# Copyright 2026 Codemarchant
"""Settings → Extensions: what was found, and which to load next start.

Extension-owned routes live under /api/plugins/<id>/ (plugins.py); this
router only manages the list, so the two prefixes never collide.
"""
from fastapi import APIRouter, Body

from .. import plugins
from ..errors import UserError

router = APIRouter(prefix="/api/extensions")


def _payload():
    settings = plugins.read_settings()
    return {
        'extensions': plugins.listing(),
        'dirs': settings['dirs'],
        'default_dir': str(plugins.DEFAULT_ROOT),
    }


@router.post("/list")
def extensions_list():
    return _payload()


@router.post("/save")
def extensions_save(payload: dict = Body(default={})):
    """Store which extensions to skip and the extra folders to search. Takes
    effect on the next start: extensions load once, while the app starts."""
    disabled = payload.get('disabled')
    dirs = payload.get('dirs')
    if not isinstance(disabled, list) or not isinstance(dirs, list):
        raise UserError('disabled and dirs must be lists.')
    plugins.write_settings({
        'disabled': sorted({str(x) for x in disabled}),
        'dirs': [d for d in dict.fromkeys(str(x).strip() for x in dirs) if d],
    })
    return _payload()
