// Briefs (spec v2 §4): what the companion is told. Facts, never answers:
// contacts (relative side, compass word, distance, closing or opening, what
// can be made out), the ship, the orders in progress, what the Captain said,
// and the geometry windows ("the brig bears on our starboard guns in ~8 s").
// At night and in fog the companion is the navigator: the briefs also list
// the HIDDEN hazards from their chart with names, compass bearings and
// distances ("Saw Reef: reef band 220 m NE (045), 80 m long"), and the
// patrol lanterns. The Captain's own chart doesn't show those reefs.
// There is no "recommended" line anywhere (tested).
//
//   contactLine(e, P) / shipLine(P, S) / ordersLine(sim) / hazardLine(sim) / lanternLine(sim) / captainLine(c, rt) / windows(sim)
//   hiddenHazards(sim, {range}) → [{h, d, brg, text}]   the companion's chart, nearest first
//   fullBrief(sim, ctx)                                    look_around: everything, now
//   createBriefer({gap})                                   the cadence: push(fact) → update(rt, compose) → beat | null
//
// Cadence: facts are pushed with a key (a newer fact with the same key
// replaces the older one) and a priority, and go out merged, one context item
// per beat. low and high facts make a spoken beat no sooner than `gap` s after
// the last one (8 s on a call, 18 s off one); a critical fact goes at once;
// note facts alone ride silently. Pure: no three.js, no DOM.

import { CLASSES, BRIEF, SAIL_NAMES, SIDES, REEFS, WEAPONS, STATION_LABEL, NAMED_LABEL, FORT } from "./const.js";
import { dist, wrap180, headingOf, relBearing, compass8Abbr, compassAbbr, degText, sideWord, metres, forward, segDist } from "./geom.js";
import { ballistic, bears } from "./gunnery.js";
import { hazardsOf } from "./world.js";

const PCT = (v) => `${Math.round(v)}%`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "brig" / "the brig Vigilant" / "a sail" (not made out yet). */
export function contactName(e, { known = e.known, article = true } = {}) {
  if (e.fixed) return `the fort's ${e.name}`;
  const C = e.C || CLASSES[e.cls];
  if (!known) return article ? "a sail" : "sail";
  if (C.legendary) return e.cls === "gloam" ? "The Gloam" : `the ${C.label} ${e.name}`;
  return `${article ? "the " : ""}${C.label} ${e.name}`;
}

/** Closing or opening, from the two ships' velocities. */
export function rangeRate(e, P) {
  const d = Math.max(1, dist(P.x, P.z, e.x, e.z));
  const ux = (e.x - P.x) / d, uz = (e.z - P.z) / d;
  return ((e.vx || 0) - (P.vx || 0)) * ux + ((e.vz || 0) - (P.vz || 0)) * uz;
}

/** One contact as a line of facts. */
export function contactLine(e, P, { detail = true } = {}) {
  const d = dist(P.x, P.z, e.x, e.z);
  const rel = relBearing(P.x, P.z, P.heading, e.x, e.z);
  const brg = headingOf(e.x - P.x, e.z - P.z);
  const rr = rangeRate(e, P);
  const move = e.fixed ? "" : Math.abs(rr) < 0.8 ? ", holding range" : rr < 0 ? ", closing" : ", opening";
  const s = `${contactName(e)}, ${sideWord(rel)} (${compass8Abbr(brg)}), ${metres(d)}${move}`;
  if (e.fixed) return `${s}, ${e.down ? "silenced" : `${PCT((e.hull / e.hullMax) * 100)} walls, ${e.batteries.port.guns} guns, range ${FORT.range} m`}.`;
  if (!detail || !e.known) return `${s}.`;
  if (e.derelict) return `${s}. A derelict: nobody aboard, no guns; ${e.salvaged ? "already salvaged" : "stop alongside her to salvage what's left"}.`;
  const C = e.C || CLASSES[e.cls];
  const bits = [];
  if (e.cloaked) bits.push("hidden in her own fog");
  if (e.state === "surrender") bits.push("white flag up");
  else if (e.state === "flee") bits.push(e.ai === "run_for_exit" ? "running for the exit" : "running");
  else if (e.state === "ram") bits.push(e.lit ? "burning, on a ram course" : "on a ram course");
  bits.push(`hull ${PCT((e.hull / e.hullMax) * 100)}`);
  if (e.masts < 100) bits.push(`masts ${PCT(e.masts)}`);
  if (C.guns) bits.push(`${e.batteries.port.guns}/${C.guns} guns a side`);
  else if (C.bow) bits.push(`${C.bow} bow guns`);
  if (e.speed > 0.5) bits.push(`${e.speed.toFixed(0)} m/s`);
  if (e.ports.port.open || e.ports.starboard.open) bits.push(`${e.ports.port.open ? "port" : "starboard"} ports open`);
  if (e.weakPoints?.length) bits.push(`${e.weakPoints.length} weak point${e.weakPoints.length === 1 ? "" : "s"} glowing`);
  if (e.chest) bits.push("carrying the paymaster's chest");
  if (e.lantern) bits.push(e.spotted ? "has seen us" : `lantern sweeping${e.alert > 0.05 ? `, alert ${PCT(e.alert * 100)}` : ""}`);
  return `${s}. ${cap(bits.join(", "))}.`;
}

