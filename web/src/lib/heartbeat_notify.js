// Silent-heartbeat follow-through in the main window: "the companion wrote
// something while you were away".
//
// The server's scheduler runs silent heartbeats itself, so the browser only
// finds out by asking. This service polls /api/heartbeats/recent_runs and
// does two things with what comes back:
//   1. If a run landed in the text session that is live on screen, its rows
//      are appended to the transcript right away (otherwise a "message the
//      user" heartbeat looks broken until the next resume).
//   2. If the row asked for it (heartbeat.notify) and the global switch is
//      on (config.heartbeat_notifications), the desktop shell raises a
//      native notification; clicking it brings the window up and opens the
//      chat with that companion (notifyState.openChat, consumed by App and
//      TextView). Desktop app only: plain browsers have no bridge and are
//      never prompted for notification permission.
//
// The `since` cursor is the server's own clock, taken on the first call, so
// runs that finished before this window opened never surface, and clock
// skew between machine and server can't matter.
import { reactive } from "./reactive";
import { rpc } from "./rpc";
import { MASCOT_MODE, MASCOT_SETTINGS_MODE, MASCOT_SHARE_MODE, TRANSCRIPT_MODE } from "./ui_state";
import { text } from "../services";

const POLL_MS = 15000;
// Idle re-check of whether any active silent heartbeat exists at all (the
// gate that keeps polling off when the feature is unused). CRUD refreshes
// immediately.
const ENABLED_RECHECK_MS = 5 * 60 * 1000;
const PREVIEW_CHARS = 140;

export const notifyState = reactive({
    // {agentId, sessionId, at} — set by a notification click; App switches
    // to the Chat tab and TextView resumes the session, then clears it.
    openChat: null,
});

/** First bubble of a reply as notification body text: `[next]` splits and
 *  markdown emphasis dropped, cut to one short line. */
function preview(rows) {
    const last = [...rows].reverse().find((r) => r.role === "assistant" && (r.content || "").trim());
    if (!last) return "";
    let s = last.content.split(/\[next\]/i)[0].replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
    if (s.length > PREVIEW_CHARS) s = s.slice(0, PREVIEW_CHARS - 1).trimEnd() + "…";
    return s;
}

class HeartbeatNotifyService {
    constructor() {
        this._enabled = false;
        this._since = null;
        this._lastEnabledCheckAt = 0;
        this._timer = null;
        this._polling = false;
        this._started = false;
    }

    /** Main window only: the pop-out windows share this server and would
     *  double up every toast. Called once from App. */
    start() {
        if (this._started || MASCOT_MODE || MASCOT_SETTINGS_MODE || MASCOT_SHARE_MODE || TRANSCRIPT_MODE) return;
        this._started = true;
        window.rexclawDesktop?.onOpenChat?.((payload) => {
            notifyState.openChat = { ...(payload || {}), at: Date.now() };
        });
        this._timer = setInterval(() => this._tick(), POLL_MS);
        this.refresh();
    }

    /** Re-check whether any active silent heartbeat exists — the polling
     *  gate. Called on boot, every few minutes, and by the HeartbeatsPanel
     *  after any heartbeat change. */
    async refresh() {
        this._lastEnabledCheckAt = Date.now();
        try {
            const rows = await rpc("/api/heartbeats/list", {});
            const was = this._enabled;
            this._enabled = (rows || []).some((h) => h.active && h.mode === "silent");
            if (this._enabled !== was) {
                console.log(`[heartbeat-notify] ${this._enabled ? "polling: active silent heartbeat(s) found" : "idle: no active silent heartbeat"}`);
            }
        } catch (e) {
            console.warn("[heartbeat-notify] refresh failed", e);
        }
    }

    _tick() {
        if (Date.now() - this._lastEnabledCheckAt >= ENABLED_RECHECK_MS) this.refresh();
        if (!this._enabled || this._polling) return;
        this._polling = true;
        this._poll()
            .catch((e) => console.warn("[heartbeat-notify] poll failed", e))
            .finally(() => { this._polling = false; });
    }

    async _poll() {
        const res = await rpc("/api/heartbeats/recent_runs", { since: this._since });
        if (!res || !res.now) return;
        if (!this._since) console.log(`[heartbeat-notify] watching for runs after ${res.now} (server clock)`);
        this._since = res.now;
        for (const run of res.runs || []) {
            const live = text.state.status === "live" && text.state.sessionId === run.session_id;
            console.log(`[heartbeat-notify] "${run.name}" ran for ${run.agent_name} at ${run.ran_at}`
                + ` (${(run.rows || []).length} rows, notify=${run.notify}, global=${res.notifications}, live=${live})`);
            if (live) text.appendExternalRows(run.rows || []);
            if (!res.notifications) continue;
            if (!run.notify) continue;
            this._notify(run);
        }
    }

    _notify(run) {
        const bridge = window.rexclawDesktop;
        if (!bridge?.notify) {
            console.log("[heartbeat-notify] no desktop bridge — notifications need the desktop app");
            return;
        }
        bridge.notify({
            title: run.agent_name || "Rexclaw",
            body: preview(run.rows || []),
            // Absolute URL: the shell fetches the portrait from the server
            // itself (a relative path means nothing outside this page).
            icon: run.agent_icon_url ? new URL(run.agent_icon_url, window.location.origin).href : null,
            agentId: run.agent_id,
            sessionId: run.session_id,
        }).then((ok) => console.log(`[heartbeat-notify] toast ${ok ? "raised" : "refused by the shell"}`))
            .catch((e) => console.warn("[heartbeat-notify] notify failed", e));
    }
}

export const heartbeatNotify = new HeartbeatNotifyService();
