// Rexmaw Raids v4: the random sea events (spec §3), drawn from the core's `state.events`.
//
// Every event is {id, kind, stage: "warn" | "active" | "over", x, z, r?, dirDeg?, ...}; while `warn` it shows a
// telegraph, while `active` the real thing, and it settles away after `over` (or once it leaves the list). Kinds
// (read forgivingly: "waterspout", "whirlwind", "squall", "rogue_set", "derelict", "treasure", "kraken_arm", "fog"):
//
//   spout / whirlwind  each funnel of the event (`spouts: [{id, x, z, r, pullR}]`, else one at x, z) on weather.js's
//              funnel (a whirlwind paler, quicker, shorter) under its own dark churning cloud base (`h` m up), a
//              ring of spray skirting the foot, a spiral of foam on the water across `pullR`. Its hazards.spouts
//              mirror is dropped (world.js). Warn: the cloud base forms, the funnel hangs half-way down, the
//              spiral turns. They wander as the core moves x/z (a little sway of their own besides).
//   squall     a small storm cell: weather.js's cloud (lower), its rain round the camera, the choppy darker water
//              and the storm grade, plus a grey rain curtain under the cell seen from outside and gusts (spray
//              streaks, a shove of the lens) inside; `intensity`, `visibility` honoured. Warn: the cell at half,
//              the curtain grey on the horizon.
//   waves      live, the core's own walls (state.hazards.wave, the v3 wave) — nothing extra; an event carrying
//              `waves` [{id, x, z, dirDeg, eta, width}] draws those; with no wave data at all (older cores) three
//              walls ~70 m apart roll from x, z along `dirDeg`. Warn: a low swell breaking white ~260 m up the
//              way the set comes from (the v4 core's x, z follow the Rexmaw).
//   derelict   a fleet hull (`cls`, default merchant), listing, canvas torn, a mast gone, dark, no crew: the
//              event's `contactId` when the core lists her as a contact (she's flagged derelict), else a stand-in
//              hull at x, z (`heading`). Warn: mist drifting off her.
//   treasure   a field of gold glints over `r` (the loot itself is the core's pickups, drawn by pickups.js), a
//              scatter of flotsam when it goes live. Warn: a few bright glints far off.
//   kraken     a lone arm via kraken.js (tremor → rise → up → sink): `armId` (default the event id); `hp` > 0
//              makes it a weak point world.pick can hit. Warn: the tremor (bubbles, light from below) and a dark
//              spiral on the water.
//   fog        a rolling bank: a wall of upright mist billboards across `r` (perpendicular to `dirDeg` when given)
//              that drifts with x, z; inside it the scene's visibility closes to ~140 m. Warn: the wall far off.
//
//   gerald · sky_whale · dolphins · flying_fish · jellyfish · turtle · admiral   the whacky ones: their creatures are
//              critters.js's (stepped from here per event; the whale's ring wave joins weather.js's heights via
//              `extra.rings`; their marks on the water use this module's swirl pool).
//
// Every event also pulses a ring of light across the water from its spot every few seconds while it warns.
// Pooled at fixed sizes, NaN-safe (every number from the state passes Number.isFinite), no compile mid-voyage
// (warmShow shows everything for the compile).

import * as THREE from "three";
import { LAYERS, WATER_Y, headingVec } from "./blocking.js";
import { SEA_HEIGHT_GLSL } from "./water.js";
import { hash } from "./util.js";
import { createCritters } from "./critters.js";

const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fin = (v) => Number.isFinite(+v);
const CLOUDS = 4, SKIRTS = 4, SWIRLS = 8, CURTAINS = 2, FOGS = 40, GLINTS = 160;
const NO_VIS = 2000;
const TELEGRAPH = { spout: "#9fb4c8", whirlwind: "#c8d4dc", squall: "#8fa0b8", waves: "#dfe8ff", derelict: "#7fd8b8", treasure: "#ffd27a", kraken: "#3ff3e0", fog: "#c8d0dc",
  gerald: "#ff6a4a", sky_whale: "#8fd0ff", dolphins: "#9fe8ff", flying_fish: "#9fd0ff", jellyfish: "#b06bff", turtle: "#8fd68a", admiral: "#ffe08a" };
/** The whacky kinds (critters.js draws them). */
const WHACKY = new Set(["gerald", "sky_whale", "dolphins", "flying_fish", "jellyfish", "turtle", "admiral"]);

const NOISE = /* glsl */`
  float eHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float eNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(eHash(i), eHash(i + vec2(1.0, 0.0)), u.x), mix(eHash(i + vec2(0.0, 1.0)), eHash(i + vec2(1.0, 1.0)), u.x), u.y); }
  float eFbm(vec2 p) { return eNoise(p) * 0.5 + eNoise(p * 2.03 + 5.2) * 0.3 + eNoise(p * 4.1 - 2.7) * 0.2; }`;

/** An event's kind, read forgivingly; null for kinds the scene doesn't draw. */
export function eventKind(e) {
  const k = String(e?.kind ?? e?.type ?? "").toLowerCase();
  if (/gerald|megalodon|shark/.test(k)) return "gerald";
  if (/whale/.test(k)) return "sky_whale";
  if (/dolphin/.test(k)) return "dolphins";
  if (/flying_?fish/.test(k)) return "flying_fish";
  if (/jelly/.test(k)) return "jellyfish";
  if (/turtle/.test(k)) return "turtle";
  if (/admiral|gull/.test(k)) return "admiral";
  if (/whirl|dust_?devil/.test(k)) return "whirlwind";
  if (/spout|twister|tornado/.test(k)) return "spout";
  if (/squall|rain|gust/.test(k)) return "squall";
  if (/rogue|wave/.test(k)) return "waves";
  if (/derelict|wreck|ghost_?ship|abandon/.test(k)) return "derelict";
  if (/treasure|flotsam|loot|field|bounty/.test(k)) return "treasure";
  if (/kraken|tentacle|arm/.test(k)) return "kraken";
  if (/fog|mist|haar/.test(k)) return "fog";
  return null;
}
/** "warn" | "active" | "over". */
export function eventStage(e) {
  const s = String(e?.stage ?? e?.state ?? "active").toLowerCase();
  if (/warn|tele|brew|incoming|soon|form/.test(s)) return "warn";
  if (/over|end|done|fade|gone|expire|clear|past|finish/.test(s)) return "over";
  return "active";
}

