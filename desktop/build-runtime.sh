#!/usr/bin/env bash
# Builds the embedded Python runtime for the packaged desktop app (macOS and
# Linux) — the counterpart of build-runtime.ps1.
#
#     bash build-runtime.sh
#
# Output: desktop/runtime/python/ — a self-contained interpreter with the
# server dependencies installed. electron-builder ships it as resources/python
# (Contents/Resources/python inside the macOS .app) and main.js
# resolvePython() finds bin/python3 there at run time. Re-run whenever
# pyproject.toml dependencies change.
#
# Run it on the platform you are packaging for (or the matching CI runner):
# pip picks wheels for the machine it runs on, so a bundle built elsewhere
# would carry the wrong native extensions.
set -euo pipefail

# Keep in sync with build-runtime.ps1. PBS_RELEASE is the
# python-build-standalone release that carries this exact CPython build.
PYTHON_VERSION="${PYTHON_VERSION:-3.12.8}"
PBS_RELEASE="${PBS_RELEASE:-20250115}"

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$DESKTOP")"
RUNTIME="${RUNTIME_DIR:-$DESKTOP/runtime}"
PY_DIR="$RUNTIME/python"
PY_EXE="$PY_DIR/bin/python3"
# PBS honours the user site (~/.local/lib/pythonX.Y) like any CPython — keep
# pip from resolving against, or uninstalling from, the builder's own packages.
export PYTHONNOUSERSITE=1

case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
    Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
    *) echo "[runtime] unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

# --- 1. Fetch + extract python-build-standalone ------------------------------
# The install_only_stripped flavour is a relocatable CPython (no debug
# symbols) that unpacks to python/bin/python3 — the layout main.js expects.
# Unlike the Windows embeddable package there is no ._pth to rewrite: the
# server runs as `python -m uvicorn` with cwd = app-server, which puts the
# bundled source on sys.path by itself.
mkdir -p "$RUNTIME"
rm -rf "$PY_DIR"
ASSET="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${TRIPLE}-install_only_stripped.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${ASSET}"
echo "[runtime] downloading $URL"
curl -fsSL "$URL" -o "$RUNTIME/python.tar.gz"
tar -xzf "$RUNTIME/python.tar.gz" -C "$RUNTIME"
rm "$RUNTIME/python.tar.gz"

# --- 2. Install the server dependencies (NOT the project itself) -------------
# Same reasoning as the Windows script: the server runs from the bundled
# source tree so its Path(__file__)-relative assets/web-dist lookups
# resolve; only third-party deps go to site-packages. PBS ships pip already.
REQS="$RUNTIME/requirements.txt"
"$PY_EXE" -c "import sys, tomllib; deps = tomllib.load(open(sys.argv[1], 'rb'))['project']['dependencies']; open(sys.argv[2], 'w').write('\n'.join(deps))" \
    "$REPO_ROOT/pyproject.toml" "$REQS"
echo "[runtime] installing:"; cat "$REQS"; echo
"$PY_EXE" -m pip install --disable-pip-version-check --no-warn-script-location -r "$REQS"
rm "$REQS"

# --- 3. Slim + smoke test ----------------------------------------------------
find "$PY_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} +
"$PY_EXE" -c "import fastapi, uvicorn, requests, multipart, numpy, onnxruntime, soundfile; print('[runtime] import smoke test OK')"
# websockets (xAI streaming STT/TTS) and the Twitch chat client use the
# interpreter's default SSL context rather than certifi — make sure it
# actually finds the OS trust store on this platform. A real handshake, since
# a capath trust store (Linux /etc/ssl/certs) loads lazily and reports empty.
"$PY_EXE" -c "import socket, ssl; s = ssl.create_default_context().wrap_socket(socket.create_connection(('pypi.org', 443), timeout=15), server_hostname='pypi.org'); print('[runtime] default SSL context verifies:', s.version()); s.close()"

echo "[runtime] done: $PY_DIR ($(du -sh "$PY_DIR" | cut -f1))"
echo "[runtime] next: npx electron-builder --mac / --linux  (packages shell + server + this runtime)"
