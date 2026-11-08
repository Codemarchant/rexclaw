# Copyright 2026 Codemarchant
"""Neural body motion: speech audio in, timed VRM bone rotations out.

Each model is one folder, server/neural_motion/models/<id>/ (or, for local
tests that are never committed, models/test_models/<id>/), whose package
exposes MODEL, a MotionModel subclass. Its weights sit beside it or in
<data>/models/<id>/ (data/ is never committed), so adding or replacing a
model means adding a folder here; nothing else in the app knows about any
particular model.

    class MODEL(MotionModel):
        label = "My model"
        sample_rate = 16000          # what push() is given
        fps = 30                     # what push() returns
        bones = ["spine", ...]       # VRM humanoid names, the quat order
        styles = [{"id": 0, "name": "Calm", "label": "Calm"}]   # optional
        default_style = 0
        hand_rest = None             # optional: {finger bone: [x, y, z]}, see below
        required_files = ("model.onnx",)        # ready() checks these

        def stream(self, style, seed, shuffle):
            # shuffle: may the character leave the spot they stand on?
            return MyStream(self, style, seed, shuffle)

    class MyStream(MotionStream):
        def push(self, pcm): ...     # returns the frames this audio finished
        def finish(self): ...        # end of speech: the remaining frames
        def cancel(self): ...        # barge-in: drop buffered audio

Every method returns Frames. quats is float32 (frames, len(bones), 4): unit
quaternions x, y, z, w, relative to the VRM T-pose, parent-relative, in
VRM 1.0 axes (the character faces +Z, their left hand is toward +X). hips
is float32 (frames, 3): the pelvis's offset from its rest spot in the same
axes, in metres, applied as is on every avatar. feet is float32 (frames, 4)
for a model that sets has_feet: left lift, left speed, right lift, right
speed of the ball of each foot on the model's own rig, in leg lengths (per
second for speed); the foot IK decides contact from it and leaves the legs
alone without it. root (same models) is float32 (frames, 3): x, z in metres
and turn in radians from home; the renderer holds the last value after the
frames end, so the idle stays with them. Frame 0 of an utterance
is the first sample pushed, and
frames stay contiguous
until finish(), so timing and stitching stay out of the models.

hand_rest is for a model whose finger rotations are relative to its own
rest hand rather than a VRM's (a rest hand with fanned fingers):
for each finger bone, the direction toward its next bone in that rest, in
the same VRM 1.0 axes. The browser then turns each finger rotation into
the loaded avatar's rest (every finger bone points where the model's
does), so a curl stays a curl on any avatar. A stream
keeps its own pose history across utterances. Models may be slower than
the socket, never than speech: each one runs in a worker thread, one call
at a time per stream.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path
from typing import NamedTuple, Optional

import numpy as np

from ..db import DATA_DIR, PROJECT_ROOT

_logger = logging.getLogger(__name__)


class Frames(NamedTuple):
    quats: np.ndarray
    hips: np.ndarray
    feet: Optional[np.ndarray] = None
    root: Optional[np.ndarray] = None


class MotionStream:
    def seed(self, pose: np.ndarray, root=None) -> None:
        """Optional: the avatar's pose (len(bones), 4) as speech starts, and
        the root as last played (x, z, turn)."""

    def transition(self, pose: np.ndarray) -> Optional[Frames]:
        """Optional: frames from the last pose toward `pose` (the idle) after
        finish(); the browser blends their last 60% into the live idle, so
        they needn't land on it. None has the framework run the model on
        silence instead."""

    def push(self, pcm: np.ndarray) -> Frames:
        raise NotImplementedError

    def finish(self) -> Frames:
        raise NotImplementedError

    def cancel(self) -> None:
        raise NotImplementedError


class MotionModel:
    label = ""
    sample_rate = 16000
    fps = 30
    bones: list = []
    has_feet = False
    styles: list = []
    default_style = 0
    hand_rest: Optional[dict] = None
    required_files: tuple = ()

    def __init__(self, model_id: str, model_dir: Path):
        self.id = model_id
        self.dir = model_dir

    def ready(self) -> bool:
        return all((self.dir / name).is_file() for name in self.required_files)

    def stream(self, style: int, seed: int, shuffle: bool) -> MotionStream:
        raise NotImplementedError

    def no_frames(self) -> Frames:
        feet = np.zeros((0, 4), np.float32) if self.has_feet else None
        root = np.zeros((0, 3), np.float32) if self.has_feet else None
        return Frames(np.zeros((0, len(self.bones), 4), np.float32), np.zeros((0, 3), np.float32), feet, root)


_instances: dict = {}


TEST_MODELS = "test_models"
MAIN_MODEL = "neural_model"


def _model_dir(model_id: str, adapter_dir: Path) -> Path:
    # Beside the adapter, else the data folder: the desktop app keeps its
    # data under %APPDATA%, a checkout in the repo's data/.
    candidates = (adapter_dir,
                  DATA_DIR / "models" / model_id,
                  PROJECT_ROOT / "data" / "models" / model_id)
    weighted = (d for d in candidates if d.is_dir()
                and any(f.is_file() and f.suffix not in _CODE_SUFFIXES for f in d.iterdir()))
    return next(weighted, candidates[1])


_CODE_SUFFIXES = {".py", ".pyc", ".json", ".md"}    # what an adapter folder carries besides weights


def _packages():
    """(package name, folder) for each model folder: models/, then models/test_models/ if there."""
    from . import models as package

    for info in pkgutil.iter_modules(package.__path__):
        if not info.ispkg:
            continue
        if info.name != TEST_MODELS:
            yield f"{package.__name__}.{info.name}", info.name, Path(package.__path__[0]) / info.name
            continue
        tests = Path(package.__path__[0]) / TEST_MODELS
        for test in pkgutil.iter_modules([str(tests)]):
            if test.ispkg:
                yield f"{package.__name__}.{TEST_MODELS}.{test.name}", test.name, tests / test.name


def all_models() -> list:
    """Every model folder, ready or not. One that wasn't ready is looked at again each
    time, so weights added while the app runs are picked up (folder, styles and all)."""
    found = []
    for module_name, model_id, folder in _packages():
        cached = _instances.get(model_id)
        if cached is None or not cached.ready():
            try:
                module = importlib.import_module(module_name)
                _instances[model_id] = module.MODEL(model_id, _model_dir(model_id, folder))
            except Exception:
                _logger.exception("neural motion: model %s did not load", model_id)
                continue
        found.append(_instances[model_id])
    return found


def get(model_id: str) -> Optional[MotionModel]:
    return next((m for m in all_models() if m.id == model_id and m.ready()), None)


def listing() -> list:
    return [{
        "id": m.id,
        "label": m.label or m.id,
        "ready": m.ready(),
        "folder": str(m.dir),
        "styles": m.styles,
        "default_style": m.default_style,
    } for m in all_models()]


def settings_of(config) -> dict:
    return {
        "on": bool(config["neural_motion_on"]),
        "model": config["neural_motion_model"],
        "style": config["neural_motion_style"],
        "parts": [p for p in config["neural_motion_parts"].split(",") if p],
    }


def for_call(config, defaults: Optional[dict] = None) -> Optional[dict]:
    """What the browser runs: None unless it is on and a model is there (the
    saved one, else the main one at its default style). `defaults` (an
    avatar's, see avatar_defaults) take the model and style's place where this
    install has them: a group call's other companions move as their own
    avatar says, the saved settings left to the one on screen."""
    saved = settings_of(config)
    if not saved["on"]:
        return None
    own = get(defaults.get("model") or MAIN_MODEL) if defaults else None
    if own is not None:
        saved = {**saved, "model": own.id, "style": _style_named(own, defaults.get("style"))}
    model = get(saved["model"] or MAIN_MODEL)
    if model is None:      # the saved model is gone: the main one, at its own default
        model, saved = get(MAIN_MODEL), {**saved, "style": -1}
    if model is None:
        return None
    style = saved["style"] if saved["style"] >= 0 else model.default_style
    return {"model": model.id, "style": style, "parts": saved["parts"]}


def _style_named(model, name) -> int:
    """The id of `model`'s style called `name`, -1 (its default) when it has none."""
    return next((s["id"] for s in model.styles if name and name in (s.get("name"), s.get("label"))), -1)


def avatar_defaults(value) -> Optional[dict]:
    """An avatar pack's `neural_motion` ({"model", "style"}, style by name) as
    stored, or None. Neither has to exist here: the defaults apply only where
    they do."""
    if not isinstance(value, dict):
        return None
    out = {k: str(value[k]).strip() for k in ("model", "style") if str(value.get(k) or "").strip()}
    return out or None


def apply_avatar(con, avatar_id: Optional[int], defaults: Optional[dict]) -> bool:
    """A companion switch: when `avatar_id` isn't the avatar the settings last
    followed, take its defaults (those this install has) and follow it, so the
    manual controls keep whatever is picked after, until the next switch.
    True when it was a switch."""
    config = con.execute("SELECT neural_motion_avatar FROM config WHERE id = 1").fetchone()
    if not avatar_id or config is None or config["neural_motion_avatar"] == avatar_id:
        return False
    sets, vals = ["neural_motion_avatar = ?"], [avatar_id]
    model = get((defaults or {}).get("model") or MAIN_MODEL) if defaults else None
    if model is not None:
        style = _style_named(model, defaults.get("style"))
        sets += ["neural_motion_model = ?", "neural_motion_style = ?"]
        vals += [model.id, style]
    con.execute(f"UPDATE config SET {', '.join(sets)} WHERE id = 1", vals)
    con.commit()
    return True
