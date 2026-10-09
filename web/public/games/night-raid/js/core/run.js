// The run: Rexmaw Raids' state machine. It owns one mission from the title to
// the results: the bay, the sim, the crew, the objective chain, the
// companion's twelve tools and speech triggers, the briefs, suggestions,
// heading calls and danger marks, crew modes, boarding rounds, the Captain's
// intents (helm, sails, sprint, aim and fire, mark), the contribution
// counters, the ship's log and the score.
//
// v4: boarding is a deck fight (boarding.js: one press of B in her ring; the Captain's pistol, Rally; the
// companion's boarding_order), the target lock (lock / lock_cycle; `mark` is its alias), the random sea
// events (seaevents.js, via the sim) and the `sink` event's cinematic flag.
//
//   title → briefing (the card; waits for start_voyage, `back` → title) → sailing ⇄ boarding
//         → ending (4 s: success / sunk / out of time / they got away / spotted / home) → results
//
// In:  run.input(intent, payload)     the user's intents (never throws; false when it doesn't apply)
//      run.companion(action, args)    the companion's tool → a result string, or throws Refuse (why + options)
//      run.heard(text)                what the companion said: "Fire!" fires held batteries, "Brace!" flashes the prompt
//      run.step(dt)                   wall seconds; fixed 1/30 s steps inside, the "tick" event at 10 Hz
//      run.aimPreview(look?)          the Captain's arcs for the scene/HUD (gunnery.aimPreview on the live sim)
// Out: run.on(event, fn) / run.state() / run.pose() / run.world() / run.results() / run.log()
//
// The companion acts on orders. Without any, the crew only reloads what the
// Captain fires: no gun fires, no repair starts, no pump runs (tested).
// Pure: no three.js, no DOM, no Math.random. Time comes only from step(dt).

import {
  MODES, MISSIONS, DEFAULT_MODE, DEFAULT_MISSION, STEP, TICK_HZ, PHASE_S, OFFCALL, BOARD, MOMENTS, MORALE, NAMED,
  STATION_LABEL, CLASSES, WHY_MAX, LOG_KEEP, SPYGLASS_MARK_S, SAIL_NAMES, BRIEF, KRAKEN, ORDER_MODES, REPAIR_WHAT,
  DANGER_KINDS, DANGER, SUGGEST, SUGGEST_KINDS, HEADING_CALL_S, WEAPONS, REEFS, MEDAL_CATS, ARENA, PICKUP_KINDS,
  CREW_MODES, CREW_MODE_INFO, CONTRIB, LOCK,
} from "./const.js";
import { createBus, EVENTS } from "./bus.js";
import * as rngLib from "./rng.js";
import { generateWorld, arenaWorld, hazardsOf } from "./world.js";
import { createCrew, label as crewLabel, stationOfSide } from "./crew.js";
import { createSim } from "./sim.js";
import { setupMission, checkMission, medalsFor, lootOf, objectiveState, briefingFor } from "./missions.js";
import { boardProblem, boardInfo, createFight, stepFight, fightState, fightOver, fightLine, pistol as firePistol, rally as fightRally, setFocus,
  pickArchetype, ARCHETYPES } from "./boarding.js";
import {
  contactLine, contactName, shipLine, ordersLine, captainLine, windows, fullBrief, createBriefer, hazardText, hazardLine, lanternLine,
  hiddenHazards, missionLine, MODE_WORDS,
} from "./brief.js";
import {
  parseSide, parseAmmo, parseManMode, parseWho, parseRepairWhat, parseHeading, parseWhere, parseDangerKind, parseSuggestKind, parseMove,
  parseMoment, parseSpeech, clean, compassIn, relIn, parseDistance, ACTION_NAMES, parseCrewMode, parseFocus,
} from "./protocol.js";
import { intentWords } from "./ships.js";
import { score as scoreOf } from "./score.js";
import { bears as batteryBears } from "./gunnery.js";
import { clamp, dist, round1, wrap180, wrap360, headingOf, relBearing, compass8Abbr, compassWord, compassAbbr, degText, sideWord, metres, forward, segDist } from "./geom.js";

class LocalRefuse extends Error {}

const ACTIVE = new Set(["sailing", "boarding"]);
const PAUSABLE = new Set(["briefing", "sailing", "boarding"]);
const CAPTAIN_ORDERS = new Set(["man_guns", "repair", "bail", "mark_danger", "call_heading", "spyglass", "brace_call"]);
const POI_WORDS = [["cove", /\b(cove|smuggler|smugglers)\b/], ["maelstrom", /\b(maelstrom|whirlpool|vortex)\b/], ["port", /\b(port|home|harbour|harbor|mouth)\b/],
  ["fort", /\bfort\b/], ["storm", /\bstorm\b/], ["exit", /\b(exit|cape|far cape|way out)\b/], ["convoy", /\bconvoy\b/], ["patrol", /\bpatrol\b/]];

const whyOf = (args) => String(args?.why ?? args?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, WHY_MAX).replace(/[\s,;:-]+$/, "");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Make a run.
 * @param {Object} [deps]
 * @param {string} [deps.mode]        the kit tab: day | night | free
 * @param {string} [deps.mission]     a MISSIONS id to start with
 * @param {number|null} [deps.seed]   pin the first mission's seed
 * @param {() => boolean} [deps.onCall] @param {"wait"|"separate"|"latest"} [deps.offcall] @param {() => boolean} [deps.connected]
 * @param {typeof Error} [deps.Refuse]
 */
