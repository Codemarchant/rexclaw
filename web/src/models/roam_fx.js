// Effects a roaming companion leaves on the screen (models/roam_director.js):
// portals, things torn off the screen and the hole they leave, crumbs,
// doodles and notes, sleep z's, bath bubbles, hearts. Plain DOM in two
// click-through layers of the mascot overlay — `under` sits behind the
// character (holes, doodles), `over` in front (what they hold, particles).
// Motion is the Web Animations API; looks are in styles/mascot.scss
// (.rx_roam_*). Nothing here touches the real screen: a "torn off" link is
// a picture of it from the last look, over a patch in the colour around it.

const SVG_NS = "http://www.w3.org/2000/svg";

// Doodles: hand-drawn strokes in a 100 × 100 box, drawn in stroke order.
const DOODLES = {
    heart: ["M50 84 C18 62 6 38 24 22 C36 12 48 20 50 32 C52 20 64 12 76 22 C94 38 82 62 50 84"],
    star: ["M50 8 L61 38 L94 38 L67 57 L77 90 L50 70 L23 90 L33 57 L6 38 L39 38 Z"],
    smiley: ["M50 10 C74 10 90 28 90 50 C90 74 72 90 50 90 C26 90 10 72 10 50 C10 28 28 10 50 10",
             "M36 38 L36 44", "M64 38 L64 44", "M30 60 C40 74 60 74 70 60"],
    flower: ["M50 50 C40 30 60 30 50 50 C70 40 70 60 50 50 C60 70 40 70 50 50 C30 60 30 40 50 50",
             "M50 58 C48 72 50 84 52 96", "M51 80 C58 74 66 74 70 78"],
    cat: ["M22 40 L28 14 L42 30 C47 28 53 28 58 30 L72 14 L78 40 C84 62 70 82 50 82 C30 82 16 62 22 40",
          "M38 50 L38 54", "M62 50 L62 54", "M46 62 L50 66 L54 62",
          "M30 62 L12 58", "M30 66 L12 70", "M70 62 L88 58", "M70 66 L88 70"],
    sun: ["M50 32 C60 32 68 40 68 50 C68 60 60 68 50 68 C40 68 32 60 32 50 C32 40 40 32 50 32",
          "M50 8 L50 22", "M50 78 L50 92", "M8 50 L22 50", "M78 50 L92 50",
          "M20 20 L30 30", "M70 70 L80 80", "M80 20 L70 30", "M30 70 L20 80"],
    note: ["M38 76 C30 76 26 82 30 86 C36 90 44 86 44 78 L44 20 L76 12 L76 66",
           "M70 64 C62 64 58 70 62 74 C68 78 76 74 76 66", "M44 32 L76 24"],
    cake: ["M18 88 L82 88 L82 60 L18 60 Z", "M18 70 C28 76 38 64 50 70 C62 76 72 64 82 70",
           "M24 60 L24 44 L76 44 L76 60", "M50 44 L50 30", "M50 26 C46 20 50 14 50 14 C50 14 54 20 50 26"],
    dog: ["M30 40 C30 22 70 22 70 40 C74 64 64 80 50 80 C36 80 26 64 30 40", "M30 36 C18 34 14 56 24 62",
          "M70 36 C82 34 86 56 76 62", "M40 46 L40 50", "M60 46 L60 50", "M44 62 C48 66 52 66 56 62", "M50 58 L50 62"],
    coffee: ["M22 40 L72 40 L66 86 L28 86 Z", "M72 50 C88 50 88 70 70 70",
             "M38 30 C34 24 42 20 38 12", "M52 30 C48 24 56 20 52 12"],
    book: ["M50 26 C40 18 22 18 12 22 L12 80 C22 76 40 76 50 84 C60 76 78 76 88 80 L88 22 C78 18 60 18 50 26",
           "M50 26 L50 84", "M20 36 L40 36", "M60 36 L80 36", "M20 48 L40 48", "M60 48 L80 48"],
    gamepad: ["M20 40 C8 40 6 76 18 76 C26 76 30 66 36 64 L64 64 C70 66 74 76 82 76 C94 76 92 40 80 40 Z",
              "M28 50 L28 60", "M23 55 L33 55", "M70 50 L70 50.5", "M78 56 L78 56.5"],
    pizza: ["M50 90 L14 22 C36 12 64 12 86 22 Z", "M18 30 C38 22 62 22 82 30",
            "M42 40 L42 41", "M58 48 L58 49", "M50 64 L50 65", "M36 54 L36 55"],
};
export const DOODLE_KINDS = Object.keys(DOODLES);
// Drawings for particular gags, not picked at random.
const SPECIAL = {
    moustache: ["M50 50 C40 40 22 44 18 56 C14 64 24 62 28 58 C34 52 42 54 50 58",
                "M50 50 C60 40 78 44 82 56 C86 64 76 62 72 58 C66 52 58 54 50 58"],
    x: ["M8 8 L92 92", "M92 8 L8 92"],
};
// The longest anything stays after its action: past the longest leftover
// by design, a buried thing's mound (BURIED_MAX_MS 50 s, roam_gags.js).
const LINGER_MS = 60000;
// Ink colours, picked per doodle.
const INKS = ["#ff5fa2", "#ffb000", "#38bdf8", "#a78bfa", "#34d399", "#f97316"];

function el(cls, parent, tag = "div") {
    const e = document.createElement(tag);
    e.className = cls;
    parent.appendChild(e);
    return e;
}

