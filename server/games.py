# Copyright 2026 Codemarchant
"""Games: companions play real games through the Neuro API.

The Neuro API (github.com/VedalAI/neuro-sdk, MIT) is the open protocol
Neuro-sama's game integrations speak. A game connects to a WebSocket,
describes what is happening (context), registers what its player can do
(actions, each with a JSON schema) and, when it is waiting on the player,
asks for one of them (actions/force). Rexclaw is the server side of that
protocol, so any game or mod built on it - the official Slay the Spire 2,
Inscryption, Buckshot Roulette and Hollow Knight integrations, the
community SDKs for Rust, JS, Python, Ren'Py, GameMaker... - can be played by
a companion without changing a line of it.

This module is the hub every transport feeds:

- routes/games.py: the Neuro WebSocket at /game and /game/<name>, also on a
  dedicated port many mods expect (8000, Neuro's default; Settings → Games).
- plugins.py: api.connect_game(name, on_action), an in-process game for an
  extension that reaches its game some other way (the game's own API, a
  mod's HTTP port, a screen reader...). Same messages, no socket.

Every game plays with one companion. The mini-games name theirs in the
WebSocket URL (?companion=<id>&offcall=<mode>, picked in the library); a
Neuro mod gets the Games tab's default. That companion gets:

- game_action and game_status, two tools that stay the same for a whole call.
  A card game re-registers its actions every turn and a realtime session's
  tool list can't follow that, so the actions travel as data in the notes;
- [Game: <name>] notes in their live call (voice_service polls
  /api/games/state). Another companion's call never sees the game;
- off a call, per the game's `offcall` mode: nothing ('wait'), or a text
  turn whenever the game waits on a move, says something worth answering,
  or the user types to them in it - in a game chat of its own ('separate')
  or in their latest conversation, the one a call resumes ('latest').

Two vendor-prefixed commands, which the spec reserves for tooling like this,
let a game hold a conversation: the game sends rexclaw/chat {text} (the user
typed to the companion) and receives rexclaw/say {text} (what the companion
said, typed off a call or spoken on one) and rexclaw/thinking {on}. Games
that don't know them ignore them, as the spec has every game do.

A game is known by its name; a newer connection under the same name replaces
the older one (a restarted game reconnects before its old socket times out).
"""
import itertools
import json
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone

_logger = logging.getLogger(__name__)

GAME_ACTION_TOOL_NAME = 'game_action'
GAME_STATUS_TOOL_NAME = 'game_status'
GAME_TOOL_NAMES = {GAME_ACTION_TOOL_NAME, GAME_STATUS_TOOL_NAME}
OFFCALL_MODES = ('wait', 'separate', 'latest')

# The Neuro server's own limit: "If you take too long (currently more than
# about 20 seconds), the server will give up, treat the action as failed"
# (SPECIFICATION.md, action/result). Games are written against it.
ACTION_RESULT_TIMEOUT = 20
# A failed forced move is asked again "a limited number of times"
# (BEST_PRACTICES.md, Action Results); the spec leaves the number open.
FORCE_RETRIES = 3
# A call owns its companion's games while it keeps polling: twice the slow
# poll (voice_service GAMES_POLL_IDLE_MS, 4 s), so one late poll doesn't
# hand a move to an off-call turn mid-call.
ATTACH_SECONDS = 8
# A move the game waits on gets this long to be picked up by a call that is
# starting before an off-call turn takes it.
OFFCALL_GRACE = 2.0
# Off a call, a move the companion's turn didn't make is asked once more,
# then the game waits.
OFFCALL_TRIES = 2
# A move a live call has been told about but not made is mentioned again
# after this long, at most REMINDERS_MAX times. The Neuro docs' answer to a
# player who drifted off ("timeout-then-force"); the values are ours.
REMIND_AFTER = 45
REMINDERS_MAX = 2
# Games register actions in bursts (one register per card in some SDKs); the
# "you can now" note waits for the burst to settle.
ACTIONS_NOTE_DELAY = 1.5
# What a call that opens after the game connected catches up on: the game's
# first context message (where games put their rules) and this many of the
# latest. Without it, a game started before the call was a game without rules.
CATCH_UP_RECENT = 4
# The log a game keeps for game_status and the Games tab.
LOG_MAX = 80
EVENTS_MAX = 300
PRIORITIES = ('low', 'medium', 'high', 'critical')


GAME_ACTION_TOOL = {
    'type': 'function',
    'name': GAME_ACTION_TOOL_NAME,
    'description': (
        "Make a move in a game you are playing: a game the user connected "
        "to Rexclaw, which announces itself with [Game: <name>] notes. The "
        "game decides what you can do. Its actions, what each does and the "
        "data it takes come in those notes (a \"your move\" note lists the "
        "ones the game is waiting on) and in game_status. You are the "
        "player, so speak of the game in first person. The result says "
        "whether the game accepted the move and what changed; what happens "
        "after arrives as more [Game] notes. Only for a game that has "
        "connected: with none, there is nothing to play."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'action': {
                'type': 'string',
                'description': "The action's exact name, as the game gave it.",
            },
            'data': {
                'type': 'object',
                'description': (
                    "The action's data, matching the schema the game gave "
                    "for it (e.g. {\"column\": 4}). Leave it out for an "
                    "action that takes none."
                ),
            },
            'game': {
                'type': 'string',
                'description': "The game's name. Only needed while more than one game is connected.",
            },
        },
        'required': ['action'],
    },
}

