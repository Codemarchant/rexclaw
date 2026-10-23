// The toys' world, shared by both stages: the toys themselves, their flight
// (models/toys/physics.js), what they bump into that every stage has (each
// other, the companion's body, the hoop and the goal), the wind the gadgets
// blow, soap bubbles, and being picked up and thrown by the user. A
// stage (screen_stage.js, scene_stage.js) subclasses it with its floors and
// walls, its drawing, its pointer, and the companion's body.
//
// Positions are metres, y up. The desktop stage keeps everything at z = 0.

import { TOYS, HOOP, GOAL, POSTS } from "./catalog";
import {
    GRAVITY, MAX_THROW, add, bounce, clampLen, closestOnSegment, collidePair, dist, dot, dragK, fly, jetAt,
    len, norm, scale, sphereTorus, sub, v3,
} from "./physics";
import { toySfx } from "./sfx";

const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);

// Integration step: collisions with a 2 cm rim need small steps for a fast
// ball (12 m/s moves 10 cm a step at 120 Hz).
const STEP = 1 / 240;
// Settling: slower than this for this long on a surface, and it rests.
const REST_SPEED = 0.06;       // m/s
const REST_S = 0.25;
// Friction on a floor (by eye): balls roll on with a little rolling
// resistance; boxes and food slide to a stop.
const ROLL_RESIST = 0.03;      // × g
const SLIDE_FRICTION = 0.45;   // × g
// A release faster than this is a throw (it gets caught or bonks), slower
// a drop.
const THROW_SPEED = 1.5;       // m/s
// The velocity a release keeps comes from the last stretch of the drag.
const RELEASE_WINDOW_MS = 90;
// Held out to the mouth this long, food is eaten from the hand (by eye).
const OFFER_NEAR = 0.32;       // m from the head
const OFFER_S = 0.35;
// The companion's body for bumps: a capsule this wide round the line from
// the feet to the top of the head (STAGE_BODY_HALF_WIDTH in the renderer
// is shoulders, 0.25 m; the torso's half depth is less, by eye).
const BODY_R = 0.17;
// Bumping into them harder than this counts as a hit.
const HIT_SPEED = 1.2;         // m/s
// A toy they've just thrown or dropped clears their body for this long.
const RELEASE_CLEAR_MS = 700;
// A fan's oscillation: 90° of sweep (what a pedestal fan ships set to), once
// each way in about 10 s (by eye).
const OSC_HALF = 45 * Math.PI / 180;
const OSC_PERIOD = 10;
// How far a fan's head tilts up or down (by eye; pedestal fans tilt about
// this much).
const FAN_TILT = 25 * Math.PI / 180;
// A smoke machine fires bursts, warming up in between (by eye).
const FOG_ON_S = 3, FOG_OFF_S = 4;
// Mirror ball motor: the slow end of a 1.8-2.5 rpm motor for balls up to
// 30 cm (a stage lighting maker's spec).
const DISCO_RPM = 1.8;
// Water's density, for a bubble's film.
const WATER = 1000;
// Blown bubbles: mostly small, now and then a big one (by eye).
const BUBBLE_R = [0.012, 0.035];
const BIG_BUBBLE_R = [0.06, 0.11];
const BIG_BUBBLE_ODDS = 0.12;
// The breath inside starts warmer than the room and cools: warm air is
// lighter, so a fresh bubble floats (a big one, more air for its film, may
// even rise) and sinks as it cools. Breath leaves the mouth near 34 °C
// but mixes on its way through the ring: 5 K over a 21 °C room, cooling
// over a few seconds, longer for a bigger one (both by eye).
const ROOM_K = 294, BREATH_DT = 5;
const COOL_S = 3, COOL_R = 0.02;
const AIR = 1.2;    // kg/m³
// Held to just floating up, at most (by eye: a big one would otherwise
// sail out of the room's view).
const LIFT_MAX = 1.04;
// A room's air is never still: draughts and warm air rising wander about
// at up to 0.15 m/s where people are (the comfort ceiling ventilation is
// designed under; Aalborg University, The Influence of Furniture on Air
// Velocity in a Room), here a slow swirl of about half that (by eye),
// changing over a metre or so and some seconds.
const DRIFT = 0.07, DRIFT_L = 1.1, DRIFT_T = 9;

let toySeq = 0;

/** A bubble's lift for flight (physics.js fly), from `share`, how much of
 *  its film's weight is held up: flight's gravity acts on the whole moving
 *  mass, the weight is the film's only. */
function bubbleLift(b, share) {
    return 1 - (b.film * (1 - Math.min(LIFT_MAX, share))) / b.mass;
}

/** A pedestal fan's head height above the floor (its own, once raised). */
export const headY = (t) => t.headY ?? t.def.headY;

export class Toy {
    constructor(world, def, p, v = v3()) {
        this.uid = ++toySeq;
        this.world = world;
        this.def = def;
        this.p = { ...p };
        this.v = { ...v };
        this.r = null;
        this._mass = null;
        this.k = dragK(def.radius, def.mass || 0.01, def.cd);
        this.alive = true;
        this.heldBy = null;          // "user" | "companion" | null
        this.resting = false;
        this.grounded = false;
        this._still = 0;
        this.angle = 0;              // roll about +z (the desktop's drawings)
        this.omega = v3();           // angular velocity (rad/s)
        this.on = false;
        this.mode = 0;               // fan: 0 off, 1 on, 2 sweeping
        this.aim = v3(1, 0, 0);      // which way a gadget faces
        this.baseAim = v3(1, 0, 0);
        this.left = 1;               // food: what's left of it
        this.hovering = false;       // let go of in mid-air and staying there
        this.opened = false;
        this.lastHitBy = null;
        this.lastHitAt = 0;
        this.thrownAt = 0;
        this.view = null;
        this.born = now();
    }

