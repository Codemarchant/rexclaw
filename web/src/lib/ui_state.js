// Cross-component UI chrome state. Kept separate from the voice service's
// reactive `state` so the app header doesn't re-render on every transcript /
// token tick — only when immersive mode actually toggles.
import { reactive } from "./reactive";
import { notification } from "./notification";
import { _t } from "./i18n";

// Mascot mode: this window was opened by the desktop shell as a frameless
// transparent always-on-top overlay (/#mascot or /#mascot-resume). Fixed for
// the window's lifetime — a reload keeps the mode (the hash stays put; only
// the -resume suffix is consumed after it triggers).
export const MASCOT_MODE = /^#mascot/.test(window.location.hash);

// Transcript-mirror mode: a standalone window (Electron tray or a second
// browser tab on /#transcript) that mirrors the live call's transcript via
// BroadcastChannel. Like MASCOT_MODE, fixed for the window's lifetime.
export const TRANSCRIPT_MODE = /^#transcript/.test(window.location.hash);

export const uiState = reactive({
    // Immersive mode: hide the app header AND all in-canvas controls for a
    // pure full-screen avatar. Paired with the browser Fullscreen API so the
    // browser chrome goes too and native Esc exits cleanly.
    immersive: false,
    // Cross-tab handoff from the Sessions tab: requestedTab switches the app
    // tab (App consumes + clears it); pendingResume {mode, sessionId, agentId}
    // is picked up by the target Voice/Chat view, which owns the live-session
    // plumbing and resumes once it becomes active.
    requestedTab: null,
    pendingResume: null,
});

export function exitImmersive() {
    uiState.immersive = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

export function toggleImmersive() {
    if (uiState.immersive) {
        exitImmersive();
        return;
    }
    uiState.immersive = true;
    notification.add(_t("Immersive view — press Esc or H to exit."), { type: "info", duration: 3000 });
    // Best-effort real fullscreen; if denied, the UI is still hidden and the
    // Esc/H handlers in VoiceView still restore it.
    document.documentElement.requestFullscreen?.().catch(() => {});
}
