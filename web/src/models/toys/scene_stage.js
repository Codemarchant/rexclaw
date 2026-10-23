// Toys in the 3D view (the Voice tab's avatar, the mascot's own window): the
// toys' world (models/toys/world.js) in the room itself, as real-size models
// (models/toys/models3d.js) on the floor the companion stands on, lit and
// shadowed with them. The companion walks over to them (renderer
// toyWalkTo), so the play happens in the room, not in front of it.
//
// The pointer: press a toy to pick it up — it moves in the upright plane
// through it, facing the camera — and let go to drop or throw it; a click
// switches a gadget or pops a bubble; the wheel turns one (Shift + wheel
// raises a fan's stand) or steps a lamp's shade; a right-click, or dropping
// it on the tray, puts it away.

import { ToyWorld, headY } from "./world";
import { TOYS, HOOP, GOAL, POSTS, lampLight, puffHz } from "./catalog";
import { buildToyModel, buildHoopModel, buildGoalModel, buildPostsModel, buildTeeModel, bubbleMaterial } from "./models3d";
import { add, bounce, dot, flatDist, len, norm, scale, sub, v3 } from "./physics";
import { playWith, idleAppeal } from "./brains";
import { reactionFor } from "./react";
import { overTray } from "./toybox";
import { bodyFx } from "./body_fx";
import { toySfx } from "./sfx";
import { RoamFx, el } from "../roam_fx";

const UP = v3(0, 1, 0);
// The play area: this far round where the companion stood when the toys
// came out, and never closer to the camera than this share of its distance
// from there (by eye: a toy fetched from there still leaves them in shot).
const AREA_R = 4.5;
const CAMERA_CLEAR = 0.55;
const CLICK_PX = 5;
const CLICK_MS = 350;
// A fan's stand goes up or down this much per wheel notch (by eye).
const RAISE_STEP = 0.05;           // m
// A toy run is this much faster than the stroll (the roam director's run).
const RUN_RATE = 1.7;
// Wait between idle looks at the toys: the roam director's pause (an NPC's
// "Wait 4 s ± 1"), and how keen they are per look (appeal / 100, at most
// half).
const IDLE_MIN_MS = 3000, IDLE_MAX_MS = 5000;
// Widening the shot to show the hoop (by eye).
const FRAME_S = 0.9;
// Fog (as the desktop's) and the mirror ball's light: spots that sweep
// over them in turning colours, pulsing to a 120 bpm beat, their beams
// showing in the air (more in fog), flecks wheeling over the floor, glints
// on the ball (all by eye).
const FOG_RATE = 24;
const FOG_MAX = 300;
const FLECKS = 90;
const DISCO_SPOTS = 6;
const DISCO_SPOT_CD = 14;      // candela: about the key light's brightness on them at 2-3 m (by eye)
const DISCO_BPM = 120;
const DISCO_GLINTS = 10;
// The lamps' light, as candela (lumens over the solid angle it shines
// into), against the room's: the default preset's key light (1.2) taken as
// a lit living room's 300 lux (by eye), so a lamp lights them as much more
// or less than the room as it would at home.
const KEY_LIGHT = 1.2, KEY_LUX = 300;
const LAMP_CD_PER_CD = KEY_LIGHT / KEY_LUX;
// With a lamp or the mirror ball on, the room's own light goes down to
// this (by eye: an evening with the big light off).
// A noodle bowl's chopsticks reach this far past the fingers (models3d.js:
// 22 cm sticks held a third of the way down).
const STICK_TIP = 0.15;            // m
const LAMP_DIM = 0.3;
const DISCO_DIM = 0.55;
// Lamps are set down round them, this far out (by eye).
const LAMP_SPOTS = [[1.3, 0.5], [-1.3, 0.5], [1.7, -0.2], [-1.7, -0.2], [0.9, 1.4], [-0.9, 1.4], [2.2, 0.9], [-2.2, 0.9]];
// The night a campfire or the galaxy projector brings comes and goes over
// this long; the projector's shooting stars cross in SHOOT_S, one every
// SHOOT_EVERY seconds (all by eye).
const NIGHT_FADE_S = 1.5;
const SHOOT_S = 0.9;
const SHOOT_EVERY = [15, 40];

const rand = (a, b) => a + Math.random() * (b - a);
const now = () => performance.now();

class Interrupt extends Error {
    constructor(reason) { super(reason); this.reason = reason; }
}

const FOG_VERTEX = /* glsl */`
    attribute float size;
    attribute float alpha;
    uniform float scale;
    varying float vAlpha;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(512.0, size * scale * projectionMatrix[1][1] / -mv.z);
        gl_Position = projectionMatrix * mv;
        vAlpha = alpha;
    }`;
const FOG_FRAGMENT = /* glsl */`
    uniform vec3 tint;
    varying float vAlpha;
    void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c));
        gl_FragColor = vec4(tint, a * a * vAlpha);
        #include <colorspace_fragment>
    }`;

export class SceneStage extends ToyWorld {
    /** renderer: the avatar renderer (its scene, camera, companion). host:
     *  the element over its canvas (pointer and effects). */
    constructor({ renderer, host, box = null, kind = "scene" }) {
        super({ dims: 3 });
        this.kind = kind;
        this.r = renderer;
        this.host = host;
        this.box = box;
        this.THREE = renderer.libs.THREE;
        this.root = new this.THREE.Group();
        this.root.name = "toys";
        renderer.scene.add(this.root);
        this.overlay = el("rx_roam_over rx_toys_overlay", host);
        this.rfx = new RoamFx(this.overlay, this.overlay, this.overlay);
        this.bodyApi = new SceneBody(this);
        this.companion = new ToyCompanion(this);
        // A group call's other companions: a body and routines each, by
        // their peer id (made as their avatars appear, _syncPeers).
        this.peers = new Map();
        // Where they stood before the toys: back there when the toys are
        // put away (goHome).
        this.home = this._feet();
        this.fog = [];
        this._waiters = [];
        this._ptr = null;
        this.dragging = false;
        this.on((evt) => this._onEvent(evt));
        this._bindPointer();
        this._off = renderer.addFrameCallback((dt) => this._frame(dt));
        this._offXr = renderer.addXRSessionListener?.({ onStart: () => this._halt() });
        renderer.toyHalt = this._toyHalt = () => this._halt();
        // Console handle: __toys.toss(__toys.TOYS.donut).
        window.__toys = this;
    }

    get TOYS() { return TOYS; }

    dispose() {
        // First: clearing the toys below empties the box, and an empty box
        // sends them home (goHome), which must find the stage gone.
        this.disposed = true;
        this._off?.();
        this._offXr?.();
        if (this.r.toyHalt === this._toyHalt) this.r.toyHalt = null;
        this._unbind?.();
        for (const c of this.runners()) { c.stop(); c.body.setBusy(null); }
        this.clear();
        toySfx.stopAll();
        this.r.setToyWind?.(null);
        this.r.setToyDim?.(1);
        this.r.toyBusy = null;
        this._disco(false);
        this._night(false);
        this._fogPoints?.geometry.dispose();
        this._fogPoints?.material.dispose();
        this.root.removeFromParent();
        this.overlay.remove();
        for (const w of this._waiters) w();
        this._waiters = [];
        if (window.__toys === this) delete window.__toys;
    }

    get ground() { return this.r._meshBottomY ?? 0; }

    /** The play area's radius round home: wider while the rugby posts are
     *  out, to take in their net. */
    get areaR() {
        const g = this.posts;
        if (!g) return AREA_R;
        let far = 0;
        for (const s of [-1, 1]) {
            const p = add(sub(g.base, scale(g.face, POSTS.netBack)), scale(g.side, (s * POSTS.netW) / 2));
            far = Math.max(far, flatDist(p, this.home));
        }
        return Math.max(AREA_R, far + 0.3);
    }

    _feet() {
        const p = this.r.vrm?.scene.position;
        return p ? { x: p.x, y: this.ground, z: p.z } : { x: 0, y: this.ground, z: 0 };
    }

    nextFrame() { return new Promise((res) => this._waiters.push(res)); }

    /** The body wanted elsewhere (avatar_renderer toyPaused): VR, where no
     *  frame callbacks run and a routine waiting on the next frame would
     *  hold the body for the whole session, or a photoshoot posing it.
     *  Routines stop (and none start till it's over, ToyCompanion.request). */
    _halt() {
        for (const c of this.runners()) c.stop();
        const w = this._waiters;
        this._waiters = [];
        for (const fn of w) fn();
    }

    // ── the camera ───────────────────────────────────────────────────────

    _camFwd() {
        const cam = this.r.camera;
        const f = new this.THREE.Vector3();
        cam.getWorldDirection(f);
        f.y = 0;
        if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
        f.normalize();
        return { x: f.x, y: 0, z: f.z };
    }

    /** How far in front of the camera the toys keep. */
    _cameraClear() {
        const cam = this.r.camera.position;
        return Math.max(0.7, CAMERA_CLEAR * Math.hypot(cam.x - this.home.x, cam.z - this.home.z));
    }

    _camRight() {
        const f = this._camFwd();
        return { x: -f.z, y: 0, z: f.x };
    }

    _ray(clientX, clientY) {
        const { THREE } = this;
        const rect = this.r.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
        const ray = (this._raycaster ||= new THREE.Raycaster());
        ray.setFromCamera(ndc, this.r.camera);
        return ray.ray;
    }

    /** A world point in the overlay's px. */
    page(p) {
        const v = new this.THREE.Vector3(p.x, p.y, p.z).project(this.r.camera);
        const rect = this.overlay.getBoundingClientRect();
        return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
    }

    /** Pull the orbit camera back (keeping its angle) to show `points`. */
    frameTo(points) {
        const cam = this.r.toyCamera?.();
        if (!cam) return;
        const { THREE } = this;
        const box = new THREE.Box3();
        for (const p of points) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const half = Math.min(cam.fov, cam.fov * cam.aspect) * Math.PI / 360;
        // A margin all round, so no one ends up under the tray at an edge
        // (by eye).
        const need = (sphere.radius * 1.35) / Math.sin(half);
        const dir = new THREE.Vector3().subVectors(cam.position, cam.target).normalize();
        const dist = Math.max(need, cam.position.distanceTo(cam.target));
        this._framed = true;
        this._camTween = {
            t: 0,
            fromP: cam.position.clone(), fromT: cam.target.clone(),
            toT: sphere.center.clone(), toP: sphere.center.clone().addScaledVector(dir, dist),
        };
    }

