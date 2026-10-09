// Night Raid: the storm cell and the sea's dangers in it.
//
//   the storm    state.storm {x, z, r, inside} (else world.storm drifting at
//                vx, vz): a ceiling of churning cloud over it (a dark mass on
//                the horizon from outside, flickering), rain around the
//                camera inside (streaks, a draw range per tier, slanting
//                downwind), darker choppy water (water.setStorm), the fog
//                closing in and greying (world.js sets the visibility)
//   lightning    hazards.lightning {x, z, t, eta}: a jagged bolt with
//                branches from the cloud base to the strike, re-striking
//                twice, a flash over the whole frame (post flash), the cloud
//                lit from inside; and silent sheet lightning in the cloud
//   rogue wave   hazards.wave {id, dirDeg, eta, x, z, width}: a wall of black
//                water ~11 m high rolling in, a breaking white crest, spray
//                off the lip; it rises out of the sea as it nears (the
//                telegraph) and rolls on after it passes. waveHeightAt(x, z)
//                lets the ship ride it.
//   waterspouts  hazards.spouts [{id, x, z, r}]: a twisting column from the
//                cloud base to the sea, forming top-down when one appears, a
//                ring of spray and churning foam at its foot
//   mortars      hazards.mortars [{id, x, z, r, eta}]: a red ring on the water
//                shrinking onto the target circle over the last 6 s

import * as THREE from "three";
import { LAYERS, WATER_Y, headingVec } from "./blocking.js";
import { MAX_COUNTS } from "./quality.js";

const CLOUD_Y = 170;
const RAIN_BOX = { w: 90, h: 46 };
const WAVE = { height: 14, back: 50, front: 14, along: 72, across: 26 };
const SPOUTS = 4, MORTARS = 8, BOLT_SEGS = 96;
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

const NOISE = /* glsl */`
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float wFbm(vec2 p) { return wNoise(p) * 0.5 + wNoise(p * 2.03 + 5.2) * 0.3 + wNoise(p * 4.1 - 2.7) * 0.2; }`;

/** The rogue wave's height profile across its front (u: metres ahead of the crest, + = the way it rolls). */
export function waveProfile(u) {
  if (u > WAVE.front || u < -WAVE.back) return 0;
  if (u >= 0) { const k = 1 - u / WAVE.front; return WAVE.height * k * k * (3 - 2 * k) * (0.85 + 0.15 * k); }
  const k = 1 + u / WAVE.back;
  return WAVE.height * Math.pow(Math.max(k, 0), 1.6);
}

/**
 * @param {object} R  the render context
 * @param {{water: object, fx: object}} deps
 */
