// Renderer look prefs — the lighting, effects and ambience presets, the
// mood-reactive ambience switch, mood marks and the cursor touch physics
// switch. Per-browser (localStorage), shared
// by every surface that shows the avatar: the full-screen view, the desktop
// mascot overlay and the mascot settings window all read the same key, and
// the renderer applies a change live wherever it happens — same-window
// edits fire a custom event, other windows (the mascot overlay is its own
// BrowserWindow on the same origin) get the browser's `storage` event for
// free.
import { useEffect, useState } from "react";

const STORAGE_KEY = "rexclaw.render_prefs";
const CHANGE_EVENT = "rexclaw:render-prefs";

export const DEFAULT_RENDER_PREFS = {
    lighting: "default", effects: "off", ambience: "off", moodAmbience: false, moodMarks: true, touch: true,
};

// [id, English label] — labels go through _t() at the UI. Ids are the keys
// of LIGHTING_PRESETS in services/avatar_renderer.js.
export const LIGHTING_PRESET_OPTIONS = [
    ["default", "Default"],
    ["flat", "Flat"],
    ["studio", "Studio"],
    ["sunny", "Sunny day"],
    ["overcast", "Overcast"],
    ["golden", "Golden hour"],
    ["moonlight", "Moonlight"],
    ["night", "Night neon"],
    ["candlelight", "Candlelight"],
    ["spotlight", "Stage spotlight"],
    ["backlit", "Backlit"],
];

// [id, English label] — ids are the keys of EFFECTS_PRESETS in
// services/avatar_renderer.js. The bare "Soft bloom" entry was retired
// (too subtle on its own; the bloom lives on inside Anime colour and
// Cinematic) — a stored pick of it reads back as Off.
export const EFFECTS_PRESET_OPTIONS = [
    ["off", "Off"],
    ["anime", "Anime colour"],
    ["portrait", "Portrait"],
    ["cinematic", "Cinematic"],
];

// [id, English label] — ids are the systems in services/ambience.js.
export const AMBIENCE_OPTIONS = [
    ["off", "Off"],
    ["rain", "Rain"],
    ["snow", "Snow"],
    ["petals", "Cherry petals"],
    ["fireflies", "Fireflies"],
    ["embers", "Embers"],
    ["focus", "Focus lines"],
];

export function loadRenderPrefs() {
    let prefs;
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        prefs = { ...DEFAULT_RENDER_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch (e) {
        prefs = { ...DEFAULT_RENDER_PREFS };
    }
    if (!EFFECTS_PRESET_OPTIONS.some(([id]) => id === prefs.effects)) prefs.effects = "off";
    return prefs;
}

/** Merge `patch` into the stored prefs and notify this window's subscribers.
 *  Returns the merged prefs. */
export function saveRenderPrefs(patch) {
    const next = { ...loadRenderPrefs(), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next })); } catch (e) { /* non-browser */ }
    return next;
}

/** React binding: [prefs, update(patch)] — tracks edits made in any window. */
export function useRenderPrefs() {
    const [prefs, setPrefs] = useState(loadRenderPrefs);
    useEffect(() => onRenderPrefsChange(setPrefs), []);
    return [prefs, (patch) => setPrefs(saveRenderPrefs(patch))];
}

/** Subscribe to pref changes from this window or any other on the origin.
 *  Returns an unsubscribe fn. */
export function onRenderPrefsChange(cb) {
    const onLocal = (ev) => cb(ev.detail || loadRenderPrefs());
    const onStorage = (ev) => { if (ev.key === STORAGE_KEY || ev.key === null) cb(loadRenderPrefs()); };
    window.addEventListener(CHANGE_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(CHANGE_EVENT, onLocal);
        window.removeEventListener("storage", onStorage);
    };
}
