# Copyright 2026 Codemarchant
"""Business logic for session lifecycle: start / append / end / resume /
summarize, for both voice (realtime WebSocket) and text (Responses API) modes.

Ported from the Odoo module's services/voice_session_service.py with the
Odoo-specific surfaces removed: no ERP read/navigation/DOM tools, no per-user
ACL or daily caps (single-user BYOK app), and `{{ }}` dynamic prompt blocks
are stripped rather than evaluated (no server-side eval surface here).
"""
import json
import logging
import re
import threading
from datetime import datetime, timedelta

from . import xai_client, browser_tools, imagine_tools, memory_tools, store
from .db import get_config, utcnow, parse_dt
from .errors import UserError, ValidationError

_logger = logging.getLogger(__name__)

# User-authored `{{ ... }}` blocks in the system prompt were evaluated
# server-side in the Odoo module (safe_eval). The standalone has no sandboxed
# eval, so blocks are stripped at render time — never leaked to the model as
# literal code.
PROMPT_BLOCK_RE = re.compile(r'\{\{(.*?)\}\}', re.DOTALL)


def _render_prompt(agent_row):
    raw = agent_row['system_prompt'] or ''
    if '{{' not in raw:
        return raw
    return PROMPT_BLOCK_RE.sub('', raw)


def _env_preamble(config):
    """Static environmental context prepended to every agent's system prompt.

    Small, static, foundational: the app surface, the user's local datetime
    (for resolving relative date phrases), and general tool-use guidance. The
    user's display name is gated by config.include_user_name_in_prompt so the
    name is never sent to xAI without explicit opt-in.
    """
    now_local = datetime.now().astimezone()
    now_str = now_local.strftime('%Y-%m-%d %H:%M:%S %Z (%z)')
    identity_line = ""
    if config['include_user_name_in_prompt'] and config['user_display_name']:
        identity_line = f"- **User name:** {config['user_display_name']!r}.\n"
    return (
        f"## Environment\n"
        f"You are running inside Rexclaw Companions — the user's personal "
        f"desktop companion app. You appear as a live 3D avatar and converse "
        f"by voice or text.\n\n"
        f"{identity_line}"
        f"- **Current datetime (user local):** {now_str}\n"
        f"  Resolve relative date/time phrases (\"today\", \"tomorrow\", "
        f"\"this week\", \"in 2 hours\") against this clock.\n\n"
        f"- **Tool use — hard rule, never announce without acting:** If your words say or "
        f"imply you're doing something, the tool call MUST go out in that same "
        f"response. A stated intent with no call is a failure, not a finished "
        f"turn. The only reason to announce without calling is when you genuinely "
        f"need missing input or the action is hard to undo — then ask instead of "
        f"announcing.\n"
        f"- **Tool sequencing:** Fire independent tools in parallel in the same "
        f"turn where they don't depend on each other. In a dependent chain, fire "
        f"the next as soon as the prior result lands instead of pausing to ask "
        f"\"want me to continue?\".\n\n"
    )


def _env_postamble(con, agent_row, mode='voice'):
    """Dynamic context appended AFTER the agent's system prompt.

    Memory grows over time and benefits from recency bias — sitting
    immediately before the conversation history means the model re-reads
    "what you remember about this user" right before deciding the next turn.
    The text-mode disclaimer overrides voice-tool references the system_prompt
    may contain, placed AFTER what it overrides.
    """
    sections = []
    if mode == 'text':
        sections.append(
            "## Surface\n"
            "- **Text mode:** This conversation is written chat, not voice. "
            "The avatar / voice / emotion / gesture tools are NOT available "
            "on this surface — ignore any instructions above that mention "
            "`set_emotion`, `play_gesture`, an avatar, or vocal delivery "
            "through speech expression tags. Respond in text only.\n"
        )
    if agent_row['enable_memory_tools']:
        sections.append(_memory_section(con, agent_row))
    if not sections:
        return ''
    return '\n\n' + '\n\n'.join(sections)


def _memory_section(con, agent_row):
    """Render the per-user memory block for the postamble. Instructions-first,
    data-last on purpose — core memories sit immediately before the
    conversation history for recency."""
    core = memory_tools.core_for(con, agent_row['id'])
    tags = memory_tools.known_tags(con)

    lines = ["## Memory"]

    if tags:
        lines.append(f"**Known tags:** {', '.join(tags)}")
        lines.append('')

    lines.append(
        "Use `recall(query)` to search past memories when the user references "
        "something earlier (\"remember when…\", \"the thing I told you about X\"). "
        "Use `remember(content, scope='core')` for high-signal context worth "
        "pinning into every session (identity, key relationships, long-standing "
        "preferences, ongoing projects, anything the user asks you to always "
        "remember); use `scope='recall'` (default) for everything else worth "
        "keeping. Reuse existing **Known tags** above when tagging so search "
        "stays consistent. Use `forget(memory_id)` when a fact becomes wrong "
        "or the user asks you to forget."
    )
    lines.append('')
    lines.append(
        "**Capture memory-worthy facts proactively.** Don't wait to be told "
        "\"remember this\" — when the user shares something durable and "
        "high-signal call `remember` naturally per your judgement."
    )
    lines.append('')
    lines.append(
        "**Recall before you deny.** If the user asks about something you might "
        "have stored, call `recall` FIRST — never say \"I don't have that yet\" "
        "or \"you haven't told me\" before checking. Bridge the lookup with "
        "natural in-character phrasing (\"let me think back…\", \"give me a "
        "second to check what you've shared…\", \"hmm, that rings a bell — "
        "one moment\") so the answer reads as one continuous thought. After the "
        "result comes back, respond as if you'd been thinking the whole time — "
        "don't pivot with \"actually, I do remember\" or apologize for an "
        "earlier denial (because there shouldn't have been one)."
    )
    lines.append('')

    if core:
        lines.append("**What you remember about this user:**")
        for m in core:
            created = parse_dt(m['created_at'])
            stamped = f"  (remembered {created.strftime('%Y-%m-%d')})" if created else ''
            lines.append(f"- [id={m['id']}] {m['content']}{stamped}")
    else:
        lines.append("You have no stored memories for this user yet.")

    return '\n'.join(lines)


