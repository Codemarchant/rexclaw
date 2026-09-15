/**
 * Ambience — weather and atmosphere around the companion (Look →
 * Ambience): rain, snow, cherry petals, fireflies, embers, and manga focus
 * lines. Scene objects
 * rather than a DOM overlay, so the character occludes what is behind them,
 * the effects preset's bloom catches the glowing ones, and they show on the
 * see-through desktop mascot (only the particles paint; the desktop stays
 * visible between them). Also drives the mood-reactive mode: the renderer
 * swaps the active ambience with the companion's emotion (MOOD_AMBIENCE).
 *
 * Numbers: fall speeds, drop and flake populations, the firefly's flash
 * rhythm, the plume speed that lofts embers and the petals' breeze are
 * measurements, cited at each system. Everything else — how far the box
 * extends, flake and glow-halo sizes, flutter, fade times, counts where no
 * population exists — is a design value tuned by eye and marked (design).
 *
 * Sizes and speeds are in scene metres (the VRM stands ~1.6 m tall at the
 * origin); the whole group follows the companion, so weather stays around
 * a character who has walked off in a 3D scene.
 */

const TAU = Math.PI * 2;
const FADE_S = 1.5;   // cross-fade when the ambience changes (design)
const NEAR_FADE = [0.4, 1.0];   // point sprites: invisible → full, metres from the camera (design)

// The particle box, metres around the companion's feet: wide enough that
// the full-body framing sits inside weather, with the far half behind the
// character so they occlude some of it (design).
const BOX = { x: 2.5, height: 3.2, zNear: 1.5, zFar: -1.5 };
const BOX_VOLUME = 2 * BOX.x * BOX.height * (BOX.zNear - BOX.zFar);   // 48 m³

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};

// ---- textures (painted once, no assets) ------------------------------------

function canvasTexture(THREE, size, paint) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    paint(canvas.getContext("2d"), size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** Soft disc: opaque centre falling off to the edge (`hard` = fraction of
 *  the radius kept fully opaque). */
function softDisc(THREE, hard = 0.2) {
    return canvasTexture(THREE, 64, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(hard, "rgba(255,255,255,1)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
    });
}

/** Glow: a small bright core inside a wide faint halo — what a point of
 *  light looks like through a lens, and what makes a spark or a firefly
 *  read at a few pixels. Core is `core` of the radius (design). */
function glowDisc(THREE, core = 0.18) {
    return canvasTexture(THREE, 64, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(core, "rgba(255,255,255,0.9)");
        g.addColorStop(core * 2, "rgba(255,255,255,0.35)");
        g.addColorStop(0.6, "rgba(255,255,255,0.1)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
    });
}

/** Cherry petal: a rounded teardrop with the notched tip, lighter at the
 *  base. #FFB7C5 is the conventional "cherry blossom" web colour. */
function petalTexture(THREE) {
    return canvasTexture(THREE, 128, (ctx, s) => {
        const p = new Path2D();
        p.moveTo(s * 0.5, s * 0.06);
        p.bezierCurveTo(s * 0.1, s * 0.2, s * 0.08, s * 0.72, s * 0.5, s * 0.94);
        p.bezierCurveTo(s * 0.92, s * 0.72, s * 0.9, s * 0.2, s * 0.5, s * 0.06);
        // The notch at the tip.
        p.moveTo(s * 0.5, s * 0.06);
        p.lineTo(s * 0.44, s * 0.16);
        p.lineTo(s * 0.5, s * 0.2);
        p.lineTo(s * 0.56, s * 0.16);
        p.closePath();
        const g = ctx.createLinearGradient(0, s * 0.94, 0, s * 0.06);
        g.addColorStop(0, "#ffe3e9");
        g.addColorStop(1, "#ffb7c5");
        ctx.fillStyle = g;
        ctx.fill(p, "evenodd");
    });
}

// ---- point sprites with per-particle size and alpha -------------------------
// PointsMaterial has one size for all points; snow and fireflies want
// their own. `size` is a true world-space diameter in
// metres: half the drawing-buffer height × the projection's focal term
// (1 / tan(fov/2), projectionMatrix[1][1]) over the view depth. three's own
// attenuation leaves the focal term out, so its sprites shrink as the FOV
// narrows; the first cut copied it and drew everything 3–6× too small
// (5.7× at the 20° face view).
// Near fade (NEAR_FADE): sprites dissolve as they reach the camera instead
// of blowing up into blobs across the face. Unity URP's particle Camera
// Fading ships 1 m / 2 m, sized for game cameras several metres out; here
// it would fade the character's own surroundings.

const POINT_VERTEX = /* glsl */`
    attribute float size;
    attribute float alpha;
    uniform float scale;
    uniform vec2 nearFade;
    varying float vAlpha;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = -mv.z;
        gl_PointSize = min(256.0, size * scale * projectionMatrix[1][1] / depth);
        gl_Position = projectionMatrix * mv;
        vAlpha = alpha * smoothstep(nearFade.x, nearFade.y, depth);
    }`;

const POINT_FRAGMENT = /* glsl */`
    uniform sampler2D map;
    uniform vec3 color;
    uniform float opacity;
    varying float vAlpha;
    void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(color * t.rgb, t.a * vAlpha * opacity);
        #include <colorspace_fragment>
    }`;

function pointCloud(THREE, count, { map, color, additive }) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
    const material = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: map },
            color: { value: new THREE.Color(color) },
            opacity: { value: 0 },
            scale: { value: 1 },
            nearFade: { value: new THREE.Vector2(...NEAR_FADE) },
        },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;   // positions move every frame; the box is the bound
    return { points, positions, sizes, alphas };
}

function markDirty(geometry, ...names) {
    for (const n of names) geometry.getAttribute(n).needsUpdate = true;
}

// ---- Rain ------------------------------------------------------------------
// Population: Marshall & Palmer (1948), N(D) = N₀ e^(−ΛD) with N₀ = 8000
// m⁻³ mm⁻¹ and Λ = 4.1 R^−0.21 mm⁻¹, at R = 4 mm/h — moderate rain (the
// US NWS class runs 2.6–7.6 mm/h). Only drops of 1 mm and up are drawn:
// the smaller ones are too faint to read as streaks (design cut), which
// leaves ~120 drops per m³, ~5900 in the box. Fall speed: the Atlas,
// Srivastava & Sekhon (1973) fit to Gunn & Kinzer's (1949) measurements,
// v = 9.65 − 10.3 e^(−0.6D) m/s (D in mm): 4.0 m/s at 1 mm, 8.1 at 3 mm.
// Streak length is the distance a drop covers in one 180°-shutter frame
// at 24 fps (1/48 s), the film convention for motion blur: 8–17 cm.
// Brightness grows with drop size (design); additive so the streaks read
// on a dark backdrop and mostly vanish on a bright desktop, like real rain.
const RAIN = {
    rate: 4, n0: 8000, minDiameter: 1, shutter: 1 / 48,
    maxDrops: 8000, brightness: 0.55, color: 0xcfe4ff,
};

