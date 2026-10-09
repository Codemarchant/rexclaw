// Night Raid (from Night Helm): quality tiers, the auto-probe and the in-play frame guard
// (from Starboard's quality.js).
//
// Four tiers, one table. Every scene module reads `R.quality` when it builds
// and subscribes `R.onQuality(fn)` to switch live, without a reload: star and
// plankton counts are draw ranges over buffers built once at Ultra size, the
// water swaps between its two pre-built surfaces, the post chain rebuilds its
// targets, the wake trims its ribbon. Nothing here touches the scene itself;
// renderer.js applies a tier.
//
// Auto: after the title is up and 0.5 s of warm-up, measure 2 s at High.
// p90 below 14 ms gives High, 14–22 ms Medium, above that Low; auto never
// picks Ultra. The frame time measured is the GPU's own (a timer query) when
// the browser offers one, else the frame interval, read with the display's
// refresh in mind. The result persists (with the GPU it was measured on) in
// localStorage["rx-nightraid-quality"].
//
// Frame guard, in play: if the 4 s average frame is above 30 ms, lower the
// DPR by 0.25 (not below 0.75), then step the tier down. It only leaves a
// line for the Settings panel (`note`), never a toast.

/** @typedef {"low"|"medium"|"high"|"ultra"} Tier */

/**
 * One tier's settings, as every module reads them from `R.quality`.
 * @typedef {object} Quality
 * @property {Tier} tier
 * @property {number} dprCap           device-pixel-ratio ceiling
 * @property {number} msaa             samples on the HDR scene target (0 = off)
 * @property {boolean} smaa            SMAA as the last pass (Low, where MSAA is off)
 * @property {number} bloomScale       bloom resolution as a fraction of the screen
 * @property {"analytic"|"reflector"} water
 * @property {number} reflect          reflection target size as a fraction of the screen
 * @property {{moon: number, lantern: number}} shadows   shadow map sizes (0 = off)
 * @property {number} stars            background stars drawn
 * @property {number} plankton         plankton motes drawn
 * @property {boolean} dof             depth of field in cinematics
 * @property {boolean} beam            the lighthouse beam
 * @property {number} wake             wake ribbon samples drawn (of 256)
 * @property {boolean} hullFoam        the foam along the hull and the bow wave
 * @property {[number, number]} krakenSegments   tube [tubular, radial] segments
 * @property {number} rain             rain streaks drawn in a storm (of MAX_COUNTS.rain)
 * @property {number} mist             maelstrom mist and spout spray motes drawn (of MAX_COUNTS.mist)
 * @property {number} shipLights       pooled lantern lights handed to the nearest enemy ships (0..3)
 * @property {number} smoke            gun smoke: puffs per muzzle (1 = as designed)
 */

/** The four tiers. Frozen: modules read them, never write. @type {Record<Tier, Quality>} */
export const TIERS = Object.freeze({
  low: Object.freeze({ tier: "low", dprCap: 1.0, msaa: 0, smaa: true, bloomScale: 0.25, water: "analytic", reflect: 0,
    shadows: Object.freeze({ moon: 0, lantern: 0 }), stars: 2500, plankton: 3000, dof: false, beam: false,
    wake: 96, hullFoam: false, krakenSegments: Object.freeze([56, 8]), rain: 2500, mist: 1500, shipLights: 0, smoke: 0.5 }),
  medium: Object.freeze({ tier: "medium", dprCap: 1.25, msaa: 4, smaa: false, bloomScale: 0.5, water: "reflector", reflect: 0.35,
    shadows: Object.freeze({ moon: 1024, lantern: 0 }), stars: 5000, plankton: 12000, dof: false, beam: true,
    wake: 160, hullFoam: true, krakenSegments: Object.freeze([90, 10]), rain: 6000, mist: 3000, shipLights: 2, smoke: 0.75 }),
  high: Object.freeze({ tier: "high", dprCap: 1.5, msaa: 4, smaa: false, bloomScale: 0.5, water: "reflector", reflect: 0.5,
    shadows: Object.freeze({ moon: 2048, lantern: 0 }), stars: 8000, plankton: 28000, dof: true, beam: true,
    wake: 220, hullFoam: true, krakenSegments: Object.freeze([120, 12]), rain: 10000, mist: 5000, shipLights: 3, smoke: 1 }),
  ultra: Object.freeze({ tier: "ultra", dprCap: 2.0, msaa: 4, smaa: false, bloomScale: 0.5, water: "reflector", reflect: 0.75,
    shadows: Object.freeze({ moon: 4096, lantern: 512 }), stars: 12000, plankton: 56000, dof: true, beam: true,
    wake: 256, hullFoam: true, krakenSegments: Object.freeze([160, 16]), rain: 16000, mist: 8000, shipLights: 3, smoke: 1 }),
});

