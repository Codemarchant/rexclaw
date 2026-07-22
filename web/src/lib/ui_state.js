// Cross-component UI chrome state. Kept separate from the voice service's
// reactive `state` so the app header doesn't re-render on every transcript /
// token tick — only when immersive mode actually toggles.
import { reactive } from "./reactive";
import { notification } from "./notification";
import { _t } from "./i18n";

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
