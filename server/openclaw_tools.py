# Copyright 2026 Codemarchant
"""openclaw_task: hand a task to the user's own OpenClaw agent.

Where delegate_task extends the companion with a cloud text-mode brain and
local_task with hands on this machine, openclaw_task reaches the assistant
the user already runs: an OpenClaw Gateway (https://github.com/openclaw/openclaw)
with whatever messaging apps, accounts, skills and automations they have
connected to it. The companion stays the personality; OpenClaw runs the
errand and reports back.

Transport is the Gateway's OpenAI-compatible HTTP surface (OpenClaw docs,
gateway/openai-http-api): POST /v1/chat/completions, where the `model` field
names an agent target (`openclaw/default`, `openclaw/<agentId>`) and each
request is a normal Gateway agent run. It is what OpenClaw documents for
other apps (its Open WebUI setup) and what third-party voice clients use.
Three things about it shape this file:

  * it is DISABLED by default in OpenClaw
    (gateway.http.endpoints.chatCompletions.enabled), so "the Gateway
    answers but the endpoint is off" is the usual setup mistake and gets
    its own message;
  * a request is stateless unless it carries an OpenAI `user` string, from
    which the Gateway derives a stable session key. Each companion sends
    its own, so its tasks land in one ongoing OpenClaw session and a
    follow-up ("now reply yes to her") needs no id passed back;
  * disconnecting the HTTP client cancels the agent run (same doc; in the
    Gateway's source, http-common.ts watchClientDisconnect aborts the run
    when the socket closes, streamed or not). That is the whole of
    cancelling here: `cancel` hangs up on the running request.

The request is NOT streamed. The companion gets one result when the run
ends either way (a realtime model takes a tool result once, and OpenClaw's
own voice calls speak only the final answer of the agent run behind them,
its openclaw_agent_consult tool), and the Gateway's streamed path has a
failure the plain one lacks: when the agent's final text is not what was
streamed plus more, it ends the stream with an error ("cannot be
represented as an append-only response stream") although the run finished.
Reported as a failure, a task that did send its message would get sent
again. The plain path returns the final text, which is also what the
third-party voice clients on this endpoint do.

Safety model:
  * opt-in per companion (enable_openclaw, default OFF): the Gateway token
    is a full operator credential, so the companion can ask for anything
    that agent is allowed to do. An OpenClaw agent with fewer tools, picked
    in Settings, is how a user narrows that;
  * never offered inside a delegated task session (session_service): acting
    for the user out there is the companion's own job.

Module-level rule (same as delegate_tools): no session_service import at
module level - session_service imports this module for tool registration.
"""
import http.client
import json
import logging
import socket
import threading
import time
from urllib.parse import urlsplit

import requests

from . import store
from .db import get_config
from .errors import UserError

_logger = logging.getLogger(__name__)

OPENCLAW_TOOL_NAME = 'openclaw_task'

# The Gateway's own default address (OpenClaw docs).
DEFAULT_URL = 'http://127.0.0.1:18789'
# Spoken-result cap, as delegate_tools and local_tools.
_MAX_RESULT_CHARS = 6000
# Connecting is instant on a running Gateway. The read limit is the longest
# any tool in the app has (60 min, see agent_connection.js
# COMPACTION_TOOL_WAIT_MS): OpenClaw ends a run at its own agent timeout
# and answers with an error, so this only catches a Gateway that hangs.
_CONNECT_TIMEOUT = 10
_READ_TIMEOUT = 60 * 60

# The description is in three parts. What the tool is and how to call it are
# fixed. What it is FOR is the user's to say (Settings → OpenClaw,
# config.openclaw_uses): which apps and accounts an OpenClaw agent reaches
# differs per install, and examples made up here ("check a calendar", "look
# something up") would pull requests away from the companion's own tools.
_WHAT = (
    "Hand a task to the user's OpenClaw agent: an assistant of their own "
    "outside this app, which works with the apps, accounts and automations "
    "they connected to it. It is for what your other tools don't reach. "
)
_USES = "What the user set theirs up for: {uses} "
_NO_USES = (
    "The user hasn't listed what theirs is set up for: use it when they ask "
    "for OpenClaw or their assistant by name, and ask the agent itself what "
    "it can do when that comes up. "
)
_HOW = (
    "Always tell the user what you're about to do BEFORE calling this, and "
    "only pass on what they asked for. Tasks take from several seconds up to "
    "minutes, so say you're on it before calling. Pass a self-contained "
    "brief in `task` in plain language (the agent doesn't hear this "
    "conversation): what to do, who it is for, and the exact wording of "
    "anything to be sent. The agent does remember the earlier tasks you gave "
    "it, so a follow-up can just say what to do next. One task runs at a "
    "time: wait for the result before calling again. If the user changes "
    "their mind while a task is running, call this with cancel=true to stop "
    "it. Tell the user the outcome naturally in your own voice."
)


