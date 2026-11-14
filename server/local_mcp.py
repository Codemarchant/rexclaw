"""MCP servers the app connects to itself.

A provider-run connection (store.mcp_entries_for) is dialled by the brain's
provider, so it needs a public HTTPS URL and a brain whose provider speaks
MCP. Every other connection is run here, the way MCP clients usually do it:
the app starts the server's command (stdio) or opens its URL (streamable
HTTP, or the older HTTP+SSE), lists its tools, and offers each one as an
ordinary function tool named `<server label>__<tool>`. So they work with
any brain, local ones included, and reach servers on this computer or
network.

A connection is configured with the JSON entry MCP servers publish for
Claude Desktop, Cursor, LM Studio and the rest (parse_config). A URL server
that asks for it is signed in to with OAuth (sign_in): the MCP SDK runs the
flow, this module supplies the browser hand-off and keeps the tokens.

Live connections are kept in a hub: one asyncio loop on its own thread,
shared by every session. A connection is keyed by what it connects to, so
two companions with the same server share one process.
"""
import asyncio
import atexit
import concurrent.futures
import json
import logging
import os
import re
import shlex
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from . import db

_logger = logging.getLogger(__name__)

# Seconds a connect (start + handshake + tool list) or one tool call may
# take: the MCP TypeScript SDK's default request timeout
# (DEFAULT_REQUEST_TIMEOUT_MSEC = 60000).
TIMEOUT = 60

# The most characters of one tool result that reach the model: Claude
# Code's default limit for an MCP tool's output, 25,000 tokens
# (MAX_MCP_OUTPUT_TOKENS), at the 4 characters a token this app counts
# tool JSON at (session_service._approx_tokens). Past it a note says how
# much was left out. Without a limit one large file read would fill a
# call's context.
RESULT_MAX = 25_000 * 4

# One class from Python 3.11 on; three before it.
_TIMEOUTS = (TimeoutError, asyncio.TimeoutError, concurrent.futures.TimeoutError)

# What a function tool may be named at xAI and OpenAI.
_NAME_BAD = re.compile(r'[^A-Za-z0-9_-]')
_NAME_MAX = 64


# ---------------------------------------------------------------------------
# Configuration: the JSON entry MCP servers publish
# ---------------------------------------------------------------------------

# There is no standard for this format, only the `mcpServers` shape Claude
# Desktop started and the variations other clients made of it. What is
# accepted here was read from the docs or source of Claude Desktop, Claude
# Code, Cursor, VS Code, Windsurf, Cline, LM Studio, Zed, Goose, Gemini CLI,
# Codex, LibreChat and AIRI (2026-11).
#
# The key a config file keeps its servers under: `mcpServers` nearly
# everywhere, `servers` in VS Code, `context_servers` in Zed.
_WRAPPERS = ('mcpServers', 'servers', 'context_servers', 'mcp_servers')
_COMMAND_KEYS = ('command', 'cmd')
_URL_KEYS = ('url', 'serverUrl', 'httpUrl', 'uri')
_ENV_KEYS = ('env', 'envs', 'environment')
_HEADER_KEYS = ('headers', 'http_headers')
# How clients spell the transport of a URL server.
_TRANSPORTS = {'sse': 'sse', 'http': 'http', 'streamable-http': 'http',
               'streamablehttp': 'http', 'streamable_http': 'http'}
# Placeholders a config may carry: ${VAR}, ${VAR:-default}, ${env:VAR} and
# ${userHome} are filled in from this computer when the server is started;
# an editor's own (${input:id}, ${workspaceFolder}) have no meaning here.
_PLACEHOLDER = re.compile(r'\$\{(?:(env|input|file):)?([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}')
_EDITOR_ONLY = ('workspaceFolder', 'workspaceFolderBasename')


def _first(raw, keys):
    return next((raw[k] for k in keys if raw.get(k) is not None), None)


def _strings(value, what):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f'"{what}" must be an object of names and values.')
    return {str(k): '' if v is None else str(v) for k, v in value.items()}


def _check_placeholders(value):
    for kind, name, _default in _PLACEHOLDER.findall(json.dumps(value)):
        if kind in ('input', 'file') or name in _EDITOR_ONLY:
            shown = f'{kind}:{name}' if kind else name
            raise ValueError(f'${{{shown}}} is a placeholder of the editor this config was written for: '
                             'put the actual value in its place.')


