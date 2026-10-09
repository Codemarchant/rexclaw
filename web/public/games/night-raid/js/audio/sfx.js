// Rexmaw Raids' sound effects (v2 spec §3/§6): every one synthesised, rendered
// once with an OfflineAudioContext behind the title, then played from memory
// (Night Helm's bank and recipe parts, with the raid's guns, hits, weather,
// the Kraken, and v2's gunnery: the broadside roll, heavy shot, mortars, fire
// barrels, hit thuds, collectables, the sprint, gulls and buoy bells).
// v2 softened every sustained high ping (whizz, perfect brace, coins,
// spyglass, hammer, clash, mortar whistle): no glassy FM rings any more.
//
//   const sfx = createSfx({ R });
//   await sfx.ready;                                  // optional: play() before it is a no-op
//   sfx.play("cannon_near", { pan: 0.7 });            // a starboard gun
//   sfx.play("cannon_far", { at: {x, y, z} });        // positional through the camera's listener
//   const f = sfx.loop("fire", { gain: 0 });          // a held loop: f.gain(0.8, 1.5), f.at(pos), f.stop(2)
//   sfx.volley({ side: "starboard", balls: 7 });      // a broadside rippling down one side + its roll
//   sfx.heavyVolley({ side: "port" });                // the heavy close volley
//   sfx.strikes(4);                                   // the ship's bell in pairs
//   sfx.wire(bus);                                    // the raid's events play themselves (see wire())
//
// Layered guns: a near gun is a crack + a chest-thump boom + a rolling tail;
// a far gun loses the crack and the highs and rolls off the bay's islands.
// Routing: each voice → (panner) → the SFX bus (0.55, as juice.js) →
// speakers, plus a send into the "sea" convolver (the "bay" one for far
// sounds). The kit's mute is checked on every play.

import { SR, graph, render, finish, loopify, db } from "./dsp.js";
import { mix } from "./mix.js";

const Kit = () => globalThis.RexGame || null;

/** v4.2 power-ups: the arpeggio's pitch per kind, and a touch of what it does ([effect, gain, delay ms]). */
const PW_PITCH = Object.freeze({ swift_wind: 1.12, quick_hands: 1.06, hot_shot: 0.94, iron_hull: 0.84, patch_kit: 1, powder_keg: 0.89, double_doubloons: 1.19,
  kraken_ink: 0.79, mermaid_kiss: 1.26 });
const PW_EXTRA = Object.freeze({ swift_wind: ["fill", 0.8, 150], quick_hands: ["ports", 0.6, 160], hot_shot: ["barrel_ignite", 0.45, 140], iron_hull: ["brace_thud", 0.6, 120],
  patch_kit: ["hammer", 0.55, 200], powder_keg: ["barrel_drop", 0.7, 150], double_doubloons: ["coins", 0.9, 250], kraken_ink: ["tremor", 0.45, 100],
  mermaid_kiss: ["dolphin", 0.5, 250] });
const BELL_HZ = 587;
const RR = [1, 1.03, 0.97, 1.015, 0.985, 1.025, 0.975];   // ±3 % round-robin
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// ---- Recipe parts (Night Helm's) -----------------------------------------------------------

function bellStrike(h, t, f, dest, amp = 1) {
  const end = t + 6;
  const a = h.gain(0, dest); h.strike(a.gain, t, 0.3 * amp, 0.002, 1.6); h.fm(f, 1.4, 5, 0.5, 3, t, end, a);
  const b = h.gain(0, dest); h.strike(b.gain, t, 0.22 * amp, 0.002, 1.45); h.fm(f * 2 ** (3 / 1200), 1.4, 5, 0.5, 3, t, end, b);
  const hum = h.gain(0, dest); h.strike(hum.gain, t, 0.09 * amp, 0.012, 2.6); h.osc("sine", f / 2, t, end, hum);
  const third = h.gain(0, dest); h.strike(third.gain, t, 0.045 * amp, 0.002, 0.8); h.osc("sine", f * 1.19, t, end, third);
  const k = h.gain(0, dest); h.strike(k.gain, t, 0.55 * amp, 0.0008, 0.005);
  h.noise("white", t, t + 0.04, h.filter("bandpass", 3000, 2.2, k));
}

function bubble(h, t, dest, { lo = 400, hi = 1200, len = 0.06, amp = 0.12, pan = 0 } = {}) {
  const g = h.gain(0, h.pan(pan, dest));
  h.strike(g.gain, t, amp, 0.004, len / 2.5);
  const o = h.osc("sine", lo, t, t + len * 3, g);
  o.frequency.setValueAtTime(lo, t); o.frequency.exponentialRampToValueAtTime(hi, t + len);
}

function crinkle(param, t0, t1, { every = [0.012, 0.03], lo = 0, hi = 1, smooth = 0.004 } = {}) {
  let t = t0;
  param.setValueAtTime(lo, t0);
  while (t < t1) {
    param.setTargetAtTime(lo + Math.random() ** 1.5 * (hi - lo), t, smooth);
    t += every[0] + Math.random() * (every[1] - every[0]);
  }
  param.setTargetAtTime(0, t1, smooth);
}

function splashAt(h, t, dest, { amp = 0.6, pan = 0, size = 1 } = {}) {
  const out = h.pan(pan, dest);
  const g = h.gain(0, out); h.swell(g.gain, t, 0.012, amp, 0.04 * size, 0.35 * size);
  const lp = h.filter("lowpass", 5000, 0.6, g);
  lp.frequency.setValueAtTime(5200, t); lp.frequency.exponentialRampToValueAtTime(700, t + 0.45 * size);
  h.noise("white", t, t + 0.6 * size, lp);
  const th = h.gain(0, out); h.strike(th.gain, t, 0.5 * amp, 0.003, 0.05 * size);
  const o = h.osc("sine", 110, t, t + 0.3, th); o.frequency.exponentialRampToValueAtTime(55, t + 0.15);
  for (let i = 0; i < 8 * size; i++) bubble(h, t + 0.08 + Math.random() * 0.5 * size, out, { lo: 300 + Math.random() * 300, hi: 900 + Math.random() * 700, amp: 0.05 + Math.random() * 0.05 });
}

function groan(h, t, len, dest, { hz = 120, amp = 0.6 } = {}) {
  const g = h.gain(0, dest); h.swell(g.gain, t, len * 0.3, amp, len * 0.3, len * 0.4);
  const bp = h.filter("bandpass", hz, 10, g);
  bp.frequency.setValueAtTime(hz, t); bp.frequency.linearRampToValueAtTime(hz * 0.7, t + len);
  const saw = h.osc("sawtooth", 18, t, t + len, h.gain(0.8, bp)); saw.frequency.linearRampToValueAtTime(30, t + len);
  h.noise("brown", t, t + len, h.gain(0.4, bp));
}

/** Splinters: a scatter of short bright wood cracks. */
function splinterBurst(h, t, dest, { n = 14, spread = 0.5, amp = 1 } = {}) {
  for (let i = 0; i < n; i++) {
    const tt = t + Math.random() ** 1.6 * spread, g = h.gain(0, h.pan(Math.random() * 1.4 - 0.7, dest));
    h.strike(g.gain, tt, (0.2 + Math.random() * 0.35) * amp, 0.0004, 0.004 + Math.random() * 0.012);
    h.noise("white", tt, tt + 0.04, h.filter("bandpass", 2200 + Math.random() * 4200, 3.5, g));
  }
}

/** A cannon's body: the boom (a sine dropping an octave), its chest thump, and a long rolling tail. */
function boom(h, t, dest, { hz = 58, amp = 1, roll = 1.6, rollHz = 200 } = {}) {
  const b = h.gain(0, dest); h.strike(b.gain, t, amp, 0.003, 0.32);
  h.osc("sine", hz, t, t + 1.6, b).frequency.exponentialRampToValueAtTime(hz * 0.52, t + 0.6);
  h.noise("brown", t, t + 1.4, h.filter("lowpass", 360, 0.7, h.gain(1.2, b)));
  const r = h.gain(0, dest); h.swell(r.gain, t + 0.1, 0.3, 0.5 * amp, roll * 0.4, roll);
  h.noise("brown", t + 0.1, t + 0.4 + roll * 1.6, h.filter("lowpass", rollHz, 0.7, r));
}

// ---- Recipes ---------------------------------------------------------------------------------
// seconds, channels, level (gain after peak-normalising), verb (room send × 0.25), jitter
// (round-robin pitch), ref (panner reference distance, m), gap (min ms between plays), rate,
// loop (seamless), room ("bay" sends to the long room).

