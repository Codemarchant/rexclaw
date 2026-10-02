# Copyright 2026 Codemarchant
"""Text-to-speech engines."""
import asyncio
import base64
import json
import logging
import struct
from urllib.parse import urlencode

import httpx
import numpy as np

from .engines import API_KEY, OPENAI_CLOUD_KEY, OPENAI_CLOUD_URL, OPENAI_URL, SERVES, Field, TtsEngine, json_field

_logger = logging.getLogger(__name__)

# docs.x.ai → Text to Speech → Sample Rates.
XAI_TTS_RATES = (8000, 16000, 22050, 24000, 44100, 48000)
# Safety limits for the xAI socket (not tunables): no event for this long
# mid-sentence means it went quiet (first audio normally lands in ~0.5 s),
# and an interrupted sentence's text.clear gets this long, in all, to be
# confirmed before the socket is replaced.
SILENT_SOCKET_S = 10
CLEAR_WAIT_S = 3


def _pcm16_to_float(data):
    return np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0


class _WavStream:
    """Incremental WAV reader for a streamed HTTP body: parses the header as
    it arrives, then hands out samples. Streaming servers write a
    placeholder data length (0 or 0xFFFFFFFF), so the length is ignored and
    everything after the data chunk header is audio."""

    def __init__(self):
        self._buf = b''
        self.rate = None
        self.channels = 1
        self._in_data = False
        self._odd = b''

    def feed(self, data):
        if self._in_data:
            return self._samples(data)
        self._buf += data
        if len(self._buf) < 12:
            return None
        if self._buf[:4] != b'RIFF' or self._buf[8:12] != b'WAVE':
            raise RuntimeError('the speech server did not return WAV audio')
        pos = 12
        while pos + 8 <= len(self._buf):
            cid, size = self._buf[pos:pos + 4], struct.unpack('<I', self._buf[pos + 4:pos + 8])[0]
            if cid == b'fmt ':
                if pos + 8 + 16 > len(self._buf):
                    return None
                fmt, channels, rate, _, _, bits = struct.unpack('<HHIIHH', self._buf[pos + 8:pos + 24])
                if fmt not in (1, 0xFFFE) or bits != 16:
                    raise RuntimeError('the speech server sent WAV that is not 16-bit PCM')
                self.channels, self.rate = channels, rate
            elif cid == b'data':
                rest = self._buf[pos + 8:]
                self._in_data, self._buf = True, b''
                return self._samples(rest)
            pos += 8 + size + (size & 1)
        return None

    def _samples(self, data):
        data = self._odd + data
        frame = 2 * self.channels
        usable = len(data) - len(data) % frame
        self._odd = data[usable:]
        if not usable:
            return None
        samples = _pcm16_to_float(data[:usable])
        if self.channels > 1:
            samples = samples.reshape(-1, self.channels).mean(axis=1)
        return samples