def expand(text):
    """`text` with its ${VAR} placeholders filled in from this computer's
    environment. Raises ValueError for a variable that isn't set and has no
    default."""
    def fill(match):
        _kind, name, default = match.groups()
        if name == 'userHome':
            return os.path.expanduser('~')
        value = os.environ.get(name, default)
        if value is None:
            raise ValueError(f'the environment variable {name} is not set on this computer')
        return value
    return _PLACEHOLDER.sub(fill, text)


def _oauth_keys(raw):
    """A client registered with the server's sign-in service by hand, for a
    server that doesn't register clients itself: {'client_id',
    'client_secret', 'scopes'}. Every client spells these differently."""
    nested = raw.get('oauth') if isinstance(raw.get('oauth'), dict) else raw.get('auth')
    nested = nested if isinstance(nested, dict) else {}
    out = {}
    for key, names in (('client_id', ('clientId', 'client_id', 'CLIENT_ID')),
                       ('client_secret', ('clientSecret', 'client_secret', 'CLIENT_SECRET')),
                       ('scopes', ('scopes', 'scope'))):
        value = _first(nested, names)
        if value is None:
            value = _first(raw, ('oauth' + n[0].upper() + n[1:] for n in names))   # oauthClientId, ...
        if isinstance(value, list):
            value = ' '.join(str(v) for v in value)
        if value:
            out[key] = str(value)
    return out


def _entry(raw):
    """One server entry as this app keeps it: {'command', 'args', 'env',
    'cwd'} or {'url', 'headers', 'transport', 'oauth'}, plus 'active' when
    the entry says whether it is switched on. Keys other clients add for
    themselves (auto-approve lists, timeouts in their own units) are not
    kept."""
    if not isinstance(raw, dict):
        raise ValueError('A server entry must be a JSON object with a "command" or a "url".')
    _check_placeholders(raw)
    out = {}
    if 'disabled' in raw or 'enabled' in raw:
        out['active'] = 0 if (raw.get('disabled') is True or raw.get('enabled') is False) else 1
    command = _first(raw, _COMMAND_KEYS)
    args = raw.get('args')
    env = _first(raw, _ENV_KEYS)
    if isinstance(command, dict):      # Zed's older {"command": {"path", "args", "env"}}
        args = command.get('args', args)
        env = command.get('env', env)
        command = command.get('path')
    if isinstance(command, list):      # the command and its arguments as one list
        command, args = (command[0] if command else ''), [*command[1:], *(args or [])]
    if command:
        if not isinstance(command, str) or not command.strip():
            raise ValueError('"command" must be the program to start, as text.')
        if args is None and not os.path.exists(command):
            command, *args = split_command(command)   # a whole command line in one string
        if not isinstance(args or [], list):
            raise ValueError('"args" must be a list.')
        return {**out, 'command': command, 'args': [str(a) for a in args or []],
                'env': _strings(env, 'env'), 'cwd': str(raw.get('cwd') or '')}
    url = _first(raw, _URL_KEYS)
    if not url:
        raise ValueError('A server entry needs a "command" to start or a "url" to connect to.')
    if not isinstance(url, str) or not url.startswith(('http://', 'https://', '${')):
        raise ValueError('"url" must start with http:// or https://.')
    kind = _first(raw, ('type', 'transport', 'transportType'))
    if isinstance(kind, dict):         # Cline's nested {"transport": {"type": ...}}
        kind = kind.get('type')
    return {**out, 'url': url.strip(), 'headers': _strings(_first(raw, _HEADER_KEYS), 'headers'),
            'transport': _TRANSPORTS.get(str(kind or '').lower(), ''), 'oauth': _oauth_keys(raw)}


def parse_config(text):
    """[(name or None, entry)] out of what the user pasted: a whole config
    file, its `mcpServers` block, one `"name": {...}` pair with or without
    the braces around it, or a bare entry. Raises ValueError with what is
    wrong."""
    text = (text or '').strip()
    if not text:
        raise ValueError('Paste the server\'s JSON config: a "command" to start or a "url" to connect to.')
    try:
        data = json.loads(text)
    except ValueError as first:
        try:   # "name": {...} lifted out of a file, perhaps with its comma
            data = json.loads('{' + text.rstrip().rstrip(',') + '}')
        except ValueError:
            raise ValueError(f'The config is not valid JSON: {first}') from None
    if not isinstance(data, dict):
        raise ValueError('The config must be a JSON object.')
    if isinstance(data.get('mcp'), dict) and isinstance(data['mcp'].get('servers'), dict):
        data = data['mcp']                         # VS Code's settings.json: {"mcp": {"servers": ...}}
    for key in _WRAPPERS:
        if isinstance(data.get(key), dict):
            data = data[key]
            break
    else:
        if _first(data, _COMMAND_KEYS + _URL_KEYS):
            # A bare entry; VS Code's `code --add-mcp` form carries its name inside.
            name = data.get('name')
            return [(name if isinstance(name, str) else None, _entry(data))]
    if not data or not all(isinstance(v, dict) for v in data.values()):
        raise ValueError('No server found in the config: it needs a "command" to start or a "url" to connect to.')
    out = []
    for name, raw in data.items():
        try:
            out.append((str(name), _entry(raw)))
        except ValueError as e:
            raise ValueError(f'{name}: {e}') from None
    return out