const RECIPES = {
  cannon_near: { seconds: 3.2, channels: 2, level: 0.95, verb: 0.8, ref: 18, gap: 25, build(h) {
    // A gun at the rail: the muzzle crack, the boom you feel, smoke rolling, the carriage slamming back.
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0004, 0.018);
    h.noise("white", 0, 0.05, h.filter("highpass", 800, 0.7, c));
    boom(h, 0, h.out, { hz: 56, amp: 1, roll: 1.4, rollHz: 220 });
    const k = h.gain(0, h.pan(-0.2, h.out)); h.strike(k.gain, 0.09, 0.35, 0.002, 0.05);   // the carriage recoil
    h.osc("triangle", 140, 0.09, 0.4, k).frequency.exponentialRampToValueAtTime(90, 0.2);
    h.noise("brown", 0.09, 0.3, h.filter("lowpass", 600, 0.7, h.gain(0.6, k)));
  } },

  cannon_far: { seconds: 4.2, channels: 2, level: 0.75, verb: 1.4, room: "bay", ref: 60, gap: 30, build(h) {
    // A gun across the water: no crack, just a dull thud and the roll of it coming back off the islands.
    boom(h, 0.02, h.filter("lowpass", 900, 0.7, h.out), { hz: 50, amp: 0.9, roll: 2.2, rollHz: 150 });
    const e = h.gain(0, h.out); h.swell(e.gain, 0.9, 0.4, 0.25, 0.6, 1.6);   // the echo off a headland
    h.noise("brown", 0.9, 4, h.filter("lowpass", 120, 0.7, e));
  } },

  chain_whirr: { seconds: 1.4, channels: 2, level: 0.5, verb: 0.4, build(h) {
    // Chain shot spinning away: a ragged whirr that falls in pitch as it flies.
    const g = h.gain(0, h.out), gate = h.gain(0, g);
    h.swell(g.gain, 0.05, 0.08, 0.8, 0.5, 0.6);
    const bp = h.filter("bandpass", 900, 3, gate);
    bp.frequency.setValueAtTime(1400, 0.05); bp.frequency.exponentialRampToValueAtTime(500, 1.2);
    h.osc("sine", 22, 0, 1.4, h.gain(0.5, gate.gain));
    h.noise("pink", 0.05, 1.3, bp);
  } },

  ports: { seconds: 2.6, channels: 2, level: 0.55, verb: 0.5, ref: 30, jitter: false, build(h) {
    // Gun ports thrown open along a hull, then the guns run out: a ripple of wooden lid knocks over a carriage rumble.
    for (let i = 0; i < 7; i++) {
      const t = 0.05 + i * 0.13 + Math.random() * 0.04, g = h.gain(0, h.pan(-0.6 + i * 0.2, h.out));
      h.strike(g.gain, t, 0.6, 0.001, 0.05);
      h.osc("triangle", 210 + Math.random() * 40, t, t + 0.25, g).frequency.exponentialRampToValueAtTime(150, t + 0.12);
      h.noise("white", t, t + 0.03, h.filter("bandpass", 1600, 2, g));
    }
    const r = h.gain(0, h.out); h.swell(r.gain, 1, 0.3, 0.5, 0.7, 0.5);
    h.noise("brown", 1, 2.6, h.filter("lowpass", 240, 0.8, r));
    groan(h, 1.05, 1.2, h.out, { hz: 160, amp: 0.3 });
  } },

  whizz: { seconds: 1.1, channels: 2, rate: 48000, level: 0.5, verb: 0.2, gap: 120, build(h) {
    // A near miss: the ball tearing past overhead, a rushing tear of air dropping as it goes (ear to ear).
    // v2: the pure whistle sits lower (1.4 kHz → 520 Hz) and under the air, so it rushes instead of rings.
    const p = h.pan(0, h.out);
    p.pan?.setValueAtTime(-0.8, 0); p.pan?.linearRampToValueAtTime(0.8, 0.7);
    const g = h.gain(0, p); h.swell(g.gain, 0, 0.32, 0.35, 0.04, 0.4);
    const o = h.osc("sine", 1400, 0, 1, g); o.frequency.setValueAtTime(1400, 0); o.frequency.exponentialRampToValueAtTime(520, 0.75);
    const air = h.gain(0, p); h.swell(air.gain, 0.05, 0.27, 0.9, 0.05, 0.4);
    const lp = h.filter("lowpass", 2600, 0.5, air); lp.frequency.exponentialRampToValueAtTime(700, 0.8);
    h.noise("pink", 0, 1, h.filter("bandpass", 1300, 0.7, lp));
  } },

  splash_ball: { seconds: 1.6, channels: 2, level: 0.55, verb: 0.5, ref: 25, gap: 40, build(h) {
    // A ball into the sea: a plunging thump, a tall column of water falling back.
    splashAt(h, 0, h.out, { amp: 0.8, size: 1.2 });
  } },

  splinters: { seconds: 2.2, channels: 2, level: 0.85, verb: 0.5, ref: 20, gap: 40, build(h) {
    // Round shot through the planking: the punch, timber shattering, a groan in the frames.
    const p = h.gain(0, h.out); h.strike(p.gain, 0, 1, 0.002, 0.09);
    h.osc("sine", 82, 0, 0.6, p).frequency.exponentialRampToValueAtTime(42, 0.3);
    h.noise("white", 0, 0.1, h.filter("bandpass", 1800, 0.9, h.gain(0.7, p)));
    splinterBurst(h, 0.01, h.out, { n: 18, spread: 0.45 });
    groan(h, 0.3, 1.6, h.out, { hz: 130, amp: 0.4 });
  } },

  mast_hit: { seconds: 3, channels: 2, level: 0.8, verb: 0.6, ref: 25, build(h) {
    // Chain shot in the rigging: a spar cracking, ropes parting with a twang, canvas ripping.
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0006, 0.06);
    h.noise("white", 0, 0.12, h.filter("bandpass", 1300, 1.2, c));
    splinterBurst(h, 0.02, h.out, { n: 10, spread: 0.3, amp: 0.8 });
    for (const [t, f] of [[0.15, 180], [0.32, 240]]) {
      const tw = h.gain(0, h.pan(Math.random() - 0.5, h.out)); h.strike(tw.gain, t, 0.5, 0.001, 0.25);
      const o = h.osc("sawtooth", f, t, t + 0.8, h.filter("lowpass", 1400, 2, tw)); o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.5);
    }
    const rip = h.gain(0, h.pan(0.3, h.out)), gate = h.gain(0, rip);
    h.swell(rip.gain, 0.4, 0.05, 0.6, 0.6, 0.4);
    crinkle(gate.gain, 0.4, 1.4, { every: [0.004, 0.012], lo: 0.2, hi: 1, smooth: 0.002 });
    h.noise("white", 0.4, 1.5, h.filter("bandpass", 2600, 0.8, gate));
  } },

  grape_hit: { seconds: 1.4, channels: 2, level: 0.65, verb: 0.4, ref: 20, gap: 60, build(h) {
    // Grape shot across a deck: a hail of small hard hits on wood and metal.
    for (let i = 0; i < 26; i++) {
      const t = Math.random() ** 1.3 * 0.5, g = h.gain(0, h.pan(Math.random() * 1.6 - 0.8, h.out));
      h.strike(g.gain, t, 0.25 + Math.random() * 0.4, 0.0003, 0.006 + Math.random() * 0.01);
      h.noise("white", t, t + 0.03, h.filter("bandpass", Math.random() < 0.3 ? 5200 : 1500 + Math.random() * 1500, 4, g));
    }
  } },

  fire_start: { seconds: 2, channels: 2, level: 0.6, verb: 0.4, ref: 20, build(h) {
    // Fire taking hold: a whoomp as the tar catches, then it starts to crackle.
    const w = h.gain(0, h.out); h.swell(w.gain, 0, 0.12, 0.9, 0.15, 0.8);
    const bp = h.filter("bandpass", 300, 0.8, w); bp.frequency.exponentialRampToValueAtTime(900, 0.4);
    h.noise("brown", 0, 1.2, bp);
    const cr = h.gain(0, h.out), gate = h.gain(0, cr);
    h.swell(cr.gain, 0.2, 0.4, 0.6, 0.8, 0.5);
    crinkle(gate.gain, 0.2, 1.9, { every: [0.006, 0.05], lo: 0, hi: 1, smooth: 0.001 });
    h.noise("white", 0.2, 2, h.filter("highpass", 1800, 0.7, gate));
  } },

  fire: { seconds: 6, channels: 2, level: 0.55, verb: 0.3, ref: 15, loop: true, build(h, len) {
    // A loop: fire on deck. A roaring low flutter and sharp crackles and pops.
    for (const pan of [-0.5, 0.5]) {
      const g = h.gain(0.45, h.pan(pan, h.out));
      h.osc("sine", 2.2 + Math.random(), 0, len, h.gain(0.2, g.gain));
      h.noise("brown", 0, len, h.filter("lowpass", 500, 0.8, g));
      const gate = h.gain(0, g);
      crinkle(gate.gain, 0, len, { every: [0.008, 0.07], lo: 0, hi: 1, smooth: 0.001 });
      h.noise("white", 0, len, h.filter("highpass", 2000, 0.7, gate));
    }
    for (let i = 0; i < 18; i++) {   // pops
      const t = Math.random() * (len - 0.2), g = h.gain(0, h.pan(Math.random() * 1.4 - 0.7, h.out));
      h.strike(g.gain, t, 0.5, 0.0005, 0.01);
      h.noise("white", t, t + 0.03, h.filter("bandpass", 1500 + Math.random() * 2000, 2, g));
    }
  } },

  explosion: { seconds: 4.5, channels: 2, level: 1, verb: 1, ref: 40, jitter: false, build(h) {
    // A fire ship's powder going up: a huge boom, a fireball's roar, debris raining into the sea.
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0005, 0.04);
    h.noise("white", 0, 0.1, h.filter("lowpass", 4000, 0.7, c));
    boom(h, 0, h.out, { hz: 44, amp: 1, roll: 2.4, rollHz: 180 });
    const f = h.gain(0, h.out); h.swell(f.gain, 0.05, 0.2, 0.7, 0.6, 1.5);
    h.noise("pink", 0.05, 2.5, h.filter("lowpass", 1200, 0.7, f));
    splinterBurst(h, 0.05, h.out, { n: 24, spread: 0.8, amp: 0.8 });
    for (let i = 0; i < 6; i++) splashAt(h, 1 + Math.random() * 2, h.out, { amp: 0.25, pan: Math.random() * 1.4 - 0.7, size: 0.5 });
  } },

  mortar_whistle: { seconds: 2.4, channels: 1, rate: 48000, level: 0.42, verb: 0.6, ref: 40, build(h) {
    // A mortar shell coming down: a long falling whistle that grows louder, soft and airy (≤ 1.5 kHz).
    const g = h.gain(0, h.out); h.swell(g.gain, 0, 1.8, 0.7, 0.2, 0.2);
    const o = h.osc("sine", 1500, 0, 2.3, h.gain(0.6, g)); o.frequency.setValueAtTime(1500, 0); o.frequency.exponentialRampToValueAtTime(480, 2.2);
    const air = h.filter("bandpass", 1200, 1.2, h.gain(0.9, g)); air.frequency.setValueAtTime(1300, 0); air.frequency.exponentialRampToValueAtTime(450, 2.2);
    h.noise("pink", 0, 2.3, air);
  } },

  thunder_near: { seconds: 5, channels: 2, level: 1, verb: 0.6, jitter: false, build(h) {
    // Lightning close by: the tearing crack, then the thunder rolling over us.
    const c = h.gain(0, h.out), gate = h.gain(0, c);
    h.swell(c.gain, 0, 0.005, 1, 0.12, 0.3);
    crinkle(gate.gain, 0, 0.4, { every: [0.002, 0.012], lo: 0.2, hi: 1, smooth: 0.0008 });
    h.noise("white", 0, 0.45, h.filter("highpass", 600, 0.7, gate));
    const r = h.gain(0, h.out); h.swell(r.gain, 0.15, 0.4, 0.9, 1.2, 2.8);
    const lp = h.filter("lowpass", 400, 0.7, r); lp.frequency.setValueAtTime(700, 0.15); lp.frequency.exponentialRampToValueAtTime(120, 4.5);
    h.noise("brown", 0.15, 5, lp);
    h.osc("sine", 0.8, 0, 5, h.gain(0.3, r.gain));
  } },

  thunder_far: { seconds: 6, channels: 2, level: 0.7, verb: 1.2, room: "bay", jitter: false, build(h) {
    // Thunder far off over the bay: a low grumble that rolls on and on.
    const r = h.gain(0, h.out); h.swell(r.gain, 0, 0.8, 0.8, 1.6, 3.2);
    h.noise("brown", 0, 6, h.filter("lowpass", 160, 0.7, r));
    h.osc("sine", 0.6 + Math.random() * 0.4, 0, 6, h.gain(0.4, r.gain));
  } },

  rain: { seconds: 8, channels: 2, level: 0.6, verb: 0.15, loop: true, build(h, len) {
    // A loop: rain on the sea and on the deck: a hiss, the patter of drops on wood, the odd gutter run.
    for (const pan of [-0.7, 0.7]) {
      const g = h.gain(0.5, h.pan(pan, h.out));
      h.noise("pink", 0, len, h.filter("highpass", 900, 0.6, g));
      h.noise("white", 0, len, h.gain(0.3, h.filter("bandpass", 6000, 0.8, g)));
      h.osc("sine", 0.07 + Math.random() * 0.05, 0, len, h.gain(0.15, g.gain));
    }
    for (let i = 0; i < 260; i++) {
      const t = Math.random() * (len - 0.05), g = h.gain(0, h.pan(Math.random() * 1.8 - 0.9, h.out));
      h.strike(g.gain, t, 0.08 + Math.random() * 0.12, 0.0003, 0.004);
      h.noise("white", t, t + 0.02, h.filter("bandpass", 2500 + Math.random() * 3000, 3, g));
    }
  } },

  maelstrom: { seconds: 8, channels: 2, level: 0.8, verb: 0.3, ref: 80, loop: true, build(h, len) {
    // A loop: the maelstrom, a vast slow roar of water turning, a sub that circles ear to ear.
    for (const [pan, rate] of [[-0.8, 0.12], [0.8, 0.17]]) {
      const g = h.gain(0.55, h.pan(pan, h.out));
      const bp = h.filter("bandpass", 320, 0.7, g);
      h.osc("sine", rate, 0, len, h.gain(160, bp.frequency));
      h.noise("pink", 0, len, bp);
      h.noise("brown", 0, len, h.gain(0.9, h.filter("lowpass", 120, 0.7, g)));
    }
    const sub = h.gain(0.35, h.out); h.osc("sine", 31, 0, len, sub); h.osc("sine", 0.25, 0, len, h.gain(0.25, sub.gain));
    for (let i = 0; i < 24; i++) bubble(h, Math.random() * (len - 0.4), h.out, { lo: 160, hi: 420, len: 0.12, amp: 0.05, pan: Math.random() * 1.6 - 0.8 });
  } },

  spout: { seconds: 6, channels: 2, level: 0.7, verb: 0.3, ref: 40, loop: true, build(h, len) {
    // A loop: a waterspout, a whirling column of spray hissing and roaring.
    for (const [pan, rate] of [[-0.6, 0.9], [0.6, 1.3]]) {
      const g = h.gain(0.5, h.pan(pan, h.out));
      const bp = h.filter("bandpass", 1100, 1.1, g);
      h.osc("sine", rate, 0, len, h.gain(500, bp.frequency));
      h.noise("white", 0, len, bp);
      h.noise("brown", 0, len, h.gain(0.5, h.filter("lowpass", 200, 0.7, g)));
    }
  } },

  surge: { seconds: 5, channels: 2, level: 0.75, verb: 0.4, jitter: false, build(h) {
    // A rogue wave coming: a rising roar of water building out of the dark.
    for (const pan of [-0.5, 0.5]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, 0, 4, 0.9, 0.4, 0.6);
      const lp = h.filter("lowpass", 300, 0.7, g); lp.frequency.setValueAtTime(250, 0); lp.frequency.exponentialRampToValueAtTime(2200, 4.2);
      h.noise("pink", 0, 5, lp);
      h.noise("brown", 0, 5, h.gain(0.8, h.filter("lowpass", 140, 0.7, g)));
    }
  } },

  wave_hit: { seconds: 3.5, channels: 2, level: 0.95, verb: 0.5, jitter: false, build(h) {
    // The wave breaking over the rail: a heavy slam, tons of water across the deck, the hull groaning.
    const s = h.gain(0, h.out); h.strike(s.gain, 0, 1, 0.006, 0.2);
    h.osc("sine", 60, 0, 1, s).frequency.exponentialRampToValueAtTime(32, 0.5);
    const w = h.gain(0, h.out); h.swell(w.gain, 0, 0.05, 0.9, 0.8, 1.8);
    const lp = h.filter("lowpass", 4000, 0.6, w); lp.frequency.exponentialRampToValueAtTime(600, 2.5);
    h.noise("white", 0, 3.4, lp);
    groan(h, 0.3, 2.2, h.out, { hz: 110, amp: 0.5 });
    for (let i = 0; i < 20; i++) bubble(h, 0.8 + Math.random() * 2.4, h.out, { lo: 300, hi: 900, amp: 0.05, pan: Math.random() * 1.4 - 0.7 });
  } },

  roar: { seconds: 3.6, channels: 2, level: 0.85, verb: 0.6, ref: 40, build(h) {
    // The Kraken rising (Night Helm's): an FM growl swelling from the deep, a wet roar, water pouring off.
    const room = h.room("deep", h.gain(0.6, h.out));
    const g = h.gain(0, h.out); g.connect(room); h.swell(g.gain, 0, 0.6, 0.8, 1.4, 1.4);
    h.fm(48, 0.5, 3, 1.2, 2.5, 0, 3.6, h.filter("lowpass", 700, 0.8, g));
    const sub = h.gain(0, h.out); h.swell(sub.gain, 0, 0.8, 0.6, 1.4, 1.2);
    const s = h.osc("sine", 32, 0, 3.6, sub); s.frequency.linearRampToValueAtTime(42, 2);
    const r = h.gain(0, h.out); h.swell(r.gain, 0.2, 0.5, 0.45, 1.2, 1.2);
    const lp = h.filter("lowpass", 400, 1, r);
    lp.frequency.setValueAtTime(300, 0.2); lp.frequency.exponentialRampToValueAtTime(1500, 1.2); lp.frequency.exponentialRampToValueAtTime(400, 3.2);
    h.noise("pink", 0, 3.6, lp);
    for (const [pan, t0] of [[-0.6, 0.9], [0.6, 1.3]]) {
      const w = h.gain(0, h.pan(pan, h.out)), gate = h.gain(0, w);
      h.swell(w.gain, t0, 0.4, 0.35, 1.2, 0.8);
      crinkle(gate.gain, t0, t0 + 2.2, { every: [0.03, 0.08], lo: 0.1, hi: 1, smooth: 0.01 });
      h.noise("white", t0, 3.6, h.filter("bandpass", 1200, 0.9, gate));
    }
  } },

  slap: { seconds: 2, channels: 2, level: 0.9, verb: 0.5, ref: 20, build(h) {
    // A tentacle across the rail (Night Helm's).
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0005, 0.03);
    h.noise("white", 0, 0.08, h.filter("highpass", 1200, 0.7, c));
    const b = h.gain(0, h.out); h.strike(b.gain, 0, 0.9, 0.002, 0.1);
    h.osc("sine", 90, 0, 0.5, b).frequency.exponentialRampToValueAtTime(40, 0.25);
    splashAt(h, 0.05, h.out, { amp: 0.7, pan: 0.3, size: 1.4 });
    groan(h, 0.2, 1.2, h.out, { hz: 130, amp: 0.35 });
  } },

  tremor: { seconds: 4, channels: 2, level: 0.6, verb: 0.3, ref: 40, build(h) {
    // Something huge stirring below (Night Helm's).
    const g = h.gain(0, h.out); h.swell(g.gain, 0, 1.4, 0.8, 1, 1.4);
    h.osc("sine", 28, 0, 4, g).frequency.linearRampToValueAtTime(36, 2.5);
    h.osc("sine", 0.9, 0, 4, h.gain(0.35, g.gain));
    h.noise("brown", 0, 4, h.filter("lowpass", 120, 0.7, h.gain(0.5, g)));
    for (let i = 0; i < 10; i++) bubble(h, 0.8 + Math.random() * 2.8, h.out, { lo: 180 + Math.random() * 120, hi: 420 + Math.random() * 200, len: 0.09, amp: 0.05, pan: Math.random() * 1.4 - 0.7 });
  } },

  brace_thud: { seconds: 1.2, channels: 2, level: 0.7, verb: 0.3, gap: 150, build(h) {
    // The crew bracing: boots planted, hands slapping the rails, a deep timber thud.
    const t = h.gain(0, h.out); h.strike(t.gain, 0, 1, 0.003, 0.08);
    h.osc("sine", 95, 0, 0.5, t).frequency.exponentialRampToValueAtTime(60, 0.2);
    for (let i = 0; i < 9; i++) {
      const tt = Math.random() * 0.18, g = h.gain(0, h.pan(Math.random() * 1.6 - 0.8, h.out));
      h.strike(g.gain, tt, 0.35, 0.001, 0.02);
      h.noise("pink", tt, tt + 0.05, h.filter("bandpass", 600 + Math.random() * 500, 2, g));
    }
    groan(h, 0.1, 0.9, h.out, { hz: 170, amp: 0.25 });
  } },

  perfect: { seconds: 1.4, channels: 2, level: 0.6, verb: 0.7, jitter: false, build(h) {
    // A perfect brace: a solid wooden "thock" and a warm low brass swell (no glassy ring).
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.9, 0.002, 0.06);
    h.osc("sine", 120, 0, 0.4, k).frequency.exponentialRampToValueAtTime(80, 0.15);
    for (const [m, pan, amp] of [[50, -0.3, 0.22], [57, 0.3, 0.18], [62, 0, 0.12]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, 0.03, 0.06, amp, 0.25, 0.6);
      h.osc("sawtooth", midiHz(m), 0.03, 1.2, h.filter("lowpass", 900, 0.6, g));
    }
  } },

  bell: { seconds: 6, level: 0.75, verb: 1.2, ref: 3, build: (h) => bellStrike(h, 0, BELL_HZ, h.out) },

  coins: { seconds: 1.8, channels: 2, level: 0.55, verb: 0.6, gap: 150, build(h) {
    // Plunder counted in: a chest lid, then coins spilling onto a table (short dull clinks, no glassy chime).
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 0.8, 0.002, 0.08);
    h.osc("triangle", 150, 0, 0.4, c); h.noise("brown", 0, 0.12, h.filter("lowpass", 700, 0.7, h.gain(0.6, c)));
    for (let i = 0; i < 22; i++) {
      const t = 0.1 + Math.random() ** 0.8 * 1.2, g = h.gain(0, h.pan(Math.random() * 1.4 - 0.7, h.out));
      h.strike(g.gain, t, 0.05 + Math.random() * 0.06, 0.001, 0.025 + Math.random() * 0.02);
      h.osc("triangle", 1100 + Math.random() * 1300, t, t + 0.2, h.filter("lowpass", 3000, 0.5, g));
    }
  } },

  swivel: { seconds: 2.4, channels: 2, level: 0.85, verb: 0.7, ref: 10, gap: 80, build(h) {
    // The swivel gun: a sharp bark, a short boom, the ball whistling away.
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0004, 0.015);
    h.noise("white", 0, 0.05, h.filter("highpass", 1200, 0.7, c));
    boom(h, 0, h.out, { hz: 90, amp: 0.6, roll: 0.8, rollHz: 260 });
    const wh = h.gain(0, h.pan(0.3, h.out)); h.swell(wh.gain, 0.08, 0.08, 0.12, 0.35, 0.3);
    h.osc("sine", 2100, 0.08, 0.9, wh).frequency.exponentialRampToValueAtTime(900, 0.8);
  } },

  spyglass: { seconds: 0.6, channels: 2, level: 0.42, verb: 0.3, gap: 300, build(h) {
    // The brass draws sliding out: three soft slides, each ending in a small click.
    for (const [t, f] of [[0, 1300], [0.11, 1500], [0.22, 1700]]) {
      const s = h.gain(0, h.out); h.swell(s.gain, t, 0.02, 0.3, 0.04, 0.03);
      h.noise("pink", t, t + 0.1, h.filter("bandpass", f, 1.5, s));
      const k = h.gain(0, h.out); h.strike(k.gain, t + 0.08, 0.4, 0.0005, 0.008);
      h.noise("white", t + 0.08, t + 0.1, h.filter("bandpass", 2400, 1, k));
    }
  } },

  wheel: { seconds: 0.16, level: 0.32, verb: 0.15, gap: 45, build(h) {
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.9, 0.0006, 0.004);
    h.noise("white", 0, 0.02, h.filter("bandpass", 2400, 3, k));
    const b = h.gain(0, h.out); h.strike(b.gain, 0, 0.4, 0.001, 0.025);
    h.osc("triangle", 380, 0, 0.15, b);
    h.osc("sine", 760, 0, 0.1, h.gain(0.25, b));
  } },

  luff: { seconds: 1.4, channels: 2, level: 0.45, verb: 0.4, build(h) {
    for (const pan of [-0.4, 0.4]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, 0, 0.08, 0.8, 0.5, 0.7);
      const fl = h.gain(0, g);
      crinkle(fl.gain, 0, 1.3, { every: [0.07, 0.11], lo: 0.15, hi: 1, smooth: 0.01 });
      const lp = h.filter("lowpass", 1400, 0.8, fl);
      lp.frequency.setValueAtTime(1600, 0); lp.frequency.exponentialRampToValueAtTime(500, 1.2);
      h.noise("pink", 0, 1.4, lp);
    }
  } },

  fill: { seconds: 1.3, channels: 2, level: 0.55, verb: 0.5, build(h) {
    const w = h.gain(0, h.out); h.strike(w.gain, 0.05, 0.9, 0.02, 0.12);
    const o = h.osc("sine", 70, 0, 0.6, w); o.frequency.exponentialRampToValueAtTime(48, 0.3);
    const air = h.gain(0, h.out); h.swell(air.gain, 0, 0.12, 0.35, 0.15, 0.6);
    const bp = h.filter("bandpass", 500, 0.8, air); bp.frequency.exponentialRampToValueAtTime(1200, 0.4);
    h.noise("pink", 0, 1, bp);
    groan(h, 0.15, 0.6, h.pan(0.3, h.out), { hz: 210, amp: 0.25 });
  } },

  clash: { seconds: 1.4, channels: 2, rate: 48000, level: 0.7, verb: 0.5, gap: 90, build(h) {
    // Boarding: cutlasses meeting (two inharmonic metal rings), a scuffle of boots, a pistol crack.
    for (const [t, f, pan] of [[0, 1870, -0.3], [0.21, 2340, 0.35], [0.5, 1620, 0]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.strike(g.gain, t, 0.45, 0.0005, 0.09);
      h.osc("sine", f, t, t + 0.6, g); h.osc("sine", f * 2.73, t, t + 0.3, h.gain(0.15, g));
      h.noise("white", t, t + 0.02, h.filter("highpass", 4000, 0.7, g));
    }
    for (let i = 0; i < 10; i++) {
      const t = Math.random() * 1.1, g = h.gain(0, h.pan(Math.random() * 1.6 - 0.8, h.out));
      h.strike(g.gain, t, 0.3, 0.002, 0.03);
      h.noise("pink", t, t + 0.06, h.filter("bandpass", 400 + Math.random() * 400, 1.5, g));
    }
    if (Math.random() < 0.6) { const p = h.gain(0, h.out); h.strike(p.gain, 0.8, 0.6, 0.0004, 0.03); h.noise("white", 0.8, 0.9, h.filter("bandpass", 2000, 0.8, p)); }
  } },

  pistol: { seconds: 1.2, channels: 2, level: 0.7, verb: 0.6, gap: 60, build(h) {
    // The Captain's flintlock: the pan's hiss, then the crack and a short, dry boom (no ring).
    const pan = h.gain(0, h.out); h.swell(pan.gain, 0, 0.01, 0.25, 0.01, 0.05);
    h.noise("white", 0, 0.07, h.filter("highpass", 3000, 0.7, pan));
    const c = h.gain(0, h.out); h.strike(c.gain, 0.06, 1, 0.0003, 0.012);
    h.noise("white", 0.06, 0.1, h.filter("bandpass", 2400, 0.6, c));
    boom(h, 0.06, h.out, { hz: 120, amp: 0.45, roll: 0.5, rollHz: 320 });
  } },

  rally: { seconds: 2.2, channels: 2, level: 0.6, verb: 0.8, jitter: false, gap: 800, build(h) {
    // Rally: two drum hits under a rising rush of the crew's breath ("Hah!"), no tones that ring.
    for (const t of [0, 0.32]) {
      const d = h.gain(0, h.out); h.strike(d.gain, t, 0.9, 0.002, 0.18);
      h.osc("sine", 82, t, t + 0.6, d).frequency.exponentialRampToValueAtTime(55, t + 0.3);
      h.noise("brown", t, t + 0.2, h.filter("lowpass", 500, 0.7, h.gain(0.7, d)));
    }
    const r = h.gain(0, h.out); h.swell(r.gain, 0.3, 0.7, 0.55, 0.15, 0.8);
    const bp = h.filter("bandpass", 380, 0.9, r); bp.frequency.setValueAtTime(320, 0.3); bp.frequency.exponentialRampToValueAtTime(900, 1.1);
    h.noise("pink", 0.3, 2, bp);
  } },

  grapple: { seconds: 1.6, channels: 2, level: 0.6, verb: 0.5, gap: 200, build(h) {
    // Grapples across: rope whipping out, the irons biting into her rail, the lines hauled taut.
    const w = h.gain(0, h.pan(-0.3, h.out)); h.swell(w.gain, 0, 0.12, 0.5, 0.05, 0.3);
    const bp = h.filter("bandpass", 700, 1.2, w); bp.frequency.setValueAtTime(500, 0); bp.frequency.exponentialRampToValueAtTime(1500, 0.3);
    h.noise("pink", 0, 0.5, bp);
    for (const [t, pan] of [[0.38, 0.2], [0.5, 0.5], [0.62, -0.1]]) {
      const k = h.gain(0, h.pan(pan, h.out)); h.strike(k.gain, t, 0.7, 0.0008, 0.05);
      h.osc("triangle", 260 + Math.random() * 80, t, t + 0.2, k).frequency.exponentialRampToValueAtTime(160, t + 0.1);
      h.noise("white", t, t + 0.03, h.filter("bandpass", 1800, 1.5, k));
    }
    groan(h, 0.8, 0.7, h.out, { hz: 180, amp: 0.35 });
  } },

  sink: { seconds: 5, channels: 2, level: 0.85, verb: 0.7, ref: 50, jitter: false, build(h) {
    // A ship going down (Night Helm's wreck): the keel's long groan, the sea pouring in, bubbles.
    groan(h, 0, 3.6, h.out, { hz: 90, amp: 0.7 });
    splinterBurst(h, 0.2, h.out, { n: 14, spread: 1.4, amp: 0.6 });
    const fl = h.gain(0, h.out); h.swell(fl.gain, 0.6, 1.2, 0.55, 1.6, 1.4);
    h.noise("pink", 0.6, 5, h.filter("lowpass", 1100, 0.7, fl));
    for (let i = 0; i < 34; i++) bubble(h, 1 + Math.random() * 3.6, h.out, { lo: 220 + Math.random() * 250, hi: 650 + Math.random() * 600, amp: 0.05 + Math.random() * 0.05, pan: Math.random() * 1.6 - 0.8 });
  } },

  overboard: { seconds: 2, channels: 2, level: 0.75, verb: 0.5, build(h) {
    // Someone over the side: a scuffle at the rail, a big splash.
    const g = h.gain(0, h.out); h.strike(g.gain, 0, 0.5, 0.002, 0.04);
    h.noise("pink", 0, 0.1, h.filter("bandpass", 700, 1.5, g));
    splashAt(h, 0.35, h.out, { amp: 0.9, pan: 0.2, size: 1.4 });
  } },

  burst: { seconds: 1.8, channels: 2, level: 0.8, verb: 0.45, build(h) {
    // A leak sprung: planks giving inward and the sea punching through (Night Helm's).
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.001, 0.05);
    h.noise("white", 0, 0.12, h.filter("bandpass", 2400, 0.8, c));
    const jet = h.gain(0, h.out); h.swell(jet.gain, 0.08, 0.06, 0.7, 0.6, 0.9);
    h.noise("white", 0.08, 1.8, h.filter("bandpass", 1500, 0.8, jet));
    h.noise("pink", 0.08, 1.8, h.gain(0.6, h.filter("lowpass", 500, 0.7, jet)));
  } },

  hammer: { seconds: 0.5, level: 0.6, verb: 0.35, gap: 80, build(h) {
    const g = h.gain(0, h.out); h.strike(g.gain, 0, 1, 0.0008, 0.035);
    h.noise("white", 0, 0.03, h.filter("bandpass", 1800, 2, g));
    h.osc("triangle", 440, 0, 0.3, h.gain(0.6, g)).frequency.exponentialRampToValueAtTime(330, 0.08);
    const ring = h.gain(0, h.out); h.strike(ring.gain, 0.002, 0.08, 0.001, 0.04);   // the nail's short ping (low, quick)
    h.osc("sine", 1250, 0, 0.3, ring);
  } },

  pump: { seconds: 0.9, channels: 2, level: 0.5, verb: 0.3, gap: 300, build(h) {
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.8, 0.001, 0.03);
    h.osc("square", 210, 0, 0.12, h.filter("bandpass", 900, 3, k));
    const gush = h.gain(0, h.pan(-0.4, h.out)); h.swell(gush.gain, 0.25, 0.05, 0.6, 0.2, 0.35);
    h.noise("white", 0.25, 0.9, h.filter("bandpass", 1300, 0.7, gush));
  } },

  creak: { seconds: 1, level: db(-6), verb: 0.3, gap: 900, build(h) {
    // The hull working: a click train through a narrow band gliding up (Starboard's).
    const g = h.gain(0, h.out); h.swell(g.gain, 0, 0.25, 1, 0.2, 0.4);
    const bp = h.filter("bandpass", 150, 12, g);
    bp.frequency.setValueAtTime(150, 0); bp.frequency.linearRampToValueAtTime(190, 0.85);
    const saw = h.osc("sawtooth", 24, 0, 0.95, h.gain(0.8, bp)); saw.frequency.linearRampToValueAtTime(44, 0.85);
    h.noise("brown", 0, 0.95, h.gain(0.4, bp));
  } },

  // ---- v2: the Captain's guns, collectables, the day ------------------------------------------

  broadside_roll: { seconds: 4.5, channels: 2, level: 0.7, verb: 1, room: "bay", jitter: false, build(h) {
    // After a full broadside: the guns' thunder rolling back off the bay, the smoke hanging (low only).
    const r = h.gain(0, h.out); h.swell(r.gain, 0, 0.35, 0.8, 0.9, 2.6);
    const lp = h.filter("lowpass", 260, 0.5, r); lp.frequency.setValueAtTime(320, 0); lp.frequency.exponentialRampToValueAtTime(90, 4);
    h.noise("brown", 0, 4.4, lp);
    h.osc("sine", 0.7, 0, 4.4, h.gain(0.3, r.gain));
  } },

  cannon_heavy: { seconds: 3.6, channels: 2, level: 1, verb: 0.9, ref: 20, gap: 20, build(h) {
    // Heavy shot at close range: a double-charged gun, a chest-caving blast and a long low roll.
    const c = h.gain(0, h.out); h.strike(c.gain, 0, 1, 0.0005, 0.03);
    h.noise("pink", 0, 0.08, h.filter("lowpass", 3000, 0.5, c));
    boom(h, 0, h.out, { hz: 46, amp: 1, roll: 2, rollHz: 170 });
    const thump = h.gain(0, h.out); h.strike(thump.gain, 0.005, 0.8, 0.004, 0.18);
    h.osc("sine", 72, 0, 0.9, thump).frequency.exponentialRampToValueAtTime(34, 0.5);
    const k = h.gain(0, h.out); h.strike(k.gain, 0.11, 0.45, 0.002, 0.07);   // the carriage slamming back
    h.noise("brown", 0.11, 0.4, h.filter("lowpass", 500, 0.6, k));
  } },

  mortar_launch: { seconds: 2.6, channels: 2, level: 0.9, verb: 0.9, ref: 25, gap: 60, build(h) {
    // A mortar: a deep hollow THOOMP straight up, the shell's rush fading overhead.
    const b = h.gain(0, h.out); h.strike(b.gain, 0, 1, 0.003, 0.22);
    h.osc("sine", 64, 0, 1.2, b).frequency.exponentialRampToValueAtTime(30, 0.6);
    h.noise("brown", 0, 0.6, h.filter("lowpass", 420, 0.6, h.gain(1.1, b)));
    const air = h.gain(0, h.out); h.swell(air.gain, 0.05, 0.08, 0.3, 0.1, 0.9);
    const lp = h.filter("lowpass", 1500, 0.5, air); lp.frequency.exponentialRampToValueAtTime(300, 1.2);
    h.noise("pink", 0.05, 1.4, lp);
  } },

  mortar_impact: { seconds: 3.4, channels: 2, level: 0.9, verb: 0.9, ref: 40, gap: 40, build(h) {
    // A shell landing: a muffled blast and a tall column of water falling back.
    boom(h, 0, h.filter("lowpass", 1200, 0.5, h.out), { hz: 52, amp: 0.95, roll: 1.5, rollHz: 200 });
    splashAt(h, 0.04, h.out, { amp: 0.75, size: 1.6 });
  } },

  barrel_drop: { seconds: 1.6, channels: 2, level: 0.6, verb: 0.5, gap: 40, build(h) {
    // A powder barrel over the stern: a wooden knock on the rail, then a heavy plop.
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.6, 0.001, 0.04);
    h.osc("triangle", 180, 0, 0.2, k).frequency.exponentialRampToValueAtTime(130, 0.1);
    h.noise("pink", 0, 0.05, h.filter("bandpass", 900, 1, k));
    splashAt(h, 0.28, h.out, { amp: 0.6, size: 0.8 });
  } },

  barrel_ignite: { seconds: 2.4, channels: 2, level: 0.8, verb: 0.6, ref: 25, gap: 60, build(h) {
    // A fire barrel going up: a deep whoosh of burning pitch, a crackle on the water.
    const w = h.gain(0, h.out); h.swell(w.gain, 0, 0.1, 1, 0.25, 1.1);
    const bp = h.filter("lowpass", 400, 0.6, w); bp.frequency.exponentialRampToValueAtTime(1300, 0.35); bp.frequency.exponentialRampToValueAtTime(500, 1.4);
    h.noise("brown", 0, 1.6, bp);
    h.noise("pink", 0, 1.6, h.gain(0.4, bp));
    const cr = h.gain(0, h.out), gate = h.gain(0, cr);
    h.swell(cr.gain, 0.2, 0.3, 0.35, 0.8, 0.6);
    crinkle(gate.gain, 0.2, 2.2, { every: [0.01, 0.06], lo: 0, hi: 1, smooth: 0.001 });
    h.noise("pink", 0.2, 2.3, h.filter("bandpass", 1600, 0.8, gate));
  } },

  hit_thud: { seconds: 0.6, channels: 2, level: 0.6, verb: 0.25, gap: 50, build(h) {
    // Our ball striking home (the hit marker's sound): a short, dry wooden thud.
    const t = h.gain(0, h.out); h.strike(t.gain, 0, 1, 0.001, 0.05);
    h.osc("sine", 140, 0, 0.3, t).frequency.exponentialRampToValueAtTime(70, 0.12);
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.5, 0.0005, 0.015);
    h.noise("pink", 0, 0.05, h.filter("bandpass", 1100, 1.2, k));
  } },

  pickup: { seconds: 1.2, channels: 2, level: 0.55, verb: 0.5, gap: 120, build(h) {
    // Something hauled aboard: a wet thump on the deck and a warm plucked rising third (no bells).
    const t = h.gain(0, h.out); h.strike(t.gain, 0, 0.6, 0.002, 0.06);
    h.osc("sine", 110, 0, 0.3, t).frequency.exponentialRampToValueAtTime(70, 0.15);
    for (const [dt, m, pan] of [[0.06, 67, -0.2], [0.16, 71, 0], [0.26, 74, 0.2]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.strike(g.gain, dt, 0.22, 0.002, 0.18);
      const lp = h.filter("lowpass", 2400, 0.5, g); lp.frequency.setValueAtTime(2400, dt); lp.frequency.exponentialRampToValueAtTime(700, dt + 0.4);
      h.osc("triangle", midiHz(m), dt, dt + 0.9, lp); h.osc("sine", midiHz(m) * 2, dt, dt + 0.5, h.gain(0.25, lp));
    }
  } },

  dry_fire: { seconds: 0.4, level: 0.45, verb: 0.15, gap: 200, build(h) {
    // Pressed fire with nothing ready: a dull wooden click and a short hiss of a wet fuse.
    const k = h.gain(0, h.out); h.strike(k.gain, 0, 0.8, 0.0006, 0.012);
    h.noise("pink", 0, 0.03, h.filter("bandpass", 1400, 1.5, k));
    h.osc("triangle", 260, 0, 0.08, h.gain(0.4, k));
    const s = h.gain(0, h.out); h.swell(s.gain, 0.04, 0.03, 0.15, 0.08, 0.12);
    h.noise("pink", 0.04, 0.3, h.filter("bandpass", 1800, 1, s));
  } },

  sprint: { seconds: 2, channels: 2, level: 0.55, verb: 0.4, gap: 1500, build(h) {
    // Every sail drawing at once: canvas cracking full and a rush of wind and water past the hull.
    const s = h.gain(0, h.out); h.strike(s.gain, 0, 0.7, 0.01, 0.1);
    h.osc("sine", 75, 0, 0.5, s).frequency.exponentialRampToValueAtTime(50, 0.25);
    for (const pan of [-0.6, 0.6]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, 0.05, 0.35, 0.6, 0.4, 1);
      const lp = h.filter("lowpass", 500, 0.5, g); lp.frequency.exponentialRampToValueAtTime(1400, 0.4); lp.frequency.exponentialRampToValueAtTime(500, 1.8);
      h.noise("pink", 0.05, 1.9, lp);
    }
  } },

  aground: { seconds: 2.4, channels: 2, level: 0.85, verb: 0.4, gap: 600, build(h) {
    // Keel on rock: a grinding scrape under the hull and the timbers groaning.
    const g = h.gain(0, h.out); h.swell(g.gain, 0, 0.05, 0.9, 0.6, 1.2);
    const gate = h.gain(0, g);
    crinkle(gate.gain, 0, 1.8, { every: [0.01, 0.04], lo: 0.3, hi: 1, smooth: 0.003 });
    h.noise("brown", 0, 2, h.filter("lowpass", 700, 0.6, gate));
    h.noise("pink", 0, 2, h.gain(0.3, h.filter("bandpass", 450, 0.8, gate)));
    groan(h, 0.1, 2, h.out, { hz: 95, amp: 0.6 });
  } },

  gull: { seconds: 2.2, channels: 2, rate: 32000, level: 0.35, verb: 0.9, room: "bay", ref: 40, gap: 3000, build(h) {
    // A gull overhead: two or three short descending cries with a little rasp (soft, distant).
    const calls = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < calls; i++) {
      const t = i * (0.28 + Math.random() * 0.12), f0 = 1050 + Math.random() * 250;
      const g = h.gain(0, h.out); h.swell(g.gain, t, 0.03, 0.4 - i * 0.07, 0.07, 0.12);
      const lp = h.filter("lowpass", 2200, 0.5, g);
      const o = h.osc("triangle", f0, t, t + 0.35, lp);
      o.frequency.setValueAtTime(f0 * 1.15, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.06); o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.24);
      h.osc("sine", 70 + Math.random() * 30, t, t + 0.35, h.gain(f0 * 0.05, o.frequency));   // the rasp
    }
  } },

  buoy_bell: { seconds: 4, channels: 1, level: 0.4, verb: 1.3, room: "bay", ref: 30, jitter: false, gap: 8000, build(h) {
    // A bell buoy rocking somewhere off in the dark: one soft low strike (never a drone).
    const lp = h.filter("lowpass", 1600, 0.5, h.out);
    const a = h.gain(0, lp); h.strike(a.gain, 0, 0.35, 0.003, 0.9); h.fm(392, 1.4, 1.6, 0.3, 1.5, 0, 3.8, a);
    const hum = h.gain(0, lp); h.strike(hum.gain, 0, 0.12, 0.01, 1.4); h.osc("sine", 196, 0, 3.8, hum);
  } },

  // ---- v4: the whacky sea events ----

  whale_song: { seconds: 6, channels: 2, level: 0.6, verb: 1.2, room: "bay", ref: 120, jitter: false, gap: 4000, build(h) {
    // The sky whale singing: three long moans sliding up and down, a little throat in them, far and wide.
    for (const [t, f0, f1, len, pan] of [[0, 140, 210, 1.9, -0.3], [1.7, 230, 120, 2.2, 0.2], [3.6, 110, 175, 2.2, -0.1]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, t, 0.35, 0.5, len - 0.8, 0.45);
      const bp = h.filter("bandpass", f0 * 2.2, 2.5, g);
      const o = h.osc("sawtooth", f0, t, t + len, bp);
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.8);
      h.osc("sine", 5 + Math.random() * 2, t, t + len, h.gain(f0 * 0.02, o.frequency));     // the vibrato
      const s = h.osc("sine", f0, t, t + len, h.gain(0.55, g));
      s.frequency.setValueAtTime(f0, t); s.frequency.exponentialRampToValueAtTime(f1, t + len * 0.8);
    }
  } },

  dolphin: { seconds: 1.8, channels: 2, rate: 32000, level: 0.35, verb: 0.6, room: "bay", ref: 30, gap: 900, build(h) {
    // A dolphin's chatter: a quick run of clicks and two rising whistles.
    for (let i = 0; i < 9; i++) {
      const t = i * (0.035 + Math.random() * 0.02), k = h.gain(0, h.pan(-0.2, h.out)); h.strike(k.gain, t, 0.25, 0.0005, 0.006);
      h.noise("white", t, t + 0.01, h.filter("bandpass", 4200, 3, k));
    }
    for (const [t, f0, f1, pan] of [[0.4, 5200, 9800, 0.3], [0.95, 6100, 8800, -0.1]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.swell(g.gain, t, 0.03, 0.22, 0.25, 0.12);
      const o = h.osc("sine", f0, t, t + 0.45, g); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.3); o.frequency.exponentialRampToValueAtTime(f0 * 1.1, t + 0.42);
    }
  } },

  zap: { seconds: 0.9, channels: 2, level: 0.5, verb: 0.4, gap: 250, build(h) {
    // A jellyfish's sting on the hull: a crackling buzz, a fizz, a soft thump.
    const g = h.gain(0, h.out); h.swell(g.gain, 0, 0.005, 0.5, 0.18, 0.3);
    const bp = h.filter("bandpass", 2400, 1.4, g);
    h.osc("square", 60, 0, 0.6, h.gain(1800, bp.frequency));
    h.noise("white", 0, 0.6, bp);
    const th = h.gain(0, h.out); h.strike(th.gain, 0, 0.4, 0.002, 0.08); h.osc("sine", 90, 0, 0.3, th);
  } },

  bosun_pipe: { seconds: 1.8, channels: 1, level: 0.35, verb: 0.6, room: "bay", gap: 2500, build(h) {
    // A bosun's call (the Admiral's arrival): a rising trill, a held note, a falling tail.
    const g = h.gain(0, h.filter("lowpass", 5000, 0.5, h.out)); h.swell(g.gain, 0, 0.04, 0.35, 1.2, 0.3);
    const o = h.osc("triangle", 1300, 0, 1.6, g);
    o.frequency.setValueAtTime(1300, 0); o.frequency.exponentialRampToValueAtTime(2100, 0.35);
    o.frequency.setValueAtTime(2100, 1.0); o.frequency.exponentialRampToValueAtTime(1500, 1.5);
    h.osc("sine", 18, 0, 0.35, h.gain(120, o.frequency));     // the trill
  } },

  // ---- v4.2: power-ups (warm and plucked like the pickup; no glassy rings) ----

  powerup: { seconds: 1.6, channels: 2, level: 0.6, verb: 0.6, gap: 150, build(h) {
    // A power-up taken: a rising rush of air, a soft low bloom, and a plucked major arpeggio climbing an octave.
    const w = h.gain(0, h.out); h.swell(w.gain, 0, 0.25, 0.45, 0.05, 0.35);
    const bp = h.filter("bandpass", 500, 1.2, w); bp.frequency.exponentialRampToValueAtTime(2600, 0.32);
    h.noise("pink", 0, 0.7, bp);
    const lo = h.gain(0, h.out); h.swell(lo.gain, 0.05, 0.12, 0.5, 0.2, 0.7); h.osc("sine", midiHz(48), 0.05, 1.2, lo);
    for (const [dt, m, pan] of [[0.1, 60, -0.3], [0.19, 64, -0.1], [0.28, 67, 0.1], [0.37, 72, 0.3]]) {
      const g = h.gain(0, h.pan(pan, h.out)); h.strike(g.gain, dt, 0.24, 0.003, 0.32);
      const lp = h.filter("lowpass", 2800, 0.5, g); lp.frequency.setValueAtTime(2800, dt); lp.frequency.exponentialRampToValueAtTime(800, dt + 0.6);
      h.osc("triangle", midiHz(m), dt, dt + 1.1, lp); h.osc("sine", midiHz(m) * 2, dt, dt + 0.6, h.gain(0.2, lp));
    }
  } },

  powerup_spawn: { seconds: 2.2, channels: 1, level: 0.3, verb: 1, room: "bay", ref: 60, gap: 2500, build(h) {
    // One coming up out of the sea in view: a soft rising bubble-swell and a single low plucked note.
    const s = h.gain(0, h.out); h.swell(s.gain, 0, 0.6, 0.4, 0.2, 0.9);
    const lp = h.filter("lowpass", 300, 0.7, s); lp.frequency.exponentialRampToValueAtTime(1400, 0.8); lp.frequency.exponentialRampToValueAtTime(400, 1.8);
    h.noise("brown", 0, 2, lp);
    for (let i = 0; i < 5; i++) bubble(h, 0.15 + i * 0.13, h.out, { lo: 300 + i * 90, hi: 700 + i * 160, amp: 0.08 });
    const g = h.gain(0, h.out); h.strike(g.gain, 0.55, 0.3, 0.004, 0.5);
    h.osc("triangle", midiHz(55), 0.55, 2, h.filter("lowpass", 1400, 0.5, g));
  } },

  powerup_end: { seconds: 1.1, channels: 1, level: 0.3, verb: 0.5, gap: 400, build(h) {
    // A buff wearing off: two soft plucked notes falling a fourth and a breath of air going out.
    for (const [dt, m] of [[0, 67], [0.14, 62]]) {
      const g = h.gain(0, h.out); h.strike(g.gain, dt, 0.25, 0.003, 0.25);
      h.osc("triangle", midiHz(m), dt, dt + 0.8, h.filter("lowpass", 1800, 0.5, g));
    }
    const a = h.gain(0, h.out); h.swell(a.gain, 0.05, 0.1, 0.15, 0.1, 0.4);
    const bp = h.filter("bandpass", 1600, 1, a); bp.frequency.exponentialRampToValueAtTime(400, 0.6);
    h.noise("pink", 0.05, 0.8, bp);
  } },
};

