# Copyright 2026 Codemarchant
"""Avatar packs: folder-convention avatar loading.

A pack is a folder containing an ``avatar.json`` manifest plus its VRM/VRMA/
GLB/image files. Two roots are scanned on every boot:

  * ``assets/avatars/<Pack>/``  — bundled packs shipped with the app,
                                  served under ``/assets/avatars/<Pack>/``
  * ``data/avatars/<Pack>/``    — user-installed packs ("drop a folder in"),
                                  served under ``/avatars/<Pack>/``

Manifest shape (all file references are pack-relative filenames, OR absolute
web paths starting with ``/`` for shared assets like the bundled grid scene):

    {
      "name": "Kira",
      "description": "optional",
      "sequence": 10,
      "vrm": "kira_default.vrm",
      "vrma_idle": "idle.vrma",
      "emotion_decay": true,             // optional; default true — emotions
                                         // settle back toward neutral after a beat
      "outfits": [
        {"name": "Winter", "vrm": "kira_winter.vrm", "description": "…"}
      ],
      "gestures": [
        {"enum": "wave_hello", "vrma": "wave.vrma", "description": "…",
         "loop": false},
        {"enum": "dance_together", "type": "combo", "vrma": "dance_a.vrma",
         "description": "…", "loop": true,
         "partner_avatar": "Ara",            // existing avatar (pack key or name), OR:
         "partner_vrm": "partner.vrm",       // dedicated model when no partner_avatar
         "partner_vrma": "dance_b.vrma",     // required — the partner's clip
         "base_offset": [0, 0, 0], "base_rotation": [0, 0, 0],
         "partner_offset": [0.6, 0, 0], "partner_rotation": [0, 0, 0],
         "partner_scale": 1.0}
      ],
      "backgrounds": [
        {"name": "Charcoal", "type": "static", "preset": "vignette_charcoal"},
        {"name": "Beach", "type": "scene", "glb": "beach.glb",
         "scale": 1.0, "offset": [0, 0, 0], "rotation_y": 0,
         "is_default": false},
        {"name": "Poster", "type": "image", "image": "poster.jpg"}
      ]
    }

Scanning upserts on ``avatars.pack_key`` (= the folder name) so re-boots pick
up manifest edits without duplicating rows, and agent → avatar links survive.
Child rows (outfits/gestures/backgrounds) are replaced wholesale on each scan
— they carry no cross-references that need stable ids. Rows that predate the
pack system (no pack_key) are adopted by exact name match so existing
databases migrate in place.

A malformed pack is skipped with a logged warning — one bad manifest must
never take the app down.
"""
import json
import logging
import re
from pathlib import Path

from .browser_tools import _BUILTIN_GESTURE_IDS
from .db import ASSETS_DIR, DATA_DIR

_logger = logging.getLogger(__name__)

USER_PACKS_DIR = DATA_DIR / "avatars"
# Shared user asset library: files dropped in data/assets/ are served at
# /user-assets/… and can be referenced from ANY pack's manifest by that
# absolute path — one copy of a background GLB / gesture VRMA instead of a
# duplicate upload per avatar. The editor surfaces them via a library picker
# (list_shared_assets → /api/avatars/shared_assets).
USER_ASSETS_DIR = DATA_DIR / "assets"

# Mirror the validation the Odoo gesture model enforced: lowercase identifier,
# and no shadowing of the built-in pack (the static catalog wins in the JS
# dispatcher, so a shadowed custom clip would be unreachable).
_GESTURE_ENUM_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_RESERVED_GESTURES = set(_BUILTIN_GESTURE_IDS) | {"idle"}

# Preset keys must match BACKGROUND_PRESETS in web/src/services/avatar_renderer.js.
_KNOWN_PRESETS = {
    "gradient_indigo", "gradient_slate", "gradient_studio",
    "vignette_charcoal", "vignette_studio", "vignette_navy",
    "solid_dark", "solid_light",
}


