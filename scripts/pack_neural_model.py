# Copyright 2026 Codemarchant
"""Packs a neural motion model's graphs and constants into the one file the
app ships: server/neural_motion/models/neural_model/neural_model.bin.

    python scripts/pack_neural_model.py data/models/neural_model

Reads <dir>/{student,prefix,generator,decoder,inbetween}.onnx and
constants.npz, plus rest_bank.npy if there (still poses, normalized frames,
for the in-between's end; see the adapter's rest_near); the style names come
from the adapter's styles.json. Weight
tensors are stored as float16 (the adapter widens them back to float32 when
it loads them), and the file is scrambled with the adapter's key. Needs the
`onnx` package (pip install onnx); the app itself only needs onnxruntime.
"""

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = Path(__file__).resolve().parent.parent
ADAPTER = ROOT / "server/neural_motion/models/neural_model"


def _pack_module():
    """The adapter's pack.py by path: importing the package would load the app."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("neural_model_pack", ADAPTER / "pack.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GRAPHS = ("student", "prefix", "generator", "decoder", "inbetween")
SMALL = 16     # tensors this size or under stay inside the graph


def strip(path):
    """A graph with its float weights moved out: (graph bytes, {name: float16 array})."""
    model = onnx.load(path)
    tensors = {}
    for init in model.graph.initializer:
        if init.data_type != onnx.TensorProto.FLOAT or np.prod(init.dims) <= SMALL:
            continue
        tensors[init.name] = numpy_helper.to_array(init).astype(np.float16)
        init.ClearField("raw_data")
        init.ClearField("float_data")
        init.data_location = onnx.TensorProto.EXTERNAL
        del init.external_data[:]
        for key, value in (("location", "packed"), ("offset", "0"), ("length", str(tensors[init.name].size * 4))):
            entry = init.external_data.add()
            entry.key, entry.value = key, value
    return model.SerializeToString(), tensors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("--out", type=Path, default=ADAPTER / "neural_model.bin")
    a = ap.parse_args()

    names = [s["name"] for s in json.loads((ADAPTER / "styles.json").read_text())]
    c = dict(np.load(a.source / "constants.npz"))
    if len(names) != len(c["style_names"]):
        sys.exit(f"styles.json names {len(names)} styles, the model has {len(c['style_names'])}")
    c["style_names"] = np.array(names)
    if (a.source / "rest_bank.npy").is_file():
        c["rest_bank"] = np.load(a.source / "rest_bank.npy").astype(np.float32)
    buffer = io.BytesIO()
    np.savez(buffer, **c)

    sections = {"constants": buffer.getvalue()}
    for g in GRAPHS:
        graph, tensors = strip(a.source / f"{g}.onnx")
        sections[f"{g}.graph"] = graph
        buffer = io.BytesIO()
        np.savez(buffer, **tensors)
        sections[f"{g}.weights"] = buffer.getvalue()
    a.out.write_bytes(_pack_module().write(sections))
    print(f"{a.out}: {a.out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
