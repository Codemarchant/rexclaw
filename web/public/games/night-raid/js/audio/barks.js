// The voices of the raid: the crew's recorded cameo barks (lib/crew/lines.json
// `nr-*` and `rr-*`, Rex, Eve, Ara, Sal and Leo in their own voices, through
// the kit's crew.js: one voice at a time, a toast with their portrait; the kit
// ducks the music under each) and the companion's own recorded reactions off
// a call (lib/lines.js "Rexmaw Raids", through game.react; on a call they
// react live and react() stays silent).
//
//   const barks = createBarks({ bus, game: () => kitGame });
//   barks.crew("rex", "tower_down")      // a named crew member's line ("who:id" first, then anyone's id)
//   barks.wire()                         // the raid's events speak for themselves (below)
//
// Crew line ids (lines.json `events`): the core's `crew_line` ids, plus this
// module's own, each in a per-speaker form "<who>:<id>" so the right person
// answers (Leo on the guns, Rex at the mortar and the fort, Ara on repairs and
// pickups, Sal on the pumps and the sprint, Eve calling reefs and lanterns):
//   orders   leo:ack_man_guns_port|starboard|bow, rex:ack_man_guns_mortar, leo:ack_keep_firing, leo:ack_hold,
//            ara:ack_repair, ara:repair_done, sal:ack_bail, sal:bail_done, eve:danger_marked, eve:fog_heading
//   missions mission_day, mission_night, rex:mission_success, ara:mission_fail, leo:day_ending, eve:cove,
//            rex:fort, rex:tower_down, leo:iron_duke, leo:spotted, eve:lantern, eve:reef_near
//   gunnery  leo:chain_hit, rex:kraken_arm_off · loot rex:pickup_chest, ara:pickup · sal:sprint
//   v1 kept  cast_off, contact, legendary, sink, man_overboard, brace, board, won, lost, hazard_wave,
//            hazard_shoal, hazard_maelstrom, leak_patched, fire_out, overboard_rescued, we_sink
//   v4 boardfight  rex:board (start), striking → won (struck), lost (repelled), moment_rally (the Rally),
//                  rex:captain_down / leo:enemy_captain
//   v4 sea events  on `sea_event {stage:"warn"}`, the lookout first: "eve:sea_<kind>" (all seven baked), else
//                  a line that fits: waves → eve hazard_wave, kraken arm → eve kraken, fog bank →
//                  eve fog_heading, derelict → eve contact
//   v4 whacky ones  warn → rex:sea_gerald, eve:sea_sky_whale, ara:sea_dolphins, ara:sea_flying_fish,
//                  eve:sea_jellyfish, sal:sea_turtle, leo:sea_admiral; then sal:gerald_hit (he landed on us),
//                  rex:gerald_miss ("Gerald sends regards"), leo:whale_flop, sal:dolphin_boost
//   v4.2 power-ups  taken → sal:powerup_swift_wind, leo:powerup_quick_hands, rex:powerup_hot_shot, ara:powerup_patch_kit,
//                  rex:powerup_double_doubloons, ara:powerup_mermaid_kiss, sal:powerup_iron_hull, rex:powerup_powder_keg,
//                  eve:powerup_kraken_ink; one coming up in view → eve:powerup_spotted now and then
//   v4.3 whacky boarding captains  `boardfight {stage, archetype}` (WHACKY below): captain → "cap_<archetype>"
//                  (bubbles / clackers sometimes as a two-liner), gimmick → "gim_<archetype>", struck →
//                  "struck_<archetype>"; the intro and the strike wait for the voice channel instead of dropping
//   v4.3 quips     big_miss (a whole volley of ours in the water), hit_aground / hit_silly (the Rexmaw hit),
//                  one_volley (one of ours sunk within 2.5 s of her first hit), doubloons, mission_success /
//                  mission_fail (anyone's), briefing_idle (60 s on the briefing), and the sea events' outcomes:
//                  eve:gerald_splash, sal:turtle_bump, ara:jelly_sting, eve:admiral_dive, leo:admiral_medal,
//                  ara:fish_caught
//   two-liners     "duo:<key>:1" then "duo:<key>:2", the second asked for 350 ms after the first one ends
//                  (skipped whole when either speaker is the companion); calm-water banter (IDLE_DUOS) after
//                  40 s without a fight, one per 75–120 s, never over a line or the companion speaking
// The companion's reactions (game.react key): greet, board, sink, surrender, brace, man_overboard, bank,
// kraken, legendary, tower_down, spotted, pickup_chest, mission_success, mission_fail (main's game.end()
// picks they_lose / they_win), whacky_captain, big_miss, one_volley, silly_hit.

