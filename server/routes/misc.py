# Copyright 2026 Codemarchant
"""Settings + memories + agent management routes for the standalone UI."""
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import threading
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .. import avatar_packs, local_tools, lore_tools, memory_tools, minecraft_tools, portraits, seeds, transfer, xai_client
from ..db import ASSETS_DIR, FILES_DIR, shipped_column_defaults, utcnow
from ..wake_models import WAKE_MODELS
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Config columns the settings UI may read/write. The API key is write-only
# from the UI's perspective — reads return a masked placeholder.
_CONFIG_FIELDS = (
    "enabled", "xai_realtime_url", "xai_client_secrets_url", "xai_responses_url",
    "xai_files_url", "xai_images_url", "xai_images_edits_url", "xai_videos_url",
    "xai_model", "text_model", "summary_model", "director_model", "imagine_model",
    "imagine_video_model", "multi_agent_model", "multi_agent_effort",
    "delegate_fast_model",
    "default_agent_id", "user_display_name", "include_user_name_in_prompt",
    "summary_threshold_tokens", "summary_threshold_tokens_text",
    "summary_keep_recent_messages",
    "replay_rollup_enabled", "replay_rollup_keep_recent",
    "call_inactivity_minutes", "hotkeys_json", "hotkeys_global_enabled",
    "wake_word_enabled", "wake_word_language",
    "local_task_workdir",
    "minecraft_brain_model", "minecraft_brain_model_hard", "minecraft_master",
    "transcript_display_limit",
    "transcript_retention_days", "file_default_expiry_seconds",
)

_AGENT_FIELDS = (
    "name", "active", "sequence", "provider", "voice", "system_prompt", "avatar_id",
    "reasoning_effort",
    "enable_code_execution", "enable_gesture_emotion_tools",
    "enable_lore_tool", "expression_style", "speech_tag_style",
    "enable_web_search", "enable_x_search", "enable_grok_imagine_tools", "enable_capture_tools",
    "enable_memory_tools", "core_memory_cap",
    "enable_affection_tool", "affection_animations",
    "affection_score", "affection_rules",
    "affection_max_score", "affection_level_count", "affection_max_delta",
    "affection_max_delta_major",
    "enable_call_agents_tool", "when_to_call_description",
    "enable_delegate_tool", "enable_multi_agent_delegation",
    "enable_local_tasks", "enable_minecraft",
    "enable_end_call_tool", "wake_phrase", "wake_action",
)


@router.post("/config/get")
def config_get(payload: dict = Body(default={}), con=Depends(db_con)):
    row = con.execute("SELECT * FROM config WHERE id = 1").fetchone()
    out = {k: row[k] for k in _CONFIG_FIELDS}
    out["has_api_key"] = bool(row["xai_api_key"])
    out["api_key_hint"] = (
        f"…{row['xai_api_key'][-4:]}" if row["xai_api_key"] and len(row["xai_api_key"]) > 8 else None
    )
    out["spend_today_usd"] = row["spend_today_usd"]
    out["spend_lifetime_usd"] = row["spend_lifetime_usd"]
    # Live PATH lookup (not persisted): lets the settings UI show whether
    # local_task can actually be offered on this machine.
    out["local_task_cli_path"] = local_tools.grok_binary()
    # Live sidecar probe (not persisted): same role for the Minecraft bot.
    out["minecraft_connected"] = minecraft_tools.connected()
    return out


@router.post("/config/set")
def config_set(payload: dict = Body(default={}), con=Depends(db_con)):
    updates = {k: payload[k] for k in _CONFIG_FIELDS if k in payload}
    # API key arrives separately; empty string is ignored (no accidental
    # clearing from a masked field), the literal null clears it.
    if "xai_api_key" in payload:
        key = payload["xai_api_key"]
        if key is None:
            updates["xai_api_key"] = None
        elif isinstance(key, str) and key.strip():
            updates["xai_api_key"] = key.strip()
    if updates:
        cols = ", ".join(f"{k} = ?" for k in updates)
        con.execute(f"UPDATE config SET {cols} WHERE id = 1", tuple(updates.values()))
        con.commit()
    return {"ok": True, "updated": sorted(updates.keys())}


# Model fields whose shipped defaults "Restore suggested models" puts back.
# The values are the SCHEMA column defaults of this version (not the user's
# DB, whose stored defaults are frozen at install time), so bumping a default
# in db.py is the single edit that updates the button.
_MODEL_DEFAULT_FIELDS = (
    "xai_model", "text_model", "summary_model", "imagine_model",
    "imagine_video_model", "director_model", "multi_agent_model",
    "delegate_fast_model",
)


