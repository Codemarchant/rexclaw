// The missions (spec v2 §2, v3 A1–A4): each mission is a short chain of steps
// (2–4) on a seeded variant of its night — one clear instruction a step, with
// a world marker (a ship, an area, a point) and its distance and compass word —
// plus the fail conditions as live counters that warn at 50% and 85%, an
// optional bonus, and the medals (time, hull, loot). The sim runs the world;
// this reads it every step.
//
//   setupMission(sim)            → the mission state (sim.S.mission) — also arms the Kraken's schedule etc.
//   checkMission(sim, h)         → {events:[objective…], end: null | {outcome:"success"|"fail", reason, failure}}
//   objectiveState(sim)          → state.objective (the current step, its marker, the steps, the bonus, the fail counters)
//   briefingFor(world)           → the briefing card's data (steps, fail conditions, medals, tip) for a generated world
//   missionInfo(id)              → the same for a title card, before any world (generic texts)
//   medalsFor(cfg, {elapsed, hull, loot}) → {time, hull, loot} tiers (gold | silver | bronze | null)
//   lootOf(sim, success)         → the gold this mission counts for its loot medal
//
// Pure: no three.js, no DOM, no Math.random.

import { MISSIONS, ARENA, MEDAL_TIERS, FORT, COVE, OBJECTIVE, BOARD, WRECKS, KRAKEN_EYE, KRAKENS_WAKE, SEA_EVENTS, FREE_ROAM } from "./const.js";
import { dist, clamp, headingOf, forward, relBearing, compass8Abbr, metres, portNormal } from "./geom.js";
import { createRng } from "./rng.js";

const CONTRABAND = 600;
const BOARD_LINE = `Disable a ship (hull ≤ 25%, masts ≤ ${BOARD.mastsMax}% or she strikes), sail into her ring (${BOARD.range} m of her hull) and press B once: take down her captain on deck`;
const CREW_MODES_LINE = "Crew modes: 1 Hold (they only reload), 2 Attack (they fire whatever bears), 3 Defend (they repair and pump)";
const mmss = (s) => { const v = Math.max(0, Math.round(s)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`; };
const ROUND1 = (v) => Math.round(v * 10) / 10;

// ---- Helpers on the live sim (ctx = {sim, S, P, W, M, v}; at briefing time S/P/sim are null) ------------------

const fleetSpec = (W, id) => W.fleet.find((f) => f.id === id) || null;
const nameOf = (c, id) => c.sim?.shipById(id)?.name || fleetSpec(c.W, id)?.name || id;
const takenSet = (c) => new Set([...c.S.stats.sunk, ...c.S.stats.captured].map((x) => x.id));
const escaped = (c, id) => c.S.stats.escaped.some((x) => x.id === id);
const captured = (c, id) => c.S.stats.captured.some((x) => x.id === id);
/** Sunk by us, taken, or gone down some other way (not escaped). */
function downOrTaken(c, id) {
  if (takenSet(c).has(id)) return true;
  const e = c.sim.shipById(id);
  return !escaped(c, id) && (!e || e.gone || e.state === "sinking");
}
const aliveShip = (c, id) => { const e = c.sim?.shipById(id); return e && c.sim.alive(e) ? e : null; };
const nearestP = (c, list) => list.sort((a, b) => dist(c.P.x, c.P.z, a.x, a.z) - dist(c.P.x, c.P.z, b.x, b.z))[0] || null;
const shipM = (id, label) => ({ kind: "ship", contactId: id, label });
const areaM = (x, z, r, label) => ({ kind: "area", x, z, r, label });
const pointM = (x, z, label) => ({ kind: "point", x, z, label });
/** How far a runner has come from her start toward the exit (0..1) and her ETA there (s). */
function runProgress(c, id) {
  const e = c.sim.shipById(id), ex = c.W.exit;
  if (!e || !ex || e.gone) return { frac: escaped(c, id) ? 1 : 0, eta: null };
  const d0 = c.M.d0[id] || 1;
  const d = Math.max(0, dist(e.x, e.z, ex.x, ex.z) - ex.r);
  return { frac: clamp(1 - d / d0, 0, 1), eta: e.state === "flee" || e.state === "patrol" ? d / Math.max(2, e.speed || 0) : null };
}
const capeOf = (W) => W.exit?.name || "the far cape";

// ---- The common fail rows ----------------------------------------------------------------------------------

const HULL_TIP = "Brace (Space) when enemy gun ports glow; switch the crew to Defend (3), or ask your companion to patch the hull and bail.";
const failHull = () => ({
  id: "hull", text: "The Rexmaw sinks (hull 0% or water 100%)", max: 100,
  value: (c) => Math.max(100 - c.P.hull, c.P.water),
  label: (c) => `Hull ${Math.round(c.P.hull)}%${c.P.water >= 20 ? `, water ${Math.round(c.P.water)}%` : ""}`,
  failText: "The Rexmaw went down.", tip: HULL_TIP, reason: "sunk",
});
const failTime = (tip, text = null) => ({
  id: "time", text: text || "Time runs out", max: 1, timed: true,
  value: (c) => clamp(c.S.t / c.S.cfg.limit, 0, 1),
  label: (c) => `${mmss(c.S.cfg.limit - c.S.t)} left`,
  eta: (c) => Math.max(0, c.S.cfg.limit - c.S.t),
  failText: "Out of time.", tip, reason: "time",
});

// ---- Bonus objectives ------------------------------------------------------------------------------------------

function bonusDef(W) {
  const b = W.variant?.bonus;
  if (!b) return null;
  const v = W.variant;
  switch (b.kind) {
    case "chest": {
      const p = W.pickups.find((q) => q.id === b.pickupId);
      return { id: "chest", text: "Haul in the treasure chest marked on the chart", marker: () => (p ? pointM(p.x, p.z, "Treasure chest") : null),
        done: (c) => !!p && !c.S.pickups.some((q) => q.id === p.id) };
    }
    case "rake": return { id: "rake", text: `Rake ${W.mission === "iron_duke" ? "her" : "a ship"} twice: fire down her bow or stern`, done: (c) => c.S.stats.rakingVolleys >= 2 };
    case "board_prize": return { id: "board_prize", text: `Board the prize ${fleetSpec(W, v.prize)?.name} rather than sink her`, marker: () => shipM(v.prize, fleetSpec(W, v.prize)?.name),
      done: (c) => captured(c, v.prize), failed: (c) => c.S.stats.sunk.some((x) => x.id === v.prize) };
    case "magazine": {
      const t = W.fort?.towers.find((q) => q.id === v.magazine);
      return { id: "magazine", text: `Silence the ${t?.name || "magazine tower"} first: her magazine`, marker: () => shipM(v.magazine, t?.name),
        done: (c) => c.M.firstTower === v.magazine, failed: (c) => !!c.M.firstTower && c.M.firstTower !== v.magazine };
    }
    case "gunboats": return { id: "gunboats", text: "Sink two of the harassing gunboats", done: (c) => c.S.stats.sunk.filter((x) => x.cls === "gunboat").length >= 2 };
    case "board_chest": return { id: "board_chest", text: `Board the chest brig ${fleetSpec(W, v.chest)?.name} too`, marker: () => shipM(v.chest, fleetSpec(W, v.chest)?.name),
      done: (c) => captured(c, v.chest), failed: (c) => c.S.stats.sunk.some((x) => x.id === v.chest) || escaped(c, v.chest) };
    case "sink_frigate": return { id: "sink_frigate", text: `Sink the escort frigate ${fleetSpec(W, "f1")?.name} too`, marker: () => shipM("f1", fleetSpec(W, "f1")?.name),
      done: (c) => takenSet(c).has("f1"), failed: (c) => escaped(c, "f1") };
    case "chain": return { id: "chain", text: "Chain her masts below 50% (bow chasers, looking ahead)", done: (c) => { const e = c.sim.shipById("d1"); return !!e && e.masts < 50; } };
    case "unseen": return { id: "unseen", text: "Reach the cove without being spotted", atEnd: true, done: (c) => c.S.stats.spotted === 0, failed: (c) => c.S.stats.spotted > 0 };
    case "hull": return { id: "hull_60", text: "Finish with the hull above 60%", atEnd: true, done: (c) => c.P.hull >= 60 };
    case "repel": return { id: "repel", text: "Beat off the Kraken's grab: all four arms off the rails", done: (c) => (c.M.kw ? c.M.kw.grabsBeaten >= 1 : c.S.stats.krakenRepelled >= 1) };
    case "arms": return { id: "arms", text: "Shoot off four of the Kraken's rising arms", done: (c) => (c.M.kw?.armsDown || 0) >= 4 };
    case "guards": {
      const ids = W.fleet.filter((f) => f.role === "guard").map((f) => f.id);
      return { id: "guards", text: `Sink the wreck's guards (${ids.length === 1 ? fleetSpec(W, ids[0])?.name : `${ids.length} gunboats`})`,
        marker: (c) => { const e = c.S ? ids.map((id) => aliveShip(c, id)).find(Boolean) : null; return e ? shipM(e.id, e.name) : null; },
        done: (c) => ids.length > 0 && ids.every((id) => takenSet(c).has(id)), failed: (c) => ids.some((id) => escaped(c, id)) };
    }
    default: return null;
  }
}

// ---- The chains -------------------------------------------------------------------------------------------------
// A step: {id, generic, text(c), hint, marker(c) → spec | null, done(c), count?(c) → {count, need}}.
// A fail row: {id, text, max, value(c), label(c), eta?(c), fatal?(c), failText, tip, reason}.