    get radius() { return this.r ?? this.def.radius; }
    get mass() { return this._mass ?? this.def.mass; }

    setSize(r, mass) {
        this.r = r;
        this._mass = mass;
        this.k = dragK(r, mass, this.def.cd);
    }

    /** Something knocked it: it's in flight again. */
    wake() {
        this.resting = false;
        this._still = 0;
    }

    bite(left) {
        this.left = left;
        this.world.onBite?.(this);
    }

    remove() { this.world.remove(this); }

    /** Whether this gadget's air reaches `p` (a hair dryer on the head). */
    blowingAt(p) {
        const w = this.world.jetOf(this, p);
        return !!w && len(w) > 1.5;
    }
}

export class ToyWorld {
    /** dims: 3 (the room), or 2 (the desktop: everything at z = 0). */
    constructor({ dims = 3 } = {}) {
        this.dims = dims;
        this.toys = [];
        this.time = 0;
        this.hoop = null;
        this.goal = null;
        this.posts = null;
        this.tee = null;
        this.drag = null;           // the user's hold: {toy, samples, offerT}
        this.listeners = new Set();
        this._acc = 0;
    }

    // ── for the stage to provide ─────────────────────────────────────────
    // collideWorld(toy) → contact normal pointing up when on a floor, or null
    // body() → {pos, height, facing} of the companion, or null
    // holdPoint(toy) → where the companion's hands hold it
    // viewAdd(toy), viewRemove(toy), render(dt), placeHoop(near) → {x, y, z, face}
    // placeGoal(near), placePosts(near) → {x, y, z, face}
    // viewHoop(hoop), viewGoal(goal), viewPosts(posts), viewTee(tee)
    // userPoint() → where the user is (to throw things back to)

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit(type, toy, extra = {}) {
        const evt = { type, toy, at: now(), ...extra };
        for (const fn of [...this.listeners]) {
            try { fn(evt); } catch (e) { console.error("[toys] listener failed", e); }
        }
    }

    // ── toys ─────────────────────────────────────────────────────────────

    add(def, p, v = v3()) {
        const t = new Toy(this, def, this.dims === 2 ? { ...p, z: 0 } : p, this.dims === 2 ? { ...v, z: 0 } : v);
        if (def.kind === "fan" || def.kind === "dryer") {
            const b = this.body();
            const dir = b ? norm({ x: b.pos.x - p.x, y: 0, z: this.dims === 2 ? 0 : b.pos.z - p.z }) : v3(1, 0, 0);
            t.aim = t.baseAim = len(dir) ? dir : v3(1, 0, 0);
        }
        this.toys.push(t);
        this.viewAdd(t);
        this.emit("add", t);
        return t;
    }

    remove(t) {
        if (!t?.alive) return;
        t.alive = false;
        if (this.drag?.toy === t) this.drag = null;
        const i = this.toys.indexOf(t);
        if (i >= 0) this.toys.splice(i, 1);
        toySfx.loop(t.uid, false);
        this.viewRemove(t);
        // The hoop goes with the last basketball, the goal with the last
        // football, the posts with the last rugby ball.
        if (t.def.hoop && !this.toys.some((x) => x.def.hoop)) this.removeHoop();
        if (t.def.goal && !this.toys.some((x) => x.def.goal)) this.removeGoal();
        if (t.def.posts && !this.toys.some((x) => x.def.posts)) this.removePosts();
        this.emit("remove", t);
    }

    clear() {
        for (const t of [...this.toys]) this.remove(t);
        this.removeHoop();
        this.removeGoal();
        this.removePosts();
    }

    count(pred) { return this.toys.reduce((n, t) => n + (pred(t) ? 1 : 0), 0); }

    nearest(pred, p, maxDist = Infinity) {
        let best = null, bd = maxDist;
        for (const t of this.toys) {
            if (!t.alive || !pred(t)) continue;
            const d = dist(t.p, p);
            if (d < bd) { bd = d; best = t; }
        }
        return best;
    }

    gadgets() { return this.toys.filter((t) => t.def.gadget); }

    fogOn() { return this.toys.some((t) => t.def.kind === "fogger" && t.on); }

    discoOn() { return this.toys.some((t) => t.def.kind === "disco" && t.on); }

    // ── gadgets ──────────────────────────────────────────────────────────

    /** A click on a gadget: the fan steps off → on → sweeping → off, the
     *  rest go on and off; the chest opens. */
    toggle(t) {
        const k = t.def.kind;
        if (k === "chest") { if (!t.opened) this.openChest(t); return; }
        if (!t.def.gadget) return;
        if (k === "fan") t.mode = (t.mode + 1) % 3;
        else t.mode = t.mode ? 0 : 1;
        t.on = t.mode > 0;
        if (k === "fan" && t.mode !== 2) t.aim = { ...t.baseAim };
        t._fogClock = 0;
        toySfx.click();
        if (k === "fan" || k === "dryer" || k === "fogger") toySfx.loop(t.uid, t.on, k);
        else if (t.def.lamp?.sound) toySfx.loop(t.uid, t.on, t.def.lamp.sound);
        this.emit("switch", t);
    }

