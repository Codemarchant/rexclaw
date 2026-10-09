// Rexmaw Raids' side of the Neuro API (spec v2 §4): the one call to
// RexGame.create with the rules and the twelve tools, the forgiving parsers for
// what the companion sends ("left" → port, "NE", "045", "Saw Reef", "chain
// shot", "keep at her"), the speech triggers ("Fire!" fires the batteries a
// gun crew has laid and is holding, zero tool latency; "Brace!" flashes the
// Captain's brace prompt), and the thin layer that carries the run's briefs
// (tells) and forces (boarding rounds) to the companion and its moments to
// the crew's cameos.
//
//   const P = createProtocol({ getRun: () => run, ui, onSay, ... });   // RexGame.create, once
//   P.attach(run)                     // tells, forces, cameos, reactions; → detach()
//   P.finish(run.results())           // the kit's end screen, record, doubloons
//
// The parsers are pure and exported for the run and the tests. Without the kit
// (a test page, neuro.js missing) a quiet stand-in game object is used.

import {
  GAME, MODES, MODE_IDS, NAMED, MOVES, MOMENTS, ORDER_MODES, REPAIR_WHAT, DANGER_KINDS, SUGGEST_KINDS, CREW_MODES, BOARD_FOCUS,
} from "./const.js";
import { wrap360 } from "./geom.js";

// ---- The words the companion reads ---------------------------------------------------------

/** The rules, told once, silently, as the first context (≤ 1200 chars). */
export const RULES_TEXT = "Rexmaw Raids. You sail with the Captain (the user) on the Rexmaw. The Captain steers, sets sail, aims and fires. "
  + "You are their second pair of hands and eyes: you act on their orders, spoken or typed. The crew mode (crew_mode) decides what the crew "
  + "do unbidden: hold (only reload), attack (fire whatever bears at the marked ship) or defend (repair and pump). Tools: man_guns puts a gun "
  + "crew on a battery at a target (once, keep_firing, or hold for your 'Fire!'), overriding the mode there; repair and bail take hands off "
  + "the guns; spyglass; call_heading; mark_danger paints an area on the Captain's chart; brace_call; suggest; look_around; crew_moment; "
  + "board (grapple a beaten ship whose ring we're in); boarding_order (on her deck: go for her captain, her crew, or defend). "
  + "At night and in fog the Captain's chart doesn't show reefs; yours does (the reports give compass bearings): navigate "
  + "with call_heading and mark_danger. The reports give facts and the current objective, never the right move. On your own, only shout "
  + "'Brace!' before big hits and make at most one unprompted suggestion every 90 s. 'Fire!' fires a held battery at once. Keep calls short; "
  + "every tool takes an optional `why`.";

const WHY = { type: "string", description: "Why, in a few words (shown to the Captain and logged), up to 60 characters." };