/** The ship in one line. */
export function shipLine(P, S) {
  const bits = [`hull ${PCT(P.hull)}`, `masts ${PCT(P.masts)}`, `water ${PCT(P.water)}${P.leaks ? ` (${P.leaks} leak${P.leaks === 1 ? "" : "s"})` : ""}`];
  if (P.fires) bits.push(`${P.fires} fire${P.fires === 1 ? "" : "s"} burning`);
  bits.push(`${P.crewHands} hands`);
  const down = SIDES.filter((s) => P.guns[s].live < P.guns[s].max).map((s) => `${s} ${P.guns[s].live}/${P.guns[s].max}`);
  if (down.length) bits.push(`guns down: ${down.join(", ")}`);
  const ammo = `chain ${Math.floor(P.ammo.chain)}, mortar ${Math.floor(P.ammo.mortar)}, barrels ${Math.floor(P.ammo.barrels)}`;
  const hold = S.cfg?.free ? ` Hold ${S.plunder.hold} gold, banked ${S.plunder.banked}.` : S.plunder.loot ? ` ${S.plunder.loot} gold gathered.` : "";
  return `**Ship:** ${bits.join(", ")}; ${P.sprint?.on ? "sprinting" : SAIL_NAMES[P.sail]}, ${P.speed.toFixed(0)} m/s, heading ${compassAbbr(P.heading)} (${degText(P.heading)}). Ammo: round ∞, heavy ∞, ${ammo}.${hold}`;
}

const MODE_WORDS = { once: "one volley", keep_firing: "keep firing", hold: "waiting for your 'Fire!'" };

/** Orders in progress (jobs): who's on which guns, repairs, pumps. */
export function ordersLine(sim, { targetName = (t) => t } = {}) {
  const S = sim.S, bits = [];
  for (const side of ["port", "starboard", "bow", "mortar"]) {
    const m = S.manned[side];
    if (!m) continue;
    const job = sim.crew.jobOf("guns", side);
    const who = job?.who[0] ? NAMED_LABEL[job.who[0]] || job.who[0] : "hands";
    const st = { laid: "laid on her, loaded", loading: "loading", waiting: "she doesn't bear yet", walking: "on the way to the guns", repelling: "hacking at the arms",
      range: "she's out of range: they hold fire until she's within 250 m (chain 200 m)" }[m.status] || m.status;
    bits.push(`${side === "mortar" ? "mortar" : `${side} guns`}: ${who}, ${m.target === "kraken" ? "the Kraken's arms" : targetName(m.target)}, ${MODE_WORDS[m.mode] || m.mode} (${st})`);
  }
  for (const kind of ["repair", "bail"]) {
    const j = S.jobs[kind];
    if (!j) continue;
    const p = sim.jobProgress(kind);
    bits.push(kind === "repair" ? `repairs (${j.what}): ${PCT((p ?? 0) * 100)} done` : `bailing: water ${PCT(S.ship.water)}`);
  }
  return bits.length ? `**Orders:** ${bits.join(" · ")}.` : "**Orders:** none (the hands only reload what the Captain fires).";
}

/** Where a hazard is from the Rexmaw: the nearest point of it, compass + degrees + distance. */
function hazardFix(P, h) {
  const s = segDist(P.x, P.z, h.a.x, h.a.z, h.b.x, h.b.z);
  const d = Math.max(0, s.d - h.w);
  const brg = headingOf(s.x - P.x, s.z - P.z);
  return { d, brg, x: s.x, z: s.z };
}