    /** Turn a gadget's facing by `rad` about the vertical (the mouse wheel). */
    turn(t, rad) {
        if (this.dims === 2) {
            // On the desktop a gadget faces left or right.
            if (Math.abs(rad) > 0) t.baseAim = t.aim = { x: -Math.sign(t.baseAim.x || 1), y: 0, z: 0 };
            return;
        }
        const c = Math.cos(rad), s = Math.sin(rad);
        const a = t.baseAim;
        t.baseAim = norm({ x: a.x * c + a.z * s, y: a.y, z: -a.x * s + a.z * c });
        if (t.mode !== 2) t.aim = { ...t.baseAim };
    }

    /** Raise (+) or lower (−) a pedestal fan's head by `dy` metres, within
     *  its stand's range (Shift + the mouse wheel). */
    raise(t, dy) {
        const range = t.def.headRange;
        if (!range) return;
        t.headY = Math.max(range[0], Math.min(range[1], headY(t) + dy));
        this.onRaise?.(t);
    }

    /** A lamp to its next (+1) or previous (−1) shade (the mouse wheel). */
    shade(t, dir) {
        const n = t.def.shades?.length;
        if (!n) return;
        t.shade = ((t.shade || 0) + dir + n) % n;
        toySfx.click();
        this.onShade?.(t);
        this.emit("shade", t);
    }

    /** Where a gadget's air comes out. */
    jetOrigin(t) {
        if (t.def.headY) return add(t.p, add(v3(0, headY(t) - t.radius, 0), scale(t.aim, 0.1)));
        return add(t.p, scale(t.aim, t.radius * 0.9));
    }

    jetOf(t, p) {
        const j = t.def.jet;
        if (!j || !t.on) return null;
        return jetAt(p, this.jetOrigin(t), t.aim, j.d, j.u0, this.time, t.uid);
    }

    /** The air's velocity at `p`: every gadget that's blowing. */
    windAt(p) {
        let w = null;
        for (const t of this.toys) {
            if (!t.on || !t.def.jet) continue;
            const j = this.jetOf(t, p);
            if (j) w = w ? add(w, j) : j;
        }
        return w;
    }

    _gadgets(dt) {
        for (const t of this.toys) {
            if (!t.alive) continue;
            const k = t.def.kind;
            if (k === "fan") {
                let flat = t.baseAim;
                if (t.mode === 2) {
                    const a = OSC_HALF * Math.sin((2 * Math.PI * this.time) / OSC_PERIOD);
                    const b = t.baseAim, c = Math.cos(a), s = Math.sin(a);
                    flat = norm({ x: b.x * c + b.z * s, y: 0, z: -b.x * s + b.z * c });
                }
                // The head tilts (up to FAN_TILT) to a face in front of it.
                let tilt = 0;
                const b = this.body();
                if (b) {
                    const o = add(t.p, v3(0, headY(t) - t.radius, 0));
                    const to = sub(add(b.pos, v3(0, b.height * 0.9, 0)), o);
                    const ahead = to.x * flat.x + to.z * flat.z;
                    if (ahead > 0.3 && ahead < 3.5) tilt = Math.max(-FAN_TILT, Math.min(FAN_TILT, Math.atan2(to.y, ahead)));
                }
                t.tilt = (t.tilt || 0) + (tilt - (t.tilt || 0)) * Math.min(1, dt * 2);
                t.aim = norm({ x: flat.x * Math.cos(t.tilt), y: Math.sin(t.tilt), z: flat.z * Math.cos(t.tilt) });
            }
            if (k === "dryer" && t.on && t.heldBy !== "companion") {
                // The nozzle finds the head when it's anywhere near.
                const b = this.body();
                if (b) {
                    const head = add(b.pos, v3(0, b.height * 0.9, 0));
                    if (dist(head, t.p) < 1.6) t.aim = norm(sub(head, t.p));
                }
            }
            if (k === "fogger" && t.on) {
                t._fogClock = (t._fogClock || 0) + dt;
                const cyc = t._fogClock % (FOG_ON_S + FOG_OFF_S);
                t.puffing = cyc < FOG_ON_S;
                toySfx.loop(t.uid, t.puffing, "fogger");
            } else if (k === "fogger") t.puffing = false;
            if (k === "disco" && t.on) t.spinAngle = (t.spinAngle || 0) + (2 * Math.PI * DISCO_RPM / 60) * dt;
        }
    }

    // ── the hoop ─────────────────────────────────────────────────────────

    /** The basketball's hoop, out (once) near `near`; the stage places it. */
    ensureHoop(near) {
        if (this.hoop) return this.hoop;
        const at = this.placeHoop(near);
        const face = norm(at.face);   // from the board toward the court
        const rim = { x: at.x + face.x * HOOP.rimOut, y: at.y + HOOP.rimHeight, z: at.z + face.z * HOOP.rimOut };
        const boardCentre = {
            x: at.x, y: at.y + HOOP.rimHeight - HOOP.boardBelowRim + HOOP.boardH / 2, z: at.z,
        };
        this.hoop = { base: { x: at.x, y: at.y, z: at.z }, face, rim, board: boardCentre };
        this.viewHoop?.(this.hoop);
        return this.hoop;
    }

    removeHoop() {
        if (!this.hoop) return;
        this.hoop = null;
        this.viewHoop?.(null);
    }

    /** A spot `d` m out from the hoop, along its facing, on the floor. */
    shootingSpot(hoop, d) {
        return { x: hoop.base.x + hoop.face.x * d, y: hoop.base.y, z: hoop.base.z + hoop.face.z * d };
    }

