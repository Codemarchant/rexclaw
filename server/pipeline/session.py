# Copyright 2026 Codemarchant
"""One call leg of the voice pipeline, speaking the realtime protocol.

The browser's AgentConnection (web/src/models/agent_connection.js) was
written against xAI's realtime WebSocket, and everything a call does —
transcript persistence, tools, compaction, group calls, heartbeats, idle
events — rides the events of that protocol. So instead of teaching the
browser a second protocol, this class *is* a realtime server: it accepts the
same client events and emits the same server events, and behind them runs

    mic → Silero VAD / Smart Turn → STT → LLM (streamed) → TTS (streamed) → speaker

Client events handled: session.update, input_audio_buffer.append,
conversation.item.create, response.create, response.cancel,
conversation.item.delete (pong and the rest are ignored).

Beyond parity, two things a speech-to-speech session doesn't do:
  * an interrupted reply is cut, in the model's own context and in the
    saved transcript, to the words the user actually heard — tracked by a
    playhead that mirrors the browser's audio scheduler;
  * a short "mm-hmm" while the companion talks is recorded but doesn't
    stop them (LiveKit's minimum interruption duration).
"""
import asyncio
import json
import logging
import re
import secrets
import time
import uuid

import numpy as np

from . import setups, smart_turn
from .audio import VAD_RATE, Resampler, TurnDetector, float_to_pcm16_b64, pcm16_b64_to_float
from .llm import LlmError
from .text import CueFilter, SentenceChunker, ThinkFilter, partial_tag_at

_logger = logging.getLogger(__name__)

# The browser starts each reply's audio this far ahead of "now" and plays
# chunks back to back after that (agent_connection.js
# PLAYBACK_JITTER_BUFFER_S) — the playhead below mirrors it.
PLAYBACK_CUSHION_S = 0.12
# Smart Turn's own decision boundary (pipecat-ai/smart-turn inference.py:
# prediction = probability > 0.5).
SMART_TURN_COMPLETE = 0.5
# Audio chunks sent to the browser: small enough that the heard-text
# estimate is word-accurate, large enough not to flood the socket.
SEND_CHUNK_S = 0.1
# The browser sends no audio while muted; a turn without audio for this
# long hears the gap as silence (see _watch_mic). Not a tunable: well past
# the browser's frame interval, well short of any turn timeout.
MIC_GAP_S = 0.5

# ---------------------------------------------------------------------------
# Connection grants: /api/voice/session/start mints one per call leg, the
# WebSocket redeems it once (the realtime client sends it as its
# xai-client-secret subprotocol, exactly as it does for xAI).
# ---------------------------------------------------------------------------

_grants = {}
GRANT_TTL_S = 3600


def mint_grant(session_id, setup_id):
    now = time.monotonic()
    for token, grant in list(_grants.items()):
        if grant[2] < now:
            _grants.pop(token, None)
    token = secrets.token_urlsafe(24)
    _grants[token] = (session_id, setup_id, now + GRANT_TTL_S)
    return token


def redeem_grant(token):
    """(session id, voice setup id) for a live grant, else None."""
    session_id, setup_id, expires = _grants.pop(token or '', (None, None, 0))
    return (session_id, setup_id) if expires >= time.monotonic() else None


def _id(prefix):
    return f'{prefix}_{uuid.uuid4().hex[:20]}'


def _visible(raw):
    """Transcript text, safe on a partial stream: a tag still being written
    is held back rather than shown half-typed. Finished tags stay in, as on
    a Grok Realtime call: the saved line shows the whisper or the laugh, and
    a resumed conversation shows the companion its own expression."""
    cut = partial_tag_at(raw)
    text = raw if cut < 0 else raw[:cut]
    return re.sub(r'[ \t]{2,}', ' ', text).lstrip()


class _Spoken:
    """One stretch of reply text and the playback intervals of its audio."""
    __slots__ = ('text', 'intervals')

    def __init__(self, text):
        self.text = text
        self.intervals = []


def _heard(spoken, at):
    """The reply text heard by time `at`: whole stretches whose audio has
    played, then a proportional share of the one playing at `at` (by words,
    or by characters for text without spaces). Returns (text, cut_short)."""
    out = []
    for seg in spoken:
        total = sum(e - s for s, e in seg.intervals)
        if seg.intervals and total <= 0:
            # Shown without audio (_SentenceSpeech): heard once reached.
            if seg.intervals[0][0] > at:
                return ''.join(out), True
            out.append(seg.text)
            continue
        heard = sum(max(0.0, min(e, at) - s) for s, e in seg.intervals if s < at)
        if heard <= 0 or total <= 0:
            return ''.join(out), True
        if heard >= total - 1e-3:
            out.append(seg.text)
            continue
        share = heard / total
        if ' ' in seg.text.strip():
            words = seg.text.split(' ')
            out.append(' '.join(words[:max(1, round(len(words) * share))]))
        else:
            out.append(seg.text[:max(1, round(len(seg.text) * share))])
        return ''.join(out), True
    return ''.join(out), False


class _Response:
    def __init__(self):
        self.id = _id('resp')
        self.task = None
        self.message = None        # the assistant message item, once text arrives
        self.raw = ''              # reply text with speech tags, thinking removed
        self.output = []           # output items, for response.done
        self.spoken = []           # [_Spoken], in playback order
        self.usage = {}
        self.status = 'in_progress'
        self.cancel_at = None      # playback time the cancel happened at
        self.had_audio = False
        self.transcript_sent = ''  # visible transcript emitted so far
        self.errored = False
        self.resamplers = {}       # engine rate → Resampler to the call's rate
        self.head_start = None     # the _Speculation this reply took over
        self.started = False       # response.created sent
        self.finished = False      # response.done sent


