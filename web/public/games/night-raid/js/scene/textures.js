// Rexmaw Raids: the ships' shared textures, loaded once and shared by every hull, sail and flag.
//
//   assets/tex/hull.webp    1024×512: dark oak planks (left half) | painted planks, pale so a
//                           strake's colour can tint them (right half)
//   assets/tex/deck.webp    512×512 deck planks (running along the ship)
//   assets/tex/sails.webp   1024×512: clean canvas (left) | weathered, patched canvas (right)
//   assets/tex/flags.webp   1024×512: navy | merchant (top row), pirate | Gloam (bottom row)
//   assets/tex/emblems.webp 512×512 RGBA sail emblems: navy crown & anchor | merchant house mark (top),
//                           the Gloam's skull | the Iron Duke's lion (bottom)
//
// (Generated for Rexclaw with OpenAI image generation through the Codex CLI; see assets/CREDITS.txt.)
// Until a file arrives (or if it can't), a procedural canvas stands in, so nothing ever waits:
// the image is swapped into the same texture object when it loads.

import * as THREE from "three";

const BASE = new URL("../../assets/tex/", import.meta.url).href;
let shared = null;

function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Planks, horizontal (hull) or vertical (deck), in a base colour: the stand-in. */
function planks(g, x0, y0, w, h, base, { vertical = false, n = 8, seed = 1 } = {}) {
  const r = rng(seed);
  g.fillStyle = base; g.fillRect(x0, y0, w, h);
  const step = (vertical ? w : h) / n;
  for (let i = 0; i < n; i++) {
    const v = 0.85 + r() * 0.3;
    g.fillStyle = `rgba(${v > 1 ? 255 : 0},${v > 1 ? 255 : 0},${v > 1 ? 255 : 0},${Math.abs(v - 1) * 0.6})`;
    if (vertical) g.fillRect(x0 + i * step, y0, step - 1, h); else g.fillRect(x0, y0 + i * step, w, step - 1);
    g.fillStyle = "rgba(0,0,0,.55)";
    if (vertical) g.fillRect(x0 + i * step + step - 2, y0, 2, h); else g.fillRect(x0, y0 + i * step + step - 2, w, 2);
    for (let b = r() * 200; b < (vertical ? h : w); b += 120 + r() * 160) {
      if (vertical) g.fillRect(x0 + i * step, y0 + b, step, 2); else g.fillRect(x0 + b, y0 + i * step, 2, step);
    }
  }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.08})`;
    if (vertical) g.fillRect(x0 + r() * w, y0 + r() * h, 1, 10 + r() * 40); else g.fillRect(x0 + r() * w, y0 + r() * h, 10 + r() * 40, 1);
  }
}

function sailCloth(g, x0, y0, w, h, base, seed) {
  const r = rng(seed);
  g.fillStyle = base; g.fillRect(x0, y0, w, h);
  g.strokeStyle = "rgba(120,100,60,.32)"; g.lineWidth = 2;
  for (let x = x0 + w / 8; x < x0 + w; x += w / 8) { g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + h); g.stroke(); }
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(80,65,40,${r() * 0.05})`; g.fillRect(x0 + r() * w, y0 + r() * h, 6 + r() * 30, 6 + r() * 30); }
}

