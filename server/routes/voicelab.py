# Copyright 2026 Codemarchant
"""Voice Lab: the optional singing engine (voicelab.py), singing voice
profiles trained from the user's own recordings, and songs imported from a
link or a video (song_covers.py)."""
import json
import logging
import re
import shutil
import threading
import time
import uuid

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from .. import song_covers, voicelab
from ..db import connect, utcnow
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voicelab")

DATASETS = voicelab.VOICELAB_DIR / 'datasets'
AUDIO_EXTS = ('.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac', '.opus', '.webm', '.mp4', '.mkv', '.mov')
MAX_UPLOAD = 1024 * 1024 * 1024   # 1 GB per file (long recordings, videos)

# Profiles with a training thread in this process. A row still marked
# 'training' without one was cut off by the app quitting: it is 'stopped',
# and Retrain carries on from its last checkpoint.
_TRAINING = set()


def _profiles(con):
    stale = [r['id'] for r in con.execute("SELECT id FROM voice_profiles WHERE status = 'training'")
             if r['id'] not in _TRAINING]
    for pid in stale:
        con.execute("UPDATE voice_profiles SET status = 'stopped', stage = NULL WHERE id = ?", (pid,))
    if stale:
        con.commit()
    rows = [dict(r) for r in con.execute("SELECT * FROM voice_profiles ORDER BY lower(name)")]
    for r in rows:
        r['scores'] = json.loads(r['scores']) if r['scores'] else None
    return rows


def _payload(con):
    return {'status': voicelab.status(), 'profiles': _profiles(con)}


@router.post("/status")
def vl_status(payload: dict = Body(default={}), con=Depends(db_con)):
    return _payload(con)


@router.post("/install")
def vl_install(payload: dict = Body(default={}), con=Depends(db_con)):
    voicelab.start_install()
    return _payload(con)


@router.post("/uninstall")
def vl_uninstall(payload: dict = Body(default={}), con=Depends(db_con)):
    voicelab.uninstall()
    con.execute("UPDATE voice_profiles SET status = 'error', error = 'The Voice Lab was removed.' "
                "WHERE status = 'ready'")
    con.commit()
    return _payload(con)


@router.post("/start")
def vl_start(payload: dict = Body(default={}), con=Depends(db_con)):
    voicelab.ensure_running()
    return _payload(con)


@router.post("/stop")
def vl_stop(payload: dict = Body(default={}), con=Depends(db_con)):
    voicelab.stop()
    return _payload(con)


# ---------------------------------------------------------------------------
# Voice profiles
# ---------------------------------------------------------------------------

def _save_uploads(files, folder):
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = re.sub(r'[^\w.\- ]', '_', f.filename or 'recording')
        if not name.lower().endswith(AUDIO_EXTS):
            raise UserError(f'"{f.filename}" is not an audio or video file.')
        dest = folder / f'{uuid.uuid4().hex[:8]}_{name}'
        with open(dest, 'wb') as out:
            shutil.copyfileobj(f.file, out, 1024 * 1024)
        if dest.stat().st_size > MAX_UPLOAD:
            dest.unlink()
            raise UserError(f'"{f.filename}" is over 1 GB.')
        saved.append(dest)
    return saved


def _start_training(profile_id, resume=False):
    _TRAINING.add(profile_id)
    threading.Thread(target=_train, args=(profile_id, resume), daemon=True).start()