def _same_words(a, b):
    """Two transcripts that say the same thing, punctuation, case and
    spacing aside (a Japanese partial and its final can differ in spaces)."""
    norm = lambda s: ''.join(re.sub(r'[^\w\s]', ' ', (s or '').lower()).split())
    return norm(a) == norm(b)


class _Speculation:
    """A reply started on a turn's last live words before its final
    transcript is in — LiveKit Agents' preemptive generation (on by default
    there): the brain's first-token time overlaps the transcriber's
    finalisation. Nothing is said or sent: the brain's events wait in a
    queue, and the reply that takes this over plays them as if it had asked
    itself. Final words that differ throw it away."""

    def __init__(self, session, text):
        self.text = text
        self.started = time.perf_counter()
        self._queue = asyncio.Queue()
        items = list(session.items) + [{'type': 'message', 'role': 'user',
                                        'content': [{'type': 'input_audio', 'transcript': text}]}]
        self.task = session._spawn(self._pull(session.llm.stream(
            instructions=session.instructions, items=items, tools=session.tools,
            conversation_key=f'rexclaw-voice:{session.session_id}')))

    async def _pull(self, stream):
        try:
            async for ev in stream:
                await self._queue.put(ev)
            await self._queue.put(None)
        except Exception as e:   # raised again by events(), in the reply
            await self._queue.put(e)
        finally:
            await stream.aclose()

    async def events(self):
        while True:
            ev = await self._queue.get()
            if ev is None:
                return
            if isinstance(ev, Exception):
                raise ev
            yield ev

    def cancel(self):
        self.task.cancel()


