// Rexmaw Raids v4: the whacky sea events' creatures (drawn for scene/seaevents.js, which owns the records and
// calls `step` for each whacky event every frame; the core's `state.events[]` rows are read forgivingly).
//
//   gerald      the chapbook's shark, grown (24 m): warn — the fin circling in; rise — a dark patch where he'll come
//               up and a darker one where he'll land; air — the leap over the Rexmaw (a half barrel roll, tail
//               thrashing); swim — the fin going away. A splash at each end, the big one where he lands.
//   sky_whale   a blue whale (46 m): warn — its back and its blows; then breach → climb → a loop up in the clouds →
//               glide → a flat belly-flop on the flop spot; its ring wave rolls out (a foam wall, and its height
//               rocks the ships through weather.waveHeightAt); fish rain round the splash.
//   dolphins    a pod of six leaping in turns round the pod's spot (it runs at the core's heading and speed).
//   flying_fish a swarm of 36 gliding and skipping across, wings beating; on a catch a dozen land on deck.
//   jellyfish   a bloom of giant glowing bells (additive, pulsing) with soft glow pools on the water; a zap flashes them.
//   turtle      an island-sized turtle: plated shell, a sandy patch with a palm and a chest on top, paddling flippers.
//   admiral     the Seagull Admiral (a big gull in a navy coat and a tricorn) leading eight gulls in a V; dives on
//               the target ship each pass, circles us when inspecting.
//
// One shared lit material program (MeshStandardMaterial with a swim/flap vertex bend, plain and instanced), one
// glow program for the jellies, one for the ring wave: shown for the compile behind the title (warmShow). Every
// mesh is built once and pooled; nothing is allocated per frame; every number from the state passes isFinite.

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";
import { SEA_HEIGHT_GLSL } from "./water.js";
import { hash } from "./util.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const fin = (v) => Number.isFinite(+v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DOLPHINS = 6, FISH = 64, GULLS = 8, JELLIES = 24;
const SIZE = { gerald: 24, whale: 46, dolphin: 5.5, fish: 1.1, gull: 4, admiral: 6.5, turtle: 30 };
/** Seconds of each sky-whale phase (the core's `times` win when sent). */
const WHALE_T = { breach: 3, climb: 8, loop: 9, glide: 5, dive: 3.2 };

// ---- Geometry: a little builder (non-indexed triangles with colour, the tail bend and the flap) ----------------

function builder() {
  const pos = [], col = [], bend = [], flap = [];
  const c3 = new THREE.Color();
  const api = {
    /** One triangle: a, b, c = [x, y, z]; colour; bend (0 head .. 1 tail) per vertex or one; flap [amp, phase] per vertex or one. */
    tri(a, b, c, color, bd = 0, fl = null) {
      c3.set(color);
      const bs = Array.isArray(bd) ? bd : [bd, bd, bd];
      const fs = Array.isArray(fl?.[0]) ? fl : [fl || [0, 0], fl || [0, 0], fl || [0, 0]];
      [a, b, c].forEach((p, i) => { pos.push(p[0], p[1], p[2]); col.push(c3.r, c3.g, c3.b); bend.push(bs[i]); flap.push(fs[i][0], fs[i][1]); });
    },
    /** A body of revolution along z: stations [z, halfWidth, halfHeight, yOffset]; colour(i, θ, x, y, z) → hex; bend from z. */
    body(stations, seg, colorAt, bendAt = () => 0) {
      const ring = stations.map(([z, w, hh, y0]) => Array.from({ length: seg + 1 }, (_, j) => {
        const th = (j / seg) * Math.PI * 2;
        return [Math.cos(th) * w, (y0 || 0) + Math.sin(th) * hh, z, th];
      }));
      for (let i = 0; i < ring.length - 1; i++) {
        for (let j = 0; j < seg; j++) {
          const a = ring[i][j], b = ring[i][j + 1], c = ring[i + 1][j], d = ring[i + 1][j + 1];
          const col0 = colorAt(i, (a[3] + b[3]) / 2, a[0], a[1], (a[2] + c[2]) / 2);
          api.tri(a, c, b, col0, [bendAt(a[2]), bendAt(c[2]), bendAt(b[2])]);
          api.tri(b, c, d, col0, [bendAt(b[2]), bendAt(c[2]), bendAt(d[2])]);
        }
      }
    },
    /** A box (the chest, the coat): centre, half sizes, colour. */
    box(cx, cy, cz, hx, hy, hz, color, bd = 0) {
      const v = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
      const faces = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
        [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]];
      for (const f of faces) { const [a, b, c, d] = f.map((p) => v(...p)); api.tri(a, b, c, color, bd); api.tri(a, c, d, color, bd); }
    },
    geometry(instanced = false) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute("aBend", new THREE.Float32BufferAttribute(bend, 1));
      g.setAttribute("aFlap", new THREE.Float32BufferAttribute(flap, 2));
      if (!instanced) g.setAttribute("aPh", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    },
  };
  return api;
}
const lerpHex = (a, b, t) => `#${new THREE.Color(a).lerp(new THREE.Color(b), clamp(t, 0, 1)).getHexString()}`;
/** Counter-shading: dark back, pale belly (θ: the ring angle, sin θ > 0 on top). */
const shade = (top, belly, th, edge = 0.25) => lerpHex(belly, top, smooth(-edge, edge, Math.sin(th)));

function sharkGeo() {
  const b = builder();
  const st = [[-0.5, 0.004, 0.006], [-0.44, 0.03, 0.045], [-0.32, 0.065, 0.085], [-0.12, 0.105, 0.125], [0.08, 0.12, 0.135], [0.24, 0.11, 0.115, -0.006],
    [0.36, 0.08, 0.08, -0.012], [0.45, 0.045, 0.045, -0.016], [0.5, 0.006, 0.008, -0.02]];
  const bendAt = (z) => clamp((0.15 - z) / 0.65, 0, 1);
  b.body(st, 18, (i, th, x, y, z) => {
    // The mouth: a dark gash under the snout, a row of white teeth on its lip.
    if (z > 0.3 && z < 0.43 && Math.sin(th) < -0.35) return Math.sin(th) < -0.75 ? "#3a1416" : "#efe9dc";
    return shade("#4c5a66", "#ebe6dc", th, 0.2);
  }, bendAt);
  // Teeth: little white points along the lip.
  for (let i = 0; i < 9; i++) {
    const t = i / 8, z = 0.33 + t * 0.09, x = (0.07 - t * 0.04) * (i % 2 ? 1 : -1), y = -0.06;
    b.tri([x - 0.008, y, z], [x + 0.008, y, z], [x, y - 0.03, z + 0.004], "#f6f1e6", 0);
  }
  // Eyes.
  for (const s of [-1, 1]) b.tri([s * 0.074, 0.03, 0.41], [s * 0.07, 0.045, 0.395], [s * 0.078, 0.022, 0.392], "#06080a", 0);
  // Dorsal fin (the one that circles), the second dorsal, pectorals, the tail.
  b.tri([0, 0.12, 0.1], [0, 0.34, -0.04], [0, 0.11, -0.12], "#45525d", [0.03, 0.2, 0.4]);
  b.tri([0, 0.06, -0.3], [0, 0.12, -0.36], [0, 0.05, -0.36], "#45525d", [0.7, 0.8, 0.8]);
  for (const s of [-1, 1]) {
    b.tri([s * 0.1, -0.06, 0.18], [s * 0.34, -0.17, -0.02], [s * 0.1, -0.08, 0.03], "#56636e", 0.05, [[0, 0], [0.04, s > 0 ? 0 : 3.1], [0, 0]]);
  }
  b.tri([0, 0.0, -0.42], [0, 0.27, -0.66], [0, 0.03, -0.51], "#45525d", [0.9, 1.25, 1.05]);
  b.tri([0, 0.0, -0.42], [0, -0.16, -0.6], [0, -0.02, -0.5], "#4c5a66", [0.9, 1.2, 1.05]);
  return b.geometry();
}