def split_command(command):
    """A command line as [executable, *arguments]. Windows paths keep their
    backslashes; quotes around an argument with spaces are dropped."""
    if os.name != 'nt':
        return shlex.split(command)
    return [a[1:-1] if len(a) > 1 and a[0] == a[-1] == '"' else a
            for a in shlex.split(command, posix=False)]


def _val(row, key):
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


def _loads(text, default):
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


def entry_of(row):
    """A connection row as a config entry. The bearer token is not part of
    it: it is write-only, kept beside the entry."""
    command = (_val(row, 'command') or '').strip()
    if command:
        args = _loads(_val(row, 'args'), None)
        if args is None:      # a whole command line, from before args had a column
            command, *args = split_command(command)
        entry = {'command': command, 'args': args}
        env = _loads(_val(row, 'env'), {})
        if env:
            entry['env'] = env
        if _val(row, 'cwd'):
            entry['cwd'] = row['cwd']
        return entry
    entry = {}
    if _val(row, 'transport'):
        entry['type'] = row['transport']
    entry['url'] = (_val(row, 'server_url') or '').strip()
    headers = _loads(_val(row, 'headers'), {})
    if headers:
        entry['headers'] = headers
    oauth = _loads(_val(row, 'oauth'), {})
    if oauth:
        # Claude Code's spelling: the most widely copied one.
        entry['oauth'] = {new: (oauth[old].split() if old == 'scopes' else oauth[old])
                          for old, new in (('client_id', 'clientId'), ('client_secret', 'clientSecret'),
                                           ('scopes', 'scopes')) if oauth.get(old)}
    return entry


def columns_of(entry):
    """A parsed entry as mcp_connections columns."""
    return {
        'command': entry.get('command') or None,
        'args': json.dumps(entry['args']) if entry.get('command') else None,
        'env': json.dumps(entry['env']) if entry.get('env') else None,
        'cwd': entry.get('cwd') or None,
        'server_url': entry.get('url') or '',
        'headers': json.dumps(entry['headers']) if entry.get('headers') else None,
        'transport': entry.get('transport') or '',
        'oauth': json.dumps(entry['oauth']) if entry.get('oauth') else None,
    }


def _pairs(mapping):
    return tuple(sorted((str(k), expand(str(v))) for k, v in mapping.items()))


def spec_of(row):
    """What a connection row connects to, placeholders filled in, as a
    hashable key: ('stdio', command, args, env pairs, cwd) or
    ('http', url, header pairs, transport, OAuth client pairs)."""
    entry = entry_of(row)
    if entry.get('command'):
        return ('stdio', expand(entry['command']), tuple(expand(str(a)) for a in entry['args']),
                _pairs(entry.get('env', {})), expand(entry.get('cwd', '')))
    headers = dict(entry.get('headers', {}))
    if _val(row, 'authorization'):
        headers['Authorization'] = f"Bearer {row['authorization']}"
    return ('http', expand(entry['url']), _pairs(headers), _val(row, 'transport') or '',
            _pairs(_loads(_val(row, 'oauth'), {})))


def signs_in(spec):
    """Whether a connection can use an OAuth sign-in: a URL server that is
    not already given an Authorization header."""
    return spec[0] == 'http' and not any(k.lower() == 'authorization' for k, _ in spec[2])


# ---------------------------------------------------------------------------
# OAuth sign-ins (mcp_oauth table)
# ---------------------------------------------------------------------------

# How long a started sign-in waits for the user to finish in the browser.
SIGN_IN_WAIT = 300

CALLBACK_PATH = '/api/mcp/oauth/callback'
_GRANTS = ['authorization_code', 'refresh_token']


class SignInNeeded(Exception):
    """The server wants the user to sign in, and nobody is there to do it."""

    def __str__(self):
        return 'the server asks you to sign in (Sign in, in the connection\'s editor)'