// ---- The bank ------------------------------------------------------------------------------------

/**
 * Build the effect bank and start pre-rendering it.
 * @param {{R?: object|null}} [opts]  the render context (for its AudioListener); may be null
 */
export function createSfx({ R = null } = {}) {
  const buffers = {};
  let renderMs = 0, disposed = false, rr = 0, failed = [];
  const lastAt = {};
  let live = null, offMix = null;

  const t0 = performance.now();
  const ready = (async () => {
    if (!globalThis.OfflineAudioContext && !globalThis.webkitOfflineAudioContext) return;
    await Promise.all(Object.entries(RECIPES).map(async ([name, r]) => {
      try {
        const len = r.loop ? r.seconds + 3 : r.seconds;
        const buf = await render(len, (h) => r.build(h, len), { channels: r.channels || 1, sampleRate: r.rate || SR });
        buffers[name] = r.loop ? finish(loopify(buf, r.seconds), { target: 0.9, fadeIn: 0, fadeOut: 0 }) : finish(buf, { target: 0.9 });
      } catch (error) {
        failed.push(name);
        console.debug(`[rexmaw-raids] sfx ${name} failed to render`, error);
      }
    }));
    renderMs = performance.now() - t0;
    console.debug(`[rexmaw-raids] sfx: ${Object.keys(buffers).length} effects rendered in ${renderMs.toFixed(0)} ms`);
  })();

  const muted = () => !!Kit()?.sfx?.muted?.();

  /** The live graph: the SFX bus, the sea room and the long bay room. */
  function graphLive() {
    if (live) return live;
    if (globalThis.navigator?.userActivation && !navigator.userActivation.hasBeenActive) return null;
    const ctx = Kit()?.sfx?.context?.();
    if (!ctx) return null;
    const h = graph(ctx);
    h.out.disconnect();
    const bus = h.gain(0.55 * mix.level("effects"), ctx.destination);   // the Effects fader (mix.js) rides the bus
    const sea = h.gain(0.25), bay = h.gain(0.25);
    sea.connect(h.room("sea", bus));
    bay.connect(h.room("bay", bus));
    live = { ctx, h, bus, sea, bay };
    offMix = mix.on(() => { if (live) live.bus.gain.setTargetAtTime(0.55 * mix.level("effects"), live.ctx.currentTime, 0.05); });
    return live;
  }

  function position(at) {
    if (!at) return null;
    if (typeof at.getWorldPosition === "function" && R?.THREE) return at.getWorldPosition(new R.THREE.Vector3());
    return Number.isFinite(at.x) ? { x: at.x, y: Number.isFinite(at.y) ? at.y : 0, z: at.z } : null;
  }
  function setPannerPos(p, pos) {
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
  }

  function voice(name, opts, loop = false) {
    if (disposed) return null;
    const r = RECIPES[name], buf = buffers[name];
    if (!r || !buf || muted()) return null;
    const now = performance.now();
    if (r.gap && !opts.force && now - (lastAt[name] ?? -Infinity) < r.gap) return null;
    lastAt[name] = now;
    const L = graphLive();
    if (!L || L.ctx.state !== "running") return null;
    const { ctx, h } = L;
    const when = ctx.currentTime + 0.005 + Math.max(0, opts.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const rate = (opts.pitch ?? 1) * (r.jitter === false || loop ? 1 : RR[rr++ % RR.length]);
    src.playbackRate.value = rate;
    const level = r.level * (opts.gain ?? 1);
    const g = h.gain(loop ? 0.0001 : level);
    src.connect(g);
    let tail = g, panner = null;
    const pos = position(opts.at);
    if (pos && R?.listener && (!R.listener.context || R.listener.context === ctx)) {
      panner = ctx.createPanner();
      panner.panningModel = "equalpower"; panner.distanceModel = "inverse";
      panner.refDistance = r.ref ?? 4; panner.rolloffFactor = 0.8; panner.maxDistance = 4000;
      setPannerPos(panner, pos);
      g.connect(panner);
      tail = panner;
    } else if (Number.isFinite(opts.pan) && opts.pan !== 0) {
      tail = h.pan(Math.max(-1, Math.min(1, opts.pan)));
      g.connect(tail);
    }
    tail.connect(L.bus);
    const send = r.verb ?? 1;
    if (send > 0) tail.connect(h.gain(send, r.room === "bay" ? L.bay : L.sea));
    src.start(when);
    if (!loop) src.stop(when + buf.duration / rate + 0.05);
    src.onended = () => { try { tail.disconnect(); g.disconnect(); } catch { /* already */ } };
    return { ctx, src, g, panner, level, when };
  }

  /** Play effect `name` once. Returns a handle ({stop(fade), when}) or null when nothing plays. */
  function play(name, opts = {}) {
    const v = voice(name, opts, false);
    if (!v) return null;
    return {
      when: v.when,
      stop(fade = 0.08) {
        const t = v.ctx.currentTime;
        v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(Math.max(0.0001, v.g.gain.value), t);
        v.g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, fade));
        try { v.src.stop(t + fade + 0.02); } catch { /* already stopped */ }
      },
    };
  }

  /** Hold a looping effect (fire, rain, the maelstrom, a spout). Starts silent unless `gain` is given. */
  function loop(name, opts = {}) {
    const v = voice(name, { ...opts, gain: 1, force: true }, true);
    if (!v) return null;
    let stopped = false;
    const api = {
      gain(k, seconds = 1) {
        if (stopped) return;
        const t = v.ctx.currentTime;
        v.g.gain.cancelScheduledValues(t);
        v.g.gain.setTargetAtTime(Math.max(0.0001, v.level * Math.max(0, k)), t, Math.max(0.02, seconds / 3));
      },
      at(p) { const pos = position(p); if (pos && v.panner) setPannerPos(v.panner, pos); },
      stop(fade = 1) {
        if (stopped) return;
        stopped = true;
        const t = v.ctx.currentTime;
        v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, Math.max(0.02, fade / 3));
        try { v.src.stop(t + fade + 0.1); } catch { /* already */ }
      },
      get playing() { return !stopped; },
    };
    api.gain(Number.isFinite(opts.gain) ? opts.gain : 0, 0.3);
    return api;
  }

  /**
   * A broadside: `balls` guns rippling down one side, 60–130 ms apart, the pan sweeping along the
   * hull (bow to stern), then the roll of it coming back off the bay. Near (ours, or `near: true`)
   * is the full layered gun; far guns are the dull thud.
   * @param {{side?: string, balls?: number, near?: boolean, at?: object|null, ammo?: string, gain?: number, roll?: boolean}} o
   */
  function volley({ side = "starboard", balls = 7, near = true, at = null, ammo = "round", gain = 1, roll = null } = {}) {
    const n = Math.max(1, Math.min(10, Math.round(balls) || 1));
    const base = side === "port" ? -0.7 : side === "starboard" ? 0.7 : 0;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const sweep = n > 1 ? (i / (n - 1)) * 0.5 - 0.25 : 0;
      const pan = side === "bow" || side === "stern" ? (Math.random() - 0.5) * 0.25 : base + sweep * Math.sign(base || 1) + (Math.random() - 0.5) * 0.1;
      setTimeout(() => play(near ? "cannon_near" : "cannon_far", { pan, at, gain: gain * (i === 0 ? 1 : 0.72 + Math.random() * 0.2), pitch: 0.9 + Math.random() * 0.16, force: true }), t * 1000);
      t += near ? 0.06 + Math.random() * 0.07 : 0.05 + Math.random() * 0.08;
    }
    if (roll ?? (near && n >= 4)) setTimeout(() => play("broadside_roll", { pan: base * 0.4, gain: 0.5 + 0.06 * n, force: true }), 200);
    if (ammo === "chain") setTimeout(() => play("chain_whirr", { pan: base * 0.6, gain: 0.8 }), 120);
  }

  /** The heavy close volley: double-charged guns, tighter and much heavier. */
  function heavyVolley({ side = "starboard", balls = 7 } = {}) {
    const base = side === "port" ? -0.7 : 0.7;
    play("cannon_heavy", { pan: base, force: true });
    const n = Math.max(2, Math.min(8, Math.round(balls) || 7));
    for (let i = 1; i < n; i++) setTimeout(() => play(i % 3 === 0 ? "cannon_heavy" : "cannon_near", { pan: base + (Math.random() - 0.5) * 0.3, gain: 0.7, pitch: 0.85 + Math.random() * 0.1, force: true }), (i * 0.035 + Math.random() * 0.02) * 1000);
    setTimeout(() => play("broadside_roll", { pan: base * 0.4, gain: 1, force: true, pitch: 0.85 }), 150);
  }

  /** Ring the ship's bell n times in pairs; onStrike(i) on each. */
  function strikes(n, { at = null, onStrike = null } = {}) {
    const count = Math.max(1, Math.min(8, Math.round(n) || 1));
    const times = Array.from({ length: count }, (_, i) => Math.floor(i / 2) * 1.65 + (i % 2) * 0.55);
    times.forEach((t, i) => setTimeout(() => {
      if (disposed) return;
      play("bell", { at, gain: i % 2 ? 0.92 : 1, force: true });
      try { onStrike?.(i); } catch (error) { console.debug("[rexmaw-raids] onStrike threw", error); }
    }, t * 1000));
    return new Promise((resolve) => setTimeout(resolve, (times[count - 1] + 1) * 1000));
  }

  /**
   * The boarding fight's presentation beats (scene/boardfight.js `cue(name, p)`, routed by main.js): each
   * sound lands with the blow on screen. While the scene stages a fight (`staged`), wire()'s bus-driven
   * hit / down clashes stand aside (they're the fallback without a 3D scene). The pistol and the Rally
   * keep sounding on their intents (a click that misses still bangs); the start keeps the bus's grapple.
   */
  let staged = false;
  const pan = () => (Math.random() - 0.5) * 0.7;
  function boardfight(name, p = {}) {
    switch (name) {
      case "boardfight_start": staged = true; break;
      case "boardfight_end":
        staged = false;
        if (p.outcome !== "lost") { play("bell", { force: true, gain: 0.5 }); }   // her colours struck
        break;
      case "grapple_bite": play("hit_thud", { gain: 0.35, pan: pan(), pitch: 1.25 }); break;
      case "land": play("brace_thud", { gain: 0.3, pan: pan(), pitch: 1.15 }); break;
      case "clash": play("clash", { gain: 0.45 + 0.25 * Math.random(), pan: pan(), pitch: 0.95 + Math.random() * 0.12 }); break;
      case "foe_hit": if (!p.pistol) play("hit_thud", { gain: p.killed ? 0.6 : 0.42, pan: pan(), pitch: 1.1 }); break;
      case "crew_hit": play("hit_thud", { gain: 0.45, pan: pan(), pitch: 0.95 }); break;
      case "foe_down": play("brace_thud", { gain: p.captain ? 0.8 : 0.45, pan: pan(), pitch: p.captain ? 0.8 : 1 }); break;
      case "crew_down": play("brace_thud", { gain: 0.55, pan: pan(), pitch: 0.9 }); break;
      case "charge_hit": play("brace_thud", { gain: 0.6, pan: pan(), force: true }); break;
      case "enemy_pistol": play("pistol", { gain: 0.45, pan: pan(), pitch: 1.12 }); break;
      // (his arrival: the bus's `boardfight {stage: "captain"}` heavy clash + thud, and Leo's bark)
      case "captain_windup": play("clash", { gain: 0.35, pitch: 0.7, force: true }); break;
      case "captain_slam": play("brace_thud", { gain: 0.9, force: true, pitch: 0.75 }); play("splinters", { gain: 0.45, force: true }); break;
      case "revive": play("perfect", { gain: 0.35 }); break;
      // The whacky captains: a line spoken (the babble voice), a pie landing in someone's face.
      case "say": babble(p.voice || p.archetype || "normal", p.text); break;
      case "pie_splat": splat(); break;
      default: break;   // swing, captain, pistol, rally: the swing is silent; the others sound on the bus / intents
    }
  }

  // ---- Live voices: the babble, the gimmicks' little noises ----------------------------------------
  //
  // Synthesised on the live context as they happen (short, few nodes): Animal Crossing-style gibberish — one
  // blip per syllable of the line, a source (pitch, waveform) per character through two vowel formants picked
  // from the letters, with the line's contour (a question rises, a shout jumps).

  /** The live graph when it can sound now (gestured, running, not muted), else null. */
  function liveNow() {
    if (disposed || muted()) return null;
    const L = graphLive();
    return L && L.ctx.state === "running" ? L : null;
  }
  /** A pitched blip: `type` from f0 to f1 over `dur`, an envelope, into the bus (and a touch of the sea room). */
  function tone(f0, f1, dur, { type = "sine", gain = 0.3, when = 0, filt = null, pan = 0 } = {}) {
    const L = liveNow(); if (!L) return;
    const { ctx, h } = L, t = ctx.currentTime + 0.01 + when;
    const g = h.gain(0.0001), out = pan ? h.pan(pan, L.bus) : L.bus;
    g.connect(out); g.connect(h.gain(0.15, L.sea));
    const o = h.osc(type, f0, t, t + dur + 0.05, filt ? h.filter(filt[0], filt[1], filt[2] ?? 1, g) : g);
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    h.swell(g.gain, t, 0.006, gain, dur * 0.4, dur * 0.6);
    o.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
  }
  /** A filtered noise burst (a click, a slurp, a splat, a whoosh): bandpass f0 → f1. */
  function hiss(f0, f1, dur, { gain = 0.3, when = 0, q = 1.2, type = "bandpass", color = "white" } = {}) {
    const L = liveNow(); if (!L) return;
    const { ctx, h } = L, t = ctx.currentTime + 0.01 + when;
    const g = h.gain(0.0001, L.bus); g.connect(h.gain(0.2, L.sea));
    const f = h.filter(type, f0, q, g);
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const s = h.noise(color, t, t + dur + 0.05, f);
    h.swell(g.gain, t, Math.min(0.02, dur * 0.2), gain, dur * 0.2, dur * 0.8);
    s.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
  }

  /**
   * Each character's voice: base pitch (Hz), waveform, syllables a second, formant shift (1 = adult), vibrato (Hz, depth),
   * pitch spread (semitones), gain; extras: sing (an arpeggio, legato), clack (a woody click per syllable), echo, squawk
   * (a falling glide), gurgle (fast wobble).
   */
  const VOICES = {
    normal: { f0: 118, type: "sawtooth", rate: 12, fmt: 1, spread: 3, gain: 0.32 },
    sailor: { f0: 132, type: "sawtooth", rate: 12.5, fmt: 1, spread: 4, gain: 0.28 },
    marine: { f0: 150, type: "square", rate: 14, fmt: 1.05, spread: 2, gain: 0.22 },
    cook: { f0: 205, type: "square", rate: 12, fmt: 1.12, spread: 4, gain: 0.22 },
    monkey: { f0: 560, type: "square", rate: 15, fmt: 1.5, spread: 9, gain: 0.18 },
    skeleton: { f0: 95, type: "triangle", rate: 9, fmt: 0.8, spread: 2, gain: 0.25, clack: 1 },
    gull: { f0: 900, type: "sawtooth", rate: 9, fmt: 1.6, spread: 3, gain: 0.16, squawk: 1 },
    tiny: { f0: 68, type: "sawtooth", rate: 7.5, fmt: 0.72, spread: 2, gain: 0.4 },
    gulls: { f0: 760, type: "sawtooth", rate: 10, fmt: 1.5, spread: 4, gain: 0.18, squawk: 1 },
    admiral: { f0: 152, type: "triangle", rate: 9.5, fmt: 0.95, vib: [6, 0.035], spread: 5, gain: 0.6 },
    chef: { f0: 290, type: "square", rate: 12.5, fmt: 1.18, vib: [9, 0.02], spread: 5, gain: 0.2 },
    pip: { f0: 520, type: "square", rate: 17, fmt: 1.45, spread: 6, gain: 0.17 },
    bubbles: { f0: 225, type: "sine", rate: 11, fmt: 1, vib: [19, 0.09], spread: 4, gain: 0.5, gurgle: 1 },
    encore: { f0: 262, type: "triangle", rate: 6, fmt: 1, vib: [5.5, 0.045], spread: 0, gain: 0.3, sing: 1 },
    clackers: { f0: 175, type: "square", rate: 12, fmt: 0.92, spread: 4, gain: 0.2, clack: 1 },
    mime: null,
    pale: { f0: 92, type: "sine", rate: 6, fmt: 0.8, vib: [3, 0.03], spread: 2, gain: 0.26, echo: 1 },
  };
  /** Vowel formants (Hz): F1, F2. */
  const VOWEL = { a: [800, 1200], e: [500, 1850], i: [320, 2250], o: [520, 900], u: [360, 780], y: [320, 2250] };
  const SING = [1, 1.26, 1.5, 2, 1.5, 1.26, 1.5, 1.68, 2, 1.5];
  let lastBabble = 0;

  /**
   * A character's gibberish voice for a line of text (the speech bubbles): `archetype` is a captain's archetype id or a
   * crew voice (sailor marine cook monkey skeleton gull tiny). The Mime says nothing at all; "…" says nothing either.
   */
  function babble(archetype, text) {
    const V = VOICES[archetype] === undefined ? VOICES.normal : VOICES[archetype];
    const s = String(text || "").toLowerCase();
    if (!V || !/[a-z]/.test(s)) return;
    const L = liveNow(); if (!L) return;
    const now = performance.now();
    if (now - lastBabble < 120) return;                    // two at once would mush
    lastBabble = now;
    const { ctx, h } = L;
    const words = s.replace(/[^a-z?!\s]/g, "").split(/\s+/).filter(Boolean);
    const q = /\?\s*$/.test(s), bang = /!/.test(s);
    // One syllable per vowel group (a word has at least one); at most 16.
    const syl = [];
    for (const w of words) {
      const groups = w.match(/[^aeiouy]*[aeiouy]+[^aeiouy]*/g) || [w];
      for (const g of groups) syl.push({ v: (g.match(/[aeiouy]/) || ["a"])[0], c: g.charCodeAt(0) || 97, end: g === groups[groups.length - 1] });
    }
    const n = Math.min(16, syl.length);
    const step = 1 / V.rate;
    const out = h.gain(1, L.bus);
    out.connect(h.gain(V.echo ? 0.6 : 0.12, L.sea));
    if (V.echo) { const d = h.delay(0.23); const fb = h.gain(0.45); out.connect(d); d.connect(fb); fb.connect(d); d.connect(L.bus); setTimeout(() => { try { fb.disconnect(); d.disconnect(); } catch { /* gone */ } }, (n * step + 3) * 1000); }
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      const S = syl[i];
      const last = i === n - 1;
      const semis = V.sing ? 12 * Math.log2(SING[i % SING.length]) : ((S.c * 7 + i * 3) % (2 * V.spread + 1)) - V.spread + (q && last ? 5 : 0) + (bang && i === 0 ? 3 : 0);
      const f = V.f0 * 2 ** (semis / 12) * (0.97 + 0.06 * Math.random());
      const dur = step * (V.sing ? 1.25 : S.end ? 0.95 : 0.8) * (last && (q || V.sing) ? 1.8 : 1);
      const g = h.gain(0.0001, out);
      const [F1, F2] = VOWEL[S.v] || VOWEL.a;
      const f1 = h.filter("bandpass", F1 * V.fmt, 5, g), f2 = h.filter("bandpass", F2 * V.fmt, 7, g);
      const mix = h.gain(1); mix.connect(f1); mix.connect(f2);
      const o = h.osc(V.type, f, t, t + dur + 0.05, mix);
      if (V.squawk) { o.frequency.setValueAtTime(f * 1.35, t); o.frequency.exponentialRampToValueAtTime(f * 0.7, t + dur); }
      else if (q && last) o.frequency.linearRampToValueAtTime(f * 1.25, t + dur);
      if (V.vib) { const lfo = h.osc("sine", V.vib[0], t, t + dur + 0.05); const dep = h.gain(f * V.vib[1]); lfo.connect(dep); dep.connect(o.frequency); }
      // The formant filters eat level: the source is driven hot, the envelope keeps it to a blip.
      h.swell(g.gain, t, 0.012, V.gain * 3.2 * (bang && i === 0 ? 1.3 : 1), dur * 0.35, dur * 0.55);
      if (V.clack) hiss(2200, 1600, 0.03, { gain: 0.2, when: t - ctx.currentTime, q: 3 });
      if (V.gurgle && i % 3 === 1) tone(500 + Math.random() * 300, 1400, 0.05, { gain: 0.08, when: t - ctx.currentTime + dur * 0.5 });
      o.onended = () => { try { g.disconnect(); mix.disconnect(); } catch { /* gone */ } };
      t += dur + step * (S.end ? 0.45 : 0.12);
    }
    setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (t - ctx.currentTime + (V.echo ? 3 : 1)) * 1000);
  }

  const soon = (ms, fn) => setTimeout(() => { if (!disposed) fn(); }, Math.max(0, ms));
  /** A pie landing in someone's face. */
  function splat() { hiss(900, 240, 0.22, { gain: 0.5, type: "lowpass", q: 0.8 }); play("hit_thud", { gain: 0.35, pitch: 1.5, force: true }); }

  /** The whacky captains' gimmick moments (`boardfight {stage: "gimmick", what}`), as little noises. */
  function gimmickSfx(p = {}) {
    switch (String(p.what || "")) {
      case "coat_collapse": play("brace_thud", { gain: 0.5, pitch: 0.8, force: true }); [0, 140, 300].forEach((ms, i) => soon(ms, () => play("gull", { force: true, pitch: 1 + i * 0.12, gain: 0.8 }))); break;
      case "gull_down": play("gull", { force: true, pitch: 1.35, gain: 0.6 }); break;
      case "tea": soon(400, () => hiss(500, 1700, 0.55, { gain: 0.22, q: 2.5 })); break;                    // a long, proper slurp
      case "pie": hiss(1800, 600, 0.35, { gain: 0.18, type: "highpass", q: 0.7 }); break;                     // the whoosh of a flung pie
      case "tiny_down": play("brace_thud", { gain: 1, pitch: 0.55, force: true }); play("splinters", { gain: 0.5, force: true }); break;
      case "dodge": play("whizz", { gain: 0.5, pitch: 1.2, force: true }); break;
      case "shield_pop": [0, 70, 150].forEach((ms) => tone(1100 + Math.random() * 500, 180, 0.07, { gain: 0.32, when: ms / 1000 })); play("splash_ball", { gain: 0.25, pitch: 1.6, force: true }); break;
      case "shield_up": for (let i = 0; i < 6; i++) tone(300 + i * 140, 900 + i * 160, 0.05, { gain: 0.12, when: i * 0.07 }); break;
      case "slip": tone(700, 1500, 0.2, { type: "triangle", gain: 0.2 }); soon(220, () => play("brace_thud", { gain: 0.4, pitch: 1.1, force: true })); break;
      case "aria_cut": tone(620, 160, 0.6, { type: "triangle", gain: 0.25 }); break;                           // the high note, deflating
      case "claw_block": play("clash", { gain: 0.5, pitch: 1.35, force: true }); hiss(2600, 2000, 0.03, { gain: 0.3, when: 0.06, q: 4 }); break;
      case "wall": tone(1900, 2500, 0.5, { gain: 0.05, when: 0.05 }); break;                                    // a pane that isn't there, faintly
      case "fade": hiss(1600, 200, 0.9, { gain: 0.22, q: 0.9 }); tone(160, 90, 1.0, { gain: 0.15 }); break;
      case "fade_end": hiss(200, 1400, 0.5, { gain: 0.15, q: 0.9 }); break;
      case "pass_through": play("whizz", { gain: 0.45, pitch: 0.7, force: true }); break;
      case "reassemble": for (let i = 0; i < 7; i++) hiss(2400 + Math.random() * 800, 1800, 0.025, { gain: 0.25, when: i * 0.06 + Math.random() * 0.03, q: 4 }); break;
      case "monkey_steal": play("coins", { gain: 0.55, pitch: 1.3, force: true }); break;
      case "monkey_swat": play("hit_thud", { gain: 0.4, pitch: 1.6, force: true }); break;
      default: break;
    }
  }

  /**
   * Let the raid's events play themselves. Returns an unsubscribe.
   *   wheel intents → spoke clicks · sail changes (tick) → fill / luff · spyglass on → the brass slide
   *   volley ours (by "rexmaw"): weapon broadside → 7 guns rippling + the roll · heavy → the heavy blast ·
   *     chain → the bow chasers + chain whirr · mortar → launch thumps · barrels → barrels over the stern;
   *     theirs → near or far guns by range, from the ship · ports → lids and carriages from that ship
   *   dry_fire → a dull click · sprint on → every sail drawing · mortar_shot → whistle + impact at its eta
   *   barrel drop → plop (once per barrel), ignite → whoosh
   *   impact from:"rexmaw" on a ship → hit thud (+ splinters there) · on us → splinters / mast_hit / grape_hit
   *     (braced: softer), a splash beside us → whizz + splash · enemy shot passing close (tick) → whizz
   *   fire start → whoomp · leak start/patched → burst / mallet · sink → sink (split → splinters + splash)
   *   brace → thud (+ perfect) · swivel → the swivel gun · pickup → pull-in pluck (+ coins for gold) ·
   *   bank → pull-in + coins (no bells: they ring only at buoys) · board → clashes each round · jobs: repair → hammering, bail → pumping
   *   hazard: wave telegraph → surge, hit → wave_hit · lightning → thunder · mortar telegraph → whistle,
   *     land → impact · reef/shoal hit → aground · kraken ink/grab/arm → tremor / roar + slap ·
   *     overboard → splash · explosion → explosion
   *   v4 boardfight: start → grapples + steel · hit → clash (thinned) · the Captain's pistol (intent / hit by
   *     "pistol") → the flintlock · rally (intent) → drums · captain → a heavy clash · struck → coins · repelled → splash ·
   *     gimmick (the whacky captains) → gulls, a slurp, a pie's whoosh, bubble pops, a squeak, claws, mist, bones…
   *   v4 sea_event warn: spout/squall → far thunder · waves → surge · kraken arm → tremor · fog → nothing ·
   *     derelict / treasure → a distant bell
   */
  function wire(bus) {
    if (!bus?.on) return () => {};
    let last = null, lastSpoke = null, barrelsAt = -1e9, lastJob = 0;
    const whizzed = new Set(), dropped = new Set(), timers = new Set();
    const later = (ms, fn) => { const id = setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, ms)); timers.add(id); };
    const contactPos = (id) => { const c = (last?.contacts || []).find((x) => x.id === id); return c ? { x: c.x, y: 2, z: c.z } : null; };
    const distTo = (p) => (p && last?.ship ? Math.hypot(p.x - last.ship.x, p.z - last.ship.z) : Infinity);
    const posOr = (p) => (R?.listener ? p : null);
    const xz = (p) => (Number.isFinite(p?.x) ? { x: p.x, y: 1, z: p.z } : null);
    const ours = (by) => by === "rexmaw" || by === "us";
    const far = (d, near = 0.9, away = 0.45) => (d < 300 ? near : away);
    /** v4 whacky sea events, by kind: (payload, stage, at (positional or null), distance) → sounds. */
    const WHACKY_SFX = {
      gerald(p, st, at, d) {
        if (st === "warn") play("tremor", { gain: 0.5 });
        else if (st === "leap") { play("surge", { at, gain: 0.7 }); play("splash_ball", { at, gain: 1, pitch: 0.6, force: true }); }
        else if (st === "hit" || st === "splash") {
          play("wave_hit", { at, gain: p.target === "rexmaw" ? 1 : p.near ? 0.85 : far(d, 0.7, 0.4), force: true });
          later(90, () => play("splash_ball", { at, gain: 0.9, pitch: 0.55, force: true }));
          if (p.target && p.target !== "rexmaw") later(160, () => play("splinters", { at, gain: 0.8, force: true }));
        }
      },
      sky_whale(p, st, at, d) {
        if (st === "warn") play("whale_song", { at, gain: 0.45 });
        else if (st === "start") play("surge", { at, gain: 0.6 });
        else if (st === "phase" && p.phase === "loop") play("whale_song", { gain: 0.8, force: true });
        else if (st === "flop") { play("wave_hit", { at, gain: 1, pitch: 0.7, force: true }); later(120, () => play("explosion", { at, gain: 0.35, pitch: 0.5, force: true })); later(500, () => play("surge", { gain: 0.7 })); }
        else if (st === "hit") play("wave_hit", { gain: 0.9, force: true });
        else if (st === "capsized") play("sink", { at, gain: 0.6 });
      },
      dolphins(p, st, at) {
        if (st === "warn" || st === "joined") play("dolphin", { at, gain: 0.8 });
        else if (st === "boost") { play("dolphin", { gain: 1, force: true }); play("sprint", { gain: 0.8, force: true }); }
      },
      flying_fish(p, st, at) {
        if (st === "warn") play("splash_ball", { at, gain: 0.35, pitch: 1.6 });
        else if (st === "caught") { for (let i = 0; i < 4; i++) later(i * 110, () => play("slap", { gain: 0.5, pitch: 1.3 + Math.random() * 0.3, force: true })); later(500, () => play("pickup", { force: true })); }
      },
      jellyfish(p, st, at, d) {
        if (st === "warn") play("zap", { at, gain: 0.25 });
        else if (st === "hit") play("zap", { gain: 0.9, force: true });
        else if (st === "zap" && d < 300) play("zap", { at, gain: 0.4 });
      },
      turtle(p, st, at) {
        if (st === "warn" || st === "start") play("tremor", { at, gain: 0.6 });
        else if (st === "hit") play("brace_thud", { gain: 0.9, force: true });
        else if (st === "salvaged") play("coins", { force: true });
      },
      admiral(p, st, at) {
        if (st === "warn") { play("gull", { at, gain: 0.9 }); later(700, () => play("bosun_pipe", { gain: 0.8 })); }
        else if (st === "dive") { play("gull", { at, gain: 1, force: true }); later(400, () => play("slap", { at, gain: 0.5, force: true })); }
        else if (st === "medal") { play("bosun_pipe", { force: true }); later(900, () => play("coins", { force: true })); }
      },
    };
    const offs = [
      bus.on("intent", ({ name, payload } = {}) => {
        if (name === "wheel" && Number.isFinite(payload?.value)) {
          const spoke = Math.round(payload.value * 12);
          if (lastSpoke != null && spoke !== lastSpoke) play("wheel", { pitch: 1 + payload.value * 0.06, gain: 0.8 });
          lastSpoke = spoke;
        } else if (name === "spyglass" && payload?.on && !payload.contactId) play("spyglass");
      }),
      bus.on("tick", (s) => {
        if (!s) return;
        const a = last?.ship?.sail, b = s.ship?.sail;
        if (last && Number.isFinite(a) && Number.isFinite(b) && a !== b) play(b > a ? "fill" : "luff", { pitch: 0.9 + 0.08 * b });
        // Enemy shot tearing past close: one whizz per ball, as it crosses within 30 m.
        if (s.ship) {
          for (const p of s.projectiles || []) {
            if (!p || p.from === "rexmaw" || whizzed.has(p.id)) continue;
            const d = Math.hypot(p.x - s.ship.x, p.z - s.ship.z);
            if (d < 30 && (p.y ?? 5) > 2) { whizzed.add(p.id); play("whizz", { pan: Math.max(-1, Math.min(1, (p.x - s.ship.x) / -30)), gain: 0.9 }); }
          }
          if (whizzed.size > 200) whizzed.clear();
        }
        // Work in progress: the carpenter's mallet on a repair, the chain pump on a bail (quiet, every ~1.5 s).
        const now = performance.now();
        if (s.phase === "sailing" && now - lastJob > 1500) {
          const jobs = (s.orders || []).filter((o) => o && (o.kind === "repair" || o.kind === "bail") && o.status !== "done");
          if (jobs.length) {
            lastJob = now;
            const j = jobs[(Math.random() * jobs.length) | 0];
            play(j.kind === "repair" ? "hammer" : "pump", { gain: 0.35, pan: (Math.random() - 0.5) * 0.6, pitch: 0.95 + Math.random() * 0.1 });
          }
        }
        last = s;
      }),
      bus.on("volley", (p = {}) => {
        if (ours(p.by)) {
          const w = p.weapon || (p.ammo === "heavy" ? "heavy" : p.ammo === "chain" ? "chain" : p.ammo === "mortar" ? "mortar" : "broadside");
          if (w === "heavy") heavyVolley({ side: p.side, balls: p.balls });
          else if (w === "chain") { volley({ side: "bow", balls: Math.min(3, p.balls || 2), near: true, ammo: "chain", roll: false }); }
          else if (w === "mortar") { for (let i = 0; i < Math.min(3, p.balls || 3); i++) later(i * 260, () => play("mortar_launch", { pan: (Math.random() - 0.5) * 0.4, force: true, pitch: 0.95 + Math.random() * 0.1 })); }
          else if (w === "barrels") { barrelsAt = performance.now(); for (let i = 0; i < Math.min(4, p.balls || 3); i++) later(i * 300, () => play("barrel_drop", { pan: (Math.random() - 0.5) * 0.4, force: true })); }
          else volley({ side: p.side, balls: Math.min(8, p.balls || 7), near: true, ammo: p.ammo });
          return;
        }
        const tower = String(p.by || "").startsWith("tower:") || String(p.by || "").startsWith("fort:");
        const at = tower ? (contactPos(String(p.by).split(":")[1]) || null) : contactPos(p.by);
        const d = distTo(at);
        if (p.weapon === "mortar" || p.ammo === "mortar") { play("mortar_launch", { at: posOr(at), gain: d < 250 ? 0.8 : 0.5 }); return; }
        volley({ side: "bow", balls: Math.min(6, p.balls || 3), near: d < 220, at: posOr(at), ammo: p.ammo, gain: d < 220 ? 0.85 : 1, roll: false });
      }),
      bus.on("dry_fire", (p = {}) => play("dry_fire", { pan: p.side === "port" ? -0.5 : p.side === "starboard" ? 0.5 : 0 })),
      bus.on("sprint", (p = {}) => { if (p.on) play("sprint"); }),
      bus.on("mortar_shot", (p = {}) => {
        // Our shells: they whistle down onto the ring and land at its eta.
        const eta = Number(p.eta) || 2.5, at = posOr(xz(p));
        later((eta - 2.2) * 1000, () => play("mortar_whistle", { at, gain: 0.55, force: true }));
        later(eta * 1000, () => play("mortar_impact", { at, gain: 0.85, force: true }));
      }),
      bus.on("barrel", (p = {}) => {
        const at = posOr(xz(p));
        if (p.stage === "drop") { if (!dropped.has(p.id) && performance.now() - barrelsAt > 1500) play("barrel_drop", { at }); dropped.add(p.id); if (dropped.size > 100) dropped.clear(); }
        else if (p.stage === "ignite") play("barrel_ignite", { at, force: true });
      }),
      bus.on("ports", (p = {}) => { if (p.open !== false) play("ports", { at: posOr(contactPos(p.id)), gain: 0.9 }); }),
      bus.on("impact", (p = {}) => {
        const k = p.braced ? 0.6 : 1;
        if (p.target === "rexmaw") {
          if (p.kind === "splash") { play("whizz", { gain: 0.7 }); play("splash_ball", { delay: 0.25, pan: (Math.random() - 0.5) * 1.2 }); return; }
          if (p.kind === "explosion" || p.ammo === "fireship") { play("explosion"); return; }
          if (p.ammo === "mortar") { play("mortar_impact", { gain: k }); play("splinters", { gain: 0.7 * k }); return; }
          const id = p.kind === "mast" ? "mast_hit" : p.kind === "crew" ? "grape_hit" : p.kind === "water" ? "burst" : "splinters";
          play(id, { gain: k, pan: (Math.random() - 0.5) * 0.8 });
          return;
        }
        const at = Number.isFinite(p.x) ? { x: p.x, y: p.y ?? 1, z: p.z } : contactPos(p.target);
        const near = distTo(at) < 260;
        if (p.kind === "splash") { play(p.ammo === "mortar" ? "mortar_impact" : "splash_ball", { at: posOr(at), gain: near ? 0.8 : 0.5 }); return; }
        if (p.from === "rexmaw" || p.from === "us") play("hit_thud", { gain: Math.min(1, 0.45 + 0.04 * (Number(p.dmg) || 0)), pitch: 0.9 + Math.random() * 0.15 });
        if (p.ammo === "mortar") play("mortar_impact", { at: posOr(at), gain: near ? 0.8 : 0.5 });
        play(p.kind === "mast" ? "mast_hit" : p.kind === "crew" ? "grape_hit" : "splinters", { at: posOr(at), gain: near ? 0.7 : 0.4 });
      }),
      bus.on("fire", (p = {}) => { if (p.stage === "start") play("fire_start", { at: p.target === "rexmaw" ? null : posOr(contactPos(p.target)), gain: p.target === "rexmaw" ? 1 : 0.6 }); }),
      bus.on("leak", (p = {}) => {
        if (p.stage === "start") play("burst");
        else if (p.stage === "patched") { play("hammer", { gain: 0.9 }); later(160, () => play("hammer", { gain: 0.7, pitch: 1.05, force: true })); }
      }),
      bus.on("sink", (p = {}) => {
        if (p.cause === "explode" || p.cause === "explosion") play("explosion", { at: posOr(contactPos(p.id)) });
        play("sink", { at: posOr(contactPos(p.id)), delay: 0.2 });
      }),
      bus.on("split", (p = {}) => { const at = posOr(contactPos(p.id)); play("splinters", { at, pitch: 0.8, force: true }); play("splash_ball", { at, delay: 0.3, force: true }); }),
      bus.on("brace", (p = {}) => { if (p.stage === "start") return; play("brace_thud"); if (p.perfect) play("perfect", { delay: 0.05 }); }),
      bus.on("swivel", (p = {}) => {
        play("swivel");
        if (p.hit) later(260, () => play("splinters", { gain: 0.5, pitch: 1.2, at: posOr(contactPos(p.targetId)) }));
        else later(420, () => play("splash_ball", { gain: 0.4 }));
      }),
      bus.on("pickup", (p = {}) => {
        play("pickup", { force: true, pitch: p.kind === "chest" ? 0.9 : 1 });
        if (p.kind === "chest" || p.kind === "bottle" || (Number(p.gold) || 0) > 0) later(250, () => play("coins", { gain: p.kind === "chest" ? 0.9 : 0.5, force: true }));
      }),
      bus.on("bank", () => { play("pickup", { force: true, pitch: 0.85 }); later(300, () => play("coins", { force: true })); }),
      bus.on("plunder", (p = {}) => { if ((p.amount || 0) > 0) play("coins", { gain: 0.6 }); }),
      bus.on("job", (p = {}) => {
        if (p.stage !== "start") return;
        if (p.kind === "repair") play("hammer", { gain: 0.6 });
        else if (p.kind === "bail") play("pump", { gain: 0.6 });
      }),
      bus.on("hazard", (p = {}) => {
        const at = Number.isFinite(p.x) ? { x: p.x, y: 2, z: p.z } : null;
        if (p.kind === "wave") { if (p.stage === "telegraph" || p.stage === "warn") play("surge"); else if (p.stage === "hit") play("wave_hit"); }
        else if (p.kind === "lightning" && (p.stage === "strike" || p.stage === "hit")) play(distTo(at) < 400 ? "thunder_near" : "thunder_far", { gain: 1 });
        else if (p.kind === "mortar" && (p.stage === "telegraph" || p.stage === "warn")) {
          const eta = Number(p.eta);
          if (Number.isFinite(eta) && eta > 2.3) later((eta - 2.2) * 1000, () => play("mortar_whistle", { at: posOr(at), force: true }));
          else play("mortar_whistle", { at: posOr(at) });
        } else if (p.kind === "mortar" && p.stage === "land") play("mortar_impact", { at: posOr(at) });
        else if (p.kind === "kraken") {
          if (p.stage === "ink" || p.stage === "telegraph") play("tremor");
          else if (p.stage === "grab" || p.stage === "rise") { play("roar"); later(900, () => play("slap", { force: true })); }
          else if (p.stage === "repelled" || p.stage === "arm") play("slap", { gain: 0.7 });
          // v5: the Kraken's eye takes a wound (a roar) / goes under (a slap of water).
          else if (p.eye && p.stage === "wound") play("roar", { gain: 0.8 });
          else if (p.eye && (p.stage === "dive" || p.stage === "driven")) play("slap", { gain: 0.8 });
        } else if ((p.kind === "shoal" || p.kind === "reef" || p.kind === "island") && (p.stage === "hit" || p.stage === "aground")) play("aground");
        else if (p.kind === "spout" && p.stage === "hit") play("wave_hit", { gain: 0.8 });
      }),
      bus.on("overboard", (p = {}) => { if (p.stage === "swept") play("overboard"); }),
      // v4: the boarding fight. The pistol sounds on the click (the intent), so a miss still bangs.
      bus.on("intent", ({ name } = {}) => {
        if (name === "pistol") play("pistol", { pan: (Math.random() - 0.5) * 0.3, force: true });
        else if (name === "rally") play("rally", { force: true });
      }),
      bus.on("boardfight", (p = {}) => {
        const st = String(p.stage || "");
        if (st === "start") { play("grapple", { force: true }); later(700, () => play("clash", { force: true, gain: 0.8 })); }
        else if (st === "hit") { if (!staged && p.by !== "pistol" && Math.random() < 0.55) play("clash", { gain: 0.45 + 0.3 * Math.random(), pan: (Math.random() - 0.5) * 0.8 }); }
        else if (st === "down") { if (!staged) play("brace_thud", { gain: 0.45, pan: (Math.random() - 0.5) * 0.6 }); }
        else if (st === "captain") { play("clash", { force: true, pitch: 0.82 }); later(180, () => play("brace_thud", { force: true, gain: 0.6 })); }
        else if (st === "struck") later(300, () => play("coins", { force: true }));
        else if (st === "repelled") play("splash_ball", { force: true, gain: 0.7 });
        else if (st === "gimmick") gimmickSfx(p);
      }),
      bus.on("sea_event", (p = {}) => {
        const k = String(p.kind || "");
        if (WHACKY_SFX[k]) { WHACKY_SFX[k](p, String(p.stage || ""), posOr(xz(p)), distTo(xz(p))); return; }
        if (p.stage !== "warn") return;
        const at = posOr(xz(p)), d = distTo(xz(p));
        if (/spout|whirl|squall|gust/.test(k)) play("thunder_far", { at, gain: d < 600 ? 0.6 : 0.4 });
        else if (/wave/.test(k)) play("surge", { gain: 0.8 });
        else if (/kraken|arm|tentacle/.test(k)) play("tremor", { gain: 0.8 });
        else if (/derelict|wreck|treasure|flotsam|loot/.test(k)) play("buoy_bell", { at, gain: 0.35 });
      }),
      // v4.2 power-ups: taken → the arpeggio (pitched per kind) + a touch of what it does; up in view → a soft bloom
      // there; a buff wearing off → two falling notes.
      bus.on("powerup", (p = {}) => {
        const st = String(p.stage || ""), k = String(p.kind || "");
        if (st === "pickup") {
          play("powerup", { force: true, pitch: PW_PITCH[k] || 1 });
          const extra = PW_EXTRA[k];
          if (extra) later(extra[2] || 120, () => play(extra[0], { force: true, gain: extra[1] }));
        } else if (st === "spawn") { const at = posOr(xz(p)); if (distTo(xz(p)) < 450) play("powerup_spawn", { at, gain: 0.8 }); }
        else if (st === "expire" && p.buff) play("powerup_end", { gain: 0.8 });
      }),
    ];
    return () => {
      offs.forEach((off) => { try { off?.(); } catch { /* gone */ } });
      timers.forEach((id) => clearTimeout(id));
    };
  }

  return {
    ready, play, loop, volley, heavyVolley, strikes, wire, boardfight,
    /** A character's gibberish voice for a line (the boarding fight's speech bubbles): babble(archetype | crew voice, text). */
    babble,
    has: (name) => !!buffers[name],
    renderMs: () => renderMs,
    failed: () => failed.slice(),
    buffers: () => ({ ...buffers }),
    live: () => graphLive(),
    dispose() {
      disposed = true;
      offMix?.();
      if (live) { try { live.bus.disconnect(); } catch { /* gone */ } live = null; }
    },
  };
}
