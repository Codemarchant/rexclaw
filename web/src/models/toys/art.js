// The toys' drawings: inline SVG for the roaming desktop (models/toys/
// screen_stage.js) and the toy tray's tiles (components/ToyTray.jsx). The 3D
// view builds its own models (models/toys/models3d.js) in the same colours.
//
// One house style, the way game item icons are drawn: a dark ink outline,
// the base colour, a cel shadow on the side away from a light up and to the
// left (the shape's own outline, clipped), a soft highlight and a glint.
//
// Each drawing has its centre at the toy's centre of mass, in a viewBox the
// stage scales to the toy's size in metres (catalog `art` box), so the same
// drawing serves the 48 px tray tile and a ball the size of a real one. Ids
// inside are suffixed per copy: two copies on one page must not share a
// gradient id (removing the first breaks the second in some engines).

import { TOYS, PUMPKIN_FACES, lampLight } from "./catalog";

let uidSeq = 0;
const uid = () => `rxt${(++uidSeq).toString(36)}`;

const INK = "#2a1a14";
const INK_W = 3.2;

/** A shape in its base colour, inked, with a cel shadow over its lower
 *  right (`shade`, clipped to the shape) and a highlight. */
function inked(d, fill, shade, { hi = null, glint = null, shadeD = null, w = INK_W, extra = "" } = {}) {
    const c = uid();
    const s = shadeD || "M-200 30 C-60 70 60 -20 60 -200 L200 -200 L200 200 L-200 200 Z";
    return `<clipPath id="${c}"><path d="${d}"/></clipPath>
<path d="${d}" fill="${fill}"/>
<g clip-path="url(#${c})"><path d="${s}" fill="${shade}"/>${extra}${hi ? `<path d="${hi}" fill="#fff" opacity=".42"/>` : ""}</g>
<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round"/>
${glint ? `<path d="${glint}" fill="#fff"/>` : ""}`;
}

/** A round thing (a ball, a fruit): centre (cx, cy), radius r. */
function ball(cx, cy, r, fill, shade, inner = "") {
    const d = `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    const sh = `M${cx - r * 1.2} ${cy + r * 0.25} C${cx - r * 0.2} ${cy + r * 0.9} ${cx + r * 0.75} ${cy + r * 0.3} ${cx + r * 0.45} ${cy - r * 1.3} L${cx + r * 2} ${cy - r * 2} L${cx + r * 2} ${cy + r * 2} L${cx - r * 2} ${cy + r * 2} Z`;
    const hi = `M${cx - r * 0.62} ${cy - r * 0.2} C${cx - r * 0.66} ${cy - r * 0.62} ${cx - r * 0.3} ${cy - r * 0.78} ${cx - r * 0.02} ${cy - r * 0.72} C${cx - r * 0.3} ${cy - r * 0.6} ${cx - r * 0.5} ${cy - r * 0.42} ${cx - r * 0.62} ${cy - r * 0.2} Z`;
    const gl = `M${cx - r * 0.36} ${cy - r * 0.5} a${r * 0.07} ${r * 0.07} 0 1 0 0.1 0 Z`;
    return inked(d, fill, shade, { hi, glint: gl, shadeD: sh, extra: inner });
}

const svg = (vb, body) => `<svg viewBox="${vb}" overflow="visible">${body}</svg>`;

/** A lamp's drawing, in centimetres: its box (catalog `art`) round the
 *  drawing's centre, with `F` the floor's y (the physics sphere's bottom). */
function lampSvg(id, body) {
    const d = TOYS[id], a = d.art;
    const F = (d.radius + (a.cy || 0)) * 100;
    return `<svg viewBox="${-a.w * 50} ${-a.h * 50} ${a.w * 100} ${a.h * 100}" overflow="visible">${body(F)}</svg>`;
}

/** A lamp's state for its drawing: shade `i`, its colours, on or off. */
function lampState(id, { shade = 0, on = false } = {}) {
    const d = TOYS[id];
    const s = d.shades[shade] || d.shades[0];
    return { s, on, light: lampLight(d, shade).color };
}

/** A soft pool of a lamp's light round (x, y), r across: shown when on. */
function halo(x, y, r, color, strength = 0.55) {
    const g = uid();
    return `<g class="rx_lamp_on"><defs><radialGradient id="${g}"><stop offset="0" stop-color="${color}" stop-opacity="${strength}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>
<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${g})"/></g>`;
}

/** Wisps of steam rising off something hot, from y up, at each x. */
function steam(xs, y) {
    return `<g class="rx_steam">${xs.map((x, i) => `<path d="M${x} ${y} c-5 -6 5 -10 0 -16 s5 -10 0 -16" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".7" style="animation-delay:${(i * 0.6).toFixed(1)}s"/>`).join("")}</g>`;
}

/** A pedestal fan's drawing box (metres) for a head `headY` up: 5 mm a
 *  unit, its round base the physics sphere (radius 0.18) at the bottom. */
export function fanBox(headY) {
    const h = headY + 0.3;
    return { w: 0.5, h, cy: h / 2 - 0.18 };
}

