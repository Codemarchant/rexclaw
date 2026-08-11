"""Minecraft sidecar link: a WebSocket for the bot process (the server's
first — everything else is client-initiated REST) and a polling endpoint the
web client uses to feed bot events into a live call."""
import asyncio
import json
import logging
import os

from fastapi import APIRouter, Body, Depends, WebSocket, WebSocketDisconnect

from .. import minecraft_tools, store
from ..db import connect
from .common import db_con, resolve_session

_logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/minecraft")
async def minecraft_ws(ws: WebSocket):
    # The config message carries the user's xAI key, so when the server is
    # reachable beyond localhost (Docker/LAN), REXCLAW_MC_TOKEN gates the
    # socket: the sidecar presents it via `node index.js --token <secret>`.
    token = os.environ.get('REXCLAW_MC_TOKEN', '')
    if token and ws.query_params.get('token') != token:
        await ws.close(code=4401)
        _logger.warning("minecraft sidecar rejected (bad or missing token)")
        return
    await ws.accept()
    # Push config (API key, brain model, master player) immediately — the
    # sidecar's brain is dormant until it has a key.
    con = connect()
    try:
        config_msg = minecraft_tools.sidecar_config(con)
    finally:
        con.close()
    minecraft_tools.link.attach(ws, asyncio.get_running_loop())
    await ws.send_text(json.dumps(config_msg))
    minecraft_tools.link.push_event("link", "Minecraft bot link established.", "low")
    _logger.info("minecraft sidecar connected")
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("type")
            if kind == "status":
                minecraft_tools.link.set_status(msg.get("data"))
            elif kind == "event":
                minecraft_tools.link.push_event(
                    str(msg.get("kind") or "notify"),
                    str(msg.get("text") or "")[:1000],
                    str(msg.get("urgency") or "normal"),
                )
    except WebSocketDisconnect:
        pass
    finally:
        # A superseded socket's teardown must not announce "link lost"
        # while its replacement is alive and connected.
        if minecraft_tools.link.detach(ws):
            minecraft_tools.link.push_event("link", "Minecraft bot link lost.", "normal")
        _logger.info("minecraft sidecar disconnected")


@router.post("/api/minecraft/state")
def minecraft_state(payload: dict = Body(default={}), con=Depends(db_con)):
    """Poll endpoint for the web client. cursor omitted/null → no event
    backlog (fresh subscribers start from 'now'); integer cursor → events
    newer than it. session_id gates the events on that session's companion
    actually having the bot enabled — a running sidecar must not narrate
    into calls with companions that can't use it."""
    cursor = payload.get("cursor")
    snap = minecraft_tools.link.snapshot(cursor if isinstance(cursor, int) else None)
    session_id = payload.get("session_id")
    if session_id:
        try:
            session = resolve_session(con, int(session_id))
            agent = store.get_agent(con, session["agent_id"])
            if not agent["enable_minecraft"]:
                snap["events"] = []
        except Exception:
            snap["events"] = []
    return snap