    /** The moment a ball is shot or kicked: nothing scored yet. (Set at the
     *  launch, not when the watching starts: a quick ball can be in before
     *  the shooting clip has finished.) */
    launched(toy) {
        toy._scored = false;
        toy._woodwork = false;
        toy._crossed = null;
        toy._prevAlong = toy._prevAlongP = undefined;
    }

    /** Follow a shot until it's in, or down and done with. */
    async watchShot(toy, hoop, ctx, body) {
        const t0 = now();
        while (now() - t0 < 4500) {
            await body.wait(16, ctx);
            if (toy._scored) {
                await body.wait(400, ctx);
                return "score";
            }
            if (!toy.alive || toy.heldBy) return "gone";
            if (toy.resting || (toy.grounded && toy.p.y < hoop.base.y + toy.radius * 1.5 && now() - t0 > 900)) break;
        }
        return toy._scored ? "score" : "miss";
    }

    _hoopCollide(t) {
        const h = this.hoop;
        if (!h || t.def.kind === "bubble") return;
        const r = t.radius;
        // The ring.
        const hit = sphereTorus(t.p, r, h.rim, v3(0, 1, 0), HOOP.rimRadius, HOOP.rimTube);
        if (hit) {
            const sp = bounce(t, hit.n, hit.depth, { e: HOOP.rimE });
            if (sp > 0.8) toySfx.rim();
            t.wake();
        }
        // The board: a slab facing h.face.
        const rel = sub(t.p, h.board);
        const along = dot(rel, h.face);
        if (along < r && along > -0.05) {
            const side = this.dims === 2 ? 0 : rel.x * h.face.z - rel.z * h.face.x;
            if (Math.abs(rel.y) < HOOP.boardH / 2 + r * 0.3 && Math.abs(side) < HOOP.boardW / 2 + r * 0.3) {
                const sp = bounce(t, h.face, r - along, { e: HOOP.boardE });
                if (sp > 0.8) toySfx.bounce(sp, "basketball");
                t.wake();
            }
        }
        // Through the ring, going down: a basket.
        const flat = Math.hypot(t.p.x - h.rim.x, t.p.z - h.rim.z);
        const prevY = t._prevY ?? t.p.y;
        if (prevY > h.rim.y && t.p.y <= h.rim.y && t.v.y < 0 && flat < HOOP.rimRadius - r * 0.35) {
            t._scored = true;
            toySfx.swish();
            this.emit("score", t, { by: t.lastHitBy });
        }
        // The net: slows a ball dropping through.
        if (t.p.y < h.rim.y && t.p.y > h.rim.y - HOOP.net && flat < HOOP.rimRadius) {
            t.v = { x: t.v.x * 0.96, y: t.v.y * 0.985, z: t.v.z * 0.96 };
        }
    }

    // ── the goal ─────────────────────────────────────────────────────────

    /** The football's goal, out (once) near `near`; the stage places it.
     *  `base` is the middle of its goal line, `face` points out to the
     *  pitch, `side` along the line. */
    ensureGoal(near) {
        if (this.goal) return this.goal;
        const at = this.placeGoal(near);
        const face = norm(at.face);
        this.goal = { base: { x: at.x, y: at.y, z: at.z }, face, side: { x: -face.z, y: 0, z: face.x } };
        this.viewGoal?.(this.goal);
        return this.goal;
    }

    removeGoal() {
        if (!this.goal) return;
        this.goal = null;
        this.viewGoal?.(null);
    }

    /** Where in the goal mouth to aim: `u` across (−1 … 1) and `v` up (0 … 1). */
    goalTarget(goal, u, v) {
        const half = GOAL.width / 2 - 0.25, top = GOAL.height - 0.25;
        return add(goal.base, add(scale(goal.side, this.dims === 2 ? 0 : u * half), v3(0, 0.2 + v * (top - 0.2), 0)));
    }

    /** Follow a kick until it's in the net, or done with. */
    async watchKick(toy, goal, ctx, body) {
        const t0 = now();
        while (now() - t0 < 5000) {
            await body.wait(16, ctx);
            if (toy._scored) {
                await body.wait(500, ctx);
                return "score";
            }
            if (!toy.alive || toy.heldBy) return "gone";
            if (toy.resting || now() - t0 > 3500) break;
        }
        return toy._scored ? "score" : "miss";
    }

    _goalCollide(t) {
        const g = this.goal;
        if (!g || t.def.kind === "bubble") return;
        const r = t.radius, P = GOAL.post;
        const w = GOAL.width / 2 + P, H = GOAL.height + P;
        const pt = (s, y) => add(g.base, add(scale(g.side, s), v3(0, y, 0)));
        // Posts and the crossbar: round bars.
        const bars = [[pt(-w, 0), pt(-w, H)], [pt(w, 0), pt(w, H)], [pt(-w, H), pt(w, H)]];
        for (const [a, b] of bars) {
            const c = closestOnSegment(t.p, a, b);
            const d = sub(t.p, c);
            const l = len(d);
            if (l < r + P && l > 1e-6) {
                const sp = bounce(t, scale(d, 1 / l), r + P - l, { e: 0.6 });
                if (sp > 1) { toySfx.clank(); t._woodwork = true; }
                t.wake();
            }
        }
        // Behind the line, inside the frame: the net takes the pace off it.
        const rel = sub(t.p, g.base);
        const along = dot(rel, g.face), across = dot(rel, g.side);
        const inMouth = Math.abs(across) < GOAL.width / 2 && t.p.y < GOAL.height + g.base.y;
        const prevAlong = t._prevAlong ?? along;
        t._prevAlong = along;
        if (inMouth && along < 0 && along > -GOAL.depth - r) {
            if (prevAlong >= 0 && !t._scored) {
                t._scored = true;
                toySfx.swish();
                this.emit("goal", t, { by: t.lastHitBy });
            }
            // The net slopes from the bar down to the ground behind: a ball
            // that reaches it is stopped dead (it gives).
            const D = GOAL.depth, Ht = GOAL.height;
            const y = t.p.y - g.base.y;
            const k = Math.hypot(1, D / Ht);
            const gap = (along + D - (D * y) / Ht) / k;
            if (gap < r) {
                const n = norm(add(g.face, v3(0, -D / Ht, 0)));
                bounce(t, n, r - gap, { e: 0.1 });
            }
            // The side nets.
            if (this.dims === 3 && Math.abs(across) > GOAL.width / 2 - r) {
                bounce(t, scale(g.side, -Math.sign(across)), Math.abs(across) - GOAL.width / 2 + r, { e: 0.1 });
            }
            t.v = scale(t.v, 0.94);
        }
    }

