// The raid's mixing desk (v3 §D15): Master, Music, Effects and Voices, each
// 0..1, kept per browser (localStorage "rx-rexmaw-raids-mix", every access
// wrapped: a private window just keeps the defaults). Settings and the pause
// menu (ui/settings.js) move the faders; everything that makes a sound reads
// them here, so main has nothing to wire:
//
//   Music    v4: this fader IS the kit's music volume (RexGame.music.volume /
//            setVolume, the ⚙ menu's "Volume" slider, kit-wide "rx-music-vol"):
//            fader 1.0 = band volume MUSIC_FULL. A move on either side moves the
//            other (setVolume is tapped once to tell the listeners). Master is
//            applied by score.js on the recorded score's level, so it never
//            leaks into the kit-wide value. Without the kit it's our own fader.
//   Effects  sfx.js and ambience.js multiply their own output bus by
//            mix.level("effects") (they subscribe with mix.on()). v4: this
//            fader IS the kit's Effects volume (RexGame.sfxVolume, the ⚙
//            menu's slider, shared by every game): get/set go through it and
//            a move on either side reaches every listener here. Without the
//            kit it is a fader of our own, as before.
//   Voices   the kit's one voice channel, RexGame.voice.play(url, {volume}):
//            the crew's recorded barks (lib/crew.js) and the companion's
//            recorded lines both go through it. The call is wrapped once
//            (whoever else wraps it, avatar/crew.js's lip-sync tap included,
//            still calls through), and a line that is already playing follows
//            a fader move live. A companion speaking LIVE on a call plays in
//            the Rexclaw app, not on this page: the Voices fader can't reach it.
//
// Defaults are the v2 loudness: Music 70 % = the kit's 0.35 band volume.

const KEY = "rx-rexmaw-raids-mix";
const KIT_MUSIC_KEY = "rx-music-vol";
const Kit = () => globalThis.RexGame || null;

/** The faders, in the order Settings shows them. */
export const CHANNELS = Object.freeze([
  { id: "master", label: "Master" },
  { id: "music", label: "Music" },
  { id: "effects", label: "Effects" },
  { id: "voices", label: "Voices", hint: "the crew's barks and your companion's recorded lines" },
]);
const DEFAULTS = Object.freeze({ master: 1, music: 0.7, effects: 1, voices: 1 });
/** Music fader 1.0 = this band volume (0.7 × 0.5 = the kit's default 0.35). */
const MUSIC_FULL = 0.5;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v)));
function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { raw = null; }
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(Number(raw[k])) && raw[k] !== null) out[k] = clamp01(raw[k]);
  return out;
}
function persist(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: this session only */ } }

let levels = load();
const subs = new Set();
const playing = new Set();   // voice <audio> elements now sounding: {a, base}

/** The kit's shared Effects volume (lib/neuro.js), when the kit loaded. */
const kitFx = () => { const v = Kit()?.sfxVolume; return v && typeof v.get === "function" && typeof v.set === "function" ? v : null; };
function notify() { for (const fn of subs) { try { fn(mix.all()); } catch { /* a listener's problem */ } } }
let fxHooked = false;
/** Follow the kit's Effects volume (once): a move in the ⚙ menu reaches sfx/ambience and the Settings fader. */
function hookFx() {
  const K = kitFx();
  if (!K || fxHooked) return !!K;
  fxHooked = true;
  // v3 kept Effects in our own save: carry a non-default one over once, if the kit has none stored yet.
  let kitStored = null;
  try { kitStored = localStorage.getItem("rx-games-sfx-vol"); } catch { kitStored = "?"; }
  if (kitStored == null && levels.effects !== DEFAULTS.effects) K.set(levels.effects);
  K.on?.(() => notify());
  return true;
}

/** The kit's band, when it has a volume to share. */
const kitBand = () => { const b = Kit()?.music; return b && typeof b.volume === "function" && typeof b.setVolume === "function" ? b : null; };
let musicHooked = false;
/** Follow the kit's music volume (once): a move of the ⚙ menu's slider reaches the Settings fader and score.js. */
function hookMusic() {
  const band = kitBand();
  if (!band || musicHooked) return !!band;
  musicHooked = true;
  // v3 kept Music in our own save: carry a non-default one over once, if the kit has none stored yet.
  let kitStored = null;
  try { kitStored = localStorage.getItem(KIT_MUSIC_KEY); } catch { kitStored = "?"; }
  if (kitStored == null && levels.music !== DEFAULTS.music) { try { band.setVolume(levels.music * MUSIC_FULL); } catch { /* no band */ } }
  const inner = band.setVolume;
  band.setVolume = function (v) { const r = inner.call(this, v); notify(); return r; };
  return true;
}

