// Keyboard shortcuts.
//
// One catalog of named ACTIONS with default key combos, bound to handlers by
// whichever view owns them (VoiceView owns the call, MascotView owns the
// overlay). Two delivery paths feed the same dispatcher:
//
//   * in-page — a window keydown listener, the only path a plain browser has;
//   * OS-wide — the Electron shell registers each combo with globalShortcut
//     and sends the action back to whichever window owns the call.
//
// The desktop app needs the second path: the mascot overlay is normally
// unfocused (in ghost mode it can't even be clicked), so a page-level key
// handler would never see the keystroke. When global shortcuts are on, the
// in-page listener stands down — a focused window would otherwise run every
// action twice, and two toggles are one no-op.
//
// Bindings live in the server config (one JSON blob) so every window and
// browser agrees on them; an unset action falls back to the default below,
// and an empty string means the user deliberately unbound it.
import { reactive } from "./reactive";
import { rpc } from "./rpc";
import { _t } from "./i18n";

export const HOTKEY_GROUPS = [
    { id: "call", label: "Call" },
    { id: "mascot", label: "Desktop avatar" },
    { id: "app", label: "App window" },
];

// `desktop: true` marks actions the Electron shell provides — they are shown
// greyed in a plain browser, where there is no overlay window to steer.
// The corner combos deliberately mirror a numpad's layout (7/9 top, 1/3
// bottom), so the key you press points at the screen corner you mean.
export const HOTKEY_ACTIONS = [
    // The two call keys are TOGGLES — idle: start; live: end. A dedicated
    // end key was removed because a start key pressed mid-call was a dead
    // press anyway (the service refuses); folding end into it gives every
    // press a meaning and halves what there is to remember.
    {
        id: "call.startOrResume", group: "call", combo: "Ctrl+Alt+C",
        label: "Resume the last call / end the call",
        hint: "No call: picks the conversation back up where it left off (or starts fresh when there is nothing to resume). In a call: ends it.",
    },
    {
        id: "call.startNew", group: "call", combo: "Ctrl+Alt+N",
        label: "Start a new conversation / end the call",
        hint: "No call: begins from scratch, without resuming (and without replaying history to xAI). In a call: ends it.",
    },
    {
        id: "call.toggleMute", group: "call", combo: "Ctrl+Alt+M",
        label: "Mute / unmute the microphone",
        hint: "Muting does not reduce what xAI charges — a connected call bills by the minute either way.",
    },
    {
        id: "call.screenShare", group: "call", combo: "Ctrl+Alt+S",
        label: "Start / stop screen sharing",
        hint: "Picking a screen needs a click, so the first use opens the picker rather than sharing outright.",
    },
    {
        id: "mascot.toggle", group: "mascot", combo: "Ctrl+Alt+D", desktop: true,
        label: "Pop the avatar out / back in",
        hint: "The same handoff as the pop-out button: a live call is ended and resumed in the other window.",
    },
    {
        id: "mascot.ghost", group: "mascot", combo: "Ctrl+Alt+G", desktop: true,
        label: "Ghost mode (clicks pass through)",
    },
    {
        id: "mascot.controls", group: "mascot", combo: "Ctrl+Alt+K", desktop: true,
        label: "Show / hide the avatar controls",
    },
    {
        id: "mascot.pin", group: "mascot", combo: "Ctrl+Alt+T", desktop: true,
        label: "Always on top",
    },
    {
        id: "mascot.size", group: "mascot", combo: "Ctrl+Alt+Z", desktop: true,
        label: "Cycle the window size",
    },
    {
        id: "mascot.fullBody", group: "mascot", combo: "Ctrl+Alt+B", desktop: true,
        label: "Face view / full body",
    },
    {
        id: "mascot.cornerTopLeft", group: "mascot", combo: "Ctrl+Alt+7", desktop: true,
        label: "Move to the top-left corner",
    },
    {
        id: "mascot.cornerTopRight", group: "mascot", combo: "Ctrl+Alt+9", desktop: true,
        label: "Move to the top-right corner",
    },
    {
        id: "mascot.cornerBottomLeft", group: "mascot", combo: "Ctrl+Alt+1", desktop: true,
        label: "Move to the bottom-left corner",
    },
    {
        id: "mascot.cornerBottomRight", group: "mascot", combo: "Ctrl+Alt+3", desktop: true,
        label: "Move to the bottom-right corner",
    },
    {
        id: "mascot.nextDisplay", group: "mascot", combo: "Ctrl+Alt+5", desktop: true,
        label: "Move to the next monitor",
        hint: "Keeps the corner it is parked in; cycles back to the first monitor after the last.",
    },
    {
        id: "app.immersive", group: "app", combo: "Ctrl+Alt+I",
        label: "Immersive view (hide all UI)",
        hint: "H on its own does the same thing while the Voice tab has focus.",
    },
    {
        id: "app.transcriptWindow", group: "app", combo: "Ctrl+Alt+W",
        label: "Open the transcript window",
    },
];

