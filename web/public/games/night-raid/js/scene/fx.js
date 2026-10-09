// Night Raid (from Night Helm): pooled effects (from Starboard's fx.js). Everything is built
// once at load, so nothing compiles mid-voyage:
//
//   two particle pools  one additive (sparks, glints, embers, flare drips,
//                       droplets catching the moon) and one alpha-blended
//                       (spray, smoke, splinters), each a single Points draw
//                       with procedural sprite shapes: soft glow, four-point
//                       glint, bubble and puff
//   foam rings          24 flat rings on the water (splashes, hits, the Kraken)
//   the flare           a rocket on a spark trail, then a parachute star that
//                       burns 8 s, drifting down: an HDR sprite and an
//                       orange-white PointLight (always in the scene, at 0 when
//                       out, so no material ever recompiles); while it burns the
//                       fog leans orange (R.atmos.tint) and `flareLevel` is up
//   floating crates     16 instanced crates: cargo lost overboard bobs on the
//                       swell and drifts astern, then founders
//
// Particle sizes and speeds are in metres, but bursts scale with their
// distance from the camera unless told otherwise. All of it lives on the FX
// layer (the water's reflection sees it too).

import * as THREE from "three";
import { LAYERS, WATER_Y, B } from "./blocking.js";

const GILT = new THREE.Color("#ffcf6b");
const LANTERN = new THREE.Color("#ffb067");
const SPRAY = new THREE.Color("#cfe6ef");
const MOONLIT = new THREE.Color("#bcd2ff");
const FLARE = new THREE.Color("#ffd6a0");
const SPLINTER = new THREE.Color("#5a3d24");
const TRAIL_SMOKE = new THREE.Color(0.3, 0.3, 0.33);
const SMOKE_GREY = new THREE.Color(0.27, 0.27, 0.3);
const SMOKE_LIT = new THREE.Color(0.55, 0.32, 0.18);

const SHAPE = { glow: 0, glint: 1, bubble: 2, puff: 3 };
const tmpColor = new THREE.Color();
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _bufSize = new THREE.Vector2();

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Any colour input → THREE.Color, scaled by `k` (HDR). */
function hdr(color, k = 1) {
  return tmpColor.set(color ?? GILT).multiplyScalar(k);
}

const GLSL_NOISE = /* glsl */ `
  float sbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float sbNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sbHash(i), sbHash(i + vec2(1.0, 0.0)), u.x), mix(sbHash(i + vec2(0.0, 1.0)), sbHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }`;

// ---- Particle pools ------------------------------------------------------------------

