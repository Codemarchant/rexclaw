# Copyright 2026 Codemarchant
"""A companion sings a song chart in its own voice.

Grok TTS can't sing to a melody: <singing> has no key or tempo control. So
this is speech-to-singing (Saitou, Goto, Unoki & Akagi 2007, "Speech-to-
singing synthesis: converting speaking voices to singing voices by
controlling acoustic features unique to singing voices", IEEE WASPAA;
staff.aist.go.jp/m.goto/PAPER/WASPAA2007saitou.pdf). Each lyric line is
spoken by xAI TTS in the companion's voice, with per-character timestamps
that locate every syllable, analysed with the WORLD vocoder (F0, spectral
envelope, aperiodicity), then

  duration   the vowel is stretched to fill its note and lands ON the beat
             (accompanists follow vowel onsets); consonants are stretched by
             Saitou's fixed per-class rates and sit before the beat, taking
             their time from the previous note (the KTH singing rules); the
             40 ms around each consonant-vowel boundary is never stretched
  F0         replaced by the melody through Saitou's F0 control model:
             second-order overshoot after a note change, the preparation dip
             before it, vibrato on held notes and fine fluctuation
  spectrum   Saitou's singing-formant boost around the envelope peak near
             3 kHz, and the amplitude modulation that rides the vibrato

and resynthesised by WORLD. The spectral envelope is the companion's own,
so a line sung well above the speaking voice still sounds like them.

Output: a vocal stem (OGG, the backing's length) plus the sung timing of
every syllable, which the stage uses for lip shapes and the lyric wipe.
"""
import base64
import concurrent.futures
import difflib
import io
import json
import logging
import math
import re
import time

import numpy as np
import requests

from . import audio_studio, songs, store, xai_client
from .errors import UserError

_logger = logging.getLogger(__name__)

SR = audio_studio.SR              # 24 kHz: xAI TTS's rate
FRAME_MS = 5.0                    # WORLD's defaults: 5 ms frames,
FPS = 1000.0 / FRAME_MS
F0_FLOOR, F0_CEIL = 71.0, 800.0   # F0 search 71–800 Hz

# --- Saitou et al. 2007, F0 control model --------------------------------
# Each fluctuation is H(s) = k / (s² + 2ζωs + ω²) driven by the melody's
# step contour (in log F0); ω in rad/ms. We run the systems at unit DC gain
# (k = ω²) so a held note settles exactly on its pitch.
OVERSHOOT_OMEGA, OVERSHOOT_ZETA = 0.0348, 0.5422
PREPARATION_OMEGA, PREPARATION_ZETA = 0.0292, 0.6681
PREPARATION_WINDOW = 0.3          # s before a change searched for the dip
VIBRATO_HZ = 0.0345 * 1000 / (2 * math.pi)   # ζ = 0 oscillator: 5.49 Hz
# The paper gives no extent in cents. Sundberg (KTH): vibrato is 50–100
# cents peak-to-peak; the midpoint, 75, is ±37.5.
VIBRATO_CENTS = 37.5
# Vibrato starts after the note has settled: 0.47 s is the mean onset
# delay measured on held soprano notes (ICIC 2025 poster; a weak source,
# measured on long classical notes).
VIBRATO_ONSET = 0.47
# Fine fluctuation: white noise high-passed at 10 Hz (first order,
# −20 dB/oct), scaled so its largest excursion is 5 Hz.
FINE_FLUCT_HZ = 10.0
FINE_FLUCT_MAX = 5.0
# --- spectral control ------------------------------------------------------
SINGER_FORMANT_DB = 12.0          # peak Fs (the envelope peak near 3 kHz) +12 dB,
SINGER_FORMANT_BAND = 2000.0      # over Fb = 2 kHz around it
SINGER_FORMANT_SEARCH = (2500.0, 3500.0)
AM_DEPTH = 0.2                    # E(t) = (1 + 0.2 sin 2π·5.5t)·E(t) during vibrato
# --- duration control --------------------------------------------------------
# Saitou's consonant stretch rates by class; the consonant-vowel boundary
# (10 ms before it to 30 ms after) is copied unstretched.
STRETCH = {'fricative': 1.58, 'plosive': 1.13, 'semivowel': 2.07, 'nasal': 1.77, 'y': 1.13}
CV_BEFORE, CV_AFTER = 0.010, 0.030
# Singers sustain a diphthong's first vowel and sound the second just
# before the next consonant. A stretched vowel holds its first 40 % for
# the note and plays the rest in the last 15 % (design fractions).
VOWEL_HOLD_SRC = 0.4
VOWEL_GLIDE_OUT = 0.15
# KTH MUSSE rule: a consonant takes its time from the previous note, up to
# half of it (/l/ after a short vowel in a 400 ms note = 200 ms).
CONSONANT_SHARE = 0.5
NUCLEUS_DIP_DB = 2.0              # de Jong & Wempe 2009: a syllable nucleus is an
                                  # intensity peak with a ≥ 2 dB dip before it
VOWEL_DROP_DB = 8.0               # design: the vowel = frames within 8 dB of its peak
# --- register -------------------------------------------------------------------
# Habitual speaking pitch sits about a quarter of the way up a voice's range
# (Fairbanks 1960). Charts move by whole octaves (so they stay in the
# backing's key) to keep the most sung time inside a two-octave range with
# the companion's speaking median at its lower quarter (the range width is
# a design value); a tie keeps the written octave.
RANGE_BELOW_SPEECH = 6
RANGE_ABOVE_SPEECH = 18
# A voice profile trained on speech keeps its timbre only near the pitches
# it heard (unseen pitch bins fall back to the pretrain), so its range tops
# out an octave above the speaking median (design; an octave-down take
# sounded most like Eve in the 2026-09-27 listening test).
PROFILE_RANGE_ABOVE = 12
# --- mix --------------------------------------------------------------------------
# Lead vocal vs accompaniment in pop has sat around +1 dB since the 1970s
# (Deruty et al. / JASA 2023, doi:10.1121/10.0017773). The stage has a
# level slider on top.
VOCAL_OVER_BACKING_LU = 1.0
REVERB_WET_DB = -14               # design: the studio's hall, well under the voice
ENV_FPS = 50                      # the stage's mouth-opening track


