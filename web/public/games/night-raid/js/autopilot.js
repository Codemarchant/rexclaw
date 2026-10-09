// Rexmaw Raids' debug crew (?debug=1 only; main imports this on demand) and the
// core tests' scripted players: a Captain who sails, aims and fires like a
// player (camera look → the aim preview → fire when the arcs show red), braces
// on open gun ports, boards beaten ships and works each mission's objective;
// and a scripted companion who only uses the companion's own tools
// (run.companion / run.heard): a gun crew on the off side, repairs at half
// hull, the pumps, headings and danger marks from their chart at night.
//
//   const cap = makeMissionCaptain(); const mate = helperMate(cap);
//   every 0.2 s of sim time: cap(run, dt); mate.step(run, dt);
//   makeFightCaptain() — the duel Captain (fights the ship whose role is "arena" or "target")

import { dist, wrap180, wrap360, headingOf, forward, portNormal, clamp, relBearing } from "./core/geom.js";
import { beamHold, sailable } from "./core/ships.js";
import { navPath, isWater } from "./core/world.js";
import { boardProblem } from "./core/boarding.js";
import { WEAPONS } from "./core/const.js";
import { elevationForRange, ballistic } from "./core/gunnery.js";
import { objectiveState } from "./core/missions.js";

/** How long the scripted Captain's camera takes to swing from one broadside to the other (s). */
const LOOK_SWING_S = 2;

/** The look that lays the `side` broadside (or the bow chasers) on `e`, leading her. */
export function lookAt(P, e, side) {
  const W = side === "bow" ? WEAPONS.chain : WEAPONS.broadside;
  let ax = e.x, az = e.z;
  for (let k = 0; k < 2; k++) {
    const L = dist(P.x, P.z, ax, az);
    const el = elevationForRange(L, 2.6, W.maxElev, -6) ?? W.maxElev;
    const T = L / ballistic(el).vh;
    ax = e.x + (e.vx || 0) * T; az = e.z + (e.vz || 0) * T;
  }
  const L = dist(P.x, P.z, ax, az);
  const el = elevationForRange(L, 2.6, W.maxElev, 0) ?? W.maxElev;
  return { lookYawRel: relBearing(P.x, P.z, P.heading, ax, az), lookPitch: el / W.gain + W.pitch0, aiming: true, mode: "auto" };
}

/** Aim at `e` with whatever bears on the side the Captain is looking (`side`), fire when the preview shows hits. */
export function aimAndFire(run, e, side, { minHits = 2, heavyAt = 80, chain = false } = {}) {
  const sim = run.sim(), P = sim.S.ship;
  const d = dist(P.x, P.z, e.x, e.z);
  const rel = relBearing(P.x, P.z, P.heading, e.x, e.z);
  // Heavy shot point-blank down a beam: an unaimed volley.
  if (side !== "bow" && d < heavyAt && Math.abs(Math.abs(rel) - 90) < 28 && (rel > 0) === (side === "starboard")) {
    const look = { lookYawRel: side === "starboard" ? 90 : -90, lookPitch: -12, aiming: false, mode: "auto" };
    run.input("aim", look);
    const pv = run.aimPreview(look);
    if (pv?.ready && pv.weapon === "heavy" && pv.targetId === e.id) return run.input("fire", {});
    return false;
  }
  if (side === "bow" && !chain) return false;
  const look = lookAt(P, e, side);
  run.input("aim", look);
  const pv = run.aimPreview(look);
  if (!pv?.ready) return false;
  if (side === "bow" ? pv.weapon !== "chain" : pv.weapon !== "broadside") return false;
  const hits = pv.arcs.filter((a) => a.hit === e.id).length;
  if (hits >= Math.min(minHits, pv.arcs.length)) return run.input("fire", {});
  return false;
}

