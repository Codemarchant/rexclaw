/**
 * Art styles — the Look → "Art style" pref. The whole frame is repainted,
 * live, in a medium: the companion keeps talking, blinking and gesturing
 * inside an oil painting, a watercolour, an inked manga panel, a
 * three-colour risograph print or a pixel-art screen.
 *
 * Each style is a port of a published technique, run with that
 * technique's own parameters; STYLE_PARAMS marks every number that is a
 * design choice instead:
 *   oil          anisotropic Kuwahara filter with polynomial sector weights
 *                (strokes follow the local structure of the image), then
 *                flow-aligned paint textures — bristle relief and varnish —
 *                bump-mapped and Phong-lit, on a woven linen canvas
 *   watercolour  the MNPR watercolour chain: difference-of-Gaussians edges
 *                blurred into edge darkening, pigment granulation in the
 *                paper's valleys, paper distortion and paper lighting, plus
 *                turbulent pigment density
 *   ink          flow-based XDoG line drawing, its tone ramp snapped to
 *                60-line screentone sheets or solid black, two-level like a
 *                manga manuscript, the lines boiling on twos
 *   riso         three drum inks, each halftoned at its own screen angle,
 *                separated through the Neugebauer/Demichel overprint model,
 *                slightly out of register like every real riso print
 *   pixel        integer-scaled low-res frame, 4×4 Bayer ordered dithering
 *                into a fixed pixel-art palette matched in OKLab, and a
 *                selective inside outline on the characters
 *
 * Pipeline: the scene (or the bloom's output, services/look_post.js) is
 * rendered at a working resolution; "prep" encodes it to sRGB and — on the
 * full-screen host — composites the backdrop underneath (the CSS layer the
 * renderer hands over as a texture), so the painting covers the whole
 * frame. Style passes run at the working resolution; the last pass runs at
 * the canvas's own resolution so paper, weave and halftone dots stay crisp.
 * Without a backdrop (the see-through mascot, mini hosts) only the
 * characters are painted and the output keeps its alpha: the painting
 * becomes a cut-out on the desktop.
 *
 * Switching styles plays a reveal instead of a cut: oil is laid down patch
 * by patch along the brush flow, watercolour spreads out as a wet wash
 * with a dark tide line, manga is inked line-first and toned after, the
 * riso drums print one ink at a time, pixel art resolves from a coarse
 * mosaic. Switching off (or to another style) runs it backwards first.
 *
 * Everything stays premultiplied, as the canvas is (alpha: true).
 */
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// Kernel sizes below are pixels of a frame this many lines tall; the
// working resolution scales them, so a style looks the same in a small
// mascot window as full screen. (Design: the order of the published test
// images.)
const REF_LINES = 720;
// Reveal timing — design values.
const REVEAL_IN_MS = 2600;
const REVEAL_OUT_MS = 900;
// Surface tiles (paper) are generated once, periodic, this size.
const TILE = 512;

export const STYLE_PARAMS = {
    oil: {
        maxLines: 720,
        // Kyprianidis, Kang & Döllner 2009 / Kyprianidis et al. 2010, and
        // the authors' own shader (polyakf akf_v3n8.glsl, called with
        // sigma 2, alpha 1, radius 6, q 8): tensor smoothing σ, ellipse
        // semi-axis, sharpness, anisotropy tuning, and the polynomial
        // sector weights for N = 8 — ζ = 1/3, η(1/3, 3π/2N) ≈ 3.77.
        sigmaT: 2.0,
        radius: 6.0,
        q: 8.0,
        alpha: 1.0,
        zeta: 0.33,
        eta: 3.77,
        // Semmo et al. 2015 paint textures, K = (σb, kscale, kspecular,
        // kshininess) = (8, 10, 3, 8): noise smoothed along the flow by a
        // line integral, bump-mapped; brush texture TB = 0.5 + N·L
        // multiplies the colour, varnish TV = kspecular (N·L)^kshininess is
        // added (linear dodge). High-frequency noise for the brush,
        // low-frequency noise for the varnish, as they found works best.
        // The flow those textures follow comes from a structure tensor
        // smoothed at σ = 8 (their Fig. 10) — broad, calm strokes — while
        // the Kuwahara keeps its own σ = 2.
        sigmaB: 8.0,
        sigmaFlow: 8.0,
        kScale: 10.0,
        kSpecular: 3.0,
        kShininess: 8.0,
        // Semmo et al. don't publish their noise's amplitude, so the height
        // units behind kscale don't carry over: our noise height is scaled
        // to a relief that reads as brushwork, not plastic — calibrated by
        // eye. Varnish noise cell size: design.
        heightScale: 0.35,
        varnishCell: 6.0,
        // The light's elevation is derived, not picked: 30° above the
        // canvas puts N·L at 0.5 on flat paint, so TB is exactly 1 there
        // and only the relief shades. Azimuth from the upper left: design.
        lightElevationDeg: 30,
        lightAzimuthDeg: 135,
        // Canvas: Claessens No 20 linen (14.3 warp × 10.5 weft threads/cm)
        // on a JIS F4 canvas (33.3 cm tall) — the frame's height is the
        // canvas's. How much weave shows through the paint: design.
        warpPerCm: 14.3,
        weftPerCm: 10.5,
        canvasCm: 33.3,
        weave: 0.06,
        orderCell: 9.0,         // design: px per reveal patch
    },
    watercolour: {
        maxLines: 720,
        // MNPR's shipped watercolour defaults (mnpr_renderer.h): edge
        // darkening intensity 1 over a width-3 kernel (σ = width / 2, taps
        // o < width), pigment density 5 (granulation), substrate
        // distortion 1 px, substrate shading 0.5 lit at 45° tilt.
        edgeIntensity: 1.0,
        edgeWidth: 3.0,
        pigmentDensity: 5.0,
        distortionPx: 1.0,
        substrateShading: 0.5,
        substrateTiltDeg: 45,
        substrateColor: [1, 1, 1],
        // Bousseau et al. 2006 turbulent flow: density d = 1 + β(T − 0.5)
        // from four octaves blended by 1/f. The paper gives no β: design.
        turbulence: 0.6,
    },
    ink: {
        maxLines: 1080,
        // XDoG (Winnemöller, Kyprianidis & Olsen 2012) with the authors'
        // reference defaults (xdog-demo: flow-based, the paper's Fig. 2g
        // set): structure tensor σc (blurred out to 2.45σc), DoG σe with
        // k = 1.6 (Marr–Hildreth), flow integration σm, anti-aliasing σa,
        // and the threshold in its τ form (τ, ε, φ ≡ p 21.7, ε 79.5,
        // φ 0.017) on CIE L* (0–100).
        sigmaC: 2.28,
        sigmaE: 1.4,
        k: 1.6,
        sigmaM: 4.4,
        sigmaA: 1.0,
        tau: 0.95595,
        epsilon: 3.5022,
        phi: 0.3859,
        // Screentone: 60 lines at 45° — CLIP STUDIO's standard and the base
        // of the Deleter / IC ranges; the tone sheets are catalogue
        // densities (Deleter SE-60/61/62: 5, 10, 20%). XDoG's tone ramp
        // snaps to the nearest sheet, or to solid black. Manuscripts are
        // two-level black and white (publishers ask for 600 dpi 1-bit).
        toneAngle: 45,
        tones: [0.05, 0.1, 0.2],
        // Design: dot pitch at 1080 lines (60 lines on a real page are
        // sub-pixel on screen), and the grey the see-through mascot is
        // outlined against.
        tonePitchPx: 5,
        outlineGrey: 0.466,     // sRGB of L* 50
        // Line boil redrawn on twos — 12 drawings a second (Laybourne, The
        // Animation Book). Its size is design.
        boilHz: 12,
        boilPx: 0.6,
        ink: [0, 0, 0],
        paper: [1, 1, 1],
    },
    riso: {
        maxLines: 720,
        // Stencil's RISO ink list (mattdesl/riso-colors, MIT): Fluorescent
        // Pink (806 U), Blue (3005 U), Yellow (Yellow U).
        inks: ["#ff48b0", "#0078bf", "#ffe800"],
        // Screen angles per ink: the offset-print convention (M 75°,
        // C 15°, Y 0°) so the three screens don't moiré.
        angles: [75, 15, 0],
        // RISO's coarsest dot process (MZ panel "Dot Process 4", 34 lpi
        // equivalent) on an A5 sheet (210 mm, the classic riso zine) — the
        // frame's height is the sheet's.
        lpi: 34,
        sheetMm: 210,
        // Riso studios quote 0–2 mm of shift between drums for tight work
        // (up to 3 mm with more colours); each ink lands a random 0–2 mm off.
        misregMm: 2,
        paper: "#f4f0e6",       // design: uncoated natural paper
    },
    pixel: {
        maxLines: 720,
        // The SNES's 224 visible lines (256 × 224), rounded to a whole
        // number of canvas pixels per pixel.
        lines: 224,
        // Resurrect 64 by Kerrie Lake (lospec; free for commercial use per
        // the author) — 64 colours with a full skin-tone ramp.
        palette: [
            "#2e222f", "#3e3546", "#625565", "#966c6c", "#ab947a", "#694f62", "#7f708a", "#9babb2",
            "#c7dcd0", "#ffffff", "#6e2727", "#b33831", "#ea4f36", "#f57d4a", "#ae2334", "#e83b3b",
            "#fb6b1d", "#f79617", "#f9c22b", "#7a3045", "#9e4539", "#cd683d", "#e6904e", "#fbb954",
            "#4c3e24", "#676633", "#a2a947", "#d5e04b", "#fbff86", "#165a4c", "#239063", "#1ebc73",
            "#91db69", "#cddf6c", "#313638", "#374e4a", "#547e64", "#92a984", "#b2ba90", "#0b5e65",
            "#0b8a8f", "#0eaf9b", "#30e1b9", "#8ff8e2", "#323353", "#484a77", "#4d65b4", "#4d9be6",
            "#8fd3ff", "#45293f", "#6b3e75", "#905ea9", "#a884f3", "#eaaded", "#753c54", "#a24b6f",
            "#cf657f", "#ed8099", "#831c5d", "#c32454", "#f04f78", "#f68181", "#fca790", "#fdcbb0",
        ],
    },
};

