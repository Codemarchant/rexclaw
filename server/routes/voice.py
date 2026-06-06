# Copyright 2026 Codemarchant
"""Voice-mode (realtime WebSocket) session routes. Mirrors the Odoo module's
controllers/voice_session.py minus the Odoo-native tool surface."""
import logging

from fastapi import APIRouter, Body, Depends

from .. import imagine_tools, memory_tools, session_service, store
from ..db import get_config
from ..errors import AccessError, UserError, ValidationError
from .common import db_con, resolve_agent, resolve_session

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice")

# xAI's PCM validator only accepts this exact set. Snap any other value to the
# nearest valid one (defense in depth — the client snaps too).
XAI_PCM_RATES = (8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000)


@router.post("/session/start")
def session_start(payload: dict = Body(default={}), con=Depends(db_con)):
    agent = resolve_agent(con, payload.get("agent_id"), mode="voice")
    resume_session = None
    if payload.get("resume_session_id"):
        resume_session = resolve_session(con, payload["resume_session_id"])
    try:
        rate = int(payload.get("audio_sample_rate") or 24000)
    except (TypeError, ValueError):
        rate = 24000
    if rate not in XAI_PCM_RATES:
        rate = min(XAI_PCM_RATES, key=lambda r: (abs(r - rate), r))
    return session_service.start_session(
        con, agent=agent, resume_session=resume_session, audio_sample_rate=rate,
    )


@router.post("/session/{session_id}/append")
def session_append(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.append_messages(
        con, session, payload.get("messages") or [],
        total_input_tokens=payload.get("total_input_tokens"),
        total_output_tokens=payload.get("total_output_tokens"),
    )


@router.post("/session/{session_id}/append-meta")
def session_append_meta(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.append_meta(con, session, payload.get("patches") or [])


@router.post("/session/{session_id}/compact")
def session_compact(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.compact_session(con, session)


@router.post("/session/{session_id}/tool_call")
def session_tool_call(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    """Execute a native tool (imagine / memory) on behalf of the active voice
    session. Errors are returned as {'error': str} so the realtime model gets
    a structured failure."""
    session = resolve_session(con, session_id)
    if session["state"] != "active":
        raise ValidationError("Session is not active.")
    agent = store.get_agent(con, session["agent_id"])
    tool_name = payload.get("tool_name")
    arguments = payload.get("arguments") or {}
    if tool_name in imagine_tools.IMAGINE_TOOL_NAMES:
        if not agent["enable_grok_imagine_tools"]:
            raise AccessError("Grok Imagine tools are disabled on this agent.")
        # Defence in depth: surface gating mirrors the tool lists.
        if tool_name == "change_background" and session["mode"] == "text":
            raise AccessError("change_background is not available in text mode.")
        if tool_name == "edit_image" and session["mode"] != "text":
            raise AccessError("edit_image is only available in text mode.")
        result = imagine_tools.execute_imagine_tool(con, session, tool_name, arguments)
        con.commit()
        return result
    if tool_name in memory_tools.MEMORY_TOOL_NAMES:
        if not agent["enable_memory_tools"]:
            raise AccessError("Memory tools are disabled on this agent.")
        result = memory_tools.execute_memory_tool(con, session, tool_name, arguments)
        con.commit()
        return result
    raise ValidationError(f"Unknown native tool: {tool_name}")


@router.post("/session/{session_id}/end")
def session_end(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.end_session(
        con, session,
        reason=payload.get("reason") or "client",
        total_input_tokens=payload.get("total_input_tokens") or 0,
        total_output_tokens=payload.get("total_output_tokens") or 0,
    )


@router.post("/sessions")
def session_list(payload: dict = Body(default={}), con=Depends(db_con)):
    limit = int(payload.get("limit") or 20)
    rows = con.execute(
        "SELECT s.*, a.name AS agent_name,"
        " (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count"
        " FROM sessions s JOIN agents a ON a.id = s.agent_id"
        " WHERE s.mode = 'voice'"
        " ORDER BY s.last_active_at DESC, s.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [
        {
            "id": s["id"],
            "name": s["name"],
            "agent_id": s["agent_id"],
            "agent_name": s["agent_name"],
            "started_at": s["started_at"],
            "ended_at": s["ended_at"],
            "state": s["state"],
            "message_count": s["message_count"],
            "summary": s["summary"],
        }
        for s in rows
    ]


@router.post("/agents")
def list_agents(payload: dict = Body(default={}), con=Depends(db_con)):
    agents = store.list_agents(con, mode="voice")
    config = get_config(con)
    accessible_ids = {a["id"] for a in agents}
    default_id = (
        config["default_agent_id"]
        if config["default_agent_id"] in accessible_ids
        else False
    )

    out = []
    for a in agents:
        sess = con.execute(
            "SELECT * FROM sessions WHERE mode = 'voice' AND agent_id = ?"
            " AND state IN ('ended', 'active')"
            " ORDER BY last_active_at DESC, id DESC LIMIT 1",
            (a["id"],),
        ).fetchone()
        imagine = store.latest_imagine_background(con, a["id"])
        out.append({
            "id": a["id"],
            "name": a["name"],
            "voice": a["voice"],
            "avatar": store.avatar_payload(con, a["avatar_id"]),
            "last_resumable_session": (
                {
                    "id": sess["id"],
                    "name": sess["name"],
                    "state": sess["state"],
                    "last_active_at": sess["last_active_at"],
                }
                if sess else None
            ),
            "latest_imagine_background": store.imagine_payload(imagine) if imagine else None,
        })
    return {"default_agent_id": default_id, "agents": out}
