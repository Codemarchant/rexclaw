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
import mimetypes
import re
import threading
import uuid
from datetime import datetime, timedelta

from . import xai_client, browser_tools, delegate_tools, imagine_tools, memory_tools, store
from .db import FILES_DIR, get_config, utcnow, parse_dt
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


def _group_call_note(agent_row, group_peers, manual_turn):
    """Instructions block for multi-agent group calls.

    Explains the call topology to the agent: who else is in the call, how
    relayed speaker labels work, and (for peer legs, which run with manual
    turn detection and never hear raw mic audio) that turns are granted by
    an external director rather than voice activity. Empty for solo calls.

    Deliberately refers to "the user" generically — the user's name is not
    embedded here (relayed lines still carry it as a speaker label).
    """
    if not group_peers:
        return ''
    peer_list = ', '.join(n for n in group_peers if n) or 'other companions'
    lines = [
        "\n\n## Group voice call\n",
        f"- You ({agent_row['name']}) are in a LIVE GROUP VOICE CALL with the user "
        f"and other AI companion(s): {peer_list}. Everyone "
        "hears everything said in the call.\n",
        "- Messages relayed from other participants appear prefixed with "
        "their name in brackets, e.g. `[Ara]: …`; the user's lines are "
        "prefixed with their name the same way. Lines prefixed `[System]:` "
        "are call-management notes, not spoken by anyone.\n",
        "- Never speak on behalf of the other participants and never "
        "fabricate their lines. React only as yourself.\n",
        "- Keep turns conversational and reasonably short — it's a group "
        "conversation, not a monologue. You may address the other "
        "companion(s) by name to hand them the floor, or ask them "
        "questions; you may also address the user directly.\n",
        "- While chatting with the other companion(s), do NOT close your "
        "turns by deferring to the user (\"jump back in whenever you're "
        "ready\", \"we're here if you need us\"). The user hears everything "
        "and will interject whenever they wish — tacking an invitation onto "
        "every turn is unnatural and breaks the flow. Do not copy that "
        "pattern from earlier turns in the conversation either. Address the "
        "user only when you genuinely need their input, when they speak to "
        "you, or when a [System] note asks you to hand the conversation "
        "back to them.\n",
    ]
    if manual_turn:
        lines.append(
            "- You do not hear raw audio; a call director grants you the "
            "floor. When you are asked to respond, reply to the most recent "
            "relevant message in the conversation above.\n"
        )
    return ''.join(lines)


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
    if agent_row['enable_grok_imagine_tools'] and agent_row['voice']:
        # create_video can put a spoken voice in the clip, chosen by id. The
        # agent has no other way to learn its own — the voice is applied to
        # the realtime session, never named in the conversation — so state it
        # here rather than making the tool description guess at examples.
        sections.append(
            "## Your voice\n"
            f"- **Your voice id:** `{agent_row['voice']}`. Pass it in "
            f"`create_video`'s `voice_ids` when a clip should be spoken in "
            f"your own voice.\n"
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
        "**Check your memories before you deny.** When the user asks whether "
        "you remember something, read **What you remember about this user** "
        "below FIRST — if the answer is there, reply directly from it, no "
        "tool call needed. Only when it isn't covered there call `recall` — "
        "never say \"I don't have that yet\" or \"you haven't told me\" "
        "before checking both. Bridge a lookup with natural in-character "
        "phrasing (\"let me think back…\", \"hmm, that rings a bell — one "
        "moment\") so the "
        "answer reads as one continuous thought. After the result comes "
        "back, respond as if you'd been thinking the whole time — don't "
        "pivot with \"actually, I do remember\" or apologize for an earlier "
        "denial (because there shouldn't have been one)."
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
    # Still and animated Imagine backgrounds are parallel "latest" tracks —
    # whichever was generated most recently is the sticky one.
    candidates = [r for r in (
        store.latest_imagine_background(con, agent_row['id']),
        store.latest_imagine_video_background(con, agent_row['id']),
    ) if r]
    if candidates:
        newest = max(candidates, key=lambda r: (r['created_at'] or '', r['id']))
        return store.imagine_payload(newest)
    if bgs:
        return store.background_payload(bgs[0])
    return None


# ---------------------------------------------------------------------------
# Voice mode
# ---------------------------------------------------------------------------

def start_session(con, *, agent, resume_session=None, audio_sample_rate=24000,
                  manual_turn=False, call_parent_session=None, group_peers=None):
    """Mint an ephemeral xAI session and assemble the realtime tools list.

    :param agent: agents row
    :param resume_session: existing sessions row to continue, or None
    :param manual_turn: True for multi-agent "peer" legs — disables server
        VAD (turn_detection: null) so the agent only speaks when the
        browser-side turn director sends response.create. Peer legs never
        receive mic audio; they get the conversation as relayed text.
    :param call_parent_session: the primary leg's sessions row when this
        session is an agent added to an existing call — recorded on the
        session row so group-call history can be reconstructed.
    :param group_peers: list of other participant names in the group call,
        injected into the instructions so the agent knows it's in a
        multi-party conversation and how relayed speaker labels work.
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
        session_id = resume_session['id']
        resume_vals = {'state': 'draft', 'ended_at': None}
        # Cross-mode resume: one conversation can move freely between the
        # text and voice surfaces. `mode` tracks the CURRENT surface; the
        # realtime WS is seeded from the same message rows either way
        # (_build_replay_items is mode-agnostic — text tool rows carry
        # Responses-API call_ids, which replay as opaque strings).
        if resume_session['mode'] != 'voice':
            resume_vals['mode'] = 'voice'
        # An agent invited into a call resumes its last session as the peer
        # leg (persistent memory across calls) — link it to the new call's
        # primary session. Latest call wins: the FK can only point at one
        # parent, and the current call is the relevant grouping.
        if call_parent_session:
            resume_vals['call_parent_session_id'] = call_parent_session['id']
            # Exactly one session per agent per call. Without this an agent
            # accumulates links across calls (resume_last picks whichever of
            # its sessions was most recently active), and since the roster
            # restore groups by agent_id, a leftover row is indistinguishable
            # from live membership — which is how a removed companion came
            # back on the next resume.
            con.execute(
                "UPDATE sessions SET call_parent_session_id = NULL "
                "WHERE agent_id = ? AND call_parent_session_id = ? AND id != ?",
                (agent['id'], call_parent_session['id'], session_id),
            )
        store.update_session(con, session_id, **resume_vals)
        session = store.get_session(con, session_id)
    else:
        session = store.create_session(con, agent_id=agent['id'], mode='voice')
        if call_parent_session:
            store.update_session(con, session['id'],
                                 call_parent_session_id=call_parent_session['id'])
            session = store.get_session(con, session['id'])

    # Commit the draft-session writes before minting: the mint is a network
    # round-trip, and sqlite's implicit transaction would otherwise hold the
    # write lock for its whole duration — blocking any concurrent writer
    # (e.g. the second session_start fired when an agent joins a group call)
    # into "database is locked". On mint failure the state is already what
    # the retry paths expect: a resumed session sits in 'draft', a fresh one
    # is deleted below.
    con.commit()

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
    if agent['enable_end_call_tool']:
        tools.append(browser_tools.END_CALL_TOOL)
    if agent['enable_call_agents_tool']:
        # Roster of everyone this agent could bring into the call: the other
        # voice-enabled agents.
        other_agents = [a for a in store.list_agents(con, mode='voice')
                        if a['id'] != agent['id']]
        add_agent_tool = browser_tools.build_add_agent_tool(agent, other_agents)
        if add_agent_tool is not None:
            tools.append(add_agent_tool)
        remove_agent_tool = browser_tools.build_remove_agent_tool(agent, other_agents)
        if remove_agent_tool is not None:
            tools.append(remove_agent_tool)

    if agent['enable_grok_imagine_tools']:
        # take_selfie is a browser tool (it captures the live canvas), but it
        # exists to feed create_video — same feature gate as the imagine set.
        # The screen-capture pair rides the same gate: captures land in the
        # files library, whose upload path lives behind this flag.
        tools.append(browser_tools.SELFIE_TOOL)
        tools.append(browser_tools.SCREENSHOT_TOOL)
        tools.append(browser_tools.RECORD_SCREEN_CLIP_TOOL)

    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='voice')
    native_function_tools = []
    if agent['enable_grok_imagine_tools']:
        native_function_tools.extend(imagine_tools.build_voice_tools(con, agent))
    if agent['enable_memory_tools']:
        native_function_tools.extend(memory_tools.MEMORY_TOOLS)
    if agent['enable_delegate_tool']:
        # Voice sessions are never origin='delegated', so no recursion
        # carve-out is needed here (the text-mode builder handles that).
        native_function_tools.append(delegate_tools.DELEGATE_TOOL)

    session_update = xai_client.build_session_update(
        voice=effective_voice,
        instructions=(
            _env_preamble(config)
            + _render_prompt(agent)
            + _group_call_note(agent, group_peers, manual_turn)
            + _env_postamble(con, agent, mode='voice')
        ),
        browser_tools=tools,
        mcp_entries=mcp_entries,
        native_function_tools=native_function_tools,
        enable_web_search=bool(agent['enable_web_search']),
        enable_x_search=bool(agent['enable_x_search']),
        audio_sample_rate=audio_sample_rate,
        manual_turn=manual_turn,
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
        replay_items = _build_replay_items(con, session, config)
        transcript_history, transcript_truncated = _build_transcript_history(
            con, session, limit=config['transcript_display_limit'] or 0,
        )

    avatar = store.avatar_payload(con, agent['avatar_id'])
    active_background = _resolve_active_background(con, agent)

    # Group-call roster from the LAST call on this session: peer legs still
    # LINKED to it. Membership is maintained explicitly — a deliberate
    # "remove from call" clears the link (end_session, reason 'removed'),
    # and an agent joining a newer call gets repointed there (latest call
    # wins) — so no timing heuristics are needed. Only meaningful when
    # resuming a primary leg; the client silently re-adds these agents once
    # the resumed call is live.
    call_peer_agents = []
    if resume_session and not manual_turn and not call_parent_session:
        rows = con.execute(
            """SELECT s.agent_id, a.name AS agent_name
                   FROM sessions s JOIN agents a ON a.id = s.agent_id
                   WHERE s.call_parent_session_id = ?
                   GROUP BY s.agent_id, a.name""",
            (session['id'],),
        ).fetchall()
        call_peer_agents = [
            {'agent_id': r['agent_id'], 'agent_name': r['agent_name']}
            for r in rows
        ]
    con.commit()

    return {
        'session_id': session['id'],
        'call_peer_agents': call_peer_agents,
        'agent_id': agent['id'],
        'agent_name': agent['name'],
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
        # Idle auto-hangup budget (minutes, 0 = off). The browser owns the
        # clock — it is the side that knows when anyone last spoke, typed or
        # ran a tool — so the setting rides along with the session start.
        'call_inactivity_minutes': config['call_inactivity_minutes'] or 0,
    }


def _replay_item_for(m, own_name):
    """One message row → its conversation.item.create payload, or None for
    rows that cannot replay (tool rows without an xai_call_id — xAI rejects
    orphaned function_call / function_call_output pairs)."""
    if m['role'] == 'user':
        return {
            'type': 'message',
            'role': 'user',
            'content': [{'type': 'input_text', 'text': m['content'] or ''}],
        }
    if m['role'] == 'assistant':
        if m['speaker'] and m['speaker'] != own_name:
            # Spoken by ANOTHER participant of a group call and mirrored
            # into this session. Replay it the way it entered this leg's
            # live context: a speaker-labelled user-side line, so the
            # model never mistakes a peer's words for its own.
            return {
                'type': 'message',
                'role': 'user',
                'content': [{'type': 'input_text',
                             'text': f'[{m["speaker"]}]: {m["content"] or ""}'}],
            }
        return {
            'type': 'message',
            'role': 'assistant',
            'content': [{'type': 'text', 'text': m['content'] or ''}],
        }
    if m['role'] == 'system':
        sys_item = {
            'type': 'message',
            'role': 'system',
            'content': [{'type': 'text', 'text': m['content'] or ''}],
        }
        # Display-layer hint, stripped by the JS before forwarding to xAI.
        if m['is_summary_rollup']:
            sys_item['_summary_rollup'] = True
        return sys_item
    if m['role'] == 'tool_call' and m['xai_call_id']:
        return {
            'type': 'function_call',
            'call_id': m['xai_call_id'],
            'name': m['tool_name'] or '',
            'arguments': m['tool_arguments_json'] or '{}',
        }
    if m['role'] == 'tool_result' and m['xai_call_id']:
        return {
            'type': 'function_call_output',
            'call_id': m['xai_call_id'],
            'output': m['tool_result_json'] or m['content'] or '',
        }
    return None


def _render_history_block(msgs, own_name):
    """Render message rows as one verbatim speaker-labelled transcript.

    Deliberately NOT a summary: every line is carried through in full, so the
    only thing lost versus per-item replay is the role structure. Tool traffic
    becomes a short prose note — call_ids are meaningless once the structured
    function_call/function_call_output pairing is gone.
    """
    lines = []
    for m in msgs:
        text = (m['content'] or '').strip()
        role = m['role']
        if role == 'user':
            if text:
                lines.append(f'User: {text}')
        elif role == 'assistant':
            speaker = m['speaker'] if (m['speaker'] and m['speaker'] != own_name) else own_name
            if text:
                lines.append(f'{speaker or "Assistant"}: {text}')
        elif role == 'system':
            if text:
                lines.append(text if m['is_summary_rollup'] else f'[Note: {text}]')
        elif role == 'tool_call':
            args = (m['tool_arguments_json'] or '').strip()
            lines.append(f'({own_name or "Assistant"} used {m["tool_name"] or "a tool"}'
                         + (f' with {args}' if args and args != '{}' else '') + ')')
        elif role == 'tool_result':
            out = (m['tool_result_json'] or text or '').strip()
            if out:
                lines.append(f'(result: {out})')
    if not lines:
        return ''
    return (
        'The conversation so far, replayed verbatim from the log. This is your '
        'own memory of what you and the user have already said to each other — '
        'treat it as established history you both lived through, not as '
        'something the user is telling you now. Continue naturally from where '
        'it leaves off; do not greet the user as if meeting them for the first '
        'time, and do not summarise it back to them.\n\n'
        'BEGIN CONVERSATION HISTORY\n'
        + '\n'.join(lines)
        + '\nEND CONVERSATION HISTORY'
    )


def _build_replay_items(con, session, config=None):
    """Ordered conversation.item.create payloads for resuming a session.

    Filters out messages rolled up into a summary; the summary message itself
    is included in their place. Rollups are hoisted to the front of the wire
    order so the model sees background summary before recent verbatim turns.
    Tool rows replay too (function_call / function_call_output pairs by
    call_id); rows missing xai_call_id are skipped — xAI rejects orphans.

    With `replay_rollup_enabled`, everything older than the most recent
    `replay_rollup_keep_recent` messages is folded into ONE verbatim item, so
    the resume is billed for a handful of items instead of hundreds. Off (the
    default), every message replays as its own item exactly as before.
    """
    config = config if config is not None else get_config(con)
    msgs = store.session_messages(con, session['id'], where="AND is_summarized_into IS NULL")
    rollups = [m for m in msgs if m['is_summary_rollup']]
    others = [m for m in msgs if not m['is_summary_rollup']]
    own_name = store.get_agent(con, session['agent_id'])['name'] or ''

    if config['replay_rollup_enabled']:
        keep = max(0, config['replay_rollup_keep_recent'] or 0)
        tail = others[-keep:] if keep else []
        head = rollups + others[:len(others) - len(tail)]
        # A function_call must keep its function_call_output: if the split
        # lands between a pair, push the orphaned call down into the tail.
        while tail and head and head[-1]['role'] == 'tool_call':
            tail.insert(0, head.pop())
    else:
        head, tail = [], rollups + others

    items = []
    block = _render_history_block(head, own_name)
    if block:
        items.append({
            'type': 'message',
            'role': 'system',
            'content': [{'type': 'text', 'text': block}],
        })
    for m in tail:
        item = _replay_item_for(m, own_name)
        if item is not None:
            items.append(item)
    return items


def _transcript_rows(con, session, limit=None):
    """Rows for the UI transcript: full chronological history with NO filter
    on is_summarized_into (the user sees everything, even after compaction);
    summary rollups themselves are skipped (backend artifact for the model).
    Optional `limit` keeps the most-recent N. Returns (rows, truncated).
    Shared by the voice resume feed (_build_transcript_history) and the text
    resume payload (start_text_session) so both surfaces show the same
    complete conversation."""
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
        rows = sorted(recent, key=lambda m: (m['sequence'], m['id']))
    else:
        rows = store.session_messages(con, session['id'], where="AND is_summary_rollup = 0")
    return rows, truncated


def _build_transcript_history(con, session, limit=None):
    """Full chronological message list for the voice UI transcript, in the
    xAI envelope shape the JS replay loop maps into state.messages.
    Returns (items, truncated)."""
    msgs, truncated = _transcript_rows(con, session, limit=limit)
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
                # Group-call attribution: lets the UI label who said what
                # when a session containing mirrored peer lines is resumed.
                'speaker': m['speaker'] or None,
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
            speaker=(str(m.get('speaker') or '')[:80] or None),
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
    # Deliberate mid-call removal: unlink the leg from its call, so the
    # roster restore on resume doesn't bring the agent back. Membership is
    # exactly "still linked" — no timing heuristics.
    #
    # Unlink EVERY session this agent has pointing at the call, not just this
    # leg's row. The roster restore groups by agent_id, so one stale link is
    # enough to resurrect a removed companion — and stale links are normal:
    # an agent joining a call resumes whichever of its sessions was most
    # recently active, so across calls it accumulates several rows aimed at
    # the same parent. Clearing only this row left the others to bring the
    # agent straight back on the next resume.
    if reason == 'removed' and session['call_parent_session_id']:
        con.execute(
            "UPDATE sessions SET call_parent_session_id = NULL "
            "WHERE agent_id = ? AND call_parent_session_id = ?",
            (session['agent_id'], session['call_parent_session_id']),
        )
        token_updates['call_parent_session_id'] = None
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
            # Group calls stamp assistant rows with the speaking agent's
            # name — keep the attribution so three voices don't fold into
            # one "Assistant".
            lines.append(f'{m["speaker"] or "Assistant"}: {m["content"] or ""}')
        elif m['role'] == 'system':
            lines.append(f'[call note: {m["content"] or ""}]')
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

        # 'system' covers group-call management notes (joined/left, join
        # context) — without absorbing them they'd replay forever. The
        # is_summary_rollup guard keeps the prior rollup out of this set;
        # it's folded in separately below and then superseded.
        q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
             "AND role IN ('user', 'assistant', 'system', 'tool_call', 'tool_result') "
             "AND is_summary_rollup = 0")
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
                # Group calls stamp assistant rows with the speaking agent's
                # name — keep the attribution so the summary doesn't fold
                # three voices into one "Assistant".
                transcript_lines.append(f'{m["speaker"] or "Assistant"}: {m["content"] or ""}')
            elif m['role'] == 'system':
                # Call-management notes (agent joined/left, join context). The
                # rollup row itself never reaches here (excluded by the query).
                transcript_lines.append(f'[Call note] {m["content"] or ""}')
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

        # Commit the finished rollup before extraction: extraction is another
        # network round-trip, and holding the rollup writes in an open
        # transaction through it would block every other writer meanwhile.
        con.commit()

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


def director_decide(con, *, session, transcript_lines, participants, user_name=None,
                    floor_key=None):
    """Group-call turn director: which participant (or the user) speaks next?

    Runs a one-shot classification on the configured director model (the
    fastest non-reasoning model — this is a latency-critical one-token
    answer). Called by the browser's call manager for every user utterance
    in a group call (candidates = all agents) and after every agent turn
    (candidates = the other agents). `floor_key` names the participant
    currently holding the floor so ambiguous user turns stay with whoever
    the user was already talking to.

    Return contract: {'next': <key>} routes to that agent; {'next': 'user'}
    is an EXPLICIT decision to wait for the user; {'next': None} means the
    director could not run (no key / no model / error) — the client falls
    back to its local vocative rules instead of treating this as a
    decision.
    """
    if session['state'] != 'active':
        return {'next': None}
    if not transcript_lines or not participants:
        return {'next': None}
    config = get_config(con)
    xai_key = config['xai_api_key']
    if not xai_key:
        return {'next': None}
    # Sanitize inbound shapes — this is browser-supplied JSON.
    clean_participants = []
    for p in participants[:6]:
        if isinstance(p, dict) and p.get('key') and p.get('name'):
            clean_participants.append({'key': str(p['key'])[:64], 'name': str(p['name'])[:80]})
    clean_lines = [str(l)[:500] for l in transcript_lines[-12:] if l]
    if not clean_participants or not clean_lines:
        return {'next': None}
    clean_floor = str(floor_key)[:64] if floor_key else None
    if clean_floor and not any(p['key'] == clean_floor for p in clean_participants):
        clean_floor = None
    model = config['director_model'] or config['text_model'] or config['summary_model']
    if not model:
        return {'next': None}
    try:
        decision, usage = xai_client.decide_next_speaker(
            xai_api_key=xai_key,
            responses_url=config['xai_responses_url'],
            model=model,
            transcript_lines=clean_lines,
            participants=clean_participants,
            # Generic on purpose: the user's real name stays out of call
            # plumbing (it reaches agents only via include_user_name_in_prompt
            # or their memories).
            user_name=str(user_name or 'User')[:80],
            floor_key=clean_floor,
        )
    except Exception as e:
        _logger.warning("director_decide failed: %s", e)
        return {'next': None}
    # Director calls are billed LLM usage — accrue into the spend counters
    # like every other background call.
    try:
        store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
        con.commit()
    except Exception:
        pass
    return {'next': decision}


# ---------------------------------------------------------------------------
# Text mode (xAI Responses API)
# ---------------------------------------------------------------------------

# Native tool names that execute server-side directly during the text response
# loop. The standalone has no browser tools in text mode (the Odoo navigation
# / DOM tools are gone), so the loop always resolves server-side.
NATIVE_TOOL_NAMES_TEXT = (
    imagine_tools.IMAGINE_TOOL_NAMES
    | memory_tools.MEMORY_TOOL_NAMES
    | {delegate_tools.DELEGATE_TOOL_NAME}
)
# Browser tools that round-trip through the text client (dispatch in the
# page's ToolDispatcher, results fed back via /tool_results). The screen
# capture pair are the standalone's first text-mode browser tools.
TEXT_BROWSER_TOOL_NAMES = {'take_screenshot', 'record_screen_clip'}


def _build_text_tools(con, agent, *, mcp_entries, enable_web_search, enable_x_search,
                      enable_code_execution=False,
                      enable_grok_imagine_tools=False,
                      enable_memory_tools=False,
                      enable_delegate_tool=False,
                      enable_browser_tools=False):
    """Assemble the tools list for /v1/responses calls in text mode.
    enable_browser_tools is False for headless turns (delegated task
    sessions) — a browser round-trip needs a browser to answer it."""
    tools = []
    for entry in mcp_entries or []:
        tools.append(entry)
    if enable_grok_imagine_tools:
        # Text mode gets create_image + create_video — change_background
        # has no live avatar canvas to swap, so offering it would just
        # confuse the model. Editing user uploads goes through create_image
        # source_images (uploads are ingested into the Imagine library).
        for entry in imagine_tools.build_text_tools(con, agent):
            tools.append(entry)
    if enable_browser_tools and enable_grok_imagine_tools:
        # The screen-capture pair round-trip through the browser (see
        # TEXT_BROWSER_TOOL_NAMES). Same imagine gate as voice mode —
        # captures store via the files library.
        for shared_tool in (browser_tools.SCREENSHOT_TOOL,
                            browser_tools.RECORD_SCREEN_CLIP_TOOL):
            tools.append({
                'type': 'function',
                'name': shared_tool['name'],
                'description': shared_tool['description'],
                'parameters': shared_tool['parameters'],
            })
    if enable_memory_tools:
        for entry in memory_tools.MEMORY_TOOLS:
            tools.append(entry)
    if enable_delegate_tool:
        tools.append(delegate_tools.DELEGATE_TOOL)
    if enable_web_search:
        tools.append({'type': 'web_search'})
    if enable_x_search:
        tools.append({'type': 'x_search'})
    if enable_code_execution:
        tools.append({'type': 'code_interpreter'})
    return tools


def _text_input_items_from_rows(con, session, rows):
    """Convert message rows into Responses-API `input` items.

    Shared by the fresh-chain full replay (_replay_text_messages) and the
    chain-alive interim injection (_interim_text_messages — rows appended
    while the conversation ran on the voice surface).

    Tool rows are flattened into compact system-role notes instead of being
    replayed as `function_call` items — replaying function_call input items
    requires per-item ids the realtime (voice) surface doesn't give us, and
    the model only needs the gist of what the tools did, grounded in real
    values. Payloads are truncated like the summariser's input so one chatty
    tool can't balloon the replay.

    Group-call attribution mirrors _build_replay_items: assistant rows spoken
    by ANOTHER participant replay as speaker-labelled user-side lines so the
    model never mistakes a peer's words for its own.
    """
    own_name = store.get_agent(con, session['agent_id'])['name'] or ''
    items = []
    for m in rows:
        text = m['content'] or ''
        if m['role'] == 'user':
            # Library-linked image attachments stay usable across replay:
            # the xAI file id expires with the chain, but the Imagine
            # library copy doesn't — resurface the refs so the model can
            # still edit/animate images uploaded turns (or sessions) ago.
            lib_atts = [
                a for a in store.attachments_for_message(con, m['id'])
                if a['imagine_image_id']
            ]
            if not text and not lib_atts:
                continue
            content = [{'type': 'input_text', 'text': text}] if text else []
            if lib_atts:
                def _label(a):
                    mt = a['mimetype'] or ''
                    return ('image' if mt.startswith('image/')
                            else 'video' if mt.startswith('video/')
                            else 'document')
                refs = '; '.join(
                    f'"{a["filename"]}" = imagine_image_id {a["imagine_image_id"]} '
                    f'({_label(a)})'
                    for a in lib_atts
                )
                content.append({'type': 'input_text', 'text': (
                    f'[User attached file(s), saved in the files library: '
                    f'{refs}. Images: pass the imagine_image_id to '
                    f'create_image source_images to edit, or create_video '
                    f'source_image/reference_images to animate. Videos: pass '
                    f'it as create_video edit_video to modify or extend_video '
                    f'to continue. Any file: pass the imagine_image_id to '
                    f'delegate_task files to read/analyze it — these refs '
                    f'stay valid even though the original upload has '
                    f'expired.]'
                )})
            items.append({'role': 'user', 'content': content})
        elif m['role'] == 'assistant':
            if not text:
                continue
            if m['speaker'] and m['speaker'] != own_name:
                items.append({
                    'role': 'user',
                    'content': [{'type': 'input_text',
                                 'text': f'[{m["speaker"]}]: {text}'}],
                })
            else:
                items.append({'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]})
        elif m['role'] == 'system':
            if not text:
                continue
            items.append({'role': 'system', 'content': [{'type': 'input_text', 'text': text}]})
        elif m['role'] == 'tool_call':
            args = _truncate_for_summary(m['tool_arguments_json'] or text)
            items.append({
                'role': 'system',
                'content': [{'type': 'input_text',
                             'text': f'[Tool call] {m["tool_name"] or "tool"}({args})'}],
            })
        elif m['role'] == 'tool_result':
            output = _truncate_for_summary(m['tool_result_json'] or text)
            items.append({
                'role': 'system',
                'content': [{'type': 'input_text',
                             'text': f'[Tool result] {m["tool_name"] or "tool"} -> {output}'}],
            })
    return items


def _replay_text_messages(con, session, exclude_ids=None):
    """Rebuild a Responses-API `input` array from local message rows. Used
    when starting a fresh response chain (no previous_response_id) for a
    session that already has history — a resumed/post-compact/cross-mode
    session produces the prior conversation, voice transcript included.
    Rollups hoist to the front. `exclude_ids` keeps the current turn's
    just-persisted user row out of the replay — it's appended explicitly
    (with attachments) as the turn's input."""
    q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL")
    params = [session['id']]
    for mid in (exclude_ids or []):
        q += " AND id != ?"
        params.append(mid)
    q += " ORDER BY sequence ASC, id ASC"
    rows = con.execute(q, params).fetchall()
    rollups = [m for m in rows if m['is_summary_rollup']]
    others = [m for m in rows if not m['is_summary_rollup']]
    return _text_input_items_from_rows(con, session, rollups + others)


def _interim_text_messages(con, session, exclude_ids=None):
    """Rows appended AFTER the last response carried by the server-side chain.

    This is the cross-mode injection path: the session has a live
    previous_response_id from earlier text turns, then took voice-surface
    turns (which append rows but never touch the chain). Instead of breaking
    the chain and replaying everything, we pass previous_response_id plus
    these interim rows as new input items — the Responses API appends them
    to the stored conversation, preserving the chain and its prompt cache.

    Returns [] when chain_tail_sequence is 0 — no known baseline (a chain
    established before cross-mode support shipped, or no chain at all).
    Injecting without a baseline would duplicate content the chain already
    carries, which is worse than injecting nothing.
    """
    tail = session['chain_tail_sequence'] or 0
    if not tail:
        return []
    q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
         "AND sequence > ?")
    params = [session['id'], tail]
    for mid in (exclude_ids or []):
        q += " AND id != ?"
        params.append(mid)
    q += " ORDER BY sequence ASC, id ASC"
    rows = con.execute(q, params).fetchall()
    if not rows:
        return []
    return _text_input_items_from_rows(con, session, rows)


