// Night Raid: the land and the fixed things of the bay, built from world
// (core/world.js) when a night starts. Built ONCE with fixed capacities at
// load (every program compiles behind the title); setWorld() only fills
// geometry buffers and instances.
//
//   islands    world.islands[].poly (blobs, 80–400 m): a terrain mesh lofted
//              from the outline (a sand skirt running under the water, a
//              beach, hills and ridges by seeded noise; vertex colours: sand,
//              grass, jungle, rock), all islands in ONE draw. Night silhouettes
//              against the horizon glow, moonlit beaches.
//   rocks      wet, faceted rocks along the shores and a few offshore
//              (instanced, three variants)
//   palms      leaning palms on the beaches (two instanced draws)
//   huts       a few fishing villages: stilt huts, thatch, warm windows, a
//              campfire (instanced; the fires through flames.js)
//   lights     ONE additive Points draw for every hut window, torch, lantern
//              and wreck glint: lights carry through the night further than
//              the things they hang on
//   shoals     world.islands[].shoals: pale shallows and breaking surf, hidden
//              beyond 120 m of the Rexmaw until revealed (state.shoalsRevealed)
//   the fort   on world.islands[].fort: walls, four round towers, a keep, a
//              flag, guns in the embrasures facing the sea, torches; gun
//              flashes when it fires; smoke and fire once silenced
//   wrecks     world.wrecks: broken hulls awash with gold glinting in them
//              (the glint stops once salvaged)
//   the cove   world.cove: the smugglers' jetty, lanterns and a green signal lamp
//   the port   world.port: lit buoys marking the 140 m harbour zone (the GLB
//              harbour itself is ship.js's)

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LAYERS, WATER_Y } from "./blocking.js";
import { seeded, hash } from "./util.js";
import { SEA_HEIGHT_GLSL } from "./water.js";

const CAP = { rocks: 420, palms: 520, huts: 72, lights: 900, shoals: 96, wrecks: 8, fortGuns: 24, reefs: 96 };
const VERTS_MAX = 60000;
const RHO = [1.24, 1.15, 1.08, 1.03, 1.0, 0.965, 0.92, 0.86, 0.78, 0.68, 0.57, 0.45, 0.33, 0.21, 0.1, 0.03];
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

const NOISE = /* glsl */`
  float ilHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float ilNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(ilHash(i), ilHash(i + vec2(1.0, 0.0)), u.x), mix(ilHash(i + vec2(0.0, 1.0)), ilHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float ilFbm(vec2 p) { return ilNoise(p) * 0.5 + ilNoise(p * 2.03 + 5.2) * 0.3 + ilNoise(p * 4.1 - 2.7) * 0.2; }`;

/** Value noise on the CPU (seeded by an offset). */
function vnoise(x, z, s = 0) {
  const h = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  return lerp(lerp(h(i, j), h(i + 1, j), ux), lerp(h(i, j + 1), h(i + 1, j + 1), ux), uz);
}
const fbm = (x, z, s) => vnoise(x, z, s) * 0.5 + vnoise(x * 2.03 + 5.2, z * 2.03, s) * 0.3 + vnoise(x * 4.1 - 2.7, z * 4.1, s) * 0.2;

/** Wet waterline: darker and glossy low down, a weed band, mottling (Night Helm's patchWet). */
function patchWet(mat, { weed = 0.6, mottle = 0.5, key = "nr-wet" } = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vIlW;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        {
          vec4 ilP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            ilP = instanceMatrix * ilP;
          #endif
          vIlW = (modelMatrix * ilP).xyz;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vIlW;\n${NOISE}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ilH = vIlW.y - (${WATER_Y.toFixed(2)});
        float ilWet = 1.0 - smoothstep(0.15, 1.8, ilH);
        float ilN = ilNoise(vIlW.xz * 0.9 + vIlW.y) * 0.6 + ilNoise(vIlW.zy * 3.1) * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.5, ilWet) * (1.0 - ${mottle.toFixed(2)} * 0.5 + ${mottle.toFixed(2)} * ilN);
        float ilBand = 1.0 - smoothstep(0.0, 0.55, abs(ilH - 0.2));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.06, 0.035), ilBand * ${weed.toFixed(2)});`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.2, ilWet * 0.85);`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** A craggy rock of radius ~1 (Night Helm's rockGeometry). */
function rockGeometry(seed, detail = 2) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const rnd = seeded(seed);
  const ox = rnd() * 50, oy = rnd() * 50, oz = rnd() * 50;
  const n3 = (x, y, z) => (Math.sin(x * 1.7 + ox) * Math.sin(y * 2.1 + oy) * Math.sin(z * 1.9 + oz)
    + 0.5 * Math.sin(x * 3.9 + oy) * Math.sin(y * 4.3 + oz) * Math.sin(z * 3.7 + ox)
    + 0.25 * Math.sin(x * 8.1 + oz) * Math.sin(y * 7.3 + ox) * Math.sin(z * 8.9 + oy));
  const flat = 0.55 + rnd() * 0.5;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + 0.32 * n3(x, y, z);
    x *= d; y *= d; z *= d;
    if (y > flat) y = flat + (y - flat) * 0.3;
    if (y < 0) { x *= 1.18; z *= 1.18; }
    y *= 0.85;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/** A broken hull ~24 m long, lying awash, ribs bared, mast snapped (Night Helm's wreck). */
function wreckGeometry() {
  const wood = [];
  const hull = new THREE.CylinderGeometry(3.2, 3.2, 20, 14, 4, true, Math.PI * 0.55, Math.PI * 0.95);
  hull.rotateX(Math.PI / 2); hull.scale(1, 0.85, 1);
  wood.push(hull);
  const bowCap = new THREE.ConeGeometry(3.0, 5, 10, 1, true, Math.PI * 0.55, Math.PI * 0.95);
  bowCap.rotateX(Math.PI / 2); bowCap.scale(1, 0.85, 1); bowCap.translate(0, 0, 12.4);
  wood.push(bowCap);
  for (let k = 0; k < 8; k++) {
    const arc = Math.PI * (0.55 + 0.35 * ((k * 37) % 7) / 7);
    const rib = new THREE.TorusGeometry(3.25, 0.13, 5, 10, arc);
    rib.rotateY(Math.PI / 2); rib.rotateX(Math.PI * 0.5 - arc * 0.15); rib.translate(0, 0, -8 + k * 2.2);
    wood.push(rib);
  }
  const mast = new THREE.CylinderGeometry(0.22, 0.3, 9, 8);
  mast.translate(0, 4.5, 0); mast.rotateZ(-0.7); mast.rotateX(0.15); mast.translate(0.5, 0.8, 2);
  wood.push(mast);
  const yard = new THREE.CylinderGeometry(0.12, 0.12, 6, 6);
  yard.rotateZ(Math.PI / 2 + 0.3); yard.translate(4.4, 5.5, 2.5);
  wood.push(yard);
  for (let k = 0; k < 5; k++) {
    const plank = new THREE.BoxGeometry(0.25, 0.08, 3 + k * 0.4);
    plank.rotateX(0.4 - k * 0.2); plank.rotateY(k * 0.7); plank.translate(-1.5 + k * 0.8, 1.2 + (k % 2) * 0.4, -4 + k * 2.6);
    wood.push(plank);
  }
  return mergeClean(wood);
}

/** Merge geometries keeping position/normal/uv (+ optional flat colour per part). */
function mergeClean(list, colors = null) {
  const prepped = list.map((g, i) => {
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) { const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n); for (let k = 0; k < n; k++) idx[k] = k; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    if (colors) {
      const c = new THREE.Color(colors[i]);
      const col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    }
    return g;
  });
  const out = mergeGeometries(prepped, false);
  prepped.forEach((g) => g.dispose());
  return out;
}

/** A palm: a leaning, tapering trunk (origin at its foot) and a crown of drooping fronds. */
function palmGeometries() {
  const trunk = [];
  const H = 9, N = 7;
  let x = 0, y = 0;
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N;
    const r0 = lerp(0.32, 0.17, t0), r1 = lerp(0.32, 0.17, t1);
    const h = H / N;
    const seg = new THREE.CylinderGeometry(r1, r0 * 1.06, h * 1.02, 7, 1);
    const lean = 0.06 + t0 * 0.16;
    seg.rotateZ(-lean);
    seg.translate(x + Math.sin(lean) * h / 2, y + h / 2, 0);
    x += Math.sin(lean) * h; y += Math.cos(lean) * h;
    trunk.push(seg);
  }
  const top = new THREE.Vector3(x, y, 0);
  const fronds = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + (k % 2) * 0.2;
    const L = 4.2 + (k % 3) * 0.5;
    const g = new THREE.PlaneGeometry(0.9, L, 1, 6);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = (p.getY(i) + L / 2) / L;               // 0 at the crown → 1 at the tip
      const w = p.getX(i) * Math.sin(Math.PI * Math.min(1, v * 1.1 + 0.05));
      // Out along +X, drooping.
      p.setXYZ(i, v * L * 0.92, 0.6 - v * v * L * 0.55, w);
    }
    g.computeVertexNormals();
    g.rotateY(a);
    g.translate(top.x, top.y, top.z);
    fronds.push(g);
  }
  // Coconuts.
  for (let k = 0; k < 3; k++) { const c = new THREE.SphereGeometry(0.2, 6, 4); c.translate(top.x + Math.cos(k * 2.1) * 0.3, top.y - 0.35, Math.sin(k * 2.1) * 0.3); trunk.push(c); }
  return { trunk: mergeClean(trunk), crown: mergeClean(fronds) };
}

/** A stilt hut: floor, walls, a thatched hip roof, a door; vertex colours. Window at (0, 2.3, 2.1). */
function hutGeometry() {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  for (const [x, z] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) { const s = new THREE.CylinderGeometry(0.12, 0.14, 1.4, 5); s.translate(x, 0.7, z); add(s, "#3a2a1c"); }
  const floor = new THREE.BoxGeometry(4.4, 0.2, 4.4); floor.translate(0, 1.45, 0); add(floor, "#4a3624");
  const walls = new THREE.BoxGeometry(3.8, 2.2, 3.8); walls.translate(0, 2.6, 0); add(walls, "#5e4630");
  const roof = new THREE.ConeGeometry(3.6, 2.4, 4, 1); roof.rotateY(Math.PI / 4); roof.translate(0, 4.9, 0); add(roof, "#6e5a36");
  const door = new THREE.BoxGeometry(0.9, 1.5, 0.08); door.translate(-0.9, 2.25, 1.92); add(door, "#1c130c");
  return mergeClean(parts, cols);
}

