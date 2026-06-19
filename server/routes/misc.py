# Copyright 2026 Codemarchant
"""Settings + memories + agent management routes for the standalone UI."""
import json
import logging
import re

from fastapi import APIRouter, Body, Depends

from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Config columns the settings UI may read/write. The API key is write-only
# from the UI's perspective — reads return a masked placeholder.
_CONFIG_FIELDS = (
    "enabled", "xai_realtime_url", "xai_client_secrets_url", "xai_responses_url",
    "xai_files_url", "xai_images_url", "xai_images_edits_url",
    "xai_model", "text_model", "summary_model", "imagine_model",
    "default_agent_id", "user_display_name", "include_user_name_in_prompt",
    "summary_threshold_tokens", "summary_threshold_tokens_text",
    "summary_keep_recent_messages", "enable_memory_extraction",
    "transcript_display_limit",
    "transcript_retention_days", "file_default_expiry_seconds",
)

_AGENT_FIELDS = (
    "name", "active", "sequence", "voice", "system_prompt", "avatar_id",
    "reasoning_effort", "enable_voice_mode", "enable_text_mode",
    "enable_code_execution", "enable_gesture_emotion_tools",
    "enable_web_search", "enable_x_search", "enable_grok_imagine_tools",
    "enable_memory_tools", "core_memory_cap",
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


@router.post("/agents/list")
def agents_list(payload: dict = Body(default={}), con=Depends(db_con)):
    rows = con.execute("SELECT * FROM agents ORDER BY sequence, name").fetchall()
    return [
        {k: r[k] for k in ("id",) + _AGENT_FIELDS}
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
    con.commit()
    return {"ok": True, "id": agent_id}


@router.post("/avatars/list")
def avatars_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """Available avatars (from packs + any hand-created rows) for the
    companion editor's dropdown."""
    rows = con.execute(
        "SELECT a.id, a.pack_key, a.name, a.vrm_path,"
        " (SELECT COUNT(*) FROM avatar_outfits o WHERE o.avatar_id = a.id) AS outfit_count"
        " FROM avatars a WHERE a.active = 1 ORDER BY a.sequence, a.name",
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/agents/delete")
def agents_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    """Delete a companion and everything that hangs off it: sessions (and
    their messages/attachments via FK cascade), memories, imagine images and
    MCP connections (all ON DELETE CASCADE). Refuses to delete the last
    agent — the app needs at least one companion to function."""
    agent_id = payload.get("id")
    if not isinstance(agent_id, int):
        raise UserError("id must be an integer.")
    count = con.execute("SELECT COUNT(*) AS n FROM agents").fetchone()["n"]
    if count <= 1:
        raise UserError("Cannot delete the last companion.")
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
    return {"ok": True}


@router.post("/agents/restore_presets")
def agents_restore_presets(payload: dict = Body(default={}), con=Depends(db_con)):
    """Re-create any deleted preset companions (matched by name) from the
    bundled seeds. Existing agents are never touched — restoring brings back
    the original prompt/voice/avatar only for presets that are missing."""
    from ..seeds import AGENT_SEEDS
    restored = []
    for seed in AGENT_SEEDS:
        exists = con.execute(
            "SELECT 1 FROM agents WHERE name = ?", (seed["name"],)
        ).fetchone()
        if exists:
            continue
        avatar = con.execute(
            "SELECT id FROM avatars WHERE pack_key = ?", (seed["pack"],)
        ).fetchone()
        con.execute(
            "INSERT INTO agents (name, sequence, voice, system_prompt, avatar_id)"
            " VALUES (?, ?, ?, ?, ?)",
            (seed["name"], seed["sequence"], seed["voice"], seed["prompt"],
             avatar["id"] if avatar else None),
        )
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


@router.post("/memories/delete")
def memories_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    memory_id = payload.get("id")
    if not isinstance(memory_id, int):
        raise UserError("id must be an integer.")
    con.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    con.commit()
    return {"ok": True}


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
            "created_at": r["created_at"],
        }
        for r in rows
    ]
