# Copyright 2026 Codemarchant
"""Rexclaw's neural body motion model.

Every 12 frames (0.4 s) of speech, the model reads a 15 kHz window of 18,250
samples (0.475 s before those frames, 0.342 s after) as a log mel
spectrogram, turns it into two streams of 18 audio codes, and draws the
chunk's 9 x 32 latent from noise in four Euler steps of a flow generator
conditioned on the codes, a style, a root command and a summary of the last
four frames. A decoder turns the latent into the 12 frames at 30 fps. After
a line, an in-between graph carries the body from its last frames to the
idle pose in 2 s.

The graphs and constants ship packed in neural_model.bin (pack.py; built by
scripts/pack_neural_model.py), their weights stored as float16 and run as
float32. styles.json names the styles in the order the generator numbers
them.

A frame is 477 floats: root velocity (sideways, forward, turn), pelvis
position and velocity in the root's frame, then a 6D rotation for each of
the 52 bones in constants["bones"] (VRM humanoid names, parent-relative,
T-pose identity, VRM 1.0 axes) and an angular velocity for each.
"""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path

import numpy as np

from ... import Frames, MotionModel, MotionStream
from .pack import Pack

AUDIO_RATE = 15_000
FPS = 30
CHUNK = 12
CHUNK_SAMPLES = CHUNK * AUDIO_RATE // FPS
LEAD_SAMPLES = 7_125
WINDOW_SAMPLES = 18_250
N_FFT, HOP, MEL_FRAMES = 500, 250, 72
HISTORY = 4
JOINTS = 52
WIDTH = 9 + JOINTS * 9
ROOT_VELOCITY = slice(0, 3)
PELVIS = slice(3, 6)
ROTATIONS = slice(9, 9 + 6 * JOINTS)
SPIN = slice(9 + 6 * JOINTS, WIDTH)
BODY_ROTATIONS = np.concatenate([np.arange(9 + 6 * j, 15 + 6 * j) for j in (3, 6, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21)])
FLOW_STEPS = 4
FLOW_START = 0.001
LATENT = (1, 9, 32)
GRAPHS = ("student", "prefix", "generator", "decoder", "inbetween")
LEG_CHAIN = {"l": (1, 4, 7, 10), "r": (2, 5, 8, 11)}     # upper leg, lower leg, foot, toes

# Root steering with shuffling on, in the model's own velocity spread: on past
# the range a calm stretch of the training motion covers in three minutes
# (0.14 m), off inside about half of it; facing on past the range it covers in
# three windows out of four (26 deg), off inside half. At most four spreads,
# about the training motion's 99th-percentile speed and turn rate.
HOME_ON_M, HOME_OFF_M = 0.15, 0.08
FACING_ON, FACING_OFF = np.radians(26.0), np.radians(13.0)
MOVE_LIMIT = TURN_LIMIT = 4.0
STEER_SECONDS = 2.5        # the horizon the root command was trained on
MAX_TURN = np.radians(90)  # rad/s: ten times the training motion's 99th-percentile turn rate, a ceiling
SWAY_SECONDS = 3.0         # shuffling off: how long a weight shift lasts before it leaks home

# Output smoothing, a centred Gaussian (Kucherenko et al. 2020): at 2 frames
# the arms' jerk matches the training motion's. Its radius is the frames held
# back for the next chunk.
SMOOTH_SIGMA = 2.0
SMOOTH_RADIUS = 6

# The model holds the head lower than an avatar's idle does; what it plays is
# lifted part of the way to level, NECK_SHARE of it at the neck. The model's
# own history keeps the posture it drew.
HEAD_LIFT_DEG = 10.0
NECK_SHARE = 0.4

TRANSITION_FRAMES = 60     # the in-between's 45 latents
TRANSITION_EASE = 8        # frames eased from the last pose shown into it


def quat_mul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], -1)


def quat_conj(q):
    return q * np.array([-1, -1, -1, 1], q.dtype)


