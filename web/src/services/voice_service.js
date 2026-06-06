import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { makeConversationState } from "../models/conversation_state";
import { ToolDispatcher } from "../models/tool_dispatcher";

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

/**
 * Voice service: top-level WebSocket lifecycle, mic capture, audio playback orchestration.
 *
 * Flow:
 * 1. start(agentId, resumeSessionId?) → POST /voice/session/start → server returns
 *    ephemeral xAI token + replay items + avatar payload.
 * 2. Open WebSocket to xAI Realtime URL with the ephemeral token.
 * 3. Send `session.update` (xAI fills it from server side, but we still confirm).
 * 4. If replay_items: replay them via `conversation.item.create` with replayMode=true.
 * 5. Begin mic capture, stream PCM frames via `input_audio_buffer.append`.
 * 6. Receive audio_deltas, write to assistant <audio> element via MediaSource.
 * 7. Lipsync service taps the assistant <audio> element via createMediaElementSource.
 * 8. Function calls from xAI: dispatch via ToolDispatcher.
 *
 * Audio strategy: xAI Realtime sends PCM16 (24kHz default). Easiest browser-side path
 * is to decode PCM frames into AudioBuffers and queue them on a single ScriptProcessor
 * (or AudioWorkletNode) — but for v1 we use a simpler approach: collect deltas into
 * Float32 chunks and play them via gain → destination. We also tap that node for
 * the lipsync analyser.
 */

class VoiceService {
    // xAI's accepted PCM sample rates (from the server validator). Browsers
    // can return native rates outside this set on studio-grade hardware
    // (96000, 88200) — _ensureAudioContext snaps to the closest valid rate.
    static XAI_PCM_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

    constructor(env) {
        this.env = env;
        this.state = makeConversationState();
        this.ws = null;
        this.audioContext = null;
        this.micStream = null;
        this.micProcessor = null;
        this.assistantPlaybackNode = null;
        this.lipsyncTapNode = null;
        // Assistant playback. Each xAI response.audio.delta is decoded to a
        // Float32Array and scheduled on the AudioContext clock at an explicit
        // start time (the xAI cookbook's nextPlayTime model). Once scheduled,
        // the audio thread plays chunks back-to-back regardless of main-thread
        // jank (3D avatar render, lip-sync, RPC) — eliminating the mid-speech
        // cutouts the older onended-chaining model suffered. _scheduledSources
        // holds every not-yet-finished BufferSource (pruned on `ended`) so
        // barge-in can stop them all; _nextPlayTime is the context time the
        // next chunk should start at. (LiveKit gets the same property via
        // WebRTC's jitter buffer; that path doesn't apply to our no-WebRTC,
        // direct-WebSocket architecture.)
        this._scheduledSources = [];
        this._nextPlayTime = 0;
        this.toolDispatcher = null;
        this.pendingFunctionCalls = new Map();   // call_id → { name, argsBuffer }
        this.lipsyncUnsub = null;
        this.replayInProgress = false;
        this._sampleRate = 24000;     // xAI default
        this._userTranscriptInProgress = "";
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
        // Mid-session compaction state. The flow is now split into two
        // phases so the user never hears a long stall:
        //   1. Background summary — as soon as the server flags
        //      needs_compaction we fire /compact in the background while
        //      the WS, mic and assistant audio all stay live. The user
        //      keeps talking; the summary LLM call (1-5s) runs silently.
        //      _compactionPending=true and _compactionPromise holds the
        //      in-flight RPC.
        //   2. WS restart — once the rollup is on the server
        //      (_compactionRollupReady=true) we wait for a natural pause
        //      window (no response in flight, assistant audio drained)
        //      and then do the fast reconnect: no LLM call, just a token
        //      mint + WS reopen + replay seeding. state.compacting only
        //      flips true for this short phase so the input lockout is
        //      visible to the user for the minimum possible duration.
        // _compacting is the per-run lock that prevents concurrent
        // restarts.
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        this._compacting = false;
        this.lastAgentId = null;
        this._sessionEnded = false;
        // Parallel-init audio buffer: per xAI's best practices, the worklet
        // starts capturing immediately on Connect (in parallel with the WS
        // handshake). Frames produced before _onWsOpen has sent session.update
        // are pushed here and flushed in order once the session is configured,
        // so the user's first words aren't lost if they speak before "Live".
        // Capped at ~5s of audio (60 frames × 2048 samples / 24kHz ≈ 85ms each)
        // so a stalled WS doesn't grow it unbounded.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
        // UI-side preference shared by side panel + full view so a companion
        // pick in one view persists into the other (and across reopens within
        // the same browser tab). Lives on the service rather than per-component
        // local state, which was getting reset to the configured default
        // every time a view re-mounted.
        this.preferredAgentId = null;
        // Outfit selection lives on the reactive `state` (selectedOutfitId)
        // instead of a plain instance field — the dropdowns in full view and
        // side panel both subscribe via useState, so the agent's change_outfit
        // tool calls also propagate to those UIs. _hydrateAvatar() in each
        // component validates the stored id against the active avatar's
        // outfit list when switching agents.
    }

