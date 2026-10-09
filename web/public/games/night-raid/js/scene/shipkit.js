// Rexmaw Raids: the ship kit. Detailed procedural ships, built ONCE per class and shared by every
// ship of that class (fleet.js pools them), plus the materials whose programs every ship shares.
//
// Per class, five geometries (one draw each per ship) and two line/flag draws:
//   hull    a lofted, planked hull in bands: copper-red bottom, dark oak, black wales standing
//           proud, painted gun-port strakes (the paint tile tinted per class: Nelson ochre on
//           navy ships, red on brigs, green on merchants), upper works, bulwarks raised over the
//           quarterdeck and forecastle with a cap rail and red-painted insides, a stepped
//           quarterdeck, the deck (deck planks), the transom.
//   rig     masts in three doublings (lower mast, topmast, topgallant) with tops, crosstrees
//           and a crow's nest; yards; bowsprit and jibboom; gaff and boom; channels; rails and
//           balustrades; the wheel, binnacle, capstan, hatches with gratings, boats, cargo; the
//           figurehead; the stern gallery with lit windows (emissive by night); lantern bodies.
//   guns    per gun: the dark port, its lid (hinged at the top, swings up as the ports open)
//           and the barrel (runs out with the lids, recoils on a volley, ripple-timed down the side).
//   sails   courses, topsails, topgallants (royals on the big ones), jibs and the spanker; they
//           billow with the wind and reef by sail state (courses first), tear (procedural holes
//           by damage; the weathered tile's own holes on the tattered), and fall with their mast.
//   ropes   shrouds with ratlines, stays, backstays, the bowsprit's gear (one LineSegments).
//   flags   the ensign at the stern and a pennant at the main truck (and a white flag, swapped
//           in by a uniform on surrender) in one mesh over the flag atlas, streaming downwind.
//
// Frames: the ship's local frame matches the Rexmaw's ship space (+Z bow, +X port, y = 0 at the
// waterline). Every class's numbers are in CLASSES (metres).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { shipTextures } from "./textures.js";

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * One look per class. L length, B half-beam, D draught, h0 deck height amidships, qd/fc the quarterdeck and
 * forecastle rise, bw bulwark height, masts {t along the hull 0 = stern, h height over the deck}, guns a side
 * per deck, decks, paint (sRGB): bottom, oak (tint on the oak tile), wale, strake (tint on the paint tile),
 * upper, inner, rail, deck. flag/sail kinds, stern window rows, figurehead, lanterns [x, y over the deck, t].
 */
// v3 look per class (read at a glance): full (0..1) fattens the bow and stern (merchants), lateen = a single
// lateen sail on a slanted yard (gunboats), stripe = [colour, bands] painted down the canvas, emblem = a sail
// emblem cell (textures.js EMBLEM_CELLS) on the main mast's course (the lateen on a gunboat), flagScale = the
// ensign's size, ember = tarred seams glowing (the fire ship), crew = figures on deck, sheerWale = the sheer
// wale's own colour (gilt / navy blue).
export const CLASSES = Object.freeze({
  gunboat: { L: 19, B: 2.25, D: 1.1, h0: 1.0, qd: 0.2, fc: 0.2, bw: 0.6, masts: [{ t: 0.6, h: 15 }], tiers: 2, guns: 0, decks: 1, bowGun: true, lateen: true,
    paint: { bottom: "#5a2a1c", oak: "#a08a78", wale: "#1d3566", strake: "#2f5592", upper: "#22385e", inner: "#6e2a1e", rail: "#3a2a1c", deck: "#b8a888", sheerWale: "#e8e2d2" },
    flag: "navy", sail: "plain", emblem: "navy", windows: 0, crew: 4, lamps: [[0, 1.0, 0.02], [0, 1.2, 0.95]] },
  merchant: { L: 31, B: 6.1, D: 2.9, h0: 2.9, qd: 1.5, fc: 1.0, bw: 1.1, full: 0.85, masts: [{ t: 0.36, h: 20 }, { t: 0.68, h: 22 }], tiers: 2, guns: 2, decks: 1, cargo: true, boat: true,
    paint: { bottom: "#7a3a22", oak: "#c4a688", wale: "#2a2018", strake: "#3f6a4a", upper: "#7a5230", inner: "#7a3a22", rail: "#4a3020", deck: "#c0aa86", sheerWale: "#c9a03a" },
    flag: "merchant", flagScale: 1.35, sail: "cream", stripe: ["#b0362a", 6], emblem: "merchant", windows: 1, figure: "#d8cbb0", crew: 6, lamps: [[0, 1.6, 0.0], [-1.6, 1.4, 0.0], [0, 1.4, 0.97]] },
  brig: { L: 28, B: 4.2, D: 2.4, h0: 2.2, qd: 1.0, fc: 0.8, bw: 1.0, masts: [{ t: 0.36, h: 22 }, { t: 0.68, h: 24 }], tiers: 3, guns: 6, decks: 1,
    paint: { bottom: "#7a3220", oak: "#9c8270", wale: "#1a1614", strake: "#9a2a20", upper: "#2c2420", inner: "#8a2a1c", rail: "#2a1c14", deck: "#bca684" },
    flag: "navy", sail: "plain", emblem: "navy", windows: 1, figure: "#d1a73a", crew: 8, lamps: [[0, 1.6, 0.0], [0, 1.4, 0.97]] },
  frigate: { L: 42, B: 5.6, D: 3.2, h0: 2.9, qd: 1.6, fc: 1.1, bw: 1.1, masts: [{ t: 0.2, h: 24 }, { t: 0.5, h: 32 }, { t: 0.76, h: 28 }], tiers: 3, guns: 11, decks: 1, boat: true, nest: true,
    paint: { bottom: "#7a3220", oak: "#8a7462", wale: "#1d3a7a", strake: "#f0ebe0", upper: "#1d3a7a", inner: "#8a2a1c", rail: "#16244a", deck: "#c0aa86", sheerWale: "#f0ebe0" },
    flag: "navy", flagScale: 1.7, sail: "plain", emblem: "navy", windows: 2, gallery: true, figure: "#e8d9b0", crew: 12, lamps: [[0, 1.8, 0.0], [1.9, 1.7, 0.01], [-1.9, 1.7, 0.01], [0, 1.4, 0.97]] },
  fireship: { L: 24, B: 3.7, D: 2.0, h0: 1.9, qd: 0.8, fc: 0.6, bw: 0.9, masts: [{ t: 0.38, h: 17 }, { t: 0.7, h: 18 }], tiers: 2, guns: 0, decks: 1, barrels: true, tattered: 0.55, ember: true,
    paint: { bottom: "#140e0c", oak: "#2a2220", wale: "#0a0807", strake: "#151110", upper: "#120e0c", inner: "#2a1410", rail: "#0e0a08", deck: "#3e342a" },
    flag: null, sail: "grimy", windows: 0, crew: 3, lamps: [[0, 1.2, 0.0]] },
  manowar: { L: 56, B: 7.4, D: 4.2, h0: 4.6, qd: 2.0, fc: 1.4, bw: 1.2, masts: [{ t: 0.2, h: 32 }, { t: 0.5, h: 44 }, { t: 0.77, h: 37 }], tiers: 4, guns: 14, decks: 2, boat: true, nest: true,
    paint: { bottom: "#7a3220", oak: "#8a7462", wale: "#121010", strake: "#d6a53a", upper: "#181614", inner: "#8a2a1c", rail: "#181410", deck: "#c0aa86" },
    flag: "navy", flagScale: 1.5, sail: "plain", emblem: "navy", windows: 3, gallery: true, figure: "#e0b84a", crew: 14, lamps: [[0, 2.2, 0.0], [2.6, 2.0, 0.01], [-2.6, 2.0, 0.01], [0, 1.8, 0.97], [0, 3.2, 0.5]] },
  ironduke: { L: 64, B: 8.4, D: 4.8, h0: 6.4, qd: 2.4, fc: 1.6, bw: 1.3, masts: [{ t: 0.19, h: 36 }, { t: 0.5, h: 50 }, { t: 0.77, h: 42 }], tiers: 4, guns: 16, decks: 3, boat: true, nest: true,
    paint: { bottom: "#5a2a1c", oak: "#6e5e54", wale: "#0c0c0c", strake: "#e2b640", upper: "#0f0f10", inner: "#7a1e16", rail: "#0f0d0b", deck: "#b8a27e", sheerWale: "#d8ac3a" },
    flag: "navy", flagScale: 1.9, sail: "plain", emblem: "duke", windows: 3, gallery: true, quarter: true, figure: "#f0c850", gilt: true, crew: 14, lamps: [[0, 2.6, 0.0], [3.0, 2.4, 0.01], [-3.0, 2.4, 0.01], [0, 2.0, 0.97], [0, 3.8, 0.5]] },
  gloam: { L: 46, B: 6.0, D: 3.4, h0: 3.0, qd: 2.0, fc: 1.2, bw: 1.1, masts: [{ t: 0.2, h: 29 }, { t: 0.5, h: 39 }, { t: 0.77, h: 31 }], tiers: 3, guns: 12, decks: 1, tattered: 0.85, eerie: true, nest: true,
    paint: { bottom: "#0b0d0e", oak: "#3a403e", wale: "#070808", strake: "#1f4a44", upper: "#101414", inner: "#14201e", rail: "#0c0f0f", deck: "#3a3c38", sheerWale: "#1f6a5e" },
    flag: "gloam", flagScale: 1.4, sail: "gloam", emblem: "gloam", windows: 2, gallery: true, quarter: true, figure: "#bdb6a4", crew: 10, lamps: [[0, 2.0, 0.0], [2.0, 1.8, 0.01], [-2.0, 1.8, 0.01], [0, 1.8, 0.97]] },
});
const ALIASES = { fire_ship: "fireship", "fire-ship": "fireship", man_o_war: "manowar", "man-o-war": "manowar", "man-o'-war": "manowar", manofwar: "manowar", legendary: "gloam", the_gloam: "gloam", iron_duke: "ironduke", "the_iron_duke": "ironduke", duke: "ironduke" };
/** The class key for a contact's `cls` (forgiving). */
export function classOf(cls) {
  const k = String(cls || "").toLowerCase().replace(/\s+/g, "_");
  if (CLASSES[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  if (k.includes("gloam")) return "gloam";
  if (k.includes("duke")) return "ironduke";
  if (k.includes("fire")) return "fireship";
  if (k.includes("war")) return "manowar";
  return "brig";
}

// ---- Shape ---------------------------------------------------------------------------------------

export function shape(c) {
  // A full-bodied hull (a merchant's) carries her beam further forward and aft, and rounds her bow.
  const full = clamp(+c.full || 0, 0, 1);
  const bowAt = 0.6 + 0.12 * full, bowExp = 0.62 - 0.3 * full, sternK = 0.78 + 0.12 * full;
  const halfBeam = (t) => {
    if (t < 0.16) return c.B * (sternK + (1 - sternK) * smooth(0, 0.16, t));
    if (t > bowAt) return c.B * Math.pow(Math.max(0, Math.cos(((t - bowAt) / (1 - bowAt)) * Math.PI / 2)), bowExp);
    return c.B;
  };
  const keel = (t) => -0.25 - c.D * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, t * 1.02 + 0.012))), 0.32);
  const sheer = (t) => c.h0 + 0.5 * Math.pow((t - 0.5) * 2, 2) + (t > 0.85 ? 0.4 * smooth(0.85, 1, t) : 0);
  /** The deck: the waist at the sheer, the quarterdeck and forecastle stepped up. */
  const QD = 0.235, FC = 0.86;
  const deck = (t) => sheer(t) - 0.05 + (t < QD ? c.qd * 0.78 : 0) + (t > FC ? c.fc * 0.72 : 0);
  const bulwark = (t) => c.bw + (t < QD + 0.01 ? c.qd * 0.78 : 0) + (t > FC - 0.01 ? c.fc * 0.72 : 0) * smooth(FC - 0.01, FC + 0.03, t);
  const zOf = (t) => (t - 0.5) * c.L;
  const tOf = (z) => z / c.L + 0.5;
  /** Half-breadth at height y (tumblehome above 70 % of the side; the bulwark carries on in). */
  const xAt = (t, y) => {
    const k = keel(t), sh = sheer(t), hb = halfBeam(t);
    const u = (y - k) / Math.max(0.1, sh - k);
    const base = hb * Math.sqrt(Math.max(0, Math.sin(Math.min(1, Math.max(0, u)) * Math.PI / 2)));
    return base * (u > 0.7 ? 1 - (Math.min(u, 1.6) - 0.7) * 0.26 : 1);
  };
  return { halfBeam, keel, sheer, deck, bulwark, zOf, tOf, xAt, QD, FC };
}