def quat_rotate(q, v):
    u, w = q[..., :3], q[..., 3:]
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def six_to_quat(six):
    """(..., 6), two rotation-matrix columns -> (..., 4) unit quaternions x, y, z, w."""
    a = six[..., :3] / np.maximum(np.linalg.norm(six[..., :3], axis=-1, keepdims=True), 1e-8)
    b = six[..., 3:] - (a * six[..., 3:]).sum(-1, keepdims=True) * a
    b = b / np.maximum(np.linalg.norm(b, axis=-1, keepdims=True), 1e-8)
    c = np.cross(a, b)
    (xx, yx, zx), (xy, yy, zy), (xz, yz, zz) = np.moveaxis(a, -1, 0), np.moveaxis(b, -1, 0), np.moveaxis(c, -1, 0)
    # One row per largest component (x, y, z, w), the best conditioned one picked.
    rows = np.stack([
        np.stack([1 + xx - yy - zz, xy + yx, xz + zx, zy - yz], -1),
        np.stack([xy + yx, 1 - xx + yy - zz, yz + zy, xz - zx], -1),
        np.stack([xz + zx, yz + zy, 1 - xx - yy + zz, yx - xy], -1),
        np.stack([zy - yz, xz - zx, yx - xy, 1 + xx + yy + zz], -1),
    ], -2)
    pick = np.argmax(np.stack([xx, yy, zz, xx + yy + zz], -1), -1)
    q = np.take_along_axis(rows, pick[..., None, None], -2)[..., 0, :]
    return (q / np.linalg.norm(q, axis=-1, keepdims=True)).astype(np.float32)


def quat_to_six(q):
    x, y, z, w = np.moveaxis(q, -1, 0)
    first = np.stack([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], -1)
    second = np.stack([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], -1)
    return np.concatenate([first, second], -1).astype(np.float32)


def same_hemisphere(q):
    """(T, B, 4) with each frame's sign flipped to agree with the frame before, so they average."""
    q = q.astype(np.float64).copy()
    for t in range(1, len(q)):
        q[t] *= np.where((q[t] * q[t - 1]).sum(-1, keepdims=True) < 0, -1.0, 1.0)
    return q


def gaussian(x, sigma=SMOOTH_SIGMA, radius=SMOOTH_RADIUS):
    """Centred Gaussian along time (axis 0), the ends held."""
    taps = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    taps /= taps.sum()
    padded = np.concatenate([np.repeat(x[:1], radius, 0), x, np.repeat(x[-1:], radius, 0)])
    return sum(w * padded[i:i + len(x)] for i, w in enumerate(taps)).astype(np.float64)


def unit(q):
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def land_on(quats, goal):
    """The transition's frames (T, B, 4) ending exactly on `goal` (B, 4): the gap between its
    last frame and the goal is taken up along the way, in step with the frames' own progress
    toward their end (residual on the target, as the delta-interpolator, Oreshkin et al. 2022).
    Progress is the share of the total rotation still to go, made monotonic, so the correction
    adds no motion of its own: none at the start, all of it by the frames' own arrival."""
    end = quats[-1]
    goal = goal * np.where((goal * end).sum(-1, keepdims=True) < 0, -1.0, 1.0)
    gap = quat_mul(quat_conj(end), goal)                                    # end . gap = goal
    togo = (2 * np.arccos(np.clip(np.abs((quats * end).sum(-1)), 0, 1))).sum(-1)   # (T,)
    progress = 1 - togo / togo[0] if togo[0] > np.radians(2) else np.linspace(0, 1, len(quats))
    progress = np.maximum.accumulate(np.clip(progress, 0, 1))
    w = progress[:, None, None]
    identity = np.array([0, 0, 0, 1.0])
    step = unit(identity * (1 - w) + gap * np.where(gap[..., 3:] < 0, -1.0, 1.0) * w)   # nlerp identity -> gap
    return quat_mul(quats, step)


