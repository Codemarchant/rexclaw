# Copyright 2026 Codemarchant
"""Avatar portraits: the thumbnail a VRM file carries in its own metadata
(VRM 0.x ``meta.texture``, VRM 1.0 ``meta.thumbnailImage`` — VRoid Studio
always writes one, face-framed), extracted and downscaled once per file
version and cached under the data dir. No rendering involved, so it works
headless (Docker) and stays a pure function of the main VRM: swap the file
and the portrait follows on the next request.

A generated sidecar — ``<stem>.portrait.png`` next to the VRM, written by
the avatar editor's Generate portrait button from a browser render — takes
precedence over the embedded thumbnail. The VRM itself is never modified
(its author's modification permission stays intact), a blank or bad
embedded thumbnail can be overridden, and re-generating simply overwrites
the sidecar. Files with neither (hand-exported from Blender/UniVRM) get a
negative cache marker so the list views don't re-parse them; the UI falls
back to a generic icon.
"""
import hashlib
import io
import json
import logging
import struct
from pathlib import Path
from urllib.parse import quote

from .db import ASSETS_DIR, DATA_DIR, FILES_DIR

_logger = logging.getLogger(__name__)

CACHE_DIR = DATA_DIR / "cache" / "portraits"
PORTRAIT_SIZE = 384   # px, square-ish source → fits list rows and editor headers
CACHE_VERSION = 5     # bump when the processing changes so cached files regenerate

_GLB_MAGIC = b"glTF"
_warned_no_pillow = False
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942


def vrm_disk_path(web_path):
    """Map a served VRM web path to its file, or None when it isn't one of
    ours. The roots mirror the StaticFiles mounts in main.py."""
    from .avatar_packs import USER_ASSETS_DIR, USER_PACKS_DIR   # circular at import time
    roots = {
        "/assets/": ASSETS_DIR,
        "/avatars/": USER_PACKS_DIR,
        "/user-assets/": USER_ASSETS_DIR,
        "/files/": FILES_DIR,
    }
    if not isinstance(web_path, str):
        return None
    for prefix, root in roots.items():
        if web_path.startswith(prefix):
            candidate = (root / web_path[len(prefix):]).resolve()
            try:
                candidate.relative_to(root.resolve())
            except ValueError:
                return None   # traversal attempt
            return candidate if candidate.is_file() else None
    return None


def sidecar_path(vrm_disk):
    """Where a generated portrait for this VRM lives: ``<stem>.portrait.png``
    beside it (inside the pack folder, so pack exports carry it)."""
    return vrm_disk.with_name(f"{vrm_disk.stem}.portrait.png")


def extract_vrm_thumbnail(path):
    """(mime, bytes) of the thumbnail embedded in a .vrm/.glb, or None."""
    with open(path, "rb") as fh:
        head = fh.read(12)
        if len(head) < 12 or head[:4] != _GLB_MAGIC:
            return None
        clen, ctype = struct.unpack("<II", fh.read(8))
        if ctype != _CHUNK_JSON:
            return None
        gltf = json.loads(fh.read(clen))
        blen, btype = struct.unpack("<II", fh.read(8))
        if btype != _CHUNK_BIN:
            return None
        bin_offset = fh.tell()

        ext = gltf.get("extensions") or {}
        image_idx = None
        if "VRMC_vrm" in ext:
            image_idx = (ext["VRMC_vrm"].get("meta") or {}).get("thumbnailImage")
        elif "VRM" in ext:
            tex = (ext["VRM"].get("meta") or {}).get("texture")
            if isinstance(tex, int) and tex >= 0:
                textures = gltf.get("textures") or []
                if tex < len(textures):
                    image_idx = textures[tex].get("source")
        if not isinstance(image_idx, int):
            return None
        images = gltf.get("images") or []
        if not 0 <= image_idx < len(images):
            return None
        image = images[image_idx]
        bv_idx = image.get("bufferView")
        views = gltf.get("bufferViews") or []
        if not isinstance(bv_idx, int) or not 0 <= bv_idx < len(views):
            return None
        bv = views[bv_idx]
        fh.seek(bin_offset + bv.get("byteOffset", 0))
        return image.get("mimeType") or "image/png", fh.read(bv["byteLength"])


def _source_file(web_path):
    """The file the portrait derives from — the sidecar when present, else
    the VRM itself — or None when the path isn't a VRM we serve."""
    disk = vrm_disk_path(web_path)
    if not disk:
        return None
    side = sidecar_path(disk)
    return side if side.is_file() else disk


def portrait_source(web_path):
    """Full-resolution (mime, bytes) of the portrait image for a served VRM
    path — generated sidecar first, else the embedded thumbnail — or None.
    Feeds the text-mode selfie, which wants the original pixels rather than
    the 384px list-row cache."""
    src = _source_file(web_path)
    if not src:
        return None
    if src.suffix == ".png" and src.name.endswith(".portrait.png"):
        return "image/png", src.read_bytes()
    try:
        return extract_vrm_thumbnail(src)
    except Exception as e:
        _logger.warning("portrait: could not read %s: %s", web_path, e)
        return None


def _cache_key(disk_path):
    st = disk_path.stat()
    raw = f"{disk_path}|{st.st_mtime_ns}|{st.st_size}|{PORTRAIT_SIZE}|{CACHE_VERSION}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def portrait_file(web_path):
    """Cached portrait JPEG for a VRM web path — built on first call — or
    None when there is neither a sidecar nor an embedded thumbnail (or the
    path isn't a VRM we serve)."""
    src = _source_file(web_path)
    if not src:
        return None
    key = _cache_key(src)
    out = CACHE_DIR / f"{key}.jpg"
    none_marker = CACHE_DIR / f"{key}.none"
    if out.is_file():
        return out
    if none_marker.is_file():
        return None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
    except ImportError:
        # Missing dependency is an environment problem, not a property of
        # the file — never record it as "no thumbnail". Warn once per process.
        global _warned_no_pillow
        if not _warned_no_pillow:
            _warned_no_pillow = True
            _logger.warning("portrait: Pillow is not installed (pip install -e . / run.sh) — portraits disabled")
        return None
    try:
        found = portrait_source(web_path)
        if not found:
            none_marker.touch()
            return None
        img = Image.open(io.BytesIO(found[1]))
        if img.mode in ("RGBA", "LA", "P"):
            # Flatten any transparency onto white — VRoid thumbnails are
            # opaque, but a hand-made one (or a rendered sidecar) may not be.
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
            img = bg
        img.thumbnail((PORTRAIT_SIZE, PORTRAIT_SIZE))
        tmp = out.with_suffix(".tmp")
        img.save(tmp, "JPEG", quality=86, optimize=True)
        tmp.replace(out)
        return out
    except Exception as e:
        # Unreadable/odd file: log and skip this time, but leave no marker —
        # a transient error (locked file mid-upload) shouldn't stick.
        _logger.warning("portrait: could not build for %s: %s", web_path, e)
        return None


def portrait_url(web_path):
    """URL the UI can <img> for this VRM's portrait, or None. Carries the
    source file's version so browsers cache aggressively yet pick up a
    swapped VRM or a regenerated sidecar."""
    if not portrait_file(web_path):
        return None
    src = _source_file(web_path)
    return f"/api/avatars/portrait?vrm={quote(web_path, safe='/')}&v={src.stat().st_mtime_ns}"
