// Boarding (spec v4 §1): a short Black Flag-style deck fight. A beaten ship
// (≤ 25% hull, masts ≤ 20%, or struck) can be boarded when the Rexmaw is
// inside her RING — her hull ellipse grown by 30 m (+ our half-beam), the ring
// the scene draws from `boardRing` — and one press of B starts it at once.
// The only refusal inside the ring is ramming speed (closing ≥ 12 m/s).
//
// Why v3 needed B spammed: it measured the range centre-to-centre minus the
// beams (off her bow or stern the drawn ring said "in range" ~35 m before the
// core did) and also wanted the speeds within 4 m/s (a struck ship lies at
// 0 m/s, the Rexmaw comes in at ~9); each failure returned false silently.
//
// The fight: our crew (the named five still aboard, and the companion's own
// figure when they aren't one of them) swing across and fight her crew (6–12
// by class: sailors with cutlasses, gunners with pistols) in paired duels on
// her deck. Every fighter swings every ~0.6–1.2 s; a hit lands when their
// accuracy accumulator passes 1 (no dice: the same fight plays the same way).
// Her captain (a boss) comes on deck when half her crew is down. Captain
// down → she strikes; all ours down → repelled.
// The Captain (the user) fires a pistol (big damage, 1.2 s cooldown) and can
// Rally once; the companion's boarding_order sets the crew's focus.
//
// Captain archetypes: about one boarding in three (seeded, never the same one
// twice in a row) meets a whacky captain instead of the plain one — see
// ARCHETYPES below (Captain Three-Gulls, Admiral Fernsby-Whistle, Cookie Mabel,
// Peg-Leg Pip and Tiny, Baron Von Bubbles, Señor Encore, Captain Clackers, The
// Mime, The Pale Captain). Each brings a crew variant (sailors, navy marines,
// cooks, monkeys, skeletons) and a gimmick in this deterministic sim, told as
// `boardfight {stage: "gimmick", archetype, what, …}` events. Every captain, plain
// or whacky, on any ship, comes up from the cabin once half the crew is down
// (the entrance cut); the gimmicks that need the captain start then.
//
//   boardRing(e) / inRing(P, e) / closingSpeed(P, e) / boardInfo(P, e) / boardProblem(P, e) / beatenWhy(e)
//   pickArchetype({key, n, last, night, gloam, navy}) → archetype id
//   createFight({e, P, ours, names, initiator, t, archetype}) → F      stepFight(F, h) → events
//   pistol(F, foeId) → {ok, reason?, dmg?, events}          rally(F, by) / setFocus(F, focus, by) → {ok, events}
//   fightState(F) → state.boardfight                        fightOver(F) → "struck" | "repelled" | null (after the beat)
//
// Pure: no three.js, no DOM, no Math.random.

import { BOARD, BOARD_FIGHT as BF, CLASSES, NAMED_LABEL, SHIP, CAPTAIN_NAMES, BOARD_FOCUS } from "./const.js";
import { dist, toLocal, forward, clamp, relBearing } from "./geom.js";
import { hashString } from "./rng.js";

const R1 = (v) => Math.round(v * 10) / 10;
const halfAxes = (e) => { const C = e?.C || CLASSES[e?.cls] || CLASSES.brig; return { hl: C.len / 2, hb: C.beam / 2 }; };

// ---- Who can be boarded, and from where -----------------------------------------------------

/** Why she can be boarded at all: "struck" | "hull" (≤ 25%) | "masts" (≤ 20%), or null while she's still fighting fit. */
export function beatenWhy(e) {
  if (!e) return null;
  if (e.state === "surrender") return "struck";
  if (e.hull / e.hullMax <= BOARD.hullFrac) return "hull";
  if (e.masts <= BOARD.mastsMax) return "masts";
  return null;
}

/** Her boarding ring: an ellipse round her hull, grown by BOARD.range (+ our half-beam). ax across her beam, az along her length. */
export function boardRing(e) {
  const { hl, hb } = halfAxes(e);
  const pad = BOARD.range + SHIP.beam / 2;
  return { x: R1(e.x), z: R1(e.z), heading: R1(e.heading || 0), ax: R1(hb + pad), az: R1(hl + pad) };
}

/** Is the Rexmaw inside her ring (her bow, waist or stern)? */
export function inRing(P, e) {
  if (!P || !e) return false;
  const { hl, hb } = halfAxes(e);
  const pad = BOARD.range + SHIP.beam / 2, ax = hb + pad, az = hl + pad;
  const f = forward(P.heading || 0);
  for (const k of [0, 1, -1]) {
    const l = toLocal(e.x, e.z, e.heading || 0, P.x + f.x * SHIP.half * k, P.z + f.z * SHIP.half * k);
    if ((l.lx / ax) ** 2 + (l.lz / az) ** 2 <= 1) return true;
  }
  return false;
}

/** How fast the Rexmaw is closing on her (m/s along the line between them, ≥ 0). */
export function closingSpeed(P, e) {
  const d = Math.max(1, dist(P.x, P.z, e.x, e.z));
  const ux = (e.x - P.x) / d, uz = (e.z - P.z) / d;
  return Math.max(0, ((P.vx || 0) - (e.vx || 0)) * ux + ((P.vz || 0) - (e.vz || 0)) * uz);
}

/** Hull to hull, roughly (m). */
const gapOf = (P, e) => Math.max(0, dist(P.x, P.z, e.x, e.z) - (SHIP.beam / 2 + halfAxes(e).hb));

/** Can she be boarded at all (afloat, a boardable class, not a derelict, not just thrown us off)? */
const boardableShip = (e) => !!e && !e.gone && !e.fixed && !e.derelict && e.state !== "sinking" && !!(e.C || CLASSES[e.cls])?.boardable;

/** The boarding picture for one ship: {eligible, why, gap, speedDiff, closing, inRing, inRange, problem, ring}. */
export function boardInfo(P, e) {
  const ok = boardableShip(e);
  const why = ok ? beatenWhy(e) : null;
  const ring = e ? inRing(P, e) : false;
  const problem = boardProblem(P, e);
  return {
    eligible: ok && !!why && !(e.boardLockT > 0), why, gap: e ? gapOf(P, e) : Infinity,
    speedDiff: e ? Math.abs((P.speed || 0) - (e.speed || 0)) : Infinity, closing: e ? closingSpeed(P, e) : 0,
    inRing: ring, inRange: !problem, problem, ring: e ? boardRing(e) : null,
  };
}

/** Why the Rexmaw can't board `e` right now, or null when one press of B would. */
export function boardProblem(P, e) {
  if (!e || e.gone || e.state === "sinking") return "there's no ship there to board";
  if (e.derelict) return "she's a derelict with nobody aboard: stop alongside to salvage her";
  const C = e.C || CLASSES[e.cls];
  if (e.fixed || !C?.boardable) return `a ${C?.label || "ship like that"} can't be boarded`;
  if (e.boardLockT > 0) return `she just threw us back: ${Math.ceil(e.boardLockT)} s before the grapples are ready again`;
  if (!beatenWhy(e)) return `the ${C.label} isn't beaten yet (hull ${Math.round((e.hull / e.hullMax) * 100)}%, masts ${Math.round(e.masts)}%: board at hull 25%, masts ${BOARD.mastsMax}% or when she strikes)`;
  if (!inRing(P, e)) return `she's ${Math.round(gapOf(P, e))} m off: sail into her ring (${BOARD.range} m of her hull)`;
  const c = closingSpeed(P, e);
  if (c >= BOARD.ramSpeed) return `we're closing at ${Math.round(c)} m/s, that's ramming speed: ease off (half sail) and grapple`;
  return null;
}