def build_tool(config):
    """The tool entry, its description carrying the user's own account of
    what their OpenClaw agent is for."""
    uses = ' '.join((config['openclaw_uses'] or '').split())
    return dict(_TOOL, description=_WHAT + (_USES.format(uses=uses) if uses else _NO_USES) + _HOW)


def prompt_section():
    """The system prompt's mention of the tool, for a session that carries
    it: the description is one of many, and this is where a companion
    learns the agent exists at all."""
    return (
        "## OpenClaw\n"
        "- **The user has an OpenClaw agent you can hand tasks to** "
        "(`openclaw_task`): an assistant of theirs outside this app that acts "
        "in the apps and accounts they connected to it. Your own tools come "
        "first for what they cover; the tool's description says what the "
        "user set their agent up for.\n"
    )


_TOOL = {
    'type': 'function',
    'name': OPENCLAW_TOOL_NAME,
    'parameters': {
        'type': 'object',
        'properties': {
            'task': {
                'type': 'string',
                'description': (
                    'Self-contained brief: what to do, who it is for, and '
                    'the exact wording of anything to be sent. For '
                    'follow-ups, what to do next.'
                ),
            },
            'cancel': {
                'type': 'boolean',
                'description': (
                    'true = stop the task that is running now. `task` is '
                    'not used then; a word like "cancel" will do.'
                ),
            },
        },
        # `task` stays required although a cancel doesn't use it, as on
        # local_task (see there).
        'required': ['task'],
    },
}


def _base_url(url):
    """The Gateway's HTTP address without a trailing slash or /v1, from
    whichever form the user has in front of them: OpenClaw's docs give other
    apps the base URL with /v1 on it, and its own apps show the Gateway as
    ws://127.0.0.1:18789 (the same port serves both)."""
    url = (url or '').strip().rstrip('/')
    if url.lower().startswith(('ws://', 'wss://')):
        url = 'http' + url[2:]
    if url.endswith('/v1'):
        url = url[:-3].rstrip('/')
    return url or DEFAULT_URL


def _headers(token):
    token = (token or '').strip()
    return {'Authorization': f'Bearer {token}'} if token else {}


def _model(agent_id):
    """The `model` field: an agent target, not a provider model."""
    agent_id = (agent_id or '').strip()
    if not agent_id:
        return 'openclaw/default'
    if agent_id.startswith(('openclaw/', 'openclaw:', 'agent:')) or agent_id == 'openclaw':
        return agent_id
    return f'openclaw/{agent_id}'


_ENDPOINT_OFF = (
    'The OpenClaw Gateway at {url} is running, but its chat completions '
    'endpoint is off. Set gateway.http.endpoints.chatCompletions.enabled to '
    'true in the OpenClaw config and restart the Gateway.'
)
_UNREACHABLE = 'Could not reach the OpenClaw Gateway at {url}. It may not be running.'


def _error_message(body):
    """The message of an {"error": {"message", ...}} body, or None."""
    err = body.get('error') if isinstance(body, dict) else None
    if not err:
        return None
    return (err.get('message') if isinstance(err, dict) else str(err)) or 'unknown error'


def _json_or_problem(status, text, url):
    """(body, None) for a JSON answer, else (None, what is wrong). A path the
    Gateway doesn't serve as an API can answer 404 or with its web page, so
    anything that isn't JSON reads as the endpoint being off."""
    if status in (401, 403):
        return None, ('The OpenClaw Gateway refused the token. Check the Gateway token in '
                      'Settings → OpenClaw.')
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    ok = 200 <= status < 300
    if not isinstance(body, dict):
        if ok or status in (404, 405):
            return None, _ENDPOINT_OFF.format(url=url)
        return None, f'The OpenClaw Gateway at {url} answered {status}.'
    if not ok:
        return None, f'OpenClaw: {_error_message(body) or f"HTTP {status}"}'
    return body, None