# ---------------------------------------------------------------------------
# Lyrics → syllables
# ---------------------------------------------------------------------------

def _is_melisma(text):
    return text.strip().startswith('~') or not re.search(r'\w', text)


def line_syllables(line):
    """Chart line → syllables: [{'text', 'notes': [note…], 'word_start'}].
    A '~' note (or one without letters) extends the previous syllable."""
    syls = []
    prev_ended_word = True
    for n in line['notes']:
        text = n['s']
        if syls and _is_melisma(text):
            syls[-1]['notes'].append(n)
            continue
        word_start = prev_ended_word or text.startswith(' ')
        syls.append({'text': text, 'notes': [n], 'word_start': word_start})
        prev_ended_word = text.endswith(' ')
    return syls


def line_text(syls):
    """What TTS says for the line, and each syllable's [a, b) in it."""
    out = ''
    ranges = []
    for s in syls:
        t = ' '.join(s['text'].replace('~', '').split())
        if s['word_start'] and out and not out.endswith(' '):
            out += ' '
        a = len(out)
        out += t
        ranges.append((a, len(out)))
    return out, ranges


# VRM viseme for a syllable's vowel (aa ih ou ee oh), from its spelling.
_KANA_VOWELS = {
    'a': 'あかさたなはまやらわがざだばぱぁゃアカサタナハマヤラワガザダバパァャ',
    'i': 'いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ',
    'u': 'うくすつぬふむゆるぐずづぶぷぅゅゥュウクスツヌフムユルグズヅブプ',
    'e': 'えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ',
    'o': 'おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ',
}
_VISEME = {'a': 'aa', 'i': 'ih', 'u': 'ou', 'e': 'ee', 'o': 'oh'}
# Frequent lyric words whose spelling misleads the rules below (the vowel
# the mouth holds when the word is sung).
_WORD_VISEME = {'i': 'aa', "i'm": 'aa', "i'll": 'aa', 'my': 'aa', 'by': 'aa', 'why': 'aa',
                'fly': 'aa', 'sky': 'aa', 'cry': 'aa', 'you': 'ou', "you're": 'ou', 'through': 'ou',
                'to': 'ou', 'do': 'ou', 'who': 'ou', 'your': 'oh', 'how': 'aa', 'now': 'aa',
                'love': 'aa', 'one': 'aa', 'come': 'aa', 'some': 'aa', 'the': 'aa', 'of': 'aa',
                'what': 'aa', 'was': 'aa', 'from': 'aa', 'heart': 'aa', 'are': 'aa', 'be': 'ih',
                'me': 'ih', 'we': 'ih', 'she': 'ih', 'he': 'ih', 'down': 'aa', 'out': 'aa',
                'around': 'aa', 'sound': 'aa', 'go': 'oh', 'so': 'oh', 'no': 'oh', 'know': 'oh',
                'oh': 'oh', 'hold': 'oh', 'home': 'oh', 'night': 'aa', 'light': 'aa', 'time': 'aa'}


def viseme(text):
    t = text.strip().lower().replace('~', '')
    for ch in reversed(t):
        for v, chars in _KANA_VOWELS.items():
            if ch in chars:
                return _VISEME[v]
    word = re.sub(r"[^a-z']", '', t)
    if word in _WORD_VISEME:
        return _WORD_VISEME[word]
    letters = re.sub(r'[^a-zà-ÿ]', '', t)
    if not letters:
        return 'aa'
    for pat, vis in (('igh', 'aa'), ('ee', 'ih'), ('ea', 'ih'), ('ie', 'ih'), ('oo', 'ou'),
                     ('oun', 'aa'), ('out', 'aa'), ('oud', 'aa'), ('ou', 'ou'),
                     ('ow', 'oh'), ('oa', 'oh'), ('ew', 'ou'), ('ue', 'ou'),
                     ('ai', 'ee'), ('ay', 'ee'), ('ei', 'ee'), ('au', 'oh'), ('aw', 'oh'),
                     ('oy', 'oh'), ('oi', 'oh')):
        if pat in letters:
            return vis
    m = re.search(r'[aeiou]', letters)
    if not m:
        return 'aa' if letters.endswith('y') and len(letters) <= 3 else 'ih'
    v = m.group(0)
    rest = letters[m.end():]
    if v == 'i' and re.fullmatch(r'[^aeiou]e', rest):      # magic e: "fire", "time"
        return 'aa'
    if v == 'u' and rest and not rest.startswith('e'):      # closed "u": sun, fun
        return 'aa'
    return _VISEME[v]


_KANA_ROWS = {'plosive': 'かきくけこがぎぐげごたちつてとだぢづでどぱぴぷぺぽばびぶべぼカキクケコガギグゲゴタチツテトダヂヅデドパピプペポバビブベボ',
              'fricative': 'さしすせそざじずぜぞはひふへほサシスセソザジズゼゾハヒフヘホ',
              'nasal': 'なにぬねのまみむめもんナニヌネノマミムメモン',
              'semivowel': 'らりるれろわをラリルレロワヲ',
              'y': 'やゆよヤユヨ'}