// ---- Captain archetypes -----------------------------------------------------------------------

/** Every captain archetype id ("normal" = the plain captain); the whacky ones; the odds of meeting one. */
export const ARCHETYPE_IDS = Object.freeze(["normal", "gulls", "admiral", "chef", "pip", "bubbles", "encore", "clackers", "mime", "pale"]);
export const WHACKY = Object.freeze(ARCHETYPE_IDS.filter((a) => a !== "normal"));
export const WHACKY_RATE = 0.35;

/**
 * The gimmicks' numbers (seconds, hit points, metres). `first` = seconds into the fight of the first one, `every` = the gap.
 */
export const GIMMICK = Object.freeze({
  gulls: Object.freeze({ n: 3, hp: 14, dmg: 1.6, acc: 0.55, swing: 0.8, speed: 1.35 }),
  admiral: Object.freeze({ first: 5, every: 12, sip: 3 }),
  chef: Object.freeze({ first: 3.5, every: 6.5, daze: 2 }),
  pip: Object.freeze({ tinyHp: 0.9, tinyDmg: 8, tinyAcc: 0.6, tinySwing: 1.35, pipHp: 30, run: 2.5 }),
  bubbles: Object.freeze({ shield: 40, regrow: 9, slipFirst: Object.freeze([5, 12]), slipEvery: Object.freeze([14, 22]), slipGap: 4, slip: 1.2, speed: 0.6 }),
  encore: Object.freeze({ first: 4, every: 11, aria: 5, heal: 3.5, r: 8 }),
  clackers: Object.freeze({ flank: 2, blockSay: 2.5 }),
  mime: Object.freeze({ first: 3, every: 7, stall: 2.5 }),
  pale: Object.freeze({ first: 6, every: 10, fade: 2.5, reassemble: 5, reHp: 0.5 }),
  monkey: Object.freeze({ hp: 12, dmg: 1.2, acc: 0.35, swing: 0.8, speed: 1.6, steal: Object.freeze([9, 13]), take: 0.06, min: 10 }),
});

/** Her crew's looks (the scene dresses them; the bubbles' chatter and the babble voice). */
export const CREW_VARIANTS = Object.freeze({
  sailor: Object.freeze({ label: "Sailor", lines: Object.freeze(["Arr!", "Have at you!", "Back to your own boat!", "For the captain!", "Repel boarders!"]) }),
  marine: Object.freeze({ label: "Marine", lines: Object.freeze(["Present arms!", "Fire at will! Who's Will?", "Hup!", "Sir, yes sir!", "Steady, lads!"]) }),
  cook: Object.freeze({ label: "Cook", lines: Object.freeze(["Yes, chef!", "Hot pan coming through!", "Mind the dough!", "Behind you!", "Who ordered the boarding?"]) }),
  monkey: Object.freeze({ label: "Monkey", lines: Object.freeze(["Ook!", "Ook ook!", "Eee!", "Shiny!", "Hee hee!"]) }),
  skeleton: Object.freeze({ label: "Skeleton", lines: Object.freeze(["*rattle*", "*clack clack*", "Brrr.", "*creak*", "Bones!"]) }),
  gull: Object.freeze({ label: "Gull", lines: Object.freeze(["Mine!", "Mine! Mine!", "Squawk!", "Chip?"]) }),
  tiny: Object.freeze({ label: "Tiny", lines: Object.freeze(["Okay, Pip.", "Tiny smash.", "Sorry about this.", "Pip says hit you.", "I'm not tiny."]) }),
});

/**
 * The captains. name/title/taunt (the fight HUD's intro card), pron (him/her/them), crew (their crew's look), cap (the
 * captain's hit points × and blows), prize (a loot drop on top of her hold), brief (the companion's fact), lines (the
 * speech bubbles: intro, idle, hurt, yield, and per gimmick moment).
 */
