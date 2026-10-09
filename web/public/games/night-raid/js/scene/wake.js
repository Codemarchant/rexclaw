// Night Raid (from Night Helm): the ship's wake, bow wave and hull wash.
//
//   the wake     a ribbon on the water through the ship's past stern
//                positions (a ring buffer of up to 256 samples, one per ~1.6 m
//                sailed): it widens with age like a Kelvin wedge (19.5° arms),
//                bright foam along its two edges, a churned band down the
//                middle that settles first, all fading over 40 s. In Kraken
//                waters it glows with stirred-up plankton.
//   the bow wave two foam wings that peel off the stem and run aft along the
//                hull as a thinner wash, scrolling with the ship's speed
//                (Medium and up)
//
// v3: both ride the displaced sea (water.js SEA_HEIGHT_GLSL in the vertex
// shader; the ribbon is five vertices across so the swell bends it), in a
// frame that follows the ship's position and heading but not her heave,
// pitch or heel. The trail is longer (2.4 m a sample: ~600 m, ~40 s at full
// sail), spreads as it ages and fades out; foam lace breaks it up.
// world.js feeds `update(x, z, heading, speed)` every frame.

import * as THREE from "three";
import { B, WATER_Y, LAYERS, headingVec } from "./blocking.js";
import { MAX_COUNTS } from "./quality.js";
import { SEA_HEIGHT_GLSL } from "./water.js";

const N = MAX_COUNTS.wake;           // samples in the ring
const SPACING = 2.4;                 // metres sailed per sample
const COLS = 5;                      // vertices across the ribbon (the swell bends it)
const LIFE = 40;                     // seconds a stretch of wake lasts
const ARM = Math.tan(19.5 * Math.PI / 180);
const STERN_Z = -12.4;               // the transom, ship space
const Y = WATER_Y + 0.035;

const NOISE = /* glsl */`
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float wFbm(vec2 p) { return wNoise(p) * 0.55 + wNoise(p * 2.3 + 7.1) * 0.3 + wNoise(p * 5.1 - 3.3) * 0.15; }`;

/**
 * Build the wake and the bow wave.
 * @param {object} R  the render context (R.water's uniforms supply fog, glow and time)
 */