// ---- Geometry helpers ----------------------------------------------------------------------------

const _c = new THREE.Color();
/** Strip a geometry to position/normal/uv, add a flat colour and extra float attributes. */
function prep(g, color, extra = {}) {
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  _c.set(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  for (const [name, [size, value]] of Object.entries(extra)) {
    const a = new Float32Array(n * size);
    for (let i = 0; i < n; i++) for (let j = 0; j < size; j++) a[i * size + j] = Array.isArray(value) ? value[j] : value;
    g.setAttribute(name, new THREE.Float32BufferAttribute(a, size));
  }
  return g;
}
/** A cylinder between two points. */
function rod(a, b, r0, r1 = r0, seg = 7) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
  const len = A.distanceTo(Bv);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), Bv.clone().sub(A).normalize());
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}
function box(w, h, d, x, y, z, ry = 0) { const g = new THREE.BoxGeometry(w, h, d); if (ry) g.rotateY(ry); g.translate(x, y, z); return g; }

// ---- The hull ------------------------------------------------------------------------------------

function hullGeometry(c, S) {
  const P = c.paint;
  const pos = [], uv = [], col = [], tile = [], idx = [];
  const tint = (hex) => new THREE.Color(hex);
  // Stations: even, plus breaks at the quarterdeck and forecastle steps.
  const N = 44;
  const ts = new Set();
  for (let i = 0; i <= N; i++) ts.add(+(i / N).toFixed(5));
  for (const b of [S.QD - 0.002, S.QD + 0.002, S.FC - 0.002, S.FC + 0.002]) ts.add(+b.toFixed(5));
  const T = [...ts].sort((a, b) => a - b);

  /** A band on both sides: y0(t)..y1(t) in `rows`, pushed out by `out`, with a tile (0 oak, 1 paint, 2 deck) and tint. */
  function band(y0, y1, rows, tileId, color, { out = 0, inner = false, xk = 1, cap = false } = {}) {
    const cc = tint(color);
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      for (const t of T) {
        const z = S.zOf(t);
        for (let r = 0; r <= rows; r++) {
          const k = r / rows;
          const y = lerp(y0(t), y1(t), k);
          let x;
          if (cap) x = lerp(S.xAt(t, y) + 0.02, S.xAt(t, y) * 0.9, k);
          else x = S.xAt(t, y) * xk + out * (S.halfBeam(t) / c.B);
          pos.push(x * side, y, z);
          uv.push(z / 2.4 + (tileId === 1 ? 0.37 : 0), cap ? x / 2.4 : y / 2.4);
          col.push(cc.r, cc.g, cc.b);
          tile.push(tileId);
        }
      }
      const R = rows + 1;
      for (let s = 0; s < T.length - 1; s++) for (let r = 0; r < rows; r++) {
        const a = base + s * R + r, b = a + R, d = a + 1, e = b + 1;
        const flip = (side > 0) !== inner;
        if (flip) idx.push(a, b, d, d, b, e); else idx.push(a, d, b, d, e, b);
      }
    }
  }
  const sheer = S.sheer, top = (t) => S.sheer(t) + S.bulwark(t);
  const gunY = (k) => (t) => sheer(t) - 1.0 - k * 1.75;
  let below = (t) => S.keel(t);
  // The bottom (copper / red-brown below the boot top).
  band(below, () => 0.12, 5, 0, P.bottom);
  below = () => 0.12;
  const nDecks = Math.max(1, c.decks || 1);
  for (let k = nDecks - 1; k >= 0; k--) {
    const g = gunY(k);
    const lo = (t) => Math.max(0.2, g(t) - 0.62);
    band(below, lo, 2, 0, P.oak);
    band(lo, (t) => Math.max(0.3, g(t) - 0.42), 1, 0, P.wale, { out: 0.09 });
    band((t) => Math.max(0.3, g(t) - 0.42), (t) => g(t) + 0.42, 2, 1, P.strake);
    below = (t) => g(t) + 0.42;
  }
  band(below, (t) => sheer(t) - 0.22, 2, 0, P.oak);
  band((t) => sheer(t) - 0.22, sheer, 1, P.sheerWale ? 1 : 0, P.sheerWale || P.wale, { out: 0.07 });
  band(sheer, top, 2, 1, P.upper);
  band(top, top, 1, 0, P.rail, { cap: true });
  band(top, (t) => S.deck(t), 1, 1, P.inner, { inner: true, xk: 0.9 });

  // The deck (deck tile), across between the inner bulwarks.
  {
    const cc = tint(P.deck);
    const base = pos.length / 3;
    for (const t of T) {
      const y = S.deck(t), z = S.zOf(t), x = S.xAt(t, y) * 0.9 + 0.02;
      pos.push(-x, y, z, x, y, z);
      uv.push(-x / 2.4, z / 2.4, x / 2.4, z / 2.4);
      col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
      tile.push(2, 2);
    }
    for (let s = 0; s < T.length - 1; s++) { const a = base + s * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  // The step bulkheads (quarterdeck break, forecastle break), painted like the inner bulwarks.
  for (const [t, up] of [[S.QD, true], [S.FC, false]]) {
    const cc = tint(P.inner);
    const z = S.zOf(t), y0 = sheer(t) - 0.05, y1 = y0 + (up ? c.qd : c.fc) * 0.72, x = S.xAt(t, top(t)) * 0.9;
    const base = pos.length / 3;
    pos.push(-x, y0, z, x, y0, z, -x, y1, z, x, y1, z);
    uv.push(0, 0, x, 0, 0, 1, x, 1);
    for (let i = 0; i < 4; i++) { col.push(cc.r, cc.g, cc.b); tile.push(1); }
    if (up) idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2); else idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  // The transom: a strip between the two sides' outlines at the stern, keel to the rail.
  {
    const t = 0, z = S.zOf(t), cc = tint(P.upper), cb = tint(P.bottom);
    const k = S.keel(t), tp = top(t);
    const rows = 10, base = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const y = lerp(k, tp, r / rows), x = S.xAt(t, y);
      const ccol = y < 0.12 ? cb : cc;
      pos.push(-x, y, z, x, y, z);
      uv.push(-x / 2.4, y / 2.4, x / 2.4, y / 2.4);
      col.push(ccol.r, ccol.g, ccol.b, ccol.r, ccol.g, ccol.b);
      tile.push(1, 1);
    }
    for (let r = 0; r < rows; r++) { const a = base + r * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("aTile", new THREE.Float32BufferAttribute(tile, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---- Guns ----------------------------------------------------------------------------------------

export function gunLayout(c, S) {
  const out = { port: [], starboard: [], bow: [] };
  const n = c.guns | 0;
  const decks = Math.max(1, c.decks || 1);
  for (let k = 0; k < decks; k++) {
    for (let i = 0; i < n; i++) {
      const z = lerp(-0.34 * c.L, 0.3 * c.L, n > 1 ? i / (n - 1) : 0.5);
      const t = S.tOf(z);
      const y = S.sheer(t) - 1.0 - k * 1.75;
      if (y < 0.6) continue;
      for (const side of [1, -1]) {
        const x = S.xAt(t, y) * side;
        (side > 0 ? out.port : out.starboard).push({ x, y, z, mx: x + 2.0 * side, side, order: n > 1 ? i / (n - 1) : 0.5, deck: k });
      }
    }
  }
  if (c.bowGun) out.bow.push({ x: 0, y: S.deck(0.94) + 0.55, z: c.L * 0.42, mx: 0, my: S.deck(0.94) + 0.55, mz: c.L * 0.42 + 1.4, side: 0, order: 0 });
  return out;
}

function gunsGeometry(c, S, guns) {
  const parts = [];
  for (const g of [...guns.port, ...guns.starboard]) {
    const s = g.side;
    const t = S.tOf(g.z);
    const xs = S.xAt(t, g.y) * s;
    const hinge = [xs + 0.06 * s, g.y + 0.38, g.z];
    // The dark port (static), a hair proud of the strake.
    const hole = new THREE.PlaneGeometry(0.8, 0.68);
    hole.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    hole.translate(xs + 0.045 * s, g.y, g.z);
    parts.push(prep(hole, "#0a0706", { aGun: [4, [s, 0, g.order, 0]], aPivot: [3, hinge] }));
    // The lid (outside black, a red inside face), hinged at the top.
    const lid = new THREE.BoxGeometry(0.1, 0.78, 0.9);
    lid.translate(xs + 0.07 * s, g.y, g.z);
    parts.push(prep(lid, c.paint.wale, { aGun: [4, [s, 1, g.order, 0]], aPivot: [3, hinge] }));
    const lidIn = new THREE.PlaneGeometry(0.84, 0.72);
    lidIn.rotateY(s > 0 ? -Math.PI / 2 : Math.PI / 2);
    lidIn.translate(xs + 0.015 * s, g.y, g.z);
    parts.push(prep(lidIn, "#7a1e16", { aGun: [4, [s, 1, g.order, 0]], aPivot: [3, hinge] }));
    // The barrel: in its port at rest, the muzzle at the hull; runs out ~1 m.
    const len = c.L > 50 ? 2.2 : c.L > 35 ? 1.9 : 1.6, r = c.L > 50 ? 0.2 : 0.17;
    const bar = new THREE.CylinderGeometry(r * 1.25, r, len, 9, 1);
    bar.rotateZ(s > 0 ? -Math.PI / 2 : Math.PI / 2);
    bar.translate(xs - (len / 2 + 0.05) * s, g.y - 0.05, g.z);
    parts.push(prep(bar, "#1a1918", { aGun: [4, [s, 2, g.order, 0]], aPivot: [3, hinge] }));
    const lip = new THREE.TorusGeometry(r * 1.05, r * 0.28, 5, 10);
    lip.rotateY(Math.PI / 2);
    lip.translate(xs - 0.05 * s, g.y - 0.05, g.z);
    parts.push(prep(lip, "#1a1918", { aGun: [4, [s, 2, g.order, 0]], aPivot: [3, hinge] }));
  }
  for (const g of guns.bow) {
    const bar = rod([0, g.y, g.z - 0.6], [0, g.y + 0.05, g.z + 1.3], 0.2, 0.15, 9);
    parts.push(prep(bar, "#1a1918", { aGun: [4, [0, 3, 0, 0]], aPivot: [3, [0, g.y, g.z]] }));
    const car = box(0.8, 0.4, 1.2, 0, g.y - 0.32, g.z - 0.3);
    parts.push(prep(car, "#4a2f18", { aGun: [4, [0, 3, 0, 0]], aPivot: [3, [0, g.y, g.z]] }));
  }
  if (!parts.length) parts.push(prep(new THREE.PlaneGeometry(0.001, 0.001), "#000", { aGun: [4, [0, 0, 0, 0]], aPivot: [3, [0, 0, 0]] }));
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

/** Quads in each gun port, facing out (aSide +1 port, −1 starboard; aSeed): the ports-open telegraph's glow. */
function portGlowGeometry(S, guns) {
  const parts = [];
  for (const g of [...guns.port, ...guns.starboard]) {
    const q = new THREE.PlaneGeometry(0.74, 0.62);
    q.rotateY(g.side > 0 ? Math.PI / 2 : -Math.PI / 2);
    q.translate(g.x + 0.12 * g.side, g.y, g.z);
    const n = q.attributes.position.count;
    q.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array(n).fill(g.side), 1));
    q.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(n).fill(Math.abs(Math.sin(g.z * 12.9898)) % 1), 1));
    parts.push(q);
  }
  if (!parts.length) {
    const q = new THREE.PlaneGeometry(0.001, 0.001);
    q.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array(4), 1));
    q.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(4), 1));
    parts.push(q);
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

