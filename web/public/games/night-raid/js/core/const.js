// Rexmaw Raids' numbers (spec v2 on top of v1). Every tunable of the pure core
// lives here so the world generator, the sim, the gunnery, the crew, the
// briefs and the tests agree. No three.js, no DOM.
//
// Frame: metres and seconds, +Y up, the sea is the XZ plane. The origin is
// the home port's mouth; the bay interior is +Z. Heading ψ in degrees:
// 0 = +Z, increasing toward starboard (−X), night-helm's convention. The
// forward vector is (−sin ψ, cos ψ); the port normal (left) is (cos ψ, sin ψ).
// A bearing relative to a ship (and the camera's look yaw) is + to starboard.
// Compass = heading: north 000 = +Z, east 090 = −X, south 180, west 270 = +X.

/** The kit name and save key. */
export const GAME = "Rexmaw Raids";
export const DEG = Math.PI / 180;

/** The sim's fixed step, s, and the tick event's rate, Hz. */
export const STEP = 1 / 30;
export const TICK_HZ = 10;

// ---- Missions (§2) ------------------------------------------------------------------------

const medals = (time, hull, loot) => Object.freeze({ time: Object.freeze(time), hull: Object.freeze(hull), loot: Object.freeze(loot) });
const ammo = (chain, mortar, barrels) => Object.freeze({ chain, mortar, barrels });

/**
 * The missions. time: day | night (the sky); tab: the title's tab; limit: s of sim time;
 * medals: time [gold, silver, bronze] seconds to finish (lower is better), hull % left, loot gold gathered.
 */
export const MISSIONS = Object.freeze({
  spice_fleet: { id: "spice_fleet", label: "Spice Fleet", time: "day", tab: "day", limit: 420,
    hint: "Take 2 of 3 spice merchants before they round the far cape",
    objective: "Take two of the three spice merchants (board or sink them) before they reach the far cape.",
    medals: medals([200, 280, 360], [80, 55, 30], [900, 600, 350]), ammo: ammo(8, 2, 3) },
  silence_fort: { id: "silence_fort", label: "Silence the Fort", time: "day", tab: "day", limit: 480,
    hint: "Four gun towers, harassing gunboats; mortars and heavy shot",
    objective: "Destroy the fort's four gun towers. Mortars and close heavy shot break them; gunboats will harass you.",
    medals: medals([220, 320, 420], [75, 50, 25], [700, 450, 250]), ammo: ammo(6, 8, 2) },
  navy_convoy: { id: "navy_convoy", label: "Navy Convoy", time: "day", tab: "day", limit: 480,
    hint: "A frigate escorting two brigs: sink her or steal the chest ship",
    objective: "Sink the escorting frigate, or board the brig carrying the paymaster's chest, before the convoy gets away.",
    medals: medals([200, 300, 400], [75, 50, 25], [1100, 700, 400]), ammo: ammo(8, 3, 3) },
  iron_duke: { id: "iron_duke", label: "Legendary: The Iron Duke", time: "day", tab: "day", limit: 600,
    hint: "A man-o'-war boss duel: broadsides, then mortars, then ram runs",
    objective: "Sink the man-o'-war Iron Duke in open water. She fights in three phases: broadsides, mortars, ram runs.",
    medals: medals([240, 360, 480], [65, 40, 20], [1800, 1200, 600]), ammo: ammo(10, 4, 4) },
  smugglers_run: { id: "smugglers_run", label: "Smuggler's Run", time: "night", tab: "night", limit: 420,
    hint: "Contraband through a fog-bound reef maze; patrol lanterns sweep",
    objective: "Carry the contraband through the fog and the reefs to the smugglers' cove and stop inside it. Navy patrols sweep the water with lanterns: stay out of the light, or fight.",
    medals: medals([170, 240, 320], [90, 65, 40], [900, 750, 600]), ammo: ammo(4, 2, 3) },
  the_gloam: { id: "the_gloam", label: "The Gloam", time: "night", tab: "night", limit: 540,
    hint: "The ghost ship hunts in the fog: it cloaks, reappears and rams",
    objective: "Sink The Gloam. She hides in her own fog, slips round you and comes out of it to ram.",
    medals: medals([220, 330, 440], [65, 40, 20], [1600, 1000, 500]), ammo: ammo(8, 3, 3) },
  krakens_wake: { id: "krakens_wake", label: "Kraken's Wake", time: "night", tab: "night", limit: 540,
    hint: "Salvage two wrecks under the Kraken's arms, drive off its eye, run home",
    objective: "Salvage the two wrecks (stop beside each one; the far one is guarded), drive the Kraken off when it rises (hit its eye three times), then run for the harbour mouth. Its arms come up round the wrecks and across your course: shoot them off.",
    medals: medals([280, 360, 450], [70, 45, 20], [2800, 2200, 1600]), ammo: ammo(6, 2, 3) },
  free_day: { id: "free_day", label: "Free Roam (day)", time: "day", tab: "free", limit: 720, free: true,
    hint: "The open bay by day: plunder, heat, bank before sunset",
    objective: "Free roam: take what you can and bank it at home port before sunset. Unbanked plunder is lost when the light goes.",
    medals: medals([720, 720, 720], [70, 45, 20], [2000, 1200, 600]), ammo: ammo(6, 3, 3) },
  free_night: { id: "free_night", label: "Free Roam (night)", time: "night", tab: "free", limit: 720, free: true,
    hint: "The open bay by night: lanterns, fog, a storm cell; bank before dawn",
    objective: "Free roam: take what you can and bank it at home port before dawn. Unbanked plunder is lost at dawn.",
    medals: medals([720, 720, 720], [70, 45, 20], [2000, 1200, 600]), ammo: ammo(6, 3, 3) },
});
export const MISSION_IDS = Object.freeze(Object.keys(MISSIONS));
export const DAY_MISSIONS = Object.freeze(["spice_fleet", "silence_fort", "navy_convoy", "iron_duke"]);
export const NIGHT_MISSIONS = Object.freeze(["smugglers_run", "the_gloam", "krakens_wake"]);
export const FREE_MISSIONS = Object.freeze(["free_day", "free_night"]);
/** The kit's mode tabs: the title's Day / Night / Free Roam. */
export const MODES = Object.freeze({
  day: { id: "day", label: "Day", hint: "Sunlit missions: gunnery and the spyglass", missions: DAY_MISSIONS },
  night: { id: "night", label: "Night", hint: "Dark water, fog and reefs: your companion navigates", missions: NIGHT_MISSIONS },
  free: { id: "free", label: "Free Roam", hint: "The open bay, day or night", missions: FREE_MISSIONS },
});
export const MODE_IDS = Object.freeze(["day", "night", "free"]);
export const DEFAULT_MODE = "day";
export const DEFAULT_MISSION = "spice_fleet";
/** The hidden duel mode for tests (not a tab). */
export const ARENA = Object.freeze({ id: "arena", label: "Duel", time: "day", tab: "arena", limit: 100000, objective: "Duel.",
  medals: medals([1, 2, 3], [100, 100, 100], [1e9, 1e9, 1e9]), ammo: ammo(8, 4, 3) });
