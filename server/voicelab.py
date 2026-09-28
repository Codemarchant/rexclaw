# Copyright 2026 Codemarchant
"""Voice Lab: install, run and talk to the optional singing sidecar.

The sidecar (voicelab_sidecar.py) needs torch, Ultimate-RVC and
faster-whisper, about 12 GB with its models: far too much for the app
itself, and the packaged desktop runtime is Python's embeddable build (no
venv module). So Install fetches uv (Astral, MIT/Apache), which creates its
own Python 3.12 environment under data/voicelab/ and installs the engines
there (CUDA builds when an NVIDIA driver is present, CPU otherwise); then
the sidecar downloads its base models once. Nothing outside data/voicelab/
is touched, and deleting that folder uninstalls it.

At run time the server starts the sidecar on demand as a child process on
a free 127.0.0.1 port (it exits by itself when the server does) and hands
it jobs over HTTP.
"""
import io
import json
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path

import requests

from .db import DATA_DIR
from .errors import UserError

_logger = logging.getLogger(__name__)

VOICELAB_DIR = DATA_DIR / 'voicelab'
VENV_DIR = VOICELAB_DIR / 'venv'
UV_DIR = VOICELAB_DIR / 'uv'
LAB_DATA = VOICELAB_DIR / 'data'
MARKER = VOICELAB_DIR / 'installed.json'
LOG = VOICELAB_DIR / 'install.log'
SIDECAR = Path(__file__).with_name('voicelab_sidecar.py')

UV_VERSION = '0.12.19'
URVC_VERSION = '0.6.0'
PY_VERSION = '3.12'
PACKAGES = [f'ultimate-rvc=={URVC_VERSION}', 'faster-whisper>=1.1', 'fastapi>=0.110',
            'uvicorn>=0.29']
TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu128'
TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu'
INSTALL_SIZE_GB = 12

_state = {'install': None, 'proc': None, 'port': None, 'log': None}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

def _uv_target():
    machine = platform.machine().lower()
    arch = 'aarch64' if machine in ('arm64', 'aarch64') else 'x86_64'
    if sys.platform == 'win32':
        return f'uv-{arch}-pc-windows-msvc', '.zip'
    if sys.platform == 'darwin':
        return f'uv-{arch}-apple-darwin', '.tar.gz'
    return f'uv-{arch}-unknown-linux-gnu', '.tar.gz'


def _uv_exe():
    return UV_DIR / ('uv.exe' if sys.platform == 'win32' else 'uv')


def venv_python():
    return VENV_DIR / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')


def has_nvidia():
    exe = shutil.which('nvidia-smi')
    if not exe and sys.platform == 'win32':
        cand = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'nvidia-smi.exe'
        exe = str(cand) if cand.is_file() else None
    if not exe:
        return False
    try:
        return subprocess.run([exe, '-L'], capture_output=True, timeout=15).returncode == 0
    except Exception:
        return False


def installed():
    return MARKER.is_file() and venv_python().is_file()


def status():
    inst = _state['install']
    running = _running()
    return {
        'installed': installed(),
        'install': dict(inst) if inst else None,
        'running': running,
        'health': health() if running else None,
        'size_gb': INSTALL_SIZE_GB,
        'gpu': has_nvidia(),
        'info': json.loads(MARKER.read_text()) if MARKER.is_file() else None,
    }


def _log(msg, stage=True):
    VOICELAB_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{time.strftime("%H:%M:%S")} {msg}\n')
    if stage and _state['install']:
        _state['install']['stage'] = msg


def _run(cmd, **kw):
    _log('$ ' + ' '.join(str(c) for c in cmd), stage=False)
    with open(LOG, 'a', encoding='utf-8') as f:
        proc = subprocess.run([str(c) for c in cmd], stdout=f, stderr=subprocess.STDOUT, **kw)
    if proc.returncode != 0:
        raise UserError(f'Voice Lab install step failed ({Path(str(cmd[0])).name}); see {LOG}.')


def start_install():
    """Install on a background thread; progress in status()['install']."""
    with _lock:
        if _state['install'] and _state['install'].get('state') == 'running':
            return
        _state['install'] = {'state': 'running', 'stage': 'Starting', 'error': None, 'started': time.time()}
    threading.Thread(target=_install, name='voicelab-install', daemon=True).start()