const ACTION_BY_ID = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a]));

export const hotkeyState = reactive({
    // action id → combo. Only entries that differ from the default are held
    // here (an explicit "" is an unbind, which is why absent ≠ empty).
    bindings: {},
    globalEnabled: true,
    loaded: false,
    // Accelerators the OS refused to hand over (another app already owns
    // them) — surfaced in Settings so a dead shortcut is explainable.
    globalFailures: [],
});

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------
// Canonical form is an Electron accelerator we can also match in the browser:
// modifiers in a fixed order, then one key name — "Ctrl+Alt+M", "Ctrl+Shift+F5".

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"];

const MODIFIER_ALIASES = {
    ctrl: "Ctrl", control: "Ctrl", cmdorctrl: "Ctrl", commandorcontrol: "Ctrl",
    alt: "Alt", option: "Alt", altgr: "Alt",
    shift: "Shift",
    super: "Super", meta: "Super", cmd: "Super", command: "Super", win: "Super",
};

// KeyboardEvent.code → accelerator key name, for the keys worth binding.
// Deliberately code-based: the physical key is what the OS-level shortcut
// registers, so a layout that moves letters around still agrees with itself.
const NAMED_KEYS = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Space: "Space", Escape: "Esc", Enter: "Return", Tab: "Tab",
    Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    NumpadAdd: "numadd", NumpadSubtract: "numsub",
    NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
};

/** KeyboardEvent → accelerator key name, or null for a bare modifier press
 *  (which is a combo still being typed, not a combo). */
function keyNameFromEvent(ev) {
    const code = ev.code || "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return "num" + code.slice(6);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return NAMED_KEYS[code] || null;
}

/** Parse an accelerator into {mods:Set, key} — null when it names no key. */
function parseCombo(combo) {
    const parts = String(combo || "").split("+").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const mods = new Set();
    let key = null;
    for (const part of parts) {
        const mod = MODIFIER_ALIASES[part.toLowerCase()];
        if (mod) {
            mods.add(mod);
        } else {
            key = part.length === 1 ? part.toUpperCase() : part;
        }
    }
    return key ? { mods, key } : null;
}

/** Canonical spelling of a combo ("alt+ctrl+m" → "Ctrl+Alt+M"), or "" when
 *  it doesn't parse. */
export function normalizeCombo(combo) {
    const parsed = parseCombo(combo);
    if (!parsed) return "";
    return [...MODIFIER_ORDER.filter((m) => parsed.mods.has(m)), parsed.key].join("+");
}

/** The combo a keydown expresses, or "" while only modifiers are held. */
export function comboFromEvent(ev) {
    const key = keyNameFromEvent(ev);
    if (!key) return "";
    const mods = [];
    if (ev.ctrlKey) mods.push("Ctrl");
    if (ev.altKey) mods.push("Alt");
    if (ev.shiftKey) mods.push("Shift");
    if (ev.metaKey) mods.push("Super");
    return [...mods, key].join("+");
}

/** Human-readable rendering — the platform's own modifier glyphs on a Mac. */
export function formatCombo(combo) {
    const parsed = parseCombo(combo);
    if (!parsed) return "";
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
    const label = {
        Ctrl: mac ? "⌃" : "Ctrl", Alt: mac ? "⌥" : "Alt",
        Shift: mac ? "⇧" : "Shift", Super: mac ? "⌘" : "Win",
    };
    const mods = MODIFIER_ORDER.filter((m) => parsed.mods.has(m)).map((m) => label[m]);
    return [...mods, parsed.key].join(mac ? "" : "+");
}

/** A combo safe to hand to the OS: a bare letter registered globally would
 *  swallow that key in every other application. Modifier-less function keys
 *  are allowed — that's what they're for. */