def consonant_class(letters, where='onset'):
    """Saitou's consonant class of a syllable's onset (or coda) spelling."""
    t = letters.strip().lower()
    if t:
        for cls, chars in _KANA_ROWS.items():
            if t[0] in chars:
                return cls
    t = re.sub(r'[^a-z]', '', t)
    if where == 'onset':
        m = re.match(r'[^aeiou]+', t)
        cons = m.group(0) if m else ''
    else:
        m = re.search(r'[^aeiouy]+$', t)
        cons = m.group(0) if m else ''
    if not cons:
        return None
    c = cons[0] if where == 'onset' else cons[-1]
    if cons.startswith(('th', 'sh', 'ch', 'ph')) or c in 'sfvzhjx':
        return 'fricative'
    if c in 'pbtdkcgq':
        return 'plosive'
    if c in 'wrl':
        return 'semivowel'
    if c in 'mn':
        return 'nasal'
    if c == 'y':
        return 'y'
    return 'plosive'


# ---------------------------------------------------------------------------
# TTS with character timestamps
# ---------------------------------------------------------------------------

def tts_timed(config, text, voice, language):
    """One xAI TTS call with `with_timestamps` → (mono float32 at SR,
    [(char, start_s, end_s)] or None). Untrimmed, so the times hold."""
    import soundfile as sf
    url = config['xai_tts_url'] or 'https://api.x.ai/v1/tts'
    headers = {'Authorization': f'Bearer {config["xai_api_key"]}',
               'Content-Type': 'application/json'}
    payload = {'text': text, 'voice_id': voice, 'language': language or 'auto',
               'output_format': {'codec': 'wav', 'sample_rate': SR},
               'with_timestamps': True}
    for backoff in (1.0, 2.0, 4.0, None):
        resp = xai_client._post_with_retry(url, headers, payload, timeout=180)
        if resp.status_code in (400, 422) and payload.get('with_timestamps'):
            # An endpoint without timestamps (an older API, a proxy): sing
            # anyway, finding the syllables from the audio alone.
            _logger.warning('TTS refused with_timestamps (%s); falling back', resp.status_code)
            payload.pop('with_timestamps')
            continue
        if resp.status_code != 429 or backoff is None:
            break
        time.sleep(backoff)
    if resp.status_code != 200:
        raise UserError(f'TTS failed ({resp.status_code}) for voice "{voice}": {(resp.text or "")[:300]}')
    chars = None
    raw = resp.content
    if 'json' in (resp.headers.get('content-type') or '') or raw[:1] == b'{':
        body = resp.json()
        raw = base64.b64decode(body.get('audio') or '')
        ts = body.get('audio_timestamps') or {}
        gc, gt = ts.get('graph_chars') or [], ts.get('graph_times') or []
        if gc and len(gc) == len(gt):
            chars = [(c, float(t[0]), float(t[1])) for c, t in zip(gc, gt)]
    data, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    if rate != SR:
        import soxr
        mono = soxr.resample(mono, rate, SR).astype(np.float32)
    return mono, chars


def _syllable_spans(text, ranges, chars):
    """Map each syllable's characters onto the TTS's timed characters →
    [(start_s, end_s) | None]. The two strings differ where the TTS
    normalised something (numbers, tags), so they are aligned first."""
    if not chars:
        return None
    graph = ''.join(c for c, _a, _b in chars)
    sm = difflib.SequenceMatcher(None, text.lower(), graph.lower(), autojunk=False)
    where = {}
    for i, j, n in sm.get_matching_blocks():
        for k in range(n):
            where[i + k] = j + k
    spans = []
    for a, b in ranges:
        idx = [where[i] for i in range(a, b) if i in where and not text[i].isspace()]
        if not idx:
            spans.append(None)
            continue
        spans.append((chars[min(idx)][1], chars[max(idx)][2]))
    return spans


# ---------------------------------------------------------------------------
# WORLD analysis + syllable segmentation
# ---------------------------------------------------------------------------

def _analyse(x):
    import pyworld as pw
    x = x.astype(np.float64)
    f0, t = pw.harvest(x, SR, f0_floor=F0_FLOOR, f0_ceil=F0_CEIL, frame_period=FRAME_MS)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    return f0, sp, ap


def _loudness_db(sp):
    """Per-frame level from the spectral envelope (dB), smoothed over 25 ms."""
    e = 10 * np.log10(sp.sum(axis=1) + 1e-12)
    return np.convolve(np.pad(e, 2, mode='edge'), np.ones(5) / 5, 'valid')


def _vowel(loud, voiced, a, b):
    """Vowel region [v0, v1] inside frames [a, b): the loudest voiced frame
    and its neighbours within VOWEL_DROP_DB. None when nothing is voiced."""
    a, b = max(0, a), min(len(loud), b)
    if b - a < 2:
        return None
    idx = np.arange(a, b)
    v = voiced[a:b]
    if not v.any():
        return None
    p = int(idx[v][np.argmax(loud[a:b][v])])
    thr = loud[p] - VOWEL_DROP_DB
    v0 = p
    while v0 - 1 >= a and voiced[v0 - 1] and loud[v0 - 1] > thr:
        v0 -= 1
    v1 = p
    while v1 + 1 < b and voiced[v1 + 1] and loud[v1 + 1] > thr:
        v1 += 1
    return v0, max(v1, v0 + 1), p


