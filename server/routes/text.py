# Copyright 2026 Codemarchant
"""Text-mode (Responses API) session routes. Mirrors the Odoo module's
controllers/text_session.py — no /tool_results round-trip in the standalone
because every tool executes server-side inside text_send_turn."""
import logging

from fastapi import APIRouter, Body, Depends, UploadFile, File

from .. import session_service, store
from ..db import get_config
from .common import db_con, resolve_agent, resolve_session

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/text")


@router.post("/session/start")
def session_start(payload: dict = Body(default={}), con=Depends(db_con)):
    agent = resolve_agent(con, payload.get("agent_id"), mode="text")
    resume_session = None
    if payload.get("resume_session_id"):
        resume_session = resolve_session(con, payload["resume_session_id"])
    return session_service.start_text_session(con, agent=agent, resume_session=resume_session)


@router.post("/session/{session_id}/send")
def session_send(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.text_send_turn(
        con, session=session,
        user_text=payload.get("user_text") or "",
        attachment_file_ids=payload.get("attachment_file_ids") or None,
    )


@router.post("/session/{session_id}/upload")
async def session_upload(session_id: int, file: UploadFile = File(...), con=Depends(db_con)):
    """Multipart upload proxy to xAI /v1/files. The response metadata is held
    by the browser until the next /send call — no attachment row yet."""
    session = resolve_session(con, session_id)
    content = await file.read()
    result = session_service.upload_text_attachment(
        con, session=session,
        filename=file.filename,
        content_bytes=content,
        mimetype=file.content_type,
    )
    # Drop the raw upstream body so the response stays small and we don't
    # leak xAI internals to the browser.
    return {k: v for k, v in result.items() if k != "raw"}


@router.post("/session/{session_id}/compact")
def session_compact(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.text_compact(con, session)


@router.post("/session/{session_id}/end")
def session_end(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.end_session(
        con, session, reason=payload.get("reason") or "client",
        total_input_tokens=0, total_output_tokens=0,
    )


@router.post("/sessions")
def session_list(payload: dict = Body(default={}), con=Depends(db_con)):
    limit = int(payload.get("limit") or 20)
    rows = con.execute(
        "SELECT s.*, a.name AS agent_name,"
        " (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count"
        " FROM sessions s JOIN agents a ON a.id = s.agent_id"
        " WHERE s.mode = 'text'"
        " ORDER BY s.started_at DESC, s.id DESC LIMIT ?",
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


@router.post("/session/{session_id}/replay")
def session_replay(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    msgs = store.session_messages(con, session["id"], where="AND is_summarized_into IS NULL")
    return {
        "session_id": session["id"],
        "name": session["name"],
        "agent_id": session["agent_id"],
        "messages": [
            {
                "sequence": m["sequence"],
                "role": m["role"],
                "content": m["content"],
                "tool_name": m["tool_name"],
                "tool_arguments_json": m["tool_arguments_json"],
                "tool_result_json": m["tool_result_json"],
                "is_summary_rollup": bool(m["is_summary_rollup"]),
                "attachments": [
                    {
                        "xai_file_id": a["xai_file_id"],
                        "filename": a["filename"],
                        "size_bytes": a["size_bytes"],
                        "mimetype": a["mimetype"],
                    }
                    for a in store.attachments_for_message(con, m["id"])
                ],
            }
            for m in msgs
        ],
    }


@router.post("/agents")
def list_agents(payload: dict = Body(default={}), con=Depends(db_con)):
    agents = store.list_agents(con, mode="text")
    config = get_config(con)
    accessible_ids = {a["id"] for a in agents}
    default_id = (
        config["default_agent_id"]
        if config["default_agent_id"] in accessible_ids
        else False
    )
    return {
        "default_agent_id": default_id,
        "agents": [
            {
                "id": a["id"],
                "name": a["name"],
                "reasoning_effort": a["reasoning_effort"],
                "chat_thumbnail_url": a["chat_thumbnail_path"] or None,
            }
            for a in agents
        ],
    }