const DRAW = {
    // ── treats ───────────────────────────────────────────────────────────
    donut() {
        const g = uid();
        const sprinkles = [[-24, -12, 20], [-12, -24, -40], [8, -27, 60], [24, -15, -20], [30, 0, 80], [-30, 4, 50],
            [-14, 14, -70], [14, 14, 30], [0, -16, 10], [20, 6, -55]]
            .map(([x, y, a], i) => `<rect x="${x - 4.5}" y="${y - 1.5}" width="9" height="3" rx="1.5" transform="rotate(${a} ${x} ${y})" fill="${["#facc15", "#38bdf8", "#f8fafc", "#a78bfa", "#4ade80"][i % 5]}" stroke="${INK}" stroke-width=".8"/>`).join("");
        const dough = "M-47 4 C-47 -22 -26 -38 0 -38 C26 -38 47 -22 47 4 C47 28 26 42 0 42 C-26 42 -47 28 -47 4 Z";
        const hole = "M-13 0 C-13 -7 -7 -11 0 -11 C7 -11 13 -7 13 0 C13 6 7 9 0 9 C-7 9 -13 6 -13 0 Z";
        const icing = "M-42 -2 C-43 -24 -22 -35 0 -35 C22 -35 43 -24 42 -2 C41 8 34 6 31 14 C28 21 20 15 13 21 C6 27 -3 18 -10 23 C-19 28 -24 16 -31 15 C-39 12 -41 6 -42 -2 Z";
        return svg("-50 -50 100 100", `<defs><radialGradient id="${g}" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#f8c98a"/><stop offset="1" stop-color="#c47a35"/></radialGradient></defs>
<path d="${dough}" fill="url(#${g})" stroke="${INK}" stroke-width="${INK_W}"/>
${inked(icing, "#f472b6", "#db2777", { hi: "M-34 -14 C-30 -26 -14 -31 2 -31 C-12 -27 -26 -22 -34 -14 Z", shadeD: "M-60 10 C-20 30 30 20 60 -6 L60 60 L-60 60 Z" })}
<path d="${hole}" fill="#7c4a20" stroke="${INK}" stroke-width="${INK_W}"/><path d="M-10 -2 C-8 -7 8 -7 10 -2" fill="none" stroke="#5b3416" stroke-width="2"/>
${sprinkles}<path d="M-27 -22 a2.5 2.5 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    strawberry() {
        const berry = "M0 45 C-24 40 -37 18 -35 -4 C-33 -21 -18 -25 0 -23 C18 -25 33 -21 35 -4 C37 18 24 40 0 45 Z";
        const seeds = [[-15, -4], [0, -9], [15, -4], [-22, 10], [-7, 9], [8, 9], [22, 10], [-13, 24], [2, 25], [15, 22], [-3, 37]]
            .map(([x, y]) => `<path d="M${x} ${y - 2.6} C${x + 2} ${y - 1} ${x + 1.4} ${y + 2.4} ${x} ${y + 2.6} C${x - 1.4} ${y + 2.4} ${x - 2} ${y - 1} ${x} ${y - 2.6} Z" fill="#fde68a" stroke="#b45309" stroke-width=".6"/>`).join("");
        const leaf = "M0 -23 L-21 -32 L-9 -24 L-18 -42 L-2 -29 L4 -46 L7 -29 L22 -40 L11 -24 L25 -27 Z";
        return svg("-50 -50 100 100", `${inked(berry, "#ef3b55", "#be123c", {
            hi: "M-26 -6 C-26 -16 -16 -18 -8 -17 C-16 -14 -22 -10 -26 -6 Z", extra: seeds,
            shadeD: "M-60 16 C-18 40 26 34 60 -6 L60 60 L-60 60 Z",
        })}
${inked(leaf, "#22c55e", "#15803d", { shadeD: "M0 -60 L60 -60 L60 0 L0 0 Z" })}
<path d="M1 -30 C2 -38 0 -44 -3 -49" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M1 -30 C2 -38 0 -44 -3 -49" fill="none" stroke="#16a34a" stroke-width="2.6" stroke-linecap="round"/>
<path d="M-20 -10 a2.6 2.6 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    chili() {
        const body = "M-30 -20 C-6 -30 26 -18 38 8 C45 23 44 37 33 47 C33 30 22 12 4 3 C-12 -5 -26 -5 -37 -10 C-39 -15 -36 -19 -30 -20 Z";
        return svg("-50 -50 100 100", `${inked(body, "#e11d2e", "#9f1239", {
            hi: "M-22 -19 C-4 -23 14 -16 24 -4 C12 -12 -4 -17 -22 -19 Z",
            shadeD: "M-60 -2 C-10 4 30 30 30 60 L60 60 L60 60 L-60 60 Z",
        })}
${inked("M-33 -20 C-40 -24 -44 -30 -42 -38 C-38 -40 -34 -34 -33 -28 C-28 -30 -24 -26 -26 -21 Z", "#22c55e", "#15803d")}
<path d="M-12 -21 a2.6 2.6 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    apple() {
        return svg("-50 -50 100 100", `${inked("M0 -26 C14 -40 44 -32 44 0 C44 28 22 44 8 40 C4 39 -4 39 -8 40 C-22 44 -44 28 -44 0 C-44 -32 -14 -40 0 -26 Z",
            "#e11d48", "#9f1239", {
                hi: "M-32 -8 C-32 -22 -22 -28 -12 -28 C-22 -24 -28 -18 -32 -8 Z",
                shadeD: "M-60 20 C-10 40 30 20 50 -20 L60 60 L-60 60 Z",
            })}
<path d="M0 -26 C1 -36 4 -42 8 -46" fill="none" stroke="${INK}" stroke-width="5.5" stroke-linecap="round"/><path d="M0 -26 C1 -36 4 -42 8 -46" fill="none" stroke="#78350f" stroke-width="2.8" stroke-linecap="round"/>
${inked("M5 -36 C12 -48 28 -48 32 -42 C24 -34 12 -32 5 -36 Z", "#4ade80", "#16a34a", { shadeD: "M0 -38 L40 -38 L40 0 L0 0 Z" })}
<path d="M-20 -14 a3 3 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    banana({ peeled = 0 } = {}) {
        const b = "M-42 -28 C-40 -30 -36 -30 -34 -27 C-22 2 8 20 40 16 C44 16 46 20 43 23 C18 40 -26 26 -42 -28 Z";
        if (peeled > 0) {
            // The stem half bare, its strips hanging from the middle (each
            // a third of the peel, `peeled` of them down).
            const fruit = "M-40 -30 C-34 -36 -28 -32 -26 -26 C-18 -6 -6 6 6 12 L-4 26 C-22 16 -36 0 -40 -30 Z";
            const strips = [
                "M0 14 C-10 24 -14 36 -12 46 C-6 44 -2 34 6 20 Z",
                "M4 18 C6 30 4 42 10 48 C14 40 14 30 12 20 Z",
                "M8 14 C20 18 28 28 30 38 C24 38 18 30 10 22 Z",
            ].slice(0, Math.round(peeled * 3));
            const lower = "M2 12 C14 20 28 18 40 16 C44 16 46 20 43 23 C24 36 6 32 -6 26 Z";
            return svg("-50 -50 100 100", `${inked(lower, "#fcd34d", "#eab308", { shadeD: "M-60 20 C-10 40 20 40 60 20 L60 60 L-60 60 Z" })}
${inked(fruit, "#fef9c3", "#fde68a", { hi: "M-34 -24 C-28 -8 -18 2 -8 10 C-20 4 -30 -8 -34 -24 Z" })}
${strips.map((d) => inked(d, "#facc15", "#ca8a04", { w: 2.4 })).join("")}
${Math.round(peeled * 3) < 3 ? inked("M-42 -28 C-40 -30 -36 -30 -34 -27 C-30 -18 -22 -6 -14 2 C-22 -2 -34 -12 -42 -28 Z", "#fcd34d", "#eab308", { w: 2.4 }) : ""}
<path d="M43 23 L45 24" stroke="#3f2a14" stroke-width="5" stroke-linecap="round"/>`);
        }
        return svg("-50 -50 100 100", `${inked(b, "#fcd34d", "#eab308", {
            hi: "M-32 -20 C-24 0 -6 14 16 20 C-4 18 -22 4 -32 -20 Z",
            shadeD: "M-60 -10 C-30 30 10 40 60 20 L60 60 L-60 60 Z",
        })}
<path d="M-42 -28 C-43 -33 -40 -37 -36 -35" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/><path d="M-42 -28 C-43 -33 -40 -37 -36 -35" fill="none" stroke="#65a30d" stroke-width="3" stroke-linecap="round"/>
<path d="M43 23 L45 24" stroke="#3f2a14" stroke-width="5" stroke-linecap="round"/>`);
    },

    grape() {
        return svg("-50 -50 100 100", `${inked("M0 -40 C24 -40 38 -16 38 6 C38 30 22 44 0 44 C-22 44 -38 30 -38 6 C-38 -16 -24 -40 0 -40 Z", "#9333ea", "#6b21a8", {
            hi: "M-26 -10 C-26 -24 -16 -32 -6 -32 C-16 -26 -22 -20 -26 -10 Z",
            shadeD: "M-60 20 C-10 44 30 30 50 -20 L60 60 L-60 60 Z",
        })}
<path d="M0 -40 C0 -46 2 -50 6 -52" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M0 -40 C0 -46 2 -50 6 -52" fill="none" stroke="#65a30d" stroke-width="2.6" stroke-linecap="round"/>
<path d="M-16 -20 a3 3 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    icecream() {
        let grid = "";
        for (let i = -3; i <= 3; i++) grid += `<path d="M${i * 7 - 10} 2 L${i * 7 + 14} 46" stroke="#a16207" stroke-width="1.6"/><path d="M${i * 7 + 10} 2 L${i * 7 - 14} 46" stroke="#a16207" stroke-width="1.6"/>`;
        return svg("-50 -50 100 100", `${inked("M-24 2 L24 2 L2 48 L-2 48 Z", "#e0a458", "#b9772f", { extra: grid, shadeD: "M6 0 L40 0 L40 60 L6 60 Z" })}
${inked("M-28 4 C-34 -2 -30 -12 -24 -12 C-26 -32 -10 -42 0 -42 C10 -42 26 -32 24 -12 C30 -12 34 -2 28 4 C22 10 14 2 8 8 C2 12 -6 4 -12 8 C-18 12 -24 8 -28 4 Z", "#fff7e0", "#f1dfb0", {
            hi: "M-18 -18 C-18 -30 -8 -36 2 -36 C-8 -32 -14 -26 -18 -18 Z",
            shadeD: "M-60 0 C-20 10 20 0 60 -20 L60 60 L-60 60 Z",
        })}
<path d="M18 6 C20 12 20 16 18 18 C16 16 16 12 18 6 Z" fill="#fff7e0" stroke="${INK}" stroke-width="1.6"/>
<path d="M-10 -30 a2.6 2.6 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    cupcake() {
        const cup = "M-28 2 L28 2 L21 44 L-21 44 Z";
        const frost = "M-32 6 C-40 -4 -32 -16 -22 -14 C-24 -28 -8 -34 0 -26 C6 -40 26 -32 22 -18 C34 -20 40 -6 32 6 Z";
        let ribs = "";
        for (let i = -3; i <= 3; i++) ribs += `<path d="M${i * 8} 3 L${i * 6} 43" stroke="#be185d" stroke-width="1.6" opacity=".55"/>`;
        return svg("-50 -50 100 100", `${inked(cup, "#f9a8d4", "#ec4899", { extra: ribs, shadeD: "M8 0 L40 0 L40 60 L8 60 Z" })}
${inked(frost, "#fdf2f8", "#f5c2dc", {
            hi: "M-26 -6 C-28 -14 -20 -18 -14 -16 C-20 -14 -24 -10 -26 -6 Z",
            shadeD: "M-60 6 C-20 0 20 -10 60 -30 L60 60 L-60 60 Z",
        })}
${ball(2, -34, 8, "#ef3b55", "#be123c")}
<path d="M3 -42 C5 -48 9 -50 12 -50" fill="none" stroke="#15803d" stroke-width="2.4" stroke-linecap="round"/>`);
    },

    // Cups, bowls and bottles: what's in them in .rx_fill (scaled down by
    // the stage's --fill as it goes), steam in .rx_steam, a cap in .rx_cap
    // (styles/toys.scss).
    noodles() {
        const bowl = "M-47 -8 H47 C45 20 26 38 0 38 C-26 38 -45 20 -47 -8 Z";
        const wave = (y) => `<path d="M-36 ${y} c4 -4 8 4 12 0 s8 4 12 0 s8 4 12 0 s8 4 12 0 s8 4 12 0" fill="none" stroke="#eab308" stroke-width="2"/>`;
        return svg("-50 -50 100 100", `${steam([-16, 0, 16], -22)}
<g class="rx_fill">${inked("M-44 -8 C-40 -22 40 -22 44 -8 Z", "#fde68a", "#facc15", { extra: wave(-14) + wave(-10), w: 2.4 })}
<circle cx="18" cy="-14" r="7" fill="#fff" stroke="${INK}" stroke-width="1.6"/><path d="M14 -14 a4 4 0 1 1 6 3" fill="none" stroke="#f472b6" stroke-width="1.8"/>
<ellipse cx="-16" cy="-15" rx="8" ry="5" fill="#fff" stroke="${INK}" stroke-width="1.6"/><ellipse cx="-15" cy="-15" rx="4" ry="3" fill="#f59e0b"/>
<circle cx="2" cy="-17" r="2.2" fill="#22c55e"/><circle cx="7" cy="-12" r="2" fill="#22c55e"/><circle cx="-4" cy="-11" r="2" fill="#16a34a"/></g>
${inked(bowl, "#dc2626", "#991b1b", { hi: "M-40 -2 C-36 14 -24 26 -10 32 C-26 22 -36 10 -40 -2 Z", shadeD: "M-60 6 C-20 30 30 26 60 -6 L60 60 L-60 60 Z" })}
<path d="M-30 4 C-24 10 -16 10 -10 4 M10 4 C16 10 24 10 30 4" fill="none" stroke="#fde68a" stroke-width="2.4" stroke-linecap="round"/>
${inked("M-16 36 H16 L13 46 H-13 Z", "#7f1d1d", "#450a0a", { w: 2.4 })}
<path d="M-34 -36 L48 -4" stroke="${INK}" stroke-width="5.5" stroke-linecap="round"/><path d="M-34 -36 L48 -4" stroke="#d6a35c" stroke-width="2.8" stroke-linecap="round"/>
<path d="M-28 -42 L50 -12" stroke="${INK}" stroke-width="5.5" stroke-linecap="round"/><path d="M-28 -42 L50 -12" stroke="#d6a35c" stroke-width="2.8" stroke-linecap="round"/>`);
    },

    tea() {
        const mug = "M-32 -26 H22 V30 C22 38 16 42 8 42 H-18 C-26 42 -32 38 -32 30 Z";
        return svg("-50 -50 100 100", `${steam([-18, -5, 8], -32)}
<path d="M20 -14 C42 -16 42 22 20 20" fill="none" stroke="${INK}" stroke-width="10"/><path d="M20 -14 C42 -16 42 22 20 20" fill="none" stroke="#60a5fa" stroke-width="5"/>
${inked(mug, "#60a5fa", "#2563eb", { hi: "M-26 -18 V24 C-24 30 -22 32 -18 34 C-24 26 -26 10 -26 -18 Z", shadeD: "M4 -40 L40 -40 L40 60 L4 60 Z" })}
<path d="M-32 -26 C-26 -32 16 -32 22 -26 C16 -21 -26 -21 -32 -26 Z" fill="#92400e" stroke="${INK}" stroke-width="2.4"/>
<path d="M-6 -26 C-8 -14 -12 -4 -14 6" fill="none" stroke="#f5f5f4" stroke-width="1.4"/>
${inked("M-20 4 H-8 V16 H-20 Z", "#fef3c7", "#fde68a", { w: 1.8 })}
<path d="M-26 -10 a2.6 2.6 0 1 0 0.1 0 Z" fill="#fff"/>`);
    },

    coffee() {
        return svg("-50 -50 100 100", `${steam([6], -48)}
${inked("M-24 -30 H24 L18 46 H-18 Z", "#f5f0e6", "#e2d6c2", { hi: "M-19 -24 L-15 38 H-12 L-15 -24 Z", shadeD: "M6 -40 L40 -40 L40 60 L6 60 Z" })}
${inked("M-23 -6 H23 L21 20 H-21 Z", "#a16207", "#713f12", { w: 2.4 })}
<circle cx="0" cy="7" r="6" fill="#fef3c7" stroke="${INK}" stroke-width="1.4"/><path d="M-2 4 C2 6 -2 9 2 11" fill="none" stroke="#713f12" stroke-width="1.4"/>
${inked("M-29 -30 H29 V-35 C29 -39 26 -42 22 -42 H-22 C-26 -42 -29 -39 -29 -35 Z", "#374151", "#1f2937", { w: 2.4 })}
${inked("M-18 -42 H18 V-46 C18 -48 16 -49 14 -49 H-14 C-16 -49 -18 -48 -18 -46 Z", "#4b5563", "#1f2937", { w: 2 })}
<ellipse cx="6" cy="-47" rx="3" ry="1.2" fill="#111827"/>`);
    },

    water() {
        const bottle = "M-16 -22 C-16 -30 -7 -33 -7 -40 H7 C7 -33 16 -30 16 -22 V44 C16 48 12 50 8 50 H-8 C-12 50 -16 48 -16 44 Z";
        return svg("-50 -50 100 100", `<path d="${bottle}" fill="#e0f2fe" opacity=".55"/>
<g class="rx_fill"><path d="M-15 -20 H15 V44 C15 47 12 49 8 49 H-8 C-12 49 -15 47 -15 44 Z" fill="#7dd3fc" opacity=".7"/></g>
<path d="M-16 -4 H16 M-16 26 H16" stroke="#7dd3fc" stroke-width="1.2" opacity=".8"/>
${inked("M-16 4 H16 V20 H-16 Z", "#0ea5e9", "#0369a1", { w: 2 })}
<path d="M-12 14 C-6 8 0 18 6 12 S12 10 14 12" fill="none" stroke="#fff" stroke-width="2"/>
<path d="${bottle}" fill="none" stroke="${INK}" stroke-width="${INK_W}" stroke-linejoin="round"/>
<path d="M-11 -18 V40" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>
<g class="rx_cap">${inked("M-9 -49 H9 V-40 H-9 Z", "#1d4ed8", "#1e3a8a", { w: 2.2 })}<path d="M-5 -48 V-41 M0 -48 V-41 M5 -48 V-41" stroke="#93c5fd" stroke-width="1.2"/></g>`);
    },

    hardtack() {
        const g = uid();
        const holes = [];
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            const x = -27 + i * 18, y = -27 + j * 18;
            holes.push(`<circle cx="${x}" cy="${y}" r="3.2" fill="#8a5a12"/><circle cx="${x - 0.8}" cy="${y - 0.8}" r="1.4" fill="#5b3a0c"/>`);
        }
        return svg("-50 -50 100 100", `<defs><radialGradient id="${g}" cx="40%" cy="35%" r="80%"><stop offset="0" stop-color="#fbe3a0"/><stop offset="1" stop-color="#d9a441"/></radialGradient></defs>
${inked("M-40 -44 H40 C44 -44 44 -40 44 -38 V40 C44 44 40 44 38 44 H-40 C-44 44 -44 40 -44 38 V-38 C-44 -42 -42 -44 -40 -44 Z", `url(#${g})`, "#c99335", {
            hi: "M-36 -38 H24 C10 -34 -20 -34 -36 -30 Z", extra: holes.join(""),
            shadeD: "M-60 30 L60 -10 L60 60 L-60 60 Z",
        })}`);
    },

    // ── toys ─────────────────────────────────────────────────────────────
    basketball() {
        const seams = `<g fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"><path d="M0 -46 V46"/><path d="M-46 0 H46"/>
<path d="M-33 -32 C-13 -15 -13 15 -33 32"/><path d="M33 -32 C13 -15 13 15 33 32"/></g>`;
        return svg("-50 -50 100 100", ball(0, 0, 46, "#f97316", "#c2410c", seams));
    },

    football() {
        // The classic black pentagons on white.
        const pent = (cx, cy, r, rot = 0) => {
            let d = "";
            for (let i = 0; i < 5; i++) {
                const a = rot + (i / 5) * Math.PI * 2 - Math.PI / 2;
                d += `${i ? "L" : "M"}${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`;
            }
            return `<path d="${d}Z" fill="#1f2937"/>`;
        };
        const spots = pent(0, 0, 13) + [0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2 - Math.PI / 2 + Math.PI / 5;
            return pent(Math.cos(a) * 40, Math.sin(a) * 40, 12, a + Math.PI);
        }).join("");
        let lines = "";
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
            lines += `<path d="M${(Math.cos(a) * 13).toFixed(1)} ${(Math.sin(a) * 13).toFixed(1)} L${(Math.cos(a) * 30).toFixed(1)} ${(Math.sin(a) * 30).toFixed(1)}" stroke="#94a3b8" stroke-width="1.6"/>`;
        }
        return svg("-50 -50 100 100", ball(0, 0, 46, "#f8fafc", "#cbd5e1", lines + spots));
    },

    rugby() {
        // Side on, long axis across: as long as it's drawn wide (catalog
        // `long`), white with two bands at each end and the lace panel.
        const rx = 46, ry = 46 / TOYS.rugby.long;
        const d = `M${-rx} 0 C${-rx} ${-ry * 0.75} ${-rx * 0.55} ${-ry} 0 ${-ry} C${rx * 0.55} ${-ry} ${rx} ${-ry * 0.75} ${rx} 0 C${rx} ${ry * 0.75} ${rx * 0.55} ${ry} 0 ${ry} C${-rx * 0.55} ${ry} ${-rx} ${ry * 0.75} ${-rx} 0 Z`;
        const band = (x, col) => `<path d="M${x} ${-ry} C${x + 4} ${-ry * 0.3} ${x + 4} ${ry * 0.3} ${x} ${ry}" fill="none" stroke="${col}" stroke-width="5"/>`;
        const extra = band(-30, "#1d4ed8") + band(-23, "#dc2626") + band(23, "#dc2626") + band(30, "#1d4ed8")
            + `<path d="M${-rx} 0 C-20 -4 20 -4 ${rx} 0" fill="none" stroke="#94a3b8" stroke-width="1.6"/>`
            + [-8, -3, 2, 7].map((x) => `<path d="M${x} -10 V-2" stroke="#334155" stroke-width="2.4" stroke-linecap="round"/>`).join("");
        return svg("-50 -50 100 100", inked(d, "#f8fafc", "#cbd5e1", {
            hi: "M-30 -12 C-24 -22 -10 -26 4 -26 C-10 -22 -22 -18 -30 -12 Z", extra,
            shadeD: "M-60 8 C-20 30 30 30 60 0 L60 60 L-60 60 Z",
        }));
    },

    wand() {
        const g = uid();
        return svg("-50 -50 100 100", `<defs><radialGradient id="${g}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#f0abfc" stop-opacity=".35"/><stop offset=".45" stop-color="#67e8f9" stop-opacity=".25"/><stop offset=".8" stop-color="#fde047" stop-opacity=".35"/><stop offset="1" stop-color="#f472b6" stop-opacity=".5"/></radialGradient></defs>
${inked("M-4 -6 H4 V44 C4 48 -4 48 -4 44 Z", "#f472b6", "#db2777", { shadeD: "M1 -10 L10 -10 L10 60 L1 60 Z" })}
<path d="M-4 30 H4" stroke="${INK}" stroke-width="2"/>
<circle cx="0" cy="-26" r="19" fill="url(#${g})"/>
<circle cx="0" cy="-26" r="19" fill="none" stroke="${INK}" stroke-width="8"/><circle cx="0" cy="-26" r="19" fill="none" stroke="#ec4899" stroke-width="4.6"/>
<path d="M-11 -35 C-8 -40 -2 -42 3 -41" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>`);
    },

    // ── gadgets ──────────────────────────────────────────────────────────
    fan({ headY = 1.2 } = {}) {
        const g = uid();
        // Side on, blowing to the right; floor at y 0, head `headY` up (in
        // 5 mm units), the box fanBox()'s.
        const H = headY / 0.005;
        const boxH = fanBox(headY).h / 0.005;
        const cy = -H;
        return `<svg viewBox="-50 ${(-boxH).toFixed(1)} 100 ${boxH.toFixed(1)}" overflow="visible"><defs>
<radialGradient id="${g}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#e0f2fe" stop-opacity=".2"/><stop offset="1" stop-color="#bae6fd" stop-opacity=".45"/></radialGradient></defs>
${inked("M-34 -2 C-34 -10 34 -10 34 -2 C34 4 -34 4 -34 -2 Z", "#64748b", "#475569")}
${inked(`M-4 ${cy + 8} H4 V-6 H-4 Z`, "#cbd5e1", "#94a3b8", { shadeD: "M0 -400 L10 -400 L10 10 L0 10 Z" })}
<path d="M-6 ${(cy + 16 + (H - 16) * 0.55).toFixed(1)} H6" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M-6 ${(cy + 16 + (H - 16) * 0.55).toFixed(1)} H6" stroke="#475569" stroke-width="2.6" stroke-linecap="round"/>
${inked(`M-34 ${cy - 12} H-2 C6 ${cy - 12} 6 ${cy + 12} -2 ${cy + 12} H-34 C-40 ${cy + 12} -40 ${cy - 12} -34 ${cy - 12} Z`, "#e2e8f0", "#94a3b8", { shadeD: `M-60 ${cy + 2} L20 ${cy + 2} L20 ${cy + 40} L-60 ${cy + 40} Z` })}
<g transform="translate(14 ${cy})"><ellipse rx="17" ry="43" fill="url(#${g})"/>
<g transform="scale(.38 1)"><g class="rx_toy_blades">
<path d="M0 0 C10 -10 12 -36 0 -40 C-8 -32 -6 -10 0 0 Z" fill="#38bdf8" stroke="#0369a1" stroke-width="2"/><path d="M0 0 C14 4 36 18 32 34 C14 34 4 12 0 0 Z" fill="#38bdf8" stroke="#0369a1" stroke-width="2"/><path d="M0 0 C-14 6 -36 18 -32 34 C-14 34 -4 14 0 0 Z" fill="#38bdf8" stroke="#0369a1" stroke-width="2"/>
<circle r="7" fill="#0ea5e9" stroke="${INK}" stroke-width="2"/></g></g>
<g fill="none" stroke="#475569" stroke-width="1.3" opacity=".75"><path d="M-17 0 H17 M0 -43 V43"/><ellipse rx="9" ry="22"/></g>
<ellipse rx="17" ry="43" fill="none" stroke="${INK}" stroke-width="5"/><ellipse rx="17" ry="43" fill="none" stroke="#94a3b8" stroke-width="2.4"/></g>
<circle class="rx_toy_led" cx="-24" cy="${cy}" r="3.4" fill="#64748b" stroke="${INK}" stroke-width="1.2"/></svg>`;
    },

    dryer() {
        const g = uid();
        // Side on, the nozzle to the right: a rounded barrel with an air
        // concentrator, the motor's grille at the back, a soft-touch grip
        // with its switches, a cord.
        return svg("-50 -50 100 100", `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5d0fe"/><stop offset=".55" stop-color="#c084fc"/><stop offset="1" stop-color="#7e22ce"/></linearGradient></defs>
<path d="M-6 44 C-8 50 -20 50 -26 46" fill="none" stroke="${INK}" stroke-width="4.4" stroke-linecap="round"/><path d="M-6 44 C-8 50 -20 50 -26 46" fill="none" stroke="#4b5563" stroke-width="2.2" stroke-linecap="round"/>
${inked("M-12 6 L-20 42 C-21 47 -6 48 -4 43 L6 8 Z", "#a855f7", "#7e22ce", { shadeD: "M-6 0 L20 0 L20 60 L-6 60 Z" })}
<rect x="-12.5" y="16" width="8" height="5" rx="2" transform="rotate(14 -8 18)" fill="#e9d5ff" stroke="${INK}" stroke-width="1.4"/>
<rect x="-15" y="25" width="8" height="5" rx="2" transform="rotate(14 -11 27)" fill="#f472b6" stroke="${INK}" stroke-width="1.4"/>
${inked("M-38 -20 C-46 -20 -46 10 -38 10 H20 C26 10 26 -20 20 -20 Z", `url(#${g})`, "#9333ea", {
            hi: "M-36 -16 H16 C8 -13 -20 -12 -36 -11 Z", shadeD: "M-60 0 H60 V40 H-60 Z",
        })}
${inked("M20 -16 L40 -11 C43 -10 43 6 40 7 L20 10 Z", "#6b21a8", "#4c1d95", { shadeD: "M10 0 H50 V20 H10 Z" })}
<path d="M40 -10 V6" stroke="#c4b5fd" stroke-width="2"/>
<ellipse cx="-40" cy="-5" rx="5" ry="13" fill="#3b0764" stroke="${INK}" stroke-width="2"/>
<g class="rx_toy_glow"><ellipse cx="-40" cy="-5" rx="3" ry="9" fill="#fb923c"/></g>
<path d="M-41 -14 V4 M-39 -14 V4" stroke="#6b21a8" stroke-width="1"/>
<circle cx="-8" cy="-14" r="2" fill="#fff" opacity=".8"/>`);
    },

    fogger() {
        return svg("-50 -50 100 100", `${inked("M-42 -22 H26 C30 -22 30 -18 30 -16 V28 C30 32 26 32 24 32 H-40 C-44 32 -44 28 -44 26 V-16 C-44 -20 -42 -22 -40 -22 Z", "#334155", "#1e293b", {
            hi: "M-40 -18 H22 C12 -15 -20 -15 -40 -14 Z", shadeD: "M-60 14 H60 V60 H-60 Z",
        })}
${inked("M30 -8 H42 C45 -8 45 6 42 6 H30 Z", "#1e293b", "#0f172a")}
<g fill="#0f172a">${[-12, -4, 4, 12].map((y) => `<rect x="-36" y="${y}" width="42" height="3.4" rx="1.7"/>`).join("")}</g>
<circle class="rx_toy_led" cx="18" cy="20" r="3.6" fill="#64748b" stroke="${INK}" stroke-width="1.2"/>
<text x="-36" y="26" font-size="9" font-weight="800" font-family="Segoe UI, sans-serif" fill="#94a3b8" letter-spacing="1">FOG</text>
<rect x="-38" y="32" width="10" height="6" rx="1.5" fill="${INK}"/><rect x="14" y="32" width="10" height="6" rx="1.5" fill="${INK}"/>`);
    },

    disco() {
        const g = uid(), c = uid();
        const tiles = [];
        for (let y = -46; y < 48; y += 8) {
            for (let x = -48; x < 48; x += 8) {
                const v = 140 + Math.round(100 * Math.random());
                tiles.push(`<rect x="${x}" y="${y}" width="7" height="7" fill="rgb(${v},${v},${Math.min(255, v + 35)})"/>`);
            }
        }
        return svg("-50 -50 100 100", `<defs><clipPath id="${c}"><circle r="45"/></clipPath>
<radialGradient id="${g}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".7" stop-color="#0f172a" stop-opacity=".2"/><stop offset="1" stop-color="#0f172a" stop-opacity=".6"/></radialGradient></defs>
<line x1="0" y1="-46" x2="0" y2="-2000" stroke="#94a3b8" stroke-width="2.5"/><rect x="-6" y="-53" width="12" height="9" rx="2" fill="#64748b" stroke="${INK}" stroke-width="1.6"/>
<g clip-path="url(#${c})"><circle r="45" fill="#cbd5e1"/><g class="rx_toy_tiles">${tiles.join("")}</g><circle r="45" fill="url(#${g})"/></g>
<circle r="45" fill="none" stroke="${INK}" stroke-width="${INK_W}"/>
<g fill="#fff"><path d="M-22 -26 l2.4 -8 l2.4 8 l8 2.4 l-8 2.4 l-2.4 8 l-2.4 -8 l-8 -2.4 Z"/><path d="M16 8 l1.6 -5 l1.6 5 l5 1.6 l-5 1.6 l-1.6 5 l-1.6 -5 l-5 -1.6 Z"/></g>`);
    },

    // ── lights (centimetres; front on; drawn on or off, in their shade) ──
    desk(o) {
        const { s, on, light } = lampState("desk", o);
        return lampSvg("desk", (F) => {
            const top = F - 75;
            const g = uid();
            const legs = [-48, 44].map((x) => inked(`M${x} ${top} H${x + 4} V${F} H${x} Z`, "#854d0e", "#5b2e0c", { w: 2.4 })).join("");
            const books = ["#1d4ed8", "#be123c", "#15803d"].map((c, i) => inked(`M${-42 + i * 1.5} ${top - 3.5 * (i + 1)} H${-20 + i * 1.5} V${top - 3.5 * i} H${-42 + i * 1.5} Z`, c, "#0f172a", { w: 1.8 })).join("");
            const hx = 28, hy = F - 117.5;
            const beam = on ? `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}" stop-opacity=".55"/><stop offset="1" stop-color="${light}" stop-opacity=".08"/></linearGradient></defs>
<path d="M${hx - 7} ${hy + 3} L${hx + 6} ${hy + 1} L${hx + 14} ${top} L${hx - 34} ${top} Z" fill="url(#${g})"/>
<ellipse cx="${hx - 10}" cy="${top}" rx="26" ry="2.4" fill="${light}" opacity=".6"/>` : "";
            return `${legs}${inked(`M-50 ${top - 3} H50 V${top + 2} H-50 Z`, "#b45309", "#854d0e", { w: 2.4, shadeD: `M-60 ${top} H60 V${top + 10} H-60 Z` })}
${inked(`M-43 ${top + 2} H-9 V${top + 14} H-43 Z`, "#854d0e", "#5b2e0c", { w: 2.2 })}<path d="M-30 ${top + 8} H-22" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
${books}${inked(`M-6 ${top - 9} H1 V${top} H-6 Z`, "#f8fafc", "#cbd5e1", { w: 1.8 })}<path d="M1 ${top - 7} C5 ${top - 7} 5 ${top - 2} 1 ${top - 2}" fill="none" stroke="${INK}" stroke-width="1.6"/>
${beam}
<ellipse cx="36" cy="${top - 1}" rx="7" ry="2" fill="${s.color}" stroke="${INK}" stroke-width="1.6"/>
<path d="M36 ${top - 2} L43 ${top - 30} L31 ${hy - 5}" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><path d="M36 ${top - 2} L43 ${top - 30} L31 ${hy - 5}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>
<circle cx="43" cy="${top - 30}" r="1.6" fill="#334155"/>
<g transform="rotate(17 ${hx} ${hy})">${on ? `<circle cx="${hx}" cy="${hy + 2}" r="3.2" fill="#fff"/>` : ""}${inked(`M${hx - 3} ${hy - 9} H${hx + 3} L${hx + 9} ${hy + 3} H${hx - 9} Z`, s.color, "#00000033", { w: 2 })}</g>
${on ? halo(hx, hy + 2, 16, light, 0.7) : ""}`;
        });
    },

    floorlamp(o) {
        const { s, on, light } = lampState("floorlamp", o);
        return lampSvg("floorlamp", (F) => {
            const by = F - 148;
            const fabric = inked(`M-17 ${by - 18} H17 L20 ${by + 10} H-20 Z`, s.color, "#00000026", { w: 2.4 });
            return `${on ? halo(0, by, 46, light, 0.45) : ""}
<ellipse cx="0" cy="${F - 1.5}" rx="15" ry="3" fill="#1f2937" stroke="${INK}" stroke-width="1.6"/>
<path d="M0 ${F - 3} V${by}" stroke="${INK}" stroke-width="3.6"/><path d="M0 ${F - 3} V${by}" stroke="#b08d57" stroke-width="1.8"/>
${on ? `<path d="M-20 ${by + 10} L-30 ${by + 40} H30 L20 ${by + 10} Z M-17 ${by - 18} L-26 ${by - 40} H26 L17 ${by - 18} Z" fill="${light}" opacity=".18"/>` : ""}
${fabric}${on ? `<path d="M-17 ${by - 18} H17 L20 ${by + 10} H-20 Z" fill="${light}" opacity=".45"/><circle cx="0" cy="${by + 4}" r="5" fill="#fff" opacity=".8"/>` : ""}
<circle cx="0" cy="${by - 20}" r="1.6" fill="#b08d57"/>`;
        });
    },

    lantern(o) {
        const { s, on, light } = lampState("lantern", o);
        return lampSvg("lantern", () => {
            const cy = TOYS.lantern.art.cy * 100;
            let ribs = "";
            for (let i = 1; i < 6; i++) {
                const y = -20 + (40 * i) / 6, w = Math.sqrt(400 - y * y);
                ribs += `<path d="M${-w} ${cy + y} Q0 ${cy + y + 2.2} ${w} ${cy + y}" fill="none" stroke="#a8a29e" stroke-width=".9"/>`;
            }
            return `<path d="M0 ${cy - 20} V-2000" stroke="#1f2937" stroke-width=".8"/>
${on ? halo(0, cy, 44, light, 0.5) : ""}
${ball(0, cy, 20, s.color, "#00000018", ribs)}
${on ? `<circle cx="0" cy="${cy}" r="19" fill="${light}" opacity=".42"/>` : ""}
<rect x="-5" y="${cy - 21.5}" width="10" height="2.5" rx="1" fill="#d6d3d1" stroke="${INK}" stroke-width="1"/>`;
        });
    },

    lava(o) {
        const { s, on, light } = lampState("lava", o);
        return lampSvg("lava", (F) => {
            const g0 = F - 13, gt = F - 38;
            const glass = `M-4.2 ${g0} C-5.4 ${g0 - 4} -5 ${g0 - 14} -4.2 ${gt + 6} L-2.8 ${gt} H2.8 L4.2 ${gt + 6} C5 ${g0 - 14} 5.4 ${g0 - 4} 4.2 ${g0} Z`;
            const c = uid();
            const blobs = [[-1.2, g0 - 4, 2.4, 0], [1.4, g0 - 12, 1.8, 3], [-0.6, g0 - 19, 2, 6], [0.8, gt + 5, 1.5, 9]]
                .map(([x, y, r, d]) => `<ellipse class="rx_lava_blob" style="animation-delay:-${d}s" cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.25}" fill="${s.wax}"/>`).join("");
            return `${on ? halo(0, F - 26, 18, light, 0.55) : ""}
<defs><clipPath id="${c}"><path d="${glass}"/></clipPath></defs>
<path d="${glass}" fill="${s.color}" opacity="${on ? 0.95 : 0.75}"/>
<g clip-path="url(#${c})" class="${on ? "rx_lava_on" : ""}">${blobs}</g>
<path d="${glass}" fill="none" stroke="${INK}" stroke-width="1.6"/>
<path d="M-2.6 ${g0 - 5} C-3.2 ${g0 - 12} -3 ${gt + 10} -2.2 ${gt + 4}" fill="none" stroke="#fff" stroke-width=".9" opacity=".6"/>
${inked(`M-4.2 ${g0} H4.2 L7 ${F} H-7 Z`, "#cbd5e1", "#94a3b8", { w: 1.6 })}
${inked(`M-2.8 ${gt} H2.8 L1.4 ${gt - 5} H-1.4 Z`, "#cbd5e1", "#94a3b8", { w: 1.4 })}`;
        });
    },

    candles(o) {
        const { s, on, light } = lampState("candles", o);
        return lampSvg("candles", (F) => {
            const top = F - 55;
            const sticks = [[-11, 11], [-2, 8.5], [6.5, 6]].map(([x, h]) => {
                const flame = on ? `<path class="rx_flame" d="M${x + 3} ${top - h - 7} C${x + 5} ${top - h - 3} ${x + 4.6} ${top - h - 0.5} ${x + 3} ${top - h - 0.5} C${x + 1.4} ${top - h - 0.5} ${x + 1} ${top - h - 3} ${x + 3} ${top - h - 7} Z" fill="#ffb347"/><circle cx="${x + 3}" cy="${top - h - 2}" r=".9" fill="#fff7d6"/>` : "";
                return `${inked(`M${x} ${top - h} H${x + 6} V${top} H${x} Z`, s.color, "#00000022", { w: 1.4 })}<path d="M${x + 3} ${top - h} V${top - h - 1.4}" stroke="${INK}" stroke-width=".8"/>${flame}`;
            }).join("");
            return `${on ? halo(0, top - 10, 30, light, 0.55) : ""}
${inked(`M-2.5 ${top} H2.5 V${F - 2} H-2.5 Z`, "#5b3a29", "#3b2418", { w: 1.6 })}
<ellipse cx="0" cy="${F - 1.2}" rx="12" ry="2.4" fill="#5b3a29" stroke="${INK}" stroke-width="1.4"/>
<path d="M-20 ${top} H20 V${top + 2.5} H-20 Z" fill="#6b4532" stroke="${INK}" stroke-width="1.6"/>
${sticks}`;
        });
    },

    jar(o) {
        const { on, light, s } = lampState("jar", o);
        return lampSvg("jar", (F) => {
            const leds = [[-4, -3], [2, -6], [4, -12], [-3, -10], [0, -16], [-5, -18], [3, -20], [-1, -22], [5, -8], [-2, -5], [1, -11], [-4, -14]]
                .map(([x, y], i) => {
                    const col = on ? (s.rainbow ? `hsl(${i * 30} 90% 65%)` : light) : "#6b7280";
                    return `<circle class="${on ? "rx_twinkle" : ""}" style="animation-delay:-${(i * 0.37) % 2}s" cx="${x}" cy="${F + y}" r="1.1" fill="${col}"/>`;
                }).join("");
            return `${on ? halo(0, F - 12, 20, light, 0.5) : ""}
<path d="M-6 ${F - 22} C-1 ${F - 18} 3 ${F - 14} -2 ${F - 9} S 3 ${F - 4} -1 ${F - 1}" fill="none" stroke="#78716c" stroke-width=".5"/>
${leds}
<rect x="-7" y="${F - 25}" width="14" height="25" rx="2.5" fill="#e0f2fe" fill-opacity=".22" stroke="${INK}" stroke-width="1.5"/>
<path d="M-5 ${F - 22} V${F - 4}" stroke="#fff" stroke-width=".9" opacity=".6"/>
${inked(`M-6 ${F - 28} H6 V${F - 25} H-6 Z`, "#a8a29e", "#78716c", { w: 1.4 })}`;
        });
    },

    moon(o) {
        const { s, on, light } = lampState("moon", o);
        return lampSvg("moon", () => {
            const craters = [[-4, -3, 2.2], [3, 2, 1.6], [-2, 5, 1.2], [5, -4, 1.1], [0, -6, 0.9]]
                .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#00000016"/>`).join("");
            return `${on ? halo(0, 0, 26, light, 0.55) : ""}
${ball(0, 0, 10, s.color, "#00000018", craters)}
${on ? `<circle r="9.6" fill="${light}" opacity=".3"/>` : ""}`;
        });
    },

    neon(o) {
        const { s, on } = lampState("neon", o);
        return lampSvg("neon", () => {
            const col = on ? s.color : "#94a3b8";
            const word = `<text x="0" y="3" text-anchor="middle" font-size="17" font-weight="900" font-style="italic" font-family="Trebuchet MS, Segoe UI, sans-serif" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round">REXCLAW</text>
<path d="M-8 12 Q-4 8 0 7.4 M-1 12 Q3 8 7 7.4 M6 12 Q10 8 14 7.4" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round"/>`;
            return `<path d="M-35 -15 V-2000 M35 -15 V-2000" stroke="#475569" stroke-width=".5"/>
<rect x="-44" y="-14" width="88" height="28" rx="4" fill="#0f172a" fill-opacity=".35" stroke="#334155" stroke-width=".8"/>
<g class="${on ? "rx_neon" : ""}" style="color:${s.color}">${word}</g>
${on ? `<g opacity=".9">${word.replaceAll(`stroke="${col}" stroke-width="1.6"`, 'stroke="#fff" stroke-width=".5"')}</g>` : ""}`;
        });
    },

    campfire(o) {
        const { s, on } = lampState("campfire", o);
        return lampSvg("campfire", (F) => {
            const [core, body, tip] = s.flame;
            const log = (x0, x1, top) => `<path d="M${x0} ${F - 3} L${x1} ${top}" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
<path d="M${x0} ${F - 3} L${x1} ${top}" stroke="#7c4a2a" stroke-width="5.6" stroke-linecap="round"/>
<circle cx="${x0}" cy="${F - 3}" r="2.6" fill="#d6b17a" stroke="${INK}" stroke-width="1"/>`;
            // A flame: a teardrop h tall and w wide on the bed at x.
            const flame = (x, h, w, col, delay) => {
                const b = F - 6, t = b - h;
                return `<path class="rx_fire" style="animation-delay:-${delay}s" d="M${x} ${t} C${x + w * 0.35} ${t + h * 0.38} ${x + w} ${t + h * 0.6} ${x + w * 0.6} ${b} C${x + w * 0.3} ${b + 4} ${x - w * 0.3} ${b + 4} ${x - w * 0.6} ${b} C${x - w} ${t + h * 0.6} ${x - w * 0.35} ${t + h * 0.38} ${x} ${t} Z" fill="${col}"/>`;
            };
            const stones = [[-34, 5.5], [-23, 6.5], [-11.5, 6], [0, 6.8], [11.5, 6], [23, 6.5], [34, 5.5]]
                .map(([x, r], i) => inked(`M${x - r * 1.3} ${F} C${x - r * 1.3} ${F - r * 1.5} ${x + r * 1.3} ${F - r * 1.5} ${x + r * 1.3} ${F} Z`,
                    i % 2 ? "#a8a29e" : "#78716c", "#57534e", { w: 1.6 })).join("");
            const fire = on ? `${halo(0, F - 26, 58, body, 0.5)}
${flame(-9, 40, 13, tip, 0.1)}${flame(9, 46, 14, tip, 0.25)}${flame(0, 62, 18, tip, 0)}${flame(0, 50, 14, body, 0.15)}${flame(-3, 30, 9, core, 0.05)}${flame(4, 26, 8, core, 0.2)}` : "";
            return `${log(-24, -3, F - 38)}${log(24, 3, F - 38)}${log(-12, -1, F - 42)}${log(12, 1, F - 42)}${fire}${stones}`;
        });
    },

    pumpkin(o) {
        const { s, on, light } = lampState("pumpkin", o);
        return lampSvg("pumpkin", (F) => {
            const [core, body] = s.flame;
            const top = F - 36, R = 26, cy = top - R * 0.6;
            // Its ribs: overlapping lobes, the middle one last, each a
            // little taller towards the middle (drawn for a 21 cm radius,
            // scaled to `R` with the stem).
            const lobe = (x, w, h) => `<ellipse cx="${x}" cy="${cy}" rx="${w}" ry="${h}" fill="${s.color}" stroke="${INK}" stroke-width="1.5"/>
<ellipse cx="${x - w * 0.3}" cy="${cy - h * 0.3}" rx="${w * 0.3}" ry="${h * 0.32}" fill="#fff" opacity=".12"/>`;
            const lobes = [[-14, 8, 11.5], [14, 8, 11.5], [-8, 9, 12.5], [8, 9, 12.5], [0, 9.5, 13]].map(([x, w, h]) => lobe(x, w, h)).join("");
            // The face's paths are on a circle of radius 50 (PUMPKIN_FACES);
            // a hole glows when it's lit, and is dark when it isn't.
            const k = R / 50;
            const holes = PUMPKIN_FACES[s.face].map((d) => `<path d="${d}"/>`).join("");
            const face = `<g transform="translate(0 ${cy}) scale(${k} ${k * 0.74})" fill="${on ? core : "#1c1009"}" stroke="${on ? body : INK}" stroke-width="${on ? 2.5 : 2}" stroke-linejoin="round"><g class="${on ? "rx_twinkle rx_twinkle--fast" : ""}">${holes}</g></g>`;
            const straws = [[-44, 6], [-30, 20], [-14, 11], [6, 25], [24, 9], [38, 19], [-38, 30], [32, 31]]
                .map(([x, y]) => `<path d="M${x} ${top + y} l5 1.4" stroke="#7a5a1f" stroke-width=".9" stroke-linecap="round"/>`).join("");
            return `${on ? halo(0, cy, 46, light, 0.55) : ""}
${inked(`M-46 ${top} H46 V${F} H-46 Z`, "#d4ae55", "#a8842f", { w: 2.2, shadeD: `M-60 ${top + 22} H60 V${F + 10} H-60 Z` })}
${straws}<path d="M-23 ${top} V${F} M23 ${top} V${F}" stroke="#6b4a24" stroke-width="1.4"/>
<g transform="translate(0 ${cy}) scale(${R / 21}) translate(0 ${-cy})">${inked(`M-1.5 ${cy - 12} C-4 ${cy - 16} -2 ${cy - 20} 5 ${cy - 21} L7 ${cy - 17.5} C3 ${cy - 16} 3 ${cy - 14} 4 ${cy - 12} Z`, "#5f6b2e", "#3f4a1c", { w: 1.5 })}
<path d="M-3 ${cy - 13} c-7 -3 -11 2 -8 4 s5 -2 2 -3" fill="none" stroke="#4d7c2f" stroke-width="1"/>
${lobes}</g>${face}
${inked(`M-41 ${top} C-41 ${top - 8} -31 ${top - 8} -31 ${top} Z`, "#d9a441", "#a8772a", { w: 1.5 })}
${inked(`M38 ${F} C38 ${F - 12} 52 ${F - 12} 52 ${F} Z`, "#d4631a", "#a5480f", { w: 1.5 })}`;
        });
    },

    galaxy(o) {
        const { s, on, light } = lampState("galaxy", o);
        return lampSvg("galaxy", (F) => {
            const top = F - 4.5;
            const stars = [[-3, -2.5], [1.5, -4], [3.5, -1.5], [-1, -1], [0, -5], [-4, -1]]
                .map(([x, y], i) => `<circle class="${on ? "rx_twinkle" : ""}" style="animation-delay:-${(i * 0.41) % 2}s" cx="${x}" cy="${top + y}" r=".5" fill="${on ? "#fff" : "#94a3b8"}"/>`).join("");
            return `${on ? halo(0, top - 3, 14, light, 0.55) : ""}
${inked(`M-6.6 ${F} L-6 ${top} H6 L6.6 ${F} Z`, "#1e1b2e", "#0f0d1a", { w: 1.2 })}
<path d="M-6.2 ${top + 0.5} H6.2" stroke="${s.color}" stroke-width="1"/>
${inked(`M-5.6 ${top} A5.6 5.6 0 0 1 5.6 ${top} Z`, on ? "#312e81" : "#475569", "#1e1b4b", { w: 1.2 })}${stars}
<circle cx="4" cy="${F - 2}" r=".6" fill="${on ? "#4ade80" : "#334155"}"/>`;
        });
    },

    aquarium(o) {
        const { s, on, light } = lampState("aquarium", o);
        return lampSvg("aquarium", (F) => {
            // The stand 72 cm, the tank 30 cm on it, the hood on top.
            const t0 = F - 72, t1 = F - 102, bed = t0 - 4, c = uid(), g = uid();
            const water = on ? s.water : "#64748b";
            // Each fish swims to and fro across the tank (.rx_fish), at
            // its own depth and pace: neon tetras, guppies, the gourami.
            const tetra = `<path d="M-1.3 0 C-1 -0.7 0.8 -0.7 1.3 0 C0.8 0.7 -1 0.7 -1.3 0 Z" fill="#a3b4c6"/><path d="M-1 -0.1 H1" stroke="#22d3ee" stroke-width=".35"/><path d="M-1.2 0.25 H-0.1" stroke="#ef4444" stroke-width=".35"/><path d="M-1.3 0 L-2 -0.5 V0.5 Z" fill="#e2e8f0"/>`;
            const guppy = (col) => `<path d="M-1.4 0 C-1 -0.6 1 -0.6 1.5 0 C1 0.6 -1 0.6 -1.4 0 Z" fill="#d4d4d8"/><path d="M-1.3 0 L-3.2 -1.2 Q-3.6 0 -3.2 1.2 Z" fill="${col}"/>`;
            const gourami = `<path d="M-3 0 C-2.4 -2 2 -2 3 0 C2 2 -2.4 2 -3 0 Z" fill="#f97316"/><path d="M-1.5 -1.2 V1.2 M0 -1.4 V1.4 M1.4 -1.1 V1.1" stroke="#60a5fa" stroke-width=".5"/><path d="M-3 0 L-4.5 -1.3 V1.3 Z" fill="#ea580c"/>`;
            const swim = (art, y, dur, delay) => `<g transform="translate(0 ${y})"><g class="rx_fish" style="animation-duration:${dur}s;animation-delay:-${delay}s">${art}</g></g>`;
            const fish = [
                ...[[-12, 9, 0], [-11, 9, 0.4], [-13, 9, 0.8], [-12.5, 9, 1.3], [-10.5, 9, 1.7]].map(([y, d, l]) => swim(tetra, t0 + y, d, l)),
                swim(guppy("#f97316"), t0 - 18, 13, 2), swim(guppy("#3b82f6"), t0 - 8, 15, 6), swim(guppy("#ec4899"), t0 - 22, 11, 4),
                swim(gourami, t0 - 15, 19, 9),
            ].join("");
            const plants = [-34, -31, -28, 29, 32, 35].map((x, i) => `<path class="rx_plant" style="animation-delay:-${i * 0.7}s" d="M${x} ${bed} C${x - 2} ${bed - 8} ${x + 2} ${bed - 14} ${x} ${bed - 18 - (i % 3) * 3}" fill="none" stroke="${i % 2 ? "#22c55e" : "#15803d"}" stroke-width="1.6" stroke-linecap="round"/>`).join("");
            const bubbles = on ? [0, 1, 2, 3, 4].map((i) => `<circle class="rx_bub" style="animation-delay:-${i * 0.25}s" cx="-31" cy="${bed - 1}" r=".7" fill="#e0f2fe"/>`).join("") : "";
            const flakes = [-6, -3, 0, 2, 5, 7].map((x, i) => `<circle style="animation-delay:${i * 0.15}s" cx="${x}" cy="${t1 + 4}" r=".6" fill="#f97316"/>`).join("");
            return `${on ? halo(0, t0 - 16, 60, light, 0.4) : ""}
${inked(`M-40 ${t0} H40 V${F} H-40 Z`, "#3b2a20", "#2a1d16", { w: 2, shadeD: `M10 ${t0} H50 V${F + 10} H10 Z` })}
<path d="M0 ${t0 + 4} V${F - 4}" stroke="${INK}" stroke-width="1"/><circle cx="-3" cy="${t0 + 32}" r="1" fill="#d6b17a"/><circle cx="3" cy="${t0 + 32}" r="1" fill="#d6b17a"/>
<defs><clipPath id="${c}"><rect x="-38" y="${t1}" width="76" height="30"/></clipPath>
<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${on ? "#0e7490" : "#334155"}"/><stop offset="1" stop-color="${on ? "#082f49" : "#1e293b"}"/></linearGradient></defs>
<g clip-path="url(#${c})">
<rect x="-38" y="${t1}" width="76" height="30" fill="url(#${g})"/>
<rect x="-38" y="${t1 + 3}" width="76" height="27" fill="${water}" opacity="${on ? 0.45 : 0.3}"/>
${plants}<ellipse cx="9" cy="${bed}" rx="7" ry="3.6" fill="#6b7280" stroke="${INK}" stroke-width=".6"/>
${fish}${bubbles}<g class="rx_flakes">${flakes}</g>
<rect x="-38" y="${bed}" width="76" height="4" fill="#a8a29e"/><path d="M-38 ${bed} H38" stroke="#78716c" stroke-width=".6" stroke-dasharray="1.2 1.6"/>
</g>
<rect x="-38" y="${t1}" width="76" height="30" fill="none" stroke="${INK}" stroke-width="1.6"/>
<path d="M-35 ${t1 + 4} V${t0 - 6}" stroke="#fff" stroke-width=".8" opacity=".45"/>
${inked(`M-39.5 ${t1 - 4} H39.5 V${t1} H-39.5 Z`, "#111827", "#030712", { w: 1.6 })}
${on ? `<path d="M-34 ${t1 + 0.6} H34" stroke="${light}" stroke-width="1"/>` : ""}`;
        });
    },

    // ── the crew's ───────────────────────────────────────────────────────
    gerald() {
        const body = "M-40 2 C-40 -18 -14 -28 4 -28 C24 -28 42 -16 42 2 C42 20 22 28 4 28 C-16 28 -40 22 -40 2 Z";
        return svg("-50 -50 100 100", `${inked("M-34 0 L-50 -20 L-44 0 L-50 20 Z", "#64748b", "#475569")}
${inked("M-8 -24 L2 -44 L14 -23 Z", "#64748b", "#475569", { shadeD: "M4 -60 L30 -60 L30 0 L4 0 Z" })}
${inked(body, "#94a3b8", "#64748b", {
            hi: "M-30 -8 C-26 -20 -10 -24 4 -24 C-10 -20 -22 -16 -30 -8 Z",
            extra: `<path d="M-32 8 C-12 28 24 28 42 8 L42 40 L-40 40 Z" fill="#f1f5f9"/><path d="M-30 9 C-10 26 22 26 40 9" fill="none" stroke="#cbd5e1" stroke-width="1.5"/>`,
            shadeD: "M-60 18 C-20 34 30 30 60 6 L60 60 L-60 60 Z",
        })}
${inked("M-6 20 L-14 36 L4 26 Z", "#64748b", "#475569")}
<circle cx="22" cy="-6" r="5.5" fill="${INK}"/><circle cx="23.6" cy="-7.6" r="1.8" fill="#fff"/>
<path d="M26 8 Q32 13 38 6" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
<path d="M28 10 l1.5 3 l1.5 -3 M32 10 l1.5 3 l1.5 -3" stroke="#fff" stroke-width="1.4" fill="none"/>
<ellipse cx="14" cy="4" rx="5" ry="2.6" fill="#fda4af" opacity=".85"/>
<path d="M-22 -12 q4 -3 8 0 q4 3 8 0 q4 -3 8 0" stroke="#475569" stroke-width="1.2" fill="none" stroke-dasharray="2 2"/>`);
    },

    chest() {
        const g = uid();
        // Front on, the lid hinged at the back (.rx_toy_lid turns up).
        return svg("-60 -56 120 100", `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a86b33"/><stop offset="1" stop-color="#5b3416"/></linearGradient></defs>
<g class="rx_toy_glow"><ellipse cx="0" cy="-14" rx="40" ry="12" fill="#fde047"/></g>
${inked("M-50 -12 L50 -12 L46 40 L-46 40 Z", `url(#${g})`, "#4a2a12", {
            extra: `<path d="M-48 6 H48 M-47 24 H47" stroke="rgba(0,0,0,.35)" stroke-width="1.6"/>`, shadeD: "M20 -20 H60 V60 H20 Z",
        })}
