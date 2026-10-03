# Copyright 2026 Codemarchant
"""Extensions: optional add-on packages that live outside the app's code.

An extension is a folder holding a manifest and a Python package:

    my_extension/
        plugin.json     {"id": "my-extension", "name": "My extension",
                         "version": "1.0", "description": "...",
                         "rexclaw_api": 1}
        __init__.py     def setup(api): ...

Rexclaw looks for extensions in data/plugins/ (each sub-folder is one) and
in any extra folder listed in data/plugins.json ("dirs") or the
REXCLAW_PLUGIN_DIRS environment variable (os.pathsep-separated). A listed
folder may be an extension itself or a folder of extensions. Extensions load
once, while the app starts; enabling, disabling or adding a folder takes a
restart.

setup(api) receives a PluginAPI and wires the extension in through it. That
is the whole contract: an extension may also import the app's own modules
(server.store, server.db, ...), but only the PluginAPI calls below are kept
stable across versions.

    api.data_dir                  a folder of its own under data/plugin-data/
    api.add_router(router)        FastAPI routes, under /api/plugins/<id>/
    api.add_static(folder, page=None, title=None)
                                  files served at /plugins/<id>/; `page` (a
                                  path inside it) is opened from Settings →
                                  Extensions
    api.add_tools(provider, executor)
                                  companion tools. provider(con, agent,
                                  surface, origin) returns the tool
                                  definitions to offer right now, in the
                                  {'type': 'function', 'name', 'description',
                                  'parameters'} shape (surface 'voice' or
                                  'text'; origin the session's: 'manual',
                                  'heartbeat' or 'delegated'). executor(name, arguments,
                                  ctx) runs one call and returns a JSON-able
                                  dict; ctx holds con, session, agent and
                                  surface. A call runs only if the provider
                                  offers that tool at that moment.
    api.add_companion_toggle(label, help='')
                                  a switch in each companion's Tools section
                                  (off by default). While it is off, none of
                                  this extension's tools, nor its script
                                  directives' guide, reach that companion.
    api.on(event, fn)             'startup', 'shutdown', and 'session_end'
                                  (fn(con=, session=))
    api.add_script_directive(name, parse, guide=None)
                                  a recording-script directive {name ...}.
                                  parse(arg, warnings, where) returns data to
                                  keep, or None to drop the line; it lands on
                                  the render timeline as a mark. `guide` is
                                  its reference entry, in the shape of the
                                  audio_studio.DIRECTIVES dicts, or a
                                  function returning one (called each time
                                  the guide is built, for live details).
    api.add_voice_engine(stage, engine_class)
                                  a speech-to-text ('stt'), brain ('llm') or
                                  text-to-speech ('tts') engine for voice
                                  calls on the pipeline voice engine: a
                                  subclass of SttEngine / LlmEngine /
                                  TtsEngine from server.pipeline.engines,
                                  with a unique `id`, a `label` and its
                                  settings `fields`. It is offered in
                                  Settings → Models & providers beside
                                  the built-in ones.
    api.add_minigame(page, title, description='', icon='🎮')
                                  a game page of this extension's (a path
                                  inside the add_static folder) listed in
                                  the mini-games library beside the
                                  built-in ones. Simpler still: any
                                  sub-folder of the add_static folder with
                                  a game.json is listed by itself. Either
                                  way the page plays like the built-in
                                  games; see web/public/games/README.md.
    api.connect_game(name, on_action, companion=None, offcall=None,
                     on_say=None)
                                  a game companions can play, for a game
                                  reached some other way than the Neuro API
                                  socket (its own API, a mod's HTTP port, a
                                  board on a web page...). Returns a client
                                  with the Neuro API's game-side messages as
                                  methods: context(message, silent=False),
                                  register([{'name', 'description',
                                  'schema'}]), unregister(names),
                                  force(query, action_names, state=None,
                                  ephemeral_context=False, priority='low'),
                                  chat(text) (the user typed to the
                                  companion) and close(). companion (an
                                  agent id) and offcall ('wait', 'separate'
                                  or 'latest') default to the Games tab's;
                                  on_say(text) gets what the companion
                                  says. on_action(name, data) runs a
                                  companion's move (data: the parsed dict,
                                  or None) and returns (success, message), a
                                  message string (success), or raises
                                  (failure). It runs on its own thread and
                                  should answer within 20 seconds. Connect
                                  once the app is up (an api.on('startup')
                                  handler, a route of yours), not inside
                                  setup(). See server/games.py.
    api.on_recording_rendered(fn) fn(mp3_path, timeline) after each render.
                                  timeline = {'duration', 'marks': [{'at',
                                  'directive', 'data'}], 'speech': [[start,
                                  end]], 'layers': [{'layer', 'value',
                                  'start', 'end', ...}], 'voice_activity':
                                  0..1 numpy array at 'frame_rate' per
                                  second}, times in seconds.
                                  Files it writes beside the mp3 named
                                  <mp3 stem>.<anything> are listed with the
                                  recording and deleted with it. A string it
                                  returns is passed to the companion that
                                  asked for the recording.

A failing extension never stops the app: its error is logged and shown in
Settings → Extensions, and nothing it registered is used.
"""
import importlib.util
import json
import logging
import os
import re
import sys
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from .db import DATA_DIR

