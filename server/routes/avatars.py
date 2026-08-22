# Copyright 2026 Codemarchant
"""Avatar pack management routes — the desktop avatar editor's backend.

Round-trips through the manifest file (see avatar_packs management helpers):
uploads land in the pack folder, save() writes avatar.json and re-scans, so
the DB is always derived from the on-disk pack. Only data/avatars packs are
editable; bundled assets/avatars packs are read-only.
"""
import base64
import logging
import os
import shutil
import tempfile
import zipfile

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .. import avatar_packs, portraits, store, transfer
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/avatars")


@router.post("/manage_list")
def manage_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """Every avatar, with an `editable` flag and the agents using it — drives
    the manager's list view."""
    rows = con.execute(
        "SELECT a.id, a.pack_key, a.name, a.vrm_path,"
        " (SELECT COUNT(*) FROM avatar_outfits o WHERE o.avatar_id = a.id) AS outfit_count,"
        " (SELECT COUNT(*) FROM avatar_gestures g WHERE g.avatar_id = a.id) AS gesture_count,"
        " (SELECT COUNT(*) FROM avatar_backgrounds b WHERE b.avatar_id = a.id) AS background_count,"
        " (SELECT GROUP_CONCAT(ag.name, ', ') FROM agents ag WHERE ag.avatar_id = a.id) AS used_by"
        " FROM avatars a WHERE a.active = 1 ORDER BY a.sequence, a.name",
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["editable"] = bool(r["pack_key"]) and avatar_packs.pack_is_editable(r["pack_key"])
        d["portrait_url"] = portraits.portrait_url(r["vrm_path"])
        out.append(d)
    return out


@router.get("/portrait")
def portrait(vrm: str, v: str = ""):
    """The portrait JPEG for a served VRM path (see server/portraits.py).
    `v` is only a cache-buster; the file is keyed by the VRM's mtime/size."""
    path = portraits.portrait_file(vrm)
    if not path:
        raise UserError("No portrait for that avatar.")
    return FileResponse(str(path), media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.post("/set_portrait")
def set_portrait(payload: dict = Body(default={}), con=Depends(db_con)):
    """Store a browser-rendered portrait PNG as a sidecar beside a user
    pack's VRM (see portraits.sidecar_path). The VRM itself is never
    modified — its author's modification permission stays intact — and the
    sidecar wins over the embedded thumbnail, so this also overrides a blank
    or bad one; re-generating simply overwrites it. Pack exports include
    every file in the folder, so it travels with the avatar. Returns the
    fresh portrait_url."""
    pack_key = payload.get("pack_key")
    filename = payload.get("filename") or ""
    if not filename.lower().endswith(".vrm"):
        raise UserError("Portraits belong to .vrm files.")
    vrm = avatar_packs.pack_file_path(pack_key, filename)
    data = payload.get("image_data_url") or ""
    if not isinstance(data, str) or not data.startswith("data:image/png;base64,"):
        raise UserError("image_data_url must be a data:image/png base64 URI.")
    try:
        png = base64.b64decode(data.split(",", 1)[1], validate=True)
    except Exception:
        raise UserError("image_data_url is not valid base64.")
    if not png or len(png) > 10 * 1024 * 1024:
        raise UserError("Image must be between 1 byte and 10 MB.")
    side = portraits.sidecar_path(vrm)
    tmp = side.with_suffix(".tmp")
    tmp.write_bytes(png)
    tmp.replace(side)
    return {"ok": True,
            "portrait_url": portraits.portrait_url(f"/avatars/{pack_key}/{filename}")}


@router.post("/create")
def create(payload: dict = Body(default={}), con=Depends(db_con)):
    """Allocate an empty user pack and return its key. The avatar isn't real
    until a main VRM is uploaded and /save runs."""
    # Name is optional here — the editor opens immediately and collects it as
    # a required field, validated on save. The pack folder just needs *a* key
    # so uploads have somewhere to land; it defaults to "avatar".
    name = (payload.get("name") or "avatar").strip()
    key = avatar_packs.create_pack(name)
    return {"ok": True, "pack_key": key}


@router.post("/upload")
async def upload(
    pack_key: str = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    con=Depends(db_con),
):
    """Multipart upload of a VRM/VRMA/GLB/image into the pack folder. Returns
    the stored filename for the manifest to reference."""
    content = await file.read()
    filename = avatar_packs.save_upload(pack_key, kind, file.filename, content)
    return {"ok": True, "filename": filename}


@router.post("/shared_assets")
def shared_assets(payload: dict = Body(default={}), con=Depends(db_con)):
    """Files in the shared library (data/assets + bundled glb/vrma dirs),
    optionally filtered by upload kind — drives the editor's library picker
    so one dropped file serves every avatar without re-uploading."""
    return avatar_packs.list_shared_assets(payload.get("kind"))


@router.post("/get")
def get(payload: dict = Body(default={}), con=Depends(db_con)):
    """Load a user pack's manifest (+ the files present) for editing."""
    pack_key = payload.get("pack_key")
    manifest = avatar_packs.read_manifest(pack_key)
    return {"pack_key": pack_key, "manifest": manifest,
            "files": avatar_packs.list_pack_files(pack_key)}


@router.post("/save")
def save(payload: dict = Body(default={}), con=Depends(db_con)):
    """Validate + write the manifest, re-scan the pack, return the avatar id."""
    pack_key = payload.get("pack_key")
    manifest = payload.get("manifest")
    if not isinstance(manifest, dict):
        raise UserError("Missing manifest.")
    # On a brand-new avatar, finalize the folder name to match the display
    # name before writing — so the pack folder is human-readable / shareable.
    # Validate first: rename_pack drops the old key, so failing validation
    # after the rename would strand the editor on a pack_key that no longer
    # exists (every retry then errors with "pack not found").
    if payload.get("is_new"):
        avatar_packs.validate_manifest(pack_key, manifest)
        pack_key = avatar_packs.rename_pack(con, pack_key, manifest.get("name") or pack_key)
    avatar_id = avatar_packs.write_manifest(con, pack_key, manifest)
    return {"ok": True, "avatar_id": avatar_id, "pack_key": pack_key}


@router.post("/duplicate")
def duplicate(payload: dict = Body(default={}), con=Depends(db_con)):
    """Copy a pack (bundled or user) into a new editable user pack. The new
    display name (required, chosen by the user) also names the folder."""
    r = avatar_packs.duplicate_pack(con, payload.get("pack_key"), payload.get("name"))
    return {"ok": True, **r}


@router.post("/delete")
def delete(payload: dict = Body(default={}), con=Depends(db_con)):
    """Delete a user pack (folder + DB row). Agents using it fall back to no
    avatar."""
    pack_key = payload.get("pack_key")
    avatar_packs.delete_pack(con, pack_key)
    return {"ok": True}


@router.get("/export")
def export(pack_key: str):
    """Download a pack (bundled or user) as a self-contained zip — the
    "drop a folder into data/avatars/" convention, in a file. GET so the
    browser/Electron streams it to disk; VRM packs run to hundreds of MB."""
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            transfer.add_pack_to_zip(zf, pack_key)
    except Exception:
        os.unlink(tmp.name)
        raise
    return FileResponse(
        tmp.name, media_type="application/zip",
        filename=f"{pack_key}-avatar-pack.zip",
        background=BackgroundTask(os.unlink, tmp.name),
    )


@router.post("/import")
def import_pack(file: UploadFile = File(...), con=Depends(db_con)):
    """Import an avatar pack zip (avatar.json at the root or inside a single
    wrapping folder) as a new editable user pack."""
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        path = tmp.name
    try:
        with zipfile.ZipFile(path) as zf:
            result = transfer.import_pack_from_zip(con, zf, transfer.pack_prefix_in_zip(zf))
        con.commit()
        return {"ok": True, **result}
    except zipfile.BadZipFile:
        raise UserError("Not a zip file.")
    finally:
        os.unlink(path)