/** Kept for callers: the band holds the Music level itself now (Master rides score.js's level). */
function applyMusic() { hookMusic(); }

function voiceGain() { return levels.master * levels.voices; }

function applyVoices() {
  const g = voiceGain();
  for (const v of playing) { try { v.a.volume = Math.max(0, Math.min(1, v.base * g)); } catch { /* gone */ } }
}

/** Wrap RexGame.voice.play once: the Voices fader scales each line's own volume. */
function tapVoice() {
  const voice = Kit()?.voice;
  if (!voice?.play) return false;
  if (voice.play.__nrMix) return true;
  const inner = voice.play;
  const wrapped = function (url, opts = {}) {
    const base = Number.isFinite(Number(opts?.volume)) ? Number(opts.volume) : 1;
    const onStart = opts?.onStart;
    return inner.call(this, url, {
      ...opts,
      volume: Math.max(0, Math.min(1, base * voiceGain())),
      onStart: (a) => {
        if (a) {
          const rec = { a, base };
          playing.add(rec);
          const done = () => playing.delete(rec);
          a.addEventListener?.("ended", done, { once: true });
          a.addEventListener?.("error", done, { once: true });
          a.addEventListener?.("pause", done, { once: true });
        }
        onStart?.(a);
      },
    });
  };
  wrapped.__nrMix = true;
  voice.play = wrapped;
  return true;
}

export const mix = {
  /** The fader's own value (0..1); Effects is the kit's shared one when the kit is here. */
  get(id) {
    if (id === "effects") { const K = kitFx(); if (K) { const v = Number(K.get()); if (Number.isFinite(v)) return clamp01(v); } }
    if (id === "music") { const b = kitBand(); if (b) { const v = Number(b.volume()); if (Number.isFinite(v)) return clamp01(v / MUSIC_FULL); } }
    return levels[id] ?? DEFAULTS[id] ?? 1;
  },
  /** All four faders. */
  all: () => ({ ...levels, effects: mix.get("effects"), music: mix.get("music") }),
  /** The gain a channel plays at: its fader × Master (Master's own is itself). */
  level(id) { return id === "master" ? levels.master : levels.master * mix.get(id); },
  /** Move faders: set({music: 0.4}). Saved at once; every listener hears it. */
  set(patch = {}) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) || !Number.isFinite(Number(v))) continue;
      const n = clamp01(v);
      if (k === "effects" && hookFx()) {
        // The kit stores it and calls us back (notify) for every game's listeners.
        if (n !== mix.get("effects")) kitFx().set(n);
        continue;
      }
      if (k === "music" && hookMusic()) {
        // The kit stores it (kit-wide, like the ⚙ slider) and the tap tells every listener.
        if (n !== mix.get("music")) kitBand().setVolume(n * MUSIC_FULL);
        continue;
      }
      if (n !== levels[k]) { levels[k] = n; changed = true; }
    }
    if (!changed) return mix.all();
    persist(levels);
    applyMusic();
    applyVoices();
    notify();
    return mix.all();
  },
  reset() {
    levels = { ...DEFAULTS }; persist(levels);
    if (hookFx()) kitFx().set(DEFAULTS.effects);
    if (hookMusic()) kitBand().setVolume(DEFAULTS.music * MUSIC_FULL);
    applyVoices(); notify();
  },
  /** Hear fader moves: fn(levels) → off(). */
  on(fn) { subs.add(fn); return () => subs.delete(fn); },
  /** Put the band at the raid's music level now (the band may have started after the page loaded). */
  applyMusic,
  DEFAULTS,
};

// Hook up at load (the kit's scripts load before the game's modules) and again
// once the page is interactive, in case the kit arrived late.
tapVoice();
hookFx();
hookMusic();
if (!Kit()?.voice?.play || !fxHooked || !musicHooked) {
  let tries = 0;
  const poll = () => { const v = tapVoice(), f = hookFx(), m = hookMusic(); if ((v && f && m) || ++tries > 40) return; setTimeout(poll, 500); };
  setTimeout(poll, 500);
}