/** The fort's pieces, local to its centre (seaward = +Z): vertex-coloured stone. Returns {geo, guns, torches, flag}. */
function fortGeometry(nGuns) {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  const STONE = "#6a665e", DARK = "#2a2824", ROOF = "#3c2a22", IRON = "#141414";
  const S = 24, H = 8, T = 3;
  // Walls: four sides, a gate in the landward (−Z) wall.
  const wall = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(z1 - z0, x1 - x0);
    const g = new THREE.BoxGeometry(len, H, T);
    g.rotateY(-a); g.translate((x0 + x1) / 2, H / 2, (z0 + z1) / 2);
    add(g, STONE);
    // Crenellations along the outer edge.
    const n = Math.floor(len / 2.4);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const m = new THREE.BoxGeometry(1.2, 1.1, 0.8);
      m.rotateY(-a);
      const nx = -Math.sin(a), nz = Math.cos(a);           // outward-ish normal (sign fixed below by the caller's winding)
      m.translate(lerp(x0, x1, t) + nx * (T / 2 - 0.4), H + 0.55, lerp(z0, z1, t) + nz * (T / 2 - 0.4));
      add(m, STONE);
    }
  };
  wall(-S, S, S, S);       // seaward
  wall(S, S, S, -S);       // east
  wall(-S, -S, -S, S);     // west
  wall(-5, -S, -S, -S);    // landward, either side of the gate
  wall(S, -S, 5, -S);
  const gate = new THREE.BoxGeometry(10, 3, T + 0.4); gate.translate(0, H - 1.5, -S); add(gate, STONE);
  const gdoor = new THREE.BoxGeometry(6, 5, 0.4); gdoor.translate(0, 2.5, -S - T / 2 - 0.1); add(gdoor, DARK);
  // Four round towers (Rexmaw Raids: their own instanced draw, towerGeometry(), so each can fall); their footings stay.
  const torches = [];
  const towers = [];
  for (const [x, z] of [[-S, S], [S, S], [S, -S], [-S, -S]]) {
    const foot = new THREE.CylinderGeometry(5.8, 6.2, 1.6, 14); foot.translate(x, 0.8, z); add(foot, DARK);
    towers.push(new THREE.Vector3(x, 0, z));
    torches.push(new THREE.Vector3(x, H + 6.2, z));
  }
  // The keep, its roof and a lit window or two.
  const keep = new THREE.BoxGeometry(14, 13, 12); keep.translate(0, 6.5, -6); add(keep, "#5f5b54");
  const kroof = new THREE.ConeGeometry(10.5, 5, 4); kroof.rotateY(Math.PI / 4); kroof.scale(1, 1, 0.86); kroof.translate(0, 15.5, -6); add(kroof, ROOF);
  torches.push(new THREE.Vector3(-3, 8, 0.1), new THREE.Vector3(3.5, 9, 0.1), new THREE.Vector3(0, 6, -S - 2.2));
  // Guns on the seaward wall and the seaward halves of the side walls, in embrasures.
  const guns = [];
  for (let i = 0; i < nGuns; i++) {
    let x, z, ax, az;
    const k = i % 3;
    if (k === 0 || nGuns <= 3) { const t = (Math.floor(i / 3) + 0.5) / Math.ceil(nGuns / 3); x = lerp(-S + 6, S - 6, t); z = S + 1.2; ax = 0; az = 1; }
    else if (k === 1) { const t = (Math.floor(i / 3) + 0.5) / Math.ceil(nGuns / 3); x = S + 1.2; z = lerp(0, S - 6, t); ax = 1; az = 0; }
    else { const t = (Math.floor(i / 3) + 0.5) / Math.ceil(nGuns / 3); x = -S - 1.2; z = lerp(0, S - 6, t); ax = -1; az = 0; }
    const b = new THREE.CylinderGeometry(0.22, 0.3, 2.4, 8);
    b.rotateX(Math.PI / 2);
    b.rotateY(Math.atan2(ax, az));
    b.translate(x, H - 1.4, z);
    add(b, IRON);
    const emb = new THREE.BoxGeometry(1.4, 1.2, 0.5); emb.rotateY(Math.atan2(ax, az)); emb.translate(x - ax * 0.6, H - 1.4, z - az * 0.6); add(emb, DARK);
    guns.push({ pos: new THREE.Vector3(x + ax * 1.6, H - 1.4, z + az * 1.6), dir: new THREE.Vector3(ax, 0.05, az).normalize() });
  }
  // Flagpole on the keep.
  const pole = new THREE.CylinderGeometry(0.1, 0.14, 12, 6); pole.translate(0, 17 + 6, -6); add(pole, "#3a2c1e");
  return { geo: mergeClean(parts, cols), guns, torches, towers, flag: new THREE.Vector3(0, 28.4, -6) };
}

/** Rexmaw Raids: one gun tower (local to its foot): the round tower, its lip, crenellations, a heavy gun and a mortar. */
function towerGeometry() {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  const STONE = "#6e6a62", IRON = "#141414", WOOD = "#3a2a1c";
  const H = 12;
  add(new THREE.CylinderGeometry(5, 5.6, H, 16).translate(0, H / 2, 0), STONE);
  add(new THREE.CylinderGeometry(5.7, 5.2, 0.8, 16).translate(0, H + 0.2, 0), STONE);
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; const m = new THREE.BoxGeometry(1.2, 1.3, 0.9); m.rotateY(-a); m.translate(Math.cos(a) * 5.2, H + 1.2, Math.sin(a) * 5.2); add(m, STONE); }
  // Arrow-slits and string courses.
  for (const y of [3.5, 7.5]) add(new THREE.CylinderGeometry(5.65, 5.65, 0.3, 16).translate(0, y, 0), "#58554e");
  for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2 + 0.4; const m = new THREE.BoxGeometry(0.4, 1.4, 0.3); m.rotateY(-a); m.translate(Math.cos(a) * 5.45, 6, Math.sin(a) * 5.45); add(m, "#1a1814"); }
  // The tower's heavy gun on its carriage, facing seaward (+Z), and a squat mortar.
  add(new THREE.CylinderGeometry(0.3, 0.4, 3.2, 10).rotateX(Math.PI / 2).translate(0, H + 1.3, 2.6), IRON);
  add(new THREE.BoxGeometry(1.4, 0.7, 2.0).translate(0, H + 0.75, 1.4), WOOD);
  add(new THREE.CylinderGeometry(0.7, 0.9, 1.1, 10).rotateX(-0.5).translate(-2, H + 1.0, -1.2), IRON);
  add(new THREE.CylinderGeometry(0.06, 0.08, 5, 6).translate(2.5, H + 3, -2.5), WOOD);
  return mergeClean(parts, cols);
}

/** A fallen tower: a broken stump and a skirt of rubble. */
function rubbleGeometry() {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  const STONE = "#5a5750", BURNT = "#2c2a26";
  const stump = new THREE.CylinderGeometry(4.6, 5.6, 4.5, 14, 3, true);
  const p = stump.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > 1) p.setY(i, y + Math.sin(i * 1.7) * 1.4 + Math.cos(i * 0.9) * 0.8); }
  stump.translate(0, 2.25, 0);
  add(stump, BURNT);
  for (let k = 0; k < 16; k++) {
    const a = k * 2.399, r = 5 + (k % 5) * 1.3;
    const b = new THREE.BoxGeometry(1.2 + (k % 3) * 0.6, 0.9 + (k % 2) * 0.5, 1.1 + (k % 4) * 0.4);
    b.rotateY(k * 0.7); b.rotateZ((k % 3 - 1) * 0.4);
    b.translate(Math.cos(a) * r, 0.4, Math.sin(a) * r);
    add(b, k % 3 ? STONE : BURNT);
  }
  return mergeClean(parts, cols);
}

/** A smugglers' jetty, along +Z from its root (0, 0, 0), with crates. Lantern spots returned. */
function jettyGeometry() {
  const parts = [], cols = [];
  const add = (g, c) => { parts.push(g); cols.push(c); };
  const L = 26;
  const deck = new THREE.BoxGeometry(3, 0.3, L); deck.translate(0, 1.2, L / 2); add(deck, "#5a4430");
  for (let z = 1; z < L; z += 4) for (const x of [-1.4, 1.4]) { const p = new THREE.CylinderGeometry(0.18, 0.2, 5.5, 6); p.translate(x, -1.2, z); add(p, "#2e2218"); }
  for (const z of [L * 0.5, L - 1]) { const p = new THREE.CylinderGeometry(0.08, 0.1, 3.2, 6); p.translate(1.3, 2.9, z); add(p, "#2e2218"); }
  for (let i = 0; i < 5; i++) { const s = 0.8 + (i % 2) * 0.3; const b = new THREE.BoxGeometry(s, s, s); b.rotateY(i * 0.7); b.translate(-0.7 + (i % 2) * 0.4, 1.35 + s / 2 + (i > 2 ? s : 0), 3 + i * 0.9); add(b, "#6b4a2a"); }
  for (let i = 0; i < 3; i++) { const b = new THREE.CylinderGeometry(0.4, 0.4, 1.1, 10); b.translate(0.6, 1.9, 7 + i * 1.0); add(b, "#4a2c18"); }
  // A shack at the root.
  const shack = new THREE.BoxGeometry(5, 3.2, 4); shack.translate(-4.5, 2.2, 1.5); add(shack, "#4a3828");
  const roof = new THREE.BoxGeometry(5.6, 0.3, 4.6); roof.rotateZ(0.12); roof.translate(-4.5, 3.95, 1.5); add(roof, "#3a2a1e");
  return { geo: mergeClean(parts, cols), lamps: [new THREE.Vector3(1.3, 4.6, L * 0.5), new THREE.Vector3(1.3, 4.6, L - 1)], signal: new THREE.Vector3(-4.5, 4.6, 3.6), window: new THREE.Vector3(-2.0, 2.4, 1.5) };
}

/** A harbour-zone buoy: float, cage, lamp at y ≈ 2.6. */
function buoyGeometry() {
  const f = new THREE.CylinderGeometry(0.85, 0.7, 1.0, 14); f.translate(0, 0.1, 0);
  const cage = new THREE.CylinderGeometry(0.35, 0.45, 1.6, 6, 1, true); cage.translate(0, 1.4, 0);
  const lamp = new THREE.CylinderGeometry(0.15, 0.18, 0.3, 8); lamp.translate(0, 2.4, 0);
  return mergeClean([f, cage, lamp]);
}

// ---- Island shape ---------------------------------------------------------------------------------

/** Centroid, a radius per angle (star-shaped about the centroid), the mean radius. */
function islandShape(poly, N) {
  let cx = 0, cz = 0;
  for (const p of poly) { cx += p.x; cz += p.z; }
  cx /= poly.length; cz /= poly.length;
  const radii = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let best = 0;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      // Ray (cx, cz) + t (dx, dz) against segment p → q.
      const ex = q.x - p.x, ez = q.z - p.z;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = p.x - cx, wz = p.z - cz;
      const t = (wx * ez - wz * ex) / den;
      const u = (wx * dz - wz * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
    radii[i] = best || 10;
  }
  let mean = 0;
  for (const r of radii) mean += r;
  mean /= N;
  return { cx, cz, radii, N, mean };
}

function radiusAt(sh, ang) {
  let a = ang / (Math.PI * 2);
  a -= Math.floor(a);
  const f = a * sh.N, i = Math.floor(f) % sh.N, j = (i + 1) % sh.N, t = f - Math.floor(f);
  return lerp(sh.radii[i], sh.radii[j], t);
}

