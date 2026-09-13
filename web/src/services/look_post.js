/**
 * Post-processing behind the "Effects" look pref (EFFECTS_PRESETS in
 * avatar_renderer.js): Unity URP's Bloom, ported from its low-quality
 * Gaussian path (Graphics repo, Shaders/PostProcessing/Bloom.shader +
 * BloomPostProcessPass.cs) so a URP Bloom volume's values mean the same
 * here — prefilter on the brightest channel with the gamma-space threshold
 * converted to linear and a hardcoded knee of half the threshold; a
 * half-res mip pyramid of floor(log2(size) - 1) levels capped at
 * maxIterations (9-tap Gaussian downsample, 5-tap bilinear vertical blur);
 * an upsample lerping each mip with the one below by
 * lerp(0.05, 0.95, scatter); composited additively, scaled by intensity ×
 * the luminance-normalised linear tint.
 *
 * Exposure: Unity-authored bloom numbers assume MToon's lit white sits near
 * 1.0 linear (white albedo under a white intensity-1 key). Rexclaw's rigs
 * put it at ~0.6 (measured: p99 avatar luminance 0.55-0.62 across the
 * daytime lighting presets), so the prefilter reads the scene / EXPOSURE
 * and the bloom goes back in × EXPOSURE — thresholds and intensities land
 * where they would in the Unity scene they were tuned in.
 *
 * Transparency: the canvas is transparent wherever the avatar isn't (the
 * full view's backdrop is a CSS layer underneath; the mascot floats on the
 * desktop) — three's UnrealBloomPass writes alpha 1 and would black it
 * out. Everything here stays premultiplied (as URP's alpha-output
 * prefilter does), and glow over a transparent pixel is written with alpha
 * = its own brightness, which the browser composites as a screen blend onto
 * whatever is behind the canvas. `spill` 0 keeps the glow inside the
 * avatar instead.
 */
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const EXPOSURE = 0.6;

const VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

// URP Bloom.shader FragPrefilter (single tap). The scene target is already
// premultiplied, which is what URP's _ENABLE_ALPHA_OUTPUT prefilter does.
const PREFILTER = /* glsl */`
    uniform sampler2D tSrc;
    uniform float threshold;
    uniform float knee;
    uniform float clampMax;
    uniform float invExposure;
    varying vec2 vUv;
    void main() {
        vec3 color = min(vec3(clampMax), texture2D(tSrc, vUv).rgb * invExposure);
        float brightness = max(color.r, max(color.g, color.b));
        float softness = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
        softness = (softness * softness) / (4.0 * knee + 1e-4);
        color *= max(brightness - threshold, softness) / max(brightness, 1e-4);
        gl_FragColor = vec4(max(color, 0.0), 1.0);
    }`;

// URP FragBlurH: 9-tap Gaussian at twice the source texel size — the
// downsample to the next mip.
const BLUR_H = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 texel;
    varying vec2 vUv;
    vec3 tap(float i) { return texture2D(tSrc, vUv + vec2(texel.x * i, 0.0)).rgb; }
    void main() {
        vec3 c = tap(-4.0) * 0.01621622 + tap(-3.0) * 0.05405405 + tap(-2.0) * 0.12162162
            + tap(-1.0) * 0.19459459 + tap(0.0) * 0.22702703 + tap(1.0) * 0.19459459
            + tap(2.0) * 0.12162162 + tap(3.0) * 0.05405405 + tap(4.0) * 0.01621622;
        gl_FragColor = vec4(c, 1.0);
    }`;

// URP FragBlurV: bilinear 5-tap Gaussian (9-tap equivalent), same size.
const BLUR_V = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 texel;
    varying vec2 vUv;
    vec3 tap(float i) { return texture2D(tSrc, vUv + vec2(0.0, texel.y * i)).rgb; }
    void main() {
        vec3 c = tap(-3.23076923) * 0.07027027 + tap(-1.38461538) * 0.31621622
            + tap(0.0) * 0.22702703
            + tap(1.38461538) * 0.31621622 + tap(3.23076923) * 0.07027027;
        gl_FragColor = vec4(c, 1.0);
    }`;

// URP Upsample (low-quality: bilinear low mip).
const UPSAMPLE = /* glsl */`
    uniform sampler2D tHigh;
    uniform sampler2D tLow;
    uniform float scatter;
    varying vec2 vUv;
    void main() {
        gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, texture2D(tLow, vUv).rgb, scatter), 1.0);
    }`;

// URP's uber pass for bloom (color += bloom), then sRGB-encoded for the
// canvas, premultiplied.
const COMPOSITE = /* glsl */`
    uniform sampler2D tScene;
    uniform sampler2D tBloom;
    uniform vec3 bloomScale;
    uniform float spill;
    varying vec2 vUv;
    vec3 toSRGB(vec3 c) {
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    void main() {
        vec4 s = texture2D(tScene, vUv);
        vec3 b = texture2D(tBloom, vUv).rgb * bloomScale;
        float a = min(1.0, s.a + spill * max(b.r, max(b.g, b.b)) * (1.0 - s.a));
        vec3 c = min(s.rgb + b, vec3(a));
        gl_FragColor = vec4(a > 0.0 ? toSRGB(c / a) * a : vec3(0.0), a);
    }`;

