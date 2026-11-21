// Roam mode's Gaussian splat gag (models/roam_director.js): a party trick
// the companion does for whoever is at the screen. A spin, and they come
// apart into a cloud of 3D Gaussians (models/roam_splats.js) — every one of
// them a speck of their own hair, face and clothes. The cloud draws itself
// into a beating heart, turning; streams across the screen to the mouse
// pointer and rings it, following wherever it goes; then pours back and
// builds them again from the feet up.
//
// Only the splats are drawn: the box they fly in is as see-through and as
// click-through as the rest of the overlay, and nothing covers the desktop.
// The avatar itself is hidden behind its splats while it runs.
//
// Each splat chases a target of its own (its place in the heart, on the
// ring, or back home) a little faster or slower than its neighbours, with
// a sideways drift that dies away as it arrives, so a move reads as a
// stream with leaders and stragglers, not a cross-fade. Which splat takes
// which place keeps their look: places are handed out top to bottom and
// left to right, so the heart has their hair along its top and their shoes
// at its point.

import { _t } from "../lib/i18n";
import { LIB, rand, clamp, ease, headPage } from "./roam_gags";
import { SplatCloud, sampleBody } from "./roam_splats";

// Splats sampled off the companion, sorted every frame.
const SPLATS = 60000;
// The heart: half its width, and how far above the floor its middle is,
// in standing body heights; a turn every eight seconds; 72 beats a minute
// (a resting heart rate), each a quick double thump.
const HEART_SIZE = 0.6;
const HEART_UP = 0.8;
const HEART_TURN = Math.PI / 4;
const HEART_BPM = 72;
// The ring round the pointer: its radius and its thickness in body
// heights, how far it leans back, how fast it goes round (rad/s).
const RING_R = 0.3;
const RING_TUBE = 0.05;
const RING_TILT = 58 * Math.PI / 180;
const RING_SPIN = 2.6;
// How hard a splat is pulled to its target in each part (1/s; each has
// its own from under half to one and a half times this), and how much it
// drifts sideways on the way. By eye.
const PULL = { burst: 5, heart: 3.2, ring: 4.5, home: 6 };
const DRIFT = { burst: 0, heart: 1.4, ring: 1.0, home: 0.5 };
// Bands the places are handed out in, top to bottom.
const BANDS = 48;

function say(d, text, ms = 1600) {
    const h = headPage(d);
    d.fx.say(text, h.x, h.y - d.body * 0.14, ms);
}

/** `n` points filling a heart about one unit across each way from its
 *  middle (x across, y up, z through, and half as thick as it is wide),
 *  most of them near its skin. The solid is Taubin's heart surface,
 *  (x² + 9/4 y² + z² − 1)³ − x² z³ − 9/80 y² z³ = 0, stood upright. */
function heartPoints(n) {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n;) {
        const x = rand(-1.25, 1.25), depth = rand(-0.72, 0.72), up = rand(-1.1, 1.35);
        const s = x * x + 2.25 * depth * depth + up * up - 1;
        const f = s * s * s - x * x * up * up * up - 0.1125 * depth * depth * up * up * up;
        if (f > 0 || (f < -0.12 && Math.random() < 0.7)) continue;
        out[i * 3] = x;
        out[i * 3 + 1] = up - 0.12;
        out[i * 3 + 2] = depth;
        i++;
    }
    return out;
}

/** Hand the heart's places to the splats so the picture keeps its layout:
 *  both sorted top to bottom into bands of equal number, each band left
 *  to right, paired off in order. Returns the place (x, y, z) per splat. */
function assignPlaces(home, places, n) {
    const byHeight = (arr) => Array.from({ length: n }, (_, i) => i).sort((a, b) => arr[b * 3 + 1] - arr[a * 3 + 1]);
    const mine = byHeight(home), theirs = byHeight(places);
    const out = new Float32Array(n * 3);
    for (let b = 0; b < BANDS; b++) {
        const from = Math.floor(b * n / BANDS), to = Math.floor((b + 1) * n / BANDS);
        const left = mine.slice(from, to).sort((p, q) => home[p * 3] - home[q * 3]);
        const right = theirs.slice(from, to).sort((p, q) => places[p * 3] - places[q * 3]);
        for (let k = 0; k < left.length; k++) out.set(places.subarray(right[k] * 3, right[k] * 3 + 3), left[k] * 3);
    }
    return { place: out, rank: mine };
}

