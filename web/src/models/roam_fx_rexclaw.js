// The Rexclaw set pieces' effects (models/roam_gags_rexclaw.js): the sea
// rising over the bottom of the screen, the Rexmaw under sail, the Kraken,
// Gerald the megalodon, the sky whale, a treasure map and its chest, and
// the crew dropping by (Sal, Rex, the Seagull Admiral). Drawn as inline SVG
// on RoamFx's layers (models/roam_fx.js), the same click-through DOM.

import { RoamFx, el, place, fxPick as pick, SVG_NS } from "./roam_fx";

const rand = (a, b) => a + Math.random() * (b - a);

/** A repeating wave crest, 120 × 24, its lower half the water's colour. */
const crest = (water, foam) => `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="${SVG_NS}" width="120" height="24" viewBox="0 0 120 24"><path d="M0 12 Q15 3 30 12 T60 12 T90 12 T120 12 V24 H0 Z" fill="${water}"/>`
    + `<path d="M0 12 Q15 3 30 12 T60 12 T90 12 T120 12" fill="none" stroke="${foam}" stroke-width="2.5"/></svg>`)}")`;

/** The Rexclaw claw, a pincer in a 40 × 40 box round (0, 0). */
const CLAW = "M-13 15 C-20 -2 -10 -18 5 -17 C1 -11 1 -6 7 -4 C13 -9 19 -3 15 4 C11 11 1 11 -3 7 C-5 11 -8 14 -13 15 Z";

// ── the drawings (viewBox units) ─────────────────────────────────────────

// The Rexmaw, side on, bow to the left: deck at y 194, waterline ~262.
const SHIP = `<svg viewBox="-30 0 430 300" overflow="visible">
<defs>
 <linearGradient id="rxHull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4520"/><stop offset="1" stop-color="#2e1a0c"/></linearGradient>
 <linearGradient id="rxSail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e6dbbd"/><stop offset=".55" stop-color="#fdf8ea"/><stop offset="1" stop-color="#d8c9a3"/></linearGradient>
 <clipPath id="rxHullClip"><path d="M14 194 L390 194 L384 214 Q366 268 300 286 L112 288 Q44 268 26 216 Z"/></clipPath>
</defs>
<g class="rig" stroke="#3b2a1a" stroke-width="1.3" fill="none">
 <path d="M-4 166 L110 40 L200 12 L376 150"/><path d="M200 30 L168 196 M200 30 L234 196 M110 52 L86 196 M110 52 L136 196"/>
 <path d="M200 60 L182 196 M200 60 L220 196" stroke-width="0.8"/>
</g>
<rect x="196" y="8" width="8" height="190" fill="#4a2c14"/><rect x="107" y="34" width="6" height="164" fill="#4a2c14"/>
<line x1="42" y1="198" x2="-8" y2="162" stroke="#4a2c14" stroke-width="6" stroke-linecap="round"/>
<g class="sails">
 <path class="sail" d="M106 50 L24 186 L102 186 Z" fill="url(#rxSail)" stroke="#bfae84"/>
 <path class="sail" d="M152 51 L248 51 Q260 80 246 110 L154 110 Q140 80 152 51 Z" fill="url(#rxSail)" stroke="#bfae84"/>
 <path class="sail" d="M142 117 L258 117 Q272 150 254 182 L146 182 Q128 150 142 117 Z" fill="url(#rxSail)" stroke="#bfae84"/>
 <path class="sail" d="M78 68 L142 68 Q152 92 140 116 L80 116 Q68 92 78 68 Z" fill="url(#rxSail)" stroke="#bfae84"/>
 <path class="sail" d="M72 122 L148 122 Q160 150 144 176 L76 176 Q60 150 72 122 Z" fill="url(#rxSail)" stroke="#bfae84"/>
 <circle cx="200" cy="150" r="21" fill="#b91c1c" opacity=".92"/>
 <path d="${CLAW}" transform="translate(200 150) scale(.9)" fill="#fef3c7"/>
</g>
<rect x="150" y="45" width="100" height="5" rx="2" fill="#4a2c14"/><rect x="140" y="112" width="120" height="5" rx="2" fill="#4a2c14"/>
<rect x="76" y="63" width="68" height="4" rx="2" fill="#4a2c14"/><rect x="70" y="118" width="80" height="4" rx="2" fill="#4a2c14"/>
<rect x="187" y="24" width="26" height="12" rx="3" fill="#5b3416"/>
<g class="flag"><path d="M204 6 L250 10 L244 19 L252 28 L204 28 Z" fill="#111827"/><path d="${CLAW}" transform="translate(222 17) scale(.32)" fill="#f8fafc"/></g>
<path d="M298 198 L298 154 L378 148 L388 196 Z" fill="url(#rxHull)"/>
<rect x="312" y="164" width="11" height="13" rx="2" fill="#fcd34d"/><rect x="332" y="163" width="11" height="13" rx="2" fill="#fcd34d"/><rect x="352" y="162" width="11" height="13" rx="2" fill="#fcd34d"/>
<path d="M298 154 L378 148" stroke="#d4a017" stroke-width="3"/>
<circle class="lamp" cx="384" cy="142" r="6" fill="#fde68a"/>
<path d="M14 194 L390 194 L384 214 Q366 268 300 286 L112 288 Q44 268 26 216 Z" fill="url(#rxHull)"/>
<g clip-path="url(#rxHullClip)" stroke="rgba(0,0,0,.32)" stroke-width="1.2"><path d="M0 226 H400 M0 244 H400 M0 262 H400 M0 278 H400"/></g>
<path d="M14 194 L390 194 L388 203 L16 203 Z" fill="#d4a017"/>
<g fill="#1c1209" stroke="#7f1d1d" stroke-width="1.5"><rect x="80" y="213" width="16" height="12" rx="2"/><rect x="130" y="213" width="16" height="12" rx="2"/><rect x="180" y="213" width="16" height="12" rx="2"/><rect x="230" y="213" width="16" height="12" rx="2"/><rect x="280" y="213" width="16" height="12" rx="2"/></g>
<g clip-path="url(#rxHullClip)"><rect x="296" y="226" width="70" height="16" rx="2" fill="#2a170a" opacity=".55"/>
<text x="300" y="238.5" textLength="62" lengthAdjust="spacingAndGlyphs" font-size="12" fill="#f5c542" stroke="#3b2208" stroke-width=".6" paint-order="stroke" font-family="Georgia, serif" font-weight="700">REXMAW</text></g>
</svg>`;
// Where the guns' muzzles are, and the deck they can stand on (viewBox).
const SHIP_PORTS = [88, 138, 188, 238, 288].map((x) => ({ x, y: 219 }));
const SHIP_BOX = { x: -30, y: 0, w: 430, h: 300, waterline: 262, deck: 194 };

