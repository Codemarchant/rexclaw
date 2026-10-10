# Copyright 2026 Codemarchant
"""Fetch the EmbeddingGemma 2 text encoder (Google DeepMind, Apache 2.0) behind
meaning-based memory search, for bundling into release packages.

CI runs this before packaging the desktop app and the Docker image, next to
fetch_wake_model.py (assets/ ships inside both); run.sh / run.bat run it on
first setup. The 4-bit ONNX export from onnx-community, pinned to a revision.
Without it the server keeps keyword-only recall. Output:
assets/models/embeddinggemma-2/ (gitignored - models are fetched, never
committed).

    python scripts/fetch_embed_model.py
"""
import shutil
import tempfile
import urllib.request
from pathlib import Path

REPO = "onnx-community/embeddinggemma-2-ONNX"
REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
# Keep in sync with server/memory_vectors.py.
FILES = ("onnx/model_q4.onnx", "onnx/model_q4.onnx_data", "tokenizer.json")
OUT_DIR = Path(__file__).resolve().parents[1] / "assets" / "models" / "embeddinggemma-2"


def fetch(path):
    out_path = OUT_DIR / Path(path).name
    if out_path.is_file():
        print(f"{out_path} already present, skipping")
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{path}"
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / out_path.name
        print(f"downloading {url} …")
        with urllib.request.urlopen(url, timeout=120) as resp, open(tmp_path, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        shutil.move(str(tmp_path), str(out_path))
    print(f"wrote {out_path} ({out_path.stat().st_size // (1 << 20)} MB)")


if __name__ == "__main__":
    for path in FILES:
        fetch(path)
