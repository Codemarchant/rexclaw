import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { MASCOT_MODE } from "../lib/ui_state";
import { makeConversationState } from "../models/conversation_state";
import {
    AgentConnection,
    floatToPcm16,
    arrayBufferToBase64,
} from "../models/agent_connection";

/**
 * Voice CALL manager (the "voice_companion" registry service).
 *
 * Historically this service WAS the single voice connection. It is now the
 * coordinator of one-or-more AgentConnection legs (models/agent_connection.js)
 * so a call can hold several agents at once:
 *
 *   - owns the SHARED capture pipeline: one AudioContext + one mic
 *     AudioWorklet, whose PCM frames fan out to every leg via
 *     conn.handleMicFrame() (each leg applies its own gating — peers are
 *     deaf by design and receive the conversation as relayed text);
 *   - owns the PRIMARY leg and its reactive state — `this.state` is the
 *     same object the systray / side panel / full view always bound to, so
 *     single-agent behaviour and the public API (start/end/setMuted/
 *     sendText/sendContextEvent) are unchanged;
 *   - owns TURN ORCHESTRATION for group calls: a server-side LLM director
 *     (/voice/director/decide, running on the fastest non-reasoning
 *     model) decides who answers each user utterance and whether agents
 *     continue among themselves; when it can't decide, a user turn falls
 *     to the current floor holder (whoever the user was talking to) and
 *     agent chatter simply waits for the user; a chain cap returns the
 *     floor to the user so two agents can't loop forever;
 *   - relays every spoken/typed turn into the other legs as
 *     speaker-labelled hidden context items, so all agents "hear" the
 *     whole conversation without any audio cross-feeding (text relay is
 *     what every serious multi-agent voice implementation does — audio
 *     cross-feed doubles transcription cost and creates feedback loops).
 */

// How many consecutive agent→agent turns may run before the conversation is
// steered back to the user. Generous enough for real back-and-forth roleplay
// banter; when the cap is hit the next agent gets ONE more turn with a hidden
// "hand the floor back to the user" nudge, then agent chatter pauses until
// the user speaks again.
const MAX_AGENT_CHAIN_TURNS = 10;

// Natural pause between one agent's audio finishing and the next agent
// starting to speak. Machine-gun turn handoffs read as two bots talking at
// each other; a small beat reads as conversation.
const INTER_TURN_PAUSE_MS = 350;

// Client-side ceiling on the LLM director round-trip. Past this the caller
// gives up on the decision (a user turn falls to the floor holder; agent
// chatter waits for the user) — a late decision arriving after the user
// has moved on is worse than no decision. The director runs on a fast
// non-reasoning model, so typical round-trips are well under a second.
const DIRECTOR_TIMEOUT_MS = 4000;

// How often the idle-call watchdog looks at the clock. Fine-grained enough
// that the hangup lands within a few seconds of the configured minute, cheap
// enough to ignore.
const INACTIVITY_TICK_MS = 15000;

class VoiceCallService {
    // xAI's accepted PCM sample rates (from the server validator). Browsers
    // can return native rates outside this set on studio-grade hardware
    // (96000, 88200) — ensureAudioContext snaps to the closest valid rate.
    static XAI_PCM_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

    constructor(env) {
        this.env = env;
        // The primary leg's reactive store doubles as the call-level UI
        // state (status, messages, peers, mute, token budget…). Components
        // keep binding to `voice.state` exactly as before.
        this.state = makeConversationState();
        this.connections = new Map();
        this.primary = new AgentConnection(env, this, {
            connId: "primary",
            role: "primary",
            state: this.state,
        });
        this.connections.set("primary", this.primary);

        // ---- shared capture pipeline ----
        this.audioContext = null;      // capture (mic) context — playback is per-leg
        this._sampleRate = 24000;
        this.micStream = null;
        this.micProcessor = null;
        this._micWorkletReady = false;
        this._micStartPromise = null;

        // UI-side companion preference — see the preferredAgentId accessors
        // below (localStorage-backed so pop-out windows and reloads inherit
        // the pick; this in-memory field is only the private-mode fallback).
        this._preferredAgentId = null;

        // ---- group-call orchestration state ----
        this._peerSeq = 0;
        this._floorConnId = null;          // agent currently holding the floor
        this._suppressPrimaryOnce = false; // eat primary's next auto-response (turn routed to a peer)
        this._directorGeneration = 0;      // bumped on every user turn; stales pending director decisions
        this._consecutiveAgentTurns = 0;
        // Set once the chain cap fired and the wrap-up nudge turn was
        // granted — no further agent-to-agent turns until the user speaks.
        this._userTurnNudgeSent = false;

        // ---- idle-call watchdog ----
        // xAI bills a realtime call by connection time, so a call left open
        // after everyone stopped talking keeps costing money. Configured in
        // Settings → Cost optimization; 0 disables it.
        this._inactivityMinutes = 0;
        this._lastActivityAt = 0;
        this._inactivityTimer = null;

        // Debug handle, mirroring the renderer's window.__voiceRenderer.
        if (typeof window !== "undefined") {
            window.__voiceCall = this;
        }
    }

    get sampleRate() {
        return this._sampleRate;
    }

    /** Back-compat: a couple of callers read the last agent id off the service. */
    get lastAgentId() {
        return this.primary.lastAgentId;
    }

    // ------------------------------------------------------------------
    // Shared capture audio (one mic, fanned out to every leg)
    // ------------------------------------------------------------------

    /** Lazily get the capture AudioContext. Tries the device's native rate
     *  first; if it's outside xAI's accepted set (96000/88200 studio DACs),
     *  recreates the context at the nearest valid rate so xAI's
     *  session.update validator doesn't reject the configuration. */
    ensureAudioContext() {
        if (!this.audioContext || this.audioContext.state === "closed") {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            let ctx = new Ctor();
            if (!VoiceCallService.XAI_PCM_RATES.includes(ctx.sampleRate)) {
                const original = ctx.sampleRate;
                const target = VoiceCallService._snapXaiRate(ctx.sampleRate);
                console.info(
                    `[voice] device native rate ${original}Hz not in xAI's set — recreating AudioContext at ${target}Hz`,
                );
                try { ctx.close(); } catch (_) { /* swallow */ }
                ctx = new Ctor({ sampleRate: target });
            }
            this.audioContext = ctx;
            this._sampleRate = this.audioContext.sampleRate;
        }
        if (this.audioContext.state === "suspended") {
            this.audioContext.resume().catch(() => {});
        }
        return this.audioContext;
    }

    /** Pick the closest xAI-supported PCM rate. Ties break to the lower rate. */
    static _snapXaiRate(rate) {
        const rates = VoiceCallService.XAI_PCM_RATES;
        if (rate <= rates[0]) return rates[0];
        if (rate >= rates[rates.length - 1]) return rates[rates.length - 1];
        let best = rates[0];
        let bestDiff = Math.abs(rates[0] - rate);
        for (const r of rates) {
            const d = Math.abs(r - rate);
            if (d < bestDiff) { best = r; bestDiff = d; }
        }
        return best;
    }

