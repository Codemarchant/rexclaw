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


def resolve_gesture_partner(con, gesture_row):
    """Return the gesture row as a plain dict with the combo partner resolved.

    `partner_avatar` names the partner COMPANION, so resolution follows the
    active agent wearing that name first — whatever avatar that agent is
    currently configured with (a duplicated pack, a custom swap) is the
    partner identity. Without a matching agent it falls back to the
    avatar/pack itself. When it resolves, partner_avatar_id /
    partner_vrm_url come from that avatar (so the renderer can borrow an
    already-loaded peer model and the URL tracks the avatar's own file).
    Otherwise the gesture's dedicated partner_vrm_path is used. Solo
    gestures pass through unchanged.
    """
    g = dict(gesture_row)
    if (g.get('gesture_type') or 'solo') != 'combo':
        return g
    g['partner_avatar_id'] = None
    g['partner_vrm_url'] = g.get('partner_vrm_path') or None
    ref = (g.get('partner_avatar') or '').strip()
    if ref:
        row = con.execute(
            "SELECT a.id, a.vrm_path FROM avatars a"
            " JOIN agents ag ON ag.avatar_id = a.id"
            " WHERE ag.active = 1 AND ag.name = ? COLLATE NOCASE LIMIT 1",
            (ref,),
        ).fetchone()
        if not row:
            row = con.execute(
                "SELECT id, vrm_path FROM avatars WHERE pack_key = ? OR name = ? "
                "ORDER BY CASE WHEN pack_key = ? THEN 0 ELSE 1 END LIMIT 1",
                (ref, ref, ref),
            ).fetchone()
        if row:
            g['partner_avatar_id'] = row['id']
            g['partner_vrm_url'] = row['vrm_path']
    return g


