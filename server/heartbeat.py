# Copyright 2026 Codemarchant
"""Heartbeats: per-companion scheduled prompts, the standalone stand-in for
the Odoo module's ir.cron heartbeats.

A heartbeat row (see db.py) names an agent, a prompt and an interval. The
scheduler here is a single daemon thread ticking every ~30s:

  * silent rows run entirely server-side — a headless text turn into either
    a fresh isolated session (ended after the turn) or one persistent
    workspace kept across ticks (Odoo's persist mode);
  * call rows are only OFFERED to clients (/api/heartbeats/due_calls): an
    open window claims one and starts a voice call where the companion
    executes the prompt and speaks first. The server can't reach the user's
    speakers, so no client means no call.

Missed-schedule rule: this app runs on user machines that are off half the
time, so a schedule that came due while the server wasn't running is NEVER
auto-run — no catch-up bursts after a month away. The startup pass flags
such rows past_due=1 ("pending user decision"); the scheduler and the
due-calls poll both skip them until the user resolves each from the
Companions view: Execute (run once now, reschedule from now) or Defer
(advance to the next future slot). Call rows that nobody claims for a full
interval past their slot go past_due the same way.

Module-level rule (same as delegate_tools): never import session_service at
module level — it's imported lazily inside the tick to dodge the circular
import.
"""
import logging
import threading
from datetime import datetime, timedelta, timezone

from . import store
from .db import connect, parse_dt, utcnow

_logger = logging.getLogger(__name__)

_TICK_SECONDS = 30

_INTERVAL_UNITS = ('minutes', 'hours', 'days')
_MODES = ('silent', 'call')
# Where each run lands — see the heartbeats DDL in db.py for the semantics.
_SESSION_STRATEGIES = ('isolated', 'persistent', 'latest', 'fixed')


# ---------------------------------------------------------------------------
# Interval math
# ---------------------------------------------------------------------------

def interval_delta(hb):
    """The row's interval as a timedelta. Tolerant: bad numbers clamp to 1,
    unknown units fall back to minutes."""
    try:
        n = max(1, int(hb['interval_number'] or 1))
    except (TypeError, ValueError):
        n = 1
    unit = hb['interval_unit'] if hb['interval_unit'] in _INTERVAL_UNITS else 'minutes'
    return timedelta(**{unit: n})


def compute_next_run(hb, from_dt):
    """next_run_at anchored on `from_dt` (naive UTC) — execute-anchored
    scheduling, so a late run never causes a catch-up burst."""
    return (from_dt + interval_delta(hb)).isoformat(timespec='seconds')


def defer_next_run(hb, now):
    """Defer: advance the STORED next_run_at by whole intervals until it is
    in the future — phase-preserving (a 9:00 daily heartbeat deferred at
    14:00 lands on tomorrow's 9:00, not 14:00 + 1 day)."""
    nxt = parse_dt(hb['next_run_at'])
    step = interval_delta(hb)
    if not nxt:
        return compute_next_run(hb, now)
    while nxt <= now:
        nxt += step
    return nxt.isoformat(timespec='seconds')


# ---------------------------------------------------------------------------
# Prompt context
# ---------------------------------------------------------------------------

def _fmt_local(iso_utc):
    """Naive-UTC ISO string → 'YYYY-MM-DD HH:MM' in the machine's local zone
    (heartbeats are single-user; server local == user local)."""
    dt = parse_dt(iso_utc)
    if not dt:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')


def when_text(iso_utc, now):
    """'YYYY-MM-DD HH:MM (~N ago)' for prompt timelines, or None when
    the timestamp is missing. Shared with session_service's resume note."""
    local = _fmt_local(iso_utc)
    return f'{local} ({_humanize_since(iso_utc, now)})' if local else None


def _humanize_since(iso_utc, now):
    dt = parse_dt(iso_utc)
    if not dt:
        return None
    seconds = max(0, (now - dt).total_seconds())
    if seconds < 90:
        return 'just now'
    minutes = seconds / 60
    if minutes < 90:
        return f'~{round(minutes)} minutes ago'
    hours = minutes / 60
    if hours < 36:
        return f'~{round(hours)} hours ago'
    return f'~{round(hours / 24)} days ago'


