<p align="center">
  <img src="docs/rexclaw_standalone_banner.jpg" alt="Rexclaw Companions" width="100%"/>
</p>

# Rexclaw Companions

**Living anime voice companions on your own machine — powered by xAI Grok Voice Realtime, self-hosted, bring-your-own-key.**

Talk to a 3D VRM avatar that lip-syncs, emotes, gestures and walks around her
scene while she answers you — with persistent memory that grows across
sessions, Grok Imagine image generation, file-aware text chat, and your own
MCP tools. Everything runs locally except the model itself: your data lives
in a SQLite file on your disk, and your API key never leaves your machine.

---

## ✨ Why it stands apart

| | |
|---|---|
| 🎙️ **Real-time voice** | Speech-in, speech-out via Grok Voice Realtime — sub-second latency, natural turn-taking with server VAD, barge-in that actually works. No STT/TTS pipeline to wire up. |
| 🌍 **Speaks any language** | Grok Voice is multilingual out of the box. Switch language mid-sentence — your companion follows. |
| 🧠 **Memory that grows with you** | Two layers: rolling in-session compaction keeps a conversation alive indefinitely (resume days later, she picks up where you left off), and durable cross-session memories — name, projects, preferences — reviewable and deletable in Settings. |
| 🧍 **Living 3D avatars** | three.js + @pixiv/three-vrm: viseme lip-sync from the live audio, idle breath/blink/eye-saccades, camera eye contact, emotions and body-language gestures the model triggers itself mid-conversation. |
| 🚶 **Walkable 3D scenes** | GLB environments as backgrounds with WASD/arrow walk mode and a trailing camera. A grid playground ships in the box. |
| 🎨 **Grok Imagine built in** | Ask her to redecorate (`change_background` swaps the live scene), generate images into the transcript, or edit photos you upload in chat. |
| 👥 **A fully written crew** | Eve, Ara, Rex, Sal and Leo — five companions with backstories, speech quirks and matching voices. Fork them or build your own. |
| 🔌 **Remote MCP tools** | Attach any number of remote MCP servers per companion, with bearer auth and per-tool whitelists — configured in the UI. |
| 🔒 **Self-hosted & BYOK** | One SQLite file, local image storage, a localhost-only server. The browser opens its realtime socket straight to xAI with a short-lived token — the long-lived key stays server-side on your machine. |

## 🚀 Quick start

```bash
./run.sh        # Linux / macOS / WSL
run.bat         # Windows
```

First run sets everything up (Python venv, backend deps, frontend build) and
opens http://localhost:8990. After that it skips straight to launch.
Requirements: Python ≥ 3.10 and Node.js.

