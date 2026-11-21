// What the game gags (models/roam_gags_games.js) and the Gaussian splat set
// piece (models/roam_gags_splat.js) put on the screen: a mixin on RoamFx,
// the same as roam_fx_rexclaw.js. Everything is drawn here — pixel textures
// painted by a seeded random at 16 × 16, blocky mobs a pixel at a time,
// low-poly figures as SVG — so there are no game files, fonts or sounds in
// it; the references are in what things do. Looks: styles/roam_games.scss
// (.rx_mc_*, .rx_rs_*, .rx_splat_*).

import { RoamFx, el, place } from "./roam_fx";

// ── pixel art ────────────────────────────────────────────────────────────

/** A small seeded random (mulberry32): the same texture every time. */
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pixelCanvas(w, h, paint) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const px = (x, y, r, gr, b, a = 1) => {
        g.fillStyle = `rgba(${r | 0},${gr | 0},${b | 0},${a})`;
        g.fillRect(x, y, 1, 1);
    };
    paint(px, g);
    return c.toDataURL("image/png");
}

/** Every pixel of a w × h patch at (x0, y0): `base` ± `spread`, the three
 *  channels moving together (a shade of the one colour). */
function speckle(px, R, x0, y0, w, h, base, spread) {
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = (R() - 0.5) * spread;
            px(x0 + x, y0 + y, base[0] + v, base[1] + v, base[2] + v);
        }
    }
}

const TEXTURES = {
    dirt: (px, R) => speckle(px, R, 0, 0, 16, 16, [134, 96, 67], 44),
    stone: (px, R) => speckle(px, R, 0, 0, 16, 16, [126, 126, 126], 30),
    water: (px, R) => {
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const v = (R() - 0.5) * 30 + ((x + y * 3) % 7 === 0 ? 34 : 0);
                px(x, y, 46 + v, 100 + v, 226, 0.74);
            }
        }
    },
};

const made = new Map();

/** A 16 × 16 block face as a data URL (one of TEXTURES), painted once. */
export function blockTexture(kind) {
    if (!made.has(kind)) {
        const R = seeded([...kind].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7));
        made.set(kind, pixelCanvas(16, 16, (px) => TEXTURES[kind](px, R)));
    }
    return made.get(kind);
}

/** The cracks of a block being broken, stage 1..9 of 9: one branching
 *  walk out from the middle, more of it shown each stage. */
function crackTexture(stage) {
    const key = `crack${stage}`;
    if (!made.has(key)) {
        const R = seeded(99);
        const walk = [];
        for (let arm = 0; arm < 7; arm++) {
            let x = 7 + Math.floor(R() * 2), y = 7 + Math.floor(R() * 2);
            const a = (arm / 7) * Math.PI * 2 + R();
            for (let i = 0; i < 9; i++) {
                walk.push([x, y, arm * 2 + i * 3]);
                x += Math.round(Math.cos(a) + (R() - 0.5));
                y += Math.round(Math.sin(a) + (R() - 0.5));
            }
        }
        walk.sort((p, q) => p[2] - q[2]);
        const upto = Math.ceil(walk.length * stage / 9);
        made.set(key, pixelCanvas(16, 16, (px) => {
            for (let i = 0; i < upto; i++) px(walk[i][0], walk[i][1], 0, 0, 0, 0.6);
        }));
    }
    return made.get(key);
}

