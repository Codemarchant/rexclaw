// Night Raid (from Night Helm, from Starboard): lip-sync for recorded lines,
// one engine per mouth on deck (each crew member and the first mate).
//
// A recorded line arrives as an <audio> element that is already playing
// (kit RexGame.voice.play → onVoiceLine → main → crew.speak("me"), or a crew
// bark the crew module catches off the kit's voice channel). The
// first time we see an element we tap it once:
//
//   MediaElementSource ──▶ AnalyserNode (fftSize 1024) ──▶ destination
//
// and every frame turn what the analyser hears into mouth shapes. Loudness
// (RMS, in dB) opens the mouth through an envelope follower (attack 30 ms,
// release 90 ms, gain 1.8). The spectral centroid then leans the open mouth
// toward `ou` (dark, rounded vowels) or `ih` (bright, spread ones), with
// `aa` in between and a little `ee` / `oh` colour on the sides.
//
// Tapping an element reroutes its sound through the AudioContext, so it is
// only done when that is safe: the context must be running (a suspended one
// would silence the line) and the source must be same-origin (a cross-origin
// source without CORS reaches the analyser as silence, and the speakers too).
// Otherwise the mouth follows a synthetic syllable envelope for as long as
// the element plays, so a line never comes out of a still face.
//
// On a call there is no audio in this window; the companion module plays a
// talk gesture instead and never calls speak().

const FFT_SIZE = 1024;
const ATTACK_S = 0.03;
const RELEASE_S = 0.09;
const GAIN = 1.8;
const FLOOR_DB = -52;          // quieter than this is a closed mouth
const RANGE_DB = 36;           // FLOOR_DB + RANGE_DB is a fully open one (before GAIN)
const CENTROID_TAU = 0.06;     // seconds; vowel colour moves a touch slower than the jaw
const BAND_LO = 150, BAND_HI = 5000;   // Hz: the centroid only looks at the voice band

const tapped = new WeakMap();  // element → { source, analyser } (each element is wrapped once, released when it ends)