_logger = logging.getLogger(__name__)

API_VERSION = 1
SETTINGS_PATH = DATA_DIR / 'plugins.json'
DEFAULT_ROOT = DATA_DIR / 'plugins'
PLUGIN_DATA_ROOT = DATA_DIR / 'plugin-data'
MANIFEST = 'plugin.json'
EVENTS = ('startup', 'shutdown', 'session_end')
_ID = re.compile(r'^[a-z][a-z0-9_-]{0,39}$')
_DIRECTIVE_NAME = re.compile(r'^[a-z][a-z-]{0,39}$')

_plugins = {}      # id → _Plugin, in load order (loaded or not)
_directives = {}   # directive name → (_Plugin, parse)


class _Plugin:
    def __init__(self, path, manifest):
        self.path = path
        self.manifest = manifest
        self.id = manifest.get('id') or path.name
        self.enabled = True
        self.loaded = False
        self.error = None
        self.page = None
        self.page_title = None
        self.providers = []     # (provider, executor)
        self.handlers = {event: [] for event in EVENTS}
        self.directives = {}    # name → (parse, guide)
        self.render_hooks = []
        self.voice_engines = []  # (stage, engine class)
        self.routers = []
        self.static = None      # folder served at /plugins/<id>/
        self.companion_toggle = None   # {'label', 'help'}: a switch in the companion form
        self.minigames = []     # {'page', 'title', 'description', 'icon'}: the mini-games library


class PluginAPI:
    """What an extension's setup(api) gets. See the module docstring.

    Registrations are collected here and only take effect once setup()
    returns, so a setup that fails halfway leaves nothing behind."""

    def __init__(self, plugin):
        self._plugin = plugin
        self._routers = []
        self._static = None
        self.id = plugin.id
        self.path = plugin.path
        self.data_dir = PLUGIN_DATA_ROOT / plugin.id
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def add_router(self, router):
        self._routers.append(router)

    def add_static(self, folder, page=None, title=None):
        self._static = Path(folder)
        if page:
            self._plugin.page = f'/plugins/{self.id}/{page.lstrip("/")}'
            self._plugin.page_title = title or self._plugin.manifest.get('name') or self.id

    def add_tools(self, provider, executor):
        self._plugin.providers.append((provider, executor))

    def add_companion_toggle(self, label, help=''):
        self._plugin.companion_toggle = {'label': label, 'help': help}

    def on(self, event, fn):
        if event not in EVENTS:
            raise ValueError(f'unknown event {event!r} (known: {", ".join(EVENTS)})')
        self._plugin.handlers[event].append(fn)

    def add_script_directive(self, name, parse, guide=None):
        if not _DIRECTIVE_NAME.match(name or ''):
            raise ValueError(f'directive names are lowercase letters and hyphens: {name!r}')
        self._plugin.directives[name] = (parse, guide)

    def on_recording_rendered(self, fn):
        self._plugin.render_hooks.append(fn)

    def add_minigame(self, page, title, description='', icon='🎮'):
        self._plugin.minigames.append({'page': page.lstrip('/'), 'title': title,
                                       'description': description, 'icon': icon})

    def connect_game(self, name, on_action, companion=None, offcall=None, on_say=None):
        from . import games
        return games.GameClient(name, on_action, self.id, companion=companion, offcall=offcall,
                                on_say=on_say)

    def add_voice_engine(self, stage, engine_class):
        if stage not in ('stt', 'llm', 'tts'):
            raise ValueError(f"unknown voice engine stage {stage!r} (known: stt, llm, tts)")
        if not getattr(engine_class, 'id', ''):
            raise ValueError('a voice engine class needs an id')
        self._plugin.voice_engines.append((stage, engine_class))


# ---------------------------------------------------------------------------
# Discovery and loading
# ---------------------------------------------------------------------------

def read_settings():
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'disabled': [], 'dirs': []}
    except (OSError, ValueError) as e:
        _logger.warning('could not read %s: %s', SETTINGS_PATH, e)
        return {'disabled': [], 'dirs': []}
    return {'disabled': [str(x) for x in data.get('disabled') or []],
            'dirs': [str(x) for x in data.get('dirs') or []]}


def write_settings(settings):
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding='utf-8')


