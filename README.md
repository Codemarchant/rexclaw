<p align="center">
  <img src="docs/rexclaw_standalone_banner.jpg" alt="Rexclaw Companions" width="100%"/>
</p>

# Rexclaw Companions

<p align="center">
  English | [<a href="./docs/README.ja-JP.md">日本語</a>]
</p>

**Living anime voice companions on your own machine — powered by xAI Grok Voice Realtime, bring-your-own-key.**

Talk to a 3D VRM avatar that lip-syncs, emotes, gestures and walks around the
scene while she answers you — with persistent memory that grows across
sessions, Grok Imagine image generation, file-aware text chat, and your own
MCP tools. Everything runs locally except the model itself: your data lives
in a SQLite file on your disk, and your API key never leaves your machine.

---

## ✨ Features

| | |
|---|---|
| 🎙️ **Real-time voice** | Speech-in, speech-out via Grok Voice Realtime — sub-second latency, natural turn-taking with server VAD, barge-in that actually works. No STT/TTS pipeline to wire up. |
| 🌍 **Speaks any language** | Grok Voice is multilingual out of the box. Switch language mid-sentence — your companion follows. |
| 💬 **One conversation, voice or text** | A session is never locked to the mode it started in: begin a voice call, continue it as a written chat, pick the same thread back up by voice later — history, tool activity and memory carry across both surfaces. |
| 🧠 **Memory that grows with you** | Two layers: rolling in-session compaction keeps a conversation alive indefinitely (resume days later, she picks up where you left off), and durable cross-session memories — name, projects, preferences — reviewable and deletable in Settings. |
| 🧍 **Living 3D avatars** | three.js + @pixiv/three-vrm: viseme lip-sync from the live audio, idle breath/blink/eye-saccades, camera eye contact, emotions and body-language gestures the model triggers itself mid-conversation. Full-body view comes with the standard three.js orbit camera — drag to orbit, Shift+drag to move the character around the frame, scroll wheel to zoom. |
| 🚶 **Walkable 3D scenes** | GLB environments as backgrounds with WASD/arrow walk mode and a trailing camera. A grid playground ships in the box. In a group call, number keys pick which character you're steering. |
| 📞 **Multi-agent group calls** | Add companions to a live call — or let them invite each other ("call Rex for this one"). Each joins with its own voice, avatar and memory; a fast LLM turn director decides who speaks next, with no audio cross-feeding between agents. |
| 🖥️ **Desktop mascot mode** | In the desktop app, pop the avatar out of the window: a small frameless, transparent, always-on-top overlay floats your companion on the desktop while you work — live call and all. Drag the character (or the handle) anywhere, pin/unpin, cycle sizes, snap to a corner from the tray icon, pop back in — the conversation resumes across the handoff. **Ghost mode** goes further: clicks pass straight through the window and the avatar fades out of your cursor's way (real per-pixel hit-testing), so they can stand over your work without ever being in it. |
| 🥽 **VR & mixed reality (WebXR)** | Stand with your companion in VR — or in your real room via passthrough MR on headset browsers that support it — with spatial audio at the avatar's head, controller haptics, an in-headset panel (mute, emotions, gestures, move mode), physical hand-to-hair/clothing contact, and an opt-in full-body ragdoll you can grab. |
| 🤝 **Combo gestures** | Two-character VRMA animations — dancing together, hugs — where a partner VRM joins the scene in sync with your avatar, with per-character placement controls. A live call peer is borrowed as the partner instead of spawning a duplicate. |
| 🎨 **Grok Imagine built in** | Ask them to redecorate (`change_background` swaps the live scene), generate images into the transcript, edit photos you upload in chat, or remix anything in the Imagine library — selfies, uploads, past generations — into new images (`create_image` with `source_images`). Uploaded images are saved to the library at upload time, so "edit that photo" keeps working turns — or whole sessions — later. |
| 🎬 **Imagine video** | Ask for a living scene and `change_background` generates an animated looping backdrop instead of a still — both stay selectable in the background picker. `create_video` drops short clips with native sound into the transcript, and can animate a library image (image-to-video), put the people and things from earlier generations into a new clip (reference-to-video), continue a clip with what happens next (extension), or tweak one in place — "add sunglasses" (editing). Companions can even `take_selfie` — snapshot their current look, pose and outfit straight off the canvas, with or without the scene backdrop — and star in their own clips. And you can share your own photos mid-call (paperclip) for the same treatment: animate them or put their subjects into new clips. Per-second Grok Imagine pricing, so clips stay short and cheap. |
| 🕵️ **Background analyst (`delegate_task`)** | Companions hand complex work — file/image analysis, coding, deep research — to a hidden text-mode analyst with the vision and document reading the realtime voice model lacks. Each task runs in its own persistent workspace the companion can continue across turns ("now fix the bug you just found"), with automatic server-side compaction. The voice-mode paperclip now accepts **any file type**: images keep feeding the Imagine tools, documents (PDF, CSV, …) upload to xAI and get read via `delegate_task`. Optional per-companion multi-agent mode (off by default) routes the hardest questions to xAI's multi-agent model, where several agents collaborate and a leader synthesizes. |
| 🖥️ **Screen sharing** | Share your screen with one click and your companion can see what you see — ask them to look at a photo, an article, an error (`take_screenshot`), or show them a moment from a video or game with `record_screen_clip` (up to 90 s, sound included if you share audio). Captures post to the transcript and save to the library for later. Red dot while recording; nothing is captured unless you armed the share. |
| 👥 **A fully written crew** | Eve, Ara, Rex, Sal and Leo — five companions with backstories, speech quirks and matching voices. Fork them or build your own. |
| 🔌 **Remote MCP tools** | Attach any number of remote MCP servers per companion, with bearer auth and per-tool whitelists — configured in the UI. |
| 🔒 **Self-hosted & BYOK** | One SQLite file, local image storage, a localhost-only server. The browser opens its realtime socket straight to xAI with a short-lived token — the long-lived key stays server-side on your machine. |