export const MEDAL_TIERS = Object.freeze(["gold", "silver", "bronze"]);
export const MEDAL_CATS = Object.freeze(["time", "hull", "loot"]);

/** Phase lengths, s (wall). The briefing waits for the Captain's start_voyage (no timer). */
export const PHASE_S = Object.freeze({ ending: 4 });
/** Objective chains (v3): fail counters warn at these fractions; a bonus pays BONUS_GOLD. */
export const OBJECTIVE = Object.freeze({ warn: Object.freeze([0.5, 0.85]), bonusGold: 150, lastSeenR: 160,
  // v5: the navy convoy calls for help this long after she's first attacked.
  reliefS: 40 });
/** Off a call with a text companion the world runs at this pace and telegraphs last ×TELEGRAPH longer. */
export const OFFCALL = Object.freeze({ pace: 0.85, telegraph: 1.3 });

// ---- The bay (§2) ---------------------------------------------------------------------

export const BAY = Object.freeze({ size: 1800, minX: -900, maxX: 900, minZ: -80, maxZ: 1720, edgeSoft: 70 });
export const PORT = Object.freeze({ x: 0, z: -40, r: 110, bankSpeed: 3, bankS: 2.5 });
export const ISLANDS = Object.freeze({ count: [5, 7], size: [60, 220], clearPort: 280, clearMaelstrom: 300, clearRoute: 60, gap: 70, verts: 14,
  shoalChance: 0.4, shoalR: [12, 22] });
/**
 * The fort (v5 retune: a tower is a few good hits, not a siege). A tower takes 60: two mortar shells (30 each), five heavy
 * balls (13.75), or ~19 round balls (3.2). When one falls the others' gunners duck for PAUSE_S (their reload set back);
 * the magazine tower goes up and shakes the towers within MAGAZINE.r for MAGAZINE.dmg. After SALLY_AT towers are down the
 * garrison sends its reinforcement out (the variant's `sally`: a brig, two gunboats, or a fire ship).
 */
export const FORT = Object.freeze({ towers: 4, towerHp: 60, towerGuns: 2, range: 380, reload: 9, skill: 0.85, towerR: 9, towerH: 14,
  spacing: 46, loot: 150, gunboatEvery: 60, gunboatMax: 4, pauseS: 5, sallyAt: 2,
  magazine: Object.freeze({ r: 75, dmg: 25 }),
  dmgMul: Object.freeze({ round: 0.8, heavy: 1.25, chain: 0, mortar: 1.5 }) });
export const WRECKS = Object.freeze({ count: 2, loot: [250, 450], salvageS: 6, salvageSpeed: 3, salvageR: 40 });
export const MAELSTROM = Object.freeze({ r: 220, eye: 35, ring: Object.freeze([60, 100]), pull: 520, swirl: 0.55, ringChests: 4, chestValue: 80,
  minPortDist: 700 });
export const STORM = Object.freeze({ r: 300, drift: 1.2, visibility: 140, waveEvery: [22, 36], spouts: [1, 2], spoutR: 14, spoutSpeed: 4,
  lightningEvery: [6, 12], lightningR: 28, waveWarn: 10, waveWidth: 220, waveSpeed: 16, gust: 0.2 });
export const COVE = Object.freeze({ r: 60, heal: 20, speed: 3, s: 2 });
export const EXIT = Object.freeze({ r: 90 });
export const WIND = Object.freeze({ strength: [0.7, 1.0], drift: 15, driftPeriod: 200 });
/** Reefs and rocks (hidden in darkness/fog). w: half-width of a band. */
export const REEFS = Object.freeze({ bandLen: [70, 160], bandW: [9, 16], rockR: [8, 16], hull: 8, hullPerMs: 0.9, stuckS: 1.2, grace: 3,
  leakChance: 0.6, revealNight: 60, revealFog: 40, nearWarn: 140, briefRange: 650 });
export const FOG = Object.freeze({ dayVis: 1500, nightVis: 520, bankVis: 110, lanternVis: 800, edge: 60 });
/** Contacts: detected within the visibility; details (class/name) within DETAIL m (day: anything in sight). */
export const SIGHT = Object.freeze({ detail: 350, lost: 1.15 });

// ---- The Rexmaw (§1) ------------------------------------------------------------------

/** The hull capsule (ship-space): a segment ±HALF along the heading, swept by RADIUS. Freeboard H for hits. */
export const SHIP = Object.freeze({ length: 40, beam: 10, half: 15, radius: 5, freeboard: 4.2 });
export const REXMAW = Object.freeze({ hull: 100, masts: 100, hands: 18, handsMax: 24, water: 100, morale: 60 });
/** Sail settings (W/S): target speed before the wind factor, m/s. Sprint: Shift at full sail. */
export const SAILS = Object.freeze([0, 9, 16]);
export const SAIL_NAMES = Object.freeze(["furled", "half sail", "full sail"]);
export const SPRINT = Object.freeze({ speed: 21, drainS: 6, refillS: 10, minStart: 0.15 });
/** Points of sail by angle off the wind (°): upper bound and speed factor. No stall: the worst is ×0.6. */
export const POINTS_OF_SAIL = Object.freeze([
  { name: "in irons", max: 35, factor: 0.6 },
  { name: "close-hauled", max: 70, factor: 0.8 },
  { name: "a beam reach", max: 115, factor: 1.0 },
  { name: "a broad reach", max: 155, factor: 1.1 },
  { name: "running", max: 180.0001, factor: 0.95 },
]);
export const SPEED_TAU = Object.freeze({ up: 1.0, down: 0.8 });
/** Turn rate, °/s, by sail (half sail turns tightest), × a speed factor (0.3 at rest → 1 from vRef m/s). */
export const TURN = Object.freeze({ furled: 14, half: 30, full: 22, sprint: 14, vRef: 6, minF: 0.3, rudderTau: 0.18 });
/** Loot slows her (−1% per 100 gold, capped −10%). Masts and water cap her speed. */
export const LOAD = Object.freeze({ per100: 0.01, cap: 0.10, mastsHalf: 50, mastsLow: 20, mastsHalfF: 0.75, mastsLowF: 0.5, waterFrom: 40, waterSlow: 0.3 });
/** Ramming: bow contact above SPEED m/s. The rammed ship takes HULL × closing speed; the rammer SELF ×. Small boats split. */
export const RAM = Object.freeze({ speed: 8, hull: 2.4, self: 0.35, splitLen: 20, enemyHull: 1.6,
  // v5: an enemy's ram on the Rexmaw is capped at ENEMY_CAP before the brace (in line with a boss broadside), and one ram is
  // one hit: the rammer breaks off (no second hit while the hulls grind together).
  enemyCap: 30 });
