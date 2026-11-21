// Gaussian splats for roam mode's splat gag (models/roam_gags_splat.js): the
// companion as a cloud of 3D Gaussians drawn in the avatar's own scene, so
// the cloud can come apart, take other shapes and come back together.
//
// A splat is a centre, a 3 × 3 covariance and a colour. Drawing follows 3D
// Gaussian Splatting (Kerbl, Kopanas, Leimkühler, Drettakis, SIGGRAPH 2023):
// the covariance goes to the screen through the Jacobian of the perspective
// projection (Σ' = J W Σ Wᵀ Jᵀ, their eq. 5, from Zwicker et al.'s EWA
// splatting), the reference implementation's 0.3 px is added to its
// diagonal so no splat is thinner than a pixel, a quad is laid along its two
// principal axes, and the quads are blended back to front with
// alpha = opacity · exp(−½ dᵀ Σ'⁻¹ d). The sort is a 16-bit counting sort
// of the view depths every frame, on this thread: 60,000 splats here, for
// the twenty seconds the gag lasts.
//
// Nothing is trained: the splats are sampled off the companion's own mesh
// as posed (one flat disc per sample, lying in the surface, coloured from
// the texture).

const TEX_W = 512;
// The reference implementation's screen-space dilation, px² (see above).
const LOW_PASS = 0.3;
// Samples per unit of area on the head, against 1 for the rest of the
// body: the face is where the eye goes, and a blurred one reads as wrong
// before anything else does (by eye).
const HEAD_DENSITY = 6;
// A disc's spread in the surface and through it, as shares of the spacing
// between samples: wide enough that neighbours close over one another,
// thin enough to stay a surface (by eye).
const SIGMA_FLAT = 0.8;
const SIGMA_THIN = 0.12;
// A sample on a see-through texel (the gaps of a hair card, a lash) is
// left out below this alpha.
const ALPHA_CUT = 0.5;
// Textures are read at up to this size: finer than the splats can show.
const READ_MAX = 1024;
// In the normal's slot of a splat seen from both sides (a sheet, a hair
// card). A real normal's x is stored as it is, plus 4 when its z is
// negative; its y beside it; z is what's left of the unit length.
const TWO_SIDED = 10;

const VERT = /* glsl */`
uniform sampler2D tCovA;
uniform sampler2D tCovB;
uniform sampler2D tColor;
uniform vec2 uViewport;
uniform float uCull;
attribute vec3 iPos;
attribute float iId;
attribute vec3 iMod;    // size ×, opacity ×, needle length (m)
varying vec4 vColor;
varying vec2 vQuad;

vec3 hash3(float n) {
    return fract(sin(vec3(n * 12.9898, n * 78.233, n * 37.719)) * 43758.5453);
}

void main() {
    int id = int(iId + 0.5);
    ivec2 tc = ivec2(id % ${TEX_W}, id / ${TEX_W});
    vec4 ta = texelFetch(tCovA, tc, 0);
    vec4 tb = texelFetch(tCovB, tc, 0);
    vec3 ca = ta.xyz;
    vec3 cb = tb.xyz;
    vec4 col = texelFetch(tColor, tc, 0);

    vec4 cam = viewMatrix * vec4(iPos, 1.0);
    vec4 clip = projectionMatrix * cam;
    float lim = 1.4 * clip.w;
    if (cam.z > -0.05 || abs(clip.x) > lim || abs(clip.y) > lim || iMod.y < 0.004) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    mat3 cov = mat3(ca.x, ca.y, ca.z, ca.y, cb.x, cb.y, ca.z, cb.y, cb.z) * (iMod.x * iMod.x);
    if (iMod.z > 0.0) {
        // Stretched to a needle along a direction of its own.
        vec3 d = normalize(hash3(iId) - 0.5);
        cov += (iMod.z * iMod.z) * mat3(d * d.x, d * d.y, d * d.z);
    }

    float fx = projectionMatrix[0][0] * uViewport.x * 0.5;
    float fy = projectionMatrix[1][1] * uViewport.y * 0.5;
    float z = cam.z;
    mat3 J = mat3(-fx / z, 0.0, 0.0,
                  0.0, -fy / z, 0.0,
                  fx * cam.x / (z * z), fy * cam.y / (z * z), 0.0);
    mat3 T = J * mat3(viewMatrix);
    mat3 c2 = T * cov * transpose(T);
    float a = c2[0][0] + ${LOW_PASS.toFixed(1)};
    float b = c2[0][1];
    float d2 = c2[1][1] + ${LOW_PASS.toFixed(1)};
    float mid = 0.5 * (a + d2);
    float rad = length(vec2(0.5 * (a - d2), b));
    float l1 = mid + rad;
    float l2 = max(mid - rad, 0.1);
    vec2 axis = vec2(b, l1 - a);
    float len = length(axis);
    axis = len > 1e-6 ? axis / len : vec2(1.0, 0.0);
    vec2 major = min(sqrt(2.0 * l1), 1024.0) * axis;
    vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(axis.y, -axis.x);

    vec2 ndc = clip.xy / clip.w;
    gl_Position = vec4(ndc + (position.x * major + position.y * minor) * 2.0 / uViewport, clip.z / clip.w, 1.0);
    vQuad = position.xy;
    // A disc on the far side of what it was sampled off faces away: left
    // out (softly, so the outline keeps its splats), as far as uCull says.
    float facing = 1.0;
    if (uCull > 0.0 && ta.w < ${TWO_SIDED.toFixed(1)} - 1.0) {
        float nx = ta.w > 2.0 ? ta.w - 4.0 : ta.w;
        float nz = sqrt(max(0.0, 1.0 - nx * nx - tb.w * tb.w)) * (ta.w > 2.0 ? -1.0 : 1.0);
        float toward = dot(mat3(viewMatrix) * vec3(nx, tb.w, nz), normalize(-cam.xyz));
        facing = mix(1.0, smoothstep(-0.25, 0.05, toward), uCull);
    }
    vColor = vec4(col.rgb, col.a * iMod.y * facing);
}`;

