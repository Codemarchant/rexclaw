// The other ships (spec v2): archetypes and their AI, retuned for the
// Rexmaw's arcade speeds and the 1.8 km bay. Each enemy is a plain object
// the sim moves; aiStep() decides where it wants to go and how fast, and what
// its guns want (ports open, a broadside, a mortar, a ram). The sim does the
// physics, the gunnery, the patrol lanterns and the hits.
//
// States (state.contacts[].state): patrol, approach, broadside, ram, flee,
// surrender, sinking. `ai` carries the detail (dart_in, dart_out, cross_t,
// cloak, ram, escort, beat, run_for_exit...).
//
// Every broadside is telegraphed: the ports on that side open AI.telegraph s
// (× the off-call telegraph scale) before the guns go — the Captain's cue to
// brace. Pure: no three.js, no DOM, no Math.random (the sim's rng).

import { CLASSES, AI, BAY, GLOAM, MORTAR, DUKE, FORT, LANTERN } from "./const.js";
import { clamp, dist, wrap180, wrap360, headingOf, forward, relBearing } from "./geom.js";

/** Make an enemy ship from a fleet entry. */
export function createShip(spec, world, rng) {
  const C = CLASSES[spec.cls] || CLASSES.brig;
  let x = spec.x, z = spec.z, heading = spec.heading ?? 0, wp = 0;
  const route = spec.route ? world.routes.find((r) => r.id === spec.route) : null;
  if (route && x == null) {
    const p = pointAlong(route.points, route.loop, route.loop ? Math.max(0, spec.offset || 0) : clamp(260 + (spec.offset || 0), 0, 1e9));
    x = p.x; z = p.z; heading = p.heading; wp = p.next;
  }
  const loot = Math.round(rng.range(C.loot[0], C.loot[1]) / 10) * 10;
  const hunting = ["hunter", "legend", "arena", "boss", "harass"].includes(spec.role);
  return {
    id: spec.id, name: spec.name, cls: spec.cls, C, role: spec.role || "patrol", route: route?.id || null, wp,
    home: { x, z }, x, z, heading, speed: route ? C.speed * 0.55 : 0, wantHeading: heading, wantSpeed: C.speed * 0.55, vx: 0, vz: 0,
    hull: C.hull, hullMax: C.hull, masts: 100, crew: C.crew, crewMax: C.crew, loot,
    state: hunting ? "approach" : "patrol", ai: spec.role === "escort" ? "escort" : spec.role,
    stateT: 0, hostile: C.navy || !!C.legendary, provoked: hunting, objective: !!spec.objective, chest: !!spec.chest,
    batteries: {
      port: { loaded: 1, guns: C.guns, gunsMax: C.guns },
      starboard: { loaded: 1, guns: C.guns, gunsMax: C.guns },
      bow: { loaded: 1, guns: C.bow, gunsMax: C.bow },
    },
    ports: { port: { open: false, t: 0 }, starboard: { open: false, t: 0 }, bow: { open: false, t: 0 } },
    fires: 0, fireT: 0, hits: 0, weakPoints: [], weakN: 0, surrenderT: 0, sinkT: 0,
    lit: false, litT: 0, cloaked: false, phase: 1, mortarT: rng.range(3, MORTAR.every), ramCd: 0, ramT: 0, crossT: rng.range(8, 20),
    dartT: 0, firingT: 0, detected: false, known: false, escaped: false, gone: false, lastHitByRexmawT: -1e9, stuckT: 0,
    boardCd: 0, brokeFree: 0, heel: 0, reelT: 0,
    lantern: spec.lantern ? { phase: rng.range(0, Math.PI * 2), yaw: heading, half: LANTERN.half, range: LANTERN.range } : null,
    alert: 0, spotted: false, lostT: 0, cycle: C.legendary && spec.cls === "gloam" ? { stage: "fight", t: 0, side: 1 } : null,
  };
}

