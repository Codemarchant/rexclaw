// Rexmaw Raids: the Black Flag camera. A close third-person orbit around the Rexmaw that the
// mouse swings (cursor aim or free look, independent of the wheel), with a small lag on turns,
// a mouse-wheel zoom between a low deck-level view and a wide tactical one, an automatic
// pull-back and a wider lens at the full-sail sprint, a push-in to a fixed shoulder view while a
// weapon is aimed, and slow recentring astern when the Captain lets go of a free-look mouse.
// v4.1: aiming the bow chasers, or zoomed in looking ahead, the lens moves forward of her rig to
// the bow (FOLLOW.bowView), so her sails and yards are behind it and the sea ahead is clear.
//
// How Assassin's Creed IV: Black Flag (PC, 2013) does it — what the v3 camera copies (research
// 2026-10-07, sources below):
//   - Distance rides the sail state, not a zoom key: the third speed step ("travel speed": W
//     pressed up through the sail settings, A ×3 on a pad) "zooms out a bit so that more of the
//     surrounding sea can be seen" (Softpedia), and only in open water — away from islands and
//     storms — and any action (combat, brace) snaps it back to the normal distance (Steam
//     threads; Game8 for the 2026 Resynced remake: "performing any action other than sailing
//     will immediately return you to the normal camera distance").           → `sprint` pull-back
//     here (×1.2 and FOV +8°), damped to 40 % while a hostile is within ~350 m (`threat`).
//   - There is NO manual camera zoom on the ship: the mouse wheel is the spyglass's zoom (and the
//     shanty selector) — "Spyglass Zoom In / Out: Scroll Wheel" (Shacknews, Resynced key map).
//     Rexmaw Raids adds the wheel zoom the v3 spec asks for (deck level ↔ tactical), and while
//     the spyglass is up the wheel zooms the glass instead, as in AC4.          → `zoomBy`, spyZoom
//   - Aiming is "Hold Right Click" (primary aim), "Hold Q" (mortar), "Hold Shift" (swivel); the
//     side the camera looks to picks the weapon ("the side of the ship you aim from decides which
//     weapon fires" — allthings.how / Prima naval guides). Aiming pulls the view into a fixed
//     over-the-guns framing whatever the travel distance was.         → aim push-in to `aimZoom`
//   - The camera sits low and close to the sea on purpose ("You're positioned quite low compared
//     to the ocean, so you actually see these waves" — Ubisoft Singapore on AC3's naval camera,
//     which Black Flag inherited).                                      → the close end, `near`
//   - Mouse: sensitivity slider + invert Y; acceleration is always on and can't be disabled; the
//     FOV is fixed (only hackable) — PCGamingWiki. Arrow keys pan, C recentres (PC defaults).
//     Pitch limits and the exact distances are not published: the numbers below are ours,
//     tuned against the hull (40 × 10 m) and the guns' ranges (55–600 m).
// Sources:
//   https://games.softpedia.com/blog/Assassin-s-Creed-4-Black-Flag-Has-Improved-Ship-Sailing-380276.shtml
//   https://steamcommunity.com/app/242050/discussions/0/666826703468006054/  (Zooming out camera while aboard?)
//   https://steamcommunity.com/app/3751950/discussions/0/572669207837276501/ (travel speed zoom-out, open water only)
//   https://game8.co/games/Assassins-Creed-Black-Flag-Resynced/archives/610314 (How to Zoom Out on Ship)
//   https://www.shacknews.com/article/149927/assassins-creed-black-flag-resynced-controls (wheel = spyglass zoom)
//   https://www.pcgamingwiki.com/wiki/Assassin%27s_Creed_IV:_Black_Flag (FOV hackable, accel always on, invert Y)
//   https://www.gamedeveloper.com/design/q-a-making-waves-in-i-assassin-s-creed-iii-i- (low camera to see the waves)
//   https://allthings.how/?p=66721 (right stick pans the camera; the aimed side picks the weapon)
//
// Frames: ship space (+Z bow, +X port, y up; the camera rides R.shipSpace). The LOOK is what the
// input layer reads to pick the weapon:
//   yaw    degrees relative to the hull, 0 = looking over the bow (camera astern), + = starboard,
//          −180..180 (the core's relative-bearing convention)
//   pitch  degrees, the view's elevation (+ up); the broadside's range rides it
//   aim01  pitch mapped 0..1 between the lowest and the highest aim (for the elevation)
//   zone   "bow" (|yaw| ≤ 35), "port" / "starboard" (45..135 that side), "stern" (|yaw| ≥ 145),
//          or the last zone in the gaps between (hysteresis)
//
// Cursor aim (v3 default): the UI maps the cursor to a look (or calls cursorLook) and sends it
// with source "cursor": the camera eases to it (τ 0.14 s) and never recentres on its own (the
// cursor holds the look). Free look (pointer lock): mouse deltas, applied at once.

