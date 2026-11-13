# Copyright 2026 Codemarchant
"""Conversation coach: a second model that reads a voice call from the side
and now and then hands the companion a thought.

Each companion keeps a list of rules (the agents.coach_rules JSON column).
A rule says when the coach is brought in and what it is asked for:

  stat, stat_min,  an optional wait: so many replies since something last
  stat_max         happened - a tool call, a tracked moment, this rule's own
                   last turn, or the coach's last thought. With stat_max
                   above stat_min the length is drawn afresh from that range
                   each time the rule fires.
  judge            who decides the moment has come once the wait is over:
                   'decision' - the decision model (jev.py) answers the
                   rule's yes/no `question` about the last stretch of the
                   call, and `when` is the answer that fires it; 'coach' -
                   the coach model reads the call and decides for itself.
  advice           what the coach is asked to work out.

Tracked moments (the agents.coach_moments JSON column, each companion its
own) are yes/no questions asked about each reply only to keep count: "did
the companion just make a joke?" gives a rule a "replies since the last
joke" to wait on.

After every reply the companion finishes, the browser asks for a review
(web/src/lib/coach.js), naming the tools called since the last one. The
counters move, one decision-model request reads every question that is
due, and one rule at most fires - the most overdue of those whose moment
has come; the rest keep their counts for a later reply, no sooner than
agents.coach_gap replies after the last thought. Only then does the coach
model itself run - on the
text chat brain of the voice setup the companion names
(agents.coach_setup), else on the brain its own text chat uses. The coach
reads the companion's whole prompt and the whole conversation and answers
with a short thought, or with nothing.

A rule that fires waits its whole length again whether or not anything
comes of it, so one overdue moment is offered once and then waited for
again. The thought reaches the companion as a hidden context item whenever
it is ready and never holds a reply back. It is saved as a system row, so
the coach's next review sees what it already said and how it landed.
"""
import hashlib
import json
import logging
import random
import secrets
import re

from . import face_director, jev, store, xai_client
from .db import get_config
from .pipeline import setups as voice_setups

_logger = logging.getLogger(__name__)

# Every thought starts with this (web/src/lib/coach.js records it as given).
# session_service._transcript_rows keeps the saved row out of the visible
# transcript by this prefix.
NOTE_PREFIX = '[Inner thought'
_NOTE_HEADER = (
    NOTE_PREFIX + '] (This comes from the back of your own mind: your inner coach, noticing how this '
    'conversation is going. Nobody else can hear it. It is not an instruction. If it fits, let it '
    'colour what you would say anyway, in your own voice, at a moment that suits. If the moment has '
    'passed, let it go. Don\'t mention this thought or that anything prompted you.)')
# The coach's whole answer when it has nothing to add.
NOTHING = 'NONE'

# How much of the call the decision model reads for a question: the turn
# director's window (session_service.director_decide).
WINDOW_LINES = 12
_LINE_MAX = 500

JUDGES = ('decision', 'coach')
# Counter keys (the coach_counters table): the coach's last thought, and the
# rule's own last turn - stored per rule as 'rule:<id>'.
NOTE_KEY = 'note'
OWN_RULE = 'rule'
# Replies since a thought last reached the companion, for agents.coach_gap.
# Unlike NOTE_KEY - which a rule can wait on, and so starts counting when
# one first asks - it does not exist until a thought has been delivered.
SENT_KEY = 'sent'
_ID_RE = re.compile(r'^[a-z0-9]{1,16}$')
_KEY_RE = re.compile(r'^(tool:[A-Za-z0-9_.\-]{1,64}|stat:[a-z0-9]{1,16})$')
# What the coach may be given to look things up with (agents.coach_tools):
# searches the brain's provider runs inside the one request.
COACH_TOOLS = ('web_search', 'x_search')

_MAX_RULES = 50
_MAX_STATS = 50
_MAX_NAME = 80
_MAX_QUESTION = 1000
_MAX_ADVICE = 4000
_MAX_NOTE = 2000
_MAX_WAIT = 100000
# The coach reasons over the whole conversation, so it gets the time a
# summary gets rather than a reply's.
_COACH_TIMEOUT = 120