/** A fixed gun tower of the fort (a contact the guns can hit, with its own battery). */
export function createTower(t, rng) {
  const C = CLASSES.tower;
  return {
    id: t.id, name: t.name || t.id, cls: "tower", C, role: "tower", fixed: true, magazine: !!t.magazine, x: t.x, z: t.z, heading: 0, speed: 0, vx: 0, vz: 0,
    hull: t.hpMax || C.hull, hullMax: t.hpMax || C.hull, masts: 100, crew: 0, crewMax: 0, loot: C.loot[0], r: FORT.towerR,
    state: "broadside", ai: "fort", hostile: true, provoked: true, objective: true, reloadT: rng.range(2, FORT.reload), portsOpen: false,
    batteries: { port: { loaded: 1, guns: t.guns || C.guns, gunsMax: t.guns || C.guns }, starboard: { loaded: 1, guns: 0, gunsMax: 0 }, bow: { loaded: 1, guns: 0, gunsMax: 0 } },
    ports: { port: { open: false, t: 0 }, starboard: { open: false, t: 0 }, bow: { open: false, t: 0 } },
    fires: 0, fireT: 0, hits: 0, weakPoints: [], weakN: 0, detected: false, known: true, gone: false, down: false, firingT: 0,
    lastHitByRexmawT: -1e9, lantern: null, alert: 0, spotted: false, sinkT: 0, heel: 0,
  };
}

/** The point `s` metres along a polyline (looping), its heading and the index of the next vertex. */
export function pointAlong(points, loop, s) {
  const n = points.length;
  const segs = [];
  let total = 0;
  for (let i = 0; i < (loop ? n : n - 1); i++) {
    const a = points[i], b = points[(i + 1) % n];
    const L = dist(a.x, a.z, b.x, b.z);
    segs.push({ a, b, L, i });
    total += L;
  }
  let d = loop ? ((s % total) + total) % total : clamp(s, 0, total);
  for (const sg of segs) {
    if (d <= sg.L) {
      const t = sg.L ? d / sg.L : 0;
      return { x: sg.a.x + (sg.b.x - sg.a.x) * t, z: sg.a.z + (sg.b.z - sg.a.z) * t,
        heading: headingOf(sg.b.x - sg.a.x, sg.b.z - sg.a.z), next: (sg.i + 1) % n };
    }
    d -= sg.L;
  }
  const last = segs[segs.length - 1];
  return { x: last.b.x, z: last.b.z, heading: headingOf(last.b.x - last.a.x, last.b.z - last.a.z), next: (last.i + 1) % n };
}

/** Steer toward a heading that puts `target` on our `side` beam at range `D` (the beam-hold controller). */
export function beamHold(sx, sz, target, side, D) {
  const d = dist(sx, sz, target.x, target.z);
  const bearing = headingOf(target.x - sx, target.z - sz);
  const off = 90 - clamp((d - D) * 0.35, -45, 60);
  return wrap360(side === "port" ? bearing + off : bearing - off);
}

/** A heading that isn't in irons: within 40° of the wind's eye → close-hauled (42° off) on the nearer tack. */
export function sailable(want, windFrom, pinch = 42) {
  const off = wrap180(want - windFrom);
  if (Math.abs(off) >= 40) return wrap360(want);
  return wrap360(windFrom + (off >= 0 ? pinch : -pinch));
}

/** Which side is nearer to bearing on a target right now (rel + = starboard). */
export const nearSide = (rel) => (rel >= 0 ? "starboard" : "port");

/**
 * One AI decision step for ship `e`. ctx: { t, player, heat, tele, rng, world, isWater(x,z,pad), dt, playerHullF, windFrom, exit }.
 * Sets e.wantHeading / e.wantSpeed / e.state / e.ai, and returns intents:
 * { open: side|null, close: side|null, fire: side|null, mortar: bool, board: bool, surrender: bool, lit: bool, burnout: bool }.
 */
