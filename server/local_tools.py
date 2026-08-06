# Copyright 2026 Codemarchant
"""local_task: hand real on-machine work to the Grok Build CLI.

Where delegate_task extends the companion with a cloud text-mode brain,
local_task extends it with HANDS: the xAI Grok Build CLI (`grok`) is a full
agentic coding CLI that plans, writes/edits files, runs shell commands and
iterates — on the user's actual computer. We drive it headlessly
(`-p … --output-format streaming-json --always-approve`) from the server
process, which in every supported non-Docker run mode lives on the user's
machine (run.sh/run.bat and the desktop app both run the server locally; in
Docker the binary simply isn't on PATH and the tool is never offered).

Sessions map onto Grok Build's own headless sessions (stored by the CLI
under ~/.grok/sessions): a new task mints a UUID and creates its session
with `-s` (the CLI insists on literal UUIDs); the id comes back as
local_task_id, and passing it back resumes that session via `-r` with its
context intact, so "now fix the bug you found" works exactly like
delegate_task follow-ups. continue_last rides the CLI's `-c` flag (most
recent session in the working directory) — no server-side state needed.

File bridging (mirroring delegate_task's `files` param): refs are
materialized from the files library into <workdir>/attachments as working
COPIES — the CLI can freely read or modify them without touching the
library originals (whose bytes back xAI re-uploads and must stay intact).

Safety model:
  * opt-in per agent (enable_local_tasks, default OFF);
  * the CLI runs with --always-approve (headless mode cannot prompt), so
    the working directory is the blast-radius boundary: it defaults to a
    dedicated <data>/workspace folder and is only widened by the user
    explicitly setting config.local_task_workdir;
  * the tool description instructs the model to announce actions first and
    never do destructive things that were not explicitly requested.

Module-level rule (same as delegate_tools): no session_service import at
module level — session_service imports this module for tool registration.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

from . import store
from .db import DATA_DIR, get_config

_logger = logging.getLogger(__name__)

LOCAL_TASK_TOOL_NAME = 'local_task'

# Spoken-result cap mirrors delegate_tools; the full transcript lives in the
# CLI's own session store. No run timeout: long agentic tasks (especially in
# text mode) are legitimate, and the CLI exits on its own when the turn ends.
_MAX_RESULT_CHARS = 6000
_MAX_ERROR_CHARS = 1500
# `-s` values land on a command line — keep them boring.
_SESSION_ID_OK = set('abcdefghijklmnopqrstuvwxyz'
                     'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-')
# Attachments per call.
_MAX_FILES = 25

LOCAL_TASK_TOOL = {
    'type': 'function',
    'name': LOCAL_TASK_TOOL_NAME,
    'description': (
        "Do REAL work on the user's computer through the Grok CLI coding "
        "agent running right on their machine: it can create/read/edit "
        "files, write and run code, execute shell commands, and iterate "
        "until the job is done — all inside its workspace folder. It can "
        "also OPEN things for the user via shell commands (a file it just "
        "made, an app, a URL in the browser). Use this when the "
        "user asks you to actually make or do something on their computer: "
        "write a script or small app, organise or generate files, analyse "
        "a local project, automate something. Always "
        "tell the user what you're about to do BEFORE calling this, and "
        "only do what they explicitly asked — never delete things, install "
        "software, or touch anything outside the task without being asked. "
        "Tasks take from several seconds up to minutes, so say you're on "
        "it before calling. Pass a self-contained brief in `task` (the "
        "agent doesn't hear this conversation) in PLAIN LANGUAGE — "
        "describe WHAT to do and the desired outcome; never write shell "
        "commands or code in `task`, the agent writes its own. Attach "
        "library files "
        "(uploads, screenshots, generated images) via `files` — working "
        "copies land in the agent's directory for it to use or modify. "
        "Never paste /files/... URLs into the task: they only exist "
        "inside this app, not on disk — always attach via `files`. "
        "CONTINUATION RULE — a "
        "call without local_task_id starts a BLANK worker with no memory: "
        "whenever the task relates to ANYTHING this tool already did "
        "(a tweak, fix, follow-up, 'open that file'), you MUST pass the "
        "local_task_id from the earlier result, or continue_last=true. "
        "Never "
        "split DEPENDENT steps ('create X' then 'open X') across "
        "parallel calls; put multi-step work in ONE self-contained brief "
        "(the agent handles many steps itself), or wait for the result "
        "and follow up with local_task_id. Parallel calls are fine only "
        "for genuinely unrelated tasks. Summarise the outcome naturally "
        "in your own voice; never recite file contents or code aloud."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'task': {
                'type': 'string',
                'description': (
                    'Self-contained brief: what to build/do, expected '
                    'outcome, and any constraints. For follow-ups, what to '
                    'do next.'
                ),
            },
            'files': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': (
                    'Optional, up to 25 files-library refs (imagine_image_id '
                    'or image_url values) to copy into the working directory '
                    'as attachments the agent can read and use.'
                ),
            },
            'local_task_id': {
                'type': 'string',
                'description': (
                    'REQUIRED for any follow-up: the id from the earlier '
                    'local_task result. Continues that worker with its '
                    'memory intact; omitting it starts a blank one.'
                ),
            },
            'continue_last': {
                'type': 'boolean',
                'description': (
                    'true = continue your most recent task instead of '
                    'starting a new one. Ignored when local_task_id is '
                    'given.'
                ),
            },
        },
        'required': ['task'],
    },
}


def _registry_path():
    """Windows only: the LIVE PATH per the registry (machine + user scope),
    rebuilt the same way Chocolatey's refreshenv does. A process launched
    before an install keeps its stale PATH copy forever (the desktop app,
    an IDE, and everything they spawn), but installers write the registry —
    so this sees a CLI installed after the server started. None elsewhere."""
    try:
        import winreg
    except ImportError:
        return None
    parts = []
    for root, key in (
        (winreg.HKEY_LOCAL_MACHINE,
         r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'),
        (winreg.HKEY_CURRENT_USER, 'Environment'),
    ):
        try:
            with winreg.OpenKey(root, key) as k:
                value, _type = winreg.QueryValueEx(k, 'Path')
            parts.append(winreg.ExpandEnvironmentStrings(value))
        except OSError:
            continue
    return os.pathsep.join(p for p in parts if p) or None


def grok_binary():
    """Absolute path of the Grok Build CLI, or None. Resolved fresh on every
    call — the user may install the CLI while the server is running."""
    found = shutil.which('grok')
    if found:
        return found
    registry_path = _registry_path()
    if registry_path:
        return shutil.which('grok', path=registry_path)
    return None


def grok_available():
    return grok_binary() is not None


def _workdir(config):
    """The blast-radius boundary. Empty config value → dedicated folder under
    the data dir (created on demand)."""
    raw = (config['local_task_workdir'] or '').strip()
    path = Path(raw) if raw else (DATA_DIR / 'workspace')
    path.mkdir(parents=True, exist_ok=True)
    return path


def _chunk_text(content):
    """Text out of a streaming-json content payload — tolerant of the block
    being a plain string, a {'type':'text','text':…} dict, or a list of
    such blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return content.get('text') or ''
    if isinstance(content, list):
        return ''.join(_chunk_text(part) for part in content)
    return ''


