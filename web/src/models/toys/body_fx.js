// The little effects a toy routine asks for (body.fx in models/toys/
// brains.js), drawn with the roam effects (models/roam_fx.js) on a DOM layer
// over either stage: hearts, crumbs, comic words, stars, steam, fire breath,
// a sweat drop, words wobbling in a fan's wind, a note from a bottle. A body
// provides `rfx` (a RoamFx) and `page(point)` (a world point in that
// layer's px).

import { el, place } from "../roam_fx";

const rand = (a, b) => a + Math.random() * (b - a);

export function bodyFx(body, name, a, b) {
    const rfx = body.rfx;
    if (!rfx) return;
    const p = (q) => body.page(q);
    switch (name) {
        case "comic": {
            const q = p(b || body.head());
            rfx.comic(a, q.x, q.y - 24, { size: 30 });
            break;
        }
        case "hearts": { const q = p(a); rfx.hearts(q.x, q.y - 26); break; }
        case "crumbs": { const q = p(a); rfx.crumbs(q.x, q.y, b, 6); break; }
        case "stars": { const q = p(a); rfx.stars(q.x, q.y - 14); break; }
        case "steam": {
            const q = p(a);
            for (let i = 0; i < 3; i++) setTimeout(() => rfx.puff(q.x + rand(-18, 18), q.y - 30 - i * 6, 20 + i * 4), i * 120);
            break;
        }
        case "sweat": { const q = p(a); rfx.drip(q.x + 16, q.y - 6, q.y + 26, "#7dd3fc"); break; }
        case "fire": {
            // Breathed out ahead of them for most of a second.
            const dir = body.facingSign();
            const t0 = performance.now();
            const iv = setInterval(() => {
                const q = p(body.head());
                const s = (performance.now() - t0) / 900;
                if (s >= 1) { clearInterval(iv); return; }
                for (let i = 0; i < 3; i++) rfx.ember(q.x + dir * rand(14, 70) * (0.4 + s), q.y + rand(8, 22));
            }, 40);
            break;
        }
        case "wobble": {
            const q = p(b || body.head());
            wobbleWords(rfx, a, q.x, q.y - 34);
            break;
        }
        case "scroll": {
            const q = p(a);
            scrollNote(rfx, q.x, q.y - 40);
            break;
        }
        default:
    }
}

/** Words said into a fan: each letter shaking in the wind. */
function wobbleWords(rfx, text, x, y) {
    const b = rfx._track(el("rx_roam_say rx_toy_wobble", rfx.follow));
    place(b, x, y, 1, 1);
    [...text].forEach((ch, i) => {
        const s = el("rx_toy_wobble_ch", b, "span");
        s.textContent = ch;
        s.animate([{ transform: "translateY(0)" }, { transform: "translateY(-3px)" }, { transform: "translateY(2px)" }, { transform: "translateY(0)" }],
            { duration: 140, delay: i * 23, iterations: Infinity });
    });
    b.animate([{ transform: "translate(-50%,-100%) scale(.6)", opacity: 0 },
        { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.1 },
        { transform: "translate(-50%,-100%) scale(1)", opacity: 1, offset: 0.88 },
        { transform: "translate(-50%,-110%) scale(1)", opacity: 0 }],
    { duration: 3200, fill: "forwards" }).finished.then(() => rfx._remove(b), () => {});
}

/** The note out of a bottle, held up for a moment: a scrap of a map. */
function scrollNote(rfx, x, y) {
    const n = rfx._track(el("rx_toy_scroll", rfx.over));
    place(n, x - 60, y - 70, 120, 84);
    n.innerHTML = `<svg viewBox="0 0 120 84"><path d="M8 6 H112 V78 H8 Z" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>
<path d="M20 60 C34 40 50 64 66 44 S96 30 100 22" fill="none" stroke="#b91c1c" stroke-width="2.5" stroke-dasharray="1 6" stroke-linecap="round"/>
<path d="M94 16 l10 10 m0 -10 l-10 10" stroke="#b91c1c" stroke-width="3.5" stroke-linecap="round"/>
<path d="M14 72 c10 -6 18 -2 26 -8 M70 74 c8 -4 16 -2 24 -6" fill="none" stroke="#92400e" stroke-width="1.5"/></svg>`;
    n.animate([{ transform: "scale(.3) rotate(-8deg)", opacity: 0 }, { transform: "scale(1) rotate(-3deg)", opacity: 1, offset: 0.12 },
        { transform: "scale(1) rotate(-3deg)", opacity: 1, offset: 0.85 }, { transform: "scale(.9) rotate(4deg)", opacity: 0 }],
    { duration: 3400, fill: "forwards" }).finished.then(() => rfx._remove(n), () => {});
}