def _resolve_active_background(con, agent_row):
    """Pick the background to apply when a session starts.

    Order of preference (must stay in lockstep with the frontend's
    _hydrateAvatar resolution so hitting Start never visibly flips the scene):
      1. The avatar's curated DEFAULT background.
      2. The most recent Grok-Imagine background generated for this agent.
      3. The avatar's first curated background.
      4. None — the renderer falls back to its built-in CSS default.
    """
    if not agent_row['avatar_id']:
        return None
    bgs = con.execute(
        "SELECT * FROM avatar_backgrounds WHERE avatar_id = ? ORDER BY sequence, id",
        (agent_row['avatar_id'],),
    ).fetchall()
    default = next((b for b in bgs if b['is_default']), None)
    if default:
        return store.background_payload(default)
    imagine = store.latest_imagine_background(con, agent_row['id'])
    if imagine:
        return store.imagine_payload(imagine)
    if bgs:
        return store.background_payload(bgs[0])
    return None


# ---------------------------------------------------------------------------
# Voice mode
# ---------------------------------------------------------------------------

def start_session(con, *, agent, resume_session=None, audio_sample_rate=24000):
    """Mint an ephemeral xAI session and assemble the realtime tools list.

    :param agent: agents row
    :param resume_session: existing sessions row to continue, or None
    :return: dict ready to JSON-serialize for the browser (same shape the
        Odoo module returned, so the ported voice_service.js consumes it
        unchanged).
    """
    # Resume locks the agent to the one the conversation was originally with.
    if resume_session and resume_session['agent_id'] != agent['id']:
        agent = store.get_agent(con, resume_session['agent_id'])
    if not agent['enable_voice_mode']:
        raise UserError("This agent is not enabled for voice mode.")

    config = get_config(con)
    if not config['enabled']:
        raise UserError("Companions are currently disabled in Settings.")

    xai_key = config['xai_api_key']
    if not xai_key:
        raise UserError("xAI API key is not configured. Set it in Settings.")
    voice_model = config['xai_model']

    if resume_session:
        if resume_session['mode'] != 'voice':
            raise UserError("This session was created in text mode and cannot be resumed as voice.")
        session_id = resume_session['id']
        store.update_session(con, session_id, state='draft', ended_at=None)
        session = store.get_session(con, session_id)
    else:
        session = store.create_session(con, agent_id=agent['id'], mode='voice')

    # Mint the ephemeral xAI token (the browser uses it to open the WebSocket).
    try:
        xai_resp = xai_client.mint_ephemeral_token(
            xai_api_key=xai_key,
            client_secrets_url=config['xai_client_secrets_url'],
            expires_after_seconds=3600,
        )
    except Exception:
        # Roll back ONLY a freshly-created session — never delete a session we
        # were resuming. For resume, leave it in 'draft' for a retry.
        if not resume_session:
            con.execute("DELETE FROM sessions WHERE id = ?", (session['id'],))
            con.commit()
        raise

    effective_voice = agent['voice']
    # Browser tool list: set_emotion is static; play_gesture / change_outfit
    # are built per-agent so their enums/descriptions reflect the avatar's
    # wardrobe + custom gesture clips.
    tools = list(browser_tools.BROWSER_TOOLS)
    if agent['enable_gesture_emotion_tools']:
        tools.append(browser_tools.build_play_gesture_tool(store.agent_gesture_dicts(con, agent)))
        change_outfit = browser_tools.build_change_outfit_tool(store.agent_outfit_dicts(con, agent))
        if change_outfit is not None:
            tools.append(change_outfit)
    else:
        tools = [t for t in tools if t['name'] != 'set_emotion']

    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='voice')
    native_function_tools = []
    if agent['enable_grok_imagine_tools']:
        native_function_tools.extend(imagine_tools.IMAGINE_TOOLS)
    if agent['enable_memory_tools']:
        native_function_tools.extend(memory_tools.MEMORY_TOOLS)

    session_update = xai_client.build_session_update(
        voice=effective_voice,
        instructions=(
            _env_preamble(config)
            + _render_prompt(agent)
            + _env_postamble(con, agent, mode='voice')
        ),
        browser_tools=tools,
        mcp_entries=mcp_entries,
        native_function_tools=native_function_tools,
        enable_web_search=bool(agent['enable_web_search']),
        enable_x_search=bool(agent['enable_x_search']),
        audio_sample_rate=audio_sample_rate,
    )

    activate_vals = {'state': 'active', 'last_active_at': utcnow()}
    if not resume_session:
        activate_vals['started_at'] = utcnow()
    store.update_session(con, session['id'], **activate_vals)
    session = store.get_session(con, session['id'])

    replay_items = []
    transcript_history = []
    transcript_truncated = False
    if resume_session:
        replay_items = _build_replay_items(con, session)
        transcript_history, transcript_truncated = _build_transcript_history(
            con, session, limit=config['transcript_display_limit'] or 0,
        )

    avatar = store.avatar_payload(con, agent['avatar_id'])
    active_background = _resolve_active_background(con, agent)
    con.commit()

    return {
        'session_id': session['id'],
        'agent_id': agent['id'],
        'xai_ephemeral_token': xai_resp['token'],
        'xai_realtime_url': config['xai_realtime_url'],
        'xai_model': voice_model,
        'voice': effective_voice,
        'session_update': session_update,
        'avatar': avatar,
        'active_background': active_background,
        'replay_items': replay_items,
        'transcript_history': transcript_history,
        'transcript_truncated': transcript_truncated,
        'total_input_tokens': session['total_input_tokens'] or 0,
        'total_output_tokens': session['total_output_tokens'] or 0,
        'summary_threshold_tokens': config['summary_threshold_tokens'] or 0,
        'tokens_at_last_summary': session['tokens_at_last_summary'] or 0,
    }


