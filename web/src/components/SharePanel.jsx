import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { screenCapture } from "../lib/screen_capture";
import { cameraAwareness, TRIGGER_HELP } from "../lib/camera_awareness";

/** The share panel body: Screen / Camera switch at the top, per-source
 *  controls, awareness opt-in, Start / Stop. Presentational — it renders
 *  a `share` snapshot and calls `actions`, so the same panel serves the
 *  header popover (snapshot straight off the capture singletons) and the
 *  mascot settings window (snapshot mirrored over the BroadcastChannel,
 *  actions sent back as commands to the page that owns the streams). */
export default function SharePanel({ share, actions, previewStream = null, busy = false, className = "" }) {
    const previewRef = useRef(null);
    const [showTriggers, setShowTriggers] = useState(false);
    const source = share.preferred;
    const armed = !!share[source];
    const aware = share.awareness || {};

    // Live camera preview (mirrored like a selfie view), so the user sees
    // exactly what a capture would grab. Only where the stream lives.
    useEffect(() => {
        const el = previewRef.current;
        if (!el) return;
        if (el.srcObject !== previewStream) {
            el.srcObject = previewStream;
            if (previewStream) el.play().catch(() => {});
        }
    }, [previewStream, share.camera, source]);

    const awarenessStatus = () => {
        if (!aware.enabled || !share.camera) return null;
        if (aware.status === "loading") return _t("Loading face model…");
        if (aware.status === "error") return _t("Awareness failed: %s", aware.error || "");
        if (aware.status !== "running") return null;
        const who = aware.present
            ? (aware.attentive ? _t("you're here, facing the screen") : _t("you're here"))
            : _t("nobody in frame");
        const parts = [aware.lastEvent
            ? _t("Watching: %s · last noticed: %s", who, aware.lastEvent.replace(/_/g, " "))
            : _t("Watching: %s", who)];
        if (aware.handsStatus === "loading") parts.push(_t("loading hand model…"));
        else if (aware.handsStatus === "error") parts.push(_t("hand model failed"));
        else if (aware.handGesture) parts.push(_t("hand: %s", aware.handGesture.replace(/_/g, " ").toLowerCase()));
        return parts.join(" · ");
    };

    return (
        <div className={"rx_share_popover " + className}>
            <div className="rx_share_seg" role="tablist">
                {share.screenSupported && (
                    <button className={source === "screen" ? "is-on" : ""} role="tab"
                            onClick={() => actions.setPreferred("screen")}>
                        <i className="fa fa-desktop" /> {_t("Screen")}
                        {share.screen && <span className="rx_share_dot" />}
                    </button>
                )}
                {share.cameraSupported && (
                    <button className={source === "camera" ? "is-on" : ""} role="tab"
                            onClick={() => actions.setPreferred("camera")}>
                        <i className="fa fa-camera" /> {_t("Camera")}
                        {share.camera && <span className="rx_share_dot" />}
                    </button>
                )}
            </div>

            {source === "screen" ? (
                <p className="rx_share_hint">
                    {_t("Your companion can take screenshots, read your screen or record short clips of it when you ask. Nothing is captured until they call a tool.")}
                </p>
            ) : (
                <>
                    {share.camera && previewStream ? (
                        <video ref={previewRef} className="rx_share_preview" muted playsInline autoPlay />
                    ) : (
                        <p className="rx_share_hint">
                            {share.camera
                                ? _t("Camera is sharing. Your companion only looks when you ask; each look sends one photo.")
                                : _t("Show your companion something — a thing you're holding, the room, yourself. They only look when you ask; each look sends one photo.")}
                        </p>
                    )}
                    {((share.cameras || []).length > 1 || !share.screenSupported) && (
                        <div className="rx_share_row">
                            {(share.cameras || []).length > 1 && (
                                <select value={share.cameraDeviceId || ""} disabled={busy}
                                        onChange={(ev) => actions.pickCamera(ev.target.value)}
                                        title={_t("Which camera to share")}>
                                    <option value="">{_t("Default camera")}</option>
                                    {share.cameras.map((c) => (
                                        <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                                    ))}
                                </select>
                            )}
                            {!share.screenSupported && (
                                // Phones / tablets / headsets: front ↔ back.
                                <button className="rx_share_mini" onClick={actions.flip} disabled={busy}
                                        title={_t("Switch between front and back camera")}>
                                    <i className="fa fa-refresh" /> {_t("Flip")}
                                </button>
                            )}
                        </div>
                    )}
                    <div className="rx_share_check_row">
                        <label className="rx_share_check"
                               title={_t("Runs small face and hand models on this device while the camera is shared, so your companion reacts when you wave, give a thumbs up or down, a peace or OK sign or rock-on, and knows when you step away, come back or yawn. Only short hints reach them — never images, never scores.")}>
                            <input type="checkbox" checked={!!aware.enabled}
                                   onChange={(ev) => actions.setAwareness(ev.target.checked)} />
                            {" "}{_t("Notice presence, expressions & gestures (on this device only)")}
                        </label>
                        {/* Outside the label on purpose: a label forwards clicks to its control. */}
                        <button type="button" className={"rx_share_info" + (showTriggers ? " is-on" : "")}
                                title={_t("What your companion reacts to")}
                                onClick={() => setShowTriggers((v) => !v)}>
                            <i className="fa fa-info-circle" />
                        </button>
                    </div>
                    {showTriggers && (
                        <div className="rx_share_triggers">
                            {TRIGGER_HELP.map((g) => (
                                <div key={g.group}>
                                    <div className="rx_share_triggers_group">{_t(g.group)}</div>
                                    {g.items.map(([key, label, effect]) => (
                                        <div key={key} className="rx_share_triggers_row">
                                            <b>{_t(label)}</b> · {_t(effect)}
                                        </div>
                                    ))}
                                </div>
                            ))}
                            <div className="rx_share_status">
                                {_t("A held sign fires once. Release it and pause before repeating it. Only short notes reach your companion, never images.")}
                            </div>
                        </div>
                    )}
                    {awarenessStatus() && (
                        <div className={"rx_share_status" + (aware.status === "error" ? " is-error" : "")}>
                            {awarenessStatus()}
                        </div>
                    )}
                </>
            )}

            {share.error && <div className="rx_share_status is-error">{share.error}</div>}

            <button className={"rx_share_go" + (armed ? " is-stop" : "")}
                    onClick={() => (armed ? actions.stop(source) : actions.start(source))} disabled={busy}>
                <i className={busy ? "fa fa-spinner fa-spin" : armed ? "fa fa-stop" : "fa fa-play"} />
                {" "}{armed
                    ? (source === "camera" ? _t("Stop camera") : _t("Stop screen sharing"))
                    : (source === "camera" ? _t("Start camera") : _t("Share screen"))}
            </button>
            {source === "screen" && share.camera && (
                <div className="rx_share_other">
                    {_t("Camera is also sharing.")}{" "}
                    <a href="#" onClick={(ev) => { ev.preventDefault(); actions.stop("camera"); }}>{_t("Stop it")}</a>
                </div>
            )}
            {source === "camera" && share.screen && (
                <div className="rx_share_other">
                    {_t("Screen is also sharing.")}{" "}
                    <a href="#" onClick={(ev) => { ev.preventDefault(); actions.stop("screen"); }}>{_t("Stop it")}</a>
                </div>
            )}
        </div>
    );
}