export const ARCHETYPES = Object.freeze({
  normal: Object.freeze({ id: "normal", name: null, title: "Her captain", taunt: "", pron: "him", crew: "sailor", cap: Object.freeze({ hp: 1 }), prize: null,
    brief: "",
    lines: Object.freeze({ intro: ["You'll hang for this!", "Cut them down!"], idle: ["Hold the line!", "Repel boarders!", "Cut them down!", "Is that a lobster?!"],
      hurt: ["Argh!", "Lucky shot!"], yield: ["Quarter! We yield!"] }) }),
  gulls: Object.freeze({ id: "gulls", name: "Captain Three-Gulls", title: "Definitely one captain", taunt: "We are ONE captain. A normal, human captain. Squawk.",
    pron: "them", crew: "sailor", cap: Object.freeze({ hp: 0.6 }), prize: Object.freeze({ item: "a coat full of feathers and three gold buttons", gold: 60 }),
    brief: "Their captain is Captain Three-Gulls: three seagulls stacked in a captain's coat. Knock the coat down and three gulls burst out; each must be shot (the Captain's pistol) or swatted by the crew before she strikes.",
    lines: Object.freeze({ intro: ["We are ONE captain. Squawk."], idle: ["Normal captain things!", "Hand over the chips. The… gold.", "Stop looking at the coat.", "Squawk. I mean: avast!", "Mine!"],
      hurt: ["Wobble! Wobble!", "Hold the coat together, Kevin!"], yield: ["We surrender. Separately."],
      coat_collapse: ["SCATTER!", "Every gull for himself!"], gull_down: ["Mine… no longer.", "Squaaawk…"] }) }),
  admiral: Object.freeze({ id: "admiral", name: "Admiral Fernsby-Whistle", title: "Of the Very Proper Navy", taunt: "Surrender at once. Or after tea. Preferably after tea.",
    pron: "him", crew: "marine", cap: Object.freeze({ hp: 0.9 }), prize: Object.freeze({ item: "a fine china tea set", gold: 120 }),
    brief: "Their captain is Admiral Fernsby-Whistle, a powdered-wig navy admiral who insists on tea: every 12 s his side stops fighting for 3 s while he sips, but his musket marines keep firing.",
    lines: Object.freeze({ intro: ["Surrender. Or after tea."], idle: ["Mind the wig!", "Marines! Look smart!", "This is most irregular.", "Pinkies out, gentlemen.", "Is that a LOBSTER?"],
      hurt: ["My wig!", "I say!"], yield: ["Very well. Do mind the china."],
      tea: ["One moment. Tea.", "Ahh. Darjeeling.", "Steady on, I'm steeping.", "Marines, carry on. I'm on break."] }) }),
  chef: Object.freeze({ id: "chef", name: "Cookie Mabel", title: "Terror of the Galley", taunt: "You're just in time for dessert. It's pie. It's flying.",
    pron: "her", crew: "cook", cap: Object.freeze({ hp: 0.9, dmg: 6 }), prize: Object.freeze({ item: "a crate of Cookie Mabel's pies", gold: 70 }),
    brief: "Their captain is Cookie Mabel, a galley chef with a frying pan and a ladle: she throws pies that daze one of ours for 2 s; her crew are cooks with rolling pins.",
    lines: Object.freeze({ intro: ["Dessert's flying!"], idle: ["Order up!", "Who wants seconds?!", "Eat your greens!", "Too much salt in this crew!", "Wipe your boots!"],
      hurt: ["My soufflé!", "Watch the pan!"], yield: ["Fine. But you're doing the dishes."],
      pie: ["Pie's up!", "Fresh from the oven!", "Catch!", "Lemon meringue, incoming!"] }) }),
  pip: Object.freeze({ id: "pip", name: "Peg-Leg Pip", title: "…and Tiny, his first mate", taunt: "Tiny! Show 'em why they call you Tiny!",
    pron: "him", crew: "sailor", cap: Object.freeze({ hp: 1 }), prize: Object.freeze({ item: "Pip's spare peg leg (solid mahogany)", gold: 80 }),
    brief: "Their captain is Peg-Leg Pip, riding the shoulders of his huge first mate Tiny: topple Tiny first, then Pip runs in circles until the crew catch him (the pistol can't hit him running).",
    lines: Object.freeze({ intro: ["Tiny! Get 'em!"], idle: ["Left, Tiny! No, YOUR left!", "Charge, Tiny! Gently!", "I'm the brains of this outfit!", "Higher, Tiny! I can't see!"],
      hurt: ["Ow! My good leg!"], yield: ["We yield. Tiny needs a nap."],
      tiny_down: ["Tiny?! TINY!", "Retreat! Every leg for itself!"], pip_runs: ["Can't catch me!", "Nyah nyah!", "Peg-leg sprint!", "Round and round!"],
      dodge: ["Missed me!", "Too quick!"], pip_caught: ["Put me down! I'm a captain!"] }) }),
  bubbles: Object.freeze({ id: "bubbles", name: "Baron Von Bubbles", title: "Of the Rolling Bath", taunt: "You dare interrupt bath time?",
    pron: "him", crew: "sailor", cap: Object.freeze({ hp: 0.8 }), prize: Object.freeze({ item: "a golden rubber duck", gold: 110 }),
    brief: "Their captain is Baron Von Bubbles, fighting from a rolling bathtub: a bubble shield blocks the crew's blows until the Captain's pistol pops it (it regrows in 9 s), and the soapy deck makes our crew slip now and then.",
    lines: Object.freeze({ intro: ["Bath time is SACRED!"], idle: ["Rubber duck, attack!", "Ahh, lavender.", "Scrub harder, men!", "Do not splash the Baron!", "Mind the soap!"],
      hurt: ["The water's getting cold!"], yield: ["Fine. Hand me a towel."],
      shield_up: ["Bubbles! Protect me!", "Lather up!"], shield_pop: ["My bubbles!", "How DARE you pop that!"], slip: ["Ha! Soapy!", "Wheee!"] }) }),
  encore: Object.freeze({ id: "encore", name: "Señor Encore", title: "The Singing Captain", taunt: "Bravo, bravo! And now… the aria!",
    pron: "him", crew: "sailor", cap: Object.freeze({ hp: 0.85 }), prize: Object.freeze({ item: "a jewelled tuning fork", gold: 100 }),
    brief: "Their captain is Señor Encore, an opera singer: his arias heal his crew (the floating notes) until the Captain's pistol hits him mid-song.",
    lines: Object.freeze({ intro: ["And now… the aria!"], idle: ["Mi-mi-mi-mi!", "Louder, my chorus!", "A tragedy in three acts!", "Applause! I hear no applause!"],
      hurt: ["My voice!"], yield: ["The curtain falls… Bravo."],
      aria: ["♪ Laaa-la-laaa! ♪", "♪ Rise, my crew, rise! ♪", "♪ Figaro! Figa-ro! ♪", "♪ Heal, my darlings! ♪"], aria_cut: ["Philistine!", "You stepped on my high note!"] }) }),
  clackers: Object.freeze({ id: "clackers", name: "Captain Clackers", title: "Rex's distant cousin", taunt: "Cousin Rex! Long time no sea!",
    pron: "him", crew: "sailor", cap: Object.freeze({ hp: 1.15 }), prize: Object.freeze({ item: "a pearl Captain Clackers kept in a claw", gold: 130 }),
    brief: "Their captain is Captain Clackers, a giant crab in a tricorn (claims to be Rex's distant cousin): from the front his claws block the Captain's pistol and half the crew's blows; flank him with two or more of ours (boarding_order captain) and everything lands.",
    lines: Object.freeze({ intro: ["Long time no sea, cousin!"], idle: ["Clack clack!", "Pinch first, ask later!", "Tell your Ma I said hello!", "Nobody gets past these claws!", "Sideways is the best way!"],
      hurt: ["My shell!"], yield: ["Alright, cousin. You win this one."],
      claw_block: ["Clack! Blocked!", "Not through these claws!", "Try the sides!"], flanked: ["Hey! Both sides is cheating!", "Who's behind me?!"] }) }),
  mime: Object.freeze({ id: "mime", name: "The Mime", title: "…", taunt: "…",
    pron: "them", crew: "sailor", cap: Object.freeze({ hp: 0.8 }), prize: Object.freeze({ item: "an invisible chest (it's very heavy)", gold: 90 }),
    brief: "Their captain is The Mime: silent, conjures invisible walls that stall one of ours for a few seconds at a time.",
    lines: Object.freeze({ intro: ["…"], idle: ["…", "…!", "…?", "……"], hurt: ["…!!"], yield: ["…"], wall: ["…", "…!"] }) }),
  pale: Object.freeze({ id: "pale", name: "The Pale Captain", title: "Ghost of the Gloam", taunt: "Cold hands, quiet decks. Welcome aboard.",
    pron: "him", crew: "skeleton", cap: Object.freeze({ hp: 0.9 }), prize: Object.freeze({ item: "a pale lantern that never goes out", gold: 140 }),
    brief: "Their captain is The Pale Captain, the Gloam's ghost: now and then he fades to mist (nothing hits him for a few seconds), and his skeleton crew get back up once after falling.",
    lines: Object.freeze({ intro: ["Welcome aboard."], idle: ["The fog keeps us.", "Rise, my crew.", "It's always cold here.", "Bones mend. Do yours?"],
      hurt: ["…the cold returns."], yield: ["The mist lifts. For now."],
      fade: ["You cannot strike mist.", "Gone…"], pass_through: ["Through me, not at me."], reassemble: ["Up again, lads.", "Bones mend."] }) }),
});

/**
 * Which captain this boarding meets: WHACKY_RATE of boardings (seeded by `key` and the boarding's number `n`) a whacky
 * one — never `last` again — else "normal". The admiral only on a navy ship; The Pale Captain only at night or on the Gloam's
 * mission.
 */
export function pickArchetype({ key = "", n = 0, last = null, night = false, gloam = false, navy = false } = {}) {
  const h = hashString(`${key}:${n}:captain`);
  if ((h % 1000) / 1000 >= WHACKY_RATE) return "normal";
  const can = WHACKY.filter((a) => a !== last && (a !== "admiral" || navy) && (a !== "pale" || night || gloam));
  if (!can.length) return "normal";
  return can[hashString(`${key}:${n}:which`) % can.length];
}

// ---- The deck fight -------------------------------------------------------------------------

/** A fixed jitter in [0, 1) for a fighter's n-th swing (the fight is the same every time it's played). */
const jit = (key, n) => (hashString(`${key}:${n}`) % 1000) / 1000;
const between = (r, u) => r[0] + (r[1] - r[0]) * u;

function fighter(side, id, stats, extra) {
  return { side, id, hp: stats.hp, max: stats.hp, dmg: stats.dmg, acc: stats.acc, swing: stats.swing, state: "fighting", target: null,
    x: 0, z: 0, act: "idle", actT: 0, cd: 0, accum: 0, n: 0, stun: 0, spd: 1, ...extra };
}

/**
 * Start a fight. e: her ship; P: the Rexmaw (which side of her we lie on); ours: our fighters' ids (rex|eve|ara|sal|leo|me);
 * names: {me: "Ada"} for the companion's figure; archetype: her captain (ARCHETYPE_IDS; run.js picks it with pickArchetype).
 */
