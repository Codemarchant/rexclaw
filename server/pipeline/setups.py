# Copyright 2026 Codemarchant
"""Voice connections and voice setups — which engines a companion runs on.

    Connection  where engines live: a kind (engines.kinds()) plus its
                connection fields — a server URL, an API key. Entered once,
                shared by every setup. "xAI" is built in: it runs on the
                app's xAI key and has no row.
    Setup       a named pipeline: for each stage (stt, llm, tts) a
                connection plus that engine's setup fields (model, voice,
                ...), and the turn-taking settings. "Grok Realtime" is built
                in: xAI's speech-to-speech API, no row. A setup can instead
                run its calls on another provider's speech-to-speech model
                (stages['realtime'], realtime.py); its brain still serves
                text chat, summaries and delegated tasks.

A companion picks a setup (agents.voice_setup: '' = the app default,
'realtime', or a setup id) and keeps its own voice per voice connection
(agents.pipeline_voice, see pipeline_voice()), so one setup serves many
companions. With agents.text_brain =
'voice_setup' its text chat uses the setup's brain too.

Stored as JSON per row. Only values that differ from a field's default are
kept, so a default the app improves later reaches every setup that never
chose otherwise. API keys are write-only from the UI, like the app's
others: the page gets True for "one is saved".
"""
import json

from ..db import get_config
from ..errors import UserError
from . import engines as E

REALTIME = 'realtime'
XAI = 'xai'   # the built-in connection's id (and kind)


def _json(text):
    try:
        value = json.loads(text or '{}')
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _connections(con):
    """{id: {'id', 'name', 'kind', 'settings'}} including the built-in xAI."""
    out = {XAI: {'id': XAI, 'name': 'xAI', 'kind': XAI, 'settings': {}, 'builtin': True}}
    for r in con.execute('SELECT * FROM voice_connections ORDER BY sequence, id'):
        out[r['id']] = {'id': r['id'], 'name': r['name'], 'kind': r['kind'],
                        'settings': _json(r['settings'])}
    return out


def _conn_id(value):
    """A stored/posted connection reference: 'xai' or an int row id."""
    if value == XAI or value is None:
        return XAI
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


class Setup:
    """One resolved voice setup, ready to build engines from."""

    def __init__(self, row_id, name, stages, turn, tts_connection=XAI, realtime=None, realtime_connection=None):
        self.id, self.name = row_id, name
        self.stages = stages   # {stage: (EngineClass, settings)}
        self.turn = turn
        self.tts_connection = tts_connection   # the voice stage's connection id
        # Speech-to-speech (realtime.py): (RealtimeEngine class, settings)
        # running the calls in place of stt → llm → tts, or None. The brain
        # stage still serves text chat, summaries and delegate_task; the voice
        # stage, voice messages.
        self.realtime = realtime
        self.realtime_connection = realtime_connection

    @property
    def uses_xai_key(self):
        """Whether its calls need the app's xAI key."""
        if self.realtime:
            return self.realtime[0].uses_xai_key
        return any(cls.uses_xai_key for cls, _ in self.stages.values())

    @property
    def call_connection(self):
        """The connection the companion's call voice is keyed by
        (pipeline_voice): the realtime one, else the voice stage's."""
        return self.realtime_connection if self.realtime else self.tts_connection

    @property
    def speech_tags(self):
        """Whether the call's voice renders Grok's speech tags."""
        return False if self.realtime else bool(self.stages['tts'][0].speech_tags)

    def engine(self, stage, config):
        cls, settings = self.stages[stage]
        return cls(settings, config)

    def build(self, config):
        return tuple(self.engine(stage, config) for stage in E.STAGES)

    def voice_for(self, agent):
        cls, settings = self.realtime or self.stages['tts']
        return cls.voice_for(settings, agent['voice'], pipeline_voice(agent, self.call_connection))

    def tag_guide(self, agent):
        """The "Speech expression tags" section a companion's prompt gets
        on this setup's voice, when that voice isn't one that renders
        Grok's tags (those have the app's own section): what the companion
        wrote for this voice connection, else the engine's built-in text
        (TtsEngine.tag_guide). '' = nothing taught — an engine with none
        built in, on a companion that wrote none."""
        cls, settings = self.stages['tts']
        if self.realtime or cls.speech_tags:
            return ''
        return companion_tag_guide(agent, self.tts_connection) or cls.tag_guide(settings)