/** Islands: a touch above SPEED m/s costs HULL. */
export const GROUND = Object.freeze({ islandSpeed: 4, islandHull: 6, shoalHull: 10, stuckS: 1.5, grace: 4 });

// ---- Damage, fires, leaks, water ----------------------------------------------------------

/** Fires burn the hull and burn out by themselves after OUT_S each (nobody fights them unless ordered). */
export const FIRE = Object.freeze({ hullPerS: 0.35, spreadEvery: 12, spreadChance: 0.25, max: 5, outS: 40, enemyOutEvery: 14 });
export const LEAK = Object.freeze({ waterPerS: 0.5, max: 6 });
/** The slow passive bilge (no order needed) and the bail order's pumps. */
export const BILGE = Object.freeze({ passive: 0.2, bail: 3.0, salMul: 1.5 });
/** The repair order: rates per second (Ara ×1.5), and how much one order restores. */
export const REPAIR = Object.freeze({ hullPerS: 1.6, mastsPerS: 3, leakS: 4, fireS: 3, hullAmount: 30, mastsAmount: 40, araMul: 1.5,
  harbourHull: 2, harbourMasts: 4 });
export const MORALE = Object.freeze({ drift: 0.01, rest: 50, handKilled: 2, momentCooldown: 45 });

// ---- Gunnery (§3) ---------------------------------------------------------------------

/** What one ball does. hull/masts damage; leak/fire/gun/kill chances. rigging: chain catches the rigging. */
export const AMMO = Object.freeze({
  round: { hull: 4, masts: 0.5, leak: 0.12, fire: 0.04, gun: 0.05, kill: 0.15 },
  heavy: { hull: 11, masts: 0, leak: 0.35, fire: 0.1, gun: 0.15, kill: 0.35 },
  chain: { hull: 1, masts: 8, leak: 0, fire: 0, gun: 0, kill: 0.1, rigging: true },
  mortar: { hull: 20, masts: 4, leak: 0.4, fire: 0.3, gun: 0.2, kill: 0.4, blast: 9 },
});
/** The ballistic model: muzzle speed, gravity, muzzle height, gun stagger in a volley. */
export const BALLISTIC = Object.freeze({ v0: 75, g: 9.81, muzzleY: 2.6, stagger: 0.05, sample: 0.1, fine: 1 / 60, maxT: 12 });
/**
 * The Captain's weapons. guns: barrels; traverse: ± degrees the guns swing off their axis; reload s (full crew);
 * elevation from the look pitch: clamp((pitch − PITCH0) × GAIN, 0, MAX); ammo: the count key (null = unlimited).
 */
export const WEAPONS = Object.freeze({
  broadside: { guns: 7, traverse: 25, reload: 4, pitch0: -22, gain: 0.75, maxElev: 17, ammo: null, shot: "round" },
  heavy: { guns: 7, traverse: 25, reload: 4, range: 90, elev: 3, ammo: null, shot: "heavy" },
  chain: { guns: 2, traverse: 20, reload: 5, pitch0: -22, gain: 0.75, maxElev: 12, ammo: "chain", shot: "chain" },
  mortar: { guns: 3, reload: 10, minRange: 150, maxRange: 600, pitch0: -25, perDeg: 18, flight: 2.5, ring: 18, ammo: "mortar", shot: "mortar",
    autoFrom: 330, autoCone: 12 },
  barrels: { guns: 3, reload: 8, ammo: "barrels", life: 30, r: 7, burnHull: 8, fires: 2, armS: 1.5 },
  swivel: { reload: 1.5, range: 120, dmg: 15, fire: 0.3, officer: 0.25, armDmg: 6 },
});
/** Weapon by look yaw (|°| off the bow): chain ≤ BOW, barrels ≥ STERN, else the broadside on that side. */
export const LOOK = Object.freeze({ bow: 40, stern: 140 });
export const SIDES = Object.freeze(["port", "starboard", "bow"]);
/** Reload multipliers by gun crew: full 1, half-manned 1.6, unmanned 3 (interpolated). */
export const RELOAD = Object.freeze({ half: 1.6, none: 3 });
/**
 * Enemy hit model: the gunners lead the target and lay the guns; each ball is thrown off by
 * σ_deflection = (BASE + PER_M × range) × spread / skill, σ_range = σ × RANGE_MUL,
 * spread = 1 + SPEED × shooter speed + REL × the target's crossing speed + sea.
 */
export const HIT = Object.freeze({ base: 2, perM: 0.03, rangeMul: 1.5, speed: 0.02, rel: 0.035, sea: 0.3, rakeDeg: 25, rakeMul: 1.5,
  riggingBeam: 2.2, mastsH: 0.7 });
/** The companion's gun crews: aim error σ (°) at skill 1; skill by gun captain. */
export const CREW_AIM = Object.freeze({ yawSigma: 1.4, elevSigma: 0.45, mortarSigma: 9, lead: true,
  skill: Object.freeze({ leo: 1.3, rex: 1.05, sal: 0.95, eve: 1.0, ara: 0.9, me: 1.0, hands: 0.8 }) });
/**
 * v4 §4: the crews' effective range by shot (m, centre to centre): they hold fire beyond it (man_guns, Attack mode,
 * "Fire!"). Their aim error grows with range: σ × (1 + d / FALLOFF). Mortars only on an explicit man_guns order.
 * The Captain's own weapons keep their full reach (broadside ~330 m, mortar 150–600 m).
 */