GAME_STATUS_TOOL = {
    'type': 'function',
    'name': GAME_STATUS_TOOL_NAME,
    'description': (
        "Look at the games connected right now: what each lets you do "
        "(its actions and the data they take), the move it is waiting on, "
        "if any, and what happened lately. Use it when you have lost track "
        "of a game, or before answering a question about one. Never guess "
        "at a game's state."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'game': {
                'type': 'string',
                'description': "One game's name, to look at only that one.",
            },
        },
    },
}


def build_tools():
    return [GAME_ACTION_TOOL, GAME_STATUS_TOOL]


class _Game:
    """One connected game. Every field is read and written under _lock."""

    def __init__(self, name, send, transport, source, player):
        self.name = name
        self.send = send              # fn(message dict) → bool, thread-safe
        self.close = None             # fn() closing the transport, when it has one
        self.transport = transport    # 'neuro' | 'extension'
        self.source = source          # where it came from, for the Games tab
        self.agent_id, self.agent_name, self.offcall = player
        self.actions = {}             # name → {'name', 'description', 'schema'}
        self.force = None             # the move it waits on, see _on_force
        self.pending = {}             # action id → {'done': Event, 'result': dict}
        self.log = deque(maxlen=LOG_MAX)
        self.since_turn = []          # context for the next off-call turn
        self.chat = []                # what the user typed, for the next off-call turn
        self.wake = False             # something off a call worth a reply arrived
        self.history = []             # context a call opened mid-game catches up on
        self.noted_actions = None     # the action names the last "you can now" note listed
        self.connected_at = time.time()
        self.actions_changed_at = None
        self.turn_busy = False        # an off-call turn is running
        self.alive = True


_lock = threading.RLock()
_games = {}                 # name → _Game
_events = deque(maxlen=EVENTS_MAX)
_event_ids = itertools.count(1)
_cursor = 0
_action_ids = itertools.count(1)
_force_ids = itertools.count(1)
_calls = {}                 # agent id → {'session_id', 'name', 'at'}: the calls that poll
_worker = None


# ---------------------------------------------------------------------------
# Transport side: what a game sends
# ---------------------------------------------------------------------------

def resolve_player(agent_id=None, offcall=None):
    """(agent id, name, off-call mode) a game plays with: the companion it
    asked for when that one has games switched on, else the Games tab's
    default, else the first companion with games on (None, 'Rexclaw' when
    there is none)."""
    from .db import connect as db_connect, get_config
    con = db_connect()
    try:
        config = get_config(con)
        mode = offcall if offcall in OFFCALL_MODES else config['games_offcall_mode']
        mode = mode if mode in OFFCALL_MODES else 'wait'
        row = None
        for pick in (agent_id, config['games_default_agent_id']):
            if pick:
                row = con.execute("SELECT id, name FROM agents WHERE id = ? AND enable_games = 1"
                                  " AND active = 1", (pick,)).fetchone()
                if row:
                    break
        if row is None:
            row = con.execute("SELECT id, name FROM agents WHERE enable_games = 1 AND active = 1"
                              " ORDER BY sequence, id LIMIT 1").fetchone()
    except Exception:
        _logger.exception('games: could not look up the player')
        row, mode = None, 'wait'
    finally:
        con.close()
    return (row['id'], row['name'], mode) if row else (None, 'Rexclaw', mode)


def connect(name, send, *, transport='neuro', source='', agent_id=None, offcall=None):
    """Register a game under `name` and return it. An older connection under
    the same name is closed: the newer one is the game."""
    name = (name or '').strip()[:100] or 'Game'
    player = resolve_player(agent_id, offcall)
    with _lock:
        old = _games.get(name)
        game = _Game(name, send, transport, source, player)
        _games[name] = game
        if old is not None:
            _retire(old, 'replaced by a new connection')
        _log(game, 'link', f'connected ({source})' if source else 'connected')
        _emit(game, 'connected', f"[Game: {name}] The game connected. You are its player.")
    if old is not None and old.close:
        try:
            old.close()
        except Exception:
            _logger.exception('games: closing the replaced %s connection failed', name)
    _ensure_worker()
    _logger.info('game connected: %s (%s), with %s, off a call: %s', name, source or transport,
                 game.agent_name, game.offcall)
    return game


def disconnect(game):
    """The game's transport closed. A replaced connection's teardown is a
    no-op: its successor is the game now."""
    with _lock:
        if _games.get(game.name) is not game:
            return
        del _games[game.name]
        _retire(game, 'the game disconnected')
        _emit(game, 'disconnected', f"[Game: {game.name}] The game disconnected.")
    _logger.info('game disconnected: %s', game.name)


