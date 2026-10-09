// Night Raid (from Night Helm): the night sky (from Starboard's sky.js).
//
// One dome, one star field, one moon, and the light they throw:
//   - The dome (a BackSide sphere, r = 1500) follows the camera, so the ship
//     can sail kilometres under it; its shading is by view direction only.
//     It draws the gradient from the night clock's keyframes, a faint teal
//     airglow, the Milky Way (fbm clouds along a great circle, cut by dark
//     dust lanes), the moon's glow (Henyey–Greenstein, g = 0.75), the fog's
//     mist, and at the far end of the night the dawn.
//   - The stars: one Points draw, a power law of magnitudes, a B−V colour
//     ramp, twinkle that grows toward the horizon, HDR up to 2.5 so the
//     brightest bloom. They hold still in the world (no wheel: the ship turns
//     under them, which is how a helmsman steers by a star).
//   - The moon: a billboard with the painted moon (`moon.webp`, or a
//     procedural one), lit to tonight's real lunar phase, HDR so it blooms.
//     It hangs at a fixed world bearing (setMoon), so its glitter path on the
//     water swings round as the ship turns.
//   - Four PMREM environments (dusk, night, deep, dawn) from a tiny env scene,
//     swapped into `scene.environment` as the night turns.
// Everything sits on the SKY layer, so the sea reflects it.
//
// Fog: the mist is the horizon's colour whitening as it thickens; it leans
// toward R.atmos.tint by R.atmos.tintK (a flare burning in the fog).
//
// API (also on R.sky): setNight(t), setMoon(az, alt), phase(), fadeStars(v),
// moonDir, sunDir, moonLight, plus the shared `uniforms`.

import * as THREE from "three";
import { B, dir } from "./blocking.js";

const DEG = Math.PI / 180;
const DOME_R = 1500, STAR_R = 1400, MOON_R = 1300;
const MOON_DEG = 2.4;                 // apparent diameter: a storybook moon
const MILKY = 0.12;                   // the band's peak brightness at deep night
const SUN_DAWN = { az: 70, alt: [-4, 1] };

// Night-clock keyframes. Colours are sRGB hex; `band` is the warm strip above the horizon.
const KEYS = [
  { t: 0.00, zenith: "#1b2a4a", horizon: "#e8875a", band: "#f2c27b", sun: 1.0, stars: 0.2, milky: 0.0, airglow: 0.0, moon: 0.8 },
  { t: 0.15, zenith: "#0f1a36", horizon: "#3b4f7a", sun: 0.35, stars: 0.55, milky: 0.15, airglow: 0.3, moon: 0.95 },
  { t: 0.35, zenith: "#050a1a", horizon: "#0d1b33", sun: 0.0, stars: 1.0, milky: 0.7, airglow: 0.8, moon: 1.0 },
  { t: 0.60, zenith: "#03060f", horizon: "#0a1428", sun: 0.0, stars: 1.0, milky: 1.0, airglow: 1.0, moon: 1.0 },
  { t: 0.85, zenith: "#0b1530", horizon: "#3a3060", sun: 0.3, stars: 0.6, milky: 0.45, airglow: 0.5, moon: 0.8 },
  { t: 1.00, zenith: "#2a4a7a", horizon: "#f0a070", band: "#f6c79a", sun: 1.0, stars: 0.1, milky: 0.0, airglow: 0.0, moon: 0.35 },
].map((k) => {
  const zenith = new THREE.Color(k.zenith), horizon = new THREE.Color(k.horizon);
  const band = k.band ? new THREE.Color(k.band) : horizon.clone().lerp(zenith, 0.35);
  return { ...k, zenith, horizon, band };
});

/** The env-map phases and the night-clock t each is rendered at. */
const PHASES = [["dusk", 0.0], ["night", 0.35], ["deep", 0.6], ["dawn", 1.0]];

/** The phase a night-clock t falls in. @param {number} t @returns {"dusk"|"night"|"deep"|"dawn"} */
export function phaseAt(t) {
  return t < 0.18 ? "dusk" : t < 0.48 ? "night" : t < 0.88 ? "deep" : "dawn";
}

/**
 * Tonight's moon: its age in days and the angle the phase mask lights from.
 * Synodic month from a known new moon (2000-01-06 18:14 UTC).
 * @param {Date} [date]
 */
