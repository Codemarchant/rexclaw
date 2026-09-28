# Copyright 2026 Codemarchant
"""Karaoke stage: songs, their sung vocals, and dances.

Rendering a companion's vocals takes a while (every line goes through TTS
and the singing resynthesis), so /render starts a job on a thread and the
stage polls /render/status for its progress.
"""
import json
import logging
import re
import threading
import time
import uuid

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from .. import music_analysis, singing, song_examples, song_sheet, song_synth, songs, voicemail_tools
from ..db import ASSETS_DIR, FILES_DIR, connect, get_config, utcnow
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/songs")

DANCES_DIR = FILES_DIR / 'dances'
MAX_DANCE_BYTES = 40 * 1024 * 1024

_jobs = {}            # job id → {'state', 'stage', 'done', 'total', 'error', 'result', 'at'}
_jobs_lock = threading.Lock()


def _examples(con):
    """Built-in songs; `id` is set once one has been prepared."""
    have = {r['example_key']: r['id'] for r in con.execute(
        "SELECT id, example_key FROM songs WHERE source = 'example'")}
    out = []
    for ex in song_examples.EXAMPLES:
        sheet = song_sheet.parse(ex['abc'])
        out.append({'key': ex['key'], 'title': sheet['title'], 'style': ex['style'],
                    'id': have.get(ex['key']), 'summary': song_sheet.describe(sheet)})
    return out


def _dances(con):
    return [dict(r) for r in con.execute("SELECT * FROM dances ORDER BY lower(name)")]


BUILTIN_DANCES_DIR = ASSETS_DIR / 'vrma' / 'dances'
# The avatar gestures that double as dances.
_GESTURE_DANCES = [('dance', '/assets/vrma/Dance.vrma'), ('belly-dance', '/assets/vrma/BellyDance.vrma')]


def _builtin_dances():
    """Dances shipped with the app: every .vrma in assets/vrma/dances, plus
    the two dance gestures."""
    out = [{'key': f'builtin:{k}', 'name': k, 'url': u, 'kind': 'vrma'} for k, u in _GESTURE_DANCES]
    if BUILTIN_DANCES_DIR.is_dir():
        for p in sorted(BUILTIN_DANCES_DIR.glob('*.vrma')):
            out.append({'key': f'builtin:{p.stem}', 'name': p.stem, 'kind': 'vrma',
                        'url': f'/assets/vrma/dances/{p.name}'})
    return out


def _payload(con):
    return {'songs': songs.list_songs(con), 'examples': _examples(con), 'dances': _dances(con),
            'builtin_dances': _builtin_dances(), 'styles': song_synth.STYLES}


@router.post("/bootstrap")
def songs_bootstrap(payload: dict = Body(default={}), con=Depends(db_con)):
    out = _payload(con)
    if payload.get('agent_id'):
        _voice, profile, singer = singer_for(con, payload['agent_id'])
        out['singer'] = singer
        out['profile'] = {'id': profile['id'], 'name': profile['name']} if profile else None
    return out


def build_sheet_song(con, abc, *, style, source, agent_id=None, example_key=None, credit='',
                     language='en'):
    """ABC sheet → a stored song with a synthesised backing. Returns
    (song id, parsed sheet)."""
    sheet = song_sheet.parse(abc)
    style = style if style in song_synth.STYLES else 'pop'
    backing, beat_energy = song_synth.render(sheet, style)
    grid = dict(sheet['grid'])
    analysis = music_analysis.grid(grid['bpm'], backing.shape[1] / song_synth.SR,
                                   beats_per_bar=grid['beats_per_bar'], energy=beat_energy)
    song_id = songs.create_song(
        con, title=sheet['title'], artist=sheet['composer'], source=source, chart=sheet['chart'],
        backing=backing, backing_rate=song_synth.SR, backing_mode='generated', source_text=abc,
        agent_id=agent_id, credit=credit, analysis=analysis, language=language)
    con.execute("UPDATE songs SET style = ?, example_key = ? WHERE id = ?", (style, example_key, song_id))
    return song_id, sheet