def _retire(game, why):
    game.alive = False
    game.force = None
    for entry in game.pending.values():
        entry['result'] = {'success': False, 'message': why}
        entry['done'].set()
    game.pending.clear()


def handle(game, msg):
    """Apply one Neuro API message from the game. Returns the replies the
    transport sends back (the startup acknowledgement, the re-register
    request); everything else the game is told goes through game.send.
    Unknown commands are ignored, as the spec says."""
    if not isinstance(msg, dict):
        return []
    command = msg.get('command')
    data = msg.get('data') if isinstance(msg.get('data'), dict) else {}
    with _lock:
        if not game.alive:
            return []
        if command == 'startup':
            # "clears all previously registered actions for this game".
            game.actions.clear()
            game.force = None
            game.since_turn.clear()
            game.history.clear()
            _log(game, 'link', 'startup')
            return [
                {'command': 'startup', 'data': {'session': {
                    'sessionId': f'rexclaw-{id(game):x}',
                    'characterId': f'companion-{game.agent_id}' if game.agent_id else 'rexclaw',
                    'displayName': game.agent_name,
                    # Ours, beside the spec's fields: the mini-games key their
                    # saves on the companion.
                    'rexclaw': {'agentId': game.agent_id, 'offcall': game.offcall},
                }}},
                # Proposed in PROPOSALS.md and sent by Randy: a game that
                # was already running when Rexclaw restarted gets its
                # actions back without waiting for its next window.
                {'command': 'actions/reregister_all'},
            ]
        if command == 'context':
            message = str(data.get('message') or '').strip()
            if message:
                silent = bool(data.get('silent'))
                _log(game, 'context', message)
                game.since_turn.append(message)
                del game.since_turn[:-20]
                game.history.append(message)
                del game.history[1:-CATCH_UP_RECENT]   # the first (usually the rules) + the latest
                _emit(game, 'context', f"[Game: {game.name}] {message}", prompt=not silent)
                if not silent and not _call_for(game.agent_id):
                    game.wake = True
        elif command == 'rexclaw/chat':
            text = str(data.get('text') or '').strip()[:1000]
            if text:
                _log(game, 'user', text)
                if _call_for(game.agent_id):
                    _emit(game, 'chat', f'[Game: {game.name}] The user types to you in the game: "{text}"',
                          prompt=True)
                else:
                    game.chat.append(text)
                    game.wake = True
        elif command == 'actions/register':
            added = []
            for action in data.get('actions') or []:
                if not isinstance(action, dict) or not str(action.get('name') or '').strip():
                    continue
                schema = action.get('schema')
                entry = {'name': str(action['name']).strip(),
                         'description': str(action.get('description') or '').strip(),
                         'schema': schema if isinstance(schema, dict) and schema else None}
                game.actions[entry['name']] = entry
                added.append(entry['name'])
            if added:
                _log(game, 'actions', 'registered ' + ', '.join(added))
                game.actions_changed_at = time.time()
        elif command == 'actions/unregister':
            names = [str(n) for n in data.get('action_names') or [] if n in game.actions]
            for n in names:
                del game.actions[n]
            if names:
                _log(game, 'actions', 'unregistered ' + ', '.join(names))
                game.actions_changed_at = time.time()
                # "If you have an upcoming actions force, you should cancel
                # it when the disposable actions are unregistered. [...]
                # Neuro will ignore the force."
                if game.force and not any(n in game.actions for n in game.force['action_names']):
                    _log(game, 'force', 'withdrawn by the game')
                    game.force = None
        elif command == 'actions/force':
            _on_force(game, data)
        elif command == 'action/result':
            entry = game.pending.pop(str(data.get('id') or ''), None)
            if entry is not None:
                entry['result'] = {'success': bool(data.get('success')),
                                   'message': str(data.get('message') or '').strip()}
                entry['done'].set()
        elif command == 'shutdown/ready':
            _log(game, 'link', 'ready to shut down')
    return []


def _on_force(game, data):
    names = [str(n) for n in data.get('action_names') or [] if str(n) in game.actions]
    if not names:
        return
    priority = data.get('priority') if data.get('priority') in PRIORITIES else 'low'
    game.force = {
        'id': next(_force_ids),
        'query': str(data.get('query') or '').strip(),
        'state': str(data.get('state') or '').strip(),
        'ephemeral': bool(data.get('ephemeral_context')),
        'priority': priority,
        'action_names': names,
        'at': time.time(),
        'prompted_at': time.time(),
        'reminders': 0,
        'retries': 0,
        'offcall_tries': 0,
    }
    # The force lists its actions itself; no separate "you can now" note.
    game.actions_changed_at = None
    game.noted_actions = frozenset(game.actions)
    _log(game, 'force', game.force['query'] or 'waiting on a move')
    # rexclaw_after_user (our games' kit, not Neuro's spec): the user's own
    # move set this force off, so a call times it for rapid play. Only the
    # first emit carries it; reminders and retries answer nothing.
    _emit(game, 'force', _force_text(game), prompt=True, priority=priority,
          after_user=bool(data.get('rexclaw_after_user')))


