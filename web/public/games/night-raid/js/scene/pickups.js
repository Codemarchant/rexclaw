// Rexmaw Raids: the collectables afloat (state.pickups): crates, barrels (repair kits), bottles
// (doubloons and notes), treasure chests and the flotsam every sunk ship spills. They ride the
// swell, turn slowly, glint (a sparkle that catches the sun or the moon), and when the core says
// one is taken (`pickup {id}`) it leaps from the water in an arc onto the Rexmaw's deck, spinning,
// with a gold burst and a ring across the sea.
//
// Draws: five instanced meshes (one per kind, shared material) and one additive glint draw.
// v4.2: the power-ups afloat (state.powerups) ride along as their own layer (powerups.js): stepped from update(),
// their `powerup` events through powerup(p), shown for the compile with the rest.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LAYERS, WATER_Y } from "./blocking.js";
import { createPowerupLayer } from "./powerups.js";

const CAP = 48;
const KINDS = ["crate", "barrel", "bottle", "chest", "flotsam"];
const KIND_OF = { crate: "crate", cargo: "crate", powder: "barrel", barrel: "barrel", repair: "barrel", kit: "barrel", bottle: "bottle", note: "bottle", message: "bottle", doubloons: "bottle", chest: "chest", treasure: "chest", ring: "chest", gold: "chest", flotsam: "flotsam", wreckage: "flotsam", spar: "flotsam" };

function colorize(g, hex, extra = 0) {
  g = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(g.attributes)) if (!["position", "normal"].includes(k)) g.deleteAttribute(k);
  const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3), em = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; em[i] = extra; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aGlow", new THREE.BufferAttribute(em, 1));
  return g;
}
function geometries() {
  const crate = mergeGeometries([
    colorize(new THREE.BoxGeometry(1.1, 1.1, 1.1), "#8a6438"),
    colorize(new THREE.BoxGeometry(1.16, 0.14, 1.16).translate(0, 0.38, 0), "#4a3220"),
    colorize(new THREE.BoxGeometry(1.16, 0.14, 1.16).translate(0, -0.38, 0), "#4a3220"),
    colorize(new THREE.BoxGeometry(0.14, 1.16, 1.16).translate(0.38, 0, 0), "#4a3220"),
  ]);
  const barrel = mergeGeometries([
    colorize(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 12, 1).rotateZ(Math.PI / 2), "#7a4a24"),
    colorize(new THREE.CylinderGeometry(0.47, 0.47, 0.1, 12).rotateZ(Math.PI / 2).translate(0.3, 0, 0), "#2a2a2a"),
    colorize(new THREE.CylinderGeometry(0.47, 0.47, 0.1, 12).rotateZ(Math.PI / 2).translate(-0.3, 0, 0), "#2a2a2a"),
    colorize(new THREE.CylinderGeometry(0.43, 0.43, 0.12, 12).rotateZ(Math.PI / 2).translate(0, 0, 0), "#c23a2a"),
  ]);
  const bottle = mergeGeometries([
    colorize(new THREE.CylinderGeometry(0.16, 0.18, 0.55, 10).rotateZ(Math.PI / 2), "#2f6a3a", 0.25),
    colorize(new THREE.CylinderGeometry(0.06, 0.12, 0.25, 8).rotateZ(-Math.PI / 2).translate(0.38, 0, 0), "#2f6a3a", 0.25),
    colorize(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 8).rotateZ(Math.PI / 2).translate(0.54, 0, 0), "#a0784a"),
    colorize(new THREE.BoxGeometry(0.3, 0.12, 0.12).translate(-0.02, 0, 0), "#f0e2c0", 0.4),
  ]);
  const lid = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).translate(0, 0.32, 0);
  const chest = mergeGeometries([
    colorize(new THREE.BoxGeometry(1.2, 0.64, 0.8), "#5a3a1e"),
    colorize(lid, "#6b4422"),
    colorize(new THREE.BoxGeometry(1.24, 0.09, 0.84).translate(0, 0.14, 0), "#d4a92a", 0.3),
    colorize(new THREE.BoxGeometry(0.09, 0.9, 0.84).translate(0.4, 0.15, 0), "#d4a92a", 0.3),
    colorize(new THREE.BoxGeometry(0.09, 0.9, 0.84).translate(-0.4, 0.15, 0), "#d4a92a", 0.3),
    colorize(new THREE.SphereGeometry(0.22, 8, 6).scale(1.6, 0.4, 1).translate(0, 0.42, 0), "#ffd36a", 1.2),
  ]);
  const flotsam = mergeGeometries([
    colorize(new THREE.BoxGeometry(3.2, 0.14, 0.36).translate(0, 0, -0.3), "#6a4a2c"),
    colorize(new THREE.BoxGeometry(2.6, 0.14, 0.3).rotateY(0.4).translate(0.2, 0.06, 0.35), "#5a3d22"),
    colorize(new THREE.CylinderGeometry(0.16, 0.16, 3.6, 7).rotateZ(Math.PI / 2).rotateY(-0.5).translate(-0.3, 0.1, 0.1), "#4a3220"),
    colorize(new THREE.BoxGeometry(0.7, 0.5, 0.7).translate(1.1, 0.12, -0.1), "#8a6438"),
  ]);
  return { crate, barrel, bottle, chest, flotsam };
}