    // ── the rugby posts ──────────────────────────────────────────────────

    /** The rugby ball's posts, out (once) near `near`; the stage places
     *  them. As the goal: `base` the middle of the line under the bar,
     *  `face` out to the kicker, `side` along the bar. */
    ensurePosts(near) {
        if (this.posts) return this.posts;
        const at = this.placePosts(near);
        const face = norm(at.face);
        this.posts = { base: { x: at.x, y: at.y, z: at.z }, face, side: { x: -face.z, y: 0, z: face.x } };
        this.viewPosts?.(this.posts);
        return this.posts;
    }

    removePosts() {
        this.removeTee();
        if (!this.posts) return;
        this.posts = null;
        this.viewPosts?.(null);
    }

    /** Where to send a kick: `u` across the posts (−1 … 1, the 2D stage's
     *  always the middle) and `up` metres over the bar, on the line. */
    postsTarget(posts, u, up) {
        return add(posts.base, add(scale(posts.side, this.dims === 2 ? 0 : (u * POSTS.width) / 2), v3(0, POSTS.bar + up, 0)));
    }

    /** The kicking tee down at `p` (one at a time). */
    placeTee(p) {
        this.tee = { p: { ...p } };
        this.viewTee?.(this.tee);
        return this.tee;
    }

    removeTee() {
        if (!this.tee) return;
        this.tee = null;
        this.viewTee?.(null);
    }

    /** A rugby ball stood on the tee, point up. */
    standOnTee(t, tee) {
        t.p = add(tee.p, v3(0, POSTS.tee + t.radius * (t.def.long || 1), 0));
        t.v = v3();
        t.hovering = true;
        t.upright = true;
        t.omega = v3();
    }

    /** Follow a place kick until it's over, or done with: "score", "wide",
     *  "short" (under the bar), "post" or "gone". */
    async watchPosts(toy, posts, ctx, body) {
        const t0 = now();
        while (now() - t0 < 5000) {
            await body.wait(16, ctx);
            if (toy._scored) {
                await body.wait(500, ctx);
                return "score";
            }
            if (!toy.alive || toy.heldBy) return "gone";
            if (toy.resting || now() - t0 > 4000) break;
        }
        if (toy._scored) return "score";
        const c = toy._crossed;
        if (!c) return toy._woodwork ? "post" : "short";
        if (Math.abs(c.across) > POSTS.width / 2) return toy._woodwork ? "post" : "wide";
        return toy._woodwork ? "post" : "short";
    }

    _postsCollide(t) {
        const g = this.posts;
        if (!g || t.def.kind === "bubble") return;
        const r = t.radius, P = POSTS.post, w = POSTS.width / 2;
        const pt = (s, y) => add(g.base, add(scale(g.side, s), v3(0, y, 0)));
        // The posts and the crossbar: round bars (on the desktop only the
        // bar, end on: the posts stand either side of the screen's plane).
        const bars = [[pt(-w, 0), pt(-w, POSTS.height)], [pt(w, 0), pt(w, POSTS.height)], [pt(-w, POSTS.bar - P), pt(w, POSTS.bar - P)]];
        for (const [a, b] of bars) {
            const c = closestOnSegment(t.p, a, b);
            const d = sub(t.p, c);
            const l = len(d);
            if (l < r + P && l > 1e-6) {
                const sp = bounce(t, scale(d, 1 / l), r + P - l, { e: 0.5 });
                if (sp > 1) { toySfx.clank(); t._woodwork = true; }
                t.wake();
            }
        }
        // Over the line: between the posts and above the bar is a goal.
        const rel = sub(t.p, g.base);
        const along = dot(rel, g.face), across = dot(rel, g.side);
        const prev = t._prevAlongP ?? along;
        t._prevAlongP = along;
        if (prev >= 0 && along < 0 && !t._crossed) {
            t._crossed = { across, y: t.p.y - g.base.y };
            if (Math.abs(across) < w && t.p.y - g.base.y > POSTS.bar && !t._scored) {
                t._scored = true;
                toySfx.swish();
                this.emit("goal", t, { by: t.lastHitBy });
            }
        }
        // The ball-stop net behind: stops it dead (it gives).
        if (this.dims === 3 && along < -POSTS.netBack + r && along > -POSTS.netBack - 0.5
            && Math.abs(across) < POSTS.netW / 2 && t.p.y - g.base.y < POSTS.netH) {
            bounce(t, g.face, -POSTS.netBack + r - along, { e: 0.1 });
            t.v = scale(t.v, 0.6);
        }
    }

