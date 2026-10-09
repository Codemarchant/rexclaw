// Night Raid (from Night Helm, from Starboard): the crew's body language, by tag.
// Night Helm's navigator set (brace, relief, cheer, arrive, resolve, calm,
// scan, nod, pointUp, walk, crouch) plus the raid's crew: a personality
// stance per member (`stance_rex` … `stance_ara`, upper-body loops over the
// idle), their fidgets (`fidget_rex` …), a flinch, a cheer for a sinking,
// flailing when swept overboard, and a relieved "made it" after a rescue.
// One engine per loaded VRM; the parsed clips are shared module-wide, the
// retargeted ones are per model.
//
// The VRM always runs a full-body idle. Everything else plays over it:
//
//   one-shot  play("celebrate")        a reaction; fades back out on its own
//   loop      setLoop("think")         a held state (thinking, listening)
//   idle      the agent's own idle VRMA, else a dlp3d full-body idle,
//             else nothing (the companion module poses the body procedurally)
//
// Clips come from two places, both already in the app with credits: the
// VRoid Motion Pack VRMA files in /assets/vrma, and the dlp3d library in
// /assets/motion/dlp3d-ani (its manifest tags each clip and says whether it
// is an upper-body or a full-body take). Every clip is retargeted onto this
// VRM with three-vrm-animation's humanoid tracks only: the clips' own
// expression and look-at tracks are dropped, because the face and the eyes
// belong to the companion module (expressions, blinks, lip-sync, look-at).
//
// Upper-body clips drop the hips and leg tracks. The idle is split in two
// matching halves (upper / lower), so an upper-body gesture replaces only the
// idle's upper half and the legs keep shifting their weight underneath it.
// A full-body clip replaces both halves. All blends are linear crossfades of
// 0.3 s; loops without an authored loop range crossfade into a fresh copy of
// themselves, so nothing pops at the wrap.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin, createVRMAnimationHumanoidTracks } from "@pixiv/three-vrm-animation";

/** Crossfade length for every clip change, in seconds. */
export const CROSSFADE = 0.3;
const LOOP_XF = 0.6;           // the self-crossfade of a loop without an authored range
const VRMA_DIR = "/assets/vrma/";
const LIB_DIR = "/assets/motion/dlp3d-ani/";
const LIB_FPS = 30;

const LOWER_BONES = new Set([
  "hips", "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
]);

const vrma = (file) => ({ kind: "vrma", url: VRMA_DIR + file, mask: "full" });
const lib = (query) => ({ kind: "lib", ...query });

/**
 * Where each tag's motion comes from, in order of preference. A `vrma`
 * source is one file; a `lib` source is a query on the dlp3d manifest
 * (any of `tags`, optionally a `mask`, only `random`-safe takes, only
 * clips with an authored `loop` range, or explicit `ids`), from which one
 * matching clip is picked at random, never the same one twice running.
 * `cap` limits how long a one-shot runs (long listening takes).
 */
