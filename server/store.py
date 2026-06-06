# Copyright 2026 Codemarchant
"""Row helpers + browser payload builders.

The payload shapes here deliberately mirror the Odoo module's `to_payload()`
methods (avatar / background / imagine image) so the ported frontend services
consume them unchanged.
"""
import json

from .db import utcnow
from .errors import UserError, ValidationError


# ---------------------------------------------------------------------------
# Avatars
# ---------------------------------------------------------------------------

def background_payload(row):
    """Mirror rexclaw.voice.avatar.background.to_payload()."""
    payload = {
        'id': row['id'],
        'name': row['name'],
        'type': row['type'],
        'preset_style': row['preset_style'] or False,
        'image_url': row['image_path'] or False,
        'is_default': bool(row['is_default']),
    }
    if row['type'] == 'scene':
        payload.update({
            'scene_url': row['scene_path'] or False,
            'scene_scale': row['scene_scale'] or 1.0,
            'scene_offset': [row['scene_offset_x'], row['scene_offset_y'], row['scene_offset_z']],
            'scene_rotation_y': row['scene_rotation_y'] or 0.0,
        })
    return payload


def avatar_payload(con, avatar_id):
    """Mirror rexclaw.voice.avatar.to_payload(). Returns None when no avatar."""
    if not avatar_id:
        return None
    av = con.execute("SELECT * FROM avatars WHERE id = ?", (avatar_id,)).fetchone()
    if not av:
        return None
    outfit_rows = con.execute(
        "SELECT * FROM avatar_outfits WHERE avatar_id = ? ORDER BY sequence, id",
        (avatar_id,),
    ).fetchall()
    bg_rows = con.execute(
        "SELECT * FROM avatar_backgrounds WHERE avatar_id = ? ORDER BY sequence, id",
        (avatar_id,),
    ).fetchall()
    gesture_rows = con.execute(
        "SELECT * FROM avatar_gestures WHERE avatar_id = ? ORDER BY sequence, id",
        (avatar_id,),
    ).fetchall()

    outfits = [{
        'id': 0,
        'name': 'Default Outfit',
        'vrm_url': av['vrm_path'],
        'is_default': True,
    }]
    for o in outfit_rows:
        if not o['vrm_path']:
            continue
        outfits.append({
            'id': o['id'],
            'name': o['name'],
            'vrm_url': o['vrm_path'],
            'is_default': False,
        })
    backgrounds = [background_payload(b) for b in bg_rows]
    default_bg = next((b for b in bg_rows if b['is_default']), None)
    custom_gestures = [
        {
            'id': g['id'],
            'gesture_enum': g['gesture_enum'],
            'name': g['name'],
            'vrma_url': g['vrma_path'],
            'loop': bool(g['loop']),
        }
        for g in gesture_rows
        if g['gesture_enum'] and g['vrma_path']
    ]
    return {
        'id': av['id'],
        'name': av['name'],
        'vrm_url': av['vrm_path'],
        'vrma_idle_url': av['vrma_idle_path'] or False,
        'backgrounds': backgrounds,
        'default_background_id': default_bg['id'] if default_bg else False,
        'outfits': outfits,
        'custom_gestures': custom_gestures,
    }


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

def get_agent(con, agent_id):
    row = con.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        raise UserError("Agent not found.")
    return row


def list_agents(con, *, mode=None):
    q = "SELECT * FROM agents WHERE active = 1"
    if mode == 'voice':
        q += " AND enable_voice_mode = 1"
    elif mode == 'text':
        q += " AND enable_text_mode = 1"
    q += " ORDER BY sequence, name"
    return con.execute(q).fetchall()


def agent_outfit_dicts(con, agent_row):
    """Additional outfits for the agent's avatar, as plain dicts for the
    change_outfit tool builder."""
    if not agent_row['avatar_id']:
        return []
    rows = con.execute(
        "SELECT id, name, outfit_description FROM avatar_outfits "
        "WHERE avatar_id = ? ORDER BY sequence, id",
        (agent_row['avatar_id'],),
    ).fetchall()
    return [dict(r) for r in rows]


def agent_gesture_dicts(con, agent_row):
    if not agent_row['avatar_id']:
        return []
    rows = con.execute(
        "SELECT gesture_enum, description, loop, vrma_path FROM avatar_gestures "
        "WHERE avatar_id = ? ORDER BY sequence, id",
        (agent_row['avatar_id'],),
    ).fetchall()
    return [dict(r) for r in rows]


def mcp_entries_for(con, agent_id, *, surface):
    """Build the `type:'mcp'` tool entries for this agent's active remote MCP
    connections. Mirrors rexclaw.voice.connection.to_xai_mcp_entry()."""
    flag = 'enable_for_voice' if surface == 'voice' else 'enable_for_text'
    rows = con.execute(
        f"SELECT * FROM mcp_connections WHERE agent_id = ? AND active = 1 AND {flag} = 1 "
        "ORDER BY sequence, id",
        (agent_id,),
    ).fetchall()
    entries = []
    for c in rows:
        entry = {
            'type': 'mcp',
            'server_url': c['server_url'],
            'server_label': c['server_label'],
        }
        if c['server_description']:
            entry['server_description'] = c['server_description']
        if c['authorization']:
            entry['authorization'] = f"Bearer {c['authorization']}"
        allowed = [t.strip() for t in (c['allowed_tools'] or '').splitlines() if t.strip()]
        if allowed:
            entry['allowed_tools'] = allowed
        if c['headers']:
            try:
                extra = json.loads(c['headers'])
                if isinstance(extra, dict) and extra:
                    entry['headers'] = extra
            except (TypeError, ValueError):
                pass
        entries.append(entry)
    return entries