class Posture:
    """What the model draws vs what the avatar shows: the head lifted toward level, and
    the shoulders played as movement from the model's average shoulder pose (shoulder
    S -> S m^-1 and its upper arm U -> m U, so where the arm points is kept), so at the
    average the avatar's shoulders rest as in its idle. show() one way, read() back."""

    def __init__(self, bones, mean_six):
        self.lifts = []
        for name, share in (("neck", NECK_SHARE), ("head", 1.0 - NECK_SHARE)):
            if name in bones:
                half = np.radians(HEAD_LIFT_DEG * share) / 2
                self.lifts.append((bones.index(name), np.array([-np.sin(half), 0, 0, np.cos(half)], np.float32)))
        six = mean_six.reshape(JOINTS, 6)
        self.shoulders = [(bones.index(f"{s}Shoulder"), bones.index(f"{s}UpperArm"),
                           six_to_quat(six[bones.index(f"{s}Shoulder")]))
                          for s in ("left", "right") if f"{s}Shoulder" in bones]

    def show(self, quats):
        out = quats.copy()
        for shoulder, arm, m in self.shoulders:
            out[..., shoulder, :] = quat_mul(out[..., shoulder, :], quat_conj(m))
            out[..., arm, :] = quat_mul(m, out[..., arm, :])
        for bone, lift in self.lifts:
            out[..., bone, :] = quat_mul(lift, out[..., bone, :])
        return out.astype(np.float32)

    def read(self, quats):
        out = np.asarray(quats, np.float32).copy()
        for bone, lift in self.lifts:
            out[..., bone, :] = quat_mul(quat_conj(lift), out[..., bone, :])
        for shoulder, arm, m in self.shoulders:
            out[..., shoulder, :] = quat_mul(out[..., shoulder, :], m)
            out[..., arm, :] = quat_mul(quat_conj(m), out[..., arm, :])
        return out


def _styles():
    path = Path(__file__).with_name("styles.json")
    return json.loads(path.read_text()) if path.is_file() else []


