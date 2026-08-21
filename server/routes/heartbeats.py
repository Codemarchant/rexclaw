# Copyright 2026 Codemarchant
"""Heartbeat CRUD + past-due resolution + the call-mode claim handshake.

See server/heartbeat.py for the scheduling model. The claim endpoint is the
whole double-fire guard for call mode: the guarded UPDATE consumes the tick
atomically, so even two windows polling at once can only start one call.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends

from .. import heartbeat, store
from ..db import parse_dt, utcnow
from ..errors import UserError
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Row fields the UI may write. next_run_at is special-cased in save (an
# explicit value overrides the auto-recompute); everything else
# (last_run_at, past_due, last_error) is owned by the scheduler/resolve
# endpoints.
_HEARTBEAT_FIELDS = (
    "agent_id", "name", "active", "prompt", "interval_number",
    "interval_unit", "mode", "session_strategy", "session_id",
)


def _row_out(r):
    return {k: r[k] for k in r.keys()}


def _get(con, hb_id):
    row = con.execute("SELECT * FROM heartbeats WHERE id = ?", (hb_id,)).fetchone()
    if not row:
        raise UserError("Heartbeat not found.")
    return row


@router.post("/heartbeats/list")
def heartbeats_list(payload: dict = Body(default={}), con=Depends(db_con)):
    """All heartbeats, or one agent's. The no-agent form powers the global
    past-due banner in the Companions view."""
    agent_id = payload.get("agent_id")
    if agent_id:
        rows = con.execute(
            "SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY id",
            (agent_id,),
        ).fetchall()
    else:
        rows = con.execute("SELECT * FROM heartbeats ORDER BY id").fetchall()
    return [_row_out(r) for r in rows]


@router.post("/heartbeats/save")
def heartbeats_save(payload: dict = Body(default={}), con=Depends(db_con)):
    hb_id = payload.get("id")
    updates = {k: payload[k] for k in _HEARTBEAT_FIELDS if k in payload}

    if "interval_unit" in updates and updates["interval_unit"] not in heartbeat._INTERVAL_UNITS:
        raise UserError("interval_unit must be minutes, hours or days.")
    if "mode" in updates and updates["mode"] not in heartbeat._MODES:
        raise UserError("mode must be silent or call.")
    if "session_strategy" in updates and updates["session_strategy"] not in heartbeat._SESSION_STRATEGIES:
        raise UserError("session_strategy must be isolated, persistent, latest or fixed.")
    if "interval_number" in updates:
        try:
            updates["interval_number"] = max(1, int(updates["interval_number"]))
        except (TypeError, ValueError):
            raise UserError("interval_number must be a positive integer.")
    if updates.get("session_strategy") == "fixed" and not (
            updates.get("session_id")
            or (hb_id and _get(con, hb_id)["session_id"])):
        raise UserError("Pick the session this heartbeat should run in.")
    if updates.get("session_id"):
        target_agent = updates.get("agent_id")
        if not target_agent and hb_id:
            target_agent = _get(con, hb_id)["agent_id"]
        sess = con.execute("SELECT agent_id FROM sessions WHERE id = ?",
                           (updates["session_id"],)).fetchone()
        if not sess or sess["agent_id"] != target_agent:
            raise UserError("That session does not belong to this companion.")
    # Switching away from 'fixed'/'persistent' drops the stale link so the
    # next persistent run starts a fresh workspace.
    if updates.get("session_strategy") in ("isolated", "latest"):
        updates["session_id"] = None

    # Explicit next-run override: the user schedules the next slot directly.
    explicit_next = None
    if "next_run_at" in payload:
        raw = payload["next_run_at"]
        if raw:
            if not parse_dt(raw):
                raise UserError("next_run_at must be an ISO datetime.")
            explicit_next = parse_dt(raw).isoformat(timespec="seconds")

    if hb_id:
        old = _get(con, hb_id)
        if updates:
            cols = ", ".join(f"{k} = ?" for k in updates)
            con.execute(f"UPDATE heartbeats SET {cols} WHERE id = ?",
                        (*updates.values(), hb_id))
    else:
        if not updates.get("agent_id"):
            raise UserError("agent_id is required.")
        if not con.execute("SELECT 1 FROM agents WHERE id = ?",
                           (updates["agent_id"],)).fetchone():
            raise UserError("Companion not found.")
        old = None
        updates.setdefault("name", "")
        updates["created_at"] = utcnow()
        cols = ", ".join(updates)
        marks = ", ".join("?" * len(updates))
        cur = con.execute(f"INSERT INTO heartbeats ({cols}) VALUES ({marks})",
                          tuple(updates.values()))
        hb_id = cur.lastrowid

    # Scheduling side effects. next_run_at is a first-class field (Odoo's
    # nextcall): an explicit value from the form always wins; otherwise it
    # is only backfilled when missing or stale (NULL / already past) on an
    # active row — so a deliberately scheduled future date survives edits
    # and re-activation, and a stale past date can't fire the instant the
    # row is switched on. After each run the scheduler advances it to
    # last run + interval; an interval edit applies from the next run
    # onward (Odoo behaviour), it does not reschedule the pending one.
    # Deactivating clears any pending past-due decision but keeps the date.
    row = _get(con, hb_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if explicit_next:
        con.execute(
            "UPDATE heartbeats SET next_run_at = ?, past_due = 0 WHERE id = ?",
            (explicit_next, hb_id),
        )
    elif row["active"]:
        nxt = parse_dt(row["next_run_at"])
        if not nxt or nxt <= now:
            con.execute(
                "UPDATE heartbeats SET next_run_at = ?, past_due = 0 WHERE id = ?",
                (heartbeat.compute_next_run(row, now), hb_id),
            )
    if not row["active"] and old and old["active"]:
        con.execute("UPDATE heartbeats SET past_due = 0 WHERE id = ?", (hb_id,))
    con.commit()
    if row["active"]:
        # Lazy start: the scheduler thread doesn't run until a heartbeat
        # actually needs it (no-op when already running).
        heartbeat.start_scheduler()
    return {"ok": True, "id": hb_id, "row": _row_out(_get(con, hb_id))}


@router.post("/heartbeats/delete")
def heartbeats_delete(payload: dict = Body(default={}), con=Depends(db_con)):
    hb_id = payload.get("id")
    _get(con, hb_id)
    # The linked session survives — session_id was only a pointer.
    con.execute("DELETE FROM heartbeats WHERE id = ?", (hb_id,))
    con.commit()
    return {"ok": True}


def _claim_past_due(con, hb):
    """Atomically take a past-due row for execution. Executing runs a full
    model turn (slow), so the flag must clear BEFORE the run — otherwise a
    second Execute click double-runs it. next_run_at advances at the same
    moment so a call-mode row doesn't look due to the call poller while its
    silent execution is still in flight. Returns False if someone else
    already took it."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    cur = con.execute(
        "UPDATE heartbeats SET past_due = 0, next_run_at = ?"
        " WHERE id = ? AND past_due = 1",
        (heartbeat.compute_next_run(hb, now), hb["id"]),
    )
    con.commit()
    return cur.rowcount > 0