// ---- Masts, yards and the rig --------------------------------------------------------------------

/** The masts: {i, z, base (deck), h, r, yards:[{y, w}], top, cross} and the bowsprit's line. */
export function mastPlan(c, S) {
  const main = Math.max(...c.masts.map((m) => m.h));
  const list = c.masts.map((m, i) => {
    const z = S.zOf(m.t), base = S.deck(m.t);
    const r = 0.16 + m.h * 0.0095;
    const k = m.h / main;
    const w0 = c.B * 2 * 1.95 * (0.72 + 0.28 * k);
    const fr = [0.4, 0.64, 0.84, 0.97].slice(0, Math.min(4, Math.max(2, c.tiers || 3)));
    const ws = [w0, w0 * 0.76, w0 * 0.54, w0 * 0.38];
    // A lateen rig carries no square yards: one long slanted yard (rigGeometry / sailGeometry draw it).
    const yards = c.lateen ? [] : fr.map((f, j) => ({ y: base + m.h * f, w: ws[j] }));
    const lateen = c.lateen ? { tack: [0, base + 1.1, z + c.L * 0.36], peak: [0, base + m.h * 1.08, z - c.L * 0.4], clew: [0, base + 1.7, z - c.L * 0.36], sling: [0, base + m.h * 0.62, z] } : null;
    return { i, z, t: m.t, base, h: m.h, r, yards, lateen, w0, top: base + m.h * 0.42, cross: base + m.h * 0.7, mizzen: i === 0 && c.masts.length >= 3 };
  });
  const bowY = S.deck(1) + 0.4, bowZ = c.L / 2 - 0.3;
  const bl = c.L * 0.36, ang = 20 * Math.PI / 180;
  const tip = [0, bowY + Math.sin(ang) * bl, bowZ + Math.cos(ang) * bl];
  return { list, bowsprit: { from: [0, bowY, bowZ - 1.5], to: tip, len: bl, ang } };
}