    _tweenCamera(dt) {
        const tw = this._camTween;
        if (!tw) return;
        tw.t = Math.min(1, tw.t + dt / FRAME_S);
        const s = tw.t * tw.t * (3 - 2 * tw.t);
        this.r.setToyCamera(tw.fromP.clone().lerp(tw.toP, s), tw.fromT.clone().lerp(tw.toT, s));
        if (tw.t >= 1) this._camTween = null;
    }

    // ── the world (ToyWorld's hooks) ─────────────────────────────────────

    body() {
        const vrm = this.r.vrm;
        if (!vrm) return null;
        const yaw = this.r._moveYaw || 0;
        const p = vrm.scene.position;
        return {
            pos: { x: p.x, y: this.ground, z: p.z },
            height: this.bodyApi.height,
            facing: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
        };
    }

    holdPoint(t) {
        const b = t.holder || this.bodyApi;
        const q = t.grip === "right" ? b._bone(["rightMiddleProximal", "rightHand"])
            : t.grip === "left" ? b._bone(["leftMiddleProximal", "leftHand"])
                : b._mid(["leftMiddleProximal", "leftHand"], ["rightMiddleProximal", "rightHand"]);
        if (!q) return null;
        // Held up by its foot: a banana stands up out of the fist, an ice
        // cream's cone sits in it.
        if (t.def.food?.style === "peel") q.y += t.radius * 2.2;
        if (t.def.food?.style === "lick") q.y += t.radius * 0.6;
        // A bottle by its middle (its drawing's centre, above its foot).
        if (t.def.food?.style === "bottle") q.y -= t.def.art.cy;
        // A wand is held by the middle of its handle: the ring a hand's
        // width above the fist, at the mouth in the blowing pose.
        if (t.def.kind === "wand") q.y += t.radius * 0.25;
        return q;
    }

    collideWorld(t) {
        const r = t.radius;
        let floor = null;
        const g = this.ground;
        if (t.p.y - r < g) {
            this._impact(t, bounce(t, UP, g + r - t.p.y));
            floor = UP;
        }
        // The edge of the play area (bubbles drift on past it).
        const dx = t.p.x - this.home.x, dz = t.p.z - this.home.z;
        const d = Math.hypot(dx, dz), R = this.areaR;
        if (d + r > R && t.def.kind !== "bubble") this._impact(t, bounce(t, { x: -dx / d, y: 0, z: -dz / d }, d + r - R));
        // Never behind (or into) the camera.
        const cam = this.r.camera.position, f = this._camFwd();
        const ahead = (t.p.x - cam.x) * f.x + (t.p.z - cam.z) * f.z;
        const clear = this._cameraClear();
        if (ahead - r < clear) this._impact(t, bounce(t, f, clear + r - ahead));
        return floor;
    }

    _impact(t, sp) {
        if (sp <= 0.4) return;
        if (t.view) t.view.sq = Math.min(1, sp / 5);
        if (sp > 0.8) toySfx.bounce(sp, t.def.kind === "coin" ? "coin" : t.def.id);
    }

    placeHoop(near) {
        // Off to the side the camera sees most of, the board facing back
        // across to them: the shot is seen side on.
        const right = this._camRight(), f = this._camFwd();
        const side = Math.random() < 0.5 ? 1 : -1;
        const dist = 4.4;
        const base = add(add(near, scale(right, side * dist)), scale(f, 0.6));
        const face = norm(sub({ ...near, y: 0 }, { ...base, y: 0 }));
        return { x: base.x, y: this.ground, z: base.z, face };
    }

    ensureHoop(near) {
        const fresh = !this.hoop;
        const h = super.ensureHoop(near);
        if (fresh) {
            const b = this.body();
            this.frameTo([h.base, { ...h.rim, y: h.rim.y + 0.6 }, b.pos, add(b.pos, v3(0, b.height, 0))]);
        }
        return h;
    }

    shootingSpot(hoop, d) {
        return { x: hoop.base.x + hoop.face.x * d, y: this.ground, z: hoop.base.z + hoop.face.z * d };
    }

    placeGoal(near) {
        // Side on like the hoop, far enough over that the penalty spot falls
        // a little to the other side of where they stand, inside the area.
        const right = this._camRight(), f = this._camFwd();
        const side = Math.random() < 0.5 ? 1 : -1;
        const base = add(add(near, scale(right, side * (GOAL.spot / 2 + 0.4))), scale(f, 0.4));
        const face = norm(sub({ ...near, y: 0 }, { ...base, y: 0 }));
        return { x: base.x, y: this.ground, z: base.z, face };
    }

    ensureGoal(near) {
        const fresh = !this.goal;
        const g = super.ensureGoal(near);
        if (fresh) {
            const b = this.body();
            const spot = this.penaltySpot(g);
            this.frameTo([add(g.base, scale(g.side, GOAL.width / 2)), add(g.base, add(scale(g.side, -GOAL.width / 2), v3(0, GOAL.height + 0.3, 0))),
                spot, add(spot, v3(0, b.height, 0)), b.pos]);
        }
        return g;
    }

    penaltySpot(goal) {
        return { x: goal.base.x + goal.face.x * GOAL.spot, y: this.ground, z: goal.base.z + goal.face.z * GOAL.spot };
    }

    placePosts(near) {
        // Side on like the goal, but set back: the posts stand 5.6 m apart
        // along the view, so the near one comes level with where they stand
        // and the far one well back, and the kick runs across the room
        // behind them.
        const right = this._camRight(), f = this._camFwd();
        const side = Math.random() < 0.5 ? 1 : -1;
        const base = add(add(near, scale(right, side * (POSTS.spot / 2 + 0.4))), scale(f, POSTS.width / 2 + 0.3));
        return { x: base.x, y: this.ground, z: base.z, face: scale(right, -side) };
    }

    ensurePosts(near) {
        const fresh = !this.posts;
        const g = super.ensurePosts(near);
        if (fresh) {
            // The near post, the bar's middle and the mark (the far post
            // stands back toward the middle of the shot anyway).
            const b = this.body();
            const spot = this.kickSpot(g);
            const nearSide = dot(sub(this.r.camera.position, g.base), g.side) > 0 ? 1 : -1;
            const near = add(g.base, scale(g.side, (nearSide * POSTS.width) / 2));
            this.frameTo([near, add(near, v3(0, POSTS.height + 0.3, 0)), add(g.base, v3(0, POSTS.bar + 0.3, 0)),
                spot, add(spot, v3(0, b.height, 0)), b.pos]);
        }
        return g;
    }

    kickSpot(posts) {
        return { x: posts.base.x + posts.face.x * POSTS.spot, y: this.ground, z: posts.base.z + posts.face.z * POSTS.spot };
    }

    /** A lamp set down where none stands yet, round where they are,
     *  toward the back of the shot. */
    _lampSpot(def) {
        const b = this.body();
        const at = b ? b.pos : this.home;
        const right = this._camRight(), f = this._camFwd();
        for (const [s, d] of LAMP_SPOTS) {
            const p = add(add(at, scale(right, s)), scale(f, d));
            if (this.toys.every((t) => !t.alive || flatDist(t.p, p) > t.radius + def.radius + 0.25)) return p;
        }
        return add(add(at, scale(right, rand(-2, 2))), scale(f, rand(0.5, 1.5)));
    }

    inFrontOf(t, d) {
        const a = norm({ x: t.aim.x, y: 0, z: t.aim.z });
        return { x: t.p.x + a.x * d, y: this.ground, z: t.p.z + a.z * d };
    }

    /** In front of the camera, a little below its eye: where a toy is
     *  thrown back to. */
    userPoint() {
        const cam = this.r.camera.position, f = this._camFwd();
        const d = this._cameraClear() + 0.35;
        return { x: cam.x + f.x * d, y: Math.max(this.ground + 0.8, cam.y - 0.45), z: cam.z + f.z * d };
    }

    /** Across the view: the angle between the toy and a mouth from the
     *  camera, as metres at the mouth's distance; the nearest mouth's, in a
     *  group call (whose, kept for the offer: _offerTo). */
    offerGap(t) {
        const cam = this.r.camera.position;
        let best = Infinity;
        for (const c of this.runners()) {
            const a = sub(c.body.mouth(), cam), b = sub(t.p, cam);
            const la = len(a), lb = len(b);
            if (la < 1e-6 || lb < 1e-6) continue;
            const gap = Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * la;
            if (gap < best) { best = gap; this._offerTo = c; }
        }
        return best;
    }

    /** Whose routines: the main companion's, then each peer's. */
    runners() { return [this.companion, ...(this.peers?.values() || [])]; }

    /** A group call's companions as their avatars come and go. */
    _syncPeers() {
        const live = this.r._peers;
        for (const [id, c] of this.peers) {
            if (!live?.get(id)?.vrm) { c.stop(); c.body.setBusy(null); this.peers.delete(id); }
        }
        for (const [id, actor] of live || []) {
            if (actor.vrm && !this.peers.has(id)) this.peers.set(id, new ToyCompanion(this, new PeerBody(this, id)));
        }
    }

    /** `body` has taken `toy`: anyone else after it stops. */
    claimed(toy, body) {
        for (const c of this.runners()) if (c.body !== body) c.cancelFor(toy);
    }

    // ── reactions ────────────────────────────────────────────────────────

    _onEvent(evt) {
        if (evt.type === "add" || evt.type === "remove") this.box?.changed?.();
        if ((evt.type === "switch" || evt.type === "shade") && evt.toy.def.kind === "lamp") this._lampLook(evt.toy);
        if (evt.type === "taken") for (const c of this.runners()) c.cancelFor(evt.toy);
        const r = reactionFor(evt);
        if (!r) return;
        // Held out to someone's mouth: theirs; the rest is the main one's.
        if (r.why === "offer" && this._offerTo) this._offerTo.request(r);
        else this.companion.request(r);
    }

    // ── the tray ─────────────────────────────────────────────────────────

