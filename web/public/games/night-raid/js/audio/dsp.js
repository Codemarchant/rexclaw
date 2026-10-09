// Night Raid's sound workshop (Night Helm's, from Starboard's): the small DSP
// kit sfx.js and ambience.js build their sounds with. Everything here is synthesised
// (no audio files): noise in three colours, reverb impulse responses grown
// from noise, an offline renderer, and a handful of graph helpers so a
// recipe reads like its description in the spec (§6).
//
// No three.js and no DOM; it needs only the Web Audio API.

/** The sample rate the effects are pre-rendered at: plenty for these sounds, a quarter of the memory. */
export const SR = 24000;

/**
 * The synthesised rooms: length in seconds and decay time constant τ.
 * @type {Readonly<Record<"sea"|"harbour"|"fog"|"cabin"|"deep", {seconds: number, tau: number}>>}
 */
export const ROOMS = Object.freeze({
  sea: { seconds: 1.8, tau: 0.32 },       // open water at night: nothing to bounce off but the swell
  harbour: { seconds: 2.6, tau: 0.55 },   // the harbour: the pier, the headland, the town's walls
  fog: { seconds: 2.2, tau: 0.6, from: 2600, to: 500 },   // fog swallows the highs and smears the tail
  cabin: { seconds: 0.7, tau: 0.18 },
  deep: { seconds: 3.5, tau: 0.8 },       // the Kraken's
  bay: { seconds: 3.2, tau: 0.7, from: 4000, to: 600 },   // the open bay at night: a far cannon rolls off the islands
});

/**
 * One reverb impulse response, as raw channels: decorrelated noise per
 * channel under `exp(−t/τ)`, through a one-pole lowpass whose cutoff falls
 * from `from` to `to` Hz across the tail (rooms darken as they ring out),
 * after a short predelay, with the last 40 ms faded so the tail never clicks.
 * @param {number} sampleRate
 * @param {{seconds: number, tau: number, predelay?: number, from?: number, to?: number, channels?: number}} room
 * @returns {Float32Array[]}
 */
export function impulseChannels(sampleRate, { seconds, tau, predelay = 0.018, from = 6000, to = 1200, channels = 2 }) {
  const pre = Math.round(predelay * sampleRate), n = pre + Math.ceil(seconds * sampleRate);
  const fadeFrom = n - Math.round(0.04 * sampleRate), ratio = to / from;
  const out = [];
  for (let ch = 0; ch < channels; ch++) {
    const d = new Float32Array(n);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const fc = from * ratio ** Math.min(1, t / seconds);
      y += (1 - Math.exp(-2 * Math.PI * fc / sampleRate)) * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp(-t / tau) * (i > fadeFrom ? (n - i) / (n - fadeFrom) : 1);
    }
    out.push(d);
  }
  return out;
}

/**
 * A reverb impulse response as an AudioBuffer for `ctx` (live or offline).
 * @param {BaseAudioContext} ctx
 * @param {"sea"|"harbour"|"fog"|"cabin"|"deep"|{seconds: number, tau: number}} room
 * @param {{predelay?: number}} [opts]
 * @returns {AudioBuffer}
 */
export function impulse(ctx, room, opts = {}) {
  const spec = typeof room === "string" ? ROOMS[room] : room;
  return toBuffer(ctx, impulseChannels(ctx.sampleRate, { ...spec, ...opts }));
}

/**
 * Noise in a colour: white (flat), pink (−3 dB/octave, Kellet's filter) or
 * brown (−6 dB/octave, leaky integration), scaled to about ±1 peak.
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @param {"white"|"pink"|"brown"} [color]
 * @returns {AudioBuffer}
 */