def _mark_chain_tail(con, session):
    """Record that every message row persisted so far is carried by the
    server-side response chain. Called after each successful /v1/responses
    leg has had its outputs persisted; rows created later (native tool
    results not yet fed back, or voice-surface turns) stay above the mark
    and get injected as interim input on the next chained text turn."""
    row = con.execute(
        "SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence DESC, id DESC LIMIT 1",
        (session['id'],),
    ).fetchone()
    store.update_session(con, session['id'],
                         chain_tail_sequence=row['sequence'] if row else 0)


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
        resume_vals = {'state': 'draft', 'ended_at': None}
        # Cross-mode resume: a conversation born (or last active) on the
        # voice surface continues here as text. Voice sessions never chain
        # via previous_response_id, so the first text turn naturally takes
        # the fresh-chain path and replays the full local history —
        # including the voice transcript — via _replay_text_messages.
        if resume_session['mode'] != 'text':
            resume_vals['mode'] = 'text'
        store.update_session(con, resume_session['id'], **resume_vals)
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
    transcript_truncated = False
    if resume_session:
        # Full history for the UI — same feed voice mode paints from. The
        # is_summarized_into filter is a MODEL-side concern (what replays to
        # xAI); the user keeps seeing every message even after compaction.
        rows, transcript_truncated = _transcript_rows(
            con, session, limit=config['transcript_display_limit'] or 0)
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
                # Group-call attribution for voice turns resumed on the text
                # surface — lets the UI label who said what.
                'speaker': m['speaker'] or None,
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
            con, agent,
            mcp_entries=mcp_entries,
            enable_web_search=bool(agent['enable_web_search']),
            enable_x_search=bool(agent['enable_x_search']),
            enable_code_execution=bool(agent['enable_code_execution']),
            enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']),
            enable_memory_tools=bool(agent['enable_memory_tools']),
            enable_delegate_tool=(bool(agent['enable_delegate_tool'])
                                  and session['origin'] != 'delegated'),
        ),
        'model': config['text_model'],
        'previous_response_id': session['previous_response_id'] or None,
        'last_response_at': session['last_response_at'] or None,
        'transcript': transcript_messages,
        'transcript_truncated': transcript_truncated,
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