import * as THREE from "three";
import { dir } from "./blocking.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

export const FOLLOW = Object.freeze({
  // The zoom: 0 = deck level (low over the quarterdeck, the waves at eye height), 1 = tactical (high and wide, the
  // battle round her); `rest` is v2's sailing view (31 m astern / 12 m up of mid-deck). Each stop: [back, up] m.
  zoom: { near: [15, 4.6], rest: [31, 12], far: [96, 52], restZ: 0.36, step: 0.11, tau: 0.16 },
  back: 31, up: 12,                  // v2 names (the rest stop)
  focus: [0, 1.6, 3.5],              // ship space: what the orbit turns about (mid-deck, the waterline + a bit)
  pitch: { rest: -11, min: -38, max: 14 },
  aimPitch: { min: -16, max: 12 },   // the elevation band the broadside aim maps to aim01 0..1
  fov: 56, sprintFov: 8, wideFov: 4, // wideFov: the tactical end opens the lens a little
  halfSail: 0.88, furled: 0.82, sprint: 1.2, sprintThreat: 0.4,
  aimZoom: 0.3, aimPush: 0.88,       // aiming eases the zoom to this (≤ the Captain's own) and in by this factor
  lagK: 0.3, lagMax: 16,             // s of turn rate the camera trails by; degrees max
  recentreAfter: 4.5, recentreTau: 1.8, recentreWithin: 55,
  cursorTau: 0.14,                   // s: cursor aim eases the look (free look is immediate)
  // Cursor aim: |x| (−1..1 across the canvas) under `dead` = ahead; the edges reach `edgeYaw` (the quarters astern).
  cursor: { dead: 0.07, edgeYaw: 165, curve: 0.9, pitchUp: 10, pitchDown: 16 },
  zones: { bow: 35, beamLo: 45, beamHi: 135, stern: 145 },
  // core WEAPONS.mortar (minRange, maxRange, pitch0, perDeg); reticleDeg: ui RETICLE_Y 0.46 at the aimed FOV (~52°).
  // `view`: cursor aim's mortar view. The circle sits on the sea under the cursor (world.mortarPoint), so the lens
  // holds still (the Captain turns it at the screen's edges, ui/input.js) and stands back and up over her (`zoom` of
  // the wheel's 0..1, the orbit `elevUp`° steeper than that zoom's) looking `ahead` m out: 150–600 m in one view.
  mortar: { min: 150, max: 600, pitch0: -25, perDeg: 18, reticleDeg: 2.2, view: { zoom: 0.85, elevUp: 14, ahead: 330, tau: 0.4 } },
  // v4.1: the bow view. Looking ahead from astern, every one of her sails and yards stands between the lens and the
  // sea (v4's stand-further-aft pose still looked through the courses, and the GLB's yards and rigging can't be
  // dithered). So looking ahead, the lens goes FORWARD of her rig instead (AC4's chain-shot aim frames the sea ahead
  // with the ship behind the camera):
  //   aim      holding the aim over the bow (the chasers' chain shot): out past the jibboom (`aim` [x, y, z], ship
  //            space), clear of every sail and stay — the outer jib's tack is at (0, 7.5, 30.9) and its luff climbs
  //            aft to (0, 15.8, 17.9) (shipkit.js sailGeometry), so anywhere over the bowsprit the lens sat inside the
  //            jibs — 3 m over the tack, so the chasers' arcs (overlays.js ribbons, 0.85 m wide, from (0, 2.35,
  //            19.6)) pass well under the lens instead of filling the frame's foot; a step toward the side the
  //            look turns to (`aimX` m at ±25°), the look `aimPitch`° up.
  //   lookout  zoomed in past `zoomIn` (two wheel notches in from the sailing view) and looking within ±`yawIn`° of
  //            the bow (out again past `zoomOut` / ±`yawOut`°, or when a broadside / the mortar is aimed): just aft
  //            of the outer jib's tack and 2.3 m over its luff (`look`; x = m toward the side the look turns to,
  //            starboard by default). Measured 2026-10-08: over the stem beside the bowsprit the jibs still filled a
  //            third of the frame (dithered), so the lookout stands clear of them too.
  // In and out over `ramp` s (eased in-out), swinging out `arcOut` m past her side and up `arcUp` m on the way so the
  // move never passes through her canvas (the yards reach ±7.2 m). The fore course spans z 14.2..19.2 (sails.js).
  bowView: {
    aim: [0, 10.8, 31.5], aimX: 1.6, aimPitch: 3,
    look: [1.8, 10.0, 30.5], lookPitch: 5,
    zoomIn: 0.15, zoomOut: 0.2, yawIn: 35, yawOut: 60,
    ramp: 0.55, arcOut: 9, arcUp: 3,
  },
});

