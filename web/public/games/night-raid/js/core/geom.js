// Rexmaw Raids' geometry helpers: angles, headings, compass words, polygons, capsules.
// Shared by the world generator, the sim, the briefs and the parsers.
// Heading 0 = +Z, increasing toward −X (starboard), as in const.js. Pure.

import { DEG } from "./const.js";

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const ease = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-6, tau));
export const round1 = (v) => Math.round(v * 10) / 10;
export const dist = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

/** An angle in degrees wrapped to (−180, 180]. */
export function wrap180(a) {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}
/** An angle in degrees wrapped to [0, 360). */
export const wrap360 = (a) => ((a % 360) + 360) % 360;
/** The heading (°) of the direction (dx, dz). */
export const headingOf = (dx, dz) => wrap360(Math.atan2(-dx, dz) / DEG);
/** The unit forward vector of heading ψ (°). */
export function forward(psi) {
  const p = psi * DEG;
  return { x: -Math.sin(p), z: Math.cos(p) };
}
/** The unit port (left) normal of heading ψ (°). */
export function portNormal(psi) {
  const p = psi * DEG;
  return { x: Math.cos(p), z: Math.sin(p) };
}
/** The bearing (°, + = starboard) of (x, z) seen from (fx, fz) on heading ψ. */
export const relBearing = (fx, fz, psi, x, z) => wrap180(headingOf(x - fx, z - fz) - psi);
/** World → ship-space {lx (port +), lz (bow +)}. */
export function toLocal(x, z, psi, wx, wz) {
  const f = forward(psi), p = portNormal(psi);
  const dx = wx - x, dz = wz - z;
  return { lx: dx * p.x + dz * p.z, lz: dx * f.x + dz * f.z };
}

export const COMPASS16 = Object.freeze(["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east",
  "south-east", "south-south-east", "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west",
  "north-west", "north-north-west"]);
export const COMPASS16_ABBR = Object.freeze(["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]);
export const COMPASS8_ABBR = Object.freeze(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
export const compassWord = (deg) => COMPASS16[Math.round(wrap360(deg) / 22.5) % 16];
export const compassAbbr = (deg) => COMPASS16_ABBR[Math.round(wrap360(deg) / 22.5) % 16];
export const compass8Abbr = (deg) => COMPASS8_ABBR[Math.round(wrap360(deg) / 45) % 8];
export const degText = (deg) => String(Math.round(wrap360(deg)) % 360).padStart(3, "0");

/** A relative bearing in sailor's words: "dead ahead", "starboard bow", "port beam", "astern"... */
export function sideWord(rel) {
  const r = wrap180(rel), a = Math.abs(r);
  if (a <= 12) return "dead ahead";
  if (a >= 168) return "dead astern";
  const side = r > 0 ? "starboard" : "port";
  if (a < 60) return `${side} bow`;
  if (a <= 120) return `${side} beam`;
  return `${side} quarter`;
}

/** Distance in round words: 600 m → "600 m", 1240 → "1.2 km". */
export function metres(d) {
  if (d >= 1000) return `${(Math.round(d / 100) / 10).toFixed(1)} km`;
  return `${Math.max(10, Math.round(d / 10) * 10)} m`;
}

/** Point in polygon (XZ, any winding). */
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from (px, pz) to segment a–b, with the closest point. */
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / L2, 0, 1) : 0;
  const cx = ax + dx * t, cz = az + dz * t;
  return { d: Math.hypot(px - cx, pz - cz), x: cx, z: cz, t };
}

/** Signed-ish distance from a point to a polygon's edge: negative inside. Also the closest edge point. */
export function polyDist(x, z, poly) {
  let best = { d: Infinity, x: 0, z: 0 };
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const s = segDist(x, z, poly[j].x, poly[j].z, poly[i].x, poly[i].z);
    if (s.d < best.d) best = { d: s.d, x: s.x, z: s.z };
  }
  return { d: inPoly(x, z, poly) ? -best.d : best.d, x: best.x, z: best.z };
}

/** The distance between segments a0–a1 and b0–b1 (0 when they cross; else the nearest endpoint-to-segment distance). */
export function segSegDist(a0x, a0z, a1x, a1z, b0x, b0z, b1x, b1z) {
  const cross = (ox, oz, px, pz, qx, qz) => (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(b0x, b0z, b1x, b1z, a0x, a0z), d2 = cross(b0x, b0z, b1x, b1z, a1x, a1z);
  const d3 = cross(a0x, a0z, a1x, a1z, b0x, b0z), d4 = cross(a0x, a0z, a1x, a1z, b1x, b1z);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(a0x, a0z, b0x, b0z, b1x, b1z).d, segDist(a1x, a1z, b0x, b0z, b1x, b1z).d,
    segDist(b0x, b0z, a0x, a0z, a1x, a1z).d, segDist(b1x, b1z, a0x, a0z, a1x, a1z).d);
}

/** Distance from a point to a capsule {a, b, w} (a reef band or a rock): negative inside. Also the closest axis point. */
export function capsuleDist(px, pz, c) {
  const s = segDist(px, pz, c.a.x, c.a.z, c.b.x, c.b.z);
  return { d: s.d - c.w, x: s.x, z: s.z };
}

/** Distance from a point to a polyline (open, or closed when `loop`). */
export function polylineDist(x, z, pts, loop = false) {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n - (loop ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    best = Math.min(best, segDist(x, z, a.x, a.z, b.x, b.z).d);
  }
  return best;
}

/** A standard normal from two uniforms (Box-Muller), using the given rng. */
export function gauss(rng) {
  const u = Math.max(1e-12, rng.next()), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