# ---------------------------------------------------------------------------
# Companion side: the tools
# ---------------------------------------------------------------------------

def connected(agent_id=None):
    """Whether a game is connected (for that companion)."""
    with _lock:
        return any(agent_id is None or g.agent_id == agent_id for g in _games.values())


def _theirs(agent_id):
    return [g for g in _games.values() if agent_id is None or g.agent_id == agent_id]


def _pick(game_name, action=None, agent_id=None):
    """(game, error) for the tools' optional `game` argument, among the
    games this companion plays. Left out with several connected, the game is
    the one the action belongs to: the one waiting on it, else the only one
    that has it. A voice model that drops the argument is the usual case,
    not the exception."""
    games = _theirs(agent_id)
    want = (game_name or '').strip().lower()
    if want:
        for game in games:
            if game.name.lower() == want:
                return game, None
        return None, f'No game called "{game_name}" is connected.{_connected_names(games)}'
    if len(games) == 1:
        return games[0], None
    if not games:
        return None, 'No game is connected right now, so there is nothing to play.'
    if action:
        for candidates in ([g for g in games if g.force and action in g.force['action_names']],
                           [g for g in games if action in g.actions]):
            if len(candidates) == 1:
                return candidates[0], None
    return None, f'More than one game is connected; say which.{_connected_names(games)}'


def _connected_names(games):
    return (' Connected: ' + ', '.join(g.name for g in games) + '.') if games else ''


def act(game_name, action, data, *, agent_id=None, retry_on_failure=False):
    """Perform one of a game's actions and wait for its verdict. Returns the
    tool result. retry_on_failure: the caller won't speak about the result
    (a voice call that ended its turn on the call), so a refused forced
    move is asked again as a note instead."""
    action = (action or '').strip()
    with _lock:
        game, error = _pick(game_name, action, agent_id)
        if error:
            return {'ok': False, 'error': error}
        spec = game.actions.get(action)
        if spec is None:
            return {'ok': False, 'error': f'{game.name} has no action "{action}" right now.',
                    'actions': _actions_brief(game)}
        if game.pending:
            return {'ok': False, 'error': f'{game.name} is still answering your last move; wait for it.'}
        data, problem = _check_data(spec['schema'], data)
        if problem:
            return {'ok': False, 'error': f'{action}: {problem}', 'schema': spec['schema']}
        action_id = str(next(_action_ids))
        # The force this move answers. A game may send its next force before
        # the result of this move (a hit that leaves the hand open), and the
        # result must not settle that new one.
        force_id = game.force['id'] if game.force else None
        entry = {'done': threading.Event(), 'result': None}
        game.pending[action_id] = entry
        payload = {'id': action_id, 'name': action}
        if data is not None:
            payload['data'] = json.dumps(data, ensure_ascii=False)
        _log(game, 'move', f'{action} {payload.get("data", "")}'.strip())
    if not game.send({'command': 'action', 'data': payload}):
        with _lock:
            game.pending.pop(action_id, None)
        return {'ok': False, 'error': f'Could not reach {game.name} (the connection just dropped).'}
    if not entry['done'].wait(ACTION_RESULT_TIMEOUT):
        with _lock:
            game.pending.pop(action_id, None)
            _log(game, 'result', f'{action}: no answer in {ACTION_RESULT_TIMEOUT} s')
        return {'ok': False, 'error': f'{game.name} did not answer within {ACTION_RESULT_TIMEOUT} seconds.'}
    result = entry['result']
    with _lock:
        _log(game, 'result', f'{action}: {"ok" if result["success"] else "refused"}'
                             + (f' - {result["message"]}' if result['message'] else ''))
        force = game.force
        forced = (force is not None and force['id'] == force_id
                  and action in force['action_names'])
        if forced and result['success']:
            game.force = None
        elif forced:
            force['retries'] += 1
            if retry_on_failure and force['retries'] <= FORCE_RETRIES:
                force['prompted_at'] = time.time()
                _emit(game, 'force', _force_text(game, refused=result['message']), prompt=True,
                      priority=force['priority'])
    out = {'ok': result['success'], 'game': game.name, 'action': action}
    if result['message']:
        out['message' if result['success'] else 'error'] = result['message']
    elif not result['success']:
        out['error'] = 'The game refused the move without saying why.'
    if not result['success'] and forced:
        out['note'] = 'The game is still waiting on your move - pick a valid one.'
    return out


def status(game_name=None, agent_id=None):
    with _lock:
        if game_name:
            game, error = _pick(game_name, agent_id=agent_id)
            if error:
                return {'connected': connected(agent_id), 'error': error}
            games = [game]
        else:
            games = _theirs(agent_id)
        if not games:
            return {'connected': False, 'note': 'No game is connected right now.'}
        out = []
        for game in games:
            entry = {
                'game': game.name,
                'actions': [{k: v for k, v in a.items() if v} for a in game.actions.values()],
                'recent': [f'{e["kind"]}: {e["text"]}' for e in list(game.log)[-12:]
                           if e['kind'] in ('context', 'move', 'result', 'user')],
            }
            if game.force:
                entry['your_move'] = {k: game.force[k] for k in ('query', 'state', 'action_names')
                                      if game.force[k]}
            out.append(entry)
        return {'connected': True, 'games': out}