# ---------------------------------------------------------------------------
# Sessions + messages
# ---------------------------------------------------------------------------

def get_session(con, session_id):
    row = con.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise UserError("Session not found.")
    return row


def create_session(con, *, agent_id, mode='voice'):
    from datetime import datetime
    name = datetime.now().strftime('Session %Y-%m-%d %H:%M')  # local wall clock
    cur = con.execute(
        "INSERT INTO sessions (name, agent_id, mode, state) VALUES (?, ?, ?, 'draft')",
        (name, agent_id, mode),
    )
    return get_session(con, cur.lastrowid)


def update_session(con, session_id, **vals):
    if not vals:
        return
    cols = ", ".join(f"{k} = ?" for k in vals)
    con.execute(f"UPDATE sessions SET {cols} WHERE id = ?", (*vals.values(), session_id))


def next_sequence(con, session_id):
    row = con.execute(
        "SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence DESC, id DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    return (row['sequence'] if row else 0) + 1


def insert_message(con, session_id, *, sequence=None, role, content='',
                   tool_name=None, tool_arguments_json=None, tool_result_json=None,
                   xai_item_id=None, xai_call_id=None, xai_previous_item_id=None,
                   is_summary_rollup=0):
    if sequence is None:
        sequence = next_sequence(con, session_id)
    cur = con.execute(
        """INSERT INTO messages (session_id, sequence, role, content, tool_name,
               tool_arguments_json, tool_result_json, xai_item_id, xai_call_id,
               xai_previous_item_id, is_summary_rollup, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (session_id, sequence, role, content or '', tool_name,
         tool_arguments_json, tool_result_json, xai_item_id, xai_call_id,
         xai_previous_item_id, int(bool(is_summary_rollup)), utcnow()),
    )
    return cur.lastrowid


def session_messages(con, session_id, *, where='', params=()):
    q = f"SELECT * FROM messages WHERE session_id = ? {where} ORDER BY sequence ASC, id ASC"
    return con.execute(q, (session_id, *params)).fetchall()


def attachments_for_message(con, message_id):
    return con.execute(
        "SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id",
        (message_id,),
    ).fetchall()


def insert_attachment(con, message_id, a):
    con.execute(
        """INSERT INTO message_attachments
               (message_id, xai_file_id, filename, size_bytes, mimetype, expires_at, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            message_id,
            str(a['xai_file_id']),
            str(a.get('filename') or a['xai_file_id']),
            int(a.get('size_bytes') or 0),
            str(a.get('mimetype') or ''),
            a.get('expires_at') or None,
            utcnow(),
        ),
    )


# ---------------------------------------------------------------------------
# Imagine images
# ---------------------------------------------------------------------------

def imagine_payload(row):
    """Mirror rexclaw.voice.imagine.image.to_payload() — same shape as an
    'image'-type background so the renderer paints either without branching."""
    return {
        'id': row['id'],
        'name': row['name'],
        'type': 'imagine',
        'preset_style': False,
        'image_url': row['image_path'] or False,
        'is_default': False,
        'prompt': row['prompt'],
    }


def latest_imagine_background(con, agent_id):
    row = con.execute(
        "SELECT * FROM imagine_images WHERE agent_id = ? AND kind = 'background' "
        "ORDER BY created_at DESC, id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()
    return row


# ---------------------------------------------------------------------------
# Spend tracking (informational — it's the user's own key)
# ---------------------------------------------------------------------------

USD_TICKS_PER_USD = 10_000_000_000


def accrue_usd_ticks(con, ticks):
    """Add the dollar-equivalent of `ticks` to the config row's spend counters.
    Resets the daily bucket when the date rolls over."""
    try:
        ticks = max(0, int(ticks or 0))
    except (TypeError, ValueError):
        ticks = 0
    if not ticks:
        return
    usd = float(ticks) / float(USD_TICKS_PER_USD)
    today = utcnow()[:10]
    row = con.execute("SELECT spend_today_date FROM config WHERE id = 1").fetchone()
    if row and row['spend_today_date'] != today:
        con.execute(
            "UPDATE config SET spend_today_usd = 0, spend_today_date = ? WHERE id = 1",
            (today,),
        )
    con.execute(
        "UPDATE config SET spend_lifetime_usd = spend_lifetime_usd + ?, "
        "spend_today_usd = spend_today_usd + ?, spend_today_date = ? WHERE id = 1",
        (usd, usd, today),
    )


def extract_cost_ticks(usage):
    """Pull `cost_in_usd_ticks` out of an xAI usage block, tolerantly."""
    if not isinstance(usage, dict):
        return 0
    raw = usage.get('cost_in_usd_ticks')
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0
