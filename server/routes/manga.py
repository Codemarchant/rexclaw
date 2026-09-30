# Copyright 2026 Codemarchant
"""Manga Diary routes (History → Manga). See server/manga.py."""
from fastapi import APIRouter, Body, Depends

from .. import manga
from .common import coerce_int, db_con

router = APIRouter(prefix="/api/manga")


def _optional_id(payload, key):
    value = payload.get(key)
    return coerce_int(value, key) if value else None


@router.post("/list")
def manga_list(payload: dict = Body(default={}), con=Depends(db_con)):
    return manga.list_pages(con)


@router.post("/sources")
def manga_sources(payload: dict = Body(default={}), con=Depends(db_con)):
    return manga.list_sources(con)


@router.post("/script")
def manga_script(payload: dict = Body(default={}), con=Depends(db_con)):
    """Storyboard an episode or a conversation's latest stretch. Slow (a
    model call over the transcript), so the browser shows its own progress."""
    source = payload.get("source") or "episode"
    return manga.generate_script(
        con,
        source=source,
        source_id=coerce_int(payload.get("source_id"), "source_id") if source in ("episode", "recent") else None,
        source_ids=payload.get("source_ids") if isinstance(payload.get("source_ids"), list) else [],
        text=payload.get("text") or "",
        agent_id=_optional_id(payload, "agent_id"),
        layout=payload.get("layout") or "page",
        focus=payload.get("focus") or "",
        art=payload.get("art") or "photo",
        pages=payload.get("pages") or 1,
        chapter_id=_optional_id(payload, "chapter_id"),
        cast=payload.get("cast") if isinstance(payload.get("cast"), list) else [],
    )


@router.post("/paint")
def manga_paint(payload: dict = Body(default={}), con=Depends(db_con)):
    """Grok Imagine art for one panel (the optional Imagine extra)."""
    return manga.paint_panel(
        con,
        agent_id=coerce_int(payload.get("agent_id"), "agent_id"),
        script=payload.get("script"),
        index=coerce_int(payload.get("index"), "index"),
        mode=payload.get("mode"),
        aspect=payload.get("aspect"),
    )


@router.post("/save")
def manga_save(payload: dict = Body(default={}), con=Depends(db_con)):
    return manga.save_page(
        con,
        agent_id=coerce_int(payload.get("agent_id"), "agent_id"),
        session_id=_optional_id(payload, "session_id"),
        episode_id=_optional_id(payload, "episode_id"),
        script=payload.get("script"),
        image_data_url=payload.get("image_data_url"),
        page_id=_optional_id(payload, "page_id"),
    )


@router.post("/delete")
def manga_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    manga.delete_page(con, coerce_int(payload.get("id"), "id"))
    return {"ok": True}