function whaleGeo() {
  const b = builder();
  const st = [[-0.5, 0.004, 0.004], [-0.45, 0.022, 0.026], [-0.36, 0.045, 0.05], [-0.2, 0.085, 0.085], [0, 0.115, 0.105], [0.18, 0.125, 0.1],
    [0.32, 0.118, 0.08, -0.01], [0.42, 0.095, 0.055, -0.016], [0.48, 0.06, 0.035, -0.02], [0.5, 0.01, 0.01, -0.02]];
  const bendAt = (z) => clamp((0.05 - z) / 0.55, 0, 1);
  b.body(st, 24, (i, th, x, y, z) => {
    const s = Math.sin(th);
    // Throat grooves: pale and dark stripes under the front half.
    if (z > 0.05 && s < -0.25) return (Math.round(th / (Math.PI * 2) * 24) % 2) ? "#b7c6d0" : "#8ea1af";
    const mottle = ((hash(`w${i}:${Math.round(th * 10)}`) % 100) / 100) * 0.25;
    return lerpHex(shade("#45688a", "#c4d2da", th, 0.3), "#7d9ab3", mottle * smooth(0, 0.6, s));
  }, bendAt);
  for (const s of [-1, 1]) {
    b.tri([s * 0.118, -0.02, 0.33], [s * 0.114, -0.005, 0.315], [s * 0.121, -0.03, 0.31], "#06090c", 0);
    // Long flippers.
    b.tri([s * 0.11, -0.05, 0.22], [s * 0.44, -0.13, 0.02], [s * 0.115, -0.06, 0.1], "#4f7090", 0.1, [[0, 0], [0.06, s > 0 ? 0 : 3.1], [0, 0]]);
    // The flukes (horizontal), a notch in the middle.
    b.tri([0, 0, -0.45], [s * 0.21, 0.012, -0.585], [s * 0.035, 0.004, -0.53], "#3f6080", [0.95, 1.3, 1.15]);
  }
  b.tri([0, 0.07, -0.24], [0, 0.1, -0.29], [0, 0.065, -0.3], "#3f6080", 0.6);
  return b.geometry();
}

function dolphinGeo() {
  const b = builder();
  const st = [[-0.5, 0.004, 0.006], [-0.42, 0.03, 0.04], [-0.25, 0.07, 0.085], [-0.02, 0.1, 0.11], [0.2, 0.09, 0.095], [0.34, 0.065, 0.07],
    [0.4, 0.035, 0.03, -0.02], [0.5, 0.012, 0.01, -0.025]];
  b.body(st, 14, (i, th) => shade("#596978", "#e3e7ea", th, 0.15), (z) => clamp((0.1 - z) / 0.6, 0, 1));
  b.tri([0, 0.1, 0.06], [0, 0.26, -0.12], [0, 0.09, -0.1], "#4e5c69", [0.05, 0.4, 0.35]);
  for (const s of [-1, 1]) {
    b.tri([s * 0.08, -0.05, 0.16], [s * 0.24, -0.13, 0.0], [s * 0.08, -0.06, 0.06], "#55636f", 0.05, [[0, 0], [0.03, 0], [0, 0]]);
    b.tri([0, 0, -0.44], [s * 0.17, 0.01, -0.58], [s * 0.03, 0.004, -0.53], "#4e5c69", [0.95, 1.3, 1.15]);
  }
  return b.geometry(true);
}

function fishGeo() {
  const b = builder();
  const st = [[-0.5, 0.004, 0.004], [-0.35, 0.03, 0.04], [0, 0.06, 0.07], [0.3, 0.05, 0.05], [0.5, 0.005, 0.005]];
  b.body(st, 8, (i, th) => shade("#2b4f8a", "#e8f0f6", th, 0.1), (z) => clamp(-z * 1.6, 0, 1));
  // The wings (big pectorals) beat; the tail forks.
  for (const s of [-1, 1]) {
    b.tri([s * 0.04, 0.02, 0.2], [s * 0.62, 0.05, -0.08], [s * 0.05, 0.02, -0.12], "#86b3e6", 0, [[0.05, 0], [0.5, 0], [0.05, 0]]);
    b.tri([0, 0, -0.42], [0, s * 0.18, -0.62], [0, s * 0.03, -0.5], "#3b6aa8", 1);
  }
  return b.geometry(true);
}

function gullGeo(admiral = false) {
  const b = builder();
  const white = "#f2f0ea", grey = "#9aa3ab", tip = "#2a2c30";
  // Body (a thin diamond), two wing panels each side (the outer flaps more), a tail; Night Helm's gull, in metres.
  b.tri([0, 0, 0.32], [0.07, 0, -0.1], [-0.07, 0, -0.1], white);
  b.tri([0, 0, 0.32], [0, 0.08, 0], [0.07, 0, -0.1], white);
  b.tri([0, 0, 0.32], [-0.07, 0, -0.1], [0, 0.08, 0], white);
  b.tri([0, 0.02, 0.36], [0.02, 0.0, 0.3], [-0.02, 0.0, 0.3], "#e8b23a");                 // beak
  for (const s of [1, -1]) {
    b.tri([0.04 * s, 0.02, 0.12], [0.42 * s, 0.05, 0.02], [0.05 * s, 0.02, -0.06], grey, 0, [[0.1, 0], [0.6, 0], [0.1, 0]]);
    b.tri([0.42 * s, 0.05, 0.02], [0.82 * s, 0.0, -0.12], [0.36 * s, 0.03, -0.08], tip, 0, [[0.6, 0], [1, 0], [0.6, 0]]);
  }
  b.tri([0, 0, -0.1], [0.1, 0, -0.26], [-0.1, 0, -0.26], white);
  if (admiral) {
    // The coat (navy, gold buttons and epaulettes) and the tricorn (black, gold trim): the harbour's own Admiral.
    b.box(0, 0.03, 0.02, 0.052, 0.038, 0.08, "#1d2a52");          // the coat (the white head and tail still show)
    for (const s of [1, -1]) b.tri([0.045 * s, 0.069, 0.07], [0.09 * s, 0.069, 0.04], [0.045 * s, 0.069, 0.0], "#e9c25a");
    for (let i = 0; i < 3; i++) b.tri([-0.012, 0.0695, 0.08 - i * 0.04], [0.012, 0.0695, 0.08 - i * 0.04], [0, 0.0695, 0.065 - i * 0.04], "#e9c25a");
    const hy = 0.1, hz = 0.24;
    const p = [[0, hy + 0.012, hz + 0.08], [0.075, hy + 0.012, hz - 0.045], [-0.075, hy + 0.012, hz - 0.045]];
    b.tri(p[0], p[1], p[2], "#111216");
    for (let i = 0; i < 3; i++) {
      const a = p[i], c = p[(i + 1) % 3], top = [(a[0] + c[0]) * 0.3, hy + 0.06, (a[2] + c[2]) * 0.3 + hz * 0.4];
      b.tri(a, c, top, "#15161b");
      b.tri([a[0], a[1] + 0.004, a[2]], [c[0], c[1] + 0.004, c[2]], [(a[0] + c[0]) / 2, a[1] + 0.012, (a[2] + c[2]) / 2], "#e9c25a");
    }
  }
  return b.geometry(!admiral);
}