def gesture_is_playable(g):
    """Whether this gesture (dict, partner-resolved) has everything the
    browser needs to play it. Shared filter for avatar_payload and
    build_play_gesture_tool so an unfinished combo never reaches the
    play_gesture enum."""
    if not (g.get('gesture_enum') and g.get('vrma_path')):
        return False
    if (g.get('gesture_type') or 'solo') == 'combo':
        return bool(g.get('partner_vrm_url') and g.get('partner_vrma_path'))
    return True


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
    # Custom gestures are surfaced to the dispatcher so play_gesture calls
    # for non-built-in ids resolve to the right VRMA URL. Built-in gestures
    # still come from the static avatar_catalog.js map. Combos ride the same
    # list with type='combo' plus the partner URLs and placement numbers the
    # renderer needs to stage both characters.
    custom_gestures = []
    for g in gesture_rows:
        g = resolve_gesture_partner(con, g)
        if not gesture_is_playable(g):
            continue
        entry = {
            'id': g['id'],
            'gesture_enum': g['gesture_enum'],
            'name': g['name'],
            'vrma_url': g['vrma_path'],
            'loop': bool(g['loop']),
            'type': g.get('gesture_type') or 'solo',
        }
        if entry['type'] == 'combo':
            entry.update({
                # Avatar identity of the partner (False for direct file
                # references). The renderer uses it to recognise when the
                # partner character is ALREADY standing in the call as a
                # live peer avatar — it then borrows that model for the
                # combo instead of spawning a duplicate copy.
                'partner_avatar_id': g.get('partner_avatar_id') or False,
                'partner_vrm_url': g.get('partner_vrm_url') or False,
                'partner_vrma_url': g.get('partner_vrma_path') or False,
                'base_offset_x': g.get('base_offset_x') or 0.0,
                'base_offset_y': g.get('base_offset_y') or 0.0,
                'base_offset_z': g.get('base_offset_z') or 0.0,
                'base_yaw': g.get('base_yaw') or 0.0,
                'base_pitch': g.get('base_pitch') or 0.0,
                'base_roll': g.get('base_roll') or 0.0,
                'partner_offset_x': g.get('partner_offset_x') or 0.0,
                'partner_offset_y': g.get('partner_offset_y') or 0.0,
                'partner_offset_z': g.get('partner_offset_z') or 0.0,
                'partner_yaw': g.get('partner_yaw') or 0.0,
                'partner_pitch': g.get('partner_pitch') or 0.0,
                'partner_roll': g.get('partner_roll') or 0.0,
                'partner_scale': g.get('partner_scale') or 1.0,
            })
        custom_gestures.append(entry)
    return {
        'id': av['id'],
        'name': av['name'],
        'vrm_url': av['vrm_path'],
        'vrma_idle_url': av['vrma_idle_path'] or False,
        'emotion_decay': bool(av['emotion_decay']),
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


def list_agents(con):
    """Every active companion serves both surfaces — the old per-mode enable
    flags are retired."""
    return con.execute(
        "SELECT * FROM agents WHERE active = 1 ORDER BY sequence, name"
    ).fetchall()


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
    """Solo AND combo customs, partner-resolved — a combo is just a gesture
    that stages a second character while it plays, so both kinds share the
    play_gesture enum. Unplayable rows (unfinished combos) are filtered by
    the tool builder via gesture_is_playable."""
    if not agent_row['avatar_id']:
        return []
    rows = con.execute(
        "SELECT * FROM avatar_gestures WHERE avatar_id = ? ORDER BY sequence, id",
        (agent_row['avatar_id'],),
    ).fetchall()
    return [resolve_gesture_partner(con, r) for r in rows]


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


def create_session(con, *, agent_id, mode='voice', origin='manual'):
    from datetime import datetime
    name = datetime.now().strftime('Session %Y-%m-%d %H:%M')  # local wall clock
    cur = con.execute(
        "INSERT INTO sessions (name, agent_id, mode, state, origin) VALUES (?, ?, ?, 'draft', ?)",
        (name, agent_id, mode, origin),
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
                   speaker=None,
                   tool_name=None, tool_arguments_json=None, tool_result_json=None,
                   xai_item_id=None, xai_call_id=None, xai_previous_item_id=None,
                   is_summary_rollup=0):
    if sequence is None:
        sequence = next_sequence(con, session_id)
    cur = con.execute(
        """INSERT INTO messages (session_id, sequence, role, content, speaker, tool_name,
               tool_arguments_json, tool_result_json, xai_item_id, xai_call_id,
               xai_previous_item_id, is_summary_rollup, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (session_id, sequence, role, content or '', speaker or None, tool_name,
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
    # imagine_image_id is browser-supplied (round-tripped from the upload
    # response) — only link a library row that actually exists, keeping the
    # link honest against stale or forged refs.
    imagine_id = a.get('imagine_image_id')
    try:
        imagine_id = int(imagine_id) if imagine_id else None
    except (TypeError, ValueError):
        imagine_id = None
    if imagine_id and not con.execute(
        "SELECT 1 FROM imagine_images WHERE id = ?", (imagine_id,)
    ).fetchone():
        imagine_id = None
    con.execute(
        """INSERT INTO message_attachments
               (message_id, xai_file_id, filename, size_bytes, mimetype, expires_at,
                uploaded_at, imagine_image_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            message_id,
            str(a['xai_file_id']),
            str(a.get('filename') or a['xai_file_id']),
            int(a.get('size_bytes') or 0),
            str(a.get('mimetype') or ''),
            a.get('expires_at') or None,
            utcnow(),
            imagine_id,
        ),
    )


# ---------------------------------------------------------------------------
# Imagine images
# ---------------------------------------------------------------------------

def imagine_payload(row):
    """Mirror rexclaw.voice.imagine.image.to_payload() — same shape as an
    'image'-type background so the renderer paints either without branching.
    Animated backgrounds (kind 'background_video') come out as
    type 'imagine_video' with a video_url — the renderer mounts those as a
    looping <video> layer instead of a CSS backdrop."""
    if row['kind'] == 'background_video':
        return {
            'id': row['id'],
            'name': row['name'],
            'type': 'imagine_video',
            'preset_style': False,
            'video_url': row['image_path'] or False,
            'is_default': False,
            'prompt': row['prompt'],
            'created_at': row['created_at'],
        }
    return {
        'id': row['id'],
        'name': row['name'],
        'type': 'imagine',
        'preset_style': False,
        'image_url': row['image_path'] or False,
        'is_default': False,
        'prompt': row['prompt'],
        'created_at': row['created_at'],
    }


def latest_imagine_background(con, agent_id):
    row = con.execute(
        "SELECT * FROM imagine_images WHERE agent_id = ? AND kind = 'background' "
        "ORDER BY created_at DESC, id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()
    return row


def latest_imagine_video_background(con, agent_id):
    row = con.execute(
        "SELECT * FROM imagine_images WHERE agent_id = ? AND kind = 'background_video' "
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