export function comboNeedsModifier(combo) {
    const parsed = parseCombo(combo);
    if (!parsed) return false;
    if (parsed.mods.size) return false;
    return !/^F([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** Every action's live combo, defaults filled in. Unbound actions map to "". */
export function effectiveBindings(bindings = hotkeyState.bindings) {
    const out = {};
    for (const action of HOTKEY_ACTIONS) {
        out[action.id] = Object.prototype.hasOwnProperty.call(bindings, action.id)
            ? normalizeCombo(bindings[action.id])
            : action.combo;
    }
    return out;
}

export function comboFor(actionId) {
    return effectiveBindings()[actionId] || "";
}

/** Actions bound to the same combo — a duplicate makes one of them dead, so
 *  Settings flags it rather than silently picking a winner. */
export function conflictingActions(bindings = hotkeyState.bindings) {
    const seen = new Map();
    for (const [id, combo] of Object.entries(effectiveBindings(bindings))) {
        if (!combo) continue;
        seen.set(combo, [...(seen.get(combo) || []), id]);
    }
    const clashing = new Set();
    for (const ids of seen.values()) {
        if (ids.length > 1) ids.forEach((id) => clashing.add(id));
    }
    return clashing;
}

/** Adopt a binding set (from a settings save or the initial config load) and
 *  re-register the OS-wide shortcuts. */
export function applyHotkeys({ bindings, globalEnabled }) {
    if (bindings) hotkeyState.bindings = { ...bindings };
    if (globalEnabled !== undefined) hotkeyState.globalEnabled = !!globalEnabled;
    syncShellHotkeys();
}

/** Pull the stored bindings from the server config. Safe to call from every
 *  window — each page instance registers its own listener. */
export async function loadHotkeys() {
    try {
        const cfg = await rpc("/api/config/get", {});
        let bindings = {};
        if (cfg.hotkeys_json) {
            try {
                const parsed = JSON.parse(cfg.hotkeys_json);
                if (parsed && typeof parsed === "object") bindings = parsed;
            } catch (e) {
                console.warn("[hotkeys] stored bindings are not valid JSON — using defaults");
            }
        }
        hotkeyState.bindings = bindings;
        hotkeyState.globalEnabled = !!cfg.hotkeys_global_enabled;
    } catch (e) {
        console.warn("[hotkeys] could not load bindings", e);
    } finally {
        hotkeyState.loaded = true;
        syncShellHotkeys();
    }
}

/** Hand the shell the list it should register OS-wide (empty when global
 *  shortcuts are off, which also unregisters whatever was live). */
function syncShellHotkeys() {
    const bridge = typeof window !== "undefined" ? window.rexclawDesktop : null;
    if (!bridge?.setGlobalHotkeys) return;
    const list = hotkeyState.globalEnabled
        ? Object.entries(effectiveBindings())
            .filter(([, combo]) => combo)
            .map(([action, accelerator]) => ({ action, accelerator }))
        : [];
    Promise.resolve(bridge.setGlobalHotkeys(list))
        .then((res) => { hotkeyState.globalFailures = res?.failed || []; })
        .catch(() => {});
}

/** Temporarily hand every accelerator back to the OS — the settings editor
 *  does this while recording, so pressing a combo to rebind it doesn't also
 *  fire whatever it is bound to today. */
export function pauseGlobalHotkeys() {
    const bridge = typeof window !== "undefined" ? window.rexclawDesktop : null;
    Promise.resolve(bridge?.setGlobalHotkeys?.([])).catch(() => {});
}

/** Re-register from the last APPLIED bindings (not whatever is being edited). */
export function resumeGlobalHotkeys() {
    syncShellHotkeys();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const handlers = new Map();

/** Register this view's action handlers. Returns the unregister function, so
 *  a React effect can `return registerHotkeyHandlers({...})`. Only one view
 *  per window owns a given action (the mascot page and the main page never
 *  run together), so a plain last-wins map is enough. */
export function registerHotkeyHandlers(map) {
    for (const [id, fn] of Object.entries(map)) {
        if (fn) handlers.set(id, fn);
    }
    return () => {
        for (const [id, fn] of Object.entries(map)) {
            if (handlers.get(id) === fn) handlers.delete(id);
        }
    };
}

/** Run an action. Anything this page doesn't handle (window placement, the
 *  pop-out handoff, the transcript window) belongs to the shell. */
export function runHotkeyAction(actionId) {
    const fn = handlers.get(actionId);
    if (fn) {
        try {
            fn();
        } catch (e) {
            console.error(`[hotkeys] action ${actionId} failed`, e);
        }
        return true;
    }
    const bridge = typeof window !== "undefined" ? window.rexclawDesktop : null;
    if (bridge?.runHotkeyAction && ACTION_BY_ID.has(actionId)) {
        bridge.runHotkeyAction(actionId);
        return true;
    }
    return false;
}

/** Start this page's hotkey plumbing: the shell's action feed plus the
 *  in-page keydown listener. Call once per page instance. */
export function startHotkeys() {
    const bridge = typeof window !== "undefined" ? window.rexclawDesktop : null;
    bridge?.onHotkeyAction?.((actionId) => {
        const fn = handlers.get(actionId);
        // No handler here means the action belongs to a window that isn't
        // this one — dropping it beats bouncing it back to the shell, which
        // routed it here in the first place.
        if (fn) runHotkeyAction(actionId);
    });

    const onKeyDown = (ev) => {
        // While the shell holds these combos OS-wide, the page must stay out
        // of the way: a focused window sees the keystroke too, and running
        // the action twice undoes it.
        if (bridge?.setGlobalHotkeys && hotkeyState.globalEnabled) return;
        if (ev.repeat) return;
        const t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const combo = comboFromEvent(ev);
        if (!combo) return;
        const bindings = effectiveBindings();
        const actionId = Object.keys(bindings).find((id) => bindings[id] === combo);
        if (!actionId) return;
        if (!runHotkeyAction(actionId)) return;
        ev.preventDefault();
        ev.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    loadHotkeys();
    return () => window.removeEventListener("keydown", onKeyDown);
}

/** Label lookup for toasts ("Ghost mode on"). */
export function actionLabel(actionId) {
    return _t(ACTION_BY_ID.get(actionId)?.label || actionId);
}