// The mobs, front legs apart (frame 0) and together (frame 1). Drawn from
// the side with the face showing, the way a flat sprite would be.
const MOBS = {
    // 12 × 26: a head of 8, a body 4 wide and 12 tall, legs of 4 by 6.
    creeper: {
        w: 12, h: 26,
        paint: (px, frame) => {
            const R = seeded(5);
            const skin = (x0, y0, w, h) => {
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const v = (R() - 0.5) * 70;
                        px(x0 + x, y0 + y, 72 + v * 0.5, 160 + v, 62 + v * 0.4);
                    }
                }
            };
            skin(frame ? 1 : 0, 20, 4, 6);
            skin(frame ? 7 : 8, 20, 4, 6);
            skin(4, 8, 4, 12);
            skin(2, 0, 8, 8);
            const dark = [[1, 2], [2, 2], [1, 3], [2, 3], [5, 2], [6, 2], [5, 3], [6, 3], [3, 4], [4, 4],
                [2, 5], [3, 5], [4, 5], [5, 5], [2, 6], [3, 6], [4, 6], [5, 6], [2, 7], [5, 7]];
            for (const [x, y] of dark) px(2 + x, y, 14, 22, 14);
        },
    },
    // 10 × 34: tall, thin, black, with the eyes.
    enderman: {
        w: 10, h: 34,
        paint: (px, frame) => {
            const R = seeded(8);
            const coat = (x0, y0, w, h) => {
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = R() * 16; px(x0 + x, y0 + y, 14 + v, 14 + v, 16 + v); }
            };
            coat(1, 0, 8, 8);
            coat(2, 8, 6, 8);
            coat(0, 8, 2, 20);
            coat(8, 8, 2, 20);
            coat(frame ? 3 : 2, 16, 2, 18);
            coat(frame ? 5 : 6, 16, 2, 18);
            for (const x of [1, 2, 3, 6, 7, 8]) px(x, 4, 204, 30, 250);
            px(2, 4, 236, 150, 255);
            px(7, 4, 236, 150, 255);
        },
    },
};

function mobFrames(kind) {
    const key = `mob:${kind}`;
    if (!made.has(key)) {
        const m = MOBS[kind];
        made.set(key, [0, 1].map((f) => pixelCanvas(m.w, m.h, (px) => m.paint(px, f))));
    }
    return made.get(key);
}

// ── low-poly figures (the old school) ────────────────────────────────────