const DEFS = {
  spice_fleet: {
    summary: (W) => `Take two of the three spice merchants, the prize ${fleetSpec(W, W.variant.prize)?.name} first, before they round ${capeOf(W)}.`,
    tip: "Chain shot from the bow chasers (look ahead) slows a runner; Sprint (Shift) to close.",
    timeTip: "Intercept early: the fleet is slow, but it never stops.",
    steps: (W) => {
      const v = W.variant, prize = v.prize;
      const merchants = W.fleet.filter((f) => f.role === "objective").map((f) => f.id);
      const left = (c) => merchants.filter((id) => !downOrTaken(c, id) && !escaped(c, id)).map((id) => c.sim.shipById(id)).filter(Boolean);
      return [
        { id: "intercept", generic: "Intercept the spice fleet", text: () => "Intercept the spice fleet", hint: `They run for ${capeOf(W)}; the prize is ${fleetSpec(W, prize)?.name}.`,
          marker: (c) => (downOrTaken(c, prize) || escaped(c, prize) ? (nearestP(c, left(c)) ? shipM(nearestP(c, left(c)).id, "Spice fleet") : null) : shipM(prize, "Spice fleet")),
          done: (c) => merchants.some((id) => { const e = c.sim.shipById(id); return downOrTaken(c, id) || (e && !e.gone && (e.provoked || dist(c.P.x, c.P.z, e.x, e.z) < 450)); }) },
        { id: "take_prize", generic: "Take the prize merchant: sink her, or board her", text: (c) => `Take the prize ${nameOf(c, prize)}: sink her, or bring her to 25% and board`,
          hint: "Chain shot cuts her masts; at 25% hull or masts below 20%, come alongside and press B.",
          marker: (c) => shipM(prize, nameOf(c, prize)), done: (c) => downOrTaken(c, prize) },
        { id: "take_more", generic: "Take one more spice merchant before the cape", text: () => `Take one more spice merchant before ${capeOf(W)}`,
          hint: "Sink her or board her: any of the other two counts.",
          marker: (c) => { const e = nearestP(c, left(c)); return e ? shipM(e.id, e.name) : null; },
          count: (c) => ({ count: Math.min(2, merchants.filter((id) => downOrTaken(c, id)).length), need: 2 }),
          done: (c) => merchants.filter((id) => downOrTaken(c, id)).length >= 2 },
      ];
    },
    fails: (W) => {
      const v = W.variant, prize = v.prize, pname = fleetSpec(W, prize)?.name;
      const merchants = W.fleet.filter((f) => f.role === "objective").map((f) => f.id);
      const tip = "Chain shot from the bow chasers (look ahead) cuts a runner's masts; Sprint (Shift) to close the gap.";
      return [
        { id: "prize_escape", text: `The prize ${pname} rounds ${capeOf(W)}`, max: 1,
          value: (c) => (downOrTaken(c, prize) ? 0 : runProgress(c, prize).frac),
          label: (c) => { if (downOrTaken(c, prize)) return `${pname} taken`; const r = runProgress(c, prize); return r.eta != null ? `${pname} at the cape in ~${mmss(r.eta)}` : `${pname} ${Math.round(r.frac * 100)}% of the way`; },
          eta: (c) => (downOrTaken(c, prize) ? null : runProgress(c, prize).eta),
          fatal: (c) => escaped(c, prize), failText: `${pname} rounded ${capeOf(W)} with the spice.`, tip, reason: "escaped" },
        { id: "escaped", text: "Two spice merchants escape", max: 2,
          value: (c) => merchants.filter((id) => escaped(c, id)).length,
          label: (c) => `Escaped ${merchants.filter((id) => escaped(c, id)).length}/2`,
          fatal: (c) => merchants.filter((id) => escaped(c, id)).length >= 2, failText: `Two of the fleet got away round ${capeOf(W)}.`, tip, reason: "escaped" },
      ];
    },
  },

  silence_fort: {
    summary: (W) => `Silence the fort's ${W.fort?.towers.length || 4} gun towers. Gunboats will harass you; when half the towers fall the garrison sends out ${W.variant?.sally === "brig" ? "a brig" : W.variant?.sally === "fireship" ? "a fire ship" : "more gunboats"}.`,
    tip: "Mortars (M, or aim past 330 m) from outside the towers' 380 m range: two shells drop a tower. Heavy shot inside 90 m does it in one volley; round shot takes a while on stone.",
    timeTip: "Mortars from the firing point break a tower in a few salvoes; don't trade round shot with stone.",
    steps: (W) => {
      const fort = W.fort;
      const towers = fort.towers.map((t) => t.id);
      // The firing point: outside the guns, on the variant's side of the fort's seaward face.
      const hp = headingOf(W.port.x - fort.x, W.port.z - fort.z) + (W.variant.approach === "west" ? 35 : W.variant.approach === "east" ? -35 : 0);
      const f = forward(hp);
      const pt = { x: Math.round(fort.x + f.x * 470), z: Math.round(fort.z + f.z * 470) };
      const standing = (c) => towers.map((id) => c.sim.shipById(id)).filter((e) => e && !e.down);
      return [
        { id: "approach", generic: "Sail to the firing point off the fort", text: () => "Sail to the firing point off the fort (outside its 380 m guns)",
          hint: "The towers' guns reach 380 m; mortars reach 600 m.", marker: () => areaM(pt.x, pt.z, 70, "Firing point"),
          done: (c) => dist(c.P.x, c.P.z, pt.x, pt.z) < 90 || standing(c).some((e) => dist(c.P.x, c.P.z, e.x, e.z) < 520) || standing(c).length < towers.length },
        { id: "towers", generic: "Destroy the fort's gun towers", text: (c) => `Destroy the fort's gun towers${c.S ? `: ${standing(c).length} standing${c.M?.sallied ? `; the garrison's ${c.M.sallied} ${c.M.sallied === "gunboats" ? "are" : "is"} out` : ""}` : ""}`,
          hint: "Mortars (M) from outside 380 m; heavy shot inside 90 m. Brace when a tower's guns glow; when one falls the others duck for a few seconds.",
          marker: (c) => { const e = nearestP(c, standing(c)); return e ? shipM(e.id, e.name) : null; },
          count: (c) => ({ count: towers.length - standing(c).length, need: towers.length }), done: (c) => standing(c).length === 0 },
      ];
    },
    fails: () => [],
  },

  navy_convoy: {
    summary: (W) => (W.variant.goal === "frigate"
      ? `Sink the escort frigate ${fleetSpec(W, "f1")?.name} before the convoy reaches ${capeOf(W)}.`
      : `Take the paymaster's chest: board the brig ${fleetSpec(W, W.variant.chest)?.name} before the convoy reaches ${capeOf(W)}. Don't sink her.`)
      + ` Once attacked, the convoy calls for ${W.variant.relief === "fireship" ? "its fire ship" : "the cape's gunboats"}.`,
    tip: "Keep a ship abeam at ~150 m and fire on the roll; chain shot (look ahead) slows a runner without sinking her.",
    timeTip: "Cut across the convoy's course early; they don't wait for you.",
    steps: (W) => {
      const v = W.variant, fr = "f1", ch = v.chest;
      const convoy = W.fleet.map((f) => f.id);
      const intercept = { id: "intercept", generic: "Intercept the navy convoy", text: () => "Intercept the navy convoy", hint: `They run for ${capeOf(W)}.`,
        marker: (c) => shipM(v.goal === "frigate" ? fr : ch, "Convoy"),
        done: (c) => convoy.some((id) => { const e = c.sim.shipById(id); return downOrTaken(c, id) || (e && !e.gone && (e.provoked || dist(c.P.x, c.P.z, e.x, e.z) < 450)); }) };
      if (v.goal === "frigate") {
        return [intercept,
          { id: "sink_frigate", generic: "Sink the escort frigate", text: (c) => `Sink the escort frigate ${nameOf(c, fr)}`, hint: "Hold her abeam at ~150 m; brace when her ports glow.",
            marker: (c) => shipM(fr, nameOf(c, fr)), done: (c) => downOrTaken(c, fr) }];
      }
      const beaten = (c) => { const e = c.sim.shipById(ch); return captured(c, ch) || (!!e && !e.gone && (e.state === "surrender" || e.hull / e.hullMax <= BOARD.hullFrac || e.masts <= BOARD.mastsMax)); };
      return [intercept,
        { id: "disable", generic: "Disable the chest brig: hull to 25% or chain her masts", text: (c) => `Disable the chest brig ${nameOf(c, ch)}: hull to 25% or chain her masts`,
          hint: "Chain shot from the bow chasers cuts masts without sinking her.", marker: (c) => shipM(ch, nameOf(c, ch)), done: beaten },
        { id: "board", generic: "Board the chest brig", text: (c) => `Board ${nameOf(c, ch)}: sail into her ring and press B`,
          hint: "Inside the ring round her hull, one press of B grapples her (not at full speed into her); then take down her captain.", marker: (c) => shipM(ch, nameOf(c, ch)), done: (c) => captured(c, ch) }];
    },
    fails: (W) => {
      const v = W.variant, fr = "f1", ch = v.chest;
      const tip = "Get across their course early; chain shot (look ahead) slows a runner.";
      if (v.goal === "frigate") {
        const nm = fleetSpec(W, fr)?.name;
        return [{ id: "frigate_escape", text: `The frigate ${nm} reaches ${capeOf(W)}`, max: 1,
          value: (c) => (downOrTaken(c, fr) ? 0 : runProgress(c, fr).frac), label: (c) => `${nm} ${Math.round(runProgress(c, fr).frac * 100)}% of the way`,
          eta: (c) => runProgress(c, fr).eta, fatal: (c) => escaped(c, fr), failText: `${nm} made ${capeOf(W)} with the convoy.`, tip, reason: "escaped" }];
      }
      const nm = fleetSpec(W, ch)?.name;
      const lost = (c) => !captured(c, ch) && !escaped(c, ch) && downOrTaken(c, ch);
      return [
        { id: "chest_escape", text: `${nm} reaches ${capeOf(W)}`, max: 1, value: (c) => (captured(c, ch) ? 0 : runProgress(c, ch).frac),
          label: (c) => { const r = runProgress(c, ch); return r.eta != null ? `${nm} at the cape in ~${mmss(r.eta)}` : `${nm} ${Math.round(r.frac * 100)}% of the way`; },
          eta: (c) => runProgress(c, ch).eta, fatal: (c) => escaped(c, ch), failText: `${nm} made ${capeOf(W)} with the chest.`, tip, reason: "escaped" },
        { id: "chest_lost", text: `The chest goes down with ${nm}`, max: 1, value: (c) => (lost(c) ? 1 : 0),
          label: (c) => { const e = c.sim.shipById(ch); return e && !e.gone ? `${nm}: hull ${Math.round((e.hull / e.hullMax) * 100)}%` : nm; },
          fatal: lost, failText: `${nm} sank with the paymaster's chest.`, tip: "Stop the round shot near 30% hull: chain her masts and board her.", reason: "lost" },
      ];
    },
  },

  iron_duke: {
    summary: () => "Sink the man-o'-war Iron Duke in open water. She fights in three phases: broadsides, mortars, ram runs.",
    tip: "Keep her abeam and brace when her three decks glow; when rings appear on the water, keep moving.",
    timeTip: "Stay close enough to hit her every reload: 150–200 m abeam.",
    steps: () => {
      const D = "d1";
      const frac = (c) => { const e = c.sim.shipById(D); return e ? e.hull / e.hullMax : 0; };
      const sunk = (c) => !aliveShip(c, D);
      return [
        { id: "close", generic: "Sail out to meet the Iron Duke", text: () => "Sail out to meet the Iron Duke", hint: "She out-guns you: never cross her bow or stern within 200 m.",
          marker: () => shipM(D, "Iron Duke"), done: (c) => { const e = c.sim.shipById(D); return sunk(c) || (!!e && (e.lastHitByRexmawT > -1e8 || dist(c.P.x, c.P.z, e.x, e.z) < 500)); } },
        { id: "broadsides", generic: "Break her broadsides: her hull below 66%", text: () => "Break her broadsides: bring her hull below 66%", hint: "Fire on the roll; brace when her ports glow.",
          marker: () => shipM(D, "Iron Duke"), done: (c) => sunk(c) || frac(c) <= 0.66 },
        { id: "mortars", generic: "Dodge her mortars: her hull below 33%", text: () => "She's firing mortars: dodge the rings and bring her below 33%", hint: "A ring on the water is a shell landing in ~4 s: change course.",
          marker: () => shipM(D, "Iron Duke"), done: (c) => sunk(c) || frac(c) <= 0.33 },
        { id: "sink", generic: "Sink the Iron Duke", text: () => "Sink the Iron Duke: she rams now, keep her abeam", hint: "Turn away from a ram run; after each run she loses way for a few seconds with her ports shut: rake her then.",
          marker: () => shipM(D, "Iron Duke"), done: sunk },
      ];
    },
    fails: () => [],
  },

  smugglers_run: {
    summary: (W) => `Carry the contraband through the fog and the reef maze to the smugglers' cove under ${W.islands.find((i) => i.id === W.cove?.island)?.name || "the north island"}, and stop inside it. Navy patrols sweep lanterns between the rows.`,
    tip: "Your chart can't show the reefs at night: ask your companion for headings and danger marks. Stay out of the lantern cones.",
    timeTip: "Keep half sail through the maze and let your companion call the gaps.",
    steps: (W) => {
      const cv = W.cove, row = W.maze?.[0], en = W.variant.entry || (row?.gaps?.[0]) || { x: 0, z: 400 };
      const pastRow = (c) => !row || c.P.z > row.z + (row.tilt || 0) * c.P.x + 30;
      const inCove = (c) => dist(c.P.x, c.P.z, cv.x, cv.z) < cv.r;
      return [
        { id: "gap", generic: "Slip through the first reef row at the gap", text: () => "Slip through the first reef row at the gap", hint: "Only your companion's chart shows the reefs at night: ask for a heading.",
          marker: () => areaM(en.x, en.z, 55, "Gap in the reef"), done: (c) => pastRow(c) || inCove(c) },
        { id: "cove", generic: "Thread the maze to the smugglers' cove", text: () => "Thread the maze to the smugglers' cove", hint: "Patrol lanterns sweep between the rows: keep out of the beams.",
          marker: () => areaM(cv.x, cv.z, cv.r, "Smugglers' cove"), done: inCove },
        { id: "heave_to", generic: "Heave to in the cove", text: () => `Heave to in the cove: below ${COVE.speed} m/s for ${COVE.s} s`, hint: "Furl the sails (S) inside the ring.",
          marker: () => areaM(cv.x, cv.z, cv.r, "Smugglers' cove"), done: (c) => c.M.coveT >= COVE.s },
      ];
    },
    fails: () => [{ id: "spotted", text: "Spotted by the patrols 3 times", max: 3, value: (c) => c.S.stats.spotted,
      label: (c) => `Spotted ${c.S.stats.spotted}/3`, fatal: (c) => c.S.stats.spotted >= 3,
      failText: "The patrols spotted us three times; the navy closed the cove.", tip: "Watch the lantern beams sweep and cross behind them; let your companion call headings through the gaps.", reason: "spotted" }],
  },

  the_gloam: {
    summary: () => "Sink The Gloam. She hides in her own fog, slips round you and comes out of it to ram.",
    tip: "When she vanishes, your companion's lookout still follows her wake: ask where she is, and brace for the ram.",
    timeTip: "Hit her every time she's in the open; she only fights for ~24 s before she cloaks again.",
    steps: () => {
      const G = "gl1";
      const frac = (c) => { const e = c.sim.shipById(G); return e ? e.hull / e.hullMax : 0; };
      const sunk = (c) => !aliveShip(c, G);
      return [
        { id: "find", generic: "Find The Gloam in the fog", text: () => "Find The Gloam in the fog", hint: "The marker is where she was last seen; your companion's lookout follows her wake.",
          marker: () => shipM(G, "The Gloam"), done: (c) => sunk(c) || !!c.M.found[G] },
        { id: "wound", generic: "Bring The Gloam below half hull", text: () => "Bring The Gloam below half hull: she cloaks, then rams out of the fog", hint: "When she vanishes, turn your bow away from her wake and brace.",
          marker: () => shipM(G, "The Gloam"), done: (c) => sunk(c) || frac(c) <= 0.5 },
        { id: "sink", generic: "Sink The Gloam", text: () => "Sink The Gloam", hint: "After each ram run she wallows, ports shut, for a few seconds: heavy shot (no aim, inside 90 m) hits hardest then.",
          marker: () => shipM(G, "The Gloam"), done: sunk },
      ];
    },
    fails: () => [],
  },

  // v5: salvage under threat (arms across her course, the grab at the first wreck, guards and arms at the second; the divers
  // only work with the rails clear), the Kraken's eye (three wounds), then the run home through rising arms (and, by the
  // night's variant, navy cutters or a fire ship off the harbour mouth). The director is krakensWake() below.
  krakens_wake: {
    summary: (W) => `Salvage the two wrecks (stop beside each one; ${W.variant?.guard === "brig" ? "a navy brig guards" : "navy gunboats guard"} the far one), drive the Kraken off when it rises (hit its eye three times), then run for the harbour mouth. Its arms come up round the wrecks and across your course: shoot them off.`,
    tip: "Shoot the arms before they reach you (an aimed broadside or the swivel); the divers only work with the rails clear. When the eye surfaces, put every gun on it.",
    timeTip: "Sail straight to each wreck and stop right beside it; fight the eye from broadside range, then sprint home.",
    steps: (W) => {
      const left = (c) => W.wrecks.filter((w) => !c.S.salvaged.has(w.id));
      const guarded = W.variant?.guardWreck;
      const wreckLabel = (w) => (w.id === guarded ? "Guarded wreck" : "Wreck");
      const wreckM = (c) => { if (!c.S) return W.wrecks[0] ? pointM(W.wrecks[0].x, W.wrecks[0].z, "Wreck") : null; const w = nearestP(c, left(c)); return w ? pointM(w.x, w.z, wreckLabel(w)) : null; };
      const salvageText = (c, head) => {
        const sv = c.S?.salvage;
        if (!sv) return `${head}: stop beside her (under ${WRECKS.salvageSpeed} m/s) for ${WRECKS.salvageS} s`;
        if (c.M?.kw?.held) return c.S.hazards.kraken?.stage === "ink" ? `${head}: ink in the water — the divers wait` : `${head}: the divers wait — shoot the arms off`;
        return `${head}: divers down, ${Math.max(1, Math.ceil(sv.dur - sv.t))} s`;
      };
      const eyeOf = (c) => c.S?.hazards.eye || null;
      const eyeText = (c) => {
        const E = eyeOf(c);
        if (!E) return "Drive off the Kraken: hit its eye when it surfaces";
        if (E.stage === "up") return "The Kraken's eye is up: put every gun on it";
        if (E.stage === "rise") return "The Kraken is surfacing: lay your guns on the eye";
        return "The eye's gone under: shoot its arms, watch for the wave, and be ready where it rises";
      };
      const ex = W.exit;
      return [
        { id: "wreck1", generic: "Salvage a wreck: stop beside her", text: (c) => salvageText(c, "Salvage a wreck"),
          hint: "Arms rise round the wrecks and grab the rails: the swivel (click an arm), an aimed broadside, or an unaimed volley down that side knocks them off. The divers wait while they hold on.",
          marker: wreckM, done: (c) => c.S.salvaged.size >= 1 },
        { id: "wreck2", generic: "Salvage the guarded wreck", text: (c) => salvageText(c, `Salvage the ${guarded && c.S && !c.S.salvaged.has(guarded) ? "guarded" : "second"} wreck`),
          hint: `${W.variant?.guard === "brig" ? "A navy brig" : "Two navy gunboats"} guard the far wreck, and arms rise round her: clear them, then stop alongside.`,
          marker: wreckM, done: (c) => c.S.salvaged.size >= Math.min(2, W.wrecks.length) },
        { id: "eye", generic: "Drive off the Kraken: hit its eye when it surfaces", text: eyeText,
          hint: `While it's up the eye is your locked target: look its way and click, the guns lay themselves on it. Shot landing within ${KRAKEN_EYE.hitR} m hurts it (mortars and the swivel too); about two good broadsides in one surfacing drive it under. Three wounds and it's gone.`,
          marker: (c) => { const E = eyeOf(c); if (!E) return null; const at = E.next || E; return areaM(at.x, at.z, E.r, E.stage === "up" || E.stage === "rise" ? "The Kraken's eye" : "Where it will rise"); },
          count: (c) => ({ count: c.M?.kw?.wounds || 0, need: KRAKEN_EYE.wounds }), done: (c) => !!c.M?.kw?.eyeGone },
        { id: "out", generic: "Run for the harbour mouth", text: () => "Run for the harbour mouth", hint: "Sprint (Shift) at full sail; arms rise ahead of you: steer round them or shoot them.",
          marker: () => (ex ? areaM(ex.x, ex.z, ex.r, "Harbour mouth") : null), done: (c) => !!ex && dist(c.P.x, c.P.z, ex.x, ex.z) < ex.r },
      ];
    },
    fails: () => [],
  },
};