/** The thirteen tools, registered once (v3 adds crew_mode; v4 swaps boarding_move for board + boarding_order). */
export const ACTIONS = [
  { name: "man_guns", description: "Put a gun crew on a battery, laid on a target: they fire when she bears (once), every time she bears until she sinks or strikes (keep_firing), or load, lay and wait for your 'Fire!' (hold).",
    schema: { type: "object", properties: {
      side: { type: "string", description: "port | starboard | bow | mortar" },
      ammo: { type: "string", description: "round | chain (bow chasers) | heavy (broadsides, close range only)" },
      target: { type: "string", description: "a contact's name, class or direction, 'nearest', 'marked' (the one the Captain eyed), or 'kraken' (the arms on that side)" },
      mode: { type: "string", description: "once | keep_firing | hold" },
      who: { type: "string", description: "optional gun captain: rex | eve | ara | sal | leo | me" }, why: WHY }, required: ["side"] } },
  { name: "repair", description: "Send the carpenters to work (takes 8 hands off the guns while they work, so reloads slow).",
    schema: { type: "object", properties: { what: { type: "string", description: "hull | masts | leaks | fires | all" }, why: WHY } } },
  { name: "bail", description: "Man the pumps until she's dry (takes 4 hands off the guns).", schema: { type: "object", properties: { why: WHY } } },
  { name: "spyglass", description: "A close look at a contact: class, cargo and value, guns, hull, which side her weak points glow on, what she seems to be doing.",
    schema: { type: "object", properties: { contact: { type: "string", description: "a contact's name, class, direction or 'nearest'" } }, required: ["contact"] } },
  { name: "call_heading", description: "Call a heading for the Captain: a compass marker and a banner on their screen.",
    schema: { type: "object", properties: { heading: { type: "string", description: "a compass word (NE, north-east) or degrees (045), or a place (the cove, home)" }, reason: { type: "string", description: "a few words" }, why: WHY }, required: ["heading"] } },
  { name: "mark_danger", description: "Paint a danger area on the Captain's chart (and a faint red glow on the water) for 60 s.",
    schema: { type: "object", properties: {
      kind: { type: "string", description: "reef | rocks | shoal | patrol | whirlpool | wreck" },
      where: { type: "string", description: "a bearing and distance ('045 220 m', 'NE 200 m', 'starboard bow 150 m') or a hazard's name from your chart ('Saw Reef')" },
      radius: { type: "integer", description: "metres (default: the hazard's size, or 60)" }, why: WHY }, required: ["where"] } },
  { name: "brace_call", description: "Shout BRACE: flashes the brace prompt for the Captain (saying 'Brace!' does the same).", schema: { type: "object", properties: { why: WHY } } },
  { name: "board", description: "Grapple and board a beaten ship (hull 25% or less, masts 20% or less, or struck) whose ring the Rexmaw is in: our crew fight on her deck until her captain falls (she strikes: her cargo, shot and hands are ours) or ours are all down. Refused at ramming speed.",
    schema: { type: "object", properties: { target: { type: "string", description: "optional: her name, class, or 'marked' (default: the nearest one in reach)" }, why: WHY } } },
  { name: "boarding_order", description: "During a boarding: where the boarding party fights. captain = up to three go for her captain (ends it fastest once he's on deck), crew = man to man with her crew, defend = hold our rail (take less, deal less; Ara heals more).",
    schema: { type: "object", properties: { focus: { type: "string", description: "captain | crew | defend" }, why: WHY }, required: ["focus"] } },
  { name: "suggest", description: "Put a suggestion card on the Captain's screen (not a yes/no blocker; accepting sets their waypoint or marks the target).",
    schema: { type: "object", properties: {
      kind: { type: "string", description: "target | loot | route | flee | board" },
      target: { type: "string", description: "a contact, a pickup or wreck, a place, or a heading" },
      pitch: { type: "string", description: "one short sentence" }, why: WHY }, required: ["kind"] } },
  { name: "look_around", description: "The full situation report now: mission, contacts, ship, orders, your chart of hidden hazards, lanterns, sea.",
    schema: { type: "object", properties: {} } },
  { name: "crew_moment", description: "A crew moment in a calm stretch: shanty (anyone), tea (Ara), banter (anyone), rally (Leo, Rex), joke (Sal, Eve).",
    schema: { type: "object", properties: { who: { type: "string", description: "rex | eve | ara | sal | leo" }, what: { type: "string", description: "shanty | tea | banter | rally | joke" } }, required: ["what"] } },
  { name: "crew_mode", description: "Set what the crew do on their own: hold (only reload what the Captain fires), attack (gun crews fire whichever battery bears at the marked ship, else the nearest enemy), defend (repair, pump and fight fires on their own). man_guns, repair and bail orders still override it.",
    schema: { type: "object", properties: { mode: { type: "string", description: "hold | attack | defend" }, why: WHY }, required: ["mode"] } },
];
export const ACTION_NAMES = ACTIONS.map((a) => a.name);

/** The kit's mode tabs: Day / Night / Free Roam. */
export const MODE_TABS = MODE_IDS.map((id) => ({ id, label: MODES[id].label, hint: MODES[id].hint }));