export function lunarPhase(date = new Date()) {
  const SYNODIC = 29.530588853;
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC;
  const angle = (age / SYNODIC) * Math.PI * 2;
  return { age, illum: (1 - Math.cos(angle)) / 2, waxing: angle < Math.PI, angle };
}

const DOME_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const DOME_FRAG = /* glsl */`
  uniform vec3 uZenith, uBand, uHorizon, uSunDir, uSunColor, uMoonDir, uMoonColor, uFogColor, uGalPole, uGalCenter;
  uniform float uSunGlow, uMoonVis, uMilky, uAirglow, uFog;
  uniform float uDay, uCloud;            // Rexmaw Raids: the day sky (0 night .. 1 noon) and its cumulus cover
  uniform vec2 uDrift;                   // the clouds' drift (m, wind-driven)
  varying vec3 vWorld;

  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 7.7; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vWorld - cameraPosition);
    float h = d.y, hp = max(h, 0.0);

    vec3 col = mix(uHorizon, uBand, smoothstep(0.0, 0.09, hp));
    col = mix(col, uZenith, sqrt(smoothstep(0.0, 0.62, hp)));
    col = mix(col, uHorizon * 0.42, 1.0 - smoothstep(-0.08, 0.0, h));

    // The sun under the horizon: a fan of afterglow hugging the horizon, and a lobe.
    if (uSunGlow > 0.001) {
      vec2 hz = normalize(d.xz + vec2(1e-5)), sz = normalize(uSunDir.xz + vec2(1e-5));
      float az = acos(clamp(dot(hz, sz), -1.0, 1.0));
      float fan = exp(-az * az / 0.55);
      float hug = exp(-max(h - max(uSunDir.y, 0.0), 0.0) / 0.10) * smoothstep(-0.10, 0.0, h);
      float lobe = pow(max(dot(d, uSunDir), 0.0), 12.0);
      col += uSunColor * uSunGlow * (fan * hug * 0.9 + lobe * 0.45 + fan * smoothstep(-0.05, 0.4, h) * 0.05);
    }
    {
      float sd = dot(d, uSunDir);
      float up = smoothstep(-0.005, 0.01, uSunDir.y) * smoothstep(-0.002, 0.002, h);
      col += uSunColor * up * (smoothstep(0.99996, 0.99999, sd) * 40.0 + pow(max(sd, 0.0), 600.0) * 1.5);
    }

    // Airglow: a faint teal veil some ten degrees up. (x*x, not pow(x, 2.0): pow of a negative is undefined in GLSL.)
    float ag = (h - 0.16) / 0.10;
    col += vec3(0.006, 0.022, 0.018) * uAirglow * exp(-ag * ag);

    // The Milky Way.
    if (uMilky > 0.001 && h > -0.06) {
      vec3 c = d;
      float b = dot(c, uGalPole);
      float lon = dot(c, uGalCenter);
      float core = smoothstep(-0.2, 1.0, lon);
      float w = 0.11 + 0.05 * core;
      float band = exp(-b * b / (w * w));
      if (band > 0.003) {
        float n1 = fbm(c * 3.1);
        float n2 = fbm(c * 8.7 + 3.7);
        float mottle = 0.45 + 1.1 * fbm(c * 23.0 + 9.1);
        float clouds = band * pow(smoothstep(0.32, 0.86, n1 * 0.62 + n2 * 0.52), 1.35) * mottle;
        float laneB = b - 0.075 * (fbm(c * 1.9 + 11.0) - 0.5) - 0.03 * (fbm(c * 6.3 + 2.0) - 0.5);
        float rift = exp(-laneB * laneB / (0.0011 + 0.0012 * core)) * smoothstep(0.36, 0.7, fbm(c * 4.3 + 5.0));
        float knotsDark = smoothstep(0.58, 0.8, fbm(c * 12.0 + 4.4)) * band;
        float dust = 1.0 - clamp(0.7 * rift + 0.45 * knotsDark, 0.0, 0.92);
        float knots = smoothstep(0.64, 0.92, fbm(c * 16.0 + 1.3)) * band * 0.55;
        float bl = max(1.0 - lon, 0.0) * 5.0;
        float bulge = exp(-bl * bl) * exp(-b * b / 0.014);
        float mw = (clouds * (0.6 + 0.4 * core) + knots + bulge * mottle * 0.35) * dust;
        vec3 tint = mix(vec3(0.56, 0.67, 1.00), vec3(0.98, 0.88, 0.76), clamp(core * 0.3 + bulge * 0.5, 0.0, 1.0));
        col += tint * mw * uMilky * smoothstep(-0.04, 0.22, h);
      }
    }

    // The moon's glow: Henyey–Greenstein (g = 0.75) and a tight aureole.
    float cm = dot(d, uMoonDir);
    const float G = 0.75;
    float hg = (1.0 - G * G) / (12.566 * pow(max(1.0 + G * G - 2.0 * G * cm, 1e-4), 1.5));
    col += uMoonColor * uMoonVis * (hg * 0.0085 + pow(max(cm, 0.0), 900.0) * 0.2);

    // Rexmaw Raids, the day: a deep blue zenith over a pale haze, the sun (an HDR disc and its
    // glow) and fair-weather cumulus on a plane overhead, thinning into the haze at the horizon.
    if (uDay > 0.001) {
      vec3 dz = vec3(0.105, 0.29, 0.68), dh = vec3(0.58, 0.71, 0.84);
      vec3 dc = mix(dh, dz, pow(smoothstep(0.0, 0.85, hp), 0.55));
      dc = mix(dc, dh * 0.82, 1.0 - smoothstep(-0.06, 0.0, h));
      float sd = max(dot(d, uSunDir), 0.0);
      dc += vec3(1.0, 0.9, 0.72) * (pow(sd, 6.0) * 0.18 + pow(sd, 48.0) * 0.45 + pow(sd, 400.0) * 1.2);
      dc += vec3(1.0, 0.97, 0.9) * smoothstep(0.99962, 0.99978, sd) * 24.0;
      if (h > 0.004) {
        vec2 cuv = d.xz / (h + 0.035) * 0.55 + uDrift * 0.0016;
        float n1 = fbm(vec3(cuv * 0.9, 1.7));
        float n2 = fbm(vec3(cuv * 2.6 + 3.1, 4.2));
        float dens = n1 * 0.78 + n2 * 0.32;
        float c = smoothstep(0.62 - 0.22 * uCloud, 0.86 - 0.12 * uCloud, dens);
        // Lit tops, grey-blue bellies; the side facing the sun glows.
        float belly = smoothstep(0.25, 0.95, c);
        vec3 cc = mix(vec3(1.04, 1.02, 0.98), vec3(0.6, 0.66, 0.76), belly * 0.55);
        cc += vec3(1.0, 0.9, 0.75) * pow(sd, 5.0) * 0.35 * (1.0 - belly * 0.5);
        float thin = smoothstep(0.004, 0.11, h);
        dc = mix(dc, cc, c * thin * 0.96);
      }
      col = mix(col, dc, uDay);
    }

    // Fog: the lower sky drowns first (fully at the horizon, where the fogged sea meets it,
    // so there's no seam), then the whole sky greys over as it thickens.
    // (At the horizon the sky is infinitely far: as fogged as the farthest sea and the farthest rock,
    // so anything out there dissolves into it instead of standing out as a pale cut-out.)
    float fogLow = smoothstep(0.0, 0.08, uFog) * (1.0 - smoothstep(0.015, 0.12 + 0.7 * uFog, h));
    float fogVeil = smoothstep(0.15, 0.95, uFog) * 0.82;
    col = mix(col, uFogColor, max(fogLow, fogVeil));

    gl_FragColor = vec4(col, 1.0);
  }`;

