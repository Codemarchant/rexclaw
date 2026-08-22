# Copyright 2026 Codemarchant
"""delegate_task: hand complex work to a background text-mode task session.

The realtime voice model is audio-only and comparatively shallow — it cannot
see images, read documents, or grind through long coding/research tasks. This
tool bridges that gap for BOTH surfaces: the calling companion delegates a
brief (optionally with file/image references) to a hidden text-mode session
running the full Responses API stack, and gets the final answer back as the
tool result.

Task sessions are real sessions rows with origin='delegated':
  * hidden from the interactive history/resume lists (those filter
    origin != 'delegated');
  * continued across turns — the tool result carries task_session_id, and
    passing it back (or continue_last=true) reuses the same workspace with
    its chain, transcript and compaction intact, so "now fix the bug you
    just found" works;
  * compacted server-side (no browser to trigger /compact — see
    _maybe_compact) and left active between turns; a follow-up reactivates
    a workspace that was ended or errored by other means.

Two execution paths:
  * standard — text_send_turn wholesale: the delegate runs headless with the
    agent's full text-mode toolset, chained via previous_response_id.
    delegate_task itself is never offered inside a delegated session
    (recursion guard).
  * multi_agent — one-shot create_response on the xAI multi-agent model
    (several agents collaborate, a leader synthesizes). That model rejects
    custom function tools, so the call carries only web/X search; rows are
    persisted into the same task session and the chain is broken afterwards
    (chaining across a model swap is untested), so follow-ups re-seed from
    the local transcript via the normal replay path.

Module-level rule: this file must NOT import session_service at module level
(session_service imports it for tool registration) — the import happens
lazily inside the executors instead.
"""
import logging
import re

from . import imagine_tools, store, xai_client
from .db import get_config, utcnow

_logger = logging.getLogger(__name__)

DELEGATE_TOOL_NAME = 'delegate_task'

# Guardrails: refs per call, spoken-result size (the full text always lives
# in the task session's transcript; the caller only needs enough to speak).
# The file cap is our own leeway number, not an xAI limit — document refs
# are ~50 bytes each (file ids); only inlined library images carry weight.
_MAX_FILES = 25
_MAX_RESULT_CHARS = 6000
# Parent-transcript rows seeded into a fresh task session as context.
_PARENT_CONTEXT_ROWS = 10
_PARENT_CONTEXT_CHARS = 300
# xAI file ids look like ``file_<uuid>`` — require the prefix, so placeholder
# tokens the model sometimes writes instead of a value ("video_url",
# "imagine_image_id from take_screenshot result") are rejected with a
# helpful note before they 400 the whole task at the Files API. The literal
# parameter names are denied even though "file_id" fits the shape.
_FILE_ID_RE = re.compile(r'^file[_-][A-Za-z0-9._-]+$')
_PLACEHOLDER_REFS = {'file_id', 'xai_file_id', 'imagine_image_id',
                     'image_url', 'video_url'}