class Rain {
    constructor(THREE) {
        const lambda = 4.1 * Math.pow(RAIN.rate, -0.21);
        const density = (RAIN.n0 / lambda) * Math.exp(-lambda * RAIN.minDiameter);
        const count = Math.min(RAIN.maxDrops, Math.round(density * BOX_VOLUME));
        this.count = count;
        this.lambda = lambda;
        this.speeds = new Float32Array(count);
        this.lengths = new Float32Array(count);
        this.positions = new Float32Array(count * 6);
        const colors = new Float32Array(count * 6);
        const color = new THREE.Color(RAIN.color);
        for (let i = 0; i < count; i++) {
            this._spawn(i, rand(0, BOX.height));
            const d = RAIN.minDiameter - Math.log(1 - Math.random()) / lambda;   // truncated exponential
            const v = 9.65 - 10.3 * Math.exp(-0.6 * d);
            this.speeds[i] = v;
            this.lengths[i] = v * RAIN.shutter;
            const b = RAIN.brightness * Math.min(1, d / 3);
            for (let k = 0; k < 2; k++) {
                colors[i * 6 + k * 3] = color.r * b;
                colors[i * 6 + k * 3 + 1] = color.g * b;
                colors[i * 6 + k * 3 + 2] = color.b * b;
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        this.material = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.object = new THREE.LineSegments(geometry, this.material);
        this.object.frustumCulled = false;
    }

    _spawn(i, y) {
        const p = this.positions;
        p[i * 6] = rand(-BOX.x, BOX.x);
        p[i * 6 + 1] = y;
        p[i * 6 + 2] = rand(BOX.zFar, BOX.zNear);
    }

    setFade(f) { this.material.opacity = f; }

    update(dt) {
        const p = this.positions;
        for (let i = 0; i < this.count; i++) {
            let y = p[i * 6 + 1] - this.speeds[i] * dt;
            if (y < -0.05) {
                this._spawn(i, BOX.height + rand(0, 0.5));
                y = p[i * 6 + 1];
            }
            p[i * 6 + 1] = y;
            p[i * 6 + 3] = p[i * 6];
            p[i * 6 + 4] = y + this.lengths[i];
            p[i * 6 + 5] = p[i * 6 + 2];
        }
        markDirty(this.object.geometry, "position");
    }

    dispose() {
        this.object.geometry.dispose();
        this.material.dispose();
    }
}

// ---- Snow ------------------------------------------------------------------
// Population: Gunn & Marshall (1958) for snow, N₀ = 3800 R^−0.87 m⁻³ mm⁻¹,
// Λ = 2.55 R^−0.48 mm⁻¹ in melted diameter, at R = 1 mm/h liquid
// equivalent (a steady moderate snowfall). Aggregates of 1 mm melted
// diameter and up: ~115 per m³, ~5600 in the box. Fall speed: Langleben
// (1954), dry aggregates at the ground — 1 m/s is the standard assumption,
// the largest reach ~1.5. Flakes draw 4–12 mm across, with a slow
// side-to-side sway (design).
const SNOW = {
    rate: 1, minDiameter: 1, speed: [0.9, 1.5], size: [0.004, 0.012],
    sway: 0.08, swayPeriod: [2, 4], maxFlakes: 8000, color: 0xffffff,
};

class Snow {
    constructor(THREE) {
        const n0 = 3800 * Math.pow(SNOW.rate, -0.87);
        const lambda = 2.55 * Math.pow(SNOW.rate, -0.48);
        const density = (n0 / lambda) * Math.exp(-lambda * SNOW.minDiameter);
        const count = Math.min(SNOW.maxFlakes, Math.round(density * BOX_VOLUME));
        this.count = count;
        this.cloud = pointCloud(THREE, count, { map: softDisc(THREE, 0.35), color: SNOW.color, additive: false });
        this.object = this.cloud.points;
        this.speeds = new Float32Array(count);
        this.phases = new Float32Array(count);
        this.rates = new Float32Array(count);
        this.baseX = new Float32Array(count);
        this.time = 0;
        for (let i = 0; i < count; i++) {
            this._spawn(i, rand(0, BOX.height));
            this.speeds[i] = rand(...SNOW.speed);
            this.phases[i] = rand(0, TAU);
            this.rates[i] = TAU / rand(...SNOW.swayPeriod);
            this.cloud.sizes[i] = rand(...SNOW.size);
            this.cloud.alphas[i] = rand(0.6, 1);
        }
        markDirty(this.object.geometry, "size", "alpha");
    }

    _spawn(i, y) {
        const p = this.cloud.positions;
        this.baseX[i] = rand(-BOX.x, BOX.x);
        p[i * 3] = this.baseX[i];
        p[i * 3 + 1] = y;
        p[i * 3 + 2] = rand(BOX.zFar, BOX.zNear);
    }

    setFade(f) { this.cloud.points.material.uniforms.opacity.value = f; }

    update(dt, scale) {
        this.time += dt;
        this.cloud.points.material.uniforms.scale.value = scale;
        const p = this.cloud.positions;
        for (let i = 0; i < this.count; i++) {
            let y = p[i * 3 + 1] - this.speeds[i] * dt;
            if (y < -0.05) {
                this._spawn(i, BOX.height + rand(0, 0.3));
                y = p[i * 3 + 1];
            }
            p[i * 3 + 1] = y;
            p[i * 3] = this.baseX[i] + Math.sin(this.time * this.rates[i] + this.phases[i]) * SNOW.sway;
        }
        markDirty(this.object.geometry, "position");
    }

    dispose() {
        this.object.geometry.dispose();
        this.object.material.uniforms.map.value.dispose();
        this.object.material.dispose();
    }
}

// ---- Cherry petals ---------------------------------------------------------
// Fall speed: 0.0535 m/s — Bowes-Reynolds, Evans, Fox & Morland-Nuttall,
// "Five Centimeters Per Second?", J. Phys. Special Topics (Leicester, 2021),
// balancing gravity, buoyancy and Rayleigh drag for a paper-thin petal; the
// figure the film 5 Centimeters per Second is named for. Breeze: Beaufort 1,
// "light air", 0.3–1.5 m/s (the WMO scale), blowing along +x with each
// petal riding its own share. Count, size (about 3× a real petal so it
// reads), flutter and tumble rates are design values. An InstancedMesh of
// quads rather than point sprites: petals tumble in 3D.
const PETALS = {
    count: 110, fall: 0.0535, breeze: [0.3, 1.5], size: 0.03,
    flutter: 0.05, flutterRate: [1, 2], tumble: [1, 3], color: 0xffffff,
};

class Petals {
    constructor(THREE) {
        this.THREE = THREE;
        const count = PETALS.count;
        this.count = count;
        this.material = new THREE.MeshBasicMaterial({
            map: petalTexture(THREE), color: PETALS.color, transparent: true, opacity: 0,
            alphaTest: 0.2, depthWrite: false, side: THREE.DoubleSide,
        });
        const geometry = new THREE.PlaneGeometry(PETALS.size * 0.85, PETALS.size);
        this.object = new THREE.InstancedMesh(geometry, this.material, count);
        this.object.frustumCulled = false;
        this.pos = new Float32Array(count * 3);
        this.wind = new Float32Array(count);
        this.rot = new Float32Array(count * 3);
        this.spin = new Float32Array(count * 3);
        this.phase = new Float32Array(count);
        this.flutterRate = new Float32Array(count);
        this.time = 0;
        this._m = new THREE.Matrix4();
        this._q = new THREE.Quaternion();
        this._e = new THREE.Euler();
        this._p = new THREE.Vector3();
        this._s = new THREE.Vector3(1, 1, 1);
        for (let i = 0; i < count; i++) {
            this._spawn(i, true);
            this.phase[i] = rand(0, TAU);
            this.flutterRate[i] = TAU * rand(...PETALS.flutterRate);
            for (let k = 0; k < 3; k++) {
                this.rot[i * 3 + k] = rand(0, TAU);
                this.spin[i * 3 + k] = rand(...PETALS.tumble) * (Math.random() < 0.5 ? -1 : 1);
            }
        }
    }

    /** Petals enter upwind (−x) or from the top; the first fill scatters
     *  them through the box so the effect doesn't start empty. */
    _spawn(i, initial) {
        const p = this.pos;
        if (initial) {
            p[i * 3] = rand(-BOX.x, BOX.x);
            p[i * 3 + 1] = rand(0.1, BOX.height);
        } else if (Math.random() < 0.6) {
            p[i * 3] = -BOX.x - rand(0, 0.3);
            p[i * 3 + 1] = rand(0.3, BOX.height);
        } else {
            p[i * 3] = rand(-BOX.x, BOX.x * 0.5);
            p[i * 3 + 1] = BOX.height + rand(0, 0.3);
        }
        p[i * 3 + 2] = rand(BOX.zFar, BOX.zNear);
        this.wind[i] = rand(...PETALS.breeze);
    }

    setFade(f) { this.material.opacity = f; }

    update(dt) {
        this.time += dt;
        const p = this.pos;
        for (let i = 0; i < this.count; i++) {
            const t = this.time * this.flutterRate[i] + this.phase[i];
            p[i * 3] += this.wind[i] * dt;
            p[i * 3 + 1] -= PETALS.fall * dt;
            // Flutter: a falling petal side-slips and lifts as it rocks.
            p[i * 3 + 2] += Math.cos(t) * PETALS.flutter * dt;
            p[i * 3 + 1] += Math.sin(t * 2) * PETALS.flutter * 0.5 * dt;
            if (p[i * 3] > BOX.x + 0.3 || p[i * 3 + 1] < -0.05) this._spawn(i, false);
            for (let k = 0; k < 3; k++) this.rot[i * 3 + k] += this.spin[i * 3 + k] * dt;
            this._e.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]);
            this._q.setFromEuler(this._e);
            this._p.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
            this._m.compose(this._p, this._q, this._s);
            this.object.setMatrixAt(i, this._m);
        }
        this.object.instanceMatrix.needsUpdate = true;
    }