class MODEL(MotionModel):
    label = "Rexclaw neural motion"
    sample_rate = AUDIO_RATE
    fps = FPS
    has_feet = True
    required_files = ("neural_model.bin",)

    def __init__(self, model_id, model_dir):
        super().__init__(model_id, model_dir)
        self._sessions = None
        self._loading = threading.Lock()
        self.bones, self.styles, self.default_style = [], [], 0
        if not self.ready():
            return
        c = self._constants()
        self.bones = [str(b) for b in c["bones"]]
        named = _styles()
        for i in range(len(c["style_names"])):
            style = named[i] if i < len(named) else {"name": f"Style {i + 1}"}
            label = f"{style['name']} ({style['energy']})" if "energy" in style else style["name"]
            self.styles.append({"id": i, "name": style["name"], "label": label})
        # Fingers turn about the model's rest hand: each finger bone's direction to its child.
        child = {int(p): k for k, p in reversed(list(enumerate(c["parents"])))}
        self.hand_rest = {self.bones[j]: unit(c["offsets"][child[j]]).round(4).tolist()
                          for j in range(22, len(self.bones)) if j in child}
        self.posture = Posture(self.bones, c["mean"][ROTATIONS])

    def _load(self):
        """Loads the graphs and constants once. Streams start in worker threads, so a second
        one starting meanwhile waits for this one; the sessions appear last, once all is set."""
        if self._sessions is not None:
            return
        with self._loading:
            if self._sessions is None:
                self._load_now()

    def _load_now(self):
        import onnxruntime as ort

        pack = Pack(self.dir / "neural_model.bin")
        weights_alive, sessions = [], {}    # onnxruntime reads the weights in place: keep them with the sessions
        for g in GRAPHS:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.log_severity_level = 3
            weights = np.load(io.BytesIO(pack.read(f"{g}.weights")))
            values = [ort.OrtValue.ortvalue_from_numpy(weights[n].astype(np.float32)) for n in weights.files]
            options.add_external_initializers(list(weights.files), values)
            weights_alive += values
            sessions[g] = ort.InferenceSession(pack.read(f"{g}.graph"), options, providers=["CPUExecutionProvider"])
        c = self._constants()
        self.mean, self.std = c["mean"].astype(np.float32), c["std"].astype(np.float32)
        self.latent_mean, self.latent_std = c["lat_mean"].astype(np.float32), c["lat_std"].astype(np.float32)
        self.history_noise = float(c["hist_level"])
        self.rest_bank = c["rest_bank"].astype(np.float32) if "rest_bank" in c else None
        self.mel_bank, self.mel_window = c["mel_fb"].astype(np.float32), c["mel_window"].astype(np.float32)
        self.offsets = c["offsets"].astype(np.float32)
        self.rest_pelvis = self.mean[PELVIS].copy()
        self.spread = self.std[ROOT_VELOCITY]
        upper, lower, foot, _ = LEG_CHAIN["l"]
        self.leg_length = float(np.linalg.norm(self.offsets[lower]) + np.linalg.norm(self.offsets[foot]))
        self.rest_toe_y = float(self.rest_pelvis[1] + sum(self.offsets[j][1] for j in LEG_CHAIN["l"]))
        self._weights = weights_alive
        self._sessions = sessions

    def _constants(self):
        return np.load(io.BytesIO(Pack(self.dir / "neural_model.bin").read("constants")))

    def run(self, graph, **inputs):
        return self._sessions[graph].run(None, inputs)

    def mel(self, window):
        """(18250,) samples -> (1, 80, 72) log mel."""
        at = np.arange(MEL_FRAMES)[:, None] * HOP + np.arange(N_FFT)
        power = np.abs(np.fft.rfft(window[at] * self.mel_window, axis=-1)) ** 2
        return np.log(np.maximum(power @ self.mel_bank, 1e-5)).T[None].astype(np.float32)

    def summary(self, history):
        return self.run("prefix", history=history.astype(np.float32))[0]

    def decode(self, latent, history):
        """One normalized latent (1, 9, 32) after `history` -> (1, 12, 477) normalized frames."""
        z = (latent * self.latent_std + self.latent_mean).astype(np.float32)
        return self.run("decoder", z=z, prefix=self.summary(history), last2=history[:, -2:])[0]

    def held(self, pose):
        """An avatar pose (bones, 4) held still on the spot, as normalized history (1, 4, 477)."""
        frame = self.mean.copy()
        frame[ROOT_VELOCITY] = 0.0
        frame[6:9] = 0.0
        frame[ROTATIONS] = quat_to_six(self.posture.read(pose)).reshape(-1)
        frame[SPIN] = 0.0
        return np.tile((frame - self.mean) / self.std, (1, HISTORY, 1)).astype(np.float32)

    def rest_near(self, pose):
        """The end the in-between is aimed at for the idle `pose`: the still pose of the model's
        own nearest to it (rest_bank), held, when the pack has one; else the idle itself. An
        avatar's idle is seldom a pose the model has seen held, and it settles toward one it
        knows as the people it learnt from do; land_on then takes it onto the idle."""
        held = self.held(pose)
        if self.rest_bank is None:
            return held
        near = np.abs(self.rest_bank[:, BODY_ROTATIONS] - held[0, 0, BODY_ROTATIONS]).sum(-1).argmin()
        return np.tile(self.rest_bank[near], (1, HISTORY, 1)).astype(np.float32)

    def toes(self, quats, pelvis):
        """(frames, 2, 3): each toe in the root's frame, down the leg from the pelvis."""
        out = np.empty((len(quats), 2, 3), np.float32)
        for s, side in enumerate(("l", "r")):
            turn, at = quats[:, 0], pelvis.copy()
            for i, j in enumerate(LEG_CHAIN[side]):
                at = at + quat_rotate(turn, self.offsets[j])
                if i < 3:
                    turn = quat_mul(turn, quats[:, j])
            out[:, s] = at
        return out

    def stream(self, style, seed, shuffle):
        self._load()
        return _Stream(self, style, seed, shuffle)


