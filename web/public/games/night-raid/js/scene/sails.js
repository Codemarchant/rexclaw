// Rexmaw Raids: the Rexmaw's own canvas. The GLB (rexmaw_deck.glb) carries her sails furled on the
// yards; this sets real sails on those yards (courses, topsails, topgallants, the jibs and the
// spanker, from the ship kit's sail builder) that billow with the wind and reef with the sail
// state: furled → half sail (topsails, t'gallants, jibs; the courses stay furled) → full sail
// (everything) → the sprint (full, straining). A GLB bundle shows only while its sail is in.
// Her colours: the black flag at the main truck and a long red pennant at the fore.
//
// Ship-space numbers measured from the GLB (yards' furled bundles): mizzen z −9.8 (yards y 9.5,
// 14; on the quarterdeck, floor 2.6), main z 8 (9.5, 15.5, 22.5; main deck 0), fore z 16 (9.5,
// 15, 19.5; forecastle 1.6), bowsprit tip (0, 6.5, 28.5), the spanker's boom at y 4.5.

import * as THREE from "three";
import { sailGeometry, sailMaterial, shipUniforms, flagMaterial, SAIL_TINT } from "./shipkit.js";
import { shipTextures } from "./textures.js";

const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** The Rexmaw's masts as the ship kit's plan. */
export const REXMAW_PLAN = Object.freeze({
  list: [
    { i: 0, z: -9.8, t: 0.1, r: 0.22, base: 2.6, h: 16, top: 9.0, cross: 13.5, mizzen: true, yards: [{ y: 9.5, w: 9.0 }, { y: 14.0, w: 6.3 }] },
    { i: 1, z: 8.0, t: 0.55, r: 0.3, base: 0, h: 27, top: 9.2, cross: 15.2, yards: [{ y: 9.5, w: 13.6 }, { y: 15.5, w: 10.2 }, { y: 22.5, w: 6.6 }] },
    { i: 2, z: 16.0, t: 0.85, r: 0.28, base: 1.6, h: 22, top: 9.2, cross: 14.8, yards: [{ y: 9.5, w: 11.8 }, { y: 15.0, w: 8.8 }, { y: 19.5, w: 5.6 }] },
  ],
  bowsprit: { from: [0, 2.6, 19.0], to: [0, 6.5, 28.5], len: 10.3, ang: 22 * DEG },
});

/**
 * @param {object} R
 * @param {{ship: object}} deps  ship.js (its `furled` meshes and its root, R.shipSpace)
 */