    dispose() {
        this.object.geometry.dispose();
        this.material.map.dispose();
        this.material.dispose();
    }
}

// ---- Fireflies -------------------------------------------------------------
// Two species share the meadow, both with published rhythms:
//   - Photinus pyralis, the common eastern firefly: a 0.3 s flash every
//     5.5 s at 25 °C, flying slowly and level, rising on the flash — the
//     "J" (Britannica). Each on its own clock, so they twinkle at random.
//   - Photinus carolinus, the Smokies' synchronous firefly: trains of 4–8
//     flashes 0.5 s apart, then 6–9 s of dark, every male in step (Faust
//     2010, Florida Entomologist 93(2)). One shared clock: the whole group
//     bursts together — the part people travel to see.
// Light peaks at 560 nm, yellow-green. The living flash decays over tens
// to ~100 ms (Nature Sci. Rep. 2021); it is stretched to a 0.35 s tail so
// the eye catches it on a small window (design). The first cut kept 24
// fireflies on the physical rhythm spread over the whole box — at most one
// was ever lit in the face framing — so they now crowd the volume around
// the character, and a faint body glow keeps them visible between flashes
// (count, spread, glow size, body glow, cruise speed: design).
const FIREFLIES = {
    count: 120, spread: { x: 1.4, y: [0.3, 2.3], zNear: 1.1, zFar: -0.8 },
    color: 0xd9ff5a, size: 0.035, speed: 0.25, bob: 0.2, body: 0.12, tail: 0.35,
    pyralis: { on: 0.3, every: 5.5 },
    carolinus: { share: 0.5, on: 0.15, gap: 0.5, flashes: [4, 8], dark: [6, 9] },
};

