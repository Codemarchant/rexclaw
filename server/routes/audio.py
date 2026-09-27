# Copyright 2026 Codemarchant
"""Audio studio: the History → Recordings playground.

Built-in example scripts (audio_examples.py), the user's saved scripts,
their uploaded sounds (audio_sounds.py), rendering, and every recording,
including the voicemails companions send from text chat, which land in the
same list.
"""
import logging
import time

import requests
from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from .. import audio_examples, audio_sounds, audio_studio, voicemail_tools
from ..db import FILES_DIR, get_config, utcnow
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audio")

# Voices shipped when the roster can't be fetched (no key yet, offline).
_FALLBACK_VOICES = [{'voice_id': v, 'name': v.title(), 'custom': False}
                    for v in ('eve', 'ara', 'rex', 'sal', 'leo')]
_VOICES_TTL = 600
_voices_cache = {'at': 0.0, 'voices': None}


def _fetch_voices(config):
    """Built-in + custom voices from xAI, cached for ten minutes."""
    if _voices_cache['voices'] and time.monotonic() - _voices_cache['at'] < _VOICES_TTL:
        return _voices_cache['voices']
    if not config['xai_api_key']:
        return _FALLBACK_VOICES
    base = (config['xai_tts_url'] or 'https://api.x.ai/v1/tts').rsplit('/tts', 1)[0]
    headers = {'Authorization': f'Bearer {config["xai_api_key"]}'}
    # Each list on its own: an account without custom voices (or a failing
    # endpoint) must not cost the built-in roster.
    voices, built_in_ok = [], False
    for path, custom in (('/tts/voices', False), ('/custom-voices', True)):
        try:
            resp = requests.get(base + path, headers=headers, timeout=15)
            resp.raise_for_status()
            rows = resp.json().get('voices') or []
        except (requests.RequestException, ValueError) as e:
            _logger.warning('voice roster fetch failed (%s): %s', path, e)
            continue
        built_in_ok = built_in_ok or not custom
        voices += [{'voice_id': v.get('voice_id'), 'custom': custom,
                    'name': v.get('name') or v.get('voice_id'), 'gender': v.get('gender') or ''}
                   for v in rows]
    if not built_in_ok:
        voices = _FALLBACK_VOICES + voices
    _voices_cache.update(at=time.monotonic(), voices=voices)
    return voices


FROM_COMPANIONS = 'From companions'


def _recordings(con):
    rows = con.execute(
        """SELECT r.*, a.name AS agent_name FROM audio_recordings r
           LEFT JOIN agents a ON a.id = r.agent_id
           ORDER BY r.created_at DESC, r.id DESC""").fetchall()
    # Voicemails group under their own heading; playground rows from before
    # recordings carried a category fall back to the default one.
    return [{**dict(r), 'category': FROM_COMPANIONS if r['source'] == 'voicemail'
             else (r['category'] or DEFAULT_CATEGORY)} for r in rows]


DEFAULT_CATEGORY = 'My scripts'


def _scripts(con):
    return [dict(r) for r in con.execute(
        "SELECT * FROM audio_scripts ORDER BY lower(category), lower(name)").fetchall()]


@router.post("/bootstrap")
def audio_bootstrap(payload: dict = Body(default={}), con=Depends(db_con)):
    """Everything the playground opens with."""
    config = get_config(con)
    return {
        'examples': audio_examples.EXAMPLES,
        'categories': [DEFAULT_CATEGORY] + audio_examples.CATEGORIES,
        'languages': audio_studio.TTS_LANGUAGES,
        'scripts': _scripts(con),
        'recordings': _recordings(con),
        'voices': _fetch_voices(config),
        'sounds': _sounds(con),
        'sound_kinds': audio_sounds.KINDS,
        'guide': audio_studio.guide(config, audio_sounds.catalog(con)),
    }


def _sounds(con):
    return list(audio_sounds.catalog(con).values())


def _sounds_payload(con):
    """What the playground refreshes after a library change: the list, and
    the guide (whose "Your sounds" section follows it)."""
    return {'sounds': _sounds(con),
            'guide': audio_studio.guide(get_config(con), audio_sounds.catalog(con))}


@router.post("/sounds/upload")
def audio_sound_upload(
    name: str = Form(...),
    kind: str = Form(...),
    description: str = Form(''),
    level: str = Form('0'),
    credit: str = Form(''),
    file: UploadFile = File(...),
    con=Depends(db_con),
):
    """Add a sound to the library: decoded, resampled and stored as FLAC.
    A plain def on purpose: FastAPI runs it in its thread pool, so a long
    decode never stalls the event loop (live calls, websockets)."""
    name, kind, level = audio_sounds.validate(con, name=name, kind=kind, level=level)
    # One byte past the cap is enough for ingest to refuse it.
    raw = file.file.read(audio_sounds.MAX_UPLOAD_BYTES + 1)
    path, duration = audio_sounds.ingest(raw, file.filename or 'upload')
    audio_sounds.store(con, name=name, kind=kind, description=description.strip()[:300],
                       level=level, credit=credit.strip()[:300], file_path=path,
                       source_filename=file.filename, duration=duration)
    con.commit()
    return _sounds_payload(con)