def execute_tool(con, session, agent, name, arguments, surface):
    if not agent['enable_games']:
        return {'error': 'Playing games is switched off for this companion.'}
    arguments = arguments or {}
    if name == GAME_STATUS_TOOL_NAME:
        return status(arguments.get('game'), agent['id'])
    data = arguments.get('data')
    if isinstance(data, str):
        # Some models send the object as JSON text, as Neuro herself does.
        try:
            data = json.loads(data) if data.strip() else None
        except ValueError:
            return {'ok': False, 'error': 'data must be a JSON object.'}
    if data is not None and not isinstance(data, dict):
        return {'ok': False, 'error': 'data must be an object.'}
    # The game can take a while to answer. The text loop calls this inside
    # the transaction that persisted the tool_call row, so commit first, or
    # SQLite holds the write lock while we wait (see voicemail_tools).
    con.commit()
    return act(arguments.get('game'), arguments.get('action'), data, agent_id=agent['id'],
               retry_on_failure=surface == 'voice' and bool(arguments.get('end_turn')))


# Voice models write numbers as words as often as digits ("square five",
# "power seventy-two").
_UNITS = {w: i for i, w in enumerate(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
    'sixteen seventeen eighteen nineteen'.split())}
_TENS = {w: (i + 2) * 10 for i, w in enumerate('twenty thirty forty fifty sixty seventy eighty ninety'.split())}


def _words_to_int(text):
    """"seventy-two" → 72, "a hundred and five" → 105; None if it isn't one."""
    total, seen = 0, False
    for part in text.replace('-', ' ').split():
        if part in _UNITS:
            total += _UNITS[part]
        elif part in _TENS:
            total += _TENS[part]
        elif part == 'hundred':
            total = (total or 1) * 100
        elif part in ('and', 'a'):
            continue
        else:
            return None
        seen = True
    return total if seen else None


class _NumberWords(dict):
    """The number words, any of them: `in` and [] parse on the fly."""
    def __contains__(self, text):
        return _words_to_int(text) is not None

    def __getitem__(self, text):
        return _words_to_int(text)


_NUMBER_WORDS = _NumberWords()


def _check_data(schema, data):
    """(data, problem): a light check of the model's data against the
    action's schema, catching the usual slips (a missing field, a value off
    the enum, "4" for 4) before a round trip. The game validates for real."""
    if not schema:
        return (data or None), None
    data = dict(data or {})
    props = schema.get('properties') if isinstance(schema.get('properties'), dict) else {}
    missing = [k for k in schema.get('required') or [] if k not in data]
    if missing:
        return data, 'missing ' + ', '.join(missing)
    for key, value in list(data.items()):
        spec = props.get(key)
        if not isinstance(spec, dict):
            continue
        kind = spec.get('type')
        if isinstance(value, str):
            text = value.strip().lower()
            # "threes", "sixes", "4s": a dice face named in the plural
            singular = next((t for t in (text, text[:-1], text[:-2])
                             if t in _NUMBER_WORDS or t.lstrip('-').isdigit()), text)
            try:
                if kind == 'integer' and singular in _NUMBER_WORDS:
                    data[key] = value = _NUMBER_WORDS[singular]
                elif kind == 'integer' and singular.lstrip('-').isdigit():
                    data[key] = value = int(singular)
                elif kind == 'number':
                    data[key] = value = float(text)
                elif kind == 'boolean' and text in ('true', 'false'):
                    data[key] = value = text == 'true'
            except ValueError:
                pass
        enum = spec.get('enum')
        if isinstance(enum, list) and isinstance(value, str) and value not in enum:
            # "Rock" for "rock", "Chain" for "chain shot": the game's own
            # spelling wins, when only one choice fits.
            want = value.strip().lower().removeprefix('the ').removeprefix('a ')
            folded = {e.lower(): e for e in enum if isinstance(e, str)}
            if want in folded:
                data[key] = value = folded[want]
            else:
                partial = [e for low, e in folded.items() if want and (low.startswith(want) or want in low.split())]
                if len(partial) == 1:
                    data[key] = value = partial[0]
        if isinstance(enum, list) and value not in enum:
            return data, f'{key} must be one of {json.dumps(enum, ensure_ascii=False)}'
    return data, None


# ---------------------------------------------------------------------------
# Notes for a live call
# ---------------------------------------------------------------------------

def _emit(game, kind, text, *, prompt=False, priority='low', after_user=False):
    global _cursor
    event_id = next(_event_ids)
    _cursor = event_id
    _events.append({'id': event_id, 'game': game.name, 'agent_id': game.agent_id, 'kind': kind,
                    'text': text, 'prompt': prompt, 'priority': priority, 'after_user': after_user})