def _build_replay_items(con, session):
    """Ordered conversation.item.create payloads for resuming a session.

    Filters out messages rolled up into a summary; the summary message itself
    is included in their place. Rollups are hoisted to the front of the wire
    order so the model sees background summary before recent verbatim turns.
    Tool rows replay too (function_call / function_call_output pairs by
    call_id); rows missing xai_call_id are skipped — xAI rejects orphans.
    """
    msgs = store.session_messages(con, session['id'], where="AND is_summarized_into IS NULL")
    rollups = [m for m in msgs if m['is_summary_rollup']]
    others = [m for m in msgs if not m['is_summary_rollup']]
    items = []
    for m in rollups + others:
        if m['role'] == 'user':
            items.append({
                'type': 'message',
                'role': 'user',
                'content': [{'type': 'input_text', 'text': m['content'] or ''}],
            })
        elif m['role'] == 'assistant':
            items.append({
                'type': 'message',
                'role': 'assistant',
                'content': [{'type': 'text', 'text': m['content'] or ''}],
            })
        elif m['role'] == 'system':
            sys_item = {
                'type': 'message',
                'role': 'system',
                'content': [{'type': 'text', 'text': m['content'] or ''}],
            }
            # Display-layer hint, stripped by the JS before forwarding to xAI.
            if m['is_summary_rollup']:
                sys_item['_summary_rollup'] = True
            items.append(sys_item)
        elif m['role'] == 'tool_call' and m['xai_call_id']:
            items.append({
                'type': 'function_call',
                'call_id': m['xai_call_id'],
                'name': m['tool_name'] or '',
                'arguments': m['tool_arguments_json'] or '{}',
            })
        elif m['role'] == 'tool_result' and m['xai_call_id']:
            items.append({
                'type': 'function_call_output',
                'call_id': m['xai_call_id'],
                'output': m['tool_result_json'] or m['content'] or '',
            })
    return items


def _build_transcript_history(con, session, limit=None):
    """Full chronological message list for the UI transcript. No filter on
    is_summarized_into (the user sees everything); summary rollups themselves
    are skipped (backend artifact). Optional `limit` keeps the most-recent N.
    Returns (items, truncated)."""
    truncated = False
    if limit and limit > 0:
        recent = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_summary_rollup = 0 "
            "ORDER BY sequence DESC, id DESC LIMIT ?",
            (session['id'], limit),
        ).fetchall()
        if recent:
            oldest = recent[-1]
            older = con.execute(
                "SELECT 1 FROM messages WHERE session_id = ? AND is_summary_rollup = 0 "
                "AND (sequence < ? OR (sequence = ? AND id < ?)) LIMIT 1",
                (session['id'], oldest['sequence'], oldest['sequence'], oldest['id']),
            ).fetchone()
            truncated = bool(older)
        msgs = sorted(recent, key=lambda m: (m['sequence'], m['id']))
    else:
        msgs = store.session_messages(con, session['id'], where="AND is_summary_rollup = 0")
    items = []
    for m in msgs:
        if m['role'] == 'user':
            items.append({
                'type': 'message',
                'role': 'user',
                'content': [{'type': 'input_text', 'text': m['content'] or ''}],
            })
        elif m['role'] == 'assistant':
            items.append({
                'type': 'message',
                'role': 'assistant',
                'content': [{'type': 'text', 'text': m['content'] or ''}],
            })
        elif m['role'] == 'tool_call' and m['xai_call_id']:
            items.append({
                'type': 'function_call',
                'call_id': m['xai_call_id'],
                'name': m['tool_name'] or '',
                'arguments': m['tool_arguments_json'] or '{}',
            })
        elif m['role'] == 'tool_result' and m['xai_call_id']:
            items.append({
                'type': 'function_call_output',
                'call_id': m['xai_call_id'],
                'output': m['tool_result_json'] or m['content'] or '',
            })
    return items, truncated


def append_messages(con, session, messages, total_input_tokens=None, total_output_tokens=None):
    """Bulk-create message rows + persist running token totals.

    The browser sends running totals (not deltas) on every flush; persistence
    rule is "write whichever is larger" — idempotent against retries and
    tolerant of out-of-order RPCs. After persisting, re-evaluate the summary
    threshold using token pressure since the last rollup.
    """
    if session['state'] != 'active':
        raise ValidationError("Cannot append to a session that is not active.")

    next_seq = store.next_sequence(con, session['id'])
    created = 0
    for m in messages:
        if m.get('role') not in ('user', 'assistant', 'system', 'tool_call', 'tool_result'):
            continue
        store.insert_message(
            con, session['id'],
            sequence=next_seq + created,
            role=m['role'],
            content=m.get('content', '') or '',
            tool_name=m.get('tool_name'),
            tool_arguments_json=m.get('tool_arguments_json'),
            tool_result_json=m.get('tool_result_json'),
            xai_item_id=m.get('xai_item_id'),
            xai_call_id=m.get('xai_call_id'),
            xai_previous_item_id=m.get('xai_previous_item_id'),
        )
        created += 1

    token_updates = {}
    if total_input_tokens is not None and total_input_tokens > (session['total_input_tokens'] or 0):
        token_updates['total_input_tokens'] = int(total_input_tokens)
    if total_output_tokens is not None and total_output_tokens > (session['total_output_tokens'] or 0):
        token_updates['total_output_tokens'] = int(total_output_tokens)
    if token_updates:
        store.update_session(con, session['id'], **token_updates)
    session = store.get_session(con, session['id'])

    config = get_config(con)
    if session['mode'] == 'text':
        threshold_tokens = config['summary_threshold_tokens_text'] or 0
    else:
        threshold_tokens = config['summary_threshold_tokens'] or 0
    just_flagged = False
    if threshold_tokens > 0 and not session['needs_summary']:
        current_total = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
        delta = current_total - (session['tokens_at_last_summary'] or 0)
        if delta >= threshold_tokens:
            store.update_session(con, session['id'], needs_summary=1)
            just_flagged = True

    last = con.execute(
        "SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
        (session['id'],),
    ).fetchone()
    if not session['title_generated']:
        maybe_generate_session_title(con, session)
    session = store.get_session(con, session['id'])
    con.commit()
    return {
        'ok': True,
        'sequence_high_water': last['sequence'] if last else 0,
        'created': created,
        'needs_compaction': bool(session['needs_summary'] or just_flagged),
        # No daily caps in the standalone (BYOK) — fields kept for JS compat.
        'cap_warning': False,
        'cap_exceeded': False,
    }


