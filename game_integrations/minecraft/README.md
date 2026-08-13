# Rexclaw Minecraft bot

Your companion joins your Minecraft world as its own player and plays for
real — mining, crafting, building, following you — while you direct them by
voice through Rexclaw. The prompting treats the game body and the voice as
one person: you're not operating a bot, your companion is *in there*.

## Quick start

Requirements: Node 18+, a Minecraft **Java Edition** world on a version
mineflayer supports (currently up to 1.21.11 — protocol support lags new
Minecraft releases by a few weeks), and a running Rexclaw server.

```bash
cd game_integrations/minecraft
npm install
node index.js --port 65000 --username Ara
```

The easiest target is a LAN world: open your single-player world to LAN and
pass the port Minecraft prints — **it changes every time the world is
opened**. Set `--username` to your companion's name so the character in the
world is them.

Then, in Rexclaw: enable **Minecraft bot** for the companion (Companions →
Edit), and set your own in-game username under **Settings → Minecraft bot**
so the bot treats your orders as its user's. The `minecraft_command` /
`minecraft_status` tools appear only in calls started while the sidecar is
connected.

## Configuration

CLI flags (matching env vars in parentheses), all optional:

| Flag | Default | |
|---|---|---|
| `--host` | `127.0.0.1` | Minecraft server host (`MC_HOST`) |
| `--port` | `25565` | Minecraft server port (`MC_PORT`) |
| `--username` | `Rex` | In-game name — use your companion's (`MC_USERNAME`) |
| `--auth` | `offline` | `microsoft` for online-mode servers, needs a real account (`MC_AUTH`) |
| `--version` | auto | Pin a Minecraft version (`MC_VERSION`) |
| `--rexclaw` | `ws://127.0.0.1:8990/ws/minecraft` | Rexclaw server link (`REXCLAW_WS`); `wss://` is auto-negotiated when the server runs in headset-HTTPS mode |
| `--token` | none | Shared secret (`REXCLAW_MC_TOKEN`) — required only when the server sets the same env var |

Run the sidecar on the same machine as the game (from WSL, `127.0.0.1` does
not reach a Windows-hosted world — use Windows for both).

When the Rexclaw server is reachable beyond localhost (Docker/LAN), set
`REXCLAW_MC_TOKEN=<secret>` on the server and pass the same value with
`--token` here — the WebSocket carries your xAI API key, and the token stops
anyone else on the network from opening it.

## How it works

The sidecar connects to the game via [mineflayer](https://github.com/PrismarineJS/mineflayer)
(a protocol-level Minecraft client — the server sees a real player) and to
Rexclaw over WebSocket. Directives from your companion wake the bot's own
brain — a text model (Settings → Minecraft bot, your API key) that answers
each event with a small JavaScript plan, executed in a sandbox against a
skill library (pathfinding, mining, crafting + a recursive recipe planner,
smelting, chests, combat, building blocks, torches, armor, sleeping) with
an ASCII map for spatial reasoning. A reflex layer underneath keeps the
bot alive without spending model calls: it eats when hungry, fights back
when a hostile mob lands a hit, and flees at low health.
Highlights travel back and are spoken by your companion; the voice call
never carries game ticks, so long jobs cost cheap text-model calls, not
call minutes. There is no command queue: a new directive always replaces
the current task, cleanly aborting whatever the bot is doing mid-action —
so "stop and follow me" takes effect at once. Sequences belong inside one
directive ("mine 16 iron, then come back to me"), which the bot plays out
as a single goal.

Two brain models are configured (Settings → Minecraft bot): the fast
default, and a stronger reasoning model for hard tasks. The companion picks
the strong one per directive (`hard_model` flag — building, long crafting
chains), and any task escalates to it automatically after a failed attempt,
so the fast model's broken plans don't get retried by the fast model.

Long tasks are managed as state, not chat history (lessons from
[mindcraft](https://github.com/mindcraft-bots/mindcraft)): the current
directive is injected into every planning turn as a standing goal, a
given-up task parks in the bot's memory so "keep going" resumes it, and
turns that fail *after* real progress don't burn the give-up budget — the
full failing script is echoed back for repair instead. Construction uses ready-made designs (`designs/`: a dirt shelter, wood and
stone huts, a large house) whose generic materials become whatever the bot
is carrying — a spruce hut when it chopped spruce. The chosen design becomes
a blueprint, and each turn diffs it against the live world and places only
what's missing, so an interrupted build resumes exactly where it stopped.
Custom structures can still be described by hand in the same shape. Memory and the active
goal persist to `brain_state.json`, so even killing the sidecar mid-build
loses nothing — on the next spawn the bot checks the world and carries on.
A stuck watchdog aborts any travel-type action that has gone nowhere for
20 seconds with a diagnosable error, instead of letting a wedged path
silently burn the script budget.

The bot will not break your things: beds, chests, barrels and workstations
are excluded from pathfinding's dig list, so it routes around your base
rather than through it. It notices the world around it too — someone
joining, a gift thrown to it, rain, nightfall, a whisper — and carries that
into its next decision without spending a model call on each event.

## Tests

`npm test` runs every suite in `test/` — each one a plain script with no
framework or extra dependencies, exercising the brain's harness logic
(interrupts, goal/plan state, failure budgets, the abort-check rewriter)
and the skill library's pure parts (blueprint diffing, position shapes)
against mocks. They need no Minecraft server and no API key.

The skills that actually touch mineflayer are covered only by mocks — those
meet reality on a live server.

## Safety

The bot executes model-generated scripts in your world with no confirmation
prompts — griefing-capable by construction. Keep it to your own worlds and
servers where a rogue `dig` is a funny story, not a problem.

## Credits

The architecture — an event-driven brain that writes JavaScript plans
against a skill library, with interrupt/error-burst/no-action guards — is
modeled on the Minecraft integration of [Project AIRI](https://github.com/moeru-ai/airi)
(`integrations/minecraft`), MIT License, Copyright (c) 2024-PRESENT Neko
Ayaka and contributors. Portions of this sidecar are ported or adapted from
that codebase under the same license — including
`patches/mineflayer-pathfinder+*.patch` (stuck-loop breaker, door/trapdoor
traversal, lava escape; applied automatically via patch-package on
`npm install`), which itself derives from
[Mindcraft](https://github.com/kolbytn/mindcraft) (MIT, Copyright (c) 2024
Kolby Nottingham). The building designs in `designs/*.json` are Mindcraft's
construction schematics (`src/agent/npc/construction`), used verbatim under
the same license. Built on the
[PrismarineJS](https://github.com/PrismarineJS) family (mineflayer,
mineflayer-pathfinder, and friends).