class Fireflies {
    constructor(THREE) {
        const count = FIREFLIES.count;
        const S = FIREFLIES.spread;
        this.count = count;
        this.cloud = pointCloud(THREE, count, { map: glowDisc(THREE), color: FIREFLIES.color, additive: true });
        this.object = this.cloud.points;
        this.heading = new Float32Array(count);
        this.clock = new Float32Array(count);   // seconds into a pyralis flash cycle
        this.baseY = new Float32Array(count);
        this.glow = new Float32Array(count);    // current light level, with the decay tail
        this.sync = new Uint8Array(count);      // 1 = carolinus, on the shared train clock
        // The shared carolinus train: `trainT` runs through flashes×gap of
        // flashing, then a dark spell, then a fresh train.
        this.trainT = 0;
        this._newTrain();
        const p = this.cloud.positions;
        for (let i = 0; i < count; i++) {
            p[i * 3] = rand(-S.x, S.x);
            this.baseY[i] = rand(...S.y);
            p[i * 3 + 1] = this.baseY[i];
            p[i * 3 + 2] = rand(S.zFar, S.zNear);
            this.heading[i] = rand(0, TAU);
            this.clock[i] = rand(0, FIREFLIES.pyralis.every);
            this.sync[i] = Math.random() < FIREFLIES.carolinus.share ? 1 : 0;
            this.cloud.sizes[i] = FIREFLIES.size * rand(0.8, 1.2);
        }
        markDirty(this.object.geometry, "size");
    }

    _newTrain() {
        const C = FIREFLIES.carolinus;
        this.trainFlashes = Math.round(rand(...C.flashes));
        this.trainDark = rand(...C.dark);
        this.trainLen = this.trainFlashes * C.gap + this.trainDark;
    }

    setFade(f) { this.cloud.points.material.uniforms.opacity.value = f; }

    update(dt, scale) {
        this.cloud.points.material.uniforms.scale.value = scale;
        const S = FIREFLIES.spread;
        const P = FIREFLIES.pyralis;
        const C = FIREFLIES.carolinus;
        const p = this.cloud.positions;
        const a = this.cloud.alphas;
        const decay = Math.exp(-dt / FIREFLIES.tail);
        // Shared train clock.
        this.trainT += dt;
        if (this.trainT >= this.trainLen) {
            this.trainT -= this.trainLen;
            this._newTrain();
        }
        const inTrain = this.trainT < this.trainFlashes * C.gap;
        const trainPhase = inTrain ? (this.trainT % C.gap) / C.on : 2;
        const trainLit = trainPhase < 1 ? Math.sin(Math.PI * Math.pow(trainPhase, 0.6)) : 0;
        for (let i = 0; i < this.count; i++) {
            // Slow level wander: the heading random-walks, the walls turn it.
            this.heading[i] += rand(-1.2, 1.2) * dt;
            let x = p[i * 3] + Math.cos(this.heading[i]) * FIREFLIES.speed * dt;
            let z = p[i * 3 + 2] + Math.sin(this.heading[i]) * FIREFLIES.speed * dt;
            if (x < -S.x || x > S.x || z < S.zFar || z > S.zNear) {
                this.heading[i] += Math.PI;
                x = Math.min(S.x, Math.max(-S.x, x));
                z = Math.min(S.zNear, Math.max(S.zFar, z));
            }
            this.baseY[i] += rand(-0.15, 0.15) * dt;
            this.baseY[i] = Math.min(S.y[1], Math.max(S.y[0], this.baseY[i]));
            let lit, swoop;
            if (this.sync[i]) {
                lit = trainLit;
                swoop = inTrain ? Math.sin(Math.PI * this.trainT / (this.trainFlashes * C.gap)) : 0;
            } else {
                // Quick rise, slower tail over the flash; the upward J-swoop
                // peaks as the light does.
                this.clock[i] += dt;
                if (this.clock[i] >= P.every) this.clock[i] -= P.every;
                const k = this.clock[i] / P.on;
                lit = k < 1 ? Math.sin(Math.PI * Math.pow(k, 0.6)) : 0;
                swoop = k < 1.5 ? Math.sin(Math.PI * Math.min(1, k / 1.5)) : 0;
            }
            // Afterglow: the light level never drops faster than the tail.
            this.glow[i] = Math.max(lit, this.glow[i] * decay);
            p[i * 3] = x;
            p[i * 3 + 1] = this.baseY[i] + swoop * FIREFLIES.bob;
            p[i * 3 + 2] = z;
            a[i] = FIREFLIES.body + this.glow[i] * (1 - FIREFLIES.body);
        }
        markDirty(this.object.geometry, "position", "alpha");
    }

    dispose() {
        this.object.geometry.dispose();
        this.object.material.uniforms.map.value.dispose();
        this.object.material.dispose();
    }
}

// ---- instanced flakes with per-instance tint and alpha ---------------------
// Petal-style tumbling quads, used by the embers and their ash. A
// ShaderMaterial rather than MeshBasicMaterial: per-instance alpha
// (instanceColor has none) and the point sprites' near-camera fade. three
// declares position, uv and instanceMatrix itself.

const FLAKE_VERTEX = /* glsl */`
    attribute vec3 tint;
    attribute float alpha;
    uniform vec2 nearFade;
    varying vec2 vUv;
    varying vec3 vTint;
    varying float vAlpha;
    void main() {
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vUv = uv;
        vTint = tint;
        vAlpha = alpha * smoothstep(nearFade.x, nearFade.y, -mv.z);
    }`;

const FLAKE_FRAGMENT = /* glsl */`
    uniform sampler2D map;
    uniform float opacity;
    varying vec2 vUv;
    varying vec3 vTint;
    varying float vAlpha;
    void main() {
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(vTint * t.rgb, t.a * vAlpha * opacity);
        #include <colorspace_fragment>
    }`;

/** `tints` hold linear RGB (THREE.Color values), like the scene's colours. */
function flakeMesh(THREE, count, { map, additive }) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const tints = new Float32Array(count * 3);
    const alphas = new Float32Array(count);
    geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tints, 3));
    geometry.setAttribute("alpha", new THREE.InstancedBufferAttribute(alphas, 1));
    const material = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: map },
            opacity: { value: 0 },
            nearFade: { value: new THREE.Vector2(...NEAR_FADE) },
        },
        vertexShader: FLAKE_VERTEX,
        fragmentShader: FLAKE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;   // instances move every frame; the box is the bound
    return { mesh, tints, alphas };
}

/** A jagged flake outline centred on an s×s canvas: `r` is the mean
 *  radius as a fraction of s, `jag` how far each point wanders from it. */