def _log(game, kind, text):
    game.log.append({'at': time.time(), 'kind': kind, 'text': text[:2000]})


def _schema_text(schema):
    return json.dumps(schema, ensure_ascii=False, separators=(',', ':')) if schema else 'no data'


def _actions_brief(game):
    return [f'{a["name"]}: {a["description"]}' if a['description'] else a['name']
            for a in game.actions.values()]


def _force_text(game, refused=None):
    force = game.force
    lines = [f"[Game: {game.name} - your move]"]
    if refused is not None:
        lines.append(f"That move was refused: {refused or 'no reason given'}")
    if force['state']:
        lines.append(force['state'])
    if force['query']:
        lines.append(force['query'])
    lines.append("Answer with game_action, using one of these actions:")
    for name in force['action_names']:
        a = game.actions.get(name)
        if a:
            desc = f" - {a['description']}" if a['description'] else ''
            lines.append(f"- {name}{desc} (data: {_schema_text(a['schema'])})")
    return '\n'.join(lines)


def _actions_text(game):
    if not game.actions:
        return f"[Game: {game.name}] You have no actions right now."
    return (f"[Game: {game.name}] What you can do now (game_status has the details): "
            + '; '.join(_actions_brief(game)))


def _call_for(agent_id):
    """The call of `agent_id` that is polling now, or None."""
    call = _calls.get(agent_id) if agent_id else None
    return call if call and time.time() - call['at'] < ATTACH_SECONDS else None


def on_call(agent_id):
    """Whether the companion is in a live call that follows its games."""
    with _lock:
        return bool(_call_for(agent_id))


def snapshot(cursor=None, *, session_id=None, agent=None):
    """The poll of a live call: the notes of the games this companion plays.
    With no cursor (the call's first poll) it returns where each of them
    stands - not the backlog - including a move still owed, so a call opened
    mid-game picks it up. While the call keeps polling it owns those games:
    their moves and messages come here, not to an off-call turn."""
    with _lock:
        mine = [g for g in _games.values() if g.agent_id == agent['id']]
        _calls[agent['id']] = {'session_id': session_id, 'name': agent['name'], 'at': time.time()}
        # A cursor past ours is from before a server restart (the ids
        # started over): treat it as the call's first poll.
        if cursor is None or cursor > _cursor:
            events = []
            for game in mine:
                intro = f"[Game: {game.name}] This game is connected. You are its player."
                if game.history:
                    intro += '\nSo far:\n' + '\n'.join(f'- {m}' for m in game.history)
                events.append({'game': game.name, 'kind': 'connected', 'prompt': False, 'priority': 'low',
                               'text': intro})
                if game.force:
                    game.force['prompted_at'] = time.time()
                    events.append({'game': game.name, 'kind': 'force', 'prompt': True,
                                   'priority': game.force['priority'], 'text': _force_text(game)})
                elif game.actions:
                    events.append({'game': game.name, 'kind': 'actions', 'prompt': False,
                                   'priority': 'low', 'text': _actions_text(game)})
        else:
            events = [e for e in _events if e['id'] > cursor and e['agent_id'] == agent['id']]
        return {'connected': bool(mine), 'cursor': _cursor, 'events': events,
                'games': sorted(g.name for g in mine)}


def companion_spoke(agent_id, text):
    """The companion of a call finished a reply: its games show the words
    (rexclaw/say) and, like Neuro's, hear that the speech ended."""
    with _lock:
        targets = [g for g in _games.values() if g.agent_id == agent_id]
    for game in targets:
        if text:
            game.send({'command': 'rexclaw/say', 'data': {'text': text[:2000]}})
        game.send({'command': 'speech_finished', 'data': {'isFinal': True}})


def overview():
    """Everything the Games tab shows, live."""
    with _lock:
        return {'games': [{
            'name': g.name,
            'transport': g.transport,
            'source': g.source,
            'agent_name': g.agent_name,
            'offcall': g.offcall,
            'on_call': bool(_call_for(g.agent_id)),
            'connected_for': int(time.time() - g.connected_at),
            'actions': list(g.actions.values()),
            'force': g.force and {k: g.force[k] for k in ('query', 'state', 'action_names', 'priority')},
            'waiting_result': bool(g.pending),
            'turn_busy': g.turn_busy,
            'log': [{'at': e['at'], 'kind': e['kind'], 'text': e['text']} for e in list(g.log)[-40:]],
        } for g in _games.values()]}


# ---------------------------------------------------------------------------
# Background: settled action notes, reminders, off-call turns
# ---------------------------------------------------------------------------

def _ensure_worker():
    global _worker
    with _lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_loop, name='games', daemon=True)
        _worker.start()


def _loop():
    while True:
        time.sleep(0.5)
        try:
            if not _tick():
                return      # nothing connected: the next connect restarts the loop
        except Exception:
            _logger.exception('games: background tick failed')