class PipelineSession:

    def __init__(self, ws, *, session_id, config, setup, on_request=None):
        self.ws = ws
        self.on_request = on_request   # (tokens, full): a reply's request size, recorded
        self.session_id = session_id
        self.config = config
        self.turn_cfg = setup.turn
        self.stt, self.llm, self.tts = setup.build(config)
        self.items = []
        self.instructions = ''
        self.tools = []
        self._cue_tools = {}
        self._cue_end_turn = set()
        self.voice = None
        self.speed = 1.0
        self.keyterms = []
        self.rate = 24000
        self.vad_on = False
        self.create_response = True
        self._out = asyncio.Queue()
        self._resp = None
        self._queued = False       # a response.create waiting for the current reply
        self._owed = False         # a turn's answer held back for the next turn's end
        self._spec = None          # a _Speculation on the turn just judged over
        self._last = None          # the last finished reply (its audio may still play)
        self._playhead = 0.0       # monotonic time the scheduled audio ends
        self._to16k = Resampler(self.rate, VAD_RATE)
        self._detector = None
        self._smart_turn = False
        self._stt_stream = None
        self._stt_reader = None
        self._turn_item = None     # item id of the utterance in progress
        self._turn_started = False # speech_started sent for it
        self._turn_text = ''       # its live transcript so far
        self._pending_interrupt = False   # talk-over not yet long enough to interrupt
        self._turn_rev = 0
        self._stt_lock = asyncio.Lock()
        self._partial_task = None
        self._heard_at = 0.0       # when mic audio last reached the turn detector
        self._mic_watch = None
        self._committed_at = None
        self._metrics = None
        self._context_tokens = 0   # the last reply's full input size (see _budget_usage)
        self._tasks = set()
        self._closed = False

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def emit(self, event):
        event.setdefault('event_id', _id('event'))
        self._out.put_nowait(event)

    async def _sender(self):
        while True:
            event = await self._out.get()
            if event is None:
                return
            try:
                await self.ws.send_text(json.dumps(event))
            except Exception:
                return

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return task

    async def run(self):
        sender = asyncio.create_task(self._sender())
        self.emit({'type': 'session.created', 'session': {'id': _id('sess'), 'object': 'realtime.session'}})
        try:
            while True:
                try:
                    raw = await self.ws.receive_text()
                except Exception:
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                try:
                    await self._handle(msg)
                except Exception as e:
                    _logger.exception('voice pipeline: %s failed', msg.get('type'))
                    self._error(str(e), event_id=msg.get('event_id'))
        finally:
            self._closed = True
            await self._shutdown()
            self._out.put_nowait(None)
            await sender

    async def _shutdown(self):
        for task in list(self._tasks):
            task.cancel()
        if self._stt_stream:
            await self._stt_stream.close()
        for engine in (self.stt, self.llm, self.tts):
            try:
                await engine.close()
            except Exception:
                pass

    def _error(self, message, *, code='server_error', event_id=None):
        err = {'type': code, 'code': code, 'message': message}
        if event_id:
            err['event_id'] = event_id
        self.emit({'type': 'error', 'error': err})

    async def _handle(self, msg):
        kind = msg.get('type')
        if kind == 'input_audio_buffer.append':
            await self._on_audio(msg.get('audio') or '')
        elif kind == 'session.update':
            await self._on_session_update(msg.get('session') or {})
        elif kind == 'conversation.item.create':
            self._add_item(msg.get('item') or {}, previous_id=msg.get('previous_item_id'))
        elif kind == 'response.create':
            self._request_response()
        elif kind == 'response.cancel':
            # Also sent when the browser stops a finished reply's tail
            # (typed input, a group-call hand-off): trim it to what was
            # heard and pull the playhead back to now.
            await self._interrupt(time.monotonic())
        elif kind == 'conversation.item.delete':
            self.items = [i for i in self.items if i.get('id') != msg.get('item_id')]
            self.emit({'type': 'conversation.item.deleted', 'item_id': msg.get('item_id')})

    # ------------------------------------------------------------------
    # Session configuration
    # ------------------------------------------------------------------

    async def _on_session_update(self, session):
        if 'instructions' in session:
            self.instructions = session.get('instructions') or ''
        if 'tools' in session:
            hosted = set(self.llm.hosted_tools)
            sent = session.get('tools') or []
            self.tools = [t for t in sent if t.get('type') == 'function' or t.get('type') in hosted]
            # Tools a written cue can stand for (text.CueFilter): one string
            # argument besides end_turn — set_emotion, play_gesture, move_around.
            self._cue_tools, self._cue_end_turn = {}, set()
            for t in self.tools:
                params = t.get('parameters') or {}
                props = params.get('properties') or {}
                required = [r for r in params.get('required') or [] if r != 'end_turn']
                if t.get('type') == 'function' and len(required) == 1 \
                        and (props.get(required[0]) or {}).get('type') == 'string':
                    self._cue_tools[t['name']] = required[0]
                    if 'end_turn' in props:
                        self._cue_end_turn.add(t['name'])
            dropped = sorted({t.get('type') for t in sent} - {t.get('type') for t in self.tools})
            if dropped:
                _logger.info('voice pipeline %s: no %s with the %s brain',
                             self.session_id, ', '.join(dropped), self.llm.label)
        if session.get('voice'):
            self.voice = session['voice']
        audio = session.get('audio') or {}
        audio_in = audio.get('input') or {}
        rate = (audio_in.get('format') or {}).get('rate')
        if rate and int(rate) != self.rate:
            self.rate = int(rate)
            self._to16k = Resampler(self.rate, VAD_RATE)
        if 'speed' in (audio.get('output') or {}):
            self.speed = float(audio['output'].get('speed') or 1.0)
        transcription = audio_in.get('transcription') or {}
        if 'keyterms' in transcription:
            self.keyterms = list(transcription.get('keyterms') or [])
        if 'turn_detection' in session:
            td = session.get('turn_detection') or {}
            self.vad_on = td.get('type') == 'server_vad'
            self.create_response = td.get('create_response', True) is not False
            await self._configure_listening()
        if self.voice:
            self._spawn(self._warm())
        partials = self.stt.streaming or int(self.stt.get('partial_ms') or 0) > 0
        self.emit({'type': 'session.updated', 'session': {
            'voice': self.voice,
            'instructions': self.instructions,
            'tools': self.tools,
            'turn_detection': {'type': 'server_vad' if self.vad_on else None},
            'audio': {
                'input': {'format': {'type': 'audio/pcm', 'rate': self.rate},
                          'transcription': {'model': self.stt.model_name,
                                            'streaming': bool(partials and self.vad_on)}},
                'output': {'format': {'type': 'audio/pcm', 'rate': self.rate}, 'speed': self.speed},
            },
        }})

    async def _warm(self):
        try:
            await self.tts.warm(voice=self.voice, speed=self.speed, rate=self.rate)
        except Exception as e:
            _logger.info('voice pipeline: TTS warm-up failed: %s', e)

    async def _configure_listening(self):
        """The mic side of the leg: a turn detector, and a streaming
        transcriber when the engine is one. Peer legs of a group call run
        without turn detection and never hear the mic."""
        if self._stt_reader:
            self._stt_reader.cancel()
            self._stt_reader = None
        if self._stt_stream:
            await self._stt_stream.close()
            self._stt_stream = None
        self._detector = None
        self._smart_turn = False
        if not self.vad_on:
            return
        if self._mic_watch is None:
            self._mic_watch = self._spawn(self._watch_mic())
        t = self.turn_cfg
        threshold = min(0.95, max(0.1, float(t['vad_threshold'])))
        if self.stt.streaming:
            # The engine decides where turns end; the local detector notices
            # speech starting (barge-in, the listening face), and with Smart
            # Turn on it tells the engine to finalise the moment the thought
            # sounds finished — xAI's own end of turn lands ~1.2 s after
            # speech stops, a finalize ~0.45 s (measured 2026-10-01; Pipecat's
            # STT benchmark has xAI at 1.3 s median). The engine's own
            # endpointing stays the backstop, and the detector's timeout a
            # safety net for noise the engine ignored.
            timeout = int(self.stt.get('smart_turn_timeout') or 3000) + 2000
            self._smart_turn = bool(t['smart_turn']) and smart_turn.available()
            self._detector = TurnDetector(threshold=threshold, max_silence_ms=timeout,
                                          **({} if self._smart_turn else {'pause_ms': timeout}))
            try:
                self._stt_stream = await self.stt.open_stream(keyterms=self.keyterms)
            except Exception as e:
                await self._deaf(e)
                return
            self._stt_reader = self._spawn(self._read_stt_stream())
        elif t['smart_turn'] and smart_turn.available():
            self._smart_turn = True
            self._detector = TurnDetector(threshold=threshold, max_silence_ms=int(t['max_silence_ms']))
        else:
            silence = int(t['silence_ms'])
            self._detector = TurnDetector(threshold=threshold, pause_ms=silence, max_silence_ms=silence)

    # ------------------------------------------------------------------
    # Conversation items
    # ------------------------------------------------------------------

    def _add_item(self, item, previous_id=None, emit=True):
        item = dict(item)
        item.setdefault('id', _id('item'))
        item.setdefault('type', 'message')
        index = len(self.items)
        if previous_id:
            for i, existing in enumerate(self.items):
                if existing.get('id') == previous_id:
                    index = i + 1
                    break
        self.items.insert(index, item)
        if emit:
            self._announce(item)
        return item

    def _announce(self, item):
        index = self.items.index(item)
        self.emit({'type': 'conversation.item.added', 'item': item,
                   'previous_item_id': self.items[index - 1]['id'] if index > 0 else None})

    # ------------------------------------------------------------------
    # Listening
    # ------------------------------------------------------------------

    def _companion_audible(self):
        return time.monotonic() < self._playhead

    async def _on_audio(self, b64):
        if not self._detector or not b64:
            return
        samples = self._to16k(pcm16_b64_to_float(b64))
        if samples.size:
            await self._hear(samples)

    async def _watch_mic(self):
        """Muting stops the browser's audio (agent_connection.js sends
        nothing while muted), and the detector and the transcriber count
        silence in audio received — muted mid-sentence, the turn would stay
        open for good and every later reply wait on it. Audio missing
        during a turn is heard as the silence it is."""
        while True:
            await asyncio.sleep(MIC_GAP_S)
            gap = time.monotonic() - self._heard_at
            if self._detector and self._detector.in_turn and gap >= MIC_GAP_S:
                await self._hear(np.zeros(int(VAD_RATE * gap), np.float32))

    async def _hear(self, samples):
        self._heard_at = time.monotonic()
        if self._stt_stream:
            await self._stt_stream.push(samples)
        for event, audio_ms in self._detector.feed(samples):
            await self._on_turn_event(event, audio_ms)
        if (self._pending_interrupt and self._detector.in_turn
                and self._detector.voiced_ms >= int(self.turn_cfg['interrupt_ms'])):
            self._pending_interrupt = False
            await self._speech_started(self._detector.audio_ms - self._detector.voiced_ms)

    async def _on_turn_event(self, event, audio_ms):
        detector = self._detector
        if event == 'start':
            self._drop_speculation()
            self._turn_rev += 1
            self._turn_item = _id('item')
            self._turn_started = False
            self._turn_text = ''
            if self._companion_audible():
                # Talking over the companion: an interruption only once it
                # has lasted interrupt_ms of actual speech (see _on_audio).
                self._pending_interrupt = True
            else:
                await self._speech_started(audio_ms)
            return
        if event == 'resume':
            self._turn_rev += 1    # a Smart Turn verdict still running is stale
            self._drop_speculation()
            return
        if not detector.in_turn and detector.state != 'ended':
            return                 # this turn was already closed
        if self.stt.streaming:
            if event == 'timeout':
                # The engine never finalised: noise it filtered out. Close
                # the turn so the browser doesn't wait for words forever.
                detector.end_turn()
                self._pending_interrupt = False
                if self._turn_started:
                    self._close_turn_without_words(audio_ms)
            elif event == 'pause' and self._smart_turn and self._turn_started:
                self._spawn(self._judge_turn(self._turn_rev, detector.utterance()))
            return
        if event == 'pause' and self._smart_turn and not self._pending_interrupt:
            self._spawn(self._judge_turn(self._turn_rev, detector.utterance()))
            return
        await self._end_local_turn(audio_ms)

    async def _judge_turn(self, rev, audio):
        started = time.perf_counter()
        probability = await asyncio.to_thread(smart_turn.probability_complete, audio)
        _logger.debug('smart turn: %.3f in %.0f ms', probability, (time.perf_counter() - started) * 1000)
        if rev != self._turn_rev or not self._detector or self._detector.state != 'paused':
            return
        if probability <= SMART_TURN_COMPLETE:
            return
        self._speculate()
        if self.stt.streaming:
            if self._stt_stream:
                await self._stt_stream.finalize()   # its final ends the turn
        else:
            await self._end_local_turn(self._detector.audio_ms)

    async def _speech_started(self, audio_ms):
        self._turn_started = True
        self.emit({'type': 'input_audio_buffer.speech_started', 'audio_start_ms': max(0, audio_ms),
                   'item_id': self._turn_item})
        await self._interrupt(time.monotonic())
        if not self.stt.streaming and int(self.stt.get('partial_ms') or 0) > 0:
            self._partial_task = self._spawn(self._partials(self._turn_item))

    async def _end_local_turn(self, audio_ms):
        """A batch engine's utterance is over: transcribe it."""
        detector = self._detector
        start_ms = detector.audio_ms - detector.voiced_ms
        audio = detector.end_turn()
        if self._pending_interrupt:
            self._pending_interrupt = False
            if self._companion_audible():
                # Too short to interrupt: a backchannel. Kept, not answered.
                self._spawn(self._record_backchannel(audio=audio))
                return
            # The companion finished while it was said ("Sure" over the
            # last words of a question): a turn like any other.
            await self._speech_started(start_ms)
        if not self._turn_started:
            self._settle_owed()
            return
        item_id = self._turn_item
        self._commit(item_id, audio_ms)
        self._spawn(self._transcribe_and_answer(item_id, audio))

    def _commit(self, item_id, audio_ms):
        self._turn_started = False
        if self._partial_task:
            self._partial_task.cancel()
            self._partial_task = None
        self._committed_at = time.perf_counter()
        self.emit({'type': 'input_audio_buffer.speech_stopped', 'audio_end_ms': audio_ms, 'item_id': item_id})
        self.emit({'type': 'input_audio_buffer.committed', 'item_id': item_id,
                   'previous_item_id': self.items[-1]['id'] if self.items else None})
        self._add_item({'id': item_id, 'type': 'message', 'role': 'user',
                        'content': [{'type': 'input_audio', 'transcript': None}]})

    async def _transcribe_and_answer(self, item_id, audio):
        async with self._stt_lock:   # transcripts land in the order spoken
            started = time.perf_counter()
            try:
                text = await self.stt.transcribe(audio, keyterms=self.keyterms)
            except Exception as e:
                _logger.warning('voice pipeline: transcription failed: %s', e)
                self._error(f'Transcription failed: {e}')
                text = ''
            stt_ms = round((time.perf_counter() - started) * 1000)
        self._set_transcript(item_id, text)
        if text:
            self._metrics = {'stt_ms': stt_ms}
            self._auto_respond(text)
        else:
            self._drop_speculation()
            self._settle_owed()

    def _set_transcript(self, item_id, text):
        self.emit({'type': 'conversation.item.input_audio_transcription.completed',
                   'item_id': item_id, 'content_index': 0, 'transcript': text})
        item = next((i for i in self.items if i.get('id') == item_id), None)
        if item is None:
            return
        if text:
            item['content'] = [{'type': 'input_audio', 'transcript': text}]
        else:
            self.items.remove(item)

    def _auto_respond(self, spoken=None):
        """Answer the turn that just ended; `spoken` is its final transcript,
        which may let the reply take over a speculation."""
        if not (self.vad_on and self.create_response):
            return
        if self._detector and self._detector.in_turn:
            # Still talking (a new utterance began while this one was being
            # transcribed): that one's end will answer both.
            self._owed = True
            return
        self._request_response(spoken)

    def _settle_owed(self):
        """A turn closed without words (a cough, noise): answer the turn it
        held back, which would otherwise never get a reply."""
        if self._owed:
            self._auto_respond()

    def _close_turn_without_words(self, audio_ms):
        self._turn_started = False
        self.emit({'type': 'input_audio_buffer.speech_stopped', 'audio_end_ms': audio_ms,
                   'item_id': self._turn_item})
        self.emit({'type': 'conversation.item.input_audio_transcription.completed',
                   'item_id': self._turn_item, 'content_index': 0, 'transcript': ''})
        self._drop_speculation()
        self._settle_owed()

    async def _deaf(self, error):
        """The transcriber is gone: end the call rather than keep a session
        that hears speech start and never gets the words."""
        _logger.warning('voice pipeline: speech recognition failed: %s', error)
        self._error(f'Speech recognition failed: {error}')
        await asyncio.sleep(0.2)   # let the error reach the browser first
        try:
            await self.ws.close(code=1011)
        except Exception:
            pass

    async def _record_backchannel(self, *, audio=None, text=None):
        if text is None:
            try:
                async with self._stt_lock:
                    text = await self.stt.transcribe(audio, keyterms=self.keyterms)
            except Exception:
                return
        if not text:
            return
        item = self._add_item({'type': 'message', 'role': 'user',
                               'content': [{'type': 'input_audio', 'transcript': text}]})
        self.emit({'type': 'conversation.item.input_audio_transcription.completed',
                   'item_id': item['id'], 'content_index': 0, 'transcript': text})

    async def _partials(self, item_id):
        """Live words for a batch engine: re-transcribe the utterance so far
        at the configured interval while it lasts."""
        interval = max(0.3, int(self.stt.get('partial_ms')) / 1000)
        last = ''
        while self._turn_item == item_id and self._detector and self._detector.in_turn:
            await asyncio.sleep(interval)
            audio = self._detector.utterance() if self._detector else None
            if audio is None or not audio.size:
                continue
            try:
                text = await self.stt.transcribe(audio, keyterms=self.keyterms)
            except Exception:
                continue
            if text and text != last and self._turn_item == item_id and self._turn_started:
                last = self._turn_text = text
                self.emit({'type': 'conversation.item.input_audio_transcription.updated',
                           'item_id': item_id, 'transcript': text})

    async def _read_stt_stream(self):
        try:
            async for kind, text in self._stt_stream.events():
                await self._on_stt_event(kind, text)
        except Exception as e:
            await self._deaf(e)
            return
        if not self._closed:
            await self._deaf('the connection closed')

    async def _on_stt_event(self, kind, text):
        detector = self._detector
        if kind == 'partial':
            self._turn_text = text
            if self._turn_started:
                self.emit({'type': 'conversation.item.input_audio_transcription.updated',
                           'item_id': self._turn_item, 'transcript': text})
            return
        if (not self._turn_started and not self._pending_interrupt
                and detector and not detector.heard_voice):
            # Words when nothing on the mic sounded like a voice since the
            # last turn: the transcriber filling silence or noise (seen live:
            # stock sentences, its own key-term list). Not a turn.
            _logger.info('voice pipeline %s: transcript with no voice heard, dropped (%d words)',
                         self.session_id, len(text.split()))
            return
        # A final: the engine says the turn is over. Said over the
        # companion and too short to interrupt, it's a backchannel —
        # unless the companion finished first (see _end_local_turn).
        backchannel = self._companion_audible() and (self._pending_interrupt or not self._turn_started)
        self._pending_interrupt = False
        if backchannel:
            if detector and detector.in_turn:
                detector.end_turn()
            await self._record_backchannel(text=text)
            return
        if not self._turn_started:
            # Quiet speech the local detector missed: open the turn now.
            self._turn_rev += 1
            self._turn_item = _id('item')
            await self._speech_started(detector.audio_ms if detector else 0)
        if detector and detector.in_turn:
            detector.end_turn()
        item_id = self._turn_item
        self._commit(item_id, detector.audio_ms if detector else 0)
        self._set_transcript(item_id, text)
        self._auto_respond(text)

    # ------------------------------------------------------------------
    # Replies
    # ------------------------------------------------------------------

    def _request_response(self, spoken=None):
        self._owed = False
        spec, self._spec = self._spec, None
        if self._resp is not None:
            self._queued = True   # requests during a reply collapse into one
            if spec:
                spec.cancel()
            return
        resp = _Response()
        if spec and spoken and _same_words(spec.text, spoken):
            resp.head_start = spec
        elif spec:
            _logger.info('voice pipeline %s: early reply dropped - heard %r, then %r',
                         self.session_id, spec.text, spoken)
            spec.cancel()
        self._resp = resp
        resp.task = self._spawn(self._run_response(resp))
        resp.task.add_done_callback(lambda _task: self._response_ended(resp))

    def _response_ended(self, resp):
        """Every reply task's end, however it ended — including a cancel
        that lands before the task first runs, which skips its body
        entirely. The floor is free again, and a reply asked for meanwhile
        starts."""
        if self._resp is not resp:
            return
        if resp.started and not resp.finished:
            resp.status = 'cancelled'
            self._finish_response(resp)
        if resp.head_start:
            resp.head_start.cancel()
        self._resp = None
        self._last = resp
        if self._queued and not self._closed:
            self._queued = False
            self._request_response()

    def _speculate(self):
        """The turn sounds finished: start the brain on its live transcript
        while the final one is made (see _Speculation)."""
        text = self._turn_text.strip()
        if (not text or self._spec or self._resp is not None or not self.turn_cfg.get('preemptive')
                or not (self.vad_on and self.create_response)):
            return
        # An earlier turn still being transcribed would be missing from it.
        if any(i.get('role') == 'user' and any(c.get('transcript', '') is None for c in i.get('content') or [])
               for i in self.items):
            return
        self._spec = _Speculation(self, text)

    def _drop_speculation(self):
        if self._spec:
            self._spec.cancel()
            self._spec = None

    async def _interrupt(self, at):
        """The user started speaking: stop the reply in progress, or trim
        the finished one whose audio is still playing out."""
        self._queued = False
        self._drop_speculation()
        # The finished reply can still be playing while a newer one runs (a
        # tool call's follow-up): both are cut.
        last = self._last if self._last is not None and at < self._playhead else None
        if self._resp is not None:
            await self._cancel_response(at)
        if last is not None:
            self._truncate(last, at)
        self._playhead = min(self._playhead, at)

    async def _cancel_response(self, at):
        resp = self._resp
        if resp is None or resp.task is None:
            return
        if resp.cancel_at is None:
            # Once: a second cancel would land in the reply's own clean-up
            # (its TTS stopping) and cut that short.
            resp.cancel_at = at
            resp.task.cancel()
        try:
            await resp.task
        except asyncio.CancelledError:
            pass
        self._playhead = min(self._playhead, at)

    def _truncate(self, resp, at):
        """Cut a reply's message item to the words heard by `at`; returns
        the heard text (with speech tags)."""
        if resp.message is None:
            return ''
        heard, cut = _heard(resp.spoken, at)
        heard = heard.rstrip()
        # Cut short also when the brain was still writing past what was voiced.
        if heard and (cut or resp.status != 'completed'):
            heard += '—'
        if heard:
            resp.message['content'] = [{'type': 'output_audio', 'transcript': heard}]
        elif resp.message in self.items:
            self.items.remove(resp.message)
        return heard

    async def _measure(self, resp):
        """Record the reply's request size — before response.done, so the
        browser's transcript save for this reply already hears a summary
        is owed — and show it on the budget meter. A database write: off
        the event loop, which every call's audio shares."""
        tokens = setups.request_tokens(resp.usage)
        if not tokens:
            return
        if self.on_request:
            try:
                await asyncio.to_thread(self.on_request, tokens, self.llm.settings)
            except Exception:
                _logger.exception('voice pipeline: could not record the request size')
        self.emit({'type': 'rexclaw.context_tokens', 'tokens': tokens})

    async def _run_response(self, resp):
        resp.started = True
        self.emit({'type': 'response.created', 'response': {
            'id': resp.id, 'object': 'realtime.response', 'status': 'in_progress', 'output': []}})
        metrics, self._metrics = self._metrics or {}, None
        committed_at, self._committed_at = self._committed_at, None
        t0 = time.perf_counter()
        speech = _SentenceSpeech(self, resp)
        snapshot = list(self.items)
        think = ThinkFilter()
        cues = CueFilter(self._cue_tools)
        tools = self.tools
        head_start = resp.head_start
        if head_start:
            metrics['head_start_ms'] = round((t0 - head_start.started) * 1000)
        try:
            while True:
                if head_start:
                    stream, head_start = resp.head_start.events(), None
                else:
                    stream = self.llm.stream(instructions=self.instructions, items=snapshot, tools=tools,
                                             conversation_key=f'rexclaw-voice:{self.session_id}')
                try:
                    async for ev in stream:
                        if 'brain_ms' not in metrics:
                            metrics['brain_ms'] = round((time.perf_counter() - t0) * 1000)
                        if ev[0] == 'text':
                            await self._say_pieces(resp, speech, cues.feed(think.feed(ev[1])))
                        elif ev[0] == 'tool_call':
                            await speech.mark(self._function_call_emitter(resp, *ev[1:]))
                        elif ev[0] == 'hosted_call':
                            await speech.mark(self._hosted_call_emitter(resp, ev[1]))
                        elif ev[0] == 'usage':
                            resp.usage = ev[1] or {}
                    break
                except LlmError as e:
                    # xAI's search loop past the limit before a word was
                    # said: answer again without searching, as text chat does.
                    if 'searches' in str(e) and tools is self.tools and not resp.raw and not resp.output:
                        _logger.warning('voice pipeline: %s - replying without search', e)
                        tools = [t for t in self.tools if t.get('type') not in ('web_search', 'x_search')]
                        continue
                    raise
                finally:
                    await stream.aclose()
            await self._say_pieces(resp, speech, cues.feed(think.flush()) + cues.flush())
            await speech.finish()
            resp.status = 'completed'
        except asyncio.CancelledError:
            resp.status = 'cancelled'
            await speech.cancel()
            if resp.head_start:
                resp.head_start.cancel()
        except Exception as e:
            _logger.warning('voice pipeline: reply failed: %s', e)
            resp.status = 'failed'
            await speech.cancel()
            if not resp.errored:
                resp.errored = True
                self._error(str(e))
        await self._measure(resp)
        self._finish_response(resp)
        if speech.first_audio_at is not None:
            metrics['first_audio_ms'] = round((speech.first_audio_at - t0) * 1000)
            if committed_at is not None:
                metrics['end_of_speech_to_audio_ms'] = round((speech.first_audio_at - committed_at) * 1000)
        if resp.usage:
            # How much of the prompt the provider served from its cache — the
            # brain's first-token time depends on it.
            usage = _usage(resp.usage)
            metrics['input_tokens'] = usage['input_tokens']
            metrics['cached_tokens'] = usage['input_token_details']['cached_tokens']
        if metrics:
            _logger.info('voice pipeline %s %s: %s', self.session_id, resp.status, metrics)
            self.emit({'type': 'rexclaw.pipeline_metrics', 'response_id': resp.id, **metrics})
        # The floor is let go in _response_ended, which runs however the
        # task ends.

    async def _say_pieces(self, resp, speech, pieces):
        for piece in pieces:
            if piece[0] == 'text':
                await self._say(resp, speech, piece[1])
                continue
            # A cue written into the reply: made the call it stands for, at
            # its place in the speech. end_turn, where the tool takes it: the
            # reply is already speaking, so no follow-up reply is owed.
            _, name, args = piece
            if name in self._cue_end_turn:
                args['end_turn'] = True
            await speech.mark(self._function_call_emitter(resp, _id('call'), name, json.dumps(args)))

    async def _say(self, resp, speech, text):
        if resp.message is None:
            self._open_message(resp)
        resp.raw += text
        await speech.feed(text)

    def _open_message(self, resp):
        resp.message = self._add_item({'type': 'message', 'role': 'assistant',
                                       'status': 'in_progress', 'content': []})
        resp.output.append(resp.message)
        self.emit({'type': 'response.output_item.added', 'response_id': resp.id,
                   'output_index': len(resp.output) - 1, 'item': resp.message})
        self.emit({'type': 'response.content_part.added', 'response_id': resp.id,
                   'item_id': resp.message['id'], 'output_index': 0, 'content_index': 0,
                   'part': {'type': 'audio', 'transcript': ''}})

    def _function_call_emitter(self, resp, call_id, name, arguments):
        def fire():
            item = self._add_item({'type': 'function_call', 'call_id': call_id, 'name': name,
                                   'arguments': arguments, 'status': 'completed'}, emit=False)
            resp.output.append(item)
            index = len(resp.output) - 1
            self.emit({'type': 'response.output_item.added', 'response_id': resp.id,
                       'output_index': index, 'item': {**item, 'arguments': '', 'status': 'in_progress'}})
            self.emit({'type': 'response.function_call_arguments.done', 'response_id': resp.id,
                       'item_id': item['id'], 'output_index': index, 'call_id': call_id,
                       'name': name, 'arguments': arguments})
            self.emit({'type': 'response.output_item.done', 'response_id': resp.id,
                       'output_index': index, 'item': item})
            self._announce(item)
        return fire

    def _hosted_call_emitter(self, resp, item):
        """A call the brain's provider ran itself (an MCP call, a web
        search, a code run) — reported the way realtime reports MCP calls,
        so the transcript records it, and kept in this call's conversation
        as a call and its result, so the next reply knows it happened (the
        brain engines replay a call of an undeclared tool as a note). Not
        announced to the browser as a function call: nothing there runs it."""
        def fire():
            call_id = item.get('id') or _id('mcp')
            name = item.get('name') or 'mcp'
            self._add_item({'type': 'function_call', 'call_id': call_id, 'name': name,
                            'arguments': item.get('arguments') or '{}', 'status': 'completed'}, emit=False)
            self._add_item({'type': 'function_call_output', 'call_id': call_id,
                            'output': f"failed: {item['error']}" if item.get('error') else item.get('output') or 'done'},
                           emit=False)
            self.emit({'type': 'response.mcp_call_arguments.done', 'response_id': resp.id,
                       'call_id': call_id, 'arguments': item.get('arguments') or ''})
            self.emit({'type': 'response.mcp_call.in_progress', 'response_id': resp.id,
                       'call_id': call_id, 'name': name, 'item_id': call_id})
            if item.get('error'):
                self.emit({'type': 'response.mcp_call.failed', 'response_id': resp.id, 'call_id': call_id,
                           'name': name, 'error': {'type': 'failed', 'message': str(item['error'])}})
            else:
                self.emit({'type': 'response.mcp_call.completed', 'response_id': resp.id,
                           'call_id': call_id, 'name': name, 'output': item.get('output')})
        return fire

    def emit_transcript(self, resp, visible):
        """Send the part of `visible` (the reply as voiced so far) not yet
        sent — just ahead of the audio that speaks it, which is what keeps
        the gestures and the face in step with the voice."""
        if resp.message is None or not visible.startswith(resp.transcript_sent):
            return
        delta = visible[len(resp.transcript_sent):]
        if delta:
            resp.transcript_sent = visible
            self.emit({'type': 'response.output_audio_transcript.delta', 'response_id': resp.id,
                       'item_id': resp.message['id'], 'output_index': 0, 'content_index': 0,
                       'delta': delta})

    def emit_audio(self, resp, samples, rate, segment):
        """Send audio to the browser, noting where it lands on the playback
        timeline (see PLAYBACK_CUSHION_S)."""
        if rate != self.rate:
            if rate not in resp.resamplers:
                resp.resamplers[rate] = Resampler(rate, self.rate)
            samples = resp.resamplers[rate](samples)
        if not samples.size:
            return
        resp.had_audio = True
        step = int(self.rate * SEND_CHUNK_S)
        for i in range(0, samples.size, step):
            piece = samples[i:i + step]
            start = max(self._playhead, time.monotonic() + PLAYBACK_CUSHION_S)
            self._playhead = start + piece.size / self.rate
            segment.intervals.append((start, self._playhead))
            self.emit({'type': 'response.output_audio.delta', 'response_id': resp.id,
                       'item_id': resp.message['id'] if resp.message else None,
                       'output_index': 0, 'content_index': 0, 'delta': float_to_pcm16_b64(piece)})

    def _finish_response(self, resp):
        resp.finished = True
        if resp.status == 'completed':
            # The sentences as voiced (formatting a voice can't say already
            # filtered out), tags kept for the model's own context.
            spoken = ''.join(seg.text for seg in resp.spoken).strip()
            transcript = spoken
            if resp.message is not None:
                resp.message['content'] = [{'type': 'output_audio', 'transcript': spoken}]
        else:
            # Cancelled: what played before the cancel. Failed: everything
            # already sent, which still plays out.
            at = (resp.cancel_at or time.monotonic()) if resp.status == 'cancelled' else float('inf')
            transcript = self._truncate(resp, at)
        if resp.message is not None:
            resp.message['status'] = 'completed' if resp.status == 'completed' else 'incomplete'
            if transcript:
                # An interrupted reply reports what was heard — the browser
                # saves that line, so the transcript matches the context.
                self.emit({'type': 'response.output_audio_transcript.done', 'response_id': resp.id,
                           'item_id': resp.message['id'], 'output_index': 0, 'content_index': 0,
                           'transcript': transcript})
            if resp.had_audio:
                self.emit({'type': 'response.output_audio.done', 'response_id': resp.id,
                           'item_id': resp.message['id'], 'output_index': 0, 'content_index': 0})
            self.emit({'type': 'response.output_item.done', 'response_id': resp.id,
                       'output_index': 0, 'item': resp.message})
        usage = self._budget_usage(resp.usage)
        self.emit({'type': 'response.done', 'usage': usage, 'response': {
            'id': resp.id, 'object': 'realtime.response', 'status': resp.status,
            'output': resp.output, 'usage': usage}})


    def _budget_usage(self, u):
        """Usage for response.done, which the browser adds up against the
        compaction budget (summary_threshold_tokens) — a measure of how far
        the conversation has grown. A text API reports the WHOLE prompt as
        input on every reply (instructions, tools and history re-read each
        time), so passing it through counted the ~18k-token companion prompt
        once per reply and compacted every couple of turns. Report the
        growth instead: how much bigger this reply's input is than the last
        one's. The first reply of a connection adds nothing — its prompt is
        the history already counted before."""
        usage = _usage(u)
        if not usage:
            return usage
        full = usage['input_tokens']
        grown = max(0, full - self._context_tokens) if self._context_tokens else 0
        self._context_tokens = full
        return {**usage, 'input_tokens': grown, 'total_tokens': grown + usage['output_tokens']}