@router.post("/xai/model_defaults")
def xai_model_defaults():
    return {"defaults": shipped_column_defaults("config", _MODEL_DEFAULT_FIELDS)}


@router.post("/xai/models")
def xai_models(payload: dict = Body(default={}), con=Depends(db_con)):
    """Every model the key can reach, grouped by kind — a read-only reference
    for the Settings "See all models" dialog (not every listed model suits
    every field). Uses the stored key, or `api_key` from the payload so it
    works on a key that isn't saved yet."""
    row = con.execute("SELECT xai_api_key, xai_responses_url FROM config WHERE id = 1").fetchone()
    key = payload.get("api_key")
    key = key.strip() if isinstance(key, str) and key.strip() else row["xai_api_key"]
    if not key:
        raise UserError("Enter your xAI API key first.")
    # API root from the configured responses URL (…/v1/responses → …/v1).
    base_url = (row["xai_responses_url"] or "https://api.x.ai/v1/responses").rsplit("/", 1)[0]
    groups = []
    for kind in xai_client.MODEL_LIST_KINDS:
        try:
            groups.append({"kind": kind, "models": xai_client.list_models(
                xai_api_key=key, base_url=base_url, kind=kind)})
        except UserError as e:
            groups.append({"kind": kind, "models": [], "error": str(e)})
    return {"groups": groups}


@router.post("/agents/list")
def agents_list(payload: dict = Body(default={}), con=Depends(db_con)):
    rows = con.execute("SELECT * FROM agents ORDER BY sequence, name").fetchall()
    return [
        # is_stock: one of the five bundled companions (by name) — unlocks
        # the editor's "Reset to stock".
        {**{k: r[k] for k in ("id",) + _AGENT_FIELDS}, "is_stock": r["name"] in seeds.SEED_NAMES}
        for r in rows
    ]


@router.post("/agents/save")
def agents_save(payload: dict = Body(default={}), con=Depends(db_con)):
    """Create or update an agent. Minimal management surface for v0.1 — the
    seeded companions cover most use; this lets the user tune prompts/voices."""
    agent_id = payload.get("id")
    updates = {k: payload[k] for k in _AGENT_FIELDS if k in payload}
    if agent_id:
        if updates:
            cols = ", ".join(f"{k} = ?" for k in updates)
            con.execute(f"UPDATE agents SET {cols} WHERE id = ?", (*updates.values(), agent_id))
    else:
        if not updates.get("name") or not updates.get("system_prompt"):
            raise UserError("name and system_prompt are required to create an agent.")
        cols = ", ".join(updates.keys())
        marks = ", ".join("?" * len(updates))
        cur = con.execute(f"INSERT INTO agents ({cols}) VALUES ({marks})", tuple(updates.values()))
        agent_id = cur.lastrowid
        # Every companion ships with the example heartbeats (inactive) —
        # duplicates deliberately don't (a copy keeps settings only).
        seeds.seed_example_heartbeats(con, agent_id)
    con.commit()
    return {"ok": True, "id": agent_id}


# What "Reset to stock" leaves alone: the companion's relationship progress
# is state, not configuration. (History, memories, lore and MCP rows are
# separate tables and untouched by construction.)
_STOCK_RESET_KEEP = ("affection_score",)


@router.post("/agents/stock_values")
def agents_stock_values(payload: dict = Body(default={}), con=Depends(db_con)):
    """The form values a bundled companion shipped with: seed values over the
    agents table's shipped column defaults. Nothing is written — the editor
    loads these as an unsaved draft, so Save/Discard is the confirmation."""
    row = con.execute("SELECT * FROM agents WHERE id = ?", (payload.get("id"),)).fetchone()
    if not row:
        raise UserError("Companion not found.")
    seed = seeds.seed_by_name(row["name"])
    if not seed:
        raise UserError(f"{row['name']} is not one of the bundled companions.")
    fields = tuple(f for f in _AGENT_FIELDS if f not in _STOCK_RESET_KEEP)
    values = shipped_column_defaults("agents", fields)
    values.update({k: v for k, v in seeds.seed_columns(con, seed).items() if k in fields})
    return {"values": values}