    /** Audio-graph prep hook called by every leg's start(). The mic-bearing
     *  (primary) leg gets the full capture teardown + rebuild — stale
     *  capture state surviving across sessions is the root of the
     *  "speak does nothing after Connect" bug family, and after a
     *  compaction restart a reused worklet put server VAD in a subtly bad
     *  state. Peer legs only need the context (for its rate); their
     *  playback contexts are their own. */
    async prepareAudioForConnection(conn) {
        if (conn.role === "primary") {
            await this._destroyCaptureGraph();
        }
        this.ensureAudioContext();
    }

    /** Tear the shared capture graph down to bare metal. Safe to call
     *  repeatedly — every step is null-guarded. */
    async _destroyCaptureGraph() {
        if (this.micProcessor) {
            try { this.micProcessor.disconnect(); } catch (e) { /* swallow */ }
            this.micProcessor = null;
        }
        if (this.micStream) {
            for (const track of this.micStream.getTracks()) {
                try { track.stop(); } catch (e) { /* swallow */ }
            }
            this.micStream = null;
        }
        if (this.audioContext && this.audioContext.state !== "closed") {
            try { await this.audioContext.close(); } catch (e) { /* swallow */ }
        }
        this.audioContext = null;
        // Worklet module load is per-AudioContext; resetting the flag forces
        // startMic to re-addModule against the fresh context next time.
        this._micWorkletReady = false;
        this._micStartPromise = null;
    }

    /** Acquire mic + wire the PCM-streaming worklet (idempotent, deduped).
     *
     *  Returns true on success, false if the user denied/blocked the mic. A
     *  denial is NOT a session failure — the session starts muted so the
     *  user can still type, and Unmute re-prompts. */
    startMic() {
        if (this.micStream && this.micProcessor) return Promise.resolve(true);
        if (this._micStartPromise) return this._micStartPromise;
        this._micStartPromise = this._doStartMic().finally(() => {
            this._micStartPromise = null;
        });
        return this._micStartPromise;
    }