def _parse_stream(stdout):
    """Newline-delimited events → (assistant_text, session_id, cost_usd).

    Observed real format (grok CLI, Aug 2026): flat {"type": …} events —
    "text" tokens carry the answer ("thought"/"tool_call"/… are progress),
    and the final "end" event carries the authoritative sessionId plus
    total_cost_usd. The ACP-style session/update shape the docs sketch is
    kept as a fallback in case a CLI version switches to it.

    Returns (text, session_id, cost_usd, saw_events) — saw_events tells the
    caller whether stdout was recognisable event JSON at all, so the
    raw-stdout fallback only fires on true format drift and never hands the
    model a pile of NDJSON."""
    chunks, session_id, cost = [], None, None
    saw_events = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith('{'):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        saw_events = True
        etype = event.get('type')
        if etype == 'text':
            chunks.append(event.get('data') or '')
            continue
        if etype == 'end':
            sid = event.get('sessionId')
            if isinstance(sid, str) and sid:
                session_id = sid
            if isinstance(event.get('total_cost_usd'), (int, float)):
                cost = event['total_cost_usd']
            continue
        # ACP-style fallback (session/update + agent_message_chunk).
        params = event.get('params') or {}
        sid = params.get('sessionId')
        if isinstance(sid, str) and sid:
            session_id = sid
        update = params.get('update') or {}
        if update.get('sessionUpdate') == 'agent_message_chunk':
            chunks.append(_chunk_text(update.get('content')))
    return ''.join(chunks).strip(), session_id, cost, saw_events