function flagFallback(g, x0, y0, w, h, kind) {
  if (kind === "navy") {
    g.fillStyle = "#1b2e6b"; g.fillRect(x0, y0, w, h);
    g.strokeStyle = "#f3f1ea"; g.lineWidth = h * 0.14;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + w, y0 + h); g.moveTo(x0 + w, y0); g.lineTo(x0, y0 + h); g.stroke();
    g.fillStyle = "#f3f1ea"; g.beginPath(); g.arc(x0 + w / 2, y0 + h / 2, h * 0.22, 0, 7); g.fill();
    g.fillStyle = "#d1a73a"; g.fillRect(x0 + w / 2 - 4, y0 + h * 0.34, 8, h * 0.32);
  } else if (kind === "merchant") {
    for (let i = 0; i < 7; i++) { g.fillStyle = i % 2 ? "#f3f1ea" : "#b3261e"; g.fillRect(x0, y0 + (i * h) / 7, w, h / 7 + 1); }
    g.fillStyle = "#1f4a33"; g.fillRect(x0, y0, w * 0.4, h * 0.57);
  } else if (kind === "pirate") {
    g.fillStyle = "#0d0d0f"; g.fillRect(x0, y0, w, h);
    const cx = x0 + w / 2, cy = y0 + h * 0.45, s = h * 0.55;
    g.fillStyle = "#ece6d6";
    g.beginPath(); g.ellipse(cx, cy - s * 0.1, s * 0.3, s * 0.27, 0, 0, 7); g.fill();
    g.fillRect(cx - s * 0.16, cy + s * 0.08, s * 0.32, s * 0.16);
    g.fillStyle = "#0d0d0f"; g.beginPath(); g.arc(cx - s * 0.11, cy - s * 0.1, s * 0.07, 0, 7); g.arc(cx + s * 0.11, cy - s * 0.1, s * 0.07, 0, 7); g.fill();
    g.strokeStyle = "#ece6d6"; g.lineWidth = s * 0.07;
    g.beginPath(); g.moveTo(cx - s * 0.5, cy + s * 0.25); g.lineTo(cx + s * 0.5, cy + s * 0.6); g.moveTo(cx + s * 0.5, cy + s * 0.25); g.lineTo(cx - s * 0.5, cy + s * 0.6); g.stroke();
  } else if (kind === "gloam") {
    g.fillStyle = "#0e1716"; g.fillRect(x0, y0, w, h);
    g.fillStyle = "#9ffff0"; g.beginPath(); g.ellipse(x0 + w / 2, y0 + h / 2, h * 0.3, h * 0.14, 0, 0, 7); g.fill();
    g.fillStyle = "#0e1716"; g.beginPath(); g.ellipse(x0 + w / 2, y0 + h / 2, h * 0.04, h * 0.13, 0, 0, 7); g.fill();
  } else if (kind === "white") {
    g.fillStyle = "#f4f1e8"; g.fillRect(x0, y0, w, h);
    g.fillStyle = "rgba(0,0,0,.06)"; for (let i = 0; i < 6; i++) g.fillRect(x0, y0 + i * h / 6, w, 3);
  } else if (kind === "pennant") {
    g.fillStyle = "#b3261e"; g.fillRect(x0, y0, w, h);
    g.fillStyle = "#f3f1ea"; g.fillRect(x0, y0, w * 0.12, h);
  }
}

