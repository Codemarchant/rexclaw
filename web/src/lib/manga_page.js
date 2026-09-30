/**
 * Manga Diary — page layout, inking and lettering.
 *
 * The photoshoot (lib/manga_shoot.js) hands over one photo per panel as
 * separate layers — the avatar with a transparent surround, and the 2D
 * backdrop — plus where the face landed. This file turns those into a
 * manga page:
 *
 *   layout  — tiers of slanted panels planned from the storyboard (one
 *             large climax panel breaks the frame); a four-panel strip for
 *             yonkoma.
 *   inking  — each layer traced into black line art (Sobel edges on the
 *             luminance, a heavier contour round the figure) and flat
 *             screentones (luminance quantized into a few tone levels, each
 *             printed as a 45° dot screen), the way manga backgrounds are
 *             traced from photos. The backdrop is inked lighter and finer so
 *             the figure reads first. "Color" keeps the colours under the
 *             same ink.
 *   letters — balloons placed where they cover neither the face nor (when
 *             they can help it) the figure, tails aimed at the mouth or out
 *             of panel for the off-panel user, captions, sound effects,
 *             manga symbols by the head and the background effects (focus
 *             lines, speed lines, sparkles, gloom, flowers).
 *
 * All sizes are page pixels and design values, tuned by eye. Randomness is
 * seeded from the title so a page re-inks the same way.
 */
import { GLYPHS } from "../services/mood_marks";

const TAU = Math.PI * 2;

const PAGE = { w: 1600, h: 2262, side: 70, top: 196, bottom: 92, gutterX: 24, gutterY: 36 };
const STRIP = { w: 1100, panelH: 560, side: 60, top: 170, bottom: 84, gutterY: 28 };
const BORDER = 5;
const SLANT_Y = 60;           // px, rise across a tier boundary
const SLANT_X = 70;           // px, lean of a column divider
const CAPTURE_SLACK = 1.12;   // photo is this much bigger than its panel, room to recompose
const BREAKOUT_BLEED = 0.24;  // × panel height of photo kept above a frame-breaking panel

const LETTER_FONT = '"Comic Sans MS", "Comic Neue", "Yu Gothic UI", "Hiragino Maru Gothic ProN", Meiryo, sans-serif';
const DISPLAY_FONT = '"Arial Black", Impact, "Yu Gothic UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';

// Tone levels (fraction of ink) the luminance snaps to, darkest last.
const FIGURE_TONES = [
    { below: 0.2, ink: 0 },
    { below: 0.42, ink: 0.14 },
    { below: 0.6, ink: 0.3 },
    { below: 0.8, ink: 0.5 },
    { below: 2, ink: 1 },
];
const BACKDROP_TONES = [
    { below: 0.22, ink: 0 },
    { below: 0.45, ink: 0.08 },
    { below: 0.65, ink: 0.18 },
    { below: 0.85, ink: 0.3 },
    { below: 2, ink: 0.45 },
];

// ── helpers ────────────────────────────────────────────────────────────

function seeded(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

function polyPath(ctx, poly) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
}

function insidePoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// A tier boundary is the line y = a + b·x; a column divider x = c + d·y.
function meet(h, v) {
    const x = (v.c + v.d * h.a) / (1 - v.d * h.b);
    return [x, h.a + h.b * x];
}

// ── layout ─────────────────────────────────────────────────────────────

function* tierings(n) {
    if (n === 0) { yield []; return; }
    for (const k of [1, 2]) {
        if (k <= n) for (const rest of tierings(n - k)) yield [k, ...rest];
    }
}

/** Which panels share a tier. Three tiers read best; a large panel or an
 *  establishing wide shot wants a tier to itself, an ordinary talking
 *  panel alone across the page wastes it. */
function planTiers(panels) {
    let best = null;
    let bestScore = Infinity;
    for (const tiers of tierings(panels.length)) {
        if (tiers.length < 2 || tiers.length > 4) continue;
        let score = Math.abs(tiers.length - 3) * 2;
        let i = 0;
        let lastSingle = false;
        for (const k of tiers) {
            const ps = panels.slice(i, i + k);
            const big = ps.some((p) => p.size === "large");
            if (k === 2 && big) score += 20;
            if (k === 1) {
                const p = ps[0];
                score += big || p.shot === "wide" || p.shot === "full" ? -1 : 1.5;
                if (lastSingle) score += 1;
            }
            lastSingle = k === 1;
            i += k;
        }
        if (score < bestScore) { bestScore = score; best = tiers; }
    }
    return best || panels.map(() => 1);
}

/** Panel geometry for a script: page size, and per panel its polygon, its
 *  bounding box, the region its photo covers (`region`, taller than the box
 *  when the panel breaks the frame) and the photo size to shoot. */
