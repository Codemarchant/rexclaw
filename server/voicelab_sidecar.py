# Copyright 2026 Codemarchant
"""Voice Lab: the optional singing sidecar.

Runs in its OWN Python environment (set up by server/voicelab.py with uv:
Ultimate-RVC, torch, faster-whisper; ~12 GB with models), never inside the
Rexclaw server process, so the app itself stays small. Rexclaw starts it as
a child process and talks to it over 127.0.0.1 HTTP:

    GET  /health                   {ok, version, cuda, device}
    GET  /models                   trained voice models
    POST /models/delete {name}
    POST /jobs/train    {name, files, epochs?, batch_size?}
    POST /jobs/convert  {model, input, output, semitones?, index_rate?, protect?}
    POST /jobs/fetch    {source, out_dir}        link (yt-dlp) or local audio/video file
    POST /jobs/separate {input, out_dir}         lead vocal (dry) + instrumental
    POST /jobs/pitch    {input, output}          RMVPE F0 at 100 fps (.npy)
    POST /jobs/transcribe {input, language?}     faster-whisper word timings
    GET  /jobs/{id}                              state, stage, progress, result, error

GPU work runs one job at a time on a worker thread. This file imports
nothing from the Rexclaw server package: it is shipped with it but executed
by the Voice Lab interpreter.

Engines: Ultimate-RVC (MIT) for RVC training/conversion, audio-separator
models and yt-dlp; RMVPE for pitch; faster-whisper (MIT) for word timings.
"""
import argparse
import glob
import json
import os
import queue
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

VERSION = 1

# RVC defaults for a companion voice profile (docs.applio.org, AI Hub, RVC
# FAQ): RMVPE pitch, ContentVec, HiFi-GAN, 40 kHz, the official v2 pretrain,
# batch 4 on 8 GB cards, 300 epochs, weights saved every 25 epochs.
DEFAULT_EPOCHS = 300
DEFAULT_BATCH = 4
SAVE_INTERVAL = 25
# Checkpoint choice: every saved weight converts a held-out clip lifted a
# fifth (towards singing range); the lowest Whisper word error wins, the
# latest epoch within WER_TIE of it breaks ties (more training, more of the
# voice). Loss curves don't pick the best epoch reliably (AI Hub).
HOLDOUT_SECONDS = 20.0
HOLDOUT_SHIFT = 7
WER_TIE = 0.02


def _parent_watch(pid):
    """Exit when the Rexclaw server that started us goes away."""
    if not pid:
        return

    def alive(p):
        try:
            if os.name == 'nt':
                import ctypes
                h = ctypes.windll.kernel32.OpenProcess(0x1000, False, p)
                if not h:
                    return False
                code = ctypes.c_ulong()
                ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
                ctypes.windll.kernel32.CloseHandle(h)
                return code.value == 259  # STILL_ACTIVE
            os.kill(p, 0)
            return True
        except Exception:
            return False

    def loop():
        while True:
            time.sleep(3)
            if not alive(pid):
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