def _nuclei(loud, voiced, n, lo, hi):
    """Fallback without timestamps: n syllable nuclei in [lo, hi) from
    intensity peaks that are voiced and stand ≥ NUCLEUS_DIP_DB above the dip
    before them; extra peaks are pruned least-prominent first, missing
    ones placed in the longest gaps."""
    seg = loud[lo:hi]
    v = voiced[lo:hi]
    peaks = [i for i in range(1, len(seg) - 1)
             if v[i] and seg[i] >= seg[i - 1] and seg[i] > seg[i + 1]]
    changed = True
    while changed and len(peaks) > 1:
        changed = False
        for k in range(len(peaks) - 1):
            a, b = peaks[k], peaks[k + 1]
            if min(seg[a], seg[b]) - seg[a:b + 1].min() < NUCLEUS_DIP_DB:
                peaks.pop(k if seg[a] < seg[b] else k + 1)
                changed = True
                break
    while len(peaks) > n:
        prom = []
        for k, p in enumerate(peaks):
            left = seg[peaks[k - 1]:p + 1].min() if k else seg[:p + 1].min()
            right = seg[p:peaks[k + 1] + 1].min() if k + 1 < len(peaks) else seg[p:].min()
            prom.append(seg[p] - max(left, right))
        peaks.pop(int(np.argmin(prom)))
    while len(peaks) < n:
        edges = [0] + peaks + [len(seg) - 1]
        gaps = [edges[i + 1] - edges[i] for i in range(len(edges) - 1)]
        g = int(np.argmax(gaps))
        mid = (edges[g] + edges[g + 1]) // 2
        if mid in peaks or gaps[g] < 2:
            mid = min(len(seg) - 1, (peaks[-1] if peaks else 0) + 1)
            if mid in peaks:
                break
        peaks = sorted(set(peaks + [mid]))
    return [lo + p for p in peaks[:n]]


def _segment(f0, sp, syls, spans):
    """Speech of one line → one {'a','v0','v1','b'} per syllable, in source
    frames: onset consonant [a, v0), vowel [v0, v1], coda (v1, b)."""
    loud = _loudness_db(sp)
    voiced = f0 > 0
    floor = loud.max() - 45.0
    active = np.flatnonzero(loud > floor)
    lo, hi = (int(active[0]), int(active[-1]) + 1) if len(active) else (0, len(loud))
    n = len(syls)
    segs = [None] * n
    if spans and sum(s is not None for s in spans) >= max(1, int(0.8 * n)):
        for k, sp_ in enumerate(spans):
            if sp_ is None:
                continue
            a, b = int(sp_[0] * FPS), int(math.ceil(sp_[1] * FPS))
            vw = _vowel(loud, voiced, a, b)
            if vw:
                segs[k] = {'a': a, 'v0': vw[0], 'v1': vw[1], 'b': max(b, vw[1] + 1), 'peak': vw[2]}
    missing = [k for k, s in enumerate(segs) if s is None]
    if missing:
        # Fill gaps from intensity nuclei between the known neighbours.
        k = 0
        while k < n:
            if segs[k] is not None:
                k += 1
                continue
            j = k
            while j < n and segs[j] is None:
                j += 1
            a = segs[k - 1]['b'] if k else lo
            b = segs[j]['a'] if j < n else hi
            if b - a < 2 * (j - k):
                b = a + 2 * (j - k)
            nuc = _nuclei(loud, voiced, j - k, a, min(b, len(loud)))
            bounds = [a] + [nuc[i] + int(np.argmin(loud[nuc[i]:nuc[i + 1] + 1]))
                            for i in range(len(nuc) - 1)] + [b]
            for i in range(j - k):
                sa, sb = bounds[i], bounds[i + 1]
                vw = _vowel(loud, voiced, sa, sb) or (sa, max(sa + 1, sb - 1), sa)
                segs[k + i] = {'a': sa, 'v0': vw[0], 'v1': vw[1], 'b': max(sb, vw[1] + 1), 'peak': vw[2]}
            k = j
    return segs, loud


# ---------------------------------------------------------------------------
# F0 contour
# ---------------------------------------------------------------------------

def _second_order(x, omega_rad_ms, zeta, dt):
    """x through ω²/(s² + 2ζωs + ω²), sampled every dt s (1 ms sub-steps)."""
    w = omega_rad_ms * 1000.0
    sub = max(1, int(round(dt / 0.001)))
    h = dt / sub
    y, v = float(x[0]), 0.0
    out = np.empty(len(x))
    for i, target in enumerate(x):
        for _ in range(sub):
            v += (w * w * (target - y) - 2 * zeta * w * v) * h
            y += v * h
        out[i] = y
    return out


def _f0_contour(step, note_spans, rng):
    """step: target MIDI per output frame (NaN where nothing is sung) →
    (MIDI curve, vibrato phase curve for the AM, vibrato weight 0..1)."""
    dt = FRAME_MS / 1000.0
    idx = np.flatnonzero(~np.isnan(step))
    n = len(step)
    if not len(idx):
        return np.full(n, 60.0), np.zeros(n), np.zeros(n)
    filled = np.interp(np.arange(n), idx, step[idx])
    over = _second_order(filled, OVERSHOOT_OMEGA, OVERSHOOT_ZETA, dt)
    prep = _second_order(filled[::-1], PREPARATION_OMEGA, PREPARATION_ZETA, dt)[::-1]
    # Preparation: the reversed system anticipates every change; keep only
    # its dip AWAY from the coming note (the rise itself is the overshoot
    # system's job), so the two join where the dip crosses zero.
    dip = prep - filled
    keep = np.zeros(n)
    changes = np.flatnonzero(np.abs(np.diff(filled)) > 1e-6) + 1
    win = int(PREPARATION_WINDOW * FPS)
    for c in changes:
        direction = np.sign(filled[c] - filled[c - 1])
        a = max(0, c - win)
        seg = dip[a:c]
        # the contiguous run of opposite-direction dip ending nearest c
        opp = seg * direction < 0
        if not opp.any():
            continue
        last = np.flatnonzero(opp)[-1]
        first = last
        while first - 1 >= 0 and opp[first - 1]:
            first -= 1
        keep[a + first:a + last + 1] = 1
    curve = over + dip * keep
    # Vibrato on held notes, faded in over one cycle.
    vib_phase = np.zeros(n)
    vib_w = np.zeros(n)
    cycle = 1.0 / VIBRATO_HZ
    for s, e in note_spans:
        on = s + int(VIBRATO_ONSET * FPS)
        if on >= e - 2:
            continue
        k = np.arange(on, e)
        tt = (k - on) / FPS
        ramp = np.clip(tt / cycle, 0, 1)
        ramp = 0.5 - 0.5 * np.cos(math.pi * ramp)
        ph = 2 * math.pi * VIBRATO_HZ * tt + rng.uniform(0, 2 * math.pi)
        vib_phase[k] = ph
        vib_w[k] = ramp
    curve = curve + vib_w * (VIBRATO_CENTS / 100.0) * np.sin(vib_phase)
    return curve, vib_phase, vib_w