def _resolve(ref, pack_dir, url_base, *, pack, field):
    """Manifest file reference → web path, or None (with a warning).

    Pack-relative filenames must exist inside the pack folder. Absolute web
    paths (leading ``/``) pass through — used for shared bundled assets; the
    ``/assets/…`` form is existence-checked against disk, other mounts are
    trusted.
    """
    if not ref or not isinstance(ref, str):
        return None
    if ref.startswith("/"):
        checked = {"/assets/": ASSETS_DIR, "/user-assets/": USER_ASSETS_DIR}
        for prefix, root in checked.items():
            if ref.startswith(prefix) and not (root / ref[len(prefix):]).is_file():
                _logger.warning("pack %s: %s points at missing %s — skipped", pack, field, ref)
                return None
        return ref
    if "/" in ref or "\\" in ref or ref.startswith("."):
        _logger.warning("pack %s: %s must be a plain filename in the pack folder, got %r — skipped",
                        pack, field, ref)
        return None
    if not (pack_dir / ref).is_file():
        _logger.warning("pack %s: %s file not found: %s — skipped", pack, field, ref)
        return None
    return f"{url_base}/{ref}"


def _vec3(value, default=(0.0, 0.0, 0.0)):
    """Manifest [x, y, z] triple → floats, falling back to `default` on any
    malformed shape. Used for combo-gesture offsets ([x,y,z] metres) and
    rotations ([yaw,pitch,roll] degrees)."""
    if isinstance(value, list) and len(value) == 3:
        try:
            return (float(value[0]), float(value[1]), float(value[2]))
        except (TypeError, ValueError):
            pass
    return default


def _upsert_avatar(con, pack_key, vals):
    """Insert or update the avatars row for this pack. Returns the row id.

    Resolution order: existing row with this pack_key → legacy row with the
    same name and no pack_key (adopted, so pre-pack databases keep their
    agent links) → fresh insert.
    """
    row = con.execute("SELECT id FROM avatars WHERE pack_key = ?", (pack_key,)).fetchone()
    if not row:
        row = con.execute(
            "SELECT id FROM avatars WHERE pack_key IS NULL AND name = ?",
            (vals["name"],),
        ).fetchone()
        if row:
            _logger.info("pack %s: adopted legacy avatar row id=%s", pack_key, row["id"])
    if row:
        con.execute(
            "UPDATE avatars SET pack_key = ?, name = ?, description = ?, sequence = ?,"
            " vrm_path = ?, vrma_idle_path = ?, emotion_decay = ?, active = 1 WHERE id = ?",
            (pack_key, vals["name"], vals["description"], vals["sequence"],
             vals["vrm_path"], vals["vrma_idle_path"], vals["emotion_decay"], row["id"]),
        )
        return row["id"]
    cur = con.execute(
        "INSERT INTO avatars (pack_key, name, description, sequence, vrm_path, vrma_idle_path,"
        " emotion_decay) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (pack_key, vals["name"], vals["description"], vals["sequence"],
         vals["vrm_path"], vals["vrma_idle_path"], vals["emotion_decay"]),
    )
    return cur.lastrowid


