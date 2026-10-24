import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { useCaptionPrefs } from "../lib/caption_prefs";
import { CAPTIONS_CHANNEL } from "../services/caption_feed";
import Captions, { captionSize } from "./Captions.jsx";

/** Desktop captions window (/#captions) — a transparent always-on-top strip
 *  that opens with the mascot and shows its call's captions, fed over a
 *  BroadcastChannel by the call's page (caption_feed). Two states, set from
 *  the mascot settings: move mode (a dashed frame to drag, a corner grip to
 *  resize, sample text to size it by) and locked (just the words — the
 *  shell makes the window click-through). The caption size pref (set in the
 *  mascot settings) sets the text, the strip's height how many whole lines
 *  show. */
export default function CaptionsWindowView() {
    const bridge = window.rexclawDesktop;
    const [lines, setLines] = useState([]);
    const [locked, setLocked] = useState(true);
    const [prefs] = useCaptionPrefs();
    const px = captionSize(prefs.stripSize)[3];
    // Whole lines that fit the strip: each is 1.3em, plus the text box's
    // 0.3em of padding (captions.scss).
    const [fit, setFit] = useState(1);
    const areaRef = useRef(null);
    const resizeRef = useRef(null);

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return undefined;
        const measure = () => setFit(Math.max(1, Math.floor((area.clientHeight - 0.3 * px) / (1.3 * px))));
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(area);
        return () => ro.disconnect();
    }, [px]);

    useEffect(() => { document.title = _t("Captions"); }, []);

    useEffect(() => {
        const ch = new BroadcastChannel(CAPTIONS_CHANNEL);
        ch.onmessage = (ev) => {
            if (ev.data?.type === "captions") setLines(ev.data.lines || []);
        };
        return () => ch.close();
    }, []);

    useEffect(() => {
        bridge?.captionsPrefs?.().then((p) => setLocked(p?.locked !== false)).catch(() => {});
        bridge?.onCaptionsPrefs?.((p) => setLocked(p?.locked !== false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Corner grip: the shell sizes the window (native resize of a
    // transparent window is unreliable on Windows), measured from where the
    // drag started so rounding never compounds.
    const onGripDown = (ev) => {
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        resizeRef.current = { x: ev.screenX, y: ev.screenY, w: window.innerWidth, h: window.innerHeight };
    };
    const onGripMove = (ev) => {
        const r = resizeRef.current;
        if (!r) return;
        bridge?.captionsResize?.({ width: r.w + ev.screenX - r.x, height: r.h + ev.screenY - r.y });
    };
    const onGripUp = () => { resizeRef.current = null; };

    return (
        <div className={"rx_captions_win" + (locked ? "" : " is-editing")}>
            {!locked && (
                <div className="rx_captions_win_bar">
                    <span><i className="fa fa-arrows" /> {_t("Drag to move, corner to resize")}</span>
                    <button className="btn btn-sm btn-primary" onClick={() => bridge?.setCaptionsLocked?.(true)}>
                        {_t("Done")}
                    </button>
                </div>
            )}
            <div className="rx_captions_win_area" ref={areaRef}>
                <Captions lines={lines}
                          sample={locked ? "" : _t("Your companion's words appear here as they speak.")}
                          style={{ fontSize: `${px}px`, "--rx-caption-lines": fit }} />
            </div>
            {!locked && (
                <div className="rx_captions_win_grip" title={_t("Resize")}
                     onPointerDown={onGripDown} onPointerMove={onGripMove}
                     onPointerUp={onGripUp} onPointerCancel={onGripUp} />
            )}
        </div>
    );
}