function freeDef(id) {
  const word = id === "free_day" ? "sunset" : "dawn";
  return {
    summary: () => `Free roam: take what you can and bank it at home port before ${word}. Unbanked plunder is lost when the light goes. Side jobs turn up as you sail (a bounty, a prize to board, a wreck, a chest adrift).`,
    tip: "Merchants carry the gold; heat brings hunters, and a full hold draws a cutter on the way home. Bank often: stop in the harbour.",
    timeTip: `Be back in the harbour before ${word}.`,
    free: true,
    steps: (W) => {
      const conv = W.pois.find((p) => p.kind === "convoy");
      const prey = (c) => { const e = nearestP(c, c.S.ships.filter((x) => x.cls === "merchant" && !x.derelict && c.sim.alive(x) && x.detected && x.state !== "surrender")); return e ? shipM(e.id, e.name) : conv ? areaM(conv.x, conv.z, 120, "Convoy route") : null; };
      const portM = () => areaM(W.port.x, W.port.z, W.port.r, "Home port");
      return [
        { id: "plunder", generic: "Take plunder: sink or board a merchant", text: () => "Take plunder: sink or board a merchant", hint: "Sunk ships spill their cargo: sail through it.",
          marker: (c) => (c.S ? prey(c) : conv ? areaM(conv.x, conv.z, 120, "Convoy route") : null), done: (c) => c.S.plunder.loot > 0 },
        { id: "bank", generic: "Bank it: stop in home port", text: () => `Bank it: stop in home port (under 3 m/s)`, hint: "Banked gold is safe; the hold is lost if the light goes.",
          marker: portM, done: (c) => c.S.plunder.banked > 0 },
        { id: "more", generic: `Keep raiding; bank again before ${word}`, text: () => `Keep raiding; bank again before ${word} (R in port ends the night)`, hint: "Heat brings hunters: bank to cool it.",
          marker: (c) => (c.S && c.S.plunder.hold > 0 ? portM() : c.S ? prey(c) : null), done: () => false, open: true },
      ];
    },
    fails: () => [],
    timeText: `${word[0].toUpperCase() + word.slice(1)}: unbanked plunder is lost`,
  };
}
DEFS.free_day = freeDef("free_day");
DEFS.free_night = freeDef("free_night");
DEFS.arena = {
  summary: () => "Duel.", tip: "", timeTip: "",
  steps: () => [{ id: "duel", generic: "Beat her", text: () => "Beat her", hint: "", marker: () => shipM("x1", "Enemy"), done: () => false, open: true }],
  fails: () => [],
};

