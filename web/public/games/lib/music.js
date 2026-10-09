/*
 * Rexclaw mini-games: the band. Background music played live by a small
 * synthesiser and sequencer on Web Audio: no audio files, nothing to
 * license, and every game gets tunes of its own.
 *
 * A track is data: tempo, metre, a chord per bar, and parts. Each part is
 * an instrument with a rhythm (one character per step: x hit, X accent,
 * . rest) and what to play on it: the chord's root/fifth/octave (seq), the
 * whole chord, an arpeggio, or a melody composed from the track's seed (the
 * same tune every time, so it sticks). Drums are parts too.
 *
 *   RexGame.music.play("brine-barnacle")   RexGame.music.stop()
 *   RexGame.music.setVolume(0..1)          RexGame.music.TRACKS
 *
 * For games that score their own scenes (all optional; a track that uses
 * none of it sounds and routes exactly as it always did):
 *   part.layer: "pad"          the part plays into a named layer that
 *                              layers() fades in and out on bar lines
 *   track.reverb: 0..1         a convolution hall send (0: none is built)
 *   RexGame.music.layers(["pad", "bass"] | null, { fade })
 *   RexGame.music.stinger({ inst, degrees, step, oct, vol, dur } | name)
 *   RexGame.music.clock()      tempo, position, key and the sounding chord
 *   RexGame.music.play(id, { fadeOut: 2 })     fade the last track out first
 *
 * Needs juice.js (it plays through the same AudioContext).
 */