// ---- Forgiving parsers -----------------------------------------------------------------------

export const clean = (v) => String(v ?? "").toLowerCase().replace(/[’']/g, "").replace(/[_-]/g, " ").replace(/[^a-z0-9%.\s]/g, " ").replace(/\s+/g, " ").trim();
const has = (s, re) => re.test(` ${s} `);

/** Sides from "port", "left", "both", "mortar", "bow chasers" → ["port"], ["port","starboard"], ...; null if none. */
export function parseSide(v) {
  const s = clean(v);
  if (!s) return null;
  if (has(s, /\b(all|every|everything|all guns|all batteries)\b/)) return ["port", "starboard", "bow"];
  if (has(s, /\b(both|broadsides|each side|both sides|either)\b/)) return ["port", "starboard"];
  const out = [];
  if (has(s, /\b(mortars?|bomb|bombs|lob)\b/)) out.push("mortar");
  if (has(s, /\b(port|left|larboard)\b/)) out.push("port");
  if (has(s, /\b(starboard|stbd|right)\b/)) out.push("starboard");
  if (has(s, /\b(bow|chasers?|bow chasers?|front|forward|ahead|bowchaser|chain)\b/) && !out.includes("mortar")) out.push("bow");
  return out.length ? out : null;
}

export function parseAmmo(v) {
  const s = clean(v);
  if (!s) return null;
  if (["round", "chain", "heavy"].includes(s)) return s;
  if (has(s, /\b(chain|bar|dismantling|rigging|masts?|sails?)\b/)) return "chain";
  if (has(s, /\b(heavy|double|doubled|double shotted|big)\b/)) return "heavy";
  if (has(s, /\b(round|ball|solid|roundshot|normal|regular|standard|hull)\b/)) return "round";
  return null;
}

/** once | keep_firing | hold, from "keep at her", "until she sinks", "one volley", "wait for my word". */
export function parseManMode(v) {
  const s = clean(v);
  if (!s) return null;
  if (ORDER_MODES.includes(s.replace(/ /g, "_"))) return s.replace(/ /g, "_");
  if (has(s, /\b(hold|wait|mark|my word|my signal|command|ready|stand by|standby|on my|armed)\b/)) return "hold";
  if (has(s, /\b(once|one|single|a volley|one volley|first chance|next)\b/)) return "once";
  if (has(s, /\b(keep|continuous|continuously|until|at will|whenever|repeat|repeatedly|all|free|sink her|bears)\b/)) return "keep_firing";
  return null;
}

/** Who: a named crew member, "me", or null. */
export function parseWho(v) {
  const s = clean(v);
  if (!s) return null;
  for (const id of NAMED) if (has(s, new RegExp(`\\b${id}\\b`))) return id;
  if (has(s, /\b(me|myself|i|first mate|mate|you)\b/)) return "me";
  return null;
}

export function parseRepairWhat(v) {
  const s = clean(v);
  if (!s) return "all";
  if (REPAIR_WHAT.includes(s)) return s;
  if (has(s, /\b(all|everything|whatever|anything|her|ship|damage)\b/)) return "all";
  if (has(s, /\b(fires?|flames?|burning|blaze)\b/)) return "fires";
  if (has(s, /\b(leaks?|holes?|waterline|flooding)\b/)) return "leaks";
  if (has(s, /\b(masts?|sails?|rigging|spars?|yards?)\b/)) return "masts";
  if (has(s, /\b(hull|planks?|timbers?|sides?|patch)\b/)) return "hull";
  return null;
}

const COMPASS = [["north north east", 22.5], ["east north east", 67.5], ["east south east", 112.5], ["south south east", 157.5],
  ["south south west", 202.5], ["west south west", 247.5], ["west north west", 292.5], ["north north west", 337.5],
  ["north east", 45], ["north west", 315], ["south east", 135], ["south west", 225], ["northeast", 45], ["northwest", 315],
  ["southeast", 135], ["southwest", 225], ["north", 0], ["south", 180], ["east", 90], ["west", 270],
  ["nne", 22.5], ["ene", 67.5], ["ese", 112.5], ["sse", 157.5], ["ssw", 202.5], ["wsw", 247.5], ["wnw", 292.5], ["nnw", 337.5],
  ["ne", 45], ["nw", 315], ["se", 135], ["sw", 225], ["n", 0], ["s", 180], ["e", 90], ["w", 270]];
/** A compass direction in cleaned text ("north-east", "NE", "nne"), as a heading, or null. */
export function compassIn(s) {
  const t = clean(s);
  for (const [w, h] of COMPASS) if (new RegExp(`(^| )${w}( |$)`).test(t)) return h;
  return null;
}

const REL_WORDS = [["dead ahead", 0], ["ahead", 0], ["starboard bow", 45], ["starboard beam", 90], ["starboard quarter", 135], ["dead astern", 180], ["astern", 180],
  ["port quarter", -135], ["port beam", -90], ["port bow", -45], ["to starboard", 90], ["to port", -90], ["starboard", 90], ["port", -90], ["right", 90], ["left", -90]];
/** A relative direction ("starboard bow", "astern") as a relative bearing (+ starboard), or null. */
export function relIn(s) {
  const t = clean(s);
  for (const [w, r] of REL_WORDS) if (new RegExp(`(^| )${w}( |$)`).test(t)) return r;
  return null;
}

/** A heading from "NE", "north-east", "045", 45, "heading 270": degrees, or null. */
export function parseHeading(v) {
  if (typeof v === "number" && Number.isFinite(v)) return wrap360(v);
  const s = clean(v);
  if (!s) return null;
  const c = compassIn(s);
  if (c != null) return c;
  const m = /(?:^| )(\d{1,3}(?:\.\d+)?)(?: ?(?:deg|degrees|°))?(?: |$)/.exec(s);
  if (m && Number(m[1]) <= 360) return wrap360(Number(m[1]));
  return null;
}

/** A distance in metres from "220 m", "220m", "220 metres", "0.3 km", "two hundred"; null if none. */
export function parseDistance(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v);
  const s = clean(v);
  let m = /(\d+(?:\.\d+)?) ?(km|kilometres|kilometers)\b/.exec(s);
  if (m) return Number(m[1]) * 1000;
  m = /(\d+(?:\.\d+)?) ?(m|metres|meters|yards|yds)\b/.exec(s);
  if (m) return Number(m[1]);
  if (/\b(cable|cables)\b/.test(s)) { const k = /(\d+(?:\.\d+)?) ?cables?/.exec(s); return (k ? Number(k[1]) : 1) * 185; }
  if (/\bhundred\b/.test(s)) { const W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, a: 1 }; const k = /(\w+) hundred/.exec(s); return (W[k?.[1]] || 1) * 100; }
  return null;
}