    spawnDrag(def, ev) {
        const b = this.body();
        const ray = this._ray(ev.clientX, ev.clientY);
        const at = b ? b.pos : this.home;
        const p = this._onUpright(ray, at) || add(at, v3(0, 1, 0));
        p.y = Math.max(this.ground + def.radius, p.y);
        const t = this.add(def, p);
        this._startDrag(t, ev, true);
        return t;
    }

    toss(def) {
        const cam = this.r.camera.position, f = this._camFwd();
        const out = this._cameraClear() + 0.25;
        const from = { x: cam.x + f.x * out, y: Math.max(this.ground + 0.5, cam.y - 0.4), z: cam.z + f.z * out };
        const t = this.add(def, from);
        const b = this.body();
        if (def.kind === "lamp") {
            // Set down round them (hung up, a lantern or a sign), off.
            const p = this._lampSpot(def);
            t.p = { x: p.x, y: this.ground + (def.hang ?? def.radius), z: p.z };
            t.v = v3();
            t.hovering = !!def.hovers;
            return t;
        }
        if (def.gadget || def.tool || def.placed || !b) {
            const right = this._camRight();
            const spot = add(b ? b.pos : this.home, scale(right, 0.85));
            t.p = { x: spot.x, y: def.hovers ? this.ground + (b ? b.height : 1.6) * 0.95 : this.ground + def.radius + 0.4, z: spot.z };
            t.v = v3();
            t.hovering = !!def.hovers;
            // A chest set down (or anything, with no one to throw it to):
            // they'll come and see once it has landed.
            if (def.placed || (!b && !def.gadget && !def.tool)) this.emit("drop", t);
            if (b && def.jet) t.aim = t.baseAim = norm({ x: b.pos.x - t.p.x, y: 0, z: b.pos.z - t.p.z });
            return t;
        }
        this.lob(t, from);
        return t;
    }

    /** The toys are all put away: back to where they stood, facing the
     *  camera, and the shot as it was if it was widened for a hoop or a
     *  goal. */
    async goHome() {
        // What they're in the middle of first (the last treat's "yum!"):
        // the user putting toys away stops their routines (putAway, clear).
        const t0 = now();
        while ((this.companion.cur || this.companion.next) && !this.disposed && now() - t0 < 15000) await this.nextFrame();
        if (this.disposed || this.count((t) => t.def.cat)) return;
        this.companion.stop();
        const r = this.r;
        if (!r.vrm) return;
        const p = r.vrm.scene.position;
        if (Math.hypot(p.x - this.home.x, p.z - this.home.z) > 0.1 && r.toyWalkTo(this.home.x, this.home.z)) {
            const t0 = now();
            while (r.toyWalking && !this.disposed && now() - t0 < 12000) await this.nextFrame();
        }
        if (this.disposed) return;
        r.toyFaceCamera();
        if (this._framed) {
            this._framed = false;
            r.toyReframe?.();
        }
    }

    // ── pointer ──────────────────────────────────────────────────────────