@router.post("/agents/duplicate")
def agents_duplicate(payload: dict = Body(default={}), con=Depends(db_con)):
    """Copy a companion's configuration into a new agent ('<name> - Copy',
    numbered when taken). Sessions, memories and MCP connections stay with
    the original — MCP rows can carry auth secrets that shouldn't silently
    multiply."""
    agent_id = payload.get("id")
    if not isinstance(agent_id, int):
        raise UserError("id must be an integer.")
    row = con.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        raise UserError("Companion not found.")
    base = f"{row['name']} - Copy"
    name, n = base, 2
    while con.execute("SELECT 1 FROM agents WHERE name = ?", (name,)).fetchone():
        name, n = f"{base} {n}", n + 1
    vals = {k: row[k] for k in _AGENT_FIELDS}
    vals["name"] = name
    cols = ", ".join(vals)
    marks = ", ".join("?" * len(vals))
    cur = con.execute(f"INSERT INTO agents ({cols}) VALUES ({marks})", tuple(vals.values()))
    con.commit()
    return {"ok": True, "id": cur.lastrowid, "name": name}


@router.get("/agents/export")
def agents_export(agent_id: int, memories: int = 1, sessions: int = 1,
                  avatar: int = 1, lore: int = 1, heartbeats: int = 0,
                  con=Depends(db_con)):
    """Download a companion package zip (see server/transfer.py for the
    format). GET so the browser/Electron streams it straight to a file —
    packs with VRMs run to hundreds of MB. The zip is built in a temp file
    and deleted after the response is sent."""
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        name = transfer.export_companion_zip(
            con, agent_id, tmp.name,
            include_memories=bool(memories),
            include_sessions=bool(sessions),
            include_avatar=bool(avatar),
            include_lore=bool(lore),
            include_heartbeats=bool(heartbeats),
        )
    except Exception:
        os.unlink(tmp.name)
        raise
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-").lower() or "companion"
    return FileResponse(
        tmp.name, media_type="application/zip",
        filename=f"rexclaw-companion-{slug}.zip",
        background=BackgroundTask(os.unlink, tmp.name),
    )


@router.post("/agents/import")
def agents_import(file: UploadFile = File(...), con=Depends(db_con)):
    """Import a companion package zip: creates a new companion (renamed when
    the name is taken) with its avatar pack, memories and sessions. All-or-
    nothing — see transfer.import_companion_zip."""
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        path = tmp.name
    try:
        return transfer.import_companion_zip(con, path)
    finally:
        os.unlink(path)


@router.post("/avatars/list")
def avatars_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """Available avatars (from packs + any hand-created rows) for the
    companion editor's dropdown."""
    rows = con.execute(
        "SELECT a.id, a.pack_key, a.name, a.vrm_path,"
        " (SELECT COUNT(*) FROM avatar_outfits o WHERE o.avatar_id = a.id) AS outfit_count"
        " FROM avatars a WHERE a.active = 1 ORDER BY a.sequence, a.name",
    ).fetchall()
    return [{**dict(r), "portrait_url": portraits.portrait_url(r["vrm_path"])} for r in rows]


@router.post("/agents/delete")
def agents_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    """Delete a companion and everything that hangs off it: sessions (and
    their messages/attachments via FK cascade), memories, imagine images,
    MCP connections and heartbeats (all ON DELETE CASCADE). Refuses to
    delete the last agent — the app needs at least one companion to
    function. delete_avatar additionally removes the linked avatar pack
    (row + files), but only when it's safe: a pack still worn by another
    companion or a bundled read-only pack is kept, with the reason in
    avatar_note."""
    agent_id = payload.get("id")
    delete_avatar = bool(payload.get("delete_avatar"))
    if not isinstance(agent_id, int):
        raise UserError("id must be an integer.")
    count = con.execute("SELECT COUNT(*) AS n FROM agents").fetchone()["n"]
    if count <= 1:
        raise UserError("Cannot delete the last companion.")
    row = con.execute("SELECT avatar_id FROM agents WHERE id = ?", (agent_id,)).fetchone()
    avatar_id = row["avatar_id"] if row else None
    # sessions.agent_id has no cascade (a session without its agent is
    # meaningless) — delete them explicitly; messages cascade off sessions.
    con.execute("DELETE FROM sessions WHERE agent_id = ?", (agent_id,))
    con.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    con.execute(
        "UPDATE config SET default_agent_id ="
        " (SELECT id FROM agents ORDER BY sequence, name LIMIT 1)"
        " WHERE default_agent_id = ?",
        (agent_id,),
    )
    con.commit()

    avatar_deleted = False
    avatar_note = None
    if delete_avatar and avatar_id:
        av = con.execute("SELECT pack_key, name FROM avatars WHERE id = ?",
                         (avatar_id,)).fetchone()
        still_used = con.execute(
            "SELECT COUNT(*) AS n FROM agents WHERE avatar_id = ?",
            (avatar_id,)).fetchone()["n"]
        if not av:
            pass
        elif still_used:
            avatar_note = "other companions still use this avatar."
        elif av["pack_key"]:
            try:
                avatar_packs.delete_pack(con, av["pack_key"])
                avatar_deleted = True
            except UserError as e:
                # Bundled read-only pack (deleting its row would only make
                # scan_packs recreate it next boot anyway).
                avatar_note = str(e)
        else:
            # Hand-created avatar row without a pack folder.
            con.execute("DELETE FROM avatars WHERE id = ?", (avatar_id,))
            con.commit()
            avatar_deleted = True
    return {"ok": True, "avatar_deleted": avatar_deleted, "avatar_note": avatar_note}