const TREE = `<svg viewBox="0 0 120 150" overflow="visible">
  <g class="top"><polygon points="60,2 94,16 110,46 98,76 70,90 40,88 14,68 10,38 30,12" fill="#2f6b2a"/>
  <polygon points="60,2 94,16 76,42 44,36 30,12" fill="#3f8a34"/>
  <polygon points="10,38 44,36 40,62 14,68" fill="#377a2e"/>
  <polygon points="76,42 110,46 98,76 70,64" fill="#285c25"/>
  <polygon points="44,36 76,42 70,64 40,62" fill="#33752c"/></g>
  <polygon points="52,150 55,96 46,78 58,84 64,70 71,86 80,80 70,100 72,150" fill="#6b4a2b"/>
  <polygon points="62,150 64,70 71,86 80,80 70,100 72,150" fill="#55391f"/>
</svg>`;
const STUMP = `<svg viewBox="0 0 120 150" overflow="visible">
  <polygon points="50,150 52,128 72,128 74,150" fill="#6b4a2b"/>
  <polygon points="62,150 62,128 72,128 74,150" fill="#55391f"/>
  <ellipse cx="62" cy="128" rx="11" ry="4" fill="#c9a26b"/><ellipse cx="62" cy="128" rx="5" ry="1.8" fill="none" stroke="#a37c48" stroke-width="1"/>
</svg>`;
// The sandwich lady, facing right: a long dress and apron, a bun under a
// cap, the tray held out in front.
const LADY = `<svg viewBox="0 0 80 120" overflow="visible">
  <polygon points="18,118 24,62 50,62 58,118" fill="#9d3f5f"/><polygon points="38,118 38,62 50,62 58,118" fill="#7f3049"/>
  <polygon points="26,118 30,66 46,66 50,118" fill="#f8fafc"/><polygon points="38,118 38,66 46,66 50,118" fill="#e2e8f0"/>
  <polygon points="24,36 50,36 50,64 24,64" fill="#b4506f"/><polygon points="38,36 50,36 50,64 38,64" fill="#9d3f5f"/>
  <polygon points="44,40 52,40 66,56 60,60" fill="#b4506f"/><polygon points="60,60 66,56 70,60 64,64" fill="#e0ac69"/>
  <polygon points="54,60 80,60 78,66 56,66" fill="#7c4a21"/>
  <path d="M57 59 C57 54 77 54 77 59 Z" fill="#d9a55b"/><path d="M62 56 L64 59 M68 55.5 L70 59 M73 56 L75 59" stroke="#b07a35" stroke-width="1"/>
  <polygon points="28,12 38,7 47,12 48,28 38,35 28,28" fill="#e0ac69"/><polygon points="38,7 47,12 48,28 38,35" fill="#c9965a"/>
  <polygon points="26,14 38,4 49,14 47,9 38,1 28,9" fill="#f8fafc"/><circle cx="26" cy="13" r="6" fill="#7a4a2a"/>
  <rect x="40" y="18" width="3" height="3" fill="#2b1d0e"/><path d="M40 27 L46 26" stroke="#7f1d1d" stroke-width="1.5"/>
</svg>`;
const BAGUETTE = `<svg viewBox="0 0 80 20" overflow="visible">
  <path d="M4 10 C4 1 76 1 76 10 C76 19 4 19 4 10 Z" fill="#d9a55b"/>
  <path d="M18 4 L25 15 M33 3 L40 16 M48 3 L55 16 M62 5 L67 14" stroke="#b07a35" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
const CHICKEN = `<svg viewBox="0 0 100 90" overflow="visible">
  <polygon points="6,36 22,30 20,52 8,50" fill="#e5e7eb"/><polygon points="2,26 20,30 16,40" fill="#d1d5db"/>
  <polygon points="18,34 44,22 70,28 78,52 62,70 34,72 18,56" fill="#f8fafc"/><polygon points="44,22 70,28 78,52 56,48" fill="#e2e8f0"/>
  <polygon class="wing" points="30,40 58,38 62,56 40,62" fill="#cbd5e1"/>
  <polygon points="62,30 70,6 86,6 92,26 82,40 68,40" fill="#f8fafc"/><polygon points="78,6 86,6 92,26 82,40" fill="#e2e8f0"/>
  <polygon points="70,6 72,-4 77,4 81,-5 85,5 90,0 88,10" fill="#dc2626"/>
  <polygon points="90,20 100,24 90,28" fill="#f59e0b"/><polygon points="88,28 92,38 86,34" fill="#dc2626"/>
  <circle cx="82" cy="17" r="3.2" fill="#7f1d1d"/><circle cx="82.8" cy="16.4" r="1" fill="#fecaca"/>
  <polygon points="74,10 88,15 87,12 75,7" fill="#111827"/>
  <g class="legs" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" fill="none"><path d="M42 70 L40 86 M40 86 L34 88 M40 86 L46 88"/><path d="M56 70 L58 86 M58 86 L52 88 M58 86 L64 88"/></g>
</svg>`;
const GENIE = `<svg viewBox="0 0 100 150" overflow="visible">
  <path class="wisp" d="M50 150 C30 140 62 128 44 116 C30 106 40 96 34 88 L66 88 C72 100 58 108 66 120 C74 134 56 140 50 150 Z" fill="#7dd3fc" opacity="0.85"/>
  <polygon points="32,52 68,52 66,90 34,90" fill="#38bdf8"/><polygon points="50,52 68,52 66,90 50,90" fill="#0ea5e9"/>
  <polygon points="32,52 42,52 40,90 34,90" fill="#7c3aed"/><polygon points="58,52 68,52 66,90 60,90" fill="#6d28d9"/>
  <polygon points="24,60 76,60 72,72 28,72" fill="#38bdf8"/><polygon points="50,60 76,60 72,72 50,72" fill="#0ea5e9"/>
  <polygon points="38,26 50,20 62,26 62,44 50,52 38,44" fill="#38bdf8"/><polygon points="50,20 62,26 62,44 50,52" fill="#0ea5e9"/>
  <polygon points="44,44 56,44 50,58" fill="#1e293b"/>
  <polygon points="34,26 40,10 50,6 60,10 66,26 50,22" fill="#f8fafc"/><polygon points="50,6 60,10 66,26 50,22" fill="#e2e8f0"/>
  <circle cx="50" cy="14" r="3.5" fill="#dc2626"/>
  <rect x="43" y="31" width="4" height="3" fill="#0f172a"/><rect x="53" y="31" width="4" height="3" fill="#0f172a"/>
