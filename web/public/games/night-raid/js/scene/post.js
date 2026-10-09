// Night Raid (from Night Helm): the post chain (from Starboard's post.js).
//
//   ScenePass (scene → private HDR target, MSAA on Medium+; its copy into the
//   chain SANITISES: NaN/Inf → 0, clamp to 0..64) → BokehPass (cinematics,
//   High/Ultra; reads the scene's depth) → UnrealBloom → OutputPass
//   → GradePass (display space) → SMAA (Low only)
//
// Why the sanitiser: one NaN or Inf pixel in the HDR target (a pow() of a
// tiny negative, a normalize(0), a half-float overflow next to a point light)
// survives tone mapping as black, and the bloom's separable blur smears it
// over its whole kernel at every mip, so it comes out as a black BOX the size
// of the coarsest mip's footprint that follows whatever made it. That is the
// "black box drifting right-to-left" Starboard had (its lighthouse beam's far
// end: see ship.js). Cleaning the pixel in the first copy of the chain stops
// any such source from ever reaching the bloom.
//
// The scene renders into a half-float target, so only true HDR emissives
// (stars, lanterns, plankton, the moon, buoys, flares, the Kraken's eye) rise
// above the bloom threshold of 1.0. OutputPass applies Neutral tone mapping
// and sRGB; the grade then works on what the eye sees: split-tone tints,
// lift/gamma/gain, saturation, vignette, grain, and the cinematic overlays
// (letterbox bars, chromatic aberration, fades). A tiny dither ends it.
//
// Everything set through `post.set` tweens (0.3–0.8 s by default, eased),
// on real time, so a hit-stop never freezes a fade.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";

/** The brightest HDR value the chain lets through (anything above is white after tone mapping anyway). */
export const HDR_MAX = 64.0;

/** Grade presets (tints are added to the shadows and multiplied into the highlights). */
export const GRADE_PRESETS = Object.freeze({
  harbour: Object.freeze({ shadowTint: [-0.005, 0.02, 0.05], highTint: [1.06, 0.98, 0.88], sat: 1.0, vignette: 0.4, grain: 0.03 }),
  night: Object.freeze({ shadowTint: [-0.01, 0.02, 0.06], highTint: [1.06, 0.98, 0.86], sat: 0.95, vignette: 0.45, grain: 0.035 }),
  fog: Object.freeze({ shadowTint: [0.0, 0.015, 0.035], highTint: [1.04, 0.99, 0.92], sat: 0.85, vignette: 0.5, grain: 0.045 }),
  kraken: Object.freeze({ shadowTint: [-0.02, 0.035, 0.05], highTint: [1.0, 1.02, 0.96], sat: 1.05, vignette: 0.55, grain: 0.04 }),
  arrival: Object.freeze({ shadowTint: [0.0, 0.02, 0.04], highTint: [1.08, 0.97, 0.88], sat: 1.06, vignette: 0.32, grain: 0.025 }),
  // v2 reaches: the Rapids run cold and crisp, the Wreck Field murky and sallow, the Home Sprint warming toward dawn.
  rapids: Object.freeze({ shadowTint: [-0.01, 0.025, 0.06], highTint: [1.0, 1.02, 1.06], sat: 1.04, vignette: 0.42, grain: 0.03 }),
  wrecks: Object.freeze({ shadowTint: [0.01, 0.02, 0.0], highTint: [1.04, 1.0, 0.84], sat: 0.82, vignette: 0.55, grain: 0.05 }),
  home: Object.freeze({ shadowTint: [0.005, 0.015, 0.04], highTint: [1.1, 0.98, 0.86], sat: 1.04, vignette: 0.36, grain: 0.028 }),
  // Night Raid: the open bay, a fight (warmer, punchier), the storm (cold, flat), the maelstrom
  // (green-black), the Gloam (cold and drained), and the dawn coming up.
  bay: Object.freeze({ shadowTint: [-0.01, 0.02, 0.06], highTint: [1.06, 0.98, 0.86], sat: 0.96, vignette: 0.42, grain: 0.032 }),
  battle: Object.freeze({ shadowTint: [-0.005, 0.015, 0.045], highTint: [1.1, 0.97, 0.82], sat: 1.04, vignette: 0.48, grain: 0.038 }),
  storm: Object.freeze({ shadowTint: [0.0, 0.015, 0.03], highTint: [0.98, 1.0, 1.04], sat: 0.78, vignette: 0.55, grain: 0.05 }),
  maelstrom: Object.freeze({ shadowTint: [-0.015, 0.03, 0.04], highTint: [1.0, 1.03, 0.96], sat: 0.9, vignette: 0.55, grain: 0.045 }),
  gloam: Object.freeze({ shadowTint: [-0.01, 0.035, 0.04], highTint: [0.94, 1.04, 1.02], sat: 0.7, vignette: 0.6, grain: 0.05 }),
  dawn: Object.freeze({ shadowTint: [0.01, 0.015, 0.035], highTint: [1.12, 0.99, 0.88], sat: 1.06, vignette: 0.34, grain: 0.026 }),
  // Rexmaw Raids: the day (warm highlights, cool shade, rich colour) and the day in battle (a touch harder).
  day: Object.freeze({ shadowTint: [-0.01, 0.005, 0.025], highTint: [1.04, 1.0, 0.95], sat: 1.12, vignette: 0.22, grain: 0.012 }),
  daybattle: Object.freeze({ shadowTint: [-0.005, 0.0, 0.02], highTint: [1.07, 0.99, 0.9], sat: 1.08, vignette: 0.3, grain: 0.016 }),
});

