# Copyright 2026 Codemarchant
"""Karaoke songs: the library behind the voice view's Stage panel.

A song is a CHART (every sung syllable with its time, length and pitch,
grouped into lyric lines) plus a BACKING track. Charts come from:

  ultrastar   an imported UltraStar .txt with its audio (the karaoke format
              used by UltraStar Deluxe, Vocaluxe, Performous; thousands of
              community charts exist for existing songs)
  companion   a song a companion wrote with the retired create_song tool
              (song_synth.py arranged its backing); existing ones still play
  example     the built-in original demo songs (song_examples.py)

A companion SINGS a chart through singing.py (its own TTS voice, re-timed
and re-pitched onto the notes), rendered once per voice and cached in
song_vocals. The browser plays the backing and the vocal stem in sync,
drives lip shapes from the chart's vowels, and dances to the beat grid
music_analysis.py extracted from the backing.
"""
import io
import json
import logging
import math
import re
import shutil
import uuid

import numpy as np

from . import music_analysis
from .db import FILES_DIR, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)

SONGS_DIR = FILES_DIR / 'songs'
AUDIO_EXTS = ('.mp3', '.ogg', '.wav', '.flac', '.opus')
MAX_UPLOAD_BYTES = 120 * 1024 * 1024
MAX_SONG_SECONDS = 12 * 60
MIDI_C4 = 60          # UltraStar pitch 0 is C4 (middle C)

# Center-channel vocal reduction for a full mix without an instrumental:
# Audacity's "Vocal Reduction and Isolation" → Remove Vocals defaults
# (manual.audacityteam.org/man/vocal_reduction_and_isolation.html): the
# centre is only removed between the low and high cut, so bass and kick
# (also centred) and the air above the voice survive.
REDUCE_LOW_CUT = 120.0
REDUCE_HIGH_CUT = 9000.0


# ---------------------------------------------------------------------------
# UltraStar TXT
# ---------------------------------------------------------------------------

_NOTE_RE = re.compile(r'^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?: (.*))?$')
_KIND = {':': 'n', '*': 'g', 'F': 'f', 'R': 'r', 'G': 'rg'}