export const TAG_SOURCES = Object.freeze({
  idle: [lib({ ids: ["dlp3d_721"] }), lib({ tags: ["idle"], mask: "full", exclude: ["energetic"] })],
  think: [vrma("Thinking.vrma"), lib({ tags: ["think"] })],
  thinkLoop: [lib({ tags: ["think"], loopable: true }), lib({ tags: ["think"], mask: "upper" }), vrma("Thinking.vrma")],
  listen: [lib({ tags: ["listen"], cap: 6 })],
  listenLoop: [lib({ tags: ["listen"], mask: "upper" })],
  point: [lib({ tags: ["point"] })],
  celebrate: [vrma("Clapping.vrma"), lib({ tags: ["celebrate"] })],
  jump: [vrma("Jump.vrma"), lib({ tags: ["jump"] })],
  surprised: [vrma("Surprised.vrma"), lib({ tags: ["surprised"], mask: "upper" })],
  sad: [vrma("Sad.vrma"), lib({ tags: ["sad"] })],
  shrug: [lib({ tags: ["shrug"] })],
  bow: [lib({ ids: ["dlp3d_571"] }), lib({ tags: ["bow"] })],
  wave: [vrma("Goodbye.vrma"), lib({ tags: ["wave"] })],
  greet: [vrma("VRMA_02_greeting.vrma"), lib({ tags: ["greet"] })],
  lookaround: [vrma("LookAround.vrma"), lib({ tags: ["look", "search"] })],
  // On a call: a short conversational beat while their words land (no mouth flaps).
  talk: [lib({ tags: ["nod", "agree", "question", "idea"], mask: "upper", exclude: ["peace"] })],
  // Now and then, at the helm: small idle-safe shifts (hand on hip, toe tap).
  fidget: [lib({ tags: ["idle_safe"], mask: "upper", random: true, cap: 9 })],
  // Night Helm's navigator.
  nod: [lib({ ids: ["dlp3d_597"] }), lib({ tags: ["nod", "agree"], mask: "upper", exclude: ["peace"] })],
  scan: [lib({ ids: ["dlp3d_590"] }), vrma("LookAround.vrma")],
  pointUp: [lib({ ids: ["dlp3d_582"] }), lib({ tags: ["point"] })],
  brace: [lib({ ids: ["dlp3d_660", "dlp3d_664"], cap: 2.4 }), vrma("Surprised.vrma"), lib({ tags: ["surprised"], mask: "upper" })],
  relief: [lib({ ids: ["dlp3d_584"] }), lib({ tags: ["relief", "calm"] })],
  cheer: [lib({ ids: ["dlp3d_631", "dlp3d_626"] }), lib({ tags: ["cheer", "praise"], mask: "upper" }), vrma("Clapping.vrma")],
  arrive: [lib({ ids: ["dlp3d_591"] }), vrma("Clapping.vrma"), lib({ tags: ["celebrate"] })],
  resolve: [lib({ ids: ["dlp3d_744"] }), lib({ tags: ["resolve", "cheer"] })],
  calm: [lib({ ids: ["dlp3d_729"], cap: 4 }), lib({ tags: ["calm"] })],
  scared: [lib({ ids: ["dlp3d_678"], cap: 3 }), vrma("Surprised.vrma")],
  // v2 crew work: a walk to the task spot (a loop, sped up to a jog), a crouch held at
  // its lowest (patching a hole), a shrug for a missed gate, a cheer for a medal.
  walk: [vrma("walking.vrma")],
  crouch: [vrma("VRMA_07_squat.vrma")],
  miss: [lib({ ids: ["dlp3d_696"], cap: 2.6 }), lib({ tags: ["shrug"] })],
  medal: [lib({ ids: ["dlp3d_591"] }), vrma("Jump.vrma"), lib({ tags: ["celebrate"] })],
  // Night Raid's crew. Personality stances (upper-body loops over the full-body idle):
  // Rex's mission-control arms-crossed, Eve's finger-to-chin toe tap over the charts, Ara's
  // hands gently clasped, Sal's watchful lean with a hand at the small of the back, Leo's
  // composed hands-behind-the-back watch. The first mate (a companion who isn't one of the
  // five) gets a plain one-hand-on-hip stance.
  stance_rex: [lib({ ids: ["dlp3d_704"] }), lib({ ids: ["dlp3d_561"] })],
  stance_eve: [lib({ ids: ["dlp3d_709"] }), lib({ ids: ["dlp3d_549"] })],
  stance_ara: [lib({ ids: ["dlp3d_625"] }), lib({ ids: ["dlp3d_567"] })],
  stance_sal: [lib({ ids: ["dlp3d_713"] }), lib({ ids: ["dlp3d_561"] })],
  stance_leo: [lib({ ids: ["dlp3d_560"] }), lib({ ids: ["dlp3d_567"] })],
  stance_me: [lib({ ids: ["dlp3d_701"] }), lib({ tags: ["idle_safe"], mask: "upper" })],
  // Their fidgets between jobs (one-shots, capped).
  fidget_rex: [lib({ ids: ["dlp3d_597", "dlp3d_617", "dlp3d_557"], cap: 4 })],
  fidget_eve: [lib({ ids: ["dlp3d_554", "dlp3d_732", "dlp3d_551", "dlp3d_705"], cap: 4 })],
  fidget_ara: [lib({ ids: ["dlp3d_729", "dlp3d_577", "dlp3d_616"], cap: 4 })],
  fidget_sal: [lib({ ids: ["dlp3d_600", "dlp3d_691", "dlp3d_590"], cap: 4 })],
  fidget_leo: [lib({ ids: ["dlp3d_597", "dlp3d_577", "dlp3d_745"], cap: 4 })],
  fidget_me: [lib({ tags: ["idle_safe"], mask: "upper", random: true, cap: 5 })],
  // A shot landing close: a quick shrink back.
  flinch: [lib({ ids: ["dlp3d_664", "dlp3d_660"], cap: 1.6 }), vrma("Surprised.vrma")],
  // A sinking, a capture, plunder banked.
  hurrah: [lib({ ids: ["dlp3d_631", "dlp3d_591", "dlp3d_626", "dlp3d_744"] }), vrma("Clapping.vrma")],
  // Swept over the side, and in the water.
  flail: [lib({ ids: ["dlp3d_678"], cap: 3 }), vrma("Surprised.vrma")],
  // Hauled back aboard.
  madeit: [lib({ ids: ["dlp3d_584", "dlp3d_729"] }), lib({ tags: ["relief"] })],
  // A first mate's order: a short point or a fist to the chest.
  order: [lib({ ids: ["dlp3d_617", "dlp3d_744", "dlp3d_597"], cap: 2.4 })],
});

