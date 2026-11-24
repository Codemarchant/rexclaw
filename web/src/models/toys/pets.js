// The toy box's pets: what each one does with itself. A pet is a toy with a
// mind (toy.pet): it walks, flies or swims about on its own instead of
// lying where it fell, keeps near the companion, naps, has its own habits
// (a cat washes, a dog fetches, a frog never stops hopping, a crab scuttles
// sideways, Gerald circles), and answers a click with its voice. Shared by
// both stages, in the toys' metres: on the desktop everything is side on
// (z = 0, facing left or right).
//
// A mind doesn't draw anything. It moves its toy (`toy.p`, its own `yaw`)
// and says how it's carrying itself in `toy.anim` (read by the rig,
// pet_rig.js, or the desktop's sprite) and `toy.cues` (one-off moves).
//
// What the companion does with a pet is in brains.js, and it's the user who
// starts it (setting a pet down, handing it over). A pet itself only emits
// "pet_ask" (a bird would like their arm to sit on, and only while nobody's
// talking), "pet_stole" (Gerald ate their snack) and "pet_fetch" (the dog
// brought the ball back).

import { _t } from "../../lib/i18n";
import { add, dist, flatDist, len, norm, scale, sub, v3 } from "./physics";
import { toySfx } from "./sfx";

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const now = () => performance.now();

// All by eye, in a room a few metres across.
// How fast a pet turns (rad/s), and how close counts as there (m): or
// this close when the spot itself is taken; no errand lasts longer than
// GO_S (the room is a few seconds across at any pet's pace).
const TURN = 4.5;
const ARRIVE = 0.06;
const BLOCKED_NEAR = 0.4;
const GO_S = 14;
// They keep within this of the companion, and this clear of their feet.
const FOLLOW_FAR = 2.2;
const KEEP_CLEAR = 0.34;
// Wandering: this far from the companion at most.
const ROAM_R = 1.7;
// Nothing social while either of you is talking, nor for this long after
// (brains.js QUIET_MS).
const QUIET_MS = 10000;
// A voice of its own accord: this far apart at least (s).
const VOICE_GAP = [35, 90];
// A nap is a short one (s).
const NAP_S = [5, 9];
// Food left lying this long is fair game (ms).
const LEFT_MS = 7000;
// A bird's flight: its speed (m/s), how high over the straight line it
// arcs (a share of the distance); how long it sits on a held-out arm, and
// how long before it wants one again (s).
const FLY_SPEED = 1.7;
const FLY_ARC = 0.22;
const PERCH_S = [10, 16];
const ARM_GAP_S = 150;
// Gerald's round of the companion: how far out, how fast (m/s).
const ORBIT_R = 0.85;
const SWIM = 0.45;

