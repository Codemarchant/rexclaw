import React, { useEffect, useMemo, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { notification } from "../lib/notification";
import { screenCapture } from "../lib/screen_capture";
import { cameraAwareness } from "../lib/camera_awareness";
import SharePanel, { localShareActions, localShareState } from "./SharePanel.jsx";

/** Header share button + popover, shared by the voice and text views.
 *
 *  Clicking the button opens the share panel (SharePanel) below it, fed
 *  straight from the capture singletons. Arming happens inside the
 *  panel's Start click — getDisplayMedia and getUserMedia both want a
 *  user gesture — and the model can never start a share itself. */
export default function ShareButton({ buttonClass = "btn btn-light" }) {
    const scap = useReactive(screenCapture.state);
    const aware = useReactive(cameraAwareness.state);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef(null);

    const screenOk = screenCapture.isSupported;
    const cameraOk = screenCapture.isCameraSupported;

    // Close on outside click / Escape.
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (ev) => {
            if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false);
        };
        const onKey = (ev) => { if (ev.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const actions = useMemo(() => localShareActions({
        onError: (msg) => notification.add(_t("Sharing failed: %s", msg), { type: "danger" }),
        onBusy: setBusy,
    }), []);

    // Plain http over LAN has neither API — nothing to offer. (After the
    // hooks: React needs the same hook order every render.)
    if (!screenOk && !cameraOk) return null;

    const anyArmed = scap.armed;
    const icon = scap.recording
        ? "fa fa-circle text-danger"
        : (scap.camera && !scap.screen) ? "fa fa-camera" : "fa fa-desktop";
    const title = scap.recording
        ? _t("Recording…")
        : anyArmed
            ? _t("Sharing — click to manage or stop")
            : _t("Share your screen or camera — lets the companion take a look, grab screenshots or record clips on request");

    return (
        <div className="rx_share" ref={rootRef}>
            <button className={buttonClass + (anyArmed ? " active" : "")}
                    onClick={() => setOpen(!open)} title={title}
                    aria-expanded={open}>
                <i className={icon} />
            </button>
            {open && (
                <SharePanel share={localShareState(scap, aware)} actions={actions}
                            previewStream={screenCapture.cameraStream} busy={busy}
                            className="rx_share_popover--below" />
            )}
        </div>
    );
}
