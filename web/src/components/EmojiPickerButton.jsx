import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";

/** Toggle button + popover for the text composer.
 *
 * Both the picker's own code and the emoji dataset (~1.6 MB / ~430 KB on
 * disk respectively) are dynamically imported on first open rather than
 * bundled into the main chunk — most sessions never touch this, so there's
 * no reason to pay for it on every page load. Once loaded they stay in
 * memory for the rest of the session (lazy() caches the module; emojiData
 * is kept in state), so re-opening after the first time is instant.
 *
 * The dataset is a local import, not a URL, so Vite bundles it — no CDN
 * fetch at runtime — and `set="native"` renders emoji as plain Unicode
 * rather than image spritesheets. No network calls either way, matching
 * every other self-hosted piece of this app. */
const Picker = lazy(() => import("@emoji-mart/react"));

export default function EmojiPickerButton({ onSelect, dark }) {
    const [open, setOpen] = useState(false);
    const [emojiData, setEmojiData] = useState(null);
    const wrapRef = useRef(null);

    useEffect(() => {
        if (open && !emojiData) {
            import("@emoji-mart/data").then((mod) => setEmojiData(mod.default));
        }
    }, [open, emojiData]);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (ev) => {
            if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false);
        };
        const onKey = (ev) => { if (ev.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDocClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div className="o_emoji_picker_wrap" ref={wrapRef}>
            <button type="button" className="btn btn-light" title={_t("Emoji")}
                    onClick={() => setOpen((v) => !v)}>
                <i className="fa fa-smile-o" />
            </button>
            {open && emojiData && (
                <div className="o_emoji_picker_popover">
                    <Suspense fallback={null}>
                        <Picker
                            data={emojiData}
                            onEmojiSelect={(emoji) => onSelect(emoji.native)}
                            theme={dark ? "dark" : "light"}
                            set="native"
                            previewPosition="none"
                            skinTonePosition="search"
                        />
                    </Suspense>
                </div>
            )}
        </div>
    );
}