/**
 * The companion's chart: hazards the Captain can't see (all at night or in fog; none by day outside fog),
 * nearest first. → [{h, d, brg, text}]
 */
export function hiddenHazards(sim, { range = REEFS.briefRange, all = false } = {}) {
  const S = sim.S, P = S.ship;
  const shown = new Set(sim.captainReefs().map((r) => r.id));
  const fix = (h) => ({ h, ...hazardFix(P, h) });
  const at = (d, brg) => `${metres(d)} ${compassAbbr(brg)} (${degText(brg)})`;
  // A reef row made of several bands shares a name: one entry for the row, with its gaps.
  const groups = new Map();
  for (const h of hazardsOf(sim.world)) {
    if (!all && h.kind !== "shoal" && shown.has(h.id) && !S.night) continue;
    if (!all && !S.night && sim.fogAt(h.x, h.z) < 0.3) continue;
    const k = h.kind === "reef" ? `reef:${h.name}` : h.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const list = [];
  for (const hs of groups.values()) {
    const fixes = hs.map(fix).sort((a, b) => a.d - b.d);
    const f = fixes[0], h = f.h;
    if (f.d > range) continue;
    const ahead = Math.abs(wrap180(f.brg - P.heading)) <= 25 ? ", across our bow" : "";
    let what;
    if (h.kind === "reef" && hs.length > 1) {
      // The row's line, end to end, and the openings in it.
      const ux = hs[0].b.x - hs[0].a.x, uz = hs[0].b.z - hs[0].a.z, L0 = Math.hypot(ux, uz) || 1;
      const along = (p) => ((p.x - hs[0].a.x) * ux + (p.z - hs[0].a.z) * uz) / L0;
      const segs = hs.map((q) => { const s0 = along(q.a), s1 = along(q.b); return s0 <= s1 ? { q, s0, s1, p0: q.a, p1: q.b } : { q, s0: s1, s1: s0, p0: q.b, p1: q.a }; }).sort((a, b) => a.s0 - b.s0);
      const gaps = [];
      for (let i = 0; i + 1 < segs.length; i++) {
        const A = segs[i], B = segs[i + 1];
        const w = dist(A.p1.x, A.p1.z, B.p0.x, B.p0.z) - A.q.w - B.q.w;
        if (w < 25) continue;
        const gx = (A.p1.x + B.p0.x) / 2, gz = (A.p1.z + B.p0.z) / 2;
        gaps.push({ d: dist(P.x, P.z, gx, gz), brg: headingOf(gx - P.x, gz - P.z), w });
      }
      gaps.sort((a, b) => a.d - b.d);
      const ends = [segs[0].p0, segs[segs.length - 1].p1].map((p) => compassAbbr(headingOf(p.x - P.x, p.z - P.z)));
      const gapText = gaps.length ? `; ${gaps.length === 1 ? "one gap" : `${gaps.length} gaps`}: ${gaps.slice(0, 2).map((g) => `${at(g.d, g.brg)}, ${Math.round(g.w)} m wide`).join(", ")}` : "; no gap";
      what = `a reef row ${at(f.d, f.brg)} at the nearest, running ${ends[0]} to ${ends[1]}${gapText}`;
    } else {
      const L = dist(h.a.x, h.a.z, h.b.x, h.b.z);
      what = h.kind === "reef" ? `reef band ${at(f.d, f.brg)}, ${Math.round(L + 2 * h.w)} m long`
        : h.kind === "shoal" ? `shoal water ${at(f.d, f.brg)}` : `rocks ${at(f.d, f.brg)}`;
    }
    list.push({ h, d: f.d, brg: f.brg, text: `${h.name}: ${what}${ahead}` });
  }
  return list.sort((a, b) => a.d - b.d);
}

/** The hidden hazards as one brief line (or ""). */
export function hazardLine(sim, { max = BRIEF.maxHazards, range = REEFS.briefRange } = {}) {
  const S = sim.S;
  if (!S.night && S.fogHere < 0.3 && !(sim.world.fog || []).length) return "";
  const list = hiddenHazards(sim, { range }).slice(0, max);
  if (!list.length) return S.night || S.fogHere > 0.3 ? `**Your chart:** no reefs or rocks within ${metres(range)}.` : "";
  return `**Your chart (the Captain can't see these):** ${list.map((x) => x.text).join("; ")}.`;
}

/** Patrol lanterns (night): where they are and where their beams point. */
export function lanternLine(sim) {
  const S = sim.S, P = S.ship;
  const bits = [];
  for (const e of S.ships) {
    if (!e.lantern || e.gone || e.state === "sinking") continue;
    const d = dist(P.x, P.z, e.x, e.z);
    if (d > 900) continue;
    const toUs = headingOf(P.x - e.x, P.z - e.z);
    const off = Math.abs(wrap180(toUs - e.lantern.yaw));
    const beam = e.spotted ? "she has seen us" : off <= e.lantern.half + 8 && d <= e.lantern.range ? "her beam is ON us" : off < 40 ? "her beam is sweeping near us" : `her beam points ${compass8Abbr(e.lantern.yaw)}`;
    bits.push(`${contactName(e)}'s lantern ${metres(d)} ${compass8Abbr(headingOf(e.x - P.x, e.z - P.z))}, ${beam} (reach ${metres(e.lantern.range)})${e.alert > 0.05 && !e.spotted ? `, alert ${PCT(e.alert * 100)}` : ""}`);
  }
  return bits.length ? `**Lanterns:** ${bits.join("; ")}.` : "";
}

/** The Captain's last words, if recent. */
export function captainLine(c, rt) {
  if (!c?.text) return "";
  const ago = Math.max(0, Math.round(rt - c.t));
  if (ago > 90) return "";
  return `**Captain, ${ago < 3 ? "just now" : `${ago} s ago`}:** '${c.text.slice(0, 140)}'`;
}

/**
 * Geometry windows: when our batteries and theirs come to bear at the current headings and speeds
 * (a straight-line projection, 1 s steps). Facts, no advice. → [{id, text, eta, kind}]
 */
export function windows(sim, { horizon = BRIEF.windowS, maxN = 2 } = {}) {
  const S = sim.S, P = S.ship;
  const out = [];
  const reach = ballistic(WEAPONS.broadside.maxElev).range;
  for (const e of sim.visibleContacts()) {
    if (e.fixed || e.state === "surrender" || e.state === "sinking" || !e.detected || e.cloaked) continue;
    const d0 = dist(P.x, P.z, e.x, e.z);
    if (d0 > 800) continue;
    const pf = forward(P.heading), ef = forward(e.heading);
    let ours = null, theirs = null;
    for (let t = 0; t <= horizon; t++) {
      const px = P.x + pf.x * P.speed * t, pz = P.z + pf.z * P.speed * t;
      const ex = e.x + ef.x * e.speed * t, ez = e.z + ef.z * e.speed * t;
      const d = dist(px, pz, ex, ez);
      const pose = { x: px, z: pz, heading: P.heading };
      for (const side of ["port", "starboard"]) if (ours == null && d <= reach && bears(pose, side, { x: ex, z: ez, C: e.C, cls: e.cls })) ours = { t, side, d };
      if (theirs == null && e.C?.guns && d <= e.C.reach) {
        const rel = relBearing(ex, ez, e.heading, px, pz);
        if (Math.abs(Math.abs(rel) - 90) <= 32) theirs = { t, side: rel > 0 ? "starboard" : "port", d };
      }
    }
    const name = contactName(e);
    if (ours) out.push({ id: e.id, kind: "ours", eta: ours.t, text: ours.t === 0 ? `${cap(name)} is in our ${ours.side} arc now, ${metres(ours.d)}.` : `${cap(name)} bears on our ${ours.side} guns in ~${ours.t} s at this heading.` });
    if (theirs) out.push({ id: e.id, kind: "theirs", eta: theirs.t, text: theirs.t === 0 ? `We're in ${name}'s ${theirs.side} broadside arc now.` : `${cap(name)}'s ${theirs.side} broadside bears on us in ~${theirs.t} s.` });
  }
  return out.sort((a, b) => a.eta - b.eta).slice(0, maxN);
}

/** Hazards on the water now (storm, wave, Kraken, mortars, maelstrom), as facts. */
export function hazardText(sim) {
  const S = sim.S, P = S.ship, H = S.hazards, bits = [];
  if (H.wave) {
    const a = Math.abs(wrap180(P.heading - H.wave.dirDeg));
    const now = a <= 25 ? "it's on our stern now" : a >= 155 ? "it's on our bow now" : `it's ${Math.round(Math.min(a, 180 - a))}° off our bow/stern line now`;
    bits.push(`rogue wave rolling in from the ${compass8Abbr(H.wave.dirDeg + 180)} in ~${Math.max(0, Math.round(H.wave.eta))} s; one within 25° of bow or stern does no harm, ${now}`);
  }
  if (H.kraken) bits.push(H.kraken.stage === "ink" ? "ink in the water around us" : H.kraken.stage === "grab"
    ? `the Kraken's arms hold the ${H.kraken.arms.filter((a) => a.hp > 0).map((a) => `${a.side} ${STATION_LABEL[a.station]}`).join(", ")} (each one slows us and works at the hull; the Captain's swivel or a heavy volley down that side knocks them off, or a gun crew on that side ordered at the Kraken)`
      : "the Kraken is letting go");
  if (S.storm?.inside) bits.push("we're inside the storm cell: visibility 140 m");
  else if (S.storm && dist(P.x, P.z, S.storm.x, S.storm.z) < S.storm.r + 300) bits.push(`the storm cell is ${metres(dist(P.x, P.z, S.storm.x, S.storm.z) - S.storm.r)} off`);
  for (const m of H.mortars) if (m.from !== "rexmaw") bits.push(`mortar shell landing ${dist(m.x, m.z, P.x, P.z) < m.r + 5 ? "on us" : `${metres(dist(m.x, m.z, P.x, P.z))} off`} in ~${Math.max(0, Math.round(m.eta))} s`);
  const M = S.world.maelstrom;
  if (M) { const d = dist(P.x, P.z, M.x, M.z); if (d < M.r + 200) bits.push(d < M.r ? `in the maelstrom's pull, ${metres(d)} from the eye` : `the maelstrom is ${metres(d - M.r)} off`); }
  if (S.fogHere > 0.3) bits.push(`we're in fog: we see ${metres(S.visibility)}`);
  // v4: the random sea events in play (or telegraphed).
  const sea = S.simRef?.sea;
  if (sea) for (const ev of sea.list()) bits.push(sea.factFor(ev, ev.stage === "warn" ? "warn" : "start").replace(/\.$/, ""));
  return bits.join("; ");
}

/** The mission tracker as facts: the current step of the chain (where it is), the fail counters, the bonus. */
export function missionLine(S) {
  const M = S.mission;
  if (!M) return "";
  const left = Math.max(0, Math.round(S.cfg.limit - S.t));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  if (!M.steps) {
    const objs = M.objectives.map((o) => `${o.text}${o.of > 1 ? ` ${o.count}/${o.of}` : ""}${o.done ? " (done)" : o.failed ? " (failed)" : ""}`).join("; ");
    return `**${S.cfg.label}:** ${objs}. ${clock}.`;
  }
  const i = Math.min(M.step, M.steps.length - 1);
  const cur = M.objectives[i];
  const P = S.ship;
  let where = "";
  const mk = M.steps[i]?.marker ? (() => { try { return M.steps[i].marker({ sim: S.simRef, S, P, W: S.world, M, v: S.world.variant || {} }); } catch { return null; } })() : null;
  if (mk) {
    const e = mk.kind === "ship" ? S.ships.find((x) => x.id === mk.contactId) : null;
    const x = e ? e.x : mk.x, z = e ? e.z : mk.z;
    if (Number.isFinite(x) && Number.isFinite(z)) { const brg = headingOf(x - P.x, z - P.z); where = ` (${metres(dist(P.x, P.z, x, z))} ${compass8Abbr(brg)}, ${degText(brg)})`; }
  }
  const step = M.status === "active" ? `step ${i + 1}/${M.steps.length}: ${cur?.text || ""}${cur && cur.of > 1 ? ` ${cur.count}/${cur.of}` : ""}${where}` : M.status === "success" ? "done" : "failed";
  const fails = M.fails.filter((f) => f.id !== "time").map((f) => { try { return `${f.text} (${Math.round(Math.min(1, f.value({ sim: S.simRef, S, P, W: S.world, M }) / f.max) * 100)}%)`; } catch { return f.text; } });
  const bonus = M.bonus && !M.bonus.done && !M.bonus.failed ? ` Bonus: ${M.bonus.text}.` : "";
  return `**${S.cfg.label}:** ${step}. Lost if: ${fails.join("; ") || "the Rexmaw sinks"}, or time runs out. ${clock}.${bonus}`;
}

/** look_around: everything, now. */
export function fullBrief(sim, { captain = null, rt = 0, suggestion = null, targetName } = {}) {
  const S = sim.S, P = S.ship;
  const cs = sim.visibleContacts().filter((e) => e.state !== "sinking").sort((a, b) => dist(P.x, P.z, a.x, a.z) - dist(P.x, P.z, b.x, b.z));
  const lines = [missionLine(S)];
  lines.push(cs.length ? `**Contacts:** ${cs.slice(0, BRIEF.maxContacts + 2).map((e) => contactLine(e, P)).join(" ")}` : `**Contacts:** none in sight (we see ${metres(S.visibility)}).`);
  // The Gloam hiding in her fog: the lookout can still follow her wake.
  for (const e of S.ships) if (e.cloaked && !e.gone && e.state !== "sinking") lines.push(`**Lookout:** a dark shape in the fog ${metres(dist(P.x, P.z, e.x, e.z))} ${compass8Abbr(headingOf(e.x - P.x, e.z - P.z))} (${degText(headingOf(e.x - P.x, e.z - P.z))}), ${sideWord(relBearing(P.x, P.z, P.heading, e.x, e.z))} — ${contactName(e, { known: true })}.`);
  lines.push(shipLine(P, S));
  lines.push(ordersLine(sim, { targetName }));
  const hz = hazardLine(sim);
  if (hz) lines.push(hz);
  const ln = lanternLine(sim);
  if (ln) lines.push(ln);
  const sea = hazardText(sim);
  if (sea) lines.push(`**Sea:** ${sea}`);
  const pu = sim.pw?.briefLine?.();   // v4.2: power-ups afloat and on us
  if (pu) lines.push(pu);
  lines.push(`**Wind:** from the ${compass8Abbr(S.wind.dirDeg)}; ${S.night ? "night" : "day"}, visibility ${metres(S.visibility)}.`);
  if (suggestion) lines.push(`**Your suggestion on the Captain's screen:** ${suggestion.kind}${suggestion.targetName ? ` (${suggestion.targetName})` : ""}.`);
  const cl = captainLine(captain, rt);
  if (cl) lines.push(cl);
  const w = windows(sim);
  if (w.length) lines.push(w.map((x) => x.text).join(" "));
  return lines.filter(Boolean).join("\n");
}

/**
 * The cadence. push({key, priority: "note"|"low"|"high"|"critical", text, t}); update(rt, compose)
 * returns {text, silent, priority, keys} or null. compose(facts, loud) builds the message.
 */
export function createBriefer({ gap = () => BRIEF.gapCall, maxAge = 30 } = {}) {
  const pending = new Map();
  let lastLoud = -Infinity, lastAny = -Infinity;
  const rank = { note: 0, low: 1, high: 2, critical: 3 };
  return {
    push(fact) {
      if (!fact?.key || !fact.text) return;
      const prev = pending.get(fact.key);
      const p = fact.priority || "low";
      const priority = prev && rank[prev.priority] > rank[p] ? prev.priority : p;
      pending.set(fact.key, { ...fact, priority, t: prev ? Math.min(prev.t, fact.t) : fact.t });
    },
    has: (key) => pending.has(key),
    drop(key) { pending.delete(key); },
    clear() { pending.clear(); },
    pending: () => [...pending.values()],
    lastLoud: () => lastLoud,
    update(rt, compose) {
      for (const [k, f] of pending) if (rt - f.t > maxAge && f.priority !== "critical") pending.delete(k);
      if (!pending.size) return null;
      const facts = [...pending.values()];
      const top = facts.reduce((m, f) => Math.max(m, rank[f.priority] ?? 1), 0);
      const g = gap();
      if (top < 3 && rt - (top >= 1 ? lastLoud : lastAny) < g) return null;
      const loud = top >= 1;
      const text = compose(facts.sort((a, b) => (rank[b.priority] ?? 1) - (rank[a.priority] ?? 1) || a.t - b.t), loud);
      pending.clear();
      lastAny = rt;
      if (loud) lastLoud = rt;
      return { text, silent: !loud, priority: ["low", "low", "high", "critical"][top], keys: facts.map((f) => f.key) };
    },
  };
}

export { MODE_WORDS };
