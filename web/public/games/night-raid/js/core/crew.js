// The crew (spec v2 §4): the five named crew (and the companion's own figure
// when they aren't one of them) plus the hands. Nobody does anything on their
// own any more except reload the guns the Captain fires: the named crew stand
// at calm posts until an order — the companion's or the Captain's — gives them
// a job, then walk to it and work it until it's done:
//   guns   (man_guns: a gun captain at that battery; Leo by default, Rex for the mortar)
//   repair (Ara and 8 hands at damage control: hammering, buckets)
//   bail   (Sal and 4 hands at the pumps)
// Hands on a job are off the guns, so the reloads slow down: the trade-off.
//
//   const crew = createCrew({ companionSlot, hands, onLog })
//   crew.startJob(kind, {side, who, by, why, t}) → {ok, job, who, text}
//   crew.endJob(jobId) ; crew.jobOf(kind, side) ; crew.jobs
//   crew.reloadMul() ; crew.gunnerSkill(side) ; crew.workMul(kind)
//   crew.update(dt, {ship, reloading, bears, disabled}) → events (arrivals)
//   crew.killHands(n) ; crew.addHands(n) ; crew.overboard(who) ; crew.back(who) ; crew.snapshot()
//
// Pure: no three.js, no DOM, no randomness.

import { NAMED, NAMED_LABEL, STATION_LABEL, DEFAULT_NAMED, CREW, HANDS, JOB_CREW, CREW_AIM, REXMAW, STATIONS, REPAIR, BILGE } from "./const.js";
import { clamp } from "./geom.js";
import { reloadMul as reloadCurve } from "./gunnery.js";

const STATION_OF = { port: "guns_port", starboard: "guns_starboard", bow: "bow_chaser", mortar: "mortar" };
const SIDE_OF = { guns_port: "port", guns_starboard: "starboard", bow_chaser: "bow", mortar: "mortar" };
const ROUND = (v) => Math.round(v * 10) / 10;

export const stationOfSide = (side) => STATION_OF[side] || null;
export const label = (who) => NAMED_LABEL[who] || who;

