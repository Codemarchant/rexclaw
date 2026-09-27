# Copyright 2026 Codemarchant
"""The user's own sound library for the audio studio.

Uploaded audio becomes a named sound that scripts call by kind:

  bed     {bed NAME}    a looping background bed, like the built-in ones
                        (ducks under speech, swells with {breathe})
  music   {music NAME}  a looping music layer that plays alongside a bed
  sound   {sound NAME}  a one-shot effect at that moment, like {chime}

Uploads are decoded (soundfile: WAV, FLAC, OGG, MP3), mixed to stereo,
resampled to the studio's 24 kHz (soxr) and stored as FLAC under
data/files/sounds/. Licensing is the user's call; the credit field is
there to keep track of it. Loops get a crossfaded seam at load time, so
any file can loop without a click.
"""
import io
import re
import uuid

import numpy as np

from .db import ASSETS_DIR, FILES_DIR, utcnow
from .errors import UserError

SOUNDS_DIR = FILES_DIR / 'sounds'

# Recorded beds and music that ship with the app (assets/audio/beds, CC0
# from Freesound; provenance in the CREDITS.md there). They play exactly
# like uploads of the same kind, by name. Descriptions come from measuring
# the files (pulse tempo, bass share, stereo width) as well as the
# uploaders' notes. name → (file, kind, description)
BUNDLED_DIR = ASSETS_DIR / 'audio' / 'beds'
BUNDLED = {
    'heartbeat-drone': ('heartbeat-drone.ogg', 'bed',
                        'a deep, evolving drone with a slow heartbeat pulse at 60 bpm: the classic '
                        'hypnosis bed, for deepeners and trance'),
    'void-drone': ('void-drone.ogg', 'bed',
                   'a very dark, heavy sub-bass drone, enveloping, for deep trance; mostly below '
                   '120 Hz, so it needs headphones or speakers with real bass'),
    'relaxation-pads': ('relaxation-pads.ogg', 'bed',
                        'warm, wide, dreamy synth pads drifting through a slow chord progression; '
                        'soothing, for inductions, meditation and sleep'),
    'angelic-pad': ('angelic-pad.ogg', 'bed',
                    'an airy, bright, floating synth pad with almost no bass; uplifting, for '
                    'inductions, meditation and gentle openings'),
    'emanation': ('emanation.ogg', 'bed',
                  'a dark, low, mesmerising synth texture with a steady fast throb; for trance '
                  'and focus, too busy for sleep'),
    'space-pad': ('space-pad.ogg', 'music',
                  'weightless, spacious ambient pad music with no beat and no bass; sits over a '
                  'low bed like ocean, for arrivals and meditation'),
    'cosmic-glow': ('cosmic-glow.ogg', 'music',
                    'warm, glowing ambient music with a soft steady rhythm at 70 bpm; for lighter '
                    'moments and wake-ups rather than deep trance'),
}
BUNDLED_BEDS = {n: v for n, v in BUNDLED.items() if v[1] == 'bed'}
BUNDLED_MUSIC = {n: v for n, v in BUNDLED.items() if v[1] == 'music'}
KINDS = {
    'bed': 'Bed loop',
    'music': 'Music',
    'sound': 'Sound effect',
}
NAME_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
MAX_UPLOAD_BYTES = 80 * 1024 * 1024
MAX_SECONDS = 30 * 60          # an upload is decoded whole into memory; beds and music
                               # loop, so they never need the render's 2-hour length
LOOP_SEAM = 3.0                # seconds of crossfade folded into a loop's seam
RESERVED = {'ocean', 'rain', 'brown', 'pink', 'drone', 'none', 'off', 'stop', 'on', *BUNDLED}

_CACHE = {}  # id → (file mtime, stereo float32 at SR)


def validate(con, *, name, kind, level, sound_id=None):
    """Clean, checked values for a sound row, or UserError."""
    name = (name or '').strip().lower()
    if not NAME_RE.match(name):
        raise UserError('The name is what scripts call it: lowercase letters, digits and hyphens, '
                        'up to 40 characters, e.g. velvet-drone.')
    if name in RESERVED:
        raise UserError(f'"{name}" is taken by a built-in sound or keyword; pick another name.')
    clash = con.execute("SELECT id FROM audio_sounds WHERE name = ? AND id IS NOT ?",
                        (name, sound_id)).fetchone()
    if clash:
        raise UserError(f'You already have a sound called "{name}".')
    if kind not in KINDS:
        raise UserError('Kind must be bed, music or sound.')
    try:
        level = max(-24.0, min(12.0, float(level or 0)))
    except (TypeError, ValueError):
        raise UserError('Level is a number of dB from -24 to 12.')
    return name, kind, level


