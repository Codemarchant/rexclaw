# Copyright 2026 Codemarchant
"""Portable export/import: avatar-pack zips and companion packages.

Two shareable artifacts, one shared codec:

  * Avatar pack zip — the existing "drop a folder into data/avatars/"
    convention, zipped: ``avatar.json`` + the pack's files, flat. Shared
    library references (``/user-assets/…``, another pack's ``/avatars/…``)
    are inlined into the zip and the manifest copy rewritten to plain
    filenames, so the pack is self-contained on any install. ``/assets/…``
    references are kept as-is — those ship with every copy of the app.

  * Companion package zip — ``manifest.json`` (format marker + what's
    included) + ``companion.json`` (agent settings, avatar referenced by
    pack_key/name) + optional ``memories.json`` (the rexclaw_memories
    format), ``sessions.json`` (transcripts), ``lore.json`` (the lore
    stories tagged with the companion — deduped by title on import, tags
    stay plain names) and ``avatar/…`` (an embedded avatar pack, same
    codec as above).

Everything travels by name — integer ids are database-local. Imports are
all-or-nothing: any invalid entry raises, the per-request connection rolls
back on close, and freshly written pack folders are removed.

Avatar imports go through the pack machinery (folder + avatar.json +
_scan_pack) rather than raw SQL — the boot-time scanner treats manifests as
the source of truth and would wipe or prune rows that have no folder.

Schema evolution: agent settings ride the routes.misc._AGENT_FIELDS whitelist
and avatar manifests are copied verbatim, so new fields there export/import
with no changes here. What DOES need a hand-edit in this file: new memories/
sessions columns (their field lists below), and any new manifest field that
references a FILE (add it to _iter_manifest_refs so shared-asset refs inline
into the zip). Importers read only the keys they know and missing keys take
DB defaults, so additive changes stay compatible in both directions — bump a
FILE_VERSION only for breaking shape changes.
"""
import json
import logging
import shutil
import zipfile
from pathlib import Path

from . import avatar_packs, lore_tools, memory_tools, portraits
from .db import ASSETS_DIR, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)

COMPANION_FILE_FORMAT = "rexclaw_companion"
COMPANION_FILE_VERSION = 1
SESSIONS_FILE_FORMAT = "rexclaw_sessions"
SESSIONS_FILE_VERSION = 1
MEMORIES_FILE_FORMAT = "rexclaw_memories"
MEMORIES_FILE_VERSION = 1
LORE_FILE_FORMAT = "rexclaw_lore"
LORE_FILE_VERSION = 1

# Already-compressed formats are STORED (zipping a VRM buys ~nothing and
# costs real time at 100+ MB); everything else (json, text) deflates.
_STORED_EXTS = {".vrm", ".vrma", ".glb", ".gltf", ".png", ".jpg", ".jpeg", ".webp"}
# Extra harmless files allowed inside an imported pack besides the media
# kinds the uploader accepts (community packs often carry a readme/license).
_PACK_EXTRA_EXTS = {".txt", ".md"}
MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

# Marker for "the memories entry names a companion this install doesn't have".
UNKNOWN_AGENT = object()


def _compress_type(name):
    return zipfile.ZIP_STORED if Path(name).suffix.lower() in _STORED_EXTS \
        else zipfile.ZIP_DEFLATED