class Root:
    """Where the character stands relative to home (x, z, facing) and the root command
    the generator is given: stay on the spot, or roam and be steered home past the range."""

    def __init__(self, model, shuffle):
        self.model = model
        self.shuffle = shuffle
        self.at = np.zeros(2)
        self.facing = 0.0
        self.sway = np.zeros(2)
        self.homing = self.turning = False

    def _local(self, velocity):
        c, s = np.cos(self.facing), np.sin(self.facing)
        return np.array([c * velocity[0] - s * velocity[1], s * velocity[0] + c * velocity[1]])

    def command(self):
        """(cmd_xz, cmd_yaw) for the next chunk: velocity wanted and its strength, in the
        model's own velocity spread; free inside the home range, steered back past it."""
        if not self.shuffle:
            return self.stay()
        self.homing = np.hypot(*self.at) > (HOME_OFF_M if self.homing else HOME_ON_M)
        self.turning = abs(self.off_facing()) > (FACING_OFF if self.turning else FACING_ON)
        return self.toward_home(STEER_SECONDS, self.homing, self.turning)

    def off_facing(self):
        """Facing from home the short way round: a body that has turned whole turns faces home."""
        return float(np.arctan2(np.sin(self.facing), np.cos(self.facing)))

    @staticmethod
    def stay():
        return np.array([[0.0, 0.0, 1.0]], np.float32), np.array([[0.0, 1.0]], np.float32)

    def toward_home(self, seconds, move=True, turn=True):
        spread = self.model.spread
        cmd_xz, cmd_yaw = np.zeros((1, 3), np.float32), np.zeros((1, 2), np.float32)
        if move:
            cmd_xz[0] = *np.clip(self._local(-self.at / seconds) / spread[:2], -MOVE_LIMIT, MOVE_LIMIT), 1.0
        if turn:
            cmd_yaw[0] = np.clip(-self.off_facing() / seconds / spread[2], -TURN_LIMIT, TURN_LIMIT), 1.0
        return cmd_xz, cmd_yaw

    def follow(self, hips, toes, velocity):
        """Move along the frames' root velocity (shuffling on) and put hips and toes in the
        world; off, keep the root's quick part as sway on the spot. Returns the path (n, 3)."""
        path = np.tile([self.at[0], self.at[1], self.facing], (len(velocity), 1)).astype(np.float32)
        if not self.shuffle:
            leak = np.exp(-1.0 / (FPS * SWAY_SECONDS))
            for f, (side, forward, _) in enumerate(velocity):
                self.sway = (self.sway + np.array([side, forward]) / FPS) * leak
                hips[f, [0, 2]] += self.sway
                toes[f, :, [0, 2]] += self.sway[:, None]
            return path
        if not (np.isfinite(self.at).all() and np.isfinite(self.facing)):
            self.at, self.facing = np.zeros(2), 0.0
        for f, (side, forward, turn) in enumerate(np.nan_to_num(velocity)):
            self.facing += float(np.clip(turn, -MAX_TURN, MAX_TURN)) / FPS
            c, s = np.cos(self.facing), np.sin(self.facing)
            self.at += np.array([c * side + s * forward, c * forward - s * side]) / FPS
            path[f] = (self.at[0], self.at[1], self.facing)
            hips[f, [0, 2]] = c * hips[f, 0] + s * hips[f, 2], c * hips[f, 2] - s * hips[f, 0]
            x, z = toes[f, :, 0].copy(), toes[f, :, 2].copy()
            toes[f, :, 0] = c * x + s * z + self.at[0]
            toes[f, :, 2] = c * z - s * x + self.at[1]
        return path

    def way_home(self, n):
        """Root velocities (n, 3) that bring the character home and facing a whole turn over n
        frames, on a smoothstep; turns first each frame, as follow() reads them."""
        f = np.arange(n + 1) / n
        ease = f * f * (3 - 2 * f)
        facings = self.facing - np.arctan2(np.sin(self.facing), np.cos(self.facing)) * ease
        spots = self.at[None] * (1 - ease)[:, None]
        out = np.zeros((n, 3), np.float32)
        out[:, 2] = np.diff(facings) * FPS
        step = np.diff(spots, axis=0) * FPS
        c, s = np.cos(facings[1:]), np.sin(facings[1:])
        out[:, 0], out[:, 1] = c * step[:, 0] - s * step[:, 1], s * step[:, 0] + c * step[:, 1]
        return out