function rigGeometry(c, S, guns, plan) {
  const parts = [];
  const P = c.paint;
  const SPAR = c.eerie ? "#1c1f1f" : "#4a3220", DARK = c.eerie ? "#0e1010" : "#2a1c12", IRON = "#161616";
  const GILT = c.gilt ? "#e0b84a" : "#b8923a";
  const add = (g, color, mast = -1, glow = 0) => parts.push(prep(g, color, { aMast: [1, mast], aGlow: [1, glow] }));
  // Masts in three doublings, tops, crosstrees, caps, the crow's nest, yards.
  for (const m of plan.list) {
    const { z, base, h, r } = m;
    add(rod([0, base - 0.4, z], [0, base + h * 0.45, z], r, r * 0.86, 9), SPAR, m.i);
    add(rod([0, base + h * 0.39, z + r * 1.6], [0, base + h * 0.74, z + r * 1.6], r * 0.68, r * 0.55, 8), SPAR, m.i);
    add(rod([0, base + h * 0.69, z + r * 2.4], [0, base + h, z + r * 2.4], r * 0.42, r * 0.28, 7), SPAR, m.i);
    add(box(r * 2.2, h * 0.07, r * 4.2, 0, base + h * 0.43, z + r * 0.8), DARK, m.i);           // the lower cap / doubling
    const tw = m.w0 * 0.17;
    if (m.lateen) {
      // The lateen yard: one long spar slung from the masthead, low forward, high aft (two pieces fished together).
      const L = m.lateen;
      add(rod(L.tack, L.sling, 0.1, 0.13, 7), SPAR, m.i);
      add(rod(L.sling, L.peak, 0.13, 0.06, 7), SPAR, m.i);
    } else add(box(tw, 0.16, tw * 0.85, 0, m.top + 0.35, z + r), DARK, m.i);                    // the top
    add(box(tw * 0.62, 0.1, 0.14, 0, m.cross, z + r * 2), DARK, m.i);                          // crosstrees
    add(box(0.14, 0.1, tw * 0.5, 0, m.cross, z + r * 2), DARK, m.i);
    add(new THREE.SphereGeometry(r * 0.5, 8, 6).translate(0, base + h + 0.1, z + r * 2.4), DARK, m.i);   // the truck
    if (c.nest && m.h === Math.max(...plan.list.map((q) => q.h))) {
      const nest = new THREE.CylinderGeometry(0.85, 0.75, 1.1, 12, 1, true);
      nest.translate(0, m.cross + 0.6, z + r * 2);
      add(nest, "#3a2818", m.i);
      add(new THREE.CylinderGeometry(0.85, 0.85, 0.08, 12).translate(0, m.cross + 0.1, z + r * 2), DARK, m.i);
    }
    m.yards.forEach((yd, j) => {
      const w = yd.w;
      const yz = z + r * (j === 0 ? 1.2 : j === 1 ? 2 : 2.8) + 0.25;
      add(rod([-w / 2, yd.y, yz], [0, yd.y, yz], 0.06 + w * 0.004, 0.08 + w * 0.007, 6), SPAR, m.i);
      add(rod([0, yd.y, yz], [w / 2, yd.y, yz], 0.08 + w * 0.007, 0.06 + w * 0.004, 6), SPAR, m.i);
    });
    // Channels (where the shrouds come down), outboard at the sheer.
    for (const side of [1, -1]) {
      const t = m.t, y = S.sheer(t) + 0.15, x = S.xAt(t, y) * side;
      add(box(0.55, 0.12, Math.min(5, c.L * 0.12), x + 0.22 * side, y, z - 0.6), DARK, -1);
    }
  }
  // The spanker's gaff and boom on the aftmost mast (three-masted ships and the gunboat's single).
  {
    const m = plan.list[0];
    if (!c.lateen && (plan.list.length >= 2 || c.L < 20)) {
      const gy = m.base + m.h * 0.38, by = m.base + 2.2;
      const len = Math.min(c.L * 0.32, 14);
      add(rod([0, gy, m.z - 0.3], [0, gy + len * 0.25, m.z - len], 0.07, 0.05, 6), SPAR, m.i);
      add(rod([0, by, m.z - 0.3], [0, by + 0.1, m.z - len * 1.05], 0.09, 0.06, 6), SPAR, -1);
    }
  }
  // The bowsprit and jibboom; the stem and its cutwater; the figurehead.
  const bp = plan.bowsprit;
  add(rod(bp.from, bp.to, 0.12 + c.B * 0.03, 0.08 + c.B * 0.012, 8), SPAR);
  {
    const dir = new THREE.Vector3(0, Math.sin(bp.ang), Math.cos(bp.ang));
    const jb = new THREE.Vector3(...bp.to).addScaledVector(dir, bp.len * 0.45);
    add(rod([0, bp.to[1] - 0.15, bp.to[2] - bp.len * 0.25], jb.toArray(), 0.08, 0.05, 6), SPAR);
    add(rod([0, bp.to[1] - 0.2, bp.to[2] - 0.6], [0, bp.to[1] - 3.2, bp.to[2] - 1.6], 0.05, 0.05, 5), SPAR);   // dolphin striker
  }
  {
    const zs = c.L / 2;
    const stem = new THREE.BoxGeometry(0.22, S.deck(1) + c.D + 0.6, 1.2);
    stem.translate(0, (S.deck(1) - c.D * 0.6) / 2, zs - 0.15);
    add(stem, P.wale);
    if (c.figure) {
      const fy = S.sheer(0.99) - 0.2, fz = zs + 0.75;
      const torso = new THREE.CapsuleGeometry(0.28 * (c.L / 40 + 0.5), 0.9 * (c.L / 40 + 0.5), 4, 8);
      torso.rotateX(0.75); torso.translate(0, fy, fz);
      add(torso, c.figure);
      add(new THREE.SphereGeometry(0.24 * (c.L / 40 + 0.5), 10, 8).translate(0, fy + 0.55 * (c.L / 40 + 0.5), fz + 0.45 * (c.L / 40 + 0.5)), c.figure);
      const wing = new THREE.ConeGeometry(0.35, 1.3, 4);
      for (const s of [1, -1]) { const w = wing.clone(); w.rotateZ(s * 1.1); w.rotateX(0.5); w.translate(s * 0.45, fy + 0.2, fz - 0.15); add(w, c.figure); }
      wing.dispose();
      // The head rails (gilt scroll lines from the cutwater to the bow).
      for (const s of [1, -1]) add(rod([s * 0.15, fy - 0.5, fz - 0.2], [s * S.xAt(0.93, S.sheer(0.93)) * 0.95, S.sheer(0.93) - 0.3, S.zOf(0.93)], 0.05, 0.05, 5), GILT);
    }
  }
  // Rails: posts and a top rail along the quarterdeck and forecastle bulwarks; the breaks' rails across.
  const rail = (t0, t1, n, side) => {
    for (let i = 0; i <= n; i++) {
      const t = lerp(t0, t1, i / n), y = S.sheer(t) + S.bulwark(t), x = S.xAt(t, y) * 0.95 * side;
      add(box(0.09, 0.62, 0.09, x, y + 0.31, S.zOf(t)), P.rail);
    }
    const a = [S.xAt(t0, S.sheer(t0) + S.bulwark(t0)) * 0.95 * side, S.sheer(t0) + S.bulwark(t0) + 0.64, S.zOf(t0)];
    const b = [S.xAt(t1, S.sheer(t1) + S.bulwark(t1)) * 0.95 * side, S.sheer(t1) + S.bulwark(t1) + 0.64, S.zOf(t1)];
    add(rod(a, b, 0.06, 0.06, 5), P.rail);
  };
  for (const side of [1, -1]) {
    rail(0.02, S.QD - 0.01, Math.round(c.L * 0.06) + 2, side);
    if (c.fc > 0.5) rail(S.FC + 0.02, 0.95, Math.round(c.L * 0.03) + 2, side);
  }
  for (const [t, h] of [[S.QD + 0.004, c.qd * 0.78], [S.FC - 0.004, c.fc * 0.72]]) {
    const y = S.deck(t + (t < 0.5 ? -0.01 : 0.01)), x = S.xAt(t, S.sheer(t) + S.bulwark(t)) * 0.86;
    const n = Math.max(4, Math.round(x * 2.2));
    for (let i = 0; i <= n; i++) add(box(0.08, 0.7, 0.08, lerp(-x, x, i / n), y + 0.35, S.zOf(t)), "#d8cbb0");
    add(rod([-x, y + 0.72, S.zOf(t)], [x, y + 0.72, S.zOf(t)], 0.06, 0.06, 5), P.rail);
    if (h < 0.3) continue;
  }
  // The helm: wheel, binnacle; a capstan, hatches with gratings, the boat, cargo or fire barrels.
  {
    const t = 0.11, y = S.deck(t), z = S.zOf(t);
    const wheel = new THREE.TorusGeometry(0.62, 0.05, 5, 18); wheel.translate(0, y + 1.1, z);
    add(wheel, "#5a3a20");
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; add(rod([0, y + 1.1, z], [Math.cos(a) * 0.78, y + 1.1 + Math.sin(a) * 0.78, z], 0.025, 0.025, 4), "#5a3a20"); }
    add(box(0.5, 1.0, 0.25, 0, y + 0.5, z - 0.25), DARK);
    add(box(0.45, 0.9, 0.45, 0, y + 0.45, z + 1.4), "#5a3a20");
    add(new THREE.SphereGeometry(0.2, 8, 6).translate(0, y + 1.0, z + 1.4), "#c9a227");
  }
  {
    const t = 0.6, y = S.deck(t);
    add(new THREE.CylinderGeometry(0.42, 0.55, 1.0, 12).translate(0, y + 0.5, S.zOf(t)), "#5a3a20");
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI; add(rod([Math.cos(a) * 1.4, y + 0.9, S.zOf(t) + Math.sin(a) * 1.4], [-Math.cos(a) * 1.4, y + 0.9, S.zOf(t) - Math.sin(a) * 1.4], 0.04, 0.04, 4), "#6a4a28"); }
  }
  for (const t of [0.42, 0.66]) {
    const y = S.deck(t), z = S.zOf(t), w = Math.min(c.B * 0.55, 3.2), d = Math.min(c.L * 0.06, 3);
    add(box(w + 0.2, 0.32, d + 0.2, 0, y + 0.16, z), "#5a3d22");
    add(box(w, 0.04, d, 0, y + 0.34, z), "#1a120c");
    for (let i = 1; i < 6; i++) add(box(0.05, 0.05, d, lerp(-w / 2, w / 2, i / 6), y + 0.36, z), "#6a4a2c");
  }
  if (c.boat) {
    const t = 0.52, y = S.deck(t) + 0.9, z = S.zOf(t) + 1, bl = Math.min(7, c.L * 0.16);
    const hull = new THREE.CapsuleGeometry(0.75, bl - 1.5, 4, 10); hull.rotateX(Math.PI / 2); hull.scale(1, 0.55, 1); hull.translate(0, y, z);
    add(hull, "#e8e0cc");
    add(box(1.3, 0.08, bl - 0.6, 0, y + 0.4, z), "#5a3d22");
    for (const s of [1, -1]) add(box(0.2, 0.9, 0.2, s * 0.9, y - 0.45, z), DARK);
  }
  const rnd = mulberry(Math.round(c.L * 1000 + c.B * 7));
  if (c.cargo) {
    for (let i = 0; i < 12; i++) {
      const s = 0.7 + rnd() * 0.45, t = 0.3 + rnd() * 0.36, x = (rnd() - 0.5) * c.B * 1.1;
      add(box(s, s, s, x, S.deck(t) + s / 2, S.zOf(t), rnd() * 0.6), rnd() < 0.5 ? "#7a5634" : "#6b4a2a");
    }
    for (let i = 0; i < 6; i++) { const t = 0.48 + rnd() * 0.12; add(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 10).translate((rnd() - 0.5) * c.B, S.deck(t) + 0.45, S.zOf(t)), "#5a3a1e"); }
  }
  if (c.barrels) {
    for (let i = 0; i < 18; i++) {
      const t = 0.22 + rnd() * 0.6;
      add(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 10).translate((rnd() - 0.5) * c.B * 1.2, S.deck(t) + 0.45, S.zOf(t)), "#4a2c18");
    }
  }
  // The stern: window frames and lit panes (aGlow), the gallery's walkway and balusters, the taffrail lanterns.
  if (c.windows) {
    const t = 0, z = S.zOf(t) - 0.04, yTop = S.sheer(t) + S.bulwark(t);
    const rows = c.windows;
    for (let r = 0; r < rows; r++) {
      const y = yTop - 0.8 - r * 1.35;
      if (y < 0.8) continue;
      const half = S.xAt(t, y) * 0.78, n = Math.max(3, Math.round(half * 1.4));
      for (let i = 0; i < n; i++) {
        const x = lerp(-half, half, (i + 0.5) / n), w = (2 * half) / n * 0.62;
        add(box(w + 0.16, 0.86, 0.06, x, y, z - 0.02), c.gilt ? GILT : P.rail);
        const pane = new THREE.PlaneGeometry(w, 0.7); pane.rotateY(Math.PI); pane.translate(x, y, z - 0.07);
        add(pane, "#ffcf8a", -1, 1);
      }
      if (c.gallery) {
        const xw = S.xAt(t, y - 0.5) * 0.98;
        add(box(xw * 2, 0.12, 0.9, 0, y - 0.55, z - 0.45), DARK);
        const nb = Math.round(xw * 3);
        for (let i = 0; i <= nb; i++) add(box(0.06, 0.55, 0.06, lerp(-xw, xw, i / nb), y - 0.24, z - 0.85), c.gilt ? GILT : "#d8cbb0");
        add(rod([-xw, y + 0.05, z - 0.85], [xw, y + 0.05, z - 0.85], 0.045, 0.045, 5), P.rail);
      }
    }
    // A carved, gilt taffrail band.
    add(box(S.xAt(0, yTop) * 1.7, 0.3, 0.12, 0, yTop - 0.15, z - 0.05), GILT);
    if (c.gilt) {
      // The flagship's stern: gilt pilasters between the lights, a carved crest over the taffrail, a gilt
      // band at every gallery, a lantern-lit cove under the counter.
      const half = S.xAt(t, yTop - 1) * 0.92;
      for (let i = 0; i <= 6; i++) add(box(0.16, rows * 1.35 + 0.4, 0.14, lerp(-half, half, i / 6), yTop - 0.4 - rows * 0.68, z - 0.1), GILT);
      const crest = new THREE.CylinderGeometry(1.25, 1.25, 0.2, 18, 1, false, 0, Math.PI);
      crest.rotateX(Math.PI / 2); crest.rotateZ(Math.PI / 2); crest.translate(0, yTop - 0.1, z - 0.12);
      add(crest, GILT);
      for (const s of [1, -1]) add(new THREE.SphereGeometry(0.35, 10, 8).translate(s * half * 0.95, yTop + 0.25, z - 0.1), GILT);
      for (let r = 0; r < rows; r++) add(box(half * 2.1, 0.14, 0.18, 0, yTop - 1.35 - r * 1.35, z - 0.1), GILT);
    }
    if (c.quarter) {
      // Quarter galleries: a bay window on each quarter, two tiers of lights, a gilt (or dark) frame.
      for (const s of [1, -1]) {
        const tq = 0.06, yq = yTop - 1.5, xq = S.xAt(tq, yq) * s;
        for (let r = 0; r < Math.min(2, rows); r++) {
          const y = yq - r * 1.25;
          add(box(0.7, 1.15, 3.0, xq + 0.32 * s, y, S.zOf(tq)), c.gilt ? GILT : P.upper);
          for (let k = 0; k < 3; k++) {
            const pane = new THREE.PlaneGeometry(0.6, 0.62);
            pane.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
            pane.translate(xq + 0.68 * s, y + 0.05, S.zOf(tq) + (k - 1) * 0.85);
            add(pane, "#ffcf8a", -1, 1);
          }
        }
        add(new THREE.ConeGeometry(0.55, 1.1, 8).rotateX(Math.PI).translate(xq + 0.32 * s, yq - Math.min(2, rows) * 1.25 + 0.05, S.zOf(tq)), c.gilt ? GILT : DARK);
      }
    }
  }
  // The lantern bodies at the lamp spots (glass lit by night).
  for (const [x, y, tz] of c.lamps || []) {
    const t = clamp(tz, 0.005, 0.995), yy = S.sheer(t) + S.bulwark(t) + y * 0.4, z = S.zOf(t) + (tz < 0.5 ? -0.6 : 0.6);
    add(new THREE.CylinderGeometry(0.2, 0.17, 0.5, 8).translate(x, yy + 0.25, z), "#ffcf8a", -1, 1);
    add(new THREE.ConeGeometry(0.26, 0.32, 8).translate(x, yy + 0.66, z), IRON);
    add(rod([x, yy - 0.6, z - (tz < 0.5 ? -0.5 : 0.5)], [x, yy, z], 0.04, 0.04, 4), IRON);
  }
  // The masthead lantern (lit by night: the fleet's lamp glow rides K.lamps' last entry).
  {
    const mh = mastheadLamp(plan);
    add(new THREE.CylinderGeometry(0.18, 0.15, 0.42, 8).translate(mh[0], mh[1], mh[2]), "#ffcf8a", -1, 1);
    add(new THREE.ConeGeometry(0.22, 0.26, 8).translate(mh[0], mh[1] + 0.34, mh[2]), IRON);
  }
  // The ensign's flagstaff over the taffrail.
  {
    const y0 = S.sheer(0) + S.bulwark(0), z = S.zOf(0) - 0.3;
    add(rod([0, y0 - 0.5, z + 0.4], [0, y0 + Math.max(3, c.L * 0.1) * Math.max(1, Math.sqrt(c.flagScale || 1)), z - 0.6], 0.06 * (c.flagScale > 1.5 ? 1.6 : 1), 0.04, 5), SPAR);
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

/** The masthead lantern's spot (ship frame): just under the truck of the tallest mast. */
function mastheadLamp(plan) {
  const main = plan.list.reduce((a, b) => (b.h > a.h ? b : a), plan.list[0]);
  return main ? [0, main.base + main.h * (main.lateen ? 0.97 : 0.9), main.z + main.r * 2.4 + 0.35] : [0, 8, 0];
}

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- Sails ---------------------------------------------------------------------------------------

/**
 * The sails of a plan (shared by the fleet's classes and the Rexmaw's own set in sails.js).
 * aSail = (u, v, bulge m, height m); aSailB = (tier: 0 course, 1 top, 2 t'gallant, 3 royal, 4 fore-and-aft; kind 0 square / 1 fore-and-aft; mast index).
 * `opts.courseFoot(m)` gives a course's foot height; `opts.skipCourse(m)`.
 */
export function sailGeometry(plan, { courseFoot, skipCourse = () => false, jibs = 2, spanker = true, bulge = 0.13, scaleW = 0.95, foreStay = null } = {}) {
  const parts = [];
  const quad = (wTop, wBot, h, y, z, tier, mast, segX = 10, segY = 8) => {
    const g = new THREE.PlaneGeometry(1, 1, segX, segY);
    const p = g.attributes.position, uv = g.attributes.uv;
    const n = p.count;
    const aS = new Float32Array(n * 4), aB = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const w = lerp(wBot, wTop, v);
      p.setXYZ(i, (u - 0.5) * w, y - h + v * h, z);
      uv.setXY(i, (u - 0.5) * w / 6, v * h / 6);
      aS.set([u, v, Math.min(2.4, Math.max(wTop, wBot) * bulge), h], i * 4);
      aB.set([tier, 0, mast, Math.max(wTop, wBot) / Math.max(0.5, h)], i * 4);
    }
    g.setAttribute("aSail", new THREE.BufferAttribute(aS, 4));
    g.setAttribute("aSailB", new THREE.BufferAttribute(aB, 4));
    g.computeVertexNormals();
    parts.push(g);
  };
  for (const m of plan.list) {
    if (m.lateen) continue;            // drawn below, once tri() exists
    const ys = m.yards;
    const z = m.z + m.r * 1.2 + 0.45;
    // Course (skipped on the mizzen of a three-master: the spanker takes its place).
    if (!skipCourse(m)) {
      const foot = courseFoot ? courseFoot(m) : m.base + 2.2;
      const h = ys[0].y - 0.15 - foot;
      if (h > 1) quad(ys[0].w * scaleW, ys[0].w * (scaleW + 0.03), h, ys[0].y - 0.15, z, 0, m.i);
    }
    for (let j = 1; j < ys.length; j++) {
      const top = ys[j].y - 0.12, bot = ys[j - 1].y + 0.25, h = top - bot;
      const zj = m.z + m.r * (j === 1 ? 2 : 2.8) + 0.45;
      if (h > 0.8) quad(ys[j].w * scaleW, ys[j - 1].w * (scaleW - 0.03), h, top, zj, j, m.i, 10, 7);
    }
  }
  // Fore-and-aft: jibs on the forestay, the spanker abaft the aftmost mast.
  const tri = (a, b, c3, tier, mast, flip = false) => {
    // a: head, b: tack, c: clew. u along the foot (tack→clew), v up to the head.
    const g = new THREE.BufferGeometry();
    const S = 7, verts = [], uvs = [], aS = [], aB = [], idx = [];
    const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b), C = new THREE.Vector3(...c3);
    const w = Bv.distanceTo(C), h = A.distanceTo(Bv);
    for (let j = 0; j <= S; j++) {
      const v = j / S;
      for (let i = 0; i <= S - j; i++) {
        const u = S - j > 0 ? i / (S - j) : 0;
        const foot = new THREE.Vector3().lerpVectors(Bv, C, u);
        const p = new THREE.Vector3().lerpVectors(foot, A, v);
        verts.push(p.x, p.y, p.z);
        uvs.push(u * w / 6, v * h / 6);
        aS.push(u, v, Math.min(1.4, w * 0.12), h);
        aB.push(tier, 1, mast, w / Math.max(0.5, h));
      }
    }
    let k = 0;
    const row = [];
    for (let j = 0; j <= S; j++) { row.push(k); k += S - j + 1; }
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S - j; i++) {
        const a0 = row[j] + i, a1 = a0 + 1, b0 = row[j + 1] + i, b1 = b0 + 1;
        if (flip) idx.push(a0, b0, a1); else idx.push(a0, a1, b0);
        if (i < S - j - 1) { if (flip) idx.push(a1, b0, b1); else idx.push(a1, b1, b0); }
      }
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute("aSail", new THREE.Float32BufferAttribute(aS, 4));
    g.setAttribute("aSailB", new THREE.Float32BufferAttribute(aB, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  };
  // The lateen: one big triangle under the slanted yard (peak aft and high, tack forward, clew aft and low).
  for (const m of plan.list) if (m.lateen) tri(m.lateen.peak, m.lateen.tack, m.lateen.clew, 4, m.i);
  const fore = plan.list[plan.list.length - 1];
  const bp = plan.bowsprit;
  if (jibs > 0 && fore && fore.yards.length) {
    const head = foreStay || [0, fore.yards[Math.min(1, fore.yards.length - 1)].y, fore.z + 0.4];
    const tip = bp.to;
    const dir = new THREE.Vector3(0, Math.sin(bp.ang), Math.cos(bp.ang));
    for (let k = 0; k < jibs; k++) {
      const tack = new THREE.Vector3(...tip).addScaledVector(dir, k * bp.len * 0.35 - bp.len * 0.1);
      const hd = new THREE.Vector3(...head).lerp(new THREE.Vector3(...tip), 0.08 + k * 0.05);
      hd.y = head[1] + k * 2.2;
      const clew = new THREE.Vector3(0, Math.max(fore.base + 2.2, tack.y - 2.2 - k * 0.6), lerp(tack.z, fore.z, 0.55 - k * 0.1));
      tri(hd.toArray(), tack.toArray(), clew.toArray(), 4, -1);
    }
  }
  if (spanker && plan.list.length >= 2) {
    const m = plan.list[0];
    const gy = m.base + m.h * 0.38, by = m.base + 2.4, len = Math.min(plan.list.length >= 3 ? 14 : 10, m.h * 0.4);
    // A gaff sail: two triangles (luff on the mast, head along the gaff, foot along the boom).
    tri([0, gy + len * 0.22, m.z - len * 0.9], [0, by, m.z - 0.4], [0, by, m.z - len], 4, m.i);
    tri([0, gy, m.z - 0.4], [0, by, m.z - 0.4], [0, gy + len * 0.22, m.z - len * 0.9], 4, m.i, true);
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

// ---- Ropes ---------------------------------------------------------------------------------------

function ropeGeometry(c, S, plan) {
  const v = [], mast = [];
  const seg = (a, b, m = -1) => { v.push(a[0], a[1], a[2], b[0], b[1], b[2]); mast.push(m, m); };
  for (const m of plan.list) {
    const { z, r } = m;
    for (const side of [1, -1]) {
      // Lower shrouds from the top to the channel, ratlines across them every 0.55 m.
      const n = c.L > 35 ? 5 : 4;
      const feet = [];
      for (let k = 0; k < n; k++) {
        const t = m.t - (k - 0.5) * 0.022, y = S.sheer(t) + 0.2;
        feet.push([S.xAt(t, y) * side + 0.45 * side, y, S.zOf(t) - 0.6]);
      }
      const head = [side * r * 1.3, m.top + 0.3, z + r];
      for (const f of feet) seg(head, f, m.i);
      const h = head[1] - feet[0][1];
      for (let y = 0.55; y < h - 1.2; y += 0.55) {
        const k = y / h;
        for (let s = 0; s < feet.length - 1; s++) {
          const a = feet[s].map((q, i) => lerp(q, head[i], k)), b = feet[s + 1].map((q, i) => lerp(q, head[i], k));
          seg(a, b, m.i);
        }
      }
      // Topmast shrouds from the crosstrees to the top's rim, their ratlines; a backstay to the hull.
      const tw = m.w0 * 0.085;
      const th = [side * r * 0.8, m.cross, z + r * 2], tfeet = [[side * tw, m.top + 0.4, z + r - 0.4], [side * tw, m.top + 0.4, z + r + 0.6]];
      for (const f of tfeet) seg(th, f, m.i);
      for (let y = 0.5; y < th[1] - tfeet[0][1] - 0.6; y += 0.5) {
        const k = y / (th[1] - tfeet[0][1]);
        seg(tfeet[0].map((q, i) => lerp(q, th[i], k)), tfeet[1].map((q, i) => lerp(q, th[i], k)), m.i);
      }
      const bt = m.t - 0.09, by = S.sheer(bt) + 0.3;
      seg([side * r * 0.5, m.base + m.h * 0.92, z + r * 2.4], [S.xAt(bt, by) * side, by, S.zOf(bt)], m.i);
      // Braces off the yardarms aft, lifts to the mast.
      for (const yd of m.yards) {
        const arm = [side * yd.w / 2, yd.y, z + 0.5];
        seg(arm, [side * r, yd.y + yd.w * 0.18, z + r], m.i);
        const ft = clamp(m.t - 0.12, 0.02, 1), fy = S.sheer(ft) + S.bulwark(ft);
        seg(arm, [S.xAt(ft, fy) * side * 0.9, fy, S.zOf(ft)], m.i);
      }
    }
  }
  // Stays: each masthead forward to the next mast (or the bowsprit), and the forestays.
  for (let i = 0; i < plan.list.length; i++) {
    const m = plan.list[i], next = plan.list[i + 1];
    const from = [0, m.top + 0.2, m.z + m.r], from2 = [0, m.cross + 0.3, m.z + m.r * 2];
    if (next) {
      seg(from, [0, next.base + 0.4, next.z - 0.3], m.i);
      seg(from2, [0, next.top + 0.3, next.z], m.i);
    } else {
      seg(from, [0, plan.bowsprit.from[1] + 0.5, plan.bowsprit.from[2] + 1.2], m.i);
      seg(from2, plan.bowsprit.to, m.i);
      seg([0, m.base + m.h * 0.95, m.z + m.r * 2.4], [0, plan.bowsprit.to[1] + 1.2, plan.bowsprit.to[2] + plan.bowsprit.len * 0.4], m.i);
    }
  }
  // The bobstay and bowsprit shrouds.
  const bp = plan.bowsprit;
  seg([0, bp.to[1] - 3.2, bp.to[2] - 1.6], [0, bp.to[1] + 0.05, bp.to[2] + bp.len * 0.4]);
  seg([0, bp.to[1] - 3.2, bp.to[2] - 1.6], [0, -0.2, c.L / 2 - 0.2]);
  for (const s of [1, -1]) seg([0, bp.to[1] - 0.1, bp.to[2] - 0.4], [s * S.xAt(0.95, S.sheer(0.95)) * 0.9, S.sheer(0.95), S.zOf(0.95)]);
  // A lateen's gear: the halyard to the masthead, the tack lashed down at the stem, the sheet aft.
  for (const m of plan.list) {
    if (!m.lateen) continue;
    const L = m.lateen;
    seg(L.sling, [0, m.base + m.h, m.z], m.i);
    seg(L.tack, [0, S.deck(0.97) + 0.3, S.zOf(0.97)], m.i);
    seg(L.clew, [0, S.deck(0.05) + 0.8, S.zOf(0.05)], m.i);
    for (const s of [1, -1]) seg(L.peak, [s * S.xAt(0.1, S.sheer(0.1)), S.sheer(0.1) + 0.4, S.zOf(0.1)], m.i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute("aMast", new THREE.Float32BufferAttribute(mast, 1));
  return g;
}

// ---- Flags ---------------------------------------------------------------------------------------

/** The ensign at the flagstaff, a pennant at the main truck; aFlag = (pivot x, y, z, length) for the wave; aWhite = the white cell's uv. */
function flagGeometry(c, S, plan, kind) {
  const T = shipTextures();
  const parts = [];
  const make = (w, h, pivot, rect, white, pennant = false) => {
    const g = new THREE.PlaneGeometry(w, h, 14, 4);
    const p = g.attributes.position, uv = g.attributes.uv, n = p.count;
    const aF = new Float32Array(n * 4), aW = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      let x = u * w, y = (v - 0.5) * h;
      if (pennant) y *= 1 - u * 0.85;
      p.setXYZ(i, pivot[0], pivot[1] + y, pivot[2] - x);            // streams aft (−Z) at rest; the shader turns it downwind
      uv.setXY(i, lerp(rect.u0, rect.u1, u), lerp(rect.v0, rect.v1, v));
      aF.set([pivot[0], pivot[1], pivot[2], w], i * 4);
      aW.set([lerp(white.u0, white.u1, u), lerp(white.v0, white.v1, v)], i * 2);
    }
    g.setAttribute("aFlag", new THREE.BufferAttribute(aF, 4));
    g.setAttribute("aWhite", new THREE.BufferAttribute(aW, 2));
    g.computeVertexNormals();
    parts.push(g);
  };
  const white = T.flagRect("white");
  const fw = clamp(c.L * 0.12, 2.2, 7) * (c.flagScale || 1);
  const y0 = S.sheer(0) + S.bulwark(0), top = y0 + Math.max(3, c.L * 0.1) * Math.max(1, Math.sqrt(c.flagScale || 1));
  if (kind) make(fw, fw * 0.6, [0, top - fw * 0.3, S.zOf(0) - 0.9], T.flagRect(kind), white);
  const main = plan.list.reduce((a, b) => (b.h > a.h ? b : a), plan.list[0]);
  const pw = clamp(c.L * 0.12, 2.2, 7) * Math.sqrt(c.flagScale || 1);
  if (main) make(pw * 1.6, pw * 0.22, [0, main.base + main.h + 0.2, main.z + main.r * 2.4], T.flagRect(kind === "gloam" ? "gloam" : "pennant"), white, true);
  if (!parts.length) parts.push(new THREE.PlaneGeometry(0.001, 0.001));
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

// ---- Per class -----------------------------------------------------------------------------------

/** Everything shared by the ships of one class. */
export function buildClass(key) {
  const c = CLASSES[key];
  const S = shape(c);
  const guns = gunLayout(c, S);
  const plan = mastPlan(c, S);
  const fore = plan.list[plan.list.length - 1];
  const sails = sailGeometry(plan, {
    courseFoot: (m) => S.deck(m.t) + 2.2 + (m.t > 0.8 ? 1 : 0),
    skipCourse: (m) => m.mizzen,
    jibs: c.L > 35 ? 3 : c.L > 20 ? 2 : 1,
    foreStay: fore ? [0, fore.top + 0.2, fore.z + fore.r] : null,
  });
  const fireSpots = [];
  for (let i = 0; i < 10; i++) {
    const t = 0.12 + (i / 9) * 0.76;
    fireSpots.push(new THREE.Vector3((i % 2 ? 1 : -1) * S.halfBeam(t) * 0.45 * (((i * 7) % 3) / 2), S.deck(t) + 0.2, S.zOf(t)));
  }
  const lamps = (c.lamps || []).map(([x, y, tz]) => { const t = clamp(tz, 0.005, 0.995); return new THREE.Vector3(x, S.sheer(t) + S.bulwark(t) + y * 0.4 + 0.3, S.zOf(t) + (tz < 0.5 ? -0.6 : 0.6)); });
  lamps.push(new THREE.Vector3(...mastheadLamp(plan)));
  const masts = plan.list.map((m) => ({ z: m.z, y: m.base, h: m.h }));
  // Crew on deck: spots along the waist and the quarterdeck, clear of the masts and hatches (x, y = deck, z, yaw).
  const crewSpots = [];
  {
    const rnd = mulberry(Math.round(c.L * 131 + c.B * 17));
    const n = c.crew || 0;
    for (let i = 0, tries = 0; i < n && tries < 400; tries++) {
      const t = i === 0 ? 0.1 : 0.08 + rnd() * 0.8;             // the first at the helm
      const z = S.zOf(t);
      if (plan.list.some((m) => Math.abs(m.z - z) < 1.1)) continue;
      const xw = S.xAt(t, S.deck(t)) * 0.75;
      const x = i === 0 ? 0.0 : (rnd() * 2 - 1) * xw;
      if (i > 0 && crewSpots.some((p) => Math.hypot(p.x - x, p.z - z) < 1.3)) continue;
      crewSpots.push({ x: i === 0 ? 0 : x, y: S.deck(t), z: i === 0 ? z - 1.2 : z, yaw: i === 0 ? 0 : (rnd() * 2 - 1) * Math.PI, seed: rnd() * 10 });
      i++;
    }
  }
  // The sail that carries the class emblem: the tallest mast's course (or its lateen, or the topsail when the course is skipped).
  let emblem = null;
  if (c.emblem) {
    const main = plan.list.reduce((a, b) => (b.h > a.h ? b : a), plan.list[0]);
    emblem = { cell: c.emblem, mast: main.i, tier: main.lateen ? 4 : main.mizzen ? 1 : 0 };
  }
  return {
    key, c, S, guns, plan, masts, fireSpots, lamps, crewSpots, emblem,
    hullG: hullGeometry(c, S),
    rigG: rigGeometry(c, S, guns, plan),
    gunsG: gunsGeometry(c, S, guns),
    glowG: portGlowGeometry(S, guns),
    sailsG: sails,
    ropeG: ropeGeometry(c, S, plan),
    flagG: flagGeometry(c, S, plan, c.flag),
    radius: Math.hypot(c.L / 2 + plan.bowsprit.len * 0.7, c.B),
  };
}

// ---- Materials -----------------------------------------------------------------------------------

const DITHER = /* glsl */`
  float nrDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  float nrH(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float nrN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(nrH(i), nrH(i + vec3(1,0,0)), f.x), mix(nrH(i + vec3(0,1,0)), nrH(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(nrH(i + vec3(0,0,1)), nrH(i + vec3(1,0,1)), f.x), mix(nrH(i + vec3(0,1,1)), nrH(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

/** The mast fall: vertices of mast i turn about its foot by uFall[i] (radians) toward a side. */
const FALL_VERT = /* glsl */`
  attribute float aMast;
  uniform vec4 uFall, uMastZ, uMastY;
  vec3 nrFall(vec3 p) {
    if (aMast < -0.5) return p;
    int mi = int(aMast + 0.5);
    float a = uFall[mi];
    if (abs(a) < 1e-4) return p;
    vec3 o = vec3(0.0, uMastY[mi], uMastZ[mi]);
    vec3 q = p - o;
    float c = cos(a), s = sin(a);
    return o + vec3(c * q.x - s * q.y, s * q.x + c * q.y, q.z);
  }
  vec3 nrFallN(vec3 n) {
    if (aMast < -0.5) return n;
    int mi = int(aMast + 0.5);
    float a = uFall[mi];
    float c = cos(a), s = sin(a);
    return vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
  }`;

/** Per-ship uniforms (one object per ship; every program reads them). */
export function shipUniforms(time) {
  return {
    uTime: time || { value: 0 }, uVis: { value: 1 }, uDmg: { value: 0 }, uBurn: { value: 0 }, uEerie: { value: 0 }, uWin: { value: 1 },
    uFall: { value: new THREE.Vector4() }, uMastZ: { value: new THREE.Vector4() }, uMastY: { value: new THREE.Vector4() },
    uOpen: { value: new THREE.Vector2() }, uFireT: { value: new THREE.Vector2(-99, -99) }, uRun: { value: new THREE.Vector2() },
    uSet: { value: 1 }, uWind: { value: 0.7 }, uLee: { value: 1 }, uTear: { value: 0 }, uSeed: { value: 0 }, uWorn: { value: 0 }, uRag: { value: 0 },
    uSailTint: { value: new THREE.Color(1, 1, 1) }, uWave: { value: 0 }, uWhite: { value: 0 }, uFlagYaw: { value: 0 },
    // v3: striped canvas (rgb, bands; 0 = plain), the sail emblem (atlas cell x, y, mast index, on) on tier
    // uEmblemTier, tarred seams' embers (the fire ship), scorch left on the canvas by fire (0..1).
    uStripe: { value: new THREE.Vector4(0, 0, 0, 0) }, uEmblem: { value: new THREE.Vector4(0, 0, -9, 0) }, uEmblemTier: { value: 0 },
    uEmber: { value: 0 }, uScorch: { value: 0 },
  };
}

/** Bind `U` into a compiled shader (only the names the shader declares matter). */
function bind(sh, U) { for (const k of Object.keys(U)) sh.uniforms[k] = U[k]; }

const COMMON_FRAG = (sail) => /* glsl */`
  varying vec3 vNrLocal;
  uniform float uVis, uDmg, uBurn, uEerie, uTime;
  ${DITHER}`;

/** The hull: three tiles (oak, painted planks, deck) chosen per vertex, vertex tints, char, fire glow, the cloak. */
export function hullMaterial(U) {
  const T = shipTextures();
  const m = new THREE.MeshStandardMaterial({ name: "rr-ship-hull", vertexColors: true, map: T.oak, roughness: 0.78, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.uniforms.tPaint = { value: T.paint };
    sh.uniforms.tDeck = { value: T.deck };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aTile;\nvarying float vNrTile;\nvarying vec3 vNrLocal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvNrTile = aTile;\nvNrLocal = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON_FRAG(false)}\nvarying float vNrTile;\nuniform sampler2D tPaint, tDeck;\nuniform float uEmber;`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (uVis < 0.999 && nrDither(gl_FragCoord.xy) > uVis) discard;")
      .replace("#include <map_fragment>", `
        vec4 nrO = texture2D(map, vMapUv), nrP = texture2D(tPaint, vMapUv), nrD = texture2D(tDeck, vMapUv);
        float nrW1 = clamp(1.0 - abs(vNrTile - 1.0), 0.0, 1.0), nrW2 = clamp(vNrTile - 1.0, 0.0, 1.0);
        vec4 nrTex = nrO * clamp(1.0 - vNrTile, 0.0, 1.0) + nrP * nrW1 + nrD * nrW2;
        // The oak tile is dark wood already: lift it so the class tint reads; paint and deck are pale.
        nrTex.rgb *= mix(1.9, 1.0, clamp(vNrTile, 0.0, 1.0));
        diffuseColor *= nrTex;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float nrChar = smoothstep(0.62 - uDmg * 0.33, 0.74 - uDmg * 0.33, nrN(vNrLocal * 0.55) * 0.7 + nrN(vNrLocal * 1.7) * 0.3) * step(0.001, uDmg);
        diffuseColor.rgb *= 1.0 - 0.75 * nrChar;
        // Shot holes: round black pocks with a ring of pale splinters, more of them as the damage grows
        // (a cell of 0.9 m on the side; about one in five cells holed on a wreck — denser read as camouflage).
        float nrHole = 0.0, nrRim = 0.0;
        if (uDmg > 0.08 && vNrLocal.y > 0.35 && vNrTile < 1.5) {
          vec2 hp = vNrLocal.zy * 1.1;
          vec2 hc = floor(hp);
          float hr = nrH(vec3(hc, sign(vNrLocal.x) * 3.0));
          vec2 ho = vec2(nrH(vec3(hc, 7.0)), nrH(vec3(hc, 11.0))) * 0.5 + 0.25;
          float hd = length(fract(hp) - ho);
          float on = step(hr, uDmg * 0.26 - 0.02);
          float rad = 0.1 + 0.12 * nrH(vec3(hc, 5.0));
          nrHole = on * (1.0 - smoothstep(rad * 0.75, rad, hd));
          nrRim = on * smoothstep(rad * 0.85, rad, hd) * (1.0 - smoothstep(rad, rad * 1.45, hd)) * step(0.45, nrN(vNrLocal * 14.0));
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.38, 0.26), nrRim * 0.6);
        diffuseColor.rgb *= 1.0 - 0.95 * nrHole;
        // Smoke-blackened above the holes on a badly hurt hull.
        diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(0.45, 0.9, uDmg) * nrN(vNrLocal * vec3(0.4, 0.15, 0.4));`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float nrFl = 0.6 + 0.4 * sin(uTime * 9.0 + vNrLocal.z * 0.7) * sin(uTime * 5.3 + vNrLocal.y);
        // Fire glows from the charred seams (not the whole hull); the flames themselves are flames.js's.
        // Embers in the deepest char only (a whole hull glowing orange read as gilt, not fire).
        totalEmissiveRadiance += vec3(1.0, 0.38, 0.08) * uBurn * nrFl * smoothstep(0.75, 1.0, nrChar * nrN(vNrLocal * 2.3 + uTime * 0.3) * 1.6) * 0.55;
        // The Gloam: a cold teal glow licking up her sides from the waterline.
        totalEmissiveRadiance += vec3(0.1, 0.62, 0.52) * uEerie * (0.04 + 0.24 * (1.0 - smoothstep(-0.6, 2.0, vNrLocal.y))) * (0.55 + 0.45 * nrN(vNrLocal * 0.4 + uTime * 0.2));
        // The fire ship: tar-black seams that smoulder (thin cracks glowing ember-orange, breathing).
        if (uEmber > 0.001) {
          // Plank seams (every 0.42 m up the side) that smoulder in patches, plus a few crazed cracks.
          float nrPlank = smoothstep(0.43, 0.49, abs(fract(vNrLocal.y / 0.42) - 0.5));
          float nrPatch = smoothstep(0.55, 0.8, nrN(vNrLocal * vec3(0.35, 0.8, 0.22) + vec3(0.0, uTime * 0.05, 0.0)));
          float nrCrack = 1.0 - abs(nrN(vNrLocal * vec3(2.2, 3.4, 1.6)) * 2.0 - 1.0);
          nrCrack = pow(clamp(nrCrack, 0.0, 1.0), 60.0) * smoothstep(0.45, 0.7, nrN(vNrLocal * 0.5 + 4.0));
          float nrBreath = 0.55 + 0.45 * sin(uTime * 1.7 + vNrLocal.z * 0.4) * sin(uTime * 2.9 + vNrLocal.y * 1.3);
          totalEmissiveRadiance += vec3(1.0, 0.32, 0.05) * uEmber * (nrPlank * nrPatch + nrCrack) * nrBreath * 1.8 * step(0.25, vNrLocal.y) * step(vNrTile, 1.5);
        }`);
  };
  m.customProgramCacheKey = () => "rr-ship-hull";
  return m;
}

/** The rig: vertex colours, lit stern windows / lanterns (aGlow × uWin), the mast fall, char, the cloak. */
export function rigMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ name: "rr-ship-rig", vertexColors: true, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.4 });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${FALL_VERT}\nattribute float aGlow;\nvarying float vNrGlow;\nvarying vec3 vNrLocal;`)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = nrFallN(objectNormal);")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = nrFall(transformed);\nvNrGlow = aGlow;\nvNrLocal = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON_FRAG(false)}\nuniform float uWin;\nvarying float vNrGlow;`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (uVis < 0.999 && nrDither(gl_FragCoord.xy) > uVis) discard;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        float nrChar = smoothstep(0.66 - uDmg * 0.5, 0.74 - uDmg * 0.5, nrN(vNrLocal * 0.7)) * step(0.001, uDmg);
        diffuseColor.rgb *= 1.0 - 0.7 * nrChar;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        // Lit stern windows and lanterns: warm lamplight (the Gloam's are cold teal, faintly lit even by day).
        vec3 nrLamp = mix(vec3(1.0, 0.62, 0.28), vec3(0.2, 1.0, 0.85), uEerie);
        totalEmissiveRadiance += nrLamp * vNrGlow * (uWin * (2.2 + 0.2 * sin(uTime * 7.0 + vNrLocal.x * 3.0)) + uEerie * 0.5);
        totalEmissiveRadiance += vec3(1.0, 0.38, 0.08) * uBurn * 0.12 * nrChar * nrChar;`);
  };
  m.customProgramCacheKey = () => "rr-ship-rig";
  return m;
}

/** The guns: lids swing up with the ports open, barrels run out, recoil on a volley (ripple), the bow gun bucks. */
export function gunsMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ name: "rr-ship-guns", vertexColors: true, roughness: 0.6, metalness: 0.25, envMapIntensity: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        attribute vec4 aGun; attribute vec3 aPivot;
        uniform vec2 uOpen, uFireT, uRun; uniform float uTime;
        varying vec3 vNrLocal;
        float nrRecoil(float t) { return t < 0.0 ? 0.0 : (t < 0.07 ? t / 0.07 : max(0.0, 1.0 - (t - 0.07) / 1.6)); }`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
        float nrSide = aGun.x, nrPart = aGun.y;
        float nrOpen = nrSide > 0.0 ? uOpen.x : (nrSide < 0.0 ? uOpen.y : 0.0);
        float nrA = nrOpen * 1.45 * sign(nrSide);
        if (nrPart > 0.5 && nrPart < 1.5) { float c = cos(nrA), s = sin(nrA); objectNormal = vec3(c * objectNormal.x - s * objectNormal.y, s * objectNormal.x + c * objectNormal.y, objectNormal.z); }`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vNrLocal = position;
        if (nrPart > 0.5 && nrPart < 1.5) {
          vec3 q = transformed - aPivot; float c = cos(nrA), s = sin(nrA);
          transformed = aPivot + vec3(c * q.x - s * q.y, s * q.x + c * q.y, q.z);
        } else if (nrPart > 1.5 && nrPart < 2.5) {
          float ft = nrSide > 0.0 ? uFireT.x : uFireT.y;
          float rec = nrRecoil(uTime - ft - aGun.z * 0.55);
          float run = nrSide > 0.0 ? uRun.x : uRun.y;
          transformed.x += nrSide * (run * 1.0 - rec * 0.85 * run);
        } else if (nrPart > 2.5) {
          float rec = nrRecoil(uTime - uFireT.x);
          transformed.z -= rec * 0.5;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON_FRAG(false)}`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (uVis < 0.999 && nrDither(gl_FragCoord.xy) > uVis) discard;");
  };
  m.customProgramCacheKey = () => "rr-ship-guns";
  return m;
}

/**
 * The sails: billow (bow-ward for squares, to leeward for fore-and-aft), reef by `uSet` (courses
 * first), fall with their mast, tear (holes grow with uTear; the worn tile's holes when uWorn),
 * a ragged foot (uRag), tint, fire, the Gloam's veins.
 */
export function sailMaterial(U, { worn = false, receiveShadow = false } = {}) {
  const T = shipTextures();
  const m = new THREE.MeshStandardMaterial({ name: "rr-ship-sail", map: worn ? T.sailWorn : T.sail, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, envMapIntensity: 0.3, alphaTest: 0.5, transparent: false });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.uniforms.tEmblem = { value: T.emblems };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        ${FALL_VERT.replace("attribute float aMast;", "float aMast;")}
        attribute vec4 aSail; attribute vec4 aSailB;
        uniform float uSet, uWind, uLee, uTime;
        varying vec3 vNrLocal; varying vec4 vNrSail; varying float vNrSet; varying vec4 vNrSailB;
        float nrSetK(float tier) {
          float th = tier < 0.5 ? 0.58 : (tier < 1.5 ? 0.1 : (tier < 2.5 ? 0.3 : (tier < 3.5 ? 0.45 : 0.04)));
          return smoothstep(th, th + 0.28, uSet);
        }`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
        aMast = aSailB.z;
        objectNormal = nrFallN(objectNormal);`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          float k = nrSetK(aSailB.x);
          vNrSet = k;
          float u = aSail.x, v = aSail.y;
          // Reef: the foot rises to the yard (a square) / the sail draws in to its stay (fore-and-aft).
          float kk = max(k, 0.035);
          if (aSailB.y < 0.5) transformed.y += (1.0 - v) * aSail.w * (1.0 - kk);
          float bx = u * 2.0 - 1.0;
          float shapeF = aSailB.y < 0.5 ? (1.0 - bx * bx) * (0.35 + 0.65 * sin(v * 3.14159)) : (sin(u * 3.14159) * sin(min(v * 1.6, 1.0) * 3.14159 * 0.5) * (1.0 - v));
          float flutter = 1.0 + 0.06 * sin(uTime * 2.6 + v * 6.0 + u * 4.0) + 0.03 * sin(uTime * 7.1 + u * 11.0);
          float bul = aSail.z * shapeF * (0.3 + 0.7 * uWind) * kk * flutter;
          if (aSailB.y < 0.5) transformed.z += bul; else transformed.x += bul * uLee;
          vNrSail = aSail;
          vNrSailB = aSailB;
        }
        transformed = nrFall(transformed);
        vNrLocal = position;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        ${COMMON_FRAG(true)}
        uniform float uTear, uSeed, uWorn, uRag, uEmblemTier, uScorch;
        uniform vec3 uSailTint;
        uniform vec4 uStripe, uEmblem;
        uniform sampler2D tEmblem;
        varying vec4 vNrSail; varying float vNrSet; varying vec4 vNrSailB;`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        if (uVis < 0.999 && nrDither(gl_FragCoord.xy) > uVis) discard;
        {
          vec2 sp = vNrSail.xy;
          // Shot holes, growing with the damage; a ragged foot on the tattered.
          float hn = nrN(vec3(sp * vec2(7.0, 5.0), uSeed)) * 0.75 + nrN(vec3(sp * 23.0, uSeed + 3.0)) * 0.25;
          if (uTear > 0.001 && hn > 1.0 - uTear * 0.42) discard;
          if (uRag > 0.001 && sp.y < (nrN(vec3(sp.x * 9.0, uSeed, 1.0)) * 0.6 + 0.1) * uRag * 0.35) discard;
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        diffuseColor.rgb *= uSailTint;
        // Striped canvas (a merchant's bands, cut down the cloth across each sail).
        if (uStripe.w > 0.5) {
          float nrS = fract(vNrSail.x * uStripe.w + 0.25);
          float nrAA = fwidth(vNrSail.x * uStripe.w) * 1.2 + 1e-4;
          float nrBand = smoothstep(0.5 - nrAA, 0.5 + nrAA, nrS) * (1.0 - smoothstep(1.0 - nrAA, 1.0, nrS));
          diffuseColor.rgb = mix(diffuseColor.rgb, uStripe.rgb * (0.75 + 0.25 * diffuseColor.g), nrBand * 0.9);
        }
        // The class emblem, painted on one sail (the main course / the lateen), sized to the cloth's height.
        if (uEmblem.w > 0.5 && abs(vNrSailB.z - uEmblem.z) < 0.5 && abs(vNrSailB.x - uEmblemTier) < 0.5) {
          vec2 nrE = vec2((vNrSail.x - 0.5) * max(vNrSailB.w, 0.3), vNrSail.y - 0.5) / 1.15 + 0.5;
          if (vNrSailB.y > 0.5) nrE = vec2((vNrSail.x - 0.55) * max(vNrSailB.w, 0.3), vNrSail.y - 0.33) / 0.95 + 0.5;
          if (nrE.x > 0.0 && nrE.x < 1.0 && nrE.y > 0.0 && nrE.y < 1.0) {
            vec4 nrEm = texture2D(tEmblem, (uEmblem.xy + nrE) * 0.5);      // uEmblem.xy = (cell x, 1 − cell y)
            diffuseColor.rgb = mix(diffuseColor.rgb, nrEm.rgb * (0.7 + 0.3 * diffuseColor.g), nrEm.a * 0.93);
          }
        }
        // Scorched canvas: brown-black blotches where fire has been (they stay after it's out).
        float nrScEdge = 0.0;
        {
          float nrSc = max(uScorch, uBurn * 0.8);
          if (nrSc > 0.01) {
            float nrB = nrN(vec3(vNrSail.xy * vec2(5.0, 4.0), uSeed + 9.0)) * 0.7 + nrN(vec3(vNrSail.xy * 15.0, uSeed)) * 0.3;
            float nrK = smoothstep(1.0 - nrSc * 0.8, 1.05 - nrSc * 0.8, nrB + (1.0 - vNrSail.y) * 0.25);
            diffuseColor.rgb *= mix(vec3(1.0), vec3(0.12, 0.08, 0.06), nrK);
            nrScEdge = nrK * (1.0 - nrK) * 4.0;
          }
        }`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        {
          float nrFl = 0.6 + 0.4 * sin(uTime * 9.0 + vNrLocal.z * 0.7) * sin(uTime * 5.3 + vNrLocal.y);
          // Fire on the canvas: the scorch's creeping edges glow (not the whole sail).
          totalEmissiveRadiance += vec3(1.0, 0.38, 0.08) * uBurn * nrFl * (0.06 + 2.2 * nrScEdge) * (0.4 + 0.6 * (1.0 - vNrSail.y));
          // The Gloam: cold veins of light wandering in the cloth.
          float vein = 1.0 - abs(nrN(vec3(vNrSail.xy * vec2(3.0, 6.0), uSeed)) * 2.0 - 1.0);
          vein = pow(clamp(vein, 0.0, 1.0), 14.0);
          totalEmissiveRadiance += vec3(0.25, 1.0, 0.82) * uEerie * (vein * 1.6 + 0.04) * (0.7 + 0.3 * sin(uTime * 1.3 + vNrSail.y * 6.0));
          // Sunlight through the canvas (lit from behind, it glows warm).
          totalEmissiveRadiance += diffuseColor.rgb * 0.06;
        }`);
  };
  m.customProgramCacheKey = () => `rr-ship-sail-${worn ? 1 : 0}`;
  return m;
}

/** Ropes: the mast fall and the cloak. */
export function ropeMaterial(U, color = "#1d1712") {
  const m = new THREE.LineBasicMaterial({ name: "rr-ship-rope", color, transparent: true, opacity: 0.9 });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${FALL_VERT}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = nrFall(transformed);");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uVis;\n${DITHER}`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (uVis < 0.999 && nrDither(gl_FragCoord.xy) > uVis) discard;");
  };
  m.customProgramCacheKey = () => "rr-ship-rope";
  return m;
}

