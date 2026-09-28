# Copyright 2026 Codemarchant
"""Backing tracks for companion-written songs, synthesised from the song
sheet's chords (song_sheet.py) in one of a few styles.

Everything is plain numpy additive / subtractive / physical-model synthesis
at 44.1 kHz, so it needs no samples and no licences:

  piano      additive partials with string inharmonicity f_n = n·f·√(1+Bn²)
             (Fletcher 1962; B ≈ 0.0004 in the piano's mid range) and
             faster decay for higher partials
  e-piano    two-operator FM (Chowning 1973), 1:1 carrier/modulator with a
             decaying index, plus a 14:1 "tine" partial for the bell attack
  pluck      Karplus-Strong plucked string (Karplus & Strong 1983)
  supersaw   seven detuned band-limited saws (the JP-8000 "supersaw")
  bass       a sine plus a filtered saw
  drums      synthesised kick (a sine swept down), snare (tone + noise),
             hats (high-passed noise), shaker; the lo-fi style adds vinyl
             crackle

Levels, patterns and envelopes are design choices, not measurements.
Voicings follow the chords with the smallest total movement between them
(voice leading), the way a keyboard player would voice them.

The arrangement follows the song: drums wait for the first sung phrase,
and bars where the melody sits high and busy (the chorus, usually) get
the full band while the others thin out, so the dance director has real
dynamics to react to.
"""
import math

import numpy as np

SR = 44100
TARGET_LUFS = -14.0           # Spotify / YouTube loudness normalisation target

STYLES = {
    'pop': 'bright modern pop: backbeat drums, eighth-note bass, piano chords and a plucked arpeggio',
    'ballad': 'slow and tender: arpeggiated piano, warm pad, soft kick and rim clicks',
    'lofi': 'lo-fi hip-hop: swung drums, electric-piano seventh chords, vinyl crackle, a muffled top end',
    'synthwave': 'retro 80s synthwave: four-on-the-floor kick, pumping supersaw pads, sixteenth-note bass',
    'acoustic': 'acoustic campfire: strummed guitar, shaker and a soft upright-style bass',
}


def _t(n):
    return np.arange(n) / SR


def _env(n, attack, release, total=None, decay=None):
    """Linear attack, optional exponential decay, linear release at the end."""
    e = np.ones(n)
    a = min(n, max(1, int(attack * SR)))
    e[:a] = np.linspace(0, 1, a)
    if decay:
        e *= np.exp(-_t(n) / decay)
    r = min(n, max(1, int(release * SR)))
    e[-r:] *= np.linspace(1, 0, r)
    return e


def _hz(midi):
    return 440.0 * 2 ** ((np.asarray(midi, float) - 69) / 12)


def _saw(freq, n, phase=0.0):
    """Band-limited saw via PolyBLEP."""
    dt = freq / SR
    ph = (phase + dt * np.arange(n)) % 1.0
    y = 2 * ph - 1
    # PolyBLEP correction around the wrap.
    m1 = ph < dt
    t1 = ph[m1] / dt
    y[m1] -= t1 + t1 - t1 * t1 - 1
    m2 = ph > 1 - dt
    t2 = (ph[m2] - 1) / dt
    y[m2] -= t2 * t2 + t2 + t2 + 1
    return y