const defOf = (id) => DEFS[id] || DEFS.arena;

// ---- Setup, the check, the state ------------------------------------------------------------------------------

export function setupMission(sim) {
  const S = sim.S, cfg = sim.cfg, W = sim.world, id = cfg.id;
  const def = defOf(id);
  const steps = def.steps(W).map((s) => ({ ...s, done: false }));
  const timeRow = id === "arena" ? [] : [failTime(def.timeTip, def.timeText)];
  const fails = [failHull(), ...def.fails(W), ...timeRow].map((f) => ({ ...f, warn: 0 }));
  const b = bonusOf(W);
  const M = {
    id, status: "active", reason: null, failure: null, step: 0, started: false, steps, fails, def,
    bonus: b ? { ...b, done: false, failed: false, reward: OBJECTIVE.bonusGold } : null,
    objectives: [], coveT: 0, gunboatT: FORT.gunboatEvery, phase: 1, seen: {}, found: {}, d0: {}, firstTower: null, lastCount: {},
  };
  for (const e of S.ships) {
    M.seen[e.id] = { x: e.x, z: e.z };
    if (W.exit) M.d0[e.id] = Math.max(1, dist(e.x, e.z, W.exit.x, W.exit.z) - W.exit.r);
  }
  if (id === "smugglers_run") S.contraband = CONTRABAND;
  // v5: the mission directors' seeded draws come from their own stream (the world's seed), never the sim's.
  M.rng = createRng(W.seed ?? 1).fork(`director:${id}`);
  Object.defineProperty(M, "rng", { enumerable: false });
  if (id === "krakens_wake") {
    S.kraken.again = false;   // v5: the director decides when the Kraken grabs
    const KW = KRAKENS_WAKE;
    M.kw = { ambushAt: M.rng.range(KW.firstAmbush[0], KW.firstAmbush[1]), ambushDone: false, legAmbushed: {}, grabbed: false, firstWreck: null, wreckArmsAt: {},
      held: false, wounds: 0, eyeGone: false, attackN: 0, attacks: W.variant?.attacks || ["arms", "wave", "grab"], escape: null, escapeNext: null,
      arms: {}, armsDown: 0, grabsBeaten: 0, grabsSeen: 0 };
  }
  if (cfg.free) M.free = freeSetup(sim, M);
  S.mission = M;
  syncObjectives(M);
  return M;
}

/** v2's tracker rows (state.mission.objectives / results.objectives): one per step + the bonus. */
function syncObjectives(M, c = null) {
  M.objectives = M.steps.map((s, i) => {
    const n = c && s.count ? s.count(c) : null;
    return { id: s.id, text: c ? s.text(c) : s.generic, count: n ? n.count : s.done ? 1 : 0, of: n ? n.need : 1, done: s.done, failed: M.status === "fail" && !s.done && i === M.step, active: i === M.step && M.status === "active" };
  });
  if (M.bonus) M.objectives.push({ id: `bonus:${M.bonus.id}`, text: M.bonus.text, count: M.bonus.done ? 1 : 0, of: 1, done: M.bonus.done, failed: M.bonus.failed, optional: true });
}

const ctxOf = (sim) => ({ sim, S: sim.S, P: sim.S.ship, W: sim.world, M: sim.S.mission, v: sim.world.variant || {} });