def append_meta(con, session, patches):
    """Back-fill xai id metadata on rows already created via append_messages,
    matched on (session, xai_call_id). Only fields that are still NULL are
    updated — never clobbering values captured at the source event."""
    if not patches:
        return {'ok': True, 'patched': 0}
    patched = 0
    for p in patches:
        call_id = p.get('call_id')
        if not call_id:
            continue
        rows = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND xai_call_id = ?",
            (session['id'], call_id),
        ).fetchall()
        for row in rows:
            updates = {}
            if p.get('xai_item_id') and not row['xai_item_id']:
                updates['xai_item_id'] = p['xai_item_id']
            if p.get('xai_previous_item_id') and not row['xai_previous_item_id']:
                updates['xai_previous_item_id'] = p['xai_previous_item_id']
            if updates:
                cols = ", ".join(f"{k} = ?" for k in updates)
                con.execute(f"UPDATE messages SET {cols} WHERE id = ?", (*updates.values(), row['id']))
                patched += 1
    con.commit()
    return {'ok': True, 'patched': patched}


def compact_session(con, session):
    """Generate a summary so the next session resume sees a compacted history.
    The browser pairs this with a WebSocket restart in resume mode — the
    replay path then produces summary + recent verbatim turns."""
    if session['state'] != 'active':
        return {'compacted': False, 'reason': 'session_not_active'}
    if not session['needs_summary']:
        return {'compacted': False, 'reason': 'no_pending_summary'}

    rollup_id = generate_session_summary(con, session)
    if not rollup_id:
        store.update_session(con, session['id'], needs_summary=0)
        con.commit()
        return {'compacted': False, 'reason': 'nothing_absorbed'}

    con.commit()
    return {'compacted': True, 'rollup_id': rollup_id}


def end_session(con, session, *, reason='client', total_input_tokens=0, total_output_tokens=0):
    """Settle session: mark ended, accumulate usage, optionally summarize."""
    if session['state'] == 'ended':
        return {'ok': True, 'summary': session['summary']}

    token_updates = {}
    if total_input_tokens and total_input_tokens > (session['total_input_tokens'] or 0):
        token_updates['total_input_tokens'] = int(total_input_tokens)
    if total_output_tokens and total_output_tokens > (session['total_output_tokens'] or 0):
        token_updates['total_output_tokens'] = int(total_output_tokens)
    ended = utcnow()
    store.update_session(con, session['id'], state='ended', ended_at=ended,
                         last_active_at=ended, **token_updates)
    session = store.get_session(con, session['id'])

    if session['needs_summary']:
        try:
            generate_session_summary(con, session)
        except Exception as e:
            _logger.warning('Summary generation failed for session %s: %s', session['id'], e)

    session = store.get_session(con, session['id'])
    con.commit()
    return {'ok': True, 'summary': session['summary']}


_SUMMARY_TOOL_FIELD_TRUNCATE = 500


def _truncate_for_summary(text):
    """Cap tool arg/result strings before they hit the summarizer — full record
    dumps are noise; the summarizer only needs enough to ground its prose."""
    if not text:
        return ''
    text = str(text)
    if len(text) <= _SUMMARY_TOOL_FIELD_TRUNCATE:
        return text
    return text[:_SUMMARY_TOOL_FIELD_TRUNCATE] + f'… (truncated, {len(text)} chars total)'


# Per-process serialization for title generation + summary rollups (the Odoo
# module used pg advisory locks / SELECT FOR UPDATE; a process lock gives the
# same guarantee in a single-process server).
_title_lock = threading.Lock()
_summary_lock = threading.Lock()


def maybe_generate_session_title(con, session):
    """Auto-title the session after the first user/assistant exchange. No-op
    once title_generated is set, so a user-edited title is never clobbered.
    Failures are swallowed — title generation is a UX nicety."""
    if session['title_generated']:
        return
    if not _title_lock.acquire(blocking=False):
        return
    try:
        fresh = store.get_session(con, session['id'])
        if fresh['title_generated']:
            return
        user_row = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND role = 'user' AND content != '' "
            "ORDER BY sequence ASC, id ASC LIMIT 1",
            (session['id'],),
        ).fetchone()
        assistant_row = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' "
            "ORDER BY sequence ASC, id ASC LIMIT 1",
            (session['id'],),
        ).fetchone()
        if not user_row or not assistant_row:
            return
        transcript = (
            f'User: {(user_row["content"] or "").strip()}\n'
            f'Assistant: {(assistant_row["content"] or "").strip()}'
        )
        config = get_config(con)
        try:
            title, usage = xai_client.generate_title(
                xai_api_key=config['xai_api_key'],
                responses_url=config['xai_responses_url'],
                summary_model=config['summary_model'],
                transcript=transcript,
            )
        except Exception:
            _logger.exception('Auto-title generation failed for session %s', session['id'])
            return
        store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
        if not title:
            return
        store.update_session(con, session['id'], name=title, title_generated=1)
    finally:
        _title_lock.release()


def _build_verbatim_transcript(to_summarize):
    """Render THIS block's user/assistant turns in full for durable episode
    storage. Unlike the summary transcript this excludes any prior rollup (we
    want only this segment's real turns) and does not truncate user/assistant
    content; tool activity is reduced to a one-line marker so the stored
    transcript stays readable without raw JSON payloads."""
    lines = []
    for m in to_summarize:
        if m['role'] == 'user':
            lines.append(f'User: {m["content"] or ""}')
        elif m['role'] == 'assistant':
            lines.append(f'Assistant: {m["content"] or ""}')
        elif m['role'] == 'tool_call':
            lines.append(f'[tool call: {m["tool_name"] or "tool"}]')
        elif m['role'] == 'tool_result':
            lines.append(f'[tool result: {m["tool_name"] or "tool"}]')
    return '\n'.join(lines)


