# Copyright 2026 Codemarchant
"""Speech-to-text engines."""
import asyncio
import json
import logging
import re
from urllib.parse import urlencode

import httpx
import numpy as np

from .. import xai_oauth
from .audio import VAD_RATE, float_to_wav_bytes
from .engines import API_KEY, OPENAI_CLOUD_KEY, OPENAI_CLOUD_URL, OPENAI_URL, SERVES, Field, SttEngine, SttStream
from .text import CJK_CHARS

_logger = logging.getLogger(__name__)


def _pcm16_bytes(samples):
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype('<i2').tobytes()


_CJK_EDGE = re.compile(f'[{CJK_CHARS}]')


def _join(parts):
    """Transcript pieces as one line: with spaces, except between two CJK
    characters (AIRI's joinTranscriptFragments, pipelines-audio
    transcript-buffer.ts)."""
    out = ''
    for part in parts:
        if out and not (_CJK_EDGE.match(out[-1]) and _CJK_EDGE.match(part[0])):
            out += ' '
        out += part
    return out


class XaiStt(SttEngine):
    """xAI streaming speech-to-text (docs.x.ai → Speech to Text → Streaming).
    One WebSocket for the whole call; xAI's own Smart Turn decides where a
    turn ends, and interim results give live words while the user talks.
    Billed per hour of audio streamed ($0.20/hr, docs.x.ai/developers/models)."""
    id = 'xai'
    label = 'xAI (streaming)'
    kind_label = 'xAI'
    description = ('Grok speech recognition over a live connection, with interim words '
                   'and built-in end-of-turn detection. Uses your xAI key.')
    streaming = True
    uses_xai_key = True
    fields = (
        Field('model', 'Model', 'text', 'grok-voice-transcribe-2.0',
              placeholder='grok-voice-transcribe-2.0'),
        Field('language', 'Language', 'text', '',
              placeholder='auto',
              help='Optional code (en, ja, ...) - turns on number and currency formatting '
                   'for that language. Speech in any supported language is transcribed either way.'),
        Field('smart_turn', 'End-of-turn confidence', 'number', 0.5,
              help='xAI Smart Turn threshold (0-1): 0.5 balanced, 0.7 conservative, '
                   '0.9 very conservative (xAI docs). 0 turns it off and ends turns on '
                   'silence alone.'),
        Field('smart_turn_timeout', 'Longest pause inside a turn (ms)', 'number', 3000,
              help='The turn ends after this much silence even if Smart Turn thinks you '
                   'are not done (1-5000). Pipecat uses 3000 ms.'),
        Field('endpointing', 'Silence before a turn can end (ms)', 'number', 400,
              help='xAI default: 400 ms.'),
    )

    @property
    def model_name(self):
        return self.get('model') or 'grok-voice-transcribe-2.0'

    async def open_stream(self, *, keyterms=()):
        base = (self.config['xai_realtime_url'] or 'wss://api.x.ai/v1/realtime').rsplit('/v1/', 1)[0]
        params = [('model', self.model_name), ('sample_rate', VAD_RATE), ('encoding', 'pcm'),
                  ('interim_results', 'true'), ('endpointing', int(self.get('endpointing') or 400))]
        if self.get('language'):
            params.append(('language', self.get('language')))
        threshold = float(self.get('smart_turn') or 0)
        if threshold > 0:
            params += [('smart_turn', threshold),
                       ('smart_turn_timeout', max(1, min(5000, int(self.get('smart_turn_timeout') or 3000))))]
        params += [('keyterm', t) for t in keyterms]
        stream = _XaiSttStream(f'{base}/v1/stt?{urlencode(params)}', self.config)
        await stream.connect()
        return stream