def _scan_pack(con, pack_dir, url_root):
    pack_key = pack_dir.name
    manifest_path = pack_dir / "avatar.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        _logger.warning("pack %s: unreadable avatar.json (%s) — skipped", pack_key, e)
        return None
    if not isinstance(manifest, dict):
        _logger.warning("pack %s: avatar.json must be a JSON object — skipped", pack_key)
        return None

    url_base = f"{url_root}/{pack_key}"
    vrm_path = _resolve(manifest.get("vrm"), pack_dir, url_base, pack=pack_key, field="vrm")
    if not vrm_path:
        _logger.warning("pack %s: no usable main `vrm` — pack skipped", pack_key)
        return None

    avatar_id = _upsert_avatar(con, pack_key, {
        "name": str(manifest.get("name") or pack_key),
        "description": manifest.get("description") or None,
        "sequence": int(manifest.get("sequence") or 10),
        "vrm_path": vrm_path,
        "vrma_idle_path": _resolve(manifest.get("vrma_idle"), pack_dir, url_base,
                                   pack=pack_key, field="vrma_idle"),
        # Only an explicit false opts out — absent (all pre-existing packs)
        # means on.
        "emotion_decay": 0 if manifest.get("emotion_decay") is False else 1,
    })

    # Children are replaced wholesale — manifest is the source of truth.
    con.execute("DELETE FROM avatar_outfits WHERE avatar_id = ?", (avatar_id,))
    con.execute("DELETE FROM avatar_gestures WHERE avatar_id = ?", (avatar_id,))
    con.execute("DELETE FROM avatar_backgrounds WHERE avatar_id = ?", (avatar_id,))

    for i, o in enumerate(manifest.get("outfits") or []):
        if not isinstance(o, dict):
            continue
        path = _resolve(o.get("vrm"), pack_dir, url_base, pack=pack_key, field=f"outfits[{i}].vrm")
        if not path:
            continue
        con.execute(
            "INSERT INTO avatar_outfits (avatar_id, name, sequence, vrm_path, outfit_description)"
            " VALUES (?, ?, ?, ?, ?)",
            (avatar_id, str(o.get("name") or f"Outfit {i + 1}"), (i + 1) * 10,
             path, o.get("description") or None),
        )

    seen_enums = set()
    for i, g in enumerate(manifest.get("gestures") or []):
        if not isinstance(g, dict):
            continue
        enum = str(g.get("enum") or "").strip()
        if not _GESTURE_ENUM_RE.match(enum):
            _logger.warning("pack %s: gestures[%d].enum %r invalid (lowercase letters/digits/"
                            "underscores, starting with a letter) — skipped", pack_key, i, enum)
            continue
        if enum in _RESERVED_GESTURES:
            _logger.warning("pack %s: gestures[%d].enum %r collides with a built-in gesture — skipped",
                            pack_key, i, enum)
            continue
        if enum in seen_enums:
            _logger.warning("pack %s: duplicate gesture enum %r — skipped", pack_key, enum)
            continue
        path = _resolve(g.get("vrma"), pack_dir, url_base, pack=pack_key, field=f"gestures[{i}].vrma")
        if not path:
            continue
        gesture_type = "combo" if g.get("type") == "combo" else "solo"
        partner_avatar = partner_vrm_path = partner_vrma_path = None
        base_off = _vec3(g.get("base_offset"))
        base_rot = _vec3(g.get("base_rotation"))
        partner_off = _vec3(g.get("partner_offset"), default=(0.6, 0.0, 0.0))
        partner_rot = _vec3(g.get("partner_rotation"))
        if gesture_type == "combo":
            partner_vrma_path = _resolve(g.get("partner_vrma"), pack_dir, url_base,
                                         pack=pack_key, field=f"gestures[{i}].partner_vrma")
            partner_avatar = str(g.get("partner_avatar") or "").strip() or None
            if not partner_avatar:
                partner_vrm_path = _resolve(g.get("partner_vrm"), pack_dir, url_base,
                                            pack=pack_key, field=f"gestures[{i}].partner_vrm")
            if not partner_vrma_path or not (partner_avatar or partner_vrm_path):
                _logger.warning("pack %s: combo gesture %r needs partner_vrma plus a "
                                "partner_avatar or partner_vrm — skipped", pack_key, enum)
                continue
        seen_enums.add(enum)
        con.execute(
            "INSERT INTO avatar_gestures (avatar_id, name, sequence, gesture_enum, description,"
            " vrma_path, loop, gesture_type, partner_avatar, partner_vrm_path, partner_vrma_path,"
            " base_offset_x, base_offset_y, base_offset_z, base_yaw, base_pitch, base_roll,"
            " partner_offset_x, partner_offset_y, partner_offset_z, partner_yaw, partner_pitch,"
            " partner_roll, partner_scale)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (avatar_id, str(g.get("name") or enum), (i + 1) * 10, enum,
             str(g.get("description") or ""), path, int(bool(g.get("loop"))),
             gesture_type, partner_avatar, partner_vrm_path, partner_vrma_path,
             base_off[0], base_off[1], base_off[2], base_rot[0], base_rot[1], base_rot[2],
             partner_off[0], partner_off[1], partner_off[2], partner_rot[0], partner_rot[1],
             partner_rot[2], float(g.get("partner_scale") or 1.0)),
        )

    saw_default = False
    for i, b in enumerate(manifest.get("backgrounds") or []):
        if not isinstance(b, dict):
            continue
        btype = b.get("type") or "static"
        name = str(b.get("name") or f"Background {i + 1}")
        preset = image_path = scene_path = None
        if btype == "static":
            preset = b.get("preset") or b.get("preset_style")
            if preset not in _KNOWN_PRESETS:
                _logger.warning("pack %s: backgrounds[%d] unknown preset %r — skipped",
                                pack_key, i, preset)
                continue
        elif btype == "image":
            image_path = _resolve(b.get("image"), pack_dir, url_base,
                                  pack=pack_key, field=f"backgrounds[{i}].image")
            if not image_path:
                continue
        elif btype == "scene":
            scene_path = _resolve(b.get("glb") or b.get("scene"), pack_dir, url_base,
                                  pack=pack_key, field=f"backgrounds[{i}].glb")
            if not scene_path:
                continue
        else:
            _logger.warning("pack %s: backgrounds[%d] unknown type %r — skipped", pack_key, i, btype)
            continue
        is_default = bool(b.get("is_default")) and not saw_default
        saw_default = saw_default or is_default
        offset = b.get("offset") or [0, 0, 0]
        if not (isinstance(offset, list) and len(offset) == 3):
            offset = [0, 0, 0]
        con.execute(
            "INSERT INTO avatar_backgrounds (avatar_id, name, sequence, type, preset_style,"
            " image_path, scene_path, scene_scale, scene_offset_x, scene_offset_y, scene_offset_z,"
            " scene_rotation_y, is_default)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (avatar_id, name, (i + 1) * 10, btype, preset, image_path, scene_path,
             float(b.get("scale") or 1.0), float(offset[0]), float(offset[1]), float(offset[2]),
             float(b.get("rotation_y") or 0.0), int(is_default)),
        )

    return avatar_id