def _install():
    try:
        VOICELAB_DIR.mkdir(parents=True, exist_ok=True)
        LOG.write_text('', encoding='utf-8')
        if not _uv_exe().is_file():
            name, ext = _uv_target()
            url = f'https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{name}{ext}'
            _log(f'Downloading uv {UV_VERSION}')
            data = requests.get(url, timeout=300).content
            UV_DIR.mkdir(parents=True, exist_ok=True)
            if ext == '.zip':
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    for m in z.namelist():
                        if Path(m).name in ('uv.exe', 'uvx.exe'):
                            (UV_DIR / Path(m).name).write_bytes(z.read(m))
            else:
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as t:
                    for m in t.getmembers():
                        if Path(m.name).name in ('uv', 'uvx') and m.isfile():
                            (UV_DIR / Path(m.name).name).write_bytes(t.extractfile(m).read())
                            os.chmod(UV_DIR / Path(m.name).name, 0o755)
        env = {**os.environ, 'UV_PYTHON_INSTALL_DIR': str(VOICELAB_DIR / 'python'),
               'UV_CACHE_DIR': str(VOICELAB_DIR / 'uv-cache')}
        _log(f'Creating a Python {PY_VERSION} environment')
        _run([_uv_exe(), 'venv', '--python', PY_VERSION, '--allow-existing', VENV_DIR], env=env)
        gpu = has_nvidia()
        _log('Installing the singing engines (' + ('CUDA' if gpu else 'CPU') + '); this is the big download')
        pkgs = list(PACKAGES)
        if gpu:
            pkgs[0] = f'ultimate-rvc[cuda]=={URVC_VERSION}'
            extra = ['--extra-index-url', TORCH_CUDA_INDEX]
        else:
            pkgs += ['torch==2.7.1', 'torchaudio==2.7.1']
            extra = ['--extra-index-url', TORCH_CPU_INDEX]
        _run([_uv_exe(), 'pip', 'install', '--python', venv_python(), *pkgs, *extra,
              '--index-strategy', 'unsafe-best-match'], env=env)
        _log('Downloading the voice models')
        LAB_DATA.mkdir(parents=True, exist_ok=True)
        _run([venv_python(), SIDECAR, '--init', '--data', LAB_DATA], env=env)
        MARKER.write_text(json.dumps({'urvc': URVC_VERSION, 'gpu': gpu, 'at': time.time()}))
        _log('Installed')
        _state['install'].update(state='done')
    except Exception as e:  # noqa: BLE001 — shown in Settings
        _logger.exception('Voice Lab install failed')
        _state['install'].update(state='error', error=str(e))


def uninstall():
    stop()
    shutil.rmtree(VOICELAB_DIR, ignore_errors=True)


# ---------------------------------------------------------------------------
# Process
# ---------------------------------------------------------------------------

def _running():
    p = _state['proc']
    return bool(p and p.poll() is None)


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def ensure_running(timeout=180):
    """Start the sidecar if it isn't up; wait until it answers."""
    if not installed():
        raise UserError('The Voice Lab is not installed (Settings → Voice Lab).')
    with _lock:
        if not _running():
            port = _free_port()
            LAB_DATA.mkdir(parents=True, exist_ok=True)
            log = open(VOICELAB_DIR / 'sidecar.log', 'a', encoding='utf-8')
            flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
            _state['proc'] = subprocess.Popen(
                [str(venv_python()), str(SIDECAR), '--port', str(port), '--data', str(LAB_DATA),
                 '--parent-pid', str(os.getpid())], stdout=log, stderr=subprocess.STDOUT, **flags)
            _state['port'] = port
            _state['log'] = log
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if health():
            return
        if not _running():
            raise UserError('The Voice Lab stopped while starting; see data/voicelab/sidecar.log.')
        time.sleep(1)
    raise UserError('The Voice Lab did not start in time.')


def stop():
    p = _state['proc']
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()
    _state['proc'] = None


def health():
    if not _state['port']:
        return None
    try:
        r = requests.get(f'http://127.0.0.1:{_state["port"]}/health', timeout=3)
        return r.json() if r.ok else None
    except requests.RequestException:
        return None


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def _url(path):
    return f'http://127.0.0.1:{_state["port"]}{path}'


def submit(kind, payload):
    ensure_running()
    r = requests.post(_url(f'/jobs/{kind}'), json=payload, timeout=30)
    r.raise_for_status()
    return r.json()['job']


def job(job_id):
    r = requests.get(_url(f'/jobs/{job_id}'), timeout=30)
    if r.status_code == 404:
        raise UserError('The Voice Lab restarted and lost that job; start it again.')
    r.raise_for_status()
    return r.json()


def run(kind, payload, progress=None, poll=1.0):
    """Submit and wait. progress(stage, fraction) is called as it goes."""
    jid = submit(kind, payload)
    while True:
        j = job(jid)
        if progress:
            progress(j.get('stage') or '', j.get('progress') or 0.0)
        if j['state'] == 'done':
            return j['result']
        if j['state'] == 'error':
            raise UserError(f'Voice Lab: {j["error"]}')
        time.sleep(poll)


def delete_model(name):
    if not installed():
        return
    try:
        ensure_running()
        requests.post(_url('/models/delete'), json={'name': name}, timeout=60)
    except Exception as e:  # noqa: BLE001
        _logger.warning('could not delete voice model %s: %s', name, e)