    /** Where `ray` meets the upright plane through `at` facing the camera. */
    _onUpright(ray, at) {
        const { THREE } = this;
        const f = this._camFwd();
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(f.x, 0, f.z), new THREE.Vector3(at.x, at.y, at.z));
        const hit = ray.intersectPlane(plane, new THREE.Vector3());
        return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
    }

    /** The toy under a client point, or null. */
    toyAt(x, y) {
        const ray = this._ray(x, y);
        const { THREE } = this;
        const c = new THREE.Vector3();
        let best = null, bd = Infinity;
        for (const t of this.toys) {
            if (!t.alive || t.def.kind === "bubble") continue;
            const spheres = [[t.p, t.radius * 1.25 + 0.03]];
            if (t.def.headY) {
                const up = headY(t) - t.radius;
                spheres.push([add(t.p, v3(0, up, 0)), 0.28], [add(t.p, v3(0, up / 2, 0)), 0.12]);
            }
            for (const [up, r] of t.def.grab || []) spheres.push([add(t.p, v3(0, up, 0)), r]);
            for (const [p, r] of spheres) {
                c.set(p.x, p.y, p.z);
                if (ray.distanceSqToPoint(c) > r * r) continue;
                const d = ray.origin.distanceTo(c);
                if (d < bd) { bd = d; best = t; }
            }
        }
        return best;
    }

    /** The soap bubble under a client point (a little generously: they're
     *  small and drifting), or null. */
    bubbleAt(x, y) {
        const ray = this._ray(x, y);
        const c = new this.THREE.Vector3();
        let best = null, bd = Infinity;
        for (const t of this.toys) {
            if (!t.alive || t.def.kind !== "bubble") continue;
            c.set(t.p.x, t.p.y, t.p.z);
            const r = t.radius + 0.02;
            if (ray.distanceSqToPoint(c) > r * r) continue;
            const d = ray.origin.distanceTo(c);
            if (d < bd) { bd = d; best = t; }
        }
        return best;
    }

    hitTest(x, y) { return this.dragging || !!this.toyAt(x, y) || !!this.bubbleAt(x, y); }

    _bindPointer() {
        const host = this.host;
        const down = (ev) => {
            if (ev.button !== 0 || this.dragging) return;
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t) {
                // A bubble: popped.
                const b = this.bubbleAt(ev.clientX, ev.clientY);
                if (!b) return;
                ev.stopPropagation();
                ev.preventDefault();
                this.popBubble(b, "user");
                return;
            }
            ev.stopPropagation();
            ev.preventDefault();
            this._startDrag(t, ev, false);
        };
        // Over a toy, the hand shows it can be picked up (nothing moves).
        const move = (ev) => {
            if (this.dragging) return;
            host.style.cursor = this.toyAt(ev.clientX, ev.clientY) ? "grab" : this.bubbleAt(ev.clientX, ev.clientY) ? "pointer" : "";
        };
        const leave = () => { host.style.cursor = ""; };
        const wheel = (ev) => {
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t?.def.jet && !t?.def.shades) return;
            ev.preventDefault();
            ev.stopPropagation();
            // A lamp: its next shade. Shift: the fan's stand up or down;
            // plain: turn it round.
            if (t.def.shades) this.shade(t, Math.sign(ev.deltaY || ev.deltaX) || 1);
            else if (ev.shiftKey && t.def.headRange) this.raise(t, -Math.sign(ev.deltaY || ev.deltaX) * RAISE_STEP);
            else this.turn(t, Math.sign(ev.deltaY) * 15 * Math.PI / 180);
        };
        // Right-click a toy: put it away.
        const menu = (ev) => {
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t) return;
            ev.stopPropagation();
            ev.preventDefault();
            this.putAway(t);
        };
        host.addEventListener("pointerdown", down, true);
        host.addEventListener("pointermove", move, true);
        host.addEventListener("pointerleave", leave);
        host.addEventListener("wheel", wheel, { capture: true, passive: false });
        host.addEventListener("contextmenu", menu, true);
        this._unbind = () => {
            host.removeEventListener("pointerdown", down, true);
            host.removeEventListener("pointermove", move, true);
            host.removeEventListener("pointerleave", leave);
            host.removeEventListener("wheel", wheel, true);
            host.removeEventListener("contextmenu", menu, true);
            host.style.cursor = "";
            this._endDrag?.();
        };
    }

    /** One toy back in the box (a right-click, or dropped on the tray):
     *  whatever they were doing with it stops. */
    putAway(t) {
        toySfx.pop();
        for (const c of this.runners()) c.cancelFor(t);
        this.remove(t);
    }

    /** Everything back in the box: they stop playing. */
    clear() {
        if (this.companion) for (const c of this.runners()) c.stop();
        super.clear();
    }

    onRaise() { /* the stand is sized per frame from headY */ }

    _startDrag(t, ev, fromTray) {
        const start = { x: ev.clientX, y: ev.clientY, at: now(), moved: fromTray, hovered: t.hovering };
        const ray = this._ray(ev.clientX, ev.clientY);
        const hit = this._onUpright(ray, t.p);
        const offset = !fromTray && hit ? sub(t.p, hit) : v3();
        const anchor = { ...t.p };
        this.grab(t);
        this.dragging = true;
        this.host.style.cursor = "grabbing";
        const move = (e) => {
            if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX) start.moved = true;
            const q = this._onUpright(this._ray(e.clientX, e.clientY), anchor);
            if (!q) return;
            let p = add(q, offset);
            p.y = Math.max(this.ground + t.radius, p.y);
            // Inside the play area.
            const dx = p.x - this.home.x, dz = p.z - this.home.z, d = Math.hypot(dx, dz), R = this.areaR;
            if (d > R - t.radius) p = { ...p, x: this.home.x + (dx / d) * (R - t.radius), z: this.home.z + (dz / d) * (R - t.radius) };
            this.dragTo(p);
        };
        const up = (e) => {
            this._endDrag();
            // Let go over the tray: back in the box.
            if (overTray(e)) { this.drag = null; this.putAway(t); return; }
            if (!start.moved && now() - start.at < CLICK_MS) {
                this.drag = null;
                t.heldBy = null;
                t.v = v3();
                t.hovering = start.hovered;
                this.toggle(t);
                if (t.def.kind === "plush") toySfx.squeak();
                return;
            }
            this.release();
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
        this._endDrag = () => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", up, true);
            this.dragging = false;
            this.host.style.cursor = "";
            this._endDrag = null;
        };
    }

    // ── frames ───────────────────────────────────────────────────────────

    _frame(dt) {
        if (this.disposed) return;
        if (this.toys.length || this.fog.length || this.hoop || this.goal) this.step(dt);
        // The room's own light down while a lamp or the mirror ball is on,
        // as far as the darkest lamp on takes it (every frame: the last lamp
        // put away stops the steps above).
        // (Loops, not filters: this runs every frame the view is open, toys
        // out or not.)
        let dim = Infinity;
        for (const t of this.toys) if (t.on && t.def.kind === "lamp") dim = Math.min(dim, t.def.lamp.dim ?? LAMP_DIM);
        if (dim === Infinity) dim = this.discoOn() ? DISCO_DIM : 1;
        if (dim !== this._dim) { this._dim = dim; this.r.setToyDim?.(dim); }
        // Likewise the mirror ball's lights and the night, when it was the
        // last one out.
        if (this._discoFx && !this.toys.length) this._disco(false);
        if (this._nightFx && !this.toys.length) { this._nightFade = 0; this._night(false); }
        this._tweenCamera(dt);
        const blowing = this.toys.some((t) => t.on && t.def.jet);
        this.r.setToyWind(blowing ? (this._windFn ||= (p) => this.windAt(p)) : null);
        this._syncPeers();
        this.companion.tick(dt);
        for (const c of this.peers.values()) c.tick(dt);
        const w = this._waiters;
        this._waiters = [];
        for (const fn of w) fn();
    }

    // ── drawing ──────────────────────────────────────────────────────────

    viewAdd(t) {
        const { THREE } = this;
        const { group, parts } = buildToyModel(THREE, t.def, t.radius);
        group.position.set(t.p.x, t.p.y, t.p.z);
        this.root.add(group);
        t.view = { group, parts, sq: 0, q: new THREE.Quaternion(), lid: 0 };
        if (t.def.kind !== "bubble") {
            group.scale.setScalar(0.01);
            t.view.pop = 0;
        }
        if (t.def.kind === "lamp") {
            // Its front to the camera; its light (off for now).
            const f = this._camFwd();
            t.view.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-f.x, -f.z));
            const L = t.def.lamp;
            const light = L.spot
                ? new THREE.SpotLight("#ffffff", 0, 0, (L.spot / 2) * Math.PI / 180, 0.5, 2)
                : new THREE.PointLight("#ffffff", 0, 0, 2);
            // A projector's spot throws its picture (models3d parts.cookie).
            if (light.isSpotLight && t.view.parts.cookie) light.map = t.view.parts.cookie;
            this.root.add(light);
            if (light.target) this.root.add(light.target);
            t.view.light = light;
            this._lampLook(t);
        }
    }

    /** A lamp's look and light for its state: on or off, its shade. */
    _lampLook(t) {
        const v = t.view;
        if (!v?.light) return;
        const def = t.def, i = t.shade || 0;
        const { color, lm } = lampLight(def, i);
        v.parts.look?.({ on: t.on, shade: def.shades[i], light: color });
        v.light.color.set(color);
        // Candela: its lumens over the solid angle it shines into (a spot's
        // cone, or all round), scaled to the room (LAMP_CD_PER_CD).
        const half = def.lamp.spot ? (def.lamp.spot / 2) * Math.PI / 180 : Math.PI;
        const solid = 2 * Math.PI * (1 - Math.cos(half));
        v.cd = (lm / solid) * LAMP_CD_PER_CD;
        v.light.intensity = t.on ? v.cd : 0;
    }

    viewRemove(t) {
        const v = t.view;
        t.view = null;
        if (!v) return;
        if (v.light) {
            v.light.target?.removeFromParent();
            v.light.removeFromParent();
            v.light.dispose();
        }
        v.group.removeFromParent();
        v.group.traverse((o) => {
            if (!o.isMesh && !o.isPoints && !o.isSprite) return;
            // (Sprites all share one geometry.)
            if (!o.isSprite) o.geometry?.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            // The bubbles' film is one material for them all.
            for (const m of mats) if (m && m !== bubbleMaterial(this.THREE)) { m.map?.dispose(); m.dispose(); }
        });
    }

    onBite() { /* scaled per frame from t.left */ }

    /** A banana's peel coming down a strip at a time. */
    onPeel(t) {
        const p = t.view?.parts;
        if (!p?.peel) return;
        const n = Math.round((t.peeled || 0) * p.peel.length);
        p.peel.forEach((s, i) => { s.visible = i < n; });
        for (const m of p.skinTop) m.visible = n === 0;
    }

    /** A noodle bowl's chopsticks: across the bowl, or in their right hand
     *  while they eat, the tips down in the bowl and turning to the mouth
     *  as the hand comes up, noodles hanging off them on the way. */
    _sticks(t, v) {
        const { THREE } = this;
        const s = v.parts.sticks;
        const eating = t.heldBy === "companion" && t.def.food?.style === "slurp";
        if (!eating) {
            s.position.copy(s.userData.rest.position);
            s.quaternion.copy(s.userData.rest.quaternion);
            v.parts.strands.visible = false;
            return;
        }
        // Pinched between the thumb and the index finger, the tips down in
        // the bowl, turning to the mouth as the hand comes up to it.
        const b = t.holder || this.bodyApi, mouth = b.mouth();
        const pinch = b._mid(["rightIndexIntermediate", "rightIndexProximal"], ["rightThumbDistal", "rightThumbIntermediate"]);
        if (!pinch || !mouth) return;
        const k = Math.min(1, Math.max(0, (pinch.y - t.p.y) / Math.max(0.05, mouth.y - t.p.y)));
        const bowl = { x: t.p.x, y: t.p.y + 0.01, z: t.p.z };
        const to = { x: bowl.x + (mouth.x - bowl.x) * k, y: bowl.y + (mouth.y - bowl.y) * k, z: bowl.z + (mouth.z - bowl.z) * k };
        const dir = new THREE.Vector3(to.x - pinch.x, to.y - pinch.y, to.z - pinch.z);
        const gap = dir.length();
        if (gap < 1e-3) return;
        dir.normalize();
        // Up at the mouth the tips stop there: held further up the sticks
        // when the hand is nearer than they reach (STICK_TIP).
        const back = Math.max(0, STICK_TIP - gap) * k;
        const inv = v.group.quaternion.clone().invert();
        s.position.set(pinch.x - dir.x * back - t.p.x, pinch.y - dir.y * back - t.p.y, pinch.z - dir.z * back - t.p.z).applyQuaternion(inv);
        s.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.applyQuaternion(inv));
        // Noodles hang straight down off the tips, whichever way they point.
        v.parts.strands.quaternion.copy(s.quaternion).invert();
        v.parts.strands.visible = k > 0.35 && t.left > 0.05;
    }

    viewPosts(g) {
        if (this._postsView) {
            this._postsView.group.removeFromParent();
            this._postsView = null;
        }
        if (!g) return;
        const v = buildPostsModel(this.THREE, POSTS);
        v.group.position.set(g.base.x, g.base.y, g.base.z);
        v.group.rotation.y = Math.atan2(g.face.x, g.face.z);
        this.root.add(v.group);
        this._postsView = v;
    }

    viewTee(tee) {
        if (this._teeView) {
            this._teeView.group.removeFromParent();
            this._teeView = null;
        }
        if (!tee) return;
        const v = buildTeeModel(this.THREE, POSTS);
        v.group.position.set(tee.p.x, tee.p.y, tee.p.z);
        this.root.add(v.group);
        this._teeView = v;
    }

    viewHoop(h) {
        if (this._hoopView) {
            this._hoopView.group.removeFromParent();
            this._hoopView = null;
        }
        if (!h) return;
        const v = buildHoopModel(this.THREE, HOOP);
        v.group.position.set(h.base.x, h.base.y, h.base.z);
        v.group.rotation.y = Math.atan2(h.face.x, h.face.z);
        this.root.add(v.group);
        this._hoopView = v;
    }

    viewGoal(g) {
        if (this._goalView) {
            this._goalView.group.removeFromParent();
            this._goalView = null;
        }
        if (!g) return;
        const v = buildGoalModel(this.THREE, GOAL);
        v.group.position.set(g.base.x, g.base.y, g.base.z);
        v.group.rotation.y = Math.atan2(g.face.x, g.face.z);
        this.root.add(v.group);
        this._goalView = v;
    }

    render(dt) {
        const { THREE } = this;
        const dq = new THREE.Quaternion(), axis = new THREE.Vector3();
        for (const t of this.toys) {
            const v = t.view;
            if (!v) continue;
            const g = v.group;
            g.position.set(t.p.x, t.p.y, t.p.z);
            // Spin from the angular velocity; a thing that doesn't roll
            // rights itself once it's still.
            const w = len(t.omega);
            if (w > 1e-4) {
                dq.setFromAxisAngle(axis.set(t.omega.x / w, t.omega.y / w, t.omega.z / w), w * dt);
                v.q.premultiply(dq);
            }
            if (t.resting && !t.def.spins && !t.def.shell && t.def.kind !== "lamp") v.q.slerp(IDENTITY(THREE), Math.min(1, dt * 6));
            if (t.def.jet && t.def.kind === "dryer") v.q.setFromUnitVectors(X_AXIS(THREE), axis.set(t.aim.x, t.aim.y, t.aim.z));
            // Stood on end: a rugby ball on its tee; held up to eat: a
            // banana stem up to peel, an ice cream cone up.
            const style = t.heldBy === "companion" ? t.def.food?.style : null;
            if (t.upright) v.q.setFromUnitVectors(X_AXIS(THREE), axis.set(0, 1, 0));
            else if (style === "peel") v.q.slerp(dq.setFromUnitVectors(axis.set(-1, 0, 0), new THREE.Vector3(0, 1, 0)), Math.min(1, dt * 8));
            else if (style === "lick") v.q.slerp(IDENTITY(THREE), Math.min(1, dt * 8));
            else if (style === "bottle") {
                // A bottle drunk from: its neck turned to point into the
                // mouth (against the way the face points, so past level as
                // the head goes back), as far as it's tipped (v.tip, 0-1
                // here); lifted to the mouth below.
                const b = t.holder || this.bodyApi;
                v.tip = (v.tip || 0) + ((t.tip ? 1 : 0) - (v.tip || 0)) * Math.min(1, dt * 10);
                const d = b.faceDir();
                const drink = dq.setFromUnitVectors(axis.set(0, 1, 0), new THREE.Vector3(-d.x, -d.y, -d.z));
                v.q.slerp(new THREE.Quaternion().slerp(drink, v.tip), Math.min(1, dt * 12));
            } else if (style && t.def.vessel) {
                // A cup, bowl or bottle: upright, its rim tipped back to
                // the mouth by toy.tip (radians) for each mouthful.
                const f = (t.holder || this.bodyApi).facing();
                v.tip = (v.tip || 0) + ((t.tip || 0) - (v.tip || 0)) * Math.min(1, dt * 10);
                v.q.slerp(dq.setFromAxisAngle(axis.set(-f.z, 0, f.x), v.tip), Math.min(1, dt * 12));
            }
            g.quaternion.copy(v.q);
            // Its neck at their lips (rather than wherever the hand holding
            // it by the middle ends up), as it tips.
            if (style === "bottle" && v.tip > 0.01 && v.parts.lip != null) {
                const m = (t.holder || this.bodyApi).mouth();
                const lip = new THREE.Vector3(0, v.parts.lip, 0).applyQuaternion(v.q).add(g.position);
                g.position.set(g.position.x + (m.x - lip.x) * v.tip, g.position.y + (m.y - lip.y) * v.tip, g.position.z + (m.z - lip.z) * v.tip);
            }
            v.sq = Math.max(0, v.sq - dt * 6);
            let s = 1;
            if (v.pop !== undefined) {
                v.pop = Math.min(1, v.pop + dt / 0.18);
                s = 1 + 2.2 * (v.pop - 1) ** 3 + 1.2 * (v.pop - 1) ** 2;
                if (v.pop >= 1) v.pop = undefined;
            }
            const p = v.parts;
            // Eaten down: the whole thing, an ice cream's scoop only, or
            // what's in a cup, bowl or bottle (it stays as it is).
            if (t.def.kind === "food" && p.scoop) p.scoop.scale.setScalar(Math.max(0.15, t.left > 0.4 ? t.left : 0.4));
            else if (p.fill) p.fill.scale.y = Math.max(0.02, t.left);
            else if (p.eatTo) p.eatTo(t.left);
            else if (t.def.kind === "food" && !t.def.vessel) s *= Math.max(0.3, Math.sqrt(t.left));
            if (p.cap) p.cap.visible = !t.opened;
            if (p.steam) p.steam.visible = !t.bad && t.left > 0.05;
            if (!v.light) p.tick?.(dt, this.time);
            if (p.sticks) this._sticks(t, v);
            if (p.scoop && t.left < 0.4) s *= Math.max(0.3, Math.sqrt(t.left / 0.4));
            if (t.def.kind === "bubble") s = 1;
            g.scale.set(s * (1 + 0.12 * v.sq), s * (1 - 0.2 * v.sq), s * (1 + 0.12 * v.sq));
            if (v.light) this._lampFrame(t, v, dt);
            if (p.head) {
                // A fan's stand at its height, its head turned to its aim,
                // the blades spinning when it's on.
                const up = headY(t), stand = up - 0.12;
                p.head.position.y = -t.radius + up;
                if (p.pole) {
                    p.pole.scale.y = stand;
                    p.pole.position.y = -t.radius + stand / 2;
                }
                p.head.quaternion.setFromUnitVectors(X_AXIS(THREE), axis.set(t.aim.x, t.aim.y, t.aim.z));
                p.head.quaternion.premultiply(dq.copy(g.quaternion).invert());
                v.rate = (v.rate || 0) + ((t.on ? 28 : 0) - (v.rate || 0)) * Math.min(1, dt * (t.on ? 2 : 0.8));
                p.blades.rotation.x += v.rate * dt;
            }
            if (p.glow) p.glow.material.opacity += ((t.on || t.opened ? 0.9 : 0) - p.glow.material.opacity) * Math.min(1, dt * 6);
            if (p.lid) {
                v.lid += ((t.opened ? 1 : 0) - v.lid) * Math.min(1, dt * 5);
                p.lid.rotation.x = -1.9 * v.lid;
            }
            if (p.led) p.led.material.color.set(t.puffing ? "#f87171" : t.on ? "#4ade80" : "#64748b");
            if (t.def.kind === "disco") g.rotation.y = t.spinAngle || 0;
        }
        bubbleMaterial(THREE).uniforms.time.value = this.time;
        this._drawFog(dt);
        this._drawDisco(dt);
        this._drawNight(dt);
    }

    /** Flakes on an aquarium's water (brains.js visitTank). */
    feedFish(t) { t.view?.parts.feed?.(); }

    /** A lamp's light where its bulb is (its centre turned with it), and
     *  what moves in it. */
    _lampFrame(t, v, dt) {
        const { THREE } = this;
        const at = (this._tmpV ||= new THREE.Vector3()).copy(v.parts.lightAt).applyQuaternion(v.q);
        v.light.position.set(t.p.x + at.x, t.p.y + at.y, t.p.z + at.z);
        if (v.light.target && v.parts.spotDir) {
            const d = (this._tmpD ||= new THREE.Vector3()).copy(v.parts.spotDir).applyQuaternion(v.q);
            v.light.target.position.copy(v.light.position).add(d);
            v.light.target.updateMatrixWorld();
        }
        // A flame's flicker (by eye: two quick wobbles), on the light too;
        // a fire's puffing (catalog puffHz) with a quicker flutter on top
        // (by eye); light through moving water (by eye).
        const L = t.def.lamp;
        let k = 1;
        if (L.flicker) k = 0.85 + 0.1 * Math.sin(this.time * 13) + 0.05 * Math.sin(this.time * 29 + 1.3);
        else if (L.fire) {
            const w = 2 * Math.PI * puffHz(L.fire) * this.time;
            k = 0.82 + 0.12 * Math.sin(w) + 0.06 * Math.sin(2.7 * w + 1.1);
        } else if (L.ripple) k = 0.9 + 0.06 * Math.sin(this.time * 1.7) + 0.04 * Math.sin(this.time * 2.9 + 1);
        v.light.intensity = t.on ? v.cd * k : 0;
        v.parts.tick?.(dt, this.time, t.on);
    }

    _drawFog(dt) {
        const { THREE } = this;
        for (const t of this.toys) {
            if (t.def.kind !== "fogger" || !t.puffing) continue;
            const a = norm({ x: t.aim.x, y: 0, z: t.aim.z });
            const nozzle = add(t.p, add(scale(a, 0.2), v3(0, 0.0, 0)));
            for (let n = Math.floor(FOG_RATE * dt + Math.random()); n > 0 && this.fog.length < FOG_MAX; n--) {
                this.fog.push({
                    p: { ...nozzle }, v: add(scale(a, rand(1.0, 1.8)), v3(rand(-0.15, 0.15), rand(-0.02, 0.2), rand(-0.15, 0.15))),
                    r: rand(0.08, 0.14), grow: rand(0.1, 0.16), age: 0, life: rand(5, 8),
                });
            }
        }
        this.fog = this.fog.filter((f) => (f.age += dt) < f.life);
        if (!this.fog.length) { if (this._fogPoints) this._fogPoints.visible = false; return; }
        if (!this._fogPoints) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FOG_MAX * 3), 3));
            geo.setAttribute("size", new THREE.BufferAttribute(new Float32Array(FOG_MAX), 1));
            geo.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(FOG_MAX), 1));
            const mat = new THREE.ShaderMaterial({
                uniforms: { scale: { value: 1 }, tint: { value: new THREE.Color("#e2e8f0") } },
                vertexShader: FOG_VERTEX, fragmentShader: FOG_FRAGMENT, transparent: true, depthWrite: false,
            });
            this._fogPoints = new THREE.Points(geo, mat);
            this._fogPoints.frustumCulled = false;
            this.root.add(this._fogPoints);
        }
        const pts = this._fogPoints;
        pts.visible = true;
        pts.material.uniforms.scale.value = this.r.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
        const pos = pts.geometry.attributes.position, size = pts.geometry.attributes.size, alpha = pts.geometry.attributes.alpha;
        const g = this.ground;
        this.fog.forEach((f, i) => {
            const air = this.windAt(f.p) || v3();
            const k = 1 - Math.exp(-1.2 * dt);
            f.v = add(f.v, scale(sub(add(air, v3(0, 0.06, 0)), f.v), k));
            f.p = add(f.p, scale(f.v, dt));
            f.p.y = Math.max(g + f.r * 0.4, f.p.y);
            f.r += f.grow * dt;
            pos.setXYZ(i, f.p.x, f.p.y, f.p.z);
            size.setX(i, f.r * 2);
            alpha.setX(i, 0.15 * Math.min(1, f.age * 3) * (1 - f.age / f.life));
        });
        pts.geometry.setDrawRange(0, this.fog.length);
        pos.needsUpdate = size.needsUpdate = alpha.needsUpdate = true;
    }

    /** The mirror ball: narrow spots in turning colours sweeping over the
     *  companion and the floor round them, pulsing on the beat, their
     *  beams showing in the air (brighter in fog); flecks of light
     *  wheeling across the floor; glints flashing on the ball. */
    _drawDisco(dt) {
        const ball = this.toys.find((t) => t.def.kind === "disco" && t.on);
        this._disco(!!ball);
        if (!ball) return;
        const { THREE } = this;
        const d = this._discoFx;
        const spin = ball.spinAngle || 0;
        const time = this.time;
        const b = this.body();
        const centre = b ? b.pos : this.home;
        const reach = b ? Math.min(1, flatDist(b.pos, ball.p)) : 1;
        // The beat: a sharp rise and an easy fall each beat.
        const beatPh = (time * DISCO_BPM / 60) % 1;
        const beat = Math.exp(-beatPh * 5);
        const foggy = Math.min(1, this.fog.length / (FOG_MAX * 0.4));
        const col = new THREE.Color();
        d.spots.forEach((s, i) => {
            s.position.set(ball.p.x, ball.p.y, ball.p.z);
            // Half the spots on them, half roaming the floor round them.
            const a = spin * (i % 2 ? -5 : 4) + (i / DISCO_SPOTS) * Math.PI * 2 + 0.6 * Math.sin(time * 0.7 + i);
            const onThem = i % 2 === 0;
            const rr = onThem ? 0.45 : 1.3 + 0.6 * Math.sin(time * 0.5 + i * 1.7);
            const y = onThem && b ? this.ground + b.height * (0.4 + 0.25 * Math.sin(a * 1.3 + i)) : this.ground;
            s.target.position.set(centre.x + Math.cos(a) * rr, y, centre.z + Math.sin(a) * rr);
            s.target.updateMatrixWorld();
            col.setHSL((time * 0.08 + i / DISCO_SPOTS) % 1, 0.9, 0.62);
            s.color.copy(col);
            s.intensity = DISCO_SPOT_CD * (0.55 + 0.45 * beat) * reach;
            // Its beam: from the ball to where it lands.
            const beam = d.beams[i];
            const from = s.position, to = s.target.position;
            const len2 = from.distanceTo(to);
            beam.position.copy(from);
            beam.scale.set(0.05 + len2 * 0.06, len2, 0.05 + len2 * 0.06);
            beam.quaternion.setFromUnitVectors(Y_DOWN(THREE), new THREE.Vector3().subVectors(to, from).normalize());
            beam.material.uniforms.color.value.copy(col);
            beam.material.uniforms.alpha.value = (0.06 + 0.22 * foggy) * (0.6 + 0.4 * beat);
        });
        // The ball's own coloured wash on the room.
        col.setHSL((time * 0.05) % 1, 0.8, 0.6);
        d.wash.color.copy(col);
        d.wash.position.set(ball.p.x, ball.p.y - 0.2, ball.p.z);
        d.wash.intensity = 1.5 * (0.7 + 0.3 * beat);
        // Flecks on the floor, coloured, sweeping round as it turns.
        const pos = d.flecks.geometry.attributes.position, fc = d.flecks.geometry.attributes.color;
        const dir = new THREE.Vector3();
        for (let i = 0; i < FLECKS; i++) {
            const f = d.fleckDir[i];
            const az = spin * 3 + f.a, el2 = f.e;
            dir.set(Math.cos(az) * Math.cos(el2), -Math.sin(el2), Math.sin(az) * Math.cos(el2));
            const t = (ball.p.y - this.ground) / Math.max(0.05, -dir.y);
            pos.setXYZ(i, ball.p.x + dir.x * t, this.ground + 0.004, ball.p.z + dir.z * t);
            col.setHSL((f.hue + time * 0.03) % 1, 0.7, 0.7).multiplyScalar(0.6 + 0.4 * Math.sin(time * 6 + f.a * 7));
            fc.setXYZ(i, col.r, col.g, col.b);
        }
        pos.needsUpdate = fc.needsUpdate = true;
        // Glints: a few mirrors catching the light at a time.
        d.glints.forEach((s, i) => {
            const g = d.glintDir[i];
            g.t -= dt;
            if (g.t <= 0) {
                g.t = rand(0.3, 1.2);
                g.a = Math.random() * Math.PI * 2;
                g.e = rand(-0.9, 0.9);
            }
            const life = Math.sin(Math.PI * Math.min(1, g.t / 0.3));
            const a = g.a + spin;
            s.position.set(ball.p.x + Math.cos(a) * Math.cos(g.e) * ball.radius * 1.02,
                ball.p.y + Math.sin(g.e) * ball.radius * 1.02, ball.p.z + Math.sin(a) * Math.cos(g.e) * ball.radius * 1.02);
            s.scale.setScalar(0.06 + 0.1 * Math.max(0, life));
            s.material.opacity = Math.max(0, life);
        });
    }

    _disco(on) {
        const { THREE } = this;
        if (on && !this._discoFx) {
            const d = this._discoFx = {};
            d.spots = Array.from({ length: DISCO_SPOTS }, () => {
                const s = new THREE.SpotLight("#ffffff", DISCO_SPOT_CD, 0, 0.06, 0.35, 2);
                this.root.add(s, s.target);
                return s;
            });
            d.wash = new THREE.PointLight("#ffffff", 0, 0, 2);
            this.root.add(d.wash);
            // Beams: open cones, their apex at the ball, fading out along
            // their length, added onto what's behind.
            // (Unit length, its apex at the origin, opening down -Y.)
            const cone = new THREE.ConeGeometry(1, 1, 18, 1, true);
            cone.translate(0, -0.5, 0);
            d.beams = d.spots.map(() => {
                const m = new THREE.Mesh(cone, new THREE.ShaderMaterial({
                    uniforms: { color: { value: new THREE.Color() }, alpha: { value: 0.1 } },
                    vertexShader: /* glsl */`
                        varying float vAlong;
                        void main() {
                            vAlong = -position.y;
                            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                        }`,
                    fragmentShader: /* glsl */`
                        uniform vec3 color;
                        uniform float alpha;
                        varying float vAlong;
                        void main() {
                            float a = alpha * (1.0 - smoothstep(0.0, 1.0, vAlong));
                            gl_FragColor = vec4(color * a, a);
                        }`,
                    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
                }));
                m.frustumCulled = false;
                this.root.add(m);
                return m;
            });
            d.fleckDir = Array.from({ length: FLECKS }, () => ({ a: Math.random() * Math.PI * 2, e: rand(0.3, 1.25), hue: Math.random() }));
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FLECKS * 3), 3));
            geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(FLECKS * 3), 3));
            const dotTex = (draw) => {
                const c = document.createElement("canvas");
                c.width = c.height = 64;
                draw(c.getContext("2d"));
                return new THREE.CanvasTexture(c);
            };
            const soft = dotTex((g) => {
                const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
                grad.addColorStop(0, "rgba(255,255,255,1)");
                grad.addColorStop(0.35, "rgba(255,255,255,0.7)");
                grad.addColorStop(1, "rgba(255,255,255,0)");
                g.fillStyle = grad;
                g.fillRect(0, 0, 64, 64);
            });
            d.flecks = new THREE.Points(geo, new THREE.PointsMaterial({
                size: 0.13, map: soft, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            }));
            d.flecks.frustumCulled = false;
            this.root.add(d.flecks);
            // A four-point star for the glints.
            const star = dotTex((g) => {
                g.translate(32, 32);
                const ray = (angle, l, w) => {
                    g.save();
                    g.rotate(angle);
                    const grad = g.createLinearGradient(-l, 0, l, 0);
                    grad.addColorStop(0, "rgba(255,255,255,0)");
                    grad.addColorStop(0.5, "rgba(255,255,255,1)");
                    grad.addColorStop(1, "rgba(255,255,255,0)");
                    g.fillStyle = grad;
                    g.fillRect(-l, -w / 2, l * 2, w);
                    g.restore();
                };
                ray(0, 30, 3);
                ray(Math.PI / 2, 30, 3);
                ray(Math.PI / 4, 15, 2);
                ray(-Math.PI / 4, 15, 2);
            });
            d.glints = Array.from({ length: DISCO_GLINTS }, () => {
                const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: star, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
                this.root.add(s);
                return s;
            });
            d.glintDir = d.glints.map(() => ({ t: Math.random(), a: 0, e: 0 }));
            d.textures = [soft, star];
            d.cone = cone;
        } else if (!on && this._discoFx) {
            const d = this._discoFx;
            for (const s of d.spots) { s.target.removeFromParent(); s.removeFromParent(); s.dispose(); }
            d.wash.removeFromParent();
            d.wash.dispose();
            for (const m of d.beams) { m.removeFromParent(); m.material.dispose(); }
            d.cone.dispose();
            d.flecks.geometry.dispose();
            d.flecks.material.dispose();
            d.flecks.removeFromParent();
            for (const s of d.glints) { s.removeFromParent(); s.material.dispose(); }
            for (const t of d.textures) t.dispose();
            this._discoFx = null;
        }
    }

    /** The dark a campfire or the galaxy projector brings (catalog
     *  lamp.night): a dome round the camera, drawn before everything else,
     *  that darkens a flat backdrop behind the 3D view and carries the
     *  projector's turning stars and nebula (now and then a shooting star)
     *  and the fire's glow in the air. A room's walls draw over it: the
     *  projector's own light falls on them instead. Not in the mascot's
     *  see-through window. */
    _drawNight(dt) {
        const on = this.kind === "mascot" ? [] : this.toys.filter((t) => t.on && t.def.lamp?.night);
        this._nightFade = Math.max(0, Math.min(1, (this._nightFade || 0) + (on.length ? dt : -dt) / NIGHT_FADE_S));
        this._night(this._nightFade > 0);
        if (!this._nightFx) return;
        const u = this._nightFx.material.uniforms;
        const f = this._nightFade;
        u.fade.value = f * f * (3 - 2 * f);
        u.time.value = this.time;
        this._nightFx.position.copy(this.r.camera.position);
        // Fading out: as it was.
        if (!on.length) return;
        u.veil.value = Math.max(...on.map((t) => t.def.lamp.night));
        const sky = on.find((t) => t.def.lamp.stars), fire = on.find((t) => t.def.lamp.fire);
        if (sky) {
            const colors = sky.def.shades[sky.shade || 0].sky;
            u.spin.value = sky.view?.parts.spin || 0;
            u.stars.value = 1;
            u.horizon.value = -0.1;
            u.nebula.value = colors.length ? 1 : 0;
            colors.forEach((c, i) => u.sky.value[i].set(c));
            this._shooting(dt, u);
        } else {
            // Over a fire, a few stars high overhead.
            u.stars.value = 0.5;
            u.horizon.value = 0.35;
            u.nebula.value = 0;
            u.shootT.value = -1;
        }
        const light = fire?.view?.light;
        if (light) {
            const p = light.position, cam = this.r.camera.position;
            u.glowDir.value.set(p.x - cam.x, p.y - cam.y, p.z - cam.z).normalize();
            u.glowCol.value.copy(light.color);
            // Breathing with its flicker.
            u.glow.value = fire.view.cd ? light.intensity / fire.view.cd : 1;
        } else u.glow.value = 0;
    }

    /** Now and then a shooting star across the projector's sky, in front of
     *  the camera and a little above, so it's seen (`shootingAt`: when the
     *  last one went, for the stargazing routine). */
    _shooting(dt, u) {
        const s = (this._shoot ||= { next: rand(4, 10), t: -1 });
        if (s.t < 0) {
            if ((s.next -= dt) > 0) { u.shootT.value = -1; return; }
            const f = this._camFwd(), r = this._camRight();
            const az = rand(-0.35, 0.35), el = rand(0.12, 0.3), dir = Math.random() < 0.5 ? -1 : 1;
            const a = norm(add(add(f, scale(r, az)), v3(0, el + 0.06, 0)));
            const b = norm(add(add(f, scale(r, az + dir * rand(0.2, 0.35))), v3(0, el - 0.06, 0)));
            u.shootA.value.set(a.x, a.y, a.z);
            u.shootB.value.set(b.x, b.y, b.z);
            s.t = 0;
            this.shootingAt = now();
        }
        s.t += dt / SHOOT_S;
        if (s.t >= 1) {
            s.t = -1;
            s.next = rand(...SHOOT_EVERY);
        }
        u.shootT.value = s.t;
    }

    _night(on) {
        const { THREE } = this;
        if (on && !this._nightFx) {
            const cam = this.r.camera;
            const uniforms = {
                time: { value: 0 }, spin: { value: 0 }, veil: { value: 0 }, fade: { value: 0 }, horizon: { value: -0.1 },
                stars: { value: 0 }, nebula: { value: 0 }, glow: { value: 0 }, shootT: { value: -1 },
                sky: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
                glowDir: { value: new THREE.Vector3(0, 0, -1) }, glowCol: { value: new THREE.Color() },
                shootA: { value: new THREE.Vector3() }, shootB: { value: new THREE.Vector3() },
            };
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(Math.min(50, cam.far * 0.5), 48, 24), new THREE.ShaderMaterial({
                uniforms, vertexShader: NIGHT_VERTEX, fragmentShader: NIGHT_FRAGMENT,
                side: THREE.BackSide, depthTest: false, depthWrite: false,
                // Its light added, what's behind darkened by the veil (the
                // canvas is see-through over a flat backdrop).
                blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
                blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
                blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
            }));
            // First of all, under the room and the companion.
            mesh.renderOrder = -100;
            mesh.frustumCulled = false;
            mesh.raycast = () => {};
            this.root.add(mesh);
            this._nightFx = mesh;
        } else if (!on && this._nightFx) {
            this._nightFx.removeFromParent();
            this._nightFx.geometry.dispose();
            this._nightFx.material.dispose();
            this._nightFx = null;
        }
    }
}

