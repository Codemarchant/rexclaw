// Night Raid (from Night Helm): the Kraken (from Starboard's Deep Bell Kraken).
//
// Two things share one set of materials, all built hidden at load (nothing
// compiles mid-voyage):
//
//   event arms  three slots of three tentacles. When the sim's Kraken event
//               (state.krakens[i]) goes tremor → rise → up → sink, a slot
//               takes it: the main arm rises at the event's spot, two smaller
//               ones beside it, all leaning toward the ship; on a Kraken hit
//               (`slam`) the main arm whips down at her. Splashes and foam
//               wherever an arm breaks the surface (found by watching the
//               spines cross y = −2.2), sheeting water while they rise, a
//               ring of light from below, one teal light.
//   set piece   once per voyage in leg 3, at a safe distance: the mantle
//               (about 15 × 10 × 13 m, chromatophores pulsing) and the eye,
//               which follows the camera, rise with four arms of their own,
//               watch the ship pass, and sink.
//
// Tentacles are tubes whose shape lives in the vertex shader: each frame the
// CPU moves 12 spine points per arm and the shader sweeps the tube along the
// Catmull-Rom spine, adds a travelling wave, and draws sucker rings.

import * as THREE from "three";
import { LAYERS, WATER_Y, B } from "./blocking.js";

const SPINE_N = 12;
const SLOTS = 8, PER_SLOT = 3, PIECE_ARMS = 4;
const SLOT_RANGE = 480;                        // only events this close to the ship take a slot (fog hides the rest; marks.js still shows them)
const DEG = Math.PI / 180;
const hv = (deg) => [-Math.sin(deg * DEG), Math.cos(deg * DEG)];
const PLANKTON = new THREE.Color("#3ff3e0");
const SKIN = new THREE.Color("#33264a");
const EYE_URL = new URL("../../assets/img/kraken_eye.webp", import.meta.url).href;
const STAGE_RISE = 1.8, STAGE_SINK = 2.4;    // seconds for an arm to rise or go down (the sim: rise 1.5 s, sink 2 s)

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const rand = (a, b) => a + Math.random() * (b - a);
const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  overshoot: (t) => { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

// ---- Shared GLSL ----------------------------------------------------------------------

const GLSL_NOISE = /* glsl */ `
  float kHash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float kHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float kNoise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(kHash3(i), kHash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(kHash3(i + vec3(0.0, 1.0, 0.0)), kHash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(kHash3(i + vec3(0.0, 0.0, 1.0)), kHash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(kHash3(i + vec3(0.0, 1.0, 1.0)), kHash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  float kNoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(kHash2(i), kHash2(i + vec2(1.0, 0.0)), u.x), mix(kHash2(i + vec2(0.0, 1.0)), kHash2(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float kWorley(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d = 1.5;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = vec2(kHash2(i + g), kHash2(i + g + 17.31));
        d = min(d, length(g + o - f));
      }
    }
    return d;
  }`;

// ---- The mantle ----------------------------------------------------------------------

const MANTLE_SCALE = 1.12;
const MANTLE_LIFT = 1.4;

function mantleGeometry() {
  const g = new THREE.SphereGeometry(1, 72, 48);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const top = Math.max(0, y);
    let X = x * 7 * MANTLE_SCALE, Y = y * 4.5 * MANTLE_SCALE, Z = z * 6 * MANTLE_SCALE;
    X -= top * top * 2.4;
    Y *= 1 + 0.28 * Math.max(0, -x) * top;
    Z *= 1 - 0.12 * top;
    if (x > 0.55 && y > -0.2) X -= (x - 0.55) * 0.9;
    p.setXYZ(i, X, Y, Z);
  }
  g.computeVertexNormals();
  return g;
}

function mantleMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ name: "nh-kraken-mantle", color: SKIN, roughness: 0.55, metalness: 0, envMapIntensity: 0.6 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uBreath = U.uBreath;
    shader.uniforms.uWet = U.uWet;
    shader.uniforms.uChroma = U.uChroma;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime, uBreath;
        varying vec3 vKObj;
        ${GLSL_NOISE}
        float kDisp(vec3 p) {
          return (kNoise3(p * 0.22 + vec3(0.0, uTime * 0.05, 0.0)) - 0.5) * 0.6
               + (kNoise3(p * 0.7 - vec3(uTime * 0.03)) - 0.5) * 0.18;
        }`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
        float kD0 = kDisp(position);
        {
          vec3 kT = normalize(cross(objectNormal, abs(objectNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 kB = cross(objectNormal, kT);
          float kE = 0.2;
          float kdT = (kDisp(position + kT * kE) - kD0) / kE;
          float kdB = (kDisp(position + kB * kE) - kD0) / kE;
          objectNormal = normalize(objectNormal - kT * kdT - kB * kdB);
        }`)
      .replace("#include <begin_vertex>", `
        vec3 transformed = position + normal * (kD0 + uBreath * 0.16 * smoothstep(-2.0, 4.0, position.y));
        vKObj = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTime, uWet, uChroma;
        varying vec3 vKObj;
        ${GLSL_NOISE}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float kMott = kNoise3(vKObj * 0.9) * 0.6 + kNoise3(vKObj * 2.7) * 0.4;
        diffuseColor.rgb *= mix(0.62, 1.25, kMott);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.33, 0.5), smoothstep(-1.0, -4.0, vKObj.y) * 0.5);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        float kRun = kNoise2(vec2(vKObj.x * 1.6 + vKObj.z * 0.7, vKObj.y * 0.35 + uTime * 0.5));
        roughnessFactor = mix(roughnessFactor, 0.12, uWet * (0.55 + 0.45 * kRun));`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        {
          vec2 kc = vKObj.xy * 0.95 + vKObj.zx * 0.55 + vec2(0.0, uTime * 0.05);
          float kCell = kWorley(kc);
          float kSpot = smoothstep(0.24, 0.03, kCell);
          float kPatch = smoothstep(0.42, 0.78, kNoise3(vKObj * 0.22 + vec3(0.0, uTime * 0.06, uTime * 0.02)));
          float kP = 0.5 + 0.5 * sin(uTime * 1.1 + kHash2(floor(kc)) * 6.2831);
          float kPulse = 0.3 + 0.7 * kP * kP * kP;
          vec3 kCol = mix(vec3(0.1, 0.95, 0.85), vec3(0.62, 0.32, 1.0), kNoise3(vKObj * 0.35 + vec3(uTime * 0.02)));
          totalEmissiveRadiance += kCol * kSpot * kPatch * kPulse * uChroma * 1.5;
        }`);
  };
  mat.customProgramCacheKey = () => "nh-kraken-mantle";
  return mat;
}

// ---- The tentacles --------------------------------------------------------------------

function tentacleMaterial(U) {
  const mat = new THREE.MeshStandardMaterial({ name: "nh-kraken-arm", color: SKIN.clone().multiplyScalar(1.15), roughness: 0.45, metalness: 0, envMapIntensity: 0.6 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        #define K_N ${SPINE_N}
        uniform vec3 uSpine[K_N];
        uniform vec3 uSide;
        uniform float uRadius, uWaveAmp, uWavePhase, uTime;
        varying vec2 vKTube;
        varying float vKR;`)
      .replace("#include <beginnormal_vertex>", `
        float kS = clamp(uv.x, 0.0, 1.0);
        float kTh = uv.y * 6.2831853;
        float kF = kS * float(K_N - 1);
        int kI = int(clamp(floor(kF), 0.0, float(K_N - 2)));
        float kU = kF - float(kI);
        vec3 kP0 = uSpine[max(kI - 1, 0)], kP1 = uSpine[kI], kP2 = uSpine[kI + 1], kP3 = uSpine[min(kI + 2, K_N - 1)];
        vec3 kA = 2.0 * kP0 - 5.0 * kP1 + 4.0 * kP2 - kP3;
        vec3 kBc = -kP0 + 3.0 * kP1 - 3.0 * kP2 + kP3;
        vec3 kC = 0.5 * (2.0 * kP1 + (-kP0 + kP2) * kU + kA * kU * kU + kBc * kU * kU * kU);
        vec3 kTan = normalize(0.5 * ((-kP0 + kP2) + 2.0 * kA * kU + 3.0 * kBc * kU * kU) + vec3(1e-5, 0.0, 0.0));
        // The frame: never normalize a zero cross product (the tangent along uSide would be NaN).
        vec3 kX = cross(kTan, uSide);
        if (dot(kX, kX) < 1e-8) kX = cross(kTan, vec3(0.0, 0.0, 1.0));
        vec3 kN = normalize(kX + vec3(1e-6, 2e-6, 3e-6));
        vec3 kBn = cross(kN, kTan);
        float kW = uWaveAmp * sin(kS * 9.0 - uTime * 1.6 + uWavePhase) * smoothstep(0.15, 1.0, kS);
        kC += kBn * kW + kN * kW * 0.3;
        float kR = uRadius * (pow(max(1.0 - kS, 0.0), 0.85) * 0.94 + 0.06);
        kR *= 1.0 + 0.1 * smoothstep(0.0, 0.1, kS) * (1.0 - smoothstep(0.1, 0.3, kS));
        vec3 kDir = cos(kTh) * kN + sin(kTh) * kBn;
        vec3 objectNormal = kDir;
        vKTube = vec2(kS, uv.y);
        vKR = kR;`)
      .replace("#include <begin_vertex>", `vec3 transformed = kC + kDir * kR;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTime, uChroma, uWet;
        varying vec2 vKTube;
        varying float vKR;
        ${GLSL_NOISE}
        float kSucker(vec2 tube, out float cup) {
          float ang = (tube.y - 0.5) * 6.2831853;
          float best = 9.0;
          for (int row = 0; row < 2; row++) {
            float off = row == 0 ? -0.36 : 0.36;
            float k = tube.x * 46.0 + (row == 0 ? 0.0 : 0.5);
            vec2 d = vec2(fract(k) - 0.5, (ang - off) / 0.36 * 0.5);
            best = min(best, length(d));
          }
          cup = smoothstep(0.27, 0.2, best);
          return smoothstep(0.33, 0.28, best) * smoothstep(0.17, 0.23, best);
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float kInner = smoothstep(0.35, 0.95, -cos(vKTube.y * 6.2831853));
        float kCup;
        float kRing = kSucker(vKTube, kCup) * step(0.08, vKTube.x);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.46, 0.62), kInner * 0.75);
        diffuseColor.rgb *= mix(0.7, 1.15, kNoise2(vKTube * vec2(60.0, 9.0)));
        diffuseColor.rgb *= 1.0 - kCup * kInner * 0.45;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, uWet * (0.5 + 0.5 * kNoise2(vec2(vKTube.x * 30.0 - uTime * 0.6, vKTube.y * 8.0))));`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.12, 0.95, 0.85) * kRing * kInner * uChroma * (0.9 + 0.6 * sin(uTime * 2.0 + vKTube.x * 40.0));
        // A bioluminescent rim, so an arm reads as a shape against the night sea (and through fog).
        {
          vec3 kV = normalize(vViewPosition + vec3(0.0, 0.0, 1e-5));
          float kF = 1.0 - clamp(abs(dot(normalize(normal), kV)), 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.12, 0.85, 0.75) * kF * kF * kF * 0.55 * uChroma;
        }`);
  };
  mat.customProgramCacheKey = () => "nh-kraken-arm";
  return mat;
}

/** A straight tube to sweep: uv.x runs along it, uv.y around it. */
function tubeGeometry([tubular, radial]) {
  const g = new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)), tubular, 1, radial, false);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

// ---- The eye ---------------------------------------------------------------------------

function eyeMaterial(U) {
  return new THREE.ShaderMaterial({
    name: "nh-kraken-eye",
    uniforms: U,
    vertexShader: /* glsl */ `
      varying vec3 vLocal, vWorldPos, vWorldN;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; uniform float uHasTex, uPupil, uTime, uGlow, uFogDensity;
      uniform vec3 uMoonDir, uLanternPos, uFogColor;
      varying vec3 vLocal, vWorldPos, vWorldN;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vLocal + vec3(0.0, 0.0, 1e-5));
        vec2 uv = d.xy / (1.0 + max(d.z, 0.0));
        float r = length(uv);
        const float IRIS = 0.5;
        vec3 col = vec3(0.025, 0.045, 0.05) * (0.6 + 0.4 * kNoise2(uv * 9.0));
        float ang = atan(uv.y, uv.x);
        float fib = kNoise2(vec2(ang * 18.0, r * 6.0)) * 0.6 + kNoise2(vec2(ang * 47.0, r * 15.0)) * 0.4;
        vec3 irisCol = mix(vec3(1.0, 0.72, 0.28) * 1.3, vec3(0.07, 0.85, 0.78), smoothstep(0.06, 0.3, r)) * (0.55 + 0.65 * fib);
        irisCol *= 1.0 - 0.78 * smoothstep(IRIS - 0.11, IRIS, r);
        vec2 cell = floor(vec2(ang * 9.0, r * 22.0));
        float h = kHash2(cell);
        irisCol += vec3(0.25, 1.0, 0.9) * 2.4 * step(0.93, h) * (0.5 + 0.5 * sin(uTime * (1.5 + h * 3.0) + h * 40.0)) * smoothstep(0.1, 0.4, r);
        if (uHasTex > 0.5) {
          vec4 tx = texture2D(uTex, 0.5 + uv / IRIS * 0.36);
          irisCol = mix(irisCol, tx.rgb * 1.5, tx.a * 0.85);
        }
        float w = mix(0.035, 0.13, uPupil);
        vec2 q = vec2(max(abs(uv.x) - (0.36 - w), 0.0), uv.y);
        irisCol = mix(irisCol, vec3(0.0), smoothstep(w + 0.012, w - 0.012, length(q)));
        float iris = smoothstep(IRIS + 0.02, IRIS - 0.02, r) * step(0.0, d.z);
        col = mix(col, irisCol * uGlow * 1.6, iris);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 N = normalize(vWorldN);
        vec3 Rf = reflect(-V, N);
        float fres = 0.04 + 0.96 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);
        float stars = step(0.9965, kHash2(floor(Rf.xy * 90.0 + Rf.z * 37.0))) * step(0.0, Rf.y);
        float moon = pow(max(dot(Rf, uMoonDir), 0.0), 600.0) * 4.0;
        vec3 toL = uLanternPos - vWorldPos;
        float lan = pow(max(dot(Rf, toL / max(length(toL), 1e-3)), 0.0), 1400.0) * 3.0;
        col += (vec3(0.8, 0.88, 1.0) * (stars * 1.2 + moon) + vec3(1.0, 0.7, 0.4) * lan) * (0.35 + fres);
        col += vec3(0.6, 0.75, 1.0) * fres * 0.08;
        float depth = length(cameraPosition - vWorldPos);
        col = mix(uFogColor, col, exp(-uFogDensity * uFogDensity * depth * depth));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/** A ring of light rising from the deep: a flat additive disc on the water. */
