// Rexmaw Raids: what the Captain aims with and what the companion marks, drawn on the sea.
//
//   arcs      the broadside's 6–8 ballistic arcs, white, turning red where a ball would hit a
//             ship (the core's gunnery.aimPreview; or worked out here from the look when the
//             core sends only the weapon); the chain shot's cone from the bow; dashed, flowing
//             toward the target. One ribbon draw (camera-facing strips).
//   decals    one instanced draw of shapes laid ON the swell (the vertex shader rides the same
//             three swell trains water.js draws): landing rings at the arcs' ends, the fire
//             barrels' drop marks astern, the mortar's target circle (a ring and a cross) and the
//             shrinking circles of shells in flight (ours and theirs), the companion's danger
//             areas (a faint red glow outline, breathing, fading out over their last 10 s), the
//             heading she calls (gold chevrons running out along the bearing) and the waypoint.
//   markers   hit markers: a quick white cross-flash where our shot strikes (one billboard draw).
//
// Everything is pooled at fixed capacities and compiled behind the title. All fog- and NaN-safe.

import * as THREE from "three";
import { B, LAYERS, WATER_Y, headingVec } from "./blocking.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const ARCS = 10, PTS = 28;
const DECALS = 64;
const MARKS = 24;
const KIND = { ring: 0, target: 1, telegraph: 2, danger: 3, chevron: 4, drop: 5, waypoint: 6 };
const WHITE = new THREE.Color(1, 1, 1), RED = new THREE.Color(1.0, 0.22, 0.14), GOLD = new THREE.Color(1.0, 0.78, 0.32), FIRE = new THREE.Color(1.0, 0.5, 0.15);
const G = 9.81;
const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  NORTH: 0, NORTHEAST: 45, EAST: 90, SOUTHEAST: 135, SOUTH: 180, SOUTHWEST: 225, WEST: 270, NORTHWEST: 315 };
/** A called heading in degrees from {deg|heading|bearing} (a number or a compass word), or null. */
function headingDeg(hc) {
  if (hc == null) return null;
  if (Number.isFinite(+hc)) return +hc;
  for (const v of [hc.deg, hc.heading, hc.bearing, hc.dirDeg]) {
    if (v == null) continue;
    if (Number.isFinite(+v)) return +v;
    const w = String(v).toUpperCase().replace(/[^A-Z]/g, "");
    if (w in COMPASS) return COMPASS[w];
  }
  return null;
}

/** The swell, as water.js computes it (uSwellA: dir.xz, k, ω; uSwellB: amplitude, phase). */
const SWELL_GLSL = /* glsl */`
  uniform vec4 uSwellA[3]; uniform vec4 uSwellB[3]; uniform float uTime;
  float rrSwell(vec2 xz) {
    float h = 0.0;
    for (int i = 0; i < 3; i++) h += uSwellB[i].x * sin(uSwellA[i].z * dot(uSwellA[i].xy, xz) - uSwellA[i].w * uTime + uSwellB[i].y);
    return h;
  }`;

/**
 * @param {object} R
 * @param {{water: object, fleet: object, fx: object}} deps
 */