export const ART_STYLES = Object.fromEntries(Object.keys(STYLE_PARAMS).map((id) => [id, true]));

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** OKLab (Ottosson 2020) of an sRGB triple in [0, 1]. */
function oklab([r, g, b]) {
    [r, g, b] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

/** A CSS rgb()/rgba() string → sRGB triple, or null when transparent. */
function parseCssColor(css) {
    const m = /rgba?\(([^)]+)\)/.exec(css || "");
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 4 && !(parts[3] > 0)) return null;
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
}

const VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

// Shared helpers. Hash: PCG (Jarzynski & Olano 2020); value noise with the
// quintic fade; periodic variants for the surface tiles.
const COMMON = /* glsl */`
    #define PI 3.14159265358979
    varying vec2 vUv;
    uint pcg(uint v) {
        uint s = v * 747796405u + 2891336453u;
        uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
        return (w >> 22u) ^ w;
    }
    float hash(vec2 p) {
        uvec2 q = uvec2(ivec2(floor(p)) + 65536);
        return float(pcg(q.x + pcg(q.y))) * (1.0 / 4294967295.0);
    }
    float hashP(vec2 p, float period) { return hash(mod(floor(p), period)); }
    vec2 fade(vec2 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }
    float vnoise(vec2 p) {
        vec2 i = floor(p), u = fade(fract(p));
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float vnoiseP(vec2 p, float period) {
        vec2 i = floor(p), u = fade(fract(p));
        return mix(mix(hashP(i, period), hashP(i + vec2(1.0, 0.0), period), u.x),
                   mix(hashP(i + vec2(0.0, 1.0), period), hashP(i + vec2(1.0, 1.0), period), u.x), u.y);
    }
    // Periodic fBm with 1/f amplitudes: each octave doubles the lattice
    // and its period, halving its weight.
    float fbmP(vec2 p, float period, int octaves) {
        float s = 0.0, a = 0.5, n = 0.0;
        for (int i = 0; i < 6; i++) {
            if (i >= octaves) break;
            s += a * vnoiseP(p, period);
            n += a;
            p *= 2.0;
            period *= 2.0;
            a *= 0.5;
        }
        return s / n;
    }
    vec3 toSRGB(vec3 c) {
        c = max(c, 0.0);
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    vec3 toLinear(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 unpremul(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
    // The smoothed structure tensor (E, G, F) → tangent, its angle and the
    // anisotropy A = (λ1 − λ2) / (λ1 + λ2). The tangent is the minor
    // eigenvector: the direction the image changes least — along an edge.
    vec4 flowAt(sampler2D t, vec2 uv) {
        vec3 g = texture2D(t, uv).xyz;
        float disc = sqrt(max((g.y - g.x) * (g.y - g.x) + 4.0 * g.z * g.z, 0.0));
        float l1 = 0.5 * (g.y + g.x + disc), l2 = 0.5 * (g.y + g.x - disc);
        vec2 v = vec2(l1 - g.x, -g.z);
        vec2 tv = dot(v, v) > 1e-12 ? normalize(v) : vec2(0.0, 1.0);
        return vec4(tv, atan(tv.y, tv.x), l1 + l2 > 1e-8 ? (l1 - l2) / (l1 + l2) : 0.0);
    }
    // Reveal mask: 0 until the reveal passes this pixel's order ∈ [0, 1],
    // then 1, with a soft edge. reveal 0 shows nothing, 1 everything.
    float revealMask(float order, float reveal, float soft) {
        float t = reveal * (1.0 + 2.0 * soft) - soft;
        return smoothstep(order - soft, order + soft, t);
    }`;

// ── Shared passes ──────────────────────────────────────────────────────

// Scene → sRGB premultiplied, over the backdrop when there is one. The
// backdrop is sampled with CSS background-size: cover (backXform).
const PREP = /* glsl */`
    uniform sampler2D tSrc;
    uniform bool srcLinear;
    uniform int backMode;          // 0 none, 1 texture, 2 flat colour
    uniform sampler2D tBack;
    uniform vec4 backXform;
    uniform vec3 backColor;
    void main() {
        vec4 c = clamp(texture2D(tSrc, vUv), 0.0, 1.0);
        if (srcLinear) c.rgb = toSRGB(unpremul(c)) * c.a;
        if (backMode == 1) {
            vec3 b = texture2D(tBack, vUv * backXform.xy + backXform.zw).rgb;
            c = vec4(c.rgb + b * (1.0 - c.a), 1.0);
        } else if (backMode == 2) {
            c = vec4(c.rgb + backColor * (1.0 - c.a), 1.0);
        }
        gl_FragColor = c;
    }`;

// Structure tensor from the RGB Sobel derivatives (÷4), summed over the
// channels — as the Kuwahara authors' sst.glsl does.
const TENSOR = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 texel;
    vec3 at(float x, float y) { return texture2D(tSrc, vUv + texel * vec2(x, y)).rgb; }
    void main() {
        vec3 fx = (-at(-1.0, -1.0) - 2.0 * at(-1.0, 0.0) - at(-1.0, 1.0)
                   + at(1.0, -1.0) + 2.0 * at(1.0, 0.0) + at(1.0, 1.0)) / 4.0;
        vec3 fy = (-at(-1.0, -1.0) - 2.0 * at(0.0, -1.0) - at(1.0, -1.0)
                   + at(-1.0, 1.0) + 2.0 * at(0.0, 1.0) + at(1.0, 1.0)) / 4.0;
        gl_FragColor = vec4(dot(fx, fx), dot(fy, fy), dot(fx, fy), 1.0);
    }`;

// Separable Gaussian: taps out to min(ceil(extent·σ), maxR).
const GAUSS = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 dir;
    uniform float sigma;
    uniform float extent;
    uniform float maxR;
    void main() {
        vec4 sum = texture2D(tSrc, vUv);
        if (sigma < 0.05) { gl_FragColor = sum; return; }
        float norm = 1.0;
        int r = int(min(ceil(extent * sigma), maxR));
        for (int i = 1; i <= 64; i++) {
            if (i > r) break;
            float k = exp(-float(i * i) / (2.0 * sigma * sigma));
            sum += k * (texture2D(tSrc, vUv + dir * float(i)) + texture2D(tSrc, vUv - dir * float(i)));
            norm += 2.0 * k;
        }
        gl_FragColor = sum / norm;
    }`;

