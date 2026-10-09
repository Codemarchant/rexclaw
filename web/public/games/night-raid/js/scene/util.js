// Night Raid (from Night Helm): small helpers the scene modules share (from Starboard's arc.js,
// which no longer comes along): easings, promise tweens, seeded noise, a
// seeded RNG, mergeStatic (one draw per material for a built prop), and the
// v2 data helpers (reaches, live positions of drifting things).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Easing curves, k in 0..1. */
export const ease = Object.freeze({
  inOut: (k) => k * k * (3 - 2 * k),
});

/**
 * Promise-based tweens driven by a frame loop. `flush()` finishes every
 * tween at once; `setSpeed` scales time (debug fast cinematics).
 */
export function createTweens() {
  const active = new Set();
  let speed = 1, instant = false;
  const finish = (tw) => {
    if (tw.done) return;
    tw.done = true;
    active.delete(tw);
    try { tw.update?.(1, 1); } catch (error) { console.debug("[night-raid] tween threw", error); }
    tw.resolve(true);
  };
  return {
    /**
     * @param {number} seconds
     * @param {(e: number, k: number) => void} [update]  eased and raw progress, 0..1
     * @param {{ease?: (k: number) => number, delay?: number}} [opts]
     * @returns {Promise<boolean>} true when it ran to the end, false when cancelled
     */
    tween(seconds, update = null, { ease: fn = ease.inOut, delay = 0 } = {}) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      const tw = { t: -Math.max(0, delay), d: Math.max(1e-4, seconds), update: update && ((k) => update(fn(k), k)), resolve, done: false };
      if (instant) finish(tw); else active.add(tw);
      return promise;
    },
    wait(seconds) { return this.tween(seconds); },
    update(dt) {
      if (!active.size) return;
      const d = dt * speed;
      for (const tw of [...active]) {
        tw.t += d;
        if (tw.t < 0) continue;
        const k = Math.min(1, tw.t / tw.d);
        if (k >= 1) finish(tw);
        else try { tw.update?.(k); } catch (error) { console.debug("[night-raid] tween threw", error); }
      }
    },
    flush() {
      instant = true;
      for (let guard = 0; active.size && guard < 64; guard++) for (const tw of [...active]) finish(tw);
      setTimeout(() => { instant = false; }, 0);
    },
    setSpeed(s) { speed = s > 0 ? s : 1; },
    cancel() { for (const tw of [...active]) { tw.done = true; tw.resolve(false); } active.clear(); },
    get busy() { return active.size > 0; },
  };
}

/** A seeded generator (mulberry32) returning floats in [0, 1). @param {number} seed */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit string/number hash (FNV-1a). */
export function hash(s) {
  const str = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Smooth 1D value noise in [-1, 1]. @param {number} x @param {number} [seed=0] */
export function noise1(x, seed = 0) {
  const h = (n) => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/**
 * Merge a group's static meshes into one mesh per material. Descends into
 * children but stops at any object marked `userData.dynamic` and leaves
 * meshes marked `userData.keep` alone. Geometry is baked into the group's
 * own frame; the parts are removed and disposed.
 * @param {THREE.Object3D} group
 * @returns {THREE.Mesh[]}
 */
export function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const parts = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (c.userData.dynamic) continue;
      if (c.isMesh && !c.isInstancedMesh && !Array.isArray(c.material) && !c.userData.keep && c.geometry?.index) parts.push(c);
      if (c.children.length) walk(c);
    }
  };
  walk(group);
  const byMat = new Map();
  for (const c of parts) {
    if (!byMat.has(c.material)) byMat.set(c.material, []);
    byMat.get(c.material).push(c);
  }
  const out = [];
  const m4 = new THREE.Matrix4();
  for (const [mat, list] of byMat) {
    if (list.length < 2) continue;
    const geos = list.map((c) => {
      const g = c.geometry.clone().applyMatrix4(m4.multiplyMatrices(inv, c.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      g.clearGroups();
      return g;
    });
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const first = list[0];
    const m = new THREE.Mesh(merged, mat);
    m.name = `${group.name || "group"}-${mat.name || "merged"}`;
    m.castShadow = list.some((c) => c.castShadow);
    m.receiveShadow = list.some((c) => c.receiveShadow);
    m.renderOrder = first.renderOrder;
    m.layers.mask = first.layers.mask;
    if (first.customDistanceMaterial) m.customDistanceMaterial = first.customDistanceMaterial;
    for (const c of list) {
      for (const k of [...c.children]) group.attach(k);
      c.removeFromParent();
      c.geometry.dispose();
    }
    group.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Merge a list of geometries (any attributes) into one non-indexed-safe
 * geometry with position/normal/uv only. For building props.
 * @param {THREE.BufferGeometry[]} geos
 */
export function mergeParts(geos) {
  const list = geos.map((g) => {
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    return g.index ? g : indexify(g);
  });
  const merged = mergeGeometries(list, false);
  list.forEach((g) => g.dispose());
  return merged;
}

function indexify(g) {
  const n = g.attributes.position.count;
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