def _search_dirs(settings):
    env = [p for p in os.environ.get('REXCLAW_PLUGIN_DIRS', '').split(os.pathsep) if p.strip()]
    return [DEFAULT_ROOT] + [Path(p).expanduser() for p in settings['dirs'] + env]


def _candidates(settings):
    """Every folder holding a plugin.json, in search order."""
    seen = set()
    for root in _search_dirs(settings):
        try:
            if not root.is_dir():
                continue
            folders = [root] if (root / MANIFEST).is_file() else sorted(
                p for p in root.iterdir() if p.is_dir() and (p / MANIFEST).is_file())
        except OSError as e:     # an unreadable folder listed in Settings
            _logger.warning('extensions: cannot read %s: %s', root, e)
            continue
        for folder in folders:
            key = os.path.normcase(str(folder.resolve()))
            if key not in seen:
                seen.add(key)
                yield folder


def load_all(app):
    """Find and set up every enabled extension, then add their routes and
    pages to `app`. Called from main.py, before the SPA catch-all route so
    extension routes win over it.

    Setup runs once per process, mounting once per app: `python -m
    server.main` imports main.py twice (as __main__, then as server.main for
    uvicorn), and the second app is the one that serves."""
    if not _plugins:
        _discover()
    for plugin in _active():
        for router in plugin.routers:
            app.include_router(router, prefix=f'/api/plugins/{plugin.id}')
        if plugin.static:
            app.mount(f'/plugins/{plugin.id}', StaticFiles(directory=str(plugin.static), html=True),
                      name=f'plugin-{plugin.id}')


def _discover():
    DEFAULT_ROOT.mkdir(parents=True, exist_ok=True)
    settings = read_settings()
    for folder in _candidates(settings):
        try:
            manifest = json.loads((folder / MANIFEST).read_text(encoding='utf-8'))
            if not isinstance(manifest, dict):
                raise ValueError('plugin.json must hold an object')
            if not isinstance(manifest.get('id', ''), str):
                raise ValueError('"id" must be text')
            manifest['rexclaw_api'] = int(manifest.get('rexclaw_api') or 1)
        except (OSError, ValueError, TypeError) as e:
            _logger.warning('extension %s: bad %s: %s', folder, MANIFEST, e)
            manifest = {'id': folder.name, 'error': str(e)}
        plugin = _Plugin(folder, manifest)
        if plugin.id in _plugins:
            _logger.warning('extension %s: id %r already loaded from %s, skipped',
                            folder, plugin.id, _plugins[plugin.id].path)
            continue
        _plugins[plugin.id] = plugin
        plugin.enabled = plugin.id not in settings['disabled']
        if manifest.get('error'):
            plugin.error = f'{MANIFEST}: {manifest["error"]}'
        elif not _ID.match(plugin.id):
            plugin.error = 'id must be lowercase letters, digits, - or _ (max 40)'
        elif manifest['rexclaw_api'] > API_VERSION:
            plugin.error = 'needs a newer version of Rexclaw'
        elif plugin.enabled:
            _load(plugin)