def _tick():
    global _worker
    now = time.time()
    turns = []
    with _lock:
        if not _games:
            _worker = None
            return False
        for game in _games.values():
            if game.actions_changed_at and now - game.actions_changed_at >= ACTIONS_NOTE_DELAY:
                game.actions_changed_at = None
                # Games unregister and re-register the same actions (that is
                # how a force is withdrawn); only a different set is news.
                names = frozenset(game.actions)
                if names != game.noted_actions:
                    game.noted_actions = names
                    _emit(game, 'actions', _actions_text(game))
            force = game.force
            if _call_for(game.agent_id):
                if (force and not game.pending and now - force['prompted_at'] >= REMIND_AFTER
                        and force['reminders'] < REMINDERS_MAX):
                    force['reminders'] += 1
                    force['prompted_at'] = now
                    _emit(game, 'force', "(Still waiting on you.)\n" + _force_text(game), prompt=True,
                          priority=force['priority'])
                continue
            if game.offcall == 'wait' or not game.agent_id or game.turn_busy or game.pending:
                continue
            move_due = (force is not None and force['offcall_tries'] < OFFCALL_TRIES
                        and now - force['at'] >= OFFCALL_GRACE)
            if move_due or game.wake:
                if move_due:
                    force['offcall_tries'] += 1
                game.wake = False
                game.turn_busy = True
                turns.append(game)
    for game in turns:
        threading.Thread(target=_offcall_turn, args=(game,), name=f'games-turn-{game.name}',
                         daemon=True).start()
    return True


def _game_chat_session(con, agent, game_name):
    """The companion's own text session for this game ('Game: <name>'),
    reused turn after turn so it remembers the game. Heartbeat origin: a
    background conversation, kept out of 'continue the latest chat'."""
    from . import heartbeat, store
    from .db import utcnow
    title = f'Game: {game_name}'
    row = con.execute(
        "SELECT * FROM sessions WHERE agent_id = ? AND origin = 'heartbeat' AND name = ?"
        " AND mode = 'text' ORDER BY id DESC LIMIT 1", (agent['id'], title)).fetchone()
    if row:
        return heartbeat.resume_for_text(con, row, datetime.now(timezone.utc).replace(tzinfo=None))
    session = store.create_session(con, agent_id=agent['id'], mode='text', origin='heartbeat')
    store.update_session(con, session['id'], name=title, title_generated=1, state='active',
                         started_at=utcnow(), last_active_at=utcnow())
    return store.get_session(con, session['id'])


def _latest_session(con, agent):
    """The conversation a call's "Resume last" continues, ready for a text
    turn; a new one when the companion has none yet."""
    from . import heartbeat, store
    from .db import utcnow
    row = heartbeat.latest_manual_session(con, agent['id'])
    if row:
        return heartbeat.resume_for_text(con, row, datetime.now(timezone.utc).replace(tzinfo=None))
    session = store.create_session(con, agent_id=agent['id'], mode='text')
    store.update_session(con, session['id'], state='active', started_at=utcnow(), last_active_at=utcnow())
    return store.get_session(con, session['id'])


def _offcall_turn(game):
    """One headless text turn for a game whose companion isn't on a call:
    what happened since the last turn, what the user typed, and the move the
    game waits on, if any. The reply goes back to the game (rexclaw/say) as
    a speech bubble; a move is made with game_action as on a call."""
    from . import session_service as svc, store
    from .db import connect as db_connect, utcnow
    con = db_connect()
    try:
        agent = store.get_agent(con, game.agent_id)
        with _lock:
            if not game.alive:
                return
            force = game.force
            again = bool(force and force['offcall_tries'] > 1)
            events, chat = list(game.since_turn), list(game.chat)
            game.since_turn.clear()
            game.chat.clear()
            lines = [f"[Game: {game.name}] You're playing {game.name} with the user, who isn't on a call: "
                     "what you write shows as a speech bubble in the game, so keep it to a line or two."]
            if events:
                lines.append('What happened in the game:\n' + '\n'.join(f'- {m}' for m in events[-12:]))
            if force:
                lines.append(_force_text(game))
                lines.append(("You haven't made your move yet. " if again else '')
                             + 'Make your move with game_action.')
            for text in chat:
                lines.append(f'The user types to you in the game: "{text}"')
            prompt = '\n\n'.join(lines)
            _log(game, 'turn', f'{agent["name"]} is answering'
                               + (' and taking the move' if force else ''))
        game.send({'command': 'rexclaw/thinking', 'data': {'on': True}})
        session = _latest_session(con, agent) if game.offcall == 'latest' else \
            _game_chat_session(con, agent, game.name)
        con.commit()
        if session['needs_summary']:
            try:
                svc.text_compact(con, session)
                session = store.get_session(con, session['id'])
            except Exception:
                _logger.exception('games: compaction of session %s failed', session['id'])
        turn = svc.text_send_turn(con, session=session, user_text=prompt, headless=True)
        store.update_session(con, session['id'], last_active_at=utcnow())
        con.commit()
        said = (turn.get('assistant_text') or '').strip()
        with _lock:
            if said:
                _log(game, 'companion', f'{agent["name"]}: {said[:600]}')
            if turn.get('type') == 'error':
                _log(game, 'turn', 'failed: ' + str(turn.get('message') or ''))
            if (force and game.force and game.force['id'] == force['id']
                    and game.force['offcall_tries'] >= OFFCALL_TRIES):
                _log(game, 'turn', 'no move made - the game waits for you')
        game.send({'command': 'rexclaw/say', 'data': {'text': said[:2000]}} if said
                  else {'command': 'rexclaw/thinking', 'data': {'on': False}})
    except Exception as e:
        _logger.exception('games: off-call turn for %s failed', game.name)
        with _lock:
            _log(game, 'turn', f'failed: {e}')
        game.send({'command': 'rexclaw/thinking', 'data': {'on': False}})
    finally:
        con.close()
        with _lock:
            game.turn_busy = False