DELEGATE_TOOL = {
    'type': 'function',
    'name': DELEGATE_TOOL_NAME,
    'description': (
        "Your deep-focus mode — a background process that extends YOUR "
        "own abilities beyond what you can do mid-conversation: it can "
        "SEE images (selfies, screenshots, library images), READ "
        "documents (PDFs, spreadsheets, any uploaded file), write and "
        "reason through code, and do deep multi-step research. You "
        "cannot see or read files directly in this conversation — "
        "whenever the user asks about the CONTENT of a file or image, "
        "use this tool. To the user this is simply YOU doing the work: "
        "say 'let me take a closer look' or 'I'll read through it' — "
        "never mention an analyst, delegating, or background processes; "
        "that is internal plumbing and naming it breaks the illusion. "
        "Pass a self-contained brief in `task` (the background process "
        "doesn't hear the conversation; recent context is attached "
        "automatically only on a NEW task). Reference files via "
        "`files`: imagine_image_id / image_url values for library "
        "images, xai_file_id values for uploaded documents. Each task "
        "runs in its own persistent workspace — the result includes a "
        "task_session_id; pass it back (or continue_last=true) for "
        "follow-ups so the workspace remembers what was already done. "
        "Takes several seconds to minutes: tell the user you're looking "
        "into it before calling. The full result is returned to you — "
        "give a natural spoken summary in your own voice; never recite "
        "long content or code verbatim. Pick `model`: 'fast' for looking "
        "at images, screenshots and clips, reading a short document, or "
        "any quick check — it answers in a fraction of the time; 'normal' "
        "(the default) for research, coding and multi-step work that "
        "needs depth."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'task': {
                'type': 'string',
                'description': (
                    'Self-contained brief: what to do, expected output, '
                    'and any constraints. For follow-ups, what to do next.'
                ),
            },
            'files': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': (
                    'Optional, up to 25. A library ref is the exact '
                    'imagine_image_id or image_url a PRIOR tool returned '
                    '(take_screenshot, take_selfie, an upload); pass one of '
                    'those, never a made-up id or a description of one. To '
                    'read something you must capture it first: call that '
                    'tool, wait for its result, THEN call this with the id '
                    'from it (not both in one turn). Library refs stay valid '
                    'forever; raw xai_file_id values also work.'
                ),
            },
            'task_session_id': {
                'type': 'integer',
                'description': (
                    'Continue this specific prior task with its memory '
                    'intact (from an earlier delegate_task result).'
                ),
            },
            'continue_last': {
                'type': 'boolean',
                'description': (
                    'true = continue your most recent task instead of '
                    'starting a new one. Ignored when task_session_id is '
                    'given.'
                ),
            },
            'model': {
                'type': 'string',
                'enum': ['normal', 'fast'],
                'description': (
                    "'fast' = the quick text model: vision (images, "
                    "screenshots, clips), short reads, quick checks. "
                    "'normal' = the full text model for deep work "
                    "(default). Ignored with multi_agent."
                ),
            },
            'multi_agent': {
                'type': 'boolean',
                'description': (
                    'true = route to the multi-agent model: several agents '
                    'collaborate and a leader synthesizes. Slow and much '
                    'more expensive — reserve for genuinely hard research '
                    'or analysis questions, never for routine tasks.'
                ),
            },
        },
        'required': ['task'],
    },
}

# Appended to the delegate description when local_task is offered alongside:
# both tools "write code", and without the contrast the model routes
# on-machine requests to the cloud sandbox — whose files the user can never
# see or open.
_LOCAL_TASK_CONTRAST = (
    " Runs in a cloud workspace — for work that should land directly on "
    "the user's machine (local files, apps, shell), prefer local_task."
)


def delegate_tool(*, with_local_task_note=False):
    """The delegate tool entry, with the cloud-vs-local contrast appended
    when local_task is in the same toolset."""
    if not with_local_task_note:
        return DELEGATE_TOOL
    tool = dict(DELEGATE_TOOL)
    tool['description'] = DELEGATE_TOOL['description'] + _LOCAL_TASK_CONTRAST
    return tool


