import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { MASCOT_SETTINGS_CHANNEL } from "../lib/mascot_link";
import SharePanel from "./SharePanel.jsx";

/** Mascot share window (/#mascot-share) — the Screen / Camera share panel
 *  for the popped-out avatar, opened from the island's share button or
 *  the mascot settings window.
 *
 *  The streams the capture tools read live in the overlay page (the call
 *  and its tool dispatcher run there), so this window mirrors the
 *  overlay's share snapshot over the settings BroadcastChannel and sends
 *  the panel's actions back as commands — same transport as the settings
 *  window. The one thing that can't cross windows is the camera picture:
 *  a MediaStream is per document. So for the preview this window opens
 *  its own stream on the same camera (Chromium happily serves one webcam
 *  to two windows) and drops it the moment the overlay's camera stops. */
export default function MascotShareView() {
    const bridge = window.rexclawDesktop;
    const [mascot, setMascot] = useState(null);
    const [stale, setStale] = useState(true);
    const [onTop, setOnTop] = useState(null);
    const [previewStream, setPreviewStream] = useState(null);
    const chRef = useRef(null);

    useEffect(() => { document.title = _t("Share screen or camera"); }, []);

    useEffect(() => {
        bridge?.windowPin?.().then((v) => setOnTop(v)).catch(() => {});
    }, []);

    const togglePin = async () => {
        try {
            const v = await bridge.setWindowPin(!onTop);
            if (v !== null) setOnTop(v);
        } catch (e) { /* shell gone — leave as is */ }
    };

    // Overlay link — request/response over the BroadcastChannel; silence
    // means the avatar isn't popped out.
    useEffect(() => {
        const ch = new BroadcastChannel(MASCOT_SETTINGS_CHANNEL);
        chRef.current = ch;
        let lastAt = 0;
        ch.onmessage = (ev) => {
            if (ev.data?.type !== "state") return;
            lastAt = Date.now();
            setMascot(ev.data);
            setStale(false);
        };
        ch.postMessage({ type: "request" });
        const timer = setInterval(() => {
            if (Date.now() - lastAt > 4500) setStale(true);
            ch.postMessage({ type: "request" });
        }, 2000);
        return () => {
            clearInterval(timer);
            ch.close();
        };
    }, []);

    const alive = !stale && !!mascot?.share;
    const share = alive ? mascot.share : null;
    const cameraOn = !!share?.camera;
    const deviceId = share?.cameraDeviceId || "";
    const facing = share?.facing || "user";

    // Own preview stream, following the overlay's camera on/off and device.
    useEffect(() => {
        if (!cameraOn || typeof navigator.mediaDevices?.getUserMedia !== "function") {
            setPreviewStream((s) => { for (const t of s?.getTracks() || []) t.stop(); return null; });
            return undefined;
        }
        let cancelled = false;
        let stream = null;
        const video = deviceId ? { deviceId: { ideal: deviceId } } : { facingMode: facing };
        navigator.mediaDevices.getUserMedia({ video: { ...video, width: { ideal: 640 }, height: { ideal: 360 } }, audio: false })
            .then((s) => {
                if (cancelled) { for (const t of s.getTracks()) t.stop(); return; }
                stream = s;
                setPreviewStream(s);
            })
            .catch((e) => console.warn("[mascot-share] preview failed", e));
        return () => {
            cancelled = true;
            for (const t of stream?.getTracks() || []) t.stop();
            setPreviewStream(null);
        };
    }, [cameraOn, deviceId, facing]);

    const send = (msg) => chRef.current?.postMessage(msg);
    const actions = {
        setPreferred: (source) => send({ type: "share", action: "preferred", source }),
        start: (source) => send({ type: "share", action: "start", source }),
        stop: (source) => send({ type: "share", action: "stop", source }),
        pickCamera: (id) => send({ type: "share", action: "pick", deviceId: id }),
        flip: () => send({ type: "share", action: "flip" }),
        setAwareness: (value) => send({ type: "share", action: "awareness", value }),
    };

    return (
        <div className="rx_mascot_share">
            <div className="rx_mascot_share_head">
                <span><i className="fa fa-desktop" /> {_t("Share screen or camera")}</span>
                {onTop !== null && (
                    <button className={"btn btn-sm " + (onTop ? "btn-primary" : "btn-light")}
                            onClick={togglePin} title={_t("Always on top")}>
                        <i className="fa fa-thumb-tack" />
                    </button>
                )}
            </div>
            {share ? (
                <SharePanel className="rx_share_popover--inline" share={share} actions={actions}
                            previewStream={previewStream} />
            ) : (
                <div className="rx_mascot_share_offline">
                    <p>{_t("The avatar isn't popped out right now — sharing for mascot mode lives with the popped-out avatar.")}</p>
                    {bridge && (
                        <button className="btn btn-sm btn-primary"
                                onClick={() => bridge.runHotkeyAction?.("mascot.toggle")}>
                            <i className="fa fa-external-link" /> {_t("Pop out avatar")}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