(function () {
  "use strict";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---- Notes and chords ------------------------------------------------------

  const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const QUALITY = { "": [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
    dim: [0, 3, 6], sus4: [0, 5, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 14] };
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
    harmonic: [0, 2, 3, 5, 7, 8, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], penta: [0, 3, 5, 7, 10] };
  const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

  /** "F#m7" → { root: pitch class, tones: [semitones] } */
  function chord(sym) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(sym);
    const pc = (NAMES[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
    return { root: pc, tones: QUALITY[m[3]] || QUALITY[""] };
  }

  function rng(seed) {
    let s = 0;
    for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // ---- The tracks ------------------------------------------------------------
  // steps = steps per bar; beat = steps per beat (4: sixteenths; 3: 6/8 eighths).

  const TRACKS = {
    "below-deck": { name: "Below Deck", bpm: 96, beat: 3, steps: 6, swing: 0, key: "D", scale: "minor", seed: 7,
      chords: ["Dm", "Dm", "C", "Dm", "F", "C", "Dm", "A"],
      parts: [
        { inst: "bass", rhythm: "x..x..", seq: [0, 2] , oct: 2 },
        { inst: "accordion", rhythm: "..x..x", chordStab: true, oct: 4, vol: 0.5 },
        { inst: "accordion", melody: "x.xx.x", oct: 5, vol: 0.7 },
        { drum: "shaker", rhythm: "xxxxxx" }, { drum: "stomp", rhythm: "x..x.." },
      ] },
    "chart-chiptune": { name: "Chart Room Chiptune", bpm: 138, beat: 4, steps: 16, key: "C", scale: "major", seed: 11,
      chords: ["C", "G", "Am", "F"],
      parts: [
        { inst: "chipbass", rhythm: "x.x.x.x.x.x.x.x.", seq: [0, 3], oct: 2 },
        { inst: "chip", arp: "up", rhythm: "xxxxxxxxxxxxxxxx", oct: 4, vol: 0.35 },
        { inst: "chiplead", melody: "x..x..x.x.x...x.", oct: 5 },
        { drum: "kick", rhythm: "x...x...x...x..." }, { drum: "noisesnare", rhythm: "....x.......x..." }, { drum: "hat", rhythm: "..x...x...x...x." },
      ] },
    "lazy-doubloons": { name: "Lazy Doubloons", bpm: 78, beat: 4, steps: 16, swing: 0.22, key: "C", scale: "major", seed: 3,
      chords: ["Fmaj7", "Em7", "Dm7", "Cmaj7"],
      parts: [
        { inst: "rhodes", rhythm: "x.....x...x.....", chordStab: true, oct: 4, vol: 0.55 },
        { inst: "bass", rhythm: "x.......x..x....", seq: [0, 0, 2], oct: 2 },
        { inst: "bell", melody: "....x.x.....x...", oct: 5, vol: 0.5 },
        { drum: "softkick", rhythm: "x.......x.x....." }, { drum: "rim", rhythm: "....x.......x..." }, { drum: "hat", rhythm: "x.x.x.x.x.x.x.x.", vol: 0.4 },
        { drum: "vinyl" },
      ] },
    "brine-barnacle": { name: "The Brine & Barnacle", bpm: 116, beat: 3, steps: 6, key: "A", scale: "minor", seed: 21,
      chords: ["Am", "Am", "G", "Am", "C", "G", "Am", "E"],
      parts: [
        { inst: "bass", rhythm: "x..x..", seq: [0, 2], oct: 2 },
        { inst: "accordion", rhythm: ".xx.xx", chordStab: true, oct: 4, vol: 0.45 },
        { inst: "fiddle", melody: "xxx.xx", oct: 5 },
        { drum: "stomp", rhythm: "x..x.." }, { drum: "clap", rhythm: "...x.." }, { drum: "shaker", rhythm: "xxxxxx", vol: 0.5 },
      ] },
    "candlelight-bluff": { name: "Candlelight Bluff", bpm: 70, beat: 4, steps: 16, key: "E", scale: "harmonic", seed: 5,
      chords: ["Em", "Em", "Am", "B7"],
      parts: [
        { inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.5 },
        { inst: "pluck", melody: "x..x..x...x.x...", oct: 4 },
        { inst: "bass", rhythm: "x.......x.......", seq: [0, 2], oct: 2 },
        { drum: "tick", rhythm: "x...x...x...x..." },
      ] },
    "quartermaster-lounge": { name: "Quartermaster's Lounge", bpm: 116, beat: 2, steps: 8, swing: 0.3, key: "Bb", scale: "dorian", seed: 13,
      chords: ["Cm7", "F7", "Bbmaj7", "Gm7", "Cm7", "F7", "Bbmaj7", "Bbmaj7"],
      parts: [
        { inst: "bass", rhythm: "x.x.x.x.", walk: true, oct: 2 },
        { inst: "rhodes", rhythm: "..x....x", chordStab: true, oct: 4, vol: 0.45 },
        { inst: "trumpet", melody: "x.xx..x.", oct: 4 },
        { drum: "ride", rhythm: "x.xxx.xx" }, { drum: "brush", rhythm: "..x...x." },
      ] },
    "high-stakes": { name: "High Stakes", bpm: 120, beat: 4, steps: 16, key: "E", scale: "minor", seed: 17,
      chords: ["Em", "Em", "C", "B7"],
      parts: [
        { inst: "pluck", rhythm: "x.xx.x.xx.x.x.x.", seq: [0, 2, 3, 2], oct: 3, vol: 0.6 },
        { inst: "strings", rhythm: "x...............", chordHold: 16, oct: 4, vol: 0.4 },
        { inst: "trumpet", melody: "x.......x.x.....", oct: 4 },
        { drum: "kick", rhythm: "x.....x...x....." }, { drum: "rim", rhythm: "....x.......x..." }, { drum: "hat", rhythm: "xxxxxxxxxxxxxxxx", vol: 0.3 },
      ] },
    "galley-ruckus": { name: "Galley Ruckus", bpm: 152, beat: 2, steps: 4, key: "G", scale: "major", seed: 29,
      chords: ["G", "G", "D", "G", "C", "G", "D", "G"],
      parts: [
        { inst: "bass", rhythm: "x.x.", seq: [0, 2], oct: 2 },
        { inst: "accordion", rhythm: ".x.x", chordStab: true, oct: 4, vol: 0.4 },
        { inst: "fiddle", melody: "xxxx", oct: 5 },
        { drum: "stomp", rhythm: "x.x." }, { drum: "clap", rhythm: ".x.x", vol: 0.5 },
      ] },
    "kraken-waltz": { name: "Kraken Waltz", bpm: 138, beat: 1, steps: 3, key: "D", scale: "minor", seed: 31,
      chords: ["Dm", "Dm", "A7", "A7", "Gm", "Dm", "A7", "Dm"],
      parts: [
        { inst: "tuba", rhythm: "x..", seq: [0, 2], oct: 2 },
        { inst: "accordion", rhythm: ".xx", chordStab: true, oct: 4, vol: 0.4 },
        { inst: "musicbox", melody: "x.x", oct: 5 },
      ] },
    "long-walk": { name: "The Long Walk", bpm: 96, beat: 4, steps: 16, key: "A", scale: "minor", seed: 37,
      chords: ["Am", "Am", "F", "E"],
      parts: [
        { inst: "marimba", rhythm: "x.x.x.x.x.x.x.x.", arp: "updown", oct: 4, vol: 0.55 },
        { inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.35 },
        { inst: "bass", rhythm: "x.......x.......", seq: [0], oct: 2 },
        { drum: "tick", rhythm: "x...x...x...x..." }, { drum: "tock", rhythm: "..x...x...x...x." },
      ] },
    "shark-tango": { name: "Shark Tango", bpm: 112, beat: 4, steps: 16, key: "D", scale: "harmonic", seed: 41,
      chords: ["Dm", "A7", "A7", "Dm", "Gm", "Dm", "A7", "Dm"],
      parts: [
        { inst: "bass", rhythm: "x..x..x.x.......", seq: [0, 2, 0, 3], oct: 2 },
        { inst: "accordion", rhythm: "x..x..x.x.......", chordStab: true, oct: 4, vol: 0.45 },
        { inst: "fiddle", melody: "x..x..x...x.x.x.", oct: 5 },
        { drum: "kick", rhythm: "x..x..x.x......." }, { drum: "clap", rhythm: "........x......." },
      ] },
    "quarterdeck-showdown": { name: "Quarterdeck Showdown", bpm: 92, beat: 4, steps: 16, key: "E", scale: "minor", seed: 43,
      chords: ["Em", "Em", "D", "Em", "C", "D", "B7", "Em"],
      parts: [
        { inst: "pluck", rhythm: "x.xxx.xxx.xxx.xx", seq: [0, 2, 3, 2], oct: 3, vol: 0.5 },
        { inst: "whistle", melody: "x.......x...x...", oct: 5, echo: true },
        { inst: "bass", rhythm: "x.......x.......", seq: [0, 2], oct: 2 },
        { drum: "tom", rhythm: "x.....x.x......." }, { drum: "snareroll", rhythm: "............xxxx", vol: 0.5 },
      ] },
    "cutlass-bossa": { name: "Cutlass Bossa", bpm: 124, beat: 4, steps: 16, key: "G", scale: "major", seed: 47,
      chords: ["Am7", "D7", "Gmaj7", "Cmaj7"],
      parts: [
        { inst: "nylon", rhythm: "x..x..x...x..x..", chordStab: true, oct: 4, vol: 0.45 },
        { inst: "bass", rhythm: "x..x....x..x....", seq: [0, 2], oct: 2 },
        { inst: "flute", melody: "x...x.x...x.....", oct: 5 },
        { drum: "rim", rhythm: "x..x..x...x..x.." }, { drum: "shaker", rhythm: "xxxxxxxxxxxxxxxx", vol: 0.4 }, { drum: "softkick", rhythm: "x..x....x..x...." },
      ] },
    "broadside": { name: "Broadside!", bpm: 140, beat: 4, steps: 16, key: "D", scale: "minor", seed: 53,
      chords: ["Dm", "Bb", "C", "Dm", "Dm", "Bb", "C", "A"],
      parts: [
        { inst: "bass", rhythm: "x.x.x.x.x.x.x.x.", seq: [0, 0, 3, 0], oct: 2 },
        { inst: "strings", rhythm: "x.......x.......", chordHold: 8, oct: 4, vol: 0.45 },
        { inst: "brass", melody: "x..x..x.x..x.x..", oct: 4 },
        { drum: "kick", rhythm: "x...x...x...x..." }, { drum: "snare", rhythm: "....x.......x.xx" }, { drum: "tom", rhythm: "x..x..x.........", vol: 0.6 },
        { drum: "hat", rhythm: "x.x.x.x.x.x.x.x.", vol: 0.4 },
      ] },
    "calm-before": { name: "Calm Before the Storm", bpm: 72, beat: 4, steps: 16, key: "D", scale: "dorian", seed: 59,
      chords: ["Dm7", "Gm7", "Dm7", "Am7"],
      parts: [
        { inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.45 },
        { inst: "bell", melody: "x.....x.....x...", oct: 5, echo: true },
        { inst: "bass", rhythm: "x...............", seq: [0], oct: 2 },
        { drum: "waves" },
      ] },
    "captains-gambit": { name: "The Captain's Gambit", bpm: 112, beat: 2, steps: 6, key: "D", scale: "major", seed: 61,
      chords: ["D", "A", "Bm", "F#m", "G", "D", "G", "A7"],
      parts: [
        { inst: "harpsichord", rhythm: "xxxxxx", arp: "updown", oct: 4, vol: 0.4 },
        { inst: "bass", rhythm: "x.x.x.", seq: [0, 2, 3], oct: 2, vol: 0.8 },
        { inst: "flute", melody: "x.x.xx", oct: 5, vol: 0.7 },
      ] },
    "river-noir": { name: "River Noir", bpm: 84, beat: 2, steps: 8, swing: 0.33, key: "A", scale: "dorian", seed: 71,
      chords: ["Am7", "Am7", "D7", "D7", "Am7", "F7", "E7", "E7"],
      parts: [
        { inst: "bass", rhythm: "x.x.x.x.", walk: true, oct: 2 },
        { inst: "rhodes", rhythm: "...x...x", chordStab: true, oct: 4, vol: 0.4 },
        { inst: "trumpet", melody: "x..x..x.", oct: 4, vol: 0.85, echo: true },
        { drum: "brush", rhythm: "x.x.x.x." }, { drum: "rim", rhythm: "..x...x.", vol: 0.5 }, { drum: "vinyl" },
      ] },
    "endgame-fog": { name: "Endgame in the Fog", bpm: 66, beat: 4, steps: 16, key: "C", scale: "harmonic", seed: 67,
      chords: ["Cm", "Ab", "Fm", "G7"],
      parts: [
        { inst: "pad", rhythm: "x...............", chordHold: 16, oct: 3, vol: 0.4 },
        { inst: "harpsichord", melody: "x...x.x.....x...", oct: 4, vol: 0.9, echo: true },
        { inst: "bass", rhythm: "x.......x.......", seq: [0, 2], oct: 2 },
        { drum: "tick", rhythm: "x.......x.......", vol: 0.6 }, { drum: "tock", rhythm: "....x.......x...", vol: 0.6 },
      ] },
  };

  // ---- Melody: a phrase per bar, composed once per track ----------------------

  /** The track's tune: for every bar, the notes (midi) on the melody rhythm's
   *  hits. Chord tones on the strong hits, a stepwise walk through the scale
   *  between, a motif that comes back, the last bar resolving home. */
  function compose(track, part) {
    const r = rng(track.seed + part.oct);
    const scale = SCALES[track.scale];
    const keyPc = chord(track.key).root;
    const base = 12 * (part.oct + 1) + keyPc;
    const hits = [...part.melody].map((c, i) => (c !== "." ? i : -1)).filter((i) => i >= 0);
    const scaleNotes = [];
    for (let o = -1; o <= 2; o++) for (const s of scale) scaleNotes.push(base + o * 12 + s);
    const nearest = (target, pool) => pool.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    let pos = base + scale[2];
    const bars = [];
    let motif = null;
    track.chords.forEach((sym, b) => {
      const c = chord(sym);
      const tones = scaleNotes.filter((n) => c.tones.some((t) => (n - (c.root + t)) % 12 === 0));
      // Bars 0 and 4 state the motif, 2 and 6 echo it on their own chords.
      if (motif && (b % 4 === 2)) {
        bars.push(motif.map((n) => nearest(n + (c.root - chord(track.chords[b - 2]).root), tones.concat(scaleNotes))));
        return;
      }
      const phrase = hits.map((step, i) => {
        const strong = step % (track.beat * (track.steps > 8 ? 2 : 1)) === 0;
        if (b === track.chords.length - 1 && i === hits.length - 1) return nearest(base, tones);
        if (strong || r() < 0.3) pos = nearest(pos + (r() < 0.5 ? -2 : 2) + (r() < 0.2 ? 5 : 0), tones);
        else pos = nearest(pos + (r() < 0.5 ? -1 : 1) * (1 + (r() * 2 | 0)), scaleNotes);
        pos = Math.max(base - 3, Math.min(base + 16, pos));
        return r() < 0.12 && !strong ? null : pos;
      });
      if (b % 4 === 0) motif = phrase.map((n) => n ?? pos);
      bars.push(phrase);
    });
    return { hits, bars };
  }

  // ---- Instruments -------------------------------------------------------------

  let ctx = null, out = null, echo = null, noiseBuf = null, comp = null;

  function setup() {
    ctx = window.RexGame.sfx?.context?.();
    if (!ctx || out) return !!ctx;
    out = ctx.createGain();
    out.gain.value = volume();
    comp = ctx.createDynamicsCompressor();
    out.connect(comp).connect(ctx.destination);
    // A soft echo send for whistles and bells.
    echo = ctx.createDelay(1);
    echo.delayTime.value = 0.32;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    echo.connect(fb).connect(echo);
    echo.connect(wet).connect(out);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  // ---- The hall (built on first use only) ---------------------------------------

  let verb = null, verbSend = null, sting = null;

  /** A synthetic hall: decorrelated stereo noise under an exponential decay
   *  (time constant `tau`), darkening as it fades (a one-pole lowpass falling
   *  from 6 kHz to 1.2 kHz over the tail), after an 18 ms predelay. */
  function impulse(seconds, tau, predelay = 0.018) {
    const sr = ctx.sampleRate, pre = Math.round(predelay * sr), n = pre + Math.ceil(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr), fadeFrom = n - Math.round(0.05 * sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = pre; i < n; i++) {
        const tt = (i - pre) / sr, fc = 6000 * (1200 / 6000) ** Math.min(1, tt / seconds);
        y += (1 - Math.exp(-2 * Math.PI * fc / sr)) * (Math.random() * 2 - 1 - y);
        d[i] = y * Math.exp(-tt / tau) * (i > fadeFrom ? (n - i) / (n - fadeFrom) : 1);
      }
    }
    return buf;
  }

  /** The track's reverb send: built for the first track that asks for one,
   *  then just turned up or down (to 0 for tracks without the field). */
  function reverbFor(track) {
    const wet = Math.max(0, Math.min(1, track.reverb || 0));
    if (!wet && !verb) return;
    if (!verb) {
      verb = ctx.createConvolver();
      verb.buffer = impulse(2.8, 0.6);
      verbSend = ctx.createGain();
      verbSend.gain.value = 0;
      out.connect(verbSend).connect(verb).connect(comp);
      if (sting) sting.connect(verbSend);
    }
    verbSend.gain.setTargetAtTime(wet, ctx.currentTime, 0.3);
  }

  /** Stingers' own output: beside the band (not under its fades), at the
   *  music volume. */
  function stingOut() {
    if (!sting) {
      sting = ctx.createGain();
      sting.gain.value = volume();
      sting.connect(comp);
      if (verbSend) sting.connect(verbSend);
    }
    return sting;
  }

  function env(g, t, a, peak, hold, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }

  function osc(type, freq, t, end, dest, detune = 0) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end);
    return o;
  }

  function filt(type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
  }

  /** One note: instrument `inst`, midi `m`, at `t` for `dur` seconds, into
   *  `dest` (the band's output, or a layer's gain). */
  function voice(inst, m, t, dur, vol = 1, toEcho = false, dest = out) {
    const f = mtof(m), g = ctx.createGain();
    g.connect(dest);
    if (toEcho) g.connect(echoOf.get(dest) || echo);
    const end = t + dur + 1.2;
    const V = (x) => x * vol;
    switch (inst) {
      case "bass": { const lp = filt("lowpass", 700); lp.connect(g); osc("triangle", f, t, end, lp); osc("sine", f / 2, t, end, lp);
        env(g, t, 0.01, V(0.32), dur * 0.6, 0.15); break; }
      case "tuba": { const lp = filt("lowpass", 500); lp.connect(g); osc("sawtooth", f, t, end, lp); env(g, t, 0.03, V(0.22), dur * 0.5, 0.2); break; }
      case "chipbass": osc("triangle", f, t, end, g); env(g, t, 0.005, V(0.3), dur * 0.5, 0.05); break;
      case "chip": osc("square", f, t, end, g); env(g, t, 0.005, V(0.08), 0.02, 0.08); break;
      case "chiplead": { const o = osc("square", f, t, end, g); o.detune.setValueAtTime(0, t + 0.12); o.detune.linearRampToValueAtTime(15, t + dur);
        env(g, t, 0.005, V(0.09), dur * 0.7, 0.08); break; }
      case "pad": case "strings": { const lp = filt("lowpass", inst === "pad" ? 1100 : 2200); lp.connect(g);
        osc("sawtooth", f, t, end, lp, -8); osc("sawtooth", f, t, end, lp, 8);
        env(g, t, inst === "pad" ? 0.6 : 0.25, V(0.06), dur * 0.8, 0.8); break; }
      case "accordion": { const bp = filt("bandpass", 1400, 0.6); bp.connect(g);
        osc("square", f, t, end, bp, -6); osc("sawtooth", f, t, end, bp, 7);
        const trem = ctx.createOscillator(), tg = ctx.createGain(); trem.frequency.value = 6; tg.gain.value = V(0.03);
        trem.connect(tg).connect(g.gain); trem.start(t); trem.stop(end);
        env(g, t, 0.04, V(0.11), dur * 0.75, 0.1); break; }
      case "fiddle": { const lp = filt("lowpass", 3200); lp.connect(g); const o = osc("sawtooth", f, t, end, lp);
        const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5.5; vg.gain.value = 9;
        vib.connect(vg).connect(o.detune); vib.start(t + 0.08); vib.stop(end);
        env(g, t, 0.05, V(0.075), dur * 0.75, 0.12); break; }
      case "pluck": case "nylon": { const lp = filt("lowpass", inst === "nylon" ? 1800 : 2600); lp.connect(g);
        lp.frequency.setValueAtTime(lp.frequency.value * 2, t); lp.frequency.exponentialRampToValueAtTime(400, t + 0.4);
        osc("triangle", f, t, end, lp); osc("sawtooth", f, t, end, lp, 4); env(g, t, 0.003, V(0.13), 0.02, 0.5); break; }
      case "marimba": osc("sine", f, t, end, g); osc("sine", f * 4, t, end, g); env(g, t, 0.002, V(0.17), 0.01, 0.35); break;
      case "harpsichord": { const lp = filt("lowpass", 6000, 0.8); lp.connect(g);
        lp.frequency.setValueAtTime(6000, t); lp.frequency.exponentialRampToValueAtTime(1400, t + 0.5);
        osc("sawtooth", f, t, end, lp); osc("square", f * 2, t, end, lp, 6); env(g, t, 0.002, V(0.055), 0.01, 0.6); break; }
      case "bell": case "musicbox": osc("sine", f, t, end, g); osc("sine", f * 2.76, t, end, g); osc("sine", f * 5.4, t, end, g);
        env(g, t, 0.002, V(inst === "bell" ? 0.09 : 0.07), 0.01, inst === "bell" ? 1.4 : 0.6); break;
      case "rhodes": { osc("sine", f, t, end, g); osc("triangle", f * 2, t, end, g, 3);
        const trem = ctx.createOscillator(), tg = ctx.createGain(); trem.frequency.value = 4.5; tg.gain.value = V(0.015);
        trem.connect(tg).connect(g.gain); trem.start(t); trem.stop(end);
        env(g, t, 0.005, V(0.07), dur * 0.5, 0.6); break; }
      case "trumpet": case "brass": { const lp = filt("lowpass", inst === "brass" ? 2400 : 1500, 2); lp.connect(g);
        lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(inst === "brass" ? 2600 : 1600, t + 0.08);
        osc("sawtooth", f, t, end, lp); if (inst === "brass") osc("sawtooth", f, t, end, lp, 10);
        env(g, t, 0.04, V(inst === "brass" ? 0.08 : 0.07), dur * 0.7, 0.1); break; }
      case "whistle": case "flute": { const o = osc("sine", f, t, end, g);
        const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5; vg.gain.value = 12;
        vib.connect(vg).connect(o.detune); vib.start(t + 0.1); vib.stop(end);
        if (inst === "flute") { const n = ctx.createBufferSource(), nf = filt("bandpass", f * 2, 4), ng = ctx.createGain();
          n.buffer = noiseBuf; ng.gain.value = V(0.015); n.connect(nf).connect(ng).connect(g); n.start(t); n.stop(t + dur); }
        env(g, t, 0.06, V(0.1), dur * 0.7, 0.15); break; }
      // The night orchestra (Night Raid's tracks and stingers).
      case "celesta": {   // FM: modulator at 3.5f, its depth falling from 2.2f to nothing in 0.35 s
        const stop = t + 1.2, c = osc("sine", f, t, stop, g), mod = ctx.createOscillator(), mg = ctx.createGain();
        mod.frequency.value = f * 3.5;
        mg.gain.setValueAtTime(2.2 * f, t); mg.gain.linearRampToValueAtTime(0, t + 0.35);
        mod.connect(mg).connect(c.frequency); mod.start(t); mod.stop(stop);
        env(g, t, 0.002, V(0.08), 0, 0.9); break; }
      case "fmbell": {    // FM at ratio 1.4, index 5 → 0.5 over 3 s, ringing out with τ 1.6 s
        const stop = t + 8.5, c = osc("sine", f, t, stop, g), mod = ctx.createOscillator(), mg = ctx.createGain();
        mod.frequency.value = f * 1.4;
        mg.gain.setValueAtTime(5 * f * 1.4, t); mg.gain.exponentialRampToValueAtTime(0.5 * f * 1.4, t + 3);
        mod.connect(mg).connect(c.frequency); mod.start(t); mod.stop(stop);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(V(0.07), t + 0.003);
        g.gain.setTargetAtTime(0.0001, t + 0.003, 1.6); break; }
      case "supersaw": {  // five saws spread −14…+14 cents across the stereo field, under a 1.4 kHz lowpass
        const lp = filt("lowpass", 1400); lp.connect(g);
        const stop = t + 0.8 + dur * 0.7 + 1.4;
        [-14, -7, 0, 7, 14].forEach((cents, i) => {
          const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
          if (pan) { pan.pan.value = -0.6 + 0.3 * i; pan.connect(lp); }
          // A few ms apart, so the saws don't all start in phase (the attack hides it).
          osc("sawtooth", f, t + Math.random() * 0.012, stop, pan || lp, cents);
        });
        env(g, t, 0.8, V(0.025), dur * 0.7, 1.3); break; }
      case "cello": {     // a bowed saw, 900 Hz lowpass, a 5 Hz vibrato that grows in after the bow bites
        const lp = filt("lowpass", 900, 1); lp.connect(g);
        const stop = t + 0.12 + dur * 0.85 + 0.5, o = osc("sawtooth", f, t, stop, lp);
        const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5;
        vg.gain.setValueAtTime(0, t + 0.15); vg.gain.linearRampToValueAtTime(8, t + 0.45);
        vib.connect(vg).connect(o.detune); vib.start(t); vib.stop(stop);
        env(g, t, 0.12, V(0.07), dur * 0.85, 0.4); break; }
      case "harp": {      // triangle plus an octave sine, its brightness closing 5 kHz → 1.2 kHz
        const lp = filt("lowpass", 5000); lp.connect(g);
        lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(1200, t + 0.6);
        const stop = t + 1.35, h = ctx.createGain(); h.gain.value = 0.4; h.connect(lp);
        osc("triangle", f, t, stop, lp); osc("sine", f * 2, t, stop, h);
        env(g, t, 0.002, V(0.1), 0, 1.2); break; }
      case "horn": {      // a saw whose lowpass opens 700 → 1200 Hz with the swell and settles back
        const lp = filt("lowpass", 700, 1.5); lp.connect(g);
        const hold = dur * 0.8, stop = t + 0.15 + hold + 0.5;
        lp.frequency.setValueAtTime(700, t); lp.frequency.linearRampToValueAtTime(1200, t + 0.15 + hold * 0.5);
        lp.frequency.linearRampToValueAtTime(800, t + 0.15 + hold + 0.35);
        osc("sawtooth", f, t, stop, lp); osc("sawtooth", f, t, stop, lp, 4);
        env(g, t, 0.15, V(0.06), hold, 0.35); break; }
      case "choir": {     // two saws a hair apart through "oo/ah" formants at 350 Hz and 800 Hz
        const mix = ctx.createGain(), hold = dur * 0.8, stop = t + 0.6 + hold + 1.1;
        mix.gain.value = 3.2;   // the narrow formants pass little of a saw: make it up here
        for (const [hz, w] of [[350, 1], [800, 0.6]]) {
          const bp = filt("bandpass", hz, 6), bg = ctx.createGain(); bg.gain.value = w;
          mix.connect(bp).connect(bg).connect(g);
        }
        const a = osc("sawtooth", f, t, stop, mix), b = osc("sawtooth", f, t, stop, mix, 5);
        const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 4.6; vg.gain.value = 5;
        vib.connect(vg); vg.connect(a.detune); vg.connect(b.detune); vib.start(t); vib.stop(stop);
        env(g, t, 0.6, V(0.05), hold, 1.0); break; }
      default: osc("triangle", f, t, end, g); env(g, t, 0.01, V(0.1), dur * 0.5, 0.2);
    }
  }

  function noise(t, dur, type, freq, vol, q = 1, dest = out) {
    const s = ctx.createBufferSource(), f = filt(type, freq, q), g = ctx.createGain();
    s.buffer = noiseBuf; s.connect(f).connect(g).connect(dest);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  function drum(kind, t, vol = 1, accent = false, dest = out) {
    const a = accent ? 1.3 : 1, V = (x) => x * vol * a;
    switch (kind) {
      case "kick": case "softkick": case "stomp": { const g = ctx.createGain(); g.connect(dest);
        const o = osc("sine", kind === "stomp" ? 110 : 150, t, t + 0.4, g);
        o.frequency.exponentialRampToValueAtTime(kind === "stomp" ? 55 : 45, t + 0.12);
        env(g, t, 0.002, V(kind === "softkick" ? 0.35 : 0.6), 0.02, 0.25);
        if (kind === "stomp") noise(t, 0.08, "lowpass", 800, V(0.25), 1, dest); break; }
      case "snare": noise(t, 0.18, "bandpass", 2200, V(0.3), 0.8, dest); voice("default", 55, t, 0.05, vol * 0.6, false, dest); break;
      case "noisesnare": noise(t, 0.12, "highpass", 1500, V(0.22), 1, dest); break;
      case "snareroll": noise(t, 0.06, "bandpass", 2500, V(0.15), 1, dest); break;
      case "clap": [0, 0.012, 0.024].forEach((d) => noise(t + d, 0.09, "bandpass", 1600, V(0.2), 1.2, dest)); break;
      case "hat": noise(t, 0.04, "highpass", 7000, V(0.12), 1, dest); break;
      case "ride": noise(t, 0.3, "highpass", 5000, V(0.06), 1, dest); voice("bell", 98, t, 0.05, vol * 0.25, false, dest); break;
      case "brush": noise(t, 0.25, "bandpass", 3000, V(0.07), 0.4, dest); break;
      case "shaker": noise(t, 0.05, "bandpass", 6500, V(0.06), 1.5, dest); break;
      case "rim": noise(t, 0.03, "bandpass", 1800, V(0.25), 6, dest); voice("default", 79, t, 0.02, vol * 0.4, false, dest); break;
      case "tick": noise(t, 0.02, "bandpass", 3500, V(0.25), 8, dest); break;
      case "tock": noise(t, 0.03, "bandpass", 1200, V(0.25), 8, dest); break;
      case "tom": { const g = ctx.createGain(); g.connect(dest); const o = osc("sine", 140, t, t + 0.5, g);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.3); env(g, t, 0.002, V(0.4), 0.02, 0.35); break; }
      case "timpani": { const g = ctx.createGain(); g.connect(dest); const o = osc("sine", 90, t, t + 1.6, g);
        o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.6);
        env(g, t, 0.004, V(0.5), 0.02, 1.2);
        noise(t, 0.7, "lowpass", 300, V(0.18), 0.7, dest); break; }
    }
  }

  // ---- Layers: parts a game fades in and out on bar lines ------------------------

  let layerNodes = {};          // layer name → { gain, echo, on, offAt } for the playing track
  let layerWant = null;         // the layers asked for (null: all of them)
  const echoOf = new WeakMap(); // a layer's gain → its own gated send into the echo

  /** The gain a layer's voices play into (and a twin gate for its echo), made on play. */
  function layerNode(name) {
    let L = layerNodes[name];
    if (!L) {
      const on = !layerWant || layerWant.includes(name) ? 1 : 0;
      const gain = ctx.createGain(), e = ctx.createGain();
      gain.gain.value = on; e.gain.value = on;
      gain.connect(out); e.connect(echo);
      echoOf.set(gain, e);
      L = layerNodes[name] = { gain, echo: e, on, offAt: on ? Infinity : -Infinity };
    }
    return L;
  }

  /** The time of the next bar line (or beat, with `unit` "beat") at or after the next step to schedule. */
  function boundary(unit = "bar") {
    const track = TRACKS[playing], stepDur = 60 / track.bpm / track.beat;
    const per = unit === "bar" ? track.steps : unit === "beat" ? track.beat : 1;
    return nextAt + ((per - (step % per)) % per) * stepDur;
  }

  /**
   * Fade layers of the playing track in (listed) or out (the rest); null
   * sounds them all. Changes start on the next bar line and settle over
   * about `fade` seconds. Asked before a track plays, it is how that track
   * starts — and so is one asked during a play(…, { fadeOut }) switch, which
   * leaves the outgoing track's layers as they are. Returns when the change
   * starts (ctx time), or null.
   */
  function layers(names, { fade = 1.5 } = {}) {
    layerWant = names ? [...names] : null;
    if (!playing || !ctx || switchTimer) return null;
    const at = boundary("bar");
    for (const [name, L] of Object.entries(layerNodes)) {
      const on = !layerWant || layerWant.includes(name) ? 1 : 0;
      if (on === L.on) continue;
      L.on = on;
      for (const p of [L.gain.gain, L.echo.gain]) {
        p.cancelScheduledValues(at);
        p.setTargetAtTime(on, at, Math.max(0.01, fade / 3));
      }
      // Once a layer has faded out, its notes aren't even scheduled.
      L.offAt = on ? Infinity : at + fade * 2;
    }
    return at;
  }

  // ---- The sequencer -------------------------------------------------------------

  let playing = null, timer = null, step = 0, nextAt = 0, tunes = null, beds = [], switchTimer = null;

  function scheduleStep(track, s, t, stepDur) {
    const bar = Math.floor(s / track.steps) % track.chords.length, pos = s % track.steps;
    const c = chord(track.chords[bar]);
    const key = chord(track.key).root;
    track.parts.forEach((part, pi) => {
      let dest = out;
      if (part.layer) {
        const L = layerNode(part.layer);
        if (!L.on && t > L.offAt) return;
        dest = L.gain;
      }
      if (part.drum) {
        if (!part.rhythm) return;
        const ch = part.rhythm[pos % part.rhythm.length];
        if (ch !== ".") drum(part.drum, t, part.vol ?? 1, ch === "X", dest);
        return;
      }
      const vol = part.vol ?? 1;
      if (part.melody) {
        const tune = tunes[pi], idx = tune.hits.indexOf(pos % part.melody.length);
        if (idx >= 0) {
          const n = tune.bars[bar][idx];
          const next = tune.hits[idx + 1] ?? track.steps;
          if (n != null) voice(part.inst, n, t, stepDur * (next - tune.hits[idx]) * 0.9, vol, !!part.echo, dest);
        }
        return;
      }
      const ch = part.rhythm[pos % part.rhythm.length];
      if (ch === ".") return;
      const root = 12 * (part.oct + 1) + c.root + (c.root < key - 5 ? 12 : 0);
      const tones = c.tones.map((x) => root + x);
      if (part.chordHold || part.chordStab) {
        const len = part.chordHold ? stepDur * part.chordHold : stepDur * 1.6;
        tones.slice(0, 4).forEach((n) => voice(part.inst, n, t, len, vol * 0.8, false, dest));
      } else if (part.arp) {
        const seq = part.arp === "updown" ? [...tones, ...tones.slice(1, -1).reverse()] : tones;
        voice(part.inst, seq[pos % seq.length] + (pos >= track.steps / 2 && part.arp === "up" ? 12 : 0), t, stepDur * 0.9, vol, false, dest);
      } else if (part.walk) {
        // Walking bass: root, third, fifth, a chromatic step into the next chord.
        const nextC = chord(track.chords[(bar + 1) % track.chords.length]);
        const nextRoot = 12 * (part.oct + 1) + nextC.root;
        const beatIdx = Math.floor(pos / (track.steps / 4));
        const walk = [root, root + c.tones[1], root + c.tones[2], nextRoot + (nextRoot > root ? -1 : 1)];
        voice(part.inst, walk[beatIdx % 4], t, stepDur * 1.8, vol, false, dest);
      } else {
        const seq = part.seq || [0];
        const hitIdx = [...part.rhythm.slice(0, pos + 1)].filter((x) => x !== ".").length - 1;
        const deg = seq[hitIdx % seq.length];
        const n = deg === 3 ? root + 12 : root + (c.tones[deg] ?? 0);
        voice(part.inst, n, t, stepDur * 1.5, vol * (ch === "X" ? 1.25 : 1), false, dest);
      }
    });
  }

  function tick() {
    const track = TRACKS[playing];
    const beatDur = 60 / track.bpm;
    const stepDur = beatDur / track.beat;
    while (nextAt < ctx.currentTime + 0.15) {
      const swing = track.swing && step % 2 === 1 ? stepDur * track.swing : 0;
      scheduleStep(track, step, nextAt + swing, stepDur);
      nextAt += stepDur;
      step++;
    }
  }

  /** Beds: a constant layer under a track (vinyl crackle, waves). */
  function startBeds(track) {
    for (const part of track.parts) {
      if (part.drum !== "vinyl" && part.drum !== "waves") continue;
      const s = ctx.createBufferSource(), f = filt(part.drum === "vinyl" ? "highpass" : "lowpass", part.drum === "vinyl" ? 3000 : 500), g = ctx.createGain();
      s.buffer = noiseBuf; s.loop = true; g.gain.value = part.drum === "vinyl" ? 0.015 : 0.05;
      if (part.drum === "waves") {
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.12; lg.gain.value = 0.04;
        lfo.connect(lg).connect(g.gain); lfo.start(); beds.push(lfo);
      }
      s.connect(f).connect(g).connect(out); s.start(); beds.push(s);
    }
  }

  /** Play a track (stopping the last). With `fadeOut` (seconds) and a track
   *  already playing, that one fades out first and the new one starts after. */
  function play(id, { fadeOut = 0 } = {}) {
    clearTimeout(switchTimer); switchTimer = null;
    if (fadeOut > 0 && playing && out && TRACKS[id]) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + fadeOut);
      switchTimer = setTimeout(() => { switchTimer = null; start(id); }, fadeOut * 1000);
      return true;
    }
    return start(id);
  }

  function start(id) {
    stop();
    if (!TRACKS[id] || !setup()) return false;
    playing = id;
    const track = TRACKS[id];
    tunes = track.parts.map((p) => (p.melody ? compose(track, p) : null));
    step = 0;
    nextAt = ctx.currentTime + 0.1;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(0.0001, ctx.currentTime);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume()), ctx.currentTime + 1.5);
    reverbFor(track);
    for (const p of track.parts) if (p.layer) layerNode(p.layer);
    startBeds(track);
    timer = setInterval(tick, 25);
    tick();
    return true;
  }

  function stop() {
    clearTimeout(switchTimer); switchTimer = null;
    clearInterval(timer); timer = null;
    beds.forEach((b) => { try { b.stop(); } catch { /* already */ } });
    beds = [];
    // The last track's layers: let their tails ring, then let go of them.
    const old = Object.values(layerNodes);
    layerNodes = {};
    if (old.length) setTimeout(() => old.forEach((L) => { L.gain.disconnect(); L.echo.disconnect(); }), 9000);
    playing = null;
  }

  function volume() { const v = parseFloat(store.get("rx-music-vol")); return Number.isFinite(v) ? v : 0.35; }
  function setVolume(v) {
    store.set("rx-music-vol", String(v));
    // Mid-switch the outgoing track keeps fading; start() brings the next one in at the new volume.
    if (out && !switchTimer) out.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.1);
    if (sting) sting.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.1);
  }

  // ---- Scoring helpers: stingers, the clock, the lowpass ---------------------------

  /** Named stingers a game registers, for stinger("name"). */
  const STINGERS = {};

  /**
   * A short phrase in the playing track's key and scale (D dorian when
   * nothing plays): `degrees` are scale steps from the key note (7 = the
   * octave in a seven-note scale; negatives go below), `step` seconds apart
   * (0 = a chord), at octave `oct`. It lands on the track's next beat
   * (`quantize`: "beat", "bar", "step" or "none"; or an exact ctx time in
   * `at`). Plays beside the band, so its fades don't touch it.
   * Returns the start time (ctx seconds), or null.
   */
  function stinger(spec) {
    if (typeof spec === "string") spec = STINGERS[spec];
    if (!spec?.inst || !Array.isArray(spec.degrees) || !setup()) return null;
    const track = playing ? TRACKS[playing] : null;
    const keyPc = chord(track?.key || "D").root, scale = SCALES[track?.scale] || SCALES.dorian;
    const q = spec.quantize || "beat";
    let t0 = ctx.currentTime + 0.02;
    if (Number.isFinite(spec.at)) t0 = Math.max(ctx.currentTime, spec.at);
    else if (track && q !== "none") t0 = Math.max(t0, boundary(q));
    const base = 12 * ((spec.oct ?? 5) + 1) + keyPc, step = spec.step ?? 0.1, dest = stingOut();
    spec.degrees.forEach((d, i) => {
      const n = scale.length, o = Math.floor(d / n), m = base + 12 * o + scale[((d % n) + n) % n];
      voice(spec.inst, m, t0 + i * step, spec.dur ?? Math.max(0.4, step * 1.5), spec.vol ?? 1, false, dest);
    });
    return t0;
  }

  /** Where the band is: tempo, metre, the step now sounding, the next step's
   *  index (`nextStep`) and time, the key and the chord under it. With
   *  nothing playing: D dorian. */
  function clock() {
    const now = ctx ? ctx.currentTime : 0;
    if (!playing) {
      return { playing: null, bpm: 0, beat: 0, steps: 0, stepDur: 0, step: 0, nextStep: 0, bar: 0, nextAt: now, now,
        key: "D", scale: "dorian", chord: { ...chord("Dm7"), name: "Dm7" } };
    }
    const track = TRACKS[playing], stepDur = 60 / track.bpm / track.beat;
    const cur = Math.max(0, step - Math.ceil((nextAt - now) / stepDur));
    const bar = Math.floor(cur / track.steps) % track.chords.length;
    return { playing, bpm: track.bpm, beat: track.beat, steps: track.steps, stepDur, step: cur, nextStep: step, bar, nextAt, now,
      key: track.key, scale: track.scale, chord: { ...chord(track.chords[bar]), name: track.chords[bar] } };
  }

  /** Duck the music under a voice line, then bring it back. */
  function duck(seconds = 2.5) {
    // Mid-switch the outgoing track is fading out: ducking would cancel the fade.
    if (!out || !playing || switchTimer) return;
    const t = ctx.currentTime, v = volume();
    out.gain.cancelScheduledValues(t);
    out.gain.setTargetAtTime(v * 0.35, t, 0.08);
    out.gain.setTargetAtTime(v, t + seconds, 0.4);
  }

  window.RexGame = Object.assign(window.RexGame || {}, {
    music: { TRACKS, play, stop, playing: () => playing, volume, setVolume, duck,
      layers, stinger, STINGERS, clock },
  });
})();
