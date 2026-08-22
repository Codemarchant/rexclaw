# Copyright 2026 Codemarchant
"""Voice-mode (realtime WebSocket) session routes. Mirrors the Odoo module's
controllers/voice_session.py minus the Odoo-native tool surface."""
import base64
import logging
import uuid

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from .. import affection_tools, delegate_tools, imagine_tools, local_tools, lore_tools, memory_tools, minecraft_tools, session_service, store
from ..db import FILES_DIR, get_config, utcnow
from ..errors import AccessError, UserError, ValidationError
from .common import db_con, resolve_agent, resolve_session

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice")

# xAI's PCM validator only accepts this exact set. Snap any other value to the
# nearest valid one (defense in depth — the client snaps too).
XAI_PCM_RATES = (8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000)


@router.post("/session/start")
def session_start(payload: dict = Body(default={}), con=Depends(db_con)):
    agent = resolve_agent(con, payload.get("agent_id"))
    resume_session = None
    if payload.get("resume_session_id"):
        resume_session = resolve_session(con, payload["resume_session_id"])

    # Multi-agent calls: a "peer" leg links back to the primary leg's
    # session and runs with manual turn detection. All optional and ignored
    # for ordinary solo sessions.
    call_parent_session = None
    if payload.get("call_parent_session_id"):
        call_parent_session = resolve_session(con, payload["call_parent_session_id"])
    group_peers = payload.get("group_peers")
    if group_peers is not None and not isinstance(group_peers, list):
        raise ValidationError("group_peers must be a list of names.")
    group_peers = [str(n)[:80] for n in (group_peers or []) if n]

    # resume_last: continue the agent's most recent voice session instead
    # of starting a blank one. Used by peer legs (agents invited into a
    # group call) so a called companion arrives with its memory of past
    # conversations intact — the same "Resume last" semantics the UI
    # offers for solo calls. An explicit resume_session_id always wins
    # (the compaction-restart path passes one). 'active' is included so
    # a stranded session (tab closed before End) is still picked up.
    # Mode-agnostic on purpose: a conversation last held in text continues
    # seamlessly as voice (start_session flips its mode).
    if payload.get("resume_last") and not resume_session:
        # origin filter: delegated task workspaces and heartbeat sessions
        # are background artifacts — never silently resumed as an
        # interactive conversation.
        q = ("SELECT * FROM sessions WHERE agent_id = ?"
             " AND state IN ('ended', 'active') AND origin NOT IN ('delegated', 'heartbeat')")
        params = [agent["id"]]
        if call_parent_session:
            q += " AND id != ?"
            params.append(call_parent_session["id"])
        q += " ORDER BY last_active_at DESC, id DESC LIMIT 1"
        resume_session = con.execute(q, params).fetchone()

    try:
        rate = int(payload.get("audio_sample_rate") or 24000)
    except (TypeError, ValueError):
        rate = 24000
    if rate not in XAI_PCM_RATES:
        rate = min(XAI_PCM_RATES, key=lambda r: (abs(r - rate), r))
    return session_service.start_session(
        con, agent=agent, resume_session=resume_session, audio_sample_rate=rate,
        manual_turn=bool(payload.get("manual_turn")),
        call_parent_session=call_parent_session,
        group_peers=group_peers,
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
        if tool_name in imagine_tools.VOICE_ONLY_TOOL_NAMES and session["mode"] == "text":
            raise AccessError(f"{tool_name} is not available in text mode.")
        result = imagine_tools.execute_imagine_tool(con, session, tool_name, arguments)
        con.commit()
        return result
    if tool_name in memory_tools.MEMORY_TOOL_NAMES:
        if not agent["enable_memory_tools"]:
            raise AccessError("Memory tools are disabled on this agent.")
        result = memory_tools.execute_memory_tool(con, session, tool_name, arguments)
        con.commit()
        return result
    if tool_name in lore_tools.LORE_TOOL_NAMES:
        if not agent["enable_lore_tool"]:
            raise AccessError("Lore stories are disabled on this companion.")
        return lore_tools.execute_lore_tool(con, session, tool_name, arguments)
    if tool_name in affection_tools.AFFECTION_TOOL_NAMES:
        if not agent["enable_affection_tool"]:
            raise AccessError("The affection meter is disabled on this companion.")
        result = affection_tools.execute_affection_tool(con, session, tool_name, arguments)
        con.commit()
        return result
    if tool_name == delegate_tools.DELEGATE_TOOL_NAME:
        # Flag + recursion checks live in the executor; it returns
        # {'error': ...} so the realtime model gets a structured failure.
        result = delegate_tools.execute_delegate_tool(con, session, arguments)
        con.commit()
        return result
    if tool_name == local_tools.LOCAL_TASK_TOOL_NAME:
        # Flag check lives in the executor (same {'error': ...} contract).
        result = local_tools.execute_local_task(con, session, arguments)
        con.commit()
        return result
    if tool_name in minecraft_tools.MINECRAFT_TOOL_NAMES:
        # Flag check lives in the executors (same {'error': ...} contract).
        if tool_name == minecraft_tools.MINECRAFT_COMMAND_TOOL_NAME:
            return minecraft_tools.execute_minecraft_command(con, session, agent, arguments)
        return minecraft_tools.execute_minecraft_status(con, session, agent, arguments)
    raise ValidationError(f"Unknown native tool: {tool_name}")


def _store_session_image(con, session_id, image_data_url, *, kind, name,
                         flag="enable_grok_imagine_tools"):
    """Shared body of the selfie/screenshot/upload routes: validate the
    session + the agent flag that offers the tool, decode a data:image/...
    URI, persist it as an imagine_images row of `kind`, and return the
    small library payload."""
    session = resolve_session(con, session_id)
    if session["state"] != "active":
        raise ValidationError("Session is not active.")
    agent = store.get_agent(con, session["agent_id"])
    if not agent[flag]:
        raise AccessError(f"{flag[len('enable_'):].replace('_', ' ').capitalize()} are disabled on this agent.")

    data = image_data_url or ""
    if not isinstance(data, str) or not data.startswith("data:image/"):
        raise ValidationError("image_data_url must be a data:image/... URI.")
    header, _, b64 = data.partition(",")
    mimetype = header[len("data:"):].split(";", 1)[0]
    if mimetype not in ("image/png", "image/jpeg", "image/webp"):
        raise ValidationError(f"Unsupported image mimetype {mimetype!r}.")
    try:
        raw = base64.b64decode(b64 or "", validate=True)
    except Exception:
        raise ValidationError("image_data_url is not valid base64.")
    if not raw or len(raw) > 10 * 1024 * 1024:
        raise ValidationError("Image must be between 1 byte and 10 MB.")

    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mimetype]
    fname = f"imagine_{uuid.uuid4().hex}{ext}"
    (FILES_DIR / fname).write_bytes(raw)
    image_path = f"/files/{fname}"
    name = name or "Image"
    cur = con.execute(
        """INSERT INTO imagine_images
               (name, agent_id, session_id, kind, prompt, image_path, mimetype, xai_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, agent["id"], session["id"], kind, name, image_path,
         mimetype, None, utcnow()),
    )
    con.commit()
    return {
        "imagine_image_id": cur.lastrowid,
        "kind": kind,
        "image_url": image_path,
        "name": name,
    }


@router.post("/session/{session_id}/selfie")
def session_selfie(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    """Persist a canvas snapshot the browser captured for the take_selfie
    tool. The image lands in the Imagine library (kind 'selfie') so the
    model can immediately reuse it via create_video's source_image /
    reference_images."""
    session = resolve_session(con, session_id)
    agent = store.get_agent(con, session["agent_id"])
    return _store_session_image(
        con, session_id, payload.get("image_data_url"),
        kind="selfie", name=f"Selfie — {agent['name']}",
        flag="enable_capture_tools",
    )


@router.post("/session/{session_id}/upload_image")
def session_upload_image(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    """Voice-mode image upload: the browser downscales the user's picture to
    a data URI and it lands in the Imagine library (kind 'upload'). The
    client then injects a context note telling the model the image_url, so
    it can look at nothing (voice models are audio-only) but can USE the
    image — create_video's source_image / reference_images resolve it like
    any other library entry."""
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "Uploaded image"
    # Filenames are user-controlled — keep them short and single-line so the
    # library list and the context note stay tidy.
    name = name.strip().replace("\n", " ")[:80]
    return _store_session_image(
        con, session_id, payload.get("image_data_url"),
        kind="upload", name=name,
    )


@router.post("/session/{session_id}/screenshot")
def session_screenshot(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    """Persist a frame the take_screenshot tool grabbed from the user's
    armed screen share. Lands in the files library (kind 'screenshot') so
    the transcript can thumbnail it and delegate_task can analyze it."""
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "Screenshot"
    name = name.strip().replace("\n", " ")[:80]
    return _store_session_image(
        con, session_id, payload.get("image_data_url"),
        kind="screenshot", name=name,
        flag="enable_capture_tools",
    )


@router.post("/session/{session_id}/screen_clip")
async def session_screen_clip(
    session_id: int,
    file: UploadFile = File(...),
    name: str = Form(default=""),
    con=Depends(db_con),
):
    """Persist a clip the record_screen_clip tool captured from the user's
    armed screen share. Multipart (clips run to tens of MB — no base64
    JSON round-trip), stored as a files-library row only: no eager xAI
    upload, imagine_tools.ensure_xai_file re-uploads lazily if
    delegate_task ever needs to watch it."""
    session = resolve_session(con, session_id)
    if session["state"] != "active":
        raise ValidationError("Session is not active.")
    agent = store.get_agent(con, session["agent_id"])
    if not agent["enable_capture_tools"]:
        raise AccessError("Capture tools are disabled on this agent.")
    content = await file.read()
    mimetype = file.content_type or "video/webm"
    if not content:
        raise ValidationError("No clip provided.")
    if not mimetype.startswith("video/"):
        raise ValidationError(f"Unsupported clip mimetype {mimetype!r}.")
    if len(content) > 48 * 1024 * 1024:
        raise ValidationError("Clip too large (max 48 MB).")
    if not isinstance(name, str) or not name.strip():
        name = "Screen recording"
    name = name.strip().replace("\n", " ")[:80]
    ext = ".mp4" if "mp4" in mimetype else ".webm"
    fname = f"imagine_{uuid.uuid4().hex}{ext}"
    (FILES_DIR / fname).write_bytes(content)
    image_path = f"/files/{fname}"
    cur = con.execute(
        """INSERT INTO imagine_images
               (name, agent_id, session_id, kind, prompt, image_path, mimetype, xai_model, created_at)
           VALUES (?, ?, ?, 'screen_clip', ?, ?, ?, NULL, ?)""",
        (name, agent["id"], session["id"], name, image_path, mimetype, utcnow()),
    )
    con.commit()
    return {
        "imagine_image_id": cur.lastrowid,
        "kind": "screen_clip",
        "video_url": image_path,
        "name": name,
    }


@router.post("/session/{session_id}/upload_file")
async def session_upload_file(session_id: int, file: UploadFile = File(...), con=Depends(db_con)):
    """Voice-mode document upload (PDF, CSV, anything non-image): multipart
    proxy to xAI /v1/files, same shape as /api/text/session/<id>/upload. The
    realtime model can't read the file — the client injects a context note
    with the returned xai_file_id so the model can pass it to delegate_task
    for analysis. Images take the /upload_image data-URI route instead
    (they land in the Imagine library)."""
    session = resolve_session(con, session_id)
    content = await file.read()
    result = session_service.upload_text_attachment(
        con, session=session,
        filename=file.filename,
        content_bytes=content,
        mimetype=file.content_type,
    )
    con.commit()
    # Drop the raw upstream body so the response stays small and we don't
    # leak xAI internals to the browser.
    return {k: v for k, v in result.items() if k != "raw"}


@router.post("/session/{session_id}/end")
def session_end(session_id: int, payload: dict = Body(default={}), con=Depends(db_con)):
    session = resolve_session(con, session_id)
    return session_service.end_session(
        con, session,
        reason=payload.get("reason") or "client",
        total_input_tokens=payload.get("total_input_tokens") or 0,
        total_output_tokens=payload.get("total_output_tokens") or 0,
    )


@router.post("/director/decide")
def director_decide(payload: dict = Body(default={}), con=Depends(db_con)):
    """Group-call turn director: given the recent speaker-labelled transcript
    and the candidate agents, decide who speaks next ('user' or a
    participant key). Gated through the primary leg's session; failures
    degrade to {'next': None} and the client applies its local rules."""
    session = resolve_session(con, payload.get("session_id"))
    transcript = payload.get("transcript")
    participants = payload.get("participants")
    return session_service.director_decide(
        con,
        session=session,
        transcript_lines=transcript if isinstance(transcript, list) else [],
        participants=participants if isinstance(participants, list) else [],
        user_name=payload.get("user_name"),
        floor_key=payload.get("floor_key"),
    )


@router.post("/sessions")
def session_list(payload: dict = Body(default={}), con=Depends(db_con)):
    limit = int(payload.get("limit") or 20)
    # No mode filter: text conversations are resumable as voice (and
    # vice-versa), so the history list shows every conversation. Delegated
    # task workspaces are hidden — they're delegate_task's background
    # artifacts, not conversations the user held.
    rows = con.execute(
        "SELECT s.*, a.name AS agent_name,"
        " (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count"
        " FROM sessions s JOIN agents a ON a.id = s.agent_id"
        " WHERE s.origin NOT IN ('delegated', 'heartbeat')"
        " ORDER BY s.last_active_at DESC, s.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [
        {
            "id": s["id"],
            "name": s["name"],
            "mode": s["mode"],
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
    agents = store.list_agents(con)
    config = get_config(con)
    accessible_ids = {a["id"] for a in agents}
    default_id = (
        config["default_agent_id"]
        if config["default_agent_id"] in accessible_ids
        else False
    )

    out = []
    for a in agents:
        # Mode-agnostic: the latest conversation with this agent is
        # resumable as voice even if it was last held in text. Delegated
        # task workspaces are excluded — not user conversations.
        sess = con.execute(
            "SELECT * FROM sessions WHERE agent_id = ?"
            " AND state IN ('ended', 'active') AND origin NOT IN ('delegated', 'heartbeat')"
            " ORDER BY last_active_at DESC, id DESC LIMIT 1",
            (a["id"],),
        ).fetchone()
        imagine = store.latest_imagine_background(con, a["id"])
        imagine_video = store.latest_imagine_video_background(con, a["id"])
        out.append({
            "id": a["id"],
            "name": a["name"],
            "voice": a["voice"],
            # Voice activation: the browser's standby listener builds its
            # grammar from these (lib/wake_word.js).
            "wake_phrase": a["wake_phrase"] or "",
            "wake_action": a["wake_action"] or "resume_last",
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
            "latest_imagine_video_background": (
                store.imagine_payload(imagine_video) if imagine_video else None
            ),
        })
    return {"default_agent_id": default_id, "agents": out}