    async _doStartMic() {
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // No sampleRate hint — let the browser deliver at native
                    // device rate (matches our AudioContext).
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    // AGC normalises the user's input level — crucial for
                    // soft speakers, whose utterances server VAD otherwise
                    // misses below threshold.
                    autoGainControl: true,
                },
            });
        } catch (e) {
            console.warn("[voice] mic unavailable, staying muted:", e?.message || e);
            this.state.muted = true;
            this.env.services.notification?.add?.(
                _t("Microphone unavailable — session is muted. You can type instead, or click Unmute to retry."),
                { type: "info" }
            );
            return false;
        }
        // Bail if the call was torn down while we awaited the permission
        // prompt — don't leave a mic track running with no consumer.
        if (this.primary._sessionEnded) {
            for (const track of this.micStream.getTracks()) {
                try { track.stop(); } catch (_) { /* swallow */ }
            }
            this.micStream = null;
            return false;
        }
        // Detect the mic track ending outside our control (USB yank, OS
        // permission revoke, tab muted) — surface as mute + notification.
        for (const track of this.micStream.getTracks()) {
            track.addEventListener("ended", () => this._onMicTrackEnded(track), { once: true });
        }
        try {
            const ctx = this.ensureAudioContext();
            const source = ctx.createMediaStreamSource(this.micStream);
            if (!this._micWorkletReady) {
                if (this.primary._sessionEnded) {
                    for (const track of this.micStream.getTracks()) {
                        try { track.stop(); } catch (_) { /* swallow */ }
                    }
                    this.micStream = null;
                    return false;
                }
                await ctx.audioWorklet.addModule(
                    "/voice_mic_worklet.js",
                );
                this._micWorkletReady = true;
            }
            if (this.primary._sessionEnded) {
                for (const track of this.micStream.getTracks()) {
                    try { track.stop(); } catch (_) { /* swallow */ }
                }
                this.micStream = null;
                return false;
            }
            this.micProcessor = new AudioWorkletNode(ctx, "mic-capture", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { frameSize: 2048 },
            });
            source.connect(this.micProcessor);
            // The worklet emits silent output; connecting to destination
            // keeps the node alive in the graph.
            this.micProcessor.connect(ctx.destination);
            this.micProcessor.port.onmessage = (ev) => {
                // User-level mute gates ALL legs; per-leg gating (deaf
                // peers, per-leg compaction) happens inside handleMicFrame.
                if (this.state.muted) return;
                const pcm16 = floatToPcm16(ev.data);
                const base64 = arrayBufferToBase64(pcm16.buffer);
                for (const conn of this.connections.values()) {
                    conn.handleMicFrame(base64);
                }
            };
        } catch (e) {
            console.error("[voice] mic setup failed", e);
            if (this.micStream) {
                for (const track of this.micStream.getTracks()) track.stop();
                this.micStream = null;
            }
            this.primary._fail(_t("Microphone setup failed: ") + (e?.message || e));
            throw e;
        }
        return true;
    }

    /** Mic track ended outside our control — disconnect the graph and flip
     *  the UI into muted state; the next setMuted(false) rebuilds. */
    _onMicTrackEnded(track) {
        if (!this.micStream || !this.micStream.getTracks().includes(track)) return;
        if (this.primary._sessionEnded) return;
        console.warn("[voice] mic track ended unexpectedly — going muted");
        if (this.micProcessor) {
            try { this.micProcessor.disconnect(); } catch (_) { /* swallow */ }
            this.micProcessor = null;
        }
        for (const t of this.micStream.getTracks()) {
            try { t.stop(); } catch (_) { /* swallow */ }
        }
        this.micStream = null;
        this.state.muted = true;
        this.env.services.notification?.add?.(
            _t("Microphone disconnected — session muted. Click Unmute to retry."),
            { type: "warning" }
        );
    }

    /** Toggle mic mute. Unmuting lazy-prompts for mic permission if needed. */
    async setMuted(muted) {
        this.noteActivity();
        if (!muted && !this.micProcessor) {
            const ok = await this.startMic();
            if (!ok) return;  // permission denied again; stay muted
        }
        this.state.muted = !!muted;
    }

    // ------------------------------------------------------------------
    // Idle-call watchdog
    // ------------------------------------------------------------------
    // A call nobody is using still bills by the minute, and the usual way
    // that happens is that the user simply walks away. Everything that means
    // "this call is still in use" — someone spoke or typed, a companion took
    // a turn, a tool ran, the roster changed — pushes the deadline out.
    // Muting counts as an action, but staying muted does not: a muted call
    // costs exactly as much as an unmuted one.

    /** Reset the idle countdown. */
    noteActivity() {
        this._lastActivityAt = Date.now();
    }

    /** Adopt the configured idle budget (minutes; 0/absent disables) and arm
     *  the watchdog. Called at session start with the server's config. */
    setInactivityLimit(minutes) {
        const value = Number(minutes);
        this._inactivityMinutes = Number.isFinite(value) && value > 0 ? value : 0;
        this.noteActivity();
        this._stopInactivityWatch();
        if (!this._inactivityMinutes) return;
        this._inactivityTimer = setInterval(
            () => this._checkInactivity(), INACTIVITY_TICK_MS);
    }

    _stopInactivityWatch() {
        if (this._inactivityTimer) {
            clearInterval(this._inactivityTimer);
            this._inactivityTimer = null;
        }
    }

    _checkInactivity() {
        if (!this._inactivityMinutes) {
            this._stopInactivityWatch();
            return;
        }
        // Only a live call can go idle: "connecting" hasn't started billing
        // in earnest, and a terminal one is already over.
        if (this.state.status !== "live") return;
        // A companion mid-sentence (or mid-tool-call) is activity even though
        // no transcript has landed yet — a long monologue must not be cut off.
        const busy = [...this.connections.values()].some(
            (c) => !c.isTerminal
                && (c._responseInFlight || c._pendingToolReply || c._assistantAudioActive()));
        if (busy) {
            this.noteActivity();
            return;
        }
        if (Date.now() - this._lastActivityAt < this._inactivityMinutes * 60000) return;
        const minutes = this._inactivityMinutes;
        this._stopInactivityWatch();
        console.log(`[voice] idle for ${minutes} min — ending the call`);
        // The mascot overlay skips the toast: its corner flash badge is the
        // feedback there, and a toast box floating over the transparent
        // window reads as clutter. The main window keeps it.
        if (!MASCOT_MODE) {
            this.env.services.notification?.add?.(
                _t("Call ended after %s minutes with nothing happening.", minutes),
                { type: "info" },
            );
        }
        this.end("inactivity").catch((e) => console.error("[voice] idle hangup failed", e));
    }

    // ------------------------------------------------------------------
    // Public API (unchanged surface for systray / side panel / full view)
    // ------------------------------------------------------------------

    /** Last companion the user picked. localStorage-backed so it survives
     *  reloads AND crosses windows — the mascot pop-out is a separate page
     *  instance whose own service starts fresh; without this it fell back
     *  to the default agent instead of the one on the call. */
    get preferredAgentId() {
        try {
            return Number(localStorage.getItem("rexclaw.preferred_agent_id")) || this._preferredAgentId || null;
        } catch (e) {
            return this._preferredAgentId || null;
        }
    }

    set preferredAgentId(id) {
        this._preferredAgentId = Number(id) || null;
        try {
            if (id) localStorage.setItem("rexclaw.preferred_agent_id", String(id));
            else localStorage.removeItem("rexclaw.preferred_agent_id");
        } catch (e) { /* private mode — in-memory fallback covers this page */ }
    }

    async start(agentId = null, resumeSessionId = null) {
        this.noteActivity();
        // Stale end reasons must not outlive the call they described — the
        // mascot's flash badge reads it on the NEXT end transition.
        this.state.endReason = null;
        const ok = await this.primary.start(agentId, resumeSessionId, false);
        // Fire-and-forget: rebuild the group-call roster the resumed
        // session last ended with (the server sends it on resume). Covers
        // both manual "Resume last" and window handoffs (mascot pop-out),
        // which are just resumes.
        if (ok !== false) this._restoreCallRoster();
        return ok;
    }

    async end(reason = "client") {
        // Observable end reason: lets the UI tell an automatic hangup (the
        // idle watchdog) from a user-initiated one after the fact.
        this.state.endReason = reason;
        this._stopInactivityWatch();
        // Peers go first (their playback stops and the avatars leave the
        // scene), then the primary leg, then the shared capture graph.
        for (const conn of [...this.connections.values()]) {
            if (conn.role === "peer") {
                await conn.end(reason);
            }
        }
        await this.primary.end(reason);
        await this._destroyCaptureGraph();
        this.env.services.voice_lipsync?.disconnect?.();
    }

    /** Typed input. Solo calls behave exactly as before; group calls ask
     *  the LLM director who answers, same as spoken input. */
    sendText(text) {
        this.noteActivity();
        if (!this.hasPeers()) {
            return this.primary.sendText(text);
        }
        text = (text || "").trim();
        if (!text) return false;
        this._directorGeneration++;
        const generation = this._directorGeneration;
        this._consecutiveAgentTurns = 0;
        this._userTurnNudgeSent = false;
        // The primary leg records the typed turn (visible transcript + its
        // own model context); nobody speaks until the director has picked.
        const ok = this.primary.sendText(text, { promptResponse: false });
        if (!ok) return false;
        const label = this._userLabel();
        for (const peer of this.activePeers()) {
            peer.cancelActiveResponse("typed-input");
            peer.injectContextItem(`[${label}]: ${text}`, { promptResponse: false });
            peer.recordMessage({ role: "user", content: text });
        }
        this._routeUserTurn(text, generation);
        return true;
    }

    /** Hidden context notes (VR touch events etc.) go to the primary leg.
     *  Solo call: the companion reacts to the note immediately. Group call:
     *  the note only informs the primary's NEXT turn — an unprompted
     *  spoken reaction would talk over whichever agent the user actually
     *  addressed (the "wrong agent answers first" failure mode). */
    sendContextEvent(text, opts) {
        this.noteActivity();
        return this.primary.sendContextEvent(text, {
            promptResponse: !this.hasPeers(),
            ...opts,
        });
    }

    enableSpatialAudio() {
        this.primary.enableSpatialAudio();
    }

    disableSpatialAudio() {
        this.primary.disableSpatialAudio();
    }

    // ------------------------------------------------------------------
    // Group calls: add / remove agents
    // ------------------------------------------------------------------

    hasPeers() {
        return this.activePeers().length > 0;
    }

    activePeers() {
        return [...this.connections.values()].filter(
            (c) => c.role === "peer" && !c.isTerminal,
        );
    }

    /** All live legs, primary first — the candidate roster sent to the
     *  LLM director (primary is the last-resort answerer). */
    _participants() {
        const out = [{
            key: "primary",
            name: this.primary.agentName || this.state.agentName || _t("Assistant"),
        }];
        for (const peer of this.activePeers()) {
            out.push({ key: peer.connId, name: peer.agentName || "" });
        }
        return out;
    }

    /** Generic speaker label for the human's relayed lines. Deliberately
     *  NOT the user's real name — if an agent should know the user's name,
     *  that belongs in its system prompt (include_user_name_in_prompt) or
     *  memories, not leaked through call plumbing. */
    _userLabel() {
        return _t("User");
    }

    _setFloor(conn) {
        this._floorConnId = conn ? conn.connId : null;
    }

    /** One line naming everyone CURRENTLY in the call — appended to join/
     *  leave notes so agents never rely on stale history for the roster
     *  (a resumed conversation can mention companions who are long gone). */
    _rosterNote() {
        const names = this._participants().map((p) => p.name).filter(Boolean);
        return `Participants currently in the call: the user and ${names.join(", ")}. ` +
            `If earlier conversation mentions any other companion, they are NOT in the call now — do not address them.`;
    }

    /** Inject a hidden [System] note into every live leg (optionally
     *  skipping one). Join/leave announcements must reach ALL agents — a
     *  peer that only the primary knows about keeps getting addressed as a
     *  ghost by the other peers.
     *
     *  `record: true` additionally persists the note (role 'system', without
     *  the label prefix) to each leg's session so join/leave events survive
     *  into resumed sessions — agents remember who was called in and when
     *  they left. Ephemeral steering nudges should NOT set it. */
    _broadcastSystemNote(text, { except = null, record = false } = {}) {
        for (const conn of this.connections.values()) {
            if (conn === except || conn.isTerminal) continue;
            // Primary has live audio input — immediate text injections get
            // lost behind its audio turns (xAI quirk; see
            // queueDeferredContext). Defer; peers take them immediately.
            if (conn === this.primary) {
                conn.queueDeferredContext(`[System]: ${text}`);
            } else {
                conn.injectContextItem(`[System]: ${text}`, { promptResponse: false });
            }
            if (record) {
                conn.recordMessage({ role: "system", content: text });
            }
        }
    }

    /** Extra /voice/session/start params per leg. Peers run with manual
     *  turn detection (they only speak when the director says so) and are
     *  linked to the primary session for history grouping; every leg gets
     *  the other participants' names so the server can inject a group-call
     *  note into its instructions. */
    getGroupCallParams(conn) {
        const others = this._participants()
            .filter((p) => p.key !== conn.connId)
            .map((p) => p.name)
            .filter(Boolean);
        if (conn.role === "peer") {
            return {
                manual_turn: true,
                call_parent_session_id: this.primary?.state?.sessionId || null,
                group_peers: others,
                // Invited agents continue their most recent session instead
                // of starting amnesiac — same semantics as the solo "Resume
                // last" button. Ignored by the server whenever an explicit
                // resume_session_id is passed (the compaction-restart path).
                resume_last: true,
            };
        }
        // Primary leg: only relevant on a compaction restart while peers
        // are live (a fresh solo start has no peers yet).
        return others.length ? { group_peers: others } : {};
    }

    /** Synchronous pre-check shared by the UI path and the
     *  add_agent_to_call browser tool: can this agent join right now? */
    canAddAgentToCall(agentId) {
        if (this.state.status !== "live") {
            return { ok: false, reason: _t("Start a call before adding another agent.") };
        }
        agentId = Number(agentId);
        if (!agentId) {
            return { ok: false, reason: _t("Unknown agent.") };
        }
        // state.peers covers still-connecting legs; activePeers covers live
        // ones whose roster entry might already be gone mid-teardown.
        if (Number(this.state.agentId) === agentId
            || this.state.peers.some((p) => Number(p.agentId) === agentId)
            || this.activePeers().some((p) => Number(p.state.agentId) === agentId)) {
            return { ok: false, reason: _t("That agent is already in the call.") };
        }
        return { ok: true };
    }

    /** Add another agent to the live call: opens a second xAI websocket
     *  (deaf, manual-turn), resumes the agent's most recent session so it
     *  keeps its memory of past conversations (server-side resume_last),
     *  loads its avatar beside the primary one, and announces the arrival.
     *  It receives NO pre-join transcript — like anyone walking into a
     *  call, it only hears the conversation from the moment it joins. */
    /** Silently re-add the agents from the resumed session's last group
     *  call. Their legs resume their own sessions (memory intact), so a
     *  greeting round would read as amnesia — the silent join path skips
     *  it. Skips anyone already in the call, making the restore idempotent
     *  across resume paths. */
    async _restoreCallRoster() {
        const roster = this.primary?._callPeerAgents || [];
        if (this.primary) this.primary._callPeerAgents = [];
        if (!roster.length) return;
        await this._waitForLive(this.primary, 15000);
        if (this.primary.state.status !== "live") return;
        for (const r of roster) {
            const id = Number(r.agent_id);
            if (!id || id === Number(this.primary.state.agentId)) continue;
            if (this.state.peers.some((p) => Number(p.agentId) === id)) continue;
            try {
                await this.addAgentToCall(id, r.agent_name || "", { silent: true });
            } catch (e) {
                console.error("[voice] call roster restore failed", e);
            }
        }
    }

    async addAgentToCall(agentId, agentName = "", { silent = false } = {}) {
        this.noteActivity();
        const check = this.canAddAgentToCall(agentId);
        if (!check.ok) {
            this.env.services.notification?.add?.(check.reason, { type: "warning" });
            return false;
        }
        agentId = Number(agentId);
        const connId = `peer-${++this._peerSeq}`;
        const conn = new AgentConnection(this.env, this, {
            connId,
            role: "peer",
            state: makeConversationState(),
        });
        this.connections.set(connId, conn);
        this.state.peers.push({
            connId,
            agentId,
            agentName: agentName || "",
            status: "connecting",
        });
        let ok = false;
        try {
            ok = await conn.start(agentId);
        } catch (e) {
            console.error("[voice] add-to-call start failed", e);
        }
        if (!ok || conn.state.status === "error") {
            const msg = conn.state.errorMessage || _t("Could not add the agent to the call.");
            this.env.services.notification?.add?.(msg, { type: "danger" });
            this.connections.delete(connId);
            this.state.peers = this.state.peers.filter((p) => p.connId !== connId);
            return false;
        }
        // Update the roster entry with the server-confirmed name.
        const entry = this.state.peers.find((p) => p.connId === connId);
        if (entry) {
            entry.agentName = conn.agentName || agentName || "";
            entry.status = "live";
        }
        // Wait for the leg to actually reach "live" (ws open + session
        // configured) before injecting context — items sent earlier drop.
        await this._waitForLive(conn, 15000);
        if (conn.isTerminal) return false;

        if (silent) {
            // Window-handoff restore (mascot pop-out/in): this peer isn't
            // NEW to the conversation — its resumed session already carries
            // the original join/group notes and everything said since, so
            // the full join ceremony (join note, room broadcast, greeting
            // round) would read as amnesia and set off a chatter cascade.
            // Reconnect quietly; whoever speaks next goes through the
            // normal director flow.
            conn.injectContextItem(
                _t("[System]: The call reconnected after a window change on the user's side. "
                    + "Do not greet or announce yourself — simply continue the "
                    + "conversation from where it left off."),
                { promptResponse: false },
            );
            return true;
        }

        // Deliberately NO transcript seed: someone walking into a call
        // realistically doesn't know what was said before they arrived, and
        // handing the newcomer the recent lines broke that illusion (it
        // reacted to conversation it "couldn't" have heard). The other
        // participants can catch it up in-conversation if it matters. The
        // short join note still goes in — live and persisted (role 'system')
        // so the resumed record reads naturally: previous conversations →
        // "you were called into a live call" → the group conversation.
        const joinNote = _t(
            "You are joining a live voice call already in progress. " +
            "You have not heard what was said before you joined."
        );
        conn.injectContextItem(`[System]: ${joinNote}`, { promptResponse: false });
        conn.recordMessage({ role: "system", content: joinNote });
        // Tell everyone already in the call who just walked in (the
        // primary's instructions were rendered before the group existed,
        // and other peers' group notes don't include the newcomer).
        this._broadcastSystemNote(
            `${conn.agentName || _t("Another companion")} has joined the voice call. ` +
            `Messages prefixed with a name in brackets were spoken by that participant. ` +
            `Only respond when you are addressed or when it is naturally your turn. ` +
            `When chatting with the other companion(s), do not close your turns by ` +
            `inviting the user back in ("jump back in whenever you're ready") — the ` +
            `user hears everything and will interject when they wish. ` +
            this._rosterNote(),
            { except: conn, record: true },
        );
        // Let the newcomer greet the room (one response, floor then returns
        // to the user unless someone is addressed). Hold the greeting until
        // every other leg's in-flight speech has played out — the joiner may
        // have been summoned by an agent (add_agent_to_call) whose spoken
        // follow-up ("getting Bob now…") is still streaming on ITS leg.
        for (const other of this.connections.values()) {
            if (other === conn || other.isTerminal) continue;
            await this._waitForPlayoutEnd(other, this._directorGeneration);
        }
        // Same natural beat as agent-to-agent handoffs — the greeting
        // shouldn't start the instant the previous speaker's audio cuts.
        await new Promise((r) => setTimeout(r, INTER_TURN_PAUSE_MS));
        if (conn.isTerminal) return false;
        this._consecutiveAgentTurns = 0;
        // The greeting owns the floor: invalidate any agent-chatter
        // deliberation still pending from before the join, so it can't
        // grant another companion right over the newcomer's hello.
        this._directorGeneration++;
        conn.injectContextItem(
            _t("[System]: You have just joined the call. Briefly greet the participants in character."),
            { promptResponse: true },
        );
        this._setFloor(conn);
        return true;
    }

    /** Remove a peer agent from the call (its session ends server-side and
     *  its avatar leaves the scene). The departure announcement happens in
     *  onConnectionEnded so it also covers legs that die on their own. */
    async removeAgentFromCall(connId) {
        this.noteActivity();
        const conn = this.connections.get(connId);
        if (!conn || conn.role !== "peer") return;
        // 'removed', not 'client': a deliberate removal unlinks the leg
        // from the call server-side, so the resume-time roster restore
        // doesn't bring this agent back. Whole-call teardown keeps the
        // link (reason 'client') — that roster SHOULD restore.
        await conn.end("removed");
    }

    /** Synchronous pre-check for the remove_agent_from_call browser tool:
     *  can this agent be disconnected right now? Returns the peer's connId
     *  on success so the caller doesn't need a second lookup. */
    canRemoveAgentFromCall(agentId) {
        agentId = Number(agentId);
        if (!agentId) {
            return { ok: false, reason: _t("Unknown agent.") };
        }
        if (Number(this.state.agentId) === agentId) {
            return {
                ok: false,
                reason: _t("The main companion of this call cannot be removed — only the user can end the call itself."),
            };
        }
        const peer = this.activePeers().find((p) => Number(p.state.agentId) === agentId);
        if (!peer) {
            return { ok: false, reason: _t("That companion is not currently in the call.") };
        }
        return { ok: true, connId: peer.connId };
    }

    /** Agent-initiated whole-call hangup (the end_call tool): same farewell
     *  choreography as removeAgentFromCallWhenIdle, but every leg drains and
     *  then the WHOLE call ends. The grace beat lets the tool caller's
     *  post-tool goodbye start; the playout wait lets it finish. Reason
     *  'agent' keeps it distinguishable from a user click (the mascot's
     *  flash badge cares). Fire-and-forget from the dispatcher. */
    async endCallWhenIdle() {
        await new Promise((r) => setTimeout(r, 1500));
        // Plain drain poll, NOT _waitForPlayoutEnd: its generation-bump abort
        // would fire on ordinary group-call chatter and cut the goodbye off
        // mid-word. A user barge-in cancels the active response anyway, so
        // the loop still exits promptly if the user talks over the farewell.
        const deadline = Date.now() + 30000;
        const anyBusy = () => [...this.connections.values()].some(
            (c) => !c.isTerminal
                && (c._responseInFlight || c._pendingToolReply
                    || c._toolReplyStarting || c._assistantAudioActive()));
        while (anyBusy() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
        }
        if (this.primary._sessionEnded) return false;   // user beat us to it
        await this.end("agent");
        return true;
    }

    /** Graceful, agent-initiated disconnect: wait out the farewell before
     *  pulling the plug. A short grace period lets the tool caller's
     *  post-tool reply START (function_call_output → response.create takes
     *  a beat — and for a self-disconnect that reply IS the goodbye, spoken
     *  on the very leg being removed), then the target's playout drains
     *  before the leg ends. Fire-and-forget from the dispatcher. */
    async removeAgentFromCallWhenIdle(connId) {
        const conn = this.connections.get(connId);
        if (!conn || conn.role !== "peer") return false;
        await new Promise((r) => setTimeout(r, 1500));
        // Ignore the result: a user barge-in aborts the wait early, but the
        // disconnect was requested and still happens.
        await this._waitForPlayoutEnd(conn, this._directorGeneration);
        await this.removeAgentFromCall(connId);
        return true;
    }

    /** Poll a leg until it's live (or terminal / timeout). */
    _waitForLive(conn, timeoutMs = 15000) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                if (conn.state.status === "live" || conn.isTerminal || Date.now() >= deadline) {
                    resolve();
                    return;
                }
                setTimeout(check, 100);
            };
            check();
        });
    }

    /** Last N user/assistant rows of the visible transcript as
     *  speaker-labelled lines (tool rows skipped). */
    _recentTranscriptLines(limit) {
        const primaryName = this.primary.agentName || _t("Assistant");
        const rows = (this.state.messages || [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-limit);
        return rows.map((m) => {
            const who = m.role === "user"
                ? this._userLabel()
                : (m.speaker || primaryName);
            return `[${who}]: ${m.content}`;
        });
    }

    // ------------------------------------------------------------------
    // Connection lifecycle hooks (called by AgentConnection)
    // ------------------------------------------------------------------

    onConnectionEnded(conn) {
        if (conn.role === "peer") {
            this.connections.delete(conn.connId);
            this.state.peers = this.state.peers.filter((p) => p.connId !== conn.connId);
            const renderer = this.env.services.voice_avatar_renderer;
            renderer?.removePeer?.(conn.connId);
            if (conn.lipsyncChannel) {
                this.env.services.voice_lipsync?.removeChannel?.(conn.lipsyncChannel);
            }
            if (this._floorConnId === conn.connId) this._floorConnId = null;
            // Announce the departure to every remaining leg — with the
            // updated roster — but only for participants the room actually
            // met (_everLive), and not while the whole call is tearing down.
            if (conn._everLive && conn.agentName && !this.primary._sessionEnded) {
                this._broadcastSystemNote(
                    `${conn.agentName} has left the voice call. Do not address them anymore. ` +
                    this._rosterNote(),
                    { record: true },
                );
            }
            return;
        }
        // Primary leg went down (End click, ws death, cap) — the call is
        // over; take every peer down with it. Fire-and-forget: each peer's
        // end() re-enters this hook on the peer branch above.
        for (const peer of [...this.connections.values()]) {
            if (peer.role === "peer" && !peer._sessionEnded) {
                peer.end("primary-ended").catch(() => {});
            }
        }
        this._floorConnId = null;
        this._suppressPrimaryOnce = false;
        this._consecutiveAgentTurns = 0;
        this._userTurnNudgeSent = false;
        // However the call died (End click, ws death, token cap, idle
        // hangup), there's nothing left to time out.
        this._stopInactivityWatch();
    }

    // ------------------------------------------------------------------
    // Avatar routing
    // ------------------------------------------------------------------

    /** Build the renderer adapter for a leg. Primary drives the base
     *  avatar; peers drive their own peer slot. Tool dispatchers and the
     *  lipsync listener call through this so each agent's emotions,
     *  gestures, outfits and visemes land on ITS model. */
    buildAvatarApi(conn) {
        const renderer = () => this.env.services.voice_avatar_renderer;
        if (conn.role === "primary") {
            return {
                setVowels: (v) => renderer()?.setVowels?.(v),
                setSpeakingIntensity: (v) => renderer()?.setSpeakingIntensity?.(v),
                setEmotion: (e, o) => renderer()?.setEmotion?.(e, o),
                playGesture: (u, o) => renderer()?.playGesture?.(u, o),
                playComboGesture: (c) => renderer()?.playComboGesture?.(c),
                stopGesture: () => renderer()?.stopGesture?.(),
                setOutfit: (u, i) => renderer()?.setOutfit?.(u, i),
                resetExpression: () => renderer()?.resetExpression?.(),
                setBackground: (bg) => renderer()?.setBackground?.(bg),
            };
        }
        const id = conn.connId;
        return {
            setVowels: (v) => renderer()?.setPeerVowels?.(id, v),
            setSpeakingIntensity: (v) => renderer()?.setPeerSpeakingIntensity?.(id, v),
            setEmotion: (e) => renderer()?.setPeerEmotion?.(id, e),
            playGesture: (u, o) => renderer()?.playPeerGesture?.(id, u, o),
            // The combo machinery is anchored on the BASE avatar. A
            // peer-triggered combo whose partner IS the base avatar works by
            // swapping the roles: the primary performs the partner half, and
            // the triggering peer is picked up as the live "partner" via the
            // borrow-by-avatar-id path. Any other shape (partner is a third
            // character) still falls back to the peer's half solo.
            playComboGesture: (c) => {
                const r = renderer();
                if (!r?.playComboGesture || !c) return;
                const baseAvatarId = r._currentAvatarPayload?.id;
                const peerAvatarId = conn.state?.avatar?.id;
                if (!baseAvatarId || !c.partner_avatar_id
                    || Number(c.partner_avatar_id) !== Number(baseAvatarId)) {
                    console.warn(`[voice] peer combo ${c.gesture_enum}: partner is not the base avatar — playing solo half`);
                    r.playPeerGesture?.(id, c.vrma_url, { loop: !!c.loop });
                    return;
                }
                // Placement slots: for SYMMETRIC combos (both halves play the
                // same clip) the two authored spots are interchangeable, so
                // give each character the spot nearest where it already
                // stands — the pair steps inward instead of crossing sides
                // (Ara leaping a metre left reads as broken staging).
                // Asymmetric combos keep placements bound to their clip half:
                // there the position IS the choreography.
                const symmetric = c.vrma_url === c.partner_vrma_url;
                const baseX = r.vrm?.scene?.position?.x ?? 0;
                const baseKeepsOwnSlot = symmetric
                    && Math.abs((c.base_offset_x || 0) - baseX)
                        <= Math.abs((c.partner_offset_x || 0) - baseX);
                const slotFor = (who) => (who === "base") === baseKeepsOwnSlot
                    ? { x: c.base_offset_x, y: c.base_offset_y, z: c.base_offset_z,
                        yaw: c.base_yaw, pitch: c.base_pitch, roll: c.base_roll }
                    : { x: c.partner_offset_x, y: c.partner_offset_y, z: c.partner_offset_z,
                        yaw: c.partner_yaw, pitch: c.partner_pitch, roll: c.partner_roll };
                const basePos = slotFor("base");
                const peerPos = slotFor("peer");
                r.playComboGesture({
                    ...c,
                    vrma_url: c.partner_vrma_url,
                    partner_vrma_url: c.vrma_url,
                    partner_avatar_id: peerAvatarId || false,
                    partner_vrm_url: conn.state?.avatar?.vrm_url || c.partner_vrm_url,
                    base_offset_x: basePos.x,
                    base_offset_y: basePos.y,
                    base_offset_z: basePos.z,
                    base_yaw: basePos.yaw,
                    base_pitch: basePos.pitch,
                    base_roll: basePos.roll,
                    partner_offset_x: peerPos.x,
                    partner_offset_y: peerPos.y,
                    partner_offset_z: peerPos.z,
                    partner_yaw: peerPos.yaw,
                    partner_pitch: peerPos.pitch,
                    partner_roll: peerPos.roll,
                    // The config's partner_scale sized the ORIGINAL partner
                    // (now the base performer, which can't be scaled) — the
                    // live borrowed peer keeps its natural size.
                    partner_scale: 1.0,
                });
            },
            stopGesture: () => renderer()?.stopPeerGesture?.(id),
            setOutfit: (u, i) => renderer()?.setPeerOutfit?.(id, u, i),
            resetExpression: () => {},
            setBackground: (bg) => renderer()?.setBackground?.(bg),
        };
    }

    /** Role-dependent avatar wiring at session start. Primary keeps the
     *  exact legacy behaviour (configure + background guard + lazy VRM
     *  load); peers load a second VRM into the shared scene. */
    configureAvatarForConnection(conn, payload) {
        const renderer = this.env.services.voice_avatar_renderer;
        if (!renderer) return;
        if (conn.role === "peer") {
            if (payload.avatar?.vrm_url) {
                renderer.setPeerAvatar?.(conn.connId, payload.avatar)
                    .catch?.((e) => console.error("[voice] peer avatar load failed", e));
            }
            return;
        }
        // active_background is resolved server-side, but an explicit pick
        // made in the fullscreen dropdown beats it — see the guard notes in
        // full_view._hydrateAvatar.
        const keepUserBackground = this.state.backgroundPickedByUser;
        if (payload.avatar) {
            renderer.configureFromAvatar(payload.avatar);
            if (!keepUserBackground && payload.active_background !== undefined && renderer.setBackground) {
                renderer.setBackground(payload.active_background || null);
            }
            if (payload.avatar.vrm_url && !renderer.vrm) {
                renderer.loadVRM(payload.avatar.vrm_url).catch((e) => {
                    console.error("[voice] avatar VRM load failed", e);
                });
                if (payload.avatar.vrma_idle_url) {
                    renderer.loadVRMA(payload.avatar.vrma_idle_url).catch(() => {});
                }
            }
        }
        if (!keepUserBackground) {
            this.state.activeBackground = payload.active_background || null;
        }
    }

    // ------------------------------------------------------------------
    // Turn orchestration hooks (called by AgentConnection)
    // ------------------------------------------------------------------

    /** The user's spoken words arrived (primary leg's transcription). Relay
     *  them to every peer, then let the LLM director pick who answers.
     *  The primary's server-VAD auto-response is held back while the
     *  director deliberates so the answer can come from any leg. */
    onUserTranscript(conn, text) {
        this.noteActivity();
        if (conn !== this.primary || !this.hasPeers()) return;
        this._directorGeneration++;
        const generation = this._directorGeneration;
        this._consecutiveAgentTurns = 0;
        this._userTurnNudgeSent = false;
        const label = this._userLabel();
        for (const peer of this.activePeers()) {
            peer.injectContextItem(`[${label}]: ${text}`, { promptResponse: false });
            // Full-conversation tracking: the user's words belong in every
            // leg's session record, not just the primary's (which persists
            // them via its own transcription append).
            peer.recordMessage({ role: "user", content: text });
        }
        // Kill primary's server-VAD auto-response for this turn — whether it
        // already started (cancel) or is yet to arrive (one-shot suppression
        // consumed in onAgentResponseStarted). The director's pick gets an
        // explicit response request instead.
        this._suppressPrimaryOnce = true;
        this.primary.cancelActiveResponse("director-deliberating");
        this._routeUserTurn(text, generation);
    }

    /** Ask the LLM director which agent answers the user's turn, then grant
     *  it the floor. The user just spoke, so SOMEONE must answer: when the
     *  director can't decide (unreachable, timeout, or a nonsensical
     *  "user"), the current floor holder answers — whoever the user was
     *  already talking to — then the primary. */
    async _routeUserTurn(text, generation) {
        const candidates = this._participants();
        const decision = await this._askDirector({
            lastLabel: this._userLabel(),
            text,
            candidates,
        });
        // A newer user turn arrived while the director deliberated — that
        // turn's own routing pass owns the floor now.
        if (generation !== this._directorGeneration) return;
        let targetKey = decision && decision !== "user" ? decision : null;
        if (!targetKey && this._floorConnId
            && candidates.some((p) => p.key === this._floorConnId)) {
            targetKey = this._floorConnId;
        }
        let target = (targetKey && this.connections.get(targetKey)) || this.primary;
        if (target.isTerminal) target = this.primary;
        console.log(`[voice] director: user turn routed to ${target.connId} (${target.agentName})`
            + (decision && decision !== "user" ? "" : " (fallback rules)"));
        if (target === this.primary) {
            // Disarm the one-shot suppression — this response is
            // director-granted, not a stray auto-response.
            this._suppressPrimaryOnce = false;
            if (this.primary._deferredContextItems?.length) {
                // The VAD auto-response (possibly already in flight) was
                // assembled BEFORE the deferred peer lines existed in
                // context — kill it, then _maybeCreateResponse flushes the
                // deferred lines and asks fresh with full knowledge.
                this.primary.cancelActiveResponse("context-refresh");
            }
            this.primary._maybeCreateResponse();
        } else {
            this.primary.cancelActiveResponse(`routed-to-${target.connId}`);
            target.requestResponse();
        }
        this._setFloor(target);
    }

    /** The user physically started speaking: they always win the floor.
     *  Silence every leg (the primary's own handler already stopped its
     *  local audio) and invalidate any pending director decision. */
    onUserSpeechStarted(conn) {
        this.noteActivity();
        if (conn !== this.primary) return;
        this._directorGeneration++;
        console.log(`[voice] chatter: VAD speech_started — generation now ${this._directorGeneration} (pending grants invalidated)`);
        this._consecutiveAgentTurns = 0;
        this._userTurnNudgeSent = false;
        for (const peer of this.activePeers()) {
            peer.cancelActiveResponse("user-barge-in");
        }
    }

    /** A response started on some leg. Consume the one-shot suppression
     *  when the primary auto-responds to a turn that was routed to a peer. */
    onAgentResponseStarted(conn) {
        this.noteActivity();
        if (conn === this.primary && this._suppressPrimaryOnce) {
            this._suppressPrimaryOnce = false;
            console.log("[voice] suppressing primary auto-response (turn routed to a peer)");
            conn.cancelActiveResponse("routed-away");
        }
    }

    /** An agent finished a spoken turn. Mirror peer speech into the visible
     *  transcript, relay the words into every other leg, then decide
     *  whether another agent should respond (LLM director, hard chain
     *  cap). */
    onAgentFinalTranscript(conn, text) {
        this.noteActivity();
        if (!this.hasPeers()) return;
        if (conn.role === "peer") {
            // Display-only mirror: the peer leg already persisted the row
            // to ITS OWN session via its append queue.
            this.state.messages.push({
                role: "assistant",
                speaker: conn.agentName || _t("Companion"),
                content: text,
                sequence: this.state.messages.length + 1,
                mirrored: true,
            });
        }
        const label = conn.agentName || _t("Companion");
        for (const other of this.connections.values()) {
            if (other === conn || other.isTerminal) continue;
            // Primary: DEFER — xAI loses text items injected before an audio
            // turn, and the user's next spoken turn always lands after this
            // relay. The line is flushed right before the primary's next
            // response, where the model can actually see it.
            if (other === this.primary) {
                other.queueDeferredContext(`[${label}]: ${text}`);
            } else {
                const delivered = other.injectContextItem(`[${label}]: ${text}`, { promptResponse: false });
                if (!delivered) {
                    console.warn(`[voice] relay of ${label}'s line to ${other.connId} `
                        + `(${other.agentName}) was NOT delivered — that leg won't know it was said`);
                }
            }
            // Full-conversation tracking: mirror the line into the other
            // leg's session record with speaker attribution. Replay tells
            // "own speech" from "another agent's speech" by comparing the
            // speaker to the session's agent, so the label matters.
            other.recordMessage({ role: "assistant", speaker: label, content: text });
        }
        this._maybeContinueAgentChatter(conn, text);
    }

    /** Agent-to-agent continuation.
     *
     *  Timing: the transcript `.done` event that triggers this fires when
     *  GENERATION completes — the speaker's audio is usually still playing
     *  out of the scheduled buffer. The who-speaks-next decision (LLM
     *  director) runs during that playout so its latency is hidden, but
     *  the floor is only granted AFTER the audio has fully
     *  drained plus a small natural pause — response.create starts the
     *  reply's audio within a second, and granting early made the second
     *  agent talk over the first one's tail.
     *
     *  Chain cap: up to MAX_AGENT_CHAIN_TURNS agent→agent turns run freely
     *  (real back-and-forth). When the cap is reached the next agent gets
     *  ONE wrap-up turn with a hidden nudge to hand the conversation back
     *  to the user, after which agent chatter pauses until the user speaks. */
    async _maybeContinueAgentChatter(speaker, text) {
        const others = this._participants().filter((p) => p.key !== speaker.connId);
        if (!others.length) return;
        const generation = this._directorGeneration;
        console.log(`[voice] chatter: ${speaker.connId} (${speaker.agentName}) finished a line — deciding who's next (gen ${generation})`);

        const capReached = this._consecutiveAgentTurns >= MAX_AGENT_CHAIN_TURNS;
        if (capReached && this._userTurnNudgeSent) {
            // The wrap-up turn already happened — the floor belongs to the
            // user until they take it (any user turn resets the counter).
            console.log("[voice] chatter: chain cap spent — waiting for the user");
            return;
        }

        // Decide the target while the speaker's audio plays. The LLM
        // director is the sole authority here — no decision (unreachable,
        // timeout, or an explicit "user") means the floor returns to the
        // user.
        let targetKey = null;
        if (!capReached) {
            const decision = await this._askDirector({
                lastLabel: speaker.agentName || _t("Companion"),
                text,
                candidates: others,
            });
            // A user turn (spoken or typed) arrived while we deliberated —
            // the user always outranks agent chatter.
            if (generation !== this._directorGeneration) {
                console.log(`[voice] chatter: decision ${JSON.stringify(decision)} DISCARDED — generation bumped mid-deliberation`);
                return;
            }
            console.log(`[voice] chatter: director → ${JSON.stringify(decision)}`);
            targetKey = decision !== "user" ? decision : null;
        } else {
            // Cap hit: force one wrap-up turn on the next participant (in a
            // two-agent call, simply "the other one").
            targetKey = others[0].key;
        }
        if (!targetKey) {
            console.log("[voice] chatter: waiting for the user");
            return;
        }
        const target = this.connections.get(targetKey);
        if (!target || target.isTerminal) {
            console.log(`[voice] chatter: target ${targetKey} missing/terminal — grant dropped`);
            return;
        }

        // Hold the floor grant until the speaker has actually finished
        // SPEAKING (generation done + playback drained), then leave a beat.
        const drained = await this._waitForPlayoutEnd(speaker, generation);
        if (!drained || generation !== this._directorGeneration) {
            console.log(`[voice] chatter: grant to ${targetKey} dropped after playout wait `
                + `(drained=${drained}, generationBumped=${generation !== this._directorGeneration})`);
            return;
        }
        await new Promise((r) => setTimeout(r, INTER_TURN_PAUSE_MS));
        if (generation !== this._directorGeneration) {
            console.log(`[voice] chatter: grant to ${targetKey} dropped — generation bumped during inter-turn pause`);
            return;
        }
        if (target.isTerminal) return;
        // ANY leg still generating or audibly speaking blocks the grant —
        // not just the target and the primary. With 3+ agents, a sibling
        // continuation may have granted another peer while this one waited
        // on the speaker's playout; granting over it would stack two voices.
        // Dropping is self-correcting: the busy leg's own finished line
        // triggers a fresh director pass.
        const busy = [...this.connections.values()].find(
            (c2) => !c2.isTerminal && (c2._responseInFlight || c2._assistantAudioActive()));
        if (busy) {
            console.log(`[voice] chatter: grant to ${targetKey} dropped — ${busy.connId} is busy `
                + `(inFlight=${!!busy._responseInFlight}, audio=${busy._assistantAudioActive()})`);
            return;
        }

        console.log(`[voice] director: ${target.connId} (${target.agentName}) responds to ${speaker.agentName}`
            + (capReached ? " (wrap-up nudge)" : ""));
        // This grant supersedes every other pending deliberation from older
        // lines — bump the generation so a slower sibling continuation can't
        // double-grant a second speaker over this one.
        this._directorGeneration++;
        this._consecutiveAgentTurns++;
        if (capReached) {
            this._userTurnNudgeSent = true;
            target.injectContextItem(
                `[System]: You companions have been talking among yourselves for a while. ` +
                `Give a brief reply, then hand the conversation back to the user — ` +
                `address them directly, e.g. with a question or an invitation to weigh in.`,
                { promptResponse: false },
            );
        }
        if (target === this.primary) {
            // The primary's context got the speaker's words via the relay
            // above; ask it to take the turn. Disarm any leftover one-shot
            // suppression from a routed-away turn whose auto-response never
            // materialised — this response is director-granted, not a stray.
            this._suppressPrimaryOnce = false;
            this.primary._maybeCreateResponse();
        } else {
            target.requestResponse();
        }
        this._setFloor(target);
    }

    /** Resolve true once `conn` has fully finished its spoken turn —
     *  response no longer in flight, no post-tool follow-up reply still
     *  owed (the silent gap between a function_call_output and its
     *  response.create would otherwise read as "idle"), AND all scheduled
     *  audio played out. Resolves false if the user takes the floor
     *  (generation bump), the leg dies, or a generous safety deadline
     *  passes (long monologues are fine; a wedged schedule is not). */
    _waitForPlayoutEnd(conn, generation) {
        return new Promise((resolve) => {
            const deadline = Date.now() + 120000;
            let nextHeartbeat = Date.now() + 5000;
            const check = () => {
                if (generation !== this._directorGeneration) { resolve(false); return; }
                if (conn.isTerminal) { resolve(false); return; }
                if (!conn._responseInFlight && !conn._pendingToolReply
                    && !conn._toolReplyStarting
                    && !conn._assistantAudioActive()) { resolve(true); return; }
                // Diagnostic heartbeat: name what's still holding the floor —
                // a flag that never clears here is a wedged handover.
                if (Date.now() >= nextHeartbeat) {
                    nextHeartbeat = Date.now() + 5000;
                    console.log(`[voice] chatter: still waiting on ${conn.connId} playout `
                        + `(inFlight=${!!conn._responseInFlight}, pendingTool=${!!conn._pendingToolReply}, `
                        + `toolStarting=${!!conn._toolReplyStarting}, audio=${conn._assistantAudioActive()})`);
                }
                if (Date.now() >= deadline) { resolve(false); return; }
                setTimeout(check, 100);
            };
            check();
        });
    }

    /** Server-side LLM director: given the recent labelled transcript,
     *  which of `candidates` (or the user) should speak next?
     *
     *  Return contract mirrors the server's: a candidate key routes to
     *  that agent; the literal "user" is an EXPLICIT decision to wait for
     *  the user; null means the director was unreachable (no model
     *  configured, timeout, error, garbage answer) — callers apply their
     *  own default (user turns: floor holder; agent turns: wait). */
    async _askDirector({ lastLabel, text, candidates }) {
        const sessionId = this.primary?.state?.sessionId;
        if (!sessionId) return null;
        // 12 lines (the server's cap) rather than a bare minimum: standing
        // user instructions like "keep talking amongst yourselves" must stay
        // inside the director's window across several agent turns.
        const transcript = this._recentTranscriptLines(12);
        // The freshly-finished line may not be in state.messages yet —
        // make sure the director sees it last.
        const lastLine = `[${lastLabel}]: ${text}`;
        if (!transcript.length || transcript[transcript.length - 1] !== lastLine) {
            transcript.push(lastLine);
        }
        const payload = {
            session_id: sessionId,
            transcript,
            participants: candidates.map((p) => ({ key: p.key, name: p.name })),
            user_name: this._userLabel(),
            floor_key: this._floorConnId,
        };
        try {
            const resp = await Promise.race([
                rpc("/api/voice/director/decide", payload),
                new Promise((resolve) => setTimeout(() => resolve(null), DIRECTOR_TIMEOUT_MS)),
            ]);
            if (!resp || !resp.next) return null;
            if (resp.next === "user") return "user";
            return candidates.some((p) => p.key === resp.next) ? resp.next : null;
        } catch (e) {
            console.warn("[voice] director decide failed", e);
            return null;
        }
    }
}

// Exported under the legacy name — services/index.js instantiates the
// singleton (`new VoiceService(env)`), same as before the call-manager
// refactor split the per-leg logic into models/agent_connection.js.
export { VoiceCallService as VoiceService };
