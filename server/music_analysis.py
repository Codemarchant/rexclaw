# Copyright 2026 Codemarchant
"""Beat, bar and energy analysis of a backing track, for the karaoke stage.

The dance director in the browser time-warps dance clips so their motion
beats land on the music's beats, changes clip on bar lines and picks how
hard to dance from the energy. This module produces that grid from the
audio alone (an imported song's own BPM tag is only a hint: UltraStar
files are often timed to a multiple of the real tempo).

Beats: Ellis 2007, "Beat Tracking by Dynamic Programming" (J. New Music
Research 36(1)), with librosa's defaults so the numbers mean what they mean
there: 22050 Hz, 2048-point FFT, hop 512, 128 mel bands, onset strength =
mean positive log-mel flux, tempo prior log-normal around 120 BPM with a
one-octave deviation, DP tightness 100.

Downbeats: Goto 2001 ("An audio-based real-time beat tracking system for
music with or without drum-sounds", J. New Music Research 30(2)) infers bar
position from chord changes (they fall on bar lines) and the pop drum
pattern (bass drum on beats 1 and 3, snare on 2 and 4). Both cues are
scored per candidate phase of a 4/4 bar here.
"""
import math

import numpy as np

AN_SR = 22050
N_FFT = 2048
HOP = 512
N_MELS = 128
START_BPM = 120.0
STD_BPM = 1.0          # octaves
TIGHTNESS = 100.0
AC_SIZE = 8.0          # seconds of onset envelope per tempogram window
MAX_TEMPO = 320.0
BEATS_PER_BAR = 4


