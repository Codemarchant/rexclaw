# Copyright 2026 Codemarchant
"""Background music in voice calls: play_background_music and the ♪ panel.

The music plays in the browser (web/src/models/background_music.js), in
whichever window holds the call, and stops with it. This module serves
what it plays:

  tracks     a companion's tracks: its avatar's own (avatar_music, the
             manifest "music" list) plus, unless the avatar opts out
             (music_library = 0), the music library: the user's music
             sounds (History → Recordings → Your sounds) and the bundled
             music
  loudness   BS.1770 integrated loudness of a track's first minutes, so
             every track plays at the same level (LEVELS)
  fetch      a link downloaded for the call (media_fetch.py): into the
             library when config.keep_downloaded_sounds is on, otherwise
             into a call-only folder that is cleared at startup

A background can name a track (avatar_backgrounds.music); the browser
starts it when that background is switched to in a call.
"""
import json
import logging
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np

from . import audio_sounds, audio_studio, media_fetch
from .db import FILES_DIR, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)

TOOL_NAME = 'play_background_music'
CALL_DIR = FILES_DIR / 'call_music'     # downloads not kept in the library
CALL_DIR_MAX_AGE = 24 * 3600            # older call-only downloads are removed
LOUDNESS_SECONDS = 300                  # measured over the first five minutes

# Levels, from the audio studio's music-under-voice numbers (audio_studio.py:
# voice clips arrive around −20 LUFS; a bed sits ~24 dB under the voice while
# someone speaks, inside the 18–25 dB norm, after an 8 dB duck). Call voices
# are taken to arrive at the same level as the studio's TTS clips.
VOICE_LUFS = -20.0
LEVELS = {
    'idle_lufs': VOICE_LUFS - 24 + audio_studio.DUCK_DB,   # −36: between lines
    'duck_db': audio_studio.DUCK_DB,
    'attack': audio_studio.DUCK_ATTACK,
    'release': audio_studio.DUCK_RELEASE,
    'fade': audio_studio.LAYER_FADE,                        # crossfade between tracks
}

_loudness_cache = {}   # disk path → (mtime, LUFS or None)
_lock = threading.Lock()


def library_tracks(con):
    """The music library as tracks: bundled music, then the user's music sounds."""
    out = [{'name': name, 'url': f'/assets/audio/beds/{fname}', 'description': desc, 'credit': '',
            'source': 'bundled'}
           for name, (fname, _kind, desc) in audio_sounds.BUNDLED_MUSIC.items()]
    out += [{'name': r['name'], 'url': r['file_path'], 'description': r['description'] or '',
             'credit': r['credit'] or '', 'source': 'library'}
            for r in audio_sounds.catalog(con).values() if r['kind'] == 'music']
    return out


def tracks(con, avatar_id, whole_library=False):
    """A companion's tracks (see the module docstring); an avatar's own
    tracks come first and win a name clash. whole_library: the library
    too even when the avatar opts out (the user's own ♪ panel picker)."""
    avatar = con.execute("SELECT music_library FROM avatars WHERE id = ?", (avatar_id,)).fetchone() \
        if avatar_id else None
    out = [{'name': r['name'], 'url': r['file_path'], 'description': r['description'],
            'credit': r['credit'], 'source': 'avatar'}
           for r in con.execute("SELECT * FROM avatar_music WHERE avatar_id = ? ORDER BY sequence, id",
                                (avatar_id,)).fetchall()] if avatar_id else []
    if whole_library or avatar is None or avatar['music_library']:
        taken = {t['name'].lower() for t in out}
        out += [t for t in library_tracks(con) if t['name'].lower() not in taken]
    return out


def agent_avatar_id(con, agent_id):
    row = con.execute("SELECT avatar_id FROM agents WHERE id = ?", (agent_id,)).fetchone() \
        if agent_id else None
    return row['avatar_id'] if row else None


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------

AUTO_PLAYLIST = 'All my tracks'   # every avatar with two or more tracks of its own


