// The raid's recorded music (v4 §5): six licensed tracks in assets/music/,
// played by an adaptive player on Web Audio. score.js decides WHAT should
// sound (from the raid's state, with its hysteresis); this file only plays it.
//
//   beds     day      "Pirate's Orchestra"   Dizzy Crow           CC0
//            night    "Fantasy: Rising Moon" RandomMind           CC0
//            combat   "Blackmoor Tides" (loop, no chants)  Matthew Pablo   CC-BY 3.0
//            boss     "Blackmoor Colossus" (Colossal Boss Battle Theme, loop)  Matthew Pablo  CC-BY 3.0
//   stings   victory  "Medieval: Victory Theme" (the opening fanfare)  RandomMind  CC0
//            defeat   "Greta Sting"          Kevin MacLeod        CC-BY 4.0
//   (sources, licences and attribution: assets/CREDITS.txt)
//
// Every bed is a seamless loop baked offline (day/night: a 2.5–3 s crossfade
// from the passage after the loop end into the loop start; combat/boss: the
// composer's own loop with a 10 ms wrap crossfade), so it loops natively,
// sample-accurately. Loudness: beds −16 LUFS, stings −14 LUFS, true peak
// ≤ −1 dBTP.
//
//   const p = createMusicPlayer();
//   await p.load()               // fetch the files (no AudioContext needed); false → use the synth band
//   p.want("day" | "night" | "combat" | "boss" | null, { fade })   // crossfade to that bed (null: silence)
//   p.sting("victory" | "defeat")                                  // over the bed, which dips under it
//   p.duck(seconds)              // dip under a voice line (−9 dB), then back
//   p.setLevel(gain)             // the music level (score.js follows the kit band's volume)
//   p.state()                    // what's loaded / playing, positions (tests, debug)
//
// A bed that fades out keeps its place: it is stopped when the fade is done
// and resumes from there the next time it is wanted (never from the top on a
// flip); a bed wanted back while still fading out just fades up again.
// Decoded beds cost memory (≈ 0.4 MB per second of stereo float): a bed not
// heard for EVICT_AFTER seconds is let go (its file bytes stay, so it decodes
// again in a moment), never the one playing.
//
//   bed sources ─▶ bed gain ─┐
//   sting source ─▶ sting ───┴▶ duck ─▶ level ─▶ speakers
//
// The AudioContext is the kit's (RexGame.sfx.context(), the one juice.js and
// the band use; null until the page's first gesture), else one of its own.

const Kit = () => globalThis.RexGame || null;

/** The files, relative to this module. */
const BASE = new URL("../../assets/music/", import.meta.url);
export const FILES = Object.freeze({
  day: { file: "day.ogg", loop: true, key: "A", scale: "minor" },
  night: { file: "night.ogg", loop: true, key: "G", scale: "minor" },
  combat: { file: "combat.ogg", loop: true, key: "C", scale: "major" },
  boss: { file: "boss.ogg", loop: true, key: "A", scale: "minor" },
  victory: { file: "victory.ogg", loop: false },
  defeat: { file: "defeat.ogg", loop: false },
});
export const BEDS = Object.freeze(["day", "night", "combat", "boss"]);
const STINGS = ["victory", "defeat"];

/** Seconds. */
export const FADES = Object.freeze({ in: 2.5, out: 4, light: 6, boss: 3, sting: 1.2 });
const DUCK = 0.35;            // the kit's own duck depth (lib/music.js duck(): ×0.35, about −9 dB)
const STING_DIP = 0.4;        // the bed under a victory / defeat sting
const EVICT_AFTER = 90;
const SILENT = 0.0001;

/**
 * @param {{ base?: URL|string, context?: () => (AudioContext|null), log?: (msg: string, data?: object) => void }} [opts]
 */