/** Brace when a broadside aimed at us is about to land (the ports glowed; the balls are in the air). */
export function braceWatch(run) {
  const S = run.sim().S, P = S.ship;
  if (P.braceT > 0 || P.braceCd > 0) return false;
  for (const p of S.projectiles) {
    if (p.from === "rexmaw") continue;
    const eta = p.b.T - (S.t - p.t0);
    // A player sees the smoke and the balls coming: braces a little early (a plain brace, now and then a perfect one).
    if (eta > 0.3 && eta < 0.9 && dist(p.b.x1, p.b.z1, P.x, P.z) < 40) return run.input("brace");
  }
  for (const m of S.hazards.mortars) if (m.from !== "rexmaw" && m.eta < 0.6 && dist(m.x, m.z, P.x, P.z) < m.r + 10) return run.input("brace");
  // v5: a ram about to land (she's in her ram run, close and closing), a Kraken arm about to slam, a wave about to break.
  for (const e of S.ships) {
    if (e.state !== "ram" || e.gone || e.cloaked) continue;
    const d = dist(e.x, e.z, P.x, P.z);
    const closing = ((e.vx - P.vx) * (P.x - e.x) + (e.vz - P.vz) * (P.z - e.z)) / Math.max(1, d);
    if (d < 70 && closing > 4 && (d - 40) / closing < 0.9) return run.input("brace");
  }
  for (const ev of run.sim().sea?.list() || []) if (ev.kind === "kraken_arm" && ev.stage === "active" && ev.slamIn < 0.7 && dist(ev.x, ev.z, P.x, P.z) < 45) return run.input("brace");
  const wv = S.hazards.wave;
  if (wv && !wv.hit && wv.eta > 0 && wv.eta < 0.8) return run.input("brace");
  return false;
}

/** v5: steer to ride a rogue wave bow-on (or stern-on) once it's close. → true when it took the helm. */
export function rideWave(run) {
  const S = run.sim().S, P = S.ship, wv = S.hazards.wave;
  if (!wv || wv.hit || !(wv.eta > 0) || wv.eta > 7) return false;
  const a = wrap180(P.heading - wv.dirDeg);
  const want = Math.abs(a) <= 90 ? wv.dirDeg : wrap360(wv.dirDeg + 180);
  run.input("wheel", { value: clamp(wrap180(want - P.heading) / 18, -1, 1) });
  if (P.sail === 0) run.input("sail", { set: 1 });
  return true;
}

/** v5: a broadside laid on a point of open water (a Kraken arm, the eye): fires when two balls would land within `r` m. */
export function shootPoint(run, pt, r = 12) {
  const S = run.sim().S, P = S.ship;
  const d = dist(P.x, P.z, pt.x, pt.z);
  const rel = relBearing(P.x, P.z, P.heading, pt.x, pt.z);
  const side = rel >= 0 ? "starboard" : "port";
  if (Math.abs(Math.abs(rel) - 90) > 24 || d < 35 || d > 320 || P.reload[side] < 1) return false;
  const look = lookAt(P, { x: pt.x, z: pt.z, vx: 0, vz: 0 }, side);
  run.input("aim", look);
  const pv = run.aimPreview(look);
  if (!pv?.ready || pv.weapon !== "broadside") return false;
  const near = pv.arcs.filter((a) => a.land && !a.hit && dist(a.land.x, a.land.z, pt.x, pt.z) <= r).length;
  return near >= 2 ? run.input("fire", {}) : false;
}

/** v5: the lone Kraken arms (sea events) in reach: the swivel inside 120 m, else a broadside when one bears. */
export function shootArms(run) {
  const S = run.sim().S, P = S.ship;
  const arms = (run.sim().sea?.list() || []).filter((e) => e.kind === "kraken_arm" && e.stage === "active").sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z));
  for (const a of arms) {
    if (P.reload.swivel >= 1 && dist(P.x, P.z, a.x, a.z) <= WEAPONS.swivel.range && run.input("swivel", { targetId: a.id, weakId: a.id })) return true;
    if (shootPoint(run, a, 10)) return true;
  }
  return false;
}

/** Swing `want` toward open water (no island, reef, shoal, maelstrom ahead). */
function clearWater(run, want, { reefs = true } = {}) {
  const W = run.world(), S = run.sim().S, P = S.ship;
  if (!W || W.arena) return want;
  for (const off of [0, 20, -20, 40, -40, 65, -65, 95, -95, 130, -130]) {
    const f = forward(want + off);
    const ok = (L) => {
      const x = P.x + f.x * L, z = P.z + f.z * L;
      return isWater(W, x, z, 18, { shoals: true, reefs }) && !(W.maelstrom && dist(x, z, W.maelstrom.x, W.maelstrom.z) < W.maelstrom.r * 0.8);
    };
    if (ok(70) && ok(35) && ok(110)) return want + off;
  }
  return want;
}

function steer(run, want, sail, { avoid = true, sprint = false } = {}) {
  const S = run.sim().S, P = S.ship;
  if (avoid) want = clearWater(run, want);
  run.input("wheel", { value: clamp(wrap180(want - P.heading) / 18, -1, 1) });
  if (P.sail !== sail) run.input("sail", { set: sail });
  run.input("sprint", { on: sprint && sail === 2 });
}

