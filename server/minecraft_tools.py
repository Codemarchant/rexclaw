"""Minecraft bot bridge: tool declarations + sidecar link state.

The bot itself is the Node sidecar in minecraft/ (mineflayer + its own
text-model brain). It connects to this server over WebSocket; the voice
companion directs it through the minecraft_command tool and hears about its
life through events the web client polls and injects into the live call.

Tool visibility mirrors local_task's "only when actually usable" rule: the
tools appear in a session only while a sidecar is connected, so companions
never offer to play Minecraft into the void.
"""
import asyncio
import itertools
import json
import logging
import threading
from collections import deque

from .db import get_config

_logger = logging.getLogger(__name__)

MINECRAFT_COMMAND_TOOL_NAME = 'minecraft_command'
MINECRAFT_STATUS_TOOL_NAME = 'minecraft_status'

_EVENTS_MAX = 200

MINECRAFT_COMMAND_TOOL = {
    'type': 'function',
    'name': MINECRAFT_COMMAND_TOOL_NAME,
    'description': (
        "Act inside the user's Minecraft world through your in-game body. "
        "The character in the game IS YOU — not a bot you operate, not a "
        "pet, not a third party. NEVER say \"I'll send the bot\" or refer "
        "to it by name as someone else; say \"on my way\", \"I'll get us "
        "some iron\", \"give me a minute to build it\". Set your goal in "
        "natural language (\"mine iron and bring it to the user\", "
        "\"build a shelter before night\") — your game self plans and "
        "plays it out autonomously over the following minutes. "
        "HOW RESULTS WORK: this call only STARTS the work — its response "
        "tells you nothing about the outcome. The outcome arrives later "
        "as [Minecraft] notes (progress, completion, failures); you must "
        "wait for those to know what happened. Until a completion note "
        "arrives, the task is still running. "
        "CALLING AGAIN REPLACES: there is no queue — a new directive "
        "always drops whatever your game self is doing and starts the "
        "new goal at once. The half-finished work is NOT lost: what was "
        "built stays built, what was gathered stays carried, and your "
        "game self remembers the task, so the user can send you back to "
        "it later and you pick up from where the world actually is. "
        "What IS thrown away is the current train of thought, so "
        "rewording or \"refining\" a goal mid-task costs progress for "
        "nothing: one call per goal, then wait for the notes. "
        "SEQUENCES GO IN THE DIRECTIVE, not in separate calls: for "
        "\"mine some iron then come back to me\", send that as ONE goal "
        "— your game self plays out the whole sequence. Never send the "
        "second half as its own call; it would cancel the first half. "
        "ONE THING AT A TIME: the bot works one goal. Send a directive "
        "ONLY when the user asks for something, then WAIT for its "
        "[Minecraft] notes — never send follow-up refinements, "
        "corrections or rewordings on your own initiative; each one "
        "resets the bot to zero and a burst of them freezes it "
        "completely. Give the goal, not the method: say WHAT you want "
        "(\"escape to the surface\"), never micromanage blocks and "
        "coordinates — the bot plans its own moves and knows the world "
        "better than the transcript does."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'directive': {
                'type': 'string',
                'description': (
                    "The goal, in natural language, including any sequence "
                    "it needs as ONE instruction (\"collect 16 oak logs, "
                    "then find Alex\"). Include the names, counts and "
                    "places the bot needs. This replaces whatever it is "
                    "doing now."
                ),
            },
            'hard_model': {
                'type': 'boolean',
                'description': (
                    "Swaps your game self's planning to a slower, heavier "
                    "model that thinks for up to a minute before it moves "
                    "a muscle. Judge it by whether the PLANNING is the "
                    "hard part, not by how important the job sounds. "
                    "Set TRUE for BIG work: several dependent stages "
                    "chained together (\"gather iron, smelt it, then make "
                    "me a full set of armour\"), or an elaborate build "
                    "that has to be designed from nothing — multi-room, a "
                    "custom layout, redstone. Also whenever the user asks "
                    "you to think hard or take your time. LEAVE IT OUT "
                    "for ordinary work, which is most of it: coming, "
                    "following, fighting, fetching, exploring, gathering, "
                    "crafting a tool set or gear, and putting up one of "
                    "the ready-made structures your game self already "
                    "knows (huts, shelters, small houses). Those have "
                    "worked patterns and the fast model carries them out "
                    "well — a minute of the user watching you stand still "
                    "is pure loss there. Never set it because an attempt "
                    "failed: a task that keeps failing moves onto the "
                    "heavier model on its own."
                ),
            },
        },
        'required': ['directive'],
    },
}

