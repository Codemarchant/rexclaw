// Heartbeat call mode — "the companion calls you first".
//
// The server's heartbeat scheduler (server/heartbeat.py) runs silent rows
// itself, but it has no path to the user's speakers: call-mode rows are only
// OFFERED over /api/heartbeats/due_calls, and an open window claims one and
// starts the voice call. On claim the server hands back the session to
// resume (the heartbeat's persistent session, if configured) plus the
// prompt wrapped in its temporal context block; we start the call, inject
// the block as a hidden context item with promptResponse, and the companion
// executes the instructions (tools available in-call) and speaks first.
//
// Double-fire protection is the server's atomic claim (a guarded UPDATE —
// one winner per tick). The BroadcastChannel election here is belt-and-
// braces on top, borrowed from wake_word.js: with the hidden main window
// and the mascot overlay both alive, only one polls at all, the mascot
// preferred. The mascot popup needs nothing special — starting the call
// flips the call-busy state MascotView already shows itself for.
import { rpc } from "./rpc";
import { MASCOT_MODE, TRANSCRIPT_MODE } from "./ui_state";
import { voice } from "../services";
import { wakeState } from "./wake_word";

const HEARTBEAT_MS = 2000;
const OWNER_STALE_MS = 5500;
const POLL_MS = 15000;
const TRIGGER_COOLDOWN_MS = 30000;
// How often an idle client re-checks whether any active call-mode heartbeat
// exists at all (the cheap gate that keeps due-polling off entirely when
// the feature is unused). CRUD in this window refreshes immediately.
const ENABLED_RECHECK_MS = 5 * 60 * 1000;
// The call start resolves before the realtime socket necessarily settles —
// retry the injection until the WS accepts it or the call clearly died.
const INJECT_RETRY_MS = 500;
const INJECT_RETRIES = 20;

class HeartbeatCallService {
    constructor() {
        this._enabled = false;      // any active call-mode heartbeat exists
        this._lastEnabledCheckAt = 0;
        this._lastPollAt = 0;
        this._lastTriggerAt = 0;
        this._claiming = false;
        this._disposed = false;

        // Ownership election (wake_word.js pattern).
        this._instanceId = Math.random().toString(36).slice(2);
        this._priority = MASCOT_MODE ? 2 : 1;
        this._peerBest = null;
        this._channel = null;
        this._timer = null;
    }

    /** Boot the service for this page. Idempotent. Transcript-mirror windows
     *  never poll — they are passive by design. */
    start() {
        if (TRANSCRIPT_MODE || this._channel) return;
        this._channel = new BroadcastChannel("rexclaw_hb_call");
        this._channel.onmessage = (ev) => {
            const m = ev.data;
            if (!m || m.type !== "hb" || m.id === this._instanceId) return;
            const best = this._peerBest;
            const fresh = best && Date.now() - best.at <= OWNER_STALE_MS;
            if (!fresh || m.priority > best.priority
                || (m.priority === best.priority && m.id <= best.id)) {
                this._peerBest = { priority: m.priority, id: m.id, at: Date.now() };
            }
        };
        this._timer = setInterval(() => this._tick(), HEARTBEAT_MS);
        this.refresh();
    }

    /** Re-check whether any active call-mode heartbeat exists — the gate
     *  for the due-calls polling. Called on boot, every few minutes, and by
     *  the HeartbeatsPanel after any heartbeat change. */
    async refresh() {
        this._lastEnabledCheckAt = Date.now();
        try {
            const rows = await rpc("/api/heartbeats/list", {});
            this._enabled = (rows || []).some(
                (h) => h.active && !h.past_due && h.mode === "call");
        } catch (e) {
            console.warn("[heartbeat] refresh failed", e);
        }
    }

    _callBusy() {
        const st = voice.state.status;
        return st === "connecting" || st === "live" || st === "ending";
    }

    _outranked() {
        const best = this._peerBest;
        if (!best || Date.now() - best.at > OWNER_STALE_MS) return false;
        if (best.priority !== this._priority) return best.priority > this._priority;
        return best.id < this._instanceId;
    }

