# Copyright 2026 Codemarchant
"""Engine contracts and the engine registry.

Three stages, each with interchangeable engines:

    stt  speech → text     SttEngine   (batch per utterance, or streaming)
    llm  the brain         LlmEngine   (streamed text + tool calls)
    tts  text → speech     TtsEngine   (sentence by sentence, streamed audio)

An engine is a class with an `id`, a `label` and `fields` — the settings it
needs, described once so the Settings page can draw them without knowing
the engine. Built-in engines live in stt.py / llm.py / tts.py; an extension
adds its own with api.add_voice_engine(stage, EngineClass) (plugins.py),
and it appears in the Settings pickers like a built-in one.

An engine's `id` is also a connection KIND: one kind can serve several
stages (an OpenAI-compatible server may transcribe, think and speak). Each
field has a scope:

    'connection'  where the engine lives — a server URL, an API key. Saved
                  once per connection (Settings → Connections) and shared
                  by every voice setup using it.
    'setup'       how a setup uses it — a model, a voice, a latency choice.
                  Saved per stage of each voice setup.

Saved connections and setups live in setups.py.
"""
import json
from dataclasses import asdict, dataclass

STAGES = ('stt', 'llm', 'tts')
# A speech-to-speech model in place of stt + llm + tts (realtime.py): not a
# pipeline stage, but registered and offered per connection kind the same way.
REALTIME = 'realtime'
ALL_STAGES = STAGES + (REALTIME,)


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    kind: str = 'text'        # text | url | secret | number | select | bool | json
    default: object = ''
    options: tuple = ()       # select: ((value, label), ...)
    help: str = ''
    placeholder: str = ''
    scope: str = 'setup'      # setup | connection


# Connection fields shared by every OpenAI-compatible engine, so one
# connection (a speaches or OpenAI server) can serve several stages.
OPENAI_URL = Field(
    'base_url', 'Server URL', 'url', '', placeholder='http://127.0.0.1:11434/v1', scope='connection',
    help='The URL that ends in /v1 - Ollama http://127.0.0.1:11434/v1, LM Studio '
         'http://127.0.0.1:1234/v1, speaches http://127.0.0.1:8000/v1, Kokoro-FastAPI '
         'http://127.0.0.1:8880/v1, OpenAI https://api.openai.com/v1.')
API_KEY = Field('api_key', 'API key', 'secret', '', scope='connection',
                help='Leave empty for a local server.')
# OpenAI's own API as a connection kind of its own ('openai_cloud'), with
# OpenAI's models as defaults; the generic kind above covers every other
# server that speaks the same routes.
OPENAI_CLOUD_URL = Field('base_url', 'Server URL', 'url', 'https://api.openai.com/v1', scope='connection',
                         placeholder='https://api.openai.com/v1',
                         help='OpenAI\'s API. Change it only for a proxy in front of it.')
OPENAI_CLOUD_KEY = Field('api_key', 'API key', 'secret', '', scope='connection',
                         help='An OpenAI API key, from platform.openai.com → API keys.')
# What an OpenAI-compatible server offers. The kind covers servers that do
# one thing (Kokoro-FastAPI: a voice; Ollama: chat models) and services
# that do all three, and a setup only lists a connection under the stages
# it offers. The "Add connection" shortcuts set these; a server added by
# hand starts with all three. Each engine lists its own stage's field.
SERVES = {
    'stt': Field('serves_stt', 'Offers speech to text', 'bool', True, scope='connection',
                 help='The server answers /v1/audio/transcriptions. Unticked, setups don\'t '
                      'list it under Speech to text.'),
    'llm': Field('serves_llm', 'Offers a brain', 'bool', True, scope='connection',
                 help='The server answers /v1/chat/completions. Unticked, setups don\'t '
                      'list it under Brain.'),
    'tts': Field('serves_tts', 'Offers a voice', 'bool', True, scope='connection',
                 help='The server answers /v1/audio/speech. Unticked, setups don\'t list '
                      'it under Voice.'),
}