// Gerald, side on, facing right; mouth open or shut, eye open or winking.
const SHARK = `<svg viewBox="-30 -20 330 150" overflow="visible">
<defs><linearGradient id="rxShark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#475569"/><stop offset="1" stop-color="#94a3b8"/></linearGradient></defs>
<path d="M18 70 L-22 26 L-6 70 L-24 116 Z" fill="#64748b"/>
<path d="M150 32 L178 -16 L196 34 Z" fill="#475569"/>
<path d="M10 70 C40 40 120 22 200 30 C240 34 272 50 292 66 C272 80 240 96 200 100 C130 108 50 100 10 70 Z" fill="url(#rxShark)"/>
<path d="M40 82 C90 100 160 104 220 96 C250 92 272 80 290 68 C270 88 240 102 200 106 C130 112 70 104 40 82 Z" fill="#f1f5f9"/>
<path d="M168 94 L146 128 L198 100 Z" fill="#475569"/>
<path d="M212 56 q-5 12 0 24 M222 56 q-5 12 0 24 M232 58 q-5 11 0 22" stroke="#334155" stroke-width="2.5" fill="none"/>
<g class="jaw-open"><path d="M236 72 Q268 104 294 66 Z" fill="#7f1d1d"/><path d="M240 74 l5 7 l5 -6 l5 8 l5 -7 l5 8 l5 -7 l5 7 l5 -8 l4 6 M246 90 l4 -6 l5 6 l5 -7 l5 6 l5 -7 l4 5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linejoin="round"/></g>
<g class="jaw-shut"><path d="M246 78 Q268 86 288 70" stroke="#1e293b" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M252 80 l3 5 l3 -4 M262 82 l3 5 l3 -5" stroke="#fff" stroke-width="2" fill="none"/></g>
<g class="eye-open"><circle cx="252" cy="50" r="9" fill="#fff"/><circle cx="255" cy="51" r="5" fill="#0f172a"/><circle cx="257" cy="49" r="1.6" fill="#fff"/></g>
<path class="eye-wink" d="M243 52 Q252 44 261 52" stroke="#0f172a" stroke-width="3" fill="none" stroke-linecap="round"/>
<ellipse cx="262" cy="64" rx="7" ry="4" fill="#fda4af" opacity=".7"/>
</svg>`;
const FIN = `<svg viewBox="0 0 60 50"><path d="M4 50 C14 30 26 8 44 0 C40 18 44 36 58 50 Z" fill="#475569"/><path d="M44 0 C40 18 44 36 58 50 L50 50 C38 36 36 18 44 0 Z" fill="#334155"/></svg>`;

