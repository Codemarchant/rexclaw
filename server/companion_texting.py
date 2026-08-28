# Copyright 2026 Codemarchant
"""text_companion: let a companion send an async text to ANOTHER companion
and get their reply back as the tool result — the cross-session counterpart
to enable_call_agents_tool's live same-call join.

The message lands in the target's own "Resume last" conversation (the exact
query heartbeat.latest_manual_session/resume_for_text use), tagged so the
target knows it's a companion texting, not the user. Exactly one reply per
call: the target's turn runs with suppress_companion_text=True, so a texted
companion can never immediately text back on its own — an unattended A<->B
loop is structurally impossible. A real back-and-forth needs the initiating
companion to call this tool again on a later turn of its own (or the target
to do the same the next time IT runs).

Module-level rule (same as delegate_tools/heartbeat): must NOT import
session_service at module level — the import happens lazily inside the
executor instead.
"""
import logging
from datetime import datetime, timezone

from . import store
from .db import utcnow

_logger = logging.getLogger(__name__)

TEXT_COMPANION_TOOL_NAME = 'text_companion'

_MAX_MESSAGE_CHARS = 2000
_MAX_REPLY_CHARS = 4000

# Every incoming companion text starts with this — same role as heartbeat's
# CONTEXT_PREFIX: how the target reading its own transcript (and any future
# filter) tells a companion's text apart from the user's own words.
CONTEXT_PREFIX = '[Companion text from '


def build_text_companion_tool(agent, other_agents):
    """Build the per-agent text_companion tool. Returns None when there is
    nobody to text (mirrors browser_tools.build_add_agent_tool).

    :param agent: agents row of the calling companion
    :param other_agents: list of agents rows (active, excluding agent)
    """
    others = [a for a in (other_agents or []) if a['id'] != agent['id']]
    if not others:
        return None
    lines = [
        "Send a text message to ANOTHER companion (not the user) and get "
        "their reply back. Use it to check in on someone, share news, or "
        "ask them something. The message lands in THEIR own conversation, "
        "clearly tagged as coming from you rather than the user, and you "
        "get back their one reply. This is not a live back-and-forth chat "
        "— one reply per call; text again on a later turn if you want to "
        "keep the conversation going. To the user this is simply you "
        "texting someone: never mention tools, sessions, or that a "
        "message was 'delivered' — just react naturally to what they "
        "said back.",
        "",
        "Roster:",
    ]
    for a in others:
        desc = (a['when_to_call_description'] or '').strip()
        lines.append(f'- id={a["id"]}, name="{a["name"]}"' + (f' — {desc}' if desc else ''))
    lines.append("")
    lines.append("You'd typically only text a companion you actually know, "
                 "not just anyone on this roster.")
    return {
        'type': 'function',
        'name': TEXT_COMPANION_TOOL_NAME,
        'description': '\n'.join(lines),
        'parameters': {
            'type': 'object',
            'properties': {
                'agent_id': {
                    'type': 'integer',
                    'description': 'id of the companion to text, from the roster above.',
                },
                'message': {
                    'type': 'string',
                    'description': 'The text message to send, in your own voice.',
                },
            },
            'required': ['agent_id', 'message'],
        },
    }


def _tagged_message(agent, message):
    return (
        f'{CONTEXT_PREFIX}"{agent["name"]}" — another companion is texting '
        f'you, not the user; this is not a live call, so reply naturally, '
        f'as you would to any other companion.]\n{message}'
    )


def execute_text_companion_tool(con, session, arguments):
    """Run one companion-to-companion text exchange. Same {'error': str}
    contract as the other native tool executors."""
    from . import heartbeat, session_service as svc  # lazy: circular import

    agent = store.get_agent(con, session['agent_id'])
    if not agent['enable_companion_texting']:
        return {'error': 'Companion texting is disabled on this agent.'}

    args = arguments or {}
    try:
        target_id = int(args.get('agent_id'))
    except (TypeError, ValueError):
        return {'error': 'agent_id is required and must be an integer.'}
    if target_id == agent['id']:
        return {'error': 'You cannot text yourself.'}

    message = args.get('message')
    if not isinstance(message, str) or not message.strip():
        return {'error': 'message is required.'}
    message = message.strip()
    if len(message) > _MAX_MESSAGE_CHARS:
        message = message[:_MAX_MESSAGE_CHARS].rstrip() + '…'

    target = con.execute(
        "SELECT * FROM agents WHERE id = ? AND active = 1", (target_id,),
    ).fetchone()
    if not target:
        return {'error': f'No active companion with id {target_id}.'}

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    target_session = heartbeat.latest_manual_session(con, target['id'])
    if target_session:
        try:
            target_session = heartbeat.resume_for_text(con, target_session, now)
        except heartbeat.SessionBusy:
            return {'error': f'{target["name"]} is busy in a live call right now.'}
    else:
        target_session = store.create_session(con, agent_id=target['id'],
                                              mode='text', origin='manual')
        store.update_session(con, target_session['id'], state='active',
                             started_at=utcnow(), last_active_at=utcnow())
        target_session = store.get_session(con, target_session['id'])

    if target_session['needs_summary']:
        # Server-side stand-in for the browser's /compact trigger — same
        # non-fatal rationale as delegate_tools/heartbeat: a failed
        # compaction just means a bigger replay this turn.
        try:
            svc.text_compact(con, target_session)
            target_session = store.get_session(con, target_session['id'])
        except Exception:
            _logger.exception('text_companion: compaction failed for session %s',
                              target_session['id'])

    try:
        turn = svc.text_send_turn(
            con, session=target_session,
            user_text=_tagged_message(agent, message),
            headless=True,  # no browser is attached to this injected turn
            suppress_companion_text=True,  # recursion guard: one reply, no auto chains
        )
    except Exception as e:
        _logger.exception('text_companion: turn failed for session %s',
                          target_session['id'])
        return {'error': f'The text could not be delivered: {e}'}

    if turn.get('type') == 'error':
        return {'error': turn.get('message') or 'The text could not be delivered.'}

    store.update_session(con, target_session['id'], last_active_at=utcnow())
    con.commit()

    reply = (turn.get('assistant_text') or '').strip()
    if not reply:
        reply = f'({target["name"]} had nothing to say back.)'
    elif len(reply) > _MAX_REPLY_CHARS:
        reply = reply[:_MAX_REPLY_CHARS].rstrip() + '…'

    return {'ok': True, 'to': target['name'], 'reply': reply}