const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export class PetMind {
    constructor(world, toy) {
        this.w = world;
        this.t = toy;
        this.d = toy.def.pet;
        this.move = this.d.move || "walk";      // "walk" | "fly" | "swim"
        this.yaw = 0;
        this.kinematic = false;
        this.state = "new";
        this.until = 0;
        this.clock = 0;
        this.target = null;
        this.then = null;
        this.run = false;
        this.happy = 0;
        this.attend = 0;
        this.stroked = 0;
        this.perch = null;                      // {spot, side} while on the companion's hand
        this._perchedAt = -ARM_GAP_S / 2;       // (a first sit on their arm half a wait in)
        this.orbit = rand(0, 6.28);
        this.nextVoice = rand(8, 30);
        this.anim = toy.anim = { speed: 0, turn: 0, climb: 0, pose: "stand", look: null, happy: 0, asleep: false, pant: false, tilt: 0 };
        toy.cues = [];
        toy.pet = this;
        const b = world.body();
        if (b) this.yaw = yawTo(toy.p, b.pos);
    }

    get dims() { return this.w.dims; }
    get name() { return this.t.def.name; }

    cue(name, dur) { this.t.cues.push({ name, dur }); }

    get quiet() {
        const box = this.w.box;
        return !box || (box.state.idle && box.quietMs() >= QUIET_MS);
    }

    // ── what others do to it ─────────────────────────────────────────────

    /** A click: its voice, and a little show. */
    poke() {
        if (this.anim.asleep) this._wake();
        this.speak(true);
        this.happy = 1;
        this.cue(this.move === "swim" ? "chomp" : this.move === "fly" ? "flap" : "hop");
        this.w.petFx?.(this.t, "hearts");
    }

    /** Its voice (and the word, when the user asked for it). */
    speak(loud = false) {
        const d = this.d;
        if (d.voice?.length) toySfx.sample(pick(d.voice), { vol: loud ? 1 : 0.6, rate: rand(0.94, 1.08) });
        else if (d.sfx) toySfx[d.sfx]?.();
        this.cue(this.move === "swim" ? "chomp" : "voice");
        if (loud && d.word) this.w.petFx?.(this.t, "word", _t(d.word));
        this.nextVoice = this.clock + rand(...VOICE_GAP);
    }

    /** The companion is on their way over to it: it waits, sitting, looking
     *  up at them, for `s` seconds. */
    attendFor(s) {
        this.attend = this.clock + s;
        if (this.perch) return;
        this.target = null;
        this.then = null;
        this._putDown();
        // A ball it was after is still there to be fetched.
        if (this._after?.alive && !this._after.heldBy) this._after._fetch = true;
        this._after = null;
        if (this.anim.asleep) this._wake();
    }

    /** Being stroked for `s` seconds: purring, pleased. */
    strokedFor(s) {
        this.stroked = this.clock + s;
        this.happy = 1;
        this.cue("nuzzle");
    }

    /** Fly (or swim) to the companion's held-out hand and stay there a
     *  while. */
    perchOn(spot = "hand", side = "right") {
        if (!this.w.perchPoint?.(spot, side)) return false;
        this.perch = { spot, side, landed: false, until: this.clock + rand(...PERCH_S) + 4 };
        this.state = "toperch";
        this.attend = 0;
        return true;
    }

    get perched() { return !!this.perch?.landed; }

    /** Off the companion again. */
    leave() {
        if (!this.perch) return;
        this.perch = null;
        this._idle(0.2);
    }

    // ── each frame ───────────────────────────────────────────────────────

    tick(dt) {
        const t = this.t, a = this.anim;
        this.clock += dt;
        this.happy = Math.max(0, this.happy - dt / 7);
        a.happy = Math.max(this.happy, this.stroked > this.clock ? 1 : 0);
        a.pant = this.d.species === "dog" && (a.happy > 0.4 || this.run);
        this._purr(t.heldBy === "companion" || this.stroked > this.clock);
        if (t.heldBy === "user") {
            // Picked up: dangling from the hand, looking at whoever has it.
            this._carried("dangle");
            return;
        }
        if (t.heldBy === "companion") {
            this._carried("held");
            const y = this.w.holdYaw?.(t);
            if (y != null) this.yaw = y;
            return;
        }
        if (this.state === "carried") this._let();
        if (!this.kinematic) {
            // Let go of in the air. A bird or Gerald catches itself; the
            // rest drop (they land on their feet) and carry on once down.
            if (this.move !== "walk") {
                this.kinematic = true;
                t.hovering = false;
                this._idle(0.3);
                // (Its "landing", for whoever was waiting on one: react.js.)
                this.w.emit("rest", t);
            }
            else {
                a.pose = t.grounded ? "stand" : "dangle";
                a.speed = 0;
                if (t.resting) { this.kinematic = true; this._idle(0.6); }
                return;
            }
        }
        if (this.nextVoice < this.clock && this.quiet && !a.asleep && this.state !== "go") this.speak(false);
        if (this.move === "fly") this._flyer(dt);
        else if (this.move === "swim") this._swimmer(dt);
        else this._walker(dt);
    }

    _carried(pose) {
        const a = this.anim;
        this.state = "carried";
        this.kinematic = false;
        this.perch = null;
        this.target = null;
        this._putDown();
        a.pose = pose;
        a.speed = a.turn = a.climb = 0;
        a.asleep = false;
        a.look = null;
    }

    _let() {
        // (Its fall, if any, is the physics'.)
        this.state = "fall";
        this.t.resting = false;
    }

    _purr(on) {
        const sound = this.d.purr;
        if (!sound || on === this._purring) return;
        this._purring = on;
        // (A purr is a murmur under the calls.)
        toySfx.sampleLoop(`purr${this.t.uid}`, on ? sound : null, 0.4);
    }

    _wake() {
        this.anim.asleep = false;
        this._idle(0.4);
    }

    _idle(s = rand(0.6, 2)) {
        this.state = "idle";
        this.until = this.clock + s;
        this.target = null;
        this.then = null;
        this.run = false;
        this.anim.speed = 0;
        this.anim.asleep = false;
        if (this.move === "walk") this.anim.pose = "stand";
    }

    _rest(pose, s) {
        this.state = pose;
        this.until = this.clock + s;
        this.anim.pose = pose;
        this.anim.speed = 0;
    }

    /** Forty winks: curled up with its eyes shut for a few seconds. */
    _nap(s = rand(...NAP_S)) {
        this._rest(this.move === "walk" ? "sleep" : this.anim.pose, s);
        this.state = "sleep";
        this.anim.asleep = true;
    }

    /** Off to `target`: a place, or a function giving where something that
     *  moves is now (null once it's gone). */
    _go(target, then = null, { run = false } = {}) {
        this.state = "go";
        this.goBy = this.clock + GO_S;
        this.target = typeof target === "function" ? target : { ...target };
        this.then = then;
        this.run = run;
        this.anim.pose = this.move === "walk" ? "stand" : this.anim.pose;
        this.anim.asleep = false;
    }

    _act(cueName, s, then = null) {
        this.state = "act";
        this.until = this.clock + s;
        this.then = then;
        this.anim.speed = 0;
        if (cueName) this.cue(cueName, s);
    }

    /** Where the companion's face is, for looking up at them; the user's
     *  side otherwise. */
    _lookAt(p) {
        if (!p) { this.anim.look = null; return; }
        const t = this.t;
        if (this.dims === 2) {
            const ahead = Math.sign(p.x - t.p.x) === Math.sign(Math.sin(this.yaw)) || Math.abs(p.x - t.p.x) < 0.05;
            this.anim.look = { yaw: ahead ? 0 : 0.6, pitch: clamp(Math.atan2(p.y - t.p.y, Math.abs(p.x - t.p.x) + 0.2), -0.6, 0.9) };
            return;
        }
        const yaw = wrap(yawTo(t.p, p) - this.yaw);
        const flat = Math.max(0.15, flatDist(t.p, p));
        this.anim.look = { yaw: clamp(yaw, -1.4, 1.4), pitch: clamp(Math.atan2(p.y - t.p.y, flat), -0.6, 0.9) };
    }

    _face(p, dt, rate = TURN) {
        if (this.dims === 2) {
            if (Math.abs(p.x - this.t.p.x) > 0.02) this.yaw = p.x > this.t.p.x ? Math.PI / 2 : -Math.PI / 2;
            return 0;
        }
        const diff = wrap(yawTo(this.t.p, p) - this.yaw);
        const step = clamp(diff, -rate * dt, rate * dt);
        this.yaw = wrap(this.yaw + step);
        return diff;
    }

    _companionHead() {
        const b = this.w.body();
        return b ? add(b.pos, v3(0, b.height * 0.9, 0)) : null;
    }

    // ── on foot ──────────────────────────────────────────────────────────

    _walker(dt) {
        const t = this.t, a = this.anim, w = this.w;
        // The floor it's on (a window's top, on the desktop): gone, it falls.
        const floor = w.petFloor(t);
        if (floor == null) { this.kinematic = false; t.resting = false; t.wake(); this.state = "fall"; return; }
        t.p.y = floor + t.radius;
        t.v = v3();
        t.resting = true;
        // Waited on by the companion: sat still, looking up at them.
        if (this.attend > this.clock) {
            const b = w.body();
            a.speed = 0;
            a.asleep = false;
            a.pose = "sit";
            if (b) { this._face(b.pos, dt, 3); this._lookAt(this._companionHead()); }
            this.state = "idle";
            this.until = this.attend;
            return;
        }
        if (this.state === "go") {
            if (this._walk(dt)) {
                const then = this.then;
                this._idle(rand(0.3, 0.9));
                then?.();
            }
            return;
        }
        a.speed = 0;
        a.turn = 0;
        if (this.state === "sleep") this._lookAt(null);
        else if (this.state !== "act") this._lookAt(Math.sin(this.clock * 0.23 + t.uid) > 0.2 ? this._companionHead() : null);
        // A ball thrown: off after it at once, whatever it was up to.
        if (this.d.fetches && this.state !== "act") {
            const ball = w.nearest((o) => o.def.kind === "fetch" && o._fetch && !o.heldBy, t.p, 9);
            if (ball) { if (a.asleep) this._wake(); this._fetch(ball); return; }
        }
        if (this.clock < this.until) return;
        if (this.state === "act") {
            const then = this.then;
            this._idle(rand(0.3, 1));
            then?.();
            return;
        }
        this._choose();
    }

    /** A step toward the target; true once there. */
    _walk(dt) {
        const t = this.t, a = this.anim, w = this.w;
        const tgt = typeof this.target === "function" ? this.target() : this.target;
        if (!tgt) return true;
        const to = { x: tgt.x - t.p.x, y: 0, z: this.dims === 2 ? 0 : tgt.z - t.p.z };
        const d = len(to);
        // There; or as near as it can get, when someone's sat on the spot
        // (it would circle them for ever), or it's taking far too long.
        const blocked = this.dims !== 2 && d < BLOCKED_NEAR && len(this._avoid()) > 0.05;
        if (d < (this.near || ARRIVE) || blocked || this.clock > this.goBy) { a.speed = 0; a.turn = 0; return true; }
        // Its pace; a hopper covers the ground in its leaps and none while
        // it gathers for the next (the rig's `surge`, about 1 on average).
        const pace = this.run ? this.d.run : this.d.walk;
        const top = pace * (w.petSurge?.(t) ?? 1);
        let diff = 0;
        if (this.dims === 2) this.yaw = to.x > 0 ? Math.PI / 2 : -Math.PI / 2;
        else {
            // Round the companion's feet and the other pets, not through.
            const steer = norm(to);
            const push = this._avoid();
            const want = norm(add(steer, push));
            diff = wrap(Math.atan2(want.x, want.z) - this.yaw);
            const step = clamp(diff, -TURN * dt, TURN * dt);
            this.yaw = wrap(this.yaw + step);
            a.turn = step / Math.max(dt, 1e-4);
        }
        // Slower while turning to it, and into the stop.
        const speed = top * clamp(1 - Math.abs(diff) / 1.6, 0.25, 1) * clamp(d / 0.12, 0.35, 1);
        t.p.x += Math.sin(this.yaw) * speed * dt;
        if (this.dims !== 2) t.p.z += Math.cos(this.yaw) * speed * dt;
        w.petClamp(t);
        // (The rig is told the pace, not the leap: it's what sets the hops
        // going in the first place.)
        a.speed = pace * clamp(1 - Math.abs(diff) / 1.6, 0.25, 1);
        a.pose = "stand";
        this._lookAt(null);
        return false;
    }

    _avoid() {
        const t = this.t, w = this.w;
        let push = v3();
        const b = w.body();
        const from = (p, r, k = 1) => {
            const dx = t.p.x - p.x, dz = t.p.z - p.z, d = Math.hypot(dx, dz);
            if (d < r && d > 1e-4) push = add(push, scale({ x: dx / d, y: 0, z: dz / d }, (k * (r - d)) / r * 2.2));
        };
        if (b) from(b.pos, KEEP_CLEAR + t.radius);
        for (const o of w.toys) {
            if (o === t || !o.alive || o.heldBy) continue;
            if (o.pet) from(o.p, t.radius + o.radius + 0.05);
            else if (o.def.placed || o.def.gadget) from(o.p, t.radius + o.radius + 0.05, 0.8);
        }
        return push;
    }

    _choose() {
        const t = this.t, w = this.w, d = this.d;
        const b = w.body();
        if (this._special()) return;
        const far = b ? flatDist(t.p, b.pos) : 0;
        const opts = [
            [30, () => this._go(w.petRoam(t, b ? b.pos : null, ROAM_R))],
            [22, () => this._rest("sit", rand(4, 9))],
            [9, () => this._rest("lie", rand(6, 14))],
            [w.dark?.() ? 12 : 4, () => this._nap()],
        ];
        if (b && far > FOLLOW_FAR) opts.push([90, () => this._go(w.petRoam(t, b.pos, 1.0), null, { run: far > FOLLOW_FAR * 1.6 })]);
        if (d.species === "cat") {
            opts.push([14, () => { this._rest("sit", 3.2); this.state = "act"; this.cue("groom", 2.8); }]);
            opts.push([6, () => this._act("stretch", 1.8)]);
        }
        if (d.species === "dog") {
            opts.push([7, () => this._go(w.petRoam(t, b ? b.pos : null, ROAM_R), () => this._go(w.petRoam(t, b ? b.pos : null, ROAM_R), null, { run: true }), { run: true })]);
            opts.push([6, () => this._act("shake", 0.9)]);
        }
        if (d.species === "rabbit") opts.push([9, () => { this.happy = 0.6; this._act("hop", 0.55, () => this._act("hop", 0.55)); }]);
        if (d.species === "frog") {
            // Always on the go: off across the floor in a string of hops,
            // or bouncing on the spot.
            opts.push([45, () => this._go(w.petRoam(t, b ? b.pos : null, ROAM_R), () => this._go(w.petRoam(t, b ? b.pos : null, ROAM_R)))]);
            opts.push([20, () => this._act("hop", 0.5, () => this._act("hop", 0.5, () => this._act("hop", 0.5)))]);
        }
        if (d.species === "crab") opts.push([14, () => this._act("voice", 0.9)]);
        // Over to the companion to sit by their feet for a while (nothing
        // is asked of them: they're not called away from what they're at).
        if (b && d.asks && far < 4) {
            opts.push([8, () => {
                this.near = KEEP_CLEAR + t.radius + 0.05;
                this._go(b.pos, () => {
                    this.near = 0;
                    this.cue("nuzzle");
                    this._rest("sit", rand(6, 12));
                });
            }]);
        }
        let r = Math.random() * opts.reduce((s, [k]) => s + k, 0);
        for (const [k, fn] of opts) { if ((r -= k) <= 0) { fn(); return; } }
    }

    /** The habits that come before idling about: a snack it fancies, a
     *  ball to fetch, a bubble to jump at, something small to bat. */
    _special() {
        const t = this.t, w = this.w, d = this.d;
        this.near = 0;
        // A ball to fetch.
        if (d.fetches) {
            const ball = w.nearest((o) => o.def.kind === "fetch" && o._fetch && !o.heldBy, t.p, 9);
            if (ball) { this._fetch(ball); return true; }
        }
        // Food it likes, left lying.
        const food = this._snack(3);
        if (food) {
            this.near = t.radius + food.radius + 0.04;
            this._go(() => (food.alive && !food.heldBy ? food.p : null), () => { this.near = 0; this._eat(food); });
            return true;
        }
        // A bubble low enough to jump at.
        if (d.pounces) {
            const bub = w.nearest((o) => o.def.kind === "bubble" && o.p.y - w.petFloor(t) < 0.75, t.p, 1.8);
            if (bub && Math.random() < 0.7) {
                this._go(() => (bub.alive ? bub.p : null), () => {
                    this._act("hop", 0.5);
                    if (bub.alive && flatDist(bub.p, t.p) < 0.3) setTimeout(() => { if (bub.alive) w.popBubble(bub, "pet"); }, 200);
                }, { run: true });
                this.near = 0.12;
                return true;
            }
        }
        // Something small to bat across the floor.
        if (d.bats && Math.random() < 0.12) {
            const toy = w.nearest((o) => !o.pet && o.resting && !o.heldBy && o.radius < 0.06 && o.def.kind !== "bubble" && !w.inUse?.(o), t.p, 1.4);
            if (toy) {
                this.near = t.radius + toy.radius + 0.03;
                this._go(() => (toy.alive && !toy.heldBy ? toy.p : null), () => {
                    this.near = 0;
                    this._act("paw", 0.7);
                    setTimeout(() => {
                        if (!toy.alive || toy.heldBy || flatDist(toy.p, t.p) > 0.4) return;
                        const dir = norm(sub(toy.p, t.p));
                        toy.v = { x: dir.x * rand(1, 1.8), y: 0.4, z: this.dims === 2 ? 0 : dir.z * rand(1, 1.8) };
                        toy.wake();
                    }, 330);
                });
                return true;
            }
        }
        return false;
    }

    _snack(maxDist) {
        const likes = this.d.eats;
        if (!likes) return null;
        return this.w.nearest((o) => o.def.kind === "food" && (likes === "all" || likes.includes(o.def.id)) && o.resting && !o.heldBy
            && !o.def.vessel && now() - Math.max(o.born, o.lastHitAt || 0) > LEFT_MS && !this.w.inUse?.(o), this.t.p, maxDist);
    }

    _eat(food) {
        const t = this.t, w = this.w;
        if (!food.alive || food.heldBy || dist(food.p, t.p) > t.radius + food.radius + 0.35) return;
        const bites = this.move === "swim" ? 1 : 3;
        const dur = this.move === "swim" ? 0.7 : 1.3;
        this._act(this.move === "swim" ? "chomp" : "nom", dur, () => {
            if (food.alive) { w.petFx?.(food, "crumbs", food.def.food.crumbs); food.remove(); }
            this.happy = 1;
            // Gerald helps himself: the companion gets to say so.
            if (this.move === "swim" && w.body()) w.emit("pet_stole", t, { food: food.def });
        });
        for (let i = 1; i <= bites; i++) {
            setTimeout(() => {
                if (!food.alive || food.heldBy) return;
                toySfx.chomp();
                if (i < bites) food.bite(1 - i / bites);
            }, (dur * 1000 * i) / (bites + 0.5));
        }
    }

    /** After a ball, into the mouth, and back to the companion's feet (the
     *  user's side, with nobody there). */
    _fetch(ball) {
        const t = this.t, w = this.w;
        ball._fetch = false;
        this._after = ball;
        this.happy = 1;
        this.near = t.radius + ball.radius + 0.05;
        this._go(() => (ball.alive && !ball.heldBy ? ball.p : null), () => {
            this._after = null;
            if (!ball.alive || ball.heldBy || dist(ball.p, t.p) > t.radius + ball.radius + 0.4) { this.near = 0; return; }
            ball.heldBy = "pet";
            ball.carrier = t;
            ball.hovering = false;
            this.carrying = ball;
            const b = w.body();
            const to = b ? b.pos : w.userPoint();
            this.near = (b ? KEEP_CLEAR : 0.2) + t.radius + 0.12;
            this._go(to, () => {
                this.near = 0;
                this._putDown(!!b);
                this.speak(false);
                this._rest("sit", 5);
            }, { run: true });
        }, { run: true });
    }

    /** What's in its mouth, dropped where it stands. `brought`: at the
     *  companion's feet, for them to throw again. */
    _putDown(brought = false) {
        const ball = this.carrying, t = this.t;
        this.carrying = null;
        if (!ball?.alive || ball.heldBy !== "pet" || ball.carrier !== t) return;
        ball.heldBy = null;
        ball.carrier = null;
        ball.v = v3();
        ball.wake();
        toySfx.bounce(2, "ball");
        if (brought) {
            ball._brought = now();
            this.w.emit("pet_fetch", ball, { pet: t });
        }
    }

    /** Where something in its mouth is carried. */
    carryPoint() {
        const m = this.w.petMouth?.(this.t);
        if (m) return m;
        const f = this.dims === 2 ? { x: Math.sign(Math.sin(this.yaw)), z: 0 } : { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
        return { x: this.t.p.x + f.x * this.t.radius * 1.3, y: this.t.p.y + this.t.radius * 0.3, z: this.t.p.z + f.z * this.t.radius * 1.3 };
    }

    // ── on the wing ──────────────────────────────────────────────────────

    _flyer(dt) {
        const t = this.t, a = this.anim, w = this.w;
        t.v = v3();
        t.resting = true;
        if (this.perch) { this._perching(dt); return; }
        if (this.state === "go") {
            if (this._flight(dt)) {
                const then = this.then;
                this._idle(rand(0.5, 1.5));
                then?.();
            }
            return;
        }
        // On its feet.
        const floor = w.petFloor(t) ?? 0;
        if (t.p.y - t.radius > floor + 0.03) { this._flyTo({ ...t.p, y: floor + t.radius }); return; }
        t.p.y = floor + t.radius;
        a.pose = "stand";
        a.speed = 0;
        a.climb = 0;
        if (this.attend > this.clock) {
            const b = w.body();
            if (b) { this._face(b.pos, dt, 3); this._lookAt(this._companionHead()); }
            return;
        }
        if (this.state === "hop") {
            // A few hopping steps along the floor.
            const done = this._walk(dt);
            a.pose = "stand";
            if (done || this.clock > this.until) this._idle(rand(0.5, 2));
            return;
        }
        if (this.state !== "sleep") this._lookAt(Math.sin(this.clock * 0.31 + t.uid) > 0 ? this._companionHead() : null);
        if (this.clock < this.until) return;
        if (this.state === "act") { const then = this.then; this._idle(rand(0.4, 1)); then?.(); return; }
        const b = w.body();
        const food = this._snack(4);
        if (food) {
            this._flyTo(add(food.p, v3(t.radius + food.radius, t.radius - food.radius, 0)), () => { this._face(food.p, 1, 99); this._eat(food); });
            return;
        }
        const far = b ? flatDist(t.p, b.pos) : 0;
        const opts = [
            [22, () => { this.state = "hop"; this.target = w.petRoam(t, t.p, 0.5); this.until = this.goBy = this.clock + 3; }],
            [16, () => this._act("preen", 2.0)],
            [8, () => this._act("flap", 0.9)],
            [w.dark?.() && !this.d.nocturnal ? 14 : 4, () => this._nap()],
            [far > FOLLOW_FAR ? 70 : 16, () => this._flyTo(w.petRoam(t, b ? b.pos : null, 1.3))],
        ];
        // Now and then, when nobody's talking: it would like their arm to
        // sit on for a bit (brains.js offerHand; they hold it out).
        if (b && this.quiet && this.clock - this._perchedAt > ARM_GAP_S && !w.armTaken?.(t)) {
            opts.push([20, () => { this._perchedAt = this.clock; this._act("flap", 0.9); w.emit("pet_ask", t); }]);
        }
        let r = Math.random() * opts.reduce((s, [k]) => s + k, 0);
        for (const [k, fn] of opts) { if ((r -= k) <= 0) { fn(); return; } }
    }

    _flyTo(target, then = null) {
        const t = this.t;
        this.state = "go";
        this.then = then;
        this.fly = { from: { ...t.p }, to: { ...target }, s: 0, len: Math.max(0.05, dist(t.p, target)) };
        this.cue("flap", 0.3);
    }

    /** Along its arc; true once landed. `to` may move (a shoulder). */
    _flight(dt, to = null) {
        const t = this.t, a = this.anim, f = this.fly;
        if (!f) return true;
        if (to) f.to = to;
        f.s = Math.min(1, f.s + (FLY_SPEED * dt) / f.len);
        const s = f.s * f.s * (3 - 2 * f.s);
        const prev = { ...t.p };
        t.p = {
            x: f.from.x + (f.to.x - f.from.x) * s,
            y: f.from.y + (f.to.y - f.from.y) * s + Math.sin(Math.PI * f.s) * Math.max(0.15, f.len * FLY_ARC),
            z: this.dims === 2 ? 0 : f.from.z + (f.to.z - f.from.z) * s,
        };
        const v = scale(sub(t.p, prev), 1 / Math.max(dt, 1e-4));
        const flat = Math.hypot(v.x, v.z);
        if (flat > 0.05) {
            if (this.dims === 2) this.yaw = v.x > 0 ? Math.PI / 2 : -Math.PI / 2;
            else {
                const diff = wrap(Math.atan2(v.x, v.z) - this.yaw);
                const step = clamp(diff, -7 * dt, 7 * dt);
                this.yaw = wrap(this.yaw + step);
                a.turn = step / Math.max(dt, 1e-4);
            }
        }
        // Wings out until the last moment.
        a.pose = f.s < 0.93 ? "fly" : "stand";
        a.speed = len(v);
        a.climb = clamp(v.y / FLY_SPEED, -1, 1);
        a.asleep = false;
        this._lookAt(null);
        if (f.s < 1) return false;
        this.fly = null;
        a.speed = a.climb = a.turn = 0;
        return true;
    }

    /** On (or on its way to) the companion's hand or shoulder. */
    _perching(dt) {
        const t = this.t, a = this.anim, w = this.w, p = this.perch;
        const at = w.perchPoint?.(p.spot, p.side);
        if (!at) { this.leave(); return; }
        const spot = { x: at.x, y: at.y + t.radius, z: at.z };
        if (!p.landed) {
            if (!this.fly) this._flyTo(spot);
            this.state = "toperch";
            if (this._flight(dt, spot)) {
                p.landed = true;
                this._perchedAt = this.clock;
                this.cue("flap", 0.5);
            }
            return;
        }
        // Sat on their hand, wherever it goes.
        t.p = spot;
        const face = w.body()?.facing;
        if (face) this.yaw = this.dims === 2 ? (face.x >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(face.x, face.z);
        a.pose = "stand";
        a.speed = 0;
        this._lookAt(Math.sin(this.clock * 0.4) > 0.3 ? this._companionHead() : w.userPoint());
        if (this.clock > (this._fidget || 0)) {
            this._fidget = this.clock + rand(5, 12);
            this.cue(pick(["preen", "nod", "flap"]));
        }
        // Had its sit: off again (they lower the arm, brains.js).
        if (this.clock > p.until) {
            this._perchedAt = this.clock;
            this.perch = null;
            const b = w.body();
            this._flyTo(w.petRoam(t, b ? b.pos : null, 1.3));
        }
    }

    // ── in the air, swimming ─────────────────────────────────────────────

    _swimmer(dt) {
        const t = this.t, a = this.anim, w = this.w;
        t.resting = true;
        t.v = v3();
        a.pose = "stand";
        const b = w.body();
        const floor = w.petFloor(t) ?? 0;
        if (this.perch) {
            // Come to their hand for a fuss.
            const at = w.perchPoint?.(this.perch.spot, this.perch.side);
            if (!at) { this.leave(); return; }
            const spot = add(at, v3(0, t.radius * 0.6, 0));
            this.perch.landed = this._swim(spot, dt, SWIM * 2) < t.radius + 0.12;
            if (this.perch.landed && b) this._lookAt(this._companionHead());
            if (this.clock > this.perch.until) this.leave();
            return;
        }
        if (this.state === "act") {
            a.speed = 0.05;
            if (this.clock >= this.until) { const then = this.then; this._idle(0.2); then?.(); }
            return;
        }
        if (this.state === "go") {
            const tgt = typeof this.target === "function" ? this.target() : this.target;
            if (!tgt || this._swim(tgt, dt, SWIM * 2.2) < (this.near || 0.1)) {
                const then = this.then;
                this._idle(0.2);
                then?.();
            }
            return;
        }
        // His round: circling whoever's there like an invoice, at about
        // their chest, rising and dipping.
        const centre = b ? b.pos : w.petRoam(t, null, 0);
        const high = b ? b.height : 1.6;
        this.orbit += (dt * SWIM) / ORBIT_R * (this._dir ||= Math.random() < 0.5 ? 1 : -1);
        const r = ORBIT_R + 0.15 * Math.sin(this.clock * 0.37);
        const y = floor + high * (0.62 + 0.2 * Math.sin(this.clock * 0.45 + 1));
        const tgt = this.dims === 2
            ? { x: centre.x + Math.sin(this.orbit) * (r + 0.5), y, z: 0 }
            : { x: centre.x + Math.sin(this.orbit) * r, y, z: centre.z + Math.cos(this.orbit) * r };
        this._swim(tgt, dt, SWIM * (this.attend > this.clock ? 0.4 : 1.3));
        this._lookAt(Math.sin(this.clock * 0.5) > 0.5 ? this._companionHead() : null);
        if (this.clock < this.until) return;
        this.until = this.clock + rand(6, 14);
        const food = this._snack(6);
        if (food) {
            this.near = t.radius + food.radius + 0.06;
            this._go(() => (food.alive && !food.heldBy ? add(food.p, v3(0, t.radius * 0.5, 0)) : null), () => { this.near = 0; this._eat(food); });
            return;
        }
        // Now and then up to the glass for a look at you, and a grin.
        if (Math.random() < 0.25) {
            const u = w.userPoint();
            this.near = 0.25;
            this._go(u, () => { this.near = 0; this._lookAt(u); this._act("chomp", 0.8); });
        }
    }

    /** Toward `tgt` through the air; returns how far off it still is. */
    _swim(tgt, dt, top) {
        const t = this.t, a = this.anim;
        const to = sub(tgt, t.p);
        if (this.dims === 2) to.z = 0;
        const d = len(to);
        if (d < 1e-3) { a.speed = 0; return d; }
        const speed = top * clamp(d / 0.4, 0.15, 1);
        const dir = scale(to, 1 / d);
        if (this.dims === 2) {
            if (Math.abs(dir.x) > 0.15) this.yaw = dir.x > 0 ? Math.PI / 2 : -Math.PI / 2;
            t.p = { x: t.p.x + dir.x * speed * dt, y: t.p.y + dir.y * speed * dt, z: 0 };
            a.turn = 0;
        } else {
            const diff = Math.hypot(dir.x, dir.z) > 0.05 ? wrap(Math.atan2(dir.x, dir.z) - this.yaw) : 0;
            const step = clamp(diff, -2.6 * dt, 2.6 * dt);
            this.yaw = wrap(this.yaw + step);
            a.turn = step / Math.max(dt, 1e-4);
            // Forward along his nose, and straight to the height.
            const fwd = speed * clamp(1 - Math.abs(diff) / 2, 0.2, 1) * Math.hypot(dir.x, dir.z);
            t.p = { x: t.p.x + Math.sin(this.yaw) * fwd * dt, y: t.p.y + dir.y * speed * dt, z: t.p.z + Math.cos(this.yaw) * fwd * dt };
        }
        this.w.petClamp(t);
        a.speed = speed;
        a.climb = clamp(dir.y, -1, 1);
        return d;
    }
}

/** Give `toy` a mind, if it's a pet. */
export function mindFor(world, toy) {
    return toy.def.kind === "pet" ? new PetMind(world, toy) : null;
}