/** The first copy of the chain: NaN/Inf to black, then clamp to 0..HDR_MAX. */
const SanitizeShader = {
  name: "NightHelmSanitize",
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // NaN → 0; +Inf (a half-float overflow: something very bright) → HDR_MAX; negatives → 0.
      c = mix(c, vec3(0.0), isnan(c));
      c = clamp(c, 0.0, ${HDR_MAX.toFixed(1)});
      // A second net for drivers that fold isnan away under fast math: a NaN fails every comparison.
      if (!all(greaterThanEqual(c, vec3(0.0)))) c = vec3(0.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/** The grade pass's shader: display-space colour work and the cinematic overlays. */
export const GradeShader = {
  name: "NightHelmGrade",
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uShadowTint: { value: new THREE.Vector3() },
    uHighTint: { value: new THREE.Vector3(1, 1, 1) },
    uLift: { value: 0 }, uGamma: { value: 1 }, uGain: { value: 1 },
    uSat: { value: 1 }, uVignette: { value: 0.4 }, uGrain: { value: 0.03 },
    uCA: { value: 0 }, uLetterbox: { value: 0 },
    uFade: { value: 0 }, uFadeColor: { value: new THREE.Vector3() },
    uScope: { value: 0 }, uFlash: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec3 uShadowTint, uHighTint, uFadeColor;
    uniform float uLift, uGamma, uGain, uSat, uVignette, uGrain, uCA, uLetterbox, uFade, uScope, uFlash;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      float aspect = uResolution.x / uResolution.y;
      vec2 c = vUv - 0.5;
      float r = length(vec2(c.x * aspect, c.y));

      // Radial chromatic aberration (the Kraken's rise, a heavy hit).
      float ca = uCA * 0.012 * r * r * 4.0;
      vec3 col;
      if (ca > 1e-5) {
        vec2 off = c * ca / max(r, 1e-3);
        col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      // Lift, gamma, gain.
      col = uGain * (col + uLift * (1.0 - col));
      col = pow(max(col, 0.0), vec3(1.0 / max(uGamma, 0.05)));

      // Split tone: cool shadows, warm (lantern-gold) highlights.
      float l = dot(col, LUMA);
      col += uShadowTint * (1.0 - smoothstep(0.0, 0.42, l));
      col *= mix(vec3(1.0), uHighTint, smoothstep(0.22, 0.95, l));

      // Saturation.
      l = dot(col, LUMA);
      col = max(mix(vec3(l), col, uSat), 0.0);

      // Vignette: 0 at the centre, uVignette darker at the corners.
      float nr = length(c * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
      col *= 1.0 - uVignette * smoothstep(0.28, 1.08, nr);

      // Film grain, animated, strongest in the mid-tones.
      float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 977.0) - 0.5;
      col += g * uGrain * (0.35 + 2.6 * l * (1.0 - l));

      // Lightning: a cold lift of the whole frame, strongest in the shadows.
      col += vec3(0.55, 0.62, 0.78) * clamp(uFlash, 0.0, 2.0) * (0.06 + 0.12 * (1.0 - l));

      // The spyglass: a round field of view, a brass rim, black beyond, a little darkening toward the rim.
      if (uScope > 1e-3) {
        vec2 q = vec2(c.x * aspect, c.y);
        float rad = mix(0.75, 0.43, uScope);
        float d = length(q);
        float px2 = 1.5 / uResolution.y;
        float inside = 1.0 - smoothstep(rad - px2, rad + px2, d);
        float rim = smoothstep(rad - 0.022, rad - 0.006, d) * inside;
        col *= mix(1.0, 1.0 - 0.55 * smoothstep(rad * 0.55, rad, d), uScope);
        col = mix(col, col * 0.4 + vec3(0.42, 0.3, 0.12) * 0.35, rim * uScope);
        col *= mix(1.0, inside, uScope);
      }

      // Fade to a colour (black for cuts, white for a flash).
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));

      // Letterbox: two bars, 7.5% of the height each at full.
      if (uLetterbox > 1e-3) {
        float bar = 0.075 * uLetterbox;
        float px = 1.0 / uResolution.y;
        col *= smoothstep(bar - px, bar + px, vUv.y) * smoothstep(bar - px, bar + px, 1.0 - vUv.y);
      }

      // Triangular dither: ±1/255, so night gradients don't band.
      col += (hash12(gl_FragCoord.xy + 17.17) + hash12(gl_FragCoord.xy + 71.31) - 1.0) / 255.0;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Tweened scalars, with their defaults. Tints are three scalars each.
const DEFAULTS = {
  "bloom.strength": 0.8, "bloom.radius": 0.3, "bloom.threshold": 1.0,
  "grade.lift": 0, "grade.gamma": 1, "grade.gain": 1, "grade.sat": 0.95, "grade.vignette": 0.45, "grade.grain": 0.035,
  "grade.st0": -0.01, "grade.st1": 0.02, "grade.st2": 0.06, "grade.ht0": 1.06, "grade.ht1": 0.98, "grade.ht2": 0.86,
  letterbox: 0, ca: 0, fade: 0, "fade.r": 0, "fade.g": 0, "fade.b": 0, exposure: 1.0, scope: 0, flash: 0,
  "dof.focus": 10, "dof.aperture": 0, "dof.maxblur": 0.006,
};
const DOF_APERTURE = 0.00035;   // blur per metre off focus, in screen units
const FAR_FOCUS = 200;          // metres: focused beyond this, nothing behind the focus blurs

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/**
 * The scene draw: it renders into a private HDR target (multisampled on the
 * MSAA tiers), then copies the resolved image into the composer's read
 * buffer through the sanitiser. Only this draw pays for MSAA; the
 * composer's ping-pong targets stay single-sample. With `withDepth` the
 * target keeps a depth texture (resolved from the MSAA depth), which the
 * bokeh reads.
 */
class ScenePass extends Pass {
  constructor(scene, camera, samples, withDepth) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: samples || 0,
      depthTexture: withDepth ? new THREE.DepthTexture(1, 1, THREE.FloatType) : null,
    });
    this.rt.texture.name = "NightHelm.hdr.scene";
    // Its own uniforms (a shared shader's uniforms holding a render target's texture
    // break every later clone of that shader with a cloneUniforms warning).
    const mat = new THREE.ShaderMaterial({
      name: "NightHelm.sanitize",
      uniforms: THREE.UniformsUtils.clone(SanitizeShader.uniforms),
      vertexShader: SanitizeShader.vertexShader,
      fragmentShader: SanitizeShader.fragmentShader,
    });
    mat.blending = THREE.NoBlending; mat.depthTest = false; mat.depthWrite = false;
    mat.uniforms.tDiffuse.value = this.rt.texture;
    this.copy = new FullScreenQuad(mat);
  }

  /** The scene's resolved depth, or null when the target has none. */
  get depthTexture() { return this.rt.depthTexture; }

  setSize(w, h) { this.rt.setSize(w, h); }

  render(renderer, writeBuffer, readBuffer) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.copy.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() { this.rt.dispose(); this.copy.material.dispose(); this.copy.dispose(); }
}