function place(e, x, y, w, h) {
    Object.assign(e.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class RoamFx {
    /** `follow`: a third layer, in front, for what goes about with the
     *  character (their rain cloud, z's, parachute, speech, fishing line):
     *  ghost mode fades it with them (.is-roam-faded in mascot.scss). */
    constructor(under, over, follow = over) {
        this.under = under;
        this.over = over;
        this.follow = follow;
        this._live = new Set();
        this._action = 0;
    }

    _track(e) {
        e._roamAction = this._action;
        this._live.add(e);
        return e;
    }

    /** The director's action just ended: whatever it left on the screen is
     *  gone LINGER_MS later, whatever the gag meant to do with it. A
     *  fallback for one cut short; gags clear their own. What comes next
     *  belongs to the next action. */
    endAction() {
        const id = this._action++;
        setTimeout(() => {
            for (const e of this._live) if (e._roamAction === id) this._fadeOut(e, 600);
        }, LINGER_MS);
    }

    _remove(e) {
        this._live.delete(e);
        e.remove();
    }

    /** Fade an element out and drop it. */
    async _fadeOut(e, ms) {
        try { await e.animate([{ opacity: getComputedStyle(e).opacity }, { opacity: 0 }], { duration: ms, fill: "forwards" }).finished; } catch (err) { /* removed meanwhile */ }
        this._remove(e);
    }

    /** A portal ring centred on (x, y), `size` px across, in front of the
     *  character. Opens at once; close() shrinks it away. */
    portal(x, y, size) {
        const ring = this._track(el("rx_roam_portal", this.over));
        place(ring, x - size / 2, y - size / 2, size, size);
        ring.animate([{ transform: "scale(0) rotate(0deg)", opacity: 0 }, { transform: "scale(1) rotate(160deg)", opacity: 1 }],
            { duration: 380, easing: "cubic-bezier(.2,1.4,.4,1)", fill: "forwards" });
        const spin = el("rx_roam_portal_swirl", ring);
        spin.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 1400, iterations: Infinity });
        return {
            close: async () => {
                try {
                    await ring.animate([{ transform: "scale(1) rotate(160deg)", opacity: 1 }, { transform: "scale(0) rotate(320deg)", opacity: 0 }],
                        { duration: 320, easing: "ease-in", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
                this._remove(ring);
            },
        };
    }

    /** Where something was torn off: a patch in the colour around it, so
     *  the screen looks bitten into. fade() lets the real thing show again. */
    patch(rect, color) {
        const p = this._track(el("rx_roam_patch", this.under));
        place(p, rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
        p.style.background = color;
        p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: "forwards" });
        return { fade: (ms = 600) => this._fadeOut(p, ms) };
    }

    /** A picture of part of the screen (a data URL), first exactly where it
     *  was. moveTo() puts its centre somewhere else (each frame while held). */
    sticker(src, rect) {
        const s = this._track(el("rx_roam_sticker", this.over, "img"));
        s.src = src;
        place(s, rect.x, rect.y, rect.width, rect.height);
        const box = { ...rect };
        let scale = 1;
        let angle = 0;
        const apply = () => {
            s.style.transform = `translate(${box.x - rect.x}px, ${box.y - rect.y}px) rotate(${angle}deg) scale(${scale})`;
        };
        return {
            moveTo: (cx, cy, a = 0) => {
                box.x = cx - rect.width / 2;
                box.y = cy - rect.height / 2;
                angle = a;
                apply();
            },
            setScale: (v) => { scale = v; apply(); },
            /** A happy wiggle, a few times over (petted). */
            wiggle: () => s.animate([{ scale: "1 1", rotate: "0deg" }, { scale: "1.05 .95", rotate: "-2deg" },
                { scale: ".97 1.04", rotate: "2deg" }, { scale: "1 1", rotate: "0deg" }],
            { duration: 650, iterations: 7, easing: "ease-in-out" }),
            /** Knocked sideways (`dir` ±1) and wobbling back: punched. */
            knock: (dir) => s.animate([
                { transform: "translate(0,0) rotate(0) scale(1,1)" },
                { transform: `translate(${dir * 46}px, -6px) rotate(${dir * 24}deg) scale(.82,1.12)`, offset: 0.15 },
                { transform: `translate(${-dir * 10}px, 0) rotate(${-dir * 8}deg) scale(1.06,.95)`, offset: 0.45 },
                { transform: `translate(${dir * 4}px, 0) rotate(${dir * 3}deg) scale(1,1)`, offset: 0.7 },
                { transform: "translate(0,0) rotate(0) scale(1,1)" },
            ], { duration: 1100, easing: "ease-out" }).finished.catch(() => {}),
            /** One bite: a bigger chunk gone from the right-hand end. */
            bite: (left) => { s.style.clipPath = `inset(0 ${Math.round((1 - left) * 100)}% 0 0 round 0 40% 40% 0)`; },
            /** Fly back to where it came from along an arc. */
            flyHome: async (ms = 800) => {
                const from = { x: box.x - rect.x, y: box.y - rect.y };
                const lift = Math.min(260, 80 + Math.hypot(from.x, from.y) * 0.3);
                try {
                    await s.animate([
                        { transform: `translate(${from.x}px, ${from.y}px) rotate(${angle}deg)` },
                        { transform: `translate(${from.x / 2}px, ${from.y / 2 - lift}px) rotate(${angle + 360}deg)`, offset: 0.5 },
                        { transform: "translate(0px, 0px) rotate(720deg)" },
                    ], { duration: ms, easing: "ease-in-out", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
            },
            remove: () => this._remove(s),
            fade: (ms = 400) => this._fadeOut(s, ms),
        };
    }

    /** A puff of crumbs at (x, y) that drop and fade. */
    crumbs(x, y, color = "#d6b07a", n = 7) {
        for (let i = 0; i < n; i++) {
            const c = this._track(el("rx_roam_crumb", this.over));
            const size = 3 + Math.random() * 4;
            place(c, x, y, size, size);
            c.style.background = color;
            const dx = (Math.random() - 0.5) * 70;
            const dy = 40 + Math.random() * 90;
            c.animate([{ transform: "translate(0,0)", opacity: 1 },
                { transform: `translate(${dx}px, ${dy}px) rotate(${Math.random() * 360}deg)`, opacity: 0 }],
            { duration: 700 + Math.random() * 500, easing: "cubic-bezier(.3,.1,.7,1)", fill: "forwards" })
                .finished.then(() => this._remove(c), () => {});
        }
    }

    /** Draw a doodle (one of DOODLE_KINDS) or a short handwritten `text`
     *  centred on (x, y), `size` px tall, over `drawMs`; it fades after
     *  `lifeMs`. Resolves when the drawing is done. */
    async doodle({ kind = null, text = null, x, y, size, width = null, ink = null, tilt = true,
        drawMs = 2600, lifeMs = 30000 }) {
        ink ||= pick(INKS);
        const wrap = this._track(el("rx_roam_doodle", this.under));
        wrap.style.setProperty("--ink", ink);
        if (text) {
            const t = el("rx_roam_doodle_text", wrap);
            t.textContent = text;
            t.style.fontSize = `${Math.round(size * 0.42)}px`;
            const w = Math.max(size, t.offsetWidth || size * 3);
            place(wrap, x - w / 2, y - size / 2, w, size);
            wrap.style.transform = `rotate(${(Math.random() * 10 - 5).toFixed(1)}deg)`;
            // Written left to right.
            await t.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }],
                { duration: drawMs, easing: "steps(18, end)", fill: "forwards" }).finished.catch(() => {});
        } else {
            // `width`: stretched over a box (a big X across an ad).
            const w = width || size;
            place(wrap, x - w / 2, y - size / 2, w, size);
            if (tilt) wrap.style.transform = `rotate(${(Math.random() * 16 - 8).toFixed(1)}deg)`;
            const svg = document.createElementNS(SVG_NS, "svg");
            svg.setAttribute("viewBox", "0 0 100 100");
            if (width) svg.setAttribute("preserveAspectRatio", "none");
            wrap.appendChild(svg);
            const paths = DOODLES[kind] || SPECIAL[kind] || DOODLES.heart;
            const per = drawMs / paths.length;
            for (const d of paths) {
                const p = document.createElementNS(SVG_NS, "path");
                p.setAttribute("d", d);
                p.setAttribute("pathLength", "1");
                // Stretched: a marker line stays a marker line.
                if (width) { p.setAttribute("vector-effect", "non-scaling-stroke"); p.style.strokeWidth = "9px"; }
                svg.appendChild(p);
                await p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
                    { duration: per, easing: "ease-in-out", fill: "forwards" }).finished.catch(() => {});
            }
        }
        setTimeout(() => { if (this._live.has(wrap)) this._fadeOut(wrap, 1500); }, lifeMs);
    }

    /** Floating z's from (x, y) until stop(). move() follows the head. */
    zzz(x, y) {
        const z = this._track(el("rx_roam_zzz", this.follow));
        place(z, x, y, 1, 1);
        ["z", "z", "Z"].forEach((ch, i) => {
            const s = el("rx_roam_zzz_letter", z, "span");
            s.textContent = ch;
            s.animate([{ transform: "translate(0,0) scale(.6)", opacity: 0 }, { opacity: 1, offset: 0.25 },
                { transform: "translate(26px,-70px) scale(1.2)", opacity: 0 }],
            { duration: 2400, delay: i * 800, iterations: Infinity });
        });
        return {
            move: (nx, ny) => { z.style.left = `${nx}px`; z.style.top = `${ny}px`; },
            stop: () => this._fadeOut(z, 400),
        };
    }

    /** Bubbles rising out of a rectangle (a bath in a search box). */
    bubbles(rect) {
        const b = this._track(el("rx_roam_bubbles", this.over));
        place(b, rect.x, rect.y, rect.width, rect.height);
        for (let i = 0; i < 9; i++) {
            const s = el("rx_roam_bubble", b, "span");
            const size = 8 + Math.random() * 14;
            Object.assign(s.style, { left: `${Math.random() * 92}%`, width: `${size}px`, height: `${size}px` });
            s.animate([{ transform: "translateY(0) scale(.4)", opacity: 0 }, { opacity: 0.9, offset: 0.2 },
                { transform: `translate(${Math.random() * 30 - 15}px, -${70 + Math.random() * 80}px) scale(1)`, opacity: 0 }],
            { duration: 1600 + Math.random() * 1200, delay: Math.random() * 1500, iterations: Infinity });
        }
        return { stop: () => this._fadeOut(b, 500) };
    }

    /** A little drift of hearts from (x, y). */
    hearts(x, y) {
        for (let i = 0; i < 5; i++) {
            const h = this._track(el("rx_roam_heart", this.over, "span"));
            h.textContent = i % 3 === 2 ? "♡" : "♥";
            place(h, x + (Math.random() - 0.5) * 60, y, 1, 1);
            h.style.fontSize = `${14 + Math.random() * 12}px`;
            h.animate([{ transform: "translate(0,0) scale(.5)", opacity: 0 }, { opacity: 1, offset: 0.2 },
                { transform: `translate(${(Math.random() - 0.5) * 50}px, -${60 + Math.random() * 50}px) scale(1.1)`, opacity: 0 }],
            { duration: 1600 + Math.random() * 700, delay: i * 140, fill: "forwards" })
                .finished.then(() => this._remove(h), () => {});
        }
    }

    // ── gags (models/roam_gags.js) ───────────────────────────────────────

    /** A comic word (POW!, SPLAT!) bursting at (x, y). */
    comic(text, x, y, { size = 42, color = "#ffde3b", ms = 1100 } = {}) {
        const w = this._track(el("rx_roam_comic", this.over));
        w.textContent = text;
        place(w, x, y, 1, 1);
        w.style.fontSize = `${size}px`;
        w.style.color = color;
        const rot = (Math.random() * 24 - 12).toFixed(1);
        w.animate([{ transform: `translate(-50%,-50%) scale(.2) rotate(${rot}deg)`, opacity: 0 },
            { transform: `translate(-50%,-50%) scale(1.15) rotate(${rot}deg)`, opacity: 1, offset: 0.2 },
            { transform: `translate(-50%,-50%) scale(1) rotate(${rot}deg)`, opacity: 1, offset: 0.75 },
            { transform: `translate(-50%,-60%) scale(1.05) rotate(${rot}deg)`, opacity: 0 }],
        { duration: ms, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(w), () => {});
    }

    /** A speech bubble over (x, y) for `ms`. */
    say(text, x, y, ms = 2200) {
        const b = this._track(el("rx_roam_say", this.follow));
        b.textContent = text;
        place(b, x, y, 1, 1);
        b.animate([{ transform: "translate(-50%,-100%) scale(.6)", opacity: 0 },
            { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.12 },
            { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.85 },
            { transform: "translate(-50%,-110%) scale(1)", opacity: 0 }],
        { duration: ms, fill: "forwards" }).finished.then(() => this._remove(b), () => {});
    }

    /** A little storm cloud raining on (x, y); move() follows the head.
     *  `storm`: darker, raining harder; `drops: false`, no rain (hail).
     *  Partly see-through, so the windows under it stay readable. */
    rainCloud(x, y, width, { storm = false, drops = true } = {}) {
        const c = this._track(el(`rx_roam_cloud${storm ? " rx_roam_cloud--storm" : ""}`, this.follow));
        const h = width * 0.45;
        place(c, x - width / 2, y - h, width, h);
        c.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 0.8, transform: "scale(1)" }], { duration: 500, fill: "forwards" });
        const rain = el("rx_roam_rain", c);
        for (let i = 0; i < (drops ? (storm ? 30 : 16) : 0); i++) {
            const d = el("rx_roam_drop", rain, "span");
            d.style.left = `${8 + Math.random() * 84}%`;
            d.animate([{ transform: "translateY(0)", opacity: 0.9 }, { transform: `translateY(${width * 1.6}px)`, opacity: 0.2 }],
                { duration: (storm ? 380 : 520) + Math.random() * 260, delay: Math.random() * 600, iterations: Infinity, easing: "linear" });
        }
        return {
            move: (nx, ny) => { c.style.left = `${nx - width / 2}px`; c.style.top = `${ny - h}px`; },
            stop: () => this._fadeOut(c, 700),
        };
    }

    /** A warm sun glow at (x, y) while sunbathing; half see-through, so
     *  the windows under it stay readable. */
    sun(x, y, size) {
        const s = this._track(el("rx_roam_sun", this.under));
        place(s, x - size / 2, y - size / 2, size, size);
        s.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 0.5, transform: "scale(1)" }], { duration: 900, fill: "forwards" });
        s.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 30000, iterations: Infinity, composite: "add" });
        return { stop: () => this._fadeOut(s, 900) };
    }

    /** The character snapshot `canvas` (drawn at `rect` on screen) blowing
     *  away as dust, left to right — or, `reverse`, gathering back. */
    async dust(canvas, rect, { reverse = false, ms = 2600 } = {}) {
        const pad = { l: 40, r: rect.width * 0.9, t: rect.height * 0.5, b: 20 };
        const out = this._track(el("rx_roam_dust", this.over, "canvas"));
        const W = Math.round(rect.width + pad.l + pad.r), H = Math.round(rect.height + pad.t + pad.b);
        out.width = W;
        out.height = H;
        place(out, rect.x - pad.l, rect.y - pad.t, W, H);
        const g = out.getContext("2d");
        const src = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
        const step = 3;
        const parts = [];
        for (let y = 0; y < rect.height; y += step) {
            for (let x = 0; x < rect.width; x += step) {
                const i = (Math.floor(y * sy) * canvas.width + Math.floor(x * sx)) * 4;
                if (src[i + 3] < 40) continue;
                parts.push({
                    x: x + pad.l, y: y + pad.t, c: `rgba(${src[i]},${src[i + 1]},${src[i + 2]},`,
                    // Crumbles from the left edge across, drifting up-right.
                    delay: (x / rect.width) * 0.55 + Math.random() * 0.2,
                    dx: 60 + Math.random() * rect.width * 0.8, dy: -(20 + Math.random() * rect.height * 0.45),
                    wob: Math.random() * Math.PI * 2,
                });
            }
        }
        const start = performance.now();
        await new Promise((resolve) => {
            const frame = (t) => {
                const k = Math.min(1, (t - start) / ms);
                g.clearRect(0, 0, W, H);
                for (const p of parts) {
                    let s = Math.max(0, Math.min(1, (k - p.delay * 0.6) / 0.45));
                    if (reverse) s = 1 - Math.max(0, Math.min(1, (k - (1 - p.delay) * 0.6) / 0.45));
                    const e = s * s;
                    const a = 1 - s;
                    if (a <= 0.01) continue;
                    g.fillStyle = `${p.c}${a.toFixed(3)})`;
                    g.fillRect(p.x + p.dx * e + Math.sin(p.wob + e * 6) * 6 * e, p.y + p.dy * e, step, step);
                }
                if (k < 1 && this._live.has(out)) requestAnimationFrame(frame);
                else resolve();
            };
            requestAnimationFrame(frame);
        });
        this._remove(out);
    }

    /** `src` (a picture of `rect`) cut into pieces that spiral into
     *  (tx, ty) one after another, like a vacuum taking them. */
    async suck(src, rect, tx, ty, ms = 2600) {
        const cols = Math.max(4, Math.min(14, Math.round(rect.width / 28)));
        const rows = Math.max(1, Math.min(5, Math.round(rect.height / 22)));
        const w = rect.width / cols, h = rect.height / rows;
        const tiles = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const dx = tx - (rect.x + c * w + w / 2), dy = ty - (rect.y + r * h + h / 2);
                tiles.push({ r, c, dx, dy, d: Math.hypot(dx, dy) });
            }
        }
        // Nearest the nozzle goes first.
        tiles.sort((a, b) => a.d - b.d);
        const jobs = [];
        tiles.forEach(({ r, c, dx, dy }, rank) => {
            const tile = this._track(el("rx_roam_tile", this.over));
            place(tile, rect.x + c * w, rect.y + r * h, w, h);
            Object.assign(tile.style, {
                backgroundImage: `url(${src})`, backgroundSize: `${rect.width}px ${rect.height}px`,
                backgroundPosition: `-${c * w}px -${r * h}px`,
            });
            const swirl = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 60);
            const delay = (rank / tiles.length) * ms * 0.45 + Math.random() * 120;
            jobs.push(tile.animate([
                { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 1 },
                { transform: `translate(${dx * 0.45 + swirl}px, ${dy * 0.45 - Math.abs(swirl)}px) rotate(${swirl * 4}deg) scale(.8)`, opacity: 1, offset: 0.5 },
                { transform: `translate(${dx}px, ${dy}px) rotate(${swirl * 9}deg) scale(.05)`, opacity: 0.4 },
            ], { duration: ms * 0.55, delay, easing: "cubic-bezier(.5,0,.9,.6)", fill: "forwards" })
                .finished.then(() => this._remove(tile), () => {}));
        });
        await Promise.all(jobs);
    }

    /** Rings spreading over `rect` from (x, y): something just went in. */
    ripple(rect, x, y) {
        const box = this._track(el("rx_roam_ripple", this.over));
        place(box, rect.x, rect.y, rect.width, rect.height);
        for (let i = 0; i < 3; i++) {
            const ring = el("rx_roam_ripple_ring", box);
            place(ring, x - rect.x, y - rect.y, 1, 1);
            const size = Math.max(rect.width, rect.height) * 1.2;
            ring.animate([{ width: "0px", height: "0px", opacity: 0.9 }, { width: `${size}px`, height: `${size}px`, opacity: 0 }],
                { duration: 1100, delay: i * 220, easing: "ease-out", fill: "forwards" });
        }
        setTimeout(() => this._remove(box), 1900);
    }

    /** A heap of earth at (x, y) on the floor, growing to `size` px wide. */
    mound(x, y, size) {
        const m = this._track(el("rx_roam_mound", this.under));
        place(m, x - size / 2, y - size * 0.32, size, size * 0.34);
        m.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 2400, fill: "forwards", easing: "ease-out" });
        return {
            el: m,
            mark: () => {
                const x0 = el("rx_roam_xmark", m, "span");
                x0.textContent = "✕";
                x0.animate([{ opacity: 0, transform: "scale(2)" }, { opacity: 1, transform: "scale(1)" }], { duration: 300, fill: "forwards" });
            },
            fade: (ms = 1200) => this._fadeOut(m, ms),
        };
    }

    /** Earth flung up from (x, y). */
    dirt(x, y, n = 6) {
        this.crumbs(x, y, "#7c5a3a", n);
    }

    /** A smoke puff at (x, y). */
    puff(x, y, size = 26) {
        const p = this._track(el("rx_roam_puff", this.over));
        place(p, x - size / 2, y - size / 2, size, size);
        p.animate([{ transform: "scale(.4)", opacity: 0.85 }, { transform: `translate(${(Math.random() - 0.5) * 20}px, -${size}px) scale(1.6)`, opacity: 0 }],
            { duration: 900, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(p), () => {});
    }

    /** Throw something from `from` to `to` along an arc `lift` px high;
     *  `kind` "potato" | "fireball" | "plane" | "rocket". Resolves on arrival. */
    async projectile(kind, from, to, { ms = 700, lift = 120 } = {}) {
        const p = this._track(el(`rx_roam_shot rx_roam_shot--${kind}`, this.over));
        const size = kind === "fireball" ? 46 : kind === "plane" ? 40 : 26;
        // A rocket is long and thin, nose first along its way.
        const [w, h] = kind === "rocket" ? [44, 14] : [size, size];
        place(p, from.x - w / 2, from.y - h / 2, w, h);
        if (kind === "plane") p.textContent = "✈";
        const steps = 24;
        const frames = [];
        let px = from.x, py = from.y;
        for (let i = 0; i <= steps; i++) {
            const s = i / steps;
            const x = from.x + (to.x - from.x) * s;
            const y = from.y + (to.y - from.y) * s - Math.sin(Math.PI * s) * lift;
            const ang = Math.atan2(y - py, x - px) * 180 / Math.PI;
            px = x; py = y;
            frames.push({ transform: `translate(${x - from.x}px, ${y - from.y}px) rotate(${kind === "potato" ? s * 720 : ang}deg)` });
        }
        let trail = null;
        if (kind === "fireball" || kind === "rocket") {
            trail = setInterval(() => {
                const r = p.getBoundingClientRect();
                const parent = this.over.getBoundingClientRect();
                const cx = r.left - parent.left + r.width / 2, cy = r.top - parent.top + r.height / 2;
                if (kind === "fireball") this.ember(cx, cy);
                else this.puff(cx, cy, 14 + Math.random() * 8);
            }, kind === "rocket" ? 30 : 40);
        }
        try { await p.animate(frames, { duration: ms, easing: "linear", fill: "forwards" }).finished; } catch (e) { /* cleared */ }
        clearInterval(trail);
        this._remove(p);
    }

    ember(x, y) {
        const e = this._track(el("rx_roam_ember", this.over));
        const size = 8 + Math.random() * 10;
        place(e, x - size / 2, y - size / 2, size, size);
        e.animate([{ opacity: 0.9, transform: "scale(1)" }, { opacity: 0, transform: `translate(${(Math.random() - 0.5) * 24}px, ${-10 - Math.random() * 20}px) scale(.2)` }],
            { duration: 500, fill: "forwards" }).finished.then(() => this._remove(e), () => {});
    }

    /** A potato hitting at (x, y): a mash splat that slides and fades
     *  (`color`: something else that went splat). */
    splat(x, y, size = 70, color = null) {
        const s = this._track(el("rx_roam_splat", this.over));
        place(s, x - size / 2, y - size / 2, size, size);
        if (color) s.style.background = color;
        s.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1.1)", opacity: 1, offset: 0.08 },
            { transform: "scale(1) translateY(0)", opacity: 1, offset: 0.2 }, { transform: "scale(1) translateY(30px)", opacity: 0 }],
        { duration: 4200, fill: "forwards" }).finished.then(() => this._remove(s), () => {});
        this.crumbs(x, y, "#e8d28c", 10);
    }

    /** A fiery blast at (x, y), soot left behind a while. */
    explosion(x, y, size = 120) {
        const b = this._track(el("rx_roam_blast", this.over));
        place(b, x - size / 2, y - size / 2, size, size);
        b.animate([{ transform: "scale(.1)", opacity: 1 }, { transform: "scale(1.2)", opacity: 0.9, offset: 0.35 }, { transform: "scale(1.5)", opacity: 0 }],
            { duration: 700, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(b), () => {});
        for (let i = 0; i < 5; i++) setTimeout(() => this.puff(x + (Math.random() - 0.5) * size * 0.6, y + (Math.random() - 0.5) * size * 0.4, size * 0.4), 120 + i * 90);
        const soot = this._track(el("rx_roam_soot", this.over));
        place(soot, x - size * 0.4, y - size * 0.4, size * 0.8, size * 0.8);
        soot.animate([{ opacity: 0 }, { opacity: 0.75, offset: 0.1 }, { opacity: 0.6, offset: 0.7 }, { opacity: 0 }],
            { duration: 5000, fill: "forwards" }).finished.then(() => this._remove(soot), () => {});
    }

    /** `src`, a picture of `rect`, blown apart from (cx, cy): an n × n of
     *  its pieces flying out and falling, spinning, fading. */
    debris(src, rect, cx, cy, n = 3) {
        const w = rect.width / n, h = rect.height / n;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const p = this._track(el("rx_roam_debris", this.over));
                place(p, rect.x + i * w, rect.y + j * h, w, h);
                p.style.backgroundImage = `url("${src}")`;
                p.style.backgroundSize = `${rect.width}px ${rect.height}px`;
                p.style.backgroundPosition = `${-i * w}px ${-j * h}px`;
                const ox = rect.x + (i + 0.5) * w - cx, oy = rect.y + (j + 0.5) * h - cy;
                const l = Math.hypot(ox, oy) || 1;
                const v = 160 + Math.random() * 220;
                const dx = (ox / l) * v, dy = (oy / l) * v - 120;
                const spin = (Math.random() - 0.5) * 720;
                p.animate([
                    { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
                    { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) rotate(${spin * 0.6}deg)`, opacity: 1, offset: 0.45 },
                    { transform: `translate(${dx}px, ${dy + 260}px) rotate(${spin}deg)`, opacity: 0 },
                ], { duration: 1300, easing: "cubic-bezier(.2,.6,.4,1)", fill: "forwards" })
                    .finished.then(() => this._remove(p), () => {});
            }
        }
    }

    /** Confetti from (x, y). */
    confetti(x, y, n = 40) {
        for (let i = 0; i < n; i++) {
            const c = this._track(el("rx_roam_confetti", this.over));
            place(c, x, y, 7, 11);
            c.style.background = pick(INKS);
            const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 200;
            c.animate([{ transform: "translate(0,0) rotate(0)", opacity: 1 },
                { transform: `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r * 0.6 + 140}px) rotate(${720 * Math.random()}deg)`, opacity: 0 }],
            { duration: 1400 + Math.random() * 900, easing: "cubic-bezier(.2,.6,.4,1)", fill: "forwards" })
                .finished.then(() => this._remove(c), () => {});
        }
    }

    /** A white camera flash over the whole screen. */
    flash() {
        const f = this._track(el("rx_roam_flash", this.over));
        Object.assign(f.style, { inset: "0" });
        f.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 380, fill: "forwards" })
            .finished.then(() => this._remove(f), () => {});
    }

    /** The video-thumbnail treatment around `rect`: a red circle, a big red
     *  arrow pointing at it, a shouty caption. remove() takes it all away. */
    thumbnail(rect, caption) {
        const wrap = this._track(el("rx_roam_thumb", this.over));
        Object.assign(wrap.style, { inset: "0" });
        const c = el("rx_roam_thumb_circle", wrap);
        const pad = 18;
        place(c, rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2);
        const fromLeft = rect.x > (this.over.clientWidth || 1000) / 2;
        const arrow = el("rx_roam_thumb_arrow", wrap);
        arrow.textContent = "➜";
        const ax = fromLeft ? rect.x - 170 : rect.x + rect.width + 30;
        place(arrow, ax, rect.y + rect.height * 0.25, 140, 100);
        if (!fromLeft) arrow.style.transform = "scaleX(-1)";
        const t = el("rx_roam_thumb_text", wrap);
        t.textContent = caption;
        place(t, fromLeft ? ax - 60 : ax, rect.y - 20, 1, 1);
        for (const e of [c, arrow, t]) e.animate([{ opacity: 0, scale: 1.6 }, { opacity: 1, scale: 1 }], { duration: 160, fill: "forwards" });
        return { remove: () => this._fadeOut(wrap, 250) };
    }

    /** A polaroid of `src` dropping to (x, y), there for `lifeMs`. Shown
     *  once the picture has decoded (never an empty white card). */
    async polaroid(src, x, y, w, lifeMs = 20000) {
        const img = document.createElement("img");
        img.className = "rx_roam_polaroid_img";
        img.src = src;
        try { await img.decode(); } catch (e) { return; }
        const p = this._track(el("rx_roam_polaroid", this.under));
        place(p, x - w / 2, y - w * 0.6, w, w * 1.18);
        // The card's border in px of its own width: a % padding would be of
        // the layer's (the screen's) width and leave the picture no room.
        p.style.padding = `${(w * 0.06).toFixed(1)}px ${(w * 0.06).toFixed(1)}px ${(w * 0.22).toFixed(1)}px`;
        p.appendChild(img);
        const rot = (Math.random() * 20 - 10).toFixed(1);
        p.animate([{ transform: `translateY(-${w}px) rotate(${rot * 3}deg)`, opacity: 0 },
            { transform: `translateY(0) rotate(${rot}deg)`, opacity: 1 }], { duration: 900, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "forwards" });
        // Developing, the instant-film way: pale at first, colour coming in.
        img.animate([{ filter: "brightness(1.6) saturate(.2)" }, { filter: "brightness(1) saturate(1)" }], { duration: 1600, fill: "forwards" });
        setTimeout(() => { if (this._live.has(p)) this._fadeOut(p, 1200); }, lifeMs);
    }

    /** A fishing line from the rod tip down to a bobber; set(tip, hook)
     *  every frame. */
    line() {
        const svg = this._track(document.createElementNS(SVG_NS, "svg"));
        svg.setAttribute("class", "rx_roam_line");
        this.follow.appendChild(svg);
        const path = document.createElementNS(SVG_NS, "path");
        const bob = document.createElementNS(SVG_NS, "circle");
        bob.setAttribute("r", "6");
        svg.appendChild(path);
        svg.appendChild(bob);
        return {
            set: (tip, hook) => {
                // A little sag between the two.
                const mx = (tip.x + hook.x) / 2, my = Math.max(tip.y, hook.y) - Math.abs(hook.x - tip.x) * 0.08 + 12;
                path.setAttribute("d", `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${hook.x.toFixed(1)} ${hook.y.toFixed(1)}`);
                bob.setAttribute("cx", hook.x.toFixed(1));
                bob.setAttribute("cy", (hook.y - 8).toFixed(1));
            },
            stop: () => this._remove(svg),
        };
    }

    /** A fluffy cloud to sit on, its top at y. */
    cloudSeat(x, y, w) {
        const c = this._track(el("rx_roam_cloud rx_roam_cloud--seat", this.under));
        const h = w * 0.42;
        place(c, x - w / 2, y - h * 0.3, w, h);
        c.animate([{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], { duration: 450, fill: "forwards" });
        return { stop: () => this._fadeOut(c, 700) };
    }

    /** A parachute: a canopy `w` px wide, its lines running down to the two
     *  hands. set(left, right, tilt) every frame with the hands' page px;
     *  collapse() on landing. */
    parachute(w) {
        const wrap = this._track(el("rx_roam_chute", this.follow));
        Object.assign(wrap.style, { inset: "0" });
        const canopy = el("rx_roam_chute_canopy", wrap);
        const h = w * 0.4;
        canopy.style.width = `${w}px`;
        canopy.style.height = `${h}px`;
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "rx_roam_chute_lines");
        wrap.appendChild(svg);
        const lines = [0, 1, 2, 3].map(() => {
            const l = document.createElementNS(SVG_NS, "line");
            svg.appendChild(l);
            return l;
        });
        canopy.animate([{ transform: "scaleY(.2)", opacity: 0 }, { transform: "scaleY(1)", opacity: 1 }], { duration: 380, fill: "forwards" });
        return {
            set: (left, right, tilt = 0) => {
                // The canopy's middle a little over a body above the hands.
                const mx = (left.x + right.x) / 2, my = (left.y + right.y) / 2;
                const rise = w * 0.95;
                const a = tilt * Math.PI / 180;
                const cx = mx + Math.sin(a) * rise, cy = my - Math.cos(a) * rise;
                canopy.style.left = `${cx - w / 2}px`;
                canopy.style.top = `${cy - h}px`;
                canopy.style.rotate = `${tilt.toFixed(1)}deg`;
                // Rim points (outer and inner on each side) to each hand.
                const rim = [-0.48, -0.2, 0.2, 0.48].map((u) => ({
                    x: cx + Math.cos(a) * u * w, y: cy + Math.sin(a) * u * w,
                }));
                rim.forEach((p, i) => {
                    const hand = i < 2 ? left : right;
                    lines[i].setAttribute("x1", p.x.toFixed(1));
                    lines[i].setAttribute("y1", p.y.toFixed(1));
                    lines[i].setAttribute("x2", hand.x.toFixed(1));
                    lines[i].setAttribute("y2", hand.y.toFixed(1));
                });
            },
            collapse: async () => {
                try {
                    await wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 650, easing: "ease-in", fill: "forwards" }).finished;
                } catch (e) { /* cleared */ }
                this._remove(wrap);
            },
        };
    }

    /** A web line from an anchor up on the screen to the hand; set() per
     *  frame. */
    web() {
        const svg = this._track(document.createElementNS(SVG_NS, "svg"));
        svg.setAttribute("class", "rx_roam_web");
        this.follow.appendChild(svg);
        const l = document.createElementNS(SVG_NS, "line");
        svg.appendChild(l);
        return {
            set: (a, hand) => {
                l.setAttribute("x1", a.x.toFixed(1));
                l.setAttribute("y1", a.y.toFixed(1));
                l.setAttribute("x2", hand.x.toFixed(1));
                l.setAttribute("y2", hand.y.toFixed(1));
            },
            hide: () => { l.setAttribute("x1", "0"); l.setAttribute("y1", "0"); l.setAttribute("x2", "0"); l.setAttribute("y2", "0"); },
            stop: () => this._remove(svg),
        };
    }

    /** A splash of web where a line sticks, at (x, y). */
    webSplat(x, y) {
        const s = this._track(el("rx_roam_websplat", this.follow));
        place(s, x - 14, y - 14, 28, 28);
        s.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1)", opacity: 1, offset: 0.15 }, { opacity: 0 }],
            { duration: 1600, fill: "forwards" }).finished.then(() => this._remove(s), () => {});
    }

    // ── more gags ────────────────────────────────────────────────────────

    /** A hand-held sign (a little card with `text`) at (x, y); `onClick`
     *  makes it the one clickable thing on a click-through screen (the
     *  mascot page lets clicks through over .rx_roam_clickable). */
    sign(text, x, y, { onClick = null, big = false } = {}) {
        const s = this._track(el(`rx_roam_sign${big ? " rx_roam_sign--big" : ""}${onClick ? " rx_roam_clickable" : ""}`, this.follow));
        s.textContent = text;
        place(s, x, y, 1, 1);
        if (onClick) s.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
        s.animate([{ transform: "translate(-50%,-100%) scale(.3)", opacity: 0 }, { transform: "translate(-50%,-100%) scale(1)", opacity: 1 }],
            { duration: 260, easing: "cubic-bezier(.3,1.5,.5,1)", fill: "forwards" });
        return {
            moveTo: (nx, ny) => { s.style.left = `${nx}px`; s.style.top = `${ny}px`; },
            remove: () => this._fadeOut(s, 250),
        };
    }

    /** A magnifying glass over the screen: at(x, y) shows that spot of the
     *  shot `src` (a data URL of frame `frame`, page px) 2× through the lens. */
    lens(src, frame, size, zoom = 2) {
        const l = this._track(el("rx_roam_lens", this.over));
        place(l, 0, 0, size, size);
        Object.assign(l.style, {
            backgroundImage: `url(${src})`, backgroundSize: `${frame.width * zoom}px ${frame.height * zoom}px`,
        });
        el("rx_roam_lens_handle", l);
        l.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "scale(1)" }], { duration: 250, fill: "forwards" });
        return {
            at: (x, y) => {
                l.style.left = `${x - size / 2}px`;
                l.style.top = `${y - size / 2}px`;
                l.style.backgroundPosition = `${-((x - frame.x) * zoom - size / 2)}px ${-((y - frame.y) * zoom - size / 2)}px`;
            },
            remove: () => this._fadeOut(l, 250),
        };
    }

    /** A pillow fort going up round (x, y) on the floor, with its sign
     *  `text`; collapse() knocks it over. */
    fort(x, y, w, text) {
        const f = this._track(el("rx_roam_fort", this.over));
        place(f, x - w / 2, y - w * 0.55, w, w * 0.55);
        const colours = ["#fda4af", "#fcd34d", "#93c5fd", "#c4b5fd", "#86efac", "#fdba74"];
        const rows = [[0, 0.2, 0.4, 0.6, 0.8], [0.1, 0.7], [0.1, 0.72]];
        let k = 0;
        rows.forEach((row, r) => row.forEach((u, i) => {
            const p = el("rx_roam_pillow", f);
            Object.assign(p.style, { left: `${u * 100}%`, bottom: `${r * 34}%`, background: colours[k++ % colours.length] });
            p.animate([{ transform: "translateY(-260px) rotate(30deg)", opacity: 0 }, { transform: "translateY(0) rotate(0)", opacity: 1 }],
                { duration: 420, delay: (r * 5 + i) * 220, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "both" });
        }));
        const sign = el("rx_roam_fort_sign", f);
        sign.textContent = text;
        sign.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 2600, fill: "both" });
        return {
            setSign: (t) => { sign.textContent = t; },
            collapse: async () => {
                for (const p of f.children) {
                    p.animate([{ transform: "translate(0,0) rotate(0)" },
                        { transform: `translate(${(Math.random() - 0.5) * 160}px, 40px) rotate(${(Math.random() - 0.5) * 180}deg)`, opacity: 0 }],
                    { duration: 700, easing: "ease-in", fill: "forwards" });
                }
                await new Promise((r) => setTimeout(r, 720));
                this._remove(f);
            },
        };
    }

    /** A red carpet unrolling along the floor from x0 to x1 at y. */
    carpet(x0, x1, y) {
        const c = this._track(el("rx_roam_carpet", this.under));
        place(c, Math.min(x0, x1), y - 6, Math.abs(x1 - x0), 10);
        c.style.transformOrigin = x1 > x0 ? "left" : "right";
        c.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 900, easing: "ease-out", fill: "forwards" });
        return {
            roll: async () => {
                try { await c.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: 600, fill: "forwards" }).finished; } catch (e) { /* cleared */ }
                this._remove(c);
            },
        };
    }

    /** A camera flash going off at (x, y). */
    pop(x, y, size = 60) {
        const p = this._track(el("rx_roam_pop", this.over));
        place(p, x - size / 2, y - size / 2, size, size);
        p.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 320, fill: "forwards" })
            .finished.then(() => this._remove(p), () => {});
    }

    /** A pile of autumn leaves on the floor at (x, y); burst() flings it up. */
    leafPile(x, y, w) {
        const pile = this._track(el("rx_roam_leafpile", this.under));
        place(pile, x - w / 2, y - w * 0.3, w, w * 0.3);
        const leaves = [];
        for (let i = 0; i < 26; i++) {
            const lf = el("rx_roam_leaf", pile, "span");
            lf.textContent = pick(["🍂", "🍁", "🍂"]);
            const u = Math.random(), h = Math.sin(u * Math.PI) * (0.4 + Math.random() * 0.6);
            Object.assign(lf.style, { left: `${u * 92}%`, bottom: `${h * 70}%`, fontSize: `${w * 0.11}px`, rotate: `${Math.random() * 360}deg` });
            leaves.push(lf);
        }
        return {
            burst: () => {
                for (const lf of leaves) {
                    const dx = (Math.random() - 0.5) * w * 1.6, dy = -(60 + Math.random() * w * 1.2);
                    lf.animate([{ transform: "translate(0,0)" }, { transform: `translate(${dx * 0.6}px, ${dy}px) rotate(${Math.random() * 360}deg)`, offset: 0.4 },
                        { transform: `translate(${dx}px, ${-dy * 0.1}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }],
                    { duration: 2200 + Math.random() * 900, easing: "ease-out", fill: "forwards" });
                }
                setTimeout(() => this._remove(pile), 3300);
            },
            remove: () => this._fadeOut(pile, 500),
        };
    }

    /** A snowball bursting at (x, y). */
    snowSplat(x, y) {
        this.crumbs(x, y, "#f8fafc", 12);
        const s = this._track(el("rx_roam_snowsplat", this.over));
        place(s, x - 22, y - 22, 44, 44);
        s.animate([{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1)", opacity: 0.9, offset: 0.15 }, { opacity: 0 }],
            { duration: 2600, fill: "forwards" }).finished.then(() => this._remove(s), () => {});
    }

    /** Fireflies drifting about (x, y) until stop(). */
    fireflies(x, y, r) {
        const box = this._track(el("rx_roam_fireflies", this.follow));
        place(box, x - r, y - r, r * 2, r * 2);
        for (let i = 0; i < 12; i++) {
            const f = el("rx_roam_firefly", box, "span");
            Object.assign(f.style, { left: `${Math.random() * 100}%`, top: `${Math.random() * 100}%` });
            const dx = (Math.random() - 0.5) * r, dy = (Math.random() - 0.5) * r;
            f.animate([{ transform: "translate(0,0)", opacity: 0.2 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, offset: 0.5 },
                { transform: "translate(0,0)", opacity: 0.2 }], { duration: 3000 + Math.random() * 3000, iterations: Infinity, easing: "ease-in-out" });
        }
        return {
            move: (nx, ny) => { box.style.left = `${nx - r}px`; box.style.top = `${ny - r}px`; },
            stop: () => this._fadeOut(box, 1200),
        };
    }

    /** A blanket over (rect), tucked in, until stop(). */
    blanket(rect) {
        const b = this._track(el("rx_roam_blanket", this.follow));
        place(b, rect.x, rect.y, rect.width, rect.height);
        b.animate([{ transform: "translateY(-30%) scaleY(.3)", opacity: 0 }, { transform: "translateY(0) scaleY(1)", opacity: 1 }],
            { duration: 700, easing: "ease-out", fill: "forwards" });
        return { stop: () => this._fadeOut(b, 600) };
    }

    /** The character's `canvas` (at `rect`) breaking up in a glitch for `ms`. */
    async glitch(canvas, rect, ms = 900) {
        const out = this._track(el("rx_roam_glitch", this.over, "canvas"));
        out.width = Math.round(rect.width);
        out.height = Math.round(rect.height);
        place(out, rect.x, rect.y, rect.width, rect.height);
        const g = out.getContext("2d");
        const tiny = document.createElement("canvas");
        const start = performance.now();
        await new Promise((resolve) => {
            const frame = (t) => {
                const k = (t - start) / ms;
                if (k >= 1 || !this._live.has(out)) { resolve(); return; }
                // Coarser blocks as it goes, slices shoved sideways, colour split.
                const px = Math.max(2, Math.round(2 + k * 18));
                tiny.width = Math.max(1, Math.round(out.width / px));
                tiny.height = Math.max(1, Math.round(out.height / px));
                const tg = tiny.getContext("2d");
                tg.clearRect(0, 0, tiny.width, tiny.height);
                tg.drawImage(canvas, 0, 0, tiny.width, tiny.height);
                g.clearRect(0, 0, out.width, out.height);
                g.imageSmoothingEnabled = false;
                for (let y = 0; y < out.height; y += 12) {
                    const dx = Math.random() < 0.3 ? (Math.random() - 0.5) * 60 * k : 0;
                    g.drawImage(tiny, 0, (y / out.height) * tiny.height, tiny.width, (12 / out.height) * tiny.height, dx, y, out.width, 12);
                }
                g.globalCompositeOperation = "lighter";
                g.globalAlpha = 0.35;
                g.drawImage(out, 6 * k, 0);
                g.globalAlpha = 1;
                g.globalCompositeOperation = "source-over";
                out.style.opacity = String(1 - k * 0.6);
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });
        this._remove(out);
    }

    /** A see-through canvas the same size as the character, for a copy of
     *  them (the clone): draw() takes a frame, place() moves it. */
    copyCanvas(w, h) {
        const c = this._track(el("rx_roam_clone", this.over, "canvas"));
        c.width = Math.round(w);
        c.height = Math.round(h);
        place(c, 0, 0, w, h);
        const g = c.getContext("2d");
        return {
            draw: (src, flip) => {
                g.clearRect(0, 0, c.width, c.height);
                g.save();
                if (flip) { g.translate(c.width, 0); g.scale(-1, 1); }
                g.drawImage(src, 0, 0, c.width, c.height);
                g.restore();
            },
            place: (x, y) => { c.style.left = `${x}px`; c.style.top = `${y}px`; },
            remove: () => this._fadeOut(c, 400),
        };
    }

    /** A giant mouse pointer lying on the floor, to ride. */
    pointer(x, y, size) {
        const p = this._track(el("rx_roam_pointer", this.over));
        place(p, 0, 0, size, size * 0.62);
        p.innerHTML = '<svg viewBox="0 0 100 62"><path d="M4 31 L70 4 L58 24 L96 24 L96 38 L58 38 L70 58 Z"/></svg>';
        const at = (nx, ny, dir = 1) => {
            p.style.left = `${nx - size / 2}px`;
            p.style.top = `${ny - size * 0.5}px`;
            p.style.transform = dir < 0 ? "scaleX(1)" : "scaleX(-1)";
        };
        at(x, y);
        return { at, remove: () => this._fadeOut(p, 300) };
    }

    /** Stars spinning off a bonk at (x, y). */
    stars(x, y, n = 6) {
        for (let i = 0; i < n; i++) {
            const s = this._track(el("rx_roam_star", this.over, "span"));
            s.textContent = "★";
            place(s, x, y, 1, 1);
            const a = (i / n) * Math.PI * 2;
            s.animate([{ transform: "translate(0,0) scale(.4)", opacity: 1 },
                { transform: `translate(${Math.cos(a) * 60}px, ${Math.sin(a) * 40 - 20}px) scale(1.1) rotate(180deg)`, opacity: 0 }],
            { duration: 900, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(s), () => {});
        }
    }

    /** Water splashing up at (x, y). */
    splash(x, y) {
        for (let i = 0; i < 12; i++) {
            const d = this._track(el("rx_roam_drop2", this.over));
            const size = 5 + Math.random() * 6;
            place(d, x, y, size, size);
            const dx = (Math.random() - 0.5) * 90, up = 40 + Math.random() * 70;
            d.animate([{ transform: "translate(0,0)", opacity: 0.95 }, { transform: `translate(${dx * 0.6}px, ${-up}px)`, offset: 0.45 },
                { transform: `translate(${dx}px, 20px)`, opacity: 0 }], { duration: 900, easing: "ease-out", fill: "forwards" })
                .finished.then(() => this._remove(d), () => {});
        }
    }

    // ── weather, seasons, holidays (models/roam_gags_seasons.js) ─────────

    get _w() { return this.over.clientWidth || window.innerWidth; }
    get _h() { return this.over.clientHeight || window.innerHeight; }

    /** The whole screen darkened behind the character (a storm), until stop(). */
    dim(alpha) {
        const d = this._track(el("rx_roam_dim", this.under));
        Object.assign(d.style, { inset: "0", background: `rgba(15, 23, 42, ${alpha})` });
        d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, fill: "forwards" });
        return { stop: () => this._fadeOut(d, 900) };
    }

    /** A lightning bolt from (x0, y0) down to (x1, y1), jagged, with a fork,
     *  and the screen lit up by it. */
    lightning(x0, y0, x1, y1) {
        const svg = this._track(document.createElementNS(SVG_NS, "svg"));
        svg.setAttribute("class", "rx_roam_bolt");
        this.over.appendChild(svg);
        const jag = (ax, ay, bx, by, n, amp) => {
            const pts = [[ax, ay]];
            for (let i = 1; i < n; i++) {
                const s = i / n;
                pts.push([ax + (bx - ax) * s + (Math.random() - 0.5) * amp, ay + (by - ay) * s]);
            }
            pts.push([bx, by]);
            return pts;
        };
        const main = jag(x0, y0, x1, y1, 12, 70);
        const k = main[5 + Math.floor(Math.random() * 3)];
        const fork = jag(k[0], k[1], k[0] + (Math.random() < 0.5 ? -1 : 1) * (80 + Math.random() * 120), k[1] + (y1 - k[1]) * 0.45, 5, 40);
        for (const [pts, wd] of [[main, 4], [fork, 2.2]]) {
            const p = document.createElementNS(SVG_NS, "polyline");
            p.setAttribute("points", pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
            p.style.strokeWidth = `${wd}px`;
            svg.appendChild(p);
        }
        svg.animate([{ opacity: 1 }, { opacity: 0.15, offset: 0.25 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }],
            { duration: 520, fill: "forwards" }).finished.then(() => this._remove(svg), () => {});
        const f = this._track(el("rx_roam_flash rx_roam_flash--bolt", this.over));
        Object.assign(f.style, { inset: "0" });
        f.animate([{ opacity: 0.55 }, { opacity: 0.1, offset: 0.3 }, { opacity: 0.4, offset: 0.45 }, { opacity: 0 }],
            { duration: 520, fill: "forwards" }).finished.then(() => this._remove(f), () => {});
    }

    /** A hailstone falling from (x, y0) to y1, bouncing off what it hits. */
    hailstone(x, y0, y1) {
        const s = this._track(el("rx_roam_hail", this.over));
        const size = 5 + Math.random() * 4;
        place(s, x - size / 2, y0, size, size);
        const fall = Math.max(60, y1 - y0 - size);
        const fallMs = fall / 1.3;   // px per ms (by eye: quicker than the rain)
        const f = fallMs / (fallMs + 420);
        const dx = (Math.random() - 0.5) * 50, up = 14 + Math.random() * 24;
        s.animate([{ transform: "translate(0,0)", opacity: 1 },
            { transform: `translate(0, ${fall}px)`, offset: f, easing: "ease-out" },
            { transform: `translate(${dx * 0.6}px, ${fall - up}px)`, offset: f + (1 - f) * 0.45, easing: "ease-in" },
            { transform: `translate(${dx}px, ${fall}px)`, opacity: 0 }],
        { duration: fallMs + 420, fill: "forwards" }).finished.then(() => this._remove(s), () => {});
    }

    /** Wind across the whole screen toward `dir` (±1): streaks of air and
     *  leaves and scraps in it until stop(); gust() is one big blow. */
    wind(dir) {
        const box = this._track(el("rx_roam_wind", this.over));
        Object.assign(box.style, { inset: "0" });
        const W = this._w, H = this._h;
        const streak = (fast) => {
            const s = el("rx_roam_gust", box);
            const len = 80 + Math.random() * 160;
            place(s, dir > 0 ? -len : W, Math.random() * H, len, 10);
            s.animate([{ transform: "translateX(0)", opacity: 0 }, { opacity: 0.8, offset: 0.2 }, { opacity: 0.8, offset: 0.7 },
                { transform: `translateX(${dir * (W + len)}px)`, opacity: 0 }],
            { duration: (fast ? 450 : 900) + Math.random() * 400, fill: "forwards" }).finished.then(() => s.remove(), () => {});
        };
        const scrap = () => {
            const s = el("rx_roam_scrap", box, "span");
            s.textContent = pick(["🍃", "🍂", "🍃", "📄"]);
            place(s, dir > 0 ? -40 : W + 10, H * (0.3 + Math.random() * 0.65), 30, 30);
            s.style.fontSize = `${18 + Math.random() * 14}px`;
            const lift = 60 + Math.random() * 160;
            s.animate([{ transform: "translate(0,0) rotate(0deg)" },
                { transform: `translate(${dir * W * 0.5}px, ${-lift}px) rotate(${dir * 540}deg)`, offset: 0.5 },
                { transform: `translate(${dir * (W + 60)}px, ${-lift * 0.3}px) rotate(${dir * 1080}deg)` }],
            { duration: 1800 + Math.random() * 1200, fill: "forwards" }).finished.then(() => s.remove(), () => {});
        };
        const tick = setInterval(() => {
            streak(false);
            if (Math.random() < 0.25) scrap();
        }, 140);
        return {
            gust: () => {
                for (let i = 0; i < 18; i++) setTimeout(() => streak(true), i * 30);
                for (let i = 0; i < 5; i++) setTimeout(scrap, i * 90);
            },
            stop: () => { clearInterval(tick); this._fadeOut(box, 1200); },
        };
    }

    /** Throw `text` (an emoji) from `from` to `to` along an arc, tumbling
     *  `spin` turns. Resolves on arrival. */
    async fling(text, from, to, { ms = 1200, spin = 1, lift = null, size = 40 } = {}) {
        const s = this._track(el("rx_roam_fling", this.over, "span"));
        s.textContent = text;
        place(s, from.x - size / 2, from.y - size / 2, size, size);
        s.style.fontSize = `${size}px`;
        const up = lift ?? Math.min(220, Math.hypot(to.x - from.x, to.y - from.y) * 0.25);
        const frames = [];
        for (let i = 0; i <= 20; i++) {
            const k = i / 20;
            const x = (to.x - from.x) * k, y = (to.y - from.y) * k - Math.sin(Math.PI * k) * up;
            frames.push({ transform: `translate(${x}px, ${y}px) rotate(${spin * 360 * k}deg)` });
        }
        try { await s.animate(frames, { duration: ms, fill: "forwards" }).finished; } catch (e) { /* cleared */ }
        this._remove(s);
    }

    /** Fog rolling in over the screen below `top`, until stop(). */
    fog(top) {
        const box = this._track(el("rx_roam_fog", this.over));
        const W = this._w, H = this._h;
        place(box, 0, top, W, H - top);
        for (let i = 0; i < 9; i++) {
            const b = el("rx_roam_fog_bank", box);
            const w = W * (0.4 + Math.random() * 0.4);
            Object.assign(b.style, { left: `${Math.random() * W - w * 0.3}px`, top: `${Math.random() * 70}%`, width: `${w}px`, height: `${(H - top) * 0.5}px` });
            const drift = (Math.random() < 0.5 ? -1 : 1) * W * (0.1 + Math.random() * 0.15);
            b.animate([{ transform: "translateX(0)" }, { transform: `translateX(${drift}px)` }],
                { duration: 14000 + Math.random() * 12000, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
        }
        box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 2500, fill: "forwards" });
        return { stop: () => this._fadeOut(box, 2500) };
    }

    /** A warm glow `size` px across (a lantern); move() puts it at a point. */
    glow(size) {
        const g = this._track(el("rx_roam_glow", this.over));
        place(g, -size, -size, size, size);
        g.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, fill: "forwards" });
        g.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }], { duration: 180, iterations: Infinity, direction: "alternate", composite: "add" });
        return {
            move: (x, y) => { g.style.left = `${x - size / 2}px`; g.style.top = `${y - size / 2}px`; },
            stop: () => this._fadeOut(g, 600),
        };
    }

    /** Snow falling gently over the whole screen until stop(). */
    snowfall() {
        const box = this._track(el("rx_roam_snowfall", this.over));
        Object.assign(box.style, { inset: "0" });
        const H = this._h;
        for (let i = 0; i < 60; i++) {
            const f = el("rx_roam_flake", box, "span");
            const size = 3 + Math.random() * 5;
            Object.assign(f.style, { left: `${Math.random() * 100}%`, top: "-10px", width: `${size}px`, height: `${size}px` });
            const sway = (Math.random() - 0.5) * 80;
            f.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${sway}px, ${H * 0.5}px)`, offset: 0.5 },
                { transform: `translate(${-sway * 0.5}px, ${H + 20}px)` }],
            { duration: 7000 + Math.random() * 6000, delay: -Math.random() * 12000, iterations: Infinity, easing: "linear" });
        }
        box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1500, fill: "forwards" });
        return { stop: () => this._fadeOut(box, 1500) };
    }

    /** A snowman, built a piece at a time: ball(size) is a snowball to
     *  roll and stack (moveTo(centre x, bottom y, turn), setSize, settle),
     *  dress(...) what goes on it once stacked; leave() lets it melt away a
     *  while later. */
    snowman() {
        // A group: its pieces fade one by one under the cursor (ghost mode),
        // not the screen-wide box they're in.
        const box = this._track(el("rx_roam_snowman rx_roam_group", this.under));
        Object.assign(box.style, { inset: "0" });
        return {
            ball: (size) => {
                const b = el("rx_roam_snowball", box);
                const grain = el("rx_roam_snowball_grain", b);
                let s = size, cx = -9999, bottom = -9999, turn = 0;
                const apply = () => {
                    place(b, cx - s / 2, bottom - s, s, s);
                    grain.style.rotate = `${turn.toFixed(1)}deg`;
                };
                return {
                    get x() { return cx; },
                    get y() { return bottom; },
                    setSize: (v) => { s = v; apply(); },
                    moveTo: (x, y, deg) => { cx = x; bottom = y; if (deg !== undefined) turn = deg; apply(); },
                    settle: () => b.animate([{ transform: "scale(1.08, .88)", transformOrigin: "50% 100%" }, { transform: "scale(1)", transformOrigin: "50% 100%" }],
                        { duration: 300, easing: "ease-out" }),
                };
            },
            dress: (x, floorY, base, mid, head, sink = 0.15) => {
                const midBottom = floorY - base * (1 - sink), cM = midBottom - mid / 2;
                const headBottom = midBottom - mid * (1 - sink), cH = headBottom - head / 2, topH = headBottom - head;
                const W = mid * 2.6, top = topH - head * 1.05, H = floorY - top, left = x - W / 2;
                const X = (v) => (v - left).toFixed(1), Y = (v) => (v - top).toFixed(1);
                const svg = document.createElementNS(SVG_NS, "svg");
                svg.setAttribute("class", "rx_roam_snowman_dress");
                svg.setAttribute("viewBox", `0 0 ${W.toFixed(1)} ${H.toFixed(1)}`);
                place(svg, left, top, W, H);
                box.appendChild(svg);
                const twig = (s) => {
                    // From the middle ball's side, up and out, with two
                    // twiglets — drawn for each side, not mirrored.
                    const sx = x + s * mid * 0.42, sy = cM - mid * 0.05;
                    const ex = x + s * mid * 1.12, ey = cM - mid * 0.62;
                    const kx = x + s * mid * 0.85, ky = cM - mid * 0.4;
                    return `M${X(sx)} ${Y(sy)} Q${X(x + s * mid * 0.75)} ${Y(cM - mid * 0.18)} ${X(ex)} ${Y(ey)}`
                        + ` M${X(kx)} ${Y(ky)} L${X(kx + s * mid * 0.05)} ${Y(ky - mid * 0.24)}`
                        + ` M${X(x + s * mid * 1.0)} ${Y(cM - mid * 0.52)} L${X(x + s * mid * 1.2)} ${Y(cM - mid * 0.5)}`;
                };
                const coal = (cx, cy, r) => `<circle cx="${X(cx)}" cy="${Y(cy)}" r="${r.toFixed(1)}"/>`
                    + `<circle class="shine" cx="${X(cx - r * 0.3)}" cy="${Y(cy - r * 0.3)}" r="${(r * 0.3).toFixed(1)}"/>`;
                const smile = [-2, -1, 0, 1, 2].map((i) => coal(x + i * head * 0.1, cH + head * 0.2 + (1 - (i / 2.2) ** 2) * head * 0.07, head * 0.03)).join("");
                const tailX = x + mid * 0.22, neck = headBottom + head * 0.02;
                svg.innerHTML = `
                    <defs><linearGradient id="rxCarrot" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ea580c"/><stop offset="1" stop-color="#fb923c"/></linearGradient></defs>
                    <g class="part" data-part="arms"><path class="twig" style="stroke-width:${(mid * 0.045).toFixed(1)}px" d="${twig(-1)} ${twig(1)}"/></g>
                    <g class="part coal" data-part="buttons">${coal(x, cM - mid * 0.12, mid * 0.045)}${coal(x, cM + mid * 0.1, mid * 0.045)}${coal(x, cM + mid * 0.3, mid * 0.045)}</g>
                    <g class="part coal" data-part="eyes">${coal(x - head * 0.18, cH - head * 0.08, head * 0.06)}${coal(x + head * 0.18, cH - head * 0.08, head * 0.06)}</g>
                    <g class="part" data-part="nose"><path fill="url(#rxCarrot)" d="M${X(x - head * 0.05)} ${Y(cH + head * 0.01)} L${X(x + head * 0.46)} ${Y(cH + head * 0.1)} L${X(x - head * 0.04)} ${Y(cH + head * 0.13)} Z"/>
                        <path class="ridge" d="M${X(x + head * 0.1)} ${Y(cH + head * 0.04)} l${(head * 0.02).toFixed(1)} ${(head * 0.06).toFixed(1)} M${X(x + head * 0.24)} ${Y(cH + head * 0.06)} l${(head * 0.015).toFixed(1)} ${(head * 0.05).toFixed(1)}"/></g>
                    <g class="part coal" data-part="smile">${smile}</g>
                    <g class="part" data-part="scarf">
                        <rect class="scarf" x="${X(x - mid * 0.4)}" y="${Y(neck - head * 0.1)}" width="${(mid * 0.8).toFixed(1)}" height="${(head * 0.2).toFixed(1)}" rx="${(head * 0.08).toFixed(1)}"/>
                        <g class="tail"><path class="scarf" d="M${X(tailX)} ${Y(neck)} L${X(tailX + mid * 0.16)} ${Y(neck)} L${X(tailX + mid * 0.2)} ${Y(neck + mid * 0.5)} L${X(tailX + mid * 0.02)} ${Y(neck + mid * 0.52)} Z"/>
                        <path class="stripe" d="M${X(tailX + mid * 0.02)} ${Y(neck + mid * 0.18)} L${X(tailX + mid * 0.18)} ${Y(neck + mid * 0.18)} M${X(tailX + mid * 0.02)} ${Y(neck + mid * 0.34)} L${X(tailX + mid * 0.19)} ${Y(neck + mid * 0.34)}"/></g></g>
                    <g class="part" data-part="hat" transform="rotate(-9 ${X(x)} ${Y(topH)})">
                        <ellipse class="hat" cx="${X(x)}" cy="${Y(topH - head * 0.04)}" rx="${(head * 0.5).toFixed(1)}" ry="${(head * 0.09).toFixed(1)}"/>
                        <rect class="hat" x="${X(x - head * 0.32)}" y="${Y(topH - head * 0.7)}" width="${(head * 0.64).toFixed(1)}" height="${(head * 0.67).toFixed(1)}" rx="${(head * 0.04).toFixed(1)}"/>
                        <rect class="band" x="${X(x - head * 0.32)}" y="${Y(topH - head * 0.2)}" width="${(head * 0.64).toFixed(1)}" height="${(head * 0.1).toFixed(1)}"/></g>`;
                return {
                    show: (name) => {
                        const g = svg.querySelector(`[data-part="${name}"]`);
                        if (!g) return;
                        g.style.opacity = "1";
                        g.animate(name === "hat"
                            ? [{ translate: `0 ${(-head).toFixed(1)}px`, opacity: 0 }, { translate: "0 0", opacity: 1, offset: 0.7 }, { translate: `0 ${(-head * 0.08).toFixed(1)}px` }, { translate: "0 0" }]
                            : [{ scale: 0.3, opacity: 0 }, { scale: 1.12, opacity: 1, offset: 0.6 }, { scale: 1 }],
                        { duration: name === "hat" ? 600 : 360, easing: "ease-out" });
                    },
                };
            },
            // Melts: down into the floor, a while after it's done.
            leave: () => setTimeout(() => {
                if (!this._live.has(box)) return;
                box.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(.2)" }], { duration: 4000, easing: "ease-in", fill: "forwards" });
                this._fadeOut(box, 4000);
            }, 20000),
        };
    }

    /** An icy patch along a surface at y from x0 to x1, until stop(). */
    ice(x0, x1, y) {
        const i = this._track(el("rx_roam_ice", this.under));
        place(i, x0, y - 10, x1 - x0, 12);
        i.animate([{ opacity: 0, transform: "scaleX(.3)" }, { opacity: 1, transform: "scaleX(1)" }], { duration: 700, fill: "forwards" });
        return { stop: () => this._fadeOut(i, 1200) };
    }

    /** A drop falling from (x, y) to floorY (melting ice cream). */
    drip(x, y, floorY, color = "#fbcfe8") {
        const d = this._track(el("rx_roam_drip", this.over));
        place(d, x - 3, y, 6, 8);
        d.style.background = color;
        const fall = Math.max(10, floorY - y - 6);
        d.animate([{ transform: "translateY(0) scaleY(.6)" }, { transform: "translateY(4px) scaleY(1.2)", offset: 0.25 },
            { transform: `translateY(${fall}px) scaleY(1)`, offset: 0.9 }, { transform: `translateY(${fall}px) scale(1.8, .3)`, opacity: 0 }],
        { duration: 300 + fall * 1.2, easing: "ease-in", fill: "forwards" }).finished.then(() => this._remove(d), () => {});
    }

    /** A jet of water from `from` to `to` over `ms`. Resolves when the last
     *  of it lands. */
    async squirt(from, to, { ms = 1000 } = {}) {
        const lift = Math.min(120, Math.hypot(to.x - from.x, to.y - from.y) * 0.12);
        const flight = 420;
        const jobs = [];
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
            const d = this._track(el("rx_roam_drop2", this.over));
            const size = 5 + Math.random() * 4;
            place(d, from.x - size / 2, from.y - size / 2, size, size);
            const frames = [];
            for (let i = 0; i <= 10; i++) {
                const k = i / 10;
                frames.push({ transform: `translate(${(to.x - from.x) * k}px, ${(to.y - from.y) * k - Math.sin(Math.PI * k) * lift}px)` });
            }
            jobs.push(d.animate(frames, { duration: flight, easing: "linear", fill: "forwards" }).finished
                .then(() => this._remove(d), () => {}));
            await new Promise((r) => setTimeout(r, 35));
        }
        await Promise.all(jobs);
    }

    /** Water running down from (x, y) (a soaked window). */
    runs(x, y) {
        for (let i = 0; i < 4; i++) {
            const d = this._track(el("rx_roam_run", this.over));
            place(d, x + (Math.random() - 0.5) * 50, y, 4, 10);
            d.animate([{ transform: "translateY(0)", opacity: 0.9 }, { transform: `translateY(${40 + Math.random() * 60}px)`, opacity: 0 }],
                { duration: 1500 + Math.random() * 1200, delay: Math.random() * 300, easing: "ease-in", fill: "forwards" })
                .finished.then(() => this._remove(d), () => {});
        }
    }

    /** Blossom drifting down over the whole screen until stop(). */
    petals() {
        const box = this._track(el("rx_roam_petals", this.over));
        Object.assign(box.style, { inset: "0" });
        const W = this._w, H = this._h;
        for (let i = 0; i < 44; i++) {
            const p = el("rx_roam_petal", box, "span");
            const size = 8 + Math.random() * 7;
            Object.assign(p.style, { left: `${Math.random() * 110 - 10}%`, top: "-20px", width: `${size}px`, height: `${size * 0.7}px` });
            const sway = W * (0.05 + Math.random() * 0.12);
            p.animate([{ transform: "translate(0, 0) rotate(0deg)" },
                { transform: `translate(${sway}px, ${H * 0.5}px) rotate(${200 + Math.random() * 200}deg)`, offset: 0.5 },
                { transform: `translate(${sway * 0.4}px, ${H + 30}px) rotate(${500 + Math.random() * 300}deg)` }],
            { duration: 8000 + Math.random() * 6000, delay: -Math.random() * 12000, iterations: Infinity, easing: "linear" });
        }
        box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1500, fill: "forwards" });
        return { stop: () => this._fadeOut(box, 1800) };
    }

    /** A painted egg standing on y at x; collect(to) flies it into a hand. */
    egg(x, y, size) {
        const e = this._track(el("rx_roam_egg", this.under));
        place(e, x - size * 0.38, y - size, size * 0.76, size);
        const [c1, c2] = [pick(INKS), pick(INKS)];
        e.style.background = `repeating-linear-gradient(0deg, ${c1} 0 18%, #fff7ed 18% 26%, ${c2} 26% 44%, #fff7ed 44% 52%)`;
        e.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 400, delay: Math.random() * 400, easing: "cubic-bezier(.3,1.5,.5,1)", fill: "both" });
        return {
            x,
            collect: (to) => {
                const dx = to.x - x, dy = to.y - (y - size / 2);
                e.animate([{ transform: "translate(0,0) scale(1)" }, { transform: `translate(${dx}px, ${dy}px) scale(.4)`, opacity: 0 }],
                    { duration: 450, easing: "ease-in", fill: "forwards" }).finished.then(() => this._remove(e), () => {});
                this.stars(to.x, to.y, 4);
            },
            remove: () => this._fadeOut(e, 300),
        };
    }

    /** `text` (an emoji) standing on y at x, `size` px tall, until remove(). */
    token(text, x, y, size) {
        const t = this._track(el("rx_roam_token", this.under, "span"));
        t.textContent = text;
        place(t, x - size / 2, y - size, size, size);
        t.style.fontSize = `${size}px`;
        t.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 500, fill: "forwards" });
        return { remove: () => this._fadeOut(t, 600) };
    }

    /** A bedsheet ghost `w` × `h` px; moveTo(x, bottom, dir) places it,
     *  whisk() whips the sheet up and away. */
    ghost(w, h) {
        const g = this._track(el("rx_roam_ghost", this.over));
        place(g, -w * 2, -h * 2, w, h);
        g.innerHTML = '<svg viewBox="0 0 100 150"><path class="sheet" d="M50 4 C82 4 94 32 94 62 L94 132 C88 146 80 132 74 144 C68 132 60 146 54 136 C48 146 40 132 34 144 C28 132 20 146 14 134 C10 140 6 136 6 130 L6 62 C6 32 18 4 50 4 Z"/>'
            + '<ellipse class="eye" cx="36" cy="54" rx="7" ry="10"/><ellipse class="eye" cx="64" cy="54" rx="7" ry="10"/>'
            + '<ellipse class="mouth" cx="50" cy="82" rx="9" ry="12"/></svg>';
        g.firstChild.animate([{ transform: "rotate(-3deg)" }, { transform: "rotate(3deg)" }], { duration: 900, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
        return {
            moveTo: (x, bottom, dir = 1) => {
                g.style.left = `${x - w / 2}px`;
                g.style.top = `${bottom - h}px`;
                g.style.transform = dir < 0 ? "scaleX(-1)" : "";
            },
            whisk: () => {
                g.animate([{ translate: "0 0", rotate: "0deg", opacity: 1 }, { translate: `${w * 0.6}px ${-h * 1.2}px`, rotate: "40deg", opacity: 0 }],
                    { duration: 700, easing: "ease-in", fill: "forwards" }).finished.then(() => this._remove(g), () => {});
            },
            remove: () => this._fadeOut(g, 300),
        };
    }

    /** A wrapped present `size` px on the floor at (x, y), dropped in;
     *  open() pops the lid off in a shower of confetti. */
    present(x, y, size) {
        const p = this._track(el("rx_roam_present", this.under));
        place(p, x - size / 2, y - size, size, size);
        const lid = el("rx_roam_present_lid", p);
        p.animate([{ transform: `translateY(-${size * 4}px)` }, { transform: "translateY(0)", offset: 0.7 },
            { transform: "translateY(-8%) scaleY(1.04)", offset: 0.85 }, { transform: "translateY(0)" }],
        { duration: 800, easing: "ease-in", fill: "forwards" });
        return {
            open: () => {
                lid.animate([{ transform: "translate(0,0) rotate(0)" }, { transform: `translate(${size * 0.6}px, ${-size * 1.6}px) rotate(70deg)`, opacity: 0 }],
                    { duration: 900, easing: "ease-out", fill: "forwards" });
                this.confetti(x, y - size, 50);
                this.stars(x, y - size * 1.1, 6);
                setTimeout(() => { if (this._live.has(p)) this._fadeOut(p, 1200); }, 6000);
            },
            remove: () => this._fadeOut(p, 400),
        };
    }

    /** A firework: a spark up from the bottom of the screen to (x, y), and
     *  the burst. */
    firework(x, y, bottom) {
        const color = pick(INKS);
        const s = this._track(el("rx_roam_spark", this.over));
        place(s, x - 3, bottom, 6, 6);
        s.style.background = color;
        s.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${y - bottom}px)`, opacity: 1 }],
            { duration: 700, easing: "cubic-bezier(.2,.7,.4,1)", fill: "forwards" }).finished.then(() => {
            this._remove(s);
            this.pop(x, y, 90);
            for (let i = 0; i < 30; i++) {
                const p = this._track(el("rx_roam_spark", this.over));
                place(p, x - 2.5, y - 2.5, 5, 5);
                p.style.background = color;
                p.style.boxShadow = `0 0 6px 2px ${color}`;
                const a = (i / 30) * Math.PI * 2, r = 70 + Math.random() * 60;
                p.animate([{ transform: "translate(0,0)", opacity: 1 },
                    { transform: `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px)`, opacity: 0.9, offset: 0.55 },
                    { transform: `translate(${Math.cos(a) * r * 1.1}px, ${Math.sin(a) * r * 1.1 + 40}px)`, opacity: 0 }],
                { duration: 1400 + Math.random() * 400, easing: "ease-out", fill: "forwards" }).finished.then(() => this._remove(p), () => {});
            }
        }, () => {});
    }

    /** A boomerang `size` px across; moveTo() puts its centre and turn.
     *  The classic shape: two flat arms meeting in a rounded elbow, wood
     *  with painted bands. */
    boomerang(size) {
        const b = this._track(el("rx_roam_boomerang", this.over));
        place(b, 0, 0, size, size);
        const d = "M14 76 C18 52 30 32 50 26 C70 32 82 52 86 76";
        b.innerHTML = '<svg viewBox="0 0 100 100"><defs><linearGradient id="rxWood" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#e3a35b"/><stop offset="1" stop-color="#a5622a"/></linearGradient></defs>'
            + `<path class="edge" d="${d}"/><path class="wood" d="${d}"/>`
            + `<path class="paint" pathLength="100" d="${d}"/><path class="grain" d="M22 66 C26 50 36 38 50 33 C64 38 74 50 78 66"/></svg>`;
        return {
            moveTo: (x, y, deg) => {
                b.style.left = `${x - size / 2}px`;
                b.style.top = `${y - size / 2}px`;
                b.style.rotate = `${deg.toFixed(0)}deg`;
            },
            remove: () => this._remove(b),
        };
    }

    // ── cartoon faces (the cute and the hungry, roam_gags_more.js) ───────

    /** A thought bubble over (x, y) with `src` (a picture) in it, the
     *  little puffs trailing down to the head; move() follows the head. */
    thought(src, x, y, size) {
        const t = this._track(el("rx_roam_thought", this.follow));
        place(t, 0, 0, size, size * 0.8);
        // In px of its own size: a % padding is of the layer's (the
        // screen's) width and squeezes the picture to nothing.
        t.style.padding = `${(size * 0.1).toFixed(1)}px`;
        const img = el("rx_roam_thought_img", t, "img");
        img.src = src;
        for (const k of [1, 2]) el(`rx_roam_thought_puff rx_roam_thought_puff--${k}`, t);
        t.animate([{ scale: 0, opacity: 0 }, { scale: 1.08, opacity: 1, offset: 0.7 }, { scale: 1, opacity: 1 }],
            { duration: 420, easing: "ease-out", fill: "forwards" });
        const at = (nx, ny) => { t.style.left = `${nx - size * 0.15}px`; t.style.top = `${ny - size * 1.1}px`; };
        at(x, y);
        return { move: at, stop: () => this._fadeOut(t, 300) };
    }

    /** Surprise lines bursting round (x, y) over the top of the head: the
     *  comics' emanata, `n` strokes `r` px out. */
    emanata(x, y, r, n = 9) {
        const box = this._track(document.createElementNS(SVG_NS, "svg"));
        box.setAttribute("class", "rx_roam_emanata");
        this.follow.appendChild(box);
        let d = "";
        for (let i = 0; i < n; i++) {
            const a = Math.PI * (1.05 + (0.9 * i) / (n - 1));
            const r0 = r * 0.72, r1 = r * (1.05 + 0.15 * (i % 2));
            d += `M${(x + Math.cos(a) * r0).toFixed(1)} ${(y + Math.sin(a) * r0).toFixed(1)} L${(x + Math.cos(a) * r1).toFixed(1)} ${(y + Math.sin(a) * r1).toFixed(1)} `;
        }
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        box.appendChild(p);
        box.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
            { duration: 900, fill: "forwards" }).finished.then(() => this._remove(box), () => {});
    }

    /** Hearts for eyes, beating, at `l`, `r`; move() follows, stop() ends. */
    heartEyes(l, r, size) {
        const make = () => {
            const h = this._track(el("rx_roam_hearteye", this.follow, "span"));
            h.textContent = "♥";
            h.style.fontSize = `${size}px`;
            place(h, 0, 0, size, size);
            h.animate([{ scale: 0.2 }, { scale: 1.3 }, { scale: 1 }], { duration: 400, fill: "forwards" });
            h.animate([{ scale: 1 }, { scale: 1.25 }, { scale: 1 }], { duration: 600, delay: 400, iterations: Infinity, composite: "accumulate" });
            return h;
        };
        const hs = [make(), make()];
        const at = (h, p) => { h.style.left = `${p.x - size / 2}px`; h.style.top = `${p.y - size / 2}px`; };
        at(hs[0], l);
        at(hs[1], r);
        return {
            move: (nl, nr) => { at(hs[0], nl); at(hs[1], nr); },
            stop: () => hs.forEach((h) => this._fadeOut(h, 250)),
        };
    }

    clear() {
        for (const e of this._live) e.remove();
        this._live.clear();
    }
}

export { el, place, pick as fxPick, INKS, SVG_NS };