/**
 * Where, from "045 220 m", "NE 200 m", "starboard bow 150 m", "bearing 45 distance 220", {bearing, distance}:
 * {bearing (compass °) | null, rel (relative °) | null, distance | null}; a name is left for the caller.
 */
export function parseWhere(v) {
  if (v && typeof v === "object") {
    const b = v.bearing ?? v.heading ?? v.deg;
    return { bearing: b != null ? parseHeading(b) : null, rel: null, distance: parseDistance(v.distance ?? v.range ?? v.dist), name: v.name || null };
  }
  const s = clean(v);
  if (!s) return { bearing: null, rel: null, distance: null, name: null };
  const distance = parseDistance(s);
  const noDist = s.replace(/(\d+(?:\.\d+)?) ?(km|kilometres|kilometers|m|metres|meters|yards|yds)\b/g, " ");
  const rel = relIn(noDist);
  const bearing = rel == null ? parseHeading(noDist) : null;
  return { bearing, rel, distance, name: s };
}

export function parseDangerKind(v) {
  const s = clean(v);
  if (!s) return null;
  if (DANGER_KINDS.includes(s)) return s;
  if (has(s, /\b(reef|reefs|coral|breakers)\b/)) return "reef";
  if (has(s, /\b(rock|rocks|stones?|teeth)\b/)) return "rocks";
  if (has(s, /\b(shoal|shoals|shallows?|sandbar|bank)\b/)) return "shoal";
  if (has(s, /\b(patrol|lantern|navy|guard|watch)\b/)) return "patrol";
  if (has(s, /\b(whirlpool|maelstrom|vortex|eddy)\b/)) return "whirlpool";
  if (has(s, /\b(wreck|wreckage|hulk)\b/)) return "wreck";
  return null;
}