@router.post("/lore/list")
def lore_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """All lore stories, or only those tagged with a character name."""
    return lore_tools.list_entries(con, payload.get("character"))


@router.post("/lore/save")
def lore_save(payload: dict = Body(default={}), con=Depends(db_con)):
    try:
        entry_id = lore_tools.save_entry(con, payload)
    except ValueError as exc:
        raise UserError(str(exc))
    con.commit()
    return {"ok": True, "id": entry_id}


@router.post("/lore/export")
def lore_export(payload: dict = Body(default={}), con=Depends(db_con)):
    """Lore stories as a shareable JSON file. Optional 'character' narrows
    the export to stories tagged with that name."""
    entries = lore_tools.list_entries(con, payload.get("character"))
    return {
        "format": transfer.LORE_FILE_FORMAT,
        "version": transfer.LORE_FILE_VERSION,
        "exported_at": utcnow(),
        "stories": [
            {k: e[k] for k in ("title", "description", "characters", "tags",
                               "story", "sequence")}
            for e in entries
        ],
    }


@router.post("/lore/import")
def lore_import(payload: dict = Body(default={}), con=Depends(db_con)):
    """Import a lore JSON file (see lore_export). Stories are deduped by
    title (case-insensitive); character tags stay plain names, so stories
    naming companions that don't exist here import fine."""
    stories = transfer.check_lore_file(payload)
    imported, duplicates = transfer.import_lore_entries(con, stories)
    con.commit()
    return {"ok": True, "imported": imported, "duplicates": duplicates}


@router.post("/lore/delete")
def lore_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    entry_id = payload.get("id")
    if not isinstance(entry_id, int):
        raise UserError("id must be an integer.")
    con.execute("DELETE FROM lore_entries WHERE id = ?", (entry_id,))
    con.commit()
    return {"ok": True}


@router.post("/agents/preview_prompt")
def agents_preview_prompt(payload: dict = Body(default={}), con=Depends(db_con)):
    """Read-only: the full computed instructions a solo voice session for
    this agent would receive right now (environment preamble + rendered
    system prompt + dynamic postamble sections)."""
    row = con.execute(
        "SELECT * FROM agents WHERE id = ?", (payload.get("id"),)
    ).fetchone()
    if not row:
        raise UserError("Companion not found.")
    from ..session_service import preview_voice_prompt
    return {"prompt": preview_voice_prompt(con, row)}


@router.post("/agents/restore_presets")
def agents_restore_presets(payload: dict = Body(default={}), con=Depends(db_con)):
    """Re-create any deleted preset companions (matched by name) from the
    bundled seeds. Existing agents are never touched — restoring brings back
    the original prompt/voice/avatar only for presets that are missing."""
    from ..seeds import AGENT_SEEDS, insert_seed
    restored = []
    for seed in AGENT_SEEDS:
        exists = con.execute(
            "SELECT 1 FROM agents WHERE name = ?", (seed["name"],)
        ).fetchone()
        if exists:
            continue
        insert_seed(con, seed)
        restored.append(seed["name"])
    con.commit()
    return {"ok": True, "restored": restored}


_SERVER_LABEL_RE = re.compile(r"^[A-Za-z0-9_]+$")

_MCP_FIELDS = (
    "name", "sequence", "active", "enable_for_voice", "enable_for_text",
    "server_url", "server_label", "server_description", "allowed_tools",
    "authorization", "headers",
)