@router.post("/heartbeats/resolve")
def heartbeats_resolve(payload: dict = Body(default={}), con=Depends(db_con)):
    """User decision on one past-due row: execute (run once now, silently,
    regardless of mode — a list button must not surprise-start a call) or
    defer (skip to the next future slot)."""
    hb = _get(con, payload.get("id"))
    action = payload.get("action")
    if not hb["past_due"]:
        raise UserError("This heartbeat is not past due.")
    if action == "execute":
        if not _claim_past_due(con, hb):
            raise UserError("This heartbeat is already being executed.")
        try:
            heartbeat.run_heartbeat(con, _get(con, hb["id"]), source="resolve")
        except heartbeat.SessionBusy:
            # Hand the decision back — the row returns to past-due.
            con.execute("UPDATE heartbeats SET past_due = 1 WHERE id = ?", (hb["id"],))
            con.commit()
            raise UserError("The target conversation is in a live call — "
                            "try again after the call ends.")
    elif action == "defer":
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        con.execute(
            "UPDATE heartbeats SET past_due = 0, next_run_at = ? WHERE id = ?",
            (heartbeat.defer_next_run(hb, now), hb["id"]),
        )
        con.commit()
    else:
        raise UserError("action must be execute or defer.")
    return {"ok": True, "row": _row_out(_get(con, hb["id"]))}


@router.post("/heartbeats/resolve_all")
def heartbeats_resolve_all(payload: dict = Body(default={}), con=Depends(db_con)):
    """Bulk resolve: all of one companion's past-due rows, or every
    companion's when agent_id is omitted."""
    action = payload.get("action")
    if action not in ("execute", "defer"):
        raise UserError("action must be execute or defer.")
    agent_id = payload.get("agent_id")
    if agent_id:
        rows = con.execute(
            "SELECT * FROM heartbeats WHERE past_due = 1 AND agent_id = ? ORDER BY id",
            (agent_id,),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM heartbeats WHERE past_due = 1 ORDER BY id",
        ).fetchall()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    resolved = 0
    for hb in rows:
        if action == "execute":
            if not _claim_past_due(con, hb):
                continue  # another request took it
            try:
                heartbeat.run_heartbeat(con, _get(con, hb["id"]), source="resolve")
            except heartbeat.SessionBusy:
                # Hand back — stays past due for a later decision.
                con.execute("UPDATE heartbeats SET past_due = 1 WHERE id = ?", (hb["id"],))
                con.commit()
                continue
            resolved += 1
        else:
            con.execute(
                "UPDATE heartbeats SET past_due = 0, next_run_at = ? WHERE id = ?",
                (heartbeat.defer_next_run(hb, now), hb["id"]),
            )
            resolved += 1
    con.commit()
    return {"ok": True, "resolved": resolved}