const STAR_VERT = /* glsl */`
  attribute float aMag;
  attribute float aSeed;
  attribute vec3 aColor;
  uniform vec3 uMoonDir;
  uniform float uTime, uVis, uFog, uPixelRatio;
  varying vec3 vCol;
  varying float vSpike;
  void main() {
    vec3 d = position;
    if (d.y < -0.03) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSpike = 0.0; return; }
    gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + d * ${STAR_R.toFixed(1)}, 1.0);

    float alt = asin(clamp(d.y, 0.0, 1.0)) * 57.2958;
    float lo = 1.0 - alt / 90.0;
    float amp = 0.25 * lo * lo;
    float tw = 1.0 + amp * (0.62 * sin(uTime * (2.3 + aSeed * 5.1) + aSeed * 91.0) + 0.38 * sin(uTime * (6.1 + aSeed * 3.3) + aSeed * 17.0));
    float ext = smoothstep(-0.02, 0.22, d.y);
    float glare = 1.0 - 0.8 * exp(-(1.0 - dot(d, uMoonDir)) / 0.004);
    float seen = tw * ext * glare * uVis * (1.0 - smoothstep(0.15, 0.7, uFog));
    float b = max(aMag, 0.22) * seen;
    vCol = aColor * mix(vec3(1.0, 0.7, 0.5), vec3(1.0), ext) * b;

    float bright = smoothstep(1.0, 2.2, aMag);
    vSpike = bright;
    gl_PointSize = (2.0 + 1.5 * smoothstep(0.1, 1.0, aMag) + 7.0 * bright) * max(uPixelRatio, 1.0);
  }`;

