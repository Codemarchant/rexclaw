# Copyright 2026 Codemarchant
"""Neural body motion: the model list, and the socket frames stream over.

Text messages are JSON: {type: "start", model, style, rate}, then "finish"
at the end of a reply and "cancel" on a barge-in. Audio goes up as binary:
f64 playback time, then float32 mono PCM at `rate`. Frames come down as
binary: f64 first frame's playback time, u32 frame count, u32 cancel count,
float32 quaternions in the order the "ready" message names the bones, then
the float32 pelvis offsets, three per frame, then the four foot contact
values and the three root values for a model with those.
A cancel counter on every frame lets the browser drop what was in flight.
Also "seed" {pose} as a line starts, and "finish" may carry {idle}: VRM
poses, for the model to start from and to end on.
"""

import asyncio
import json
import logging
import struct
import time

import numpy as np
from fastapi import APIRouter, Body, Depends, WebSocket, WebSocketDisconnect

from .. import neural_motion
from ..db import get_config
from ..neural_motion.stream import MotionSession
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/neural_motion")


@router.post("/settings")
def settings(payload: dict = Body(default={}), con=Depends(db_con)):
    """Read, or patch with any of on / model / style / parts.
    agent_id: the companion on screen; switching to one with another avatar
    first takes that avatar's defaults (neural_motion.apply_avatar)."""
    switched = False
    if payload.get("agent_id"):
        row = con.execute("SELECT av.id, av.neural_motion FROM agents a JOIN avatars av ON av.id = a.avatar_id"
                          " WHERE a.id = ?", (int(payload["agent_id"]),)).fetchone()
        if row:
            try:
                defaults = json.loads(row["neural_motion"] or "{}")
            except ValueError:
                defaults = {}
            switched = neural_motion.apply_avatar(con, row["id"], defaults)
    sets, vals = [], []
    if "on" in payload:
        sets.append("neural_motion_on = ?")
        vals.append(1 if payload["on"] else 0)
    main = neural_motion.MAIN_MODEL
    if "model" in payload and (payload["model"] or main) != (get_config(con)["neural_motion_model"] or main):
        # A model's style ids are its own ('' is the main model, so naming it isn't a change).
        sets += ["neural_motion_model = ?", "neural_motion_style = -1"]
        vals.append(str(payload["model"]))
    if "style" in payload:
        sets.append("neural_motion_style = ?")
        vals.append(int(payload["style"]))
    if "parts" in payload:
        sets.append("neural_motion_parts = ?")
        vals.append(",".join(str(p) for p in payload["parts"]))
    if sets:
        con.execute(f"UPDATE config SET {', '.join(sets)} WHERE id = 1", vals)
        con.commit()
    config = get_config(con)
    return {
        "models": neural_motion.listing(),
        "settings": neural_motion.settings_of(config),
        "call": neural_motion.for_call(config),
        "switched": switched,
    }


async def _send(ws, frames, cancels):
    for t0, motion in frames:
        await ws.send_bytes(struct.pack("<dII", t0, len(motion.quats), cancels)
                            + motion.quats.tobytes() + motion.hips.tobytes()
                            + (motion.feet.tobytes() if motion.feet is not None else b"")
                            + (motion.root.tobytes() if motion.root is not None else b""))


def _pose(values, model):
    return np.array(values, np.float32).reshape(len(model.bones), 4)


async def _run(ws, queue, state):
    """One message at a time; a message that fails is reported and skipped, so
    one bad seed or start never stops the stream (or leaves its queue unread)."""
    current = {"session": None, "model": None}
    while True:
        message = await queue.get()
        try:
            await _handle(ws, message, state, current)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _logger.exception("neural motion: a stream message failed")
            # `of`: which message failed, so the browser counts only a start's as its answer.
            of = message.get("type") if isinstance(message, dict) else "audio"
            await ws.send_json({"type": "error", "message": str(e), "of": of})


async def _handle(ws, message, state, current):
    session, model = current["session"], current["model"]
    # Stamped before the model runs: a cancel landing mid-inference makes
    # these frames stale, and the browser has to be able to tell.
    cancels = state["cancels"]
    if isinstance(message, tuple):
        start_at, pcm = message
        if session:
            await _send(ws, await asyncio.to_thread(session.audio, pcm, start_at), cancels)
        return
    kind = message.get("type")
    if kind == "start":
        model = neural_motion.get(message.get("model") or "")
        if model is None:
            await ws.send_json({"type": "error", "message": "That motion model is not installed.", "of": "start"})
            return
        style = message.get("style")
        style = int(style) if style is not None else model.default_style
        rate = int(message.get("rate") or 24000)
        shuffle = bool(message.get("shuffle"))
        current["session"] = await asyncio.to_thread(MotionSession, model, style, int(time.time()), rate, shuffle)
        current["model"] = model
        await ws.send_json({"type": "ready", "bones": model.bones, "fps": model.fps,
                            "feet": model.has_feet,
                            "hand_rest": model.hand_rest})
    elif kind == "seed" and session:
        frames = await asyncio.to_thread(session.seed, _pose(message["pose"], model), message.get("root"))
        await _send(ws, frames, cancels)
    elif kind == "finish" and session:
        idle = _pose(message["idle"], model) if message.get("idle") else None
        await _send(ws, await asyncio.to_thread(session.finish, idle), cancels)
    elif kind == "cancel" and session:
        await asyncio.to_thread(session.cancel)


async def _guarded(ws, queue, state):
    try:
        await _run(ws, queue, state)
    except asyncio.CancelledError:
        raise
    except Exception:
        _logger.exception("neural motion: stream failed")


@router.websocket("/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    queue = asyncio.Queue()
    state = {"cancels": 0}
    worker = asyncio.create_task(_guarded(ws, queue, state))
    try:
        while True:
            raw = await ws.receive()
            if raw["type"] == "websocket.disconnect":
                break
            if raw.get("bytes") is not None:
                data = raw["bytes"]
                start_at = struct.unpack_from("<d", data, 0)[0]
                await queue.put((start_at, np.frombuffer(data, "<f4", offset=8).copy()))
                continue
            message = json.loads(raw["text"])
            if message.get("type") == "cancel":
                # The audio still queued was for the speech just cut, and so is a finish
                # with no audio after it (the line the cut ended). An earlier line's
                # finish, a start or a seed queued meanwhile still applies, in order.
                queued = []
                while not queue.empty():
                    queued.append(queue.get_nowait())
                last_audio = max((i for i, item in enumerate(queued) if isinstance(item, tuple)), default=-1)
                for i, item in enumerate(queued):
                    if isinstance(item, tuple) or (item.get("type") == "finish" and i > last_audio):
                        continue
                    queue.put_nowait(item)
                state["cancels"] += 1
                await queue.put({"type": "cancel"})
            else:
                await queue.put(message)
    except WebSocketDisconnect:
        pass
    finally:
        worker.cancel()