def _fine_fluctuation(n, rng):
    """Saitou's fine fluctuation in Hz: white noise through a first-order
    10 Hz high-pass, largest excursion FINE_FLUCT_MAX."""
    x = rng.standard_normal(n)
    rc = 1.0 / (2 * math.pi * FINE_FLUCT_HZ)
    dt = FRAME_MS / 1000.0
    alpha = rc / (rc + dt)
    y = np.zeros(n)
    for i in range(1, n):
        y[i] = alpha * (y[i - 1] + x[i] - x[i - 1])
    m = np.abs(y).max()
    return y * (FINE_FLUCT_MAX / m) if m > 0 else y


# ---------------------------------------------------------------------------
# One line
# ---------------------------------------------------------------------------

def _formant_weight(n_bins, fs_hz):
    """Saitou's W(f): +SINGER_FORMANT_DB at Fs, raised-cosine over Fs ± Fb/2
    (power gain)."""
    freqs = np.linspace(0, SR / 2, n_bins)
    x = np.clip((freqs - fs_hz) / (SINGER_FORMANT_BAND / 2), -1, 1)
    db = SINGER_FORMANT_DB * (0.5 + 0.5 * np.cos(math.pi * x))
    return 10 ** (db / 10)


def _place(syls, segs):
    """Target times (seconds) for every syllable's regions:
    onset [o0, T0), vowel [T0, c0), coda [c0, c1). Consonants before the
    beat take their time from the previous note (KTH), shrinking together
    when the gap is tight."""
    plan = []
    for s, seg in zip(syls, segs):
        notes = s['notes']
        T0 = notes[0]['t']
        T1 = notes[-1]['t'] + notes[-1]['d']
        on_cls = consonant_class(s['text'], 'onset')
        cd_cls = consonant_class(s['text'], 'coda')
        on_src = max(0, seg['v0'] - seg['a']) / FPS
        cd_src = max(0, seg['b'] - seg['v1']) / FPS
        on = on_src * STRETCH.get(on_cls, 1.0) if on_src > CV_BEFORE else on_src
        cd = cd_src * STRETCH.get(cd_cls, 1.0)
        plan.append({'T0': T0, 'T1': T1, 'on': on, 'cd': cd, 'on_src': on_src, 'cd_src': cd_src})
    for k, p in enumerate(plan):
        prev = plan[k - 1] if k else None
        if prev:
            # Room between the previous vowel's minimum and this beat.
            min_vowel = max(0.06, (1 - CONSONANT_SHARE) * (prev['T1'] - prev['T0']))
            room = p['T0'] - (prev['T0'] + min_vowel)
            # The previous coda ends at its note end or where this onset
            # starts, whichever is first.
            need = p['on'] + (prev['cd'] if prev['T1'] > p['T0'] - p['on'] else 0.0)
            if need > room > 0:
                scale = room / need
                p['on'] *= scale
                prev['cd'] *= scale
            elif room <= 0:
                p['on'] = min(p['on'], 0.02)
                prev['cd'] = min(prev['cd'], 0.02)
        else:
            p['on'] = min(p['on'], 0.35)
    for k, p in enumerate(plan):
        nxt = plan[k + 1] if k + 1 < len(plan) else None
        p['o0'] = p['T0'] - p['on']
        end = p['T1']
        if nxt:
            end = min(end, nxt['T0'] - nxt['on'])
        p['c1'] = max(p['T0'] + 0.02, end)
        p['c0'] = max(p['T0'] + 0.02, min(p['c1'] - 0.005, p['c1'] - p['cd']))
    return plan