function flakePath(s, r, jag, points) {
    const p = new Path2D();
    for (let k = 0; k < points; k++) {
        const a = (k / points) * TAU + rand(-0.2, 0.2);
        const rr = s * r * (1 + rand(-jag, jag));
        const x = s / 2 + Math.cos(a) * rr;
        const y = s / 2 + Math.sin(a) * rr;
        if (k) p.lineTo(x, y);
        else p.moveTo(x, y);
    }
    p.closePath();
    return p;
}

/** Ember flake, greyscale (the per-instance tint carries the blackbody
 *  hue): a white-hot heart, dimmer jagged edges, and a faint halo over the
 *  rest of the quad so it glows. The flake spans ~0.4 of the quad. */
function emberTexture(THREE) {
    return canvasTexture(THREE, 128, (ctx, s) => {
        const halo = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        halo.addColorStop(0, "rgba(255,255,255,0.4)");
        halo.addColorStop(0.45, "rgba(255,255,255,0.1)");
        halo.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, s, s);
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.24);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.55, "#d9d9d9");
        g.addColorStop(1, "#7a7a7a");
        ctx.fillStyle = g;
        ctx.fill(flakePath(s, 0.2, 0.35, 9));
    });
}

/** Ash speck: a flat jagged flake spanning ~0.76 of the quad; the tint
 *  sets its grey. */
function ashTexture(THREE) {
    return canvasTexture(THREE, 64, (ctx, s) => {
        ctx.fillStyle = "#ffffff";
        ctx.fill(flakePath(s, 0.38, 0.4, 7));
    });
}

// ---- Embers ----------------------------------------------------------------
// A fire burning just below the frame: embers lift off its bed, ride the
// hot air up past the character and burn out on the way, and each one that
// dies leaves a flake of ash drifting on in the same air. Both are tumbling
// flakes, like the petals, so they glint as they turn edge-on.
//   - Rise: the plume slows with height as z^−⅓, the shape of McCaffrey's
//     (1979) plume-region law, scaled down to a slow drift (his real
//     speeds, 2.5–3.5 m/s over a campfire, crossed the face framing in a
//     third of a second).
//   - Turbulence (Air): a kinematic simulation (Kraichnan 1970; Fung et al.
//     1992), a few random Fourier modes whose velocity is perpendicular to
//     their wave vector, so the field is exactly divergence-free: the
//     property Bridson et al. (2007) call "necessary for the characteristic
//     look of everyday fluids", and why nearby embers swirl together
//     instead of jittering apart. Mode speeds follow Kolmogorov's u ∝ l^⅓,
//     each turns over at its own eddy rate, and the pattern rides up with
//     the plume (Taylor's frozen turbulence). Embers lag the air a little,
//     so they drift rather than track it.
//   - Heat: each ember cools exponentially (Newton) along the blackbody
//     locus, 1500 K #ff6d00 → 1000 K #ff3800 (Charity's 2001 table: CIE
//     1964 10°, sRGB, D65), going dark at the Draper point, 798 K, below
//     which solids give off almost no visible light (Draper 1847).
//     Lifetimes skew short, so most burn out low and few make it high.
//   - It starts pre-warmed, like Unity's Prewarm and Niagara's Warmup Time,
//     so it opens mid-burn instead of empty.
// Design values (nothing measured exists for embers this small): the bed,
// rise and turbulence speeds, eddy sizes, lag, lifetimes, birth
// temperatures, counts, flake sizes, tumble, flicker, ash greys and life.
const EMBERS = {
    count: 90, bed: { x: 1.0, zNear: 0.8, zFar: -0.6, y: [0, 0.15], clear: 0.35 },
    lofted: 0.15, loftedY: [0.3, 1.4], rise: 0.4, riseRef: 0.3, buoyancy: [0.7, 1.2],
    lag: 0.6, life: { min: 2.5, mean: 6, max: 12 }, birthK: [1300, 1700], ambientK: 293,
    draperK: 798, brightK: 1100, size: [0.01, 0.022], tumble: [0.8, 2.5], flicker: [2, 6],
    prewarm: 10,
};
const AIR = { modes: 6, wavelength: [0.4, 1.6], rms: 0.12, unsteady: 0.5, scroll: 0.25 };
const ASH = { life: [2.5, 4], buoyancy: 0.3, grey: [0.28, 0.45], alpha: 0.8, shrink: 0.4 };
// [kelvin, sRGB hex], Charity's 2001 blackbody table.
const BLACKBODY = [[1000, 0xff3800], [1500, 0xff6d00], [2000, 0xff8a12]];
const EMBER_QUAD = 2.5;   // quad over flake size (emberTexture: flake ~0.4 of it)
const ASH_QUAD = 1.3;     // quad over speck size (ashTexture: speck ~0.76 of it)

/** Random unit vector, uniform on the sphere. */
function randomUnit() {
    const z = rand(-1, 1), a = rand(0, TAU), r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
}

/** The embers' turbulence: AIR.modes random Fourier modes (see above). */
class Air {
    constructor() {
        const [l0, l1] = AIR.wavelength;
        this.modes = [];
        let power = 0;
        for (let n = 0; n < AIR.modes; n++) {
            const l = l1 * Math.pow(l0 / l1, n / (AIR.modes - 1));   // geometric across the band
            const k = randomUnit();
            // Velocity direction: a random unit vector with its k part removed.
            let a;
            do {
                const v = randomUnit();
                const d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
                a = [v[0] - d * k[0], v[1] - d * k[1], v[2] - d * k[2]];
            } while (Math.hypot(...a) < 0.1);
            const len = Math.hypot(...a);
            const u = Math.pow(l, 1 / 3);   // Kolmogorov: u ∝ l^⅓
            power += (u * u) / 2;           // the mean of cos² is ½
            const wave = TAU / l;
            this.modes.push({
                kx: k[0] * wave, ky: k[1] * wave, kz: k[2] * wave,
                ax: a[0] / len, ay: a[1] / len, az: a[2] / len,
                u, wave, phase: rand(0, TAU), omega: 0,
            });
        }
        // Scale to the target rms speed; each mode turns over at its eddy rate.
        const scale = AIR.rms / Math.sqrt(power);
        for (const m of this.modes) {
            m.u *= scale;
            m.omega = AIR.unsteady * m.u * m.wave;
        }
    }

    /** Turbulent air velocity at (x, y, z) and time t, into `out`. */
    sample(x, y, z, t, out) {
        const yy = y - AIR.scroll * t;   // the pattern rides up with the plume
        out[0] = out[1] = out[2] = 0;
        for (const m of this.modes) {
            const c = m.u * Math.cos(m.kx * x + m.ky * yy + m.kz * z + m.omega * t + m.phase);
            out[0] += m.ax * c;
            out[1] += m.ay * c;
            out[2] += m.az * c;
        }
        return out;
    }
}

