# Copyright 2026 Codemarchant
"""Voice pipeline: voice calls without the realtime speech-to-speech API.

Settings → Voice engine picks how a call is voiced:

  realtime  xAI's Grok Voice realtime API — one model hears and speaks.
  pipeline  separate engines: speech-to-text → a text model → text-to-speech,
            each swappable, local or hosted.

The browser doesn't know the difference. session.PipelineSession speaks the
same realtime WebSocket protocol xAI does, so every call feature built on it
(tools, transcripts, compaction, group calls, heartbeats) works unchanged;
start_session hands the browser this server's /api/voice/pipeline socket
instead of xAI's.

  audio.py       PCM helpers, Silero VAD, the turn detector
  smart_turn.py  Smart Turn v3.2: finished thought, or just a pause?
  text.py        sentence chunking and speech tags
  engines.py     engine contracts, registry (extensions can add engines),
                 saved settings
  stt.py / llm.py / tts.py   the built-in engines
  session.py     the realtime-protocol call leg
"""
