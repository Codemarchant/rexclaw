// The sim (spec v2): one mission on the bay at a fixed step. The Rexmaw's
// arcade handling (sails, sprint, wind, turning, loot, masts, water), the
// Captain's weapons (aimed broadsides, the heavy close volley, bow chain shot,
// fire barrels astern, mortars, the swivel), the companion's gun crews and
// repair/bail jobs (only on orders), the other ships (AI in ships.js, fort
// towers), ballistic projectiles with continuous hits, collectables and
// flotsam, reefs/rocks/shoals/islands, fog and visibility, patrol lanterns,
// the Kraken's arms, the maelstrom and the storm (free roam), fires, leaks
// and water, plunder, banking, heat (free roam), boarding hooks.
//
//   const sim = createSim({ world, rng, mission, tele: () => 1, crew })
//   sim.step(h) → events[]                       h = sim seconds (the run applies the pace)
//   sim.S / sim.P                                the live state (read-only outside)
//   sim.setLook(look) / sim.fireWeapon(look?) → {fired, weapon, side, reason, balls}
//   sim.setSail / setWheel / setSprint / brace() / swivel(targetId, weakId)
//   sim.manGuns(side, {target, mode, ammo, who, by, why}) / sim.standDown(side) / sim.fireManned(sides|null, by)
//   sim.startRepair(what, opts) / sim.startBail(opts) / sim.endJob(kind)
//   sim.setCrewMode(mode, by)                     v3: hold | attack (the crews fire what bears) | defend (repairs + pumps on their own)
//   S.contrib                                      v3: what the crew did (gun damage by who, hull repaired, water bailed, …) + `contrib` pops
//   sim.preview(look?) → gunnery.aimPreview on the live sim
//   sim.startBoardingLock / endBoardingLock / capture / release / shipById / visibleContacts / drain / applyBall (tests)
//
//   v4: sim.sea (seaevents.js: the random sea events; their drift, fog, squall sight and gusts feed the physics here),
//   sim.lockShip() (the locked target the Captain's lay snaps to), crew range caps, `sink.cinematic`, kill credit
//   only within 30 s of our last hit (maelstrom, blasts; fires 60 s).
//
// Events are plain {type, ...} objects named like the bus events; the run forwards them.
// Pure: no three.js, no DOM, no Math.random.

import {
  MISSIONS, ARENA, BAY, PORT, SHIP, REXMAW, SAILS, SPRINT, POINTS_OF_SAIL, SPEED_TAU, TURN, LOAD, RAM, GROUND, FIRE, LEAK, BILGE,
  REPAIR, MORALE, AMMO, WEAPONS, BRACE, WEAK, CLASSES, AI, MORTAR, HEAT, KRAKEN, SINK_S, PICKUP, MAELSTROM, STORM, COVE, WRECKS,
  WIND, NAMED, NAMES, REEFS, FOG, SIGHT, LANTERN, FORT, BOARD, BALLISTIC, CREW_AIM, CREW_MODES, CREW_MODE, CONTRIB, NAMED_LABEL,
  CINEMATIC_CLASSES, GLOAM, DUKE, KRAKEN_EYE,
} from "./const.js";
import { clamp, dist, wrap180, wrap360, headingOf, forward, portNormal, relBearing, polyDist, toLocal, ease, segDist, capsuleDist } from "./geom.js";
import { createShip, createTower, aiStep, moveShip } from "./ships.js";
import {
  traceBall, ballDamage, isRaking, hullAxes, enemyBalls, planAimed, weaponFor, normLook, mortarShells, barrelDrops, crewSolution,
  bears as batteryBears, crewBears, crewRange as crewRangeOf, aimPreview, layFor, mortarAim,
} from "./gunnery.js";
import { createSeaEvents } from "./seaevents.js";
import { createPowerups, HOT_FIRES as PU_FIRES } from "./powerups.js";
import { objectivePoints } from "./missions.js";

const ROUND = (v) => Math.round(v * 10) / 10;

/** Degrees off the wind (0 = straight into it). */
export const offWind = (heading, windFrom) => Math.abs(wrap180(heading - windFrom));
/** The point of sail: {name, factor}. */
export const pointOfSail = (off) => POINTS_OF_SAIL.find((p) => Math.abs(off) < p.max) || POINTS_OF_SAIL[POINTS_OF_SAIL.length - 1];

const RELOAD_KEYS = ["port", "starboard", "bow", "mortar", "barrels", "swivel"];
const reloadBase = (k) => (k === "port" || k === "starboard" ? WEAPONS.broadside.reload : k === "bow" ? WEAPONS.chain.reload
  : k === "mortar" ? WEAPONS.mortar.reload : k === "barrels" ? WEAPONS.barrels.reload : WEAPONS.swivel.reload);