// The sky whale, side on, facing right.
const WHALE = `<svg viewBox="-40 0 440 200" overflow="visible">
<defs><linearGradient id="rxWhale" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>
<path class="fluke" d="M34 106 C12 92 -8 60 -26 40 C2 50 20 68 36 90 C16 100 -6 124 -22 154 C6 134 22 120 36 112 Z" fill="#2563eb"/>
<path d="M20 110 C30 60 120 30 230 34 C320 38 380 70 392 104 C384 132 330 156 240 160 C140 166 60 150 20 110 Z" fill="url(#rxWhale)"/>
<path d="M80 136 C160 162 290 162 372 124 C340 152 270 170 210 170 C150 170 108 158 80 136 Z" fill="#dbeafe"/>
<path d="M140 154 C200 166 270 164 330 146 M150 162 C210 172 270 170 318 156" stroke="#93c5fd" stroke-width="2" fill="none"/>
<path class="flipper" d="M224 142 C214 172 192 188 170 192 C196 172 206 152 212 140 Z" fill="#1e40af"/>
<circle cx="330" cy="94" r="7" fill="#0f172a"/><circle cx="332" cy="92" r="2" fill="#fff"/>
<path d="M348 118 Q370 124 388 110" stroke="#0f172a" stroke-width="3" fill="none" stroke-linecap="round"/>
<ellipse cx="340" cy="114" rx="10" ry="5" fill="#f9a8d4" opacity=".75"/>
<g fill="#cbd5e1"><circle cx="190" cy="44" r="4"/><circle cx="200" cy="40" r="3"/><circle cx="172" cy="50" r="3"/></g>
<ellipse cx="276" cy="38" rx="6" ry="2.5" fill="#1e3a8a"/>
</svg>`;

// The Kraken's eye, peering up out of the sea.
const KRAKEN_EYE = `<svg viewBox="0 0 220 150" overflow="visible">
<path d="M10 150 C10 60 60 10 110 10 C160 10 210 60 210 150 Z" fill="#6d28d9"/>
<path d="M40 150 C40 90 70 60 110 60 C150 60 180 90 180 150 Z" fill="#5b21b6"/>
<ellipse cx="110" cy="92" rx="52" ry="38" fill="#fefce8"/>
<ellipse class="iris" cx="110" cy="92" rx="30" ry="30" fill="#facc15"/>
<ellipse class="pupil" cx="110" cy="92" rx="6" ry="26" fill="#0f172a"/>
<circle cx="98" cy="80" r="6" fill="#fff" opacity=".9"/>
<path class="lid" d="M56 92 C56 44 164 44 164 92 C150 72 70 72 56 92 Z" fill="#7c3aed"/>
</svg>`;

// A treasure chest, front on; the lid hinged at the back.
const CHEST = `<svg viewBox="0 0 120 100" overflow="visible">
<defs><linearGradient id="rxChest" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a0662f"/><stop offset="1" stop-color="#5b3416"/></linearGradient></defs>
<path d="M10 44 L110 44 L106 96 L14 96 Z" fill="url(#rxChest)"/>
<path d="M12 62 H108 M13 80 H107" stroke="rgba(0,0,0,.3)" stroke-width="1.5"/>
<g fill="#475569"><rect x="22" y="44" width="7" height="52"/><rect x="91" y="44" width="7" height="52"/></g>
<rect x="53" y="46" width="14" height="16" rx="2" fill="#facc15" stroke="#a16207" stroke-width="1.5"/>
<g class="lid"><path d="M8 46 C8 18 112 18 112 46 Z" fill="url(#rxChest)"/><path d="M22 46 C22 24 29 22 29 22 L29 46 Z M91 22 C91 22 98 24 98 46 L91 46 Z" fill="#475569"/>
<path d="M8 46 H112" stroke="#facc15" stroke-width="3"/></g>
</svg>`;