def _mel_filters(sr, n_fft, n_mels, fmin=0.0, fmax=None):
    """Slaney-style mel filterbank (librosa's default, htk=False, norm=slaney)."""
    fmax = fmax or sr / 2

    def hz_to_mel(f):
        f = np.asarray(f, float)
        f_sp = 200.0 / 3
        mels = f / f_sp
        min_log_hz = 1000.0
        min_log_mel = min_log_hz / f_sp
        logstep = math.log(6.4) / 27.0
        return np.where(f >= min_log_hz, min_log_mel + np.log(np.maximum(f, 1e-9) / min_log_hz) / logstep, mels)

    def mel_to_hz(m):
        m = np.asarray(m, float)
        f_sp = 200.0 / 3
        freqs = f_sp * m
        min_log_hz = 1000.0
        min_log_mel = min_log_hz / f_sp
        logstep = math.log(6.4) / 27.0
        return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), freqs)

    fft_freqs = np.linspace(0, sr / 2, n_fft // 2 + 1)
    mel_f = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = mel_f[:, None] - fft_freqs[None, :]
    weights = np.zeros((n_mels, len(fft_freqs)))
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    weights *= (2.0 / (mel_f[2:n_mels + 2] - mel_f[:n_mels]))[:, None]
    return weights, mel_f


def _stft_power(y):
    """|STFT|² with centred Hann frames → (freq, frames)."""
    pad = N_FFT // 2
    y = np.pad(y, pad, mode='reflect') if len(y) > pad else np.pad(y, pad)
    n = 1 + (len(y) - N_FFT) // HOP
    win = np.hanning(N_FFT + 1)[:-1].astype(np.float32)
    out = np.empty((N_FFT // 2 + 1, n), np.float32)
    step = 2048  # frames per batch keeps memory flat on long songs
    for a in range(0, n, step):
        b = min(n, a + step)
        idx = (np.arange(a, b) * HOP)[:, None] + np.arange(N_FFT)[None, :]
        frames = y[idx] * win
        out[:, a:b] = (np.abs(np.fft.rfft(frames, axis=1)) ** 2).T
    return out


def _power_to_db(S):
    """librosa.power_to_db(S, ref=1.0, top_db=80)."""
    log = 10.0 * np.log10(np.maximum(1e-10, S))
    return np.maximum(log, log.max() - 80.0)


def _onset_strength(S_db):
    """Mean positive first difference over bands."""
    flux = np.maximum(0.0, S_db[:, 1:] - S_db[:, :-1]).mean(axis=0)
    # librosa pads lag + n_fft // (2 * hop) = 3 frames at the front. On a
    # synthetic drum track with known onsets that put every beat 24 ms late;
    # a 2-frame pad lands them within ~2 ms.
    pad = 2
    env = np.concatenate([np.zeros(pad), flux])
    return env[:S_db.shape[1]]


def _tempo(onset_env):
    """Global tempo: windowed autocorrelation × log-normal prior."""
    fps = AN_SR / HOP
    win = int(round(AC_SIZE * fps))
    n = len(onset_env)
    if n < 8:
        return START_BPM
    # Autocorrelation of the whole envelope in overlapping windows, averaged.
    acs = []
    for a in range(0, max(1, n - win + 1), max(1, win // 4)):
        seg = onset_env[a:a + win]
        seg = seg - seg.mean()
        spec = np.fft.rfft(seg, 2 * len(seg))
        ac = np.fft.irfft(np.abs(spec) ** 2)[:len(seg)]
        if ac[0] > 0:
            acs.append(ac / ac[0])
    if not acs:
        return START_BPM
    L = min(len(a) for a in acs)
    ac = np.mean([a[:L] for a in acs], axis=0)
    lags = np.arange(1, L)
    bpms = 60.0 * fps / lags
    prior = np.exp(-0.5 * ((np.log2(bpms) - math.log2(START_BPM)) / STD_BPM) ** 2)
    prior[bpms > MAX_TEMPO] = 0
    score = ac[1:] * prior
    best = int(np.argmax(score))
    return float(bpms[best])


def _dp_beats(onset_env, bpm):
    """Ellis's dynamic program over the onset envelope → beat frame indices."""
    fps = AN_SR / HOP
    period = fps * 60.0 / bpm
    std = onset_env.std(ddof=1) if len(onset_env) > 1 else 1.0
    onset = onset_env / (std or 1.0)
    # Local score: onsets smoothed with a Gaussian of ~1/32 of the period.
    k = np.arange(-int(period), int(period) + 1)
    window = np.exp(-0.5 * (k * 32.0 / period) ** 2)
    local = np.convolve(onset, window, 'same')
    n = len(local)
    backlink = np.full(n, -1, int)
    cum = np.zeros(n)
    lo, hi = int(round(-2 * period)), -int(round(period / 2))
    offs = np.arange(lo, hi + 1)
    txwt = -TIGHTNESS * np.log(-offs / period) ** 2
    first = True
    for i in range(n):
        z = i + offs
        valid = z >= 0
        if not valid.any():
            cum[i] = local[i]
            continue
        cand = np.where(valid, cum[np.clip(z, 0, n - 1)] + txwt, -np.inf)
        j = int(np.argmax(cand))
        cum[i] = local[i] + cand[j]
        # The first beats get no predecessor (librosa: while the local score
        # is still below 1% of the max so far, start fresh).
        if first and local[i] < 0.01 * local.max():
            backlink[i] = -1
        else:
            backlink[i] = z[j]
            first = False
    # Last beat: the last local maximum of cum above half the median of them.
    peaks = np.flatnonzero((cum[1:-1] > cum[:-2]) & (cum[1:-1] >= cum[2:])) + 1
    if not len(peaks):
        return np.array([], int), local
    med = np.median(cum[peaks])
    good = peaks[cum[peaks] >= 0.5 * med]
    tail = int(good[-1]) if len(good) else int(peaks[-1])
    beats = [tail]
    while backlink[beats[-1]] >= 0:
        beats.append(int(backlink[beats[-1]]))
    beats = np.array(beats[::-1], int)
    # Trim weak leading/trailing beats (librosa __trim_beats).
    smooth = np.convolve(local[beats], np.hanning(5), 'same')
    thr = 0.5 * math.sqrt(float(np.mean(smooth ** 2))) if len(smooth) else 0
    keep = np.flatnonzero(smooth >= thr)
    if len(keep):
        beats = beats[keep[0]:keep[-1] + 1]
    return beats, local


def _smooth_times(times, half=4):
    """Beats sit on 23 ms analysis frames; a line fitted through each beat's
    ±4 neighbours takes out that quantisation while still following a
    drifting tempo."""
    n = len(times)
    if n < 3:
        return times
    out = np.empty(n)
    idx = np.arange(n, dtype=float)
    for i in range(n):
        a, b = max(0, i - half), min(n, i + half + 1)
        slope, icpt = np.polyfit(idx[a:b], times[a:b], 1)
        out[i] = slope * i + icpt
    return out


def _band_flux(S, freqs, lo, hi):
    band = (freqs >= lo) & (freqs < hi)
    e = np.log1p(S[band].sum(axis=0))
    return np.concatenate([[0.0], np.maximum(0.0, np.diff(e))])


def _chroma(S, freqs):
    """12-bin pitch-class energy per frame (bins 60 Hz–5 kHz)."""
    ok = (freqs > 60) & (freqs < 5000)
    pc = np.round(12 * np.log2(freqs[ok] / 440.0)).astype(int) % 12
    C = np.zeros((12, S.shape[1]))
    for k in range(12):
        C[k] = S[ok][pc == k].sum(axis=0)
    return C / (C.sum(axis=0, keepdims=True) + 1e-9)


def _downbeat_phase(beats, S, freqs):
    """Which of the first BEATS_PER_BAR beats is a bar's first beat."""
    if len(beats) < 2 * BEATS_PER_BAR:
        return 0
    low = _band_flux(S, freqs, 30, 150)       # bass drum
    mid = _band_flux(S, freqs, 1000, 5000)    # snare crack
    chroma = _chroma(S, freqs)
    # Chord change: chroma distance between the halves either side of a beat.
    change = np.zeros(len(beats))
    for i in range(1, len(beats) - 1):
        a = chroma[:, beats[i - 1]:beats[i]].mean(axis=1)
        b = chroma[:, beats[i]:beats[i + 1]].mean(axis=1)
        change[i] = float(np.abs(a - b).sum())

    def at(env, i):
        f = beats[i]
        return float(env[max(0, f - 2):f + 3].max())

    lows = np.array([at(low, i) for i in range(len(beats))])
    mids = np.array([at(mid, i) for i in range(len(beats))])

    def norm(v):
        s = v.std()
        return (v - v.mean()) / s if s > 0 else v * 0

    lows, mids, change = norm(lows), norm(mids), norm(change)
    best, best_score = 0, -np.inf
    for phase in range(BEATS_PER_BAR):
        one = np.arange(phase, len(beats), BEATS_PER_BAR)
        three = one + 2
        three = three[three < len(beats)]
        two = one + 1
        two = two[two < len(beats)]
        four = one + 3
        four = four[four < len(beats)]
        score = (lows[one].mean() + lows[three].mean() - mids[one].mean() - mids[three].mean()
                 + mids[two].mean() + mids[four].mean() + 2.0 * change[one].mean())
        if score > best_score:
            best, best_score = phase, score
    return best


def analyze(stereo, sr):
    """stereo/mono float array at `sr` → the dance grid.

    Returns {'bpm', 'beats': [s…], 'downbeats': [s…], 'energy': [0..1 per
    beat], 'duration'}. Energy is each beat's loudness ranked within the
    song (10th→90th percentile maps to 0→1), so a quiet ballad's chorus
    still reads as its loud part."""
    import soxr
    mono = np.asarray(stereo, np.float32)
    if mono.ndim == 2:
        mono = mono.mean(axis=0 if mono.shape[0] <= 2 else 1)
    duration = len(mono) / sr
    y = soxr.resample(mono, sr, AN_SR).astype(np.float32) if sr != AN_SR else mono
    S = _stft_power(y)
    mel, _ = _mel_filters(AN_SR, N_FFT, N_MELS)
    S_db = _power_to_db(mel @ S)
    onset = _onset_strength(S_db)
    bpm = _tempo(onset)
    beats, _local = _dp_beats(onset, bpm)
    fps = AN_SR / HOP
    freqs = np.linspace(0, AN_SR / 2, N_FFT // 2 + 1)
    phase = _downbeat_phase(beats, S, freqs)
    times = _smooth_times(beats / fps)
    # Loudness per beat span.
    rms = np.sqrt(S.sum(axis=0) + 1e-12)
    energy = []
    for i, f in enumerate(beats):
        g = beats[i + 1] if i + 1 < len(beats) else min(len(rms), f + int(60 / bpm * fps))
        energy.append(20 * math.log10(float(rms[f:max(g, f + 1)].mean()) + 1e-9))
    energy = np.array(energy)
    if len(energy):
        lo, hi = np.percentile(energy, 10), np.percentile(energy, 90)
        energy = np.clip((energy - lo) / max(hi - lo, 1e-6), 0, 1)
    if len(times) > 1:
        bpm = 60.0 / float(np.median(np.diff(times)))
    return {
        'bpm': round(bpm, 2),
        'beats': [round(float(t), 3) for t in times],
        'downbeats': [round(float(t), 3) for t in times[phase::BEATS_PER_BAR]],
        'energy': [round(float(e), 3) for e in energy],
        'duration': round(duration, 3),
    }


def grid(bpm, duration, offset=0.0, beats_per_bar=BEATS_PER_BAR, energy=None):
    """A known tempo (a generated backing) → the same shape as analyze()."""
    period = 60.0 / bpm
    n = int((duration - offset) / period) + 1
    beats = [round(offset + i * period, 3) for i in range(max(0, n))]
    return {
        'bpm': round(bpm, 2),
        'beats': beats,
        'downbeats': beats[::beats_per_bar],
        'energy': [round(float(e), 3) for e in (energy or [0.6] * len(beats))][:len(beats)],
        'duration': round(duration, 3),
    }