class Jobs:
    def __init__(self):
        self.jobs = {}
        self.q = queue.Queue()
        self.lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, kind, fn, payload):
        jid = uuid.uuid4().hex
        with self.lock:
            self.jobs[jid] = {'id': jid, 'kind': kind, 'state': 'queued', 'stage': '',
                              'progress': 0.0, 'result': None, 'error': None,
                              'created': time.time()}
        self.q.put((jid, fn, payload))
        return jid

    def update(self, jid, **kw):
        with self.lock:
            self.jobs[jid].update(kw)

    def get(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            return dict(j) if j else None

    # The model each job kind reuses across calls; everything else is let go
    # before it starts (see _release).
    KEEP = {'convert': ('rvc',), 'pitch': ('rmvpe',), 'transcribe': ('whisper',),
            'fetch': ('rvc', 'rmvpe', 'whisper')}

    def _worker(self):
        while True:
            jid, fn, payload = self.q.get()
            self.update(jid, state='running')
            _release(self.KEEP.get(self.jobs[jid]['kind'], ()))
            try:
                result = fn(payload, lambda stage, p=None: self.update(
                    jid, stage=stage, **({'progress': p} if p is not None else {})))
                self.update(jid, state='done', result=result, progress=1.0)
            except Exception as e:  # noqa: BLE001 — reported to Rexclaw
                traceback.print_exc()
                self.update(jid, state='error', error=f'{type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Engine calls (imported lazily: ultimate_rvc takes seconds to import)
# ---------------------------------------------------------------------------

_whisper = {}


def _whisper_model(cpu=False):
    if 'm' not in _whisper or (cpu and _whisper.get('device') != 'cpu'):
        _whisper.clear()
        _release()
        from faster_whisper import WhisperModel
        import torch
        cuda = torch.cuda.is_available() and not cpu
        # large-v3-turbo on a GPU (int8 weights, fp16 maths: about half the
        # memory of fp16, which matters next to the other models on an
        # 8 GB card); small on CPU keeps a song under minutes.
        name = 'large-v3-turbo' if cuda else 'small'
        _whisper['m'] = WhisperModel(name, device='cuda' if cuda else 'cpu',
                                     compute_type='int8_float16' if cuda else 'int8')
        _whisper['device'] = 'cuda' if cuda else 'cpu'
    return _whisper['m']


def _release(keep=()):
    """Free the GPU memory of models the next job doesn't need: jobs run one
    at a time, and an 8 GB card can't hold separation, RVC, RMVPE and
    Whisper at once next to the desktop."""
    import gc
    if 'whisper' not in keep:
        _whisper.clear()
    if 'rmvpe' not in keep:
        _rmvpe.clear()
    if 'rvc' not in keep:
        try:
            from ultimate_rvc.core.generate import common
            if hasattr(common, '_get_voice_converter') and hasattr(common._get_voice_converter, 'cache_clear'):
                common._get_voice_converter.cache_clear()
        except Exception:
            pass
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _is_oom(e):
    return 'out of memory' in str(e).lower()


def _words(text):
    return re.sub(r"[^\w' ]", ' ', (text or '').lower()).split()


def _wer(ref, hyp):
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1] / len(ref)


def _transcribe(path, **kw):
    """faster-whisper, falling back to the CPU when the GPU is out of memory."""
    try:
        segs, info = _whisper_model().transcribe(str(path), vad_filter=False, **kw)
        return list(segs), info
    except RuntimeError as e:
        if not _is_oom(e):
            raise
        segs, info = _whisper_model(cpu=True).transcribe(str(path), vad_filter=False, **kw)
        return list(segs), info


def _transcribe_text(path, language=None):
    segs, _info = _transcribe(path, language=language)
    return ' '.join(s.text for s in segs)


def job_train(p, report):
    import numpy as np
    import soundfile as sf
    from ultimate_rvc.core.train.prepare import populate_dataset, preprocess_dataset
    from ultimate_rvc.core.train.extract import extract_features
    from ultimate_rvc.core.train.train import run_training
    from ultimate_rvc.core.manage.models import upload_voice_model, delete_voice_models, get_voice_model_names
    from ultimate_rvc.common import TRAINING_MODELS_DIR
    from ultimate_rvc.typing_extra import PrecisionType
    name = p['name']
    files = [f for f in p['files'] if os.path.isfile(f)]
    if not files:
        raise ValueError('No audio files to train on.')
    work = Path(p.get('work_dir') or (DATA / 'datasets' / name))
    work.mkdir(parents=True, exist_ok=True)
    # Hold out the middle of the longest recording for checkpoint scoring.
    report('Preparing the recordings', 0.01)
    lengths = []
    for f in files:
        try:
            lengths.append((sf.info(f).duration, f))
        except Exception:
            lengths.append((0.0, f))
    total = sum(d for d, _ in lengths)
    train_files = list(files)
    holdout = None
    longest_d, longest = max(lengths)
    if total > 180 and longest_d > 2 * HOLDOUT_SECONDS:
        x, sr = sf.read(longest, dtype='float32', always_2d=True)
        mid = len(x) // 2
        h = int(HOLDOUT_SECONDS * sr)
        a, b = mid - h // 2, mid + h // 2
        holdout = work / 'holdout.wav'
        sf.write(holdout, x[a:b].mean(axis=1), sr)
        rest = work / 'longest_without_holdout.wav'
        sf.write(rest, np.concatenate([x[:a], x[b:]]).mean(axis=1), sr)
        train_files = [f for f in files if f != longest] + [str(rest)]
    report('Slicing the dataset', 0.03)
    dataset = populate_dataset(name, train_files)
    preprocess_dataset(name, dataset)
    report('Extracting pitch and voice features', 0.08)
    extract_features(name)
    epochs = int(p.get('epochs') or DEFAULT_EPOCHS)
    report(f'Training ({epochs} epochs)', 0.12)
    model_dir = Path(TRAINING_MODELS_DIR) / name
    stop = threading.Event()

    def watch():
        # Progress from the saved weights (every SAVE_INTERVAL epochs).
        while not stop.wait(20):
            done = [e for e, _f in _saved_weights(model_dir, name)]
            if done:
                e = max(done)
                report(f'Training: epoch {e} of {epochs}', 0.12 + 0.78 * e / epochs)

    threading.Thread(target=watch, daemon=True).start()
    # URVC's trainer rendezvous on MASTER_PORT = randint(20000, 55555), and
    # Windows reserves blocks of that range for Hyper-V/WSL (netsh int ipv4
    # show excludedportrange): a pick inside one fails to bind (WinError
    # 10013, "One or more training processes failed"). Hand it a port the
    # OS just gave out instead.
    import ultimate_rvc.rvc.train.train as urvc_train
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    urvc_train.randint = lambda _a, _b: port
    try:
        # resume: carry on from the latest checkpoint of a run the app quit
        # in the middle of (URVC loads it on its own); otherwise start clean,
        # or a finished model's final checkpoint would end training at once.
        best = run_training(name, num_epochs=epochs, batch_size=int(p.get('batch_size') or DEFAULT_BATCH),
                            save_interval=SAVE_INTERVAL, save_all_weights=True,
                            clear_saved_data=not p.get('resume'),
                            precision=PrecisionType.FP16 if p.get('fp16', True) else PrecisionType.FP32,
                            reduce_memory_usage=True)
    finally:
        stop.set()
    index = model_dir / f'{name}.index'
    weights = _saved_weights(model_dir, name)            # [(epoch, path)], oldest first
    if not weights and best:
        weights = [(epochs, best[0])]
    if not weights:
        raise RuntimeError('Training produced no model.')
    candidates = []
    chosen_ep, chosen = weights[-1]
    if holdout is not None and len(weights) > 1:
        report('Scoring checkpoints', 0.92)
        from ultimate_rvc.core.generate.common import convert
        ref = _words(_transcribe_text(holdout))
        tmp = f'{name}__eval'
        for ep, w in weights:
            if tmp in get_voice_model_names():
                delete_voice_models([tmp])
            upload_voice_model([w, str(index)] if index.is_file() else [w], tmp)
            out = convert(str(holdout), str(work / 'eval'), tmp, n_semitones=HOLDOUT_SHIFT, make_directory=True)
            wer = _wer(ref, _words(_transcribe_text(out)))
            candidates.append({'epoch': ep, 'wer': round(wer, 3), 'file': w})
            report(f'Scoring checkpoints: epoch {ep}, word error {wer:.0%}', 0.92)
        if tmp in get_voice_model_names():
            delete_voice_models([tmp])
        best_wer = min(c['wer'] for c in candidates)
        good = [c for c in candidates if c['wer'] <= best_wer + WER_TIE]
        pick = max(good, key=lambda c: c['epoch'])
        chosen_ep, chosen = pick['epoch'], pick['file']
    report('Installing the voice', 0.98)
    if name in get_voice_model_names():
        delete_voice_models([name])
    upload_voice_model([chosen, str(index)] if index.is_file() else [chosen], name)
    # The profile's speaking pitch: where its sung range should sit.
    median_hz = _median_f0(files[:6])
    return {'model': name, 'epoch': chosen_ep,
            'candidates': [{k: v for k, v in c.items() if k != 'file'} for c in candidates],
            'minutes': round(total / 60, 1), 'speech_median_hz': median_hz}


def _saved_weights(model_dir, name):
    """The weights training saved along the way → [(epoch, path)], oldest
    first. Ultimate-RVC writes <name>_<epoch>.pth (Applio: <name>_<e>e_<s>s.pth)."""
    out = []
    for f in glob.glob(str(Path(model_dir) / f'{name}_*.pth')):
        m = re.search(rf'{re.escape(name)}_(\d+)(?:e_\d+s)?\.pth$', f)
        if m:
            out.append((int(m.group(1)), f))
    return sorted(out)


_rmvpe = {}


def _f0(path):
    """RMVPE F0 (Hz, 0 = unvoiced) at 100 frames a second."""
    import librosa
    import torch
    from ultimate_rvc.rvc.lib.predictors.f0 import RMVPE
    if 'm' not in _rmvpe:
        _rmvpe['m'] = RMVPE('cuda' if torch.cuda.is_available() else 'cpu')
    x, _sr = librosa.load(str(path), sr=16000, mono=True)
    return _rmvpe['m'].get_f0(x)


def _median_f0(files):
    import numpy as np
    vals = []
    for f in files:
        try:
            f0 = _f0(f)
            vals.append(f0[f0 > 0])
        except Exception:
            continue
    v = np.concatenate(vals) if vals else []
    return round(float(np.median(v)), 1) if len(v) else None


def job_convert(p, report):
    from ultimate_rvc.core.generate.common import convert
    report('Singing in the profile voice', 0.1)
    tmp = DATA / 'tmp' / uuid.uuid4().hex
    out = convert(p['input'], str(tmp), p['model'], n_semitones=int(p.get('semitones') or 0),
                  index_rate=float(p.get('index_rate', 0.3)), protect_rate=float(p.get('protect', 0.33)),
                  make_directory=True)
    Path(p['output']).parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(out), p['output'])
    shutil.rmtree(tmp, ignore_errors=True)
    return {'output': p['output']}


