// Power-ups (v4.2): glowing floats on the water — not loot — that give the Rexmaw a short edge. One comes up every
// ~20–35 s (free roam ~16–28 s) while fewer than four are afloat, IN VIEW (120–320 m off, within ±50° of the camera's
// look or her bow, clear of land); a ship we sink brings the next one sooner and may drop one where she went down.
// Sailing through one (within 6 m of the hull) takes it.
//
//   swift_wind        speed cap ×1.3 for 20 s
//   quick_hands       every gun reloads twice as fast for 20 s
//   hot_shot          our next 3 volleys set what they hit burning (each ball that lands lights a fire, up to 3 a ship)
//   iron_hull         damage taken ×0.5 for 20 s (balls, rams, reefs, waves, the sea events)
//   patch_kit         +20 hull at once, a leak plugged
//   powder_keg        chain shot, mortar shells and fire barrels topped up (+2 / +1 / +1, at least the mission's load);
//                     every gun loaded
//   double_doubloons  every gold coin counts twice for 30 s
//   kraken_ink        an ink cloud round her: enemy volleys scatter wide (their aim's spread +2, ~×3) for 15 s
//   mermaid_kiss      every fire out, every leak plugged, the bilge pumped dry, a little morale
//
// Stacking: the same timed one again adds its time (up to 2× its length); Hot Shot adds 3 volleys (up to 6); different
// kinds stack (Swift Wind × the dolphins' bow wave, Iron Hull × a brace).
//
//   const pw = createPowerups(hooks)   hooks: the sim's {S, P, world, cfg, rng, emit, isWater, shipById}
//   pw.step(h)                         the spawner, the drift, the pickup, the buffs' clocks
//   pw.speedMul() / reloadMul() / damageMul() / lootMul() / inkSpread()     what the sim's physics read
//   pw.useHotShot() → boolean          one of our volleys leaves: is it hot? (spends a charge)
//   pw.state() → state.powerups[]      {id, kind, label, x, z, left, from}
//   pw.buffs() → state.buffs[]         {id, kind, label, t (s left), dur, charges?}
//   pw.force(kind, {x, z}) / give(kind)  tests and debug: float one now / apply one now
//   pw.factFor(p) / briefLine() / nearest(text)   the companion's facts, look_around, "suggest loot: the power-up"
//
// Events: {type: "powerup", stage: "spawn" | "pickup" | "use" | "expire", id, kind, label, …}: spawn {x, z, from:
// "sea"|"wreck", life, dist}, pickup {x, z, dur, charges?, gain: {hull?, ammo?, fires?, leaks?, water?}, info},
// use {charges} (a Hot Shot volley), expire {afloat: true} (it sank unclaimed) | {buff: true, spent?} (it wore off).
// Pure: no three.js, no DOM, no Math.random (its own seeded stream).

import { POWERUP as PU, POWERUP_KINDS, POWERUP_TIMED, POWERUP_LABEL, POWERUP_INFO, SHIP, REXMAW } from "./const.js";
import { dist, forward, headingOf, wrap180, wrap360, segDist, metres, compass8Abbr } from "./geom.js";

const R1 = (v) => Math.round(v * 10) / 10;
/** A Hot Shot ball sets a ship burning while she has fewer fires than this (the sim's damageEnemy reads it). */
export const HOT_FIRES = PU.hot_shot.fires;

