# Copyright 2026 Codemarchant
"""Live-stream chat endpoints for a call's idle events (see live_chat.py)."""
from fastapi import APIRouter, Body, Depends

from .. import live_chat
from ..db import get_config
from .common import db_con

router = APIRouter(prefix="/api/live_chat")


@router.post("/state")
def live_chat_state(payload: dict = Body(default={}), con=Depends(db_con)):
    """The call's poll: keeps the readers the settings ask for running (they
    stop a minute after the polls do) and reports the unread count, the
    running total of accepted messages, and each platform's status."""
    live_chat.feed.touch(get_config(con))
    return live_chat.feed.state()


@router.post("/take")
def live_chat_take(payload: dict = Body(default={})):
    """An idle event reads chat: the newest `count` unread messages, after
    which the unread pool starts over (see live_chat.take)."""
    try:
        count = int(payload.get("count") or 10)
    except (TypeError, ValueError):
        count = 10
    return {"messages": live_chat.feed.take(count)}