def _extract_and_store_memories(con, session, config, to_summarize, transcript):
    """Distil durable memory from a freshly rolled-up block and persist it.

    Reads the same flattened `transcript` the summary used, asks the model for
    fact operations + one episode, accrues the call's cost, then writes via
    memory_tools.apply_extraction_ops. The verbatim segment transcript is
    stored inline on the episode so it survives transcript pruning. Best-effort;
    the caller isolates failures so compaction is never broken.
    """
    agent_id = session['agent_id']
    if agent_id:
        core_rows = con.execute(
            "SELECT id, content FROM memories WHERE scope = 'core' AND memory_type = 'fact' "
            "AND (agent_id = ? OR agent_id IS NULL) ORDER BY created_at ASC, id ASC",
            (agent_id,),
        ).fetchall()
    else:
        core_rows = con.execute(
            "SELECT id, content FROM memories WHERE scope = 'core' AND memory_type = 'fact' "
            "AND agent_id IS NULL ORDER BY created_at ASC, id ASC",
        ).fetchall()
    existing_core = [(r['id'], r['content']) for r in core_rows]

    parsed, usage = xai_client.generate_memory_extraction(
        xai_api_key=config['xai_api_key'],
        responses_url=config['xai_responses_url'],
        summary_model=config['summary_model'],
        transcript=transcript,
        existing_core=existing_core,
        known_tags=memory_tools.known_tags(con),
        reasoning_effort=None,
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
    if not parsed:
        return
    verbatim = _build_verbatim_transcript(to_summarize)
    counts = memory_tools.apply_extraction_ops(
        con, agent_id,
        ops=parsed.get('facts'), episode=parsed.get('episode'),
        transcript=verbatim, session_id=session['id'],
    )
    _logger.info('Memory extraction for session %s: %s', session['id'], counts)


def generate_session_summary(con, session):
    """Roll up older turns into a single system-role summary message.

    Behaviours (ported):
      1. The most recent K user/assistant turns stay verbatim; the summary
         absorbs anything older. Tool rows attach to whichever side of the
         boundary they sit on by sequence.
      2. Tool calls/results fold INTO the summary input in compressed form so
         summaries stay grounded in real values.
      3. An existing rollup is folded in and superseded — at most one active
         rollup at a time.
      4. Concurrent callers are serialized via a process lock; after acquiring
         it the runner re-reads needs_summary and bails if a sibling cleared it.

    Returns the new rollup message id, or None.
    """
    with _summary_lock:
        session = store.get_session(con, session['id'])
        if not session['needs_summary']:
            return None

        config = get_config(con)
        keep_recent = max(0, config['summary_keep_recent_messages'] or 0)

        user_assistant_rows = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
            "AND role IN ('user', 'assistant') ORDER BY sequence ASC, id ASC",
            (session['id'],),
        ).fetchall()

        if keep_recent and len(user_assistant_rows) <= keep_recent:
            store.update_session(con, session['id'], needs_summary=0)
            return None

        cutoff_sequence = None
        if keep_recent and len(user_assistant_rows) > keep_recent:
            cutoff_sequence = user_assistant_rows[-keep_recent]['sequence']

        q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
             "AND role IN ('user', 'assistant', 'tool_call', 'tool_result')")
        params = [session['id']]
        if cutoff_sequence is not None:
            q += " AND sequence < ?"
            params.append(cutoff_sequence)
        q += " ORDER BY sequence ASC, id ASC"
        to_summarize = con.execute(q, params).fetchall()

        if not to_summarize:
            store.update_session(con, session['id'], needs_summary=0)
            return None

        prior_rollup = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_summary_rollup = 1 "
            "AND is_summarized_into IS NULL ORDER BY sequence ASC LIMIT 1",
            (session['id'],),
        ).fetchone()

        transcript_lines = []
        if prior_rollup:
            transcript_lines.append(f'[Prior summary]\n{prior_rollup["content"]}\n')
        for m in to_summarize:
            if m['role'] == 'user':
                transcript_lines.append(f'User: {m["content"] or ""}')
            elif m['role'] == 'assistant':
                transcript_lines.append(f'Assistant: {m["content"] or ""}')
            elif m['role'] == 'tool_call':
                args = _truncate_for_summary(m['tool_arguments_json'] or m['content'] or '')
                transcript_lines.append(f'[Tool call] {m["tool_name"] or "tool"}({args})')
            elif m['role'] == 'tool_result':
                output = _truncate_for_summary(m['tool_result_json'] or m['content'] or '')
                transcript_lines.append(f'[Tool result] {m["tool_name"] or "tool"} -> {output}')

        transcript = '\n'.join(transcript_lines)

        summary_text, summary_usage = xai_client.generate_summary(
            xai_api_key=config['xai_api_key'],
            responses_url=config['xai_responses_url'],
            summary_model=config['summary_model'],
            transcript=transcript,
            reasoning_effort=None,
        )
        store.accrue_usd_ticks(con, store.extract_cost_ticks(summary_usage))

        # Rollup at the END of the sequence (audit-friendly); replay paths
        # hoist it to the front of the wire order.
        rollup_id = store.insert_message(
            con, session['id'],
            role='system',
            content=summary_text,
            is_summary_rollup=1,
        )

        absorbed_ids = [m['id'] for m in to_summarize]
        if prior_rollup:
            absorbed_ids.append(prior_rollup['id'])
        con.execute(
            f"UPDATE messages SET is_summarized_into = ? "
            f"WHERE id IN ({','.join('?' * len(absorbed_ids))})",
            (rollup_id, *absorbed_ids),
        )

        session = store.get_session(con, session['id'])
        current_total = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
        store.update_session(
            con, session['id'],
            summary=summary_text,
            needs_summary=0,
            tokens_at_last_summary=current_total,
        )

        # Automatic memory extraction — distil durable facts + one episodic
        # memory from this same block, so load-bearing detail survives outside
        # the lossy rollup and "remember when…" moments become retrievable.
        # Best-effort and fully isolated: any failure must never break
        # compaction (mirrors maybe_generate_session_title).
        agent = store.get_agent(con, session['agent_id'])
        if agent['enable_memory_tools'] and config['enable_memory_extraction']:
            try:
                _extract_and_store_memories(con, session, config, to_summarize, transcript)
            except Exception:
                _logger.exception('Memory extraction failed for session %s', session['id'])

        return rollup_id


# ---------------------------------------------------------------------------
# Text mode (xAI Responses API)
# ---------------------------------------------------------------------------

# Native tool names that execute server-side directly during the text response
# loop. The standalone has no browser tools in text mode (the Odoo navigation
# / DOM tools are gone), so the loop always resolves server-side.
NATIVE_TOOL_NAMES_TEXT = imagine_tools.IMAGINE_TOOL_NAMES | memory_tools.MEMORY_TOOL_NAMES
TEXT_BROWSER_TOOL_NAMES = set()


