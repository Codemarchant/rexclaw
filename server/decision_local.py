# Copyright 2026 Codemarchant
"""The local decision model: install, run and find an open decision model
on this computer.

Valen-Decision-1.5 (Valen-Team, Apache-2.0) is an open decision model that
answers Choice, Noul, Score and Box questions, so the directors ask it the
way they ask Jev (decision_sidecar.py gives it Jev's request format), and
it finds things on a screenshot too (point_at_screen, a roaming
companion's looks at the screen). Which size is the user's pick (MODELS
below), by what their graphics card holds beside the app (fits): the 2B
wants a 12 GB card.

It needs torch and gigabytes of weights: far too much to ship in the app,
so each size is an optional download, set up the way the Voice Lab is
(voicelab.py). Install fetches uv, which creates one Python environment
under data/decision/ for all of them (the CUDA build of torch when an
NVIDIA driver is present), then downloads the chosen model's weights from
Hugging Face into data/decision/models/. Nothing outside data/decision/ is
touched, and deleting that folder uninstalls everything.

While "Local model" is the chosen decision model, the server keeps the
picked model loaded as a child process (decision_sidecar.py) on a free
127.0.0.1 port; it exits by itself when the server does. Loading the
weights takes a while, so nothing waits for it: until it answers, a
question fails the way an unreachable Jev does, and the feature that asked
carries on without.
"""
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

from . import voicelab
from .db import DATA_DIR
from .errors import UserError

_logger = logging.getLogger(__name__)

DECISION_DIR = DATA_DIR / 'decision'
VENV_DIR = DECISION_DIR / 'venv'
UV_DIR = DECISION_DIR / 'uv'
MODELS_DIR = DECISION_DIR / 'models'
ENV_MARKER = DECISION_DIR / 'env.json'
LOG = DECISION_DIR / 'install.log'
SIDECAR = Path(__file__).with_name('decision_sidecar.py')

# Each size at a pinned commit, so a later push can't change what an
# install gets (the repos carry the Python the model runs with). `bytes`
# is what the download fetches, the repo without its card's pictures.
MODELS = {
    'valen-0.8b': {
        'name': 'Valen-Decision-1.5-0.8B', 'repo': 'Valen-Team/Valen-Decision-1.5-0.8B',
        'revision': '19a226b238cdddc76f528bb735baf6e8ef1bc599', 'bytes': 1_744_050_666,
    },
    'valen-2b': {
        'name': 'Valen-Decision-1.5-2B', 'repo': 'Valen-Team/Valen-Decision-1.5-2B',
        'revision': '99785876d73fc46bd8ae26f9ca7fad0c68fceb8d', 'bytes': 4_474_041_173,
    },
    'valen-4b': {
        'name': 'Valen-Decision-1.5-4B', 'repo': 'Valen-Team/Valen-Decision-1.5-4B',
        'revision': 'dac4b4b195bfa421b1fa17dc654b7ab9810c3747', 'bytes': 9_130_905_987,
    },
    'valen-9b': {
        'name': 'Valen-Decision-1.5-9B', 'repo': 'Valen-Team/Valen-Decision-1.5-9B',
        'revision': '566c45a78b344694b3c407f55d5aa15b3bb6324d', 'bytes': 16_851_965_090,
    },
}
DEFAULT_MODEL = 'valen-2b'
# What a model needs beside the app. Measured 2026-11-09 on an 8 GB card
# with the desktop app roaming: the 2B (4.47 GB of weights) held 5.2 GB of
# video memory (4.44 GB on the card plus 0.77 GB pushed out to system
# memory), and the app with Windows' own desktop wanted 5.1 GB (3.05 GB on
# the card, 2.05 GB pushed out). Together that is more than the card has,
# and a model whose memory is pushed out answers in minutes instead of
# tenths of a second, which is no use to anything that asks it. So "fits"
# means the card holds both.
MODEL_VRAM_FACTOR = 5.2 / 4.47
APP_VRAM_BYTES = 5_100_000_000
# One environment for every size. Valen's card asks for torch, torchvision,
# transformers and pillow without versions; these are the ones the 2B was
# run and measured with here.
PY_VERSION = '3.12'
PACKAGES = ['torch==2.14.0', 'torchvision==0.29.0', 'transformers==5.17.0', 'pillow']
# torch 2.14.0's CUDA wheels (1.99 GB for Windows); PyPI's Windows wheel is
# the CPU build (0.12 GB).
TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu130'
TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu'
TORCH_GB = {'cuda': 2.0, 'cpu': 0.1}
_DOWNLOAD = ("import sys; from huggingface_hub import snapshot_download; "
             "snapshot_download(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], "
             "ignore_patterns=['assets/*'])")
_DOWNLOAD_STAGE = 'Downloading the model'

_state = {'install': None, 'proc': None, 'port': None, 'log': None, 'up': False, 'device': None,
          'model': None, 'vram': None}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

def model_key(key):
    return key if key in MODELS else DEFAULT_MODEL