/** Snapshot of the local capture + awareness singletons in the panel's
 *  `share` shape. Plain data, so the mascot page can post it over its
 *  settings channel unchanged. `error` = last arming failure to show. */
export function localShareState(scap, aware, error = null) {
    return {
        screenSupported: screenCapture.isSupported,
        cameraSupported: screenCapture.isCameraSupported,
        screen: !!scap.screen,
        camera: !!scap.camera,
        recording: !!scap.recording,
        preferred: scap.preferred,
        facing: scap.facing,
        cameraDeviceId: scap.cameraDeviceId,
        cameras: scap.cameras.map((c) => ({ ...c })),
        error,
        awareness: {
            enabled: !!aware.enabled,
            status: aware.status,
            handsStatus: aware.handsStatus,
            error: aware.error,
            present: !!aware.present,
            attentive: !!aware.attentive,
            handGesture: aware.handGesture,
            lastEvent: aware.lastEvent,
        },
    };
}

/** Panel actions against the local singletons. `onError(message)` shows
 *  a failure; `onBusy(flag)` brackets the async arming calls. Arming must
 *  run from a user gesture in the page that owns the stream — the header
 *  popover's clicks, or (Electron) a command from the settings window,
 *  which the shell lets through without one. */
export function localShareActions({ onError, onBusy } = {}) {
    const run = async (fn) => {
        onBusy?.(true);
        try {
            await fn();
        } catch (e) {
            onError?.(String(e?.message || e));
        } finally {
            onBusy?.(false);
        }
    };
    return {
        setPreferred: (source) => screenCapture.setPreferred(source),
        start: (source) => run(() => (source === "camera" ? screenCapture.armCamera() : screenCapture.arm())),
        stop: (source) => screenCapture.disarm(source),
        pickCamera: (deviceId) => {
            if (!screenCapture.state.camera) {
                screenCapture.setCameraDevice(deviceId || null);
                return Promise.resolve();
            }
            return run(() => screenCapture.armCamera({ deviceId: deviceId || null }));
        },
        flip: () => run(() => screenCapture.switchCamera()),
        setAwareness: (flag) => cameraAwareness.setEnabled(flag),
    };
}