function glowMaterial() {
  return new THREE.ShaderMaterial({
    name: "nh-kraken-glow",
    uniforms: { uI: { value: 0 }, uT: { value: 0 }, uTime: { value: 0 }, uColor: { value: PLANKTON.clone().multiplyScalar(1.6) } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uI, uT, uTime; uniform vec3 uColor; varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float ringR = mix(0.95, 0.35, uT);
        float q = (r - ringR) / 0.07;
        float ring = exp(-q * q);
        float core = exp(-r * r * 6.0) * 0.6;
        float n = 0.6 + 0.4 * kNoise2(vec2(atan(p.y, p.x) * 4.0, r * 6.0 - uTime * 0.6));
        float a = (ring + core) * n * uI * smoothstep(1.0, 0.85, r);
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

// ---- The Kraken ---------------------------------------------------------------------------

/**
 * Build the Kraken (hidden) and add it to the scene.
 * @param {object} R  the render context
 * @param {{fx?: object, water?: object}} [opts]
 */
export function createKraken(R, { fx = null, water = null } = {}) {
  const scene = R.scene;
  const group = new THREE.Group();
  group.name = "kraken";
  scene.add(group);
  const disposables = [];
  const time = { t: 0 };
  const shared = { uTime: { value: 0 }, uChroma: { value: 1 }, uWet: { value: 1 } };

  // ---- Tentacle pool ----
  const segs = () => (Array.isArray(R?.quality?.krakenSegments) ? R.quality.krakenSegments : [120, 12]);
  let tubeSegs = segs();
  let tubeGeo = tubeGeometry(tubeSegs);
  const makeArm = (i, radius) => {
    const U = {
      uSpine: { value: Array.from({ length: SPINE_N }, () => new THREE.Vector3(0, -60, 0)) },
      uSide: { value: new THREE.Vector3(1, 0, 0) },
      uRadius: { value: radius }, uWaveAmp: { value: 0.3 }, uWavePhase: { value: i * 1.7 },
      uTime: shared.uTime, uChroma: shared.uChroma, uWet: shared.uWet,
    };
    const mat = tentacleMaterial(U);
    const mesh = new THREE.Mesh(tubeGeo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.layers.set(LAYERS.WORLD);
    group.add(mesh);
    disposables.push(mat);
    return {
      i, U, mesh, base: new THREE.Vector3(), out: new THREE.Vector3(0, 0, 1), radial: new THREE.Vector3(0, 0, -1),
      up: UP.clone(), side: U.uSide.value, height: 10, curl: 1, rise: 0, phase: i * 1.37, slam: 0, crossings: 0, sheetAcc: 0, rising: false,
    };
  };
  const slots = Array.from({ length: SLOTS }, (_, s) => ({
    id: null, stage: "idle", t: 0, x: 0, z: 0, rise: 0, from: 0, slam: 0, slamT: -1,
    kind: "rise", sweep: null, angle: 0, lift: 0, stun: 0, flinch: 0, stunned: false, prevStage: null, k: null,
    arms: Array.from({ length: PER_SLOT }, (_, k) => makeArm(s * PER_SLOT + k, k === 0 ? 1.15 : 0.7)),
    glow: null,
  }));
  const glowGeo = new THREE.PlaneGeometry(26, 26);
  glowGeo.rotateX(-Math.PI / 2);
  disposables.push(glowGeo);
  for (const sl of slots) {
    const m = glowMaterial();
    const disc = new THREE.Mesh(glowGeo, m);
    disc.renderOrder = 9;
    disc.visible = false;
    disc.layers.set(LAYERS.NOREFLECT);
    group.add(disc);
    disposables.push(m);
    sl.glow = disc;
  }
  // One teal light under the busiest slot (always present: toggling lights recompiles every lit material).
  const light = new THREE.PointLight(PLANKTON, 0, 60, 2);
  light.name = "kraken-light";
  scene.add(light);

  // ---- The set piece: mantle, eye and four arms ----
  const piece = { stage: "hidden", t: 0, drop: 14, lid: 0, lidHalf: 1, pupil: 0.45, chroma: 0, x: 0, z: 0, face: 0, arms: [] };
  const head = new THREE.Group();
  head.name = "kraken-head";
  head.visible = false;
  group.add(head);
  const mantleU = { uTime: shared.uTime, uBreath: { value: 0 }, uWet: shared.uWet, uChroma: { value: 0 } };
  const mantleGeo = mantleGeometry();
  const mantleMat = mantleMaterial(mantleU);
  const mantle = new THREE.Mesh(mantleGeo, mantleMat);
  mantle.position.y = MANTLE_LIFT;
  head.add(mantle);
  disposables.push(mantleGeo, mantleMat);
  const eye = new THREE.Group();
  eye.name = "kraken-eye";
  eye.position.set(6.05, 1.9 + MANTLE_LIFT, 0);
  eye.rotation.y = Math.PI / 2;
  eye.scale.setScalar(1.25);
  head.add(eye);
  const eyeTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  eyeTex.needsUpdate = true;
  const eyeU = {
    uTex: { value: eyeTex }, uHasTex: { value: 0 }, uPupil: { value: 0.4 }, uTime: shared.uTime, uGlow: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 0.4, 0.9).normalize() }, uLanternPos: { value: new THREE.Vector3() },
    uFogDensity: { value: 0 }, uFogColor: { value: new THREE.Color(0x070b1a) },
  };
  const ballGeo = new THREE.SphereGeometry(1.25, 48, 32);
  ballGeo.scale(1, 1, 0.78);
  const ballMat = eyeMaterial(eyeU);
  const ball = new THREE.Mesh(ballGeo, ballMat);
  eye.add(ball);
  const skinMat = new THREE.MeshStandardMaterial({ name: "nh-kraken-lid", color: SKIN.clone().multiplyScalar(0.9), roughness: 0.36, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.6 });
  const lidUpGeo = new THREE.SphereGeometry(1.33, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const lidLoGeo = new THREE.SphereGeometry(1.33, 40, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  lidUpGeo.scale(1, 1, 0.82); lidLoGeo.scale(1, 1, 0.82);
  const lidUp = new THREE.Mesh(lidUpGeo, skinMat);
  const lidLo = new THREE.Mesh(lidLoGeo, skinMat);
  const browGeo = new THREE.TorusGeometry(1.5, 0.42, 10, 24, Math.PI);
  const brow = new THREE.Mesh(browGeo, skinMat);
  brow.scale.set(1.12, 0.8, 1);
  brow.position.set(0, 0.18, -0.25);
  eye.add(lidUp, lidLo, brow);
  disposables.push(ballGeo, ballMat, skinMat, lidUpGeo, lidLoGeo, browGeo, eyeTex);
  try {
    if (typeof document === "undefined") throw new Error("no DOM");
    new THREE.TextureLoader().load(EYE_URL, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      eyeU.uTex.value = tex;
      eyeU.uHasTex.value = 1;
      disposables.push(tex);
    }, undefined, () => console.debug("[night-raid] kraken: kraken_eye.webp not found; the procedural iris stands in"));
  } catch { /* the procedural iris */ }
  for (let k = 0; k < PIECE_ARMS; k++) piece.arms.push(makeArm(SLOTS * PER_SLOT + k, [1.0, 0.85, 0.9, 0.75][k]));
  const pieceLook = [
    { a: -0.9, d: 9, swing: 0.62, lean: 0.28, height: 10, curl: 1.0 },
    { a: -0.35, d: 12, swing: 0.8, lean: 0.12, height: 12.5, curl: 1.25 },
    { a: 0.4, d: 11, swing: 0.55, lean: 0.34, height: 8, curl: 0.85 },
    { a: 0.95, d: 8, swing: 0.86, lean: 0.18, height: 10.5, curl: 1.15 },
  ];
  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

  // ---- Helpers ----
  const lanternLocal = new THREE.Vector3().fromArray(B.RAIL_LANTERN);
  const lanternWorld = (out) => { out.copy(lanternLocal); return R?.shipSpace ? R.shipSpace.localToWorld(out) : out; };
  const camPos = new THREE.Vector3();
  const shipPos = new THREE.Vector3();
  const pulse = (x, z, opts = {}) => { try { water?.pulse?.({ x, z, color: opts.color ?? PLANKTON, speed: opts.speed ?? 6 }); } catch { /* */ } };

  /** Aim an arm: base at (x, z), arching toward the point (tx, tz). */
  function aimArm(arm, bx, bz, tx, tz, look) {
    arm.base.set(bx, WATER_Y, bz);
    const toward = _a.set(tx - bx, 0, tz - bz);
    if (toward.lengthSq() < 1e-6) toward.set(0, 0, 1);
    toward.normalize();
    arm.radial.copy(toward).negate();                 // "back" from the target
    const around = _b.crossVectors(UP, toward);
    arm.out.copy(toward).lerp(around, look.swing).normalize();
    arm.up.copy(UP).addScaledVector(toward, look.lean).normalize();
    arm.side.crossVectors(arm.up, arm.out).normalize();
    arm.height = look.height;
    arm.curl = look.curl;
  }

  /** The 12 spine points of one arm for the current state. */
  function spine(arm, out, bow = 0) {
    const r = ease.inOut(clamp(arm.rise, 0, 1));
    const sink = (1 - r) * 15;
    const H = arm.height * (1 - 0.45 * bow) * (1 - 0.55 * arm.slam);
    const t = time.t;
    const B0 = arm.base, o = arm.out, rad = arm.radial, U = arm.up;
    const set = (k, along, up, back = 0) => out[k].copy(B0).addScaledVector(o, along).addScaledVector(rad, -back).addScaledVector(U, up);
    set(0, -1.5, -6, 5);
    set(1, -0.6, -2.6, 2.2);
    set(2, 0.7, H * 0.32);
    set(3, 2.0, H * 0.74);
    set(4, 3.6, H);
    set(5, 5.4, H * 0.86);
    set(6, 6.6, H * 0.6 - bow * 1.8);
    const C = _c.copy(B0).addScaledVector(o, 6.0).addScaledVector(U, H * 0.46 - bow * 2.6);
    const v6 = _d.subVectors(out[6], C);
    const a0 = Math.atan2(v6.dot(U), v6.dot(o));
    const R0 = v6.length();
    const curl = Math.PI * 1.45 * arm.curl * (0.75 + 0.35 * bow + 0.12 * Math.sin(t * 0.4 + arm.phase)) * (1 - 0.6 * arm.slam);
    for (let j = 0; j < 5; j++) {
      const k = (j + 1) / 5;
      const ang = a0 - k * curl;
      const rr = R0 * (1 - k * 0.7);
      out[7 + j].copy(C).addScaledVector(o, Math.cos(ang) * rr).addScaledVector(U, Math.sin(ang) * rr);
    }
    // The slam: the outer arm lunges along its reach and down onto the water.
    if (arm.slam > 0) {
      for (let k = 4; k < SPINE_N; k++) {
        const w = (k - 3) / (SPINE_N - 4);
        out[k].addScaledVector(arm.radial, -arm.slam * 7 * w);
        out[k].y -= arm.slam * 5 * w;
      }
    }
    for (let k = 2; k < SPINE_N; k++) {
      const w = k / (SPINE_N - 1);
      out[k].addScaledVector(arm.side, Math.sin(t * 0.5 + arm.phase + k * 0.3) * 1.1 * w * w);
      out[k].y += Math.sin(t * 0.37 + arm.phase * 1.3) * 0.6 * w;
    }
    for (const p of out) p.y -= sink;
    return out;
  }

  const crossList = [];
  function crossings(pts, list) {
    list.length = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k].y - WATER_Y, b = pts[k + 1].y - WATER_Y;
      if ((a < 0) !== (b < 0)) list.push(_d.lerpVectors(pts[k], pts[k + 1], a / (a - b)).clone());
    }
    return list;
  }

  /** Spines, splashes and sheeting for one arm. */
  function stepArm(arm, dt, bow = 0) {
    const live = arm.rise > 0.002 || arm.slam > 0.002;
    arm.mesh.visible = live;
    if (!live) { arm.crossings = 0; return; }
    const pts = spine(arm, arm.U.uSpine.value, bow);
    arm.U.uWaveAmp.value = 0.25 + 0.3 * (arm.rising ? 1 : 0);
    const n = crossings(pts, crossList).length;
    if (fx && n !== arm.crossings) {
      for (const p of crossList) {
        if (n > arm.crossings) { fx.splash?.(p, { scale: 1.1 }); pulse(p.x, p.z, { speed: 5 }); }
        else fx.foam?.(p, { radius: 2.4, life: 3 });
      }
    }
    arm.crossings = n;
    if (fx && arm.rising) {
      arm.sheetAcc += dt * 9;
      while (arm.sheetAcc >= 1) {
        arm.sheetAcc -= 1;
        const p = pts[2 + Math.floor(Math.random() * 8)];
        if (p.y > WATER_Y + 0.5) fx.sheet?.(p, { count: 3, radius: 0.5 });
      }
    }
  }

  // ---- Event slots ----
  function slotFor(id) { return slots.find((s) => s.id === id) || null; }

  /** Take a free slot for event `k` and lay its arms out around the spot. */
  function claim(k) {
    const sl = slots.find((s) => s.id == null) || slots.reduce((a, b) => (a.rise < b.rise ? a : b));
    sl.id = k.id; sl.stage = "tremor"; sl.t = 0; sl.x = k.x; sl.z = k.z; sl.rise = 0; sl.from = 0; sl.slam = 0; sl.slamT = -1;
    sl.kind = k.kind === "sweep" ? "sweep" : "rise"; sl.stun = 0; sl.flinch = 0; sl.lift = 0; sl.stunned = false; sl.prevStage = null;
    sl.sweep = sl.kind === "sweep" ? { ...(k.sweep || {}) } : null;
    if (sl.sweep) {
      sl.x = Number.isFinite(sl.sweep.pivotX) ? sl.sweep.pivotX : k.x;
      sl.z = Number.isFinite(sl.sweep.pivotZ) ? sl.sweep.pivotZ : k.z;
      sl.angle = Number.isFinite(k.angle) ? k.angle : (+sl.sweep.fromDeg || 0);
      const R0 = Math.max(12, +sl.sweep.radius || 40);
      sl.arms.forEach((arm, j) => {
        arm.rise = 0; arm.slam = 0; arm.rising = false; arm.crossings = 0;
        arm.U.uRadius.value = j === 0 ? THREE.MathUtils.clamp(R0 * 0.042, 1.2, 2.2) : 0.75;
        arm.U.uWaveAmp.value = j === 0 ? 0.35 : 0.3;
        if (j > 0) {
          // Two smaller arms coil beside the pivot: the body is just under the lane's edge.
          const a = (j === 1 ? 1 : -1) * 2.0, [dx, dz] = hv(sl.angle + 180);
          const bx = sl.x + dx * 5 + Math.cos(a) * 3, bz = sl.z + dz * 5 + Math.sin(a) * 3;
          aimArm(arm, bx, bz, shipPos.x, shipPos.z, { swing: j === 1 ? 0.8 : -0.8, lean: 0.15, height: 6.5, curl: 1.3 });
        }
      });
      return sl;
    }
    sl.arms.forEach((arm, j) => { arm.U.uRadius.value = j === 0 ? 1.15 : 0.7; });
    const looks = [
      { swing: 0.15, lean: 0.35, height: 13, curl: 1.1 },
      { swing: 0.75, lean: 0.2, height: 8.5, curl: 1.3 },
      { swing: -0.7, lean: 0.25, height: 7.5, curl: 0.95 },
    ];
    sl.arms.forEach((arm, j) => {
      const a = j === 0 ? 0 : (j === 1 ? 2.1 : -2.3) + rand(-0.3, 0.3), d = j === 0 ? 0 : rand(4.5, 7);
      aimArm(arm, k.x + Math.cos(a) * d, k.z + Math.sin(a) * d, shipPos.x, shipPos.z, looks[j]);
      arm.rise = 0; arm.slam = 0; arm.rising = false; arm.crossings = 0;
    });
    return sl;
  }

  /** Follow the sim's Kraken events (state.krakens). */
  function sync(list) {
    const seen = new Set();
    for (const k of list || []) {
      if (!k || k.id == null) continue;
      let sl = slotFor(k.id);
      const far = Math.hypot(k.x - shipPos.x, k.z - shipPos.z);
      if (!sl) {
        if (k.stage === "sink" || k.stage === "gone") continue;            // never rose for us: nothing to sink
        if (far > SLOT_RANGE || !slots.some((s) => s.id == null)) continue;   // never steal a live slot
        sl = claim(k);
      } else if (far > SLOT_RANGE + 120) continue;                          // left astern: let it go (sinks below)
      seen.add(k.id);
      sl.k = k;
      sl.stunned = !!k.stunned || k.stage === "stunned";
      if (sl.kind === "sweep") {
        if (Number.isFinite(k.angle)) sl.angle = k.angle;
        if (sl.stage !== k.stage) {
          const was = sl.stage;
          sl.stage = k.stage; sl.t = 0;
          if (k.stage === "hold" && was === "slam") slamDown(sl);
          if (k.stage === "telegraph") { fx?.bubbles?.(_a.set(sl.x, WATER_Y, sl.z), { seconds: 2.5, radius: 5 }); pulse(sl.x, sl.z, { speed: 7 }); }
        }
        continue;
      }
      // v4: a sea event's lone arm drifts toward the Rexmaw (`follow`): carry the arms with it.
      if (k.follow && Number.isFinite(+k.x) && Number.isFinite(+k.z)) {
        const dx = +k.x - sl.x, dz = +k.z - sl.z;
        if (dx || dz) { sl.x = +k.x; sl.z = +k.z; for (const arm of sl.arms) { arm.base.x += dx; arm.base.z += dz; } }
      }
      if (sl.stage !== k.stage) {
        const was = sl.stage;
        sl.stage = k.stage; sl.t = 0; sl.from = sl.rise;
        if (k.stage === "rise" && was !== "rise") {
          // Re-aim at the ship as it comes up, a burst of light and bubbles.
          sl.arms.forEach((arm, j) => aimArm(arm, arm.base.x, arm.base.z, shipPos.x, shipPos.z, { swing: [0.15, 0.75, -0.7][j], lean: [0.35, 0.2, 0.25][j], height: arm.height, curl: arm.curl }));
          fx?.bubbles?.(_a.set(sl.x, WATER_Y, sl.z), { seconds: 2.5, radius: 6 });
          pulse(sl.x, sl.z, { speed: 6 });
        }
      }
    }
    // Events the sim dropped: let their arms sink.
    for (const sl of slots) if (sl.id != null && !seen.has(sl.id) && sl.stage !== "sink" && sl.stage !== "idle") { sl.stage = "sink"; sl.t = 0; sl.from = sl.rise; }
  }

  /** The arm hits the water across the lane at the end of its slam: a wall of spray along it. */
  function slamDown(sl) {
    const R0 = Math.max(12, +sl.sweep?.radius || 40);
    const [dx, dz] = hv(sl.angle);
    for (let k = 1; k <= 5; k++) {
      const d = R0 * k / 5.5;
      fx?.splash?.(_a.set(sl.x + dx * d, WATER_Y, sl.z + dz * d), { scale: 1.6 - k * 0.12 });
    }
    pulse(sl.x + dx * R0 * 0.5, sl.z + dz * R0 * 0.5, { speed: 9 });
    const near = Math.hypot(sl.x + dx * R0 * 0.5 - shipPos.x, sl.z + dz * R0 * 0.5 - shipPos.z);
    if (near < 140) R.cam?.trauma?.(0.35 * (1 - near / 140) + 0.08);
  }

  /** A sweeping arm's spine: from the pivot out along `angle`, lying on (or over) the water. */
  function sweepSpine(sl, arm, out) {
    const R0 = Math.max(12, +sl.sweep?.radius || 40);
    const [dx, dz] = hv(sl.angle);
    const t = time.t;
    const H = sl.lift;            // metres the arch stands above the water at its crown
    arm.side.set(dz, 0, -dx);
    for (let k = 0; k < SPINE_N; k++) {
      let d, y;
      if (k === 0) { d = -4; y = WATER_Y - 5; }
      else if (k === 1) { d = 0; y = WATER_Y - 1.2 + H * 0.2; }
      else {
        const s = (k - 1) / (SPINE_N - 2);
        d = R0 * s;
        const arch = Math.pow(Math.max(Math.sin(Math.PI * Math.min(1, s * 1.05)), 0), 0.6);
        y = WATER_Y + H * arch - 0.6 + Math.sin(t * 2.2 + k * 0.9 + arm.phase) * 0.25 * (0.4 + H * 0.15);
        if (k === SPINE_N - 1) y += 1.2 + H * 0.3;                 // the tip curls up
      }
      const wob = k >= 2 ? Math.sin(t * 1.3 + k * 0.7 + arm.phase) * 0.6 * (k / SPINE_N) : 0;
      out[k].set(sl.x + dx * d + arm.side.x * wob, y - sl.stun * 4, sl.z + dz * d + arm.side.z * wob);
    }
    return out;
  }

  function stepSweep(sl, dt) {
    const st = sl.stage;
    // How high the arm stands: awash at rest (a dark ridge along the lane edge), rearing
    // while it telegraphs, high on the slam and the lift, lying across the lane when it holds.
    const want = sl.stunned ? -1.5 : st === "telegraph" ? 3.2 : st === "slam" ? 3.8 : st === "hold" ? 1.1 : st === "lift" ? 4.6 : st === "rest" ? 1.0 : -2;
    sl.lift += (want - sl.lift) * Math.min(1, dt * (st === "hold" ? 9 : 3));
    sl.stun += ((sl.stunned ? 1 : 0) - sl.stun) * Math.min(1, dt * 1.5);
    sl.rise = THREE.MathUtils.clamp((sl.lift + 2) / 4, 0, 1);
    const main = sl.arms[0];
    main.rise = 1; main.slam = 0; main.rising = st === "telegraph" || st === "lift";
    main.mesh.visible = sl.lift > -1.9;
    if (main.mesh.visible) {
      const pts = sweepSpine(sl, main, main.U.uSpine.value);
      const n = crossings(pts, crossList).length;
      if (fx && n !== main.crossings && st !== "rest") for (const p of crossList) fx.foam?.(p, { radius: 2.6, life: 2.5 });
      main.crossings = n;
      if (fx && main.rising) {
        main.sheetAcc += dt * 10;
        while (main.sheetAcc >= 1) { main.sheetAcc -= 1; const p = pts[2 + Math.floor(Math.random() * 9)]; if (p.y > WATER_Y + 0.4) fx.sheet?.(p, { count: 3, radius: 0.6 }); }
      }
    }
    // The coils by the pivot rise with it.
    const coil = st === "rest" ? 0 : sl.stunned ? 0.1 : st === "telegraph" ? 0.6 : 1;
    for (let j = 1; j < sl.arms.length; j++) {
      const arm = sl.arms[j];
      arm.rise += (coil - arm.rise) * Math.min(1, dt * 2);
      arm.rising = st === "telegraph";
      arm.slam = 0;
      stepArm(arm, dt);
    }
    return sl.rise;
  }

  function stepSlots(dt) {
    let best = null;
    for (const sl of slots) {
      if (sl.id == null) { sl.glow.visible = false; continue; }
      sl.t += dt;
      sl.flinch = Math.max(0, sl.flinch - dt * 1.5);
      if (sl.kind === "sweep") {
        if (sl.stage === "gone" || sl.stage === "sink") { sl.lift += (-2.5 - sl.lift) * Math.min(1, dt * 2); if (sl.lift < -2.3) { sl.id = null; sl.stage = "idle"; for (const a of sl.arms) { a.rise = 0; a.mesh.visible = false; } sl.glow.visible = false; continue; } }
        stepSweep(sl, dt);
        sl.glow.visible = sl.stage === "telegraph" || sl.stage === "slam";
        sl.glow.position.set(sl.x, WATER_Y + 0.04, sl.z);
        sl.glow.material.uniforms.uI.value = sl.stage === "telegraph" ? 0.9 : 0.5;
        sl.glow.material.uniforms.uT.value = clamp(sl.t / 3, 0, 1);
        sl.glow.material.uniforms.uTime.value = time.t;
        if (sl.stage !== "rest" && (!best || sl.rise > best.rise)) best = sl;
        continue;
      }
      let target = 0;
      if (sl.stage === "rise") sl.rise = lerp(sl.from, 1, ease.out(clamp(sl.t / STAGE_RISE, 0, 1)));
      else if (sl.stage === "up") sl.rise += (1 - sl.rise) * Math.min(1, dt * 3);
      else if (sl.stage === "sink") {
        sl.rise = lerp(sl.from, 0, ease.inOut(clamp(sl.t / STAGE_SINK, 0, 1)));
        if (sl.t > STAGE_SINK + 0.2) { sl.id = null; sl.stage = "idle"; sl.rise = 0; }
      } else sl.rise = 0;
      // Stunned by the cannon: the arm sags back under for a while.
      sl.stun += ((sl.stunned ? 1 : 0) - sl.stun) * Math.min(1, dt * 1.5);
      target = sl.rise * (1 - 0.82 * sl.stun) * (1 - 0.25 * sl.flinch);
      // The slam: 0.35 s in, 1.2 s back.
      if (sl.slamT >= 0) {
        sl.slamT += dt;
        sl.slam = sl.slamT < 0.35 ? ease.out(sl.slamT / 0.35) : Math.max(0, 1 - ease.inOut((sl.slamT - 0.35) / 1.2));
        if (sl.slamT > 1.6) { sl.slamT = -1; sl.slam = 0; }
      }
      sl.arms.forEach((arm, j) => {
        const lag = j === 0 ? 0 : 0.18 * j;
        arm.rise = clamp(target * (1 + lag) - lag, 0, 1);
        arm.rising = sl.stage === "rise";
        arm.slam = j === 0 ? sl.slam : sl.slam * 0.3;
        stepArm(arm, dt);
      });
      sl.glow.visible = sl.rise > 0.01 || sl.stage === "rise";
      sl.glow.position.set(sl.x, WATER_Y + 0.04, sl.z);
      sl.glow.material.uniforms.uI.value = 0.9 * (sl.stage === "rise" ? 1 : sl.rise * 0.5);
      sl.glow.material.uniforms.uT.value = clamp(sl.t / 4, 0, 1);
      sl.glow.material.uniforms.uTime.value = time.t;
      if (!best || sl.rise > best.rise) best = sl;
    }
    if (best && best.rise > 0.01) {
      light.position.set(best.x, -4 + 3 * best.rise, best.z);
      light.intensity = 260 * best.rise;
    } else light.intensity = Math.max(0, light.intensity - dt * 400);
  }

  // ---- The set piece ----
  function stepPiece(dt) {
    if (piece.stage === "hidden") { head.visible = false; for (const a of piece.arms) a.mesh.visible = false; return; }
    piece.t += dt * (piece.stage === "rise" ? piece.rate || 1 : 1);
    const t = piece.t;
    if (piece.stage === "rise") {
      piece.drop = lerp(14, 0, ease.out(clamp((t - 1.5) / 5.5, 0, 1)));
      piece.chroma = clamp((t - 4) / 3, 0, 1);
      piece.lid = ease.overshoot(clamp((t - 6.2) / 1.4, 0, 1));
      piece.arms.forEach((arm, k) => { arm.rise = ease.sine(clamp((t - 0.8 - k * 0.6) / 2.8, 0, 1)); arm.rising = t < 0.8 + k * 0.6 + 3; });
      if (t >= 8) { piece.stage = "watch"; piece.t = 0; }
    } else if (piece.stage === "sink") {
      piece.lid = 1 - clamp(t / 0.6, 0, 1);
      piece.chroma = 1 - clamp(t / 2.4, 0, 1);
      piece.drop = lerp(0, 14, ease.inOut(clamp((t - 0.6) / 3.1, 0, 1)));
      piece.arms.forEach((arm, k) => { arm.rise = 1 - ease.sine(clamp((t - 0.2 - k * 0.22) / 2.2, 0, 1)); arm.rising = false; });
      if (t >= 4) { piece.stage = "hidden"; head.visible = false; return; }
    } else {
      piece.arms.forEach((arm) => { arm.rise = 1; arm.rising = false; });
    }
    head.visible = true;
    head.position.set(piece.x, -1.5 - piece.drop, piece.z);
    head.rotation.y = piece.face;
    const breath = Math.sin(t * Math.PI * 2 * 0.12) * 0.5;
    mantleU.uBreath.value = breath;
    mantleU.uChroma.value = piece.chroma;
    head.scale.setScalar(1 + breath * 0.012);
    // The surface breaks.
    const crown = -1.5 - piece.drop + MANTLE_LIFT + 5.6;
    const up = crown > WATER_Y;
    if (up !== piece.surfaced && fx) {
      const p = _a.set(piece.x, WATER_Y, piece.z);
      if (up) { fx.splash?.(p, { scale: 2.6 }); fx.foam?.(p, { radius: 12, life: 5 }); pulse(p.x, p.z, { speed: 8 }); }
      else { fx.foam?.(p, { radius: 10, life: 4.5 }); fx.bubbles?.(p, { seconds: 2.2, radius: 6 }); }
    }
    piece.surfaced = up;
    // The eye: blinks, pupil, a gaze that follows the camera (±10°).
    piece.blinkIn = (piece.blinkIn ?? rand(5, 8)) - dt;
    if (piece.blinkIn <= 0 && !(piece.blinkT >= 0)) { piece.blinkT = 0; piece.blinkIn = rand(5, 8); }
    let blink = 1;
    if (piece.blinkT >= 0) {
      piece.blinkT += dt;
      const b = piece.blinkT;
      blink = b < 0.12 ? 1 - b / 0.12 : b < 0.18 ? 0 : Math.min(1, (b - 0.18) / 0.22);
      if (b > 0.4) piece.blinkT = -1;
    }
    const open = clamp(piece.lid, 0, 1.1) * piece.lidHalf * blink;
    lidUp.rotation.x = -1.12 * open;
    lidLo.rotation.x = 0.85 * open;
    eyeU.uPupil.value = piece.pupil + 0.06 * Math.sin(t * 0.7);
    eyeU.uGlow.value = clamp(piece.lid, 0, 1);
    eyeU.uLanternPos.value.copy(lanternWorld(_b));
    if (R.sky?.moonDir) eyeU.uMoonDir.value.copy(R.sky.moonDir);
    const fog = scene.fog;
    eyeU.uFogDensity.value = fog?.isFogExp2 ? fog.density : 0;
    if (fog?.color) eyeU.uFogColor.value.copy(fog.color);
    eye.updateWorldMatrix(true, false);
    const camLocal = _c.copy(camPos);
    eye.worldToLocal(camLocal);
    if (camLocal.lengthSq() > 1e-6) {
      camLocal.normalize();
      const MAX = THREE.MathUtils.degToRad(10);
      const ang = Math.acos(clamp(camLocal.z, -1, 1));
      const q = new THREE.Quaternion();
      if (ang > MAX) { const axis = _d.set(0, 0, 1).cross(camLocal); if (axis.lengthSq() > 1e-8) q.setFromAxisAngle(axis.normalize(), MAX); }
      else q.setFromUnitVectors(_d.set(0, 0, 1), camLocal);
      ball.quaternion.slerp(q, 1 - Math.exp(-3 * dt));
    }
    for (const arm of piece.arms) stepArm(arm, dt);
  }

  // ---- Per frame ----
  function frame(dtIn) {
    const dt = Math.max(0, Math.min(0.1, dtIn || 0));
    time.t += dt;
    shared.uTime.value = time.t;
    R.camera.getWorldPosition(camPos);
    if (R.shipSpace) shipPos.copy(R.shipSpace.position);
    stepSlots(dt);
    stepPiece(dt);
  }
  const offFrame = R.onFrame((dt) => frame(dt), 25);

  const offQuality = R.onQuality(() => {
    const next = segs();
    if (next[0] === tubeSegs[0] && next[1] === tubeSegs[1]) return;
    tubeSegs = next;
    const old = tubeGeo;
    tubeGeo = tubeGeometry(next);
    for (const sl of slots) for (const arm of sl.arms) arm.mesh.geometry = tubeGeo;
    for (const arm of piece.arms) arm.mesh.geometry = tubeGeo;
    old.dispose();
  });

  return {
    group,
    eye,
    sync,
    /**
     * A cannonball struck an arm: it flinches, ink and light burst from it (the
     * sim's `stunned` then sinks it for a while).
     */
    hit(id) {
      const sl = id != null ? slotFor(id) : null;
      if (!sl) return false;
      sl.flinch = 1;
      const p = this.armTarget(id, _b);
      if (p) { fx?.burst?.(p.clone(), { color: "#3ff3e0", count: 60, speed: 5, size: 0.5, life: 1.2, intensity: 4 }); pulse(p.x, p.z, { speed: 10 }); }
      return true;
    },
    /** The set piece reacts to the companion's challenge ("narrow": the eye narrows; "roar"). */
    pieceReact(kind) {
      if (piece.stage === "hidden") return;
      if (kind === "narrow") { piece.lidHalf = 0.45; piece.pupil = 0.08; setTimeout(() => { piece.lidHalf = 1; piece.pupil = 0.45; }, 3500); }
      else if (kind === "hit") {
        // v5: a shot struck the eye (Kraken's Wake): it squints, teal light bursts from it, the arms twitch.
        piece.lidHalf = 0.6; piece.pupil = 0.12;
        clearTimeout(piece.hitT);
        piece.hitT = setTimeout(() => { piece.lidHalf = 1; piece.pupil = 0.45; }, 700);
        fx?.burst?.(eye.getWorldPosition(_b).clone(), { color: "#3ff3e0", count: 50, speed: 5, size: 0.45, life: 1, intensity: 4 });
        for (const arm of piece.arms) arm.rising = true;
      } else {
        piece.pupil = 0.9; setTimeout(() => { piece.pupil = 0.45; }, 2000);
        mantleU.uBreath.value = 2;
        fx?.splash?.(_a.set(piece.x, WATER_Y, piece.z), { scale: 3 });
        pulse(piece.x, piece.z, { speed: 12 });
        R.cam?.trauma?.(0.4);
        for (const arm of piece.arms) arm.rising = true;
      }
    },
    /** A Kraken hit: the event's main arm whips down at the ship. @param {string|number} [id] */
    slam(id) {
      const sl = (id != null && slotFor(id)) || slots.filter((s) => s.id != null).sort((a, b) => b.rise - a.rise)[0];
      if (!sl) return;
      sl.slamT = 0;
      R.cam?.trauma?.(0.5);
      fx?.splash?.(_a.set(sl.x, WATER_Y, sl.z), { scale: 2 });
    },
    /** World position of an event's main arm's crown (for a close-up shot), or null. */
    armTarget(id, out = new THREE.Vector3()) {
      const sl = id != null ? slotFor(id) : slots.filter((s) => s.id != null).sort((a, b) => b.rise - a.rise)[0];
      if (!sl) return null;
      return out.copy(sl.arms[0].U.uSpine.value[4]);
    },
    /** The set piece: place it (world), facing the point (fx, fz). */
    placePiece(x, z, faceX, faceZ) {
      piece.x = x; piece.z = z;
      piece.face = Math.atan2(-(faceZ - z), faceX - x);           // local +X (the eye) toward the face point
      const toward = new THREE.Vector3(faceX - x, 0, faceZ - z).normalize();
      piece.arms.forEach((arm, k) => {
        const L = pieceLook[k];
        const a = Math.atan2(toward.z, toward.x) + L.a;
        aimArm(arm, x + Math.cos(a) * L.d, z + Math.sin(a) * L.d, faceX, faceZ, L);
      });
    },
    /** Raise the set piece (≈8 s; `rate` > 1 plays the rise faster, and hurries one already under way). */
    risePiece(rate = 1) {
      if (piece.stage === "rise") { piece.rate = Math.max(piece.rate || 1, rate); return; }
      if (piece.stage === "watch") return;
      piece.stage = "rise"; piece.t = 0; piece.rate = rate; piece.drop = 14; piece.lid = 0; piece.surfaced = false;
      fx?.bubbles?.(_a.set(piece.x, WATER_Y, piece.z), { seconds: 3.5, radius: 8 });
      pulse(piece.x, piece.z, { speed: 4 });
    },
    /** Sink it (≈4 s). */
    sinkPiece() {
      if (piece.stage === "hidden" || piece.stage === "sink") return;
      piece.stage = "sink"; piece.t = 0;
    },
    get pieceStage() { return piece.stage; },
    /** Where the eye is (world), for the krakenEye shot. */
    eyeTarget(out = new THREE.Vector3()) { return eye.getWorldPosition(out); },
    /** Clear every arm (a new voyage). */
    reset() {
      for (const sl of slots) { sl.id = null; sl.stage = "idle"; sl.rise = 0; sl.slam = 0; sl.slamT = -1; for (const a of sl.arms) { a.rise = 0; a.mesh.visible = false; } sl.glow.visible = false; }
      piece.stage = "hidden"; head.visible = false;
      for (const a of piece.arms) { a.rise = 0; a.mesh.visible = false; }
      light.intensity = 0;
    },
    /** For the compile warm-up: show everything. */
    warmShow(on) {
      for (const sl of slots) { for (const a of sl.arms) a.mesh.visible = on || a.rise > 0.002; sl.glow.visible = on || sl.rise > 0.01; }
      for (const a of piece.arms) a.mesh.visible = on || (piece.stage !== "hidden" && a.rise > 0.002);
      head.visible = on || piece.stage !== "hidden";
    },
    dispose() {
      offFrame(); offQuality();
      group.removeFromParent();
      light.removeFromParent();
      tubeGeo.dispose();
      for (const d of disposables) d.dispose?.();
    },
  };
}