    // ── bubbles ──────────────────────────────────────────────────────────

    /** One soap bubble off a wand, blown along `dir` at `speed` m/s. */
    blowBubble(wand, dir, speed = 0.8) {
        const def = TOYS.bubble;
        const big = Math.random() < BIG_BUBBLE_ODDS;
        const r = big ? rand(BIG_BUBBLE_R[0], BIG_BUBBLE_R[1]) : rand(BUBBLE_R[0], BUBBLE_R[1]);
        const ring = this.wandRing(wand);
        // A breath fans out (by eye).
        const d = norm(add(dir, v3(rand(-0.7, 0.7), rand(-0.25, 0.6), this.dims === 2 ? 0 : rand(-0.6, 0.6))));
        const b = this.add(def, add(ring, scale(d, r)), scale(d, speed * rand(0.6, 1.3)));
        // The film's weight: a shell of water this thick. What it takes to
        // get it moving is far more: the air inside, and half as much of
        // the room's air it pushes aside (a sphere's added mass), so a
        // breath carries it a way before the drag has it.
        const film = WATER * 4 * Math.PI * r * r * def.film;
        const vol = (4 / 3) * Math.PI * r ** 3;
        b.film = film;
        b.setSize(r, film + 1.5 * AIR * vol);
        b.life = rand(def.life[0], def.life[1]);
        // The warm breath's lift, as a share of the film's weight.
        b.warm = (AIR * vol * (BREATH_DT / (ROOM_K + BREATH_DT))) / film;
        b.coolS = COOL_S * (r / COOL_R);
        b.age = 0;
        b.lift = bubbleLift(b, def.buoyancy + b.warm);
        // Born inside the wand's ring and in front of whoever blew it: it
        // doesn't burst on either on its way out.
        b.src = wand;
        b.releasedAt = now();
        return b;
    }

    /** The room's own slow air movement at `p` (a bubble feels it). */
    roomAir(p) {
        const T = this.time / DRIFT_T, L = 1 / DRIFT_L, s = this._driftSeed || (this._driftSeed = rand(0, 100));
        const w = (a, b, c) => Math.sin(a + s) + 0.6 * Math.sin(b * 1.7 + s * 0.3) + 0.3 * Math.sin(c * 2.9 - s);
        return {
            x: DRIFT * 0.55 * w(p.z * L + T * 2.1, p.y * L - T * 1.3, p.x * L + T),
            y: DRIFT * 0.35 * w(p.x * L - T * 1.6, p.z * L + T * 0.9, p.y * L + T * 2.3),
            z: this.dims === 2 ? 0 : DRIFT * 0.55 * w(p.x * L + T * 1.4, p.y * L + T * 2.2, p.z * L - T * 1.1),
        };
    }

    /** Coffee's in the main companion (brains.js WIRED_MS): they run, and
     *  play more. */
    wired() { return now() < (this.bodyApi?.wiredUntil || 0); }

    /** Where a wand's ring is (its drawing's top). */
    wandRing(w) { return add(w.p, v3(0, w.radius * 0.45, 0)); }

    nearestBubble(p, maxDist) { return this.nearest((t) => t.def.kind === "bubble", p, maxDist); }

    popBubble(b, by = null) {
        if (!b.alive) return;
        toySfx.pop();
        this.onPop?.(b);
        this.remove(b);
        if (by) this.emit("pop", b, { by });
    }

    // ── the user's hand ──────────────────────────────────────────────────

    grab(t) {
        if (t.heldBy === "companion") this.emit("taken", t);
        t.heldBy = "user";
        t.hovering = false;
        t.upright = false;
        t.v = v3();
        t.wake();
        this.drag = { toy: t, samples: [{ p: { ...t.p }, at: now() }], offerT: 0, offered: false };
        this.emit("grab", t);
    }

    /** The held toy to `p` this moment. */
    dragTo(p) {
        const d = this.drag;
        if (!d) return;
        const t = d.toy;
        const q = this.dims === 2 ? { ...p, z: 0 } : p;
        const last = d.samples[d.samples.length - 1];
        const secs = (now() - last.at) / 1000;
        // Its velocity while held (a wand being waved), smoothed.
        if (secs > 0.004) t.v = add(scale(t.v, 0.6), scale(sub(q, last.p), 0.4 / secs));
        t.p = q;
        d.samples.push({ p: { ...q }, at: now() });
        while (d.samples.length > 2 && now() - d.samples[0].at > 250) d.samples.shift();
    }

    release() {
        const d = this.drag;
        if (!d) return null;
        this.drag = null;
        const t = d.toy;
        if (!t.alive) return null;
        const recent = d.samples.filter((s) => now() - s.at <= RELEASE_WINDOW_MS);
        const s0 = recent[0] || d.samples[0], s1 = d.samples[d.samples.length - 1];
        const secs = Math.max(0.016, (s1.at - s0.at) / 1000);
        let v = clampLen(scale(sub(s1.p, s0.p), 1 / secs), MAX_THROW);
        if (now() - s1.at > 120) v = v3();   // held still before letting go
        t.heldBy = null;
        t.v = this.dims === 2 ? { ...v, z: 0 } : v;
        const speed = len(v);
        // Gadgets that hang in the air stay where they're let go of, unless
        // flung; the rest fall.
        t.hovering = !!t.def.hovers && speed < 3;
        if (t.hovering) t.v = v3();
        // Flung, a thing tumbles end over end (a ball's spin is its roll).
        if (t.def.tumbles && speed > THROW_SPEED) t.omega = { x: -t.v.z * 3, y: 0, z: -t.v.x * 3 };
        t.wake();
        if (speed > THROW_SPEED) {
            t.thrownAt = now();
            t.lastHitBy = "user";
            t.lastHitAt = now();
            t._incoming = false;
            this.emit("throw", t, { speed });
        } else {
            this.emit("drop", t);
        }
        return t;
    }