export function createSim({ world, rng, mission = "spice_fleet", tele = () => 1, crew }) {
  const cfg = world.arena ? ARENA : MISSIONS[mission] || MISSIONS[world.mission] || MISSIONS.spice_fleet;
  const R = { ai: rng.fork("ai"), guns: rng.fork("guns"), haz: rng.fork("hazards"), dmg: rng.fork("damage"), spawn: rng.fork("spawn"),
    board: rng.fork("board"), crew: rng.fork("crew"), loot: rng.fork("loot"), sea: rng.fork("sea-events") };
  const out = [];
  const emit = (e) => { out.push(e); return e; };
  let pid = 0;
  const night = (world.time || cfg.time) === "night";

  const start = world.start || { x: PORT.x, z: PORT.z + 90, heading: 0 };
  const P = {
    id: "rexmaw", x: start.x, z: start.z, heading: start.heading, speed: 0, vx: 0, vz: 0, sail: 0, wheel: 0, rudder: 0, heel: 0,
    sprint: { on: false, want: false, wind: 1 },
    hull: REXMAW.hull, hullMax: REXMAW.hull, masts: REXMAW.masts, water: 0, fires: 0, fireAges: [], leaks: 0, morale: REXMAW.morale,
    crewHands: crew.hands(), ammo: { ...cfg.ammo },
    guns: { port: { live: 7, max: 7 }, starboard: { live: 7, max: 7 }, bow: { live: 2, max: 2 } },
    reload: Object.fromEntries(RELOAD_KEYS.map((k) => [k, 1])), reloadS: Object.fromEntries(RELOAD_KEYS.map((k) => [k, 0])),
    braceT: 0, braceStart: -1e9, braceCd: 0, perfectT: null, perfectThisBrace: false, stuckT: 0, spinT: 0, groundCd: 0,
    inHarbour: false, speedCap: 0, lootSlow: 0, pointOfSail: "", krakenSlow: 1, firingT: {},
  };

  const S = {
    t: 0, mission: cfg.id, cfg, world, night, wind: { ...world.wind }, ship: P, ships: [], projectiles: [], pickups: [], barrels: [],
    storm: world.storm ? { ...world.storm, inside: false } : null,
    hazards: { wave: null, spouts: [], lightning: null, kraken: null, mortars: [] },
    heat: 0, lastFightT: -1e9, nextWave: null, waveRepeatT: HEAT.waveEvery,
    plunder: { hold: 0, banked: 0, loot: 0 }, contraband: 0, banking: null, salvage: null, salvaged: new Set(), cove: { used: false, t: 0 },
    revealed: new Set(), overboard: [], boarding: null, visibility: night ? FOG.nightVis : FOG.dayVis, fogHere: 0,
    look: normLook({ lookYawRel: 90, lookPitch: -12 }), weapon: { weapon: "broadside", side: "starboard" },
    manned: {}, jobs: {}, marked: null, track: [], trackT: 0, kraken: { next: null, done: 0 },
    stats: { sunk: [], captured: [], escaped: [], volleys: 0, captainVolleys: 0, crewVolleys: 0, rakingVolleys: 0, ballsFired: 0, ballsHit: 0,
      perfectBraces: 0, braces: 0, damageTaken: 0, damageDealt: 0, heatMax: 0, banks: 0, lastBankT: null, krakenRepelled: 0, maelstromKills: 0,
      boardings: 0, salvages: 0, swivelHits: 0, distance: 0, pickups: 0, repairs: 0, hullRepaired: 0, spotted: 0, reefHits: 0, sprintS: 0 },
    wavesT: R.haz.range(STORM.waveEvery[0], STORM.waveEvery[1]), lightT: R.haz.range(STORM.lightningEvery[0], STORM.lightningEvery[1]),
    // v3: the crew mode (hold | attack | defend) and what the crew did (the contribution counters).
    crewMode: { mode: "hold", by: null, t: 0, targets: {}, defendT: 0 },
    contrib: { guns: { damage: 0, volleys: 0, hits: 0, sunk: 0, by: {} }, hullRepaired: 0, waterBailed: 0, firesOut: 0, leaksPatched: 0,
      reefsCalled: 0, dangerMarks: 0, headingCalls: 0, braceCalls: 0, bracesBeforeHits: 0, damageSaved: 0, armsCut: 0, best: null },
    crewVolleys: {}, contribPending: {},
  };
  if (world.storm) { const n = R.haz.int(STORM.spouts[0], STORM.spouts[1]); for (let i = 0; i < n; i++) S.hazards.spouts.push(newSpout(i + 1, true)); }
  if (world.maelstrom) {
    for (let i = 0; i < MAELSTROM.ringChests; i++) {
      S.pickups.push({ id: `ring${i + 1}`, kind: "ring", value: MAELSTROM.chestValue, a: (i / MAELSTROM.ringChests) * Math.PI * 2,
        r: R.spawn.range(world.maelstrom.ring[0], world.maelstrom.ring[1]), x: 0, z: 0 });
    }
  }
  for (const p of world.pickups || []) S.pickups.push({ ...p, age: 0, placed: true });

  // The fleet and the fort's towers (towers are fixed contacts in the same list).
  for (const spec of world.fleet || []) S.ships.push(createShip(spec, world, R.spawn));
  if (world.fort) for (const t of world.fort.towers) S.ships.push(createTower(t, R.spawn));
  let shipN = S.ships.length;

  // ---- Helpers ------------------------------------------------------------------------

  const shipById = (id) => S.ships.find((e) => e.id === id) || null;
  const alive = (e) => !!e && !e.gone && e.state !== "sinking" && !e.down;

  function isWater(x, z, pad = 0) {
    const b = world.bounds;
    if (x < b.minX + 30 || x > b.maxX - 30 || z < b.minZ + 30 || z > b.maxZ - 30) return false;
    for (const isl of world.islands) {
      if (dist(x, z, isl.x, isl.z) > isl.r + pad + 30) continue;
      if (polyDist(x, z, isl.poly).d < pad) return false;
      for (const s of isl.shoals) if (dist(x, z, s.x, s.z) < s.r + pad * 0.5) return false;
    }
    for (const rf of world.reefs || []) if (dist(x, z, rf.x, rf.z) < rf.r + pad && capsuleDist(x, z, rf).d < pad * 0.6) return false;
    return true;
  }
  const inStorm = (x, z, margin = 0) => !!S.storm && dist(x, z, S.storm.x, S.storm.z) < S.storm.r + margin;
  /** Fog density (0..1) at a point: the thickest bank it's in (the bay's, or a sea event's rolling one), faded at the edge. */
  function fogAt(x, z) {
    let f = 0;
    for (const b of world.fog || []) {
      const d = dist(x, z, b.x, b.z);
      if (d < b.r) f = Math.max(f, (b.density ?? 0.85) * clamp((b.r - d) / FOG.edge, 0, 1));
    }
    if (sea) f = Math.max(f, sea.fogAt(x, z));
    return f;
  }
  /** How far one can see from (x, z). */
  function visibilityAt(x, z) {
    let v = night ? FOG.nightVis : FOG.dayVis;
    const f = fogAt(x, z);
    if (f > 0) v = v + (FOG.bankVis - v) * f;
    if (inStorm(x, z)) v = Math.min(v, STORM.visibility);
    if (sea) v = sea.visibility(x, z, v);
    return v;
  }
  /** v4: the random sea events (created once the sim's helpers exist, below). */
  let sea = null;
  /** v4.2: the power-ups afloat and the buffs they give (created with the sea events, below). */
  let pw = null;

  function newSpout(i, initial = false) {
    const st = S.storm || world.storm;
    const a = R.haz.range(0, Math.PI * 2), r = R.haz.range(0, st.r * 0.85);
    return { id: `spout${i}`, x: st.x + Math.cos(a) * r, z: st.z + Math.sin(a) * r, r: STORM.spoutR, dir: R.haz.range(0, 360),
      stage: initial ? "active" : "forming", t: 0, life: R.haz.range(50, 90), cd: 0 };
  }

  const windFactor = (heading) => pointOfSail(offWind(heading, S.wind.dirDeg)).factor;

  function addHeat(n, why = "") {
    if (!cfg.free) return;
    const prev = S.heat;
    S.heat = clamp(S.heat + n, 0, HEAT.max);
    if (S.heat === prev) return;
    S.stats.heatMax = Math.max(S.stats.heatMax, S.heat);
    if (S.heat > prev) S.lastFightT = S.t;
    emit({ type: "heat", level: S.heat, prev, why });
    if (S.heat > prev) {
      const at = S.t + R.spawn.range(HEAT.waveDelay[0], HEAT.waveDelay[1]);
      if (!S.nextWave || S.nextWave.level < S.heat) S.nextWave = { at, level: S.heat };
    }
  }
  const fought = () => { S.lastFightT = S.t; };

  // ---- Spawning --------------------------------------------------------------------------

  function spawnShip(cls, role, near = null, extra = {}) {
    let x = null, z = null;
    for (let i = 0; i < 60 && x == null; i++) {
      const a = R.spawn.range(0, Math.PI * 2), r = near?.r ?? R.spawn.range(600, 750);
      const cx = (near?.x ?? P.x) + Math.cos(a) * r, cz = (near?.z ?? P.z) + Math.sin(a) * r;
      if (isWater(cx, cz, 40) && dist(cx, cz, PORT.x, PORT.z) > 300) { x = cx; z = cz; }
    }
    if (x == null) { x = clamp(P.x, -700, 700); z = BAY.maxZ - 150; }
    const used = new Set(S.ships.map((e) => e.name));
    const pool = CLASSES[cls] ? cls : "brig";
    const names = (NAMES[pool] || []).filter((n) => !used.has(n));
    const name = names.length ? R.spawn.pick(names) : `the ${CLASSES[pool].label} no. ${shipN + 1}`;
    const e = createShip({ id: `${pool[0]}${++shipN}`, cls: pool, name, role, x, z, heading: headingOf(P.x - x, P.z - z), ...extra }, world, R.spawn);
    S.ships.push(e);
    emit({ type: "spawn", id: e.id, cls: e.cls, role, name: e.name });
    return e;
  }

  function hunterWave(level) {
    const list = HEAT.waves[clamp(level, 0, HEAT.max)] || [];
    const a = R.spawn.range(0, Math.PI * 2), r = R.spawn.range(600, 750);
    const base = { x: P.x + Math.cos(a) * r, z: P.z + Math.sin(a) * r };
    const made = list.map((cls) => spawnShip(cls, "hunter", { x: base.x, z: base.z, r: R.spawn.range(0, 80) }));
    if (made.length) emit({ type: "wave", level, ids: made.map((e) => e.id) });
    return made;
  }

  // ---- The Rexmaw ----------------------------------------------------------------------

  function setSail(v) { P.sail = clamp(Math.round(v), 0, 2); if (P.sail < 2) setSprint(false); }
  function setWheel(v) { P.wheel = clamp(Number(v) || 0, -1, 1); }
  function setSprint(on) {
    const want = !!on;
    if (want && (P.sail < 2 || P.sprint.wind < SPRINT.minStart)) { P.sprint.want = true; return false; }
    P.sprint.want = want;
    if (P.sprint.on !== want) { P.sprint.on = want; emit({ type: "sprint", on: want }); }
    return true;
  }

  function movePlayer(h) {
    P.rudder += (P.wheel - P.rudder) * ease(h, TURN.rudderTau);
    // The sprint's wind bar: drains while sprinting, refills otherwise.
    if (P.sprint.on) {
      P.sprint.wind = Math.max(0, P.sprint.wind - h / SPRINT.drainS);
      S.stats.sprintS += h;
      if (P.sprint.wind <= 0 || P.sail < 2) { P.sprint.on = false; emit({ type: "sprint", on: false }); }
    } else {
      P.sprint.wind = Math.min(1, P.sprint.wind + h / SPRINT.refillS);
      if (P.sprint.want && P.sail === 2 && P.sprint.wind >= SPRINT.minStart + 0.1) { P.sprint.on = true; emit({ type: "sprint", on: true }); }
    }
    const pos = pointOfSail(offWind(P.heading, S.wind.dirDeg));
    P.pointOfSail = pos.name;
    const mastsF = P.masts < LOAD.mastsLow ? LOAD.mastsLowF : P.masts < LOAD.mastsHalf ? LOAD.mastsHalfF : 1;
    P.lootSlow = Math.min(LOAD.cap, (S.plunder.hold / 100) * LOAD.per100);
    const waterF = P.water > LOAD.waterFrom ? 1 - LOAD.waterSlow * (P.water - LOAD.waterFrom) / (100 - LOAD.waterFrom) : 1;
    const windS = 0.85 + 0.15 * S.wind.strength;
    const base = P.sprint.on ? SPRINT.speed : SAILS[P.sail];
    let cap = base * pos.factor * windS * mastsF * (1 - P.lootSlow) * waterF * P.krakenSlow * (sea ? sea.speedMul() : 1) * (pw ? pw.speedMul() : 1);   // v4: the dolphins' bow wave; v4.2 Swift Wind
    if (S.boarding) cap = 0;
    P.speedCap = cap;
    if (P.stuckT > 0) { P.stuckT -= h; P.speed *= Math.exp(-h / 0.15); }
    else P.speed += (cap - P.speed) * ease(h, cap > P.speed ? SPEED_TAU.up : SPEED_TAU.down);
    const maxRate = P.sprint.on ? TURN.sprint : P.sail === 2 ? TURN.full : P.sail === 1 ? TURN.half : TURN.furled;
    const rate = maxRate * clamp(TURN.minF + (1 - TURN.minF) * P.speed / TURN.vRef, TURN.minF, 1);
    let turn = P.rudder * rate;
    if (S.boarding) turn = 0;
    if (P.spinT > 0) { P.spinT -= h; turn = 120; }
    P.heading = wrap360(P.heading + turn * h);
    P.heel = clamp(turn / 30 * clamp(P.speed / 12, 0.3, 1.3), -1, 1);
    const f = forward(P.heading);
    const drift = seaDrift(P.x, P.z);
    P.vx = f.x * P.speed + drift.x; P.vz = f.z * P.speed + drift.z;
    if (S.boarding) { P.vx = 0; P.vz = 0; }
    const ox = P.x, oz = P.z;
    P.x += P.vx * h; P.z += P.vz * h;
    S.stats.distance += dist(ox, oz, P.x, P.z);
    collideLand(P, h, true);
    collideReefs(h);
    collideObstacles(P, SHIP.half, SHIP.radius);
    const b = world.bounds, m = 25;
    if (P.x < b.minX + m) P.x = b.minX + m; if (P.x > b.maxX - m) P.x = b.maxX - m;
    if (P.z < b.minZ + m) P.z = b.minZ + m; if (P.z > b.maxZ - m) P.z = b.maxZ - m;
    P.inHarbour = dist(P.x, P.z, world.port.x, world.port.z) < world.port.r;
  }

  /** Everything that carries a hull along regardless of her sails: the maelstrom's pull and a waterspout's (v4). */
  function seaDrift(x, z) {
    const m = maelstromDrift(x, z);
    if (!sea) return m;
    const s = sea.driftAt(x, z);
    return { x: m.x + s.x, z: m.z + s.z };
  }

  function maelstromDrift(x, z) {
    const M = world.maelstrom;
    if (!M) return { x: 0, z: 0 };
    const d = dist(x, z, M.x, M.z);
    if (d > M.r || d < 1) return { x: 0, z: 0 };
    const v = MAELSTROM.pull / Math.max(d, M.eye) * Math.min(1, (M.r - d) / 50);
    const ux = (M.x - x) / d, uz = (M.z - z) / d;
    return { x: ux * v + uz * v * MAELSTROM.swirl, z: uz * v - ux * v * MAELSTROM.swirl };
  }

  let obstacles = [];
  function setObstacles(list) { obstacles = Array.isArray(list) ? list.filter((o) => o && Number.isFinite(o.r)) : []; }
  function collideObstacles(s, half, pad) {
    if (!obstacles.length || dist(s.x, s.z, world.port.x, world.port.z) > 400) return;
    const f = forward(s.heading);
    for (const o of obstacles) {
      for (const k of [1, 0, -1]) {
        const px = s.x + f.x * half * k, pz = s.z + f.z * half * k;
        let cx = o.x, cz = o.z;
        if (o.a && o.b) {
          const dx = o.b.x - o.a.x, dz = o.b.z - o.a.z, L2 = dx * dx + dz * dz || 1;
          const u = clamp(((px - o.a.x) * dx + (pz - o.a.z) * dz) / L2, 0, 1);
          cx = o.a.x + dx * u; cz = o.a.z + dz * u;
        }
        const d = dist(px, pz, cx, cz), need = o.r + pad;
        if (d >= need || d < 1e-6) continue;
        s.x += ((px - cx) / d) * (need - d); s.z += ((pz - cz) / d) * (need - d);
        s.speed *= 0.6;
        break;
      }
    }
  }

  /** Islands are solid; shoals ground the Rexmaw (enemies steer clear of them). */
  function collideLand(s, h, isPlayer) {
    const half = isPlayer ? SHIP.half : (s.C?.len || 30) / 2 - 2;
    const pad = isPlayer ? SHIP.radius : (s.C?.beam || 8) / 2;
    const f = forward(s.heading);
    for (const isl of world.islands) {
      if (dist(s.x, s.z, isl.x, isl.z) > isl.r + half + 20) continue;
      for (const k of [1, 0, -1]) {
        const px = s.x + f.x * half * k, pz = s.z + f.z * half * k;
        const pd = polyDist(px, pz, isl.poly);
        if (pd.d >= pad) continue;
        let nx = px - pd.x, nz = pz - pd.z;
        const L = Math.hypot(nx, nz) || 1;
        nx /= L; nz /= L;
        if (pd.d < 0) { nx = -nx; nz = -nz; }
        const push = pad - pd.d;
        s.x += nx * push; s.z += nz * push;
        if (isPlayer) {
          if (s.speed > GROUND.islandSpeed && s.groundCd <= 0) {
            hurtPlayer(GROUND.islandHull, { kind: "hull", cause: "island", x: px, z: pz });
            emit({ type: "hazard", kind: "island", stage: "hit", id: isl.id, x: ROUND(px), z: ROUND(pz) });
            s.groundCd = 2;
          }
          s.speed *= 0.3;
        } else { s.speed *= 0.5; s.stuckT = (s.stuckT || 0) + h; }
        break;
      }
      if (isPlayer) {
        for (const sh of isl.shoals) {
          if (dist(s.x, s.z, sh.x, sh.z) > sh.r + 3) continue;
          S.revealed.add(sh.id);
          if (s.groundCd > 0 || s.stuckT > 0) continue;
          hurtPlayer(GROUND.shoalHull, { kind: "hull", cause: "shoal", x: s.x, z: s.z });
          s.stuckT = GROUND.stuckS; s.groundCd = GROUND.grace;
          const d = dist(s.x, s.z, sh.x, sh.z) || 1;
          s.x = sh.x + (s.x - sh.x) / d * (sh.r + 6); s.z = sh.z + (s.z - sh.z) / d * (sh.r + 6);
          emit({ type: "hazard", kind: "shoal", stage: "hit", id: sh.id, x: ROUND(sh.x), z: ROUND(sh.z) });
        }
      }
    }
    if (isPlayer && s.groundCd > 0) s.groundCd -= h;
  }

  /** Reefs and rocks: the hull capsule meets a reef capsule → she grounds: hull by speed, maybe a leak, a short stop. */
  function collideReefs() {
    const f = forward(P.heading);
    const ax = P.x + f.x * SHIP.half, az = P.z + f.z * SHIP.half, bx = P.x - f.x * SHIP.half, bz = P.z - f.z * SHIP.half;
    for (const rf of world.reefs || []) {
      if (dist(P.x, P.z, rf.x, rf.z) > rf.r + SHIP.half + SHIP.radius + 5) continue;
      // Closest points: sample the hull's axis against the reef's capsule.
      let best = null;
      for (let i = 0; i <= 6; i++) {
        const t = i / 6, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const c = capsuleDist(px, pz, rf);
        if (!best || c.d < best.d) best = { d: c.d, px, pz, cx: c.x, cz: c.z };
      }
      if (best.d >= SHIP.radius) continue;
      let nx = best.px - best.cx, nz = best.pz - best.cz;
      const L = Math.hypot(nx, nz) || 1;
      nx /= L; nz /= L;
      const push = SHIP.radius - best.d;
      P.x += nx * push; P.z += nz * push;
      if (!S.revealed.has(rf.id)) { S.revealed.add(rf.id); emit({ type: "hazard", kind: "reef", stage: "reveal", id: rf.id, x: rf.x, z: rf.z }); }
      if (P.groundCd > 0) { P.speed *= 0.5; continue; }
      const sp = P.speed;
      const dmg = REEFS.hull + REEFS.hullPerMs * sp;
      hurtPlayer(dmg, { kind: "hull", cause: "reef", x: best.px, z: best.pz });
      if (sp > 6 && R.dmg.chance(REEFS.leakChance)) startLeak();
      P.stuckT = REEFS.stuckS; P.groundCd = REEFS.grace; P.speed *= 0.25;
      S.stats.reefHits++;
      emit({ type: "hazard", kind: "reef", stage: "hit", id: rf.id, name: rf.name, x: ROUND(best.px), z: ROUND(best.pz), dmg: ROUND(dmg) });
    }
  }

  /** Damage to the Rexmaw from anything but a ball (rams, hazards, fires): brace applies to impacts. */
  function hurtPlayer(hull, { kind = "hull", cause = "", x = P.x, z = P.z, braceable = true, crewLoss = 0 } = {}) {
    if (S.boarding && cause !== "fire" && cause !== "kraken") return { cancelled: true };
    let mul = 1, perfect = false;
    if (braceable && P.braceT > 0) {
      perfect = S.t - P.braceStart <= BRACE.perfect;
      mul = perfect ? BRACE.perfectMul : BRACE.mul;
      notePerfect(perfect);
    }
    const dmg = hull * mul * (pw ? pw.damageMul() : 1);   // v4.2: Iron Hull
    P.hull = Math.max(0, P.hull - dmg);
    S.stats.damageTaken += dmg;
    if (crewLoss > 0 && !perfect) killHands(crewLoss);
    if (braceable) emit({ type: "impact", target: "rexmaw", x: ROUND(x), y: 2, z: ROUND(z), dmg: ROUND(dmg), kind, cause, braced: mul < 1, perfect });
    return { dmg, perfect, mul };
  }

  function notePerfect(perfect) {
    if (perfect && !P.perfectThisBrace) {
      P.perfectThisBrace = true; P.perfectT = 0; S.stats.perfectBraces++;
      emit({ type: "brace", perfect: true });
    }
  }

  function killHands(n) {
    const k = crew.killHands(n);
    P.crewHands = crew.hands();
    if (k > 0) P.morale = Math.max(0, P.morale - k * MORALE.handKilled);
    return k;
  }

  function startFire(x = P.x, z = P.z) {
    if (P.fires >= FIRE.max) return;
    P.fires++; P.fireAges.push(0);
    emit({ type: "fire", target: "rexmaw", x: ROUND(x), z: ROUND(z), stage: "start", count: P.fires });
  }
  function startLeak() {
    if (P.leaks >= LEAK.max) return;
    P.leaks++;
    emit({ type: "leak", target: "rexmaw", stage: "start", count: P.leaks });
  }

  // ---- Brace & swivel (the Captain's) --------------------------------------------------

  function brace() {
    if (P.braceCd > 0 || P.braceT > 0) return false;
    P.braceT = BRACE.window; P.braceStart = S.t; P.braceCd = BRACE.window + BRACE.cooldown; P.perfectThisBrace = false;
    S.stats.braces++;
    emit({ type: "brace", perfect: false, stage: "start" });
    return true;
  }

  function swivel(targetId, weakId) {
    if (P.reload.swivel < 1) return { hit: false, reason: "reloading" };
    const W = WEAPONS.swivel;
    const K = S.hazards.kraken;
    // v4: a lone Kraken arm (a sea event) by its event id.
    // v5: the Kraken's eye (Kraken's Wake), while it's up and within the swivel's reach.
    if (targetId === "kraken_eye" || weakId === "kraken_eye") {
      const E = S.hazards.eye;
      if (!E || E.stage !== "up") return { hit: false, reason: "the eye's under the water" };
      if (dist(P.x, P.z, E.x, E.z) > KRAKEN_EYE.swivelR) return { hit: false, reason: "out of range" };
      P.reload.swivel = 0; S.stats.swivelHits++;
      eyeHit(KRAKEN_EYE.swivel, "swivel");
      emit({ type: "swivel", targetId: "kraken_eye", weakId: "kraken_eye", hit: true, effect: "eye" });
      return { hit: true, effect: "eye" };
    }
    const armEv = sea?.byId(targetId) || sea?.byId(weakId);
    if (armEv?.kind === "kraken_arm") {
      const r = sea.swivel(armEv.id);
      if (r?.hit) { P.reload.swivel = 0; S.stats.swivelHits++; }
      emit({ type: "swivel", targetId: armEv.id, weakId: armEv.id, hit: !!r?.hit, effect: r?.hit ? "arm" : undefined });
      return r?.hit ? { hit: true, effect: "arm" } : { hit: false, reason: r?.reason || "no arm there" };
    }
    if (targetId === "kraken" || (K && K.stage === "grab" && K.arms.some((a) => a.id === weakId))) {
      const arm = K?.arms.find((a) => a.id === weakId && a.hp > 0);
      P.reload.swivel = 0;
      if (!arm) { emit({ type: "swivel", targetId: "kraken", weakId, hit: false }); return { hit: false, reason: "no arm there" }; }
      armDamage(arm, W.armDmg, "swivel");
      S.stats.swivelHits++;
      emit({ type: "swivel", targetId: "kraken", weakId, hit: true, effect: "arm" });
      return { hit: true, effect: "arm" };
    }
    const e = shipById(targetId);
    if (!alive(e) || e.fixed) { emit({ type: "swivel", targetId, weakId, hit: false }); return { hit: false, reason: "no target" }; }
    const d = dist(P.x, P.z, e.x, e.z);
    const wp = e.weakPoints.find((w) => w.id === weakId);
    if (!wp || d > W.range) { emit({ type: "swivel", targetId, weakId, hit: false }); return { hit: false, reason: d > W.range ? "out of range" : "no weak point" }; }
    P.reload.swivel = 0;
    e.weakPoints = e.weakPoints.filter((w) => w !== wp);
    e.hull -= W.dmg;
    let effect = "hull";
    if (R.dmg.chance(W.fire)) { e.fires++; effect = "fire"; emit({ type: "fire", target: e.id, x: ROUND(e.x), z: ROUND(e.z), stage: "start" }); }
    else if (R.dmg.chance(W.officer)) { e.crew = Math.max(0, e.crew - 3); effect = "officer"; }
    S.stats.swivelHits++;
    S.stats.damageDealt += W.dmg;
    provoke(e);
    e.lastHitByRexmawT = S.t;
    emit({ type: "swivel", targetId, weakId, hit: true, effect });
    emit({ type: "impact", target: e.id, x: ROUND(e.x), y: 3, z: ROUND(e.z), dmg: W.dmg, kind: "hull", ammo: "swivel", from: "rexmaw" });
    if (e.hull <= 0) sinkEnemy(e, "swivel", true);
    return { hit: true, effect };
  }

  // ---- The Captain's guns ----------------------------------------------------------------------

  /** v4: the locked ship (state.lock / S.marked) when she can still be shot at. v5: the Kraken's eye while it's up (a fixed point). */
  const lockShip = () => {
    const E = S.marked === "kraken_eye" ? S.hazards.eye : null;
    if (E) return E.stage === "up" ? { id: "kraken_eye", name: "The Kraken's eye", eye: true, fixed: true, x: E.x, z: E.z, vx: 0, vz: 0, heading: 0, r: KRAKEN_EYE.hitR } : null;
    const e = S.marked ? shipById(S.marked) : null; return alive(e) ? e : null;
  };

  function setLook(look) {
    S.look = normLook(look);
    const w = weaponFor(S.look, { pose: P, contacts: S.ships, lock: lockShip() });
    if (w.weapon !== S.weapon.weapon || w.side !== S.weapon.side) emit({ type: "weapon", weapon: w.weapon, side: w.side });
    S.weapon = { weapon: w.weapon, side: w.side };
    return S.weapon;
  }

  const reloadKeyOf = (weapon, side) => (weapon === "broadside" || weapon === "heavy" ? side : weapon === "chain" ? "bow" : weapon);

  /** The Captain fires what the look selects. */
  function fireWeapon(lookIn = null, by = "captain") {
    if (lookIn) setLook(lookIn);
    const look = S.look;
    const lock = lockShip();
    const sel = weaponFor(look, { pose: P, contacts: S.ships, lock });
    const W = WEAPONS[sel.weapon];
    const key = reloadKeyOf(sel.weapon, sel.side);
    const fail = (reason) => { emit({ type: "dry_fire", weapon: sel.weapon, side: sel.side, reason }); return { fired: false, weapon: sel.weapon, side: sel.side, reason }; };
    if (S.boarding) return fail("boarding");
    if (P.reload[key] < 1) return fail("reloading");
    if (W.ammo && (P.ammo[W.ammo] ?? 0) < 1) return fail("empty");
    if ((sel.side === "port" || sel.side === "starboard" || sel.side === "bow") && P.guns[sel.side].live <= 0) return fail("no guns");
    if (W.ammo) P.ammo[W.ammo] -= 1;
    P.reload[key] = 0;
    S.stats.captainVolleys++;
    if (sel.weapon === "barrels") {
      for (const d of barrelDrops(P)) {
        const b = { id: `bar${++pid}`, x: d.x, z: d.z, t: 0, lit: true };
        S.barrels.push(b);
        emit({ type: "barrel", id: b.id, stage: "drop", x: ROUND(b.x), z: ROUND(b.z) });
      }
      emit({ type: "volley", side: "stern", by: "rexmaw", firedBy: by, weapon: "barrels", ammo: "barrels", balls: 3, target: null, raking: false });
      return { fired: true, weapon: "barrels", side: "stern", balls: 3 };
    }
    if (sel.weapon === "mortar") {
      const ma = mortarAim(P, look, sel, lock);
      return fireMortar(ma.circle, by, R.guns, ma.snapped ? { target: ma.target } : {});
    }
    // The same lay the preview drew: the heavy volley's, the locked ship's (v4), else the look's.
    const lay = layFor(P, look, sel, S.ships, lock);
    const { yaw, elev } = lay;
    let target = lay.target || null;
    const balls = planAimed({ pose: P, weapon: sel.weapon, side: sel.side, yaw, elev }).slice(0, P.guns[sel.side].live);
    if (!target) {
      // The volley's target: the hull most of the arcs end on (as the preview shows it).
      const n = {};
      for (const b of balls) { const tr = traceBall(b, S.ships, { from: "rexmaw", ammo: W.shot, dt: 1 / 30, lead: true }); if (tr.ship) n[tr.ship.id] = (n[tr.ship.id] || 0) + 1; }
      const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
      if (top) target = shipById(top[0]);
    }
    // A heavy volley point-blank down the side clears the Kraken's arms off that rail.
    const K = S.hazards.kraken;
    if (sel.weapon === "heavy" && K?.stage === "grab") for (const a of K.arms) if (a.side === sel.side && a.hp > 0) armDamage(a, KRAKEN.heavyArm, "heavy");
    return launch(balls, { side: sel.side, weapon: sel.weapon, ammo: W.shot, by, target });
  }

  function fireMortar(circle, by, rngShells = R.guns, extra = {}) {
    const shells = mortarShells(P, circle, rngShells);
    const m = { id: `mortar${++pid}`, from: "rexmaw", x: circle.x, z: circle.z, r: circle.r, eta: WEAPONS.mortar.flight, total: WEAPONS.mortar.flight };
    S.hazards.mortars.push(m);
    emit({ type: "mortar_shot", id: m.id, x: ROUND(m.x), z: ROUND(m.z), r: m.r, eta: m.eta });
    const tgt = extra.target || S.ships.find((e) => alive(e) && dist(e.x, e.z, circle.x, circle.z) <= circle.r + hullAxes(e).hb) || null;
    return launch(shells, { side: "mortar", weapon: "mortar", ammo: "mortar", by, ...extra, target: tgt });
  }

  /** Put balls in the air; one volley event. A crew volley (not the Captain's) is tracked for the contribution counters. */
  function launch(balls, { side, weapon, ammo, by, target = null, who = null, orderedBy = null }) {
    let vid = null;
    if (by !== "captain" && balls.length) {
      vid = `v${++pid}`;
      S.crewVolleys[vid] = { who: who || "hands", by: orderedBy, side, left: balls.length, dmg: 0, hits: 0, target: target?.id ?? null, x: target?.x ?? P.x, z: target?.z ?? P.z, sunk: null, t: S.t };
    }
    const hot = balls.length > 0 && !!pw?.useHotShot();   // v4.2: a Hot Shot volley sets what it hits burning
    for (const b of balls) S.projectiles.push({ id: `b${++pid}`, from: "rexmaw", side, ammo, b, t0: S.t + (b.delay || 0), tau: 0, target: target?.id ?? null, by, vid, hot });
    S.stats.volleys++; S.stats.ballsFired += balls.length;
    P.firingT[side] = 0.3;
    const raking = !!target && isRaking(P.x, P.z, target);
    if (raking) S.stats.rakingVolleys++;
    if (target) provoke(target);
    fought();
    emit({ type: "volley", side, by: "rexmaw", firedBy: by, weapon, ammo, balls: balls.length, target: target?.id ?? null, raking });
    return { fired: true, weapon, side, balls: balls.length, target: target?.id ?? null, raking };
  }

  // ---- The companion's gun crews (man_guns) ------------------------------------------------------

  /**
   * Put a gun crew on a battery: target (a ship id, or "kraken"), mode once | keep_firing | hold, ammo round | chain | heavy.
   * Returns {ok, text, who}.
   */
  function manGuns(side, { target = null, mode = "keep_firing", ammo = null, who = null, by = "companion", why = "" } = {}) {
    const r = crew.startJob("guns", { side, who, by, why, t: S.t });
    if (!r.ok) return r;
    const prev = S.manned[side];
    const shot = side === "mortar" ? "mortar" : ammo || (side === "bow" ? "chain" : "round");
    S.manned[side] = { side, job: r.job.id, target, mode, ammo: shot, by, why, t: S.t, fired: 0, status: "waiting", prevTarget: prev?.target ?? null };
    r.job.repel = target === "kraken";
    emit({ type: "job", id: r.job.id, kind: "guns", side, stage: "start", who: r.who });
    return { ok: true, text: r.text, who: r.who };
  }

  function standDown(side, why = "", stage = "stopped") {
    const m = S.manned[side];
    if (!m) return false;
    delete S.manned[side];
    const job = crew.endJob(m.job, { t: S.t });
    emit({ type: "job", id: m.job, kind: "guns", side, stage, who: job?.who || [] });
    return true;
  }

  function mannedTarget(m) {
    if (m.target === "kraken") return null;
    return shipById(m.target);
  }

  /** Fire a manned battery now (the crew lays the guns). → {fired, reason} */
  function crewFire(side, by = "crew") {
    const m = S.manned[side];
    if (!m) return { fired: false, reason: "nobody's on those guns" };
    const key = side === "bow" ? "bow" : side;
    if (P.reload[key] < 1) return { fired: false, reason: `still loading (${Math.round(P.reload[key] * 100)}%)` };
    if (S.boarding) return { fired: false, reason: "we're boarding" };
    if (m.target === "kraken") return { fired: false, reason: "they're hacking at the arms" };
    const tgt = mannedTarget(m);
    if (!alive(tgt)) return { fired: false, reason: "the target's gone" };
    const skill = crew.gunnerSkill(side);
    const gj = crew.jobOf("guns", side);
    const credit = { who: gj?.who.find((w) => crew.present(w) && crew.atOf(w) === gj.station) || "hands", orderedBy: m.by };
    if (side === "mortar") {
      if ((P.ammo.mortar ?? 0) < 1) return { fired: false, reason: "no mortar shells left" };
      const sol = crewSolution({ pose: P, side: "mortar", target: tgt, skill, rng: R.crew });
      if (!sol) return { fired: false, reason: "she's outside mortar range (150–600 m)" };
      P.ammo.mortar -= 1; P.reload.mortar = 0;
      S.stats.crewVolleys++;
      m.fired++;
      return fireMortar(sol.circle, by, R.crew, credit);
    }
    if (side !== "bow" && P.guns[side].live <= 0) return { fired: false, reason: "no guns left on that side" };
    const heavy = m.ammo === "heavy";
    const weapon = side === "bow" ? "chain" : heavy ? "heavy" : "broadside";
    let shot = side === "bow" ? m.ammo : heavy ? "heavy" : "round";
    if (shot === "chain" && (P.ammo.chain ?? 0) < 1) shot = "round";
    if (heavy && dist(P.x, P.z, tgt.x, tgt.z) > WEAPONS.heavy.range + 20) return { fired: false, reason: `heavy shot only carries ${WEAPONS.heavy.range} m` };
    // v4 §4: a crew holds fire beyond its shot's effective range (round 250 m, chain 200 m), even when the guns would reach.
    const cb = crewBears(P, side, tgt, shot);
    if (cb?.short) return { fired: false, reason: `she's ${Math.round(cb.d)} m off: the crew holds fire beyond ${crewRangeOf(shot)} m with ${shot} shot` };
    const sol = crewSolution({ pose: P, side, weapon: side === "bow" ? "chain" : "broadside", target: tgt, skill, rng: R.crew, ammo: shot });
    if (!sol) return { fired: false, reason: "she doesn't bear on that side" };
    if (shot === "chain") P.ammo.chain -= 1;
    P.reload[key] = 0;
    S.stats.crewVolleys++;
    m.fired++;
    const balls = planAimed({ pose: P, weapon, side, yaw: sol.yaw, elev: sol.elev }).slice(0, side === "bow" ? P.guns.bow.live : P.guns[side].live);
    return launch(balls, { side, weapon, ammo: shot, by, target: tgt, ...credit });
  }

  // ---- Crew modes (v3): hold | attack | defend ------------------------------------------------------

  /** Switch the crew's mode. Leaving defend stands down the jobs the mode started (orders stay). → {ok, prev} */
  function setCrewMode(mode, by = "captain") {
    if (!CREW_MODES.includes(mode)) return { ok: false, prev: S.crewMode.mode };
    const prev = S.crewMode.mode;
    S.crewMode = { mode, by, t: S.t, targets: {}, defendT: 0 };
    if (prev === "defend" && mode !== "defend") for (const kind of ["repair", "bail"]) if (S.jobs[kind]?.mode) endJob(kind, "stopped", "the crew mode changed");
    emit({ type: "crew_mode", mode, prev, by });
    return { ok: true, prev };
  }

  /** Is the Captain aiming this battery right now (RMB held on that side)? The attack crews leave it to them. */
  const captainHas = (side) => !!S.look.aiming && reloadKeyOf(S.weapon.weapon, S.weapon.side) === side;
  /** An enemy the attack crews shoot at unbidden: in sight, fighting us (or a mission target / a fort tower), not struck.
   *  A navy patrol minding its own business isn't one — mark her to make her one. */
  const fair = (e) => alive(e) && e.detected && !e.cloaked && e.state !== "surrender";
  const enemyOf = (e) => fair(e) && (e.fixed || e.provoked || e.objective || e.role === "hunter" || (e.hostile && ["approach", "broadside", "ram"].includes(e.state)));

  function attackStep() {
    const T = S.crewMode.targets;
    if (S.crewMode.mode !== "attack" || S.boarding) { for (const k of Object.keys(T)) delete T[k]; return; }
    const marked = S.marked ? shipById(S.marked) : null;
    for (const side of ["port", "starboard", "bow"]) {
      T[side] = null;
      if (S.manned[side]) continue;   // a man_guns order has this battery
      const weapon = side === "bow" ? "chain" : "broadside";
      // v4 §4: only what's inside the crew's effective range for round shot (the locked ship first); never the mortar.
      const inReach = (e) => { const b = crewBears(P, side, e, "round"); return !!b && !b.short; };
      let tgt = marked && fair(marked) && inReach(marked) ? marked : null;
      if (!tgt) {
        let best = null, bd = Infinity;
        for (const e of S.ships) {
          if (!enemyOf(e) || !inReach(e)) continue;
          const d = dist(P.x, P.z, e.x, e.z);
          if (d < bd) { bd = d; best = e; }
        }
        tgt = best;
      }
      if (!tgt) continue;
      T[side] = tgt.id;
      if (captainHas(side) || P.reload[side] < 1 || P.guns[side].live <= 0) continue;
      const sol = crewSolution({ pose: P, side, weapon, target: tgt, skill: CREW_AIM.skill[CREW_MODE.attackSkill], rng: R.crew, ammo: "round" });
      if (!sol) continue;
      P.reload[side] = 0;
      S.stats.crewVolleys++;
      const balls = planAimed({ pose: P, weapon, side, yaw: sol.yaw, elev: sol.elev }).slice(0, P.guns[side].live);
      launch(balls, { side, weapon, ammo: "round", by: "crew", target: tgt, who: "hands", orderedBy: S.crewMode.by });
    }
  }

  function defendStep(h) {
    if (S.crewMode.mode !== "defend" || S.boarding) return;
    S.crewMode.defendT -= h;
    if (S.crewMode.defendT > 0) return;
    S.crewMode.defendT = CREW_MODE.defendEvery;
    if (!S.jobs.repair && (P.fires > 0 || P.leaks > 0 || P.hull <= P.hullMax - CREW_MODE.defendHullGap || P.masts < CREW_MODE.defendMasts)) {
      startRepair("all", { by: "crew", why: "defend", mode: true });
    }
    if (!S.jobs.bail && P.water >= CREW_MODE.defendWater) startBail({ by: "crew", why: "defend", mode: true });
  }

  // ---- Contributions (v3 C10): what the crew did, as counters and pops ---------------------------------

  const whoLabel = (who) => (who === "hands" || !who ? "the hands" : S.names?.[who] || NAMED_LABEL[who] || who);
  /** The companion's best moment: the highest-scoring thing done on their order. */
  function moment(by, kind, text, score) {
    if (by !== "companion") return;
    const b = S.contrib.best;
    if (!b || score > b.score) S.contrib.best = { kind, text, t: ROUND(S.t), score: Math.round(score) };
  }
  /** A crew ball has landed (hit or miss): when the volley's last one is down, count it and pop it. */
  function volleyBall(p, dmg = 0, ship = null) {
    const v = p.vid ? S.crewVolleys[p.vid] : null;
    if (!v) return;
    if (dmg > 0) { v.dmg += dmg; v.hits++; if (ship) { v.x = ship.x; v.z = ship.z; v.target = ship.id; } }
    if (ship && (ship.state === "sinking" || ship.down) && !v.sunk) v.sunk = ship.name;
    if (--v.left <= 0) finishVolley(p.vid);
  }
  function finishVolley(vid) {
    const v = S.crewVolleys[vid];
    if (!v) return;
    delete S.crewVolleys[vid];
    const G = S.contrib.guns;
    G.volleys++;
    if (!v.hits) return;
    const n = Math.round(v.dmg);
    G.damage += v.dmg; G.hits += v.hits; G.by[v.who] = Math.round(((G.by[v.who] || 0) + v.dmg) * 10) / 10;
    if (v.sunk) G.sunk++;
    const tn = v.target ? shipById(v.target)?.name : null;
    const label = v.who === "hands" ? "gun crews" : `${whoLabel(v.who)}'s guns`;
    emit({ type: "contrib", kind: "guns", who: v.who, by: v.by, amount: n, text: `+${n} ${label}`, x: ROUND(v.x), z: ROUND(v.z), target: v.target });
    moment(v.by, "guns", v.sunk ? `${v.who === "hands" ? "The gun crews" : `${whoLabel(v.who)}'s guns`} sank ${v.sunk}` : `${v.who === "hands" ? "The gun crews" : `${whoLabel(v.who)}'s guns`} put ${n} into ${tn || "her"}`, n + (v.sunk ? 60 : 0));
  }
  /** Repairs and pumping pop in batches (every CONTRIB.batchS s, and when the job ends). */
  function pend(kind, who, by, amount) {
    const k = `${kind}:${who}`;
    const p = S.contribPending[k] || (S.contribPending[k] = { kind, who, by, amount: 0, t0: S.t });
    p.amount += amount; p.by = by;
  }
  function flushPending(force = false, kindOnly = null) {
    for (const [k, p] of Object.entries(S.contribPending)) {
      if (kindOnly && p.kind !== kindOnly) continue;
      if (!force && S.t - p.t0 < CONTRIB.batchS) continue;
      delete S.contribPending[k];
      const n = Math.round(p.amount);
      if (n < 1) continue;
      const text = p.kind === "hull" ? `+${n} hull ${whoLabel(p.who)}` : `−${n} water ${whoLabel(p.who)}`;
      emit({ type: "contrib", kind: p.kind, who: p.who, by: p.by, amount: n, text, x: ROUND(P.x), z: ROUND(P.z) });
    }
  }
  const jobCredit = (kind) => { const j = crew.jobOf(kind); return j?.who.find((w) => crew.present(w) && crew.atOf(w) === j.station) || j?.who[0] || "hands"; };
  const jobBy = (j) => (j?.mode ? S.crewMode.by : j?.by);

  /** "Fire!": every once/hold battery whose target is in its arc fires now. */
  function fireManned(sides = null, by = "voice") {
    const res = [];
    const list = sides && sides.length ? sides : Object.keys(S.manned).filter((s) => ["once", "hold"].includes(S.manned[s].mode));
    for (const side of list) {
      const m = S.manned[side];
      if (!m) { res.push({ side, fired: false, reason: "nobody's on those guns" }); continue; }
      if (!["once", "hold"].includes(m.mode)) { res.push({ side, fired: false, reason: `on ${m.mode.replace(/_/g, " ")}` }); continue; }
      const r = crewFire(side, by);
      res.push({ side, ...r });
      if (r.fired && m.mode === "once") finishManned(side, "fired");
    }
    return res;
  }

  function finishManned(side, why) {
    const m = S.manned[side];
    if (!m) return;
    emit({ type: "order_done", kind: "man_guns", side, target: m.target, why, mode: m.mode });
    standDown(side, why, "done");
  }

  function mannedStep(h) {
    for (const side of Object.keys(S.manned)) {
      const m = S.manned[side];
      if (m.target === "kraken") {
        const K = S.hazards.kraken;
        if (!K || K.stage !== "grab") { m.status = "waiting"; continue; }
        const arms = K.arms.filter((a) => a.hp > 0 && (side === "bow" || side === "mortar" || a.side === side));
        if (!arms.length) { m.status = "waiting"; continue; }
        const job = crew.jobOf("guns", side);
        if (job?.who.length && !job.who.some((w) => crew.present(w) && crew.atOf(w) === job.station)) { m.status = "walking"; continue; }
        m.status = "repelling";
        armDamage(arms[0], KRAKEN.crewDps * h, "crew", { who: job?.who.find((w) => crew.present(w)) || "hands", by: m.by });
        continue;
      }
      const tgt = mannedTarget(m);
      if (!tgt || tgt.gone || tgt.state === "sinking" || tgt.down || tgt.state === "surrender") {
        const why = !tgt || tgt.gone ? "she's gone" : tgt.state === "sinking" || tgt.down ? "she's going down" : "she struck her colours";
        emit({ type: "order_done", kind: "man_guns", side, target: m.target, why, mode: m.mode });
        standDown(side, why, "done");
        continue;
      }
      const key = side;
      const shot = side === "mortar" ? "mortar" : m.ammo === "chain" && (P.ammo.chain ?? 0) < 1 ? "round" : m.ammo;
      const brs = side === "mortar" ? batteryBears(P, "mortar", tgt) : crewBears(P, side, tgt, shot);
      // v4 §4: "range" — she's in the guns' arc but beyond the crew's effective range: they wait for her to close.
      m.status = brs?.short ? "range" : brs ? (P.reload[key] >= 1 ? "laid" : "loading") : "waiting";
      if (!brs || brs.short || P.reload[key] < 1 || m.mode === "hold") continue;
      // The gun captain waits a beat for a steady sea: fires when she bears and the crew has her.
      const job = crew.jobOf("guns", side);
      if (job && job.who.length && !job.who.some((w) => crew.present(w) && crew.atOf(w) === job.station)) { m.status = "walking"; continue; }
      const r = crewFire(side, "crew");
      if (r.fired && m.mode === "once") finishManned(side, "fired");
    }
  }

  // ---- Jobs: repair and bail ---------------------------------------------------------------------

  function startRepair(what = "all", { who = null, by = "companion", why = "", mode = false } = {}) {
    const r = crew.startJob("repair", { who, by, why, t: S.t, quiet: mode });
    if (!r.ok) return r;
    const want = what === "hull" || what === "all" ? Math.min(REPAIR.hullAmount, P.hullMax - P.hull) : 0;
    S.jobs.repair = { id: r.job.id, what, hullLeft: want, hullTotal: Math.max(1, want), mastsLeft: what === "masts" || what === "all" ? Math.min(REPAIR.mastsAmount, 100 - P.masts) : 0,
      firesAt: P.fires, leaksAt: P.leaks, leakT: 0, fireT: 0, t: S.t, by, why, mode, hullAt: P.hull, repaired: 0 };
    r.job.what = what; r.job.mode = mode;
    emit({ type: "job", id: r.job.id, kind: "repair", what, stage: "start", who: r.who, auto: mode });
    return { ok: true, text: r.text, who: r.who };
  }
  function startBail({ who = null, by = "companion", why = "", mode = false } = {}) {
    const r = crew.startJob("bail", { who, by, why, t: S.t, quiet: mode });
    if (!r.ok) return r;
    S.jobs.bail = { id: r.job.id, from: P.water, t: S.t, by, why, mode, bailed: 0 };
    r.job.mode = mode;
    emit({ type: "job", id: r.job.id, kind: "bail", stage: "start", who: r.who, auto: mode });
    return { ok: true, text: r.text, who: r.who };
  }
  function endJob(kind, stage = "done", why = "") {
    const j = S.jobs[kind];
    if (!j) return false;
    flushPending(true, kind === "repair" ? "hull" : "water");
    const who = jobCredit(kind), by = jobBy(j);
    if (kind === "repair" && j.repaired >= 1) moment(by, "repair", `${whoLabel(who)} patched ${Math.round(j.repaired)} hull${j.hullAt < 40 ? ` with the hull at ${Math.round(j.hullAt)}%` : ""}`, j.repaired * (j.hullAt < 40 ? 2 : 1));
    if (kind === "bail" && j.bailed >= 1) moment(by, "bail", `${whoLabel(who)} pumped out ${Math.round(j.bailed)}% water${j.from >= 50 ? ` from ${Math.round(j.from)}%` : ""}`, j.bailed * (j.from >= 50 ? 1.6 : 0.8));
    delete S.jobs[kind];
    const job = crew.endJob(j.id, { t: S.t });
    emit({ type: "job", id: j.id, kind, stage, what: j.what, who: job?.who || [], why, auto: !!j.mode });
    if (stage === "done") emit({ type: "order_done", kind, what: j.what, why: why || "done", auto: !!j.mode });
    return true;
  }
  /** Progress 0..1 of a job. */
  function jobProgress(kind) {
    const j = S.jobs[kind];
    if (!j) return null;
    if (kind === "bail") return j.from > 0 ? clamp(1 - P.water / j.from, 0, 1) : 1;
    const parts = [];
    if (j.what === "fires" || j.what === "all") parts.push(j.firesAt ? 1 - P.fires / j.firesAt : 1);
    if (j.what === "leaks" || j.what === "all") parts.push(j.leaksAt ? 1 - P.leaks / j.leaksAt : 1);
    if (j.what === "hull" || j.what === "all") parts.push(1 - j.hullLeft / j.hullTotal);
    if (j.what === "masts" || j.what === "all") parts.push(j.mastsLeft > 0 ? 0 : 1);
    return clamp(parts.reduce((a, b) => a + b, 0) / Math.max(1, parts.length), 0, 1);
  }

  function jobsStep(h) {
    const rep = S.jobs.repair;
    if (rep) {
      const k = crew.workMul("repair");
      let done = false;
      const doFires = rep.what === "fires" || rep.what === "all", doLeaks = rep.what === "leaks" || rep.what === "all";
      const who = jobCredit("repair"), by = jobBy(rep);
      if (doFires && P.fires > 0) {
        rep.fireT += h * k;
        if (rep.fireT >= REPAIR.fireS) {
          rep.fireT = 0; P.fires--; P.fireAges.shift(); S.contrib.firesOut++;
          emit({ type: "fire", target: "rexmaw", x: ROUND(P.x), z: ROUND(P.z), stage: "out", count: P.fires });
          emit({ type: "contrib", kind: "fire", who, by, amount: 1, text: `Fire out · ${whoLabel(who)}`, x: ROUND(P.x), z: ROUND(P.z) });
          moment(by, "fire", `${whoLabel(who)} put out a fire`, 8);
        }
      } else if (doLeaks && P.leaks > 0) {
        rep.leakT += h * k;
        if (rep.leakT >= REPAIR.leakS) {
          rep.leakT = 0; P.leaks--; S.contrib.leaksPatched++;
          emit({ type: "leak", target: "rexmaw", stage: "patched", count: P.leaks });
          emit({ type: "contrib", kind: "leak", who, by, amount: 1, text: `Leak patched · ${whoLabel(who)}`, x: ROUND(P.x), z: ROUND(P.z) });
          moment(by, "leak", `${whoLabel(who)} patched a leak`, 6);
        }
      } else if ((rep.what === "hull" || rep.what === "all") && rep.hullLeft > 0 && P.hull < P.hullMax) {
        const dh = Math.min(rep.hullLeft, REPAIR.hullPerS * k * h, P.hullMax - P.hull);
        P.hull += dh; rep.hullLeft -= dh; S.stats.hullRepaired += dh;
        rep.repaired += dh; S.contrib.hullRepaired += dh;
        pend("hull", who, by, dh);
      } else if ((rep.what === "masts" || rep.what === "all") && rep.mastsLeft > 0 && P.masts < 100) {
        const dm = Math.min(rep.mastsLeft, REPAIR.mastsPerS * k * h, 100 - P.masts);
        P.masts += dm; rep.mastsLeft -= dm;
      } else done = true;
      if (rep.what === "hull" && P.hull >= P.hullMax) done = true;
      if (done) { S.stats.repairs++; endJob("repair", "done"); }
    }
    const bail = S.jobs.bail;
    if (bail) {
      const w0 = P.water;
      P.water = Math.max(0, P.water - BILGE.bail * crew.workMul("bail") * h);
      const dw = w0 - P.water;
      if (dw > 0) { bail.bailed += dw; S.contrib.waterBailed += dw; pend("water", jobCredit("bail"), jobBy(bail), dw); }
      if (P.water <= 0 && P.leaks === 0) endJob("bail", "done", "she's dry");
      else if (P.water <= 0 && S.t - bail.t > 20) endJob("bail", "done", "she's dry (the leaks still need patching)");
    }
  }

  // ---- Enemy guns ----------------------------------------------------------------------------------

  function enemyVolley(e, side) {
    const B = e.batteries[side];
    const crewF = e.crewMax ? e.crew / e.crewMax : 1;
    const ammo = "round";   // v5: the Gloam's point-blank heavy broadside (up to 60 in a volley) is gone: round shot like the rest
    const skill = e.C.skill * (0.7 + 0.3 * crewF);
    const sea = (inStorm(e.x, e.z) ? 0.3 : 0) + (pw ? pw.inkSpread() : 0);   // v4.2: Kraken Ink scatters their aim
    const balls = enemyBalls({ shooter: e, side, target: P, skill, sea, rng: R.guns, guns: B.guns });
    for (const b of balls) S.projectiles.push({ id: `b${++pid}`, from: e.id, side, ammo, b, t0: S.t + (b.delay || 0), tau: 0, target: "rexmaw" });
    B.loaded = 0; e.firingT = 0.3;
    e.ports[side].open = false;
    fought();
    const raking = isRaking(e.x, e.z, P);
    emit({ type: "volley", side, by: e.fixed ? `tower:${e.id}` : e.id, weapon: "broadside", ammo, target: "rexmaw", balls: balls.length, raking });
    emit({ type: "ports", id: e.id, side, open: false });
  }

  // ---- Projectiles ------------------------------------------------------------------------------------

  function projectileStep() {
    const keep = [];
    for (const p of S.projectiles) {
      const tau = S.t - p.t0;
      if (tau < 0) { keep.push(p); continue; }
      if (p.ammo === "mortar") {
        if (tau < p.b.T) { keep.push(p); continue; }
        mortarLand(p);
        continue;
      }
      const targets = p.from === "rexmaw" ? S.ships : [P, ...S.ships];
      const tr = traceBall(p.b, targets, { from: p.from, ammo: p.ammo, tau0: p.tau, tau1: Math.min(tau, p.b.T) });
      p.tau = Math.min(tau, p.b.T) + BALLISTIC.fine;
      if (tr.ship) { hit(p, tr.ship, tr); continue; }
      if (tau >= p.b.T) {
        // v4: a ball of ours splashing beside a lone Kraken arm hits it.
        if (p.from === "rexmaw" && eyeSplash(p.b.x1, p.b.z1, p.ammo)) { volleyBall(p); continue; }   // v5: the Kraken's eye
        if (p.from === "rexmaw" && sea?.splash(p.b.x1, p.b.z1, p.ammo)) { volleyBall(p); continue; }
        emit({ type: "impact", target: null, x: ROUND(p.b.x1), y: 0, z: ROUND(p.b.z1), dmg: 0, kind: "splash", ammo: p.ammo, from: p.from }); volleyBall(p); continue;
      }
      keep.push(p);
    }
    S.projectiles = keep;
    // Our mortar rings count down with the shells and shrink onto the splash.
    S.hazards.mortars = S.hazards.mortars.filter((m) => {
      if (m.from !== "rexmaw") return true;
      m.eta -= STEP_H;
      m.r = WEAPONS.mortar.ring * (0.45 + 0.55 * clamp(m.eta / m.total, 0, 1));
      return m.eta > -0.4;
    });
  }
  let STEP_H = 1 / 30;

  function hit(p, ship, tr) {
    const raking = isRaking(p.b.x0, p.b.z0, ship);
    if (ship === P) damagePlayer(p, raking, tr);
    else volleyBall(p, damageEnemy(ship, p, raking, tr), ship);
  }

  function mortarLand(p) {
    const x = p.b.x1, z = p.b.z1, r = AMMO.mortar.blast;
    let any = false, dealt = 0, last = null;
    if (p.from !== "rexmaw" && dist(x, z, P.x, P.z) < SHIP.half + r) {
      const l = toLocal(P.x, P.z, P.heading, x, z);
      if (Math.abs(l.lz) < SHIP.length / 2 + r && Math.abs(l.lx) < SHIP.beam / 2 + r) { damagePlayer(p, false, { x, y: 1, z }); any = true; }
    }
    for (const e of S.ships) {
      if (!alive(e) || e.id === p.from) continue;
      const { hl, hb } = hullAxes(e);
      if (e.fixed ? dist(x, z, e.x, e.z) <= (e.r || FORT.towerR) + r : (() => { const l = toLocal(e.x, e.z, e.heading, x, z); const a = l.lz / (hl + r), b = l.lx / (hb + r); return a * a + b * b <= 1; })()) {
        dealt += damageEnemy(e, p, false, { x, y: 1, z }) || 0; last = e;
        any = true;
      }
    }
    if (!any && p.from === "rexmaw" && eyeSplash(x, z, "mortar", r)) any = true;   // v5: the Kraken's eye
    if (!any && !(p.from === "rexmaw" && sea?.splash(x, z, "mortar"))) emit({ type: "impact", target: null, x: ROUND(x), y: 0, z: ROUND(z), dmg: 0, kind: "splash", ammo: "mortar", from: p.from });
    volleyBall(p, dealt, last);
  }

  function damagePlayer(p, raking, tr) {
    if (S.boarding) { emit({ type: "impact", target: "rexmaw", x: ROUND(tr.x), y: 2, z: ROUND(tr.z), dmg: 0, kind: "hull", ammo: p.ammo, cancelled: true }); return; }
    const d = ballDamage(p.ammo, { raking });
    let mul = 1, perfect = false;
    if (P.braceT > 0) { perfect = S.t - P.braceStart <= BRACE.perfect; mul = perfect ? BRACE.perfectMul : BRACE.mul; notePerfect(perfect); }
    const l = toLocal(P.x, P.z, P.heading, tr.x, tr.z);
    const side = l.lz > SHIP.length * 0.42 ? "bow" : l.lx > 0 ? "port" : "starboard";
    const iron = pw ? pw.damageMul() : 1;   // v4.2: Iron Hull
    const hull = d.hull * mul * iron, masts = d.masts * mul * iron;
    P.hull = Math.max(0, P.hull - hull);
    P.masts = Math.max(0, P.masts - masts);
    S.stats.damageTaken += hull;
    let kind = masts > hull ? "mast" : "hull";
    if (!perfect && d.kill > 0 && R.dmg.chance(d.kill * mul)) { killHands(1); kind = "crew"; }
    if (d.leak > 0 && R.dmg.chance(d.leak * mul)) { startLeak(); kind = "water"; }
    if (d.fire > 0 && R.dmg.chance(d.fire * mul)) startFire(tr.x, tr.z);
    if (d.gun > 0 && R.dmg.chance(d.gun * mul) && P.guns[side].live > 0 && P.guns[side].live > (side === "bow" ? 1 : 3)) { P.guns[side].live--; emit({ type: "gun_down", side }); }
    P.morale = Math.max(0, P.morale - 0.4);
    emit({ type: "impact", target: "rexmaw", x: ROUND(tr.x), y: ROUND(tr.y ?? 2), z: ROUND(tr.z), dmg: ROUND(hull + masts), kind, ammo: p.ammo, raking, braced: mul < 1, perfect, from: p.from });
  }

  function damageEnemy(e, p, raking, tr) {
    const d = ballDamage(p.ammo, { raking });
    if (e.fixed) {
      const dmg = d.hull * (FORT.dmgMul[p.ammo] ?? 0.3);
      e.hull = Math.max(0, e.hull - dmg);
      if (p.from === "rexmaw") { S.stats.ballsHit++; S.stats.damageDealt += dmg; e.lastHitByRexmawT = S.t; }
      emit({ type: "impact", target: e.id, x: ROUND(tr.x), y: ROUND(tr.y ?? 4), z: ROUND(tr.z), dmg: ROUND(dmg), kind: "hull", ammo: p.ammo, from: p.from });
      if (e.hull <= 0 && !e.down) towerDown(e);
      return dmg;
    }
    e.hull -= d.hull;
    e.masts = Math.max(0, e.masts - d.masts);
    let killed = 0;
    if (d.kill > 0 && R.dmg.chance(d.kill)) killed++;
    if (p.ammo === "mortar" || p.ammo === "heavy") killed += R.dmg.int(0, 2);
    if (p.ammo === "heavy") e.lastGrapeT = S.t;   // boarding preparation: her deck's been swept
    e.crew = Math.max(0, e.crew - killed);
    if (d.leak > 0 && R.dmg.chance(d.leak)) e.hull -= 2;
    if ((d.fire > 0 && R.dmg.chance(d.fire)) || (p.hot && e.fires < PU_FIRES)) { e.fires++; emit({ type: "fire", target: e.id, x: ROUND(e.x), z: ROUND(e.z), stage: "start" }); }
    const l = toLocal(e.x, e.z, e.heading, tr.x, tr.z);
    const side = l.lx > 0 ? "port" : "starboard";
    if (d.gun > 0 && R.dmg.chance(d.gun) && e.batteries[side].guns > 1) e.batteries[side].guns--;
    e.hits++;
    if (p.from === "rexmaw") {
      S.stats.ballsHit++; S.stats.damageDealt += d.hull;
      e.lastHitByRexmawT = S.t;
      provoke(e);
    }
    if (e.hits >= WEAK.hits && !e.weakN) {
      e.weakN = WEAK.points;
      const { len, beam } = e.C;
      for (let i = 0; i < WEAK.points; i++) {
        e.weakPoints.push({ id: `${e.id}w${i + 1}`, local: { x: ROUND((R.dmg.chance(0.5) ? 1 : -1) * beam / 2), y: ROUND(R.dmg.range(1.5, 4)), z: ROUND(R.dmg.range(-0.4, 0.4) * len) } });
      }
      emit({ type: "weak", id: e.id, n: e.weakPoints.length });
    }
    emit({ type: "impact", target: e.id, x: ROUND(tr.x), y: ROUND(tr.y ?? 2), z: ROUND(tr.z), dmg: ROUND(d.hull + d.masts), kind: d.masts > d.hull ? "mast" : "hull",
      ammo: p.ammo, raking, from: p.from, killed });
    if (e.hull <= 0) sinkEnemy(e, "gunfire", p.from === "rexmaw" || e.lastHitByRexmawT > S.t - 30);
    return d.hull;
  }

  function towerDown(e) {
    e.down = true; e.state = "down"; e.ai = "silenced"; e.portsOpen = false;
    S.stats.sunk.push({ id: e.id, name: e.name, cls: "tower", cause: "silenced", t: ROUND(S.t) });
    addHeat(HEAT.byClass.tower, `silenced the ${e.name}`);
    spill(e, e.loot);
    // v5: the beat. The other towers' gunners duck (reload set back FORT.pauseS, ports shut) — a breather to line up the next.
    const standing = S.ships.filter((t) => t.fixed && !t.down && !t.gone);
    for (const t of standing) {
      t.reloadT = Math.max(t.reloadT, (FORT.pauseS + AI.telegraph) * tele());
      if (t.ports.port.open) { t.ports.port.open = false; t.portsOpen = false; emit({ type: "ports", id: t.id, side: "port", open: false }); }
    }
    emit({ type: "sink", id: e.id, cause: "silenced", cls: "tower", name: e.name, ours: true, loot: e.loot, left: standing.length, magazine: !!e.magazine });
    // The magazine goes up: a blast that shakes the towers beside it.
    if (e.magazine) {
      emit({ type: "hazard", kind: "blast", stage: "explode", id: e.id, x: ROUND(e.x), z: ROUND(e.z), r: FORT.magazine.r, magazine: true });
      emit({ type: "impact", target: e.id, x: ROUND(e.x), y: 8, z: ROUND(e.z), dmg: 0, kind: "explosion", ammo: "magazine", from: "rexmaw" });   // the scene's explosion
      for (const t of standing) {
        if (t.down || dist(t.x, t.z, e.x, e.z) > FORT.magazine.r) continue;
        t.hull = Math.max(0, t.hull - FORT.magazine.dmg);
        emit({ type: "impact", target: t.id, x: ROUND(t.x), y: 6, z: ROUND(t.z), dmg: FORT.magazine.dmg, kind: "explosion", ammo: "magazine", from: "rexmaw" });
        if (t.hull <= 0) towerDown(t);
      }
    }
  }

  /** The Rexmaw fights her: she and (for a convoy) her friends turn on us; merchants run. */
  function provoke(e) {
    if (!e || e.fixed || e.derelict) return;
    e.provoked = true;
    if (["convoy", "escort", "objective"].includes(e.role)) for (const o of S.ships) if (["convoy", "escort", "objective"].includes(o.role) && !o.gone) o.provoked = true;
    for (const o of S.ships) if (o.C?.navy && !o.gone && !o.fixed && o.state === "patrol" && !o.lantern && dist(o.x, o.z, e.x, e.z) < 600) o.provoked = true;
  }

  /** A sunk ship's cargo floats: flotsam around where she went down. */
  function spill(e, value) {
    const n = R.loot.int(PICKUP.flotsamN[0], PICKUP.flotsamN[1]);
    const gold = Math.round((value * PICKUP.sinkLoot) / Math.max(1, n - 1) / 5) * 5;
    for (let i = 0; i < n; i++) {
      const a = R.loot.range(0, Math.PI * 2), r = R.loot.range(4, 22);
      const kind = i === 0 ? "crate" : i === 1 && n > 3 ? "barrel" : "flotsam";
      const p = { id: `fl_${e.id}_${i + 1}`, kind: kind === "flotsam" ? "flotsam" : kind, flotsam: true, x: e.x + Math.cos(a) * r, z: e.z + Math.sin(a) * r,
        value: kind === "barrel" ? PICKUP.barrelHull : kind === "crate" ? PICKUP.crateGold : gold, age: 0, from: e.id, vx: Math.cos(a) * PICKUP.drift, vz: Math.sin(a) * PICKUP.drift };
      if (!e.fixed) S.pickups.push(p);
      else if (kind !== "barrel") S.pickups.push({ ...p, x: e.x + (P.x - e.x) * 0.15 + Math.cos(a) * r, z: e.z + (P.z - e.z) * 0.15 + Math.sin(a) * r });
    }
  }

  /** v4 §3: the sinkings that get the camera's cinematic — the big ships and the mission's prize / chest ship. */
  const VARIANT = world.variant || {};
  const prizeIds = new Set([VARIANT.prize, VARIANT.goal === "chest" ? VARIANT.chest : null].filter(Boolean));
  const cinematicOf = (e) => CINEMATIC_CLASSES.includes(e.cls) || prizeIds.has(e.id);
  /** Did the Rexmaw put her down? Only with a hit of ours in the last `s` seconds (v4: no credit for a far-off sinking long after). */
  const ourKill = (e, s = 30) => (e.lastHitByRexmawT ?? -1e9) > S.t - s;

  function sinkEnemy(e, cause, ours = true, extra = {}) {
    if (e.state === "sinking" || e.gone) return;
    e.state = "sinking"; e.ai = cause; e.sinkT = 0; e.hull = Math.min(e.hull, 0);
    if (e.cls === "fireship") { cause = "explode"; e.ai = cause; blast(e); }
    if (e.loot > 0) spill(e, e.loot);
    for (const side of Object.keys(S.manned)) if (S.manned[side].target === e.id) { /* mannedStep reports it */ }
    if (ours && !e.derelict) {
      S.stats.sunk.push({ id: e.id, name: e.name, cls: e.cls, cause, t: ROUND(S.t) });
      if (cause === "maelstrom") S.stats.maelstromKills++;
      addHeat(HEAT.byClass[e.cls] ?? 0, `sank ${e.name}`);
    }
    emit({ type: "sink", id: e.id, cause, cls: e.cls, name: e.name, ours: ours && !e.derelict, loot: e.loot, cinematic: cinematicOf(e), ...extra });
  }

  /** A fire ship goes up. */
  function blast(e) {
    const C = e.C;
    const d = dist(e.x, e.z, P.x, P.z);
    emit({ type: "hazard", kind: "blast", stage: "explode", id: e.id, x: ROUND(e.x), z: ROUND(e.z), r: C.blastR });
    emit({ type: "impact", target: d < C.blastR + SHIP.half ? "rexmaw" : null, x: ROUND(e.x), y: 2, z: ROUND(e.z), dmg: 0, kind: "explosion", ammo: "fireship", from: e.id });
    if (d < C.blastR + SHIP.half) {
      const r = hurtPlayer(C.blast, { cause: "fireship", x: e.x, z: e.z });
      if (!r.cancelled && !r.perfect) { startFire(); startFire(); }
    }
    for (const o of S.ships) {
      if (o === e || !alive(o) || o.fixed) continue;
      if (dist(e.x, e.z, o.x, o.z) < C.blastR + o.C.len / 2) { o.hull -= C.blast; o.fires += 2; if (o.hull <= 0) sinkEnemy(o, "blast", ourKill(o) || ourKill(e)); }
    }
  }

  // ---- Ships: AI, motion, collisions, lanterns ---------------------------------------------------------

  function shipsStep(h) {
    const exit = world.exit && world.mission !== "smugglers_run" ? world.exit : null;
    const ctx = { t: S.t, player: P, heat: S.heat, tele: tele(), rng: R.ai, world, isWater, dt: h, playerHullF: P.hull / P.hullMax, windFrom: S.wind.dirDeg, exit };
    for (const e of S.ships) {
      if (e.gone) continue;
      if (e.fixed) { towerStep(e, h); continue; }
      if (e.state === "sinking") {
        e.sinkT += h;
        moveShip(e, h, { windF: 1 });
        if (e.sinkT >= SINK_S) e.gone = true;
        continue;
      }
      if (S.boarding?.enemyId === e.id) { e.speed = 0; e.vx = 0; e.vz = 0; continue; }
      if (e.boardLockT > 0) e.boardLockT -= h;
      if (e.lantern) lanternStep(e, h);
      const res = aiStep(e, ctx);
      if (res.surrender) { emit({ type: "surrender", id: e.id, name: e.name, cls: e.cls }); e.ports.port.open = false; e.ports.starboard.open = false; }
      if (res.open) emit({ type: "ports", id: e.id, side: res.open, open: true });
      if (res.close) emit({ type: "ports", id: e.id, side: res.close, open: false });
      if (res.fire && !S.boarding) enemyVolley(e, res.fire);
      if (res.mortar) enemyMortar(e);
      if (res.lit) emit({ type: "hazard", kind: "fireship", stage: "lit", id: e.id, x: ROUND(e.x), z: ROUND(e.z), eta: ROUND(e.C.lightS * tele()) });
      // v5: a boss's ram run is told as it starts (eta: s to contact at her speed and ours).
      if (res.ramRun) {
        const d = dist(e.x, e.z, P.x, P.z);
        emit({ type: "hazard", kind: "ram", stage: "telegraph", id: e.id, by: e.id, x: ROUND(e.x), z: ROUND(e.z), eta: ROUND(d / Math.max(6, e.C.speed + P.speed * 0.5)) });
      }
      if (res.burnout) sinkEnemy(e, "explode", false);
      if (res.board && !S.boarding) emit({ type: "board_attempt", id: e.id });
      const crewF = e.crewMax ? e.crew / e.crewMax : 1;
      for (const side of ["port", "starboard", "bow"]) {
        const B = e.batteries[side];
        if (B.guns > 0 && B.loaded < 1) B.loaded = Math.min(1, B.loaded + h / (e.C.reload * (1 + (1 - crewF) * 1.2)));
      }
      e.firingT = Math.max(0, (e.firingT || 0) - h);
      if (e.fires > 0) {
        e.hull -= FIRE.hullPerS * 1.2 * e.fires * h;
        e.fireT += h;
        if (e.fireT >= FIRE.enemyOutEvery) { e.fireT = 0; e.fires--; emit({ type: "fire", target: e.id, x: ROUND(e.x), z: ROUND(e.z), stage: "out" }); }
        if (e.hull <= 0) { sinkEnemy(e, "fire", ourKill(e, 60)); continue; }   // a fire we started (barrels set the hit time too)
      }
      moveShip(e, h, { windF: e.cls === "gunboat" || e.cls === "gloam" ? 1 : windFactor(e.heading) * (0.85 + 0.15 * S.wind.strength), drift: seaDrift(e.x, e.z) });   // v5: the Gloam minds no wind
      collideLand(e, h, false);
      const M = world.maelstrom;
      if (M && dist(e.x, e.z, M.x, M.z) < M.eye) { sinkEnemy(e, "maelstrom", ourKill(e)); continue; }
      if (exit && !e.escaped && (e.role === "objective" || e.role === "convoy" || e.role === "escort") && dist(e.x, e.z, exit.x, exit.z) < exit.r) e.escaped = true;
      if (e.escaped) {
        e.gone = true;
        S.stats.escaped.push({ id: e.id, name: e.name, cls: e.cls });
        emit({ type: "escaped", id: e.id, name: e.name, cls: e.cls });
      }
      if (e.cls === "fireship" && e.lit && dist(e.x, e.z, P.x, P.z) < e.C.len / 2 + SHIP.half + 4) sinkEnemy(e, "explode", false);
    }
    const all = [P, ...S.ships.filter((e) => !e.gone && e.state !== "sinking" && !e.fixed)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) collideShips(all[i], all[j]);
    S.ships = S.ships.filter((e) => !e.gone || e.keep);
  }

  /** A fort tower: reloads, telegraphs, fires two guns at the Rexmaw inside its range. */
  function towerStep(e, h) {
    if (e.down) return;
    const d = dist(e.x, e.z, P.x, P.z);
    if (d > FORT.range) { e.reloadT = Math.max(e.reloadT, 2.2 * tele()); if (e.ports.port.open) { e.ports.port.open = false; emit({ type: "ports", id: e.id, side: "port", open: false }); } return; }
    e.reloadT -= h;
    if (!e.ports.port.open && e.reloadT <= 2.2 * tele()) { e.ports.port.open = true; emit({ type: "ports", id: e.id, side: "port", open: true }); }
    e.portsOpen = e.ports.port.open;
    if (e.reloadT > 0 || S.boarding) return;
    e.reloadT = FORT.reload;
    enemyVolley(e, "port");
    e.portsOpen = false;
  }

  /** A patrol's lantern sweeps; the Rexmaw in its beam (or very close) fills the alert meter; full = spotted. */
  function lanternStep(e, h) {
    const L = e.lantern;
    L.phase += h * LANTERN.sweepRate;
    L.yaw = wrap360(e.heading + LANTERN.sweep * Math.sin(L.phase));
    const fogMul = 1 - (1 - LANTERN.fogMul) * fogAt(e.x, e.z);
    L.range = LANTERN.range * fogMul;
    if (e.state !== "patrol" && e.spotted) {
      // Chasing: lose us when we're far and dark for a while.
      const d = dist(e.x, e.z, P.x, P.z);
      e.lostT = d > LANTERN.loseR ? e.lostT + h : 0;
      if (e.lostT >= LANTERN.loseS) {
        e.spotted = false; e.provoked = false; e.state = "patrol"; e.ai = "beat"; e.alert = 0; e.lostT = 0;
        emit({ type: "spotted", id: e.id, stage: "lost" });
      }
      return;
    }
    const d = dist(e.x, e.z, P.x, P.z);
    const off = Math.abs(wrap180(headingOf(P.x - e.x, P.z - e.z) - L.yaw));
    const ang = Math.atan2(SHIP.length / 2, Math.max(1, d)) * 180 / Math.PI;
    let fill = 0;
    if (d <= L.range && off <= L.half + ang) fill = 1 / LANTERN.fill;
    if (d <= LANTERN.nearR) fill = Math.max(fill, 1 / LANTERN.nearFill);
    const was = e.alert;
    e.alert = clamp(e.alert + (fill > 0 ? fill * h : -h / LANTERN.decay), 0, 1);
    if (was === 0 && e.alert > 0) emit({ type: "spotted", id: e.id, stage: "alert" });
    if (e.alert >= 1) spotted(e);
  }

  function spotted(e) {
    if (e.spotted) return;
    S.stats.spotted++;
    for (const o of S.ships) {
      if (!o.lantern || o.gone || o.state === "sinking" || o.spotted) continue;
      if (o !== e && dist(o.x, o.z, e.x, e.z) > LANTERN.callR) continue;
      o.spotted = true; o.provoked = true; o.alert = 1; o.state = "approach"; o.ai = "chase"; o.lostT = 0;
      emit({ type: "spotted", id: o.id, stage: "spotted" });
    }
  }

  const ramCd = new Map();
  function collideShips(a, b) {
    const ha = a === P ? SHIP.half : a.C.len / 2 - 2, hb = b === P ? SHIP.half : b.C.len / 2 - 2;
    const ra = a === P ? SHIP.radius : a.C.beam / 2, rb = b === P ? SHIP.radius : b.C.beam / 2;
    if (dist(a.x, a.z, b.x, b.z) > ha + hb + ra + rb) return;
    const fa = forward(a.heading), fb = forward(b.heading);
    let best = null;
    for (const ka of [1, 0.5, 0, -0.5, -1]) for (const kb of [1, 0.5, 0, -0.5, -1]) {
      const ax = a.x + fa.x * ha * ka, az = a.z + fa.z * ha * ka, bx = b.x + fb.x * hb * kb, bz = b.z + fb.z * hb * kb;
      const d = dist(ax, az, bx, bz);
      if (d < ra + rb && (!best || d < best.d)) best = { d, ax, az, bx, bz, ka, kb };
    }
    if (!best) return;
    const nx = (best.ax - best.bx) / (best.d || 1), nz = (best.az - best.bz) / (best.d || 1);
    const push = (ra + rb - best.d) / 2;
    if (!(S.boarding && (a === P || b === P))) { a.x += nx * push; a.z += nz * push; b.x -= nx * push; b.z -= nz * push; }
    const key = `${a.id}|${b.id}`;
    if ((ramCd.get(key) || -1e9) > S.t - 2.5) return;
    const closing = (a.vx - b.vx) * -nx + (a.vz - b.vz) * -nz;
    const bowA = best.ka >= 0.5, bowB = best.kb >= 0.5;
    const rammer = bowA && !bowB ? a : bowB && !bowA ? b : (a.speed >= b.speed ? a : b);
    const rammed = rammer === a ? b : a;
    const rammerSpeed = rammer.speed;
    if (rammer === P) {
      if (rammerSpeed < RAM.speed || closing < RAM.speed * 0.6) { ramCd.set(key, S.t - 1.5); return; }
      ramCd.set(key, S.t);
      const dmg = RAM.hull * rammerSpeed;
      hurtPlayer(RAM.self * rammerSpeed, { cause: "ram", braceable: false });
      provoke(rammed);
      rammed.lastHitByRexmawT = S.t;
      emit({ type: "hazard", kind: "ram", stage: "hit", id: rammed.id, by: "rexmaw", dmg: ROUND(dmg) });
      emit({ type: "impact", target: rammed.id, x: ROUND(best.bx), y: 2, z: ROUND(best.bz), dmg: ROUND(dmg), kind: "hull", ammo: "ram", from: "rexmaw" });
      if (rammed.C.len <= RAM.splitLen) {
        rammed.hull = 0; rammed.split = true;
        emit({ type: "split", id: rammed.id });
        sinkEnemy(rammed, "ram", true, { split: true });
      } else {
        rammed.hull -= dmg;
        if (rammed.hull <= 0) sinkEnemy(rammed, "ram", true);
      }
      return;
    }
    if (closing < RAM.speed * 0.5) return;
    // v5: hulls grinding together after a ram (or a slow bump) aren't another ram: only a ship on her ram run, or one coming in
    // at ramming speed, rams the Rexmaw.
    if (rammed === P && rammer.state !== "ram" && (rammer.C.legendary || closing < RAM.speed || rammer.speed < RAM.speed * 0.75)) return;
    ramCd.set(key, S.t);
    if (rammed === P) {
      // v5: capped (in line with a boss broadside) and one hit per run: she breaks off (a boss wallows: the punish window).
      const r = hurtPlayer(Math.min(RAM.enemyCap, RAM.enemyHull * closing * (rammer.C.len / 32)), { cause: "ram", x: rammer.x, z: rammer.z, crewLoss: 1 });
      emit({ type: "hazard", kind: "ram", stage: "hit", id: rammer.id, by: rammer.id, dmg: ROUND(r.dmg || 0) });
      if (rammer.state === "ram" && rammer.cls !== "fireship") {
        rammer.state = "broadside"; rammer.ai = "broadside"; rammer.stateT = 0; rammer.ramCd = Math.max(rammer.ramCd || 0, 8);
        if (rammer.cls === "gloam") rammer.reelT = GLOAM.reelS;
        else if (rammer.cls === "manowar") rammer.reelT = DUKE.reelS;
      }
      rammer.hull -= RAM.self * closing * 3;
      if (rammer.hull <= 0) sinkEnemy(rammer, "ram", true);
    } else {
      rammed.hull -= RAM.hull * closing * 0.5;
      if (rammed.hull <= 0) sinkEnemy(rammed, "ram", false);
    }
  }

  // ---- Hazards ----------------------------------------------------------------------------

  function enemyMortar(e) {
    const w = MORTAR.warn * tele();
    const m = { id: `mortar${++pid}`, from: e.id, x: P.x + P.vx * w * 0.8, z: P.z + P.vz * w * 0.8, r: MORTAR.r0, eta: w, total: w };
    S.hazards.mortars.push(m);
    emit({ type: "hazard", kind: "mortar", stage: "telegraph", id: m.id, x: ROUND(m.x), z: ROUND(m.z), r: m.r, eta: ROUND(w), from: e.id });
  }

  /** A rogue wave rolling along `dirDeg` that reaches the Rexmaw in `eta` s (the storm's, or a sea event's set). */
  function spawnWave(dirDeg, eta, extra = {}) {
    const H = S.hazards;
    const f = forward(dirDeg);
    H.wave = { id: `wave${++pid}`, dirDeg: Math.round(dirDeg), x: P.x - f.x * eta * STORM.waveSpeed, z: P.z - f.z * eta * STORM.waveSpeed, width: STORM.waveWidth, eta, hit: false, ...extra };
    emit({ type: "hazard", kind: "wave", stage: "telegraph", id: H.wave.id, dirDeg: H.wave.dirDeg, eta: ROUND(eta), x: ROUND(H.wave.x), z: ROUND(H.wave.z), event: extra.event });
    return H.wave;
  }

  /** The live rogue wave rolls on; it does no harm ridden bow or stern on (within 25°), else hull, water and maybe a man overboard. */
  function waveStep(h) {
    const H = S.hazards;
    if (!H.wave) return;
    const W = H.wave, f = forward(W.dirDeg);
    W.x += f.x * STORM.waveSpeed * h; W.z += f.z * STORM.waveSpeed * h;
    const along = (P.x - W.x) * f.x + (P.z - W.z) * f.z;
    const lateral = Math.abs((P.x - W.x) * -f.z + (P.z - W.z) * f.x);
    W.eta = along / STORM.waveSpeed;
    if (!W.hit && along <= 0 && along > -30 && lateral < W.width / 2) {
      W.hit = true;
      const a = Math.abs(wrap180(P.heading - W.dirDeg));
      if (a <= 25 || a >= 155) emit({ type: "hazard", kind: "wave", stage: "ridden", id: W.id, angle: Math.round(a), event: W.event });
      else {
        const r = hurtPlayer(20, { cause: "wave", x: P.x, z: P.z });
        if (!r.cancelled) P.water = Math.min(100, P.water + 15);
        emit({ type: "hazard", kind: "wave", stage: "hit", id: W.id, angle: Math.round(a), event: W.event });
        if (!r.cancelled && !r.perfect) sweepOverboard();
      }
    }
    if (along < -200 || lateral > W.width * 2) H.wave = null;
  }

  function hazardsStep(h) {
    const H = S.hazards;
    waveStep(h);
    H.mortars = H.mortars.filter((m) => {
      if (m.from === "rexmaw") return true;
      m.eta -= h;
      m.r = MORTAR.r1 + (MORTAR.r0 - MORTAR.r1) * clamp(m.eta / m.total, 0, 1);
      if (m.eta > 0) return true;
      const hitP = dist(m.x, m.z, P.x, P.z) < m.r + SHIP.radius;
      if (hitP) { const r = hurtPlayer(MORTAR.dmg, { cause: "mortar", x: m.x, z: m.z }); if (!r.cancelled && !r.perfect && R.dmg.chance(0.5)) startFire(m.x, m.z); }
      emit({ type: "hazard", kind: "mortar", stage: hitP ? "hit" : "land", id: m.id, x: ROUND(m.x), z: ROUND(m.z), hit: hitP });
      return false;
    });

    // Fire barrels astern: anything that sails through one catches fire.
    S.barrels = S.barrels.filter((b) => {
      b.t += h;
      if (b.t >= WEAPONS.barrels.life) { emit({ type: "barrel", id: b.id, stage: "out", x: ROUND(b.x), z: ROUND(b.z) }); return false; }
      if (b.t < WEAPONS.barrels.armS) return true;
      for (const e of S.ships) {
        if (!alive(e) || e.fixed) continue;
        const l = toLocal(e.x, e.z, e.heading, b.x, b.z);
        const { hl, hb } = hullAxes(e);
        const a = l.lz / (hl + WEAPONS.barrels.r), c = l.lx / (hb + WEAPONS.barrels.r);
        if (a * a + c * c > 1) continue;
        e.fires += WEAPONS.barrels.fires; e.hull -= WEAPONS.barrels.burnHull; e.burnedByUs = true; e.lastHitByRexmawT = S.t;
        provoke(e);
        S.stats.damageDealt += WEAPONS.barrels.burnHull;
        emit({ type: "barrel", id: b.id, stage: "ignite", x: ROUND(b.x), z: ROUND(b.z), target: e.id });
        emit({ type: "fire", target: e.id, x: ROUND(e.x), z: ROUND(e.z), stage: "start" });
        emit({ type: "impact", target: e.id, x: ROUND(b.x), y: 1, z: ROUND(b.z), dmg: WEAPONS.barrels.burnHull, kind: "explosion", ammo: "barrel", from: "rexmaw" });
        if (e.hull <= 0) sinkEnemy(e, "fire", true);
        return false;
      }
      return true;
    });

    const st = S.storm;
    if (st) {
      st.x += st.vx * h; st.z += st.vz * h;
      const b = world.bounds;
      if (st.x < b.minX + st.r * 0.3 || st.x > b.maxX - st.r * 0.3) st.vx = -st.vx;
      if (st.z < 300 || st.z > b.maxZ - st.r * 0.3) st.vz = -st.vz;
      st.inside = inStorm(P.x, P.z);
      H.spouts.forEach((sp, i) => {
        sp.t += h; sp.cd = Math.max(0, sp.cd - h);
        if (sp.stage === "forming" && sp.t >= 8 * tele()) { sp.stage = "active"; sp.t = 0; emit({ type: "hazard", kind: "spout", stage: "active", id: sp.id, x: ROUND(sp.x), z: ROUND(sp.z) }); }
        if (sp.stage === "active" && sp.t >= sp.life) { H.spouts[i] = newSpout(Number(sp.id.replace(/\D/g, "")) || i + 1); emit({ type: "hazard", kind: "spout", stage: "forming", id: H.spouts[i].id, x: ROUND(H.spouts[i].x), z: ROUND(H.spouts[i].z) }); return; }
        sp.dir = wrap360(sp.dir + R.haz.range(-30, 30) * h);
        const f = forward(sp.dir);
        sp.x += f.x * STORM.spoutSpeed * h + st.vx * h; sp.z += f.z * STORM.spoutSpeed * h + st.vz * h;
        if (dist(sp.x, sp.z, st.x, st.z) > st.r * 0.9) sp.dir = headingOf(st.x - sp.x, st.z - sp.z);
        if (sp.stage !== "active" || sp.cd > 0) return;
        if (dist(sp.x, sp.z, P.x, P.z) < sp.r + SHIP.radius + 4) {
          sp.cd = 8;
          hurtPlayer(20, { cause: "spout", x: sp.x, z: sp.z });
          P.spinT = 1.2; P.speed *= 0.3;
          emit({ type: "hazard", kind: "spout", stage: "hit", id: sp.id, x: ROUND(sp.x), z: ROUND(sp.z) });
        }
      });
      const near = inStorm(P.x, P.z, 80);
      if (near && !H.wave) {
        S.wavesT -= h;
        if (S.wavesT <= 0) {
          S.wavesT = R.haz.range(STORM.waveEvery[0], STORM.waveEvery[1]);
          spawnWave(wrap360(S.wind.dirDeg + 180 + R.haz.range(-35, 35)), STORM.waveWarn * tele());
        }
      }
      if (H.lightning) {
        H.lightning.eta -= h; H.lightning.t += h;
        if (H.lightning.eta <= 0 && !H.lightning.struck) {
          const L = H.lightning;
          L.struck = true;
          const hitP = dist(L.x, L.z, P.x, P.z) < STORM.lightningR;
          if (hitP) { P.masts = Math.max(0, P.masts - 10); startFire(); hurtPlayer(4, { cause: "lightning", braceable: false }); }
          for (const e of S.ships) if (alive(e) && !e.fixed && dist(L.x, L.z, e.x, e.z) < STORM.lightningR) { e.hull -= 10; e.fires++; }
          emit({ type: "hazard", kind: "lightning", stage: "strike", x: ROUND(L.x), z: ROUND(L.z), hit: hitP, target: hitP ? "rexmaw" : null });
        }
        if (H.lightning.t > 2.5) H.lightning = null;
      } else if (near) {
        S.lightT -= h;
        if (S.lightT <= 0) {
          S.lightT = R.haz.range(STORM.lightningEvery[0], STORM.lightningEvery[1]);
          let x, z;
          if (R.haz.chance(0.3)) { x = P.x + R.haz.range(-20, 20); z = P.z + R.haz.range(-20, 20); }
          else { const a = R.haz.range(0, Math.PI * 2), r = R.haz.range(0, st.r); x = st.x + Math.cos(a) * r; z = st.z + Math.sin(a) * r; }
          H.lightning = { x, z, eta: 1.2 * tele(), t: 0, struck: false };
          emit({ type: "hazard", kind: "lightning", stage: "telegraph", x: ROUND(x), z: ROUND(z), eta: ROUND(H.lightning.eta) });
        }
      }
    }

    const M = world.maelstrom;
    if (M) {
      const d = dist(P.x, P.z, M.x, M.z);
      const inside = d < M.r;
      if (inside && !S.inMaelstrom) emit({ type: "hazard", kind: "maelstrom", stage: "enter", dist: Math.round(d) });
      if (!inside && S.inMaelstrom) emit({ type: "hazard", kind: "maelstrom", stage: "leave" });
      S.inMaelstrom = inside;
      if (d < M.eye && !S.boarding && P.hull > 0) { P.hull = 0; emit({ type: "hazard", kind: "maelstrom", stage: "eye" }); }
      for (const p of S.pickups) {
        if (p.kind !== "ring") continue;
        const v = MAELSTROM.pull / Math.max(p.r, M.eye) * MAELSTROM.swirl;
        p.a += (v / p.r) * h;
        p.x = M.x + Math.cos(p.a) * p.r; p.z = M.z + Math.sin(p.a) * p.r;
      }
    }
    krakenStep(h);
  }

  function sweepOverboard() {
    const onDeck = crew.ids.filter((id) => NAMED.includes(id) && crew.present(id) && !crew.named[id].companion);
    let who;
    if (onDeck.length && R.haz.chance(0.5)) who = R.haz.pick(onDeck);
    else if (P.crewHands > 0) { who = "hand"; killHands(1); }
    if (!who) return;
    if (who !== "hand") crew.overboard(who);
    S.overboard.push({ who, t: 0, slowT: 0 });
    emit({ type: "overboard", who, stage: "swept" });
  }

  function overboardStep(h) {
    S.overboard = S.overboard.filter((o) => {
      o.t += h;
      if (o.lost) {
        if (o.t >= 25 + 60) { crew.back(o.who); emit({ type: "overboard", who: o.who, stage: "rescued", by: "boat" }); return false; }
        return true;
      }
      if (P.speed < 4) o.slowT += h;
      if (o.slowT >= 3) {
        if (o.who === "hand") { crew.addHands(1); P.crewHands = crew.hands(); } else crew.back(o.who);
        emit({ type: "overboard", who: o.who, stage: "rescued", by: "rope" });
        return false;
      }
      if (o.t >= 25) {
        emit({ type: "overboard", who: o.who, stage: "lost" });
        if (o.who === "hand") return false;
        o.lost = true;
      }
      return true;
    });
  }

  /** The Kraken comes now (Kraken's Wake schedules it; tests force it). */
  function startKraken() {
    if (S.hazards.kraken) return false;
    S.hazards.kraken = { stage: "ink", t: 0, ink: KRAKEN.inkS * tele(), x: P.x, z: P.z, arms: [] };
    emit({ type: "hazard", kind: "kraken", stage: "ink", eta: ROUND(S.hazards.kraken.ink) });
    return true;
  }

  function krakenStep(h) {
    const H = S.hazards;
    P.krakenSlow = 1;
    if (!H.kraken) {
      if (S.kraken.next != null && S.t >= S.kraken.next) { S.kraken.next = null; startKraken(); }
      return;
    }
    const K = H.kraken;
    K.t += h;
    K.x = P.x; K.z = P.z;
    if (K.stage === "ink" && K.t >= K.ink) {
      K.stage = "grab"; K.t = 0;
      const spots = [["port", "guns_port"], ["port", "sails"], ["starboard", "guns_starboard"], ["starboard", "pumps"]];
      K.arms = spots.slice(0, KRAKEN.arms).map(([side, station], i) => ({ id: `arm${i + 1}`, side, station, hp: KRAKEN.armHp, hpMax: KRAKEN.armHp }));
      emit({ type: "hazard", kind: "kraken", stage: "grab", arms: K.arms.map((a) => ({ id: a.id, side: a.side, station: a.station })) });
      return;
    }
    if (K.stage === "grab") {
      const holding = K.arms.filter((a) => a.hp > 0);
      P.hull = Math.max(0, P.hull - KRAKEN.hullPerArm * holding.length * h);
      if (holding.length) P.krakenSlow = KRAKEN.slow;
      if (K.arms.every((a) => a.hp <= 0)) {
        K.stage = "retreat"; K.t = 0; S.stats.krakenRepelled++;
        gainPlunder(KRAKEN.loot, "kraken");
        emit({ type: "hazard", kind: "kraken", stage: "repelled" });
        if (S.kraken.again) S.kraken.next = S.t + KRAKEN.again;
      } else if (K.t >= KRAKEN.lastS) {
        K.stage = "retreat"; K.t = 0;
        emit({ type: "hazard", kind: "kraken", stage: "retreat" });
        if (S.kraken.again) S.kraken.next = S.t + KRAKEN.again;
      }
      return;
    }
    if (K.stage === "retreat" && K.t > 3) H.kraken = null;
  }

  // ---- v5: the Kraken's eye (Kraken's Wake's boss beat). missions.js raises it (S.hazards.eye) and runs its cycle; here,
  // only what hits it: our balls and shells landing within its reach while it's up, and the swivel.
  /** Our shot landing at (x, z) (a mortar shell's blast widens the reach by `pad`): the eye takes it while it's up. */
  function eyeSplash(x, z, ammo, pad = 0) {
    const E = S.hazards.eye;
    if (!E || E.stage !== "up" || dist(x, z, E.x, E.z) > KRAKEN_EYE.hitR + pad) return false;
    return eyeHit((AMMO[ammo] || AMMO.round).hull, ammo);
  }
  function eyeHit(dmg, by) {
    const E = S.hazards.eye;
    if (!E || E.stage !== "up") return false;
    E.dealt += dmg; E.hits++;
    S.stats.damageDealt += dmg;
    emit({ type: "impact", target: E.id, x: ROUND(E.x), y: 4, z: ROUND(E.z), dmg: ROUND(dmg), kind: "hull", ammo: by, from: "rexmaw" });
    return true;
  }

  function armDamage(arm, dmg, by, credit = null) {
    if (arm.hp <= 0) return;
    arm.hp = Math.max(0, arm.hp - dmg);
    if (arm.hp <= 0) {
      emit({ type: "hazard", kind: "kraken", stage: "arm", id: arm.id, station: arm.station, side: arm.side, by });
      if (credit) {
        S.contrib.armsCut = (S.contrib.armsCut || 0) + 1;
        emit({ type: "contrib", kind: "arm", who: credit.who, by: credit.by, amount: 1, text: `Arm off · ${whoLabel(credit.who)}`, x: ROUND(P.x), z: ROUND(P.z) });
        moment(credit.by, "arm", `${whoLabel(credit.who)} hacked a Kraken arm off the ${arm.side} rail`, 20);
      }
    }
  }

  // ---- Fires, leaks, water ---------------------------------------------------------------------

  let fireSpreadT = 0;
  function shipDamageStep(h) {
    if (P.hull <= 0) return;
    if (P.fires > 0) {
      P.hull = Math.max(0, P.hull - FIRE.hullPerS * P.fires * h);
      // Fires burn themselves out in time; a repair order puts them out sooner.
      for (let i = 0; i < P.fireAges.length; i++) P.fireAges[i] += h;
      while (P.fireAges.length && P.fireAges[0] >= FIRE.outS) { P.fireAges.shift(); P.fires = Math.max(0, P.fires - 1); emit({ type: "fire", target: "rexmaw", x: ROUND(P.x), z: ROUND(P.z), stage: "out", count: P.fires }); }
      fireSpreadT += h;
      if (fireSpreadT >= FIRE.spreadEvery) {
        fireSpreadT = 0;
        const n = P.fires;
        for (let i = 0; i < n; i++) if (R.dmg.chance(FIRE.spreadChance)) startFire();
      }
    } else fireSpreadT = 0;
    P.water = clamp(P.water + P.leaks * LEAK.waterPerS * h - BILGE.passive * h, 0, 100);
    P.morale += (MORALE.rest - P.morale) * MORALE.drift * h;
  }

  // ---- Plunder, pickups, banking, salvage, the cove ------------------------------------------------

  function gainPlunder(amount, from) {
    if (amount <= 0) return;
    if (pw) amount *= pw.lootMul();   // v4.2: Double Doubloons
    S.plunder.hold += Math.round(amount);
    S.plunder.loot += Math.round(amount);
    emit({ type: "plunder", amount: Math.round(amount), from, hold: S.plunder.hold });
  }

  function addAmmo(patch) {
    const got = {};
    for (const [k, v] of Object.entries(patch || {})) if (v > 0) { P.ammo[k] = (P.ammo[k] || 0) + v; got[k] = v; }
    return got;
  }

  /** Sail through a collectable (within PICKUP.range of the hull) and it's hauled in. */
  function collect(p) {
    const ev = { type: "pickup", id: p.id, kind: p.kind, x: ROUND(p.x), z: ROUND(p.z), value: p.value, gold: 0, hull: 0, ammo: {} };
    if (p.kind === "crate") { ev.ammo = addAmmo(PICKUP.crate); ev.gold = p.value; }
    else if (p.kind === "barrel") { const before = P.hull; P.hull = Math.min(P.hullMax, P.hull + p.value); ev.hull = ROUND(P.hull - before); }
    else if (p.kind === "bottle") { ev.gold = p.value; ev.note = p.note || null; }
    else ev.gold = p.value;
    if (ev.gold) gainPlunder(ev.gold, p.kind === "ring" ? "maelstrom" : p.kind);
    S.stats.pickups++;
    emit(ev);
  }

  function lootStep(h) {
    const f = forward(P.heading);
    const ax = P.x + f.x * SHIP.half, az = P.z + f.z * SHIP.half, bx = P.x - f.x * SHIP.half, bz = P.z - f.z * SHIP.half;
    const reach = SHIP.radius + PICKUP.range;
    S.pickups = S.pickups.filter((p) => {
      if (p.flotsam) {
        p.age += h;
        if (p.age > PICKUP.flotsamS) return false;
        p.x += (p.vx || 0) * h; p.z += (p.vz || 0) * h;
        p.vx = (p.vx || 0) * Math.exp(-h / 20); p.vz = (p.vz || 0) * Math.exp(-h / 20);
      }
      if (Math.abs(p.x - P.x) > 40 || Math.abs(p.z - P.z) > 40) return true;
      if (segDist(p.x, p.z, ax, az, bx, bz).d > reach) return true;
      collect(p);
      return false;
    });
    S.repairing = P.inHarbour && P.speed < PORT.bankSpeed && (P.hull < P.hullMax || P.masts < REXMAW.masts || P.water > 0) && !!cfg.free;
    if (S.repairing) {
      P.hull = Math.min(P.hullMax, P.hull + REPAIR.harbourHull * h);
      P.masts = Math.min(REXMAW.masts, P.masts + REPAIR.harbourMasts * h);
      P.water = Math.max(0, P.water - 5 * h);
      if (P.fires || P.leaks) { P.fires = 0; P.fireAges = []; P.leaks = 0; }
    }
    if (cfg.free && P.inHarbour && P.speed < PORT.bankSpeed && S.plunder.hold > 0) {
      S.banking = (S.banking || 0) + h / PORT.bankS;
      if (S.banking >= 1) bank();
    } else S.banking = null;
    const cv = world.cove;
    if (cfg.free && cv && !S.cove.used && dist(P.x, P.z, cv.x, cv.z) < cv.r && P.speed < COVE.speed) {
      S.cove.t += h;
      if (S.cove.t >= COVE.s) {
        S.cove.used = true;
        const before = P.hull;
        P.hull = Math.min(P.hullMax, P.hull + COVE.heal);
        emit({ type: "cove", healed: Math.round(P.hull - before) });
      }
    } else if (cfg.free) S.cove.t = 0;
    // Salvage: stopped beside a wreck.
    let near = null;
    for (const w of world.wrecks) if (!S.salvaged.has(w.id) && dist(P.x, P.z, w.x, w.z) < WRECKS.salvageR) near = w;
    if (near && P.speed < WRECKS.salvageSpeed) {
      if (!S.salvage || S.salvage.id !== near.id) { S.salvage = { id: near.id, t: 0, dur: WRECKS.salvageS }; emit({ type: "salvage", id: near.id, stage: "start" }); }
      S.salvage.t += h;
      if (S.salvage.t >= S.salvage.dur) {
        S.salvaged.add(near.id); S.salvage = null; S.stats.salvages++;
        addAmmo({ chain: 2, mortar: 1 });
        gainPlunder(near.loot, "wreck");
        emit({ type: "salvage", id: near.id, stage: "done", value: near.loot });
      }
    } else { if (S.salvage) emit({ type: "salvage", id: S.salvage.id, stage: "stopped" }); S.salvage = null; }
  }

  function bank() {
    const amount = S.plunder.hold;
    if (amount <= 0) return 0;
    S.plunder.banked += amount; S.plunder.hold = 0; S.banking = null;
    S.stats.banks++; S.stats.lastBankT = S.t;
    emit({ type: "bank", amount, total: S.plunder.banked });
    if (S.heat > 0) addHeat(HEAT.bank, "banked");
    return amount;
  }

  // ---- Heat, waves, wind (free roam) ----------------------------------------------------------------

  function worldStep(h) {
    if (cfg.free) {
      if (S.heat > 0 && S.t - S.lastFightT >= HEAT.decayS) { S.lastFightT = S.t; addHeat(-1, "the trail went cold"); }
      if (S.nextWave && S.t >= S.nextWave.at) { hunterWave(S.nextWave.level); S.nextWave = null; S.waveRepeatT = HEAT.waveEvery; }
      if (S.heat >= 1) {
        S.waveRepeatT -= h;
        const hunters = S.ships.filter((e) => e.role === "hunter" && alive(e)).length;
        if (S.waveRepeatT <= 0) { S.waveRepeatT = HEAT.waveEvery; if (hunters === 0) hunterWave(S.heat); }
      }
    }
    const gust = sea ? sea.wind() : { strength: 0, dir: 0 };   // v4: a squall's gusts
    S.wind.dirDeg = wrap360(world.wind.dirDeg + WIND.drift * Math.sin((S.t / WIND.driftPeriod) * Math.PI * 2) + gust.dir);
    S.wind.strength = clamp(world.wind.strength + (S.storm?.inside ? STORM.gust * Math.sin(S.t * 1.7) : 0) + gust.strength, 0.4, 1.4);
  }

  /** Who the Rexmaw can see: the visibility (night, fog, storm) and lanterns. Reefs show on the Captain's chart by day or close. */
  function sightStep() {
    const vis = visibilityAt(P.x, P.z);
    S.visibility = Math.round(vis);
    S.fogHere = fogAt(P.x, P.z);
    const knownR = night ? 260 : 650;
    for (const e of S.ships) {
      if (e.gone || e.state === "sinking") continue;
      const d = dist(P.x, P.z, e.x, e.z);
      let range = Math.min(vis, visibilityAt(e.x, e.z) + 60);
      if (night && !e.cloaked && (e.lantern || e.C.navy || e.cls === "merchant") && fogAt(e.x, e.z) < 0.5 && fogAt(P.x, P.z) < 0.5) range = Math.max(range, FOG.lanternVis);
      if (e.fixed && !night) range = Math.max(range, FOG.dayVis);
      if (e.cloaked) range = WEAPONS.swivel.range * 0.5;
      const was = e.detected;
      if (!was && d <= range) { e.detected = true; emit({ type: "contact", id: e.id, stage: "appear", cls: e.cls, name: e.name }); }
      else if (was && d > range * SIGHT.lost + 30) { e.detected = false; emit({ type: "contact", id: e.id, stage: "lost", cls: e.cls, name: e.name }); }
      if (e.detected && d <= Math.min(knownR, range) && !e.known) { e.known = true; emit({ type: "known", id: e.id }); }
    }
    const revealR = S.fogHere > 0.3 ? REEFS.revealFog : REEFS.revealNight;
    if (night || S.fogHere > 0.3) {
      for (const rf of world.reefs || []) {
        if (S.revealed.has(rf.id)) continue;
        if (dist(P.x, P.z, rf.x, rf.z) - rf.r > revealR + SHIP.half) continue;
        if (capsuleDist(P.x, P.z, rf).d <= revealR + SHIP.half) { S.revealed.add(rf.id); emit({ type: "hazard", kind: "reef", stage: "reveal", id: rf.id, x: rf.x, z: rf.z }); }
      }
    }
    for (const isl of world.islands) for (const sh of isl.shoals) {
      const d = dist(P.x, P.z, sh.x, sh.z) - sh.r;
      if ((!night || d < 80) && d < (night ? 80 : 500) && !S.revealed.has(sh.id)) {
        S.revealed.add(sh.id);
        emit({ type: "hazard", kind: "shoal", stage: "reveal", id: sh.id, x: sh.x, z: sh.z, r: sh.r, by: "sight" });
      }
    }
  }

  /** The reefs the Captain's chart may show: every one by day (outside fog), else only those seen close. */
  function captainReefs() {
    const all = world.reefs || [];
    if (!night) return all.filter((rf) => S.revealed.has(rf.id) || fogAt(rf.x, rf.z) < 0.3);
    return all.filter((rf) => S.revealed.has(rf.id));
  }

  // ---- The step ----------------------------------------------------------------------------------

  function drain() { const res = out.slice(); out.length = 0; return res; }

  function reloadStep(h) {
    const mul = crew.reloadMul() * (S.crewMode.mode === "attack" ? CREW_MODE.attackReload : 1) * (pw ? pw.reloadMul() : 1);   // v4.2: Quick Hands
    for (const k of RELOAD_KEYS) {
      if (P.reload[k] >= 1) { P.reloadS[k] = 0; continue; }
      const base = reloadBase(k) * (k === "swivel" || k === "barrels" ? 1 : mul);
      P.reload[k] = Math.min(1, P.reload[k] + h / base);
      P.reloadS[k] = (1 - P.reload[k]) * base;
    }
    for (const k of Object.keys(P.firingT)) P.firingT[k] = Math.max(0, P.firingT[k] - h);
  }

  function step(h) {
    STEP_H = h;
    S.t += h;
    if (P.braceT > 0) P.braceT = Math.max(0, P.braceT - h);
    P.braceCd = Math.max(0, P.braceCd - h);
    if (P.perfectT != null) P.perfectT += h;
    const reloading = {}, bearsNow = {};
    for (const k of ["port", "starboard", "bow", "mortar"]) { reloading[k] = P.reload[k] < 1; bearsNow[k] = S.manned[k]?.status === "laid"; }
    const K = S.hazards.kraken;
    const disabled = K && K.stage === "grab" ? K.arms.filter((a) => a.hp > 0).map((a) => a.station) : [];
    for (const e of crew.update(h, { ship: P, reloading, bears: bearsNow, disabled })) emit(e);
    P.crewHands = crew.hands();
    movePlayer(h);
    shipsStep(h);
    reloadStep(h);
    mannedStep(h);
    attackStep();
    projectileStep();
    hazardsStep(h);
    sea.step(h);
    pw.step(h);
    shipDamageStep(h);
    defendStep(h);
    jobsStep(h);
    flushPending();
    for (const [vid, v] of Object.entries(S.crewVolleys)) if (S.t - v.t > 15) finishVolley(vid);   // balls dropped by a boarding lock
    overboardStep(h);
    lootStep(h);
    worldStep(h);
    sightStep();
    S.trackT += h;
    if (S.trackT >= 2) { S.trackT = 0; S.track.push({ x: Math.round(P.x), z: Math.round(P.z) }); if (S.track.length > 600) S.track.splice(0, S.track.length - 600); }
    if (P.hull <= 0 && !S.sunk) { S.sunk = true; emit({ type: "sunk", cause: "hull" }); }
    if (P.water >= 100 && !S.sunk) { S.sunk = true; emit({ type: "sunk", cause: "flooded" }); }
    return drain();
  }

  // ---- Boarding hooks ---------------------------------------------------------------------------------

  function startBoardingLock(id) {
    const e = shipById(id);
    if (!e) return false;
    S.boarding = { enemyId: id };
    const p = portNormal(P.heading);
    const side = relBearing(P.x, P.z, P.heading, e.x, e.z) < 0 ? 1 : -1;
    e.x = P.x + p.x * side * (SHIP.beam / 2 + e.C.beam / 2 + 2); e.z = P.z + p.z * side * (SHIP.beam / 2 + e.C.beam / 2 + 2);
    e.heading = P.heading; e.speed = 0; P.speed = 0;
    S.projectiles = S.projectiles.filter((pr) => pr.from === "rexmaw" && pr.target !== id);
    S.stats.boardings++;
    return true;
  }
  function endBoardingLock() { S.boarding = null; }

  /** She's ours: her loot to the hold, powder and hands from her, and a prize crew sails her off. */
  function capture(id) {
    const e = shipById(id);
    if (!e) return 0;
    const loot = e.loot;
    gainPlunder(loot, "capture");
    addAmmo(BOARD.winAmmo);
    crew.addHands(BOARD.winHands); P.crewHands = crew.hands();
    S.stats.captured.push({ id: e.id, name: e.name, cls: e.cls, t: ROUND(S.t), chest: !!e.chest });
    addHeat(HEAT.byClass[e.cls] ?? 0, `took ${e.name}`);
    e.state = "surrender"; e.gone = true; e.captured = true;
    emit({ type: "captured", id: e.id, name: e.name, cls: e.cls, loot, chest: !!e.chest });
    return loot;
  }
  function release(id) {
    const e = shipById(id);
    if (!e) return;
    e.state = "flee"; e.ai = "broke_free"; e.brokeFree++; e.surrenderT = 0; e.boardLockT = 30;
    e.x += (e.x - P.x) * 0.2; e.z += (e.z - P.z) * 0.2;
  }

  // ---- Queries ---------------------------------------------------------------------------------

  const visibleContacts = () => S.ships.filter((e) => !e.gone && e.detected && !e.down);

  /** The aim preview on the live sim (the run's aimPreview). */
  let previewCache = { key: null, value: null };
  function preview(look = null) {
    const lk = look || { lookYawRel: S.look.yaw, lookPitch: S.look.pitch, aiming: S.look.aiming, mode: S.look.mode, point: S.look.point };
    // The HUD and the scene both ask every frame with the same look: one trace per sim step and look.
    const key = `${S.t}|${lk.lookYawRel ?? lk.yaw}|${lk.lookPitch ?? lk.pitch}|${!!lk.aiming}|${lk.mode}|${lk.point ? `${lk.point.x},${lk.point.z}` : ""}|${P.reload.port}|${P.reload.starboard}|${P.reload.bow}|${P.reload.mortar}|${P.reload.barrels}|${S.marked}`;
    if (previewCache.key === key) return previewCache.value;
    const view = { ship: { ...P, ammo: P.ammo }, contacts: S.ships, reload: P.reload, reloadS: P.reloadS };
    const value = aimPreview(view, lk, { lock: lockShip() });
    previewCache = { key, value };
    return value;
  }

  // ---- v4: the random sea events ------------------------------------------------------------------------

  let derelictN = 0;
  /** An abandoned merchant adrift: anchored (no AI), nobody aboard, never fights, salvaged alongside. */
  function spawnDerelict({ x, z, heading }) {
    const used = new Set(S.ships.map((e) => e.name));
    const pool = NAMES.merchant.filter((nm) => !used.has(`the derelict ${nm}`));
    const name = `the derelict ${pool.length ? R.sea.pick(pool) : "hulk"}`;
    const e = createShip({ id: `dr${++derelictN}`, cls: "merchant", name, role: "derelict", x, z, heading }, world, R.sea);
    Object.assign(e, { derelict: true, anchored: true, crew: 0, hostile: false, provoked: false, loot: 0, masts: 25, speed: 0, wantSpeed: 0 });
    e.hull = Math.round(e.hullMax * 0.55);
    e.batteries.port.guns = 0; e.batteries.starboard.guns = 0;
    S.ships.push(e);
    emit({ type: "spawn", id: e.id, cls: e.cls, role: "derelict", name: e.name });
    return e;
  }
  sea = createSeaEvents({
    S, P, world, rng: R.sea, tele, emit, isWater: (x, z, pad) => isWater(x, z, pad),
    objectivePoints: () => objectivePoints(api),
    hurtPlayer, spin: (s = 1.2) => { P.spinT = s; P.speed *= 0.3; },
    spawnDerelict, sinkShip: (e, cause) => sinkEnemy(e, cause, false), shipById, gainPlunder, addAmmo,
    addPickup: (p) => { S.pickups.push(p); }, removePickups: (pred) => { S.pickups = S.pickups.filter((p) => !pred(p)); },
    spawnWave, waveBusy: () => !!S.hazards.wave,
  });
  pw = createPowerups({ S, P, world, cfg, rng: rng.fork("powerups"), emit, isWater: (x, z, pad) => isWater(x, z, pad), shipById });

  const api = {
    S, P, crew, world, cfg, step, drain, setSail, setWheel, setSprint, brace, swivel, setLook, fireWeapon, preview,
    manGuns, standDown, fireManned, crewFire, startRepair, startBail, endJob, jobProgress, setCrewMode, moment,
    bank, addHeat, gainPlunder, addAmmo, startBoardingLock, endBoardingLock, capture, release, shipById, visibleContacts, spawnShip,
    hunterWave, isWater, inStorm, fogAt, visibilityAt, captainReefs, killHands, startFire, startLeak, rngBoard: R.board, rngMission: R.spawn,
    alive, windFactor, startKraken, setObstacles, sinkEnemy, collect, spawnWave, lockShip,
    /** v5: the off-call telegraph scale (the mission directors' telegraphs stretch with it). */
    teleScale: () => tele(),
    /** v4: the random sea events (state(), force(kind), schedule(), …). */
    get sea() { return sea; },
    /** v4.2: the power-ups (state(), buffs(), force(kind), give(kind), …). */
    get pw() { return pw; },
  };
  // The mission's step builders read the sim through S (missionLine); not part of any snapshot.
  Object.defineProperty(S, "simRef", { value: api, enumerable: false });
  return api;
}
