// Stream caption prefs — per-browser (localStorage), shared by every window
// on the origin the way render_prefs.js is: the full-screen view's manual
// triggers panel, the mascot settings window, the desktop captions strip and
// the caption feed in whichever page holds the call all read the same key,
// and edits reach the other windows through the browser's `storage` event.
// (Showing the strip and its move mode are the shell's — it owns the window.)
import { useEffect, useState } from "react";

const STORAGE_KEY = "rexclaw.caption_prefs";
const CHANGE_EVENT = "rexclaw:caption-prefs";

export const DEFAULT_CAPTION_PREFS = {
    fullscreen: false,   // captions in the full-screen view
    lines: 4,            // full-screen box height, 2-4 lines
    size: "m",           // full-screen text size (Captions.jsx CAPTION_SIZES)
    stripSize: "m",      // desktop strip text size
    hold: 7,             // seconds a reply's line stays after its voice ends
};

// [seconds, English label]. 7 s is the default: the longest one subtitle
// event may stay up in the Netflix Timed Text Style Guide.
export const CAPTION_HOLD_OPTIONS = [
    [3, "3 seconds"],
    [5, "5 seconds"],
    [7, "7 seconds"],
    [10, "10 seconds"],
    [15, "15 seconds"],
];

export function loadCaptionPrefs() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return { ...DEFAULT_CAPTION_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch (e) {
        return { ...DEFAULT_CAPTION_PREFS };
    }
}

export function saveCaptionPrefs(patch) {
    const next = { ...loadCaptionPrefs(), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next })); } catch (e) { /* non-browser */ }
    return next;
}

/** React binding: [prefs, update(patch)] — tracks edits made in any window. */
export function useCaptionPrefs() {
    const [prefs, setPrefs] = useState(loadCaptionPrefs);
    useEffect(() => {
        const onLocal = (ev) => setPrefs(ev.detail || loadCaptionPrefs());
        const onStorage = (ev) => { if (ev.key === STORAGE_KEY || ev.key === null) setPrefs(loadCaptionPrefs()); };
        window.addEventListener(CHANGE_EVENT, onLocal);
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener(CHANGE_EVENT, onLocal);
            window.removeEventListener("storage", onStorage);
        };
    }, []);
    return [prefs, (patch) => setPrefs(saveCaptionPrefs(patch))];
}