def _oauth_row(url):
    con = db.connect()
    try:
        return con.execute("SELECT * FROM mcp_oauth WHERE server_url = ?", (url,)).fetchone()
    finally:
        con.close()


def _oauth_write(url, **values):
    con = db.connect()
    try:
        con.execute("INSERT OR IGNORE INTO mcp_oauth (server_url) VALUES (?)", (url,))
        con.execute(f"UPDATE mcp_oauth SET {', '.join(f'{k} = ?' for k in values)} WHERE server_url = ?",
                    (*values.values(), url))
        con.commit()
    finally:
        con.close()


def signed_in(row):
    """Whether a sign-in is kept for the server a connection row points at."""
    try:
        spec = spec_of(row)
    except ValueError:
        return False
    if not signs_in(spec):
        return False
    kept = _oauth_row(spec[1])
    return bool(kept and kept['tokens'])


def sign_out(row):
    """Forget the sign-in for a connection's server: its tokens and the
    client registered for them."""
    con = db.connect()
    try:
        con.execute("DELETE FROM mcp_oauth WHERE server_url = ?", (spec_of(row)[1],))
        con.commit()
    finally:
        con.close()
    reset()


class _TokenStore:
    """The SDK's TokenStorage over the mcp_oauth row of one server URL.
    `client` is a client registered by hand ({'client_id', 'client_secret'}
    from the connection's config), which then stands in for the one the
    SDK would register itself."""

    def __init__(self, url, client, redirect_uri):
        self.url = url
        self.client = client
        self.redirect_uri = redirect_uri

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken
        row = _oauth_row(self.url)
        return OAuthToken.model_validate_json(row['tokens']) if row and row['tokens'] else None

    async def set_tokens(self, tokens):
        _oauth_write(self.url, tokens=tokens.model_dump_json(),
                     expires_at=time.time() + int(tokens.expires_in) if tokens.expires_in else None)

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull
        if self.client.get('client_id'):
            secret = self.client.get('client_secret')
            return OAuthClientInformationFull(
                client_id=self.client['client_id'], client_secret=secret,
                redirect_uris=[self.redirect_uri], grant_types=_GRANTS, response_types=['code'],
                token_endpoint_auth_method='client_secret_post' if secret else 'none')
        row = _oauth_row(self.url)
        return (OAuthClientInformationFull.model_validate_json(row['client_info'])
                if row and row['client_info'] else None)

    async def set_client_info(self, client_info):
        if not self.client.get('client_id'):
            _oauth_write(self.url, client_info=client_info.model_dump_json())


class _SignIn:
    """One sign-in under way: the page to open, then the browser's answer."""

    def __init__(self, redirect_uri):
        self.redirect_uri = redirect_uri
        self.url = asyncio.get_running_loop().create_future()
        self.answer = asyncio.get_running_loop().create_future()


def _oauth_provider(link):
    """The SDK's OAuth flow for a link's server, or None when the server is
    reached without one: no sign-in was ever made for it and none is being
    made now. The SDK discovers the authorization server, registers this
    app with it, runs PKCE and refreshes tokens; the two handlers below are
    where a person comes in."""
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata
    url, flow, configured = link.spec[1], link.sign_in, dict(link.spec[4])
    row = _oauth_row(url)
    if flow is None and not (row and row['tokens']):
        return None
    if flow is not None and (row is None or row['redirect_uri'] != flow.redirect_uri):
        # The client registered before was registered for another callback
        # address (the app moved port or host): start over.
        _oauth_write(url, redirect_uri=flow.redirect_uri, client_info=None, tokens=None, expires_at=None)
        row = _oauth_row(url)

    async def open_page(authorization_url):
        if flow is None:
            # The SDK only gets here once the kept sign-in is of no use any
            # more (the token was turned down and could not be refreshed).
            # Dropping it makes the editor offer Sign in again, where it
            # would go on saying "signed in" over a dead token.
            _oauth_write(url, tokens=None, expires_at=None)
            raise SignInNeeded()
        page = urlparse(authorization_url)
        query = parse_qs(page.query)
        if configured.get('scopes'):
            # The SDK asks for the scopes the server advertises; scopes set
            # in the connection's config are the user's say and go instead.
            query['scope'] = [configured['scopes']]
            authorization_url = urlunparse(page._replace(query=urlencode(query, doseq=True)))
        _hub.waiting[(query.get('state') or [''])[0]] = flow
        if not flow.url.done():
            flow.url.set_result(authorization_url)

    async def wait_for_answer():
        try:
            return await asyncio.wait_for(flow.answer, SIGN_IN_WAIT)
        except _TIMEOUTS:
            raise RuntimeError('the sign-in was not finished in the browser in time') from None

    provider = OAuthClientProvider(
        server_url=url,
        client_metadata=OAuthClientMetadata(
            client_name='Rexclaw',
            redirect_uris=[row['redirect_uri']],
            grant_types=_GRANTS,
            response_types=['code'],
            token_endpoint_auth_method='none',
        ),
        storage=_TokenStore(url, configured, row['redirect_uri']),
        redirect_handler=open_page,
        callback_handler=wait_for_answer,
    )
    # The SDK keeps a token's expiry in memory only; without this a token
    # that ran out while the app was closed is sent as it is, and the 401
    # it earns asks for a whole new sign-in where a refresh would do.
    provider.context.token_expiry_time = row['expires_at']
    return provider