export function createFight({ e, P, ours = [], names = {}, initiator = "rexmaw", t = 0, archetype = "normal" }) {
  const C = e.C || CLASSES[e.cls] || CLASSES.brig;
  const cls = e.cls;
  const L = C.len, B = C.beam;
  const side = P && relBearing(e.x, e.z, e.heading || 0, P.x, P.z) < 0 ? 1 : -1;   // + = we lie on her port side
  const key = `${e.id}:${e.name}`;
  const arch = ARCHETYPES[archetype] ? archetype : "normal";
  const A = ARCHETYPES[arch];
  const struck = e.state === "surrender";
  const crewF = e.crewMax ? clamp(e.crew / e.crewMax, 0, 1) : 1;
  const base = BF.foes[cls] ?? BF.foes.default;
  const n = clamp(base - (struck ? 2 : 0) - (crewF < 0.5 ? 2 : 0), 6, 12);
  // Her crew's look: the archetype's, else marines on a navy ship. The admiral brings one more musket; the cooks none.
  const look = arch === "normal" ? (C.navy ? "marine" : "sailor") : A.crew;
  const gun0 = BF.gunners[cls] ?? BF.gunners.default;
  const gunners = arch === "chef" ? 0 : Math.min(n - 2, gun0 + (arch === "admiral" ? 1 : 0));
  const foes = [];
  for (let i = 0; i < n; i++) {
    const kind = i < gunners ? "gunner" : "sailor";
    const f = fighter("foes", `f${i + 1}`, BF.foe[kind], { kind, look: look === "marine" && kind === "sailor" && arch === "normal" ? "sailor" : look, crew: true });
    const u = (i + 0.5) / n;
    f.z = R1((-0.36 + 0.72 * u + (jit(key, i) - 0.5) * 0.06) * L);
    f.x = R1(kind === "gunner" ? -side * B * 0.32 : (-side * 0.12 + (jit(key, i + 50) - 0.5) * 0.4) * B);
    f.accum = jit(key, i + 100) * 0.9;
    f.cd = 0.3 + jit(key, i + 200) * 0.6;
    foes.push(f);
  }
  // Monkeys: Pip's and the Baron's pets; a plain merchant's now and then. Fast, they don't fight: they pocket loot.
  const monkeys = arch === "pip" || arch === "bubbles" ? 2 : arch === "normal" && cls === "merchant" && jit(key, 900) < 0.3 ? 2 : 0;
  const MK = GIMMICK.monkey;
  for (let i = 0; i < monkeys; i++) {
    const m = fighter("foes", `f${n + i + 1}`, MK, { kind: "monkey", look: "monkey", spd: MK.speed, ph: jit(key, 950 + i) * 6.28 });
    m.x = R1(-side * B * 0.1); m.z = R1((i ? 0.18 : -0.12) * L);
    m.stealT = between(MK.steal, jit(key, 960 + i));
    foes.push(m);
  }
  const capName = A.name || CAPTAIN_NAMES[hashString(key) % CAPTAIN_NAMES.length];
  const capHp = Math.round((BF.captainHp[cls] ?? BF.captainHp.default) * (A.cap.hp ?? 1));
  const ourList = [];
  ours.forEach((id, i) => {
    const st = BF.ours[id] || BF.ours.me;
    const o = fighter("ours", id, st, { name: names[id] || NAMED_LABEL[id] || id, kind: id });
    o.x = R1(side * (B / 2 + 3));
    o.z = R1((-0.3 + 0.6 * ((i + 0.5) / Math.max(1, ours.length))) * L);
    o.accum = jit(key, i + 300) * 0.9;
    o.cd = 0.2 + jit(key, i + 400) * 0.5;
    o.act = "move";
    ourList.push(o);
  });
  ourList.forEach((o, i) => { o.slipT = between(GIMMICK.bubbles.slipFirst, jit(key, 500 + i)); });
  const F = {
    enemyId: e.id, enemyName: e.name, cls, initiator, t: 0, t0: t, phase: "grapple", phaseT: 0, focus: "crew", key,
    arch, whacky: arch !== "normal", look,
    deck: { len: L, beam: B, side }, ours: ourList, foes, nonCaptain: n,
    captain: { present: false, hp: capHp, max: capHp, name: capName, id: "cap" },
    pistol: { cooldown: 0, max: BF.pistol.cooldown }, rally: { used: false, burst: 0 },
    loot: e.loot || 0, stolen: 0, prize: A.prize ? { ...A.prize } : null, result: null, log: [],
    // The gimmick's clocks and state (see stepGimmick).
    G: { next: GIMMICK[arch]?.first ?? 0, k: 0, tea: 0, aria: 0, fade: 0, told: -99, shield: arch === "bubbles" ? { up: true, hp: GIMMICK.bubbles.shield, max: GIMMICK.bubbles.shield, t: 0 } : null,
      riding: arch === "pip", running: false, collapsed: false, flanked: false, flankT: -99, blockN: 0, blockT: -99, lastSlip: -99, walls: [] },
  };
  return F;
}

/** A gimmick moment: `boardfight {stage: "gimmick", archetype, what, …}`. */
const gimmick = (F, ev, what, extra = {}) => ev.push({ stage: "gimmick", archetype: F.arch, what, ...extra });

function spawnCaptain(F, ev) {
  if (F.captain.present) return;
  const A = ARCHETYPES[F.arch];
  const stats = { ...BF.foe.captain, hp: F.captain.max, ...(A.cap.dmg ? { dmg: A.cap.dmg } : {}) };
  const c = fighter("foes", "cap", stats, { kind: "captain", name: F.captain.name, look: F.arch });
  c.x = 0; c.z = R1(-0.32 * F.deck.len); c.accum = 0.5; c.cd = 1;
  if (F.arch === "bubbles") c.spd = GIMMICK.bubbles.speed;
  if (F.arch === "pip") {
    // Pip (tiny, never fights) rides on Tiny's shoulders: Tiny takes the blows until he's toppled.
    const PP = GIMMICK.pip;
    c.hp = c.max = PP.pipHp; c.dmg = 0; c.riding = true;
    const tiny = fighter("foes", "tiny", { hp: Math.round(F.captain.max * PP.tinyHp), dmg: PP.tinyDmg, acc: PP.tinyAcc, swing: PP.tinySwing },
      { kind: "mate", name: "Tiny", look: "tiny", accum: 0.4, cd: 1.2 });
    tiny.x = c.x; tiny.z = c.z;
    F.foes.push(tiny);
    F.captain.max = c.max;
  }
  F.foes.push(c);
  F.captain.present = true;
  F.captain.hp = c.hp;
  const s = capShow(F);
  ev.push({ stage: "captain", archetype: F.arch, name: F.captain.name, title: A.title, hp: Math.round(s.hp), max: s.max, x: c.x, z: c.z });
}

