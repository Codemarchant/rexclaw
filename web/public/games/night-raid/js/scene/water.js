// Rexmaw Raids (from Night Helm / Starboard): the sea.
//
// v3: a real moving surface. A camera-centred polar grid (fine under the lens, ~0.4 m cells,
// coarsening with distance; 96–224 spokes by tier) is displaced on the GPU by Gerstner waves:
// three swell trains (70, 41, 23 m, running downwind, 0.25–0.8 m in open water) and four wind-
// chop trains (12.5, 7.3, 4.4, 2.6 m, spread round the wind, ≤ 0.18 m). Each train fades out of
// the displacement where the grid's cell is too coarse to carry it (no aliasing far off; the far
// sea is flat geometry shaded by the same waves' normals). The fragment adds four gradient-noise
// ripple layers and a fine chop for the glints.
//
// Shading: Schlick fresnel (F0 0.02) between the body colour and the sky (the Reflector's planar
// reflection on Medium+, an analytic sky on Low); by day a deep-blue body with turquoise shallows
// round the islands, a subsurface tint on wave faces lit through by the sun, the sun's glitter
// (a broad lobe + hard sparkles); wind whitecaps on the steepest crests (more as the wind
// rises; moonlit grey at night); foam slapping round the Rexmaw's hull; at night darker deep
// tones and a moon path (a rough-sea lobe broken into glints) that leads to the moon.
//
// The CPU twin `swellAt` evaluates the same Gerstner sum — inverting the horizontal shift with two
// fixed-point steps, so the height is the surface's height AT (x, z) — so ships, buoys and
// pickups ride the waves the sea draws. Other modules that sample the swell in GLSL may keep the
// three-train sine sum (`uSwellA/uSwellB`, unchanged semantics); `SEA_HEIGHT_GLSL` is the full one.
//
//   - Plankton: one Points draw of cyan motes on a 160 m tile that wraps around the ship.
//   - Kraken waters (`setBio`): drifting veins of bioluminescence on the surface.
//   - Pulses: up to eight expanding rings of light (`pulse`).
//
// NaN safety: every division is guarded (dist, the hull ellipse, the amplitude sums); dot
// products feeding pow() are clamped to [0, 1].
//
// API (also on R.water): pulse({x, z, color, speed}), setGlow(v), setBio(v), setWind(dirDeg, strength),
// setNight(t), swellAt(x, z, out), heightAt(x, z), uniforms, SEA_HEIGHT_GLSL (export).

import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import { WATER_Y, B } from "./blocking.js";

const RADIUS = 1650;                          // the grid's reach (m); the fog has the rest
const PULSES = 8;
const PLANKTON_MAX = 56000;
const TILE = 160;                            // the plankton tile's side (m), wrapped around the ship
const HULL = B.HULL;                         // the hull's waterline ellipse (ship space)
const PLANKTON_COLOR = new THREE.Color("#3ff3e0");
const ISLES = 10;                            // Rexmaw Raids: islands whose shallows the day's water shows
const DEEP = new THREE.Color("#030f18");
const G = 9.81;
/** The swell trains: wavelength (m), share of the amplitude, bearing off the wind (deg), phase. */
const SWELL = [[70, 1.0, 0, 0.0], [41, 0.55, 28, 1.7], [23, 0.3, -36, 4.1]];
/** The wind chop: wavelength (m), amplitude at full wind (m), bearing off the wind (deg), phase. */
const CHOP = [[12.5, 0.09, 18, 0.7], [7.3, 0.05, -42, 2.9], [4.4, 0.028, 61, 5.3], [2.6, 0.014, -15, 1.1]];
const STEEP = { swell: 0.55, chop: 0.38 };   // Gerstner Q per train family (crest sharpness; < 1/(k·A·n) so no loops)
const HARBOUR = { calm: 140, open: 520 };   // metres from the mooring: the swell builds from calm to open sea
const SPOKES = { low: 96, medium: 160, high: 224, ultra: 224 };

/** GLSL: the full sea height (Eulerian sine sum of every train) at a world xz; needs uSwellA/B[3], uChopA/B[4], uTime. */
export const SEA_HEIGHT_GLSL = /* glsl */`
  uniform vec4 uSwellA[3]; uniform vec4 uSwellB[3]; uniform vec4 uChopA[4]; uniform vec4 uChopB[4];
  float seaHeight(vec2 xz) {
    float h = 0.0;
    for (int i = 0; i < 3; i++) h += uSwellB[i].x * sin(uSwellA[i].z * dot(uSwellA[i].xy, xz) - uSwellA[i].w * uTime + uSwellB[i].y);
    for (int i = 0; i < 4; i++) h += uChopB[i].x * sin(uChopA[i].z * dot(uChopA[i].xy, xz) - uChopA[i].w * uTime + uChopB[i].y);
    return h;
  }`;

const NOISE = /* glsl */`
  vec2 hash22(vec2 p) {
    p = mod(p, 289.0);
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
  }
  // Gradient noise with its analytic derivatives (value, d/dx, d/dy).
  vec3 noised(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec2 ga = hash22(i), gb = hash22(i + vec2(1.0, 0.0)), gc = hash22(i + vec2(0.0, 1.0)), gd = hash22(i + vec2(1.0, 1.0));
    float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
    return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd),
                ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
                + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va));
  }`;

const COMMON_U = /* glsl */`
  uniform float uTime, uSteepS, uSteepC;
  uniform vec4 uSwellA[3];                  // dirX, dirZ, k, omega
  uniform vec4 uSwellB[3];                  // amplitude, phase, -, -
  uniform vec4 uChopA[4];
  uniform vec4 uChopB[4];
  uniform vec4 uStorm;                      // the storm cell x, z, radius, strength
  float stormAt(vec2 xz) { return uStorm.w > 0.0 ? uStorm.w * smoothstep(uStorm.z, uStorm.z * 0.55, length(xz - uStorm.xy)) : 0.0; }`;