function tex(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Load `name` into a canvas region when it arrives; `onload(img)` repaints. */
function fetchImage(name, onload) {
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => { try { onload(img); } catch (e) { console.debug("[rexmaw-raids] texture paint failed", name, e); } };
  img.onerror = () => console.debug(`[rexmaw-raids] ${name} not available; the painted stand-in stays`);
  img.src = BASE + name;
}

/**
 * The shared ship textures (built once, the files swapped in as they load).
 * @returns {{oak: THREE.Texture, paint: THREE.Texture, deck: THREE.Texture, sail: THREE.Texture, sailWorn: THREE.Texture, flags: THREE.Texture, FLAG_CELLS: object, onReady: (fn) => void}}
 */
export function shipTextures() {
  if (shared) return shared;
  // Hull: two separate tiles (oak, paint) so each wraps on its own.
  const oakC = canvas(512, 512), paintC = canvas(512, 512), deckC = canvas(512, 512);
  planks(oakC.getContext("2d"), 0, 0, 512, 512, "#4a3424", { seed: 3 });
  planks(paintC.getContext("2d"), 0, 0, 512, 512, "#e9e3d4", { seed: 5 });
  planks(deckC.getContext("2d"), 0, 0, 512, 512, "#a8946f", { vertical: true, n: 10, seed: 9 });
  const sailC = canvas(512, 512), wornC = canvas(512, 512);
  sailCloth(sailC.getContext("2d"), 0, 0, 512, 512, "#f1e9d4", 11);
  sailCloth(wornC.getContext("2d"), 0, 0, 512, 512, "#c9bc9c", 13);
  // Flags: a 2×3 atlas of 512×256 cells.
  const flagC = canvas(1024, 768);
  const fg = flagC.getContext("2d");
  const FLAG_CELLS = { navy: [0, 0], merchant: [1, 0], pirate: [0, 1], gloam: [1, 1], white: [0, 2], pennant: [1, 2] };
  for (const [k, [cx, cy]] of Object.entries(FLAG_CELLS)) flagFallback(fg, cx * 512, cy * 256, 512, 256, k);

  // Sail emblems: a 2×2 atlas on transparency (navy crown and anchor | merchant house mark, Gloam skull | the
  // Iron Duke's lion). The stand-in: plain shapes in the same colours.
  const emblemC = canvas(512, 512);
  {
    const g = emblemC.getContext("2d");
    const disc = (cx, cy, r, fill, stroke) => { g.beginPath(); g.arc(cx, cy, r, 0, 7); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.lineWidth = 16; g.strokeStyle = stroke; g.stroke(); } };
    disc(128, 140, 70, "#1b2e6b"); disc(128, 70, 30, "#d1a73a");
    disc(384, 128, 80, null, "#b3261e");
    disc(128, 370, 70, "#2a9a8a"); disc(105, 360, 14, "#bffff4");
    disc(384, 384, 75, "#151515", "#d8ac3a");
  }
  const EMBLEM_CELLS = { navy: [0, 0], merchant: [1, 0], gloam: [0, 1], duke: [1, 1] };

  const T = {
    oak: tex(oakC), paint: tex(paintC), deck: tex(deckC), sail: tex(sailC), sailWorn: tex(wornC), flags: tex(flagC, { repeat: false }),
    emblems: tex(emblemC, { repeat: false }),
    FLAG_CELLS, EMBLEM_CELLS,
    /** The atlas cell's uv rectangle {u0, v0, u1, v1} for a flag kind. */
    flagRect(kind) {
      const [cx, cy] = FLAG_CELLS[kind] || FLAG_CELLS.white;
      const pad = 0.004;
      return { u0: cx / 2 + pad, u1: (cx + 1) / 2 - pad, v0: 1 - (cy + 1) / 3 + pad, v1: 1 - cy / 3 - pad };
    },
  };

  fetchImage("hull.webp", (img) => {
    const w = img.width / 2, h = img.height;
    for (const [c, sx] of [[oakC, 0], [paintC, w]]) { const g = c.getContext("2d"); g.clearRect(0, 0, 512, 512); g.drawImage(img, sx, 0, w, h, 0, 0, 512, 512); }
    T.oak.needsUpdate = true; T.paint.needsUpdate = true;
  });
  fetchImage("deck.webp", (img) => { const g = deckC.getContext("2d"); g.drawImage(img, 0, 0, 512, 512); T.deck.needsUpdate = true; });
  fetchImage("sails.webp", (img) => {
    const w = img.width / 2, h = img.height;
    for (const [c, sx] of [[sailC, 0], [wornC, w]]) { const g = c.getContext("2d"); g.clearRect(0, 0, 512, 512); g.drawImage(img, sx, 0, w, h, 0, 0, 512, 512); }
    T.sail.needsUpdate = true; T.sailWorn.needsUpdate = true;
  });
  fetchImage("flags.webp", (img) => {
    const w = img.width / 2, h = img.height / 2;
    const map = { navy: [0, 0], merchant: [1, 0], pirate: [0, 1], gloam: [1, 1] };
    for (const [k, [sx, sy]] of Object.entries(map)) {
      const [cx, cy] = FLAG_CELLS[k];
      fg.clearRect(cx * 512, cy * 256, 512, 256);
      fg.drawImage(img, sx * w, sy * h, w, h, cx * 512, cy * 256, 512, 256);
    }
    T.flags.needsUpdate = true;
  });
  fetchImage("emblems.webp", (img) => { const g = emblemC.getContext("2d"); g.clearRect(0, 0, 512, 512); g.drawImage(img, 0, 0, 512, 512); T.emblems.needsUpdate = true; });
  shared = T;
  return T;
}