export function layoutPage(script) {
    const rand = seeded(script.title || "manga");
    const panels = script.panels || [];
    const out = [];
    if (script.layout === "yonkoma") {
        const S = STRIP;
        const height = S.top + panels.length * S.panelH + (panels.length - 1) * S.gutterY + S.bottom;
        panels.forEach((p, i) => {
            const y = S.top + i * (S.panelH + S.gutterY);
            const box = { x: S.side, y, w: S.w - S.side * 2, h: S.panelH };
            out.push(finishPanel(p, i, box, [[box.x, y], [box.x + box.w, y],
                [box.x + box.w, y + box.h], [box.x, y + box.h]], false));
        });
        return { width: S.w, height, panels: out };
    }
    const P = PAGE;
    const tiers = planTiers(panels);
    const weights = [];
    let pi = 0;
    for (const k of tiers) {
        const ps = panels.slice(pi, pi + k);
        weights.push(ps.some((p) => p.size === "large") ? 1.55
            : k === 1 && ps[0].shot === "closeup" ? 0.8 : 1);
        pi += k;
    }
    const x0 = P.side;
    const x1 = P.w - P.side;
    const cx = (x0 + x1) / 2;
    const free = P.h - P.top - P.bottom - P.gutterY * (tiers.length - 1);
    const total = weights.reduce((s, w) => s + w, 0);
    // Boundaries between tiers, each a (possibly) slanted line through its
    // nominal height; a third of them stay level so the page can breathe.
    const bounds = [{ a: P.top, b: 0 }];
    let y = P.top;
    weights.forEach((w, t) => {
        y += (free * w) / total;
        if (t < weights.length - 1) {
            const mid = y + P.gutterY / 2;
            const b = rand() < 0.33 ? 0 : ((rand() - 0.5) * 2 * SLANT_Y) / (x1 - x0);
            bounds.push({ a: mid - b * cx, b });
            y += P.gutterY;
        }
    });
    bounds.push({ a: P.h - P.bottom, b: 0 });
    const edge = (t, side) => {
        const g = t === 0 || t === bounds.length - 1 ? 0 : (side * P.gutterY) / 2;
        return { a: bounds[t].a + g, b: bounds[t].b };
    };
    pi = 0;
    tiers.forEach((k, t) => {
        const top = edge(t, 1);
        const bot = edge(t + 1, -1);
        if (k === 1) {
            const p = panels[pi];
            const poly = [[x0, top.a + top.b * x0], [x1, top.a + top.b * x1],
                [x1, bot.a + bot.b * x1], [x0, bot.a + bot.b * x0]];
            // The climax breaks the frame — unless it heads the page, where
            // the head would run into the title.
            out.push(finishPanel(p, pi, boxOf(poly), poly, p.size === "large" && t > 0));
        } else {
            const [pa, pb] = [panels[pi], panels[pi + 1]];
            // The close-up (or the small one) takes the narrower column.
            let f = 0.5;
            if ((pa.shot === "closeup") !== (pb.shot === "closeup")) f = pa.shot === "closeup" ? 0.42 : 0.58;
            else if ((pa.size === "small") !== (pb.size === "small")) f = pa.size === "small" ? 0.42 : 0.58;
            const lean = (rand() - 0.5) * 2 * SLANT_X;
            const ym = (top.a + top.b * cx + bot.a + bot.b * cx) / 2;
            const hgt = Math.max(1, (bot.a - top.a));
            const d = -lean / hgt;
            const xm = x0 + (x1 - x0) * f;
            const div = (g) => ({ c: xm + g - d * ym, d });
            const L = div(-P.gutterX / 2);
            const R = div(P.gutterX / 2);
            const left = [[x0, top.a + top.b * x0], meet(top, L), meet(bot, L), [x0, bot.a + bot.b * x0]];
            const right = [meet(top, R), [x1, top.a + top.b * x1], [x1, bot.a + bot.b * x1], meet(bot, R)];
            out.push(finishPanel(pa, pi, boxOf(left), left, false));
            out.push(finishPanel(pb, pi + 1, boxOf(right), right, false));
        }
        pi += k;
    });
    return { width: P.w, height: P.h, panels: out };
}

function boxOf(poly) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function finishPanel(panel, index, box, poly, breakout) {
    const bleed = breakout ? Math.round(box.h * BREAKOUT_BLEED) : 0;
    const region = { x: box.x, y: box.y - bleed, w: box.w, h: box.h + bleed };
    return {
        index, poly, box, region, breakout,
        shotW: Math.round(region.w * CAPTURE_SLACK),
        shotH: Math.round(region.h * CAPTURE_SLACK),
    };
}

// ── inking ─────────────────────────────────────────────────────────────

/** Printed dot screen: true where a pixel of a flat `ink` tone is black.
 *  Round dots on a 45° grid (manga screentone), area = ink. */
function dot(x, y, ink, period) {
    if (ink <= 0) return false;
    if (ink >= 1) return true;
    const u = ((x + y) * Math.SQRT1_2) / period;
    const v = ((x - y) * Math.SQRT1_2) / period;
    const fu = u - Math.floor(u) - 0.5;
    const fv = v - Math.floor(v) - 0.5;
    // Past half coverage the dots merge: print white dots on black instead.
    if (ink > 0.5) return fu * fu + fv * fv >= (1 - ink) / Math.PI;
    return fu * fu + fv * fv < ink / Math.PI;
}

function toneFor(tones, dark) {
    for (const t of tones) if (dark < t.below) return t.ink;
    return 1;
}

/** Ink one layer in place. `figure` layers get the heavy contour and the
 *  full tone range; the backdrop gets finer dots, lighter tones and only
 *  its stronger edges. */
