#!/usr/bin/env python3
"""Embed (or replace) the metadata thumbnail in a .vrm file.

    python scripts/embed_vrm_thumbnail.py <model.vrm> <thumbnail.png> [out.vrm]

VRM 0.x: appends the PNG to the binary chunk as a new image + texture and
points ``extensions.VRM.meta.texture`` at it. VRM 1.0: same image, referenced
from ``extensions.VRMC_vrm.meta.thumbnailImage``. Writes in place unless an
output path is given. The portrait shown in Rexclaw's companion/avatar lists
is read from exactly this field (see server/portraits.py), so this is how a
non-VRoid model gets a profile picture.
"""
import json
import struct
import sys
from pathlib import Path

JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


def _pad(b, fill):
    return b + fill * (-len(b) % 4)


def embed(vrm_path, png_path, out_path=None):
    raw = Path(vrm_path).read_bytes()
    png = Path(png_path).read_bytes()
    if raw[:4] != b"glTF":
        raise SystemExit(f"{vrm_path}: not a glb/vrm")
    clen, ctype = struct.unpack_from("<II", raw, 12)
    assert ctype == JSON_CHUNK
    gltf = json.loads(raw[20:20 + clen])
    blen, btype = struct.unpack_from("<II", raw, 20 + clen)
    assert btype == BIN_CHUNK
    bin_start = 28 + clen
    bin_data = raw[bin_start:bin_start + blen]
    if len(gltf.get("buffers", [])) != 1:
        raise SystemExit("only single-buffer files are supported")

    # Append the PNG as a new bufferView / image / texture.
    bin_data = _pad(bin_data, b"\x00")
    gltf.setdefault("bufferViews", []).append(
        {"buffer": 0, "byteOffset": len(bin_data), "byteLength": len(png)})
    bin_data = _pad(bin_data + png, b"\x00")
    gltf["buffers"][0]["byteLength"] = len(bin_data)
    gltf.setdefault("images", []).append(
        {"name": "thumbnail", "mimeType": "image/png", "bufferView": len(gltf["bufferViews"]) - 1})
    image_idx = len(gltf["images"]) - 1

    ext = gltf.setdefault("extensions", {})
    if "VRMC_vrm" in ext:
        ext["VRMC_vrm"].setdefault("meta", {})["thumbnailImage"] = image_idx
    elif "VRM" in ext:
        tex = {"source": image_idx}
        if gltf.get("samplers"):
            tex["sampler"] = 0
        gltf.setdefault("textures", []).append(tex)
        ext["VRM"].setdefault("meta", {})["texture"] = len(gltf["textures"]) - 1
    else:
        raise SystemExit("no VRM extension found")

    json_bytes = _pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    out = b"".join([
        b"glTF", struct.pack("<II", 2, total),
        struct.pack("<II", len(json_bytes), JSON_CHUNK), json_bytes,
        struct.pack("<II", len(bin_data), BIN_CHUNK), bin_data,
    ])
    Path(out_path or vrm_path).write_bytes(out)
    return image_idx


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    idx = embed(*sys.argv[1:4])
    print(f"embedded thumbnail as image {idx}")
