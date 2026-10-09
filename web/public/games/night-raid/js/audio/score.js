// The score: Rexmaw Raids' music director (v2 §6 by situation AND time of day;
// v3 §D16 no abrupt switches; v4 §5 recorded music).
//
// v4: the music is six recorded tracks (audio/music.js plays them; licences in
// assets/CREDITS.txt). From the same decisions as below, one bed sounds:
//
//   boss     the boss family (the Iron Duke, the Gloam, the Kraken; holds 15 s)
//   combat   intensity contact or battle (a hostile inside 600 m for 3 s; a
//            shot holds it 12 s; none inside 700 m for 8 s lets it go)
//   day / night   otherwise, by the light (the storm cell plays the light's bed)
//
// Crossfades (music.js FADES): calm → combat 2 s in / 3 s out, combat → calm
// 4 s, day ⇄ night 6 s, to or from the boss 3 s. A bed that steps aside
// resumes where it left off. A mission's end plays the victory or defeat sting
// over the bed (which dips under it) and the calm bed comes back. Voice lines
// duck it (the kit's band.duck is tapped, so every kit voice line counts).
// Level: the kit band's volume (mix.js's Music fader and the cog's slider both
// set it through RexGame.music.setVolume, which is tapped): BED_GAIN at the
// kit's default 0.35. The cog's Music "Off" (RexGame.music.stop) silences it.
// The band itself plays the silent "Rexmaw Raids score" track meanwhile
// (tracks.js), its key retuned to the bed's so the stingers below stay in tune.
// If the files can't be fetched or decoded, everything below runs as in v3 on
// the synthesised tracks (the fallback).
//
// Two things are decided separately:
//
//   the FAMILY (the track)  day · night by the light (daylight ≥ 0.5 and fog
//                           under 0.6, with a band of hysteresis and 4 s of
//                           steadiness) · boss (the Iron Duke, the Gloam within
//                           900 m, the Kraken up; holds 15 s after) · storm
//                           (inside the cell 3 s; holds 10 s after leaving)
//   the INTENSITY (layers)  calm · contact (a hostile within 600 m for 3 s
//                           running; drops back after 8 s with none inside
//                           700 m) · battle (any shot fired, by anyone, a hit on
//                           us, boarding, spotted; holds 12 s after the LAST
//                           shot or hit)
//
// An intensity change is only a layer fade inside the playing track
// (tracks.js: calm → contact → battle add layers over the same groove): it
// starts on the next bar line and settles over 2 s up, 4 s down. The band is
// never stopped and no tune starts from the top. A family change (day ⇄
// night) starts its 4.5 s fade-out on a bar line and the next track fades in
// over 1.5 s (6 s in all); a set piece (boss, storm) crossfades over 4 s.
// The `danger` layer (ports open close by, a ram, a mortar ring on us, water
// ≥ 40 %, hull under 30 %, fire aboard) comes in at the next bar over 0.6 s.
//
// It only steers the music while the Captain's pick in the kit's cog is the
// game's default ("Rexmaw Raids score", or a v3 synth pick) or unset; "Off"
// silences it.
// Stingers are game feedback and play whatever the track (warm voices only:
// horn, harp, low brass, cello, a little choir; no bells or celesta).
// Ducking: the kit already ducks the band under recorded voice lines (its one
// voice channel); the bus's `say` (the companion talking live on a call) ducks
// it by the length of the line.

import { SCORE_ID, SYNTH_IDS, INTENSITY } from "./tracks.js";
import { createMusicPlayer, FADES } from "./music.js";
import { mix } from "./mix.js";

const Kit = () => globalThis.RexGame || null;
const PICK_KEY = "rx-music-Rexmaw Raids";
const DEFAULT_TRACK = SCORE_ID;
/** Every band track the score may steer: the silent score track and the synthesised fallback. */
const OURS = [SCORE_ID, ...SYNTH_IDS];
/** The kit band's default volume (lib/music.js) and the files' gain there: −16 LUFS beds play about −22 LUFS. */
const KIT_DEFAULT_VOL = 0.35, BED_GAIN = 0.5;
/** The track each family plays. */
export const MOOD_TRACKS = Object.freeze({ day: "rr-day-sail", night: "rr-night-sail", boss: "rr-boss", storm: "rr-storm" });
const T = MOOD_TRACKS;