/** One check: the steps, the bonus, the fail counters and their warnings, the mission's own machinery, success and failure. */
export function checkMission(sim, h) {
  const S = sim.S, cfg = sim.cfg, M = S.mission, ev = [];
  if (!M || M.status !== "active") return { events: ev, end: null };
  const c = ctxOf(sim);
  const P = S.ship;
  let end = null;

  // Last-seen positions for ship markers (fog, the Gloam's cloak).
  for (const e of S.ships) if (!e.gone && e.detected && !e.cloaked) { M.seen[e.id] = { x: e.x, z: e.z }; M.found[e.id] = true; }
  if (!M.firstTower) { const t = S.stats.sunk.find((x) => x.cls === "tower"); if (t) M.firstTower = t.id; }

  // The mission's machinery.
  if (cfg.id === "silence_fort") {
    M.gunboatT -= h;
    const standing = S.ships.filter((e) => e.cls === "tower" && !e.down).length;
    if (M.gunboatT <= 0 && standing > 0) {
      M.gunboatT = FORT.gunboatEvery;
      const live = S.ships.filter((e) => e.cls === "gunboat" && sim.alive(e)).length;
      const fort = sim.world.fort;
      if (live <= FORT.gunboatMax - 2 && fort) for (let i = 0; i < 2; i++) sim.spawnShip("gunboat", "harass", { x: fort.x, z: fort.z - 160, r: 60 + i * 30 }, { role: "harass" });
    }
    // v5: half the towers down → the garrison sends out the night's reinforcement (variant.sally).
    const towersAll = S.ships.filter((e) => e.cls === "tower");
    if (!M.sallied && standing > 0 && towersAll.length - standing >= FORT.sallyAt && sim.world.fort) {
      const fort = sim.world.fort, kind = sim.world.variant?.sally || "gunboats";
      const near = (i) => ({ x: fort.x, z: fort.z - 170, r: 70 + i * 40 });
      if (kind === "brig") sim.spawnShip("brig", "harass", near(0), { role: "harass" });
      else if (kind === "fireship") sim.spawnShip("fireship", "harass", near(0), { role: "harass" });
      else for (let i = 0; i < 2; i++) sim.spawnShip("gunboat", "harass", near(i), { role: "harass" });
      M.sallied = kind === "fireship" ? "fire ship" : kind;
    }
  }
  if (cfg.id === "iron_duke") { const d = S.ships.find((e) => e.cls === "manowar"); if (d) M.phase = d.phase || 1; }
  // v5: the convoy calls for help RELIEF_S s after she's first attacked (the night's variant: the cape's gunboats, or a fire ship).
  if (cfg.id === "navy_convoy" && !M.relieved) {
    const W = sim.world, conv = S.ships.filter((e) => ["convoy", "escort"].includes(e.role) && sim.alive(e));
    if (M.attackedT == null && conv.some((e) => e.provoked)) M.attackedT = S.t;
    if (M.attackedT != null && S.t >= M.attackedT + OBJECTIVE.reliefS && conv.length) {
      M.relieved = W.variant?.relief || "gunboats";
      const lead = conv.slice().sort((a, b) => dist(a.x, a.z, P.x, P.z) - dist(b.x, b.z, P.x, P.z))[0];
      if (M.relieved === "fireship") sim.spawnShip("fireship", "harass", { x: lead.x, z: lead.z, r: 90 }, { role: "harass" });
      else if (W.exit) for (let i = 0; i < 2; i++) sim.spawnShip("gunboat", "harass", { x: (W.exit.x + lead.x) / 2, z: (W.exit.z + lead.z) / 2, r: 60 + i * 40 }, { role: "harass" });
    }
  }
  if (cfg.id === "smugglers_run") {
    const cv = sim.world.cove;
    if (cv && dist(P.x, P.z, cv.x, cv.z) < cv.r && P.speed < COVE.speed) M.coveT += h; else M.coveT = 0;
  }
  if (cfg.id === "krakens_wake" && M.kw) krakensWake(sim, c, h, ev);
  if (cfg.free && M.free) freeRoam(sim, c, h, ev);

  // The chain: the current step, and on through any already done.
  const stepEv = (stage, s, i, extra = {}) => ({ type: "objective", stage, id: s.id, step: i + 1, of: M.steps.length, text: s.text(c), ...extra });
  if (!M.started) { M.started = true; ev.push(stepEv("start", M.steps[0], 0, { marker: markerOut(c, M.steps[0].marker(c)) })); }
  for (let guard = 0; guard < M.steps.length && M.step < M.steps.length; guard++) {
    const s = M.steps[M.step];
    if (s.count) {
      const n = s.count(c);
      if (M.lastCount[s.id] != null && n.count !== M.lastCount[s.id]) ev.push(stepEv("progress", s, M.step, { count: n.count, need: n.need }));
      M.lastCount[s.id] = n.count;
    }
    if (s.open || !s.done && !s.done_(c)) break;
    s.done = true;
    ev.push(stepEv("done", s, M.step));
    M.step++;
    if (M.step < M.steps.length) { const nx = M.steps[M.step]; ev.push(stepEv("start", nx, M.step, { marker: markerOut(c, nx.marker(c)) })); }
  }
  const allDone = M.steps.every((s) => s.done);
  if (allDone) end = { outcome: "success", reason: "objective" };

  // The bonus.
  const B = M.bonus;
  if (B && !B.done && !B.failed) {
    if (B.failed_?.(c)) { B.failed = true; ev.push({ type: "objective", stage: "fail", id: B.id, bonus: true, text: B.text, tip: null }); }
    else if ((!B.atEnd || end) && B.done_(c)) {
      B.done = true;
      sim.gainPlunder(B.reward, "bonus");
      ev.push({ type: "objective", stage: "done", id: B.id, bonus: true, text: B.text, reward: B.reward });
    }
  }

  // The fail counters: warnings at 50% and 85%, and the fatal ones.
  for (const f of M.fails) {
    if (end) break;
    const frac = clamp(f.value(c) / f.max, 0, 1);
    for (const lv of OBJECTIVE.warn) {
      if (frac >= lv && f.warn < lv) { f.warn = lv; ev.push({ type: "objective", stage: "warn", id: f.id, level: lv, text: f.text, label: f.label(c) }); }
    }
    if (f.warn > 0 && frac < f.warn - 0.15) f.warn = OBJECTIVE.warn.filter((lv) => frac >= lv).pop() || 0;   // repaired: re-arm
    if (f.fatal?.(c)) end = { outcome: "fail", reason: f.reason, failure: { id: f.id, text: f.failText, tip: f.tip } };
  }
  if (!end && S.sunk) { const f = M.fails.find((x) => x.id === "hull"); end = { outcome: "fail", reason: "sunk", failure: { id: "hull", text: f.failText, tip: f.tip } }; }
  if (!end && S.t >= cfg.limit) {
    const f = M.fails.find((x) => x.id === "time") || failTime(M.def.timeTip);
    if (cfg.free) end = { outcome: P.inHarbour || S.plunder.banked > 0 ? "success" : "fail", reason: P.inHarbour ? "home" : "time" };
    else end = { outcome: "fail", reason: "time" };
    if (end.outcome === "fail") end.failure = { id: "time", text: cfg.free ? `${f.text.split(":")[0]} came with nothing banked.` : f.failText, tip: f.tip };
  }
  if (end?.outcome === "fail") {
    ev.push({ type: "objective", stage: "fail", id: end.failure?.id || end.reason, text: end.failure?.text || end.reason, tip: end.failure?.tip || null });
    if (B && !B.done && !B.failed) B.failed = true;
  }
  if (end && end.outcome === "success" && B && !B.done && !B.failed && B.atEnd) {
    if (B.done_(c)) { B.done = true; sim.gainPlunder(B.reward, "bonus"); ev.push({ type: "objective", stage: "done", id: B.id, bonus: true, text: B.text, reward: B.reward }); }
    else { B.failed = true; ev.push({ type: "objective", stage: "fail", id: B.id, bonus: true, text: B.text, tip: null }); }
  }
  if (end) { M.status = end.outcome; M.reason = end.reason; M.failure = end.failure || null; }
  syncObjectives(M, c);
  return { events: ev, end };
}

// ---- v5 directors -------------------------------------------------------------------------------------------------

const inBay = (W, x, z, m) => x > W.bounds.minX + m && x < W.bounds.maxX - m && z > W.bounds.minZ + m && z < W.bounds.maxZ - m;
/** Raise a lone Kraken arm (the sea event: telegraphed, drawn, shot off) near (x, z), nudged onto open water. → its event or null. */
function raiseArm(sim, K, x, z) {
  const W = sim.world;
  const spots = [[0, 0]];
  for (const rr of [30, 60, 95, 130]) for (let k = 0; k < 8; k++) spots.push([Math.cos((k * Math.PI) / 4) * rr, Math.sin((k * Math.PI) / 4) * rr]);
  for (const [ox, oz] of spots) {
    const ax = x + ox, az = z + oz;
    if (!inBay(W, ax, az, 60) || !sim.isWater(ax, az, 20)) continue;
    if (W.port && dist(ax, az, W.port.x, W.port.z) < W.port.r + 60) continue;
    const ev = sim.sea?.force("kraken_arm", { x: ax, z: az });
    if (ev) K.arms[ev.id] = { t: 0, dur: SEA_EVENTS.kraken_arm.s, live: true };
    return ev;
  }
  return null;
}
/** An arm across her course toward `goal`: AHEAD m ahead of her on that line, SIDE m off it. */
function armAhead(sim, K, goal, ahead, side) {
  const P = sim.S.ship;
  const h = goal ? headingOf(goal.x - P.x, goal.z - P.z) : P.heading;
  const f = forward(h), n = portNormal(h);
  return raiseArm(sim, K, P.x + f.x * ahead + n.x * side, P.z + f.z * ahead + n.z * side);
}

/**
 * Kraken's Wake's director (v5). Every beat is an existing piece: lone arms (sea events), the grab (S.hazards.kraken), the
 * rogue wave (sim.spawnWave), the guards and cutters (fleet classes); the eye is S.hazards.eye (sim.js counts the hits).
 */