function turtleGeo() {
  const b = builder();
  // The shell: a low dome of plates (dark seams), its rim; units = the shell's radius (30 m).
  const rings = 7, seg = 28, H = 0.38;
  const ptOf = (i, j) => { const r = 1 - i / rings, th = (j / seg) * Math.PI * 2; const y = H * Math.sqrt(Math.max(0, 1 - r * r)) * (1 - 0.1 * r); return [Math.cos(th) * r * 0.92, y, Math.sin(th) * r * 1.08, th]; };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = ptOf(i, j), c = ptOf(i, j + 1), d = ptOf(i + 1, j), e = ptOf(i + 1, j + 1);
      const plate = (Math.floor(j / 4) + Math.floor(i / 2)) % 2;
      const seam = j % 4 === 0 || i % 2 === 0;
      const col = seam ? "#2c3220" : plate ? "#5f6b3a" : "#4b5a31";
      b.tri(a, d, c, col); b.tri(c, d, e, col);
    }
  }
  // The rim's skirt down to the water and the plastron (underside).
  for (let j = 0; j < seg; j++) {
    const a = ptOf(0, j), c = ptOf(0, j + 1);
    b.tri(a, c, [c[0] * 1.02, -0.12, c[2] * 1.02], "#3d4728"); b.tri(a, [c[0] * 1.02, -0.12, c[2] * 1.02], [a[0] * 1.02, -0.12, a[2] * 1.02], "#3d4728");
    b.tri([0, -0.14, 0], [a[0], -0.12, a[2]], [c[0], -0.12, c[2]], "#cdbb86");
  }
  // The head and neck (front = +z), the eyes.
  // (raised so it rides above the water while she swims: she holds her head up to look about)
  const head = [[0.9, 0.02, 0.05, 0.02], [1.04, 0.13, 0.11, 0.1], [1.22, 0.16, 0.12, 0.17], [1.36, 0.12, 0.1, 0.2], [1.44, 0.01, 0.01, 0.2]];
  b.body(head.map(([z, w, hh, y]) => [z, w, hh, y]), 12, (i, th) => shade("#556640", "#c9c08e", th, 0.3));
  for (const s of [-1, 1]) b.tri([s * 0.12, 0.27, 1.32], [s * 0.1, 0.29, 1.28], [s * 0.125, 0.25, 1.27], "#0a0b08");
  // Flippers: two big at the front, two small at the back (they paddle).
  for (const s of [-1, 1]) {
    b.tri([s * 0.7, 0.0, 0.62], [s * 1.55, -0.04, 0.22], [s * 0.8, 0.0, 0.32], "#4f5f3a", 0, [[0.04, s > 0 ? 0 : 3.1], [0.3, s > 0 ? 0 : 3.1], [0.06, s > 0 ? 0 : 3.1]]);
    b.tri([s * 0.62, 0.0, -0.64], [s * 1.0, -0.04, -0.96], [s * 0.7, 0.0, -0.78], "#4f5f3a", 0, [[0.03, s > 0 ? 1.6 : 4.7], [0.2, s > 0 ? 1.6 : 4.7], [0.04, s > 0 ? 1.6 : 4.7]]);
  }
  b.tri([0, 0, -1.0], [0.08, 0.0, -1.2], [-0.08, 0.0, -1.2], "#4f5f3a");
  // The sandy patch on top, the palm (a leaning trunk, drooping fronds).
  const sandR = 0.36;
  for (let j = 0; j < 16; j++) {
    const a = (j / 16) * Math.PI * 2, c = ((j + 1) / 16) * Math.PI * 2;
    b.tri([0, H + 0.035, -0.05], [Math.cos(a) * sandR, H - 0.03, Math.sin(a) * sandR - 0.05], [Math.cos(c) * sandR, H - 0.03, Math.sin(c) * sandR - 0.05], "#d8c18a");
  }
  const trunk = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; trunk.push([0.08 * t * t + 0.05, H + 0.03 + t * 0.62, -0.1 + 0.06 * t]); }
  for (let i = 0; i < 6; i++) {
    const p = trunk[i], q = trunk[i + 1], w0 = 0.028 - i * 0.002, w1 = 0.028 - (i + 1) * 0.002;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2, c = ((k + 1) / 6) * Math.PI * 2;
      const P0 = [p[0] + Math.cos(a) * w0, p[1], p[2] + Math.sin(a) * w0], P1 = [p[0] + Math.cos(c) * w0, p[1], p[2] + Math.sin(c) * w0];
      const Q0 = [q[0] + Math.cos(a) * w1, q[1], q[2] + Math.sin(a) * w1], Q1 = [q[0] + Math.cos(c) * w1, q[1], q[2] + Math.sin(c) * w1];
      const col = i % 2 ? "#7a5c3b" : "#8b6a45";
      b.tri(P0, Q0, P1, col); b.tri(P1, Q0, Q1, col);
    }
  }
  const top = trunk[6];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2, len = 0.32 + 0.06 * (k % 3);
    const tip = [top[0] + Math.cos(a) * len, top[1] - 0.16, top[2] + Math.sin(a) * len];
    const mid = [top[0] + Math.cos(a) * len * 0.5, top[1] + 0.04, top[2] + Math.sin(a) * len * 0.5];
    const side = [-Math.sin(a) * 0.05, 0, Math.cos(a) * 0.05];
    b.tri(top, [mid[0] + side[0], mid[1], mid[2] + side[2]], tip, "#3f7d3a", 0, [[0, 0], [0.01, k], [0.03, k]]);
    b.tri(top, tip, [mid[0] - side[0], mid[1], mid[2] - side[2]], "#356b31", 0, [[0, 0], [0.03, k], [0.01, k]]);
  }
  for (let k = 0; k < 3; k++) b.box(top[0] + 0.02 * k - 0.02, top[1] - 0.03, top[2] + 0.015 * k, 0.018, 0.018, 0.018, "#5a3b1f");   // coconuts
  return b.geometry();
}

function chestGeo() {
  const b = builder();
  b.box(0, 0.05, 0, 0.09, 0.05, 0.06, "#6b4423");
  b.box(0, 0.11, 0, 0.092, 0.018, 0.062, "#7c5230");
  b.box(0, 0.06, 0.061, 0.012, 0.022, 0.003, "#e9c25a");
  for (const x of [-0.06, 0.06]) b.box(x, 0.065, 0, 0.006, 0.066, 0.063, "#c9a24a");
  return b.geometry();
}