class Embers {
    constructor(THREE) {
        this.THREE = THREE;
        this.object = new THREE.Group();
        const n = EMBERS.count;
        this.ash = flakeMesh(THREE, n, { map: ashTexture(THREE), additive: false });
        this.embers = flakeMesh(THREE, n, { map: emberTexture(THREE), additive: true });
        this.embers.mesh.renderOrder = 1;   // glow over the ash
        this.object.add(this.ash.mesh, this.embers.mesh);
        this.palette = BLACKBODY.map(([k, hex]) => [k, new THREE.Color(hex)]);   // linear
        this.air = new Air();
        this.time = 0;
        this._u = [0, 0, 0];
        this._c = new THREE.Color();
        this._m = new THREE.Matrix4();
        this._q = new THREE.Quaternion();
        this._e = new THREE.Euler();
        this._p = new THREE.Vector3();
        this._s = new THREE.Vector3();
        // Per-slot state. Slot i holds an ember and, once it burns out, its
        // ash; an ash still drifting when the slot's next ember dies is
        // kept, and that ember leaves none.
        const f = () => new Float32Array(n);
        const f3 = () => new Float32Array(n * 3);
        this.e = {
            pos: f3(), vel: f3(), rot: f3(), tumble: f3(), age: f(), life: f(), tau: f(),
            birthK: f(), buoy: f(), size: f(), phase: f(), flickA: f(), flickB: f(),
        };
        this.a = { pos: f3(), vel: f3(), rot: f3(), tumble: f3(), age: f(), life: f(), size: f() };
        for (let i = 0; i < n; i++) {
            this._spawnEmber(i);
            this.e.age[i] = -rand(0, EMBERS.life.mean);   // stagger the first births
        }
        for (let t = 0; t < EMBERS.prewarm; t += 0.1) this.update(0.1);
    }

    /** Lifetime, skewed short: the minimum plus an exponential tail, capped. */
    _life() {
        const L = EMBERS.life;
        return Math.min(L.max, L.min - Math.log(1 - Math.random()) * (L.mean - L.min));
    }

    _spawnEmber(i) {
        const E = EMBERS, B = E.bed, e = this.e;
        let x, z;
        do {   // anywhere on the bed but the character's own footprint
            x = rand(-B.x, B.x);
            z = rand(B.zFar, B.zNear);
        } while (x * x + z * z < B.clear * B.clear);
        e.pos[i * 3] = x;
        e.pos[i * 3 + 1] = Math.random() < E.lofted ? rand(...E.loftedY) : rand(...B.y);
        e.pos[i * 3 + 2] = z;
        e.buoy[i] = rand(...E.buoyancy);
        e.vel[i * 3] = 0;
        e.vel[i * 3 + 1] = E.rise * e.buoy[i];
        e.vel[i * 3 + 2] = 0;
        e.age[i] = 0;
        e.life[i] = this._life();
        e.birthK[i] = rand(...E.birthK);
        // Newton cooling time constant that reaches the Draper point at end of life.
        e.tau[i] = e.life[i] / Math.log((e.birthK[i] - E.ambientK) / (E.draperK - E.ambientK));
        e.size[i] = rand(...E.size);
        e.phase[i] = rand(0, TAU);
        e.flickA[i] = TAU * rand(...E.flicker);
        e.flickB[i] = TAU * rand(...E.flicker);
        for (let k = 0; k < 3; k++) {
            e.rot[i * 3 + k] = rand(0, TAU);
            e.tumble[i * 3 + k] = rand(...E.tumble) * (Math.random() < 0.5 ? -1 : 1);
        }
    }

    /** Ember i has burnt out: its slot's ash carries on from where it was. */
    _toAsh(i) {
        const e = this.e, a = this.a;
        if (a.age[i] < a.life[i]) return;   // the slot's last ash is still drifting
        for (let k = 0; k < 3; k++) {
            a.pos[i * 3 + k] = e.pos[i * 3 + k];
            a.vel[i * 3 + k] = e.vel[i * 3 + k];
            a.rot[i * 3 + k] = e.rot[i * 3 + k];
            a.tumble[i * 3 + k] = e.tumble[i * 3 + k];
        }
        a.age[i] = 0;
        a.life[i] = rand(...ASH.life);
        a.size[i] = e.size[i];
        const grey = rand(...ASH.grey);
        this._c.setRGB(grey, grey, grey, this.THREE.SRGBColorSpace);   // sRGB grey → linear
        this.ash.tints[i * 3] = this._c.r;
        this.ash.tints[i * 3 + 1] = this._c.g;
        this.ash.tints[i * 3 + 2] = this._c.b;
    }