/**
 * Build the post chain for R (renderer.js calls this; everyone else uses R.post).
 * @param {object} R  the render context (renderer, scene, camera, quality, size, motion)
 */
export function createPost(R) {
  const { renderer, scene, camera } = R;
  const tw = {};                                   // key → { v, from, to, t0, dur }
  for (const [k, v] of Object.entries(DEFAULTS)) tw[k] = { v, from: v, to: v, t0: 0, dur: 0 };
  let clockMs = 0;
  let dofOn = false, dofAuto = true;
  let hit = { until: 0, scale: 1, easeOut: 0 };
  let composer = null, passes = {};

  /** Tween one key toward a value. */
  function to(key, value, dur) {
    const s = tw[key];
    if (!s || !Number.isFinite(value)) return;
    if (!(dur > 0)) { s.v = s.from = s.to = value; s.dur = 0; return; }
    if (s.to === value && s.dur > 0) return;
    s.from = s.v; s.to = value; s.t0 = clockMs; s.dur = dur * 1000;
  }

  function build(q) {
    disposeChain();
    const { w, h, dpr } = R.size;
    // The ping-pong targets are single-sample and need no depth: the scene draws into its own target.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    rt.texture.name = "NightHelm.hdr";
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(dpr);
    passes = {};
    passes.render = new ScenePass(scene, camera, q.msaa, !!q.dof);
    composer.addPass(passes.render);

    if (q.dof) {
      const bokeh = new BokehPass(scene, camera, { focus: tw["dof.focus"].v, aperture: 0, maxblur: tw["dof.maxblur"].v });
      // The bokeh reads the scene pass's resolved depth instead of drawing the
      // scene again with an override MeshDepthMaterial (that pre-pass gave
      // vertex-shaped things the wrong depth, drew additive glows as solid
      // occluders, and re-rendered every shadow map). Focused far off, the sky
      // stays sharp; a dead zone keeps the depth's imprecision from smearing the focus.
      const mat = bokeh.materialBokeh;
      const FOCUS_LINE = "float factor = ( focus + viewZ );";
      if (mat.fragmentShader.includes(FOCUS_LINE)) {
        mat.fragmentShader = mat.fragmentShader.replace(FOCUS_LINE,
          `${FOCUS_LINE}\n\t\t\tif ( focus > ${FAR_FOCUS.toFixed(1)} ) factor = max( factor - focus * 0.08, 0.0 );`);
      }
      mat.defines.DEPTH_PACKING = 0;            // raw depth from a DepthTexture, not RGBA-packed
      mat.needsUpdate = true;
      const scenePass = passes.render;
      bokeh.render = (rdr, writeBuffer, readBuffer) => {
        const u = bokeh.uniforms;
        u.tColor.value = readBuffer.texture;
        u.tDepth.value = scenePass.depthTexture;
        u.nearClip.value = camera.near; u.farClip.value = camera.far;
        u.aspect.value = camera.aspect;
        rdr.setRenderTarget(bokeh.renderToScreen ? null : writeBuffer);
        if (!bokeh.renderToScreen) rdr.clear();
        bokeh._fsQuad.render(rdr);
      };
      bokeh.enabled = dofOn;
      passes.bokeh = bokeh;
      composer.addPass(bokeh);
    }

    // UnrealBloomPass halves whatever size it's given for its first mip; scale it
    // so the bloom works at the tier's fraction of the screen (1/2, or 1/4 on Low).
    const bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(2, w * dpr * q.bloomScale * 2), Math.max(2, h * dpr * q.bloomScale * 2)),
      tw["bloom.strength"].v, tw["bloom.radius"].v, tw["bloom.threshold"].v);
    // Each kernel a true Gaussian (sigma = R/3): three's 1-sigma cut-off is close to a
    // box filter, and separable boxes make square halos.
    for (const m of bloom.separableBlurMaterials) {
      const n = m.defines.KERNEL_RADIUS, s = n / 3;
      m.uniforms.gaussianCoefficients.value = Array.from({ length: n }, (_, k) => Math.exp(-0.5 * k * k / (s * s)));
    }
    const setSize = bloom.setSize.bind(bloom);
    bloom.setSize = (bw, bh) => setSize(Math.max(2, bw * q.bloomScale * 2), Math.max(2, bh * q.bloomScale * 2));
    passes.bloom = bloom;
    composer.addPass(bloom);

    passes.output = new OutputPass();
    composer.addPass(passes.output);

    passes.grade = new ShaderPass(GradeShader);
    composer.addPass(passes.grade);

    if (q.smaa) {
      passes.smaa = new SMAAPass();
      composer.addPass(passes.smaa);
    }
    composer.setSize(w, h);
    passes.grade.uniforms.uResolution.value.set(w * dpr, h * dpr);
    apply();
  }

  function disposeChain() {
    if (!composer) return;
    for (const p of Object.values(passes)) { try { p.dispose?.(); } catch { /* already gone */ } }
    composer.dispose();
    composer = null;
  }

  /** Push the tweened values into the passes. */
  function apply() {
    const v = (k) => tw[k].v;
    const b = passes.bloom;
    if (b) { b.strength = v("bloom.strength"); b.radius = v("bloom.radius"); b.threshold = v("bloom.threshold"); }
    const u = passes.grade?.uniforms;
    if (u) {
      u.uLift.value = v("grade.lift"); u.uGamma.value = v("grade.gamma"); u.uGain.value = v("grade.gain");
      u.uSat.value = v("grade.sat"); u.uVignette.value = v("grade.vignette"); u.uGrain.value = v("grade.grain");
      u.uShadowTint.value.set(v("grade.st0"), v("grade.st1"), v("grade.st2"));
      u.uHighTint.value.set(v("grade.ht0"), v("grade.ht1"), v("grade.ht2"));
      u.uLetterbox.value = v("letterbox"); u.uCA.value = v("ca");
      u.uFade.value = v("fade"); u.uFadeColor.value.set(v("fade.r"), v("fade.g"), v("fade.b"));
      u.uScope.value = v("scope"); u.uFlash.value = v("flash");
    }
    renderer.toneMappingExposure = v("exposure");
    const k = passes.bokeh;
    if (k) {
      if (dofAuto && Number.isFinite(R.cam?.focus)) tw["dof.focus"].v = R.cam.focus;
      k.uniforms.focus.value = v("dof.focus");
      k.uniforms.aperture.value = v("dof.aperture");
      k.uniforms.maxblur.value = v("dof.maxblur");
      k.enabled = dofOn || v("dof.aperture") > 1e-7;
    }
  }

  function setGrade(g, dur) {
    if (g.phase && GRADE_PRESETS[g.phase]) gradeTo(GRADE_PRESETS[g.phase], dur);
    for (const k of ["lift", "gamma", "gain", "sat", "vignette", "grain"]) if (Number.isFinite(g[k])) to(`grade.${k}`, g[k], dur);
  }
  function gradeTo(p, dur) {
    to("grade.sat", p.sat, dur); to("grade.vignette", p.vignette, dur); to("grade.grain", p.grain, dur);
    p.shadowTint.forEach((x, i) => to(`grade.st${i}`, x, dur));
    p.highTint.forEach((x, i) => to(`grade.ht${i}`, x, dur));
  }

  /**
   * @typedef {object} PostSettings
   * @property {{strength?: number, radius?: number, threshold?: number}} [bloom]
   * @property {{phase?: "harbour"|"night"|"fog"|"kraken"|"arrival", lift?: number, gamma?: number, gain?: number,
   *             sat?: number, vignette?: number, grain?: number}} [grade]
   * @property {number|boolean} [letterbox]   0..1 (true = 1)
   * @property {number} [ca]                  0..1 radial chromatic aberration
   * @property {number|{amount: number, color?: string|number}} [fade]   to black, or to a colour ("white")
   * @property {number} [exposure]            tone-mapping exposure (1 = neutral)
   * @property {{on?: boolean, focus?: number|"auto", aperture?: number, maxblur?: number}} [dof]
   */

  const post = {
    /**
     * Tween post settings. Every value eases over `duration` seconds
     * (default 0.6; letterbox 0.8, the grade 1.2).
     * @param {PostSettings} opts
     * @param {{duration?: number}} [how]
     */
    set(opts = {}, how = {}) {
      const d = (def) => (Number.isFinite(how.duration) ? how.duration : def);
      if (opts.bloom) {
        if (Number.isFinite(opts.bloom.strength)) to("bloom.strength", opts.bloom.strength, d(0.6));
        if (Number.isFinite(opts.bloom.radius)) to("bloom.radius", opts.bloom.radius, d(0.6));
        if (Number.isFinite(opts.bloom.threshold)) to("bloom.threshold", opts.bloom.threshold, d(0.6));
      }
      if (opts.grade) setGrade(opts.grade, d(1.2));
      if (opts.letterbox != null) to("letterbox", +opts.letterbox, d(0.8));
      if (opts.ca != null) to("ca", +opts.ca, d(0.5));
      if (opts.exposure != null) to("exposure", +opts.exposure, d(0.8));
      if (opts.scope != null) to("scope", +opts.scope, d(0.35));
      if (opts.flash != null) to("flash", +opts.flash, d(0.05));
      if (opts.fade != null) {
        const f = typeof opts.fade === "object" ? opts.fade : { amount: +opts.fade };
        if (f.color != null) {
          const c = new THREE.Color(f.color === "white" ? 0xf4f1ea : f.color === "black" ? 0x000000 : f.color);
          c.convertLinearToSRGB();
          to("fade.r", c.r, 0); to("fade.g", c.g, 0); to("fade.b", c.b, 0);
        }
        to("fade", +f.amount || 0, d(0.6));
      }
      if (opts.dof) {
        const o = opts.dof;
        if (o.focus === "auto") dofAuto = true;
        else if (Number.isFinite(o.focus)) { dofAuto = false; to("dof.focus", o.focus, d(0.6)); }
        if (Number.isFinite(o.maxblur)) to("dof.maxblur", o.maxblur, d(0.6));
        if (o.on != null) {
          dofOn = !!o.on && !!R.quality.dof;
          to("dof.aperture", dofOn ? (Number.isFinite(o.aperture) ? o.aperture : DOF_APERTURE) : 0, d(0.7));
        } else if (Number.isFinite(o.aperture) && dofOn) to("dof.aperture", o.aperture, d(0.6));
      }
    },

    /**
     * Hit-stop: animation time runs at `scale` for `ms`, then eases back.
     * Audio, input and the sim keep real time. Reduced motion skips it.
     * @param {number} [ms=80]
     * @param {number} [scale=0.05]
     */
    hitStop(ms = 80, scale = 0.05, easeOut = 70) {
      if (R.motion === "reduced") return;
      const now = performance.now();
      // A longer stop already running (a slow-mo) isn't cut short by a hit.
      if (now < hit.until && hit.until > now + ms && hit.scale <= scale) return;
      hit = { until: now + ms, scale: THREE.MathUtils.clamp(scale, 0, 1), easeOut: Math.max(1, +easeOut || 70) };
    },

    /** The animation time scale right now (renderer.js multiplies dt by it). @param {number} now  performance.now() */
    timeScale(now) {
      if (now < hit.until) return hit.scale;
      const k = (now - hit.until) / hit.easeOut;
      return k >= 1 ? 1 : hit.scale + (1 - hit.scale) * easeInOut(k);
    },

    /** The current value of a tweened setting ("letterbox", "bloom.strength", "fade", ...). */
    get: (key) => tw[key]?.v,

    /** Whether depth of field is active (or still racking out). */
    get dofActive() { return !!passes.bokeh?.enabled; },

    /** The passes, for the curious (debug). */
    get passes() { return passes; },

    /** @internal Advance the tweens on real time (seconds). */
    update(rawDt) {
      clockMs += rawDt * 1000;
      for (const s of Object.values(tw)) {
        if (!(s.dur > 0)) continue;
        const k = Math.min(1, (clockMs - s.t0) / s.dur);
        s.v = s.from + (s.to - s.from) * easeInOut(k);
        if (k >= 1) { s.v = s.to; s.dur = 0; }
      }
      if (passes.grade) passes.grade.uniforms.uTime.value = clockMs / 1000;
      apply();
    },

    /** @internal Draw a frame. */
    render(dt) { composer?.render(dt); },

    /** @internal The canvas size or DPR changed. */
    resize() {
      if (!composer) return;
      const { w, h, dpr } = R.size;
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
      passes.grade.uniforms.uResolution.value.set(w * dpr, h * dpr);
    },

    /** @internal A new tier: rebuild the targets and passes. */
    rebuild(q) {
      if (!q.dof) dofOn = false;
      build(q);
    },

    /** @internal Compile every pass's shaders now (the bokeh too, even when it's off). */
    warm() {
      if (!composer) return;
      const k = passes.bokeh;
      const was = k?.enabled;
      if (k) k.enabled = true;
      composer.render(0);
      if (k) k.enabled = was;
    },

    dispose() { disposeChain(); },
  };

  build(R.quality);
  post.set({ grade: { phase: "harbour" } }, { duration: 0 });
  return post;
}
