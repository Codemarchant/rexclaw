# Copyright 2026 Codemarchant
#
# The log-mel feature code below is ported from Pipecat
# (src/pipecat/audio/turn/smart_turn/_whisper_features.py):
#
#   Copyright (c) 2024-2026, Daily
#   SPDX-License-Identifier: BSD 2-Clause License
#
#   Portions derived from Hugging Face Transformers
#   (src/transformers/models/whisper/feature_extraction_whisper.py and
#   src/transformers/audio_utils.py):
#     Copyright 2022 The HuggingFace Inc. team.
#     Copyright 2023 The HuggingFace Inc. team and the librosa & torchaudio authors.
#     Licensed under the Apache License, Version 2.0
#     (https://www.apache.org/licenses/LICENSE-2.0). Modified by Daily.
"""Smart Turn v3.2 (Pipecat, BSD-2, assets/models/smart-turn-v3.2-cpu.onnx):
has the speaker finished their thought, or only paused?

Silence alone can't tell "I went to the shop and…" from "I went to the
shop." — the model hears intonation and phrasing (23 languages, Japanese
included) and answers in ~10–100 ms on a CPU. It reads the last 8 s of the
turn as Whisper-style log-mel features, computed here in numpy so the app
needs neither `transformers` nor `torch`.
"""
import threading

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from ..db import ASSETS_DIR

MODEL_PATH = ASSETS_DIR / 'models' / 'smart-turn-v3.2-cpu.onnx'

_N_FFT = 400
_HOP_LENGTH = 160
_N_MELS = 80
_SAMPLING_RATE = 16000
_WINDOW_S = 8
_MEL_FLOOR = 1e-10
_NORM_VARIANCE_EPS = 1e-7


def _hertz_to_mel_slaney(freq):
    min_log_hertz, min_log_mel = 1000.0, 15.0
    logstep = 27.0 / np.log(6.4)
    freq = np.atleast_1d(np.asarray(freq, dtype=np.float64))
    mels = 3.0 * freq / 200.0
    log_region = freq >= min_log_hertz
    mels[log_region] = min_log_mel + np.log(freq[log_region] / min_log_hertz) * logstep
    return mels


def _mel_to_hertz_slaney(mels):
    min_log_hertz, min_log_mel = 1000.0, 15.0
    logstep = np.log(6.4) / 27.0
    mels = np.atleast_1d(np.asarray(mels, dtype=np.float64))
    freq = 200.0 * mels / 3.0
    log_region = mels >= min_log_mel
    freq[log_region] = min_log_hertz * np.exp(logstep * (mels[log_region] - min_log_mel))
    return freq


def _mel_filterbank():
    """Slaney-normalised triangular filters, (n_fft/2 + 1, n_mels)."""
    mel_min = float(_hertz_to_mel_slaney(0.0)[0])
    mel_max = float(_hertz_to_mel_slaney(_SAMPLING_RATE / 2.0)[0])
    filter_freqs = _mel_to_hertz_slaney(np.linspace(mel_min, mel_max, _N_MELS + 2))
    fft_freqs = np.linspace(0, _SAMPLING_RATE // 2, _N_FFT // 2 + 1)
    filter_diff = np.diff(filter_freqs)
    slopes = np.expand_dims(filter_freqs, 0) - np.expand_dims(fft_freqs, 1)
    down_slopes = -slopes[:, :-2] / filter_diff[:-1]
    up_slopes = slopes[:, 2:] / filter_diff[1:]
    filters = np.maximum(np.zeros(1), np.minimum(down_slopes, up_slopes))
    enorm = 2.0 / (filter_freqs[2:_N_MELS + 2] - filter_freqs[:_N_MELS])
    return filters * np.expand_dims(enorm, 0)


_HANN_WINDOW = np.hanning(_N_FFT + 1)[:-1]   # periodic, as torch.hann_window
_MEL_FILTERS = _mel_filterbank()


def log_mel_features(audio):
    """transformers.WhisperFeatureExtractor(chunk_length=8) output for
    exactly 8 s of 16 kHz audio, do_normalize=True: float32 (80, 800)."""
    x = np.asarray(audio, dtype=np.float32)
    x = (x - x.mean()) / np.sqrt(x.var() + _NORM_VARIANCE_EPS)
    pad = _N_FFT // 2
    padded = np.pad(x.astype(np.float64), (pad, pad), mode='reflect')
    windows = sliding_window_view(padded, _N_FFT)[::_HOP_LENGTH]
    power = (np.abs(np.fft.rfft(windows * _HANN_WINDOW, axis=-1)) ** 2).T
    log_spec = np.log10(np.maximum(_MEL_FLOOR, _MEL_FILTERS.T @ power))[:, :-1]
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)


_session = None
_lock = threading.Lock()


def available():
    return MODEL_PATH.is_file()


def probability_complete(audio16k):
    """Probability (0–1) that the turn in `audio16k` is finished. The model
    sees the LAST 8 s, zero-padded at the start when shorter (Pipecat's
    truncate_audio_to_last_n_seconds). Blocking: call from a thread."""
    global _session
    with _lock:
        if _session is None:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            _session = ort.InferenceSession(str(MODEL_PATH), sess_options=opts,
                                            providers=['CPUExecutionProvider'])
    n = _SAMPLING_RATE * _WINDOW_S
    audio = np.asarray(audio16k, dtype=np.float32)[-n:]
    if audio.size < n:
        audio = np.pad(audio, (n - audio.size, 0))
    features = np.expand_dims(log_mel_features(audio), 0)
    return float(_session.run(None, {'input_features': features})[0][0].item())