def ingest(raw, filename):
    """Decode an uploaded file → (web path, duration seconds)."""
    import soundfile as sf
    import soxr
    from .audio_studio import SR
    if len(raw) > MAX_UPLOAD_BYTES:
        raise UserError(f'The file is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.')
    try:
        data, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    except Exception:
        raise UserError(f'Could not read "{filename}" as audio. Supported: WAV, FLAC, OGG and MP3.')
    if not len(data):
        raise UserError('The file holds no audio.')
    if len(data) / rate > MAX_SECONDS:
        raise UserError(f'The file is longer than {MAX_SECONDS // 60} minutes.')
    data = data[:, :2] if data.shape[1] >= 2 else np.repeat(data, 2, axis=1)
    if rate != SR:
        data = soxr.resample(data, rate, SR).astype(np.float32)
    peak = float(np.abs(data).max())
    if peak > 0:
        data = data * (0.89 / peak)  # −1 dBFS; levels are set at render time
    SOUNDS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f'sound_{uuid.uuid4().hex}.flac'
    with sf.SoundFile(SOUNDS_DIR / fname, 'w', SR, 2, format='FLAC', subtype='PCM_16') as f:
        for i in range(0, len(data), 65536):  # blocks: one huge write can crash libsndfile
            f.write(data[i:i + 65536])
    return f'/files/sounds/{fname}', round(len(data) / SR, 1)


def catalog(con):
    """name → row dict for every sound, for the parser and the guide."""
    if con is None:
        return {}
    return {r['name']: dict(r) for r in con.execute(
        "SELECT * FROM audio_sounds ORDER BY kind, name").fetchall()}


def load(row):
    """An uploaded sound's audio; see load_file."""
    path = SOUNDS_DIR / row['file_path'].rsplit('/', 1)[-1]
    return load_file(path, row['kind'], ('upload', row['id']), row['name'])


def load_bundled(name):
    """A bundled bed or music track's audio; see load_file."""
    fname, kind, _desc = BUNDLED[name]
    return load_file(BUNDLED_DIR / fname, kind, ('bundled', name), name)


def load_file(path, kind, cache_key, name):
    """Audio as (2, N) float32 at the studio rate, cached per file. Beds and
    music come back as seamless loops scaled to RMS 1 (the procedural beds'
    scale); effects come back peak-normalised to 1."""
    import soundfile as sf
    from .audio_studio import SR
    try:
        mtime = path.stat().st_mtime
    except OSError:
        raise UserError(f'The file for sound "{name}" is missing; re-upload it.')
    hit = _CACHE.get(cache_key)
    if hit and hit[0] == mtime and hit[2] == kind:
        return hit[1]
    data, rate = sf.read(path, dtype='float32', always_2d=True)
    if rate != SR:
        import soxr
        data = soxr.resample(data, rate, SR).astype(np.float32)
    x = np.ascontiguousarray(data.T)
    if kind == 'sound':
        x = x / max(float(np.abs(x).max()), 1e-9)
    else:
        x = _seamless(x)
        x = x / max(float(np.sqrt(np.mean(x ** 2))), 1e-9)
    _CACHE[cache_key] = (mtime, x, kind)
    return x


def _seamless(x):
    """Fold the tail into the head with an equal-power crossfade, so the
    buffer loops without a click or a gap."""
    from .audio_studio import SR
    n = x.shape[1]
    seam = min(int(LOOP_SEAM * SR), n // 4)
    if seam < 2:
        return x
    ramp = np.linspace(0, np.pi / 2, seam, dtype=np.float32)
    head = x[:, :seam] * np.sin(ramp) + x[:, n - seam:] * np.cos(ramp)
    return np.concatenate([head, x[:, seam:n - seam]], axis=1)


def delete_file(row):
    path = SOUNDS_DIR / row['file_path'].rsplit('/', 1)[-1]
    path.unlink(missing_ok=True)
    _CACHE.pop(('upload', row['id']), None)


def store(con, *, name, kind, description, level, credit, file_path, source_filename, duration):
    return con.execute(
        """INSERT INTO audio_sounds (name, kind, description, level, credit, file_path,
                                     source_filename, duration_seconds, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, kind, description, level, credit, file_path, source_filename, duration,
         utcnow())).lastrowid