@router.post("/example")
def songs_example(payload: dict = Body(default={}), con=Depends(db_con)):
    """Prepare a built-in song (arrange + synthesise its backing once)."""
    key = payload.get('key')
    ex = next((e for e in song_examples.EXAMPLES if e['key'] == key), None)
    if not ex:
        raise UserError('Unknown example song.')
    row = con.execute("SELECT id FROM songs WHERE source = 'example' AND example_key = ?", (key,)).fetchone()
    if row:
        song_id = row['id']
    else:
        sheet = song_sheet.parse(ex['abc'])
        song_id, _sheet = build_sheet_song(con, ex['abc'], style=ex['style'], source='example',
                                           example_key=key, language=ex.get('language', 'en'),
                                           credit=sheet['composer'] or 'Rexclaw original')
        con.commit()
    return {'id': song_id, **_payload(con)}


@router.post("/import")
def songs_import(
    files: list[UploadFile] = File(...),
    vocals: str = Form('auto'),
    con=Depends(db_con),
):
    """An UltraStar .txt plus its audio. A plain def: decoding and the beat
    analysis run in FastAPI's thread pool."""
    got = []
    for f in files:
        raw = f.file.read(songs.MAX_UPLOAD_BYTES + 1)
        got.append((f.filename or 'upload', raw))
    song_id = songs.import_ultrastar(con, got, vocals_mode=vocals if vocals in ('auto', 'reduce', 'keep') else 'auto')
    con.commit()
    return {'id': song_id, **_payload(con)}


@router.post("/save")
def songs_save(payload: dict = Body(default={}), con=Depends(db_con)):
    song_id = payload.get('id')
    songs.get_song(con, song_id)
    con.execute("UPDATE songs SET title = ?, artist = ?, credit = ? WHERE id = ?",
                ((payload.get('title') or '').strip()[:120] or 'Untitled song',
                 (payload.get('artist') or '').strip()[:120],
                 (payload.get('credit') or '').strip()[:300], song_id))
    con.commit()
    return _payload(con)


@router.post("/delete")
def songs_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    songs.delete_song(con, payload.get('id'))
    con.commit()
    return _payload(con)


@router.post("/restyle")
def songs_restyle(payload: dict = Body(default={}), con=Depends(db_con)):
    """Re-arrange a written song's backing in another style. The chart and
    any sung vocals stay valid: the timing comes from the sheet."""
    row = songs.get_song(con, payload.get('id'))
    if row['backing_mode'] != 'generated' or not row['source_text']:
        raise UserError('Only songs with a generated backing can change style.')
    style = payload.get('style')
    if style not in song_synth.STYLES:
        raise UserError('Unknown style.')
    sheet = song_sheet.parse(row['source_text'])
    backing, beat_energy = song_synth.render(sheet, style)
    folder = songs.song_dir(row['folder'])
    songs.write_ogg(folder / row['backing_file'], backing, song_synth.SR)
    analysis = music_analysis.grid(sheet['grid']['bpm'], backing.shape[1] / song_synth.SR,
                                   beats_per_bar=sheet['grid']['beats_per_bar'], energy=beat_energy)
    con.execute("UPDATE songs SET style = ?, analysis = ?, duration_seconds = ? WHERE id = ?",
                (style, json.dumps(analysis), round(backing.shape[1] / song_synth.SR, 2), row['id']))
    con.commit()
    return _payload(con)


@router.post("/stage")
def songs_stage(payload: dict = Body(default={}), con=Depends(db_con)):
    """Everything the stage needs to perform one song by one companion
    (its voice profile's vocals when it has one)."""
    singer = payload.get('voice')
    if payload.get('agent_id'):
        _voice, _profile, singer = singer_for(con, payload['agent_id'], payload.get('voice'))
    return songs.stage_payload(con, payload.get('id'), singer)


