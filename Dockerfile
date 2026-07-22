# Rexclaw Companions — self-hosted container.
#
#   docker compose up -d          # or:
#   docker build -t rexclaw . && docker run -p 8990:8990 -v rexclaw-data:/data rexclaw
#
# The image bundles the built frontend, so neither Python nor Node is needed
# on the host. All state (SQLite DB, generated images, user avatar packs)
# lives in /data — mount a volume there or it vanishes with the container.
#
# SECURITY: the app has no authentication and the container binds 0.0.0.0 —
# anyone who can reach the port can talk on your xAI key. Keep the port
# published on a trusted network only, or put it behind an authenticating
# reverse proxy. See the Docker section in README.md (including why mic/VR
# need HTTPS or a localhost tunnel when accessed from other devices).

# ---- Stage 1: frontend build -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

# ---- Stage 2: runtime --------------------------------------------------------
FROM python:3.12-slim
WORKDIR /app

# Backend deps via the package itself (mirrors run.sh's `pip install -e .`),
# then drop the site-packages copy of the app: server/db.py resolves assets/
# and web/dist relative to the server package's location, so the app MUST run
# from the /app source tree below — an importable site-packages copy resolving
# into site-packages/assets is exactly the wrong one.
COPY pyproject.toml ./
COPY server/ server/
RUN pip install --no-cache-dir . && pip uninstall -y -q rexclaw

# Read-only bundled resources, laid out exactly as the source tree expects
# (server/db.py resolves assets/ and web/dist relative to the repo root).
COPY assets/ assets/
COPY --from=web /build/dist web/dist

ENV REXCLAW_DATA_DIR=/data \
    REXCLAW_HOST=0.0.0.0 \
    REXCLAW_PORT=8990
VOLUME /data
EXPOSE 8990

# `python -m` from /app so the source-tree server package (next to assets/
# and web/dist) is the one imported. main.py's run() reads REXCLAW_HOST/PORT.
CMD ["python", "-m", "server.main"]