/**
 * The duel Captain: fights the ship whose role is "arena" or "target". Holds her on one beam at ~150 m
 * (looking only at that side — the other broadside is the companion's to man), chases a runner with chain
 * shot from the bow, comes alongside a beaten ship and boards, braces on incoming fire.
 */
export function makeFightCaptain({ range = 150 } = {}) {
  const mem = { side: null, chaseT: 0 };
  const cap = function captain(run, dt) {
    if (run.phase() === "boarding") { boardingHands(run, mem); return; }
    const sim = run.sim(), S = sim.S, P = S.ship;
    const e = S.ships.find((x) => !x.gone && x.state !== "sinking" && !x.down && (x.role === "arena" || x.role === "target"));
    if (!e) return;
    braceWatch(run);
    const d = dist(P.x, P.z, e.x, e.z);
    const toE = headingOf(e.x - P.x, e.z - P.z);
    const rel = wrap180(toE - P.heading);
    let want, sail, sprint = false;
    // Board her when she's struck, or beaten and slow enough to come alongside; a beaten runner gets shot at.
    // (Masts ≤ 20% also makes her boardable, but her crew is still whole: only a ship to take intact is worth that fight.)
    const beaten = e.C.boardable && !(e.boardLockT > 0) && (e.state === "surrender" || ((e.hull / e.hullMax <= 0.25 || (mem.gentle && e.masts <= 20)) && e.speed < 8));
    if (e.fixed) {
      steer(run, beamHold(P.x, P.z, e, rel >= 0 ? "starboard" : "port", 420), 1);
      return;
    }
    // Gentle (a ship to take intact): once she's under 45%, no more round shot — chain her masts from the bow until she can be boarded.
    if (mem.gentle && !beaten && e.C.boardable && (e.hull / e.hullMax <= 0.45 || e.state === "flee")) {
      // Run her down from astern (lead her), chain from the bow chasers; broadsides only while she's well above a quarter.
      const lead = d / 15;
      const ax = e.x + (e.vx || 0) * lead, az = e.z + (e.vz || 0) * lead;
      want = d < 60 ? e.heading : headingOf(ax - P.x, az - P.z);
      const chainLeft = (P.ammo.chain ?? 0) >= 1;
      if (chainLeft && Math.abs(rel) < 25) aimAndFire(run, e, "bow", { chain: true, minHits: 1 });
      else if (Math.abs(Math.abs(rel) - 90) < 40 && e.hull / e.hullMax > (chainLeft ? 0.45 : 0.33)) aimAndFire(run, e, rel >= 0 ? "starboard" : "port", { heavyAt: 0 });
      steer(run, want, 2, { sprint: d > 100 && P.sprint.wind > 0.2, avoid: d > 120 });
      return;
    }
    if (beaten) {
      // Come up alongside (a 12 m gap, inside the 30 m grapple range) and match her speed.
      const pn = portNormal(e.heading), f = forward(e.heading);
      const sd = ((P.x - e.x) * pn.x + (P.z - e.z) * pn.z) >= 0 ? 1 : -1;
      const off = 5 + e.C.beam / 2 + 12;
      const ax = e.x + pn.x * sd * off + f.x * e.speed * 1.5, az = e.z + pn.z * sd * off + f.z * e.speed * 1.5;
      const da = dist(P.x, P.z, ax, az);
      want = da < 20 ? e.heading : headingOf(ax - P.x, az - P.z);
      sail = da > 25 ? 2 : P.speed > e.speed + 1.5 ? 0 : P.speed < e.speed - 1.5 ? 2 : 1;
      if (!boardProblem(P, e)) run.input("board");
      steer(run, want, sail, { avoid: d > 120 });
      return;
    }
    if (e.state === "flee" && d > 230) {
      // Run her down: lead her, sprint, chain shot from the bow to cut her rigging.
      const lead = d / 15;
      want = headingOf(e.x + (e.vx || 0) * lead - P.x, e.z + (e.vz || 0) * lead - P.z);
      sail = 2; sprint = P.sprint.wind > 0.3;
      if (Math.abs(rel) < 25 && e.masts > 30) aimAndFire(run, e, "bow", { chain: true, minHits: 1 });
    } else {
      if (!mem.side || (mem.side === "port" && rel > 70) || (mem.side === "starboard" && rel < -70)) mem.side = rel >= 0 ? "starboard" : "port";
      want = beamHold(P.x, P.z, e, mem.side, range);
      sail = d > 400 ? 2 : d < 110 ? 1 : 2;
      sprint = d > 500;
      // Every so often, right after a volley, cut across her stern to rake her and come up on her other side.
      mem.crossCd = (mem.crossCd ?? 15) - dt;
      if (!mem.cross && mem.crossCd <= 0 && d < 240 && P.reload[mem.lookSide || mem.side] < 0.3) mem.cross = { from: mem.side, t: 0 };
      if (mem.cross) {
        mem.cross.t += dt;
        const f = forward(e.heading);
        want = headingOf(e.x - f.x * 45 - P.x, e.z - f.z * 45 - P.z);
        sail = 2;
        const other = mem.cross.from === "port" ? "starboard" : "port";
        if ((other === "starboard" ? rel > 40 : rel < -40) && mem.cross.t > 3) { mem.side = other; mem.cross = null; mem.crossCd = 22; }
        else if (mem.cross.t > 20) { mem.cross = null; mem.crossCd = 22; }
      }
      // A player's camera takes a moment to swing to the other side: they fire the side they're looking at.
      if (mem.lookSide !== mem.side) { mem.swingT = (mem.swingT || 0) + dt; if (!mem.lookSide || mem.swingT >= LOOK_SWING_S) { mem.lookSide = mem.side; mem.swingT = 0; } }
      else mem.swingT = 0;
      aimAndFire(run, e, mem.lookSide, mem.gentle ? { heavyAt: 0 } : {});
    }
    if (!mem.lookSide) mem.lookSide = mem.side;
    if (!(beaten && d < 160)) want = sailable(want, S.wind.dirDeg, 30);
    steer(run, want, sail, { sprint, avoid: true });
  };
  cap.mem = mem;
  return cap;
}