def _resolve_file_blocks(con, refs):
    """Model-supplied file refs → Responses-API content blocks.

    Library refs (numeric ids / library /files paths) resolve user-scoped:
    images become input_image data URIs; anything else (videos, documents)
    rides as input_file via the row's cached xai_file_id — re-uploaded from
    the local bytes when the cached id expired (imagine_tools.ensure_xai_file),
    which is what makes library refs durable across turns and sessions. Raw
    file_… refs pass through as input_file unchanged. Returns (blocks,
    errors)."""
    blocks, errors = [], []
    if not isinstance(refs, list):
        refs = [refs]
    if len(refs) > _MAX_FILES:
        errors.append(f'Only the first {_MAX_FILES} files were used.')
    for ref in refs[:_MAX_FILES]:
        ref = str(ref or '').strip()
        if not ref:
            continue
        row = imagine_tools._imagine_row_for_ref(con, ref)
        if row:
            if (row['mimetype'] or '').startswith('image/'):
                uri, err = imagine_tools._library_image_data_uri(con, ref)
                if err:
                    errors.append(f'"{ref}": {err}')
                else:
                    blocks.append({'type': 'input_image', 'image_url': uri})
            else:
                try:
                    blocks.append({
                        'type': 'input_file',
                        'file_id': imagine_tools.ensure_xai_file(con, row),
                    })
                except Exception as e:
                    errors.append(f'"{ref}" could not be attached: {e}')
        elif _FILE_ID_RE.match(ref) and ref.lower() not in _PLACEHOLDER_REFS:
            blocks.append({'type': 'input_file', 'file_id': ref})
        else:
            # Not a library row and not a file_… id — almost always a
            # placeholder the model invented instead of a real ref. Forwarding
            # it 400s the whole task; note it instead so the model retries with
            # the id a prior tool actually returned.
            errors.append(f'"{ref}" is not a valid file reference — pass the '
                          f'imagine_image_id / image_url a prior tool returned, '
                          f'not a description.')
    return blocks, errors


def _seed_task_session(con, svc, parent, task_session, agent):
    """First-run context for a fresh workspace: a role note plus the tail of
    the parent conversation, persisted as system rows so the fresh-chain
    replay path (and any later re-seed) naturally includes them."""
    svc._persist_text_message(
        con, task_session, role='system', content=(
            f'You are a delegated background task process working on behalf '
            f'of the companion "{agent["name"]}". Complete the task below '
            f'thoroughly and self-sufficiently — there is no user to ask '
            f'for clarification mid-task. Your final message is returned '
            f'to the main conversation as the task result.'
        ),
    )
    rows = con.execute(
        "SELECT * FROM messages WHERE session_id = ? "
        "AND role IN ('user', 'assistant') "
        "ORDER BY sequence DESC, id DESC LIMIT ?",
        (parent['id'], _PARENT_CONTEXT_ROWS),
    ).fetchall()
    if not rows:
        return
    lines = []
    for m in reversed(rows):
        text = (m['content'] or '').strip().replace('\n', ' ')
        if not text:
            continue
        if len(text) > _PARENT_CONTEXT_CHARS:
            text = text[:_PARENT_CONTEXT_CHARS].rstrip() + '…'
        speaker = 'User' if m['role'] == 'user' else (m['speaker'] or agent['name'] or 'Agent')
        lines.append(f'{speaker}: {text}')
    if lines:
        svc._persist_text_message(
            con, task_session, role='system', content=(
                '[Recent context from the conversation that spawned this '
                'task]\n' + '\n'.join(lines)
            ),
        )


def _maybe_compact(con, svc, task_session):
    """Server-side stand-in for the browser's /compact trigger: headless
    sessions have no client watching the token counter, so compact between
    turns whenever the accrual flagged the session. Non-fatal — a failed
    compaction just means a bigger replay next turn."""
    if not task_session['needs_summary']:
        return
    try:
        svc.text_compact(con, task_session)
    except Exception:
        _logger.exception('delegate_task: compaction failed for session %s',
                          task_session['id'])