@router.post("/sounds/save")
def audio_sound_save(payload: dict = Body(default={}), con=Depends(db_con)):
    """Edit a sound's details (not its audio). Renaming breaks scripts that
    call the old name; they then render with a warning."""
    sound_id = payload.get('id')
    if not isinstance(sound_id, int):
        raise UserError('id must be an integer.')
    name, kind, level = audio_sounds.validate(con, name=payload.get('name'), kind=payload.get('kind'),
                                              level=payload.get('level'), sound_id=sound_id)
    con.execute("""UPDATE audio_sounds SET name = ?, kind = ?, description = ?, level = ?, credit = ?
                   WHERE id = ?""",
                (name, kind, (payload.get('description') or '').strip()[:300], level,
                 (payload.get('credit') or '').strip()[:300], sound_id))
    con.commit()
    return _sounds_payload(con)


@router.post("/sounds/delete")
def audio_sound_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    row = con.execute("SELECT * FROM audio_sounds WHERE id = ?", (payload.get('id'),)).fetchone()
    if row:
        con.execute("DELETE FROM audio_sounds WHERE id = ?", (row['id'],))
        con.commit()
        audio_sounds.delete_file(row)
    return _sounds_payload(con)


@router.post("/rules/save")
def audio_rules_save(payload: dict = Body(default={}), con=Depends(db_con)):
    """Override the default writing rules (a companion reads them in the
    create_voicemail description), or reset to the defaults with an empty
    value."""
    rules = (payload.get('rules') or '').strip() or None
    con.execute("UPDATE config SET recording_rules = ? WHERE id = 1", (rules,))
    con.commit()
    return {'guide': audio_studio.guide(get_config(con), audio_sounds.catalog(con))}


@router.post("/scripts/save")
def audio_script_save(payload: dict = Body(default={}), con=Depends(db_con)):
    name = (payload.get('name') or '').strip()
    script = payload.get('script') or ''
    if not name:
        raise UserError('Give the script a name.')
    if not script.strip():
        raise UserError('The script is empty.')
    category = ' '.join((payload.get('category') or '').split())[:60] or DEFAULT_CATEGORY
    vals = (name[:120], category, (payload.get('voice') or 'eve').strip(),
            (payload.get('language') or 'en').strip(), script)
    now = utcnow()
    script_id = payload.get('id')
    if isinstance(script_id, int):
        con.execute("""UPDATE audio_scripts SET name = ?, category = ?, voice = ?, language = ?,
                       script = ?, updated_at = ? WHERE id = ?""", (*vals, now, script_id))
    else:
        script_id = con.execute(
            """INSERT INTO audio_scripts (name, category, voice, language, script, created_at,
                                          updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""", (*vals, now, now)).lastrowid
    con.commit()
    return {'id': script_id, 'scripts': _scripts(con)}


@router.post("/scripts/delete")
def audio_script_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    if not isinstance(payload.get('id'), int):
        raise UserError('id must be an integer.')
    con.execute("DELETE FROM audio_scripts WHERE id = ?", (payload['id'],))
    con.commit()
    return {'scripts': _scripts(con)}


@router.post("/render")
def audio_render(payload: dict = Body(default={}), con=Depends(db_con)):
    """Render a playground script. Blocks until the file is written (a long
    piece takes a minute or more: the TTS calls run in parallel)."""
    voice = (payload.get('voice') or '').strip() or 'eve'
    script = payload.get('script') or ''
    name = (payload.get('name') or '').strip()[:120] or 'Untitled recording'
    try:
        pace = float(payload.get('pace') or 1.0)
    except (TypeError, ValueError):
        pace = 1.0
    language = audio_studio.normalize_language(payload.get('language') or 'auto')
    if not language:
        raise UserError('Language must be a language code such as en, ja or nl, or auto.')
    result = audio_studio.render(con, get_config(con), script, voice=voice, language=language,
                                 pace=max(0.7, min(1.5, pace)))
    category = ' '.join((payload.get('category') or '').split())[:60] or DEFAULT_CATEGORY
    rec_id = voicemail_tools.store_recording(con, name=name, source='playground',
                                             script=script, voice=voice, result=result,
                                             category=category)
    con.commit()
    return {'recording_id': rec_id, **result, 'recordings': _recordings(con)}


@router.post("/recordings/delete")
def audio_recording_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    rec_id = payload.get('id')
    if not isinstance(rec_id, int):
        raise UserError('id must be an integer.')
    row = con.execute("SELECT audio_path FROM audio_recordings WHERE id = ?", (rec_id,)).fetchone()
    if row:
        con.execute("DELETE FROM audio_recordings WHERE id = ?", (rec_id,))
        con.commit()
        path = FILES_DIR / row['audio_path'].rsplit('/', 1)[-1]
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            _logger.warning('could not delete %s: %s', path, e)
    return {'recordings': _recordings(con)}