def playlists(con, avatar_id, listed=None):
    """A companion's playlists, each {name, source, default, tracks}: the
    avatar's own (manifest "playlists"), "All my tracks" (its own tracks,
    when it has two or more), then the library's (while the avatar uses
    the library). Track names a playlist can't resolve are skipped; an empty
    playlist is left out. `default` marks what a call opens with
    (config.music_on_call_start): the avatar's default playlist, else
    "All my tracks"."""
    listed = listed if listed is not None else tracks(con, avatar_id)
    by_name = {t['name'].lower(): t for t in listed}

    def resolve(names):
        return [by_name[n.lower()] for n in names if isinstance(n, str) and n.lower() in by_name]

    out = []
    if avatar_id:
        for r in con.execute("SELECT * FROM avatar_playlists WHERE avatar_id = ? ORDER BY sequence, id",
                             (avatar_id,)).fetchall():
            got = resolve(json.loads(r['tracks'] or '[]'))
            if got:
                out.append({'name': r['name'], 'source': 'avatar', 'default': bool(r['is_default']),
                            'tracks': got})
    own = [t for t in listed if t['source'] == 'avatar']
    taken = {p['name'].lower() for p in out}
    if len(own) >= 2 and AUTO_PLAYLIST.lower() not in taken:
        out.append({'name': AUTO_PLAYLIST, 'source': 'auto', 'default': False, 'tracks': own})
        taken.add(AUTO_PLAYLIST.lower())
    if not any(p['default'] for p in out) and out and out[-1]['source'] == 'auto':
        out[-1]['default'] = True
    # The library's tracks are listed only while the avatar uses the library.
    if any(t['source'] in ('bundled', 'library') for t in listed):
        for r in con.execute("SELECT * FROM music_playlists ORDER BY lower(name)").fetchall():
            got = resolve(json.loads(r['tracks'] or '[]'))
            if got and r['name'].lower() not in taken:
                out.append({'name': r['name'], 'source': 'library', 'default': False, 'tracks': got})
    return out


def library_playlists(con):
    """The library's playlists for History → Recordings: {id, name, tracks}."""
    return [{'id': r['id'], 'name': r['name'], 'tracks': json.loads(r['tracks'] or '[]')}
            for r in con.execute("SELECT * FROM music_playlists ORDER BY lower(name)").fetchall()]


def save_library_playlist(con, *, playlist_id=None, name, track_names):
    name = (name or '').strip()[:80]
    if not name:
        raise UserError('Give the playlist a name.')
    known = {t['name'] for t in library_tracks(con)}
    names = [n for n in track_names or [] if n in known]
    if not names:
        raise UserError('Pick at least one music track for the playlist.')
    clash = con.execute("SELECT id FROM music_playlists WHERE lower(name) = lower(?) AND id IS NOT ?",
                        (name, playlist_id)).fetchone()
    if clash:
        raise UserError(f'You already have a playlist called "{name}".')
    if playlist_id:
        con.execute("UPDATE music_playlists SET name = ?, tracks = ? WHERE id = ?",
                    (name, json.dumps(names), playlist_id))
    else:
        con.execute("INSERT INTO music_playlists (name, tracks, created_at) VALUES (?, ?, ?)",
                    (name, json.dumps(names), utcnow()))
    con.commit()


