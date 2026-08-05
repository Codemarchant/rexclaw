// Voice activation ("hey Eve") — standby wake-phrase listener.
//
// While NO call is live and the feature is enabled, the mic stays open and a
// LOCAL Vosk recognizer (vosk-browser WASM, model served by our own server)
// listens for the wake phrases configured per companion. A match starts a
// call with that companion — resuming its last conversation or starting
// fresh, per its wake_action. Detection is fully offline: nothing is billed
// and no audio leaves the machine until the xAI call actually starts.
//
// The recognizer runs GRAMMAR-CONSTRAINED — Vosk decodes against just the
// wake phrases plus [unk], which is what turns a general recognizer into a
// cheap keyword spotter for arbitrary, runtime-configurable phrases (no
// per-phrase model training). An RMS gate keeps the decoder idle during
// silence so standby costs near-zero CPU.
//
// Window ownership: the desktop app can have two live pages at once (hidden
// main window + mascot overlay) and both must not listen. A BroadcastChannel
// heartbeat elects one: the mascot outranks the main window, ties break on
// instance id. Candidates heartbeat WHILE THEY WANT the feature — including
// during their own live call — so the losing window stays parked even while
// the winner is mid-call (standby during someone else's call would trigger
// on the conversation itself). When the owner's window closes, heartbeats
// stop and the runner-up takes over within a few seconds.
import { reactive, subscribe } from "./reactive";
import { rpc } from "./rpc";
import { MASCOT_MODE, TRANSCRIPT_MODE } from "./ui_state";
import { voice } from "../services";

const HEARTBEAT_MS = 2000;
const OWNER_STALE_MS = 5500;
const TRIGGER_COOLDOWN_MS = 4000;
// RMS gate: feed the decoder only while recent audio has energy. The
// hangover keeps feeding through the quiet gaps inside a phrase.
const RMS_THRESHOLD = 0.01;
const RMS_HANGOVER_MS = 1500;

export const wakeState = reactive({
    // Feature is on AND at least one companion has a phrase (from refresh()).
    enabled: false,
    // off | standby-other-window | acquiring | downloading-model |
    // loading-model | listening | error
    status: "off",
    error: null,
    modelProgress: 0,
    // {agentId, agentName, at} — views watch this to sync their agent
    // selector and (mascot) arm the corner flash.
    lastTrigger: null,
});