def _build_text_tools(agent, *, mcp_entries, enable_web_search, enable_x_search,
                      enable_code_execution=False,
                      enable_grok_imagine_tools=False,
                      enable_memory_tools=False):
    """Assemble the tools list for /v1/responses calls in text mode."""
    tools = []
    for entry in mcp_entries or []:
        tools.append(entry)
    if enable_grok_imagine_tools:
        # Text mode only gets create_image + edit_image — change_background
        # has no live avatar canvas to swap.
        for entry in imagine_tools.IMAGINE_TEXT_TOOLS:
            tools.append(entry)
    if enable_memory_tools:
        for entry in memory_tools.MEMORY_TOOLS:
            tools.append(entry)
    if enable_web_search:
        tools.append({'type': 'web_search'})
    if enable_x_search:
        tools.append({'type': 'x_search'})
    if enable_code_execution:
        tools.append({'type': 'code_interpreter'})
    return tools


def _replay_text_messages(con, session):
    """Rebuild a Responses-API `input` array from local message rows. Used
    when starting a fresh response chain (no previous_response_id) for a
    session that already has history. Rollups hoist to the front; tool rows
    are skipped (assistant prose carries the gist)."""
    rows = con.execute(
        "SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
        "AND role IN ('user', 'assistant', 'system') ORDER BY sequence ASC, id ASC",
        (session['id'],),
    ).fetchall()
    rollups = [m for m in rows if m['is_summary_rollup']]
    others = [m for m in rows if not m['is_summary_rollup']]
    items = []
    for m in rollups + others:
        text = m['content'] or ''
        if not text:
            continue
        if m['role'] == 'user':
            items.append({'role': 'user', 'content': [{'type': 'input_text', 'text': text}]})
        elif m['role'] == 'assistant':
            items.append({'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]})
        elif m['role'] == 'system':
            items.append({'role': 'system', 'content': [{'type': 'input_text', 'text': text}]})
    return items


def _agent_thumbnail_url(agent):
    return agent['chat_thumbnail_path'] or None


def start_text_session(con, *, agent, resume_session=None):
    """Create or reactivate a text-mode session and return the bootstrap
    payload the browser needs to render history and submit its first turn."""
    if resume_session and resume_session['agent_id'] != agent['id']:
        agent = store.get_agent(con, resume_session['agent_id'])
    if not agent['enable_text_mode']:
        raise UserError("This agent is not enabled for text-mode chat.")

    config = get_config(con)
    if not config['enabled']:
        raise UserError("Companions are currently disabled in Settings.")
    if not config['xai_api_key']:
        raise UserError("xAI API key is not configured. Set it in Settings.")

    if resume_session:
        if resume_session['mode'] != 'text':
            raise UserError("This session was created in voice mode and cannot be resumed as text.")
        store.update_session(con, resume_session['id'], state='draft', ended_at=None)
        session = store.get_session(con, resume_session['id'])
    else:
        session = store.create_session(con, agent_id=agent['id'], mode='text')

    activate_vals = {'state': 'active', 'last_active_at': utcnow()}
    if not resume_session:
        activate_vals['started_at'] = utcnow()
    store.update_session(con, session['id'], **activate_vals)
    session = store.get_session(con, session['id'])

    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='text')
    instructions = (
        _env_preamble(config)
        + _render_prompt(agent)
        + _env_postamble(con, agent, mode='text')
    )

    transcript_messages = []
    if resume_session:
        rows = store.session_messages(con, session['id'], where="AND is_summarized_into IS NULL")
        for m in rows:
            attachments = [
                {
                    'xai_file_id': a['xai_file_id'],
                    'filename': a['filename'],
                    'size_bytes': a['size_bytes'],
                    'mimetype': a['mimetype'],
                }
                for a in store.attachments_for_message(con, m['id'])
            ]
            transcript_messages.append({
                'sequence': m['sequence'],
                'role': m['role'],
                'content': m['content'] or '',
                'tool_name': m['tool_name'],
                'tool_arguments_json': m['tool_arguments_json'],
                'tool_result_json': m['tool_result_json'],
                'is_summary_rollup': bool(m['is_summary_rollup']),
                'attachments': attachments,
            })
    con.commit()

    return {
        'session_id': session['id'],
        'mode': 'text',
        'agent': {
            'id': agent['id'],
            'name': agent['name'],
            'reasoning_effort': agent['reasoning_effort'],
            'chat_thumbnail_url': _agent_thumbnail_url(agent),
        },
        'instructions': instructions,
        'tools': _build_text_tools(
            agent,
            mcp_entries=mcp_entries,
            enable_web_search=bool(agent['enable_web_search']),
            enable_x_search=bool(agent['enable_x_search']),
            enable_code_execution=bool(agent['enable_code_execution']),
            enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']),
            enable_memory_tools=bool(agent['enable_memory_tools']),
        ),
        'model': config['text_model'],
        'previous_response_id': session['previous_response_id'] or None,
        'last_response_at': session['last_response_at'] or None,
        'transcript': transcript_messages,
        'total_input_tokens': session['total_input_tokens'] or 0,
        'total_output_tokens': session['total_output_tokens'] or 0,
        'summary_threshold_tokens': config['summary_threshold_tokens_text'] or 0,
        'tokens_at_last_summary': session['tokens_at_last_summary'] or 0,
        'summary': session['summary'] or None,
    }


def _persist_text_message(con, session, *, role, content='', tool_name=None,
                          tool_arguments_json=None, tool_result_json=None,
                          xai_call_id=None, attachments=None):
    """Append one row to a text session, continuing the sequence high water."""
    msg_id = store.insert_message(
        con, session['id'],
        role=role,
        content=content or '',
        tool_name=tool_name,
        tool_arguments_json=tool_arguments_json,
        tool_result_json=tool_result_json,
        xai_call_id=xai_call_id,
    )
    for a in (attachments or []):
        if not a.get('xai_file_id'):
            continue
        # Coerce expires_at to an ISO string if it round-tripped as unix int.
        expires_at = a.get('expires_at')
        if isinstance(expires_at, (int, float)):
            expires_at = xai_client._normalize_xai_timestamp(expires_at)
        a = {**a, 'expires_at': expires_at}
        store.insert_attachment(con, msg_id, a)
    return msg_id


def _accrue_text_usage(con, session, usage):
    """Apply per-call usage from a Responses API response to the session
    totals + the spend counter. Token totals drive the summarization threshold."""
    if not isinstance(usage, dict):
        return
    new_in = int(usage.get('input_tokens') or 0)
    new_out = int(usage.get('output_tokens') or 0)
    in_details = usage.get('input_tokens_details')
    new_cached = int(in_details.get('cached_tokens') or 0) if isinstance(in_details, dict) else 0

    session = store.get_session(con, session['id'])
    store.update_session(
        con, session['id'],
        total_input_tokens=(session['total_input_tokens'] or 0) + new_in,
        total_output_tokens=(session['total_output_tokens'] or 0) + new_out,
        cached_input_tokens=(session['cached_input_tokens'] or 0) + new_cached,
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))


