# Copyright 2026 Codemarchant
"""Speech-to-speech engines: a voice setup that hands the whole call to one
provider model instead of speech-to-text → brain → voice.

The browser talks to the provider directly, as it does to Grok Realtime
(web/src/models/agent_connection.js): the server mints a short-lived key
and builds the session config, and the call runs on the provider's
socket. xAI's Voice Agent API was modelled on OpenAI's Realtime API, so
the client's event handling serves both; what differs is the session
config's shape, the tools the provider runs, the audio rate and the
replayed history (OpenAI rejects fields it doesn't know). The app builds
everything in xAI's shapes (xai_client.build_session_update,
session_service._build_replay_items) and an engine here translates.

OpenAI's GPT-Live (gpt-live-1) is not this protocol - its own endpoint
and events, with the reasoning handed to a separate backend model - so it
isn't offered here.

Sources (developers.openai.com, 2026-10-02): api/docs/guides/realtime.md,
realtime-conversations.md, voice-websockets.md, realtime-mcp.md,
api/reference/resources/realtime (client/server events, client_secrets),
api/docs/models/gpt-realtime-2.1.md.
"""
import hashlib
import logging

import httpx

from ..errors import UserError
from .engines import OPENAI_CLOUD_KEY, OPENAI_CLOUD_URL, Engine, Field

_logger = logging.getLogger(__name__)

# OpenAI's realtime audio/pcm takes 24 kHz only (session audio format enum).
OPENAI_RATE = 24000
# OpenAI Realtime rejects a call_id over 32 characters ("string_above_max_length",
# probe 2026-10-02); xAI's run to 43-53, so replayed ones get a stand-in.
OPENAI_CALL_ID_MAX = 32


def _call_id(call_id):
    """A replayed call id within OpenAI's limit: as it is when it fits, else
    a stable short stand-in (the same for a call and its result)."""
    if len(call_id) <= OPENAI_CALL_ID_MAX:
        return call_id
    return 'r_' + hashlib.sha1(call_id.encode()).hexdigest()[:OPENAI_CALL_ID_MAX - 2]


class RealtimeEngine(Engine):
    """A provider's speech-to-speech API. `protocol` tells the browser which
    dialect it speaks (agent_connection.js); `rate` is the audio rate the
    call must run at, None for any."""
    protocol = ''
    rate = None
    voice_hint = 'Voice name'

    @classmethod
    def voice_for(cls, settings, companion_voice, pipeline_voice):
        """As TtsEngine.voice_for: the companion's own voice on this
        connection, else the setup's default."""
        return pipeline_voice or settings.get('voice') or ''

    @classmethod
    def mint(cls, settings):
        """{'token', 'url', 'model'} for the browser's socket."""
        raise NotImplementedError

    @classmethod
    def session_update(cls, update, settings, *, voice, keyterms, manual_turn):
        """The xAI-shaped session.update (xai_client.build_session_update)
        in this provider's shape."""
        raise NotImplementedError

    @classmethod
    def wire_items(cls, items, tool_names=()):
        """Replay items (session_service._build_replay_items) as this
        provider takes them; `tool_names`: the functions the session
        declares."""
        return items