function krakensWake(sim, c, h, ev) {
  const S = sim.S, P = S.ship, W = sim.world, M = S.mission, K = M.kw, KW = KRAKENS_WAKE, r = M.rng;
  const step = M.steps[Math.min(M.step, M.steps.length - 1)]?.id;
  const left = W.wrecks.filter((w) => !S.salvaged.has(w.id));
  const nearestWreck = left.slice().sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z))[0] || null;
  // The arms we raised: shot off (gone before their time) or sunk back (their time ran out).
  for (const [id, a] of Object.entries(K.arms)) {
    if (!a.live) continue;
    const e = sim.sea?.byId(id);
    if (e) { if (e.stage === "active") { a.t = e.t; a.dur = e.dur || a.dur; } continue; }
    a.live = false;
    if (a.t > 0 && a.t < a.dur - 0.5) K.armsDown++;
  }
  // The grab: how many times the arms on the rails were all beaten off (the "repel" bonus).
  const G = S.hazards.kraken;
  if (G?.stage === "grab" && !K.inGrab) { K.inGrab = true; K.grabsSeen++; }
  if (K.inGrab && (!G || G.stage !== "grab")) { K.inGrab = false; if (G && G.arms.every((a) => a.hp <= 0)) K.grabsBeaten++; }

  // 1. On the way to each wreck: an arm rises across her course (once per leg, while she's still well short of it).
  if (K.leg !== step && (step === "wreck1" || step === "wreck2")) { K.leg = step; K.ambushDone = false; if (step === "wreck2") K.ambushAt = S.t + r.range(KW.legAmbush[0], KW.legAmbush[1]); }
  const toWreck = nearestWreck ? dist(P.x, P.z, nearestWreck.x, nearestWreck.z) : 0;
  if (!K.ambushDone && (S.t >= K.ambushAt || (toWreck < 520 && !K.legAmbushed[step])) && nearestWreck && (step === "wreck1" || step === "wreck2")) {
    K.legAmbushed[step] = true;
    // (Another one LEG_EVERY s later while she's still well out: a long leg gets two.)
    if (dist(P.x, P.z, nearestWreck.x, nearestWreck.z) > 380) {
      armAhead(sim, K, nearestWreck, r.range(KW.ambushAhead[0], KW.ambushAhead[1]), r.sign() * r.range(KW.ambushSide[0], KW.ambushSide[1]));
      K.ambushAt = S.t + r.range(KW.legEvery[0], KW.legEvery[1]);
    } else K.ambushDone = true;
  }
  // 2. The first wreck: once the divers go down, ink spreads under her and the Kraken grabs the rails.
  if (!K.firstWreck && nearestWreck && dist(P.x, P.z, nearestWreck.x, nearestWreck.z) < KW.grabAt) K.firstWreck = nearestWreck.id;
  if (!K.grabbed && S.salvage) {
    K.grabbed = true; K.firstWreck = S.salvage.id;
    if (!S.hazards.kraken) sim.startKraken();
  }
  // 3. Arms rise round each wreck as she closes on it (one at the first, WRECK_ARMS at the second).
  if (nearestWreck && !K.wreckArmsAt[nearestWreck.id] && (step === "wreck1" || step === "wreck2") && dist(P.x, P.z, nearestWreck.x, nearestWreck.z) < KW.wreckArmsAt) {
    K.wreckArmsAt[nearestWreck.id] = S.t;
    const n = step === "wreck1" ? 1 : KW.wreckArms, a0 = r.range(0, 360);
    for (let i = 0; i < n; i++) {
      const f = forward(a0 + (i * 360) / n), d = r.range(KW.wreckArmR[0], KW.wreckArmR[1]);
      raiseArm(sim, K, nearestWreck.x + f.x * d, nearestWreck.z + f.z * d);
    }
  }
  // The divers stop work while the ink spreads, while arms hold the rails, or while one thrashes alongside: the salvage clock waits.
  const holding = G?.stage === "ink" || (G?.stage === "grab" && G.arms.some((a) => a.hp > 0));
  const thrashing = (sim.sea?.list() || []).some((e) => e.kind === "kraken_arm" && e.stage === "active" && dist(e.x, e.z, P.x, P.z) < 45);
  K.held = !!S.salvage && (holding || thrashing);
  if (K.held) S.salvage.t = Math.max(0, S.salvage.t - h);

  // 4. The eye.
  if (step === "eye" && !K.eyeGone) eyeStep(sim, c, h, ev);
  // 5. The run home: arms ahead, and the night's welcome off the harbour mouth.
  if (step === "out" && W.exit) {
    if (!K.escape) {
      K.escape = W.variant?.escape || "arms";
      const near = (i) => ({ x: W.exit.x + (i ? 1 : -1) * 90, z: W.exit.z + 300, r: 30 + i * 20 });
      if (K.escape === "cutters") for (let i = 0; i < 2; i++) sim.spawnShip("gunboat", "harass", near(i), { role: "harass" });
      else if (K.escape === "fireship") sim.spawnShip("fireship", "harass", near(0), { role: "harass" });
      K.escapeNext = S.t + r.range(5, 9);
    }
    if (S.t >= K.escapeNext && dist(P.x, P.z, W.exit.x, W.exit.z) > KW.escapeClear) {
      K.escapeNext = S.t + r.range(KW.escapeEvery[0], KW.escapeEvery[1]);
      armAhead(sim, K, W.exit, r.range(KW.ambushAhead[0], KW.ambushAhead[1]), r.sign() * r.range(0, KW.ambushSide[1]));
    }
  }
}

/** Where the eye surfaces: DIST m from her, toward home (± 60°), on open water. */
function eyeSpot(sim, r) {
  const P = sim.S.ship, W = sim.world, E = KRAKEN_EYE;
  const home = W.exit || W.port;
  const base = headingOf(home.x - P.x, home.z - P.z);
  for (let i = 0; i < 16; i++) {
    const h = base + r.range(-60, 60) * (i < 10 ? 1 : 2.5), d = r.range(E.dist[0], E.dist[1]);
    const f = forward(h), x = P.x + f.x * d, z = P.z + f.z * d;
    if (inBay(W, x, z, 80) && sim.isWater(x, z, 30) && dist(x, z, home.x, home.z) > 160) return { x, z };
  }
  const f = forward(P.heading);
  return { x: P.x + f.x * 220, z: P.z + f.z * 220 };
}

/** The eye's cycle: rise → up (hittable; a wound dives it early) → dive → down (an attack) → rise elsewhere. */
function eyeStep(sim, c, h, ev) {
  const S = sim.S, P = S.ship, M = S.mission, K = M.kw, r = M.rng, KE = KRAKEN_EYE;
  const tele = sim.teleScale ? sim.teleScale() : 1;
  let E = S.hazards.eye;
  const hz = (stage, extra = {}) => ev.push({ type: "hazard", kind: "kraken", stage, eye: true, id: "kraken_eye", x: Math.round(E.x), z: Math.round(E.z), ...extra });
  if (!E) {
    const at = eyeSpot(sim, r);
    S.hazards.eye = E = { id: "kraken_eye", stage: "rise", t: 0, x: at.x, z: at.z, r: KE.r, dealt: 0, hits: 0, wounds: K.wounds, need: KE.wounds, next: null, surfacings: 1 };
    hz("telegraph", { eta: KE.riseS });
    return;
  }
  E.t += h;
  if (E.stage === "rise" && E.t >= KE.riseS * tele) {
    E.stage = "up"; E.t = 0; E.dealt = 0; E.next = null; hz("rise");
    // Told as the chain's progress (the companion hears where it is).
    const i = M.steps.findIndex((s) => s.id === "eye");
    ev.push({ type: "objective", stage: "progress", id: "eye", step: i + 1, of: M.steps.length, count: K.wounds, need: KE.wounds,
      text: `The Kraken's eye is up, ${metres(dist(P.x, P.z, E.x, E.z))} ${compass8Abbr(headingOf(E.x - P.x, E.z - P.z))}: put every gun on it (${KE.upS} s before it dives)` });
    return;
  }
  if (E.stage === "up") {
    if (E.dealt >= KE.wound) { K.wounds++; E.wounds = K.wounds; E.stage = "dive"; E.t = 0; hz("wound", { wounds: K.wounds, need: KE.wounds }); }
    else if (E.t >= KE.upS) { E.stage = "dive"; E.t = 0; hz("dive"); }
    return;
  }
  if (E.stage === "dive" && E.t >= KE.diveS) {
    if (K.wounds >= KE.wounds) {
      K.eyeGone = true; S.hazards.eye = null;
      S.stats.krakenRepelled++;
      sim.gainPlunder(KE.loot, "kraken");
      ev.push({ type: "hazard", kind: "kraken", stage: "driven", eye: true, id: "kraken_eye", x: Math.round(E.x), z: Math.round(E.z), gold: KE.loot });
      return;
    }
    E.stage = "down"; E.t = 0;
    E.next = eyeSpot(sim, r);
    // While it's under, the Kraken comes at her: its arms, a wave, or the grab (the night's order).
    const kind = K.attacks[K.attackN++ % K.attacks.length];
    if (kind === "arms") {
      const n = portNormal(P.heading), side = r.sign();
      raiseArm(sim, K, P.x + n.x * side * r.range(60, 85), P.z + n.z * side * r.range(60, 85));
      raiseArm(sim, K, P.x - n.x * side * r.range(60, 85) + forward(P.heading).x * 40, P.z - n.z * side * r.range(60, 85) + forward(P.heading).z * 40);
    } else if (kind === "wave" && !S.hazards.wave) sim.spawnWave(headingOf(P.x - E.x, P.z - E.z), 9 * tele);
    else if (!S.hazards.kraken) sim.startKraken();
    hz("dive", { attack: kind });
    return;
  }
  if (E.stage === "down" && E.t >= KE.downS) {
    const at = E.next || eyeSpot(sim, r);
    E.x = at.x; E.z = at.z; E.next = null; E.stage = "rise"; E.t = 0; E.surfacings++;
    hz("telegraph", { eta: KE.riseS });
  }
}