# ---------------------------------------------------------------------------
# The mini-games library
# ---------------------------------------------------------------------------

def read_manifests(folder, url_base, extension=None):
    """The mini-games in `folder`: one sub-folder per game, each described by
    its game.json (title, description, tags, cover, background, entry,
    order, save_key; see web/public/games/README.md), served under
    `url_base`/<sub-folder>/. A folder can hold a game as big as it likes -
    scripts, models, sounds - since only the manifest is read here."""
    out = []
    try:
        subs = sorted(p for p in folder.iterdir() if (p / 'game.json').is_file())
    except OSError:
        return out
    for sub in subs:
        try:
            m = json.loads((sub / 'game.json').read_text(encoding='utf-8'))
        except (OSError, ValueError) as e:
            _logger.warning('games: bad manifest %s: %s', sub / 'game.json', e)
            continue
        if not isinstance(m, dict) or not str(m.get('title') or '').strip():
            continue
        base = f'{url_base}/{sub.name}'
        out.append({
            'id': sub.name,
            'title': str(m['title']),
            'description': str(m.get('description') or ''),
            'tags': [str(t) for t in m.get('tags') or []][:8],
            'url': f"{base}/{m.get('entry') or 'index.html'}",
            'cover': f"{base}/{m['cover']}" if m.get('cover') else None,
            'icon': str(m.get('icon') or '') or None,
            'background': str(m.get('background') or '') or None,
            # The name the page plays under (RexGame.create), which its save
            # is filed under; the title unless the manifest says otherwise.
            'save_key': str(m.get('save_key') or m['title']),
            'order': m.get('order') if isinstance(m.get('order'), (int, float)) else 100,
            'extension': extension,
        })
    return out


# ---------------------------------------------------------------------------
# In-process games (extensions)
# ---------------------------------------------------------------------------

class GameClient:
    """An extension's game: the Neuro API's game-side messages as methods,
    without a socket. Made by PluginAPI.connect_game; see plugins.py."""

    def __init__(self, name, on_action, owner, companion=None, offcall=None, on_say=None):
        self._on_action = on_action
        self._on_say = on_say
        self._game = connect(name, self._deliver, transport='extension', source=f'extension {owner}',
                             agent_id=companion, offcall=offcall)
        handle(self._game, {'command': 'startup'})

    @property
    def name(self):
        return self._game.name

    @property
    def companion(self):
        """(agent id, name) the game plays with."""
        return self._game.agent_id, self._game.agent_name

    def context(self, message, silent=False):
        handle(self._game, {'command': 'context', 'data': {'message': message, 'silent': silent}})

    def register(self, actions):
        handle(self._game, {'command': 'actions/register', 'data': {'actions': actions}})

    def unregister(self, names):
        handle(self._game, {'command': 'actions/unregister', 'data': {'action_names': list(names)}})

    def force(self, query, action_names, state=None, ephemeral_context=False, priority='low'):
        handle(self._game, {'command': 'actions/force', 'data': {
            'query': query, 'state': state, 'action_names': list(action_names),
            'ephemeral_context': ephemeral_context, 'priority': priority}})

    def chat(self, text):
        """The user typed `text` to the companion in the game."""
        handle(self._game, {'command': 'rexclaw/chat', 'data': {'text': text}})

    def close(self):
        disconnect(self._game)

    def _deliver(self, message):
        command = message.get('command')
        if command == 'rexclaw/say' and self._on_say:
            try:
                self._on_say(message['data']['text'])
            except Exception:
                _logger.exception('games: %s on_say failed', self._game.name)
        if command != 'action':
            return True
        data = message['data']
        threading.Thread(target=self._run_action, args=(data,), daemon=True,
                         name=f'game-action-{self._game.name}').start()
        return True

    def _run_action(self, data):
        try:
            args = json.loads(data['data']) if data.get('data') else None
            answer = self._on_action(data['name'], args)
            success, message = (answer if isinstance(answer, tuple)
                                else (True, answer if isinstance(answer, str) else ''))
        except Exception as e:
            _logger.exception('games: %s action %s failed', self._game.name, data.get('name'))
            success, message = False, str(e) or type(e).__name__
        handle(self._game, {'command': 'action/result', 'data': {
            'id': data['id'], 'success': bool(success), 'message': message or ''}})