/** The stingers, as specs for RexGame.music.stinger (scale degrees of the playing track's key; 7 = the octave). */
export const STINGERS = Object.freeze({
  victory: [{ inst: "brass", degrees: [0, 2, 4, 7], step: 0.16, oct: 3, vol: 1.3, dur: 1.4, quantize: "none" },
    { inst: "harp", degrees: [0, 2, 4, 7, 9, 11, 14], step: 0.06, oct: 4, vol: 1.1, quantize: "none" },
    { inst: "horn", degrees: [7], step: 0, oct: 3, vol: 1, dur: 2, quantize: "none" }],
  fail: [{ inst: "cello", degrees: [2, 1, 0, -3], step: 0.45, oct: 2, vol: 1.5, dur: 0.9, quantize: "none" },
    { inst: "choir", degrees: [-7, -3, 0], step: 0, oct: 3, vol: 0.6, dur: 3, quantize: "none" }],
  sink: [{ inst: "brass", degrees: [0, 4, 7], step: 0.12, oct: 3, vol: 1.2, dur: 0.9, quantize: "none" },
    { inst: "tuba", degrees: [0, -7], step: 0.12, oct: 2, vol: 1.1, dur: 0.8, quantize: "none" }],
  surrender: [{ inst: "horn", degrees: [0, 4, 7, 9], step: 0.16, oct: 3, vol: 1.2, dur: 0.8, quantize: "none" }],
  tower: [{ inst: "brass", degrees: [0, 4], step: 0.14, oct: 3, vol: 1.1, dur: 0.7, quantize: "none" },
    { inst: "tuba", degrees: [0], step: 0, oct: 2, vol: 1, dur: 0.8, quantize: "none" }],
  objective: [{ inst: "harp", degrees: [0, 4, 7, 11], step: 0.07, oct: 4, vol: 1.2, quantize: "none" },
    { inst: "horn", degrees: [4, 7], step: 0.2, oct: 3, vol: 0.9, dur: 0.9, quantize: "none" }],
  chest: [{ inst: "harp", degrees: [0, 2, 4, 7, 9], step: 0.05, oct: 4, vol: 1.2, quantize: "none" }],
  bank: [{ inst: "harp", degrees: [0, 2, 4, 7, 9, 11, 14], step: 0.05, oct: 4, vol: 1.1, quantize: "none" },
    { inst: "horn", degrees: [0, 4, 7], step: 0, oct: 3, vol: 0.8, dur: 1.2, quantize: "none" }],
  board_won: [{ inst: "brass", degrees: [0, 2, 4, 7], step: 0.12, oct: 3, vol: 1.3, dur: 0.9, quantize: "none" }],
  board_lost: [{ inst: "cello", degrees: [2, 1, 0, -3], step: 0.3, oct: 2, vol: 1.4, dur: 0.7, quantize: "none" }],
  heat: [{ inst: "horn", degrees: [0, -1], step: 0.3, oct: 2, vol: 1.3, dur: 0.8, quantize: "none" }],
  kraken: [{ inst: "horn", degrees: [0, -2, -3], step: 0.28, oct: 2, vol: 1.5, dur: 1.1, quantize: "none" },
    { inst: "choir", degrees: [0, 2, 4], step: 0, oct: 3, vol: 0.6, dur: 2.4, quantize: "none" }],
  legendary: [{ inst: "choir", degrees: [0, 1, 4], step: 0, oct: 3, vol: 0.7, dur: 3, quantize: "none" },
    { inst: "tuba", degrees: [0, -1, 0], step: 0.4, oct: 2, vol: 1.3, dur: 0.9, quantize: "none" }],
  spotted: [{ inst: "horn", degrees: [0, 1], step: 0.22, oct: 3, vol: 1.2, dur: 0.6, quantize: "none" }],
  suggestion: [{ inst: "harp", degrees: [4, 7], step: 0.08, oct: 4, vol: 1, quantize: "step" }],
  perfect: [{ inst: "harp", degrees: [7, 11, 14], step: 0.05, oct: 4, vol: 1.3, quantize: "none" },
    { inst: "brass", degrees: [7], step: 0, oct: 3, vol: 0.8, dur: 0.5, quantize: "none" }],
});