def job_fetch(p, report):
    """A link (any site yt-dlp supports) or a local audio/video file → WAV,
    with whatever title/artist metadata there is."""
    import static_ffmpeg
    static_ffmpeg.add_paths(weak=True)
    out_dir = Path(p['out_dir'])
    out_dir.mkdir(parents=True, exist_ok=True)
    src = p['source']
    if re.match(r'^https?://', src):
        import yt_dlp
        from ultimate_rvc.common import NODE_PATH
        report('Downloading', 0.05)
        opts = {'quiet': True, 'noplaylist': True, 'format': 'bestaudio/best',
                'outtmpl': str(out_dir / 'source.%(ext)s'),
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'wav'}],
                'js_runtimes': {'node': {'path': str(NODE_PATH)}}}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(src, download=True) or {}
        wav = out_dir / 'source.wav'
        meta = {'title': info.get('track') or info.get('title') or '',
                'artist': info.get('artist') or info.get('creator') or info.get('uploader') or '',
                'duration': info.get('duration'), 'webpage_url': info.get('webpage_url') or src,
                'raw_title': info.get('title') or ''}
    else:
        import subprocess
        report('Reading the file', 0.05)
        wav = out_dir / 'source.wav'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '2', '-ar', '44100', str(wav)],
                       check=True)
        meta = {'title': Path(src).stem, 'artist': '', 'duration': None, 'raw_title': Path(src).stem}
    if not wav.is_file():
        raise RuntimeError('No audio came out of that source.')
    return {'audio': str(wav), **meta}


