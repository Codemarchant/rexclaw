"""Motion clip libraries — folders of .vrma files plus a manifest.json (see
tools/motion/dlp3d_npz2vrma.py for the shape). Two roots, matching
routes/misc.motion_libraries: assets/motion/ ships with the app and
data/assets/motion/ is the user drop-in, where a folder of the same name
wins. This module derives the SPEECH GESTURE candidate list the selector
model is shown (session_service.speech_gesture_select) and caches it per
manifest mtime, since it is re-read for every spoken line.
"""

import json
import logging

from .avatar_packs import USER_ASSETS_DIR
from .db import ASSETS_DIR

_logger = logging.getLogger(__name__)

# Later roots win, so a user library shadows a shipped one of the same name.
MOTION_DIRS = (ASSETS_DIR / "motion", USER_ASSETS_DIR / "motion")

# Tags that describe how a clip is USED rather than what it means — a clip
# carrying only these (or a lifecycle state) is idle/filler material, not a
# gesture the selector should offer.
_NON_SEMANTIC_TAGS = frozenset({"idle", "fidget", "idle_safe", "neutral", "energetic", "waiting"})

_cache = {}   # folder name → (mtime, manifest dict)


def libraries():
    """[(key, manifest)] for every readable library, manifests cached by mtime."""
    found = {}
    for root in MOTION_DIRS:
        if not root.is_dir():
            continue
        for folder in sorted(root.iterdir()):
            manifest = folder / "manifest.json"
            if not folder.is_dir() or not manifest.is_file():
                continue
            try:
                mtime = manifest.stat().st_mtime
                cached = _cache.get(folder.name)
                if cached and cached[0] == mtime:
                    found[folder.name] = cached[1]
                    continue
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                _logger.warning("motion library %s: unreadable manifest (%s)", folder.name, e)
                continue
            _cache[folder.name] = (mtime, data)
            found[folder.name] = data
    return [(k, found[k]) for k in sorted(found)]


def is_speech_gesture(clip):
    """Whether a manifest clip is a semantic gesture (vs idle / filler /
    lifecycle clip) — the pool the speech selector chooses from.

    An annotated `keyframe` (the stroke of the motion) is what separates the
    two in the source library, and it separates them by length as well:
    keyframed clips run to about 8 s, the rest to 30 s and are meant as
    background filler between gestures. Without this test the selector
    could pick a half-minute filler clip for a sentence and monopolise the
    whole turn — those clips belong in the idle-fidget pool instead.
    """
    if not clip.get("id") or not clip.get("file") or not clip.get("en"):
        return False
    if clip.get("states") or not clip.get("keyframe"):
        return False
    tags = set(clip.get("tags") or [])
    return bool(tags - _NON_SEMANTIC_TAGS)


def speech_gesture_candidates():
    """{id: clip} across libraries, gesture clips only."""
    out = {}
    for _key, manifest in libraries():
        for clip in manifest.get("clips", []):
            if is_speech_gesture(clip) and clip["id"] not in out:
                out[clip["id"]] = clip
    return out


def speech_gesture_lines(candidates):
    """Rows for the selector prompt, one per distinct motion (libraries
    carry several takes of the same gesture — the caller spreads plays
    across them, see speech_gesture_variants), grouped by first tag so
    related gestures sit together (a model scans a grouped list better than
    an alphabetical one).

    Each row is `id | motion | tags | said when: …`. The trailing phrases
    are the library's own authored triggers for that gesture — the same
    signal the reference implementation hands its selector, and the
    strongest one for matching a line to a motion. They are in the
    library's source language; a bilingual model maps them onto the spoken
    line without trouble.
    """
    best_by_motion = {}
    for c in candidates.values():
        key = _motion_key(c)
        # Represent each motion with a take that actually carries triggers.
        if key not in best_by_motion or (
            c.get("speech_keywords_zh") and not best_by_motion[key].get("speech_keywords_zh")
        ):
            best_by_motion[key] = c
    rows = sorted(
        best_by_motion.values(),
        key=lambda c: ((c.get("tags") or [""])[0], c.get("en") or ""),
    )
    lines = []
    for c in rows:
        line = f"{c['id']} | {c['en']} | {', '.join(c.get('tags') or [])}"
        said = (c.get("speech_keywords_zh") or "").strip()
        if said:
            lines.append(f"{line} | said when: {said}")
        else:
            lines.append(line)
    return lines


def speech_gesture_variants(candidates, clip_id):
    """All takes of the same motion as `clip_id` (including itself)."""
    chosen = candidates.get(clip_id)
    if not chosen:
        return []
    key = _motion_key(chosen)
    return [c for c in candidates.values() if _motion_key(c) == key]


def speech_gesture_canonical(candidates, clip_ids):
    """Map played clip ids onto the ids the prompt actually lists.

    The prompt shows one row per distinct motion, but a play may have used
    any take of it (see speech_gesture_variants) — so a raw "recently used"
    list can name ids the model never sees, making the hint inert. This
    folds each id back to its listed representative, order preserved,
    de-duplicated.
    """
    listed = {}
    for clip in candidates.values():
        listed.setdefault(_motion_key(clip), clip['id'])
    out = []
    for cid in clip_ids:
        clip = candidates.get(cid)
        canonical = listed.get(_motion_key(clip)) if clip else None
        if canonical and canonical not in out:
            out.append(canonical)
    return out


def _motion_key(clip):
    return ((clip.get("en") or "").strip().lower(), tuple(clip.get("tags") or []))