def conversation_fields(compact_at, max_words, consolidate_words):
    """How long a brain's conversations get before they are summarised,
    and how long the summary may grow — per setup, since a local model's
    context (and how fast it answers as the prompt grows) differs from
    Grok's. A brain engine lists these with its own defaults; Settings →
    Conversation length holds the same knobs for Grok Realtime and Grok
    text chat."""
    return (
        Field('compact_at', 'Summarise at (tokens)', 'number', compact_at,
              help='Once a request to this brain reaches this size - the companion\'s prompt '
                   '(about 18,000 tokens) plus the conversation - the older part is summarised. '
                   'Lower keeps replies quick; a local model needs it under its loaded context '
                   'length, with room for the reply. 0 = never.'),
        Field('summary_max_words', 'Summary word limit (low)', 'number', max_words,
              help='When a summary passes the high limit, it is rewritten down to about this '
                   'many words. 0 = off (summaries keep growing).'),
        Field('summary_consolidate_words', 'Summary word limit (high)', 'number', consolidate_words,
              help='Below this, new conversation is added to the summary as it is; above it, '
                   'the summary is rewritten down to the low limit.'),
    )


class Engine:
    id = ''
    label = ''
    kind_label = ''           # the connection kind's name, when it differs from label
    description = ''
    fields = ()
    # Runs on the app's xAI key (Settings → xAI connection) — the built-in
    # "xAI" connection. A setup with no such engine runs without a key.
    uses_xai_key = False

    def __init__(self, settings, config):
        # `settings`: the connection's values plus this stage's setup values,
        # over the field defaults. `config`: the app config row (the xAI
        # key, URLs, search limits).
        self.settings = settings
        self.config = config

    def get(self, key):
        return self.settings.get(key)

    async def close(self):
        """Release connections. Called once when the call leg ends."""


class SttEngine(Engine):
    """Speech to text.

    Batch engines implement transcribe(); the pipeline cuts utterances with
    its own voice-activity and turn detection. Streaming engines set
    `streaming = True` and implement open_stream(): they hear the whole
    call and decide themselves where a turn ends.
    """
    streaming = False
    model_name = ''

    async def transcribe(self, audio16k, *, keyterms=()):
        """Transcript of one utterance (float32 mono, 16 kHz)."""
        raise NotImplementedError

    async def open_stream(self, *, keyterms=()):
        """A SttStream for the whole call leg."""
        raise NotImplementedError


class SttStream:
    """A live transcription session. push() audio as it arrives; events()
    yields ('partial', text) while the user talks and ('final', text) once
    the engine decides the turn is over."""

    async def push(self, audio16k):
        raise NotImplementedError

    async def finalize(self):
        """End the current turn now (the user pressed talk-over)."""

    def events(self):
        raise NotImplementedError

    async def close(self):
        pass


class LlmEngine(Engine):
    """The brain — of voice calls, and of text chat for companions whose
    text brain follows their voice setup. stream() yields, in order:

        ('text', delta)                       reply text
        ('tool_call', call_id, name, args)    a finished function call
        ('hosted_call', item)                 a call the provider ran itself
                                          (an xAI-shaped mcp_call item)
        ('file', file_id)                     a file the provider's code sandbox
                                          made for the user (download_file)
        ('usage', {input_tokens, output_tokens, ...})

    `items` is the whole conversation, every time: realtime-shaped messages
    ({'type': 'message', 'role', 'content'}) and function_call /
    function_call_output items.
    """
    # Tool types beyond plain functions this engine can pass through
    # ('web_search', 'x_search', 'code_interpreter', 'mcp'), in the app's
    # own (xAI Responses) shape: the engine translates them for its
    # provider. Others are dropped from the call.
    hosted_tools = ()

    @classmethod
    def hosted_for(cls, settings):
        """hosted_tools for one connection + setup: an engine whose provider
        decides it (OpenAI-compatible: only OpenAI's own API runs searches)
        overrides this."""
        return cls.hosted_tools

    @classmethod
    def file_types(cls, settings):
        """MIME types, besides images, of attached files this brain reads
        itself (input_file parts). Others reach it as text when they are
        text, else as a reference (session_service.attachment_part).
        Images follow the 'vision' setting."""
        return frozenset()

    @classmethod
    def sandbox_accepts(cls, settings, filename):
        """True when, with code execution on, the brain can open this
        attached file (one it can't read directly) in its provider's code
        sandbox - Claude's container_upload, OpenAI's container file_ids:
        it is uploaded for it."""
        return False

    @classmethod
    def download_file(cls, settings, file_id):
        """(filename, bytes, MIME type) of a ('file', file_id) the stream
        reported. Sync, like upload_file."""
        raise NotImplementedError

    @classmethod
    def upload_file(cls, settings, *, filename, data, mimetype, expires_seconds):
        """Put a file in the provider's Files API, so a request names it by
        id instead of carrying it: (file_id, expires_at as naive-UTC ISO or
        None). None = this engine has no Files API (files go inline). Sync:
        called from text chat's request building."""
        return None

    def __init__(self, settings, config):
        super().__init__(settings, config)
        self.hosted_tools = self.hosted_for(settings)

    def stream(self, *, instructions, items, tools, conversation_key):
        raise NotImplementedError