/**
 * The Captain's hands in a deck fight (v4): the pistol at her captain when he's on deck, else at the weakest of her
 * crew already fighting one of ours, every `every` s (a player doesn't click on every reload); Rally once, when
 * half of ours are down or hurt. → what was done ("pistol" | "rally" | null)
 */
export function boardingHands(run, mem = {}, { every = 2, rallyAt = 0.5 } = {}) {
  const F = run.state().boardfight;
  if (!F || F.phase !== "fight") return null;
  if (!F.rally.used) {
    const hurt = F.ours.filter((o) => o.state === "down" || o.hp < o.max * 0.4).length;
    if (hurt >= Math.ceil(F.ours.length * rallyAt) && run.input("rally")) return "rally";
  }
  mem.pistolT = (mem.pistolT ?? 0) + 0.2;
  if (F.pistol.cooldown > 0 || mem.pistolT < every) return null;
  const live = F.foes.filter((f) => f.state === "fighting");
  const t = live.find((f) => f.kind === "captain") || live.slice().sort((a, b) => a.hp - b.hp)[0];
  if (t && run.input("pistol", { foeId: t.id })) { mem.pistolT = 0; return "pistol"; }
  return null;
}

/**
 * The mission Captain (v3): reads the briefing, presses Set sail (start_voyage), then follows the objective
 * chain's current step and its marker — a ship to fight (and board when the step says so), an area or a point
 * to sail to (round islands and reefs: the companion's chart, in effect) — with each mission's own tactics
 * (mortars on the fort, stopping in the cove and beside wrecks, the Kraken's arms), picking up loot on the way.
 */
