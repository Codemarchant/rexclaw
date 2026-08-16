# Copyright 2026 Codemarchant
"""Shared route helpers: per-request DB connection + agent/session resolution."""
from .. import store
from ..db import connect, get_config
from ..errors import UserError


def db_con():
    """FastAPI dependency: per-request sqlite connection."""
    con = connect()
    try:
        yield con
    finally:
        con.close()


def coerce_int(value, field_name):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise UserError(f"{field_name} must be an integer.")


def resolve_agent(con, agent_id):
    """agent_id → agents row, falling back to the configured default, then the
    first active agent. Every companion serves both surfaces — the old
    per-mode enable flags are retired."""
    if agent_id:
        return store.get_agent(con, coerce_int(agent_id, 'agent_id'))
    config = get_config(con)
    if config['default_agent_id']:
        row = con.execute(
            "SELECT * FROM agents WHERE id = ? AND active = 1",
            (config['default_agent_id'],),
        ).fetchone()
        if row:
            return row
    row = con.execute(
        "SELECT * FROM agents WHERE active = 1 ORDER BY sequence, name LIMIT 1",
    ).fetchone()
    if not row:
        raise UserError("No agent available. Create one in Settings.")
    return row


def resolve_session(con, session_id):
    return store.get_session(con, coerce_int(session_id, 'session_id'))
