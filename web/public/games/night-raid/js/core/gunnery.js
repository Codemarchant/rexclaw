// Gunnery (spec v2 §3): Black Flag style. The camera's look direction picks
// the weapon, its pitch lays the guns, and every ball flies a real ballistic
// arc (muzzle speed, gravity) that both the HUD's preview and the sim use, so
// an arc drawn on the water lands exactly where the ball will.
//
//   weaponFor(look, ctx)            → {weapon, side, target?}  broadside | heavy | chain | barrels | mortar | none
//   elevationFor(weapon, pitch)     → degrees the guns are laid at
//   planAimed({pose, weapon, side, yaw, elev}) → balls (one per gun)
//   aimPreview(state, look)         → {weapon, side, arcs:[{points, land, hit, hitAt}], circle, drops, ready, ...}
//   crewSolution({pose, side, weapon, target, skill, rng}) → {yaw, elev, circle?} | null  (the companion's gun crews)
//   enemyBalls({shooter, side, target, ...})                → balls with the enemy hit model's scatter
//   traceBall(ball, targets, {from, ammo})                  → the first hull it meets on its flight, or where it lands
//   v4: lockLay / layFor / mortarAim — the Captain's lay snaps to the LOCKED ship within LOCK.cone (preview = volley);
//       crewBears / crewRange — the crews hold fire beyond their shot's effective range (CREW_RANGE), aim worse with range.
//
// A ball is {x0, z0, y0, dx, dz, vh, vy, T, x1, z1, gun}: it leaves (x0, y0, z0)
// along the unit direction (dx, dz) at vh horizontally and vy up, and meets
// the sea at (x1, z1) after T seconds. Hits are continuous: a ball is in a hull
// when it is inside her waterline ellipse and below her freeboard (chain:
// inside the wider rigging ellipse, below the mast tops), so a ball laid too
// high flies over her and splashes beyond.
//
// Pure: no three.js, no DOM, no Math.random (scatter takes the caller's rng).

import { AMMO, HIT, BALLISTIC, WEAPONS, LOOK, RELOAD, CLASSES, SHIP, FORT, CREW_AIM, CREW_RANGE, LOCK } from "./const.js";
import { clamp, dist, wrap180, wrap360, headingOf, forward, portNormal, relBearing, gauss, toLocal, segSegDist } from "./geom.js";

const G = BALLISTIC.g, V0 = BALLISTIC.v0, DEG = Math.PI / 180;

// ---- Ballistics ---------------------------------------------------------------------------

/** Flight of a ball fired at `elev`° from height y0: {vh, vy, T, range}. */
export function ballistic(elev, y0 = BALLISTIC.muzzleY, v0 = V0) {
  const vh = v0 * Math.cos(elev * DEG), vy = v0 * Math.sin(elev * DEG);
  const T = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * G * y0))) / G;
  return { vh, vy, T, range: vh * T };
}