def call_voice_label(con, agent, config=None):
    """The voice a companion's calls speak with, for lists and pickers: its
    setup's engine voice (OpenAI's marin) rather than the Grok one, or the
    engine's name where that voice is an opaque id (a Fish model)."""
    setup = for_agent(con, agent, config)
    voice = setup.voice_for(agent) if setup else ''
    if not voice:
        return agent['voice']
    if len(voice) >= 20 and voice.isalnum() and not voice.isalpha():
        return (setup.realtime or setup.stages['tts'])[0].label
    return voice


def companion_tag_guide(agent, connection):
    """A companion's own speech-tag section on one voice connection:
    agents.speech_tag_guides is a JSON map {connection id: text}, holding
    only what the companion wrote — none for a connection = the engine's
    built-in text, if it has one. Keyed by connection, like its voice
    (pipeline_voice): two OpenAI-compatible servers can run models with
    different tags, or none."""
    try:
        guides = json.loads(agent['speech_tag_guides'] or '{}')
    except ValueError:
        return ''
    return str(guides.get(str(connection)) or '').strip() if isinstance(guides, dict) else ''


def pipeline_voice(agent, connection):
    """A companion's voice on one voice connection: agents.pipeline_voice
    is a JSON map {connection id: voice}. Keyed by connection, not setup —
    two setups on the same Kokoro server share it, and switching setups
    never sends a Kokoro voice name to Fish. On xAI the companion's Grok
    voice is used (the map has no entry for it)."""
    try:
        voices = json.loads(agent['pipeline_voice'] or '{}')
    except ValueError:
        return ''
    return str(voices.get(str(connection)) or '').strip() if isinstance(voices, dict) else ''