export const CREW_RANGE = Object.freeze({ round: 250, heavy: 90, chain: 200, falloff: 250 });
/** v4 §2: the target lock. The aim snaps to the locked ship when the look is within CONE° of her; Tab cycles within CYCLE_R m. */
export const LOCK = Object.freeze({ cone: 30, cycleR: 900 });
/** v4 §3: the classes whose sinking gets the camera's cinematic (plus the mission's prize/chest ship). */
export const CINEMATIC_CLASSES = Object.freeze(["frigate", "manowar", "gloam"]);
/** Brace (Space): window, damage taken, perfect window before an impact. */
export const BRACE = Object.freeze({ window: 1.2, mul: 0.5, perfect: 0.35, perfectMul: 0.15, cooldown: 0.4 });
/** Weak points appear on a ship after HITS hits. */
export const WEAK = Object.freeze({ hits: 3, points: 3 });

// ---- Enemies -----------------------------------------------------------------------------

/**
 * Archetypes. hull, guns a side (bow: bow guns), max speed (m/s), turn (°/s), crew, loot, size (L×B m),
 * skill, preferred range (m), reach (m: they open fire inside it), navy, boardable, reload s.
 */
export const CLASSES = Object.freeze({
  merchant: { label: "merchant", hull: 95, guns: 2, bow: 0, speed: 9.5, turn: 16, crew: 24, loot: [220, 380], len: 34, beam: 10,
    skill: 0.55, range: 150, reach: 200, navy: false, boardable: true, surrenderHull: 0.3, surrenderCrew: 0.4, mortar: false, reload: 9 },
  gunboat: { label: "gunboat", hull: 32, guns: 0, bow: 2, speed: 17, turn: 42, crew: 12, loot: [50, 50], len: 18, beam: 5,
    skill: 0.75, range: 110, reach: 200, navy: true, boardable: false, mortar: false, reload: 6 },
  brig: { label: "brig", hull: 150, guns: 6, bow: 0, speed: 14, turn: 24, crew: 40, loot: [260, 260], len: 32, beam: 9,
    skill: 1.1, range: 150, reach: 260, navy: true, boardable: true, fleeHull: 0.25, mortar: false, reload: 6 },
  frigate: { label: "frigate", hull: 240, guns: 9, bow: 0, speed: 13, turn: 17, crew: 90, loot: [520, 520], len: 46, beam: 12,
    skill: 1.1, range: 170, reach: 300, navy: true, boardable: true, mortar: false, reload: 6 },
  fireship: { label: "fire ship", hull: 40, guns: 0, bow: 0, speed: 15, turn: 24, crew: 10, loot: [0, 0], len: 26, beam: 8,
    skill: 0, range: 0, reach: 0, navy: true, boardable: false, mortar: false, reload: 99, blast: 30, blastR: 40, lightS: 8 },
  // v5 bosses: a broadside in line with a frigate's (~15–20 a volley), the fight's length from their hull.
  manowar: { label: "man-o'-war", hull: 480, guns: 10, bow: 0, speed: 11, turn: 12, crew: 160, loot: [1500, 1500], len: 58, beam: 15,
    skill: 0.85, range: 200, reach: 320, navy: true, boardable: false, mortar: true, reload: 9, legendary: true },
  gloam: { label: "The Gloam", hull: 640, guns: 10, bow: 0, speed: 16, turn: 24, crew: 120, loot: [1400, 1400], len: 52, beam: 13,
    skill: 1.1, range: 150, reach: 260, navy: false, boardable: false, mortar: false, reload: 5.5, legendary: true },
  tower: { label: "gun tower", hull: 60, guns: 2, bow: 0, speed: 0, turn: 0, crew: 0, loot: [150, 150], len: 18, beam: 18,
    skill: 0.85, range: 380, reach: 380, navy: true, boardable: false, mortar: false, reload: 8, fixed: true },
});
/** Enemy AI timings: ports open TELEGRAPH s before a broadside; close again after PORTS_HOLD s unused. */
export const AI = Object.freeze({ telegraph: 2.2, portsHold: 3, detect: 500, navyDetectCold: 160, merchantFlee: 260, surrenderHold: 60,
  fleeEscape: 900, edgeEscape: 420, dartIn: 80, dartOut: 230, ramRange: 110, fireLight: 200 });
export const MORTAR = Object.freeze({ every: 9, warn: 4, r0: 34, r1: 11, dmg: 20, range: 520 });
/** The Iron Duke's phases by hull fraction; ram runs every RAM_EVERY s in phase 3. */
export const DUKE = Object.freeze({ phase2: 0.66, phase3: 0.33, ramEvery: 18, mortarEvery: 8,
  // v5: after each ram run (hit or miss) she has lost way for REEL_S: REEL_SPEED of her speed, her ports shut (the window to rake her).
  reelS: 6, reelSpeed: 0.45 });
/**
 * The Gloam's cycle: fight FIGHT_S, cloak CLOAK_S (slips round to a flank), then a ram run. Visible within CLOAK_SIGHT m when cloaked.
 * v5: she slips out past ~170 m into her fog and round to a point FLANK_DEG off our bow, so the ram comes across our beam;
 * the run is told (`hazard {kind: "ram", stage: "telegraph"}`) and she stays in her fog only REVEAL_S of it, then bursts out
 * (~5 s to brace or turn away); one ram is one hit (capped, RAM.enemyCap); after the run, hit or miss, she wallows for REEL_S
 * at REEL_SPEED with her ports shut (the window to punish her: heavy shot inside 90 m). Round shot only (v4's point-blank
 * heavy broadside did up to 60 in one volley). A ghost ship: she minds no wind and keeps out of the maelstrom.
 */
export const GLOAM = Object.freeze({ fightS: 24, cloakS: 12, ramS: 10, cloakSight: 60, flankR: 220, flankDeg: 105, revealS: 3, reelS: 7, reelSpeed: 0.35 });
/** Patrol lanterns: a sweeping beam. Spotted when the alert meter fills. */
export const LANTERN = Object.freeze({ half: 15, range: 240, sweep: 70, sweepRate: 0.45, fill: 1.1, nearR: 70, nearFill: 0.7, decay: 4,
  callR: 500, loseS: 20, loseR: 520, fogMul: 0.55 });
