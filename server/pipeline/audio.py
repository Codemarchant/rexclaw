# Copyright 2026 Codemarchant
"""Audio plumbing for the voice pipeline: PCM conversions, resampling, and
the voice-activity turn detector that stands in for xAI's server VAD.

Silero VAD v6.2 (MIT, assets/models/silero_vad.onnx) scores each 32 ms
window of 16 kHz audio; TurnDetector turns those scores into the
speech_started / speech_stopped events the realtime protocol carries.
"""
import base64
import threading

import numpy as np
import soxr

from ..db import ASSETS_DIR

VAD_RATE = 16000
# Silero v5+ takes exactly 512 samples per call at 16 kHz, plus the last 64
# samples of the previous window as context (silero-vad's OnnxWrapper).
VAD_WINDOW = 512
VAD_CONTEXT = 64
WINDOW_MS = VAD_WINDOW * 1000 // VAD_RATE   # 32

SILERO_PATH = ASSETS_DIR / 'models' / 'silero_vad.onnx'

_session = None
_session_lock = threading.Lock()


def _silero():
    """One shared onnxruntime session: it is stateless (each caller carries
    its own recurrent state) and safe to call from several threads."""
    global _session
    with _session_lock:
        if _session is None:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            # A 32 ms window is a few hundred microseconds of work; extra
            # threads only add wake-up overhead (silero-vad's own default).
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            _session = ort.InferenceSession(str(SILERO_PATH), sess_options=opts,
                                            providers=['CPUExecutionProvider'])
        return _session


def pcm16_b64_to_float(b64):
    pcm = np.frombuffer(base64.b64decode(b64), dtype='<i2')
    return pcm.astype(np.float32) / 32768.0


def float_to_pcm16_b64(samples):
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype('<i2')
    return base64.b64encode(pcm.tobytes()).decode('ascii')


def float_to_wav_bytes(samples, rate):
    """Mono 16-bit WAV in memory — what every transcription API accepts."""
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(samples, -1.0, 1.0) * 32767.0).astype('<i2').tobytes())
    return buf.getvalue()


class Resampler:
    """Streaming resampler: chunk boundaries leave no clicks, unlike
    resampling each chunk on its own."""

    def __init__(self, in_rate, out_rate):
        self.in_rate, self.out_rate = int(in_rate), int(out_rate)
        self._stream = (None if self.in_rate == self.out_rate else
                        soxr.ResampleStream(self.in_rate, self.out_rate, 1, dtype='float32'))

    def __call__(self, samples, last=False):
        if self._stream is None:
            return samples.astype(np.float32, copy=False)
        return self._stream.resample_chunk(samples.astype(np.float32, copy=False), last=last)


class SileroVad:
    """Speech probability per 32 ms window, with its own recurrent state."""

    def __init__(self):
        self._model = _silero()
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, VAD_CONTEXT), dtype=np.float32)
        self._sr = np.array(VAD_RATE, dtype=np.int64)

    def __call__(self, window):
        x = np.concatenate([self._context, window.reshape(1, -1)], axis=1)
        out, self._state = self._model.run(None, {'input': x, 'state': self._state, 'sr': self._sr})
        self._context = x[:, -VAD_CONTEXT:]
        return float(out[0][0])