export function createCrew({ companionSlot = null, hands = REXMAW.hands, onLog = null } = {}) {
  const slot = NAMED.includes(companionSlot) ? companionSlot : null;
  const ids = slot ? [...NAMED] : [...NAMED, "me"];
  const named = {};
  for (const id of ids) {
    const home = DEFAULT_NAMED[id] || "quarterdeck";
    named[id] = { home, station: home, at: home, walkT: 0, overboard: false, task: "stand_by", job: null, companion: id === slot };
  }
  let total = hands;
  let jobN = 0;
  const jobs = [];
  const log = [];
  const disabled = new Set();

  const resolve = (who) => (who === "me" && slot ? slot : who);
  const present = (id) => { const n = named[id]; return !!n && !n.overboard && n.walkT <= 0 && n.at != null; };

  function record(entry) {
    const e = { t: ROUND(entry.t || 0), kind: entry.kind || "event", by: entry.by || "crew", who: entry.who || null, text: entry.text || "", why: entry.why || "" };
    log.push(e);
    try { onLog?.(e); } catch { /* the log listener is a nicety */ }
    return e;
  }

  function walkTo(id, station) {
    const n = named[id];
    if (!n) return;
    n.station = station;
    if (n.overboard) return;
    if (n.at === station && n.walkT <= 0) return;
    n.walkT = CREW.walkS; n.at = null;
  }

  // ---- Jobs -----------------------------------------------------------------------------------

  const jobOf = (kind, side = null) => jobs.find((j) => j.kind === kind && (side == null || j.side === side)) || null;
  const handsOnJobs = () => jobs.reduce((a, j) => a + j.hands, 0);

  /** Who takes a job: the named member asked for, else the first free one in the job's list. */
  function pick(kind, whoRaw) {
    const want = whoRaw ? resolve(whoRaw) : null;
    if (want) {
      if (!named[want]) return { error: `${label(whoRaw)} isn't aboard` };
      if (named[want].overboard) return { error: `${label(want)} is overboard` };
      return { id: want };
    }
    const list = JOB_CREW[kind === "guns" ? "guns" : kind] || NAMED;
    const free = (id) => named[id] && !named[id].overboard && !named[id].job;
    const id = list.find(free) || ids.find(free) || list.find((x) => named[x] && !named[x].overboard) || null;
    return { id };
  }

  /**
   * Start a job (or re-target the one already there). kind: guns | repair | bail. side: port | starboard | bow | mortar (guns).
   * Returns {ok, job, who, text}.
   */
  function startJob(kind, { side = null, who = null, by = "companion", why = "", t = 0, quiet = false } = {}) {
    let job = jobOf(kind, kind === "guns" ? side : null);
    const station = kind === "guns" ? STATION_OF[side] : kind === "repair" ? "damage" : "pumps";
    if (!station) return { ok: false, text: `no station for ${kind}` };
    const p = pick(kind === "guns" && side === "mortar" ? "mortar" : kind, who);
    if (p.error) return { ok: false, text: p.error };
    if (!job) {
      job = { id: `job${++jobN}`, kind, side, station, who: [], hands: kind === "repair" ? HANDS.repair : kind === "bail" ? HANDS.bail : HANDS.manned, t, by, why };
      jobs.push(job);
    }
    job.by = by; job.why = why || job.why;
    if (p.id && !job.who.includes(p.id)) {
      // Someone already on another job leaves it for this one.
      const prev = jobs.find((j) => j !== job && j.who.includes(p.id));
      if (prev) prev.who = prev.who.filter((x) => x !== p.id);
      job.who = [p.id];
      named[p.id].job = job.id;
      walkTo(p.id, station);
    }
    const whoText = job.who.length ? label(job.who[0]) : "the hands";
    const text = kind === "guns" ? `${whoText} to the ${STATION_LABEL[station]}` : kind === "repair" ? `${whoText} and ${job.hands} hands to damage control` : `${whoText} and ${job.hands} hands to the pumps`;
    if (!quiet) record({ t, kind: "order", by, who: job.who[0] || null, text, why });   // a crew mode's own jobs don't fill the log
    return { ok: true, job, who: job.who.slice(), text };
  }

  function endJob(id, { t = 0, text = "" } = {}) {
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return null;
    const job = jobs[i];
    jobs.splice(i, 1);
    for (const w of job.who) {
      const n = named[w];
      if (!n || n.job !== job.id) continue;
      n.job = null;
      walkTo(w, n.home);
    }
    if (text) record({ t, kind: "event", by: "crew", who: job.who[0] || null, text, why: "" });
    return job;
  }

  // ---- What the jobs do to the ship ----------------------------------------------------------------

  /** Reloads slow down when hands are off the guns (repair, bail) or dead. */
  function reloadMul() {
    const gunHands = clamp(total - handsOnJobs() - HANDS.posts, 0, HANDS.guns);
    return reloadCurve(gunHands / HANDS.guns);
  }

  /** The gun captain's skill at a battery (a named crew member there, else the hands). */
  function gunnerSkill(side) {
    const j = jobOf("guns", side);
    const id = j?.who.find((w) => present(w) && named[w].at === j.station);
    return CREW_AIM.skill[id] ?? CREW_AIM.skill.hands;
  }

  /** Work rate multiplier for a job: Ara on repairs ×1.5, Sal on the pumps ×1.5; 0.5 until someone's arrived. */
  function workMul(kind) {
    const j = jobOf(kind);
    if (!j) return 0;
    const at = j.who.filter((w) => present(w) && named[w].at === j.station);
    if (!at.length && j.who.length) return 0.5;
    if (kind === "repair" && at.includes("ara")) return REPAIR.araMul;
    if (kind === "bail" && at.includes("sal")) return BILGE.salMul;
    return 1;
  }

  // ---- The tick ---------------------------------------------------------------------------------------

  /** ctx: {ship, reloading: {side: bool}, bears: {side: bool}, disabled: [stations]}. */
  function update(dt, ctx) {
    const out = [];
    disabled.clear();
    for (const s of ctx.disabled || []) disabled.add(s);
    for (const id of ids) {
      const n = named[id];
      if (n.overboard) continue;
      if (n.walkT > 0) {
        n.walkT -= dt;
        if (n.walkT <= 0) { n.walkT = 0; n.at = n.station; out.push({ type: "arrived", who: id, station: n.station }); }
      }
    }
    for (const id of ids) named[id].task = taskOf(id, ctx);
    return out;
  }

  function taskOf(id, ctx) {
    const n = named[id];
    if (n.overboard) return "overboard";
    if (n.walkT > 0) return "walk";
    const st = n.at;
    if (disabled.has(st)) return "grabbed";
    const ship = ctx.ship;
    const job = n.job ? jobs.find((j) => j.id === n.job) : null;
    if (job?.repel) return "repel";
    switch (st) {
      case "guns_port": case "guns_starboard": case "bow_chaser": case "mortar": {
        const side = SIDE_OF[st];
        return ctx.reloading?.[side] ? "reload" : ctx.bears?.[side] ? "aim" : "stand_by";
      }
      case "damage": return !job ? "stand_by" : ship.fires > 0 ? "fight_fire" : ship.leaks > 0 ? "patch" : job.what === "masts" ? "repair_mast" : "patch";
      case "pumps": return job ? "pump" : "stand_by";
      case "sails": return "haul";
      case "lookout": return "spyglass";
      case "powder": return "carry_powder";
      case "boarding": return "ready_arms";
      case "galley": return "cook";
      case "quarterdeck": return id === "me" || n.companion ? "command" : "stand_by";
      case "repel": return "repel";
      default: return "stand_by";
    }
  }

  // ---- Bodies -------------------------------------------------------------------------------------------

  function killHands(n) { const k = Math.min(n, total); total -= k; return k; }
  function addHands(n) { total = Math.min(REXMAW.handsMax, total + n); }
  function overboard(whoRaw) {
    const who = resolve(whoRaw), n = named[who];
    if (!n || n.overboard) return false;
    n.overboard = true; n.at = null; n.walkT = 0;
    return true;
  }
  function back(whoRaw) {
    const who = resolve(whoRaw), n = named[who];
    if (!n || !n.overboard) return false;
    n.overboard = false; n.walkT = CREW.walkS; n.at = null;
    return true;
  }

  function snapshot() {
    const nm = {};
    for (const id of ids) {
      const n = named[id];
      nm[id] = { station: n.station, at: n.at, task: n.task, walking: n.walkT > 0, overboard: n.overboard, companion: !!n.companion, job: n.job };
    }
    const st = {};
    for (const s of STATIONS) st[s] = { named: ids.filter((id) => present(id) && named[id].at === s), disabled: disabled.has(s) };
    return { named: nm, stations: st, hands: total, onJobs: handsOnJobs(), jobs: jobs.map((j) => ({ ...j, who: j.who.slice() })) };
  }

  return {
    ids, slot, named, log, jobs, resolve, record,
    startJob, endJob, jobOf, reloadMul, gunnerSkill, workMul, update,
    killHands, addHands, overboard, back, snapshot,
    present: (who) => present(resolve(who)),
    hands: () => total,
    atOf: (who) => named[resolve(who)]?.at ?? null,
  };
}