    _tick() {
        if (this._disposed) return;
        this._channel?.postMessage({
            type: "hb", id: this._instanceId, priority: this._priority,
        });
        if (this._outranked() || this._claiming) return;
        const now = Date.now();
        if (now - this._lastEnabledCheckAt >= ENABLED_RECHECK_MS) {
            this.refresh();     // fire-and-forget; polling waits for _enabled
        }
        if (!this._enabled) return;
        if (now - this._lastPollAt < POLL_MS) return;
        this._lastPollAt = now;
        if (this._callBusy()) {
            // Already in a call — a due call heartbeat can't ring, and
            // ringing the instant the user hangs up would be worse: skip
            // any due call rows to their next scheduled slot instead.
            rpc("/api/heartbeats/skip_due_calls", {})
                .then((r) => {
                    if (r?.skipped) {
                        console.log(`[heartbeat] in a call — skipped ${r.skipped} due call heartbeat(s) to the next slot`);
                    }
                })
                .catch((e) => console.warn("[heartbeat] skip failed", e));
            return;
        }
        if (now - this._lastTriggerAt < TRIGGER_COOLDOWN_MS) return;
        this._poll().catch((e) => console.warn("[heartbeat] poll failed", e));
    }

    async _poll() {
        const due = await rpc("/api/heartbeats/due_calls", {});
        if (!Array.isArray(due) || !due.length) return;
        if (this._callBusy() || this._outranked() || this._claiming) return;
        const hb = due[0];
        this._claiming = true;
        try {
            // Atomic on the server: with two windows racing, exactly one
            // gets claimed:true. Consume-on-read — a claim whose call then
            // fails is lost until the row's next slot.
            const claim = await rpc("/api/heartbeats/claim", { id: hb.id });
            if (!claim?.claimed) return;
            this._lastTriggerAt = Date.now();
            console.log(`[heartbeat] "${hb.name}" → calling as ${hb.agent_name}`);
            this._chime();
            // Reusing the wake trigger signal on purpose: MascotView/VoiceView
            // already watch it to sync their agent selector and arm the
            // mascot's corner flash — a heartbeat call is the same "the
            // companion is calling you" moment.
            wakeState.lastTrigger = {
                agentId: claim.agent_id, agentName: hb.agent_name, at: Date.now(),
            };
            // The heartbeat block below is the opening — suppress the
            // companion's own speaks-first kickoff so it doesn't greet a
            // user the block says is absent, then speak again.
            const ok = await voice.start(claim.agent_id, claim.session_id || null, { speaksFirst: false });
            if (ok === false) {
                console.warn("[heartbeat] call start refused — tick lost until next slot");
                return;
            }
            await this._injectPrompt(claim.context_block);
        } finally {
            this._claiming = false;
        }
    }

    /** Deliver the prompt: hidden context item + promptResponse so the
     *  companion acts on it and speaks first; recordMessage persists it so
     *  the session's server-side record (and a later resume) includes it. */
    async _injectPrompt(block) {
        if (!block) return;
        for (let i = 0; i < INJECT_RETRIES; i++) {
            const st = voice.state.status;
            if (st !== "connecting" && st !== "live") return; // call died
            if (voice.primary.injectContextItem(block, { promptResponse: true })) {
                voice.primary.recordMessage({ role: "user", content: block });
                return;
            }
            await new Promise((r) => setTimeout(r, INJECT_RETRY_MS));
        }
        console.warn("[heartbeat] prompt injection never went through — "
            + "call is live but the companion got no instructions");
    }

    /** Same soft two-note chime as the wake word — the call takes seconds
     *  to connect and feedback must be instant. */
    _chime() {
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctor();
            const gain = ctx.createGain();
            gain.gain.value = 0.06;
            gain.connect(ctx.destination);
            [[660, 0], [880, 0.12]].forEach(([freq, at]) => {
                const osc = ctx.createOscillator();
                osc.type = "sine";
                osc.frequency.value = freq;
                osc.connect(gain);
                osc.start(ctx.currentTime + at);
                osc.stop(ctx.currentTime + at + 0.15);
            });
            setTimeout(() => ctx.close().catch(() => {}), 600);
        } catch (e) { /* no audio — the mascot flash still shows */ }
    }
}

export const heartbeatCall = new HeartbeatCallService();
