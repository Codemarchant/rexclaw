<p align="center">
  <img src="docs/rexclaw_standalone_banner.jpg" alt="Rexclaw Companions" width="100%"/>
</p>

# Rexclaw Companions

<p align="center">
  English | [<a href="./docs/README.ja-JP.md">日本語</a>]
</p>

**Living anime voice companions on your own machine. Bring your own models: Grok, OpenAI, Claude, or fully local.**

**[⬇ Download for Windows](https://github.com/Codemarchant/rexclaw/releases/latest)** · [From source](#-from-source) · [Docker](#-docker)

Talk to a 3D VRM avatar that lip-syncs, emotes and gestures as they answer
you, in 3D scenes you can walk them through. Memory grows across sessions,
voice and text chat share one conversation, and companions can search the
web, see your screen, make images and video, and use your own MCP tools.

By default calls run on xAI's Grok Realtime with your own xAI key. Or build
a voice setup from OpenAI, Claude, ElevenLabs, Fish Audio and others, or from
models on your own computer with no API key at all (see
[Models & providers](#-models--providers)). Your data lives in a SQLite file
on your disk, and your API keys are stored only on your machine.

---

## ✨ Features

### Conversation

| | |
|---|---|
| 🎙️ **Real-time voice** | Speech in, speech out, with natural turn-taking and interruptions that work. Runs on Grok Realtime by default, or on OpenAI Realtime or your own speech-to-text → brain → voice pipeline ([Models & providers](#-models--providers)). Grok voices are multilingual: switch language mid-sentence and your companion follows. |
| 💬 **One conversation, voice or text** | Start a call, continue it as a written chat, pick it back up by voice later. History, tool activity and memory carry across both, and text chat reads the files and images you attach. |
| 🧠 **Memory that grows with you** | Long conversations are summarised as they go, so you can resume one days later, and lasting memories (your name, projects, preferences) carry across sessions. Review and delete them under History → Memories, or fly through them as a 3D star map in the Memory Galaxy. |
| 📞 **Group calls** | Add companions to a live call, or let them invite each other ("call Rex for this one"). Each joins with its own voice, avatar and memory, and a turn director decides who speaks next. Outside a call they can text each other (`text_companion`). |
| 🗣️ **Voice activation** | Say a companion's wake phrase ("hey Eve") and the call starts; ask them to hang up and they end it themselves. Detection runs offline on your machine, so nothing is sent or billed until the call starts. |
| 💓 **Heartbeats** | Scheduled prompts per companion: write a diary entry, check on something, or **call you first**. Schedules missed while the app was closed never fire on their own; they wait as *past due* for your one-click decision. |
| 📺 **Idle events & stream chat** | Opt-in per companion: when a call goes quiet they get one of your prompts, or read your Twitch/YouTube chat and answer viewers by name (Settings → Live chat). |
| 💗 **Affection meter** | Opt-in per companion: a score they nudge as the relationship warms or cools, with editable rules for how they behave at each level, and a burst of hearts when a moment lands. |

### Avatar & stage

| | |
|---|---|
| 🧍 **Living 3D avatars** | VRM characters with lip-sync from the live audio, idle breathing, blinking and eye contact, plus emotions, gestures and outfit changes the model triggers itself. Orbit, move and zoom freely; hair and clothes react to your cursor. |
| 🎨 **Look** | Lighting presets from golden hour to stage spotlight, effects, and ambience (rain, snow, cherry petals, fireflies) that can follow their mood. **Art styles** repaint the live scene as oil, watercolour, manga ink, risograph or pixel art. |
| 🚶 **Walkable 3D scenes** | GLB environments with WASD walk mode and a trailing camera. **Camera - auto follow** directs itself between face, waist-up and full-body shots, and with the opt-in **Locomotion tools** (`move_around`) your companion walks up to you, steps back, wanders or follows your view. |
| 🖥️ **Desktop mascot** | In the Windows app, pop the avatar out as a frameless, always-on-top overlay that floats on your desktop, live call and all. Drag it, resize it, snap it to a corner or another monitor. **Ghost mode** lets clicks pass through and fades the avatar out of your cursor's way. |
| ⌨️ **Hotkeys** | Rebindable shortcuts for calls, mute, screen share and every mascot control, system-wide in the Windows app (Settings → Hotkeys). |
| 🥽 **VR & mixed reality** | WebXR on headset browsers: stand with your companion in VR, or in your own room via passthrough, with spatial audio, controller haptics, an in-headset panel, hand-to-hair and clothing contact, and an opt-in ragdoll you can grab. |
| 🤝 **Combo gestures** | Two-character animations (dancing together, hugs) where a partner joins the scene in sync. In a group call, the other companion plays the partner. |
| 🕺 **Gesture generation** | Opt-in (`generate_gesture`): ask for a move that isn't in their list ("do a curtsy") and they invent it on the spot, made by the free [Text-To-VRMA](https://github.com/Kirakun0328/text-to-vrma/releases) app on your computer (Settings → Gesture generation). Motions are saved to the shared library, so good ones can become regular gestures. |
| 🎤 **Karaoke stage** | Your companion sings in their own voice and dances, with the lyrics on screen. Use the built-in songs or import from [UltraStar](https://usdb.animux.de), then let them sing, duet, or take the mic yourself and get scored. Opt-in, they can perform a song they know mid-call (`perform_song`). The optional **Voice Lab** (a download in Settings, best with an NVIDIA GPU) trains a singing voice from your recordings and turns a song from a link into karaoke. |

### What they can do

| | |
|---|---|
| 🎬 **Images & video** | `create_image`, `create_video` and `change_background` generate into the transcript or swap the live scene, from a prompt or by remixing library images: selfies off the canvas (`take_selfie`), your uploads, past generations. Video can animate an image, extend a clip or edit one in place. Renders on Grok Imagine or your own ComfyUI server. Only use photos of yourself or of people happy to appear. |
| 📸 **Screen & camera sharing** | Share your screen or camera and your companion can look when asked (`take_screenshot`, `analyze_screen`) or record a clip of up to 90 s. Camera sharing also works on phones, tablets and headsets. Nothing is captured unless you armed the share and the companion asks. |
| 👀 **Camera awareness** | Optional, with the camera shared: small on-device face and hand models let them react to a wave, a thumbs up, a yawn or you stepping away. Only short text hints reach the companion; no images leave your device. |
| 🎧 **Voice messages & recording studio** | Ask in chat for a voice note, a bedtime story or a guided meditation and they record it in their own voice (`create_voicemail`), with timed silences, guided breathing, ambient beds, binaural beats and voice effects. Write and render your own scripts in History → Recordings. |
| 📖 **Manga Diary** | Turns an episode of a conversation into a manga page: a storyboard is written from that stretch, your companion poses for every panel, and the shots are inked into screentone art and lettered (History → Manga). |
| 🕵️ **Background tasks** | `delegate_task` hands research, document and image analysis or coding to a background session with search, code execution and file reading, which the companion can continue across turns ("now fix the bug you just found"). In a call, the paperclip takes any file type. |
| 🛠️ **Local computer tasks** | Opt-in (`local_task`): real files, code and shell on your machine through the [Grok Build CLI](https://docs.x.ai/build), confined to a working folder you choose (Settings → Local computer tasks). It runs without confirmation prompts inside that folder, so it's **off by default**. Never offered in Docker. |
| ⛏️ **Minecraft bot** | Opt-in: your companion joins your Minecraft world as a real player, plays on your spoken directions and reacts aloud to what happens ("found diamonds!"). **Off by default**: it runs model-written scripts in your world, so use your own or trusted servers. |
| 🔌 **Remote MCP tools** | Attach remote MCP servers per companion, with bearer auth and per-tool whitelists, all from the UI. |
| 🧩 **Extensions** | Drop-in folders that add your own companion tools, pages and voice engines. |

### Yours

| | |
|---|---|
| 👥 **A fully written crew** | Eve, Ara, Rex, Sal and Leo: five companions with backstories, speech quirks and matching voices. Fork them or build your own. |
| 📦 **Portable companions** | Export a companion as one zip (settings, avatar pack, lore, and on request memories and history) and import someone else's in one click. Avatar packs and memories travel on their own too. |
| 🔒 **Self-hosted** | One SQLite file, local file storage, a localhost-only server. API keys stay on your machine; speech-to-speech calls connect the browser straight to the provider with a short-lived token. |

## 🚀 Quick start

### 💻 Windows app — recommended

Grab `Rexclaw-<version>-win.zip` from the
[latest release](https://github.com/Codemarchant/rexclaw/releases/latest),
unzip, run `Rexclaw.exe`. Self-contained: no Python, Node or Docker needed
(Windows 10/11, 64-bit). It also has what the browser version can't offer:
the pop-out desktop mascot (ghost mode, tray controls, transcript window),
system-wide hotkeys and one-click VR / HTTPS device access.

- The app isn't code-signed yet, so the first launch shows a SmartScreen
  warning: **More info → Run anyway**.
- Your data lives in `%APPDATA%\Rexclaw\data\`, not in the unzipped folder.
  To update, download the new zip and replace the folder; nothing is lost.

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

### 🔑 First run

Companions need somewhere to think and speak. Pick one:

- **Grok Realtime (the default, quickest):** **Settings → xAI connection**,
  paste your xAI API key (grab one at [x.ai/api](https://x.ai/api)), then
  **Voice** → pick a companion → **Start**.
- **Another provider, or local models:** **Settings → Models & providers →
  Add connection**, build a voice setup from it and make it the default.
  Details in [Models & providers](#-models--providers).

> **Optional:** a [TypeSafe](https://typesafe.ai) API key switches on the expressive face
> and head, and hands the background gestures and group-call turn-taking to TypeSafe's Jev
> judgment model, a per-sentence read in ~250 ms for a fraction of a penny an hour. Without
> one, gestures and turn-taking fall back to the xAI turn director (or, with no xAI key, to
> the quick model of the companion's voice setup brain) and the expressive face stays off.

## 🧠 Models & providers

**Grok Realtime** is built in: one xAI model hears you and answers, with the
most natural timing. Everything else is a **voice setup** you build in
**Settings → Models & providers**:

1. **Add connection**: a provider key or a local server, entered once.
   Presets cover OpenAI, Anthropic (Claude), Groq, OpenRouter, DeepSeek,
   ElevenLabs, Fish Audio, Ollama, LM Studio, speaches and Kokoro-FastAPI.
   Any other OpenAI-compatible server works too.
2. **Add voice setup**: calls run either on a speech-to-speech model
   (OpenAI Realtime) or as three stages you mix freely:

   | Stage | Runs on |
   |---|---|
   | Speech to text | xAI, OpenAI, Groq, OpenRouter, or a local Whisper server |
   | Brain | Grok, OpenAI, Claude, DeepSeek, Groq, OpenRouter, or a local model (LM Studio, Ollama, llama.cpp, vLLM) |
   | Voice | Grok voices, OpenAI, ElevenLabs, Fish Audio, or a local voice (Kokoro, speaches) |

3. Press **Test** on the setup, then make it the **Default for companions**,
   or pick it per companion under **Companions → Edit → Voice & brain**.
   A companion can have its own voice on each setup, and its text chat can
   run on the same brain (**Text chat brain**).

The app's own tools (memory, avatar control, selfies, screen sharing, group
calls, texting, songs already learned) work on any brain, and three-stage
setups detect the end of your turn on your computer (Silero VAD + Smart
Turn). A few things depend on the provider, and the companion editor badges
each tool with what it needs:

- **Web search, code execution and MCP servers** run at the brain's
  provider, so they need a Grok, OpenAI (its own API) or Claude brain.
  X search is Grok only. Other brains, local ones included, have none of
  them.
- **`delegate_task`** runs on the companion's own brain when that is OpenAI
  or Claude, otherwise on Grok.
- **Images and video** need an xAI key (Grok Imagine) or your own ComfyUI
  server.
- **xAI only:** teaching a companion new songs, Manga Diary, multi-agent
  delegation and local computer tasks (Grok Build CLI).

An xAI key is optional: on a setup with no xAI stage, calls, text chat,
summaries and memory all run on that setup's providers, and with every stage
on your own computer the conversations never leave the machine. Hardware,
model picks and LM Studio settings are in
**[Running companions on local models](docs/local-models.md)**.

## 👥 Meet the crew

https://github.com/user-attachments/assets/ff569423-325c-4fb2-ac4f-f538e9c03895

- **Eve** — caffeinated junior researcher. Reacts before replying, narrates their lookups, gets genuinely excited about a good find.
- **Ara** — warm, patient, older-sister energy. The calm voice at the end of a busy day.
- **Rex** — half lobster, half man, all quartermaster. Mission-control brevity, calls you Captain, occasionally sings a bar of shanty when the books balance.
- **Sal** — philosophical frog who knows he's software and finds retirement interesting. Precise, comfortable with silence.
- **Leo** — veteran theatre stage manager. "Standby… go." Dignified, composed, earns every gesture.

All five are editable in the **Companions** tab: prompt, voice, avatar,
voice setup and per-tool access. **New companion** starts you from a
structured persona template; **Restore presets** brings back any of the
originals you've deleted.

**Tip:** when you come back, prefer **Resume last** over **Start**. Start
opens a brand-new session; Resume last continues the same conversation, on
the Voice or the Chat tab. Older turns are summarised and distilled into
memories, so the thread never outgrows the model's context.

## 🎭 Custom avatars — avatar packs

Every companion has an avatar — a VRM character with optional outfits, gesture
clips and scene backgrounds. Two ways to make one: the **in-app editor**
(easiest), or by dropping a **pack folder** on disk (shareable / advanced).

### In the app — the Avatars tab

Click **New avatar**, give it a name, upload a **main VRM** (the only
required file), and fill in the **appearance** — a physical description
(face, hair, build…) plus the **main outfit**'s name and description. That's
what the companion knows about their own look: it goes into their prompt as
an *Appearance* section, so the persona prompt doesn't need an outfit
paragraph, and the outfit pickers (`change_outfit`, pictures of themselves)
call the main look by that name. Then optionally add:

- an **idle animation** (VRMA),
- **outfits** — extra VRMs of the same character, each with a description the
  model reads to decide when to wear it. Whatever the companion has on is
  remembered across reloads, restarts and companion switches,
- **custom gestures** — VRMA clips with a trigger name + description (looping
  optional),
- **backgrounds** — a built-in preset, an uploaded image, or a **GLB 3D
  scene** with scale / X-Y-Z offset / Y-rotation controls.

Save, then pick it from the **Avatar** dropdown when editing a companion. Your
avatars are editable and deletable any time; the five **bundled** avatars are
read-only (to tweak one, create a new avatar instead). Files upload straight
into the pack as you add them, and the folder is named after the avatar on
save (shown in the editor as `data/avatars/<name>/`).

**Shared asset library:** drop a file into `data/assets/` once and pick it
from the **Library…** dropdown on any upload field — every avatar references
that single copy (bundled scenes and gesture clips are in the picker too).

### Pack format (sharing / hand-authoring)

Under the hood each avatar is just a folder with an `avatar.json` manifest plus
its files — exactly what the editor reads and writes, and exactly what the
**Export**/**Import pack** buttons on the Avatars tab zip up and unpack (see
[Export & import](#-export--import)). The folder convention still works both
ways without the buttons: drop a pack folder into `data/avatars/` and restart,
or author one by hand. The five bundled packs in `assets/avatars/` double as
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
  "physical_description": "what the character looks like — face, hair, build — fed to the LLM",
  "main_outfit_name": "Lab coat",
  "main_outfit_description": "what the main VRM wears — fed to the LLM",
  "vrma_idle": "idle.vrma",
  "restrict_base_gestures": true,
  "base_gestures": "greeting,goodbye,thinking",
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
    {"name": "Loft", "type": "scene", "glb": "/user-assets/loft.glb"},
    {"name": "Poster", "type": "image", "image": "poster.jpg"},
    {"name": "Rain", "type": "video", "video": "rain.mp4"}
  ]
}
```

Notes: `video` backgrounds (`.mp4`/`.webm`) play as a muted loop behind the
companion, like an animated Imagine background. File references are
pack-relative filenames, or absolute web paths —
`/user-assets/…` for your shared `data/assets/` library (like `Loft` above),
`/assets/…` for bundled assets. Packs are re-scanned on every server start.

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

## 📦 Export & import

Everything is portable:

- **Companions** (download icon on the Companions tab): one zip with the
  companion's settings, plus the avatar pack, lore stories, memories,
  conversation history, heartbeats and idle events, each on its own toggle.
  The ones about you rather than the character (memories, history,
  heartbeats, idle events) default to off, and heartbeats and idle events
  always import switched off, ready to review. **Import** recreates it as a
  new companion; nothing is ever overwritten.
- **What never leaves:** MCP connections and provider connections, since
  they can carry keys. A companion's voice setup travels by name only: on
  import it links to a setup of the same name if you have one, otherwise it
  uses your default.
- **Avatars:** any avatar exports as a self-contained pack zip; **Import
  pack** accepts one, or any hand-zipped pack folder.
- **Memories** (History → Memories): a versioned JSON file, following the
  companion filter. Re-importing skips duplicates.

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
**Companions → Edit → Remote MCP connections**. Each connection takes a
server label, the endpoint URL, an optional bearer token (stored write-only,
never echoed back to the browser), optional extra headers, an allowed-tools
whitelist, and toggles for voice and text sessions.

The connection is added to the session's tool list and **the brain's
provider calls the MCP endpoint directly** (xAI, OpenAI's own API or
Anthropic), so the URL must be **publicly reachable over HTTPS**. Claude
takes the bearer token but not extra headers. Other brains (local models,
Groq, OpenRouter, DeepSeek) have no MCP tools.

## ⛏️ Minecraft bot

Your companion can join your Minecraft (Java Edition) world as its own
player: you direct them by voice, they play for real, and they react aloud
to what happens. The bot runs as a sidecar process next to the game. It
isn't part of the Windows zip, so run it from a source checkout (Node 18+):

```bash
cd game_integrations/minecraft
npm install
node index.js --port <lan port> --username <YourCompanionsName>
```

Then enable **Minecraft bot** for a companion (Companions → Edit) and set it
up on the **Games** tab: your in-game name, and where the bot's planner runs
(Grok, OpenAI, Claude or a local server). Full setup, configuration,
architecture and safety notes:
**[game_integrations/minecraft/README.md](game_integrations/minecraft/README.md)**.

## 🖥️ Local generation (ComfyUI)

The three media tools (`create_image`, `create_video`, `change_background`)
can render on your own **ComfyUI** server instead of Grok Imagine. Any
model ComfyUI runs works, with no per-generation billing.
**Settings → Local generation**:

1. Enter the **ComfyUI URL** (default `http://127.0.0.1:8188`) and press
   **Test connection**. A rented pod works too: paste its proxy URL, and
   an optional auth header covers pods behind a password.
2. Pick the engine per tool, for example images and videos local and
   backgrounds still on Grok Imagine.
3. Load a workflow per capability (text to image, image edit, text to
   video, image to video). In ComfyUI open a template for the model you
   want, run it once so its models download, then **Workflow → Export
   (API)** and load that file. Nothing in the graph needs renaming. Put
   `{prompt}` inside the positive prompt text to keep the rest as a fixed
   style prefix.

On the local engine `include_self` on a video becomes the clip's opening
frame, there is no reference-to-video, extension, editing or voices, and
rendering takes minutes rather than seconds. The companion's **Image &
video tools** toggle still decides whether the tools are offered at all.

## 💰 Costs

Rexclaw is free. You pay your providers directly, and models on your own
computer cost nothing.

**Voice setups** bill per use, at each provider's rates: transcription
time, tokens, characters spoken. A quiet call costs little or nothing.

**Grok Realtime** bills by connection time, which is worth knowing:

- **Voice is billed per minute the call is open, not per minute you talk**:
  ~$0.05/min on `grok-voice-think-fast-1.0`, ~$0.08/min on 2.0. **Every
  companion in a group call bills its own connection**, so three in a call
  is roughly triple the rate whether they're speaking or not, and **muting
  doesn't stop it**. End calls instead of leaving them minimised. (xAI closes
  a call by itself after 15 minutes with no speech.)
- **Resuming a conversation costs ~$0.004 per message of unsummarised
  history**, since it is replayed to xAI to restore the companion's memory.
  Only what has built up since the last summary replays message by message,
  so a 250-message backlog is about **$1 every resume**.

Two settings cut that second cost:

- **Settings → Conversation length → Grok Realtime calls: summarise after**:
  lower it and conversations summarise more often, so less history piles up
  between resumes. The trade is a few more summary calls, and more of the
  conversation carried as a recap rather than word for word.
- **Settings → Grok Realtime calls → Roll up older history**: bundles old
  messages into one instead of hundreds, taking ~$1 to under a cent. Every
  word is still sent; only the shape changes, so recall of the bundled part
  may be slightly softer. On by default for new installs. It matters most if
  you dip in and out of a conversation for quick exchanges; on long calls
  the per-minute charge outweighs it anyway.

Tools (web and X search, MCP, image and video generation), text chats and
background summarisation bill on top. Real xAI spend:
[xAI console](https://console.x.ai) · rates: [xAI pricing](https://docs.x.ai/docs/models).

## 🛠 Development

```
server/   FastAPI + SQLite backend       → edit, restart (or uvicorn --reload)
web/src/  React + Vite frontend          → edit, then npm run build
desktop/  Electron shell (Windows app)   → npm start; packaging in desktop/README.md
data/     your DB, images, avatar packs  → just data, nothing to build
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
browser ── WebSocket ──► xAI / OpenAI Realtime   (speech-to-speech calls: direct, short-lived token)
browser ── WebSocket ──► FastAPI :8990           (voice setups: speech to text → brain → voice)
browser ── fetch ──────► FastAPI :8990           (sessions, memory, imagine, config)
FastAPI ── HTTP(S) ────► your providers, or model servers on this machine
FastAPI ── SQLite + local files                  (data/rexclaw.sqlite3, data/files/)
```

### Extensions

Add your own companion tools without touching the app's code: an extension is
a folder with a `plugin.json` and an `__init__.py`, placed in `data/plugins/`
or in a folder listed under Settings → Extensions. Extensions load when the
app starts and run with its full access, so only use ones you trust.

```python
# data/plugins/dice/plugin.json: {"id": "dice", "name": "Dice", "rexclaw_api": 1}
import random

def setup(api):
    api.add_companion_toggle('Dice roller')           # a switch in each companion's Tools
    api.add_tools(
        lambda con, agent, surface, origin: [{         # surface: 'voice' or 'text'
            'type': 'function', 'name': 'roll_dice', 'description': 'Roll an N-sided die.',
            'parameters': {'type': 'object', 'properties': {'sides': {'type': 'integer'}}}}],
        lambda name, args, ctx: {'result': random.randint(1, int(args.get('sides') or 6))})
```

To keep an extension working across updates, use only the `api` calls; the
app's own modules can change. The full list (routes, a page, events,
recording-script directives, voice engines) is in `server/plugins.py`.

## 📋 Credits

Also in the app, under **Settings → Credits**. Licences are as stated by
each project.

- **[VRoid Project Motion Pack](https://vroid.pixiv.help/hc/en-us/articles/4402394424089)**
  — pixiv Inc. The bundled VRMA gesture clips. Commercial use permitted
  with credit.
- **[@pixiv/three-vrm](https://github.com/pixiv/three-vrm)** (MIT) — VRM
  avatar and VRMA animation runtime, on
  **[three.js](https://threejs.org)** (MIT).
- **[Digital Life Project](https://github.com/dlp3d-ai/dlp3d.ai)** (MIT,
  S-Lab, Nanyang Technological University) — source of the motion library in
  `assets/motion/dlp3d-ani` (the speaking gestures and idle fidgets),
  converted to VRMA by `tools/motion/dlp3d_npz2vrma.py`.
- **[Text-To-VRMA](https://github.com/Kirakun0328/text-to-vrma)** (MIT,
  Kiratchi): the separate app that makes the `generate_gesture` motions over
  its local HTTP API. Not bundled; you install and run it yourself.
- **[Freesound](https://freesound.org)** (CC0) — the recording studio's
  recorded beds and music: `heartbeat-drone` and `void-drone` by bassimat,
  `relaxation-pads` and `angelic-pad` by PhonZz, `emanation` by Kronek9,
  `space-pad` and `cosmic-glow` by Andrewkn. Sources in
  `assets/audio/beds/CREDITS.md`.
- **[WORLD](https://github.com/mmorise/World)** (modified BSD, Masanori
  Morise) via **[pyworld](https://github.com/JeremyCCHsu/Python-Wrapper-for-World-Vocoder)**
  (MIT): the vocoder the karaoke stage re-sings companions' voices with.
- **[LRCLIB](https://lrclib.net)**: synced lyrics for songs imported from a link.
- Voice Lab (optional download, not bundled):
  **[Ultimate RVC](https://github.com/JackismyShephard/ultimate-rvc)** (MIT),
  **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** (MIT),
  **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** (Unlicense) and
  **[uv](https://github.com/astral-sh/uv)** (MIT/Apache-2.0).
- Voice pipeline — **[Silero VAD](https://github.com/snakers4/silero-vad)**
  (MIT, Silero Team), the bundled voice detector, and
  **[Smart Turn](https://github.com/pipecat-ai/smart-turn)** (BSD 2-Clause,
  Daily), the bundled end-of-turn model, whose audio features are ported from
  Pipecat (portions Apache-2.0, Hugging Face Transformers).
- **[Vosk](https://alphacephei.com/vosk/)** (Apache-2.0) — offline speech
  models for wake phrases.
- **[MediaPipe](https://github.com/google-ai-edge/mediapipe)** (Apache-2.0) —
  the on-device face and hand models behind camera awareness.
- Minecraft sidecar — **[Project AIRI](https://github.com/moeru-ai/airi)**
  (MIT) for the brain architecture and pathfinder patches,
  **[Mindcraft](https://github.com/kolbytn/mindcraft)** (MIT) for those
  patches' origin and the building schematics, and
  **[PrismarineJS](https://github.com/PrismarineJS)** (MIT) for mineflayer.
  Full provenance in `game_integrations/minecraft/README.md`.

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