class _XaiSttStream(SttStream):
    # docs.x.ai: "Send 100 ms audio chunks (3,200 bytes at 16 kHz PCM16)".
    SEND_SAMPLES = VAD_RATE // 10
    # A dropped connection is reopened in the background, so the call's
    # other events keep flowing: this many tries, then the call ends
    # (Pipecat's WebsocketService: 3 tries with backoff).
    RECONNECT_TRIES = 3

    def __init__(self, url, config):
        self.url, self.config = url, config
        self.ws = None
        self._queue = asyncio.Queue()
        self._reader = None
        self._reconnecting = None
        self._buf = np.zeros(0, np.float32)
        self._locked = []          # chunk finals of the utterance in progress
        self._closed = False

    async def connect(self):
        import websockets
        # Read on every (re)connect: a Grok subscription token renews mid-call.
        bearer = xai_oauth.current_key(self.config)
        try:
            ws = await websockets.connect(self.url, additional_headers={
                'Authorization': f'Bearer {bearer}'}, max_size=None)
        except websockets.InvalidStatus as e:
            refused = xai_oauth.note_refusal(bearer, e.response.status_code,
                                             e.response.body.decode('utf-8', 'replace'))
            if refused:
                raise RuntimeError(refused) from e
            raise
        try:
            first = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if first.get('type') != 'transcript.created':
                raise RuntimeError(f"xAI STT did not start: {first.get('message') or first}")
        except BaseException:
            await ws.close()
            raise
        # Words of the utterance the old connection was hearing are gone.
        self._locked = []
        self.ws = ws
        self._reader = asyncio.create_task(self._read(ws))

    async def _reconnect(self):
        error = None
        for attempt in range(self.RECONNECT_TRIES):
            if attempt:
                await asyncio.sleep(2 ** attempt)
            if self._closed:
                return
            try:
                await self.connect()
                return
            except Exception as e:
                error = e
                _logger.warning('xAI STT reconnect failed (%d/%d): %s', attempt + 1, self.RECONNECT_TRIES, e)
        # events() raises it, which ends the call (PipelineSession._deaf).
        self._closed = True
        await self._queue.put(RuntimeError(f'the connection could not be reopened: {error}'))

    async def _read(self, ws):
        try:
            async for raw in ws:
                ev = json.loads(raw)
                etype = ev.get('type')
                if etype == 'transcript.partial':
                    text = (ev.get('text') or '').strip()
                    if ev.get('speech_final'):
                        self._locked = []
                        if text:
                            await self._queue.put(('final', text))
                    elif ev.get('is_final'):
                        if text:
                            self._locked.append(text)
                            await self._queue.put(('partial', _join(self._locked)))
                    elif text:
                        await self._queue.put(('partial', _join(self._locked + [text])))
                elif etype == 'error':
                    _logger.warning('xAI STT error: %s', ev.get('message') or ev)
        except Exception as e:   # connection dropped — reconnect on the next push
            if not self._closed:
                _logger.warning('xAI STT connection lost: %s', e)
        finally:
            if self.ws is ws:
                self.ws = None

    async def push(self, audio16k):
        self._buf = np.concatenate([self._buf, audio16k]) if self._buf.size else audio16k
        if self._buf.size < self.SEND_SAMPLES:
            return
        data, self._buf = _pcm16_bytes(self._buf), np.zeros(0, np.float32)
        if self.ws is None:
            # Audio while the connection is reopened is lost.
            if not self._closed and (self._reconnecting is None or self._reconnecting.done()):
                self._reconnecting = asyncio.create_task(self._reconnect())
            return
        try:
            await self.ws.send(data)
        except Exception:
            self.ws = None

    async def finalize(self):
        if self.ws is not None:
            await self.ws.send(json.dumps({'type': 'finalize'}))

    async def events(self):
        while True:
            item = await self._queue.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise item
            yield item

    async def close(self):
        self._closed = True
        if self._reconnecting:
            self._reconnecting.cancel()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
        if self._reader:
            self._reader.cancel()
        await self._queue.put(None)


