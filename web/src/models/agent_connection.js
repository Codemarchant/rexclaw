import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { ToolDispatcher } from "./tool_dispatcher";

// Tools xAI runs server-side. They appear as function_call events to the
// client but must NOT receive a function_call_output reply — see
// _handleFunctionCall for the rationale.
const XAI_SERVER_SIDE_TOOLS = new Set(["web_search", "x_search"]);

// Tools whose calls/results are visually noisy in the transcript but carry
// no information the user cares about (the avatar visibly performs the
// action). Still dispatched normally — we just skip the transcript entries.
const SILENT_BROWSER_TOOLS = new Set(["play_gesture", "set_emotion", "change_outfit"]);

// Pre-roll cushion (seconds) applied when (re)starting assistant playback —
// each turn's first chunk, and after any underrun. Absorbs network jitter so a
// late-arriving chunk still lands before its scheduled play time. Same spirit
// as LiveKit's WebRTC AudioSource queue_size_ms=200, kept lighter here since it
// adds to perceived response latency; continuous playback adds NO extra delay
// (chunks chain off the previous chunk's end time).
const PLAYBACK_JITTER_BUFFER_S = 0.12;

// ---- PCM helpers (shared with the call manager for mic capture) ----

export function floatToPcm16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
}

export function pcm16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }
    return out;
}