export function createOverlays(R, { water, fleet, fx }) {
  const root = new THREE.Group();
  root.name = "overlays";
  R.scene.add(root);
  const wu = water.uniforms;

  // ---- Arcs: camera-facing ribbons ----
  const nV = ARCS * PTS * 2;
  const aPos = new Float32Array(nV * 3), aDir = new Float32Array(nV * 3), aInfo = new Float32Array(nV * 4);
  const arcIdx = [];
  for (let a = 0; a < ARCS; a++) for (let i = 0; i < PTS - 1; i++) {
    const b = (a * PTS + i) * 2;
    arcIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute("position", new THREE.BufferAttribute(aPos, 3).setUsage(THREE.DynamicDrawUsage));
  arcGeo.setAttribute("aDir", new THREE.BufferAttribute(aDir, 3).setUsage(THREE.DynamicDrawUsage));
  arcGeo.setAttribute("aInfo", new THREE.BufferAttribute(aInfo, 4).setUsage(THREE.DynamicDrawUsage));   // side ±1, along 0..1, hit 0..1, width m
  arcGeo.setIndex(arcIdx);
  arcGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  arcGeo.setDrawRange(0, 0);
  const arcMat = new THREE.ShaderMaterial({
    name: "RexmawAimArcs", transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, fog: false,
    uniforms: { uTime: wu.uTime, uAlpha: { value: 1 }, uDay: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aDir; attribute vec4 aInfo;
      varying vec4 vInfo; varying float vDist;
      void main() {
        vInfo = aInfo;
        vec3 view = normalize(cameraPosition - position);
        vec3 d = aDir;
        if (dot(d, d) < 1e-8) d = vec3(0.0, 0.0, 1.0);
        vec3 side = cross(normalize(d), view);
        if (dot(side, side) < 1e-8) side = vec3(1.0, 0.0, 0.0);
        float dist = length(cameraPosition - position);
        float w = aInfo.w * (1.0 + dist * 0.004);
        vec3 p = position + normalize(side) * aInfo.x * w * 0.5;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAlpha, uDay;
      varying vec4 vInfo; varying float vDist;
      void main() {
        float along = clamp(vInfo.y, 0.0, 1.0);
        float edge = 1.0 - abs(vInfo.x);
        float dash = 0.55 + 0.45 * smoothstep(0.35, 0.6, fract(along * 14.0 - uTime * 1.6));
        float a = smoothstep(0.0, 0.08, along) * (1.0 - smoothstep(0.9, 1.0, along)) * smoothstep(0.0, 0.5, edge) * dash;
        vec3 col = mix(vec3(1.0, 0.98, 0.92), vec3(1.0, 0.22, 0.12), clamp(vInfo.z, 0.0, 1.0));
        // Bright enough to read in daylight and bloom a touch at night.
        col *= mix(1.6, 1.15, uDay);
        if (a * uAlpha < 0.004) discard;
        gl_FragColor = vec4(col, a * uAlpha * 0.85);
      }`,
  });
  const arcs = new THREE.Mesh(arcGeo, arcMat);
  arcs.name = "aim-arcs";
  arcs.frustumCulled = false;
  arcs.renderOrder = 14;
  arcs.layers.set(LAYERS.NOREFLECT);
  root.add(arcs);

  // ---- Decals on the swell (two instanced meshes: on the sea, depth-tested; and the mortar's rings on top,
  // lifted onto the land they fall on — a tower's ring would hide under the island otherwise) ----
  const decGeo = new THREE.PlaneGeometry(2, 2, 18, 18);
  decGeo.rotateX(-Math.PI / 2);
  const decGeoTop = decGeo.clone();
  const attrs = (g) => {
    const a = {
      d0: new THREE.InstancedBufferAttribute(new Float32Array(DECALS * 4), 4).setUsage(THREE.DynamicDrawUsage),   // x, z, r, kind
      d1: new THREE.InstancedBufferAttribute(new Float32Array(DECALS * 4), 4).setUsage(THREE.DynamicDrawUsage),   // r, g, b, alpha
      d2: new THREE.InstancedBufferAttribute(new Float32Array(DECALS * 4), 4).setUsage(THREE.DynamicDrawUsage),   // progress, rot, seed, ground lift
    };
    g.setAttribute("aD0", a.d0); g.setAttribute("aD1", a.d1); g.setAttribute("aD2", a.d2);
    return a;
  };
  const SEA = attrs(decGeo), TOP = attrs(decGeoTop);
  const decU = { uTime: wu.uTime, uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uFogDensity: wu.uFogDensity, uDay: { value: 0 } };
  const decMat = new THREE.ShaderMaterial({
    name: "RexmawSeaDecals", transparent: true, depthWrite: false, fog: false, blending: THREE.NormalBlending,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    uniforms: decU,
    vertexShader: /* glsl */`
      ${SWELL_GLSL}
      attribute vec4 aD0, aD1, aD2;
      varying vec2 vP; varying vec4 vC; varying vec4 vX; varying float vKind; varying float vDist; varying float vR;
      void main() {
        vP = position.xz; vC = aD1; vX = aD2; vKind = aD0.w; vR = aD0.z;
        float c = cos(aD2.y), s = sin(aD2.y);
        vec2 q = vec2(c * position.x - s * position.z, s * position.x + c * position.z) * aD0.z;
        vec2 xz = aD0.xy + q;
        float y = max(${WATER_Y.toFixed(2)} + rrSwell(xz), ${WATER_Y.toFixed(2)} + aD2.w) + 0.14;
        vec3 wp = vec3(xz.x, y, xz.y);
        // The mortar's rings, seen at a grazing angle from far off, tilt up toward the lens so they still read.
        if (aD0.w > 0.5 && aD0.w < 2.5) {
          vec3 cen = vec3(aD0.x, ${WATER_Y.toFixed(2)} + max(aD2.w, 0.0) + 0.3, aD0.y);
          vec3 toC = cen - cameraPosition;
          float hd = max(length(toC.xz), 1e-3);
          vec3 fwd = vec3(toC.x / hd, 0.0, toC.z / hd), right = vec3(-fwd.z, 0.0, fwd.x);
          float e = atan(-toC.y, hd);
          float tilt = clamp((0.55 - e) / 0.55, 0.0, 1.0) * 0.9;
          vec3 ax = normalize(fwd * cos(tilt) + vec3(0.0, sin(tilt), 0.0));
          wp = cen + right * position.x * aD0.z - ax * position.z * aD0.z;
        }
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uDay;
      varying vec2 vP; varying vec4 vC; varying vec4 vX; varying float vKind; varying float vDist; varying float vR;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float ring(float r, float at, float w) { float q = (r - at) / max(w, 1e-3); return exp(-q * q); }
      void main() {
        float r = length(vP);
        float px = 1.0 / max(vR, 0.5);               // one metre in decal units
        float a = 0.0;
        float k = vKind;
        if (k < 0.5) {                               // landing ring
          a = ring(r, 0.8, 0.12) + 0.25 * (1.0 - smoothstep(0.0, 0.8, r));
        } else if (k < 1.5) {                        // mortar target: ring, inner ring, a cross
          float cr = (1.0 - smoothstep(0.0, 0.03, abs(vP.x))) + (1.0 - smoothstep(0.0, 0.03, abs(vP.y)));
          cr *= step(r, 0.7) * step(0.15, r);
          a = ring(r, 0.92, max(0.04, px * 0.6)) + 0.6 * ring(r, 0.5, max(0.025, px * 0.4)) + cr * 0.7 + 0.12 * (1.0 - smoothstep(0.0, 0.95, r));
          a *= 0.75 + 0.25 * sin(uTime * 6.0);
        } else if (k < 2.5) {                        // a shell's telegraph: the outer ring, an inner one closing on it
          float p = clamp(vX.x, 0.0, 1.0);
          a = 0.7 * ring(r, 0.95, max(0.03, px * 0.5)) + ring(r, 0.95 * (1.0 - p), max(0.035, px * 0.6)) + 0.18 * p * (1.0 - smoothstep(0.0, 0.95, r));
        } else if (k < 3.5) {                        // danger area: a breathing red glow at the rim, a faint fill
          float wob = (n2(vP * 3.0 + vX.z * 7.0 + uTime * 0.15) - 0.5) * 0.08;
          float rr = r + wob;
          a = ring(rr, 0.88, 0.07) * (0.75 + 0.25 * sin(uTime * 2.2 + vX.z * 5.0)) + 0.18 * (1.0 - smoothstep(0.6, 0.9, rr));
          a *= 1.0 - smoothstep(0.98, 1.0, r);
        } else if (k < 4.5) {                        // chevron pointing +z (rotated by aD2.y)
          vec2 p = vP;
          float v = abs(p.y - (0.4 - abs(p.x) * 0.9) * 1.0);
          a = (1.0 - smoothstep(0.08, 0.16, v)) * step(abs(p.x), 0.75) * step(-0.5, p.y);
          a *= 0.55 + 0.45 * smoothstep(0.0, 1.0, fract(-uTime * 1.2 + vX.z));
        } else if (k < 5.5) {                        // fire barrel drop mark
          a = ring(r, 0.75, 0.14) + 0.3 * (1.0 - smoothstep(0.0, 0.7, r));
          a *= 0.7 + 0.3 * sin(uTime * 8.0 + vX.z * 6.0);
        } else {                                     // waypoint: two rings, a soft beacon fill
          a = ring(r, 0.9, 0.06) + 0.6 * ring(r, 0.6 + 0.3 * fract(uTime * 0.5), 0.07) + 0.1 * (1.0 - smoothstep(0.0, 0.9, r));
        }
        a *= vC.a * step(r, 1.0);
        float fd = uFogDensity * vDist * 0.55;
        a *= exp(-fd * fd);
        if (a < 0.004) discard;
        vec3 col = vC.rgb * mix(1.5, 1.0, uDay);
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }`,
  });
  const decals = new THREE.InstancedMesh(decGeo, decMat, DECALS);
  decals.name = "sea-decals";
  decals.count = 0;
  decals.frustumCulled = false;
  decals.renderOrder = 10;   // after life.js's fog-bank billboards (9): the companion's marks must read inside a bank
  decals.layers.set(LAYERS.NOREFLECT);
  root.add(decals);
  const decMatTop = decMat.clone();
  decMatTop.uniforms = decU;
  decMatTop.depthTest = false;
  decMatTop.name = "RexmawSeaDecalsTop";
  const decalsTop = new THREE.InstancedMesh(decGeoTop, decMatTop, DECALS);
  decalsTop.name = "sea-decals-top";
  decalsTop.count = 0;
  decalsTop.frustumCulled = false;
  decalsTop.renderOrder = 15;
  decalsTop.layers.set(LAYERS.NOREFLECT);
  root.add(decalsTop);
  let groundAt = null;        // islands.heightAt: the land's height above the sea at (x, z)

  // ---- Hit markers ----
  const quad = new THREE.PlaneGeometry(1, 1);
  const mkGeo = new THREE.InstancedBufferGeometry();
  mkGeo.index = quad.index;
  mkGeo.setAttribute("position", quad.attributes.position);
  mkGeo.setAttribute("uv", quad.attributes.uv);
  const mkAt = new THREE.InstancedBufferAttribute(new Float32Array(MARKS * 4), 4).setUsage(THREE.DynamicDrawUsage);   // x, y, z, t0
  const mkInfo = new THREE.InstancedBufferAttribute(new Float32Array(MARKS * 2), 2).setUsage(THREE.DynamicDrawUsage);  // size, heavy
  mkGeo.setAttribute("aAt", mkAt); mkGeo.setAttribute("aInfo", mkInfo);
  mkGeo.instanceCount = MARKS;
  const mkMat = new THREE.ShaderMaterial({
    name: "RexmawHitMarkers", transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: wu.uTime },
    vertexShader: /* glsl */`
      attribute vec4 aAt; attribute vec2 aInfo;
      uniform float uTime;
      varying vec2 vUv; varying float vK; varying float vHeavy;
      void main() {
        vUv = uv;
        float t = uTime - aAt.w;
        vK = (t >= 0.0 && t < 0.45) ? 1.0 - t / 0.45 : 0.0;
        vHeavy = aInfo.y;
        vec4 mv = modelViewMatrix * vec4(aAt.xyz, 1.0);
        float d = max(-mv.z, 1.0);
        float s = d * 0.045 * aInfo.x * (1.25 - 0.25 * vK);
        mv.xy += position.xy * s * step(0.001, vK);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying float vK; varying float vHeavy;
      void main() {
        if (vK <= 0.0) discard;
        vec2 p = (vUv * 2.0 - 1.0);
        vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.7071;
        float arms = (1.0 - smoothstep(0.05, 0.11, abs(q.x))) * smoothstep(0.25, 0.4, abs(q.y)) * (1.0 - smoothstep(0.85, 1.0, abs(q.y)))
                   + (1.0 - smoothstep(0.05, 0.11, abs(q.y))) * smoothstep(0.25, 0.4, abs(q.x)) * (1.0 - smoothstep(0.85, 1.0, abs(q.x)));
        vec3 col = mix(vec3(1.0, 0.97, 0.9), vec3(1.0, 0.55, 0.25), vHeavy);
        gl_FragColor = vec4(col * arms * vK * 2.4, 1.0);
      }`,
  });
  const markers = new THREE.Mesh(mkGeo, mkMat);
  markers.name = "hit-markers";
  markers.frustumCulled = false;
  markers.renderOrder = 22;
  markers.layers.set(LAYERS.NOREFLECT);
  root.add(markers);
  for (let i = 0; i < MARKS; i++) mkAt.setXYZW(i, 0, -999, 0, -99);
  let mkSlot = 0;

  // ---- State ----
  const O = { aimPoint: null, preview: null, dangers: new Map(), heading: null, hold: 0, lastAim: 0, alpha: 0 };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _m = new THREE.Matrix4();
  const tmpPts = Array.from({ length: PTS }, () => new THREE.Vector3());

  // A world point on the Rexmaw (ship space → world).
  const shipToWorld = (x, y, z, out) => { R.shipSpace.updateMatrixWorld(); return R.shipSpace.localToWorld(out.set(x, y, z)); };

  /** Is (x, z) on a ship's hull (an ellipse, a little generous)? → the contact id or null. */
  function shipAt(x, z, pad = 1.5) {
    let hit = null;
    fleet?.each?.((id, sh) => {
      if (hit) return;
      const c = sh.K.c;
      const [fx, fz] = headingVec(sh.heading);
      const dx = x - sh.x, dz = z - sh.z;
      const along = dx * fx + dz * fz, across = dx * -fz + dz * fx;
      const a = c.L * 0.5 + pad, b = c.B + pad;
      if ((along * along) / (a * a) + (across * across) / (b * b) <= 1) hit = id;
    });
    return hit;
  }

  /** A ballistic arc from `from` with velocity `vel` until the sea: fills tmpPts, returns {n, land, hit}. */
  function integrate(from, vel, g = G, hitTest = true) {
    // Time to the water: solve y0 + vy t − g t²/2 = WATER_Y.
    const y0 = from.y - WATER_Y, vy = vel.y;
    const disc = vy * vy + 2 * g * Math.max(0, y0);
    const T = Math.max(0.05, (vy + Math.sqrt(Math.max(0, disc))) / g);
    let hit = null, n = PTS;
    for (let i = 0; i < PTS; i++) {
      const t = (i / (PTS - 1)) * T;
      tmpPts[i].set(from.x + vel.x * t, from.y + vel.y * t - 0.5 * g * t * t, from.z + vel.z * t);
      if (hitTest && !hit && i > 1) {
        const p = tmpPts[i];
        const id = shipAt(p.x, p.z, 0.5);
        if (id && p.y < WATER_Y + 14) { hit = id; n = i + 1; break; }
      }
    }
    return { n, land: tmpPts[n - 1], hit };
  }

  let nArc = 0, nDec = 0, nTop = 0;
  function pushArc(points, n, hit, width = 0.5) {
    if (nArc >= ARCS || n < 2) return;
    const base = nArc * PTS * 2;
    for (let i = 0; i < PTS; i++) {
      const p = points[Math.min(i, n - 1)];
      const q = points[Math.min(i + 1, n - 1)], o = points[Math.max(i - 1, 0)];
      const dx = q.x - o.x, dy = q.y - o.y, dz = q.z - o.z;
      const along = i / (PTS - 1);
      for (let s = 0; s < 2; s++) {
        const k = (base + i * 2 + s);
        aPos[k * 3] = p.x; aPos[k * 3 + 1] = p.y; aPos[k * 3 + 2] = p.z;
        aDir[k * 3] = dx; aDir[k * 3 + 1] = dy; aDir[k * 3 + 2] = dz;
        aInfo[k * 4] = s ? 1 : -1; aInfo[k * 4 + 1] = along; aInfo[k * 4 + 2] = hit ? 1 : 0; aInfo[k * 4 + 3] = width;
      }
    }
    nArc++;
  }
  function pushDecal(x, z, r, kind, color, alpha = 1, progress = 0, rot = 0, seed = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) return;
    // The mortar's target and its shells' rings go on top (lifted onto land when they fall on it).
    const top = kind === KIND.target || kind === KIND.telegraph;
    const A = top ? TOP : SEA;
    const i = top ? nTop : nDec;
    if (i >= DECALS) return;
    const lift = top && groundAt ? Math.max(0, +groundAt(x, z) || 0) : 0;
    A.d0.setXYZW(i, x, z, r, kind);
    A.d1.setXYZW(i, color.r, color.g, color.b, alpha);
    A.d2.setXYZW(i, progress, rot, seed, lift);
    if (top) nTop++; else nDec++;
  }

  /** The preview the scene works out itself from the look (when the core sends only the weapon). */
  function localPreview(weapon, side, aim01, ship) {
    const out = { weapon, side, arcs: [] };
    if (weapon === "broadside" || weapon === "heavy") {
      const s = side === "starboard" ? -1 : 1;
      const muzzles = B.GUNS[side === "starboard" ? "starboard" : "port"];
      const elev = (weapon === "heavy" ? 0.5 : 0.8 + 8.2 * clamp(aim01, 0, 1)) * DEG;
      const speed = 128;
      const pick = muzzles.length > 7 ? muzzles.filter((_, i) => i % 1 === 0).slice(0, 8) : muzzles;
      pick.forEach((m, i) => {
        const from = shipToWorld(m[0] + 0.4 * s, m[1], m[2], new THREE.Vector3());
        const yawSpread = (i - (pick.length - 1) / 2) * 0.7 * DEG;
        const outDir = shipToWorld(s * Math.cos(yawSpread), 0, Math.sin(yawSpread) * s, new THREE.Vector3()).sub(shipToWorld(0, 0, 0, _u));
        outDir.y = 0; outDir.normalize();
        const vel = outDir.multiplyScalar(Math.cos(elev) * speed);
        vel.y = Math.sin(elev) * speed;
        // The ship's own way adds to the ball's.
        if (ship) { const [hx, hz] = headingVec(+ship.heading || 0); vel.x += hx * (+ship.speed || 0); vel.z += hz * (+ship.speed || 0); }
        out.arcs.push({ from: { x: from.x, y: from.y, z: from.z }, v: { x: vel.x, y: vel.y, z: vel.z } });
      });
    } else if (weapon === "chain") {
      const bow = shipToWorld(0, 2.3, 19.6, new THREE.Vector3());
      const fwd = shipToWorld(0, 0, 1, new THREE.Vector3()).sub(shipToWorld(0, 0, 0, _u)).setY(0).normalize();
      const range = 120 + 160 * clamp(aim01, 0, 1);
      out.line = { from: { x: bow.x, z: bow.z }, dir: { x: fwd.x, z: fwd.z }, range, spread: 6 };
    } else if (weapon === "barrels") {
      out.drops = [10, 17, 24].map((d, i) => { const p = shipToWorld((i - 1) * 2.4, 0, -13 - d, new THREE.Vector3()); return { x: p.x, z: p.z }; });
    }
    return out;
  }

  function update(st, dt, { look = null } = {}) {
    nArc = 0; nDec = 0; nTop = 0;
    const day = R.atmos?.day || 0;
    arcMat.uniforms.uDay.value = day;
    decU.uDay.value = day;
    const sh = st?.ship || null;
    const live = st && (st.phase === "sailing" || st.phase === "boarding" || st.phase == null);

    // ---- The aim preview: the core's, else the scene's from the look ----
    const g = st?.gunnery || null;
    let pv = O.preview || g?.aimPreview || st?.aimPreview || null;
    // The per-frame preview (run.aimPreview(look), handed over by setAimPreview) knows best whether she's aiming.
    // Mortar mode (M) shows its circle without the aim held: the weapon is only "mortar" in that mode or an aimed auto-mortar.
    const aiming = (!!(pv?.aiming ?? g?.aiming ?? st?.aiming ?? (pv != null)) || pv?.weapon === "mortar") && pv?.weapon !== "none";
    if (!pv && (g?.aiming || st?.aiming) && look) {
      const weapon = g?.weapon || (look.zone === "bow" ? "chain" : look.zone === "stern" ? "barrels" : "broadside");
      pv = localPreview(weapon, g?.side || look.zone, look.aim01, sh);
    } else if (pv && !pv.arcs && !pv.line && !pv.drops && !pv.target && look) {
      pv = { ...pv, ...localPreview(pv.weapon || "broadside", pv.side || look.zone, pv.elevation ?? look.aim01, sh) };
    }
    O.alpha += ((live && aiming && pv ? 1 : 0) - O.alpha) * Math.min(1, dt * 10);
    arcMat.uniforms.uAlpha.value = O.alpha;
    // Over the bow the chasers' arcs run up behind her own masts and yards: drawn on top there.
    arcMat.depthTest = pv?.weapon !== "chain";
    if (pv && O.alpha > 0.01) {
      const grav = Number.isFinite(+pv.g) ? +pv.g : G;
      for (const a of pv.arcs || []) {
        let n = 0, land = null, hit = false;
        if (Array.isArray(a.points) && a.points.length >= 2) {
          n = Math.min(PTS, a.points.length);
          for (let i = 0; i < n; i++) {
            const p = a.points[Math.round((i / (n - 1)) * (a.points.length - 1))];
            tmpPts[i].set(+p.x || 0, Number.isFinite(+p.y) ? +p.y : WATER_Y, +p.z || 0);
          }
          land = tmpPts[n - 1];
          hit = !!a.hit;
        } else if (a.from && a.v) {
          const r = integrate(_v.set(+a.from.x || 0, +a.from.y || 0, +a.from.z || 0), _w.set(+a.v.x || 0, +a.v.y || 0, +a.v.z || 0), grav, a.hit == null);
          n = r.n; land = r.land; hit = a.hit != null ? !!a.hit : !!r.hit;
        }
        if (n >= 2) {
          pushArc(tmpPts, n, hit, pv.weapon === "heavy" ? 0.7 : pv.weapon === "chain" ? 0.85 : pv.weapon === "mortar" ? 0.6 : 0.45);
          pushDecal(land.x, land.z, hit ? 3.2 : 2.6, KIND.ring, hit ? RED : WHITE, 0.85 * O.alpha);
        }
      }
      // The chain shot: a cone from the bow on the water.
      if (pv.line) {
        const L = pv.line;
        const fx0 = +L.from?.x || 0, fz0 = +L.from?.z || 0;
        let dx = +L.dir?.x, dz = +L.dir?.z;
        if (!Number.isFinite(dx) && L.to) { dx = L.to.x - fx0; dz = L.to.z - fz0; }
        const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
        const range = +L.range || (L.to ? Math.hypot(L.to.x - fx0, L.to.z - fz0) : 220);
        const spread = (+L.spread || 6) * DEG;
        let hitAny = L.hit != null ? !!L.hit : false;
        for (const k of [-1, 0, 1]) {
          const c = Math.cos(k * spread), s = Math.sin(k * spread);
          const ux = dx * c - dz * s, uz = dx * s + dz * c;
          for (let i = 0; i < PTS; i++) {
            const t = (i / (PTS - 1)) * range;
            const px = fx0 + ux * t, pz = fz0 + uz * t;
            tmpPts[i].set(px, WATER_Y + 1.2 + (k === 0 ? 1.5 : 0.4), pz);
            if (L.hit == null && !hitAny && i > 2 && shipAt(px, pz, 0)) hitAny = true;
          }
          pushArc(tmpPts, PTS, false, k === 0 ? 0.5 : 0.3);
        }
        if (hitAny) for (let i = nArc - 3; i < nArc; i++) for (let v = 0; v < PTS * 2; v++) aInfo[((i * PTS * 2) + v) * 4 + 2] = 1;
        pushDecal(fx0 + dx * range, fz0 + dz * range, 5, KIND.ring, hitAny ? RED : WHITE, 0.7 * O.alpha);
      }
      // Fire barrels: where they'd drop astern.
      for (const [i, p] of (pv.drops || []).entries()) pushDecal(+p.x, +p.z, 2.2, KIND.drop, FIRE, 0.9 * O.alpha, 0, 0, i);
      // Mortars: the target circle following the mouse.
      const tg = pv.circle || (pv.target && Number.isFinite(+pv.target.x) ? pv.target : null) || (pv.weapon === "mortar" && O.aimPoint ? { ...O.aimPoint, r: pv.r || 18 } : null);
      if (tg && Number.isFinite(+tg.x)) pushDecal(+tg.x, +tg.z, +tg.r || 18, KIND.target, tg.hit || shipAt(+tg.x, +tg.z, +tg.r * 0.3 || 4) ? RED : GOLD, 0.95 * O.alpha);
    }

    // ---- Shells in flight (ours and theirs): shrinking circles where they land ----
    const hzm = st?.hazards?.mortars || [];
    const ringsFromCore = hzm.some((m) => m.ours || m.from === "rexmaw");
    for (const p of ringsFromCore ? [] : st?.projectiles || []) {
      if (p.ammo !== "mortar" && p.kind !== "mortar") continue;
      const tx = +(p.target?.x ?? p.tx), tz = +(p.target?.z ?? p.tz);
      if (!Number.isFinite(tx)) continue;
      const total = +p.total || +p.T || 2.5, eta = Number.isFinite(+p.eta) ? +p.eta : 1;
      const k = clamp(1 - eta / total, 0, 1);
      const ours = p.from === "rexmaw" || p.by === "rexmaw";
      pushDecal(tx, tz, +p.r || 12, KIND.telegraph, ours ? GOLD : RED, 0.95, k);
    }
    for (const m of st?.hazards?.mortars || []) {
      // (weather.js draws the enemy's mortar rings in red; ours — from "rexmaw" — are gold, here)
      if (!(m.ours || m.from === "rexmaw")) continue;
      pushDecal(+m.x, +m.z, +m.r || 14, KIND.telegraph, GOLD, 0.9, clamp(1 - (+m.eta || 0) / 6, 0, 1));
    }
    // Floating fire barrels already dropped (the core's) burn on the water: a hot ring under each.
    for (const b of st?.barrels || st?.hazards?.barrels || []) if (Number.isFinite(+b.x)) pushDecal(+b.x, +b.z, +b.r || 6, KIND.drop, FIRE, b.lit === false ? 0.3 : 0.6, 0, 0, (+b.x * 0.13) % 1);

    // ---- The companion's marks: danger areas (fade out over their last 10 s), the heading called ----
    const now = st?.t ?? R.time;
    const list = st?.dangers || st?.marks || st?.hazards?.dangers || [];
    for (const d of list) {
      if (!Number.isFinite(+d.x)) continue;
      const left = Number.isFinite(+d.expiresIn) ? +d.expiresIn : Number.isFinite(+d.ttl) ? +d.ttl : (Number.isFinite(+d.until) ? +d.until - now : 60);
      const fade = clamp(left / 10, 0, 1);
      const born = Number.isFinite(+d.t) ? clamp((now - +d.t) / 1.2, 0, 1) : 1;
      const col = d.kind === "patrol" ? new THREE.Color(1.0, 0.55, 0.2) : RED;
      pushDecal(+d.x, +d.z, Math.max(8, +d.r || +d.radius || 40), KIND.danger, col, 0.7 * fade * born, 0, 0, ((+d.x * 0.017 + +d.z * 0.031) % 1 + 1) % 1);
    }
    const hc = st?.headingCall || st?.callHeading || st?.heading_call || null;
    const deg = headingDeg(hc);
    if (hc && sh && deg != null) {
      const age = Number.isFinite(+hc.t) ? now - +hc.t : 0;
      const k = Number.isFinite(+hc.expiresIn) ? clamp(+hc.expiresIn / 6, 0, 1) : clamp(1 - (age - 20) / 10, 0, 1);
      const [hx, hz] = headingVec(deg);
      for (let i = 0; i < 5; i++) {
        const dist = 32 + i * 16;
        pushDecal(+sh.x + hx * dist, +sh.z + hz * dist, 4.2, KIND.chevron, GOLD, 0.8 * k, 0, Math.atan2(-hx, hz), i * 0.2);
      }
    }
    const wp = st?.course || st?.waypoint || null;
    if (wp && Number.isFinite(+wp.x)) pushDecal(+wp.x, +wp.z, 14, KIND.waypoint, GOLD, 0.55);

    // Commit.
    arcGeo.setDrawRange(0, nArc * (PTS - 1) * 6);
    if (nArc) for (const a of [arcGeo.attributes.position, arcGeo.attributes.aDir, arcGeo.attributes.aInfo]) a.needsUpdate = true;
    decals.count = nDec;
    if (nDec) { SEA.d0.needsUpdate = true; SEA.d1.needsUpdate = true; SEA.d2.needsUpdate = true; }
    decalsTop.count = nTop;
    if (nTop) { TOP.d0.needsUpdate = true; TOP.d1.needsUpdate = true; TOP.d2.needsUpdate = true; }
  }

  /** A hit marker at world (x, y, z) (our shot striking home). */
  function hitMarker(x, y, z, { heavy = false, size = 1 } = {}) {
    if (!Number.isFinite(x)) return;
    const i = mkSlot;
    mkSlot = (mkSlot + 1) % MARKS;
    mkAt.setXYZW(i, x, y, z, wu.uTime.value);
    mkInfo.setXY(i, size * (heavy ? 1.4 : 1), heavy ? 1 : 0);
    mkAt.needsUpdate = true; mkInfo.needsUpdate = true;
  }

  return {
    root, update, hitMarker,
    /** The scene's own preview (debug / solo): {weapon, side, aiming, arcs?|line?|drops?|target?}; null clears. */
    setPreview(p) { O.preview = p || null; },
    /** Where the mouse meets the sea (the mortar's circle follows it when the core sends no target). */
    setAimPoint(x, z) { O.aimPoint = Number.isFinite(+x) ? { x: +x, z: +z } : null; },
    /** The contact whose hull covers (x, z), or null. */
    shipAt,
    /** The land's height above the sea at (x, z) (islands.heightAt): the mortar's rings sit on it. */
    setGround(fn) { groundAt = typeof fn === "function" ? fn : null; },
    warmShow(on) {
      if (on) {
        decals.count = Math.max(1, decals.count); decalsTop.count = Math.max(1, decalsTop.count);
        arcGeo.setDrawRange(0, 6);
      } else { decals.count = 0; decalsTop.count = 0; arcGeo.setDrawRange(0, 0); }
    },
    stats: () => ({ arcs: nArc, decals: nDec, top: nTop }),
    dispose() { root.removeFromParent(); for (const x of [arcGeo, arcMat, decGeo, decGeoTop, decMat, decMatTop, quad, mkGeo, mkMat]) x.dispose(); },
  };
}