const alive = (f) => f && f.state === "fighting";
const byId = (F, id) => F.ours.find((o) => o.id === id) || F.foes.find((f) => f.id === id) || null;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const capOf = (F) => F.foes.find((f) => f.kind === "captain") || null;
/** Can our crew go for this foe (Pip up on Tiny's shoulders can't be reached)? */
const targetable = (f) => alive(f) && !f.riding;
/** The one the crew go for on "captain": her captain, Tiny while Pip rides, a gull once the coat's down. */
function bossOf(F) {
  const cap = capOf(F);
  if (cap && alive(cap)) return cap.riding ? F.foes.find((f) => f.id === "tiny" && alive(f)) || null : cap;
  return F.G.collapsed ? F.foes.find((f) => f.kind === "gull" && alive(f)) || null : null;
}
/** The captain's bar: Tiny + Pip together; the gulls' hit points once the coat's down. */
function capShow(F) {
  const cap = capOf(F);
  if (F.arch === "pip" && cap) { const tiny = F.foes.find((f) => f.id === "tiny"); return { hp: (tiny ? tiny.hp : 0) + cap.hp, max: (tiny ? tiny.max : 0) + cap.max }; }
  if (F.arch === "gulls" && F.G.collapsed) { const g = F.foes.filter((f) => f.kind === "gull"); return { hp: g.reduce((s, f) => s + f.hp, 0), max: g.reduce((s, f) => s + f.max, 0) }; }
  return { hp: cap ? cap.hp : F.captain.hp, max: cap ? cap.max : F.captain.max };
}

/** Our fighters' targets, by the focus. */
function pickOurs(F) {
  const live = F.foes.filter(targetable);
  const cap = bossOf(F);
  const on = (f) => F.ours.filter((o) => alive(o) && o.target === f.id).length;
  for (const o of F.ours) {
    if (!alive(o)) { o.target = null; continue; }
    let t = o.target ? byId(F, o.target) : null;
    if (!targetable(t)) t = null;
    if (F.focus === "captain" && cap && t !== cap && on(cap) < BF.packOnCaptain) t = cap;
    if (F.focus === "defend" && t && t.target !== o.id && d2(o, t) > 4) t = null;
    if (!t) {
      if (F.focus === "defend") {
        const mine = live.filter((f) => f.target === o.id || d2(o, f) <= 4).sort((a, b) => d2(o, a) - d2(o, b));
        t = mine[0] || null;
      } else if (F.focus === "captain" && cap && on(cap) < BF.packOnCaptain) t = cap;
      else {
        const crew = live.filter((f) => f.kind !== "captain");
        const pool = crew.length ? crew : live;
        t = pool.slice().sort((a, b) => on(a) - on(b) || d2(o, a) - d2(o, b))[0] || null;
      }
    }
    o.target = t ? t.id : null;
  }
}

/** Their fighters' targets: the one of ours fewest are on (the captain goes for our strongest). */
function pickFoes(F) {
  const live = F.ours.filter(alive);
  const on = (o) => F.foes.filter((f) => alive(f) && f.target === o.id).length;
  for (const f of F.foes) {
    // Monkeys don't fight (they're after the loot); Pip doesn't either (he gives the orders, then he runs).
    if (!alive(f) || f.kind === "monkey" || (f.kind === "captain" && F.arch === "pip")) { f.target = null; continue; }
    const t = f.target ? byId(F, f.target) : null;
    if (alive(t)) continue;
    let pick = null;
    if (f.kind === "captain" || f.kind === "mate") pick = live.slice().sort((a, b) => b.hp - a.hp)[0] || null;
    else pick = live.slice().sort((a, b) => on(a) - on(b) || d2(f, a) - d2(f, b))[0] || null;
    f.target = pick ? pick.id : null;
  }
}

function setAct(f, act) { if (f.act !== act || act === "swing" || act === "hurt") { f.act = act; f.actT = 0; } }

/** One blow: damage, the hurt flinch, a knockdown. False when a gimmick took it (its event says how). */
function strike(F, a, b, dmg, ev, { pistol = false } = {}) {
  const got = guard(F, a, b, dmg, ev, pistol);
  if (got == null) return false;
  dmg = got;
  b.hp = Math.max(0, b.hp - dmg);
  ev.push({ stage: "hit", by: pistol ? "pistol" : a.id, target: b.id, dmg: R1(dmg), side: pistol ? "ours" : a.side, pistol: pistol || undefined, x: b.x, z: b.z });
  if (b.hp <= 0) {
    b.state = "down"; b.target = null; setAct(b, "down");
    if (b.kind === "captain") F.captain.hp = 0;
    ev.push({ stage: "down", id: b.id, side: b.side, kind: b.kind, by: pistol ? "pistol" : a.id, x: b.x, z: b.z });
    fell(F, b, ev);
  } else setAct(b, "hurt");
  if (b.kind === "captain") F.captain.hp = b.hp;
  return true;
}

/** Is her captain flanked (two or more of ours on him, within reach)? */
const flanked = (F, cap) => F.ours.filter((o) => alive(o) && o.target === cap.id && d2(o, cap) <= BF.reach + 0.6).length >= GIMMICK.clackers.flank;

/** The gimmicks that turn a blow aside: the dmg that lands, or null (absorbed; a gimmick event says so). */
function guard(F, a, b, dmg, ev, pistol) {
  const G = F.G;
  if (b.kind === "captain") {
    if (G.shield?.up) {
      // The Baron's bubbles: the pistol pops them at once; the crew's blows wear them down.
      if (!pistol) G.shield.hp -= dmg;
      if (pistol || G.shield.hp <= 0) {
        G.shield.up = false; G.shield.hp = 0; G.shield.t = GIMMICK.bubbles.regrow;
        gimmick(F, ev, "shield_pop", { by: pistol ? "pistol" : a.id, target: b.id, pistol: pistol || undefined });
      }
      return null;
    }
    if (F.arch === "clackers" && !flanked(F, b)) {
      // His claws: the pistol from the front never gets through; every other blow from a lone fighter is clacked aside.
      G.blockN++;
      if (pistol || G.blockN % 2 === 1) {
        if (pistol || F.t - G.blockT >= GIMMICK.clackers.blockSay) { G.blockT = F.t; gimmick(F, ev, "claw_block", { by: pistol ? "pistol" : a.id, target: b.id, pistol: pistol || undefined }); }
        return null;
      }
    }
    if (G.fade > 0) {
      // The Pale Captain is mist: blows and shot pass through.
      if (pistol || G.told < G.fadeN) { G.told = G.fadeN; gimmick(F, ev, "pass_through", { by: pistol ? "pistol" : a.id, target: b.id, pistol: pistol || undefined }); }
      return null;
    }
    if (G.running && pistol) { gimmick(F, ev, "dodge", { target: b.id, pistol: true }); return null; }
  }
  return dmg;
}

/** Someone of hers fell: the gimmicks that follow (the coat collapses, Tiny topples, Pip's caught, bones wait to rise). */
function fell(F, b, ev) {
  const G = F.G;
  if (b.kind === "captain" && F.arch === "gulls" && !G.collapsed) {
    // The coat collapses and three gulls burst out of it.
    G.collapsed = true;
    const GG = GIMMICK.gulls, ids = [];
    for (let i = 0; i < GG.n; i++) {
      const g = fighter("foes", `g${i + 1}`, { hp: GG.hp, dmg: GG.dmg, acc: GG.acc, swing: GG.swing }, { kind: "gull", look: "gull", spd: GG.speed, name: "Gull" });
      const a = (i / GG.n) * Math.PI * 2;
      g.x = R1(b.x + Math.cos(a) * 0.6); g.z = R1(b.z + Math.sin(a) * 0.6);
      g.accum = jit(F.key, 700 + i) * 0.6; g.cd = 0.8 + 0.3 * i;
      F.foes.push(g); ids.push(g.id);
    }
    gimmick(F, ev, "coat_collapse", { ids, x: b.x, z: b.z });
  } else if (b.kind === "gull") {
    gimmick(F, ev, "gull_down", { id: b.id, left: F.foes.filter((f) => f.kind === "gull" && alive(f)).length });
  } else if (b.id === "tiny") {
    const pip = capOf(F);
    G.riding = false;
    gimmick(F, ev, "tiny_down", { id: b.id });
    if (pip && alive(pip)) {
      pip.riding = false; G.running = true;
      G.ang = Math.atan2(pip.z, pip.x);
      gimmick(F, ev, "pip_runs", { id: pip.id });
    }
  } else if (b.kind === "captain" && F.arch === "pip") {
    G.running = false;
    gimmick(F, ev, "pip_caught", { id: b.id });
  } else if (b.look === "skeleton" && !b.rose) {
    b.reT = GIMMICK.pale.reassemble;
  } else if (b.kind === "monkey" && !b.fled) {
    gimmick(F, ev, "monkey_swat", { id: b.id });
  }
}