def _validate_mcp(payload):
    """Mirror the Odoo connection model's constraints."""
    label = (payload.get("server_label") or "").strip()
    if not _SERVER_LABEL_RE.match(label):
        raise UserError("Server label must contain only letters, digits, and underscores.")
    url = (payload.get("server_url") or "").strip()
    if not url.startswith("https://"):
        # xAI's servers dial this URL from their infrastructure, so it must be
        # publicly reachable over HTTPS — a localhost/http URL can never work.
        raise UserError("Server URL must start with https:// (xAI connects to it "
                        "from their side, so it must be publicly reachable).")
    headers = payload.get("headers")
    if headers:
        try:
            parsed = json.loads(headers)
        except (TypeError, ValueError) as e:
            raise UserError(f"Extra headers must be valid JSON: {e}")
        if not isinstance(parsed, dict):
            raise UserError('Extra headers must be a JSON object (e.g. {"X-Tenant": "acme"}).')


@router.post("/mcp/list")
def mcp_list(payload: dict = Body(default={}), con=Depends(db_con)):
    agent_id = payload.get("agent_id")
    if not isinstance(agent_id, int):
        raise UserError("agent_id must be an integer.")
    rows = con.execute(
        "SELECT * FROM mcp_connections WHERE agent_id = ? ORDER BY sequence, id",
        (agent_id,),
    ).fetchall()
    out = []
    for r in rows:
        d = {k: r[k] for k in ("id", "agent_id") + _MCP_FIELDS}
        # Never echo the bearer back to the browser — write-only, like the API key.
        d["has_authorization"] = bool(d.pop("authorization"))
        out.append(d)
    return out


@router.post("/mcp/save")
def mcp_save(payload: dict = Body(default={}), con=Depends(db_con)):
    _validate_mcp(payload)
    updates = {k: payload[k] for k in _MCP_FIELDS if k in payload}
    # Blank bearer on update = keep the stored one (the field is write-only in
    # the UI); the literal null clears it.
    if "authorization" in updates and updates["authorization"] == "":
        del updates["authorization"]
    if not updates.get("name"):
        updates["name"] = updates.get("server_label") or "Connection"
    conn_id = payload.get("id")
    if conn_id:
        cols = ", ".join(f"{k} = ?" for k in updates)
        con.execute(f"UPDATE mcp_connections SET {cols} WHERE id = ?",
                    (*updates.values(), conn_id))
    else:
        if not isinstance(payload.get("agent_id"), int):
            raise UserError("agent_id is required.")
        updates["agent_id"] = payload["agent_id"]
        cols = ", ".join(updates)
        marks = ", ".join("?" * len(updates))
        cur = con.execute(f"INSERT INTO mcp_connections ({cols}) VALUES ({marks})",
                          tuple(updates.values()))
        conn_id = cur.lastrowid
    con.commit()
    return {"ok": True, "id": conn_id}


@router.post("/mcp/delete")
def mcp_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    conn_id = payload.get("id")
    if not isinstance(conn_id, int):
        raise UserError("id must be an integer.")
    con.execute("DELETE FROM mcp_connections WHERE id = ?", (conn_id,))
    con.commit()
    return {"ok": True}