// ---- Shared caches (module level: avatar-independent) ----------------------------

let manifestPromise = null;
const vrmaPromises = new Map();     // url → Promise<VRMAnimation|null>

/** The dlp3d manifest's clips, each with its `url`; [] when it can't be read. */
export function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(LIB_DIR + "manifest.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m) => (Array.isArray(m?.clips) ? m.clips : []).map((c) => ({
        ...c, url: LIB_DIR + c.file, fps: m.fps || LIB_FPS, mask: c.mask === "upper" ? "upper" : "full",
      })))
      .catch((error) => {
        console.debug("[night-raid] motions: dlp3d manifest unavailable", error);
        manifestPromise = null;    // allow a retry later
        return [];
      });
  }
  return manifestPromise;
}

/**
 * The dlp3d clips predate the VRMA `specVersion` field: three-vrm-animation
 * assumes 1.0 for them and warns in the console for every clip. This states
 * the version up front (what the loader assumes anyway), before it reads it.
 */
class VrmaSpecVersion {
  constructor(parser) { this.parser = parser; this.name = "nighthelm_vrma_spec_version"; }
  beforeRoot() {
    const ext = this.parser.json?.extensions?.VRMC_vrm_animation;
    if (ext && ext.specVersion == null) ext.specVersion = "1.0";
  }
}

/** Parsed VRMAnimation for a url (cached; null on failure, retried next time). */
function loadVrma(url) {
  let p = vrmaPromises.get(url);
  if (!p) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VrmaSpecVersion(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    p = loader.loadAsync(url)
      .then((gltf) => gltf.userData?.vrmAnimations?.[0] || null)
      .catch((error) => {
        vrmaPromises.delete(url);
        console.debug("[night-raid] motions: clip failed to load", url, error);
        return null;
      });
    vrmaPromises.set(url, p);
  }
  return p;
}

/** The largest rotation (radians) a quaternion track makes away from its first key. */
function trackTravel(track) {
  if (!track) return 0;
  const v = track.values;
  let best = 0;
  for (let i = 4; i < v.length; i += 4) {
    const d = Math.abs(v[0] * v[i] + v[1] * v[i + 1] + v[2] * v[i + 2] + v[3] * v[i + 3]);
    best = Math.max(best, 2 * Math.acos(Math.min(1, d)));
  }
  return best;
}

const approach = (v, target, rate, dt) => (v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt));

// ---- Slots: one clip playing on the mixer, with its own weight ------------------

/**
 * One clip in play. `w` is the slot's weight (crossfaded toward `target`);
 * a loop without an authored range keeps two actions and crossfades between
 * them at the wrap. A slot only ends after release(): a loop that a
 * one-shot pushed down to weight 0 is held, not finished.
 */