def _voice_for(con, payload):
    voice = (payload.get('voice') or '').strip()
    if not voice and payload.get('agent_id'):
        row = con.execute("SELECT voice FROM agents WHERE id = ?", (payload['agent_id'],)).fetchone()
        voice = row['voice'] if row else ''
    return voice or 'eve'


def singer_for(con, agent_id=None, voice=None):
    """(xAI voice, ready voice profile row or None, singer key) for a
    companion: its Voice Lab profile when it has a trained one."""
    agent = con.execute("SELECT voice, singing_profile_id FROM agents WHERE id = ?",
                        (agent_id,)).fetchone() if agent_id else None
    voice = (voice or (agent['voice'] if agent else '') or 'eve').strip()
    profile = None
    if agent and agent['singing_profile_id']:
        profile = con.execute("SELECT * FROM voice_profiles WHERE id = ? AND status = 'ready'",
                              (agent['singing_profile_id'],)).fetchone()
    return voice, profile, singing.singer_key(voice, profile)


def start_render_job(song_id, voice, language=None, profile_id=None):
    """Sing a song on a background thread; returns the job id."""
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        for k in [k for k, j in _jobs.items() if time.monotonic() - j['at'] > 3600]:
            _jobs.pop(k, None)
        _jobs[job_id] = {'state': 'running', 'stage': 'voice', 'done': 0, 'total': 0,
                         'error': None, 'result': None, 'at': time.monotonic(),
                         'song_id': song_id, 'voice': voice, 'profile_id': profile_id}

    def progress(stage, done, total):
        with _jobs_lock:
            _jobs[job_id].update(stage=stage, done=done, total=total)

    def run():
        con = connect()
        try:
            profile = con.execute("SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)).fetchone() \
                if profile_id else None
            result = singing.render(con, get_config(con), song_id, voice=voice, language=language,
                                    progress=progress, profile=profile)
            con.commit()
            with _jobs_lock:
                _jobs[job_id].update(state='done', result=result)
        except UserError as e:
            with _jobs_lock:
                _jobs[job_id].update(state='error', error=str(e))
        except Exception as e:   # noqa: BLE001 — surfaced to the stage, logged here
            _logger.exception('song render failed')
            with _jobs_lock:
                _jobs[job_id].update(state='error', error=f'Singing failed: {e}')
        finally:
            con.close()

    threading.Thread(target=run, name=f'song-render-{song_id}', daemon=True).start()
    return job_id


@router.post("/render")
def songs_render(payload: dict = Body(default={}), con=Depends(db_con)):
    row = songs.get_song(con, payload.get('id'))
    voice, profile, _singer = singer_for(con, payload.get('agent_id'), payload.get('voice'))
    pid = profile['id'] if profile else None
    with _jobs_lock:
        running = next((k for k, j in _jobs.items() if j['state'] == 'running'
                        and j['song_id'] == row['id'] and j['voice'] == voice
                        and j.get('profile_id') == pid), None)
    return {'job': running or start_render_job(row['id'], voice, payload.get('language'), pid)}


@router.post("/render/status")
def songs_render_status(payload: dict = Body(default={})):
    with _jobs_lock:
        job = dict(_jobs.get(payload.get('job')) or {})
    if not job:
        raise UserError('That render job is gone (the server restarted?). Start it again.')
    job.pop('at', None)
    return job


@router.post("/record")
def songs_record(payload: dict = Body(default={}), con=Depends(db_con)):
    """Mix backing + vocals into one mp3 in History → Recordings."""
    row = songs.get_song(con, payload.get('id'))
    voice = _voice_for(con, payload)
    if payload.get('agent_id'):
        _v, _p, voice = singer_for(con, payload['agent_id'])
    try:
        vocal_db = float(payload.get('vocal_db') or 0)
    except (TypeError, ValueError):
        vocal_db = 0.0
    path, duration = songs.mix_to_recording(con, row['id'], voice, vocal_db=max(-24, min(12, vocal_db)))
    rec_id = voicemail_tools.store_recording(
        con, name=f'{row["title"]} (sung)', source='playground',
        script=songs.lyrics_text(json.loads(row['chart'])), voice=voice,
        result={'audio_url': path, 'duration_seconds': round(duration, 1), 'tts_chars': 0},
        agent_id=payload.get('agent_id'), category='Songs')
    con.commit()
    return {'recording_id': rec_id, 'audio_url': path}


# ---------------------------------------------------------------------------
# Dances
# ---------------------------------------------------------------------------

@router.post("/dances/upload")
def dances_upload(
    name: str = Form(''),
    song_id: str = Form(''),
    offset_ms: str = Form('0'),
    arm_angle: str = Form('30'),
    credit: str = Form(''),
    file: UploadFile = File(...),
    con=Depends(db_con),
):
    fname = file.filename or 'dance'
    ext = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
    if ext not in ('vmd', 'vrma'):
        raise UserError('Dances are MMD motion files (.vmd) or VRM animations (.vrma).')
    raw = file.file.read(MAX_DANCE_BYTES + 1)
    if len(raw) > MAX_DANCE_BYTES:
        raise UserError(f'The file is over {MAX_DANCE_BYTES // (1024 * 1024)} MB.')
    if ext == 'vmd' and not raw.startswith(b'Vocaloid Motion Data'):
        raise UserError('That is not an MMD motion file (the VMD header is missing).')
    DANCES_DIR.mkdir(parents=True, exist_ok=True)
    stored = f'dance_{uuid.uuid4().hex}.{ext}'
    (DANCES_DIR / stored).write_bytes(raw)
    try:
        sid = int(song_id) if song_id.strip() else None
        off = int(float(offset_ms or 0))
        arm = max(0.0, min(60.0, float(arm_angle or 30)))
    except ValueError:
        raise UserError('Offset and arm angle are numbers.')
    con.execute("""INSERT INTO dances (name, kind, file_path, song_id, offset_ms, arm_angle, credit,
                                       created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                ((name.strip() or re.sub(r'\.[^.]+$', '', fname))[:80], ext, f'/files/dances/{stored}',
                 sid, off, arm, credit.strip()[:300], utcnow()))
    con.commit()
    return _payload(con)


@router.post("/dances/save")
def dances_save(payload: dict = Body(default={}), con=Depends(db_con)):
    dance_id = payload.get('id')
    row = con.execute("SELECT * FROM dances WHERE id = ?", (dance_id,)).fetchone()
    if not row:
        raise UserError('That dance no longer exists.')
    try:
        off = int(float(payload.get('offset_ms', row['offset_ms']) or 0))
        arm = max(0.0, min(60.0, float(payload.get('arm_angle', row['arm_angle']))))
    except (TypeError, ValueError):
        raise UserError('Offset and arm angle are numbers.')
    sid = payload.get('song_id')
    con.execute("UPDATE dances SET name = ?, song_id = ?, offset_ms = ?, arm_angle = ?, credit = ? WHERE id = ?",
                ((payload.get('name') or row['name']).strip()[:80], sid if isinstance(sid, int) else None,
                 off, arm, (payload.get('credit') or '').strip()[:300], dance_id))
    con.commit()
    return _payload(con)


@router.post("/dances/delete")
def dances_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    row = con.execute("SELECT * FROM dances WHERE id = ?", (payload.get('id'),)).fetchone()
    if row:
        con.execute("DELETE FROM dances WHERE id = ?", (row['id'],))
        con.commit()
        try:
            (DANCES_DIR / row['file_path'].rsplit('/', 1)[-1]).unlink(missing_ok=True)
        except OSError as e:
            _logger.warning('could not delete %s: %s', row['file_path'], e)
    return _payload(con)
