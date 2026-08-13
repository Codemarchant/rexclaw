// WebSocket link to the Rexclaw server. Fail-open by design: the bot plays
// Minecraft fine with no server attached and reconnects forever in the
// background — the companion app is a director, not a dependency.
//
// Protocol (JSON messages):
//   server → bot: {type:"config", api_key, model, hard_model?, base_url?, name?, master?}
//                 {type:"directive", text, hard?}   (always replaces the
//                 current task — there is no queue)
//   bot → server: {type:"hello", version}
//                 {type:"status", data}                      (on change, ~10s)
//                 {type:"event", kind, text, urgency}
//                   kind: ack|done|error|notify|chat|death|online|offline
"use strict";

const WebSocket = require("ws");

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const STATUS_INTERVAL_MS = 10000;
const OUTBOX_MAX = 50;

class Bridge {
    constructor(url, log) {
        this.url = url;
        this.log = log;
        this.ws = null;
        this.stopped = false;
        this.onConfig = null;      // ({api_key, model, ...}) => void
        this.onDirective = null;   // ({text, interrupt}) => void
        this._delay = RECONNECT_BASE_MS;
        this._outbox = [];
        this._lastStatusJson = null;
        this._statusTimer = null;
        // Scheme auto-negotiation: with headset access (HTTPS) on, the
        // Rexclaw server speaks wss — a plain ws handshake gets "socket
        // hang up". Failed attempts alternate ws↔wss until one opens.
        this._altScheme = false;
    }

    _currentUrl() {
        if (!this._altScheme) return this.url;
        return this.url.startsWith("wss:")
            ? this.url.replace(/^wss:/, "ws:")
            : this.url.replace(/^ws:/, "wss:");
    }

    /** extra(): fields merged into every status payload (the brain's goal
     *  state) — the companion needs to know what it is working on. */
    start(host, extra = () => ({})) {
        this.stopped = false;
        this._connect();
        // Status relay: only on change, so an idle bot costs nothing.
        this._statusTimer = setInterval(() => {
            const status = { ...host.status(), ...extra(), inventory: host.inventory() };
            const json = JSON.stringify(status);
            if (json === this._lastStatusJson) return;
            this._lastStatusJson = json;
            this.send({ type: "status", data: status });
        }, STATUS_INTERVAL_MS);
    }

    stop() {
        this.stopped = true;
        clearInterval(this._statusTimer);
        try { this.ws?.close(); } catch (e) { /* fine */ }
    }

    _connect() {
        if (this.stopped) return;
        const url = this._currentUrl();
        this.log(`connecting to rexclaw at ${url}`);
        let ws;
        try {
            // Headset mode uses the app's own self-signed localhost cert —
            // there is nothing a CA could vouch for here, so accept it.
            ws = new WebSocket(url, url.startsWith("wss:") ? { rejectUnauthorized: false } : undefined);
        } catch (e) {
            return this._scheduleReconnect(e.message);
        }
        this.ws = ws;
        let opened = false;
        ws.on("open", () => {
            opened = true;
            this._delay = RECONNECT_BASE_MS;
            this.log("rexclaw connected");
            this.send({ type: "hello", version: require("./package.json").version });
            // Re-announce current status so a restarted server catches up.
            this._lastStatusJson = null;
            const queued = this._outbox.splice(0);
            for (const msg of queued) this.send(msg);
        });
        ws.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
            if (msg.type === "config") this.onConfig?.(msg);
            else if (msg.type === "directive") this.onDirective?.(msg);
        });
        ws.on("error", (e) => this.log("rexclaw ws error:", e.message));
        ws.on("close", () => {
            this.ws = null;
            // Never got a handshake through — try the other scheme next.
            if (!opened) this._altScheme = !this._altScheme;
            if (!this.stopped) this._scheduleReconnect("closed");
        });
    }

    _scheduleReconnect(reason) {
        this.log(`rexclaw link down (${reason}) — retrying in ${Math.round(this._delay / 1000)}s`);
        setTimeout(() => this._connect(), this._delay);
        this._delay = Math.min(this._delay * 2, RECONNECT_MAX_MS);
    }

    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify(msg)); return; } catch (e) { /* fall through */ }
        }
        // Events survive a server restart; unbounded growth doesn't.
        if (msg.type === "event") {
            this._outbox.push(msg);
            if (this._outbox.length > OUTBOX_MAX) this._outbox.shift();
        }
    }

    event(kind, text, urgency = "normal") {
        this.send({ type: "event", kind, text, urgency, at: Date.now() });
    }
}

module.exports = { Bridge };