export function parseSuggestKind(v) {
  const s = clean(v);
  if (!s) return null;
  if (SUGGEST_KINDS.includes(s)) return s;
  if (has(s, /\b(board|boarding|grapple|take her)\b/)) return "board";
  if (has(s, /\b(flee|run|escape|retreat|away)\b/)) return "flee";
  if (has(s, /\b(loot|pickup|crate|barrel|chest|flotsam|treasure|salvage|wreck|bottle)\b/)) return "loot";
  if (has(s, /\b(route|course|heading|way|path|go|sail|detour|cove|home)\b/)) return "route";
  if (has(s, /\b(target|attack|engage|hunt|chase|fight|ship)\b/)) return "target";
  return null;
}

export function parseMove(v) {
  const s = clean(v);
  if (MOVES.includes(s)) return s;
  if (has(s, /\b(rally|inspire|rally the crew)\b/)) return "rally";
  if (has(s, /\b(brace|duck|cover|take cover|get down)\b/)) return "brace";
  if (has(s, /\b(volley|shoot|fire|muskets?|pistols?)\b/)) return "volley";
  if (has(s, /\b(charge|attack|rush|swords?|cutlass|cutlasses|board)\b/)) return "charge";
  if (has(s, /\b(defend|block|hold|shields?|parry|guard)\b/)) return "defend";
  return null;
}

/** v4: a boarding party's focus — captain | crew | defend — from "go for the captain", "their crew", "hold the rail". */
export function parseFocus(v) {
  const s = clean(v);
  if (!s) return null;
  if (BOARD_FOCUS.includes(s)) return s;
  if (has(s, /\b(captain|officer|boss|leader|skipper|him|charge)\b/)) return "captain";
  if (has(s, /\b(defend|defence|defense|hold|rail|guard|back|careful|cover|brace)\b/)) return "defend";
  if (has(s, /\b(crew|sailors|men|hands|them|everyone|all|volley|fight)\b/)) return "crew";
  return null;
}

/** hold | attack | defend, from "attack", "open fire at will", "defensive", "stand easy", "repairs", "2". */
export function parseCrewMode(v) {
  const s = clean(v);
  if (!s) return null;
  if (CREW_MODES.includes(s)) return s;
  if (has(s, /\b(1|hold|stand easy|hold fire|cease fire|ceasefire|easy|reload only|wait)\b/)) return "hold";
  if (has(s, /\b(2|attack|attacking|offence|offense|offensive|fire at will|open fire|engage|aggressive|guns)\b/)) return "attack";
  if (has(s, /\b(3|defend|defence|defense|defensive|repair|repairs|patch|pumps?|bail|damage control|protect)\b/)) return "defend";
  return null;
}

export function parseMoment(v) {
  const s = clean(v);
  if (MOMENTS[s]) return s;
  if (has(s, /\b(shanty|song|sing|singing)\b/)) return "shanty";
  if (has(s, /\b(tea|brew|cuppa)\b/)) return "tea";
  if (has(s, /\b(banter|chat|tease|teasing)\b/)) return "banter";
  if (has(s, /\b(rally|speech|inspire|pep)\b/)) return "rally";
  if (has(s, /\b(joke|jest|pun|funny)\b/)) return "joke";
  return null;
}