def sing_line(x, line, transpose, rng, spans=None):
    """Spoken line audio → (sung mono float32 at SR, t0 seconds of its first
    sample on the song clock, [per-syllable timing])."""
    import pyworld as pw
    syls = line_syllables(line)
    if not syls:
        return None
    f0, sp, ap = _analyse(x)
    segs, loud = _segment(f0, sp, syls, spans)
    n_src = len(f0)
    plan = _place(syls, segs)
    t0 = max(0.0, min(p['o0'] for p in plan) - 0.05)
    t_end = max(p['c1'] for p in plan) + 0.25
    n_out = int((t_end - t0) * FPS) + 1
    src_pos = np.full(n_out, -1.0)          # source frame per output frame; -1 = silence
    role = np.zeros(n_out, np.int8)         # 0 silent, 1 consonant, 2 vowel
    step = np.full(n_out, np.nan)
    gain = np.ones(n_out)
    rap = np.zeros(n_out, bool)
    note_spans = []
    timing = []

    def fr(t):
        return min(n_out, max(0, int(round((t - t0) * FPS))))

    def lay(a, b, sa, sb, r):
        """Map output frames [a, b) linearly onto source frames [sa, sb)."""
        if b > a:
            src_pos[a:b] = np.linspace(sa, sb, b - a, endpoint=False)
            role[a:b] = r

    for s, seg, p in zip(syls, segs, plan):
        o0, T0, c0, c1 = fr(p['o0']), fr(p['T0']), fr(p['c0']), fr(p['c1'])
        # Onset: all but the last 10 ms stretched, the CV boundary 1:1.
        cv = int(CV_BEFORE * FPS)
        src_on0 = seg['v0'] - p['on_src'] * FPS
        if T0 - o0 > cv and p['on_src'] * FPS > cv:
            lay(o0, T0 - cv, src_on0, seg['v0'] - cv, 1)
            lay(T0 - cv, T0, seg['v0'] - cv, seg['v0'], 1)
        else:
            lay(o0, T0, max(src_on0, seg['v0'] - (T0 - o0)), seg['v0'], 1)
        # Vowel: the first 30 ms 1:1, the rest stretched (or squeezed) to fit.
        after = min(int(CV_AFTER * FPS), max(0, seg['v1'] - seg['v0'] - 1), max(0, c0 - T0 - 1))
        lay(T0, T0 + after, seg['v0'], seg['v0'] + after, 2)
        src_len = seg['v1'] - (seg['v0'] + after)
        out_len = c0 - (T0 + after)
        if out_len > 2 * src_len > 0:
            # Stretched: sustain the vowel's first part and sound the rest
            # (a diphthong's glide, "time" = ah…ee) just before the
            # consonant, the way singers do, instead of smearing the glide
            # over the whole note.
            split_src = seg['v0'] + after + VOWEL_HOLD_SRC * src_len
            split_out = T0 + after + int((1 - VOWEL_GLIDE_OUT) * out_len)
            lay(T0 + after, split_out, seg['v0'] + after, split_src, 2)
            lay(split_out, c0, split_src, seg['v1'], 2)
        else:
            lay(T0 + after, c0, seg['v0'] + after, seg['v1'], 2)
        if c0 > T0:
            # Hold the vowel at its peak: speech vowels decay, and a
            # stretched decay reads as a fading note (design). Only the decay
            # after the peak is made up, so the rise into the vowel stays as
            # spoken and the make-up starts from nothing, and it hands back
            # over the last CV_BEFORE + CV_AFTER before the coda: switched
            # on and off in one frame, it stepped the level 6-8 dB at every
            # word (measured), which sounds jittery.
            pos_v = src_pos[T0:c0]
            lv = np.interp(pos_v, np.arange(n_src), loud)
            up = np.where(pos_v >= seg['peak'], np.clip(loud[seg['peak']] - 1.5 - lv, 0, 12), 0.0)
            k = min(len(up), int((CV_BEFORE + CV_AFTER) * FPS))
            if k:
                up[-k:] *= np.linspace(1, 0, k)
            gain[T0:c0] = 10 ** (up / 20)
        lay(c0, c1, seg['v1'], seg['b'], 1)
        notes = s['notes']
        if notes[0]['k'] in ('r', 'rg', 'f') or notes[0]['p'] is None:
            rap[o0:c1] = True
        else:
            for n in notes:
                if n['p'] is None:
                    continue
                a, b = fr(n['t']), fr(n['t'] + n['d'])
                step[a:max(b, a + 1)] = n['p'] + transpose
                note_spans.append((a, b))
            step[o0:T0] = notes[0]['p'] + transpose     # the change happens in the consonant
            step[c0:c1] = notes[-1]['p'] + transpose
        timing.append({'t0': round(p['T0'], 3), 't1': round(p['c0'], 3),
                       'v': viseme(s['text']), 'text': s['text']})

    contour, vib_phase, vib_w = _f0_contour(step, note_spans, rng)
    live = src_pos >= 0
    pos = np.clip(src_pos, 0, n_src - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, n_src - 1)
    w = (pos - i0)[:, None]
    out_sp = sp[i0] * (1 - w) + sp[i1] * w
    out_ap = ap[i0] * (1 - w) + ap[i1] * w
    src_voiced = f0[np.rint(pos).astype(int)] > 0
    voiced = live & ((role == 2) | src_voiced) & ~rap
    out_f0 = np.where(voiced, 440.0 * 2 ** ((contour - 69) / 12.0), 0.0)
    out_f0[voiced] += _fine_fluctuation(int(voiced.sum()), rng)
    spoken = live & rap & src_voiced
    out_f0[spoken] = f0[np.rint(pos[spoken]).astype(int)]
    # Singing formant on vowels, at this line's envelope peak near 3 kHz.
    vowel = role == 2
    if vowel.any():
        freqs = np.linspace(0, SR / 2, sp.shape[1])
        band = (freqs >= SINGER_FORMANT_SEARCH[0]) & (freqs <= SINGER_FORMANT_SEARCH[1])
        fs_hz = float(np.median(freqs[band][np.argmax(out_sp[vowel][:, band], axis=1)]))
        W = _formant_weight(sp.shape[1], fs_hz)
        out_sp[vowel] *= W
        out_ap[vowel] /= np.sqrt(W)           # deepen the aperiodicity dip the same way
    out_ap[vowel] = np.minimum(out_ap[vowel], 1.0)
    # Amplitude modulation riding the vibrato.
    am = 1 + AM_DEPTH * vib_w * np.sin(vib_phase)
    out_sp *= (gain * am)[:, None] ** 2
    out_sp[~live] = max(float(sp.min()), 1e-16) * 1e-3
    out_ap[~live] = 1.0
    out_f0 = np.maximum(out_f0, 0.0)
    y = pw.synthesize(out_f0.astype(np.float64), np.ascontiguousarray(out_sp),
                      np.ascontiguousarray(np.clip(out_ap, 0.0, 1.0)), SR, FRAME_MS)
    # 10 ms fades at the edges of every silent gap (WORLD can click there).
    env = np.interp(np.arange(len(y)) / SR * FPS, np.arange(n_out), live.astype(float))
    k = int(0.01 * SR)
    env = np.convolve(env, np.ones(k) / k, 'same')
    return (y * env).astype(np.float32), t0, timing


# ---------------------------------------------------------------------------
# Whole song
# ---------------------------------------------------------------------------