// Periodic surface tiles, generated once.
//   mode 1, cold-press paper: r height, gb normal (MNPR's encoding: rg − 0.5
//     is the normal's xy), a turbulence (four 1/f octaves, Bousseau).
//   mode 2, uncoated print paper: r fibre, g ink-film blotches, b grain.
// The paper's structure itself is design (procedural, no scanned asset).
const TILE_GEN = /* glsl */`
    uniform int mode;
    // Every lattice here divides the tile, so it repeats without a seam.
    float paperH(vec2 p) {
        return 0.55 * fbmP(p / 16.0, ${TILE.toFixed(1)} / 16.0, 3)
             + 0.30 * fbmP(p / 4.0, ${TILE.toFixed(1)} / 4.0, 2)
             + 0.15 * hashP(p, ${TILE.toFixed(1)});
    }
    void main() {
        vec2 p = floor(vUv * ${TILE.toFixed(1)});
        if (mode == 1) {
            float h = paperH(p);
            vec2 g = vec2(paperH(p + vec2(1.0, 0.0)) - paperH(p - vec2(1.0, 0.0)),
                          paperH(p + vec2(0.0, 1.0)) - paperH(p - vec2(0.0, 1.0)));
            vec2 n = clamp(g * 2.5, -0.5, 0.5);
            float turb = fbmP(p / 128.0, ${TILE.toFixed(1)} / 128.0, 4);
            gl_FragColor = vec4(h, n + 0.5, turb);
        } else {
            float fibre = 0.6 * fbmP(p / 4.0, ${TILE.toFixed(1)} / 4.0, 2) + 0.4 * hashP(p, ${TILE.toFixed(1)});
            float blot = fbmP(p / 32.0, ${TILE.toFixed(1)} / 32.0, 3);
            gl_FragColor = vec4(fibre, blot, hashP(p + 91.0, ${TILE.toFixed(1)}), 1.0);
        }
    }`;

// ── Oil ─────────────────────────────────────────────────────────────────

// Anisotropic Kuwahara filter with polynomial sector weights — the
// authors' akf_v3n8.glsl: the filter ellipse follows the local
// orientation, stretched by the anisotropy; the eight sector means are
// mixed by 1 / (1 + (255 Σσ)^q) over their standard deviations, so the
// flattest sector wins — edges stay crisp while regions flatten into
// strokes. Runs on premultiplied RGBA, so the silhouette is filtered too.
const AKF = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tFlow;
    uniform vec2 texel;
    uniform float radius;
    uniform float q;
    uniform float alpha;
    uniform float zeta;
    uniform float eta;
    void main() {
        vec4 f = flowAt(tFlow, vUv);
        float a = radius * clamp((alpha + f.w) / alpha, 0.1, 2.0);
        float b = radius * clamp(alpha / (alpha + f.w), 0.1, 2.0);
        float cp = cos(f.z), sp = sin(f.z);
        mat2 SR = mat2(cp / a, -sp / b, sp / a, cp / b);
        int mx = int(sqrt(a * a * cp * cp + b * b * sp * sp));
        int my = int(sqrt(a * a * sp * sp + b * b * cp * cp));
        vec4 m[8];
        vec3 s[8];
        float ws[8];
        for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); ws[k] = 0.0; }
        for (int j = -24; j <= 24; j++) {
            if (j < -my || j > my) continue;
            for (int i = -24; i <= 24; i++) {
                if (i < -mx || i > mx) continue;
                vec2 v = SR * vec2(float(i), float(j));
                float dotv = dot(v, v);
                if (dotv > 1.0) continue;
                vec4 c = texture2D(tSrc, vUv + vec2(float(i), float(j)) * texel);
                vec3 cc = c.rgb * c.rgb;
                float w[8];
                float z, vxx, vyy, sum = 0.0;
                vxx = zeta - eta * v.x * v.x;
                vyy = zeta - eta * v.y * v.y;
                z = max(0.0, v.y + vxx);  w[0] = z * z; sum += w[0];
                z = max(0.0, -v.x + vyy); w[2] = z * z; sum += w[2];
                z = max(0.0, -v.y + vxx); w[4] = z * z; sum += w[4];
                z = max(0.0, v.x + vyy);  w[6] = z * z; sum += w[6];
                v = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
                vxx = zeta - eta * v.x * v.x;
                vyy = zeta - eta * v.y * v.y;
                z = max(0.0, v.y + vxx);  w[1] = z * z; sum += w[1];
                z = max(0.0, -v.x + vyy); w[3] = z * z; sum += w[3];
                z = max(0.0, -v.y + vxx); w[5] = z * z; sum += w[5];
                z = max(0.0, v.x + vyy);  w[7] = z * z; sum += w[7];
                float g = exp(-3.125 * dotv) / max(sum, 1e-8);
                for (int k = 0; k < 8; k++) {
                    float wk = w[k] * g;
                    m[k] += c * wk;
                    s[k] += cc * wk;
                    ws[k] += wk;
                }
            }
        }
        vec4 o = vec4(0.0);
        float ow = 0.0;
        for (int k = 0; k < 8; k++) {
            if (ws[k] <= 0.0) continue;
            vec4 mean = m[k] / ws[k];
            vec3 v = abs(s[k] / ws[k] - mean.rgb * mean.rgb);
            float sigma2 = sqrt(v.r) + sqrt(v.g) + sqrt(v.b);
            float w = 1.0 / (1.0 + pow(255.0 * sigma2, q));
            o += mean * w;
            ow += w;
        }
        gl_FragColor = ow > 0.0 ? o / ow : texture2D(tSrc, vUv);
    }`;

// Paint textures: noise smoothed along the flow by a Gaussian-weighted
// line integral (σb, out to 2σb each way). x = brush (per-pixel white
// noise), y = varnish (low-frequency value noise), z = the reveal's paint
// patches (coarser value noise, same integral).
const STROKES = /* glsl */`
    uniform sampler2D tFlow;
    uniform vec2 texel;
    uniform float sigma;
    uniform float varnishCell;
    uniform float orderCell;
    vec3 sampleNoise(vec2 px) {
        return vec3(hash(px), vnoise(px / varnishCell + 7.0), vnoise(px / orderCell));
    }
    void main() {
        vec3 sum = sampleNoise(vUv / texel);
        float norm = 1.0;
        vec2 t0 = flowAt(tFlow, vUv).xy;
        int r = int(ceil(2.0 * sigma));
        for (int side = 0; side < 2; side++) {
            vec2 prev = side == 0 ? t0 : -t0;
            vec2 p = vUv;
            for (int i = 1; i <= 48; i++) {
                if (i > r) break;
                vec2 t = flowAt(tFlow, p).xy;
                if (dot(t, prev) < 0.0) t = -t;
                prev = t;
                p += t * texel;
                float k = exp(-float(i * i) / (2.0 * sigma * sigma));
                sum += k * sampleNoise(p / texel);
                norm += k;
            }
        }
        gl_FragColor = vec4(sum / norm, 1.0);
    }`;

const OIL_COMPOSE = /* glsl */`
    uniform sampler2D tPaint;
    uniform sampler2D tStrokes;
    uniform sampler2D tRaw;
    uniform vec2 workTexel;
    uniform float reveal;
    uniform bool opaque;
    uniform vec3 lightDir;
    uniform float kScale, kSpecular, kShininess;
    uniform vec2 weavePitch;       // px per thread: x warp, y weft
    uniform float weave;
    // Plain weave: each thread a rounded ridge, over-under by cell parity.
    float weaveH(vec2 fp) {
        vec2 c = fp / weavePitch;
        vec2 f = fract(c);
        bool warp = mod(floor(c.x) + floor(c.y), 2.0) < 1.0;
        return warp ? sin(PI * f.x) * (0.6 + 0.4 * sin(PI * f.y))
                    : sin(PI * f.y) * (0.6 + 0.4 * sin(PI * f.x));
    }
    void main() {
        vec4 paint = texture2D(tPaint, vUv);
        vec4 raw = texture2D(tRaw, vUv);
        vec2 dx = vec2(workTexel.x, 0.0), dy = vec2(0.0, workTexel.y);
        vec3 sx = texture2D(tStrokes, vUv + dx).xyz - texture2D(tStrokes, vUv - dx).xyz;
        vec3 sy = texture2D(tStrokes, vUv + dy).xyz - texture2D(tStrokes, vUv - dy).xyz;
        vec2 fp = gl_FragCoord.xy;
        // Below ~2 px a thread can't be drawn; let the weave fade out.
        float wv = weave * smoothstep(1.5, 2.5, min(weavePitch.x, weavePitch.y));
        vec2 gw = vec2(weaveH(fp + vec2(1.0, 0.0)) - weaveH(fp - vec2(1.0, 0.0)),
                       weaveH(fp + vec2(0.0, 1.0)) - weaveH(fp - vec2(0.0, 1.0))) * 0.5 * wv;
        vec3 l = normalize(lightDir);
        vec3 nb = normalize(vec3(-kScale * (0.5 * vec2(sx.x, sy.x)) - kScale * gw, 1.0));
        vec3 nv = normalize(vec3(-kScale * (0.5 * vec2(sx.y, sy.y)), 1.0));
        float TB = 0.5 + dot(nb, l);
        float TV = kSpecular * pow(max(dot(nv, l), 0.0), kShininess);
        vec3 col = clamp(unpremul(paint) * TB + TV, 0.0, 1.0);
        vec4 painted = vec4(col, 1.0) * (opaque ? 1.0 : paint.a);
        float order = clamp((texture2D(tStrokes, vUv).z - 0.5) * 3.0 + 0.5, 0.0, 1.0);
        gl_FragColor = mix(raw, painted, revealMask(order, reveal, 0.08));
    }`;

// ── Watercolour ─────────────────────────────────────────────────────────

// MNPR's DoG edge detection (quadEdgeDetection dogRGBDFrag): pixel minus
// its σ = 1 Gaussian, per channel, clamped; the fourth channel is depth ×3
// there — here the characters' coverage stands in for depth. Magnitudes
// over 0.05 count as a full edge.
const WC_EDGES = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tFig;
    uniform vec2 texel;
    vec4 rgbd(vec2 o) {
        vec2 uv = vUv + o * texel;
        return vec4(texture2D(tSrc, uv).rgb, texture2D(tFig, uv).a);
    }
    void main() {
        vec4 g = 0.077847 * (rgbd(vec2(-1.0, -1.0)) + rgbd(vec2(1.0, -1.0)) + rgbd(vec2(-1.0, 1.0)) + rgbd(vec2(1.0, 1.0)))
               + 0.123317 * (rgbd(vec2(0.0, -1.0)) + rgbd(vec2(-1.0, 0.0)) + rgbd(vec2(1.0, 0.0)) + rgbd(vec2(0.0, 1.0)))
               + 0.195346 * rgbd(vec2(0.0));
        vec4 dog = clamp(rgbd(vec2(0.0)) - g, 0.0, 1.0);
        dog.a *= 3.0;
        float e = length(dog);
        if (e > 0.05) e = 1.0;
        gl_FragColor = vec4(e, e, e, 1.0);
    }`;

