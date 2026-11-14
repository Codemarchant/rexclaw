# Copyright 2026 Codemarchant
"""Sound effects in calls (sound_effects.py): the effects a companion can
play and each one's playback gain. Playback is the browser's
(web/src/models/sound_effects.js)."""
from fastapi import APIRouter, Body, Depends

from .. import call_music, sound_effects
from ..errors import UserError
from .common import db_con

router = APIRouter(prefix="/api/sound_effects")


@router.post("/list")
def sound_effects_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """A companion's effects: its avatar's own, plus the library unless the
    avatar opts out. Without a companion, or with whole_library, the
    library is always included (the avatar editor's picker)."""
    agent_id = payload.get('agent_id')
    if agent_id is not None and not isinstance(agent_id, int):
        raise UserError('agent_id must be an integer.')
    avatar_id = call_music.agent_avatar_id(con, agent_id)
    return {'effects': sound_effects.effects(con, avatar_id, whole_library=bool(payload.get('whole_library')))}


@router.post("/level")
def sound_effects_level(payload: dict = Body(default={})):
    """The gain (dB) that plays an effect's file at the call's effect
    level; `level` is the effect's own offset (a library sound's level).
    A plain def: the first measurement decodes the file."""
    return {'gain_db': sound_effects.level(payload.get('url'), payload.get('level'))}