/** Her side stands still: tea break (all but the musket marines), the aria (the singer), Pip riding or running, the monkeys. */
function held(F, f) {
  if (f.side !== "foes") return false;
  if (F.G.tea > 0 && f.kind !== "gunner") return true;
  if (f.kind === "captain" && (F.G.aria > 0 || F.arch === "pip")) return true;
  return f.kind === "monkey";
}

function clampDeck(F, f) {
  const hb = F.deck.beam / 2 - 0.5, hl = F.deck.len / 2 - 1;
  f.x = clamp(f.x, -hb, hb); f.z = clamp(f.z, -hl, hl);
}

function moveToward(f, tx, tz, want, h) {
  const dx = tx - f.x, dz = tz - f.z, d = Math.hypot(dx, dz);
  if (d <= want + 1e-3) return false;
  const s = Math.min(BF.move * (f.spd || 1) * h, d - want);
  f.x += (dx / d) * s; f.z += (dz / d) * s;
  return true;
}

/** The ones of ours a gimmick can catch (up, not already dazed / slipping / walled), in a fixed order. */
const catchable = (F) => F.ours.filter((o) => alive(o) && !(o.stun > 0));

/** The gimmicks' clocks, once a step of the fight (before the blows). */
function stepGimmick(F, h, ev) {
  const G = F.G, T = F.phaseT, cap = capOf(F), capUp = cap && alive(cap);
  for (const o of F.ours) if (o.stun > 0) { o.stun = Math.max(0, o.stun - h); if (!o.stun && alive(o)) setAct(o, "idle"); }
  switch (F.arch) {
    case "admiral": {
      const K = GIMMICK.admiral;
      if (G.tea > 0) { G.tea = Math.max(0, G.tea - h); if (!G.tea) { if (capUp) setAct(cap, "idle"); gimmick(F, ev, "tea_over"); } }
      else if (T >= G.next) {
        G.next += K.every;
        if (capUp) { G.tea = K.sip; setAct(cap, "tea"); for (const f of F.foes) if (alive(f) && f.kind !== "gunner" && f !== cap) setAct(f, "idle"); gimmick(F, ev, "tea", { id: cap.id, seconds: K.sip }); }
      }
      break;
    }
    case "chef": {
      const K = GIMMICK.chef;
      if (T < G.next) break;
      G.next += K.every;
      const c = catchable(F);
      if (!capUp || !c.length) break;
      const o = c.slice().sort((a, b) => b.hp - a.hp || (a.id < b.id ? -1 : 1))[G.k++ % Math.min(2, c.length)];
      o.stun = K.daze; setAct(o, "dazed"); setAct(cap, "throw");
      gimmick(F, ev, "pie", { id: cap.id, target: o.id, x: cap.x, z: cap.z, tx: o.x, tz: o.z, seconds: K.daze });
      break;
    }
    case "pip": {
      if (!capUp) break;
      if (G.riding) { const tiny = F.foes.find((f) => f.id === "tiny"); if (tiny) { cap.x = tiny.x; cap.z = tiny.z; } }
      else if (G.running) {
        // Round and round her waist (a little slower than ours: they catch him).
        const r = Math.max(2, Math.min(F.deck.beam * 0.3, F.deck.len * 0.2));
        G.ang = (G.ang ?? 0) + (GIMMICK.pip.run / r) * h;
        cap.x = R1(Math.cos(G.ang) * r * 0.8); cap.z = R1(F.deck.len * 0.04 + Math.sin(G.ang) * r);
        clampDeck(F, cap);
        setAct(cap, "run");
      }
      break;
    }
    case "bubbles": {
      const K = GIMMICK.bubbles;
      if (G.shield && !G.shield.up && capUp) {
        G.shield.t -= h;
        if (G.shield.t <= 0) { G.shield.up = true; G.shield.hp = G.shield.max; gimmick(F, ev, "shield_up", { id: cap.id }); }
      }
      // The soapy deck: now and then one of ours goes over (never two inside SLIP_GAP s).
      F.ours.forEach((o, i) => {
        if (!alive(o) || o.stun > 0) return;
        o.slipT -= h;
        if (o.slipT > 0) return;
        if (F.t - G.lastSlip < K.slipGap) { o.slipT = 0.5; return; }
        o.slipT = between(K.slipEvery, jit(F.key, 520 + i * 7 + (o.slips = (o.slips || 0) + 1)));
        o.stun = K.slip; G.lastSlip = F.t; setAct(o, "slip");
        gimmick(F, ev, "slip", { target: o.id, x: o.x, z: o.z });
      });
      break;
    }
    case "encore": {
      const K = GIMMICK.encore;
      if (G.aria > 0) {
        G.aria = Math.max(0, G.aria - h);
        if (capUp) for (const f of F.foes) if (alive(f) && f !== cap && d2(f, cap) <= K.r) f.hp = Math.min(f.max, f.hp + K.heal * h);
        if (!G.aria) { if (capUp) setAct(cap, "idle"); gimmick(F, ev, "aria_end"); }
      } else if (T >= G.next) {
        G.next += K.every;
        if (capUp) { G.aria = K.aria; setAct(cap, "sing"); gimmick(F, ev, "aria", { id: cap.id, seconds: K.aria, r: K.r }); }
      }
      break;
    }
    case "clackers": {
      if (!capUp) break;
      const fl = flanked(F, cap);
      if (fl && !G.flanked && F.t - G.flankT > 4) { G.flankT = F.t; gimmick(F, ev, "flanked", { id: cap.id }); }
      G.flanked = fl;
      break;
    }
    case "mime": {
      const K = GIMMICK.mime;
      G.walls = G.walls.filter((w) => (w.t -= h) > 0);
      if (T < G.next) break;
      G.next += K.every;
      const c = catchable(F);
      if (!capUp || !c.length) break;
      const o = c[G.k++ % c.length];
      const tg = o.target ? byId(F, o.target) : cap;
      const dx = (tg ? tg.x : cap.x) - o.x, dz = (tg ? tg.z : cap.z) - o.z, d = Math.hypot(dx, dz) || 1;
      const w = { x: R1(o.x + (dx / d) * 0.8), z: R1(o.z + (dz / d) * 0.8), yaw: R1(Math.atan2(dx, dz)), target: o.id, t: K.stall };
      G.walls.push(w);
      o.stun = K.stall; setAct(o, "walled"); setAct(cap, "mime");
      gimmick(F, ev, "wall", { id: cap.id, target: o.id, x: w.x, z: w.z, yaw: w.yaw, seconds: K.stall });
      break;
    }
    case "pale": {
      const K = GIMMICK.pale;
      if (G.fade > 0) { G.fade = Math.max(0, G.fade - h); if (!G.fade) { if (capUp) setAct(cap, "idle"); gimmick(F, ev, "fade_end"); } }
      else if (T >= G.next) {
        G.next += K.every;
        if (capUp) { G.fade = K.fade; G.fadeN = (G.fadeN || 0) + 1; setAct(cap, "fade"); gimmick(F, ev, "fade", { id: cap.id, seconds: K.fade }); }
      }
      break;
    }
    default: break;
  }
  // Bones get back up, once.
  for (const f of F.foes) {
    if (f.reT > 0 && f.state === "down") {
      f.reT -= h;
      if (f.reT <= 0) { f.reT = 0; f.rose = true; f.state = "fighting"; f.hp = Math.round(f.max * GIMMICK.pale.reHp); setAct(f, "idle"); f.cd = 0.8; gimmick(F, ev, "reassemble", { id: f.id, x: f.x, z: f.z }); }
    }
  }
  // The monkeys scamper about; one still loose when its moment comes pockets some of the prize and is off up the rigging.
  const MK = GIMMICK.monkey;
  for (const m of F.foes) {
    if (m.kind !== "monkey" || !alive(m)) continue;
    m.ph += h * 0.9;
    const tx = -F.deck.side * F.deck.beam * 0.12 + Math.sin(m.ph * 1.7) * F.deck.beam * 0.22, tz = Math.cos(m.ph) * F.deck.len * 0.26;
    if (moveToward(m, tx, tz, 0.2, h)) setAct(m, "move");
    clampDeck(F, m);
    m.stealT -= h;
    if (m.stealT <= 0) {
      const gold = Math.max(MK.min, Math.round(F.loot * MK.take));
      F.stolen += gold;
      m.state = "down"; m.fled = true; m.target = null; setAct(m, "fled");
      gimmick(F, ev, "monkey_steal", { id: m.id, gold, x: m.x, z: m.z });
    }
  }
}