${inked("M-38 -12 H-31 V40 H-38 Z", "#64748b", "#475569")}${inked("M31 -12 H38 V40 H31 Z", "#64748b", "#475569")}
${inked("M-8 -10 H8 V6 H-8 Z", "#facc15", "#ca8a04")}<path d="M0 -4 V1" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>
<g class="rx_toy_lid">${inked("M-52 -10 C-52 -38 52 -38 52 -10 Z", `url(#${g})`, "#4a2a12", {
            hi: "M-44 -16 C-40 -28 -10 -32 10 -32 C-12 -28 -34 -24 -44 -16 Z", shadeD: "M20 -60 H60 V0 H20 Z",
        })}
${inked("M-38 -10 C-38 -32 -31 -34 -31 -34 L-31 -10 Z", "#64748b", "#475569")}${inked("M31 -34 C31 -34 38 -32 38 -10 L31 -10 Z", "#64748b", "#475569")}
<path d="M-52 -10 H52" stroke="#facc15" stroke-width="3.4"/></g>`);
    },

    bottle() {
        const g = uid();
        return svg("-50 -50 100 100", `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6ee7b7" stop-opacity=".8"/><stop offset=".5" stop-color="#10b981" stop-opacity=".55"/><stop offset="1" stop-color="#065f46" stop-opacity=".85"/></linearGradient></defs>