class TtsEngine(Engine):
    """Text to speech. The pipeline splits each reply into sentences as the
    brain writes it and calls synthesize() once per sentence, one sentence
    ahead of playback; the transcript of a sentence is sent just before its
    audio. An engine with a streaming socket keeps it open across calls to
    synthesize() (see tts.XaiTts).
    """
    # Renders Grok speech tags ([laugh], <whisper>…). Others get them removed.
    speech_tags = False
    # What a companion's voice is called on this engine, for the companion
    # editor's voice field.
    voice_hint = 'Voice name'
    # True when the engine has no voice of its own to fall back on, so a
    # request without one fails (ElevenLabs); callers check first and say
    # where to set one.
    needs_voice = False

    @classmethod
    def tag_guide(cls, settings):
        """For a voice with expression tags of its own (not Grok's): the
        whole "Speech expression tags" section a companion's prompt gets
        on this engine, how they work and which exist. It is the default
        of the companion editor's speech tags field, which a companion can
        rewrite (setups.Setup.tag_guide). '' = none built in: the field
        starts empty and nothing is taught until a companion fills it in
        (an OpenAI-compatible server can run any model, with any tags)."""
        return ''

    @classmethod
    def voice_for(cls, settings, companion_voice, pipeline_voice):
        """The voice a companion speaks with on this engine: its own
        pipeline voice when set, else the setup's default voice.
        (Grok voice names mean nothing to other engines; xAI's overrides
        this to fall back to them.)"""
        return pipeline_voice or settings.get('voice') or ''

    async def warm(self, *, voice, speed, rate):
        """Get ready for the first reply (open connections) while the call
        is still connecting. Optional."""

    async def synthesize(self, text, *, voice, speed, rate):
        """One sentence: an async iterator of (float32 mono samples,
        sample_rate). `rate` is the call's playback rate — use it when the
        engine can, any other rate is resampled. Cancelled mid-sentence on
        an interruption: stop generating there."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Turn taking — not an engine, but configured beside them, per setup.
# ---------------------------------------------------------------------------

TURN_FIELDS = (
    Field('smart_turn', 'Smart Turn (local)', 'bool', True,
          help='Listens to how you speak, not just for silence, to tell a finished '
               'thought from a pause mid-sentence (Pipecat Smart Turn v3.2, runs on '
               'this computer). With a live transcription engine it ends your turn '
               'early, as soon as you sound finished; the engine\'s own detection '
               'stays as the backstop.'),
    Field('preemptive', 'Start replying early', 'bool', True,
          help='When your turn sounds finished, the brain starts on your live words while '
               'the final transcript is made, and the reply is dropped if the final words '
               'differ. Saves the transcriber\'s finishing time on each reply, for an '
               'occasional extra brain request. Needs live words (a streaming engine, or '
               'live words on). LiveKit Agents default: on.'),
    Field('vad_threshold', 'Speech threshold', 'number', 0.7,
          help='How sure the voice detector must be that a sound is speech (0-1). '
               'Raise it if background noise or the companion\'s own voice through '
               'your speakers keeps interrupting. Pipecat default: 0.7.'),
    Field('silence_ms', 'Silence that ends a turn without Smart Turn (ms)', 'number', 800,
          help='Pipecat\'s voice-detector stop time before it had a turn model: 800 ms.'),
    Field('max_silence_ms', 'Longest pause inside a turn (ms)', 'number', 3000,
          help='With Smart Turn on, a turn it judges unfinished still ends after '
               'this much silence. Pipecat default: 3000 ms.'),
    Field('interrupt_ms', 'Speech needed to interrupt (ms)', 'number', 500,
          help='While the companion is talking, you must speak this long to cut in, '
               'so a cough or a "mm" doesn\'t stop them. LiveKit Agents default: 500 ms.'),
)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def _builtin():
    from . import llm, realtime, stt, tts
    return {'stt': stt.ENGINES, 'llm': llm.ENGINES, 'tts': tts.ENGINES, REALTIME: realtime.ENGINES}


def engines(stage):
    """{id: EngineClass} for a stage, built-ins first, then extensions'."""
    from .. import plugins
    out = {cls.id: cls for cls in _builtin()[stage]}
    for cls in plugins.voice_engines(stage):
        out.setdefault(cls.id, cls)
    return out


