# Copyright 2026 Codemarchant
"""Background music in calls (call_music.py): the tracks a companion can
play, each track's loudness, and links downloaded for a call. Playback is
the browser's (web/src/models/background_music.js)."""
from fastapi import APIRouter, Body, Depends

from .. import call_music
from ..db import get_config
from ..errors import UserError
from .common import db_con

router = APIRouter(prefix="/api/music")


@router.post("/tracks")
def music_tracks(payload: dict = Body(default={}), con=Depends(db_con)):
    """A companion's tracks (its avatar's own, plus the library unless the
    avatar opts out) and the playback levels."""
    agent_id = payload.get('agent_id')
    if agent_id is not None and not isinstance(agent_id, int):
        raise UserError('agent_id must be an integer.')
    avatar_id = call_music.agent_avatar_id(con, agent_id)
    listed = call_music.tracks(con, avatar_id)
    return {'tracks': listed, 'playlists': call_music.playlists(con, avatar_id, listed),
            'levels': call_music.LEVELS,
            'start_on_call': bool(get_config(con)['music_on_call_start'])}


@router.post("/settings")
def music_settings(payload: dict = Body(default={}), con=Depends(db_con)):
    """"Start music when a call starts" (config.music_on_call_start)."""
    on = bool(payload.get('start_on_call'))
    con.execute("UPDATE config SET music_on_call_start = ? WHERE id = 1", (int(on),))
    con.commit()
    return {'start_on_call': on}


@router.post("/playlists")
def music_playlists(payload: dict = Body(default={}), con=Depends(db_con)):
    """The music library's playlists (History → Recordings → Your sounds)."""
    return {'playlists': call_music.library_playlists(con)}


@router.post("/playlists/save")
def music_playlist_save(payload: dict = Body(default={}), con=Depends(db_con)):
    playlist_id = payload.get('id')
    if playlist_id is not None and not isinstance(playlist_id, int):
        raise UserError('id must be an integer.')
    call_music.save_library_playlist(con, playlist_id=playlist_id, name=payload.get('name'),
                                     track_names=payload.get('tracks'))
    return {'playlists': call_music.library_playlists(con)}


@router.post("/playlists/delete")
def music_playlist_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    con.execute("DELETE FROM music_playlists WHERE id = ?", (payload.get('id'),))
    con.commit()
    return {'playlists': call_music.library_playlists(con)}


@router.post("/loudness")
def music_loudness(payload: dict = Body(default={})):
    """A track's integrated loudness (LUFS; None = silent). A plain def:
    the first measurement decodes a few minutes of audio."""
    return {'lufs': call_music.loudness(payload.get('url'))}


@router.post("/fetch")
def music_fetch(payload: dict = Body(default={}), con=Depends(db_con)):
    """Download a link for the call (play_background_music's `url`, or the
    panel's link box) → the track to play."""
    agent_id = payload.get('agent_id')
    if payload.get('from_companion'):
        row = con.execute("SELECT enable_background_music_downloads FROM agents WHERE id = ?",
                          (agent_id,)).fetchone()
        if not row or not row['enable_background_music_downloads']:
            raise UserError('Playing music from links is switched off for this companion.')
    keep = bool(get_config(con)['keep_downloaded_sounds'])
    return {'track': call_music.fetch(con, payload.get('url'), title=payload.get('title'), keep=keep)}
