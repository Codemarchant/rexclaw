import { reactive } from "../lib/reactive";

/**
 * Reactive store for the active voice conversation. Components read from this; the
 * voice_service writes to it as transcripts arrive over the WebSocket.
 */
export function makeConversationState() {
    return reactive({
        // High-level UI state
        status: "idle",         // idle | connecting | live | paused | ending | ended | error
        muted: false,
        thinking: false,        // true between user-end-of-turn / tool dispatch and the next assistant chunk
        replayMode: false,
        compacting: false,      // true while the session is being torn down + resumed for context compaction
        errorMessage: null,

        // Session identity
        sessionId: null,
        agentId: null,
        agentName: null,
        avatar: null,           // dict with vrm_url, expression_map, etc. (null if no avatar)
        voice: null,

        // UI: systray side panel open/closed. Lives on the shared service
        // state (not the systray's local state) so the full_view can reopen
        // the panel after Minimize, and any other component can drive it.
        sidePanelOpen: false,

        // Compaction budget. tokenUsage is the running total since the last
        // summary rollup (matches the server-side delta that triggers
        // compaction); tokenLimit is the configured threshold. The status
        // bar renders these as `usage / limit` so the user can see how
        // close the session is to the next auto-compact.
        tokenUsage: 0,
        tokenLimit: 0,

        // Daily-cap warning latch. Set to true the first time the server
        // returns cap_warning on an /append response so the toast only
        // fires once per session. Reset in voice_service.start().
        tokenCapWarningShown: false,

        // Live transcript: ordered list of { role, content, sequence, toolName?, toolArgs?, toolResult? }
        // In group calls assistant rows also carry `speaker` (agent name) so
        // the transcript can label who said what; peer speech is mirrored in
        // with `mirrored: true` (display-only — it persists on the peer's
        // own session, not this one).
        messages: [],

        // Group call roster (primary store only): one entry per agent added
        // to the call — { connId, agentId, agentName, status }. The full
        // view renders these as removable chips next to the call controls.
        peers: [],

        // True when the server capped transcript_history on resume — set
        // from start_session's transcript_truncated flag, used by the
        // Transcript component to render a subtle "Earlier messages not
        // shown" note at the top. Older messages live on in the DB; only
        // the UI payload is sliced.
        transcriptTruncated: false,
        // Text mode: the live response chain carries an older system prompt
        // than a fresh one would (persona/prompt/memory changed since it
        // opened) — offers the "refresh prompt" action. Server-computed.
        promptStale: false,

        // Mouth shape state (lipsync writes here, avatar canvas reads)
        vowels: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
        emotion: "neutral",
        speakingIntensity: 0,   // 0..1, used as a master mouth-open level

        // Active outfit. 0 = the avatar's default VRM; other values are
        // outfit record ids embedded in `avatar.outfits`. Lives on the
        // shared reactive store so the dropdown picker, full view, side
        // panel, AND the change_outfit tool dispatcher all read/write the
        // same value — any of them updating it re-renders the others.
        selectedOutfitId: 0,

        // Active background payload. Either an avatar.backgrounds[] entry
        // (type='static'|'image') or a synthetic Imagine background
        // (type='imagine', image_url set). null = renderer falls back to the
        // SCSS default. Driven by /voice/session/start's active_background,
        // the change_background tool's post-result hook, and the fullscreen
        // background picker.
        activeBackground: null,

        // True once the user explicitly picks a background in the fullscreen
        // dropdown (including the synthetic "Default" entry). Session start
        // then KEEPS that pick instead of applying the server-resolved
        // active_background — same philosophy as the outfit guard in
        // voice_service.start(). Reset whenever the avatar changes, so a new
        // character boots from its own defaults again.
        backgroundPickedByUser: false,

        // Affection meter. `affection` is the server payload from
        // session/start ({score, level, max_score, max_level}), or null when
        // the companion's meter is disabled — it drives the fullscreen
        // readout. The adjust_affection tool's post-result hook updates it
        // live and stamps `affectionPulse` ({delta, score, at}) to run the
        // heart effect; the dispatcher clears the pulse after the animation.
        affection: null,
        affectionPulse: null,

        // Per-agent map of the most recently generated Imagine background
        // within this session. Keyed by agent id; value is the same payload
        // shape pushed into activeBackground. Used so the background picker
        // can surface "the Imagine bg you just made for Eve" again after the
        // user switches to a different agent and back — the server payload's
        // agent.latest_imagine_background is a session-start snapshot and
        // doesn't reflect mid-session generations.
        latestImagineBackgroundByAgent: {},
        // Same idea for animated (video) Imagine backgrounds — a parallel
        // "latest" track so the picker offers both the newest still and the
        // newest animated backdrop.
        latestImagineVideoBackgroundByAgent: {},
    });
}