<g transform="rotate(-6)">${inked("M-30 -6 H14 V6 H-30 Z", "#fef3c7", "#e9cf94")}<path d="M-26 -2 H8 M-26 2 H2" stroke="#b45309" stroke-width="1" opacity=".6"/></g>
<path d="M-42 -18 C-42 -22 -38 -24 -34 -24 L10 -24 C20 -24 24 -10 34 -9 L42 -8 L42 8 L34 9 C24 10 20 24 10 24 L-34 24 C-38 24 -42 22 -42 18 Z" fill="url(#${g})" stroke="${INK}" stroke-width="${INK_W}" stroke-linejoin="round"/>
${inked("M42 -8 H51 V8 H42 Z", "#b45309", "#78350f")}
<path d="M-34 -18 H6" stroke="#fff" stroke-width="3.4" opacity=".6" stroke-linecap="round"/><path d="M-30 18 H-12" stroke="#fff" stroke-width="2" opacity=".35" stroke-linecap="round"/>`);
    },

    // Not in the tray: what the toys make.
    coin() {
        const g = uid();
        return svg("-50 -50 100 100", `<defs><radialGradient id="${g}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fef08a"/><stop offset=".6" stop-color="#eab308"/><stop offset="1" stop-color="#a16207"/></radialGradient></defs>