    /** A toy flung from the user's side straight to the companion (a click
     *  on a tray tile): a soft lob at their chest (at their mouth, for
     *  something to catch in it). */
    lob(t, from) {
        const b = this.body();
        if (!b) return;
        const to = add(b.pos, v3(0, b.height * (t.def.food?.style === "catch" ? 0.9 : 0.6), 0));
        t.p = { ...from };
        const flat = Math.hypot(to.x - from.x, to.z - from.z);
        const T = Math.max(0.6, Math.min(1.3, flat / 3));
        // Straight ballistics (drag is small over a lob this short; the
        // catch reaches for the difference).
        t.v = {
            x: (to.x - from.x) / T,
            y: (to.y - from.y + 0.5 * GRAVITY * T * T) / T,
            z: this.dims === 2 ? 0 : (to.z - from.z) / T,
        };
        t.wake();
        t.thrownAt = now();
        t.lastHitBy = "user";
        t.lastHitAt = now();
        t._incoming = false;
        this.emit("toss", t);
    }


    /** How far a held toy is from the companion's mouth, as the user sees
     *  it (a stage with depth measures across the view: a toy held at the
     *  wrong depth still looks held to the mouth). */
    offerGap(t, b) {
        return dist(t.p, add(b.pos, v3(0, b.height * 0.9, 0)));
    }

    noteHit(t, who) {
        t.lastHitBy = who;
        t.lastHitAt = now();
    }

    // ── the chest ────────────────────────────────────────────────────────

    openChest(chest) {
        if (chest.opened) return;
        chest.opened = true;
        this.onChestOpen?.(chest);
        const n = 10;
        for (let i = 0; i < n; i++) {
            const a = rand(-0.9, 0.9);
            const sp = rand(2.2, 3.6);
            const lat = this.dims === 2 ? 0 : rand(-1, 1);
            const c = this.add(TOYS.coin, add(chest.p, v3(0, chest.radius * 0.9, 0)),
                { x: Math.sin(a) * sp * 0.5, y: Math.cos(a) * sp, z: lat * 0.8 });
            c.omega = v3(rand(-20, 20), rand(-20, 20), rand(-20, 20));
        }
        toySfx.chime();
        this.emit("open", chest);
    }

    // ── stepping ─────────────────────────────────────────────────────────

    step(dt) {
        dt = Math.min(dt, 0.05);
        this.time += dt;
        this._gadgets(dt);
        this._acc += dt;
        let n = 0;
        while (this._acc >= STEP && n < 16) {
            this._acc -= STEP;
            n++;
            this._substep(STEP);
        }
        if (n >= 16) this._acc = 0;
        this._afterStep(dt);
        this.render(dt);
    }

    _substep(h) {
        const body = this.body();
        for (const t of this.toys) {
            if (!t.alive) continue;
            t._prevY = t.p.y;
            if (t.heldBy === "user") continue;
            if (t.heldBy === "companion") {
                const q = this.holdPoint(t);
                if (q) {
                    t.v = scale(sub(q, t.p), 1 / h);
                    t.p = q;
                }
                continue;
            }
            if (t.hovering || t.resting) continue;
            // A bubble is light enough to go with the room's own air too.
            fly(t, h, t.def.kind === "bubble"
                ? (p) => { const w = this.windAt(p), a = this.roomAir(p); return w ? add(w, a) : a; }
                : (p) => this.windAt(p));
            t.grounded = false;
            const floor = this.collideWorld(t, h);
            if (floor) {
                t.grounded = true;
                this._friction(t, h, floor);
            }
            this._hoopCollide(t);
            this._goalCollide(t);
            this._postsCollide(t);
            // Not their own body as it leaves their hands.
            if (body && now() - (t.releasedAt || 0) > RELEASE_CLEAR_MS) this._bodyCollide(t, body);
            this._spin(t, h);
            const slow = len(t.v) < REST_SPEED;
            if (t.grounded && slow) {
                t._still += h;
                if (t._still > REST_S && t.def.kind !== "bubble") {
                    t.resting = true;
                    t.v = v3();
                    t.omega = v3();
                    this.emit("rest", t);
                }
            } else t._still = 0;
        }
        // Toy against toy (bubbles burst on anything solid).
        const free = this.toys.filter((t) => t.alive && t.heldBy !== "user");
        for (let i = 0; i < free.length; i++) {
            for (let j = i + 1; j < free.length; j++) {
                const a = free[i], b = free[j];
                const ab = a.def.kind === "bubble", bb = b.def.kind === "bubble";
                if (ab && bb) continue;
                if (dist(a.p, b.p) > a.radius + b.radius) continue;
                if (ab || bb) {
                    const bub = ab ? a : b, other = ab ? b : a;
                    if (bub.src !== other) this.popBubble(bub);
                    continue;
                }
                if (a.heldBy === "companion" || b.heldBy === "companion") continue;
                a.pinned = a.hovering || a.resting && a.mass > b.mass * 4;
                b.pinned = b.hovering || b.resting && b.mass > a.mass * 4;
                if (collidePair(a, b)) {
                    if (!a.pinned) a.wake();
                    if (!b.pinned) b.wake();
                }
            }
        }
    }