export function createSails(R, { ship }) {
  const T = shipTextures();
  const U = shipUniforms(R.water?.uniforms?.uTime);
  const tint = SAIL_TINT.rexmaw;
  U.uSailTint.value.setRGB(tint[0], tint[1], tint[2]);
  U.uSeed.value = 4.2;
  U.uSet.value = 0;
  const plan = REXMAW_PLAN;
  const geo = sailGeometry(plan, {
    courseFoot: (m) => m.base + (m.i === 1 ? 2.6 : 2.4),
    skipCourse: (m) => m.mizzen,
    jibs: 2, bulge: 0.15, scaleW: 0.97,
    foreStay: [0, 13.6, 16.3],
  });
  const mat = sailMaterial(U);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "rexmaw-sails";
  mesh.frustumCulled = false;
  // No shadow receiving: the shadow pass draws the canvas unbillowed, so it would stripe itself.
  mesh.receiveShadow = false;
  const parent = R.shipSpace || R.scene;
  parent.add(mesh);

  // The colours: the black flag at the main truck, a red pennant streaming from the fore.
  const flagGeo = (() => {
    const parts = [];
    const make = (w, h, pivot, rect, pennant) => {
      const g = new THREE.PlaneGeometry(w, h, 14, 4);
      const p = g.attributes.position, uv = g.attributes.uv, n = p.count;
      const aF = new Float32Array(n * 4), aW = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        let y = (v - 0.5) * h;
        if (pennant) y *= 1 - u * 0.85;
        p.setXYZ(i, pivot[0], pivot[1] + y, pivot[2] - u * w);
        uv.setXY(i, rect.u0 + (rect.u1 - rect.u0) * u, rect.v0 + (rect.v1 - rect.v0) * v);
        aF.set([pivot[0], pivot[1], pivot[2], w], i * 4);
        aW.set([rect.u0, rect.v0], i * 2);
      }
      g.setAttribute("aFlag", new THREE.BufferAttribute(aF, 4));
      g.setAttribute("aWhite", new THREE.BufferAttribute(aW, 2));
      g.computeVertexNormals();
      parts.push(g);
    };
    make(4.4, 2.8, [0, 26.2, 8.2], T.flagRect("pirate"), false);
    make(7, 0.7, [0, 21.6, 16.2], T.flagRect("pennant"), true);
    const g0 = parts[0], g1 = parts[1];
    const merged = new THREE.BufferGeometry();
    for (const name of Object.keys(g0.attributes)) {
      const a = g0.attributes[name], b = g1.attributes[name];
      const arr = new Float32Array(a.array.length + b.array.length);
      arr.set(a.array, 0); arr.set(b.array, a.array.length);
      merged.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    const ia = g0.index.array, ib = g1.index.array, off = g0.attributes.position.count;
    merged.setIndex([...ia, ...Array.from(ib, (x) => x + off)]);
    g0.dispose(); g1.dispose();
    return merged;
  })();
  const flag = new THREE.Mesh(flagGeo, flagMaterial(U));
  flag.name = "rexmaw-colours";
  flag.frustumCulled = false;
  parent.add(flag);

  // The GLB's furled bundles, split by yard: a bundle shows while its sail is in.
  const bundles = [];      // {mesh, tier}
  const tierOf = (x, y, z) => (y < 6 ? 4 : y < 11.5 ? (z < -5 ? -1 : 0) : y < 17 ? 1 : 2);
  for (const m of ship?.furled || []) {
    const g = m.geometry;
    const pos = g.attributes.position.array;
    const idx = g.index ? g.index.array : null;
    const tri = idx ? idx.length / 3 : pos.length / 9;
    const lists = new Map();
    for (let t = 0; t < tri; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const y = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      const tier = tierOf(0, y, z);
      if (!lists.has(tier)) lists.set(tier, []);
      lists.get(tier).push(a, b, c);
    }
    for (const [tier, list] of lists) {
      const part = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) part.setAttribute(name, attr);
      part.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? Uint32Array.from(list) : Uint16Array.from(list), 1));
      part.boundingSphere = g.boundingSphere?.clone() || null;
      if (!part.boundingSphere) part.computeBoundingSphere();
      const pm = new THREE.Mesh(part, m.material);
      pm.name = `${m.name}-tier${tier}`;
      pm.castShadow = m.castShadow; pm.receiveShadow = m.receiveShadow;
      pm.layers.mask = m.layers.mask;
      m.parent?.add(pm);
      bundles.push({ mesh: pm, tier });
    }
    m.visible = false;
  }

  const st = { set: 0, setT: 0, wind: 0.7, sprint: 0, tearT: 0, fade: 1, fadeT: 1 };
  const setK = (tier, s) => { const th = tier === 0 ? 0.58 : tier === 1 ? 0.1 : tier === 2 ? 0.3 : tier === 3 ? 0.45 : 0.04; const t = clamp((s - th) / 0.28, 0, 1); return t * t * (3 - 2 * t); };

  function update(dt, { sail = 0, sprint = false, wind = null, heading = 0, masts = 100, day = 0 } = {}) {
    const d = Math.min(0.1, Math.max(0, dt));
    const s = clamp(Math.round(+sail || 0), 0, 3);
    st.setT = s === 0 ? 0 : s === 1 ? 0.5 : 1;
    // Setting canvas takes a moment; taking it in is quicker.
    const rate = st.setT > st.set ? 0.9 : 1.4;
    st.set += clamp(st.setT - st.set, -rate * d, rate * d);
    U.uSet.value = st.set;
    st.sprint += ((sprint || s >= 3 ? 1 : 0) - st.sprint) * Math.min(1, d * 2);
    const w = clamp(+wind?.strength || 0.7, 0, 1.2);
    U.uWind.value = clamp(w * (0.85 + 0.45 * st.sprint), 0, 1.4);
    const rel = wrap180((+wind?.dirDeg || 0) - heading);
    U.uLee.value = rel >= 0 ? 1 : -1;
    const downwind = wrap180((+wind?.dirDeg || 0) + 180 - heading);
    U.uFlagYaw.value = Math.PI - downwind * DEG;
    // Damage aloft: holes in the canvas.
    const mk = Number.isFinite(+masts) ? (+masts <= 1.0001 ? +masts * 100 : +masts) : 100;
    st.tearT = clamp((100 - mk) / 100 * 0.55, 0, 0.55);
    U.uTear.value += (st.tearT - U.uTear.value) * Math.min(1, d * 2);
    for (const b of bundles) b.mesh.visible = b.tier < 0 || setK(b.tier, st.set) < 0.5;
    // Aiming over the bow, her own canvas thins (dithered) so the Captain sees the sea ahead.
    st.fade += (st.fadeT - st.fade) * Math.min(1, d * 6);
    U.uVis.value = st.fade;
    flag.visible = st.fade > 0.5;
    mesh.castShadow = st.set > 0.95 && day > 0.5;
    U.uWin.value = 1 - 0.9 * day;
  }

  return {
    mesh, flag, uniforms: U, plan,
    update,
    /** 0 furled .. 1 full, as drawn now. */
    get set() { return st.set; },
    /** Thin her canvas (1 = solid, 0.3 = see-through dither) — the bow aim. */
    setFade(v) { st.fadeT = Math.max(0.15, Math.min(1, +v || 0)); },
    warmShow(on) { if (on) U.uSet.value = 1; },
    dispose() { mesh.removeFromParent(); flag.removeFromParent(); geo.dispose(); mat.dispose(); flagGeo.dispose(); flag.material.dispose(); for (const b of bundles) { b.mesh.removeFromParent(); b.mesh.geometry.dispose(); } },
  };
}
