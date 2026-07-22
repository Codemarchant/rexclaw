# Copyright 2026 Codemarchant
"""FastAPI app: API routes + static assets + built-SPA serving.

Dev:   uvicorn server.main:app --reload   (+ `npm run dev` in web/ — the Vite
       dev server proxies /api, /assets and /files here)
Prod:  npm run build in web/, then this app serves web/dist directly.
"""
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .avatar_packs import USER_PACKS_DIR, scan_packs
from .db import ASSETS_DIR, FILES_DIR, connect, init_db
from .errors import UserError
from .routes import avatars, misc, text, voice
from .seeds import seed_if_empty

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
_logger = logging.getLogger(__name__)

WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

app = FastAPI(title="Rexclaw Companions", docs_url=None, redoc_url=None)


@app.exception_handler(UserError)
async def user_error_handler(request: Request, exc: UserError):
    # Shape matches what the frontend rpc helper expects: {error: {message}}.
    return JSONResponse(
        status_code=getattr(exc, "status_code", 400),
        content={"error": {"message": str(exc)}},
    )


@app.on_event("startup")
def startup():
    init_db()
    con = connect()
    try:
        # Packs first, agent seeding second — the preset agents link to the
        # bundled packs by pack_key. Re-scanning every boot also picks up
        # manifest edits and freshly dropped packs in data/avatars/.
        scan_packs(con)
        seed_if_empty(con)
    finally:
        con.close()
    _logger.info("Rexclaw Companions server ready.")


app.include_router(voice.router)
app.include_router(text.router)
app.include_router(misc.router)
app.include_router(avatars.router)

# Bundled VRM/VRMA/GLB assets + generated/uploaded files + user avatar packs.
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
FILES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(FILES_DIR)), name="files")
USER_PACKS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/avatars", StaticFiles(directory=str(USER_PACKS_DIR)), name="avatars")

# Built SPA (production). In dev the Vite server owns the page instead.
if WEB_DIST.is_dir():
    # Vite emits hashed bundles under dist/app-assets (renamed from the
    # default `assets/` to avoid colliding with the VRM/VRMA/GLB mount).
    app.mount("/app-assets", StaticFiles(directory=str(WEB_DIST / "app-assets")), name="app-assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = WEB_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")


def run():
    """Console-script entry point: `rexclaw`.

    REXCLAW_HOST widens the bind address (Docker / LAN hub use — the compose
    file sets 0.0.0.0). Default stays loopback-only: the app has no
    authentication, so anyone who can reach the port can talk on your xAI
    key. REXCLAW_PORT mirrors what run.sh/run.bat already honour.
    """
    import os
    import uvicorn
    host = os.environ.get("REXCLAW_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("REXCLAW_PORT", "8990"))
    except ValueError:
        port = 8990
    uvicorn.run("server.main:app", host=host, port=port)


if __name__ == "__main__":
    run()
