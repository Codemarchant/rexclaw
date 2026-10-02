# Running companions on local models

A **voice setup** (Settings → Models & providers) splits a call into three engines:
speech to text, a text model as the brain, and a voice. Each can run on your
own computer instead of at xAI. Each companion picks its setup on the
Companions tab, and can run its text chat on the same brain.

This guide covers a fully local setup, and which parts still need xAI.

## What works without xAI

Rexclaw runs with no xAI key at all. A companion on a fully local setup gets
these, all on your own computer:

- calls, and text chat on the setup's brain (with no xAI key, chat follows
  that brain even when the companion is set to Grok);
- summaries, chat titles and memory extraction, run on the brain its text
  chat uses — its conversations never leave the computer;
- the app's own tools: emotions, gestures, outfits, movement, memory, lore,
  affection, selfies, screenshots, group calls, companion texting, songs it
  has already learned;
- voice messages, recorded in its local call voice;
- images on ComfyUI (Settings → Local generation);
- attached images and `analyze_screen`, on a brain set to **Can see images**.

The companion editor marks the tools that need more:

- **xAI**: multi-agent delegation and local computer tasks (Grok Build CLI).
  Without a key they're left out of the session.
- **xAI, OpenAI or Claude**: delegated tasks run on the companion's own brain
  when it is OpenAI or Claude, otherwise on Grok. With a local brain and no
  xAI key they're left out.
- **The Minecraft bot's planner** runs on the connection picked on the Games
  tab: Grok, OpenAI, Claude or a local server.
- **Provider tools**: web search, code execution and remote MCP servers run
  at the brain's provider (xAI, OpenAI's own API or Anthropic), and X search
  is Grok's own. A brain on your own computer has none of them.

Teaching a new song still needs xAI's voice: singing is built from its
per-character timings. Manga Diary's storyboard also runs on xAI.

## Conversation length

Each setup's brain has its own **Summarise at (tokens)** and summary word
limits. Settings → Conversation length holds the same settings for Grok
Realtime calls and Grok text chat. A brain is sent the whole conversation on
every request, so once a request reaches **Summarise at**, the older part is
summarised.

The defaults:

- **OpenAI-compatible brains:** 24,000 tokens, with summaries of
  1,500–3,000 words. That suits a model loaded with 32,000 tokens of context.
- **xAI brains:** 64,000 tokens.

The companion's prompt alone is about 18,000 tokens, so:

- load a local model with at least 32,000 tokens of context;
- keep **Summarise at** below the loaded length, with room for a reply.

Lower values keep replies quick, since a smaller request is read faster. This
helps on calls with a big model.

## The three servers

Anything that speaks the OpenAI API works. Under **Add connection**, presets
fill in the usual address:

| Stage | Suggested server | Preset address |
|---|---|---|
| Brain | [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/) | `http://127.0.0.1:1234/v1` / `:11434/v1` |
| Speech to text | [speaches](https://github.com/speaches-ai/speaches) (faster-whisper) | `http://127.0.0.1:8000/v1` |
| Voice | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) | `http://127.0.0.1:8880/v1` |

For Japanese, two voice options:

- [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) also
  serves `/v1/audio/speech`. Add it as an *OpenAI-compatible server* with its
  own address.
- Fish Audio has its own connection kind, but it is a paid cloud service, not
  local.

Then create a setup. Pick the connection for each stage, and fill in the
model names the servers expect. Press **Test** after saving: the brain
answers, the voice speaks a line, and the transcriber hears that line back.
Each step shows its timing.

## Fitting it on one graphics card

The avatar renderer shares the graphics card with whatever runs locally. On
an 8 GB card (an RTX 3070, say), a workable split is:

- **Brain on the GPU:** an 8–9B model at a 4-bit quant with 16–24k context
  takes about 6 GB.
- **Speech to text on the CPU:** faster-whisper `large-v3-turbo` at int8.
  Use `distil-large-v3` for English only.
- **Voice on the CPU:** Kokoro's ONNX build. Its first audio is about 1 s on
  CPU, against about 0.3 s on a GPU.

On a bigger card, move the voice to the GPU first. It is the stage you hear
waiting on.

## Choosing a brain