    /** One slot's flight: its velocity eases toward the air's (turbulence
     *  plus a rise slowing with height as z^−⅓) with `ease` per step, then
     *  it moves; leaves the new position in this._p. */
    _fly(pos, vel, i, buoyancy, dt, ease) {
        const E = EMBERS;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const u = this.air.sample(x, y, z, this.time, this._u);
        const rise = E.rise * buoyancy * Math.pow(Math.max(y, E.riseRef) / E.riseRef, -1 / 3);
        vel[i * 3] += (u[0] - vel[i * 3]) * ease;
        vel[i * 3 + 1] += (u[1] + rise - vel[i * 3 + 1]) * ease;
        vel[i * 3 + 2] += (u[2] - vel[i * 3 + 2]) * ease;
        pos[i * 3] = x + vel[i * 3] * dt;
        pos[i * 3 + 1] = y + vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] = z + vel[i * 3 + 2] * dt;
        this._p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }

    /** Blackbody colour at `kelvin` (linear) into `out`. Below the table's
     *  1000 K it keeps that hue; the brightness ramp does the dimming. */
    _blackbody(kelvin, out) {
        const P = this.palette;
        if (kelvin <= P[0][0]) return out.copy(P[0][1]);
        for (let k = 1; k < P.length; k++) {
            if (kelvin <= P[k][0]) {
                return out.copy(P[k - 1][1]).lerp(P[k][1], (kelvin - P[k - 1][0]) / (P[k][0] - P[k - 1][0]));
            }
        }
        return out.copy(P[P.length - 1][1]);
    }

    /** Write instance `i`'s matrix from this._p, a rotation triple and a size. */
    _place(mesh, i, rot, size) {
        this._e.set(rot[i * 3], rot[i * 3 + 1], rot[i * 3 + 2]);
        this._q.setFromEuler(this._e);
        this._s.setScalar(size);
        this._m.compose(this._p, this._q, this._s);
        mesh.setMatrixAt(i, this._m);
    }

    setFade(f) {
        this.embers.mesh.material.uniforms.opacity.value = f;
        this.ash.mesh.material.uniforms.opacity.value = f;
    }

    update(dt) {
        this.time += dt;
        const E = EMBERS, e = this.e, a = this.a;
        const ease = 1 - Math.exp(-dt / E.lag);   // velocity lag toward the air
        const tints = this.embers.tints, alphas = this.embers.alphas;
        for (let i = 0; i < E.count; i++) {
            e.age[i] += dt;
            if (e.age[i] >= e.life[i]) {
                this._toAsh(i);
                this._spawnEmber(i);
            }
            const age = e.age[i];
            if (age < 0) {   // not born yet: hidden
                alphas[i] = 0;
                continue;
            }
            this._fly(e.pos, e.vel, i, e.buoy[i], dt, ease);
            for (let k = 0; k < 3; k++) e.rot[i * 3 + k] += e.tumble[i * 3 + k] * dt;
            this._place(this.embers.mesh, i, e.rot, e.size[i] * EMBER_QUAD);
            // Newton cooling from the birth temperature toward the room's.
            const kelvin = E.ambientK + (e.birthK[i] - E.ambientK) * Math.exp(-age / e.tau[i]);
            this._blackbody(kelvin, this._c);
            tints[i * 3] = this._c.r;
            tints[i * 3 + 1] = this._c.g;
            tints[i * 3 + 2] = this._c.b;
            // Flicker: two slow incommensurate sines, a soft ±15% shimmer.
            const flick = 1 + 0.15 * (0.6 * Math.sin(this.time * e.flickA[i] + e.phase[i])
                + 0.4 * Math.sin(this.time * e.flickB[i] + 2 * e.phase[i]));
            alphas[i] = Math.min(1, age / 0.3) * smoothstep(E.draperK, E.brightK, kelvin) * flick;
        }
        this.embers.mesh.instanceMatrix.needsUpdate = true;
        markDirty(this.embers.mesh.geometry, "tint", "alpha");

        // Ash rides the same air with little lift of its own, fading and
        // shrinking as it goes.
        const A = ASH, ashAlphas = this.ash.alphas;
        for (let i = 0; i < E.count; i++) {
            if (a.age[i] >= a.life[i]) {
                ashAlphas[i] = 0;
                continue;
            }
            a.age[i] += dt;
            const t = Math.min(1, a.age[i] / a.life[i]);
            this._fly(a.pos, a.vel, i, A.buoyancy, dt, ease);
            for (let k = 0; k < 3; k++) a.rot[i * 3 + k] += a.tumble[i * 3 + k] * 0.5 * dt;
            this._place(this.ash.mesh, i, a.rot, a.size[i] * ASH_QUAD * (1 - A.shrink * t));
            ashAlphas[i] = A.alpha * Math.min(1, a.age[i] / 0.4) * (1 - t);
        }
        this.ash.mesh.instanceMatrix.needsUpdate = true;
        markDirty(this.ash.mesh.geometry, "tint", "alpha");
    }

    dispose() {
        for (const part of [this.embers, this.ash]) {
            part.mesh.geometry.dispose();
            part.mesh.material.uniforms.map.value.dispose();
            part.mesh.material.dispose();
        }
    }
}

// ---- Focus lines -----------------------------------------------------------
// Manga focus lines (集中線, shūchūsen): strokes converging on the face, the
// page's standard mark for surprise or shock, good news or bad, which is
// why they carry the surprised mood. Modelled on Clip Studio Paint's
// focus-line tools: strokes spaced by angle with a random variation, some
// gathered into bundles, running in from past the frame edge to a
// reference circle round the focal point and tapering to a point there.
// Redrawn with fresh strokes 12 times a second, anime's "on twos" (each
// drawing held for two frames of 24 fps), so they flicker the way drawn
// focus lines do, and each surprise rushes them in from the edge. They sit
// on a plane just behind the character, who covers the strokes behind
// them. Spacing, variation, bundling, lengths, widths, the clear zone
// round the face and the rush-in are design values: Clip Studio documents
// the parameters but not their defaults.
const FOCUS = {
    max: 160, spacingDeg: 3.2, jitter: 0.6, bundle: 0.35, clear: 0.24, reach: [1, 1.9],
    width: [0.008, 0.026], behind: 0.5, redraw: 1 / 12, rushIn: 0.18, alpha: 0.9, fadeS: 0.25,
};

