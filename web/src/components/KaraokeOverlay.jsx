import React, { useEffect, useRef } from "react";
import { useReactive } from "../lib/reactive";
import { _t } from "../lib/i18n";
import { stage } from "../models/stage";

/** Lyrics and the note lane over the avatar while the stage performs.
 *
 *  Drawn on a canvas each frame from the stage clock (no React re-render
 *  per frame). Lyrics follow UltraStar Deluxe's layout: the current line
 *  with the next one under it, the colour wiping through each syllable
 *  linearly over its note. The note lane above shows the melody as bars
 *  (golden notes gold) scrolling past a "now" line, and — when the mic is
 *  scored — the singer's own pitch, moved into the target's octave the
 *  way the scoring treats it. */

const LANE_BEFORE = 1.2;     // seconds of the lane shown behind "now"
const LANE_AFTER = 4.0;      // and ahead of it
const LANE_TOP = 118;        // px: below the topbar's two rows
const LYRICS_BOTTOM = 112;   // px: above the call controls bar

/** sidePanel: the Stage or Settings panel is open on the left, so the lane
 *  starts clear of it; closed, the lane runs the full width. laneTop and
 *  lyricsBottom (px) keep clear of the host's own chrome: the voice view's
 *  topbar and call bar by default, the mascot's controls island there.
 *  (Stopping a song lives in the host's own controls: the voice view's
 *  toolbar, the mascot's island; nothing here takes clicks.) */
export default function KaraokeOverlay({ sidePanel = false, laneTop = LANE_TOP, lyricsBottom = LYRICS_BOTTOM }) {
    const st = useReactive(stage.state);
    const canvasRef = useRef(null);
    const layoutRef = useRef(null);
    layoutRef.current = { sidePanel, laneTop, lyricsBottom };
    const visible = st.song && ["playing", "paused", "ended"].includes(st.status);

    useEffect(() => {
        if (!visible) return undefined;
        let raf = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const cv = canvasRef.current;
            if (!cv) return;
            const dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth, h = cv.clientHeight;
            if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
                cv.width = Math.round(w * dpr);
                cv.height = Math.round(h * dpr);
            }
            const g = cv.getContext("2d");
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);
            const song = stage.state.song;
            if (!song?.chart) return;
            const t = stage.state.status === "ended" ? stage.state.duration : stage.now();
            const layout = layoutRef.current;
            if (stage.state.options.lane) drawLane(g, w, h, song.chart, t, stage, layout);
            drawLyrics(g, w, h, song.chart, t, stage, layout);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [visible]);

    if (!visible) return null;
    const score = st.score;
    return (
        <div className="rx_stage_overlay">
            <canvas ref={canvasRef} className="rx_stage_canvas" />
            {score && (
                <div className="rx_stage_score" title={_t("UltraStar-style score: 9000 for notes sung in tune, 1000 for whole lines")}>
                    {Math.round(score.total).toLocaleString()}
                </div>
            )}
            {st.status === "ended" && (
                <div className="rx_stage_final">
                    <div className="rx_stage_final_title">{st.song.title}</div>
                    {score && <div className="rx_stage_final_score">{Math.round(score.total).toLocaleString()}<span> / 10,000</span></div>}
                </div>
            )}
        </div>
    );
}