@router.post("/sessions/list")
def sessions_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """Unified session archive (voice + text) for the Sessions tab. Returns
    everything — filtering/search happens client-side, mirroring the
    Memories tab. call_parent_session_id lets the UI nest group-call peer
    legs under their primary session. Unlike the chat history/resume lists
    this archive INCLUDES origin='delegated' task workspaces (it's the
    audit surface), labelled via `origin`."""
    rows = con.execute(
        "SELECT s.id, s.name, s.agent_id, s.mode, s.state, s.origin, s.started_at,"
        " s.ended_at,"
        " s.last_active_at, s.summary, s.call_parent_session_id,"
        " s.delegate_parent_session_id, a.name AS agent_name,"
        " (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.is_summary_rollup = 0)"
        "   AS message_count"
        " FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id"
        " ORDER BY s.last_active_at DESC, s.id DESC LIMIT ?",
        (int(payload.get("limit") or 500),),
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/sessions/messages")
def sessions_messages(payload: dict = Body(default={}), con=Depends(db_con)):
    """Read-only transcript of one session, in the shape the Transcript
    component renders (state.messages rows). Unlike resume, this never
    reactivates the session or touches xAI."""
    from .common import resolve_session
    session = resolve_session(con, payload.get("id"))
    rows = con.execute(
        "SELECT * FROM messages WHERE session_id = ? AND is_summary_rollup = 0"
        " ORDER BY sequence ASC, id ASC",
        (session["id"],),
    ).fetchall()
    out = []
    for m in rows:
        entry = {
            "sequence": m["sequence"],
            "role": m["role"],
            # tool_result rows store their payload in tool_result_json; the
            # transcript renderer reads row content.
            "content": (m["tool_result_json"] or m["content"] or "")
                       if m["role"] == "tool_result" else (m["content"] or ""),
            "speaker": m["speaker"],
            "tool_name": m["tool_name"],
            "tool_arguments_json": m["tool_arguments_json"],
            # The Transcript component pairs tool_call/tool_result rows by
            # call id; without it, adjacency guessing mispairs multi-tool
            # turns.
            "xai_call_id": m["xai_call_id"],
        }
        atts = con.execute(
            "SELECT xai_file_id, filename, size_bytes FROM message_attachments"
            " WHERE message_id = ? ORDER BY id", (m["id"],),
        ).fetchall()
        if atts:
            entry["attachments"] = [dict(a) for a in atts]
        out.append(entry)
    agent = con.execute("SELECT name FROM agents WHERE id = ?", (session["agent_id"],)).fetchone()
    return {"mode": session["mode"], "agent_name": agent["name"] if agent else None, "messages": out}


@router.post("/sessions/rename")
def sessions_rename(payload: dict = Body(default={}), con=Depends(db_con)):
    from .common import resolve_session
    session = resolve_session(con, payload.get("id"))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise UserError("Session name cannot be empty.")
    # title_generated=1 so the auto-titler never clobbers a user-chosen name.
    con.execute("UPDATE sessions SET name = ?, title_generated = 1 WHERE id = ?",
                (name[:120], session["id"]))
    con.commit()
    return {"ok": True}


@router.post("/sessions/delete")
def sessions_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    """Delete a session and its messages (FK cascade). Linked rows survive
    sanely: memory episodes and imagine images keep their content
    (session_id → NULL), and group-call peer sessions become top-level
    (call_parent_session_id → NULL). Active sessions are refused — end the
    call/chat first rather than yanking rows out from under it."""
    from .common import resolve_session
    session = resolve_session(con, payload.get("id"))
    if session["state"] == "active":
        raise UserError("This session is active — end it before deleting.")
    con.execute("DELETE FROM sessions WHERE id = ?", (session["id"],))
    con.commit()
    return {"ok": True}


@router.post("/memories/list")
def memories_list(payload: dict = Body(default={}), con=Depends(db_con)):
    rows = con.execute(
        "SELECT m.*, a.name AS agent_name FROM memories m"
        " LEFT JOIN agents a ON a.id = m.agent_id"
        " ORDER BY m.created_at DESC, m.id DESC",
    ).fetchall()
    return [
        {
            "id": r["id"],
            "agent_id": r["agent_id"],
            "agent_name": r["agent_name"],
            "scope": r["scope"],
            "memory_type": r["memory_type"],
            "content": r["content"],
            "keywords": r["keywords"],
            "transcript": r["transcript"],
            "tags": r["tags"],
            "source": r["source"],
            "created_at": r["created_at"],
            "last_used_at": r["last_used_at"],
        }
        for r in rows
    ]


@router.post("/memories/save")
def memories_save(payload: dict = Body(default={}), con=Depends(db_con)):
    """Create or update a memory from the UI. Manual creations are 'fact'
    rows (episodes only come from session rollups); editing an episode keeps
    its type and additionally allows retouching the keyword index that recall
    scores against."""
    memory_id = payload.get("id")
    content = (payload.get("content") or "").strip()
    if not content:
        raise UserError("Memory content is required.")
    if len(content) > memory_tools.CONTENT_MAX_LEN:
        raise UserError("Memory content is too long.")
    scope = payload.get("scope") or "recall"
    if scope not in ("core", "recall"):
        raise UserError("scope must be 'core' or 'recall'.")
    agent_id = payload.get("agent_id")
    if agent_id is not None:
        if not isinstance(agent_id, int) or not con.execute(
            "SELECT 1 FROM agents WHERE id = ?", (agent_id,)
        ).fetchone():
            raise UserError("Companion not found.")
    tags = memory_tools._normalize_tags(payload.get("tags"))

    if memory_id:
        row = con.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
        if not row:
            raise UserError("Memory not found.")
        vals = {"content": content, "scope": scope, "agent_id": agent_id, "tags": tags}
        if row["memory_type"] == "episode" and "keywords" in payload:
            vals["keywords"] = (payload.get("keywords") or "").strip() or None
        cols = ", ".join(f"{k} = ?" for k in vals)
        con.execute(f"UPDATE memories SET {cols} WHERE id = ?", (*vals.values(), memory_id))
    else:
        cur = con.execute(
            "INSERT INTO memories (agent_id, scope, memory_type, content, tags, source, created_at)"
            " VALUES (?, ?, 'fact', ?, ?, 'user_explicit', ?)",
            (agent_id, scope, content, tags, utcnow()),
        )
        memory_id = cur.lastrowid
    con.commit()
    return {"ok": True, "id": memory_id}


@router.post("/memories/delete")
def memories_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    memory_id = payload.get("id")
    if not isinstance(memory_id, int):
        raise UserError("id must be an integer.")
    con.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    con.commit()
    return {"ok": True}


# Portable memories file: versioned JSON shared with the Odoo module, whose
# memory model mirrors this schema field-for-field. Companions travel by name
# (integer ids are database-local), and derived/provenance columns (id,
# session_id) are dropped — they can't survive a transfer anyway. The format
# itself (and the entry-import loop, shared with companion packages) lives in
# server/transfer.py.


@router.post("/memories/export")
def memories_export(payload: dict = Body(default={}), con=Depends(db_con)):
    """Optional filter: an 'agent_id' key in the payload narrows the export —
    an int exports that companion's memories only, an explicit null exports
    only the shared (global) ones. Omit the key to export everything."""
    where, params = "", ()
    if "agent_id" in payload:
        agent_id = payload["agent_id"]
        if agent_id is None:
            where = " WHERE m.agent_id IS NULL"
        else:
            if not isinstance(agent_id, int) or not con.execute(
                "SELECT 1 FROM agents WHERE id = ?", (agent_id,)
            ).fetchone():
                raise UserError("Companion not found.")
            where = " WHERE m.agent_id = ?"
            params = (agent_id,)
    rows = con.execute(
        "SELECT m.*, a.name AS agent_name FROM memories m"
        " LEFT JOIN agents a ON a.id = m.agent_id"
        + where +
        " ORDER BY m.created_at, m.id",
        params,
    ).fetchall()
    return {
        "format": transfer.MEMORIES_FILE_FORMAT,
        "version": transfer.MEMORIES_FILE_VERSION,
        "exported_at": utcnow(),
        "memories": [transfer.memory_entry(r, r["agent_name"]) for r in rows],
    }


@router.post("/memories/import")
def memories_import(payload: dict = Body(default={}), con=Depends(db_con)):
    """Import a memories JSON file (see memories_export). Companions are
    matched by name (case-insensitive); entries for companions that don't
    exist here are skipped and reported, not silently made global — create or
    rename the companion and re-import, which is safe because entries that
    already exist (same companion, type and content) are skipped as
    duplicates. Any invalid entry aborts the whole import (the per-request
    connection rolls back on error), so a file never half-imports."""
    entries = transfer.check_memories_file(payload)
    agents_by_name = {
        r["name"].strip().lower(): r["id"]
        for r in con.execute("SELECT id, name FROM agents").fetchall()
    }

    def resolve(agent_name):
        if not agent_name:
            return None
        return agents_by_name.get(agent_name.lower(), transfer.UNKNOWN_AGENT)

    imported, duplicates, unknown_agents = transfer.import_memory_entries(
        con, entries, resolve)
    con.commit()
    return {
        "ok": True,
        "imported": imported,
        "duplicates": duplicates,
        "unknown_agents": sorted(unknown_agents),
    }


@router.post("/imagine/list")
def imagine_list(payload: dict = Body(default={}), con=Depends(db_con)):
    rows = con.execute(
        "SELECT i.*, a.name AS agent_name FROM imagine_images i"
        " JOIN agents a ON a.id = i.agent_id"
        " ORDER BY i.created_at DESC, i.id DESC LIMIT ?",
        (int(payload.get("limit") or 100),),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "agent_id": r["agent_id"],
            "agent_name": r["agent_name"],
            "kind": r["kind"],
            "prompt": r["prompt"],
            "image_url": r["image_path"],
            "mimetype": r["mimetype"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Wake-word model management (voice activation)
# ---------------------------------------------------------------------------
# The browser spots wake phrases locally with a Vosk model (vosk-browser
# WASM) — keeping standby listening offline and unbilled. Models are ~40-50MB
# per language, so they are fetched once server-side from alphacephei.com and
# converted zip → tar.gz (the format vosk-browser loads), then served
# same-origin under /files/wake_models/. Download runs in a background thread;
# the UI polls /wake/model/status.

_WAKE_MODELS_DIR = FILES_DIR / "wake_models"
# lang → {"state": "downloading"|"error", "progress": float, "error": str}
_wake_jobs = {}
_wake_lock = threading.Lock()


def _wake_model_path(lang):
    return _WAKE_MODELS_DIR / f"{lang}.tar.gz"


def _wake_model_file(lang):
    """(path, url) of the ready model, or (None, None).

    Two sources: the runtime-downloaded copy in the user's data dir, and the
    copy release packages bundle under assets/wake_models (fetched at build
    time by scripts/fetch_wake_model.py into the desktop zip and Docker
    image, so those installs work offline out of the box). Source checkouts
    ship no bundled models - they use the download path as before. The user
    copy wins so a re-download can supersede a stale bundled model."""
    user = _wake_model_path(lang)
    if user.is_file():
        return user, f"/files/wake_models/{lang}.tar.gz"
    bundled = ASSETS_DIR / "wake_models" / f"{lang}.tar.gz"
    if bundled.is_file():
        return bundled, f"/assets/wake_models/{lang}.tar.gz"
    return None, None


def _wake_download(lang, model_name):
    """Background worker: fetch the model zip and repack it as tar.gz."""
    import requests

    url = f"https://alphacephei.com/vosk/models/{model_name}.zip"
    try:
        _WAKE_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=str(_WAKE_MODELS_DIR)) as tmp:
            tmp = Path(tmp)
            zip_path = tmp / "model.zip"
            with requests.get(url, stream=True, timeout=60) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length") or 0)
                done = 0
                with open(zip_path, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 18):
                        fh.write(chunk)
                        done += len(chunk)
                        if total:
                            with _wake_lock:
                                job = _wake_jobs.get(lang)
                                if job:
                                    # Cap at 0.9 — the repack below is the rest.
                                    job["progress"] = 0.9 * done / total
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp / "unpacked")
            # The zip contains one top-level model directory — keep that
            # directory name in the tar so vosk-browser finds the model root.
            roots = [p for p in (tmp / "unpacked").iterdir() if p.is_dir()]
            if not roots:
                raise RuntimeError("model archive had no directory inside")
            out_tmp = tmp / "model.tar.gz"
            with tarfile.open(out_tmp, "w:gz") as tf:
                tf.add(roots[0], arcname=roots[0].name)
            # Atomic-ish move into place; replace() so a re-download updates.
            shutil.move(str(out_tmp), str(_wake_model_path(lang)))
        with _wake_lock:
            _wake_jobs.pop(lang, None)
        _logger.info("wake model %s ready (%s)", lang, model_name)
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI verbatim
        _logger.exception("wake model download failed (%s)", lang)
        with _wake_lock:
            _wake_jobs[lang] = {"state": "error", "progress": 0, "error": str(exc)}


def _wake_status(lang):
    path, url = _wake_model_file(lang)
    with _wake_lock:
        job = dict(_wake_jobs.get(lang) or {})
    if job.get("state") == "downloading":
        return {"lang": lang, "ready": False, "downloading": True,
                "progress": round(job.get("progress") or 0, 3), "error": None}
    out = {"lang": lang, "ready": path is not None, "downloading": False,
           "progress": 1.0 if path else 0, "error": job.get("error") or None}
    if path:
        out["url"] = url
        out["size_bytes"] = path.stat().st_size
    return out


@router.post("/wake/model/status")
def wake_model_status(payload: dict = Body(default={})):
    lang = str(payload.get("lang") or "en")
    if lang not in WAKE_MODELS:
        raise UserError(f"Unknown wake-word language '{lang}'.")
    return _wake_status(lang)


@router.post("/wake/model/prepare")
def wake_model_prepare(payload: dict = Body(default={})):
    """Kick off (or report) the model download for a language. Idempotent —
    an already-present model or in-flight download just returns status."""
    lang = str(payload.get("lang") or "en")
    model_name = WAKE_MODELS.get(lang)
    if not model_name:
        raise UserError(f"Unknown wake-word language '{lang}'.")
    if _wake_model_file(lang)[0] is not None:
        return _wake_status(lang)
    with _wake_lock:
        job = _wake_jobs.get(lang)
        if not job or job.get("state") == "error":
            _wake_jobs[lang] = {"state": "downloading", "progress": 0, "error": None}
            threading.Thread(
                target=_wake_download, args=(lang, model_name), daemon=True,
            ).start()
    return _wake_status(lang)