/**
 * @param {object} R  the render context
 * @param {{water: object, fx: object}} deps
 */
export function createSeaEvents(R, { water, fx }) {
  const root = new THREE.Group();
  root.name = "sea-events";
  R.scene.add(root);
  const wu = water?.uniforms || {};
  const time = wu.uTime || { value: 0 };
  const shared = { uTime: time, uFogDensity: wu.uFogDensity || { value: 0 }, uFogColor: wu.uFogColor || { value: new THREE.Color() }, uMoonVis: wu.uMoonVis || { value: 1 }, uDay: { value: 0 } };
  const disposables = [];
  /** The tier's share of spray (quality.mist over High's 5000: Low 0.3, Medium 0.6, High 1). */
  const mistShare = () => clamp((R.quality?.mist || 5000) / 5000, 0.2, 1);

  // ---- A spout's cloud base: a dark disc churning round its centre ----
  const cloudGeo = new THREE.CircleGeometry(1, 48);
  cloudGeo.rotateX(Math.PI / 2);
  disposables.push(cloudGeo);
  const clouds = Array.from({ length: CLOUDS }, (_, i) => {
    const mat = new THREE.ShaderMaterial({
      name: "RexmawEventCloud", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { ...shared, uAmt: { value: 0 }, uSeed: { value: i * 3.1 }, uSpin: { value: 1 } },
      vertexShader: /* glsl */`
        varying vec2 vL; varying vec3 vW;
        void main() { vL = position.xz; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uFogDensity, uMoonVis, uDay, uAmt, uSeed, uSpin;
        uniform vec3 uFogColor;
        varying vec2 vL; varying vec3 vW;
        ${NOISE}
        void main() {
          float r = length(vL);
          float th = atan(vL.y, vL.x);
          // Swirling in toward the funnel: the angle winds tighter near the centre.
          float s = th + 2.6 * (1.0 - r) * uSpin + uTime * 0.18 * uSpin;
          float n = eFbm(vec2(s * 2.2 + uSeed, r * 5.0 - uTime * 0.12));
          float body = smoothstep(1.0, 0.45, r + (n - 0.5) * 0.35);
          vec3 night = mix(vec3(0.010, 0.013, 0.018), vec3(0.04, 0.045, 0.055), n) * (0.6 + 0.6 * uMoonVis);
          vec3 day = mix(vec3(0.16, 0.17, 0.19), vec3(0.32, 0.33, 0.36), n);
          vec3 col = mix(night, day, uDay);
          float fd = uFogDensity * length(cameraPosition - vW) * 0.45;
          float seen = exp(-fd * fd);
          float a = body * uAmt * mix(0.25, 0.95, seen);
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(uFogColor, col, seen), a);
        }`,
    });
    const mesh = new THREE.Mesh(cloudGeo, mat);
    mesh.name = `event-cloud-${i}`;
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = -4;
    mesh.layers.set(LAYERS.FX);
    root.add(mesh);
    disposables.push(mat);
    return { mesh, mat, id: null };
  });

  // ---- A spray skirt round a funnel's foot (and a squall's rain curtain: the same open cylinder, streaked) ----
  const skirtGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 6, true);
  skirtGeo.translate(0, 0.5, 0);
  disposables.push(skirtGeo);
  const veil = (name, rain) => new THREE.ShaderMaterial({
    name, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    uniforms: { ...shared, uAmt: { value: 0 }, uR: { value: 10 }, uH: { value: 10 }, uFlare: { value: rain ? 0.05 : 0.7 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */`
      uniform float uR, uH, uFlare;
      varying vec2 vUv; varying vec3 vW; varying vec3 vN;
      void main() {
        vUv = uv;
        float y = position.y;
        float r = uR * (1.0 + uFlare * y);
        vec4 w = modelMatrix * vec4(position.x * r, y * uH, position.z * r, 1.0);
        vW = w.xyz;
        vN = normalize(vec3(position.x, 0.0, position.z) + 1e-5);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uMoonVis, uDay, uAmt, uSeed;
      uniform vec3 uFogColor;
      varying vec2 vUv; varying vec3 vW; varying vec3 vN;
      ${NOISE}
      void main() {
        float y = vUv.y;
        // Seen edge-on (the tube's silhouette) the sheet thins out: no hard outline where front and back overlap.
        vec3 V = normalize(cameraPosition - vW);
        float facing = smoothstep(0.05, 0.45, abs(dot(vN, V)));
        ${rain ? `
        // Rain: a soft grey veil (big slow billows) combed into tall thin streaks falling; heavier toward the sea,
        // thinning into the cloud above. The streak cells are stretched tall (600 round, under one up) so they never block.
        float veil = 0.45 + 0.55 * eFbm(vec2(vUv.x * 36.0 + uSeed, y * 1.4 + uTime * 0.25));
        float comb = 0.65 + 0.35 * eNoise(vec2(vUv.x * 600.0 + uSeed, y * 0.7 + uTime * 1.6));
        float a = 0.95 * veil * comb * smoothstep(1.0, 0.5, y) * smoothstep(0.0, 0.05, y) * facing;
        vec3 col = mix(vec3(0.06, 0.07, 0.09) * (0.6 + 0.8 * uMoonVis), vec3(0.3, 0.33, 0.38), uDay);` : `
        // Spray: torn white curtains whirling up off the sea.
        float n = eFbm(vec2(vUv.x * 14.0 + uTime * 1.9 + uSeed, y * 3.0 - uTime * 1.3));
        float a = smoothstep(0.4, 0.82, n) * pow(1.0 - y, 1.4) * smoothstep(0.0, 0.05, y) * (0.4 + 0.6 * facing);
        vec3 col = mix(vec3(0.42, 0.47, 0.52) * (0.4 + 0.7 * uMoonVis), vec3(0.85, 0.88, 0.9), uDay);`}
        // A third of the scene's fog (a cell of rain is a big dark thing: it should read from the horizon).
        float fd = uFogDensity * length(cameraPosition - vW) * ${rain ? "0.3" : "0.5"};
        float seen = exp(-fd * fd);
        a *= uAmt * mix(0.2, 1.0, seen);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uFogColor, col, seen), clamp(a, 0.0, 0.85));
      }`,
  });
  const skirts = Array.from({ length: SKIRTS }, (_, i) => {
    const mat = veil("RexmawEventSpray", false);
    mat.uniforms.uSeed.value = i * 7.3;
    const mesh = new THREE.Mesh(skirtGeo, mat);
    mesh.name = `event-spray-${i}`;
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 8;
    mesh.layers.set(LAYERS.NOREFLECT);
    root.add(mesh);
    disposables.push(mat);
    return { mesh, mat, id: null };
  });
  const curtains = Array.from({ length: CURTAINS }, (_, i) => {
    const mat = veil("RexmawEventRain", true);
    mat.uniforms.uSeed.value = i * 11.7;
    const mesh = new THREE.Mesh(skirtGeo, mat);
    mesh.name = `event-rain-${i}`;
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 7;
    mesh.layers.set(LAYERS.NOREFLECT);
    root.add(mesh);
    disposables.push(mat);
    return { mesh, mat, id: null };
  });

  // ---- A spiral on the water (a funnel's foot, the Kraken's tremor): foam streaks winding in, darker at the eye ----
  const swirlGeo = new THREE.RingGeometry(0, 1, 96, 6);
  swirlGeo.rotateX(-Math.PI / 2);
  disposables.push(swirlGeo);
  const swirls = Array.from({ length: SWIRLS }, (_, i) => {
    const mat = new THREE.ShaderMaterial({
      name: "RexmawEventSwirl", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: { ...shared, uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uChopA: wu.uChopA, uChopB: wu.uChopB,
        uAmt: { value: 0 }, uColor: { value: new THREE.Color() }, uSpin: { value: 1 }, uSeed: { value: i * 2.3 }, uDark: { value: 0.4 } },
      vertexShader: /* glsl */`
        uniform float uTime;
        ${SEA_HEIGHT_GLSL}
        varying vec2 vL; varying vec3 vW;
        void main() {
          vL = position.xz;
          vec4 w = modelMatrix * vec4(position, 1.0);
          w.y = ${WATER_Y.toFixed(2)} + seaHeight(w.xz) + 0.1;
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uFogDensity, uMoonVis, uDay, uAmt, uSpin, uSeed, uDark;
        uniform vec3 uColor, uFogColor;
        varying vec2 vL; varying vec3 vW;
        ${NOISE}
        void main() {
          float r = max(length(vL), 1e-3);
          float th = atan(vL.y, vL.x);
          float s = th * 2.0 + log(r) * 4.5 * uSpin + uTime * 1.6 * uSpin;
          float n = eFbm(vec2(s * 1.6 + uSeed, r * 7.0 - uTime * 0.6));
          float edge = smoothstep(1.0, 0.7, r);
          float streak = smoothstep(0.55, 0.85, n) * edge * smoothstep(0.03, 0.2, r);
          float eye = smoothstep(0.55, 0.0, r) * uDark;
          vec3 foam = uColor * mix(0.35 + 0.55 * uMoonVis, 1.2, uDay);
          float a = max(streak * 0.75, eye) * uAmt;
          float fd = uFogDensity * length(cameraPosition - vW) * 0.4;
          float seen = exp(-fd * fd);
          a *= seen;
          if (a < 0.004) discard;
          vec3 col = mix(vec3(0.0, 0.004, 0.008), foam, streak / max(streak + eye, 1e-3));
          gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
        }`,
    });
    const mesh = new THREE.Mesh(swirlGeo, mat);
    mesh.name = `event-swirl-${i}`;
    mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 3;
    mesh.layers.set(LAYERS.NOREFLECT);
    root.add(mesh);
    disposables.push(mat);
    return { mesh, mat, id: null };
  });

  // ---- The whacky ones' creatures (critters.js); their marks on the water borrow the swirls above ----
  let frameNo = 0;
  /** A helper swirl for a creature (slot "<event id>|<name>"): shown this frame only (released when not asked again). */
  function helperSwirl(slot, x, z, scale, amt, color, spin = 1, dark = 0.4) {
    if (!fin(x) || !fin(z) || !fin(scale)) return;
    const sw = claim(swirls, slot);
    if (!sw) return;
    sw.id = slot; sw.helper = frameNo;
    sw.mesh.visible = amt > 0.01;
    sw.mesh.position.set(x, WATER_Y, z);
    sw.mesh.scale.setScalar(Math.max(1, scale));
    sw.mat.uniforms.uAmt.value = clamp(amt, 0, 1);
    sw.mat.uniforms.uColor.value.set(color);
    sw.mat.uniforms.uSpin.value = spin;
    sw.mat.uniforms.uDark.value = dark;
  }
  const critters = createCritters(R, { water, fx, swirl: helperSwirl });

  // ---- A rolling fog bank: upright mist billboards (yaw-only), world-placed each frame ----
  const fogGeo = new THREE.PlaneGeometry(1, 1);
  fogGeo.translate(0, 0.5, 0);
  const fogAttr = new THREE.InstancedBufferAttribute(new Float32Array(FOGS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  fogGeo.setAttribute("aBank", fogAttr);
  disposables.push(fogGeo);
  const fogMat = new THREE.ShaderMaterial({
    name: "RexmawEventFog", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    uniforms: { ...shared, uAmt: { value: 0 }, uColor: { value: new THREE.Color("#8d96a3") } },
    vertexShader: /* glsl */`
      attribute vec4 aBank;   // world x, z, width, seed
      varying vec2 vUv; varying float vSeed; varying float vNear; varying float vH;
      void main() {
        vUv = uv; vSeed = aBank.w; vH = position.y;
        vec3 c = vec3(aBank.x, ${WATER_Y.toFixed(2)} - 0.5, aBank.y);
        vec3 toCam = cameraPosition - c; toCam.y = 0.0;
        float l = max(length(toCam), 1e-3);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x) / l;
        float w = aBank.z, h = w * (0.24 + 0.1 * fract(aBank.w * 7.3));
        vec3 wp = c + right * position.x * w + vec3(0.0, position.y * h, 0.0);
        vNear = smoothstep(14.0, 60.0, l);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAmt, uMoonVis, uDay; uniform vec3 uColor;
      varying vec2 vUv; varying float vSeed; varying float vNear; varying float vH;
      ${NOISE}
      void main() {
        vec2 q = vUv * vec2(3.0, 1.2) + vec2(vSeed * 13.0 + uTime * 0.03, vSeed * 5.0);
        float n = eFbm(q) * 0.75 + eFbm(q * 2.7 - uTime * 0.04) * 0.35;
        float side = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        // The foot fades in over the bottom third: where the upright card cuts the sea there's no hard line.
        float body = smoothstep(1.0, 0.3, vH) * smoothstep(0.0, 0.32, vH);
        float a = smoothstep(0.28, 0.75, n) * side * body * uAmt * vNear * 0.85;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * (0.9 + 0.25 * n), a);
      }`,
  });
  const fogs = new THREE.InstancedMesh(fogGeo, fogMat, FOGS);
  fogs.name = "event-fog"; fogs.count = 0; fogs.frustumCulled = false; fogs.renderOrder = 9;
  fogs.layers.set(LAYERS.NOREFLECT);
  { const id = new THREE.Matrix4(); for (let i = 0; i < FOGS; i++) fogs.setMatrixAt(i, id); }
  root.add(fogs);
  disposables.push(fogMat);

  // ---- Gold glints over a treasure field ----
  const glintGeo = new THREE.BufferGeometry();
  const gPos = new Float32Array(GLINTS * 3), gSeed = new Float32Array(GLINTS);
  glintGeo.setAttribute("position", new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage));
  glintGeo.setAttribute("aSeed", new THREE.BufferAttribute(gSeed, 1).setUsage(THREE.DynamicDrawUsage));
  glintGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  glintGeo.setDrawRange(0, 0);
  disposables.push(glintGeo);
  const glintMat = new THREE.ShaderMaterial({
    name: "RexmawEventGlints", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { ...shared, uScale: { value: 900 }, uAmt: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uTime, uScale; varying float vK; varying float vD;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = pow(max(0.0, sin(uTime * (1.3 + fract(aSeed * 3.7) * 1.8) + aSeed * 40.0)), 10.0);
        vK = tw;
        vD = -mv.z;
        gl_PointSize = clamp(uScale * (0.8 + 1.6 * tw) / max(-mv.z, 1.0), 1.5, 26.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFogDensity, uAmt, uDay; varying float vK; varying float vD;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float star = max(exp(-abs(c.x) * 9.0) * exp(-abs(c.y) * 1.6), exp(-abs(c.y) * 9.0) * exp(-abs(c.x) * 1.6));
        float core = exp(-dot(c, c) * 7.0);
        float fd = uFogDensity * vD * 0.35;
        float a = (star * 0.8 + core) * (0.25 + 1.4 * vK) * uAmt * exp(-fd * fd);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vec3(1.0, 0.82, 0.42) * a * mix(2.2, 3.2, uDay), 1.0);
      }`,
  });
  const glints = new THREE.Points(glintGeo, glintMat);
  glints.name = "event-glints"; glints.frustumCulled = false; glints.renderOrder = 12;
  glints.layers.set(LAYERS.NOREFLECT);
  root.add(glints);
  disposables.push(glintMat);

  // ---- State ----
  const recs = new Map();     // event id → record
  const E = { visibility: NO_VIS, squallIn: 0, fogIn: 0, gustT: 2, extra: { squall: null, spouts: [], waves: [] }, contacts: [], arms: [], derelicts: new Map(), spoutIds: new Set(), spoutEvents: [], fogAmt: 0 };
  const _v = new THREE.Vector3(), _cam = new THREE.Vector3(), _m = new THREE.Matrix4();

  function claim(pool, id) { return pool.find((p) => p.id === id) || pool.find((p) => p.id == null) || null; }
  function release(pool, id) { for (const p of pool) if (p.id === id || String(p.id).startsWith(`${id}|`)) { p.id = null; p.mesh.visible = false; } }

  function record(e, kind) {
    const id = String(e.id ?? `${kind}-${Math.round(+e.x)}-${Math.round(+e.z)}`);
    let rec = recs.get(id);
    if (!rec) {
      rec = { id, kind, stage: "warn", k: 0, warnK: 0, liveK: 0, t: 0, liveT: 0, pulseT: 0.2, seed: (hash(id) % 1000) / 1000, x: +e.x, z: +e.z, gone: false, ev: e, fired: {} };
      recs.set(id, rec);
    }
    return rec;
  }

  /** Per frame: the events, before weather / fleet / kraken read their share (see `extra`, `contacts`, `arms`). */
  function update(st, dt) {
    const d = clamp(+dt || 0, 0, 0.1);
    R.camera.getWorldPosition(_cam);
    shared.uDay.value = R.atmos?.day || 0;
    const list = Array.isArray(st?.events) ? st.events : [];
    for (const r of recs.values()) r.seen = false;
    for (const e of list) {
      if (!e || !fin(e.x) || !fin(e.z)) continue;
      const kind = eventKind(e);
      if (!kind) continue;
      const rec = record(e, kind);
      rec.seen = true; rec.ev = e;
      rec.stage = eventStage(e);
      rec.x = +e.x; rec.z = +e.z;
    }
    const sh = st?.ship;
    frameNo++;
    critters.begin(d);
    E.extra = { squall: null, spouts: [], waves: [], rings: critters.rings };
    E.contacts = []; E.arms = []; E.derelicts.clear(); E.fogAmt = 0; E.spoutIds.clear();
    E.spoutEvents = [...recs.values()].filter((r) => r.seen && (r.kind === "spout" || r.kind === "whirlwind")).map((r) => r.id);
    let vis = NO_VIS, squallIn = 0, fogIn = 0;
    const hazardWave = !!(st?.hazards?.wave && fin(st.hazards.wave.x));
    for (const rec of [...recs.values()]) {
      const live = rec.seen && rec.stage !== "over";
      rec.t += d;
      rec.k += ((live ? 1 : 0) - rec.k) * Math.min(1, d / (live ? 1.2 : 2.5));
      rec.warnK += ((rec.seen && rec.stage === "warn" ? 1 : 0) - rec.warnK) * Math.min(1, d / 1.2);
      rec.liveK += ((rec.seen && rec.stage === "active" ? 1 : 0) - rec.liveK) * Math.min(1, d / 1.5);
      if (rec.stage === "active" && rec.seen) rec.liveT += d;
      if (!live && rec.k < 0.01) { drop(rec); continue; }
      const e = rec.ev || {};
      const dCam = Math.hypot(rec.x - _cam.x, rec.z - _cam.z);
      // The telegraph: a ring of light across the water from the spot, every few seconds while it warns.
      if (rec.seen && rec.stage === "warn" && dCam < 1300) {
        rec.pulseT -= d;
        if (rec.pulseT <= 0) { rec.pulseT = 3.2; water?.pulse?.({ x: rec.x, z: rec.z, color: TELEGRAPH[rec.kind], speed: Math.max(7, (+e.r || 60) / 4), intensity: 0.55 }); }
      }
      if (rec.kind === "spout" || rec.kind === "whirlwind") stepSpout(rec, e, dCam, d);
      else if (rec.kind === "squall") { const v = stepSquall(rec, e, d); squallIn = Math.max(squallIn, v.inK); vis = Math.min(vis, v.vis); }
      else if (rec.kind === "waves") stepWaves(rec, e, sh, hazardWave);
      else if (rec.kind === "derelict") stepDerelict(rec, e, st, d, dCam);
      else if (rec.kind === "treasure") stepTreasure(rec, e, d, dCam);
      else if (rec.kind === "kraken") stepKraken(rec, e, d, dCam);
      else if (rec.kind === "fog") { const v = stepFog(rec, e); fogIn = Math.max(fogIn, v.inK); vis = Math.min(vis, v.vis); }
      else if (WHACKY.has(rec.kind)) critters.step(rec, e, d);
    }
    critters.finish(d);
    // The creatures' marks not asked for this frame go back to the pool.
    for (const sw of swirls) if (sw.helper != null && sw.helper !== frameNo) { sw.helper = null; sw.id = null; sw.mesh.visible = false; }
    writeGlints();
    writeFogs();
    E.visibility = vis; E.squallIn = squallIn; E.fogIn = fogIn;
  }

  function drop(rec) {
    for (const pool of [clouds, skirts, curtains, swirls]) release(pool, rec.id);
    recs.delete(rec.id);
  }

  // ---- Spouts and whirlwinds ----
  // The core's spout event carries 1–2 funnels (`spouts: [{id, x, z, r, pullR}]`, mirrored into hazards.spouts with
  // the same ids): the scene draws them here instead (world.js drops the mirrors), each under its own cloud base.
  function stepSpout(rec, e, dCam, d) {
    const subs = Array.isArray(e.spouts) && e.spouts.length ? e.spouts : [{ id: null, x: rec.x, z: rec.z, r: e.r, pullR: e.pullR }];
    subs.forEach((sp, i) => {
      if (!sp || !fin(sp.x) || !fin(sp.z)) return;
      const sid = String(sp.id ?? `${rec.id}s${i + 1}`);
      E.spoutIds.add(sid);
      stepFunnel(rec, `${rec.id}|${i}`, sid, +sp.x, +sp.z, fin(sp.r) ? +sp.r : null, fin(sp.pullR) ? +sp.pullR : (fin(e.pullR) ? +e.pullR : null), e, dCam, d, i);
    });
  }
  function stepFunnel(rec, slot, sid, sx, sz, r0, pullR, e, dCam, d, i) {
    const whirl = rec.kind === "whirlwind";
    const colR = fin(e.colR) ? +e.colR : r0 != null ? Math.max(3, r0 * 0.4) : whirl ? 3.5 : 6;
    const reach = pullR ?? (whirl ? 40 : 80);
    const h = fin(e.h) ? +e.h : whirl ? 75 : 115;
    // A little wander of its own over the core's track (the funnel's foot never sits still).
    const wx = Math.sin(rec.t * 0.21 + rec.seed * 9 + i) * 4, wz = Math.cos(rec.t * 0.17 + rec.seed * 5 + i) * 4;
    const x = sx + wx, z = sz + wz;
    const k = rec.k;
    if (rec.seen && rec.stage !== "over") E.extra.spouts.push({ id: sid, x, z, colR, h, formMax: rec.stage === "warn" ? 0.5 : 1, pale: whirl });
    const cl = claim(clouds, slot);
    if (cl) {
      cl.id = slot;
      const R0 = whirl ? 45 : 80;
      cl.mesh.visible = k > 0.01;
      cl.mesh.position.set(x, WATER_Y + h, z);
      cl.mesh.scale.set(R0, 1, R0);
      cl.mat.uniforms.uAmt.value = k * (whirl ? 0.6 : 0.95);
      cl.mat.uniforms.uSpin.value = whirl ? 1.6 : 1;
    }
    const sk = claim(skirts, slot);
    if (sk) {
      sk.id = slot;
      const amt = rec.liveK * k;
      sk.mesh.visible = amt > 0.01;
      sk.mesh.position.set(x, WATER_Y - 0.4, z);
      sk.mat.uniforms.uR.value = colR * 1.8;
      sk.mat.uniforms.uH.value = whirl ? 14 : 10;
      sk.mat.uniforms.uAmt.value = amt * (whirl ? 1 : 0.85);
    }
    // The spiral on the water spans the pull (`pullR`): where a ship gets drawn in.
    const sw = claim(swirls, slot);
    if (sw) {
      sw.id = slot;
      sw.mesh.visible = k > 0.01;
      sw.mesh.position.set(x, WATER_Y, z);
      sw.mesh.scale.setScalar(Math.max(colR * 6, reach));
      sw.mat.uniforms.uAmt.value = k * (0.45 + 0.55 * rec.liveK);
      sw.mat.uniforms.uColor.value.set(whirl ? "#dfe6ea" : "#b8c4cc");
      sw.mat.uniforms.uSpin.value = whirl ? 1.5 : 1;
      sw.mat.uniforms.uDark.value = 0.35;
    }
    // The spray at the foot is weather.js's (one emitter per funnel: a second one here doubled the particles).
  }

  // ---- The squall ----
  function stepSquall(rec, e, d) {
    const r = fin(e.r) ? Math.max(60, +e.r) : 450;
    // Warn: the cell already dark on the horizon (half strength: its cloud, its curtain), no rain round the lens yet.
    const amt = rec.k * (rec.stage === "warn" ? 0.5 : fin(e.intensity) ? clamp(0.55 + 0.45 * +e.intensity, 0.55, 1) : 1) * (rec.seen ? 1 : 0.6);
    if (!E.extra.squall || amt > E.extra.squall.k) E.extra.squall = { x: rec.x, z: rec.z, r, k: amt };
    const dCam = Math.hypot(rec.x - _cam.x, rec.z - _cam.z);
    const inK = smooth(r * 1.05, r * 0.6, dCam) * amt;
    const cu = claim(curtains, rec.id);
    if (cu) {
      cu.id = rec.id;
      cu.mesh.visible = amt > 0.01;
      cu.mesh.position.set(rec.x, WATER_Y - 0.5, rec.z);
      cu.mat.uniforms.uR.value = r * 0.85;
      cu.mat.uniforms.uH.value = 102;
      // From inside, the rain round the lens is the squall: the far wall only thins the view a little.
      cu.mat.uniforms.uAmt.value = Math.min(1, amt * (rec.stage === "warn" ? 1.6 : 0.95)) * (1 - 0.75 * smooth(r * 0.9, r * 0.6, dCam));
    }
    // Gusts inside: spray streaking downwind past the ship, a shove of the lens.
    if (inK > 0.5 && rec.stage === "active") {
      E.gustT -= d;
      if (E.gustT <= 0) {
        E.gustT = 1.6 + Math.random() * 2.4;
        const dirDeg = fin(e.windDeg) ? +e.windDeg : fin(e.dirDeg) ? +e.dirDeg : 0;
        const [gx, gz] = headingVec(dirDeg);
        // A few streaks 14–40 m off the lens (spray right under it drew 512 px puffs across the frame), fewer by tier.
        const n = Math.max(1, Math.round(4 * mistShare()));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, rr = 14 + Math.random() * 26;
          _v.set(_cam.x + Math.cos(a) * rr - gx * 10, WATER_Y + 0.4, _cam.z + Math.sin(a) * rr - gz * 10);
          fx?.spray?.(_v, { dirX: gx, dirZ: gz, amount: 1 });
        }
        R.cam?.trauma?.(0.07);
      }
    }
    return { inK, vis: inK > 0.01 ? THREE.MathUtils.lerp(NO_VIS, fin(e.visibility) ? Math.max(60, +e.visibility) : 260, inK) : NO_VIS };
  }

  // ---- The rogue set ----
  function stepWaves(rec, e, sh, hazardWave) {
    if (!rec.seen || rec.stage === "over") return;
    const width = fin(e.width) ? +e.width : 260;
    if (Array.isArray(e.waves) && e.waves.length) {
      for (const w of e.waves) if (w && fin(w.x) && fin(w.z)) E.extra.waves.push({ ...w, id: `ev:${rec.id}:${w.id ?? E.extra.waves.length}`, width: fin(w.width) ? +w.width : width, riseMax: rec.stage === "warn" ? 0.38 : undefined });
      return;
    }
    // Live, the core rolls the set itself (its live wave is state.hazards.wave, `n`/`done`/`next` count them): draw
    // nothing extra. Warn: one low wall with a white line where it will come from. Only a set with no wave data at all
    // (an older core) is synthesised.
    if (rec.stage === "active" && (hazardWave || fin(e.n) || fin(e.done))) return;
    let dir = fin(e.dirDeg) ? +e.dirDeg : null;
    if (dir == null && sh && fin(sh.x)) dir = Math.atan2(-(+sh.x - rec.x), +sh.z - rec.z) / (Math.PI / 180);
    if (dir == null) dir = 0;
    const [hx, hz] = headingVec(dir);
    const speed = fin(e.speed) ? +e.speed : 14, spacing = fin(e.spacing) ? +e.spacing : 70, n = fin(e.count) ? clamp(Math.round(+e.count), 1, 3) : 3;
    const reach = fin(e.len) ? +e.len : 1000;
    // The v4 core's set follows the Rexmaw (its x, z are hers) and rolls along `dirDeg`: the warn line stands `upwind`
    // m up the way it comes from, never on her. An older core's event at a fixed spot: the line at the spot.
    const up = rec.stage === "warn" && fin(e.dirDeg) ? (fin(e.upwind) ? +e.upwind : 260) : 0;
    for (let i = 0; i < (rec.stage === "warn" ? 1 : n); i++) {
      const s = rec.stage === "warn" ? -up : speed * rec.liveT - i * spacing;
      if (s > reach) continue;
      // Warn: a low swell (~5 m) whose crest already breaks white — the line on the water the set comes from.
      E.extra.waves.push({ id: `ev:${rec.id}:${i}`, x: rec.x + hx * s, z: rec.z + hz * s, dirDeg: dir, eta: rec.stage === "warn" ? 8 : 0, width, fixedDir: true, riseMax: rec.stage === "warn" ? 0.38 : undefined });
    }
  }

  // ---- The derelict ----
  function stepDerelict(rec, e, st, d, dCam) {
    const cid = e.contactId ?? e.shipId ?? null;
    const listed = cid != null && (st?.contacts || []).some((c) => c.id === cid);
    if (listed) E.derelicts.set(cid, rec.id);
    else if (rec.seen && rec.stage === "active") {      // the core lists her once she's there; a stand-in only if it doesn't
      E.contacts.push({
        id: `event:${rec.id}`, cls: e.cls || "merchant", name: e.name || "Derelict", x: rec.x, z: rec.z,
        heading: fin(e.heading) ? +e.heading : rec.seed * 360, speed: 0, hull: fin(e.hull) ? +e.hull : 0.35, masts: 25,
        derelict: true, state: "derelict", synthetic: true,
      });
    }
    // Warn: mist curling off her (and the light rings); live: now and then a creak of mist too.
    if (rec.seen && dCam < 900) {
      rec.mistT = (rec.mistT ?? 0) - d;
      if (rec.mistT <= 0) { rec.mistT = rec.stage === "warn" ? 0.35 : 1.4; fx?.ghostMist?.(_v.set(rec.x + (Math.random() - 0.5) * 30, WATER_Y + 1 + Math.random() * 4, rec.z + (Math.random() - 0.5) * 30), { thick: rec.stage === "warn" }); }
    }
  }

  // ---- The treasure field ----
  const glintList = [];
  function stepTreasure(rec, e, d, dCam) {
    const r = fin(e.r) ? Math.max(15, +e.r) : 60;
    const n = Math.round((rec.stage === "warn" ? 14 : 48) * rec.k);
    for (let i = 0; i < n && glintList.length < GLINTS; i++) {
      const a = (hash(`${rec.id}:${i}`) % 6283) / 1000, rr = Math.sqrt(((hash(`${rec.id}:r${i}`) % 1000) / 1000)) * r;
      const x = rec.x + Math.cos(a) * rr, z = rec.z + Math.sin(a) * rr;
      const h = water?.swellAt ? water.swellAt(x, z, _sw).h : 0;
      glintList.push(x, WATER_Y + h + 0.5, z, i * 0.137 + rec.seed);
    }
    if (rec.stage === "active" && rec.seen && !rec.fired.live) {
      rec.fired.live = true;
      if (dCam < 1200) for (let i = 0; i < 6; i++) { const a = Math.random() * Math.PI * 2, rr = Math.random() * r * 0.8; fx?.flotsam?.(_v.set(rec.x + Math.cos(a) * rr, WATER_Y + 0.6, rec.z + Math.sin(a) * rr), { n: 2 }); }
    }
  }
  const _sw = { h: 0, dx: 0, dz: 0 };
  function writeGlints() {
    const n = Math.min(GLINTS, glintList.length / 4);
    for (let i = 0; i < n; i++) {
      gPos[i * 3] = glintList[i * 4]; gPos[i * 3 + 1] = glintList[i * 4 + 1]; gPos[i * 3 + 2] = glintList[i * 4 + 2];
      gSeed[i] = glintList[i * 4 + 3];
    }
    glintGeo.setDrawRange(0, n);
    glints.visible = n > 0;
    if (n) { glintGeo.attributes.position.needsUpdate = true; glintGeo.attributes.aSeed.needsUpdate = true; }
    glintMat.uniforms.uScale.value = 0.9 * R.size.h * R.size.dpr / 2;
    glintList.length = 0;
  }

  // ---- The lone Kraken arm ----
  function stepKraken(rec, e, d, dCam) {
    const armId = e.armId ?? rec.id;          // the event id: the swivel's targetId / weakId
    let stage = "sink";
    if (rec.seen && rec.stage === "warn") stage = "tremor";
    else if (rec.seen && rec.stage === "active") stage = rec.liveT < 1.8 ? "rise" : "up";
    if (rec.seen || rec.k > 0.05) E.arms.push({ id: armId, x: rec.x, z: rec.z, stage, hp: fin(e.hp) ? +e.hp : null, eventId: rec.id, follow: true });
    const sw = claim(swirls, rec.id);
    if (sw) {
      sw.id = rec.id;
      const amt = rec.k * (0.4 + 0.6 * rec.warnK);
      sw.mesh.visible = amt > 0.01;
      sw.mesh.position.set(rec.x, WATER_Y, rec.z);
      sw.mesh.scale.setScalar(fin(e.r) ? Math.max(12, +e.r * 0.6) : 22);
      sw.mat.uniforms.uAmt.value = amt;
      sw.mat.uniforms.uColor.value.set("#3ff3e0");
      sw.mat.uniforms.uSpin.value = 0.5;
      sw.mat.uniforms.uDark.value = 0.55;
    }
    if (rec.seen && rec.stage === "warn" && dCam < 700 && Math.random() < d * 1.5) fx?.bubbles?.(_v.set(rec.x + (Math.random() - 0.5) * 10, WATER_Y, rec.z + (Math.random() - 0.5) * 10), { seconds: 1.5, radius: 4 });
  }

  // ---- The fog bank ----
  const fogList = [];
  function stepFog(rec, e) {
    const r = fin(e.r) ? Math.max(60, +e.r) : 240;
    const amt = rec.k * (rec.stage === "warn" ? 0.8 : 1) * (fin(e.density) ? clamp(0.6 + 0.5 * +e.density, 0.6, 1.1) : 1);
    // The wall stands across the way it rolls (its drift vx, vz; else dirDeg).
    const dir = fin(e.dirDeg) ? +e.dirDeg : fin(e.vx) && fin(e.vz) && Math.hypot(+e.vx, +e.vz) > 0.05 ? Math.atan2(-+e.vx, +e.vz) / (Math.PI / 180) : null;
    const n = Math.min(FOGS - fogList.length / 4, 20);
    let ax = 1, az = 0, depth = r;
    if (dir != null) { const [hx, hz] = headingVec(dir); ax = -hz; az = hx; depth = r * 0.45; }
    for (let i = 0; i < n; i++) {
      const u = ((hash(`${rec.id}:u${i}`) % 1000) / 1000) * 2 - 1, v = ((hash(`${rec.id}:v${i}`) % 1000) / 1000) * 2 - 1;
      let x, z;
      if (dir != null) {
        const [hx, hz] = headingVec(dir);
        x = rec.x + ax * u * r + hx * v * depth; z = rec.z + az * u * r + hz * v * depth;
      } else {
        const a = u * Math.PI, rr = Math.sqrt(Math.abs(v)) * r;
        x = rec.x + Math.cos(a) * rr; z = rec.z + Math.sin(a) * rr;
      }
      fogList.push(x + Math.sin(rec.t * 0.05 + i) * 8, z + Math.cos(rec.t * 0.04 + i * 1.7) * 8, 70 + ((hash(`${rec.id}:w${i}`) % 1000) / 1000) * 90, (i * 0.37 + rec.seed) % 1);
    }
    E.fogAmt = Math.max(E.fogAmt, amt);
    // Inside the bank (an ellipse across `dirDeg`, else the disc): the visibility closes in.
    const dx = _cam.x - rec.x, dz = _cam.z - rec.z;
    let q;
    if (dir != null) { const [hx, hz] = headingVec(dir); const a = (dx * ax + dz * az) / r, b = (dx * hx + dz * hz) / Math.max(depth * 1.2, 1); q = Math.hypot(a, b); }
    else q = Math.hypot(dx, dz) / r;
    const inK = smooth(1.05, 0.55, q) * (rec.stage === "active" ? rec.k : 0);
    return { inK, vis: inK > 0.01 ? THREE.MathUtils.lerp(NO_VIS, 140, inK) : NO_VIS };
  }
  function writeFogs() {
    const n = Math.min(FOGS, fogList.length / 4);
    for (let i = 0; i < n; i++) fogAttr.setXYZW(i, fogList[i * 4], fogList[i * 4 + 1], fogList[i * 4 + 2], fogList[i * 4 + 3]);
    fogs.count = n;
    if (n) fogAttr.needsUpdate = true;
    if (R.scene.fog) fogMat.uniforms.uColor.value.copy(R.scene.fog.color).lerp(new THREE.Color(0.24, 0.28, 0.34), 0.5).multiplyScalar(0.75 + 0.6 * (R.sky?.moonLight || 0) + 0.8 * (R.atmos?.day || 0));
    fogMat.uniforms.uAmt.value = n ? E.fogAmt : 0;
    fogList.length = 0;
  }

  return {
    root,
    update,
    /** weather.js's share: {squall: {x, z, r, k} | null, spouts: [...], waves: [...]} (see weather.update). */
    get extra() { return E.extra; },
    /** Stand-in contacts for derelicts the core doesn't list (fleet.update draws them; ids "event:<id>"). */
    get contacts() { return E.contacts; },
    /** Contact ids the core lists as a derelict event's ship (the fleet draws them derelict). */
    isDerelict(id) { return E.derelicts.has(id); },
    /** A state.hazards.spouts entry ({id, event?}) that mirrors a spout event's funnel (the scene draws it with the event). */
    ownsSpout(sp) {
      const s = String(sp?.id ?? sp);
      if (sp?.event != null && E.spoutEvents.includes(String(sp.event))) return true;
      return E.spoutIds.has(s) || E.spoutEvents.some((e) => s.startsWith(e));
    },
    /** Lone Kraken arms for kraken.sync: [{id, x, z, stage, hp, eventId}]. */
    get arms() { return E.arms; },
    /** The visibility (m) the events close the scene to here (2000 = no say), and how deep in a squall / fog bank. */
    get visibility() { return E.visibility; },
    get squallIn() { return E.squallIn; },
    get fogIn() { return E.fogIn; },
    /** The run's `sea_event` {id, kind, stage, x, z}: an immediate telegraph ring when one starts to warn. */
    event(p = {}) {
      const kind = eventKind(p);
      if (kind && WHACKY.has(kind)) critters.event({ ...p, kind });
      if (!kind || !fin(p.x) || !fin(p.z)) return;
      const st = eventStage(p);
      if (st === "warn") water?.pulse?.({ x: +p.x, z: +p.z, color: TELEGRAPH[kind], speed: Math.max(7, (+p.r || 60) / 4), intensity: 0.8 });
      else if (String(p.stage) === "start" && kind === "squall") R.cam?.trauma?.(0.06);
    },
    /** Debug / harness: [{id, kind, stage, k}]. */
    stats() { return [...recs.values()].map((r) => ({ id: r.id, kind: r.kind, stage: r.stage, k: Math.round(r.k * 100) / 100 })); },
    /** Debug / harness: what the whacky ones show ({gerald, whale, turtle, admiral, dolphins, fish, gulls, jellies, ring}). */
    critters: () => critters.stats(),
    warmShow(on) {
      for (const p of [...clouds, ...skirts, ...curtains, ...swirls]) { p.mesh.visible = !!on || p.id != null; if (on) p.mat.uniforms.uAmt.value = Math.max(p.mat.uniforms.uAmt.value, 0.001); }
      fogs.count = on ? Math.max(1, fogs.count) : fogs.count;
      glints.visible = !!on || glints.visible;
      if (on) glintGeo.setDrawRange(0, Math.max(1, glintGeo.drawRange.count));
      critters.warmShow(on);
    },
    reset() {
      recs.clear();
      for (const p of [...clouds, ...skirts, ...curtains, ...swirls]) { p.id = null; p.helper = null; p.mesh.visible = false; }
      fogs.count = 0; glintGeo.setDrawRange(0, 0); glints.visible = false;
      critters.reset();
      E.extra = { squall: null, spouts: [], waves: [], rings: [] }; E.contacts = []; E.arms = []; E.derelicts.clear(); E.visibility = NO_VIS; E.squallIn = 0; E.fogIn = 0;
    },
    dispose() { critters.dispose(); root.removeFromParent(); for (const x of disposables) x.dispose?.(); },
  };
}