class OpenAiStt(SttEngine):
    """Any server with OpenAI's POST /audio/transcriptions: speaches or
    faster-whisper-server on this machine, Groq, OpenAI itself. One request
    per utterance; the pipeline's own voice detection and Smart Turn decide
    where utterances end."""
    id = 'openai'
    label = 'OpenAI-compatible'
    kind_label = 'OpenAI-compatible server'
    description = ('Local Whisper servers (speaches, faster-whisper-server), Groq or OpenAI: '
                   'anything that serves /v1/audio/transcriptions.')
    fields = (
        OPENAI_URL,
        API_KEY,
        SERVES['stt'],
        Field('model', 'Model', 'text', '',
              placeholder='Systran/faster-whisper-large-v3',
              help='As the server names it, e.g. whisper-large-v3-turbo on Groq, '
                   'gpt-4o-mini-transcribe on OpenAI.'),
        Field('language', 'Language', 'text', '', placeholder='auto',
              help='Optional ISO code (en, ja, ...). Leave empty to detect it.'),
        Field('partial_ms', 'Live words while you talk (ms, 0 = off)', 'number', 0,
              help='Re-transcribes what you have said so far at this interval, for the '
                   'features that follow your words as you speak. Fine on a local server; '
                   'on a paid one every pass is another billed request.'),
    )

    def __init__(self, settings, config):
        super().__init__(settings, config)
        headers = {'Authorization': f"Bearer {self.get('api_key')}"} if self.get('api_key') else {}
        self._http = httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(60, connect=10))
        self._plain = False   # the server or model refused verbose_json

    @property
    def model_name(self):
        return self.get('model') or 'whisper-1'

    def _hints(self, keyterms):
        """The language and vocabulary hints of a request."""
        hints = {}
        if self.get('language'):
            hints['language'] = self.get('language')
        if keyterms:
            # Whisper's prompt conditions its vocabulary: listing the names
            # is the documented way to get them spelled right.
            hints['prompt'] = ', '.join(keyterms)
        return hints

    async def transcribe(self, audio16k, *, keyterms=()):
        if audio16k.size < VAD_RATE // 10:
            return ''
        # verbose_json carries each segment's no-speech and confidence
        # scores, which tell Whisper's hallucinations on noise ("Thank you.",
        # "ご視聴ありがとうございました") from words.
        data = {'model': self.model_name, 'response_format': 'json' if self._plain else 'verbose_json',
                **self._hints(keyterms)}
        url = self.get('base_url').rstrip('/') + '/audio/transcriptions'
        resp = await self._http.post(url, data=data, files={
            'file': ('speech.wav', float_to_wav_bytes(audio16k, VAD_RATE), 'audio/wav')})
        if resp.status_code == 400 and not self._plain and (
                'verbose_json' in resp.text or 'response_format' in resp.text):
            # gpt-4o-transcribe and some servers only answer in plain json.
            self._plain = True
            return await self.transcribe(audio16k, keyterms=keyterms)
        if resp.status_code >= 400:
            raise RuntimeError(f'transcription failed ({resp.status_code}): {resp.text[:300]}')
        body = resp.json()
        segments = body.get('segments') or []
        # openai-whisper's transcribe() defaults: a segment is silence when
        # no_speech_prob > 0.6 and avg_logprob < -1.0.
        kept = [s for s in segments
                if not ((s.get('no_speech_prob') or 0) > 0.6 and (s.get('avg_logprob') or 0) < -1.0)]
        if len(kept) < len(segments):
            _logger.info('transcription: dropped %d segment(s) heard as silence',
                         len(segments) - len(kept))
            return ''.join(s.get('text') or '' for s in kept).strip()
        return (body.get('text') or '').strip()

    async def close(self):
        await self._http.aclose()


class OpenAiCloudStt(OpenAiStt):
    """OpenAI's own transcription. gpt-transcribe is OpenAI's recommended
    model (speech-to-text guide, 2026-10-02): it takes the key terms as
    `keywords[]` and the language as `languages[]` (its replacement for
    `language` - sending both is refused), and answers in plain json."""
    id = 'openai_cloud'
    label = 'OpenAI'
    kind_label = 'OpenAI'
    description = 'OpenAI\'s speech to text (gpt-transcribe, $0.0045 a minute). Uses your OpenAI API key.'
    fields = (
        OPENAI_CLOUD_URL,
        OPENAI_CLOUD_KEY,
        Field('model', 'Model', 'text', 'gpt-transcribe', placeholder='gpt-transcribe',
              help='gpt-transcribe (OpenAI\'s recommended model), or whisper-1.'),
        Field('language', 'Language', 'text', '', placeholder='auto',
              help='Optional ISO code (en, ja, ...). Leave empty to detect it.'),
        Field('partial_ms', 'Live words while you talk (ms, 0 = off)', 'number', 0,
              help='Re-transcribes what you have said so far at this interval, for the '
                   'features that follow your words as you speak. Every pass is another '
                   'billed request.'),
    )

    def __init__(self, settings, config):
        super().__init__(settings, config)
        # Only whisper-1 answers verbose_json (the no-speech scores).
        self._plain = not self.model_name.startswith('whisper')

    def _hints(self, keyterms):
        if self.model_name.startswith('whisper'):
            return super()._hints(keyterms)
        hints = {}
        if self.get('language'):
            hints['languages[]'] = [self.get('language')]
        if keyterms:
            # One per line, none with < > or line breaks: the API refuses
            # the whole request otherwise.
            hints['keywords[]'] = [re.sub(r'[<>\r\n]', ' ', t).strip() for t in keyterms if t.strip()]
        return hints


ENGINES = [XaiStt, OpenAiStt, OpenAiCloudStt]