const STAR_FRAG = /* glsl */`
  varying vec3 vCol;
  varying float vSpike;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * mix(3.0, 26.0, vSpike));
    float halo = exp(-r2 * 4.0) * 0.18 * vSpike;
    float spikes = (exp(-abs(p.x) * 22.0) * exp(-abs(p.y) * 2.6) + exp(-abs(p.y) * 22.0) * exp(-abs(p.x) * 2.6)) * vSpike * 0.55;
    gl_FragColor = vec4(vCol * (core + halo + spikes), 1.0);
  }`;

const MOON_VERT = /* glsl */`
  uniform vec3 uMoonDir;
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = viewMatrix * vec4(cameraPosition + uMoonDir * ${MOON_R.toFixed(1)}, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }`;

const MOON_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uLight, uColor;
  uniform float uVis, uEarthshine, uFog;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    float disc = 1.0 - smoothstep(0.94, 1.0, r2);
    vec4 tex = texture2D(uMap, vUv);
    vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r2)));
    float lit = smoothstep(-0.05, 0.14, dot(n, uLight));
    vec3 c = tex.rgb * (lit * uColor + uEarthshine) * (0.8 + 0.2 * n.z);
    float a = tex.a * disc * uVis * (1.0 - 0.85 * uFog);
    gl_FragColor = vec4(c, a);
  }`;

/** Seeded RNG (mulberry32): the sky is the same every night, for everyone. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Star colour from a B−V index: blue-white through white to amber (linear RGB). */
const BV_RAMP = [[-0.3, "#9fb6ff"], [0.0, "#cad8ff"], [0.4, "#fff6ec"], [0.8, "#ffe2b8"], [1.4, "#ffc185"], [2.0, "#ffa868"]]
  .map(([bv, hex]) => [bv, new THREE.Color(hex)]);
function bvColor(bv, out) {
  for (let i = 1; i < BV_RAMP.length; i++) {
    if (bv <= BV_RAMP[i][0] || i === BV_RAMP.length - 1) {
      const [b0, c0] = BV_RAMP[i - 1], [b1, c1] = BV_RAMP[i];
      return out.copy(c0).lerp(c1, THREE.MathUtils.clamp((bv - b0) / (b1 - b0), 0, 1));
    }
  }
  return out.set(1, 1, 1);
}

/** A painted-looking moon drawn on a canvas: the stand-in until `moon.webp` loads (or if it can't). */
function canvasMoon(size = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  g.save();
  g.beginPath(); g.arc(r, r, r - 1, 0, Math.PI * 2); g.clip();
  const base = g.createRadialGradient(r * 0.85, r * 0.8, r * 0.1, r, r, r);
  base.addColorStop(0, "#f4efe1"); base.addColorStop(0.7, "#ddd6c6"); base.addColorStop(1, "#bdb6a8");
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  const rnd = mulberry32(17);
  for (const [x, y, s] of [[0.36, 0.34, 0.2], [0.55, 0.3, 0.14], [0.62, 0.48, 0.17], [0.42, 0.58, 0.13], [0.3, 0.52, 0.1], [0.66, 0.66, 0.09]]) {
    const m = g.createRadialGradient(x * size, y * size, 0, x * size, y * size, s * size);
    m.addColorStop(0, "rgba(120,118,112,0.55)"); m.addColorStop(0.7, "rgba(130,128,120,0.32)"); m.addColorStop(1, "rgba(140,138,130,0)");
    g.fillStyle = m; g.fillRect(0, 0, size, size);
  }
  for (let i = 0; i < 46; i++) {
    const x = rnd() * size, y = rnd() * size, s = (0.008 + Math.pow(rnd(), 3) * 0.05) * size;
    g.fillStyle = "rgba(95,92,86,0.28)"; g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(255,252,240,0.35)"; g.lineWidth = Math.max(1, s * 0.25);
    g.beginPath(); g.arc(x - s * 0.15, y - s * 0.15, s, Math.PI * 0.9, Math.PI * 1.9); g.stroke();
  }
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A smooth (eased) tween of one number, on animation time. */
function tween(v) {
  return {
    v, from: v, to: v, t0: 0, dur: 0,
    set(to, dur, now) { if (!(dur > 0)) { this.v = this.from = this.to = to; this.dur = 0; return; } this.from = this.v; this.to = to; this.t0 = now; this.dur = dur; },
    step(now) {
      if (!(this.dur > 0)) return this.v;
      const k = Math.min(1, (now - this.t0) / this.dur);
      this.v = this.from + (this.to - this.from) * (-(Math.cos(Math.PI * k) - 1) / 2);
      if (k >= 1) this.dur = 0;
      return this.v;
    },
  };
}

/**
 * Build the night sky into R.scene and register it as R.sky.
 * @param {object} R  the render context
 */
export function createSky(R) {
  const { scene, layers } = R;
  const fogMist = new THREE.Color("#8b97ad"), _c = new THREE.Color(), _hz = new THREE.Color(), _cam = new THREE.Vector3();

  const uniforms = {
    uZenith: { value: new THREE.Color() }, uBand: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() }, uSunGlow: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonColor: { value: new THREE.Color(0.74, 0.82, 1.0) }, uMoonVis: { value: 1 },
    uMilky: { value: 0 }, uAirglow: { value: 0 },
    uFog: { value: 0 }, uFogColor: { value: new THREE.Color() },
    uGalPole: { value: new THREE.Vector3() }, uGalCenter: { value: new THREE.Vector3() },
    uDay: { value: 0 }, uCloud: { value: 0.5 }, uDrift: { value: new THREE.Vector2() },
  };
  const moonDir = uniforms.uMoonDir.value, sunDir = uniforms.uSunDir.value;
  let moonAz = 18, moonAlt = 22;
  // Rexmaw Raids: the day's sun (heading convention: 0 = +Z) and the haze the day's fog takes.
  let sunAz = 150, sunAlt = 48;
  const daySun = new THREE.Vector3(), DAY_HAZE = new THREE.Color(0.58, 0.71, 0.84), DAY_SUN = new THREE.Color(1.0, 0.94, 0.84);
  let windAz = 200, dayV = 0;
  const drift = new THREE.Vector2();

  // The galactic plane: rising from astern to port, arching high over the
  // starboard bow; its core glows low to starboard.
  {
    const a = dir(200, 0), b = dir(60, 60);
    const pole = new THREE.Vector3().crossVectors(a, b).normalize();
    const want = dir(110, 14);
    const center = want.clone().addScaledVector(pole, -want.dot(pole)).normalize();
    uniforms.uGalPole.value.copy(pole);
    uniforms.uGalCenter.value.copy(center);
  }

  const domeMat = new THREE.ShaderMaterial({
    name: "NightHelmSky", uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 64, 40), domeMat);
  dome.name = "sky.dome";
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.layers.set(layers.SKY);
  scene.add(dome);

  // ---- Stars ---------------------------------------------------------------------
  const MAX = 12000;
  const starGeo = new THREE.BufferGeometry();
  {
    const rnd = mulberry32(0x5ab0a2d);
    const pos = new Float32Array(MAX * 3), mag = new Float32Array(MAX), seed = new Float32Array(MAX), col = new Float32Array(MAX * 3);
    const v = new THREE.Vector3(), c = new THREE.Color();
    const pole = uniforms.uGalPole.value, center = uniforms.uGalCenter.value;
    const side = new THREE.Vector3().crossVectors(pole, center).normalize();
    for (let i = 0; i < MAX; i++) {
      if (rnd() < 0.35) {
        const lon = rnd() * Math.PI * 2;
        const g = (rnd() + rnd() + rnd() - 1.5) * 0.16;
        v.copy(center).multiplyScalar(Math.cos(lon)).addScaledVector(side, Math.sin(lon)).multiplyScalar(Math.cos(g)).addScaledVector(pole, Math.sin(g)).normalize();
      } else {
        const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        v.set(s * Math.cos(a), z, s * Math.sin(a));
      }
      v.toArray(pos, i * 3);
      const u = rnd();
      mag[i] = 0.1 + 0.4 * u * u * u + 2.0 * Math.pow(u, 60);
      seed[i] = rnd();
      const bv = -0.3 + 2.1 * Math.pow(rnd(), 1.5);
      bvColor(bv, c).toArray(col, i * 3);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
    starGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    starGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    starGeo.setDrawRange(0, R.quality.stars);
  }
  const starUniforms = {
    uMoonDir: uniforms.uMoonDir, uTime: { value: 0 }, uVis: { value: 1 }, uFog: uniforms.uFog, uPixelRatio: { value: 1 },
  };
  const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
    name: "NightHelmStars", uniforms: starUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  stars.name = "sky.stars";
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  stars.layers.set(layers.SKY);
  const _sz = new THREE.Vector2();
  stars.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const full = renderer.getDrawingBufferSize(_sz).y;
    starUniforms.uPixelRatio.value = R.size.dpr * (rt && full > 0 ? rt.height / full : 1);
  };
  scene.add(stars);

  // ---- The moon ------------------------------------------------------------------
  const lunar = lunarPhase(new Date());
  const moonUniforms = {
    uMap: { value: canvasMoon() }, uMoonDir: uniforms.uMoonDir, uFog: uniforms.uFog,
    uSize: { value: 2 * MOON_R * Math.tan((MOON_DEG / 2) * DEG) },
    uLight: { value: new THREE.Vector3(Math.sin(lunar.angle), 0.12, -Math.cos(lunar.angle)).normalize() },
    uColor: { value: new THREE.Color(1.0, 0.97, 0.9).multiplyScalar(2.3) },
    uVis: { value: 1 }, uEarthshine: { value: 0.035 },
  };
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    name: "NightHelmMoon", uniforms: moonUniforms, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
    transparent: true, depthWrite: false, fog: false,
  }));
  moon.name = "sky.moon";
  moon.renderOrder = -8;
  moon.frustumCulled = false;
  moon.layers.set(layers.SKY);
  scene.add(moon);
  new THREE.TextureLoader().load(new URL("../../assets/img/moon.webp", import.meta.url).href, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const old = moonUniforms.uMap.value;
    moonUniforms.uMap.value = tex;
    old.dispose();
  }, undefined, () => console.debug("[night-raid] moon.webp not available; the painted stand-in stays"));

  // ---- Environment maps: one per phase, from a tiny env scene ------------------
  const envs = {};
  {
    const pmrem = new THREE.PMREMGenerator(R.renderer);
    const envScene = new THREE.Scene();
    const envMat = domeMat.clone();
    const envDome = new THREE.Mesh(dome.geometry, envMat);
    envScene.add(envDome);
    const moonBall = new THREE.Mesh(new THREE.SphereGeometry(40, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.93, 1.0).multiplyScalar(6) }));
    envScene.add(moonBall);
    const lantern = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.3).multiplyScalar(5) });
    const deck = new THREE.Vector3(0, 2.6, -7);
    for (const p of [B.RAIL_LANTERN, [0.9, 4.4, -12.0], [0.0, 8.5, 1.5]]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 6), lantern);
      s.position.fromArray(p).sub(deck);
      envScene.add(s);
    }
    for (const [name, t] of PHASES) {
      evaluate(t, 0);
      for (const k of Object.keys(uniforms)) {
        const src = uniforms[k].value, dst = envMat.uniforms[k];
        if (src?.isColor || src?.isVector3) dst.value.copy(src); else dst.value = src;
      }
      envMat.uniforms.uMilky.value *= 0.4;
      envMat.uniforms.uFog.value = 0;
      moonBall.position.copy(uniforms.uMoonDir.value).multiplyScalar(1200);
      moonBall.visible = uniforms.uMoonVis.value > 0.05;
      envs[name] = pmrem.fromScene(envScene, 0.04, 0.1, 3000);
      envs[name].texture.name = `NightHelm.env.${name}`;
    }
    // Rexmaw Raids: the day's environment (the blue dome, the cumulus, the sun as a hot ball).
    {
      evaluate(0.5, 0);
      for (const k of Object.keys(uniforms)) {
        const src = uniforms[k].value, dst = envMat.uniforms[k];
        if (src?.isColor || src?.isVector3 || src?.isVector2) dst.value.copy(src); else dst.value = src;
      }
      envMat.uniforms.uDay.value = 1; envMat.uniforms.uFog.value = 0; envMat.uniforms.uMilky.value = 0; envMat.uniforms.uMoonVis.value = 0;
      dir(sunAz, sunAlt, envMat.uniforms.uSunDir.value);
      moonBall.visible = true;
      moonBall.material.color.setRGB(1.0, 0.95, 0.85).multiplyScalar(40);
      moonBall.position.copy(envMat.uniforms.uSunDir.value).multiplyScalar(1200);
      for (const o of envScene.children) if (o !== envDome && o !== moonBall) o.visible = false;
      envs.day = pmrem.fromScene(envScene, 0.04, 0.1, 3000);
      envs.day.texture.name = "RexmawRaids.env.day";
    }
    envMat.dispose();
    moonBall.geometry.dispose(); moonBall.material.dispose();
    lantern.dispose();
    for (const o of envScene.children) if (o !== envDome && o !== moonBall) o.geometry.dispose();
    pmrem.dispose();
  }

  // ---- State ---------------------------------------------------------------------
  const night = tween(0.55), fade = tween(1), dayT = tween(0), cloudT = tween(0.5);
  let envPhase = null;

  /** Fill the uniforms for night-clock t. */
  function evaluate(t, now) {
    let i = 0;
    while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const k = THREE.MathUtils.smoothstep(t, a.t, b.t);
    const mix = (x, y) => x + (y - x) * k;
    uniforms.uZenith.value.copy(a.zenith).lerp(b.zenith, k);
    uniforms.uHorizon.value.copy(a.horizon).lerp(b.horizon, k);
    uniforms.uBand.value.copy(a.band).lerp(b.band, k);
    uniforms.uSunGlow.value = mix(a.sun, b.sun);
    uniforms.uMilky.value = mix(a.milky, b.milky) * MILKY;
    uniforms.uAirglow.value = mix(a.airglow, b.airglow);
    const moonKey = mix(a.moon, b.moon);
    starUniforms.uVis.value = mix(a.stars, b.stars);

    const nightSunAlt = t < 0.5 ? -1 - 40 * t : THREE.MathUtils.lerp(SUN_DAWN.alt[0], SUN_DAWN.alt[1], THREE.MathUtils.smoothstep(t, 0.85, 1.0));
    dir(SUN_DAWN.az, nightSunAlt, sunDir);
    uniforms.uSunColor.value.set(t < 0.5 ? 0xff8a4a : 0xffa878).multiplyScalar(0.55);

    dir(moonAz, moonAlt, moonDir);
    const vis = moonKey * THREE.MathUtils.smoothstep(moonAlt, -1.5, 3);
    uniforms.uMoonVis.value = vis * (0.25 + 0.75 * lunar.illum);
    moonUniforms.uVis.value = vis;
    starUniforms.uTime.value = now;
    // Rexmaw Raids: by day the sun rides high (setSun), the moon and the stars are gone.
    if (dayV > 0.001) {
      dir(sunAz, sunAlt, daySun);
      sunDir.lerp(daySun, dayV).normalize();
      uniforms.uSunColor.value.lerp(DAY_SUN, dayV);
      uniforms.uMoonVis.value *= 1 - dayV;
      moonUniforms.uVis.value *= 1 - dayV;
      starUniforms.uVis.value *= 1 - dayV;
    }
    uniforms.uDay.value = dayV;
  }

  function update(dt, time) {
    // The dome rides with the camera (its shading is by direction only).
    R.camera.getWorldPosition(_cam);
    dome.position.copy(_cam);

    dayV = dayT.step(time);
    uniforms.uCloud.value = cloudT.step(time);
    if (R.atmos) R.atmos.day = dayV;
    const wa = windAz * DEG;
    drift.x += Math.sin(wa) * 6 * dt; drift.y -= Math.cos(wa) * 6 * dt;   // downwind, ~6 m/s
    uniforms.uDrift.value.copy(drift);
    const t = night.step(time);
    evaluate(t, time);
    starUniforms.uVis.value *= fade.step(time);

    // Fog: the mist is the horizon's colour, whitening as it thickens (moonlit fog glows a
    // grey-blue), leaning toward a flare's light. It has to be brighter than it looks: the
    // Neutral tone mapper's toe crushes linear values under ~0.08, and a fog no lighter than
    // the black water would hide the rocks instead of standing them out as silhouettes.
    const f = R.atmos?.fog || 0;
    uniforms.uFog.value = f;
    _c.copy(uniforms.uHorizon.value).multiplyScalar(0.6).lerp(fogMist, THREE.MathUtils.smoothstep(f, 0.05, 0.85) * 0.5);
    // A reach's haze (the Wreck Field's murk, the Kraken's teal) leans the mist, more as it thickens.
    const hk = THREE.MathUtils.clamp(R.atmos?.hazeK || 0, 0, 1);
    if (hk > 0 && R.atmos.haze) _c.lerp(_hz.copy(R.atmos.haze).multiplyScalar(0.35 + 0.5 * f), hk);
    const tk = THREE.MathUtils.clamp(R.atmos?.tintK || 0, 0, 1);
    if (tk > 0 && R.atmos.tint) _c.lerp(R.atmos.tint, tk);
    // The day's haze (a storm or a mood's haze still leans it).
    if (dayV > 0.001) {
      _hz.copy(DAY_HAZE);
      if (hk > 0 && R.atmos.haze) _hz.lerp(R.atmos.haze, hk * 0.6);
      _c.lerp(_hz, dayV);
    }
    uniforms.uFogColor.value.copy(_c);
    if (scene.fog) scene.fog.color.copy(_c);

    const ph = dayV > 0.5 ? "day" : phaseAt(t);
    if (ph !== envPhase && envs[ph]) { envPhase = ph; scene.environment = envs[ph].texture; }
  }

  const off = R.onFrame(update, -20);
  const offQ = R.onQuality((q) => starGeo.setDrawRange(0, q.stars));

  const sky = {
    uniforms,
    moonDir, sunDir,
    /** The painted moon's phase tonight: {age, illum, waxing}. */
    lunar,
    /** How much light the moon gives right now, 0..1. For the moon DirectionalLight. */
    get moonLight() { return uniforms.uMoonVis.value; },
    /** The moonlight colour, for lights and glitter. */
    moonColor: new THREE.Color("#9fb4ff"),
    /** The night clock right now. */
    get night() { return night.v; },
    dome, stars, moon,

    /**
     * Ease the sky to night-clock t (0 = dusk, 0.55 = deep night, 1 = dawn).
     * @param {number} t
     * @param {{duration?: number}} [opts]
     */
    setNight(t, { duration = 4 } = {}) {
      night.set(THREE.MathUtils.clamp(+t || 0, 0, 1), duration, R.time);
    },

    /**
     * Hang the moon at a world bearing (heading convention: 0 = +Z, the harbour mouth).
     * @param {number} az @param {number} alt
     */
    setMoon(az, alt) { moonAz = +az || 0; moonAlt = THREE.MathUtils.clamp(+alt || 20, -5, 80); },

    /** The phase the night is in ("day" by day). */
    phase: () => (dayV > 0.5 ? "day" : phaseAt(night.v)),

    /** Rexmaw Raids: day (1) or night (0), easing over `duration` s. */
    setDay(v, { duration = 3 } = {}) { dayT.set(THREE.MathUtils.clamp(+v || 0, 0, 1), duration, R.time); if (!(duration > 0)) { dayV = dayT.v; uniforms.uDay.value = dayV; if (R.atmos) R.atmos.day = dayV; } },
    /** 0..1 now (0 night). */
    get day() { return dayV; },
    /** The wind the clouds drift on (the bearing it blows FROM). */
    setWind(dirDeg) { windAz = (+dirDeg || 0) + 180; },
    /** The light the scene's key light takes: the sun by day, the moon by night. */
    keyLight(out = { dir: new THREE.Vector3(), intensity: 0, color: new THREE.Color() }) {
      out.dir.copy(moonDir).lerp(sunDir, dayV).normalize();
      out.intensity = dayV;
      out.color.set("#9fb4ff").lerp(DAY_SUN, dayV);
      return out;
    },

    /** Dim the stars (1 = as the night clock has them, 0 = gone). */
    fadeStars(v, { duration = 3 } = {}) { fade.set(THREE.MathUtils.clamp(+v, 0, 1), duration, R.time); },

    /** The PMREM for a phase. */
    env: (name) => envs[name]?.texture || null,

    dispose() {
      off(); offQ();
      scene.remove(dome, stars, moon);
      dome.geometry.dispose(); domeMat.dispose();
      starGeo.dispose(); stars.material.dispose();
      moon.geometry.dispose(); moon.material.dispose(); moonUniforms.uMap.value.dispose();
      if (Object.values(envs).some((e) => e.texture === scene.environment)) scene.environment = null;
      for (const e of Object.values(envs)) e.dispose();
      if (R.sky === sky) R.sky = null;
    },
  };

  update(0, R.time);
  R.sky = sky;
  return sky;
}