/**
 * v5 free roam: the bay keeps its traffic (a fresh merchant sails in when fewer than TRAFFIC_MIN are about) and offers side
 * jobs one at a time in the bonus slot (a bounty on a navy hunter, a prize to board, a wreck, a fort tower, a chest adrift),
 * each with its own reward and CONTRACT_S s to do it.
 */
function freeSetup(sim, M) {
  const F = FREE_ROAM, r = M.rng;
  return { trafficAt: r.range(F.trafficEvery[0], F.trafficEvery[1]), contractAt: r.range(F.contractFirst[0], F.contractFirst[1]),
    order: r.shuffle(["bounty", "prize", "chest", "salvage", "tower"]), n: 0, jobs: 0 };
}

function freeRoam(sim, c, h, ev) {
  const S = sim.S, P = S.ship, W = sim.world, M = S.mission, F = M.free, FR = FREE_ROAM, r = M.rng;
  // Traffic: merchants come into the bay from its edges.
  if (S.t >= F.trafficAt) {
    F.trafficAt = S.t + r.range(FR.trafficEvery[0], FR.trafficEvery[1]);
    const calm = S.ships.filter((e) => sim.alive(e) && e.cls === "merchant" && !e.derelict && !e.provoked && e.state !== "surrender").length;
    if (calm < FR.trafficMin && S.t < S.cfg.limit - 90) {
      for (let i = 0; i < 12; i++) {
        const edge = r.int(0, 2);
        const x = edge === 0 ? W.bounds.minX + 120 : edge === 1 ? W.bounds.maxX - 120 : r.range(-650, 650);
        const z = edge === 2 ? W.bounds.maxZ - 120 : r.range(450, 1550);
        if (dist(x, z, P.x, P.z) < 450 || !sim.isWater(x, z, 40)) continue;
        const e = sim.spawnShip("merchant", "merchant", { x, z, r: 1 }, { role: "merchant" });
        e.heading = headingOf(0 - x, 900 - z); e.wantHeading = e.heading;
        break;
      }
    }
  }
  // The run home with a full hold: a navy cutter tries to cut her off (once a trip).
  if (S.plunder.hold >= FR.interceptHold && S.t >= (F.interceptAt || 0) && S.t < S.cfg.limit - 60) {
    const dp = dist(P.x, P.z, W.port.x, W.port.z);
    const homeward = Math.abs(((headingOf(W.port.x - P.x, W.port.z - P.z) - P.heading + 540) % 360) - 180) < 60;
    if (homeward && dp > FR.interceptFrom[0] && dp < FR.interceptFrom[1] && !S.ships.some((x) => x.role === "hunter" && sim.alive(x))) {
      F.interceptAt = S.t + FR.interceptEvery;
      // Off her bow, between her and home (and clear of the harbour: spawnShip keeps 300 m off it).
      const k = Math.max(430, dp * 0.55) / dp, mx = W.port.x + (P.x - W.port.x) * k, mz = W.port.z + (P.z - W.port.z) * k;
      const n = S.heat >= 2 ? 2 : 1;
      for (let i = 0; i < n; i++) sim.spawnShip("gunboat", "hunter", { x: mx, z: mz, r: 120 + i * 40 });
    }
  }
  // Side jobs.
  const B = M.bonus;
  if (B && (B.done || B.failed)) { if (!F.gapSet) { F.gapSet = true; F.contractAt = S.t + r.range(FR.contractGap[0], FR.contractGap[1]); } }
  if ((!B || B.done || B.failed) && S.t >= F.contractAt && S.t < S.cfg.limit - FR.contractS * 0.5) {
    for (let k = 0; k < F.order.length; k++) {
      const kind = F.order[F.n++ % F.order.length];
      // With the navy on her trail (heat FREE_ROAM.quietHeat+), only the quiet jobs: a wreck, a chest.
      if (S.heat >= FR.quietHeat && kind !== "salvage" && kind !== "chest") continue;
      const job = makeJob(sim, kind, r, ++F.jobs);
      if (!job) continue;
      M.bonus = { ...job, done: false, failed: false, until: S.t + FR.contractS, done_: job.done, failed_: (cc) => job.failed?.(cc) || cc.S.t > M.bonus.until };
      F.gapSet = false;
      ev.push({ type: "objective", stage: "start", id: `bonus:${job.id}`, bonus: true, step: M.step + 1, of: M.steps.length, text: `Side job: ${job.text} (+${job.reward} gold)`,
        marker: markerOut(c, job.marker?.(c) || null) });
      break;
    }
    if (!M.bonus || M.bonus.done || M.bonus.failed) F.contractAt = S.t + 20;
  }
}

/** One free-roam side job, or null when there's none of that kind to give. */
function makeJob(sim, kind, r, n) {
  const S = sim.S, P = S.ship, W = sim.world, reward = FREE_ROAM.reward[kind] || OBJECTIVE.bonusGold;
  const near = (list) => list.sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z));
  switch (kind) {
    case "bounty": {
      // Not while hunters are already out; a brig only for a fresh ship with no heat on her, else a gunboat.
      if (S.ships.some((x) => x.role === "hunter" && sim.alive(x))) return null;
      const e = sim.spawnShip(S.heat === 0 && P.hull >= 70 && r.chance(0.6) ? "brig" : "gunboat", "hunter");
      return { id: `bounty${n}`, kind, reward, text: `Bounty: sink the navy ${e.C.label} ${e.name}`, marker: () => shipM(e.id, e.name),
        done: (c) => takenSet(c).has(e.id), failed: (c) => escaped(c, e.id) || (!aliveShip(c, e.id) && !takenSet(c).has(e.id)) };
    }
    case "prize": {
      const e = near(S.ships.filter((x) => sim.alive(x) && x.cls === "merchant" && !x.derelict && !x.provoked && x.state !== "surrender" && dist(P.x, P.z, x.x, x.z) > 250))[0];
      if (!e) return null;
      return { id: `prize${n}`, kind, reward, text: `Take the merchant ${e.name} intact: board her`, marker: () => shipM(e.id, e.name),
        done: (c) => captured(c, e.id), failed: (c) => !captured(c, e.id) && (escaped(c, e.id) || !aliveShip(c, e.id)) };
    }
    case "salvage": {
      const w = near(W.wrecks.filter((q) => !S.salvaged.has(q.id)))[0];
      if (!w) return null;
      return { id: `salvage${n}`, kind, reward, text: "Salvage the wreck on the chart: stop beside her", marker: () => pointM(w.x, w.z, "Wreck"), done: (c) => c.S.salvaged.has(w.id) };
    }
    case "tower": {
      const t = near(S.ships.filter((x) => x.cls === "tower" && !x.down))[0];
      if (!t) return null;
      return { id: `tower${n}`, kind, reward, text: `Silence the fort's ${t.name} (mortars, or heavy shot close in)`, marker: () => shipM(t.id, t.name), done: () => !!t.down };
    }
    case "chest": {
      for (let i = 0; i < 20; i++) {
        const f = forward(r.range(0, 360)), d = r.range(320, 560), x = P.x + f.x * d, z = P.z + f.z * d;
        if (!inBay(W, x, z, 100) || !sim.isWater(x, z, 30) || dist(x, z, W.port.x, W.port.z) < 300) continue;
        if (W.maelstrom && dist(x, z, W.maelstrom.x, W.maelstrom.z) < W.maelstrom.r + 60) continue;
        const id = `job${n}chest`;
        S.pickups.push({ id, kind: "chest", x: Math.round(x), z: Math.round(z), value: FREE_ROAM.chestGold, age: 0, placed: true, job: true });
        return { id: `chest${n}`, kind, reward, text: "Haul in the chest adrift", marker: () => pointM(x, z, "Chest adrift"),
          done: (c) => !c.S.pickups.some((p) => p.id === id),
          failed: (c) => { if (c.S.t > c.M.bonus?.until) { c.S.pickups = c.S.pickups.filter((p) => p.id !== id); return true; } return false; } };
      }
      return null;
    }
    default: return null;
  }
}

// Step/bonus predicates live under `done_` / `failed_` so the `done` flags can be plain booleans.
for (const def of Object.values(DEFS)) {
  const raw = def.steps;
  def.steps = (W) => raw(W).map((s) => ({ ...s, done_: s.done }));
}
const rawBonus = bonusDef;
function bonusOf(W) { const b = rawBonus(W); return b ? { ...b, done_: b.done, failed_: b.failed || null } : null; }

/** A marker spec → its live shape: distance, compass bearing, relative bearing; a ship out of sight → her last known spot. */
function markerOut(c, m) {
  if (!m) return null;
  let { kind, x, z, r = null, contactId = null, label = "" } = m;
  let seen = true;
  if (kind === "ship") {
    const e = c.sim?.shipById(contactId);
    if (!e || e.gone) return null;
    if (e.fixed || (e.detected && !e.cloaked)) { x = e.x; z = e.z; }
    else { const s = c.M.seen[contactId] || { x: e.x, z: e.z }; x = s.x; z = s.z; kind = "area"; r = OBJECTIVE.lastSeenR; seen = false; label = `${label} (last seen)`; }
  }
  if (!c.P) return { kind, x: ROUND1(x), z: ROUND1(z), r, contactId: kind === "ship" ? contactId : null, label, dist: null, bearing: null, compass: null, rel: null, seen };
  const d = dist(c.P.x, c.P.z, x, z), brg = headingOf(x - c.P.x, z - c.P.z);
  return { kind, x: ROUND1(x), z: ROUND1(z), r, contactId: kind === "ship" || !seen ? contactId : null, label, dist: Math.round(d), bearing: Math.round(brg),
    compass: compass8Abbr(brg), rel: Math.round(relBearing(c.P.x, c.P.z, c.P.heading, x, z)), seen };
}
const where = (mk) => (mk && mk.dist != null ? ` — ${metres(mk.dist)} ${mk.compass}` : "");