async function gaussianSplat(ctx) {
    const r = this.r;
    if (!this.onFloor || !r.roamShot || !r.vrm || !r.scene || !r.libs) return;
    const { THREE } = r.libs;
    const { width, height } = this.world.area;
    // Somewhere about the middle, so the box that covers the screen from
    // where they stand isn't much wider than it.
    if (this.b.x < width * 0.35 || this.b.x > width * 0.65) await this._walkTo(clamp(this.b.x, width * 0.35, width * 0.65), ctx);
    if (!this.onFloor) return;
    this._face(0);
    say(this, _t("watch this."));
    await this._play(LIB("VRMA_05_spin"), ctx, { maxMs: 3000 });
    this._rest();
    await this._wait(450, ctx);

    // Hidden for the moment the box takes to grow over the screen.
    const bodyPx = this.body;
    const frac0 = this.bodyFrac;
    const footFrac = 1 - this.m.footY / this.box.height;
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    const bw = 2 * Math.max(this.b.x, width - this.b.x), bh = this.b.y / (1 - footFrac);
    this.boxOverride = { left: this.b.x - bw / 2, top: 0, width: bw, height: bh };
    this.bodyFrac = bodyPx / bh;
    this.noGhost = true;
    this._applySize();
    await this._nextFrame();
    await this._nextFrame();
    this._check(ctx);
    const shot = r.roamShot();
    const pxPerM = this.m?.pxPerM;
    if (!shot || !pxPerM) return;

    // Them, as they stand this instant.
    const vrm = r.vrm;
    const cloud = new SplatCloud(THREE, SPLATS);
    const body = sampleBody(cloud, vrm.scene, SPLATS, shot.headY - 0.03);
    if (!body.count) { cloud.dispose(); return; }
    cloud.commit();
    const n = cloud.count;
    const tall = Math.max(0.3, body.max[1] - body.min[1]);
    const mid = { x: (body.min[0] + body.max[0]) / 2, y: (body.min[1] + body.max[1]) / 2, z: (body.min[2] + body.max[2]) / 2 };
    const { seed, home, pos, scale, alpha } = cloud;
    const { place, rank } = assignPlaces(home, heartPoints(n), n);
    // Round the ring in the same order, head to foot: their colours in turn.
    const round = new Float32Array(n);
    rank.forEach((i, k) => { round[i] = (k / n) * Math.PI * 2; });
    r.scene.add(cloud.mesh);
    vrm.scene.visible = false;

    // A point of the page as a point of the scene, at their depth.
    const world = (px, py) => ({ x: shot.x + (px - this.b.x) / pxPerM, y: shot.bottom + (this.b.y - py) / pxPerM });
    const heartAt = { x: mid.x, y: body.min[1] + tall * HEART_UP, z: mid.z };
    const size = tall * HEART_SIZE;
    const cosR = Math.cos(RING_TILT), sinR = Math.sin(RING_TILT);
    const st = { part: "home", fly: 0, snap: 0, t: 0, ringAt: { x: mid.x, y: heartAt.y } };
    const stopFrame = r.addFrameCallback((dt) => {
        st.t += dt;
        const pull = PULL[st.part] || 0, drift = DRIFT[st.part] || 0;
        // Two thumps close together, then a rest, HEART_BPM times a minute.
        const phase = (st.t * HEART_BPM / 60) % 1;
        const beat = 1 + 0.09 * Math.exp(-((phase - 0.08) ** 2) / 0.002) + 0.06 * Math.exp(-((phase - 0.3) ** 2) / 0.003);
        const turn = st.t * HEART_TURN, cosH = Math.cos(turn), sinH = Math.sin(turn);
        // The pointer, or with none to follow, a slow figure of eight.
        const c = this.cursor;
        const want = c ? world(clamp(c.x, 40, width - 40), clamp(c.y, 40, height - 40))
            : { x: mid.x + Math.sin(st.t * 0.9) * tall * 1.2, y: heartAt.y + Math.sin(st.t * 1.8) * tall * 0.3 };
        st.ringAt.x += (want.x - st.ringAt.x) * Math.min(1, dt * 6);
        st.ringAt.y += (want.y - st.ringAt.y) * Math.min(1, dt * 6);
        for (let i = 0; i < n; i++) {
            const hx = home[i * 3], hy = home[i * 3 + 1], hz = home[i * 3 + 2];
            let tx = hx, ty = hy, tz = hz;
            if (st.part === "burst") {
                tx = hx + (hx - mid.x) * 1.6 + (seed[i * 4 + 1] - 0.5) * tall * 0.3;
                ty = hy + (hy - mid.y) * 0.5 + (seed[i * 4 + 2] - 0.3) * tall * 0.3;
                tz = hz + (seed[i * 4 + 3] - 0.5) * tall * 0.5;
            } else if (st.part === "heart") {
                const px = place[i * 3] * size * beat, pz = place[i * 3 + 2] * size * beat;
                tx = heartAt.x + px * cosH + pz * sinH;
                ty = heartAt.y + place[i * 3 + 1] * size * beat;
                tz = heartAt.z - px * sinH + pz * cosH;
            } else if (st.part === "ring") {
                const a = round[i] + st.t * RING_SPIN;
                const rr = tall * (RING_R + (seed[i * 4 + 1] - 0.5) * 2 * RING_TUBE);
                const ry = Math.sin(a) * rr, rz = (seed[i * 4 + 2] - 0.5) * 2 * tall * RING_TUBE;
                tx = st.ringAt.x + Math.cos(a) * rr;
                ty = st.ringAt.y + ry * cosR - rz * sinR;
                tz = mid.z + ry * sinR + rz * cosR;
            }
            let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            // Home builds from the feet up: the lower, the keener.
            const keen = st.part === "home" ? 1.5 - (hy - body.min[1]) / tall : 0.45 + 1.1 * seed[i * 4];
            const f = Math.max(st.snap, 1 - Math.exp(-pull * keen * dt));
            const dx = tx - x, dy = ty - y;
            x += dx * f - dy * drift * dt;
            y += dy * f + dx * drift * dt;
            z += (tz - z) * f;
            pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
            scale[i] = 1 + 0.7 * st.fly;
            alpha[i] = 1 - 0.12 * st.fly;
        }
        // In flight every splat shows, whichever way it faces.
        cloud.cull = 1 - st.fly;
        cloud.frame(r.camera);
    });
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        stopFrame();
        vrm.scene.visible = true;
        cloud.dispose();
    };
    this.onEnd(restore);
    await this._nextFrame();
    await this._nextFrame();
    this._check(ctx);

    // There they are, the same to look at; then they aren't.
    const chest = { x: this.b.x, y: this.b.y - bodyPx * 0.6 };
    this.host.style.opacity = "";
    await this._wait(250, ctx);
    st.part = "burst";
    this.fx.pop(chest.x, chest.y, bodyPx);
    await this._tween(450, (s) => { st.fly = s; });
    this._check(ctx);

    // A heart of them, beating, turning.
    st.part = "heart";
    const heartPx = { x: this.b.x, y: this.b.y - bodyPx * HEART_UP };
    for (let i = 0; i < 4; i++) {
        await this._wait(1250, ctx);
        this.fx.hearts(heartPx.x + rand(-1, 1) * bodyPx * 0.5, heartPx.y - bodyPx * 0.5);
    }

    // Over to the pointer, and round it wherever it goes.
    st.part = "ring";
    await this._wait(5500, ctx);

    // Back, from the feet up.
    st.part = "home";
    await this._wait(1300, ctx);
    await this._tween(1000, (s) => { st.fly = 1 - ease(s); });
    await this._tween(350, (s) => { st.snap = s; });
    this._check(ctx);
    this.host.style.opacity = "0";
    this.fx.pop(chest.x, chest.y, bodyPx * 0.9);
    restore();
    this.boxOverride = null;
    this.bodyFrac = frac0;
    this.noGhost = false;
    this._applySize();
    await this._nextFrame();
    await this._nextFrame();
    this.host.style.opacity = "";
    this._rest();
    this.r.setEmotion?.("happy", { explicit: false });
    say(this, _t("ta-da!"), 1800);
    const h = headPage(this);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    await this._play(LIB("BlowKiss"), ctx, { maxMs: 3500 });
}

export function installSplatGags(proto) {
    Object.assign(proto, { gaussianSplat });
}

// Rare, and it plays out (the director's PLAYS_OUT).
export const SPLAT_GAG_ACTIONS = [
    { id: "gaussian_splat", group: "splat", weight: 1, cooldown: 1800, when: (d) => d.onFloor, run: gaussianSplat },
];
