"""Games over the Neuro API: the WebSocket games connect to, the dedicated
port many Neuro mods expect, and the polls behind live calls and the Games
tab. The hub itself is server/games.py."""
import asyncio
import json
import logging
import os
import socket
import threading
from pathlib import Path

from fastapi import APIRouter, Body, Depends, WebSocket, WebSocketDisconnect

from .. import game_voice, games, plugins, store
from ..db import utcnow
from ..errors import UserError
from .common import db_con, resolve_session

_logger = logging.getLogger(__name__)

router = APIRouter()


async def serve(ws, name=None):
    """One game's connection, speaking the Neuro API. `name` comes from a
    /game/<name> URL; otherwise the game's first message names it (every
    game message carries `game`). Text frames only: binary frames belong
    to the voice side-channel, which Rexclaw doesn't offer."""
    # Like REXCLAW_MC_TOKEN: when the server is reachable beyond this
    # computer (Docker, LAN), a token keeps strangers from playing. Neuro
    # games keep the query string of the URL they are given, so the token
    # rides in it: ws://host:8990/game?token=<secret>.
    token = os.environ.get('REXCLAW_GAMES_TOKEN', '')
    if token and ws.query_params.get('token') != token:
        await ws.close(code=4401)
        _logger.warning('game connection rejected (bad or missing token)')
        return
    await ws.accept()
    loop = asyncio.get_running_loop()
    client = ws.client
    source = f'{client.host}:{client.port}' if client else 'websocket'
    # Who the game plays with, when its URL says (the mini-games carry the
    # library's pick); a Neuro mod's plain URL gets the Games tab's default.
    try:
        companion = int(ws.query_params.get('companion') or 0) or None
    except ValueError:
        companion = None
    offcall = ws.query_params.get('offcall')
    game = None

    def send(message):
        # From tool threads: wait for the write so a dead socket is reported
        # to the companion instead of a move that never left.
        try:
            asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(message)), loop).result(timeout=2)
            return True
        except Exception:
            _logger.warning('games: send to %s failed', game.name if game else source)
            return False

    def close():
        asyncio.run_coroutine_threadsafe(ws.close(), loop)

    try:
        while True:
            frame = await ws.receive()
            if frame['type'] == 'websocket.disconnect':
                break
            raw = frame.get('text')
            if raw is None:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            game_name = name or str(msg.get('game') or '').strip()
            if not game_name:
                continue
            if game is None or game.name != game_name[:100]:
                if game is not None:
                    games.disconnect(game)
                game = games.connect(game_name, send, transport='neuro', source=source,
                                     agent_id=companion, offcall=offcall)
                game.close = close
            for reply in games.handle(game, msg):
                await ws.send_text(json.dumps(reply))
    except WebSocketDisconnect:
        pass
    finally:
        if game is not None:
            games.disconnect(game)


async def serve_voice(ws):
    """The optional voice chat side-channel (VOICE_CHAT.md). Not offered:
    answer its handshake with voice/unavailable, which the official SDKs
    take as "carry on without voice"."""
    await ws.accept()
    try:
        while True:
            frame = await ws.receive()
            if frame['type'] == 'websocket.disconnect':
                return
            if frame.get('text') and '"voice/start"' in frame['text']:
                await ws.send_text(json.dumps({'command': 'voice/unavailable',
                                               'data': {'reason': 'Rexclaw has no game voice chat.'}}))
                await ws.close()
                return
    except WebSocketDisconnect:
        pass


@router.websocket('/game')
async def game_ws(ws: WebSocket):
    await serve(ws)


@router.websocket('/game/{name}')
async def game_named_ws(ws: WebSocket, name: str):
    await serve(ws, name)


@router.websocket('/game/{name}/voice')
async def game_voice_ws(ws: WebSocket, name: str):
    await serve_voice(ws)


@router.post('/api/games/state')
def games_state(payload: dict = Body(default={}), con=Depends(db_con)):
    """A live call's poll (voice_service._pumpGameEvents). cursor null = the
    call's first poll: where every game stands, not the backlog. A call whose
    companion has games switched off is told so once (eligible=False) and
    stops asking."""
    cursor = payload.get('cursor')
    agent = None
    session_id = payload.get('session_id')
    if session_id:
        try:
            session = resolve_session(con, int(session_id))
            agent = store.get_agent(con, session['agent_id'])
        except Exception:
            agent = None
    if agent is None or not agent['enable_games']:
        return {'eligible': False, 'connected': False, 'events': [], 'cursor': None}
    snap = games.snapshot(cursor if isinstance(cursor, int) else None,
                          session_id=int(session_id), agent=agent)
    snap['eligible'] = True
    return snap