/** The kit's shared AudioContext, if the kit is there. */
function kitContext() {
  try { return window.RexGame?.sfx?.context?.() || null; } catch { return null; }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** True when routing this element through Web Audio keeps it audible. */
function canTap(el, ctx) {
  if (!ctx || ctx.state !== "running" || !el?.src) return false;
  if (tapped.has(el)) return true;
  try {
    const u = new URL(el.currentSrc || el.src, location.href);
    if (u.protocol === "blob:" || u.protocol === "data:") return true;
    return u.origin === location.origin || !!el.crossOrigin;
  } catch {
    return false;
  }
}

/**
 * The lip-sync engine for one mouth.
 *
 * @param {{context?: () => (AudioContext|null)}} [opts]
 *   `context` supplies the AudioContext (default: the kit's shared one).
 * @returns {{
 *   speak: (el: HTMLMediaElement) => {stop: () => void},
 *   update: (dt: number) => {open: number, aa: number, ih: number, ou: number, ee: number, oh: number, active: boolean},
 *   stop: () => void,
 *   readonly speaking: boolean,
 *   readonly level: number,
 *   dispose: () => void,
 * }}
 *   `update` is called once per frame and returns the viseme weights (0..1)
 *   to write into the VRM's expressions; `level` is the smoothed loudness,
 *   for things that only want a pulse (the paper standee).
 */
export function createLipSync({ context = kitContext } = {}) {
  let el = null;               // the element being followed
  let tap = null;              // its analyser, or null for the synthetic envelope
  let timeBuf = null, freqBuf = null;
  let env = 0;                 // the jaw: smoothed loudness 0..1
  let centroid = 1300;         // smoothed spectral centroid, Hz
  // Synthetic envelope state (no analyser).
  let synPhase = 0, synRate = 4.2, synAmp = 0.7, synBright = 1300;
  const out = { open: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, active: false };

  const playing = () => !!el && !el.paused && !el.ended && el.readyState >= 2;

  function wrap(target, ctx) {
    let t = tapped.get(target);
    if (!t) {
      const source = ctx.createMediaElementSource(target);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const tapNodes = { source, analyser, ctx };
      t = tapNodes;
      tapped.set(target, t);
      // Kit voice elements are one-shot: release the tap when the line is over,
      // so the shared context doesn't keep one analyser per line all night.
      const release = () => {
        try { source.disconnect(); analyser.disconnect(); } catch { /* already gone */ }
        tapped.delete(target);
        if (tap === tapNodes) tap = null;
      };
      target.addEventListener("ended", release, { once: true });
      target.addEventListener("error", release, { once: true });
    }
    return t;
  }

  /** Follow `target` (a playing <audio>) until it ends or another line starts. */
  function speak(target) {
    if (!target) return { stop() {} };
    el = target;
    tap = null;
    const ctx = context();
    if (canTap(target, ctx)) {
      try {
        tap = wrap(target, ctx);
        timeBuf = new Float32Array(tap.analyser.fftSize);
        freqBuf = new Float32Array(tap.analyser.frequencyBinCount);
      } catch (error) {
        // Already wrapped by someone else, or the context refused: use the envelope.
        console.debug("[night-raid] lipsync: analyser tap unavailable, using the syllable envelope", error);
        tap = null;
      }
    } else if (ctx && ctx.state === "suspended") {
      ctx.resume?.().catch(() => {});
    }
    synPhase = 0;
    const mine = target;
    return { stop: () => { if (el === mine) el = null; } };
  }

  function measure() {
    const a = tap.analyser;
    a.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sum / timeBuf.length);
    const db = 20 * Math.log10(rms + 1e-7);
    const loud = clamp01(clamp01((db - FLOOR_DB) / RANGE_DB) * GAIN);

    a.getFloatFrequencyData(freqBuf);
    const hz = tap.ctx.sampleRate / a.fftSize;
    const lo = Math.max(1, Math.floor(BAND_LO / hz)), hi = Math.min(freqBuf.length - 1, Math.ceil(BAND_HI / hz));
    let wsum = 0, msum = 0;
    for (let i = lo; i <= hi; i++) {
      const m = Math.pow(10, freqBuf[i] / 20);
      wsum += m * i * hz; msum += m;
    }
    return { loud, c: msum > 1e-9 ? wsum / msum : centroid };
  }

  function synthesise(dt) {
    // Syllables at ~4 Hz with a little jitter in rate, height and colour,
    // the rough shape of conversational speech.
    synPhase += dt * synRate * Math.PI * 2;
    if (synPhase > Math.PI * 2) {
      synPhase -= Math.PI * 2;
      synRate = 3.4 + Math.random() * 2.0;
      synAmp = Math.random() < 0.12 ? 0.15 : 0.5 + Math.random() * 0.45;
      synBright = 800 + Math.random() * 1600;
    }
    const s = Math.max(0, Math.sin(synPhase));
    return { loud: Math.pow(s, 0.7) * synAmp, c: synBright };
  }

  /** Advance one frame; returns the viseme weights. */
  function update(dt) {
    dt = Math.max(0, Math.min(dt || 0, 0.1));
    let loud = 0, c = centroid;
    const live = playing();
    if (live) {
      try {
        ({ loud, c } = tap ? measure() : synthesise(dt));
      } catch (error) {
        console.debug("[night-raid] lipsync: analyser read failed, switching to the envelope", error);
        tap = null;
      }
    } else if (el && (el.ended || el.error)) {
      el = null;
    }
    const tau = loud > env ? ATTACK_S : RELEASE_S;
    env += (loud - env) * (1 - Math.exp(-dt / tau));
    centroid += (c - centroid) * (1 - Math.exp(-dt / CENTROID_TAU));

    const bright = smoothstep(1250, 2600, centroid);
    const dark = 1 - smoothstep(650, 1250, centroid);
    const open = env < 0.02 ? 0 : env;
    out.open = open;
    out.aa = open * clamp01(1 - 0.65 * bright - 0.6 * dark);
    out.ih = open * bright * 0.8;
    out.ou = open * dark * 0.85;
    out.ee = out.ih * 0.3;
    out.oh = out.ou * 0.45 + open * 0.08;
    out.active = live || env > 0.02;
    return out;
  }

  return {
    speak,
    update,
    stop() { el = null; },
    get speaking() { return out.active; },
    get level() { return env; },
    dispose() { el = null; tap = null; },
  };
}