<circle r="46" fill="url(#${g})" stroke="${INK}" stroke-width="${INK_W}"/>
<circle r="34" fill="none" stroke="#ca8a04" stroke-width="3" stroke-dasharray="4 5"/>
<path d="M0 -24 V24 M-24 0 H24" stroke="#a16207" stroke-width="8" stroke-linecap="round"/>
<path d="M-26 -26 C-18 -36 -4 -40 8 -38" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/>`);
    },
};

/** The drawing of toy `id` as SVG markup (a fresh copy). */
export function toyArt(id, opts = {}) {
    return (DRAW[id] || DRAW.basketball)(opts);
}

/** A tray tile's picture: the drawing as a data URL (an <img> needs no ids). */
const tileCache = new Map();
export function toyIcon(id) {
    if (!tileCache.has(id)) {
        // Lights show lit.
        let markup = toyArt(id, { on: true });
        // The fan's tile: just its head, not a 1.5 m stand.
        if (id === "fan") markup = markup.replace(/viewBox="[^"]*"/, 'viewBox="-50 -300 100 120"');
        // Hung things' tiles: not their cords.
        markup = markup.replace(/ V-2000/g, " V-30");
        const s = markup.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
        tileCache.set(id, `data:image/svg+xml,${encodeURIComponent(s)}`);
    }
    return tileCache.get(id);
}