const WATER_VERT = /* glsl */`
  uniform mat4 textureMatrix;
  ${COMMON_U}
  attribute float aCell;                    // the grid's local cell size (m)
  varying vec4 vUvProj;
  varying vec3 vWorld;
  varying float vH, vFoamJ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 xz = wp.xz;
    float sk = stormAt(xz);
    vec3 D = vec3(0.0);
    float jac = 0.0;                        // how much the crests bunch up (Gerstner's horizontal squeeze): foam where it's high
    for (int i = 0; i < 3; i++) {
      vec4 a = uSwellA[i];
      float lambda = 6.2831853 / max(a.z, 1e-4);
      float fade = smoothstep(2.5 * aCell, 5.0 * aCell, lambda);
      float A = uSwellB[i].x * (1.0 + 1.8 * sk) * fade;
      float ph = a.z * dot(a.xy, xz) - a.w * uTime + uSwellB[i].y;
      float s = sin(ph), c = cos(ph);
      D.y += A * s;
      D.xz += uSteepS * A * a.xy * c;
      jac += uSteepS * A * a.z * s;
    }
    for (int i = 0; i < 4; i++) {
      vec4 a = uChopA[i];
      float lambda = 6.2831853 / max(a.z, 1e-4);
      float fade = smoothstep(2.5 * aCell, 5.0 * aCell, lambda);
      float A = uChopB[i].x * (1.0 + 1.3 * sk) * fade;
      float ph = a.z * dot(a.xy, xz) - a.w * uTime + uChopB[i].y;
      float s = sin(ph), c = cos(ph);
      D.y += A * s;
      D.xz += uSteepC * A * a.xy * c;
      jac += uSteepC * A * a.z * s;
    }
    vH = D.y;
    vFoamJ = jac;
    // The mesh lies in its local XY plane, turned −90° about X: world (dx, dy, dz) = local (dx, −dz, dy).
    vec3 local = position + vec3(D.x, -D.z, D.y);
    vUvProj = textureMatrix * vec4(local, 1.0);
    vWorld = wp.xyz + D;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }`;