export const KRAKEN = Object.freeze({ inkS: 8, arms: 4, armHp: 12, lastS: 50, hullPerArm: 0.4, slow: 0.55, again: 45, heavyArm: 8, crewDps: 1.6,
  loot: 300 });
/**
 * v5 Kraken's Wake: the Kraken's eye (the boss beat after the salvage). It surfaces RISE_S, stays up UP_S (hittable: our balls
 * splashing within HIT_R m — the mantle is huge — mortar shells, the swivel within SWIVEL_R; R is the drawn reach and the marker;
 * while it's up it is the locked target, so the arcs snap to it), and dives early once it has taken WOUND in one surfacing (a
 * wound); then it's down DOWN_S while its arms / a wave / the grab come at us, and surfaces again DIST m off. WOUNDS drive it off.
 */
export const KRAKEN_EYE = Object.freeze({ wounds: 3, wound: 40, r: 18, hitR: 26, riseS: 3, upS: 18, diveS: 3, downS: 11, dist: Object.freeze([200, 270]),
  swivelR: 250, swivel: 6, loot: 300 });
/**
 * v5 Kraken's Wake's director: a lone arm across her course on each leg out to a wreck (FIRST_AMBUSH s in, LEG_AMBUSH s into
 * the second leg, or once she's within 520 m, then every LEG_EVERY s while she's still 380 m+ out; AMBUSH_AHEAD m ahead,
 * AMBUSH_SIDE m off the line); arms round each wreck (one at the first, WRECK_ARMS at the second; WRECK_ARM_R m off it) when she's
 * within WRECK_ARMS_AT m; the ink and the grab as the divers go down at the first wreck; on the run home an arm ahead every
 * ESCAPE_EVERY s until she's ESCAPE_CLEAR m from the mouth. The divers stop work while the ink spreads, while arms hold the
 * rails and while one thrashes within 45 m (the salvage clock waits). GRAB_AT: the wreck she closes on first (within it) is "the first".
 */
export const KRAKENS_WAKE = Object.freeze({ firstAmbush: Object.freeze([14, 22]), legAmbush: Object.freeze([8, 14]), legEvery: Object.freeze([24, 30]),
  ambushAhead: Object.freeze([230, 290]), ambushSide: Object.freeze([25, 55]), grabAt: 260, wreckArms: 2, wreckArmR: Object.freeze([70, 105]), wreckArmsAt: 230, escapeEvery: Object.freeze([17, 23]), escapeClear: 300 });
/** Enemy names by class (seeded picks). */
export const NAMES = Object.freeze({
  merchant: ["Plump Margaret", "Sweet Tallow", "Golden Hind", "Contented Goose", "Saltcellar", "Fair Ledger", "Merry Bale", "Spice Queen", "Brass Kettle", "Clove Maiden"],
  gunboat: ["Wasp", "Hornet", "Midge", "Gnat", "Terrier", "Ferret", "Weasel", "Sting"],
  brig: ["Vigilant", "Dauntless", "Pursuit", "Resolute", "Swift", "Zealous", "Tenacious"],
  frigate: ["Lady Justice", "Retribution", "Sovereign", "Magistrate", "Inquisitor"],
  fireship: ["Ember", "Kindling", "Tinderbox", "Cinder"],
  manowar: ["Iron Duke"],
  gloam: ["The Gloam"],
  tower: ["north tower", "east tower", "south tower", "west tower"],
});
/** Names for the far cape the spice fleet and the convoy run for (v3 variants). */
export const CAPE_NAMES = Object.freeze(["Cape Saffron", "Clove Head", "Cinnamon Point", "Pepper Bluff", "Nutmeg Cape", "Mace Point"]);
/** Names for reefs and rocks (the companion's chart). */
export const REEF_NAMES = Object.freeze(["Saw Reef", "the Needles", "Dead Man's Fingers", "the Combs", "Gull Teeth", "the Graters", "Widow's Lace",
  "the Knuckles", "Black Molars", "the Rasp", "Hangman's Shelf", "the Bones"]);

// ---- Heat, loot (free roam) -----------------------------------------------------------------

export const HEAT = Object.freeze({ max: 5, bank: -1, decayS: 150, waveDelay: [20, 35], waveEvery: 180,
  byClass: Object.freeze({ merchant: 1, gunboat: 1, brig: 2, frigate: 2, fireship: 0, manowar: 2, gloam: 0, tower: 1 }),
  waves: Object.freeze([[], ["gunboat", "gunboat"], ["brig", "gunboat"], ["frigate"], ["frigate", "fireship"], ["frigate", "brig", "fireship"]]) });
/**
 * v5 free roam's director: a fresh merchant sails in from the bay's edge every TRAFFIC_EVERY s when fewer than TRAFFIC_MIN calm
 * ones are about; side jobs (the bonus slot, one at a time) from CONTRACT_FIRST s, CONTRACT_GAP s apart, CONTRACT_S s each
 * (from heat QUIET_HEAT up, only the quiet ones: a wreck, a chest adrift).
 */
export const FREE_ROAM = Object.freeze({ trafficEvery: Object.freeze([60, 90]), trafficMin: 2, contractFirst: Object.freeze([25, 40]),
  contractGap: Object.freeze([12, 20]), contractS: 170, chestGold: 60, quietHeat: 2,
  // Homeward with INTERCEPT_HOLD+ gold in the hold, INTERCEPT_FROM m out: a cutter (two with heat 2+) tries to cut her off.
  interceptHold: 200, interceptFrom: Object.freeze([560, 1100]), interceptEvery: 150,
  reward: Object.freeze({ bounty: 220, prize: 200, salvage: 150, tower: 180, chest: 160 }) });
/** Collectables (§2.4): collected within RANGE m of the hull. Flotsam from a sunk ship drifts for FLOTSAM_S s. */
export const PICKUP = Object.freeze({ range: 8, flotsamS: 120, flotsamN: [3, 5], sinkLoot: 0.5, drift: 0.4,
  crate: Object.freeze({ chain: 2, mortar: 1, barrels: 1 }), barrelHull: 12, bottleGold: 60, chestGold: [250, 400], crateGold: 20 });
export const PICKUP_KINDS = Object.freeze(["crate", "barrel", "bottle", "chest", "flotsam", "ring"]);
export const BOTTLE_NOTES = Object.freeze(["\"The Duke's gunners always fire on the downroll.\"", "\"Count to three after the ports glow.\"",
  "\"The Gloam can't hide from a sharp lookout.\"", "\"Half sail turns tightest.\"", "\"Chain shot first, then she can't run.\"",
  "\"Mortars find towers that guns can't.\"", "\"Barrels astern for anyone who chases.\""]);