def sound_users(con, name=None, file_path=None):
    """What avatars would lose without a library sound: its file (file_path)
    as one of their tracks, or its name (name, a music library track) in a
    playlist or a background's music, unless their own track of that name
    wins. One line each."""
    out = [f'{r["avatar"]}\'s track "{r["name"]}"' for r in con.execute(
        """SELECT a.name AS avatar, m.name FROM avatar_music m JOIN avatars a ON a.id = m.avatar_id
           WHERE m.file_path = ? ORDER BY a.name, m.name""", (file_path,))] if file_path else []
    if not name:
        return out
    name = name.lower()
    for a in con.execute("SELECT id, name FROM avatars WHERE music_library ORDER BY name").fetchall():
        if con.execute("SELECT 1 FROM avatar_music WHERE avatar_id = ? AND lower(name) = ?",
                       (a['id'], name)).fetchone():
            continue
        for p in con.execute("SELECT name, tracks FROM avatar_playlists WHERE avatar_id = ? ORDER BY sequence, id",
                             (a['id'],)):
            if any(isinstance(n, str) and n.lower() == name for n in json.loads(p['tracks'] or '[]')):
                out.append(f'{a["name"]}\'s playlist "{p["name"]}"')
        for b in con.execute("SELECT name, music FROM avatar_backgrounds WHERE avatar_id = ? ORDER BY sequence, id",
                             (a['id'],)):
            if (b['music'] or '').lower() == name:
                out.append(f'{a["name"]}\'s background "{b["name"]}"')
    return out


def rename_in_library_playlists(con, old, new=None):
    """A library track renamed (new) or gone (None): the library's playlists
    follow. A playlist left with no tracks is removed. The caller commits."""
    for r in con.execute("SELECT id, tracks FROM music_playlists").fetchall():
        names = json.loads(r['tracks'] or '[]')
        if old not in names:
            continue
        names = [new if n == old else n for n in names if new or n != old]
        if names:
            con.execute("UPDATE music_playlists SET tracks = ? WHERE id = ?", (json.dumps(names), r['id']))
        else:
            con.execute("DELETE FROM music_playlists WHERE id = ?", (r['id'],))


# ---------------------------------------------------------------------------
# Loudness
# ---------------------------------------------------------------------------

def disk_path(url):
    """A track's web path → its file on disk, or UserError."""
    from .transfer import _shared_ref_disk_path
    path = _shared_ref_disk_path(url or '')
    if path is None:
        raise UserError(f'The music file {url} is missing.')
    return path


def loudness(url):
    """BS.1770 integrated loudness (LUFS) of a track's first
    LOUDNESS_SECONDS, cached per file; None for silence."""
    path = disk_path(url)
    mtime = path.stat().st_mtime
    with _lock:
        hit = _loudness_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    from .audio_studio import SR, _LOOP_SECONDS, _block_energies, _integrated_loudness
    # Measured a minute at a time as it decodes, like the studio's mix.
    chunk, energies, pending, held = _LOOP_SECONDS * SR, [], [], 0
    for _rate, x in media_fetch.decode(path, rate=SR, max_seconds=LOUDNESS_SECONDS):
        pending.append(x)
        held += len(x)
        if held >= chunk:
            x = np.concatenate(pending)
            energies.extend(_block_energies(x[:chunk].T))
            pending, held = [x[chunk:]], held - chunk
    if held:
        energies.extend(_block_energies(np.concatenate(pending).T))
    value = _integrated_loudness(energies)
    with _lock:
        _loudness_cache[path] = (mtime, value)
    return value


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

def clear_call_downloads(max_age=0):
    """Remove call-only downloads (all of them at startup)."""
    if not CALL_DIR.is_dir():
        return
    cutoff = time.time() - max_age
    for f in CALL_DIR.iterdir():
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def fetch(con, url, *, title=None, keep=False):
    """Download a link for the call → a track dict. Kept downloads join the
    library as music (and a link already there is reused); the others go to
    CALL_DIR."""
    url = (url or '').strip()
    if not re.match(r'^https?://', url):
        raise UserError(f'"{url}" is not a link.')
    known = con.execute("SELECT * FROM audio_sounds WHERE source_filename = ?", (url,)).fetchone()
    if known:
        return {'name': known['name'], 'url': known['file_path'], 'description': known['description'] or '',
                'credit': known['credit'] or '', 'source': 'library'}
    work = audio_sounds.SOUNDS_DIR / f'_download_{uuid.uuid4().hex}'
    try:
        meta = media_fetch.fetch_audio(url, work, max_seconds=audio_sounds.MAX_SECONDS)
        path, duration = audio_sounds.ingest_file(meta['audio'], url)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    label = (title or '').strip() or ' - '.join(v for v in (meta.get('artist'), meta.get('title')) if v) \
        or 'Downloaded track'
    credit = ', '.join(v for v in (meta.get('artist'), url) if v)[:300]
    if keep:
        name = _free_name(con, label)
        audio_sounds.store(con, name=name, kind='music', description=label[:300], level=0.0, credit=credit,
                           file_path=path, source_filename=url, duration=duration)
        con.commit()
        return {'name': name, 'url': path, 'description': label, 'credit': credit, 'source': 'library'}
    CALL_DIR.mkdir(parents=True, exist_ok=True)
    clear_call_downloads(CALL_DIR_MAX_AGE)
    fname = path.rsplit('/', 1)[-1]
    shutil.move(str(audio_sounds.SOUNDS_DIR / fname), str(CALL_DIR / fname))
    return {'name': label[:80], 'url': f'/files/call_music/{fname}', 'description': '', 'credit': credit,
            'source': 'download'}