const WC_COMPOSE = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tEdge;
    uniform sampler2D tPaper;
    uniform vec2 fullTexel;
    uniform vec2 aspect;
    uniform float reveal;
    uniform bool opaque;
    uniform float edgeIntensity, pigmentDensity, distortionPx, substrateShading, turbulence;
    uniform vec3 substrateLight;
    uniform vec3 substrateColor;
    void main() {
        vec4 paper = texture2D(tPaper, gl_FragCoord.xy / ${TILE.toFixed(1)});
        vec2 nrm = paper.gb - 0.5;
        float turb = texture2D(tPaper, gl_FragCoord.xy / (${TILE.toFixed(1)} * 2.0)).a;
        // Substrate distortion: the paper's normal pushes the painting by
        // up to distortionPx.
        vec2 uv = vUv + nrm * 2.0 * distortionPx * fullTexel;
        vec4 src = texture2D(tSrc, uv);
        vec4 raw = texture2D(tSrc, vUv);
        vec3 c = unpremul(src);
        // Turbulent flow (pigment density, Bousseau's colour model).
        float d = 1.0 + turbulence * (turb - 0.5);
        c = c - (c - c * c) * (d - 1.0);
        // Wet front of the reveal: pigment pooled into a tide line.
        vec2 dd = (vUv - vec2(0.5, 0.55)) * aspect;
        float order = clamp(length(dd) / length(0.55 * aspect) * 0.8 + 0.2 * turb, 0.0, 1.0);
        float t = reveal * 1.16 - 0.08;
        float tide = exp(-pow((order - t) / 0.03, 2.0)) * (1.0 - smoothstep(0.8, 1.0, reveal));
        // Edge darkening (gradientEdgesWC): density 1 + blurred edge, off
        // where the colour is the paper's.
        float dEdge = (texture2D(tEdge, uv).r + tide) * edgeIntensity;
        dEdge *= clamp(length(c - substrateColor) * 5.0, 0.0, 1.0);
        c = pow(max(c, 0.0), vec3(1.0 + dEdge));
        // Pigment application (pigmentApplicationWC): granulation settles
        // in the paper's valleys, more in lighter washes.
        float application = mix(0.2, 1.0, luma(c));
        float heightMap = paper.r * 0.2 + 0.8;
        c = pow(max(c, 0.0), vec3(1.0 + pigmentDensity * application * (1.0 - heightMap)));
        // Substrate lighting (deferredLighting), gamma-corrected as MNPR
        // does when the target is display-encoded.
        float diffuse = dot(vec3(-nrm, 1.0), substrateLight);
        diffuse = 1.0 - pow(1.0 - diffuse, 2.0) * substrateShading;
        c *= pow(max(diffuse, 0.0), 1.0 / 2.2);
        vec4 painted = vec4(clamp(c, 0.0, 1.0), 1.0) * (opaque ? 1.0 : src.a);
        gl_FragColor = mix(raw, painted, revealMask(order, reveal, 0.03));
    }`;

// ── Ink ─────────────────────────────────────────────────────────────────

// XDoG, step 1: a 1-D difference of Gaussians across the edge (along the
// gradient), D = G_σe − τ·G_kσe, on CIE L* (0–100) from linear light. The
// see-through mascot has no backdrop to draw against, so its characters
// are read over a mid grey: every silhouette then has an edge to ink.
const FDOG_ACROSS = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tFlow;
    uniform vec2 texel;
    uniform float sigmaE;
    uniform float k;
    uniform float tau;
    uniform float grey;
    float lstar(vec2 uv) {
        vec4 c = texture2D(tSrc, uv);
        float Y = luma(toLinear(c.rgb + grey * (1.0 - c.a)));
        return 116.0 * (Y > 0.008856 ? pow(Y, 1.0 / 3.0) : 7.787 * Y + 16.0 / 116.0) - 16.0;
    }
    void main() {
        vec2 t = flowAt(tFlow, vUv).xy;
        vec2 n = vec2(t.y, -t.x);
        vec2 na = abs(n);
        float ds = 1.0 / max(max(na.x, na.y), 1e-3);
        vec2 stepUv = n * texel;
        float sR = k * sigmaE;
        float s0 = lstar(vUv);
        float sumE = s0, sumR = s0, normE = 1.0, normR = 1.0;
        for (int i = 1; i <= 32; i++) {
            float d = float(i) * ds;
            if (d >= 2.0 * sR) break;
            float kE = exp(-d * d / (2.0 * sigmaE * sigmaE));
            float kR = exp(-d * d / (2.0 * sR * sR));
            float L = lstar(vUv - d * stepUv) + lstar(vUv + d * stepUv);
            sumE += kE * L; normE += 2.0 * kE;
            sumR += kR * L; normR += 2.0 * kR;
        }
        gl_FragColor = vec4(sumE / normE - tau * (sumR / normR), 0.0, 0.0, 1.0);
    }`;