export function aiStep(e, ctx) {
  const C = e.C, P = ctx.player, out = { open: null, fire: null, mortar: false, board: false };
  e.stateT += ctx.dt;
  e.ramCd = Math.max(0, e.ramCd - ctx.dt);
  e.boardCd = Math.max(0, e.boardCd - ctx.dt);
  if (e.state === "sinking") { e.wantSpeed = 0; return out; }
  // Anchored (moored in a harbour, or held for a test): she stays put and doesn't fight.
  if (e.anchored) { e.wantSpeed = 0; e.wantHeading = e.heading; return out; }
  const d = dist(e.x, e.z, P.x, P.z);
  const toP = headingOf(P.x - e.x, P.z - e.z);
  const relP = wrap180(toP - e.heading);
  const hullF = e.hull / e.hullMax, crewF = e.crewMax ? e.crew / e.crewMax : 1;
  const set = (state, ai = state) => { if (e.state !== state) e.stateT = 0; e.state = state; e.ai = ai; };
  // Merchants and the convoy's transports run; they don't fight unless cornered.
  const runner = e.cls === "merchant" || e.chest || (e.role === "convoy" && !!ctx.exit);

  // ---- Surrender / flee checks -----------------------------------------------------
  if (e.state === "surrender") {
    e.wantSpeed = 0;
    e.surrenderT += ctx.dt;
    if (e.surrenderT >= AI.surrenderHold) { e.brokeFree++; e.surrenderT = 0; set("flee", "broke_free"); e.crew = Math.max(e.crew, Math.round(e.crewMax * 0.45)); }
    return out;
  }
  if (C.surrenderHull != null && (hullF <= C.surrenderHull || crewF < C.surrenderCrew) && e.brokeFree < 2 && e.provoked) {
    set("surrender"); e.surrenderT = 0; out.surrender = true; return out;
  }
  if (e.cls === "brig" && (crewF < 0.25 || (e.state === "flee" && e.masts < 20))) { set("surrender"); e.surrenderT = 0; out.surrender = true; return out; }
  if (e.cls === "frigate" && crewF < 0.2) { set("surrender"); e.surrenderT = 0; out.surrender = true; return out; }
  if (C.fleeHull != null && hullF <= C.fleeHull && e.state !== "flee" && !e.chest) set("flee");

  // ---- Waking up ------------------------------------------------------------------------
  if (e.state === "patrol") {
    if (runner) {
      if (d < AI.merchantFlee || (e.provoked && d < AI.fleeEscape)) set("flee", ctx.exit ? "run_for_exit" : "flee");
    } else if (e.hostile && !e.lantern) {
      const guard = e.role === "escort" || e.role === "convoy";
      // v5: a wreck's guards (Kraken's Wake) come out to meet her a little further off.
      const sees = d < (ctx.heat >= 1 || e.provoked ? AI.detect : e.role === "guard" ? 420 : guard ? 320 : AI.navyDetectCold);
      if (sees) { e.provoked = true; set("approach"); }
    } else if (e.lantern && e.provoked) set("approach", "chase");
  }

  // ---- Per state --------------------------------------------------------------------------
  const maxV = C.speed;
  switch (e.state) {
    case "patrol": patrol(e, ctx); break;
    case "flee": {
      let h = wrap360(toP + 180);
      if (ctx.exit && (e.role === "objective" || e.role === "convoy" || e.chest)) {
        // A convoy runs for the exit along its course, swinging off when the Rexmaw blocks the way.
        const route = e.route ? ctx.world.routes.find((r) => r.id === e.route) : null;
        const q = route ? route.points[Math.min(e.wp, route.points.length - 1)] : ctx.exit;
        if (route && dist(e.x, e.z, q.x, q.z) < 60 && e.wp < route.points.length - 1) e.wp++;
        h = headingOf(q.x - e.x, q.z - e.z);
        const off = wrap180(toP - h);
        if (d < 160 && Math.abs(off) < 50) h = wrap360(h - Math.sign(off || 1) * 55);
      }
      e.wantHeading = h;
      e.wantSpeed = maxV;
      if (!ctx.exit && d > AI.fleeEscape) e.escaped = true;
      break;
    }
    case "approach":
    case "broadside":
    case "ram":
      if (e.cls === "gunboat") gunboat(e, ctx, d, toP, relP, out);
      else if (e.cls === "fireship") fireship(e, ctx, d, toP, out);
      else warship(e, ctx, d, toP, relP, out);
      break;
    default: break;
  }

  // (The Gloam sails where she likes: a ghost ship minds no wind — v5.)
  if (e.cls !== "gunboat" && e.cls !== "gloam" && e.state !== "ram" && ctx.windFrom != null) e.wantHeading = sailable(e.wantHeading, ctx.windFrom);

  // Edges: anything but a fleeing ship turns back from the bay's edge; a fleeing one escapes there.
  const b = ctx.world.bounds, m = BAY.edgeSoft + 40;
  const nearEdge = e.x < b.minX + m || e.x > b.maxX - m || e.z < b.minZ + m || e.z > b.maxZ - m;
  if (nearEdge && !ctx.world.arena) {
    if (e.state === "flee" && !ctx.exit && d > AI.edgeEscape) e.escaped = true;
    else if (e.state === "flee" && !ctx.exit) {
      const inward = headingOf(0 - e.x, 800 - e.z);
      const away = wrap360(toP + 180);
      e.wantHeading = Math.abs(wrap180(away - inward)) < 90 ? away : wrap360(inward + (wrap180(away - inward) > 0 ? 80 : -80));
    } else if (!(e.state === "flee" && ctx.exit)) e.wantHeading = headingOf(0 - e.x, 800 - e.z);
  }
  avoid(e, ctx);
  return out;
}

