# Copyright 2026 Codemarchant
"""One browser's neural motion stream: scheduled speech in, timed frames out.

Audio arrives tagged with the playback clock time it will be heard at, so
every frame goes back anchored to that same clock. Playback is contiguous
within a reply; a short underrun becomes silence so the frames stay on the
voice, and a longer one starts a new utterance at its own anchor.
"""

from __future__ import annotations

import numpy as np
import soxr

from . import Frames, MotionModel

# Longest hole in the schedule filled with silence. Past this it is a new
# utterance: the model would only be walking the pose through nothing.
MAX_FILLED_GAP_S = 1.0
GAP_TOLERANCE_S = 0.02
WIND_DOWN_S = 2.0     # a model without transitions: its own motion on silence, back toward idle


class MotionSession:
    def __init__(self, model: MotionModel, style: int, seed: int, rate: int, shuffle: bool):
        self.model = model
        self.rate = rate
        self.stream = model.stream(style, seed, shuffle)
        self._reset()

    def _reset(self):
        self.resampler = soxr.ResampleStream(self.rate, self.model.sample_rate, 1, dtype="float32")
        self.t0 = None        # playback time of the utterance's first sample
        self.expected = 0.0   # playback time of the next sample
        self.emitted = 0      # frames sent for this utterance

    def _stamp(self, frames: Frames) -> list:
        count = len(frames.quats)
        if not count or self.t0 is None:
            return []
        t0 = self.t0 + self.emitted / self.model.fps
        self.emitted += count
        return [(t0, frames)]

    def audio(self, pcm: np.ndarray, start_at: float) -> list:
        """pcm plays at start_at; returns [(t0, Frames), ...] now finished."""
        out = []
        gap = start_at - self.expected
        if self.t0 is None:
            self.t0 = start_at
        elif gap > MAX_FILLED_GAP_S:
            out += self.finish()
            self.t0 = start_at
        elif gap > GAP_TOLERANCE_S:
            pcm = np.concatenate([np.zeros(int(gap * self.rate), np.float32), pcm])
        self.expected = start_at + len(pcm) / self.rate
        resampled = self.resampler.resample_chunk(pcm)
        return out + self._stamp(self.stream.push(resampled))

    def seed(self, pose: np.ndarray, root=None) -> list:
        """A new line starts from `pose`. A line still open (its finish never came, or a stall
        past MAX_FILLED_GAP_S is about to end it) is finished first, so the new one starts from
        the pose on screen, not from the old one's tail. Returns those last frames."""
        out = self.finish() if self.t0 is not None else []
        self.stream.seed(pose, root)
        return out

    def finish(self, idle=None) -> list:
        if self.t0 is None:
            return []
        tail = self.resampler.resample_chunk(np.zeros(0, np.float32), last=True)
        out = self._stamp(self.stream.push(tail)) if len(tail) else []
        out += self._stamp(self.stream.finish())
        bridge = self.stream.transition(idle) if idle is not None else None
        if bridge is not None:
            out += self._stamp(bridge)
        else:
            # The model keeps going on silence, so the body settles on its
            # own motion instead of freezing while the browser fades it out.
            silence = np.zeros(int(WIND_DOWN_S * self.model.sample_rate), np.float32)
            out += self._stamp(self.stream.push(silence))
            out += self._stamp(self.stream.finish())
        self._reset()
        return out

    def cancel(self):
        self.stream.cancel()
        self._reset()