COACH_INSTRUCTIONS = (
    'You are the inner coach of an AI companion who is on a live voice call: the part of their own '
    'mind that steps back and notices how the conversation is going. You are not in the call. You '
    'read it from the side, and what you write surfaces in the companion\'s mind as a thought of '
    'their own before one of their next replies. The user never sees it.\n\n'
    'Below you get the companion\'s own instructions (who they are and how they talk), the '
    'conversation so far, some counts, and what to look at this time. Lines in the conversation '
    f'marked {NOTE_PREFIX}] are thoughts you sent earlier: check how they landed, and do not send '
    'the same one twice.\n\n'
    'Write one short thought, a few sentences at most, in plain words, in the first person, as the '
    'companion thinking to themselves ("I never asked how the interview went."). Give them '
    'something concrete they can use in their own voice: what you notice about how the talk is '
    'going, a detail from earlier worth coming back to, a fact, a fresh angle. It is material, not '
    'a script: do not write their lines for them. Stay inside who they are - a thought that pulls '
    'them out of character is worse than none.\n\n'
    'What you are asked to look at is an opening, not an order. If it does not fit this moment, or '
    f'nothing here would make the conversation better right now, answer with the single word {NOTHING}.'
)


def _int(value, lo, hi, fallback):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return fallback


def _stat_key(value):
    """A rule's wait as stored: '' (none), 'rule', 'note', 'tool:<name>' or
    'stat:<moment id>'."""
    value = str(value or '').strip()
    return value if value in (OWN_RULE, NOTE_KEY) or _KEY_RE.match(value) else ''


def _json_list(value):
    """A column's list, from the list itself or its JSON text."""
    if isinstance(value, str):
        try:
            value = json.loads(value or '[]')
        except ValueError:
            value = []
    return value if isinstance(value, list) else []


def clean_rules(value, mint=False):
    """The coach_rules list in its stored shape: {id, name, judge, question,
    when, stat, stat_min, stat_max, advice, active} dicts. Accepts the list or
    its JSON text; malformed entries are dropped rather than refused
    (imports carry whatever another install wrote). `id` is the short key a
    rule's counters are kept under ('rule:<id>', 'wait:<id>'), so renaming a
    rule keeps its count and two rules never share one. The editor mints it;
    a rule that arrives without one, or with one already taken, gets a new
    one on save (`mint`), and until then is known by its name."""
    out, seen = [], set()
    for item in _json_list(value)[:_MAX_RULES]:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '')[:_MAX_NAME]
        key = str(item.get('id') or '')
        if not _ID_RE.match(key) or key in seen:
            key = secrets.token_hex(4) if mint else 'n' + hashlib.md5(name.encode()).hexdigest()[:8]
        seen.add(key)
        out.append({
            'id': key,
            'name': name,
            'judge': item.get('judge') if item.get('judge') in JUDGES else 'decision',
            'question': str(item.get('question') or '')[:_MAX_QUESTION],
            'when': 'no' if item.get('when') == 'no' else 'yes',
            'stat': _stat_key(item.get('stat')),
            'stat_min': (lo := _int(item.get('stat_min'), 0, _MAX_WAIT, 0)),
            'stat_max': _int(item.get('stat_max'), lo, _MAX_WAIT, lo),
            'advice': str(item.get('advice') or '')[:_MAX_ADVICE],
            'active': bool(item.get('active', True)),
        })
    return out


def rules_json(value):
    """JSON text for the column. Compact separators and this key order match
    the editor's JSON.stringify, so a list the user didn't touch never reads
    as an unsaved edit after a reload."""
    return json.dumps(clean_rules(value, mint=True), ensure_ascii=False, separators=(',', ':'))


def active_rules(agent):
    """The rules that can fire: switched on, with advice to ask for and a
    way to decide (a question for the decision model, or the coach)."""
    if not agent['coach_enabled']:
        return []
    return [r for r in clean_rules(agent['coach_rules'])
            if r['active'] and r['advice'].strip() and (r['judge'] == 'coach' or r['question'].strip())]


def call_payload(agent):
    """True when this companion's calls should ask for reviews."""
    return bool(active_rules(agent))


# ---------------------------------------------------------------------------
# Tracked moments and counters
# ---------------------------------------------------------------------------

def clean_moments(value):
    """The coach_moments list in its stored shape: {id, name, question,
    active} dicts. `id` is the short key rules and counters know the moment
    by ('stat:<id>'), so renaming one keeps its count; the editor mints it."""
    out, seen = [], set()
    for item in _json_list(value)[:_MAX_STATS]:
        if not isinstance(item, dict):
            continue
        key = str(item.get('id') or '')
        if not _ID_RE.match(key) or key in seen:
            continue
        seen.add(key)
        out.append({
            'id': key,
            'name': str(item.get('name') or '')[:_MAX_NAME],
            'question': str(item.get('question') or '')[:_MAX_QUESTION],
            'active': bool(item.get('active', True)),
        })
    return out