// The crew, dropping by.
const FROG = `<svg viewBox="0 0 100 90" overflow="visible">
<ellipse cx="50" cy="62" rx="40" ry="26" fill="#22c55e"/><ellipse cx="50" cy="70" rx="26" ry="16" fill="#bbf7d0"/>
<ellipse cx="20" cy="84" rx="16" ry="6" fill="#15803d"/><ellipse cx="80" cy="84" rx="16" ry="6" fill="#15803d"/>
<circle cx="31" cy="30" r="15" fill="#22c55e"/><circle cx="69" cy="30" r="15" fill="#22c55e"/>
<circle cx="31" cy="29" r="10" fill="#fff"/><circle cx="69" cy="29" r="10" fill="#fff"/>
<circle class="pupil" cx="33" cy="30" r="5" fill="#0f172a"/><circle class="pupil" cx="71" cy="30" r="5" fill="#0f172a"/>
<g fill="none" stroke="#78350f" stroke-width="2.2"><circle cx="31" cy="29" r="12"/><circle cx="69" cy="29" r="12"/><path d="M43 29 Q50 25 57 29"/></g>
<path d="M28 56 Q50 70 72 56" stroke="#14532d" stroke-width="3" fill="none" stroke-linecap="round"/>
<ellipse cx="22" cy="56" rx="5" ry="3" fill="#fda4af" opacity=".7"/><ellipse cx="78" cy="56" rx="5" ry="3" fill="#fda4af" opacity=".7"/>
</svg>`;
const LOBSTER = `<svg viewBox="0 0 140 110" overflow="visible">
<g stroke="#991b1b" stroke-width="3" stroke-linecap="round" fill="none"><path d="M58 30 C40 6 20 4 6 12"/><path d="M82 30 C100 6 120 4 134 12"/>
<path d="M54 72 L36 92 M58 78 L44 100 M86 72 L104 92 M82 78 L96 100"/></g>
<g class="claw-l"><path d="M50 56 C34 52 22 42 18 30" stroke="#dc2626" stroke-width="9" stroke-linecap="round" fill="none"/>
<path d="M18 30 C4 26 2 8 14 2 C14 10 18 14 24 14 C30 6 40 10 36 20 C32 30 24 32 18 30 Z" fill="#ef4444"/></g>
<g class="claw-r"><path d="M90 56 C106 52 118 42 122 30" stroke="#dc2626" stroke-width="9" stroke-linecap="round" fill="none"/>
<path d="M122 30 C136 26 138 8 126 2 C126 10 122 14 116 14 C110 6 100 10 104 20 C108 30 116 32 122 30 Z" fill="#ef4444"/></g>
<ellipse cx="70" cy="60" rx="24" ry="30" fill="#dc2626"/><path d="M50 70 H90 M52 80 H88 M56 89 H84" stroke="#991b1b" stroke-width="2.5"/>
<path d="M58 96 L70 108 L82 96 Z" fill="#b91c1c"/>
<g><path d="M62 34 L58 22 M78 34 L82 22" stroke="#991b1b" stroke-width="3"/><circle cx="58" cy="20" r="5" fill="#0f172a"/><circle cx="82" cy="20" r="5" fill="#0f172a"/>
<circle cx="59" cy="19" r="1.6" fill="#fff"/><circle cx="83" cy="19" r="1.6" fill="#fff"/></g>
<path d="M48 22 C52 6 88 6 92 22 Z" fill="#111827"/><path d="M48 22 H92" stroke="#d4a017" stroke-width="2.5"/><circle cx="70" cy="13" r="3" fill="#d4a017"/>
<path d="M60 50 Q70 56 80 50" stroke="#7f1d1d" stroke-width="2.5" fill="none" stroke-linecap="round"/>
</svg>`;
const GULL = `<svg viewBox="0 0 130 90" overflow="visible">
<path class="wing-back" d="M60 44 C46 20 30 10 10 8 C24 22 34 36 44 50 Z" fill="#94a3b8"/>
<ellipse cx="62" cy="54" rx="32" ry="18" fill="#f8fafc"/><path d="M32 54 L8 48 L30 62 Z" fill="#cbd5e1"/>
<circle cx="92" cy="40" r="15" fill="#f8fafc"/>
<path d="M104 40 L124 44 L104 48 Z" fill="#f59e0b"/><circle cx="125" cy="44" r="2" fill="#dc2626"/>
<circle cx="96" cy="36" r="3" fill="#0f172a"/>
<path d="M70 72 L66 88 M80 72 L82 88" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>
<path class="wing-front" d="M66 50 C58 24 44 12 24 10 C36 26 44 42 50 58 Z" fill="#cbd5e1"/>
<path d="M76 26 C80 14 104 14 108 26 Z" fill="#1e3a8a"/><path d="M72 27 H112" stroke="#d4a017" stroke-width="3"/><circle cx="92" cy="18" r="3.5" fill="#d4a017"/>
</svg>`;

/** A drawing on a layer: placed by its centre each frame (moveTo), turned
 *  and scaled about it. */