/** Tier names, lowest first. */
export const TIER_ORDER = Object.freeze(["low", "medium", "high", "ultra"]);

/** The most any tier draws; buffers are built at this size and draw ranges pick a tier's share. */
export const MAX_COUNTS = Object.freeze({ stars: TIERS.ultra.stars, plankton: TIERS.ultra.plankton, wake: TIERS.ultra.wake, rain: TIERS.ultra.rain, mist: TIERS.ultra.mist });

const STORE_KEY = "rx-nightraid-quality";
const PROBE = { warmup: 500, measure: 2000, high: 14, medium: 22 };
const GUARD = { window: 4000, limit: 30, grace: 2500, dprStep: 0.25, dprFloor: 0.75 };

/**
 * The saved choice: `pref` is what the player picked ("auto" or a tier),
 * `auto` the last probe's answer and `gpu` the GPU it was measured on.
 * @returns {{pref: Tier|"auto", auto: Tier|null, gpu: string|null}}
 */
export function loadPref() {
  const out = { pref: "auto", auto: null, gpu: null };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return out;
    const v = JSON.parse(raw);
    if (v && (v.pref === "auto" || v.pref in TIERS)) out.pref = v.pref;
    if (v && v.auto in TIERS && v.auto !== "ultra") out.auto = v.auto;
    if (v && typeof v.gpu === "string") out.gpu = v.gpu;
  } catch { /* private mode or a mangled value: start from auto */ }
  return out;
}

/** Persist the choice (best effort). @param {{pref: string, auto: string|null, gpu: string|null}} v */
export function savePref(v) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ pref: v.pref, auto: v.auto, gpu: v.gpu })); } catch { /* not persisted */ }
}

/** A short name for the GPU, so a probe result is re-measured on a different machine. @param {WebGL2RenderingContext} gl */
export function gpuName(gl) {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "").slice(0, 120);
  } catch { return ""; }
}

/** The tier a probe's p90 frame time earns (never Ultra). @param {number} p90ms @returns {Tier} */
export function tierForFrameTime(p90ms) {
  return p90ms < PROBE.high ? "high" : p90ms <= PROBE.medium ? "medium" : "low";
}

/** The tier one step below (Low stays Low). @param {Tier} tier @returns {Tier} */
export function stepDown(tier) {
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(tier) - 1)];
}

