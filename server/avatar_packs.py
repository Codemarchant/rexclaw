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
      "outfits": [
        {"name": "Winter", "vrm": "kira_winter.vrm", "description": "…"}
      ],
      "gestures": [
        {"enum": "wave_hello", "vrma": "wave.vrma", "description": "…",
         "loop": false}
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

from .browser_tools import _BUILTIN_GESTURE_IDS
from .db import ASSETS_DIR, DATA_DIR

_logger = logging.getLogger(__name__)

USER_PACKS_DIR = DATA_DIR / "avatars"

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
        if ref.startswith("/assets/"):
            on_disk = ASSETS_DIR / ref[len("/assets/"):]
            if not on_disk.is_file():
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
            " vrm_path = ?, vrma_idle_path = ?, active = 1 WHERE id = ?",
            (pack_key, vals["name"], vals["description"], vals["sequence"],
             vals["vrm_path"], vals["vrma_idle_path"], row["id"]),
        )
        return row["id"]
    cur = con.execute(
        "INSERT INTO avatars (pack_key, name, description, sequence, vrm_path, vrma_idle_path)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (pack_key, vals["name"], vals["description"], vals["sequence"],
         vals["vrm_path"], vals["vrma_idle_path"]),
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
        seen_enums.add(enum)
        con.execute(
            "INSERT INTO avatar_gestures (avatar_id, name, sequence, gesture_enum, description,"
            " vrma_path, loop) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (avatar_id, str(g.get("name") or enum), (i + 1) * 10, enum,
             str(g.get("description") or ""), path, int(bool(g.get("loop")))),
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
    con.commit()
    if found:
        _logger.info("avatar packs loaded: %s", ", ".join(sorted(found)))
    return found