def _free_name(con, label):
    """A library name (audio_sounds.NAME_RE) for a kept download."""
    base = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')[:34] or 'download'
    name, n = base, 1
    while name in audio_sounds.RESERVED or con.execute(
            "SELECT 1 FROM audio_sounds WHERE name = ?", (name,)).fetchone():
        n += 1
        name = f'{base}-{n}'
    return name


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------

def build_tool(con, agent):
    """play_background_music for a voice call, or None when the companion
    has nothing to play (no tracks, no downloads)."""
    downloads = bool(agent['enable_background_music_downloads'])
    listed = tracks(con, agent['avatar_id'])
    lists = playlists(con, agent['avatar_id'], listed)
    if not listed and not downloads:
        return None
    lines = '\n'.join(f'- {t["name"]}' + (f': {t["description"][:120]}' if t['description'] else '')
                      for t in listed)
    description = (
        'Play music quietly under the call, change it, or stop it. Use it when the user asks for '
        'music, or when the moment clearly calls for it and they would welcome it. A track loops '
        'until changed or stopped; a playlist plays its tracks in turn. It dips under voices by '
        'itself. To change the music, make ONE call with the new track, playlist or url: it '
        'crossfades from whatever is playing, so never stop the music first. Say it is playing '
        'only once this call has returned. The user can also pick music themselves; you get a '
        'note when they do. It stops when the call ends.'
    )
    if listed:
        description += '\n\nYour tracks:\n' + lines
    if lists:
        description += '\n\nYour playlists:\n' + '\n'.join(
            f'- {p["name"]}: ' + ', '.join(t['name'] for t in p['tracks']) for p in lists)
    props = {
        'track': {'type': 'string', 'enum': [t['name'] for t in listed] + ['off'],
                  'description': 'The track to play, or "off" only to stop the music for good.'},
        'volume': {'type': 'integer', 'minimum': 1, 'maximum': 100,
                   'description': 'Optional volume, 1-100; 50 is the usual background level. '
                                  'Only when the user asks for it louder or quieter.'},
    }
    if not listed:
        del props['track']['enum']
        props['track']['description'] = '"off" to stop the music.'
    if lists:
        props['playlist'] = {'type': 'string', 'enum': [p['name'] for p in lists],
                             'description': 'A playlist to play instead of a single track.'}
    if downloads:
        description += ('\n\nYou can also play music from the web: find a track (for example with web '
                        'search) and pass its link as `url`, instead of `track`. A YouTube link, '
                        'another video or music site, or an audio file all work. The download takes '
                        'up to a minute: the call returns once the music is playing (or says why it '
                        'could not), so keep talking meanwhile and do not put on other music.')
        props['url'] = {'type': 'string', 'description': 'A link to play instead of a track.'}
        props['title'] = {'type': 'string', 'description': 'With `url`: a short name for it, e.g. '
                                                           '"Lo-fi beats".'}
    return {'type': 'function', 'name': TOOL_NAME, 'description': description,
            'parameters': {'type': 'object', 'properties': props, 'required': []}}