/** The p-th percentile (0..1) of a list of numbers; 0 for an empty list. */
export function percentile(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * GPU frame timing through EXT_disjoint_timer_query_webgl2, when the browser
 * has it. One query per frame, read back a few frames later; disjoint frames
 * (a clock change on the GPU) are thrown away.
 * @param {WebGL2RenderingContext} gl
 */
export function createGpuTimer(gl) {
  let ext = null;
  try { ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"); } catch { ext = null; }
  const pending = [];
  const free = [];
  let open = null;
  let last = 0;
  return {
    /** Whether timings are coming in at all. */
    get available() { return !!ext; },
    /** The latest finished frame's GPU time, in ms (0 before the first). */
    get last() { return last; },
    begin() {
      if (!ext || open) return;
      const q = free.pop() || gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      open = q;
    },
    end() {
      if (!ext || !open) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    },
    /** Read back whatever is ready; calls `fn(ms)` for each finished frame. */
    poll(fn) {
      if (!ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length) {
        const q = pending[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        pending.shift();
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        free.push(q);
        if (!disjoint) { last = ns / 1e6; fn?.(last); }
      }
      if (pending.length > 8) free.push(...pending.splice(0, pending.length - 8));   // a stalled driver: drop the oldest
    },
    dispose() {
      for (const q of [...pending, ...free]) gl.deleteQuery(q);
      pending.length = 0; free.length = 0; open = null;
    },
  };
}

/**
 * The auto-probe: a 0.5 s warm-up, then 2 s of frames. Feed it every frame;
 * it calls `onDone(tier, stats)` once.
 * @param {{gpu: {available: boolean}, onDone: (tier: Tier, stats: object) => void}} opts
 */
export function createProbe({ gpu, onDone }) {
  const raf = [], cpu = [], gpuMs = [];
  let start = -1, done = false;
  return {
    get running() { return !done; },
    frame(now, rawMs, cpuMs) {
      if (done) return;
      if (start < 0) start = now;
      const t = now - start;
      if (t < PROBE.warmup) return;
      if (rawMs > 0 && rawMs < 250) { raf.push(rawMs); cpu.push(cpuMs); }
      if (t < PROBE.warmup + PROBE.measure) return;
      if (raf.length < 20) {                       // the tab was hidden or the page stalled: measure again
        start = now; raf.length = 0; cpu.length = 0; gpuMs.length = 0;
        return;
      }
      done = true;
      const stats = measure();
      onDone(tierForFrameTime(stats.p90), stats);
    },
    gpu(ms) { if (!done && start >= 0) gpuMs.push(ms); },
    cancel() { done = true; },
  };

  function measure() {
    const rafP90 = percentile(raf, 0.9), cpuP90 = percentile(cpu, 0.9);
    if (gpu.available && gpuMs.length >= 10) {
      return { p90: Math.max(percentile(gpuMs, 0.9), cpuP90), via: "gpu", rafP90, cpuP90, frames: raf.length };
    }
    const refresh = Math.min(17.5, percentile(raf, 0.1) || 16.7);
    const keepsUp = rafP90 <= refresh * 1.15;
    return { p90: keepsUp ? Math.min(rafP90, Math.max(cpuP90, 1)) : rafP90, via: keepsUp ? "cpu" : "raf", rafP90, cpuP90, refresh, frames: raf.length };
  }
}

/**
 * The in-play frame guard: 4 s windows of frame intervals. When a window's
 * average is above 30 ms it asks for less: first resolution, then a tier.
 * @param {{onLower: (step: "dpr"|"tier") => boolean}} opts  return false when nothing is left to lower
 */
export function createFrameGuard({ onLower }) {
  let sum = 0, n = 0, since = 0, quietUntil = 0;
  return {
    hush(now, ms = GUARD.grace) { quietUntil = Math.max(quietUntil, now + ms); sum = 0; n = 0; since = now; },
    frame(now, rawMs) {
      if (now < quietUntil) return;
      if (!(rawMs > 0) || rawMs > 250) { sum = 0; n = 0; since = now; return; }
      if (!n) since = now;
      sum += rawMs; n++;
      if (now - since < GUARD.window) return;
      const avg = sum / n;
      sum = 0; n = 0; since = now;
      if (avg <= GUARD.limit) return;
      if (!onLower("dpr")) onLower("tier");
      this.hush(now);
    },
  };
}

/** The guard's steps, for renderer.js. */
export const GUARD_STEPS = Object.freeze({ dprStep: GUARD.dprStep, dprFloor: GUARD.dprFloor });