/**
 * Speech triggers in what the companion said aloud (onSay):
 * fire: the sides named with an imperative "Fire!" / "Now!" ([] = every held battery), or null;
 * brace: an imperative "Brace!".
 */
export function parseSpeech(text) {
  const raw = String(text ?? "").toLowerCase().replace(/[’]/g, "'");
  if (!raw.trim()) return { fire: null, brace: false };
  let fire = null, brace = false;
  for (const sentence of raw.split(/[.!?;\n]+/)) {
    const s = sentence.replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
    if (!s) continue;
    const w = s.split(" ");
    let trig = false;
    for (let i = 0; i < w.length; i++) {
      if (w[i] === "fire") {
        const prev = w[i - 1] || "", next = w[i + 1] || "", next2 = w[i + 2] || "";
        if (/^(a|the|on|no|any|that|this|of|cease|hold|ceasefire|another|big|small|her|their|our|by|to|from|catch|caught|set|light|lit|under|returning)$/.test(prev)) continue;
        if (w.slice(Math.max(0, i - 5), i).some((x) => /^(don't|dont|not|no|never|won't|wont|can't|cant|shouldn't|wait|until|unless)$/.test(x))) continue;
        if (/^(to|should|could|would|might|can|will|may|must|if|when|before|after|gonna|going|wanna|they|she|he|it|they'll|she'll|we'll|i'll)$/.test(prev)) continue;
        if (/^(ship|ships|aboard|aft|forward|below|out|is|was|spreading|started|burning|in|on|there|here|control|hazard|damage|crew|party|watch|barrels?)$/.test(next)) continue;
        if (next === "at" && next2 === "will") continue;
        trig = true;
      }
      if (w[i] === "now" && w.length <= 4 && i === w.length - 1) {
        const rest = w.filter((x, j) => j !== i && !/^(and|ok|okay|right|guns|lads|boys|all|port|starboard|bow|both|go|mortar|mortars)$/.test(x));
        if (!rest.length) trig = true;
      }
      if (w[i] === "brace") {
        if (w.slice(Math.max(0, i - 4), i).some((x) => /^(don't|dont|not|no|never|won't|wont|needn't)$/.test(x))) continue;
        brace = true;
      }
    }
    if (trig) {
      const sides = parseSide(s.replace(/\b(fire|now)\b/g, " ")) || [];
      fire = fire ? [...new Set([...fire, ...sides])] : sides;
    }
  }
  return { fire, brace };
}

// ---- The kit ---------------------------------------------------------------------------------

class LocalRefuse extends Error {}

function standInGame() {
  return {
    name: GAME, companion: "Your companion", companionId: 0, connected: false, saved: {}, mode: MODE_TABS[0].id, sessionPoints: 0,
    save(patch = {}) { Object.assign(this.saved, patch); },
    force() {}, cancelForce() {}, waiting: () => false, tell() {}, chat() {}, heckle: () => false, react() {},
    award() {}, best: () => false, record: () => ({ wins: 0, losses: 0, draws: 0 }), end() {},
  };
}

/**
 * Connect Rexmaw Raids to the companion.
 * @param {Object} deps
 * @param {() => object|null} deps.getRun
 * @param {{recordInto?: Element|null, modesInto?: Element|null}} [deps.ui]
 * @param {string[]} [deps.music]
 * @param {() => boolean} [deps.solo]  the Captain's "Companion off a call: Solo" setting: off a call, no tells or
 *   forces reach the companion (so the kit wakes no off-call turn for the game); on a call it changes nothing
 */
export function createProtocol({ getRun = () => null, ui = {}, music = [], onVoiceLine = null, onSay = null, onThinking = null, onSpeechEnd = null,
  solo = () => false } = {}) {
  const Kit = globalThis.RexGame || null;
  const Refuse = Kit?.Refuse || LocalRefuse;
  let onCall = false;
  /** Off a call with Solo picked: the game keeps its reports and requests to itself. */
  const sittingOut = () => { if (onCall) return false; try { return !!solo(); } catch { return false; } };
  const held = [];
  let flushTimer = 0, flushTries = 0;
  const deliver = (fn) => {
    const r = getRun?.();
    if (r) { try { fn(r); } catch (error) { console.debug("[rexmaw-raids] protocol: the run threw", error); } return; }
    held.push(fn);
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
  };
  function flush() {
    flushTimer = 0;
    const r = getRun?.();
    if (!r) { if (++flushTries < 300) flushTimer = setTimeout(flush, 100); return; }
    for (const fn of held.splice(0)) { try { fn(r); } catch (error) { console.debug("[rexmaw-raids] protocol: the run threw", error); } }
  }
  const live = (fn) => { const r = getRun?.(); if (r) { try { fn(r); } catch (error) { console.debug("[rexmaw-raids] protocol: the run threw", error); } } };

  const game = Kit?.create
    ? Kit.create({
      name: GAME,
      rules: RULES_TEXT,
      actions: ACTIONS,
      onAction: (name, args) => {
        const r = getRun?.();
        if (!r) throw new Refuse("The ship isn't ready yet. Try again in a moment.");
        return r.companion(name, args);
      },
      modes: MODE_TABS,
      onMode: (id, byUser) => deliver((r) => r.input("mode", { id, byUser })),
      music,
      scenes: [], seagulls: false,
      chat: true,
      ui: { recordInto: ui.recordInto || null, modesInto: ui.modesInto || null },
      onCompanion: (name) => deliver((r) => r.input("companion", { name })),
      onLoad: (saved) => deliver((r) => r.input("loaded", { saved })),
      onAgain: () => deliver((r) => r.input("again")),
      onSay: (text) => { live((r) => r.heard(text)); try { onSay?.(text); } catch (error) { console.debug("[rexmaw-raids] onSay failed", error); } },
      onThinking: (on) => { try { onThinking?.(on); } catch (error) { console.debug("[rexmaw-raids] onThinking failed", error); } },
      onSpeechEnd: () => { live((r) => r.input("speech_end")); try { onSpeechEnd?.(); } catch (error) { console.debug("[rexmaw-raids] onSpeechEnd failed", error); } },
      onVoiceLine: (audio, info) => { try { onVoiceLine?.(audio, info); } catch (error) { console.debug("[rexmaw-raids] voiceLine failed", error); } },
    })
    : standInGame();

  function cameo(event, { chance = 1, minGap } = {}) {
    const opts = { chance: onCall && chance < 1 ? chance / 2 : chance };
    if (minGap != null) opts.minGap = minGap;
    try { return !!game.heckle?.(event, opts); } catch (error) { console.debug("[rexmaw-raids] cameo failed", error); return false; }
  }
  function react(event) {
    if (onCall) return;
    try { game.react?.(event); } catch (error) { console.debug("[rexmaw-raids] react failed", error); }
  }
  const tell = (text, silent = true) => { if (text && !sittingOut()) game.tell?.(text, silent); };

  function chat(text) {
    const line = String(text ?? "").trim().slice(0, 500);
    if (!line) return false;
    try { if (typeof game.chat === "function") { game.chat(line); return true; } } catch (error) { console.debug("[rexmaw-raids] chat failed", error); }
    return false;
  }

  function attach(run, { reactions = true, cameos = true } = {}) {
    const offs = [];
    const on = (type, fn) => offs.push(run.on(type, fn));
    on("tell", ({ text, silent }) => tell(text, silent));
    on("force", ({ state, query, actions, priority }) => {
      if (sittingOut()) return;
      try { game.force?.({ state, query, actions, priority, afterUser: false }); } catch (error) { console.debug("[rexmaw-raids] force failed", error); }
    });
    on("cancel_force", () => { try { game.cancelForce?.(); } catch { /* nothing open */ } });
    let flooded = false, low = false;
    on("phase", ({ phase }) => { if (phase === "briefing") { flooded = false; low = false; } });
    if (cameos) {
      on("phase", ({ phase }) => { if (phase === "sailing") cameo("cast_off", { chance: 0.8, minGap: 0 }); });
      on("contact", ({ stage }) => { if (stage === "appear") cameo("contact", { chance: 0.25 }); });
      on("volley", ({ by, raking }) => { if (by === "rexmaw") cameo(raking ? "rake" : "volley", { chance: raking ? 0.5 : 0.1 }); });
      on("sink", ({ ours }) => { if (ours) cameo("sink", { chance: 0.7 }); });
      on("surrender", () => cameo("surrender", { chance: 0.8 }));
      on("board", ({ stage }) => { if (stage === "won") cameo("board_won", { minGap: 0 }); if (stage === "lost") cameo("board_lost", { minGap: 0 }); });
      on("overboard", ({ stage }) => { if (stage === "swept") cameo("man_overboard", { minGap: 0 }); });
      on("fire", ({ target, stage }) => { if (target === "rexmaw" && stage === "start") cameo("fire_aboard", { chance: 0.4 }); });
      on("tick", (s) => {
        if (s.ship?.water >= 50 && !flooded) { flooded = true; cameo("flooding", { minGap: 0 }); }
        if (s.ship?.hull <= 25 && !low) { low = true; cameo("hull_low", { minGap: 0 }); }
      });
      on("bank", () => cameo("bank", { minGap: 0 }));
      on("spotted", ({ stage }) => { if (stage === "spotted") cameo("spotted", { chance: 0.6 }); });
      on("hazard", ({ kind, stage }) => {
        if (kind === "kraken" && stage === "ink") cameo("kraken", { minGap: 0 });
        if (kind === "wave" && stage === "telegraph") cameo("wave", { chance: 0.5 });
        if (kind === "maelstrom" && stage === "enter") cameo("maelstrom", { chance: 0.6 });
      });
      on("salvage", ({ stage }) => { if (stage === "done") cameo("salvage", { chance: 0.8 }); });
      on("contact", ({ cls, stage }) => { if ((cls === "gloam" || cls === "manowar") && stage === "appear") cameo("legendary", { minGap: 0 }); });
    }
    if (reactions) {
      on("board", ({ stage }) => { if (stage === "start") react("board"); });
      on("sink", ({ ours }) => { if (ours) react("sink"); });
      on("surrender", () => react("surrender"));
      on("brace", ({ perfect }) => { if (perfect) react("brace"); });
      on("overboard", ({ stage }) => { if (stage === "swept") react("man_overboard"); });
      on("bank", () => react("bank"));
      on("hazard", ({ kind, stage }) => { if (kind === "kraken" && stage === "grab") react("kraken"); });
      on("contact", ({ cls, stage }) => { if ((cls === "gloam" || cls === "manowar") && stage === "appear") react("legendary"); });
    }
    return () => { for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } } };
  }

  /** The kit's end of a mission: record, doubloons, best score, its result screen. */
  function finish(results) {
    if (!results) return;
    const s = results.score;
    try { game.best?.(s.total, results.mission); } catch { /* the best score is a nicety */ }
    const stars = "★".repeat(s.stars) + "☆".repeat(3 - s.stars);
    const title = results.outcome === "success" ? `${results.label}: done ${stars}` : `${results.label}: ${{ sunk: "sunk", time: "out of time", escaped: "they got away", spotted: "spotted", lost: "the prize was lost" }[results.reason] || "failed"}`;
    game.end?.({
      outcome: s.outcome, points: s.doubloons, title,
      detail: `${results.loot} gold · ${results.sunk.length} sunk · ${results.captured.length} taken · hull ${results.hull}% · ${s.total} points`,
      quip: `Seed ${results.seed}`,
    });
  }

  return {
    game, Refuse, tell, chat, cameo, react, finish, attach,
    setOnCall: (v) => { onCall = !!v; }, onCall: () => onCall,
  };
}
