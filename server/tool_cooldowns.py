# Copyright 2026 Codemarchant
"""Tool cooldowns: an optional wait, per companion and per tool, before the
companion can call that tool again.

agents.tool_cooldowns holds the waits as a JSON object {tool name: seconds},
set in the companion editor's "Tool cooldowns" dialog. A call inside its wait
is not run: the companion gets a result saying so, and how long is left. A
call that fails gives the tool back, so only one that worked starts the wait.

Voice calls ask through the browser's tool dispatcher, which runs or proxies
every call there (routes/voice.session_tool_cooldown); text turns ask in
session_service.text_send_turn. Tools the brain's provider runs itself (the
searches, code execution, remote MCP servers) never pass through the app, so
they can't have one.

When each tool was last used, and by which call, is the tool_cooldown_uses
table: per companion, shared by calls and text chat, and kept across restarts. The waits themselves
stay out of companion packages (transfer._agent_portable_fields).
"""
import json
import math
import time


def parse(value):
    """{tool name: seconds} out of agents.tool_cooldowns, or the editor's
    draft of it. Anything that isn't a wait is dropped."""
    try:
        data = json.loads(value or '{}') if isinstance(value, str) else value
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    waits = {}
    for name, seconds in data.items():
        name = str(name).strip()
        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            continue
        if name and seconds > 0:
            waits[name] = seconds
    return waits


def cooldowns_json(value):
    """The agents.tool_cooldowns column, normalised."""
    return json.dumps(parse(value), separators=(',', ':'), sort_keys=True)


def _wait_text(seconds):
    if seconds < 90:
        return '1 second' if seconds == 1 else f'{seconds} seconds'
    if seconds < 90 * 60:
        return f'{math.ceil(seconds / 60)} minutes'
    return f'{round(seconds / 3600, 1):g} hours'


def claim(con, agent, name, call_id):
    """Take `name` for the call `call_id`. None when it may run (the wait
    starts now, if the tool has one), else the result the companion gets
    instead."""
    wait = parse(agent['tool_cooldowns']).get(name)
    if not wait:
        return None
    now = time.time()
    # Checked and taken in one statement: two calls at once (a reply that
    # makes the same call twice) are separate requests, and both would find
    # the tool free if the look came before the write. The row is only
    # written when the last wait is over - or its time is still ahead of the
    # clock, which has been set back since.
    taken = con.execute(
        'INSERT INTO tool_cooldown_uses (agent_id, tool_name, used_at, call_id) VALUES (?, ?, ?, ?) '
        'ON CONFLICT(agent_id, tool_name) DO UPDATE '
        'SET used_at = excluded.used_at, call_id = excluded.call_id '
        'WHERE tool_cooldown_uses.used_at + ? <= excluded.used_at '
        'OR tool_cooldown_uses.used_at > excluded.used_at',
        (agent['id'], name, now, call_id, wait)).rowcount
    if taken:
        return None
    row = con.execute('SELECT used_at FROM tool_cooldown_uses WHERE agent_id = ? AND tool_name = ?',
                      (agent['id'], name)).fetchone()
    left = math.ceil((row['used_at'] if row else now) + wait - now)
    return {'ok': False, 'reason': 'on_cooldown', 'retry_after_seconds': left,
            'message': f'{name} is on a cooldown and was not run. '
                       f'It can be used again in {_wait_text(left)}.'}


def release(con, agent, name, call_id):
    """Give `name` back after the claimed call `call_id` didn't work. Only
    while the wait is still that call's own: a slow call that fails after
    its wait ran out must not clear the wait of a call made since. A claim
    only goes through once the last wait is over, so no wait is what this
    restores."""
    con.execute('DELETE FROM tool_cooldown_uses WHERE agent_id = ? AND tool_name = ? AND call_id = ?',
                (agent['id'], name, call_id))


def settle(con, agent, name, result, call_id):
    """After the claimed call `call_id`: release the tool when `result` (a
    dict, or its JSON) is a failure, the way tools report one - 'error', or
    ok: false."""
    if name not in parse(agent['tool_cooldowns']):
        return
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return
    if isinstance(result, dict) and (result.get('error') or result.get('ok') is False):
        release(con, agent, name, call_id)