class OpenAiRealtime(RealtimeEngine):
    id = 'openai_cloud'
    label = 'OpenAI Realtime'
    description = ('OpenAI\'s speech-to-speech models: one model hears you and answers in its own voice, '
                   'billed per token. Web search and code run through delegate_task on this setup\'s brain.')
    protocol = 'openai'
    rate = OPENAI_RATE
    voice_hint = 'OpenAI voice (marin, cedar, coral, alloy...)'
    fields = (
        OPENAI_CLOUD_URL, OPENAI_CLOUD_KEY,
        # gpt-realtime-2.1: "improved alphanumeric recognition, silence and
        # noise handling, and interruption behavior" over 2 ($32/$64 per M
        # audio tokens in/out); -mini is the distilled one ($10/$20).
        Field('model', 'Model', 'text', 'gpt-realtime-2.1', placeholder='gpt-realtime-2.1',
              help='gpt-realtime-2.1 (best), gpt-realtime-2.1-mini (about a third of the price), or an '
                   'older gpt-realtime-1.5 / gpt-realtime.'),
        Field('voice', 'Default voice', 'text', 'marin', placeholder='marin',
              help='marin and cedar are OpenAI\'s best voices; also alloy, ash, ballad, coral, echo, sage, '
                   'shimmer, verse. Each companion can pick its own on the Companions tab.'),
        # OpenAI's prompting guide: "Start with `low`". Sent to the
        # reasoning models only (gpt-realtime-2*).
        Field('reasoning_effort', 'Reasoning', 'select', 'low',
              options=(('', "Model's default"), ('minimal', 'Minimal'), ('low', 'Low'),
                       ('medium', 'Medium'), ('high', 'High'), ('xhigh', 'Extra high')),
              help='Thinking before answering, on gpt-realtime-2 and later. Low suits conversation; '
                   'more makes replies slower.'),
        Field('transcribe_model', 'Transcription model', 'text', 'gpt-transcribe', placeholder='gpt-transcribe',
              help='Writes down what you say for the transcript and memories (billed separately, '
                   '$0.0045/min). gpt-live-transcribe is the streaming one; the companion\'s key terms '
                   'are passed to either.'),
        # Silence by default, as Grok Realtime's server VAD: semantic VAD on
        # eagerness auto waited 4-5 s of silence before every reply in a probe
        # (2026-10-02, gpt-realtime-2.1), long enough that a caller speaks
        # again thinking it didn't hear. OpenAI documents eagerness as a
        # ceiling: high 2 s, medium (= auto) 4 s, low 8 s.
        Field('turn_detection', 'Turn detection', 'select', 'server_vad',
              options=(('server_vad', 'Silence - answers after a short pause'),
                       ('semantic_vad', 'Semantic - waits until you sound finished')),
              help='Silence answers as soon as you pause, like Grok. Semantic turn detection reads whether you '
                   'have finished your thought, so a pause mid-sentence doesn\'t cut you off, but it waits '
                   'longer before each reply (see Semantic eagerness).'),
        # OpenAI's server VAD defaults to threshold 0.5, xAI's to 0.85 (docs.x.ai
        # speech-to-speech). At 0.5 a live call heard noise and echo as speech
        # (several speech_started per utterance, a reply to "nothing clear"),
        # and each one cancels the reply in progress - Grok's 0.85 is the
        # setting calls were already tuned on.
        Field('vad_threshold', 'Voice detection threshold', 'number', 0.85,
              help='How loud speech must be to count as you talking (0-1), with Silence turn detection. '
                   'Higher ignores more background noise and the companion\'s own echo; lower catches '
                   'quieter speech. Grok uses 0.85, OpenAI\'s own default is 0.5.'),
        Field('eagerness', 'Semantic eagerness', 'select', 'high',
              options=(('high', 'High - waits up to 2 s'), ('medium', 'Medium - up to 4 s'),
                       ('low', 'Low - up to 8 s, lets you take your time'), ('auto', 'Auto (= medium)')),
              help='With semantic turn detection: the longest it waits after you stop before answering.'),
        Field('noise_reduction', 'Noise reduction', 'select', '',
              options=(('', 'Off (the browser already filters)'), ('near_field', 'Headset / close mic'),
                       ('far_field', 'Laptop / room mic'))),
        # OpenAI resends the whole conversation with every reply (usage
        # input_tokens), so a reply's size is the conversation's, as on a
        # setup brain (setups.context_full). The companion's prompt and tools
        # alone measured ~13.9k tokens a reply (probe, 2026-10-02); 32k - the
        # whole window of gpt-realtime-1.5 - leaves ~16k (about ten minutes
        # of talk at 10 / 20 tokens a second) before a summary. A design pick.
        Field('compact_at', 'Summarise at (tokens per reply)', 'number', 32000,
              help='When one reply\'s request reaches this size, the older part of the call is summarised '
                   'and the call reconnects with the summary. Every reply resends the whole conversation, '
                   'so this caps what each reply costs; the 2.x models take up to 128k.'),
    )

    @staticmethod
    def _base(settings):
        return (settings.get('base_url') or 'https://api.openai.com/v1').rstrip('/')

    @classmethod
    def mint(cls, settings):
        """POST /realtime/client_secrets: an ephemeral key (ek_…) the browser
        opens the socket with. Valid 10-7200 s; a session started inside it
        may run on past expiry (to Realtime's 60-minute session cap)."""
        key = settings.get('api_key') or ''
        if not key:
            raise UserError('The OpenAI connection has no API key (Settings → Models & providers).')
        model = settings.get('model') or 'gpt-realtime-2.1'
        try:
            resp = httpx.post(f'{cls._base(settings)}/realtime/client_secrets', timeout=20,
                              headers={'Authorization': f'Bearer {key}'},
                              json={'expires_after': {'anchor': 'created_at', 'seconds': 600},
                                    'session': {'type': 'realtime', 'model': model}})
        except httpx.HTTPError as e:
            raise UserError(f'Could not reach OpenAI: {e}') from e
        if resp.status_code >= 400:
            _logger.error('OpenAI realtime key mint failed: %s %s', resp.status_code, resp.text[:500])
            raise UserError(f'OpenAI Realtime refused the call ({resp.status_code}): {resp.text[:300]}')
        token = (resp.json() or {}).get('value')
        if not token:
            raise UserError('OpenAI returned no realtime key.')
        base = cls._base(settings)
        url = 'ws' + base[len('http'):] if base.startswith('http') else base   # https → wss
        return {'token': token, 'url': f'{url}/realtime', 'model': model}

    @classmethod
    def session_update(cls, update, settings, *, voice, keyterms, manual_turn):
        session = update['session']
        tools = []
        for t in session.get('tools') or []:
            kind = t.get('type')
            if kind == 'function':
                tools.append({'type': 'function', 'name': t['name'], 'description': t.get('description') or '',
                              'parameters': t.get('parameters') or {'type': 'object', 'properties': {}}})
            elif kind == 'mcp':
                # As on the Responses API (llm._openai_responses_tools): no
                # approval stop, the app's 'Bearer …' key as a header.
                entry = {k: v for k, v in t.items() if k != 'authorization'}
                entry['require_approval'] = 'never'
                if t.get('authorization'):
                    entry['headers'] = {'Authorization': t['authorization'], **(t.get('headers') or {})}
                tools.append(entry)
            # web_search / x_search / code_interpreter: Realtime runs function
            # and MCP tools only; delegate_task covers search and code.
        model = settings.get('model') or ''
        transcribe = settings.get('transcribe_model') or 'gpt-transcribe'
        transcription = {'model': transcribe}
        terms = [t for t in keyterms or () if not set(t) & set('<>\r\n')]
        if terms:
            # keywords[] on the gpt-transcribe family; older models read a prompt.
            if transcribe.startswith(('gpt-transcribe', 'gpt-live-transcribe')):
                transcription['keywords'] = terms
            else:
                transcription['prompt'] = ', '.join(terms)
        if manual_turn:
            turn = None   # group-call peers speak on response.create only
        elif settings.get('turn_detection') == 'server_vad':
            turn = {'type': 'server_vad', 'threshold': max(0.0, min(1.0, float(settings.get('vad_threshold') or 0.85)))}
        else:
            turn = {'type': 'semantic_vad', 'eagerness': settings.get('eagerness') or 'auto'}
        audio_in = {'format': {'type': 'audio/pcm', 'rate': OPENAI_RATE},
                    'transcription': transcription, 'turn_detection': turn}
        if settings.get('noise_reduction'):
            audio_in['noise_reduction'] = {'type': settings['noise_reduction']}
        audio_out = {'format': {'type': 'audio/pcm', 'rate': OPENAI_RATE}, 'voice': voice or 'marin'}
        speed = (session.get('audio') or {}).get('output', {}).get('speed')
        if speed:
            audio_out['speed'] = max(0.25, min(1.5, float(speed)))
        out = {'type': 'realtime', 'instructions': session.get('instructions') or '',
               'output_modalities': ['audio'], 'audio': {'input': audio_in, 'output': audio_out},
               'tools': tools}
        if settings.get('reasoning_effort') and model.startswith('gpt-realtime-2'):
            out['reasoning'] = {'effort': settings['reasoning_effort']}
        return {'type': 'session.update', 'session': out}

    @classmethod
    def wire_items(cls, items, tool_names=()):
        """Only the fields OpenAI's item schema has (the app's `speaker`,
        `fold` and `name` would be rejected), with GA content types:
        output_text for the companion's lines, input_text for the rest.
        `_summary_rollup` stays: the browser strips it before sending.

        A call to a tool this session doesn't declare (web_search run in
        text chat, a tool since switched off) is replayed as a short system
        note in place of the call/result pair, as the Claude brain does
        (llm._claude_messages) - the call stays on record without a function
        the model can't call."""
        out, undeclared = [], {}
        for it in items:
            kind = it.get('type')
            if kind == 'message':
                part = 'output_text' if it.get('role') == 'assistant' else 'input_text'
                item = {'type': 'message', 'role': it.get('role'),
                        'content': [{'type': part, 'text': c.get('text') or ''} for c in it.get('content') or []]}
            elif kind == 'function_call' and it.get('name') not in tool_names:
                undeclared[it['call_id']] = it
                continue
            elif kind == 'function_call_output' and it['call_id'] in undeclared:
                call = undeclared.pop(it['call_id'])
                note = (f'[Earlier you used {call.get("name") or "a tool"} with {call.get("arguments") or "{}"}; '
                        f'result: {(it.get("output") or "")[:1500]}]')
                item = {'type': 'message', 'role': 'system', 'content': [{'type': 'input_text', 'text': note}]}
            elif kind == 'function_call':
                item = {'type': 'function_call', 'call_id': _call_id(it['call_id']), 'name': it.get('name') or '',
                        'arguments': it.get('arguments') or '{}'}
            elif kind == 'function_call_output':
                item = {'type': 'function_call_output', 'call_id': _call_id(it['call_id']),
                        'output': it.get('output') or ''}
            else:
                continue
            if it.get('_summary_rollup'):
                item['_summary_rollup'] = it['_summary_rollup']
            out.append(item)
        return out


ENGINES = [OpenAiRealtime]