const FRAG = /* glsl */`
varying vec4 vColor;
varying vec2 vQuad;

void main() {
    float A = -dot(vQuad, vQuad);
    if (A < -4.0) discard;
    // Colours are kept as the sRGB bytes they were read as.
    gl_FragColor = vec4(pow(vColor.rgb, vec3(2.2)), exp(A) * vColor.a);
    #include <colorspace_fragment>
}`;

export class SplatCloud {
    /** Room for `max` splats; `mesh` goes in the scene. Per frame, write
     *  pos / scale / alpha / needle for whatever moved, then frame(). */
    constructor(THREE, max) {
        this.THREE = THREE;
        this.max = max;
        this.count = 0;
        const rows = Math.ceil(max / TEX_W);
        this.home = new Float32Array(max * 3);
        this.seed = new Float32Array(max * 4);
        this.pos = new Float32Array(max * 3);
        this.scale = new Float32Array(max).fill(1);
        this.alpha = new Float32Array(max).fill(1);
        this.needle = new Float32Array(max);
        this._covA = new Float32Array(TEX_W * rows * 4);
        this._covB = new Float32Array(TEX_W * rows * 4);
        this._col = new Uint8Array(TEX_W * rows * 4);
        this._tCovA = new THREE.DataTexture(this._covA, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
        this._tCovB = new THREE.DataTexture(this._covB, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
        this._tCol = new THREE.DataTexture(this._col, TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
        this._inst = new Float32Array(max * 7);
        this._buf = new THREE.InstancedInterleavedBuffer(this._inst, 7);
        this._buf.setUsage(THREE.DynamicDrawUsage);
        const geo = new THREE.InstancedBufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        geo.setAttribute("iPos", new THREE.InterleavedBufferAttribute(this._buf, 3, 0));
        geo.setAttribute("iId", new THREE.InterleavedBufferAttribute(this._buf, 1, 3));
        geo.setAttribute("iMod", new THREE.InterleavedBufferAttribute(this._buf, 3, 4));
        geo.instanceCount = 0;
        const viewport = new THREE.Vector4();
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                tCovA: { value: this._tCovA }, tCovB: { value: this._tCovB }, tColor: { value: this._tCol },
                uViewport: { value: new THREE.Vector2(1, 1) }, uCull: { value: 1 },
            },
            vertexShader: VERT, fragmentShader: FRAG,
            // Both sides: a quad's two axes come out mirrored as often as not.
            transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 20;
        // The size of whatever is being drawn into (the canvas, or a pass's
        // own target at its own size).
        this.mesh.onBeforeRender = (renderer) => {
            renderer.getCurrentViewport(viewport);
            mat.uniforms.uViewport.value.set(viewport.z, viewport.w);
            mat.uniformsNeedUpdate = true;
        };
        this._keys = new Uint16Array(max);
        this._order = new Uint32Array(max);
        this._depth = new Float32Array(max);
        this._starts = new Uint32Array(65537);
        this._inv = new THREE.Matrix4();
    }

    /** How far splats facing away from the camera are left out: 1 (a
     *  surface at rest: its far side stays hidden) to 0 (all of them show,
     *  flying about). */
    set cull(v) { this.mesh.material.uniforms.uCull.value = v; }

    /** One more splat: centre, covariance (xx xy xz yy yz zz, m²), colour
     *  (sRGB bytes), and the unit normal of the surface it lies in (none:
     *  seen from both sides). Returns its index, or -1 when full. */
    push(x, y, z, xx, xy, xz, yy, yz, zz, r, g, b, normal = null) {
        const i = this.count;
        if (i >= this.max) return -1;
        this.count++;
        this.home[i * 3] = this.pos[i * 3] = x;
        this.home[i * 3 + 1] = this.pos[i * 3 + 1] = y;
        this.home[i * 3 + 2] = this.pos[i * 3 + 2] = z;
        for (let k = 0; k < 4; k++) this.seed[i * 4 + k] = Math.random();
        this._covA.set([xx, xy, xz, normal ? normal[0] + (normal[2] < 0 ? 4 : 0) : TWO_SIDED], i * 4);
        this._covB.set([yy, yz, zz, normal ? normal[1] : 0], i * 4);
        this._col.set([r, g, b, 255], i * 4);
        return i;
    }

    /** After the last push: the tables go to the GPU. */
    commit() {
        this._tCovA.needsUpdate = true;
        this._tCovB.needsUpdate = true;
        this._tCol.needsUpdate = true;
    }

    /** Sort by depth from `camera` (posed for this frame) and hand the
     *  frame's positions to the GPU, furthest first. */
    frame(camera) {
        const n = this.count;
        if (!n) return;
        camera.updateMatrixWorld();
        const e = this._inv.copy(camera.matrixWorld).invert().elements;
        const { pos, alpha, scale, needle } = this;
        const depth = this._depth, keys = this._keys, order = this._order, starts = this._starts;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) {
            const d = e[2] * pos[i * 3] + e[6] * pos[i * 3 + 1] + e[10] * pos[i * 3 + 2] + e[14];
            depth[i] = d;
            if (d < lo) lo = d;
            if (d > hi) hi = d;
        }
        // View z runs negative into the screen: lowest first is furthest first.
        const k = 65535 / Math.max(1e-6, hi - lo);
        starts.fill(0);
        for (let i = 0; i < n; i++) {
            const key = ((depth[i] - lo) * k) | 0;
            keys[i] = key;
            starts[key + 1]++;
        }
        for (let j = 1; j <= 65536; j++) starts[j] += starts[j - 1];
        for (let i = 0; i < n; i++) order[starts[keys[i]]++] = i;
        const out = this._inst;
        let m = 0;
        for (let j = 0; j < n; j++) {
            const i = order[j];
            if (alpha[i] < 0.004) continue;
            const o = m * 7;
            out[o] = pos[i * 3];
            out[o + 1] = pos[i * 3 + 1];
            out[o + 2] = pos[i * 3 + 2];
            out[o + 3] = i;
            out[o + 4] = scale[i];
            out[o + 5] = alpha[i];
            out[o + 6] = needle[i];
            m++;
        }
        this._buf.needsUpdate = true;
        this.mesh.geometry.instanceCount = m;
    }

    dispose() {
        this.mesh.removeFromParent();
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this._tCovA.dispose();
        this._tCovB.dispose();
        this._tCol.dispose();
    }
}

/** A texture's pixels (sRGB bytes), read once per texture; null when the
 *  image can't be drawn (a compressed texture): its material's flat colour
 *  stands in then. */
function texturePixels(map, cache) {
    if (!map?.image) return null;
    if (cache.has(map)) return cache.get(map);
    let out = null;
    try {
        const img = map.image;
        const iw = img.width || img.videoWidth || 0, ih = img.height || img.videoHeight || 0;
        if (iw && ih && !map.isCompressedTexture) {
            const k = Math.min(1, READ_MAX / Math.max(iw, ih));
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(iw * k));
            c.height = Math.max(1, Math.round(ih * k));
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(img, 0, 0, c.width, c.height);
            out = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height, flip: !!map.flipY };
        }
    } catch (e) { /* not drawable: the flat colour */ }
    cache.set(map, out);
    return out;
}