function patrol(e, ctx) {
  const C = e.C;
  const route = e.route ? ctx.world.routes.find((r) => r.id === e.route) : null;
  if (route) {
    const n = route.points.length;
    const p = route.points[e.wp % n];
    if (dist(e.x, e.z, p.x, p.z) < 50) {
      if (route.loop) e.wp = (e.wp + 1) % n;
      else if (e.wp < n - 1) e.wp++;
      else if (ctx.exit && dist(e.x, e.z, ctx.exit.x, ctx.exit.z) < ctx.exit.r) e.escaped = true;
    }
    const q = route.points[e.wp % n];
    e.wantHeading = headingOf(q.x - e.x, q.z - e.z);
    e.wantSpeed = C.speed * (e.lantern ? 0.45 : 0.55);
    e.ai = e.lantern ? "beat" : e.ai;
    return;
  }
  if (!e.wander || dist(e.x, e.z, e.wander.x, e.wander.z) < 50) {
    for (let i = 0; i < 12; i++) {
      // A wreck's guards (v5) keep close to her; anyone else roams.
      const a = ctx.rng.range(0, Math.PI * 2), r = e.role === "guard" ? ctx.rng.range(40, 120) : ctx.rng.range(150, 400);
      const w = { x: e.home.x + Math.cos(a) * r, z: e.home.z + Math.sin(a) * r };
      if (ctx.isWater(w.x, w.z, 60)) { e.wander = w; break; }
    }
    if (!e.wander) e.wander = { x: e.home.x, z: e.home.z };
  }
  e.wantHeading = headingOf(e.wander.x - e.x, e.wander.z - e.z);
  e.wantSpeed = C.speed * 0.45;
}