/** The (low) elevation that puts a ball `L` m out from height y0, or null beyond `maxElev`. */
export function elevationForRange(L, y0 = BALLISTIC.muzzleY, maxElev = 30, minElev = -10) {
  if (ballistic(maxElev, y0).range < L) return null;
  if (ballistic(minElev, y0).range >= L) return minElev;
  let lo = minElev, hi = maxElev;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (ballistic(mid, y0).range < L) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A ball from (x0, z0, y0) along heading `dirDeg` at `elev`°. */
export function makeBall(x0, z0, y0, dirDeg, elev, extra = {}) {
  const f = forward(dirDeg);
  const b = ballistic(elev, y0);
  return { x0, z0, y0, dx: f.x, dz: f.z, vh: b.vh, vy: b.vy, T: b.T, x1: x0 + f.x * b.range, z1: z0 + f.z * b.range, elev, dir: dirDeg, ...extra };
}

/** A ball that lands at (x1, z1) after exactly `T` s (mortar shells: a high lob). */
export function lobBall(x0, z0, y0, x1, z1, T, extra = {}) {
  const L = dist(x0, z0, x1, z1) || 1e-6;
  const vh = L / T, vy = (0.5 * G * T * T - y0) / T;
  return { x0, z0, y0, dx: (x1 - x0) / L, dz: (z1 - z0) / L, vh, vy, T, x1, z1, elev: Math.atan2(vy, vh) / DEG, dir: headingOf(x1 - x0, z1 - z0), ...extra };
}

/** A ball's position and velocity `tau` s after it left the muzzle. */
export function ballAt(b, tau) {
  const t = clamp(tau, 0, b.T);
  return {
    x: b.x0 + b.dx * b.vh * t, z: b.z0 + b.dz * b.vh * t,
    y: Math.max(0, b.y0 + b.vy * t - 0.5 * G * t * t),
    vx: b.dx * b.vh, vz: b.dz * b.vh, vy: b.vy - G * t,
  };
}

// ---- Hulls ----------------------------------------------------------------------------------

const classOf = (s) => s.C || CLASSES[s.cls] || CLASSES.brig;
const isRexmaw = (s) => s.id === "rexmaw";
const isFixed = (s) => !!(s.fixed || s.cls === "tower" || classOf(s).fixed);

/** The hull ellipse half-axes of a ship: {hl, hb}. */
export function hullAxes(ship) {
  if (isRexmaw(ship)) return { hl: SHIP.length / 2, hb: SHIP.beam / 2 };
  const C = classOf(ship);
  return { hl: C.len / 2, hb: C.beam / 2 };
}
/** Her freeboard (m above the water a ball must be under to hole her). */
export function freeboard(ship) {
  if (isRexmaw(ship)) return SHIP.freeboard;
  if (isFixed(ship)) return FORT.towerH;
  return clamp(0.09 * classOf(ship).len + 1, 2.6, 6.5);
}

/** Is (x, y, z) inside `ship` for a ball of `ammo`? Chain catches the rigging (wider, up to the mast tops). */
export function inHull(ship, x, y, z, ammo = "round") {
  if (isFixed(ship)) return y <= FORT.towerH && dist(x, z, ship.x, ship.z) <= (ship.r || FORT.towerR);
  const { hl, hb } = hullAxes(ship);
  const rig = !!AMMO[ammo]?.rigging;
  const H = rig ? HIT.mastsH * hl * 2 : freeboard(ship);
  if (y > H) return false;
  const l = toLocal(ship.x, ship.z, ship.heading, x, z);
  const a = l.lz / hl, b = l.lx / (rig ? hb * HIT.riggingBeam : hb);
  return a * a + b * b <= 1;
}

/** Can a ball hit this ship at all (afloat, not going down)? */
export const hittable = (s) => !!s && !s.gone && s.state !== "sinking" && !s.down;

/**
 * Follow a ball from `tau0` (s after it was fired) to its landing, against `targets` (ships with x, z, heading, cls/C).
 * Returns {ship, tau, x, y, z} for the first hull it meets, or {ship: null, tau: T, x: x1, y: 0, z: z1}.
 */
export function traceBall(b, targets, { from = null, ammo = "round", tau0 = 0, tau1 = b.T, dt = BALLISTIC.fine, lead = false } = {}) {
  // Only hulls the ball's ground track passes near (their own track swept while it flies, when leading) are tested.
  const p0 = ballAt(b, tau0), p1 = ballAt(b, Math.min(tau1, b.T));
  const near = targets.filter((s) => {
    if (s.id === from || !hittable(s)) return false;
    const R = (isFixed(s) ? (s.r || FORT.towerR) : hullAxes(s).hl * (AMMO[ammo]?.rigging ? 1.1 : 1)) + 4;
    const vx = lead ? s.vx || 0 : 0, vz = lead ? s.vz || 0 : 0;
    return segSegDist(p0.x, p0.z, p1.x, p1.z, s.x + vx * tau0, s.z + vz * tau0, s.x + vx * tau1, s.z + vz * tau1) <= R + 2;
  });
  if (near.length) {
    for (let tau = tau0; tau <= tau1 + 1e-9; tau += dt) {
      const p = ballAt(b, Math.min(tau, b.T));
      for (const s0 of near) {
        // `lead`: the targets sail on at their present velocity while the ball flies (the preview's prediction).
        const s = lead && !isFixed(s0) && (s0.vx || s0.vz) ? { ...s0, x: s0.x + (s0.vx || 0) * tau, z: s0.z + (s0.vz || 0) * tau } : s0;
        const R = isFixed(s) ? (s.r || FORT.towerR) + 2 : hullAxes(s).hl * 1.1 + 2;
        if (Math.abs(p.x - s.x) > R + 30 || Math.abs(p.z - s.z) > R + 30) continue;
        if (inHull(s, p.x, p.y, p.z, ammo)) return { ship: s0, tau, x: p.x, y: p.y, z: p.z };
      }
      if (tau >= b.T) break;
    }
  }
  return { ship: null, tau: b.T, x: b.x1, y: 0, z: b.z1 };
}

// ---- Arcs, raking, reloads --------------------------------------------------------------------

/** The angle (0..90°) between a line of fire from (fx, fz) and the target's fore-and-aft axis. */
export function rakeAngle(fx, fz, target) {
  const lof = headingOf(target.x - fx, target.z - fz);
  const a = Math.abs(wrap180(lof - target.heading));
  return a > 90 ? 180 - a : a;
}
/** A raking shot: along her length, within RAKE° of the bow/stern axis. */
export const isRaking = (fx, fz, target) => !isFixed(target) && rakeAngle(fx, fz, target) <= HIT.rakeDeg;

/** Reload multiplier for a gun crew at `frac` (0..1) of full strength: 1 full, 1.6 half, 3 none. */
export function reloadMul(frac) {
  const c = clamp(frac, 0, 1);
  if (c >= 1) return 1;
  if (c >= 0.5) return 1 + ((1 - c) / 0.5) * (RELOAD.half - 1);
  return RELOAD.half + ((0.5 - c) / 0.5) * (RELOAD.none - RELOAD.half);
}

/** What one ball does: {hull, masts, leak, fire, gun, kill} (chances are rolled by the sim). */
export function ballDamage(ammo, { raking = false } = {}) {
  const A = AMMO[ammo] || AMMO.round;
  const k = raking ? HIT.rakeMul : 1;
  return { hull: A.hull * k, masts: A.masts * k, leak: A.leak, fire: A.fire, gun: A.gun, kill: A.kill };
}

// ---- The Captain's weapons ---------------------------------------------------------------------

const centreOf = (side) => (side === "port" ? -90 : side === "starboard" ? 90 : side === "bow" ? 0 : 180);

/** Broadside elevation (°) from the look pitch: looking up lays the guns higher. */
export function elevationFor(weapon, pitch = -12) {
  const W = WEAPONS[weapon] || WEAPONS.broadside;
  if (weapon === "heavy") return WEAPONS.heavy.elev;
  return clamp(((Number(pitch) || 0) - W.pitch0) * W.gain, 0, W.maxElev);
}
/** Mortar range (m) from the look pitch. */
export const mortarRange = (pitch = -12) => clamp(WEAPONS.mortar.minRange + ((Number(pitch) || 0) - WEAPONS.mortar.pitch0) * WEAPONS.mortar.perDeg,
  WEAPONS.mortar.minRange, WEAPONS.mortar.maxRange);

/** The look, tidied: {yaw (rel °, + starboard), pitch, aiming, mode, point}. */
export function normLook(look = {}) {
  const yaw = wrap180(Number(look.lookYawRel ?? look.yaw ?? 90) || 0);
  const pitch = clamp(Number(look.lookPitch ?? look.pitch ?? -12) || 0, -89, 89);
  const p = look.point && Number.isFinite(look.point.x) && Number.isFinite(look.point.z) ? { x: look.point.x, z: look.point.z } : null;
  return { yaw, pitch, aiming: !!look.aiming, mode: look.mode === "mortar" ? "mortar" : "auto", point: p };
}

/**
 * The weapon a look selects. ctx: {pose, contacts} for the auto-mortar (an aimed broadside look at a
 * ship beyond broadside range, within the auto cone).
 */
export function weaponFor(lookIn, { pose = null, contacts = [], lock = null } = {}) {
  const look = normLook(lookIn);
  const a = Math.abs(look.yaw);
  if (look.mode === "mortar") return { weapon: "mortar", side: "mortar" };
  if (a <= LOOK.bow) return { weapon: "chain", side: "bow" };
  if (a >= LOOK.stern) return { weapon: "barrels", side: "stern" };
  const side = look.yaw > 0 ? "starboard" : "port";
  // v5: the Kraken's eye (locked while it's up) is far beyond the heavy volley's 90 m: a plain click looking its way fires the
  // aimed broadside, laid on it (lockLay), so no hold-to-aim and no pitch to judge.
  const eyeInCone = !!lock?.eye && !!pose && Math.abs(wrap180(relBearing(pose.x, pose.z, pose.heading, lock.x, lock.z) - look.yaw)) <= LOCK.cone;
  if (!look.aiming && !eyeInCone) return { weapon: "heavy", side };
  if (pose) {
    const M = WEAPONS.mortar;
    const lookDir = wrap360(pose.heading + look.yaw);
    let best = null;
    for (const c of contacts) {
      if (!hittable(c) || c.detected === false) continue;
      const d = dist(pose.x, pose.z, c.x, c.z);
      if (d < M.autoFrom || d > M.maxRange) continue;
      const off = Math.abs(wrap180(headingOf(c.x - pose.x, c.z - pose.z) - lookDir));
      // v4: the locked ship wins the auto-mortar anywhere in the lock's cone.
      const isLock = !!lock && c.id === lock.id;
      if ((off <= M.autoCone || (isLock && off <= LOCK.cone)) && (!best || isLock || (!best.lock && off < best.off))) best = { c, off, lock: isLock };
    }
    if (best) return { weapon: "mortar", side: "mortar", auto: true, target: best.c };
  }
  return { weapon: "broadside", side };
}

/**
 * v4 §2: the lay that puts an aimed broadside / the bow chasers on the LOCKED ship (her lead, the solved elevation),
 * when the look is within LOCK.cone of her and she's in the guns' traverse and reach. → {yaw, elev, lead} | null
 */
export function lockLay(pose, weapon, side, target, lookYaw) {
  if (!target || !hittable(target) || (weapon !== "broadside" && weapon !== "chain")) return null;
  const W = WEAPONS[weapon];
  const relT = relBearing(pose.x, pose.z, pose.heading, target.x, target.z);
  if (Math.abs(wrap180(relT - lookYaw)) > LOCK.cone) return null;
  const m = muzzles(pose, weapon, side);
  const cx = m.reduce((s, q) => s + q.x, 0) / m.length, cz = m.reduce((s, q) => s + q.z, 0) / m.length;
  const vx = target.vx || 0, vz = target.vz || 0;
  let ax = target.x, az = target.z, elev = 0;
  for (let k = 0; k < 3; k++) {
    const L = dist(cx, cz, ax, az);
    const e = elevationForRange(L, BALLISTIC.muzzleY, W.maxElev, -6);
    if (e == null) return null;
    elev = e;
    const T = L / ballistic(e).vh;
    ax = target.x + vx * T; az = target.z + vz * T;
  }
  const yaw = relBearing(cx, cz, pose.heading, ax, az);
  if (Math.abs(wrap180(yaw - centreOf(side))) > (W.traverse ?? 0)) return null;
  return { yaw, elev, lead: { x: ax, z: az } };
}

/**
 * The Captain's lay for a look (the preview and the volley share it, so the arcs are where the balls go):
 * the heavy volley's lay, the locked ship's snapped lay, else the look itself. → {yaw, elev, target, snapped, lead}
 */
export function layFor(pose, look, sel, contacts = [], lock = null) {
  if (sel.weapon === "heavy") {
    const lay = heavyLay(pose, sel.side, contacts, lock);
    return { yaw: lay.yaw, elev: lay.elev, target: lay.target, snapped: !!lock && lay.target === lock, lead: null };
  }
  const sn = lockLay(pose, sel.weapon, sel.side, lock, look.yaw);
  if (sn) return { yaw: sn.yaw, elev: sn.elev, target: lock, snapped: true, lead: sn.lead };
  return { yaw: look.yaw, elev: elevationFor(sel.weapon, look.pitch), target: null, snapped: false, lead: null };
}

/** The mortar's ring for a look: the auto target, the locked ship (in the cone and the mortar's reach), else the look's own. */
export function mortarAim(pose, look, sel, lock = null) {
  const M = WEAPONS.mortar;
  if (sel.auto) return { circle: mortarCircle(pose, look, sel.target), snapped: !!lock && sel.target === lock, target: sel.target };
  if (lock && hittable(lock)) {
    const d = dist(pose.x, pose.z, lock.x, lock.z);
    const relT = relBearing(pose.x, pose.z, pose.heading, lock.x, lock.z);
    // Aimed at a point on the sea (the cursor), the cone is judged from the point's bearing, not the camera's.
    const aimYaw = look.point ? relBearing(pose.x, pose.z, pose.heading, look.point.x, look.point.z) : look.yaw;
    const nearPoint = !look.point || dist(look.point.x, look.point.z, lock.x, lock.z) <= 80;
    if (nearPoint && d >= M.minRange && d <= M.maxRange && Math.abs(wrap180(relT - aimYaw)) <= LOCK.cone) {
      const c = mortarCircle(pose, look, lock);
      return { circle: c, snapped: true, target: lock, lead: { x: c.x, z: c.z } };
    }
  }
  return { circle: mortarCircle(pose, look, null), snapped: false, target: null };
}

/** Where the guns sit (world x, z) for a weapon on a side. */
export function muzzles(pose, weapon, side) {
  const f = forward(pose.heading), p = portNormal(pose.heading);
  const hl = SHIP.length / 2, hb = SHIP.beam / 2;
  const out = [];
  const at = (lx, lz) => ({ x: pose.x + p.x * lx + f.x * lz, z: pose.z + p.z * lx + f.z * lz, lx, lz });
  if (weapon === "chain") { out.push(at(1.2, hl * 0.92), at(-1.2, hl * 0.92)); return out; }
  if (weapon === "barrels") { for (const lx of [4, 0, -4]) out.push(at(lx, -(SHIP.half + 6))); return out; }
  if (weapon === "mortar") { out.push(at(0, -2)); return out; }
  const n = WEAPONS.broadside.guns;
  const sgn = side === "port" ? 1 : -1;
  for (let i = 0; i < n; i++) out.push(at(sgn * hb, (-0.62 + 1.24 * (i / (n - 1))) * hl * 0.9));
  return out;
}

/** The world heading the guns point along: the look clamped to the weapon's traverse. */
export function gunHeading(pose, weapon, side, yawRel) {
  const W = WEAPONS[weapon] || WEAPONS.broadside;
  const c = centreOf(side);
  const rel = c + clamp(wrap180(yawRel - c), -(W.traverse ?? 0), W.traverse ?? 0);
  return wrap360(pose.heading + rel);
}

/** One ball per gun for an aimed (or heavy) volley: the guns parallel along `yaw` (rel °) at `elev`°. */
export function planAimed({ pose, weapon, side, yaw, elev }) {
  const dir = gunHeading(pose, weapon, side, yaw);
  return muzzles(pose, weapon, side).map((m, i) => makeBall(m.x, m.z, BALLISTIC.muzzleY, dir, elev, { gun: i, delay: i * BALLISTIC.stagger }));
}

/** The heavy volley's lay: on the nearest ship in that side's traverse within range, else flat out on the beam. */
export function heavyLay(pose, side, contacts = [], lock = null) {
  const W = WEAPONS.heavy, c = centreOf(side);
  let best = null;
  for (const e of contacts) {
    if (!hittable(e) || e.id === "rexmaw") continue;
    const d = dist(pose.x, pose.z, e.x, e.z);
    if (d > W.range + 25) continue;
    const rel = relBearing(pose.x, pose.z, pose.heading, e.x, e.z);
    if (Math.abs(wrap180(rel - c)) > W.traverse + 8) continue;
    const isLock = !!lock && e.id === lock.id;   // v4: the locked ship first when she's in its traverse and reach
    if (!best || isLock || (!best.lock && d < best.d)) best = { e, d, rel, lock: isLock };
  }
  if (!best) return { yaw: c, elev: W.elev, target: null };
  const elev = clamp(elevationForRange(Math.max(1, best.d - 2)) ?? W.elev, -6, W.elev + 3);
  return { yaw: best.rel, elev, target: best.e };
}

/** The mortar's target ring: the look's point, or along the look at the pitch's range (or the auto target, led). */
export function mortarCircle(pose, look, auto = null) {
  const M = WEAPONS.mortar;
  if (auto) {
    const lx = auto.x + (auto.vx || 0) * M.flight, lz = auto.z + (auto.vz || 0) * M.flight;
    return { x: lx, z: lz, r: M.ring };
  }
  if (look.point) {
    const d = dist(pose.x, pose.z, look.point.x, look.point.z);
    const k = d > M.maxRange ? M.maxRange / d : d < M.minRange ? M.minRange / Math.max(1, d) : 1;
    return { x: pose.x + (look.point.x - pose.x) * k, z: pose.z + (look.point.z - pose.z) * k, r: M.ring };
  }
  const f = forward(pose.heading + look.yaw), R = mortarRange(look.pitch);
  return { x: pose.x + f.x * R, z: pose.z + f.z * R, r: M.ring };
}

/** Mortar shells into a ring: offsets from `rng` (or a fixed spread without one), all landing after the flight time. */
export function mortarShells(pose, circle, rng = null, n = WEAPONS.mortar.guns) {
  const M = WEAPONS.mortar;
  const m = muzzles(pose, "mortar", "mortar")[0];
  const out = [];
  for (let i = 0; i < n; i++) {
    let ox, oz;
    if (rng) { const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * circle.r * 0.75; ox = Math.cos(a) * r; oz = Math.sin(a) * r; }
    else { const a = (i / n) * Math.PI * 2; ox = Math.cos(a) * circle.r * 0.4; oz = Math.sin(a) * circle.r * 0.4; }
    out.push(lobBall(m.x, m.z, 3, circle.x + ox, circle.z + oz, M.flight + i * 0.12, { gun: i, delay: i * 0.25 }));
  }
  return out;
}

/** Where the fire barrels fall astern. */
export const barrelDrops = (pose) => muzzles(pose, "barrels", "stern").map((m) => ({ x: m.x, z: m.z }));

/** The flight of a ball as points every SAMPLE s up to `tauEnd`. */
function arcPoints(b, tauEnd) {
  const pts = [];
  for (let tau = 0; tau < tauEnd; tau += BALLISTIC.sample) { const p = ballAt(b, tau); pts.push({ x: r2(p.x), y: r2(p.y), z: r2(p.z) }); }
  const e = ballAt(b, tauEnd);
  pts.push({ x: r2(e.x), y: r2(e.y), z: r2(e.z) });
  return pts;
}
const r2 = (v) => Math.round(v * 100) / 100;

/** The contacts a preview or a volley can hit, from a state snapshot or the sim. */
function targetsOf(contacts) {
  return (contacts || []).filter((c) => c && c.id !== "rexmaw" && hittable(c));
}

/**
 * The aim preview the scene and HUD draw: per-gun ballistic arcs with hit flags, the mortar ring, the barrel drops.
 * `state`: run.state() (or any {ship, contacts, reload, ship.ammo}); `look`: the `aim` intent's payload.
 */
export function aimPreview(state, lookIn = {}, { lock: lockIn } = {}) {
  const look = normLook(lookIn);
  const pose = state?.ship;
  const empty = { weapon: "none", side: null, aiming: look.aiming, ready: false, reload: 0, reloadS: 0, ammo: null, elevation: 0, range: 0,
    arcs: [], hit: false, targetId: null, circle: null, drops: [], locked: null, snapped: false, lead: null };
  if (!pose || !Number.isFinite(pose.x)) return empty;
  const contacts = targetsOf(state.contacts);
  // v4: the locked ship (an object, an id, or the snapshot's own `lock` / `marked`).
  const lockId = lockIn && typeof lockIn === "object" ? lockIn.id : lockIn ?? (state.lock && typeof state.lock === "object" ? state.lock.id : state.lock) ?? state.marked ?? null;
  const lock = lockIn && typeof lockIn === "object" && hittable(lockIn) ? lockIn : lockId != null ? contacts.find((c) => c.id === lockId) || null : null;
  const sel = weaponFor(look, { pose, contacts, lock });
  const W = WEAPONS[sel.weapon];
  const key = sel.weapon === "broadside" || sel.weapon === "heavy" ? sel.side : sel.weapon === "chain" ? "bow" : sel.weapon;
  const reload = clamp(Number(state.reload?.[key] ?? 1), 0, 1);
  const ammoKey = W.ammo;
  const ammo = ammoKey ? Math.floor(Number(state.ship?.ammo?.[ammoKey] ?? 0)) : null;
  const ready = reload >= 1 && (ammo == null || ammo > 0);
  const out = { ...empty, weapon: sel.weapon, side: sel.side, ready, reload, reloadS: Number(state.reloadS?.[key] ?? 0), ammo, locked: lock ? lock.id : null };
  if (sel.weapon === "barrels") { out.drops = barrelDrops(pose); out.range = 0; return out; }
  if (sel.weapon === "mortar") {
    const ma = mortarAim(pose, look, sel, lock);
    const c = ma.circle;
    out.snapped = ma.snapped;
    out.lead = ma.snapped ? { x: r2(c.x), z: r2(c.z) } : null;
    out.circle = { x: r2(c.x), z: r2(c.z), r: c.r };
    out.range = Math.round(dist(pose.x, pose.z, c.x, c.z));
    out.elevation = 45;
    const tgt = ma.snapped ? ma.target : contacts.find((e) => dist(e.x, e.z, c.x, c.z) <= c.r + hullAxes(e).hb);
    out.targetId = tgt ? tgt.id : null;
    out.hit = !!tgt;
    // The lob of the middle shell, for a dotted line from the mortar.
    const b = mortarShells(pose, c, null, 1)[0];
    out.arcs = [{ gun: 0, from: { x: r2(b.x0), y: r2(b.y0), z: r2(b.z0) }, points: arcPoints(b, b.T), land: { x: r2(b.x1), z: r2(b.z1) }, hit: out.targetId, hitAt: null }];
    return out;
  }
  const lay = layFor(pose, look, sel, contacts, lock);
  const yaw = lay.yaw, elev = lay.elev;
  if (sel.weapon === "heavy") out.targetId = lay.target?.id ?? null;
  out.snapped = lay.snapped;
  out.lead = lay.lead ? { x: r2(lay.lead.x), z: r2(lay.lead.z) } : null;
  out.elevation = Math.round(elev * 10) / 10;
  const balls = planAimed({ pose, weapon: sel.weapon, side: sel.side, yaw, elev });
  out.range = Math.round(dist(balls[0].x0, balls[0].z0, balls[0].x1, balls[0].z1));
  const hits = {};
  out.arcs = balls.map((b) => {
    const tr = traceBall(b, contacts, { from: "rexmaw", ammo: W.shot, lead: true });
    if (tr.ship) hits[tr.ship.id] = (hits[tr.ship.id] || 0) + 1;
    return { gun: b.gun, from: { x: r2(b.x0), y: r2(b.y0), z: r2(b.z0) }, points: arcPoints(b, tr.tau), land: { x: r2(tr.x), z: r2(tr.z) },
      hit: tr.ship ? tr.ship.id : null, hitAt: tr.ship ? { x: r2(tr.x), y: r2(tr.y), z: r2(tr.z) } : null };
  });
  // v5: arcs ending within the locked eye's reach count as on it (no hull to trace).
  if (lock?.eye) for (const a of out.arcs) if (!a.hit && dist(a.land.x, a.land.z, lock.x, lock.z) <= lock.r) hits[lock.id] = (hits[lock.id] || 0) + 1;
  const top = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
  out.hit = !!top;
  if (top) out.targetId = top[0];
  return out;
}

// ---- The companion's gun crews -----------------------------------------------------------------

/** Does `side`'s battery bear on `target` (in the traverse, in range)? → {rel, d} or null. (The guns' full reach: the Captain's.) */
export function bears(pose, side, target, weapon = side === "bow" ? "chain" : "broadside") {
  const d = dist(pose.x, pose.z, target.x, target.z);
  if (side === "mortar") return d >= WEAPONS.mortar.minRange * 0.8 && d <= WEAPONS.mortar.maxRange ? { rel: relBearing(pose.x, pose.z, pose.heading, target.x, target.z), d } : null;
  const W = WEAPONS[weapon];
  const rel = relBearing(pose.x, pose.z, pose.heading, target.x, target.z);
  if (Math.abs(wrap180(rel - centreOf(side))) > W.traverse + 4) return null;
  if (d > ballistic(W.maxElev).range + hullAxes(target).hb) return null;
  return { rel, d };
}

/** v4 §4: a crew's effective range for a shot (m, centre to centre); mortars: the mortar's own 150–600 m (explicit orders only). */
export const crewRange = (ammo) => (ammo === "mortar" ? WEAPONS.mortar.maxRange : CREW_RANGE[ammo] ?? CREW_RANGE.round);

/**
 * v4 §4: does `side`'s battery bear on `target` for a CREW firing `ammo` — in the traverse and inside the crew's effective
 * range? → {rel, d, short: false} | {rel, d, short: true} (bears for the guns, but too far for the crew) | null.
 */
export function crewBears(pose, side, target, ammo = side === "bow" ? "chain" : side === "mortar" ? "mortar" : "round") {
  const b = bears(pose, side, target, side === "bow" ? "chain" : "broadside");
  if (!b) return null;
  return { ...b, short: side !== "mortar" && b.d > crewRange(ammo) };
}

/**
 * How a gun crew lays the battery on `target`: lead her by the flight time, solve the elevation, then the
 * crew's own error (σ shrinks with skill and grows with range). With `ammo`, null beyond the crew's range
 * for that shot (v4). → {yaw, elev, d} | {circle} (mortar) | null when she doesn't bear.
 */
export function crewSolution({ pose, side, weapon = side === "bow" ? "chain" : side === "mortar" ? "mortar" : "broadside", target, skill = 1, rng = null, ammo = null }) {
  const vx = target.vx || 0, vz = target.vz || 0;
  if (side === "mortar") {
    if (!bears(pose, "mortar", target)) return null;
    const M = WEAPONS.mortar;
    const s = CREW_AIM.mortarSigma / Math.max(0.3, skill);
    const ex = rng ? gauss(rng) * s : 0, ez = rng ? gauss(rng) * s : 0;
    return { circle: { x: target.x + vx * M.flight + ex, z: target.z + vz * M.flight + ez, r: M.ring } };
  }
  const brs = bears(pose, side, target, weapon);
  if (!brs) return null;
  if (ammo && brs.d > crewRange(ammo)) return null;
  const falloff = 1 + brs.d / CREW_RANGE.falloff;
  const W = WEAPONS[weapon];
  const m = muzzles(pose, weapon, side);
  const cx = m.reduce((a, q) => a + q.x, 0) / m.length, cz = m.reduce((a, q) => a + q.z, 0) / m.length;
  let ax = target.x, az = target.z, elev = 0, T = 0;
  for (let k = 0; k < 3; k++) {
    const L = dist(cx, cz, ax, az);
    const e = elevationForRange(L, BALLISTIC.muzzleY, W.maxElev, -6);
    if (e == null) return null;
    elev = e; T = L / ballistic(e).vh;
    ax = target.x + vx * T; az = target.z + vz * T;
  }
  let yaw = relBearing(cx, cz, pose.heading, ax, az);
  if (Math.abs(wrap180(yaw - centreOf(side))) > W.traverse + 4) return null;
  if (rng) {
    const k = falloff / Math.max(0.3, skill);
    yaw += gauss(rng) * CREW_AIM.yawSigma * k;
    elev = clamp(elev + gauss(rng) * CREW_AIM.elevSigma * k, -6, W.maxElev);
  }
  return { yaw, elev, d: dist(cx, cz, ax, az), T };
}

// ---- The enemy's guns ------------------------------------------------------------------------------

/** σ (deflection, range) in metres for one enemy ball. */
export function sigmaFor({ range, shooterSpeed = 0, crossSpeed = 0, sea = 0, skill = 1 }) {
  const spread = 1 + HIT.speed * Math.abs(shooterSpeed) + HIT.rel * Math.abs(crossSpeed) + sea;
  const d = (HIT.base + HIT.perM * range) * spread / Math.max(0.2, skill);
  return { d, r: d * HIT.rangeMul };
}

/** Where an enemy's guns sit along a broadside (or the bow, or a tower's embrasures). */
export function enemyMuzzles(shooter, side, n) {
  if (isFixed(shooter)) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: shooter.x + (i - (n - 1) / 2) * 3, z: shooter.z, y: FORT.towerH - 2 });
    return out;
  }
  const { hl, hb } = hullAxes(shooter);
  const f = forward(shooter.heading), p = portNormal(shooter.heading);
  const out = [];
  for (let i = 0; i < n; i++) {
    let lx, lz;
    if (side === "bow") { lx = (i - (n - 1) / 2) * 1.5; lz = hl * 0.9; }
    else { lx = (side === "port" ? 1 : -1) * hb; lz = n > 1 ? (-0.6 + 1.2 * (i / (n - 1))) * hl * 0.9 : 0; }
    out.push({ x: shooter.x + p.x * lx + f.x * lz, z: shooter.z + p.z * lx + f.z * lz, y: BALLISTIC.muzzleY });
  }
  return out;
}

