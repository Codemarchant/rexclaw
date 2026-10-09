// Night Raid (from Night Helm): the renderer and the render context R (from Starboard's renderer.js).
//
// createRenderer(ctx) builds everything the 3D night stands on and hands it
// over as R: the WebGL2 renderer, the scene and its ship space (the group the
// Rexmaw, the companion and the camera ride in; world.js sails it), the post
// chain (R.post), the camera rig (R.cam), the label layer, the audio
// listener, the quality tiers and the frame loop. Every scene, avatar and
// audio module takes R and builds on it; none of them makes its own loop.
//
//   R.onFrame(fn, order)   fn(dt, t, rawDt): dt is hit-stop scaled (animate with it),
//                          rawDt is real time (audio, input, the sim). Lower order runs first.
//   R.onQuality(fn)        fn(quality) on every tier change: switch live, no reload.
//   R.onResize(fn)         fn(size) when the canvas or its pixel ratio changes.
//
// Layers: WORLD 0, SKY 1, AVATAR 2, NOREFLECT 3, FX 4 (blocking.js). The
// main camera sees them all; the water's reflection sees WORLD, SKY and FX.
//
// Fog: FogExp2, driven by visibility in metres (`R.setVisibility`, the sim's
// `visibility`), density = FOG_K / visibility, easing over about a second.

import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { LAYERS } from "./blocking.js";
import { createPost } from "./post.js";
import { createCameraRig } from "./camera.js";
import { TIERS, loadPref, savePref, gpuName, createGpuTimer, createProbe, createFrameGuard, stepDown, percentile, GUARD_STEPS } from "./quality.js";

const NEAR = 0.1, FAR = 4000;
const CLEAR = 0x070b1a;
/**
 * density = FOG_K / visibility (m). FogExp2 hides 1 − e^−(d·density)²: at the visibility
 * distance ~92% (a dark rock is a faint shape against the fog), at 70% of it ~71%, at half ~47%.
 * (The spec's "3/density" would hide everything by the visibility distance.)
 */
export const FOG_K = 1.6;
/** Visibility (m) for fog levels 0..3, as core/const.js FOG_VIS has it (setFog fallback only). */
const FOG_VIS = [200, 120, 70, 40];
const FOG_COLOR = 0x0d1b33;
const DARK_TEXT = "The sea went dark: reload to keep going.";
const NO_GL_TEXT = "Night Raid needs WebGL2, which this browser couldn't start. Try another browser, or turn on hardware acceleration.";

/** Capitalised tier name, for the Settings line. */
const nameOf = (tier) => tier.charAt(0).toUpperCase() + tier.slice(1);

/**
 * The render context every scene, avatar and audio module builds on.
 * @typedef {object} R
 * @property {typeof THREE} THREE
 * @property {THREE.WebGLRenderer} renderer
 * @property {THREE.Scene} scene
 * @property {THREE.PerspectiveCamera} camera
 * @property {THREE.Group} shipSpace   the ship's frame; world.js sails it, the camera rides in it
 * @property {CSS2DRenderer} labels
 * @property {typeof LAYERS} layers
 * @property {object} post        post.js: set(), hitStop(), get()
 * @property {object} cam         camera.js: shot(), trauma(), fovKick(), ray(), toggleChase()...
 * @property {import("./quality.js").Quality} quality   the current tier's settings (read live)
 * @property {"full"|"reduced"} motion
 * @property {{w: number, h: number, aspect: number, dpr: number}} size
 * @property {THREE.AudioListener|null} listener   on the camera, on the kit's AudioContext
 * @property {number} time        animation seconds (hit-stop scaled)
 * @property {number} rawTime     real seconds since start
 * @property {{fog: number, density: number, target: number, visibility: number, tint: THREE.Color, tintK: number}} atmos
 *           fog: the smoothed fog amount 0..1 (sky and water read it); tint/tintK: a colour the fog leans toward (a flare)
 * @property {object|null} sky    sky.js registers itself here
 * @property {object|null} water  water.js registers itself here
 */

/**
 * Build the renderer and R. Throws (after showing a message) when WebGL2
 * isn't available; main.js then plays on without the 3D night.
 * @param {{dom?: {stage?: HTMLElement, labels?: HTMLElement}}} [ctx]  main.js's UI context
 * @returns {R}
 */
