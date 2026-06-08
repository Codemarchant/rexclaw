# Copyright 2026 Codemarchant
"""Avatar pack management routes — the desktop avatar editor's backend.

Round-trips through the manifest file (see avatar_packs management helpers):
uploads land in the pack folder, save() writes avatar.json and re-scans, so
the DB is always derived from the on-disk pack. Only data/avatars packs are
editable; bundled assets/avatars packs are read-only.
"""
import logging

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile

from .. import avatar_packs, store
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
        out.append(d)
    return out


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
    if payload.get("is_new"):
        pack_key = avatar_packs.rename_pack(con, pack_key, manifest.get("name") or pack_key)
    avatar_id = avatar_packs.write_manifest(con, pack_key, manifest)
    return {"ok": True, "avatar_id": avatar_id, "pack_key": pack_key}


@router.post("/delete")
def delete(payload: dict = Body(default={}), con=Depends(db_con)):
    """Delete a user pack (folder + DB row). Agents using it fall back to no
    avatar."""
    pack_key = payload.get("pack_key")
    avatar_packs.delete_pack(con, pack_key)
    return {"ok": True}
