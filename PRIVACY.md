# Rexclaw Privacy Policy

_Last updated: August 15, 2026_

Rexclaw is a local-first desktop companion app. It runs entirely on your own
machine, and we (Codemarchant) do not operate any servers, accounts, or data
collection for it.

## What we collect

**Nothing.** Rexclaw contains no telemetry, analytics, tracking, or ads. No
usage data, chat content, or personal information is ever sent to Codemarchant.

## Where your data lives

Everything Rexclaw stores — chat history, companion settings and memories,
your API keys, and generated assets — is kept locally on your device:

- Desktop app (Windows): `%APPDATA%\Rexclaw\data\`
- Script / Docker installs: the `data/` folder next to the app

Deleting that folder (or uninstalling the app) permanently removes all of it.
Your API keys are stored only in this local data folder and are used solely to
call the AI services you configure.

## Data sent to third-party AI services

Rexclaw's AI features work by calling third-party APIs **with an API key that
you provide**. This happens only when you use those features, and the data goes
directly from your machine to the provider — never through us. Depending on
what you use, this can include:

- **Chat and companion context** — your messages, plus the companion's prompt
  and stored memories needed for the conversation (sent to xAI, `api.x.ai`).
- **Voice** — your microphone audio during voice conversations (sent to xAI's
  realtime API while a session is active).
- **Image and video generation** — your prompts and any images you edit
  (sent to xAI's generation APIs).

Handling of that data is governed by the provider's own privacy policy — for
xAI, see <https://x.ai/legal/privacy-policy>. Rexclaw does not send anything to
these services in the background; requests happen only as part of features you
actively use.

## Optional connections you configure

If you connect Rexclaw to other services yourself — for example custom MCP
servers or local game integrations (e.g. Minecraft) — data flows only to the
endpoints you configured. Local integrations stay on your machine.

## Downloads

The app may download open-source components on demand, such as offline speech
recognition models (Vosk, from `alphacephei.com`) and JavaScript libraries from
public CDNs. These are plain file downloads; no personal data is sent.

## Children

Rexclaw is not directed at children under 13, and since we collect no data, we
knowingly hold none.

## Changes

If this policy changes, the update will be published at this URL with a new
"Last updated" date.

## Contact

Questions about privacy: **jonathan@codemarchant.com**