def context_full(settings, tokens, floor):
    """True when a request of `tokens` to a setup's brain owes a summary:
    it reached the brain's 'Summarise at' size (engines.conversation_fields).
    A text API is sent the whole conversation every time, so one request's
    size is the conversation's — the app's Grok budgets (sums of billed
    tokens on xAI's stored chains and realtime calls) don't describe it.

    `floor` is what summarising can't shrink — the companion's prompt,
    tools and the summary itself: the first request's size after the last
    summary, or the size at which a summary found nothing old enough to
    absorb (session_service.generate_session_summary); 0 until either.
    With the floor at or near 'Summarise at', every reply (or every few)
    would owe another summary, so a summary always waits for at least half
    the limit's worth of new conversation (a design pick, not a sourced
    number)."""
    limit = int((settings or {}).get('compact_at') or 0)
    if limit <= 0:
        return False
    return tokens >= max(limit, floor + limit // 2)


def request_tokens(usage):
    """One request's size: everything sent plus the reply written."""
    return int((usage or {}).get('input_tokens') or 0) + int((usage or {}).get('output_tokens') or 0)


def summary_limits(settings, config):
    """(max_words, consolidate_words) for summaries: the brain's own when it
    has them, else Settings' (summary_max_words / summary_consolidate_words)."""
    settings = settings or {}
    return (int(settings.get('summary_max_words', config['summary_max_words']) or 0),
            int(settings.get('summary_consolidate_words', config['summary_consolidate_words']) or 0))


def _resolve_row(con, row, connections=None):
    connections = connections or _connections(con)
    stages_saved = _json(row['stages'])
    stages = {}
    tts_connection = XAI
    for stage in E.STAGES:
        saved = stages_saved.get(stage) or {}
        conn = connections.get(_conn_id(saved.get('connection')))
        cls = E.engine_for(stage, conn['kind']) if conn else None
        if cls is None:
            # The connection was removed, or its extension is gone: fall
            # back to xAI rather than failing the call.
            conn, cls = connections[XAI], E.engine_for(stage, XAI)
            saved = {}
        conn_fields = [f for f in cls.fields if f.scope == 'connection']
        settings = {**E.with_defaults(conn_fields, conn['settings']),
                    **E.with_defaults(E.setup_fields(cls), saved)}
        stages[stage] = (cls, settings)
        if stage == 'tts':
            tts_connection = conn['id']
    realtime, realtime_connection = None, None
    saved = stages_saved.get(E.REALTIME)
    if saved:
        conn = connections.get(_conn_id(saved.get('connection')))
        cls = E.engine_for(E.REALTIME, conn['kind']) if conn else None
        if cls is not None:   # its connection gone: the stages take the calls
            conn_fields = [f for f in cls.fields if f.scope == 'connection']
            realtime = (cls, {**E.with_defaults(conn_fields, conn['settings']),
                              **E.with_defaults(E.setup_fields(cls), saved)})
            realtime_connection = conn['id']
    return Setup(row['id'], row['name'], stages, E.with_defaults(E.TURN_FIELDS, stages_saved.get('turn')),
                 tts_connection, realtime, realtime_connection)


def get(con, setup_id):
    """A saved setup by id, or None."""
    try:
        row = con.execute('SELECT * FROM voice_setups WHERE id = ?', (int(setup_id),)).fetchone()
    except (TypeError, ValueError):
        return None
    return _resolve_row(con, row) if row else None


def for_agent(con, agent, config=None):
    """The Setup a companion's calls use, or None for Grok Realtime. A
    choice that no longer exists — deleted, or a companion imported from
    another install — falls back to the app default, then to Realtime."""
    config = config or get_config(con)
    for choice in ((agent['voice_setup'] or '').strip(), config['default_voice_setup'] or REALTIME):
        if choice == REALTIME:
            return None
        setup = get(con, choice) if choice else None
        if setup is not None:
            return setup
    return None


def text_brain_for(con, agent, config=None):
    """(LlmEngine class, settings) for a companion whose text chat follows
    its voice setup's brain, else None — the app's own Grok text chat.
    Without an xAI key the app's Grok can't answer, so a companion on a
    setup whose brain isn't xAI's chats on that brain whatever it picked:
    a fully local install works without switching every companion over."""
    config = config or get_config(con)
    follow = (agent['text_brain'] or 'app') == 'voice_setup'
    if not follow and config['xai_api_key']:
        return None
    setup = for_agent(con, agent, config)
    if setup is None:
        return None
    brain = setup.stages['llm']
    return brain if follow or not brain[0].uses_xai_key else None


# ---------------------------------------------------------------------------
# Settings page
# ---------------------------------------------------------------------------

def public(con):
    """Connections and setups for the Settings page, keys masked, every
    field present."""
    kinds = E.kinds()
    conns = []
    for c in _connections(con).values():
        fields = kinds.get(c['kind'], {}).get('fields', [])
        values = E.with_defaults(fields, c['settings'])
        for f in fields:
            if f.kind == 'secret':
                values[f.key] = bool(values.get(f.key))
        conns.append({**c, 'settings': values})
    setups = []
    connections = _connections(con)
    for r in con.execute('SELECT * FROM voice_setups ORDER BY sequence, id'):
        saved = _json(r['stages'])
        stages = {}
        for stage in E.STAGES:
            s = saved.get(stage) or {}
            conn = connections.get(_conn_id(s.get('connection'))) or connections[XAI]
            cls = E.engine_for(stage, conn['kind']) or E.engine_for(stage, XAI)
            stages[stage] = {'connection': conn['id'], **E.with_defaults(E.setup_fields(cls), s)}
        stages['turn'] = E.with_defaults(E.TURN_FIELDS, saved.get('turn'))
        # null = a pipeline setup (stt → llm → tts).
        s = saved.get(E.REALTIME)
        conn = connections.get(_conn_id(s.get('connection'))) if s else None
        cls = E.engine_for(E.REALTIME, conn['kind']) if conn else None
        stages[E.REALTIME] = {'connection': conn['id'], **E.with_defaults(E.setup_fields(cls), s)} if cls else None
        setups.append({'id': r['id'], 'name': r['name'], 'stages': stages})
    return {'connections': conns, 'setups': setups}


def save(con, payload):
    """Replace the connections and setups with the Settings page's lists.

    New rows come with a temporary id ('new:…'); a setup may point at a new
    connection by that id. Rows missing from a list are deleted, and
    companions (and the default) pointing at a deleted setup fall back to
    the app default / Grok Realtime. Doesn't commit."""
    kinds = E.kinds()
    existing = _connections(con)
    ids = {}   # posted id → row id
    keep = set()
    for i, c in enumerate(payload.get('connections') or []):
        if c.get('builtin') or c.get('id') == XAI:
            continue
        kind = c.get('kind')
        old = existing.get(_conn_id(c.get('id')))
        if old and old['kind'] == kind and kind not in kinds:
            # Its extension isn't loaded: keep the row as it is, so the
            # rest of Settings still saves and the row works again later.
            ids[str(c.get('id'))] = old['id']
            keep.add(old['id'])
            continue
        if kind not in kinds or kind == XAI:
            raise UserError(f'Unknown connection kind: {kind}')
        name = (c.get('name') or '').strip() or kinds[kind]['label']
        stored = dict(old['settings']) if old else {}
        values = c.get('settings') or {}
        for f in kinds[kind]['fields']:
            if f.key not in values:
                continue
            v = values[f.key]
            if f.kind == 'secret':
                if v is None:
                    stored.pop(f.key, None)
                elif isinstance(v, str) and v.strip():
                    stored[f.key] = v.strip()
                continue
            stored[f.key] = E.coerce(f, v)
            if stored[f.key] == f.default:
                stored.pop(f.key)
        if old and old['kind'] == kind:
            con.execute('UPDATE voice_connections SET name = ?, settings = ?, sequence = ? WHERE id = ?',
                        (name, json.dumps(stored), i, old['id']))
            row_id = old['id']
        else:
            row_id = con.execute('INSERT INTO voice_connections (name, kind, settings, sequence) '
                                 'VALUES (?, ?, ?, ?)', (name, kind, json.dumps(stored), i)).lastrowid
        ids[str(c.get('id'))] = row_id
        keep.add(row_id)
    for cid in existing:
        if cid != XAI and cid not in keep:
            con.execute('DELETE FROM voice_connections WHERE id = ?', (cid,))

    connections = _connections(con)
    kept_setups = set()
    for i, s in enumerate(payload.get('setups') or []):
        name = (s.get('name') or '').strip() or 'Voice setup'
        stages_in = s.get('stages') or {}
        try:
            old_id = int(s.get('id'))
        except (TypeError, ValueError):
            old_id = None
        old = con.execute('SELECT stages FROM voice_setups WHERE id = ?', (old_id,)).fetchone() if old_id else None
        stored = {}
        for stage in E.STAGES:
            st = stages_in.get(stage) or {}
            ref = st.get('connection')
            ref = ids.get(str(ref), _conn_id(ref))
            conn = connections.get(ref)
            if conn and conn['kind'] not in kinds and old:
                # On a connection whose extension isn't loaded: the page
                # showed stand-in fields, so keep the stage as stored.
                stored[stage] = _json(old['stages']).get(stage) or {'connection': conn['id']}
                continue
            cls = E.engine_for(stage, conn['kind']) if conn else None
            if cls is None:
                raise UserError(f'"{name}": pick a connection that can do '
                                f'{ {"stt": "speech to text", "llm": "the brain", "tts": "the voice"}[stage] }.')
            out = {'connection': conn['id']}
            for f in E.setup_fields(cls):
                if f.key in st:
                    v = E.coerce(f, st[f.key])
                    if v != f.default:
                        out[f.key] = v
            stored[stage] = out
        turn = {}
        for f in E.TURN_FIELDS:
            if f.key in (stages_in.get('turn') or {}):
                v = E.coerce(f, stages_in['turn'][f.key])
                if v != f.default:
                    turn[f.key] = v
        stored['turn'] = turn
        rt = stages_in.get(E.REALTIME)
        if rt:
            ref = rt.get('connection')
            conn = connections.get(ids.get(str(ref), _conn_id(ref)))
            cls = E.engine_for(E.REALTIME, conn['kind']) if conn else None
            if cls is None:
                raise UserError(f'"{name}": pick a connection that runs speech-to-speech (OpenAI).')
            out = {'connection': conn['id']}
            for f in E.setup_fields(cls):
                if f.key in rt:
                    v = E.coerce(f, rt[f.key])
                    if v != f.default:
                        out[f.key] = v
            stored[E.REALTIME] = out
        if old:
            con.execute('UPDATE voice_setups SET name = ?, stages = ?, sequence = ? WHERE id = ?',
                        (name, json.dumps(stored), i, old_id))
            row_id = old_id
        else:
            row_id = con.execute('INSERT INTO voice_setups (name, stages, sequence) VALUES (?, ?, ?)',
                                 (name, json.dumps(stored), i)).lastrowid
        ids[str(s.get('id'))] = row_id
        kept_setups.add(row_id)
    for (sid,) in con.execute('SELECT id FROM voice_setups').fetchall():
        if sid not in kept_setups:
            con.execute('DELETE FROM voice_setups WHERE id = ?', (sid,))
            con.execute("UPDATE agents SET voice_setup = '' WHERE voice_setup = ?", (str(sid),))
            con.execute("UPDATE config SET default_voice_setup = ? WHERE default_voice_setup = ?",
                        (REALTIME, str(sid)))
    return ids


def default_choice(con, ids, value):
    """The posted default ('realtime', an id or a new setup's temporary id)
    as it is stored — Realtime when that setup doesn't exist (any more)."""
    if value in (None, '', REALTIME):
        return REALTIME
    setup_id = ids.get(str(value), value)
    try:
        exists = con.execute('SELECT 1 FROM voice_setups WHERE id = ?', (int(setup_id),)).fetchone()
    except (TypeError, ValueError):
        exists = None
    return str(setup_id) if exists else REALTIME


# ---------------------------------------------------------------------------
# Migration of the single pipeline (config.voice_engine / voice_pipeline,
# never released) into a connection + setup.
# ---------------------------------------------------------------------------

def migrate_single_pipeline(con):
    cols = {r[1] for r in con.execute('PRAGMA table_info(config)')}
    if 'voice_pipeline' not in cols:
        return
    row = con.execute('SELECT voice_engine, voice_pipeline FROM config WHERE id = 1').fetchone()
    data = _json(row['voice_pipeline']) if row else {}
    if data:
        stages = {}
        made = {}
        for stage in E.STAGES:
            block = data.get(stage) or {}
            kind = block.get('engine') or XAI
            cls = E.engine_for(stage, kind)
            if cls is None:
                kind, cls = XAI, E.engine_for(stage, XAI)
            values = (block.get('engines') or {}).get(kind) or {}
            conn_values = {f.key: values[f.key] for f in cls.fields
                           if f.scope == 'connection' and f.key in values}
            if kind == XAI:
                conn_id = XAI
            else:
                key = (kind, json.dumps(conn_values, sort_keys=True))
                if key not in made:
                    made[key] = con.execute(
                        'INSERT INTO voice_connections (name, kind, settings) VALUES (?, ?, ?)',
                        (E.kinds()[kind]['label'], kind, json.dumps(conn_values))).lastrowid
                conn_id = made[key]
            stages[stage] = {'connection': conn_id,
                             **{k: v for k, v in values.items()
                                if k not in conn_values and k in {f.key for f in E.setup_fields(cls)}}}
        stages['turn'] = data.get('turn') or {}
        setup_id = con.execute('INSERT INTO voice_setups (name, stages) VALUES (?, ?)',
                               ('My pipeline', json.dumps(stages))).lastrowid
        if row['voice_engine'] == 'pipeline':
            con.execute('UPDATE config SET default_voice_setup = ? WHERE id = 1', (str(setup_id),))
    con.execute('ALTER TABLE config DROP COLUMN voice_engine')
    con.execute('ALTER TABLE config DROP COLUMN voice_pipeline')