# ---------------------------------------------------------------------------
# Live connections
# ---------------------------------------------------------------------------

class _Link:
    """One live server. Its task owns the client for the connection's whole
    life (anyio wants a context left by the task that entered it); calls
    run beside it on the same loop."""

    def __init__(self, spec, sign_in=None, errlog=None):
        self.spec = spec
        self.sign_in = sign_in       # a _SignIn while the user is signing in
        self.errlog = errlog         # where a stdio server's stderr goes (default: ours)
        self.client = None
        self.tools = []              # [{'name', 'description', 'parameters'}]
        self.ready = asyncio.Event()
        self.stop = asyncio.Event()
        self.error = None
        self.waited = False          # a caller already waited the full TIMEOUT for it to come up
        self.refused = None          # the HTTP status the server last turned a request down with
        self.auth = None             # the OAuth flow its requests go through, if any
        self.task = asyncio.ensure_future(self._serve())

    def _transports(self):
        """The transports to try, in order. A URL server says which it
        speaks ("type" in its config) or is tried the way the MCP spec
        tells clients to: streamable HTTP, then the old HTTP+SSE when the
        first POST is answered 400, 404 or 405. A URL ending in /sse is
        the old transport's address (the heuristic FastMCP uses)."""
        if self.spec[0] == 'stdio':
            return ['stdio']
        url, transport = self.spec[1], self.spec[3]
        if transport:
            return [transport]
        return ['sse'] if re.search(r'/sse(/|\?|&|$)', url) else ['http', 'sse']

    async def _serve(self):
        try:
            transports = self._transports()
            for transport in transports:
                self.refused = None
                try:
                    await self._serve_on(transport)
                    break
                except BaseException:
                    # Only a server that turned the new transport down gets
                    # the old one: never one that asked for a sign-in, was
                    # unreachable, or had already been connected.
                    if (transport == transports[-1] or self.ready.is_set()
                            or self.refused not in (400, 404, 405)):
                        raise
        except BaseException as e:   # a cancelled or crashed connect included
            self.error = e
        finally:
            self.client = None
            self.ready.set()
            if self.sign_in is not None:
                if not self.sign_in.url.done():
                    self.sign_in.url.cancel()
                for state in [s for s, flow in _hub.waiting.items() if flow is self.sign_in]:
                    del _hub.waiting[state]


    async def _serve_on(self, transport):
        from contextlib import AsyncExitStack
        from mcp import Client, StdioServerParameters
        from mcp.client.sse import sse_client
        from mcp.client.stdio import stdio_client
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client
        async with AsyncExitStack() as stack:
            if transport == 'stdio':
                _kind, command, args, env, cwd = self.spec
                params = StdioServerParameters(command=command, args=list(args),
                                               env=dict(env) or None, cwd=cwd or None)
                server = stdio_client(params, errlog=self.errlog) if self.errlog else params
            else:
                url, headers = self.spec[1], dict(self.spec[2]) or None
                auth = self.auth = _oauth_provider(self) if signs_in(self.spec) else None

                # The SDK turns a refused request into a bare "error
                # response": the status is noted here, for the fallback to
                # the old transport and for telling the user why.
                async def note(response):
                    if response.status_code >= 400 and self.client is None:
                        self.refused = response.status_code

                def http_client(**kwargs):
                    made = create_mcp_http_client(**kwargs)
                    made.event_hooks['response'].append(note)
                    return made

                if transport == 'sse':
                    server = sse_client(url, headers=headers, auth=auth, httpx_client_factory=http_client)
                else:
                    http = await stack.enter_async_context(http_client(headers=headers, auth=auth))
                    server = streamable_http_client(url, http_client=http)
            client = await stack.enter_async_context(Client(server))
            tools, cursor = [], None
            while True:
                page = await client.list_tools(cursor=cursor)
                tools += [{'name': t.name, 'description': t.description or '',
                           'parameters': t.input_schema or {'type': 'object', 'properties': {}}}
                          for t in page.tools]
                cursor = page.next_cursor
                if not cursor:
                    break
            self.tools, self.client = tools, client
            self.ready.set()
            await self.stop.wait()

    def reason(self):
        """Why the connect failed, for the user."""
        if isinstance(_unwrap(self.error), SignInNeeded) or (
                self.refused == 401 and signs_in(self.spec) and self.auth is None):
            return str(SignInNeeded())
        if self.refused in (401, 403):
            return f'the server turned the connection down (HTTP {self.refused}): check the token in its config'
        said = _reason(self.error) or 'the server closed the connection'
        return f'{said} (HTTP {self.refused})' if self.refused else said


