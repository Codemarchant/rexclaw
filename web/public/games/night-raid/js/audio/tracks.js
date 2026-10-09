// Rexmaw Raids' music for the kit's band (lib/music.js), registered in
// RexGame.music.TRACKS the moment this module loads (main imports this file
// first, before protocol.js creates the game):
//
//   music: TRACK_IDS   // ["rr-score"]: what the kit's cog offers
//
// v4 (§5): the raid's music is recorded now (audio/music.js plays the files in
// assets/music/; score.js steers it). The cog's Music picker offers one entry,
// "Rexmaw Raids score" (SCORE_ID), a SILENT band track: picking it (the
// default) lets the score play, "Off" stops it, and the cog's Volume slider
// sets its level; while it runs the band's clock and key (set to the playing
// file's) keep the kit's stingers in tune. The kit starts it on the first
// gesture as it would any track, so it never fights the files.
//
// The synthesised tracks below stay registered (not listed in the cog) as the
// FALLBACK: when the files can't be fetched or decoded, score.js plays these
// exactly as v3 did.
//
// v3 (§D16): each time of day is ONE track family whose intensities are layers
// over a shared groove, so calm → contact → battle never stops the band or
// starts a tune from the top: score.js fades layers in and out on bar lines
// (2–4 s). Only a change of family (day ⇄ night, over 6 s) or a set piece
// (the boss, the storm cell) changes the track itself.
//
//   base     harmony and bass: always on (the groove every intensity shares)
//   pulse    the rhythm that says "under way"
//   melody   the tune (calm and contact; it stays in battle by day)
//   tension  contact: a watchful low ostinato and a far drum, same key
//   drive    battle: the push (stomp / kick, low brass stabs)
//   drums    battle: war drums (guns in the last seconds, boarding)
//   danger   a telegraph close by (ports open, a ram, a mortar ring), water rising
//
// Voiced warm on purpose (v2 §6): no noise "waves" bed, no bells, celesta,
// music box or accordion; leads are the bowed "cello" voice in the low-fiddle
// register (octave 3), chords are plucked (harp), brass stabs sit low
// (octave 3), the frame drum is the tom and stomp.

/** The silent band track that stands for the recorded score in the kit's cog. */
export const SCORE_ID = "rr-score";
/** What the kit's cog lists (main passes it as `music:`): the recorded score only. */
export const TRACK_IDS = Object.freeze([SCORE_ID]);
/** The synthesised tracks (the fallback when the files don't load), day first. */
export const SYNTH_IDS = Object.freeze(["rr-day-sail", "rr-night-sail", "rr-boss", "rr-storm"]);

/** The layers each intensity sounds, per family (score.js adds `danger` on top when a threat is close). */
export const INTENSITY = Object.freeze({
  calm: { moored: ["base", "melody"], still: ["base", "melody"], underway: ["base", "pulse", "melody"] },
  contact: ["base", "pulse", "melody", "tension"],
  battle: ["base", "pulse", "melody", "tension", "drive", "drums"],
  nightBattle: ["base", "pulse", "tension", "drive", "drums"],
});

