#!/usr/bin/env bash
# One-command start for Rexclaw Companions (Linux / macOS / WSL).
#
#   ./run.sh
#
# First run: creates the Python venv, installs backend deps, and builds the
# frontend if web/dist/ is missing. Subsequent runs skip straight to launch.
# Set REXCLAW_NO_BROWSER=1 to suppress auto-opening the browser.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${REXCLAW_PORT:-8990}"
VENV=".venv"
PY="$VENV/bin/python"

# ---- Python venv + backend deps --------------------------------------------
# A venv that was moved/copied from another path is silently broken (its
# scripts hard-code the old location), so probe it by actually importing the
# deps rather than just checking the folder exists.
if ! "$PY" -c "import fastapi, uvicorn, requests" >/dev/null 2>&1; then
    echo "[rexclaw] setting up Python environment…"
    rm -rf "$VENV"
    if command -v uv >/dev/null 2>&1; then
        uv venv "$VENV"
        uv pip install --python "$PY" -e .
    else
        PYBIN="$(command -v python3 || command -v python)"
        "$PYBIN" -m venv "$VENV" || {
            echo "[rexclaw] venv creation failed — on Debian/Ubuntu: sudo apt install python3-venv" >&2
            exit 1
        }
        "$PY" -m pip install --quiet --upgrade pip
        "$PY" -m pip install --quiet -e .
    fi
fi

# ---- Frontend build (only when web/dist is missing) -------------------------
if [ ! -f web/dist/index.html ]; then
    if ! command -v npm >/dev/null 2>&1; then
        echo "[rexclaw] web/dist/ is missing and npm is not installed." >&2
        echo "          Install Node.js (https://nodejs.org), then re-run ./run.sh" >&2
        exit 1
    fi
    echo "[rexclaw] building frontend (first run only)…"
    (cd web && [ -d node_modules ] || npm install --no-fund --no-audit)
    # A node_modules that was moved/copied from another path has broken .bin
    # symlinks (same failure mode as a moved venv) — on build failure, wipe
    # and reinstall once before giving up.
    if ! (cd web && npm run build); then
        echo "[rexclaw] build failed — reinstalling node_modules and retrying…"
        (cd web && rm -rf node_modules && npm install --no-fund --no-audit && npm run build)
    fi
fi

# ---- Launch ------------------------------------------------------------------
URL="http://localhost:$PORT"
if [ "${REXCLAW_NO_BROWSER:-0}" != "1" ]; then
    # Open the browser once the server is up. Best-effort per platform;
    # wslview covers WSL → Windows browser.
    (
        sleep 2
        if command -v wslview >/dev/null 2>&1; then wslview "$URL"
        elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
        elif command -v open >/dev/null 2>&1; then open "$URL"
        fi
    ) >/dev/null 2>&1 &
fi

echo "[rexclaw] starting at $URL  (Ctrl+C to stop)"
exec "$PY" -m uvicorn server.main:app --port "$PORT"