export function createMusicPlayer({ base = BASE, context = null, log = null } = {}) {
  const say = (msg, data) => { try { log?.(msg, data); } catch { /* the logger's problem */ } };
  const bytes = {};             // id → ArrayBuffer (kept: decoding consumes a copy)
  const buffers = {};           // id → AudioBuffer (decoded on demand)
  const decoding = {};          // id → Promise<AudioBuffer|null>
  const beds = {};              // id → { gain, src, startedAt, offset, pos, on, lastHeard, stopTimer }
  let ctx = null, out = null, duckG = null, bedBus = null, stingBus = null;
  let level = 0.5, want = null, wantFade = FADES.in, status = "idle", failed = null, disposed = false;
  let dipUntil = 0, evictTimer = 0, loading = null;
  const own = { ctx: null };

  // ---- Context and graph ----------------------------------------------------------------------

  function getCtx() {
    if (ctx && ctx.state !== "closed") return ctx;
    let c = null;
    try { c = context ? context() : Kit()?.sfx?.context?.() ?? null; } catch { c = null; }
    if (!c && !Kit()?.sfx?.context && !context) {
      // No kit (a bare test page): a context of our own.
      const C = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (C && !own.ctx) { try { own.ctx = new C(); } catch { own.ctx = null; } }
      c = own.ctx;
    }
    if (!c) return null;
    ctx = c;
    out = ctx.createGain(); out.gain.value = level;
    duckG = ctx.createGain(); duckG.gain.value = 1;
    bedBus = ctx.createGain(); bedBus.gain.value = 1;
    stingBus = ctx.createGain(); stingBus.gain.value = 1;
    bedBus.connect(duckG); stingBus.connect(duckG); duckG.connect(out); out.connect(ctx.destination);
    say("context", { sampleRate: ctx.sampleRate, state: ctx.state });
    return ctx;
  }

  /** Ramp an AudioParam from where it is now to `to` over `sec`, equal-power shaped. */
  function ramp(param, to, sec) {
    const now = ctx.currentTime, t = now + 0.01;   // the curve starts just after the held value (no overlap)
    const from = Math.max(SILENT, param.value);
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now); else { param.cancelScheduledValues(now); param.setValueAtTime(from, now); }
    if (!(sec > 0.02) || Math.abs(from - to) < 1e-4) { param.setValueAtTime(Math.max(SILENT, to), t); return; }
    const n = 64, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const k = to > from ? Math.sin(u * Math.PI / 2) : 1 - Math.cos(u * Math.PI / 2);   // rise fast, fall late: no hole mid-crossfade
      curve[i] = Math.max(SILENT, from + (to - from) * k);
    }
    try { param.setValueCurveAtTime(curve, t, sec); } catch { param.setTargetAtTime(Math.max(SILENT, to), t, sec / 3); }
  }

  // ---- Loading ---------------------------------------------------------------------------------

  /** Fetch every file's bytes. Resolves true when the beds are all there (stings are optional). */
  async function load() {
    if (status === "ready" || status === "loading") return status === "ready" || loading;
    status = "loading";
    loading = (async () => {
      const ids = Object.keys(FILES);
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch(new URL(FILES[id].file, base));
          if (!r.ok) throw new Error(`${r.status}`);
          bytes[id] = await r.arrayBuffer();
          return true;
        } catch (error) {
          say("fetch failed", { id, error: String(error?.message || error) });
          return false;
        }
      }));
      const bedsOk = ids.every((id, i) => results[i] || !BEDS.includes(id));
      if (!bedsOk) { status = "failed"; failed = "fetch"; return false; }
      // A probe decode on a throwaway offline context: a browser that can't play Ogg Vorbis says so now.
      const ok = await probe();
      status = ok ? "ready" : "failed";
      if (!ok) failed = "decode";
      say(ok ? "ready" : "decode failed", { bytes: Object.values(bytes).reduce((a, b) => a + b.byteLength, 0) });
      if (ok) apply();
      return ok;
    })();
    return loading;
  }

  async function probe() {
    const id = bytes.victory ? "victory" : "day";
    const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!C) return !!(globalThis.AudioContext || globalThis.webkitAudioContext);
    try {
      const off = new C(2, 1, 44100);
      const b = await off.decodeAudioData(bytes[id].slice(0));
      return b.duration > 0.5;
    } catch (error) {
      say("probe decode failed", { id, error: String(error?.message || error) });
      return false;
    }
  }

  /** The decoded buffer for `id` (decoded on the live context the first time it's wanted). */
  function decode(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    if (decoding[id]) return decoding[id];
    if (!bytes[id] || !getCtx()) return Promise.resolve(null);
    const t0 = performance.now();
    decoding[id] = ctx.decodeAudioData(bytes[id].slice(0)).then((b) => {
      buffers[id] = b;
      say("decoded", { id, seconds: Math.round(b.duration * 10) / 10, ms: Math.round(performance.now() - t0) });
      return b;
    }, (error) => {
      say("decode failed", { id, error: String(error?.message || error) });
      if (BEDS.includes(id)) { status = "failed"; failed = "decode"; }
      return null;
    }).finally(() => { delete decoding[id]; });
    return decoding[id];
  }

  // ---- Beds ------------------------------------------------------------------------------------

  function bed(id) {
    let B = beds[id];
    if (!B) {
      const g = ctx.createGain(); g.gain.value = SILENT; g.connect(bedBus);
      B = beds[id] = { id, gain: g, src: null, startedAt: 0, offset: 0, pos: 0, on: false, lastHeard: 0, stopTimer: 0, starting: false };
    }
    return B;
  }

  /** Where a bed is in its file now (seconds). */
  function position(B) {
    const buf = buffers[B.id];
    if (!B.src || !buf) return B.pos;
    const p = B.offset + (ctx.currentTime - B.startedAt);
    return buf.duration > 0 ? ((p % buf.duration) + buf.duration) % buf.duration : 0;
  }

  async function fadeIn(id, fade) {
    const B = bed(id);
    B.on = true;
    clearTimeout(B.stopTimer); B.stopTimer = 0;
    if (!B.src) {
      if (B.starting) return;
      B.starting = true;
      const buf = await decode(id);
      B.starting = false;
      if (!buf || disposed || !B.on || want !== id) return;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      src.connect(B.gain);
      B.offset = Math.min(B.pos, Math.max(0, buf.duration - 0.05));
      B.startedAt = ctx.currentTime + 0.02;
      src.start(B.startedAt, B.offset);
      B.src = src;
      say("start", { id, at: Math.round(B.offset * 100) / 100 });
    }
    ramp(B.gain.gain, 1, fade);
    say("fade in", { id, fade });
  }

  function fadeOut(id, fade) {
    const B = beds[id];
    if (!B || !B.on) return;
    B.on = false;
    ramp(B.gain.gain, SILENT, fade);
    say("fade out", { id, fade });
    clearTimeout(B.stopTimer);
    B.stopTimer = setTimeout(() => {
      B.stopTimer = 0;
      if (B.on || !B.src) return;
      B.pos = position(B);
      try { B.src.stop(); } catch { /* already */ }
      B.src.disconnect();
      B.src = null;
      B.lastHeard = performance.now();
      say("parked", { id, at: Math.round(B.pos * 100) / 100 });
    }, (fade + 0.15) * 1000);
  }

  /** Make the playing bed match `want`. */
  function apply() {
    if (disposed || status !== "ready" || !getCtx()) return;
    for (const id of Object.keys(beds)) if (id !== want && beds[id].on) fadeOut(id, wantFade.out);
    if (want) fadeIn(want, wantFade.in);
    scheduleEvict();
  }

  /**
   * Crossfade to a bed (or to silence with null).
   * @param {string|null} id
   * @param {{fade?: number, fadeIn?: number, fadeOut?: number}} [opts]  seconds
   */
  function setWant(id, { fade = null, fadeIn: fi = null, fadeOut: fo = null } = {}) {
    if (id !== null && !BEDS.includes(id)) return false;
    const changed = id !== want;
    want = id;
    wantFade = { in: fi ?? fade ?? FADES.in, out: fo ?? fade ?? FADES.out };
    if (changed) say("want", { id, fade: wantFade });
    if (changed || (id && !beds[id]?.on)) apply();
    return true;
  }

  function scheduleEvict() {
    clearTimeout(evictTimer);
    evictTimer = setTimeout(() => {
      const now = performance.now();
      for (const id of BEDS) {
        const B = beds[id];
        if (!buffers[id] || id === want || (B && (B.on || B.src))) continue;
        if (B && now - B.lastHeard < EVICT_AFTER * 1000) continue;
        delete buffers[id];
        say("evicted", { id });
      }
      if (Object.keys(buffers).some((id) => BEDS.includes(id) && id !== want)) scheduleEvict();
    }, (EVICT_AFTER + 1) * 1000);
  }

  // ---- Stings, ducking, level -------------------------------------------------------------------

  /** Play a victory / defeat sting over the bed (which dips under it). Resolves to its length, or 0. */
  async function sting(id) {
    if (!STINGS.includes(id) || status !== "ready" || !getCtx()) return 0;
    const buf = await decode(id);
    if (!buf || disposed) return 0;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(stingBus);
    const t = ctx.currentTime + 0.03;
    src.start(t);
    src.onended = () => { try { src.disconnect(); } catch { /* gone */ } };
    // The bed steps back for the sting and comes up again as it rings out.
    const p = bedBus.gain;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
    p.setTargetAtTime(STING_DIP, t, 0.15);
    p.setTargetAtTime(1, t + Math.max(0.5, buf.duration - FADES.sting), FADES.sting / 2);
    dipUntil = performance.now() + buf.duration * 1000;
    say("sting", { id, seconds: Math.round(buf.duration * 10) / 10 });
    return buf.duration;
  }

  /** Dip under a voice line for `seconds`, then come back (the kit's duck: −9 dB, 80 ms in, 0.4 s out). */
  function duck(seconds = 2.5) {
    if (!getCtx() || !duckG) return;
    const t = ctx.currentTime, s = Math.max(0.3, Number(seconds) || 2.5);
    const p = duckG.gain;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
    p.setTargetAtTime(DUCK, t, 0.08);
    p.setTargetAtTime(1, t + s, 0.4);
    say("duck", { seconds: Math.round(s * 10) / 10 });
  }

  function setLevel(v) {
    const n = Math.max(0, Math.min(1.5, Number(v)));
    if (!Number.isFinite(n)) return level;
    level = n;
    if (out) {
      out.gain.cancelScheduledValues(ctx.currentTime);
      out.gain.setTargetAtTime(Math.max(SILENT, level), ctx.currentTime, 0.1);
    }
    return level;
  }

  return {
    load,
    want: setWant,
    sting,
    duck,
    setLevel,
    /** Retry once the AudioContext exists (score calls this from its tick; cheap when nothing is pending). */
    poke() { if (status === "ready" && want && !beds[want]?.on && getCtx()) apply(); },
    /** Decode beds ahead of need, one after another (a contact closing in: the combat bed). */
    async prepare(ids = []) {
      if (status !== "ready" || !getCtx()) return;
      for (const id of ids) if (FILES[id] && !buffers[id]) await decode(id);
    },
    get status() { return status; },
    get failed() { return failed; },
    /** The key and scale of a bed (for the kit's stingers to sound in tune over it). */
    keyOf: (id) => (FILES[id]?.key ? { key: FILES[id].key, scale: FILES[id].scale } : null),
    state() {
      const now = ctx ? ctx.currentTime : 0;
      const b = {};
      for (const [id, B] of Object.entries(beds)) {
        b[id] = { on: B.on, playing: !!B.src, gain: Math.round(B.gain.gain.value * 1000) / 1000, pos: Math.round((B.src ? position(B) : B.pos) * 100) / 100 };
      }
      return { status, failed, want, level, beds: b, decoded: Object.keys(buffers), duck: duckG ? Math.round(duckG.gain.value * 1000) / 1000 : 1,
        dipping: performance.now() < dipUntil, time: Math.round(now * 100) / 100, context: ctx ? ctx.state : null };
    },
    dispose() {
      disposed = true;
      clearTimeout(evictTimer);
      for (const B of Object.values(beds)) {
        clearTimeout(B.stopTimer);
        try { B.src?.stop(); } catch { /* already */ }
        try { B.gain.disconnect(); } catch { /* gone */ }
      }
      try { out?.disconnect(); } catch { /* gone */ }
      if (own.ctx) { try { own.ctx.close(); } catch { /* fine */ } }
    },
  };
}