export const SINK_S = 8;

// ---- Crew --------------------------------------------------------------------------------------

export const NAMED = Object.freeze(["rex", "eve", "ara", "sal", "leo"]);
export const NAMED_LABEL = Object.freeze({ rex: "Rex", eve: "Eve", ara: "Ara", sal: "Sal", leo: "Leo", me: "you" });
export const STATIONS = Object.freeze(["guns_port", "guns_starboard", "bow_chaser", "mortar", "sails", "damage", "pumps", "lookout", "powder",
  "boarding", "galley", "quarterdeck", "repel"]);
export const STATION_LABEL = Object.freeze({ guns_port: "port guns", guns_starboard: "starboard guns", bow_chaser: "bow chasers", mortar: "mortar",
  sails: "sails", damage: "damage control", pumps: "pumps", lookout: "lookout", powder: "powder room", boarding: "boarding party",
  galley: "galley", quarterdeck: "quarterdeck", repel: "repelling the Kraken" });
/** Calm posts: where the named crew stand when nobody has ordered them anywhere. */
export const DEFAULT_NAMED = Object.freeze({ rex: "powder", eve: "lookout", ara: "galley", sal: "sails", leo: "quarterdeck", me: "quarterdeck" });
/** Hands: guns need GUNS (both broadsides), POSTS stay on sails/bow/mortar; jobs take hands off the guns. */
export const HANDS = Object.freeze({ guns: 12, posts: 4, repair: 8, bail: 4, manned: 0 });
export const CREW = Object.freeze({ walkS: 2 });
/** Who a job wants first. */
export const JOB_CREW = Object.freeze({ guns: ["leo", "rex", "sal", "eve", "ara"], mortar: ["rex", "leo", "sal", "eve", "ara"],
  repair: ["ara", "rex", "sal", "eve", "leo"], bail: ["sal", "rex", "eve", "ara", "leo"] });
export const ORDER_MODES = Object.freeze(["once", "keep_firing", "hold"]);
export const REPAIR_WHAT = Object.freeze(["hull", "masts", "leaks", "fires", "all"]);
export const DANGER_KINDS = Object.freeze(["reef", "rocks", "shoal", "patrol", "whirlpool", "wreck"]);
/**
 * Crew modes (v3, keys 1/2/3): hold = the hands only reload what the Captain fires; attack = the gun crews fire the battery that
 * bears on the marked/nearest enemy (reloads × ATTACK_RELOAD); defend = repairs and pumps on their own. Orders override per battery/job.
 */
export const CREW_MODES = Object.freeze(["hold", "attack", "defend"]);
export const CREW_MODE_INFO = Object.freeze({
  hold: { key: "1", label: "Hold", line: "The crew only reload what you fire." },
  attack: { key: "2", label: "Attack", line: "Gun crews fire whichever battery bears on the locked or nearest enemy within 250 m." },
  defend: { key: "3", label: "Defend", line: "The crew repair, pump and fight fires on their own; guns only when you fire." },
});
export const CREW_MODE = Object.freeze({ attackReload: 0.85, attackSkill: "hands", defendHullGap: 10, defendMasts: 80, defendWater: 8, defendEvery: 0.5 });
/** Contribution pops: repairs and pumping are batched this often (s); a brace call counts if a hit lands within BRACE_S. */
export const CONTRIB = Object.freeze({ batchS: 1.5, braceS: 4 });
export const DANGER = Object.freeze({ life: 60, r: 60, minR: 15, maxR: 250 });
export const HEADING_CALL_S = 25;

/** Crew moments (crew_moment): who can lead them, morale. */
export const MOMENTS = Object.freeze({
  shanty: { who: ["rex", "eve", "ara", "sal", "leo"], morale: 8, text: "strikes up a shanty" },
  tea: { who: ["ara"], morale: 6, text: "brings round the tea" },
  banter: { who: ["rex", "eve", "ara", "sal", "leo"], morale: 4, text: "trades banter with the hands" },
  rally: { who: ["leo", "rex"], morale: 10, text: "rallies the crew" },
  joke: { who: ["sal", "eve"], morale: 5, text: "cracks a joke" },
});

// ---- Boarding -----------------------------------------------------------------------------------

/**
 * Boarding (v4): a beaten ship (≤ HULL_FRAC hull, masts ≤ MASTS_MAX, or struck) can be boarded when the Rexmaw is inside
 * her ring: her hull ellipse grown by RANGE m (+ our half-beam). One press of B; refused only at ramming speed (closing
 * ≥ RAM_SPEED m/s). The world runs at WORLD_PACE while the deck fight (BOARD_FIGHT) is on.
 */
export const BOARD = Object.freeze({ hullFrac: 0.25, mastsMax: 20, range: 30, ramSpeed: 12, worldPace: 0.2,
  loseHands: [2, 4], winHands: 2, winAmmo: Object.freeze({ chain: 2, mortar: 1, barrels: 1 }),
  // v3 names kept for old readers (the RPS rounds are gone).
  speedDiff: 12, rounds: [0, 0], timeout: 0, rallyAt: 0, rallyCost: 0 });
/**
 * The deck fight (v4 §1): paired duels on her deck, a swing every ~0.6–1.2 s, hits from an accuracy accumulator (no dice).
 * hp, dmg (a hit), acc (hits per swing), swing (s between swings). Ara heals those near her; Rally once per fight.
 */