@router.post("/heartbeats/due_calls")
def heartbeats_due_calls(payload: dict = Body(default={}), con=Depends(db_con)):
    """Call-mode rows waiting for a client. Cheap — polled by open windows."""
    rows = con.execute(
        "SELECT h.id, h.agent_id, h.name, a.name AS agent_name"
        " FROM heartbeats h JOIN agents a ON a.id = h.agent_id"
        " WHERE h.active = 1 AND h.past_due = 0 AND h.mode = 'call'"
        " AND h.next_run_at IS NOT NULL AND h.next_run_at <= ?"
        " ORDER BY h.next_run_at, h.id",
        (utcnow(),),
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/heartbeats/skip_due_calls")
def heartbeats_skip_due_calls(payload: dict = Body(default={}), con=Depends(db_con)):
    """The user is in a call: a due call-mode heartbeat can't ring them, and
    ringing the moment they hang up would be worse — the client calls this
    to skip every due call row to its next future slot instead (no run,
    phase-preserving, same math as Defer)."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = con.execute(
        "SELECT * FROM heartbeats WHERE active = 1 AND past_due = 0"
        " AND mode = 'call' AND next_run_at IS NOT NULL AND next_run_at <= ?",
        (now.isoformat(timespec='seconds'),),
    ).fetchall()
    for hb in rows:
        con.execute("UPDATE heartbeats SET next_run_at = ? WHERE id = ?",
                    (heartbeat.defer_next_run(hb, now), hb["id"]))
    con.commit()
    if rows:
        _logger.info("heartbeat: skipped %d due call(s) to the next slot — "
                     "user is in a call", len(rows))
    return {"ok": True, "skipped": len(rows)}


@router.post("/heartbeats/claim")
def heartbeats_claim(payload: dict = Body(default={}), con=Depends(db_con)):
    """Atomically consume one due call-mode tick. The guarded UPDATE is the
    real double-fire protection (the client-side BroadcastChannel election
    is only belt-and-braces): whichever window's UPDATE lands first wins,
    the loser gets {claimed: false}.

    Consume-on-read: if the winner's call then fails to connect, the tick is
    lost until the next slot — accepted for simplicity."""
    hb = _get(con, payload.get("id"))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    cur = con.execute(
        "UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, last_error = NULL"
        " WHERE id = ? AND active = 1 AND past_due = 0 AND mode = 'call'"
        " AND next_run_at IS NOT NULL AND next_run_at <= ?",
        (now.isoformat(timespec='seconds'), heartbeat.compute_next_run(hb, now),
         hb["id"], now.isoformat(timespec='seconds')),
    )
    if cur.rowcount == 0:
        con.commit()
        return {"claimed": False}
    agent = store.get_agent(con, hb["agent_id"])
    # Which session the call resumes, per strategy. Null → the client starts
    # a fresh normal call — used for 'isolated', for a 'latest' with no
    # conversation yet (the call itself becomes that conversation), and for
    # a 'fixed' whose target is gone. Auto-created persistent workspaces are
    # left in 'draft' — the voice start activates them.
    session_id = None
    strategy = hb["session_strategy"]
    if strategy == "persistent":
        session, _isolated = heartbeat.resolve_session(con, hb, agent, mode="voice")
        session_id = session["id"]
    elif strategy == "latest":
        session = heartbeat.latest_manual_session(con, agent["id"])
        session_id = session["id"] if session else None
    elif strategy == "fixed":
        session = con.execute("SELECT id FROM sessions WHERE id = ?",
                              (hb["session_id"],)).fetchone() if hb["session_id"] else None
        if session:
            session_id = session["id"]
        else:
            _logger.warning("heartbeat %s claim: chosen session is gone — "
                            "starting a fresh call", hb["id"])
    # Built from the PRE-claim row: last_run_at must describe the previous
    # tick, not the stamp the claim just wrote.
    context_block = heartbeat.build_context_block(con, hb, agent)
    con.commit()
    return {
        "claimed": True,
        "agent_id": hb["agent_id"],
        "session_id": session_id,
        "context_block": context_block,
    }
