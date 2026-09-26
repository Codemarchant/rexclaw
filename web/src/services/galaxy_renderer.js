import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { spiralPoint } from "../lib/memory_galaxy";

/** Draws a lib/memory_galaxy layout: one star per memory, spiral-arm dust
 *  and a glow per topic galaxy, faint similarity lines inside each galaxy,
 *  HTML labels over the canvas. Everything reveals by time rank (0 = the
 *  oldest memory), which is what the replay scrubs.
 *
 *  Point sizes are world metres: the vertex shaders multiply by the focal
 *  term projectionMatrix[1][1] (three's own attenuation leaves it out, see
 *  ambience.js). Numbers here are design unless noted. */

const BG = 0x04050c;
const ALL = 1e9;              // reveal rank that shows everything
const INTRO_MS = 2600;
const FLY_MS = 1400;
const REPLAY_MS = 22000;
const HOME_DIR = [0.45, 1.25, 1];   // ~50° above the plane, discs read face-on
const HOME_DIST = 1.9;              // × layout extent: fits the sky at 50° FOV

const STAR_VERTEX = /* glsl */ `
uniform float uTime, uReveal, uFlash, uViewH, uFilter, uSel, uHover, uIntro;
attribute vec3 aColor;
attribute float aSize, aRank, aSeed, aMatch, aCore, aEpisode, aRecent, aIndex;
varying vec3 vColor;
varying float vAlpha, vCore, vEpisode;
void main() {
    float e = clamp(uIntro * 1.5 - aSeed * 0.5, 0.0, 1.0);
    e = 1.0 - pow(1.0 - e, 3.0);
    vec4 mv = modelViewMatrix * vec4(position * mix(0.02, 1.0, e), 1.0);
    gl_Position = projectionMatrix * mv;
    float age = uReveal - aRank;
    float alive = step(0.0, age) * step(0.001, e);
    float flash = alive * exp(-max(age, 0.0) / uFlash);
    float tw = 0.82 + 0.18 * sin(uTime * (0.9 + aSeed * 2.3) + aSeed * 61.0);
    float pulse = aRecent * (0.5 + 0.5 * sin(uTime * 2.4 + aSeed * 17.0));
    float hot = max(step(abs(aIndex - uSel), 0.5), step(abs(aIndex - uHover), 0.5));
    float dim = mix(1.0, mix(0.08, 1.0, aMatch), uFilter);
    float size = aSize * tw * (1.0 + 2.4 * flash + 0.6 * pulse + 0.9 * hot) * (1.0 + 1.0 * aMatch * uFilter);
    float px = size * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1);
    gl_PointSize = alive * clamp(px, 2.5, 240.0);
    vColor = mix(aColor, vec3(1.0), 0.5 * flash + 0.35 * hot + 0.3 * aMatch * uFilter);
    vAlpha = alive * dim * (0.72 + 0.28 * tw + 0.5 * pulse);
    vCore = aCore;
    vEpisode = aEpisode;
}`;

const STAR_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha, vCore, vEpisode;
void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float r = sqrt(r2);
    float core = exp(-r2 * 26.0);
    float halo = exp(-r2 * 4.5) * 0.42;
    float ring = vEpisode * smoothstep(0.07, 0.0, abs(r - 0.6)) * 0.5;
    float spikes = vCore * (exp(-abs(uv.x) * 34.0) + exp(-abs(uv.y) * 34.0)) * (1.0 - r) * 1.1;
    vec3 col = vColor * (halo + ring + spikes + core * 0.5) + vec3(1.0) * core * 0.9;
    gl_FragColor = vec4(col, vAlpha);
}`;

const DUST_VERTEX = /* glsl */ `
uniform float uTime, uReveal, uViewH, uIntro, uDim, uFilter;
attribute vec3 aColor;
attribute float aSize, aRank, aSeed, aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
    float e = clamp(uIntro * 1.4 - aSeed * 0.4, 0.0, 1.0);
    e = 1.0 - pow(1.0 - e, 3.0);
    vec4 mv = modelViewMatrix * vec4(position * mix(0.02, 1.0, e), 1.0);
    gl_Position = projectionMatrix * mv;
    float alive = step(aRank, uReveal) * step(0.001, e);
    float px = aSize * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1);
    gl_PointSize = alive * clamp(px, 1.0, 160.0);
    vColor = aColor;
    vAlpha = alive * uDim * aAlpha * (0.75 + 0.25 * sin(uTime * (0.4 + aSeed) + aSeed * 40.0));
    // Fade out as the camera closes in, or a near puff fills the screen.
    vAlpha *= smoothstep(aSize * 3.0, aSize * 10.0, -mv.z);
    vAlpha *= mix(1.0, 0.3, uFilter); // a search lets the matches stand out
}`;

const DUST_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor * exp(-r2 * 5.0), vAlpha);
}`;