/** A fixed pool of point sprites with CPU integration. Dead slots are reused first. */
class Pool {
  constructor(capacity, additive) {
    this.n = capacity;
    const f = (k) => new Float32Array(capacity * k);
    this.pos = f(3); this.vel = f(3); this.col = f(3);
    this.age = f(1).fill(1); this.life = f(1).fill(1);
    this.size0 = f(1); this.size1 = f(1); this.alpha0 = f(1);
    this.gravity = f(1); this.drag = f(1); this.swirl = f(1);
    this.shape = f(1); this.seed = f(1); this.floor = f(1).fill(-1e9);
    this.fadeIn = f(1);
    this.aSize = f(1); this.aAlpha = f(1);
    this.cursor = 0;
    this.high = 0;

    const geo = new THREE.BufferGeometry();
    const attr = (name, arr, k) => {
      const a = new THREE.BufferAttribute(arr, k);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.aPos = attr("position", this.pos, 3);
    this.aCol = attr("aColor", this.col, 3);
    this.aSz = attr("aSize", this.aSize, 1);
    this.aAl = attr("aAlpha", this.aAlpha, 1);
    this.aSh = attr("aShape", this.shape, 1);
    this.aSe = attr("aSeed", this.seed, 1);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      name: additive ? "NightHelmFxGlow" : "NightHelmFxMist",
      uniforms: {
        uScale: { value: 800 }, uFogDensity: { value: 0 }, uFogColor: { value: new THREE.Color(0x070b1a) },
        uAdditive: { value: additive ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize, aAlpha, aShape, aSeed;
        uniform float uScale, uFogDensity;
        varying vec3 vColor; varying float vAlpha, vShape, vSeed, vFog;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float depth = max(0.05, -mv.z);
          gl_PointSize = aAlpha <= 0.0 ? 0.0 : clamp(aSize * uScale / depth, 0.0, 512.0);
          vColor = aColor; vAlpha = aAlpha; vShape = aShape; vSeed = aSeed;
          vFog = exp(-uFogDensity * uFogDensity * depth * depth);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAdditive; uniform vec3 uFogColor;
        varying vec3 vColor; varying float vAlpha, vShape, vSeed, vFog;
        ${GLSL_NOISE}
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          if (r2 > 1.0) discard;
          float a;
          if (vShape < 0.5) {
            a = exp(-r2 * 4.5) * 0.75 + exp(-r2 * 30.0) * 0.6;
          } else if (vShape < 1.5) {
            float ang = vSeed * 6.2831853;
            vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
            float spikes = exp(-abs(q.x) * 26.0) * exp(-abs(q.y) * 3.4) + exp(-abs(q.y) * 26.0) * exp(-abs(q.x) * 3.4);
            a = exp(-r2 * 20.0) + 0.85 * spikes * (1.0 - r2);
          } else if (vShape < 2.5) {
            float r = sqrt(r2);
            vec2 h = p - vec2(-0.32, 0.34);
            a = smoothstep(0.6, 0.86, r) * smoothstep(1.0, 0.86, r) + 0.55 * exp(-dot(h, h) * 34.0);
          } else {
            float n = sbNoise(p * 2.4 + vSeed * 31.0) * 0.6 + sbNoise(p * 5.1 - vSeed * 17.0) * 0.4;
            a = exp(-r2 * 2.6) * (0.45 + 0.55 * n) * smoothstep(1.0, 0.7, r2);
          }
          a *= vAlpha;
          if (a < 0.003) discard;
          if (uAdditive > 0.5) gl_FragColor = vec4(vColor * vFog * a, 1.0);
          else gl_FragColor = vec4(mix(uFogColor, vColor, vFog), a);
        }`,
      transparent: true, depthWrite: false, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
    this.points.layers.set(LAYERS.FX);
    this.focal = 1;
    this.points.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(_bufSize).y;
      this.mat.uniforms.uScale.value = h * this.focal;
    };
  }

  // The live particles stay packed in [0, high): a new one goes on the end (a full pool overwrites round a ring) and
  // a dead one is replaced by the last (update). The draw range and the uploads then cover only the live ones — a
  // ring cursor left `high` near the capacity (~3000) once anything sprayed for a while (a waterspout: measured
  // 1775 of 3072 uploaded and drawn every frame with ~300 alive).
  slot() {
    if (this.high < this.n) return this.high++;
    const i = this.cursor;
    this.cursor = (i + 1) % this.n;
    return i;
  }

  /** Move particle `from` into slot `to` (the packing in update). */
  move(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (const a of [this.pos, this.vel, this.col]) { a[t3] = a[f3]; a[t3 + 1] = a[f3 + 1]; a[t3 + 2] = a[f3 + 2]; }
    for (const a of [this.age, this.life, this.size0, this.size1, this.alpha0, this.gravity, this.drag, this.swirl, this.shape, this.seed, this.floor, this.fadeIn]) a[to] = a[from];
  }

  /** One particle: x,y,z, vx,vy,vz, life, size (→ size1), color (HDR), alpha, gravity, drag, swirl, shape, floor, fadeIn. */
  emit(o) {
    const i = this.slot(), i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
    this.col[i3] = o.color.r; this.col[i3 + 1] = o.color.g; this.col[i3 + 2] = o.color.b;
    this.age[i] = 0; this.life[i] = Math.max(0.02, o.life);
    this.size0[i] = o.size; this.size1[i] = o.size1 ?? o.size;
    this.alpha0[i] = o.alpha ?? 1;
    this.gravity[i] = o.gravity || 0; this.drag[i] = o.drag || 0; this.swirl[i] = o.swirl || 0;
    this.shape[i] = o.shape || 0; this.seed[i] = Math.random();
    this.floor[i] = o.floor ?? -1e9;
    this.fadeIn[i] = o.fadeIn ?? 0.06;
    this.aAlpha[i] = 0;
    this.dirtyAll = true;
  }

  update(dt, t) {
    let high = this.high;
    for (let i = 0; i < high;) {
      const i3 = i * 3;
      this.age[i] += dt;
      const life = this.life[i], k = this.age[i] / life;
      if (k >= 1 || this.pos[i3 + 1] < this.floor[i]) {
        // Dead: the last live one takes its slot (and is stepped here next).
        high--;
        if (i < high) this.move(high, i);
        this.aAlpha[high] = 0;
        continue;
      }
      const sw = this.swirl[i];
      if (sw) {
        const s = this.seed[i] * 40;
        this.vel[i3] += Math.sin(t * 1.7 + s) * sw * dt;
        this.vel[i3 + 2] += Math.cos(t * 1.3 + s * 1.3) * sw * dt;
      }
      this.vel[i3 + 1] -= this.gravity[i] * dt;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= d; this.vel[i3 + 1] *= d; this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const fin = this.fadeIn[i] > 0 ? Math.min(1, k / this.fadeIn[i]) : 1;
      this.aAlpha[i] = this.alpha0[i] * fin * (1 - k) * (1 - k * 0.35);
      this.aSize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * k;
      i++;
    }
    this.high = high;
    this.geo.setDrawRange(0, high);
    if (high > 0 || this.dirtyAll) {
      for (const a of [this.aPos, this.aSz, this.aAl, this.aCol, this.aSh, this.aSe]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, high) * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirtyAll = high > 0;
    }
  }

  get live() { return this.high; }
}

// ---- Foam rings ------------------------------------------------------------------------

function makeFoamRing() {
  const mat = new THREE.ShaderMaterial({
    name: "NightHelmFoamRing",
    uniforms: { uT: { value: 1 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0.34, 0.45, 0.52) }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uAlpha, uSeed; uniform vec3 uColor; varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p), ang = atan(p.y, p.x);
        float t = clamp(uT, 0.0, 1.0);
        float R = mix(0.12, 0.9, 1.0 - pow(1.0 - t, 2.6));
        float w = mix(0.05, 0.17, t);
        float n = sbNoise(vec2(ang * 3.1 + uSeed * 10.0, r * 7.0 - t * 2.0));
        float m = sbNoise(vec2(ang * 9.0 - uSeed * 4.0, r * 13.0 + t));
        float ring = smoothstep(w, 0.0, abs(r - R - (n - 0.5) * 0.08));
        float churn = smoothstep(R, R * 0.2, r) * 0.3 * (1.0 - t) * m;
        float a = (ring * (0.45 + 0.7 * m) + churn) * uAlpha * (1.0 - t) * smoothstep(1.0, 0.94, r);
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * (0.8 + 0.4 * n), a);
      }`,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.renderOrder = 10;
  mesh.layers.set(LAYERS.FX);
  return { mesh, mat, geo, t: 1, dur: 3, busy: false };
}

/** A camera-facing HDR glow (the flare's star). */
function glowSprite(color, size) {
  const u = { uI: { value: 0 }, uSize: { value: size }, uColor: { value: new THREE.Color(color) } };
  const mat = new THREE.ShaderMaterial({
    name: "NightHelmFlareStar", uniforms: u, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uSize; varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uSize;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uI; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        float v = exp(-r2 * 220.0) * 6.0 + exp(-r2 * 26.0) * 0.9 + exp(-r2 * 4.0) * 0.18;
        v += (exp(-abs(p.y) * 70.0) * exp(-abs(p.x) * 3.0)) * 0.35;
        gl_FragColor = vec4(uColor * v * uI * smoothstep(1.0, 0.7, r2), 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 13;
  m.layers.set(LAYERS.FX);
  return { mesh: m, u };
}

// ---- The FX system -----------------------------------------------------------------------

/**
 * Build every pooled effect and add it to the scene.
 * @param {object} R  the render context: scene, camera, renderer, shipSpace, onFrame, water.
 */
export function createFx(R) {
  const scene = R?.scene;
  const root = new THREE.Group();
  root.name = "fx";
  scene?.add(root);
  const glow = new Pool(4096, true);
  const mist = new Pool(3072, false);
  root.add(mist.points, glow.points);

  const foams = Array.from({ length: 24 }, makeFoamRing);
  for (const f of foams) root.add(f.mesh);

  // The flare: star sprite + light. The light stays in the scene at 0 (adding or
  // removing a light would recompile every lit material).
  const star = glowSprite(FLARE.clone().multiplyScalar(1.6), 9);
  star.mesh.visible = false;
  root.add(star.mesh);
  const flareLight = new THREE.PointLight(0xffc890, 0, 260, 2);
  flareLight.name = "flare-light";
  flareLight.castShadow = false;
  scene?.add(flareLight);
  let flareRun = null;
  let flareLevel = 0;

  // Floating crates.
  const CRATES = 16;
  const crateGeo = new THREE.BoxGeometry(0.86, 0.86, 0.86);
  const crateMat = new THREE.MeshStandardMaterial({ name: "nh-crate-float", color: "#7a5634", roughness: 0.78, metalness: 0, envMapIntensity: 0.4 });
  const crateMesh = new THREE.InstancedMesh(crateGeo, crateMat, CRATES);
  crateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  crateMesh.frustumCulled = false;
  crateMesh.count = 0;
  crateMesh.name = "fx.crates";
  root.add(crateMesh);
  const crates = Array.from({ length: CRATES }, () => ({ alive: false, x: 0, z: 0, vx: 0, vz: 0, y: 0, vy: 0, age: 0, life: 40, spin: 0, rx: 0, rz: 0, yaw: 0 }));
  const _sw = { h: 0, dx: 0, dz: 0 };
  // Night Raid: flotsam from sinking ships and smashed boats (planks and barrels), the same drift as the crates.
  const FLOT = 48;
  const plankGeo = new THREE.BoxGeometry(0.45, 0.16, 2.6);
  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 10);
  barrelGeo.rotateZ(Math.PI / 2);
  const flotMat = new THREE.MeshStandardMaterial({ name: "nr-flotsam", color: "#5e4128", roughness: 0.85, metalness: 0, envMapIntensity: 0.3 });
  const flotMeshes = [plankGeo, barrelGeo].map((g, i) => {
    const m = new THREE.InstancedMesh(g, flotMat, FLOT);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.name = i ? "fx.barrels" : "fx.planks";
    root.add(m);
    return m;
  });
  const flots = Array.from({ length: FLOT * 2 }, (_, i) => ({ kind: i % 2, alive: false, x: 0, z: 0, vx: 0, vz: 0, y: 0, vy: 0, age: 0, life: 40, spin: 0, rx: 0, rz: 0, yaw: 0 }));

  const trails = new Set();
  const emitters = new Set();
  let embersOn = true, emberAcc = 0;
  let speed = 1, time = 0;
  const camPos = new THREE.Vector3();
  const lanternLocal = new THREE.Vector3().fromArray(B.RAIL_LANTERN);

  /** The rail lantern's flame in world space (it rides the ship). */
  const lanternWorld = (out) => {
    out.copy(lanternLocal);
    out.y += 0.02;
    return R?.shipSpace ? R.shipSpace.localToWorld(out) : out;
  };

  /** Size/speed factor so an effect reads the same at any distance (1 at 10 m). */
  const scaleAt = (pos) => clamp(camPos.distanceTo(pos) / 10, 0.15, 90);

  // ---- One-shot effects ------------------------------------------------------------------

  function burst(pos, { color = GILT, count = 40, speed: sp = 2.4, size = 0.22, life = 1.2, gravity = 0.6, intensity = 2.6, scale = null } = {}) {
    if (!pos) return;
    const k = scale ?? scaleAt(pos);
    const n = clamp(Math.round(count), 1, 80);
    const c = hdr(color, intensity).clone();
    glow.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.45, size: size * 6 * k, size1: size * 10 * k, color: c, alpha: 0.9, shape: SHAPE.glow, fadeIn: 0 });
    glow.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.7, size: size * 3 * k, size1: size * 1.5 * k, color: c, alpha: 1, shape: SHAPE.glint, fadeIn: 0 });
    for (let i = 0; i < n; i++) {
      const d = _v.randomDirection();
      const v = sp * k * rand(0.35, 1.0);
      glow.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: d.x * v, vy: d.y * v + sp * k * 0.15, vz: d.z * v,
        life: life * rand(0.6, 1.25), size: size * k * rand(0.6, 1.4), size1: 0,
        color: c, alpha: 1, gravity: gravity * k, drag: 1.6, shape: i % 3 === 0 ? SHAPE.glint : SHAPE.glow, fadeIn: 0.02,
      });
    }
  }

  function sparks(pos, { color = "#ffd88a", count = 24, speed: sp = 3.4, scale = null } = {}) {
    if (!pos) return;
    const k = scale ?? scaleAt(pos);
    const c = hdr(color, 3).clone();
    for (let i = 0; i < Math.min(80, count); i++) {
      const d = _v.randomDirection();
      d.y = Math.abs(d.y) * 0.8 + 0.2;
      const v = sp * k * rand(0.5, 1.1);
      glow.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: d.x * v, vy: d.y * v, vz: d.z * v,
        life: rand(0.35, 0.75), size: 0.07 * k * rand(0.7, 1.3), size1: 0.02 * k,
        color: c, gravity: 9.8 * k * 0.4, drag: 2.2, shape: SHAPE.glint, fadeIn: 0,
      });
    }
  }

  function trail(from, to, dur = 1.2, { color = GILT, lift = null, size = 0.13, intensity = 3, burst: endBurst = true, onProgress = null } = {}) {
    if (!from || !to) return Promise.resolve();
    const a = from.clone(), b = to.clone();
    const dist = a.distanceTo(b);
    const ctrl = a.clone().lerp(b, 0.5).addScaledVector(new THREE.Vector3(0, 1, 0), lift ?? dist * 0.22);
    return new Promise((resolve) => {
      const tr = {
        a, b, ctrl, dur: Math.max(0.05, dur), t: 0, last: a.clone(), color: hdr(color, intensity).clone(), size,
        onProgress, endBurst, color0: color, done: false,
        resolve: () => { if (!tr.done) { tr.done = true; trails.delete(tr); clearTimeout(tr.guard); resolve(); } },
      };
      tr.guard = setTimeout(() => tr.resolve(), (tr.dur / Math.max(0.01, speed)) * 1000 + 1500);
      trails.add(tr);
    });
  }

  function bezier(tr, k, out) {
    const u = 1 - k;
    return out.copy(tr.a).multiplyScalar(u * u).addScaledVector(tr.ctrl, 2 * u * k).addScaledVector(tr.b, k * k);
  }

  function updateTrail(tr, dt) {
    tr.t += dt;
    const k = Math.min(1, tr.t / tr.dur);
    const head = bezier(tr, tr.linear ? k : smoother(k), _w);
    const sc = scaleAt(head);
    const step = 0.06 * sc;
    const moved = tr.last.distanceTo(head);
    const n = Math.min(24, Math.max(1, Math.ceil(moved / step)));
    for (let i = 1; i <= n; i++) {
      _v.copy(tr.last).lerp(head, i / n);
      const j = 0.04 * sc;
      glow.emit({
        x: _v.x + rand(-j, j), y: _v.y + rand(-j, j), z: _v.z + rand(-j, j),
        vx: rand(-0.1, 0.1) * sc, vy: rand(-0.12, 0.05) * sc, vz: rand(-0.1, 0.1) * sc,
        life: rand(0.45, 0.9), size: tr.size * sc * rand(0.7, 1.2), size1: 0,
        color: tr.color, alpha: 0.9, shape: Math.random() < 0.18 ? SHAPE.glint : SHAPE.glow, drag: 1.2, fadeIn: 0,
      });
    }
    glow.emit({ x: head.x, y: head.y, z: head.z, life: 0.05, size: tr.size * sc * 4, size1: tr.size * sc * 4, color: tr.color, shape: SHAPE.glint, fadeIn: 0 });
    tr.last.copy(head);
    tr.onProgress?.(k, head);
    if (k >= 1) {
      if (tr.endBurst) burst(tr.b, { color: tr.color0, count: 26, speed: 1.4, size: 0.12, life: 0.8 });
      tr.resolve();
    }
  }

  // ---- Water: splashes, foam, bubbles, sheeting --------------------------------------------

  function foam(pos, { radius = 4, life = 3.4, alpha = 0.9 } = {}) {
    if (!pos) return;
    const f = foams.find((x) => !x.busy) || foams.reduce((a, b) => (a.t > b.t ? a : b));
    f.busy = true; f.t = 0; f.dur = life;
    f.mesh.position.set(pos.x, WATER_Y + 0.05, pos.z);
    f.mesh.scale.setScalar(radius);
    f.mat.uniforms.uSeed.value = Math.random();
    f.mat.uniforms.uAlpha.value = alpha;
    f.mat.uniforms.uT.value = 0;
    f.mesh.visible = true;
  }

  function splash(pos, { scale = 1 } = {}) {
    if (!pos) return;
    const y = Math.max(pos.y, WATER_Y);
    const spray = hdr(SPRAY, 0.75).clone();
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0, 0.8) * scale;
      const up = rand(2.5, 6) * Math.sqrt(scale);
      mist.emit({
        x: pos.x + Math.cos(a) * r, y, z: pos.z + Math.sin(a) * r,
        vx: Math.cos(a) * rand(0.5, 2.2) * scale, vy: up, vz: Math.sin(a) * rand(0.5, 2.2) * scale,
        life: rand(0.9, 1.7), size: 0.5 * scale, size1: 1.6 * scale, color: spray, alpha: 0.5,
        gravity: 7.5, drag: 0.7, shape: SHAPE.puff, floor: WATER_Y - 0.2, fadeIn: 0.05,
      });
    }
    const drop = hdr(MOONLIT, 1.4).clone();
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(1, 3.4) * scale;
      glow.emit({
        x: pos.x, y: y + 0.2, z: pos.z, vx: Math.cos(a) * v, vy: rand(3.5, 8.5) * Math.sqrt(scale), vz: Math.sin(a) * v,
        life: rand(1.0, 1.8), size: 0.16 * scale, size1: 0.07 * scale, color: drop, alpha: 0.85,
        gravity: 9.8, drag: 0.25, shape: i % 2 ? SHAPE.glint : SHAPE.glow, floor: WATER_Y, fadeIn: 0,
      });
    }
    foam(pos, { radius: 3.2 * scale, life: 3.6 });
  }

  /** Bow spray: a sheet of mist off the stem as she buries her bow in a swell. */
  function spray(pos, { dirX = 0, dirZ = 1, amount = 1 } = {}) {
    if (!pos) return;
    const c = hdr(SPRAY, 0.6).clone();
    const n = Math.round(10 * amount);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const sx = -dirZ * side, sz = dirX * side;      // out to either side of the stem
      const v = rand(1.5, 4.5) * amount;
      mist.emit({
        x: pos.x + rand(-0.4, 0.4), y: pos.y, z: pos.z + rand(-0.4, 0.4),
        vx: sx * v + dirX * rand(0, 1.5), vy: rand(1.5, 4.0) * amount, vz: sz * v + dirZ * rand(0, 1.5),
        life: rand(0.7, 1.3), size: 0.4, size1: 1.4, color: c, alpha: 0.32,
        gravity: 6, drag: 0.8, shape: SHAPE.puff, floor: WATER_Y - 0.2, fadeIn: 0.05,
      });
    }
  }

  function sheet(pos, { count = 14, radius = 1.2 } = {}) {
    if (!pos) return;
    const drop = hdr(MOONLIT, 1.2).clone();
    const veil = hdr(SPRAY, 0.5).clone();
    for (let i = 0; i < Math.min(60, count); i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.2, 1) * radius;
      glow.emit({
        x: pos.x + Math.cos(a) * r, y: pos.y + rand(-0.3, 0.3), z: pos.z + Math.sin(a) * r,
        vx: Math.cos(a) * rand(0.1, 0.6), vy: rand(-0.5, 0.6), vz: Math.sin(a) * rand(0.1, 0.6),
        life: rand(0.9, 1.8), size: 0.12, size1: 0.05, color: drop, gravity: 9.8, drag: 0.4,
        shape: SHAPE.glint, floor: WATER_Y, fadeIn: 0,
      });
      if (i % 3 === 0) {
        mist.emit({
          x: pos.x + Math.cos(a) * r, y: pos.y, z: pos.z + Math.sin(a) * r, vy: -rand(0.5, 1.5),
          life: rand(0.8, 1.4), size: 0.35, size1: 0.8, color: veil, alpha: 0.28, gravity: 4, drag: 0.6,
          shape: SHAPE.puff, floor: WATER_Y - 0.3,
        });
      }
    }
  }

  /** A hard hit: splinters and spray thrown off the hull at a world point. */
  function splinters(pos, { count = 22, scale = 1 } = {}) {
    if (!pos) return;
    const c = SPLINTER.clone();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(1.5, 5) * scale;
      mist.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: Math.cos(a) * v, vy: rand(2, 6) * scale, vz: Math.sin(a) * v,
        life: rand(0.9, 1.6), size: rand(0.12, 0.3) * scale, size1: 0.1 * scale, color: c, alpha: 0.95,
        gravity: 9.8, drag: 0.4, shape: SHAPE.puff, floor: WATER_Y, fadeIn: 0,
      });
    }
    sparks(pos, { color: "#ffd8a0", count: 10, speed: 2.4 });
  }

  /**
   * A hole in the hull spouting: water forced up through the planks in
   * pulses. Call every frame while it's open; `dt` scales how much comes out.
   */
  function jet(pos, dt, { amount = 1, up = null } = {}) {
    if (!pos) return;
    const rate = 48 * amount;
    const n = Math.floor(rate * dt + Math.random());
    if (n <= 0) return;
    const ux = up?.x ?? 0, uy = up?.y ?? 1, uz = up?.z ?? 0;
    const pulse = 0.65 + 0.35 * Math.sin(time * 9 + pos.x * 3);
    const drop = hdr(MOONLIT, 1.1).clone();
    const veil = hdr(SPRAY, 0.55).clone();
    for (let i = 0; i < n; i++) {
      const v = rand(2.2, 4.6) * pulse * Math.sqrt(amount);
      const sx = rand(-0.9, 0.9), sz = rand(-0.9, 0.9);
      glow.emit({
        x: pos.x + rand(-0.2, 0.2), y: pos.y + 0.05, z: pos.z + rand(-0.2, 0.2),
        vx: ux * v + sx, vy: uy * v, vz: uz * v + sz,
        life: rand(0.5, 0.95), size: rand(0.07, 0.14), size1: 0.04, color: drop, alpha: 0.95,
        gravity: 9.8, drag: 0.3, shape: Math.random() < 0.4 ? SHAPE.glint : SHAPE.glow, fadeIn: 0,
      });
      if (i % 2 === 0) {
        mist.emit({
          x: pos.x, y: pos.y + 0.1, z: pos.z, vx: ux * v * 0.5 + sx * 0.5, vy: uy * v * 0.6, vz: uz * v * 0.5 + sz * 0.5,
          life: rand(0.6, 1.0), size: 0.25, size1: 0.9, color: veil, alpha: 0.45, gravity: 5, drag: 0.8, shape: SHAPE.puff, fadeIn: 0.05,
        });
      }
    }
  }

  /**
   * A cannon shot from `from` (the gun's muzzle, world) at `to`: a flash and a
   * gout of smoke at the gun, an ember-trailed ball on a flat arc, then a hit
   * (sparks, splinters or ink, a big splash) or a miss (a plume where it lands).
   * Resolves when it lands.
   * @param {THREE.Vector3} from @param {THREE.Vector3} to
   * @param {{hit?: boolean, onLand?: () => void, ink?: boolean}} [opts]
   */
  function cannon(from, to, { hit = true, onLand = null, ink = false } = {}) {
    if (!from || !to) return Promise.resolve();
    const dir = _w.subVectors(to, from).setY(0).normalize();
    // The muzzle: a hot flash and a ring of smoke rolling out along the shot.
    burst(from, { color: "#ffb04a", count: 40, speed: 6, size: 0.5, life: 0.35, gravity: 0, intensity: 6, scale: 1 });
    glow.emit({ x: from.x, y: from.y, z: from.z, life: 0.12, size: 3.5, size1: 6, color: hdr("#ffd27a", 8).clone(), alpha: 1, shape: SHAPE.glow, fadeIn: 0 });
    const smoke = new THREE.Color(0.4, 0.4, 0.44);
    for (let i = 0; i < 26; i++) {
      const v = rand(1, 6);
      mist.emit({
        x: from.x + dir.x * 0.5, y: from.y, z: from.z + dir.z * 0.5,
        vx: dir.x * v + rand(-0.8, 0.8), vy: rand(0, 1.2), vz: dir.z * v + rand(-0.8, 0.8),
        life: rand(1.4, 2.6), size: 0.6, size1: rand(2.2, 3.6), color: smoke, alpha: 0.42, swirl: 0.4, drag: 1.3, shape: SHAPE.puff, fadeIn: 0.04,
      });
    }
    R?.cam?.fovKick?.(-1.5);
    const dist = from.distanceTo(to);
    return trail(from, to, clamp(dist / 140, 0.35, 1.1), { color: "#ff9a4a", lift: Math.max(2, dist * 0.08), size: 0.16, intensity: 4, burst: false }).then(() => {
      if (hit) {
        burst(to, { color: ink ? "#3ff3e0" : "#ffcf6b", count: 60, speed: 5, size: 0.45, life: 1.1, intensity: 4 });
        sparks(to, { color: "#ffd88a", count: 30, speed: 5 });
        if (!ink) splinters(to, { count: 26, scale: 1.3 });
        splash(_v.set(to.x, WATER_Y, to.z), { scale: 1.8 });
      } else {
        splash(_v.set(to.x, WATER_Y, to.z), { scale: 1.4 });
      }
      try { onLand?.(); } catch (e) { console.debug("[night-raid] fx: cannon onLand threw", e); }
    });
  }

  // ---- Night Raid: guns, fire, the Gloam's mist ------------------------------------------------

  /**
   * One gun going off at `pos` (world) toward `dir` (world, unit): a white-hot flash, a tongue of
   * flame along the bore, sparks, and a bank of smoke rolling out and up, lit orange at first.
   * @param {THREE.Vector3} pos @param {THREE.Vector3} dir @param {{scale?: number, smoke?: number}} [o]
   */
  function muzzle(pos, dir, { scale = 1, smoke = 1 } = {}) {
    if (!pos) return;
    const k = scale;
    const dx = dir?.x ?? 0, dy = dir?.y ?? 0, dz = dir?.z ?? 1;
    glow.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.09, size: 5 * k, size1: 8 * k, color: hdr("#fff1c8", 9).clone(), alpha: 1, shape: SHAPE.glow, fadeIn: 0 });
    const fire = hdr("#ff9a3a", 6).clone();
    for (let i = 0; i < 16; i++) {
      const v = rand(10, 34) * k;
      glow.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: dx * v + rand(-2, 2), vy: dy * v + rand(-1.5, 2.5), vz: dz * v + rand(-2, 2),
        life: rand(0.12, 0.3), size: rand(0.9, 1.8) * k, size1: rand(1.8, 3) * k, color: fire, alpha: 1, drag: 5, shape: SHAPE.glow, fadeIn: 0,
      });
    }
    sparks(pos, { color: "#ffcf8a", count: 10, speed: 7 * k, scale: 1 });
    const n = Math.round(14 * clamp(smoke, 0.2, 1.5));
    // Night smoke: dark grey, faintly moonlit; the first puffs lit by the flash die fast.
    for (let i = 0; i < n; i++) {
      const v = rand(3, 13) * k;
      const lit = i < 2;
      mist.emit({
        x: pos.x + dx * 0.6, y: pos.y, z: pos.z + dz * 0.6,
        vx: dx * v + rand(-1, 1), vy: rand(0.2, 1.8), vz: dz * v + rand(-1, 1),
        life: lit ? rand(0.5, 0.8) : rand(3.5, 7), size: 1.4 * k, size1: (lit ? 4 : rand(5, 9)) * k, color: lit ? SMOKE_LIT : smokeColor(), alpha: lit ? 0.4 : 0.34 + 0.12 * dayK(), swirl: 0.5, drag: 1.1, gravity: -0.12, shape: SHAPE.puff, fadeIn: 0.03,
      });
    }
  }

  // ---- Rexmaw Raids: juice ---------------------------------------------------------------------
  const SMOKE_DAY = new THREE.Color(0.78, 0.77, 0.74);
  const _smoke = new THREE.Color();
  const dayK = () => clamp(R?.atmos?.day || 0, 0, 1);
  /** Powder smoke: dark by night, the white of black powder by day. */
  function smokeColor() { return _smoke.copy(SMOKE_GREY).lerp(SMOKE_DAY, dayK()).clone(); }

  /** A smoke ring rolling out of a muzzle along `dir`: a ring of puffs expanding round the bore. */
  function smokeRing(pos, dir, { scale = 1 } = {}) {
    if (!pos || !dir) return;
    const k = scale;
    const d = _v.copy(dir).normalize();
    const a = Math.abs(d.y) < 0.9 ? _w.set(0, 1, 0) : _w.set(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(d, a).normalize(), w = new THREE.Vector3().crossVectors(d, u);
    const col = smokeColor();
    const n = R?.quality?.tier === "low" ? 8 : 14;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const rx = Math.cos(t), ry = Math.sin(t);
      const ox = u.x * rx + w.x * ry, oy = u.y * rx + w.y * ry, oz = u.z * rx + w.z * ry;
      const fwd = rand(5, 7) * k;
      mist.emit({
        x: pos.x + d.x * 1.2 * k + ox * 0.4 * k, y: pos.y + d.y * 1.2 * k + oy * 0.4 * k, z: pos.z + d.z * 1.2 * k + oz * 0.4 * k,
        vx: d.x * fwd + ox * 2.4 * k, vy: d.y * fwd + oy * 2.4 * k + 0.3, vz: d.z * fwd + oz * 2.4 * k,
        life: rand(1.6, 2.4), size: 0.7 * k, size1: 2.2 * k, color: col, alpha: 0.4, drag: 1.9, gravity: -0.1, shape: SHAPE.puff, fadeIn: 0.02,
      });
    }
  }

  /**
   * Water sheeting off the bow at speed: two fans of spray thrown out and up from the bow cheeks
   * (`side` = the ship's port normal), and a veil blown back over the forecastle when she digs in.
   * Call per frame; `rate` 0..1.5 scales it (speed, the sprint).
   */
  function bowWater(pos, fwdX, fwdZ, sideX, sideZ, dt, { rate = 1, over = 0, shipVX = 0, shipVZ = 0 } = {}) {
    if (!pos || !(rate > 0)) return;
    const n = Math.floor(rate * dt * (R?.quality?.tier === "low" ? 30 : 60) + Math.random());
    const veil = hdr(SPRAY, 0.6 + 0.4 * dayK()).clone();
    const drop = hdr(MOONLIT, 1.1 + 0.6 * dayK()).clone();
    for (let i = 0; i < n; i++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const out = rand(2.5, 6) * rate, up = rand(1.5, 4.5) * rate;
      const back = rand(-1, 0.5);
      const x = pos.x + sideX * s * rand(0.6, 1.4), z = pos.z + sideZ * s * rand(0.6, 1.4);
      mist.emit({
        x, y: pos.y + rand(-0.2, 0.3), z,
        vx: shipVX + sideX * s * out + fwdX * back, vy: up, vz: shipVZ + sideZ * s * out + fwdZ * back,
        life: rand(0.7, 1.3), size: 0.5, size1: 1.8, color: veil, alpha: 0.3, gravity: 7, drag: 0.9, shape: SHAPE.puff, floor: WATER_Y - 0.2, fadeIn: 0.04,
      });
      if (i % 2 === 0) {
        glow.emit({
          x, y: pos.y, z, vx: shipVX + sideX * s * out * 1.2, vy: up * 1.3, vz: shipVZ + sideZ * s * out * 1.2,
          life: rand(0.6, 1.1), size: 0.12, size1: 0.05, color: drop, gravity: 9.8, drag: 0.3, shape: SHAPE.glint, floor: WATER_Y, fadeIn: 0,
        });
      }
    }
    // Over the bow: a veil blown back along the deck (the ship's velocity minus the wind of her passage).
    const m = Math.floor(over * dt * 40 + Math.random() * over);
    for (let i = 0; i < m; i++) {
      mist.emit({
        x: pos.x + rand(-1.5, 1.5), y: pos.y + rand(1.5, 3), z: pos.z + rand(-1.5, 1.5),
        vx: shipVX * 0.55 + rand(-1, 1), vy: rand(1.5, 3.5), vz: shipVZ * 0.55 + rand(-1, 1),
        life: rand(0.9, 1.5), size: 0.6, size1: 2.4, color: veil, alpha: 0.35, gravity: 5, drag: 0.4, shape: SHAPE.puff, floor: WATER_Y - 0.2, fadeIn: 0.03,
      });
    }
  }

  /** One mote of a cannonball's trail (burning wad, a thread of smoke). */
  function trailMote(pos, color, k = 1) {
    // Sized with the distance (a ball 300 m off must still read as a spark streaking in).
    const sc = clamp(camPos.distanceTo(pos) / 60, 1, 6);
    glow.emit({ x: pos.x, y: pos.y, z: pos.z, vx: rand(-0.2, 0.2), vy: rand(-0.1, 0.2), vz: rand(-0.2, 0.2), life: rand(0.2, 0.35), size: 0.4 * k * sc, size1: 0.08 * k * sc, color: hdr(color, 3.2).clone(), alpha: 0.9, shape: SHAPE.glow, fadeIn: 0 });
    if (Math.random() < 0.3) mist.emit({ x: pos.x, y: pos.y, z: pos.z, vy: rand(0, 0.4), life: rand(0.8, 1.4), size: 0.3 * k, size1: 1.2 * k, color: TRAIL_SMOKE, alpha: 0.22, drag: 0.8, shape: SHAPE.puff, fadeIn: 0.05 });
  }

  /** A burst of embers drifting up from `pos` (a fire ship, a burning deck). */
  function embers(pos, { count = 3 } = {}) {
    if (!pos) return;
    for (let i = 0; i < count; i++) {
      glow.emit({
        x: pos.x + rand(-0.5, 0.5), y: pos.y, z: pos.z + rand(-0.5, 0.5), vx: rand(-0.6, 0.6), vy: rand(1.5, 4), vz: rand(-0.6, 0.6),
        life: rand(1.2, 2.6), size: rand(0.08, 0.16), size1: 0.02, color: hdr("#ff8a3a", rand(3, 6)).clone(), gravity: -0.3, drag: 0.6, swirl: 1.2, shape: SHAPE.glow, fadeIn: 0.05,
      });
    }
  }

  /** The Gloam's mist: a slow, cold, faintly teal puff (thick while she cloaks). */
  function ghostMist(pos, { thick = false } = {}) {
    if (!pos) return;
    mist.emit({
      x: pos.x, y: Math.max(pos.y, WATER_Y + 0.5), z: pos.z, vx: rand(-0.6, 0.6), vy: rand(0.05, 0.4), vz: rand(-0.6, 0.6),
      life: rand(5, 9), size: thick ? 6 : 3, size1: thick ? 16 : 9, color: new THREE.Color(0.42, 0.56, 0.55), alpha: thick ? 0.5 : 0.28, swirl: 0.3, drag: 0.3, shape: SHAPE.puff, fadeIn: 0.2,
    });
  }

  /** A fire going out: a gout of steam and dark smoke. */
  function steam(pos) {
    if (!pos) return;
    for (let i = 0; i < 10; i++) {
      mist.emit({
        x: pos.x + rand(-0.4, 0.4), y: pos.y, z: pos.z + rand(-0.4, 0.4), vx: rand(-0.4, 0.4), vy: rand(1.5, 3.2), vz: rand(-0.4, 0.4),
        life: rand(1.6, 3), size: 0.6, size1: rand(2.5, 4), color: new THREE.Color(0.62, 0.64, 0.68), alpha: 0.42, swirl: 0.5, drag: 0.8, shape: SHAPE.puff, fadeIn: 0.05,
      });
    }
  }

  /** A powder blast (a fire ship going up, a magazine): flash, fireball, a column of smoke, flotsam. */
  function explosion(pos, { scale = 1 } = {}) {
    if (!pos) return;
    const k = scale;
    glow.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.25, size: 18 * k, size1: 30 * k, color: hdr("#fff0c0", 10).clone(), alpha: 1, shape: SHAPE.glow, fadeIn: 0 });
    for (let i = 0; i < 70; i++) {
      const d = _v.randomDirection();
      const v = rand(6, 22) * k;
      glow.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: d.x * v, vy: Math.abs(d.y) * v + 3, vz: d.z * v, life: rand(0.4, 1.1), size: rand(1.5, 3.5) * k, size1: rand(3, 6) * k,
        color: hdr(i % 3 ? "#ff8a2a" : "#ffd27a", 5).clone(), alpha: 1, drag: 2.6, gravity: -1, shape: SHAPE.glow, fadeIn: 0,
      });
    }
    for (let i = 0; i < 40; i++) {
      mist.emit({
        x: pos.x + rand(-2, 2), y: pos.y + rand(0, 3), z: pos.z + rand(-2, 2), vx: rand(-4, 4), vy: rand(3, 10), vz: rand(-4, 4),
        life: rand(4, 8), size: 3 * k, size1: rand(9, 16) * k, color: new THREE.Color(0.18, 0.17, 0.17), alpha: 0.6, swirl: 0.4, drag: 0.9, gravity: -0.2, shape: SHAPE.puff, fadeIn: 0.05,
      });
    }
    sparks(pos, { color: "#ffd27a", count: 60, speed: 12 * k, scale: 1 });
    flotsam(pos, { n: 6 });
    splash(_w.set(pos.x, WATER_Y, pos.z), { scale: 3 * k });
  }

  /** Bailing: a sheet of water thrown over the rail at `pos` (world), outboard along (dirX, dirZ). */
  function sluice(pos, { dirX = 1, dirZ = 0, amount = 1 } = {}) {
    if (!pos) return;
    const drop = hdr(MOONLIT, 1.0).clone();
    const veil = hdr(SPRAY, 0.6).clone();
    for (let i = 0; i < 40 * amount; i++) {
      const v = rand(1.5, 3.5);
      glow.emit({
        x: pos.x + rand(-0.4, 0.4), y: pos.y, z: pos.z + rand(-0.4, 0.4), vx: dirX * v, vy: rand(0.5, 2.5), vz: dirZ * v,
        life: rand(0.8, 1.3), size: 0.1, size1: 0.05, color: drop, gravity: 9.8, drag: 0.2, shape: SHAPE.glint, floor: WATER_Y, fadeIn: 0,
      });
      if (i % 3 === 0) mist.emit({ x: pos.x, y: pos.y, z: pos.z, vx: dirX * v * 0.8, vy: rand(0.4, 1.6), vz: dirZ * v * 0.8, life: rand(0.8, 1.2), size: 0.3, size1: 1.0, color: veil, alpha: 0.4, gravity: 7, drag: 0.4, shape: SHAPE.puff, floor: WATER_Y, fadeIn: 0.05 });
    }
  }

  function bubbles(pos, { seconds = 2.5, radius = 3 } = {}) {
    if (!pos) return;
    emitters.add({ kind: "bubbles", pos: pos.clone(), until: time + seconds, acc: 0, radius });
  }

  function snuff(pos = null) {
    const p = pos ? pos.clone() : lanternWorld(new THREE.Vector3());
    embersOn = false;
    const smoke = new THREE.Color(0.32, 0.34, 0.4);
    for (let i = 0; i < 16; i++) {
      mist.emit({
        x: p.x + rand(-0.03, 0.03), y: p.y + rand(0, 0.05), z: p.z + rand(-0.03, 0.03),
        vx: rand(-0.12, 0.12), vy: rand(0.25, 0.6), vz: rand(-0.12, 0.12),
        life: rand(2.2, 3.6), size: 0.05, size1: rand(0.35, 0.6), color: smoke, alpha: 0.38,
        swirl: 0.35, drag: 0.25, shape: SHAPE.puff, fadeIn: 0.1,
      });
    }
  }

  // ---- The flare ---------------------------------------------------------------------------

  /**
   * Fire a flare from `from` (world; default the rail lantern), arcing up and
   * ahead to ~70 m, then burning 8 s under its parachute. Resolves when it
   * goes out. `onBurst` fires when the star kindles.
   * @param {{from?: THREE.Vector3, ahead?: THREE.Vector3, burn?: number, onBurst?: () => void}} [opts]
   */
  function flare({ from = null, ahead = null, burn = 8, onBurst = null } = {}) {
    flareRun?.resolve();
    const a = from ? from.clone() : lanternWorld(new THREE.Vector3());
    const fwd = ahead ? ahead.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const top = a.clone().addScaledVector(fwd, 38).setY(a.y + 66);
    return new Promise((resolve) => {
      const run = {
        t: 0, burn, top, done: false, fwd, onBurst,
        resolve: () => {
          if (run.done) return;
          run.done = true; clearTimeout(run.guard);
          star.mesh.visible = false; star.u.uI.value = 0; flareLight.intensity = 0; flareLevel = 0;
          if (R.atmos) R.atmos.tintK = 0;
          if (flareRun === run) flareRun = null;
          resolve();
        },
      };
      run.guard = setTimeout(() => run.resolve(), ((1.7 + burn) / Math.max(0.01, speed)) * 1000 + 2500);
      flareRun = run;
      const tr = trail(a, top, 1.7, { color: "#ffb26b", lift: 6, size: 0.16, intensity: 4, burst: false });
      tr.then(() => {
        if (run.done) return;
        run.lit = true;
        star.mesh.position.copy(top);
        star.mesh.visible = true;
        burst(top, { color: "#ffe2b0", count: 50, speed: 3.2, size: 0.4, life: 1.3, intensity: 3.4 });
        try { run.onBurst?.(); } catch (e) { console.debug("[night-raid] fx: onBurst threw", e); }
      });
    });
  }

  function updateFlare(dt) {
    const run = flareRun;
    if (!run || !run.lit) return;
    run.t += dt;
    const t = run.t, T = run.burn;
    if (t >= T) { run.resolve(); return; }
    // Kindle over 0.4 s, burn with a sputter, gutter over the last 1.2 s.
    const k = Math.min(1, t / 0.4) * (1 - THREE.MathUtils.smoothstep(t, T - 1.2, T));
    const sputter = 0.86 + 0.08 * Math.sin(t * 23.0) * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 41.0);
    flareLevel = k;
    star.u.uI.value = 2.2 * k * sputter;
    star.mesh.position.y = run.top.y - t * 3.2;                // sinking under its parachute
    star.mesh.position.x += run.fwd.x * dt * 1.2;
    star.mesh.position.z += run.fwd.z * dt * 1.2;
    flareLight.position.copy(star.mesh.position);
    flareLight.intensity = 4000 * k * sputter;
    if (R.atmos) R.atmos.tintK = 0.28 * k;
    // Drips of burning stuff.
    if (Math.random() < dt * 14) {
      const p = star.mesh.position;
      glow.emit({
        x: p.x + rand(-0.3, 0.3), y: p.y - 0.4, z: p.z + rand(-0.3, 0.3), vx: rand(-0.5, 0.5), vy: rand(-2, -0.5), vz: rand(-0.5, 0.5),
        life: rand(0.8, 1.6), size: 0.35, size1: 0.05, color: hdr("#ffcf8a", 3).clone(), gravity: 6, drag: 0.6, shape: SHAPE.glow, fadeIn: 0,
      });
    }
  }

  // ---- Floating crates ---------------------------------------------------------------------

  /**
   * Cargo over the side: `n` crates tumble off the deck at `pos` (world) and
   * drift astern on the swell. `vx, vz` is the ship's velocity (m/s).
   */
  function crateOverboard(pos, { n = 1, vx = 0, vz = 0, sideX = 1, sideZ = 0 } = {}) {
    for (let i = 0; i < n; i++) {
      const c = crates.find((x) => !x.alive) || crates.reduce((a, b) => (a.age > b.age ? a : b));
      Object.assign(c, {
        alive: true, x: pos.x + rand(-0.6, 0.6), z: pos.z + rand(-0.6, 0.6), y: pos.y + 0.5, vy: rand(1.5, 3),
        vx: vx * 0.5 + sideX * rand(1.5, 3.2), vz: vz * 0.5 + sideZ * rand(1.5, 3.2), age: 0, life: rand(35, 50),
        spin: rand(-1.5, 1.5), rx: rand(-0.4, 0.4), rz: rand(-0.4, 0.4), yaw: rand(0, 6.28),
      });
      splash(_v.set(c.x + sideX * 2, WATER_Y, c.z + sideZ * 2), { scale: 0.6 });
    }
  }

  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
  /** Flotsam (Night Raid): `n` planks and barrels thrown up from `pos` (world), drifting. */
  function flotsam(pos, { n = 2, vx = 0, vz = 0 } = {}) {
    if (!pos) return;
    for (let i = 0; i < n; i++) {
      const kind = Math.random() < 0.65 ? 0 : 1;
      const c = flots.find((x) => !x.alive && x.kind === kind) || flots.filter((x) => x.kind === kind).reduce((a, b) => (a.age > b.age ? a : b));
      Object.assign(c, {
        alive: true, x: pos.x + rand(-1.5, 1.5), z: pos.z + rand(-1.5, 1.5), y: Math.max(pos.y, WATER_Y + 0.5), vy: rand(2, 6),
        vx: vx * 0.5 + rand(-3, 3), vz: vz * 0.5 + rand(-3, 3), age: 0, life: rand(40, 70),
        spin: rand(-2, 2), rx: rand(-0.3, 0.3), rz: rand(-0.3, 0.3), yaw: rand(0, 6.28),
      });
    }
  }

  function updateFlotsam(dt) {
    const water = R.water;
    const counts = [0, 0];
    for (const c of flots) {
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > c.life) { c.alive = false; continue; }
      const surf = water ? WATER_Y + water.swellAt(c.x, c.z, _sw).h : WATER_Y;
      const rest = surf + 0.05 - THREE.MathUtils.smoothstep(c.age, c.life - 8, c.life) * 1.4;
      if (c.y > rest + 0.05) c.vy -= 9.8 * dt;
      else { c.vy += (rest - c.y) * 12 * dt; c.vy *= Math.max(0, 1 - 3 * dt); }
      c.y += c.vy * dt;
      const d = Math.max(0, 1 - 0.3 * dt);
      c.vx *= d; c.vz *= d;
      c.x += c.vx * dt; c.z += c.vz * dt;
      c.yaw += c.spin * dt; c.spin *= Math.max(0, 1 - 0.25 * dt);
      _e.set(c.rx + Math.sin(time * 0.9 + c.yaw) * 0.1 - _sw.dz * 0.5, c.yaw, c.rz + Math.cos(time * 0.8 + c.yaw) * 0.1 + _sw.dx * 0.5);
      _m4.compose(_v.set(c.x, c.y, c.z), _q.setFromEuler(_e), _s);
      flotMeshes[c.kind].setMatrixAt(counts[c.kind]++, _m4);
    }
    flotMeshes.forEach((m, i) => { m.count = counts[i]; if (counts[i]) m.instanceMatrix.needsUpdate = true; });
  }

  function updateCrates(dt) {
    updateFlotsam(dt);
    let n = 0;
    const water = R.water;
    for (const c of crates) {
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > c.life) { c.alive = false; continue; }
      const surf = water ? WATER_Y + water.swellAt(c.x, c.z, _sw).h : WATER_Y;
      const sink = THREE.MathUtils.smoothstep(c.age, c.life - 6, c.life) * 1.2;
      const rest = surf + 0.12 - sink;
      if (c.y > rest + 0.05) { c.vy -= 9.8 * dt; }
      else { c.vy += (rest - c.y) * 12 * dt; c.vy *= Math.max(0, 1 - 3 * dt); }
      c.y += c.vy * dt;
      const d = Math.max(0, 1 - 0.35 * dt);
      c.vx *= d; c.vz *= d;
      c.x += c.vx * dt; c.z += c.vz * dt;
      c.yaw += c.spin * dt; c.spin *= Math.max(0, 1 - 0.2 * dt);
      _e.set(c.rx + Math.sin(time * 0.9 + c.yaw) * 0.12 - _sw.dz * 0.6, c.yaw, c.rz + Math.cos(time * 0.8 + c.yaw) * 0.12 + _sw.dx * 0.6);
      _m4.compose(_v.set(c.x, c.y, c.z), _q.setFromEuler(_e), _s);
      crateMesh.setMatrixAt(n++, _m4);
    }
    crateMesh.count = n;
    if (n) crateMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- Ambience ---------------------------------------------------------------------------

  function updateEmbers(dt) {
    if (!embersOn) return;
    emberAcc += dt * 2.6;
    if (emberAcc < 1) return;
    const p = lanternWorld(_v);
    const c = hdr(LANTERN, rand(2.5, 4)).clone();
    while (emberAcc >= 1) {
      emberAcc -= 1;
      glow.emit({
        x: p.x + rand(-0.04, 0.04), y: p.y + 0.12, z: p.z + rand(-0.04, 0.04),
        vx: rand(-0.04, 0.04), vy: rand(0.22, 0.5), vz: rand(-0.04, 0.04),
        life: rand(1.4, 2.8), size: rand(0.012, 0.022), size1: 0.004, color: c,
        gravity: -0.04, drag: 0.4, swirl: 0.25, shape: SHAPE.glow, fadeIn: 0.1,
      });
    }
  }

  function updateEmitters(dt) {
    for (const em of emitters) {
      if (time > em.until) { emitters.delete(em); continue; }
      if (em.kind === "bubbles") {
        em.acc += dt * 34;
        const c = hdr(SPRAY, 0.9).clone();
        while (em.acc >= 1) {
          em.acc -= 1;
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * em.radius;
          glow.emit({
            x: em.pos.x + Math.cos(a) * r, y: WATER_Y + 0.05, z: em.pos.z + Math.sin(a) * r, vy: rand(0.05, 0.2),
            life: rand(0.35, 0.9), size: rand(0.08, 0.26), size1: rand(0.2, 0.32), color: c, alpha: 0.7,
            shape: SHAPE.bubble, fadeIn: 0.2,
          });
        }
      }
    }
  }

  function updateFoams(dt) {
    for (const f of foams) {
      if (!f.busy) continue;
      f.t += dt / f.dur;
      if (f.t >= 1) { f.busy = false; f.mesh.visible = false; continue; }
      f.mat.uniforms.uT.value = f.t;
    }
  }

  // ---- The frame -----------------------------------------------------------------------------

  function frame(dtIn) {
    const dt = Math.max(0, Math.min(0.1, dtIn || 0)) * speed;
    time += dt;
    R?.camera?.getWorldPosition(camPos);
    if (R?.camera) {
      const focal = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(R.camera.fov || 50) / 2));
      glow.focal = focal;
      mist.focal = focal;
    }
    const fog = scene?.fog;
    const density = fog?.isFogExp2 ? fog.density : 0;
    glow.mat.uniforms.uFogDensity.value = density;
    mist.mat.uniforms.uFogDensity.value = density;
    if (fog?.color) mist.mat.uniforms.uFogColor.value.copy(fog.color);

    for (const tr of [...trails]) updateTrail(tr, dt);
    updateFlare(dt);
    updateEmbers(dt);
    updateEmitters(dt);
    updateFoams(dt);
    updateCrates(dt);
    glow.update(dt, time);
    mist.update(dt, time);
  }

  let offFrame = null;
  if (typeof R?.onFrame === "function") offFrame = R.onFrame((dt) => frame(dt), 30);

  return {
    burst,
    sparks,
    trail,
    splash,
    foam,
    bubbles,
    sheet,
    spray,
    splinters,
    jet,
    cannon,
    sluice,
    snuff,
    flare,
    crateOverboard,
    muzzle,
    smokeRing,
    bowWater,
    trailMote,
    embers,
    ghostMist,
    steam,
    explosion,
    flotsam,
    /** 0..1 while a flare burns (world.js lights the fog with it). */
    get flareLevel() { return flareLevel; },
    /** The flare's light and star, for compile warm-up. */
    flareParts: { light: flareLight, star: star.mesh, crates: crateMesh },
    /** For the compile warm-up: show a foam ring (the rest is in the flare's parts). */
    warmShow(on) { foams[0].mesh.visible = on || foams[0].busy; },
    /** Debug cinematic speed (1 = as designed). */
    setSpeed(n) { speed = Math.max(0.01, Number(n) || 1); },
    /** Finish every trail and the flare now. */
    flush() {
      for (const tr of [...trails]) tr.resolve();
      flareRun?.resolve();
    },
    /** Clear everything (a new voyage). */
    reset() {
      for (const tr of [...trails]) tr.resolve();
      flareRun?.resolve();
      emitters.clear();
      for (const c of crates) c.alive = false;
      crateMesh.count = 0;
      for (const c of flots) c.alive = false;
      for (const m of flotMeshes) m.count = 0;
      for (const f of foams) { f.busy = false; f.mesh.visible = false; }
      embersOn = true;
    },
    stats: () => ({ glow: glow.live, mist: mist.live, trails: trails.size, crates: crateMesh.count, flare: flareLevel }),
    dispose() {
      offFrame?.();
      for (const tr of [...trails]) tr.resolve();
      flareRun?.resolve();
      emitters.clear();
      root.removeFromParent();
      flareLight.removeFromParent();
      for (const p of [glow, mist]) { p.geo.dispose(); p.mat.dispose(); }
      for (const f of foams) { f.geo.dispose(); f.mat.dispose(); }
      star.mesh.geometry.dispose(); star.mesh.material.dispose();
      crateGeo.dispose(); crateMat.dispose(); crateMesh.dispose?.();
      plankGeo.dispose(); barrelGeo.dispose(); flotMat.dispose();
    },
  };
}