MINECRAFT_STATUS_TOOL = {
    'type': 'function',
    'name': MINECRAFT_STATUS_TOOL_NAME,
    'description': (
        "Check on yourself in the Minecraft world: your position, health, "
        "food, inventory, who and what is around you, what you are "
        "working on (`goal`), how far through a multi-step job you are "
        "(`plan`: progress, the step you're on, and anything blocked), "
        "what you did just before and how it ended (`recent_goals`), where "
        "you last died and how long ago (`deathSpot` — your dropped items "
        "are there and despawn ~5 minutes after falling), and "
        "whether you're in the game at all. Use before answering "
        "questions like \"how's it going in there?\" or \"what are you "
        "carrying?\" — and answer in first person (\"I'm at the cave "
        "entrance, half health, carrying 12 iron ore\"). Never guess at "
        "this: check, then speak."
    ),
    'parameters': {'type': 'object', 'properties': {}},
}

MINECRAFT_TOOL_NAMES = {MINECRAFT_COMMAND_TOOL_NAME, MINECRAFT_STATUS_TOOL_NAME}


class _SidecarLink:
    """Single-sidecar link state. The WS endpoint (routes/minecraft.py) owns
    the socket; everything else reads through the lock. Events get monotonic
    ids so the web client can poll with a cursor."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ws = None                    # active WebSocket (starlette) or None
        self.loop = None                  # event loop owning the socket
        self.status = None                # last status payload from the bot
        self.events = deque(maxlen=_EVENTS_MAX)
        self._ids = itertools.count(1)
        self.cursor = 0                   # id of the newest event

    def attach(self, ws, loop):
        with self.lock:
            old_ws, old_loop = self.ws, self.loop
            self.ws = ws
            self.loop = loop
            self.status = None
        # A second sidecar supersedes the first — close the old socket so
        # two bots can't interleave status/events into one link.
        if old_ws is not None and old_loop is not None and old_ws is not ws:
            try:
                asyncio.run_coroutine_threadsafe(old_ws.close(), old_loop)
            except Exception:
                _logger.exception("closing superseded minecraft sidecar failed")

    def detach(self, ws):
        """True when this socket actually held the link (a superseded
        socket's teardown must not announce 'link lost')."""
        with self.lock:
            if self.ws is not ws:
                return False
            self.ws = None
            self.loop = None
            self.status = None
            return True

    def push_event(self, kind, text, urgency='normal'):
        with self.lock:
            event_id = next(self._ids)
            self.cursor = event_id
            self.events.append({'id': event_id, 'kind': kind, 'text': text, 'urgency': urgency})

    def set_status(self, status):
        with self.lock:
            self.status = status

    def snapshot(self, cursor=None):
        """State for the polling client. cursor=None → no event backlog, just
        the current cursor (a fresh subscriber doesn't want history)."""
        with self.lock:
            connected = self.ws is not None
            status = self.status
            if cursor is None:
                events = []
            else:
                events = [e for e in self.events if e['id'] > cursor]
            return {'connected': connected, 'status': status, 'events': events, 'cursor': self.cursor}

    def send(self, message):
        """Thread-safe send from sync route handlers into the async socket.
        Waits for the write to land, so callers get a truthful answer — a
        fire-and-forget send reported success on a half-closed socket and
        the companion narrated work that never started."""
        with self.lock:
            ws, loop = self.ws, self.loop
        if not ws or not loop:
            return False
        try:
            future = asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(message)), loop)
            future.result(timeout=2)
            return True
        except Exception:
            _logger.exception("minecraft sidecar send failed")
            return False


