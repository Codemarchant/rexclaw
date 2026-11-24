// The toy box's mounts (the room view only): an animal the companion rides.
// Picked, it comes over to them and they're up on its back, sat astride
// (the riding clips, tools/motion/roam_motions); from then on wherever they
// walk (move_around, the move keys) it's the animal that walks, at its own
// pace, and they stay in the saddle until it's put away. A click on it is
// answered with its voice.
//
// A mount's mind stands in for a pet's (world.js looks at toy.pet): it
// moves its toy and says how it's carrying itself in toy.anim for the rig
// (pet_rig.js). The avatar renderer does the rest: while `renderer.riding`
// is set its walks play no walk clip and go at the animal's pace.

import { v3 } from "./physics";
import { toySfx } from "./sfx";

const TOY = (n) => `/assets/vrma/toys/${n}.vrma`;
const RIDE = TOY("ride"), RIDE_WIDE = TOY("ride_wide"), RIDE_IN = TOY("ride_in"), RIDE_WIDE_IN = TOY("ride_wide_in");
// The riding clips sit them with the underside of the pelvis 0.11 m below
// the hips bone on a 1.56 m body (measured on the clips): that far, by
// their height, is where the saddle is.
const SEAT_UNDER = 0.11 / 1.56;
// Up into the saddle, and down again (s); `ride_in` is 0.6 s.
const UP_S = 0.6;
const DOWN_S = 0.35;
// Free, it comes to them at this pace (a share of its ridden walk) and is
// there within this (m); it turns this fast (rad/s). By eye.
const COME = 0.9;
const THERE = 0.12;
const TURN = 2.6;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class MountMind {
    constructor(stage, toy) {
        this.stage = stage;
        this.t = toy;
        this.d = toy.def.mount;
        this.move = "walk";
        this.perch = null;
        this.kinematic = false;
        this.riding = false;
        this.want = true;          // to be ridden once it's with them
        this.up = 0;               // 0 on the floor … 1 in the saddle
        this.yaw = stage.r._moveYaw || 0;
        this.clock = 0;
        this.anim = toy.anim = { speed: 0, turn: 0, climb: 0, pose: "stand", look: null, happy: 0, asleep: false, pant: false, tilt: 0 };
        toy.cues = [];
        toy.pet = this;
    }

    get r() { return this.stage.r; }

    cue(name, dur) { this.t.cues.push({ name, dur }); }

    speak() {
        if (this.d.voice) toySfx.sample(this.d.voice, { vol: 0.8 });
        this.cue("voice", 0.9);
    }

    /** A click: its voice, and nothing else (they stay up: putting it away
     *  gets them down; down, a click doesn't put them up). */
    poke() {
        this.speak();
        this.anim.happy = 1;
    }

    // ── each frame ───────────────────────────────────────────────────────

    tick(dt) {
        const t = this.t, st = this.stage, a = this.anim;
        this.clock += dt;
        a.happy = Math.max(0, a.happy - dt / 4);
        if (t.heldBy === "user") {
            // Picked up and carried somewhere (only with nobody on it: the
            // room's pointer leaves a ridden one alone, scene_stage.js).
            this.want = true;
            this.kinematic = false;
            a.pose = "dangle";
            a.speed = 0;
            return;
        }
        if (!this.kinematic) {
            a.pose = "stand";
            a.speed = 0;
            if (!t.resting) return;
            this.kinematic = true;
        }
        t.v = v3();
        t.resting = true;
        t.p.y = st.ground + t.radius;
        if (this.riding) { this._carry(dt); return; }
        const b = st.body();
        if (this.want && b && t.view?.rig && !st.r.toyPaused && this.up === 0) {
            // Over to them, and round to face the way they do.
            if (this._come(b, dt)) this.mount();
            return;
        }
        a.speed = damp(a.speed, 0, 8, dt);
        a.turn = 0;
        if (b) {
            const yaw = wrap(Math.atan2(b.pos.x - t.p.x, b.pos.z - t.p.z) - this.yaw);
            a.look = { yaw: clamp(yaw, -1.2, 1.2), pitch: 0 };
        }
    }

    /** A step toward standing under the companion; true once there. */
    _come(b, dt) {
        const t = this.t, a = this.anim;
        const seat = this._seatAhead();
        const face = Math.atan2(b.facing.x, b.facing.z);
        // Where its middle goes for its saddle to be under them.
        const to = { x: b.pos.x - Math.sin(face) * seat - t.p.x, z: b.pos.z - Math.cos(face) * seat - t.p.z };
        const d = Math.hypot(to.x, to.z);
        const want = d < THERE ? face : Math.atan2(to.x, to.z);
        const diff = wrap(want - this.yaw);
        const step = clamp(diff, -TURN * dt, TURN * dt);
        this.yaw = wrap(this.yaw + step);
        a.turn = step / Math.max(dt, 1e-4);
        a.look = null;
        if (d < THERE) {
            a.speed = Math.abs(a.turn) * 0.3;
            return Math.abs(diff) < 0.08;
        }
        const speed = this.d.speed * COME * clamp(1 - Math.abs(diff) / 1.4, 0.2, 1) * clamp(d / 0.4, 0.3, 1);
        t.p.x += Math.sin(this.yaw) * speed * dt;
        t.p.z += Math.cos(this.yaw) * speed * dt;
        a.speed = speed;
        return false;
    }

    /** How far ahead of its middle the saddle is (m). */
    _seatAhead() {
        const rig = this.t.view?.rig;
        return (rig?.meta.seat?.[2] || 0) * (rig?.scale || 1);
    }

    /** Under them wherever they go, stepping at the pace they move. */
    _carry(dt) {
        const t = this.t, a = this.anim, r = this.r;
        const vrm = r.vrm;
        // The body wanted elsewhere (VR, a photoshoot): down without a word,
        // and back up when it's over.
        if (!vrm || r.toyPaused) { this.dismount({ quiet: true, now: true }); return; }
        // A new body (an outfit change): sat back down.
        if (vrm !== this._vrm) this._sit();
        const p = vrm.scene.position, yaw = r._moveYaw || 0;
        const last = this._last || { x: p.x, z: p.z, yaw };
        const lin = Math.hypot(p.x - last.x, p.z - last.z) / Math.max(dt, 1e-4);
        const rate = wrap(yaw - last.yaw) / Math.max(dt, 1e-4);
        this._last = { x: p.x, z: p.z, yaw };
        this.yaw = yaw;
        const seat = this._seatAhead();
        t.p.x = p.x - Math.sin(yaw) * seat;
        t.p.z = p.z - Math.cos(yaw) * seat;
        // Turning on the spot it still has to step round.
        a.speed = damp(a.speed, lin + Math.abs(rate) * 0.25, 10, dt);
        a.turn = rate;
        a.look = null;
        a.pose = "stand";
        this.up = Math.min(1, this.up + dt / UP_S);
    }

    // ── up and down ──────────────────────────────────────────────────────

    /** The companion up onto its back. */
    mount() {
        const st = this.stage, r = this.r;
        if (this.riding || !r.vrm || r.toyPaused) return;
        // Whatever they're in the middle of with another toy winds up
        // first (asked to here, tried again next frame): its ending frees
        // the body and stops its clip, which coming after this would undo
        // the seat.
        const mid = st.companion.running;
        st.companion.stop();
        if (mid) return;
        // One animal at a time: off the other (which stays down).
        for (const o of st.toys) if (o !== this.t && o.pet?.riding) o.pet.dismount({ again: false });
        this.riding = true;
        this.want = false;
        this.up = 0;
        this._last = null;
        st.riding = this;
        r.stopMoving?.();
        // How much taller a subject they are up there than on their feet,
        // and how far its head is ahead of them: the shot and their walks
        // keep that much more room (avatar_renderer `riding`).
        const meta = this.t.view?.rig?.meta || {}, k = this.t.view?.rig?.scale || 1;
        const high = st.bodyApi.height;
        const frame = Math.max(1, ((meta.seat?.[1] || 1.2) * k + high * 0.62) / high);
        const ahead = Math.max(0, ((meta.mouth?.[2] || 1) - (meta.seat?.[2] || 0)) * k);
        r.riding = { note: this.t.def.note, rate: this.d.rate || 1, frame, ahead };
        this._sit();
        this.speak();
        st.frameRider?.(this.t, frame);
        // (Back up after VR or a photoshoot took them off: no news.)
        if (!this.resuming) st.box?.note?.(`The user just put you up on ${this.t.def.note}: you're riding it now, sat on its back. Wherever you move, it carries you.`, { respond: true });
        this.resuming = false;
    }

    /** The riding pose on the body they have now. */
    _sit() {
        const r = this.r;
        this._vrm = r.vrm;
        r.toyBusy = `riding ${this.t.def.note}`;
        // (A broad back has its own seat, and its own way up into it.)
        const wide = !!this.t.view?.rig?.meta.wide;
        const loop = wide ? RIDE_WIDE : RIDE;
        const mine = r.riding;
        // The way up, then the seat (whatever they were doing gives way).
        Promise.resolve(r.playGesture?.(wide ? RIDE_WIDE_IN : RIDE_IN, { toy: true })).then(() => new Promise((res) => setTimeout(res, UP_S * 1000 - 80)))
            .then(() => { if (r.riding === mine && this.riding) r.playGesture?.(loop, { loop: true, toy: true }); })
            .catch(() => {});
    }

    /** Down off it, to stand beside it. `quiet`: nothing said to the call;
     *  `now`: on the floor at once (the animal is going away this frame, or
     *  the body is wanted elsewhere); `again`: back up as soon as they can
     *  be (not when it was for another animal that they got down). */
    dismount({ quiet = false, now = false, again = true } = {}) {
        if (!this.riding) return;
        const st = this.stage, r = this.r;
        this.riding = false;
        this.want = again;
        this.resuming = again && quiet;
        if (st.riding === this) st.riding = null;
        r.riding = null;
        r.toyBusy = null;
        r.stopMoving?.();
        r.stopGesture?.({ toy: true });
        const vrm = r.vrm;
        if (vrm) {
            // Down on its left, clear of its flank.
            const half = (this.t.view?.rig?.meta.halfWidth || 0.3) + 0.3;
            const yaw = this.yaw;
            vrm.scene.position.x += Math.cos(yaw) * half;
            vrm.scene.position.z += -Math.sin(yaw) * half;
            if (now) vrm.scene.position.y = 0;
            else this._down = { vrm, from: vrm.scene.position.y, t: 0 };
        }
        this.up = 0;
        this.anim.speed = 0;
        st.unframeRider?.();
        r.toyFaceCamera?.();
        if (!quiet) st.box?.note?.(`You've got down off ${this.t.def.note} and are standing beside it.`);
    }

    /** After the animal is posed, before the draw: the rider's height, so
     *  their seat is on the saddle (which rises and falls with its walk). */
    seat(dt) {
        const d = this._down;
        if (d) {
            d.t = Math.min(1, d.t + dt / DOWN_S);
            if (d.vrm.scene) d.vrm.scene.position.y = d.from * (1 - d.t) * (1 - d.t);
            if (d.t >= 1) this._down = null;
        }
        const r = this.r, rig = this.t.view?.rig, vrm = r.vrm;
        if (!this.riding || !rig || !vrm) return;
        const hips = vrm.humanoid?.getRawBoneNode?.("hips");
        if (!hips) return;
        const { THREE } = this.stage;
        const seat = rig.seat(this._seatV ||= new THREE.Vector3());
        hips.updateWorldMatrix(true, false);
        const hipsUp = hips.getWorldPosition(this._hipsV ||= new THREE.Vector3()).y - vrm.scene.position.y;
        const lift = seat.y - hipsUp + SEAT_UNDER * this.stage.bodyApi.height;
        // Eased up into the saddle, then held to it.
        const k = this.up * this.up * (3 - 2 * this.up);
        vrm.scene.position.y = lift * k + Math.sin(Math.PI * this.up) * 0.12 * (this.up < 1 ? 1 : 0);
    }
}