// Step 2: a Gaussian line integral along the flow (σ out to 2σ each way).
// With `threshold` (σm) it ends in XDoG's soft threshold — 1 above ε,
// 1 + tanh(φ(D − ε)) below; without (σa) it only smooths, which is the
// XDoG anti-aliasing pass.
const FLOW_SMOOTH = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tFlow;
    uniform vec2 texel;
    uniform float sigma;
    uniform bool threshold;
    uniform float epsilon;
    uniform float phi;
    void main() {
        float H = texture2D(tSrc, vUv).x;
        float w = 1.0;
        vec2 t0 = flowAt(tFlow, vUv).xy;
        for (int side = 0; side < 2; side++) {
            vec2 prev = side == 0 ? t0 : -t0;
            vec2 p = vUv;
            for (int i = 1; i <= 32; i++) {
                float d = float(i);
                if (d >= 2.0 * sigma) break;
                vec2 t = flowAt(tFlow, p).xy;
                if (dot(t, prev) < 0.0) t = -t;
                prev = t;
                p += t * texel;
                float kk = exp(-d * d / (2.0 * sigma * sigma));
                H += kk * texture2D(tSrc, p).x;
                w += kk;
            }
        }
        H /= w;
        if (threshold) H = H >= epsilon ? 1.0 : 1.0 + tanh(phi * (H - epsilon));
        gl_FragColor = vec4(H, 0.0, 0.0, 1.0);
    }`;

// XDoG's tone (1 = paper) → the nearest tone sheet: paper, a screentone
// of one of the catalogue densities, or solid black (lines and fills).
const INK_COMPOSE = /* glsl */`
    uniform sampler2D tLines;
    uniform sampler2D tRaw;
    uniform float reveal;
    uniform bool opaque;
    uniform float boilPx, boilSeed, pitch, angle;
    uniform vec3 tones;
    uniform vec3 inkColor, paperColor;
    uniform vec2 fullTexel;
    // Screentone: round dots on a grid at the tone angle.
    float dots(vec2 fp, float cov) {
        float ca = cos(angle), sa = sin(angle);
        vec2 q = mat2(ca, -sa, sa, ca) * fp / pitch;
        float r = sqrt(cov / PI), aa = 0.7 / pitch;
        return 1.0 - smoothstep(r - aa, r + aa, length(fract(q) - 0.5));
    }
    void main() {
        vec2 fp = gl_FragCoord.xy;
        // Line boil: the drawing wobbles by a fraction of a pixel, redrawn
        // on twos.
        vec2 wob = vec2(vnoise(fp / 40.0 + boilSeed), vnoise(fp / 40.0 + boilSeed + 19.7)) - 0.5;
        float x = 1.0 - texture2D(tLines, vUv + wob * 2.0 * boilPx * fullTexel).x;
        vec4 raw = texture2D(tRaw, vUv);
        // Nearest sheet: 0, the three tones, or black (midpoints between).
        float sheet = x < 0.5 * tones.x ? 0.0
            : x < 0.5 * (tones.x + tones.y) ? tones.x
            : x < 0.5 * (tones.y + tones.z) ? tones.y
            : x < 0.5 * (tones.z + 1.0) ? tones.z : 1.0;
        bool solid = sheet >= 1.0;
        float order = vnoise(fp / 90.0) * 0.7 + vnoise(fp / 23.0) * 0.3;
        float lineShow = revealMask(order, clamp(reveal / 0.6, 0.0, 1.0), 0.05);
        float toneShow = revealMask(order, clamp((reveal - 0.45) / 0.55, 0.0, 1.0), 0.05);
        float inkAmt = solid ? lineShow : sheet > 0.0 ? dots(fp, sheet) * toneShow : 0.0;
        // Off the characters (see-through host) only solid ink remains —
        // the outline they were read against.
        float a = opaque ? 1.0 : max(raw.a, solid ? lineShow : 0.0);
        if (!opaque && raw.a < 0.5 && !solid) inkAmt = 0.0;
        vec4 inked = vec4(mix(paperColor, inkColor, inkAmt) * a, a);
        // Under the pen the plain frame fades to the blank page first.
        float blank = smoothstep(0.0, 0.25, reveal);
        vec4 page = opaque ? vec4(paperColor, 1.0) : vec4(paperColor * raw.a, raw.a);
        vec4 under = mix(raw, page, blank);
        gl_FragColor = mix(under, inked, max(solid ? lineShow : toneShow, blank));
    }`;

// ── Riso ────────────────────────────────────────────────────────────────

// Separation: the three ink coverages whose Demichel-weighted Neugebauer
// primaries (paper, each ink, each overprint — transmittances multiply)
// best reproduce the pixel in linear light. Starts from the Beer–Lambert
// density solve, then Gauss–Newton steps, clamped to [0, 1].
const RISO_SEP = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec3 inkT0, inkT1, inkT2;     // ink transmittance relative to paper, linear
    uniform mat3 densInv;                 // inverse of the ink density matrix
    uniform vec3 paperLin;
    vec3 predict(vec3 c) {
        vec3 R = vec3(0.0);
        for (int s = 0; s < 8; s++) {
            float w = 1.0;
            vec3 T = vec3(1.0);
            if ((s & 1) != 0) { w *= c.x; T *= inkT0; } else { w *= 1.0 - c.x; }
            if ((s & 2) != 0) { w *= c.y; T *= inkT1; } else { w *= 1.0 - c.y; }
            if ((s & 4) != 0) { w *= c.z; T *= inkT2; } else { w *= 1.0 - c.z; }
            R += w * T;
        }
        return R;
    }
    void main() {
        vec4 src = texture2D(tSrc, vUv);
        vec3 target = clamp(toLinear(unpremul(src)) / paperLin, 0.002, 1.0);
        vec3 c = clamp(densInv * -log(target), 0.0, 1.0);
        for (int it = 0; it < 5; it++) {
            vec3 p0 = predict(c);
            vec3 r = target - p0;
            const float h = 1e-3;
            mat3 J = mat3((predict(c + vec3(h, 0.0, 0.0)) - p0) / h,
                          (predict(c + vec3(0.0, h, 0.0)) - p0) / h,
                          (predict(c + vec3(0.0, 0.0, h)) - p0) / h);
            if (abs(determinant(J)) < 1e-7) break;
            c = clamp(c + inverse(J) * r, 0.0, 1.0);
        }
        gl_FragColor = vec4(c, src.a);
    }`;

const RISO_COMPOSE = /* glsl */`
    uniform sampler2D tSep;
    uniform sampler2D tRaw;
    uniform sampler2D tPaper;
    uniform float reveal;
    uniform bool opaque;
    uniform vec3 ink0, ink1, ink2;        // linear
    uniform vec3 paperLin;
    uniform vec3 angles;
    uniform float pitch;
    uniform vec2 misreg0, misreg1, misreg2;   // full-res px
    uniform vec2 fullTexel;
    // AM screen: round ink dots to 50%, then solid ink with paper dots.
    float screen(vec2 fp, float angle, float cov) {
        float ca = cos(angle), sa = sin(angle);
        vec2 q = mat2(ca, -sa, sa, ca) * fp / pitch;
        float aa = 0.8 / pitch;
        if (cov <= 0.5) {
            float r = sqrt(cov / PI);
            return 1.0 - smoothstep(r - aa, r + aa, length(fract(q) - 0.5));
        }
        float r = sqrt((1.0 - cov) / PI);
        return smoothstep(r - aa, r + aa, length(fract(q + 0.5) - 0.5));
    }
    // Each drum passes the sheet top to bottom in turn.
    float drum(float i, float top) {
        float p = clamp(reveal * 3.4 - i * 1.1 - 0.12, 0.0, 1.0);
        return smoothstep(top - 0.03, top + 0.03, p * 1.06);
    }
    void main() {
        vec2 fp = gl_FragCoord.xy;
        vec4 paper = texture2D(tPaper, fp / ${TILE.toFixed(1)});
        float top = 1.0 - vUv.y;
        float c0 = texture2D(tSep, vUv + misreg0 * fullTexel).x;
        float c1 = texture2D(tSep, vUv + misreg1 * fullTexel).y;
        float c2 = texture2D(tSep, vUv + misreg2 * fullTexel).z;
        float m0 = screen(fp, angles.x, c0) * drum(0.0, top);
        float m1 = screen(fp, angles.y, c1) * drum(1.0, top);
        float m2 = screen(fp, angles.z, c2) * drum(2.0, top);
        // Drum ink never lays down a perfectly even film (design amount).
        float film = 0.92 + 0.08 * paper.g;
        vec3 lin = paperLin * (0.965 + 0.035 * paper.r);
        lin *= 1.0 - m0 * film * (1.0 - ink0);
        lin *= 1.0 - m1 * film * (1.0 - ink1);
        lin *= 1.0 - m2 * film * (1.0 - ink2);
        vec4 raw = texture2D(tRaw, vUv);
        float a = opaque ? 1.0 : texture2D(tSep, vUv).a;
        vec4 printed = vec4(toSRGB(lin) * a, a);
        gl_FragColor = mix(raw, printed, smoothstep(0.0, 0.12, reveal));
    }`;

// ── Pixel ───────────────────────────────────────────────────────────────