link = _SidecarLink()


def connected():
    with link.lock:
        return link.ws is not None


def build_tools():
    return [MINECRAFT_COMMAND_TOOL, MINECRAFT_STATUS_TOOL]


def sidecar_config(con, agent=None):
    """The config message pushed to the sidecar on connect: the brain runs on
    the user's key, with its own (cheaper) model than the voice session."""
    config = get_config(con)
    return {
        'type': 'config',
        'api_key': config['xai_api_key'] or '',
        'model': config['minecraft_brain_model'] or 'grok-4.20-non-reasoning',
        # The stronger model is a rare escape hatch, not the default: it
        # thinks for ~70s a turn and tends to over-plan (bundling materials
        # it doesn't have into one brittle script). Empty here = disabled
        # entirely, for both the per-directive flag and failure escalation.
        'hard_model': config['minecraft_brain_model_hard'] or 'grok-4.5',
        'name': (agent and agent['name']) or 'your companion',
        'master': config['minecraft_master'] or '',
    }


def execute_minecraft_command(con, session, agent, arguments):
    if not agent['enable_minecraft']:
        return {'error': 'The Minecraft bot is disabled for this companion.'}
    directive = (arguments.get('directive') or '').strip()
    if not directive:
        return {'error': 'directive is required.'}
    if not connected():
        return {'error': 'The Minecraft bot is not connected right now — the sidecar (minecraft/ folder, `node index.js`) must be running.'}
    if not get_config(con)['xai_api_key']:
        return {'error': 'No xAI API key is configured (Settings) — the bot brain cannot plan without one.'}
    # What this directive is about to displace (last reported goal, ≤10s
    # old) — so the reply can tell the companion what it set aside.
    prior_goal = ((link.snapshot().get('status') or {}).get('goal') or '').strip()
    # Keep the game-side persona in sync with whoever is directing: the
    # sidecar connected before any session existed, so its config only had
    # a placeholder name. Cheap to resend on every directive.
    link.send({'type': 'config', 'name': agent['name'] or 'your companion'})
    # Always interrupting: a delayed directive still replaced the goal, it
    # just did so minutes later, which read as the bot ignoring the user.
    # Sequencing belongs inside the directive text, not in a queue.
    ok = link.send({
        'type': 'directive',
        'text': directive[:2000],
        'interrupt': True,
        'hard': bool(arguments.get('hard_model')),
    })
    if not ok:
        return {'error': 'Could not reach the Minecraft world (link just dropped).'}
    note = (
        'The goal is set — this is NOT the outcome. Your in-game self '
        'now works on it; the result (progress, completion, failure) '
        'arrives later as [Minecraft] notes, so wait for those before '
        'drawing conclusions or commanding again. Keep the '
        'conversation going meanwhile, speaking of the work in first '
        'person ("on my way", "I\'ll have it soon").'
    )
    out = {'ok': True, 'status': 'started', 'note': note}
    if prior_goal and prior_goal != directive:
        out['set_aside'] = prior_goal
        out['note'] = note + (
            f' You set aside: "{prior_goal}" — that work is not lost (what '
            'you built stays built, what you gathered stays carried, and '
            'your game self remembers the task). If it mattered, offer to '
            'go back to it later; a directive saying so is enough, and you '
            'will pick up from where the world actually is.'
        )
    return out


def execute_minecraft_status(con, session, agent, arguments):
    if not agent['enable_minecraft']:
        return {'error': 'The Minecraft bot is disabled for this companion.'}
    snap = link.snapshot()
    if not snap['connected']:
        return {'connected': False, 'note': 'Sidecar not connected (start it with `node index.js` in the minecraft/ folder).'}
    return {'connected': True, 'status': snap['status'] or {'online': False}}