    _friction(t, h, n) {
        // Along the floor only.
        const vn = dot(t.v, n);
        const vt = sub(t.v, scale(n, vn));
        const sp = len(vt);
        if (sp < 1e-6) return;
        const roll = t.def.shell || t.def.spins;
        const decel = (roll ? ROLL_RESIST : SLIDE_FRICTION) * GRAVITY * h;
        const k = Math.max(0, sp - decel) / sp;
        t.v = add(scale(vt, k), scale(n, vn));
    }

    _spin(t, h) {
        if (t.grounded && (t.def.shell || t.def.spins)) {
            // Rolling: ω = n × v / r with n up.
            t.omega = scale({ x: t.v.z, y: 0, z: -t.v.x }, 1 / t.radius);
        } else {
            // Tumbling through the air; on the floor a thing that doesn't
            // roll stops turning at once.
            t.omega = scale(t.omega, Math.exp(-(t.grounded ? 12 : 0.4) * h));
        }
        t.angle += t.omega.z * h;
    }

    _bodyCollide(t, b) {
        const a0 = add(b.pos, v3(0, BODY_R, 0));
        const a1 = add(b.pos, v3(0, b.height - BODY_R * 0.6, 0));
        const c = closestOnSegment(t.p, this.dims === 2 ? { ...a0, z: 0 } : a0, this.dims === 2 ? { ...a1, z: 0 } : a1);
        const d = sub(t.p, c);
        const l = len(d);
        const r = BODY_R + t.radius;
        if (l >= r) return;
        if (t.def.kind === "bubble") { this.popBubble(t); return; }
        // Something they're catching in their mouth, reaching their face:
        // in (brains.js mouthCatch).
        if (t.mouthCatch && c.y > b.pos.y + b.height * 0.78) {
            t.inMouth = true;
            t.v = v3();
            t.hovering = true;
            return;
        }
        const n = l > 1e-6 ? scale(d, 1 / l) : norm({ x: t.p.x - b.pos.x || 1, y: 0, z: 0 });
        const sp = bounce(t, n, r - l, { e: Math.min(0.5, t.def.restitution) });
        t.wake();
        if (sp > HIT_SPEED && now() - (t._hitAt || 0) > 800) {
            t._hitAt = now();
            const part = c.y > b.pos.y + b.height * 0.78 ? "head" : "body";
            toySfx.bounce(sp, t.def.id);
            this.emit("hit", t, { part, speed: sp });
        }
    }

    _afterStep(dt) {
        const b = this.body();
        // Held still: no longer moving.
        const held = this.drag;
        if (held && now() - held.samples[held.samples.length - 1].at > 60) held.toy.v = v3();
        for (const t of [...this.toys]) {
            if (!t.alive) continue;
            // Bubbles burst when their time is up (or they touch down).
            if (t.def.kind === "bubble") {
                t.life -= dt;
                // The breath inside cooling to the room's.
                t.age = (t.age || 0) + dt;
                if (t.warm) t.lift = bubbleLift(t, t.def.buoyancy + t.warm * Math.exp(-t.age / t.coolS));
                if (t.life <= 0 || t.grounded) this.popBubble(t);
                continue;
            }
            // A wand with air going through its ring (waved about in the
            // user's hand, or held up to a fan's wind) makes bubbles;
            // they're left in the air that made them, so they hang where
            // the ring was. One just falling or rolling doesn't.
            const wind = t.def.kind === "wand" && t.heldBy !== "companion" ? this.windAt(this.wandRing(t)) : null;
            if (t.def.kind === "wand" && (t.heldBy === "user" || wind)) {
                const air = wind || v3();
                const through = len(sub(t.v, air));
                if (through > 0.8 && Math.random() < dt * 5 * Math.min(3, through)) {
                    const bub = this.blowBubble(t, norm(sub(air, t.v)), 0.05);
                    bub.v = { ...air, z: this.dims === 2 ? 0 : air.z };
                }
            }
            // A hair dryer on their head for a moment: they lean into it.
            if (t.def.kind === "dryer" && b) {
                const head = add(b.pos, v3(0, b.height * 0.9, 0));
                if (t.on && t.blowingAt(head)) {
                    t._onHead = (t._onHead || 0) + dt;
                    if (t._onHead > 0.6 && !t._dried) { t._dried = true; this.emit("blowdry", t); }
                } else if ((t._onHead = Math.max(0, (t._onHead || 0) - dt)) === 0) t._dried = false;
            }
            // Something thrown their way: a heads-up so they can catch it.
            if (b && !t._incoming && t.heldBy == null && t.thrownAt && now() - t.thrownAt < 1500) {
                const chest = add(b.pos, v3(0, b.height * 0.6, 0));
                const rel = sub(chest, t.p);
                const d = len(rel);
                const closing = dot(t.v, rel) / Math.max(d, 1e-6);
                if (closing > 0.5 && d / closing < 0.9) {
                    t._incoming = true;
                    this.emit("incoming", t);
                }
            }
        }
        // Food held out to their mouth.
        const d = this.drag;
        if (d && b && d.toy.def.kind === "food" && !d.offered) {
            if (this.offerGap(d.toy, b) < OFFER_NEAR + d.toy.radius) d.offerT += dt; else d.offerT = 0;
            if (d.offerT > OFFER_S) {
                d.offered = true;
                this.emit("offer", d.toy);
            }
        }
    }
}
