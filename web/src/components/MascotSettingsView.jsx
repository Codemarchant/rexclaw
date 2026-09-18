import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { MASCOT_SETTINGS_CHANNEL, MASCOT_SIZES } from "../lib/mascot_link";
import { AMBIENCE_OPTIONS, EFFECTS_PRESET_OPTIONS, LIGHTING_PRESET_OPTIONS, useRenderPrefs } from "../lib/render_prefs";
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
    // Look prefs are per-browser localStorage, not overlay state: this
    // window writes them directly and the overlay (same origin) picks the
    // change up through the storage event — so they work with it closed too.
    const [renderPrefs, updateRenderPrefs] = useRenderPrefs();
    const chRef = useRef(null);
    // Shared-library .vrma files for the Emotions & gestures picker. Fetched
    // the first time that tab opens (null = not fetched yet); a failed fetch
    // leaves it empty, which just hides the picker.
    const [libraryGestures, setLibraryGestures] = useState(null);
    useEffect(() => {
        if (tab !== "emotions" || libraryGestures) return;
        rpc("/api/avatars/shared_assets", { kind: "vrma" })
            .then((files) => setLibraryGestures((files || []).filter((f) => f.kind === "vrma")))
            .catch(() => setLibraryGestures([]));
    }, [tab]);

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
    // Custom size draft: seeded from the overlay's live window size and
    // re-synced whenever that changes (a preset click, a scroll resize), so
    // the fields always read what's on screen until the user types.
    const [custom, setCustom] = useState({ width: "", height: "" });
    const liveW = mascot?.windowSize?.width;
    const liveH = mascot?.windowSize?.height;
    useEffect(() => {
        if (liveW && liveH) setCustom({ width: String(liveW), height: String(liveH) });
    }, [liveW, liveH]);
    const applyCustom = () => send({ type: "customSize", width: Number(custom.width), height: Number(custom.height) });
    // Motion switches are global config rather than overlay prefs, but they
    // travel the same way: the overlay owns the director, so it applies and
    // persists them and pushes the new state back.
    const sendMotion = (settings) => {
        setMascot((m) => (m ? { ...m, motion: { ...m.motion, ...settings } } : m));
        send({ type: "motion", settings });
    };
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
                            {_t("The desktop mascot is part of the desktop app. Open this window from there.")}
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
                            <span>{_t("The avatar isn't popped out. Most settings come alive when it is.")}</span>
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
                                {mascot?.share && (mascot.share.screenSupported || mascot.share.cameraSupported) && (
                                    // Screen / Camera sharing has its own window
                                    // (same one the island's share button opens).
                                    <button className={"btn btn-sm " + (mascot.share.screen || mascot.share.camera ? "btn-primary" : "btn-light")}
                                            title={_t("Share your screen or camera — lets the companion take a look, grab screenshots or record clips on request")}
                                            onClick={() => bridge.openMascotShare?.()}>
                                        <i className={mascot.share.recording
                                            ? "fa fa-circle text-danger"
                                            : mascot.share.camera && !mascot.share.screen ? "fa fa-camera" : "fa fa-desktop"} />
                                        {" "}{_t("Share screen or camera…")}
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
                            {alive && (mascot?.outfits || []).length > 1 && (
                                <div className="rx_mascot_set_item">
                                    <label>{_t("Outfit")}</label>
                                    <select value={Number(mascot.outfitId || 0)}
                                            onChange={(ev) => send({ type: "outfit", id: Number(ev.target.value) })}>
                                        {mascot.outfits.map((o) => (
                                            <option key={o.id} value={Number(o.id)}>{o.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {check("rx_ms_fullbody", _t("Full body view"),
                                _t("Whole character instead of the face. Drag to rotate, scroll to zoom, Ctrl + drag to move."),
                                mascot?.fullBody,
                                (v) => send({ type: "set", key: "fullBody", value: v }))}
                            {check("rx_ms_ghost", _t("Ghost mode"),
                                _t("Clicks pass through to whatever is behind the window, and the avatar fades out of the cursor's way."),
                                mascot?.ghost,
                                (v) => send({ type: "set", key: "ghost", value: v }))}
                            {mascot?.ghost && (() => {
                                // Opacity under the cursor, shown as a percentage.
                                const pct = Math.round((mascot.ghostFade ?? 0.15) * 100);
                                return (
                                    <div className="rx_mascot_set_item rx_mascot_set_range">
                                        <label htmlFor="rx_ms_ghostfade">{_t("Fade to")} {pct}%</label>
                                        <input id="rx_ms_ghostfade" type="range" min="0" max="100" step="5"
                                               value={pct}
                                               onChange={(ev) => {
                                                   const v = Number(ev.target.value) / 100;
                                                   setMascot((m) => (m ? { ...m, ghostFade: v } : m));
                                                   send({ type: "ghostFade", value: v });
                                               }} />
                                    </div>
                                );
                            })()}
                            {check("rx_ms_follow", _t("Follow the cursor"),
                                _t("Eyes and head track your mouse across the desktop."),
                                mascot?.cursorFollow,
                                (v) => send({ type: "set", key: "cursorFollow", value: v }))}
                        </fieldset>
                        {/* A shared look pref (localStorage, read by the overlay
                            and the full-screen view), not overlay state, so it
                            stays live with the avatar popped back in. */}
                        {check("rx_ms_touch", _t("Touch physics"),
                            _t("Hair and clothes dodge the cursor, ruffle on quick sweeps and bounce when clicked."),
                            renderPrefs.touch,
                            (v) => updateRenderPrefs({ touch: v }))}
                        <fieldset disabled={!alive}>
                            {check("rx_ms_pin", _t("Always on top"),
                                _t("Keep the avatar above every other window."),
                                mascot?.pinned,
                                (v) => send({ type: "set", key: "pinned", value: v }))}
                        </fieldset>
                    </section>

                    <section>
                        <h3><i className="fa fa-arrows" /> {_t("Placement")}</h3>
                        <fieldset disabled={!alive}>
                            <label>{_t("Window size")}</label>
                            <div className="rx_mascot_set_sizes">
                                {MASCOT_SIZES.map((s, idx) => (
                                    <button key={idx}
                                            className={"btn btn-sm "
                                                + (alive && mascot?.sizeIdx === idx ? "btn-primary" : "btn-light")}
                                            title={s.full ? _t("Whole screen (this display, taskbar excluded)") : `${s.width}×${s.height}`}
                                            onClick={() => send({ type: "size", idx })}>
                                        {s.full ? _t("Full") : ["S", "M", "L", "XL"][idx]}
                                    </button>
                                ))}
                            </div>
                            <p className="rx_mascot_set_desc rx_mascot_set_desc--flush">
                                {_t("Or scroll on the avatar (face view) for fine control.")}
                            </p>
                            <label>{_t("Custom size")}</label>
                            <div className="rx_mascot_set_sizes rx_mascot_set_custom">
                                <input type="number" min={220} step={10} value={custom.width}
                                       title={_t("Width (px)")}
                                       onChange={(ev) => setCustom((c) => ({ ...c, width: ev.target.value }))}
                                       onKeyDown={(ev) => { if (ev.key === "Enter") applyCustom(); }} />
                                <span>×</span>
                                <input type="number" min={320} step={10} value={custom.height}
                                       title={_t("Height (px)")}
                                       onChange={(ev) => setCustom((c) => ({ ...c, height: ev.target.value }))}
                                       onKeyDown={(ev) => { if (ev.key === "Enter") applyCustom(); }} />
                                <button className={"btn btn-sm "
                                            + (alive && mascot?.sizeIdx === -1 ? "btn-primary" : "btn-light")}
                                        onClick={applyCustom}>
                                    {_t("Apply")}
                                </button>
                                <button className="btn btn-sm btn-light"
                                        title={_t("Set the width to this display's full width")}
                                        disabled={!mascot?.screenSize?.width}
                                        onClick={() => setCustom((c) => ({ ...c, width: String(mascot.screenSize.width) }))}>
                                    <i className="fa fa-arrows-h" /> {_t("Screen width")}
                                </button>
                                <button className="btn btn-sm btn-light"
                                        title={_t("Set the height to this display's full height (taskbar excluded)")}
                                        disabled={!mascot?.screenSize?.height}
                                        onClick={() => setCustom((c) => ({ ...c, height: String(mascot.screenSize.height) }))}>
                                    <i className="fa fa-arrows-v" /> {_t("Screen height")}
                                </button>
                            </div>
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
                        <h3><i className="fa fa-lightbulb-o" /> {_t("Look")}</h3>
                        {/* Overlay-owned (the mascot page paints it), unlike
                            the look prefs below — greyed out with it closed. */}
                        {check("rx_ms_backdrop", _t("Show a background"), null,
                            mascot?.backdrop,
                            (v) => send({ type: "set", key: "backdrop", value: v }),
                            !alive)}
                        {alive && mascot?.backdrop && (mascot.backgrounds || []).length > 1 && (
                            <div className="rx_mascot_set_item">
                                <label htmlFor="rx_ms_background">{_t("Background")}</label>
                                <select id="rx_ms_background" value={mascot.backgroundKey || ""}
                                        onChange={(ev) => send({ type: "background", key: ev.target.value })}>
                                    {mascot.backgrounds.map((b) => (
                                        <option key={b.key} value={b.key}>{b.label}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        <div className="rx_mascot_set_item">
                            <label htmlFor="rx_ms_lighting">{_t("Lighting")}</label>
                            <select id="rx_ms_lighting" value={renderPrefs.lighting}
                                    onChange={(ev) => updateRenderPrefs({ lighting: ev.target.value })}>
                                {LIGHTING_PRESET_OPTIONS.map(([id, label]) => (
                                    <option key={id} value={id}>{_t(label)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="rx_mascot_set_item">
                            <label htmlFor="rx_ms_effects">{_t("Effects")}</label>
                            <select id="rx_ms_effects" value={renderPrefs.effects}
                                    onChange={(ev) => updateRenderPrefs({ effects: ev.target.value })}>
                                {EFFECTS_PRESET_OPTIONS.map(([id, label]) => (
                                    <option key={id} value={id}>{_t(label)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="rx_mascot_set_item">
                            <label htmlFor="rx_ms_ambience">{_t("Ambience")}</label>
                            <select id="rx_ms_ambience" value={renderPrefs.ambience}
                                    onChange={(ev) => updateRenderPrefs({ ambience: ev.target.value })}>
                                {AMBIENCE_OPTIONS.map(([id, label]) => (
                                    <option key={id} value={id}>{_t(label)}</option>
                                ))}
                            </select>
                        </div>
                        {check("rx_ms_moodamb", _t("Mood-reactive ambience"),
                            _t("Their mood picks the ambience, then back to your pick."),
                            renderPrefs.moodAmbience,
                            (v) => updateRenderPrefs({ moodAmbience: v }))}
                        {check("rx_ms_moods", _t("Mood marks"),
                            _t("Manga-style marks by their head when their mood changes."),
                            renderPrefs.moodMarks,
                            (v) => updateRenderPrefs({ moodMarks: v }))}
                    </section>

                    <section>
                        <h3><i className="fa fa-eye-slash" /> {_t("Visibility & startup")}</h3>
                        {check("rx_ms_controls", _t("Hide avatar controls"),
                            _t("The floating controls never show, even on hover. Right-click the avatar or use the tray to get back here."),
                            controlsHidden,
                            (v) => setShell(bridge.setMascotControlsHidden, setControlsHidden, v))}
                        {check("rx_ms_hideidle", _t("Hide the avatar between calls"),
                            _t("The avatar hides while no call is live and pops back up when one starts. Pairs well with voice activation. While hidden, the tray icon brings it back."),
                            hideIdle,
                            (v) => setShell(bridge.setMascotHideIdle, setHideIdle, v))}
                        {check("rx_ms_startup", _t("Open in mascot mode"),
                            _t("Start as the desktop companion instead of the app window. From the next launch."),
                            startInMascot,
                            (v) => setShell(bridge.setStartupMascot, setStartInMascot, v))}
                    </section>

                    {/* Last on purpose: the least-used section, and a niche one. */}
                    {mascot?.motion && (
                        <section>
                            <h3><i className="fa fa-child" /> {_t("Background Avatar Motion")}</h3>
                            {!mascot.motionAvailable && (
                                <p className="rx_mascot_set_desc">
                                    {_t("No motion library installed, so these have nothing to play yet.")}
                                </p>
                            )}
                            <fieldset disabled={!alive}>
                                {check("rx_ms_speechgest",
                                    _t("Automated background gestures while speaking (experimental)"),
                                    _t("Gestures along with what they're saying. Matched per sentence by the director model, so it adds a little usage."),
                                    mascot.motion.speech_gestures,
                                    (v) => sendMotion({ speech_gestures: v }))}
                                {check("rx_ms_fidgets", _t("Idle fidgets"),
                                    _t("Small movements while they stand quietly: a weight shift, folded arms, a touch of their hair."),
                                    mascot.motion.idle_fidgets,
                                    (v) => sendMotion({ idle_fidgets: v }))}
                                {check("rx_ms_gesturezoom", _t("Zoom out for manual gestures in face view"),
                                    _t("Pulls the camera out while a chosen gesture plays (the companion's own, or a manual trigger), so the body is in shot, and eases back in afterwards. The automated ones above never move the camera."),
                                    mascot.motion.gesture_zoom_out,
                                    (v) => sendMotion({ gesture_zoom_out: v }))}
                            </fieldset>
                        </section>
                    )}
                </>}

                {tab === "emotions" && <>
                    <section>
                        <h3><i className="fa fa-smile-o" /> {_t("Emotions")}</h3>
                        <p className="text-muted">
                            {_t("Play on the desktop avatar right away, call or no call.")}
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
                    {(libraryGestures || []).length > 0 && (
                        <section>
                            <h3><i className="fa fa-folder-open-o" /> {_t("Library animations")}</h3>
                            <fieldset disabled={!alive}>
                                {/* value stays "" so the same entry can be picked again to replay it */}
                                <select value=""
                                        title={_t("Play any animation from the shared asset library once, even if it is not one of this avatar's gestures")}
                                        onChange={(ev) => { if (ev.target.value) send({ type: "libraryGesture", url: ev.target.value }); }}>
                                    <option value="">{_t("Library…")}</option>
                                    {libraryGestures.map((f) => (
                                        <option key={f.url} value={f.url}>
                                            {f.name}{f.source === "bundled" ? " " + _t("(bundled)") : ""}
                                        </option>
                                    ))}
                                </select>
                            </fieldset>
                        </section>
                    )}
                </>}
            </div>
        </div>
    );
}