def scan_packs(con):
    """Scan both pack roots and upsert every valid pack. Returns
    {pack_key: avatar_id} for the packs found this scan."""
    USER_PACKS_DIR.mkdir(parents=True, exist_ok=True)
    found = {}
    for root, url_root in (
        (ASSETS_DIR / "avatars", "/assets/avatars"),
        (USER_PACKS_DIR, "/avatars"),
    ):
        if not root.is_dir():
            continue
        for pack_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            if not (pack_dir / "avatar.json").is_file():
                continue
            try:
                avatar_id = _scan_pack(con, pack_dir, url_root)
            except Exception:
                _logger.exception("pack %s: scan failed — skipped", pack_dir.name)
                continue
            if avatar_id:
                found[pack_dir.name] = avatar_id
    # Prune rows whose pack folder has vanished from BOTH roots — e.g. a
    # folder duplicated in the file manager ("Ara - Copy") that got scanned
    # in and later deleted or renamed away. Upsert-only scanning would keep
    # such rows forever, and with no folder behind them they render as
    # locked "bundled" avatars in the manager. Folder presence protects a
    # pack even when its manifest is currently broken — a failed scan must
    # never read as deletion.
    stale = [
        r for r in con.execute(
            "SELECT id, pack_key, name FROM avatars WHERE pack_key IS NOT NULL",
        ).fetchall()
        if r["pack_key"] not in found
        and not (USER_PACKS_DIR / r["pack_key"]).is_dir()
        and not (ASSETS_DIR / "avatars" / r["pack_key"]).is_dir()
    ]
    for r in stale:
        con.execute("UPDATE agents SET avatar_id = NULL WHERE avatar_id = ?", (r["id"],))
        con.execute("DELETE FROM avatars WHERE id = ?", (r["id"],))
        _logger.info("pack %r: folder gone — pruned stale avatar row %r (id=%s)",
                     r["pack_key"], r["name"], r["id"])
    con.commit()
    if found:
        _logger.info("avatar packs loaded: %s", ", ".join(sorted(found)))
    return found


