# Copyright 2026 Codemarchant
"""Idle events: prompts a companion gets when a voice call goes quiet.

The browser runs the clock (web/src/lib/idle_events.js) - it is the side
that knows when the companion's audio finished playing and when the user
last spoke or typed. The server stores each companion's list (the
agents.idle_events JSON column), cleans it on save, and hands the usable
events to a call at session start. Chat-reading events draw on the live
chat feed in live_chat.py."""
import json

# Every event note starts with this (web/src/lib/idle_events.js NOTE_PREFIX).
# The note is saved as a system row so a resumed conversation still knows
# what the companion was answering; session_service._transcript_rows keeps
# it out of the visible transcript by this prefix.
NOTE_PREFIX = '[Idle event'

# What an event does: 'prompt' = its prompt, drawn by weight in a quiet
# stretch; 'stream_chat' = the same plus the newest unread stream-chat
# messages (live_chat.take); 'silent_chat' = not drawn - after its own
# after_seconds of quiet the newest unread chat goes in as background for
# the companion's next reply, without asking for one.
TYPES = ('prompt', 'stream_chat', 'silent_chat')

_MAX_EVENTS = 50
# A stream-chat event takes at most this many of the newest unread
# messages - live_chat's whole unread pool.
_MAX_CHAT_MESSAGES = 50
_MAX_NAME = 80
_MAX_PROMPT = 4000


def _int(value, lo, hi, fallback):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return fallback


def clean_events(value):
    """The idle_events list in its stored shape: {name, prompt, weight,
    type, chat_messages, after_seconds, active} dicts. Accepts the list or its JSON text; malformed
    entries are dropped rather than refused (imports carry whatever another
    install wrote). Weights are relative - 100 is the editor's default, so a
    lone event reads as 100%."""
    if isinstance(value, str):
        try:
            value = json.loads(value or '[]')
        except ValueError:
            value = []
    if not isinstance(value, list):
        return []
    out = []
    for item in value[:_MAX_EVENTS]:
        if not isinstance(item, dict):
            continue
        out.append({
            'name': str(item.get('name') or '')[:_MAX_NAME],
            'prompt': str(item.get('prompt') or '')[:_MAX_PROMPT],
            'weight': _int(item.get('weight', 100), 0, 1000, 100),
            'type': item.get('type') if item.get('type') in TYPES else 'prompt',
            # 'stream_chat' only: how many of the newest unread messages ride
            # along. Kept for the other types too, so switching back doesn't
            # lose the number.
            'chat_messages': _int(item.get('chat_messages', 10), 1, _MAX_CHAT_MESSAGES, 10),
            # 'silent_chat' only: seconds of quiet before the chat goes in.
            'after_seconds': _int(item.get('after_seconds', 0), 0, 3600, 0),
            'active': bool(item.get('active', True)),
        })
    return out


def events_json(value):
    """JSON text for the column. Compact separators and this key order match
    the editor's JSON.stringify, so a list the user didn't touch never reads
    as an unsaved edit after a reload."""
    return json.dumps(clean_events(value), ensure_ascii=False, separators=(',', ':'))


def call_payload(agent):
    """What a voice call needs to run the idle clock, or None when the
    companion has idle events off or no event that could fire (inactive,
    or a drawn event with a blank prompt or zero weight). Clamped here as
    well as in the editor: imported packages skip the editor."""
    if not agent['idle_events_enabled']:
        return None
    events = [e for e in clean_events(agent['idle_events'])
              if e['active'] and (e['type'] == 'silent_chat'
                                  or (e['prompt'].strip() and e['weight'] > 0))]
    if not events:
        return None
    lo = _int(agent['idle_events_min_seconds'], 1, 3600, 10)
    return {
        'min_seconds': lo,
        'max_seconds': _int(agent['idle_events_max_seconds'], lo, 3600, lo),
        'max_unanswered': _int(agent['idle_events_max_unanswered'], 0, 1000, 6),
        'events': [{'name': e['name'], 'prompt': e['prompt'].strip(), 'weight': e['weight'],
                    'type': e['type'], 'chat_messages': e['chat_messages'],
                    'after_seconds': e['after_seconds']} for e in events],
    }