</svg>`;
const LAMP = `<svg viewBox="0 0 60 40" overflow="visible">
  <path d="M8 22 C8 14 20 12 30 12 C40 12 46 16 46 22 C46 30 38 34 28 34 C18 34 8 30 8 22 Z" fill="#facc15"/>
  <path d="M28 12 C38 12 46 16 46 22 C46 30 38 34 28 34 Z" fill="#ca8a04"/>
  <path d="M44 20 C52 18 54 12 60 10 C58 18 54 24 46 26 Z" fill="#eab308"/>
  <path d="M10 20 C2 18 0 26 6 28" fill="none" stroke="#ca8a04" stroke-width="3"/>
  <rect x="24" y="7" width="8" height="5" rx="2" fill="#eab308"/><rect x="20" y="33" width="16" height="4" rx="1" fill="#a16207"/>
</svg>`;
const NEST = `<svg viewBox="0 0 60 36" overflow="visible">
  <ellipse cx="22" cy="14" rx="7" ry="9" fill="#bfdbfe"/><ellipse cx="38" cy="14" rx="7" ry="9" fill="#dbeafe"/>
  <path d="M2 14 C6 34 54 34 58 14 C44 22 16 22 2 14 Z" fill="#92400e"/>
  <path d="M6 20 L54 18 M10 26 L50 25 M4 16 L20 26 M56 16 L40 27" stroke="#78350f" stroke-width="2" fill="none"/>
</svg>`;
const GRAVE = `<svg viewBox="0 0 60 70" overflow="visible">
  <path d="M10 70 L10 24 C10 6 50 6 50 24 L50 70 Z" fill="#9ca3af"/><path d="M30 10 C44 10 50 16 50 24 L50 70 L30 70 Z" fill="#6b7280"/>
  <text x="30" y="38" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="13" fill="#374151">RIP</text>
  <rect x="2" y="64" width="56" height="6" fill="#4b5563"/>
</svg>`;
const CRACKER = `<svg viewBox="0 0 120 40" overflow="visible">
  <g class="half half-l"><polygon points="0,6 14,14 14,26 0,34" fill="#dc2626"/><rect x="14" y="8" width="46" height="24" fill="#dc2626"/><rect x="20" y="8" width="6" height="24" fill="#facc15"/><polygon points="60,8 54,14 60,20 54,26 60,32 14,32 14,8" fill="#dc2626"/></g>
  <g class="half half-r"><polygon points="120,6 106,14 106,26 120,34" fill="#b91c1c"/><polygon points="60,8 66,14 60,20 66,26 60,32 106,32 106,8" fill="#b91c1c"/><rect x="94" y="8" width="6" height="24" fill="#facc15"/></g>