# ---------------------------------------------------------------------------
# Management — UI-driven pack authoring (data/avatars only).
#
# The avatar editor in Settings round-trips through these: uploads land in the
# pack folder, the manifest is written back, and the pack is re-scanned so the
# DB reflects it. Bundled packs (assets/avatars, in git) are read-only here.
# ---------------------------------------------------------------------------

from .errors import UserError  # noqa: E402  (kept local to the management half)

_KEY_RE = re.compile(r"[^a-zA-Z0-9_-]+")
_ALLOWED_UPLOAD_EXT = {
    "vrm": {".vrm"},
    "vrma": {".vrma"},
    "scene": {".glb", ".gltf"},
    "image": {".png", ".jpg", ".jpeg", ".webp"},
}
MAX_UPLOAD_BYTES = 120 * 1024 * 1024  # generous — VRMs run 10-30 MB


def list_shared_assets(kind=None):
    """Files usable from any pack by absolute web path, grouped by upload
    kind: the user's shared library (data/assets, recursive) plus the bundled
    shared GLB/VRMA dirs. Drives the editor's library picker."""
    ext_kind = {e: k for k, exts in _ALLOWED_UPLOAD_EXT.items() for e in exts}
    roots = [
        (USER_ASSETS_DIR, "/user-assets", "user"),
        (ASSETS_DIR / "glb", "/assets/glb", "bundled"),
        (ASSETS_DIR / "vrma", "/assets/vrma", "bundled"),
    ]
    out = []
    for root, base, source in roots:
        if not root.is_dir():
            continue
        for f in sorted(root.rglob("*")):
            if not f.is_file():
                continue
            k = ext_kind.get(f.suffix.lower())
            if not k or (kind and k != kind):
                continue
            rel = f.relative_to(root).as_posix()
            out.append({"kind": k, "name": rel, "url": f"{base}/{rel}", "source": source})
    return out


def pack_is_editable(pack_key):
    """True if this pack lives under data/avatars (so the UI may write it).
    Bundled packs in assets/avatars are read-only."""
    return (USER_PACKS_DIR / pack_key / "avatar.json").is_file() or \
           (USER_PACKS_DIR / pack_key).is_dir()


def _sanitize_key(name):
    key = _KEY_RE.sub("-", (name or "").strip()).strip("-_")
    return key or "avatar"


def allocate_pack_key(name):
    """Derive a unique, filesystem-safe pack folder name from a display name."""
    base = _sanitize_key(name)
    USER_PACKS_DIR.mkdir(parents=True, exist_ok=True)
    # Uniqueness is across BOTH roots — a user pack must not shadow a bundled
    # one (the scanner upserts on pack_key, so a clash would hijack the bundled
    # avatar's row).
    taken = {p.name for p in USER_PACKS_DIR.iterdir() if p.is_dir()} if USER_PACKS_DIR.is_dir() else set()
    bundled = ASSETS_DIR / "avatars"
    if bundled.is_dir():
        taken |= {p.name for p in bundled.iterdir() if p.is_dir()}
    key = base
    n = 2
    while key in taken:
        key = f"{base}-{n}"
        n += 1
    return key