def _train(profile_id, resume=False):
    """Background: hand the profile's recordings to the Voice Lab and keep
    the row's progress current."""
    con = connect()
    try:
        row = con.execute("SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)).fetchone()
        files = sorted(str(p) for p in (voicelab.VOICELAB_DIR / 'datasets' / row['model']).iterdir()
                       if p.is_file() and p.suffix.lower() in AUDIO_EXTS)
        last = [0.0]

        def progress(stage, frac):
            if time.monotonic() - last[0] < 2:
                return
            last[0] = time.monotonic()
            con.execute("UPDATE voice_profiles SET stage = ?, progress = ? WHERE id = ?",
                        (stage, round(frac, 3), profile_id))
            con.commit()

        result = voicelab.run('train', {'name': row['model'], 'files': files, 'epochs': row['epochs'],
                                        'resume': resume}, progress=progress, poll=5)
        con.execute("""UPDATE voice_profiles SET status = 'ready', stage = NULL, progress = 1, error = NULL,
                       minutes = ?, chosen_epoch = ?, scores = ?, speech_median_hz = ?, trained_at = ?
                       WHERE id = ?""",
                    (result.get('minutes'), result.get('epoch'), json.dumps(result.get('candidates') or []),
                     result.get('speech_median_hz'), utcnow(), profile_id))
        # Vocals rendered by the old model are stale now.
        con.execute("DELETE FROM song_vocals WHERE voice = ?", (f'profile:{profile_id}',))
        con.commit()
    except Exception as e:  # noqa: BLE001 — shown on the profile
        _logger.exception('voice profile training failed')
        con.execute("UPDATE voice_profiles SET status = 'error', error = ?, stage = NULL WHERE id = ?",
                    (str(e)[:500], profile_id))
        con.commit()
    finally:
        _TRAINING.discard(profile_id)
        con.close()


@router.post("/profiles/create")
def profile_create(
    name: str = Form(...),
    epochs: str = Form('200'),
    files: list[UploadFile] = File(...),
    con=Depends(db_con),
):
    """A new singing voice from the user's own recordings; training starts
    at once in the background."""
    if not voicelab.installed():
        raise UserError('Install the Voice Lab first (Settings → Voice Lab).')
    label = (name or '').strip()[:60] or 'Voice'
    model = re.sub(r'[^a-z0-9]+', '_', label.lower()).strip('_')[:30] + '_' + uuid.uuid4().hex[:6]
    _save_uploads(files, DATASETS / model)
    try:
        ep = max(50, min(1000, int(epochs)))
    except ValueError:
        ep = 200
    cur = con.execute("""INSERT INTO voice_profiles (name, model, status, stage, dataset_dir, epochs, created_at)
                         VALUES (?, ?, 'training', 'Queued', ?, ?, ?)""",
                      (label, model, str(DATASETS / model), ep, utcnow()))
    con.commit()
    _start_training(cur.lastrowid)
    return _payload(con)


@router.post("/profiles/retrain")
def profile_retrain(
    id: str = Form(...),
    epochs: str = Form(''),
    files: list[UploadFile] = File(default=[]),
    con=Depends(db_con),
):
    """Train again, with any extra recordings added to the ones it has. A
    training that didn't finish (the app quit, or it failed), with nothing
    added, carries on from its last checkpoint; with none, URVC just starts
    fresh."""
    _profiles(con)          # marks a cut-off training 'stopped'
    row = con.execute("SELECT * FROM voice_profiles WHERE id = ?", (int(id),)).fetchone()
    if not row:
        raise UserError('That voice profile no longer exists.')
    if row['status'] == 'training':
        raise UserError('It is already training.')
    added = [f for f in files if f.filename]
    if added:
        _save_uploads(added, DATASETS / row['model'])
    ep = row['epochs']
    if epochs.strip():
        ep = max(50, min(1000, int(epochs)))
    resume = row['status'] in ('stopped', 'error') and not added and ep == row['epochs']
    con.execute("UPDATE voice_profiles SET status = 'training', stage = 'Queued', progress = ?, error = NULL, "
                "epochs = ? WHERE id = ?", (row['progress'] if resume else 0, ep, row['id']))
    con.commit()
    _start_training(row['id'], resume=resume)
    return _payload(con)


@router.post("/profiles/rename")
def profile_rename(payload: dict = Body(default={}), con=Depends(db_con)):
    con.execute("UPDATE voice_profiles SET name = ? WHERE id = ?",
                ((payload.get('name') or '').strip()[:60] or 'Voice', payload.get('id')))
    con.commit()
    return _payload(con)


@router.post("/profiles/delete")
def profile_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    row = con.execute("SELECT * FROM voice_profiles WHERE id = ?", (payload.get('id'),)).fetchone()
    if row:
        if row['status'] == 'training':
            raise UserError('Wait for the training to finish before deleting it.')
        con.execute("DELETE FROM voice_profiles WHERE id = ?", (row['id'],))
        con.execute("UPDATE agents SET singing_profile_id = NULL WHERE singing_profile_id = ?", (row['id'],))
        con.execute("DELETE FROM song_vocals WHERE voice = ?", (f'profile:{row["id"]}',))
        con.commit()
        voicelab.delete_model(row['model'])
        shutil.rmtree(DATASETS / row['model'], ignore_errors=True)
    return _payload(con)


@router.post("/profiles/assign")
def profile_assign(payload: dict = Body(default={}), con=Depends(db_con)):
    """Which profile a companion sings with (null = the built-in engine)."""
    pid = payload.get('profile_id')
    if pid is not None:
        row = con.execute("SELECT id FROM voice_profiles WHERE id = ?", (pid,)).fetchone()
        if not row:
            raise UserError('That voice profile no longer exists.')
    con.execute("UPDATE agents SET singing_profile_id = ? WHERE id = ?", (pid, payload.get('agent_id')))
    con.commit()
    return _payload(con)


# ---------------------------------------------------------------------------
# Songs from a link or a video
# ---------------------------------------------------------------------------

@router.post("/import/link")
def import_link(payload: dict = Body(default={}), con=Depends(db_con)):
    url = (payload.get('url') or '').strip()
    if not re.match(r'^https?://', url):
        raise UserError('Paste a full link starting with https://.')
    if not voicelab.installed():
        raise UserError('Songs from links need the Voice Lab (Settings → Voice Lab).')
    return {'job': song_covers.start_import(url, title=payload.get('title'), artist=payload.get('artist'),
                                            language=payload.get('language'))}


@router.post("/import/file")
def import_file(
    file: UploadFile = File(...),
    title: str = Form(''),
    artist: str = Form(''),
    con=Depends(db_con),
):
    if not voicelab.installed():
        raise UserError('Songs from videos need the Voice Lab (Settings → Voice Lab).')
    saved = _save_uploads([file], song_covers.UPLOAD_DIR)[0]
    return {'job': song_covers.start_import(saved, title=title or None, artist=artist or None)}


@router.post("/import/status")
def import_status(payload: dict = Body(default={})):
    return song_covers.job_status(payload.get('job'))