export function noiseBuffer(ctx, seconds, color = "white") {
  const n = Math.max(1, Math.ceil(seconds * ctx.sampleRate)), d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === "pink") {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else if (color === "brown") {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return toBuffer(ctx, [d]);
}

/**
 * Raw channels into an AudioBuffer (one buffer plays in any context).
 * @param {BaseAudioContext|null} ctx  supplies the default sample rate
 * @param {Float32Array[]} channels
 * @param {number} [sampleRate]
 * @returns {AudioBuffer}
 */
export function toBuffer(ctx, channels, sampleRate = ctx?.sampleRate ?? SR) {
  const buf = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
  channels.forEach((d, i) => buf.copyToChannel(d, i));
  return buf;
}

/**
 * Render a graph offline: `build(h, t0)` wires it up with the helpers in
 * `h` (see graph()) into `h.out`, starting at t0 = 0.
 * @param {number} seconds
 * @param {(h: ReturnType<typeof graph>) => void} build
 * @param {{channels?: number, sampleRate?: number}} [opts]
 * @returns {Promise<AudioBuffer>}
 */
export async function render(seconds, build, { channels = 1, sampleRate = SR } = {}) {
  const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!C) throw new Error("no OfflineAudioContext");
  const oc = new C(channels, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  build(graph(oc));
  return oc.startRendering();
}

/**
 * Graph helpers bound to one context. Each node helper connects to `dest`
 * when given and returns the node; sources start and stop themselves.
 * @param {BaseAudioContext} c
 */
export function graph(c) {
  const out = c.createGain();
  out.connect(c.destination);
  const noises = {};
  const noiseOf = (color) => (noises[color] ??= noiseBuffer(c, 4, color));
  const link = (node, dest) => { if (dest) node.connect(dest); return node; };
  const h = {
    c, out,
    /** A gain node at `v`. */
    gain: (v = 1, dest) => { const g = c.createGain(); g.gain.value = v; return link(g, dest); },
    /** A biquad filter. */
    filter: (type, freq, q = 0.7, dest) => {
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return link(f, dest);
    },
    /** A stereo panner (−1 left … 1 right); a plain gain where the context has none. */
    pan: (v, dest) => {
      if (!c.createStereoPanner) return h.gain(1, dest);
      const p = c.createStereoPanner(); p.pan.value = v; return link(p, dest);
    },
    /** An oscillator from t0 to t1. */
    osc: (type, freq, t0, t1, dest, detune = 0) => {
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
      link(o, dest); o.start(t0); o.stop(t1); return o;
    },
    /** Noise ("white", "pink", "brown") from t0 to t1, looped from a random offset. */
    noise: (color, t0, t1, dest, rate = 1) => {
      const s = c.createBufferSource(); s.buffer = noiseOf(color); s.loop = true; s.playbackRate.value = rate;
      link(s, dest); s.start(t0, Math.random() * 3); s.stop(t1); return s;
    },
    /** A delay line. */
    delay: (seconds, dest) => { const d = c.createDelay(Math.max(1, seconds + 0.1)); d.delayTime.value = seconds; return link(d, dest); },
    /** A convolver on one of the ROOMS (or a {seconds, tau} room). */
    room: (name, dest, opts) => { const v = c.createConvolver(); v.buffer = impulse(c, name, opts); return link(v, dest); },
    /** Attack to `peak` (linear), then an exponential decay with time constant `tau`. */
    strike(param, t, peak, attack, tau) {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + attack);
      param.setTargetAtTime(0, t + attack, tau);
    },
    /** Exponential attack / hold / release, from and to silence. */
    swell(param, t, attack, peak, hold, release) {
      param.setValueAtTime(0.0001, t);
      param.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + Math.max(0.001, attack));
      param.setValueAtTime(Math.max(0.0001, peak), t + attack + hold);
      param.exponentialRampToValueAtTime(0.0001, t + attack + hold + Math.max(0.001, release));
    },
    /**
     * Two-operator FM: a sine carrier at `f`, a sine modulator at f × ratio
     * whose index (peak deviation / modulator frequency) glides i0 → i1 over
     * `glide` seconds. Returns the carrier.
     */
    fm(f, ratio, i0, i1, glide, t0, t1, dest) {
      const car = h.osc("sine", f, t0, t1, dest), mod = h.osc("sine", f * ratio, t0, t1), depth = c.createGain();
      const fmHz = f * ratio;
      depth.gain.setValueAtTime(Math.max(0.0001, i0 * fmHz), t0);
      if (i1 > 0) depth.gain.exponentialRampToValueAtTime(i1 * fmHz, t0 + glide);
      else depth.gain.linearRampToValueAtTime(0, t0 + glide);
      mod.connect(depth).connect(car.frequency);
      return car;
    },
  };
  return h;
}

/** The loudest sample of a buffer (absolute). */
export function peak(buf) {
  let p = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}

/**
 * Tidy a rendered sound in place: scale its peak to `target`, fade the first
 * `fadeIn` and last `fadeOut` seconds (no clicks at either end).
 * @param {AudioBuffer} buf
 * @param {{target?: number, fadeIn?: number, fadeOut?: number}} [opts]
 * @returns {AudioBuffer}
 */
export function finish(buf, { target = 0.9, fadeIn = 0.002, fadeOut = 0.03 } = {}) {
  const p = peak(buf), k = p > 1e-6 ? target / p : 1;
  const fi = Math.round(fadeIn * buf.sampleRate), fo = Math.round(fadeOut * buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch), n = d.length;
    for (let i = 0; i < n; i++) {
      let g = k;
      if (i < fi) g *= i / fi;
      if (i > n - fo) g *= (n - i) / fo;
      d[i] *= g;
    }
  }
  return buf;
}

/**
 * Make a seamless loop from a render `loopSeconds + overlap` long: the
 * last `overlap` seconds are cross-faded (equal power) into the start, so
 * `source.loop = true` plays it with no seam and no click.
 * @param {AudioBuffer} buf
 * @param {number} loopSeconds
 * @returns {AudioBuffer}
 */
export function loopify(buf, loopSeconds) {
  const sr = buf.sampleRate, n = Math.round(loopSeconds * sr), x = Math.min(buf.length - n, Math.round(sr * 3));
  const chans = [];
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch), d = new Float32Array(n);
    d.set(src.subarray(0, n));
    for (let i = 0; i < x; i++) {
      const u = i / x;
      d[i] = src[i] * Math.sin(u * Math.PI / 2) + src[n + i] * Math.cos(u * Math.PI / 2);
    }
    chans.push(d);
  }
  return toBuffer(null, chans, sr);
}

/** Decibels to a gain factor. */
export const db = (v) => 10 ** (v / 20);