def _run_multi_agent_turn(con, svc, config, agent, task_session, task,
                          file_blocks, xai_key):
    """One-shot multi-agent call. No custom tools (the model rejects them);
    context comes from replaying the task session's local rows. The chain is
    broken afterwards so a later standard turn re-seeds cleanly."""
    instructions = (
        svc._env_preamble(config)
        + svc._render_prompt(agent)
        + svc._env_postamble(con, agent, mode='text')
    )
    input_items = svc._replay_text_messages(con, task_session)
    content = [{'type': 'input_text', 'text': task}] + file_blocks
    input_items.append({'role': 'user', 'content': content})
    tools = []
    if agent['enable_web_search']:
        tools.append({'type': 'web_search'})
    if agent['enable_x_search']:
        tools.append({'type': 'x_search'})
    svc._persist_text_message(con, task_session, role='user', content=task)
    body = xai_client.create_response(
        xai_api_key=xai_key,
        responses_url=config['xai_responses_url'],
        model=config['multi_agent_model'] or 'grok-4.20-multi-agent',
        input_items=input_items,
        instructions=instructions,
        tools=tools or None,
        reasoning_effort=config['multi_agent_effort'] or 'low',
        prompt_cache_key=f'rexclaw:{agent["id"]}',
    )
    svc._accrue_text_usage(con, task_session, body.get('usage') or {})
    chunks = []
    for item in (body.get('output') or []):
        if isinstance(item, dict) and item.get('type') == 'message':
            for part in (item.get('content') or []):
                if isinstance(part, dict) and part.get('type') == 'output_text':
                    if part.get('text'):
                        chunks.append(part['text'])
    text = ''.join(chunks).strip()
    if text:
        svc._persist_text_message(con, task_session, role='assistant', content=text)
    # Chaining across the multi-agent model swap is untested — break it so
    # the next turn (standard or multi-agent) re-seeds from local rows.
    _break_chain(con, task_session)
    return text


def _break_chain(con, task_session):
    """Drop the task session's server-side response chain so the next turn
    re-seeds from local rows — used around any turn that runs on a different
    model than the chain was built with (multi-agent, fast)."""
    store.update_session(con, task_session['id'],
                         previous_response_id=None,
                         last_response_at=None,
                         chain_tail_sequence=0)