/** The tracks, as data for lib/music.js (see its header for the fields). */
export const TRACKS = Object.freeze({
  // No parts: the band's sequencer runs (clock, key) but plays nothing. score.js
  // sets key/scale to the playing file's so stingers land in tune.
  [SCORE_ID]: { name: "Rexmaw Raids score", bpm: 96, beat: 4, steps: 16, key: "A", scale: "minor", seed: 1, chords: ["Am"], parts: [] },
  // Sun on the water: a 6/8 shanty, a bowed fiddle tune over plucked chords and a frame drum.
  // Contact keeps the tune and adds a low cello ostinato and a far timpani; battle adds the stomp, low brass and drums.
  "rr-day-sail": {
    name: "Fair Wind", bpm: 108, beat: 3, steps: 6, key: "D", scale: "major", seed: 307, reverb: 0.25,
    chords: ["D", "G", "D", "A", "Bm", "G", "A", "D"],
    parts: [
      { layer: "base", inst: "bass", rhythm: "x..x..", seq: [0, 2], oct: 2, vol: 0.75 },
      { layer: "base", inst: "pad", rhythm: "x.....", chordHold: 6, oct: 3, vol: 0.2 },
      { layer: "pulse", inst: "harp", rhythm: "x.xx.x", arp: "up", oct: 3, vol: 0.42 },
      { layer: "pulse", drum: "tom", rhythm: "x..x.x", vol: 0.42 },
      { layer: "melody", inst: "cello", melody: "x.xx.x", oct: 3, vol: 0.78 },
      { layer: "tension", inst: "cello", rhythm: "x.x.x.", seq: [0, 0, 2], oct: 2, vol: 0.42 },
      { layer: "tension", drum: "timpani", rhythm: "x.....", vol: 0.35 },
      { layer: "drive", drum: "stomp", rhythm: "x..x..", vol: 0.62 },
      { layer: "drive", inst: "brass", rhythm: "x....x", chordStab: true, oct: 3, vol: 0.36 },
      { layer: "drums", drum: "timpani", rhythm: "x..x.x", vol: 0.6 },
      { layer: "drums", drum: "snare", rhythm: "...x..", vol: 0.3 },
      { layer: "danger", drum: "snareroll", rhythm: "....xx", vol: 0.26 },
      { layer: "danger", inst: "horn", rhythm: "x.....", chordHold: 6, oct: 3, vol: 0.38 },
    ],
  },
  // Moonlight and fog: slow low strings, a pad that breathes, a few plucked notes, a soft heartbeat.
  // Contact: the heartbeat quickens into a cello ostinato; battle: kick, low brass, war drums at the same tempo.
  "rr-night-sail": {
    name: "Lantern Watch", bpm: 76, beat: 4, steps: 16, key: "D", scale: "dorian", seed: 311, reverb: 0.45,
    chords: ["Dm", "Dm", "C", "Am", "Bb", "F", "C", "Dm"],
    parts: [
      { layer: "base", inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.36 },
      { layer: "base", inst: "bass", rhythm: "x.......x.......", seq: [0, 2], oct: 2, vol: 0.55 },
      { layer: "pulse", inst: "harp", rhythm: "x...x...x...x...", arp: "up", oct: 3, vol: 0.33 },
      { layer: "pulse", drum: "softkick", rhythm: "x.........x.....", vol: 0.34 },
      { layer: "melody", inst: "cello", melody: "x.......x...x...", oct: 3, vol: 0.72 },
      { layer: "tension", inst: "cello", rhythm: "x.x.x.x.x.x.x.x.", seq: [0, 0, 2, 0], oct: 2, vol: 0.34 },
      { layer: "tension", drum: "timpani", rhythm: "x.......x.......", vol: 0.38 },
      { layer: "drive", drum: "kick", rhythm: "x.....x...x.....", vol: 0.7 },
      { layer: "drive", inst: "brass", rhythm: "x.......x.......", chordStab: true, oct: 3, vol: 0.34 },
      { layer: "drums", drum: "tom", rhythm: "x..x..x...x..x..", vol: 0.5 },
      { layer: "drums", drum: "timpani", rhythm: "....x.......x.x.", vol: 0.55 },
      { layer: "danger", drum: "snareroll", rhythm: "............xxxx", vol: 0.26 },
      { layer: "danger", inst: "choir", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.24 },
    ],
  },
  // The big ones: the Iron Duke, the Gloam, the Kraken. Tuba and a low choir under racing cellos.
  "rr-boss": {
    name: "Iron and Fog", bpm: 120, beat: 4, steps: 16, key: "D", scale: "harmonic", seed: 331, reverb: 0.4,
    chords: ["Dm", "Bb", "Gm", "A7", "Dm", "Bb", "Eb", "A7"],
    parts: [
      { layer: "base", inst: "tuba", rhythm: "x.......x.......", seq: [0, 2], oct: 2, vol: 0.8 },
      { layer: "base", inst: "pad", rhythm: "x...............", chordHold: 16, oct: 2, vol: 0.35 },
      { layer: "pulse", inst: "cello", rhythm: "xxxxxxxxxxxxxxxx", seq: [0], oct: 2, vol: 0.5 },
      { layer: "melody", inst: "horn", melody: "x.......x...x...", oct: 3, vol: 0.65 },
      { layer: "tension", inst: "choir", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.26 },
      { layer: "drive", drum: "kick", rhythm: "x...x...x...x...", vol: 0.85 },
      { layer: "drive", inst: "brass", rhythm: "x.....x.....x...", chordStab: true, oct: 3, vol: 0.4 },
      { layer: "drums", drum: "timpani", rhythm: "x.x.x..xx.x.x..x", vol: 0.9 },
      { layer: "drums", drum: "tom", rhythm: "..x...x...x...xx", vol: 0.55 },
      { layer: "danger", drum: "snareroll", rhythm: "............xxxx", vol: 0.3 },
    ],
  },
  // Inside the storm cell: a minor pad heaving like the swell, plucked rain, the cello low.
  "rr-storm": {
    name: "Squall Line", bpm: 100, beat: 4, steps: 16, key: "C", scale: "minor", seed: 337, reverb: 0.45,
    chords: ["Cm", "Cm", "Ab", "G7", "Fm", "Cm", "Ab", "G7"],
    parts: [
      { layer: "base", inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.4 },
      { layer: "base", inst: "bass", rhythm: "x.......x..x....", seq: [0, 0, 2], oct: 2, vol: 0.7 },
      { layer: "pulse", inst: "harp", rhythm: "x.x.x.x.x.x.x.x.", arp: "up", oct: 3, vol: 0.38 },
      { layer: "melody", inst: "cello", melody: "x.......x...x...", oct: 3, vol: 0.8 },
      { layer: "tension", inst: "cello", rhythm: "x.x.x.x.x.x.x.x.", seq: [0], oct: 2, vol: 0.45 },
      { layer: "drive", drum: "softkick", rhythm: "x.....x...x.....", vol: 0.8 },
      { layer: "drive", drum: "tom", rhythm: "......x.......xx", vol: 0.45 },
      { layer: "drums", drum: "timpani", rhythm: "x..x..x...x..x..", vol: 0.75 },
      { layer: "danger", drum: "timpani", rhythm: "x.......x.......", vol: 0.6 },
    ],
  },
});

// Register with the band now (before the first gesture and before RexGame.create).
const band = globalThis.RexGame?.music;
if (band?.TRACKS) {
  // A copy of the score's entry: score.js retunes its key/scale while files play.
  for (const id of [SCORE_ID, ...SYNTH_IDS]) band.TRACKS[id] = id === SCORE_ID ? { ...TRACKS[id] } : TRACKS[id];
} else {
  console.debug("[rexmaw-raids] the band (lib/music.js) isn't loaded; the game's tracks are not registered");
}