def moments_json(value):
    """JSON text for the column, in the editor's own shape (see rules_json)."""
    return json.dumps(clean_moments(value), ensure_ascii=False, separators=(',', ':'))


def tracked_stats(agent, rules):
    """The moments counted for this companion: the ones switched on, and any
    that one of its active rules waits on."""
    waited = {r['stat'][5:] for r in rules if r['stat'].startswith('stat:')}
    return [m for m in clean_moments(agent['coach_moments'])
            if m['question'].strip() and (m['active'] or m['id'] in waited)]


def counts(con, agent):
    """One companion's counters, for the editor."""
    return {'counts': _counters(con, agent['id'])}


def _counters(con, agent_id):
    return {r['key']: r['replies'] for r in con.execute(
        'SELECT key, replies FROM coach_counters WHERE agent_id = ?', (agent_id,))}


def _reset(con, agent_id, keys):
    for key in keys:
        con.execute('INSERT INTO coach_counters (agent_id, key, replies) VALUES (?, ?, 0) '
                    'ON CONFLICT(agent_id, key) DO UPDATE SET replies = 0', (agent_id, key))


def _wait_key(rule):
    """The counter a rule waits on, or None."""
    if not rule['stat']:
        return None
    return f'rule:{rule["id"]}' if rule['stat'] == OWN_RULE else rule['stat']


def _advance(con, agent_id, rules, stats, replies, tools):
    """Move every counter of this companion on by `replies` and return them.
    A counter starts the first time something asks for it, so "since the
    last gesture" counts from when the coach began watching until one is
    seen. The tools just called start over at zero."""
    tool_keys = [key for key in (f'tool:{t}' for t in tools) if _KEY_RE.match(key)]
    wanted = {*tool_keys, *(f'stat:{s["id"]}' for s in stats), *(f'rule:{r["id"]}' for r in rules)}
    wanted.update(key for key in map(_wait_key, rules) if key)
    for key in wanted:
        con.execute('INSERT OR IGNORE INTO coach_counters (agent_id, key, replies) VALUES (?, ?, 0)',
                    (agent_id, key))
    con.execute("UPDATE coach_counters SET replies = replies + ? WHERE agent_id = ? AND key NOT LIKE 'wait:%'",
                (replies, agent_id))
    _reset(con, agent_id, tool_keys)
    _draw_waits(con, agent_id, rules)
    con.commit()
    return _counters(con, agent_id)


def _draw_waits(con, agent_id, rules):
    """A rule whose wait is a range gets one length out of it, drawn at
    random and kept ('wait:<id>') until the rule fires - so two rules
    with the same wait drift apart instead of coming due together every
    time."""
    held = _counters(con, agent_id)
    for r in rules:
        if not r['stat'] or r['stat_max'] <= r['stat_min']:
            continue
        key = f'wait:{r["id"]}'
        if not r['stat_min'] <= held.get(key, -1) <= r['stat_max']:
            con.execute('INSERT INTO coach_counters (agent_id, key, replies) VALUES (?, ?, ?) '
                        'ON CONFLICT(agent_id, key) DO UPDATE SET replies = excluded.replies',
                        (agent_id, key, random.randint(r['stat_min'], r['stat_max'])))


def _wait_length(rule, counts):
    """How many replies this rule is waiting for this time round."""
    return counts.get(f'wait:{rule["id"]}', rule['stat_min']) if rule['stat_max'] > rule['stat_min'] \
        else rule['stat_min']


def _since(rule, counts):
    """Replies this rule has waited: since the thing it waits on, or since
    its own last turn if that is more recent - having fired, it waits the
    whole length again even though the thing itself has not happened. The
    thing's own count is left alone, so the coach and other rules read it
    true. None for a rule with no wait."""
    key = _wait_key(rule)
    return None if key is None else min(counts.get(key, 0), counts.get(f'rule:{rule["id"]}', 0))


def _waited(rule, counts):
    since = _since(rule, counts)
    return since is None or since >= _wait_length(rule, counts)


def _overdue(rule, counts):
    """How far past its wait a rule is, as a share of the wait: what picks
    one rule when several are due at once. A rule with no wait is exactly
    due."""
    since = _since(rule, counts)
    return 1.0 if since is None else since / max(_wait_length(rule, counts), 1)