/**
 * The Rexmaw's canvas as keep-out boxes (ship space, [x0, x1, y0, y1, z0, z1]; sails.js's plan + the billow and a
 * margin): wherever the orbit lands, the lens is pushed out of them (aft, up or to the side, the shortest way).
 */
const CANVAS = Object.freeze([
  [-1.6, 1.6, 4.4, 10.9, -16.8, -9.6],      // the spanker (fore-and-aft, on the centreline abaft the mizzen)
  [-4.8, 4.8, 9.3, 14.3, -10.7, -7.0],      // the mizzen topsail
  [-7.2, 7.2, 2.3, 23.2, 6.2, 11.4],        // the main course, topsail, t'gallant
  [-6.4, 6.4, 3.8, 19.9, 14.2, 19.2],       // the fore
  [-1.6, 1.6, 3.0, 16.5, 16.0, 29.0],       // the jibs
  [-2.6, 1.0, 10.8, 13.5, -14.6, -12.7],    // the ensign at the spanker gaff's peak
]);
function clearOfCanvas(p) {
  for (const b of CANVAS) {
    if (p.x <= b[0] || p.x >= b[1] || p.y <= b[2] || p.y >= b[3] || p.z <= b[4] || p.z >= b[5]) continue;
    // The cheapest way out: aft, up, or to whichever side is nearer (never down onto the deck, never forward into her rig).
    const aft = p.z - b[4], up = b[3] - p.y, side = Math.min(p.x - b[0], b[1] - p.x);
    if (aft <= up && aft <= side) p.z = b[4] - 0.05;
    else if (up <= side) p.y = b[3] + 0.05;
    else p.x = p.x - b[0] < b[1] - p.x ? b[0] - 0.05 : b[1] + 0.05;
  }
  return p;
}

/** The [back, up] offset for a zoom 0..1 (log-distance between the stops, so each wheel notch feels alike). */
function offsetAt(z, out) {
  const Z = FOLLOW.zoom;
  const a = z <= Z.restZ ? Z.near : Z.rest, b = z <= Z.restZ ? Z.rest : Z.far;
  const t = z <= Z.restZ ? z / Z.restZ : (z - Z.restZ) / (1 - Z.restZ);
  const da = Math.hypot(a[0], a[1]), db = Math.hypot(b[0], b[1]);
  const D = Math.exp(lerp(Math.log(da), Math.log(db), t));
  const e = lerp(Math.atan2(a[1], a[0]), Math.atan2(b[1], b[0]), t);
  out.D = D; out.e = e / DEG;
  return out;
}