def engine_for(stage, kind):
    """The engine class serving `stage` on a connection of `kind`, or None."""
    return engines(stage).get(kind)


def kinds():
    """{kind: {'label', 'stages', 'fields'}} — every connection kind, the
    stages it can serve and its connection-scoped fields (merged across
    its engines, first definition wins)."""
    out = {}
    for stage in ALL_STAGES:
        for kind, cls in engines(stage).items():
            entry = out.setdefault(kind, {'label': cls.kind_label or cls.label, 'stages': [], 'fields': {}})
            entry['stages'].append(stage)
            for f in cls.fields:
                if f.scope == 'connection':
                    entry['fields'].setdefault(f.key, f)
    for entry in out.values():
        entry['fields'] = list(entry['fields'].values())
    return out


def setup_fields(cls):
    return [f for f in cls.fields if f.scope != 'connection']


def catalog():
    """Everything the Settings page needs to draw connections and setups."""
    def describe(cls, stage):
        entry = {'kind': cls.id, 'label': cls.label, 'description': cls.description,
                 'fields': [asdict(f) for f in setup_fields(cls)]}
        if stage == 'stt':
            entry['streaming'] = cls.streaming
        if stage == 'tts':
            entry['speech_tags'] = cls.speech_tags
            entry['own_tags'] = bool(cls.tag_guide(with_defaults(setup_fields(cls), None)))
            entry['voice_hint'] = cls.voice_hint
        if stage == REALTIME:
            entry['voice_hint'] = cls.voice_hint
        if stage == 'llm':
            entry['hosted_tools'] = list(cls.hosted_tools)
        return entry
    return {
        'kinds': [{'kind': k, 'label': v['label'], 'stages': v['stages'],
                   'fields': [asdict(f) for f in v['fields']]} for k, v in kinds().items()],
        'engines': {stage: [describe(cls, stage) for cls in engines(stage).values()] for stage in ALL_STAGES},
        'turn': [asdict(f) for f in TURN_FIELDS],
    }


def with_defaults(fields, saved):
    saved = saved if isinstance(saved, dict) else {}
    return {f.key: saved.get(f.key, f.default) for f in fields}


def coerce(field, value):
    if field.kind == 'bool':
        return bool(value)
    if field.kind == 'number':
        try:
            return float(value) if isinstance(field.default, float) else int(float(value))
        except (TypeError, ValueError):
            return field.default
    if field.kind == 'json':
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        text = str(value or '').strip()
        if text:
            json.loads(text)   # ValueError → the route turns it into a UserError
        return text
    if field.kind == 'select' and field.options and value not in {v for v, _ in field.options}:
        return field.default
    return '' if value is None else str(value).strip()


def json_field(engine, key):
    """A 'json' field's value as a dict ({} when empty or invalid)."""
    text = engine.get(key) or ''
    if not text:
        return {}
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