def job_separate(p, report):
    """Song → dry lead vocal (the singing guide) + instrumental (the
    backing, with the backing vocals left in): vocals/instrumental split,
    lead/backing split of the vocals, then de-reverb of the lead."""
    import numpy as np
    import soundfile as sf
    from ultimate_rvc.core.generate.song_cover import separate_audio, init_song_dir
    from ultimate_rvc.typing_extra import SeparationModel
    out_dir = Path(p['out_dir'])
    out_dir.mkdir(parents=True, exist_ok=True)
    report('Separating vocals from the music', 0.05)
    song_dir, _ = init_song_dir(p['input'])
    vocals, inst = separate_audio(p['input'], song_dir, SeparationModel.UVR_MDX_NET_VOC_FT, 512)
    report('Separating the lead vocal', 0.45)
    lead, backing = separate_audio(vocals, song_dir, SeparationModel.UVR_MDX_NET_KARA_2, 512)
    # The lead/backing model can file a whole vocal (a heavily reverbed or
    # synthetic one) under "backing"; the lead then comes out near-silent.
    # A lead far quieter than the vocals it came from means: use them all.
    if _rms_db(lead) < _rms_db(vocals) - SPLIT_GUARD_DB:
        lead, backing = vocals, None
    report('Removing reverb from the lead vocal', 0.75)
    _wet, dry = separate_audio(lead, song_dir, SeparationModel.REVERB_HQ_BY_FOXJOY, 512)
    if _rms_db(dry) < _rms_db(lead) - SPLIT_GUARD_DB:
        dry = lead
    report('Mixing the backing', 0.92)
    a, sr = sf.read(inst, dtype='float32', always_2d=True)
    mix = a
    if backing is not None:
        b, sr2 = sf.read(backing, dtype='float32', always_2d=True)
        n = min(len(a), len(b))
        mix = a[:n] + (b[:n] if sr == sr2 else 0)
    peak = float(np.abs(mix).max()) or 1.0
    if peak > 0.99:
        mix *= 0.99 / peak
    sf.write(out_dir / 'instrumental.wav', mix, sr)
    shutil.copy(dry, out_dir / 'lead_dry.wav')
    shutil.copy(lead, out_dir / 'lead.wav')
    return {'instrumental': str(out_dir / 'instrumental.wav'), 'lead_dry': str(out_dir / 'lead_dry.wav'),
            'lead': str(out_dir / 'lead.wav')}