function actor(fx, layer, cls, svg, w, h) {
    const a = fx._track(el(`rx_roam_actor ${cls}`, layer));
    place(a, 0, 0, w, h);
    a.innerHTML = svg;
    let cx = -9999, cy = -9999, deg = 0, sx = 1, sy = 1;
    const apply = () => { a.style.transform = `translate(${(cx - w / 2).toFixed(1)}px, ${(cy - h / 2).toFixed(1)}px) rotate(${deg.toFixed(1)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`; };
    return {
        el: a, w, h,
        get x() { return cx; }, get y() { return cy; },
        moveTo: (x, y, d = deg, scx = sx, scy = sy) => { cx = x; cy = y; deg = d; sx = scx; sy = scy; apply(); },
        /** A point of the drawing (its own viewBox units over `box`) in page px. */
        point: (box, ux, uy) => {
            const kx = w / box.w, ky = h / box.h;
            const lx = (ux - box.x) * kx - w / 2, ly = (uy - box.y) * ky - h / 2;
            const r = deg * Math.PI / 180;
            return { x: cx + (lx * Math.cos(r) - ly * Math.sin(r)) * sx, y: cy + (lx * Math.sin(r) + ly * Math.cos(r)) * sy };
        },
        set: (cls2, on) => a.classList.toggle(cls2, on),
        fade: (ms = 400) => fx._fadeOut(a, ms),
        remove: () => fx._remove(a),
    };
}

/** Run `fn(s)` with s from 0 to 1 over `ms`, every frame. */
function tween(ms, fn) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const step = (t) => {
            const s = Math.min(1, (t - t0) / ms);
            try { fn(s); } catch (e) { /* removed meanwhile */ }
            if (s < 1) requestAnimationFrame(step);
            else resolve();
        };
        requestAnimationFrame(step);
    });
}