def _writestr_json(zf, arcname, data):
    zf.writestr(arcname, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _read_json(zf, arcname):
    try:
        data = json.loads(zf.read(arcname).decode("utf-8"))
    except KeyError:
        raise UserError(f"The zip is missing {arcname}.")
    except Exception as e:
        raise UserError(f"{arcname} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise UserError(f"{arcname} must be a JSON object.")
    return data


def _text(v):
    """Loose string coercion for imported values: None stays None, everything
    else becomes a (non-empty) string or None."""
    if v is None:
        return None
    return str(v) or None


# ---------------------------------------------------------------------------
# Memories — entry serialization + import loop, shared by the standalone
# memories file endpoints and the companion package.
# ---------------------------------------------------------------------------

def memory_entry(row, agent_name):
    """One memories-file entry from a DB row. ids and session provenance are
    dropped — they can't survive a transfer; the companion travels by name."""
    return {
        "agent": agent_name,  # None = global (all companions)
        "scope": row["scope"],
        "memory_type": row["memory_type"],
        "content": row["content"],
        "keywords": row["keywords"],
        "transcript": row["transcript"],
        "tags": row["tags"],
        "source": row["source"],
        "created_at": row["created_at"],
        "last_used_at": row["last_used_at"],
    }


def memories_payload_for_agent(con, agent_id, agent_name):
    rows = con.execute(
        "SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at, id",
        (agent_id,),
    ).fetchall()
    return {
        "format": MEMORIES_FILE_FORMAT,
        "version": MEMORIES_FILE_VERSION,
        "exported_at": utcnow(),
        "memories": [memory_entry(r, agent_name) for r in rows],
    }


def check_memories_file(payload):
    """Format/version gate for a memories file (standalone or inside a
    companion package). Returns the entries list."""
    if payload.get("format") != MEMORIES_FILE_FORMAT:
        raise UserError("Not a rexclaw memories file.")
    if payload.get("version") != MEMORIES_FILE_VERSION:
        raise UserError("Unsupported memories file version.")
    entries = payload.get("memories")
    if not isinstance(entries, list):
        raise UserError("Invalid memories file: 'memories' must be a list.")
    return entries


def import_memory_entries(con, entries, resolve_agent_id):
    """Validate + insert memory entries. `resolve_agent_id(name_or_None)`
    returns the target agent id (None = global) or UNKNOWN_AGENT to skip the
    entry. Entries identical to an existing memory (same companion, type and
    content) are skipped as duplicates so re-importing is safe. Any invalid
    entry raises — the caller's connection rollback makes the import atomic.
    Returns (imported, duplicates, unknown_agent_names)."""
    imported = duplicates = 0
    unknown_agents = set()
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise UserError(f"Invalid memory entry #{i + 1}.")
        content = str(entry.get("content") or "").strip()
        if not content:
            raise UserError(f"Memory entry #{i + 1} has no content.")
        if len(content) > memory_tools.CONTENT_MAX_LEN:
            raise UserError(f"Memory entry #{i + 1} content is too long.")
        scope = entry.get("scope") or "recall"
        memory_type = entry.get("memory_type") or "fact"
        source = entry.get("source") or "user_explicit"
        if (scope not in ("core", "recall")
                or memory_type not in ("fact", "episode")
                or source not in ("user_explicit", "agent_inferred")):
            raise UserError(f"Memory entry #{i + 1} has an invalid scope, type or source.")

        agent_name = str(entry.get("agent") or "").strip()
        agent_id = resolve_agent_id(agent_name or None)
        if agent_id is UNKNOWN_AGENT:
            unknown_agents.add(agent_name)
            continue

        if con.execute(
            "SELECT 1 FROM memories WHERE agent_id IS ? AND memory_type = ? AND content = ?",
            (agent_id, memory_type, content),
        ).fetchone():
            duplicates += 1
            continue

        is_episode = memory_type == "episode"
        con.execute(
            "INSERT INTO memories (agent_id, scope, memory_type, content, keywords,"
            " transcript, tags, source, created_at, last_used_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                agent_id, scope, memory_type, content,
                (str(entry.get("keywords") or "").strip() or None) if is_episode else None,
                (str(entry.get("transcript") or "") or None) if is_episode else None,
                memory_tools._normalize_tags(entry.get("tags")),
                source,
                str(entry.get("created_at") or "") or utcnow(),
                str(entry.get("last_used_at") or "") or None,
            ),
        )
        imported += 1
    return imported, duplicates, unknown_agents


# ---------------------------------------------------------------------------
# Avatar pack ⇄ zip
# ---------------------------------------------------------------------------

def _iter_manifest_refs(manifest):
    """Yield every (container, key) in the manifest whose value is a file
    reference — the fields the scanner resolves."""
    yield manifest, "vrm"
    yield manifest, "vrma_idle"
    for o in manifest.get("outfits") or []:
        if isinstance(o, dict):
            yield o, "vrm"
    for g in manifest.get("gestures") or []:
        if isinstance(g, dict):
            yield g, "vrma"
            yield g, "partner_vrm"
            yield g, "partner_vrma"
    for b in manifest.get("backgrounds") or []:
        if isinstance(b, dict):
            yield b, "image"
            yield b, "glb"
            yield b, "scene"


def _pack_dir_for(pack_key):
    if not isinstance(pack_key, str) or avatar_packs._KEY_RE.search(pack_key) \
            or pack_key in ("", ".", ".."):
        raise UserError("Invalid pack key.")
    for root in (avatar_packs.USER_PACKS_DIR, ASSETS_DIR / "avatars"):
        d = root / pack_key
        if (d / "avatar.json").is_file():
            return d
    raise UserError(f"Avatar pack {pack_key!r} not found.")


def _shared_ref_disk_path(ref):
    """Absolute-web-path manifest ref → disk Path, or None when it can't be
    resolved to an existing file inside a known root."""
    for prefix, root in (
        ("/user-assets/", avatar_packs.USER_ASSETS_DIR),
        ("/avatars/", avatar_packs.USER_PACKS_DIR),
        ("/assets/", ASSETS_DIR),
    ):
        if ref.startswith(prefix):
            p = (root / ref[len(prefix):]).resolve()
            if root.resolve() in p.parents and p.is_file():
                return p
    return None


def add_pack_to_zip(zf, pack_key, prefix=""):
    """Write a self-contained copy of the pack into an open zip under
    `prefix`: every file in the pack folder, plus user-local shared assets
    the manifest references (inlined, manifest rewritten to plain filenames).
    Bundled `/assets/…` references are kept — every install has them."""
    src = _pack_dir_for(pack_key)
    try:
        manifest = json.loads((src / "avatar.json").read_text(encoding="utf-8"))
    except Exception as e:
        raise UserError(f"avatar.json is unreadable: {e}")
    if not isinstance(manifest, dict):
        raise UserError("avatar.json must be a JSON object.")

    taken = {f.name for f in src.iterdir() if f.is_file() and f.name != "avatar.json"}
    inlined = {}
    for container, key in _iter_manifest_refs(manifest):
        ref = container.get(key)
        if not (isinstance(ref, str) and ref.startswith("/")) or ref.startswith("/assets/"):
            continue
        if ref in inlined:
            container[key] = inlined[ref]
            continue
        path = _shared_ref_disk_path(ref)
        if not path:
            _logger.warning("export %s: shared ref %s not found — kept as-is", pack_key, ref)
            continue
        name, i = path.name, 2
        while name in taken:
            name = f"{path.stem}-{i}{path.suffix}"
            i += 1
        taken.add(name)
        zf.write(path, f"{prefix}{name}", compress_type=_compress_type(name))
        inlined[ref] = name
        container[key] = name

    for f in sorted(src.iterdir()):
        if f.is_file() and f.name != "avatar.json":
            zf.write(f, f"{prefix}{f.name}", compress_type=_compress_type(f.name))
    _writestr_json(zf, f"{prefix}avatar.json", manifest)
    return manifest


def pack_prefix_in_zip(zf):
    """Locate avatar.json in a standalone pack zip: at the root, or inside a
    single wrapping folder (how zips of a pack folder naturally come out)."""
    names = set(zf.namelist())
    if "avatar.json" in names:
        return ""
    for p in sorted({n.split("/", 1)[0] for n in names if "/" in n}):
        if f"{p}/avatar.json" in names:
            return f"{p}/"
    raise UserError("Not an avatar pack: no avatar.json found in the zip.")


def import_pack_from_zip(con, zf, prefix="", name_override=None):
    """Extract the pack members under `prefix` into a new user pack, validate
    the manifest, and scan it into the DB. Does NOT commit — the caller does,
    so a companion import stays all-or-nothing. On any failure the freshly
    written folder is removed. Returns {pack_key, avatar_id, name}."""
    members = {}
    total = 0
    for info in zf.infolist():
        if info.is_dir() or "__MACOSX" in info.filename:
            continue
        name = info.filename
        if prefix:
            if not name.startswith(prefix):
                continue
            name = name[len(prefix):]
        elif "/" in name or "\\" in name:
            continue  # standalone pack zips are flat; stray nested files are noise
        # Flat basenames only — this is also the zip-slip guard (no '/', '..'
        # or absolute paths can survive it).
        if not name or name != Path(name).name or name.startswith("."):
            continue
        ext = Path(name).suffix.lower()
        allowed = _STORED_EXTS | _PACK_EXTRA_EXTS
        if name != "avatar.json" and ext not in allowed:
            raise UserError(f"Unsupported file in pack: {name}")
        if info.file_size > avatar_packs.MAX_UPLOAD_BYTES:
            raise UserError(f"{name} is too large ({info.file_size // (1024 * 1024)} MB). Max is 120 MB.")
        total += info.file_size
        if total > MAX_IMPORT_TOTAL_BYTES:
            raise UserError("The zip unpacks to more than 2 GB.")
        members[name] = info

    if "avatar.json" not in members:
        raise UserError("Not an avatar pack: no avatar.json found in the zip.")
    try:
        manifest = json.loads(zf.read(members.pop("avatar.json")).decode("utf-8"))
    except Exception as e:
        raise UserError(f"avatar.json is not valid JSON: {e}")
    if not isinstance(manifest, dict):
        raise UserError("avatar.json must be a JSON object.")

    name = str(name_override or manifest.get("name") or "avatar").strip() or "avatar"
    key = avatar_packs.allocate_pack_key(name)
    dest = avatar_packs.USER_PACKS_DIR / key
    dest.mkdir(parents=True, exist_ok=True)
    try:
        for fname, info in members.items():
            with zf.open(info) as srcf, open(dest / fname, "wb") as dstf:
                shutil.copyfileobj(srcf, dstf)
        manifest["name"] = name
        avatar_packs._validate_manifest(dest, manifest)
        (dest / "avatar.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        avatar_id = avatar_packs._scan_pack(con, dest, "/avatars")
        if not avatar_id:
            raise UserError("The avatar pack failed to load after import.")
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    return {"pack_key": key, "avatar_id": avatar_id, "name": name}


# ---------------------------------------------------------------------------
# Sessions ⇄ JSON
# ---------------------------------------------------------------------------

def sessions_payload_for_agent(con, agent_id):
    """All of the agent's sessions with their messages. Cross-references
    travel as list indexes (ids are database-local); xAI-side handles
    (response/item/call ids) are meaningless after transfer and dropped."""
    rows = con.execute(
        "SELECT * FROM sessions WHERE agent_id = ? ORDER BY id", (agent_id,),
    ).fetchall()
    session_idx = {r["id"]: i for i, r in enumerate(rows)}
    sessions = []
    for r in rows:
        msgs = con.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY sequence, id",
            (r["id"],),
        ).fetchall()
        msg_idx = {m["id"]: j for j, m in enumerate(msgs)}
        sessions.append({
            "name": r["name"],
            "mode": r["mode"],
            "origin": r["origin"],
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "last_active_at": r["last_active_at"],
            "summary": r["summary"],
            "title_generated": r["title_generated"],
            "total_input_tokens": r["total_input_tokens"],
            "total_output_tokens": r["total_output_tokens"],
            "call_parent": session_idx.get(r["call_parent_session_id"]),
            "delegate_parent": session_idx.get(r["delegate_parent_session_id"]),
            "messages": [
                {
                    "sequence": m["sequence"],
                    "role": m["role"],
                    "content": m["content"],
                    "speaker": m["speaker"],
                    "tool_name": m["tool_name"],
                    "tool_arguments_json": m["tool_arguments_json"],
                    "tool_result_json": m["tool_result_json"],
                    "is_summary_rollup": m["is_summary_rollup"],
                    "summarized_into": msg_idx.get(m["is_summarized_into"]),
                    "created_at": m["created_at"],
                }
                for m in msgs
            ],
        })
    return {"format": SESSIONS_FILE_FORMAT, "version": SESSIONS_FILE_VERSION,
            "sessions": sessions}


def import_sessions(con, sessions, agent_id):
    """Insert exported sessions + messages under `agent_id`. Everything lands
    as state 'ended' — the xAI response chain can't survive a transfer, so an
    imported conversation is history to read (and text mode can resume it by
    replaying messages). Returns (session_count, message_count)."""
    if not isinstance(sessions, list):
        raise UserError("Invalid sessions file: 'sessions' must be a list.")
    new_ids = []
    message_count = 0
    for i, s in enumerate(sessions):
        if not isinstance(s, dict):
            raise UserError(f"Invalid session entry #{i + 1}.")
        mode = s.get("mode") if s.get("mode") in ("voice", "text") else "text"
        origin = s.get("origin") if s.get("origin") in ("manual", "delegated") else "manual"
        cur = con.execute(
            "INSERT INTO sessions (name, agent_id, state, mode, origin, started_at,"
            " ended_at, last_active_at, summary, title_generated,"
            " total_input_tokens, total_output_tokens)"
            " VALUES (?, ?, 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(s.get("name") or f"Imported session {i + 1}"), agent_id, mode, origin,
                _text(s.get("started_at")), _text(s.get("ended_at")),
                _text(s.get("last_active_at")), _text(s.get("summary")),
                int(bool(s.get("title_generated", 1))),
                int(s.get("total_input_tokens") or 0), int(s.get("total_output_tokens") or 0),
            ),
        )
        new_ids.append(cur.lastrowid)
        messages = s.get("messages") or []
        if not isinstance(messages, list):
            raise UserError(f"Session #{i + 1}: 'messages' must be a list.")
        msg_ids = []
        for j, m in enumerate(messages):
            if not isinstance(m, dict):
                raise UserError(f"Invalid message in session #{i + 1}.")
            cur2 = con.execute(
                "INSERT INTO messages (session_id, sequence, role, content, speaker,"
                " tool_name, tool_arguments_json, tool_result_json, is_summary_rollup,"
                " created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    new_ids[-1], int(m.get("sequence") or j), str(m.get("role") or "user"),
                    _text(m.get("content")), _text(m.get("speaker")), _text(m.get("tool_name")),
                    _text(m.get("tool_arguments_json")), _text(m.get("tool_result_json")),
                    int(bool(m.get("is_summary_rollup"))), _text(m.get("created_at")),
                ),
            )
            msg_ids.append(cur2.lastrowid)
            message_count += 1
        for j, m in enumerate(messages):
            k = m.get("summarized_into")
            if isinstance(k, int) and 0 <= k < len(msg_ids) and k != j:
                con.execute("UPDATE messages SET is_summarized_into = ? WHERE id = ?",
                            (msg_ids[k], msg_ids[j]))
    for i, s in enumerate(sessions):
        for key, col in (("call_parent", "call_parent_session_id"),
                         ("delegate_parent", "delegate_parent_session_id")):
            k = s.get(key)
            if isinstance(k, int) and 0 <= k < len(new_ids) and k != i:
                con.execute(f"UPDATE sessions SET {col} = ? WHERE id = ?",
                            (new_ids[k], new_ids[i]))
    return len(new_ids), message_count