export function makeMissionCaptain() {
  const fight = makeFightCaptain();
  const mem = { path: null, pathFor: null, pathT: 0, targetId: null, goal: null, mortarT: 0, step: null };
  const cap = function captain(run, dt) {
    const sim = run.sim();
    if (!sim) return;
    const S = sim.S, P = S.ship, W = run.world();
    if (run.phase() === "briefing") { run.input("start_voyage"); return; }
    if (run.phase() === "boarding") { boardingHands(run, mem); return; }
    if (run.phase() !== "sailing") return;
    const mission = W.mission;
    const near = (x) => dist(P.x, P.z, x.x, x.z);
    const obj = objectiveState(sim);
    mem.step = obj?.id || null;
    fight.mem.gentle = ["disable", "board"].includes(mem.step);
    const follow = (goal, sail = 2, opts = {}) => {
      mem.pathT -= dt;
      const key = `${Math.round(goal.x / 40)},${Math.round(goal.z / 40)}`;
      if (!mem.path || mem.pathFor !== key || mem.pathT <= 0) {
        const avoid = [];
        if (W.maelstrom) avoid.push({ x: W.maelstrom.x, z: W.maelstrom.z, r: W.maelstrom.r + 60 });
        if (opts.avoidFort && W.fort) for (const t of W.fort.towers) avoid.push({ x: t.x, z: t.z, r: 400 });
        for (const x of opts.avoidShips || []) avoid.push({ x: x.x, z: x.z, r: x.r });
        mem.path = navPath(W, { x: P.x, z: P.z }, goal, { pad: 22, avoid, reefs: true }) || navPath(W, { x: P.x, z: P.z }, goal, { pad: 14, reefs: true }) || [goal];
        mem.pathFor = key; mem.pathT = 6;
      }
      while (mem.path.length > 1 && near(mem.path[0]) < 45) mem.path.shift();
      const wp = mem.path[0];
      // v5: a player beats upwind close-hauled rather than sitting in irons (tacking as the mark swings across the wind).
      let want = headingOf(wp.x - P.x, wp.z - P.z);
      if (near(wp) > 90) want = sailable(want, S.wind.dirDeg);
      steer(run, want, sail, { avoid: true, sprint: opts.sprint && near(goal) > 300 });
    };
    const fightShip = (e) => { mem.targetId = e.id; const was = e.role; e.role = "target"; fight(run, dt); e.role = was; };
    /** A fort tower: stand off outside its guns and lob mortars; out of shells, aimed broadsides from ~260 m. */
    const siege = (t) => {
      braceWatch(run);
      const d = near(t);
      if (P.ammo.mortar > 0) {
        const stand = 450;
        const bearing = headingOf(P.x - t.x, P.z - t.z);
        if (Math.abs(d - stand) > 60) follow({ x: t.x + forward(bearing).x * stand, z: t.z + forward(bearing).z * stand }, 1, { avoidFort: d > 400 });
        else steer(run, beamHold(P.x, P.z, t, wrap180(headingOf(t.x - P.x, t.z - P.z) - P.heading) >= 0 ? "starboard" : "port", stand), 1);
        if (d <= WEAPONS.mortar.maxRange && d >= WEAPONS.mortar.minRange) {
          const look = { lookYawRel: relBearing(P.x, P.z, P.heading, t.x, t.z), lookPitch: -12, aiming: true, mode: "mortar", point: { x: t.x, z: t.z } };
          run.input("aim", look);
          if (run.aimPreview(look)?.ready) run.input("fire", {});
        }
        return;
      }
      // v5: out of shells, a player works a tower with aimed broadsides from ~260 m (heavy shot only if she's in close anyway).
      const side = wrap180(headingOf(t.x - P.x, t.z - P.z) - P.heading) >= 0 ? "starboard" : "port";
      if (d > 360) follow({ x: t.x, z: t.z }, 2);
      else steer(run, beamHold(P.x, P.z, t, side, 260), 1, { avoid: false });
      if (d < 90) {
        const look = { lookYawRel: side === "starboard" ? 90 : -90, lookPitch: -12, aiming: false };
        run.input("aim", look);
        const pv = run.aimPreview(look);
        if (pv?.ready && pv.targetId === t.id) run.input("fire", {});
      } else aimAndFire(run, t, side, { heavyAt: 0 });
    };
    // A ship the debug stage pointed us at: fight her until she's taken or gone.
    if (mem.focus) {
      const f = sim.shipById(mem.focus);
      if (f && !f.gone && f.state !== "sinking") { fightShip(f); return; }
      mem.focus = null;
    }
    const hostiles = S.ships.filter((x) => sim.alive(x) && !x.fixed && x.detected && x.hostile && ["approach", "broadside", "ram"].includes(x.state)).sort((a, b) => near(a) - near(b));
    const threat = hostiles.find((x) => near(x) < 260);
    // Loot within a short detour.
    const loot = S.pickups.filter((q) => q.kind !== "ring" && near(q) < 220).sort((a, b) => near(a) - near(b))[0];

    const mk = obj?.marker || null;
    switch (mission) {
      case "spice_fleet": case "navy_convoy": case "iron_duke": case "the_gloam": {
        // The step's marker names the ship (or where she was last seen).
        const pickable = (x) => x && !x.gone && x.state !== "sinking" && !x.down;
        let e = mk?.contactId ? sim.shipById(mk.contactId) : null;
        if (!pickable(e)) e = null;
        if (e) mem.targetId = e.id;
        // Out of sight and far: sail to her last known spot (close by, the companion's lookout gives her wake: fight on).
        if (e && mk.kind === "area" && !mk.seen && near(e) > 450) {
          if (near(mk) > 120) { follow({ x: mk.x, z: mk.z }, 2, { sprint: true }); braceWatch(run); return; }
        }
        // Escorts: the crew's attack mode deals with them unless one is right on top of us.
        if (threat && e && threat.id !== e.id && near(threat) < 150 && near(threat) < near(e) - 150 && mission !== "iron_duke" && !fight.mem.gentle) { fightShip(threat); return; }
        const urgent = (obj?.fail || []).some((f) => f.id !== "hull" && f.id !== "time" && f.frac >= 0.3);
        if (!e) {
          if (mk) { follow({ x: mk.x, z: mk.z }, 2); return; }
          if (loot) steer(run, headingOf(loot.x - P.x, loot.z - P.z), 2);
          return;
        }
        if (loot && near(loot) < 90 && near(e) > 300 && !urgent && e.state !== "flee") { steer(run, headingOf(loot.x - P.x, loot.z - P.z), 2); return; }
        if (near(e) > 450) { follow({ x: e.x, z: e.z }, 2, { sprint: true }); braceWatch(run); return; }
        fightShip(e);
        return;
      }
      case "silence_fort": {
        // The harassing gunboats and the garrison's sally (v5: a brig or a fire ship too) when they're on us.
        if (threat && near(threat) < (threat.cls === "fireship" ? 260 : 220)) { fightShip(threat); return; }
        if (mem.step === "approach" && mk) { follow({ x: mk.x, z: mk.z }, 2, { avoidFort: true }); braceWatch(run); return; }
        const towers = S.ships.filter((x) => x.cls === "tower" && !x.down).sort((a, b) => near(a) - near(b));
        const t = (mk?.contactId && sim.shipById(mk.contactId)) || towers[0];
        if (!t || t.down) return;
        siege(t);
        return;
      }
      case "smugglers_run": {
        if (threat && threat.spotted && near(threat) < 200) { fightShip(threat); return; }
        const cv = W.cove;
        if (mem.step === "heave_to" || near(cv) < cv.r * 0.7) { steer(run, P.heading, 0, { avoid: false }); run.input("wheel", { value: 0 }); return; }
        const goal = mem.step === "gap" && mk ? { x: mk.x, z: mk.z + 40 } : { x: cv.x, z: cv.z };
        follow(goal, near(cv) < 160 ? 1 : 2);
        braceWatch(run);
        return;
      }
      case "krakens_wake": {
        braceWatch(run);
        const K = S.hazards.kraken;
        if (K?.stage === "grab") {
          // Shoot the arms off: the swivel on any arm, a heavy volley down a side that has arms.
          const arm = K.arms.find((a) => a.hp > 0);
          if (arm && P.reload.swivel >= 1) run.input("swivel", { targetId: "kraken", weakId: arm.id });
          for (const side of ["port", "starboard"]) {
            if (!K.arms.some((a) => a.hp > 0 && a.side === side) || P.reload[side] < 1) continue;
            const look = { lookYawRel: side === "starboard" ? 90 : -90, lookPitch: -12, aiming: false };
            run.input("aim", look); run.input("fire", {});
          }
        }
        // v5: the lone arms rising round her (a player shoots the ones in reach whatever else they're doing).
        if (K?.stage !== "grab") shootArms(run);
        if (rideWave(run)) return;
        // The wrecks' guards: deal with a guard that's on us before stopping to salvage.
        if (threat && near(threat) < 200 && (mem.step === "wreck1" || mem.step === "wreck2")) { fightShip(threat); return; }
        // The marker: the nearest wreck still to salvage (a point), the eye, then the harbour mouth (an area).
        if (mk && (mem.step === "wreck1" || mem.step === "wreck2")) {
          if (near(mk) < 30) { steer(run, P.heading, 0, { avoid: false }); return; }
          follow({ x: mk.x, z: mk.z }, near(mk) < 140 ? 1 : 2);
          return;
        }
        if (mem.step === "eye") {
          const E = S.hazards.eye;
          if (!E) return;
          const at = E.next || E;
          const d = near(at);
          // Hold it on a beam at ~150 m and pour it in; mortars from range; the swivel close in.
          if (E.stage === "up") {
            if (P.reload.swivel >= 1 && d <= 140) run.input("swivel", { targetId: "kraken_eye", weakId: "kraken_eye" });
            if (P.ammo.mortar > 0 && P.reload.mortar >= 1 && d >= WEAPONS.mortar.minRange + 10 && d <= WEAPONS.mortar.maxRange) {
              const look = { lookYawRel: relBearing(P.x, P.z, P.heading, E.x, E.z), lookPitch: -12, aiming: true, mode: "mortar", point: { x: E.x, z: E.z } };
              run.input("aim", look);
              if (run.aimPreview(look)?.ready) run.input("fire", {});
            } else shootPoint(run, E, 16);
          }
          if (threat && near(threat) < 160 && E.stage !== "up") { fightShip(threat); return; }
          const rel = relBearing(P.x, P.z, P.heading, at.x, at.z);
          mem.eyeSide = mem.eyeSide && Math.abs(Math.abs(rel) - 90) < 70 ? mem.eyeSide : rel >= 0 ? "starboard" : "port";
          steer(run, sailable(beamHold(P.x, P.z, at, mem.eyeSide, 150), S.wind.dirDeg, 30), d > 260 ? 2 : 1);
          return;
        }
        if (threat && near(threat) < 140) { fightShip(threat); return; }
        const ex = mk || W.exit;
        follow({ x: ex.x, z: ex.z }, 2, { sprint: true });
        return;
      }
      default: {
        // Free roam: hunt merchants, bank, be home in time.
        const left = S.cfg.limit - S.t;
        const portD = near(W.port);
        if (left < portD / 12 + 60 || S.plunder.hold >= 250 || (S.heat >= 2 && S.plunder.hold > 0) || P.hull < 50) {
          if (portD > 160) follow({ x: W.port.x, z: W.port.z + 40 }, 2, { sprint: true, avoidFort: true });
          else steer(run, headingOf(W.port.x - P.x, W.port.z - P.z), portD < 80 ? 0 : 1, { avoid: false });
          if (threat && near(threat) < 200) aimAndFire(run, threat, relBearing(P.x, P.z, P.heading, threat.x, threat.z) >= 0 ? "starboard" : "port");
          braceWatch(run);
          return;
        }
        if (threat) { fightShip(threat); return; }
        // v5: free roam's side job (the bonus slot), when there's time for it.
        const job = S.mission?.bonus, jm = obj?.bonus?.marker;
        if (job && !job.done && !job.failed && jm && left > 120) {
          const je = jm.contactId ? sim.shipById(jm.contactId) : null;
          if (je && je.cls === "tower") { if (!je.down) { siege(je); return; } }
          else if (je && sim.alive(je)) {
            fight.mem.gentle = job.kind === "prize";
            if (near(je) > 450) { follow({ x: je.x, z: je.z }, 2, { sprint: true }); return; }
            fightShip(je); return;
          } else if (!jm.contactId) {
            if (job.kind === "salvage" && near(jm) < 30) { steer(run, P.heading, 0, { avoid: false }); return; }
            follow({ x: jm.x, z: jm.z }, job.kind === "salvage" && near(jm) < 140 ? 1 : 2); return;
          }
        }
        let e = sim.shipById(mem.targetId);
        if (!e || !sim.alive(e) || e.cls !== "merchant" || e.derelict) {
          e = S.ships.filter((x) => sim.alive(x) && x.cls === "merchant" && !x.derelict && x.detected).sort((a, b) => near(a) - near(b))[0]
            || S.ships.filter((x) => sim.alive(x) && x.cls === "merchant" && !x.derelict).sort((a, b) => near(a) - near(b))[0] || null;
          mem.targetId = e?.id || null;
        }
        if (loot && (!e || near(e) > 250)) { steer(run, headingOf(loot.x - P.x, loot.z - P.z), 2); return; }
        if (!e) { follow({ x: 0, z: 900 }); return; }
        if (near(e) > 450) { follow({ x: e.x, z: e.z }, 2, { sprint: true }); return; }
        fightShip(e);
      }
    }
  };
  cap.mem = mem;
  cap.fight = fight;
  return cap;
}

