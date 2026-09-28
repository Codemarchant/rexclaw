# Copyright 2026 Codemarchant
"""Songs from a link or a video: the karaoke stage's "cover" songs.

Everything heavy runs in the Voice Lab (voicelab.py):

  fetch      a link (any site yt-dlp supports) or an uploaded audio/video
             file → WAV, with title/artist metadata
  separate   → instrumental (the backing, backing vocals kept) + the
             original singer's lead vocal, de-reverbed (the singing guide
             a voice profile re-sings: the AI-cover recipe)
  pitch      RMVPE melody of the lead vocal, 100 frames a second
  transcribe faster-whisper word timings of the lead vocal

Lyrics text comes from LRCLIB (lrclib.net, free, line-synced) when it has
the song, else from Whisper. LRCLIB's words are placed on Whisper's word
timings (sequence alignment over normalised words); words Whisper missed
are spread over the voiced frames between their neighbours. Every word
becomes a note at the median pitch of its voiced frames, split into
'~' continuation notes where the melody moves a semitone or more and holds
(melisma), so the note lane and the scoring follow the singer.
"""
import difflib
import logging
import re
import shutil
import threading
import time
import uuid

import numpy as np
import requests

from . import songs, voicelab
from .db import FILES_DIR
from .errors import UserError

_logger = logging.getLogger(__name__)

LRCLIB = 'https://lrclib.net/api'
USER_AGENT = 'Rexclaw (https://github.com/codemarchant/rexclaw)'
F0_FPS = 100
MIN_NOTE = 0.12        # s: shorter pitch steps stay inside the note (design)
SPLIT_SEMITONES = 1.0  # a held change this big starts a '~' note (design)
MAX_LINE_WORDS = 9     # longer lyric lines are split for the karaoke display (design)
UPLOAD_DIR = FILES_DIR / 'songs' / '_uploads'

# Title noise stripped before searching lyrics.
_NOISE = re.compile(r'\s*[\(\[\{][^\)\]\}]*(official|video|audio|lyric|mv|hd|4k|visualizer|remaster'
                    r'|live|color coded|eng|sub)[^\)\]\}]*[\)\]\}]', re.I)


def guess_artist_title(meta):
    title = (meta.get('title') or '').strip()
    artist = (meta.get('artist') or '').strip()
    raw = _NOISE.sub('', meta.get('raw_title') or title).strip()
    m = re.match(r'^(.+?)\s+[-–—|]\s+(.+)$', raw)
    if m and (not meta.get('artist') or meta.get('title') == meta.get('raw_title')):
        artist, title = m.group(1).strip(), m.group(2).strip()
    title = _NOISE.sub('', title).strip(' -')
    artist = re.sub(r'\s*-\s*Topic$', '', artist).strip()
    return artist, title


def lrclib_lookup(artist, title, duration=None):
    """→ [(t_seconds, line text)] from LRCLIB's synced lyrics, or None."""
    headers = {'User-Agent': USER_AGENT}
    cands = []
    try:
        if artist and title:
            params = {'artist_name': artist, 'track_name': title}
            if duration:
                params['duration'] = int(round(duration))
            r = requests.get(f'{LRCLIB}/get', params=params, headers=headers, timeout=15)
            if r.ok:
                cands.append(r.json())
        q = f'{artist} {title}'.strip()
        if q:
            r = requests.get(f'{LRCLIB}/search', params={'q': q}, headers=headers, timeout=15)
            if r.ok:
                cands.extend(r.json() or [])
    except requests.RequestException as e:
        _logger.warning('LRCLIB lookup failed: %s', e)
        return None
    best = None
    for c in cands:
        lines = parse_lrc(c.get('syncedLyrics') or '')
        # Crowd-sourced: skip placeholder entries and ones for another cut.
        if len(lines) < 4:
            continue
        if duration and c.get('duration') and abs(c['duration'] - duration) > 4:
            continue
        best = lines
        break
    return best


def parse_lrc(text):
    out = []
    for line in (text or '').splitlines():
        stamps = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', line)
        words = re.sub(r'\[[^\]]*\]', '', line).strip()
        for mm, ss in stamps:
            out.append((int(mm) * 60 + float(ss), words))
    out.sort()
    return [(t, w) for t, w in out if w]


def _norm(w):
    return re.sub(r"[^\w']", '', w.lower())