export const BOARD_FIGHT = Object.freeze({
  grappleS: 2.5, endS: 2.5, maxS: 120, reach: 1.7, move: 3.2, gunnerRange: 9, packOnCaptain: 3,
  foes: Object.freeze({ merchant: 6, brig: 8, frigate: 12, default: 8 }),
  gunners: Object.freeze({ merchant: 2, brig: 3, frigate: 4, default: 3 }),
  captainHp: Object.freeze({ merchant: 200, brig: 250, frigate: 300, default: 250 }),
  ours: Object.freeze({
    rex: Object.freeze({ hp: 120, dmg: 5, acc: 0.72, swing: 1.1 }),     // strong
    leo: Object.freeze({ hp: 95, dmg: 3.6, acc: 0.95, swing: 0.9 }),    // precise
    sal: Object.freeze({ hp: 160, dmg: 3, acc: 0.72, swing: 1.0 }),     // tough
    ara: Object.freeze({ hp: 100, dmg: 2.5, acc: 0.72, swing: 1.0 }),   // heals those near her
    eve: Object.freeze({ hp: 90, dmg: 2.5, acc: 0.8, swing: 0.62 }),    // quick
    me: Object.freeze({ hp: 105, dmg: 3.3, acc: 0.8, swing: 0.9 }),
  }),
  foe: Object.freeze({
    sailor: Object.freeze({ hp: 60, dmg: 4, acc: 0.48, swing: 1.1 }),
    gunner: Object.freeze({ hp: 50, dmg: 5, acc: 0.42, swing: 1.2 }),
    captain: Object.freeze({ hp: 250, dmg: 7, acc: 0.65, swing: 0.95 }),
  }),
  pistol: Object.freeze({ dmg: 18, cooldown: 1.2 }),
  rally: Object.freeze({ heal: 0.35, mul: 1.6, swingMul: 0.8, s: 8 }),
  heal: Object.freeze({ perS: 2.2, r: 5, below: 0.75 }),
  defend: Object.freeze({ taken: 0.7, dealt: 0.75, healMul: 1.5 }),
});
/** The enemy captains' names (a seeded pick per ship). */
export const CAPTAIN_NAMES = Object.freeze(["Captain Hale", "Captain Mordaunt", "Captain Vance", "Captain Thorne", "Captain Ashby", "Captain Crane",
  "Captain Blackwood", "Captain Pell", "Captain Rook", "Captain Sterling", "Captain Fairweather", "Captain Grimsby"]);
export const BOARD_FOCUS = Object.freeze(["captain", "crew", "defend"]);
/** v3's boarding moves (gone in v4; kept so old imports don't break). */
export const MOVES = Object.freeze(["brace", "volley", "charge", "defend", "rally"]);

// ---- Random sea events (v4 §3) -----------------------------------------------------------------------

/**
 * A recurring seeded spawner (v4.2): the first FIRST s in, then one every GAP s (free roam FREE_FIRST / FREE_GAP) until the
 * mission's last TAIL s; WHACKY of the slots are whacky ones (never two of those in play at once). Telegraphed WARN s and
 * placed IN VIEW: DIST m off the Rexmaw (led by where she'll be when the telegraph ends) within ±ARC° of the camera's look
 * (else her bow), at least CLEAR_OBJ m from the current objective marker; at the start it's checked again (VIEW m, ±VIEW_ARC°)
 * and moved back into view if she's turned away. Per kind: s = how long it lasts.
 */
export const SEA_EVENTS = Object.freeze({
  first: Object.freeze([45, 75]), gap: Object.freeze([60, 120]), freeFirst: Object.freeze([30, 50]), freeGap: Object.freeze([40, 75]), tail: 60,
  warn: Object.freeze([8, 12]), dist: Object.freeze([150, 400]), arc: 55, view: Object.freeze([110, 480]), viewArc: 75, leadMax: 200,
  clearObj: 350, clearPort: 300, clearFort: 450, retry: 15,
  /** The nearer margins a spot in view may fall back to (m; the maelstrom's beyond its pull radius). */
  relax: Object.freeze({ obj: 220, port: 220, fort: 300, maelstrom: 80 }),
  spout: Object.freeze({ s: Object.freeze([45, 65]), n: Object.freeze([1, 2]), r: 14, pullR: 80, pull: 3.5, speed: 4, roam: 200, dmg: 18, cd: 6 }),
  squall: Object.freeze({ s: Object.freeze([40, 70]), r: 450, upwind: 350, drift: 6, visibility: 200, gust: 0.35, swing: 20, ramp: 6 }),
  waves: Object.freeze({ n: 3, every: 7, first: 6, s: 40 }),
  derelict: Object.freeze({ s: 150, gap: 25, speed: 4, salvageS: 5, gold: Object.freeze([150, 300]), ammo: Object.freeze({ chain: 2, mortar: 1 }) }),
  treasure: Object.freeze({ s: 90, n: Object.freeze([6, 10]), r: 55, chest: Object.freeze([80, 140]), flotsam: Object.freeze([25, 45]) }),
  kraken_arm: Object.freeze({ s: 45, hp: 30, every: 7, slamR: 24, dmg: 12, speed: 2, splashR: 12, swivel: 10, gold: 120 }),
  fog: Object.freeze({ s: Object.freeze([90, 120]), r: 240, density: 0.85, upwind: 400, drift: 3, fade: 10 }),
  // ---- The whacky ones (`whacky` = the share of the slots that are whacky; never two in play at once) ----
  whacky: 0.4,
  /** Gerald (the chapbook's shark, grown): a fin circling, a dark shape rising, a leap over the Rexmaw, a landing. */
  gerald: Object.freeze({ circleR: 40, approach: 9, rise: 2.4, air: 4.4, swim: 6, apex: 38, launch: 75, land: Object.freeze([0, 34]), hitR: 12,
    nearR: 36, dmg: 26, water: 12, splashWater: 5, enemyDmg: 40 }),
  /** A blue whale that breaches and keeps going: up into the clouds, a loop, a song, a belly-flop and its ring wave. */
  sky_whale: Object.freeze({ breach: 3, climb: 8, loop: 9, glide: 5, dive: 3.2, after: 55, flopFrom: Object.freeze([170, 230]), ring: 15,
    ringMax: 460, ringBand: 9, rideDeg: 30, dmg: 10, water: 8, bigDmg: 12, capsize: Object.freeze(["gunboat", "fireship"]),
    loot: Object.freeze([8, 12]), lootR: 75, chest: Object.freeze([60, 110]), gold: Object.freeze([25, 45]) }),
  /** A pod running alongside: keep pace (inside `paceR` of them at ≥ `paceV` m/s) for `paceS` s and ride their bow wave. */
  dolphins: Object.freeze({ s: 45, speed: 13, join: 24, side: 30, ahead: 20, paceR: 50, paceV: 8, paceS: 6, boost: 1.25, boostS: 25 }),
  /** A swarm of flying fish crossing her bow: steer into it and they land on deck (supper, and a little gold). */
  flying_fish: Object.freeze({ s: 14, speed: 30, lead: 40, past: 140, catchR: 24, gold: 40 }),
  /** (Night) a bloom of giant glowing jellyfish adrift: anything inside is zapped every few seconds. */
  jellyfish: Object.freeze({ s: 60, r: 120, every: 3, dmg: 3, enemyDmg: 4, drift: 0.8, fade: 6 }),
  /** An island-sized turtle surfaces with a palm and a chest on her back: come alongside slowly and take the chest. */
  turtle: Object.freeze({ s: 75, r: 30, speed: 2.2, gap: 16, slow: 5, salvageS: 4, gold: Object.freeze([140, 220]), ammo: Object.freeze({ barrels: 1 }),
    bump: 6, bumpCd: 4 }),
  /** The Seagull Admiral and the squadron: dive-bombs the locked (else nearest) hostile within reach, else inspects us. */
  admiral: Object.freeze({ s: 28, reach: 700, every: 6, passes: 3, dmg: 3, loaded: 0.2, medal: 50, fly: 26, inspect: 5 }),
});
/** The ordinary sea events (the schedule's pool) and the whacky ones (at most one per mission). */
export const SEA_NORMAL = Object.freeze(["spout", "squall", "waves", "derelict", "treasure", "kraken_arm", "fog"]);
export const SEA_WHACKY = Object.freeze(["gerald", "sky_whale", "dolphins", "flying_fish", "jellyfish", "turtle", "admiral"]);
export const SEA_KINDS = Object.freeze([...SEA_NORMAL, ...SEA_WHACKY]);
export const SEA_LABEL = Object.freeze({ spout: "Waterspout", squall: "Squall", waves: "Rogue waves", derelict: "Derelict", treasure: "Treasure afloat",
  kraken_arm: "Kraken arm", fog: "Fog bank", gerald: "Gerald", sky_whale: "Sky whale", dolphins: "Dolphin pod", flying_fish: "Flying fish",
  jellyfish: "Jellyfish bloom", turtle: "Island turtle", admiral: "The Seagull Admiral" });