SPLIT_GUARD_DB = 12   # design: a stem this far under its source failed to separate


def _rms_db(path):
    import numpy as np
    import soundfile as sf
    x, _sr = sf.read(str(path), dtype='float32', always_2d=True)
    return 20 * np.log10(float(np.sqrt(np.mean(x ** 2))) + 1e-9)


def job_pitch(p, report):
    import numpy as np
    report('Tracking the melody', 0.1)
    f0 = _f0(p['input'])
    np.save(p['output'], f0.astype('float32'))
    return {'output': p['output'], 'fps': 100}


def job_transcribe(p, report):
    report('Listening to the lyrics', 0.1)
    segs, info = _transcribe(p['input'], word_timestamps=True, language=p.get('language') or None)
    out = []
    for s in segs:
        out.append({'start': s.start, 'end': s.end, 'text': s.text.strip(),
                    'words': [{'w': w.word.strip(), 'start': w.start, 'end': w.end} for w in (s.words or [])]})
    return {'language': info.language, 'segments': out}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

DATA = Path('.')


def build_app(jobs):
    from fastapi import FastAPI, HTTPException
    app = FastAPI(title='Rexclaw Voice Lab')

    @app.get('/health')
    def health():
        import torch
        cuda = torch.cuda.is_available()
        return {'ok': True, 'version': VERSION, 'cuda': cuda,
                'device': torch.cuda.get_device_name(0) if cuda else 'CPU'}

    @app.get('/models')
    def models():
        from ultimate_rvc.core.manage.models import get_voice_model_names
        return {'models': get_voice_model_names()}

    @app.post('/models/delete')
    def models_delete(p: dict):
        from ultimate_rvc.core.manage.models import delete_voice_models, get_voice_model_names
        if p.get('name') in get_voice_model_names():
            delete_voice_models([p['name']])
        return {'ok': True}

    kinds = {'train': job_train, 'convert': job_convert, 'fetch': job_fetch,
             'separate': job_separate, 'pitch': job_pitch, 'transcribe': job_transcribe}

    @app.post('/jobs/{kind}')
    def submit(kind: str, p: dict):
        if kind not in kinds:
            raise HTTPException(404, 'Unknown job kind.')
        return {'job': jobs.submit(kind, kinds[kind], p)}

    @app.get('/jobs/{jid}')
    def status(jid: str):
        j = jobs.get(jid)
        if not j:
            raise HTTPException(404, 'Unknown job.')
        return j

    return app


def main():
    global DATA
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8995)
    ap.add_argument('--data', required=True)
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--init', action='store_true', help='download the base models, then exit')
    args = ap.parse_args()
    DATA = Path(args.data)
    for k in ('MODELS', 'AUDIO', 'TEMP', 'CONFIG', 'LOGS'):
        os.environ.setdefault(f'URVC_{k}_DIR', str(DATA / k.lower()))
    os.environ.setdefault('URVC_CONSOLE_LOG_LEVEL', 'ERROR')
    if args.init:
        from ultimate_rvc.core.main import prequisites_download_pipeline
        from ultimate_rvc.core.generate.song_cover import initialize_audio_separator
        prequisites_download_pipeline(exe=False)
        initialize_audio_separator()
        print(json.dumps({'ok': True}))
        return
    _parent_watch(args.parent_pid)
    import uvicorn
    uvicorn.run(build_app(Jobs()), host='127.0.0.1', port=args.port, log_level='warning')


if __name__ == '__main__':
    sys.exit(main())