def _usage(u):
    if not u:
        return {}
    inp, out = int(u.get('input_tokens') or 0), int(u.get('output_tokens') or 0)
    cached = int((u.get('input_tokens_details') or {}).get('cached_tokens') or 0)
    return {'input_tokens': inp, 'output_tokens': out, 'total_tokens': inp + out,
            'input_token_details': {'cached_tokens': cached}}


def _log_failure(task):
    if not task.cancelled() and task.exception():
        _logger.error('voice pipeline task failed', exc_info=task.exception())


class _SentenceSpeech:
    """A reply's speech. Each sentence is synthesised as soon as the brain
    has written it, up to LOOKAHEAD at once, and sent in order with its
    transcript just ahead of its audio; a tool call waits its turn behind
    the words spoken before it."""
    LOOKAHEAD = 2

    def __init__(self, session, resp):
        self.s, self.resp = session, resp
        self.chunker = SentenceChunker(keep_tags=session.tts.speech_tags)
        self.queue = asyncio.Queue()    # ('say', (sentence, out)) | ('mark', fn) | None
        self.slots = asyncio.Semaphore(self.LOOKAHEAD)
        self.jobs = []
        self.voiced_raw = ''
        self.first_audio_at = None
        self.emitter = asyncio.create_task(self._emit_in_order())

    async def feed(self, text):
        for sentence in self.chunker.feed(text):
            self._say(sentence)

    async def mark(self, fn):
        # The words before the call become their own sentence, so the call
        # fires right after them rather than after the next sentence.
        for sentence in self.chunker.flush():
            self._say(sentence)
        await self.queue.put(('mark', fn))

    def _say(self, sentence):
        out = asyncio.Queue()
        self.jobs.append(asyncio.create_task(self._synth(sentence, out)))
        self.queue.put_nowait(('say', (sentence, out)))

    async def _synth(self, sentence, out):
        if not sentence.strip():   # written but nothing to say (a bare link)
            await out.put(None)
            return
        async with self.slots:
            try:
                async for samples, rate in self.s.tts.synthesize(
                        sentence, voice=self.s.voice, speed=self.s.speed, rate=self.s.rate):
                    await out.put((samples, rate))
            except Exception as e:
                await out.put(e)
            finally:
                await out.put(None)

    async def _emit_in_order(self):
        while True:
            entry = await self.queue.get()
            if entry is None:
                return
            kind, payload = entry
            if kind == 'mark':
                payload()
                continue
            sentence, out = payload
            # The transcript and the brain's context get the sentence as
            # written (links and all); the voice says the filtered one.
            written = sentence.written or str(sentence)
            segment = _Spoken(written + ' ')
            self.resp.spoken.append(segment)
            announced = False
            while True:
                chunk = await out.get()
                if chunk is None:
                    if not announced:
                        # Nothing played (a bare link, or speech failed):
                        # still shown, as an instant at the playhead, so
                        # truncation doesn't stop at it.
                        at = max(self.s._playhead, time.monotonic())
                        segment.intervals.append((at, at))
                        self.voiced_raw += written + ' '
                        self.s.emit_transcript(self.resp, _visible(self.voiced_raw))
                    break
                if isinstance(chunk, Exception):
                    if not self.resp.errored:
                        self.resp.errored = True
                        self.s._error(f'Speech failed: {chunk}')
                    continue
                if not announced:
                    announced = True
                    if self.first_audio_at is None:
                        self.first_audio_at = time.perf_counter()
                    self.voiced_raw += written + ' '
                    self.s.emit_transcript(self.resp, _visible(self.voiced_raw))
                self.s.emit_audio(self.resp, chunk[0], chunk[1], segment)

    async def finish(self):
        for sentence in self.chunker.flush():
            self._say(sentence)
        await self.queue.put(None)
        await self.emitter

    async def cancel(self):
        self.emitter.cancel()
        for job in self.jobs:
            job.cancel()
        # Let each engine stop its sentence cleanly (xAI waits for its
        # socket to confirm) before the next reply uses it.
        await asyncio.gather(*self.jobs, return_exceptions=True)