/** The hysteresis (seconds / metres) the spec asks for, and the fades. */
export const RULES = Object.freeze({
  battleHold: 12,            // battle stays this long after the last shot or hit
  contactIn: 600, contactFor: 3,     // a hostile inside 600 m for 3 s running → contact
  contactOut: 700, contactLeave: 8,  // none inside 700 m for 8 s → calm
  dayIn: 0.55, dayOut: 0.45, fogIn: 0.65, fogOut: 0.5, lightSteady: 4,   // the day / night family, with a band
  bossHold: 15, stormIn: 3, stormHold: 10,
  fadeUp: 2, fadeDown: 4, fadeDanger: 0.6,   // layer fades (start on the next bar line)
  familyFade: 6, pieceFade: 4,               // whole-track changes (fade out on a bar line, then 1.5 s in)
  // The recorded beds' crossfades (seconds, in / out).
  toCombat: [2, 3], toCalm: [4, 4], light: [FADES.light, FADES.light], boss: [FADES.boss, FADES.boss], silence: [2.5, 2],
});
const MIN_FADE = 0.6;
const BAND_FADE_IN = 1.5;   // lib/music.js start(): the new track fades in over 1.5 s
const BOSS_CLS = new Set(["manowar", "gloam"]);

/**
 * Seconds from now to the playing track's next bar line (at least `min`; else the bar after), or null.
 * @param {object} band  RexGame.music
 */
export function toNextBar(band, min = MIN_FADE) {
  const c = band?.clock?.();
  if (!c || !c.playing || !(c.stepDur > 0) || !(c.steps > 0)) return null;
  const k = Math.max(0, Math.ceil((c.nextAt - c.now) / c.stepDur));   // steps between the sounding one and the next scheduled
  const internal = c.nextStep;                                        // the sequencer's step index at nextAt
  const sounding = internal - k;                                      // −1 before the first step sounds (c.step clamps it to 0)
  const line = (Math.floor(sounding / c.steps) + 1) * c.steps;        // the next bar line's step index
  let dt = c.nextAt + (line - internal) * c.stepDur - c.now;
  while (dt < min) dt += c.steps * c.stepDur;
  return dt;
}

/**
 * Build the score and start following the bus.
 * @param {{bus?: object|null}} [opts]
 */