class TurnDetector:
    """Voice activity on Silero scores, as turn events. Defaults are
    Pipecat's (audio/vad/vad_analyzer.py VADParams: confidence 0.7,
    start_secs 0.2, stop_secs 0.2; audio/turn/smart_turn/base_smart_turn.py:
    PRE_SPEECH_MS 500, STOP_SECS 3):

    - a window at or over `threshold` counts as speech; `min_speech_ms` of
      it starts a turn, so a cough or a click never interrupts the
      companion;
    - a window under `threshold - 0.15` counts as silence (silero-vad's own
      neg_threshold hysteresis); `pause_ms` of it is a pause, the moment the
      caller decides whether the turn is over (Smart Turn, or at once);
    - speech after a pause resumes the same turn; `max_silence_ms` of
      silence ends it regardless;
    - the utterance keeps `prefix_ms` of audio from before the start, so
      the first syllable is never clipped.

    feed() returns ('start' | 'pause' | 'resume' | 'timeout', audio_ms)
    events. The turn's audio accumulates until the caller calls end_turn().
    """

    def __init__(self, *, threshold=0.7, min_speech_ms=200, pause_ms=200, max_silence_ms=3000,
                 prefix_ms=500, max_utterance_s=120):
        self.vad = SileroVad()
        self.threshold = float(threshold)
        self.neg_threshold = max(0.01, self.threshold - 0.15)
        self.start_windows = max(1, int(min_speech_ms) // WINDOW_MS)
        self.pause_windows = max(1, int(pause_ms) // WINDOW_MS)
        self.timeout_windows = max(self.pause_windows, int(max_silence_ms) // WINDOW_MS)
        self.prefix_windows = max(0, int(prefix_ms) // WINDOW_MS)
        self.max_windows = int(max_utterance_s * 1000) // WINDOW_MS
        self._pending = np.zeros(0, dtype=np.float32)
        self._history = []        # recent windows, for the prefix padding
        self._utterance = []      # windows of the turn in progress
        self._voiced_run = 0
        self._silent_run = 0
        self._turn_voiced = 0     # speech windows in the turn so far
        self.state = 'idle'       # idle | speaking | paused | ended
        self.windows_seen = 0
        # The window of the last sound above silence (neg_threshold) since
        # the last turn ended, even too little to start one. See heard_voice.
        self._last_voice = None

    @property
    def audio_ms(self):
        return self.windows_seen * WINDOW_MS

    @property
    def heard_voice(self):
        """Whether something above silence was on the mic recently enough
        to be what a transcript arriving now is about: within
        max_silence_ms, the longest pause a turn may hold. A transcript the
        engine sends outside a turn must have come from such a sound
        (PipelineSession._on_stt_event); one from minutes ago (the
        companion's own voice through the speakers, a door) says nothing
        about words arriving now."""
        return self._last_voice is not None and self.windows_seen - self._last_voice <= self.timeout_windows

    @property
    def voiced_ms(self):
        """How long the user has actually been speaking in this turn —
        silence inside it excluded."""
        return self._turn_voiced * WINDOW_MS

    @property
    def in_turn(self):
        return self.state in ('speaking', 'paused')

    def utterance(self):
        return np.concatenate(self._utterance) if self._utterance else np.zeros(0, np.float32)

    def end_turn(self):
        """Close the turn in progress and hand back its audio."""
        audio = self.utterance()
        self._utterance, self._history = [], []
        self._voiced_run = self._silent_run = self._turn_voiced = 0
        self.state = 'idle'
        self._last_voice = None
        return audio

    def feed(self, samples16k):
        events = []
        buf = np.concatenate([self._pending, samples16k]) if self._pending.size else samples16k
        n = buf.size // VAD_WINDOW
        for i in range(n):
            window = buf[i * VAD_WINDOW:(i + 1) * VAD_WINDOW]
            prob = self.vad(window)
            self.windows_seen += 1
            voiced = prob >= self.threshold
            if prob >= self.neg_threshold:
                self._last_voice = self.windows_seen
            if self.state == 'idle':
                self._history.append(window)
                keep = self.prefix_windows + self.start_windows
                if len(self._history) > keep:
                    del self._history[:-keep]
                self._voiced_run = self._voiced_run + 1 if voiced else 0
                if self._voiced_run >= self.start_windows:
                    self.state = 'speaking'
                    self._silent_run = 0
                    self._turn_voiced = self._voiced_run
                    self._utterance = list(self._history)
                    self._history = []
                    events.append(('start', max(0, self.audio_ms - self._voiced_run * WINDOW_MS)))
                continue
            if self.state == 'ended':
                # Timed out, waiting for the caller's end_turn(): nothing
                # more belongs to this turn.
                continue
            self._utterance.append(window)
            if prob < self.neg_threshold:
                self._silent_run += 1
                self._voiced_run = 0
            elif voiced:
                self._silent_run = 0
                self._voiced_run += 1
                self._turn_voiced += 1
            if self.state == 'speaking' and self._silent_run >= self.pause_windows:
                self.state = 'paused'
                events.append(('pause', self.audio_ms))
            elif self.state == 'paused' and self._voiced_run >= self.start_windows:
                self.state = 'speaking'
                events.append(('resume', self.audio_ms))
            if self.in_turn and (self._silent_run >= self.timeout_windows
                                 or len(self._utterance) >= self.max_windows):
                self.state = 'ended'
                events.append(('timeout', self.audio_ms))
        self._pending = buf[n * VAD_WINDOW:].copy()
        return events