/** One enemy volley's balls: lead the target, lay for her, scatter by the hit model. */
export function enemyBalls({ shooter, side, target, skill = 1, sea = 0, rng, guns }) {
  const n = Math.max(0, guns | 0);
  const pts = enemyMuzzles(shooter, side, n);
  const tv = { x: target.vx || 0, z: target.vz || 0 };
  const sv = isFixed(shooter) ? 0 : shooter.speed || 0;
  const balls = [];
  for (let i = 0; i < n; i++) {
    const m = pts[i];
    let ax = target.x, az = target.z, T = 0;
    for (let k = 0; k < 2; k++) {
      const L = dist(m.x, m.z, ax, az);
      const e = elevationForRange(L, m.y, 30, -10) ?? 30;
      T = L / ballistic(e, m.y).vh;
      ax = target.x + tv.x * T; az = target.z + tv.z * T;
    }
    const range = dist(m.x, m.z, ax, az);
    const ux = (ax - m.x) / Math.max(1, range), uz = (az - m.z) / Math.max(1, range);
    const cross = Math.abs(tv.x * -uz + tv.z * ux);
    const sg = sigmaFor({ range, shooterSpeed: sv, crossSpeed: cross, sea, skill });
    const er = gauss(rng) * sg.r, ed = gauss(rng) * sg.d;
    const x1 = ax + ux * er + -uz * ed, z1 = az + uz * er + ux * ed;
    const L = Math.max(5, dist(m.x, m.z, x1, z1));
    const elev = elevationForRange(L, m.y, 35, -15) ?? 35;
    balls.push({ ...makeBall(m.x, m.z, m.y, headingOf(x1 - m.x, z1 - m.z), elev), gun: i, delay: i * BALLISTIC.stagger });
  }
  return balls;
}