import { seaKind } from "../ui/dom.js";

const GAME = "Rexmaw Raids";
const MIN_GAP = 4500;          // ms between two crew barks (crew.js's own default is 6 s)

/** Baked lines that fit a sea event until its own "eve:sea_<kind>" line is recorded. */
const SEA_FALLBACK = Object.freeze({ waves: ["eve", "hazard_wave"], kraken_arm: ["eve", "kraken"], fog: ["eve", "fog_heading"], derelict: ["eve", "contact"] });
/** v4 whacky sea events: who calls each one ("<who>:sea_<kind>"). Gerald is Rex's (chapter nine of his chapbook). */
const SEA_VOICE = Object.freeze({ gerald: "rex", sky_whale: "eve", dolphins: "ara", flying_fish: "ara", jellyfish: "eve", turtle: "sal", admiral: "leo" });
/** …and a word on how it went ("<kind>:<stage>" → [who, line id], a list of those to pick from, or a function of the payload). */
const SEA_OUTCOME = Object.freeze({
  "gerald:hit": (p) => (p.target === "rexmaw" ? ["sal", "gerald_hit"] : ["rex", "gerald_miss"]),
  "gerald:splash": [["rex", "gerald_miss"], ["eve", "gerald_splash"]],
  "sky_whale:flop": ["leo", "whale_flop"],
  "dolphins:boost": ["sal", "dolphin_boost"],
  "turtle:hit": (p) => (p.target === "rexmaw" ? ["sal", "turtle_bump"] : null),
  "jellyfish:hit": (p) => (p.target === "rexmaw" ? ["ara", "jelly_sting"] : null),
  "admiral:dive": ["eve", "admiral_dive"],
  "admiral:medal": ["leo", "admiral_medal"],
  "flying_fish:caught": ["ara", "fish_caught"],
});
/** v4.2: who remarks on a power-up taken ("<who>:powerup_<kind>"). */
const PW_VOICE = Object.freeze({ swift_wind: "sal", quick_hands: "leo", hot_shot: "rex", patch_kit: "ara", double_doubloons: "rex", mermaid_kiss: "ara",
  iron_hull: "sal", powder_keg: "rex", kraken_ink: "eve" });
/** v4.3: the whacky boarding captains (`boardfight` payloads' `archetype`), each with its own cap_ / gim_ / struck_ lines. */
const WHACKY = new Set(["gulls", "admiral", "chef", "pip", "bubbles", "encore", "clackers", "mime", "pale"]);
/** …the ones whose entrance is sometimes a two-liner ("duo:cap_<archetype>:1|2"): [first speaker, second]. */
const CAP_DUO = Object.freeze({ bubbles: ["eve", "sal"], clackers: ["eve", "rex"] });
/** Calm-water banter: [key, first speaker, second] ("duo:<key>:1|2" in lines.json). */
const IDLE_DUOS = Object.freeze([
  ["idle_island", "eve", "rex"], ["idle_odds", "sal", "leo"], ["idle_crunch", "rex", "sal"], ["idle_saturday", "eve", "ara"],
  ["idle_teapot", "sal", "leo"], ["idle_cloud", "sal", "eve"], ["idle_lighthouse", "leo", "sal"], ["idle_buoy", "eve", "rex"],
  ["idle_wet", "rex", "eve"], ["idle_tea", "ara", "sal"], ["idle_evie", "eve", "ara"],
]);
/** When the banter may start: seconds without a fight, the gap between two (s, random in the range), the quiet it needs (ms). */
const IDLE = Object.freeze({ calm: 40, gap: [75, 120], quietMs: 3000, liveMs: 10000, briefing: 60 });
/** Contact states that count as a fight going on. */
const BATTLE = new Set(["approach", "broadside", "ram"]);
/** The gap after a line ends before its answer starts (ms). */
const REPLY_MS = 350;
/** The wait before the next calm-water two-liner (s). */
const drawGap = () => IDLE.gap[0] + Math.random() * (IDLE.gap[1] - IDLE.gap[0]);