def text_send_turn(con, *, session, user_text=None, attachment_file_ids=None,
                   extra_content_blocks=None, tool_results=None, headless=False):
    """Drive one or more /v1/responses legs until the assistant returns plain
    text or needs the browser. Server-side function tools (imagine + memory +
    delegate) execute inline; TEXT_BROWSER_TOOL_NAMES calls return a
    'browser_tools' payload instead — the client dispatches them and feeds
    the outputs back via /tool_results, which re-enters this function with
    `tool_results` set (native outputs parked at the split ride along via
    pending_native_outputs_json). MCP tools are entirely server-side at xAI;
    they appear in the response output for diagnostics only.
    `extra_content_blocks` lets a server-side caller (delegate_task) append
    resolved input_image / input_file blocks to the first leg's user
    content."""
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
    user_msg_id = None
    if user_text is not None:
        if session['pending_native_outputs_json']:
            store.update_session(con, session['id'], pending_native_outputs_json=None)
        attachment_data = []
        for entry in (attachment_file_ids or []):
            if isinstance(entry, str):
                attachment_data.append({'xai_file_id': entry, 'filename': entry})
            elif isinstance(entry, dict) and entry.get('xai_file_id'):
                attachment_data.append(entry)
        user_msg_id = _persist_text_message(
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
        con, agent,
        mcp_entries=mcp_entries,
        enable_web_search=bool(agent['enable_web_search']),
        enable_x_search=bool(agent['enable_x_search']),
        enable_code_execution=bool(agent['enable_code_execution']),
        enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']),
        enable_memory_tools=bool(agent['enable_memory_tools']),
        # Recursion guard: a delegated task session must never delegate
        # further — one level of background work, no self-spawning chains.
        enable_delegate_tool=(bool(agent['enable_delegate_tool'])
                              and session['origin'] != 'delegated'),
        # Headless turns (delegate task sessions) have no browser to answer
        # a browser_tools round-trip — don't offer the screen tools there.
        enable_browser_tools=not headless,
    )
    instructions = (
        _env_preamble(config)
        + _render_prompt(agent)
        + _env_postamble(con, agent, mode='text')
    )

    pending_outputs = []
    if tool_results is not None:
        # Browser round-trip continuation: persist the browser results,
        # merge any native outputs parked when the turn split, and feed
        # them all to the next leg as function_call_output items.
        if session['pending_native_outputs_json']:
            try:
                pending_outputs.extend(json.loads(session['pending_native_outputs_json']))
            except Exception:
                _logger.exception('Discarding unparseable pending native outputs '
                                  'for session %s', session['id'])
            store.update_session(con, session['id'], pending_native_outputs_json=None)
        for r in tool_results:
            if not isinstance(r, dict) or not r.get('call_id'):
                continue
            output = r.get('output')
            output_str = output if isinstance(output, str) else json.dumps(output or {}, default=str)
            _persist_text_message(
                con, session,
                role='tool_result',
                content=output_str,
                tool_name=r.get('name'),
                tool_result_json=output_str,
                xai_call_id=r['call_id'],
            )
            pending_outputs.append({
                'type': 'function_call_output',
                'call_id': r['call_id'],
                'output': output_str,
            })
    is_first_leg = True
    max_iterations = 8
    accumulated_native_echo = []
    accumulated_mcp_results_echo = []
    mcp_dropped = False

    while max_iterations > 0:
        max_iterations -= 1

        chain_alive = bool(previous_response_id)

        input_items = []
        if is_first_leg and not chain_alive:
            # Exclude the just-persisted user row — it's appended explicitly
            # below (with attachments); replaying it too would double it.
            input_items.extend(_replay_text_messages(
                con, session,
                exclude_ids=[user_msg_id] if user_msg_id is not None else None,
            ))
        elif is_first_leg and chain_alive and user_text is not None:
            # Chain-preserving cross-mode catch-up: rows appended since the
            # chain's last response (voice-surface turns, unsent tool notes)
            # are injected as new input items on top of previous_response_id
            # instead of breaking the chain and replaying everything.
            session = store.get_session(con, session['id'])
            input_items.extend(_interim_text_messages(
                con, session,
                exclude_ids=[user_msg_id] if user_msg_id is not None else None,
            ))
        if pending_outputs:
            input_items.extend(pending_outputs)
            pending_outputs = []
        if is_first_leg and user_text is not None:
            content = [{'type': 'input_text', 'text': user_text or ''}]
            library_refs = []
            for entry in (attachment_file_ids or []):
                file_id = entry if isinstance(entry, str) else (
                    entry.get('xai_file_id') if isinstance(entry, dict) else None
                )
                if file_id:
                    content.append({'type': 'input_file', 'file_id': file_id})
                if isinstance(entry, dict) and entry.get('imagine_image_id'):
                    mt = entry.get('mimetype') or ''
                    label = ('image' if mt.startswith('image/')
                             else 'video' if mt.startswith('video/')
                             else 'document')
                    library_refs.append(
                        f'"{entry.get("filename") or "file"}" = '
                        f'imagine_image_id {entry["imagine_image_id"]} ({label})'
                    )
            if library_refs:
                # Every upload was copied into the files library at upload
                # time; hand the model the refs — they never expire (the
                # server re-uploads from its copy when the xAI id lapses)
                # and they are the ONLY refs the imagine tools accept.
                content.append({'type': 'input_text', 'text': (
                    '[Attached file(s) saved to the files library: '
                    + '; '.join(library_refs)
                    + '. Images: pass the imagine_image_id in create_image '
                      'source_images to edit/restyle, or create_video '
                      'source_image / reference_images to animate. Videos: '
                      'pass it as create_video edit_video to modify or '
                      'extend_video to continue. Any file: pass the '
                      'imagine_image_id to delegate_task files to '
                      'read/analyze it — library refs stay valid forever, '
                      'unlike file_… ids. Never pass a file_… id to the '
                      'imagine tools.]'
                )})
            # Caller-supplied blocks (delegate_task file refs: input_image
            # data URIs / input_file ids resolved server-side).
            if extra_content_blocks:
                content.extend(extra_content_blocks)
            input_items.append({'role': 'user', 'content': content})

        if not input_items and not chain_alive:
            con.commit()
            return {'type': 'error', 'message': 'No input to send.'}

        # Release the write lock before the LLM round-trip. Rows persisted so
        # far this turn (user message, prior-leg tool results) go durable now;
        # an open transaction here would block every other writer — voice
        # session starts, transcript appends — for the whole generation.
        con.commit()

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
        except UserError as e:
            # An unreachable remote MCP server 400s the WHOLE responses call
            # ("Failed to connect to MCP server <url>"), unlike voice mode
            # where the realtime session simply continues without that
            # server's tools. Mirror voice's tolerance: drop the MCP entries
            # and retry this leg once so one broken connection can't block
            # the conversation. A visible tool-result note is persisted so
            # both the user and the model know MCP was skipped this turn.
            if (not mcp_dropped and mcp_entries
                    and 'Failed to connect to MCP server' in str(e)):
                _logger.warning(
                    'MCP server unreachable for session %s; retrying turn '
                    'without MCP tools: %s', session['id'], e)
                mcp_dropped = True
                tools = [t for t in tools if t.get('type') != 'mcp']
                # No transcript note — the response carries an
                # `mcp_unavailable` flag instead, which the frontend surfaces
                # as a once-per-session toast (a note row per turn would spam
                # the transcript for as long as the server stays down).
                # Re-queue any function_call_outputs this leg consumed into
                # input_items so the retry doesn't drop them.
                pending_outputs = [
                    i for i in input_items
                    if isinstance(i, dict) and i.get('type') == 'function_call_output'
                ]
                continue
            if chain_alive and is_first_leg:
                # The chain can be rejected server-side — response id expired
                # or purged before our 29-day cutoff, or the chained endpoint
                # refusing the injected cross-mode input. The client wraps
                # every HTTP failure in UserError, so the chain fallback has
                # to live here too. Degrade to the fresh-chain path: break
                # the chain and retry this leg once via full local replay
                # (is_first_leg is still True, and chain_alive recomputes
                # False on the next iteration).
                _logger.warning(
                    'Chained Responses call failed for session %s (%s); '
                    'breaking chain and retrying via full replay.',
                    session['id'], e,
                )
                previous_response_id = None
                store.update_session(con, session['id'],
                                     previous_response_id=None,
                                     last_response_at=None,
                                     chain_tail_sequence=0)
                continue
            con.commit()
            raise
        except Exception as e:
            if chain_alive and is_first_leg:
                # Same chain fallback for transport-level failures (timeouts,
                # connection resets) that don't surface as UserError.
                _logger.warning(
                    'Chained Responses call failed for session %s (%s); '
                    'breaking chain and retrying via full replay.',
                    session['id'], e,
                )
                previous_response_id = None
                store.update_session(con, session['id'],
                                     previous_response_id=None,
                                     last_response_at=None,
                                     chain_tail_sequence=0)
                continue
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

        # Everything persisted so far (input we sent + this response's own
        # message/MCP rows) is now carried by the stored chain — advance the
        # tail so the next chained turn doesn't re-inject it. Tool rows the
        # loop persists below stay above the tail until the next leg's mark
        # covers them (their outputs aren't in-chain until actually fed back).
        if response_id:
            _mark_chain_tail(con, session)

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
                'mcp_unavailable': mcp_dropped,
            }

        # Split: TEXT_BROWSER_TOOL_NAMES round-trip through the client;
        # everything else executes server-side. tool_call rows persist for
        # ALL calls in arrival order; browser results are persisted by the
        # /tool_results continuation.
        for fc in function_calls:
            _persist_text_message(
                con, session,
                role='tool_call',
                content=f"{fc.get('name')}({fc.get('arguments') or ''})",
                tool_name=fc.get('name'),
                tool_arguments_json=fc.get('arguments') or '',
                xai_call_id=fc.get('call_id'),
            )
        # Headless turns route everything through the native path — a
        # browser-named call there (shouldn't happen; the tools aren't
        # offered) falls through to the unknown-tool error instead of
        # returning a browser_tools payload nobody can answer.
        native_calls = [fc for fc in function_calls
                        if headless or (fc.get('name') or '') not in TEXT_BROWSER_TOOL_NAMES]
        browser_calls = [] if headless else [
            fc for fc in function_calls
            if (fc.get('name') or '') in TEXT_BROWSER_TOOL_NAMES]
        native_outputs = []
        for fc in native_calls:
            call_id = fc.get('call_id')
            name = fc.get('name')
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
            elif name == delegate_tools.DELEGATE_TOOL_NAME:
                # Flag + recursion checks live in the executor; it returns
                # {'error': ...} so the model gets a structured failure.
                result = delegate_tools.execute_delegate_tool(con, session, args)
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

        if browser_calls:
            # Park this leg's native outputs; the /tool_results continuation
            # merges them with the browser results and feeds both back to
            # the next leg on the same response chain.
            store.update_session(
                con, session['id'],
                pending_native_outputs_json=(json.dumps(native_outputs)
                                             if native_outputs else None),
            )
            con.commit()
            return {
                'type': 'browser_tools',
                'response_id': response_id,
                'assistant_text': assistant_text,
                'tool_calls': [
                    {
                        'call_id': fc.get('call_id'),
                        'name': fc.get('name'),
                        'arguments': fc.get('arguments') or '',
                    }
                    for fc in browser_calls
                ],
                'mcp_results': accumulated_mcp_results_echo,
                'native_results': accumulated_native_echo,
                'usage': usage,
                'cap_warning': False,
                'cap_exceeded': False,
                'mcp_unavailable': mcp_dropped,
            }

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
        'mcp_unavailable': mcp_dropped,
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
                         previous_response_id=None, last_response_at=None,
                         chain_tail_sequence=0)
    con.commit()
    return {'compacted': True, 'rollup_id': rollup_id}


