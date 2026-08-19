# Copyright 2026 Codemarchant
"""Fetch a Vosk wake-word model and repack it for bundling into release
packages.

CI runs this before packaging the desktop app so the default model ships
inside the zip (assets/ is copied into the package by electron-builder) and
a fresh install needs no post-install download for voice activation:

    python scripts/fetch_wake_model.py en

Mirrors the runtime converter in server/routes/misc.py (_wake_download):
alphacephei zip -> tar.gz keeping the model's top-level directory name, the
format vosk-browser loads. Output: assets/wake_models/<lang>.tar.gz
(gitignored - models are CI-fetched, never committed).
"""
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.wake_models import WAKE_MODELS  # noqa: E402  (dependency-free)

OUT_DIR = Path(__file__).resolve().parents[1] / "assets" / "wake_models"


def fetch(lang):
    model_name = WAKE_MODELS[lang]
    out_path = OUT_DIR / f"{lang}.tar.gz"
    if out_path.is_file():
        print(f"{out_path} already present, skipping")
        return
    url = f"https://alphacephei.com/vosk/models/{model_name}.zip"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        zip_path = tmp / "model.zip"
        print(f"downloading {url} …")
        with urllib.request.urlopen(url, timeout=120) as resp, open(zip_path, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp / "unpacked")
        roots = [p for p in (tmp / "unpacked").iterdir() if p.is_dir()]
        if not roots:
            raise RuntimeError("model archive had no directory inside")
        out_tmp = tmp / "model.tar.gz"
        with tarfile.open(out_tmp, "w:gz") as tf:
            tf.add(roots[0], arcname=roots[0].name)
        shutil.move(str(out_tmp), str(out_path))
    print(f"wrote {out_path} ({out_path.stat().st_size // (1 << 20)} MB)")


if __name__ == "__main__":
    langs = sys.argv[1:] or ["en"]
    for lang in langs:
        if lang not in WAKE_MODELS:
            raise SystemExit(f"unknown wake-word language {lang!r}; "
                             f"known: {', '.join(sorted(WAKE_MODELS))}")
        fetch(lang)