class _LostMidCall(Exception):
    """The connection went after a call was sent and before its answer."""


class _Hub:
    def __init__(self):
        self._loop = None
        self._links = {}             # spec -> _Link (touched on the loop only)
        self.waiting = {}            # OAuth state -> _SignIn the browser has yet to answer
        self._lock = threading.Lock()

    def _run(self, coro, timeout):
        with self._lock:
            if self._loop is None:
                self._loop = asyncio.new_event_loop()
                threading.Thread(target=self._loop.run_forever, name='rexclaw-mcp', daemon=True).start()
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout)
        except BaseException:
            future.cancel()
            raise

    async def _link(self, spec, errlog=None):
        link = self._links.get(spec)
        if link is None or link.task.done():
            link = self._links[spec] = _Link(spec, errlog=errlog)
        if link.sign_in is not None and not link.ready.is_set():
            raise SignInNeeded()     # the user is in the browser right now: don't wait for them
        if not link.ready.is_set():
            # A server gets one wait. One that hasn't answered by then goes
            # on starting in the background (a first `npx` download can
            # take longer than this) and is used once it is up; until then
            # later sessions and turns pass it by instead of waiting again.
            if link.waited:
                raise RuntimeError(f'still not answering, {TIMEOUT} seconds after it was started')
            try:
                await asyncio.wait_for(link.ready.wait(), TIMEOUT)
            except _TIMEOUTS:
                link.waited = True
                raise
        if link.client is None:
            self._links.pop(spec, None)
            raise RuntimeError(link.reason())
        return link

    async def _all_tools(self, specs):
        """Each server's tool list, or the exception that kept it from
        connecting. All are connected to at once, so one slow server costs
        a session start its own wait, not that of every server after it."""
        async def one(spec):
            try:
                return (await self._link(spec)).tools
            except Exception as e:
                return e
        return await asyncio.gather(*(one(spec) for spec in specs))

    async def _drop(self, spec=None):
        for key in ([spec] if spec else list(self._links)):
            link = self._links.pop(key, None)
            if link is None:
                continue
            # A connected link leaves by itself (the server gets a clean
            # shutdown); one still connecting, or stuck, is cancelled.
            link.stop.set()
            if link.client is None or not (await asyncio.wait([link.task], timeout=5))[0]:
                link.task.cancel()
                await asyncio.wait([link.task], timeout=5)

    async def _call(self, spec, tool, arguments):
        link = await self._link(spec)
        if spec[0] == 'stdio':
            # A command server dies easily while idle (the computer slept,
            # it crashed, the user closed it). A ping finds that out before
            # the call is sent, so the fresh start can never repeat a call
            # that had already run.
            try:
                await asyncio.wait_for(link.client.send_ping(), TIMEOUT)
            except Exception as e:
                # Any answer is a live server, even one saying it knows no ping.
                if _connection_lost(e) or isinstance(_unwrap(e), _TIMEOUTS):
                    await self._drop(spec)
                    link = await self._link(spec)
        # Up to here nothing was sent: a server that can't be started or
        # asks for a sign-in fails as what it is. From here on, a lost
        # connection leaves it open whether the call ran.
        try:
            return await link.client.call_tool(tool, arguments or {}, read_timeout_seconds=TIMEOUT)
        except Exception as e:
            if _connection_lost(e):
                raise _LostMidCall() from e
            raise

    async def _sign_in(self, spec, redirect_uri):
        """Connect with a person at hand. {'url'} when the server sent them
        to a sign-in page (the link then waits for the browser's answer),
        {} when it connected without one."""
        await self._drop(spec)
        flow = _SignIn(redirect_uri)
        link = self._links[spec] = _Link(spec, sign_in=flow)
        ready = asyncio.ensure_future(link.ready.wait())
        await asyncio.wait([flow.url, ready], return_when=asyncio.FIRST_COMPLETED)
        ready.cancel()
        if flow.url.done() and not flow.url.cancelled():
            return {'url': flow.url.result()}
        if link.client is None:
            self._links.pop(spec, None)
            raise RuntimeError(link.reason())
        return {}

    async def _state(self, spec):
        link = self._links.get(spec)
        if link is None:
            return {'state': 'none'}
        if not link.ready.is_set():
            return {'state': 'pending'}
        if link.client is None:
            self._links.pop(spec, None)
            return {'state': 'error', 'error': link.reason()}
        return {'state': 'connected', 'tools': [t['name'] for t in link.tools]}

    async def _answer(self, state, result, error):
        flow = self.waiting.pop(state, None)
        if flow is None or flow.answer.done():
            return False
        if error:
            flow.answer.set_exception(RuntimeError(error))
        else:
            flow.answer.set_result(result)
        return True

    def tools(self, spec, errlog=None):
        return self._run(self._link(spec, errlog), TIMEOUT + 10).tools

    def all_tools(self, specs):
        return self._run(self._all_tools(specs), TIMEOUT + 10)

    def call(self, spec, tool, arguments):
        # Up to three waits: a connect when the server isn't running yet,
        # the ping, and the call itself.
        try:
            return self._run(self._call(spec, tool, arguments), 3 * TIMEOUT + 10)
        except _LostMidCall:
            # The connection went in the middle of the call. Whether the
            # server ran it can't be known, so it is NOT sent again (a tool
            # that writes or sends would do it twice): the model is told,
            # and the next call starts the server afresh.
            self.drop(spec)
            raise RuntimeError('the server stopped answering in the middle of the call, so whether it ran is '
                               'not known. It is started afresh on the next call.') from None

    def drop(self, spec=None):
        if self._loop is not None:
            try:
                self._run(self._drop(spec), 15)
            except Exception:
                _logger.exception('closing MCP connections failed')