def _models(url, token, timeout):
    """(agent target ids, None) from GET /v1/models, or (None, problem). The
    cheap probe: it lists the agents and starts no run."""
    try:
        resp = requests.get(f'{url}/v1/models', headers=_headers(token), timeout=timeout)
    except requests.RequestException:
        return None, (f'Could not reach the OpenClaw Gateway at {url}. Is it running, and is '
                      'the address in Settings → OpenClaw right?')
    body, problem = _json_or_problem(resp.status_code, resp.text, url)
    if problem:
        return None, problem
    if not isinstance(body.get('data'), list):
        return None, _ENDPOINT_OFF.format(url=url)
    return [m.get('id') for m in body['data'] if isinstance(m, dict) and m.get('id')], None


# A call's tool list and a text turn's are each built from this; one probe
# per few seconds is plenty (same as text_to_vrma.reachable).
_reachable_cache = {}   # (url, token) -> (checked_at, ok)
_REACHABLE_TTL = 10.0


def reachable(config):
    """Is the Gateway's endpoint answering right now? Same "only when
    actually usable" rule as local_task and generate_gesture: a tool that
    can only fail is not offered. A refused local connection fails
    instantly, so the probe costs nothing when OpenClaw isn't running."""
    url, token = _base_url(config['openclaw_url']), config['openclaw_token']
    hit = _reachable_cache.get((url, token))
    now = time.monotonic()
    if hit and now - hit[0] < _REACHABLE_TTL:
        return hit[1]
    ok = _models(url, token, 1.5)[0] is not None
    _reachable_cache[(url, token)] = (now, ok)
    return ok


def offered(config, agent_row):
    """openclaw_task is on this companion's tool list: the companion's own
    toggle, and the Gateway answering."""
    return bool(agent_row['enable_openclaw']) and reachable(config)


def test_connection(url, token):
    """Reachability, token and endpoint in one, plus the agents the Gateway
    offers, for the Settings button."""
    agents, problem = _models(_base_url(url), token, 5)
    if problem:
        raise UserError(problem)
    return {'ok': True, 'agents': agents}


def _content_text(content):
    """Assistant content as text: a string, or a list of
    {'type': 'text', 'text': ...} parts."""
    if isinstance(content, list):
        return ''.join(p.get('text') or '' for p in content if isinstance(p, dict))
    return content if isinstance(content, str) else ''


class _Run:
    """One request to the Gateway, made on its own thread so that the call
    waiting for it can be answered the moment it is cancelled."""

    def __init__(self, url, token, payload):
        self.url, self.token, self.payload = url, token, payload
        self.text = ''            # the agent's report
        self.problem = None       # why the run failed, if it did
        self.cut_off = False      # `text` is the summary of a run that was cut off
        self.cancelled = False
        self.finished = threading.Event()   # the run ended, or was cancelled
        self._conn = None
        # The connection's socket, held here too: http.client drops its own
        # reference once a `Connection: close` response's headers are in.
        self._sock = None
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._work, name='openclaw-task', daemon=True).start()

    def cancel(self):
        """Hang up: the Gateway cancels a run whose client disconnects.
        shutdown() rather than close(), which waits for the reader's file
        object and would leave the connection up until the run ended."""
        with self._lock:
            self.cancelled = True
            sock = self._sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.finished.set()

    def _work(self):
        try:
            self._exchange()
        except (OSError, http.client.HTTPException, ValueError) as e:
            if not self.cancelled:
                self.problem = ('The OpenClaw agent did not answer in time.'
                                if isinstance(e, TimeoutError) else _UNREACHABLE.format(url=self.url))
                _logger.warning('openclaw_task: %s (%s)', self.problem, e)
        finally:
            conn = self._conn
            if conn is not None:
                conn.close()
            self.finished.set()

    def _exchange(self):
        parts = urlsplit(self.url)
        cls = http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection
        conn = cls(parts.hostname, parts.port, timeout=_CONNECT_TIMEOUT)
        conn.connect()
        with self._lock:
            if self.cancelled:
                conn.close()
                return
            self._conn, self._sock = conn, conn.sock
        conn.sock.settimeout(_READ_TIMEOUT)
        conn.request('POST', f'{parts.path.rstrip("/")}/v1/chat/completions',
                     body=json.dumps(self.payload),
                     headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                              **_headers(self.token)})
        resp = conn.getresponse()
        status, text = resp.status, resp.read().decode('utf-8', 'replace')
        try:
            error = json.loads(text).get('error')
        except (ValueError, AttributeError):
            error = None
        if isinstance(error, dict) and error.get('code') == 'incomplete_turn':
            # A run that hit its output limit after tool work: the Gateway
            # answers 500 with the agent's recovered summary as the message.
            self.text, self.cut_off = str(error.get('message') or ''), True
            return
        body, self.problem = _json_or_problem(status, text, self.url)
        if body is not None:
            try:
                self.text = _content_text(body['choices'][0]['message'].get('content'))
            except (KeyError, IndexError, TypeError, AttributeError):
                self.problem = 'OpenClaw answered in a form this app could not read.'