def _maybe_flag_summary_text(con, session):
    """Threshold check for text mode. Sets needs_summary when the configured
    text threshold has been crossed since the last rollup."""
    session = store.get_session(con, session['id'])
    config = get_config(con)
    threshold = config['summary_threshold_tokens_text'] or 0
    if not threshold:
        return False
    current = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
    delta = current - (session['tokens_at_last_summary'] or 0)
    if session['needs_summary']:
        return False
    if delta >= threshold:
        store.update_session(con, session['id'], needs_summary=1)
        return True
    return False


def text_send_turn(con, *, session, user_text=None, attachment_file_ids=None):
    """Drive one or more /v1/responses legs until the assistant returns plain
    text. All function tools in the standalone (imagine + memory) execute
    server-side inside this loop — there is no browser round-trip in text mode.
    MCP tools are entirely server-side at xAI; they appear in the response
    output for diagnostics only."""
    if session['state'] != 'active':
        raise ValidationError("Session is not active.")
    if session['mode'] != 'text':
        raise ValidationError("Session is not a text-mode session.")

    config = get_config(con)
    agent = store.get_agent(con, session['agent_id'])
    xai_key = config['xai_api_key']
    if not xai_key:
        raise UserError("xAI API key is not configured.")

    # Persist the user message + attachments on the FIRST leg only.
    if user_text is not None:
        if session['pending_native_outputs_json']:
            store.update_session(con, session['id'], pending_native_outputs_json=None)
        attachment_data = []
        for entry in (attachment_file_ids or []):
            if isinstance(entry, str):
                attachment_data.append({'xai_file_id': entry, 'filename': entry})
            elif isinstance(entry, dict) and entry.get('xai_file_id'):
                attachment_data.append(entry)
        _persist_text_message(
            con, session,
            role='user',
            content=user_text or '',
            attachments=attachment_data,
        )

    # Chain via previous_response_id when available; xAI retains stored
    # responses for ~30 days — drop a stale chain and rebuild from local rows.
    previous_response_id = session['previous_response_id'] or None
    if previous_response_id and session['last_response_at']:
        last_at = parse_dt(session['last_response_at'])
        if last_at and datetime.utcnow() - last_at > timedelta(days=29):
            previous_response_id = None

    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='text')
    tools = _build_text_tools(
        agent,
        mcp_entries=mcp_entries,
        enable_web_search=bool(agent['enable_web_search']),
        enable_x_search=bool(agent['enable_x_search']),
        enable_code_execution=bool(agent['enable_code_execution']),
        enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']),
        enable_memory_tools=bool(agent['enable_memory_tools']),
    )
    instructions = (
        _env_preamble(config)
        + _render_prompt(agent)
        + _env_postamble(con, agent, mode='text')
    )

    pending_outputs = []
    is_first_leg = True
    max_iterations = 8
    accumulated_native_echo = []
    accumulated_mcp_results_echo = []

    while max_iterations > 0:
        max_iterations -= 1

        chain_alive = bool(previous_response_id)

        input_items = []
        if is_first_leg and not chain_alive:
            input_items.extend(_replay_text_messages(con, session))
        if pending_outputs:
            input_items.extend(pending_outputs)
            pending_outputs = []
        if is_first_leg and user_text is not None:
            content = [{'type': 'input_text', 'text': user_text or ''}]
            for entry in (attachment_file_ids or []):
                file_id = entry if isinstance(entry, str) else (
                    entry.get('xai_file_id') if isinstance(entry, dict) else None
                )
                if file_id:
                    content.append({'type': 'input_file', 'file_id': file_id})
            input_items.append({'role': 'user', 'content': content})

        if not input_items and not chain_alive:
            con.commit()
            return {'type': 'error', 'message': 'No input to send.'}

        try:
            body = xai_client.create_response(
                xai_api_key=xai_key,
                responses_url=config['xai_responses_url'],
                model=config['text_model'],
                input_items=input_items,
                instructions=None if chain_alive else instructions,
                tools=tools,
                reasoning_effort=agent['reasoning_effort'] or 'low',
                previous_response_id=previous_response_id,
                prompt_cache_key=f'rexclaw:{agent["id"]}',
            )
        except UserError:
            con.commit()
            raise
        except Exception as e:
            con.commit()
            _logger.exception('Responses API call failed')
            raise UserError(f"Text chat request failed: {e}")

        is_first_leg = False

        response_id = body.get('id') or None
        usage = body.get('usage') or {}
        _accrue_text_usage(con, session, usage)

        if response_id:
            store.update_session(con, session['id'],
                                 previous_response_id=response_id,
                                 last_response_at=utcnow())
            previous_response_id = response_id

        output = body.get('output') or []
        assistant_text_chunks = []
        function_calls = []
        mcp_results_echo = []
        incomplete_reason = None
        if isinstance(body.get('incomplete_details'), dict):
            incomplete_reason = body['incomplete_details'].get('reason')

        for item in output:
            if not isinstance(item, dict):
                continue
            itype = item.get('type')
            if itype == 'message':
                for part in (item.get('content') or []):
                    if isinstance(part, dict) and part.get('type') == 'output_text':
                        text = part.get('text')
                        if text:
                            assistant_text_chunks.append(text)
            elif itype == 'function_call':
                function_calls.append({
                    'call_id': item.get('call_id'),
                    'name': item.get('name'),
                    'arguments': item.get('arguments') or '{}',
                })
            elif itype == 'mcp_call':
                # Server-side MCP execution at xAI: persist the call+result
                # rows so MCP failures are visible in the transcript.
                mcp_call_id = item.get('id') or item.get('call_id')
                mcp_name = item.get('name') or 'mcp'
                mcp_args = item.get('arguments') or ''
                mcp_status = item.get('status')
                mcp_error = item.get('error')
                mcp_output = item.get('output') or ''
                if mcp_status == 'failed' or mcp_error:
                    err = mcp_error if isinstance(mcp_error, dict) else {}
                    err_type = err.get('type') or 'failed'
                    err_msg = err.get('message') or (str(mcp_error) if mcp_error else '')
                    result_content = f"{err_type}: {err_msg}" if err_msg else err_type
                else:
                    result_content = mcp_output or 'ok'
                _persist_text_message(
                    con, session,
                    role='tool_call',
                    content=f"{mcp_name}({mcp_args})",
                    tool_name=mcp_name,
                    tool_arguments_json=mcp_args,
                    xai_call_id=mcp_call_id,
                )
                _persist_text_message(
                    con, session,
                    role='tool_result',
                    content=result_content,
                    tool_name=mcp_name,
                    tool_result_json=result_content,
                    xai_call_id=mcp_call_id,
                )
                mcp_results_echo.append({
                    'call_id': mcp_call_id,
                    'name': mcp_name,
                    'arguments': mcp_args,
                    'output': result_content,
                })

        assistant_text = ''.join(assistant_text_chunks).strip()
        if assistant_text:
            _persist_text_message(con, session, role='assistant', content=assistant_text)
            fresh = store.get_session(con, session['id'])
            if not fresh['title_generated']:
                maybe_generate_session_title(con, fresh)

        accumulated_mcp_results_echo.extend(mcp_results_echo)

        if not function_calls:
            _maybe_flag_summary_text(con, session)
            fresh = store.get_session(con, session['id'])
            con.commit()
            return {
                'type': 'complete',
                'response_id': response_id,
                'assistant_text': assistant_text,
                'mcp_results': accumulated_mcp_results_echo,
                'native_results': accumulated_native_echo,
                'incomplete_reason': incomplete_reason,
                'usage': usage,
                'cap_warning': False,
                'cap_exceeded': False,
                'needs_compaction': bool(fresh['needs_summary']),
            }

        # Every function call executes server-side in the standalone.
        native_outputs = []
        for fc in function_calls:
            call_id = fc.get('call_id')
            name = fc.get('name')
            _persist_text_message(
                con, session,
                role='tool_call',
                content=f"{name}({fc.get('arguments') or ''})",
                tool_name=name,
                tool_arguments_json=fc.get('arguments') or '',
                xai_call_id=call_id,
            )
            try:
                args = json.loads(fc.get('arguments') or '{}')
            except Exception:
                args = {}
            if name in imagine_tools.IMAGINE_TOOL_NAMES:
                result = imagine_tools.execute_imagine_tool(con, session, name, args)
            elif name in memory_tools.MEMORY_TOOL_NAMES:
                if not agent['enable_memory_tools']:
                    result = {'ok': False, 'reason': 'tool_disabled',
                              'message': 'Memory tools are disabled on this agent.'}
                else:
                    result = memory_tools.execute_memory_tool(con, session, name, args)
            else:
                result = {'error': f'Unknown tool: {name}'}
            output_str = json.dumps(result, default=str)
            _persist_text_message(
                con, session,
                role='tool_result',
                content=output_str,
                tool_name=name,
                tool_result_json=output_str,
                xai_call_id=call_id,
            )
            native_outputs.append({
                'type': 'function_call_output',
                'call_id': call_id,
                'output': output_str,
            })
            accumulated_native_echo.append({
                'call_id': call_id,
                'name': name,
                'arguments': fc.get('arguments') or '',
                'output': output_str,
            })

        pending_outputs.extend(native_outputs)

    _logger.warning('text_send_turn iteration cap reached for session %s', session['id'])
    fresh = store.get_session(con, session['id'])
    con.commit()
    return {
        'type': 'complete',
        'response_id': previous_response_id,
        'assistant_text': '',
        'mcp_results': accumulated_mcp_results_echo,
        'native_results': accumulated_native_echo,
        'incomplete_reason': 'tool_loop_cap',
        'usage': {},
        'cap_warning': False,
        'cap_exceeded': False,
        'needs_compaction': bool(fresh['needs_summary']),
    }