_hub = _Hub()
atexit.register(_hub.drop)


def _unwrap(error):
    """The first real error inside anyio's exception groups."""
    while getattr(error, 'exceptions', None):
        error = error.exceptions[0]
    return error


def _connection_lost(error):
    """Whether a failed call means the connection is gone, as opposed to a
    server that answered with an error or took too long."""
    from mcp.shared.exceptions import MCPError
    from mcp_types import CONNECTION_CLOSED
    error = _unwrap(error)
    if isinstance(error, MCPError):
        return error.code == CONNECTION_CLOSED
    return not isinstance(error, _TIMEOUTS)


def _reason(error):
    """A one-line reason out of an exception."""
    error = _unwrap(error)
    if error is None:
        return ''
    if isinstance(error, _TIMEOUTS):
        return f'no answer within {TIMEOUT} seconds'
    return getattr(error, 'message', None) or str(error) or type(error).__name__


# ---------------------------------------------------------------------------
# What the app calls
# ---------------------------------------------------------------------------

def _allowed(row, tools):
    allowed = {t.strip() for t in (row['allowed_tools'] or '').splitlines() if t.strip()}
    return [t for t in tools if not allowed or t['name'] in allowed]


def _offered_name(row, tool_name):
    return _NAME_BAD.sub('_', f"{row['server_label']}__{tool_name}")[:_NAME_MAX]


def _rows(con, agent_id, surface):
    flag = 'enable_for_voice' if surface == 'voice' else 'enable_for_text'
    return con.execute(
        f"SELECT * FROM mcp_connections WHERE agent_id = ? AND active = 1 AND {flag} = 1 "
        "AND runs_on = 'local' ORDER BY sequence, id",
        (agent_id,),
    ).fetchall()