/**
 * @param {{bus: object, game?: () => object|null}} opts  `game` returns the kit's game (heckle, react, companion)
 */
export function createBarks({ bus, game = () => null } = {}) {
  const K = () => globalThis.RexGame || null;
  const g = () => { try { return game?.() || null; } catch { return null; } };
  let last = null, warnedWater = false, inMaelstrom = false, fortHeard = false, endingWarned = false, missionId = null, time = "day";
  const seen = new Set(), once = new Set(), lastAt = {};
  // v4.3: the calm-water clock (sim seconds), the briefing nudge, a volley of ours in flight, first hits per ship.
  let lastT = 0, calmFrom = 0, idleAt = 0, idleGap = drawGap(), briefNagged = false, lastSay = 0, pend = null, bag = [];
  const firstHit = new Map(), timers = new Set();

  /** Heckle with the kit's game (it excludes the companion's own crew member), else the crew module directly. */
  function heckle(event, opts = {}) {
    const gm = g();
    if (gm?.heckle) return !!gm.heckle(event, { minGap: MIN_GAP, ...opts });
    return !!K()?.crew?.heckle?.(event, { game: GAME, minGap: MIN_GAP, ...opts });
  }

  /** A crew member's line for `id` ("who:id" first, then "who:ack_<station>", then anyone's `id`). */
  function crew(who, id, { station = null, chance = 1, anyone = true, gap = 0, minGap = null } = {}) {
    if (Math.random() > chance) return false;
    const key = `${who || ""}:${id}`, now = performance.now();
    if (gap && now - (lastAt[key] ?? -1e9) < gap) return false;
    const w = String(who || "").toLowerCase();
    const opts = minGap == null ? {} : { minGap };
    let ok = false;
    if (w && station) ok = heckle(`${w}:ack_${station}`, opts);
    if (!ok && w) ok = heckle(`${w}:${id}`, opts);
    if (!ok && anyone) ok = heckle(id, opts);
    if (ok) lastAt[key] = now;
    return ok;
  }
  /** Once per mission. */
  const first = (key) => { if (once.has(key)) return false; once.add(key); return true; };

  /** The companion's recorded reaction (off a call only; game.react does nothing on one). */
  function react(event) {
    try { g()?.react?.(event); } catch { /* reactions are a nicety */ }
  }
  /** …at most once per `gap` ms for that event. */
  function reactNow(event, gap) {
    const now = performance.now();
    if (now - (lastAt[`react:${event}`] ?? -1e9) < gap) return;
    lastAt[`react:${event}`] = now;
    react(event);
  }

  // ---- The voice channel, watched (v4.3) ---------------------------------------------------------------
  // RexGame.voice.play wrapped once, like mix.js and the deck crew do: who's speaking (any line, crew or
  // the companion's), the lines still waiting their turn, and a line's end for its two-liner answer.
  let speaking = null, quietSince = 0, armed = null, tapped = null;
  const queued = [];   // when each line waiting on the channel gives up (the kit drops a line after 4 s)

  function tapVoice() {
    const voice = K()?.voice;
    if (!voice?.play) return false;
    if (voice.play.__nrBarks) return true;
    const inner = voice.play;
    const wrapped = function (url, opts = {}) {
      const then = armed;
      armed = null;
      const slot = Date.now() + 4500;
      queued.push(slot);
      const onStart = opts?.onStart;
      return inner.call(this, url, { ...opts, onStart: (a) => {
        const i = queued.indexOf(slot);
        if (i >= 0) queued.splice(i, 1);
        if (a?.addEventListener) {
          speaking = a;
          let guard = 0;
          const done = () => { clearTimeout(guard); timers.delete(guard); if (speaking === a) { speaking = null; quietSince = Date.now(); } };
          guard = later(done, 15000);   // a line that never says it ended doesn't hold the channel for good
          for (const ev of ["ended", "error", "pause"]) a.addEventListener(ev, done, { once: true });
          if (then) a.addEventListener("ended", () => later(then, REPLY_MS), { once: true });
        }
        onStart?.(a);
      } });
    };
    // The other taps' marks carry over, so a later poll of theirs doesn't wrap the channel twice.
    for (const k of Object.keys(inner)) if (k.startsWith("__nr")) wrapped[k] = inner[k];
    wrapped.__nrBarks = true;
    voice.play = wrapped;
    tapped = { voice, inner, wrapped };
    return true;
  }

  /** How long the channel has been quiet (ms): 0 while a line plays or waits its turn. */
  function quietFor() {
    if (speaking) return 0;
    const now = Date.now();
    while (queued.length && queued[0] < now) queued.shift();
    return queued.length ? 0 : now - quietSince;
  }
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }
  /** Run `fn` once the channel is free (a line already playing finishes first), within `within` ms, else drop it. */
  function whenQuiet(fn, within = 6000) {
    const until = Date.now() + within;
    const go = () => { if (quietFor() >= 250) fn(); else if (Date.now() < until) later(go, 200); };
    go();
  }

  /** Is `who` the companion (whose own lines the kit never plays)? */
  const isCompanion = (who) => String(g()?.companion || "").toLowerCase() === who;

  /** A two-liner: "duo:<key>:1" by `a`, then "duo:<key>:2" by `b` once it ends. Neither when either is the companion. */
  function duo(key, a, b, { minGap = null } = {}) {
    if (isCompanion(a) || isCompanion(b)) return false;
    armed = () => heckle(`duo:${key}:2`, { minGap: 0 });
    try { return heckle(`duo:${key}:1`, minGap == null ? {} : { minGap }); } finally { armed = null; }
  }

  /** A whacky captain's entrance: their two-liner now and then, else anyone's line for them. */
  function captainIntro(arch) {
    const d = CAP_DUO[arch];
    if (d && Math.random() < 0.6 && duo(`cap_${arch}`, d[0], d[1], { minGap: 0 })) return true;
    return crew(null, `cap_${arch}`, { minGap: 0 });
  }

  /** The next calm-water two-liner from a shuffled bag (none twice before the bag's been through). */
  function banter() {
    if (!bag.length) bag = IDLE_DUOS.map((d) => [Math.random(), d]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    const i = bag.findIndex(([, a, b]) => !isCompanion(a) && !isCompanion(b));
    if (i < 0) { bag = []; return false; }
    const [key, a, b] = bag[i];
    if (!duo(key, a, b)) return false;
    bag.splice(i, 1);
    return true;
  }

  /** Something's happening: the calm-water clock starts again. */
  const busy = () => { calmFrom = lastT; };
  /** A fight on: shot in the air, or a contact running in, laying alongside or ramming. */
  function fighting(s) {
    if (s.phase === "boarding" || (s.projectiles || []).length) return true;
    return (s.contacts || []).some((c) => c && BATTLE.has(c.state));
  }

  /** A volley of ours has landed in full: every ball in the water is a quip (the crew's, or the companion's). */
  function settleMiss() {
    if (!pend || pend.hits + pend.splashes < pend.balls) return;
    const whiff = pend.hits === 0;
    pend = null;
    if (!whiff) return;
    if (Math.random() < 0.6) crew(null, "big_miss", { chance: 0.6, gap: 45000 });
    else if (Math.random() < 0.5) reactNow("big_miss", 45000);
  }

  function wire() {
    if (!bus?.on) return () => {};
    if (!tapVoice()) { let tries = 0; const poll = () => { if (!tapVoice() && ++tries < 20) later(poll, 500); }; later(poll, 500); }
    const offs = [
      // The core's own crew barks.
      bus.on("crew_line", (p = {}) => {
        if (!p.id) return;
        if (p.id === "ack_station") crew(p.who, "ack_station", { station: p.station, anyone: false });
        else crew(p.who, p.id);
      }),
      bus.on("mission", (p = {}) => {
        if (p.stage === "start") { missionId = p.id || null; }
        else if (p.stage === "success") { crew(null, "mission_success"); react("mission_success"); }
        else if (p.stage === "fail") { crew(null, "mission_fail"); react("mission_fail"); }
      }),
      bus.on("phase", (p = {}) => {
        if (p.phase === "briefing" || p.phase === "moored") {
          seen.clear(); once.clear(); warnedWater = false; inMaelstrom = false; fortHeard = false; endingWarned = false;
          lastT = 0; calmFrom = 0; idleAt = 0; idleGap = drawGap(); briefNagged = false; pend = null; firstHit.clear();
        }
        if (p.phase === "sailing" && (p.prev === "briefing" || p.prev === "moored")) {
          if (!crew(null, time === "night" ? "mission_night" : "mission_day")) crew(null, "cast_off");
        }
      }),
      bus.on("contact", (p = {}) => {
        if (p.stage !== "appear" || seen.has(p.id)) return;
        seen.add(p.id);
        if (p.cls === "gloam") { crew(null, "legendary"); react("legendary"); }
        else if (p.cls === "manowar") { if (!crew("leo", "iron_duke")) crew(null, "legendary"); react("legendary"); }
        else if (p.cls === "tower") { if (!fortHeard) { fortHeard = true; crew("rex", "fort"); } }
        else crew("eve", "contact", { chance: 0.5 });
      }),
      bus.on("sink", (p = {}) => {
        busy();
        if (p.cls === "tower") { crew("rex", "tower_down"); react("tower_down"); return; }
        // Down within 2.5 s of the first ball of ours that hurt her: one volley did it.
        const t0 = firstHit.get(p.id);
        firstHit.delete(p.id);
        if (p.ours && t0 != null && lastT - t0 <= 2.5 && !/gerald|gulls|jellyfish|ram/.test(String(p.cause || ""))) {
          if (!crew(null, "one_volley")) crew(null, "sink");
          react("one_volley");
          return;
        }
        crew(null, "sink", { chance: 0.6 }); react("sink");
      }),
      bus.on("surrender", () => { busy(); react("surrender"); }),
      // What the companion says on a call: the banter keeps out of their way.
      bus.on("say", () => { lastSay = Date.now(); }),
      // (v4: the boarding fight's own `boardfight` events speak for it below; the legacy `board` won/lost that
      // follows 2.5 s later stays quiet so nobody says it twice.)
      bus.on("bank", () => react("bank")),
      // v4: the boarding fight (spec §1).
      // v4.3: a whacky captain (`archetype`) gets their own entrance, gimmick and strike lines.
      bus.on("boardfight", (p = {}) => {
        busy();
        const st = String(p.stage || "");
        const odd = WHACKY.has(p.archetype) ? p.archetype : null;
        const struck = () => { if (!crew("rex", "captain_down", { anyone: false })) crew(null, Math.random() < 0.5 ? "striking" : "won"); };
        if (st === "start") { crew("rex", "board"); react("board"); }
        else if (st === "captain") {
          if (!odd) { crew("leo", "enemy_captain", { anyone: false }); return; }
          whenQuiet(() => { if (!captainIntro(odd)) crew("leo", "enemy_captain", { anyone: false, minGap: 0 }); });
          react("whacky_captain");
        }
        else if (st === "gimmick") { if (odd) crew(null, `gim_${odd}`, { chance: 0.75, gap: 12000 }); }
        else if (st === "struck") {
          if (odd) whenQuiet(() => { if (!crew(null, `struck_${odd}`, { minGap: 0 })) struck(); });
          else struck();
          react("surrender");
        }
        else if (st === "repelled") crew("ara", "lost");
      }),
      bus.on("intent", ({ name } = {}) => { if (name === "rally") crew(null, "moment_rally", { gap: 20000 }); }),
      // v4: random sea events, called by whoever's on lookout when they're telegraphed.
      bus.on("sea_event", (p = {}) => {
        if (p.stage !== "end") busy();
        // The whacky ones: their own caller (Rex knows that fin), and a word on how it went.
        const odd = SEA_VOICE[p.kind];
        if (odd) {
          if (p.stage === "warn") { if (first(`sea:${p.id ?? p.kind}`)) { crew(odd, `sea_${p.kind}`, { anyone: false }); if (p.kind === "gerald" || p.kind === "sky_whale") react("legendary"); } }
          else {
            const out = SEA_OUTCOME[`${p.kind}:${p.stage}`];
            let line = typeof out === "function" ? out(p) : out;
            if (Array.isArray(line?.[0])) line = line[(Math.random() * line.length) | 0];
            if (line && first(`sea:${p.id ?? p.kind}:${p.stage}`)) crew(line[0], line[1], { anyone: false });
          }
          return;
        }
        if (p.stage !== "warn") return;
        const kind = seaKind(p.kind);
        if (!kind || !first(`sea:${p.id ?? kind}`)) return;
        const fb = SEA_FALLBACK[kind];
        if (crew("eve", `sea_${kind}`, { anyone: false })) return;
        if (fb) crew(fb[0], fb[1]);
        if (kind === "kraken_arm") react("kraken");
      }),
      bus.on("overboard", (p = {}) => {
        busy();
        if (p.stage === "swept") react("man_overboard");
        else if (p.stage === "rescued") crew("ara", "overboard_rescued");
      }),
      // The Captain's or the companion's orders: the person who takes the job says so.
      bus.on("order", (p = {}) => {
        const pl = p.payload || {};
        if (p.kind === "man_guns") {
          const side = pl.side || "port";
          if (pl.mode === "hold") { crew("leo", "ack_hold", { chance: 0.9 }); return; }
          if (side === "mortar") { crew("rex", "ack_man_guns_mortar"); return; }
          if (pl.mode === "keep_firing" && Math.random() < 0.5 && crew("leo", "ack_keep_firing")) return;
          crew("leo", `ack_man_guns_${side}`);
        } else if (p.kind === "repair") crew("ara", "ack_repair");
        else if (p.kind === "bail") crew("sal", "ack_bail");
        else if (p.kind === "danger") crew("eve", "danger_marked", { chance: 0.6, gap: 20000 });
        else if (p.kind === "heading") { if (time === "night" || (last?.fog?.density ?? 0) > 0.3) crew("eve", "fog_heading", { chance: 0.5, gap: 25000 }); }
      }),
      // v3 crew modes: the person who runs it answers (Leo on the guns, Ara on damage control, Leo calling the hold).
      bus.on("crew_mode", (p = {}) => {
        if (p.mode === "attack") crew("leo", "fire_bears", { gap: 6000 });
        else if (p.mode === "defend") crew("ara", "ack_damage", { gap: 6000 });
        else if (p.mode === "hold" && p.prev && p.prev !== "hold") crew("leo", "order_hold", { chance: 0.7, gap: 6000 });
      }),
      // v3 fail counters: at 85 % someone shouts (50 % is the HUD's amber alone). The words that fit the danger.
      bus.on("objective", (p = {}) => {
        if (p.stage !== "warn" || !(Number(p.level) >= 0.85)) return;
        const what = `${p.id || ""} ${p.text || ""}`.toLowerCase();
        if (/spot|alarm|lantern|patrol/.test(what)) crew("leo", "spotted", { gap: 12000 });
        else if (/time|light|dawn|dusk|clock/.test(what)) { if (!endingWarned) { endingWarned = true; crew("leo", "day_ending"); } }
        else if (/hull|sink|sunk/.test(what)) crew(null, "brace", { gap: 10000 });
        else crew(null, "moment_rally", { gap: 15000 });
      }),
      bus.on("job", (p = {}) => {
        if (p.stage !== "done") return;
        if (p.kind === "repair") crew("ara", "repair_done", { chance: 0.8 });
        else if (p.kind === "bail") crew("sal", "bail_done", { chance: 0.8 });
      }),
      bus.on("spotted", (p = {}) => {
        busy();
        if (p.stage === "alert") crew("eve", "lantern", { gap: 20000 });
        else if (p.stage === "spotted") { crew("leo", "spotted", { gap: 15000 }); react("spotted"); }
      }),
      bus.on("pickup", (p = {}) => {
        if (p.kind === "chest") { crew("rex", "pickup_chest"); react("pickup_chest"); }
        else if (Number(p.gold) > 0 && (p.kind === "flotsam" || p.kind === "ring") && Math.random() < 0.5) crew(null, "doubloons", { chance: 0.35, gap: 40000 });
        else crew("ara", "pickup", { chance: 0.25, gap: 30000 });
      }),
      bus.on("sprint", (p = {}) => { if (p.on) crew("sal", "sprint", { chance: 0.35, gap: 40000 }); }),
      bus.on("powerup", (p = {}) => {
        if (p.stage === "pickup") { const who = PW_VOICE[p.kind]; if (who) crew(who, `powerup_${p.kind}`, { anyone: false, gap: 15000 }); }
        else if (p.stage === "spawn" && Number(p.dist) <= 400) crew("eve", "powerup_spotted", { anyone: false, chance: 0.5, gap: 60000 });
      }),
      // v4.3: a volley of ours counted in (every ball in the water is a big miss).
      bus.on("volley", (p = {}) => {
        busy();
        const balls = Number(p.balls) || 0;
        if (p.by !== "rexmaw" || balls < 2 || p.weapon === "barrels") return;
        if (pend && Date.now() - pend.at < 6000) pend.balls += balls;
        else pend = { balls, hits: 0, splashes: 0, at: Date.now() };
      }),
      bus.on("impact", (p = {}) => {
        busy();
        const ours = p.from === "rexmaw" || p.from === "us";
        if (ours && p.kind === "mast" && p.ammo === "chain") crew("leo", "chain_hit", { chance: 0.4, gap: 20000 });
        if (ours && pend) {
          if (p.kind === "splash" && !p.target) pend.splashes++;
          else if (p.target && p.kind !== "explosion") pend.hits++;
          settleMiss();
        }
        // The first ball of ours that hurt her (for "one volley").
        if (ours && p.target && p.target !== "rexmaw" && Number(p.dmg) > 0 && p.kind !== "explosion" && p.ammo !== "ram" && !firstHit.has(p.target)) firstHit.set(p.target, lastT);
        // The Rexmaw hit: run aground on a charted island, or now and then a ball with a sense of humour.
        if (p.target === "rexmaw" && Number(p.dmg) > 0 && !p.cancelled) {
          if (p.cause === "island" || p.cause === "shoal") crew("eve", "hit_aground", { anyone: false, chance: 0.8, gap: 30000 });
          else if (!p.cause || p.cause === "mortar" || p.cause === "ram") {
            if (!crew(null, "hit_silly", { chance: 0.1, gap: 60000 }) && Math.random() < 0.08) reactNow("silly_hit", 60000);
          }
        }
      }),
      bus.on("hazard", (p = {}) => {
        busy();
        if (p.kind === "wave" && (p.stage === "telegraph" || p.stage === "warn")) { crew("eve", "hazard_wave"); react("brace"); }
        else if (p.kind === "reef" && p.stage === "near") crew("eve", "reef_near", { gap: 15000 });
        else if ((p.kind === "shoal" || p.kind === "reef") && (p.stage === "reveal" || p.stage === "spotted")) crew("eve", "hazard_shoal", { chance: 0.6 });
        else if (p.kind === "kraken" && (p.stage === "grab" || p.stage === "rise")) react("kraken");
        else if (p.kind === "kraken" && (p.stage === "arm" || p.stage === "repelled")) crew("rex", "kraken_arm_off", { chance: 0.6, gap: 8000 });
        else if (p.kind === "maelstrom" && (p.stage === "enter" || p.stage === "pull") && !inMaelstrom) { inMaelstrom = true; crew("sal", "hazard_maelstrom"); }
        else if (p.kind === "maelstrom" && (p.stage === "leave" || p.stage === "exit")) inMaelstrom = false;
      }),
      bus.on("leak", (p = {}) => { if (p.stage === "patched") crew("ara", "leak_patched", { chance: 0.5 }); }),
      bus.on("fire", (p = {}) => { if (p.target === "rexmaw") busy(); if (p.target === "rexmaw" && p.stage === "out") crew("ara", "fire_out", { chance: 0.5 }); }),
      bus.on("brace_call", () => { busy(); crew(null, "brace", { chance: 0.5, gap: 10000 }); }),
      bus.on("end", (p = {}) => { if (p.reason === "sunk") crew("rex", "we_sink"); }),
      bus.on("tick", (s) => {
        if (!s) return;
        time = Number.isFinite(s.daylight) ? (s.daylight >= 0.5 ? "day" : "night") : (s.mission?.time || time);
        // Pumps winning the fight: water back under 20 % after being over 40 % (without a bail order: the passive bilge).
        const w = Number(s?.ship?.water) || 0;
        if (w >= 40) warnedWater = true;
        else if (warnedWater && w < 20) { warnedWater = false; crew("sal", "pumps_holding"); }
        // The light going (or the clock running out) with a minute left.
        const left = Number(s.mission?.timeLeft);
        if (s.phase === "sailing" && Number.isFinite(left) && left <= 60 && left > 50 && !endingWarned) { endingWarned = true; crew("leo", "day_ending"); }
        // Inside the cove on a smugglers' run.
        if (missionId === "smugglers_run" && s.phase === "sailing" && s.ship && last?.ship) {
          const cove = s.mission && (s.mission.objectives || []).find((o) => /cove/i.test(o.text || ""));
          if (cove?.done && first("cove")) crew("eve", "cove");
        }
        // Ports thrown open close by: the companion off a call calls the brace.
        if (s.phase === "sailing" && last) {
          for (const c of s.contacts || []) {
            const open = c?.portsOpen && (c.portsOpen.port || c.portsOpen.starboard);
            const was = (last.contacts || []).find((x) => x.id === c?.id)?.portsOpen;
            if (open && !(was && (was.port || was.starboard)) && (Number(c.dist) || 9e9) < 300) { react("brace"); break; }
          }
        }
        // v4.3: calm water (no fight for IDLE.calm s) → a two-liner now and then, never over a line or the companion.
        const t = Number(s.t) || 0;
        if ((s.phase === "sailing" || s.phase === "boarding") && !s.paused) {
          if (t < lastT - 1) { calmFrom = t; idleAt = t; }   // the clock went back: a new run
          if (fighting(s)) calmFrom = t;
          if (s.phase === "sailing" && t - calmFrom >= IDLE.calm && t - idleAt >= idleGap && quietFor() >= IDLE.quietMs && Date.now() - lastSay >= IDLE.liveMs) {
            if (banter()) { idleAt = t; idleGap = drawGap(); }
            else idleAt = Math.max(idleAt, t - idleGap + 10);   // the gallery's busy or switched off: try again in 10 s
          }
        }
        lastT = t;
        // Lingering on the briefing: one nudge.
        if (s.phase === "briefing" && !s.paused && Number(s.phaseT) >= IDLE.briefing && !briefNagged) { briefNagged = true; crew(null, "briefing_idle"); }
        last = s;
      }),
    ];
    return () => {
      offs.forEach((off) => { try { off?.(); } catch { /* gone */ } });
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
      if (tapped && tapped.voice.play === tapped.wrapped) tapped.voice.play = tapped.inner;
      tapped = null;
    };
  }

  return { crew, react, heckle, wire };
}