/** The shared lit material: vertex colours, the tail's sway (uSwim.x phase, .y sway) and the flap (.z phase, .w amp). */
function critterMat() {
  const mat = new THREE.MeshStandardMaterial({ name: "rr-critter", vertexColors: true, roughness: 0.58, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.7 });
  const uSwim = { value: new THREE.Vector4() };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSwim = uSwim;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aBend;\nattribute vec2 aFlap;\nattribute float aPh;\nuniform vec4 uSwim;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float crPh = uSwim.x + aPh;
        transformed.x += sin(crPh - aBend * 2.6) * uSwim.y * aBend * aBend;
        transformed.y += sin(uSwim.z + aPh * 1.7 + aFlap.y) * uSwim.w * aFlap.x;`);
  };
  mat.customProgramCacheKey = () => "rr-critter";
  mat.userData.uSwim = uSwim.value;
  return mat;
}

export function createCritters(R, { water = null, fx = null, swirl = () => {} } = {}) {
  const root = new THREE.Group();
  root.name = "critters";
  R.scene.add(root);
  const wu = water?.uniforms || {};
  const uTime = wu.uTime || { value: 0 };
  const disposables = [];
  const keep = (...xs) => { disposables.push(...xs); return xs[0]; };

  const mesh = (geo, name, scale) => {
    const m = new THREE.Mesh(keep(geo), keep(critterMat()));
    m.name = name; m.visible = false; m.frustumCulled = false; m.scale.setScalar(scale);
    m.layers.set(LAYERS.WORLD);
    root.add(m);
    return m;
  };
  const instanced = (geo, name, n, scale) => {
    const ph = new Float32Array(n);
    for (let i = 0; i < n; i++) ph[i] = (hash(`${name}${i}`) % 1000) / 1000 * 6.283;
    geo.setAttribute("aPh", new THREE.InstancedBufferAttribute(ph, 1));
    const m = new THREE.InstancedMesh(keep(geo), keep(critterMat()), n);
    m.name = name; m.count = 0; m.frustumCulled = false; m.userData.scale = scale;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.layers.set(LAYERS.WORLD);
    root.add(m);
    return m;
  };

  const gerald = mesh(sharkGeo(), "gerald", SIZE.gerald);
  const whale = mesh(whaleGeo(), "sky-whale", SIZE.whale);
  const turtle = mesh(turtleGeo(), "island-turtle", SIZE.turtle);
  const chest = mesh(chestGeo(), "turtle-chest", SIZE.turtle);
  const admiral = mesh(gullGeo(true), "seagull-admiral", SIZE.admiral);
  const dolphins = instanced(dolphinGeo(), "dolphins", DOLPHINS, SIZE.dolphin);
  const fishes = instanced(fishGeo(), "flying-fish", FISH, SIZE.fish);
  const gulls = instanced(gullGeo(false), "squadron", GULLS, SIZE.gull);

  // ---- The jellyfish: glowing bells (additive), pulsing; a soft glow pool on the water under each ----
  const bellGeo = keep(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55));
  const jAttr = new THREE.InstancedBufferAttribute(new Float32Array(JELLIES * 4), 4).setUsage(THREE.DynamicDrawUsage);
  bellGeo.setAttribute("aJ", jAttr);
  const jellyU = { uTime, uAmt: { value: 0 }, uZap: { value: 0 }, uDay: { value: 0 } };
  const jellyMat = keep(new THREE.ShaderMaterial({
    name: "RexmawJellyfish", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: jellyU,
    vertexShader: /* glsl */`
      attribute vec4 aJ;      // phase, size (m), hue 0..1, visibility
      uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying float vY; varying vec4 vJ;
      void main() {
        float p = sin(uTime * 1.7 + aJ.x);
        vec3 q = position * vec3(1.0 + 0.12 * p, 0.8 - 0.18 * p, 1.0 + 0.12 * p);
        vY = position.y;
        vJ = aJ;
        vec4 w = modelMatrix * instanceMatrix * vec4(q, 1.0);
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAmt, uZap, uDay, uTime;
      varying vec3 vN; varying vec3 vV; varying float vY; varying vec4 vJ;
      void main() {
        float rim = pow(1.0 - abs(dot(vN, vV)), 2.0);
        vec3 a = vec3(0.2, 0.95, 1.0), b = vec3(0.95, 0.35, 1.0);
        vec3 col = mix(a, b, vJ.z);
        float bands = 0.6 + 0.4 * sin(vY * 22.0 - uTime * 2.0 + vJ.x);
        float k = (0.25 + 1.6 * rim) * bands * (1.0 + 2.5 * uZap) * uAmt * vJ.w * mix(1.0, 0.45, uDay);
        if (k < 0.004) discard;
        gl_FragColor = vec4(col * k, 1.0);
      }`,
  }));
  const jellies = new THREE.InstancedMesh(bellGeo, jellyMat, JELLIES);
  jellies.name = "jellyfish"; jellies.count = 0; jellies.frustumCulled = false; jellies.renderOrder = 12;
  jellies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jellies.layers.set(LAYERS.NOREFLECT);
  root.add(jellies);
  const poolGeo = keep(new THREE.PlaneGeometry(2, 2));
  poolGeo.rotateX(-Math.PI / 2);
  const pAttr = new THREE.InstancedBufferAttribute(new Float32Array(JELLIES * 4), 4).setUsage(THREE.DynamicDrawUsage);
  poolGeo.setAttribute("aJ", pAttr);
  const poolMat = keep(new THREE.ShaderMaterial({
    name: "RexmawJellyPool", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: jellyU,
    vertexShader: /* glsl */`
      attribute vec4 aJ; varying vec2 vP; varying vec4 vJ;
      void main() { vP = position.xz; vJ = aJ; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uAmt, uZap, uDay, uTime; varying vec2 vP; varying vec4 vJ;
      void main() {
        float r = length(vP);
        float k = exp(-r * r * 4.5) * (0.13 + 0.06 * sin(uTime * 1.7 + vJ.x)) * (1.0 + 2.0 * uZap) * uAmt * vJ.w * mix(1.0, 0.25, uDay);
        if (k < 0.003) discard;
        gl_FragColor = vec4(mix(vec3(0.1, 0.7, 0.9), vec3(0.7, 0.25, 0.9), vJ.z) * k, 1.0);
      }`,
  }));
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, JELLIES);
  pools.name = "jelly-pools"; pools.count = 0; pools.frustumCulled = false; pools.renderOrder = 4;
  pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pools.layers.set(LAYERS.NOREFLECT);
  root.add(pools);

  // ---- The whale's ring wave: a foam-crested wall on the sea (its height rocks the ships via weather.js) ----
  const RING_SEG = 192, RING_ACROSS = 6;
  const ringGeo = keep(new THREE.BufferGeometry());
  {
    const pos = [], idx = [];
    for (let i = 0; i <= RING_SEG; i++) for (let j = 0; j <= RING_ACROSS; j++) { const th = (i / RING_SEG) * Math.PI * 2; pos.push(Math.cos(th), (j / RING_ACROSS) * 2 - 1, Math.sin(th)); }
    for (let i = 0; i < RING_SEG; i++) for (let j = 0; j < RING_ACROSS; j++) {
      const a = i * (RING_ACROSS + 1) + j, b = a + RING_ACROSS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    ringGeo.setIndex(idx);
    ringGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  const ringU = { uTime, uR: { value: 10 }, uBand: { value: 9 }, uH: { value: 0 }, uAmt: { value: 0 }, uDay: { value: 0 },
    uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uChopA: wu.uChopA, uChopB: wu.uChopB,
    uFogDensity: wu.uFogDensity || { value: 0 }, uFogColor: wu.uFogColor || { value: new THREE.Color() }, uMoonVis: wu.uMoonVis || { value: 1 } };
  const ringMat = keep(new THREE.ShaderMaterial({
    name: "RexmawRingWave", transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, uniforms: ringU,
    vertexShader: /* glsl */`
      uniform float uTime, uR, uBand, uH;
      ${SEA_HEIGHT_GLSL}
      varying float vU; varying float vK; varying vec3 vW; varying float vTh;
      void main() {
        vU = position.y;
        vTh = atan(position.z, position.x);
        float rad = max(0.5, uR + position.y * uBand * 1.6);
        vec4 w = modelMatrix * vec4(position.x * rad, 0.0, position.z * rad, 1.0);
        float bump = exp(-position.y * position.y * 2.6) * (1.0 - 0.25 * position.y);
        vK = bump;
        w.y = ${WATER_Y.toFixed(2)} + seaHeight(w.xz) + 0.12 + uH * bump;
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAmt, uDay, uFogDensity, uMoonVis; uniform vec3 uFogColor;
      varying float vU; varying float vK; varying vec3 vW; varying float vTh;
      float rh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float rn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(rh(i), rh(i + vec2(1.0, 0.0)), u.x), mix(rh(i + vec2(0.0, 1.0)), rh(i + vec2(1.0, 1.0)), u.x), u.y); }
      void main() {
        float n = rn(vec2(vTh * 60.0, vU * 3.0 - uTime * 2.0)) * 0.6 + rn(vec2(vTh * 170.0, vU * 6.0 + uTime)) * 0.4;
        float crest = smoothstep(0.55, 0.95, vK) * (0.55 + 0.6 * n);
        vec3 water = mix(vec3(0.004, 0.012, 0.016), vec3(0.02, 0.1, 0.13), uDay);
        vec3 foam = mix(vec3(0.5, 0.56, 0.62) * (0.45 + 0.6 * uMoonVis), vec3(0.9, 0.94, 0.96), uDay);
        vec3 col = mix(water, foam, clamp(crest, 0.0, 1.0));
        float fd = uFogDensity * length(cameraPosition - vW) * 0.6;
        float seen = exp(-fd * fd);
        float a = smoothstep(0.0, 0.25, vK) * uAmt * (0.55 + 0.45 * crest);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uFogColor, col, seen), a);
      }`,
  }));
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = "whale-ring"; ring.visible = false; ring.frustumCulled = false; ring.renderOrder = 4;
  ring.layers.set(LAYERS.NOREFLECT);
  root.add(ring);

  // ---- State ----
  const st = new Map();               // event id → this module's own record for it
  const rings = [];                   // for weather.js: [{x, z, r, h, band}]
  const flights = [];                 // fish in flight (a catch onto the deck, the whale's rain): {x, y, z, vx, vy, vz, t, life, deck}
  for (let i = 0; i < 28; i++) flights.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 1, tx: 0, ty: 0, tz: 0, deck: false, sx: 0, sy: 0, sz: 0 });
  const used = { gerald: 0, whale: 0, turtle: 0, admiral: 0 };
  const n = { dolphins: 0, fish: 0, gulls: 0, jellies: 0 };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ");
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  const _cam = new THREE.Vector3(), _f = new THREE.Vector3(), _sw = { h: 0, dx: 0, dz: 0 };
  const Zf = new THREE.Vector3(0, 0, 1);
  let time = 0, zap = 0, swimPh = 0;

  const surf = (x, z) => (water?.swellAt ? water.swellAt(x, z, _sw).h : 0);
  /** A world heading (deg, 0 = +z) and pitch (rad, + nose up) and roll (rad) → the quaternion (a geometry nose at +z). */
  function orient(q, headingDeg, pitch = 0, roll = 0) { _e.set(-pitch, -headingDeg * DEG, roll, "YXZ"); return q.setFromEuler(_e); }
  /** A frame from a forward direction in the vertical plane whose side axis is `side` (the whale's loop, Gerald's arc). */
  function frame(q, fwd, side, roll = 0) {
    _z.copy(fwd).normalize(); _x.copy(side).normalize(); _y.crossVectors(_z, _x).normalize(); _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z); q.setFromRotationMatrix(_m);
    if (roll) q.multiply(_q2.setFromAxisAngle(Zf, roll));
    return q;
  }
  function place(m, x, y, z, q, scale) {
    m.position.set(x, y, z); m.quaternion.copy(q);
    if (scale != null) m.scale.setScalar(scale);
    m.visible = true;
  }
  function inst(m, i, x, y, z, q, scale) { _m.compose(_p.set(x, y, z), q, _s.setScalar(scale)); m.setMatrixAt(i, _m); }
  /** Follow the core's 10 Hz spot smoothly (snap when far: a new event, a jump). */
  function follow(c, x, z, d, tau = 0.35) {
    if (!fin(x) || !fin(z)) return;
    if (!fin(c.x) || Math.hypot(x - c.x, z - c.z) > 80) { c.x = x; c.z = z; return; }
    const k = 1 - Math.exp(-d / tau);
    c.x += (x - c.x) * k; c.z += (z - c.z) * k;
  }
  /** The scene's clock for a phase, synced to the core's `phaseT` (10 Hz) without stepping. */
  function clock(c, phase, phaseT, d) {
    if (c.phase !== phase) { c.phase = phase; c.clock = fin(phaseT) ? +phaseT : 0; return c.clock; }
    c.clock += d;
    if (fin(phaseT)) { const e = +phaseT - c.clock; c.clock += Math.abs(e) > 0.3 ? e : e * Math.min(1, d * 2); }
    return c.clock;
  }
  const near = (x, z, m = 700) => Math.hypot(x - _cam.x, z - _cam.z) < m;

  function begin(dt) {
    const d = clamp(+dt || 0, 0, 0.1);
    time += d; swimPh += d;
    zap = Math.max(0, zap - d * 2.2);
    runQueue(d);
    R.camera.getWorldPosition(_cam);
    for (const k of Object.keys(used)) used[k] = 0;
    n.dolphins = 0; n.fish = 0; n.gulls = 0; n.jellies = 0;
    rings.length = 0;
    for (const c of st.values()) c.seen = false;
    const day = R.atmos?.day || 0;
    jellyU.uDay.value = day; ringU.uDay.value = day; jellyU.uZap.value = zap;
    return d;
  }

  /** One whacky event's frame: `rec` = seaevents' record {id, kind, stage, k, t, liveT}, `e` = the state row. */
  function step(rec, e, d) {
    let c = st.get(rec.id);
    if (!c) { c = { id: rec.id, kind: rec.kind, x: NaN, z: NaN, phase: null, clock: 0, seed: (hash(rec.id) % 1000) / 1000, fired: {} }; st.set(rec.id, c); }
    c.seen = true;
    const k = rec.k;
    if (k < 0.01) return;
    switch (rec.kind) {
      case "gerald": stepGerald(c, rec, e, d, k); break;
      case "sky_whale": stepWhale(c, rec, e, d, k); break;
      case "dolphins": stepDolphins(c, rec, e, d, k); break;
      case "flying_fish": stepFish(c, rec, e, d, k); break;
      case "jellyfish": stepJelly(c, rec, e, d, k); break;
      case "turtle": stepTurtle(c, rec, e, d, k); break;
      case "admiral": stepAdmiral(c, rec, e, d, k); break;
      default: break;
    }
  }

  /** One mesh per kind: a live event takes it over from one still settling away (0 free, 1 settling, 2 live). */
  function claimMesh(kind, rec) {
    const lvl = rec.seen && rec.stage !== "over" ? 2 : 1;
    if (used[kind] >= lvl) return false;
    used[kind] = lvl;
    return true;
  }

  // ---- Gerald ----
  function stepGerald(c, rec, e, d, k) {
    if (!claimMesh("gerald", rec)) return;
    const mat = gerald.material.userData.uSwim;
    if (rec.stage === "warn") {
      // The fin circling (the body under the water), the circle closing on her.
      follow(c, +e.x, +e.z, d);
      const ta = fin(e.fin?.a) ? +e.fin.a : null;
      c.a = ta == null ? (c.a || 0) + 0.35 * d : fin(c.a) && Math.abs(c.a - ta) < 0.6 ? c.a + 0.35 * d + (ta - c.a) * Math.min(1, d) : ta;
      const x = c.x + Math.cos(c.a) * 40, z = c.z + Math.sin(c.a) * 40;
      const hd = c.a / DEG;            // the tangent of (cos a, sin a) as a heading (0 = +z, + toward −x) is a itself
      place(gerald, x, WATER_Y - 4.6 + surf(x, z) * 0.6 - (1 - k) * 4, z, orient(_q, hd, 0, 0.12), SIZE.gerald);
      mat.set(swimPh * 3.2, 0.05, swimPh * 2, 0.4);
      if (near(x, z, 500) && Math.random() < d * 4) fx?.spray?.(_v.set(x - Math.sin(hd * DEG) * 3, WATER_Y + 0.3, z + Math.cos(hd * DEG) * 3), { dirX: -Math.sin(hd * DEG), dirZ: Math.cos(hd * DEG), amount: 0.5 });
      return;
    }
    const L = e.launch, D = e.land;
    if (!L || !D || !fin(L.x) || !fin(D.x)) { gerald.visible = false; return; }
    const rise = fin(e.rise) ? +e.rise : 2.4, air = fin(e.air) ? +e.air : 4.4, apex = fin(e.apex) ? +e.apex : 38;
    const phase = String(e.phase || "rise");
    const t = clock(c, phase, e.phaseT, d);
    const span = Math.max(1, Math.hypot(D.x - L.x, D.z - L.z));
    const hd = fin(e.heading) ? +e.heading : Math.atan2(-(D.x - L.x), D.z - L.z) / DEG;
    // The marks on the water: a dark churn where he comes up; where he'll land, dark with a red edge, pulsing.
    if (phase === "rise" || phase === "air") {
      swirl(`${rec.id}|land`, D.x, D.z, 15 + 3 * Math.sin(time * 6), k * 0.75, "#e8553a", 1.4, 0.85);
      c.pulseT = (c.pulseT ?? 0) - d;
      if (c.pulseT <= 0) { c.pulseT = 0.9; water?.pulse?.({ x: D.x, z: D.z, color: "#ff5a3c", speed: 9, intensity: 0.9 }); }
    }
    if (phase === "rise") {
      swirl(`${rec.id}|up`, L.x, L.z, 18, k * smooth(0, 1, t / rise), "#0a1418", 0.8, 0.95);
      if (near(L.x, L.z) && Math.random() < d * 6) fx?.bubbles?.(_v.set(L.x + (Math.random() - 0.5) * 12, WATER_Y, L.z + (Math.random() - 0.5) * 12), { seconds: 0.8, radius: 5 });
      // Rising in the dark water: the fin breaks the surface last.
      const y = WATER_Y - 14 + 9 * smooth(0, 1, t / rise);
      place(gerald, L.x, y, L.z, orient(_q, hd, 0.35 * smooth(0.4, 1, t / rise)), SIZE.gerald);
      mat.set(swimPh * 6, 0.09, swimPh * 4, 0.6);
      return;
    }
    if (phase === "air") {
      const kk = clamp((t - rise) / air, 0, 1);
      const x = L.x + (D.x - L.x) * kk, z = L.z + (D.z - L.z) * kk;
      const y = WATER_Y - 6 + (apex + 6) * 4 * kk * (1 - kk);
      const dy = (apex + 6) * 4 * (1 - 2 * kk) / span;            // the slope of the arc
      const f = _v.set(-Math.sin(hd * DEG), dy, Math.cos(hd * DEG));
      frame(_q, f, _p.set(Math.cos(hd * DEG), 0, Math.sin(hd * DEG)), Math.PI * smooth(0.15, 0.85, kk));   // a half barrel roll: belly up at the top
      place(gerald, x, y, z, _q, SIZE.gerald);
      mat.set(swimPh * 9, 0.13, swimPh * 7, 0.9);                  // thrashing
      if (!c.fired.launch) { c.fired.launch = true; splash(L.x, L.z, 5); }
      return;
    }
    // Swimming off: the fin again, going away from the landing.
    follow(c, +e.x, +e.z, d);
    const fade = clamp((+e.left || 0) / 2, 0, 1);
    place(gerald, c.x, WATER_Y - 4.6 - (1 - fade) * 6, c.z, orient(_q, hd, 0), SIZE.gerald);
    mat.set(swimPh * 4, 0.07, swimPh * 2, 0.4);
  }

  // ---- The sky whale ----
  /** The whale's place and heading along its flight at `t` s after the breach (bx, bz → flop along u; side s fixed). */
  function whaleAt(out, e, t) {
    const T = { ...WHALE_T, ...(e.times || {}) };
    const bx = +e.bx, bz = +e.bz, fx_ = +e.flop.x, fz_ = +e.flop.z;
    const L = Math.max(60, Math.hypot(fx_ - bx, fz_ - bz)), ux = (fx_ - bx) / L, uz = (fz_ - bz) / L;
    const t1 = T.breach, t2 = t1 + T.climb, t3 = t2 + T.loop, t4 = t3 + T.glide, t5 = t4 + T.dive;
    const h = (a, b, s) => a + (b - a) * s;
    let along, y;
    const loopR = 48, A1 = L * 0.22, A2 = L * 0.32, A3 = L * 0.78, Y1 = 150, Y3 = 120;
    if (t < t1) { const s = t / t1; along = 0; y = -32 + 72 * (1 - (1 - s) * (1 - s)); }
    else if (t < t2) { const s = smooth(0, 1, (t - t1) / T.climb); along = h(0, A1, s); y = h(40, Y1, Math.sin(s * Math.PI / 2)); }
    else if (t < t3) {
      // The loop: up and over backwards, through the clouds, drifting on a little.
      const s = (t - t2) / T.loop, th = s * Math.PI * 2;
      along = h(A1, A2, s) + Math.sin(th) * loopR; y = Y1 + loopR - Math.cos(th) * loopR;
    } else if (t < t4) { const s = smooth(0, 1, (t - t3) / T.glide); along = h(A2, A3, s); y = h(Y1, Y3, s); }
    else if (t < t5) { const s = clamp((t - t4) / T.dive, 0, 1); along = h(A3, L, s); y = Y3 * (1 - s) * (1 - s); }   // flat at the end: a belly-flop
    else { along = L; y = -Math.min(30, (t - t5) * 4); }
    out.x = bx + ux * along; out.z = bz + uz * along; out.y = WATER_Y + y; out.ux = ux; out.uz = uz;
    return out;
  }
  const _w0 = {}, _w1 = {};
  function stepWhale(c, rec, e, d, k) {
    if (!claimMesh("whale", rec)) return;
    const mat = whale.material.userData.uSwim;
    if (rec.stage === "warn" || !e.flop || !fin(e.bx) || !fin(e.flop.x)) {
      // Its back rolling at the surface, and its blows.
      follow(c, +e.x, +e.z, d);
      const hd = fin(e.heading) ? +e.heading : c.seed * 360;
      place(whale, c.x, WATER_Y - 3.4 - (1 - k) * 6 + Math.sin(time * 0.7) * 0.7, c.z, orient(_q, hd, 0.02 * Math.sin(time * 0.7)), SIZE.whale);
      mat.set(swimPh * 1.4, 0.03, swimPh, 0.2);
      // A blow every few seconds: a column of spray ~12 m up off its blowhole.
      c.blowT = (c.blowT ?? 0.5) - d;
      if (c.blowT < 0) {
        c.blowT = 3.4;
        if (near(c.x, c.z, 1100)) {
          const bx = c.x - Math.sin(hd * DEG) * SIZE.whale * 0.26, bz = c.z + Math.cos(hd * DEG) * SIZE.whale * 0.26;
          for (let i = 0; i < 5; i++) fx?.steam?.(_v.set(bx, WATER_Y + 2 + i * 2.6, bz));
          fx?.splash?.(_v.set(bx, WATER_Y + 1.5, bz), { scale: 1.6 });
        }
      }
      return;
    }
    const t = clock(c, "fly", e.t, d);
    whaleAt(_w0, e, t); whaleAt(_w1, e, t + 0.08);
    const f = _f.set(_w1.x - _w0.x, _w1.y - _w0.y, _w1.z - _w0.z);
    if (f.lengthSq() < 1e-6) f.set(_w0.ux, 0, _w0.uz);
    const T = { ...WHALE_T, ...(e.times || {}) };
    const flopAt = T.breach + T.climb + T.loop + T.glide + T.dive;
    if (t > flopAt) f.set(_w0.ux, 0, _w0.uz);                       // lying flat after the flop
    else if (t > flopAt - T.dive) {
      // The dive levels out: it comes down flat on its belly (the whole point).
      const s = smooth(0.2, 0.75, (t - (flopAt - T.dive)) / T.dive);
      f.normalize().lerp(_y.set(_w0.ux, 0, _w0.uz), s);
    }
    // Breaking the surface: white water round it while it comes up.
    if (t < T.breach && near(_w0.x, _w0.z, 800) && Math.random() < d * 14) {
      const a = Math.random() * Math.PI * 2;
      fx?.spray?.(_v.set(_w0.x + Math.cos(a) * 8, WATER_Y + 0.4, _w0.z + Math.sin(a) * 8), { dirX: Math.cos(a), dirZ: Math.sin(a), amount: 1.6 });
    }
    // Its side axis is fixed (the whole flight is in one vertical plane): the loop goes properly over the top.
    frame(_q, f, _p.set(_w0.uz, 0, -_w0.ux));
    const sink = t > flopAt ? smooth(flopAt, flopAt + 7, t) : 0;
    place(whale, _w0.x, _w0.y - sink * 8, _w0.z, _q, SIZE.whale);
    whale.visible = sink < 0.98;
    mat.set(swimPh * 1.8, t > flopAt ? 0.03 : 0.06, swimPh * 1.3, 0.5);
    if (!c.fired.breach && t < 2) { c.fired.breach = true; splash(+e.bx, +e.bz, 6); }
    // Through the clouds: mist streaming off it up high.
    if (_w0.y > WATER_Y + 120 && Math.random() < d * 6) fx?.steam?.(_v.set(_w0.x + (Math.random() - 0.5) * 20, _w0.y, _w0.z + (Math.random() - 0.5) * 20));
    // The ring wave.
    const rg = e.ring;
    if (rg && fin(rg.r) && fin(rg.max) && +rg.r < +rg.max) {
      const r = +rg.r, band = fin(rg.band) ? +rg.band : 9, hgt = 5.2 * (1 - r / +rg.max) * (0.4 + 0.6 * smooth(0, 30, r));
      rings.push({ x: +e.flop.x, z: +e.flop.z, r, h: hgt, band });
      ring.position.set(+e.flop.x, 0, +e.flop.z);
      ringU.uR.value = r; ringU.uBand.value = band; ringU.uH.value = hgt; ringU.uAmt.value = 1 - smooth(+rg.max * 0.75, +rg.max, r);
      ring.visible = true;
      c.ringOn = true;
    } else if (c.ringOn) ring.visible = false;
  }

  // ---- The dolphins ----
  function stepDolphins(c, rec, e, d, k) {
    const hd = fin(e.heading) ? +e.heading : 0, v = fin(e.speed) ? +e.speed : 0;
    // The pod's spot, carried on by its own speed between the core's ticks.
    if (fin(c.x) && rec.stage === "active") { c.x += -Math.sin(hd * DEG) * v * d; c.z += Math.cos(hd * DEG) * v * d; }
    follow(c, +e.x, +e.z, d, 0.6);
    const warn = rec.stage === "warn";
    for (let i = 0; i < DOLPHINS && n.dolphins < DOLPHINS; i++) {
      const s = (hash(`${rec.id}d${i}`) % 1000) / 1000;
      // The formation (or a ring while they're only splashing about far off).
      let ox, oz, ringA = 0;
      if (warn) { ringA = i / DOLPHINS * Math.PI * 2 + time * 0.3; ox = Math.cos(ringA) * 14; oz = Math.sin(ringA) * 14; }
      else { const lat = (i - (DOLPHINS - 1) / 2) * 3.4, back = -Math.abs(i - (DOLPHINS - 1) / 2) * 3 + s * 2; ox = Math.cos(hd * DEG) * lat - Math.sin(hd * DEG) * back; oz = Math.sin(hd * DEG) * lat + Math.cos(hd * DEG) * back; }
      // Leaping in turns: 2.4 s a cycle, ~0.95 s of it in the air.
      const cyc = (time / 2.4 + s + i * 0.17) % 1, air = cyc < 0.4 ? cyc / 0.4 : -1;
      const x = c.x + ox, z = c.z + oz;
      let y = WATER_Y - 0.3 + 0.25 * Math.sin(time * 3 + i), pitch = 0;      // awash between leaps: backs and fins showing
      if (air >= 0) { y = WATER_Y - 0.6 + 5 * 4 * air * (1 - air); pitch = Math.atan(5 * 4 * (1 - 2 * air) / (Math.max(6, v) * 0.95)); }
      if (air >= 0 && air < 0.06 && near(x, z, 260) && Math.random() < 0.5) fx?.spray?.(_v.set(x, WATER_Y + 0.4, z), { dirX: -Math.sin(hd * DEG), dirZ: Math.cos(hd * DEG), amount: 0.6 });
      const h = warn ? ringA / DEG : hd;
      inst(dolphins, n.dolphins++, x, y - (1 - k) * 4, z, orient(_q, h, pitch), SIZE.dolphin);
    }
    dolphins.material.userData.uSwim.set(swimPh * 7, 0.08, swimPh * 4, 0.6);
  }

  // ---- The flying fish ----
  function stepFish(c, rec, e, d, k) {
    const hd = fin(e.heading) ? +e.heading : 0, v = fin(e.speed) ? +e.speed : 0;
    if (fin(c.x) && rec.stage === "active") { c.x += -Math.sin(hd * DEG) * v * d; c.z += Math.cos(hd * DEG) * v * d; }
    follow(c, +e.x, +e.z, d, 0.5);
    const m = rec.stage === "warn" ? 6 : 36;
    if (rec.stage === "warn") swirl(`${rec.id}|fish`, c.x, c.z, 20, k * 0.7, "#9fd0ff", 0.6, 0.15);
    const fwx = -Math.sin(hd * DEG), fwz = Math.cos(hd * DEG);
    for (let i = 0; i < m && n.fish < FISH; i++) {
      const s = (hash(`${rec.id}f${i}`) % 1000) / 1000, s2 = (hash(`${rec.id}g${i}`) % 1000) / 1000;
      const lat = (s - 0.5) * 18, along = (s2 - 0.5) * 26;
      const x = c.x + fwz * lat + fwx * along, z = c.z - fwx * lat + fwz * along;
      // Gliding a metre or three up, skipping off the water now and then.
      const ph = time * 1.3 + s * 9;
      const y = WATER_Y + (rec.stage === "warn" ? 0.4 + 1.2 * Math.max(0, Math.sin(ph * 2)) : 1.2 + 2.4 * Math.abs(Math.sin(ph))) - (1 - k) * 3;
      inst(fishes, n.fish++, x, y, z, orient(_q, hd + (s - 0.5) * 16, 0.1 * Math.cos(ph)), SIZE.fish);
    }
  }

  // ---- The jellyfish ----
  function stepJelly(c, rec, e, d, k) {
    follow(c, +e.x, +e.z, d, 1);
    const r = fin(e.r) ? +e.r : 120;
    const amt = k * (rec.stage === "warn" ? 0.35 : Math.max(0.2, fin(e.amt) ? +e.amt : 1));
    jellyU.uAmt.value = Math.max(jellyU.uAmt.value * 0, amt);
    for (let i = 0; i < JELLIES && n.jellies < JELLIES; i++) {
      const a = (hash(`${rec.id}a${i}`) % 6283) / 1000, rr = Math.sqrt((hash(`${rec.id}r${i}`) % 1000) / 1000) * r * 0.92;
      const x = c.x + Math.cos(a) * rr + Math.sin(time * 0.2 + i) * 3, z = c.z + Math.sin(a) * rr + Math.cos(time * 0.17 + i * 1.3) * 3;
      const size = 5 + ((hash(`${rec.id}s${i}`) % 1000) / 1000) * 6;
      const hue = (hash(`${rec.id}h${i}`) % 1000) / 1000;
      const y = WATER_Y + surf(x, z) - size * (rec.stage === "warn" ? 0.75 : 0.22) + Math.sin(time * 1.1 + i) * 0.5;
      const j = n.jellies++;
      _m.compose(_p.set(x, y, z), _q.identity(), _s.set(size, size * 0.9, size)); jellies.setMatrixAt(j, _m);
      jAttr.setXYZW(j, i * 1.37, size, hue, 1);
      _m.compose(_p.set(x, WATER_Y + surf(x, z) + 0.6, z), _q.identity(), _s.set(size * 2.6, 1, size * 2.6)); pools.setMatrixAt(j, _m);
      pAttr.setXYZW(j, i * 1.37, size, hue, 1);
    }
  }

  // ---- The island turtle ----
  function stepTurtle(c, rec, e, d, k) {
    if (!claimMesh("turtle", rec)) return;
    const hd = fin(e.heading) ? +e.heading : c.seed * 360, v = fin(e.speed) ? +e.speed : 0;
    if (fin(c.x) && rec.stage === "active") { c.x += -Math.sin(hd * DEG) * v * d; c.z += Math.cos(hd * DEG) * v * d; }
    follow(c, +e.x, +e.z, d, 0.8);
    c.hd = fin(c.hd) ? c.hd + ((((hd - c.hd) % 360) + 540) % 360 - 180) * Math.min(1, d / 1.5) : hd;
    const mat = turtle.material.userData.uSwim;
    if (rec.stage === "warn") {
      // A great dark shape under the water, bubbles coming up.
      swirl(`${rec.id}|shape`, c.x, c.z, 42, k, "#05100c", 0.25, 0.95);
      if (near(c.x, c.z, 700) && Math.random() < d * 5) fx?.bubbles?.(_v.set(c.x + (Math.random() - 0.5) * 40, WATER_Y, c.z + (Math.random() - 0.5) * 40), { seconds: 1, radius: 6 });
      turtle.visible = false; chest.visible = false;
      return;
    }
    const lt = rec.liveT || 0, left = fin(e.left) ? +e.left : 99;
    const up = smooth(0, 5, lt) * smooth(0, 6, left);
    const y = WATER_Y - 16 + 13.2 * up + Math.sin(time * 0.5) * 0.4;
    // The flippers churn the water at her sides.
    if (up > 0.8 && near(c.x, c.z, 500) && Math.random() < d * 3) {
      const s = Math.random() < 0.5 ? -1 : 1, fw = Math.random() < 0.6 ? 0.45 : -0.75;
      const lx = s * 1.2 * SIZE.turtle, lz = fw * SIZE.turtle, hr = c.hd * DEG;
      fx?.spray?.(_v.set(c.x + Math.cos(hr) * lx - Math.sin(hr) * lz, WATER_Y + 0.4, c.z + Math.sin(hr) * lx + Math.cos(hr) * lz), { dirX: Math.cos(hr) * s, dirZ: Math.sin(hr) * s, amount: 1.2 });
    }
    const pitch = 0.02 * Math.sin(time * 0.5);
    orient(_q, c.hd, pitch);
    place(turtle, c.x, y, c.z, _q, SIZE.turtle);
    mat.set(0, 0, time * 1.1, 1);
    if (!c.fired.surface && lt > 0.5) { c.fired.surface = true; if (near(c.x, c.z, 900)) for (let i = 0; i < 6; i++) splash(c.x + (Math.random() - 0.5) * 50, c.z + (Math.random() - 0.5) * 50, 3); }
    // The chest on the sand by the palm (gone once she's given it up).
    if (!e.taken && !c.fired.taken) {
      _v.set(-0.1 * SIZE.turtle, 0.4 * SIZE.turtle, 0.08 * SIZE.turtle).applyQuaternion(_q);
      place(chest, c.x + _v.x, y + _v.y, c.z + _v.z, _q, SIZE.turtle);
      c.chestAt = { x: c.x + _v.x, y: y + _v.y, z: c.z + _v.z };
    } else chest.visible = false;
  }

  // ---- The Seagull Admiral and the squadron ----
  function stepAdmiral(c, rec, e, d, k) {
    if (!claimMesh("admiral", rec)) return;
    const mode = String(e.mode || "fly");
    follow(c, +e.x, +e.z, d, 0.5);
    const hd0 = fin(e.heading) ? +e.heading : 0;
    let cx = c.x, cz = c.z, alt = 26, hd = hd0;
    if (rec.stage === "warn") { const a = time * 0.5; cx += Math.cos(a) * 30; cz += Math.sin(a) * 30; alt = 42; hd = a / DEG; }
    else if (mode === "inspect" || (mode === "leave" && e.medal && (c.leaveT = (c.leaveT ?? 0) + d) < 3)) {
      const a = time * 0.45; cx += Math.cos(a) * 32; cz += Math.sin(a) * 32; alt = 34; hd = a / DEG;      // circling over her mastheads
    } else if (mode === "leave") alt = 26 + (c.climb = (c.climb ?? 0) + d * 6);
    // A dive: down onto her deck and up again (1.5 s), on each `dive` event.
    c.dive = Math.max(0, (c.dive ?? 0) - d / 1.5);
    if (c.dive > 0) alt = 26 - 20 * Math.sin((1 - c.dive) * Math.PI);
    const pitch = c.dive > 0 ? -0.8 * Math.cos((1 - c.dive) * Math.PI) : 0;
    c.alt = fin(c.alt) ? c.alt + (alt - c.alt) * Math.min(1, d * 2.5) : alt;
    const y = WATER_Y + c.alt - (1 - k) * 20;
    orient(_q, hd, pitch, Math.sin(time * 0.9) * 0.1);
    place(admiral, cx, y, cz, _q, SIZE.admiral);
    admiral.material.userData.uSwim.set(0, 0, time * 7, 0.55);
    // The V behind the Admiral.
    const fx_ = -Math.sin(hd * DEG), fz_ = Math.cos(hd * DEG), px = fz_, pz = -fx_;
    for (let i = 0; i < GULLS && n.gulls < GULLS; i++) {
      const row = Math.floor(i / 2) + 1, side = i % 2 ? 1 : -1;
      const x = cx - fx_ * row * 5 + px * side * row * 4.5, z = cz - fz_ * row * 5 + pz * side * row * 4.5;
      inst(gulls, n.gulls++, x, y + row * 0.6 + Math.sin(time * 2 + i) * 0.5, z, orient(_q2, hd, pitch, Math.sin(time * 1.3 + i) * 0.15), SIZE.gull);
    }
    gulls.material.userData.uSwim.set(0, 0, time * 9, 0.6);
  }

  function splash(x, z, scale) {
    if (!near(x, z, 900)) return;
    fx?.splash?.(_v.set(x, WATER_Y + 0.2, z), { scale });
    water?.pulse?.({ x, z, color: "#dfe8ff", speed: 10 + scale * 2, intensity: 0.6 });
    // A big one keeps throwing water for a moment and leaves a wide ring of foam.
    if (scale >= 5) {
      fx?.foam?.(_v.set(x, WATER_Y + 0.1, z), { radius: scale * 3.2, life: 6, alpha: 0.9 });
      for (let i = 1; i <= 3; i++) later(i * 0.16, () => { fx?.splash?.(_v.set(x + (Math.random() - 0.5) * scale * 2, WATER_Y + 0.2, z + (Math.random() - 0.5) * scale * 2), { scale: scale * 0.7 }); fx?.sheet?.(_v.set(x, WATER_Y + 2 + i * 2, z), { count: 40, radius: scale }); });
    }
  }
  /** A beat a moment later (scene time; no timers): the splashes that keep coming. */
  const queue = [];
  function later(s, fn) { if (queue.length < 32) queue.push({ t: s, fn }); }
  function runQueue(d) {
    for (let i = queue.length - 1; i >= 0; i--) { const q = queue[i]; q.t -= d; if (q.t <= 0) { queue.splice(i, 1); try { q.fn(); } catch { /* an effect is a nicety */ } } }
  }

  /** The fish in flight: onto her deck (a catch), or raining down round the whale's splash. */
  function launchFish(x, y, z, tx, ty, tz, life, deck) {
    const f = flights.find((q) => !q.live);
    if (!f) return;
    Object.assign(f, { live: true, x, y, z, sx: x, sy: y, sz: z, tx, ty, tz, t: 0, life, deck });
  }
  function stepFlights(d) {
    for (const f of flights) {
      if (!f.live) continue;
      f.t += d;
      const s = clamp(f.t / f.life, 0, 1);
      f.x = f.sx + (f.tx - f.sx) * s; f.z = f.sz + (f.tz - f.sz) * s;
      f.y = f.sy + (f.ty - f.sy) * s + (f.deck ? 6 : 0) * 4 * s * (1 - s);
      if (s >= 1) {
        f.live = false;
        if (!f.deck && near(f.x, f.z, 500) && Math.random() < 0.5) fx?.spray?.(_v.set(f.x, WATER_Y + 0.3, f.z), { amount: 0.4 });
        continue;
      }
      if (n.fish < FISH) inst(fishes, n.fish++, f.x, f.y, f.z, orient(_q, (f.sx * 13 + f.t * 400) % 360, -0.6 + s, f.t * 9), SIZE.fish);
    }
  }

  function finish(d) {
    stepFlights(d);
    // Hide what nobody drew this frame; forget events that left (and their own state).
    if (!used.gerald) gerald.visible = false;
    if (!used.whale) { whale.visible = false; ring.visible = false; }
    if (!used.turtle) { turtle.visible = false; chest.visible = false; }
    if (!used.admiral) admiral.visible = false;
    if (!rings.length) ring.visible = false;
    for (const [m, cnt] of [[dolphins, n.dolphins], [fishes, n.fish], [gulls, n.gulls]]) { m.count = cnt; if (cnt) m.instanceMatrix.needsUpdate = true; }
    jellies.count = n.jellies; pools.count = n.jellies;
    if (n.jellies) { jellies.instanceMatrix.needsUpdate = true; pools.instanceMatrix.needsUpdate = true; jAttr.needsUpdate = true; pAttr.needsUpdate = true; }
    else jellyU.uAmt.value = 0;
    for (const [id, c] of st) if (!c.seen) st.delete(id);
  }

  /** The run's `sea_event` beats for the whacky ones (one-shot effects; sound is sfx.js's, words barks.js's). */
  function event(p = {}) {
    const kind = String(p.kind || ""), stage = String(p.stage || "");
    const x = +p.x, z = +p.z;
    if (kind === "gerald") {
      if (stage === "hit" || stage === "splash") {
        const c = st.get(String(p.id));
        const lx = fin(c?.landX) ? c.landX : x, lz = fin(c?.landZ) ? c.landZ : z;
        if (fin(lx) && fin(lz)) { splash(lx, lz, p.target === "rexmaw" || p.near ? 8 : 6); if (near(lx, lz, 400)) R.cam?.trauma?.(p.target === "rexmaw" ? 0.6 : p.near ? 0.35 : 0.15); }
        if (p.target === "rexmaw") fx?.sheet?.(_v.set(x, WATER_Y + 4, z), { count: 60, radius: 6 });
      } else if (stage === "start" && p.launch && fin(p.land?.x)) {
        const c = st.get(String(p.id)); if (c) { c.landX = +p.land.x; c.landZ = +p.land.z; }
      }
    } else if (kind === "sky_whale" && stage === "flop") {
      if (fin(x) && fin(z)) {
        splash(x, z, 9);
        for (let i = 0; i < 4; i++) splash(x + (Math.random() - 0.5) * 40, z + (Math.random() - 0.5) * 40, 4);
        if (near(x, z, 600)) R.cam?.trauma?.(0.45);
        // The fish and the treasure rain down round the splash.
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 60;
          launchFish(x + (Math.random() - 0.5) * 20, WATER_Y + 25 + Math.random() * 25, z + (Math.random() - 0.5) * 20, x + Math.cos(a) * r, WATER_Y, z + Math.sin(a) * r, 1.2 + Math.random() * 1.2, false);
        }
      }
    } else if (kind === "flying_fish" && stage === "caught") {
      // A dozen land on her deck.
      for (let i = 0; i < 12; i++) {
        const sx = x + (Math.random() - 0.5) * 16, sz = z + (Math.random() - 0.5) * 16;
        const dx = (Math.random() - 0.5) * 6, dz = -10 + Math.random() * 24;
        _v.set(dx, 3.2, dz);
        if (R.shipSpace) R.shipSpace.localToWorld(_v); else _v.set(sx, WATER_Y + 3, sz);
        launchFish(sx, WATER_Y + 2, sz, _v.x, _v.y, _v.z, 0.6 + Math.random() * 0.4, true);
      }
    } else if (kind === "jellyfish" && (stage === "zap" || stage === "hit")) {
      zap = 1;
      if (fin(x) && fin(z)) water?.pulse?.({ x, z, color: "#7ff6ff", speed: 30, intensity: 0.8 });
      if (stage === "hit" && R.shipSpace) { R.shipSpace.localToWorld(_v.set(0, 1, 0)); fx?.burst?.(_v.clone(), { color: "#7ff6ff", count: 40, speed: 5, size: 0.3, life: 0.5, intensity: 5, gravity: 0 }); R.cam?.trauma?.(0.12); }
    } else if (kind === "turtle" && stage === "salvaged") {
      const c = [...st.values()].find((q) => q.kind === "turtle");
      if (c?.chestAt) fx?.burst?.(_v.set(c.chestAt.x, c.chestAt.y + 2, c.chestAt.z), { color: "#ffd27a", count: 50, speed: 3, size: 0.3, life: 1, intensity: 3.5 });
      if (c) c.fired.taken = true;
    } else if (kind === "admiral" && (stage === "dive" || stage === "medal")) {
      const c = [...st.values()].find((q) => q.kind === "admiral");
      if (c) c.dive = 1;
      if (stage === "medal" && R.shipSpace) { R.shipSpace.localToWorld(_v.set(0, 4, 2)); fx?.burst?.(_v.clone(), { color: "#ffd27a", count: 30, speed: 2, size: 0.25, life: 1, intensity: 3.5 }); }
      if (stage === "dive" && fin(x) && fin(z)) fx?.burst?.(_v.set(x, WATER_Y + 6, z), { color: "#f2f0ea", count: 24, speed: 3, size: 0.3, life: 1.2, intensity: 1.2, gravity: 2 });
    } else if (kind === "dolphins" && stage === "boost") {
      if (R.shipSpace) { R.shipSpace.localToWorld(_v.set(0, 0.5, 20)); water?.pulse?.({ x: _v.x, z: _v.z, color: "#9fe8ff", speed: 14, intensity: 0.8 }); }
    }
  }

  return {
    root,
    begin, step, finish, event,
    /** The ring waves for weather.js's heights: [{x, z, r, h, band}]. */
    get rings() { return rings; },
    stats: () => ({ gerald: gerald.visible, whale: whale.visible, turtle: turtle.visible, admiral: admiral.visible, dolphins: n.dolphins, fish: n.fish, gulls: n.gulls, jellies: n.jellies, ring: ring.visible }),
    warmShow(on) {
      for (const m of [gerald, whale, turtle, chest, admiral, ring]) m.visible = !!on;
      for (const m of [dolphins, fishes, gulls, jellies, pools]) m.count = on ? 1 : 0;
      if (on) ringU.uAmt.value = 0.001;
    },
    reset() {
      st.clear(); rings.length = 0; queue.length = 0;
      for (const f of flights) f.live = false;
      for (const m of [gerald, whale, turtle, chest, admiral, ring]) m.visible = false;
      for (const m of [dolphins, fishes, gulls, jellies, pools]) m.count = 0;
    },
    dispose() { root.removeFromParent(); for (const x of disposables) x.dispose?.(); },
  };
}
