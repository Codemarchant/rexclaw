import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { confirmAsk } from "../lib/confirm";
import { heartbeatCall } from "../lib/heartbeat_call";
import { withEditorSnapshot, editorDirty, useRegisterChildEditor } from "../lib/child_editor";

/** Heartbeats panel — one companion's scheduled prompts, embedded in the
 *  companion editor. Rows are their own table (like MCP connections):
 *  immediate rpc CRUD, saved independently of the agent form.
 *
 *  A row that came due while the app was closed shows a "past due" badge
 *  instead of running — the user decides per row (or in bulk) whether to
 *  Execute it once now or Defer it to its next future slot. */

const EMPTY_HEARTBEAT = {
    id: null,
    name: "",
    active: 0,
    prompt: "",
    interval_number: 30,
    interval_unit: "minutes",
    mode: "silent",
    // The feature's headline use case: diary entries landing in the thread
    // "Resume last" picks up — so that's what a new heartbeat targets.
    session_strategy: "latest",
    session_id: null,
    next_run_at: null,
};

const UNIT_LABELS = { minutes: "minutes", hours: "hours", days: "days" };
const STRATEGY_LABELS = {
    isolated: "own session per run",
    persistent: "ongoing session",
    latest: "latest conversation",
    fixed: "chosen session",
};

