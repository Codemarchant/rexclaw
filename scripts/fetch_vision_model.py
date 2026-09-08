# Copyright 2026 Codemarchant
"""Fetch the MediaPipe models behind camera awareness (FaceLandmarker for
presence/expressions, GestureRecognizer for hand gestures) for bundling
into release packages, so the feature works offline out of the box.

CI runs this before packaging the desktop app and the Docker image, next
to fetch_wake_model.py (assets/ ships inside both). The browser tries the
bundled copies at /assets/vision_models/<name>.task first and falls back
to Google's model bucket when one is missing — so source checkouts that
never ran this script still work, they just need internet the first time
the box is ticked. Output: assets/vision_models/*.task (gitignored —
models are CI-fetched, never committed).

    python scripts/fetch_vision_model.py
"""
import shutil
import tempfile
import urllib.request
from pathlib import Path

# Keep in sync with MODELS in web/src/lib/camera_awareness.js.
MODELS = {
    "face_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
        "face_landmarker/float16/1/face_landmarker.task"),
    "gesture_recognizer.task": (
        "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/"
        "gesture_recognizer/float16/1/gesture_recognizer.task"),
}
OUT_DIR = Path(__file__).resolve().parents[1] / "assets" / "vision_models"


def fetch(name, url):
    out_path = OUT_DIR / name
    if out_path.is_file():
        print(f"{out_path} already present, skipping")
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / name
        print(f"downloading {url} …")
        with urllib.request.urlopen(url, timeout=120) as resp, open(tmp_path, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        shutil.move(str(tmp_path), str(out_path))
    print(f"wrote {out_path} ({out_path.stat().st_size // (1 << 20)} MB)")


if __name__ == "__main__":
    for name, url in MODELS.items():
        fetch(name, url)
