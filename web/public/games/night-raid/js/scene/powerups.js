// Rexmaw Raids v4.2: the power-ups afloat (state.powerups) — distinct from the loot: a glowing orb in its kind's
// colour bobbing a metre over the swell inside a spinning ring, a badge with the kind's icon over it, a soft halo, a
// shaft of light standing up out of the sea (seen from 400 m), and a pulsing ring of light on the water under it.
// It rises out of the sea when it comes up, blinks through its last 8 s, sinks if nobody takes it; taken
// (`powerup {stage: "pickup"}`) it flashes, flies onto the deck and bursts in its colour with a ring across the sea.
//
// Draws (pooled, CAP each, compiled behind the title): the orbs, the rings (one unlit instanced program), the shafts,
// the water rings (additive), and one Points draw for the halos + the badges (an icon atlas drawn once on a canvas).
// NaN-safe: every number from the state passes Number.isFinite. Driven by pickups.js (update / event / warmShow).

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";

const CAP = 8;
const BEAM_H = 38;
const clamp = THREE.MathUtils.clamp;
/** Each kind's colour (the HUD's chips and the chart use the same). */
export const POWERUP_COLORS = Object.freeze({ swift_wind: "#5fe3ff", quick_hands: "#ff9a3c", hot_shot: "#ff4a2a", iron_hull: "#a8bcff", patch_kit: "#5ee07a",
  powder_keg: "#c486ff", double_doubloons: "#ffd23a", kraken_ink: "#7a66ff", mermaid_kiss: "#ff6fcf" });
const KINDS = Object.keys(POWERUP_COLORS);