export function createScore({ bus = null } = {}) {
  const M = { phase: "title", family: "day", intensity: "calm", layers: ["base", "pulse", "melody"], outcome: null, mission: null };
  let lastCombat = -1e9, disposed = false;
  // Hysteresis clocks (seconds, performance time).
  const H = { nearSince: null, nearLast: -1e9, near: Infinity, bossSeen: false, light: "day", lightWant: "day", lightSince: 0, bossLast: -1e9, stormSince: null, stormLast: -1e9 };
  let applied = { layers: null, track: null, switchAt: 0, pendingTimer: 0 };
  const lastSting = {};
  const offs = [];
  const now = () => performance.now() / 1000;

  const music = () => Kit()?.music || null;
  const muted = () => !!Kit()?.sfx?.muted?.();

  function owns() {
    let pick = null;
    try { pick = localStorage.getItem(PICK_KEY); } catch { /* private mode: the default */ }
    // A pick of one of the v3 synth tracks (no longer listed) counts as the default.
    return pick === null || pick === "" || pick === DEFAULT_TRACK || SYNTH_IDS.includes(pick);
  }

  // ---- The recorded score (v4) ----------------------------------------------------------------

  /** "loading" until the files are in, then "files", or "synth" (the fallback) if they never come. */
  let mode = "loading";
  let kitOff = false;          // the cog's Music "Off" (RexGame.music.stop) since the last play
  let fileBed = null, lastTickAt = -1e9;
  const player = createMusicPlayer({ log: (msg, data) => console.debug(`[rexmaw-raids] music: ${msg}`, data ?? "") });
  // The band's volume is the Music fader (mix.js); the raid's Master rides on top here.
  const levelOf = (v) => Math.max(0, Number(v) || 0) / KIT_DEFAULT_VOL * BED_GAIN * mix.level("master");
  const offMix = mix.on(() => player.setLevel(levelOf(music()?.volume?.() ?? KIT_DEFAULT_VOL)));

  /** Tap the kit band once: its volume, its duck and its play / stop reach the files too. */
  function hookBand() {
    const band = music();
    if (!band || band.__rrScore) return;
    const { setVolume, duck: kitDuck, play, stop } = band;
    if (typeof setVolume === "function") band.setVolume = function (v) { const r = setVolume.call(this, v); player.setLevel(levelOf(v)); return r; };
    if (typeof kitDuck === "function") band.duck = function (s) { player.duck(s); return kitDuck.call(this, s); };
    if (typeof play === "function") band.play = function (id, o) { if (OURS.includes(id)) kitOff = false; const r = play.call(this, id, o); setTimeout(() => update(), 0); return r; };
    if (typeof stop === "function") band.stop = function () { kitOff = true; const r = stop.call(this); setTimeout(() => update(), 0); return r; };
    Object.defineProperty(band, "__rrScore", { value: true });
    player.setLevel(levelOf(band.volume?.() ?? KIT_DEFAULT_VOL));
  }
  hookBand();
  player.load().then((ok) => {
    if (disposed) return;
    mode = ok ? "files" : "synth";
    console.debug(`[rexmaw-raids] music: ${ok ? "recorded score ready" : `files unavailable (${player.failed}); the synth band plays`}`);
    update();
  });

  /** Which bed: the boss, combat (contact or battle), else the light's. Null when the music is off. */
  function wantBed(family, intensity) {
    if (!owns() || kitOff) return null;
    if (family === "boss") return "boss";
    if (intensity !== "calm" && !M.outcome) return "combat";
    return H.light === "night" ? "night" : "day";
  }

  function updateFiles(family, intensity) {
    const band = music();
    if (player.status === "failed") {   // a decode failed once playing: hand over to the synth band
      mode = "synth"; fileBed = null; player.want(null, { fade: 1 });
      return false;
    }
    // Nothing synthesised plays over the files; the silent score track carries the clock and the key.
    const playing = band?.playing?.();
    if (band && SYNTH_IDS.includes(playing) && owns() && !kitOff) band.play(SCORE_ID);
    const bed = wantBed(family, intensity);
    if (bed !== fileBed) {
      const f = !bed || !fileBed ? RULES.silence
        : bed === "boss" || fileBed === "boss" ? RULES.boss
          : bed === "combat" ? RULES.toCombat
            : fileBed === "combat" ? RULES.toCalm : RULES.light;
      player.want(bed, { fadeIn: f[0], fadeOut: f[1] });
      fileBed = bed;
      const k = bed && player.keyOf(bed), tr = band?.TRACKS?.[SCORE_ID];
      if (k && tr && !Object.isFrozen(tr)) Object.assign(tr, k);
    } else player.poke();
    // Decode what's likely next while there's time: combat with a hostile closing, the boss once one shows.
    if (fileBed && fileBed !== "combat" && H.near < 1200) player.prepare(["combat"]);
    if (fileBed && fileBed !== "boss" && H.bossSeen) player.prepare(["boss"]);
    M.family = family; M.intensity = intensity; M.layers = null;
    return true;
  }

  // ---- Deciding --------------------------------------------------------------------------

  // The light, with a band either side and 4 s of steadiness, so fog banks and dusk don't flip the family back and forth.
  function lightOf(s, t) {
    const day = Number.isFinite(s?.daylight) ? s.daylight : (s?.mission?.time === "night" ? 0 : 1);
    const fog = Number(s?.fog?.density) || 0;
    const wasDay = H.light === "day";
    const isDay = wasDay ? day >= RULES.dayOut && fog <= RULES.fogIn : day >= RULES.dayIn && fog <= RULES.fogOut;
    const want = isDay ? "day" : "night";
    if (want !== H.lightWant) { H.lightWant = want; H.lightSince = t; }
    if (want !== H.light && t - H.lightSince >= RULES.lightSteady) H.light = want;
    return H.light;
  }

  /** The family (the track) for this snapshot: day / night by the light, boss and storm as set pieces. */
  function wantFamily(s, t) {
    if (!s || s.phase === "title") {
      // The title follows the chosen mission's light at once (no steadiness wait there).
      const day = !Number.isFinite(s?.daylight) || s.daylight >= 0.5;
      H.light = H.lightWant = day ? "day" : "night";
      return H.light;
    }
    const light = lightOf(s, t);
    if (M.outcome || s.phase === "moored" || s.phase === "briefing" || s.phase === "results") return light;
    let boss = false;
    for (const c of s.contacts || []) {
      if (!c || c.detected === false || c.state === "surrender" || c.state === "sinking" || !BOSS_CLS.has(c.cls)) continue;
      H.bossSeen = true;
      const d = Number.isFinite(c.dist) ? c.dist : 9e9;
      if ((d < 900 && !c.cloaked) || (c.objective && d < 1200)) boss = true;
    }
    if (s.hazards?.kraken && s.hazards.kraken.stage !== "retreat") boss = true;
    // v5 Kraken's Wake: the Kraken's eye above the water (the hold carries the bed through its dives).
    const eye = s.objective?.eye;
    if (eye && eye.stage !== "down") { boss = true; H.bossSeen = true; }
    if (boss) H.bossLast = t;
    if (t - H.bossLast < RULES.bossHold) return "boss";
    if (s.storm?.inside) { H.stormSince ??= t; H.stormLast = t; } else H.stormSince = null;
    if ((H.stormSince != null && t - H.stormSince >= RULES.stormIn) || (M.family === "storm" && t - H.stormLast < RULES.stormHold)) return "storm";
    return light;
  }

  /** calm · contact · battle, with the spec's hysteresis. */
  function wantIntensity(s, t) {
    if (!s || M.outcome || !["sailing", "boarding", "ending"].includes(s.phase)) { H.near = Infinity; return "calm"; }
    if (s.phase === "boarding") lastCombat = t;
    let near = Infinity;
    for (const c of s.contacts || []) {
      if (!c || c.detected === false || c.hostile === false || c.state === "surrender" || c.state === "sinking" || c.fixed) continue;
      near = Math.min(near, Number.isFinite(c.dist) ? c.dist : 9e9);
    }
    H.near = near;
    if (near < RULES.contactIn) { H.nearSince ??= t; } else H.nearSince = null;
    if (near < RULES.contactOut) H.nearLast = t;
    if (t - lastCombat < RULES.battleHold) return "battle";
    const contactNow = (H.nearSince != null && t - H.nearSince >= RULES.contactFor)
      || (M.intensity !== "calm" && t - H.nearLast < RULES.contactLeave);
    return contactNow ? "contact" : "calm";
  }

  function wantLayers(s, family, intensity) {
    if (M.outcome === "fail") return ["base"];
    if (M.outcome === "success" || s?.phase === "results") return ["base", "pulse", "melody", "drive"];
    if (!s || s.phase === "title") return [...INTENSITY.calm.underway];
    if (s.phase === "moored" || s.phase === "briefing") return [...INTENSITY.calm.moored];
    const ship = s.ship || {}, hz = s.hazards || {};
    let on;
    if (intensity === "battle") on = [...(family === "night" ? INTENSITY.nightBattle : INTENSITY.battle)];
    else if (intensity === "contact") on = [...INTENSITY.contact];
    else on = [...((Number(ship.speed) || 0) > 1.5 || (Number(ship.sail) || 0) >= 1 ? INTENSITY.calm.underway : INTENSITY.calm.still)];
    // Set pieces always run with their drive (they ARE the fight); a sprint at sea adds the push.
    if ((family === "boss" || family === "storm") && !on.includes("drive")) on.push("drive");
    const dist = (c) => (Number.isFinite(c?.dist) ? c.dist : 9e9);
    const portsNear = (s.contacts || []).some((c) => c?.portsOpen && (c.portsOpen.port || c.portsOpen.starboard) && dist(c) < 400);
    const ram = (s.contacts || []).some((c) => (c?.state === "ram" || (c?.cls === "fireship" && c.lit)) && dist(c) < 300);
    const hullLow = (Number(ship.hull) || 0) / Math.max(1, Number(ship.hullMax) || 100) < 0.3;
    const mortarOnUs = (hz.mortars || []).some((m) => m && m.from !== "rexmaw" && Number.isFinite(m.x) && Math.hypot(m.x - ship.x, m.z - ship.z) < (m.r || 20) + 25);
    if (portsNear || ram || mortarOnUs || (hz.wave && hz.wave.eta < 12) || (Number(ship.water) || 0) >= 40 || hullLow || (Number(ship.fires) || 0) > 0) on.push("danger");
    return on;
  }

  /**
   * Change the whole track (a new family): wait for the playing track's next bar line, fade it out
   * across `fade − 1.5` s, and the band fades the next one in over its own 1.5 s.
   */
  function switchTo(band, track, layers, fade) {
    clearTimeout(applied.pendingTimer);
    const toBar = toNextBar(band, 0.05) ?? 0;
    const out = Math.max(MIN_FADE, fade - BAND_FADE_IN);
    applied.track = track;
    applied.switchAt = performance.now() + (toBar + out + 0.2) * 1000;
    applied.layers = layers.join(",");
    // With a track playing, play() starts its fade first, so layers() holds the set for the next track
    // instead of re-layering the outgoing one; with none, the set is in place before the track starts.
    const go = () => {
      if (disposed || applied.track !== track) return;
      const fading = !!band.playing?.();
      if (!fading) band.layers(layers);
      band.play(track, { fadeOut: out });
      if (fading) band.layers(layers);
    };
    if (band.playing?.() && toBar > 0.05) applied.pendingTimer = setTimeout(go, toBar * 1000); else go();
  }

  let lastState = null;
  function update(s = lastState) {
    if (disposed) return;
    hookBand();
    const band = music();
    if (mode !== "synth") {
      // The recorded score (or its files still loading: the hysteresis clocks run meanwhile).
      const t = now();
      const family = wantFamily(s, t);
      const intensity = wantIntensity(s, t);
      if (mode === "loading" || updateFiles(family, intensity)) return;
    }
    if (!band?.layers) return;
    if (!owns()) {
      if (applied.layers !== null) { band.layers(null); applied.layers = null; }
      return;
    }
    const t = now();
    const family = wantFamily(s, t);
    const intensity = wantIntensity(s, t);
    const L = wantLayers(s, family, intensity);
    const track = T[family];
    const playing = band.playing?.();
    const ours = !playing || OURS.includes(playing);
    // A family change: one fade of the whole track (never on an intensity flip).
    if (ours && playing && playing !== track && applied.track !== track) {
      const piece = family === "boss" || family === "storm" || M.family === "boss" || M.family === "storm";
      switchTo(band, track, L, piece ? RULES.pieceFade : RULES.familyFade);
      M.family = family; M.intensity = intensity; M.layers = L;
      return;
    }
    M.family = family;
    if (performance.now() < applied.switchAt) return;   // a switch is in flight: its layers are already asked for
    applied.track = playing || applied.track;
    const key = L.join(",");
    if (key !== applied.layers) {
      const prev = String(applied.layers || "").split(",");
      const added = L.filter((x) => !prev.includes(x));
      const fade = added.includes("danger") && added.length === 1 ? RULES.fadeDanger : added.length ? RULES.fadeUp : RULES.fadeDown;
      band.layers(L, { fade });
      applied.layers = key;
    }
    M.intensity = intensity;
    M.layers = L;
  }

  // ---- Following the raid ----------------------------------------------------------------------

  const combat = () => { lastCombat = now(); };
  const guns = combat;
  if (bus?.on) {
    offs.push(bus.on("tick", (s) => { lastState = s; lastTickAt = now(); M.phase = s?.phase || M.phase; update(s); }));
    offs.push(bus.on("view", ({ name } = {}) => { if (name === "title") { M.outcome = null; lastState = null; update(null); } }));
    offs.push(bus.on("volley", () => { guns(); update(); }));
    offs.push(bus.on("impact", (p = {}) => { if (p.target === "rexmaw" && p.kind !== "splash") combat(); }));
    offs.push(bus.on("ports", () => combat()));
    offs.push(bus.on("sink", (p = {}) => stinger(p.cls === "tower" ? "tower" : "sink")));
    offs.push(bus.on("surrender", () => stinger("surrender")));
    offs.push(bus.on("bank", () => stinger("bank")));
    offs.push(bus.on("board", (p = {}) => { if (p.stage === "won") stinger("board_won"); else if (p.stage === "lost") stinger("board_lost"); else if (p.stage === "start") { guns(); update(); } }));
    offs.push(bus.on("heat", (p = {}) => { if ((p.level || 0) > (p.prev || 0)) stinger("heat"); }));
    offs.push(bus.on("hazard", (p = {}) => { if (p.kind === "kraken" && (p.stage === "grab" || p.stage === "rise")) { stinger("kraken"); update(); } }));
    offs.push(bus.on("contact", (p = {}) => { if (p.stage === "appear" && BOSS_CLS.has(p.cls)) stinger("legendary"); }));
    offs.push(bus.on("spotted", (p = {}) => { if (p.stage === "spotted") { stinger("spotted"); combat(); update(); } }));
    offs.push(bus.on("suggestion", (p = {}) => { if (p.stage === "open") stinger("suggestion"); }));
    offs.push(bus.on("proposal", (p = {}) => { if (p.stage === "open") stinger("suggestion"); }));
    offs.push(bus.on("objective", (p = {}) => { if (p.stage === "done") stinger("objective"); }));
    offs.push(bus.on("pickup", (p = {}) => { if (p.kind === "chest") stinger("chest"); }));
    offs.push(bus.on("brace", (p = {}) => { if (p.perfect) stinger("perfect"); }));
    offs.push(bus.on("mission", (p = {}) => {
      if (p.stage === "success" || p.stage === "fail") { M.outcome = p.stage; stinger(p.stage === "success" ? "victory" : "fail"); update(); }
      else if (p.stage === "start") { M.outcome = null; M.mission = p.id || null; }
    }));
    offs.push(bus.on("end", (p = {}) => {
      if (M.outcome) return;   // the mission event said it already
      const ok = p.reason === "home" || p.reason === "retired" || p.reason === "objective" || p.outcome === "success";
      M.outcome = ok ? "success" : "fail";
      stinger(ok ? "victory" : "fail");
      update();
    }));
    offs.push(bus.on("intent", ({ name } = {}) => { if (name === "start" || name === "again" || name === "quit") { M.outcome = null; lastCombat = -1e9; H.nearSince = null; H.nearLast = -1e9; H.bossLast = -1e9; H.stormSince = null; H.bossSeen = false; } }));
    offs.push(bus.on("say", (p) => {
      const words = String(p?.text ?? p ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (words) duck(Math.min(9, 0.8 + words * 0.36));
    }));
    offs.push(bus.on("tally", (p = {}) => tallyStep(p)));
  }
  // Between ticks (the title, the results, a pause) the score still follows the light's hysteresis and the cog.
  const idle = setInterval(() => { if (now() - lastTickAt > 1) update(); }, 500);
  // The AudioContext exists only after the first gesture (main gates it): start the bed then.
  const onGesture = () => setTimeout(() => update(), 0);
  for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, onGesture, { capture: true, passive: true });
  offs.push(() => { clearInterval(idle); for (const ev of ["pointerdown", "keydown", "touchend"]) removeEventListener(ev, onGesture, { capture: true }); });

  // ---- Stingers, ducking and tallies ------------------------------------------------------------

  function stinger(id) {
    // The recorded score has its own victory and defeat stings (music, so the music's on/off rules them, not the effects mute).
    if (mode === "files" && (id === "victory" || id === "fail")) {
      if (disposed || !owns() || kitOff) return null;
      const t = performance.now();
      if (t - (lastSting[id] ?? -Infinity) < 600) return null;
      lastSting[id] = t;
      player.sting(id === "fail" ? "defeat" : "victory");
      return t;
    }
    const parts = STINGERS[id], band = music();
    if (!parts || !band?.stinger || muted() || disposed) return null;
    const t = performance.now();
    if (t - (lastSting[id] ?? -Infinity) < 600) return null;
    lastSting[id] = t;
    let at = null;
    for (const p of parts) {
      const when = band.stinger(at == null ? p : { ...p, at });
      if (at == null) at = when;
    }
    return at;
  }

  /** Duck the band for a number of seconds. */
  function duck(seconds = 2.5) {
    hookBand();
    const band = music();
    const len = Math.max(0.5, Number(seconds) || 2.5);
    // Through the band's (tapped) duck, which ducks the files too; without a kit band, the files directly.
    if (!band?.duck) { player.duck(len); return; }
    try { band.duck(len); } catch { /* the band may not be playing */ }
  }

  const tickDegree = (i) => [0, 2, 4][i % 3] + 7 * (Math.floor(i / 3) % 2);

  /** The results card's tally (results.js emits `tally` steps): plucks rising, a horn per medal, a chord on the total. */
  function tallyStep(p) {
    const band = music();
    if (!band?.stinger || muted() || disposed) return;
    if (p.medal) {
      const deg = p.medal === "gold" ? [7, 9, 11] : p.medal === "silver" ? [4, 7] : [0, 4];
      band.stinger({ inst: "harp", degrees: deg, step: 0.05, oct: 4, vol: 1.4, quantize: "none" });
      band.stinger({ inst: "horn", degrees: [deg[deg.length - 1]], oct: 3, vol: 0.8, dur: 0.8, quantize: "none" });
      return;
    }
    if (Number.isFinite(p.banked) || Number.isFinite(p.loot)) { if ((p.banked || p.loot) > 0) band.stinger({ inst: "harp", degrees: [0, 4, 7], step: 0.06, oct: 4, vol: 1.3, quantize: "none" }); return; }
    if (p.star) { band.stinger({ inst: "harp", degrees: [7 + [0, 2, 4][(p.star - 1) % 3]], oct: 4, vol: 1.6, quantize: "none" }); return; }
    if (p.final) {
      band.stinger({ inst: "brass", degrees: [0, 4, 7], step: 0, oct: 3, vol: 1.1, quantize: "none", dur: 1.2 });
      band.stinger({ inst: "harp", degrees: [-7, -3, 0, 4, 7], step: 0.02, oct: 4, vol: 1.2, quantize: "none" });
      return;
    }
    band.stinger({ inst: "nylon", degrees: [tickDegree(p.step || 0)], oct: 4, vol: 1.4, quantize: "none", dur: 0.4 });
  }

  const api = {
    stinger,
    owns,
    state: () => ({ ...M, owns: owns(), mode, kitOff, bed: fileBed, files: player.state(),
      layers: mode === "synth" ? applied.layers : null, track: mode === "synth" ? T[M.family] : null, light: H.light }),
    /** The recorded score's player (tests and debug). */
    player,
    dispose() {
      disposed = true;
      offMix();
      offs.forEach((off) => { try { off?.(); } catch { /* gone */ } });
      player.dispose();
    },
  };

  const band = music();
  if (band?.STINGERS) for (const [id, parts] of Object.entries(STINGERS)) band.STINGERS[`rexmaw-raids:${id}`] = parts[0];
  update(null);
  return api;
}
