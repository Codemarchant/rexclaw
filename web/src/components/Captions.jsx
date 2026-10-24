import React, { useRef } from "react";
import { useReactive } from "../lib/reactive";
import { captions } from "../services/caption_feed";

/** Caption text sizes: [id, English label, full-screen scale, desktop strip
 *  px]. Medium is the default — the full-screen view's own responsive size,
 *  and in the strip ~42 characters across its default 900 px width. */
export const CAPTION_SIZES = [
    ["s", "Small", 0.8, 26],
    ["m", "Medium", 1, 36],
    ["l", "Large", 1.25, 48],
    ["xl", "Extra large", 1.5, 64],
];
export const captionSize = (id) => CAPTION_SIZES.find((s) => s[0] === id) || CAPTION_SIZES[1];

/** Stream captions: the companion's words rolling up from the bottom,
 *  `--rx-caption-lines` lines tall (older text slides off the top).
 *  Outlined text, no box, so it reads over any scene or desktop. Fades out
 *  when the lines clear, keeping the last words on screen for the fade.
 *  `sample` stands in while there is nothing to show (the captions window's
 *  move mode). */
export default function Captions({ lines, sample = "", style }) {
    const last = useRef([]);
    if (lines.length) last.current = lines;
    const shown = lines.length ? lines : sample
        ? [{ id: "sample", speaker: "", text: sample }]
        : last.current;
    return (
        <div className={"rx_captions" + (lines.length || sample ? " is-visible" : "")} style={style}
             aria-live="polite">
            <div className="rx_captions_text">
                {shown.map((l) => (
                    <div key={l.id} className="rx_captions_line">
                        {l.speaker && <span className="rx_captions_speaker">{l.speaker}: </span>}
                        {l.text}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** In-page captions straight off the feed, `lines` text lines tall at the
 *  `size` step. Its own component so the 10 Hz updates re-render only this,
 *  not the view around it. */
export function LiveCaptions({ lines, size }) {
    const cap = useReactive(captions);
    return (
        <Captions lines={cap.lines}
                  style={{ "--rx-caption-lines": lines, "--rx-caption-scale": captionSize(size)[2] }} />
    );
}