def _materialize_files(con, workdir, refs):
    """Inbound bridge: library refs → real files under <workdir>/attachments.

    The delegate_task counterpart pushes library bytes UP to xAI as content
    blocks; here they come DOWN onto disk where the CLI can read them.
    Returns (workdir-relative paths, errors, resolved library row ids).
    Refs are model-controlled, so resolution goes strictly through library
    rows — never an arbitrary-file read."""
    from . import imagine_tools  # lazy: mirrors the session_service cycle rule
    paths, errors, row_ids = [], [], []
    if not isinstance(refs, list):
        refs = [refs]
    if len(refs) > _MAX_FILES:
        errors.append(f'Only the first {_MAX_FILES} files were attached.')
    attachments = workdir / 'attachments'
    for ref in refs[:_MAX_FILES]:
        ref = str(ref or '').strip()
        if not ref:
            continue
        row = imagine_tools._imagine_row_for_ref(con, ref)
        if not row:
            errors.append(f'"{ref}": no files-library entry matches.')
            continue
        if row['id'] in row_ids:
            continue  # same file referenced twice in one call
        src = imagine_tools._web_path_to_file(row['image_path'])
        if src is None or not src.is_file():
            errors.append(f'"{ref}": file is missing on disk.')
            continue
        # Library names are user/model text — flatten to a safe filename,
        # keeping the stored extension so tools recognise the type.
        base = re.sub(r'[^\w.\- ]+', '_', (row['name'] or '').strip())[:60]
        base = base or src.stem
        if not base.lower().endswith(src.suffix.lower()):
            base += src.suffix
        dest, n = attachments / base, 1
        while dest.exists():
            dest = attachments / f'{Path(base).stem}-{n}{Path(base).suffix}'
            n += 1
        try:
            attachments.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
        except OSError as e:
            errors.append(f'"{ref}" could not be copied: {e}')
            continue
        paths.append(f'attachments/{dest.name}')
        row_ids.append(row['id'])
    return paths, errors, row_ids