def model_dir(key):
    return MODELS_DIR / key


def _marker(key):
    return model_dir(key) / 'rexclaw-installed.json'


def _uv_exe():
    return UV_DIR / ('uv.exe' if sys.platform == 'win32' else 'uv')


def venv_python():
    return VENV_DIR / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')


def installed(key):
    return _marker(model_key(key)).is_file() and ENV_MARKER.is_file() and venv_python().is_file()


def vram_mib():
    """The first NVIDIA card's video memory in MiB, or 0. Asked once: a
    card's size doesn't change while the server runs, and Settings polls
    this while a model installs or loads."""
    if _state['vram'] is None:
        out = voicelab.nvidia_smi('--query-gpu=memory.total', '--format=csv,noheader,nounits')
        try:
            _state['vram'] = int(out.stdout.split()[0]) if out and out.returncode == 0 else 0
        except (ValueError, IndexError):
            _state['vram'] = 0
    return _state['vram']


def fits(key, vram):
    """Does a card with `vram` MiB hold this model beside the app?"""
    return vram * 2 ** 20 >= MODELS[model_key(key)]['bytes'] * MODEL_VRAM_FACTOR + APP_VRAM_BYTES


def device_for(key, setting):
    """'cuda' or 'cpu' for the Settings choice ('' = pick for me): the
    card when it holds the model beside the app (fits), else the
    processor, slowly."""
    if setting in ('cuda', 'cpu'):
        return setting
    env = json.loads(ENV_MARKER.read_text()) if ENV_MARKER.is_file() else {}
    return 'cuda' if env.get('gpu') and fits(key, vram_mib()) else 'cpu'


def status():
    inst = dict(_state['install']) if _state['install'] else None
    if inst and inst['state'] == 'running' and inst['stage'] == _DOWNLOAD_STAGE:
        folder = model_dir(inst['model'])
        done = sum(f.stat().st_size for f in folder.rglob('*') if f.is_file()) if folder.is_dir() else 0
        inst['progress'] = min(1.0, done / MODELS[inst['model']]['bytes'])
    vram = vram_mib()
    torch_gb = 0 if ENV_MARKER.is_file() else TORCH_GB['cuda' if vram else 'cpu']
    return {
        'models': [{
            'key': key, 'name': m['name'], 'installed': installed(key),
            'size_gb': round(m['bytes'] / 1e9, 1),
            'download_gb': round(m['bytes'] / 1e9 + torch_gb, 1),
            'fits': fits(key, vram),
            'needs_gb': round((m['bytes'] * MODEL_VRAM_FACTOR + APP_VRAM_BYTES) / 2 ** 30, 1),
        } for key, m in MODELS.items()],
        'install': inst,
        'running': _running(),
        'up': _running() and _state['up'],
        'model': _state['model'] if _running() else None,
        'device': _state['device'] if _running() else None,
        'gpu': vram > 0,
        'vram_gb': round(vram / 1024, 1),
    }


def _log(msg, stage=True):
    DECISION_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{time.strftime("%H:%M:%S")} {msg}\n')
    if stage and _state['install']:
        _state['install']['stage'] = msg


def _run(cmd, **kw):
    _log('$ ' + ' '.join(str(c) for c in cmd), stage=False)
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
    with open(LOG, 'a', encoding='utf-8') as f:
        proc = subprocess.run([str(c) for c in cmd], stdout=f, stderr=subprocess.STDOUT, **flags, **kw)
    if proc.returncode != 0:
        raise UserError(f'Local decision model install step failed ({Path(str(cmd[0])).name}); see {LOG}.')


def start_install(key):
    """Install one model (and the environment, the first time) on a
    background thread; progress in status()['install']."""
    if key not in MODELS:
        raise UserError('Unknown local decision model.')
    with _lock:
        if _state['install'] and _state['install'].get('state') == 'running':
            return
        _state['install'] = {'state': 'running', 'stage': 'Starting', 'error': None, 'model': key,
                             'started': time.time()}
    threading.Thread(target=_install, args=(key,), name='decision-install', daemon=True).start()