def execute_delegate_tool(con, session, arguments):
    """Run one delegation turn for `session` (the calling voice/text session).
    Same {'error': str} contract as the other native tool executors."""
    from . import session_service as svc  # lazy: circular import

    agent = store.get_agent(con, session['agent_id'])
    if not agent['enable_delegate_tool']:
        return {'error': 'Task delegation is disabled on this agent.'}
    if session['origin'] == 'delegated':
        # Never offered there, but a forged/stale call must still fail —
        # unbounded self-delegation is a spend bug.
        return {'error': 'A delegated task session cannot delegate further.'}

    args = arguments or {}
    task = args.get('task')
    if not isinstance(task, str) or not task.strip():
        return {'error': 'task is required.'}
    task = task.strip()

    config = get_config(con)
    xai_key = config['xai_api_key']
    if not xai_key:
        return {'error': 'xAI API key is not configured.'}

    # _truthy, not bool(): a model answering the string "false" would otherwise
    # read as True and route to the priciest path (see imagine_tools._truthy).
    multi_agent = imagine_tools._truthy(args.get('multi_agent'))
    notes = []
    if multi_agent and not agent['enable_multi_agent_delegation']:
        multi_agent = False
        notes.append('multi_agent is not enabled on this agent — ran as a '
                     'standard delegation instead.')

    # Fast path: the quick text model for vision / short reads. The chain
    # was built on the standard model, so break it on either side of the
    # swap (same precaution as multi-agent).
    fast_model = None
    if not multi_agent and args.get('model') == 'fast':
        fast_model = (config['delegate_fast_model'] or '').strip() or None
        if not fast_model:
            notes.append('No fast text model is configured (Settings) — ran '
                         'on the standard text model.')
        elif fast_model == (config['text_model'] or '').strip():
            fast_model = None   # same model: nothing to swap

    file_blocks, file_errors = _resolve_file_blocks(con, args.get('files') or [])
    notes.extend(file_errors)
    # A task that names files but resolves none would otherwise run text-only
    # against a brief like "describe the attached screenshot" — and the model
    # confabulates a confident answer from nothing. Refuse before any workspace
    # or spend happens; the error names what to pass instead, and unlike a
    # trailing note the model reliably acts on it.
    if args.get('files') and not file_blocks:
        detail = ' '.join(file_errors) or 'No usable file reference was given.'
        return {'error': f'Task not run — none of its files resolved. {detail}'}
    if multi_agent and file_blocks:
        notes.append('Note: file support on the multi-agent model is '
                     'experimental — if analysis fails, retry without '
                     'multi_agent.')

    # --- Resolve or create the task workspace -----------------------------
    task_session = None
    explicit_id = args.get('task_session_id')
    if explicit_id:
        try:
            explicit_id = int(explicit_id)
        except (TypeError, ValueError):
            return {'error': 'task_session_id must be an integer.'}
        cand = con.execute(
            "SELECT * FROM sessions WHERE id = ?", (explicit_id,),
        ).fetchone()
        # Scoped to the same agent; parent may differ (a task started from
        # yesterday's conversation is legitimately continuable today).
        if (not cand or cand['origin'] != 'delegated'
                or cand['agent_id'] != agent['id']):
            return {'error': (
                f'No delegated task session {explicit_id} exists for this '
                f'agent. Omit task_session_id to start a new task.'
            )}
        task_session = cand
    elif args.get('continue_last'):
        task_session = con.execute(
            "SELECT * FROM sessions WHERE origin = 'delegated' AND agent_id = ? "
            "ORDER BY last_active_at DESC, id DESC LIMIT 1",
            (agent['id'],),
        ).fetchone()
        if not task_session:
            notes.append('No previous task existed — started a new one.')

    created = False
    if not task_session:
        task_session = store.create_session(con, agent_id=agent['id'],
                                            mode='text', origin='delegated')
        store.update_session(
            con, task_session['id'],
            state='active',
            delegate_parent_session_id=session['id'],
            name=f'Task: {task[:60]}',
            title_generated=1,  # keep the task name; skip the auto-titler
            started_at=utcnow(),
            last_active_at=utcnow(),
        )
        task_session = store.get_session(con, task_session['id'])
        created = True
        _seed_task_session(con, svc, session, task_session, agent)
    elif task_session['state'] != 'active':
        # Ended/errored workspace — reactivate for the follow-up.
        store.update_session(con, task_session['id'],
                             state='active', ended_at=None)
        task_session = store.get_session(con, task_session['id'])

    _maybe_compact(con, svc, task_session)
    task_session = store.get_session(con, task_session['id'])

    # --- Run the turn ------------------------------------------------------
    try:
        if multi_agent:
            result_text = _run_multi_agent_turn(
                con, svc, config, agent, task_session, task, file_blocks,
                xai_key,
            )
        else:
            if fast_model:
                _break_chain(con, task_session)
                task_session = store.get_session(con, task_session['id'])
            turn = svc.text_send_turn(
                con, session=task_session, user_text=task,
                extra_content_blocks=file_blocks or None,
                # No browser is attached to a task session — a browser_tools
                # round-trip could never be answered.
                headless=True,
                model=fast_model,
                # Non-reasoning fast models reject reasoning.effort.
                **({'reasoning_effort': None} if fast_model else {}),
            )
            if fast_model:
                _break_chain(con, task_session)
                notes.append('Ran on the fast text model.')
            if turn.get('type') == 'error':
                return {'error': turn.get('message') or 'Delegated task failed.',
                        'task_session_id': task_session['id']}
            result_text = (turn.get('assistant_text') or '').strip()
    except Exception as e:
        _logger.exception('delegate_task failed for session %s (task %s)',
                          session['id'], task_session['id'])
        return {'error': f'Delegated task failed: {e}',
                'task_session_id': task_session['id']}

    store.update_session(con, task_session['id'], last_active_at=utcnow())
    con.commit()

    truncated = len(result_text) > _MAX_RESULT_CHARS
    if truncated:
        result_text = result_text[:_MAX_RESULT_CHARS].rstrip() + '…'
    if not result_text:
        result_text = '(The task produced no text output.)'

    note = (
        f'Pass task_session_id {task_session["id"]} to delegate_task to '
        f'continue this task with memory of what it already did. Give the '
        f'user a natural spoken summary — never recite long content or '
        f'code verbatim.'
    )
    if notes:
        note += ' ' + ' '.join(notes)
    return {
        'ok': True,
        'task_session_id': task_session['id'],
        'created': created,
        'multi_agent': multi_agent,
        'result': result_text,
        'truncated': truncated,
        'note': note,
    }