def _count_lines(counts, stats):
    """The counters as the coach reads them."""
    names = {f'stat:{s["id"]}': s['name'] or s['question'] for s in stats}
    lines = []
    for key, n in sorted(counts.items()):
        if key == NOTE_KEY:
            what = 'your last thought'
        elif key.startswith('tool:'):
            what = f'the {key[5:]} tool was last used'
        elif key in names:
            what = f'"{names[key]}" last happened'
        else:
            continue
        lines.append(f'- {n} since {what}')
    return lines


# ---------------------------------------------------------------------------
# The review
# ---------------------------------------------------------------------------

def _speaker_lines(rows, own_name):
    """The spoken lines of a call, oldest first, as '[name]: words'."""
    lines = []
    for m in rows:
        text = (m['content'] or '').strip()
        if not text:
            continue
        if m['role'] == 'user':
            lines.append(f'[User]: {text}')
        elif m['role'] == 'assistant':
            lines.append(f'[{m["speaker"] or own_name or "Companion"}]: {text}')
    return lines


def _conversation_text(rows, own_name):
    """Everything the companion's own context holds, as one transcript:
    summaries first, then every row since, hidden notes and tool use
    included."""
    rollups = [m for m in rows if m['is_summary_rollup']]
    lines = [(m['content'] or '').strip() for m in rollups]
    for m in rows:
        if m['is_summary_rollup']:
            continue
        text = (m['content'] or '').strip()
        role = m['role']
        if role == 'system':
            if text:
                lines.append(text if text.startswith(NOTE_PREFIX) else f'[Note: {text}]')
        elif role == 'tool_call':
            args = (m['tool_arguments_json'] or '').strip()
            lines.append(f'({own_name or "Companion"} used {m["tool_name"] or "a tool"}'
                         + (f' with {args}' if args and args != '{}' else '') + ')')
        elif role == 'tool_result':
            out = (m['tool_result_json'] or text or '').strip()
            if out:
                lines.append(f'(result: {out})')
        elif text:
            lines.extend(_speaker_lines([m], own_name))
    return '\n'.join(line for line in lines if line)


def _window(rows, own_name):
    return [line[:_LINE_MAX] for line in _speaker_lines(rows, own_name)[-WINDOW_LINES:]]


def _last_reply(rows, own_name):
    for m in reversed(rows):
        if m['role'] == 'assistant' and (not m['speaker'] or m['speaker'] == own_name):
            return (m['content'] or '').strip()[:_LINE_MAX]
    return ''


def _character(agent):
    """Who the companion is, as the face and gesture directors hand it to
    the decision model: whether a line is a joke, or out of the ordinary,
    depends on who says it."""
    from . import session_service   # imports this module
    return {'name': agent['name'] or '',
            'personality': face_director.persona_excerpt(session_service._render_prompt(agent))}


def _judge(con, config, agent, rules, stats, counts, rows):
    """One decision-model request for everything that is due: each tracked
    moment, and the question of every rule whose wait is over. Returns
    (fired rules - one at most -, counters after the tracked moments just
    seen, what was read). With no decision model, or a failed read, only
    rules the coach judges fire. While the last thought the companion got
    is fewer than agents.coach_gap replies old no rule is looked at; the
    tracked moments are still counted."""
    own_name = agent['name'] or ''
    qs = {f's{s["id"]}': {'type': 'noul', 'instructions': s['question'].strip()} for s in stats}
    if counts.get(SENT_KEY, _MAX_WAIT) < _int(agent['coach_gap'], 0, _MAX_WAIT, 0):
        rules = []
    for i, r in enumerate(rules):
        if r['judge'] == 'decision' and _waited(r, counts):
            qs[f'r{i}'] = {'type': 'noul', 'instructions': r['question'].strip()}
    yes = {}
    if qs and jev.ready(config):
        state = {'character': _character(agent), 'conversation': _window(rows, own_name),
                 'last_reply': _last_reply(rows, own_name)}
        try:
            body = jev.ask(config, state, qs)
            yes = {qid: a['yes'] for qid, a in jev.answers(body, qs).items() if 'yes' in a}
            store.accrue_usd_ticks(con, jev.input_ticks(body))
        except Exception as e:  # noqa: BLE001 - a failed read is "nothing answered"
            _logger.warning('coach: decision model failed: %s', e)
    seen = [f'stat:{s["id"]}' for s in stats if yes.get(f's{s["id"]}', 0) >= jev.YES]
    if seen:
        _reset(con, agent['id'], seen)
        counts = {**counts, **{key: 0 for key in seen}}
    fired = []
    for i, r in enumerate(rules):
        # Checked again: the moment a rule waits on may just have happened.
        if not _waited(r, counts):
            continue
        if r['judge'] == 'decision':
            p = yes.get(f'r{i}')
            if p is None or (p >= jev.YES) != (r['when'] == 'yes'):
                continue
        fired.append(r)
    # Several due at once: the most overdue goes, the rest keep their
    # counts and come up again on a later reply.
    fired = [max(fired, key=lambda r: _overdue(r, counts))] if fired else []
    return fired, counts, {qid: round(p, 3) for qid, p in yes.items()}


