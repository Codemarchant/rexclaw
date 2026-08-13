import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { MASCOT_SETTINGS_CHANNEL, MASCOT_SIZES } from "../lib/mascot_link";
import { EMOTIONS, GESTURES } from "../models/avatar_catalog";

/** Mascot settings window (/#mascot-settings) — the mascot's full control
 *  panel in one friendly place, opened from the overlay island's ⚙ or the
 *  tray's "Full mascot settings" (the only in-app path when the controls
 *  island is hidden). Two tabs: Settings (call controls first, then
 *  behavior/placement/visibility) and Emotions & gestures (the same manual
 *  triggers as the full-screen view, played on the desktop avatar).
 *
 *  Two kinds of controls, two transports:
 *  - Overlay-owned state (the call, prefs, emotions/gestures) lives in the
 *    overlay page — this window mirrors it over a BroadcastChannel,
 *    transcript-window style: periodic "request" pings double as the
 *    liveness probe, and edits go back as commands applied through the same
 *    functions the island uses, so every surface (island, hotkeys, here)
 *    agrees.
 *  - Shell-owned settings (hide controls, hide between calls, open in mascot
 *    mode) go straight to the Electron bridge and work with the overlay
 *    closed too; pushes keep the checkboxes honest wherever one is flipped.
 */