export function createPowerups(H) {
  const { S, P, world, cfg = {}, rng } = H;
  const afloat = [];     // {id, kind, x, z, age, life, from, vx, vz}
  const active = [];     // {id, kind, t (s left), dur, charges}
  let n = 0, bn = 0, last = null, sunkSeen = 0;
  let nextAt = world.arena ? Infinity : rng.range(PU.first[0], PU.first[1]);
  const emit = (stage, p, extra = {}) => H.emit({ type: "powerup", stage, id: p.id, kind: p.kind, label: POWERUP_LABEL[p.kind] || p.kind, ...extra });
  const look0 = S.look;
  const lookAt = () => (S.look && S.look !== look0 && Number.isFinite(S.look.yaw) ? wrap360(P.heading + S.look.yaw) : null);
  const buff = (kind) => active.find((b) => b.kind === kind) || null;

  // ---- Where and what ----------------------------------------------------------------------------

  function clear(x, z) {
    const b = world.bounds, m = 80;
    if (!(x > b.minX + m && x < b.maxX - m && z > b.minZ + m && z < b.maxZ - m)) return false;
    if (dist(x, z, world.port.x, world.port.z) < (world.port.r || 110) + 60) return false;
    if (world.maelstrom && dist(x, z, world.maelstrom.x, world.maelstrom.z) < world.maelstrom.r + 40) return false;
    if (!H.isWater(x, z, 15)) return false;
    return afloat.every((q) => dist(x, z, q.x, q.z) >= PU.spacing);
  }
  /** In view: DIST m off, within ±ARC° of the camera's look (once the Captain has looked), then her bow, her beams, anywhere. */
  function place() {
    const look = lookAt();
    const cones = [...(look != null ? [[look, PU.arc, 1]] : []), [P.heading, PU.arc, 1], [P.heading, 110, 1], [P.heading, 180, 1.3]];
    for (const [c, arc, far] of cones) {
      for (let i = 0; i < 12; i++) {
        const f = forward(c + rng.range(-arc, arc)), d = rng.range(PU.dist[0], PU.dist[1] * far);
        const x = P.x + f.x * d, z = P.z + f.z * d;
        if (clear(x, z)) return { x, z };
      }
    }
    return null;
  }

  const hostilesWithin = (r) => S.ships.some((e) => !e.gone && !e.fixed && !e.derelict && e.state !== "sinking" && (e.hostile || e.provoked) && dist(e.x, e.z, P.x, P.z) < r);
  /** A weighted pick: what she could use now a little likelier; not what's already afloat or what came last. */
  function pickKind() {
    const start = cfg.ammo || {};
    const lowAmmo = ["chain", "mortar", "barrels"].some((k) => (P.ammo[k] ?? 0) < Math.max(1, (start[k] ?? 2) / 2));
    const fight = hostilesWithin(600);
    const w = {
      swift_wind: 1, quick_hands: fight ? 1.3 : 0.8, hot_shot: fight ? 1.3 : 0.8, iron_hull: fight ? 1.2 : 0.8,
      patch_kit: P.hull < 60 ? 2.5 : P.hull > 90 ? 0.4 : 1, powder_keg: lowAmmo ? 2 : 0.6, double_doubloons: cfg.free ? 1.3 : 1,
      kraken_ink: fight ? 1.2 : 0.5, mermaid_kiss: P.fires || P.leaks || P.water > 20 ? 2.5 : 0.3,
    };
    for (const q of afloat) w[q.kind] *= 0.2;
    if (last) w[last] *= 0.3;
    const total = POWERUP_KINDS.reduce((a, k) => a + w[k], 0);
    let r = rng.next() * total;
    for (const k of POWERUP_KINDS) { r -= w[k]; if (r <= 0) return k; }
    return POWERUP_KINDS[0];
  }

  function spawn(kind, at, from = "sea", life = PU.life, drift = null) {
    const p = { id: `pw${++n}`, kind, x: at.x, z: at.z, age: 0, life, from, vx: drift ? drift.x : 0, vz: drift ? drift.z : 0 };
    afloat.push(p);
    last = kind;
    emit("spawn", p, { x: R1(p.x), z: R1(p.z), from, life, dist: Math.round(dist(P.x, P.z, p.x, p.z)) });
    return p;
  }

  // ---- Taking one ----------------------------------------------------------------------------------

  /** Apply `kind` to the Rexmaw: {dur, charges?, gain}. */
  function apply(kind) {
    const K = PU[kind] || {}, gain = {};
    if (POWERUP_TIMED.includes(kind)) {
      let b = buff(kind);
      if (!b) { b = { id: `bf${++bn}`, kind, t: 0, dur: K.s, charges: 0 }; active.push(b); }
      b.t = Math.min(b.t + K.s, K.s * PU.stack);
      b.dur = Math.max(b.dur, b.t);
      if (kind === "hot_shot") b.charges = Math.min(K.max, b.charges + K.volleys);
      return { dur: R1(b.t), charges: kind === "hot_shot" ? b.charges : undefined, gain };
    }
    if (kind === "patch_kit") {
      const before = P.hull;
      P.hull = Math.min(P.hullMax || REXMAW.hull, P.hull + K.hull);
      gain.hull = R1(P.hull - before);
      if (P.leaks > 0) { const l = Math.min(P.leaks, K.leaks); P.leaks -= l; gain.leaks = l; }
    } else if (kind === "powder_keg") {
      gain.ammo = {};
      for (const [k, v] of Object.entries(K.add)) {
        const was = P.ammo[k] ?? 0;
        P.ammo[k] = Math.max(was + v, cfg.ammo?.[k] ?? 0);
        if (P.ammo[k] > was) gain.ammo[k] = P.ammo[k] - was;
      }
      for (const k of Object.keys(P.reload || {})) { P.reload[k] = 1; if (P.reloadS) P.reloadS[k] = 0; }
    } else if (kind === "mermaid_kiss") {
      if (P.fires) { gain.fires = P.fires; P.fires = 0; P.fireAges = []; }
      if (P.leaks) { gain.leaks = P.leaks; P.leaks = 0; }
      if (P.water > 0) { gain.water = Math.round(P.water); P.water = 0; }
      P.morale = Math.min(100, (P.morale ?? 50) + K.morale);
    }
    return { dur: 0, gain };
  }

  function take(p) {
    const r = apply(p.kind);
    if (S.stats) S.stats.powerups = (S.stats.powerups || 0) + 1;
    emit("pickup", p, { x: R1(p.x), z: R1(p.z), dur: r.dur, charges: r.charges, gain: r.gain, info: POWERUP_INFO[p.kind] || "" });
  }

  // ---- The clock -------------------------------------------------------------------------------------

  function step(h) {
    // Our sinkings (stats.sunk only lists ours): the next one comes sooner, and she may drop one where she went down.
    const sunk = S.stats?.sunk || [];
    for (; sunkSeen < sunk.length; sunkSeen++) {
      const s = sunk[sunkSeen];
      if (world.arena) continue;
      nextAt = Math.min(nextAt, S.t + PU.afterSink);
      if (s.cls === "tower") continue;
      const e = H.shipById(s.id);
      if (!e || !(rng.next() < (PU.drop[s.cls] ?? PU.drop.default))) continue;
      if (!H.isWater(e.x, e.z, 4)) continue;
      const a = rng.range(0, Math.PI * 2);
      spawn(pickKind(), { x: e.x + Math.cos(a) * 8, z: e.z + Math.sin(a) * 8 }, "wreck", PU.dropLife, { x: Math.cos(a) * PU.drift, z: Math.sin(a) * PU.drift });
    }
    // The steady ones, in view.
    if (S.t >= nextAt && !S.boarding) {
      const at = afloat.length < PU.max ? place() : null;
      if (at) spawn(pickKind(), at);
      const ev = cfg.free ? PU.freeEvery : PU.every;
      nextAt = S.t + (at ? rng.range(ev[0], ev[1]) : 6);
    }
    // Afloat: drift, sink unclaimed, or come aboard (sailed through: her hull line within RANGE m + her half-beam).
    const f = forward(P.heading);
    const ax = P.x + f.x * SHIP.half, az = P.z + f.z * SHIP.half, bx = P.x - f.x * SHIP.half, bz = P.z - f.z * SHIP.half;
    const reach = SHIP.radius + PU.range;
    for (let i = afloat.length - 1; i >= 0; i--) {
      const p = afloat[i];
      p.age += h;
      if (p.vx || p.vz) { p.x += p.vx * h; p.z += p.vz * h; p.vx *= Math.exp(-h / 20); p.vz *= Math.exp(-h / 20); }
      if (!S.boarding && Math.abs(p.x - P.x) < 40 && Math.abs(p.z - P.z) < 40 && segDist(p.x, p.z, ax, az, bx, bz).d <= reach) {
        afloat.splice(i, 1);
        take(p);
        continue;
      }
      if (p.age >= p.life) { afloat.splice(i, 1); emit("expire", p, { x: R1(p.x), z: R1(p.z), afloat: true }); }
    }
    // The buffs' clocks.
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i];
      b.t -= h;
      if (b.t <= 0) { active.splice(i, 1); emit("expire", b, { buff: true }); }
    }
  }

  // ---- What the sim reads ----------------------------------------------------------------------------

  const speedMul = () => (buff("swift_wind") ? PU.swift_wind.speed : 1);
  const reloadMul = () => (buff("quick_hands") ? PU.quick_hands.reload : 1);
  const damageMul = () => (buff("iron_hull") ? PU.iron_hull.taken : 1);
  const lootMul = () => (buff("double_doubloons") ? PU.double_doubloons.loot : 1);
  const inkSpread = () => (buff("kraken_ink") ? PU.kraken_ink.spread : 0);
  /** One of our volleys leaves: hot while Hot Shot has a charge (spends it). */
  function useHotShot() {
    const b = buff("hot_shot");
    if (!b || b.charges <= 0) return false;
    b.charges--;
    emit("use", b, { charges: b.charges });
    if (b.charges <= 0) { active.splice(active.indexOf(b), 1); emit("expire", b, { buff: true, spent: true }); }
    return true;
  }

  // ---- State, facts --------------------------------------------------------------------------------------

  const state = () => afloat.map((p) => ({ id: p.id, kind: p.kind, label: POWERUP_LABEL[p.kind], x: R1(p.x), z: R1(p.z), left: R1(Math.max(0, p.life - p.age)), from: p.from }));
  const buffs = () => active.map((b) => ({ id: b.id, kind: b.kind, label: POWERUP_LABEL[b.kind], t: R1(Math.max(0, b.t)), dur: R1(b.dur), ...(b.kind === "hot_shot" ? { charges: b.charges } : {}) }));

  const where = (p) => `${metres(dist(P.x, P.z, p.x, p.z))} ${compass8Abbr(headingOf(p.x - P.x, p.z - P.z))}`;
  const side = (p) => { const r = wrap180(headingOf(p.x - P.x, p.z - P.z) - P.heading); return Math.abs(r) <= 30 ? "dead ahead" : Math.abs(r) >= 150 ? "astern" : `off the ${r > 0 ? "starboard" : "port"} ${Math.abs(r) < 90 ? "bow" : "quarter"}`; };
  /** A spawn, as the companion hears it. */
  function factFor(p) {
    const q = afloat.find((x) => x.id === p.id) || p;
    return `${POWERUP_LABEL[q.kind]} glowing on the water ${where(q)}, ${side(q)}${q.from === "wreck" ? " where she went down" : ""}: ${POWERUP_INFO[q.kind]}. Sail through it within ~${Math.round(PU.life - (q.age || 0))} s (you can suggest it: suggest loot, target "power-up").`;
  }
  /** look_around: what's afloat and what's on us. */
  function briefLine() {
    const near = afloat.slice().sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z)).slice(0, 4);
    const on = active.map((b) => `${POWERUP_LABEL[b.kind]} ${b.kind === "hot_shot" ? `${b.charges} volley${b.charges === 1 ? "" : "s"}, ` : ""}${Math.ceil(b.t)} s left`);
    if (!near.length && !on.length) return "";
    const parts = [];
    if (near.length) parts.push(`afloat: ${near.map((p) => `${POWERUP_LABEL[p.kind]} ${where(p)} (${POWERUP_INFO[p.kind]})`).join("; ")}`);
    if (on.length) parts.push(`on us: ${on.join("; ")}`);
    return `**Power-ups:** ${parts.join(". ")}.`;
  }
  /** The nearest power-up afloat whose name / kind the words mention (or any, for "power-up"), else null. */
  function nearest(text = "") {
    const s = String(text).toLowerCase();
    const named = POWERUP_KINDS.filter((k) => s.includes(k.replace(/_/g, " ")) || s.includes(POWERUP_LABEL[k].toLowerCase()) || s.includes(k));
    const pool = afloat.filter((p) => !named.length || named.includes(p.kind));
    const p = pool.sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z))[0];
    return p ? { ...p, label: POWERUP_LABEL[p.kind] } : null;
  }

  /** Tests and debug: float one of `kind` now (at x, z or in view). */
  function force(kind, { x = null, z = null } = {}) {
    if (!POWERUP_KINDS.includes(kind)) return null;
    const at = x != null && z != null ? { x, z } : place() || { x: P.x + forward(P.heading).x * 200, z: P.z + forward(P.heading).z * 200 };
    return spawn(kind, at);
  }
  /** Tests and debug: take one of `kind` now (as if sailed through). */
  function give(kind) {
    if (!POWERUP_KINDS.includes(kind)) return null;
    const p = { id: `pw${++n}`, kind, x: P.x, z: P.z, age: 0, life: PU.life, from: "debug" };
    take(p);
    return buffs();
  }

  return {
    step, speedMul, reloadMul, damageMul, lootMul, inkSpread, useHotShot, state, buffs, factFor, briefLine, nearest, force, give,
    afloat: () => afloat, active: () => active, byId: (id) => afloat.find((p) => p.id === id) || null,
    nextAt: () => nextAt,
  };
}