/** Brig, frigate, the Iron Duke, the Gloam, a merchant's lone guns. */
function warship(e, ctx, d, toP, relP, out) {
  const C = e.C, P = ctx.player;
  // v5: after a ram run (hit or miss) a boss has lost way: slow, ports shut, holding her course — the window to punish her.
  if (e.reelT > 0) {
    e.reelT = Math.max(0, e.reelT - ctx.dt);
    e.state = "broadside"; e.ai = "reel"; e.cloaked = false;
    e.wantSpeed = C.speed * (e.cls === "gloam" ? GLOAM.reelSpeed : DUKE.reelSpeed);
    e.wantHeading = e.heading;
    for (const side of ["port", "starboard"]) if (e.ports[side].open) { e.ports[side].open = false; out.close = side; }
    if (e.cycle) { e.cycle.stage = "reel"; e.phase = 3; if (e.reelT <= 0) { e.cycle.stage = "fight"; e.cycle.t = 0; } }
    return;
  }
  // The Iron Duke's phases: broadsides → + mortars → + ram runs.
  if (e.cls === "manowar") {
    const f = e.hull / e.hullMax;
    e.phase = f > DUKE.phase2 ? 1 : f > DUKE.phase3 ? 2 : 3;
    if (e.phase === 3 && e.ramCd <= 0 && d < 380 && e.state !== "ram") { e.state = "ram"; e.ai = "ram"; e.ramT = 0; e.ramCd = DUKE.ramEvery; out.ramRun = true; }
  }
  // The Gloam: fight, slip into her fog and round to a flank, then come out of it to ram (told, and in the open for the last of
  // the run); after the run she wallows (the punish window).
  if (e.cycle) {
    const cy = e.cycle;
    cy.t += ctx.dt;
    e.phase = cy.stage === "fight" ? 1 : cy.stage === "cloak" ? 2 : 3;
    if (cy.stage === "fight" && cy.t >= GLOAM.fightS) { cy.stage = "cloak"; cy.t = 0; cy.side = ctx.rng.sign(); }
    if (cy.stage === "cloak") {
      e.cloaked = true; e.state = "broadside"; e.ai = "cloak";
      for (const side of ["port", "starboard"]) if (e.ports[side].open) { e.ports[side].open = false; out.close = side; }
      // v5: round to a point off her beam (GLOAM.flankDeg off her bow, where she'll be in a few seconds), so the ram comes in
      // from the side (v4 came from astern and rarely caught her before the run ran out).
      const f = forward(P.heading + cy.side * GLOAM.flankDeg);
      e.wantHeading = headingOf(P.x + f.x * GLOAM.flankR + P.vx * 4 - e.x, P.z + f.z * GLOAM.flankR + P.vz * 4 - e.z);
      // v5: she slips away into her fog first (out past ~170 m, so the ram run has room to build), never through us.
      if (d < 170) e.wantHeading = wrap360(toP + 180 + cy.side * 35);
      e.wantSpeed = C.speed;
      if (cy.t >= GLOAM.cloakS) { cy.stage = "ram"; cy.t = 0; e.ramT = 0; out.ramRun = true; }
      return;
    }
    if (cy.stage === "ram") {
      e.state = "ram"; e.ai = "ram";
      e.cloaked = d > 150 && cy.t < GLOAM.revealS;
      // v5: she leads her mark by the time it takes her to get there (a crossing ram, not a stern chase).
      const tgo = clamp(d / Math.max(8, C.speed), 0, 5);
      e.wantHeading = headingOf(P.x + P.vx * tgo - e.x, P.z + P.vz * tgo - e.z); e.wantSpeed = C.speed;
      if (cy.t >= GLOAM.ramS) { cy.t = 0; e.cloaked = false; e.reelT = GLOAM.reelS; e.state = "broadside"; e.ai = "reel"; cy.stage = "reel"; }
      return;
    }
    if (cy.stage === "reel") cy.stage = "fight";
    e.cloaked = false;
  }
  if (e.state === "approach") {
    const lead = clamp(d / Math.max(4, C.speed), 0, 20);
    e.wantHeading = headingOf(P.x + P.vx * lead * 0.4 - e.x, P.z + P.vz * lead * 0.4 - e.z);
    e.wantSpeed = C.speed;
    if (d < C.range + 120) { e.state = "broadside"; e.stateT = 0; e.ai = "broadside"; }
    gunsFor(e, ctx, d, out);
    return;
  }
  if (e.state === "ram") {
    e.ramT += ctx.dt;
    e.wantHeading = headingOf(P.x + P.vx * 1.2 - e.x, P.z + P.vz * 1.2 - e.z);
    e.wantSpeed = C.speed;
    if (e.ramT > 10 || d > 420) { e.state = "broadside"; e.ai = "broadside"; e.stateT = 0; if (e.cls === "manowar") e.reelT = DUKE.reelS; }
    gunsFor(e, ctx, d, out);
    return;
  }
  if (d > C.range + 320) { e.state = "approach"; e.ai = "approach"; return; }
  let loadedSide = e.side || nearSide(relP);
  if ((loadedSide === "port" && relP > 50) || (loadedSide === "starboard" && relP < -50)) loadedSide = nearSide(relP);
  const other = loadedSide === "port" ? "starboard" : "port";
  // Her side just fired and the other is loaded: she wears round across our wake (or bow) to show it.
  if (e.batteries[loadedSide].loaded < 0.5 && e.batteries[other].loaded >= 1 && e.stateT > 4) {
    const turn = Math.abs(wrap180(beamHold(e.x, e.z, P, other, C.range) - e.heading));
    if (turn <= (e.cls === "merchant" ? 90 : 160)) { loadedSide = other; e.stateT = 0; }
  }
  e.side = loadedSide;
  e.crossT -= ctx.dt;
  if (e.cls === "frigate" && e.crossT <= 0) { e.ai = e.ai === "cross_t" ? "broadside" : "cross_t"; e.crossT = e.ai === "cross_t" ? 12 : ctx.rng.range(16, 26); }
  if (e.cls === "brig" && e.ramCd <= 0 && d < AI.ramRange && e.hull / e.hullMax > ctx.playerHullF && ctx.rng.chance(0.25 * ctx.dt)) {
    e.state = "ram"; e.ai = "ram"; e.ramT = 0; e.ramCd = 25; return;
  }
  if (e.ai === "cross_t") {
    const f = forward(P.heading);
    const ax = P.x + f.x * (C.range + 30), az = P.z + f.z * (C.range + 30);
    e.wantHeading = dist(e.x, e.z, ax, az) > 60 ? headingOf(ax - e.x, az - e.z) : beamHold(e.x, e.z, P, loadedSide, C.range);
  } else e.wantHeading = beamHold(e.x, e.z, P, loadedSide, C.range);
  // Pace the Rexmaw to keep her on the beam (she's faster: a ship that can't keep up falls astern of her).
  e.wantSpeed = clamp(Math.hypot(P.vx, P.vz) + (d > C.range ? 2 : 0), C.speed * 0.5, C.speed);
  if (e.cls === "merchant") e.wantSpeed = C.speed;
  gunsFor(e, ctx, d, out);
}