/** Step the fight `h` s. → events (boardfight payloads without the enemy id). */
export function stepFight(F, h) {
  const ev = [];
  if (!F || !(h > 0)) return ev;
  F.t += h; F.phaseT += h;
  for (const f of [...F.ours, ...F.foes]) {
    f.actT += h;
    if ((f.act === "swing" || f.act === "hurt") && f.actT > 0.6 && f.state === "fighting") { f.act = "idle"; f.actT = 0; }
  }
  F.pistol.cooldown = Math.max(0, F.pistol.cooldown - h);
  F.rally.burst = Math.max(0, F.rally.burst - h);
  const side = F.deck.side, B = F.deck.beam;
  if (F.phase === "grapple") {
    // The grapples bite and our crew swing across onto her rail.
    const rail = side * (B / 2 - 0.8);
    for (const o of F.ours) { o.x += (rail - o.x) * Math.min(1, h * 2.2); setAct(o, "move"); }
    if (F.phaseT >= BF.grappleS) {
      F.phase = "fight"; F.phaseT = 0;
      for (const o of F.ours) { o.x = R1(rail); setAct(o, "idle"); }
    }
    return ev;
  }
  if (F.phase === "struck" || F.phase === "repelled") return ev;

  // Ara binds the wounds of whoever's fighting near her.
  const ara = F.ours.find((o) => o.id === "ara" && alive(o));
  if (ara) {
    const k = F.focus === "defend" ? BF.defend.healMul : 1;
    for (const o of F.ours) if (alive(o) && o.hp < o.max * BF.heal.below && d2(ara, o) <= BF.heal.r) o.hp = Math.min(o.max, o.hp + BF.heal.perS * k * h);
  }
  stepGimmick(F, h, ev);
  pickOurs(F);
  pickFoes(F);
  const railX = side * (B / 2 - 0.8), holdX = side * (B / 2 - 3.5);
  for (const f of [...F.ours, ...F.foes]) {
    if (!alive(f)) continue;
    f.cd = Math.max(0, f.cd - h);
    // Dazed by a pie, gone over on the soap, pressed against a wall that isn't there; tea; the aria.
    if (f.stun > 0 || held(F, f)) continue;
    const t = f.target ? byId(F, f.target) : null;
    if (!alive(t)) {
      if (f.side === "ours" && F.focus === "defend") { if (moveToward(f, railX, f.z, 0.2, h)) setAct(f, "move"); }
      else if (f.act === "move") setAct(f, "idle");
      continue;
    }
    const gun = f.kind === "gunner";
    const want = gun ? BF.gunnerRange * 0.8 : BF.reach * 0.85;
    let moved = moveToward(f, t.x, t.z, want, h);
    if (f.side === "ours" && F.focus === "defend") {
      // Holding the rail: they don't chase past it.
      const lim = side > 0 ? Math.max(f.x, holdX) : Math.min(f.x, holdX);
      if (lim !== f.x) { f.x = lim; moved = false; }
    }
    clampDeck(F, f);
    const reach = gun ? BF.gunnerRange : BF.reach + 0.25;
    if (moved && d2(f, t) > reach) { setAct(f, "move"); continue; }
    if (d2(f, t) > reach || f.cd > 0) { if (f.act === "move") setAct(f, "idle"); continue; }
    // A swing (or a pistol shot from a gunner).
    const burst = f.side === "ours" && F.rally.burst > 0;
    f.n++;
    f.cd = f.swing * (0.85 + 0.3 * jit(`${F.key}:${f.id}`, f.n)) * (burst ? BF.rally.swingMul : 1);
    setAct(f, "swing");
    f.accum += f.acc;
    if (f.accum < 1) continue;
    f.accum -= 1;
    let dmg = f.dmg * (burst ? BF.rally.mul : 1);
    if (F.focus === "defend") dmg *= f.side === "ours" ? BF.defend.dealt : BF.defend.taken;
    strike(F, f, t, dmg, ev);
  }
  // Her captain comes on deck when half her crew is down.
  const crewDown = F.foes.filter((f) => f.crew && f.state === "down").length;
  const half = crewDown >= Math.ceil(F.nonCaptain / 2) || !F.foes.some((f) => f.crew && alive(f));
  if (!F.captain.present && (half || !F.foes.some(alive))) spawnCaptain(F, ev);
  // The end: her captain down (and, for Three-Gulls, every gull out of the coat).
  const cap = capOf(F);
  const oursUp = F.ours.filter(alive).length;
  let over = null;
  if (cap && cap.state === "down" && !(F.arch === "gulls" && F.foes.some((f) => f.kind === "gull" && alive(f)))) over = "struck";
  else if (!oursUp) over = "repelled";
  else if (F.t > BF.maxS) over = "struck";
  if (over) endFight(F, over, ev);
  return ev;
}

function endFight(F, result, ev) {
  F.phase = result; F.phaseT = 0; F.result = result;
  for (const o of F.ours) { o.target = null; if (alive(o)) setAct(o, result === "struck" ? "cheer" : "idle"); }
  for (const f of F.foes) { f.target = null; f.stun = 0; if (alive(f)) setAct(f, result === "struck" ? "yield" : "cheer"); }
  F.G.tea = F.G.aria = F.G.fade = 0; F.G.walls = [];
  if (result === "struck") {
    ev.push({ stage: result, archetype: F.arch, t: R1(F.t), loot: Math.max(0, F.loot - F.stolen) + (F.prize?.gold || 0), ammo: { ...BOARD.winAmmo }, hands: BOARD.winHands,
      prize: F.prize ? { ...F.prize } : undefined, stolen: F.stolen || undefined });
  } else {
    F.handsLost = BOARD.loseHands[0] + (hashString(`${F.key}:lost`) % (BOARD.loseHands[1] - BOARD.loseHands[0] + 1));
    ev.push({ stage: result, archetype: F.arch, t: R1(F.t), handsLost: F.handsLost });
  }
}