def speech_median_midi(clips):
    """Median speaking pitch over the given clips (a quick DIO pass)."""
    import pyworld as pw
    vals = []
    for x in clips:
        f0, _t = pw.dio(x.astype(np.float64), SR, f0_floor=F0_FLOOR, f0_ceil=F0_CEIL,
                        frame_period=FRAME_MS)
        vals.append(f0[f0 > 0])
    v = np.concatenate(vals) if vals else np.array([])
    return float(songs.midi_of(np.median(v))) if len(v) else None


def transpose_for(chart, speech_midi, above=RANGE_ABOVE_SPEECH):
    """Whole octaves that keep the most sung time in the voice's range."""
    if speech_midi is None:
        return 0
    notes = [n for ln in chart['lines'] for n in ln['notes'] if n['p'] is not None and n['k'] in ('n', 'g')]
    if not notes:
        return 0
    lo, hi = speech_midi - RANGE_BELOW_SPEECH, speech_midi + above

    def outside(shift):
        # semitone-seconds outside the range
        return sum(n['d'] * max(0.0, lo - (n['p'] + shift), (n['p'] + shift) - hi) for n in notes)

    return min((0, -12, 12, -24, 24), key=lambda s: (round(outside(s), 3), abs(s)))


def line_jobs(chart):
    """(line index, TTS text, syllable char ranges) for every sung line."""
    jobs = []
    for li, line in enumerate(chart['lines']):
        syls = line_syllables(line)
        text, ranges = line_text(syls)
        if text and re.search(r'\w', text):
            jobs.append((li, text, ranges))
    return jobs


def singer_key(voice, profile=None):
    """What a song's rendered vocal is filed under: the xAI voice, or the
    voice profile that re-sang it."""
    return f'profile:{profile["id"]}' if profile else voice


def render(con, config, song_id, *, voice, language=None, transpose=None, progress=None,
           profile=None):
    """Sing song `song_id` in `voice` (or through voice `profile`, a ready
    voice_profiles row); stores/replaces its song_vocals row.
    Returns {'vocal_url', 'transpose', 'tts_chars', 'usd', 'seconds'}."""
    row = songs.get_song(con, song_id)
    chart = json.loads(row['chart'])
    if row['source'] == 'cover':
        if not profile:
            raise UserError('A song from a link or video is sung through a singing voice profile. '
                            'Train one in the Stage panel first.')
        return _render_cover(con, row, chart, profile, transpose, progress)
    if not config['xai_api_key']:
        raise UserError(xai_client.NO_KEY_MSG)
    language = language or row['language'] or 'auto'
    jobs = line_jobs(chart)
    if not jobs:
        raise UserError('The song has no lyrics to sing.')
    started = time.monotonic()
    speech = {}
    pool = concurrent.futures.ThreadPoolExecutor(audio_studio.TTS_WORKERS)
    futures = {pool.submit(tts_timed, config, text, voice, language): (li, text, ranges)
               for li, text, ranges in jobs}
    try:
        for fut in concurrent.futures.as_completed(futures):
            li, text, ranges = futures[fut]
            audio, chars = fut.result()
            speech[li] = (audio, _syllable_spans(text, ranges, chars))
            if progress:
                progress('voice', len(speech), len(jobs))
    except requests.RequestException as e:
        raise UserError(f'Could not reach xAI TTS: {e}')
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        spoken = sum(len(t) for f, (li, t, r) in futures.items()
                     if f.done() and not f.cancelled() and f.exception() is None)
        store.accrue_usd_ticks(con, int(spoken * audio_studio.TTS_USD_PER_CHAR * store.USD_TICKS_PER_USD))
    chars = sum(len(t) for _li, t, _r in jobs)
    if transpose is None:
        if profile and profile['speech_median_hz']:
            # A voice profile sings best near the range it was trained on.
            transpose = transpose_for(chart, songs.midi_of(profile['speech_median_hz']),
                                      above=PROFILE_RANGE_ABOVE)
        else:
            transpose = transpose_for(chart, speech_median_midi([a for a, _s in list(speech.values())[:12]]))
    mono, timing = sing_song(row, chart, speech, transpose, progress=progress)
    rate = SR
    if profile:
        mono, rate = _through_profile(row, mono, SR, profile, 0, progress)
    stereo = _finish(row, mono, rate)
    usd = chars * audio_studio.TTS_USD_PER_CHAR
    return _store(con, row, singer_key(voice, profile), transpose, stereo, rate, timing, chars, usd,
                  started)