const waterFrag = (reflector) => /* glsl */`
  ${reflector ? "#define REFLECTOR" : ""}
  uniform sampler2D tDiffuse;
  uniform vec3 color;
  ${COMMON_U}
  uniform float uRipple, uMoonVis, uSunVis, uGlow, uFogDensity, uReflect, uDeepLight, uBio, uAmp, uCaps, uShipSpeed;
  uniform vec3 uMoonDir, uMoonColor, uSunDir, uSunColor, uDeep, uFogColor, uZenith, uHorizon, uBand, uPlankton, uSSS;
  uniform vec4 uShip;                       // x, z, cos(yaw), sin(yaw)
  uniform vec4 uHole;                       // the maelstrom's bowl x, z, radius (the surface opens there)
  uniform vec4 uPulse[${PULSES}];
  uniform vec3 uPulseColor[${PULSES}];
  uniform float uDay;                       // 0 night .. 1 day
  uniform vec4 uIsles[${ISLES}];            // island centres and radii (x, z, r, 1): the turquoise shallows around them
  uniform vec3 uDayDeep, uDayShallow;
  varying vec4 vUvProj;
  varying vec3 vWorld;
  varying float vH, vFoamJ;
  ${NOISE}

  // One ripple layer: wavelength (m), slope weight, drift direction. It fades
  // out before its wavelength shrinks under a few pixels.
  vec2 layer(vec2 xz, float lambda, float w, vec2 d, float dist) {
    float f = 1.0 / lambda;
    float att = 1.0 - smoothstep(90.0, 320.0, dist * f);
    if (att <= 0.0) return vec2(0.0);
    vec3 n = noised(xz * f + d * (uTime * 0.4 * f) + d * 17.0);
    return n.yz * w * att;
  }

  vec3 analyticSky(vec3 r) {
    float h = max(r.y, 0.0);
    vec3 c = mix(uHorizon, uBand, smoothstep(0.0, 0.09, h));
    c = mix(c, uZenith, sqrt(smoothstep(0.0, 0.62, h)));
    float cm = clamp(dot(r, uMoonDir), 0.0, 1.0);
    vec3 dayC = mix(vec3(0.58, 0.71, 0.84), vec3(0.105, 0.29, 0.68), pow(smoothstep(0.0, 0.85, h), 0.55));
    c = mix(c, dayC, uDay);
    c += uSunColor * uSunVis * pow(clamp(dot(r, uSunDir), 0.0, 1.0), 2400.0) * 20.0;
    return c + uMoonColor * uMoonVis * (pow(cm, 2400.0) * 6.0 + pow(cm, 400.0) * 0.12);
  }

  // A rough-sea glint lobe toward a light (the statistical "path" of a moon or sun on waves): Beckmann-like on the
  // half vector against the mean surface, roughness sigma² from the swell's slopes.
  float pathLobe(vec3 V, vec3 L, float s2) {
    vec3 H = V + L;
    float hl = length(H);
    if (hl < 1e-4 || L.y <= 0.0) return 0.0;
    H /= hl;
    float c2 = max(H.y * H.y, 1e-4);
    float t2 = (1.0 - c2) / c2;
    return exp(-t2 / s2);
  }

  void main() {
    vec2 xz = vWorld.xz;
    // The maelstrom's bowl takes over inside its rim (maelstrom.js draws the slope and the funnel).
    if (uHole.z > 0.0 && length(xz - uHole.xy) < uHole.z) discard;
    vec3 toCam = cameraPosition - vWorld;
    float dist = max(length(toCam), 1e-3);
    vec3 V = toCam / dist;

    // The storm cell: rougher water, a heavier swell, darker deeps, whitecaps (the CPU's swellAt matches the swell).
    float sk = stormAt(xz);

    vec2 s = layer(xz, 13.0, 0.075, vec2(0.80, 0.60), dist)
           + layer(xz, 5.1, 0.064, vec2(-0.42, 0.91), dist)
           + layer(xz, 2.3, 0.048, vec2(0.95, -0.31), dist)
           + layer(xz, 0.9, 0.032, vec2(-0.71, -0.70), dist);
    s *= uRipple * (1.0 + 1.3 * sk);
    // The waves' own slopes (every train; Eulerian, close enough for shading).
    float crest = 0.0;
    for (int i = 0; i < 3; i++) {
      vec4 a = uSwellA[i];
      float ph = a.z * dot(a.xy, xz) - a.w * uTime + uSwellB[i].y;
      float A = uSwellB[i].x * (1.0 + 1.8 * sk);
      s += a.xy * (A * a.z * cos(ph));
      crest += sin(ph) * (i == 0 ? 0.6 : 0.2);
    }
    for (int i = 0; i < 4; i++) {
      vec4 a = uChopA[i];
      float ph = a.z * dot(a.xy, xz) - a.w * uTime + uChopB[i].y;
      float A = uChopB[i].x * (1.0 + 1.3 * sk);
      float fadeN = 1.0 - smoothstep(60.0, 260.0, dist * a.z);   // the chop's normals fade before they alias
      s += a.xy * (A * a.z * cos(ph)) * fadeN;
    }
    vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
    vec2 fine = layer(xz, 0.34, 0.03, vec2(0.3, -0.95), dist) * uRipple;
    vec3 Ng = normalize(vec3(-s.x - fine.x, 1.0, -s.y - fine.y));

    float F = 0.02 + 0.98 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);   // clamped: dot can top 1.0 by an ulp
    vec3 R = reflect(-V, N);

  #ifdef REFLECTOR
    vec4 uvp = vUvProj;
    uvp.xy += N.xz * 0.02 * (1.0 - F) * uvp.w;
    vec3 refl = texture2DProj(tDiffuse, uvp).rgb;
  #else
    vec3 refl = analyticSky(R);
  #endif

    // How high on its wave this point rides (−1 trough … 1 crest).
    float hN = clamp(vH / max(uAmp, 0.05), -1.0, 1.0);

    vec3 deep = uDeep * uDeepLight;
    // Night: the deeps darker in the troughs, a faint navy lift on the faces toward the moon.
    deep *= mix(1.0, 0.82 + 0.18 * (hN * 0.5 + 0.5), 1.0 - uDay);
    if (uDay > 0.001) {
      // The day: deep blue offshore, turquoise over the sand round the islands, a caustic shimmer in the shallows.
      float sh = 0.0;
      for (int i = 0; i < ${ISLES}; i++) {
        vec4 I = uIsles[i];
        if (I.w <= 0.0) continue;
        float di = length(xz - I.xy) - I.z;
        sh = max(sh, 1.0 - smoothstep(-10.0, 95.0 + I.z * 0.15, di));
      }
      sh *= 0.75 + 0.25 * noised(xz * 0.02 + 4.0).x;
      float caus = noised(xz * 0.35 + vec2(uTime * 0.21, uTime * 0.17)).x;
      caus = pow(clamp(1.0 - abs(caus) * 2.5, 0.0, 1.0), 3.0);
      vec3 dayBody = mix(uDayDeep, uDayShallow, clamp(sh, 0.0, 1.0)) * (1.0 + 0.12 * caus * sh);
      // Looking down into it, the body shows; grazing, the sky's mirror takes over (F).
      dayBody *= 0.85 + 0.3 * max(V.y, 0.0);
      // Subsurface: the sun shining through the thin upper faces of the waves (strongest looking toward the sun,
      // on the crests' lee faces), a green-turquoise glow under the mirror.
      vec3 Ls = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0, 1e-4, 0.0));
      float back = pow(clamp(dot(-V, Ls) * 0.5 + 0.5, 0.0, 1.0), 2.5);
      float face = smoothstep(-0.3, 0.9, hN) * (0.5 + 0.5 * clamp((1.0 - N.y) * 25.0, 0.0, 1.0));
      dayBody += uSSS * face * (0.25 + 0.9 * back) * 0.22 * (1.0 - sh * 0.6);
      deep = mix(deep, dayBody, uDay);
    }
    vec3 col = deep * (1.0 - 0.45 * sk) * (1.0 - F) + refl * F * uReflect * (1.0 - 0.35 * sk);

    // Whitecaps: the steepest, bunched-up crests break when the wind is up (more in the storm); the foam is patchy
    // and streaks downwind; moonlit grey at night. Fades with distance into a general brightening.
    float jK = smoothstep(0.012, 0.06, vFoamJ);
    float capK = clamp(uCaps + 1.2 * sk, 0.0, 1.6);
    if (capK > 0.001) {
      float br = noised(xz * 0.21 + vec2(uTime * 0.3, 0.0)).x * 0.5 + 0.5;
      float lace = noised(xz * 1.3 - vec2(uTime * 0.5, uTime * 0.2)).x * 0.5 + 0.5;
      float cap = smoothstep(0.35, 0.95, max(hN, crest)) * mix(0.3, 1.0, jK) * smoothstep(0.62 - 0.22 * capK, 0.9, br);
      cap *= 0.55 + 0.6 * lace;
      float streak = smoothstep(0.55, 0.9, noised(xz * vec2(0.6, 0.12) + uTime * 0.05).x * 0.5 + 0.5) * 0.35 * sk;
      vec3 foamC = mix(vec3(0.14, 0.17, 0.21) + uMoonColor * 0.05 * uMoonVis, vec3(0.86, 0.9, 0.92), uDay);
      float far = 1.0 - smoothstep(160.0, 520.0, dist) * 0.75;
      col = mix(col, foamC, clamp(cap * capK * 0.85 + streak * cap, 0.0, 0.9) * far);
    }

    // The moon's path: a broad lobe of glints across the swell toward the moon, and the sharp glitter in it (HDR).
    vec3 Rg = reflect(-V, Ng);
    float glint = smoothstep(0.35, 0.95, noised(xz * 0.9 + vec2(uTime * 0.6, -uTime * 0.4)).x * 0.5 + 0.5);
    // σ² ≈ 0.03 (a moderate wind sea's slope variance): the path runs from under the bow out to the horizon.
    float moonPath = pathLobe(V, uMoonDir, 0.03 + 0.02 * sk) * (0.18 + 1.5 * glint) * (0.4 + 0.6 * smoothstep(40.0, 400.0, dist));
    col += uMoonColor * uMoonVis * (1.0 - 0.9 * sk) * (moonPath * 0.5 * (1.0 - uDay)
                                    + pow(clamp(dot(R, uMoonDir), 0.0, 1.0), 260.0) * 2.2
                                    + pow(clamp(dot(Rg, uMoonDir), 0.0, 1.0), 900.0) * 2.0);
    col += uSunColor * uSunVis * (1.0 - 0.6 * uDay) * (pow(clamp(dot(R, uSunDir), 0.0, 1.0), 180.0) * 6.0
                                + pow(clamp(dot(Rg, uSunDir), 0.0, 1.0), 700.0) * 5.0);
    if (uDay > 0.001) {
      // The day's sun glitter: a broad sheen (the path) and hard sparkles off the fine chop (HDR, so they bloom).
      float gl = clamp(dot(Rg, uSunDir), 0.0, 1.0);
      float spark = pow(gl, 1800.0) * 26.0 + pow(clamp(dot(R, uSunDir), 0.0, 1.0), 90.0) * 0.9;
      spark += pathLobe(V, uSunDir, 0.012) * (0.15 + 1.1 * glint) * 0.6;
      col += vec3(1.0, 0.95, 0.85) * spark * uDay * (1.0 - 0.8 * sk);
    }

    // Round the Rexmaw's hull (ship space): foam where the waves slap the planking (more under way), and the tide's
    // own light at night.
    vec2 d0 = xz - uShip.xy;
    vec2 loc = vec2(d0.x * uShip.z - d0.y * uShip.w, d0.x * uShip.w + d0.y * uShip.z);
    vec2 e = vec2(loc.x / ${HULL.a.toFixed(2)}, (loc.y - ${HULL.z.toFixed(2)}) / ${HULL.b.toFixed(2)});
    float edge = max(length(e) - 1.0, 0.0);
    float shimmer = 0.65 + 0.35 * noised(xz * 0.35 + vec2(uTime * 0.05, -uTime * 0.04)).x;
    col += uPlankton * uGlow * exp(-edge * 2.4) * shimmer * 0.045 * (1.0 - uDay);
    {
      float wash = exp(-edge * mix(9.0, 5.0, smoothstep(1.0, 12.0, uShipSpeed)));
      float fl = noised(xz * 1.6 + vec2(uTime * 0.9, -uTime * 0.7)).x * 0.5 + 0.5;
      float fl2 = noised(xz * 4.1 - vec2(uTime * 1.3, uTime * 0.4)).x * 0.5 + 0.5;
      float hf = wash * smoothstep(0.32, 0.8, fl * 0.65 + fl2 * 0.45) * (0.45 + 0.55 * smoothstep(0.5, 8.0, uShipSpeed));
      vec3 foamC = mix(vec3(0.16, 0.19, 0.23) + uMoonColor * 0.06 * uMoonVis, vec3(0.88, 0.92, 0.94), uDay);
      col = mix(col, foamC, clamp(hf, 0.0, 0.85) * (edge > 0.0 ? 1.0 : 0.0));
    }

    // Kraken waters: drifting veins of bioluminescence.
    if (uBio > 0.001) {
      float n1 = noised(xz * 0.045 + vec2(uTime * 0.013, -uTime * 0.009)).x;
      float n2 = noised(xz * 0.11 - vec2(uTime * 0.02, uTime * 0.017) + 7.3).x;
      float vein = 1.0 - abs(n1 + 0.45 * n2) * 3.2;
      vein = clamp(vein, 0.0, 1.0);
      vein = vein * vein * vein * vein;
      float patchy = smoothstep(-0.15, 0.45, noised(xz * 0.012 + 3.1).x);
      float breathe = 0.75 + 0.25 * sin(uTime * 0.7 + n2 * 6.0);
      col += uPlankton * uBio * vein * patchy * breathe * 0.16 * (1.0 - F * 0.5);
    }

    // Rings of light (pulses): a bright front and a soft wake behind it.
    for (int i = 0; i < ${PULSES}; i++) {
      vec4 P = uPulse[i];
      if (P.w <= 0.0) continue;
      float age = uTime - P.z;
      if (age < 0.0) continue;
      float life = min(12.0, 150.0 / P.w);
      float k = 1.0 - smoothstep(life * 0.45, life, age);
      if (k <= 0.0) continue;
      float r = age * P.w;
      float d = length(xz - P.xy);
      float w = 1.1 + r * 0.045;
      float q = (d - r) / w;
      float ring = exp(-q * q);
      float wake = smoothstep(r + w, r * 0.4, d) * exp(-age * 0.6) * 0.12;
      col += uPulseColor[i] * (ring * 0.4 + wake) * k;
    }

    // Fog, by hand (FogExp2, as the rest of the scene has it).
    float fd = uFogDensity * dist;
    float fog = 1.0 - exp(-fd * fd);
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }`;