/** The fight is over and its beat has played: "struck" | "repelled", else null. */
export const fightOver = (F) => (F && (F.phase === "struck" || F.phase === "repelled") && F.phaseT >= BF.endS ? F.phase : null);

/** The Captain's pistol at one of her crew: never misses, 1.2 s to reload. */
export function pistol(F, foeId) {
  const ev = [];
  if (!F) return { ok: false, reason: "we're not boarding anyone", events: ev };
  if (F.phase !== "fight") return { ok: false, reason: F.phase === "grapple" ? "the grapples are still flying" : "the fight's over", events: ev };
  if (F.pistol.cooldown > 0) return { ok: false, reason: `reloading (${F.pistol.cooldown.toFixed(1)} s)`, events: ev };
  let f = F.foes.find((x) => x.id === foeId);
  if (!alive(f)) return { ok: false, reason: "no one standing there", events: ev };
  // Pip up on Tiny's shoulders: the shot takes Tiny.
  if (f.riding) f = F.foes.find((x) => x.id === "tiny" && alive(x)) || f;
  F.pistol.cooldown = BF.pistol.cooldown;
  const landed = strike(F, { id: "pistol", side: "ours" }, f, BF.pistol.dmg, ev, { pistol: true });
  // Señor Encore hit mid-aria: the song's cut.
  if (landed && f.kind === "captain" && F.G.aria > 0) {
    F.G.aria = 0; F.G.next = Math.max(F.G.next, F.phaseT + GIMMICK.encore.every * 0.6);
    if (alive(f)) setAct(f, "hurt");
    gimmick(F, ev, "aria_cut", { id: f.id, pistol: true });
  }
  return { ok: true, dmg: landed ? BF.pistol.dmg : 0, events: ev };
}

/** Rally (once a fight): everyone still up heals and fights harder for a few seconds. */
export function rally(F, by = "captain") {
  const ev = [];
  if (!F || (F.phase !== "fight" && F.phase !== "grapple")) return { ok: false, reason: "not now", events: ev };
  if (F.rally.used) return { ok: false, reason: "they've rallied once already", events: ev };
  F.rally.used = true; F.rally.burst = BF.rally.s; F.rally.by = by;
  for (const o of F.ours) if (alive(o)) { o.hp = Math.min(o.max, o.hp + o.max * BF.rally.heal); setAct(o, "cheer"); }
  ev.push({ stage: "rally", by });
  return { ok: true, events: ev };
}

/** The crew's focus: captain (up to three on her captain), crew (paired duels), defend (hold the rail, take less, deal less). */
export function setFocus(F, focus, by = "captain") {
  const ev = [];
  if (!F || !BOARD_FOCUS.includes(focus)) return { ok: false, reason: "not a focus", events: ev };
  if (F.phase === "struck" || F.phase === "repelled") return { ok: false, reason: "the fight's over", events: ev };
  const same = F.focus === focus;
  F.focus = focus; F.focusBy = by;
  if (!same) for (const o of F.ours) if (focus !== "crew") o.target = null;
  ev.push({ stage: "order", focus, by, same: same || undefined });
  return { ok: true, same, events: ev };
}

/** state.boardfight: the fight, rounded for the scene, the avatars and the HUD. */
export function fightState(F) {
  if (!F) return null;
  const out = (f) => ({ id: f.id, kind: f.kind, look: f.look || undefined, name: f.name, hp: R1(f.hp), max: f.max, state: f.state, target: f.target, x: R1(f.x), z: R1(f.z),
    act: f.act, actT: R1(f.actT), stun: f.stun > 0 ? R1(f.stun) : undefined, riding: f.riding || undefined, fled: f.fled || undefined });
  const A = ARCHETYPES[F.arch], G = F.G;
  const show = capShow(F);
  return {
    enemyId: F.enemyId, enemyName: F.enemyName, cls: F.cls, initiator: F.initiator, t: R1(F.t), phase: F.phase, phaseT: R1(F.phaseT), focus: F.focus,
    archetype: F.arch, crewLook: F.look,
    deck: { ...F.deck }, ours: F.ours.map(out), foes: F.foes.map(out),
    captain: { present: F.captain.present, hp: R1(show.hp), max: show.max, name: F.captain.name, id: "cap", archetype: F.arch, title: A.title, taunt: A.taunt,
      status: capStatus(F) },
    gimmick: { tea: R1(G.tea), aria: R1(G.aria), fade: R1(G.fade), shield: G.shield ? { up: G.shield.up, hp: R1(Math.max(0, G.shield.hp)), max: G.shield.max } : null,
      riding: F.arch === "pip" ? G.riding : undefined, running: G.running || undefined, collapsed: G.collapsed || undefined, flanked: G.flanked || undefined,
      walls: G.walls.map((w) => ({ x: w.x, z: w.z, yaw: w.yaw, target: w.target, t: R1(w.t) })), stolen: F.stolen || 0 },
    pistol: { cooldown: R1(F.pistol.cooldown), max: F.pistol.max }, rally: { used: F.rally.used, burst: R1(F.rally.burst) },
    foesTotal: F.foes.length + (F.captain.present ? 0 : 1), foesLeft: F.foes.filter(alive).length + (F.captain.present ? 0 : 1), oursUp: F.ours.filter(alive).length,
    endIn: F.phase === "struck" || F.phase === "repelled" ? R1(Math.max(0, BF.endS - F.phaseT)) : null,
  };
}

/** What her captain's gimmick is doing now, in a few words (the HUD under his bar; the companion's line). */
function capStatus(F) {
  const G = F.G, cap = capOf(F);
  if (!F.whacky || F.phase === "struck" || F.phase === "repelled") return "";
  switch (F.arch) {
    case "gulls": return G.collapsed ? `${F.foes.filter((f) => f.kind === "gull" && alive(f)).length} gulls loose: shoot or swat them` : "knock the coat down";
    case "admiral": return G.tea > 0 ? "tea break (his marines keep firing)" : "stops for tea every 12 s";
    case "chef": return "throws pies (2 s daze)";
    case "pip": return G.riding ? "riding Tiny: topple Tiny first" : G.running ? "running in circles: catch him!" : "";
    case "bubbles": return G.shield?.up ? "bubble shield up: pistol pops it" : cap && alive(cap) ? `shield down (back in ${Math.ceil(G.shield?.t || 0)} s)` : "";
    case "encore": return G.aria > 0 ? "singing (healing his crew): pistol him!" : "sings arias that heal his crew";
    case "clackers": return G.flanked ? "flanked: everything lands" : "claws block the front: flank him";
    case "mime": return "conjures invisible walls";
    case "pale": return G.fade > 0 ? "faded to mist: nothing hits" : "fades to mist; skeletons rise once";
    default: return "";
  }
}

/** The fight in one line of facts (the companion's brief). */
export function fightLine(F) {
  const s = fightState(F);
  const ours = s.ours.map((o) => `${o.name} ${o.state === "down" ? "down" : `${Math.round((o.hp / o.max) * 100)}%`}`).join(", ");
  const cap = s.captain.present ? `${s.captain.name} on deck (${Math.round((s.captain.hp / s.captain.max) * 100)}%${s.captain.status ? `; ${s.captain.status}` : ""})`
    : `${s.captain.name} not on deck yet (comes when half her crew is down)`;
  return `Boarding ${s.enemyName}: ${s.foesLeft} of her ${s.foesTotal} still fighting; her captain ${cap}. Ours: ${ours}. Focus: ${s.focus}. `
    + `${s.rally.used ? "Rally used." : "Rally not used yet (the Captain's F)."}`;
}