const NIGHT_VERTEX = /* glsl */`
    varying vec3 vDir;
    void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
const NIGHT_FRAGMENT = /* glsl */`
    uniform float time;
    uniform float spin;
    uniform float veil;
    uniform float fade;
    uniform float horizon;
    uniform float stars;
    uniform float nebula;
    uniform float glow;
    uniform float shootT;
    uniform vec3 sky[3];
    uniform vec3 glowDir;
    uniform vec3 glowCol;
    uniform vec3 shootA;
    uniform vec3 shootB;
    varying vec3 vDir;
    vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
    }
    float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash33(i).x, hash33(i + vec3(1.0, 0.0, 0.0)).x, f.x), mix(hash33(i + vec3(0.0, 1.0, 0.0)).x, hash33(i + vec3(1.0, 1.0, 0.0)).x, f.x), f.y),
            mix(mix(hash33(i + vec3(0.0, 0.0, 1.0)).x, hash33(i + vec3(1.0, 0.0, 1.0)).x, f.x), mix(hash33(i + vec3(0.0, 1.0, 1.0)).x, hash33(i + vec3(1.0, 1.0, 1.0)).x, f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }
        return s;
    }
    // One star (or none) per cell of a grid, put on the sphere; its glow
    // as the angle off it (radians), twinkling.
    float starField(vec3 d, float cells, float rad, float density) {
        vec3 p = d * cells;
        vec3 c = floor(p);
        vec3 h = hash33(c);
        if (h.x > density) return 0.0;
        vec3 sp = normalize(c + 0.2 + 0.6 * hash33(c + 17.3)) * cells;
        float ang = length(p - sp) / cells;
        float tw = 0.65 + 0.35 * sin(time * (1.5 + 3.0 * h.y) + h.z * 6.283);
        return smoothstep(rad, rad * 0.2, ang) * tw * (0.35 + 0.65 * h.y);
    }
    void main() {
        vec3 d = normalize(vDir);
        // The sky turns with the projector.
        float cs = cos(spin), sn = sin(spin);
        vec3 r = vec3(cs * d.x - sn * d.z, d.y, sn * d.x + cs * d.z);
        // Above the horizon given (the projector's: overhead and the walls,
        // little on the floor; a fire's night: only high up).
        float up = smoothstep(horizon - 0.4, horizon, d.y);
        float s = starField(r, 140.0, 0.0018, 0.14) + 1.4 * starField(r, 45.0, 0.003, 0.05);
        vec3 col = vec3(0.9, 0.93, 1.0) * s * stars * up;
        if (nebula > 0.0) {
            float m = smoothstep(0.42, 0.82, fbm(r * 1.8 + vec3(0.0, time * 0.004, 0.0)));
            vec3 c = mix(sky[0], sky[1], smoothstep(0.3, 0.7, fbm(r * 2.6 + 4.1)));
            c = mix(c, sky[2], smoothstep(0.45, 0.75, fbm(r * 1.3 - 2.7)));
            col += c * m * 0.45 * nebula * up;
        }
        if (shootT >= 0.0) {
            vec3 head = normalize(mix(shootA, shootB, shootT));
            vec3 tail = normalize(mix(shootA, shootB, max(0.0, shootT - 0.35)));
            vec3 pa = d - tail, ba = head - tail;
            float k = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
            col += vec3(1.5) * smoothstep(0.0035, 0.0, length(pa - ba * k)) * k * sin(3.14159 * shootT);
        }
        if (glow > 0.0) {
            float a = acos(clamp(dot(d, glowDir), -1.0, 1.0));
            col += glowCol * (exp(-a * a / 0.02) * 0.35 + exp(-a * a / 0.25) * 0.07) * glow;
        }
        gl_FragColor = vec4(col * fade, veil * fade);
        #include <colorspace_fragment>
    }`;

let _identity = null, _xAxis = null, _yDown = null;
const IDENTITY = (THREE) => (_identity ||= new THREE.Quaternion());
const X_AXIS = (THREE) => (_xAxis ||= new THREE.Vector3(1, 0, 0));
const Y_DOWN = (THREE) => (_yDown ||= new THREE.Vector3(0, -1, 0));

// ── the companion, for the toy routines (brains.js) ─────────────────────

class SceneBody {
    constructor(stage) {
        this.stage = stage;
        this.r = stage.r;
        this.id = null;            // the main companion; a PeerBody's is its peer id
    }

    /** What a toy routine has them busy with (null: free): their own
     *  gestures, and the call's, wait meanwhile (avatar_renderer toyBusy). */
    setBusy(what) { this.r.toyBusy = what; }

    get rfx() { return this.stage.rfx; }
    get key() { return String(this.stage.box?.companionKey ?? "companion"); }
    get inCall() { return !!this.stage.box?.inCall; }
    get height() {
        const r = this.r;
        return (r._meshTopY != null && r._meshBottomY != null) ? r._meshTopY - r._meshBottomY : 1.6;
    }
    get reach() { return this.height * 0.4; }

    page(p) { return this.stage.page(p); }

    _bone(names) {
        const h = this.r.vrm?.humanoid;
        for (const n of names) {
            const node = h?.getRawBoneNode?.(n);
            if (node) {
                const v = node.getWorldPosition(new this.stage.THREE.Vector3());
                return { x: v.x, y: v.y, z: v.z };
            }
        }
        return null;
    }

    _mid(a, b) {
        const p = this._bone(a), q = this._bone(b);
        if (!p || !q) return p || q;
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 };
    }

    pos() { return this.stage.body()?.pos || this.stage.home; }
    head() { return this._bone(["head"]) || add(this.pos(), v3(0, this.height * 0.9, 0)); }

    /** The mouth: a little up from the head bone's root and forward of it,
     *  turned with the head (by eye). */
    mouth() {
        const node = this.r.vrm?.humanoid?.getNormalizedBoneNode?.("head");
        if (!node) return add(this.head(), v3(0, 0.05, 0));
        const { THREE } = this.stage;
        const p = node.getWorldPosition(new THREE.Vector3());
        const fwd = new THREE.Vector3(0, 0.05, 0.08).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
        // In case a rig faces the other way in its own space: forward is
        // the way they face.
        const yaw = this.r._moveYaw || 0;
        const facing = { x: Math.sin(yaw), z: Math.cos(yaw) };
        if (fwd.x * facing.x + fwd.z * facing.z < 0) { fwd.x = -fwd.x; fwd.z = -fwd.z; }
        return { x: p.x + fwd.x, y: p.y + fwd.y, z: p.z + fwd.z };
    }

    _headNode() { return this.r.vrm?.humanoid?.getNormalizedBoneNode?.("head") || null; }

    /** Which way the face points (unit), the head's tilt included. */
    faceDir() {
        const node = this._headNode(), f = this.facing();
        if (!node) return f;
        const { THREE } = this.stage;
        const d = new THREE.Vector3(0, 0, 1).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
        // In case a rig faces the other way in its own space (as mouth).
        if (d.x * f.x + d.z * f.z < 0) d.negate();
        return { x: d.x, y: d.y, z: d.z };
    }

    openMouth(shape, ms) { this.r.toyMouth?.(shape, ms); }
    chest() { return this._bone(["upperChest", "chest"]) || add(this.pos(), v3(0, this.height * 0.7, 0)); }
    hand(side) { return this._bone([side === "left" ? "leftHand" : "rightHand"]) || this.chest(); }
    facing() { return this.stage.body()?.facing || v3(0, 0, 1); }

    facingSign() {
        const h = this.head();
        const a = this.page(h), b = this.page(add(h, this.facing()));
        return Math.sign(b.x - a.x) || 1;
    }

    userPoint() { return this.stage.userPoint(); }

    async goTo(point, ctx, { gap = 0.3, run = false, chase = null } = {}) {
        const r = this.r;
        run = run || this.stage.wired();
        const target = (p) => {
            const at = this.pos();
            const d = flatDist(p, at);
            if (d <= gap) return null;
            const k = (d - gap) / d;
            return { x: at.x + (p.x - at.x) * k, z: at.z + (p.z - at.z) * k };
        };
        const first = target(point);
        if (!first) return true;
        if (!r.toyWalkTo(first.x, first.z, run ? RUN_RATE : 1)) {
            // Can't walk here (a group call, a song): reach from where they are.
            return flatDist(point, this.pos()) < this.reach * 1.6;
        }
        const t0 = now();
        let last = 0;
        while (r.toyWalking && now() - t0 < 15000) {
            await this.wait(50, ctx);
            if (chase && now() - last > 250) {
                last = now();
                const p = chase();
                if (!p) break;
                const next = target(p);
                if (!next) break;
                r.toyWalkTo(next.x, next.z, run ? RUN_RATE : 1);
            }
        }
        return flatDist(chase?.() || point, this.pos()) < gap + 0.45;
    }

    face(point) { this.r.toyFace(point.x, point.z); }
    faceUser() { this.r.toyFaceCamera(); }

    lookAt(point, ms) {
        const p = this.page(point);
        const rect = this.stage.overlay.getBoundingClientRect();
        this.r.lookAtPoint?.({ x: rect.left + p.x, y: rect.top + p.y }, ms);
    }

    play(url, ctx, { loop = false, maxMs = 9000 } = {}) {
        const run = (async () => {
            const t0 = now();
            while (this.r.toyWalking && now() - t0 < 6000) await this.wait(30, ctx);
            const action = await this.r.playGesture?.(url, { loop, toy: true });
            this.check(ctx);
            if (loop || !action) return;
            const t1 = now();
            while (action.isRunning() && now() - t1 < maxMs) await this.wait(30, ctx);
        })();
        run.catch(() => {});
        return run;
    }

    rest() { this.r.stopGesture?.({ toy: true }); }

    async wait(ms, ctx) {
        const end = now() + ms;
        do {
            await this.stage.nextFrame();
            this.check(ctx);
        } while (now() < end);
    }

    check(ctx) {
        if (this.stage.disposed) throw new Interrupt("stop");
        if (ctx?.cancelled) throw new Interrupt(ctx.cancelled);
    }

    // A toy's moment shows on the face only: no mood marks or bursts.
    emotion(name) { this.r.setEmotion?.(name, { explicit: false, marks: false }); }

    hold(toy, grip = "both") {
        // Theirs now: anyone else going for it stops.
        if (toy.holder !== this) this.stage.claimed(toy, this);
        toy.heldBy = "companion";
        toy.holder = this;
        toy.grip = grip;
        toy.hovering = false;
        // In their hands: no longer something the user just put down.
        toy._fresh = false;
        toy.wake();
    }

    take(toy, grip = "both") {
        if (this.stage.drag?.toy === toy) {
            this.stage.drag = null;
            this.stage._endDrag?.();
        }
        this.hold(toy, grip);
    }

    letGo(toy, v) {
        if (toy.heldBy !== "companion" || (toy.holder && toy.holder !== this)) return;
        toy.heldBy = null;
        toy.holder = null;
        toy.v = { ...v };
        toy.thrownAt = 0;
        toy.releasedAt = performance.now();
        toy.wake();
        this.stage.noteHit(toy, "companion");
    }

    say(text, ms = 1600) {
        const h = this.page(this.head());
        this.rfx.say(text, h.x, h.y - 40, ms);
    }

    fx(name, a, b) { bodyFx(this, name, a, b); }

    note(text, opts) { this.stage.box?.note?.(text, { ...opts, who: this.id }); }
}

/** Another companion in a group call: the same body, on their avatar (the
 *  renderer's peer actor by its id). They stand in the call's row, so they
 *  can't walk anywhere: they take what's held out to them. */
class PeerBody extends SceneBody {
    constructor(stage, id) {
        super(stage);
        this.id = id;
    }

    get actor() { return this.r._peers?.get(this.id) || null; }
    get key() { return String(this.stage.box?.keyOf?.(this.id) ?? this.id); }

    get height() {
        const h = this.actor?.vrm?.humanoid;
        const head = h?.getRawBoneNode?.("head");
        if (!head) return 1.6;
        const v = head.getWorldPosition(new this.stage.THREE.Vector3());
        return Math.max(0.8, (v.y - this.stage.ground) / 0.9);
    }

    setBusy(what) { if (this.actor) this.actor.toyBusy = what; }

    _bone(names) {
        const h = this.actor?.vrm?.humanoid;
        for (const n of names) {
            const node = h?.getRawBoneNode?.(n);
            if (node) {
                const v = node.getWorldPosition(new this.stage.THREE.Vector3());
                return { x: v.x, y: v.y, z: v.z };
            }
        }
        return null;
    }

    pos() {
        const p = this.actor?.vrm?.scene?.position;
        return p ? { x: p.x, y: this.stage.ground, z: p.z } : this.stage.home;
    }

    /** They face the camera from their place in the row. */
    facing() {
        const cam = this.r.camera?.position, p = this.pos();
        if (!cam) return v3(0, 0, 1);
        const d = Math.hypot(cam.x - p.x, cam.z - p.z) || 1;
        return v3((cam.x - p.x) / d, 0, (cam.z - p.z) / d);
    }

    mouth() {
        const node = this.actor?.vrm?.humanoid?.getNormalizedBoneNode?.("head");
        if (!node) return add(this.head(), v3(0, 0.05, 0));
        const p = node.getWorldPosition(new this.stage.THREE.Vector3());
        const f = this.facing();
        return { x: p.x + f.x * 0.08, y: p.y + 0.05, z: p.z + f.z * 0.08 };
    }

    _headNode() { return this.actor?.vrm?.humanoid?.getNormalizedBoneNode?.("head") || null; }

    openMouth(shape, ms) { this.r.toyMouth?.(shape, ms, this.id); }

    async goTo(point) { return flatDist(point, this.pos()) < this.reach * 1.6; }
    face() { /* their place in the row sets which way they face */ }
    faceUser() { /* already */ }
    lookAt() { /* the renderer's look-at point is the main companion's */ }

    play(url, ctx, { loop = false, maxMs = 9000 } = {}) {
        const run = (async () => {
            const action = await this.r.playPeerGesture?.(this.id, url, { loop, toy: true });
            this.check(ctx);
            if (loop || !action) return;
            const t1 = now();
            while (action.isRunning() && now() - t1 < maxMs) await this.wait(30, ctx);
        })();
        run.catch(() => {});
        return run;
    }

    rest() { this.r.stopPeerGesture?.(this.id, { toy: true }); }
    emotion(name) { this.r.setPeerEmotion?.(this.id, name, { marks: false }); }
}

// ── who decides what to play with, and when ─────────────────────────────

class ToyCompanion {
    /** body: whose routines these are (the main companion's, or a group
     *  call peer's PeerBody). */
    constructor(stage, body = stage.bodyApi) {
        this.stage = stage;
        this.body = body;
        this.cur = null;
        this.next = null;
        this.ctx = null;
        this.idleAt = now() + rand(IDLE_MIN_MS, IDLE_MAX_MS);
        this.running = false;
    }

    stop() {
        if (this.ctx) this.ctx.cancelled = "stop";
        this.next = null;
    }

    request(r) {
        // VR or a photoshoot has the body (SceneStage._halt).
        if (this.stage.r.toyPaused) return;
        // Not walking anywhere (a group call's row): what's lying out of
        // their reach is left be, rather than reached for and given up on.
        if ((r.why === "dropped" || r.why === "idle") && r.toy && !this.reachable(r.toy)) return;
        const cur = this.cur;
        if (cur) {
            if (cur.toy && cur.toy === r.toy && cur.why === r.why) return;
            // Bumping into them while they reach for it is the catch.
            if (cur.toy === r.toy && cur.why === "thrown" && r.why === "hit") return;
            if (r.urgent || !cur.urgent) {
                this.next = r;
                if (this.ctx) this.ctx.cancelled = "toy";
            } else if (!this.next) this.next = r;
        } else this.next = r;
        this._run();
    }

    /** Whether they can get to `toy`: anywhere when they can walk, else
     *  within the reach goTo allows from where they stand. */
    reachable(toy) {
        if (this.body.id == null && this.stage.r.toyCanWalk) return true;
        return flatDist(toy.p, this.body.pos()) < this.body.reach * 1.6;
    }

    /** The user took `toy` from them (or put it away): whatever they were
     *  doing with it stops. */
    cancelFor(toy) {
        if (this.cur?.toy === toy && this.ctx) this.ctx.cancelled = "taken";
        if (this.next?.toy === toy) this.next = null;
    }

    async _run() {
        if (this.running) return;
        this.running = true;
        const body = this.body;
        try {
            while (this.next && !this.stage.disposed) {
                const r = this.next;
                this.next = null;
                this.cur = r;
                const ctx = this.ctx = { cancelled: null };
                // Their own gestures (and the call's) wait while a routine
                // has the body (avatar_renderer toyBusy, what with).
                body.setBusy(r.toy ? `with ${r.toy.def.note}` : null);
                try {
                    await playWith(body, r.toy, r.why, ctx, r.part);
                } catch (e) {
                    if (!(e instanceof Interrupt)) console.error("[toys] routine failed", e);
                } finally {
                    body.setBusy(null);
                    this.cur = null;
                    this.ctx = null;
                    for (const t of this.stage.toys) if (t.heldBy === "companion" && t.holder === body) body.letGo(t, v3(0, 0.3, 0));
                    if (!this.stage.disposed) {
                        if (!this.next) { body.rest(); body.faceUser(); }
                    }
                }
            }
        } finally {
            this.running = false;
            this.idleAt = now() + rand(IDLE_MIN_MS, IDLE_MAX_MS);
        }
    }

    /** Now and then, with nothing going on, a toy lying about catches
     *  their eye. */
    tick() {
        // (A group call's other companions only take what's held out to
        // them: no wandering through the row after toys.)
        if (this.body.id != null || this.cur || this.next || now() < this.idleAt) return;
        this.idleAt = now() + rand(IDLE_MIN_MS, IDLE_MAX_MS);
        const r = this.stage.r;
        if (!r.vrm || r.isGestureBusy?.() || r.toyWalking || r.isPerforming?.()) return;
        const from = this.stage.body()?.pos || null;
        const cands = this.stage.toys.map((t) => [t, this.reachable(t) ? idleAppeal(t, this.stage, from) : 0]).filter(([, w]) => w > 0);
        if (!cands.length) return;
        const total = cands.reduce((s, [, w]) => s + w, 0);
        if (Math.random() > Math.min(0.5, total / 100)) return;
        let x = Math.random() * total;
        for (const [t, w] of cands) {
            x -= w;
            if (x <= 0) { this.request({ toy: t, why: "idle" }); return; }
        }
    }
}

export { TOYS, dot };