export function createRenderer(ctx = {}) {
  const stage = ctx.dom?.stage || document.getElementById("stage") || document.body;
  const labelsEl = ctx.dom?.labels || document.getElementById("labels");

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false });
  } catch (error) {
    showVeil(NO_GL_TEXT, false);
    throw error;
  }
  const gl = renderer.getContext();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(CLEAR, 1);
  renderer.info.autoReset = false;          // count every pass of a frame: reflection, shadows, post
  renderer.domElement.setAttribute("aria-label", "The Rexmaw's helm at night");
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.name = "Night Raid";
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_K / FOG_VIS[0]);

  const camera = new THREE.PerspectiveCamera(60, 1, NEAR, FAR);
  camera.name = "Captain";
  for (const l of Object.values(LAYERS)) camera.layers.enable(l);

  const shipSpace = new THREE.Group();
  shipSpace.name = "shipSpace";
  scene.add(shipSpace);
  shipSpace.add(camera);

  const labels = new CSS2DRenderer(labelsEl ? { element: labelsEl } : {});
  if (!labelsEl) { labels.domElement.style.cssText = "position:absolute;inset:0;pointer-events:none"; stage.append(labels.domElement); }
  let labelClip = "";

  // ---- Listeners -----------------------------------------------------------------

  const frameFns = [];                       // { fn, order, seq, failed }
  let seq = 0;
  const resizeFns = new Set(), qualityFns = new Set();
  const call = (set, ...a) => { for (const fn of [...set]) { try { fn(...a); } catch (e) { console.debug("[night-raid] renderer listener threw", e); } } };

  // ---- Quality state -------------------------------------------------------------

  const gpu = gpuName(gl);
  const pref = loadPref();
  const cachedAuto = pref.auto && pref.gpu === gpu ? pref.auto : null;
  let tier = pref.pref !== "auto" ? pref.pref : (cachedAuto || "high");
  let needProbe = pref.pref === "auto" && !cachedAuto;
  let probe = null, probeTimer = 0, dprDrop = 0;
  let note = pref.pref === "auto" && cachedAuto ? `Auto: ${nameOf(cachedAuto)} (measured earlier on this GPU)` : "";
  const gpuTimer = createGpuTimer(gl);

  /** @type {R} */
  const R = {
    THREE, renderer, scene, camera, shipSpace, labels,
    layers: LAYERS, LAYERS,
    post: null, cam: null,
    quality: TIERS[tier],
    motion: matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "reduced" : "full",
    size: { w: 1, h: 1, aspect: 1, dpr: 1 },
    listener: null,
    time: 0, rawTime: 0,
    atmos: { fog: 0, density: FOG_K / FOG_VIS[0], target: FOG_K / FOG_VIS[0], visibility: FOG_VIS[0], tint: new THREE.Color(0xff9a4a), tintK: 0, day: 0 },
    sky: null, water: null,

    /**
     * Run `fn(dt, t, rawDt)` every frame, before the camera and the render.
     * @param {(dt: number, t: number, rawDt: number) => void} fn
     * @param {number} [order=0]  lower runs first (world.js −50, the sky −20, the water −10)
     * @returns {() => void} off
     */
    onFrame(fn, order = 0) {
      const entry = { fn, order, seq: seq++, failed: 0 };
      frameFns.push(entry);
      frameFns.sort((a, b) => a.order - b.order || a.seq - b.seq);
      return () => { const i = frameFns.indexOf(entry); if (i >= 0) frameFns.splice(i, 1); };
    },

    /** @param {(size: R["size"]) => void} fn @returns {() => void} off */
    onResize(fn) { resizeFns.add(fn); return () => resizeFns.delete(fn); },

    /** @param {(quality: import("./quality.js").Quality) => void} fn @returns {() => void} off */
    onQuality(fn) { qualityFns.add(fn); return () => qualityFns.delete(fn); },

    /**
     * Pick a tier, or "auto" (the probe's answer, measured once per GPU).
     * Switches live; the choice persists.
     * @param {"auto"|"low"|"medium"|"high"|"ultra"} choice
     */
    setQuality(choice) {
      if (choice === "auto") {
        pref.pref = "auto";
        savePref(pref);
        if (pref.auto && pref.gpu === gpu) { note = `Auto: ${nameOf(pref.auto)}`; applyTier(pref.auto); }
        else if (running) startProbe(); else needProbe = true;
        return;
      }
      if (!TIERS[choice]) return;
      probe?.cancel(); probe = null; needProbe = false;
      pref.pref = choice;
      savePref(pref);
      note = "";
      applyTier(choice, true);
    },

    /** "full" or "reduced" (no shake, hit-stop, sway, push-ins). @param {"full"|"reduced"} m */
    setMotion(m) {
      R.motion = m === "reduced" ? "reduced" : "full";
    },

    /**
     * How far the Captain can see, in metres (the sim's `visibility`: the
     * leg's fog, ×3 under a flare, the lantern's reach). The fog eases there.
     * @param {number} metres
     */
    setVisibility(metres) {
      const m = THREE.MathUtils.clamp(+metres || FOG_VIS[0], 15, 2000);
      R.atmos.visibility = m;
      R.atmos.target = FOG_K / m;
    },

    /** Fog by level (0 = clear harbour … 3 = a pea-souper). @param {number} level */
    setFog(level) {
      const x = THREE.MathUtils.clamp(+level || 0, 0, 3);
      const i = Math.min(2, Math.floor(x));
      R.setVisibility(THREE.MathUtils.lerp(FOG_VIS[i], FOG_VIS[i + 1], x - i));
    },

    /** Compile every material now (behind the title, and again after the VRM joins). */
    async compile() {
      const parallel = renderer.extensions.has("KHR_parallel_shader_compile");
      try {
        if (parallel) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
      } catch (e) { console.debug("[night-raid] compileAsync failed, compiling inline", e); renderer.compile(scene, camera); }
      R.post.warm();
      if (needProbe && running) { clearTimeout(probeTimer); startProbe(); }
    },

    /** Start the frame loop (and the auto-probe, once the shaders are compiled). */
    start() {
      if (running) return;
      running = true;
      last = 0;
      renderer.setAnimationLoop(frame);
      if (needProbe) probeTimer = setTimeout(() => { if (needProbe && running) startProbe(); }, 2500);
    },

    /** Stop the frame loop. */
    stop() { running = false; clearTimeout(probeTimer); renderer.setAnimationLoop(null); },

    /**
     * Frame stats for the perf overlay and the debug hooks.
     * @returns {{fps: number, frameMs: {p50: number, p90: number}, calls: number, triangles: number, tier: string, dpr: number, gpuMs: number, cpuMs: number}}
     */
    perf() {
      const list = intervals.slice(0, Math.min(nInt, intervals.length));
      const mean = list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
      return {
        fps: mean ? 1000 / mean : 0,
        frameMs: { p50: percentile(list, 0.5), p90: percentile(list, 0.9) },
        calls: stats.calls, triangles: stats.triangles, tier, dpr: R.size.dpr,
        gpuMs: gpuTimer.available ? gpuTimer.last : NaN, cpuMs: stats.cpuMs,
      };
    },

    /** Tear it all down. */
    dispose() {
      R.stop();
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      R.cam.dispose();
      R.post.dispose();
      gpuTimer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      frameFns.length = 0; resizeFns.clear(); qualityFns.clear();
    },
  };

  // ---- Size and pixel ratio ------------------------------------------------------

  function measure() {
    const w = Math.max(1, stage.clientWidth || window.innerWidth);
    const h = Math.max(1, stage.clientHeight || window.innerHeight);
    const base = Math.min(window.devicePixelRatio || 1, R.quality.dprCap);
    const dpr = Math.max(Math.min(base, GUARD_STEPS.dprFloor), base - dprDrop);
    return { w, h, dpr };
  }
  function resize() {
    const { w, h, dpr } = measure();
    const s = R.size;
    if (s.w === w && s.h === h && s.dpr === dpr) return;
    Object.assign(s, { w, h, aspect: w / h, dpr });
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = s.aspect;
    camera.updateProjectionMatrix();
    R.post?.resize();
    guard.hush(performance.now());
    call(resizeFns, s);
  }

  // ---- Tiers ---------------------------------------------------------------------

  function applyTier(next, force = false) {
    if (!TIERS[next] || (next === tier && !force && R.quality === TIERS[next])) return;
    const hadShadows = renderer.shadowMap.enabled;
    tier = next;
    R.quality = TIERS[next];
    dprDrop = 0;
    renderer.shadowMap.enabled = R.quality.shadows.moon > 0;
    resize();
    R.post.rebuild(R.quality);
    call(qualityFns, R.quality);
    // Shadows on or off changes every lit material's program.
    if (hadShadows !== renderer.shadowMap.enabled) {
      scene.traverse((o) => { const m = o.material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
    }
    guard.hush(performance.now(), 3000);
  }

  function startProbe() {
    needProbe = false;
    note = "Auto: measuring…";
    if (tier !== "high") applyTier("high");
    probe = createProbe({
      gpu: gpuTimer,
      onDone: (picked, st) => {
        probe = null;
        pref.auto = picked; pref.gpu = gpu;
        savePref(pref);
        note = `Auto: ${nameOf(picked)} (p90 ${st.p90.toFixed(1)} ms, ${st.via})`;
        console.debug("[night-raid] quality probe", picked, st);
        if (pref.pref === "auto") applyTier(picked);
      },
    });
  }

  const guard = createFrameGuard({
    onLower(step) {
      if (step === "dpr") {
        const base = Math.min(window.devicePixelRatio || 1, R.quality.dprCap);
        if (base - dprDrop - GUARD_STEPS.dprStep < GUARD_STEPS.dprFloor - 1e-6) return false;
        dprDrop += GUARD_STEPS.dprStep;
        resize();
        note = `Frame guard: resolution lowered to ${R.size.dpr.toFixed(2)}×`;
        console.debug("[night-raid]", note);
        return true;
      }
      if (tier === "low") { note = "Frame guard: already at Low"; return false; }
      // At sea (main sets this) only the resolution may drop: a tier step recompiles shaders and freezes the frame.
      if (R.holdTierSteps) { note = "Frame guard: tier step held until port"; return false; }
      const next = stepDown(tier);
      applyTier(next);
      note = `Frame guard: stepped down to ${nameOf(next)}`;
      if (pref.pref === "auto") { pref.auto = next; pref.gpu = gpu; savePref(pref); }
      console.debug("[night-raid]", note);
      return true;
    },
  });

  // ---- Build the rest on R -------------------------------------------------------

  renderer.shadowMap.enabled = R.quality.shadows.moon > 0;
  Object.assign(R.size, (() => { const m = measure(); return { ...m, aspect: m.w / m.h }; })());
  renderer.setPixelRatio(R.size.dpr);
  renderer.setSize(R.size.w, R.size.h, false);
  labels.setSize(R.size.w, R.size.h);
  camera.aspect = R.size.aspect;
  camera.updateProjectionMatrix();
  R.post = createPost(R);
  R.cam = createCameraRig(R);

  // Positional audio shares the kit's AudioContext. The context is only made on
  // the page's first gesture, so the listener joins the camera then; sfx.js looks
  // for R.listener on every play.
  const attachListener = () => {
    if (R.listener) return true;
    try {
      const ac = window.RexGame?.sfx?.context?.();
      if (!ac) return false;
      THREE.AudioContext.setContext(ac);
      R.listener = new THREE.AudioListener();
      camera.add(R.listener);
      return true;
    } catch (e) { console.debug("[night-raid] no audio listener", e); return true; }
  };
  const onGesture = () => {
    if (!attachListener()) return;
    for (const ev of ["pointerdown", "keydown"]) window.removeEventListener(ev, onGesture, true);
  };
  if (!navigator.userActivation?.hasBeenActive || !attachListener()) {
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, onGesture, true);
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(stage);
  window.addEventListener("resize", resize);

  function onVisibility() {
    last = 0;
    guard.hush(performance.now(), 3000);
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onLost(e) {
    e.preventDefault();
    R.stop();
    showVeil(DARK_TEXT, true);
  }
  renderer.domElement.addEventListener("webglcontextlost", onLost);

  // ---- The frame -----------------------------------------------------------------

  let running = false, last = 0;
  const intervals = new Float32Array(120);
  let nInt = 0, iInt = 0;
  const stats = { calls: 0, triangles: 0, cpuMs: 0 };
  // The fog "amount" the sky, the stars and the fog colour read: 0 at a clear night (Rexmaw Raids: 650 m
  // and up, so a night mission's 150–300 m fog greys the air), 1 at a pea-souper (40 m), on a log scale of density.
  const D_CLEAR = FOG_K / 650, D_DENSE = FOG_K / FOG_VIS[3];

  function frame(now) {
    const rawMs = last ? Math.max(0, now - last) : 1000 / 60;
    last = now;
    const raw = Math.min(rawMs, 100) / 1000;
    const dt = raw * R.post.timeScale(now);
    R.time += dt;
    R.rawTime += raw;
    const t0 = performance.now();
    renderer.info.reset();

    // Fog rolls in over ~1.4 s and lifts a little faster (a flare's light).
    const a = R.atmos;
    const tau = a.target < a.density ? 0.6 : 1.4;
    a.density += (a.target - a.density) * (1 - Math.exp(-raw / tau));
    scene.fog.density = a.density;
    a.fog = THREE.MathUtils.clamp(Math.log(a.density / D_CLEAR) / Math.log(D_DENSE / D_CLEAR), 0, 1);

    for (let k = 0; k < frameFns.length; k++) {
      const e = frameFns[k];
      try { e.fn(dt, R.time, raw); } catch (err) {
        if (e.failed++ < 3) console.debug("[night-raid] an onFrame listener threw", err);
      }
    }
    R.cam.update(dt);
    R.post.update(raw);
    gpuTimer.begin();
    R.post.render(dt);
    gpuTimer.end();
    // Labels are DOM, so the post chain's letterbox can't cover them: clip the layer to the same bars.
    const lb = R.post.get("letterbox") || 0;
    const clip = lb > 1e-3 ? `inset(${(7.5 * lb).toFixed(2)}% 0)` : "";
    if (clip !== labelClip) { labelClip = clip; labels.domElement.style.clipPath = clip; }
    labels.render(scene, camera);

    stats.cpuMs = performance.now() - t0;
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    gpuTimer.poll((ms) => probe?.gpu(ms));
    if (rawMs > 0 && rawMs < 250) { intervals[iInt] = rawMs; iInt = (iInt + 1) % intervals.length; nInt = Math.min(nInt + 1, intervals.length); }
    if (probe) probe.frame(now, rawMs, stats.cpuMs);
    else if (!document.hidden) guard.frame(now, rawMs);
  }

  resize();
  return R;
}

/**
 * A full-page message over the stage (lost context, no WebGL2), with a
 * Reload button when reloading helps.
 * @param {string} text
 * @param {boolean} reload
 */
function showVeil(text, reload) {
  if (document.getElementById("nh-dark")) return;
  const el = document.createElement("div");
  el.id = "nh-dark";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-live", "assertive");
  el.style.cssText = "position:fixed;inset:0;z-index:95;display:grid;place-items:center;padding:16px;"
    + "background:radial-gradient(110% 80% at 50% 110%,#12264a 0%,#0d1b33 35%,#070b1a 75%);";
  const card = document.createElement("div");
  card.style.cssText = "max-width:420px;padding:22px 24px;text-align:center;border-radius:16px;"
    + "border:1px solid rgba(255,207,107,.45);background:rgba(7,11,26,.86);box-shadow:0 18px 48px rgba(0,0,0,.55);"
    + "color:#f3e6c8;font:italic 1.05rem/1.5 Georgia,serif;";
  card.textContent = text;
  if (reload) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Reload";
    b.style.cssText = "display:block;margin:16px auto 0;min-height:44px;padding:9px 22px;border:0;border-radius:12px;cursor:pointer;"
      + "font:italic 800 1.05rem Georgia,serif;color:#2a1a05;background:radial-gradient(circle at 50% 28%,#ffe7a3,#e8a83e 70%,#b8862f);";
    b.addEventListener("click", () => location.reload());
    card.append(b);
  }
  el.append(card);
  document.body.append(el);
}