/**
 * The scripted companion (tests, ?debug mate): only the companion's tools. A gun crew on the side the Captain
 * isn't looking at (keep firing at the Captain's target), repairs at half hull, the pumps at 35% water,
 * the arms when the Kraken grabs, boarding moves, and at night headings + danger marks from their chart.
 * `cap`: a Captain with mem.targetId / fight.mem.side (or null). Tool calls every 2.5 s (latency).
 */
export function helperMate(cap = null, { guns = true, repairs = true, navigate = true } = {}) {
  const m = { toolT: 0, calls: 0, last: "", offSide: null, offTarget: null, hullMark: 100, kraken: false, headingT: 0 };
  const say = (run, action, args) => {
    m.calls++;
    try { m.last = `${action}: ${run.companion(action, args)}`; } catch (e) { m.last = `${action} REFUSED ${e?.message || e}`; }
    return m.last;
  };
  m.step = function step(run, dt) {
    const sim = run.sim();
    if (!sim) return;
    const S = sim.S, P = S.ship, phase = run.phase();
    if (phase === "boarding") {
      // On her deck: go for her captain once he's out, hold the rail when ours are going down, else man to man.
      const F = run.state().boardfight;
      if (!F || F.phase !== "fight") return;
      m.moveT = (m.moveT || 0) + dt;
      if (m.moveT < 2.5) return;
      m.moveT = 0;
      const want = F.oursUp <= Math.floor(F.ours.length / 2) && !F.captain.present ? "defend" : F.captain.present ? "captain" : "crew";
      if (F.focus !== want) say(run, "boarding_order", { focus: want, why: want === "captain" ? "their captain's out" : want === "defend" ? "we're taking losses" : "thin out her crew" });
      return;
    }
    if (phase !== "sailing") return;
    m.toolT -= dt;
    if (m.toolT > 0) return;
    m.toolT = 2.5;
    // The Kraken: crews on both sides hack at the arms.
    const K = S.hazards.kraken;
    if (K?.stage === "grab" && !m.kraken) { m.kraken = true; say(run, "man_guns", { side: "port", target: "kraken", why: "cut the arms off" }); say(run, "man_guns", { side: "starboard", target: "kraken" }); m.offSide = null; return; }
    if (m.kraken && (!K || K.stage !== "grab")) m.kraken = false;
    if (repairs) {
      if (P.hull < 50 && !S.jobs.repair && (P.hull < m.hullMark - 8 || m.hullMark >= 50)) { m.hullMark = P.hull; say(run, "repair", { what: P.fires ? "all" : "hull", why: "she's at half hull" }); return; }
      if (P.water > 35 && !S.jobs.bail) { say(run, "bail", { why: "water rising" }); return; }
      if (P.leaks >= 2 && !S.jobs.repair) { say(run, "repair", { what: "leaks", why: "stop the water" }); return; }
    }
    // Crew mode (v3): attack while enemies other than the Captain's ship are about; defend (no crew guns) when she's to be taken intact.
    if (guns && cap?.mem && "step" in cap.mem) {
      const gentleStep = cap.mem.step === "disable" || cap.mem.step === "board";
      const tgtId = cap.mem.targetId;
      const others = S.ships.some((x) => sim.alive(x) && x.detected && !x.fixed && x.id !== tgtId && (x.hostile || x.provoked) && x.state !== "surrender"
        && dist(P.x, P.z, x.x, x.z) < 450);
      const want = gentleStep ? "defend" : others ? "attack" : null;
      if (want && S.crewMode.mode !== want && (gentleStep || S.crewMode.mode === "hold")) { say(run, "crew_mode", { mode: want, why: gentleStep ? "take her intact" : "deal with the escorts" }); return; }
    }
    if (guns && cap) {
      const tid = cap.mem?.targetId;
      const e = tid ? sim.shipById(tid) : null;
      const side = cap.fight?.mem?.lookSide || cap.mem?.lookSide || cap.fight?.mem?.side || cap.mem?.side || null;
      // A ship to take intact (the chain's disable/board steps): no crew broadsides into her once she's under half.
      const gentle = (cap.mem?.step === "disable" || cap.mem?.step === "board") && e && e.hull / e.hullMax <= 0.5;
      if (gentle) {
        const on = Object.keys(S.manned).find((sd) => S.manned[sd].target === e.id && S.manned[sd].mode !== "hold");
        if (on) { say(run, "man_guns", { side: on, target: e.id, mode: "hold", why: "take her intact" }); return; }
      } else if (e && sim.alive(e) && e.detected && !e.fixed && side && e.state !== "surrender") {
        const off = side === "port" ? "starboard" : "port";
        if (m.offSide !== off || m.offTarget !== e.id || !S.manned[off]) {
          m.offSide = off; m.offTarget = e.id;
          say(run, "man_guns", { side: off, target: e.id, mode: "keep_firing", why: "the other side while you work yours" });
          return;
        }
      }
    }
    if (navigate && (S.night || S.fogHere > 0.3) && cap?.mem?.path?.length) {
      m.headingT -= 2.5;
      if (m.headingT <= 0) {
        m.headingT = 10;
        const wp = cap.mem.path[0];
        say(run, "call_heading", { heading: String(Math.round(headingOf(wp.x - P.x, wp.z - P.z))).padStart(3, "0"), reason: "clear water" });
      }
    }
  };
  return m;
}

/** v1 names for main.js's debug hooks. */
export const makeNightCaptain = () => makeMissionCaptain();
export const nightMate = (cap) => helperMate(cap);