// ---- Power-ups (v4.2) --------------------------------------------------------------------------------

/**
 * Glowing floats on the water (not loot): the first FIRST s in, then one every EVERY s (free roam FREE_EVERY) while fewer than
 * MAX are afloat, placed in view (DIST m off, within ±ARC° of the camera's look or her bow, SPACING m from each other) clear
 * of land; LIFE s afloat. Our sinkings bring the next one sooner (AFTER_SINK s) and may drop one where she went down (DROP by
 * class, DROP_LIFE s). Sailed through within RANGE m of her hull. A timed one picked up again adds its time (up to STACK ×);
 * different kinds stack. Per kind: s = how long it lasts.
 */
export const POWERUP = Object.freeze({
  first: Object.freeze([10, 20]), every: Object.freeze([20, 35]), freeEvery: Object.freeze([16, 28]), max: 4, life: 70, dropLife: 60,
  dist: Object.freeze([120, 320]), arc: 50, spacing: 40, range: 6, afterSink: 6, stack: 2, drift: 0.4,
  drop: Object.freeze({ merchant: 0.35, gunboat: 0.35, brig: 0.5, frigate: 0.75, fireship: 0.25, manowar: 1, gloam: 1, default: 0.4 }),
  swift_wind: Object.freeze({ s: 20, speed: 1.3 }),
  quick_hands: Object.freeze({ s: 20, reload: 0.5 }),
  hot_shot: Object.freeze({ s: 60, volleys: 3, max: 6, fires: 3 }),
  iron_hull: Object.freeze({ s: 20, taken: 0.5 }),
  patch_kit: Object.freeze({ hull: 20, leaks: 1 }),
  powder_keg: Object.freeze({ add: Object.freeze({ chain: 2, mortar: 1, barrels: 1 }) }),
  double_doubloons: Object.freeze({ s: 30, loot: 2 }),
  kraken_ink: Object.freeze({ s: 15, spread: 2 }),
  mermaid_kiss: Object.freeze({ morale: 5 }),
});
export const POWERUP_KINDS = Object.freeze(["swift_wind", "quick_hands", "hot_shot", "iron_hull", "patch_kit", "powder_keg", "double_doubloons",
  "kraken_ink", "mermaid_kiss"]);
/** The timed ones (a buff with a clock); the rest act at once. */
export const POWERUP_TIMED = Object.freeze(["swift_wind", "quick_hands", "hot_shot", "iron_hull", "double_doubloons", "kraken_ink"]);
export const POWERUP_LABEL = Object.freeze({ swift_wind: "Swift Wind", quick_hands: "Quick Hands", hot_shot: "Hot Shot", iron_hull: "Iron Hull",
  patch_kit: "Patch Kit", powder_keg: "Powder Keg", double_doubloons: "Double Doubloons", kraken_ink: "Kraken Ink", mermaid_kiss: "Mermaid's Kiss" });
/** What each one does, in a few words (the companion's facts, the HUD's card). */
export const POWERUP_INFO = Object.freeze({
  swift_wind: "speed +30% for 20 s", quick_hands: "every gun reloads twice as fast for 20 s", hot_shot: "our next 3 volleys set what they hit burning",
  iron_hull: "damage taken halved for 20 s", patch_kit: "+20 hull at once and a leak plugged", powder_keg: "chain shot, mortar shells and fire barrels topped up, every gun loaded",
  double_doubloons: "every gold coin counts twice for 30 s", kraken_ink: "an ink cloud round us: enemy volleys scatter wide for 15 s",
  mermaid_kiss: "every fire out, every leak plugged, the bilge pumped dry",
});

// ---- The companion --------------------------------------------------------------------------------

export const SUGGEST_KINDS = Object.freeze(["target", "loot", "route", "flee", "board"]);
export const SUGGEST = Object.freeze({ expireS: 20, offcallExpireS: 30, unpromptedGap: 90 });
/** Briefs: gap between spoken beats (wall s), high beats may cut the gap. */
export const BRIEF = Object.freeze({ gapCall: 8, gapOff: 18, highGapCall: 4, highGapOff: 9, contactRange: 800, windowS: 15, maxContacts: 4,
  maxHazards: 5 });
export const WHY_MAX = 60;
export const LOG_KEEP = 20;
export const SPYGLASS_MARK_S = 1;

// ---- Score ---------------------------------------------------------------------------------------

export const SCORE = Object.freeze({ success: 500, gold: 1, sunk: 50, captured: 100, medal: Object.freeze({ gold: 300, silver: 200, bronze: 100 }),
  hull: 2, perDoubloon: 25 });
export const SAVE_BUDGET = 56000;