class FocusLines {
    constructor(THREE) {
        this.fadeS = FOCUS.fadeS;   // snap in and out, not the weather's slow cross-fade
        this.positions = new Float32Array(FOCUS.max * 9);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
        this.material = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
            side: THREE.DoubleSide, toneMapped: false,
        });
        this.object = new THREE.Mesh(geometry, this.material);
        this.object.frustumCulled = false;   // rebuilt round the camera every frame
        this.angle = new Float32Array(FOCUS.max);
        this.reach = new Float32Array(FOCUS.max);
        this.width = new Float32Array(FOCUS.max);
        this.count = 0;
        this.age = 0;        // since the last rush-in
        this.nextDraw = 0;   // seconds to the next drawing
        this._cam = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3();
        this._focus = new THREE.Vector3();
        this._off = new THREE.Vector3();
    }

    /** Another surprise: rush the lines in again. */
    pulse() { this.age = 0; }

    /** A fresh drawing: strokes spaced by angle with a random variation,
     *  some gathered into tight bundles. */
    _redraw() {
        const step = (FOCUS.spacingDeg * Math.PI) / 180;
        let a = rand(0, step), n = 0;
        while (a < TAU && n < FOCUS.max) {
            this.angle[n] = a;
            this.reach[n] = rand(...FOCUS.reach);
            this.width[n] = rand(...FOCUS.width);
            n++;
            const gap = Math.random() < FOCUS.bundle ? 0.35 : 1;
            a += step * gap * (1 + rand(-FOCUS.jitter, FOCUS.jitter));
        }
        this.count = n;
    }

    setFade(f) { this.material.opacity = FOCUS.alpha * f; }

    update(dt, scale, view) {
        this.age += dt;
        const head = view?.head, camera = view?.camera;
        if (!head || !camera) {
            this.object.visible = false;
            return;
        }
        this.nextDraw -= dt;
        if (this.nextDraw <= 0) {
            this._redraw();
            this.nextDraw = FOCUS.redraw;
        }
        // Camera basis, and the focal point: where the ray through the head
        // meets a plane FOCUS.behind past it.
        const e = camera.matrixWorld.elements, P = camera.projectionMatrix.elements;
        const cam = this._cam.set(e[12], e[13], e[14]);
        const right = this._right.set(e[0], e[1], e[2]).normalize();
        const up = this._up.set(e[4], e[5], e[6]).normalize();
        const fwd = this._fwd.set(-e[8], -e[9], -e[10]).normalize();
        const d = this._focus.copy(head).sub(cam).dot(fwd);
        this.object.visible = d > 0.05;
        if (!this.object.visible) return;
        const dp = d + FOCUS.behind;
        const focus = this._focus.multiplyScalar(dp / d).add(cam);
        // The plane's half extents; strokes start past its farthest corner
        // from the focus, which usually sits off centre.
        const halfH = dp / P[5], halfW = dp / P[0];
        const off = this._off.copy(focus).sub(cam).addScaledVector(fwd, -dp);
        const cx = off.dot(right), cy = off.dot(up);
        const outer = 1.02 * Math.max(
            Math.hypot(halfW - cx, halfH - cy), Math.hypot(halfW + cx, halfH - cy),
            Math.hypot(halfW - cx, halfH + cy), Math.hypot(halfW + cx, halfH + cy));
        const clear = (FOCUS.clear * dp) / d;
        const k = Math.min(1, this.age / FOCUS.rushIn);
        const rush = 1 - (1 - k) ** 3;   // ease-out
        const g = this.object.parent?.position;   // the ambience group, anchored at the feet
        const gx = g?.x || 0, gy = g?.y || 0, gz = g?.z || 0;
        const p = this.positions;
        // A point `r` out along the stroke's direction (c, sn in the plane)
        // and `s` across it, in group space.
        const put = (j, r, s, c, sn) => {
            p[j] = focus.x + (c * right.x + sn * up.x) * r + (c * up.x - sn * right.x) * s - gx;
            p[j + 1] = focus.y + (c * right.y + sn * up.y) * r + (c * up.y - sn * right.y) * s - gy;
            p[j + 2] = focus.z + (c * right.z + sn * up.z) * r + (c * up.z - sn * right.z) * s - gz;
        };
        for (let i = 0; i < this.count; i++) {
            const c = Math.cos(this.angle[i]), sn = Math.sin(this.angle[i]);
            const inner = outer + (clear * this.reach[i] - outer) * rush;
            const w = (this.width[i] * halfH) / 2;
            put(i * 9, outer, w, c, sn);
            put(i * 9 + 3, outer, -w, c, sn);
            put(i * 9 + 6, inner, 0, c, sn);
        }
        this.object.geometry.setDrawRange(0, this.count * 3);
        this.object.geometry.getAttribute("position").needsUpdate = true;
    }

    dispose() {
        this.object.geometry.dispose();
        this.material.dispose();
    }
}

const SYSTEMS = {
    rain: Rain, snow: Snow, petals: Petals, fireflies: Fireflies, embers: Embers, focus: FocusLines,
};

/** Mood-reactive mode: a deliberate emotion plays its ambience for a burst
 *  (Ambience.burst); an emotion not listed (neutral) leaves whatever is
 *  playing alone. */
export const MOOD_AMBIENCE = {
    happy: "petals",
    sad: "rain",
    angry: "embers",
    relaxed: "fireflies",
    surprised: "focus",
};

export class Ambience {
    constructor(THREE, scene) {
        this.THREE = THREE;
        this.group = new THREE.Group();
        this.group.name = "ambience";
        scene.add(this.group);
        this._systems = new Map();   // id → live system (fading in or out)
        this._base = "off";
        this._burst = null;          // mood burst playing over the user's pick
        this._burstLeft = 0;         // its seconds to go
        this._current = "off";
    }

    /** The user's pick (Look → Ambience). */
    set(id) {
        this._base = id;
        this._apply();
    }

    /** Play `id` over the user's pick at full strength for `hold` seconds
     *  after its fade-in, then fade back. A new burst replaces the last,
     *  restarting the clock. */
    burst(id, hold) {
        if (!SYSTEMS[id]) return;
        this._burst = id;
        this._burstLeft = hold + FADE_S;
        this._apply();
        this._systems.get(id)?.pulse?.();   // already live: replay its entrance
    }

    /** End a burst now (the user picked something, or switched mood off). */
    clearBurst() {
        if (!this._burst) return;
        this._burst = null;
        this._apply();
    }

    get active() { return this._systems.size > 0; }

    _apply() {
        let want = this._burst || this._base;
        if (!SYSTEMS[want]) want = "off";
        this._current = want;
        if (want !== "off" && !this._systems.has(want)) {
            const sys = new SYSTEMS[want](this.THREE);
            this.group.add(sys.object);
            this._systems.set(want, sys);
        }
    }

    /** Per frame. anchor: the companion's feet (world); heightPx: the
     *  drawing buffer height, for point sizing; view: { camera, head } for
     *  screen-anchored systems (head is null without an avatar). Systems
     *  cross-fade: the current one rises to full, the rest fall and are
     *  dropped at zero, each over its own fadeS or else FADE_S. */
    update(dt, anchor, heightPx, view) {
        if (this._burst && (this._burstLeft -= dt) <= 0) this.clearBurst();
        if (!this._systems.size) return;
        if (anchor) this.group.position.copy(anchor);
        const scale = heightPx / 2;
        for (const [id, sys] of this._systems) {
            const up = id === this._current;
            sys.fade = clamp01((sys.fade || 0) + (up ? dt : -dt) / (sys.fadeS || FADE_S));
            if (!up && sys.fade <= 0) {
                this.group.remove(sys.object);
                sys.dispose();
                this._systems.delete(id);
                continue;
            }
            sys.setFade(sys.fade);
            sys.update(dt, scale, view);
        }
    }

    dispose() {
        for (const sys of this._systems.values()) sys.dispose();
        this._systems.clear();
        this.group.removeFromParent();
    }
}