/** Open the ports on a side that's about to bear, fire the ones that are open long enough. */
function gunsFor(e, ctx, d, out) {
  const C = e.C, P = ctx.player;
  if (e.cloaked) return;
  const rel = relBearing(e.x, e.z, e.heading, P.x, P.z);
  const reach = C.reach;
  for (const side of ["port", "starboard"]) {
    const B = e.batteries[side], ports = e.ports[side];
    if (!B.guns) continue;
    const centre = side === "port" ? -90 : 90;
    const off = Math.abs(wrap180(rel - centre));
    const bearsSoon = off < 50 && d < reach + 80;
    if (B.loaded >= 1 && bearsSoon && !ports.open) { ports.open = true; ports.t = 0; out.open = side; }
    if (ports.open) {
      ports.t += ctx.dt;
      if (ports.t >= AI.telegraph * ctx.tele && off <= 40 && d <= reach && B.loaded >= 1) out.fire = side;
      else if (ports.t > AI.telegraph * ctx.tele + AI.portsHold) { ports.open = false; out.close = side; }
    }
  }
  const mortarPhase = C.mortar && (e.cls !== "manowar" || e.phase >= 2);
  if (mortarPhase && d < MORTAR.range && d > 90) {
    e.mortarT -= ctx.dt;
    if (e.mortarT <= 0) { e.mortarT = e.cls === "manowar" ? DUKE.mortarEvery : MORTAR.every; out.mortar = true; }
  }
}

/** Gunboats dart in bow-on, fire the bow guns, and dart out again. */
function gunboat(e, ctx, d, toP, relP, out) {
  const C = e.C, P = ctx.player;
  if (e.ai !== "dart_out") {
    e.state = "approach"; e.ai = "dart_in";
    const lead = clamp(d / 30, 0, 4);
    e.wantHeading = headingOf(P.x + P.vx * lead - e.x, P.z + P.vz * lead - e.z); e.wantSpeed = C.speed;
    const B = e.batteries.bow, ports = e.ports.bow;
    if (B.loaded >= 1 && Math.abs(relP) < 30 && d < AI.dartIn + 140 && !ports.open) { ports.open = true; ports.t = 0; out.open = "bow"; }
    if (ports.open) {
      ports.t += ctx.dt;
      if (ports.t >= AI.telegraph * ctx.tele * 0.6 && Math.abs(relP) <= 18 && d < C.reach && B.loaded >= 1) out.fire = "bow";
    }
    if (d < AI.dartIn || (ports.open && B.loaded < 1)) { e.ai = "dart_out"; e.dartT = 0; ports.open = false; out.close = "bow"; }
  } else {
    e.state = "broadside";
    e.dartT += ctx.dt;
    e.wantHeading = wrap360(toP + 180 + (e.id.charCodeAt(e.id.length - 1) % 2 ? 40 : -40));
    e.wantSpeed = C.speed;
    if (d > AI.dartOut || e.dartT > 18) e.ai = "dart_in";
  }
}

/** A fire ship closes, lights up LIGHT s before it rams, and goes up on contact. */
function fireship(e, ctx, d, toP, out) {
  const C = e.C, P = ctx.player;
  e.state = d < AI.fireLight || e.lit ? "ram" : "approach";
  if (e.state === "ram" && !e.lit) { e.lit = true; e.litT = 0; out.lit = true; }
  if (e.lit) e.litT += ctx.dt;
  e.ai = e.lit ? "lit" : "approach";
  const tt = clamp(d / Math.max(3, C.speed), 0, 8);
  e.wantHeading = headingOf(P.x + P.vx * tt * 0.7 - e.x, P.z + P.vz * tt * 0.7 - e.z);
  e.wantSpeed = C.speed;
  if (e.lit && e.litT > C.lightS * ctx.tele + 14) out.burnout = true;
}

