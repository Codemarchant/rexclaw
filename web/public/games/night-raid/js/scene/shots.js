// Night Raid: shot in flight. The sim simulates every ball as a projectile
// (state.projectiles: {id, from, x, y, z, vx, vy, vz, ammo}); this draws
// them: round and heavy shot as iron balls, chain shot as a spinning pair on
// its chain, grape as a cloud of small balls, all instanced (one draw per
// ammo), each with a faint glowing trail of burning wad and smoke so a ball
// can be followed at night. Between the sim's 10 Hz samples a ball flies on
// ballistically (gravity 9.81), so it moves smoothly at any frame rate.
// When a ball vanishes without a hit reported near it, it splashes where it
// went in (a tall white column for heavy shot).

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";

const CAP = 160;
const G = 9.81;
const AMMO = ["round", "heavy", "chain", "grape", "swivel"];

/**
 * @param {object} R  the render context
 * @param {{fx: object}} deps
 */
export function createShots(R, { fx }) {
  const root = new THREE.Group();
  root.name = "shots";
  R.scene.add(root);
  const iron = new THREE.MeshStandardMaterial({ name: "nr-shot-iron", color: "#2a2a2c", roughness: 0.45, metalness: 0.8, emissive: "#ff6a20", emissiveIntensity: 0.25, envMapIntensity: 0.6 });
  const geos = {
    round: new THREE.SphereGeometry(0.16, 10, 8),
    heavy: new THREE.SphereGeometry(0.24, 12, 9),
    swivel: new THREE.SphereGeometry(0.08, 8, 6),
  };
  {
    // Chain shot: two half-balls on a short chain (along x, spun as it flies).
    const a = new THREE.SphereGeometry(0.13, 8, 6); a.translate(-0.55, 0, 0);
    const b = new THREE.SphereGeometry(0.13, 8, 6); b.translate(0.55, 0, 0);
    const c = new THREE.CylinderGeometry(0.025, 0.025, 1.1, 5); c.rotateZ(Math.PI / 2);
    geos.chain = mergeSimple([a, b, c]);
    // Grape: a cluster.
    const parts = [];
    for (let i = 0; i < 9; i++) { const s = new THREE.SphereGeometry(0.06, 6, 4); s.translate((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.9); parts.push(s); }
    geos.grape = mergeSimple(parts);
  }
  const meshes = {};
  for (const k of AMMO) {
    const m = new THREE.InstancedMesh(geos[k], iron, CAP);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.name = `shots-${k}`;
    m.layers.set(LAYERS.FX);
    root.add(m);
    meshes[k] = m;
  }

  const live = new Map();     // id → {x, y, z, vx, vy, vz, ammo, t0, px, py, pz, seen, spin, trailAcc}
  const impacts = [];         // recent hits: {x, y, z, t}
  let time = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
  const counts = {};

  function ingest(list) {
    const seen = new Set();
    for (const p of list || []) {
      if (!p || p.id == null || !Number.isFinite(+p.x) || !Number.isFinite(+p.z)) continue;
      seen.add(p.id);
      let b = live.get(p.id);
      const y = Number.isFinite(+p.y) ? +p.y : WATER_Y + 2;
      if (!b) {
        b = { x: +p.x, y, z: +p.z, vx: +p.vx || 0, vy: +p.vy || 0, vz: +p.vz || 0, ammo: AMMO.includes(p.ammo) ? p.ammo : "round", t0: time, px: +p.x, py: y, pz: +p.z, spin: Math.random() * 6, trailAcc: 0, from: p.from };
        live.set(p.id, b);
      } else if (b.x !== +p.x || b.y !== y || b.z !== +p.z) {
        // A new sample: restart the extrapolation from it.
        b.x = +p.x; b.y = y; b.z = +p.z; b.vx = +p.vx || 0; b.vy = +p.vy || 0; b.vz = +p.vz || 0; b.t0 = time;
      }
    }
    // Balls the sim dropped: a splash where they went in, unless a hit was reported there.
    for (const [id, b] of live) {
      if (seen.has(id)) continue;
      live.delete(id);
      const hit = impacts.some((h) => Math.hypot(h.x - b.px, h.z - b.pz) < 9 && time - h.t < 0.8);
      if (!hit && b.py < WATER_Y + 4) splashAt(b.px, b.pz, b.ammo);
    }
  }

  function splashAt(x, z, ammo) {
    const s = ammo === "heavy" ? 1.5 : ammo === "grape" ? 0.55 : ammo === "swivel" ? 0.4 : 1.0;
    fx.splash(_p.set(x, WATER_Y, z), { scale: s });
    if (ammo === "grape") for (let i = 0; i < 4; i++) fx.splash(_p.set(x + (Math.random() - 0.5) * 8, WATER_Y, z + (Math.random() - 0.5) * 8), { scale: 0.35 });
  }

  function update(state, dt) {
    time += dt;
    ingest(state?.projectiles);
    for (const k of AMMO) counts[k] = 0;
    const trailColor = new THREE.Color("#ff8a3a");
    for (const b of live.values()) {
      const t = time - b.t0;
      b.px = b.x + b.vx * t;
      b.py = b.y + b.vy * t - 0.5 * G * t * t;
      b.pz = b.z + b.vz * t;
      b.spin += dt * 14;
      const m = meshes[b.ammo];
      const i = counts[b.ammo];
      if (i >= CAP) continue;
      _e.set(b.spin * 0.3, b.spin, 0);
      _m.compose(_p.set(b.px, b.py, b.pz), _q.setFromEuler(_e), _s);
      m.setMatrixAt(i, _m);
      counts[b.ammo] = i + 1;
      // The trail: smouldering wad and a thread of smoke.
      b.trailAcc += dt * (b.ammo === "swivel" ? 50 : 30);
      while (b.trailAcc >= 1) {
        b.trailAcc -= 1;
        fx.trailMote?.(_p, trailColor, b.ammo === "heavy" ? 1.3 : b.ammo === "swivel" ? 0.6 : 1);
      }
    }
    for (const k of AMMO) {
      meshes[k].count = counts[k];
      if (counts[k]) meshes[k].instanceMatrix.needsUpdate = true;
    }
    for (let i = impacts.length - 1; i >= 0; i--) if (time - impacts[i].t > 2) impacts.splice(i, 1);
  }

  return {
    update,
    /** A hit was reported at (x, y, z): no splash for the ball that made it. */
    noteImpact(x, y, z) { impacts.push({ x: +x || 0, y: +y || 0, z: +z || 0, t: time }); },
    /** Where ball `id` is now (world), or null. */
    positionOf(id, out = new THREE.Vector3()) { const b = live.get(id); return b ? out.set(b.px, b.py, b.pz) : null; },
    get count() { return live.size; },
    warmShow(on) { for (const k of AMMO) meshes[k].count = on ? Math.max(1, meshes[k].count) : (counts[k] || 0); },
    reset() { live.clear(); impacts.length = 0; for (const k of AMMO) meshes[k].count = 0; },
    dispose() {
      root.removeFromParent();
      for (const g of Object.values(geos)) g.dispose();
      iron.dispose();
    },
  };
}

function mergeSimple(list) {
  let n = 0, ni = 0;
  for (const g of list) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), idx = new Uint32Array(ni);
  let o = 0, oi = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) idx[oi + i] = ia[i] + o;
    o += g.attributes.position.count; oi += ia.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