    /** Lazily get the singleton AudioContext (browsers require user gesture before resume).
     *  We try the device's native rate first — letting the browser pick
     *  means no silent resample pass when the native rate is xAI-compatible
     *  (typically 48000 on desktop). If the native rate is outside xAI's
     *  accepted set (e.g. 96000 / 88200 from studio-grade DACs), we close
     *  and re-create the context with the nearest valid rate so xAI's
     *  session.update validator doesn't reject the configuration.
     *
     *  xAI's accepted PCM sample rates (from server validator error):
     *    8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000
     */
    _ensureAudioContext() {
        if (!this.audioContext || this.audioContext.state === "closed") {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            let ctx = new Ctor();
            if (!VoiceService.XAI_PCM_RATES.includes(ctx.sampleRate)) {
                const original = ctx.sampleRate;
                const target = VoiceService._snapXaiRate(ctx.sampleRate);
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

    /** Pick the closest xAI-supported PCM rate. Ties are broken by the lower
     *  rate (less bandwidth) which is the conservative choice. */
    static _snapXaiRate(rate) {
        const rates = VoiceService.XAI_PCM_RATES;
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

    /** Tear the audio graph down to bare metal — close the AudioContext,
     *  drop the worklet module flag, stop the mic stream, disconnect the
     *  playback node, detach lipsync.
     *
     *  Why this isn't optional: keeping the AudioContext + AudioWorklet
     *  alive across sessions has been a recurring source of intermittent
     *  "speech does nothing after End → Connect" bugs that only a full
     *  page reload could clear. The xAI iOS cookbook
     *  (VoiceAgentAudioEngine.stop) rebuilds AVAudioEngine on every
     *  session — we now do the equivalent on the web side. Cost is ~100ms
     *  on the next start (worklet re-addModule + new context), which is
     *  acceptable for the reliability gain.
     *
     *  Safe to call repeatedly — every step is null-guarded.
     */
    async _destroyAudioGraph() {
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
        this._stopAssistantAudio();
        if (this.assistantPlaybackNode) {
            try { this.assistantPlaybackNode.disconnect(); } catch (e) { /* swallow */ }
            this.assistantPlaybackNode = null;
        }
        if (this.lipsyncUnsub) {
            try { this.lipsyncUnsub(); } catch (e) { /* swallow */ }
            this.lipsyncUnsub = null;
        }
        try { this.env.services.voice_lipsync?.disconnect?.(); } catch (e) { /* swallow */ }
        if (this.audioContext && this.audioContext.state !== "closed") {
            try { await this.audioContext.close(); } catch (e) { /* swallow */ }
        }
        this.audioContext = null;
        // Worklet module load is per-AudioContext; resetting the flag
        // forces _startMic to re-addModule against the fresh context next
        // time. Without this, AudioWorkletNode construction throws
        // "InvalidStateError: cannot register processor on closed context".
        this._micWorkletReady = false;
        // Drop any audio queued for the next session — stale frames from a
        // dead WS shouldn't leak into the new one.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
    }

    async start(agentId = null, resumeSessionId = null, isCompactionRestart = false) {
        if (this.state.status !== "idle" && this.state.status !== "ended" && this.state.status !== "error") {
            // Already running. Surface a notification so the user understands
            // why nothing happened (the silent return previously made resume-
            // from-history feel broken — the click did nothing visible).
            this.env.services.notification?.add?.(
                _t("End the current voice session before starting a new one."),
                { type: "warning" }
            );
            return false;
        }
        // Reset the parallel-init audio buffer + readiness flag on every
        // start so the new WS's _onWsOpen owns a clean buffer-flush cycle.
        // Compaction restart goes through here too — its previous session
        // left _wsReady=true, and we want the new session's worklet frames
        // to go through the buffer→flush path against the new ws.
        this._earlyAudioBuffer = [];
        this._wsReady = false;
        // Always rebuild the audio graph from scratch. Even when end() ran
        // cleanly we re-do it for symmetry, and crucially: if the previous
        // session died via _onWsClose (which no longer recursively calls
        // end()), the AudioContext + worklet + mic stream are still alive
        // from the prior run. Stale audio state surviving across sessions
        // is the root of the "speak does nothing after Connect" bug that
        // only a page reload fixed.
        //
        // Compaction restart goes through this path too. We originally
        // tried skipping the rebuild to save ~100ms but the same stale-
        // audio-state bug bit us: after compaction, xAI's server VAD
        // received audio bursts that misclassified the user's speech
        // (the symptom was committed buffers transcribing only the first
        // syllable repeatedly, never firing response.created). The
        // reused AudioContext + worklet enter a subtly bad state that
        // only a full teardown clears. The latency cost is acceptable
        // given the LLM summary call is already front-loaded.
        await this._destroyAudioGraph();
        this.state.status = "connecting";
        this.state.errorMessage = null;
        // Never clear messages on compaction restart: the local transcript
        // already holds the full conversation history (we append to
        // state.messages as turns happen and never remove anything). The
        // post-compaction view is purely an xAI-context concern — the
        // user keeps seeing every turn they ever spoke, regardless of
        // how often we roll older turns into a summary for the model.
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
        // in flight (user ended mid-reply, or start failed). Clear it so the
        // fresh session never thinks a turn from the dead session is pending —
        // a stale true here makes the first typed turn send a bogus
        // response.cancel that xAI rejects ("no active response found").
        this._responseInFlight = false;
        // Latched true while a turn owes a post-tool-call follow-up
        // response.create. Fired only once the originating response.done has
        // landed AND every function_call_output is submitted — see
        // _maybeCreateToolReply.
        this._pendingToolReply = false;
        this.pendingFunctionCalls.clear();
        this._runningTokens = { input: 0, output: 0 };
        // Re-arm the daily-cap soft-warning latch so the toast can fire
        // once per session (not once per browser session).
        this.state.tokenCapWarningShown = false;
        // Don't touch _compacting here — it's a per-restart lock owned by
        // _maybeRunCompaction's finally block. _restartForCompaction calls
        // start() WHILE the lock is held; releasing it here would let a
        // concurrent /append flush re-trigger compaction during the
        // restart. Pending flag is fine to clear: the threshold check
        // re-flags on the next /append if still warranted.
        this._compactionPending = false;

        // Eagerly create the AudioContext so we know the device's native
        // sample rate before the RPC. We pass it through to xAI so the
        // server matches our rate — no silent resampling on either side.
        // Click is a user gesture, which Chrome requires to resume a
        // newly-created AudioContext, so this is the right place to do it.
        this._ensureAudioContext();

        let payload;
        try {
            payload = await rpc("/api/voice/session/start", {
                agent_id: agentId,
                resume_session_id: resumeSessionId,
                audio_sample_rate: this._sampleRate,
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
        this.state.avatar = payload.avatar;
        this.state.voice = payload.voice;
        this._sessionUpdate = payload.session_update;
        // Two parallel feeds from start_session:
        //   * replay_items     — compacted (filtered + rollup-hoisted),
        //     forwarded to xAI in _onWsOpen via conversation.item.create.
        //   * transcript_history — full chronological list, used only to
        //     paint the UI transcript on resume. Backend rollup is
        //     excluded; the user sees their full conversation regardless
        //     of any backend summarization.
        this._replayItems = payload.replay_items || [];
        this._transcriptHistory = payload.transcript_history || [];
        // Server may have capped transcript_history at config.transcript_
        // display_limit; the flag lets the UI hint that there's older
        // history in the DB the user isn't seeing. We don't expose a
        // "Load earlier" affordance yet — would add it here when needed.
        // Not touched on compaction restart so the existing UI hint
        // (if any) sticks until end of session.
        if (!isCompactionRestart) {
            this.state.transcriptTruncated = !!payload.transcript_truncated;
        }
        // Seed the running token counter from any existing session totals
        // (non-zero only on resume). Subsequent response.done events add
        // to this baseline so the value we send back is always the full
        // session total, which is what the server expects under its
        // "max wins" persistence rule.
        this._runningTokens = {
            input: payload.total_input_tokens || 0,
            output: payload.total_output_tokens || 0,
        };
        // Compact-budget display. Baseline is the running total at the
        // last rollup; the UI shows (current - baseline) / threshold so
        // the user sees how many tokens remain before the next auto-
        // compact. After a compaction the server bumps tokens_at_last_
        // summary, and since compaction restarts go through /start, the
        // fresh baseline arrives here automatically.
        this._tokensAtLastSummary = payload.tokens_at_last_summary || 0;
        this.state.tokenLimit = payload.summary_threshold_tokens || 0;
        this.state.tokenUsage = Math.max(
            0,
            (this._runningTokens.input + this._runningTokens.output) - this._tokensAtLastSummary,
        );

        // When resuming, populate the local transcript from
        // transcript_history (the unfiltered chronological feed) so the
        // user sees the full prior conversation. xAI separately gets the
        // compacted replay_items in _onWsOpen via conversation.item.create.
        //
        // Skipped entirely on compaction restart: state.messages already
        // holds the live transcript and we never want to clear it — the
        // user's view of their conversation is decoupled from any backend
        // summarization that happens to ride along with the restart.
        //
        // Three xAI item shapes to render:
        //   - message            → role from item.role; content from .text parts
        //   - function_call      → tool_call row with name(args) summary
        //   - function_call_output → tool_result row with the stored output
        if (!isCompactionRestart) {
            for (const item of this._transcriptHistory) {
                if (item.type === "message") {
                    const text = (item.content || []).map((c) => c.text || "").join("").trim();
                    if (!text) continue;
                    this.state.messages.push({
                        role: item.role,
                        content: text,
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

        // Configure renderer. The side panel / full view normally hydrates
        // the VRM before Connect is clicked, so skip the load here if a model
        // is already on screen — otherwise we'd overwrite a user-picked outfit
        // with the avatar's default. Headless contexts (no panel mounted yet)
        // still need this fallback so the avatar appears at all.
        const renderer = this.env.services.voice_avatar_renderer;
        // active_background is resolved server-side (tagged default → latest
        // Imagine → first curated — see _resolve_active_background, mirrored
        // by full_view._hydrateAvatar). BUT an explicit pick made in the
        // fullscreen dropdown beats it — without this guard, hitting Start
        // snapped the picker back to the server's resolution, discarding the
        // user's choice.
        // Same philosophy as the outfit guard above: on-screen user state
        // wins over server defaults. The flag resets on avatar change, so a
        // different character still boots from the server resolution.
        const keepUserBackground = this.state.backgroundPickedByUser;
        if (renderer && payload.avatar) {
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
        // Store the resolved background on conversation state so the picker
        // can highlight it and the tool dispatcher can update it.
        if (!keepUserBackground) {
            this.state.activeBackground = payload.active_background || null;
        }

        // Open WebSocket. xAI's docs say the ephemeral token goes in the WS
        // sub-protocol with the `xai-client-secret.` prefix. The token returned
        // from /v1/realtime/client_secrets MAY already carry the prefix or may
        // be raw — be defensive either way.
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
            console.error("[voice] WS error", ev);
        };
        this.ws.onclose = (ev) => this._onWsClose(ev);

        // Tool dispatcher
        this.toolDispatcher = new ToolDispatcher({
            actionService: this.env.services.action,
            avatarRenderer: renderer,
            sendWs: (msg) => this._sendWs(msg),
            conversationState: this.state,
            sessionId: this.state.sessionId,
        });

        // Kick the mic acquisition off in parallel with the WS connecting.
        // Cookbook starts AVAudioEngine immediately after webSocket.connect,
        // not after webSocketDidOpen — getUserMedia + AudioWorklet.addModule
        // can take 100-300ms (more on first-time-permission), and overlapping
        // that with the WS handshake shaves user-perceived connect latency.
        // The mic worklet's onmessage gate (`!this.ws || readyState !== OPEN`)
        // drops frames produced before the WS opens, so there's no risk of
        // pre-session-update audio leaking through. _onWsOpen awaits this
        // promise before flipping status to "live" — same guarantee as
        // before, just parallelized.
        this._micStartPromise = this._startMic().catch((e) => {
            // _startMic calls _fail on hard failures; rethrow so _onWsOpen's
            // catch can surface a generic "couldn't enter live" if needed.
            throw e;
        });
        // Kick-off succeeded — async transition to "live" continues in _onWsOpen.
        return true;
    }

    async _onWsOpen() {
        // Safety net: end() may have run during the connect (user clicked End
        // before the WS fully opened, or a transient ws.close fired and routed
        // through _onWsClose → end()). If so, refuse to bring the session up
        // — without this, status gets clobbered back to "live" after end()
        // already settled on "ended", leaving the End button visible but the
        // mic-worklet silently dropping every chunk (this.ws was nulled by
        // end()). end() also detaches our handlers before close, so we
        // normally never get here in that case, but the guard is cheap.
        if (this._sessionEnded) {
            console.warn("[voice] _onWsOpen fired after session ended — ignoring");
            return;
        }
        try {
            // xAI's /v1/realtime/client_secrets endpoint accepts only `expires_after`,
            // so the full session config (voice, instructions, MCP tool entry with
            // bearer + custom headers, browser function tools, modalities, VAD) is
            // sent here from the browser. The server pre-built it for us.
            if (this._sessionUpdate) {
                console.log("[voice] sending session.update", this._sessionUpdate);
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

            // Flush any audio the worklet captured during the parallel
            // connect window. Must come AFTER session.update + replay so
            // xAI receives the config first (per the xAI best-practices
            // doc); flipping _wsReady=true here is also what enables the
            // worklet's onmessage to start sending subsequent frames
            // directly instead of buffering them.
            this._flushEarlyAudioBuffer();

            // Mic acquisition was kicked off in parallel from start() to
            // overlap with the WS handshake. Now block until it resolves
            // (or fails — _startMic raises on hard setup failures; mic
            // denial sets state.muted = true and resolves false instead).
            if (this._micStartPromise) {
                await this._micStartPromise;
                this._micStartPromise = null;
            }

            this.state.status = "live";
            console.log("[voice] session live", this.state.muted ? "(muted)" : "");
        } catch (e) {
            console.error("[voice] _onWsOpen failed", e);
            // _fail was already called inside _startMic for hard setup failures;
            // surface a generic message so the UI doesn't get stuck on "connecting".
            if (this.state.status === "connecting") {
                this._fail(e?.message || "Failed to enter live state");
            }
        }
    }

    /** Acquire mic + wire the PCM-streaming processor.
     *
     *  Returns true on success, false if the user denied/blocked the mic. A
     *  denial is NOT a session failure — we start the session muted so the
     *  user can still type, and they can click Unmute later to re-prompt.
     *  A real setup failure (audio graph wiring, etc.) still raises.
     */
    async _startMic() {
        if (this.micStream && this.micProcessor) return true;  // already running
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    // No sampleRate hint — let the browser deliver at native
                    // device rate (matches our AudioContext), avoids a hidden
                    // resample pass on every captured frame.
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    // autoGainControl normalises the user's input level over
                    // time. The iOS cookbook turns AGC on via
                    // isVoiceProcessingAGCEnabled; this is the browser-side
                    // equivalent. Crucial for soft/quiet speakers — without
                    // it, server VAD frequently misses utterances that come
                    // in below threshold.
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
        // Bail if the session was torn down while we were awaiting the
        // permission prompt (end() can run during a slow getUserMedia and
        // _destroyAudioGraph nulls everything; without this check we'd
        // re-populate this.micStream against a dead service and leave a
        // mic track running with no consumer).
        if (this._sessionEnded) {
            for (const track of this.micStream.getTracks()) {
                try { track.stop(); } catch (_) { /* swallow */ }
            }
            this.micStream = null;
            return false;
        }
        // Listen for the mic track ending unexpectedly (USB device yanked,
        // OS revoked permission, browser tab muted by the user). Without
        // this the worklet keeps posting silent frames into a live WS and
        // the user sees nothing change — barge-in stops working, no audio
        // reaches the model, the session looks frozen. Surface it as a
        // mute + notification so the user knows to plug the mic back in.
        for (const track of this.micStream.getTracks()) {
            track.addEventListener("ended", () => this._onMicTrackEnded(track), { once: true });
        }
        try {
            const ctx = this._ensureAudioContext();
            const source = ctx.createMediaStreamSource(this.micStream);
            // AudioWorkletNode replaces the deprecated ScriptProcessorNode.
            // The worklet runs on a dedicated audio thread, postMessages
            // 2048-sample frames back to us, and we keep the same PCM16 +
            // base64 + WS flush pipeline. Module load is per-AudioContext;
            // cache the readiness flag so re-entering _startMic (after a
            // mute/unmute cycle) skips the addModule fetch.
            if (!this._micWorkletReady) {
                if (this._sessionEnded) {
                    // Session torn down while we were setting up; release
                    // the stream and abort before allocating worklet state.
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
            if (this._sessionEnded) {
                // Final guard before allocating the worklet node — session
                // may have ended during addModule.
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
            // The worklet emits silent output (we don't write to the output
            // bus). Connecting to destination keeps the node alive in the
            // graph — destination's silent input is harmless.
            this.micProcessor.connect(ctx.destination);
            this.micProcessor.port.onmessage = (ev) => {
                // state.compacting covers both the audio-drain wait and the
                // brief WS-restart window; without it, the user can keep
                // talking into a void (the WS may already be closing or the
                // server-side context is being torn down).
                if (this.state.muted || this.state.compacting) return;
                const input = ev.data;
                const pcm16 = floatToPcm16(input);
                const base64 = arrayBufferToBase64(pcm16.buffer);
                // Three states for the WS:
                //   1. _wsReady=false (WS still connecting OR session.update
                //      not flushed yet) → buffer for later flush.
                //   2. _wsReady=true, ws OPEN → send directly.
                //   3. _wsReady=true, ws not OPEN (closed/closing) → drop.
                // The buffer is capped at ~5s of audio so a stalled connect
                // doesn't grow it unbounded. State (1) → state (2)
                // transition happens in _onWsOpen after session.update +
                // replay items are sent — see _flushEarlyAudioBuffer.
                if (!this._wsReady) {
                    if (this._earlyAudioBuffer.length < 60) {
                        this._earlyAudioBuffer.push(base64);
                    }
                    return;
                }
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                this._sendWs({ type: "input_audio_buffer.append", audio: base64 });
            };
        } catch (e) {
            console.error("[voice] mic setup failed", e);
            // Tear down the half-acquired stream so a retry via Unmute starts clean.
            if (this.micStream) {
                for (const track of this.micStream.getTracks()) track.stop();
                this.micStream = null;
            }
            this._fail(_t("Microphone setup failed: ") + (e?.message || e));
            throw e;
        }
        return true;
    }

    _setupAssistantPlayback() {
        if (this.assistantPlaybackNode) return;
        const ctx = this._ensureAudioContext();
        // Single dummy gain node for playback chain. Lipsync analyser will be
        // attached by the lipsync service via createMediaElementSource — but
        // since we synthesize audio buffers ourselves, we feed them through a
        // gain node and let lipsync tap the same node.
        this.assistantPlaybackNode = ctx.createGain();
        this.assistantPlaybackNode.gain.value = 1;
        this.assistantPlaybackNode.connect(ctx.destination);

        // Inform lipsync via a custom hook: connect an analyser to our gain node.
        const lipsync = this.env.services.voice_lipsync;
        if (lipsync && !lipsync.connected) {
            // Build a virtual element: lipsync expects a media element source, but
            // since we play via AudioBufferSourceNode chain, we need a different path.
            // Workaround: we skip the analyser tap on the audio element and instead
            // hook the gain node directly.
            this._attachLipsyncToGain(this.assistantPlaybackNode);
        }
    }

    _attachLipsyncToGain(gainNode) {
        const lipsync = this.env.services.voice_lipsync;
        if (!lipsync) return;
        const ctx = gainNode.context;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        gainNode.connect(analyser);
        // Feed the existing service plumbing manually.
        lipsync.audioContext = ctx;
        lipsync.analyser = analyser;
        lipsync.timeBuffer = new Float32Array(analyser.fftSize);
        lipsync.freqBuffer = new Float32Array(analyser.frequencyBinCount);
        lipsync.connected = true;
        lipsync._startLoop();

        // Wire vowel updates → state + renderer.
        if (this.lipsyncUnsub) this.lipsyncUnsub();
        const renderer = this.env.services.voice_avatar_renderer;
        this.lipsyncUnsub = lipsync.addListener((vowels, intensity) => {
            this.state.vowels = vowels;
            this.state.speakingIntensity = intensity;
            renderer?.setVowels?.(vowels);
            // Drive body/head gestures from speech intensity. Renderer smooths
            // (fast attack, slow release) so brief silences between words don't
            // collapse the gesture; on real silence (interrupt or end-of-turn),
            // intensity decays to 0 over ~1 second and the avatar settles.
            renderer?.setSpeakingIntensity?.(intensity);
        });
    }

    /** Decode and schedule one assistant audio chunk for gapless playback.
     *  Each chunk is started at an explicit time on the AudioContext clock —
     *  the later of "now + jitter cushion" and the end of the previously
     *  scheduled chunk — so the audio thread plays them back-to-back even when
     *  the main thread is busy. Mirrors the xAI web cookbook's nextPlayTime
     *  model and replaces onended-chaining, whose main-thread-callback handoff
     *  between chunks caused mid-speech cutouts under render/RPC load. */
    _enqueueAssistantAudio(int16ArrayBuffer) {
        const float32 = pcm16ToFloat32(new Int16Array(int16ArrayBuffer));
        const ctx = this._ensureAudioContext();
        this._setupAssistantPlayback();
        const audioBuffer = ctx.createBuffer(1, float32.length, this._sampleRate);
        audioBuffer.copyToChannel(float32, 0);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.assistantPlaybackNode);

        // Re-anchor to now (+ cushion) whenever the schedule has fallen behind
        // real time: a fresh turn, or an underrun where chunks stopped arriving
        // and playback caught up to _nextPlayTime. This is also the drift guard
        // the old playhead model lacked — _nextPlayTime can never run away from
        // currentTime because it's reset here.
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
            // off mid-word. Once everything has drained, re-poke it in case a
            // flag was set during the response.
            if (this._scheduledSources.length === 0 && this._compactionPending && !this._compacting) {
                this._maybeRunCompaction();
            }
        };
    }

    /** True while assistant audio is still scheduled or playing out. Replaces
     *  the old (`_currentAssistantSource || queue.length`) checks. */
    _assistantAudioActive() {
        if (this._scheduledSources.length > 0) return true;
        const ctx = this.audioContext;
        return !!ctx && this._nextPlayTime > ctx.currentTime;
    }

    /** Stop all scheduled/playing assistant audio and reset the schedule. Used
     *  for barge-in when the user starts talking while the assistant replies.
     *  With scheduled playback several chunks may be queued ahead at once, so
     *  every source is stopped (not just a single "current" one). */
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
        // console isn't drowned by audio.delta. Toggle the noise filter to
        // see audio frames during deeper debugging.
        if (!msg.type?.endsWith(".delta")) {
            console.log("[voice] ←", msg.type, msg);
        }
        // Keepalive: xAI sends `ping` events with a timestamp; we echo back
        // `pong` with the same timestamp. Without this, idle connections may
        // be closed by the server. The xAI sample app handles this the same way.
        if (msg.type === "ping") {
            // xAI's ping payload schema has shifted between revisions —
            // the iOS cookbook (VoiceAgentConversation.swift) echoes back
            // `ping_timestamp`, but current xAI builds emit `timestamp` +
            // `event_id` instead. Mirror back every correlation field we
            // recognize so the pong is valid against whatever shape the
            // server is on. Without a recognised pong, the server may
            // count us as unresponsive and silently degrade the session.
            const reply = { type: "pong" };
            if (msg.ping_timestamp != null) reply.ping_timestamp = msg.ping_timestamp;
            if (msg.timestamp != null) reply.timestamp = msg.timestamp;
            if (msg.event_id != null) reply.event_id = msg.event_id;
            this._sendWs(reply);
            return;
        }

        // Audio out — xAI uses `response.output_audio.delta`. The `delta` field
        // carries base64-encoded PCM16. We accept either `delta` or `audio` since
        // older API revisions used the latter.
        if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
            // After barge-in, xAI may still be streaming audio chunks that
            // were already in flight when our response.cancel arrived on
            // their side. Without this gate they queue up and play out as
            // a tail after the user has already started a new turn — the
            // interrupt looks broken even though it worked. Flag is cleared
            // when the next response starts (response.created handler).
            if (this._bargedIn) return;
            // Drop deltas from a stale response (cancelled or superseded) so
            // they don't play after the user has moved on. The xAI sample
            // app does the same per-event check.
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
        // Assistant transcript deltas — xAI uses `response.output_audio_transcript.delta`.
        if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.text.delta") {
            // Same staleness guard as audio: a cancelled response can still
            // emit transcript deltas; without filtering they accumulate into
            // _assistantTranscriptInProgress and contaminate the next turn
            // (or surface as a "ghost" assistant message on the trailing
            // .done event).
            if (msg.response_id && this._currentResponseId &&
                msg.response_id !== this._currentResponseId) return;
            this.state.thinking = false;
            if (msg.delta) this._assistantTranscriptInProgress += msg.delta;
            return;
        }
        // Assistant transcript final — `done` events carry the full transcript
        // in a `transcript` field, which we prefer over the accumulated deltas
        // (deltas can be lossy if events arrive out of order).
        if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.text.done") {
            // Drop trailing .done from a stale response so its partial
            // transcript doesn't surface as a ghost assistant message.
            if (msg.response_id && this._currentResponseId &&
                msg.response_id !== this._currentResponseId) return;
            const finalText = msg.transcript || this._assistantTranscriptInProgress;
            if (finalText) {
                this._appendMessage({ role: "assistant", content: finalText });
            }
            this._assistantTranscriptInProgress = "";
            return;
        }
        // Audio finished — already emitted as separate event from transcript.done;
        // nothing to do here, the playback queue drains itself.
        if (msg.type === "response.output_audio.done" || msg.type === "response.audio.done") {
            return;
        }
        if (msg.type === "response.done" || msg.type === "response.completed") {
            const status = msg.response?.status;
            const respId = msg.response?.id;
            // xAI's realtime ships the populated usage object at the OUTER
            // event level rather than inside response.usage as the OpenAI
            // spec implies (response.usage arrives empty: `{}`). Read the
            // inner one first for OpenAI-compatibility, fall back to outer.
            const innerUsage = msg.response?.usage;
            const usage = innerUsage && Object.keys(innerUsage).length
                ? innerUsage
                : msg.usage;
            // Structured per-response summary so the console clearly shows
            // each cycle's status + token consumption, useful for cost
            // tracking and for spotting "0 output tokens" cases that
            // indicate a stalled or abandoned response.
            console.log(
                "[voice] response", respId, "done:", status,
                usage
                    ? `(in: ${usage.input_tokens ?? "?"}, out: ${usage.output_tokens ?? "?"}, total: ${usage.total_tokens ?? "?"})`
                    : ""
            );
            // Accumulate token usage into the session-running counter so
            // the next /append flush reports an up-to-date total to the
            // server, which uses it for the token-based summary threshold
            // and to keep the session record's totals accurate (we used to
            // only ever send tokens at /end, leaving them at 0 mid-session).
            // Cancelled responses still report partial usage — count it.
            if (usage) {
                this._runningTokens.input += usage.input_tokens || 0;
                this._runningTokens.output += usage.output_tokens || 0;
                // Mirror the new total into the reactive state so the
                // status bar's `usage / limit` indicator updates each turn.
                this.state.tokenUsage = Math.max(
                    0,
                    (this._runningTokens.input + this._runningTokens.output) - (this._tokensAtLastSummary || 0),
                );
            }
            // Cancelled responses (e.g. our barge-in cancel) shouldn't reset
            // _responseInFlight here, since the speech_started handler
            // already cleared it explicitly and the user may already be
            // mid-way through a new turn.
            if (status !== "cancelled") {
                this._responseInFlight = false;
                this.state.thinking = false;
                // The originating response is now fully complete. If it emitted
                // tool calls, this is the gate to send the follow-up reply —
                // but only once every function_call_output has also been
                // submitted (see _maybeCreateToolReply). Firing before this
                // point races the still-active response; xAI then rejects the
                // duplicate or answers without the tool result (a "dropped"
                // tool call). Whichever lands last — this event or the final
                // dispatch().then() — triggers the reply.
                this._maybeCreateToolReply();
            } else {
                // Cancelled (barge-in / abort): abandon any owed tool reply.
                this._pendingToolReply = false;
            }
            // If a /append earlier flagged needs_compaction during this
            // response, restart the session now that the model is idle —
            // doing it mid-response would tear down the WebSocket while
            // audio is still streaming.
            this._maybeRunCompaction();
            return;
        }
        // session.updated acks our session.update. xAI may silently drop
        // unknown fields — we sanity-check that the voice and tool TYPES
        // round-tripped, since a mismatch means part of our config didn't
        // take and would explain unexpected behavior downstream.
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
                console.warn("[voice] session.updated mismatch:", mismatches.join("; "));
            } else {
                console.log("[voice] session.updated — accepted as sent");
            }
            return;
        }
        // conversation.item.added is mostly informational — except when xAI
        // delivers a function_call_output via its server-side MCP path, which
        // is the cleanest signal that the MCP call actually completed end-
        // to-end. Logging it explicitly makes the success vs. abandonment
        // path obvious without having to read the whole event dump.
        if (msg.type === "conversation.item.added") {
            const item = msg.item || {};
            if (item.type === "function_call_output") {
                console.log(
                    "[voice] xAI delivered function_call_output for call_id",
                    item.call_id,
                    "(server-side tool call resolved)"
                );
            }
            // Back-fill xai_item_id and xai_previous_item_id on rows we
            // already recorded at the source event (mcp_call.in_progress /
            // function_call_arguments.done). conversation.item.added is the
            // canonical event that always carries previous_item_id, and is
            // the only place we learn the function_call_output's own item.id
            // (we only knew the call_id when we sent it).
            const callId = item.call_id;
            if (callId && (item.id || msg.previous_item_id)) {
                this._enqueueMetaPatch({
                    call_id: callId,
                    xai_item_id: item.id || null,
                    xai_previous_item_id: msg.previous_item_id || null,
                });
                // Mirror the patch into the local in-memory transcript so
                // anything reading state.messages later sees the same ids.
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
        // flips true. (For typed/text turns and post-tool flow, the flag
        // gets set in _maybeCreateResponse / the post-tool handler before
        // we send response.create ourselves.)
        if (msg.type === "response.created") {
            this._responseInFlight = true;
            this._currentResponseId = msg.response?.id || null;
            console.log("[voice] response started:", this._currentResponseId);
            // call_id is RESPONSE-scoped per the spec — xAI restarts at "0"
            // for each new response. Without clearing the dedupe sets here,
            // turn 2's call_id "0" gets suppressed because turn 1 already
            // recorded "0", and the tool_call entry never appears in the
            // transcript. Same risk for browser-tool dispatch tracking and
            // for arg/pending maps lingering with stale data.
            this._recordedMcpCallIds?.clear();
            this._mcpCallArgs?.clear();
            this._dispatchedCallIds?.clear();
            this.pendingFunctionCalls?.clear();
            // Fresh turn — clear any tool-reply debt. (If this response itself
            // emits tool calls, _handleFunctionCall re-arms the flag.)
            this._pendingToolReply = false;
            // A new response is starting — any post-barge-in suppression of
            // audio chunks should end here, otherwise we'd silently swallow
            // the new reply too.
            this._bargedIn = false;
            return;
        }
        // User transcript — record into the local transcript only. With
        // server_vad active, xAI auto-creates the response itself; we do
        // NOT send response.create here or it produces a duplicate response.
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
            const text = msg.transcript;
            if (text) this._appendMessage({ role: "user", content: text });
            return;
        }
        // Barge-in: user started speaking while the assistant was talking.
        // In server-VAD mode (which we use), xAI handles the cancel itself
        // when speech_started fires — sending an explicit response.cancel
        // races with their internal handling and has been observed to drop
        // queued function_calls from the in-flight response. We just stop
        // local playback / drop speaking gestures so the avatar settles into
        // listening posture, mark _bargedIn so straggling audio chunks are
        // discarded, and let server VAD finish its own cancel cycle.
        if (msg.type === "input_audio_buffer.speech_started") {
            // User interrupted: abandon any owed tool reply. The tool's
            // function_call_output (if already sent) stays in history for the
            // next turn; server-VAD will create a fresh response for the new
            // utterance. Done unconditionally — the originating response may
            // already be done with only a slow tool still resolving.
            this._pendingToolReply = false;
            // Two reasons we might still be "talking" from the user's POV:
            //  1. Response is in flight (model still generating)
            //  2. Response is done server-side but local audio queue has
            //     more scheduled chunks that haven't finished playing
            //     (especially common after web_search / long replies).
            // Either case warrants stopping local audio.
            const audioStillPlaying = this._assistantAudioActive();
            if (this._responseInFlight || audioStillPlaying) {
                console.log(
                    "[voice] → barge-in",
                    this._responseInFlight
                        ? `(response ${this._currentResponseId} in flight, server-VAD will cancel)`
                        : "(audio tail)"
                );
                this._stopAssistantAudio();
                this.env.services.voice_avatar_renderer?.setSpeakingIntensity?.(0);
                this._responseInFlight = false;
                this._currentResponseId = null;
                this._assistantTranscriptInProgress = "";
                // Suppress any audio chunks still arriving for the cancelled
                // response. Cleared when a new response starts.
                this._bargedIn = true;
            }
            return;
        }
        // With server_vad turn detection, xAI auto-creates the response on
        // speech_stopped (per docs: "response.create is handled automatically
        // when using server-side VAD"). We deliberately do NOT call
        // _maybeCreateResponse here; doing so produces a second response in
        // parallel with xAI's auto-one. Same for `committed`.
        if (msg.type === "input_audio_buffer.speech_stopped" ||
            msg.type === "input_audio_buffer.committed") {
            return;
        }
        // Function call discovery: xAI puts the function `name` on the
        // response.output_item.{added,done} events (inside `item`), NOT on the
        // response.function_call_arguments.* events. Capture name+call_id when
        // the item is added so we have the mapping by the time arguments arrive.
        if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
            // Capture all three identifiers at the earliest event that carries
            // them — response.output_item.added has item.id, item.call_id, and
            // previous_item_id all in one place. _handleFunctionCall reads
            // them out by call_id when arguments.done fires later.
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
        // Final args event — dispatch via name we captured from output_item.added.
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
        // Fallback: response.output_item.done with type=function_call carries the
        // complete payload (name + arguments) in one shot. We dispatch from here
        // if the args.done event didn't, and we record dispatched call_ids so
        // a late-arriving args.done doesn't double-fire.
        if (msg.type === "response.output_item.done" && msg.item?.type === "function_call") {
            const item = msg.item;
            if (this._dispatchedCallIds?.has(item.call_id)) return;
            this._handleFunctionCall(item.call_id, item.name, item.arguments || "", {
                itemId: item.id || null,
                previousItemId: msg.previous_item_id || null,
            });
            return;
        }
        // MCP tool calls (server-side, fulfilled by xAI itself). We don't
        // dispatch — just record start/finish in the transcript so the user
        // sees what was called. Args/result deliberately omitted to keep the
        // transcript readable; xAI's own response chunk has the user-facing
        // answer derived from the tool result.
        //
        // xAI emits dedicated events for these (NOT generic output_item.added):
        //   response.mcp_call.in_progress  → start
        //   response.mcp_call.completed    → success
        //   response.mcp_call.failed       → error
        // The `name` field carries the tool (e.g. "odoo.read_group"); call_id
        // dedupes (just in case the event ever fires twice for the same call).
        // MCP call args streaming. We capture them so the transcript shows
        // the actual call (instead of `name(…)`) when in_progress fires.
        // `arguments` arrives as a JSON STRING — we keep it stringified so
        // it slots straight into the existing tool_call entry shape.
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
                // previous_item_id isn't on this event; will be back-filled
                // when conversation.item.added fires for the same item_id.
                xai_previous_item_id: null,
            });
            return;
        }
        if (msg.type === "response.mcp_call.completed" || msg.type === "response.mcp_call.failed") {
            const failed = msg.type === "response.mcp_call.failed";
            // Per spec, failure carries an error object: { type, message }.
            // Success carries the tool's actual output payload — surface it
            // so the accordion shows what the MCP tool returned, matching
            // how native/browser tool results are rendered.
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
        // MCP tool discovery — only the failure case is actionable for the
        // user. If xAI can't fetch the tool list (auth fail, network drop,
        // /mcp returning 5xx), the model runs without ANY of our Odoo
        // tools and silently answers from general knowledge instead. Surface
        // it loudly so the user knows the agent has no data access.
        if (msg.type === "mcp_list_tools.failed") {
            console.error("[voice] MCP tool discovery failed:", msg);
            const label = msg.server_label || _t("the MCP server");
            const errMsg = msg.error?.message || msg.error || msg.message || _t("unknown error");
            this.env.services.notification?.add?.(
                _t("Couldn't load tools from %s — %s. The agent won't be able to query your data this session.", label, errMsg),
                { type: "danger", sticky: true }
            );
            return;
        }
        // Errors — surface to the UI in addition to the console so the user
        // doesn't get stuck on "connecting" with no feedback.
        if (msg.type === "error") {
            // Spec fields: error.{type, code, message, param, event_id}.
            // event_id on the error refers to the CLIENT event that
            // triggered it (distinct from the outer msg.event_id which
            // identifies the error event itself). param identifies the
            // specific field at fault when applicable.
            const err = msg.error || {};
            const errType = err.type || "";
            const errCode = err.code || errType;
            const errMsg = err.message || msg.message || "xAI error";
            const causedByClientEventId = err.event_id;
            // Inactivity / stream-idle timeout — xAI's documented `timeout`
            // type, or the "stream idle timeout" message it emits after ~30s
            // of no chunk on the response stream (typically an internal hiccup
            // routing an MCP / tool call). Match the type explicitly since the
            // bare code/type "timeout" doesn't satisfy the idle-timeout regex.
            // The WebSocket stays alive and the session is recoverable: surface
            // a transient toast and reset the in-flight flags so the user can
            // speak again instead of being stuck on a red error banner.
            if (errType === "timeout"
                || /idle.?timeout/i.test(errMsg) || /idle.?timeout/i.test(errCode)) {
                console.warn("[voice] xAI idle timeout — recovering");
                this._responseInFlight = false;
                this.state.thinking = false;
                this._assistantTranscriptInProgress = "";
                this.env.services.notification?.add?.(
                    _t("The agent stalled mid-reply. Try rephrasing your request."),
                    { type: "warning" }
                );
                return;
            }
            console.error("[voice] xAI error", {
                type: errType,
                code: errCode,
                message: errMsg,
                param: err.param,
                causedByClientEventId,
                full: msg,
            });
            // max_duration is the one terminal error type in xAI's enum — the
            // conversation hit its configured maximum length and the server is
            // closing the socket. Tell the user plainly (the generic
            // "agent hit a problem" toast below would be misleading), then let
            // the imminent _onWsClose settle status/teardown. No status flip
            // here so we don't race that handler.
            if (errType === "max_duration") {
                this.state.thinking = false;
                this.env.services.notification?.add?.(
                    _t("This conversation reached its maximum length and is ending."),
                    { type: "info" }
                );
                return;
            }
            // A realtime `error` event is per-event, not session-ending: it
            // reports a problem with a single client event / response and the
            // WebSocket stays OPEN. _onWsClose is the sole authority on session
            // death. So if we're already live with an open socket, recover the
            // same way the idle-timeout branch does — reset the in-flight turn
            // flags and surface a transient toast — and crucially DON'T flip
            // state.status. Flipping it to "error" tore down the live UI (hid
            // the text box / End button) and, once dismissed, mislabeled the
            // session as "Ready", even though the mic worklet (gated on
            // muted/compacting, not status) kept streaming and the user could
            // still talk. Only treat the error as fatal when we're not yet live
            // or the socket is already gone — the original "don't get stuck on
            // connecting with no feedback" case.
            const wsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
            if (this.state.status === "live" && wsOpen) {
                console.warn("[voice] non-fatal xAI error during live session — staying live");
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
            // Not live (or socket already closed): surface the cause in the
            // blocking banner, including param / upstream event id when present
            // so the user has enough context to report or self-debug.
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
     *  and replay items have been sent, so the server processes audio
     *  with the correct VAD/voice/instructions config (xAI doc best
     *  practice: configure first, then flush buffered audio).
     *
     *  Flips _wsReady=true atomically with the buffer reassignment so the
     *  worklet's onmessage starts sending directly with no gap and no
     *  duplicate frames. JS is single-threaded — between the
     *  `this._earlyAudioBuffer = []` assignment and the for loop, no
     *  onmessage callback can interleave, so frame order is preserved.
     */
    _flushEarlyAudioBuffer() {
        const buffered = this._earlyAudioBuffer;
        this._earlyAudioBuffer = [];
        this._wsReady = true;
        if (buffered.length > 0) {
            console.log("[voice] flushing", buffered.length, "buffered audio frames");
            for (const base64 of buffered) {
                this._sendWs({ type: "input_audio_buffer.append", audio: base64 });
            }
        }
    }

    _onWsClose(ev) {
        if (this._sessionEnded) return;  // we initiated the close
        // Cookbook pattern (VoiceAgentConversation.webSocketDidClose): just
        // record the close in the UI. Don't recursively call end() — its
        // async teardown (queue flushes + /end RPC + audio teardown) races
        // with concurrent state transitions and leaves the service in
        // inconsistent states. The full cleanup happens either when the
        // user clicks End (endSession → voice.end) or implicitly on the
        // next start() (which destroys the leftover audio graph).
        this._sessionEnded = true;
        this.state.thinking = false;
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        const code = ev?.code;
        const reason = ev?.reason;
        const wasClean = ev?.wasClean;
        console.warn("[voice] WS closed unexpectedly", { code, reason, wasClean });
        if (wasClean) {
            this.state.status = "ended";
        } else {
            this.state.status = "error";
            this.state.errorMessage = reason
                ? _t("Voice connection closed (%s): %s", code ?? "?", reason)
                : _t("Voice connection closed (%s)", code ?? _t("unknown"));
        }
        this.state.tokenUsage = 0;
        // Best-effort flush of pending transcript appends so we don't lose
        // them on the server. Fire-and-forget: don't await — we're inside
        // the WS onclose callback and want to return quickly so any other
        // close-triggered handlers can run.
        this._flushAppendQueue?.().catch(() => {});
        this._flushMetaQueue?.().catch(() => {});
    }

    _sendWs(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }

    /** Trigger model response generation, idempotent per user turn. xAI uses
     *  multiple events to signal end-of-input (speech_stopped, committed,
     *  transcription.completed) and at least one fires reliably; we listen to
     *  all of them and dedupe via this flag. The flag clears when the model's
     *  response stream completes. */
    _maybeCreateResponse() {
        if (this._responseInFlight) return;
        this._responseInFlight = true;
        this.state.thinking = true;  // gap until the next audio/transcript chunk arrives
        console.log("[voice] → response.create");
        // modalities matches the xAI iOS cookbook pattern — we drive the
        // response explicitly here (typed text path), and the cookbook
        // passes ['text', 'audio'] on every manually-issued response.create
        // so the response is unambiguous regardless of xAI's defaults.
        this._sendWs({ type: "response.create", response: { modalities: ["text", "audio"] } });
    }

    /** Send the post-tool-call follow-up response — but only once BOTH
     *  preconditions hold:
     *    1. the originating response has fully completed (response.done →
     *       _responseInFlight false), and
     *    2. every tool's function_call_output has been submitted
     *       (!toolDispatcher.hasPending()).
     *
     *  Reacting to each tool's resolution individually (the old behaviour, and
     *  what xAI's quickstart documents) can fire response.create while the
     *  originating response is still active, or before a sibling parallel
     *  call's output is sent. xAI then rejects the duplicate or answers without
     *  the tool result — which surfaces as a "dropped" tool call. Gating on
     *  response.done mirrors how LiveKit (function channel closed on
     *  response.done → one generate_reply) and Pipecat (context-completion →
     *  one _create_response) drive the reply.
     *
     *  Called from BOTH the response.done handler and the last dispatch().then();
     *  whichever satisfies the final precondition wins. _pendingToolReply is
     *  claimed synchronously up front so the two callers can't double-fire
     *  across the audio-drain await. */
    async _maybeCreateToolReply() {
        if (!this._pendingToolReply) return;
        if (this._responseInFlight) return;             // originating response still streaming
        if (this.toolDispatcher?.hasPending()) return;  // tool outputs still in flight
        this._pendingToolReply = false;                 // claim it (idempotent vs. the racing caller)
        // Let the announcement audio ("one sec, let me check…") finish before
        // the answer so the two audio streams don't overlap — matches xAI's
        // guidance and LiveKit's speech-drain before the tool reply.
        await this._waitForAudioPlayback();
        if (this._bargedIn || this._sessionEnded) {
            // User interrupted (or session ended) while audio drained — drop
            // the reply. Server-VAD handles the user's new turn; the tool
            // output stays in history.
            return;
        }
        console.log("[voice] → response.create (post-tool)");
        // Route through the guarded helper so the response.create can't
        // duplicate one already in flight (checks + sets _responseInFlight).
        this._maybeCreateResponse();
    }

    /** Dispatch a single function call to the browser tool dispatcher and
     *  echo a tool_call message + tool_result message into the transcript.
     *
     *  Server-side xAI tools (web_search, x_search) are also surfaced to the
     *  client as function_call events even though xAI fulfils them itself.
     *  We must NOT send a function_call_output for those — doing so makes the
     *  dispatcher reply with "Unknown browser tool" which confuses the model
     *  on the first turn (it then redoes the call internally and succeeds).
     *  Just record the call in the transcript so the user can see it happened.
     */
    _handleFunctionCall(callId, name, argumentsJson, ids = {}) {
        if (!callId || !name) {
            console.warn("[voice] dropping malformed function call", { callId, name, argumentsJson });
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
            // xAI runs the search itself and feeds the result back into its own
            // response stream — the user sees it as part of the assistant's
            // next transcript chunk, no client-side fulfilment required.
            return;
        }
        // This turn now owes a follow-up response.create once the tool
        // round-trip completes. Latch it BEFORE dispatch so it's set no matter
        // how fast the handler resolves. Server-side tools (web_search /
        // x_search) returned above and never reach here — xAI continues their
        // response itself, so they need no manual reply.
        this._pendingToolReply = true;
        this.toolDispatcher
            ?.dispatch({ callId, name, argumentsJson })
            .then((result) => {
                try {
                    console.log("[voice] tool result", name, "→", result);
                    if (!SILENT_BROWSER_TOOLS.has(name)) {
                        // call_id is known immediately (we picked the value when
                        // sending function_call_output). The function_call_output
                        // item's own id and previous_item_id come back later via
                        // conversation.item.added — back-filled there.
                        this._appendMessage({
                            role: "tool_result",
                            content: JSON.stringify(result),
                            tool_name: name,
                            tool_result_json: JSON.stringify(result),
                            xai_call_id: callId,
                        });
                    }
                } catch (e) {
                    // Guard the transcript append so a throw here doesn't strand
                    // the turn — the gated reply attempt below still runs.
                    console.error("[voice] post-dispatch handling failed for", name, e);
                }
                // function_call_output was already sent by dispatch(). Attempt
                // the follow-up reply — it only fires once the originating
                // response.done has landed AND no tool outputs are still pending
                // (see _maybeCreateToolReply); if this isn't the last
                // precondition, response.done will trigger it instead.
                this._maybeCreateToolReply();
            })
            .catch((e) => {
                // dispatch() catches _invoke errors internally and resolves with
                // {error}, so reaching here means the chain itself blew up (e.g.
                // optional-chained dispatcher torn down mid-call). Still drive
                // the turn forward through the same gated path.
                console.error("[voice] dispatch promise rejected for", name, e);
                this._maybeCreateToolReply();
            });
    }

    /** Resolve once the assistant's queued audio has finished playing.
     *  With the onended-chained playback model we don't track a deadline;
     *  poll the queue + current source instead. Resolves immediately if
     *  nothing is queued, or after at most 10s (safety net against a
     *  stalled chunk). */
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

    _appendMessage(msg) {
        this.state.messages.push({
            ...msg,
            sequence: this.state.messages.length + 1,
        });
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
                // takes the max so retries are idempotent and out-of-order
                // RPCs can't roll the counter backwards.
                total_input_tokens: this._runningTokens.input,
                total_output_tokens: this._runningTokens.output,
            });
            // Server flagged the session for mid-session compaction (token
            // threshold crossed). We defer the actual restart until no
            // response is in flight — _maybeRunCompaction handles that
            // scheduling.
            if (resp && resp.needs_compaction) {
                this._compactionPending = true;
                // Front-load the summary generation: fire /compact in the
                // background NOW, while the user keeps talking and the
                // assistant keeps responding. The slow part (LLM
                // summarization, 1-5s) overlaps with the live
                // conversation. state.compacting stays false during this
                // phase — we only lock input later, briefly, for the WS
                // restart itself.
                //
                // Skip if a /compact is already in flight OR a rollup is
                // already sitting ready waiting for the safe-window
                // restart — kicking off another would be wasted work
                // (the server's SELECT FOR UPDATE would serialize it and
                // the second call would see needs_summary=False).
                if (!this._compactionPromise && !this._compactionRollupReady) {
                    this._compactionPromise = this._beginBackgroundCompaction();
                }
                this._maybeRunCompaction();
            }
            // Daily token cap signals from the server-side accrual. Hard
            // exceeded → end the session immediately. Soft warning → one
            // toast per session, tracked via tokenCapWarningShown.
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
            console.warn("[voice] append failed, will retry on next flush", e);
            // Re-queue messages so we don't lose them.
            this._pendingAppendQueue.unshift(...messages);
        }
    }

    /** Phase 1 of compaction: fire /compact in the background while the
     *  user keeps talking. Resolves the long-pole LLM summary call away
     *  from the user-visible restart window, so by the time we actually
     *  reconnect the WS in phase 2 the rollup is already on the server
     *  and the reconnect is a fast no-LLM operation (~300-500ms instead
     *  of 1-5s). */
    async _beginBackgroundCompaction() {
        const sessionId = this.state.sessionId;
        if (!sessionId) return null;
        try {
            const result = await rpc(`/api/voice/session/${sessionId}/compact`, {});
            if (!result || !result.compacted) {
                console.log("[voice] background compaction skipped:", result?.reason || "unknown");
                // Nothing to absorb / nothing flagged: clear the
                // pending flag so we don't busy-loop retrying a no-op.
                // A future /append crossing the threshold will re-arm.
                if (result?.reason === "nothing_absorbed" ||
                    result?.reason === "no_pending_summary" ||
                    result?.reason === "session_not_active") {
                    this._compactionPending = false;
                }
                this._compactionPromise = null;
                return result;
            }
            console.log("[voice] background compaction ready (rollup id", result.rollup_id +
                ") — awaiting safe restart window");
            this._compactionRollupReady = true;
            // The safe window may already be open (no response in flight,
            // assistant audio drained); kick the scheduler so we don't
            // have to wait for the next /append response or response.done
            // to actually trigger the restart.
            this._maybeRunCompaction();
            return result;
        } catch (e) {
            console.warn("[voice] background compaction failed:", e);
            // Re-arm by clearing the promise. The next /append flagging
            // needs_compaction will retry by allocating a new promise.
            this._compactionPromise = null;
            return null;
        }
    }

    /** Phase 2 of compaction: do the WS restart, but only when both
     *  (a) the background rollup is ready and (b) we hit a natural
     *  pause window — no response in flight, assistant audio fully
     *  drained, WS still open. Called opportunistically from /append
     *  responses, response.done, the assistant-audio queue drain, and
     *  _beginBackgroundCompaction's resolve. */
    _maybeRunCompaction() {
        if (!this._compactionPending) return;
        if (!this._compactionRollupReady) return;  // wait for background summary
        if (this._compacting) return;
        if (this._responseInFlight) return;  // wait until the model finishes its turn
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        // Wait for queued assistant audio to drain. response.done fires when
        // the model is done GENERATING, but PCM chunks remain queued for
        // another second or two; tearing down the WS mid-playback cuts off
        // the last syllables of the spoken line. The retry hook lives in
        // _enqueueAssistantAudio's onended handler — when the final chunk
        // finishes playing, it calls back into this method.
        if (this._assistantAudioActive()) return;
        this._compacting = true;
        this._compactionPending = false;
        // Lock input ONLY for the brief restart window — the long
        // background summary phase ran with the user freely talking.
        this.state.compacting = true;
        this._restartForCompaction()
            .catch((e) => {
                console.warn("[voice] compaction restart failed:", e);
                // Re-arm so the next /append can retry. Without this,
                // a transient restart failure permanently disables
                // compaction for the session.
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
     *  the session record, then call start() in resume mode to mint a
     *  fresh xAI token, reopen the socket, and seed history from replay
     *  items. The summary itself was already generated and persisted
     *  by _beginBackgroundCompaction; this restart is the cheap part.
     *
     *  Why this beats in-place WebSocket compaction (item.delete +
     *  item.create) for our setup:
     *    * xAI's MCP integration items hit "Item not found" when we tried
     *      to delete them — they live in a parallel namespace managed by
     *      xAI's server-side MCP plumbing.
     *    * The replay path already produces the exact post-compaction
     *      shape we want (summary + recent verbatim + tool history with
     *      proper call_id correlation), so a fresh resume gives us that
     *      for free.
     *    * A new WebSocket starts with a clean prompt cache prefix —
     *      better cache hit rate after the rollup.
     *  The user-visible window is now ~300-500ms (the WS reconnect)
     *  instead of 1-5s, because the LLM summary call was front-loaded
     *  into the background phase. The transcript is NEVER cleared
     *  during the restart — state.messages already holds the full
     *  conversation history locally, and the compacted replay_items
     *  feed only goes to xAI (not the UI). */
    async _restartForCompaction() {
        const sessionId = this.state.sessionId;
        const agentId = this.lastAgentId || this.state.agentId;
        if (!sessionId || !agentId) {
            console.warn("[voice] compaction restart aborted: missing session or agent id");
            return;
        }
        console.log("[voice] applying compacted context — restarting WS");

        // Preserve mute state so the user's mic preference survives
        // the restart (start() resets state on a normal start path).
        const savedMuted = this.state.muted;

        // Close the WebSocket and tear down audio, but DO NOT call
        // /end (that would mark the session record as ended).
        this._closeWsOnly();

        // Resume the same session — start_session rebuilds replay_items
        // from is_summarized_into=False rows (the compacted view for
        // xAI), mints a fresh ephemeral token, and the existing
        // _onWsOpen flow seeds the new WS via conversation.item.create.
        // The isCompactionRestart flag tells start() to leave
        // state.messages alone so the user's visible transcript is
        // never interrupted.
        await this.start(agentId, sessionId, true);

        this.state.muted = savedMuted;
    }

    /** Tear down the active WebSocket + audio plumbing without touching
     *  the server-side session record. Used by the compaction restart
     *  path — leaves session.state='active' so start() can resume it. */
    _closeWsOnly() {
        // Cancel any in-flight assistant audio so the new connection
        // doesn't overlap with leftover playback.
        this._stopAssistantAudio();
        this._responseInFlight = false;
        this.state.thinking = false;
        // Drop tool-call tracking — the resumed session uses fresh call_ids
        // and a stuck _invoke from the prior socket would otherwise leave
        // hasPending() permanently true, blocking response.create.
        this.toolDispatcher?.clearPending?.();
        this.pendingFunctionCalls?.clear?.();
        this._dispatchedCallIds?.clear?.();
        this._mcpCallArgs?.clear?.();

        // Flush queued appends + meta so we don't lose state across the
        // reconnect. Same order as end() — appends first (creates rows),
        // then meta patches (back-fill against rows that now exist).
        if (this._appendFlushTimer) {
            clearTimeout(this._appendFlushTimer);
            this._appendFlushTimer = null;
        }
        // Fire-and-forget: don't await, the calls are idempotent and a
        // small delay before the new session opens is fine.
        this._flushAppendQueue();
        if (this._metaFlushTimer) {
            clearTimeout(this._metaFlushTimer);
            this._metaFlushTimer = null;
        }
        this._flushMetaQueue();

        if (this.ws) {
            // Detach handlers BEFORE closing. Otherwise _onWsClose fires
            // on our intentional close, sees _sessionEnded=false (we want
            // to keep the session record alive across the restart), and
            // calls end("ws-close") — which marks the session ended on
            // the server, breaking the resume that follows.
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.onopen = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { /* swallow */ }
            }
        }
        this.ws = null;
        if (this.micProcessor) {
            try { this.micProcessor.disconnect(); } catch (e) { /* swallow */ }
            this.micProcessor = null;
        }
        if (this.micStream) {
            for (const track of this.micStream.getTracks()) track.stop();
            this.micStream = null;
        }
        if (this.lipsyncUnsub) {
            this.lipsyncUnsub();
            this.lipsyncUnsub = null;
        }
        this.env.services.voice_lipsync?.disconnect();
        if (this.assistantPlaybackNode) {
            try { this.assistantPlaybackNode.disconnect(); } catch (e) { /* swallow */ }
            this.assistantPlaybackNode = null;
        }

        // Brief "ended" status so the start() gate (which refuses to
        // start over a non-idle status) lets us proceed. start() will
        // immediately flip status to "connecting" then "live".
        this.state.status = "ended";
    }

    /** Queue a back-fill patch for a row already created via /append.
     *  Keyed by call_id so repeated conversation.item.added events for the
     *  same call collapse — newer non-null fields win. Debounced flush
     *  reuses the same 1.5s window as the main append queue. */
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
            console.warn("[voice] append-meta failed, will retry on next flush", e);
            // Re-stage the patches (latest values still authoritative).
            for (const p of patches) {
                if (!this._pendingMetaPatches.has(p.call_id)) {
                    this._pendingMetaPatches.set(p.call_id, p);
                }
            }
        }
    }

    /** Mic track ended outside our control (device disconnect, OS perm
     *  revoke, browser tab muted). We've already stopped the track from
     *  the device's perspective, so just disconnect the audio graph and
     *  flip the UI into muted state. The next setMuted(false) call will
     *  re-prompt for permission and rebuild via _startMic. */
    _onMicTrackEnded(track) {
        // Guard: we tear down the worklet + stream from _destroyAudioGraph
        // / _closeWsOnly too, which fires this same event. Only act when
        // it's the still-live stream that lost its track.
        if (!this.micStream || !this.micStream.getTracks().includes(track)) return;
        if (this._sessionEnded) return;
        console.warn("[voice] mic track ended unexpectedly — going muted");
        if (this.micProcessor) {
            try { this.micProcessor.disconnect(); } catch (_) { /* swallow */ }
            this.micProcessor = null;
        }
        // Tracks already ended; calling stop on the dead one is a no-op
        // but releases any sibling tracks the browser keeps in the stream.
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

    /** Toggle mic mute. Unmuting lazy-prompts for mic permission if the user
     *  declined (or never saw the prompt) at session start. If they decline
     *  again, the state stays muted — _startMic() handles the messaging. */
    async setMuted(muted) {
        if (!muted && !this.micProcessor) {
            const ok = await this._startMic();
            if (!ok) return;  // permission denied again; stay muted
        }
        this.state.muted = !!muted;
    }

    /** Inject a typed user message into the live conversation. The model still
     *  replies with voice (modalities aren't restricted), so this lets the user
     *  silently type a turn while audio replies stream back. Mirrors xAI's
     *  conversation.item.create shape used by replay (services/voice_session_service.py:139). */
    sendText(text) {
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
        // this window would either be dropped or arrive in a half-rebuilt
        // session. The text input is also disabled in the templates while
        // compacting; this is the belt-and-braces guard for keyboard
        // shortcuts or programmatic callers.
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
            const cancelMsg = { type: "response.cancel" };
            if (this._currentResponseId) cancelMsg.response_id = this._currentResponseId;
            console.log("[voice] → response.cancel (typed-input)", this._currentResponseId);
            this._sendWs(cancelMsg);
            this._stopAssistantAudio();
            this.env.services.voice_avatar_renderer?.setSpeakingIntensity?.(0);
            this._responseInFlight = false;
            this._assistantTranscriptInProgress = "";
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
        this._maybeCreateResponse();
        return true;
    }

    async end(reason = "client") {
        if (this._sessionEnded) return;
        this._sessionEnded = true;
        this.state.status = "ending";
        this.state.thinking = false;
        // If the session ends (or the WS dies, which routes here via
        // _onWsClose) while a compaction was pending or in flight, clear
        // the flag so the disabled-input UX doesn't outlive the session.
        // The background /compact promise (if any) is left to settle on
        // its own — the rollup row it creates is harmless and useful for
        // the next resume.
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
        // Drop tool-call tracking so any in-flight dispatch doesn't leak
        // state into the next session if the same singleton service is
        // reused for a fresh start().
        this.toolDispatcher?.clearPending?.();
        this.pendingFunctionCalls?.clear?.();
        this._dispatchedCallIds?.clear?.();
        this._mcpCallArgs?.clear?.();
        this._stopAssistantAudio();
        // A response may still be "in flight" when the user ends mid-reply.
        // We deliberately don't send response.cancel — the socket is about to
        // close and xAI tears the response down on disconnect. But these flags
        // must NOT survive into the next session: the service is a singleton,
        // and a stale _responseInFlight made the resumed session's next typed
        // turn fire a bogus response.cancel ("Cancellation failed: no active
        // response found", since that response lived in the now-dead session).
        // start() also clears these defensively; resetting here keeps the
        // "ending" state self-consistent.
        this._responseInFlight = false;
        this._currentResponseId = null;
        this._assistantTranscriptInProgress = "";
        this._bargedIn = false;
        // Flush any pending appends before ending. Order matters: append
        // creates the rows, append-meta back-fills ids on them — flushing
        // meta first against rows that don't exist yet would silently no-op.
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
            // Detach handlers BEFORE closing — otherwise a still-pending
            // ws.onopen (user clicked End mid-connect, or the socket opened
            // just as we decided to tear down) can fire after end() has
            // settled status to "ended" and clobber it back to "live",
            // leaving the End button visible while this.ws is already
            // nulled and the mic worklet silently drops every chunk.
            // _closeWsOnly does the same dance for the compaction path.
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { /* swallow */ }
            }
        }
        this.ws = null;
        // Fully rebuild the audio graph (close AudioContext, drop the
        // worklet module flag, release mic, detach lipsync). The cookbook
        // does the equivalent (rebuilds AVAudioEngine per session) and
        // this closes the page-reload-fixes-it class of bug where stale
        // AudioContext state survived End → Connect.
        await this._destroyAudioGraph();
        // Lipsync was detached inside _destroyAudioGraph (it drove setVowels /
        // setSpeakingIntensity every frame), so this reset won't be clobbered
        // by a straggling frame. Without it, ending mid-speech freezes the
        // avatar on its last viseme with the mouth hanging open. resetExpression
        // zeroes vowels, speaking intensity, and emotion back to a neutral idle.
        this.env.services.voice_avatar_renderer?.resetExpression?.();

        if (this.state.sessionId) {
            try {
                await rpc(`/api/voice/session/${this.state.sessionId}/end`, {
                    reason,
                    // Send the final running totals even if the last
                    // _flushAppendQueue hasn't fired — without this the
                    // session record would only reflect tokens up to the
                    // most recent debounced flush, missing whatever
                    // accumulated in the final 1.5s window.
                    total_input_tokens: this._runningTokens.input,
                    total_output_tokens: this._runningTokens.output,
                });
            } catch (e) {
                console.warn("[voice] /end failed:", e);
            }
        }
        // Reset the budget counter to 0 / limit so the header reads as a
        // fresh slate after End, instead of freezing on the last running
        // value. Keep tokenLimit untouched so the "/ 40,000" stays visible.
        // _runningTokens / _tokensAtLastSummary are wiped in start() on the
        // next connect, so no internal state leak.
        this.state.tokenUsage = 0;
        this.state.status = "ended";
    }

    _fail(message) {
        this.state.status = "error";
        this.state.errorMessage = message;
        this._sessionEnded = true;
        // Don't leave stale token-budget numbers visible when the session
        // never came up; the next successful start() will repopulate them.
        this.state.tokenUsage = 0;
        this.state.tokenLimit = 0;
        // Drop any in-flight compaction state so a failed start doesn't
        // leave the input lockout stuck on after the user dismisses the
        // error and reconnects.
        this.state.compacting = false;
        this._compactionPending = false;
        this._compactionRollupReady = false;
        this._compactionPromise = null;
    }
}

// ---- Helpers ----

function floatToPcm16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
}

function pcm16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }
    return out;
}

function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

export { VoiceService };