class Slot {
  constructor(mixer, clip, { mask, loop, start = 0, end = null, tag, kind, fadeIn = CROSSFADE, owned = false, rate = 1, holdEnd = false }) {
    this.mixer = mixer;
    this.clip = clip;
    this.owned = owned;              // a private copy: uncached when the slot ends
    this.mask = mask;                // "full" | "upper" | "lower"
    this.loop = loop;                // false | "repeat" | "xfade"
    this.start = start;
    this.end = Math.min(end ?? clip.duration, clip.duration);
    this.rate = rate > 0 ? rate : 1; // playback speed (a walk sped up to a jog)
    this.holdEnd = holdEnd;          // a one-shot that freezes on its last frame until released (a held crouch)
    this.tag = tag;
    this.kind = kind;                // "idle" | "loop" | "shot"
    this.w = fadeIn > 0 ? 0 : 1;
    this.target = 1;
    this.fade = Math.max(0.05, fadeIn);
    this.scale = 1;                  // idle halves: what the gestures leave them
    this.layers = [this.makeLayer(clip, 1)];
    this.cur = 0;
    this.releasing = false;
    this.cutShort = false;
    this.ended = false;
    this.onEnd = null;
  }

  makeLayer(clip, w) {
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(this.loop === "repeat" ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.time = this.start;
    action.timeScale = this.rate ?? 1;
    action.paused = false;
    action.setEffectiveWeight(0);
    action.play();
    return { clip, action, w, target: w };
  }

  /** Change the playback speed while it runs (a jog that slows to a walk). */
  setRate(rate) {
    this.rate = rate > 0 ? rate : 1;
    for (const l of this.layers) l.action.timeScale = this.rate;
  }

  /** Ease out over `seconds` and end. */
  release(seconds = CROSSFADE) {
    this.releasing = true;
    this.target = 0;
    this.fade = Math.max(0.05, seconds);
  }

  /** Push down to weight 0 (or back up to 1) without ending: a one-shot over a loop. */
  hold(on) {
    if (this.releasing) return;
    this.target = on ? 0 : 1;
    this.fade = CROSSFADE;
  }

  update(dt) {
    this.w = approach(this.w, this.target, 1 / this.fade, dt);
    const lead = this.layers[this.cur];
    if (this.loop === "xfade" && lead.target === 1 && lead.action.time >= this.end - LOOP_XF && !this.releasing) {
      // Start the other copy from the top and crossfade into it.
      let other = this.layers[1 - this.cur];
      if (!other) {
        const twin = this.clip.clone();
        twin.name = `${this.clip.name}~`;
        other = this.makeLayer(twin, 0);
        this.layers.push(other);
      } else {
        other.action.reset();
        other.action.time = this.start;
        other.action.play();
      }
      other.target = 1;
      lead.target = 0;
      this.cur = 1 - this.cur;
    }
    if (this.holdEnd && !this.releasing) {
      // Freeze on the last frame (the bottom of the crouch) until released.
      if (lead.action.time >= this.end) { lead.action.time = this.end; lead.action.paused = true; }
    } else if (!this.loop && !this.releasing && lead.action.time >= this.end - CROSSFADE) this.release(CROSSFADE);
    for (const l of this.layers) {
      l.w = approach(l.w, l.target, 1 / LOOP_XF, dt);
      l.action.setEffectiveWeight(this.w * l.w * this.scale);
    }
    if (this.releasing && this.w === 0) this.finish();
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    for (const l of this.layers) {
      try { l.action.stop(); } catch { /* the mixer may be gone */ }
      if (l.clip !== this.clip || this.owned) {
        try { this.mixer.uncacheAction(l.clip); this.mixer.uncacheClip(l.clip); } catch { /* */ }
      }
    }
    this.onEnd?.(!this.cutShort);
  }
}

// ---- The motion engine for one VRM ------------------------------------------------

/**
 * Body language for one loaded VRM.
 *
 * @param {{vrm: import("@pixiv/three-vrm").VRM, idleUrl?: string|null}} opts
 *   `idleUrl` is the agent's own idle VRMA (`agent.avatar.vrma_idle_url`).
 * @returns {{
 *   ready: Promise<boolean>,
 *   readonly hasIdle: boolean,
 *   readonly busy: boolean,
 *   readonly current: string|null,
 *   readonly drivesHips: boolean,
 *   play: (tag: string, opts?: {loop?: boolean, cut?: number, trimLeadIn?: boolean, side?: "left"|"right"|null,
 *          up?: boolean, fadeIn?: number}) => Promise<boolean>,
 *   setLoop: (tag: string|null) => Promise<boolean>,
 *   stop: (fade?: number) => void,
 *   has: (tag: string) => boolean,
 *   preload: (tags: string[]) => Promise<void>,
 *   update: (dt: number) => void,
 *   dispose: () => void,
 * }}
 *   `ready` resolves once the idle is running (true) or is known to be
 *   unavailable (false: the caller poses the body itself). `play` resolves
 *   true when the one-shot ran to its end, false when it couldn't play or
 *   was cut short; with `loop: true` it holds until the next play/stop and
 *   resolves when it starts. For `point`, `side` picks a clip that points
 *   with the arm on that side (the companion's own left or right) and `up`
 *   prefers the one that points up at the sky.
 */
export function createMotions({ vrm, idleUrl = null }) {
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const clipCache = new Map();         // `${url}|${part}` → AnimationClip
  const sideCache = new Map();         // url → "left" | "right"
  const lowCache = new Map();          // url → seconds at which the hips are lowest (the bottom of a squat)
  const lastPick = new Map();          // tag → url (variety)
  const missing = new Set();           // tags with no playable source
  let disposed = false;
  let idle = [];                       // the two idle halves (Slots)
  let loopSlot = null, loopTag = null;
  let shot = null, shotTag = null;
  let token = 0;                       // bumps on every play(), so a late load can tell it lost

  /** An AnimationClip for `url` limited to `part` ("full" | "upper" | "lower"). */
  async function clipFor(url, part) {
    const key = `${url}|${part}`;
    if (clipCache.has(key)) return clipCache.get(key);
    const anim = await loadVrma(url);
    if (!anim || disposed) return null;
    let clip = null;
    try {
      const { translation, rotation } = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, vrm.meta?.metaVersion);
      const keep = (bone) => (part === "full" ? true : part === "upper" ? !LOWER_BONES.has(bone) : LOWER_BONES.has(bone));
      const tracks = [];
      for (const [bone, track] of rotation) if (keep(bone)) tracks.push(track);
      for (const [bone, track] of translation) if (keep(bone)) tracks.push(track);
      if (!sideCache.has(url)) {
        const travel = (side) => trackTravel(rotation.get(`${side}UpperArm`)) + trackTravel(rotation.get(`${side}LowerArm`));
        sideCache.set(url, travel("left") >= travel("right") ? "left" : "right");
      }
      if (!lowCache.has(url)) {
        // The first time the hips reach their lowest (a squat's bottom), for a held crouch.
        const hips = translation.get("hips");
        let tLow = null;
        if (hips?.values?.length >= 6) {
          let minY = Infinity;
          for (let i = 0; i < hips.times.length; i++) {
            const y = hips.values[i * 3 + 1];
            if (y < minY - 1e-4) { minY = y; tLow = hips.times[i]; }
          }
        }
        lowCache.set(url, tLow);
      }
      if (tracks.length) clip = new THREE.AnimationClip(`${url.split("/").pop()}|${part}`, anim.duration, tracks);
    } catch (error) {
      console.debug("[night-raid] motions: retarget failed", url, error);
    }
    clipCache.set(key, clip);
    return clip;
  }