export function fmtLocal(isoUtc) {
    if (!isoUtc) return "—";
    const d = new Date(isoUtc + "Z");
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Naive-UTC ISO (storage format) → value for <input type="datetime-local">. */
function toLocalInput(isoUtc) {
    if (!isoUtc) return "";
    const d = new Date(isoUtc + "Z");
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (user's zone) → naive-UTC ISO for the server. */
function toUtcIso(localValue) {
    if (!localValue) return "";
    const d = new Date(localValue);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 19);
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** now + interval, as naive-UTC ISO — the form's default next-run value,
 *  mirroring what the server would compute on activation. */
function computeNextIso(intervalNumber, intervalUnit) {
    const n = Math.max(1, parseInt(intervalNumber, 10) || 1);
    return new Date(Date.now() + n * (UNIT_MS[intervalUnit] || UNIT_MS.minutes))
        .toISOString().slice(0, 19);
}

export default function HeartbeatsPanel({ agentId, agentName, registerEditor }) {
    const [rows, setRows] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        try {
            setRows(await rpc("/api/heartbeats/list", { agent_id: agentId }));
        } catch (e) {
            notification.add(e?.message || _t("Could not load heartbeats"), { type: "danger" });
        }
    };
    useEffect(() => {
        load();
        // Session picker source: this companion's real conversations. The
        // archive endpoint returns everything; heartbeat/delegated workspace
        // rows are filtered out (a currently-linked one is re-added below).
        (async () => {
            try {
                const all = await rpc("/api/sessions/list", {});
                setSessions((all || []).filter(
                    (s) => s.agent_id === agentId && s.origin === "manual"));
            } catch (e) { /* picker degrades to "keep current" */ }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId]);

    const save = async () => {
        setBusy(true);
        try {
            const { _origNext, _nextTouched, _snap, ...fields } = editing;
            const payload = { ...fields, agent_id: agentId };
            // next_run_at only travels when the user actually changed it —
            // an untouched value must not suppress the server's own
            // rescheduling (activation / interval changes).
            if ((editing.next_run_at || "") === (_origNext || "")) {
                delete payload.next_run_at;
            } else {
                payload.next_run_at = editing.next_run_at || "";
            }
            await rpc("/api/heartbeats/save", payload);
            setEditing(null);
            load();
            heartbeatCall.refresh();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Could not save the heartbeat"), { type: "danger" });
            return false;
        } finally {
            setBusy(false);
        }
    };

    // The companion form's Save commits this draft too (a row-level draft
    // must never die because the user pressed the wrong Save button).
    useRegisterChildEditor(registerEditor, editorDirty(editing), async () => {
        if (!editing || !editorDirty(editing)) return true;
        if (!editing.prompt.trim()
            || (editing.session_strategy === "fixed" && !editing.session_id)) {
            notification.add(
                _t("The open heartbeat draft is incomplete — finish it or cancel it, then save again."),
                { type: "warning" });
            return false;
        }
        return save();
    });

    const toggleActive = async (hb) => {
        try {
            await rpc("/api/heartbeats/save", { id: hb.id, active: hb.active ? 0 : 1 });
            load();
            heartbeatCall.refresh();
        } catch (e) {
            notification.add(e?.message || _t("Could not save the heartbeat"), { type: "danger" });
        }
    };

    const remove = async (hb) => {
        if (!(await confirmAsk(_t("Delete the heartbeat '%s'?", hb.name || _t("(unnamed)"))))) return;
        try {
            await rpc("/api/heartbeats/delete", { id: hb.id });
            load();
            heartbeatCall.refresh();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const resolve = async (hb, action) => {
        setBusy(true);
        try {
            await rpc("/api/heartbeats/resolve", { id: hb.id, action });
            load();
            heartbeatCall.refresh();
        } catch (e) {
            notification.add(e?.message || _t("Could not resolve the heartbeat"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const resolveAll = async (action) => {
        if (action === "execute" && !(await confirmAsk(
            _t("Execute every past-due heartbeat of %s once, now? Each run is a real model turn.", agentName)))) return;
        setBusy(true);
        try {
            await rpc("/api/heartbeats/resolve_all", { agent_id: agentId, action });
            load();
            heartbeatCall.refresh();
        } catch (e) {
            notification.add(e?.message || _t("Could not resolve the heartbeats"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const set = (key, value) => setEditing((c) => ({ ...c, [key]: value }));
    /** Interval edits keep the (untouched) next-run date tracking now +
     *  interval, so the form always shows a truthful next slot. Once the
     *  user edits the date itself, it's theirs. */
    const setInterval_ = (key, value) => setEditing((c) => {
        const next = { ...c, [key]: value };
        if (!c._nextTouched) {
            next.next_run_at = computeNextIso(next.interval_number, next.interval_unit);
        }
        return next;
    });
    const pastDue = rows.filter((r) => r.past_due);
    // Keep a stale link visible: the picker always offers the currently
    // linked session even when it wouldn't pass the filter (auto-created
    // heartbeat workspaces have origin 'heartbeat').
    const pickerSessions = editing?.session_id
            && !sessions.some((s) => s.id === editing.session_id)
        ? [{ id: editing.session_id, name: _t("(current session #%s)", editing.session_id) }, ...sessions]
        : sessions;

    // The edit form: rendered at the top for a NEW draft, and IN PLACE of
    // the row being edited for an existing one — a form jumping to the top
    // of a long list is disorienting.
    const editorForm = editing && (
        <div className="rx_agent_editor" style={{ marginTop: "0.5rem" }}>
            <div className="rx_row">
                <div>
                    <label>{_t("Name")}</label>
                    <input type="text" value={editing.name}
                           placeholder={_t("e.g. 'Afternoon diary'")}
                           onChange={(ev) => set("name", ev.target.value)} />
                </div>
                <div>
                    <label title={_t("How often the heartbeat fires while the app is running. Also drives the default 'Next run' (now + interval) until you pick a date yourself.")}>
                        {_t("Every")}
                    </label>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                        <input type="number" min={1} step={1} style={{ width: "5rem" }}
                               value={editing.interval_number}
                               onChange={(ev) => {
                                   const v = parseInt(ev.target.value, 10);
                                   setInterval_("interval_number", Number.isNaN(v) ? 1 : Math.max(1, v));
                               }} />
                        <select value={editing.interval_unit}
                                onChange={(ev) => setInterval_("interval_unit", ev.target.value)}>
                            <option value="minutes">{_t("minutes")}</option>
                            <option value="hours">{_t("hours")}</option>
                            <option value="days">{_t("days")}</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label title={_t("Silent: the prompt runs as a background text turn — you find the result in the session later. Call the user first: the companion starts a voice call with you, carries out the prompt, and speaks first (needs the app open).")}>
                        {_t("Mode")}
                    </label>
                    <select value={editing.mode}
                            onChange={(ev) => set("mode", ev.target.value)}>
                        <option value="silent">{_t("Silent (background)")}</option>
                        <option value="call">{_t("Call the user first")}</option>
                    </select>
                </div>
            </div>
            <label title={_t("What the companion should do each time the heartbeat fires. It always knows the current time, when this heartbeat last ran, and when you last actually talked — so prompts like 'if it's been more than 4 hours since our last call, write a diary entry about what you've been doing' work.")}>
                {_t("Prompt")}
            </label>
            <textarea rows={5} value={editing.prompt}
                      placeholder={_t("e.g. 'Bring your diary up to date: one date-stamped entry per 4-hour span since our last conversation ended (under 4 hours = one short entry noting it's only been a little while). Decide what you were doing from your job, hobbies and recent conversations; weekends and time off count, and entries may continue the previous span. Sleeping hours are 23:00–07:00: just log \"sleeping\" for those spans. This records your life between calls, so you know what you've been up to when the user comes back.'")}
                      onChange={(ev) => set("prompt", ev.target.value)} />
            <div className="rx_row">
                <div>
                    <label title={_t("Where each run lands. 'Latest conversation' resolves fresh every run to the same session 'Resume last' picks up — so the companion's diary entries are right there next time you resume. 'One ongoing heartbeat session' keeps a workspace of its own. 'A session I pick' always runs in one specific conversation. 'Own session per run' is a throwaway, ended after each run.")}>
                        {_t("Runs in")}
                    </label>
                    <select value={editing.session_strategy || "isolated"}
                            onChange={(ev) => set("session_strategy", ev.target.value)}>
                        <option value="latest">{_t("Latest conversation (the 'Resume last' target)")}</option>
                        <option value="persistent">{_t("One ongoing heartbeat session")}</option>
                        <option value="fixed">{_t("A session I pick")}</option>
                        <option value="isolated">{_t("Own session per run (throwaway)")}</option>
                    </select>
                </div>
                <div>
                    <label title={_t("When the next run is due, in your local time. Maintained automatically — after each run it advances to last run + interval — and you can set it directly to schedule the next run yourself (e.g. tomorrow 09:00). Setting it in the past makes a silent heartbeat run on the next scheduler tick.")}>
                        {_t("Next run")}
                    </label>
                    <input type="datetime-local" value={toLocalInput(editing.next_run_at)}
                           onChange={(ev) => setEditing((c) => ({
                               ...c,
                               next_run_at: toUtcIso(ev.target.value) || null,
                               _nextTouched: true,
                           }))} />
                </div>
            </div>
            {editing.session_strategy === "fixed" && (
                <div style={{ marginTop: "0.25rem" }}>
                    <label title={_t("The conversation this heartbeat always runs in — its turns land in that thread.")}>
                        {_t("Session")}
                    </label>
                    <select value={editing.session_id ?? ""}
                            onChange={(ev) => set("session_id", parseInt(ev.target.value, 10) || null)}>
                        <option value="">{_t("(pick a session…)")}</option>
                        {pickerSessions.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}{s.last_active_at ? ` — ${fmtLocal(s.last_active_at)}` : ""}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <span className="rx_check" style={{ marginTop: "0.25rem" }}>
                <input id={`hb-active-${agentId}`} type="checkbox"
                       checked={!!editing.active}
                       onChange={(ev) => set("active", ev.target.checked ? 1 : 0)} />
                <label htmlFor={`hb-active-${agentId}`}
                       title={_t("The heartbeat only fires while active: at the 'Next run' date, then every interval.")}>
                    {_t("Active")}
                </label>
            </span>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button className="btn btn-sm" onClick={save}
                        disabled={busy || !editing.prompt.trim()
                            || (editing.session_strategy === "fixed" && !editing.session_id)}>
                    {_t("Save heartbeat")}
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>
                    {_t("Cancel")}
                </button>
            </div>
        </div>
    );

    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3 style={{ margin: 0 }}><i className="fa fa-heartbeat" /> {_t("Heartbeats")}</h3>
                <span style={{ display: "flex", gap: "0.5rem" }}>
                    {pastDue.length > 0 && (
                        <>
                            <button className="btn btn-sm" disabled={busy} onClick={() => resolveAll("execute")}
                                    title={_t("Run every past-due heartbeat once now, then reschedule from now")}>
                                <i className={busy ? "fa fa-spinner fa-spin" : "fa fa-play"} /> {_t("Execute all past due")}
                            </button>
                            <button className="btn btn-sm" disabled={busy} onClick={() => resolveAll("defer")}
                                    title={_t("Skip the missed runs — each heartbeat waits for its next scheduled slot")}>
                                <i className="fa fa-forward" /> {_t("Defer all past due")}
                            </button>
                        </>
                    )}
                    <button className="btn btn-sm"
                            onClick={() => setEditing(withEditorSnapshot({
                                ...EMPTY_HEARTBEAT,
                                // Always-populated, like Odoo's nextcall.
                                // Tracks the interval fields until the user
                                // edits the date themselves.
                                next_run_at: computeNextIso(
                                    EMPTY_HEARTBEAT.interval_number,
                                    EMPTY_HEARTBEAT.interval_unit),
                                _nextTouched: false,
                            }))}>
                        <i className="fa fa-plus" /> {_t("Add heartbeat")}
                    </button>
                </span>
            </div>
            <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                {_t("Scheduled prompts that keep the companion living between your conversations — write a diary entry, check on something, or call you. Silent heartbeats run in the background while the app is open; call heartbeats ring you like the wake word does. Schedules missed while the app was closed never run on their own: they wait here, past due, for your decision.")}
            </p>
            {editing && editing.id == null && editorForm}
            {!rows.length && !editing && (
                <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                    {_t("No heartbeats yet.")}
                </p>
            )}
            {rows.map((hb) => (editing && editing.id === hb.id) ? (
                <React.Fragment key={hb.id}>{editorForm}</React.Fragment>
            ) : (
                <div key={hb.id} className="rx_memory_row">
                    <input type="checkbox" checked={!!hb.active}
                           title={_t("Active")}
                           onChange={() => toggleActive(hb)} />
                    <strong>{hb.name || _t("(unnamed)")}</strong>
                    <span className="rx_memory_content text-muted small">
                        {_t("every %s %s", hb.interval_number, _t(UNIT_LABELS[hb.interval_unit] || "minutes"))}
                        {" · "}
                        {hb.mode === "call" ? _t("calls you") : _t("silent")}
                        {" · "}
                        {_t(STRATEGY_LABELS[hb.session_strategy] || "own session per run")}
                    </span>
                    <span className="rx_memory_meta" title={hb.last_error ? `${_t("Last run failed:")} ${hb.last_error}` : undefined}>
                        {hb.last_error ? <i className="fa fa-exclamation-triangle" style={{ marginRight: "0.25rem" }} /> : null}
                        {hb.past_due
                            ? null
                            : hb.active
                                ? `${_t("next:")} ${fmtLocal(hb.next_run_at)}`
                                : _t("inactive")}
                        {hb.last_run_at ? ` · ${_t("last:")} ${fmtLocal(hb.last_run_at)}` : ""}
                    </span>
                    {!!hb.past_due && (
                        <>
                            <span className="small" style={{ color: "var(--rx-danger, #c0392b)", fontWeight: 600 }}
                                  title={_t("This heartbeat came due while the app was closed (or nobody answered its call). It won't run until you decide.")}>
                                <i className="fa fa-clock-o" /> {_t("past due")}
                            </span>
                            <button className="btn btn-sm btn-link p-0" disabled={busy}
                                    title={_t("Run it once now, then reschedule from now")}
                                    onClick={() => resolve(hb, "execute")}>
                                {_t("Execute")}
                            </button>
                            <button className="btn btn-sm btn-link p-0" disabled={busy}
                                    title={_t("Skip the missed run — wait for the next scheduled slot")}
                                    onClick={() => resolve(hb, "defer")}>
                                {_t("Defer")}
                            </button>
                        </>
                    )}
                    <button className="btn btn-sm btn-link p-0"
                            onClick={() => setEditing(withEditorSnapshot({
                                id: hb.id,
                                name: hb.name || "",
                                active: hb.active,
                                prompt: hb.prompt || "",
                                interval_number: hb.interval_number,
                                interval_unit: hb.interval_unit,
                                mode: hb.mode,
                                session_strategy: hb.session_strategy || "isolated",
                                session_id: hb.session_id,
                                // Always populated: rows that never got a
                                // date (created inactive) show a truthful
                                // now + interval that tracks interval edits.
                                next_run_at: hb.next_run_at
                                    || computeNextIso(hb.interval_number, hb.interval_unit),
                                _origNext: hb.next_run_at,
                                _nextTouched: !!hb.next_run_at,
                            }))}>
                        {_t("Edit")}
                    </button>
                    <button className="btn btn-sm btn-link p-0" title={_t("Remove")} onClick={() => remove(hb)}>
                        <i className="fa fa-trash-o" />
                    </button>
                </div>
            ))}
        </div>
    );
}