def build_chart(f0, whisper, lrc, duration):
    """Lead-vocal F0 (Hz at 100 fps), Whisper segments and LRCLIB lines
    (or None) → chart {'lines': [{notes: [{t, d, p, s, k}]}]}."""
    voiced = f0 > 0
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0), np.nan)
    ww = [(w['w'], w['start'], w['end']) for s in whisper for w in s.get('words', []) if w['w'].strip()]
    lines = []   # [(start, end, [(word, t0, t1)])]
    if lrc:
        flat = []    # (line index, word)
        for li, (_t, text) in enumerate(lrc):
            for w in text.split():
                flat.append((li, w))
        sm = difflib.SequenceMatcher(None, [_norm(w) for _li, w in flat], [_norm(w) for w, _a, _b in ww],
                                     autojunk=False)
        times = [None] * len(flat)
        for a, b, n in sm.get_matching_blocks():
            for k in range(n):
                times[a + k] = (ww[b + k][1], ww[b + k][2])
        for li, (t_line, _text) in enumerate(lrc):
            idx = [i for i, (l, _w) in enumerate(flat) if l == li]
            if not idx:
                continue
            end_line = lrc[li + 1][0] if li + 1 < len(lrc) else duration
            # Anchor the unmatched words between matched neighbours (or the
            # line's own start/end), spread over that stretch.
            known = [(i, times[i]) for i in idx if times[i] and t_line - 1 <= times[i][0] <= end_line + 1]
            words = []
            anchors = [(idx[0] - 1, (t_line, t_line))] + known + [(idx[-1] + 1, (end_line, end_line))]
            for (ia, ta), (ib, tb) in zip(anchors[:-1], anchors[1:]):
                if ia >= idx[0]:
                    words.append((flat[ia][1], ta[0], ta[1]))
                gap = [i for i in idx if ia < i < ib]
                if gap:
                    a0, b0 = ta[1], tb[0]
                    step = max(0.05, (b0 - a0) / len(gap))
                    for k, i in enumerate(gap):
                        words.append((flat[i][1], a0 + k * step, a0 + (k + 1) * step))
            words.sort(key=lambda w: w[1])
            lines.append(words)
    else:
        for s in whisper:
            ws = [(w['w'], w['start'], w['end']) for w in s.get('words', []) if w['w'].strip()]
            if ws:
                lines.append(ws)
    # Karaoke shows a line at a time: split long ones (Whisper often joins
    # two sung lines) at the comma nearest the middle, else the middle.
    split = []
    for words in lines:
        while len(words) > MAX_LINE_WORDS:
            mid = len(words) // 2
            commas = [i + 1 for i, (w, _a, _b) in enumerate(words[:-1]) if w.rstrip().endswith((',', '.', ';', '!', '?'))]
            cut = min(commas, key=lambda i: abs(i - mid)) if commas else mid
            if cut <= 2 or cut >= len(words) - 2:
                cut = mid
            split.append(words[:cut])
            words = words[cut:]
        split.append(words)
    lines = split
    chart_lines = []
    for words in lines:
        notes = []
        for k, (w, t0, t1) in enumerate(words):
            t1 = max(t1, t0 + 0.08)
            nxt = words[k + 1][1] if k + 1 < len(words) else t1
            t1 = min(t1, max(t0 + 0.08, nxt))
            a, b = int(t0 * F0_FPS), int(t1 * F0_FPS)
            seg = midi[a:b]
            text = w + ' '
            if not np.isfinite(seg).any():
                notes.append({'t': round(t0, 3), 'd': round(t1 - t0, 3), 'p': None, 's': text, 'k': 'f'})
                continue
            notes.extend(_split_word(seg, t0, text))
        if notes:
            chart_lines.append({'singer': 1, 'notes': notes, 'start': notes[0]['t'],
                                'end': max(n['t'] + n['d'] for n in notes)})
    return {'lines': chart_lines, 'bpm': None, 'gap_ms': 0, 'duet': False}