  /** Every manifest entry or file a source can resolve to (lib queries can match several). */
  async function candidates(source) {
    if (source.kind === "vrma") return [{ url: source.url, mask: "full", startup: 0, recovery: 0, loop: null, fps: LIB_FPS }];
    const clips = await loadManifest();
    return clips.filter((c) => {
      if (source.ids) return source.ids.includes(c.id);
      if (source.mask && c.mask !== source.mask) return false;
      if (source.random && !c.random) return false;
      if (source.loopable && !(Array.isArray(c.loop) && c.loop[1] - c.loop[0] > 1)) return false;
      if (source.exclude && c.tags?.some((t) => source.exclude.includes(t))) return false;
      return c.tags?.some((t) => source.tags.includes(t));
    }).map((c) => ({ ...c, cap: source.cap }));
  }

  /**
   * Pick a playable entry for `tag` and build its clip. Tries the sources in
   * order; within a lib query prefers variety, a matching `side` and `up`.
   */
  async function resolve(tag, { side = null, up = false, part = null } = {}) {
    const sources = TAG_SOURCES[tag];
    if (!sources) return null;
    for (const source of sources) {
      let list = await candidates(source);
      if (!list.length) continue;
      if (tag === "point" && list.length > 1) {
        // Know every take's arm before choosing (they're small and cached after).
        await Promise.all(list.map((e) => clipFor(e.url, e.mask)));
        const upTake = list.filter((e) => /\bup\b|sky/i.test(e.en || ""));
        const level = list.filter((e) => !upTake.includes(e));
        let pool = up && upTake.length ? upTake : level.length ? level : list;
        if (side) {
          const sided = pool.filter((e) => sideCache.get(e.url) === side);
          if (sided.length) pool = sided;
        }
        list = pool;
      }
      const last = lastPick.get(tag);
      const fresh = list.length > 1 ? list.filter((e) => e.url !== last) : list;
      const shuffled = [...fresh].sort(() => Math.random() - 0.5);
      for (const entry of shuffled) {
        const clip = await clipFor(entry.url, part || entry.mask);
        if (clip) {
          lastPick.set(tag, entry.url);
          return { entry, clip, mask: part || entry.mask };
        }
      }
    }
    return null;
  }