## 🚀 Quick start

### 💻 Windows app — recommended

Grab `Rexclaw-<version>-win.zip` from the
[latest release](https://github.com/Codemarchant/rexclaw/releases/latest),
unzip, run `Rexclaw.exe`. Fully self-contained — no Python, Node or Docker
needed (Windows 10/11, 64-bit) — and it includes the desktop-only features
the browser version can't offer: the pop-out desktop mascot (with ghost
mode, tray controls and the transcript window) and one-click VR / HTTPS
device access.

### 🛠 From source

```bash
./run.sh        # Linux / macOS / WSL
run.bat         # Windows
```

First run sets everything up (Python venv, backend deps, frontend build) and
opens http://localhost:8990. After that it skips straight to launch.
Requirements: Python ≥ 3.10 and Node.js.

On Windows, the packaged app above is the easier path — `run.bat` is mainly
for development, or for running the browser version without the desktop
shell.

Then in the app: **Settings → paste your xAI API key** (grab one at
[x.ai/api](https://x.ai/api)) → back to **Voice** → pick a companion → **Start**.

### 🐳 Docker

```bash
git clone https://github.com/Codemarchant/rexclaw.git && cd rexclaw
docker compose up -d                          # → http://localhost:8990
docker compose pull && docker compose up -d   # update to the latest release
```

All state (settings, history, images) lives in the `/data` volume, so
updates never lose your data. To reach the app from phones, tablets or a
VR headset on your network, enable HTTPS mode in `docker-compose.yml`
(port mapping `"8990:8990"` + `REXCLAW_SSL=1` under `environment:`) —
details in [Using VR](#-using-vr).

## 👥 Meet the crew

https://github.com/user-attachments/assets/ff569423-325c-4fb2-ac4f-f538e9c03895

- **Eve** — caffeinated junior researcher. Reacts before she replies, narrates her lookups, gets genuinely excited about a good find.
- **Ara** — warm, patient, older-sister energy. The calm voice at the end of a busy day.
- **Rex** — half lobster, half man, all quartermaster. Mission-control brevity, calls you Captain, occasionally sings a bar of shanty when the books balance.
- **Sal** — philosophical frog who knows he's software and finds retirement interesting. Precise, comfortable with silence.
- **Leo** — veteran theatre stage manager. "Standby… go." Dignified, composed, earns every gesture.

All five are editable in the **Companions** tab — prompt, voice, avatar,
and per-tool access. **New companion** starts you from a structured persona
template; **Restore presets** brings back any of the originals you've deleted.

**Tip — keep one long-running conversation:** prefer **Resume last** over
**Start** when you come back. Each Start creates a brand-new session; Resume
last continues the same rolling conversation, which is what lets your
companion carry context across days — older turns are automatically compacted
into summaries and distilled into memories, so the thread never outgrows its
context window. Works across modes too: the resumed conversation continues
seamlessly whether you pick it up on the Voice or the Chat tab.

## 🎭 Custom avatars — avatar packs

Every companion has an avatar — a VRM character with optional outfits, gesture
clips and scene backgrounds. Two ways to make one: the **in-app editor**
(easiest), or by dropping a **pack folder** on disk (shareable / advanced).

### In the app — the Avatars tab

Click **New avatar**, give it a name, and upload a **main VRM** (the only
required file). Then optionally add:

- an **idle animation** (VRMA),
- **outfits** — extra VRMs of the same character, each with a description the
  model reads to decide when to wear it,
- **custom gestures** — VRMA clips with a trigger name + description (looping
  optional),
- **backgrounds** — a built-in preset, an uploaded image, or a **GLB 3D
  scene** with scale / X-Y-Z offset / Y-rotation controls.

Save, then pick it from the **Avatar** dropdown when editing a companion. Your
avatars are editable and deletable any time; the five **bundled** avatars are
read-only (to tweak one, create a new avatar instead). Files upload straight
into the pack as you add them, and the folder is named after the avatar on
save (shown in the editor as `data/avatars/<name>/`).

### Pack format (sharing / hand-authoring)

Under the hood each avatar is just a folder with an `avatar.json` manifest plus
its files — exactly what the editor reads and writes. So a UI-built avatar is
also a **shareable pack**: zip the folder, hand it to someone, they drop it in
`data/avatars/` and restart (no rebuild — packs are data). You can author one
by hand the same way. The five bundled packs in `assets/avatars/` double as
worked examples.

> **Windows desktop app:** the packaged app keeps its data under
> `%APPDATA%\Rexclaw\data\` — so custom packs go in
> `%APPDATA%\Rexclaw\data\avatars\<PackName>\` (paste that path into the
> Explorer address bar). Everything else works the same.

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
like `/assets/glb/grid_playground.glb` for shared bundled assets); Packs are
re-scanned on every server start.

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

## 🥽 Using VR

Open the app in your headset's own browser (Quest, Pico, …) and press the
cube button to stand with your companion in VR. On browsers that support
passthrough, the same button enters **mixed reality** — your companion in
your real room — and the in-headset panel toggles Virtual/Passthrough.
WebXR and the microphone only work on secure (HTTPS) origins, so the app
has a built-in HTTPS mode; the headset and the PC just need to be on the
same WiFi.

The same HTTPS mode is what unlocks **phones and tablets** too: any device
on your WiFi can open the same URL, and because the page is served over
HTTPS the microphone works there — full voice calls from your phone, plus
installing it as an app (Add to Home Screen). Over plain HTTP another
device could only browse and text-chat.

**Windows app (recommended):**

1. Turn on **Settings → VR headset & other devices (HTTPS)**. The app
   restarts its server in HTTPS mode and reloads; allow access if Windows
   Firewall asks.
2. The setting now shows an address like `https://192.168.1.42:8990/` —
   open it in the headset's browser and accept the one-time certificate
   warning (Advanced → proceed).
3. Press the cube button. The conversation starts (or resumes)
   automatically as you enter VR.

**From source (`run.sh` / `run.bat`):**

1. Start with HTTPS + LAN enabled:
   - Linux/macOS: `REXCLAW_SSL=1 REXCLAW_HOST=0.0.0.0 ./run.sh`
   - Windows: `set REXCLAW_SSL=1`, then `set REXCLAW_HOST=0.0.0.0`, then
     `run.bat` — on native Windows, not WSL (LAN devices can't reach a
     server inside WSL's virtual network).
2. Find the PC's LAN address (`ipconfig` on Windows, `ip addr` on Linux)
   and open `https://<pc-ip>:8990` in the headset's browser; accept the
   certificate warning.
3. Press the cube button.

**Docker:**

1. In `docker-compose.yml`, change the port mapping to `"8990:8990"` and
   add `REXCLAW_SSL=1` under an `environment:` key.
2. Open `https://<host-ip>:8990` in the headset's browser; accept the
   certificate warning.
3. Press the cube button.

The self-signed certificate is generated once under `data/certs/`; set
`REXCLAW_SSL_CERT` / `REXCLAW_SSL_KEY` to use your own pair instead. The
app has no authentication, so only enable LAN serving on a network you
trust. (A PCVR/OpenXR setup works as well — the Windows app's cube button
opens the scene in a VR-capable browser window — but the headset-browser
flow above is the recommended one.)

## 🔌 Remote MCP connections

Give a companion extra tools by attaching remote MCP servers:
**Companions → Edit → Remote MCP connections**. Each connection
takes a server label, the endpoint URL, an optional bearer token (stored
write-only — it's never echoed back to the browser), optional extra headers,
an allowed-tools whitelist, and toggles for voice/text sessions.

How it works: the connection is injected into the session's tool list and
**xAI's servers call the MCP endpoint directly** — The URL must be **publicly reachable over HTTPS**

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

- Animation credits: bundled VRMA clips include pixiv Inc.'s VRoid Project
  Motion Pack (commercial use permitted with credit).

## 🔗 Related projects

Making your own gesture clips? These convert motion data into the `.vrma`
format the avatars play:

- **[kimodo_NPZ_to_fbx_and_vrma](https://github.com/Codemarchant/kimodo_NPZ_to_fbx_and_vrma)** —
  convert KIMODO motion-capture NPZ output to FBX and VRMA.
- **[fbxgeneral2vrma](https://github.com/Codemarchant/fbxgeneral2vrma)** —
  convert FBX animations in awkward formats to VRMA. Pairs well with
  [Mixamo](https://www.mixamo.com)'s huge free FBX animation library, and
  with the FBX animation packs sold on [BOOTH](https://booth.pm/).

## ☕ Support

Rexclaw Companions is free and open source. If it made your desk a little
less lonely, you can [buy me a coffee](https://buymeacoffee.com/codemarchant) —
it keeps the companions talking.

---

*Want Rexclaw Companions fully embedded in your business ERP — searching
records, navigating views, and driving Odoo hands-free? Check out
**[RexClaw Companions for Odoo](https://apps.odoo.com/apps/modules/19.0/odoo_rexclaw_companions)**.
An Odoo site also doubles as a hub for your companions: host it once and
talk to them from any device — desktop, phone, tablet or VR headset —
with shared conversations and memory everywhere you sign in.*