def execute_local_task(con, session, arguments):
    """Run one Grok Build turn for `session` (the calling voice/text session).
    Same {'error': str} contract as the other native tool executors."""
    agent = store.get_agent(con, session['agent_id'])
    if not agent['enable_local_tasks']:
        return {'error': 'Local computer tasks are disabled on this agent.'}

    args = arguments or {}
    task = args.get('task')
    if not isinstance(task, str) or not task.strip():
        return {'error': 'task is required.'}
    task = task.strip()

    binary = grok_binary()
    if not binary:
        return {'error': (
            'The Grok Build CLI is not installed on this machine (the '
            '`grok` command was not found). The user can install it from '
            'https://docs.x.ai/build — then this tool works.'
        )}

    config = get_config(con)
    try:
        workdir = _workdir(config)
    except OSError as e:
        return {'error': f'Could not create the task workspace folder: {e}'}

    notes = []
    attached, file_errors, attached_ids = _materialize_files(
        con, workdir, args.get('files') or [])
    notes.extend(file_errors)
    if attached:
        task += ('\n\n[The user attached these files — copied into the '
                 'working directory at: ' + ', '.join(attached) + ']')

    # Safety net: the model often pastes the app-internal /files/... URL
    # into the task instead of using `files` (the upload context note hands
    # it exactly that URL). Those paths don't exist on disk — point the
    # agent at working copies instead: rows already attached via `files`
    # reuse their existing copy (no duplicates), unattached ones are
    # materialized now. Non-matching /files/ mentions are ignored silently.
    from . import imagine_tools  # lazy: mirrors the session_service cycle rule
    path_by_row = dict(zip(attached_ids, attached))
    redirect_paths, new_refs = [], []
    for u in dict.fromkeys(re.findall(r'/files/[A-Za-z0-9_.\-]+', task)):
        row = imagine_tools._imagine_row_for_ref(con, u.rstrip('.'))
        if not row:
            continue
        if row['id'] in path_by_row:
            redirect_paths.append(path_by_row[row['id']])
        else:
            new_refs.append(u.rstrip('.'))
    if new_refs:
        url_paths, url_errors, _ids = _materialize_files(con, workdir, new_refs)
        notes.extend(url_errors)
        redirect_paths.extend(url_paths)
        attached = attached + url_paths
    if redirect_paths:
        task += ('\n\n[Note: /files/... URLs mentioned above are '
                 'app-internal and do NOT exist on disk. Local copies '
                 'of those files are in the working directory at: '
                 + ', '.join(dict.fromkeys(redirect_paths))
                 + ' — reference these paths instead.]')

    explicit_id = (args.get('local_task_id') or '').strip() \
        if isinstance(args.get('local_task_id'), str) else ''
    if explicit_id and (len(explicit_id) > 64
                       or not set(explicit_id) <= _SESSION_ID_OK):
        return {'error': 'local_task_id is not a valid task id.'}

    minted = None
    if explicit_id:
        # -s only CREATES ("Session ID … is already in use" on reuse);
        # resuming an existing session is its own flag.
        session_args = ['-r', explicit_id]
    elif args.get('continue_last'):
        # The CLI's own "most recent session in this directory" — the real
        # id is scraped back out of the event stream below.
        session_args = ['-c']
    else:
        # The CLI requires -s to be a literal UUID (it rejects named ids).
        minted = str(uuid.uuid4())
        session_args = ['-s', minted]

    cmd = [
        binary,
        '-p', task,
        '--output-format', 'streaming-json',
        '--always-approve',      # headless mode has no one to ask
        '--no-auto-update',
        '--cwd', str(workdir),
        *session_args,
    ]
    env = dict(os.environ)
    if config['xai_api_key']:
        # Fallback auth only: the CLI's own stored login (~/.grok/auth.json)
        # takes precedence over this env var (verified empirically), so a
        # logged-in CLI bills its own account; the rexclaw key covers
        # never-logged-in installs.
        env.setdefault('XAI_API_KEY', config['xai_api_key'])

    _logger.info('local_task: running grok (session %s) in %s',
                 explicit_id or minted or '(-c)', workdir)
    try:
        proc = subprocess.run(
            cmd, cwd=str(workdir), env=env,
            capture_output=True, text=True,
            encoding='utf-8', errors='replace',
            # No visible console window when the (windowless) desktop-app
            # server spawns the CLI on Windows.
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except OSError as e:
        return {'error': f'Could not launch the Grok Build CLI: {e}'}

    result_text, stream_sid, cost_usd, saw_events = _parse_stream(proc.stdout or '')
    # The end event's sessionId is authoritative — trust it over what we
    # passed in (`-s` on a fresh id may not be honoured verbatim).
    task_id = stream_sid or explicit_id or minted

    if proc.returncode != 0:
        detail = (proc.stderr or '').strip() or (proc.stdout or '').strip()
        return {
            'error': (
                f'The local task failed (exit {proc.returncode}): '
                f'{detail[-_MAX_ERROR_CHARS:] or "no output"}'
            ),
            'local_task_id': task_id,
        }

    if not result_text and not saw_events:
        # Format drift tolerance: if the CLI didn't emit recognisable
        # streaming-json at all (older/newer version), fall back to raw
        # stdout. When events WERE parsed but carried no text (an
        # action-only turn), stay empty — never hand the model raw NDJSON.
        result_text = (proc.stdout or '').strip()
    truncated = len(result_text) > _MAX_RESULT_CHARS
    if truncated:
        result_text = result_text[:_MAX_RESULT_CHARS].rstrip() + '…'
    if not result_text:
        result_text = '(The task produced no text output.)'

    note = (
        f'Files were created/changed in {workdir} — tell the user the '
        f'filename and that it is in their workspace folder, so they can '
        f'open it themselves. Pass local_task_id "{task_id}" to local_task '
        f'to continue this task with memory of what it already did. Give '
        f'the user a natural spoken summary — never recite file contents '
        f'or code verbatim.'
    ) if task_id else (
        f'Files were created/changed in {workdir}.'
    )
    if notes:
        note += ' ' + ' '.join(notes)
    # `result` leads so the model reads the worker's report before the
    # bookkeeping fields.
    out = {
        'ok': True,
        'result': result_text,
        'local_task_id': task_id,
        'workdir': str(workdir),
        'truncated': truncated,
        'note': note,
    }
    if attached:
        out['attached_files'] = attached
    if cost_usd is not None:
        out['cost_usd'] = round(cost_usd, 4)
    return out