/**
 * v4: where the objective is now (the current step's marker and the bonus's, ships where they really are):
 * [{x, z}]. The random sea events keep clear of these.
 */
export function objectivePoints(sim) {
  const M = sim?.S.mission;
  if (!M || M.status !== "active") return [];
  const c = ctxOf(sim);
  const out = [];
  const add = (m) => {
    if (!m) return;
    if (m.kind === "ship") { const e = sim.shipById(m.contactId); if (e && !e.gone) out.push({ x: e.x, z: e.z }); }
    else if (Number.isFinite(m.x) && Number.isFinite(m.z)) out.push({ x: m.x, z: m.z });
  };
  try { add(M.steps[Math.min(M.step, M.steps.length - 1)]?.marker?.(c)); } catch { /* a marker that can't be made now */ }
  try { if (M.bonus && !M.bonus.done && !M.bonus.failed) add(M.bonus.marker?.(c)); } catch { /* idem */ }
  return out;
}

/**
 * The eye as the state shows it: {stage: rise|up|dive|down, x, z, r, wounds, need, hp (this surfacing, 1 → 0), next {x, z}|null, upLeft,
 * riseIn (s until it's up again, while it's under or rising; null while up)}.
 */
function eyeOut(E, tele = 1) {
  if (!E) return null;
  const KE = KRAKEN_EYE, riseS = KE.riseS * tele;
  const riseIn = E.stage === "rise" ? riseS - E.t : E.stage === "down" ? KE.downS - E.t + riseS : E.stage === "dive" && E.wounds < E.need ? KE.diveS - E.t + KE.downS + riseS : null;
  return { stage: E.stage, x: ROUND1(E.x), z: ROUND1(E.z), r: E.r, wounds: E.wounds, need: E.need, hp: ROUND1(clamp(1 - E.dealt / KE.wound, 0, 1)),
    next: E.next ? { x: ROUND1(E.next.x), z: ROUND1(E.next.z) } : null, upLeft: E.stage === "up" ? ROUND1(Math.max(0, KE.upS - E.t)) : null,
    riseIn: riseIn == null ? null : ROUND1(Math.max(0, riseIn)) };
}

/** state.objective: the current step with its live marker, the chain, the bonus, the fail counters. */
export function objectiveState(sim, { phase = null } = {}) {
  const M = sim?.S.mission;
  if (!M) return null;
  const c = ctxOf(sim);
  const i = Math.min(M.step, M.steps.length - 1);
  const s = M.steps[i];
  const mk = M.status === "active" || phase === "briefing" ? markerOut(c, s.marker(c)) : null;
  const instruction = s.text(c);
  const n = s.count ? s.count(c) : null;
  const B = M.bonus;
  return {
    id: s.id, step: i + 1, of: M.steps.length, status: phase === "briefing" ? "briefing" : M.status,
    instruction, text: `${instruction}${where(mk)}`, hint: s.hint || "", count: n ? n.count : null, need: n ? n.need : null, marker: mk,
    steps: M.steps.map((x, j) => ({ id: x.id, text: x.text(c), done: x.done, active: j === M.step && M.status === "active" })),
    bonus: B ? { id: B.id, text: B.text, reward: B.reward, done: B.done, failed: B.failed, marker: !B.done && !B.failed && B.marker ? markerOut(c, B.marker(c)) : null,
      ...(B.until != null ? { left: Math.max(0, Math.round(B.until - sim.S.t)) } : {}) } : null,
    // v5 Kraken's Wake: the Kraken's eye for the scene (kraken.js's set piece: placePiece/risePiece/sinkPiece) and a boss bar.
    eye: eyeOut(sim.S.hazards.eye, sim.teleScale ? sim.teleScale() : 1),
    fail: M.fails.map((f) => {
      const value = f.value(c);
      return { id: f.id, text: f.text, label: f.label(c), value: Math.round(value * 100) / 100, max: f.max, frac: Math.round(clamp(value / f.max, 0, 1) * 1000) / 1000, warn: f.warn,
        eta: f.eta ? (Number.isFinite(f.eta(c)) ? Math.round(f.eta(c)) : null) : null };
    }),
  };
}

// ---- Briefings ----------------------------------------------------------------------------------------------------

function briefOf(id, W = null) {
  const cfg = MISSIONS[id] || ARENA;
  const def = defOf(id);
  const c = W ? { sim: null, S: null, P: null, W, M: null, v: W.variant || {} } : null;
  const steps = W ? def.steps(W).map((s) => ({ id: s.id, text: s.text(c) })) : genericSteps(id);
  const fails = W ? [failHull(), ...def.fails(W), failTime(def.timeTip, def.timeText)].map((f) => ({ id: f.id, text: f.id === "time" && !cfg.free ? `Time runs out (${mmss(cfg.limit)})` : f.text }))
    : [{ id: "hull", text: "The Rexmaw sinks (hull 0% or water 100%)" }, ...GENERIC_FAILS[id] || [], { id: "time", text: cfg.free ? `${def.timeText || "Time"}` : `Time runs out (${mmss(cfg.limit)})` }];
  const b = W ? bonusOf(W) : null;
  return {
    mission: cfg.id, label: cfg.label, time: cfg.time, tab: cfg.tab, seed: W ? W.seed : null, limit: cfg.limit,
    summary: W ? def.summary(W) : cfg.objective,
    variant: W ? { id: W.variant?.id || "", label: W.variant?.label || "" } : null,
    steps, fail: fails, bonus: b ? { id: b.id, text: b.text, reward: OBJECTIVE.bonusGold } : null,
    medals: { time: [...cfg.medals.time], hull: [...cfg.medals.hull], loot: [...cfg.medals.loot] },
    tip: def.tip, ammo: { ...cfg.ammo }, boarding: BOARD_LINE, crewModes: CREW_MODES_LINE,
  };
}
const GENERIC_FAILS = {
  spice_fleet: [{ id: "prize_escape", text: "The prize merchant rounds the cape" }, { id: "escaped", text: "Two spice merchants escape" }],
  navy_convoy: [{ id: "escape", text: "The frigate or the chest brig reaches the cape (by the night's goal)" }],
  smugglers_run: [{ id: "spotted", text: "Spotted by the patrols 3 times" }],
};
function genericSteps(id) {
  switch (id) {
    case "navy_convoy": return [{ id: "intercept", text: "Intercept the navy convoy" }, { id: "goal", text: "Sink the escort frigate, or disable and board the chest brig (the night decides)" }];
    case "silence_fort": return [{ id: "approach", text: "Sail to the firing point off the fort" }, { id: "towers", text: "Destroy the fort's gun towers" }];
    default: {
      const def = defOf(id);
      // Steps that don't need the world for their generic text.
      try { return def.steps(fakeWorld(id)).map((s) => ({ id: s.id, text: s.generic })); } catch { return []; }
    }
  }
}
/** Just enough of a world for the step builders' generic texts. */
function fakeWorld(id) {
  return { mission: id, fleet: [{ id: "m1", role: "objective", name: "the prize" }, { id: "f1", name: "the frigate" }, { id: "d1" }, { id: "gl1" }], exit: { x: 0, z: 0, r: 90, name: "the cape" },
    variant: { prize: "m1", chest: "f1", goal: "frigate", entry: { x: 0, z: 400 } }, maze: [{ z: 400, gaps: [{ x: 0, z: 400 }] }], cove: { x: 0, z: 1500, r: 60 },
    islands: [], wrecks: [{ id: "wreck1", x: 0, z: 1000 }], port: { x: 0, z: -40, r: 110 }, pois: [], pickups: [], fort: { x: 0, z: 1200, towers: [] } };
}

/** The briefing card's data for a generated world (the night's variant). */
export function briefingFor(world) { return briefOf(world.mission, world); }
/** A title card's data before any world: generic step texts, the fail conditions, medals, tip. */
export function missionInfo(id) { return MISSIONS[id] ? briefOf(id, null) : null; }

/** The gold this mission's loot medal counts: everything gathered (free roam: what was banked; the run: + the contraband delivered). */
export function lootOf(sim, success) {
  const S = sim.S;
  if (sim.cfg.free) return S.plunder.banked;
  return S.plunder.loot + (success && sim.cfg.id === "smugglers_run" ? S.contraband : 0);
}

/** Medal tiers: time (lower is better), hull % left, loot gold — only for a success. */
export function medalsFor(cfg, { elapsed, hull, loot, success = true }) {
  const C = cfg?.medals || ARENA.medals;
  const tier = (v, th, lower) => {
    if (!success) return null;
    for (let i = 0; i < MEDAL_TIERS.length; i++) if (lower ? v <= th[i] : v >= th[i]) return MEDAL_TIERS[i];
    return null;
  };
  return { time: cfg?.free ? null : tier(elapsed, C.time, true), hull: tier(hull, C.hull, false), loot: tier(loot, C.loot, false) };
}
