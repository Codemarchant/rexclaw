# Copyright 2026 Codemarchant
"""neural_model.bin: named byte sections in one file.

b"RXNM", u32 version, u32 index length, then the index (JSON: name ->
[offset, length], offsets from the end of the index) and the sections.
Every byte after the first 12 is XORed with KEY at its file offset.
"""

import hashlib
import json
import struct

import numpy as np

MAGIC = b"RXNM"
VERSION = 2
# SHA-256 blocks, not a random generator: the same bytes on every Python and NumPy.
KEY = b"".join(hashlib.sha256(b"rexclaw neural model %d" % i).digest() for i in range(128))   # 4096 bytes
_HEAD = struct.Struct("<4sII")
_BLOCK = 256 * len(KEY)      # 1 MiB at a time: memory stays near the data's own size


def _xor(data, start):
    """`data` (bytes) XOR the key from file offset `start`."""
    arr = np.frombuffer(data, np.uint8)
    shift = start % len(KEY)
    key = np.frombuffer(KEY[shift:] + KEY[:shift], np.uint8)
    tile = np.tile(key, _BLOCK // len(KEY))
    out = np.empty_like(arr)
    for i in range(0, len(arr), _BLOCK):
        n = min(_BLOCK, len(arr) - i)
        np.bitwise_xor(arr[i:i + n], tile[:n], out=out[i:i + n])
    return out.tobytes()


def write(sections):
    """{name: bytes} -> the file's bytes."""
    offsets, at = {}, 0
    for name, data in sections.items():
        offsets[name] = [at, len(data)]
        at += len(data)
    index = json.dumps(offsets).encode()
    body = b"".join(sections.values())
    return _HEAD.pack(MAGIC, VERSION, len(index)) + _xor(index, _HEAD.size) + _xor(body, _HEAD.size + len(index))


class Pack:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            magic, version, size = _HEAD.unpack(f.read(_HEAD.size))
            if magic != MAGIC or version != VERSION:
                raise ValueError(f"{path}: not a neural_model pack")
            self.index = json.loads(_xor(f.read(size), _HEAD.size))
        self.base = _HEAD.size + size

    def __contains__(self, name):
        return name in self.index

    def read(self, name):
        offset, length = self.index[name]
        offset += self.base
        with open(self.path, "rb") as f:
            f.seek(offset)
            return _xor(f.read(length), offset)