const srgbByte = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));

/** Sample `count` flat splats off every visible mesh under `root` as it is
 *  posed right now (skinning and expressions included), into `cloud`.
 *  `headY`: above this height (world m) the sampling is HEAD_DENSITY times
 *  as dense. Returns {start, count, min, max} (the cloud's range, and the
 *  samples' bounding box). */
export function sampleBody(cloud, root, count, headY = Infinity) {
    const { THREE } = cloud;
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const pixels = new Map();
    const parts = [];
    const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    root.traverse((o) => {
        const geo = o.geometry;
        if (!o.isMesh || !geo?.attributes?.position || !visible(o)) return;
        const n = geo.attributes.position.count;
        const world = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
            world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
        }
        const index = geo.index?.array || null;
        const total = index ? index.length : n;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const groups = geo.groups?.length ? geo.groups : [{ start: 0, count: total, materialIndex: 0 }];
        for (const g of groups) {
            const m = mats[g.materialIndex] || mats[0];
            // An outline is the same surface again, pushed out and inked.
            if (!m || m.isOutline || m.visible === false || (m.opacity ?? 1) < 0.05) continue;
            const map = m.map || m.uniforms?.map?.value || null;
            const col = m.color || m.uniforms?.litFactor?.value || null;
            parts.push({
                world, index, uv: geo.attributes.uv?.array || null,
                start: g.start, end: Math.min(total, g.start + g.count),
                tex: texturePixels(map, pixels),
                tint: col ? [srgbByte(col.r) / 255, srgbByte(col.g) / 255, srgbByte(col.b) / 255] : [1, 1, 1],
                opacity: m.opacity ?? 1,
                cut: !!(m.transparent || m.alphaTest > 0),
                both: m.side === THREE.DoubleSide,
            });
        }
    });
    // Every triangle's area, weighted (the head's count for more), summed.
    const tris = [];
    let sum = 0, area = 0;
    for (const p of parts) {
        for (let t = p.start; t + 2 < p.end; t += 3) {
            const a = (p.index ? p.index[t] : t) * 3, b = (p.index ? p.index[t + 1] : t + 1) * 3, c = (p.index ? p.index[t + 2] : t + 2) * 3;
            const w = p.world;
            const ux = w[b] - w[a], uy = w[b + 1] - w[a + 1], uz = w[b + 2] - w[a + 2];
            const vx = w[c] - w[a], vy = w[c + 1] - w[a + 1], vz = w[c + 2] - w[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const A = 0.5 * Math.hypot(nx, ny, nz);
            if (!(A > 1e-10)) continue;
            const dense = (w[a + 1] + w[b + 1] + w[c + 1]) / 3 > headY ? HEAD_DENSITY : 1;
            sum += A * dense;
            area += A;
            tris.push({ p, a, b, c, t, n: [nx / (2 * A), ny / (2 * A), nz / (2 * A)], dense, upto: sum });
        }
    }
    const start = cloud.count;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    if (!tris.length) return { start, count: 0, min, max };
    // The spacing a sample of weight 1 has to itself; a head sample's is
    // 1/√HEAD_DENSITY of it.
    const spacing = Math.sqrt(sum / count);
    for (let tries = 0, made = 0; made < count && tries < count * 3; tries++) {
        const r = Math.random() * sum;
        let lo = 0, hi = tris.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tris[mid].upto < r) lo = mid + 1; else hi = mid;
        }
        const tri = tris[lo];
        const { p, a, b, c } = tri;
        let s = Math.random(), q = Math.random();
        if (s + q > 1) { s = 1 - s; q = 1 - q; }
        const o = 1 - s - q;
        const w = p.world;
        const x = w[a] * o + w[b] * s + w[c] * q, y = w[a + 1] * o + w[b + 1] * s + w[c + 1] * q, z = w[a + 2] * o + w[b + 2] * s + w[c + 2] * q;
        let R = 255 * p.tint[0], G = 255 * p.tint[1], B = 255 * p.tint[2], alpha = p.opacity;
        if (p.tex && p.uv) {
            const ia = a / 3 * 2, ib = b / 3 * 2, ic = c / 3 * 2;
            let tu = p.uv[ia] * o + p.uv[ib] * s + p.uv[ic] * q, tv = p.uv[ia + 1] * o + p.uv[ib + 1] * s + p.uv[ic + 1] * q;
            tu -= Math.floor(tu);
            tv -= Math.floor(tv);
            if (p.tex.flip) tv = 1 - tv;
            const px = (Math.min(p.tex.h - 1, (tv * p.tex.h) | 0) * p.tex.w + Math.min(p.tex.w - 1, (tu * p.tex.w) | 0)) * 4;
            const d = p.tex.data;
            R = d[px] * p.tint[0]; G = d[px + 1] * p.tint[1]; B = d[px + 2] * p.tint[2];
            alpha *= d[px + 3] / 255;
        }
        if (p.cut && alpha < ALPHA_CUT) continue;
        const sp = spacing / Math.sqrt(tri.dense);
        const flat = (SIGMA_FLAT * sp) ** 2, thin = (SIGMA_THIN * sp) ** 2;
        // Σ = flat · (I − n nᵀ) + thin · n nᵀ: a disc lying in the surface.
        const [nx, ny, nz] = tri.n;
        const k = thin - flat;
        if (cloud.push(x, y, z, flat + k * nx * nx, k * nx * ny, k * nx * nz, flat + k * ny * ny, k * ny * nz, flat + k * nz * nz,
            R, G, B, p.both ? null : tri.n) < 0) break;
        made++;
        if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
    }
    return { start, count: cloud.count - start, min, max, area };
}