export function createRun({ clock = null, rng = null, mode = DEFAULT_MODE, mission = null, seed = null, onCall = () => false, offcall = "wait",
  connected = () => true, Refuse = null } = {}) {
  const Rlib = rng && typeof rng.createRng === "function" ? rng : rngLib;
  const RefuseErr = Refuse || globalThis.RexGame?.Refuse || LocalRefuse;
  const events = createBus({ types: EVENTS, name: "run" });

  let phase = "title", phaseT = 0, paused = false, camera = "chase";
  let modeId = MODES[mode] ? mode : DEFAULT_MODE;
  let missionId = MISSIONS[mission] ? mission : null;
  let pinnedSeed = seed;
  /** The next boarding's captain archetype, forced (debug / tests: setArchetype); null = the seeded pick. */
  let forcedArchetype = null;
  let companionName = "Your companion", companionSlot = null;
  let rt = 0, acc = 0, tickAcc = 0;
  let world = null, sim = null, crew = null, briefer = null, V = null, results = null, cfg = null;
  let seedUsed = null, arena = null;
  let prevPose = null, saved = null, obstacles = [];

  const call = () => { try { return !!onCall(); } catch { return false; } };
  const isConnected = () => { try { return !!connected(); } catch { return false; } };
  const solo = () => !call() && (offcall === "wait" || !isConnected());
  const offCall = () => !call() && !solo();
  const pace = () => (phase === "boarding" ? BOARD.worldPace : 1) * (offCall() ? OFFCALL.pace : 1);
  const tele = () => (offCall() ? OFFCALL.telegraph : 1);

  function emit(type, payload) {
    try { events.emit(type, payload); } catch (error) { console.debug("[rexmaw-raids] run emit failed", error); }
  }
  function setPhase(next) {
    if (next === phase) return;
    const prev = phase;
    phase = next; phaseT = 0;
    emit("phase", { phase, prev, world: next === "briefing" || (next === "sailing" && prev === "title") ? world : undefined });
  }
  const refuse = (text) => { throw new RefuseErr(text); };
  const P = () => sim?.S.ship;
  const nameOf = (id) => { const e = sim?.shipById(id); return e ? contactName(e, { known: true }) : id === "kraken_eye" ? "the Kraken's eye" : id; };
  const targetName = (t) => (t === "kraken" ? "the Kraken's arms" : sim?.shipById(t) ? contactName(sim.shipById(t), { known: true }) : t || "nothing");

  // ---- A mission ------------------------------------------------------------------------------

  function pickMission({ mission: m = null, mode: md = null, night = false } = {}) {
    if (MISSIONS[m]) return m;
    const tab = MODES[md] ? md : modeId;
    if (tab === "free") return night ? "free_night" : "free_day";
    if (missionId && MISSIONS[missionId]?.tab === tab) return missionId;
    return MODES[tab].missions[0] || DEFAULT_MISSION;
  }

  function begin({ mission: m = null, mode: md = null, night = false, seed: sd = null, arena: ar = null } = {}) {
    arena = ar || null;
    missionId = arena ? null : pickMission({ mission: m, mode: md, night });
    if (missionId) modeId = MISSIONS[missionId].tab;
    const s = sd != null && sd !== "" ? (Number.isFinite(Number(sd)) ? Number(sd) >>> 0 : Rlib.hashString(String(sd)))
      : pinnedSeed != null ? pinnedSeed : Rlib.freshSeed();
    pinnedSeed = null;
    seedUsed = s;
    world = arena ? arenaWorld(s, arena) : generateWorld(s, missionId);
    cfg = arena ? ARENA : MISSIONS[missionId];
    V = {
      captain: null, spy: null, suggestion: null, sugN: 0, lastSuggestT: -1e9, course: null, boarding: null, lastOrder: null,
      orders: { companion: 0, captain: 0 }, delta: null, moments: {}, told: new Map(), inRange: new Set(), hullMark: 100, waterMark: 0,
      firesWere: 0, wave: null, boardWhenReady: null, lastBarkT: {}, ended: null, lostPlunder: 0, lastBoarding: null,
      headingCall: null, dangers: [], dangerN: 0, braceCall: null, fogIn: false, cloaked: {}, lanternAlert: {}, briefedAt: -1e9,
      braceCalls: [], briefing: null, lockBy: null,
    };
    crew = createCrew({ companionSlot, onLog: (e) => emit("log", e) });
    sim = createSim({ world, rng: Rlib.createRng(s).fork("sim"), mission: missionId || "arena", tele, crew });
    sim.S.names = { me: companionName };   // the companion's own figure in the contribution pops ("+12 Ada's guns")
    if (!arena) sim.setObstacles(obstacles);
    setupMission(sim);
    briefer = createBriefer({ gap: () => (call() ? BRIEF.gapCall : BRIEF.gapOff) });
    results = null; paused = false; acc = 0; prevPose = null;
    if (arena) {
      sim.setSail(1);
      sim.S.ship.speed = 6;
      setPhase("sailing");
    } else {
      V.briefing = briefingFor(world);
      setPhase("briefing");
      emit("mission", { stage: "start", id: missionId, label: cfg.label, time: cfg.time, variant: V.briefing.variant });
      tell(briefing(), true);
    }
  }

  /** The silent briefing at the pier: the mission, the bay in compass words, facts only. */
  function briefing() {
    const p = world.port, at = (x, z) => `${compass8Abbr(headingOf(x - p.x, z - p.z))} ${metres(dist(p.x, p.z, x, z))}`;
    const bits = [];
    if (world.fort) bits.push(`the fort's ${world.fort.towers.length} gun towers at ${at(world.fort.x, world.fort.z)} (range 380 m; mortars and close heavy shot break them)`);
    if (world.exit && missionId !== "smugglers_run") bits.push(`${missionId === "krakens_wake" ? "the harbour mouth (our way out)" : "the far cape (where they escape)"} at ${at(world.exit.x, world.exit.z)}`);
    if (world.cove) bits.push(`the smugglers' cove at ${at(world.cove.x, world.cove.z)}`);
    if (world.wrecks.length) bits.push(`wrecks at ${world.wrecks.map((w) => at(w.x, w.z)).join(", ")} (stop beside one under 3 m/s for ${Math.round(6)} s to salvage)`);
    if (world.maelstrom) bits.push(`the maelstrom at ${at(world.maelstrom.x, world.maelstrom.z)} (pull from 220 m; the eye sinks ships)`);
    if (world.storm) bits.push(`a storm cell at ${at(world.storm.x, world.storm.z)}`);
    if (world.fog.length) bits.push(`${world.fog.length} fog bank${world.fog.length === 1 ? "" : "s"} (you see ~110 m inside one)`);
    const hidden = (world.reefs || []).length;
    if (hidden) bits.push(`${hidden} reef bands and rocks on your chart${cfg.time === "night" ? " — the Captain's chart can't show them in the dark: navigate for them" : ""}`);
    const foes = world.fleet.map((f) => `${f.name} (${CLASSES[f.cls]?.label || f.cls}${f.chest ? ", the chest ship" : ""}${f.prize ? ", the prize" : ""}${f.lantern ? ", lantern" : ""})`).join(", ");
    const B = V.briefing;
    const chain = B ? ` Steps: ${B.steps.map((s, i) => `${i + 1}) ${s.text}`).join("; ")}. Lost if: ${B.fail.map((f) => f.text).join("; ")}.${B.bonus ? ` Bonus: ${B.bonus.text} (+${B.bonus.reward} gold).` : ""} ${B.variant?.label || ""}` : "";
    return `${cfg.label}. ${B?.summary || cfg.objective}${chain} ${Math.round(cfg.limit / 60)} minutes. ${cfg.time === "night" ? "Night" : "Day"}; wind from the ${compassWord(world.wind.dirDeg)}. `
      + `${foes ? `Ships: ${foes}. ` : ""}The bay: ${bits.join("; ") || "open water"}. The Rexmaw is at home port, the bay's south edge. `
      + `Ammo: chain ${cfg.ammo.chain}, mortar ${cfg.ammo.mortar}, barrels ${cfg.ammo.barrels} (round and heavy unlimited).`;
  }

  /** The Captain's "Set sail" on the briefing card (start_voyage): she casts off; the chain's first step starts. */
  function castOff() {
    if (phase !== "briefing") return false;
    setPhase("sailing");
    if (P().sail < 1) sim.setSail(1);
    pushFact({ key: "castoff", priority: "low", head: "Under way", text: `We've cast off. ${missionLine(sim.S)}` });
    return true;
  }

  // ---- Facts for the briefs -------------------------------------------------------------------

  function pushFact(f) { briefer?.push({ t: rt, ...f }); }
  function tell(text, silent = true, priority = "low") { if (text) emit("tell", { text, silent, priority }); }

  function compose(facts, loud) {
    const lines = facts.map((f) => (f.head ? `**${f.head}** — ${f.text}` : f.text));
    if (!loud) return lines.join("\n");
    const s = sim.S;
    lines.push(shipLine(s.ship, s));
    lines.push(ordersLine(sim, { targetName }));
    const hz = s.night || s.fogHere > 0.3 ? hazardLine(sim, { max: 4, range: 500 }) : "";
    if (hz && !facts.some((f) => f.key === "reefs")) lines.push(hz);
    const ln = lanternLine(sim);
    if (ln) lines.push(ln);
    const cl = captainLine(V.captain, rt);
    if (cl) lines.push(cl);
    const w = windows(sim, { maxN: 2 });
    if (w.length) lines.push(w.map((x) => x.text).join(" "));
    V.briefedAt = rt;
    return lines.join("\n");
  }

  // ---- The fixed step -----------------------------------------------------------------------------

  function fixedStep(h) {
    if (!sim || paused) return;
    phaseT += h;
    switch (phase) {
      case "sailing":
      case "boarding":
      case "ending": {
        prevPose = poseNow();
        const evs = sim.step(h * pace());
        // The deck fight runs at full speed while the world around it crawls (BOARD.worldPace).
        if (phase === "boarding" && V.boarding) {
          for (const fe of stepFight(V.boarding, h)) fightEvent(fe);
          const over = fightOver(V.boarding);
          if (over) finishBoarding(over);
        }
        if (phase !== "ending") {
          for (const e of evs) handle(e);
          const mc = checkMission(sim, h * pace());
          for (const e of mc.events) objectiveEvent(e);
          if (arena && !mc.end) arenaCheck();
          else if (mc.end) end(mc.end.outcome, mc.end.reason, mc.end.failure);
        } else for (const e of evs) handle(e);   // the last shots land, the crews stand down
        if (phase === "ending" && phaseT >= PHASE_S.ending) toResults();
        break;
      }
      default: break;
    }
  }

  function relay(e) { const { type, ...rest } = e; emit(type, rest); }

  function bark(who, id, minGap = 6, extra = {}) {
    if (!who || who === companionSlot) return;
    if (!crew.ids.includes(who) || (!crew.present(who) && id !== "ack_station")) return;
    if ((V.lastBarkT[id] ?? -1e9) > rt - minGap) return;
    V.lastBarkT[id] = rt;
    emit("crew_line", { who, id, ...extra });
  }
  const anyNamed = (prefer = []) => [...prefer, ...NAMED].find((id) => crew.ids.includes(id) && crew.present(id) && id !== companionSlot);

  /** The chain's events: relayed as they are, and told to the companion as facts (what the Captain is on now, the warnings). */
  function objectiveEvent(e) {
    relay(e);
    const where = e.marker?.dist != null ? ` (${metres(e.marker.dist)} ${e.marker.compass})` : "";
    switch (e.stage) {
      case "start": pushFact({ key: "obj:step", priority: e.step > 1 ? "high" : "low", head: `Objective ${e.step}/${e.of}`, text: `${e.text}${where}.` }); break;
      case "done": pushFact({ key: `obj:${e.id}`, priority: "high", head: e.bonus ? "Bonus" : "Objective", text: e.bonus ? `${e.text}: done (+${e.reward} gold).` : `Done: ${e.text}.` }); break;
      case "progress": pushFact({ key: `obj:${e.id}`, priority: "low", head: "Objective", text: `${e.text}: ${e.count}/${e.need}.` }); break;
      case "warn": pushFact({ key: `warn:${e.id}`, priority: e.level >= 0.85 ? "critical" : "high", head: e.level >= 0.85 ? "Close to failing" : "Warning", text: `${e.text}: ${e.label}.` }); break;
      case "fail": if (e.bonus) pushFact({ key: `obj:${e.id}`, priority: "low", head: "Bonus", text: `${e.text}: missed.` }); break;
      default: break;
    }
  }

  function handle(e) {
    const s = sim.S, P0 = s.ship;
    switch (e.type) {
      case "contact": {
        relay(e);
        if (e.stage !== "appear") break;
        const c = sim.shipById(e.id);
        if (!c) break;
        const d = dist(P0.x, P0.z, c.x, c.z);
        const hostile = c.fixed || c.hostile || c.role === "hunter";
        pushFact({ key: `contact:${e.id}`, priority: hostile && d < 500 ? "high" : "low", head: c.C?.legendary ? cap(contactName(c, { known: true })) : "New contact", text: contactLine(c, P0) });
        break;
      }
      case "known": {
        const c = sim.shipById(e.id);
        if (c && !briefer.has(`contact:${e.id}`)) pushFact({ key: `known:${e.id}`, priority: "low", head: "Made her out", text: contactLine(c, P0) });
        relay(e);
        break;
      }
      case "ports": {
        relay(e);
        if (!e.open) break;
        const c = sim.shipById(e.id);
        if (!c) break;
        const d = dist(P0.x, P0.z, c.x, c.z);
        if (d > 420) break;
        pushFact({ key: `ports:${e.id}`, priority: "high", head: "Ports open", text: c.fixed ? `${cap(contactName(c))}'s guns are run out, ${metres(d)} off (~2 s).` : `${cap(contactName(c))}'s ${e.side === "bow" ? "bow guns are" : `${e.side} ports are`} open, ${metres(d)} ${sideWord(relBearing(P0.x, P0.z, P0.heading, c.x, c.z))} (~2 s).` });
        break;
      }
      case "volley":
        relay(e);
        if (e.by === "rexmaw" && e.firedBy === "crew") {
          const j = crew.jobOf("guns", e.side);
          if (j?.who[0]) bark(j.who[0], "fire_bears", 12);
        }
        break;
      case "impact":
        relay(e);
        if (e.target === "rexmaw" && (e.dmg > 0 || e.braced)) braceCredit(e);
        break;
      case "crew_mode": {
        const text = crewModeText(e.mode);
        relay({ ...e, by: e.by === "companion" ? companionName : e.by, text });
        if (e.by !== "companion") pushFact({ key: "crew_mode", priority: "high", head: "Crew mode", text: `The Captain set the crew to ${CREW_MODE_INFO[e.mode].label}: ${CREW_MODE_INFO[e.mode].line}` });
        break;
      }
      case "fire":
        relay(e);
        if (e.target === "rexmaw" && e.stage === "start" && V.firesWere === 0) {
          pushFact({ key: "fire", priority: "high", head: "Fire aboard", text: `A fire's broken out (${P0.fires} burning; each burns the hull until it burns out or is put out).` });
          bark(anyNamed(["ara"]), "fire_aboard", 15);
        }
        if (e.target === "rexmaw") V.firesWere = P0.fires;
        break;
      case "leak":
        relay(e);
        if (e.stage === "start") pushFact({ key: "leak", priority: "low", head: "Leak", text: `We're holed below the waterline (${P0.leaks} leak${P0.leaks === 1 ? "" : "s"}; water ${Math.round(P0.water)}%).` });
        break;
      case "sink":
        relay(e);
        if (e.ours) pushFact({ key: `sink:${e.id}`, priority: "high", head: e.cls === "tower" ? "Tower down" : "She's going down", text: e.cls === "tower" ? `The fort's ${e.name} is silenced.` : `${e.name} (${CLASSES[e.cls]?.label || e.cls}) is sinking${e.split ? " — rammed in two" : ""}; her cargo's floating where she went down.` });
        break;
      case "surrender":
        relay(e);
        pushFact({ key: `surrender:${e.id}`, priority: "high", head: "Colours struck", text: `${e.name} has struck her colours and heaved to. She can be boarded for 60 s: inside her ring (${BOARD.range} m of her hull), one press of B or your board tool.` });
        bark(anyNamed(["eve", "rex"]), "striking", 10);
        break;
      case "hazard": hazardFact(e); relay(e); break;
      case "overboard":
        relay(e);
        if (e.stage === "swept") {
          pushFact({ key: `overboard:${e.who}`, priority: "high", head: "Man overboard", text: `${e.who === "hand" ? "A hand" : crewLabel(e.who)} went over the side. Under 4 m/s for 3 s within 25 s and they're hauled back in.` });
          bark(anyNamed(["sal", "rex"]), "man_overboard", 5);
        } else pushFact({ key: `overboard:${e.who}`, priority: "low", head: e.stage === "rescued" ? "Back aboard" : "Lost", text: e.stage === "rescued" ? `${e.who === "hand" ? "The hand" : crewLabel(e.who)} is back aboard.` : `${e.who === "hand" ? "The hand's gone." : `${crewLabel(e.who)} is clinging to wreckage; the jolly boat will bring them back.`}` });
        break;
      case "bank":
        relay(e);
        pushFact({ key: "bank", priority: "low", head: "Banked", text: `${e.amount} gold counted in by Rex (${e.total} banked).` });
        bark("rex", "bank", 5);
        break;
      case "pickup":
        relay(e);
        pushFact({ key: `pickup`, priority: "note", head: "Hauled aboard", text: `${e.kind}${e.gold ? ` (${e.gold} gold)` : ""}${e.hull ? ` (+${e.hull} hull)` : ""}${Object.keys(e.ammo || {}).length ? ` (${Object.entries(e.ammo).map(([k, v]) => `+${v} ${k}`).join(", ")})` : ""}${e.note ? `; the note reads ${e.note}` : ""}.` });
        break;
      case "salvage":
        relay(e);
        if (e.stage === "done") pushFact({ key: "salvage", priority: "high", head: "Salvage aboard", text: `${e.value} gold and some shot from the wreck.` });
        if (e.stage === "start") pushFact({ key: "salvage", priority: "note", head: "Salvage", text: "The divers are down on the wreck: hold her under 3 m/s for 6 s." });
        break;
      case "arrived":
        emit("crew_move", { who: e.who, station: e.station, stage: "arrived" });
        break;
      case "job":
        relay(e);
        if (e.stage === "start") for (const w of e.who || []) emit("crew_move", { who: w, station: e.kind === "repair" ? "damage" : e.kind === "bail" ? "pumps" : stationOfSide(e.side), stage: "walk" });
        break;
      case "order_done": {
        if (e.auto) break;   // a crew mode's own repair/pump job: no order traffic
        const text = e.kind === "man_guns" ? `${e.side === "mortar" ? "Mortar" : `${cap(e.side)} guns`}: ${e.why === "fired" ? "fired their volley" : e.why}; the crew stood down.`
          : e.kind === "repair" ? `Repairs (${e.what}) done.` : `Pumps: ${e.why}.`;
        emit("order", { kind: "done", by: "crew", why: e.why, payload: { kind: e.kind, side: e.side, what: e.what, target: e.target }, text });
        pushFact({ key: `done:${e.kind}:${e.side || ""}`, priority: e.kind === "man_guns" && e.why !== "fired" ? "high" : "low", head: "Orders", text });
        break;
      }
      case "spotted": {
        relay(e);
        const c = sim.shipById(e.id);
        if (e.stage === "spotted" && !V.told.has("spotted")) { V.told.set("spotted", rt); pushFact({ key: "spotted", priority: "critical", head: "Spotted", text: `${cap(c ? contactName(c, { known: true }) : "A patrol")}'s lantern found us: the patrols are coming.` }); }
        if (e.stage === "lost") { V.told.delete("spotted"); pushFact({ key: "spotted", priority: "high", head: "Lost them", text: `${cap(c ? contactName(c, { known: true }) : "The patrol")} lost us in the dark and is going back to her beat.` }); }
        break;
      }
      case "escaped": relay(e); pushFact({ key: `escaped:${e.id}`, priority: "high", head: "Got away", text: `${e.name} got away.` }); break;
      case "captured": relay(e); break;
      case "sunk": break;
      case "board_attempt": if (!V.boarding) startBoardingNow(e.id, "enemy"); break;
      case "sea_event": relay(e); seaFact(e); break;
      case "powerup": relay(e); powerupFact(e); break;
      case "gun_down": relay(e); pushFact({ key: `gun:${e.side}`, priority: "low", head: "Gun down", text: `A ${e.side} gun's knocked out (${P0.guns[e.side].live}/${P0.guns[e.side].max}).` }); break;
      default: relay(e); break;
    }
  }

  function hazardFact(e) {
    const P0 = P();
    switch (e.kind) {
      case "wave":
        if (e.stage === "telegraph") pushFact({ key: "wave", priority: "high", head: "Rogue wave", text: `A wall of water ~${Math.round(e.eta)} s out. ${hazardText(sim)}.` });
        break;
      case "kraken":
        if (e.stage === "ink") { pushFact({ key: "kraken", priority: "high", head: "Ink in the water", text: `Something big is under us. ~${Math.round(e.eta)} s.` }); bark(anyNamed(["eve"]), "kraken", 10); }
        if (e.stage === "grab") pushFact({ key: "kraken", priority: "critical", head: "The Kraken", text: `Four arms have the rails: ${e.arms.map((a) => `${a.side} ${STATION_LABEL[a.station]}`).join(", ")}. They slow us and crush the hull. The Captain's swivel or a heavy volley down that side knocks them off; a gun crew on that side ordered at the Kraken hacks at them.` });
        if (e.stage === "repelled") pushFact({ key: "kraken", priority: "high", head: "Kraken repelled", text: `All four arms beaten off: +${KRAKEN.loot} gold from what it dropped.` });
        if (e.stage === "retreat") pushFact({ key: "kraken", priority: "low", head: "Kraken", text: "It let go and sank back down." });
        if (e.stage === "arm") pushFact({ key: `arm:${e.id}`, priority: "low", head: "Arm off", text: `The arm on the ${e.side} ${STATION_LABEL[e.station]} let go.` });
        break;
      case "mortar":
        if (e.stage === "telegraph" && dist(e.x, e.z, P0.x, P0.z) < 90) pushFact({ key: "mortar", priority: "high", head: "Mortar", text: `A shell is falling on our position in ~${Math.round(e.eta)} s (the ring on the water).` });
        break;
      case "fireship":
        if (e.stage === "lit") pushFact({ key: `ram:${e.id}`, priority: "critical", head: "Fire ship lit", text: `A fire ship has lit up ${metres(dist(e.x, e.z, P0.x, P0.z))} off and is steering for us: she explodes on contact.` });
        break;
      case "maelstrom":
        if (e.stage === "enter") pushFact({ key: "maelstrom", priority: "high", head: "Maelstrom", text: `We're in its pull, ${metres(e.dist)} from the eye (the eye sinks ships).` });
        break;
      case "reef":
        if (e.stage === "hit") pushFact({ key: "reef", priority: "high", head: "Aground", text: `We struck ${e.name || "a reef"}: ${e.dmg} hull.` });
        break;
      case "shoal": if (e.stage === "hit") pushFact({ key: "shoal", priority: "low", head: "Aground", text: "We hit a shoal." }); break;
      case "island": pushFact({ key: "island", priority: "low", head: "Scraped", text: "We scraped an island's rocks." }); break;
      case "ram": if (e.by !== "rexmaw") pushFact({ key: `rammed:${e.id}`, priority: "high", head: "Rammed", text: `${cap(nameOf(e.id))} rammed us for ${e.dmg}.` }); break;
      default: break;
    }
  }

  /** v4.2: power-ups, told to the companion as facts: one afloat near us (what it does, where), what we took, what wore off. */
  function powerupFact(e) {
    const P0 = P(), label = e.label || "A power-up";
    switch (e.stage) {
      case "spawn":
        if (dist(P0.x, P0.z, e.x, e.z) <= 450) pushFact({ key: `pw:${e.id}`, priority: "low", head: "Power-up", text: sim.pw.factFor(e) });
        break;
      case "pickup": {
        briefer.drop(`pw:${e.id}`);
        const g = e.gain || {}, bits = [];
        if (g.hull) bits.push(`+${g.hull} hull`);
        for (const [k, v] of Object.entries(g.ammo || {})) bits.push(`+${v} ${k}`);
        if (g.fires) bits.push(`${g.fires} fire${g.fires === 1 ? "" : "s"} out`);
        if (g.leaks) bits.push(`${g.leaks} leak${g.leaks === 1 ? "" : "s"} plugged`);
        if (g.water) bits.push("the bilge pumped dry");
        pushFact({ key: `pw:${e.kind}`, priority: "low", head: "Power-up aboard", text: `${label}: ${e.info || ""}${bits.length ? ` (${bits.join(", ")})` : ""}${e.dur ? `; ${Math.round(e.dur)} s on the clock` : ""}${e.charges ? `, ${e.charges} hot volley${e.charges === 1 ? "" : "s"} left` : ""}.` });
        break;
      }
      case "expire":
        if (e.buff) pushFact({ key: `pw:${e.kind}`, priority: "note", head: "Power-up", text: e.spent ? `${label} is spent: our shot is cold again.` : `${label} has worn off.` });
        else briefer.drop(`pw:${e.id}`);
        break;
      default: break;
    }
  }

  /** v4: a random sea event, told to the companion as facts (where, when, what it does). */
  function seaFact(e) {
    const ev = sim.sea?.byId(e.id) || { ...e, eta: e.eta ?? 0 };
    const key = `sea:${e.id}`, head = e.label || "Sea";
    switch (e.stage) {
      case "warn": pushFact({ key, priority: "high", head: `Lookout: ${head}`, text: sim.sea.factFor(ev, "warn") }); break;
      case "start": pushFact({ key, priority: "high", head, text: sim.sea.factFor(ev, "start") }); break;
      case "hit": pushFact({ key: `${key}:hit`, priority: "high", head, text: e.kind === "spout" ? "The waterspout caught us and spun us round." : `The arm slammed down on us${e.dmg ? ` for ${e.dmg}` : ""}.` }); break;
      case "salvaged": pushFact({ key, priority: "high", head: "Salvage aboard", text: `${e.gold} gold and some shot from the derelict.` }); break;
      case "defeated": pushFact({ key, priority: "high", head: "Arm off", text: `The Kraken arm sank back, beaten: +${e.gold} gold.` }); break;
      case "end": if (!e.salvaged && !e.defeated) pushFact({ key, priority: "low", head, text: e.kind === "treasure" && e.collected ? "We hauled in all the floating cargo." : `The ${head.toLowerCase()} has passed.` }); break;
      default: break;
    }
  }

  // ---- Wall-clock work (10 Hz) ------------------------------------------------------------------

  function tick() {
    if (sim && !paused && ACTIVE.has(phase)) {
      watch();
      const beat = briefer.update(rt, compose);
      if (beat) tell(beat.text, beat.silent, beat.priority);
      suggestionClock();
      spyClock();
      marksClock();
    }
    if (events.has("tick")) emit("tick", state());
  }

  /** Thresholds and windows the sim doesn't announce: hull, water, guns range, rams, hidden hazards ahead, fog, the Gloam's cloak. */
  function watch() {
    const s = sim.S, P0 = s.ship;
    for (const mark of [75, 50, 25]) if (P0.hull <= mark && V.hullMark > mark) pushFact({ key: "hull", priority: "high", head: "Hull", text: `Hull down to ${Math.round(P0.hull)}%.` });
    V.hullMark = P0.hull;
    for (const mark of [40, 70]) if (P0.water >= mark && V.waterMark < mark) pushFact({ key: "water", priority: "high", head: "Water", text: `Water at ${Math.round(P0.water)}% (${P0.leaks} leak${P0.leaks === 1 ? "" : "s"}; she sinks at 100).` });
    V.waterMark = P0.water;
    for (const c of sim.visibleContacts()) {
      if (c.fixed || c.state === "sinking" || c.state === "surrender") continue;
      const d = dist(P0.x, P0.z, c.x, c.z);
      if (d <= 330 && !V.inRange.has(c.id)) { V.inRange.add(c.id); pushFact({ key: `range:${c.id}`, priority: "high", head: "In gun range", text: contactLine(c, P0) }); }
      if (d > 450) V.inRange.delete(c.id);
      const rk = `ram:${c.id}`;
      if (c.state === "ram" && !c.lit && d < 200 && !c.cloaked && (V.told.get(rk) ?? -1e9) < rt - 20) {
        V.told.set(rk, rt);
        pushFact({ key: rk, priority: "critical", head: "Ramming run", text: `${cap(contactName(c))} is coming straight at us to ram, ${metres(d)} off.` });
      }
    }
    // The Gloam in her fog: the companion's lookout still follows her wake.
    for (const e of s.ships) {
      if (e.gone || e.state === "sinking") continue;
      const was = !!V.cloaked[e.id];
      if (e.cloaked && !was) pushFact({ key: `cloak:${e.id}`, priority: "high", head: "Gone into the fog", text: `${cap(contactName(e, { known: true }))} has vanished into her fog ${metres(dist(P0.x, P0.z, e.x, e.z))} ${compass8Abbr(headingOf(e.x - P0.x, e.z - P0.z))}. The Captain can't see her; the lookout follows her wake.` });
      if (e.cloaked && (V.told.get(`wake:${e.id}`) ?? -1e9) < rt - 6) {
        V.told.set(`wake:${e.id}`, rt);
        const brg = headingOf(e.x - P0.x, e.z - P0.z);
        pushFact({ key: `wake:${e.id}`, priority: "high", head: "Lookout", text: `Her wake: ${metres(dist(P0.x, P0.z, e.x, e.z))} ${compassAbbr(brg)} (${degText(brg)}), ${sideWord(relBearing(P0.x, P0.z, P0.heading, e.x, e.z))}, moving ${compass8Abbr(e.heading)}.` });
      }
      if (!e.cloaked && was && e.state === "ram") pushFact({ key: `ram:${e.id}`, priority: "critical", head: "Out of the fog", text: `${cap(contactName(e, { known: true }))} came out of the fog ${metres(dist(P0.x, P0.z, e.x, e.z))} ${sideWord(relBearing(P0.x, P0.z, P0.heading, e.x, e.z))}, on a ram course.` });
      V.cloaked[e.id] = !!e.cloaked;
      if (e.lantern && !e.spotted) {
        const k = `lantern:${e.id}`;
        if (e.alert > 0.25 && (V.told.get(k) ?? -1e9) < rt - 10) { V.told.set(k, rt); pushFact({ key: k, priority: "high", head: "Lantern", text: `${cap(contactName(e, { known: true }))}'s beam is on us (alert ${Math.round(e.alert * 100)}%).` }); }
      }
    }
    // Night and fog: the hidden hazards coming up ahead, from the companion's chart.
    if (s.night || s.fogHere > 0.3) {
      const near = hiddenHazards(sim, { range: 320 }).filter((x) => Math.abs(wrap180(x.brg - P0.heading)) <= 75 || x.d < 60);
      const hk = (x) => `hz:${x.h.kind === "reef" ? x.h.name : x.h.id}`;
      const fresh = near.filter((x) => (V.told.get(hk(x)) ?? -1e9) < rt - 40);
      if (fresh.length) {
        for (const x of near) V.told.set(hk(x), rt);
        pushFact({ key: "reefs", priority: near[0].d < REEFS.nearWarn ? "critical" : "high", head: "Your chart", text: `Ahead in the dark: ${near.slice(0, 4).map((x) => x.text).join("; ")}.` });
      }
    }
    const inFog = s.fogHere > 0.3;
    if (inFog !== V.fogIn) { V.fogIn = inFog; pushFact({ key: "fog", priority: "low", head: inFog ? "Fog" : "Out of the fog", text: inFog ? `We're in a fog bank: we see ${metres(s.visibility)}.` : `Clear of the fog: we see ${metres(s.visibility)}.` }); }
    const W = s.hazards.wave;
    if (W && V.wave !== W.id && W.eta <= 5) { V.wave = W.id; pushFact({ key: "wave", priority: "critical", head: "Rogue wave", text: `~${Math.max(1, Math.round(W.eta))} s. ${hazardText(sim)}.` }); }
    if (V.boardWhenReady && !V.boarding) {
      const e = sim.shipById(V.boardWhenReady.id);
      if (!e || rt > V.boardWhenReady.until) V.boardWhenReady = null;
      else if (!boardProblem(P0, e)) { V.boardWhenReady = null; startBoardingNow(e.id, "rexmaw"); }
    }
  }

  // ---- Crew modes, marks, contributions (v3) -----------------------------------------------------

  const crewModeText = (mode) => `${CREW_MODE_INFO[mode].label}: ${CREW_MODE_INFO[mode].line}`;

  /** Set the crew mode for the Captain ("captain") or the companion ("companion"). → the sim's {ok, prev} */
  function setCrewMode(mode, by) {
    if (!sim) return { ok: false };
    if (sim.S.crewMode.mode === mode) return { ok: false, same: true, prev: mode };
    return sim.setCrewMode(mode, by);
  }

  function doCrewMode(args, why, by) {
    const raw = args.mode ?? args.name ?? args.what;
    const mode = parseCrewMode(raw);
    if (!mode) refuse(`"${String(raw ?? "").slice(0, 30)}" isn't a crew mode. Modes: ${CREW_MODES.map((m) => `${m} (${CREW_MODE_INFO[m].line})`).join("; ")}`);
    if (sim.S.crewMode.mode === mode) refuse(`The crew are already on ${mode}. Other modes: ${CREW_MODES.filter((m) => m !== mode).join(", ")}.`);
    setCrewMode(mode, by);
    noteOrder("crew_mode", `crew to ${mode}`, why, { mode }, by);
    const st = crewModeState();
    return `Crew to ${CREW_MODE_INFO[mode].label}: ${CREW_MODE_INFO[mode].line}${mode === "attack" ? ` Now: ${st.doing}.` : ""} Your man_guns, repair and bail orders still override it.`;
  }

  /** What the crew mode is doing right now, in words, for the HUD: "Attack · port guns on Wasp". */
  function crewModeState() {
    const s = sim.S, cm = s.crewMode;
    const nameOf = (id) => (id === "kraken_eye" ? "the Kraken's eye" : sim.shipById(id)?.name || id);
    const bat = {};
    for (const side of ["port", "starboard", "bow"]) {
      const t = cm.targets?.[side] || null;
      bat[side] = { target: s.manned[side] ? s.manned[side].target : t, bears: !!t, override: !!s.manned[side] };
    }
    let doing = "Hold · reloading only", target = null;
    if (cm.mode === "attack") {
      const live = ["port", "starboard", "bow"].filter((sd) => cm.targets?.[sd]);
      if (live.length) { target = cm.targets[live[0]]; doing = `Attack · ${live.map((sd) => (sd === "bow" ? "bow chasers" : `${sd} guns`)).join(" + ")} on ${nameOf(target)}`; }
      else doing = `Attack · waiting for a target to bear${s.marked ? ` (${nameOf(s.marked)} marked)` : ""}`;
    } else if (cm.mode === "defend") {
      const rep = s.jobs.repair, bail = s.jobs.bail, P0 = s.ship;
      const bits = [];
      if (rep) bits.push(P0.fires > 0 && (rep.what === "all" || rep.what === "fires") ? "fighting fires" : P0.leaks > 0 && (rep.what === "all" || rep.what === "leaks") ? "patching leaks" : "patching the hull");
      if (bail) bits.push("pumping");
      doing = `Defend · ${bits.length ? bits.join(" + ") : "standing by to repair"}`;
    }
    return { mode: cm.mode, by: cm.by === "companion" ? companionName : cm.by, t: round1(cm.t), doing, target, targetName: target ? nameOf(target) : null, batteries: bat };
  }

  /** A companion's brace call that came ≤ 4 s before a hit: counted, and what the Captain's brace saved. */
  function braceCredit(e) {
    const c = V.braceCalls.find((b) => !b.counted && rt - b.t <= CONTRIB.braceS);
    if (!c) return;
    c.counted = true;
    const K = sim.S.contrib;
    K.bracesBeforeHits++;
    const mul = e.perfect ? 0.15 : e.braced ? 0.5 : 1;
    const saved = mul < 1 ? (e.dmg || 0) * (1 / mul - 1) : 0;
    K.damageSaved += saved;
    const n = Math.round(saved);
    emit("contrib", { kind: "brace", who: "companion", by: "companion", amount: n, text: n > 0 ? `Brace call · saved ${n}` : "Brace call · hit coming", x: round1(e.x), z: round1(e.z) });
    sim.moment("companion", "brace", `Called "Brace!" ${Math.max(0.1, round1(rt - c.t))} s before a hit${n > 0 ? ` (the brace saved ${n} hull)` : ""}`, n > 0 ? n * 3 : 6);
  }
  /** state.contrib / results.crew: the counters, rounded. */
  function contribOut() {
    const K = sim.S.contrib, G = K.guns;
    return { guns: { damage: Math.round(G.damage), volleys: G.volleys, hits: G.hits, sunk: G.sunk, by: Object.fromEntries(Object.entries(G.by).map(([k, v]) => [k, Math.round(v)])) },
      hullRepaired: Math.round(K.hullRepaired), waterBailed: Math.round(K.waterBailed), firesOut: K.firesOut, leaksPatched: K.leaksPatched,
      reefsCalled: K.reefsCalled, dangerMarks: K.dangerMarks, headingCalls: K.headingCalls, braceCalls: K.braceCalls, bracesBeforeHits: K.bracesBeforeHits,
      damageSaved: Math.round(K.damageSaved), armsCut: K.armsCut, best: K.best ? { ...K.best } : null };
  }
  function noteBraceCall(by) { if (by === "companion") { V.braceCalls.push({ t: rt, counted: false }); if (V.braceCalls.length > 12) V.braceCalls.shift(); sim.S.contrib.braceCalls++; } }

  /** The boarding picture: every beaten ship, nearest first, her ring, and whether one press of B works right now. */
  function boardableState() {
    const P0 = P(), out = [];
    for (const e of sim.S.ships) {
      if (e.gone || e.fixed) continue;
      const b = boardInfo(P0, e);
      if (!b.eligible) continue;
      out.push({ contactId: e.id, name: e.name, cls: e.cls, dist: Math.round(b.gap), inRing: b.inRing, inRange: !b.problem, speedDiff: round1(b.speedDiff),
        closing: round1(b.closing), why: b.why, problem: b.problem, ring: b.ring });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  // ---- The target lock (v4 §2) ----------------------------------------------------------------------

  /** Lock (or with null, clear) the target. by: captain | companion | suggestion | spyglass | auto. → true when it applies. */
  function setLock(id, by = "captain", { fact = true } = {}) {
    if (!sim) return false;
    const S0 = sim.S;
    if (id == null || id === "") {
      if (!S0.marked) return false;
      S0.marked = null; V.lockBy = null;
      emit("lock", { id: null, by }); emit("mark", { id: null, by });
      return true;
    }
    // v5: the Kraken's eye locks like a ship while it's up (the arcs snap to it).
    if (id === "kraken_eye") {
      if (S0.hazards.eye?.stage !== "up") return false;
      if (S0.marked === id) return true;
      S0.marked = id; V.lockBy = by;
      emit("lock", { id, by }); emit("mark", { id, by });
      return true;
    }
    const e = sim.shipById(id);
    if (!e || e.gone || e.state === "sinking" || e.down) return false;
    if (S0.marked === e.id) return true;
    S0.marked = e.id; V.lockBy = by;
    e.known = true;
    emit("lock", { id: e.id, by }); emit("mark", { id: e.id, by });
    if (fact && by !== "auto") {
      const P0 = P();
      pushFact({ key: "marked", priority: "high", head: by === "captain" ? "The Captain's target" : "Target locked",
        text: `${by === "captain" ? "The Captain locked" : "Locked"} ${contactName(e)} (${sideWord(relBearing(P0.x, P0.z, P0.heading, e.x, e.z))}, ${metres(dist(P0.x, P0.z, e.x, e.z))}). man_guns target "marked" and the attack crews lay on her.` });
    }
    return true;
  }

  /** Tab: the next ship out (dir +1) or in (−1) by distance, nearest first when nothing's locked. */
  function cycleLock(dir = 1, by = "captain") {
    const P0 = P();
    const E = sim.S.hazards.eye;
    const list = [...sim.visibleContacts().filter((e) => sim.alive(e) && dist(P0.x, P0.z, e.x, e.z) <= LOCK.cycleR), ...(E?.stage === "up" ? [E] : [])]
      .sort((a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z));
    if (!list.length) return false;
    const i = list.findIndex((e) => e.id === sim.S.marked);
    const step = Number(dir) < 0 ? -1 : 1;
    const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length;
    if (list[next].id === sim.S.marked) return false;
    return setLock(list[next].id, by);
  }

  /** state.lock. */
  function lockState() {
    const E = sim.S.marked === "kraken_eye" ? sim.S.hazards.eye : null;
    const e = E ? { id: E.id, name: "The Kraken's eye", cls: "kraken_eye", x: E.x, z: E.z } : sim.S.marked ? sim.shipById(sim.S.marked) : null;
    if (!e) return null;
    const P0 = P();
    const rel = relBearing(P0.x, P0.z, P0.heading, e.x, e.z);
    return { id: e.id, name: e.name, cls: e.cls, dist: Math.round(dist(P0.x, P0.z, e.x, e.z)), bearing: Math.round(headingOf(e.x - P0.x, e.z - P0.z)),
      rel: Math.round(rel), inCone: Math.abs(wrap180(rel - sim.S.look.yaw)) <= LOCK.cone, by: V.lockBy };
  }

  // ---- Suggestions, heading calls, danger marks -------------------------------------------------

  function openSuggestion({ kind, target = null, targetName: tn = null, pitch = "", by = companionName, course = null }) {
    if (V.suggestion) closeSuggestion("expired", { quiet: true });
    const id = `s${++V.sugN}`;
    const exp = offCall() ? SUGGEST.offcallExpireS : SUGGEST.expireS;
    V.suggestion = { id, kind, target, targetName: tn, pitch: String(pitch || "").slice(0, 160), by, t: rt, expires: rt + exp, course };
    emit("suggestion", { id, kind, stage: "open", target, targetName: tn, pitch: V.suggestion.pitch });
    emit("proposal", { id, kind, stage: "open", target, targetName: tn, pitch: V.suggestion.pitch });
    return V.suggestion;
  }

  function closeSuggestion(stage, { quiet = false, by = "captain" } = {}) {
    const p = V.suggestion;
    if (!p) return null;
    V.suggestion = null;
    emit("suggestion", { id: p.id, kind: p.kind, stage, target: p.target, by });
    emit("proposal", { id: p.id, kind: p.kind, stage, target: p.target, by });
    if (!quiet) {
      const what = `${p.kind}${p.targetName ? ` (${p.targetName})` : ""}`;
      pushFact({ key: "suggestion", priority: stage === "expired" ? "low" : "high", head: stage === "accepted" ? "Captain: aye" : stage === "declined" ? "Captain: no" : "No answer",
        text: stage === "accepted" ? `The Captain took your suggestion: ${what}.` : stage === "declined" ? `The Captain waved off your suggestion: ${what}.` : `Your suggestion (${what}) went unanswered.` });
    }
    return p;
  }

  function suggestionClock() { if (V.suggestion && rt >= V.suggestion.expires) closeSuggestion("expired"); }

  function acceptSuggestion(p) {
    switch (p.kind) {
      case "target": case "board": {
        const e = sim.shipById(p.target);
        if (e) { setLock(e.id, "suggestion", { fact: false }); V.course = { kind: "contact", id: e.id, label: p.targetName }; }
        if (p.kind === "board" && e) { if (!boardProblem(P(), e)) startBoardingNow(e.id, "rexmaw"); else V.boardWhenReady = { id: e.id, until: rt + 60 }; }
        break;
      }
      default: V.course = p.course; break;
    }
  }

  function marksClock() {
    if (V.headingCall && rt >= V.headingCall.until) V.headingCall = null;
    if (V.braceCall && rt - V.braceCall.t > 2.5) V.braceCall = null;
    const keep = [];
    for (const d of V.dangers) {
      if (rt >= d.until) emit("danger", { id: d.id, kind: d.kind, x: d.x, z: d.z, r: d.r, label: d.label, stage: "expire", by: d.by });
      else keep.push(d);
    }
    V.dangers = keep;
    // v5: the Kraken's eye is the target while it's up: locked once each surfacing (the Captain may still pick another), let go
    // when it dives.
    const eye = sim.S.hazards.eye;
    if (eye?.stage === "up" && V.eyeLockN !== eye.surfacings) { V.eyeLockN = eye.surfacings; setLock("kraken_eye", "auto"); }
    const mk = sim.S.marked === "kraken_eye" ? (eye?.stage === "up" ? eye : null) : sim.S.marked ? sim.shipById(sim.S.marked) : null;
    if (sim.S.marked && (!mk || mk.gone || mk.state === "sinking" || mk.down)) setLock(null, "auto");
    if (V.course?.kind === "contact") { const e = sim.shipById(V.course.id); if (!e || e.gone) V.course = null; }
    else if (V.course && dist(P().x, P().z, V.course.x, V.course.z) < 40) V.course = null;
  }

  // ---- Boarding -------------------------------------------------------------------------------------

  /**
   * One press of B (or the companion's `board`): the nearest beaten ship whose ring holds the Rexmaw, at once.
   * `id` narrows it to one ship. → {ok, id, reason}; a refusal also goes out as `board {stage: "refused"}`.
   */
  function tryBoard(id = null, by = "captain") {
    const P0 = P();
    const beaten = sim.S.ships.filter((e) => boardInfo(P0, e).eligible && (id == null || e.id === id));
    const byGap = (a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z);
    const ready = beaten.filter((e) => !boardProblem(P0, e)).sort(byGap);
    if (ready.length) return { ok: startBoardingNow(ready[0].id, "rexmaw", by), id: ready[0].id, reason: null };
    let reason, enemyId = null;
    const target = id != null ? sim.shipById(id) : null;
    if (target && !beaten.length) { reason = boardProblem(P0, target) || "she can't be boarded now"; enemyId = target.id; }
    else if (beaten.length) { const e = beaten.sort(byGap)[0]; reason = boardProblem(P0, e); enemyId = e.id; }
    else reason = `no beaten ship to board (hull ≤ 25%, masts ≤ ${BOARD.mastsMax}% or struck)`;
    emit("board", { stage: "refused", enemyId, reason, by });
    return { ok: false, id: enemyId, reason };
  }

  /** The grapples fly: the deck fight begins (phase "boarding"; the world crawls at BOARD.worldPace around it). */
  function startBoardingNow(id, initiator, by = "captain") {
    const e = sim.shipById(id);
    if (!e || V.boarding) return false;
    if (initiator === "rexmaw" && boardProblem(P(), e)) return false;
    if (V.suggestion?.kind === "board") closeSuggestion("accepted", { quiet: true });
    V.boardWhenReady = null;
    const P0 = P();
    const ours = crew.ids.filter((w) => !crew.named[w].overboard);
    const names = { me: companionName };
    if (companionSlot) names[companionSlot] = companionName;
    // Her captain: a whacky one about one boarding in three (seeded; never the same one twice in a row).
    const archetype = forcedArchetype || pickArchetype({ key: `${seedUsed}:${e.id}:${e.name}`, n: V.boardN || 0, last: V.lastBoarding?.arch ?? null,
      night: !!sim.S.night, gloam: missionId === "the_gloam", navy: !!(e.C || CLASSES[e.cls])?.navy });
    forcedArchetype = null;
    V.boardN = (V.boardN || 0) + 1;
    const F = createFight({ e, P: P0, ours, names, initiator, t: sim.S.t, archetype });
    sim.startBoardingLock(id);
    V.boarding = F;
    setPhase("boarding");
    emit("board", { stage: "start", enemyId: id, enemyName: e.name, initiator, by });
    emit("boardfight", { stage: "start", enemyId: id, enemyName: e.name, cls: e.cls, initiator, foes: F.foes.length, ours: F.ours.length, archetype: F.arch,
      captain: { present: F.captain.present, name: F.captain.name, archetype: F.arch } });
    bark(anyNamed(["rex"]), "board", 5);
    crew.record({ t: sim.S.t, kind: "event", by: "crew", text: `${initiator === "enemy" ? `${e.name} boarded us` : `We boarded ${e.name}`}`, why: "" });
    pushFact({ key: "boarding", priority: "high", head: "Boarding", text: `${fightLine(F)} The crew fight on their own; boarding_order sets their focus (captain, crew or defend).` });
    return true;
  }

  /** The fight's moments: relayed as `boardfight`, the big ones told to the companion as facts. */
  function fightEvent(fe) {
    const F = V.boarding;
    if (!F) return;
    emit("boardfight", { enemyId: F.enemyId, ...fe });
    const who = (id) => F.ours.find((o) => o.id === id)?.name || id;
    switch (fe.stage) {
      case "captain": pushFact({ key: "boarding:cap", priority: "high", head: "Their captain", text: F.arch !== "normal" ? ARCHETYPES[F.arch].brief
        : `${fe.name} is on deck (${fe.hp} hp). Take him down and she strikes.` }); break;
      case "down":
        if (fe.side === "ours") pushFact({ key: `boarding:down:${fe.id}`, priority: "high", head: "Down", text: `${who(fe.id)} is down, wounded. ${F.ours.filter((o) => o.state === "fighting").length} of ours still fighting.` });
        break;
      case "struck": pushFact({ key: "boarding", priority: "high", head: "She strikes", text: `${F.captain.name} is down and ${F.enemyName} strikes her colours.` }); break;
      case "repelled": pushFact({ key: "boarding", priority: "critical", head: "Thrown back", text: `All our fighters are down: ${F.enemyName}'s crew are cutting the grapples.` }); break;
      default: break;
    }
  }

  /** After the struck / repelled beat: the prize (or the losses), and back to sailing. */
  function finishBoarding(result) {
    const B = V.boarding;
    V.boarding = null;
    V.lastBoarding = B;
    sim.endBoardingLock();
    setPhase("sailing");
    const e = sim.shipById(B.enemyId);
    const wounded = B.ours.filter((o) => o.state === "down").map((o) => o.name);
    if (result === "struck") {
      // The monkeys' pickings come off her hold; a whacky captain's prize goes on top.
      if (e && B.stolen) e.loot = Math.max(0, e.loot - B.stolen);
      let loot = sim.capture(B.enemyId);
      if (B.prize?.gold) { sim.gainPlunder(B.prize.gold, "prize"); loot += B.prize.gold; }
      emit("board", { stage: "won", enemyId: B.enemyId, loot, ammo: { ...BOARD.winAmmo }, wounded, archetype: B.arch, prize: B.prize ? { ...B.prize } : undefined });
      if (B.focusBy === "companion" || B.rally.by === "companion") sim.moment("companion", "boarding", `Called the boarding party's focus that took ${B.enemyName}`, 40);
      bark("rex", "won", 3);
      crew.record({ t: sim.S.t, kind: "event", by: "crew", text: `Took ${B.enemyName}: ${loot} gold, shot and ${BOARD.winHands} new hands`, why: "" });
      pushFact({ key: "boarding", priority: "high", head: "She's ours", text: `We took ${B.enemyName} in ${Math.round(B.t)} s: ${loot} gold, ${Object.entries(BOARD.winAmmo).map(([k, v]) => `+${v} ${k}`).join(", ")}, +${BOARD.winHands} hands.${B.prize ? ` ${B.captain.name}'s prize: ${B.prize.item}.` : ""}${B.stolen ? ` Her monkeys made off with ${B.stolen} gold.` : ""}${wounded.length ? ` Wounded: ${wounded.join(", ")}.` : ""}` });
    } else {
      const extra = B.handsLost ?? BOARD.loseHands[0];
      sim.killHands(extra);
      if (e) sim.release(B.enemyId);
      emit("board", { stage: "lost", enemyId: B.enemyId, handsLost: extra, wounded });
      bark(anyNamed(["leo", "rex"]), "lost", 3);
      crew.record({ t: sim.S.t, kind: "event", by: "crew", text: `Beaten back from ${B.enemyName}: ${extra} hands lost`, why: "" });
      pushFact({ key: "boarding", priority: "high", head: "Boarding lost", text: `${B.enemyName} threw us back: ${extra} hands lost, everyone who went across is back aboard wounded. She's breaking away.` });
    }
  }

  // ---- The Captain's spyglass ----------------------------------------------------------------------

  function spyClock() {
    const sp = V.spy;
    if (!sp?.id || sim.S.marked === sp.id) return;
    if (rt - sp.since < SPYGLASS_MARK_S) return;
    const e = sim.shipById(sp.id);
    if (!e) return;
    if (!setLock(sp.id, "captain", { fact: false })) return;
    const P0 = P();
    pushFact({ key: "marked", priority: "high", head: "The Captain's eye", text: `The Captain is eyeing ${contactName(e)} (${sideWord(relBearing(P0.x, P0.z, P0.heading, e.x, e.z))}, ${metres(dist(P0.x, P0.z, e.x, e.z))}). man_guns target "marked" lays on her.` });
  }

  // ---- Endings -----------------------------------------------------------------------------------

  function arenaCheck() {
    const st = sim.S.stats;
    if (st.sunk.some((x) => x.id === "x1") || st.captured.some((x) => x.id === "x1")) { if (!V.boarding) end("success", "objective"); }
    else if (st.escaped.some((x) => x.id === "x1")) end("fail", "escaped");
    else if (sim.S.sunk) end("fail", "sunk");
  }

  function end(outcome, reason, failure = null) {
    if (V.ended || !sim) return;
    const s = sim.S;
    V.failure = outcome === "fail" ? failure || failureFor(reason) : null;
    if (V.boarding) { V.boarding = null; sim.endBoardingLock(); }
    if (cfg.free) {
      if (reason === "home" || reason === "retired" || s.ship.inHarbour) { if (s.plunder.hold > 0) sim.bank(); }
      else { V.lostPlunder = s.plunder.hold; s.plunder.hold = 0; }
      if (!s.sunk) outcome = s.plunder.banked > 0 ? "success" : outcome;
    }
    V.ended = { outcome, reason };
    if (V.suggestion) closeSuggestion("expired", { quiet: true });
    emit("cancel_force", { kind: "end" });
    results = buildResults(outcome, reason);
    emit("mission", { stage: outcome, id: missionId || "arena", reason });
    emit("end", { reason, outcome });
    for (const m of results.medalList) emit("medal", { id: m.id, tier: m.tier, label: m.label });
    tell(endText(), false, "high");
    setPhase("ending");
  }

  /** A failure without a row of its own (the duel, a retire): the reason in words and a tip. */
  function failureFor(reason) {
    const row = sim?.S.mission?.fails?.find((f) => f.reason === reason);
    if (row) return { id: row.id, text: row.failText, tip: row.tip };
    return { id: reason, text: { sunk: "The Rexmaw went down.", time: "Out of time.", escaped: "She got away." }[reason] || "The mission failed.",
      tip: reason === "escaped" ? "Chain shot from the bow chasers (look ahead) slows a runner." : "Brace (Space) when enemy gun ports glow; switch the crew to Defend (3)." };
  }

  function endText() {
    const r = results;
    const what = r.outcome === "success" ? `${r.label}: done.` : `${r.label}: ${r.failure?.text || "failed."}`;
    const md = r.medalList.length ? ` Medals: ${r.medalList.map((m) => `${m.tier} ${m.cat}`).join(", ")}.` : "";
    return `${what} ${r.loot} gold; ${r.sunk.length} sunk, ${r.captured.length} taken; hull ${r.hull}%.${md} Score ${r.score.total}.`;
  }

  function toResults() {
    setPhase("results");
    emit("results", { results });
  }

  function buildResults(outcome, reason) {
    const s = sim.S, st = s.stats;
    const success = outcome === "success";
    const loot = lootOf(sim, success);
    const medals = medalsFor(cfg, { elapsed: s.t, hull: Math.round(s.ship.hull), loot, success });
    const medalList = MEDAL_CATS.filter((c) => medals[c]).map((c) => ({ id: `${c}_${medals[c]}`, cat: c, tier: medals[c], label: `${cap(medals[c])} ${c === "time" ? "time" : c === "hull" ? "hull" : "loot"}` }));
    const sc = scoreOf({ outcome, loot, sunk: st.sunk.length, captured: st.captured.length, medals, hull: s.ship.hull, free: !!cfg.free });
    return {
      mission: missionId || "arena", label: cfg.label, time: cfg.time, tab: cfg.tab, free: !!cfg.free, outcome, reason, seed: seedUsed,
      elapsed: round1(s.t), realTime: round1(rt), hull: Math.round(s.ship.hull), loot, banked: s.plunder.banked, lostPlunder: V.lostPlunder,
      medals, medalList, objectives: s.mission.objectives.map((o) => ({ ...o })),
      failure: V.failure ? { ...V.failure } : null,
      steps: s.mission.steps.map((x) => ({ id: x.id, text: s.mission.objectives.find((o) => o.id === x.id)?.text || x.generic, done: !!x.done })),
      bonus: s.mission.bonus ? { id: s.mission.bonus.id, text: s.mission.bonus.text, done: !!s.mission.bonus.done, reward: s.mission.bonus.reward } : null,
      variant: world.variant ? { id: world.variant.id, label: world.variant.label } : null,
      crew: contribOut(), crewMode: s.crewMode.mode,
      sunk: st.sunk.slice(), captured: st.captured.slice(), escaped: st.escaped.slice(), score: sc,
      log: crew.log.slice(), orders: { ...V.orders }, track: s.track.slice(), stats: { ...st, sunk: undefined, captured: undefined, escaped: undefined },
    };
  }

  // ---- The companion -------------------------------------------------------------------------------

  const phaseProblem = () => {
    if (!sim || phase === "title") return "The mission hasn't started: we're not at sea yet.";
    if (phase === "results" || phase === "ending") return "The mission is over.";
    return null;
  };

  /** A contact by what the companion called her: a name, a class, an id, a direction, "nearest", "marked". */
  function resolveContact(v, { side = null } = {}) {
    const s = clean(v);
    const list = sim.visibleContacts().filter((e) => e.state !== "sinking" && !e.down);
    const P0 = P();
    const byDist = (a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z);
    const onSide = (e) => {
      if (!side || side === "mortar") return true;
      const rel = relBearing(P0.x, P0.z, P0.heading, e.x, e.z);
      return side === "bow" ? Math.abs(rel) < 70 : side === "port" ? rel < 0 : rel > 0;
    };
    if (!s || /\b(nearest|closest|her|it|that one|target)\b/.test(s) && !/\b(merchant|brig|frigate|gunboat|tower|fort)\b/.test(s)) {
      const hostile = list.filter((e) => e.state !== "surrender" && !e.derelict).sort(byDist);
      return hostile.find(onSide) || hostile[0] || null;
    }
    if (/\b(marked|eyed|captain|captains)\b/.test(s)) return sim.shipById(sim.S.marked) || null;
    const exact = list.find((e) => e.id === String(v));
    if (exact) return exact;
    const named = list.filter((e) => { const n = clean(e.name); return n && (s.includes(n) || (n.includes(s) && s.length >= 3)); });
    if (named.length) return named.sort(byDist)[0];
    const cw = compassIn(s);
    if (cw != null) {
      const near = list.map((e) => ({ e, off: Math.abs(wrap180(headingOf(e.x - P0.x, e.z - P0.z) - cw)) })).filter((c) => c.off <= 30).sort((a, b) => a.off - b.off || byDist(a.e, b.e));
      if (near.length) return near[0].e;
    }
    const rw = relIn(s);
    if (rw != null) {
      const near = list.map((e) => ({ e, off: Math.abs(wrap180(relBearing(P0.x, P0.z, P0.heading, e.x, e.z) - rw)) })).filter((c) => c.off <= 40).sort((a, b) => a.off - b.off || byDist(a.e, b.e));
      if (near.length) return near[0].e;
    }
    const words = { merchant: /\b(merchant|merchantman|trader|cargo|spice)\b/, gunboat: /\b(gunboat|gun boat|boat)\b/, brig: /\b(brig|chest)\b/, frigate: /\bfrigate\b/,
      fireship: /\b(fire ship|fireship)\b/, manowar: /\b(man o war|manowar|man of war|duke|iron duke)\b/, gloam: /\b(gloam|ghost)\b/, tower: /\b(tower|towers|fort)\b/ };
    for (const [cls, re] of Object.entries(words)) {
      if (!re.test(s)) continue;
      let of = list.filter((e) => e.cls === cls).sort(byDist);
      if (cls === "brig" && /\bchest\b/.test(s)) of = of.filter((e) => e.chest);
      if (of.length) return of.find(onSide) || of[0];
    }
    return null;
  }

  const contactOptions = () => {
    const P0 = P();
    const list = sim.visibleContacts().filter((e) => e.state !== "sinking");
    if (!list.length) return "no contacts in sight";
    return list.map((e) => `${e.known ? e.name : "a sail"} (${e.known ? (e.C?.label || e.cls) : "unknown"}, ${compass8Abbr(headingOf(e.x - P0.x, e.z - P0.z))} ${metres(dist(P0.x, P0.z, e.x, e.z))})`).join(", ")
      + (list.some((e) => !e.known) ? ` (name a sail by its direction, e.g. "the sail NE")` : "");
  };

  function noteOrder(kind, text, why, payload, by = "companion") {
    if (by === "companion") V.orders.companion++; else V.orders.captain++;
    V.lastOrder = { by: by === "companion" ? companionName : by, kind, text, why, t: rt };
    emit("order", { kind, by, why, payload, text });
  }

  /** "Since your last call: hull 80→72%, water 10→18%, +1 fire." */
  function deltaLine() {
    const P0 = P(), s = sim.S;
    const now = { hull: Math.round(P0.hull), water: Math.round(P0.water), fires: P0.fires, leaks: P0.leaks, loot: s.plunder.loot, hands: P0.crewHands, t: rt };
    const d = V.delta;
    V.delta = now;
    if (!d) return "";
    const bits = [];
    if (now.hull !== d.hull) bits.push(`hull ${d.hull}→${now.hull}%`);
    if (Math.abs(now.water - d.water) >= 3) bits.push(`water ${d.water}→${now.water}%`);
    if (now.fires !== d.fires) bits.push(`fires ${d.fires}→${now.fires}`);
    if (now.leaks !== d.leaks) bits.push(`leaks ${d.leaks}→${now.leaks}`);
    if (now.hands !== d.hands) bits.push(`hands ${d.hands}→${now.hands}`);
    if (now.loot !== d.loot) bits.push(`gold ${d.loot}→${now.loot}`);
    return bits.length ? ` Since your last call (${Math.round(rt - d.t)} s): ${bits.join(", ")}.` : "";
  }

  function flushing(fn) {
    try { return fn(); } finally { if (sim && phase !== "title") for (const e of sim.drain()) { if (phase === "ending" || phase === "results") relay(e); else handle(e); } }
  }

  function companion(action, data = {}) {
    let args = data && typeof data === "object" ? data : {};
    const why = whyOf(args);
    // v3's boarding_move, kept as an alias of boarding_order: charge → captain, volley → crew, brace/defend → defend.
    if (action === "boarding_move") {
      const mv = parseMove(args.move ?? args.name ?? args.action);
      args = { focus: mv === "charge" || mv === "rally" ? "captain" : mv === "volley" ? "crew" : mv ? "defend" : args.move, why: args.why };
      action = "boarding_order";
    }
    if (!ACTION_NAMES.includes(action)) refuse(`Rexmaw Raids' tools are: ${ACTION_NAMES.join(", ")} (not "${String(action).slice(0, 30)}").`);
    if (action === "look_around") {
      const p = phaseProblem();
      if (p && phase !== "ending") refuse(p);
      const b = fullBrief(sim, { captain: V.captain, rt, suggestion: V.suggestion, targetName });
      const fight = V.boarding ? `\n**Boarding:** ${fightLine(V.boarding)}` : "";
      return phase === "briefing" ? `${briefing()}\n${b}` : `${b}${fight}`;
    }
    if (action === "boarding_order") {
      if (!V?.boarding) refuse("We're not boarding anyone right now. Board a beaten ship first (board, or the Captain's B inside her ring).");
      const focus = parseFocus(args.focus ?? args.order ?? args.what ?? args.mode);
      if (!focus) refuse(`"${String(args.focus ?? "").slice(0, 30)}" isn't a boarding order. Focus: captain (go for her captain), crew (fight her crew man to man), defend (hold our rail, take less, deal less).`);
      const r = setFocus(V.boarding, focus, "companion");
      if (!r.ok) refuse(`${cap(r.reason)}.`);
      for (const fe of r.events) fightEvent(fe);
      V.orders.companion++;
      V.lastOrder = { by: companionName, kind: "boarding_order", text: `boarding party: ${focus}`, why, t: rt };
      const F = V.boarding;
      return `Boarding party: ${focus === "captain" ? `up to three go for ${F.captain.present ? F.captain.name : "her captain when he shows"}` : focus === "crew" ? "man to man with her crew" : "hold our rail, take less, deal less"}. ${fightLine(F)}`;
    }
    const p = phaseProblem();
    if (p) refuse(p);
    const out = runTool(action, args, why, "companion");
    return `${out}${deltaLine()}`;
  }

  function runTool(action, args, why, by) {
    switch (action) {
      case "man_guns": return doManGuns(args, why, by);
      case "repair": return doRepair(args, why, by);
      case "bail": return doBail(args, why, by);
      case "spyglass": return doSpyglass(args);
      case "call_heading": return doHeading(args, why, by);
      case "mark_danger": return doDanger(args, why, by);
      case "brace_call": return doBraceCall(why, by);
      case "suggest": return doSuggest(args, why, by);
      case "crew_moment": return doMoment(args);
      case "crew_mode": return doCrewMode(args, why, by);
      case "board": return doBoard(args, why, by);
      default: return refuse(`Rexmaw Raids' tools are: ${ACTION_NAMES.join(", ")}.`);
    }
  }

  /** The companion's `board`: grapple the named (or nearest) beaten ship whose ring we're in. */
  function doBoard(args, why, by) {
    if (V.boarding) refuse(`We're already boarding ${V.boarding.enemyName}: boarding_order sets the party's focus.`);
    if (phase !== "sailing") refuse("Not now: we're not under way.");
    const raw = args.target ?? args.contact ?? args.ship ?? "";
    let id = null;
    if (String(raw).trim() && !/\b(nearest|closest|her|it|that one|target)\b/.test(clean(raw))) {
      const P0 = P();
      const s = clean(raw);
      const pool = sim.S.ships.filter((e) => !e.gone && !e.fixed && e.state !== "sinking");
      const e = pool.find((x) => x.id === String(raw)) || pool.find((x) => { const n = clean(x.name); return n && (s.includes(n) || (n.includes(s) && s.length >= 3)); })
        || (/\b(marked|locked)\b/.test(s) ? sim.shipById(sim.S.marked) : null)
        || pool.filter((x) => s.includes(x.cls)).sort((a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z))[0];
      if (!e) refuse(`I can't see "${String(raw).slice(0, 40)}". Beaten ships: ${boardableState().map((b) => `${b.name} (${b.dist} m${b.inRange ? ", in reach" : ""})`).join(", ") || "none"}.`);
      id = e.id;
    }
    const r = tryBoard(id, by);
    if (!r.ok) refuse(`Can't board: ${r.reason}.`);
    noteOrder("board", `board ${V.boarding?.enemyName || r.id}`, why, { id: r.id }, by);
    return `Grapples away: we're boarding ${V.boarding.enemyName}. ${fightLine(V.boarding)} boarding_order sets their focus.`;
  }

  function doManGuns(args, why, by) {
    const rawSide = args.side ?? args.battery ?? args.guns ?? args.where;
    const sides = parseSide(rawSide);
    if (!sides) refuse(`"${String(rawSide ?? "").slice(0, 30)}" isn't a battery. Sides: port, starboard, bow (chasers), mortar.`);
    const mode = args.mode != null && args.mode !== "" ? parseManMode(args.mode) : "keep_firing";
    if (!mode) refuse(`"${String(args.mode).slice(0, 30)}" isn't a firing order. Modes: ${ORDER_MODES.join(", ")}.`);
    const P0 = P();
    let ammo = null;
    if (args.ammo != null && args.ammo !== "") {
      ammo = parseAmmo(args.ammo);
      if (!ammo) refuse(`"${String(args.ammo).slice(0, 30)}" isn't a shot. Ammo: round (∞), heavy (∞, broadsides, ${WEAPONS.heavy.range} m), chain (${Math.floor(P0.ammo.chain)} left, bow chasers).`);
    }
    let who = null;
    if (args.who != null && args.who !== "") { who = parseWho(args.who); if (!who) refuse(`"${String(args.who).slice(0, 30)}" isn't aboard. Gun captains: rex, eve, ara, sal, leo, me.`); }
    const rawT = String(args.target ?? args.contact ?? "nearest");
    const kraken = /\b(kraken|arms?|tentacles?)\b/.test(clean(rawT));
    const K = sim.S.hazards.kraken;
    if (kraken && !(K && K.stage === "grab")) refuse(`There's no Kraken on us. Targets: ${contactOptions()}.`);
    const lines = [];
    for (const side of sides) {
      if (ammo === "chain" && side !== "bow") refuse(`Chain shot is for the bow chasers (side "bow"); the broadsides fire round or heavy.`);
      if (ammo === "heavy" && (side === "bow" || side === "mortar")) refuse(`Heavy shot is for the broadsides (port, starboard), at ${WEAPONS.heavy.range} m or less.`);
      if (ammo === "chain" && P0.ammo.chain < 1) refuse(`We're out of chain shot. Left: chain 0, mortar ${Math.floor(P0.ammo.mortar)}, barrels ${Math.floor(P0.ammo.barrels)}; round and heavy are unlimited.`);
      if (side === "mortar" && P0.ammo.mortar < 1) refuse(`We're out of mortar shells. Left: chain ${Math.floor(P0.ammo.chain)}, barrels ${Math.floor(P0.ammo.barrels)}; round and heavy are unlimited.`);
      if (side !== "mortar" && side !== "bow" && P0.guns[side].live <= 0) refuse(`No guns left on the ${side} side. Batteries: ${["port", "starboard", "bow"].filter((s) => P0.guns[s].live > 0).join(", ")}, mortar.`);
      let tgt = null;
      if (!kraken) {
        tgt = resolveContact(rawT, { side });
        if (!tgt) refuse(`I can't see "${rawT.slice(0, 40)}". Targets: nearest, marked, or a contact: ${contactOptions()}${K?.stage === "grab" ? ", or the kraken" : ""}.`);
        if (tgt.state === "surrender") refuse(`${cap(contactName(tgt))} has struck her colours: board her instead. Other targets: ${contactOptions()}.`);
      }
      const r = sim.manGuns(side, { target: kraken ? "kraken" : tgt.id, mode, ammo: side === "mortar" ? null : ammo, who, by, why });
      if (!r.ok) refuse(`${cap(r.text)}. Gun captains: rex, eve, ara, sal, leo${companionSlot ? "" : ", me"}.`);
      const gunner = r.who[0];
      if (gunner) bark(gunner, ammo ? `ack_${ammo === "heavy" ? "heavy" : ammo}` : "ack_station", 3, { station: stationOfSide(side) });
      let note = "";
      if (tgt) {
        const d = dist(P0.x, P0.z, tgt.x, tgt.z);
        const now = side === "mortar" ? batteryBears(P0, "mortar", tgt) : batteryBears(P0, side, tgt, side === "bow" ? "chain" : "broadside");
        note = ` She's ${metres(d)} ${sideWord(relBearing(P0.x, P0.z, P0.heading, tgt.x, tgt.z))}${now ? " and bears now" : `; she doesn't bear on the ${side === "mortar" ? "mortar (150–600 m)" : `${side} guns`} yet`}.`;
      }
      lines.push(`${cap(r.text)}, ${kraken ? "hacking at the Kraken's arms" : `laid on ${contactName(tgt, { known: true })}`} (${MODE_WORDS[mode]}${ammo ? `, ${ammo} shot` : ""}).${note}`);
      noteOrder("man_guns", `${side} guns on ${kraken ? "the Kraken" : tgt.name} (${mode.replace(/_/g, " ")})`, why, { side, target: kraken ? "kraken" : tgt.id, mode, ammo, who: r.who[0] || null }, by);
    }
    const repair = crew.jobOf("repair") || crew.jobOf("bail");
    return `Aye: ${lines.join(" ")}${mode === "hold" ? " Say \"Fire!\" when you want them." : ""}${repair ? " (Hands are off the guns for repairs: reloads are slower.)" : ""}`;
  }

  function doRepair(args, why, by) {
    const what = parseRepairWhat(args.what ?? args.target ?? args.part);
    if (!what) refuse(`"${String(args.what).slice(0, 30)}" isn't something the carpenters fix. Repair: ${REPAIR_WHAT.join(", ")}.`);
    const P0 = P();
    const need = { hull: P0.hull < P0.hullMax - 1, masts: P0.masts < 99, leaks: P0.leaks > 0, fires: P0.fires > 0 };
    need.all = need.hull || need.masts || need.leaks || need.fires;
    const state = `hull ${Math.round(P0.hull)}%, masts ${Math.round(P0.masts)}%, ${P0.leaks} leak${P0.leaks === 1 ? "" : "s"}, ${P0.fires} fire${P0.fires === 1 ? "" : "s"}`;
    if (!need[what]) refuse(`Nothing to repair there (${state}). Repair: ${Object.keys(need).filter((k) => need[k]).join(", ") || "nothing needs it"}.`);
    if (sim.S.jobs.repair?.what === what) refuse(`The carpenters are already on it (${what}: ${Math.round((sim.jobProgress("repair") ?? 0) * 100)}% done). Other orders: bail, man_guns.`);
    if (sim.S.jobs.repair) sim.endJob("repair", "stopped");
    const r = sim.startRepair(what, { by, why });
    if (!r.ok) refuse(r.text);
    noteOrder("repair", `repair: ${what}`, why, { what }, by);
    bark(r.who[0], "ack_station", 3, { station: "damage" });
    const est = what === "hull" || what === "all" ? ` (+${Math.min(30, Math.round(P0.hullMax - P0.hull))} hull)` : "";
    return `Aye: ${r.text}, on the ${what}${est}. Reloads are slower while they work (8 hands off the guns).`;
  }

  function doBail(args, why, by) {
    const P0 = P();
    if (P0.water < 2) refuse(`She's dry (water ${Math.round(P0.water)}%, ${P0.leaks} leak${P0.leaks === 1 ? "" : "s"}). Other orders: repair, man_guns.`);
    if (sim.S.jobs.bail) refuse(`The pumps are already going (water ${Math.round(P0.water)}%).`);
    const r = sim.startBail({ by, why });
    if (!r.ok) refuse(r.text);
    noteOrder("bail", "bail", why, {}, by);
    bark(r.who[0], "ack_station", 3, { station: "pumps" });
    return `Aye: ${r.text}. Water ${Math.round(P0.water)}%${P0.leaks ? `, still ${P0.leaks} leak${P0.leaks === 1 ? "" : "s"} letting it in (repair leaks to stop it)` : ""}. Reloads slower while they pump (4 hands off the guns).`;
  }

  function doSpyglass(args) {
    const raw = args.contact ?? args.target ?? args.name ?? "";
    const e = resolveContact(raw);
    if (!e) refuse(`Can't find "${String(raw).slice(0, 40)}" in the glass. In sight: ${contactOptions()}.`);
    const P0 = P();
    e.known = true;
    emit("spyglass", { id: e.id, by: "companion" });
    const d = dist(P0.x, P0.z, e.x, e.z);
    if (e.fixed) return `${cap(contactName(e))}, ${metres(d)} ${compass8Abbr(headingOf(e.x - P0.x, e.z - P0.z))}: walls ${Math.round((e.hull / e.hullMax) * 100)}%, ${e.batteries.port.guns} guns, range 380 m. Round shot barely marks it; heavy shot (inside 90 m) and mortars break it.`;
    const C = e.C;
    const flag = e.state === "surrender" ? "a white flag" : e.cls === "gloam" ? "no flag at all" : C.navy ? "navy colours" : "merchant colours";
    const brg = headingOf(e.x - P0.x, e.z - P0.z);
    const guns = C.guns ? `${e.batteries.port.guns}/${C.guns} guns port, ${e.batteries.starboard.guns}/${C.guns} starboard` : C.bow ? `${C.bow} bow guns` : "no guns";
    const bits = [
      `${contactName(e, { known: true })} under ${flag}, ${sideWord(relBearing(P0.x, P0.z, P0.heading, e.x, e.z))} (${compass8Abbr(brg)}), ${metres(d)}`,
      `hull ${Math.round((e.hull / e.hullMax) * 100)}% (of ${e.hullMax}), masts ${Math.round(e.masts)}%`, guns, `~${Math.round(e.crew)} crew`,
      C.loot[1] ? `cargo worth ~${e.loot} gold${e.chest ? " (the paymaster's chest)" : ""}` : "no cargo worth taking",
      `heading ${compass8Abbr(e.heading)} at ${e.speed.toFixed(0)} m/s (top ${C.speed})`, `she looks to be ${intentWords(e)}`,
    ];
    if (e.weakPoints.length) {
      const sides = [...new Set(e.weakPoints.map((w) => (w.local.x > 0 ? "port" : "starboard")))];
      bits.push(`${e.weakPoints.length} weak point${e.weakPoints.length === 1 ? "" : "s"} glowing on her ${sides.join(" and ")} side (the Captain's swivel, inside 120 m)`);
    } else bits.push(`no weak points showing yet (they open up after ${3} hits)`);
    if (!C.boardable) bits.push(`a ${C.label} can't be boarded`);
    if (e.cls === "manowar") bits.push(`phase ${e.phase}: ${e.phase === 1 ? "broadsides" : e.phase === 2 ? "broadsides and mortars" : "broadsides, mortars and ram runs"}`);
    if (e.cls === "gloam") bits.push(e.cycle ? `she's ${e.cycle.stage === "fight" ? "fighting in the open" : e.cycle.stage === "cloak" ? "hidden in her fog" : "on a ram run"}` : "");
    if (e.lantern) bits.push(e.spotted ? "she has seen us" : "her lantern is sweeping");
    return `${cap(bits.filter(Boolean).join("; "))}.`;
  }

  /** A place in words → {x, z, label, kind}. */
  function placeTarget(v) {
    const s = clean(v);
    if (!s) return null;
    for (const [id, re] of POI_WORDS) {
      if (!re.test(s)) continue;
      if (id === "port") return { x: world.port.x, z: world.port.z, label: "home port", kind: "port" };
      if (id === "cove" && world.cove) return { x: world.cove.x, z: world.cove.z, label: "the cove", kind: "cove" };
      if (id === "maelstrom" && world.maelstrom) return { x: world.maelstrom.x, z: world.maelstrom.z, label: "the maelstrom", kind: "maelstrom" };
      if (id === "storm" && sim.S.storm) return { x: sim.S.storm.x, z: sim.S.storm.z, label: "the storm cell", kind: "storm" };
      if (id === "fort" && world.fort) return { x: world.fort.x, z: world.fort.z, label: "the fort", kind: "fort" };
      if (id === "exit" && world.exit) return { x: world.exit.x, z: world.exit.z, label: missionId === "krakens_wake" ? "the harbour mouth" : "the far cape", kind: "exit" };
      const poi = world.pois.find((q) => q.kind === id);
      if (poi) return { x: poi.x, z: poi.z, label: poi.label, kind: id };
    }
    if (/\bwreck/.test(s)) {
      const P0 = P();
      const w = world.wrecks.filter((x) => !sim.S.salvaged.has(x.id)).sort((a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z))[0];
      if (w) return { x: w.x, z: w.z, label: "the wreck", kind: "wreck", id: w.id };
    }
    return null;
  }

  function doHeading(args, why, by) {
    const raw = args.heading ?? args.course ?? args.direction ?? args.to;
    const P0 = P();
    let deg = parseHeading(raw);
    let label = null;
    if (deg == null) { const rel = relIn(raw); if (rel != null) deg = wrap360(P0.heading + rel); }
    if (deg == null) { const pl = placeTarget(raw); if (pl) { deg = headingOf(pl.x - P0.x, pl.z - P0.z); label = pl.label; } }
    if (deg == null) refuse(`"${String(raw ?? "").slice(0, 30)}" isn't a heading. Give a compass word (N, NE, east-north-east), degrees (000–359), or a place (cove, home, wreck${world.exit ? ", exit" : ""}).`);
    const reason = String(args.reason ?? why ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    V.headingCall = { deg: Math.round(deg), word: compassWord(deg), reason, by: by === "companion" ? companionName : by, t: rt, until: rt + HEADING_CALL_S };
    emit("heading_call", { deg: Math.round(deg), word: compassWord(deg), reason, by: V.headingCall.by });
    noteOrder("heading", `heading ${compassAbbr(deg)} (${degText(deg)})${label ? ` for ${label}` : ""}`, why || reason, { deg: Math.round(deg) }, by);
    if (by === "companion") {
      const n = ++sim.S.contrib.headingCalls;
      if (sim.S.night || sim.S.fogHere > 0.3) sim.moment("companion", "heading", `Called ${n} heading${n === 1 ? "" : "s"} through the ${sim.S.night ? "dark" : "fog"}`, Math.min(n * 2, 30));
    }
    const off = Math.round(wrap180(deg - P0.heading));
    return `On the Captain's compass: ${compassWord(deg)} (${degText(deg)})${label ? `, for ${label}` : ""}. We're heading ${compassAbbr(P0.heading)} (${degText(P0.heading)}) now: ${Math.abs(off) < 5 ? "right on it" : `${Math.abs(off)}° to ${off > 0 ? "starboard" : "port"}`}.`;
  }

  function doDanger(args, why, by) {
    const P0 = P();
    const raw = args.where ?? args.at ?? args.place ?? args.area ?? "";
    let kind = args.kind != null && args.kind !== "" ? parseDangerKind(args.kind) : null;
    if (args.kind != null && args.kind !== "" && !kind) refuse(`"${String(args.kind).slice(0, 30)}" isn't a danger. Kinds: ${DANGER_KINDS.join(", ")}.`);
    let x = null, z = null, r = null, label = null;
    // A hazard by its name on the chart, a patrol by her name, a known place.
    const s = clean(raw);
    const hz = s ? hazardsOf(world).filter((h) => { const n = clean(h.name).replace(/^the /, ""); return n.length >= 3 && s.includes(n); }) : [];
    if (hz.length) {
      const best = hz.map((h) => ({ h, d: segDist(P0.x, P0.z, h.a.x, h.a.z, h.b.x, h.b.z) })).sort((a, b) => a.d.d - b.d.d)[0];
      const h = best.h;
      x = (h.a.x + h.b.x) / 2; z = (h.a.z + h.b.z) / 2; r = h.r + 10; label = h.name;
      if (hz.length > 1 && h.kind === "reef") { x = best.d.x; z = best.d.z; r = Math.max(60, h.w + 50); }
      kind = kind || (h.kind === "shoal" ? "shoal" : h.kind);
    }
    if (x == null && s) {
      const e = /\b(patrol|lantern|gunboat|brig|frigate)\b/.test(s) || (kind === "patrol") ? resolveContact(raw) : null;
      if (e) { x = e.x; z = e.z; r = 90; label = contactName(e, { known: true }); kind = kind || "patrol"; }
    }
    if (x == null && s && /\b(maelstrom|whirlpool)\b/.test(s) && world.maelstrom) { x = world.maelstrom.x; z = world.maelstrom.z; r = world.maelstrom.r; label = "the maelstrom"; kind = kind || "whirlpool"; }
    if (x == null) {
      const w = parseWhere(raw);
      if (w.bearing == null && w.rel == null) refuse(`Where? Give a bearing and distance ("045 220 m", "NE 200 m", "starboard bow 150 m") or a name from your chart${hiddenHazards(sim, { range: 900, all: true }).length ? ` (${hiddenHazards(sim, { range: 900, all: true }).slice(0, 4).map((q) => q.h.name).join(", ")})` : ""}.`);
      if (w.distance == null) refuse(`How far? Give the distance too ("${w.bearing != null ? degText(w.bearing) : "starboard bow"} 200 m").`);
      const brg = w.bearing != null ? w.bearing : wrap360(P0.heading + w.rel);
      const f = forward(brg);
      x = P0.x + f.x * w.distance; z = P0.z + f.z * w.distance;
      label = `${compassAbbr(brg)} ${metres(w.distance)}`;
    }
    kind = kind || "reef";
    if (args.radius != null && args.radius !== "") { const rr = parseDistance(args.radius) ?? Number(args.radius); if (Number.isFinite(rr)) r = rr; }
    r = clamp(Math.round(r ?? DANGER.r), DANGER.minR, DANGER.maxR);
    const d = { id: `dz${++V.dangerN}`, kind, x: round1(x), z: round1(z), r, label, by: by === "companion" ? companionName : by, t: rt, until: rt + DANGER.life };
    V.dangers.push(d);
    while (V.dangers.length > 8) { const old = V.dangers.shift(); emit("danger", { id: old.id, kind: old.kind, x: old.x, z: old.z, r: old.r, label: old.label, stage: "expire", by: old.by }); }
    emit("danger", { id: d.id, kind, x: d.x, z: d.z, r, label, stage: "mark", by: d.by });
    noteOrder("danger", `${kind} marked: ${label}`, why, { id: d.id, kind, x: d.x, z: d.z, r }, by);
    if (by === "companion") {
      const K = sim.S.contrib;
      K.dangerMarks++;
      if (["reef", "rocks", "shoal"].includes(kind)) {
        K.reefsCalled++;
        emit("contrib", { kind: "reef", who: "companion", by: "companion", amount: 1, text: `${cap(kind)} marked · ${label}`, x: d.x, z: d.z });
        sim.moment("companion", "reef", `Marked ${label} on the chart${sim.S.night || sim.S.fogHere > 0.3 ? " in the dark" : ""}`, sim.S.night || sim.S.fogHere > 0.3 ? 14 : 6);
      }
    }
    const brg = headingOf(d.x - P0.x, d.z - P0.z);
    return `Marked on the Captain's chart for ${DANGER.life} s: ${kind} — ${label}, ${metres(Math.max(0, dist(P0.x, P0.z, d.x, d.z) - r))} ${compassAbbr(brg)} (${degText(brg)}), ${r} m across the ring.`;
  }

  function doBraceCall(why, by) {
    V.braceCall = { by: by === "companion" ? companionName : by, t: rt };
    emit("brace_call", { by: V.braceCall.by, why });
    noteBraceCall(by);
    if (by === "companion") V.orders.companion++;
    return "BRACE is flashing on the Captain's screen.";
  }

  function doSuggest(args, why, by) {
    const kind = parseSuggestKind(args.kind ?? args.type ?? args.what);
    if (!kind) refuse(`"${String(args.kind ?? "").slice(0, 30)}" isn't a suggestion. Kinds: ${SUGGEST_KINDS.join(", ")}.`);
    if (by === "companion") {
      const since = rt - V.lastSuggestT;
      const prompted = V.captain && V.captain.t >= V.lastSuggestT;
      if (since < SUGGEST.unpromptedGap && !prompted) refuse(`You made a suggestion ${Math.round(since)} s ago and the Captain hasn't spoken since: wait for them, or ${Math.round(SUGGEST.unpromptedGap - since)} s. Meanwhile: man_guns, repair, bail, call_heading, mark_danger.`);
    }
    const pitch = String(args.pitch ?? args.text ?? why ?? "").slice(0, 160);
    const P0 = P();
    let tgt = null, tn = null, course = null;
    switch (kind) {
      case "target": case "board": {
        const e = resolveContact(args.target ?? "nearest");
        if (!e) refuse(`Which ship? In sight: ${contactOptions()}.`);
        if (kind === "board") {
          const pr = boardProblem(P0, e);
          if (pr && !/her ring|ramming speed/.test(pr)) refuse(`Can't board ${contactName(e)}: ${pr}.`);
        }
        tgt = e.id; tn = contactName(e, { known: true });
        break;
      }
      case "loot": {
        const s = clean(args.target ?? "");
        const pl = /\bwreck/.test(s) ? placeTarget("wreck") : null;
        if (pl) { course = pl; tn = pl.label; break; }
        // v4.2: a power-up ("power-up", or its name), or the nearest one when there's no loot afloat.
        const pu = sim.pw?.nearest(s);
        if (pu && (/power|swift|quick|hot shot|iron|patch|keg|doubloon|ink|mermaid|kiss/.test(s) || !sim.S.pickups.length)) {
          course = { x: round1(pu.x), z: round1(pu.z), label: `${pu.label} ${compassAbbr(headingOf(pu.x - P0.x, pu.z - P0.z))} ${metres(dist(P0.x, P0.z, pu.x, pu.z))}`, kind: "loot", id: pu.id };
          tn = course.label;
          break;
        }
        const kindWant = PICKUP_KINDS.find((k) => s.includes(k));
        const list = sim.S.pickups.filter((q) => (!kindWant || q.kind === kindWant || (kindWant === "flotsam" && q.flotsam))).sort((a, b) => dist(P0.x, P0.z, a.x, a.z) - dist(P0.x, P0.z, b.x, b.z));
        const q = list[0];
        if (!q) refuse(`No ${kindWant || "loot"} afloat that I can see. Other suggestions: target, route, flee, board.`);
        course = { x: round1(q.x), z: round1(q.z), label: `${q.kind} ${compassAbbr(headingOf(q.x - P0.x, q.z - P0.z))} ${metres(dist(P0.x, P0.z, q.x, q.z))}`, kind: "loot", id: q.id };
        tn = course.label;
        break;
      }
      case "route": {
        const raw = args.target ?? args.heading ?? "";
        const pl = placeTarget(raw);
        if (pl) { course = pl; tn = pl.label; break; }
        const h = parseHeading(raw);
        if (h == null) refuse(`Route where? A place (cove, home, wreck${world.exit ? ", exit" : ""}, fort) or a heading (NE, 045).`);
        const f = forward(h);
        course = { x: round1(P0.x + f.x * 400), z: round1(P0.z + f.z * 400), label: `${compassWord(h)} (${degText(h)})`, kind: "route" };
        tn = course.label;
        break;
      }
      case "flee": {
        const threats = sim.visibleContacts().filter((e) => !e.fixed && e.hostile && e.state !== "sinking" && e.state !== "surrender");
        let x = world.port.x, z = world.port.z, label = "home port";
        if (threats.length) {
          const cx = threats.reduce((a, e) => a + e.x, 0) / threats.length, cz = threats.reduce((a, e) => a + e.z, 0) / threats.length;
          const h = headingOf(P0.x - cx, P0.z - cz), f = forward(h);
          x = P0.x + f.x * 450; z = P0.z + f.z * 450; label = `away ${compassWord(h)}`;
        }
        course = { x: round1(x), z: round1(z), label, kind: "flee" };
        tn = label;
        break;
      }
      default: break;
    }
    openSuggestion({ kind, target: tgt, targetName: tn, pitch, course, by: by === "companion" ? companionName : by });
    if (by === "companion") { V.lastSuggestT = rt; V.orders.companion++; }
    V.lastOrder = { by: by === "companion" ? companionName : by, kind: "suggest", text: `${kind}${tn ? ` (${tn})` : ""}`, why: pitch || why, t: rt };
    crew.record({ t: sim.S.t, kind: "order", by, who: null, text: `Suggested: ${kind}${tn ? ` — ${tn}` : ""}`, why: pitch || why });
    return `On the Captain's screen: ${kind}${tn ? ` (${tn})` : ""}. They take it with Y or wave it off; you'll hear which.`;
  }

  function doMoment(args) {
    const what = parseMoment(args.what ?? args.moment ?? args.kind);
    if (!what) refuse(`"${String(args.what ?? "").slice(0, 30)}" isn't a crew moment. Moments: ${Object.entries(MOMENTS).map(([k, m]) => `${k} (${m.who.length === 5 ? "anyone" : m.who.map(crewLabel).join(", ")})`).join(", ")}.`);
    const M = MOMENTS[what];
    let who = args.who != null && args.who !== "" ? parseWho(args.who) : null;
    if (who === "me") who = companionSlot;
    if (args.who && (!who || !M.who.includes(who))) refuse(`${who ? crewLabel(who) : `"${args.who}"`} doesn't lead a ${what}. ${cap(what)}: ${M.who.map(crewLabel).join(", ")}.`);
    if (!who) who = M.who.find((id) => crew.present(id)) || null;
    if (who && !crew.present(who)) refuse(`${crewLabel(who)} can't right now (${crew.named[who]?.overboard ? "overboard" : "on the way somewhere"}). ${cap(what)}: ${M.who.map(crewLabel).join(", ")}.`);
    if (!who) refuse(`Nobody who leads a ${what} is free right now (${M.who.map(crewLabel).join(", ")}).`);
    if ((V.moments[what] ?? -1e9) > rt - MORALE.momentCooldown) refuse(`They just had a ${what} ${Math.round(rt - V.moments[what])} s ago. Other moments: ${Object.keys(MOMENTS).filter((k) => k !== what).join(", ")}.`);
    V.moments[what] = rt;
    const P0 = P();
    P0.morale = Math.min(100, P0.morale + M.morale);
    emit("crew_line", { who, id: `moment_${what}` });
    crew.record({ t: sim.S.t, kind: "event", by: "companion", who: crewLabel(who), text: `${crewLabel(who)} ${M.text}`, why: "" });
    V.orders.companion++;
    return `${crewLabel(who)} ${M.text}. Morale ${Math.round(P0.morale)}.`;
  }

  /** What the companion said aloud: "Fire!" fires held/once batteries; "Brace!" flashes the Captain's prompt. */
  function heard(text) {
    const line = String(text ?? "");
    if (line.trim()) emit("say", { text: line });
    if (!sim || !ACTIVE.has(phase) || paused) return null;
    const sp = parseSpeech(line);
    let fired = null;
    if (sp.fire !== null && phase === "sailing") {
      const res = sim.fireManned(sp.fire.length ? sp.fire : null, "voice");
      const ok = res.filter((r) => r.fired);
      if (ok.length) {
        fired = ok.map((r) => r.side);
        const t2 = ok.map((r) => `${r.side} at ${nameOf(r.target)}${r.raking ? " (raking)" : ""}`).join("; ");
        noteOrder("fire", `Fire! ${t2}`, "", { sides: fired, voice: true }, "companion");
        crew.record({ t: sim.S.t, kind: "order", by: "companion", who: null, text: `"Fire!" — ${t2}`, why: "" });
      }
    }
    if (sp.brace) { V.braceCall = { by: companionName, t: rt }; emit("brace_call", { by: companionName }); noteBraceCall("companion"); }
    return { fire: fired, brace: sp.brace };
  }

  // ---- Intents ---------------------------------------------------------------------------------------

  function input(intent, payload = {}) {
    const p = payload && typeof payload === "object" ? payload : {};
    try {
      switch (intent) {
        case "start":
          if (phase !== "title" && phase !== "results") return false;
          begin({ mission: p.mission, mode: p.mode, night: p.night, seed: p.seed, arena: p.arena });
          return true;
        case "again":
          if (phase !== "results" && phase !== "ending") return false;
          begin(arena ? { arena, seed: p.same ? seedUsed : null } : { mission: missionId, seed: p.same ? seedUsed : null });
          return true;
        case "quit":
        case "back":
          if (phase === "title") return false;
          if (intent === "back" && !["briefing", "ending", "results"].includes(phase)) return false;   // at sea, Back is the pause menu's
          paused = false;
          if (V?.boarding) sim.endBoardingLock();
          emit("cancel_force", { kind: "quit" });
          setPhase("title");
          return true;
        case "start_voyage":
          if (!sim || phase !== "briefing") return false;
          paused = false;
          return castOff();
        case "crew_mode": {
          if (!sim || !(ACTIVE.has(phase) || phase === "briefing")) return false;
          const mode = parseCrewMode(p.mode ?? p.id);
          if (!mode) return false;
          const r = setCrewMode(mode, "captain");
          if (r.ok) { V.orders.captain++; V.lastOrder = { by: "captain", kind: "crew_mode", text: `crew to ${mode}`, why: "", t: rt }; }
          return !!r.ok;
        }
        case "retire":
          if (!sim || !ACTIVE.has(phase) || !cfg?.free || !P().inHarbour) return false;
          end("success", "retired");
          return true;
        case "sail": {
          if (!sim || !ACTIVE.has(phase)) return false;   // the briefing waits for start_voyage
          const before = P().sail;
          sim.setSail(p.set != null ? p.set : before + (Number(p.delta) || 0));
          return P().sail !== before;
        }
        case "sprint":
          if (!sim || !ACTIVE.has(phase)) return false;
          return sim.setSprint(!!p.on);
        case "wheel":
          if (!sim) return false;
          sim.setWheel(p.value);
          return true;
        case "aim":
          if (!sim) return false;
          sim.setLook(p);
          return true;
        case "fire": {
          if (!sim || phase !== "sailing" || paused) return false;
          const look = p && (p.lookYawRel != null || p.yaw != null || p.mode != null) ? p : null;
          return !!sim.fireWeapon(look, "captain").fired;
        }
        case "brace":
          if (!sim || !ACTIVE.has(phase) || paused) return false;
          return sim.brace();
        case "swivel":
          if (!sim || phase !== "sailing" || paused) return false;
          return !!sim.swivel(p.targetId ?? p.contactId, p.weakId ?? p.id).hit;
        case "spyglass":
          if (!sim || !ACTIVE.has(phase)) return false;
          if (!p.on || !p.contactId) { V.spy = p.on ? { id: null, since: rt } : null; emit("spyglass", { id: null, by: "captain", on: !!p.on }); return true; }
          if (V.spy?.id !== p.contactId) V.spy = { id: p.contactId, since: rt };
          return true;
        case "order": {
          if (!sim || !ACTIVE.has(phase)) return false;
          const action = String(p.action ?? p.name ?? "");
          if (!CAPTAIN_ORDERS.has(action)) { emit("order", { kind: "refused", by: "captain", why: `Orders: ${[...CAPTAIN_ORDERS].join(", ")}`, text: `"${action}" isn't an order` }); return false; }
          try { runTool(action, p.args || {}, whyOf(p.args || {}), "captain"); return true; } catch (error) {
            if (error instanceof RefuseErr || error instanceof LocalRefuse) { emit("order", { kind: "refused", by: "captain", why: error.message, text: error.message }); return false; }
            throw error;
          }
        }
        case "suggestion":
        case "proposal": {
          const sg = V?.suggestion;
          if (!sg || (p.id && p.id !== sg.id)) return false;
          closeSuggestion(p.accept ? "accepted" : "declined");
          if (p.accept) acceptSuggestion(sg);
          crew.record({ t: sim.S.t, kind: "event", by: "captain", text: `Captain ${p.accept ? "took" : "waved off"}: ${sg.kind}${sg.targetName ? ` (${sg.targetName})` : ""}`, why: "" });
          return true;
        }
        case "board": {
          // v4: one press. The nearest beaten ship whose ring holds us, at once (refused only at ramming speed, with the reason).
          if (!sim || phase !== "sailing" || paused) return false;
          const r = tryBoard(p.contactId ?? p.id ?? null, "captain");
          if (r.ok) noteOrder("board", `board ${V.boarding?.enemyName || r.id}`, "", { id: r.id }, "captain");
          else if (V.suggestion?.kind === "board") { const sg = V.suggestion; closeSuggestion("accepted"); acceptSuggestion(sg); return !!V.boarding || !!V.boardWhenReady; }
          return r.ok;
        }
        case "boarding_move": return false;   // v3's rounds are gone (boarding_order / pistol / rally)
        case "pistol": {
          if (!V?.boarding || paused) return false;
          const r = firePistol(V.boarding, p.foeId ?? p.id ?? p.targetId ?? null);
          for (const fe of r.events) fightEvent(fe);
          return r.ok;
        }
        case "rally": {
          if (!V?.boarding || paused) return false;
          const r = fightRally(V.boarding, "captain");
          for (const fe of r.events) fightEvent(fe);
          if (r.ok) pushFact({ key: "boarding:rally", priority: "high", head: "Rally", text: "The Captain rallied the boarding party: they're patched up and fighting harder for a few seconds." });
          return r.ok;
        }
        case "boarding_order": {
          if (!V?.boarding) return false;
          const focus = parseFocus(p.focus ?? p.id);
          if (!focus) return false;
          const r = setFocus(V.boarding, focus, "captain");
          for (const fe of r.events) fightEvent(fe);
          return r.ok;
        }
        case "mark":
        case "lock": {
          // v4: the target lock (`mark` is its v3 alias). null clears it.
          if (!sim || !ACTIVE.has(phase)) return false;
          const id = p.contactId ?? p.id ?? null;
          return setLock(id == null || id === "" ? null : id, "captain");
        }
        case "lock_cycle":
          if (!sim || !ACTIVE.has(phase)) return false;
          return cycleLock(p.dir ?? 1, "captain");
        case "pause":
        case "resume": {
          if (!PAUSABLE.has(phase)) return false;
          const want = intent === "resume" ? false : p.on != null ? !!p.on : !paused;
          if (want === paused) return false;
          paused = want;
          emit("pause", { on: paused });
          tell(paused ? "Paused: the Captain stepped away. The bay holds still until they're back." : "Unpaused: back under way.", true);
          return true;
        }
        case "camera":
          camera = p.view || (camera === "chase" ? "helm" : "chase");
          emit("camera", { view: camera });
          return true;
        case "skip":
          if (phase === "briefing") return castOff();   // debug alias of start_voyage
          if (phase === "ending") { toResults(); return true; }
          return false;
        case "mode":
          if (MODES[p.id]) { modeId = p.id; if (missionId && MISSIONS[missionId].tab !== p.id) missionId = null; return true; }
          if (MISSIONS[p.id]) { missionId = p.id; modeId = MISSIONS[p.id].tab; return true; }
          return false;
        case "loaded": saved = p.saved || null; return true;
        case "companion": {
          if (!p.name) return false;
          companionName = String(p.name);
          companionSlot = NAMED.find((id) => clean(companionName) === id || clean(companionName).split(" ")[0] === id) || null;
          if (sim) sim.S.names = { me: companionName };
          return true;
        }
        case "captain_line": {
          const text = String(p.text ?? "").trim();
          if (!text || !V) return false;
          V.captain = { text: text.slice(0, 200), t: rt };
          if (V.boarding && !solo()) tell(`The Captain shouts across the deck: '${text.slice(0, 120)}'`, false, "high");
          return true;
        }
        case "speech_end": return true;
        default: return false;
      }
    } catch (error) {
      console.debug(`[rexmaw-raids] input ${intent} failed`, error);
      return false;
    }
  }

  // ---- Time ----------------------------------------------------------------------------------------

  function step(dt) {
    const d = Number(dt);
    if (!(d > 0)) return;
    const h = Math.min(d, 0.25);
    rt += h;
    acc += h;
    while (acc >= STEP - 1e-9) { acc -= STEP; fixedStep(STEP); }
    tickAcc += h;
    const period = 1 / TICK_HZ;
    if (tickAcc >= period - 1e-9) {
      tickAcc = Math.max(0, tickAcc - period);
      if (tickAcc >= period) tickAcc = 0;
      tick();
    }
  }

  // ---- The snapshot -----------------------------------------------------------------------------------

  function contactState(e) {
    const P0 = P();
    const d = dist(P0.x, P0.z, e.x, e.z);
    return {
      id: e.id, name: e.name, cls: e.cls, role: e.role, x: round1(e.x), z: round1(e.z), heading: round1(e.heading), speed: round1(e.speed || 0),
      vx: round1(e.vx || 0), vz: round1(e.vz || 0),
      hull: Math.max(0, Math.round((e.hull / e.hullMax) * 1000) / 1000), masts: Math.round(e.masts) / 100, crew: Math.round(e.crew), state: e.state, ai: e.ai,
      detected: !!e.detected, known: !!e.known, hostile: !!(e.hostile || e.role === "hunter"), navy: !!e.C.navy,
      portsOpen: { port: !!e.ports.port.open, starboard: !!e.ports.starboard.open, bow: !!e.ports.bow.open }, lit: !!e.lit, cloaked: !!e.cloaked,
      flag: e.state === "surrender" ? "white" : e.cls === "gloam" ? "black" : e.C.navy ? "navy" : "merchant",
      weakPoints: e.weakPoints.map((w) => ({ id: w.id, local: { ...w.local } })), firing: (e.firingT || 0) > 0, fires: e.fires,
      dist: Math.round(d), rel: Math.round(relBearing(P0.x, P0.z, P0.heading, e.x, e.z)), boardable: !e.fixed && !boardProblem(P0, e), marked: sim.S.marked === e.id,
      locked: sim.S.marked === e.id, derelict: !!e.derelict, prize: e.id === world.variant?.prize || (world.variant?.goal === "chest" && e.id === world.variant?.chest),
      sinkT: e.state === "sinking" ? round1(e.sinkT) : null, phase: e.C.legendary ? e.phase : undefined, objective: !!e.objective, chest: !!e.chest,
      lantern: e.lantern ? { yaw: round1(e.lantern.yaw), half: e.lantern.half, range: Math.round(e.lantern.range) } : null,
      alert: Math.round((e.alert || 0) * 100) / 100, spotted: !!e.spotted, split: !!e.split, down: !!e.down, fixed: !!e.fixed,
    };
  }

  function state() {
    if (!sim) {
      return { t: 0, rt: round1(rt), clock: 0, phase, paused, mode: modeId, seed: null, onCall: call(), solo: solo(), pace: 1, daylight: 1, fog: { density: 0, banks: [] },
        mission: missionId ? { id: missionId, label: MISSIONS[missionId].label, time: MISSIONS[missionId].time, tab: MISSIONS[missionId].tab, objective: MISSIONS[missionId].objective, objectives: [], status: "title" } : null,
        ship: null, crew: {}, batteries: {}, contacts: [], projectiles: [], hazards: { spouts: [], mortars: [], shoals: [], reefs: [] }, pickups: [], barrels: [],
        dangers: [], headingCall: null, orders: [], heat: 0, plunder: { hold: 0, banked: 0, loot: 0 }, suggestion: null, proposal: null, boarding: null, marked: null, log: [], companionSlot,
        briefing: null, objective: null, crewMode: null, boardable: [], contrib: null, boardfight: null, lock: null, events: [], powerups: [], buffs: [] };
    }
    const s = sim.S, P0 = s.ship, snap = crew.snapshot();
    const crewOut = {};
    for (const id of crew.ids) { const n = snap.named[id]; crewOut[id] = { station: n.station, at: n.at, task: n.task, walking: n.walking, overboard: n.overboard, companion: n.companion }; }
    const batteries = {};
    for (const sd of ["port", "starboard", "bow", "mortar"]) {
      const m = s.manned[sd];
      const job = crew.jobOf("guns", sd);
      batteries[sd] = { loaded: Math.round(P0.reload[sd] * 100) / 100, manned: !!m, who: job?.who[0] || null, mode: m?.mode || null, target: m?.target || null,
        targetName: m ? targetName(m.target) : null, ammo: m?.ammo || null, firing: (P0.firingT[sd] || 0) > 0, bears: m?.status === "laid", status: m?.status || null,
        auto: s.crewMode.targets?.[sd] || null };
    }
    const orders = [];
    for (const sd of Object.keys(s.manned)) {
      const m = s.manned[sd], job = crew.jobOf("guns", sd);
      orders.push({ id: m.job, kind: "man_guns", side: sd, ammo: m.ammo, mode: m.mode, target: m.target, targetName: targetName(m.target), who: job?.who.slice() || [], hands: 0, progress: null, status: m.status, by: m.by, why: m.why, t: round1(m.t) });
    }
    for (const kind of ["repair", "bail"]) {
      const j = s.jobs[kind];
      if (!j) continue;
      const job = crew.jobOf(kind);
      orders.push({ id: j.id, kind, what: j.what, who: job?.who.slice() || [], hands: job?.hands || 0, progress: Math.round((sim.jobProgress(kind) ?? 0) * 100) / 100, status: "working", by: j.by, why: j.why, t: round1(j.t) });
    }
    const H = s.hazards;
    const shoals = [];
    for (const isl of world.islands) for (const sh of isl.shoals) if (s.revealed.has(sh.id)) shoals.push({ id: sh.id, x: sh.x, z: sh.z, r: sh.r });
    const projectiles = [];
    for (const pr of s.projectiles) {
      if (s.t < pr.t0) continue;
      const tau = s.t - pr.t0;
      const b = pr.b, t = Math.min(tau, b.T);
      const y = Math.max(0, b.y0 + b.vy * t - 4.905 * t * t);
      projectiles.push({ id: pr.id, from: pr.from, side: pr.side, x: round1(b.x0 + b.dx * b.vh * t), y: round1(y), z: round1(b.z0 + b.dz * b.vh * t),
        vx: round1(b.dx * b.vh), vy: round1(b.vy - 9.81 * t), vz: round1(b.dz * b.vh), ammo: pr.ammo, eta: round1(b.T - tau), target: pr.target });
    }
    const M = s.mission;
    const fight = fightState(V.boarding);
    const lim = cfg.limit;
    const look = s.look;
    const sel = s.weapon;
    const W = WEAPONS[sel.weapon] || WEAPONS.broadside;
    const reloadKey = sel.weapon === "broadside" || sel.weapon === "heavy" ? sel.side : sel.weapon === "chain" ? "bow" : sel.weapon;
    return {
      t: round1(s.t), rt: round1(rt), clock: Math.round(clamp(s.t / lim, 0, 1) * 1000) / 1000, phase, phaseT: round1(phaseT), paused, mode: modeId, seed: seedUsed,
      onCall: call(), solo: solo(), pace: pace(), camera,
      mission: { id: missionId || "arena", label: cfg.label, time: cfg.time, tab: cfg.tab, objective: cfg.objective, objectives: M.objectives.map((o) => ({ ...o })),
        status: phase === "briefing" ? "briefing" : M.status, elapsed: round1(s.t), limit: lim, timeLeft: round1(Math.max(0, lim - s.t)), reason: M.reason, phase: M.phase,
        failure: M.failure ? { ...M.failure } : null, variant: world.variant ? { id: world.variant.id, label: world.variant.label } : null },
      briefing: phase === "briefing" ? V.briefing : null,
      objective: objectiveState(sim, { phase }),
      crewMode: crewModeState(),
      boardable: boardableState(),
      contrib: contribOut(),
      daylight: s.night ? 0 : 1, fog: { density: Math.round(s.fogHere * 100) / 100, banks: [...(world.fog || []).map((b) => ({ ...b })), ...sim.sea.banks()] }, visibility: s.visibility,
      wind: { dirDeg: Math.round(s.wind.dirDeg), strength: Math.round(s.wind.strength * 100) / 100 },
      storm: s.storm ? { x: round1(s.storm.x), z: round1(s.storm.z), r: s.storm.r, inside: !!s.storm.inside } : null,
      ship: {
        x: P0.x, z: P0.z, heading: P0.heading, speed: round1(P0.speed), vx: round1(P0.vx), vz: round1(P0.vz), sail: P0.sail, sailName: P0.sprint.on ? "sprint" : SAIL_NAMES[P0.sail],
        sprint: { on: P0.sprint.on, wind: Math.round(P0.sprint.wind * 100) / 100 }, wheel: P0.wheel, rudder: Math.round(P0.rudder * 100) / 100,
        hull: Math.round(P0.hull * 10) / 10, hullMax: P0.hullMax, masts: Math.round(P0.masts), water: Math.round(P0.water * 10) / 10, fires: P0.fires, leaks: P0.leaks,
        crewHands: P0.crewHands, morale: Math.round(P0.morale), ammo: { chain: Math.floor(P0.ammo.chain), mortar: Math.floor(P0.ammo.mortar), barrels: Math.floor(P0.ammo.barrels) },
        braceT: round1(P0.braceT), braceCd: round1(P0.braceCd), perfectT: P0.perfectT == null ? null : round1(P0.perfectT), stuckT: round1(Math.max(0, P0.stuckT)),
        inHarbour: P0.inHarbour, speedCap: round1(P0.speedCap), pointOfSail: P0.pointOfSail, lootSlow: Math.round(P0.lootSlow * 100) / 100, swivelCd: round1(P0.reloadS.swivel),
        guns: { port: { ...P0.guns.port }, starboard: { ...P0.guns.starboard }, bow: { ...P0.guns.bow } }, heel: Math.round(P0.heel * 100) / 100,
      },
      gunnery: { weapon: sel.weapon, side: sel.side, aiming: look.aiming, mode: look.mode, elevation: sel.weapon === "broadside" || sel.weapon === "chain" ? round1(elevOf(sel.weapon, look.pitch)) : null,
        ready: P0.reload[reloadKey] >= 1 && (!W.ammo || P0.ammo[W.ammo] >= 1), ammo: W.ammo ? Math.floor(P0.ammo[W.ammo]) : null },
      reload: Object.fromEntries(Object.entries(P0.reload).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      reloadS: Object.fromEntries(Object.entries(P0.reloadS).map(([k, v]) => [k, round1(v)])),
      batteries,
      crew: crewOut, companionSlot, companionName, hands: { total: snap.hands, onJobs: snap.onJobs },
      orders,
      contacts: s.ships.filter((e) => !e.gone).map(contactState),
      projectiles,
      hazards: {
        wave: H.wave ? { id: H.wave.id, dirDeg: H.wave.dirDeg, eta: round1(H.wave.eta), x: round1(H.wave.x), z: round1(H.wave.z), width: H.wave.width } : null,
        spouts: [...H.spouts.map((sp) => ({ id: sp.id, x: round1(sp.x), z: round1(sp.z), r: sp.r, stage: sp.stage })), ...sim.sea.spouts()],
        lightning: H.lightning ? { x: round1(H.lightning.x), z: round1(H.lightning.z), t: round1(H.lightning.t), eta: round1(Math.max(0, H.lightning.eta)), struck: H.lightning.struck } : null,
        kraken: H.kraken ? { stage: H.kraken.stage, t: round1(H.kraken.t), x: round1(H.kraken.x), z: round1(H.kraken.z), arms: H.kraken.arms.map((a) => ({ id: a.id, side: a.side, station: a.station, hp: round1(a.hp), hpMax: a.hpMax })) } : null,
        mortars: H.mortars.map((m) => ({ id: m.id, x: round1(m.x), z: round1(m.z), r: round1(m.r), eta: round1(Math.max(0, m.eta)), from: m.from })),
        maelstrom: world.maelstrom ? { x: world.maelstrom.x, z: world.maelstrom.z, r: world.maelstrom.r, eye: world.maelstrom.eye } : null,
        shoals,
        reefs: sim.captainReefs().map((r) => ({ id: r.id, name: r.name, kind: r.kind, a: { ...r.a }, b: { ...r.b }, w: r.w, x: r.x, z: r.z, r: r.r })),
      },
      dangers: V.dangers.map((d) => ({ id: d.id, kind: d.kind, x: d.x, z: d.z, r: d.r, label: d.label, by: d.by, expiresIn: round1(Math.max(0, d.until - rt)) })),
      headingCall: V.headingCall ? { deg: V.headingCall.deg, word: V.headingCall.word, reason: V.headingCall.reason, by: V.headingCall.by, expiresIn: round1(Math.max(0, V.headingCall.until - rt)) } : null,
      braceCall: V.braceCall ? { by: V.braceCall.by, ago: round1(rt - V.braceCall.t) } : null,
      pickups: s.pickups.map((q) => ({ id: q.id, kind: q.kind, x: round1(q.x), z: round1(q.z), value: q.value, flotsam: !!q.flotsam, event: q.event || undefined })),
      events: sim.sea.state(),
      powerups: sim.pw.state(), buffs: sim.pw.buffs(),
      barrels: s.barrels.map((b) => ({ id: b.id, x: round1(b.x), z: round1(b.z), lit: b.lit, t: round1(b.t) })),
      wrecks: world.wrecks.map((w) => ({ id: w.id, x: w.x, z: w.z, salvaged: s.salvaged.has(w.id) })),
      salvage: s.salvage ? { id: s.salvage.id, t: round1(s.salvage.t), dur: s.salvage.dur } : null,
      fort: world.fort ? { x: world.fort.x, z: world.fort.z, towers: s.ships.filter((e) => e.cls === "tower").map((e) => ({ id: e.id, x: e.x, z: e.z, hp: Math.round(e.hull), hpMax: e.hullMax, down: !!e.down })), silenced: s.ships.filter((e) => e.cls === "tower").every((e) => e.down) } : null,
      heat: s.heat, plunder: { hold: s.plunder.hold, banked: s.plunder.banked, loot: s.plunder.loot }, contraband: s.contraband, banking: s.banking == null ? null : Math.round(s.banking * 100) / 100,
      repairing: !!s.repairing, coveUsed: s.cove.used,
      suggestion: V.suggestion ? sugState() : null, proposal: V.suggestion ? sugState() : null,
      course: V.course ? courseState() : null,
      boardfight: fight, boarding: fight,
      lock: lockState(),
      marked: s.marked, captainLine: V.captain ? { text: V.captain.text, ago: round1(rt - V.captain.t) } : null, lastOrder: V.lastOrder ? { ...V.lastOrder } : null,
      log: crew.log.slice(-LOG_KEEP),
      stats: { volleys: s.stats.volleys, hits: s.stats.ballsHit, rakingVolleys: s.stats.rakingVolleys, perfectBraces: s.stats.perfectBraces, sunk: s.stats.sunk.length, captured: s.stats.captured.length, pickups: s.stats.pickups },
      ended: V.ended ? { ...V.ended } : null,
    };
  }

  const elevOf = (weapon, pitch) => { const W = WEAPONS[weapon]; return clamp(((Number(pitch) || 0) - W.pitch0) * W.gain, 0, W.maxElev); };
  const sugState = () => ({ id: V.suggestion.id, kind: V.suggestion.kind, target: V.suggestion.target, targetName: V.suggestion.targetName, pitch: V.suggestion.pitch,
    by: V.suggestion.by, t: round1(V.suggestion.t), expiresIn: round1(Math.max(0, V.suggestion.expires - rt)) });

  function courseState() {
    const c = V.course;
    if (c.kind === "contact") {
      const e = sim.shipById(c.id);
      if (!e || e.gone) { V.course = null; return null; }
      return { x: round1(e.x), z: round1(e.z), label: c.label || e.name, kind: "contact", id: e.id };
    }
    return { x: c.x, z: c.z, label: c.label, kind: c.kind, id: c.id };
  }

  function poseNow() {
    const s = sim.S, P0 = s.ship;
    const contacts = {};
    for (const e of s.ships) if (!e.gone) contacts[e.id] = { x: e.x, z: e.z, heading: e.heading, heel: e.heel || 0, speed: e.speed || 0 };
    return { ship: { x: P0.x, z: P0.z, heading: P0.heading, speed: P0.speed, heel: P0.heel }, contacts };
  }

  function pose() {
    if (!sim) return { ship: { x: 0, z: 0, heading: 0, speed: 0, heel: 0 }, contacts: {} };
    const cur = poseNow();
    if (!prevPose || paused) return cur;
    const a = Math.min(1, acc / STEP);
    const lerpPose = (p, q) => {
      const dh = ((q.heading - p.heading + 540) % 360) - 180;
      return { x: p.x + (q.x - p.x) * a, z: p.z + (q.z - p.z) * a, heading: wrap360(p.heading + dh * a), heel: q.heel, speed: q.speed };
    };
    const out = { ship: lerpPose(prevPose.ship, cur.ship), contacts: {} };
    for (const [id, q] of Object.entries(cur.contacts)) out.contacts[id] = prevPose.contacts[id] ? lerpPose(prevPose.contacts[id], q) : q;
    return out;
  }

  return {
    input: (intent, payload) => flushing(() => input(intent, payload)),
    companion: (action, args) => flushing(() => companion(action, args)),
    heard: (text) => flushing(() => heard(text)),
    aimPreview: (look) => (sim ? sim.preview(look || null) : null),
    step, state, pose,
    world: () => world, results: () => results, log: () => (crew ? crew.log.slice() : []), phase: () => phase, mission: () => missionId,
    briefing: () => V?.briefing || null,
    sim: () => sim, crew: () => crew,
    /** The live deck fight (boarding.js's object; tests and debug only — read state().boardfight otherwise). */
    fight: () => V?.boarding || null,
    on: (type, fn) => events.on(type, fn), off: (type, fn) => events.off(type, fn),
    setSeed: (s) => { pinnedSeed = s; }, saved: () => saved,
    /** Debug / tests: the next boarding meets this captain archetype (boarding.js ARCHETYPE_IDS; null = the seeded pick). */
    setArchetype: (id) => { forcedArchetype = ARCHETYPES[id] ? id : null; return forcedArchetype; },
    setObstacles: (list) => { obstacles = Array.isArray(list) ? list : []; sim?.setObstacles(arena ? [] : obstacles); },
    dispose: () => { events.clear(); sim = null; },
  };
}