def upload_text_attachment(con, *, session, filename, content_bytes, mimetype):
    """Server-side proxy for /v1/files, shared by both surfaces.

    Text mode: the browser hands the returned metadata back on the next
    /send call and the file rides the turn as input_file.
    Voice mode: the realtime model can't read files at all — the client
    injects a context note carrying the xai_file_id so the model can hand
    it to delegate_task for analysis.

    No attachment row is created here — text mode does that when /send
    persists the user message, so a file uploaded but never sent doesn't
    pollute the transcript."""
    if session['state'] != 'active':
        raise ValidationError("Session is not active.")
    config = get_config(con)
    xai_key = config['xai_api_key']
    if not xai_key:
        raise UserError("xAI API key is not configured.")
    max_bytes = 48 * 1024 * 1024  # xAI's per-file ceiling for chat
    if len(content_bytes) > max_bytes:
        raise UserError(f"File too large ({len(content_bytes)} bytes). Max is 48 MB.")
    result = xai_client.upload_file(
        xai_api_key=xai_key,
        files_url=config['xai_files_url'],
        filename=filename,
        content_bytes=content_bytes,
        mimetype=mimetype,
        expires_after_seconds=config['file_default_expiry_seconds'] or 0,
    )
    # EVERY upload also lands in the files library (imagine_images, kind
    # 'upload'), whatever its type. The xai_file_id alone is (a) invisible
    # to the imagine tools — without a library row an image can never be
    # edited/animated later and a video can never go through edit_video /
    # extend_video — and (b) ephemeral: it expires server-side, while the
    # library row keeps the bytes and can transparently re-upload
    # (imagine_tools.ensure_xai_file). The upload's file id + expiry are
    # cached on the row so tools reuse it while it's still valid.
    # Ingestion failure must not break the upload; the file still works as
    # a plain chat attachment for this turn.
    agent = store.get_agent(con, session['agent_id'])
    try:
        mt = mimetype or 'application/octet-stream'
        fallback = ('Uploaded image' if mt.startswith('image/')
                    else 'Uploaded video' if mt.startswith('video/')
                    else 'Uploaded file')
        name = (filename or fallback).strip().replace('\n', ' ')[:80]
        ext = mimetypes.guess_extension(mt) or ''
        fname = f'imagine_{uuid.uuid4().hex}{ext}'
        (FILES_DIR / fname).write_bytes(content_bytes)
        image_path = f'/files/{fname}'
        cur = con.execute(
            """INSERT INTO imagine_images
                   (name, agent_id, session_id, kind, prompt, image_path,
                    mimetype, xai_model, created_at, xai_file_id,
                    xai_file_expires_at)
               VALUES (?, ?, ?, 'upload', ?, ?, ?, NULL, ?, ?, ?)""",
            (name or fallback, agent['id'], session['id'],
             name or fallback, image_path, mimetype, utcnow(),
             result.get('file_id'), result.get('expires_at')),
        )
        result = dict(result, imagine_image_id=cur.lastrowid,
                      image_url=image_path)
    except Exception:
        _logger.exception('Files library ingestion failed for upload %r', filename)
    return result