function normalizePhrase(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s']/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

class WakeWordService {
    constructor() {
        this._config = { enabled: false, lang: "en" };
        this._agents = [];          // [{id, name, phrase, action, sessionId}]
        this._model = null;
        this._modelUrl = null;
        this._recognizer = null;
        this._mediaStream = null;
        this._audioContext = null;
        this._processor = null;
        this._lastLoudAt = 0;
        this._lastTriggerAt = 0;
        this._armed = false;
        this._starting = false;
        this._disposed = false;

        // Ownership election.
        this._instanceId = Math.random().toString(36).slice(2);
        this._priority = MASCOT_MODE ? 2 : 1;
        this._peerBest = null;      // strongest fresh OTHER candidate {priority, id, at}
        this._channel = null;
        this._heartbeatTimer = null;

        // Debug/test handle (integration tests feed PCM through this).
        if (typeof window !== "undefined") window.__wakeWord = this;
    }

    /** Boot the service for this page. Idempotent. Transcript-mirror windows
     *  never listen — they are passive by design. */
    start() {
        if (TRANSCRIPT_MODE || this._channel) return;
        this._channel = new BroadcastChannel("rexclaw_wake");
        this._channel.onmessage = (ev) => {
            const m = ev.data;
            if (!m || m.type !== "hb" || m.id === this._instanceId) return;
            const best = this._peerBest;
            const fresh = best && Date.now() - best.at <= OWNER_STALE_MS;
            // Keep the strongest fresh peer; a repeat heartbeat from the
            // stored one refreshes its timestamp (id equality passes).
            if (!fresh || m.priority > best.priority
                || (m.priority === best.priority && m.id <= best.id)) {
                this._peerBest = { priority: m.priority, id: m.id, at: Date.now() };
            }
        };
        this._heartbeatTimer = setInterval(() => this._tick(), HEARTBEAT_MS);
        // A call in THIS window suspends standby immediately (the reactive
        // store beats the 2 s tick); the tick re-arms after it ends.
        this._unsubVoice = subscribe(voice.state, () => {
            if (this._callBusy() && (this._armed || this._starting)) {
                this._teardownListening("off");
            }
        });
        this.refresh();
    }

    /** Re-read config + agent wake phrases and reconcile. Call after saving
     *  Settings or editing companions. */
    async refresh() {
        try {
            const cfg = await rpc("/api/config/get", {});
            this._config = {
                enabled: !!cfg.wake_word_enabled,
                lang: cfg.wake_word_language || "en",
            };
            await this._refreshAgents();
        } catch (e) {
            console.warn("[wake] refresh failed", e);
        }
        this._nextArmAttempt = 0;   // an explicit refresh retries right away
        this._tick();
    }

    /** Agents + phrases + freshest resumable session ids. Re-run on every
     *  arm so a resume after a just-ended call picks up the right session. */
    async _refreshAgents() {
        const resp = await rpc("/api/voice/agents", {});
        this._agents = (resp.agents || [])
            .map((a) => ({
                id: Number(a.id),
                name: a.name || "",
                phrase: normalizePhrase(a.wake_phrase),
                action: a.wake_action || "resume_last",
                sessionId: a.last_resumable_session?.id || null,
            }))
            .filter((a) => a.phrase);
        wakeState.enabled = this._config.enabled && this._agents.length > 0;
    }

    // ------------------------------------------------------------------
    // Election + reconciliation
    // ------------------------------------------------------------------

    _wants() {
        return this._config.enabled && this._agents.length > 0 && !this._disposed;
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
        if (!this._wants()) {
            this._teardownListening("off");
            return;
        }
        // Heartbeat even while busy or outranked — wanting the feature is
        // what parks the other windows (see the ownership note up top).
        this._channel?.postMessage({
            type: "hb", id: this._instanceId, priority: this._priority,
        });
        if (this._callBusy()) {
            this._teardownListening("off");
            return;
        }
        if (this._outranked()) {
            this._teardownListening("standby-other-window");
            return;
        }
        if (!this._armed && !this._starting
            && Date.now() >= (this._nextArmAttempt || 0)) {
            this._arm().catch((e) => {
                console.error("[wake] arm failed", e);
                this._teardownListening(null);
                wakeState.status = "error";
                wakeState.error = String(e?.message || e);
                // A failing mic (denied permission, no device) would
                // otherwise retry — and log — every tick. Back off; the
                // next Settings save (refresh) retries immediately.
                this._nextArmAttempt = Date.now() + 30000;
            });
        }
    }

    // ------------------------------------------------------------------
    // Model + audio pipeline
    // ------------------------------------------------------------------

    async _ensureModel() {
        const lang = this._config.lang;
        let status = await rpc("/api/wake/model/status", { lang });
        if (!status.ready) {
            wakeState.status = "downloading-model";
            status = await rpc("/api/wake/model/prepare", { lang });
            while (!status.ready) {
                if (status.error) throw new Error(status.error);
                wakeState.modelProgress = status.progress || 0;
                await new Promise((r) => setTimeout(r, 2000));
                if (this._disposed || !this._wants()) throw new Error("standby disabled");
                status = await rpc("/api/wake/model/status", { lang });
            }
        }
        wakeState.modelProgress = 1;
        if (this._model && this._modelUrl === status.url) return this._model;
        if (this._model) {
            try { this._model.terminate(); } catch (e) { /* already gone */ }
            this._model = null;
        }
        wakeState.status = "loading-model";
        const { createModel } = await import("vosk-browser");
        this._model = await createModel(status.url);
        this._modelUrl = status.url;
        return this._model;
    }

    /** True when arming should abort (state changed while we awaited). */
    _armObsolete() {
        return this._disposed || !this._wants() || this._callBusy() || this._outranked();
    }

    async _arm() {
        this._starting = true;
        try {
            wakeState.status = "acquiring";
            wakeState.error = null;
            // Fresh session ids every arm — the "resume last" target changes
            // every time a call ends.
            await this._refreshAgents();
            if (this._armObsolete()) return;
            const model = await this._ensureModel();
            if (this._armObsolete()) return;

            const phrases = this._agents.map((a) => a.phrase);
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            });
            if (this._armObsolete()) {
                for (const t of stream.getTracks()) t.stop();
                return;
            }
            this._mediaStream = stream;
            const Ctor = window.AudioContext || window.webkitAudioContext;
            this._audioContext = new Ctor();
            if (this._audioContext.state === "suspended") {
                this._audioContext.resume().catch(() => {});
            }
            // Grammar-constrained recognizer: decodes against the phrases
            // plus [unk], so out-of-grammar speech comes out as unknown
            // instead of force-matching the closest phrase.
            const recognizer = new model.KaldiRecognizer(
                this._audioContext.sampleRate,
                JSON.stringify([...phrases, "[unk]"]),
            );
            this._recognizer = recognizer;
            recognizer.on("result", (message) => {
                const text = message?.result?.text || "";
                if (text) this._onRecognized(text);
            });

            const source = this._audioContext.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but universal; this is standby
            // plumbing, deliberately independent of the call's worklet
            // pipeline (which belongs to the call lifecycle).
            const proc = this._audioContext.createScriptProcessor(4096, 1, 1);
            this._processor = proc;
            proc.onaudioprocess = (ev) => {
                if (!this._recognizer) return;
                const data = ev.inputBuffer.getChannelData(0);
                let sum = 0;
                for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
                const rms = Math.sqrt(sum / (data.length / 8));
                const now = performance.now();
                if (rms >= RMS_THRESHOLD) this._lastLoudAt = now;
                if (now - this._lastLoudAt > RMS_HANGOVER_MS) return;  // silence
                try {
                    this._recognizer.acceptWaveformFloat(
                        new Float32Array(data), this._audioContext.sampleRate);
                } catch (e) { /* recognizer torn down mid-frame */ }
            };
            source.connect(proc);
            // Keep the node pulled by the graph; it outputs silence.
            proc.connect(this._audioContext.destination);
            this._armed = true;
            wakeState.status = "listening";
            console.log(`[wake] standby listening for: ${phrases.map((p) => `"${p}"`).join(", ")}`);
        } finally {
            this._starting = false;
        }
    }

    _teardownListening(status) {
        if (this._processor) {
            try { this._processor.disconnect(); } catch (e) { /* gone */ }
            this._processor = null;
        }
        if (this._recognizer) {
            try { this._recognizer.remove(); } catch (e) { /* gone */ }
            this._recognizer = null;
        }
        if (this._mediaStream) {
            for (const t of this._mediaStream.getTracks()) {
                try { t.stop(); } catch (e) { /* gone */ }
            }
            this._mediaStream = null;
        }
        if (this._audioContext && this._audioContext.state !== "closed") {
            this._audioContext.close().catch(() => {});
        }
        this._audioContext = null;
        this._armed = false;
        if (status) wakeState.status = status;
    }

    // ------------------------------------------------------------------
    // Trigger
    // ------------------------------------------------------------------

    _onRecognized(text) {
        const heard = normalizePhrase(text.replace(/\[unk\]/g, " "));
        if (!heard) return;
        const now = Date.now();
        if (now - this._lastTriggerAt < TRIGGER_COOLDOWN_MS) return;
        // Word-boundary match: the grammar limits output words to phrase
        // vocabulary, but require the whole phrase in sequence anyway so a
        // half-decoded fragment can't trigger.
        const agent = this._agents.find(
            (a) => ` ${heard} `.includes(` ${a.phrase} `));
        if (!agent) return;
        this._lastTriggerAt = now;
        console.log(`[wake] phrase "${agent.phrase}" → ${agent.name} (${agent.action})`);
        this._chime();
        wakeState.lastTrigger = { agentId: agent.id, agentName: agent.name, at: now };
        // Free the mic before the call grabs it.
        this._teardownListening("off");
        const sessionId = agent.action === "start_new" ? null : agent.sessionId;
        voice.start(agent.id, sessionId)
            .then((ok) => { if (ok === false) this._tick(); })
            .catch((e) => {
                console.error("[wake] call start failed", e);
                this._tick();   // resume standby rather than going deaf
            });
    }

    /** Soft two-note chime so a wake trigger is never silent — the call
     *  takes seconds to connect, and feedback must be instant. */
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

    /** Test hook: push raw PCM through the live recognizer as if it came
     *  from the mic. Lets integration tests exercise the whole
     *  grammar → trigger path without fake-mic plumbing. */
    _testFeed(float32, sampleRate) {
        this._lastLoudAt = performance.now();
        this._recognizer?.acceptWaveformFloat(float32, sampleRate);
    }
}

export const wakeWord = new WakeWordService();