</svg>`;
// A red burst with a number on it; blue for a zero.
const HITSPLAT = "M50 2 L60 22 L82 12 L76 34 L98 40 L80 54 L94 74 L70 72 L66 96 L50 78 L34 96 L30 72 L6 74 L20 54 L2 40 L24 34 L18 12 L40 22 Z";

/** A drawing placed by the middle of its bottom edge each frame. */
function figure(fx, layer, cls, html, w, h) {
    const a = fx._track(el(`rx_roam_actor ${cls}`, layer));
    place(a, 0, 0, w, h);
    a.innerHTML = html;
    let fx0 = -9999, fy0 = -9999;
    return {
        el: a, w, h,
        get x() { return fx0; }, get y() { return fy0; },
        /** (x, y): the middle of its bottom edge; `dir` -1 mirrors it. */
        moveTo: (x, y, dir = 1, deg = 0, k = 1) => {
            fx0 = x; fy0 = y;
            a.style.transformOrigin = "50% 100%";
            a.style.transform = `translate(${(x - w / 2).toFixed(1)}px, ${(y - h).toFixed(1)}px) rotate(${deg.toFixed(1)}deg) scale(${(dir * k).toFixed(3)}, ${k.toFixed(3)})`;
        },
        set: (c, on) => a.classList.toggle(c, on),
        fade: (ms = 400) => fx._fadeOut(a, ms),
        remove: () => fx._remove(a),
    };
}

const FIGURES = {
    tree: [TREE, 120 / 150], stump: [STUMP, 120 / 150], chicken: [CHICKEN, 100 / 90], lady: [LADY, 80 / 120],
    baguette: [BAGUETTE, 80 / 20], genie: [GENIE, 100 / 150], lamp: [LAMP, 60 / 40], nest: [NEST, 60 / 36],
    grave: [GRAVE, 60 / 70], cracker: [CRACKER, 120 / 40],
};

// Overhead chat's colour effects, as the keyframes they cycle through.
const CHAT_COLOURS = {
    flash1: { colors: ["#ff0000", "#ffff00"], steps: true, ms: 500 },
    flash2: { colors: ["#00ffff", "#0000ff"], steps: true, ms: 500 },
    flash3: { colors: ["#00b000", "#80ff80"], steps: true, ms: 500 },
    glow1: { colors: ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#ff0000"], ms: 2400 },
    glow2: { colors: ["#ff0000", "#ff00ff", "#0000ff", "#800000", "#ff0000"], ms: 2400 },
    glow3: { colors: ["#ffffff", "#00ff00", "#ffffff", "#00ffff", "#ffffff"], ms: 2400 },
};

Object.assign(RoamFx.prototype, {
    // ── blocks ───────────────────────────────────────────────────────────

    /** A block `size` px across with its front face's top-left at (x, y):
     *  one of the textures, or (`src`, `cut`) a piece of a picture — `cut`
     *  is {x, y, width, height}, the picture's size and this block's place
     *  in it. crack(0..9), pop() (broken: bits fly), remove(). */
    block(kind, x, y, size, { src = null, cut = null, layer = null, flat = false } = {}) {
        const b = this._track(el(`rx_mc_block${flat ? " rx_mc_block--flat" : ""}`, layer || this.under));
        place(b, x, y, size, size);
        b.style.setProperty("--d", `${(size * 0.26).toFixed(1)}px`);
        if (src && cut) {
            b.style.backgroundImage = `url("${src}")`;
            b.style.backgroundSize = `${cut.width}px ${cut.height}px`;
            b.style.backgroundPosition = `${-cut.x}px ${-cut.y}px`;
            b.classList.add("rx_mc_block--cut");
        } else {
            b.style.backgroundImage = `url("${src || blockTexture(kind)}")`;
        }
        let cracks = null;
        return {
            el: b, kind, x, y, size,
            crack: (stage) => {
                if (!stage) { cracks?.remove(); cracks = null; return; }
                cracks ||= el("rx_mc_crack", b);
                cracks.style.backgroundImage = `url("${crackTexture(Math.min(9, stage))}")`;
            },
            /** Flung from (cx, cy), spinning, falling, fading. */
            fling: (cx, cy, power = 1) => {
                const ox = x + size / 2 - cx, oy = y + size / 2 - cy;
                const l = Math.hypot(ox, oy) || 1;
                const v = (180 + Math.random() * 260) * power;
                const dx = (ox / l) * v, dy = (oy / l) * v - 140 * power;
                const spin = (Math.random() - 0.5) * 540;
                return b.animate([
                    { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
                    { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) rotate(${spin * 0.6}deg)`, opacity: 1, offset: 0.45 },
                    { transform: `translate(${dx}px, ${dy + 300}px) rotate(${spin}deg)`, opacity: 0 },
                ], { duration: 1500, easing: "cubic-bezier(.2,.6,.4,1)", fill: "forwards" }).finished.catch(() => {});
            },
            /** Set down with a little bounce. */
            plop: () => b.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1.08)", opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }],
                { duration: 160, fill: "forwards" }),
            moveTo: (nx, ny) => { x = nx; y = ny; b.style.left = `${nx}px`; b.style.top = `${ny}px`; },
            fade: (ms = 400) => this._fadeOut(b, ms),
            remove: () => this._remove(b),
        };
    },

    /** A broken block's drop: a small one of the same face, bobbing and
     *  turning where the block was, until flyTo() takes it to who picked
     *  it up. */
    blockItem(src, x, y, size) {
        const s = size * 0.36;
        const it = this._track(el("rx_mc_block rx_mc_item", this.over));
        place(it, x - s / 2, y - s / 2, s, s);
        it.style.setProperty("--d", `${(s * 0.26).toFixed(1)}px`);
        it.style.backgroundImage = `url("${src}")`;
        const bob = it.animate([{ translate: "0 0", scale: "1 1" }, { translate: "0 -5px", scale: "0.25 1" }, { translate: "0 0", scale: "1 1" }],
            { duration: 900, iterations: Infinity, easing: "ease-in-out" });
        return {
            flyTo: async (tx, ty, ms = 260) => {
                bob.cancel();
                try {
                    await it.animate([{ transform: "translate(0,0) scale(1)" }, { transform: `translate(${tx - x}px, ${ty - y}px) scale(.3)` }],
                        { duration: ms, easing: "ease-in", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
                this._remove(it);
            },
            remove: () => this._remove(it),
        };
    },

    /** The row of nine slots along the bottom of the screen; give(src)
     *  puts one more of that in the first slot. */
    hotbar() {
        const bar = this._track(el("rx_mc_hotbar", this.over));
        const slot = 40;
        place(bar, (this._w - slot * 9) / 2, this._h - slot - 6, slot * 9, slot);
        const slots = [];
        for (let i = 0; i < 9; i++) slots.push(el(`rx_mc_slot${i === 0 ? " is-held" : ""}`, bar));
        bar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: "forwards" });
        let n = 0;
        return {
            give: (src) => {
                n++;
                slots[0].innerHTML = "";
                const icon = el("rx_mc_slot_icon", slots[0]);
                icon.style.backgroundImage = `url("${src}")`;
                if (n > 1) el("rx_mc_slot_n", slots[0], "span").textContent = String(n);
                slots[0].animate([{ scale: "1.25" }, { scale: "1" }], { duration: 160 });
            },
            remove: () => this._fadeOut(bar, 400),
        };
    },

    /** The toast that slides in at the top right: a heading, what was
     *  earned, a block face for its picture. Gone by itself. */
    toast(heading, name, icon = "dirt", ms = 5200) {
        const t = this._track(el("rx_mc_toast", this.over));
        Object.assign(t.style, { right: "0px", top: "12px" });
        const pic = el("rx_mc_toast_icon", t);
        pic.style.backgroundImage = `url("${blockTexture(icon)}")`;
        const text = el("rx_mc_toast_text", t);
        el("rx_mc_toast_heading", text).textContent = heading;
        el("rx_mc_toast_name", text).textContent = name;
        t.animate([{ transform: "translateX(105%)" }, { transform: "translateX(0)", offset: 0.07 },
            { transform: "translateX(0)", offset: 0.93 }, { transform: "translateX(105%)" }],
        { duration: ms, fill: "forwards", easing: "ease-out" }).finished.then(() => this._remove(t), () => {});
    },

    /** A line in the blocky game's chat, bottom left, for a few seconds. */
    worldChat(text, ms = 6500) {
        const c = this._track(el("rx_mc_chat", this.over));
        Object.assign(c.style, { left: "8px", bottom: "64px" });
        c.textContent = text;
        c.animate([{ opacity: 0 }, { opacity: 1, offset: 0.05 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: ms, fill: "forwards" })
            .finished.then(() => this._remove(c), () => {});
    },

    /** A blocky mob `h` px tall: moveTo(x, feet y, dir) places it, walk(on)
     *  moves its legs. */
    mob(kind, h, layer = null) {
        const m = MOBS[kind];
        const w = h * m.w / m.h;
        const frames = mobFrames(kind);
        const a = figure(this, layer || this.over, `rx_mc_mob rx_mc_mob--${kind}`, `<img alt="" src="${frames[0]}">`, w, h);
        const img = a.el.firstChild;
        let timer = null, f = 0;
        const walk = (on) => {
            clearInterval(timer);
            timer = on ? setInterval(() => { f = 1 - f; img.src = frames[f]; }, 190) : null;
            if (!on) img.src = frames[0];
        };
        const { remove, fade } = a;
        return Object.assign(a, { walk, remove: () => { walk(false); remove(); }, fade: (ms) => { walk(false); fade(ms); } });
    },

    /** Where blocks were taken out of the screen: each of `tiles` ({x, y},
     *  `size` px) a dark square of stone, as if there were rock behind. */
    pit(tiles, size) {
        const holes = tiles.map((t) => {
            const h = this._track(el("rx_mc_pit", this.under));
            place(h, t.x, t.y, size, size);
            h.style.backgroundImage = `url("${blockTexture("stone")}")`;
            return h;
        });
        return { remove: () => holes.forEach((h) => { if (this._live.has(h)) this._fadeOut(h, 300); }) };
    },

    /** The purple motes of something that just went, or just arrived, in
     *  a column `h` px tall about (x, y). */
    wisps(x, y, h, n = 16) {
        for (let i = 0; i < n; i++) {
            const w = this._track(el("rx_mc_wisp", this.over));
            const s = 4 + Math.random() * 5;
            place(w, x + (Math.random() - 0.5) * h * 0.45, y + (Math.random() - 0.5) * h, s, s);
            w.animate([{ transform: "translate(0,0)", opacity: 1 },
                { transform: `translate(${(Math.random() - 0.5) * 40}px, ${-20 - Math.random() * 40}px)`, opacity: 0 }],
            { duration: 600 + Math.random() * 500, fill: "forwards" }).finished.then(() => this._remove(w), () => {});
        }
    },

    // ── the old school ───────────────────────────────────────────────────

    /** One of FIGURES, `h` px tall, on the under or over layer. */
    figure(kind, h, { under = false } = {}) {
        const [svg, aspect] = FIGURES[kind];
        return figure(this, under ? this.under : this.over, `rx_rs_${kind}`, svg, h * aspect, h);
    },

    /** The chat box, bottom left: line(text, kind) adds one ("game" plain,
     *  "level" the blue of good news, "bad" red, "say" someone talking). */
    chatBox() {
        const box = this._track(el("rx_rs_chat", this.over));
        Object.assign(box.style, { left: "10px", bottom: "10px" });
        box.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 250, fill: "forwards" });
        return {
            line: (text, kind = "game") => {
                const l = el(`rx_rs_chat_line rx_rs_chat_line--${kind}`, box);
                l.textContent = text;
                while (box.children.length > 6) box.firstChild.remove();
            },
            remove: () => this._fadeOut(box, 500),
        };
    },

    /** Words over a head, the way players talk: yellow, or with one colour
     *  effect (flash1-3, glow1-3) and one that moves (wave, wave2, shake,
     *  scroll, slide). moveTo() follows the head. */
    overhead(text, x, y, { effects = [], ms = 3000 } = {}) {
        const o = this._track(el("rx_rs_overhead", this.follow));
        place(o, x, y, 1, 1);
        const inner = el("rx_rs_overhead_text", o, "span");
        const colour = CHAT_COLOURS[effects.find((e) => CHAT_COLOURS[e])];
        if (colour) {
            inner.animate(colour.colors.map((c) => ({ color: c })),
                { duration: colour.ms, iterations: Infinity, easing: colour.steps ? "steps(1, jump-none)" : "linear", direction: colour.steps ? "alternate" : "normal" });
        }
        const move = effects.find((e) => ["wave", "wave2", "shake", "scroll", "slide"].includes(e));
        if (move === "scroll" || move === "slide" || !move) {
            inner.textContent = text;
            if (move === "scroll") {
                inner.animate([{ transform: "translateX(60%)", clipPath: "inset(0 100% 0 0)" }, { transform: "translateX(0)", clipPath: "inset(0 0 0 0)", offset: 0.3 },
                    { transform: "translateX(0)", clipPath: "inset(0 0 0 0)", offset: 0.7 }, { transform: "translateX(-60%)", clipPath: "inset(0 0 0 100%)" }], { duration: ms, fill: "forwards" });
            } else if (move === "slide") {
                inner.animate([{ transform: "translateY(-120%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1, offset: 0.15 },
                    { transform: "translateY(0)", opacity: 1, offset: 0.85 }, { transform: "translateY(120%)", opacity: 0 }], { duration: ms, fill: "forwards" });
            }
        } else {
            [...text].forEach((ch, i) => {
                const s = el("rx_rs_overhead_ch", inner, "span");
                s.textContent = ch === " " ? " " : ch;
                const opts = { duration: 700, iterations: Infinity, delay: -i * 70, easing: "ease-in-out", direction: "alternate" };
                if (move === "wave") s.animate([{ transform: "translateY(-4px)" }, { transform: "translateY(4px)" }], opts);
                else if (move === "wave2") s.animate([{ transform: "translate(-3px,-4px)" }, { transform: "translate(3px,4px)" }], opts);
                else s.animate([{ transform: "translate(-1px,1px)" }, { transform: "translate(2px,-2px)" }, { transform: "translate(-2px,-1px)" }, { transform: "translate(1px,2px)" }],
                    { duration: 160, iterations: Infinity, delay: -i * 37, easing: "steps(4)" });
            });
        }
        const done = setTimeout(() => { if (this._live.has(o)) this._fadeOut(o, 200); }, ms);
        return {
            moveTo: (nx, ny) => { o.style.left = `${nx}px`; o.style.top = `${ny}px`; },
            remove: () => { clearTimeout(done); if (this._live.has(o)) this._remove(o); },
        };
    },

    /** Experience floating up from (x, y) and fading. */
    xpDrop(text, x, y) {
        const d = this._track(el("rx_rs_xp", this.over));
        d.textContent = text;
        place(d, x, y, 1, 1);
        d.animate([{ transform: "translate(-50%, 0)", opacity: 0 }, { transform: "translate(-50%, -14px)", opacity: 1, offset: 0.15 },
            { transform: "translate(-50%, -70px)", opacity: 1, offset: 0.8 }, { transform: "translate(-50%, -84px)", opacity: 0 }],
        { duration: 1800, fill: "forwards", easing: "linear" }).finished.then(() => this._remove(d), () => {});
    },

    /** A hit: the red burst with its number (blue for 0) at (x, y). */
    hitsplat(n, x, y, size = 34) {
        const h = this._track(el("rx_rs_hit", this.over));
        place(h, x - size / 2, y - size / 2, size, size);
        h.innerHTML = `<svg viewBox="0 0 100 100"><path d="${HITSPLAT}" fill="${n ? "#b91c1c" : "#1d4ed8"}" stroke="#00000055" stroke-width="3"/>`
            + `<text x="50" y="63" text-anchor="middle" font-size="40" font-weight="700" font-family="Trebuchet MS, Verdana, sans-serif" fill="#fff">${n}</text></svg>`;
        h.animate([{ transform: "scale(.4)", opacity: 0 }, { transform: "scale(1.1)", opacity: 1, offset: 0.12 },
            { transform: "scale(1)", opacity: 1, offset: 0.8 }, { transform: "scale(1)", opacity: 0 }], { duration: 1100, fill: "forwards" })
            .finished.then(() => this._remove(h), () => {});
    },

    /** The right-click menu at (x, y): `options` are [verb, target] pairs
     *  (the target in its own colour) or plain strings. choose(i) lights
     *  one up; remove(). */
    optionMenu(options, x, y, title = "Choose Option") {
        const m = this._track(el("rx_rs_menu", this.over));
        el("rx_rs_menu_head", m).textContent = title;
        const rows = options.map((o) => {
            const r = el("rx_rs_menu_row", m);
            if (Array.isArray(o)) {
                r.append(o[0] + " ");
                el("rx_rs_menu_target", r, "span").textContent = o[1];
            } else r.textContent = o;
            return r;
        });
        const w = m.offsetWidth || 180, h = m.offsetHeight || 120;
        Object.assign(m.style, { left: `${Math.max(4, Math.min(this._w - w - 4, x - w / 2))}px`, top: `${Math.max(4, Math.min(this._h - h - 4, y))}px` });
        return {
            choose: (i) => rows.forEach((r, j) => r.classList.toggle("is-on", i === j)),
            remove: () => this._remove(m),
        };
    },

});