function inkLayer(cv, { figure, color }) {
    const w = cv.width;
    const h = cv.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const n = w * h;
    const lum = new Float32Array(n);
    const alpha = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const a = d[j + 3] / 255;
        alpha[i] = d[j + 3];
        // Over white, so a silhouette edge reads as an edge.
        lum[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
    }
    // The backdrop is a photo: soften its grain before tracing it.
    let src = lum;
    if (!figure) {
        src = new Float32Array(n);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                let c = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        s += lum[yy * w + xx];
                        c++;
                    }
                }
                src[y * w + x] = s / c;
            }
        }
    }
    const edgeT = figure ? 150 : 210;
    const tones = figure ? FIGURE_TONES : BACKDROP_TONES;
    const period = figure ? 6 : 5;
    const hasAlpha = figure && alpha.some((a) => a < 250);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const j = i * 4;
            if (figure && alpha[i] < 8) { d[j + 3] = 0; continue; }
            let edge = false;
            if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
                const tl = src[i - w - 1], t = src[i - w], tr = src[i - w + 1];
                const l = src[i - 1], r = src[i + 1];
                const bl = src[i + w - 1], b = src[i + w], br = src[i + w + 1];
                const gx = tr + 2 * r + br - tl - 2 * l - bl;
                const gy = bl + 2 * b + br - tl - 2 * t - tr;
                edge = gx * gx + gy * gy > edgeT * edgeT;
            }
            // Contour: the figure's silhouette, two pixels thick.
            if (!edge && hasAlpha && alpha[i] > 128) {
                for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
                    const xx = x + ox;
                    const yy = y + oy;
                    if (xx < 0 || yy < 0 || xx >= w || yy >= h || alpha[yy * w + xx] <= 128) { edge = true; break; }
                }
            }
            const dark = 1 - lum[i] / 255;
            if (color) {
                if (edge) {
                    d[j] = d[j + 1] = d[j + 2] = 20;
                } else {
                    // Colour keeps its hue; shadows pick up a dot screen and
                    // the backdrop is washed out so the figure leads.
                    const shade = dark > 0.55 && dot(x, y, 0.22, period) ? 0.7 : 1;
                    const wash = figure ? 0 : 0.35;
                    for (let k = 0; k < 3; k++) d[j + k] = (d[j + k] * (1 - wash) + 255 * wash) * shade;
                }
            } else {
                const v = edge || dot(x, y, toneFor(tones, dark), period) ? 0 : 255;
                d[j] = d[j + 1] = d[j + 2] = v;
            }
            if (figure) d[j + 3] = alpha[i] > 128 ? 255 : alpha[i] * 2;
        }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
}

// ── effects (drawn behind the figure) ──────────────────────────────────