The brain needs reliable **tool calling**. A companion has 15–25 tools, and a
model that can't call them writes "[set_emotion: happy]" into its speech
instead. Rexclaw turns simple cues like that into real calls, but a model
that calls tools properly does much better.

Researched October 2026; check for newer releases:

- **Qwen3.5-9B** (Q4_K_S / IQ4_XS):
  - Strong tool calling for its size. The 4B scored 97.5% in an
    [LM Studio tool-calling test](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/).
  - Use a chat template with the community fixes
    ([fixed templates](https://huggingface.co/sudiptosarkar/Qwen-Fixed-Chat-Templates)).
  - Turn thinking off (see below).
- **Ministral 3 8B Instruct**: full attention, so prompt caching just works,
  and LM Studio parses its tool calls natively.
- **Qwen3.6-35B-A3B** (a mixture of experts, with the experts in system RAM):
  - Clearly smarter than the 9B.
  - Speed on an 8 GB card is borderline for voice: about 30 tokens/s,
    [measured at a 4k context](https://dev.to/alexchen31337/770-experiments-to-squeeze-30-toks-out-of-a-35b-moe-model-on-a-500-gpu-4il5).

Community finetunes and "abliterated" builds trade refusals for capability.
Reports say this can [weaken tool calling](https://nathan.sapwell.net/posts/glm47-flash-abliteration/),
so compare one against the stock model on your own companion before
switching.

If a small model drifts out of character or answers slowly, set the brain's
**Tools** to *No tools - talk only*. Every tool description is read on every
turn.

## LM Studio settings

- **Context length:** about 24,000 tokens. A companion's voice prompt runs
  to about 18,000.
- **Flash attention:** on, with the K and V cache at **Q8_0**. That halves
  the cache's memory.
- **GPU offload:** maximum for a dense model. For a mixture-of-experts model,
  use *Force Model Expert Weights onto CPU*.
- **Keep the model loaded:**
  - Load it with `lms load`, or give it no idle TTL.
  - A just-in-time model unloads after an hour idle, and the next call then
    waits for it to load
    ([TTL docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)).
- **Turn thinking off for hybrid reasoning models:**
  - For Qwen3.5/3.6, put `{%- set enable_thinking = false %}` at the top of
    the prompt template.
  - Any `<think>` block that still comes through is never spoken or shown.
- **Parallel requests: 1.** Another request would evict the cached prompt.

**Prompt caching** makes the most difference to local speed.

- **How it works:** the server reuses the work already done on a prompt
  whose start hasn't changed. Rexclaw keeps the companion's prompt
  byte-identical through a call and across text messages; the current time
  goes in a note at the end.
- **What clears it:**
  - editing the companion,
  - a new memory in its core set,
  - a summary rewriting the history.

  The next reply after any of these reprocesses the whole prompt, which takes
  seconds on a mid-range card.
- **Hybrid-attention models need a current build:** Qwen3.5/3.6 and Gemma 4
  [reuse the cache](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1563)
  only on recent LM Studio and llama.cpp builds. Update LM Studio if every
  reply starts slowly.

## Turn taking

Setups with a local speech-to-text engine use Rexclaw's own turn detection,
on this computer:

- [Silero VAD](https://github.com/snakers4/silero-vad) hears speech start and
  stop.
- [Smart Turn](https://github.com/pipecat-ai/smart-turn) v3.2 judges from the
  audio whether you've finished a thought or are only pausing.

These are the defaults Pipecat uses. The settings are under **Turn taking**
on each setup.

With xAI speech to text, Smart Turn tells xAI to finish the transcript as
soon as you sound done. That takes about 0.45 s after you stop talking,
against about 1.2 s when waiting for xAI's own end-of-turn detection.

**Start replying early** (on by default, as in LiveKit Agents) starts the brain
on your live words the moment your turn sounds finished. That overlaps the
transcriber's last step, about 0.2 s. If the final words differ, the early
reply is dropped and the brain starts again, so a miss costs one extra
request. It needs live words: a streaming engine, or **Live words while you
talk** on a local one.

If the companion's voice through your speakers keeps interrupting it, raise
**Speech threshold**, or use headphones.