export function createWeather(R, { water, fx }) {
  const root = new THREE.Group();
  root.name = "weather";
  R.scene.add(root);
  const wu = water?.uniforms || {};
  const shared = {
    uTime: wu.uTime || { value: 0 }, uFogDensity: wu.uFogDensity || { value: 0 }, uFogColor: wu.uFogColor || { value: new THREE.Color() },
    uMoonVis: wu.uMoonVis || { value: 1 }, uFlash: { value: 0 }, uSheet: { value: 0 },
    uDay: { value: 0 },                          // v4: R.atmos.day (the rogue wave was night-black by day too)
  };
  const S = { world: null, storm: null, k: 0, inside: 0, flash: 0, sheetT: 4, sheet: 0, wave: null, waves: [], spouts: new Map(), strikeKey: null, time: 0 };
  /** The tier's share of spray (quality.mist over High's 5000: Low 0.3, Medium 0.6, High 1). */
  const mistShare = () => clamp((R.quality?.mist || 5000) / 5000, 0.2, 1);

  // ---- The cloud ceiling ----
  const cloudGeo = new THREE.CircleGeometry(1, 64, 0, Math.PI * 2);
  cloudGeo.rotateX(Math.PI / 2);                // facing down
  const cloudMat = new THREE.ShaderMaterial({
    name: "NightRaidStormCloud", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    uniforms: { ...shared, uCentre: { value: new THREE.Vector2() }, uR: { value: 450 }, uStrike: { value: new THREE.Vector3() }, uAmt: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uFlash, uSheet, uR, uMoonVis, uAmt;
      uniform vec2 uCentre; uniform vec3 uStrike, uFogColor;
      varying vec3 vW;
      ${NOISE}
      void main() {
        vec2 d = vW.xz - uCentre;
        float r = length(d) / (uR * 1.7);
        if (r > 1.0) discard;
        vec2 q = vW.xz * 0.004 + vec2(uTime * 0.01, -uTime * 0.007);
        float n = wFbm(q) * 0.65 + wFbm(q * 3.1 + 7.0) * 0.35;
        float body = smoothstep(1.0, 0.55, r + (n - 0.5) * 0.35);
        vec3 col = mix(vec3(0.012, 0.016, 0.024), vec3(0.04, 0.05, 0.065), n) * (0.6 + 0.6 * uMoonVis);
        // Lit from inside: by the strike, and by sheet lightning.
        float near = exp(-length(vW.xz - uStrike.xz) / 260.0);
        col += vec3(0.55, 0.62, 0.85) * (uFlash * (0.25 + 1.8 * near) + uSheet * 0.6 * smoothstep(0.35, 0.8, n)) * body;
        float dist = length(cameraPosition - vW);
        float fd = uFogDensity * dist * 0.5;
        float seen = exp(-fd * fd);
        // Far off it's a low smudge on the horizon (a disc seen edge-on would read as a lens): fade it with distance.
        float far = 1.0 - smoothstep(uR * 1.6, uR * 4.0, length(cameraPosition.xz - uCentre));
        gl_FragColor = vec4(mix(uFogColor, col, seen), body * mix(0.1, 0.92, seen) * (0.25 + 0.75 * far) * uAmt);
      }`,
  });
  const cloud = new THREE.Mesh(cloudGeo, cloudMat);
  cloud.name = "storm.cloud";
  cloud.frustumCulled = false;
  cloud.renderOrder = -5;
  cloud.visible = false;
  cloud.layers.set(LAYERS.FX);
  root.add(cloud);

  // ---- Rain around the camera ----
  const RAIN = MAX_COUNTS.rain;
  const rainGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(RAIN * 2 * 3), seed = new Float32Array(RAIN * 2 * 4);
    let s = 0x2545f491;
    const rnd = () => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s / 4294967296; };
    for (let i = 0; i < RAIN; i++) {
      const a = rnd(), b = rnd(), c = rnd(), d = rnd();
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        seed[k * 4] = a; seed[k * 4 + 1] = b; seed[k * 4 + 2] = c; seed[k * 4 + 3] = e;
      }
    }
    rainGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    rainGeo.setAttribute("aDrop", new THREE.BufferAttribute(seed, 4));
    rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    rainGeo.setDrawRange(0, 0);
  }
  const rainMat = new THREE.ShaderMaterial({
    name: "NightRaidRain", transparent: true, depthWrite: false, fog: false,
    uniforms: { ...shared, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uRain: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec4 aDrop;
      uniform vec3 uCam; uniform vec2 uWind; uniform float uTime, uRain;
      varying float vA; varying float vEnd;
      void main() {
        // A column of rain from the sea up past the camera (a high chase camera sees it all the way down).
        float W = ${RAIN_BOX.w.toFixed(1)} + max(uCam.y, 0.0) * 1.2;
        float H = max(uCam.y - ${WATER_Y.toFixed(2)} + 14.0, ${RAIN_BOX.h.toFixed(1)});
        float speed = 22.0 + aDrop.z * 8.0;
        float fall = mod(aDrop.z * 97.0 - uTime * speed, H);
        vec3 base = vec3((aDrop.x - 0.5) * W, 0.0, (aDrop.y - 0.5) * W);
        // World-anchored drops (they don't follow the camera's sideways moves): wrap around it.
        vec2 world = uCam.xz + mod(base.xz - uCam.xz + W * 0.5, W) - W * 0.5;
        vec3 p = vec3(world.x, ${WATER_Y.toFixed(2)} + fall, world.y);
        vec3 vel = vec3(uWind.x, -speed, uWind.y);
        p += vel * 0.05 * aDrop.w;
        vEnd = aDrop.w;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        vA = uRain * smoothstep(1.0, 4.0, d) * (1.0 - smoothstep(W * 0.35, W * 0.55, d)) * step(${WATER_Y.toFixed(2)}, p.y);
      }`,
    fragmentShader: /* glsl */`
      uniform float uFlash, uMoonVis;
      varying float vA; varying float vEnd;
      void main() {
        float a = vA * mix(0.06, 0.4, vEnd) * (1.0 + 2.5 * uFlash);
        if (a < 0.002) discard;
        gl_FragColor = vec4(vec3(0.62, 0.68, 0.78) * (0.55 + 0.45 * uMoonVis + 1.5 * uFlash), a);
      }`,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.name = "storm.rain";
  rain.frustumCulled = false;
  rain.renderOrder = 14;
  rain.layers.set(LAYERS.NOREFLECT);
  root.add(rain);

  // ---- Lightning: bolts as camera-facing ribbons ----
  const boltPos = new Float32Array(BOLT_SEGS * 6 * 3), boltA = new Float32Array(BOLT_SEGS * 6);
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute("position", new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  boltGeo.setAttribute("aA", new THREE.BufferAttribute(boltA, 1).setUsage(THREE.DynamicDrawUsage));
  boltGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  boltGeo.setDrawRange(0, 0);
  const boltMat = new THREE.ShaderMaterial({
    name: "NightRaidBolt", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    uniforms: { uI: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aA; varying float vA;
      void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uI; varying float vA;
      void main() { float edge = 1.0 - abs(vA * 2.0 - 1.0); gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * uI * (0.25 + edge * edge * 1.6), 1.0); }`,
  });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.name = "storm.bolt";
  bolt.frustumCulled = false;
  bolt.renderOrder = 15;
  bolt.layers.set(LAYERS.FX);
  root.add(bolt);
  const boltLight = new THREE.DirectionalLight("#b8c8ff", 0);
  boltLight.name = "lightning";
  const boltTarget = new THREE.Object3D();
  boltLight.target = boltTarget;
  R.scene.add(boltLight, boltTarget);
  const B = { t: 9, life: 0.7, pts: [], branches: [], strikes: [0, 0.12, 0.3], at: new THREE.Vector3() };

  function makeBolt(to) {
    const from = new THREE.Vector3(to.x + (Math.random() - 0.5) * 120, CLOUD_Y - 10, to.z + (Math.random() - 0.5) * 120);
    const pts = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const p = from.clone().lerp(to, k);
      const j = (1 - Math.abs(k - 0.5) * 2) * 0 + 1;
      if (i > 0 && i < n) { p.x += (Math.random() - 0.5) * 16 * j; p.z += (Math.random() - 0.5) * 16 * j; p.y += (Math.random() - 0.5) * 4; }
      pts.push(p);
    }
    const branches = [];
    for (let b = 0; b < 3; b++) {
      const s = 4 + Math.floor(Math.random() * (n - 12));
      const br = [pts[s].clone()];
      const dir = new THREE.Vector3((Math.random() - 0.5) * 2, -1.2, (Math.random() - 0.5) * 2).normalize();
      for (let i = 1; i < 9; i++) br.push(br[i - 1].clone().addScaledVector(dir, 7 + Math.random() * 5).add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)));
      branches.push(br);
    }
    B.pts = pts; B.branches = branches; B.t = 0; B.at.copy(to);
  }

  const _cam = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _side = new THREE.Vector3(), _d = new THREE.Vector3();
  function writeBolt() {
    let k = 0;
    const strip = (pts, w) => {
      for (let i = 0; i < pts.length - 1 && k < BOLT_SEGS; i++) {
        _a.copy(pts[i]); _b.copy(pts[i + 1]);
        _d.subVectors(_b, _a);
        _side.subVectors(_a, _cam).cross(_d).normalize().multiplyScalar(w * (1 - i / pts.length * 0.5));
        const quad = [_a.clone().sub(_side), _a.clone().add(_side), _b.clone().sub(_side), _b.clone().sub(_side), _a.clone().add(_side), _b.clone().add(_side)];
        const aa = [0, 1, 0, 0, 1, 1];
        for (let q = 0; q < 6; q++) { boltPos.set([quad[q].x, quad[q].y, quad[q].z], (k * 6 + q) * 3); boltA[k * 6 + q] = aa[q]; }
        k++;
      }
    };
    strip(B.pts, 0.9);
    for (const br of B.branches) strip(br, 0.45);
    boltGeo.setDrawRange(0, k * 6);
    boltGeo.attributes.position.needsUpdate = true;
    boltGeo.attributes.aA.needsUpdate = true;
  }

  // ---- The rogue wave ----
  const waveGeo = new THREE.PlaneGeometry(1, 1, 72, 30);
  const wavePos = waveGeo.attributes.position;
  {
    // x: along the crest (−0.5..0.5 × width), y: across (u, metres; the plane is laid along z and lifted by the profile).
    const across = [];
    for (let j = 0; j <= 30; j++) across.push(-WAVE.back + (WAVE.back + WAVE.front) * (j / 30));
    const p = wavePos;
    for (let i = 0; i < p.count; i++) {
      const gx = p.getX(i) + 0.5, gy = p.getY(i) + 0.5;
      const j = Math.round(gy * 30);
      const u = across[j];
      p.setXYZ(i, gx - 0.5, 0, u);           // y filled in the vertex shader
    }
  }
  waveGeo.computeBoundingSphere();
  const waveMat = new THREE.ShaderMaterial({
    name: "NightRaidRogueWave", transparent: true, depthWrite: true, fog: false, side: THREE.DoubleSide,
    uniforms: { ...shared, uWidth: { value: 300 }, uRise: { value: 0 }, uH: { value: WAVE.height } },
    vertexShader: /* glsl */`
      uniform float uWidth, uRise, uH, uTime;
      varying vec3 vW; varying float vU; varying float vAlong; varying float vHk; varying float vRel;
      float prof(float u) {
        if (u > ${WAVE.front.toFixed(1)} || u < -${WAVE.back.toFixed(1)}) return 0.0;
        if (u >= 0.0) { float k = 1.0 - u / ${WAVE.front.toFixed(1)}; return uH * k * k * (3.0 - 2.0 * k) * (0.85 + 0.15 * k); }
        float k = 1.0 + u / ${WAVE.back.toFixed(1)};
        return uH * pow(max(k, 0.0), 1.6);
      }
      void main() {
        float along = position.x;
        float u = position.z;
        float ends = smoothstep(0.5, 0.36, abs(along));
        float wob = 0.85 + 0.15 * sin(along * 19.0 + uTime * 0.8) * sin(along * 7.0 - uTime * 0.5);
        float h = prof(u) * ends * wob * uRise;
        // The lip curls forward over the face near the crest.
        float lip = smoothstep(-6.0, 0.0, u) * smoothstep(${WAVE.front.toFixed(1)}, 2.0, u) * uRise * ends;
        vec3 p = vec3(along * uWidth, h, u + lip * 2.2);
        vU = u; vAlong = along; vHk = h / max(uH, 1.0);
        vRel = prof(u) / max(uH, 1.0) * smoothstep(0.1, 0.4, ends * uRise);
        vec4 w = modelMatrix * vec4(p, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uFlash, uMoonVis, uWidth, uDay;
      uniform vec3 uFogColor;
      varying vec3 vW; varying float vU; varying float vAlong; varying float vHk; varying float vRel;
      ${NOISE}
      void main() {
        // The face: black-green water, translucent near the crest; the crest: breaking white.
        float n = wFbm(vec2(vAlong * uWidth * 0.06 + uTime * 0.1, vU * 0.18 - uTime * 0.6));
        // Breaking white only along the top of the crest; foam streaks run down the face; the rest black.
        float brk = 0.3 + 0.9 * wNoise(vec2(vAlong * uWidth * 0.35 - uTime * 0.4, vU * 0.3 + uTime * 0.7));
        float crest = smoothstep(0.8 - 0.12 * brk, 0.97, vRel) * smoothstep(-9.0, 0.5, vU) * (0.5 + 0.6 * n) * brk;
        float streaks = smoothstep(0.62, 0.9, wFbm(vec2(vAlong * uWidth * 0.11, vU * 0.06 - uTime * 0.3))) * smoothstep(0.35, 0.85, vHk) * step(0.0, vU);
        float face = smoothstep(${WAVE.front.toFixed(1)}, 0.0, vU) * step(0.0, vU);
        // As dark as the night sea (≈0.005 linear), the top of the face a touch green where the crest thins.
        vec3 water = mix(vec3(0.0015, 0.0035, 0.0045), vec3(0.004, 0.013, 0.013), face * smoothstep(0.5, 1.0, vHk));
        // By day: deep sea blue, the thinning crest glass-green with the light through it.
        vec3 dayWater = mix(vec3(0.012, 0.06, 0.11), vec3(0.03, 0.2, 0.2), face * smoothstep(0.45, 1.0, vHk));
        water = mix(water, dayWater, uDay);
        vec3 foam = mix(vec3(0.5, 0.56, 0.6) * (0.4 + 0.6 * uMoonVis + 1.2 * uFlash), vec3(0.85, 0.9, 0.92), uDay);
        vec3 col = mix(water, foam, clamp(crest + streaks * 0.22, 0.0, 0.92));
        col += vec3(0.4, 0.45, 0.6) * uFlash * 0.15;
        float fd = uFogDensity * length(cameraPosition - vW) * 0.6;
        float seen = exp(-fd * fd);
        float a = smoothstep(0.02, 0.12, vHk);
        gl_FragColor = vec4(mix(uFogColor, col, seen), a);
      }`,
  });
  const waveMeshes = [0, 1, 2].map((i) => {      // v4: three (a sea event's rogue set)
    const m = new THREE.Mesh(waveGeo, i ? waveMat.clone() : waveMat);
    m.name = `rogue-wave-${i}`;
    m.frustumCulled = false;
    m.visible = false;
    m.renderOrder = 4;
    m.layers.set(LAYERS.NOREFLECT);
    root.add(m);
    return { mesh: m, mat: m.material, id: null, x: 0, z: 0, dir: 0, speed: 12, rise: 0, gone: 0, width: 300, sprayT: 0, live: false };
  });
  // A clone copies its uniforms: hand the shared ones back so both walls follow the fog, the moon and the flash.
  for (const w of waveMeshes) for (const k of Object.keys(shared)) w.mat.uniforms[k] = shared[k];

  // ---- Waterspouts ----
  const spoutGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 40, true);
  spoutGeo.translate(0, 0.5, 0);
  const spoutMats = [];
  const spouts = Array.from({ length: SPOUTS }, (_, i) => {
    const mat = new THREE.ShaderMaterial({
      name: "NightRaidWaterspout", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { ...shared, uForm: { value: 0 }, uR: { value: 6 }, uH: { value: CLOUD_Y - WATER_Y }, uSeed: { value: i * 1.7 }, uPale: { value: 0 } },
      vertexShader: /* glsl */`
        uniform float uTime, uR, uH, uSeed;
        varying vec2 vUv; varying vec3 vW; varying vec3 vN;
        void main() {
          vUv = uv;
          float y = position.y;                         // 0 at the sea .. 1 at the cloud
          // Radius: a flared foot, a narrow neck, a wide funnel into the cloud.
          float r = uR * (0.55 + 1.2 * exp(-y * 14.0) + 4.0 * pow(max(y - 0.55, 0.0) / 0.45, 2.2));
          float sway = sin(y * 3.0 + uTime * 0.4 + uSeed) * 6.0 * y * (1.0 - y) * 4.0;
          float sway2 = cos(y * 2.3 + uTime * 0.33 + uSeed * 2.0) * 5.0 * y * (1.0 - y) * 4.0;
          vec3 p = vec3(position.x * r + sway, y * uH, position.z * r + sway2);
          vN = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
          vec4 w = modelMatrix * vec4(p, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uForm, uFogDensity, uFlash, uMoonVis, uSeed, uPale;
        uniform vec3 uFogColor;
        varying vec2 vUv; varying vec3 vW; varying vec3 vN;
        ${NOISE}
        void main() {
          float y = vUv.y;
          // Forming: the funnel reaches down from the cloud.
          float formed = smoothstep(1.0 - uForm * 1.05, 1.0 - uForm * 1.05 + 0.08, y);
          // A whirlwind (uPale) spins faster and reads as pale spray rather than dark cloud.
          float twist = vUv.x * 6.2831 * 3.0 + y * 18.0 - uTime * (2.4 + 1.6 * uPale);
          float n = wFbm(vec2(twist * 0.6 + uSeed, y * 30.0 - uTime * 1.6));
          vec3 V = normalize(cameraPosition - vW);
          float rim = 1.0 - abs(dot(normalize(vN), V));
          float body = (0.25 + 0.75 * rim) * (0.45 + 0.7 * n);
          float a = body * formed * (0.85 - 0.4 * smoothstep(0.7, 1.0, y)) * smoothstep(0.0, 0.03, y) * (1.0 - 0.3 * uPale);
          vec3 col = mix(vec3(0.32, 0.36, 0.4), vec3(0.62, 0.66, 0.68), uPale) * (0.35 + 0.55 * uMoonVis + 1.6 * uFlash) * (0.7 + 0.5 * n);
          float fd = uFogDensity * length(cameraPosition - vW) * 0.5;
          float seen = exp(-fd * fd);
          if (a * seen < 0.003) discard;
          gl_FragColor = vec4(mix(uFogColor, col, seen), a * (0.35 + 0.65 * seen));
        }`,
    });
    spoutMats.push(mat);
    const mesh = new THREE.Mesh(spoutGeo, mat);
    mesh.name = `waterspout-${i}`;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 9;
    mesh.layers.set(LAYERS.FX);
    root.add(mesh);
    return { mesh, mat, id: null, form: 0, x: 0, z: 0, r: 6, gone: 0, sprayT: 0 };
  });
  // The churning foot: a foam disc per spout.
  const footGeo = new THREE.PlaneGeometry(2, 2);
  footGeo.rotateX(-Math.PI / 2);
  const footMat = new THREE.ShaderMaterial({
    name: "NightRaidSpoutFoot", transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { ...shared, uK: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec2 vP; varying vec3 vW; attribute vec2 aK; varying vec2 vK;
      void main() { vP = position.xz; vK = aK; vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uMoonVis;
      varying vec2 vP; varying vec3 vW; varying vec2 vK;
      ${NOISE}
      void main() {
        float r = length(vP), th = atan(vP.y, vP.x);
        float s = th + uTime * 2.2 / max(r, 0.15) * 0.3 + log(max(r, 0.05)) * 2.0;
        float n = wFbm(vec2(s * 3.0 + vK.y, r * 6.0 - uTime));
        float a = smoothstep(1.0, 0.4, r) * smoothstep(0.45, 0.8, n) * vK.x;
        float fd = uFogDensity * length(cameraPosition - vW);
        a *= exp(-fd * fd);
        if (a < 0.003) discard;
        gl_FragColor = vec4(vec3(0.42, 0.48, 0.52) * (0.45 + 0.6 * uMoonVis), a * 0.8);
      }`,
  });
  const footK = new THREE.InstancedBufferAttribute(new Float32Array(SPOUTS * 2), 2).setUsage(THREE.DynamicDrawUsage);
  footGeo.setAttribute("aK", footK);
  const feet = new THREE.InstancedMesh(footGeo, footMat, SPOUTS);
  feet.name = "waterspout-feet"; feet.count = 0; feet.frustumCulled = false; feet.renderOrder = 3;
  feet.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  feet.layers.set(LAYERS.NOREFLECT);
  root.add(feet);

  // ---- Mortar rings ----
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);
  const ringK = new THREE.InstancedBufferAttribute(new Float32Array(MORTARS * 2), 2).setUsage(THREE.DynamicDrawUsage);
  ringGeo.setAttribute("aK", ringK);
  const ringMat = new THREE.ShaderMaterial({
    name: "NightRaidMortarRing", transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: shared.uTime },
    vertexShader: /* glsl */`
      attribute vec2 aK; varying vec2 vP; varying vec2 vK;
      void main() { vP = position.xz; vK = aK; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vP; varying vec2 vK;
      void main() {
        // vK.x: the shrinking ring's radius as a share of the quad (1 = the outer edge), the target circle at 1/3.
        float r = length(vP);
        float target = 1.0 / 3.0;
        float tq = (r - target) / 0.012;
        float rq = (r - vK.x) / 0.02;
        float t = exp(-tq * tq) * (0.55 + 0.45 * step(0.5, fract(atan(vP.y, vP.x) * 4.0)));
        float ring = exp(-rq * rq);
        float fill = smoothstep(target, 0.0, r) * 0.08 * (0.6 + 0.4 * sin(uTime * 12.0));
        float a = (t * 0.9 + ring * 1.4 + fill) * vK.y;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vec3(1.0, 0.28, 0.12) * a * 2.2, 1.0);
      }`,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, MORTARS);
  rings.name = "mortar-rings"; rings.count = 0; rings.frustumCulled = false; rings.renderOrder = 16;
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.layers.set(LAYERS.NOREFLECT);
  root.add(rings);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);

  // ---- Per frame ----
  function stormNow(state, squall = null) {
    let cell = null;
    const s = state?.storm;
    if (s && Number.isFinite(+s.x)) cell = { x: +s.x, z: +s.z, r: +s.r || 450, inside: !!s.inside, amt: 1 };
    else {
      const w = S.world?.storm;
      if (w && Number.isFinite(+w.x)) {
        const t = +state?.t || 0;
        cell = { x: +w.x + (+w.vx || 0) * t, z: +w.z + (+w.vz || 0) * t, r: +w.r || 450, inside: false, amt: 1 };
      }
    }
    // v4: a sea event's squall is a small storm cell (seaevents.js); `k` < 1 while it's only brewing. One cell is drawn:
    // with the bay's storm cell too (free roam at night) the one the lens is deeper in (the squall was never drawn there).
    if (squall && Number.isFinite(+squall.x) && +squall.k > 0.01) {
      const sq = { x: +squall.x, z: +squall.z, r: Math.max(40, +squall.r || 160), inside: false, amt: clamp(+squall.k, 0, 1), squall: true };
      if (!cell || cell.inside) return cell || sq;
      const depth = (c) => Math.hypot(_cam.x - c.x, _cam.z - c.z) / c.r;
      return depth(sq) < depth(cell) ? sq : cell;
    }
    return cell;
  }

  /**
   * Per frame. `extra` (v4, seaevents.js): {squall: {x, z, r, k} | null, spouts: [{id, x, z, r, h, formMax, pale}],
   * waves: [{id, x, z, dirDeg, eta, width}]} — the sea events' share, drawn with the storm's own pieces.
   */
  function update(state, dt, { ship = null, wind = null, extra = null } = {}) {
    S.time += dt;
    shared.uDay.value = R.atmos?.day || 0;
    R.camera.getWorldPosition(_cam);
    S.rings = Array.isArray(extra?.rings) ? extra.rings : [];      // v4: the sky whale's ring wave (critters.js draws it)
    const st = stormNow(state, extra?.squall);
    S.storm = st;
    // How deep in the storm the camera is (0 outside, 1 well inside); its strength on the water.
    let k = 0;
    if (st) {
      const d = Math.hypot(_cam.x - st.x, _cam.z - st.z);
      k = smooth(st.r * 1.05, st.r * 0.7, d) * st.amt;
      water.setStorm(st.x, st.z, st.r, st.amt);
      cloud.visible = true;
      // A squall's cloud hangs lower (it reads as a cell, not a ceiling).
      cloud.position.set(st.x, st.squall ? CLOUD_Y * 0.6 : CLOUD_Y, st.z);
      cloud.scale.set(st.r * 1.7, 1, st.r * 1.7);
      cloudMat.uniforms.uCentre.value.set(st.x, st.z);
      cloudMat.uniforms.uR.value = st.r;
      cloudMat.uniforms.uAmt.value = st.amt;
    } else { water.setStorm(0, 0, 1, 0); cloud.visible = false; }
    S.k += (k - S.k) * Math.min(1, dt * 0.8);
    // Rain.
    const n = Math.round((R.quality.rain || 0) * S.k);
    rainGeo.setDrawRange(0, n * 2);
    rain.visible = n > 0;
    rainMat.uniforms.uRain.value = S.k;
    rainMat.uniforms.uCam.value.copy(_cam);
    const wd = wind?.dirDeg ?? S.world?.wind?.dirDeg ?? 0, ws = wind?.strength ?? 0.8;
    const [wx, wz] = headingVec(wd + 180);
    rainMat.uniforms.uWind.value.set(wx * 7 * ws, wz * 7 * ws);
    // Sheet lightning in the cloud (nearby storms only).
    if (st) {
      const d = Math.hypot(_cam.x - st.x, _cam.z - st.z);
      S.sheetT -= dt;
      if (S.sheetT <= 0 && d < st.r * 3.5) { S.sheetT = 3 + Math.random() * 7; S.sheet = 1; }
    }
    S.sheet = Math.max(0, S.sheet - dt * 3.2);
    shared.uSheet.value = S.sheet * (0.6 + 0.4 * Math.sin(S.time * 40));

    // Lightning strikes.
    const lt = state?.hazards?.lightning;
    if (lt && Number.isFinite(+lt.x)) {
      const key = `${Math.round(+lt.x)},${Math.round(+lt.z)},${lt.t ?? ""}`;
      if (key !== S.strikeKey && !(+lt.eta > 0.05)) { S.strikeKey = key; strike(_v.set(+lt.x, WATER_Y, +lt.z), lt); }
    }
    stepBolt(dt);

    // Rogue wave(s).
    stepWaves(state, dt, ship, extra?.waves);
    // Waterspouts.
    stepSpouts(state, dt, extra?.spouts);
    // Mortars.
    const ms = state?.hazards?.mortars || [];
    let nm = 0;
    for (const m of ms) {
      if (nm >= MORTARS || !Number.isFinite(+m.x)) continue;
      if (m.ours || m.from === "rexmaw") continue;      // Rexmaw Raids: ours are overlays.js's gold rings
      const r = Math.max(4, +m.r || 12);
      const eta = Number.isFinite(+m.eta) ? +m.eta : 6;
      const k6 = clamp(eta / 6, 0, 1);
      _m.compose(_v.set(+m.x, WATER_Y + 0.08, +m.z), _q.identity(), _s.set(r * 3, 1, r * 3));
      rings.setMatrixAt(nm, _m);
      ringK.setXY(nm, 1 / 3 + (2 / 3) * k6, smooth(6.5, 5.5, eta) * 0.7 + 0.3);
      nm++;
    }
    rings.count = nm;
    if (nm) { rings.instanceMatrix.needsUpdate = true; ringK.needsUpdate = true; }
  }

  function strike(at, lt = {}) {
    // A strike on (or right by) the Rexmaw comes down her mainmast.
    const tgt = at.clone();
    if (lt.target === "rexmaw" || lt.mast) {
      const mast = R.shipSpace ? R.shipSpace.localToWorld(new THREE.Vector3(0, 26, 8)) : null;
      if (mast) tgt.copy(mast);
    }
    makeBolt(tgt);
    B.life = 0.75;
    const d = Math.hypot(_cam.x - at.x, _cam.z - at.z);
    const near = clamp(1 - d / 900, 0.15, 1);
    S.flash = 1.2 * near + 0.3;
    boltLight.position.set(at.x, CLOUD_Y, at.z);
    boltTarget.position.set(at.x, WATER_Y, at.z);
    cloudMat.uniforms.uStrike.value.copy(at);
    fx.burst(tgt.clone().setY(Math.max(tgt.y, WATER_Y + 0.5)), { color: "#cfe0ff", count: 50, speed: 7, size: 0.5, life: 0.6, intensity: 6, gravity: 0 });
    if (tgt.y <= WATER_Y + 1) fx.splash(tgt.clone(), { scale: 1.2 });
    if (d < 400) R.cam?.trauma?.(0.15 * (1 - d / 400) + 0.05);
  }

  function stepBolt(dt) {
    B.t += dt;
    const t = B.t;
    let I = 0;
    for (const s of B.strikes) {
      const e = t - s;
      if (e >= 0 && e < 0.12) I = Math.max(I, 1 - e / 0.12);
    }
    I = Math.max(I, t < B.life ? 0.25 * (1 - t / B.life) : 0);
    if (I > 0.001 && B.pts.length) { writeBolt(); bolt.visible = true; } else { bolt.visible = false; boltGeo.setDrawRange(0, 0); }
    boltMat.uniforms.uI.value = I * 9;
    S.flash = Math.max(0, S.flash - dt * 3.5);
    const flash = Math.max(S.flash * (0.6 + 0.4 * I), 0) + S.sheet * 0.15 * S.k;
    shared.uFlash.value = flash;
    boltLight.intensity = 6 * S.flash;
    R.post?.set({ flash: Math.min(1.6, flash * 1.1) }, { duration: 0 });
  }

  function stepWaves(state, dt, ship, extraWaves = null) {
    // v4: the hazard's wave plus a sea event's set (seaevents.js), one wall each (up to the pool).
    const list = [];
    const hw = state?.hazards?.wave;
    if (hw && Number.isFinite(+hw.x)) list.push(hw);
    for (const e of extraWaves || []) if (e && Number.isFinite(+e.x) && list.length < waveMeshes.length) list.push(e);
    const ids = new Set(list.map((e) => e.id ?? "wave"));
    for (const wv of list) {
      let w = waveMeshes.find((m) => m.id === (wv.id ?? "wave") && m.live) || null;
      if (!w) {
        w = waveMeshes.find((m) => !m.live) || waveMeshes.find((m) => !ids.has(m.id)) || null;
        if (!w) continue;
        Object.assign(w, { id: wv.id ?? "wave", live: true, rise: 0, gone: 0, sprayT: 0 });
        w.mesh.visible = true;
        w.lastX = +wv.x; w.lastZ = +wv.z;
      }
      // The way it rolls: toward the ship (dirDeg read as the travel heading; flipped if it points away).
      let dir = Number.isFinite(+wv.dirDeg) ? +wv.dirDeg : 0;
      if (ship && !wv.fixedDir) {
        const [hx, hz] = headingVec(dir);
        if (hx * (ship.x - +wv.x) + hz * (ship.z - +wv.z) < 0 && Math.hypot(ship.x - +wv.x, ship.z - +wv.z) > 30) dir += 180;
      }
      const moved = Math.hypot(+wv.x - w.lastX, +wv.z - w.lastZ);
      if (dt > 0 && moved > 0.01) w.speed = clamp(moved / Math.max(dt, 1 / 60), 4, 40) * 0.2 + w.speed * 0.8;
      w.lastX = +wv.x; w.lastZ = +wv.z;
      w.x = +wv.x; w.z = +wv.z; w.dir = dir;
      w.width = +wv.width || 300;
      // The telegraph: it rises out of the sea as it nears (12 s out: a long low swell with a white line).
      const eta = Number.isFinite(+wv.eta) ? +wv.eta : 6;
      w.rise = Math.max(w.rise, 0.25 + 0.75 * smooth(12, 3, eta));
      // A set still only brewing (a sea event's warn) stays a low swell with a white line.
      if (Number.isFinite(+wv.riseMax)) w.rise = Math.min(w.rise, clamp(+wv.riseMax, 0, 1));
    }
    for (const w of waveMeshes) {
      if (!w.live) continue;
      const still = ids.has(w.id);
      if (!still) {
        // Passed: it rolls on and settles.
        const [hx, hz] = headingVec(w.dir);
        w.x += hx * w.speed * dt; w.z += hz * w.speed * dt;
        w.gone += dt;
        w.rise = Math.max(0, 1 - w.gone / 7);
        if (w.rise <= 0) { w.live = false; w.mesh.visible = false; w.id = null; continue; }
      }
      w.mesh.position.set(w.x, WATER_Y - 0.15, w.z);
      w.mesh.rotation.set(0, -w.dir * DEG, 0);
      w.mat.uniforms.uWidth.value = w.width;
      w.mat.uniforms.uRise.value = w.rise;
      // Spray off the lip near the camera.
      w.sprayT -= dt;
      if (w.sprayT <= 0 && Math.hypot(w.x - _cam.x, w.z - _cam.z) < 500) {
        w.sprayT = 0.06 / mistShare();
        const [hx, hz] = headingVec(w.dir);
        const px = -hz, pz = hx;
        const s = (Math.random() - 0.5) * w.width * 0.7;
        _v.set(w.x + px * s + hx * 2, WATER_Y + WAVE.height * w.rise * 0.92, w.z + pz * s + hz * 2);
        fx.spray(_v, { dirX: hx, dirZ: hz, amount: 1.2 });
        if (Math.random() < 0.5) fx.steam(_v);          // spume torn off the lip
      }
    }
  }

  function stepSpouts(state, dt, extra = null) {
    // v4: a sea event's spouts and whirlwinds join the storm's: `colR` (the column's radius), `h` (cloud base height),
    // `formMax` (a warn holds the funnel part-way down from the cloud), `pale` (a whirlwind).
    const list = extra?.length ? [...(state?.hazards?.spouts || []), ...extra] : state?.hazards?.spouts || [];
    const seen = new Set();
    for (const s of list) {
      if (s?.id == null || !Number.isFinite(+s.x)) continue;
      seen.add(s.id);
      let sp = spouts.find((p) => p.id === s.id);
      if (!sp) {
        sp = spouts.find((p) => p.id == null) || null;
        if (!sp) continue;
        Object.assign(sp, { id: s.id, form: 0, gone: 0 });
      }
      sp.x = +s.x; sp.z = +s.z; sp.r = Number.isFinite(+s.colR) ? Math.max(2, +s.colR) : Math.max(3, (+s.r || 12) * 0.4);
      const cap = Number.isFinite(+s.formMax) ? clamp(+s.formMax, 0, 1) : 1;
      sp.form = sp.form > cap ? Math.max(cap, sp.form - dt / 2) : Math.min(cap, sp.form + dt / 4);
      sp.mat.uniforms.uH.value = Number.isFinite(+s.h) ? Math.max(20, +s.h) : CLOUD_Y - WATER_Y;
      sp.mat.uniforms.uPale.value = s.pale ? 1 : 0;
    }
    let nf = 0;
    for (const sp of spouts) {
      if (sp.id == null) { sp.mesh.visible = false; continue; }
      if (!seen.has(sp.id)) {
        sp.gone += dt;
        sp.form = Math.max(0, sp.form - dt / 2.5);
        if (sp.form <= 0) { sp.id = null; sp.mesh.visible = false; continue; }
      }
      sp.mesh.visible = true;
      sp.mesh.position.set(sp.x, WATER_Y, sp.z);
      sp.mat.uniforms.uForm.value = sp.form;
      sp.mat.uniforms.uR.value = sp.r;
      if (nf < SPOUTS) {
        const R0 = sp.r * 5 * smooth(0.6, 1, sp.form);
        _m.compose(_v.set(sp.x, WATER_Y + 0.06, sp.z), _q.identity(), _s.set(Math.max(0.01, R0), 1, Math.max(0.01, R0)));
        feet.setMatrixAt(nf, _m);
        footK.setXY(nf, smooth(0.6, 1, sp.form), sp.mat.uniforms.uSeed.value);
        nf++;
      }
      // Spray at the foot: by the tier's share, thinning with distance (12 bursts/s × 15 motes per funnel, plus a
      // second emitter in seaevents.js, kept ~1800 motes live round a pair of spouts: the frame rate halved).
      const dCam = Math.hypot(sp.x - _cam.x, sp.z - _cam.z);
      if (sp.form > 0.7 && dCam < 600 && Math.random() < dt * 7 * mistShare() * (1 - 0.6 * dCam / 600)) {
        const a = Math.random() * Math.PI * 2;
        _v.set(sp.x + Math.cos(a) * sp.r * 1.5, WATER_Y + 0.5, sp.z + Math.sin(a) * sp.r * 1.5);
        fx.spray(_v, { dirX: -Math.sin(a), dirZ: Math.cos(a), amount: 1.3 });
      }
    }
    feet.count = nf;
    if (nf) { feet.instanceMatrix.needsUpdate = true; footK.needsUpdate = true; }
  }

  return {
    root,
    /** The world (for the storm's drift when state.storm is absent, and the wind). */
    setWorld(world) { S.world = world || null; S.strikeKey = null; },
    update,
    /** 0..1: how deep in the storm the camera is (eased). */
    get storminess() { return S.k; },
    /** The storm now: {x, z, r} or null. */
    get storm() { return S.storm; },
    /** A strike now at world (x, z) (debug / events). */
    strike(x, z, o = {}) { strike(new THREE.Vector3(+x || 0, WATER_Y, +z || 0), o); },
    /** The rogue waves' extra height at (x, z) (m), for the ship to ride. */
    waveHeightAt(x, z) {
      let h = 0;
      for (const w of waveMeshes) {
        if (!w.live || w.rise <= 0) continue;
        const [hx, hz] = headingVec(w.dir);
        const u = (x - w.x) * hx + (z - w.z) * hz;
        const v = (x - w.x) * -hz + (z - w.z) * hx;
        const ends = smooth(0.5, 0.36, Math.abs(v / Math.max(1, w.width)));
        h = Math.max(h, waveProfile(u) * ends * w.rise);
      }
      // A ring wave (the whale's belly-flop): a bump `h` m high, `band` m wide, `r` m out from its centre.
      for (const g of S.rings || []) {
        if (!Number.isFinite(+g.r) || !Number.isFinite(+g.h)) continue;
        const q = (Math.hypot(x - g.x, z - g.z) - g.r) / Math.max(1, +g.band || 9);
        if (Math.abs(q) < 2.5) h = Math.max(h, +g.h * Math.exp(-q * q * 1.6));
      }
      return h;
    },
    /** The live rogue wave (for cameras): {x, z, dir} or null. */
    get wave() { const w = waveMeshes.find((m) => m.live); return w ? { x: w.x, z: w.z, dir: w.dir, rise: w.rise } : null; },
    warmShow(on) {
      cloud.visible = on || !!S.storm;
      for (const w of waveMeshes) w.mesh.visible = on || w.live;
      for (const s of spouts) s.mesh.visible = on || s.id != null;
      feet.count = on ? Math.max(1, feet.count) : feet.count;
      rings.count = on ? Math.max(1, rings.count) : rings.count;
      bolt.visible = on;
      if (on) { boltGeo.setDrawRange(0, 6); rainGeo.setDrawRange(0, 2); rain.visible = true; }
    },
    reset() {
      for (const w of waveMeshes) { w.live = false; w.mesh.visible = false; w.id = null; }
      for (const s of spouts) { s.id = null; s.mesh.visible = false; }
      feet.count = 0; rings.count = 0; S.flash = 0; S.sheet = 0; S.k = 0; B.pts = []; B.t = 9;
    },
    dispose() {
      root.removeFromParent(); boltLight.removeFromParent(); boltTarget.removeFromParent();
      for (const g of [cloudGeo, rainGeo, boltGeo, waveGeo, spoutGeo, footGeo, ringGeo]) g.dispose();
      for (const m of [cloudMat, rainMat, boltMat, ...waveMeshes.map((w) => w.mat), footMat, ringMat, ...spoutMats]) m.dispose();
    },
  };
}