/** Steer clear of islands, reefs and (on patrol) the maelstrom: probe ahead, swing toward open water. */
function avoid(e, ctx) {
  const probe = (h, L) => { const f = forward(h); return ctx.isWater(e.x + f.x * L, e.z + f.z * L, 22); };
  const L = 60 + e.speed * 4;
  if (!probe(e.wantHeading, L) || !probe(e.wantHeading, L * 0.5)) {
    for (const off of [25, -25, 50, -50, 80, -80, 120, -120, 160, -160]) {
      const h = wrap360(e.wantHeading + off);
      if (probe(h, L) && probe(h, L * 0.5)) { e.wantHeading = h; break; }
    }
  }
  const M = ctx.world.maelstrom;
  // (v5: the Gloam knows these waters: she never strays into the maelstrom's pull, whatever she's doing.)
  if (M && (e.state === "patrol" || e.state === "flee" || e.cls === "gloam")) {
    const dm = dist(e.x, e.z, M.x, M.z);
    if (dm < M.r + 60) e.wantHeading = headingOf(e.x - M.x, e.z - M.z);
  }
}

/** Move a ship one step: turn toward wantHeading (respecting its turning circle), ease the speed. */
export function moveShip(e, dt, { windF = 1, drift = null, slow = 1 } = {}) {
  const C = e.C;
  if (e.fixed) return;
  if (e.state === "sinking") {
    e.speed = Math.max(0, e.speed - 2 * dt);
  } else {
    const turnMax = C.turn * clamp(0.4 + e.speed / Math.max(1, C.speed), 0.4, 1);
    const dh = wrap180(e.wantHeading - e.heading);
    const step = clamp(dh, -turnMax * dt, turnMax * dt);
    e.heading = wrap360(e.heading + step);
    e.heel = clamp(step / Math.max(1e-6, dt) / Math.max(1, C.turn), -1, 1);
    // Chain shot through the rigging: under half her masts she sails at 60%, under a fifth at 35%.
    const mastF = e.masts < 20 ? 0.35 : e.masts < 50 ? 0.6 : 1;
    const hullF = 0.65 + 0.35 * clamp(e.hull / e.hullMax, 0, 1);
    const cap = C.speed * mastF * hullF * windF * slow;
    const want = Math.min(e.wantSpeed, cap);
    const tau = want > e.speed ? 1.6 : 1.2;
    e.speed += (want - e.speed) * (1 - Math.exp(-dt / tau));
  }
  const f = forward(e.heading);
  e.vx = f.x * e.speed + (drift?.x || 0);
  e.vz = f.z * e.speed + (drift?.z || 0);
  e.x += e.vx * dt;
  e.z += e.vz * dt;
}

/** A guess at what a ship means to do, in words (facts about her behaviour, for the spyglass). */
export function intentWords(e) {
  if (e.fixed) return e.down ? "silenced" : "manning its guns";
  switch (e.state) {
    case "patrol": return e.lantern ? "sweeping the water with a lantern" : e.role === "objective" ? "making for the far cape" : e.role === "convoy" ? "sailing the convoy route" : e.role === "escort" ? "escorting the convoy" : e.cls === "merchant" ? "going about her business" : "on patrol";
    case "approach": return e.cls === "fireship" ? "closing on us" : e.ai === "chase" ? "chasing us" : e.cls === "gunboat" ? "darting in bow-on" : "closing to fight";
    case "broadside": return e.ai === "cross_t" ? "trying to cross our bow" : e.cls === "gunboat" ? "darting out to come round again" : e.ai === "cloak" ? "hiding in her fog"
      : e.ai === "reel" ? "wallowing after her ram run, ports shut" : "holding off to trade broadsides";
    case "ram": return e.lit ? "burning, and steering to ram us" : "steering to ram us";
    case "flee": return e.ai === "run_for_exit" ? "running for the exit" : "running for it";
    case "surrender": return "struck her colours";
    case "sinking": return "going down";
    default: return e.state;
  }
}