function drawEffect(ctx, kind, region, face, rand, color) {
    const { w, h } = region;
    const fx = face ? face.x : w / 2;
    const fy = face ? face.y : h * 0.4;
    const fr = face ? face.r : h * 0.12;
    ctx.save();
    if (kind === "focus") {
        // Wedges from beyond the frame, stopping short of the face.
        const reach = Math.hypot(Math.max(fx, w - fx), Math.max(fy, h - fy)) + 20;
        ctx.fillStyle = "#000";
        for (let i = 0; i < 150; i++) {
            const a = rand() * TAU;
            const inner = fr * (2.6 + rand() * 1.8);
            const half = (0.0025 + rand() * 0.006) * TAU / 2;
            ctx.beginPath();
            ctx.moveTo(fx + Math.cos(a) * inner, fy + Math.sin(a) * inner);
            ctx.lineTo(fx + Math.cos(a - half) * reach, fy + Math.sin(a - half) * reach);
            ctx.lineTo(fx + Math.cos(a + half) * reach, fy + Math.sin(a + half) * reach);
            ctx.closePath();
            ctx.fill();
        }
    } else if (kind === "speed") {
        ctx.strokeStyle = "#000";
        for (let i = 0; i < 90; i++) {
            const y = rand() * h;
            const len = w * (0.25 + rand() * 0.6);
            const x = rand() * (w - len * 0.5) - len * 0.25;
            ctx.lineWidth = 0.8 + rand() * 2.4;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + len, y);
            ctx.stroke();
        }
    } else if (kind === "gloom") {
        // Vertical shadow lines (縦線) hanging from the top.
        ctx.strokeStyle = "#000";
        for (let x = 4; x < w; x += 7 + rand() * 5) {
            ctx.lineWidth = 1 + rand() * 1.6;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h * (0.35 + rand() * 0.45));
            ctx.stroke();
        }
    } else if (kind === "sparkle" || kind === "flowers") {
        const count = kind === "sparkle" ? 26 : 16;
        for (let i = 0; i < count; i++) {
            const x = rand() * w;
            const y = rand() * h;
            if (Math.hypot(x - fx, y - fy) < fr * 2.2) continue;
            const s = fr * (0.18 + rand() * 0.45);
            if (kind === "sparkle") drawSparkle(ctx, x, y, s, color);
            else drawFlower(ctx, x, y, s, rand() * TAU, color);
        }
        if (kind === "sparkle") {
            // Soft bokeh circles behind the sparkles, shoujo style.
            ctx.globalAlpha = 0.25;
            for (let i = 0; i < 10; i++) {
                ctx.beginPath();
                ctx.arc(rand() * w, rand() * h, fr * (0.4 + rand()), 0, TAU);
                ctx.strokeStyle = "#000";
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }
    ctx.restore();
}

function drawSparkle(ctx, x, y, s, color) {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU - Math.PI / 2;
        const r = k % 2 === 0 ? s : s * 0.18;
        ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = color ? "#fff6b0" : "#fff";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
}

function drawFlower(ctx, x, y, s, rot, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = color ? "#ffd6e6" : "#fff";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
        ctx.rotate(TAU / 5);
        ctx.beginPath();
        ctx.ellipse(0, -s * 0.55, s * 0.32, s * 0.5, 0, 0, TAU);
        ctx.fill();
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.22, 0, TAU);
    ctx.fillStyle = color ? "#ffe27a" : "#fff";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

// ── manga symbols by the head ──────────────────────────────────────────

function paintHeart(ctx, s) {
    const p = new Path2D();
    p.moveTo(s * 0.5, s * 0.84);
    p.bezierCurveTo(s * 0.12, s * 0.58, s * 0.06, s * 0.3, s * 0.28, s * 0.2);
    p.bezierCurveTo(s * 0.4, s * 0.15, s * 0.48, s * 0.24, s * 0.5, s * 0.33);
    p.bezierCurveTo(s * 0.52, s * 0.24, s * 0.6, s * 0.15, s * 0.72, s * 0.2);
    p.bezierCurveTo(s * 0.94, s * 0.3, s * 0.88, s * 0.58, s * 0.5, s * 0.84);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = s * 0.1;
    ctx.stroke(p);
    ctx.strokeStyle = "#3b2a33";
    ctx.lineWidth = s * 0.045;
    ctx.stroke(p);
    ctx.fillStyle = "#ff5c8a";
    ctx.fill(p);
}

function drawMark(ctx, mark, face, side, color, region) {
    const painter = mark === "heart" ? paintHeart : GLYPHS[mark];
    if (!painter || !face) return;
    const s = Math.max(40, Math.min(face.r * 1.25, region.h * 0.18));
    const tile = canvas(s, s);
    painter(tile.getContext("2d"), s);
    // Above the head for the cloud and the bulb, beside it for the rest —
    // kept inside the panel, which a close-up's head nearly fills.
    const above = mark === "gloom" || mark === "bulb";
    const pad = s * 0.15;
    const clampTo = (v, max) => Math.min(Math.max(v, pad), max - s - pad);
    const x = clampTo(above ? face.x - s / 2 : face.x + side * face.r * 1.55 - s / 2, region.w);
    const y = clampTo(above ? face.y - face.r * 2.9 - s / 2 : face.y - face.r * 1.25 - s / 2, region.h);
    ctx.save();
    if (!color) ctx.filter = "grayscale(1) contrast(1.6)";
    ctx.drawImage(tile, x, y);
    ctx.restore();
}

// ── lettering ──────────────────────────────────────────────────────────

const CJK_RE = /[぀-ヿ㐀-鿿가-힯＀-￯]/;

function wrap(ctx, text, maxW) {
    const cjk = CJK_RE.test(text) && !/\s/.test(text.trim());
    const tokens = cjk ? [...text] : text.split(/\s+/).filter(Boolean);
    const joiner = cjk ? "" : " ";
    const lines = [];
    let line = "";
    for (const tok of tokens) {
        const next = line ? line + joiner + tok : tok;
        if (line && ctx.measureText(next).width > maxW) {
            lines.push(line);
            line = tok;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** Wrap a balloon's text into the roundest block that fits `maxW`. */
function setBlock(ctx, text, px, maxW) {
    let best = null;
    for (let tw = px * 4; tw <= maxW; tw += px) {
        const lines = wrap(ctx, text, tw);
        const bw = Math.max(...lines.map((l) => ctx.measureText(l).width));
        const bh = lines.length * px * 1.18;
        const score = Math.abs(bh / Math.max(bw, 1) - 0.62) + (bw > maxW ? 10 : 0);
        if (!best || score < best.score) best = { lines, bw, bh, score };
    }
    return best || { lines: [text], bw: ctx.measureText(text).width, bh: px * 1.18 };
}

function letterFont(px, bold) {
    return `${bold ? "bold " : ""}${Math.round(px)}px ${LETTER_FONT}`;
}

function ellipsePts(cx, cy, rx, ry, count) {
    const pts = [];
    for (let k = 0; k < count; k++) {
        const a = (k / count) * TAU;
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return pts;
}

function rectOverlap(a, b) {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (x * y) / Math.max(1, a.w * a.h);
}

/** Best spot for an ellipse of rx×ry inside the panel. Penalties, largest
 *  first: covering a face, leaving the panel, covering other lettering,
 *  covering the figure; then reading order (first balloon high and toward
 *  the start of the line) and distance from the speaker's face, when the
 *  speaker is drawn. */
function placeEllipse(panel, rx, ry, { faces, speaker, taken, figureAt, order }) {
    const { box, poly } = panel;
    let best = null;
    const xsN = 9;
    const ysN = 7;
    // Centres may sit close enough to the edge that a balloon leans over
    // the border, as manga balloons do; the outside samples price it.
    const lean = 0.7;
    const x0 = box.x + rx * lean;
    const y0 = box.y + ry * lean;
    const xr = Math.max(0, box.w - 2 * rx * lean);
    const yr = Math.max(0, box.h - 2 * ry * lean);
    for (let ix = 0; ix < xsN; ix++) {
        for (let iy = 0; iy < ysN; iy++) {
            const cx = x0 + (xr * ix) / (xsN - 1);
            const cy = y0 + (yr * iy) / (ysN - 1);
            let s = 0;
            for (const face of faces) {
                const k = ((face.x - cx) / (rx + face.r * 1.25)) ** 2 + ((face.y - cy) / (ry + face.r * 1.25)) ** 2;
                if (k < 1) s += 500 * (1 - k) + 200;
            }
            const pts = ellipsePts(cx, cy, rx, ry, 20);
            for (const [px, py] of pts) {
                if (!insidePoly(poly, px, py)) s += 45;
                if (figureAt && figureAt(px, py)) s += 9;
            }
            if (figureAt && figureAt(cx, cy)) s += 20;
            // Lettering over lettering: a touch is the manga linked-balloon
            // look; past a fifth of the balloon it hides words, and that
            // costs more than anything else here (face, border, figure).
            const rect = { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
            let overlap = 0;
            for (const t of taken) {
                const o = rectOverlap(rect, t);
                overlap = Math.max(overlap, o);
                s += o <= 0.2 ? o * 300 : 60 + (o - 0.2) * 3000;
            }
            const ny = (cy - box.y) / box.h;
            const nx = (cx - box.x) / box.w;
            s += order === 0 ? ny * 30 + nx * 12 : ny * 8;
            if (speaker) s += (Math.hypot(speaker.x - cx, speaker.y - cy) / box.h) * 22;
            if (!best || s < best.s) best = { cx, cy, s, overlap };
        }
    }
    return best;
}

function tailPoints(b, target, width) {
    const dx = target[0] - b.cx;
    const dy = target[1] - b.cy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    return {
        base1: [b.cx + nx * width, b.cy + ny * width],
        base2: [b.cx - nx * width, b.cy - ny * width],
        tip: target,
        bend: [b.cx + dx * 0.6 + nx * width * 0.6, b.cy + dy * 0.6 + ny * width * 0.6],
    };
}

function balloonBody(b, rand) {
    const p = new Path2D();
    if (b.style === "shout") {
        const spikes = 22;
        for (let k = 0; k <= spikes * 2; k++) {
            const a = (k / (spikes * 2)) * TAU;
            const r = k % 2 === 0 ? 1.2 + rand() * 0.12 : 0.98;
            const x = b.cx + Math.cos(a) * b.rx * r;
            const y = b.cy + Math.sin(a) * b.ry * r;
            k ? p.lineTo(x, y) : p.moveTo(x, y);
        }
        p.closePath();
    } else if (b.style === "thought") {
        const bump = Math.min(b.rx, b.ry) * 0.3;
        const per = TAU * Math.sqrt((b.rx * b.rx + b.ry * b.ry) / 2);
        const count = Math.max(8, Math.round(per / (bump * 1.5)));
        for (let k = 0; k < count; k++) {
            const a = (k / count) * TAU;
            const x = b.cx + Math.cos(a) * b.rx;
            const y = b.cy + Math.sin(a) * b.ry;
            p.moveTo(x + bump, y);
            p.arc(x, y, bump * (0.9 + rand() * 0.25), 0, TAU);
        }
        p.moveTo(b.cx + b.rx, b.cy);
        p.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, TAU);
    } else {
        p.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, TAU);
    }
    return p;
}

function drawBalloon(ctx, b, rand) {
    const body = balloonBody(b, rand);
    const tails = [];
    if (b.tailTo) {
        if (b.style === "thought") {
            // Trail of shrinking bubbles toward the thinker.
            for (let k = 1; k <= 3; k++) {
                const t = 0.55 + k * 0.14;
                const x = b.cx + (b.tailTo[0] - b.cx) * t;
                const y = b.cy + (b.tailTo[1] - b.cy) * t;
                const p = new Path2D();
                p.arc(x, y, Math.min(b.rx, b.ry) * (0.2 - k * 0.045), 0, TAU);
                tails.push(p);
            }
        } else {
            const t = tailPoints(b, b.tailTo, Math.min(b.rx, b.ry) * 0.26);
            const p = new Path2D();
            p.moveTo(...t.base1);
            p.quadraticCurveTo(...t.bend, ...t.tip);
            p.lineTo(...t.base2);
            p.closePath();
            tails.push(p);
        }
    }
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = b.style === "shout" ? 4.5 : 3.6;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    if (b.style === "whisper") ctx.setLineDash([12, 8]);
    // Stroke every part, then fill them all: the fills cover the strokes
    // where tail meets body, leaving one outline round the union.
    for (const p of tails) ctx.stroke(p);
    ctx.stroke(body);
    for (const p of tails) ctx.fill(p);
    ctx.fill(body);
    ctx.setLineDash([]);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = letterFont(b.px, b.style === "shout");
    const lh = b.px * 1.18;
    b.lines.forEach((line, i) => {
        ctx.fillText(line, b.cx, b.cy - b.bh / 2 + lh * (i + 0.5));
    });
    ctx.restore();
}

function letterPanel(ctx, panel, spec, face, others, figureAt, rand, color) {
    const { box, poly } = panel;
    const taken = [];
    const base = Math.max(24, Math.min(38, box.h * 0.055, box.w * 0.05));

    if (spec.caption) {
        ctx.save();
        const px = base * 0.82;
        ctx.font = letterFont(px, false);
        const text = spec.caption.toUpperCase();
        const block = setBlock(ctx, text, px, Math.min(box.w * 0.5, 460));
        const w = block.bw + px * 1.2;
        const h = block.bh + px * 0.9;
        // Top-left corner, nudged down until it clears a slanted top edge;
        // the top-right when the face is in that corner.
        const faceLeft = face && face.x < box.x + box.w * 0.4 && face.y < box.y + box.h * 0.45;
        let x = faceLeft ? box.x + box.w - w - 14 : box.x + 14;
        let y = box.y + 14;
        while (y < box.y + box.h * 0.4 && !(insidePoly(poly, x, y) && insidePoly(poly, x + w, y))) y += 3;
        ctx.fillStyle = color ? "#fffbe8" : "#fff";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = "#000";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        block.lines.forEach((line, i) => ctx.fillText(line, x + w / 2, y + px * 0.45 + px * 1.18 * (i + 0.5)));
        ctx.restore();
        taken.push({ x, y, w, h });
    }

    const balloons = [];
    (spec.lines || []).forEach((line, order) => {
        let px = line.style === "whisper" ? base * 0.9 : line.style === "shout" ? base * 1.1 : base;
        const text = line.text.toUpperCase();
        let block;
        let rx;
        let ry;
        let spot;
        // The speaker's face when they're drawn here; the companion's own
        // lines are "companion". Anyone not in the panel speaks off-panel.
        const speaker = line.who === "companion" ? face : others[line.who] || null;
        // Smaller lettering when the balloon won't fit the panel, or when
        // the panel is too crowded for it to find a spot of its own.
        for (let attempt = 0; attempt < 4; attempt++) {
            ctx.font = letterFont(px, line.style === "shout");
            block = setBlock(ctx, text, px, box.w * 0.42);
            const pad = px * 0.5;
            rx = (block.bw / 2) * 1.38 + pad;
            ry = (block.bh / 2) * 1.38 + pad;
            const last = attempt === 3 || px * 0.84 < 16;
            if (!last && !(rx * 2 < box.w * 0.9 && ry * 2 < box.h * 0.85)) {
                px *= 0.84;
                continue;
            }
            spot = placeEllipse(panel, rx, ry, {
                faces: [face, ...Object.values(others)].filter(Boolean), speaker, taken, figureAt, order,
            });
            if (last || spot.overlap <= 0.2) break;
            px *= 0.84;
        }
        const b = { ...block, px, rx, ry, cx: spot.cx, cy: spot.cy, style: line.style };
        if (speaker) {
            // Aim at the speaker's mouth, stop short of the face.
            const mx = speaker.x;
            const my = speaker.y + speaker.r * 0.45;
            const dx = b.cx - mx;
            const dy = b.cy - my;
            const len = Math.hypot(dx, dy) || 1;
            const stop = Math.min(len - Math.min(rx, ry) * 0.5, speaker.r * 1.25);
            b.tailTo = [mx + (dx / len) * stop, my + (dy / len) * stop];
        } else {
            // Off-panel speaker: the tail runs out through the nearest
            // side or bottom edge (never the top — no one speaks from there).
            const opts = [
                [b.cx, box.y + box.h + 10, box.y + box.h - b.cy],
                [box.x - 10, b.cy, b.cx - box.x],
                [box.x + box.w + 10, b.cy, box.x + box.w - b.cx],
            ];
            opts.sort((a, c) => a[2] - c[2]);
            b.tailTo = [opts[0][0], opts[0][1]];
            if (Math.hypot(b.tailTo[0] - b.cx, b.tailTo[1] - b.cy) > Math.max(rx, ry) * 2.4) {
                const t = (Math.max(rx, ry) * 2.4) / Math.hypot(b.tailTo[0] - b.cx, b.tailTo[1] - b.cy);
                b.tailTo = [b.cx + (b.tailTo[0] - b.cx) * t, b.cy + (b.tailTo[1] - b.cy) * t];
            }
        }
        balloons.push(b);
        taken.push({ x: b.cx - rx, y: b.cy - ry, w: rx * 2, h: ry * 2 });
    });
    balloons.forEach((b) => drawBalloon(ctx, b, rand));

    if (spec.sfx) drawSfx(ctx, panel, spec.sfx, face, taken, rand, color);
}

/** Hand-drawn-looking sound effect: heavy letters, each tilted and bounced
 *  a little, black with a white keyline, in the emptiest corner. */
function drawSfx(ctx, panel, text, face, taken, rand, color) {
    const { box } = panel;
    const chars = [...text.toUpperCase()];
    const px = Math.min(box.h * 0.2, (box.w * 0.55) / Math.max(2, chars.length * 0.8));
    ctx.save();
    ctx.font = `${Math.round(px)}px ${DISPLAY_FONT}`;
    const widths = chars.map((c) => ctx.measureText(c).width * 0.92);
    const tw = widths.reduce((s, w) => s + w, 0);
    const spots = [
        [box.x + box.w * 0.08, box.y + box.h * 0.9],
        [box.x + box.w * 0.92 - tw, box.y + box.h * 0.9],
        [box.x + box.w * 0.92 - tw, box.y + box.h * 0.3],
        [box.x + box.w * 0.08, box.y + box.h * 0.3],
    ];
    let best = spots[0];
    let bestS = Infinity;
    for (const [x, y] of spots) {
        const rect = { x, y: y - px, w: tw, h: px };
        let s = taken.reduce((acc, t) => acc + rectOverlap(rect, t) * 100, 0);
        if (face && Math.hypot(face.x - (x + tw / 2), face.y - (y - px / 2)) < face.r * 2 + tw / 2) s += 80;
        if (s < bestS) { bestS = s; best = [x, y]; }
    }
    const tilt = (rand() - 0.5) * 0.35;
    ctx.translate(best[0], best[1]);
    ctx.rotate(tilt);
    // Each letter's jitter, fixed up front: the keylines go down in one pass
    // and the fills in a second, so a letter's white keyline never paints
    // over the letter before it where they overlap.
    let x = 0;
    const placed = chars.map((c, i) => {
        const at = { c, x, y: (rand() - 0.5) * px * 0.25, rot: (rand() - 0.5) * 0.3,
                     s: 0.9 + rand() * 0.3 + (i === chars.length - 1 ? 0.1 : 0) };
        x += widths[i];
        return at;
    });
    const each = (paint) => placed.forEach((l) => {
        ctx.save();
        ctx.translate(l.x, l.y);
        ctx.rotate(l.rot);
        ctx.scale(l.s, l.s);
        paint(l.c);
        ctx.restore();
    });
    ctx.lineJoin = "round";
    ctx.lineWidth = px * 0.16;
    ctx.strokeStyle = "#fff";
    each((c) => ctx.strokeText(c, 0, 0));
    ctx.fillStyle = color ? "#e0243c" : "#000";
    each((c) => ctx.fillText(c, 0, 0));
    if (color) {
        ctx.lineWidth = px * 0.04;
        ctx.strokeStyle = "#000";
        each((c) => ctx.strokeText(c, 0, 0));
    }
    ctx.restore();
}

// ── page ───────────────────────────────────────────────────────────────

/** Where a photo lands in its panel's region: scale to the shot size, then
 *  slide within the slack so the face sits on a third (away from the side
 *  the balloons will take), or — for a frame break — so the head crosses
 *  the top border. */
function photoOffset(panel, spec, face, otherFaces) {
    const { region, shotW, shotH, box } = panel;
    let ox = region.x - (shotW - region.w) / 2;
    let oy = region.y - (shotH - region.h) / 2;
    if (face) {
        // A group shot centres the group; a solo shot puts the face on a third.
        const xs = [face, ...otherFaces].map((f) => f.x);
        const group = xs.length > 1;
        const fx = (group ? (Math.min(...xs) + Math.max(...xs)) / 2 : face.x) * shotW;
        const fy = face.y * shotH;
        const want = spec.shot === "closeup" || group ? 0.5 : panel.index % 2 ? 0.36 : 0.64;
        const wantY = { closeup: 0.46, bust: 0.4, waist: 0.32, full: 0.24, wide: 0.36 }[spec.shot] ?? 0.4;
        ox = region.x + region.w * want - fx;
        oy = panel.breakout
            ? box.y + face.r * shotH * 0.6 - fy
            : box.y + box.h * wantY - fy;
    }
    ox = Math.min(region.x, Math.max(region.x + region.w - shotW, ox));
    oy = Math.min(region.y, Math.max(region.y + region.h - shotH, oy));
    return [ox, oy];
}

function paperColor(color) {
    return color ? "#fffdf6" : "#ffffff";
}

/** Compose the finished page. `shots[i]` is the photoshoot's capture for
 *  panel i: { figure, backdrop, face, room }. Returns a canvas. */
export function composePage({ script, layout, shots, agentName, dateText }) {
    const color = script.style === "color";
    const rand = seeded(script.title || "manga");
    const page = canvas(layout.width, layout.height);
    const ctx = page.getContext("2d");
    ctx.fillStyle = paperColor(color);
    ctx.fillRect(0, 0, page.width, page.height);
    drawHeader(ctx, layout, script, agentName, dateText);

    const lettering = [];
    layout.panels.forEach((panel, i) => {
        const spec = script.panels[i];
        const shot = shots[i];
        const { region, shotW, shotH } = panel;
        // Everyone else standing in the panel: cast members by name, the
        // user as "user" — each key a balloon's `who` can name.
        const otherEntries = Object.entries(shot?.others || {}).filter(([, f]) => f);
        const [ox, oy] = shot
            ? photoOffset(panel, spec, shot.face, otherEntries.map(([, f]) => f)) : [region.x, region.y];
        const onPage = (f) => (f ? { x: ox + f.x * shotW, y: oy + f.y * shotH, r: f.r * shotH } : null);
        const face = onPage(shot?.face);
        const others = Object.fromEntries(otherEntries.map(([k, f]) => [k, onPage(f)]));
        // The panel's art, in region coordinates.
        const art = canvas(region.w, region.h);
        const actx = art.getContext("2d");
        actx.fillStyle = paperColor(color);
        actx.fillRect(0, 0, art.width, art.height);
        const place = (layer) => {
            const c = canvas(region.w, region.h);
            c.getContext("2d").drawImage(layer, ox - region.x, oy - region.y, shotW, shotH);
            return c;
        };
        if (shot?.backdrop) actx.drawImage(inkLayer(place(shot.backdrop), { figure: false, color }), 0, 0);
        const local = face ? { x: face.x - region.x, y: face.y - region.y, r: face.r } : null;
        const fxRand = seeded(`${script.title}:${i}`);
        if (spec.effect !== "none" && !shot?.room) drawEffect(actx, spec.effect, region, local, fxRand, color);
        let figure = null;
        if (shot?.figure) {
            figure = inkLayer(place(shot.figure), { figure: true, color });
            actx.drawImage(figure, 0, 0);
        }
        if (spec.effect !== "none" && shot?.room) drawEffect(actx, spec.effect, region, local, fxRand, color);
        if (spec.mark !== "none") drawMark(actx, spec.mark, local, panel.index % 2 ? 1 : -1, color, region);

        ctx.save();
        polyPath(ctx, panel.poly);
        ctx.clip();
        ctx.drawImage(art, region.x, region.y);
        ctx.restore();
        ctx.save();
        ctx.lineWidth = BORDER;
        ctx.lineJoin = "miter";
        ctx.strokeStyle = "#000";
        polyPath(ctx, panel.poly);
        ctx.stroke();
        ctx.restore();

        // Frame break: the figure again, over the border and into the
        // gutter above — only its own pixels, so only the head crosses.
        if (panel.breakout && figure && !shot.room) {
            const [tl, tr] = panel.poly;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(region.x, region.y);
            ctx.lineTo(region.x + region.w, region.y);
            ctx.lineTo(tr[0], tr[1] + BORDER);
            ctx.lineTo(tl[0], tl[1] + BORDER);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(figure, region.x, region.y);
            ctx.restore();
        }

        let figureAt = null;
        if (figure && !shot.room) {
            const fctx = figure.getContext("2d", { willReadFrequently: true });
            const data = fctx.getImageData(0, 0, figure.width, figure.height).data;
            figureAt = (x, y) => {
                const lx = Math.round(x - region.x);
                const ly = Math.round(y - region.y);
                if (lx < 0 || ly < 0 || lx >= figure.width || ly >= figure.height) return false;
                return data[(ly * figure.width + lx) * 4 + 3] > 128;
            };
        }
        lettering.push({ panel, spec, face, others, figureAt });
    });
    // Lettering last, over every panel, so balloons may lean over a border.
    for (const l of lettering) letterPanel(ctx, l.panel, l.spec, l.face, l.others, l.figureAt, rand, color);
    drawFooter(ctx, layout, agentName);
    return page;
}

function drawHeader(ctx, layout, script, agentName, dateText) {
    const strip = script.layout === "yonkoma";
    const side = strip ? STRIP.side : PAGE.side;
    const top = strip ? STRIP.top : PAGE.top;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.font = `bold 22px ${LETTER_FONT}`;
    ctx.textAlign = "left";
    const kicker = ["MANGA DIARY", strip && "4-KOMA", `PAGE ${script.page_no || 1}`].filter(Boolean).join(" · ");
    ctx.fillText(kicker.split("").join(String.fromCharCode(8202)), side, top * 0.3);
    ctx.textAlign = "right";
    ctx.fillText([(agentName || "").toUpperCase(), dateText].filter(Boolean).join("  ·  "), layout.width - side, top * 0.3);
    // Title, then the page's subtitle at half size: together as large as
    // fits the width.
    const sub = script.subtitle ? `  —  ${script.subtitle}` : "";
    const measure = (px) => {
        ctx.font = `${px}px ${DISPLAY_FONT}`;
        const t = ctx.measureText(script.title).width;
        ctx.font = `bold ${Math.round(px * 0.5)}px ${LETTER_FONT}`;
        return t + (sub ? ctx.measureText(sub).width : 0);
    };
    let px = strip ? 56 : 72;
    while (px > 30 && measure(px) > layout.width - side * 2) px -= 4;
    const total = measure(px);
    const x0 = strip ? (layout.width - total) / 2 : side;
    const baseline = top * 0.3 + px * 1.15;
    ctx.textAlign = "left";
    ctx.font = `${px}px ${DISPLAY_FONT}`;
    ctx.fillText(script.title, x0, baseline);
    if (sub) {
        const tw = ctx.measureText(script.title).width;
        ctx.font = `bold ${Math.round(px * 0.5)}px ${LETTER_FONT}`;
        ctx.fillText(sub, x0 + tw, baseline);
    }
    ctx.fillRect(side, top - 30, layout.width - side * 2, 6);
    ctx.fillRect(side, top - 20, layout.width - side * 2, 1.5);
    ctx.restore();
}

function drawFooter(ctx, layout, agentName) {
    ctx.save();
    ctx.fillStyle = "#555";
    ctx.textAlign = "center";
    ctx.font = `18px ${LETTER_FONT}`;
    ctx.fillText(`— ${agentName || ""} —`, layout.width / 2, layout.height - 36);
    ctx.restore();
}