@router.post('/api/games/speech')
def games_speech(payload: dict = Body(default={}), con=Depends(db_con)):
    """The call's companion finished a reply: its games show the words and
    hear Neuro's speech_finished."""
    try:
        session = resolve_session(con, int(payload.get('session_id')))
    except Exception:
        return {'ok': False}
    games.companion_spoke(session['agent_id'], str(payload.get('text') or '').strip())
    return {'ok': True}


@router.post('/api/games/players')
def games_players(payload: dict = Body(default={}), con=Depends(db_con)):
    """The companions games can play with (Games switched on), for the
    library's picker, and the defaults for a game that names none."""
    from ..db import get_config
    from ..session_service import _agent_thumbnail_url
    config = get_config(con)
    rows = con.execute("SELECT * FROM agents WHERE enable_games = 1 AND active = 1 ORDER BY sequence, id")
    return {
        'players': [{'id': r['id'], 'name': r['name'], 'picture': _agent_thumbnail_url(con, r)} for r in rows],
        'default_agent_id': config['games_default_agent_id'],
        'offcall_mode': config['games_offcall_mode'],
    }


# ---------------------------------------------------------------------------
# Saves: one JSON blob per game per companion, written by the game page
# ---------------------------------------------------------------------------

SAVE_MAX_BYTES = 64 * 1024


def _save_key(payload):
    game = str(payload.get('game') or '').strip()[:100]
    if not game:
        raise UserError('A save needs the game\'s name.')
    try:
        agent_id = int(payload.get('agent_id') or 0)
    except (TypeError, ValueError):
        agent_id = 0
    return game, agent_id


@router.post('/api/games/save/get')
def games_save_get(payload: dict = Body(default={}), con=Depends(db_con)):
    game, agent_id = _save_key(payload)
    row = con.execute("SELECT data FROM game_saves WHERE game = ? AND agent_id = ?", (game, agent_id)).fetchone()
    try:
        return {'data': json.loads(row['data']) if row else {}}
    except ValueError:
        return {'data': {}}


@router.post('/api/games/save/set')
def games_save_set(payload: dict = Body(default={}), con=Depends(db_con)):
    game, agent_id = _save_key(payload)
    data = payload.get('data')
    if not isinstance(data, dict):
        raise UserError('A save is a JSON object.')
    text = json.dumps(data, ensure_ascii=False)
    if len(text.encode('utf-8')) > SAVE_MAX_BYTES:
        raise UserError(f'A save is limited to {SAVE_MAX_BYTES // 1024} KB.')
    con.execute("INSERT INTO game_saves (game, agent_id, data, updated_at) VALUES (?, ?, ?, ?)"
                " ON CONFLICT (game, agent_id) DO UPDATE SET data = excluded.data,"
                " updated_at = excluded.updated_at", (game, agent_id, text, utcnow()))
    con.commit()
    return {'ok': True}


@router.post('/api/games/voiceline')
def games_voiceline(payload: dict = Body(default={}), con=Depends(db_con)):
    """A mini-game's reaction line in the companion's voice (game_voice.py).
    On a call the companion reacts live, so the game is told to stay quiet
    (on_call). record=False only looks in the cache; True renders a missing
    line (the library's "record voice lines")."""
    try:
        agent = store.get_agent(con, int(payload.get('agent_id') or 0))
    except Exception:
        return {'url': None}
    if games.on_call(agent['id']):
        return {'on_call': True}
    con.commit()   # a render takes seconds; hold no write lock meanwhile
    try:
        return game_voice.line(con, agent, str(payload.get('text') or ''), record=bool(payload.get('record')))
    except UserError as e:
        return {'url': None, 'error': str(e)}
    except Exception as e:
        _logger.exception('game voice line failed')
        return {'url': None, 'error': f'{type(e).__name__}: {e}'}


@router.post('/api/games/voicelines/missing')
def games_voicelines_missing(payload: dict = Body(default={}), con=Depends(db_con)):
    """Which of `texts` the companion has no recording of yet, in their
    current voice: the library shows "N of M recorded" and records only
    those."""
    texts = [str(t) for t in payload.get('texts') or []][:2000]
    try:
        agent = store.get_agent(con, int(payload.get('agent_id') or 0))
        return {'missing': game_voice.missing(con, agent, texts), 'total': len(texts)}
    except Exception as e:
        return {'missing': None, 'total': len(texts), 'error': str(e)}