export class LookPost {
    constructor(THREE, renderer) {
        this.THREE = THREE;
        this.renderer = renderer;
        // Half float keeps dark gradients from banding in linear light;
        // fall back to 8-bit where float targets aren't renderable.
        const ext = renderer.extensions;
        this._type = (ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"))
            ? THREE.HalfFloatType : THREE.UnsignedByteType;
        this._size = new THREE.Vector2();
        this._w = 0;
        this._h = 0;
        this._sceneRT = null;
        this._down = [];
        this._up = [];
        this._maxIterations = 6;
        const mat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
            uniforms, vertexShader: VERTEX, fragmentShader,
            depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        });
        const v2 = () => ({ value: new THREE.Vector2() });
        this._prefilter = mat(PREFILTER, {
            tSrc: { value: null }, threshold: { value: 1 }, knee: { value: 0.5 },
            clampMax: { value: 65472 }, invExposure: { value: 1 / EXPOSURE },
        });
        this._blurH = mat(BLUR_H, { tSrc: { value: null }, texel: v2() });
        this._blurV = mat(BLUR_V, { tSrc: { value: null }, texel: v2() });
        this._upsample = mat(UPSAMPLE, { tHigh: { value: null }, tLow: { value: null }, scatter: { value: 0.7 } });
        this._composite = mat(COMPOSITE, {
            tScene: { value: null }, tBloom: { value: null },
            bloomScale: { value: new THREE.Vector3() }, spill: { value: 1 },
        });
        this._quad = new FullScreenQuad(null);
    }

    /** URP Bloom volume values: threshold (gamma), intensity, scatter,
     *  tint (hex, sRGB), clamp, maxIterations. */
    configure({ threshold = 0.9, intensity = 0, scatter = 0.7, tint = 0xffffff, clamp = 65472, maxIterations = 6 } = {}) {
        // Mathf.GammaToLinearSpace — the exact sRGB curve.
        const t = threshold <= 0.04045 ? threshold / 12.92 : Math.pow((threshold + 0.055) / 1.055, 2.4);
        this._prefilter.uniforms.threshold.value = t;
        this._prefilter.uniforms.knee.value = t * 0.5;      // URP's hardcoded soft knee
        this._prefilter.uniforms.clampMax.value = clamp;
        this._upsample.uniforms.scatter.value = 0.05 + 0.9 * scatter;
        this._maxIterations = maxIterations;
        const c = new this.THREE.Color(tint);                // hex is sRGB; Color holds linear
        const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        if (luma > 0) c.multiplyScalar(1 / luma);
        else c.setRGB(1, 1, 1);
        this._composite.uniforms.bloomScale.value.set(c.r, c.g, c.b).multiplyScalar(intensity * EXPOSURE);
        this._w = 0;   // the mip count depends on maxIterations — rebuild targets
    }

    /** Whether glow may extend past the avatar's silhouette. */
    setSpill(on) {
        this._composite.uniforms.spill.value = on ? 1 : 0;
    }

    _target(list, i, w, h) {
        const opts = { type: this._type, depthBuffer: false };
        if (!list[i]) list[i] = new this.THREE.WebGLRenderTarget(w, h, opts);
        else list[i].setSize(w, h);
    }

    _ensureTargets() {
        const size = this.renderer.getDrawingBufferSize(this._size);
        const w = Math.max(1, size.x), h = Math.max(1, size.y);
        if (w === this._w && h === this._h) return;
        this._w = w;
        this._h = h;
        if (!this._sceneRT) {
            this._sceneRT = new this.THREE.WebGLRenderTarget(w, h, { type: this._type, samples: 4 });
        } else {
            this._sceneRT.setSize(w, h);
        }
        // BloomPostProcessPass: half res ("Downscale: Half"),
        // floor(log2(max side) - 1) mips, clamped to [1, maxIterations].
        const tw = Math.max(1, w >> 1), th = Math.max(1, h >> 1);
        this._mipCount = Math.min(Math.max(Math.floor(Math.log2(Math.max(tw, th)) - 1), 1), this._maxIterations);
        for (let i = 0; i < this._mipCount; i++) {
            const mw = Math.max(1, tw >> i), mh = Math.max(1, th >> i);
            this._target(this._down, i, mw, mh);
            this._target(this._up, i, mw, mh);
        }
    }

    _pass(material, target) {
        this._quad.material = material;
        this.renderer.setRenderTarget(target);
        this._quad.render(this.renderer);
    }

    /** Render `scene` through the bloom onto the canvas. */
    render(scene, camera) {
        const r = this.renderer;
        this._ensureTargets();
        r.setRenderTarget(this._sceneRT);
        r.render(scene, camera);

        const down = this._down, up = this._up, n = this._mipCount;
        this._prefilter.uniforms.tSrc.value = this._sceneRT.texture;
        this._pass(this._prefilter, down[0]);
        // Downsample: blur H at 2x the source texel into up[i] (URP uses the
        // up mip as the scratch target), then blur V into down[i].
        for (let i = 1; i < n; i++) {
            const src = down[i - 1];
            this._blurH.uniforms.tSrc.value = src.texture;
            this._blurH.uniforms.texel.value.set(2 / src.width, 2 / src.height);
            this._pass(this._blurH, up[i]);
            this._blurV.uniforms.tSrc.value = up[i].texture;
            this._blurV.uniforms.texel.value.set(1 / up[i].width, 1 / up[i].height);
            this._pass(this._blurV, down[i]);
        }
        for (let i = n - 2; i >= 0; i--) {
            this._upsample.uniforms.tHigh.value = down[i].texture;
            this._upsample.uniforms.tLow.value = (i === n - 2 ? down[i + 1] : up[i + 1]).texture;
            this._pass(this._upsample, up[i]);
        }

        this._composite.uniforms.tScene.value = this._sceneRT.texture;
        this._composite.uniforms.tBloom.value = (n === 1 ? down[0] : up[0]).texture;
        this._pass(this._composite, null);
    }

    dispose() {
        for (const t of [this._sceneRT, ...this._down, ...this._up]) t?.dispose();
        for (const m of [this._prefilter, this._blurH, this._blurV, this._upsample, this._composite]) m.dispose();
        this._quad.dispose();
    }
}