// Box-filter the working frame down to the virtual screen: straight colour
// of the composite + the characters' coverage.
const PX_DOWN = /* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tFig;
    uniform vec2 srcTexel;
    uniform float cell;
    void main() {
        int n = int(ceil(cell));
        vec4 sum = vec4(0.0);
        float fig = 0.0, cnt = 0.0;
        for (int j = 0; j < 12; j++) {
            if (j >= n) break;
            for (int i = 0; i < 12; i++) {
                if (i >= n) break;
                vec2 o = (vec2(float(i), float(j)) + 0.5 - float(n) * 0.5) * cell / float(n);
                vec2 uv = vUv + o * srcTexel;
                sum += texture2D(tSrc, uv);
                fig += texture2D(tFig, uv).a;
                cnt += 1.0;
            }
        }
        sum /= cnt;
        gl_FragColor = vec4(unpremul(sum), fig / cnt);
    }`;

// Ordered dithering into the palette, in OKLab (Ottosson 2020), after
// Yliluoma's arbitrary-palette positional dithering: the nearest colour is
// paired with the partner whose best mix lands closest to the target, the
// pair's own distance penalised by 0.1 × (|ratio − ½| + ½) as in his
// algorithm 1 — so a skin tone dithers with skin tones, not with a grey
// that happens to be near. The Bayer threshold picks each pixel's side.
// Matching weighs OKLab's chroma axes double (design): a pixel artist
// keeps the hue and gives up lightness first, and a palette's gaps (no
// dusky mid pinks in Resurrect 64) should fall to a warmer or cooler
// neighbour, never to a grey of the right lightness.
const PX_CHROMA_WEIGHT = 2;
const PX_QUANT = /* glsl */`
    #define CHROMA_WEIGHT ${PX_CHROMA_WEIGHT.toFixed(1)}
    uniform sampler2D tSrc;
    uniform vec2 texel;
    uniform vec3 pal[64];
    uniform vec3 palSRGB[64];
    uniform int palN;
    uniform bool opaque;
    vec3 oklab(vec3 c) {
        float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
        float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
        float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
        l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
        return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
    }
    float bayer4(ivec2 p) {
        int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
        return (float(m[(p.y & 3) * 4 + (p.x & 3)]) + 0.5) / 16.0;
    }
    void main() {
        vec4 d = texture2D(tSrc, vUv);
        vec3 lab = oklab(toLinear(d.rgb)) * vec3(1.0, CHROMA_WEIGHT, CHROMA_WEIGHT);
        bool inside = d.a >= 0.5;
        bool edge = inside && (texture2D(tSrc, vUv + vec2(texel.x, 0.0)).a < 0.5
            || texture2D(tSrc, vUv - vec2(texel.x, 0.0)).a < 0.5
            || texture2D(tSrc, vUv + vec2(0.0, texel.y)).a < 0.5
            || texture2D(tSrc, vUv - vec2(0.0, texel.y)).a < 0.5);
        // Selective outline: the rim takes a darker shade of its own colour.
        if (edge) lab.x *= 0.5;
        int i1 = 0;
        float d1 = 1e9;
        for (int i = 0; i < 64; i++) {
            if (i >= palN) break;
            vec3 e = lab - pal[i];
            float dd = dot(e, e);
            if (dd < d1) { d1 = dd; i1 = i; }
        }
        int i2 = i1;
        float t = 0.0, best = d1;
        for (int i = 0; i < 64; i++) {
            if (i >= palN) break;
            vec3 seg = pal[i] - pal[i1];
            float len2 = dot(seg, seg);
            if (len2 <= 0.0) continue;
            float r = floor(clamp(dot(lab - pal[i1], seg) / len2, 0.0, 1.0) * 16.0 + 0.5) / 16.0;
            vec3 e = lab - (pal[i1] + r * seg);
            float err = dot(e, e) + 0.1 * len2 * (abs(r - 0.5) + 0.5);
            if (err < best) { best = err; i2 = i; t = r; }
        }
        int pick = !edge && bayer4(ivec2(gl_FragCoord.xy)) < t ? i2 : i1;
        gl_FragColor = vec4(palSRGB[pick], opaque || inside ? 1.0 : 0.0);
    }`;

const PX_COMPOSE = /* glsl */`
    uniform sampler2D tQ;
    uniform sampler2D tRaw;
    uniform float scale;
    uniform float reveal;
    void main() {
        ivec2 size = textureSize(tQ, 0);
        ivec2 ip = ivec2(gl_FragCoord.xy / scale);
        // Mosaic resolve: 32 → 1 virtual pixels as the reveal runs.
        int block = int(exp2(floor((1.0 - reveal) * 5.999)));
        ivec2 bp = (ip / block) * block + block / 2;
        vec4 q = texelFetch(tQ, clamp(bp, ivec2(0), size - 1), 0);
        gl_FragColor = mix(texture2D(tRaw, vUv), vec4(q.rgb * q.a, q.a), smoothstep(0.0, 0.08, reveal));
    }`;

// name → [fragment shader, uniform names]. Uniform values are set per pass.
const SHADERS = {
    prep: [PREP, ["tSrc", "srcLinear", "backMode", "tBack", "backXform", "backColor"]],
    tensor: [TENSOR, ["tSrc", "texel"]],
    gauss: [GAUSS, ["tSrc", "dir", "sigma", "extent", "maxR"]],
    tile: [TILE_GEN, ["mode"]],
    akf: [AKF, ["tSrc", "tFlow", "texel", "radius", "q", "alpha", "zeta", "eta"]],
    strokes: [STROKES, ["tFlow", "texel", "sigma", "varnishCell", "orderCell"]],
    oilCompose: [OIL_COMPOSE, ["tPaint", "tStrokes", "tRaw", "workTexel", "reveal", "opaque", "lightDir",
        "kScale", "kSpecular", "kShininess", "weavePitch", "weave"]],
    wcEdges: [WC_EDGES, ["tSrc", "tFig", "texel"]],
    wcCompose: [WC_COMPOSE, ["tSrc", "tEdge", "tPaper", "fullTexel", "aspect", "reveal", "opaque", "edgeIntensity",
        "pigmentDensity", "distortionPx", "substrateShading", "turbulence", "substrateLight", "substrateColor"]],
    fdogAcross: [FDOG_ACROSS, ["tSrc", "tFlow", "texel", "sigmaE", "k", "tau", "grey"]],
    flowSmooth: [FLOW_SMOOTH, ["tSrc", "tFlow", "texel", "sigma", "threshold", "epsilon", "phi"]],
    inkCompose: [INK_COMPOSE, ["tLines", "tRaw", "reveal", "opaque", "boilPx", "boilSeed", "pitch", "angle",
        "tones", "inkColor", "paperColor", "fullTexel"]],
    risoSep: [RISO_SEP, ["tSrc", "inkT0", "inkT1", "inkT2", "densInv", "paperLin"]],
    risoCompose: [RISO_COMPOSE, ["tSep", "tRaw", "tPaper", "reveal", "opaque", "ink0", "ink1", "ink2", "paperLin",
        "angles", "pitch", "misreg0", "misreg1", "misreg2", "fullTexel"]],
    pxDown: [PX_DOWN, ["tSrc", "tFig", "srcTexel", "cell"]],
    pxQuant: [PX_QUANT, ["tSrc", "texel", "pal", "palSRGB", "palN", "opaque"]],
    pxCompose: [PX_COMPOSE, ["tQ", "tRaw", "scale", "reveal"]],
};