def create_pack(name):
    """Make an empty user-pack folder and return its key. No manifest yet —
    the avatar only becomes real once a main VRM is uploaded and save() runs."""
    key = allocate_pack_key(name)
    (USER_PACKS_DIR / key).mkdir(parents=True, exist_ok=True)
    return key


def _require_editable(pack_key):
    if not isinstance(pack_key, str) or _KEY_RE.search(pack_key) or pack_key in ("", ".", ".."):
        raise UserError("Invalid pack key.")
    if (ASSETS_DIR / "avatars" / pack_key / "avatar.json").is_file() and \
       not (USER_PACKS_DIR / pack_key).is_dir():
        raise UserError("Bundled avatars are read-only. Create a new avatar instead.")
    pack_dir = USER_PACKS_DIR / pack_key
    if not pack_dir.is_dir():
        raise UserError(f"Avatar pack {pack_key!r} not found.")
    return pack_dir


def pack_file_path(pack_key, filename):
    """Resolve a bare filename inside an editable pack folder. Raises for
    bundled/unknown packs, path components, or a file that isn't there —
    the guard for routes that write beside a pack file (portrait sidecars)."""
    pack_dir = _require_editable(pack_key)
    name = Path(filename or "").name
    if not name or name != filename:
        raise UserError("Invalid filename.")
    path = pack_dir / name
    if not path.is_file():
        raise UserError(f"{name!r} is not in this pack.")
    return path


def save_upload(pack_key, kind, filename, content_bytes):
    """Save an uploaded file into the pack folder, return the stored filename.
    `kind` (vrm/vrma/scene/image) gates the allowed extension."""
    pack_dir = _require_editable(pack_key)
    if len(content_bytes) > MAX_UPLOAD_BYTES:
        raise UserError(f"File too large ({len(content_bytes) // (1024*1024)} MB). Max is 120 MB.")
    safe = _KEY_RE.sub("_", Path(filename or "").stem)
    ext = Path(filename or "").suffix.lower()
    allowed = _ALLOWED_UPLOAD_EXT.get(kind)
    if not allowed or ext not in allowed:
        raise UserError(f"{kind} upload must be one of {sorted(allowed or [])}, got {ext!r}.")
    if not safe:
        safe = kind
    dest = f"{safe}{ext}"
    # Avoid clobbering a different file with the same name.
    i = 2
    while (pack_dir / dest).exists() and (pack_dir / dest).stat().st_size != len(content_bytes):
        dest = f"{safe}-{i}{ext}"
        i += 1
    (pack_dir / dest).write_bytes(content_bytes)
    return dest