@router.post('/api/games/leaderboard')
def games_leaderboard(payload: dict = Body(default={}), con=Depends(db_con)):
    """Every companion's standing across the mini-games, from the saves:
    doubloons (points), wins and losses (the user's), best streak, and each
    game's best score."""
    from ..session_service import _agent_thumbnail_url
    rows = {}
    for row in con.execute("SELECT s.game, s.data, a.* FROM game_saves s JOIN agents a ON a.id = s.agent_id"):
        try:
            data = json.loads(row['data'])
        except ValueError:
            continue
        entry = rows.setdefault(row['id'], {
            'id': row['id'], 'name': row['name'], 'picture': _agent_thumbnail_url(con, row),
            'points': 0, 'wins': 0, 'losses': 0, 'draws': 0, 'best_streak': 0, 'games': {}})
        rec = data.get('record') or {}
        entry['points'] += int(data.get('points') or 0)
        for k in ('wins', 'losses', 'draws'):
            entry[k] += int(rec.get(k) or 0)
        entry['best_streak'] = max(entry['best_streak'], int(data.get('bestStreak') or 0))
        entry['games'][row['game']] = {'points': int(data.get('points') or 0), 'best': data.get('best'),
                                       'record': rec}
    return sorted(rows.values(), key=lambda e: (-e['points'], -e['wins']))


@router.post('/api/games/saves')
def games_saves(payload: dict = Body(default={}), con=Depends(db_con)):
    """Every game's save with one companion: the library's records."""
    try:
        agent_id = int(payload.get('agent_id') or 0)
    except (TypeError, ValueError):
        agent_id = 0
    out = {}
    for row in con.execute("SELECT game, data FROM game_saves WHERE agent_id = ?", (agent_id,)):
        try:
            out[row['game']] = json.loads(row['data'])
        except ValueError:
            pass
    return out


# The built-in games: web/dist/games once built, web/public/games before.
_WEB = Path(__file__).resolve().parents[2] / 'web'


@router.post('/api/games/library')
def games_library(payload: dict = Body(default={})):
    """The mini-games library: every built-in game folder with a game.json,
    then the extensions' (see games.read_manifests)."""
    root = _WEB / 'dist' / 'games'
    builtin = games.read_manifests(root if root.is_dir() else _WEB / 'public' / 'games', '/games')
    extra = plugins.minigames()
    key = lambda g: (g['order'], g['title'].lower())  # noqa: E731
    return sorted(builtin, key=key) + sorted(extra, key=lambda g: (g['extension'] or '', *key(g)))


@router.post('/api/games/overview')
def games_overview(payload: dict = Body(default={})):
    out = games.overview()
    out['listener'] = listener_status()
    return out


# ---------------------------------------------------------------------------
# The dedicated port
# ---------------------------------------------------------------------------
# Neuro mods default to ws://localhost:8000 (Randy, Neuro's test bot, listens
# there) and many ship that address in their config. A second little server
# on that port, this computer only, makes them work untouched. Off unless
# switched on in the Games tab (config.games_neuro_port).

_listener = {'server': None, 'thread': None, 'port': 0, 'error': None}
_listener_lock = threading.Lock()


def _listener_app():
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute

    async def root(ws):
        await serve(ws)

    async def named(ws):
        await serve(ws, ws.path_params['name'])

    async def voice(ws):
        await serve_voice(ws)

    return Starlette(routes=[WebSocketRoute('/', root), WebSocketRoute('/game', root),
                             WebSocketRoute('/game/{name}', named),
                             WebSocketRoute('/game/{name}/voice', voice)])


def apply_listener(port):
    """Start, move or stop the dedicated port to match the setting."""
    import uvicorn
    port = int(port or 0)
    with _listener_lock:
        if _listener['server'] is not None and _listener['port'] == port and _listener['thread'].is_alive():
            return
        _stop_locked()
        _listener['port'] = port
        _listener['error'] = None
        if not port:
            return
        # Bind once first: a port in use is reported in the Games tab rather
        # than as uvicorn's exit inside a thread.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(('127.0.0.1', port))
        except OSError as e:
            _listener['error'] = f'port {port} is in use ({e.strerror or e})'
            _logger.warning('games: cannot listen on %s: %s', port, e)
            return
        config = uvicorn.Config(_listener_app(), host='127.0.0.1', port=port,
                                log_level='warning', lifespan='off')
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, name=f'games-port-{port}', daemon=True)
        _listener.update(server=server, thread=thread)
        thread.start()
        _logger.info('games: Neuro API listening on ws://127.0.0.1:%s', port)


def stop_listener():
    with _listener_lock:
        _stop_locked()


def _stop_locked():
    server, thread = _listener['server'], _listener['thread']
    _listener.update(server=None, thread=None)
    if server is not None:
        server.should_exit = True
        if thread is not None:
            thread.join(timeout=5)


def listener_status():
    with _listener_lock:
        thread = _listener['thread']
        return {'port': _listener['port'], 'running': bool(thread and thread.is_alive()),
                'error': _listener['error']}