/**
 * @param {object} R  the render context
 * @returns the follow rig: {pos, target, step(st, dt, motion), lookBy, setLook, aim, look, zoomBy, setZoom, ...}
 */
export function createFollow(R) {
  const F = FOLLOW;
  const pos = new THREE.Vector3(0, F.up, -F.back), target = new THREE.Vector3(0, 0, 40);
  const focus = new THREE.Vector3().fromArray(F.focus);
  const s = {
    yaw: 0, pitch: F.pitch.rest, lag: 0, dist: 1, side: 0, aimK: 0, aiming: false, aimSide: null,
    idle: 99, zone: "bow", sprint: 0, fovOff: 0, settled: false, user: false, bowK: 0,
    // v3: the look's goal (cursor aim eases to it), the zoom (goal and sprung), the threat damping.
    yawT: 0, pitchT: F.pitch.rest, ease: 0, cursor: false,
    zoomT: F.zoom.restZ, zoom: F.zoom.restZ, threat: 0, closeAhead: 0,
    // v4.1 the bow view: fwd 0..1 (the ramp), fwdAim (the aim pose's share), lookout (latched), the side, the arc's side.
    fwd: 0, fwdAim: 0, lookout: false, fwdSide: 1, arcX: -1,
    // The mortar view's share (cursor aim in mortar mode), eased.
    mortK: 0,
  };
  const _d = new THREE.Vector3(), _f = new THREE.Vector3(), _p = new THREE.Vector3(), _o = { D: 0, e: 0 };

  function zoneOf(yaw, prev) {
    const a = Math.abs(yaw), Z = F.zones;
    if (a <= Z.bow) return "bow";
    if (a >= Z.stern) return "stern";
    if (a >= Z.beamLo && a <= Z.beamHi) return yaw > 0 ? "starboard" : "port";
    return prev;
  }

  /**
   * Per frame. `m` = {sail (0 furled, 1 half, 2 full), sprint (bool), turnRate (deg/s), speed, threat (0..1: a hostile close)}.
   */
  function step(dt, m = {}) {
    const d = clamp(+dt || 0, 0, 0.1);
    s.idle += d;
    // The look's goal: cursor aim eases there; free look already put it there.
    if (s.ease > 0) {
      const k = 1 - Math.exp(-d / s.ease);
      s.yaw = wrap180(s.yaw + wrap180(s.yawT - s.yaw) * k);
      s.pitch += (s.pitchT - s.pitch) * k;
      if (Math.abs(wrap180(s.yawT - s.yaw)) < 0.02 && Math.abs(s.pitchT - s.pitch) < 0.02) { s.yaw = s.yawT; s.pitch = s.pitchT; s.ease = 0; }
    }
    // Recentre astern when the Captain lets go of a free-look mouse (never under cursor aim: the cursor holds the look).
    if (!s.cursor && !s.aiming && s.idle > F.recentreAfter && Math.abs(s.yaw) < F.recentreWithin) {
      const k = 1 - Math.exp(-d / F.recentreTau);
      s.yaw += (0 - s.yaw) * k;
      s.pitch += (F.pitch.rest - s.pitch) * k;
      s.yawT = s.yaw; s.pitchT = s.pitch;
    }
    s.zone = zoneOf(s.yaw, s.zone);
    // The lag: the camera trails the turn a little, then catches up.
    const lagT = clamp(-(+m.turnRate || 0) * F.lagK, -F.lagMax, F.lagMax);
    s.lag += (lagT - s.lag) * (1 - Math.exp(-d / 0.6));
    // The zoom: the wheel's goal, sprung; aiming eases it to the aim framing (never further out than the Captain's).
    const aimT = s.aiming ? 1 : 0;
    s.aimK += (aimT - s.aimK) * (1 - Math.exp(-d / 0.25));
    const MV = F.mortar.view, mortT = s.aiming && s.aimSide === "mortar" && s.cursor ? 1 : 0;
    s.mortK += (mortT - s.mortK) * (1 - Math.exp(-d / MV.tau));
    s.zoom += (s.zoomT - s.zoom) * (1 - Math.exp(-d / F.zoom.tau));
    const zoomEff = lerp(lerp(s.zoom, Math.min(s.zoom, F.aimZoom), s.aimK), MV.zoom, s.mortK);
    offsetAt(clamp(zoomEff, 0, 1), _o);
    // Distance: closer at half sail, out at the sprint (AC4's travel speed; damped in a fight); the aim pushes in.
    const sail = clamp(Math.round(+m.sail || 0), 0, 2);
    const sprintT = m.sprint ? 1 : 0;
    s.sprint += (sprintT - s.sprint) * (1 - Math.exp(-d / (sprintT ? 0.5 : 0.9)));
    s.threat += (clamp(+m.threat || 0, 0, 1) - s.threat) * (1 - Math.exp(-d / 1.2));
    const pull = (F.sprint - 1) * s.sprint * (1 - (1 - F.sprintThreat) * s.threat);
    const base = sail === 2 ? 1 : sail === 1 ? F.halfSail : F.furled;
    const distT = base * (1 + pull) * lerp(1, F.aimPush, s.aimK * (1 - s.mortK));
    s.dist += (distT - s.dist) * (1 - Math.exp(-d / 0.7));
    // The aimed side: the orbit's focus slides a few metres toward the guns (over the bow: a little to starboard, so
    // the masts don't stand in the middle of the sight line).
    const sideT = s.aiming && s.aimSide ? (s.aimSide === "port" ? 1 : s.aimSide === "starboard" ? -1 : s.zone === "bow" ? -1.6 : 0) : 0;
    s.side += (sideT - s.side) * (1 - Math.exp(-d / 0.3));

    const yaw = s.yaw + s.lag;
    // Looking up lowers the camera, looking down lifts it (the orbit's elevation follows the look).
    const e0 = _o.e;
    // Aiming: the pitch steers the elevation, so the camera holds a high shoulder view over the deck instead.
    // Out at the tactical end the look's pitch moves the orbit less (it's a map-like view).
    const zk = clamp((zoomEff - F.zoom.restZ) / (1 - F.zoom.restZ), 0, 1);
    const coupled = e0 - (s.pitch - F.pitch.rest) * lerp(0.65, 0.25, zk);
    // Over the bow (the chasers) the camera climbs higher still, to look down past her canvas (sails.js fades it too).
    const bowK = s.zone === "bow" ? 1 : 0;
    s.bowK += (bowK * s.aimK - s.bowK) * (1 - Math.exp(-d / 0.3));
    const elev = clamp(coupled + (e0 + lerp(6 + 5 * s.bowK, MV.elevUp, s.mortK) - coupled) * s.aimK, 3, 70);
    // Looking aft the orbit swings forward over her bow: stand off clear of the foremast's canvas and the bowsprit
    // (the jibboom ends ~25 m forward of the orbit's centre) whatever the zoom; on the beam the yards are overhead.
    const fwd = smooth01((Math.abs(yaw) - 80) / 70);
    const D = Math.max(_o.D * s.dist, 36 * fwd);
    dir(yaw, 0, _d);
    _f.copy(focus);
    _f.x += s.side * 3.2;
    pos.copy(_f).addScaledVector(_d, -Math.cos(elev * DEG) * D);
    pos.y = _f.y + Math.sin(elev * DEG) * D;
    // Keep the lens out of the hull and the sea, and never inside her canvas.
    if (pos.y < 2.2) pos.y = 2.2;
    clearOfCanvas(pos);
    // v4.1 the bow view (FOLLOW.bowView): aiming the chasers, or zoomed in looking ahead, the lens goes forward of her rig.
    const BV = F.bowView, ay = Math.abs(s.yaw);
    const bowAimT = s.aiming && s.aimSide === "bow" ? 1 : 0;
    if (s.aiming || s.zoom > BV.zoomOut || ay > BV.yawOut) s.lookout = false;
    else if (s.zoom < BV.zoomIn && ay < BV.yawIn) s.lookout = true;
    const fwdT = Math.max(bowAimT, s.lookout ? 1 : 0);
    s.fwd = clamp(s.fwd + clamp(fwdT - s.fwd, -d / BV.ramp, d / BV.ramp), 0, 1);
    s.fwdAim += (bowAimT - s.fwdAim) * (1 - Math.exp(-d / 0.25));
    const fwdSideT = s.yaw > 8 ? 1 : s.yaw < -8 ? -1 : s.fwdSide >= 0 ? 1 : -1;     // +1 = starboard (−X)
    s.fwdSide += (fwdSideT - s.fwdSide) * (1 - Math.exp(-d / 0.4));
    const fk = smooth01(s.fwd);
    let fwdPitch = 0;
    if (fk > 0) {
      const a = s.fwdAim;
      _p.set(lerp(-BV.look[0] * s.fwdSide, BV.aim[0] - BV.aimX * clamp(yaw / 25, -1, 1), a), lerp(BV.look[1], BV.aim[1], a), lerp(BV.look[2], BV.aim[2], a));
      // The arc's side is chosen as a move starts (and kept through it): the side the pose stands on, else starboard.
      if (s.fwd < 0.02 || s.fwd > 0.98) s.arcX = _p.x > 0.3 ? 1 : -1;
      const bump = 4 * fk * (1 - fk);
      pos.lerp(_p, fk);
      pos.x += s.arcX * BV.arcOut * bump;
      pos.y += BV.arcUp * bump;
      fwdPitch = lerp(BV.lookPitch, BV.aimPitch, a) * fk;
    }
    // world.js thins her canvas (the jibs beside the lookout) by the lookout's share.
    s.closeAhead = fk * (1 - s.fwdAim);
    // The look: at the tactical end it tips down toward the ship's surroundings (the pitch still steers it).
    dir(yaw, s.pitch - 14 * zk * (1 - s.aimK) + fwdPitch, _d);
    target.copy(pos).addScaledVector(_d, 80);
    const aimNarrow = s.aimK * (1 - s.mortK);   // the mortar view keeps the tactical end's wide lens
    s.fovOff = F.sprintFov * s.sprint - 4 * aimNarrow + F.wideFov * zk * (1 - aimNarrow);
    // The mortar. Free look: the core ranges it by the look's pitch (150 m at −25° … 600 m at 0°, along the look), so
    // the lens looks at that spot on the sea and the circle sits under the reticle (RETICLE_Y 0.46: ~2° above the
    // centre). Cursor aim: the circle is under the cursor, so the lens looks a fixed `view.ahead` m out along the look.
    if (s.aimSide === "mortar" && s.aimK > 0.01) {
      const M = F.mortar;
      const range = lerp(clamp(M.min + (s.pitch - M.pitch0) * M.perDeg, M.min, M.max), MV.ahead, s.mortK);
      dir(s.yaw, 0, _d);
      _f.set(_d.x * range, 0, _d.z * range);
      _f.y -= Math.tan(M.reticleDeg * DEG) * _f.distanceTo(pos) * (1 - s.mortK);
      target.lerp(_f, s.aimK);
    }
    return { pos, target, fovOff: s.fovOff };
  }

  /** Put the look's goal somewhere (degrees); `ease` s > 0 = ease there (cursor aim), else at once. */
  function setGoal(yaw, pitch, ease) {
    if (Number.isFinite(yaw)) s.yawT = wrap180(yaw);
    if (Number.isFinite(pitch)) s.pitchT = clamp(pitch, F.pitch.min, F.pitch.max);
    if (ease > 0) s.ease = ease;
    else { s.yaw = s.yawT; s.pitch = s.pitchT; s.ease = 0; }
    s.idle = 0;
  }

  const rig = {
    pos, target, step,
    /** Swing the look by degrees (mouse delta × sensitivity is the caller's): free look, applied at once. */
    lookBy(dYaw = 0, dPitch = 0) {
      if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return;
      s.cursor = false;
      setGoal(s.yawT + dYaw, s.pitchT + dPitch, 0);
    },
    /**
     * Put the look at hull-relative yaw / pitch (degrees); omitted values stay. `{source:"cursor"}` (or `smooth`)
     * eases there and switches recentring off; anything else is free look (immediate).
     */
    setLook(yaw = null, pitch = null, { source = null, smooth = null } = {}) {
      const cursor = source === "cursor" || smooth === true;
      s.cursor = source === "cursor" ? true : source ? false : s.cursor && smooth !== false;
      setGoal(yaw, pitch, cursor ? F.cursorTau : 0);
    },
    /**
     * Cursor aim: the canvas point (nx, ny in −1..1, +x right, +y up) → the look {yaw, pitch}: centre = ahead,
     * left half = port, right half = starboard, the far edges = the quarters astern; a dead zone round the centre;
     * pitch follows the height gently. `apply` (default) eases the camera there.
     */
    cursorLook(nx, ny, { apply = true } = {}) {
      const C = F.cursor;
      const x = clamp(+nx || 0, -1, 1), y = clamp(+ny || 0, -1, 1);
      const u = clamp((Math.abs(x) - C.dead) / (1 - C.dead), 0, 1);
      const yaw = Math.sign(x) * C.edgeYaw * Math.pow(u, C.curve);
      const v = Math.sign(y) * clamp((Math.abs(y) - C.dead) / (1 - C.dead), 0, 1);
      const pitch = F.pitch.rest + (v > 0 ? v * C.pitchUp : v * C.pitchDown);
      if (apply) rig.setLook(yaw, pitch, { source: "cursor" });
      return { yaw, pitch };
    },
    /** Hold (or release) the aim: the shoulder view toward `side` ("port"|"starboard"|"bow"|"stern"|"mortar"). */
    aim(on, side = null) { s.aiming = !!on; s.aimSide = on ? side : null; s.idle = 0; },
    recentre() { s.idle = 99; s.yaw = s.yawT = 0; s.pitch = s.pitchT = F.pitch.rest; s.ease = 0; },
    /** The mouse wheel: + = out (toward tactical), − = in (toward deck level); one notch = `zoom.step`. */
    zoomBy(notches = 0) {
      const n = clamp(+notches || 0, -4, 4);
      if (!n) return s.zoomT;
      s.zoomT = clamp(s.zoomT + n * F.zoom.step, 0, 1);
      return s.zoomT;
    },
    /** The zoom's goal (0 deck level … 1 tactical; `restZ` = the v2 sailing view); `cut` jumps. */
    setZoom(z, { cut = false } = {}) { s.zoomT = clamp(Number.isFinite(+z) ? +z : F.zoom.restZ, 0, 1); if (cut) s.zoom = s.zoomT; return s.zoomT; },
    get zoom() { return { goal: s.zoomT, now: s.zoom, distance: offsetAt(s.zoom, { D: 0, e: 0 }).D * s.dist }; },
    /** The look the input layer reads (see the header). */
    get look() {
      const a = F.aimPitch;
      return {
        yaw: s.yaw, pitch: s.pitch, zone: s.zone, aiming: s.aiming,
        aim01: clamp((s.pitch - a.min) / (a.max - a.min), 0, 1),
        worldYaw: null, cursor: s.cursor, goalYaw: s.yawT, goalPitch: s.pitchT, zoom: s.zoom, closeAhead: s.closeAhead,
        bowView: smooth01(s.fwd), bowAim: s.fwdAim,
      };
    },
    get state() { return { ...s }; },
  };
  return rig;
}