def read_manifest(pack_key):
    """Return the pack's manifest dict for editing, or a blank skeleton when
    it has no manifest yet (freshly created). Raises if the pack isn't
    editable."""
    pack_dir = _require_editable(pack_key)
    mpath = pack_dir / "avatar.json"
    if mpath.is_file():
        try:
            data = json.loads(mpath.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception as e:
            raise UserError(f"avatar.json is not valid JSON: {e}")
    return {"name": pack_key, "outfits": [], "gestures": [], "backgrounds": []}


def list_pack_files(pack_key):
    """Filenames present in the pack folder, by inferred kind — lets the editor
    offer existing uploads in dropdowns without re-uploading."""
    pack_dir = USER_PACKS_DIR / pack_key
    out = {"vrm": [], "vrma": [], "scene": [], "image": []}
    if not pack_dir.is_dir():
        return out
    ext_kind = {e: k for k, exts in _ALLOWED_UPLOAD_EXT.items() for e in exts}
    for f in sorted(pack_dir.iterdir()):
        if f.is_file() and f.name != "avatar.json":
            kind = ext_kind.get(f.suffix.lower())
            if kind:
                out[kind].append(f.name)
    return out


def _suggest_gesture_enum(raw):
    """Turn whatever the user typed into a valid gesture enum to show in the
    validation error — 'test 1' → 'test_1', 'Wave Hello!' → 'wave_hello'."""
    key = re.sub(r"[^a-z0-9_]+", "_", (raw or "").lower()).strip("_")
    key = re.sub(r"_+", "_", key)
    if not key:
        return "my_gesture"
    if not key[0].isalpha():
        return f"gesture_{key}"
    return key


def _validate_manifest(pack_dir, m):
    """Editor-side validation: reject with a clear message rather than the
    scanner's skip-with-warning. Mirrors the scanner's rules."""
    if not isinstance(m, dict):
        raise UserError("Manifest must be an object.")
    if not (m.get("name") or "").strip():
        raise UserError("Avatar needs a name.")

    def _check_file(ref, field):
        if not ref or not isinstance(ref, str):
            raise UserError(f"{field}: a file is required.")
        if ref.startswith("/"):
            return  # shared web path (e.g. the bundled grid scene) — trusted
        if "/" in ref or "\\" in ref or ref.startswith("."):
            raise UserError(f"{field}: must be a plain filename in the pack.")
        if not (pack_dir / ref).is_file():
            raise UserError(f"{field}: file {ref!r} is not in the pack — upload it first.")

    _check_file(m.get("vrm"), "Main VRM")
    if m.get("vrma_idle"):
        _check_file(m["vrma_idle"], "Idle animation")

    for i, o in enumerate(m.get("outfits") or []):
        if not (o.get("name") or "").strip():
            raise UserError(f"Outfit #{i + 1} needs a name.")
        _check_file(o.get("vrm"), f"Outfit '{o.get('name')}' VRM")

    seen = set()
    for i, g in enumerate(m.get("gestures") or []):
        enum = (g.get("enum") or "").strip()
        if not _GESTURE_ENUM_RE.match(enum):
            raise UserError(f"Gesture #{i + 1}: {enum!r} isn't a valid gesture name. "
                            f"Use only lowercase letters, digits and underscores, "
                            f"starting with a letter — for example "
                            f"{_suggest_gesture_enum(enum)!r} instead.")
        if enum in _RESERVED_GESTURES:
            raise UserError(f"Gesture enum {enum!r} collides with a built-in gesture.")
        if enum in seen:
            raise UserError(f"Duplicate gesture enum {enum!r}.")
        seen.add(enum)
        _check_file(g.get("vrma"), f"Gesture '{enum}' animation")
        if g.get("type") == "combo":
            _check_file(g.get("partner_vrma"), f"Combo gesture '{enum}' partner animation")
            if not (g.get("partner_avatar") or "").strip():
                _check_file(g.get("partner_vrm"), f"Combo gesture '{enum}' partner VRM")

    for i, b in enumerate(m.get("backgrounds") or []):
        btype = b.get("type") or "static"
        if not (b.get("name") or "").strip():
            raise UserError(f"Background #{i + 1} needs a name.")
        if btype == "static":
            if b.get("preset") not in _KNOWN_PRESETS:
                raise UserError(f"Background '{b.get('name')}': pick a valid preset.")
        elif btype == "image":
            _check_file(b.get("image"), f"Background '{b.get('name')}' image")
        elif btype == "scene":
            _check_file(b.get("glb") or b.get("scene"), f"Background '{b.get('name')}' GLB")
        else:
            raise UserError(f"Background '{b.get('name')}': unknown type {btype!r}.")


def validate_manifest(pack_key, manifest):
    """Validation-only pass against the pack's current folder. The save route
    runs this on new packs BEFORE rename_pack: rename drops the old key, so a
    validation failure after renaming would strand the editor — its pack_key
    would no longer exist and every retry would fail with 'pack not found'."""
    _validate_manifest(_require_editable(pack_key), manifest)


def rename_pack(con, old_key, new_name):
    """Rename a freshly-created pack's folder to match its display name, so the
    on-disk folder (and any future shared zip) reads `data/avatars/Kira/`
    rather than the generic `avatar-3` allocated before the name was known.

    Only safe for brand-new packs — they carry no agent links yet, so dropping
    the stale DB row (the rescan re-adds it under the new key) can't orphan a
    companion. Returns the resulting key (unchanged if no rename was needed).
    """
    old_dir = _require_editable(old_key)
    base = _sanitize_key(new_name)
    if base == old_key:
        return old_key
    # Allocate a unique key for the new name, ignoring our own old folder.
    taken = {p.name for p in USER_PACKS_DIR.iterdir() if p.is_dir() and p.name != old_key}
    bundled = ASSETS_DIR / "avatars"
    if bundled.is_dir():
        taken |= {p.name for p in bundled.iterdir() if p.is_dir()}
    key, n = base, 2
    while key in taken:
        key, n = f"{base}-{n}", n + 1
    old_dir.rename(USER_PACKS_DIR / key)
    con.execute("DELETE FROM avatars WHERE pack_key = ?", (old_key,))
    return key


def write_manifest(con, pack_key, manifest):
    """Validate + write the manifest, then re-scan just this pack so the DB
    matches. Returns the resulting avatar id."""
    pack_dir = _require_editable(pack_key)
    _validate_manifest(pack_dir, manifest)
    (pack_dir / "avatar.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    avatar_id = _scan_pack(con, pack_dir, "/avatars")
    con.commit()
    return avatar_id


def duplicate_pack(con, pack_key, new_name):
    """Copy any pack — bundled or user — into a new editable user pack named
    `new_name`. The name is chosen by the user at duplicate time and also
    derives the folder key (duplicating Eve as 'Kira' lands in
    data/avatars/Kira/) — the folder only follows the display name on
    creation, so baking in a '<name> - Copy' folder would stick forever."""
    import shutil
    if not isinstance(pack_key, str) or _KEY_RE.search(pack_key) or pack_key in ("", ".", ".."):
        raise UserError("Invalid pack key.")
    new_name = (new_name or "").strip()
    if not new_name:
        raise UserError("The copy needs a name.")
    src = USER_PACKS_DIR / pack_key
    if not (src / "avatar.json").is_file():
        src = ASSETS_DIR / "avatars" / pack_key
    if not (src / "avatar.json").is_file():
        raise UserError(f"Avatar pack {pack_key!r} not found.")
    try:
        manifest = json.loads((src / "avatar.json").read_text(encoding="utf-8"))
    except Exception as e:
        raise UserError(f"Source avatar.json is unreadable: {e}")
    if not isinstance(manifest, dict):
        raise UserError("Source avatar.json must be a JSON object.")
    key = allocate_pack_key(new_name)
    dest = USER_PACKS_DIR / key
    shutil.copytree(src, dest)
    manifest["name"] = new_name
    (dest / "avatar.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    avatar_id = _scan_pack(con, dest, "/avatars")
    con.commit()
    return {"pack_key": key, "avatar_id": avatar_id, "name": new_name}


def delete_pack(con, pack_key):
    """Remove a user pack's folder and its DB row (+ children via cascade).
    Bundled packs cannot be deleted."""
    import shutil
    pack_dir = _require_editable(pack_key)
    row = con.execute("SELECT id FROM avatars WHERE pack_key = ?", (pack_key,)).fetchone()
    if row:
        # Null out agents pointing at it so they fall back to no-avatar rather
        # than dangling; then delete the avatar (children cascade).
        con.execute("UPDATE agents SET avatar_id = NULL WHERE avatar_id = ?", (row["id"],))
        con.execute("DELETE FROM avatars WHERE id = ?", (row["id"],))
        con.commit()
    shutil.rmtree(pack_dir, ignore_errors=True)
    return True