class Smoother:
    """Rotations and pelvis through the output Gaussian as frames stream: the last
    SMOOTH_RADIUS frames of each push wait for the next one, and the frames before them
    are kept as context. Feet and root pass through as drawn."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.waiting = None
        self.context = None

    def __call__(self, frames, last, empty):
        if self.waiting is None or not len(self.waiting.quats):
            self.waiting = frames
        elif len(frames.quats):
            self.waiting = Frames(*[np.concatenate([a, b]) for a, b in zip(self.waiting, frames)])
        w = self.waiting
        ready = len(w.quats) - (0 if last else SMOOTH_RADIUS)
        if ready <= 0:
            if last:
                self.reset()
            return empty
        before_q, before_h = self.context if self.context is not None else (w.quats[:0], w.hips[:0])
        quats = same_hemisphere(np.concatenate([before_q, w.quats]))
        hips = np.concatenate([before_h, w.hips])
        start = len(before_q)
        out = Frames(unit(gaussian(quats))[start:start + ready].astype(np.float32),
                     gaussian(hips)[start:start + ready].astype(np.float32), w.feet[:ready], w.root[:ready])
        self.context = (np.concatenate([before_q, w.quats[:ready]])[-SMOOTH_RADIUS:],
                        np.concatenate([before_h, w.hips[:ready]])[-SMOOTH_RADIUS:])
        self.waiting = Frames(*[a[ready:] for a in w])
        if last:
            self.reset()
        return out


class _Stream(MotionStream):
    def __init__(self, model, style, seed, shuffle):
        self.model = model
        self.style = np.array([max(0, int(style))], np.int64)
        self.rng = np.random.default_rng(seed)
        self.root = Root(model, shuffle)
        self.smoother = Smoother()
        self.history = np.zeros((1, HISTORY, WIDTH), np.float32)
        self.last_pose = None
        self._new_line()

    def _new_line(self):
        self.audio = np.zeros(LEAD_SAMPLES, np.float32)
        self.heard = 0
        self.played = 0
        self.last_toes = None

    def seed(self, pose, root=None):
        self.history = self.model.held(pose)
        if root is not None and self.root.shuffle:
            self.root.at = np.array(root[:2], np.float64)
            self.root.facing = float(root[2])

    def _frames(self, body):
        """Denormalized frames -> what the avatar plays: rotations, hips, feet, root."""
        m = self.model
        quats = six_to_quat(body[:, ROTATIONS].reshape(-1, JOINTS, 6))
        hips = (body[:, PELVIS] - m.rest_pelvis).astype(np.float32)
        toes = m.toes(quats, body[:, PELVIS])
        path = self.root.follow(hips, toes, body[:, ROOT_VELOCITY])
        before = np.concatenate([toes[:1] if self.last_toes is None else self.last_toes, toes[:-1]])
        self.last_toes = toes[-1:].copy()
        speed = np.hypot(*(toes - before)[..., [0, 2]].transpose(2, 0, 1)) * FPS
        lift = toes[..., 1] - m.rest_toe_y
        feet = (np.stack([lift, speed], -1).reshape(len(body), 4) / m.leg_length).astype(np.float32)
        return quats, hips, feet, path

    def _chunk(self, window):
        m = self.model
        hubert, beats = (codes.astype(np.int64) for codes in m.run("student", mel=m.mel(window)))
        move, turn = self.root.command()
        noisy = self.history + self.rng.standard_normal(self.history.shape).astype(np.float32) * m.history_noise
        given = dict(prefix=m.summary(noisy), hubert=hubert, beats=beats, cmd_xz=move, cmd_yaw=turn,
                     style=self.style, hist_level=np.array([m.history_noise], np.float32),
                     d=np.array([1.0 / FLOW_STEPS], np.float32))
        x = self.rng.standard_normal(LATENT).astype(np.float32)
        times = np.linspace(FLOW_START, 1.0, FLOW_STEPS + 1)
        for t, t_next in zip(times, times[1:]):
            x = x + m.run("generator", x_t=x, t=np.array([t], np.float32), **given)[0] * np.float32(t_next - t)
        decoded = m.decode(x, self.history)
        self.history = decoded[:, -HISTORY:].copy()
        self.decoded.append(decoded)
        quats, hips, feet, path = self._frames(decoded[0] * m.std + m.mean)
        return Frames(m.posture.show(quats), hips, feet, path)

    def _drain(self):
        self.decoded = []
        chunks = []
        while len(self.audio) >= WINDOW_SAMPLES:
            chunks.append(self._chunk(self.audio[:WINDOW_SAMPLES]))
            self.audio = self.audio[CHUNK_SAMPLES:]
        if not chunks:
            return self.model.no_frames()
        self.played += CHUNK * len(chunks)
        return Frames(*[np.concatenate(part) for part in zip(*chunks)])

    def push(self, pcm):
        self.heard += len(pcm)
        self.audio = np.concatenate([self.audio, pcm.astype(np.float32)])
        frames = self._drain()
        if len(frames.quats):
            self.last_pose = frames.quats[-1].copy()
        return self.smoother(frames, False, self.model.no_frames())

    def finish(self):
        voiced = int(np.ceil(self.heard / (AUDIO_RATE / FPS)))
        before, at, facing = (self.history, self.root.at.copy(), self.root.facing)
        played = self.played
        self.audio = np.concatenate([self.audio, np.zeros(WINDOW_SAMPLES, np.float32)])
        frames = self._drain()
        keep = min(max(0, voiced - played), len(frames.quats))
        # The silence after the voice decodes frames that never play: go on from the last shown.
        self.history = np.concatenate([before, *self.decoded], axis=1)[:, keep:HISTORY + keep].copy()
        if keep:
            self.last_pose = frames.quats[keep - 1].copy()
            self.root.at = frames.root[keep - 1, :2].astype(np.float64)
            self.root.facing = float(frames.root[keep - 1, 2])
        else:
            self.root.at, self.root.facing = at, facing
        self._new_line()
        kept = Frames(frames.quats[:keep], frames.hips[:keep], frames.feet[:keep], frames.root[:keep])
        return self.smoother(kept, True, self.model.no_frames())

    def transition(self, pose):
        """Two seconds from the last frames shown to `pose`, the idle: the in-between's latents,
        decoded chunk by chunk, with the root taken home when shuffling."""
        m = self.model
        move, turn = self.root.toward_home(TRANSITION_FRAMES / FPS) if self.root.shuffle else self.root.stay()
        latents = m.run("inbetween", start_prefix=m.summary(self.history), end_prefix=m.summary(m.rest_near(pose)),
                        cmd_xz=move, cmd_yaw=turn)[0]
        bodies = []
        for i in range(0, latents.shape[1], LATENT[1]):
            decoded = m.decode(latents[:, i:i + LATENT[1]], self.history)
            self.history = decoded[:, -HISTORY:].copy()
            bodies.append(decoded[0] * m.std + m.mean)
        body = np.concatenate(bodies)
        if self.root.shuffle:
            body[:, ROOT_VELOCITY] = self.root.way_home(len(body))
        quats, hips, feet, path = self._frames(body)
        quats = same_hemisphere(quats)
        if self.last_pose is not None:
            last = m.posture.read(self.last_pose[None])[0]
            last = last * np.where((last * quats[0]).sum(-1, keepdims=True) < 0, -1.0, 1.0)
            w = ((np.arange(TRANSITION_EASE) + 1) / (TRANSITION_EASE + 1))[:, None, None]
            quats[:TRANSITION_EASE] = last * (1 - w) + quats[:TRANSITION_EASE] * w
        quats = land_on(unit(quats), m.posture.read(np.asarray(pose, np.float32)[None])[0])
        out = m.posture.show(unit(gaussian(quats)).astype(np.float32))
        self.last_pose = out[-1].copy()
        return Frames(out, gaussian(hips).astype(np.float32), feet, path)

    def cancel(self):
        self._new_line()
        self.smoother.reset()