Then in the app: **Settings → paste your xAI API key** (grab one at
[x.ai/api](https://x.ai/api)) → back to **Voice** → pick a companion → **Start**.

`REXCLAW_PORT` overrides the port; `REXCLAW_NO_BROWSER=1` skips the
auto-open; `REXCLAW_DATA_DIR` relocates the data folder. The script just
automates:

```bash
python3 -m venv .venv && .venv/bin/pip install -e .   # once
(cd web && npm install && npm run build)              # once, → web/dist/
.venv/bin/uvicorn server.main:app --port 8990         # every start
```

## 👥 Meet the crew

- **Eve** — caffeinated junior researcher. Reacts before she replies, narrates her lookups, gets genuinely excited about a good find.
- **Ara** — warm, patient, older-sister energy. The calm voice at the end of a busy day.
- **Rex** — half lobster, half man, all quartermaster. Mission-control brevity, calls you Captain, occasionally sings a bar of shanty when the books balance.
- **Sal** — philosophical frog who knows he's software and finds retirement interesting. Precise, comfortable with silence.
- **Leo** — veteran theatre stage manager. "Standby… go." Dignified, composed, earns every gesture.

All five are editable in **Settings → Companions** — prompt, voice, avatar,
and per-tool access. **New companion** starts you from a structured persona
template; **Restore presets** brings back any of the originals you've deleted.

## 🎭 Custom avatars — avatar packs

Avatars load from **packs**: a folder with an `avatar.json` manifest plus its
files. Bundled packs live in `assets/avatars/`; drop your own into
`data/avatars/` and restart the server (no rebuild — packs are data). They
then appear in the Avatar dropdown when editing a companion. The five bundled
packs double as worked examples.

```
data/avatars/Kira/
├── avatar.json
├── kira_default.vrm
├── kira_winter.vrm
├── wave.vrma
└── beach.glb
```

```json
{
  "name": "Kira",
  "vrm": "kira_default.vrm",
  "vrma_idle": "idle.vrma",
  "outfits": [
    {"name": "Winter", "vrm": "kira_winter.vrm",
     "description": "what it looks like / when to wear it — fed to the LLM"}
  ],
  "gestures": [
    {"enum": "wave_hello", "vrma": "wave.vrma", "loop": false,
     "description": "when to use it — fed to the LLM"}
  ],
  "backgrounds": [
    {"name": "Charcoal", "type": "static", "preset": "vignette_charcoal"},
    {"name": "Beach", "type": "scene", "glb": "beach.glb",
     "scale": 1.0, "offset": [0, 0, 0], "rotation_y": 0, "is_default": true},
    {"name": "Poster", "type": "image", "image": "poster.jpg"}
  ]
}
```

Notes: file references are pack-relative filenames (or absolute web paths
like `/assets/glb/grid_playground.glb` for shared bundled assets); gesture
enums are lowercase identifiers and may not shadow the built-in gesture pack;
`preset` must be one of the renderer's background presets. Packs are
re-scanned on every server start; invalid entries are skipped with a warning
in the server log.

### Where to get VRM models

- **[VRoid Studio](https://vroid.com/en/studio)** — pixiv's free character
  creator (Windows/macOS/Steam). Sculpt an anime character with sliders,
  paint clothes, export straight to `.vrm`. The easiest way to make a
  companion that's *yours* — outfits are just separate exports of the same
  character.
- **[VRoid Hub](https://hub.vroid.com)** — thousands of ready-made VRM
  characters to download. **Check each model's usage license** (creators set
  per-model permissions for modification, redistribution, and commercial
  use) before bundling one into a pack.
- **[BOOTH](https://booth.pm)** — pixiv's marketplace, with a large paid (and
  free) VRM avatar scene if you want something more polished or exclusive.

Animation clips are `.vrma` — the bundled gesture pack (pixiv's VRoid Project
Motion Pack) covers the built-ins, and packs can add custom clips per avatar.

## 🔌 Remote MCP connections

Give a companion extra tools by attaching remote MCP servers:
**Settings → Companions → Edit → Remote MCP connections**. Each connection
takes a server label, the endpoint URL, an optional bearer token (stored
write-only — it's never echoed back to the browser), optional extra headers,
an allowed-tools whitelist, and toggles for voice/text sessions.

How it works: the connection is injected into the session's tool list and
**xAI's servers call the MCP endpoint directly** — your machine is not in
that loop. That means the URL must be **publicly reachable over HTTPS**; a
`localhost` URL can never work. To expose a tool server running on your own
machine, put a tunnel in front of it (e.g. `cloudflared tunnel`, ngrok, or
Tailscale Funnel) and register the tunnel's HTTPS URL.

## 🛠 Development

```
server/   FastAPI + SQLite backend     → edit, restart (or uvicorn --reload)
web/src/  React + Vite frontend        → edit, then npm run build
data/     your DB, images, avatar packs → just data, nothing to build
```

- Hot-reload frontend dev: `cd web && npm run dev` → http://localhost:5990
  (the uvicorn backend **must be running too** — Vite proxies `/api`,
  `/assets` and `/files` to port 8990).
- IDE debug configurations (PyCharm): run `debug_server.py` instead of the
  uvicorn CLI.
- The database is plain SQLite at `data/rexclaw.sqlite3` — open it with any
  client (PyCharm's Database panel, DB Browser for SQLite, `sqlite3`).

### Architecture

```
browser ── WebSocket ──► xAI Realtime API   (voice — direct, ephemeral token)
browser ── fetch ──────► FastAPI :8990      (sessions, memory, imagine, config)
FastAPI ── SQLite + local files             (data/rexclaw.sqlite3, data/files/)
```

## 📋 Notes

- three.js / three-vrm load from esm.sh at runtime — the first avatar load
  needs network access.
- The server binds 127.0.0.1 and has no auth — don't expose it to a network
  as-is.
- Animation credits: bundled VRMA clips include pixiv Inc.'s VRoid Project
  Motion Pack (commercial use permitted with credit).
- Ported from the Odoo voice-companion module; the ERP-specific surface
  (record tools, navigation, multi-user ACLs) was deliberately left behind.

---

*Want Rexclaw Companions fully embedded in your business ERP — searching
records, navigating views, and driving Odoo hands-free? Check out
**[RexClaw Companions for Odoo](https://apps.odoo.com/apps/modules/19.0/odoo_rexclaw_companions)**.*