def _onepole_lp(x, cutoff):
    a = math.exp(-2 * math.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def _fft_lp(x, cutoff, order=2):
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    return np.fft.irfft(np.fft.rfft(x) / np.sqrt(1 + (f / cutoff) ** (2 * order)), n)


def _fft_hp(x, cutoff, order=2):
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    r = (f / cutoff) ** (2 * order)
    return np.fft.irfft(np.fft.rfft(x) * np.sqrt(r / (1 + r)), n)


# ---------------------------------------------------------------------------
# Instruments: (midi, seconds, velocity 0..1) → mono float
# ---------------------------------------------------------------------------

def piano(midi, dur, vel=0.8):
    f = float(_hz(midi))
    ring = min(dur + 0.6, 4.0)
    n = int(ring * SR)
    t = _t(n)
    y = np.zeros(n)
    B = 0.0004
    for k in range(1, 11):
        fk = k * f * math.sqrt(1 + B * k * k)
        if fk > SR / 2 - 500:
            break
        amp = 1.0 / k ** 1.3
        decay = 1.6 / (1 + 0.45 * (k - 1)) * (1.0 if f < 400 else 400 / f + 0.3)
        y += amp * np.sin(2 * math.pi * fk * t + k) * np.exp(-t / decay)
    # key release: damp fast after the note ends
    off = int(dur * SR)
    if off < n:
        y[off:] *= np.exp(-(t[off:] - t[off]) / 0.12)
    y *= _env(n, 0.004, 0.02)
    return y * vel * 0.28


def epiano(midi, dur, vel=0.8):
    f = float(_hz(midi))
    n = int((dur + 0.5) * SR)
    t = _t(n)
    index = 2.2 * vel * np.exp(-t / 0.45) + 0.4
    mod = np.sin(2 * math.pi * f * t) * index
    y = np.sin(2 * math.pi * f * t + mod) * np.exp(-t / 2.2)
    y += 0.25 * vel * np.sin(2 * math.pi * 14 * f * t) * np.exp(-t / 0.06)   # tine
    trem = 1 + 0.12 * np.sin(2 * math.pi * 4.5 * t)
    off = int(dur * SR)
    if off < n:
        y[off:] *= np.exp(-(t[off:] - t[off]) / 0.15)
    return y * trem * _env(n, 0.003, 0.03) * vel * 0.22


def pluck(midi, dur, vel=0.8, bright=0.5):
    """Karplus-Strong: a noise burst recirculating through a delay line
    with a two-point average (the string's loss)."""
    f = float(_hz(midi))
    n = int((dur + 0.4) * SR)
    period = SR / f
    p = int(period)
    frac = period - p
    rng = np.random.default_rng(int(midi * 1000 + dur * 10))
    buf = rng.uniform(-1, 1, p + 2)
    if bright < 1:
        buf = _onepole_lp(buf, 800 + 6000 * bright)
    out = np.zeros(n)
    out[:len(buf)] = buf[:n]
    decay = 0.996
    # y[i] only reads samples at least p back, so a whole period at a time
    # can be computed from the one before it.
    i = p + 2
    while i < n:
        j = min(n, i + p)
        k = np.arange(i, j)
        a, b, c = out[k - p], out[k - p - 1], out[k - p - 2]
        out[i:j] = decay * ((1 - frac) * 0.5 * (a + b) + frac * 0.5 * (b + c))
        i = j
    off = int(dur * SR)
    if off < n:
        out[off:] *= np.exp(-_t(n - off) / 0.08)
    return out * _env(n, 0.001, 0.02) * vel * 0.3


def supersaw(midi, dur, vel=0.7, cutoff=2600):
    f = float(_hz(midi))
    n = int((dur + 0.7) * SR)
    detunes = (-0.11, -0.063, -0.02, 0.0, 0.021, 0.064, 0.11)   # semitones
    rng = np.random.default_rng(int(midi))
    y = np.zeros(n)
    for d in detunes:
        w = 1.0 if d == 0 else 0.6
        y += w * _saw(f * 2 ** (d / 12), n, rng.uniform())
    y = _fft_lp(y, cutoff)
    return y * _env(n, 0.25, 0.6) * vel * 0.05


def bass(midi, dur, vel=0.8, cutoff=700):
    f = float(_hz(midi))
    n = int((dur + 0.08) * SR)
    t = _t(n)
    y = np.sin(2 * math.pi * f * t) + 0.35 * _fft_lp(_saw(f, n), cutoff)
    return y * _env(n, 0.006, 0.06) * vel * 0.34


def kick(vel=1.0, soft=False):
    n = int(0.45 * SR)
    t = _t(n)
    fq = 48 + 110 * np.exp(-t / 0.035)
    ph = 2 * math.pi * np.cumsum(fq) / SR
    y = np.sin(ph) * np.exp(-t / (0.16 if soft else 0.22))
    click = np.random.default_rng(1).standard_normal(n) * np.exp(-t / 0.004) * 0.3
    return (y + (0 if soft else click)) * vel * 0.9


def snare(vel=1.0, rim=False):
    n = int(0.3 * SR)
    t = _t(n)
    if rim:
        y = np.sin(2 * math.pi * 1700 * t) * np.exp(-t / 0.01)
        y += np.random.default_rng(2).standard_normal(n) * np.exp(-t / 0.008) * 0.4
        return y * vel * 0.35
    tone = (np.sin(2 * math.pi * 185 * t) + 0.5 * np.sin(2 * math.pi * 330 * t)) * np.exp(-t / 0.05)
    noise = _fft_hp(np.random.default_rng(3).standard_normal(n), 1200) * np.exp(-t / 0.09)
    return (0.6 * tone + 0.8 * noise) * vel * 0.45


def hat(vel=1.0, open_=False):
    n = int((0.35 if open_ else 0.06) * SR)
    t = _t(n)
    y = _fft_hp(np.random.default_rng(4 + open_).standard_normal(n), 7000)
    return y * np.exp(-t / (0.12 if open_ else 0.018)) * vel * 0.16


def shaker(vel=1.0):
    n = int(0.09 * SR)
    t = _t(n)
    y = _fft_hp(np.random.default_rng(5).standard_normal(n), 5000)
    env = np.minimum(t / 0.02, 1) * np.exp(-t / 0.03)
    return y * env * vel * 0.12


# ---------------------------------------------------------------------------
# Harmony helpers
# ---------------------------------------------------------------------------

def _voicing(chord, prev, lo=52, hi=76, size=4):
    """Chord → MIDI notes in [lo, hi], nearest to the previous voicing."""
    root = chord['root']
    ivs = list(chord['intervals'])[:size]
    pcs = [(root + i) % 12 for i in ivs]
    best, best_cost = None, None
    for base in range(lo - 12, hi):
        if base % 12 != pcs[0] % 12:
            continue
        for inv in range(len(pcs)):
            order = pcs[inv:] + pcs[:inv]
            notes = []
            cur = base - 12
            for pc in order:
                cur = cur + ((pc - cur) % 12 or (12 if notes else 0))
                notes.append(cur)
            if notes[0] < lo or notes[-1] > hi:
                continue
            cost = sum(min(abs(a - b) for b in prev) for a in notes) if prev else abs(np.mean(notes) - 64)
            if best_cost is None or cost < best_cost:
                best, best_cost = notes, cost
    return best or [60 + (root + i) % 12 for i in ivs]


def _bass_note(chord, lo=33):
    b = chord['bass']
    return lo + ((b - lo) % 12)


def _chord_at(chords, t, default):
    cur = default
    for c in chords:
        if c['t'] <= t + 1e-6:
            cur = c
        else:
            break
    return cur


# ---------------------------------------------------------------------------
# Arrangement
# ---------------------------------------------------------------------------

def _bar_energy(sheet):
    """0..1 per bar from the melody: mean pitch and note density (both
    z-scored), so chorus-like bars read as the loud ones."""
    bars = sheet['grid']['downbeats'] + [sheet['duration']]
    notes = [n for ln in sheet['chart']['lines'] for n in ln['notes']]
    vals = []
    for a, b in zip(bars[:-1], bars[1:]):
        inside = [n for n in notes if a <= n['t'] < b]
        if not inside:
            vals.append(None)
            continue
        vals.append((np.mean([n['p'] for n in inside]), len(inside) / max(b - a, 1e-3)))
    sung = [v for v in vals if v]
    if not sung:
        return [0.5] * (len(bars) - 1)
    p = np.array([v[0] for v in sung])
    d = np.array([v[1] for v in sung])
    z = lambda x, v: (v - x.mean()) / (x.std() or 1)
    out = []
    for v in vals:
        if v is None:
            out.append(None)
        else:
            out.append(float(np.clip(0.5 + 0.25 * (z(p, v[0]) + 0.5 * z(d, v[1])), 0.1, 1.0)))
    # Instrumental bars take their neighbours' level (intro rises into it).
    for i in range(len(out)):
        if out[i] is None:
            nxt = next((x for x in out[i:] if x is not None), 0.5)
            prv = next((x for x in reversed(out[:i]) if x is not None), None)
            out[i] = 0.35 if prv is None else min(prv, nxt)
    return out


def render(sheet, style='pop', seed=0):
    """Song sheet (song_sheet.parse output) → (stereo float32 (2, n) at SR,
    per-beat energy list)."""
    style = style if style in STYLES else 'pop'
    grid = sheet['grid']
    beat = grid['beat']
    bpb = grid['beats_per_bar']
    compound = abs(beat * 3 / 8 - beat / 3 * 3 / 8) and sheet['meter'].strip().endswith('/8') and bpb in (2, 3, 4)
    sub = 3 if compound else 2                        # subdivisions per beat
    total = sheet['duration'] + 2.5 * beat + 1.5      # ring-out tail
    n = int(total * SR)
    L = np.zeros(n)
    R = np.zeros(n)
    rng = np.random.default_rng(seed)
    chords = sheet['chords']
    tonic = sheet['key']['tonic']
    default_chord = {'root': tonic, 'intervals': (0, 3, 7) if sheet['key']['minor'] else (0, 4, 7),
                     'bass': tonic, 'symbol': ''}
    first_vocal = min(ln['start'] for ln in sheet['chart']['lines'])
    energy = _bar_energy(sheet)
    downbeats = grid['downbeats']

    def add(sig, t, pan=0.0, gain=1.0):
        s = int(round(t * SR))
        if s >= n or s + len(sig) <= 0:
            return
        a = max(0, -s)
        sig = sig[a:]
        s += a
        e = min(n, s + len(sig))
        lg = math.cos((pan + 1) * math.pi / 4) * math.sqrt(2)
        rg = math.sin((pan + 1) * math.pi / 4) * math.sqrt(2)
        L[s:e] += sig[:e - s] * gain * lg
        R[s:e] += sig[:e - s] * gain * rg

    def bar_index(t):
        i = 0
        for k, d in enumerate(downbeats):
            if d <= t + 1e-6:
                i = k
        return min(i, len(energy) - 1)

    swing = 0.62 if style == 'lofi' else 0.5          # lo-fi: eighths swung ~62:38
    step = beat / sub
    n_beats = int(round(sheet['duration'] / beat))
    prev_voicing = None
    last_chord = None
    for bi in range(n_beats + 1):
        tb = bi * beat
        if tb > sheet['duration'] + 1e-6:
            break
        bar = bar_index(tb)
        e = energy[bar] if energy else 0.5
        in_bar = bi % bpb
        chord = _chord_at(chords, tb, default_chord)
        changed = chord is not last_chord
        if changed:
            prev_voicing = _voicing(chord, prev_voicing)
            last_chord = chord
        voicing = prev_voicing
        drums_on = tb >= first_vocal - bpb * beat - 1e-6
        full = e >= 0.55
        is_last = bi >= n_beats - 1

        for si in range(sub):
            ts = tb + si * step
            if sub == 2 and si == 1:
                ts = tb + beat * swing
            vel_j = 1 + rng.uniform(-0.06, 0.06)          # humanise velocities
            if style == 'pop':
                if drums_on:
                    if si == 0 and in_bar in (0, 2 % bpb) or (si == 1 and in_bar == 1 and full):
                        add(kick(vel_j), ts)
                    if si == 0 and in_bar % 2 == 1:
                        add(snare(0.9 * vel_j), ts, 0.05)
                    add(hat((0.8 if si else 1.0) * vel_j * (1 if full else 0.7)), ts, 0.3)
                add(bass(_bass_note(chord), step * 0.9, 0.85 * vel_j), ts)
                if si == 0 and (in_bar % 2 == 1 or changed):
                    for k, m in enumerate(voicing):
                        add(piano(m, beat * 0.9, 0.55 * vel_j), ts + 0.006 * k, -0.2)
                if full or tb >= first_vocal:
                    arp = voicing[(bi * sub + si) % len(voicing)] + 12
                    add(pluck(arp, step * 1.5, 0.5 * vel_j, 0.7), ts, 0.45)
            elif style == 'ballad':
                if drums_on and si == 0:
                    if in_bar == 0:
                        add(kick(0.6 * vel_j, soft=True), ts)
                    if in_bar == bpb // 2 and bpb > 2:
                        add(snare(0.6 * vel_j, rim=True), ts, 0.1)
                # arpeggio up and back down the voicing, one note per subdivision
                seq = voicing + voicing[-2:0:-1]
                m = seq[(in_bar * sub + si) % len(seq)]
                add(piano(m, step * 2.5, 0.6 * vel_j), ts, -0.15 + 0.1 * (m % 3))
                if si == 0 and in_bar == 0:
                    add(piano(_bass_note(chord, 36), beat * bpb, 0.7 * vel_j), ts, -0.1)
                if changed and si == 0:
                    for m in voicing:
                        add(supersaw(m, _chord_len(chords, chord, sheet['duration']), 0.35, 1400), ts, 0.0)
            elif style == 'lofi':
                if drums_on:
                    if si == 0 and in_bar == 0 or (si == 1 and in_bar == 2 % bpb):
                        add(_fft_lp(kick(0.9 * vel_j, soft=True), 2500), ts)
                    if si == 0 and in_bar % 2 == 1:
                        add(_fft_lp(snare(0.7 * vel_j), 5000), ts, 0.05)
                    add(_fft_lp(hat(0.7 * vel_j), 9000), ts, 0.25)
                if si == 0 and in_bar == 0 or changed and si == 0:
                    for k, m in enumerate(voicing):
                        add(epiano(m, _chord_len(chords, chord, sheet['duration']), 0.7 * vel_j), ts + 0.012 * k, -0.2 + 0.13 * k)
                    add(bass(_bass_note(chord, 33), beat * 1.8, 0.8, 400), ts)
                elif si == 0 and in_bar == 2 % bpb:
                    add(bass(_bass_note(chord, 33) + 7, beat * 0.8, 0.6, 400), ts)
            elif style == 'synthwave':
                if drums_on:
                    if si == 0:
                        add(kick(vel_j), ts)
                    if si == 0 and in_bar % 2 == 1:
                        add(snare(vel_j), ts, 0.0)
                    add(hat(0.7 * vel_j, open_=(si == 1 and full)), ts, 0.3)
                # sixteenth bass: root, root, octave, root
                for q in range(2):
                    tq = ts + q * step / 2
                    note = _bass_note(chord, 33) + (12 if (si * 2 + q) % 4 == 2 else 0)
                    add(bass(note, step / 2 * 0.8, 0.75 * vel_j, 1100), tq)
                if changed and si == 0:
                    for m in voicing:
                        add(supersaw(m, _chord_len(chords, chord, sheet['duration']), 0.7, 3000 if full else 1800), ts, 0.0)
                if full:
                    arp = voicing[(bi * sub + si) % len(voicing)] + 12
                    add(pluck(arp, step, 0.4, 0.9), ts, -0.5)
            else:  # acoustic
                pattern = [1, 0, 1, 1, 0, 1, 1, 1][((in_bar * sub + si) % 8)] if sub == 2 else 1
                if pattern:
                    down = (si == 0)
                    order = voicing if down else voicing[::-1]
                    for k, m in enumerate(order):
                        add(pluck(m - 12 if k == 0 and down else m, step * 1.8,
                                  (0.7 if down else 0.45) * vel_j, 0.45), ts + 0.011 * k, -0.25 + 0.12 * k)
                if drums_on:
                    add(shaker(vel_j * (1 if si else 0.7)), ts, 0.4)
                    if si == 0 and in_bar == 0:
                        add(kick(0.5, soft=True), ts)
                if si == 0 and in_bar in (0, bpb // 2):
                    add(bass(_bass_note(chord, 33) + (7 if in_bar else 0), beat * 1.5, 0.7, 500), ts)
        if is_last:
            # Final chord rings out.
            for m in voicing:
                inst = epiano if style == 'lofi' else (pluck if style == 'acoustic' else piano)
                add(inst(m, 2.5 * beat, 0.6), tb + beat, 0.0)
            break

    if style == 'lofi':
        # Vinyl crackle: sparse clicks over a quiet hiss (design).
        crackle = np.zeros(n)
        idx = rng.integers(0, n, int(total * 6))
        crackle[idx] = rng.uniform(-1, 1, len(idx))
        crackle = _fft_hp(crackle, 1500) * 0.08 + rng.standard_normal(n) * 0.0015
        L += crackle
        R += np.roll(crackle, 37)
        L, R = _fft_lp(L, 6500), _fft_lp(R, 6500)

    mix = np.stack([L, R])
    if style == 'synthwave':
        # Sidechain pump on everything but the kick: duck 6 dB on each beat.
        t = _t(n)
        phase = (t % beat) / beat
        mix *= (1 - 0.5 * np.exp(-phase * beat / 0.12))[None, :]
    mix = _reverb(mix, 0.12 if style in ('pop', 'lofi') else 0.2)
    mix = np.tanh(mix * 1.2) / 1.2            # gentle soft clip on the bus
    mix = _normalise(mix)
    beat_energy = []
    for bi in range(int(sheet['duration'] / beat) + 1):
        beat_energy.append(round(energy[bar_index(bi * beat)], 3) if energy else 0.5)
    return mix.astype(np.float32), beat_energy


def _chord_len(chords, chord, end):
    for i, c in enumerate(chords):
        if c is chord:
            return c.get('d') or (end - c['t'])
    return 2.0


def _reverb(stereo, wet):
    rng = np.random.default_rng(7)
    ln = int(1.8 * SR)
    t = _t(ln)
    ir = rng.standard_normal((2, ln)) * np.exp(-6.91 * t / 1.8)
    ir = np.stack([_fft_lp(ir[0], 5000), _fft_lp(ir[1], 5000)])
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    n = stereo.shape[1]
    nfft = 1 << (n + ln - 1).bit_length()
    mono = np.fft.rfft(stereo.mean(axis=0), nfft)
    wet_sig = np.fft.irfft(mono[None, :] * np.fft.rfft(ir, nfft, axis=1), nfft, axis=1)[:, :n]
    return stereo + wet * wet_sig


def _normalise(stereo):
    from . import songs
    lufs = songs.integrated_lufs(stereo.astype(np.float32), SR)
    if lufs is not None:
        stereo = stereo * 10 ** ((TARGET_LUFS - lufs) / 20)
    peak = np.abs(stereo).max()
    if peak > 10 ** (-1 / 20):
        stereo = stereo * (10 ** (-1 / 20) / peak)
    return stereo