def tools_for(con, agent_id, surface):
    """Function tool definitions for the connections of this companion the
    app runs. A server that can't be reached is logged and left out: the
    session goes on without its tools."""
    out, names, rows, specs = [], set(), [], []
    for row in _rows(con, agent_id, surface):
        try:
            specs.append(spec_of(row))
            rows.append(row)
        except ValueError as e:      # a placeholder this computer has no value for
            _logger.warning('MCP connection %s is unavailable: %s', row['server_label'], e)
    for row, tools in zip(rows, _hub.all_tools(specs) if specs else []):
        if isinstance(tools, Exception):
            _logger.warning('MCP connection %s is unavailable: %s', row['server_label'], _reason(tools))
            continue
        for tool in _allowed(row, tools):
            name = _offered_name(row, tool['name'])
            if name in names:
                continue
            names.add(name)
            out.append({'type': 'function', 'name': name,
                        'description': tool['description'], 'parameters': tool['parameters']})
    return out


def execute_tool(con, agent_id, surface, name, arguments):
    """Run a call to a tool of a connection the app runs, or None when no
    such connection of this companion offers `name`."""
    for row in _rows(con, agent_id, surface):
        if not name.startswith(_NAME_BAD.sub('_', f"{row['server_label']}__")):
            continue
        try:
            spec = spec_of(row)
            tool = next((t for t in _allowed(row, _hub.tools(spec))
                         if _offered_name(row, t['name']) == name), None)
            if tool is None:
                continue
            result = _hub.call(spec, tool['name'], arguments)
        except Exception as e:
            _logger.warning('MCP tool %s failed: %s', name, _reason(e))
            return {'error': f'{name} failed: {_reason(e)}'}
        # Text is passed on as it is; anything else (an image, a file) is
        # named, so the model knows the result held more than it can read.
        parts = [block.text if block.type == 'text' else f'[{block.type} content]'
                 for block in result.content]
        text = '\n'.join(parts)
        if not text and result.structured_content is not None:
            text = json.dumps(result.structured_content, default=str)
        if len(text) > RESULT_MAX:
            text = (f'{text[:RESULT_MAX]}\n[The result is cut off here: {len(text) - RESULT_MAX:,} more '
                    'characters were left out. Ask the tool for a smaller part if it can give one.]')
        return {'error': text or f'{name} failed'} if result.is_error else {'result': text}
    return None


def probe(row):
    """Connect afresh to what an editor draft describes and return its tool
    names (the editor's Test button). Raises RuntimeError with the reason,
    and with what a command wrote before it gave up."""
    spec = spec_of(row)
    _hub.drop(spec)
    errlog = tempfile.TemporaryFile('w+', encoding='utf-8', errors='replace') if spec[0] == 'stdio' else None
    try:
        return [t['name'] for t in _hub.tools(spec, errlog)]
    except Exception as e:
        said = ''
        if errlog is not None:
            errlog.seek(0)
            said = errlog.read()[-1500:].strip()
        raise RuntimeError(_reason(e) + (f'\n{said}' if said else '')) from None
    finally:
        _hub.drop(spec)
        if errlog is not None:
            errlog.close()


def sign_in(row, origin):
    """Start signing in to a URL server. {'url': page to open} when the
    server sends the user to one, {} when it connects without. `origin` is
    where the user's browser reaches this app: the sign-in page sends them
    back to it."""
    spec = spec_of(row)
    if not signs_in(spec):
        raise RuntimeError('only a URL server without an Authorization header of its own is signed in to')
    try:
        return _hub._run(_hub._sign_in(spec, callback_address(origin)), TIMEOUT)
    except Exception as e:
        raise RuntimeError(_reason(e)) from None


def callback_address(origin):
    """Where a sign-in page sends the browser back to, for an app reached
    at `origin`. It has to stay the same from one sign-in to the next:
    servers compare it letter by letter with the one a client was
    registered with."""
    host = urlparse(origin)
    # RFC 8252 7.3: a loopback callback is the IP literal, not "localhost".
    netloc = host.netloc.replace('localhost', '127.0.0.1', 1) if host.hostname == 'localhost' else host.netloc
    return f'{host.scheme}://{netloc}{CALLBACK_PATH}'


def sign_in_state(row):
    """Where a started sign-in stands: {'state': 'pending' | 'connected' |
    'error' | 'none'}."""
    return _hub._run(_hub._state(spec_of(row)), 10)


def sign_in_answer(state, code, issuer, error):
    """The browser came back from the sign-in page. False when no sign-in
    is waiting for this answer."""
    from mcp.shared.auth import AuthorizationCodeResult
    result = None if error else AuthorizationCodeResult(code=code or '', state=state, iss=issuer)
    return _hub._run(_hub._answer(state, result, error), 10)


def reset():
    """Close every live connection (a connection was edited or removed);
    each reconnects the next time it is used."""
    _hub.drop()