class XaiTts(TtsEngine):
    """xAI streaming TTS (docs.x.ai → Text to Speech → Streaming TTS). One
    WebSocket per call leg stays open across replies, so no sentence pays
    for a connection handshake; each sentence is one utterance on it
    (text.delta → text.done → audio.delta… → audio.done).

    Not one utterance per reply: xAI sends a reply's character timings only
    once its audio is complete (observed 2026-09-30 — the docs say per
    chunk), so a whole-reply utterance would leave the transcript, and the
    gestures that follow it, a reply behind the voice. Per sentence, the
    transcript goes out right ahead of the audio that speaks it."""
    id = 'xai'
    label = 'xAI (streaming)'
    description = ('The same Grok voices as realtime calls, speech tags included. '
                   'Uses your xAI key.')
    speech_tags = True
    uses_xai_key = True
    voice_hint = 'Grok voice (leave empty for the companion\'s own)'
    fields = (
        Field('voice', 'Default voice', 'text', '',
              placeholder='the companion\'s Grok voice',
              help='Leave empty to use each companion\'s own Grok voice.'),
        Field('language', 'Language', 'text', 'auto', placeholder='auto'),
        Field('optimize_latency', 'Latency', 'select', '1',
              options=(('0', 'Best quality'), ('1', 'Faster first words'),
                       ('2', 'Fastest first words')),
              help='xAI optimize_streaming_latency: smaller first chunks start sooner, '
                   'with a small quality cost at chunk boundaries.'),
    )

    def __init__(self, settings, config):
        super().__init__(settings, config)
        self._ws = None
        self._key = None          # (voice, speed, rate) the open socket was made for
        self._reader = None
        self._current = None      # event queue of the utterance being spoken
        self._lock = asyncio.Lock()   # one utterance at a time per socket

    @classmethod
    def voice_for(cls, settings, companion_voice, pipeline_voice):
        # The companions' Grok voices are xAI TTS voices too.
        return pipeline_voice or settings.get('voice') or companion_voice

    @staticmethod
    def output_rate(wanted):
        return wanted if wanted in XAI_TTS_RATES else 24000

    async def warm(self, *, voice, speed, rate):
        async with self._lock:
            await self._socket(voice, speed, self.output_rate(rate))

    async def _socket(self, voice, speed, rate):
        import websockets
        key = (voice, speed, rate)
        if self._ws is not None and self._key == key:
            return self._ws
        await self._drop()
        base = (self.config['xai_realtime_url'] or 'wss://api.x.ai/v1/realtime').rsplit('/v1/', 1)[0]
        params = {'language': self.get('language') or 'auto', 'voice': voice, 'codec': 'pcm',
                  'sample_rate': rate, 'optimize_streaming_latency': self.get('optimize_latency') or '1'}
        if speed and speed != 1.0:
            params['speed'] = speed
        self._ws = await websockets.connect(
            f'{base}/v1/tts?{urlencode(params)}', max_size=None,
            additional_headers={'Authorization': f"Bearer {self.config['xai_api_key']}"})
        self._key = key
        self._reader = asyncio.create_task(self._read(self._ws))
        return self._ws

    async def _read(self, ws):
        try:
            async for raw in ws:
                if self._current is not None:
                    self._current.put_nowait(json.loads(raw))
        except Exception as e:
            _logger.info('xAI TTS connection closed: %s', e)
        finally:
            if self._ws is ws:
                self._ws = None
            if self._current is not None:
                self._current.put_nowait({'type': 'error', 'message': 'connection closed'})

    async def _drop(self):
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass
        if self._reader:
            self._reader.cancel()
            self._reader = None

    async def synthesize(self, text, *, voice, speed, rate):
        rate = self.output_rate(rate)
        async with self._lock:
            ws = await self._socket(voice, speed, rate)
            events = asyncio.Queue()
            self._current = events
            finished = False
            try:
                await ws.send(json.dumps({'type': 'text.delta', 'delta': text}))
                await ws.send(json.dumps({'type': 'text.done'}))
                while True:
                    try:
                        ev = await asyncio.wait_for(events.get(), SILENT_SOCKET_S)
                    except asyncio.TimeoutError:
                        # Open but silent: this sentence is lost, and the
                        # next one gets a fresh socket.
                        finished = True
                        await self._drop()
                        raise RuntimeError('the voice stopped responding') from None
                    etype = ev.get('type')
                    if etype == 'audio.delta':
                        data = base64.b64decode(ev.get('delta') or '')
                        if data:   # the timing summary arrives as an empty delta
                            yield _pcm16_to_float(data), rate
                    elif etype == 'audio.done':
                        finished = True
                        return
                    elif etype == 'error':
                        finished = True
                        raise RuntimeError(ev.get('message') or 'speech failed')
            finally:
                if not finished:
                    # Interrupted: text.clear, and wait for audio.clear so no
                    # audio of this sentence reaches the next one (docs: the
                    # connection is ready again once audio.clear arrives).
                    # audio.done also frees it: the sentence had finished
                    # as the clear went out.
                    try:
                        await ws.send(json.dumps({'type': 'text.clear'}))
                        loop = asyncio.get_running_loop()
                        deadline = loop.time() + CLEAR_WAIT_S
                        while (await asyncio.wait_for(events.get(), max(0.0, deadline - loop.time()))).get('type') \
                                not in ('audio.clear', 'audio.done', 'error'):
                            pass
                    except Exception:
                        await self._drop()   # no confirmation: next sentence gets a fresh socket
                self._current = None

    async def close(self):
        self._current = None
        await self._drop()