  // ---- The idle -------------------------------------------------------------------

  async function startIdle() {
    const fromAgent = async () => {
      if (!idleUrl) return null;
      const upper = await clipFor(idleUrl, "upper");
      const lower = await clipFor(idleUrl, "lower");
      return upper && lower ? { upper, lower, loop: "xfade", end: null } : null;
    };
    const fromLibrary = async () => {
      for (const source of TAG_SOURCES.idle) {
        for (const entry of await candidates(source)) {
          const upper = await clipFor(entry.url, "upper");
          const lower = await clipFor(entry.url, "lower");
          if (!upper || !lower) continue;
          const ranged = Array.isArray(entry.loop) && entry.loop[1] - entry.loop[0] > 1;
          if (ranged) {
            const sub = (c) => THREE.AnimationUtils.subclip(c, `${c.name}|loop`, Math.round(entry.loop[0] * entry.fps),
              Math.round(entry.loop[1] * entry.fps), entry.fps);
            return { upper: sub(upper), lower: sub(lower), loop: "repeat", end: null };
          }
          return { upper, lower, loop: "xfade", end: null };
        }
      }
      return null;
    };
    const parts = (await fromAgent()) || (await fromLibrary());
    if (!parts || disposed) return false;
    idle = [
      new Slot(mixer, parts.upper, { mask: "upper", loop: parts.loop, tag: "idle", kind: "idle", fadeIn: 0 }),
      new Slot(mixer, parts.lower, { mask: "lower", loop: parts.loop, tag: "idle", kind: "idle", fadeIn: 0 }),
    ];
    return true;
  }

  const ready = startIdle().catch((error) => {
    console.debug("[night-raid] motions: idle unavailable", error);
    return false;
  });

  // ---- Playing ----------------------------------------------------------------------

  // Every non-idle slot lives here from creation until it has faded out.
  const live = new Set();
  const inUse = new Set();             // clips some live slot is playing

  /** A slot on `clip`, or on a private copy when another live slot still has it. */
  function makeSlot(clip, opts) {
    let use = clip, owned = false;
    if (inUse.has(clip)) {
      use = clip.clone();
      use.name = `${clip.name}^${token}`;
      owned = true;
    }
    const slot = new Slot(mixer, use, { ...opts, owned: owned || !!opts.owned });
    inUse.add(use);
    const done = slot.onEnd;
    slot.onEnd = (natural) => { inUse.delete(use); live.delete(slot); done?.(natural); };
    live.add(slot);
    return slot;
  }

  /** The running one-shot gives way (to a newer one, or to stop()). */
  function dropShot(fade) {
    if (!shot) return;
    shot.cutShort = true;
    shot.release(fade);
    shot = null; shotTag = null;
    loopSlot?.hold(false);
  }

  async function play(tag, { loop = false, cut = null, trimLeadIn = false, side = null, up = false, fadeIn = CROSSFADE, rate = 1, hold = false, toLowest = false } = {}) {
    if (disposed) return false;
    if (loop) return setLoop(tag, { rate });
    const my = ++token;
    const got = await resolve(tag, { side, up });
    if (!got) { missing.add(tag); return false; }
    if (my !== token || disposed) return false;      // a newer play() won
    const { entry, clip, mask } = got;
    const duration = clip.duration;
    let start = 0;
    let end = duration;
    if (entry.recovery > 0.5 && entry.recovery < duration - 0.1) end = entry.recovery;
    if (entry.cap) end = Math.min(end, entry.cap);
    if (trimLeadIn && entry.startup > 0.05) start = Math.min(entry.startup, end - 0.6);
    if (cut && cut > 0.4) end = Math.min(end, start + cut);
    // A held crouch stops at the clip's lowest point (found from its hips track).
    if (toLowest) { const low = lowCache.get(entry.url); if (Number.isFinite(low) && low > start + 0.2) end = Math.min(end, low); }
    dropShot(CROSSFADE);
    loopSlot?.hold(true);
    return new Promise((resolveDone) => {
      const slot = makeSlot(clip, { mask, loop: false, start, end, tag, kind: "shot", fadeIn, rate, holdEnd: !!hold });
      const done = slot.onEnd;
      slot.onEnd = (natural) => { done(natural); resolveDone(natural); };
      shot = slot; shotTag = tag;
    });
  }