/**
 * Build everything; fill it from setWorld(world).
 * @param {object} R  the render context
 * @param {{water: object, fx: object, flames: object}} deps
 */
export function createIslands(R, { water, fx, flames }) {
  const root = new THREE.Group();
  root.name = "islands";
  R.scene.add(root);
  const disposables = [];
  const wu = water?.uniforms || {};
  const fogU = { uFogDensity: wu.uFogDensity || { value: 0 }, uTime: wu.uTime || { value: 0 } };
  const shipU = { value: new THREE.Vector2() };
  const revealU = { value: 0 };
  const moonU = { value: 0.8 };
  const dayU = { value: 0 };

  // ---- Terrain: one dynamic mesh, refilled per night ----
  const tPos = new Float32Array(VERTS_MAX * 3), tCol = new Float32Array(VERTS_MAX * 3), tNor = new Float32Array(VERTS_MAX * 3);
  const tIdx = new Uint32Array(VERTS_MAX * 6);
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3));
  terrainGeo.setAttribute("normal", new THREE.BufferAttribute(tNor, 3));
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(tCol, 3));
  terrainGeo.setIndex(new THREE.BufferAttribute(tIdx, 1));
  terrainGeo.setDrawRange(0, 0);
  // Two-sided: the loft's winding never culls a hill.
  const terrainMat = new THREE.MeshStandardMaterial({ name: "nr-island", vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.25, side: THREE.DoubleSide });
  terrainMat.onBeforeCompile = (sh) => {
    sh.uniforms.uDay = dayU;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vIlW;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvIlW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>\nvarying vec3 vIlW;\nuniform float uDay;\n${NOISE}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ilN = ilFbm(vIlW.xz * 0.08) * 0.6 + ilFbm(vIlW.xz * 0.6) * 0.4;
        diffuseColor.rgb *= 0.72 + 0.56 * ilN;
        // Rexmaw Raids: by day the jungle greens and the sand warms (the night's colours are deliberately dim).
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.25, 1.45, 1.05), uDay);
        float ilH = vIlW.y - (${WATER_Y.toFixed(2)});
        diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(-0.3, 0.9, ilH));`);
  };
  terrainMat.customProgramCacheKey = () => "nr-island";
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.name = "islands.terrain";
  terrain.frustumCulled = false;
  terrain.receiveShadow = false;
  root.add(terrain);
  disposables.push(terrainGeo, terrainMat);

  // ---- Rocks ----
  const rockMat = patchWet(new THREE.MeshStandardMaterial({ name: "nr-rock", color: "#4a4a4c", roughness: 0.82, metalness: 0, envMapIntensity: 0.5, flatShading: true }), { key: "nr-rock" });
  disposables.push(rockMat);
  const rockMeshes = Array.from({ length: 3 }, (_, i) => {
    const g = rockGeometry(2000 + i * 77);
    const m = new THREE.InstancedMesh(g, rockMat, CAP.rocks);
    m.name = `rocks-${i}`; m.count = 0;
    root.add(m);
    disposables.push(g);
    return m;
  });

  // ---- Palms ----
  const palmG = palmGeometries();
  const trunkMat = new THREE.MeshStandardMaterial({ name: "nr-palm-trunk", color: "#4a3a2a", roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
  const frondMat = new THREE.MeshStandardMaterial({ name: "nr-palm-frond", color: "#1d3a22", roughness: 0.8, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.3 });
  frondMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = fogU.uTime;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          float r = length(position.xz - vec2(1.4, 0.0));
          vec4 ip = instanceMatrix[3];
          float sway = sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.04 * r;
          transformed.y += sway;
          transformed.x += sway * 0.4;
        }`);
  };
  frondMat.customProgramCacheKey = () => "nr-palm-frond";
  const trunks = new THREE.InstancedMesh(palmG.trunk, trunkMat, CAP.palms);
  const crowns = new THREE.InstancedMesh(palmG.crown, frondMat, CAP.palms);
  for (const [m, n] of [[trunks, "palms-trunk"], [crowns, "palms-crown"]]) { m.name = n; m.count = 0; root.add(m); }
  disposables.push(palmG.trunk, palmG.crown, trunkMat, frondMat);

  // ---- Huts, the fort, the jetty, buoys: vertex-coloured, one material ----
  const propMat = new THREE.MeshStandardMaterial({ name: "nr-props", vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.3 });
  disposables.push(propMat);
  const hutGeo = hutGeometry();
  const huts = new THREE.InstancedMesh(hutGeo, propMat, CAP.huts);
  huts.name = "huts"; huts.count = 0;
  root.add(huts);
  disposables.push(hutGeo);
  const fortParts = fortGeometry(CAP.fortGuns / 3);
  const fortMesh = new THREE.Mesh(fortParts.geo, propMat);
  fortMesh.name = "fort"; fortMesh.visible = false;
  root.add(fortMesh);
  // Rexmaw Raids: the fort's four gun towers (instanced, each can be brought down) and their rubble.
  const towerGeo = towerGeometry(), rubbleGeo = rubbleGeometry();
  const towerMesh = new THREE.InstancedMesh(towerGeo, propMat, 4);
  towerMesh.name = "fort-towers"; towerMesh.count = 0;
  towerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  towerMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12).fill(1), 3);
  const rubbleMesh = new THREE.InstancedMesh(rubbleGeo, propMat, 4);
  rubbleMesh.name = "fort-rubble"; rubbleMesh.count = 0;
  root.add(towerMesh, rubbleMesh);
  disposables.push(towerGeo, rubbleGeo);
  const TW = { list: [] };     // {base: Matrix4, pos: Vector3 (world foot), top: Vector3, fall: 0..1, down: bool, dmg: 0..1}
  // Curtain walls between the v2 fort's towers: a 10 m crenellated stretch, scaled along its length.
  const CURTAINS = 6;
  const curtainGeo = (() => {
    const parts = [new THREE.BoxGeometry(10, 9, 3.2).translate(0, 4.5, 0), new THREE.BoxGeometry(10, 0.4, 3.6).translate(0, 9.2, 0)];
    const cols = ["#6a665e", "#58554e"];
    for (let i = 0; i < 5; i++) { parts.push(new THREE.BoxGeometry(1.1, 1.2, 0.8).translate(-4 + i * 2, 9.9, 1.3)); cols.push("#6a665e"); }
    return mergeClean(parts, cols);
  })();
  const curtains = new THREE.InstancedMesh(curtainGeo, propMat, CURTAINS);
  curtains.name = "fort-curtains"; curtains.count = 0;
  root.add(curtains);
  disposables.push(curtainGeo);
  // Torchlight on the fort's walls (always in the scene, 0 when there's no fort: no recompiles).
  const fortLights = [0, 1].map((i) => { const l = new THREE.PointLight("#ff9a4a", 0, 70, 1.6); l.name = `fort-light-${i}`; R.scene.add(l); return l; });
  disposables.push(fortParts.geo);
  const jetty = jettyGeometry();
  const coveMesh = new THREE.Mesh(jetty.geo, propMat);
  coveMesh.name = "cove"; coveMesh.visible = false;
  root.add(coveMesh);
  disposables.push(jetty.geo);
  const buoyGeo = buoyGeometry();
  const buoyMat = new THREE.MeshStandardMaterial({ name: "nr-buoy", color: "#8a2a22", roughness: 0.5, metalness: 0.1, envMapIntensity: 0.6 });
  const buoys = new THREE.InstancedMesh(buoyGeo, buoyMat, 16);
  buoys.name = "harbour-buoys"; buoys.count = 0; buoys.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(buoys);
  disposables.push(buoyGeo, buoyMat);
  // The fort's flag.
  const flagTex = (() => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 160;
    const g = c.getContext("2d");
    g.fillStyle = "#1e3a8a"; g.fillRect(0, 0, 256, 160);
    g.fillStyle = "#f3f4f6"; g.fillRect(0, 62, 256, 36); g.fillRect(110, 0, 36, 160);
    g.fillStyle = "#b91c1c"; g.fillRect(0, 70, 256, 20); g.fillRect(118, 0, 20, 160);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const fortFlagMat = new THREE.MeshStandardMaterial({ name: "nr-fort-flag", map: flagTex, side: THREE.DoubleSide, roughness: 0.9 });
  fortFlagMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = fogU.uTime;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.z += sin(uv.x * 7.0 - uTime * 6.0) * 0.4 * uv.x;");
  };
  fortFlagMat.customProgramCacheKey = () => "nr-fort-flag";
  const fortFlagGeo = new THREE.PlaneGeometry(6, 3.8, 10, 4);
  fortFlagGeo.translate(3, 0, 0);
  const fortFlag = new THREE.Mesh(fortFlagGeo, fortFlagMat);
  fortFlag.visible = false;
  root.add(fortFlag);
  disposables.push(flagTex, fortFlagMat, fortFlagGeo);

  // ---- Treasure afloat (state.pickups) ----
  const CHESTS = 32;
  const chestGeo = (() => {
    const box = new THREE.BoxGeometry(1.1, 0.6, 0.75);
    const lid = new THREE.CylinderGeometry(0.375, 0.375, 1.1, 10, 1, false, 0, Math.PI); lid.rotateZ(Math.PI / 2); lid.rotateX(-Math.PI / 2); lid.translate(0, 0.3, 0);
    const band = new THREE.BoxGeometry(1.14, 0.08, 0.79); band.translate(0, 0.12, 0);
    return mergeClean([box, lid, band], ["#5a3a1e", "#6b4422", "#c9a227"]);
  })();
  const chests = new THREE.InstancedMesh(chestGeo, propMat, CHESTS);
  chests.name = "chests"; chests.count = 0; chests.frustumCulled = false;
  chests.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(chests);
  disposables.push(chestGeo);

  // ---- Wrecks ----
  const wreckMat = patchWet(new THREE.MeshStandardMaterial({ name: "nr-wreck", color: "#3b2c1f", roughness: 0.85, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide }), { weed: 0.8, mottle: 0.6, key: "nr-wreck" });
  const wreckGeo = wreckGeometry();
  const wrecks = new THREE.InstancedMesh(wreckGeo, wreckMat, CAP.wrecks);
  wrecks.name = "wrecks"; wrecks.count = 0;
  root.add(wrecks);
  disposables.push(wreckMat, wreckGeo);

  // ---- Lights: one Points draw ----
  const lPos = new Float32Array(CAP.lights * 3), lCol = new Float32Array(CAP.lights * 3), lInfo = new Float32Array(CAP.lights * 3);
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3));
  lightGeo.setAttribute("aColor", new THREE.BufferAttribute(lCol, 3));
  lightGeo.setAttribute("aInfo", new THREE.BufferAttribute(lInfo, 3));        // size (m), seed, kind (0 steady, 1 flicker, 2 glint, 3 beacon)
  lightGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  lightGeo.setDrawRange(0, 0);
  const lightMat = new THREE.ShaderMaterial({
    name: "NightRaidIslandLights", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uScale: { value: 800 }, uFogDensity: fogU.uFogDensity, uTime: fogU.uTime, uDim: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor, aInfo;
      uniform float uScale, uFogDensity, uTime, uDim;
      varying vec3 vCol; varying float vKind;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.5);
        float fd = uFogDensity * d * 0.42;
        float k = 1.0;
        if (aInfo.z > 0.5 && aInfo.z < 1.5) k = 0.82 + 0.18 * sin(uTime * 9.0 + aInfo.y * 40.0) * sin(uTime * 5.3 + aInfo.y * 13.0);
        else if (aInfo.z > 1.5 && aInfo.z < 2.5) { float g = sin(uTime * (1.3 + aInfo.y) + aInfo.y * 60.0); k = 0.25 + 1.6 * max(g * g * g * g * g * g * g * g, 0.0); }
        else if (aInfo.z > 2.5) k = 0.5 + 0.5 * step(0.0, sin(uTime * 3.14159 * 0.5 + aInfo.y * 6.0));
        vCol = aColor * k * exp(-fd * fd) * uDim;
        vKind = aInfo.z;
        gl_PointSize = clamp(aInfo.x * uScale / d, 2.0, 48.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vKind;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float v = exp(-r2 * 10.0) + 0.22 * exp(-r2 * 2.4);
        if (vKind > 1.5 && vKind < 2.5) v += (exp(-abs(p.x) * 30.0) + exp(-abs(p.y) * 30.0)) * (1.0 - r2) * 0.4;
        gl_FragColor = vec4(vCol * v, 1.0);
      }`,
  });
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.frustumCulled = false;
  lights.renderOrder = 12;
  lights.layers.set(LAYERS.FX);
  root.add(lights);
  disposables.push(lightGeo, lightMat);
  const _bs = new THREE.Vector2();
  lights.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_bs).y;
    lightMat.uniforms.uScale.value = h / (2 * Math.tan((R.camera.fov * DEG) / 2));
  };
  let nLights = 0;
  const WARM = new THREE.Color("#ffb067"), FIRE = new THREE.Color("#ff8a3a"), GOLD = new THREE.Color("#ffd27a"), GREEN = new THREE.Color("#5dff8a"), WHITE = new THREE.Color("#fff1d8");
  function addLight(x, y, z, color, k, size, kind = 0, seed = Math.random()) {
    if (nLights >= CAP.lights) return -1;
    const i = nLights++;
    lPos[i * 3] = x; lPos[i * 3 + 1] = y; lPos[i * 3 + 2] = z;
    lCol[i * 3] = color.r * k; lCol[i * 3 + 1] = color.g * k; lCol[i * 3 + 2] = color.b * k;
    lInfo[i * 3] = size; lInfo[i * 3 + 1] = seed; lInfo[i * 3 + 2] = kind;
    return i;
  }

  // ---- Shoals ----
  const shoalGeo = new THREE.PlaneGeometry(2, 2);
  shoalGeo.rotateX(-Math.PI / 2);
  const aShoal = new THREE.InstancedBufferAttribute(new Float32Array(CAP.shoals * 2), 2).setUsage(THREE.DynamicDrawUsage);
  shoalGeo.setAttribute("aShoal", aShoal);
  const shoalMat = new THREE.ShaderMaterial({
    name: "NightRaidShoals",
    uniforms: { ...fogU, uShip: shipU, uReveal: revealU, uMoon: moonU },
    transparent: true, depthWrite: false, premultipliedAlpha: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    vertexShader: /* glsl */`
      attribute vec2 aShoal;        // seed, revealed (0/1)
      varying vec2 vP; varying vec2 vS; varying vec3 vW;
      void main() {
        vP = position.xz; vS = aShoal;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uReveal, uMoon;
      uniform vec2 uShip;
      varying vec2 vP; varying vec2 vS; varying vec3 vW;
      ${NOISE}
      void main() {
        float seed = vS.x;
        float r = length(vP), ang = atan(vP.y, vP.x);
        float n = ilFbm(vP * 1.4 + seed * 5.0);
        float shape = r + (n - 0.5) * 0.32;
        float body = 1.0 - smoothstep(0.5, 0.86, shape);
        float sand = ilFbm(vP * 7.0 + seed);
        float aD = body * 0.55;
        vec3 dCol = mix(vec3(0.05, 0.08, 0.075), vec3(0.12, 0.13, 0.11), sand) * (0.5 + 0.7 * uMoon);
        float surfW = exp(-abs(shape - 0.82) * 20.0);
        float brk = 0.5 + 0.5 * sin(uTime * 1.1 - shape * 16.0 + seed * 4.0);
        float aF = surfW * (0.3 + 0.7 * brk * brk) * (0.4 + 0.8 * ilFbm(vec2(ang * 7.0, uTime * 0.2 + seed))) * 0.75;
        // Hidden beyond 120 m of the Rexmaw until the lookout has called them.
        float near = 1.0 - smoothstep(85.0, 125.0, length(vW.xz - uShip));
        float shown = max(near, max(vS.y, uReveal));
        float fd = uFogDensity * length(cameraPosition - vW);
        float seen = exp(-fd * fd) * shown;
        aF = clamp(aF, 0.0, 1.0) * seen;
        aD = clamp(aD, 0.0, 1.0) * seen;
        vec3 foam = vec3(0.42, 0.48, 0.53) * (0.45 + 0.6 * uMoon);
        vec3 rgb = foam * aF + dCol * aD * (1.0 - aF);
        float a = aF + aD * (1.0 - aF);
        if (a < 0.002) discard;
        gl_FragColor = vec4(rgb, a);
      }`,
  });
  const shoals = new THREE.InstancedMesh(shoalGeo, shoalMat, CAP.shoals);
  shoals.name = "shoals"; shoals.count = 0; shoals.renderOrder = 1; shoals.frustumCulled = false;
  shoals.layers.set(LAYERS.NOREFLECT);
  root.add(shoals);
  disposables.push(shoalGeo, shoalMat);
  const shoalKeys = [];

  // ---- Rexmaw Raids: reefs (capsule decals on the swell) ----
  const reefGeo = new THREE.PlaneGeometry(1, 1, 6, 24);
  reefGeo.rotateX(-Math.PI / 2);
  const aReef = new THREE.InstancedBufferAttribute(new Float32Array(CAP.reefs * 4), 4);    // len, w, seed, rocks
  reefGeo.setAttribute("aReef", aReef);
  const reefMat = new THREE.ShaderMaterial({
    name: "RexmawReefs",
    uniforms: { ...fogU, uSwellA: wu.uSwellA || { value: [] }, uSwellB: wu.uSwellB || { value: [] }, uMoon: moonU, uDay: { value: 0 } },
    transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */`
      uniform vec4 uSwellA[3]; uniform vec4 uSwellB[3]; uniform float uTime;
      attribute vec4 aReef;
      varying vec2 vL; varying vec4 vR; varying vec3 vW;
      void main() {
        vR = aReef;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        // Local metres: x across, y along (the instance scale is the box round the capsule).
        vec3 sx = vec3(instanceMatrix[0].xyz), sz = vec3(instanceMatrix[2].xyz);
        vL = vec2(position.x * length(sx), position.z * length(sz));
        float h = 0.0;
        for (int i = 0; i < 3; i++) h += uSwellB[i].x * sin(uSwellA[i].z * dot(uSwellA[i].xy, w.xz) - uSwellA[i].w * uTime + uSwellB[i].y);
        w.y = ${WATER_Y.toFixed(2)} + h + 0.06;
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uMoon, uDay;
      varying vec2 vL; varying vec4 vR; varying vec3 vW;
      ${NOISE}
      void main() {
        float len = vR.x, w = vR.y, seed = vR.z;
        vec2 q = vec2(vL.x, max(abs(vL.y) - len * 0.5, 0.0));
        float n = ilFbm(vW.xz * 0.06 + seed * 11.0) - 0.5;
        float d = length(q) - w * (1.0 + 0.45 * n);
        // The reef itself: coral and weed under a skin of water (day), a dark stain (night).
        float body = 1.0 - smoothstep(-2.0, 1.5, d);
        float mottle = ilFbm(vW.xz * 0.35 + seed);
        vec3 dayC = mix(vec3(0.16, 0.3, 0.26), vec3(0.42, 0.4, 0.26), mottle);
        vec3 nightC = vec3(0.012, 0.02, 0.02);
        vec3 bodyC = mix(nightC, dayC, uDay);
        // Surf breaking along the edge, pulsing in with the sets.
        float brk = 0.5 + 0.5 * sin(uTime * 1.3 - d * 0.9 + seed * 6.0 + vL.y * 0.05);
        float surf = exp(-abs(d - 0.5) * 0.55) * (0.25 + 0.75 * brk * brk) * (0.45 + 0.75 * ilFbm(vec2(vL.y * 0.2, uTime * 0.25 + seed)));
        surf *= 1.0 - smoothstep(4.0, 14.0, d);
        vec3 foamC = vec3(0.85, 0.9, 0.92) * mix(0.18 + 0.35 * uMoon, 1.1, uDay);
        float aB = body * mix(0.5, 0.62, uDay);
        float aF = clamp(surf, 0.0, 1.0) * mix(0.35, 0.85, uDay);
        float fd = uFogDensity * length(cameraPosition - vW);
        float seen = exp(-fd * fd);
        vec3 rgb = foamC * aF + bodyC * aB * (1.0 - aF);
        float a = (aF + aB * (1.0 - aF)) * seen;
        if (a < 0.003) discard;
        gl_FragColor = vec4(rgb * seen / max(a, 1e-3) * seen, a);
      }`,
  });
  const reefs = new THREE.InstancedMesh(reefGeo, reefMat, CAP.reefs);
  reefs.name = "reefs"; reefs.count = 0; reefs.frustumCulled = false; reefs.renderOrder = 1;
  reefs.layers.set(LAYERS.NOREFLECT);
  root.add(reefs);
  disposables.push(reefGeo, reefMat);

  // ---- v3: shoreline foam: a strip round every island's waterline (from −4 m under the sand to 14 m out), riding the
  // swell; lines of foam run in and wash up the beach, a steady lace at the water's edge. One draw for the bay. ----
  const SHORE_ROWS = [-4, 0, 2.5, 6, 14];
  const SHORE_MAX = 12 * 142 * SHORE_ROWS.length;
  const sPos = new Float32Array(SHORE_MAX * 3), sInfo = new Float32Array(SHORE_MAX * 3);
  const shoreGeo = new THREE.BufferGeometry();
  shoreGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  shoreGeo.setAttribute("aShore", new THREE.BufferAttribute(sInfo, 3));      // metres seaward of the waterline, metres along it, seed
  shoreGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(SHORE_MAX * 6), 1));
  shoreGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  shoreGeo.setDrawRange(0, 0);
  const shoreMat = new THREE.ShaderMaterial({
    name: "RexmawShoreFoam",
    uniforms: { ...fogU, uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uChopA: wu.uChopA, uChopB: wu.uChopB, uMoon: moonU, uDay: dayU },
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */`
      uniform float uTime;
      ${SEA_HEIGHT_GLSL}
      attribute vec3 aShore;
      varying vec3 vS; varying vec3 vW;
      void main() {
        vS = aShore;
        vec4 w = modelMatrix * vec4(position, 1.0);
        w.y = ${WATER_Y.toFixed(2)} + seaHeight(w.xz) + 0.08;
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uMoon, uDay;
      varying vec3 vS; varying vec3 vW;
      ${NOISE}
      void main() {
        float s = vS.x, along = vS.y, seed = vS.z;
        float n = ilFbm(vec2(along * 0.08, s * 0.15) + seed * 7.0);
        float lace = ilFbm(vW.xz * 0.55 + vec2(uTime * 0.12, -uTime * 0.08));
        // The wash at the edge, surging up and back with the sets.
        float surge = 0.5 + 0.5 * sin(uTime * 0.9 + along * 0.025 + seed * 5.0);
        float edge = exp(-pow((s - mix(-0.5, 1.8, surge)) / 1.6, 2.0));
        // Lines of foam running in toward the beach, breaking up as they come.
        float ph = s * 0.55 + uTime * 1.25 + n * 3.0 + along * 0.01;
        float line = pow(max(0.0, sin(ph)), 10.0) * smoothstep(13.0, 3.0, s) * smoothstep(-1.0, 1.5, s);
        float foam = (edge * 0.9 + line * 0.75) * smoothstep(0.3, 0.75, lace * 0.6 + n * 0.55);
        foam *= smoothstep(14.0, 8.0, s);
        vec3 foamC = vec3(0.85, 0.9, 0.92) * mix(0.16 + 0.32 * uMoon, 1.12, uDay);
        float fd = uFogDensity * length(cameraPosition - vW);
        float seen = exp(-fd * fd);
        float a = clamp(foam, 0.0, 1.0) * mix(0.4, 0.88, uDay) * seen;
        if (a < 0.004) discard;
        gl_FragColor = vec4(foamC * a, a);
      }`,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const shore = new THREE.Mesh(shoreGeo, shoreMat);
  shore.name = "shore-foam"; shore.frustumCulled = false; shore.renderOrder = 1;
  shore.layers.set(LAYERS.NOREFLECT);
  root.add(shore);
  disposables.push(shoreGeo, shoreMat);

  /** The shore strips for W.isles (the waterline is where the terrain's profile crosses the sea: ρ ≈ 1.028). */
  function buildShore() {
    const idx = shoreGeo.index.array;
    const NR = SHORE_ROWS.length;
    let v = 0, k = 0;
    for (const is of W.isles.slice(0, 12)) {
      const sh = is.sh, N = Math.min(140, sh.N);
      const base = v;
      let along = 0, px = null, pz = null;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
        const rc = radiusAt(sh, a) * 1.028;
        const cx = sh.cx + dx * rc, cz = sh.cz + dz * rc;
        if (px != null) along += Math.hypot(cx - px, cz - pz);
        px = cx; pz = cz;
        for (let r = 0; r < NR; r++) {
          const off = SHORE_ROWS[r];
          sPos[v * 3] = cx + dx * off; sPos[v * 3 + 1] = WATER_Y; sPos[v * 3 + 2] = cz + dz * off;
          sInfo[v * 3] = off; sInfo[v * 3 + 1] = along; sInfo[v * 3 + 2] = (is.seed % 17) / 17;
          v++;
        }
      }
      for (let i = 0; i < N; i++) {
        for (let r = 0; r < NR - 1; r++) {
          const a = base + i * NR + r, b = a + 1, c = a + NR, d = c + 1;
          idx[k++] = a; idx[k++] = b; idx[k++] = c;
          idx[k++] = b; idx[k++] = d; idx[k++] = c;
        }
      }
    }
    shoreGeo.attributes.position.needsUpdate = true;
    shoreGeo.attributes.aShore.needsUpdate = true;
    shoreGeo.index.needsUpdate = true;
    shoreGeo.setDrawRange(0, k);
  }

  // ---- State ----
  const W = { world: null, isles: [], fort: null, fortGuns: [], fortTorchIdx: [], wrecks: [], wreckLights: [], campfires: [], cove: null, coveLights: [] };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _e = new THREE.Euler(), _Y = new THREE.Vector3(0, 1, 0);
  const _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _c = new THREE.Color(), _white = new THREE.Color(1, 1, 1);
  const _hide = new THREE.Matrix4().makeScale(0, 0, 0);

  /** The island terrain's height above the water at world (x, z) (≤ 0 in the water). */
  function heightAt(x, z) {
    let best = -8;
    for (const is of W.isles) {
      const dx = x - is.sh.cx, dz = z - is.sh.cz;
      const d = Math.hypot(dx, dz);
      if (d > is.sh.mean * 2.2) continue;
      best = Math.max(best, islandH(is, x, z));
    }
    return best;
  }
  function islandH(is, x, z) {
    const dx = x - is.sh.cx, dz = z - is.sh.cz;
    const d = Math.hypot(dx, dz);
    const r = radiusAt(is.sh, Math.atan2(dz, dx));
    return profile(is, d / Math.max(1, r), x, z);
  }
  function profile(is, rho, x, z) {
    let h;
    if (rho >= 1.2) h = -8;
    else if (rho >= 1.0) h = lerp(0.35, -6, smooth(1.0, 1.2, rho));
    else if (rho >= 0.86) h = lerp(2.0, 0.35, smooth(0.86, 1.0, rho));
    else {
      const k = Math.pow(smooth(0.86, 0.05, rho), 1.25);
      const n = fbm(x * 0.012, z * 0.012, is.seed) * 0.7 + fbm(x * 0.045, z * 0.045, is.seed + 3) * 0.3;
      const ridge = 1 - Math.abs(fbm(x * 0.02, z * 0.02, is.seed + 7) * 2 - 1);
      h = 2.0 + (is.H - 2.0) * k * (0.45 + 0.75 * n + 0.35 * ridge * k);
    }
    // The fort's plateau.
    if (is.fort) {
      const fd = Math.hypot(x - is.fort.x, z - is.fort.z);
      const w = smooth(42, 28, fd) * smooth(1.1, 1.0, rho);
      if (w > 0) h = lerp(h, is.fort.y, w);
    }
    return h;
  }

  function buildTerrain() {
    let nv = 0, ni = 0;
    const SAND = new THREE.Color("#b5a27a"), WETSAND = new THREE.Color("#6e624c"), GRASS = new THREE.Color("#33502e"), JUNGLE = new THREE.Color("#1c3420"), ROCK = new THREE.Color("#55534e"), SEABED = new THREE.Color("#3a3428");
    const c = new THREE.Color();
    for (const is of W.isles) {
      const N = is.sh.N, rings = RHO.length;
      if (nv + N * rings + 1 > VERTS_MAX) break;
      const base = nv;
      for (let j = 0; j < rings; j++) {
        const rho = RHO[j];
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          const r = is.sh.radii[i] * rho;
          const x = is.sh.cx + Math.cos(a) * r, z = is.sh.cz + Math.sin(a) * r;
          const h = profile(is, rho, x, z);
          tPos[nv * 3] = x; tPos[nv * 3 + 1] = WATER_Y + h; tPos[nv * 3 + 2] = z;
          if (h < -0.4) c.copy(SEABED);
          else if (h < 0.9) c.copy(WETSAND).lerp(SAND, smooth(-0.4, 0.9, h));
          else if (h < 3.2) c.copy(SAND).lerp(GRASS, smooth(1.8, 3.2, h));
          else c.copy(GRASS).lerp(JUNGLE, smooth(3, 12, h)).lerp(ROCK, smooth(is.H * 0.62, is.H * 0.95, h));
          tCol[nv * 3] = c.r; tCol[nv * 3 + 1] = c.g; tCol[nv * 3 + 2] = c.b;
          nv++;
        }
      }
      const centre = nv;
      const hc = profile(is, 0, is.sh.cx, is.sh.cz);
      tPos[nv * 3] = is.sh.cx; tPos[nv * 3 + 1] = WATER_Y + hc; tPos[nv * 3 + 2] = is.sh.cz;
      c.copy(ROCK);
      tCol[nv * 3] = c.r; tCol[nv * 3 + 1] = c.g; tCol[nv * 3 + 2] = c.b;
      nv++;
      for (let j = 0; j < rings - 1; j++) {
        for (let i = 0; i < N; i++) {
          const a = base + j * N + i, b = base + j * N + (i + 1) % N, d = a + N, e = b + N;
          tIdx[ni++] = a; tIdx[ni++] = d; tIdx[ni++] = b;
          tIdx[ni++] = b; tIdx[ni++] = d; tIdx[ni++] = e;
        }
      }
      const last = base + (rings - 1) * N;
      for (let i = 0; i < N; i++) { tIdx[ni++] = last + i; tIdx[ni++] = centre; tIdx[ni++] = last + (i + 1) % N; }
    }
    terrainGeo.setDrawRange(0, ni);
    terrainGeo.attributes.position.needsUpdate = true;
    terrainGeo.attributes.color.needsUpdate = true;
    terrainGeo.index.needsUpdate = true;
    // Normals over the filled range.
    tNor.fill(0, 0, nv * 3);
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
    for (let k = 0; k < ni; k += 3) {
      const ia = tIdx[k], ib = tIdx[k + 1], ic = tIdx[k + 2];
      pa.fromArray(tPos, ia * 3); pb.fromArray(tPos, ib * 3); pc.fromArray(tPos, ic * 3);
      cb.subVectors(pc, pb); ab.subVectors(pa, pb); cb.cross(ab);
      for (const i of [ia, ib, ic]) { tNor[i * 3] += cb.x; tNor[i * 3 + 1] += cb.y; tNor[i * 3 + 2] += cb.z; }
    }
    for (let i = 0; i < nv; i++) {
      const x = tNor[i * 3], y = tNor[i * 3 + 1], z = tNor[i * 3 + 2], l = Math.hypot(x, y, z) || 1;
      // Upward-facing (the loft's winding can face either way: keep normals up).
      const s = y < 0 ? -1 : 1;
      tNor[i * 3] = s * x / l; tNor[i * 3 + 1] = s * y / l; tNor[i * 3 + 2] = s * z / l;
    }
    terrainGeo.attributes.normal.needsUpdate = true;
    terrainGeo.computeBoundingSphere();
  }

  function place(mesh, i, x, y, z, yaw, sx, sy = sx, sz = sx, tiltX = 0, tiltZ = 0) {
    _e.set(tiltX, yaw, tiltZ, "YXZ");
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
    mesh.setMatrixAt(i, _m);
  }

  /** Fill everything from a world (core/world.js's shape). */
  function setWorld(world) {
    W.world = world || null;
    W.isles = [];
    nLights = 0;
    shoalKeys.length = 0;
    W.campfires = [];
    W.wrecks = []; W.wreckLights = [];
    W.fort = null; W.fortGuns = []; W.fortTorchIdx = [];
    W.cove = null; W.coveLights = [];
    const rnd = seeded(hash(world?.seed ?? 1) ^ 0x5eed);
    for (const isl of world?.islands || []) {
      const poly = (isl.poly || []).filter((p) => Number.isFinite(+p.x) && Number.isFinite(+p.z)).map((p) => ({ x: +p.x, z: +p.z }));
      if (poly.length < 3) continue;
      const per = poly.reduce((s, p, i) => s + Math.hypot(poly[(i + 1) % poly.length].x - p.x, poly[(i + 1) % poly.length].z - p.z), 0);
      const N = clamp(Math.round(per / 9), 40, 140);
      const sh = islandShape(poly, N);
      const seed = (hash(isl.id ?? W.isles.length) % 997) + 1;
      const H = clamp(sh.mean * (0.16 + rnd() * 0.12), 9, 72);
      const is = { id: isl.id, sh, seed, H, per, isl, fort: null };
      if (isl.fort && Number.isFinite(+isl.fort.x)) {
        is.fort = { x: +isl.fort.x, z: +isl.fort.z, y: 0, guns: +isl.fort.guns || 8 };
        is.fort.y = Math.max(5, Math.min(18, profile({ ...is, fort: null }, Math.hypot(is.fort.x - sh.cx, is.fort.z - sh.cz) / Math.max(1, radiusAt(sh, Math.atan2(is.fort.z - sh.cz, is.fort.x - sh.cx))), is.fort.x, is.fort.z)));
      }
      W.isles.push(is);
    }
    buildTerrain();
    buildShore();

    // Rocks, palms, huts.
    let nr = [0, 0, 0], np = 0, nh = 0;
    for (const is of W.isles) {
      const sh = is.sh;
      const rr = seeded(is.seed * 31 + 7);
      const rocks = Math.round(is.per / 26);
      for (let k = 0; k < rocks; k++) {
        const a = rr() * Math.PI * 2, rho = 0.97 + rr() * (rr() < 0.15 ? 0.45 : 0.14);
        const r = radiusAt(sh, a) * rho;
        const x = sh.cx + Math.cos(a) * r, z = sh.cz + Math.sin(a) * r;
        const v = k % 3;
        if (nr[v] >= CAP.rocks) continue;
        const s = (rho > 1.12 ? 1.2 : 2) + rr() * (rho > 1.12 ? 2.5 : 4.5);
        place(rockMeshes[v], nr[v]++, x, WATER_Y - s * 0.25 + Math.max(0, islandH(is, x, z)) * 0.6, z, rr() * 6.28, s, s * (0.7 + rr() * 0.6), s);
      }
      // Palms in groves along the beach.
      const groves = Math.max(2, Math.round(is.per / 140));
      for (let g = 0; g < groves; g++) {
        const a0 = rr() * Math.PI * 2;
        const n = 3 + Math.floor(rr() * 6);
        for (let k = 0; k < n && np < CAP.palms; k++) {
          const a = a0 + (rr() - 0.5) * 0.35, rho = 0.8 + rr() * 0.14;
          const r = radiusAt(sh, a) * rho;
          const x = sh.cx + Math.cos(a) * r, z = sh.cz + Math.sin(a) * r;
          const h = islandH(is, x, z);
          if (h < 0.4 || h > 9) continue;
          if (is.fort && Math.hypot(x - is.fort.x, z - is.fort.z) < 48) continue;
          const s = 0.8 + rr() * 0.6;
          const yaw = -a + (rr() - 0.5) * 1.1;                   // local +X (the lean) out toward the sea
          place(trunks, np, x, WATER_Y + h - 0.2, z, yaw, s, s, s);
          place(crowns, np, x, WATER_Y + h - 0.2, z, yaw, s, s, s);
          np++;
        }
      }
      // A fishing village on some islands (never the fort's).
      if (!is.fort && rr() < 0.55 && nh < CAP.huts - 6) {
        const a0 = rr() * Math.PI * 2;
        const n = 2 + Math.floor(rr() * 4);
        let fire = null;
        for (let k = 0; k < n; k++) {
          const a = a0 + (k - n / 2) * (14 / radiusAt(sh, a0)), rho = 0.86 + rr() * 0.05;
          const r = radiusAt(sh, a) * rho;
          const x = sh.cx + Math.cos(a) * r, z = sh.cz + Math.sin(a) * r;
          const h = Math.max(0.5, islandH(is, x, z));
          const yaw = Math.PI / 2 - a;                           // local +Z (the door) toward the sea
          const s = 0.9 + rr() * 0.25;
          place(huts, nh++, x, WATER_Y + h - 0.3, z, yaw, s);
          // Window light (front, facing the water).
          const fx_ = Math.cos(a), fz_ = Math.sin(a);
          if (rr() < 0.8) addLight(x + fx_ * 2.2 * s, WATER_Y + h + 2.0 * s, z + fz_ * 2.2 * s, WARM, 2.6, 0.9, 1);
          if (!fire) fire = { x: sh.cx + Math.cos(a) * r * 1.03, z: sh.cz + Math.sin(a) * r * 1.03, y: WATER_Y + Math.max(0.4, islandH(is, sh.cx + Math.cos(a) * r * 1.03, sh.cz + Math.sin(a) * r * 1.03)) + 0.2 };
        }
        if (fire) { W.campfires.push(fire); addLight(fire.x, fire.y + 0.9, fire.z, FIRE, 3.4, 2.4, 1); }
      }
    }
    // Rexmaw Raids: reefs and rocks (world.reefs: capsules a–b, half-width w). Every one is drawn (the captain's
    // chart is what hides them): a decal of darker water with surf breaking round it, and for `rocks` the
    // heads awash along it.
    let nf = 0;
    for (const rf of world?.reefs || []) {
      if (nf >= CAP.reefs || !rf?.a || !Number.isFinite(+rf.a.x)) continue;
      const ax = +rf.a.x, az = +rf.a.z, bx = +rf.b.x, bz = +rf.b.z, w = Math.max(3, +rf.w || 10);
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(bx - ax, bz - az);
      const pad = 10;
      _m.compose(_v.set((ax + bx) / 2, WATER_Y, (az + bz) / 2), _q.setFromAxisAngle(_Y, yaw), _s.set(w * 2 + pad * 2, 1, len + w * 2 + pad * 2));
      reefs.setMatrixAt(nf, _m);
      aReef.setXYZW(nf, len, w, (hash(rf.id ?? nf) % 1000) / 1000, rf.kind === "rocks" ? 1 : 0);
      nf++;
      if (rf.kind === "rocks" || rf.kind === "reef") {
        const rr = seeded(hash(rf.id ?? nf) + 11);
        const n = Math.min(14, Math.max(2, Math.round((len + w) / (rf.kind === "rocks" ? 5 : 12))));
        for (let k = 0; k < n; k++) {
          const v = k % 3;
          if (nr[v] >= CAP.rocks) continue;
          const t = n > 1 ? k / (n - 1) : 0.5, off = (rr() - 0.5) * w * 1.2;
          const x = ax + (bx - ax) * t + Math.cos(yaw) * off, z = az + (bz - az) * t - Math.sin(yaw) * off;
          const s = rf.kind === "rocks" ? 1.6 + rr() * 2.2 : 0.8 + rr() * 1.2;
          place(rockMeshes[v], nr[v]++, x, WATER_Y - s * (rf.kind === "rocks" ? 0.45 : 0.85), z, rr() * 6.28, s, s * (0.6 + rr() * 0.5), s);
        }
      }
    }
    reefs.count = nf; reefs.instanceMatrix.needsUpdate = true; aReef.needsUpdate = true;
    rockMeshes.forEach((m, i) => { m.count = nr[i]; m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); });
    for (const m of [trunks, crowns]) { m.count = np; m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
    huts.count = nh; huts.instanceMatrix.needsUpdate = true; huts.computeBoundingSphere();

    // Shoals.
    let ns = 0;
    for (const is of W.isles) {
      (is.isl.shoals || []).forEach((s, k) => {
        if (ns >= CAP.shoals || !Number.isFinite(+s.x)) return;
        const r = Math.max(8, +s.r || 30);
        place(shoals, ns, +s.x, WATER_Y + 0.03, +s.z, (hash(`${is.id}:${k}`) % 628) / 100, r);
        aShoal.setXY(ns, (hash(`${is.id}:${k}`) % 1000) / 1000, 0);
        shoalKeys.push({ key: `${is.id}:${k}`, id: s.id ?? `${is.id}:${k}`, i: ns });
        ns++;
      });
    }
    shoals.count = ns; shoals.instanceMatrix.needsUpdate = true; aShoal.needsUpdate = true;

    // The fort (one per world: the first island that has one). Rexmaw Raids: world.fort {x, z, island, towers:[{id, x, z}]}
    // — four gun towers along the coast joined by curtain walls (placeFortV2); v1's island fort otherwise.
    const F2 = world?.fort && Array.isArray(world.fort.towers) && world.fort.towers.length ? world.fort : null;
    const fi = F2 ? null : W.isles.find((is) => is.fort);
    curtains.count = 0;
    if (F2) placeFortV2(F2);
    else if (fi) {
      const f = fi.fort;
      const sea = Math.atan2(f.x - fi.sh.cx, f.z - fi.sh.cz);           // seaward (+Z local) = away from the island's centre
      fortMesh.position.set(f.x, WATER_Y + f.y - 0.5, f.z);
      fortMesh.rotation.set(0, sea, 0);
      fortMesh.visible = true;
      fortMesh.updateMatrixWorld(true);
      const guns = fortParts.guns.slice(0, clamp(f.guns, 1, fortParts.guns.length));
      W.fort = { id: fi.isl.fort.id ?? "fort", islandId: fi.id, x: f.x, z: f.z, y: WATER_Y + f.y, yaw: sea, silenced: false, smokeT: 0 };
      W.fortGuns = guns.map((g) => ({ pos: g.pos.clone().applyMatrix4(fortMesh.matrixWorld), dir: g.dir.clone().transformDirection(fortMesh.matrixWorld) }));
      for (const t of fortParts.torches) { const p = t.clone().applyMatrix4(fortMesh.matrixWorld); W.fortTorchIdx.push(addLight(p.x, p.y, p.z, FIRE, 4, 2.4, 1)); }
      // Two lights: one in the courtyard (the keep and the inner walls), one outside the seaward wall.
      fortLights[0].position.copy(new THREE.Vector3(0, 10, -1).applyMatrix4(fortMesh.matrixWorld));
      fortLights[1].position.copy(new THREE.Vector3(0, 9, 34).applyMatrix4(fortMesh.matrixWorld));
      fortLights[0].intensity = 1500; fortLights[1].intensity = 800;
      const fp = fortParts.flag.clone().applyMatrix4(fortMesh.matrixWorld);
      fortFlag.position.copy(fp);
      fortFlag.visible = true;
      // The towers at the fort's corners, seaward pair first (the core's towers[i] by index, or by nearest).
      TW.list = fortParts.towers.map((t, i) => {
        const base = new THREE.Matrix4().makeTranslation(t.x, 0, t.z).premultiply(fortMesh.matrixWorld);
        const pos = new THREE.Vector3().setFromMatrixPosition(base);
        const top = new THREE.Vector3(0, 13, 0).applyMatrix4(base);
        return { i, base, pos, top, fall: 0, down: false, dmg: 0, smokeT: Math.random() };
      });
      towerMesh.count = 4; rubbleMesh.count = 4;
      TW.list.forEach((t) => { towerMesh.setMatrixAt(t.i, t.base); rubbleMesh.setMatrixAt(t.i, _hide); towerMesh.setColorAt(t.i, _white); });
      towerMesh.instanceMatrix.needsUpdate = true; rubbleMesh.instanceMatrix.needsUpdate = true; towerMesh.instanceColor.needsUpdate = true;
      towerMesh.computeBoundingSphere(); rubbleMesh.computeBoundingSphere();
    } else { fortMesh.visible = false; fortFlag.visible = false; for (const l of fortLights) l.intensity = 0; towerMesh.count = 0; rubbleMesh.count = 0; TW.list = []; }

    // Wrecks.
    let nw = 0;
    for (const w of world?.wrecks || []) {
      if (nw >= CAP.wrecks || !Number.isFinite(+w.x)) continue;
      const rr = seeded(hash(w.id ?? nw) + 3);
      place(wrecks, nw, +w.x, WATER_Y - 1.6, +w.z, rr() * 6.28, 1, 1, 1, (rr() - 0.5) * 0.25, 0.35 + rr() * 0.4);
      const glints = [];
      for (let k = 0; k < 6; k++) glints.push(addLight(+w.x + (rr() - 0.5) * 10, WATER_Y + 0.2 + rr() * 1.6, +w.z + (rr() - 0.5) * 14, GOLD, 2.4, 0.5, 2, rr()));
      W.wrecks.push({ id: w.id, x: +w.x, z: +w.z, glints, salvaged: false, sparkT: rr() * 3 });
      nw++;
    }
    wrecks.count = nw; wrecks.instanceMatrix.needsUpdate = true; wrecks.computeBoundingSphere();

    // The smugglers' cove: the jetty runs out from the cove toward open water (away from the nearest island).
    const cv = world?.cove;
    if (cv && Number.isFinite(+cv.x)) {
      let near = null, nd = Infinity;
      for (const is of W.isles) { const d = Math.hypot(is.sh.cx - cv.x, is.sh.cz - cv.z); if (d < nd) { nd = d; near = is; } }
      const out = near ? Math.atan2(cv.x - near.sh.cx, cv.z - near.sh.cz) : 0;
      // The jetty's root on the shore: walk back toward the island until there's land.
      let rx = +cv.x, rz = +cv.z;
      if (near) {
        for (let k = 0; k < 40; k++) {
          if (islandH(near, rx, rz) > 0.6) break;
          rx -= Math.sin(out) * 4; rz -= Math.cos(out) * 4;
        }
      }
      coveMesh.position.set(rx, WATER_Y + 0.4 + (near ? Math.max(0, islandH(near, rx, rz)) * 0.2 : 0), rz);
      coveMesh.rotation.set(0, out, 0);
      coveMesh.visible = true;
      coveMesh.updateMatrixWorld(true);
      for (const l of jetty.lamps) { const p = l.clone().applyMatrix4(coveMesh.matrixWorld); W.coveLights.push(addLight(p.x, p.y, p.z, WARM, 3.4, 1.0, 1)); }
      const sp = jetty.signal.clone().applyMatrix4(coveMesh.matrixWorld);
      W.coveLights.push(addLight(sp.x, sp.y, sp.z, GREEN, 4.5, 1.2, 3));
      const wp = jetty.window.clone().applyMatrix4(coveMesh.matrixWorld);
      addLight(wp.x, wp.y, wp.z, WARM, 2.4, 1.0, 1);
      W.cove = { x: +cv.x, z: +cv.z, r: +cv.r || 60 };
    } else coveMesh.visible = false;

    // The harbour zone's buoys, on its seaward arc (the land lies to starboard of the mooring and astern).
    const port = world?.port;
    let nb = 0;
    if (port && Number.isFinite(+port.x)) {
      const r = +port.r || 140;
      for (let k = 0; k < 16 && nb < 14; k++) {
        const a = (k / 16) * Math.PI * 2;
        const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
        if (lx < -6 && lz < 75) continue;            // on the quay / in the town
        if (lz < -48) continue;                      // behind the headland
        place(buoys, nb++, +port.x + lx, WATER_Y, +port.z + lz, a, 1);
        addLight(+port.x + lx, WATER_Y + 2.7, +port.z + lz, nb % 2 ? WHITE : GOLD, 3.2, 0.9, 3, k / 16);
      }
    }
    buoys.count = nb; buoys.instanceMatrix.needsUpdate = true;
    W.buoys = nb;

    lightGeo.setDrawRange(0, nLights);
    for (const a of [lightGeo.attributes.position, lightGeo.attributes.aColor, lightGeo.attributes.aInfo]) a.needsUpdate = true;
  }

  // ---- Per frame ----
  const _sw = { h: 0, dx: 0, dz: 0 };
  let time = 0;
  function update(state, dt, { camPos } = {}) {
    time += dt;
    const sp = state?.ship;
    if (sp && Number.isFinite(+sp.x)) shipU.value.set(+sp.x, +sp.z);
    moonU.value = R.sky?.moonLight ?? 0.8;
    dayU.value = R.atmos?.day || 0;
    reefMat.uniforms.uDay.value = dayU.value;
    lightMat.uniforms.uDim.value = 1 - 0.8 * dayU.value;
    // Shoals revealed: true (all) or a list of ids/keys (the core's hazards.shoals lists the revealed ones).
    const rev = state?.shoalsRevealed ?? (Array.isArray(state?.hazards?.shoals) ? state.hazards.shoals.map((s) => s.id) : null);
    // Treasure afloat: Rexmaw Raids draws state.pickups in pickups.js (crates, barrels, bottles, chests,
    // flotsam); this pool stays for anything a caller hands it as `chests`.
    let nc = 0;
    for (const p of state?.chests || []) {
      if (nc >= CHESTS || !Number.isFinite(+p.x)) continue;
      const h = water.swellAt(+p.x, +p.z, _sw).h;
      const bob = Math.sin(time * 1.3 + nc) * 0.08;
      _e.set(_sw.dz * 0.5 + Math.sin(time * 0.9 + nc) * 0.08, (+p.x * 0.37 + nc) % 6.28, -_sw.dx * 0.5);
      _m.compose(_v.set(+p.x, WATER_Y + h + 0.1 + bob, +p.z), _q.setFromEuler(_e), _s.set(1, 1, 1));
      chests.setMatrixAt(nc, _m);
      if (camPos && Math.hypot(+p.x - camPos.x, +p.z - camPos.z) < 500 && Math.random() < dt * 1.5) fx.burst(_v.set(+p.x, WATER_Y + h + 0.8, +p.z), { color: "#ffd27a", count: 6, speed: 0.4, size: 0.16, life: 0.7, intensity: 3, gravity: 0 });
      nc++;
    }
    chests.count = nc;
    if (nc) chests.instanceMatrix.needsUpdate = true;
    revealU.value = rev === true ? 1 : 0;
    if (Array.isArray(rev) && shoalKeys.length) {
      let dirty = false;
      for (const s of shoalKeys) {
        const on = rev.includes(s.id) || rev.includes(s.key) ? 1 : 0;
        if (aShoal.getY(s.i) !== on) { aShoal.setY(s.i, on); dirty = true; }
      }
      if (dirty) aShoal.needsUpdate = true;
    }
    // Buoys bob.
    const port = W.world?.port;
    if (port && W.buoys) {
      for (let i = 0; i < W.buoys; i++) {
        buoys.getMatrixAt(i, _m);
        _v.setFromMatrixPosition(_m);
        const h = water.swellAt(_v.x, _v.z, _sw).h;
        _m.elements[13] = WATER_Y + h - 0.2;
        buoys.setMatrixAt(i, _m);
      }
      buoys.instanceMatrix.needsUpdate = true;
    }
    // Campfires near enough to matter.
    if (flames && camPos) {
      for (const f of W.campfires) if (Math.hypot(f.x - camPos.x, f.z - camPos.z) < 900) flames.add(_v.set(f.x, f.y, f.z), { size: 1.3, seed: f.x * 0.01, smoke: false });
    }
    // Wrecks: glints; a sparkle now and then while the gold is still there.
    const salv = state?.salvaged || (Array.isArray(state?.wrecks) ? state.wrecks.filter((w) => w.salvaged).map((w) => w.id) : null);
    for (const w of W.wrecks) {
      const done = !!(salv && salv.includes?.(w.id));
      if (done !== w.salvaged) {
        w.salvaged = done;
        for (const i of w.glints) if (i >= 0) { const k = done ? 0 : 2.4; lCol[i * 3] = GOLD.r * k; lCol[i * 3 + 1] = GOLD.g * k; lCol[i * 3 + 2] = GOLD.b * k; }
        lightGeo.attributes.aColor.needsUpdate = true;
      }
      if (!w.salvaged && camPos && Math.hypot(w.x - camPos.x, w.z - camPos.z) < 420) {
        w.sparkT -= dt;
        if (w.sparkT <= 0) { w.sparkT = 1.2 + Math.random() * 2.5; fx.burst(_v.set(w.x + (Math.random() - 0.5) * 8, WATER_Y + 0.6, w.z + (Math.random() - 0.5) * 12), { color: "#ffd27a", count: 8, speed: 0.6, size: 0.18, life: 0.8, intensity: 3, gravity: 0 }); }
      }
    }
    // The fort: silenced (a contact of cls "fort" at 0 hull or state "silenced", or state.fort.silenced).
    if (W.fort) {
      const fc = (state?.contacts || []).find((c) => String(c.cls || "").toLowerCase() === "fort");
      const silenced = !!(state?.fort?.silenced || (fc && (fc.state === "silenced" || fc.state === "sinking" || (Number.isFinite(+fc.hull) && +fc.hull <= 0))));
      if (silenced !== W.fort.silenced) {
        W.fort.silenced = silenced;
        for (const i of W.fortTorchIdx) if (i >= 0) { const k = silenced ? 0.6 : 3.2; lCol[i * 3] = FIRE.r * k; lCol[i * 3 + 1] = FIRE.g * k; lCol[i * 3 + 2] = FIRE.b * k; }
        lightGeo.attributes.aColor.needsUpdate = true;
        fortFlag.visible = !silenced;
        fortLights[0].intensity = silenced ? 2600 : 1800;      // silenced: the fort burns
        fortLights[0].color.set(silenced ? "#ff6a20" : "#ff9a4a");
      }
      if (W.fort.silenced) fortLights[0].intensity = 2200 + 500 * Math.sin(time * 11) * Math.sin(time * 4.3);
      if (silenced && flames) {
        for (let k = 0; k < 4; k++) {
          const g = W.fortGuns[(k * 3) % Math.max(1, W.fortGuns.length)];
          if (g) flames.add(_v.copy(g.pos).setY(g.pos.y + 0.5), { size: 2.6, seed: k * 0.31 });
        }
      }
      // The fort's flag streams downwind.
      const wd = W.world?.wind?.dirDeg ?? 0;
      fortFlag.rotation.y = -((wd + 180) * DEG) + Math.PI / 2;
      stepTowers(state, dt);
    }
  }

  /** Rexmaw Raids: the fort as the core lays it out — its towers where the core put them, curtain walls between, the flag on the middle one. */
  function placeFortV2(F) {
    let isl = W.isles.find((is) => is.id === F.island);
    if (!isl) { let bd = Infinity; for (const is of W.isles) { const d = Math.hypot(is.sh.cx - F.x, is.sh.cz - F.z); if (d < bd) { bd = d; isl = is; } } }
    const sea = isl ? Math.atan2(F.x - isl.sh.cx, F.z - isl.sh.cz) : 0;
    const towers = F.towers.slice(0, 4);
    const R_T = 9, H_T = 14;
    const sx = R_T / 5.6, sy = H_T / 12.4;
    TW.list = towers.map((t, i) => {
      const gy = Math.max(0, heightAt(+t.x, +t.z));
      const base = new THREE.Matrix4().compose(new THREE.Vector3(+t.x, WATER_Y + gy - 1.2, +t.z), _q.setFromAxisAngle(_Y, sea), new THREE.Vector3(sx, sy, sx));
      const pos = new THREE.Vector3().setFromMatrixPosition(base);
      const top = new THREE.Vector3(0, 13.2, 0).applyMatrix4(base);
      const gun = new THREE.Vector3(0, 13.3, 4.2).applyMatrix4(base);
      return { i, id: t.id, base, pos, top, gun, fall: 0, down: false, dmg: 0, smokeT: Math.random() };
    });
    towerMesh.count = TW.list.length; rubbleMesh.count = TW.list.length;
    TW.list.forEach((t) => { towerMesh.setMatrixAt(t.i, t.base); rubbleMesh.setMatrixAt(t.i, _hide); towerMesh.setColorAt(t.i, _white); });
    towerMesh.instanceMatrix.needsUpdate = true; rubbleMesh.instanceMatrix.needsUpdate = true; towerMesh.instanceColor.needsUpdate = true;
    towerMesh.computeBoundingSphere(); rubbleMesh.computeBoundingSphere();
    // Curtain walls from tower to tower (standing on the lower of the two footings).
    let nc = 0;
    for (let k = 0; k + 1 < TW.list.length && nc < CURTAINS; k++) {
      const a = TW.list[k].pos, b = TW.list[k + 1].pos;
      const len = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z) - R_T * 1.6);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
      _m.compose(_v.set((a.x + b.x) / 2, Math.min(a.y, b.y) + 0.4, (a.z + b.z) / 2), _q.setFromAxisAngle(_Y, yaw), _s.set(len / 10, 1, 1));
      curtains.setMatrixAt(nc++, _m);
    }
    curtains.count = nc; curtains.instanceMatrix.needsUpdate = true; curtains.computeBoundingSphere();
    fortMesh.visible = false;
    const mid = TW.list[Math.min(1, TW.list.length - 1)];
    W.fort = { id: F.id ?? "fort", islandId: isl?.id ?? null, x: +F.x, z: +F.z, y: mid ? mid.top.y : WATER_Y + 14, yaw: sea, silenced: false, smokeT: 0, v2: true };
    W.fortGuns = TW.list.map((t) => ({ id: t.id, pos: t.gun.clone(), dir: new THREE.Vector3(Math.sin(sea), 0.05, Math.cos(sea)).normalize() }));
    for (const t of TW.list) W.fortTorchIdx.push(addLight(t.top.x, t.top.y + 1.5, t.top.z, FIRE, 4, 2.4, 1));
    if (TW.list[0]) fortLights[0].position.copy(TW.list[0].top).add(_v.set(0, 3, 0));
    if (TW.list[2] || TW.list[1]) fortLights[1].position.copy((TW.list[2] || TW.list[1]).top).add(_v.set(0, 3, 0));
    fortLights[0].intensity = 1500; fortLights[1].intensity = 800;
    if (mid) { fortFlag.position.copy(mid.top).add(_v.set(0, 9, 0)); fortFlag.visible = true; }
  }

  /** A tower fires (`id` = its id; a mortar lobs high): flash and smoke at its gun, laid on the target. */
  function towerVolley(id, { balls = 1, target = null, mortar = false } = {}) {
    const t = TW.list.find((x) => x.id === id) || TW.list[0];
    if (!t || t.down) return false;
    const dir = new THREE.Vector3(0, mortar ? 1 : 0.05, 1);
    if (target) dir.set(target.x - t.gun.x, 0, target.z - t.gun.z).normalize().setY(mortar ? 1.2 : 0.06).normalize();
    for (let i = 0; i < clamp(balls || 1, 1, 3); i++) setTimeout(() => fx.muzzle(t.gun, dir, { scale: mortar ? 1.4 : 1.25, smoke: R.quality.smoke ?? 1 }), i * 140);
    return true;
  }

  /** The gun towers: state.fort.towers [{id, x?, z?, hp, hpMax, destroyed}] (by index, or matched by nearest x/z). */
  function stepTowers(state, dt) {
    const list = state?.fort?.towers;
    if (!Array.isArray(list) || !TW.list.length) return;
    let dirty = false, cdirty = false;
    for (let j = 0; j < list.length && j < 8; j++) {
      const s = list[j];
      let t = TW.list[j];
      if (Number.isFinite(+s?.x)) {
        let bd = Infinity;
        for (const c of TW.list) { const d = Math.hypot(c.pos.x - +s.x, c.pos.z - +s.z); if (d < bd) { bd = d; t = c; } }
      }
      if (!t) continue;
      const hpMax = +s.hpMax || 100;
      const hp = Number.isFinite(+s.hp) ? +s.hp : hpMax;
      const down = !!(s.destroyed || s.down || s.silenced || hp <= 0);
      const dmg = clamp(1 - hp / hpMax, 0, 1);
      if (Math.abs(dmg - t.dmg) > 0.01) { t.dmg = dmg; towerMesh.setColorAt(t.i, _c.setScalar(1 - 0.55 * dmg)); cdirty = true; }
      if (down && !t.down) {
        t.down = true; t.fall = 0;
        fx.explosion?.(t.top.clone(), { scale: 1.3 });
        fx.splinters?.(t.top.clone(), { count: 40, scale: 2 });
        R.cam?.trauma?.(0.25);
      }
      if (!down && t.down) { t.down = false; t.fall = 0; towerMesh.setMatrixAt(t.i, t.base); rubbleMesh.setMatrixAt(t.i, _hide); dirty = true; }
      if (t.down && t.fall < 1) {
        t.fall = Math.min(1, t.fall + dt / 1.6);
        const k = t.fall * t.fall;
        // It slumps, leans and sinks into its own dust, then the rubble shows.
        _m.copy(t.base).multiply(_m2.makeRotationZ(0.35 * k)).multiply(_m3.makeTranslation(0, -13 * k, 0));
        towerMesh.setMatrixAt(t.i, t.fall >= 1 ? _hide : _m);
        if (t.fall >= 1) rubbleMesh.setMatrixAt(t.i, t.base);
        if (Math.random() < dt * 20) fx.ghostMist?.(t.pos.clone().setY(t.pos.y + 4 + Math.random() * 6), { thick: true });
        dirty = true;
      }
      // The ruin burns and smokes.
      if (t.down && flames) flames.add(_v.copy(t.pos).setY(t.pos.y + 2.5), { size: 3.2, seed: t.i * 0.41 + 0.2, smoke: true });
    }
    if (dirty) { towerMesh.instanceMatrix.needsUpdate = true; rubbleMesh.instanceMatrix.needsUpdate = true; }
    if (cdirty) towerMesh.instanceColor.needsUpdate = true;
  }

  /** The fort's guns facing a target fire (`balls` of them): flashes and smoke at the embrasures. */
  function fortVolley({ balls = 0, target = null } = {}) {
    if (!W.fort || !W.fortGuns.length) return false;
    let guns = W.fortGuns;
    if (target) {
      guns = [...guns].sort((a, b) => {
        const da = _v.set(target.x - a.pos.x, 0, target.z - a.pos.z).normalize().dot(a.dir);
        const db = _v.set(target.x - b.pos.x, 0, target.z - b.pos.z).normalize().dot(b.dir);
        return db - da;
      });
    }
    const n = clamp(balls || Math.ceil(guns.length / 2), 1, guns.length);
    guns.slice(0, n).forEach((g, i) => setTimeout(() => fx.muzzle(g.pos, g.dir, { scale: 1.2, smoke: R.quality.smoke ?? 1 }), i * 110));
    return true;
  }

  return {
    root,
    setWorld,
    update,
    heightAt,
    fortVolley,
    /** The fort's centre (world) and id, or null. */
    get fort() { return W.fort ? { id: W.fort.id, x: W.fort.x, y: W.fort.y, z: W.fort.z, silenced: W.fort.silenced } : null; },
    /** Rexmaw Raids: the fort's four gun towers, world: [{i, x, z, top: {x, y, z}, down}] (index i ↔ state.fort.towers[i]). */
    fortTowers() { return TW.list.map((t) => ({ i: t.i, id: t.id ?? null, x: t.pos.x, z: t.pos.z, top: { x: t.top.x, y: t.top.y, z: t.top.z }, down: t.down })); },
    /** A tower's top (world), by its id ("tower1"…) or index, or null (HUD labels, audio, the spyglass). */
    towerPos(id, out = new THREE.Vector3()) { const t = TW.list.find((x) => x.id === id) || (Number.isInteger(id) ? TW.list[id] : null); return t ? out.copy(t.top) : null; },
    towerVolley,
    /** For the compile warm-up. */
    warmShow(on) {
      if (on) { for (const m of [...rockMeshes, trunks, crowns, huts, wrecks, shoals, buoys, towerMesh, rubbleMesh, curtains, reefs]) m.count = Math.max(1, m.count); fortMesh.visible = true; coveMesh.visible = true; fortFlag.visible = true; }
      else if (W.world) setWorld(W.world);
      else { for (const m of [...rockMeshes, trunks, crowns, huts, wrecks, shoals, buoys, towerMesh, rubbleMesh, curtains, reefs]) m.count = 0; fortMesh.visible = false; coveMesh.visible = false; fortFlag.visible = false; }
    },
    stats() { return { islands: W.isles.length, lights: nLights, rocks: rockMeshes.reduce((n, m) => n + m.count, 0), palms: trunks.count, huts: huts.count, shoals: shoals.count, wrecks: wrecks.count }; },
    dispose() {
      root.removeFromParent();
      for (const l of fortLights) l.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
}