# ---------------------------------------------------------------------------
# Companion package ⇄ zip
# ---------------------------------------------------------------------------

def _agent_portable_fields():
    """The agent save/duplicate whitelist minus avatar_id — the avatar link
    travels by pack_key/name instead. Imported lazily: routes.misc imports
    this module at load time."""
    from .routes.misc import _AGENT_FIELDS
    return tuple(k for k in _AGENT_FIELDS if k != "avatar_id")


def export_companion_zip(con, agent_id, out_path, *,
                         include_memories, include_sessions, include_avatar,
                         include_lore=True):
    """Build the companion package at out_path. Returns the agent's name."""
    agent = con.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not agent:
        raise UserError("Companion not found.")
    avatar = None
    if agent["avatar_id"]:
        avatar = con.execute(
            "SELECT pack_key, name, vrm_path FROM avatars WHERE id = ?", (agent["avatar_id"],),
        ).fetchone()
    include_avatar = bool(include_avatar and avatar and avatar["pack_key"])

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        _writestr_json(zf, "manifest.json", {
            "format": COMPANION_FILE_FORMAT,
            "version": COMPANION_FILE_VERSION,
            "exported_at": utcnow(),
            "name": agent["name"],
            "includes": {
                "memories": bool(include_memories),
                "sessions": bool(include_sessions),
                "avatar": include_avatar,
                "lore": bool(include_lore),
            },
        })
        _writestr_json(zf, "companion.json", {
            "agent": {k: agent[k] for k in _agent_portable_fields()},
            "avatar": {"pack_key": avatar["pack_key"], "name": avatar["name"]} if avatar else None,
        })
        if include_memories:
            _writestr_json(zf, "memories.json",
                           memories_payload_for_agent(con, agent_id, agent["name"]))
        if include_sessions:
            _writestr_json(zf, "sessions.json", sessions_payload_for_agent(con, agent_id))
        # Lore stories tagged with this companion - companion-defining
        # content, like the prompt, so on by default; the toggle exists
        # because a story tagged with several companions would otherwise
        # travel with each of them. Character tags stay plain names; a
        # destination without those companions just keeps them in the array.
        lore = lore_tools.list_entries(con, agent["name"]) if include_lore else []
        if lore:
            _writestr_json(zf, "lore.json", {
                "format": LORE_FILE_FORMAT,
                "version": LORE_FILE_VERSION,
                "stories": [{"title": e["title"], "description": e["description"],
                             "characters": e["characters"], "tags": e["tags"],
                             "story": e["story"], "sequence": e["sequence"]}
                            for e in lore],
            })
        if include_avatar:
            add_pack_to_zip(zf, avatar["pack_key"], prefix="avatar/")
        # A face for the package before it's even imported (shared zips get
        # looked at). Derived from the VRM, so the importer ignores it.
        portrait = portraits.portrait_file(avatar["vrm_path"]) if avatar else None
        if portrait:
            zf.write(portrait, "portrait.jpg")
    return agent["name"]