  /** Hold a looping state (thinking, listening, walking) under the one-shots; null lets it go. `rate` speeds it up. */
  async function setLoop(tag, { rate = 1 } = {}) {
    if (disposed) return false;
    if (tag === loopTag && loopSlot) { loopSlot.setRate(rate); return true; }
    const old = loopSlot;
    loopTag = tag;
    loopSlot = null;
    old?.release(CROSSFADE);
    if (!tag) return true;
    const key = TAG_SOURCES[`${tag}Loop`] ? `${tag}Loop` : tag;
    const got = await resolve(key);
    if (!got) { missing.add(tag); return false; }
    if (loopTag !== tag || disposed) return false;
    const { entry, clip, mask } = got;
    let use = clip, mode = "xfade";
    if (Array.isArray(entry.loop) && entry.loop[1] - entry.loop[0] > 1) {
      use = THREE.AnimationUtils.subclip(clip, `${clip.name}|loop`, Math.round(entry.loop[0] * entry.fps),
        Math.round(entry.loop[1] * entry.fps), entry.fps);
      mode = "repeat";
    }
    loopSlot = makeSlot(use, { mask, loop: mode, tag, kind: "loop", owned: use !== clip, rate });
    if (shot) loopSlot.hold(true);
    return true;
  }

  /** The playing loop's speed (no-op when `tag` isn't the loop). */
  function loopRate(tag, rate) {
    if (loopSlot && loopTag === tag) loopSlot.setRate(rate);
  }

  /** Let a held one-shot (a crouch) go: it fades back to the idle. */
  function releaseHold(fade = 0.45) {
    if (shot?.holdEnd) dropShot(fade);
  }

  /** Let every gesture and loop go back to the idle. */
  function stop(fade = CROSSFADE) {
    token++;
    dropShot(fade);
    if (loopSlot) { loopSlot.release(fade); loopSlot = null; loopTag = null; }
  }

  function update(dt) {
    if (disposed) return;
    dt = Math.max(0, Math.min(dt || 0, 0.1));
    // A one-shot that has begun its fade-out hands the body back to the loop now,
    // so the two crossfade instead of queueing.
    if (shot?.releasing) { shot = null; shotTag = null; loopSlot?.hold(false); }
    // What the gestures cover: the idle halves get what's left.
    let upperOcc = 0, lowerOcc = 0;
    for (const s of [...live]) {
      s.update(dt);
      if (s.ended) continue;
      upperOcc += s.w;
      if (s.mask === "full") lowerOcc += s.w;
    }
    for (const s of idle) {
      s.scale = Math.max(0, 1 - Math.min(1, s.mask === "upper" ? upperOcc : lowerOcc));
      s.update(dt);
    }
    mixer.update(dt);
  }

  return {
    ready,
    get hasIdle() { return idle.length > 0; },
    get busy() { return !!shot; },
    get current() { return shotTag || loopTag || (idle.length ? "idle" : null); },
    get drivesHips() { return idle.length > 0 || [...live].some((s) => s.mask === "full" && s.w > 0); },
    get loop() { return loopTag; },
    play,
    setLoop,
    loopRate,
    releaseHold,
    stop,
    has: (tag) => !!TAG_SOURCES[tag] && !missing.has(tag),
    async preload(tags) {
      await Promise.all(tags.map((t) => resolve(t).catch(() => null)));
    },
    update,
    dispose() {
      disposed = true;
      try { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); } catch { /* */ }
      clipCache.clear();
      live.clear();
      inUse.clear();
      idle = []; shot = null; loopSlot = null;
    },
  };
}