export class ArtStyle {
    constructor(THREE, renderer) {
        this.THREE = THREE;
        this.renderer = renderer;
        const ext = renderer.extensions;
        this._type = (ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"))
            ? THREE.HalfFloatType : THREE.UnsignedByteType;
        this._quad = new FullScreenQuad(null);
        this._mats = new Map();
        this._targets = new Map();
        this._tiles = new Map();
        this._size = new THREE.Vector2();
        this._style = null;        // style on screen (showing, revealing or fading)
        this._want = "off";        // the pick to end up on
        this._phase = "idle";      // in | on | out | idle
        this._t0 = 0;
        this._print = null;        // per-reveal randomness: boil seed, riso misregistration
        this._back = { source: null, texture: null };
    }

    /** True while a style shows, reveals or fades out. */
    get active() {
        return !!this._style;
    }

    /** Switch to an ART_STYLES id or 'off'. The current style (if any)
     *  un-paints first, from however far it had got. */
    set(id) {
        id = ART_STYLES[id] ? id : "off";
        this._want = id;
        const now = performance.now();
        if (!this._style) {
            if (id !== "off") this._begin(id, now, 0);
            return;
        }
        const p = this._progress(now);
        if (id === this._style) {
            if (this._phase === "out") this._begin(id, now, p);
            return;
        }
        if (this._phase !== "out") {
            this._phase = "out";
            this._t0 = now - (1 - p) * REVEAL_OUT_MS;
        }
    }

    _begin(id, now, from) {
        this._style = id;
        this._phase = "in";
        this._t0 = now - from * REVEAL_IN_MS;
        // A fresh print each time: riso drums land a little out of
        // register in a new direction; the ink boil starts elsewhere.
        const shift = () => [Math.random() * Math.PI * 2, Math.random()];   // direction, share of the max
        this._print = { seed: Math.random() * 1000, misreg: [shift(), shift(), shift()] };
    }

    /** How much of the style is laid down, 0..1. */
    _progress(now) {
        if (this._phase === "in") return Math.min(1, (now - this._t0) / REVEAL_IN_MS);
        if (this._phase === "out") return Math.max(0, 1 - (now - this._t0) / REVEAL_OUT_MS);
        return 1;
    }

    _advance(now) {
        if (!this._style) return null;
        let p = this._progress(now);
        if (this._phase === "in" && p >= 1) this._phase = "on";
        if (this._phase === "out" && p <= 0) {
            if (this._want === "off") {
                this._style = null;
                this._phase = "idle";
                return null;
            }
            this._begin(this._want, now, 0);
            p = 0;
        }
        return p;
    }

    _mat(name) {
        let m = this._mats.get(name);
        if (m) return m;
        const [frag, names] = SHADERS[name];
        const uniforms = Object.fromEntries(names.map((n) => [n, { value: null }]));
        m = new this.THREE.ShaderMaterial({
            uniforms, vertexShader: VERTEX, fragmentShader: COMMON + frag,
            depthTest: false, depthWrite: false, blending: this.THREE.NoBlending,
        });
        this._mats.set(name, m);
        return m;
    }

    /** Draw a full-screen pass. Array uniform values become vectors or
     *  matrices by length (2/3/4 → Vector, 9 → Matrix3); `pal*` arrays of
     *  triples stay arrays of Vector3. */
    _pass(name, target, values) {
        const T = this.THREE;
        const m = this._mat(name);
        for (const [k, v] of Object.entries(values)) {
            const u = m.uniforms[k];
            if (!u) continue;
            if (Array.isArray(v) && Array.isArray(v[0])) {
                if (u.source !== v) {
                    u.value = v.map((x) => new T.Vector3(...x));
                    u.source = v;
                }
            } else if (Array.isArray(v)) {
                if (!u.value) {
                    u.value = v.length === 2 ? new T.Vector2() : v.length === 3 ? new T.Vector3()
                        : v.length === 4 ? new T.Vector4() : new T.Matrix3();
                }
                u.value.fromArray(v);
            } else {
                u.value = v?.isWebGLRenderTarget ? v.texture : v;
            }
        }
        this._quad.material = m;
        this.renderer.setRenderTarget(target);
        this._quad.render(this.renderer);
    }

    _rt(name, w, h, { depth = false, samples = 0, nearest = false } = {}) {
        let t = this._targets.get(name);
        if (!t) {
            const T = this.THREE;
            const filter = nearest ? T.NearestFilter : T.LinearFilter;
            t = new T.WebGLRenderTarget(w, h, {
                type: this._type, depthBuffer: depth, samples, minFilter: filter, magFilter: filter,
            });
            this._targets.set(name, t);
        } else if (t.width !== w || t.height !== h) {
            t.setSize(w, h);
        }
        return t;
    }

    _tile(mode) {
        let t = this._tiles.get(mode);
        if (t) return t;
        const T = this.THREE;
        t = new T.WebGLRenderTarget(TILE, TILE, {
            type: T.UnsignedByteType, depthBuffer: false, wrapS: T.RepeatWrapping, wrapT: T.RepeatWrapping,
            minFilter: T.LinearFilter, magFilter: T.LinearFilter,
        });
        this._pass("tile", t, { mode });
        this._tiles.set(mode, t);
        return t;
    }

    /** Separable Gaussian of `src` into `dst` (through `tmp`; dst may be src). */
    _gauss(src, tmp, sigma, { extent = 2, maxR = 64, dst = src } = {}) {
        this._pass("gauss", tmp, { tSrc: src, dir: [1 / src.width, 0], sigma, extent, maxR });
        this._pass("gauss", dst, { tSrc: tmp, dir: [0, 1 / src.height], sigma, extent, maxR });
    }

    /** The prepped frame's structure tensor ("t0"), smoothed by σ into
     *  target `name`. Call with the same ctx to smooth it at other scales. */
    _flow(ctx, sigma, { extent = 2, name = "t1" } = {}) {
        const t0 = this._rt("t0", ctx.ww, ctx.wh);
        if (ctx.tensorOf !== ctx.prep) {
            this._pass("tensor", t0, { tSrc: ctx.prep, texel: ctx.texel });
            ctx.tensorOf = ctx.prep;
        }
        const out = this._rt(name, ctx.ww, ctx.wh);
        this._gauss(t0, this._rt("t2", ctx.ww, ctx.wh), sigma * ctx.ks, { extent, dst: out });
        return out;
    }

    /** Uniforms for the prep pass's backdrop: a texture sampled with
     *  cover semantics, a flat colour, or nothing. */
    _backdropUniforms(bd, fw, fh) {
        if (!bd) return { backMode: 0 };
        if (bd.source && bd.width && bd.height) {
            if (this._back.source !== bd.source) {
                const T = this.THREE;
                this._back.texture?.dispose();
                const tex = bd.source.tagName === "VIDEO" ? new T.VideoTexture(bd.source) : new T.Texture(bd.source);
                tex.colorSpace = T.NoColorSpace;   // sample the sRGB values as they are
                tex.minFilter = T.LinearFilter;
                tex.generateMipmaps = false;
                tex.needsUpdate = true;
                this._back = { source: bd.source, texture: tex };
            }
            const s = Math.max(fw / bd.width, fh / bd.height);
            const fx = fw / (bd.width * s), fy = fh / (bd.height * s);
            return { backMode: 1, tBack: this._back.texture, backXform: [fx, fy, (1 - fx) / 2, (1 - fy) / 2] };
        }
        const color = parseCssColor(bd.color);
        return color ? { backMode: 2, backColor: color } : { backMode: 0 };
    }

    /** Render the frame through the current style onto the canvas. False
     *  when nothing is showing (the caller then draws plainly). */
    render(scene, camera, { look = null, backdrop = null } = {}) {
        const now = performance.now();
        const p = this._advance(now);
        if (p === null) {
            this._releaseTargets();
            return false;
        }
        const r = this.renderer;
        const P = STYLE_PARAMS[this._style];
        const full = r.getDrawingBufferSize(this._size);
        const fw = Math.max(1, full.x), fh = Math.max(1, full.y);
        const wh = Math.min(fh, P.maxLines);
        const ww = Math.max(1, Math.round((fw * wh) / fh));
        const src = this._rt("src", ww, wh, { depth: true, samples: 4 });
        if (look) {
            look.render(scene, camera, src);
        } else {
            r.setRenderTarget(src);
            r.render(scene, camera);
        }
        const prep = this._rt("prep", ww, wh);
        const back = this._backdropUniforms(backdrop, fw, fh);
        this._pass("prep", prep, {
            tSrc: src, srcLinear: !look, tBack: null, backXform: [1, 1, 0, 0], backColor: [0, 0, 0], ...back,
        });
        const ctx = {
            P, now, src, prep, ww, wh, fw, fh,
            ks: wh / REF_LINES,
            texel: [1 / ww, 1 / wh],
            fullTexel: [1 / fw, 1 / fh],
            opaque: back.backMode !== 0,
            reveal: easeInOutCubic(p),
        };
        this[`_${this._style}`](ctx);
        r.setRenderTarget(null);
        return true;
    }

    _oil(ctx) {
        const { P, ks, ww, wh, texel } = ctx;
        const flow = this._flow(ctx, P.sigmaT);
        const paint = this._rt("a", ww, wh);
        this._pass("akf", paint, {
            tSrc: ctx.prep, tFlow: flow, texel,
            radius: P.radius * ks, q: P.q, alpha: P.alpha, zeta: P.zeta, eta: P.eta,
        });
        const strokeFlow = this._flow(ctx, P.sigmaFlow, { name: "t3" });
        const strokes = this._rt("b", ww, wh);
        this._pass("strokes", strokes, {
            tFlow: strokeFlow, texel, sigma: P.sigmaB * ks,
            varnishCell: Math.max(1, P.varnishCell * ks), orderCell: P.orderCell * ks,
        });
        const el = (P.lightElevationDeg * Math.PI) / 180, az = (P.lightAzimuthDeg * Math.PI) / 180;
        const perCmPx = ctx.fh / P.canvasCm;
        this._pass("oilCompose", null, {
            tPaint: paint, tStrokes: strokes, tRaw: ctx.prep, workTexel: texel,
            reveal: ctx.reveal, opaque: ctx.opaque,
            lightDir: [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)],
            kScale: P.kScale * P.heightScale, kSpecular: P.kSpecular, kShininess: P.kShininess,
            weavePitch: [perCmPx / P.warpPerCm, perCmPx / P.weftPerCm], weave: P.weave,
        });
    }