def check_lore_file(payload):
    """Format/version gate for a lore file (standalone or inside a
    companion package)."""
    if payload.get("format") != LORE_FILE_FORMAT:
        raise UserError("Not a rexclaw lore file.")
    if payload.get("version") != LORE_FILE_VERSION:
        raise UserError("Unsupported lore file version.")
    stories = payload.get("stories")
    if not isinstance(stories, list):
        raise UserError("Invalid lore file: 'stories' must be a list.")
    return stories


def import_lore_entries(con, stories):
    """Insert lore stories from a companion package. Dedupe by title
    (case-insensitive): an install importing two companions that share a
    story gets one copy. Returns (imported, duplicates)."""
    imported = duplicates = 0
    for entry in stories or []:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        story = str(entry.get("story") or "").strip()
        if not title or not story:
            continue
        exists = con.execute(
            "SELECT 1 FROM lore_entries WHERE title = ? COLLATE NOCASE",
            (title,)).fetchone()
        if exists:
            duplicates += 1
            continue
        lore_tools.save_entry(con, {
            "title": title,
            "description": entry.get("description"),
            "characters": entry.get("characters"),
            "tags": entry.get("tags"),
            "story": story,
            "sequence": entry.get("sequence"),
        })
        imported += 1
    return imported, duplicates