# The runs in progress by companion, for `cancel` to find.
_runs = {}   # agent id -> [_Run, ...]
_runs_lock = threading.Lock()


def _cancel_running(agent_id):
    with _runs_lock:
        running = list(_runs.get(agent_id) or ())
    for run in running:
        run.cancel()
    if not running:
        return {'ok': True, 'status': 'nothing_running', 'note': 'No task was running.'}
    return {
        'ok': True,
        'status': 'cancelled',
        'note': ('The running task was told to stop. Anything the agent had already done '
                 '(a message already sent, say) stays done.'),
    }


def execute_openclaw_task(con, session, arguments):
    """Run one OpenClaw agent turn for `session` (the calling voice/text
    session), or cancel the one running. Same {'error': str} contract as the
    other native tool executors."""
    agent = store.get_agent(con, session['agent_id'])
    if not agent['enable_openclaw']:
        return {'error': 'OpenClaw tasks are disabled on this companion.'}

    args = arguments or {}
    if args.get('cancel') is True:
        return _cancel_running(agent['id'])
    task = args.get('task')
    if not isinstance(task, str) or not task.strip():
        return {'error': 'task is required.'}

    config = get_config(con)
    url = _base_url(config['openclaw_url'])
    payload = {
        'model': _model(config['openclaw_agent']),
        # The Gateway derives a stable session key from this: one ongoing
        # OpenClaw session per companion.
        'user': f"rexclaw:{agent['id']}",
        'messages': [
            # The Gateway treats the sender as its owner; say who is asking
            # and where the answer goes. A system message reaches the agent
            # as an extra system prompt for this run (the Gateway's
            # buildAgentPrompt) and stays out of its transcript.
            {'role': 'system',
             'content': (f"This request is relayed by {agent['name']}, the user's companion in "
                         f"the Rexclaw app, on the user's behalf. {agent['name']} passes your "
                         f"answer on to the user in conversation, so reply with a short, plain "
                         f"report of what you did or found.")},
            {'role': 'user', 'content': task.strip()},
        ],
    }
    _logger.info('openclaw_task: asking %s at %s', payload['model'], url)
    run = _Run(url, config['openclaw_token'], payload)
    with _runs_lock:
        _runs.setdefault(agent['id'], []).append(run)
    try:
        run.start()
        run.finished.wait()
    finally:
        with _runs_lock:
            _runs[agent['id']].remove(run)
            if not _runs[agent['id']]:
                del _runs[agent['id']]

    if run.cancelled:
        # No partial answer: a cancelled task's half-written report is not
        # an outcome (OpenClaw's own voice calls don't speak it either).
        return {'ok': False, 'status': 'cancelled',
                'note': 'This task was cancelled before it finished.'}
    if run.problem:
        return {'error': run.problem}
    result_text = run.text.strip()
    truncated = len(result_text) > _MAX_RESULT_CHARS
    if truncated:
        result_text = result_text[:_MAX_RESULT_CHARS].rstrip() + '…'
    if run.cut_off:
        return {
            'ok': False,
            'status': 'cut_off',
            'result': result_text,
            'truncated': truncated,
            'note': ("The agent ran out of room before it finished. This is its own summary of "
                     "how far it got; it does not confirm the task was completed, so tell the "
                     "user what is and isn't known to be done."),
        }
    if not result_text:
        result_text = '(The agent finished without a written report.)'
    # `result` leads so the model reads the agent's report first.
    return {
        'ok': True,
        'result': result_text,
        'truncated': truncated,
        'note': ("This is the OpenClaw agent's report. Tell the user the outcome naturally in "
                 "your own voice."),
    }