def _load(plugin):
    try:
        name = 'rexclaw_plugin_' + plugin.id.replace('-', '_')
        spec = importlib.util.spec_from_file_location(
            name, plugin.path / '__init__.py', submodule_search_locations=[str(plugin.path)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        api = PluginAPI(plugin)
        module.setup(api)
    except Exception as e:
        _logger.exception('extension %s failed to load', plugin.id)
        plugin.error = f'{type(e).__name__}: {e}'
        plugin.providers, plugin.render_hooks, plugin.directives = [], [], {}
        plugin.voice_engines, plugin.minigames = [], []
        plugin.handlers = {event: [] for event in EVENTS}
        plugin.page = plugin.companion_toggle = None
        return
    plugin.routers, plugin.static = api._routers, api._static
    if plugin.minigames and plugin.static is None:
        _logger.warning('extension %s: add_minigame needs add_static (where its pages live); games skipped',
                        plugin.id)
        plugin.minigames = []
    for dname, entry in plugin.directives.items():
        if dname in _directives:
            _logger.warning('extension %s: directive {%s} already belongs to %s, skipped',
                            plugin.id, dname, _directives[dname][0].id)
        else:
            _directives[dname] = (plugin, entry[0])
    plugin.loaded = True
    _logger.info('extension loaded: %s (%s)', plugin.id, plugin.path)


def _active():
    return [p for p in _plugins.values() if p.loaded]


def listing():
    """Every extension found, for Settings → Extensions. `enabled` is the
    saved choice (next start); `loaded` is whether it runs now."""
    disabled = set(read_settings()['disabled'])
    return [{
        'id': p.id,
        'name': p.manifest.get('name') or p.id,
        'version': p.manifest.get('version') or '',
        'description': p.manifest.get('description') or '',
        'path': str(p.path),
        'enabled': p.id not in disabled,
        'loaded': p.loaded,
        'error': p.error,
        'page': p.page,
        'page_title': p.page_title,
        'companion_toggle': p.companion_toggle if p.loaded else None,
    } for p in _plugins.values()]


# ---------------------------------------------------------------------------
# Hooks the app calls
# ---------------------------------------------------------------------------

def emit(event, **kwargs):
    for plugin in _active():
        for fn in plugin.handlers[event]:
            try:
                fn(**kwargs)
            except Exception:
                _logger.exception('extension %s: %s handler failed', plugin.id, event)


def companion_enabled(agent, plugin_id):
    """Whether a companion has an extension's tool switch on."""
    try:
        return bool(json.loads(agent['extension_tools'] or '{}').get(plugin_id))
    except (ValueError, AttributeError, IndexError, KeyError):
        return False


def _offered(con, agent, surface, origin):
    """[(plugin, executor, tool definition)] the extensions offer now. An
    extension with a companion switch offers nothing while it is off."""
    out = []
    for plugin in _active():
        if plugin.companion_toggle and not companion_enabled(agent, plugin.id):
            continue
        for provider, executor in plugin.providers:
            try:
                tools = provider(con, agent, surface, origin) or []
            except Exception:
                _logger.exception('extension %s: tool provider failed', plugin.id)
                continue
            out += [(plugin, executor, tool) for tool in tools]
    return out


def tool_definitions(con, agent, surface, origin, taken=()):
    """Extension tools to add to a session's list. A name already in
    `taken` (a built-in tool) is skipped: the model can't be offered two."""
    names = set(taken)
    tools = []
    for plugin, _executor, tool in _offered(con, agent, surface, origin):
        if tool.get('name') in names:
            _logger.warning('extension %s: tool %s clashes with another, skipped',
                            plugin.id, tool.get('name'))
            continue
        names.add(tool.get('name'))
        tools.append(tool)
    return tools


def execute_tool(con, session, agent, name, arguments, surface):
    """Run an extension tool call, or None when no extension offers `name`
    for this session right now (the caller then reports an unknown tool)."""
    origin = session['origin'] if 'origin' in session.keys() else 'manual'
    for plugin, executor, tool in _offered(con, agent, surface, origin):
        if tool.get('name') != name:
            continue
        try:
            result = executor(name, arguments or {},
                              {'con': con, 'session': session, 'agent': agent, 'surface': surface})
        except Exception as e:
            _logger.exception('extension %s: tool %s failed', plugin.id, name)
            return {'error': f'{name} failed: {e}'}
        return result if isinstance(result, dict) else {'result': result}
    return None


def directive(name):
    """(plugin id, parse) for a recording-script directive, or None."""
    entry = _directives.get(name)
    return (entry[0].id, entry[1]) if entry and entry[0].loaded else None


def directive_guides(agent=None):
    """[(section title, [guide entries])] for the recording guide. With a
    companion, only extensions whose switch it has on (or that have none):
    the directives still parse for anyone, but only those companions are
    taught them."""
    out = []
    for plugin in _active():
        if agent is not None and plugin.companion_toggle and not companion_enabled(agent, plugin.id):
            continue
        entries = []
        for _parse, guide in plugin.directives.values():
            try:
                entry = guide() if callable(guide) else guide
            except Exception:
                _logger.exception('extension %s: directive guide failed', plugin.id)
                continue
            if entry:
                entries.append(entry)
        if entries:
            out.append((plugin.manifest.get('name') or plugin.id, entries))
    return out


def recording_rendered(mp3_path, timeline):
    """Run the render hooks; returns the notes they left for the companion."""
    notes = []
    for plugin in _active():
        for fn in plugin.render_hooks:
            try:
                note = fn(mp3_path, timeline)
            except Exception:
                _logger.exception('extension %s: recording hook failed', plugin.id)
                continue
            if isinstance(note, str) and note.strip():
                notes.append(note.strip())
    return notes


def minigames():
    """The games extensions add to the mini-games library: every sub-folder
    of their static folder with a game.json, and each add_minigame page."""
    from . import games
    out = []
    for plugin in _active():
        name = plugin.manifest.get('name') or plugin.id
        if plugin.static is not None:
            out += games.read_manifests(plugin.static, f'/plugins/{plugin.id}', name)
        out += [{'id': game['page'], 'title': game['title'], 'description': game['description'], 'tags': [],
                 'url': f'/plugins/{plugin.id}/{game["page"]}', 'cover': None, 'icon': game['icon'],
                 'background': None, 'save_key': game['title'], 'order': 100, 'extension': name}
                for game in plugin.minigames]
    return out


def voice_engines(stage):
    """Engine classes extensions add for one voice pipeline stage."""
    return [cls for plugin in _active() for s, cls in plugin.voice_engines if s == stage]