def import_companion_zip(con, zip_path):
    """Import a companion package: create the agent (renamed if the name is
    taken), import the embedded avatar pack (or re-link an existing avatar by
    pack_key/name), then memories and sessions — all forced onto the new
    agent. All-or-nothing; returns a summary dict."""
    created_pack_dir = None
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            manifest = _read_json(zf, "manifest.json")
            if manifest.get("format") != COMPANION_FILE_FORMAT:
                raise UserError("Not a rexclaw companion file.")
            if manifest.get("version") != COMPANION_FILE_VERSION:
                raise UserError("Unsupported companion file version.")
            companion = _read_json(zf, "companion.json")
            agent_data = companion.get("agent")
            if not isinstance(agent_data, dict):
                raise UserError("Invalid companion file: missing agent settings.")
            vals = {k: agent_data[k] for k in _agent_portable_fields() if k in agent_data}
            name = str(vals.get("name") or "").strip()
            if not name or not str(vals.get("system_prompt") or "").strip():
                raise UserError("Companion file has no name or system prompt.")

            def taken(candidate):
                return con.execute(
                    "SELECT 1 FROM agents WHERE name = ?", (candidate,),
                ).fetchone()

            if taken(name):
                candidate, n = f"{name} - Imported", 2
                while taken(candidate):
                    candidate, n = f"{name} - Imported {n}", n + 1
                name = candidate
            vals["name"] = name

            avatar_ref = companion.get("avatar") or {}
            avatar_result = None
            avatar_id = None
            if any(n.startswith("avatar/") for n in names):
                avatar_result = import_pack_from_zip(
                    con, zf, prefix="avatar/",
                    name_override=avatar_ref.get("name"))
                created_pack_dir = avatar_packs.USER_PACKS_DIR / avatar_result["pack_key"]
                avatar_id = avatar_result["avatar_id"]
            elif avatar_ref:
                # Package built without the avatar — re-link one already here.
                row = None
                if avatar_ref.get("pack_key"):
                    row = con.execute("SELECT id FROM avatars WHERE pack_key = ?",
                                      (avatar_ref["pack_key"],)).fetchone()
                if not row and avatar_ref.get("name"):
                    row = con.execute("SELECT id FROM avatars WHERE name = ?",
                                      (avatar_ref["name"],)).fetchone()
                avatar_id = row["id"] if row else None
            vals["avatar_id"] = avatar_id

            cols = ", ".join(vals)
            marks = ", ".join("?" * len(vals))
            cur = con.execute(f"INSERT INTO agents ({cols}) VALUES ({marks})",
                              tuple(vals.values()))
            new_agent_id = cur.lastrowid

            memories_imported = memory_duplicates = 0
            if "memories.json" in names:
                entries = check_memories_file(_read_json(zf, "memories.json"))
                memories_imported, memory_duplicates, _ = import_memory_entries(
                    con, entries, lambda _name: new_agent_id)

            sessions_imported = messages_imported = 0
            if "sessions.json" in names:
                data = _read_json(zf, "sessions.json")
                if data.get("format") != SESSIONS_FILE_FORMAT \
                        or data.get("version") != SESSIONS_FILE_VERSION:
                    raise UserError("Unsupported sessions file in the companion package.")
                sessions_imported, messages_imported = import_sessions(
                    con, data.get("sessions"), new_agent_id)

            lore_imported = lore_duplicates = 0
            if "lore.json" in names:
                data = _read_json(zf, "lore.json")
                if data.get("format") != LORE_FILE_FORMAT \
                        or data.get("version") != LORE_FILE_VERSION:
                    raise UserError("Unsupported lore file in the companion package.")
                lore_imported, lore_duplicates = import_lore_entries(
                    con, data.get("stories"))

        con.commit()
        return {
            "ok": True,
            "id": new_agent_id,
            "name": name,
            "lore_imported": lore_imported,
            "lore_duplicates": lore_duplicates,
            "avatar": ({"pack_key": avatar_result["pack_key"], "name": avatar_result["name"]}
                       if avatar_result else None),
            "memories_imported": memories_imported,
            "memory_duplicates": memory_duplicates,
            "sessions_imported": sessions_imported,
            "messages_imported": messages_imported,
        }
    except zipfile.BadZipFile:
        raise UserError("Not a zip file.")
    except Exception:
        if created_pack_dir:
            shutil.rmtree(created_pack_dir, ignore_errors=True)
        raise