export default function MascotSettingsView() {
    const bridge = window.rexclawDesktop;
    const [tab, setTab] = useState("settings");
    const [mascot, setMascot] = useState(null);   // last state snapshot from the overlay
    const [stale, setStale] = useState(true);
    const [controlsHidden, setControlsHidden] = useState(false);
    const [hideIdle, setHideIdle] = useState(false);
    const [startInMascot, setStartInMascot] = useState(false);
    // Cosmetic highlight for the emotion buttons — mirrors the click, not
    // the renderer (which decays emotions on its own schedule).
    const [emotion, setEmotion] = useState(null);
    // This window's own "always on top" pin (null = shell without the
    // feature — button hidden).
    const [onTop, setOnTop] = useState(null);
    const chRef = useRef(null);

    useEffect(() => { document.title = _t("Mascot settings"); }, []);

    useEffect(() => {
        window.rexclawDesktop?.windowPin?.().then((v) => setOnTop(v)).catch(() => {});
    }, []);

    const togglePin = async () => {
        try {
            const v = await bridge.setWindowPin(!onTop);
            if (v !== null) setOnTop(v);
        } catch (e) { /* shell gone — leave as is */ }
    };

    // Overlay link — request/response over the BroadcastChannel. Silence
    // means the overlay is closed: grey the overlay-owned controls out
    // rather than letting them edit nothing.
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

    // Shell-side settings: fetch once, then follow pushes (wherever flipped).
    useEffect(() => {
        if (!bridge) return;
        bridge.mascotControlsHidden?.().then((v) => setControlsHidden(!!v)).catch(() => {});
        bridge.mascotHideIdle?.().then((v) => setHideIdle(!!v)).catch(() => {});
        bridge.startupMascot?.().then((v) => setStartInMascot(!!v)).catch(() => {});
        bridge.onMascotControlsHidden?.((v) => setControlsHidden(!!v));
        bridge.onMascotHideIdle?.((v) => setHideIdle(!!v));
        bridge.onStartupMascot?.((v) => setStartInMascot(!!v));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const send = (msg) => chRef.current?.postMessage(msg);
    // Optimistic flip + rollback on failure, same as the Settings tab's
    // shell toggles.
    const setShell = async (fn, setLocal, flag) => {
        setLocal(flag);
        try {
            await fn(flag);
        } catch (e) {
            setLocal(!flag);
        }
    };

    const alive = !stale && !!mascot;
    const isLive = alive && mascot.status === "live";
    const busy = alive && (mascot.status === "live" || mascot.status === "connecting");

    if (!bridge) {
        return (
            <div className="rx_settings rx_mascot_settings">
                <div className="rx_settings_inner">
                    <section>
                        <h3><i className="fa fa-cog" /> {_t("Mascot settings")}</h3>
                        <p className="text-muted">
                            {_t("The desktop mascot is part of the desktop app — open this window from there.")}
                        </p>
                    </section>
                </div>
            </div>
        );
    }

    // One checkbox + description row (overlay-owned ones ride the channel).
    const check = (id, label, desc, checked, onChange, disabled = false) => (
        <div className="rx_mascot_set_item">
            <div className="rx_check">
                <input id={id} type="checkbox" checked={!!checked} disabled={disabled}
                       onChange={(ev) => onChange(ev.target.checked)} />
                <label htmlFor={id}>{label}</label>
            </div>
            {desc && <p className="rx_mascot_set_desc">{desc}</p>}
        </div>
    );

    const statusLabel = (() => {
        if (!alive) return _t("Ready");
        switch (mascot.status) {
            case "idle": return _t("Ready");
            case "connecting": return _t("Connecting…");
            case "live": return mascot.muted ? _t("Muted (live)") : _t("Live");
            case "ending": return _t("Ending…");
            case "ended": return _t("Ended");
            case "error": return _t("Error");
            default: return mascot.status;
        }
    })();

    return (
        <div className="rx_settings rx_mascot_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3 className="rx_mascot_set_head">
                        <span><i className="fa fa-cog" /> {_t("Mascot settings")}</span>
                        {onTop !== null && (
                            <button className={"btn btn-sm " + (onTop ? "btn-primary" : "btn-light")}
                                    onClick={togglePin} title={_t("Always on top")}>
                                <i className="fa fa-thumb-tack" />
                            </button>
                        )}
                    </h3>
                    <p className="text-muted">
                        {_t("Everything about the desktop avatar in one place. Changes "
                            + "apply immediately.")}
                    </p>
                    <div className="rx_mascot_set_tabs">
                        <button className={"btn btn-sm " + (tab === "settings" ? "btn-primary" : "btn-light")}
                                onClick={() => setTab("settings")}>
                            <i className="fa fa-sliders" /> {_t("Settings")}
                        </button>
                        <button className={"btn btn-sm " + (tab === "emotions" ? "btn-primary" : "btn-light")}
                                onClick={() => setTab("emotions")}>
                            <i className="fa fa-smile-o" /> {_t("Emotions & gestures")}
                        </button>
                    </div>
                    {!alive && (
                        <div className="rx_mascot_set_offline">
                            <span>{_t("The avatar isn't popped out right now — everything "
                                + "except Visibility & startup comes alive when it is.")}</span>
                            <button className="btn btn-sm btn-primary"
                                    onClick={() => bridge.runHotkeyAction?.("mascot.toggle")}>
                                <i className="fa fa-external-link" /> {_t("Pop out avatar")}
                            </button>
                        </div>
                    )}
                </section>

                {tab === "settings" && <>
                    <section>
                        <h3><i className="fa fa-microphone" /> {_t("Companion & call")}</h3>
                        <fieldset disabled={!alive}>
                            <label>{_t("Companion")}</label>
                            <select value={mascot?.selectedAgentId ?? ""}
                                    disabled={!alive || busy}
                                    onChange={(ev) => send({ type: "agent", id: Number(ev.target.value) })}>
                                {(mascot?.agents || []).map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            <div className="rx_mascot_set_call">
                                <span className={
                                    "rx_mascot_status"
                                    + (isLive ? " is-live" : "")
                                    + (alive && mascot.status === "connecting" ? " is-connecting" : "")
                                } />
                                <span className="rx_mascot_set_call_state">{statusLabel}</span>
                                {!busy && (
                                    <button className="btn btn-sm btn-primary"
                                            onClick={() => send({ type: "call", action: mascot?.hasResumable ? "resume" : "start" })}>
                                        <i className="fa fa-microphone" /> {mascot?.hasResumable ? _t("Resume last") : _t("Start")}
                                    </button>
                                )}
                                {!busy && mascot?.hasResumable && (
                                    <button className="btn btn-sm btn-light"
                                            onClick={() => send({ type: "call", action: "start" })}>
                                        {_t("Start new")}
                                    </button>
                                )}
                                {isLive && (
                                    <button className={"btn btn-sm " + (mascot.muted ? "btn-primary" : "btn-light")}
                                            onClick={() => send({ type: "mute", value: !mascot.muted })}>
                                        <i className={mascot.muted ? "fa fa-microphone-slash" : "fa fa-microphone"} />
                                        {" "}{mascot.muted ? _t("Unmute") : _t("Mute")}
                                    </button>
                                )}
                                {busy && (
                                    <button className="btn btn-sm btn-danger"
                                            onClick={() => send({ type: "call", action: "end" })}>
                                        <i className="fa fa-stop" /> {_t("End")}
                                    </button>
                                )}
                                {mascot?.shareSupported && (
                                    <button className={"btn btn-sm " + (mascot.shareArmed ? "btn-primary" : "btn-light")}
                                            title={_t("Share your screen — lets the companion take screenshots or record clips of it on request")}
                                            onClick={() => send({ type: "share" })}>
                                        <i className={mascot.shareRecording ? "fa fa-circle text-danger" : "fa fa-desktop"} />
                                        {" "}{mascot.shareArmed ? _t("Stop screen sharing") : _t("Share screen")}
                                    </button>
                                )}
                            </div>
                            <div className="rx_mascot_set_call">
                                <button className="btn btn-sm btn-light"
                                        title={_t("Back to the app window")}
                                        onClick={() => send({ type: "popback" })}>
                                    <i className="fa fa-window-restore" /> {_t("Pop back in")}
                                </button>
                                <button className="btn btn-sm btn-light"
                                        onClick={() => bridge.runHotkeyAction?.("app.transcriptWindow")}>
                                    <i className="fa fa-comments" /> {_t("Transcript window")}
                                </button>
                            </div>
                        </fieldset>
                    </section>

                    <section>
                        <h3><i className="fa fa-sliders" /> {_t("Behavior")}</h3>
                        <fieldset disabled={!alive}>
                            {check("rx_ms_ghost", _t("Ghost mode"),
                                _t("Clicks pass through the window to whatever is behind it, "
                                    + "and the avatar fades out of the cursor's way. The "
                                    + "controls island stays clickable."),
                                mascot?.ghost,
                                (v) => send({ type: "set", key: "ghost", value: v }))}
                            {check("rx_ms_follow", _t("Follow the cursor"),
                                _t("Eyes and head track your mouse across the desktop; when "
                                    + "it rests, they return to eye contact."),
                                mascot?.cursorFollow,
                                (v) => send({ type: "set", key: "cursorFollow", value: v }))}
                            {check("rx_ms_pin", _t("Always on top"),
                                _t("Keep the avatar above every other window, fullscreen "
                                    + "apps included."),
                                mascot?.pinned,
                                (v) => send({ type: "set", key: "pinned", value: v }))}
                            {check("rx_ms_fullbody", _t("Full body view"),
                                _t("Show the whole character instead of the face view — "
                                    + "drag rotates, scroll zooms."),
                                mascot?.fullBody,
                                (v) => send({ type: "set", key: "fullBody", value: v }))}
                            <label>{_t("Window size")}</label>
                            <div className="rx_mascot_set_sizes">
                                {MASCOT_SIZES.map((s, idx) => (
                                    <button key={s.width}
                                            className={"btn btn-sm "
                                                + (alive && mascot?.sizeIdx === idx ? "btn-primary" : "btn-light")}
                                            title={`${s.width}×${s.height}`}
                                            onClick={() => send({ type: "size", idx })}>
                                        {["S", "M", "L", "XL"][idx]}
                                    </button>
                                ))}
                            </div>
                            <p className="rx_mascot_set_desc rx_mascot_set_desc--flush">
                                {_t("Or scroll on the avatar (face view) for fine control.")}
                            </p>
                            {alive && (mascot?.outfits || []).length > 1 && (
                                <>
                                    <label>{_t("Outfit")}</label>
                                    <select value={Number(mascot.outfitId || 0)}
                                            onChange={(ev) => send({ type: "outfit", id: Number(ev.target.value) })}>
                                        {mascot.outfits.map((o) => (
                                            <option key={o.id} value={Number(o.id)}>{o.name}</option>
                                        ))}
                                    </select>
                                </>
                            )}
                        </fieldset>
                    </section>

                    <section>
                        <h3><i className="fa fa-arrows" /> {_t("Placement")}</h3>
                        <fieldset disabled={!alive}>
                            <label>{_t("Snap to corner")}</label>
                            <div className="rx_mascot_set_corners">
                                {[["top-left", "↖"], ["top-right", "↗"],
                                  ["bottom-left", "↙"], ["bottom-right", "↘"]].map(([corner, arrow]) => (
                                    <button key={corner} className="btn btn-sm btn-light"
                                            title={corner.replace("-", " ")}
                                            onClick={() => bridge.alignMascot?.(corner)}>
                                        {arrow}
                                    </button>
                                ))}
                                <button className="btn btn-sm btn-light"
                                        onClick={() => bridge.mascotNextDisplay?.()}>
                                    <i className="fa fa-television" /> {_t("Next monitor")}
                                </button>
                            </div>
                        </fieldset>
                    </section>

                    <section>
                        <h3><i className="fa fa-eye-slash" /> {_t("Visibility & startup")}</h3>
                        {check("rx_ms_controls", _t("Hide avatar controls"),
                            _t("The floating controls island never shows, even on hover. "
                                + "The tray menu and hotkeys stay available — including "
                                + "this window."),
                            controlsHidden,
                            (v) => setShell(bridge.setMascotControlsHidden, setControlsHidden, v))}
                        {check("rx_ms_hideidle", _t("Hide the avatar between calls"),
                            _t("In mascot mode, the avatar disappears from the desktop while no call is live and pops back up (without stealing focus) when one starts. Pairs naturally with voice activation: the companion waits dormant and appears when you call their wake phrase. While hidden, the tray icon is the way back — click it or its \"Show Rexclaw\" entry."),
                            hideIdle,
                            (v) => setShell(bridge.setMascotHideIdle, setHideIdle, v))}
                        {check("rx_ms_startup", _t("Open in mascot mode"),
                            _t("Rexclaw starts as the companion on your desktop instead of "
                                + "an app window. Takes effect on the next launch."),
                            startInMascot,
                            (v) => setShell(bridge.setStartupMascot, setStartInMascot, v))}
                    </section>
                </>}

                {tab === "emotions" && <>
                    <section>
                        <h3><i className="fa fa-smile-o" /> {_t("Emotions")}</h3>
                        <p className="text-muted">
                            {_t("Manual triggers, same as the full-screen view — they play "
                                + "on the desktop avatar right away, call or no call.")}
                        </p>
                        <fieldset disabled={!alive}>
                            <div className="rx_mascot_set_grid">
                                {EMOTIONS.map((emo) => (
                                    <button key={emo.id}
                                            className={"btn btn-sm "
                                                + (emotion === emo.id ? "btn-primary" : "btn-light")}
                                            onClick={() => { setEmotion(emo.id); send({ type: "emotion", id: emo.id }); }}>
                                        <i className={"fa " + emo.icon} /> {_t(emo.label)}
                                    </button>
                                ))}
                            </div>
                        </fieldset>
                    </section>
                    <section>
                        <h3><i className="fa fa-hand-paper-o" /> {_t("Gestures")}</h3>
                        <fieldset disabled={!alive}>
                            <div className="rx_mascot_set_grid">
                                {GESTURES.map((g) => (
                                    <button key={g.id} className="btn btn-sm btn-light"
                                            title={_t(g.label) + (g.loop ? " " + _t("(loops)") : "")}
                                            onClick={() => send({ type: "gesture", id: g.id })}>
                                        <i className={"fa " + g.icon} /> {_t(g.label)}
                                    </button>
                                ))}
                            </div>
                        </fieldset>
                    </section>
                    {alive && (mascot?.customGestures || []).length > 0 && (
                        <section>
                            <h3><i className="fa fa-star-o" /> {_t("Custom Gestures")}</h3>
                            <fieldset disabled={!alive}>
                                <div className="rx_mascot_set_grid">
                                    {mascot.customGestures.map((g) => (
                                        <button key={g.id} className="btn btn-sm btn-light"
                                                title={(g.type === "combo" ? `${g.name} ${_t("(combo)")}` : g.name)
                                                    + (g.loop ? " " + _t("(loops)") : "")}
                                                onClick={() => send({ type: "customGesture", id: g.id })}>
                                            <i className={g.type === "combo" ? "fa fa-users" : (g.loop ? "fa fa-repeat" : "fa fa-star-o")} />
                                            {" "}{g.name}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>
                        </section>
                    )}
                </>}
            </div>
        </div>
    );
}