    _watercolour(ctx) {
        const { P, ks, ww, wh, texel } = ctx;
        const edges = this._rt("a", ww, wh);
        this._pass("wcEdges", edges, { tSrc: ctx.prep, tFig: ctx.src, texel });
        // MNPR's edge blur: σ = width / 2, taps while o < width.
        const width = Math.max(1, P.edgeWidth * ks);
        this._gauss(edges, this._rt("b", ww, wh), width / 2, { extent: 64, maxR: Math.max(0, Math.ceil(width) - 1) });
        // MNPR's light vector is (sin dir, cos dir, tilt / 89) with the
        // default dir 180°; which way that points on screen depends on
        // Maya's texture orientation, so the light comes from the top here.
        const tilt = P.substrateTiltDeg / 89;
        this._pass("wcCompose", null, {
            tSrc: ctx.prep, tEdge: edges, tPaper: this._tile(1), fullTexel: ctx.fullTexel,
            aspect: [ctx.fw / ctx.fh, 1], reveal: ctx.reveal, opaque: ctx.opaque,
            edgeIntensity: P.edgeIntensity, pigmentDensity: P.pigmentDensity, distortionPx: P.distortionPx,
            substrateShading: P.substrateShading, turbulence: P.turbulence,
            substrateLight: [0, 1, tilt], substrateColor: P.substrateColor,
        });
    }

    _ink(ctx) {
        const { P, ks, ww, wh, texel } = ctx;
        // XDoG's appendix: the structure tensor blur reaches 2.45σc.
        const flow = this._flow(ctx, P.sigmaC, 2.45);
        const dog = this._rt("a", ww, wh);
        this._pass("fdogAcross", dog, {
            tSrc: ctx.prep, tFlow: flow, texel, sigmaE: P.sigmaE * ks, k: P.k, tau: P.tau, grey: P.outlineGrey,
        });
        const xdog = this._rt("b", ww, wh);
        this._pass("flowSmooth", xdog, {
            tSrc: dog, tFlow: flow, texel, sigma: P.sigmaM * ks, threshold: true, epsilon: P.epsilon, phi: P.phi,
        });
        this._pass("flowSmooth", dog, { tSrc: xdog, tFlow: flow, texel, sigma: P.sigmaA * ks, threshold: false });
        const onTwos = Math.floor((ctx.now / 1000) * P.boilHz);
        this._pass("inkCompose", null, {
            tLines: dog, tRaw: ctx.prep, reveal: ctx.reveal, opaque: ctx.opaque,
            boilPx: P.boilPx * ctx.fh / 1080, boilSeed: this._print.seed + onTwos * 7.31,
            pitch: Math.max(3, P.tonePitchPx * ctx.fh / 1080), angle: (P.toneAngle * Math.PI) / 180,
            tones: P.tones, inkColor: P.ink, paperColor: P.paper, fullTexel: ctx.fullTexel,
        });
    }

    _riso(ctx) {
        const { P, ww, wh } = ctx;
        const inks = (this._risoInks ||= this._risoSetup(P));
        const sep = this._rt("a", ww, wh);
        this._pass("risoSep", sep, {
            tSrc: ctx.prep, inkT0: inks.T[0], inkT1: inks.T[1], inkT2: inks.T[2],
            densInv: inks.densInv, paperLin: inks.paper,
        });
        // Physical scale: the sheet fills the frame's height.
        const pxPerMm = ctx.fh / P.sheetMm;
        const pitch = Math.max(3, (25.4 / P.lpi) * pxPerMm);
        const off = ([a, m]) => [Math.cos(a) * m * P.misregMm * pxPerMm, Math.sin(a) * m * P.misregMm * pxPerMm];
        const [a0, a1, a2] = this._print.misreg;
        const deg = (d) => (d * Math.PI) / 180;
        this._pass("risoCompose", null, {
            tSep: sep, tRaw: ctx.prep, tPaper: this._tile(2), reveal: ctx.reveal, opaque: ctx.opaque,
            ink0: inks.lin[0], ink1: inks.lin[1], ink2: inks.lin[2], paperLin: inks.paper,
            angles: P.angles.map(deg), pitch,
            misreg0: off(a0), misreg1: off(a1), misreg2: off(a2), fullTexel: ctx.fullTexel,
        });
    }

    /** Ink transmittances relative to the paper (linear light) and the
     *  inverse density matrix for the separation's first guess. */
    _risoSetup(P) {
        const lin = (hex) => hexToRgb(hex).map(srgbToLinear);
        const paper = lin(P.paper);
        const inkLin = P.inks.map(lin);
        const T = inkLin.map((c) => c.map((v, i) => Math.min(1, v / paper[i])));
        const D = new this.THREE.Matrix3().set(
            -Math.log(T[0][0]), -Math.log(T[1][0]), -Math.log(T[2][0]),
            -Math.log(T[0][1]), -Math.log(T[1][1]), -Math.log(T[2][1]),
            -Math.log(T[0][2]), -Math.log(T[1][2]), -Math.log(T[2][2]),
        );
        const inv = D.clone().invert();
        return { paper, lin: inkLin, T, densInv: inv.toArray() };
    }

    _pixel(ctx) {
        const { P, wh } = ctx;
        const pal = (this._palette ||= this._paletteSetup(P.palette));
        // Integer scale: every virtual pixel is the same whole number of
        // canvas pixels, never fewer than two.
        const scale = Math.max(2, Math.round(ctx.fh / P.lines));
        const vw = Math.ceil(ctx.fw / scale), vh = Math.ceil(ctx.fh / scale);
        const down = this._rt("lo", vw, vh, { nearest: true });
        this._pass("pxDown", down, { tSrc: ctx.prep, tFig: ctx.src, srcTexel: ctx.texel, cell: wh / vh });
        const q = this._rt("lo2", vw, vh, { nearest: true });
        this._pass("pxQuant", q, {
            tSrc: down, texel: [1 / vw, 1 / vh], pal: pal.lab, palSRGB: pal.srgb, palN: pal.n, opaque: ctx.opaque,
        });
        this._pass("pxCompose", null, { tQ: q, tRaw: ctx.prep, scale, reveal: ctx.reveal });
    }

    /** Palette → OKLab (chroma-weighted like PX_QUANT's target) + sRGB
     *  uniform arrays, padded to 64. */
    _paletteSetup(hexes) {
        const srgb = hexes.map(hexToRgb);
        const lab = srgb.map((c) => oklab(c).map((v, i) => (i ? v * PX_CHROMA_WEIGHT : v)));
        const pad = (arr) => arr.concat(Array.from({ length: 64 - arr.length }, () => [0, 0, 0]));
        return { n: hexes.length, srgb: pad(srgb), lab: pad(lab) };
    }

    _releaseTargets() {
        for (const t of this._targets.values()) t.dispose();
        this._targets.clear();
    }

    dispose() {
        this._releaseTargets();
        for (const t of this._tiles.values()) t.dispose();
        this._tiles.clear();
        for (const m of this._mats.values()) m.dispose();
        this._mats.clear();
        this._back.texture?.dispose();
        this._back = { source: null, texture: null };
        this._quad.dispose();
    }
}