def latest_manual_session(con, agent_id):
    """The agent's most recent real conversation — the SAME query the
    "Resume last" action uses, so the 'latest' session strategy writes into
    exactly the thread the user comes back to."""
    return con.execute(
        "SELECT * FROM sessions WHERE agent_id = ?"
        " AND state IN ('ended', 'active') AND origin NOT IN ('delegated', 'heartbeat')"
        " ORDER BY last_active_at DESC, id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()


# Every heartbeat user turn starts with this — how other code tells a
# scheduled turn apart from something the user actually typed.
CONTEXT_PREFIX = '[Scheduled heartbeat '


def build_context_block(con, hb, agent):
    """The user-turn amble a heartbeat runs with — shared verbatim by the
    silent path and the call path (the claim endpoint hands it to the
    browser), so the two surfaces can never drift.

    Self-contained on purpose: the user's absence, the current local clock
    (also in _env_preamble, repeated here so the timeline reads in one
    place), when this heartbeat last ran, and when the last real
    conversation ended — the anchors that make prompts like "write a diary
    entry per elapsed 4-hour period" computable."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    def line(iso_utc, never_text):
        return when_text(iso_utc, now) or never_text

    last = latest_manual_session(con, agent['id'])
    if not last:
        last_line = 'no conversation yet'
    elif last['ended_at']:
        last_line = f'ended {line(last["ended_at"], "")}'
    else:
        # Still-open session (stranded or live) — the honest anchor is its
        # last activity.
        last_line = f'is still open; last active {line(last["last_active_at"], "(unknown)")}'
    name = (hb['name'] or '').strip() or 'unnamed'
    return (
        f'{CONTEXT_PREFIX}"{name}" — this is an autonomous scheduled '
        f'prompt, not typed by the user; the user is not present in the '
        f'conversation right now.]\n'
        f'- Current local datetime: {now.replace(tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")}\n'
        f'- This heartbeat last ran: {line(hb["last_run_at"], "never")}\n'
        f'- Your last real conversation with the user {last_line}\n'
        f'Instructions:\n'
        f'{(hb["prompt"] or "").strip()}'
    )


# ---------------------------------------------------------------------------
# Silent execution
# ---------------------------------------------------------------------------

class SessionBusy(RuntimeError):
    """The target session is live in a voice call right now — the tick is
    retried on a later scheduler pass instead of erroring or writing into
    the user's ongoing conversation."""


# How long a voice session must be quiet (no transcript rows, no activity)
# before an 'active' state is treated as stranded (tab closed without End)
# rather than a live call. Generous on purpose: writing into a live call is
# far worse than a stranded session delaying the diary by half an hour.
_BUSY_QUIET_MINUTES = 30


def _voice_session_live(con, session, now):
    """Best-effort liveness check: the server holds no call socket (the
    browser talks to xAI directly), so 'live' is inferred from recent
    activity on an active voice session. Live calls append transcript rows
    continuously; a stranded session goes quiet."""
    if session['state'] != 'active' or session['mode'] != 'voice':
        return False
    cutoff = now - timedelta(minutes=_BUSY_QUIET_MINUTES)
    la = parse_dt(session['last_active_at'])
    if la and la > cutoff:
        return True
    m = con.execute(
        "SELECT created_at FROM messages WHERE session_id = ?"
        " ORDER BY id DESC LIMIT 1", (session['id'],),
    ).fetchone()
    md = parse_dt(m['created_at']) if m else None
    return bool(md and md > cutoff)


def _resume_for_text(con, session, now):
    """Prepare a reused conversation for a headless text turn — the same
    thing a manual text-mode resume does: reactivate if ended/errored and
    flip a voice-surface session to text (mode tracks the CURRENT surface;
    a later voice resume flips it back). A session live in a call is never
    touched — the tick retries after the call."""
    if _voice_session_live(con, session, now):
        raise SessionBusy(f'session {session["id"]} is in a live call')
    vals = {}
    if session['state'] != 'active':
        vals.update(state='active', ended_at=None)
    if session['mode'] != 'text':
        vals['mode'] = 'text'
    if vals:
        store.update_session(con, session['id'], **vals)
        session = store.get_session(con, session['id'])
    return session


def resolve_session(con, hb, agent, *, mode='text'):
    """Resolve where this tick's turn lands, per session_strategy. Returns
    (session_row, isolated) — isolated sessions are ended after the turn.
    Raises SessionBusy when the target is live in a voice call."""
    strategy = hb['session_strategy'] if hb['session_strategy'] in _SESSION_STRATEGIES else 'isolated'
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if strategy == 'fixed':
        session = con.execute(
            "SELECT * FROM sessions WHERE id = ?", (hb['session_id'],),
        ).fetchone() if hb['session_id'] else None
        if not session:
            # The user picked this session deliberately — don't silently
            # write elsewhere; surface it via last_error instead.
            raise RuntimeError('the chosen session no longer exists — '
                               'pick another in the heartbeat settings')
        return (_resume_for_text(con, session, now) if mode == 'text'
                else session), False

    if strategy == 'latest':
        session = latest_manual_session(con, agent['id'])
        if session:
            return (_resume_for_text(con, session, now) if mode == 'text'
                    else session), False
        # No conversation exists yet — fall back to an isolated tick rather
        # than inventing a "latest" thread the user never started.
        _logger.info('heartbeat %s: no conversation to append to yet — '
                     'running isolated', hb['id'])
        strategy = 'isolated'

    persistent = strategy == 'persistent'
    if persistent and hb['session_id']:
        session = con.execute(
            "SELECT * FROM sessions WHERE id = ?", (hb['session_id'],),
        ).fetchone()
        if session:
            return (_resume_for_text(con, session, now) if mode == 'text'
                    else session), False
        # Workspace was deleted — fall through and create a new one.
    session = store.create_session(con, agent_id=agent['id'], mode=mode,
                                   origin='heartbeat')
    stamp = ('(persistent)' if persistent
             else datetime.now().strftime('%Y-%m-%d %H:%M'))
    vals = {
        'name': f'Heartbeat: {agent["name"]} {stamp}',
        'title_generated': 1,  # keep the name; skip the auto-titler
        'started_at': utcnow(),
        'last_active_at': utcnow(),
    }
    if mode == 'text':
        vals['state'] = 'active'
    store.update_session(con, session['id'], **vals)
    session = store.get_session(con, session['id'])
    if persistent:
        con.execute("UPDATE heartbeats SET session_id = ? WHERE id = ?",
                    (session['id'], hb['id']))
    return session, not persistent


def run_heartbeat(con, hb, *, source='scheduler'):
    """Execute one silent tick (also the past-due Execute action, any mode —
    a list button must not surprise-start a call). Never raises: failures
    are logged into last_error and next_run_at STILL advances, so a broken
    prompt can't hot-loop the scheduler or spend-loop the API key.

    Returns True when the turn completed."""
    from . import session_service as svc  # lazy: circular import

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    ok = False
    error = None
    session = None
    isolated = False
    try:
        agent = con.execute("SELECT * FROM agents WHERE id = ?",
                            (hb['agent_id'],)).fetchone()
        if not agent:
            raise RuntimeError('companion no longer exists')
        if not (hb['prompt'] or '').strip():
            raise RuntimeError('heartbeat has no prompt')

        session, isolated = resolve_session(con, hb, agent)
        if session['needs_summary']:
            # Server-side stand-in for the browser's /compact trigger —
            # non-fatal, a failure just means a bigger replay this turn.
            try:
                svc.text_compact(con, session)
                session = store.get_session(con, session['id'])
            except Exception:
                _logger.exception('heartbeat %s: compaction failed for session %s',
                                  hb['id'], session['id'])

        turn = svc.text_send_turn(
            con, session=session,
            user_text=build_context_block(con, hb, agent),
            headless=True,  # no browser is attached to a heartbeat turn
        )
        if turn.get('type') == 'error':
            raise RuntimeError(turn.get('message') or 'heartbeat turn failed')

        store.update_session(con, session['id'], last_active_at=utcnow())
        if isolated:
            session = store.get_session(con, session['id'])
            svc.end_session(con, session, reason='heartbeat')
        ok = True
    except SessionBusy:
        # Target conversation is live in a call — nothing was persisted.
        # Callers decide the retry policy (the scheduler restores the row's
        # slot and retries next tick; a user-triggered Execute surfaces it).
        raise
    except Exception as e:
        error = str(e) or e.__class__.__name__
        _logger.exception('heartbeat %s (%s, source=%s) failed',
                          hb['id'], hb['name'], source)
        # A failed isolated tick must not leave its throwaway session
        # dangling active (a broken heartbeat would orphan one per tick).
        # Persistent sessions are never flagged — they may be a live user
        # conversation.
        if session is not None and isolated:
            try:
                store.update_session(con, session['id'],
                                     state='errored', ended_at=utcnow())
            except Exception:
                _logger.exception('heartbeat %s: could not flag session %s errored',
                                  hb['id'], session['id'])

    try:
        con.execute(
            "UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, past_due = 0,"
            " last_error = ? WHERE id = ?",
            (now.isoformat(timespec='seconds'), compute_next_run(hb, now), error,
             hb['id']),
        )
        con.commit()
    except Exception:
        # A locked database must not turn one tick into two: the caller
        # already advanced next_run_at before running (claim-before-run),
        # so losing this bookkeeping costs only the last_run/last_error
        # stamps.
        _logger.exception('heartbeat %s: bookkeeping write failed', hb['id'])
    return ok


# ---------------------------------------------------------------------------
# Scheduler thread
# ---------------------------------------------------------------------------

_started = False
_stop = threading.Event()


def _flag_past_due(con, now, *, startup):
    """Flag rows the user must decide on. At startup: anything already due
    (it came due while the server was off — never auto-run). At runtime:
    call rows nobody claimed for a full interval past their slot (the app
    was never opened)."""
    rows = con.execute(
        "SELECT * FROM heartbeats WHERE active = 1 AND past_due = 0"
        " AND next_run_at IS NOT NULL AND next_run_at <= ?"
        + ("" if startup else " AND mode = 'call'"),
        (now.isoformat(timespec='seconds'),),
    ).fetchall()
    flagged = 0
    for hb in rows:
        due = parse_dt(hb['next_run_at'])
        if not due:
            continue
        if startup or now > due + interval_delta(hb):
            con.execute("UPDATE heartbeats SET past_due = 1 WHERE id = ?",
                        (hb['id'],))
            flagged += 1
    if flagged:
        con.commit()
        _logger.info('heartbeat: flagged %d %s row(s) past due (pending user decision)',
                     flagged, 'missed' if startup else 'unclaimed call')


def _tick(con, now):
    _flag_past_due(con, now, startup=False)
    due = con.execute(
        "SELECT * FROM heartbeats WHERE active = 1 AND past_due = 0"
        " AND mode = 'silent' AND next_run_at IS NOT NULL AND next_run_at <= ?"
        " ORDER BY next_run_at, id",
        (now.isoformat(timespec='seconds'),),
    ).fetchall()
    for hb in due:
        if _stop.is_set():
            return
        # Claim-before-run: advance the slot BEFORE the (slow) model turn,
        # guarded on the value we read. If the run's own bookkeeping later
        # fails (e.g. the DB briefly locked by a long request), the row is
        # already rescheduled — one due slot can never run twice.
        claimed = con.execute(
            "UPDATE heartbeats SET next_run_at = ? WHERE id = ?"
            " AND active = 1 AND past_due = 0 AND next_run_at = ?",
            (compute_next_run(hb, now), hb['id'], hb['next_run_at']),
        )
        con.commit()
        if claimed.rowcount == 0:
            continue  # someone else took or rescheduled it meanwhile
        try:
            run_heartbeat(con, hb, source='scheduler')
        except SessionBusy:
            # Target is live in a call — hand the slot back so the next
            # tick retries; the diary catches up right after the call.
            con.execute("UPDATE heartbeats SET next_run_at = ? WHERE id = ?",
                        (hb['next_run_at'], hb['id']))
            con.commit()
            _logger.debug('heartbeat %s: target session is in a live call — '
                          'retrying next tick', hb['id'])
        except Exception:
            # run_heartbeat handles its own failures; this is belt-and-
            # braces so one broken row can't kill the pass for the rest.
            _logger.exception('heartbeat %s: unexpected failure', hb['id'])


def _loop():
    first = True
    while not _stop.is_set():
        con = None
        try:
            con = connect()
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            if first:
                _flag_past_due(con, now, startup=True)
                first = False
            _tick(con, now)
        except Exception:
            _logger.exception('heartbeat scheduler pass failed')
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:
                    pass
        _stop.wait(_TICK_SECONDS)


def start_scheduler():
    global _started
    if _started:
        return
    _started = True
    _stop.clear()
    threading.Thread(target=_loop, name='heartbeat-scheduler',
                     daemon=True).start()
    _logger.info('heartbeat scheduler started (tick every %ss)', _TICK_SECONDS)


def start_scheduler_if_needed():
    """Startup gate: the scheduler thread only spins up when at least one
    active heartbeat exists. Activating one later starts it lazily (the
    save route calls start_scheduler()); once running it stays for the
    process lifetime — an idle tick is one indexed SELECT every 30s."""
    con = connect()
    try:
        any_active = con.execute(
            "SELECT 1 FROM heartbeats WHERE active = 1 LIMIT 1").fetchone()
    finally:
        con.close()
    if any_active:
        start_scheduler()
    else:
        _logger.info('heartbeat scheduler idle — no active heartbeats')


def stop_scheduler():
    _stop.set()