def _split_word(seg, t0, text):
    """One word's pitch frames → notes: the first carries the word, later
    ones '~' where the melody steps and holds."""
    pts = np.where(np.isfinite(seg), seg, np.nan)
    # Median-smooth over 50 ms so vibrato and scoops don't split notes.
    k = 5
    padded = np.pad(pts, k // 2, mode='edge')
    sm = np.array([np.nanmedian(padded[i:i + k]) if np.isfinite(padded[i:i + k]).any() else np.nan
                   for i in range(len(pts))])
    notes = []
    start, cur = 0, None
    for i, v in enumerate(sm):
        if not np.isfinite(v):
            continue
        if cur is None:
            cur, start = v, i
            continue
        if abs(v - cur) >= SPLIT_SEMITONES and (i - start) / F0_FPS >= MIN_NOTE:
            # a step: close the current note if the new pitch holds
            ahead = sm[i:i + int(MIN_NOTE * F0_FPS)]
            ahead = ahead[np.isfinite(ahead)]
            if len(ahead) and abs(np.median(ahead) - cur) >= SPLIT_SEMITONES:
                notes.append((start, i, cur))
                cur, start = v, i
                continue
        cur = cur + (v - cur) * 0.05   # follow slow drift
    if cur is not None:
        notes.append((start, len(sm), cur))
    out = []
    for j, (a, b, p) in enumerate(notes):
        seg_p = sm[a:b]
        seg_p = seg_p[np.isfinite(seg_p)]
        pitch = int(round(float(np.median(seg_p)))) if len(seg_p) else int(round(p))
        out.append({'t': round(t0 + a / F0_FPS, 3), 'd': round(max(0.05, (b - a) / F0_FPS), 3), 'p': pitch,
                    's': text if j == 0 else '~', 'k': 'n'})
    return out or [{'t': round(t0, 3), 'd': 0.1, 'p': None, 's': text, 'k': 'f'}]


# ---------------------------------------------------------------------------
# Import job
# ---------------------------------------------------------------------------

_jobs = {}
_lock = threading.Lock()


def start_import(source, *, title=None, artist=None, language=None):
    """Start importing a link or an uploaded file path; returns a job id
    the stage polls with job_status()."""
    jid = uuid.uuid4().hex
    with _lock:
        _jobs[jid] = {'state': 'running', 'stage': 'Starting', 'progress': 0.0, 'error': None,
                      'song_id': None, 'at': time.monotonic()}

    def run():
        from .db import connect
        con = connect()
        try:
            song_id = _import(con, jid, source, title, artist, language)
            con.commit()
            _set(jid, state='done', song_id=song_id, progress=1.0, stage='Done')
        except UserError as e:
            _set(jid, state='error', error=str(e))
        except Exception as e:  # noqa: BLE001
            _logger.exception('cover import failed')
            _set(jid, state='error', error=f'Import failed: {e}')
        finally:
            con.close()

    threading.Thread(target=run, name='cover-import', daemon=True).start()
    return jid


def _set(jid, **kw):
    with _lock:
        _jobs[jid].update(kw)


def job_status(jid):
    with _lock:
        j = dict(_jobs.get(jid) or {})
    if not j:
        raise UserError('That import is gone (the server restarted?). Start it again.')
    j.pop('at', None)
    return j


def _import(con, jid, source, title, artist, language):
    work =FILES_DIR / 'songs' / f'_import_{jid}'
    work.mkdir(parents=True, exist_ok=True)
    try:
        def step(name, a, b):
            return lambda s, f: _set(jid, stage=s or name, progress=a + (b - a) * (f or 0))

        _set(jid, stage='Starting the Voice Lab')
        meta = voicelab.run('fetch', {'source': str(source), 'out_dir': str(work)},
                            progress=step('Downloading', 0.02, 0.15))
        sep = voicelab.run('separate', {'input': meta['audio'], 'out_dir': str(work)},
                           progress=step('Separating', 0.15, 0.6))
        voicelab.run('pitch', {'input': sep['lead_dry'], 'output': str(work / 'f0.npy')},
                     progress=step('Tracking the melody', 0.6, 0.65))
        f0 = np.load(work / 'f0.npy')
        g_artist, g_title = guess_artist_title(meta)
        artist = (artist or g_artist or '').strip()
        title = (title or g_title or 'Untitled song').strip()
        backing, rate = songs.read_audio(sep['instrumental'])
        duration = backing.shape[1] / rate
        _set(jid, stage='Looking up the lyrics', progress=0.66)
        lrc = lrclib_lookup(artist, title, duration)
        tr = voicelab.run('transcribe', {'input': sep['lead_dry'], 'language': language},
                          progress=step('Listening to the lyrics', 0.7, 0.9))
        chart = build_chart(f0, tr['segments'], lrc, duration)
        if not chart['lines']:
            raise UserError('No sung lyrics were found in that song.')
        _set(jid, stage='Finding the beat', progress=0.92)
        voiced = f0[f0 > 0]
        song_id = songs.create_song(
            con, title=title, artist=artist, source='cover', chart=chart, backing=backing,
            backing_rate=rate, backing_mode='instrumental', language=tr.get('language') or language or 'auto',
            credit=', '.join(v for v in (artist, meta.get('webpage_url')) if v))
        row = songs.get_song(con, song_id)
        folder = songs.song_dir(row['folder'])
        shutil.copy(sep['lead_dry'], folder / 'guide.wav')
        con.execute("""UPDATE songs SET guide_file = 'guide.wav', guide_median_hz = ?, source_url = ?,
                       lyrics_source = ? WHERE id = ?""",
                    (round(float(np.median(voiced)), 1) if len(voiced) else None,
                     meta.get('webpage_url') if re.match(r'^https?://', str(source)) else None,
                     'lrclib' if lrc else 'whisper', song_id))
        return song_id
    finally:
        shutil.rmtree(work, ignore_errors=True)
        # An uploaded video/audio file was only needed for this import.
        try:
            if UPLOAD_DIR in (source.parents if hasattr(source, 'parents') else ()):
                source.unlink(missing_ok=True)
        except OSError:
            pass