class OpenAiTts(TtsEngine):
    """Any server with OpenAI's POST /audio/speech, one request per
    sentence: Kokoro-FastAPI, Irodori-TTS-Server, speaches, OpenAI."""
    id = 'openai'
    label = 'OpenAI-compatible'
    description = ('Local voices (Kokoro-FastAPI, Irodori-TTS-Server, speaches) or any API '
                   'that serves /v1/audio/speech.')
    voice_hint = 'Voice name on the server (e.g. af_heart on Kokoro)'
    fields = (
        OPENAI_URL,
        API_KEY,
        SERVES['tts'],
        Field('model', 'Model', 'text', 'kokoro', placeholder='kokoro'),
        Field('voice', 'Default voice', 'text', 'af_heart', placeholder='af_heart',
              help='Used for companions without a voice of their own for this setup. '
                   'af_heart is Kokoro\'s default voice.'),
        Field('response_format', 'Audio format', 'select', 'wav',
              options=(('wav', 'WAV (any sample rate)'), ('pcm', 'Raw PCM')),
              help='WAV describes its own sample rate. Raw PCM starts a little sooner, '
                   'but needs the rate below.'),
        Field('sample_rate', 'PCM sample rate', 'number', 24000,
              help='Only for raw PCM: 24000 for OpenAI and Kokoro.'),
        Field('extra_body', 'Extra request fields (JSON)', 'json', '',
              placeholder='{"stream": true}',
              help='Merged into every request - e.g. {"instructions": "..."} for '
                   'gpt-4o-mini-tts, or an "irodori" options object.'),
    )

    def __init__(self, settings, config):
        super().__init__(settings, config)
        headers = {'Authorization': f"Bearer {self.get('api_key')}"} if self.get('api_key') else {}
        self._http = httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(60, connect=10))

    def _extra(self):
        """Request fields beyond the text, voice and format."""
        return json_field(self, 'extra_body')

    async def synthesize(self, text, *, voice, speed, rate):
        fmt = self.get('response_format') or 'wav'
        payload = {'model': self.get('model') or 'tts-1', 'input': text, 'voice': voice,
                   'response_format': fmt, **self._extra()}
        if speed and speed != 1.0:
            payload['speed'] = speed
        url = self.get('base_url').rstrip('/') + '/audio/speech'
        async with self._http.stream('POST', url, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode('utf-8', 'replace')
                raise RuntimeError(f'speech failed ({resp.status_code}): {body[:300]}')
            async for samples, out_rate in _decode_stream(resp, fmt, int(self.get('sample_rate') or 24000)):
                yield samples, out_rate

    async def close(self):
        await self._http.aclose()


async def _decode_stream(resp, fmt, pcm_rate):
    """(samples, rate) pairs from a streamed WAV or raw-PCM body."""
    if fmt == 'pcm':
        odd = b''
        async for data in resp.aiter_bytes():
            data = odd + data
            usable = len(data) - len(data) % 2
            odd = data[usable:]
            if usable:
                yield _pcm16_to_float(data[:usable]), pcm_rate
        return
    wav = _WavStream()
    async for data in resp.aiter_bytes():
        samples = wav.feed(data)
        if samples is not None and samples.size:
            yield samples, wav.rate


# What a companion on a Fish voice is taught about its cues: the default of
# the companion editor's speech tags field (TtsEngine.tag_guide). The syntax,
# the cue lists and the tips are Fish's (docs.fish.audio → Emotion Control:
# every cue on that page — 24 basic + 25 advanced emotions, tone markers,
# audio effects, special effects — plus [inhale] / [exhale] from Models
# Overview → Natural Language Control; "bracket cues can use natural
# language descriptions and are not limited to a fixed set"; emotions at
# the start of a sentence, one primary emotion per sentence, up to 3
# combined, text after a sound effect). The opening paragraph mirrors the
# Grok section's (session_service._expression_section). Nothing in the
# request switches cues on: the S2 models read brackets as part of the text.
FISH_TAG_GUIDE = """\
Your voice performs cues written in square brackets. A cue is never spoken: it shapes how the words after it sound, or puts a sound at that spot. Reach for them freely - they are most of what separates a voice that sounds like a person from one reading lines aloud. Anything audible - a laugh, a sigh, a whisper - belongs in a cue inside the line (`[chuckling] okay, that's actually wild`), never narrated as an action ("I chuckle"). Which cues are yours, and how thickly you lay them on, is your character's call.

A cue is plain words describing the delivery, so the lists below are a starting point, not a limit: `[soft, tired voice]`, `[slightly annoyed]` and `[very excited]` work too.

- Emotions: `[happy]`, `[sad]`, `[angry]`, `[excited]`, `[calm]`, `[nervous]`, `[confident]`, `[surprised]`, `[satisfied]`, `[delighted]`, `[scared]`, `[worried]`, `[upset]`, `[frustrated]`, `[depressed]`, `[empathetic]`, `[embarrassed]`, `[disgusted]`, `[moved]`, `[proud]`, `[relaxed]`, `[grateful]`, `[curious]`, `[sarcastic]`
- More emotions: `[disdainful]`, `[unhappy]`, `[anxious]`, `[hysterical]`, `[indifferent]`, `[uncertain]`, `[doubtful]`, `[confused]`, `[disappointed]`, `[regretful]`, `[guilty]`, `[ashamed]`, `[jealous]`, `[envious]`, `[hopeful]`, `[optimistic]`, `[pessimistic]`, `[nostalgic]`, `[lonely]`, `[bored]`, `[contemptuous]`, `[sympathetic]`, `[compassionate]`, `[determined]`, `[resigned]`
- Tone: `[whispering]`, `[soft tone]`, `[shouting]`, `[screaming]`, `[in a hurry tone]`, and `[emphasis]` right before the word to stress
- Sounds: `[laughing]`, `[chuckling]`, `[sighing]`, `[gasping]`, `[groaning]`, `[panting]`, `[yawning]`, `[clear throat]`, `[sobbing]`, `[crying loudly]`, `[snoring]`, `[inhale]`, `[exhale]`
- Pauses: `[break]`, `[long-break]`
- Laughter around you, not your own: `[audience laughing]`, `[background laughter]`, `[crowd laughing]`

Tips:
- An emotion goes at the start of the sentence it colours - `[excited] We won!` - and a change of feeling starts the next sentence with a new cue.
- Tone and sound cues go wherever they happen: `Come closer. [whispering] It is a secret.`
- Cues combine - `[sad][whispering] I miss you so much.` - around one main emotion per sentence; up to three combine well.
- A sound lands best with a word of its own after it: `[laughing] Ha ha!`, `[sighing] Ugh.`
- A cue works best as a few words.

When the user asks for a delivery - whisper this, say it softer - the cue is how you do it: `[whispering]` in front of the words, not a description of whispering."""


class FishTts(TtsEngine):
    """Fish Audio's hosted TTS (docs.fish.audio → Text to Speech), one
    request per sentence. A voice is a Fish model id (reference_id) from
    their library or your own clones."""
    id = 'fish'
    label = 'Fish Audio'
    description = 'Fish Audio voices and voice clones (fish.audio API key).'
    voice_hint = 'Fish Audio voice id (reference id)'
    fields = (
        Field('api_key', 'API key', 'secret', '', scope='connection'),
        Field('model', 'Model', 'text', 's2.1-pro', placeholder='s2.1-pro',
              help='s2.1-pro (Fish\'s default), s2-pro, s1, or s2.1-pro-free.'),
        Field('voice', 'Default voice (reference id)', 'text', '',
              help='Used for companions without a voice of their own for this setup. The id from '
                   'the voice\'s page on fish.audio (32 letters and digits); a voice\'s name '
                   'doesn\'t work.'),
        Field('latency', 'Latency', 'select', 'balanced',
              options=(('normal', 'Best quality'), ('balanced', 'Balanced'), ('low', 'Lowest latency'))),
    )

    @classmethod
    def tag_guide(cls, settings):
        # The S2 models take free-form [bracket] cues. S1 has a fixed set
        # in (parentheses) instead, which this guide would get wrong.
        model = (settings.get('model') or 's2.1-pro').strip().lower()
        return '' if model.startswith('s1') else FISH_TAG_GUIDE

    def __init__(self, settings, config):
        super().__init__(settings, config)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), headers={
            'Authorization': f"Bearer {self.get('api_key')}",
            'model': self.get('model') or 's2.1-pro'})

    async def synthesize(self, text, *, voice, speed, rate):
        payload = {'text': text, 'format': 'wav', 'latency': self.get('latency') or 'balanced'}
        if voice:
            payload['reference_id'] = voice
        if speed and speed != 1.0:
            payload['prosody'] = {'speed': speed}
        async with self._http.stream('POST', 'https://api.fish.audio/v1/tts', json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode('utf-8', 'replace')
                raise RuntimeError(f'Fish Audio failed ({resp.status_code}): {body[:300]}')
            async for samples, out_rate in _decode_stream(resp, 'wav', 44100):
                yield samples, out_rate

    async def close(self):
        await self._http.aclose()


# What a companion on an ElevenLabs v3/v4 voice is taught about its cues
# (TtsEngine.tag_guide). Every tag ElevenLabs documents (best practices,
# 2026-10-02): the Prompting Eleven v4 lists (voice-related, sound effects,
# unique and special, plus [whispering] [shouting] [laughing] from its
# audio-tags intro), the tag list of their own "Enhance" prompt (directions
# and non-verbal, incl. [short pause] / [long pause]), and the free-form
# descriptions from their examples. The tips are theirs too: tags are
# natural-language instructions, go "immediately before ... or immediately
# after" a segment, combine, must "describe something auditory" (not
# [standing], [grinning], [pacing], [music]); describe the voice quality so
# a tag isn't read as a sound effect; ellipses pause, CAPITALS stress; match
# tags to the voice; v3/v4 take no SSML.
ELEVENLABS_TAG_GUIDE = """\
Your voice performs cues written in square brackets. A cue is never spoken: it shapes how the words around it sound, or puts a sound at that spot. Reach for them freely - they are most of what separates a voice that sounds like a person from one reading lines aloud. Anything audible - a laugh, a sigh, a whisper - belongs in a cue inside the line (`[laughs] okay, that's actually wild`), never narrated as an action ("I laugh"). Which cues are yours, and how thickly you lay them on, is your character's call.

A cue is plain words describing the delivery, so the lists below are a starting point, not a limit: `[low, gravelly voice]`, `[warm, conversational tone, faint amusement]`, `[quietly, with controlled fear]`, `[softening, reflective]`, `[gentle laugh, then sincere]` and `[frustrated sigh]` work too.

- Feeling and delivery: `[happy]`, `[sad]`, `[excited]`, `[angry]`, `[annoyed]`, `[appalled]`, `[thoughtful]`, `[surprised]`, `[curious]`, `[sarcastic]`, `[mischievously]`, `[crying]`, `[whispers]`, `[whispering]`, `[shouting]`, `[muttering]`
- Sounds you make: `[laughs]`, `[laughing]`, `[laughs harder]`, `[starts laughing]`, `[chuckles]`, `[giggles]`, `[wheezing]`, `[snorts]`, `[sighs]`, `[exhales]`, `[exhales sharply]`, `[inhales deeply]`, `[clears throat]`, `[gulps]`, `[swallows]`
- Pauses: `[short pause]`, `[long pause]`
- Special: `[strong French accent]` (any accent), `[sings]`, `[singing]`, `[woo]`
- Sound effects, less consistent from voice to voice: `[applause]`, `[clapping]`, `[gunshot]`, `[explosion]`, `[fart]`

Tips:
- A cue goes right before the words it colours, or right after the line it reacts to: `[annoyed] This is hard.` or `This is hard. [sighs]`. A change of feeling gets a new cue: `[excited] We won! [whispers] Don't tell anyone yet.`
- Cues combine: `[whispers][mischievously] I have an idea.`
- A cue must be something you can hear: not `[smiles]`, `[standing]`, `[grinning]`, `[pacing]` or `[music]`.
- Describe the voice, not the scene: `[low, gravelly voice]` reads as delivery, while a cue that could be a noise in the room may come out as a sound effect.
- Ellipses add a pause and weight (`It was... a lot.`); CAPITALS stress a word (`a VERY long day`).
- Match the cue to your character: a serious voice may not take playful cues like `[giggles]` well, and a calm one whispers more convincingly than it shouts.

When the user asks for a delivery - whisper this, say it softer - the cue is how you do it: `[whispers]` in front of the words, not a description of whispering."""


class ElevenLabsTts(TtsEngine):
    """ElevenLabs' hosted TTS, one streamed request per sentence:
    POST /v1/text-to-speech/{voice}/stream with output_format=pcm_24000
    (raw 16-bit PCM). ElevenLabs has no OpenAI-style /audio/speech, hence
    an engine of its own. Eleven v4 (released 2026-09-28) is their best
    model and takes free-form [audio tags]; Flash v2.5 is their fastest
    (~75 ms) and takes none. Sources: elevenlabs.io/docs → Models, Text to
    Speech stream API, Best practices (2026-10-02)."""
    id = 'elevenlabs'
    label = 'ElevenLabs'
    description = 'ElevenLabs voices and voice clones (elevenlabs.io API key).'
    voice_hint = 'ElevenLabs voice id'
    needs_voice = True   # no account-wide default voice to fall back on
    fields = (
        Field('api_key', 'API key', 'secret', '', scope='connection',
              help='From elevenlabs.io → Developers → API keys.'),
        Field('model', 'Model', 'text', 'eleven_v4', placeholder='eleven_v4',
              help='eleven_v4 (best quality, audio tags; $0.08 per 1,000 characters), eleven_flash_v2_5 '
                   '(fastest, ~75 ms, no tags, $0.04), eleven_v3, or eleven_multilingual_v2.'),
        Field('voice', 'Default voice (voice id)', 'text', '',
              help='Used for companions without a voice of their own for this setup: the voice id '
                   'from your ElevenLabs Voices page (a voice\'s name doesn\'t work). ElevenLabs\' old '
                   'premade voices are being retired, so pick one of yours or from their library.'),
        Field('stability', 'Stability', 'number', 0.5,
              help='0-1. Lower is more expressive and varied, higher more even. ElevenLabs default: 0.5.'),
        Field('similarity_boost', 'Similarity', 'number', 0.75,
              help='0-1. How closely it holds to the original voice. ElevenLabs default: 0.75.'),
    )

    @staticmethod
    def _expressive(settings):
        """Eleven v3 and v4 take audio tags, and no speed or SSML."""
        model = (settings.get('model') or 'eleven_v4').strip().lower()
        return model.startswith(('eleven_v3', 'eleven_v4'))

    @classmethod
    def tag_guide(cls, settings):
        return ELEVENLABS_TAG_GUIDE if cls._expressive(settings) else ''

    def __init__(self, settings, config):
        super().__init__(settings, config)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10),
                                       headers={'xi-api-key': self.get('api_key') or ''})

    async def synthesize(self, text, *, voice, speed, rate):
        if not voice:
            raise RuntimeError('ElevenLabs needs a voice id: set the default voice in the setup, '
                               'or the companion\'s own on the Companions tab.')
        voice_settings = {'stability': float(self.get('stability') or 0.5),
                          'similarity_boost': float(self.get('similarity_boost') or 0.75)}
        if speed and speed != 1.0 and not self._expressive(self.settings):
            voice_settings['speed'] = max(0.7, min(1.2, speed))   # v2 / Flash range
        payload = {'text': text, 'model_id': self.get('model') or 'eleven_v4', 'voice_settings': voice_settings}
        url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream?output_format=pcm_24000'
        async with self._http.stream('POST', url, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode('utf-8', 'replace')
                raise RuntimeError(f'ElevenLabs failed ({resp.status_code}): {body[:300]}')
            async for samples, out_rate in _decode_stream(resp, 'pcm', 24000):
                yield samples, out_rate

    async def close(self):
        await self._http.aclose()


class OpenAiCloudTts(OpenAiTts):
    """OpenAI's own voices. gpt-4o-mini-tts is OpenAI's newest speech model
    (text-to-speech guide, 2026-10-02): 13 voices, marin and cedar
    recommended for quality, and a free-text `instructions` prompt for
    delivery (accent, tone, pace, whispering) - it has no inline tags."""
    id = 'openai_cloud'
    label = 'OpenAI'
    description = 'OpenAI\'s voices (gpt-4o-mini-tts). Uses your OpenAI API key.'
    voice_hint = 'OpenAI voice (marin, cedar, coral, alloy...)'
    fields = (
        OPENAI_CLOUD_URL,
        OPENAI_CLOUD_KEY,
        Field('model', 'Model', 'text', 'gpt-4o-mini-tts', placeholder='gpt-4o-mini-tts',
              help='gpt-4o-mini-tts (newest), or tts-1 / tts-1-hd (fewer voices, no delivery prompt).'),
        Field('voice', 'Default voice', 'text', 'marin', placeholder='marin',
              help='Used for companions without a voice of their own for this setup. OpenAI recommends '
                   'marin or cedar; the others are alloy, ash, ballad, coral, echo, fable, nova, onyx, '
                   'sage, shimmer and verse. Hear them at openai.fm.'),
        Field('instructions', 'Delivery', 'text', '',
              placeholder='Warm and playful, a little breathy.',
              help='How the voice speaks - accent, emotional range, tone, pace, whispering - for '
                   'gpt-4o-mini-tts. Empty = the voice as it is.'),
        Field('response_format', 'Audio format', 'select', 'pcm',
              options=(('pcm', 'Raw PCM (starts soonest)'), ('wav', 'WAV')),
              help='OpenAI\'s raw PCM is 24 kHz 16-bit mono, and starts playing a little sooner.'),
        Field('sample_rate', 'PCM sample rate', 'number', 24000,
              help='24000 for OpenAI.'),
    )

    def _extra(self):
        return {'instructions': self.get('instructions')} if self.get('instructions') else {}


ENGINES = [XaiTts, OpenAiTts, OpenAiCloudTts, FishTts, ElevenLabsTts]