/**
 * @param {object} R
 * @param {{water: object, fx: object}} deps
 */
export function createPickups(R, { water, fx, flames = null }) {
  const root = new THREE.Group();
  root.name = "pickups";
  R.scene.add(root);
  const geos = geometries();
  const powerups = createPowerupLayer(R, { water, fx });
  const glowU = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ name: "rr-pickup", vertexColors: true, roughness: 0.7, metalness: 0.1, envMapIntensity: 0.6 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = glowU;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aGlow;\nvarying float vRrGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRrGlow = aGlow;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vRrGlow;\nuniform float uNight;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vRrGlow * (0.4 + 1.6 * uNight);");
  };
  mat.customProgramCacheKey = () => "rr-pickup";
  const meshes = {};
  for (const k of KINDS) {
    const m = new THREE.InstancedMesh(geos[k], mat, CAP);
    m.name = `pickups-${k}`;
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(m);
    meshes[k] = m;
  }

  // Glints: one additive Points draw.
  const gPos = new Float32Array(CAP * 3), gInfo = new Float32Array(CAP * 2);
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute("position", new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage));
  gGeo.setAttribute("aInfo", new THREE.BufferAttribute(gInfo, 2).setUsage(THREE.DynamicDrawUsage));
  gGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  gGeo.setDrawRange(0, 0);
  const wu = water.uniforms;
  const gMat = new THREE.ShaderMaterial({
    name: "RexmawPickupGlints", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uScale: { value: 800 } },
    vertexShader: /* glsl */`
      attribute vec2 aInfo;            // seed, gold (0/1)
      uniform float uTime, uFogDensity, uScale;
      varying float vK; varying float vGold;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 1.0);
        float tw = sin(uTime * (1.7 + aInfo.x * 1.3) + aInfo.x * 40.0);
        tw = tw * tw * tw * tw * tw * tw;
        float fd = uFogDensity * d * 0.5;
        vK = (0.35 + 1.4 * tw) * exp(-fd * fd);
        vGold = aInfo.y;
        gl_PointSize = clamp((1.6 + 2.0 * tw) * uScale / d, 3.0, 56.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vK; varying float vGold;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float v = exp(-r2 * 14.0) + (exp(-abs(p.x) * 26.0) + exp(-abs(p.y) * 26.0)) * (1.0 - r2) * 0.5;
        vec3 col = mix(vec3(0.85, 0.95, 1.0), vec3(1.0, 0.82, 0.4), vGold);
        gl_FragColor = vec4(col * v * vK * 2.2, 1.0);
      }`,
  });
  const glints = new THREE.Points(gGeo, gMat);
  glints.frustumCulled = false;
  glints.renderOrder = 13;
  glints.layers.set(LAYERS.FX);
  root.add(glints);
  const _bs = new THREE.Vector2();
  glints.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_bs).y;
    gMat.uniforms.uScale.value = h / (2 * Math.tan((R.camera.fov * Math.PI / 180) / 2));
  };

  const last = new Map();       // id → {x, z, kind, seen}
  const flying = [];            // {kind, from: V3, t, dur, spin, seed}
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _to = new THREE.Vector3();
  const _sw = { h: 0, dx: 0, dz: 0 };
  let time = 0;

  const kindOf = (p) => KIND_OF[String(p?.kind || "crate").toLowerCase()] || "crate";
  const seedOf = (id) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 1000; };

  function update(st, dt) {
    time += dt;
    const day = R.atmos?.day || 0;
    glowU.value = 1 - day;
    const counts = { crate: 0, barrel: 0, bottle: 0, chest: 0, flotsam: 0 };
    let ng = 0;
    for (const v of last.values()) v.seen = false;
    for (const p of st?.pickups || []) {
      if (!Number.isFinite(+p.x) || p.taken) continue;
      const k = kindOf(p);
      const m = meshes[k];
      const i = counts[k];
      if (i >= CAP) continue;
      const seed = seedOf(p.id);
      const x = +p.x, z = +p.z;
      const h = water.swellAt(x, z, _sw).h;
      const bob = Math.sin(time * 1.4 + seed * 9) * 0.07;
      const sink = k === "flotsam" ? -0.05 : k === "bottle" ? 0.02 : -0.25;
      _e.set(_sw.dz * 0.6 + Math.sin(time * 0.9 + seed * 7) * 0.1, seed * 6.28 + time * 0.12, -_sw.dx * 0.6 + Math.cos(time * 0.8 + seed * 5) * 0.08);
      const sc = k === "chest" ? 1.1 : k === "flotsam" ? 1 : 1;
      _m.compose(_p.set(x, WATER_Y + h + sink + bob, z), _q.setFromEuler(_e), _s.setScalar(sc));
      m.setMatrixAt(i, _m);
      counts[k]++;
      if (ng < CAP) {
        gPos[ng * 3] = x + Math.sin(seed * 20) * 0.4; gPos[ng * 3 + 1] = WATER_Y + h + 0.6; gPos[ng * 3 + 2] = z + Math.cos(seed * 20) * 0.4;
        gInfo[ng * 2] = seed; gInfo[ng * 2 + 1] = k === "chest" || k === "bottle" ? 1 : 0;
        ng++;
      }
      const rec = last.get(p.id) || {};
      Object.assign(rec, { x, z, y: WATER_Y + h, kind: k, seen: true });
      last.set(p.id, rec);
    }
    for (const [id, v] of last) if (!v.seen && !v.flying) last.delete(id);
    // The Rexmaw's fire barrels afloat astern (state.barrels): bobbing, burning once lit.
    for (const b of st?.barrels || []) {
      if (!Number.isFinite(+b.x) || counts.barrel >= CAP) continue;
      const seed = seedOf(b.id ?? b.x);
      const h = water.swellAt(+b.x, +b.z, _sw).h;
      _e.set(_sw.dz * 0.5, seed * 6.28 + time * 0.3, -_sw.dx * 0.5 + 0.2 * Math.sin(time * 1.1 + seed * 5));
      _m.compose(_p.set(+b.x, WATER_Y + h - 0.15, +b.z), _q.setFromEuler(_e), _s.setScalar(1.15));
      meshes.barrel.setMatrixAt(counts.barrel++, _m);
      if (b.lit !== false && flames) flames.add(_p.set(+b.x, WATER_Y + h + 0.5, +b.z), { size: 1.8, seed: seed * 3.1, smoke: true });
    }
    // In flight to the deck.
    R.shipSpace?.updateMatrixWorld();
    for (let j = flying.length - 1; j >= 0; j--) {
      const f = flying[j];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      R.shipSpace ? R.shipSpace.localToWorld(_to.set(f.toLocal.x, f.toLocal.y, f.toLocal.z)) : _to.set(0, 0, 0);
      const e = k * k * (3 - 2 * k);
      _p.lerpVectors(f.from, _to, e);
      _p.y += Math.sin(k * Math.PI) * (6 + f.from.distanceTo(_to) * 0.18);
      _e.set(f.spin * k * 6, f.spin * k * 9, 0);
      const s = k < 0.85 ? 1 : 1 - (k - 0.85) / 0.15 * 0.9;
      _m.compose(_p, _q.setFromEuler(_e), _s.setScalar(Math.max(0.05, s)));
      const m = meshes[f.kind];
      if (counts[f.kind] < CAP) { m.setMatrixAt(counts[f.kind]++, _m); }
      if (Math.random() < dt * 30) fx.burst?.(_p.clone(), { color: "#ffd27a", count: 3, speed: 0.6, size: 0.14, life: 0.5, intensity: 3, gravity: 0 });
      if (k >= 1) {
        flying.splice(j, 1);
        fx.burst?.(_to.clone(), { color: "#ffd27a", count: 30, speed: 2.6, size: 0.2, life: 0.8, intensity: 3.5 });
        fx.sparks?.(_to.clone(), { color: "#ffe2a0", count: 14, speed: 3 });
      }
    }
    for (const k of KINDS) { meshes[k].count = counts[k]; if (counts[k]) meshes[k].instanceMatrix.needsUpdate = true; }
    gGeo.setDrawRange(0, ng);
    if (ng) { gGeo.attributes.position.needsUpdate = true; gGeo.attributes.aInfo.needsUpdate = true; }
    powerups.update(st, dt);
  }

  /** The core took one: it leaps from the sea onto the deck. */
  function collect(p = {}) {
    const rec = last.get(p.id);
    const x = Number.isFinite(+p.x) ? +p.x : rec?.x, z = Number.isFinite(+p.z) ? +p.z : rec?.z;
    if (!Number.isFinite(x)) return false;
    const from = new THREE.Vector3(x, (rec?.y ?? WATER_Y) + 0.2, z);
    const kind = rec?.kind || kindOf(p);
    flying.push({ kind, from, t: 0, dur: 0.75, spin: Math.random() < 0.5 ? -1 : 1, toLocal: { x: (Math.random() - 0.5) * 2.5, y: 0.8, z: 2 + Math.random() * 4 } });
    fx.splash?.(from.clone().setY(WATER_Y), { scale: 0.7 });
    water.pulse?.({ x, z, color: "#ffd27a", speed: 10, intensity: 0.7 });
    last.delete(p.id);
    return true;
  }

  return {
    root, update, collect, powerups,
    /** v4.2: the run's `powerup` event (spawn ring, the take's burst, a sinking one's splash). */
    powerup: (p) => powerups.event(p),
    get count() { let n = 0; for (const k of KINDS) n += meshes[k].count; return n; },
    warmShow(on) { for (const k of KINDS) meshes[k].count = on ? 1 : 0; gGeo.setDrawRange(0, on ? 1 : 0); powerups.warmShow(on); },
    reset() { last.clear(); flying.length = 0; for (const k of KINDS) meshes[k].count = 0; gGeo.setDrawRange(0, 0); powerups.reset(); },
    dispose() { root.removeFromParent(); for (const g of Object.values(geos)) g.dispose(); mat.dispose(); gGeo.dispose(); gMat.dispose(); powerups.dispose(); },
  };
}