function drawLane(g, w, h, chart, t, stg, { sidePanel, laneTop }) {
    const lines = chart.lines;
    const notes = [];
    for (const ln of lines) {
        if (ln.end < t - LANE_BEFORE || ln.start > t + LANE_AFTER) continue;
        for (const n of ln.notes) {
            if (n.t + n.d < t - LANE_BEFORE || n.t > t + LANE_AFTER || n.p == null) continue;
            notes.push({ n, user: stg.state.mode === "duet" && stg._isUserLine?.(ln) });
        }
    }
    if (!notes.length && !stg.state.score) return;
    // Under the voice view's two-row topbar, clear of the side panels.
    const top = laneTop, laneH = Math.min(110, h * 0.16);
    const left = sidePanel ? Math.max(16, Math.min(w * 0.45, 380)) : 16, right = w - 16;
    const nowX = left + (right - left) * (LANE_BEFORE / (LANE_BEFORE + LANE_AFTER));
    const xOf = (tt) => left + (right - left) * ((tt - (t - LANE_BEFORE)) / (LANE_BEFORE + LANE_AFTER));
    // Pitch range: this window's notes ± 2 semitones.
    const ps = notes.map((x) => x.n.p);
    const lo = (ps.length ? Math.min(...ps) : 60) - 2, hi = (ps.length ? Math.max(...ps) : 72) + 2;
    const yOf = (p) => top + laneH - ((p - lo) / Math.max(1, hi - lo)) * laneH;
    g.fillStyle = "rgba(10, 12, 24, 0.38)";
    roundRect(g, left - 8, top - 8, right - left + 16, laneH + 16, 12);
    g.fill();
    const bar = Math.max(6, laneH / Math.max(8, hi - lo) * 0.8);
    for (const { n, user } of notes) {
        const x0 = xOf(n.t), x1 = xOf(n.t + n.d);
        const y = yOf(n.p);
        const past = n.t + n.d < t;
        g.fillStyle = n.k === "g" || n.k === "rg" ? (past ? "rgba(255,210,90,0.55)" : "#ffd25a")
            : user ? (past ? "rgba(120,220,255,0.45)" : "#78dcff")
            : (past ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.85)");
        if (n.k === "f") g.fillStyle = "rgba(255,255,255,0.18)";
        roundRect(g, x0, y - bar / 2, Math.max(3, x1 - x0 - 2), bar, bar / 2);
        g.fill();
    }
    // The singer's pitch.
    const trail = stg.pitchTrail?.() || [];
    for (const p of trail) {
        if (p.midi == null || p.t < t - LANE_BEFORE) continue;
        let m = p.midi;
        const ref = p.target ?? (lo + hi) / 2;
        while (m - ref > 6) m -= 12;
        while (ref - m > 6) m += 12;
        g.fillStyle = p.hit ? "#7dff9a" : "rgba(255,120,140,0.8)";
        g.beginPath();
        g.arc(xOf(p.t), yOf(m), 3, 0, Math.PI * 2);
        g.fill();
    }
    g.strokeStyle = "rgba(255,255,255,0.7)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(nowX, top - 6);
    g.lineTo(nowX, top + laneH + 6);
    g.stroke();
}

function drawLyrics(g, w, h, chart, t, stg, { lyricsBottom }) {
    const lines = chart.lines;
    let cur = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].start - 1.0 <= t) cur = i; else break;
    }
    // Before the first line: show it coming up.
    const show = cur < 0 ? [lines[0]] : [lines[cur], lines[cur + 1]];
    const big = Math.max(20, Math.min(40, w / 26));
    const small = big * 0.72;
    const baseY = h - lyricsBottom - small * 1.3;
    show.forEach((ln, row) => {
        if (!ln) return;
        const fontPx = row === 0 && cur >= 0 ? big : small;
        g.font = `700 ${fontPx}px "Segoe UI", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
        const parts = ln.notes.map((n) => ({ n, text: n.s.startsWith("~") ? "" : n.s }));
        const widths = parts.map((p) => g.measureText(p.text).width);
        const total = widths.reduce((a, b) => a + b, 0);
        let x = (w - total) / 2;
        const y = row === 0 ? baseY : baseY + big * 1.25;
        const faded = ln.end < t;
        const user = stg.state.mode === "duet" && stg._isUserLine?.(ln);
        const sungColor = user ? "#78dcff" : "#ff8fc7";
        g.lineJoin = "round";
        parts.forEach((p, i) => {
            const width = widths[i];
            if (!p.text) return;
            // The syllable's note span covers its '~' continuations too.
            const n = p.n;
            let end = n.t + n.d;
            for (let j = i + 1; j < parts.length && !parts[j].text; j++) end = parts[j].n.t + parts[j].n.d;
            const frac = Math.min(1, Math.max(0, (t - n.t) / Math.max(0.01, end - n.t)));
            g.lineWidth = Math.max(3, fontPx / 7);
            g.strokeStyle = "rgba(10, 10, 20, 0.85)";
            g.strokeText(p.text, x, y);
            g.fillStyle = faded ? "rgba(255,255,255,0.55)" : "#ffffff";
            g.fillText(p.text, x, y);
            if (frac > 0) {
                g.save();
                g.beginPath();
                g.rect(x, y - fontPx * 1.1, width * frac, fontPx * 1.5);
                g.clip();
                g.fillStyle = sungColor;
                g.fillText(p.text, x, y);
                g.restore();
            }
            x += width;
        });
    });
}

function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
}