export function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * One live agent leg of a voice call: a single xAI Realtime WebSocket plus
 * everything scoped to it — assistant audio playback, lipsync channel, tool
 * dispatcher, transcript persistence queues, token accounting, compaction.
 *
 * Extracted from the old singleton VoiceService so a call can hold several
 * of these at once (multi-agent calls). The registry service is now the
 * call MANAGER (voice_service.js): it owns the shared microphone pipeline
 * and fans captured frames out to each connection via handleMicFrame(); it
 * also owns turn arbitration between connections. This class deliberately
 * knows nothing about other connections — cross-agent behaviour goes
 * through the small manager hook surface:
 *
 *   manager.prepareAudioForConnection(conn)   — audio graph prep before start
 *   manager.startMic()                        — kick shared mic acquisition
 *   manager.buildAvatarApi(conn)              — renderer routing (base/peer)
 *   manager.getGroupCallParams(conn)          — extra /start params
 *   manager.onAgentResponseStarted(conn)
 *   manager.onAgentFinalTranscript(conn, text)
 *   manager.onUserTranscript(conn, text)
 *   manager.onUserSpeechStarted(conn)
 *   manager.onConnectionEnded(conn)
 *
 * Roles:
 *   'primary' — the original call leg. Hears the mic (server VAD turns),
 *      drives the shared reactive state the UI binds to, owns the visible
 *      transcript and the base avatar.
 *   'peer' — an agent added to the call. Never hears the mic; runs with
 *      manual turn detection (turn_detection: null) so it only speaks when
 *      the manager sends response.create. Conversation context arrives as
 *      speaker-labelled text items relayed by the manager.
 *
 * Audio strategy: xAI Realtime sends PCM16. Each connection owns its own
 * playback AudioContext (created at the shared capture rate) so one leg's
 * compaction restart can rebuild its audio graph without disturbing the
 * other legs. Chunks are decoded to Float32 and scheduled gaplessly on the
 * context clock (the xAI cookbook's nextPlayTime model).
 */
export class AgentConnection {
    constructor(env, manager, { connId, role = "primary", state }) {
        this.env = env;
        this.manager = manager;
        this.connId = connId;
        this.role = role;
        this.state = state;
        this.agentName = null;
        // Whether shared mic frames are forwarded into this leg's
        // input_audio_buffer. Peers run "deaf" — they get the conversation
        // as relayed text — which is what prevents double-transcription and
        // double-response of every user utterance.
        this.hearsMic = role === "primary";

        this.ws = null;
        this.playbackContext = null;   // per-connection playback AudioContext
        this.assistantPlaybackNode = null;
        this.lipsyncChannel = null;
        this.avatarApi = null;
        // Assistant playback. Each xAI response.audio.delta is decoded to a
        // Float32Array and scheduled on the AudioContext clock at an explicit
        // start time (the xAI cookbook's nextPlayTime model). Once scheduled,
        // the audio thread plays chunks back-to-back regardless of main-thread
        // jank (3D avatar render, lip-sync, RPC) — eliminating the mid-speech
        // cutouts the older onended-chaining model suffered. _scheduledSources
        // holds every not-yet-finished BufferSource (pruned on `ended`) so
        // barge-in can stop them all; _nextPlayTime is the context time the
        // next chunk should start at.
        this._scheduledSources = [];
        this._nextPlayTime = 0;
        this.toolDispatcher = null;
        this.pendingFunctionCalls = new Map();   // call_id → { name, argsBuffer }
        this.lipsyncUnsub = null;
        this.replayInProgress = false;
        this._sampleRate = 24000;     // synced to the manager's capture rate at start
        this._assistantTranscriptInProgress = "";
        this._pendingAppendQueue = [];
        this._appendFlushTimer = null;
        // Patches deferred from conversation.item.added back-fill — flushed
        // separately from the main append queue. Keyed by call_id so repeat
        // events for the same call collapse into one row.
        this._pendingMetaPatches = new Map();
        this._metaFlushTimer = null;
        // Running session token totals, accumulated from each response.done's
        // usage block. Sent to the server on every /append and /end so the
        // token-based summary threshold can fire mid-session, and so the
        // session record reflects actual usage instead of staying at zero.
        this._runningTokens = { input: 0, output: 0 };
        // Mid-session compaction state — two phases so the user never hears
        // a long stall: (1) background /compact while the WS stays live,
        // (2) a fast WS restart once the rollup is ready and a natural pause
        // window opens. state.compacting only flips true for phase 2.
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        this._compacting = false;
        this.lastAgentId = null;
        this._sessionEnded = false;
        // Parallel-init audio buffer: mic frames produced before _onWsOpen
        // has sent session.update are pushed here and flushed in order once
        // the session is configured, so the user's first words aren't lost
        // if they speak before "Live". Capped at ~5s of audio.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
    }

    /** Lazily build this connection's playback AudioContext at the shared
     *  capture rate (so xAI's output PCM plays back without resampling).
     *  Per-connection contexts are what make per-leg compaction restarts
     *  safe: rebuilding one leg's audio graph can't disturb the others. */
    _ensurePlaybackContext() {
        if (!this.playbackContext || this.playbackContext.state === "closed") {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            const rate = this.manager?.sampleRate || this._sampleRate || 24000;
            try {
                this.playbackContext = new Ctor({ sampleRate: rate });
            } catch (e) {
                // Rate rejected by the device — let the browser pick;
                // createBuffer's explicit rate still resamples correctly.
                this.playbackContext = new Ctor();
            }
        }
        if (this.playbackContext.state === "suspended") {
            this.playbackContext.resume().catch(() => {});
        }
        return this.playbackContext;
    }

    /** Tear this connection's playback graph down to bare metal — stop all
     *  scheduled audio, disconnect the gain node, detach the lipsync channel,
     *  close the playback AudioContext. The full rebuild-per-session policy
     *  is inherited from the singleton era: stale audio state surviving
     *  across sessions was the root of the "speak does nothing after
     *  Connect" class of bug that only a page reload fixed. */
    async _teardownPlayback() {
        this._stopAssistantAudio();
        if (this.assistantPlaybackNode) {
            try { this.assistantPlaybackNode.disconnect(); } catch (e) { /* swallow */ }
            this.assistantPlaybackNode = null;
        }
        if (this.lipsyncUnsub) {
            try { this.lipsyncUnsub(); } catch (e) { /* swallow */ }
            this.lipsyncUnsub = null;
        }
        if (this.lipsyncChannel) {
            try { this.lipsyncChannel.detach(); } catch (e) { /* swallow */ }
        }
        this._panner = null;
        if (this.playbackContext && this.playbackContext.state !== "closed") {
            try { await this.playbackContext.close(); } catch (e) { /* swallow */ }
        }
        this.playbackContext = null;
        // Drop any audio queued for the next session — stale frames from a
        // dead WS shouldn't leak into the new one.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
    }

    async start(agentId = null, resumeSessionId = null, isCompactionRestart = false) {
        if (this.state.status !== "idle" && this.state.status !== "ended" && this.state.status !== "error") {
            // Already running. Surface a notification so the user understands
            // why nothing happened.
            this.env.services.notification?.add?.(
                _t("End the current voice session before starting a new one."),
                { type: "warning" }
            );
            return false;
        }
        // Reset the parallel-init audio buffer + readiness flag on every
        // start so the new WS's _onWsOpen owns a clean buffer-flush cycle.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
        // Always rebuild this leg's playback graph from scratch (see
        // _teardownPlayback for why), and let the manager rebuild the shared
        // mic pipeline when this is the mic-bearing leg. Compaction restarts
        // go through the same full teardown — reusing the capture worklet
        // after a restart put server VAD in a subtly bad state (committed
        // buffers transcribing only the first syllable repeatedly).
        await this._teardownPlayback();
        await this.manager.prepareAudioForConnection(this);
        this._sampleRate = this.manager.sampleRate || 24000;

        this.state.status = "connecting";
        this.state.errorMessage = null;
        // Never clear messages on compaction restart: the local transcript
        // already holds the full conversation history. The post-compaction
        // view is purely an xAI-context concern.
        if (!isCompactionRestart) {
            this.state.messages = [];
        }
        this._sessionEnded = false;
        this._dispatchedCallIds = new Set();
        this._recordedMcpCallIds = new Set();
        this._mcpCallArgs = new Map();
        this._bargedIn = false;
        this._currentResponseId = null;
        // Belt-and-braces: end()/_fail() may have exited with a response still
        // in flight. Clear it so the fresh session never thinks a turn from
        // the dead session is pending.
        this._responseInFlight = false;
        // Latched true while a turn owes a post-tool-call follow-up
        // response.create — see _maybeCreateToolReply.
        this._pendingToolReply = false;
        this._toolReplyStarting = false;
        this.pendingFunctionCalls.clear();
        // Fresh socket = fresh input item state on xAI's side — the
        // cumulative-transcript guard must not strip against stale text.
        this._lastUserTranscriptText = "";
        // Deferred relays from before a restart are already recovered via
        // the session-record replay — flushing them again would duplicate.
        this._deferredContextItems = [];
        this._runningTokens = { input: 0, output: 0 };
        // Re-arm the daily-cap soft-warning latch so the toast can fire
        // once per session (not once per browser session).
        this.state.tokenCapWarningShown = false;
        // Don't touch _compacting here — it's a per-restart lock owned by
        // _maybeRunCompaction's finally block. Pending flag is fine to clear.
        this._compactionPending = false;

        // Eagerly create the playback context so the first audio chunk has
        // a resumed context to schedule on (Connect click = user gesture).
        this._ensurePlaybackContext();

        let payload;
        try {
            payload = await rpc("/api/voice/session/start", {
                agent_id: agentId,
                resume_session_id: resumeSessionId,
                audio_sample_rate: this._sampleRate,
                ...this.manager.getGroupCallParams(this),
            });
        } catch (e) {
            // Pull the most informative message we can find. Odoo wraps UserError
            // in `data.message` for json-rpc; a network failure has plain `message`.
            const rawMsg = e?.data?.message
                || e?.data?.arguments?.[0]
                || e?.message
                || _t("Failed to start session");
            this._fail(rawMsg);
            return;
        }
        this.lastAgentId = agentId;

        this.state.sessionId = payload.session_id;
        this.state.agentId = payload.agent_id || agentId;
        this.state.agentName = payload.agent_name || null;
        this.agentName = payload.agent_name || null;
        this.state.avatar = payload.avatar;
        this.state.voice = payload.voice;
        this._sessionUpdate = payload.session_update;
        // Two parallel feeds from start_session:
        //   * replay_items     — compacted (filtered + rollup-hoisted),
        //     forwarded to xAI in _onWsOpen via conversation.item.create.
        //   * transcript_history — full chronological list, used only to
        //     paint the UI transcript on resume.
        this._replayItems = payload.replay_items || [];
        this._transcriptHistory = payload.transcript_history || [];
        if (!isCompactionRestart) {
            this.state.transcriptTruncated = !!payload.transcript_truncated;
        }
        // Seed the running token counter from any existing session totals
        // (non-zero only on resume) — the server's "max wins" persistence
        // rule expects full session totals.
        this._runningTokens = {
            input: payload.total_input_tokens || 0,
            output: payload.total_output_tokens || 0,
        };
        // Compact-budget display (see the original singleton for details).
        this._tokensAtLastSummary = payload.tokens_at_last_summary || 0;
        this.state.tokenLimit = payload.summary_threshold_tokens || 0;
        this.state.tokenUsage = Math.max(
            0,
            (this._runningTokens.input + this._runningTokens.output) - this._tokensAtLastSummary,
        );

        // When resuming, populate the local transcript from
        // transcript_history (the unfiltered chronological feed). xAI
        // separately gets the compacted replay_items in _onWsOpen.
        if (!isCompactionRestart) {
            for (const item of this._transcriptHistory) {
                if (item.type === "message") {
                    const text = (item.content || []).map((c) => c.text || "").join("").trim();
                    if (!text) continue;
                    this.state.messages.push({
                        role: item.role,
                        content: text,
                        // Group-call attribution persisted with the row — lets
                        // resumed transcripts keep labelling who said what.
                        speaker: item.speaker || null,
                        sequence: this.state.messages.length + 1,
                        replayed: true,
                        xai_item_id: item.id || null,
                        xai_previous_item_id: item.previous_item_id || null,
                    });
                } else if (item.type === "function_call") {
                    const args = item.arguments || "";
                    this.state.messages.push({
                        role: "tool_call",
                        content: `${item.name || "tool"}(${args})`,
                        tool_name: item.name,
                        tool_arguments_json: args,
                        sequence: this.state.messages.length + 1,
                        replayed: true,
                        xai_item_id: item.id || null,
                        xai_call_id: item.call_id || null,
                        xai_previous_item_id: item.previous_item_id || null,
                    });
                } else if (item.type === "function_call_output") {
                    this.state.messages.push({
                        role: "tool_result",
                        content: item.output || "",
                        tool_result_json: item.output || null,
                        sequence: this.state.messages.length + 1,
                        replayed: true,
                        xai_item_id: item.id || null,
                        xai_call_id: item.call_id || null,
                        xai_previous_item_id: item.previous_item_id || null,
                    });
                }
            }
        }

        // Avatar wiring is role-dependent: the primary leg configures the
        // base avatar + background exactly like the singleton did; peers
        // load a second VRM into the shared scene at an offset.
        this.avatarApi = this.manager.buildAvatarApi(this);
        this.manager.configureAvatarForConnection(this, payload);

        // Open WebSocket. xAI's docs say the ephemeral token goes in the WS
        // sub-protocol with the `xai-client-secret.` prefix. Be defensive
        // about whether the minted token already carries it.
        const url = `${payload.xai_realtime_url}?model=${encodeURIComponent(payload.xai_model)}`;
        const rawToken = payload.xai_ephemeral_token || "";
        const tokenForWs = rawToken.startsWith("xai-client-secret.")
            ? rawToken
            : `xai-client-secret.${rawToken}`;
        try {
            this.ws = new WebSocket(url, ["realtime", tokenForWs]);
        } catch (e) {
            this._fail(_t("Could not open WebSocket: ") + (e?.message || e));
            return;
        }
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = () => this._onWsOpen(payload);
        this.ws.onmessage = (ev) => this._onWsMessage(ev);
        this.ws.onerror = (ev) => {
            console.error(`[voice:${this.connId}] WS error`, ev);
        };
        this.ws.onclose = (ev) => this._onWsClose(ev);

        // Tool dispatcher — avatar tools route through avatarApi so each
        // agent's set_emotion/play_gesture/change_outfit lands on ITS model.
        this.toolDispatcher = new ToolDispatcher({
            actionService: this.env.services.action,
            avatarApi: this.avatarApi,
            sendWs: (msg) => this._sendWs(msg),
            conversationState: this.state,
            sessionId: this.state.sessionId,
            // Powers add_agent_to_call — peer legs get it too, so one
            // companion can pull a third into the conversation.
            callManager: this.manager,
        });

        // Kick mic acquisition off in parallel with the WS connecting (the
        // manager owns the shared pipeline; peers skip this — they're deaf).
        if (this.hearsMic) {
            this._micStartPromise = this.manager.startMic().catch((e) => {
                throw e;
            });
        } else {
            this._micStartPromise = null;
        }
        // Kick-off succeeded — async transition to "live" continues in _onWsOpen.
        return true;
    }

    async _onWsOpen() {
        // Safety net: end() may have run during the connect. Refuse to bring
        // the session up — without this, status gets clobbered back to
        // "live" after end() already settled on "ended".
        if (this._sessionEnded) {
            console.warn(`[voice:${this.connId}] _onWsOpen fired after session ended — ignoring`);
            return;
        }
        try {
            // xAI's /v1/realtime/client_secrets endpoint accepts only
            // `expires_after`, so the full session config is sent here from
            // the browser. The server pre-built it for us.
            if (this._sessionUpdate) {
                console.log(`[voice:${this.connId}] sending session.update`, this._sessionUpdate);
                this._sendWs(this._sessionUpdate);
            }

            // Replay history if resuming.
            if (this._replayItems && this._replayItems.length) {
                this.replayInProgress = true;
                this.state.replayMode = true;
                const lipsync = this.env.services.voice_lipsync;
                lipsync?.setReplayMode(true);
                for (const item of this._replayItems) {
                    // Strip private hint fields (leading underscore) before
                    // forwarding to xAI — they're for the JS display layer
                    // only and the realtime spec doesn't recognise them.
                    const { _summary_rollup, ...wireItem } = item;
                    void _summary_rollup;
                    this._sendWs({ type: "conversation.item.create", item: wireItem });
                }
                this.replayInProgress = false;
                this.state.replayMode = false;
                lipsync?.setReplayMode(false);
            }

            // Flush any audio captured during the parallel connect window.
            // Must come AFTER session.update + replay so xAI receives the
            // config first (xAI best-practices doc).
            this._flushEarlyAudioBuffer();

            // Block until the shared mic pipeline resolves (primary only —
            // mic denial resolves false and the session starts muted).
            if (this._micStartPromise) {
                await this._micStartPromise;
                this._micStartPromise = null;
            }

            this.state.status = "live";
            // Latched (never reset): lets the manager distinguish "a live
            // participant left" (worth announcing to the room) from "a join
            // attempt failed before anyone met them".
            this._everLive = true;
            console.log(`[voice:${this.connId}] session live`, this.state.muted ? "(muted)" : "");
        } catch (e) {
            console.error(`[voice:${this.connId}] _onWsOpen failed`, e);
            if (this.state.status === "connecting") {
                this._fail(e?.message || "Failed to enter live state");
            }
        }
    }

    /** One shared-mic frame (already PCM16+base64). Called by the manager's
     *  capture pipeline for every connection; each leg applies its own
     *  gating. Three states for the WS:
     *    1. _wsReady=false → buffer for later flush (capped ~5s).
     *    2. _wsReady=true, ws OPEN → send directly.
     *    3. _wsReady=true, ws not OPEN → drop.
     */
    handleMicFrame(base64) {
        if (!this.hearsMic) return;
        // state.compacting covers both the audio-drain wait and the brief
        // WS-restart window; without it the user talks into a void.
        if (this.state.muted || this.state.compacting) return;
        if (!this._wsReady) {
            if (this._earlyAudioBuffer.length < 60) {
                this._earlyAudioBuffer.push(base64);
            }
            return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this._sendWs({ type: "input_audio_buffer.append", audio: base64 });
    }

    _setupAssistantPlayback() {
        if (this.assistantPlaybackNode) return;
        const ctx = this._ensurePlaybackContext();
        this.assistantPlaybackNode = ctx.createGain();
        this.assistantPlaybackNode.gain.value = 1;
        this.assistantPlaybackNode.connect(ctx.destination);
        this._attachLipsyncToGain(this.assistantPlaybackNode);
    }

    _attachLipsyncToGain(gainNode) {
        const lipsync = this.env.services.voice_lipsync;
        if (!lipsync) return;
        if (!this.lipsyncChannel) {
            this.lipsyncChannel = lipsync.createChannel();
        }
        this.lipsyncChannel.attach(gainNode);

        // Wire vowel updates → state + this connection's avatar.
        if (this.lipsyncUnsub) this.lipsyncUnsub();
        this.lipsyncUnsub = this.lipsyncChannel.addListener((vowels, intensity) => {
            this.state.vowels = vowels;
            this.state.speakingIntensity = intensity;
            this.avatarApi?.setVowels?.(vowels);
            // Drive body/head gestures from speech intensity. Renderer smooths
            // (fast attack, slow release) so brief silences between words don't
            // collapse the gesture.
            this.avatarApi?.setSpeakingIntensity?.(intensity);
        });
    }

    /** Decode and schedule one assistant audio chunk for gapless playback.
     *  Each chunk is started at an explicit time on the AudioContext clock —
     *  the later of "now + jitter cushion" and the end of the previously
     *  scheduled chunk — so the audio thread plays them back-to-back even when
     *  the main thread is busy. */
    _enqueueAssistantAudio(int16ArrayBuffer) {
        const float32 = pcm16ToFloat32(new Int16Array(int16ArrayBuffer));
        const ctx = this._ensurePlaybackContext();
        this._setupAssistantPlayback();
        const audioBuffer = ctx.createBuffer(1, float32.length, this._sampleRate);
        audioBuffer.copyToChannel(float32, 0);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.assistantPlaybackNode);

        // Re-anchor to now (+ cushion) whenever the schedule has fallen behind
        // real time: a fresh turn, or an underrun where chunks stopped arriving
        // and playback caught up to _nextPlayTime.
        const now = ctx.currentTime;
        if (this._nextPlayTime < now) {
            this._nextPlayTime = now + PLAYBACK_JITTER_BUFFER_S;
        }
        const startAt = this._nextPlayTime;
        source.start(startAt);
        this._nextPlayTime = startAt + audioBuffer.duration;

        const entry = { source };
        this._scheduledSources.push(entry);
        source.onended = () => {
            const i = this._scheduledSources.indexOf(entry);
            if (i !== -1) this._scheduledSources.splice(i, 1);
            // Audio-tail retry for compaction: _maybeRunCompaction bails while
            // any audio is still scheduled so the last spoken line isn't cut
            // off mid-word. Once everything has drained, re-poke it.
            if (this._scheduledSources.length === 0 && this._compactionPending && !this._compacting) {
                this._maybeRunCompaction();
            }
        };
    }

    /** True while assistant audio is still scheduled or playing out. */
    _assistantAudioActive() {
        if (this._scheduledSources.length > 0) return true;
        const ctx = this.playbackContext;
        return !!ctx && this._nextPlayTime > ctx.currentTime;
    }

    /** Stop all scheduled/playing assistant audio and reset the schedule. Used
     *  for barge-in when the user starts talking while the assistant replies. */
    _stopAssistantAudio() {
        for (const { source } of this._scheduledSources) {
            try { source.stop(); } catch (e) { /* already stopped */ }
            try { source.disconnect(); } catch (e) { /* swallow */ }
        }
        this._scheduledSources = [];
        // Next chunk re-anchors to now (it's < currentTime after this).
        this._nextPlayTime = 0;
    }

    _onWsMessage(ev) {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch (e) {
            return;
        }
        // Lightweight inbound trace — only for non-noisy event types so the
        // console isn't drowned by audio.delta.
        if (!msg.type?.endsWith(".delta")) {
            console.log(`[voice:${this.connId}] ←`, msg.type, msg);
        }
        // Keepalive: xAI sends `ping` events; we echo back `pong` with every
        // correlation field we recognise (the payload schema has shifted
        // between revisions).
        if (msg.type === "ping") {
            const reply = { type: "pong" };
            if (msg.ping_timestamp != null) reply.ping_timestamp = msg.ping_timestamp;
            if (msg.timestamp != null) reply.timestamp = msg.timestamp;
            if (msg.event_id != null) reply.event_id = msg.event_id;
            this._sendWs(reply);
            return;
        }

        // Audio out — xAI uses `response.output_audio.delta`; older API
        // revisions used `audio`.
        if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
            // After barge-in / cancel, xAI may still stream chunks that were
            // in flight — drop them so the interrupt doesn't look broken.
            if (this._bargedIn) return;
            // Drop deltas from a stale response (cancelled or superseded).
            if (msg.response_id && this._currentResponseId &&
                msg.response_id !== this._currentResponseId) return;
            this.state.thinking = false;  // first audio chunk = model is talking
            const audioB64 = msg.delta || msg.audio;
            if (audioB64) {
                const buffer = base64ToArrayBuffer(audioB64);
                this._enqueueAssistantAudio(buffer);
            }
            return;
        }
        // Assistant transcript deltas.
        if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.text.delta") {
            // Same staleness guard as audio: a cancelled response can still
            // emit transcript deltas.
            if (msg.response_id && this._currentResponseId &&
                msg.response_id !== this._currentResponseId) return;
            this.state.thinking = false;
            if (msg.delta) this._assistantTranscriptInProgress += msg.delta;
            return;
        }
        // Assistant transcript final — `done` events carry the full transcript
        // in a `transcript` field, preferred over accumulated deltas.
        if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.text.done") {
            if (msg.response_id && this._currentResponseId &&
                msg.response_id !== this._currentResponseId) {
                // A skipped final means this line is never relayed to other
                // call legs — if an agent seems unaware of something that was
                // audibly said, this warning is the smoking gun.
                console.warn(`[voice:${this.connId}] transcript.done SKIPPED (stale response_id `
                    + `${msg.response_id} != ${this._currentResponseId}): `
                    + `"${(msg.transcript || "").slice(0, 80)}"`);
                return;
            }
            const finalText = msg.transcript || this._assistantTranscriptInProgress;
            if (finalText) {
                this._appendMessage({ role: "assistant", content: finalText });
                // Manager hook: relay to other call legs + run the turn
                // director (agent-to-agent flow). No-op in a solo call.
                try { this.manager.onAgentFinalTranscript(this, finalText); } catch (e) {
                    console.error(`[voice:${this.connId}] onAgentFinalTranscript failed`, e);
                }
            }
            this._assistantTranscriptInProgress = "";
            return;
        }
        if (msg.type === "response.output_audio.done" || msg.type === "response.audio.done") {
            return;
        }
        if (msg.type === "response.done" || msg.type === "response.completed") {
            const status = msg.response?.status;
            const respId = msg.response?.id;
            // xAI ships the populated usage object at the OUTER event level;
            // response.usage arrives empty. Read inner first for
            // OpenAI-compatibility, fall back to outer.
            const innerUsage = msg.response?.usage;
            const usage = innerUsage && Object.keys(innerUsage).length
                ? innerUsage
                : msg.usage;
            console.log(
                `[voice:${this.connId}] response`, respId, "done:", status,
                usage
                    ? `(in: ${usage.input_tokens ?? "?"}, out: ${usage.output_tokens ?? "?"}, total: ${usage.total_tokens ?? "?"})`
                    : ""
            );
            // Accumulate token usage into the session-running counter.
            // Cancelled responses still report partial usage — count it.
            if (usage) {
                this._runningTokens.input += usage.input_tokens || 0;
                this._runningTokens.output += usage.output_tokens || 0;
                this.state.tokenUsage = Math.max(
                    0,
                    (this._runningTokens.input + this._runningTokens.output) - (this._tokensAtLastSummary || 0),
                );
            }
            // Cancelled responses (e.g. our barge-in cancel) shouldn't reset
            // _responseInFlight here — the speech_started handler already
            // cleared it and the user may be mid-way through a new turn.
            if (status !== "cancelled") {
                this._responseInFlight = false;
                this.state.thinking = false;
                // Gate for the post-tool follow-up reply — see
                // _maybeCreateToolReply.
                this._maybeCreateToolReply();
            } else {
                // Cancelled (barge-in / abort): abandon any owed tool reply.
                this._pendingToolReply = false;
            }
            // If a /append earlier flagged needs_compaction during this
            // response, restart now that the model is idle.
            this._maybeRunCompaction();
            return;
        }
        // session.updated acks our session.update — sanity-check that the
        // voice and tool TYPES round-tripped.
        if (msg.type === "session.updated") {
            const sess = msg.session || {};
            const expected = this._sessionUpdate?.session || {};
            const mismatches = [];
            if (sess.voice && expected.voice
                && String(sess.voice).toLowerCase() !== String(expected.voice).toLowerCase()) {
                mismatches.push(`voice: sent ${expected.voice}, got ${sess.voice}`);
            }
            const sentToolTypes = (expected.tools || []).map((t) => t.type).sort();
            const gotToolTypes = (sess.tools || []).map((t) => t.type).sort();
            if (JSON.stringify(sentToolTypes) !== JSON.stringify(gotToolTypes)) {
                mismatches.push(
                    `tools: sent [${sentToolTypes.join(",")}], got [${gotToolTypes.join(",")}]`
                );
            }
            if (mismatches.length) {
                console.warn(`[voice:${this.connId}] session.updated mismatch:`, mismatches.join("; "));
            } else {
                console.log(`[voice:${this.connId}] session.updated — accepted as sent`);
            }
            return;
        }
        // conversation.item.added — back-fill xai ids on tool rows recorded
        // at the source event; also the cleanest signal that a server-side
        // MCP call completed end-to-end.
        if (msg.type === "conversation.item.added") {
            const item = msg.item || {};
            if (item.type === "function_call_output") {
                console.log(
                    `[voice:${this.connId}] xAI delivered function_call_output for call_id`,
                    item.call_id,
                    "(server-side tool call resolved)"
                );
            }
            const callId = item.call_id;
            if (callId && (item.id || msg.previous_item_id)) {
                this._enqueueMetaPatch({
                    call_id: callId,
                    xai_item_id: item.id || null,
                    xai_previous_item_id: msg.previous_item_id || null,
                });
                for (const m of this.state.messages) {
                    if (m.xai_call_id === callId) {
                        if (item.id && !m.xai_item_id) m.xai_item_id = item.id;
                        if (msg.previous_item_id && !m.xai_previous_item_id) {
                            m.xai_previous_item_id = msg.previous_item_id;
                        }
                    }
                }
            }
            return;
        }
        // For audio turns, xAI auto-creates the response when server_vad
        // detects end-of-speech, so this is where _responseInFlight first
        // flips true. (Typed/text turns and post-tool flow set the flag in
        // _maybeCreateResponse before sending response.create ourselves.)
        if (msg.type === "response.created") {
            this._responseInFlight = true;
            this._currentResponseId = msg.response?.id || null;
            console.log(`[voice:${this.connId}] response started:`, this._currentResponseId);
            // call_id is RESPONSE-scoped per the spec — clear the dedupe sets
            // so turn 2's call_id "0" isn't suppressed by turn 1's.
            this._recordedMcpCallIds?.clear();
            this._mcpCallArgs?.clear();
            this._dispatchedCallIds?.clear();
            this.pendingFunctionCalls?.clear();
            // Fresh turn — clear any tool-reply debt. (If this response
            // itself emits tool calls, _handleFunctionCall re-arms the flag.)
            this._pendingToolReply = false;
            // A new response is starting — end any post-barge-in suppression.
            this._bargedIn = false;
            // Manager hook: single-speaker arbitration across call legs.
            try { this.manager.onAgentResponseStarted(this); } catch (e) { /* non-fatal */ }
            return;
        }
        // User transcript — record into the local transcript only. With
        // server_vad active, xAI auto-creates the response itself.
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
            let text = msg.transcript || "";
            if (text) {
                text = this._extractNewUserSpeech(text);
            }
            if (text) {
                this._appendMessage({ role: "user", content: text });
                // Manager hook: turn routing + relay to peer legs.
                try { this.manager.onUserTranscript(this, text); } catch (e) {
                    console.error(`[voice:${this.connId}] onUserTranscript failed`, e);
                }
            }
            return;
        }
        // Barge-in: user started speaking while the assistant was talking.
        // In server-VAD mode xAI handles the cancel itself; we stop local
        // playback and mark _bargedIn so straggling chunks are discarded.
        if (msg.type === "input_audio_buffer.speech_started") {
            // User interrupted: abandon any owed tool reply.
            this._pendingToolReply = false;
            const audioStillPlaying = this._assistantAudioActive();
            if (this._responseInFlight || audioStillPlaying) {
                console.log(
                    `[voice:${this.connId}] → barge-in`,
                    this._responseInFlight
                        ? `(response ${this._currentResponseId} in flight, server-VAD will cancel)`
                        : "(audio tail)"
                );
                this._stopAssistantAudio();
                this.avatarApi?.setSpeakingIntensity?.(0);
                this._responseInFlight = false;
                this._currentResponseId = null;
                this._assistantTranscriptInProgress = "";
                // Suppress any audio chunks still arriving for the cancelled
                // response. Cleared when a new response starts.
                this._bargedIn = true;
            }
            // Manager hook: the user has the floor — silence every other
            // call leg too (their audio isn't covered by this leg's stop).
            try { this.manager.onUserSpeechStarted(this); } catch (e) { /* non-fatal */ }
            return;
        }
        // With server_vad, xAI auto-creates the response on speech_stopped.
        // Deliberately do NOT call _maybeCreateResponse here.
        if (msg.type === "input_audio_buffer.speech_stopped" ||
            msg.type === "input_audio_buffer.committed") {
            return;
        }
        // Function call discovery: the function `name` rides on
        // response.output_item.{added,done} (inside `item`), NOT on the
        // function_call_arguments.* events.
        if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
            this.pendingFunctionCalls.set(msg.item.call_id, {
                name: msg.item.name,
                argsBuffer: msg.item.arguments || "",
                itemId: msg.item.id,
                previousItemId: msg.previous_item_id || null,
            });
            return;
        }
        // Args streaming — append by call_id, the buffer was seeded above.
        if (msg.type === "response.function_call_arguments.delta") {
            const buf = this.pendingFunctionCalls.get(msg.call_id);
            if (buf) buf.argsBuffer += msg.delta || "";
            return;
        }
        // Final args event — dispatch via the name captured at output_item.added.
        if (msg.type === "response.function_call_arguments.done") {
            const buf = this.pendingFunctionCalls.get(msg.call_id) || {};
            const name = buf.name;
            const args = msg.arguments || buf.argsBuffer || "";
            const itemId = buf.itemId || msg.item_id || null;
            const previousItemId = buf.previousItemId || null;
            this.pendingFunctionCalls.delete(msg.call_id);
            if (this._dispatchedCallIds?.has(msg.call_id)) return;  // already done via output_item.done
            this._handleFunctionCall(msg.call_id, name, args, { itemId, previousItemId });
            return;
        }
        // Fallback: response.output_item.done with type=function_call carries
        // the complete payload in one shot.
        if (msg.type === "response.output_item.done" && msg.item?.type === "function_call") {
            const item = msg.item;
            if (this._dispatchedCallIds?.has(item.call_id)) return;
            this._handleFunctionCall(item.call_id, item.name, item.arguments || "", {
                itemId: item.id || null,
                previousItemId: msg.previous_item_id || null,
            });
            return;
        }
        // MCP tool calls (server-side, fulfilled by xAI itself) — recorded
        // in the transcript, never dispatched.
        if (msg.type === "response.mcp_call_arguments.delta") {
            if (!this._mcpCallArgs) this._mcpCallArgs = new Map();
            const prev = this._mcpCallArgs.get(msg.call_id) || "";
            this._mcpCallArgs.set(msg.call_id, prev + (msg.delta || ""));
            return;
        }
        if (msg.type === "response.mcp_call_arguments.done") {
            if (!this._mcpCallArgs) this._mcpCallArgs = new Map();
            // .done carries the FULL args; prefer it over accumulated deltas.
            this._mcpCallArgs.set(msg.call_id, msg.arguments || this._mcpCallArgs.get(msg.call_id) || "");
            return;
        }
        if (msg.type === "response.mcp_call.in_progress") {
            if (!this._recordedMcpCallIds) this._recordedMcpCallIds = new Set();
            if (this._recordedMcpCallIds.has(msg.call_id)) return;
            this._recordedMcpCallIds.add(msg.call_id);
            this.state.thinking = true;  // xAI is fetching server-side; keep the dots up
            const argsJson = this._mcpCallArgs?.get(msg.call_id) || "";
            this._appendMessage({
                role: "tool_call",
                content: argsJson ? `${msg.name || "mcp"}(${argsJson})` : `${msg.name || "mcp"}(…)`,
                tool_name: msg.name,
                tool_arguments_json: argsJson,
                xai_item_id: msg.item_id || null,
                xai_call_id: msg.call_id,
                xai_previous_item_id: null,
            });
            return;
        }
        if (msg.type === "response.mcp_call.completed" || msg.type === "response.mcp_call.failed") {
            const failed = msg.type === "response.mcp_call.failed";
            let content;
            if (failed) {
                const errType = msg.error?.type || "failed";
                const errMsg = msg.error?.message || "";
                content = errMsg ? `${errType}: ${errMsg}` : errType;
            } else {
                const out = msg.output;
                if (out == null || out === "") {
                    content = "ok";
                } else {
                    content = typeof out === "string" ? out : JSON.stringify(out);
                }
            }
            this._appendMessage({
                role: "tool_result",
                content,
                tool_name: msg.name,
                tool_result_json: content,
                xai_item_id: msg.item_id || null,
                xai_call_id: msg.call_id,
                xai_previous_item_id: null,
            });
            this._mcpCallArgs?.delete(msg.call_id);
            return;
        }
        // MCP tool discovery failure — the model runs without ANY of our
        // Odoo tools; surface it loudly.
        if (msg.type === "mcp_list_tools.failed") {
            console.error(`[voice:${this.connId}] MCP tool discovery failed:`, msg);
            const label = msg.server_label || _t("the MCP server");
            const errMsg = msg.error?.message || msg.error || msg.message || _t("unknown error");
            this.env.services.notification?.add?.(
                _t("Couldn't load tools from %s — %s. The agent won't be able to query your data this session.", label, errMsg),
                { type: "danger", sticky: true }
            );
            return;
        }
        // Errors — surface to the UI in addition to the console.
        if (msg.type === "error") {
            const err = msg.error || {};
            const errType = err.type || "";
            const errCode = err.code || errType;
            const errMsg = err.message || msg.message || "xAI error";
            const causedByClientEventId = err.event_id;
            // Failed response.cancel races are benign: by the time our
            // cancel reached xAI the response had already completed or been
            // replaced by a newer one. Local playback/flags were already
            // reset when the cancel was sent — nothing to recover, nothing
            // the user needs to see.
            if (/cancell?ation failed/i.test(errMsg)
                || /no active response/i.test(errMsg)
                || /does not match current response/i.test(errMsg)) {
                console.log(`[voice:${this.connId}] benign cancel race:`, errMsg);
                return;
            }
            // Inactivity / stream-idle timeout — recoverable: reset in-flight
            // flags so the user can speak again.
            if (errType === "timeout"
                || /idle.?timeout/i.test(errMsg) || /idle.?timeout/i.test(errCode)) {
                console.warn(`[voice:${this.connId}] xAI idle timeout — recovering`);
                this._responseInFlight = false;
                this.state.thinking = false;
                this._assistantTranscriptInProgress = "";
                this.env.services.notification?.add?.(
                    _t("The agent stalled mid-reply. Try rephrasing your request."),
                    { type: "warning" }
                );
                return;
            }
            console.error(`[voice:${this.connId}] xAI error`, {
                type: errType,
                code: errCode,
                message: errMsg,
                param: err.param,
                causedByClientEventId,
                full: msg,
            });
            // max_duration is the one terminal error type — the server is
            // closing the socket; let _onWsClose settle teardown.
            if (errType === "max_duration") {
                this.state.thinking = false;
                this.env.services.notification?.add?.(
                    _t("This conversation reached its maximum length and is ending."),
                    { type: "info" }
                );
                return;
            }
            // A realtime `error` event is per-event, not session-ending —
            // recover in place when we're live with an open socket.
            const wsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
            if (this.state.status === "live" && wsOpen) {
                console.warn(`[voice:${this.connId}] non-fatal xAI error during live session — staying live`);
                this._responseInFlight = false;
                this.state.thinking = false;
                this._assistantTranscriptInProgress = "";
                const detail = err.param ? ` (${err.param})` : "";
                this.env.services.notification?.add?.(
                    _t("The agent hit a problem: %s%s", errMsg, detail),
                    { type: "warning" }
                );
                return;
            }
            const detailParts = [];
            if (err.param) detailParts.push(`param: ${err.param}`);
            if (causedByClientEventId) detailParts.push(`event: ${causedByClientEventId}`);
            this.state.errorMessage = detailParts.length
                ? `${errMsg} (${detailParts.join(", ")})`
                : errMsg;
            this.state.status = "error";
            this.state.thinking = false;
        }
    }

    /** Drain any audio captured during the parallel connect window into
     *  the now-configured WS. Called from _onWsOpen AFTER session.update
     *  and replay items have been sent. */
    _flushEarlyAudioBuffer() {
        const buffered = this._earlyAudioBuffer;
        this._earlyAudioBuffer = [];
        this._wsReady = true;
        if (buffered.length > 0) {
            console.log(`[voice:${this.connId}] flushing`, buffered.length, "buffered audio frames");
            for (const base64 of buffered) {
                this._sendWs({ type: "input_audio_buffer.append", audio: base64 });
            }
        }
    }

    _onWsClose(ev) {
        if (this._sessionEnded) return;  // we initiated the close
        // Don't recursively call end() — its async teardown races concurrent
        // state transitions. Full cleanup happens on the user's End click or
        // implicitly on the next start().
        this._sessionEnded = true;
        this.state.thinking = false;
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        const code = ev?.code;
        const reason = ev?.reason;
        const wasClean = ev?.wasClean;
        console.warn(`[voice:${this.connId}] WS closed unexpectedly`, { code, reason, wasClean });
        if (wasClean) {
            this.state.status = "ended";
        } else {
            this.state.status = "error";
            this.state.errorMessage = reason
                ? _t("Voice connection closed (%s): %s", code ?? "?", reason)
                : _t("Voice connection closed (%s)", code ?? _t("unknown"));
        }
        this.state.tokenUsage = 0;
        // Best-effort flush of pending transcript appends. Fire-and-forget.
        this._flushAppendQueue?.().catch(() => {});
        this._flushMetaQueue?.().catch(() => {});
        try { this.manager.onConnectionEnded(this); } catch (e) { /* non-fatal */ }
    }

    _sendWs(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }

    /** Trigger model response generation, idempotent per user turn. */
    /** Queue a context line to be delivered right before this leg's next
     *  response instead of immediately. Needed for legs with live audio
     *  input: xAI's realtime API loses text items injected BEFORE an audio
     *  turn — responses generated after the audio item can't see them (the
     *  model literally answers "I must have missed it"). Items created
     *  AFTER the audio item are seen fine, so peer-speech relays for the
     *  primary are parked here and flushed at grant time. */
    queueDeferredContext(text) {
        text = (text || "").trim();
        if (!text) return;
        this._deferredContextItems = this._deferredContextItems || [];
        this._deferredContextItems.push(text);
        if (this._deferredContextItems.length > 30) this._deferredContextItems.shift();
    }

    _maybeCreateResponse() {
        if (this._responseInFlight) return;
        // Deliver deferred context now — after any audio item from the turn
        // that triggered this grant, where the model can actually see it.
        if (this._deferredContextItems?.length
            && this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log(`[voice:${this.connId}] flushing ${this._deferredContextItems.length} deferred context item(s) pre-response`);
            for (const text of this._deferredContextItems) {
                this._sendWs({
                    type: "conversation.item.create",
                    item: { type: "message", role: "user",
                            content: [{ type: "input_text", text }] },
                });
            }
            this._deferredContextItems = [];
        }
        this._responseInFlight = true;
        this.state.thinking = true;  // gap until the next audio/transcript chunk arrives
        console.log(`[voice:${this.connId}] → response.create`);
        this._sendWs({ type: "response.create", response: { modalities: ["text", "audio"] } });
    }

    /** Public wrapper for the turn director: ask this agent to take the
     *  floor and generate a spoken reply from its current context. */
    requestResponse() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        if (this.state.compacting) return false;
        this._maybeCreateResponse();
        return true;
    }

    /** Cancel the response currently being generated/played (if any) and
     *  suppress its remaining audio/transcript deltas. Used by the manager
     *  when routing a turn to a different agent, and by sendText. */
    cancelActiveResponse(reason = "cancel") {
        const hadResponse = this._responseInFlight;
        const audioActive = this._assistantAudioActive();
        if (!hadResponse && !audioActive) return;
        if (hadResponse) {
            // Deliberately NO response_id: passing one raced xAI's own
            // response lifecycle — by the time the cancel landed the id was
            // often stale ("Response ID … does not match current response").
            // A bare cancel kills whatever is currently in progress, which
            // is exactly the intent here: this leg stops talking now.
            console.log(`[voice:${this.connId}] → response.cancel (${reason})`, this._currentResponseId);
            this._sendWs({ type: "response.cancel" });
        }
        this._stopAssistantAudio();
        this.avatarApi?.setSpeakingIntensity?.(0);
        this._responseInFlight = false;
        this._currentResponseId = null;
        this._assistantTranscriptInProgress = "";
        this._pendingToolReply = false;
        this.state.thinking = false;
        // Suppress stragglers until the next response.created.
        this._bargedIn = true;
    }

    /** Send the post-tool-call follow-up response — but only once BOTH
     *  preconditions hold: (1) the originating response fully completed,
     *  and (2) every tool's function_call_output has been submitted.
     *  See the original singleton for the full rationale (mirrors LiveKit's
     *  and Pipecat's one-reply-per-tool-round gating). */
    async _maybeCreateToolReply() {
        if (!this._pendingToolReply) return;
        if (this._responseInFlight) return;             // originating response still streaming
        if (this.toolDispatcher?.hasPending()) return;  // tool outputs still in flight
        this._pendingToolReply = false;                 // claim it (idempotent vs. the racing caller)
        // Bridge flag: from the claim until response.create fires (or we
        // bail), this leg still "owes speech". Without it there's a silent
        // window — pendingToolReply already false, responseInFlight not yet
        // true, audio drained — where the manager's _waitForPlayoutEnd sees
        // an idle leg and grants another agent the floor (e.g. a freshly
        // joined companion's greeting), only for this post-tool reply to
        // land right on top of it.
        this._toolReplyStarting = true;
        try {
            // Let the announcement audio ("one sec, let me check…") finish
            // before the answer so the two audio streams don't overlap.
            await this._waitForAudioPlayback();
            if (this._bargedIn || this._sessionEnded) {
                return;
            }
            console.log(`[voice:${this.connId}] → response.create (post-tool)`);
            // Sets _responseInFlight synchronously, so the owes-speech state
            // stays continuous when the finally clears the bridge flag.
            this._maybeCreateResponse();
        } finally {
            this._toolReplyStarting = false;
        }
    }

    /** Dispatch a single function call to the browser tool dispatcher and
     *  echo tool_call / tool_result messages into the transcript.
     *
     *  Server-side xAI tools (web_search, x_search) are surfaced as
     *  function_call events even though xAI fulfils them itself — we must
     *  NOT send a function_call_output for those. */
    _handleFunctionCall(callId, name, argumentsJson, ids = {}) {
        if (!callId || !name) {
            console.warn(`[voice:${this.connId}] dropping malformed function call`, { callId, name, argumentsJson });
            return;
        }
        if (!this._dispatchedCallIds) this._dispatchedCallIds = new Set();
        this._dispatchedCallIds.add(callId);
        this.state.thinking = true;  // hide the freeze gap during execute + audio drain
        if (!SILENT_BROWSER_TOOLS.has(name)) {
            this._appendMessage({
                role: "tool_call",
                content: `${name}(${argumentsJson})`,
                tool_name: name,
                tool_arguments_json: argumentsJson,
                xai_item_id: ids.itemId || null,
                xai_call_id: callId,
                xai_previous_item_id: ids.previousItemId || null,
            });
        }
        if (XAI_SERVER_SIDE_TOOLS.has(name)) {
            // xAI runs the search itself and feeds the result back into its
            // own response stream.
            return;
        }
        // This turn now owes a follow-up response.create once the tool
        // round-trip completes.
        this._pendingToolReply = true;
        this.toolDispatcher
            ?.dispatch({ callId, name, argumentsJson })
            .then((result) => {
                try {
                    console.log(`[voice:${this.connId}] tool result`, name, "→", result);
                    if (!SILENT_BROWSER_TOOLS.has(name)) {
                        this._appendMessage({
                            role: "tool_result",
                            content: JSON.stringify(result),
                            tool_name: name,
                            tool_result_json: JSON.stringify(result),
                            xai_call_id: callId,
                        });
                    }
                } catch (e) {
                    console.error(`[voice:${this.connId}] post-dispatch handling failed for`, name, e);
                }
                this._maybeCreateToolReply();
            })
            .catch((e) => {
                console.error(`[voice:${this.connId}] dispatch promise rejected for`, name, e);
                this._maybeCreateToolReply();
            });
    }

    /** Resolve once the assistant's queued audio has finished playing (or
     *  after at most 10s as a safety net against a stalled chunk). */
    _waitForAudioPlayback() {
        return new Promise((resolve) => {
            const deadline = Date.now() + 10000;
            const check = () => {
                if (!this._assistantAudioActive()) {
                    resolve();
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve();
                    return;
                }
                setTimeout(check, 100);
            };
            check();
        });
    }

    /** Cumulative-transcript guard. After a response.cancel (turn routed to
     *  another agent, typed-input interrupt), xAI has been observed to keep
     *  the user's input item open and re-emit `completed` on a later
     *  utterance with ALL prior speech prefixed — sometimes spanning several
     *  earlier turns. Without stripping, the visible transcript snowballs,
     *  duplicate rows persist (and replay on resume), and turn routing keeps
     *  matching the FIRST name ever addressed instead of the new speech.
     *
     *  The re-transcription is NOT stable across emissions — wording,
     *  spelling and punctuation drift ("favorite" → "favourite",
     *  "Rex's." → "Rex's coat") — so an exact prefix compare alone misses.
     *  Two layers:
     *    1. Exact: duplicate-of / prefix-of the previous raw emission
     *       (cheap, catches the common single-turn case).
     *    2. Fuzzy: word-align the new transcript against the concatenation
     *       of recent user rows from THIS socket (replayed history can't
     *       re-emit) and strip every fully-matched row — ≥80% per-row word
     *       overlap counts as a match. Only engaged when at least
     *       MIN_STRIP_WORDS words match, so a user genuinely repeating a
     *       short phrase ("yes", "do it") is never swallowed.
     *
     *  Returns the genuinely-new speech, or "" if the whole emission is a
     *  replay of known speech. */
    _extractNewUserSpeech(transcript) {
        const prev = this._lastUserTranscriptText;
        this._lastUserTranscriptText = transcript;
        if (prev) {
            if (transcript === prev) return "";  // pure duplicate re-emission
            if (transcript.length > prev.length && transcript.startsWith(prev)) {
                return transcript.slice(prev.length).trim();
            }
        }
        const MIN_STRIP_WORDS = 4;
        const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
        const rawWords = transcript.split(/\s+/).filter(Boolean);
        // Normalized words plus a map back to their raw index, so the strip
        // point survives punctuation-only tokens being dropped.
        const newNorm = [];
        const newRawIdx = [];
        rawWords.forEach((w, idx) => {
            const n = normWord(w);
            if (n) {
                newNorm.push(n);
                newRawIdx.push(idx);
            }
        });
        if (newNorm.length < MIN_STRIP_WORDS) return transcript;
        const rows = this.state.messages
            .filter((m) => m.role === "user" && !m.replayed && m.content)
            .slice(-8)
            .map((m) => m.content.split(/\s+/).map(normWord).filter(Boolean))
            .filter((r) => r.length);
        // Word equality must tolerate the re-transcription's spelling drift
        // ("favourite" ↔ "favorite", "colour" ↔ "color") — with short
        // utterances two drifted words already sink the 80% row threshold.
        // Edit distance ≤1 (≤2 for 8+ letter words) counts as the same word.
        const editDistanceAtMost = (a, b, max) => {
            if (Math.abs(a.length - b.length) > max) return false;
            const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
            for (let j = 1; j <= b.length; j++) {
                let prevDiag = dp[0];
                dp[0] = j;
                for (let i = 1; i <= a.length; i++) {
                    const tmp = dp[i];
                    dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1,
                                     prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1));
                    prevDiag = tmp;
                }
            }
            return dp[a.length] <= max;
        };
        const wordsMatch = (a, b) => a === b ||
            (a.length >= 4 && b.length >= 4 &&
             editDistanceAtMost(a, b, (a.length >= 8 || b.length >= 8) ? 2 : 1));
        // The re-emission starts at some earlier utterance boundary — try
        // each starting row, greedily consume consecutive matching rows,
        // and keep the alignment that explains the most leading words.
        let best = 0;
        for (let i = 0; i < rows.length; i++) {
            let pos = 0;
            for (let j = i; j < rows.length; j++) {
                const row = rows[j];
                if (pos + row.length > newNorm.length) break;
                let hits = 0;
                for (let k = 0; k < row.length; k++) {
                    if (wordsMatch(newNorm[pos + k], row[k])) hits++;
                }
                if (hits / row.length < 0.8) break;
                pos += row.length;
            }
            if (pos > best) best = pos;
        }
        if (best < MIN_STRIP_WORDS) return transcript;
        if (best >= newNorm.length) {
            console.warn(`[voice:${this.connId}] dropped fully re-emitted user transcript (${best} words)`);
            return "";
        }
        console.warn(`[voice:${this.connId}] stripped ${best} re-emitted words from user transcript`);
        return rawWords.slice(newRawIdx[best]).join(" ").trim();
    }

    _appendMessage(msg) {
        // In a group call, stamp assistant rows with this agent's name so the
        // transcript can label who said what (solo calls skip the label).
        if (msg.role === "assistant" && this.agentName && this.manager?.hasPeers?.()) {
            msg = { ...msg, speaker: this.agentName };
        }
        // Peer tool activity is otherwise invisible in the call transcript:
        // peer rows persist to the PEER's own session, and the manager only
        // mirrors speech. Display-mirror tool_call/tool_result rows into the
        // shared transcript too, so a peer's remember/recall/imagine shows
        // up exactly like the primary's.
        if (this.role === "peer" && this.manager?.state
            && (msg.role === "tool_call" || msg.role === "tool_result")) {
            this.manager.state.messages.push({
                ...msg,
                speaker: this.agentName || undefined,
                sequence: this.manager.state.messages.length + 1,
                mirrored: true,
            });
        }
        this.state.messages.push({
            ...msg,
            sequence: this.state.messages.length + 1,
        });
        this._pendingAppendQueue.push(msg);
        if (!this._appendFlushTimer) {
            this._appendFlushTimer = setTimeout(() => this._flushAppendQueue(), 1500);
        }
    }

    /** Persist a conversation row to this leg's session record WITHOUT
     *  touching the visible transcript or the live xAI context. The manager
     *  uses this to mirror the OTHER participants' turns (and call-management
     *  notes) into every leg's session, so each agent's stored history holds
     *  the FULL group conversation, not just its own lines. Rows ride the
     *  same debounced /append queue as _appendMessage, so ordering against
     *  the leg's own rows is preserved and compaction replay picks them up
     *  from the DB naturally. */
    recordMessage(msg) {
        if (!this.state.sessionId || this._sessionEnded) return;
        this._pendingAppendQueue.push(msg);
        if (!this._appendFlushTimer) {
            this._appendFlushTimer = setTimeout(() => this._flushAppendQueue(), 1500);
        }
    }

    async _flushAppendQueue() {
        this._appendFlushTimer = null;
        if (!this.state.sessionId || !this._pendingAppendQueue.length) return;
        const messages = this._pendingAppendQueue.splice(0);
        try {
            const resp = await rpc(`/api/voice/session/${this.state.sessionId}/append`, {
                messages,
                // Running session totals (cumulative, not deltas). Server
                // takes the max so retries are idempotent.
                total_input_tokens: this._runningTokens.input,
                total_output_tokens: this._runningTokens.output,
            });
            // Server flagged the session for mid-session compaction.
            if (resp && resp.needs_compaction) {
                this._compactionPending = true;
                // Front-load the summary generation in the background while
                // the conversation keeps flowing.
                if (!this._compactionPromise && !this._compactionRollupReady) {
                    this._compactionPromise = this._beginBackgroundCompaction();
                }
                this._maybeRunCompaction();
            }
            // Daily token cap signals from the server-side accrual.
            if (resp?.cap_exceeded) {
                this.env.services.notification?.add?.(
                    _t("Daily voice token allowance reached. Ending session."),
                    { type: "warning", sticky: true }
                );
                this.end("cap_exceeded");
                return;
            }
            if (resp?.cap_warning && !this.state.tokenCapWarningShown) {
                this.state.tokenCapWarningShown = true;
                this.env.services.notification?.add?.(
                    _t("You're approaching your daily voice token allowance."),
                    { type: "info" }
                );
            }
        } catch (e) {
            console.warn(`[voice:${this.connId}] append failed, will retry on next flush`, e);
            // Re-queue messages so we don't lose them.
            this._pendingAppendQueue.unshift(...messages);
        }
    }

    /** Phase 1 of compaction: fire /compact in the background while the
     *  user keeps talking, so the eventual WS restart is fast (no LLM call
     *  inside the user-visible window). */
    async _beginBackgroundCompaction() {
        const sessionId = this.state.sessionId;
        if (!sessionId) return null;
        try {
            const result = await rpc(`/api/voice/session/${sessionId}/compact`, {});
            if (!result || !result.compacted) {
                console.log(`[voice:${this.connId}] background compaction skipped:`, result?.reason || "unknown");
                if (result?.reason === "nothing_absorbed" ||
                    result?.reason === "no_pending_summary" ||
                    result?.reason === "session_not_active") {
                    this._compactionPending = false;
                }
                this._compactionPromise = null;
                return result;
            }
            console.log(`[voice:${this.connId}] background compaction ready (rollup id`, result.rollup_id +
                ") — awaiting safe restart window");
            this._compactionRollupReady = true;
            this._maybeRunCompaction();
            return result;
        } catch (e) {
            console.warn(`[voice:${this.connId}] background compaction failed:`, e);
            this._compactionPromise = null;
            return null;
        }
    }

    /** Phase 2 of compaction: do the WS restart, but only when the rollup
     *  is ready AND we hit a natural pause window (no response in flight,
     *  assistant audio drained, WS open). */
    _maybeRunCompaction() {
        if (!this._compactionPending) return;
        if (!this._compactionRollupReady) return;
        if (this._compacting) return;
        if (this._responseInFlight) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this._assistantAudioActive()) return;
        this._compacting = true;
        this._compactionPending = false;
        // Lock input ONLY for the brief restart window.
        this.state.compacting = true;
        this._restartForCompaction()
            .catch((e) => {
                console.warn(`[voice:${this.connId}] compaction restart failed:`, e);
                this._compactionPending = true;
            })
            .finally(() => {
                this._compacting = false;
                this._compactionPromise = null;
                this._compactionRollupReady = false;
                this.state.compacting = false;
            });
    }

    /** Restart-on-compaction: close the current WebSocket without ending
     *  the session record, then call start() in resume mode. See the
     *  original singleton for why this beats in-place item.delete. */
    async _restartForCompaction() {
        const sessionId = this.state.sessionId;
        const agentId = this.lastAgentId || this.state.agentId;
        if (!sessionId || !agentId) {
            console.warn(`[voice:${this.connId}] compaction restart aborted: missing session or agent id`);
            return;
        }
        console.log(`[voice:${this.connId}] applying compacted context — restarting WS`);

        // Preserve mute state so the user's mic preference survives.
        const savedMuted = this.state.muted;

        await this._closeWsOnly();
        await this.start(agentId, sessionId, true);
        this.state.muted = savedMuted;
    }

    /** Tear down the active WebSocket + this leg's audio plumbing without
     *  touching the server-side session record. Used by the compaction
     *  restart path. */
    async _closeWsOnly() {
        this._stopAssistantAudio();
        this._responseInFlight = false;
        this.state.thinking = false;
        // Drop tool-call tracking — a stuck _invoke from the prior socket
        // would leave hasPending() permanently true after reconnect.
        this.toolDispatcher?.clearPending?.();
        this.pendingFunctionCalls?.clear?.();
        this._dispatchedCallIds?.clear?.();
        this._mcpCallArgs?.clear?.();

        // Flush queued appends + meta so nothing is lost across the
        // reconnect. Appends first (create rows), then meta (back-fill).
        // AWAITED: the restart's /start builds its replay from the DB, so
        // any row still in the queue when the query runs (e.g. a group-call
        // line mirrored in via recordMessage) would be missing from the
        // rebuilt live context until the next restart.
        if (this._appendFlushTimer) {
            clearTimeout(this._appendFlushTimer);
            this._appendFlushTimer = null;
        }
        await this._flushAppendQueue();
        if (this._metaFlushTimer) {
            clearTimeout(this._metaFlushTimer);
            this._metaFlushTimer = null;
        }
        await this._flushMetaQueue();

        if (this.ws) {
            // Detach handlers BEFORE closing — otherwise _onWsClose fires on
            // our intentional close and marks the session ended, breaking
            // the resume that follows.
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.onopen = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { /* swallow */ }
            }
        }
        this.ws = null;
        if (this.lipsyncUnsub) {
            this.lipsyncUnsub();
            this.lipsyncUnsub = null;
        }
        if (this.lipsyncChannel) {
            try { this.lipsyncChannel.detach(); } catch (e) { /* swallow */ }
        }
        if (this.assistantPlaybackNode) {
            try { this.assistantPlaybackNode.disconnect(); } catch (e) { /* swallow */ }
            this.assistantPlaybackNode = null;
        }

        // Brief "ended" status so the start() gate lets us proceed.
        this.state.status = "ended";
    }

    /** Queue a back-fill patch for a row already created via /append. */
    _enqueueMetaPatch(patch) {
        if (!patch || !patch.call_id) return;
        const existing = this._pendingMetaPatches.get(patch.call_id) || { call_id: patch.call_id };
        if (patch.xai_item_id) existing.xai_item_id = patch.xai_item_id;
        if (patch.xai_previous_item_id) existing.xai_previous_item_id = patch.xai_previous_item_id;
        this._pendingMetaPatches.set(patch.call_id, existing);
        if (!this._metaFlushTimer) {
            this._metaFlushTimer = setTimeout(() => this._flushMetaQueue(), 1500);
        }
    }

    async _flushMetaQueue() {
        this._metaFlushTimer = null;
        if (!this.state.sessionId || !this._pendingMetaPatches.size) return;
        const patches = Array.from(this._pendingMetaPatches.values());
        this._pendingMetaPatches.clear();
        try {
            await rpc(`/api/voice/session/${this.state.sessionId}/append-meta`, { patches });
        } catch (e) {
            console.warn(`[voice:${this.connId}] append-meta failed, will retry on next flush`, e);
            for (const p of patches) {
                if (!this._pendingMetaPatches.has(p.call_id)) {
                    this._pendingMetaPatches.set(p.call_id, p);
                }
            }
        }
    }

    /** Inject a typed user message into the live conversation. The model
     *  still replies with voice. `promptResponse: false` records the item in
     *  the model's context without asking it to reply — the manager uses
     *  this when routing a typed group-call turn to a different agent. */
    sendText(text, { promptResponse = true } = {}) {
        text = (text || "").trim();
        if (!text) return false;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.env.services.notification?.add?.(
                _t("Connect first before sending a typed message."),
                { type: "warning" }
            );
            return false;
        }
        // Compaction tears down and reopens the WS — a message landed in
        // this window would be dropped or arrive in a half-rebuilt session.
        if (this.state.compacting) {
            this.env.services.notification?.add?.(
                _t("Compacting context — try again in a moment."),
                { type: "info" }
            );
            return false;
        }
        // If the assistant is mid-reply, cancel it so the typed turn isn't
        // queued behind streaming audio — same shape as the barge-in path.
        if (this._responseInFlight) {
            this.cancelActiveResponse("typed-input");
        }
        this._sendWs({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
            },
        });
        this._appendMessage({ role: "user", content: text });
        if (promptResponse) {
            this._maybeCreateResponse();
        }
        return true;
    }

    /** Inject a hidden, non-transcript context item into the live session.
     *  The raw primitive behind sendContextEvent and the manager's
     *  cross-agent relay: `promptResponse` decides whether the model is
     *  asked to react now or the note just informs its next turn. */
    injectContextItem(text, { role = "user", promptResponse = false } = {}) {
        text = (text || "").trim();
        if (!text) return false;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(`[voice:${this.connId}] context injection DROPPED (ws not open): `
                + `"${text.slice(0, 80)}"`);
            return false;
        }
        if (this.state.compacting) {
            // Usually harmless: relayed lines are also recorded server-side
            // and come back via the compaction restart's replay. Logged so a
            // context gap can be traced to its cause.
            console.warn(`[voice:${this.connId}] context injection DROPPED (compacting): `
                + `"${text.slice(0, 80)}"`);
            return false;
        }
        this._sendWs({
            type: "conversation.item.create",
            item: {
                type: "message",
                role,
                content: [{ type: "input_text", text }],
            },
        });
        // Deliberately no _appendMessage — stays out of the transcript.
        if (promptResponse) {
            this._maybeCreateResponse();
        }
        return true;
    }

    /** Inject a hidden context note (e.g. a VR touch event) so the companion
     *  reacts in character. Debounced so rapid events don't flood the model.
     *  promptResponse=false stores the note for the next turn instead of
     *  asking the model to speak right now (used in group calls, where an
     *  unprompted reaction would steal the floor from the addressed agent). */
    sendContextEvent(text, { role = "user", minIntervalMs = 4000, promptResponse = true } = {}) {
        text = (text || "").trim();
        if (!text) return false;
        const now = Date.now();
        if (this._lastContextEventAt && now - this._lastContextEventAt < minIntervalMs) return false;
        this._lastContextEventAt = now;
        return this.injectContextItem(text, { role, promptResponse });
    }

    /** Enable the VR audio path. Registers ONE per-XR-frame driver that (1)
     *  ticks lipsync — an immersive session pauses window rAF — and (2)
     *  updates the spatial panner. Primary leg only (it owns the base
     *  avatar the panner tracks). */
    enableSpatialAudio() {
        if (this.role !== "primary") return;
        const renderer = this.env.services.voice_avatar_renderer;
        if (!renderer) return;
        if (!this._xrAudioUnsub) {
            this._xrAudioUnsub = renderer.addXRFrameCallback?.(() => {
                this.env.services.voice_lipsync?.tick?.();
                this._updateSpatialAudio();
            });
        }
        this._setupSpatialPanner();
    }

    /** Reroute assistant playback gain → HRTF panner → destination. The
     *  lipsync analyser stays tapped off the dry gain node. */
    _setupSpatialPanner() {
        if (this._panner) return;
        this._setupAssistantPlayback();
        const ctx = this.playbackContext;
        if (!ctx || !this.assistantPlaybackNode) return;
        const panner = ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "inverse";
        panner.refDistance = 0.6;
        panner.maxDistance = 12;
        panner.rolloffFactor = 0.5;
        try { this.assistantPlaybackNode.disconnect(ctx.destination); } catch (e) { /* may not be connected */ }
        this.assistantPlaybackNode.connect(panner);
        panner.connect(ctx.destination);
        this._panner = panner;
    }

    /** Tear down the VR audio path: unregister the frame driver and restore
     *  the flat stereo route (gain → destination). */
    disableSpatialAudio() {
        this._xrAudioUnsub?.();
        this._xrAudioUnsub = null;
        if (!this._panner) return;
        const ctx = this.playbackContext;
        try {
            this.assistantPlaybackNode?.disconnect(this._panner);
            this._panner.disconnect();
        } catch (e) { /* non-fatal */ }
        if (ctx && this.assistantPlaybackNode) {
            try { this.assistantPlaybackNode.connect(ctx.destination); } catch (e) { /* non-fatal */ }
        }
        this._panner = null;
    }

    _updateSpatialAudio() {
        const ctx = this.playbackContext;
        const renderer = this.env.services.voice_avatar_renderer;
        if (!ctx || !this._panner || !renderer) return;
        const head = renderer.getHeadWorldPosition?.();
        if (head) {
            if (this._panner.positionX) {
                this._panner.positionX.value = head.x;
                this._panner.positionY.value = head.y;
                this._panner.positionZ.value = head.z;
            } else {
                this._panner.setPosition(head.x, head.y, head.z);
            }
        }
        const lp = renderer.getXRListenerPose?.();
        if (lp) {
            const L = ctx.listener;
            if (L.positionX) {
                L.positionX.value = lp.px; L.positionY.value = lp.py; L.positionZ.value = lp.pz;
                L.forwardX.value = lp.fx; L.forwardY.value = lp.fy; L.forwardZ.value = lp.fz;
                L.upX.value = lp.ux; L.upY.value = lp.uy; L.upZ.value = lp.uz;
            } else {
                L.setPosition?.(lp.px, lp.py, lp.pz);
                L.setOrientation?.(lp.fx, lp.fy, lp.fz, lp.ux, lp.uy, lp.uz);
            }
        }
    }

    get isTerminal() {
        return ["idle", "ended", "error"].includes(this.state.status);
    }

    async end(reason = "client") {
        if (this._sessionEnded) return;
        // Durable end-of-call marker for group-call legs. Sessions are
        // resumed later (peer legs auto-resume on the next invite, users
        // resume-last), and the replayed history contains join/roster notes
        // phrased in the present tense — without a closing marker a later
        // solo resume would read them as still current. Queued BEFORE
        // _sessionEnded flips so the flush below carries it.
        if (this.state.sessionId
            && (this.role === "peer" || this.manager?.hasPeers?.())) {
            this._pendingAppendQueue.push({
                role: "system",
                content: this.role === "peer"
                    ? "You left the group voice call at this point. Any participant roster above no longer applies."
                    : "The group voice call ended at this point. Any participant roster above no longer applies.",
            });
        }
        this._sessionEnded = true;
        this.state.status = "ending";
        this.state.thinking = false;
        // Clear compaction flags so the disabled-input UX doesn't outlive
        // the session. Any background /compact promise settles on its own.
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        // Drop tool-call tracking so an in-flight dispatch doesn't leak
        // state into a later start() on this connection object.
        this.toolDispatcher?.clearPending?.();
        this.pendingFunctionCalls?.clear?.();
        this._dispatchedCallIds?.clear?.();
        this._mcpCallArgs?.clear?.();
        this._stopAssistantAudio();
        // A response may still be "in flight" when the user ends mid-reply.
        // We deliberately don't send response.cancel — the socket is about
        // to close. But these flags must NOT survive into the next session.
        this._responseInFlight = false;
        this._currentResponseId = null;
        this._assistantTranscriptInProgress = "";
        this._bargedIn = false;
        // Flush pending appends before ending. Order matters: append creates
        // the rows, append-meta back-fills ids on them.
        if (this._appendFlushTimer) {
            clearTimeout(this._appendFlushTimer);
            this._appendFlushTimer = null;
        }
        await this._flushAppendQueue();
        if (this._metaFlushTimer) {
            clearTimeout(this._metaFlushTimer);
            this._metaFlushTimer = null;
        }
        await this._flushMetaQueue();

        if (this.ws) {
            // Detach handlers BEFORE closing — a still-pending ws.onopen can
            // otherwise clobber status back to "live" after end() settled.
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { /* swallow */ }
            }
        }
        this.ws = null;
        // Fully rebuild this leg's playback graph next start.
        await this._teardownPlayback();
        // Reset the avatar's face so ending mid-speech doesn't freeze the
        // mouth open on its last viseme.
        this.avatarApi?.resetExpression?.();

        if (this.state.sessionId) {
            try {
                await rpc(`/api/voice/session/${this.state.sessionId}/end`, {
                    reason,
                    // Final running totals even if the last debounced flush
                    // hasn't fired.
                    total_input_tokens: this._runningTokens.input,
                    total_output_tokens: this._runningTokens.output,
                });
            } catch (e) {
                console.warn(`[voice:${this.connId}] /end failed:`, e);
            }
        }
        // Reset the budget counter so the header reads as a fresh slate.
        this.state.tokenUsage = 0;
        this.state.status = "ended";
        try { this.manager.onConnectionEnded(this); } catch (e) { /* non-fatal */ }
    }

    _fail(message) {
        this.state.status = "error";
        this.state.errorMessage = message;
        this._sessionEnded = true;
        this.state.tokenUsage = 0;
        this.state.tokenLimit = 0;
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        try { this.manager.onConnectionEnded(this); } catch (e) { /* non-fatal */ }
    }
}