Object.assign(RoamFx.prototype, {
    /** The sea over the bottom of the screen: a back layer behind the
     *  character, a see-through front one before them (they stand in it).
     *  rise(level, ms) / drain(ms); `level` px above the screen's bottom. */
    sea() {
        const W = this._w, H = this._h;
        const make = (layer, cls, water, foam, ms) => {
            const s = this._track(el(`rx_roam_sea ${cls}`, layer));
            place(s, 0, H, W, 0);
            const c = el("rx_roam_sea_crest", s);
            c.style.backgroundImage = crest(water, foam);
            c.animate([{ backgroundPositionX: "0px" }, { backgroundPositionX: "120px" }], { duration: ms, iterations: Infinity });
            return s;
        };
        const back = make(this.under, "rx_roam_sea--back", "#0e7490", "#a5f3fc", 2600);
        const front = make(this.over, "rx_roam_sea--front", "#0891b2", "#ecfeff", 1700);
        let level = 0;
        const set = (lv) => {
            level = lv;
            back.style.top = `${H - lv - 8}px`;
            back.style.height = `${lv + 40}px`;
            front.style.top = `${H - lv}px`;
            front.style.height = `${lv + 40}px`;
        };
        return {
            get level() { return level; },
            get surface() { return H - level; },
            rise: (lv, ms = 1500) => { const l0 = level; return tween(ms, (s) => set(l0 + (lv - l0) * s * (2 - s))); },
            drain: async (ms = 1500) => {
                const l0 = level;
                await tween(ms, (s) => set(l0 * (1 - s * s)));
                this._remove(back);
                this._remove(front);
            },
            stop: () => { this._fadeOut(back, 800); this._fadeOut(front, 800); },
        };
    },

    /** The Rexmaw under sail, `w` px long: moveTo(x, waterline y, roll)
     *  places it by its middle at the waterline; deck(ux) / port(i) are
     *  points on it (page px). */
    rexmaw(w) {
        const h = w * SHIP_BOX.h / SHIP_BOX.w;
        const a = actor(this, this.under, "rx_roam_ship", SHIP, w, h);
        const midY = SHIP_BOX.y + SHIP_BOX.h / 2;
        return {
            ...a,
            moveTo: (x, water, roll = 0) => a.moveTo(x, water - (SHIP_BOX.waterline - midY) * (h / SHIP_BOX.h), roll),
            deck: (ux) => a.point(SHIP_BOX, ux, SHIP_BOX.deck),
            port: (i) => a.point(SHIP_BOX, SHIP_PORTS[i].x, SHIP_PORTS[i].y),
            ports: SHIP_PORTS.length,
        };
    },

    /** Gerald, `w` px long, and his fin on its own. */
    gerald(w) {
        const a = actor(this, this.over, "rx_roam_shark", SHARK, w, w * 150 / 330);
        a.set("is-shut", true);
        return {
            ...a,
            mouth: (open) => a.set("is-shut", !open),
            wink: (on) => a.set("is-wink", on),
            jaw: () => a.point({ x: -30, y: -20, w: 330, h: 150 }, 280, 76),
        };
    },

    fin(w) {
        return actor(this, this.over, "rx_roam_fin", FIN, w, w * 50 / 60);
    },

    whale(w) {
        const a = actor(this, this.over, "rx_roam_whale", WHALE, w, w * 200 / 440);
        return { ...a, spout: () => a.point({ x: -40, y: 0, w: 440, h: 200 }, 276, 36) };
    },

    krakenEye(w) {
        const a = actor(this, this.under, "rx_roam_kraken_eye", KRAKEN_EYE, w, w * 150 / 220);
        return {
            ...a,
            blink: () => a.el.querySelector(".lid")?.animate([{ scale: "1 1" }, { scale: "1 2.3" }, { scale: "1 1" }],
                { duration: 260, easing: "ease-in-out" }),
            squint: (on) => a.set("is-squint", on),
        };
    },

    /** A Kraken's tentacle from (bx, by) (below the screen) toward a grip
     *  point; set(grip, reach 0..1, t, opts) every frame redraws it. */
    tentacle(width) {
        const svg = this._track(document.createElementNS(SVG_NS, "svg"));
        svg.setAttribute("class", "rx_roam_tentacle");
        this.under.appendChild(svg);
        const body = document.createElementNS(SVG_NS, "path");
        const belly = document.createElementNS(SVG_NS, "path");
        const suckers = document.createElementNS(SVG_NS, "g");
        body.setAttribute("class", "body");
        belly.setAttribute("class", "belly");
        suckers.setAttribute("class", "suckers");
        svg.append(body, belly, suckers);
        const phase = Math.random() * Math.PI * 2;
        const N = 34;
        return {
            /** `base` and `tip`: page px; `curl` ±1 hooks the tip over an
             *  edge that way; `amp` the wriggle (px). */
            set: (base, tip, reach, t, { curl = 0, amp = 16 } = {}) => {
                const pts = [];
                const c1 = { x: base.x, y: base.y - (base.y - tip.y) * 0.45 };
                const c2 = { x: tip.x - curl * 40, y: tip.y + Math.abs(base.y - tip.y) * 0.25 };
                for (let i = 0; i <= N; i++) {
                    const s = (i / N) * reach, u = 1 - s;
                    let x = u * u * u * base.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * tip.x;
                    let y = u * u * u * base.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * tip.y;
                    x += Math.sin(s * 9 - t * 3.2 + phase) * amp * s * (curl ? 1 - s * s : 1);
                    pts.push({ x, y });
                }
                // Hooked over the edge: on over the top and down the far side.
                if (curl && reach > 0.98) {
                    const k = width * 0.5;
                    pts.push({ x: tip.x + curl * k * 0.6, y: tip.y - k * 0.55 }, { x: tip.x + curl * k * 1.25, y: tip.y - k * 0.2 },
                        { x: tip.x + curl * k * 1.5, y: tip.y + k * 0.6 });
                }
                const L = [], R = [], S = [];
                for (let i = 0; i < pts.length; i++) {
                    const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
                    const dx = q.x - o.x, dy = q.y - o.y, l = Math.hypot(dx, dy) || 1;
                    const nx = -dy / l, ny = dx / l;
                    const wd = width * (1 - 0.86 * (i / (pts.length - 1))) / 2;
                    L.push(`${(p.x + nx * wd).toFixed(1)} ${(p.y + ny * wd).toFixed(1)}`);
                    R.push(`${(p.x - nx * wd).toFixed(1)} ${(p.y - ny * wd).toFixed(1)}`);
                    S.push({ x: p.x - nx * wd * 0.45, y: p.y - ny * wd * 0.45, r: wd * 0.32 });
                }
                body.setAttribute("d", `M${L.join(" L")} L${R.reverse().join(" L")} Z`);
                belly.setAttribute("d", `M${S.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L")}`);
                belly.style.strokeWidth = `${(width * 0.3).toFixed(1)}px`;
                suckers.innerHTML = S.filter((_, i) => i % 3 === 1 && i > 3)
                    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${Math.max(1.5, p.r).toFixed(1)}"/>`).join("");
            },
            stop: () => this._fadeOut(svg, 500),
        };
    },

    /** Ink clouds blooming at (x, y) and fading. */
    ink(x, y, size) {
        for (let i = 0; i < 6; i++) {
            const b = this._track(el("rx_roam_ink", this.over));
            const s = size * rand(0.5, 1);
            place(b, x + rand(-0.6, 0.6) * size - s / 2, y + rand(-0.4, 0.2) * size - s / 2, s, s);
            b.animate([{ scale: 0.2, opacity: 0.95 }, { scale: 1.3, opacity: 0.8, offset: 0.3 }, { scale: 1.8, opacity: 0 }],
                { duration: 2600 + Math.random() * 1200, delay: i * 90, easing: "ease-out", fill: "forwards" })
                .finished.then(() => this._remove(b), () => {});
        }
    },

    /** A big splash: a crown of water up from (x, y) and spray. */
    bigSplash(x, y, size) {
        const c = this._track(el("rx_roam_crown", this.over));
        place(c, x - size / 2, y - size * 0.9, size, size);
        c.animate([{ scale: "0.3 0.1", opacity: 1 }, { scale: "1 1", opacity: 0.95, offset: 0.35 }, { scale: "1.25 0.6", opacity: 0 }],
            { duration: 1100, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(c), () => {});
        for (let i = 0; i < 26; i++) {
            const d = this._track(el("rx_roam_drop2", this.over));
            const s = 5 + Math.random() * 9;
            place(d, x, y, s, s);
            const dx = rand(-1, 1) * size * 0.9, up = size * rand(0.5, 1.3);
            d.animate([{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${dx * 0.6}px, ${-up}px)`, offset: 0.45 },
                { transform: `translate(${dx}px, ${size * 0.2}px)`, opacity: 0 }], { duration: 1200 + Math.random() * 500, easing: "ease-out", fill: "forwards" })
                .finished.then(() => this._remove(d), () => {});
        }
    },

    /** Gold coins: `n` thrown up from (x, y) (or raining from above with
     *  `rain`), bouncing on floorY and lying a moment. */
    coins(x, y, floorY, n = 24, { rain = false, spread = 200 } = {}) {
        for (let i = 0; i < n; i++) {
            const c = this._track(el("rx_roam_coin", this.over));
            const s = 14 + Math.random() * 8;
            const x0 = rain ? x + rand(-1, 1) * spread : x;
            const y0 = rain ? -30 - Math.random() * 300 : y;
            place(c, x0 - s / 2, y0 - s / 2, s, s);
            const dx = rain ? rand(-30, 30) : rand(-1, 1) * spread;
            const up = rain ? 0 : rand(80, 220);
            const fall = floorY - y0 - s / 2;
            const ms = rain ? 900 + fall * 0.9 : 1300 + Math.random() * 500;
            c.animate([{ transform: "translate(0,0)" },
                { transform: `translate(${dx * 0.5}px, ${-up}px)`, offset: rain ? 0.01 : 0.35, easing: "ease-in" },
                { transform: `translate(${dx}px, ${fall}px)`, offset: 0.8, easing: "ease-out" },
                { transform: `translate(${dx * 1.08}px, ${fall - 18}px)`, offset: 0.9, easing: "ease-in" },
                { transform: `translate(${dx * 1.12}px, ${fall}px)` }],
            { duration: ms, delay: (rain ? Math.random() * 1800 : i * 30), fill: "forwards" });
            c.animate([{ scale: "1 1" }, { scale: "0.15 1" }, { scale: "1 1" }], { duration: 380, iterations: 8 });
            setTimeout(() => { if (this._live.has(c)) this._fadeOut(c, 900); }, ms + 5000);
        }
    },

    /** A treasure chest standing on y at x, rising out of the ground;
     *  open() throws the lid back in a burst of gold light. */
    chest(x, y, w) {
        const a = actor(this, this.under, "rx_roam_chest", CHEST, w, w * 100 / 120);
        a.moveTo(x, y - a.h / 2 + a.h * 0.04);
        a.el.animate([{ clipPath: "inset(0 0 100% 0)", translate: `0 ${a.h * 0.6}px` }, { clipPath: "inset(0 0 0 0)", translate: "0 0" }],
            { duration: 1100, easing: "ease-out", fill: "forwards" });
        return {
            open: () => {
                const g = this._track(el("rx_roam_goldglow", this.under));
                place(g, x - w, y - a.h * 1.9, w * 2, w * 2);
                g.animate([{ opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1 }], { duration: 500, fill: "forwards" });
                g.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 9000, iterations: Infinity });
                // Thrown back on its hinge: seen from the front, it flips
                // up over the chest, its inside showing.
                a.el.querySelector(".lid")?.animate([{ scale: "1 1" }, { scale: "1 -0.7" }],
                    { duration: 380, easing: "cubic-bezier(.3,1.6,.5,1)", fill: "forwards" });
                return { stop: () => this._fadeOut(g, 800) };
            },
            sink: async () => {
                try {
                    await a.el.animate([{ clipPath: "inset(0 0 0 0)", translate: "0 0" }, { clipPath: "inset(0 0 100% 0)", translate: `0 ${a.h * 0.6}px` }],
                        { duration: 900, easing: "ease-in", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
                a.remove();
            },
            remove: () => a.fade(300),
        };
    },

    /** A treasure map of this very screen — its windows sketched in, a
     *  dotted way from `from` to the X at `to` (page px) — unrolling at
     *  the top of the screen; roll() rolls it up again. */
    treasureMap(windows, from, to) {
        const W = this._w, H = this._h;
        const mw = Math.min(W * 0.3, 400), mh = mw * 0.62;
        const m = this._track(el("rx_roam_map", this.over));
        place(m, W / 2 - mw / 2, H * 0.08, mw, mh);
        const pad = mw * 0.08, iw = mw - 2 * pad, ih = mh - 2 * pad;
        const sx = iw / W, sy = ih / H;
        const X = (v) => (pad + v * sx).toFixed(1), Y = (v) => (pad + v * sy).toFixed(1);
        const wins = windows.filter((w) => !w.maximized).slice(0, 12)
            .map((w) => `<rect x="${X(w.x)}" y="${Y(w.y)}" width="${(w.width * sx).toFixed(1)}" height="${(w.height * sy).toFixed(1)}" rx="3"/>`).join("");
        const mx = (from.x + to.x) / 2, my = Math.min(from.y, to.y) - H * 0.25;
        const route = `M${X(from.x)} ${Y(from.y)} Q${X(mx)} ${Y(my)} ${X(to.x)} ${Y(to.y)}`;
        const r = mw * 0.06, cx = mw - pad * 1.6, cy = pad * 1.6;
        m.innerHTML = `<svg viewBox="0 0 ${mw.toFixed(1)} ${mh.toFixed(1)}">
            <rect class="frame" x="${(pad * 0.5).toFixed(1)}" y="${(pad * 0.5).toFixed(1)}" width="${(mw - pad).toFixed(1)}" height="${(mh - pad).toFixed(1)}" rx="6"/>
            <g class="wins">${wins}</g>
            <path class="route" d="${route}"/>
            <circle class="you" cx="${X(from.x)}" cy="${Y(from.y)}" r="${(mw * 0.012).toFixed(1)}"/>
            <path class="x" d="M${(+X(to.x) - mw * 0.03).toFixed(1)} ${(+Y(to.y) - mw * 0.03).toFixed(1)} l${(mw * 0.06).toFixed(1)} ${(mw * 0.06).toFixed(1)} m0 ${(-mw * 0.06).toFixed(1)} l${(-mw * 0.06).toFixed(1)} ${(mw * 0.06).toFixed(1)}"/>
            <g class="rose" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})"><circle r="${r.toFixed(1)}"/><path d="M0 ${(-r * 1.3).toFixed(1)} L${(r * 0.25).toFixed(1)} 0 L0 ${(r * 1.3).toFixed(1)} L${(-r * 0.25).toFixed(1)} 0 Z M${(-r * 1.3).toFixed(1)} 0 L0 ${(r * 0.25).toFixed(1)} L${(r * 1.3).toFixed(1)} 0 L0 ${(-r * 0.25).toFixed(1)} Z"/>
            <text y="${(-r * 1.45).toFixed(1)}" font-size="${(r * 0.8).toFixed(1)}">N</text></g>
            <path class="seal" d="${CLAW}" transform="translate(${(pad * 1.7).toFixed(1)} ${(mh - pad * 1.7).toFixed(1)}) scale(${(mw / 900).toFixed(3)})"/>
        </svg>`;
        el("rx_roam_map_roll rx_roam_map_roll--l", m);
        el("rx_roam_map_roll rx_roam_map_roll--r", m);
        m.animate([{ clipPath: "inset(0 49% 0 49%)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 900, easing: "ease-out", fill: "forwards" });
        for (const [sel, delay] of [[".route", 700], [".x", 1500]]) {
            m.querySelector(sel)?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay, fill: "both" });
        }
        return {
            rect: { x: W / 2 - mw / 2, y: H * 0.08, width: mw, height: mh },
            roll: async () => {
                try {
                    await m.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 49% 0 49%)" }], { duration: 600, easing: "ease-in", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
                this._remove(m);
            },
        };
    },

    /** A dotted trail along the floor at y from x0, drawn on to x by
     *  to(x) as they walk it. */
    trail(x0, y) {
        const t = this._track(el("rx_roam_trail", this.under));
        place(t, x0, y - 5, 0, 5);
        return {
            to: (x) => {
                t.style.left = `${Math.min(x0, x)}px`;
                t.style.width = `${Math.abs(x - x0)}px`;
            },
            fade: (ms = 1500) => this._fadeOut(t, ms),
        };
    },

    /** One of the crew dropping by: "frog" (Sal), "lobster" (Rex) or "gull"
     *  (the Seagull Admiral), `w` px wide. */
    crewmate(kind, w) {
        const art = { frog: [FROG, 100, 90], lobster: [LOBSTER, 140, 110], gull: [GULL, 130, 90] }[kind];
        const a = actor(this, this.over, `rx_roam_crew rx_roam_crew--${kind}`, art[0], w, w * art[2] / art[1]);
        return a;
    },
});

export { tween, rand as fxRand, pick as fxPickAny };