def install(key):
    """The install itself, on the calling thread. Raises on failure."""
    model = MODELS[key]
    DECISION_DIR.mkdir(parents=True, exist_ok=True)
    LOG.write_text('', encoding='utf-8')
    env = {**os.environ, 'UV_PYTHON_INSTALL_DIR': str(DECISION_DIR / 'python'),
           'UV_CACHE_DIR': str(DECISION_DIR / 'uv-cache')}
    if not (ENV_MARKER.is_file() and venv_python().is_file()):
        if not _uv_exe().is_file():
            _log(f'Downloading uv {voicelab.UV_VERSION}')
            voicelab.fetch_uv(UV_DIR)
        _log(f'Creating a Python {PY_VERSION} environment')
        _run([_uv_exe(), 'venv', '--python', PY_VERSION, '--allow-existing', VENV_DIR], env=env)
        gpu = voicelab.has_nvidia()
        _log('Installing the model runtime (' + ('CUDA' if gpu else 'CPU') + ')')
        _run([_uv_exe(), 'pip', 'install', '--python', venv_python(), *PACKAGES,
              '--extra-index-url', TORCH_CUDA_INDEX if gpu else TORCH_CPU_INDEX,
              '--index-strategy', 'unsafe-best-match'], env=env)
        ENV_MARKER.write_text(json.dumps({'gpu': gpu, 'packages': PACKAGES, 'at': time.time()}))
        # The wheels are unpacked into the environment; the cache is a copy.
        shutil.rmtree(DECISION_DIR / 'uv-cache', ignore_errors=True)
    _log(_DOWNLOAD_STAGE)
    _run([venv_python(), '-c', _DOWNLOAD, model['repo'], model['revision'], model_dir(key)], env=env)
    _marker(key).write_text(json.dumps({'repo': model['repo'], 'revision': model['revision'],
                                        'at': time.time()}))
    _log('Installed')


def _install(key):
    try:
        install(key)
        # Chosen before it was installed: load it now, and only then call
        # the install done, so Settings (which polls while either an
        # install or a load is going) never sees a moment with neither.
        from .db import connect, get_config
        con = connect()
        try:
            apply(get_config(con))
        finally:
            con.close()
        _state['install'].update(state='done')
    except Exception as e:  # noqa: BLE001 — shown in Settings
        _logger.exception('Local decision model install failed')
        _state['install'].update(state='error', error=str(e))


def uninstall(key):
    """Delete one model's weights; the environment goes with the last one."""
    if key not in MODELS:
        raise UserError('Unknown local decision model.')
    if _state['model'] == key:
        stop()
    shutil.rmtree(model_dir(key), ignore_errors=True)
    if not any(installed(k) for k in MODELS):
        stop()
        shutil.rmtree(DECISION_DIR, ignore_errors=True)


# ---------------------------------------------------------------------------
# Process
# ---------------------------------------------------------------------------

def _running():
    p = _state['proc']
    return bool(p and p.poll() is None)


def apply(config):
    """Keep the picked model loaded exactly while "Local model" is the
    chosen decision model: called at startup and whenever Settings are
    saved."""
    if config['decision_provider'] == 'local' and installed(config['decision_local_model']):
        start(config['decision_local_model'], config['decision_local_device'])
    else:
        stop()


def start(key, setting=''):
    """Start the model's server unless that model already runs on that
    device. Returns at once; `up` turns true when it answers."""
    key = model_key(key)
    device = device_for(key, setting)
    with _lock:
        if _running() and _state['device'] == device and _state['model'] == key:
            return
        _stop()
        port = voicelab._free_port()
        log = open(DECISION_DIR / 'sidecar.log', 'a', encoding='utf-8')
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
        # Weights and code come from the folder alone; nothing is fetched.
        env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'PYTHONUTF8': '1'}
        proc = subprocess.Popen(
            [str(venv_python()), str(SIDECAR), '--model', str(model_dir(key)), '--name', MODELS[key]['name'], '--port', str(port),
             '--device', device, '--parent-pid', str(os.getpid())],
            stdout=log, stderr=subprocess.STDOUT, env=env, **flags)
        _state.update(proc=proc, port=port, log=log, up=False, device=device, model=key)
    threading.Thread(target=_wait_up, args=(proc, port), name='decision-start', daemon=True).start()


def _wait_up(proc, port):
    # For as long as the process lives: a load that takes long (the largest
    # size off a slow disk) is still a load, and giving up on a model that
    # then finishes would leave it holding its memory, answering nobody.
    while proc.poll() is None:
        try:
            if requests.get(f'http://127.0.0.1:{port}/health', timeout=3).ok:
                if _state['proc'] is proc:
                    _state['up'] = True
                    _logger.info('Local decision model %s ready on %s.', _state['model'], _state['device'])
                return
        except requests.RequestException:
            pass
        time.sleep(1)
    if _state['proc'] is proc:
        _logger.warning('Local decision model stopped while loading; see %s.', DECISION_DIR / 'sidecar.log')


def _stop():
    p = _state['proc']
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()
    if _state['log']:
        _state['log'].close()
    _state.update(proc=None, port=None, log=None, up=False, device=None, model=None)


def stop():
    with _lock:
        _stop()


def base_url(key):
    """Where the loaded model answers. Raises while there is nothing to
    ask: not installed, still loading, or stopped (a model that died is not
    started again per question: that would reload it for every line)."""
    key = model_key(key)
    if not installed(key):
        raise RuntimeError('The local decision model is not installed.')
    if not _running() or _state['model'] != key:
        raise RuntimeError(f'The local decision model is not running; see {DECISION_DIR / "sidecar.log"}.')
    if not _state['up']:
        raise RuntimeError('The local decision model is still loading.')
    return f'http://127.0.0.1:{_state["port"]}'