const LINE_VERTEX = /* glsl */ `
uniform float uReveal;
attribute vec3 aColor;
attribute float aRank;
varying vec3 vColor;
varying float vAlive;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vAlive = step(aRank, uReveal);
}`;

const LINE_FRAGMENT = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying float vAlive;
void main() {
    if (vAlive < 0.5) discard;
    gl_FragColor = vec4(vColor, uAlpha);
}`;

export const clusterColor = (c) => (c ? new THREE.Color().setHSL(c.hue, 0.75, 0.64) : new THREE.Color().setHSL(0.6, 0.18, 0.86));

function rand32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function glowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}

function ringTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    g.strokeStyle = "rgba(255,255,255,0.95)";
    g.lineWidth = 3;
    g.setLineDash([14, 9]);
    g.beginPath();
    g.arc(64, 64, 54, 0, Math.PI * 2);
    g.stroke();
    return new THREE.CanvasTexture(c);
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class GalaxyRenderer {
    constructor(host, { onHover, onSelect, onReveal, onLabelClick } = {}) {
        this.host = host;
        this.cb = { onHover, onSelect, onReveal, onLabelClick };
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setClearColor(BG, 1);
        this.renderer.domElement.className = "rx_galaxy_canvas";
        host.appendChild(this.renderer.domElement);

        this.labelsEl = document.createElement("div");
        this.labelsEl.className = "rx_galaxy_labels";
        host.appendChild(this.labelsEl);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
        this.camera.position.set(20, 30, 60);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 0.3;
        this.controls.addEventListener("start", () => {
            this.controls.autoRotate = false;
            this._fly = null;
        });

        this.glowTex = glowTexture();
        this.ringTex = ringTexture();
        this.uniforms = {
            uTime: { value: 0 },
            uReveal: { value: ALL },
            uFlash: { value: 1 },
            uViewH: { value: 800 },
            uFilter: { value: 0 },
            uSel: { value: -1 },
            uHover: { value: -1 },
            uIntro: { value: 0 },
        };
        this.objects = [];
        this.links = { hover: null, sel: null };
        this.layout = null;
        this.selected = -1;
        this.hovered = -1;
        this.matches = null;
        this.running = false;
        this.clock = new THREE.Clock();
        this._v = new THREE.Vector3();

        this._resize = this._resize.bind(this);
        this._frame = this._frame.bind(this);
        this._ro = new ResizeObserver(this._resize);
        this._ro.observe(host);
        this._resize();
        this._bindPointer();
    }

    // ── data ──────────────────────────────────────────────────────────────

    setData(layout) {
        this._clearObjects();
        this.layout = layout;
        this.selected = -1;
        this.hovered = -1;
        this.uniforms.uSel.value = -1;
        this.uniforms.uHover.value = -1;
        this._stopReplay();
        this.uniforms.uReveal.value = ALL;
        const { stars, clusters, extent } = layout;
        const n = stars.length;
        this.extent = extent;
        this.controls.maxDistance = extent * 6;
        this.controls.minDistance = 1.5;

        // Stars
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const f = () => new Float32Array(n);
        const [size, rank, seed, match, core, episode, recent, index] = [f(), f(), f(), f(), f(), f(), f(), f()];
        stars.forEach((s, i) => {
            pos.set(s.pos, i * 3);
            clusterColor(clusters[s.cluster]).toArray(col, i * 3);
            size[i] = (s.episode ? 0.62 : 0.44) * (s.core ? 1.5 : 1);
            rank[i] = i;
            seed[i] = s.seed;
            match[i] = 1;
            core[i] = s.core ? 1 : 0;
            episode[i] = s.episode ? 1 : 0;
            recent[i] = s.recent ? 1 : 0;
            index[i] = i;
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
        for (const [name, arr] of Object.entries({ aSize: size, aRank: rank, aSeed: seed, aMatch: match, aCore: core, aEpisode: episode, aRecent: recent, aIndex: index })) {
            g.setAttribute(name, new THREE.BufferAttribute(arr, 1));
        }
        this.starGeom = g;
        this.stars = new THREE.Points(g, new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: STAR_VERTEX,
            fragmentShader: STAR_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.stars.renderOrder = 3;
        this._add(this.stars);

        // Spiral-arm dust + bulge, revealed with the member that sits at the
        // same point of the arm, so the arms grow during the replay.
        const dust = [];
        for (const c of clusters) {
            const rand = rand32(0xa11ce ^ (c.id * 31337));
            const color = clusterColor(c);
            const count = Math.min(4000, 200 + c.size * 60);
            const m = c.members;
            for (let k = 0; k < count; k++) {
                const t = Math.pow(rand(), 0.8);
                const bulge = rand() < 0.2;
                // A quarter of the arm dust is soft gas: big, faint puffs that
                // turn the dotted arm into a glowing band.
                const gas = !bulge && rand() < 0.25;
                const p = bulge
                    ? spiralPoint(c, rand() * 0.1, 0, rand, 3)
                    : spiralPoint(c, t, Math.floor(rand() * 2), rand, gas ? 1.4 : 1);
                const tint = color.clone().offsetHSL((rand() - 0.5) * 0.06, -0.1, bulge ? 0.12 : (rand() - 0.5) * 0.2);
                dust.push({
                    p, tint,
                    size: gas ? c.radius * (0.08 + rand() * 0.07) : 0.14 + rand() * 0.3,
                    alpha: gas ? 0.1 : 1,
                    rank: m[Math.round((bulge ? 0 : t) * (m.length - 1))],
                    seed: rand(),
                });
            }
        }
        const bgRand = rand32(0x5eed);
        for (let k = 0; k < 4000; k++) {
            const dir = new THREE.Vector3(bgRand() * 2 - 1, bgRand() * 2 - 1, bgRand() * 2 - 1).normalize();
            const p = dir.multiplyScalar(extent * (2.5 + bgRand() * 4)).toArray();
            const tint = new THREE.Color().setHSL(0.55 + bgRand() * 0.15, 0.3, 0.7 + bgRand() * 0.25);
            dust.push({ p, tint, size: 0.35 + bgRand() * 0.9, alpha: 1, rank: -1, seed: bgRand() });
        }
        this.dust = this._dustPoints(dust, 0.8);
        this.dust.renderOrder = 1;
        this._add(this.dust);

        // Galaxy glows: a bright bulge and a wide faint halo per topic.
        this.glows = clusters.map((c) => {
            const color = clusterColor(c);
            const make = (scale, opacity) => {
                const s = new THREE.Sprite(new THREE.SpriteMaterial({
                    map: this.glowTex, color, transparent: true, opacity: 0,
                    depthWrite: false, blending: THREE.AdditiveBlending,
                }));
                s.position.fromArray(c.center);
                s.scale.setScalar(c.radius * scale);
                s.userData = { opacity, firstRank: c.firstRank };
                s.renderOrder = 0;
                this._add(s);
                return s;
            };
            return [make(0.5, 0.5), make(1.9, 0.07)];
        }).flat();

        // Constellation lines only for the hovered and the selected star —
        // drawn for every star they cut across the spiral arms.
        this.links = { hover: null, sel: null };

        this.marker = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.ringTex, color: 0xffffff, transparent: true, depthWrite: false, depthTest: false,
        }));
        this.marker.visible = false;
        this.marker.renderOrder = 4;
        this._add(this.marker);

        this._buildLabels();
        this.uniforms.uIntro.value = 0;
        this._introStart = performance.now();
        const home = new THREE.Vector3(...HOME_DIR).normalize().multiplyScalar(extent * HOME_DIST);
        this.camera.position.copy(home);
        this.controls.target.set(0, 0, 0);
        this.controls.autoRotate = true;
        this.controls.update();
    }

    _dustPoints(items, dim) {
        const n = items.length;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const rank = new Float32Array(n);
        const seed = new Float32Array(n);
        const alpha = new Float32Array(n);
        items.forEach((d, i) => {
            pos.set(d.p, i * 3);
            d.tint.toArray(col, i * 3);
            size[i] = d.size;
            rank[i] = d.rank;
            seed[i] = d.seed;
            alpha[i] = d.alpha;
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
        g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
        g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
        g.setAttribute("aRank", new THREE.BufferAttribute(rank, 1));
        g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
        return new THREE.Points(g, new THREE.ShaderMaterial({
            uniforms: { ...this.uniforms, uDim: { value: dim } },
            vertexShader: DUST_VERTEX,
            fragmentShader: DUST_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
    }

    _lineSegments(pairs, alpha, color = null) {
        const { stars, clusters } = this.layout;
        const pos = new Float32Array(pairs.length * 6);
        const col = new Float32Array(pairs.length * 6);
        const rank = new Float32Array(pairs.length * 2);
        pairs.forEach(([a, b], k) => {
            pos.set(stars[a].pos, k * 6);
            pos.set(stars[b].pos, k * 6 + 3);
            const ca = color || clusterColor(clusters[stars[a].cluster]);
            const cb = color || clusterColor(clusters[stars[b].cluster]);
            ca.toArray(col, k * 6);
            cb.toArray(col, k * 6 + 3);
            rank[k * 2] = rank[k * 2 + 1] = Math.max(a, b);
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
        g.setAttribute("aRank", new THREE.BufferAttribute(rank, 1));
        return new THREE.LineSegments(g, new THREE.ShaderMaterial({
            uniforms: { uReveal: this.uniforms.uReveal, uAlpha: { value: alpha } },
            vertexShader: LINE_VERTEX,
            fragmentShader: LINE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
    }

    _buildLabels() {
        this.labelsEl.replaceChildren();
        this._labelSizes = null;
        this.labelEls = this.layout.clusters.map((c) => {
            const el = document.createElement("button");
            el.type = "button";
            el.className = "rx_galaxy_label";
            el.style.setProperty("--c", `#${clusterColor(c).getHexString()}`);
            el.textContent = c.label;
            el.title = c.terms.join(", ");
            el.addEventListener("click", () => this.cb.onLabelClick?.(c.id));
            this.labelsEl.appendChild(el);
            return el;
        });
    }

    /** Search highlight: a Set of star indices, or null for no filter. */
    setMatches(set) {
        if (!this.layout) return;
        this.matches = set;
        const attr = this.starGeom.getAttribute("aMatch");
        for (let i = 0; i < attr.count; i++) attr.array[i] = !set || set.has(i) ? 1 : 0;
        attr.needsUpdate = true;
        this.uniforms.uFilter.value = set ? 1 : 0;
    }

    // ── selection + camera ────────────────────────────────────────────────

    select(index, { fly = true } = {}) {
        if (!this.layout) return;
        this.selected = index ?? -1;
        this.uniforms.uSel.value = this.selected;
        this._setLinks("sel", this.selected, 0.55);
        if (this.selected < 0) {
            this.marker.visible = false;
            return;
        }
        const s = this.layout.stars[this.selected];
        this.marker.position.fromArray(s.pos);
        this.marker.visible = true;
        if (fly) this.flyTo(s.pos, 10);
    }

    /** Lines from star `index` to its related memories ("hover" / "sel"). */
    _setLinks(slot, index, alpha) {
        const old = this.links[slot];
        if (old) {
            this.scene.remove(old);
            old.geometry.dispose();
            old.material.dispose();
            this.objects = this.objects.filter((o) => o !== old);
            this.links[slot] = null;
        }
        if (index < 0) return;
        const pairs = this.layout.related[index].map((r) => [index, r.index]);
        if (!pairs.length) return;
        const lines = this._lineSegments(pairs, alpha, new THREE.Color(0xfff4d6));
        lines.renderOrder = 2;
        this._add(lines);
        this.links[slot] = lines;
    }

    flyTo(point, distance, viewDir = null) {
        const target = new THREE.Vector3().fromArray(point);
        const dir = viewDir
            ? new THREE.Vector3().fromArray(viewDir).normalize()
            : this.camera.position.clone().sub(this.controls.target).normalize();
        this._fly = {
            t0: performance.now(),
            fromPos: this.camera.position.clone(),
            fromTarget: this.controls.target.clone(),
            toPos: target.clone().add(dir.multiplyScalar(distance)),
            toTarget: target,
        };
        this.controls.autoRotate = false;
    }

    flyToCluster(id) {
        const c = this.layout?.clusters[id];
        if (!c) return;
        // Mostly face-on, tilted a little toward the current view.
        const cur = this.camera.position.clone().sub(this.controls.target).normalize();
        const n = new THREE.Vector3().fromArray(c.normal);
        if (n.dot(cur) < 0) n.negate();
        const dir = n.multiplyScalar(0.85).add(cur.multiplyScalar(0.35));
        this.flyTo(c.center, c.radius * 2.3, dir.toArray());
    }

    home() {
        if (!this.layout) return;
        this.flyTo([0, 0, 0], this.extent * HOME_DIST, HOME_DIR);
        this._afterFly = () => { this.controls.autoRotate = true; };
    }

    // ── replay ────────────────────────────────────────────────────────────

    /** Play the memories back in the order they were made, from `from`
     *  (a rank) to the newest, over ~22 s — paced by count, not by date, so
     *  quiet weeks don't stall it. */
    play(from = 0) {
        if (!this.layout) return;
        const n = this.layout.stars.length;
        const start = from >= n - 1 ? -1 : from;
        this._replay = { t0: performance.now(), from: start, to: n - 1, ms: REPLAY_MS * (1 - (start + 1) / (n + 1)) };
        this.uniforms.uFlash.value = Math.max(0.6, (n / (REPLAY_MS / 1000)) * 0.45);
        if (start < 0) this.home();
        this.controls.autoRotate = true;
    }

    pause() {
        this._stopReplay();
    }

    /** Scrub to a rank (float), or null to show everything. */
    setReveal(rank) {
        this._stopReplay();
        this.uniforms.uReveal.value = rank == null ? ALL : rank;
    }

    get playing() {
        return !!this._replay;
    }

    _stopReplay() {
        this._replay = null;
    }

    // ── loop ──────────────────────────────────────────────────────────────

    setActive(on) {
        if (on === this.running) return;
        this.running = on;
        if (on) {
            this.clock.getDelta();
            this._raf = requestAnimationFrame(this._frame);
        } else {
            cancelAnimationFrame(this._raf);
        }
    }

    _frame() {
        if (!this.running) return;
        this._raf = requestAnimationFrame(this._frame);
        const now = performance.now();
        this.uniforms.uTime.value += this.clock.getDelta();
        if (this._introStart != null) {
            const t = Math.min(1, (now - this._introStart) / INTRO_MS);
            this.uniforms.uIntro.value = t;
            if (t >= 1) this._introStart = null;
        }
        if (this._replay) {
            const r = this._replay;
            const t = Math.min(1, (now - r.t0) / Math.max(1, r.ms));
            const rank = r.from + (r.to + 0.999 - r.from) * t;
            this.uniforms.uReveal.value = rank;
            this.cb.onReveal?.(rank, t >= 1);
            if (t >= 1) {
                this._replay = null;
                this.uniforms.uReveal.value = ALL;
            }
        }
        if (this._fly) {
            const f = this._fly;
            const t = Math.min(1, (now - f.t0) / FLY_MS);
            const e = easeInOut(t);
            this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
            this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
            if (t >= 1) {
                this._fly = null;
                this._afterFly?.();
                this._afterFly = null;
            }
        }
        this.controls.update();
        if (this.layout) {
            const reveal = this.uniforms.uReveal.value;
            const intro = this.uniforms.uIntro.value;
            for (const s of this.glows) {
                const on = s.userData.firstRank <= reveal ? 1 : 0;
                const target = s.userData.opacity * on * Math.min(1, intro * 1.6);
                s.material.opacity += (target - s.material.opacity) * 0.08;
            }
            if (this.marker.visible) {
                const d = this.camera.position.distanceTo(this.marker.position);
                this.marker.scale.setScalar(Math.max(1.4, d * 0.05));
                this.marker.material.rotation = this.uniforms.uTime.value * 0.6;
            }
            this._placeLabels(reveal, intro);
        }
        this.renderer.render(this.scene, this.camera);
    }

    _placeLabels(reveal, intro) {
        const { clusters } = this.layout;
        const w = this.host.clientWidth;
        const h = this.host.clientHeight;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const spots = clusters.map((c, i) => {
            const p = this._v.fromArray(c.center).addScaledVector(up, c.radius * 0.75);
            const dist = this.camera.position.distanceTo(p);
            p.project(this.camera);
            const visible = p.z < 1 && c.firstRank <= reveal && intro > 0.85;
            return { i, dist, visible, x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h };
        });
        // Nearest galaxy first; a label that would overlap one already
        // placed (a galaxy behind another) hides until the view clears.
        // Label sizes measured once (text never changes) — reading them per
        // frame between style writes would force a layout every frame.
        if (!this._labelSizes || this._labelSizes.some(([sw]) => !sw)) {
            this._labelSizes = this.labelEls.map((el) => [el.offsetWidth, el.offsetHeight]);
        }
        const placed = [];
        for (const s of spots.sort((a, b) => a.dist - b.dist)) {
            const el = this.labelEls[s.i];
            const [lw, lh] = this._labelSizes[s.i];
            const box = [s.x - lw / 2, s.y - lh, s.x + lw / 2, s.y];
            const clash = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
            if (!s.visible || clash) {
                el.style.opacity = "0";
                el.style.pointerEvents = "none";
                continue;
            }
            placed.push(box);
            const near = Math.max(0, Math.min(1, 1.6 - s.dist / (this.extent * 3)));
            const fade = this.selected >= 0 ? 0.45 : 1;
            el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
            el.style.opacity = String(Math.max(0.25, near) * fade);
            el.style.pointerEvents = "auto";
        }
    }

    // ── pointer ───────────────────────────────────────────────────────────

    _bindPointer() {
        const el = this.renderer.domElement;
        let down = null;
        this._onMove = (ev) => {
            const idx = this._pick(ev);
            if (idx !== this.hovered) {
                this.hovered = idx;
                this.uniforms.uHover.value = idx;
                this._setLinks("hover", idx === this.selected ? -1 : idx, 0.3);
                el.style.cursor = idx >= 0 ? "pointer" : "";
            }
            const rect = el.getBoundingClientRect();
            this.cb.onHover?.(idx, ev.clientX - rect.left, ev.clientY - rect.top);
        };
        this._onDown = (ev) => { down = [ev.clientX, ev.clientY]; };
        this._onUp = (ev) => {
            if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) return;
            down = null;
            this.cb.onSelect?.(this._pick(ev));
        };
        this._onLeave = () => {
            this.hovered = -1;
            this.uniforms.uHover.value = -1;
            this._setLinks("hover", -1);
            this.cb.onHover?.(-1, 0, 0);
        };
        el.addEventListener("pointermove", this._onMove);
        el.addEventListener("pointerdown", this._onDown);
        el.addEventListener("pointerup", this._onUp);
        el.addEventListener("pointerleave", this._onLeave);
    }

    /** Nearest visible star to the pointer, in screen space. */
    _pick(ev) {
        if (!this.layout || this.uniforms.uIntro.value < 1) return -1;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const reveal = this.uniforms.uReveal.value;
        let best = -1;
        let bestD = 16 * 16;
        for (const s of this.layout.stars) {
            if (s.index > reveal) continue;
            if (this.matches && !this.matches.has(s.index)) continue;
            this._v.fromArray(s.pos).project(this.camera);
            if (this._v.z > 1) continue;
            const dx = (this._v.x + 1) / 2 * rect.width - mx;
            const dy = (1 - this._v.y) / 2 * rect.height - my;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = s.index; }
        }
        return best;
    }

    _resize() {
        const w = Math.max(1, this.host.clientWidth);
        const h = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.uniforms.uViewH.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    }

    _add(obj) {
        this.scene.add(obj);
        this.objects.push(obj);
    }

    _clearObjects() {
        for (const o of this.objects) {
            this.scene.remove(o);
            o.geometry?.dispose();
            o.material?.dispose();
        }
        this.objects = [];
        this.links = { hover: null, sel: null };
    }

    dispose() {
        this.setActive(false);
        this._ro.disconnect();
        const el = this.renderer.domElement;
        el.removeEventListener("pointermove", this._onMove);
        el.removeEventListener("pointerdown", this._onDown);
        el.removeEventListener("pointerup", this._onUp);
        el.removeEventListener("pointerleave", this._onLeave);
        this._clearObjects();
        this.glowTex.dispose();
        this.ringTex.dispose();
        this.controls.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss(); // free the GL context now, not at GC — List/Galaxy toggles add up
        el.remove();
        this.labelsEl.remove();
    }
}