/** The icons, drawn white in a 24-unit box (the atlas's cells). */
const ICON = {
  swift_wind: (g) => { g.lineWidth = 2.4; g.lineCap = "round"; g.stroke(new Path2D("M3 9h11a3 3 0 1 0-3-3")); g.stroke(new Path2D("M3 14h15a3 3 0 1 1-3 3")); g.stroke(new Path2D("M3 19h7")); },
  quick_hands: (g) => g.fill(new Path2D("M13.5 2 4.5 13.5h6l-1.5 8.5 9.5-12h-6.2Z")),
  hot_shot: (g) => g.fill(new Path2D("M12 2c1 3.6 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.2 2.6-5.4.2 1.6.9 2.8 2 3.2C10.8 8 11 5 12 2Z")),
  iron_hull: (g) => g.fill(new Path2D("M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5Z")),
  patch_kit: (g) => g.fill(new Path2D("M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5Z")),
  powder_keg: (g) => { g.fill(new Path2D("M7 5h10c1.3 2.2 1.9 4.6 1.9 7.4S18.3 17.8 17 20H7c-1.3-2.2-1.9-4.8-1.9-7.6S5.7 7.2 7 5Z")); g.globalCompositeOperation = "destination-out"; g.fillRect(4, 8.6, 16, 1.5); g.fillRect(4, 14.9, 16, 1.5); g.globalCompositeOperation = "source-over"; },
  double_doubloons: (g) => { g.beginPath(); g.arc(9, 13, 6.2, 0, Math.PI * 2); g.fill(); g.lineWidth = 1.6; g.beginPath(); g.arc(15.5, 10, 6.2, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = "destination-out"; g.beginPath(); g.arc(15.5, 10, 3.6, 0, Math.PI * 2); g.lineWidth = 1.3; g.stroke(); g.globalCompositeOperation = "source-over"; },
  kraken_ink: (g) => { g.fill(new Path2D("M12 2.5S5.5 10 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10 12 2.5 12 2.5Z")); g.globalCompositeOperation = "destination-out"; g.beginPath(); g.arc(9.6, 14.2, 1.7, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = "source-over"; },
  mermaid_kiss: (g) => g.fill(new Path2D("M12 21s-7.6-4.6-9.5-9.4C1 7.9 3.6 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.4 0 6 3.4 4.5 7.1C19.6 16.4 12 21 12 21Z")),
};

function iconAtlas() {
  const cell = 64, n = 3;
  const c = document.createElement("canvas");
  c.width = c.height = cell * n;
  const g = c.getContext("2d");
  KINDS.forEach((k, i) => {
    g.save();
    g.translate((i % n) * cell + cell * 0.18, Math.floor(i / n) * cell + cell * 0.18);
    g.scale(cell * 0.64 / 24, cell * 0.64 / 24);
    g.fillStyle = "#fff"; g.strokeStyle = "#fff";
    try { ICON[k]?.(g); } catch { g.fillRect(6, 6, 12, 12); }
    g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * @param {object} R  the renderer context
 * @param {{water: object, fx: object}} deps
 */
export function createPowerupLayer(R, { water, fx }) {
  const root = new THREE.Group();
  root.name = "powerups";
  R.scene.add(root);
  const wu = water.uniforms;
  const uDay = { value: 0 };

  /** Per-instance colour + fade on a geometry. */
  function instAttrs(geo) {
    const col = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);   // fade, seed
    geo.setAttribute("aColor", col); geo.setAttribute("aFade", fade);
    return { col, fade };
  }

  // ---- The orb and its ring: unlit, a hot core and a rim (bright enough for the bloom) ----
  const glowMat = new THREE.ShaderMaterial({
    name: "RexmawPowerupGlow", fog: false,
    uniforms: { uTime: wu.uTime, uDay },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute vec2 aFade;
      varying vec3 vC; varying float vF; varying vec3 vN; varying vec3 vV; varying float vS;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        vC = aColor; vF = aFade.x; vS = aFade.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uDay;
      varying vec3 vC; varying float vF; varying vec3 vN; varying vec3 vV; varying float vS;
      void main() {
        float fr = 1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float pulse = 0.85 + 0.15 * sin(uTime * 3.2 + vS * 30.0);
        vec3 core = mix(vec3(1.0), vC, 0.35);
        vec3 col = mix(core * 1.6, vC * 2.2, smoothstep(0.15, 0.9, fr)) * pulse * mix(1.25, 1.0, uDay);
        gl_FragColor = vec4(col * clamp(vF, 0.0, 1.0), 1.0);
      }`,
  });
  const orbGeo = new THREE.IcosahedronGeometry(0.85, 3);
  const orbA = instAttrs(orbGeo);
  const orbs = new THREE.InstancedMesh(orbGeo, glowMat, CAP);
  const ringGeo = new THREE.TorusGeometry(1.55, 0.08, 6, 40);
  const ringA = instAttrs(ringGeo);
  const rings = new THREE.InstancedMesh(ringGeo, glowMat, CAP);

  // ---- The shaft of light standing out of the sea ----
  const beamGeo = new THREE.CylinderGeometry(2.2, 0.7, BEAM_H, 16, 1, true).translate(0, BEAM_H / 2, 0);
  const beamA = instAttrs(beamGeo);
  const beamMat = new THREE.ShaderMaterial({
    name: "RexmawPowerupBeam", transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uDay },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute vec2 aFade;
      varying vec3 vC; varying float vF; varying float vH; varying vec3 vN; varying vec3 vW; varying float vS;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vH = clamp(position.y / ${BEAM_H.toFixed(1)}, 0.0, 1.0);
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vW = w.xyz; vC = aColor; vF = aFade.x; vS = aFade.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uDay;
      varying vec3 vC; varying float vF; varying float vH; varying vec3 vN; varying vec3 vW; varying float vS;
      void main() {
        vec3 v = normalize(cameraPosition - vW);
        float side = pow(clamp(abs(dot(normalize(vN), v)), 0.0, 1.0), 1.6);
        float up = pow(1.0 - vH, 1.8) * smoothstep(0.0, 0.04, vH);
        float shimmer = 0.75 + 0.25 * sin(vH * 22.0 - uTime * 4.0 + vS * 20.0);
        float d = length(cameraPosition - vW);
        float fd = uFogDensity * d * 0.4;
        float near = smoothstep(6.0, 30.0, d);
        float k = side * up * shimmer * near * exp(-fd * fd) * mix(0.75, 0.42, uDay) * clamp(vF, 0.0, 1.0);
        gl_FragColor = vec4(vC * k, 1.0);
      }`,
  });
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, CAP);

  // ---- The ring of light on the water ----
  const padGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const padA = instAttrs(padGeo);
  const padMat = new THREE.ShaderMaterial({
    name: "RexmawPowerupPad", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uDay },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute vec2 aFade;
      varying vec2 vP; varying vec3 vC; varying float vF; varying float vS; varying float vD;
      void main() {
        vP = position.xz; vC = aColor; vF = aFade.x; vS = aFade.y;
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uDay;
      varying vec2 vP; varying vec3 vC; varying float vF; varying float vS; varying float vD;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float w = fract(uTime * 0.45 + vS);
        float ring = exp(-pow((r - w) * 9.0, 2.0)) * (1.0 - w);
        float glow = exp(-r * r * 5.0) * 0.55;
        float edge = 1.0 - smoothstep(0.8, 1.0, r);
        float fd = uFogDensity * vD * 0.45;
        gl_FragColor = vec4(vC * (ring + glow) * edge * exp(-fd * fd) * mix(1.0, 0.6, uDay) * clamp(vF, 0.0, 1.0), 1.0);
      }`,
  });
  const pads = new THREE.InstancedMesh(padGeo, padMat, CAP);

  for (const m of [orbs, rings, beams, pads]) {
    m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(m);
  }
  orbs.name = "powerup-orbs"; rings.name = "powerup-rings";
  beams.name = "powerup-beams"; beams.renderOrder = 11; beams.layers.set(LAYERS.FX);
  pads.name = "powerup-pads"; pads.renderOrder = 4; pads.layers.set(LAYERS.NOREFLECT);

  // ---- Halos + badges: one Points draw ----
  const NP = CAP * 2;
  const pPos = new Float32Array(NP * 3), pCol = new Float32Array(NP * 3), pInfo = new Float32Array(NP * 4);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute("aColor", new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute("aInfo", new THREE.BufferAttribute(pInfo, 4).setUsage(THREE.DynamicDrawUsage));   // cell, mode (0 halo, 1 badge), fade, seed
  pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  pGeo.setDrawRange(0, 0);
  const atlas = iconAtlas();
  const pMat = new THREE.ShaderMaterial({
    name: "RexmawPowerupBadges", transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uScale: { value: 800 }, uAtlas: { value: atlas }, uDay },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute vec4 aInfo;
      uniform float uScale, uFogDensity;
      varying vec3 vC; varying vec4 vI; varying float vFog;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 1.0);
        vC = aColor; vI = aInfo;
        float fd = uFogDensity * d * 0.3;
        vFog = mix(0.55, 1.0, exp(-fd * fd));
        gl_PointSize = aInfo.y > 0.5 ? clamp(2.8 * uScale / d, 24.0, 46.0) * aInfo.z : clamp(7.0 * uScale / d, 10.0, 120.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas; uniform float uTime, uDay;
      varying vec3 vC; varying vec4 vI; varying float vFog;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float fade = clamp(vI.z, 0.0, 1.0);
        if (vI.y < 0.5) {
          float a = exp(-r * r * 4.0) * (0.55 + 0.1 * sin(uTime * 3.0 + vI.w * 20.0)) * mix(0.9, 0.55, uDay);
          gl_FragColor = vec4(vC * 1.4, a * fade * vFog);
          return;
        }
        // The badge: a disc in the kind's colour, a pale rim, the icon in white.
        float cell = vI.x;
        vec2 uv = vec2((mod(cell, 3.0) + gl_PointCoord.x) / 3.0, 1.0 - (floor(cell / 3.0) + gl_PointCoord.y) / 3.0);
        float icon = texture2D(uAtlas, uv).a;
        float disc = 1.0 - smoothstep(0.86, 0.94, r);
        float rim = smoothstep(0.74, 0.8, r) * (1.0 - smoothstep(0.88, 0.94, r));
        vec3 col = mix(vC * 0.55, vec3(1.0), clamp(icon + rim * 0.8, 0.0, 1.0));
        gl_FragColor = vec4(col, disc * 0.95 * fade * vFog);
      }`,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.name = "powerup-badges";
  points.frustumCulled = false;
  points.renderOrder = 14;
  root.add(points);
  const _bs = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_bs).y;
    pMat.uniforms.uScale.value = h / (2 * Math.tan((R.camera.fov * Math.PI / 180) / 2));
  };

  // ---- State ----
  const recs = new Map();   // id → {id, kind, x, z, y, born, seed, gone: null | {mode: "take"|"sink", t}, seen}
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _to = new THREE.Vector3();
  const _sw = { h: 0, dx: 0, dz: 0 };
  const _c = new THREE.Color();
  let time = 0;
  const fin = (v) => Number.isFinite(+v);
  const seedOf = (id) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 1000; };

  function update(st, dt) {
    const d = clamp(+dt || 0, 0, 0.1);
    time += d;
    uDay.value = R.atmos?.day || 0;
    for (const r of recs.values()) r.seen = false;
    for (const p of Array.isArray(st?.powerups) ? st.powerups : []) {
      if (!p || !fin(p.x) || !fin(p.z) || !POWERUP_COLORS[p.kind]) continue;
      let r = recs.get(p.id);
      if (!r) { r = { id: p.id, kind: p.kind, born: time, seed: seedOf(p.id), gone: null }; recs.set(p.id, r); }
      if (r.gone) continue;
      r.x = +p.x; r.z = +p.z; r.left = fin(p.left) ? +p.left : 60; r.seen = true;
    }
    R.shipSpace?.updateMatrixWorld();
    let n = 0, np = 0;
    for (const r of [...recs.values()]) {
      if (!r.seen && !r.gone) r.gone = { mode: "sink", t: 0 };
      if (r.gone) { r.gone.t += d; if (r.gone.t > (r.gone.mode === "take" ? 0.8 : 1.0)) { recs.delete(r.id); continue; } }
      if (n >= CAP) continue;
      const age = time - r.born;
      const h = water.swellAt(r.x, r.z, _sw).h;
      const rise = clamp(age / 0.9, 0, 1);
      let fade = rise * rise * (3 - 2 * rise), sc = 0.2 + 0.8 * fade;
      // The last 8 s afloat: it blinks, quicker as it goes.
      if (!r.gone && r.left < 8) fade *= 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(time * (6 + (8 - r.left) * 1.5)));
      let x = r.x, z = r.z;
      const baseY = WATER_Y + h + 1.1 + Math.sin(time * 1.6 + r.seed * 9) * 0.22;
      let y = baseY - (1 - rise) * 1.6;
      if (r.gone?.mode === "sink") { const k = clamp(r.gone.t / 1.0, 0, 1); fade *= 1 - k; y -= k * 2; sc *= 1 - 0.6 * k; }
      if (r.gone?.mode === "take") {
        // Up, a swelling flash, then onto the deck.
        const k = clamp(r.gone.t / 0.8, 0, 1), e = k * k * (3 - 2 * k);
        R.shipSpace ? R.shipSpace.localToWorld(_to.set(0, 1.5, 4)) : _to.set(x, y, z);
        x += (_to.x - x) * e; z += (_to.z - z) * e;
        y = baseY + (_to.y - baseY) * e + Math.sin(k * Math.PI) * 7;
        sc = (1 + Math.sin(Math.min(1, k * 2.5) * Math.PI) * 1.4) * (1 - 0.8 * k);
        fade = 1 - 0.6 * k;
        if (Math.random() < d * 40) fx?.burst?.(new THREE.Vector3(x, y, z), { color: POWERUP_COLORS[r.kind], count: 3, speed: 0.8, size: 0.16, life: 0.45, intensity: 3, gravity: 0 });
      }
      r.y = y;
      _c.set(POWERUP_COLORS[r.kind]);
      const setAttrs = (A) => { A.col.setXYZ(n, _c.r, _c.g, _c.b); A.fade.setXY(n, fade, r.seed); };
      // Orb.
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, time * 0.8 + r.seed * 6, 0)), _s.setScalar(sc));
      orbs.setMatrixAt(n, _m); setAttrs(orbA);
      // Ring: tilted, spinning.
      _e.set(Math.PI / 2 + Math.sin(time * 0.9 + r.seed * 5) * 0.35, time * 1.7 + r.seed * 6, Math.cos(time * 0.7 + r.seed * 3) * 0.3);
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.setScalar(sc));
      rings.setMatrixAt(n, _m); setAttrs(ringA);
      // Shaft and pad (they stay on the water; gone with the orb).
      const groundFade = r.gone ? fade * (1 - clamp(r.gone.t / 0.4, 0, 1)) : fade;
      _m.compose(_p.set(r.x, WATER_Y + h - 0.3, r.z), _q.identity(), _s.set(1, 0.3 + 0.7 * fade, 1));
      beams.setMatrixAt(n, _m); beamA.col.setXYZ(n, _c.r, _c.g, _c.b); beamA.fade.setXY(n, groundFade, r.seed);
      _m.compose(_p.set(r.x, WATER_Y + h + 0.06, r.z), _q.identity(), _s.setScalar(5.5));
      pads.setMatrixAt(n, _m); padA.col.setXYZ(n, _c.r, _c.g, _c.b); padA.fade.setXY(n, groundFade, r.seed);
      // Halo round the orb; the badge 2.6 m over it.
      if (np + 2 <= NP) {
        const cell = KINDS.indexOf(r.kind);
        pPos.set([x, y, z], np * 3); pCol.set([_c.r, _c.g, _c.b], np * 3); pInfo.set([cell, 0, fade, r.seed], np * 4); np++;
        pPos.set([x, y + 2.6 * Math.max(0.3, sc), z], np * 3); pCol.set([_c.r, _c.g, _c.b], np * 3); pInfo.set([cell, 1, r.gone ? fade * 0.6 : fade, r.seed], np * 4); np++;
      }
      n++;
    }
    for (const [m, A] of [[orbs, orbA], [rings, ringA], [beams, beamA], [pads, padA]]) {
      m.count = n;
      if (n) { m.instanceMatrix.needsUpdate = true; A.col.needsUpdate = true; A.fade.needsUpdate = true; }
    }
    pGeo.setDrawRange(0, np);
    if (np) for (const k of ["position", "aColor", "aInfo"]) pGeo.attributes[k].needsUpdate = true;
  }

  /** The run's `powerup` event: a ring when one comes up; the take's flash + burst; a splash when one sinks. */
  function event(p = {}) {
    const st = String(p.stage || "");
    const col = POWERUP_COLORS[p.kind] || "#ffffff";
    if (st === "spawn" && fin(p.x) && fin(p.z)) water.pulse?.({ x: +p.x, z: +p.z, color: col, speed: 9, intensity: 0.45 });
    else if (st === "pickup") {
      const r = recs.get(p.id);
      const x = fin(p.x) ? +p.x : r?.x, z = fin(p.z) ? +p.z : r?.z;
      if (r) r.gone = { mode: "take", t: 0 };
      if (!fin(x) || !fin(z)) return;
      const y = r?.y ?? WATER_Y + 1.2;
      fx?.burst?.(new THREE.Vector3(x, y, z), { color: col, count: 46, speed: 3.4, size: 0.3, life: 0.9, intensity: 4.5, gravity: 0.2 });
      fx?.sparks?.(new THREE.Vector3(x, y, z), { color: "#ffffff", count: 18, speed: 4 });
      fx?.splash?.(new THREE.Vector3(x, WATER_Y, z), { scale: 0.7 });
      water.pulse?.({ x, z, color: col, speed: 14, intensity: 0.6 });
      // The burst on the deck as it lands.
      setTimeout(() => {
        if (!R.shipSpace) return;
        const at = R.shipSpace.localToWorld(new THREE.Vector3(0, 1.5, 4));
        fx?.burst?.(at, { color: col, count: 36, speed: 2.6, size: 0.24, life: 0.8, intensity: 4 });
      }, 750);
    } else if (st === "expire" && p.afloat) {
      const r = recs.get(p.id);
      if (r && !r.gone) r.gone = { mode: "sink", t: 0 };
      if (r) fx?.splash?.(new THREE.Vector3(r.x, WATER_Y, r.z), { scale: 0.5 });
    }
  }

  function warmShow(on) {
    if (on) {
      _m.identity();
      for (const [m, A] of [[orbs, orbA], [rings, ringA], [beams, beamA], [pads, padA]]) { m.setMatrixAt(0, _m); A.col.setXYZ(0, 1, 1, 1); A.fade.setXY(0, 1, 0); m.count = 1; m.instanceMatrix.needsUpdate = true; }
      pPos.set([0, 0, 0, 0, 3, 0], 0); pInfo.set([0, 0, 1, 0, 0, 1, 1, 0], 0);
      pGeo.setDrawRange(0, 2);
    } else {
      for (const m of [orbs, rings, beams, pads]) m.count = 0;
      pGeo.setDrawRange(0, 0);
    }
  }

  return {
    root, update, event, warmShow,
    get count() { return orbs.count; },
    reset() { recs.clear(); warmShow(false); },
    dispose() {
      root.removeFromParent();
      for (const g of [orbGeo, ringGeo, beamGeo, padGeo, pGeo]) g.dispose();
      for (const m of [glowMat, beamMat, padMat, pMat]) m.dispose();
      atlas.dispose();
    },
  };
}