def _brain(con, agent, config):
    """(LlmEngine class, settings) the coach thinks on, or None for the
    app's Grok text model: the named setup's text chat brain, else the
    brain this companion's own text chat runs on."""
    choice = (agent['coach_setup'] or '').strip()
    setup = voice_setups.get(con, choice) if choice else None
    return setup.text_brain if setup else voice_setups.text_brain_for(con, agent, config)


def tools_json(value):
    """The agents.coach_tools column: a JSON list out of COACH_TOOLS."""
    picked = _json_list(value)
    return json.dumps([t for t in COACH_TOOLS if t in picked], separators=(',', ':'))


def _lookups(agent, brain):
    """The search tools this companion's coach has, as request entries:
    the ones switched on that its brain's provider runs (X search is
    Grok's own). The provider does the searching inside the one request,
    so the coach still answers once."""
    picked = _json_list(tools_json(agent['coach_tools']))
    if brain is not None and not brain[0].uses_xai_key:
        hosted = set(brain[0].hosted_for(brain[1]))
        picked = [t for t in picked if t in hosted]
    return [{'type': t} for t in picked]


def _ask_coach(agent, config, brain, *, instructions, text, lookups=()):
    """One request to the coach's brain: (reply text, billed ticks)."""
    from . import session_service   # imports this module
    items = [{'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}]
    if brain is not None and not brain[0].uses_xai_key:
        reply, _calls, _usage = session_service._run_brain(
            brain, config, instructions=instructions, items=items, tools=list(lookups),
            conversation_key=f'rexclaw-coach:{agent["id"]}')
        return reply, 0
    # An xAI brain: the setup's own model and effort - not the companion's
    # effort, which is set for the text model and which the setup's model
    # may not take - else the text chat's model at the companion's effort.
    settings = brain[1] if brain is not None else {}
    effort = settings.get('reasoning_effort') if brain is not None else agent['reasoning_effort']
    body = xai_client.create_response(
        xai_api_key=config['xai_api_key'],
        responses_url=config['xai_responses_url'],
        model=settings.get('model') or config['text_model'] or config['summary_model'],
        input_items=items,
        instructions=instructions,
        tools=list(lookups) or None,
        reasoning_effort=effort or None,
        store=False,
        timeout=_COACH_TIMEOUT,
        # Streamed when it can search, so the search watchdog applies
        # (Settings' limit for a text reply; 0 = none).
        stream=bool(lookups),
        max_search_calls=(config['text_max_searches'] or None) if lookups else None,
    )
    usage = (body.get('usage') if isinstance(body, dict) else None) or {}
    return xai_client._extract_response_text(body) or '', store.extract_cost_ticks(usage)


def review(con, session, replies=1, tools=()):
    """Read the call as it stands and return {'note': text | None}. The
    browser calls this once a reply has finished, with the rows saved:
    `replies` is how many replies finished since its last review, `tools`
    the tools the companion called in them."""
    from . import session_service   # imports this module
    empty = {'note': None}
    if session['state'] != 'active' or session['mode'] != 'voice':
        return empty
    agent = store.get_agent(con, session['agent_id'])
    rules = active_rules(agent) if agent else []
    if not rules:
        return empty
    config = get_config(con)
    own_name = agent['name'] or ''
    if (agent['coach_setup'] or '').strip() and voice_setups.get(con, agent['coach_setup']) is None:
        # The setup picked as the coach's brain is gone. The conversation
        # is not sent to some other model in its place: the coach stays
        # quiet until a brain is picked again.
        _logger.warning('coach[%s]: its coach brain setup no longer exists - pick one in the '
                        'companion editor', own_name)
        return empty
    stats = tracked_stats(agent, rules)
    tools = [str(t) for t in (tools if isinstance(tools, (list, tuple)) else ())][:50]
    counts = _advance(con, agent['id'], rules, stats, _int(replies, 1, 1000, 1), tools)
    rows = store.session_messages(con, session['id'], where='AND is_summarized_into IS NULL')
    if not _window(rows, own_name):
        return empty
    fired, counts, read = _judge(con, config, agent, rules, stats, counts, rows)
    names = [r['name'] or 'Rule' for r in fired]
    # A rule that fires has had its turn, whatever comes of it, and waits a
    # freshly drawn length next time (_since).
    _reset(con, agent['id'], [f'rule:{r["id"]}' for r in fired])
    for r in fired:
        con.execute('DELETE FROM coach_counters WHERE agent_id = ? AND key = ?',
                    (agent['id'], f'wait:{r["id"]}'))
    con.commit()
    if not fired:
        _logger.info('coach[%s]: nothing fired %s', own_name, read)
        return empty
    look_at = '\n'.join(f'- {r["name"] or "Rule"}: {r["advice"].strip()}' for r in fired)
    count_lines = _count_lines(counts, stats)
    text = (
        '## The conversation so far\n'
        f'{_conversation_text(rows, own_name)}\n\n'
        + ('## Counts, in replies the companion has given\n' + '\n'.join(count_lines) + '\n\n'
           if count_lines else '')
        + '## What to look at this time\n'
        f'{look_at}'
    )
    brain = _brain(con, agent, config)
    lookups = _lookups(agent, brain)
    instructions = (
        COACH_INSTRUCTIONS
        + ('\n\nYou can search for what you need: when a thought rests on a fact, a name or '
           'something recent, look it up rather than trust memory.' if lookups else '')
        + f'\n\n## The instructions {own_name or "the companion"} runs on\n'
        + session_service.preview_voice_prompt(con, agent)
    )
    try:
        reply, ticks = _ask_coach(agent, config, brain, instructions=instructions, text=text, lookups=lookups)
    except Exception as e:  # noqa: BLE001 - the call goes on without a thought
        _logger.warning('coach[%s]: coach model failed: %s', own_name, e)
        return empty
    try:
        store.accrue_usd_ticks(con, ticks)
        con.commit()
    except Exception:  # noqa: BLE001 - spend accounting never fails a review
        pass
    reply = reply.strip()
    if not reply or reply.strip('."\'` ').upper() == NOTHING:
        _logger.info('coach[%s]: %s fired %s, coach had nothing to add', own_name, names, read)
        return empty
    _logger.info('coach[%s]: %s fired %s, thought sent', own_name, names, read)
    return {'note': f'{_NOTE_HEADER}\n{reply[:_MAX_NOTE]}', 'rules': names}


def delivered(con, session):
    """The browser handed a thought to the companion: "since the coach's
    last thought" starts over. Counted from here and not from the review
    that wrote it, since a thought can still be dropped on the way - the
    call moved on, or ended."""
    _reset(con, session['agent_id'], [NOTE_KEY, SENT_KEY])
    con.commit()


def still_fits(con, session, note):
    """Whether a thought written a few turns ago still belongs in the call:
    {'fits': bool}. Asked only when the user has spoken since the review
    began. Without a decision model it goes in as it is."""
    config = get_config(con)
    note = str(note or '').strip()
    if note.startswith(NOTE_PREFIX):
        # Judged on what the coach wrote, without the header every thought
        # carries.
        note = note.partition('\n')[2].strip()
    if not note or session['state'] != 'active':
        return {'fits': False}
    if not jev.ready(config):
        return {'fits': True}
    agent = store.get_agent(con, session['agent_id'])
    own_name = (agent['name'] if agent else '') or ''
    rows = store.session_messages(con, session['id'], where='AND is_summarized_into IS NULL')
    qs = {'fits': {'type': 'noul', 'instructions':
          'Is what `note` talks about still what `conversation` is on, or still open in it? '
          'A note about something the conversation has since settled or left behind does not fit.'}}
    state = {'companion': own_name, 'conversation': _window(rows, own_name), 'note': note[:_MAX_NOTE]}
    try:
        body = jev.ask(config, state, qs)
        p = (jev.answers(body, qs).get('fits') or {}).get('yes')
        store.accrue_usd_ticks(con, jev.input_ticks(body))
        con.commit()
    except Exception as e:  # noqa: BLE001 - a failed read lets the thought through
        _logger.warning('coach: fit check failed: %s', e)
        return {'fits': True}
    return {'fits': p is None or p >= jev.YES}
