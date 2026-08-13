// Shared between the mascot overlay page (/#mascot) and its settings window
// (/#mascot-settings). A lib module rather than exports on either component,
// so the two never import each other.

// BroadcastChannel the two pages talk over. The overlay owns the state and
// publishes {type:"state", ...} snapshots — on every change and in answer to
// the window's {type:"request"} pings, which double as its liveness probe;
// the window sends back {type:"set"|"size"|"outfit"} commands.
export const MASCOT_SETTINGS_CHANNEL = "rexclaw-mascot-settings";

// Window sizes the island's ⤢ button (and the settings window's presets)
// cycle through (bottom-right corner anchored by the shell). Portrait
// 2:3-ish — a standing character's natural frame. The old 280×420 step is
// gone (it clipped the controls island); the two big steps mainly serve
// full-body view, and the shell clamps them to the screen's work area on
// smaller displays. Scroll on the avatar still gives fine-grained sizing
// between the presets.
export const MASCOT_SIZES = [
    { width: 380, height: 560 },
    { width: 480, height: 700 },
    { width: 620, height: 900 },
    { width: 760, height: 1100 },
];
