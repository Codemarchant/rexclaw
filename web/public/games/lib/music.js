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

  let ctx = null, out = null, echo = null, noiseBuf = null;

  function setup() {
    ctx = window.RexGame.sfx?.context?.();
    if (!ctx || out) return !!ctx;
    out = ctx.createGain();
    out.gain.value = volume();
    const comp = ctx.createDynamicsCompressor();
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

  /** One note: instrument `inst`, midi `m`, at `t` for `dur` seconds. */
  function voice(inst, m, t, dur, vol = 1, toEcho = false) {
    const f = mtof(m), g = ctx.createGain();
    g.connect(out);
    if (toEcho) g.connect(echo);
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
      default: osc("triangle", f, t, end, g); env(g, t, 0.01, V(0.1), dur * 0.5, 0.2);
    }
  }

  function noise(t, dur, type, freq, vol, q = 1) {
    const s = ctx.createBufferSource(), f = filt(type, freq, q), g = ctx.createGain();
    s.buffer = noiseBuf; s.connect(f).connect(g).connect(out);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  function drum(kind, t, vol = 1, accent = false) {
    const a = accent ? 1.3 : 1, V = (x) => x * vol * a;
    switch (kind) {
      case "kick": case "softkick": case "stomp": { const g = ctx.createGain(); g.connect(out);
        const o = osc("sine", kind === "stomp" ? 110 : 150, t, t + 0.4, g);
        o.frequency.exponentialRampToValueAtTime(kind === "stomp" ? 55 : 45, t + 0.12);
        env(g, t, 0.002, V(kind === "softkick" ? 0.35 : 0.6), 0.02, 0.25);
        if (kind === "stomp") noise(t, 0.08, "lowpass", 800, V(0.25)); break; }
      case "snare": noise(t, 0.18, "bandpass", 2200, V(0.3), 0.8); voice("default", 55, t, 0.05, vol * 0.6); break;
      case "noisesnare": noise(t, 0.12, "highpass", 1500, V(0.22)); break;
      case "snareroll": noise(t, 0.06, "bandpass", 2500, V(0.15), 1); break;
      case "clap": [0, 0.012, 0.024].forEach((d) => noise(t + d, 0.09, "bandpass", 1600, V(0.2), 1.2)); break;
      case "hat": noise(t, 0.04, "highpass", 7000, V(0.12)); break;
      case "ride": noise(t, 0.3, "highpass", 5000, V(0.06)); voice("bell", 98, t, 0.05, vol * 0.25); break;
      case "brush": noise(t, 0.25, "bandpass", 3000, V(0.07), 0.4); break;
      case "shaker": noise(t, 0.05, "bandpass", 6500, V(0.06), 1.5); break;
      case "rim": noise(t, 0.03, "bandpass", 1800, V(0.25), 6); voice("default", 79, t, 0.02, vol * 0.4); break;
      case "tick": noise(t, 0.02, "bandpass", 3500, V(0.25), 8); break;
      case "tock": noise(t, 0.03, "bandpass", 1200, V(0.25), 8); break;
      case "tom": { const g = ctx.createGain(); g.connect(out); const o = osc("sine", 140, t, t + 0.5, g);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.3); env(g, t, 0.002, V(0.4), 0.02, 0.35); break; }
    }
  }

  // ---- The sequencer -------------------------------------------------------------

  let playing = null, timer = null, step = 0, nextAt = 0, tunes = null, beds = [];

  function scheduleStep(track, s, t, stepDur) {
    const bar = Math.floor(s / track.steps) % track.chords.length, pos = s % track.steps;
    const c = chord(track.chords[bar]);
    const key = chord(track.key).root;
    track.parts.forEach((part, pi) => {
      if (part.drum) {
        if (!part.rhythm) return;
        const ch = part.rhythm[pos % part.rhythm.length];
        if (ch !== ".") drum(part.drum, t, part.vol ?? 1, ch === "X");
        return;
      }
      const vol = part.vol ?? 1;
      if (part.melody) {
        const tune = tunes[pi], idx = tune.hits.indexOf(pos % part.melody.length);
        if (idx >= 0) {
          const n = tune.bars[bar][idx];
          const next = tune.hits[idx + 1] ?? track.steps;
          if (n != null) voice(part.inst, n, t, stepDur * (next - tune.hits[idx]) * 0.9, vol, !!part.echo);
        }
        return;
      }
      const ch = part.rhythm[pos % part.rhythm.length];
      if (ch === ".") return;
      const root = 12 * (part.oct + 1) + c.root + (c.root < key - 5 ? 12 : 0);
      const tones = c.tones.map((x) => root + x);
      if (part.chordHold || part.chordStab) {
        const len = part.chordHold ? stepDur * part.chordHold : stepDur * 1.6;
        tones.slice(0, 4).forEach((n) => voice(part.inst, n, t, len, vol * 0.8));
      } else if (part.arp) {
        const seq = part.arp === "updown" ? [...tones, ...tones.slice(1, -1).reverse()] : tones;
        voice(part.inst, seq[pos % seq.length] + (pos >= track.steps / 2 && part.arp === "up" ? 12 : 0), t, stepDur * 0.9, vol);
      } else if (part.walk) {
        // Walking bass: root, third, fifth, a chromatic step into the next chord.
        const nextC = chord(track.chords[(bar + 1) % track.chords.length]);
        const nextRoot = 12 * (part.oct + 1) + nextC.root;
        const beatIdx = Math.floor(pos / (track.steps / 4));
        const walk = [root, root + c.tones[1], root + c.tones[2], nextRoot + (nextRoot > root ? -1 : 1)];
        voice(part.inst, walk[beatIdx % 4], t, stepDur * 1.8, vol);
      } else {
        const seq = part.seq || [0];
        const hitIdx = [...part.rhythm.slice(0, pos + 1)].filter((x) => x !== ".").length - 1;
        const deg = seq[hitIdx % seq.length];
        const n = deg === 3 ? root + 12 : root + (c.tones[deg] ?? 0);
        voice(part.inst, n, t, stepDur * 1.5, vol * (ch === "X" ? 1.25 : 1));
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

  function play(id) {
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
    startBeds(track);
    timer = setInterval(tick, 25);
    tick();
    return true;
  }

  function stop() {
    clearInterval(timer); timer = null;
    beds.forEach((b) => { try { b.stop(); } catch { /* already */ } });
    beds = [];
    playing = null;
  }

  function volume() { const v = parseFloat(store.get("rx-music-vol")); return Number.isFinite(v) ? v : 0.35; }
  function setVolume(v) {
    store.set("rx-music-vol", String(v));
    if (out) out.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.1);
  }
  /** Duck the music under a voice line, then bring it back. */
  function duck(seconds = 2.5) {
    if (!out || !playing) return;
    const t = ctx.currentTime, v = volume();
    out.gain.cancelScheduledValues(t);
    out.gain.setTargetAtTime(v * 0.35, t, 0.08);
    out.gain.setTargetAtTime(v, t + seconds, 0.4);
  }

  window.RexGame = Object.assign(window.RexGame || {}, {
    music: { TRACKS, play, stop, playing: () => playing, volume, setVolume, duck },
  });
})();