const PLANKTON_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime, uGlow, uScale, uFogDensity, uBio;
  uniform vec3 uPlankton;
  uniform vec2 uCenter;
  uniform vec4 uShip;
  uniform vec4 uHole;
  uniform vec4 uPulse[${PULSES}];
  uniform vec3 uPulseColor[${PULSES}];
  ${SEA_HEIGHT_GLSL}
  varying vec3 vCol;
  varying float vAlpha;

  // A stream function ψ(x, z, t); the drift is its curl, so motes swirl and eddy.
  vec2 curl(vec2 q, float t) {
    float a = 0.11, b = 0.083, c = 0.29, d = 0.23;
    float s1 = sin(q.x * a + t * 0.050), c1 = cos(q.x * a + t * 0.050);
    float s2 = sin(q.y * b - t * 0.040), c2 = cos(q.y * b - t * 0.040);
    float c3 = cos(q.x * c - q.y * d + t * 0.13);
    float dpx = a * c1 * c2 + 0.35 * c * c3;
    float dpz = -b * s1 * s2 - 0.35 * d * c3;
    return vec2(dpz, -dpx);
  }

  void main() {
    // The tile wraps around the ship: each mote keeps its world spot, re-entering ahead as it falls astern.
    vec2 rel = mod(position.xz - uCenter + ${(TILE / 2).toFixed(1)}, ${TILE.toFixed(1)}) - ${(TILE / 2).toFixed(1)};
    vec2 wxz = uCenter + rel;
    vec3 p = vec3(wxz.x, position.y, wxz.y);
    float t = uTime;
    p.xz += curl(p.xz, t) * 5.5 + vec2(sin(t * 0.31 + aSeed * 40.0), cos(t * 0.27 + aSeed * 31.0)) * 0.22;
    p.y += seaHeight(p.xz) + 0.04;          // v3: they ride the displaced surface
    float edgeFade = 1.0 - smoothstep(0.78, 1.0, max(abs(rel.x), abs(rel.y)) / ${(TILE / 2).toFixed(1)});
    if (uHole.z > 0.0 && length(p.xz - uHole.xy) < uHole.z) edgeFade = 0.0;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;

    // Near the hull (ship space): the bow wave and the hull's wash stir them up.
    vec2 d0 = p.xz - uShip.xy;
    vec2 loc = vec2(d0.x * uShip.z - d0.y * uShip.w, d0.x * uShip.w + d0.y * uShip.z);
    float edge = max(length(vec2(loc.x / ${HULL.a.toFixed(2)}, (loc.y - ${HULL.z.toFixed(2)}) / ${HULL.b.toFixed(2)})) - 1.0, 0.0) * ${HULL.a.toFixed(2)};
    float hull = exp(-edge / 3.2);

    float twinkle = 0.55 + 0.45 * sin(t * (0.6 + fract(aSeed * 13.7) * 1.8) + aSeed * 61.0);
    float flash = pow(max(0.0, sin(t * 0.21 + aSeed * 97.0)), 40.0) * 3.0;
    vec3 col = uPlankton * uGlow * (0.025 + 0.3 * uBio + 0.95 * hull * hull) * (twinkle + flash);

    for (int i = 0; i < ${PULSES}; i++) {
      vec4 P = uPulse[i];
      if (P.w <= 0.0) continue;
      float age = t - P.z;
      if (age < 0.0) continue;
      float life = min(12.0, 150.0 / P.w);
      float k = 1.0 - smoothstep(life * 0.45, life, age);
      if (k <= 0.0) continue;
      float r = age * P.w;
      float q = (length(p.xz - P.xy) - r) / (2.0 + r * 0.05);
      col += uPulseColor[i] * exp(-q * q) * k * 2.2;
    }
    float fd = uFogDensity * dist;
    col *= exp(-fd * fd) * edgeFade;

    float size = (0.06 + 0.08 * fract(aSeed * 7.31)) * uScale / dist;
    vAlpha = clamp(size / 1.6, 0.0, 1.0);
    gl_PointSize = clamp(size, 1.6, 9.0);
    vCol = col;
  }`;

const PLANKTON_FRAG = /* glsl */`
  varying vec3 vCol;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vCol * exp(-r2 * 3.2) * vAlpha, 1.0);
  }`;

/** Seeded RNG (mulberry32), so the tide is laid out the same each load. */
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

/** An eased tween of one number on animation time. */
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
 * The polar grid (local XY plane, the mesh is turned onto XZ): rings from the centre out to RADIUS, square-ish
 * cells (≈ 0.4 m under the lens, growing with the radius), `spokes` round. aCell = the cell's size (m).
 */
function buildGrid(spokes) {
  const rings = [0];
  let r = 0;
  const kArc = (2 * Math.PI) / spokes;
  while (r < RADIUS) { r += Math.max(0.4, r * kArc); rings.push(Math.min(r, RADIUS)); }
  const nr = rings.length;
  const pos = new Float32Array(nr * spokes * 3), cell = new Float32Array(nr * spokes);
  for (let i = 0; i < nr; i++) {
    const ri = rings[i], c = Math.max(0.4, ri * kArc);
    for (let j = 0; j < spokes; j++) {
      const a = j * kArc, o = (i * spokes + j);
      pos[o * 3] = Math.cos(a) * ri; pos[o * 3 + 1] = Math.sin(a) * ri; pos[o * 3 + 2] = 0;
      cell[o] = c;
    }
  }
  const idx = new Uint32Array((nr - 1) * spokes * 6);
  let k = 0;
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = i * spokes + j, b = i * spokes + ((j + 1) % spokes), c = a + spokes, d = b + spokes;
      // Counter-clockwise seen from +Z (the plane's front, which faces up once it's turned onto XZ).
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aCell", new THREE.BufferAttribute(cell, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS + 10);
  g.userData.rings = nr;
  return g;
}

/**
 * Build the sea into R.scene and register it as R.water.
 * @param {object} R  the render context
 */
export function createWater(R) {
  const { scene, layers } = R;
  const sky = () => R.sky;

  const shared = {
    uTime: { value: 0 }, uRipple: { value: 1 }, uReflect: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, 0.4, 0.9).normalize() }, uMoonColor: { value: new THREE.Color("#9fb4ff") }, uMoonVis: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, -1, 0) }, uSunColor: { value: new THREE.Color() }, uSunVis: { value: 0 },
    uDeep: { value: DEEP.clone() }, uDeepLight: { value: 1 },
    uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 },
    uZenith: { value: new THREE.Color("#050a1a") }, uHorizon: { value: new THREE.Color("#0d1b33") }, uBand: { value: new THREE.Color("#0d1b33") },
    uPlankton: { value: PLANKTON_COLOR.clone().multiplyScalar(2.2) }, uGlow: { value: 0.4 }, uBio: { value: 0 },
    uPulse: { value: Array.from({ length: PULSES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uPulseColor: { value: Array.from({ length: PULSES }, () => new THREE.Color()) },
    uScale: { value: 800 },
    uShip: { value: new THREE.Vector4(0, 0, 1, 0) },
    uShipSpeed: { value: 0 },
    uStorm: { value: new THREE.Vector4(0, 0, 1, 0) },
    uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCenter: { value: new THREE.Vector2() },
    uSwellA: { value: SWELL.map(() => new THREE.Vector4(0, 1, 0.1, 1)) },
    uSwellB: { value: SWELL.map(() => new THREE.Vector4(0, 0, 0, 0)) },
    uChopA: { value: CHOP.map(() => new THREE.Vector4(0, 1, 0.5, 2)) },
    uChopB: { value: CHOP.map(() => new THREE.Vector4(0, 0, 0, 0)) },
    uSteepS: { value: STEEP.swell }, uSteepC: { value: STEEP.chop },
    uAmp: { value: 0.5 }, uCaps: { value: 0 },
    uSSS: { value: new THREE.Color(0.1, 0.62, 0.55) },
    uDay: { value: 0 },
    uIsles: { value: Array.from({ length: ISLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uDayDeep: { value: new THREE.Color(0.012, 0.085, 0.2) },
    uDayShallow: { value: new THREE.Color(0.07, 0.42, 0.42) },
  };
  const surfaceUniforms = { tDiffuse: { value: null }, color: { value: new THREE.Color(0x7f7f7f) }, textureMatrix: { value: new THREE.Matrix4() } };
  const shaderFor = (reflector) => ({
    name: reflector ? "RexmawSea" : "RexmawSeaLow",
    uniforms: { ...surfaceUniforms, ...shared },
    vertexShader: WATER_VERT,
    fragmentShader: waterFrag(reflector),
  });
  const grids = {};
  const gridFor = (tier) => { const n = SPOKES[tier] || SPOKES.high; return (grids[n] ||= buildGrid(n)); };
  const geometry = gridFor(R.quality?.tier || "high");

  // ---- The reflective surface (Medium+) -----------------------------------------
  const reflectSize = () => {
    const q = R.quality, s = R.size;
    const k = Math.max(0.1, q.reflect || 0.5);
    return [Math.max(64, Math.round(s.w * s.dpr * k)), Math.max(64, Math.round(s.h * s.dpr * k))];
  };
  const [rw, rh] = reflectSize();
  const reflector = new Reflector(geometry, { textureWidth: rw, textureHeight: rh, clipBias: 0.003, multisample: 0, shader: shaderFor(true) });
  reflector.name = "water.reflector";
  for (const k of Object.keys(shared)) reflector.material.uniforms[k] = shared[k];
  reflector.material.fog = false;
  reflector.camera.layers.set(layers.WORLD);
  reflector.camera.layers.enable(layers.SKY);
  reflector.camera.layers.enable(layers.FX);
  const reflect = reflector.onBeforeRender;
  reflector.onBeforeRender = function (renderer, sc, camera, ...rest) {
    if (camera !== R.camera) return;               // only for the player's view
    reflect.call(this, renderer, sc, camera, ...rest);
  };

  // ---- The analytic surface (Low) ------------------------------------------------
  const lowMat = new THREE.ShaderMaterial({ ...shaderFor(false), fog: false });
  const analytic = new THREE.Mesh(geometry, lowMat);
  analytic.name = "water.analytic";

  for (const m of [reflector, analytic]) {
    m.rotation.x = -Math.PI / 2;
    m.position.y = WATER_Y;
    m.layers.set(layers.NOREFLECT);         // the water never sees itself
    m.renderOrder = -1;
    m.frustumCulled = false;
    scene.add(m);
  }

  // ---- Plankton ------------------------------------------------------------------
  const planktonGeo = new THREE.BufferGeometry();
  {
    const rnd = mulberry32(0x91a7c3);
    const pos = new Float32Array(PLANKTON_MAX * 3), seed = new Float32Array(PLANKTON_MAX);
    for (let i = 0; i < PLANKTON_MAX; i++) {
      pos[i * 3] = (rnd() - 0.5) * TILE;
      pos[i * 3 + 1] = WATER_Y + 0.025 + rnd() * 0.03;
      pos[i * 3 + 2] = (rnd() - 0.5) * TILE;
      seed[i] = rnd();
    }
    planktonGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    planktonGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    planktonGeo.setDrawRange(0, R.quality.plankton);
  }
  const plankton = new THREE.Points(planktonGeo, new THREE.ShaderMaterial({
    name: "NightHelmPlankton", uniforms: shared, vertexShader: PLANKTON_VERT, fragmentShader: PLANKTON_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  plankton.name = "water.plankton";
  plankton.frustumCulled = false;
  plankton.renderOrder = 2;
  plankton.layers.set(layers.NOREFLECT);
  scene.add(plankton);

  // ---- The waves (CPU twin of the shader's) ------------------------------------------
  const swell = { dir: 0, strength: 0.5, amp: 0.4 };
  const mk = ([lambda, share, off, phase]) => ({ lambda, share, off, phase, dx: 0, dz: 1, k: 2 * Math.PI / lambda, w: 0 });
  const trains = SWELL.map(mk), chops = CHOP.map(mk);
  for (const tr of [...trains, ...chops]) tr.w = Math.sqrt(G * tr.k);
  function applyWind() {
    // `dir` is where the wind blows FROM (sailing usage); the waves run the other way.
    const put = (list, arr) => list.forEach((tr, i) => {
      const toward = (swell.dir + 180 + tr.off) * Math.PI / 180;
      tr.dx = -Math.sin(toward); tr.dz = Math.cos(toward);
      arr[i].set(tr.dx, tr.dz, tr.k, tr.w);
    });
    put(trains, shared.uSwellA.value);
    put(chops, shared.uChopA.value);
  }
  applyWind();
  let openSea = 0;

  /** The storm's share at (x, z), as the shaders have it. */
  function stormAt(x, z) {
    const st = shared.uStorm.value;
    if (!(st.w > 0)) return 0;
    const d = Math.hypot(x - st.x, z - st.y);
    return st.w * THREE.MathUtils.smoothstep(st.z - d, 0, st.z * 0.45);
  }
  /** The Gerstner displacement of the undisplaced point (x0, z0): writes D.x, D.y, D.z. */
  const _D = { x: 0, y: 0, z: 0 };
  function displace(x0, z0, t, sk, out) {
    out.x = 0; out.y = 0; out.z = 0;
    const QS = shared.uSteepS.value, QC = shared.uSteepC.value;
    for (let i = 0; i < trains.length; i++) {
      const tr = trains[i], A = shared.uSwellB.value[i].x * (1 + 1.8 * sk);
      const ph = tr.k * (tr.dx * x0 + tr.dz * z0) - tr.w * t + tr.phase;
      const c = Math.cos(ph);
      out.y += A * Math.sin(ph); out.x += QS * A * tr.dx * c; out.z += QS * A * tr.dz * c;
    }
    for (let i = 0; i < chops.length; i++) {
      const tr = chops[i], A = shared.uChopB.value[i].x * (1 + 1.3 * sk);
      const ph = tr.k * (tr.dx * x0 + tr.dz * z0) - tr.w * t + tr.phase;
      const c = Math.cos(ph);
      out.y += A * Math.sin(ph); out.x += QC * A * tr.dx * c; out.z += QC * A * tr.dz * c;
    }
    return out;
  }

  /**
   * The sea at (x, z) now: the surface's height above WATER_Y there and its slopes. Matches the shader's
   * displaced grid (the horizontal Gerstner shift is inverted with two fixed-point steps). NaN-safe.
   * @param {number} x @param {number} z @param {{h: number, dx: number, dz: number}} [out]
   */
  function swellAt(x, z, out = { h: 0, dx: 0, dz: 0 }) {
    out.h = 0; out.dx = 0; out.dz = 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return out;
    const t = shared.uTime.value;
    const sk = stormAt(x, z);
    let x0 = x, z0 = z;
    for (let it = 0; it < 2; it++) { displace(x0, z0, t, sk, _D); x0 = x - _D.x; z0 = z - _D.z; }
    displace(x0, z0, t, sk, _D);
    out.h = _D.y;
    // Slopes (Eulerian; for heel and pitch these are plenty).
    for (let i = 0; i < trains.length; i++) {
      const tr = trains[i], A = shared.uSwellB.value[i].x * (1 + 1.8 * sk);
      const c = A * tr.k * Math.cos(tr.k * (tr.dx * x0 + tr.dz * z0) - tr.w * t + tr.phase);
      out.dx += tr.dx * c; out.dz += tr.dz * c;
    }
    if (!Number.isFinite(out.h)) { out.h = 0; out.dx = 0; out.dz = 0; }
    return out;
  }

  // ---- State ---------------------------------------------------------------------
  const harbourAt = { x: 0, z: 0 };
  const ripple = tween(1), glow = tween(0.4), bio = tween(0);
  let baseGlow = 0.4, glowOverride = null, pulseSlot = 0;
  const plankCol = PLANKTON_COLOR.clone().multiplyScalar(2.2);
  const _cam = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ");
  let lastShipX = NaN, lastShipZ = NaN;

  function applyTier(q) {
    const refl = q.water === "reflector";
    reflector.visible = refl;
    analytic.visible = !refl;
    const g = gridFor(q.tier);
    reflector.geometry = g; analytic.geometry = g;
    if (refl) { const [w, h] = reflectSize(); reflector.getRenderTarget().setSize(w, h); }
    planktonGeo.setDrawRange(0, q.plankton);
  }
  applyTier(R.quality);

  function update(dt, time) {
    shared.uTime.value = time;
    shared.uRipple.value = ripple.step(time);
    shared.uGlow.value = glow.step(time);
    shared.uBio.value = bio.step(time);

    // Recentre on the camera: the shading and the waves are in world space, so nothing slides.
    R.camera.getWorldPosition(_cam);
    reflector.position.set(_cam.x, WATER_Y, _cam.z);
    analytic.position.set(_cam.x, WATER_Y, _cam.z);

    // The ship's waterline frame (for the hull's foam and glow) and the plankton tile's centre.
    const ss = R.shipSpace;
    if (ss) {
      _q.copy(ss.quaternion);
      _e.setFromQuaternion(_q, "YXZ");
      const yaw = _e.y;
      shared.uShip.value.set(ss.position.x, ss.position.z, Math.cos(yaw), Math.sin(yaw));
      shared.uCenter.value.set(ss.position.x + 30 * Math.sin(yaw), ss.position.z + 30 * Math.cos(yaw));   // a little ahead of the ship
      // Her speed (for the hull's wash), from her own track.
      if (dt > 0 && Number.isFinite(lastShipX)) {
        const v = Math.hypot(ss.position.x - lastShipX, ss.position.z - lastShipZ) / dt;
        if (v < 60) shared.uShipSpeed.value += (v - shared.uShipSpeed.value) * Math.min(1, dt * 2);
      }
      lastShipX = ss.position.x; lastShipZ = ss.position.z;
      // Open sea: the swell builds with distance from the home port's mooring.
      const d = Math.hypot(ss.position.x - harbourAt.x, ss.position.z - harbourAt.z);
      openSea = THREE.MathUtils.smoothstep(d, HARBOUR.calm, HARBOUR.open);
    }
    const A = swell.amp * (0.18 + 0.82 * openSea);
    trains.forEach((tr, i) => shared.uSwellB.value[i].set(A * tr.share, tr.phase, 0, 0));
    const chopK = (0.35 + 0.65 * swell.strength) * (0.4 + 0.6 * openSea);
    chops.forEach((tr, i) => shared.uChopB.value[i].set(tr.share * chopK, tr.phase, 0, 0));
    shared.uAmp.value = Math.max(0.05, A * (1 + 0.55 + 0.3) * 0.75 + chopK * 0.1);
    // Whitecaps: none in a light air, building from a moderate breeze (strength 0.45) to a fresh one.
    shared.uCaps.value = THREE.MathUtils.smoothstep(swell.strength, 0.4, 1.0) * (0.3 + 0.7 * openSea);

    const sk = sky();
    if (sk) {
      shared.uMoonDir.value.copy(sk.moonDir);
      shared.uMoonVis.value = sk.moonLight;
      const u = sk.uniforms;
      shared.uSunDir.value.copy(sk.sunDir);
      shared.uSunColor.value.copy(u.uSunColor.value);
      shared.uSunVis.value = THREE.MathUtils.smoothstep(sk.sunDir.y, -0.01, 0.02);
      shared.uZenith.value.copy(u.uZenith.value);
      shared.uHorizon.value.copy(u.uHorizon.value);
      shared.uBand.value.copy(u.uBand.value);
    }
    if (scene.fog) { shared.uFogColor.value.copy(scene.fog.color); shared.uFogDensity.value = scene.fog.density; }
    // Rexmaw Raids: the day (the sky owns R.atmos.day); the plankton only shows at night.
    const day = R.atmos?.day || 0;
    shared.uDay.value = day;
    if (day > 0.001 && sk) shared.uSunVis.value = Math.max(shared.uSunVis.value, day);
    plankton.visible = day < 0.95;
    const cam = R.camera;
    shared.uScale.value = (R.size.h * R.size.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  }

  const off = R.onFrame(update, -10);
  const offQ = R.onQuality(applyTier);
  const offR = R.onResize(() => { if (reflector.visible) { const [w, h] = reflectSize(); reflector.getRenderTarget().setSize(w, h); } });

  const water = {
    reflector, analytic, plankton,
    /** The shared uniforms (uTime, uSwellA/B, uChopA/B, uGlow, uFogColor, uFogDensity...), for anyone drawing on the sea. */
    uniforms: shared,
    /** GLSL: `float seaHeight(vec2 worldXZ)` (declares uSwellA/B, uChopA/B; the includer declares uTime). */
    SEA_HEIGHT_GLSL,
    swellAt,
    /** The sea's height at (x, z), world y of the surface there. */
    heightAt: (x, z) => WATER_Y + swellAt(x, z, _sw).h,
    /** 0 in the harbour, 1 out at sea. */
    get openSea() { return openSea; },
    /** The wind's strength 0..1 as the sea has it (whitecaps from ~0.45). */
    get wind() { return { dirDeg: swell.dir, strength: swell.strength }; },

    /**
     * A ring of light expanding across the sea from (x, z) (world). Eight
     * slots, reused oldest first. Returns the slot.
     * @param {{x: number, z: number, color?: THREE.ColorRepresentation, speed?: number, intensity?: number}} opts
     */
    pulse({ x = 0, z = 0, color = null, speed = 7, intensity = 1 } = {}) {
      const i = pulseSlot;
      pulseSlot = (pulseSlot + 1) % PULSES;
      shared.uPulse.value[i].set(+x || 0, +z || 0, R.time, Math.max(0.5, +speed || 7));
      const c = shared.uPulseColor.value[i];
      if (color == null) c.copy(plankCol); else c.set(color).multiplyScalar(2.2);
      c.multiplyScalar(Number.isFinite(+intensity) ? +intensity : 1);
      return i;
    },

    /** The plankton's glow (0..1.5), easing; null hands it back to the night. */
    setGlow(v, { duration = 3 } = {}) {
      glowOverride = v == null ? null : THREE.MathUtils.clamp(+v || 0, 0, 1.5);
      glow.set(glowOverride ?? baseGlow, duration, R.time);
    },

    /**
     * The wind (sailing usage: the bearing it blows FROM, heading convention) and
     * its strength 0..1: the swell runs downwind, 0.25–0.8 m in open water; chop and whitecaps rise with it.
     */
    setWind(dirDeg, strength = 0.5) {
      swell.dir = +dirDeg || 0;
      swell.strength = THREE.MathUtils.clamp(+strength || 0, 0, 1);
      swell.amp = 0.25 + 0.55 * swell.strength;
      applyWind();
    },

    /** Night Raid: where the home port's mooring is (the swell is calm there, open beyond ~500 m). */
    setHarbour(x, z) { harbourAt.x = +x || 0; harbourAt.z = +z || 0; },

    /** Night Raid: the storm cell (world x, z, radius m, strength 0..1; 0 = no storm). */
    setStorm(x, z, r, k) { shared.uStorm.value.set(+x || 0, +z || 0, Math.max(1, +r || 1), THREE.MathUtils.clamp(+k || 0, 0, 1)); },

    /** Rexmaw Raids: the islands whose sandy shallows show turquoise by day ([{x, z, r}], up to 10). */
    setIslands(list = []) {
      const u = shared.uIsles.value;
      for (let i = 0; i < ISLES; i++) {
        const is = list[i];
        if (is && Number.isFinite(+is.x)) u[i].set(+is.x, +is.z, Math.max(10, +is.r || 80) * 0.82, 1); else u[i].set(0, 0, 0, 0);
      }
    },

    /** Night Raid: open the surface inside a circle (the maelstrom's bowl); r = 0 closes it. */
    setHole(x, z, r) { shared.uHole.value.set(+x || 0, +z || 0, Math.max(0, +r || 0), 0); },

    /** A calmer, glassier surface (harbour, arrival). 1 = as built. */
    setRipple(v, { duration = 3 } = {}) { ripple.set(THREE.MathUtils.clamp(+v || 0, 0, 2), duration, R.time); },

    /** The night clock: the deep water's colour and the tide's base glow. */
    setNight(t, { duration = 4 } = {}) {
      const x = THREE.MathUtils.clamp(+t || 0, 0, 1);
      baseGlow = 0.2 + 0.45 * THREE.MathUtils.smoothstep(x, 0.0, 0.55) - 0.25 * THREE.MathUtils.smoothstep(x, 0.9, 1.0);
      if (glowOverride == null) glow.set(baseGlow, duration, R.time);
      shared.uDeepLight.value = 1.0 + 0.6 * (1 - THREE.MathUtils.smoothstep(x, 0.0, 0.25)) + 0.8 * THREE.MathUtils.smoothstep(x, 0.85, 1.0);
    },

    /** Debug: the grid. */
    stats() { const g = reflector.geometry; return { verts: g.attributes.position.count, tris: g.index.count / 3, rings: g.userData.rings, amp: shared.uAmp.value, caps: shared.uCaps.value }; },

    dispose() {
      off(); offQ(); offR();
      scene.remove(reflector, analytic, plankton);
      reflector.dispose();
      lowMat.dispose();
      for (const g of Object.values(grids)) g.dispose();
      planktonGeo.dispose();
      plankton.material.dispose();
      if (R.water === water) R.water = null;
    },
  };
  const _sw = { h: 0, dx: 0, dz: 0 };

  water.setNight(R.sky?.night ?? 0.55, { duration: 0 });
  update(0, R.time);
  R.water = water;
  return water;
}