def _decode(raw):
    for enc in ('utf-8-sig', 'cp1252'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1')


def _num(text):
    return float(str(text).strip().replace(',', '.'))


def parse_ultrastar(text):
    """UltraStar TXT → (headers, chart). Times in the chart are seconds from
    the start of the audio; pitches are MIDI note numbers."""
    headers = {}
    body = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip('\r\n')
        if not line.strip():
            continue
        if line.startswith('#') and not body:
            key, _, value = line[1:].partition(':')
            headers[key.strip().upper()] = value.strip()
        else:
            body.append(line)
    if 'BPM' not in headers:
        raise UserError('This is not an UltraStar song: the #BPM header is missing.')
    try:
        bpm = _num(headers['BPM'])
        gap = _num(headers.get('GAP') or 0)
    except ValueError:
        raise UserError('The #BPM or #GAP header is not a number.')
    if bpm <= 0:
        raise UserError('#BPM must be above zero.')
    beat = 60.0 / (bpm * 4)          # UltraStar beats are quarter-beats of #BPM
    relative = headers.get('RELATIVE', '').lower() in ('yes', 'true', '1')

    lines, current, singer, base = [], [], 1, 0
    duet = False

    def close_line():
        if current:
            lines.append({'singer': singer, 'notes': list(current)})
            current.clear()

    for line in body:
        stripped = line.strip()
        if stripped == 'E' or stripped.startswith('E '):
            break
        if re.match(r'^P\s*\d', stripped):
            close_line()
            singer = int(re.sub(r'\D', '', stripped) or 1)
            duet = True
            base = 0
            continue
        if stripped.startswith('-'):
            close_line()
            if relative:
                parts = stripped[1:].split()
                if len(parts) >= 2:
                    base += int(parts[1])
                elif parts:
                    base += int(parts[0])
            continue
        m = _NOTE_RE.match(line.lstrip() if line[:1] == ' ' else line)
        if not m:
            continue
        kind, start, length, pitch, syl = m.groups()
        start = int(start) + base
        length = max(1, int(length))
        current.append({
            't': round(gap / 1000.0 + start * beat, 4),
            'd': round(length * beat, 4),
            'p': int(pitch) + MIDI_C4,
            's': syl if syl is not None else '',
            'k': _KIND[kind],
        })
    close_line()
    for ln in lines:
        ln['notes'].sort(key=lambda n: n['t'])
        ln['start'] = ln['notes'][0]['t']
        ln['end'] = max(n['t'] + n['d'] for n in ln['notes'])
    lines.sort(key=lambda ln: (ln['start'], ln['singer']))
    if not lines:
        raise UserError('The song has no notes.')
    chart = {'lines': lines, 'bpm': bpm, 'gap_ms': gap, 'duet': duet}
    if duet:
        chart['singers'] = {str(i): headers.get(f'DUETSINGERP{i}') or headers.get(f'P{i}') or f'Singer {i}'
                            for i in sorted({ln['singer'] for ln in lines})}
    return headers, chart


def chart_stats(chart):
    notes = [n for ln in chart['lines'] for n in ln['notes']]
    pitched = [n['p'] for n in notes if n['k'] in ('n', 'g') and n['p'] is not None]
    return {
        'notes': len(notes),
        'lines': len(chart['lines']),
        'low': min(pitched) if pitched else None,
        'high': max(pitched) if pitched else None,
        'median': float(np.median(pitched)) if pitched else None,
        'end': max((ln['end'] for ln in chart['lines']), default=0.0),
    }


def lyrics_text(chart):
    """Plain lyrics, one chart line per text line."""
    out = []
    for ln in chart['lines']:
        out.append(''.join(n['s'] for n in ln['notes'] if not n['s'].startswith('~')).strip())
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def decode_audio(raw, filename):
    """Any supported file → (stereo float32 (2, n), sample rate)."""
    import soundfile as sf
    try:
        data, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    except Exception:
        raise UserError(f'Could not read "{filename}" as audio. Supported: MP3, OGG, WAV, FLAC.')
    if not len(data):
        raise UserError(f'"{filename}" holds no audio.')
    if len(data) / rate > MAX_SONG_SECONDS:
        raise UserError(f'"{filename}" is longer than {MAX_SONG_SECONDS // 60} minutes.')
    data = data[:, :2] if data.shape[1] >= 2 else np.repeat(data, 2, axis=1)
    return np.ascontiguousarray(data.T), rate


def read_audio(path):
    import soundfile as sf
    data, rate = sf.read(str(path), dtype='float32', always_2d=True)
    data = data[:, :2] if data.shape[1] >= 2 else np.repeat(data, 2, axis=1)
    return np.ascontiguousarray(data.T), rate


def write_ogg(path, stereo, rate):
    """Vorbis in blocks: one huge write can crash libsndfile (seen with the
    bundled beds)."""
    import soundfile as sf
    with sf.SoundFile(str(path), 'w', rate, stereo.shape[0], format='OGG', subtype='VORBIS') as f:
        x = np.clip(stereo.T, -1, 1)
        for i in range(0, len(x), 65536):
            f.write(x[i:i + 65536])


def reduce_vocals(stereo, rate):
    """Remove centre-panned content between the low and high cut (see
    REDUCE_*). Side content and everything outside the band is kept."""
    n = stereo.shape[1]
    # Overlap-add in 2^16 blocks with a raised-cosine window (50 % overlap)
    # so memory stays flat on long songs.
    block = 1 << 16
    hop = block // 2
    win = np.sin(np.pi * (np.arange(block) + 0.5) / block) ** 2
    freqs = np.fft.rfftfreq(block, 1.0 / rate)
    band = ((freqs >= REDUCE_LOW_CUT) & (freqs <= REDUCE_HIGH_CUT)).astype(np.float32)
    acc = np.zeros((2, n + hop + block), np.float32)
    pad = np.pad(stereo, ((0, 0), (hop, block)))
    for a in range(0, n + hop, hop):
        seg = pad[:, a:a + block] * win
        mid = np.fft.rfft(seg.mean(axis=0))
        centre = np.fft.irfft(mid * band, block)
        acc[:, a:a + block] += seg - centre[None, :]
    return acc[:, hop:hop + n].astype(np.float32)


def integrated_lufs(stereo, rate):
    """BS.1770 integrated loudness of a whole (2, n) array."""
    from . import audio_studio
    if rate != audio_studio.SR:
        import soxr
        stereo = soxr.resample(stereo.T, rate, audio_studio.SR).T.astype(np.float32)
    hop = audio_studio.SR // 10
    kw = audio_studio._fft_filter(stereo, audio_studio._k_weight_curve)
    m = kw.shape[1] // hop
    energies = (kw[:, :m * hop] ** 2).reshape(2, m, hop).mean(axis=2).sum(axis=0)
    return audio_studio._integrated_loudness(energies)


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------

def song_dir(folder):
    return SONGS_DIR / folder


def file_url(folder, name):
    return f'/files/songs/{folder}/{name}' if name else None


def _row_dict(con, row):
    chart = json.loads(row['chart'])
    vocals = [dict(v) for v in con.execute(
        "SELECT id, voice, transpose, vocal_file, tts_chars, usd, created_at FROM song_vocals "
        "WHERE song_id = ? ORDER BY created_at DESC", (row['id'],))]
    for v in vocals:
        v['vocal_url'] = file_url(row['folder'], v.pop('vocal_file'))
    stats = chart_stats(chart)
    return {
        'id': row['id'], 'title': row['title'], 'artist': row['artist'],
        'source': row['source'], 'agent_id': row['agent_id'], 'language': row['language'],
        'backing_url': file_url(row['folder'], row['backing_file']),
        'backing_mode': row['backing_mode'], 'style': row['style'],
        'duration_seconds': row['duration_seconds'], 'credit': row['credit'],
        'created_at': row['created_at'], 'stats': stats, 'vocals': vocals,
        'duet': bool(chart.get('duet')),
    }


def list_songs(con):
    rows = con.execute("SELECT * FROM songs ORDER BY lower(title)").fetchall()
    return [_row_dict(con, r) for r in rows]


def get_song(con, song_id):
    row = con.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone()
    if not row:
        raise UserError('That song no longer exists.')
    return row


def stage_payload(con, song_id, voice=None):
    """Everything the stage needs to perform a song: chart, beat grid, the
    backing and (when rendered) the vocal stem with its sung timing."""
    row = get_song(con, song_id)
    out = _row_dict(con, row)
    out['chart'] = json.loads(row['chart'])
    out['analysis'] = json.loads(row['analysis']) if row['analysis'] else None
    if voice:
        v = con.execute("SELECT * FROM song_vocals WHERE song_id = ? AND voice = ?",
                        (song_id, voice)).fetchone()
        if v:
            out['vocal'] = {'voice': v['voice'], 'transpose': v['transpose'],
                            'url': file_url(row['folder'], v['vocal_file']),
                            'timing': json.loads(v['timing']) if v['timing'] else None}
    return out


def create_song(con, *, title, artist, source, chart, backing, backing_rate, backing_mode,
                source_text='', language='en', agent_id=None, credit='', analysis=None):
    """Store a song: writes the backing as OGG, analyses its beats (unless
    the caller knows them) and inserts the row. Returns the new id."""
    folder = uuid.uuid4().hex
    d = song_dir(folder)
    d.mkdir(parents=True, exist_ok=True)
    try:
        backing_file = 'backing.ogg'
        write_ogg(d / backing_file, backing, backing_rate)
        duration = backing.shape[1] / backing_rate
        if analysis is None:
            analysis = music_analysis.analyze(backing, backing_rate)
        cur = con.execute(
            """INSERT INTO songs (title, artist, source, agent_id, language, chart, source_text,
                                  folder, backing_file, backing_mode, analysis, duration_seconds,
                                  credit, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (title[:120], (artist or '')[:120], source, agent_id, language, json.dumps(chart),
             source_text, folder, backing_file, backing_mode, json.dumps(analysis),
             round(duration, 2), (credit or '')[:300], utcnow()))
        return cur.lastrowid
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


def delete_song(con, song_id):
    row = con.execute("SELECT folder FROM songs WHERE id = ?", (song_id,)).fetchone()
    if not row:
        return
    con.execute("DELETE FROM song_vocals WHERE song_id = ?", (song_id,))
    con.execute("UPDATE dances SET song_id = NULL WHERE song_id = ?", (song_id,))
    con.execute("DELETE FROM songs WHERE id = ?", (song_id,))
    shutil.rmtree(song_dir(row['folder']), ignore_errors=True)


def _basename(name):
    return re.split(r'[\\/]', name or '')[-1].strip().lower()


def import_ultrastar(con, files, *, vocals_mode='auto'):
    """files: [(filename, bytes)] — one .txt plus its audio.

    vocals_mode: 'auto' uses an #INSTRUMENTAL file when one was uploaded,
    else the song audio as it is; 'reduce' runs the centre-cut vocal
    reduction on the song audio; 'keep' never touches it."""
    txts = [(n, b) for n, b in files if n.lower().endswith('.txt')]
    audios = {_basename(n): (n, b) for n, b in files if n.lower().endswith(AUDIO_EXTS)}
    if len(txts) != 1:
        raise UserError('Pick exactly one UltraStar .txt file, together with its audio.')
    for n, b in files:
        if len(b) > MAX_UPLOAD_BYTES:
            raise UserError(f'"{n}" is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.')
    text = _decode(txts[0][1])
    headers, chart = parse_ultrastar(text)
    wanted = _basename(headers.get('AUDIO') or headers.get('MP3') or '')
    instrumental = _basename(headers.get('INSTRUMENTAL') or '')
    if not audios:
        want = headers.get('AUDIO') or headers.get('MP3') or 'its audio file'
        raise UserError(f'Add the song\'s audio too ({want}).')
    mode = 'as-is'
    if instrumental and instrumental in audios and vocals_mode != 'keep':
        name, raw = audios[instrumental]
        mode = 'instrumental'
    elif wanted in audios:
        name, raw = audios[wanted]
    elif len(audios) == 1:
        name, raw = next(iter(audios.values()))
    else:
        raise UserError(f'None of the audio files is the one the chart names ({wanted or "?"}).')
    backing, rate = decode_audio(raw, name)
    if vocals_mode == 'reduce' and mode != 'instrumental':
        backing = reduce_vocals(backing, rate)
        mode = 'reduced'
    title = headers.get('TITLE') or txts[0][0].rsplit('.', 1)[0]
    lang = _language_code(headers.get('LANGUAGE', ''))
    song_id = create_song(con, title=title, artist=headers.get('ARTIST', ''), source='ultrastar',
                          chart=chart, backing=backing, backing_rate=rate, backing_mode=mode,
                          source_text=text, language=lang,
                          credit=', '.join(v for v in (headers.get('ARTIST'),
                                                       headers.get('CREATOR') and f'chart by {headers["CREATOR"]}')
                                           if v))
    return song_id


_LANGS = {'english': 'en', 'japanese': 'ja', 'german': 'de', 'french': 'fr', 'spanish': 'es',
          'italian': 'it', 'portuguese': 'pt', 'korean': 'ko', 'chinese': 'zh', 'dutch': 'nl',
          'polish': 'pl', 'russian': 'ru', 'swedish': 'sv', 'finnish': 'fi', 'norwegian': 'no',
          'danish': 'da', 'turkish': 'tr'}


def _language_code(name):
    first = re.split(r'[,;/]', name or '')[0].strip().lower()
    if re.fullmatch(r'[a-z]{2}', first):
        return first
    return _LANGS.get(first, 'auto')


def mix_to_recording(con, song_id, voice, *, vocal_db=0.0):
    """Backing + the companion's vocal stem → one mp3 in /files (for the
    Recordings list and sharing). Returns (web path, duration)."""
    from . import audio_studio
    import lameenc
    import soxr
    row = get_song(con, song_id)
    v = con.execute("SELECT * FROM song_vocals WHERE song_id = ? AND voice = ?",
                    (song_id, voice)).fetchone()
    if not v:
        raise UserError('Render the vocals first.')
    d = song_dir(row['folder'])
    backing, rate = read_audio(d / row['backing_file'])
    vocal, vrate = read_audio(d / v['vocal_file'])
    sr = 44100
    if rate != sr:
        backing = soxr.resample(backing.T, rate, sr).T
    if vrate != sr:
        vocal = soxr.resample(vocal.T, vrate, sr).T
    n = max(backing.shape[1], vocal.shape[1])
    mix = np.zeros((2, n), np.float32)
    mix[:, :backing.shape[1]] += backing
    mix[:, :vocal.shape[1]] += vocal * audio_studio._db(vocal_db)
    peak = float(np.abs(mix).max()) or 1.0
    if peak > audio_studio._db(-1.0):
        mix *= audio_studio._db(-1.0) / peak
    enc = lameenc.Encoder()
    enc.set_bit_rate(192)
    enc.set_in_sample_rate(sr)
    enc.set_channels(2)
    enc.set_quality(5)
    out = bytearray()
    for a in range(0, n, sr * 30):
        pcm = (np.clip(mix[:, a:a + sr * 30], -1, 1).T * 32767).astype('<i2')
        out += enc.encode(pcm.tobytes())
    out += enc.flush()
    fname = f'audio_{uuid.uuid4().hex}.mp3'
    (FILES_DIR / fname).write_bytes(bytes(out))
    return f'/files/{fname}', n / sr


def semitone_name(midi):
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return f'{names[int(midi) % 12]}{int(midi) // 12 - 1}'


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12.0)


def midi_of(freq):
    return 69 + 12 * math.log2(freq / 440.0)