def text_compact(con, session):
    """Roll up older text-mode turns into a single summary, then break the xAI
    response chain so the next turn re-seeds with the summary as input."""
    if session['state'] != 'active':
        return {'compacted': False, 'reason': 'session_not_active'}
    if session['mode'] != 'text':
        return {'compacted': False, 'reason': 'wrong_mode'}
    if not session['needs_summary']:
        return {'compacted': False, 'reason': 'no_pending_summary'}

    rollup_id = generate_session_summary(con, session)
    if not rollup_id:
        store.update_session(con, session['id'], needs_summary=0)
        con.commit()
        return {'compacted': False, 'reason': 'nothing_absorbed'}

    # Breaking the chain forces the next turn to re-seed via the replay path.
    store.update_session(con, session['id'],
                         previous_response_id=None, last_response_at=None)
    con.commit()
    return {'compacted': True, 'rollup_id': rollup_id}


def upload_text_attachment(con, *, session, filename, content_bytes, mimetype):
    """Server-side proxy for /v1/files. Returns metadata the browser hands back
    on the next /send call. No attachment row is created here — that happens
    when /send persists the user message, so a file uploaded but never sent
    doesn't pollute the transcript."""
    if session['state'] != 'active':
        raise ValidationError("Session is not active.")
    if session['mode'] != 'text':
        raise ValidationError("Attachments are only supported in text mode.")
    config = get_config(con)
    xai_key = config['xai_api_key']
    if not xai_key:
        raise UserError("xAI API key is not configured.")
    max_bytes = 48 * 1024 * 1024  # xAI's per-file ceiling for chat
    if len(content_bytes) > max_bytes:
        raise UserError(f"File too large ({len(content_bytes)} bytes). Max is 48 MB.")
    return xai_client.upload_file(
        xai_api_key=xai_key,
        files_url=config['xai_files_url'],
        filename=filename,
        content_bytes=content_bytes,
        mimetype=mimetype,
        expires_after_seconds=config['file_default_expiry_seconds'] or 0,
    )