def _store(con, row, singer, transpose, stereo, rate, timing, chars, usd, started):
    fname = f'vocal_{re.sub(r"[^a-z0-9_-]", "_", singer.lower()) or "voice"}.ogg'
    songs.write_ogg(songs.song_dir(row['folder']) / fname, stereo, rate)
    con.execute("DELETE FROM song_vocals WHERE song_id = ? AND voice = ?", (row['id'], singer))
    con.execute("""INSERT INTO song_vocals (song_id, voice, transpose, vocal_file, timing,
                                             tts_chars, usd, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (row['id'], singer, transpose, fname,
                 json.dumps({'syllables': timing, 'env': _envelope(stereo, rate), 'env_fps': ENV_FPS}),
                 chars, round(usd, 4), songs.utcnow()))
    _logger.info('song %s sung by %s: transpose %+d, %.1f s wall',
                 row['id'], singer, transpose, time.monotonic() - started)
    return {'vocal_url': songs.file_url(row['folder'], fname), 'transpose': transpose,
            'tts_chars': chars, 'usd': round(usd, 4),
            'seconds': round(time.monotonic() - started, 1)}


def _through_profile(row, mono, rate, profile, semitones, progress):
    """Re-sing a guide vocal in a voice profile's voice (Voice Lab RVC)."""
    import soundfile as sf
    from . import voicelab
    folder = songs.song_dir(row['folder'])
    guide = folder / 'guide_tmp.wav'
    out = folder / 'converted_tmp.wav'
    sf.write(str(guide), np.asarray(mono, np.float32), rate)
    try:
        voicelab.run('convert', {'model': profile['model'], 'input': str(guide), 'output': str(out),
                                 'semitones': int(semitones)},
                     progress=(lambda s, f: progress('convert', int(f * 100), 100)) if progress else None)
        y, r = sf.read(str(out), dtype='float32', always_2d=True)
    finally:
        for f in (guide, out):
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass
    return y.mean(axis=1), r


def _render_cover(con, row, chart, profile, transpose, progress):
    """A song from a link or video: the original singer's dry lead vocal,
    re-sung in the profile's voice, moved by whole octaves towards it."""
    import soundfile as sf
    started = time.monotonic()
    guide = songs.song_dir(row['folder']) / row['guide_file']
    if not row['guide_file'] or not guide.is_file():
        raise UserError('This song has no lead vocal to sing from; import it again.')
    if transpose is None:
        transpose = transpose_for(chart, songs.midi_of(profile['speech_median_hz'])
                                  if profile['speech_median_hz'] else None, above=PROFILE_RANGE_ABOVE)
    x, rate = sf.read(str(guide), dtype='float32', always_2d=True)
    mono, rate = _through_profile(row, x.mean(axis=1), rate, profile, transpose, progress)
    stereo = _finish(row, mono, rate)
    timing = []
    for li, ln in enumerate(chart['lines']):
        notes = ln['notes']
        for i, n in enumerate(notes):
            if n['s'].startswith('~'):
                continue
            end = n['t'] + n['d']
            for m in notes[i + 1:]:
                if not m['s'].startswith('~'):
                    break
                end = m['t'] + m['d']
            timing.append({'t0': round(n['t'], 3), 't1': round(end, 3), 'v': viseme(n['s']),
                           'text': n['s'], 'line': li})
    return _store(con, row, singer_key(None, profile), transpose, stereo, rate, timing, 0, 0.0, started)


def _finish(row, mono, rate):
    """Dry vocal → stereo with the hall reverb, levelled against the backing."""
    stereo = _vocal_chain(np.asarray(mono, np.float32), rate)
    backing, brate = songs.read_audio(songs.song_dir(row['folder']) / row['backing_file'])
    b_lufs = songs.integrated_lufs(backing, brate)
    v_lufs = songs.integrated_lufs(stereo, rate)
    if b_lufs is not None and v_lufs is not None:
        stereo *= audio_studio._db(b_lufs + VOCAL_OVER_BACKING_LU - v_lufs)
    peak = float(np.abs(stereo).max()) or 1.0
    if peak > audio_studio._db(-1.0):
        stereo *= audio_studio._db(-1.0) / peak
    return stereo


def sing_song(row, chart, speech, transpose, progress=None):
    """{line index: (speech audio, syllable spans)} → (the dry mono sung
    track at SR, per-syllable timing)."""
    rng = np.random.default_rng(int(row['id']) * 7919 + transpose)
    duration = row['duration_seconds'] or songs.chart_stats(chart)['end'] + 2
    n_total = int((duration + 1.0) * SR)
    track = np.zeros(n_total, np.float32)
    timing = []
    items = sorted(speech.items())
    with concurrent.futures.ThreadPoolExecutor(min(4, len(items)) or 1) as pool:
        futs = {pool.submit(sing_line, x, chart['lines'][li], transpose,
                            np.random.default_rng(int(rng.integers(1 << 30))), spans): li
                for li, (x, spans) in items}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            li = futs[fut]
            res = fut.result()
            done += 1
            if progress:
                progress('sing', done, len(futs))
            if not res:
                continue
            y, t0, tim = res
            s = int(t0 * SR)
            e = min(n_total, s + len(y))
            if e > s:
                track[s:e] += y[:e - s]
            for item in tim:
                item['line'] = li
            timing.extend(tim)
    timing.sort(key=lambda r: r['t0'])
    return track, timing


def _envelope(stereo, rate=SR):
    """Vocal level at ENV_FPS as 0–255 ints: the stage's mouth opening."""
    mono = np.abs(stereo).mean(axis=0)
    hop = rate // ENV_FPS
    m = len(mono) // hop
    if not m:
        return []
    rms = np.sqrt((mono[:m * hop].reshape(m, hop) ** 2).mean(axis=1))
    db = 20 * np.log10(rms + 1e-9)
    loud = db[db > db.max() - 60]
    top = np.percentile(loud, 95) if len(loud) else db.max()
    lvl = np.clip((db - (top - 30)) / 30, 0, 1)
    return [int(v * 255) for v in lvl]


def _vocal_chain(mono, rate=SR):
    """Mono sung track → stereo with the studio's hall reverb (its 24 kHz
    impulse resampled to the track's rate)."""
    stereo = np.stack([mono, mono]) * math.sqrt(0.5)
    ir = audio_studio._reverb_ir()
    if rate != SR:
        import soxr
        ir = np.ascontiguousarray(soxr.resample(ir.T, SR, rate).T, dtype=np.float32)
        ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True)) + 1e-12
    n = stereo.shape[1]
    wet = np.zeros((2, n + ir.shape[1]), np.float32)
    block = rate * 20
    nfft = 1 << (block + ir.shape[1] - 1).bit_length()
    IR = np.fft.rfft(ir, nfft, axis=1)
    for a in range(0, n, block):
        seg = stereo[0, a:a + block]
        y = np.fft.irfft(np.fft.rfft(seg, nfft)[None, :] * IR, nfft, axis=1)[:, :len(seg) + ir.shape[1]]
        wet[:, a:a + y.shape[1]] += y
    return (stereo + wet[:, :n] * audio_studio._db(REVERB_WET_DB)).astype(np.float32)