/** Flags: the atlas, streaming downwind (uFlagYaw about each flag's pivot), the white flag by uWhite. */
export function flagMaterial(U) {
  const T = shipTextures();
  const m = new THREE.MeshStandardMaterial({ name: "rr-ship-flag", map: T.flags, side: THREE.DoubleSide, roughness: 0.9, envMapIntensity: 0.3 });
  m.onBeforeCompile = (sh) => {
    bind(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        attribute vec4 aFlag; attribute vec2 aWhite;
        uniform float uTime, uFlagYaw, uWhite, uWind;`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = mix(vMapUv, aWhite, uWhite);
        #endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          vec3 q = transformed - aFlag.xyz;
          float along = clamp(-q.z / max(aFlag.w, 0.1), 0.0, 1.0);
          float amp = (0.3 + 0.5 * uWind) * along;
          q.x += sin(along * 7.0 - uTime * 7.5 + aFlag.y) * 0.22 * amp * aFlag.w * 0.35;
          q.y += sin(along * 5.0 - uTime * 6.0) * 0.06 * amp * aFlag.w * 0.25 - along * along * (1.0 - uWind) * aFlag.w * 0.25;
          float c = cos(uFlagYaw), s = sin(uFlagYaw);
          q = vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z);
          transformed = aFlag.xyz + q;
        }`);
  };
  m.customProgramCacheKey = () => "rr-ship-flag";
  return m;
}