export function createWake(R) {
  const scene = R.scene;
  const wu = R.water?.uniforms;
  const shared = {
    uTime: wu?.uTime || { value: 0 },
    uFogDensity: wu?.uFogDensity || { value: 0 }, uFogColor: wu?.uFogColor || { value: new THREE.Color() },
    uGlow: wu?.uGlow || { value: 0.4 }, uBio: wu?.uBio || { value: 0 },
    uPlankton: wu?.uPlankton || { value: new THREE.Color("#3ff3e0").multiplyScalar(2.2) },
    uMoon: { value: 0.8 },
    uSwellA: wu?.uSwellA || { value: [0, 0, 0].map(() => new THREE.Vector4()) }, uSwellB: wu?.uSwellB || { value: [0, 0, 0].map(() => new THREE.Vector4()) },
    uChopA: wu?.uChopA || { value: [0, 0, 0, 0].map(() => new THREE.Vector4()) }, uChopB: wu?.uChopB || { value: [0, 0, 0, 0].map(() => new THREE.Vector4()) },
    uDay: { value: 0 },
  };
  const SEA_VERT = /* glsl */`
    uniform float uTime;
    ${SEA_HEIGHT_GLSL}
    vec4 onSea(vec3 p, float lift) { vec4 w = modelMatrix * vec4(p, 1.0); w.y += seaHeight(w.xz) + lift; return w; }`;

  // ---- The wake ribbon ----
  const VERTS = (N + 1) * COLS;
  const pos = new Float32Array(VERTS * 3);
  const info = new Float32Array(VERTS * 4);                 // across, age, along, speed
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aInfo = new THREE.BufferAttribute(info, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos);
  geo.setAttribute("aInfo", aInfo);
  {
    const Q = COLS - 1;
    const idx = new Uint16Array(N * Q * 6);
    for (let i = 0; i < N; i++) {
      for (let q = 0; q < Q; q++) {
        const a = i * COLS + q, b = a + 1, c = a + COLS, d = c + 1;
        idx.set([a, c, b, b, c, d], (i * Q + q) * 6);
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    name: "NightHelmWake", uniforms: { ...shared, uLife: { value: LIFE } },
    transparent: true, depthWrite: false, premultipliedAlpha: true, fog: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    vertexShader: /* glsl */`
      attribute vec4 aInfo;
      varying vec4 vInfo;
      varying vec3 vWorld;
      ${SEA_VERT}
      void main() {
        vInfo = aInfo;
        vec4 w = onSea(position, 0.05);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uGlow, uBio, uLife, uMoon, uDay;
      uniform vec3 uFogColor, uPlankton;
      varying vec4 vInfo;
      varying vec3 vWorld;
      ${NOISE}
      void main() {
        float across = clamp(vInfo.x, -1.0, 1.0), age = max(vInfo.y, 0.0), along = vInfo.z, spd = vInfo.w;
        float k = clamp(age / uLife, 0.0, 1.0);
        float life = (1.0 - k) * (1.0 - k);
        float go = smoothstep(0.4, 4.0, spd);
        float ax = abs(across);
        // Soft outer edges; brighter toward the Kelvin arms; a churned middle that settles first.
        float edgeFade = 1.0 - smoothstep(0.68, 1.0, ax);
        float arms = smoothstep(0.35, 0.85, ax) * edgeFade;
        float centre = (1.0 - smoothstep(0.0, 0.6, ax)) * exp(-age * 0.12);
        float n = wFbm(vec2(along * 0.16, across * 2.2) + vec2(0.0, uTime * 0.05));
        float m = wFbm(vWorld.xz * 0.45 + vec2(uTime * 0.07, -uTime * 0.05));
        float lace = smoothstep(0.38, 0.78, n * 0.55 + m * 0.55);   // foam is patchy, never a solid band
        float foam = (arms * 0.85 + centre * 0.6) * lace * (0.55 + 0.45 * m);
        foam *= smoothstep(0.0, 3.0, along);            // no hard edge at the transom
        float a = clamp(foam * life * go * 0.75, 0.0, 1.0);
        float d = uFogDensity * length(cameraPosition - vWorld);
        float seen = exp(-d * d);
        vec3 col = mix(vec3(0.30, 0.36, 0.41) * (0.55 + 0.6 * uMoon), vec3(0.9, 0.94, 0.96), uDay);
        vec3 glow = uPlankton * (0.08 * uGlow + 0.55 * uBio) * foam * life * go * 0.4 * (1.0 - uDay);
        gl_FragColor = vec4((col * a * 0.85 + glow) * seen, a * 0.85 * seen);
      }`,
  });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.name = "wake";
  ribbon.frustumCulled = false;
  ribbon.renderOrder = 1;
  ribbon.layers.set(LAYERS.NOREFLECT);
  scene.add(ribbon);

  // Samples: x, z, dirX, dirZ, speed, time, distance travelled.
  const sx = new Float32Array(N), sz = new Float32Array(N), sdx = new Float32Array(N), sdz = new Float32Array(N);
  const ssp = new Float32Array(N), st = new Float32Array(N), sd = new Float32Array(N);
  let head = 0, count = 0, travelled = 0, lastX = NaN, lastZ = NaN, lastSampleD = -1e9;

  // ---- The bow wave and hull wash (in a yaw-only frame) ----
  const follow = new THREE.Group();
  follow.name = "wake.follow";
  scene.add(follow);
  const M = 40;
  const bowGeo = new THREE.BufferGeometry();
  {
    const P = [], U = [], I = [];
    const { a, b, z: zc } = B.HULL;
    for (const side of [-1, 1]) {
      const base = P.length / 3;
      for (let i = 0; i <= M; i++) {
        const s = i / M;                                   // 0 at the stem, 1 at the stern
        const th = s * Math.PI;
        const x = side * a * Math.sin(th) * 1.02, z = zc + b * Math.cos(th);
        // Outward normal of the ellipse.
        let nx = side * Math.sin(th) / a, nz = Math.cos(th) / b;
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        const w = 0.8 + 2.6 * Math.sin(Math.min(1, s * 3.2) * Math.PI * 0.5) * (1 - 0.55 * s);
        P.push(x - nx * 0.3, Y + 0.01, z - nz * 0.3, x + nx * w, Y + 0.01, z + nz * w);
        U.push(s, 0, s, 1);
        if (i < M) {
          const q = base + i * 2;
          if (side < 0) I.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
          else I.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
        }
      }
    }
    bowGeo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    bowGeo.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
    bowGeo.setIndex(I);
  }
  const bowU = { ...shared, uSpeed: { value: 0 }, uScroll: { value: 0 } };
  const bowMat = new THREE.ShaderMaterial({
    name: "NightHelmBowWave", uniforms: bowU,
    transparent: true, depthWrite: false, premultipliedAlpha: true, fog: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vWorld;
      ${SEA_VERT}
      void main() { vUv = uv; vec4 w = onSea(position, 0.07); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uGlow, uBio, uSpeed, uScroll, uMoon, uDay;
      uniform vec3 uFogColor, uPlankton;
      varying vec2 vUv; varying vec3 vWorld;
      ${NOISE}
      void main() {
        float s = vUv.x, out_ = vUv.y;
        float go = smoothstep(0.3, 3.5, uSpeed);
        // The bow wave: strongest just aft of the stem, then a thinner wash along the side.
        float bow = exp(-pow(max(s - 0.08, 0.0) / 0.16, 1.6)) * 1.2 + 0.35;
        float n = wFbm(vec2(s * 22.0 + uScroll * 0.08, out_ * 2.5));
        float lace = wFbm(vec2(s * 60.0 + uScroll * 0.2, out_ * 6.0 + uTime * 0.3));
        float band = smoothstep(0.0, 0.25, out_) * (1.0 - smoothstep(0.35 + 0.4 * n, 1.0, out_));
        float foam = band * bow * (0.4 + 0.8 * n) * (0.6 + 0.6 * lace) * (1.0 - smoothstep(0.82, 1.0, s));
        float a = clamp(foam * go, 0.0, 1.0);
        float d = uFogDensity * length(cameraPosition - vWorld);
        float seen = exp(-d * d);
        vec3 col = mix(vec3(0.34, 0.40, 0.45) * (0.55 + 0.6 * uMoon), vec3(0.92, 0.95, 0.97), uDay);
        vec3 glow = uPlankton * (0.1 * uGlow + 0.6 * uBio) * foam * go * 0.35 * (1.0 - uDay);
        gl_FragColor = vec4((col * a * 0.9 + glow) * seen, a * 0.9 * seen);
      }`,
  });
  const bow = new THREE.Mesh(bowGeo, bowMat);
  bow.name = "bow-wave";
  bow.frustumCulled = false;
  bow.renderOrder = 2;
  bow.layers.set(LAYERS.NOREFLECT);
  follow.add(bow);

  function applyTier(q) { bow.visible = !!q.hullFoam; }
  applyTier(R.quality);
  const offQ = R.onQuality(applyTier);

  const _sternDir = [0, 1];

  /** Rebuild the ribbon's vertices from the samples (newest first, then the live stern). */
  function rebuild(x, z, dx, dz, speed) {
    const now = shared.uTime.value;
    const limit = Math.min(count, R.quality.wake || N);
    // Vertex pair 0: the live stern.
    let v = 0;
    const put = (cx, cz, ldx, ldz, age, along, spd) => {
      const hw = Math.min(38, 2.6 + (age * Math.max(spd, 0.5) * ARM) * 0.9 + age * 0.1);
      const lx = -ldz, lz = ldx;                       // lateral (to port)
      for (let q = 0; q < COLS; q++) {
        const a = (q / (COLS - 1)) * 2 - 1;
        const o = (v * COLS + q) * 3, oi = (v * COLS + q) * 4;
        pos[o] = cx + lx * hw * a; pos[o + 1] = Y; pos[o + 2] = cz + lz * hw * a;
        info[oi] = a; info[oi + 1] = age; info[oi + 2] = along; info[oi + 3] = spd;
      }
      v++;
    };
    put(x + dx * STERN_Z, z + dz * STERN_Z, dx, dz, 0, 0, speed);
    for (let k = 0; k < limit; k++) {
      const i = (head - 1 - k + N) % N;
      put(sx[i], sz[i], sdx[i], sdz[i], now - st[i], travelled - sd[i], ssp[i]);
    }
    geo.setDrawRange(0, Math.max(0, v - 1) * (COLS - 1) * 6);
    aPos.clearUpdateRanges(); aPos.addUpdateRange(0, v * COLS * 3); aPos.needsUpdate = true;
    aInfo.clearUpdateRanges(); aInfo.addUpdateRange(0, v * COLS * 4); aInfo.needsUpdate = true;
  }

  const wake = {
    ribbon, bow,
    /**
     * Per frame: where the ship is and how fast (m/s).
     * @param {number} x @param {number} z @param {number} heading  degrees @param {number} speed
     */
    update(x, z, heading, speed, dropY = 0) {
      // Night Raid: in the maelstrom's bowl the surface slopes away under these flat ribbons: the bowl's own churn
      // is her wake there, so these step aside.
      ribbon.position.y = dropY;
      const onSea = dropY > -0.25;
      ribbon.visible = onSea;
      follow.visible = onSea;
      const [dx, dz] = headingVec(heading);
      _sternDir[0] = dx; _sternDir[1] = dz;
      if (Number.isFinite(lastX)) travelled += Math.hypot(x - lastX, z - lastZ);
      lastX = x; lastZ = z;
      if (travelled - lastSampleD >= SPACING) {
        lastSampleD = travelled;
        sx[head] = x + dx * STERN_Z; sz[head] = z + dz * STERN_Z;
        sdx[head] = dx; sdz[head] = dz;
        ssp[head] = Math.max(0, speed || 0);
        st[head] = shared.uTime.value;
        sd[head] = travelled;
        head = (head + 1) % N;
        count = Math.min(N, count + 1);
      }
      rebuild(x, z, dx, dz, Math.max(0, speed || 0));
      follow.position.set(x, dropY, z);
      follow.rotation.y = -heading * Math.PI / 180;
      bowU.uSpeed.value = Math.max(0, speed || 0);
      bowU.uScroll.value = travelled;
      shared.uMoon.value = R.sky?.moonLight ?? 0.8;
      shared.uDay.value = R.atmos?.day || 0;
    },

    /** Forget the trail (a new voyage, a cut). */
    reset() { head = 0; count = 0; travelled = 0; lastX = NaN; lastZ = NaN; lastSampleD = -1e9; geo.setDrawRange(0, 0); },

    dispose() {
      offQ();
      ribbon.removeFromParent(); follow.removeFromParent();
      geo.dispose(); mat.dispose(); bowGeo.dispose(); bowMat.dispose();
    },
  };
  return wake;
}