/** The ports-open telegraph glow (additive, fog by hand). */
export function portGlowMaterial(fogU) {
  return new THREE.ShaderMaterial({
    name: "RexmawPortGlow",
    uniforms: { uGlow: { value: new THREE.Vector2() }, uTime: fogU.uTime, uFogDensity: fogU.uFogDensity, uVis: { value: 1 }, uColor: { value: new THREE.Color("#ff7a2a") } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aSide, aSeed;
      varying float vK; varying vec2 vUv; varying float vDist;
      uniform vec2 uGlow; uniform float uTime;
      void main() {
        vUv = uv;
        float g = aSide > 0.0 ? uGlow.x : (aSide < 0.0 ? uGlow.y : 0.0);
        vK = g * (0.8 + 0.2 * sin(uTime * (7.0 + aSeed * 5.0) + aSeed * 40.0));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uFogDensity, uVis;
      varying float vK; varying vec2 vUv; varying float vDist;
      void main() {
        if (vK < 0.002) discard;
        vec2 p = abs(vUv * 2.0 - 1.0);
        float box = (1.0 - smoothstep(0.55, 1.0, p.x)) * (1.0 - smoothstep(0.5, 1.0, p.y));
        float fd = uFogDensity * vDist * 0.6;
        gl_FragColor = vec4(uColor * vK * box * 4.5 * exp(-fd * fd) * uVis, 1.0);
      }`,
  });
}

/** Sail tints per class kind (linear multipliers on the canvas). */
export const SAIL_TINT = Object.freeze({ plain: [1, 1, 1], cream: [1.0, 0.95, 0.84], navy: [1, 1, 1], grimy: [0.62, 0.56, 0.46], gloam: [0.17, 0.2, 0.19], rexmaw: [0.96, 0.93, 0.86] });
