// How a pet's skeleton moves (the models: tools/pets/build_pets.py, loaded
// by pets3d.js). No clips: every bone is posed here each frame from what
// the pet is doing (models/toys/pets.js writes `rig.in`), so a walk keeps
// pace with the ground at any speed, a sit folds the same legs the walk
// swings, and a tail or an ear keeps going through all of it.
//
// The models' bones all rest unrotated, in the model's own axes (+Y up, +Z
// forward, +X the pet's left), so a bone is posed by plain turns about those
// axes; legs are solved to where their feet should be (two bones and a paw).
//
// Three kinds (the model's meta.rig): "quad" (cat, dog, rabbit, frog, and
// the mounts), "bird" (parrot, owl), "fish" (Gerald).
//
// No imports: THREE is handed in, as for the toy models.

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const rand = (a, b) => a + Math.random() * (b - a);
/** A bump that rises and falls once over 0-1. */
const bump = (u) => Math.sin(Math.PI * clamp(u, 0, 1));

// How long each one-off move lasts (s).
const SHOT_S = {
    voice: 0.55, hop: 0.5, nom: 1.3, groom: 2.6, paw: 0.7, shake: 0.8, wiggle: 0.7, nuzzle: 1.6, chomp: 0.7,
    flap: 0.9, preen: 2.0, nod: 0.6, spin: 0.9, stretch: 1.8,
};

class Rig {
    constructor(THREE, root, meta = {}, style = {}) {
        this.THREE = THREE;
        this.root = root;
        this.meta = meta;
        this.style = style;
        this.bones = {};
        root.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
        // Rest places: each bone's own (from its parent) and in the model.
        this.rest = {};
        this.restM = {};
        const walk = (b, base) => {
            this.rest[b.name] = b.position.clone();
            this.restM[b.name] = base.clone().add(b.position);
            for (const c of b.children) if (c.isBone) walk(c, this.restM[b.name]);
        };
        for (const b of Object.values(this.bones)) if (!b.parent?.isBone) walk(b, new THREE.Vector3());
        // What the pet is doing, written by its mind each frame.
        this.in = { speed: 0, turn: 0, climb: 0, pose: "stand", look: null, happy: 0, asleep: false, fold: 1 };
        this.t = rand(0, 10);
        this.phase = Math.random();
        this.shots = [];
        this.lookYaw = 0;
        this.lookPitch = 0;
        this._blink = { next: rand(1, 4), t: -1 };
        this._e = new THREE.Euler();
        this._q = new THREE.Quaternion();
        this._v = new THREE.Vector3();
        this.surge = 1;
        if (meta.mouth && this.bones.head) this._mouth = new THREE.Vector3(...meta.mouth).sub(this.restM.head);
    }

    /** A one-off move over whatever else is going on. */
    fire(name, dur) {
        this.shots = this.shots.filter((s) => s.name !== name);
        this.shots.push({ name, t: 0, dur: dur || SHOT_S[name] || 0.6 });
    }

    /** How far through one-off `name` it is (0-1), or -1. */
    shot(name) {
        const s = this.shots.find((x) => x.name === name);
        return s ? s.t / s.dur : -1;
    }

    busy() { return this.shots.length > 0; }

    /** Its mouth, in the world. */
    mouth(out = new this.THREE.Vector3()) {
        const h = this.bones.head;
        if (!h || !this._mouth) return this.root.getWorldPosition(out);
        return h.localToWorld(out.copy(this._mouth));
    }

    /** A mount's saddle (the model's `seat`), in the world as it's posed
     *  now: it rides the back, so it rises and falls with the walk. */
    seat(out = new this.THREE.Vector3()) {
        const b = this.bones[this.meta.seatBone || "spine"];
        if (!b || !this.meta.seat) return this.root.getWorldPosition(out);
        this._seat ||= new this.THREE.Vector3(...this.meta.seat).sub(this.restM[b.name]);
        b.updateWorldMatrix(true, false);
        return b.localToWorld(out.copy(this._seat));
    }

    /** Bone `name`'s place in the world. */
    point(name, out = new this.THREE.Vector3()) {
        const b = this.bones[name];
        return b ? b.getWorldPosition(out) : this.root.getWorldPosition(out);
    }

    _turn(name, x = 0, y = 0, z = 0) {
        const b = this.bones[name];
        if (b) b.quaternion.setFromEuler(this._e.set(x, y, z, "YXZ"));
        return b;
    }

    _tick(dt) {
        this.t += dt;
        for (const s of this.shots) s.t += dt;
        this.shots = this.shots.filter((s) => s.t < s.dur);
        // Looking: eased toward where the mind points it (angles from
        // straight ahead, in the model's frame).
        const look = this.in.look;
        this.lookYaw = damp(this.lookYaw, look ? look.yaw : 0, 5, dt);
        this.lookPitch = damp(this.lookPitch, look ? look.pitch : 0, 5, dt);
        // Blinking.
        const b = this._blink;
        if (b.t < 0) {
            if ((b.next -= dt) <= 0) b.t = 0;
        } else if ((b.t += dt / 0.16) >= 1) {
            b.t = -1;
            b.next = rand(1.5, 5);
        }
    }

    /** The eyes' lids: `shut` 0-1 over the blinking. */
    _eyes(shut = 0) {
        const b = this._blink;
        const k = Math.max(shut, this.in.asleep ? 1 : 0, b.t >= 0 ? bump(b.t) : 0);
        for (const side of ["L", "R"]) {
            const e = this.bones[`eye_${side}`];
            if (e) e.scale.y = 1 - 0.9 * k;
        }
    }
}

// ── four legs ────────────────────────────────────────────────────────────

// Where the legs are in each stance, as offsets the rig eases between:
// `drop`: how far the hips come down, as a share of their height above
// where the rump would rest; `pitch`: the trunk's tilt (rad, + nose down);
// `front` / `hind`: the feet forward of where they stand, as a share of that
// leg's length; `rel`: 0 when the feet are on the floor, 1 when they hang
// from the body (held, in the air); `tuck`: how far hanging legs draw up.
const QUAD_POSES = {
    stand: { drop: 0, pitch: 0, front: 0, hind: 0, rel: 0, tuck: 0, head: 0 },
    sit: { drop: 1, pitch: -0.52, front: 0.1, hind: 0.75, rel: 0, tuck: 0, head: 0 },
    lie: { drop: 1, pitch: 0.02, front: 0.95, hind: 0.7, rel: 0, tuck: 0, head: 0.05 },
    sleep: { drop: 1, pitch: 0.02, front: 0.7, hind: 0.7, rel: 0, tuck: 0, head: 0.4 },
    held: { drop: 0, pitch: -0.15, front: 0.25, hind: 0.35, rel: 1, tuck: 0.35, head: 0.1 },
    dangle: { drop: 0, pitch: -0.5, front: 0.1, hind: 0.2, rel: 1, tuck: 0.08, head: -0.3 },
};

const FLAT_POSES = {
    sit: { drop: 0.6, pitch: 0, front: 0, hind: 0, rel: 0, tuck: 0, head: 0 },
    lie: { drop: 1, pitch: 0, front: 0.1, hind: -0.1, rel: 0, tuck: 0, head: 0 },
    sleep: { drop: 1, pitch: 0, front: 0.1, hind: -0.1, rel: 0, tuck: 0, head: 0 },
};

// The order the feet go down in. A walk: each foot a quarter of the stride
// after the last, hind before front on a side (the lateral sequence nearly
// every four-legged animal walks in); a trot: the diagonals together.
const WALK_PHASE = { hl_L: 0, fl_L: 0.25, hl_R: 0.5, fl_R: 0.75 };
const TROT_PHASE = { hl_L: 0, fl_R: 0, hl_R: 0.5, fl_L: 0.5 };

class QuadRig extends Rig {
    constructor(THREE, root, meta, style) {
        super(THREE, root, meta, style);
        const s = this.style = {
            gait: meta.gait || "walk", tail: "sway", ears: "prick", duty: 0.62, lift: 0.28, stride: 1.0, hop: 0.26, hopHigh: 0.5,
            trot: 0.9, ...style,
        };
        this.legs = ["fl_L", "fl_R", "hl_L", "hl_R"].map((id) => {
            const [kind, side] = id.split("_");
            const up = `${kind}_upper_${side}`, lo = `${kind}_lower_${side}`, paw = `${kind}_paw_${side}`;
            if (!this.bones[up]) return null;
            const hip = this.restM[up], knee = this.restM[lo], foot = this.restM[paw];
            const d = foot.clone().sub(hip);
            const dn = d.clone().normalize();
            const k = knee.clone().sub(hip);
            let pole = k.clone().addScaledVector(dn, -k.dot(dn));
            if (pole.length() < 1e-4) pole.set(0, 0, kind === "fl" ? -1 : 1);
            pole.normalize();
            return {
                id, kind, side, up, lo, paw, pole,
                l1: knee.distanceTo(hip), l2: foot.distanceTo(knee), len: d.length(),
                upDir: k.clone().normalize(), loDir: foot.clone().sub(knee).normalize(),
                foot: foot.clone(), off: foot.clone().sub(hip),
            };
        }).filter(Boolean);
        // The tail's bones, and how far the hips can come down.
        this.tail = [1, 2, 3, 4, 5, 6].map((i) => `tail${i}`).filter((n) => this.bones[n]);
        this.trunk = [1, 2, 3, 4, 5, 6].map((i) => `trunk${i}`).filter((n) => this.bones[n]);
        this.hipH = this.restM.hips.y;
        this.dropMax = Math.max(0, this.hipH - (meta.rump ?? this.hipH * 0.45));
        this.P = { ...QUAD_POSES.stand };
        this.move = 0;
        this.trot = 0;
        this.M = {};     // each bone's place and turn in the model, as posed this frame
        this.ear = { L: { t: -1, next: rand(1, 5) }, R: { t: -1, next: rand(2, 7) } };
        this.air = 0;
        void s;
    }

    _fk(name, parent) {
        const { THREE } = this;
        const b = this.bones[name];
        const m = (this.M[name] ||= { p: new THREE.Vector3(), q: new THREE.Quaternion() });
        if (!parent) {
            m.p.copy(b.position);
            m.q.copy(b.quaternion);
        } else {
            const pm = this.M[parent];
            m.p.copy(this.rest[name]).applyQuaternion(pm.q).add(pm.p);
            m.q.copy(pm.q).multiply(b.quaternion);
        }
        return m;
    }

    /** One leg's bones turned so its foot is at `target` (in the model). */
    _leg(leg, target, parent, rel) {
        const { THREE } = this;
        const pm = this.M[parent];
        const hip = (leg._hip ||= new THREE.Vector3()).copy(this.rest[leg.up]).applyQuaternion(pm.q).add(pm.p);
        const d = (leg._d ||= new THREE.Vector3()).subVectors(target, hip);
        const reach = (leg.l1 + leg.l2) * 0.998, least = Math.abs(leg.l1 - leg.l2) * 1.05 + 1e-4;
        const dist = clamp(d.length(), least, reach);
        d.normalize();
        // The knee: off the line to the foot, toward the pole (which turns
        // with the body).
        const cosA = clamp((leg.l1 * leg.l1 + dist * dist - leg.l2 * leg.l2) / (2 * leg.l1 * dist), -1, 1);
        const pole = (leg._pole ||= new THREE.Vector3()).copy(leg.pole).applyQuaternion(pm.q);
        pole.addScaledVector(d, -pole.dot(d));
        if (pole.lengthSq() < 1e-8) pole.set(0, 0, leg.kind === "fl" ? -1 : 1);
        pole.normalize();
        const knee = (leg._knee ||= new THREE.Vector3()).copy(hip)
            .addScaledVector(d, leg.l1 * cosA).addScaledVector(pole, leg.l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
        const foot = (leg._foot ||= new THREE.Vector3()).copy(hip).addScaledVector(d, dist);
        const qUp = (leg._qUp ||= new THREE.Quaternion()).setFromUnitVectors(leg.upDir, this._v.subVectors(knee, hip).normalize());
        const qLo = (leg._qLo ||= new THREE.Quaternion()).setFromUnitVectors(leg.loDir, this._v.subVectors(foot, knee).normalize());
        const inv = this._q;
        this.bones[leg.up].quaternion.copy(inv.copy(pm.q).invert()).multiply(qUp);
        this.bones[leg.lo].quaternion.copy(inv.copy(qUp).invert()).multiply(qLo);
        // The paw level with the floor; hanging, it follows the shin.
        const paw = this.bones[leg.paw].quaternion.copy(inv.copy(qLo).invert());
        if (rel > 0) paw.slerp(inv.identity(), rel * 0.7);
    }

    update(dt) {
        const { THREE } = this;
        const inp = this.in, st = this.style, t = this.t;
        this._tick(dt);
        // (A crab doesn't sit up: resting, it just settles onto its shell.)
        const goal = (st.flat && FLAT_POSES[inp.pose]) || QUAD_POSES[inp.pose] || QUAD_POSES.stand;
        const P = this.P;
        for (const k in goal) P[k] = damp(P[k], goal[k], 7, dt);
        const upright = 1 - clamp(P.drop + P.rel, 0, 1);
        const speed = Math.max(0, inp.speed || 0);
        this.move = damp(this.move, speed > 0.015 ? 1 : 0, 10, dt);
        const hopper = st.gait === "hop";
        const size = this.legs[2]?.len || 0.1;

        // The stride: how far a foot goes back while it's down, and how
        // long a round of all four takes. Quicker steps as it speeds up
        // (stride frequency rises with speed in every gait), longer too.
        let hopY = 0, hopPitch = 0, flight = 0, u = 0;
        this.surge = 1;
        if (hopper) {
            const hopLen = st.hop;
            if (speed > 0.015 || (this.phase > 0.02 && this.phase < 0.98)) {
                // (A hop begun is finished, even if it stops meanwhile.)
                this.phase += (Math.max(speed, hopLen * 1.2) * dt) / hopLen;
                if (this.phase >= 1) this.phase = speed > 0.015 ? this.phase - 1 : 0;
            } else this.phase = 0;
            // Gathered for the first third, then off the floor.
            const LOAD = 0.3;
            if (this.phase > LOAD) {
                u = (this.phase - LOAD) / (1 - LOAD);
                flight = 1;
                // (`hopUp`: how high, in metres; else by its legs' length.)
                hopY = (st.hopUp ?? st.hopHigh * size) * Math.sin(Math.PI * u);
                hopPitch = lerp(-0.3, 0.28, u);
                this.surge = 1 / (1 - LOAD);
            } else {
                hopPitch = 0.1 * bump(this.phase / LOAD);
                this.surge = 0;
            }
        } else {
            const stride = st.stride * size * (0.9 + 0.5 * clamp(speed / (st.trot || 1), 0, 1.5));
            this.trot = damp(this.trot, speed > st.trot ? 1 : 0, 6, dt);
            if (speed > 0.015) this.phase = (this.phase + (speed * dt * st.duty) / stride) % 1;
            this._stride = stride;
        }
        this.air = damp(this.air, flight, 14, dt);

        // One-offs.
        const voice = this.shot("voice"), hop = this.shot("hop"), nom = this.shot("nom"), groom = this.shot("groom");
        const paw = this.shot("paw"), shake = this.shot("shake"), wiggle = this.shot("wiggle"), nuzzle = this.shot("nuzzle");
        const stretch = this.shot("stretch");
        const joy = hop >= 0 ? bump(hop) : 0;

        // The hips: down for a sit, bobbing with the steps, up in a hop.
        const hips = this.bones.hips;
        const bob = hopper ? 0 : -0.035 * size * this.move * upright * (0.5 - 0.5 * Math.cos(this.phase * TAU * 2));
        const breath = Math.sin(t * (inp.asleep ? 1.6 : 2.6));
        const stretchK = stretch >= 0 ? bump(stretch) : 0;
        hips.position.copy(this.rest.hips);
        hips.position.y += -P.drop * this.dropMax + bob + hopY * upright + joy * (st.hopUp ?? size * 0.9) + 0.012 * size * breath * P.drop + stretchK * size * 0.25;
        const sway = hopper ? 0 : Math.sin(this.phase * TAU) * 0.07 * this.move * upright;
        const bend = clamp((inp.turn || 0) * 0.12, -0.35, 0.35);
        const wig = wiggle >= 0 ? Math.sin(wiggle * 40) * 0.16 * bump(wiggle) : 0;
        const shk = shake >= 0 ? Math.sin(shake * 55) * 0.3 * bump(shake) : 0;
        this._turn("hips", P.pitch + hopPitch * upright - joy * 0.25 + (wiggle >= 0 ? 0.22 * bump(wiggle) : 0) - stretchK * 0.45,
            -sway - bend * 0.3 + wig, shk * 0.5);
        this._fk("hips", null);
        // (Curled up: head and tail round to the same side.)
        const curl = inp.pose === "sleep" && st.curl ? -P.drop : 0;
        this._turn("spine", stretchK * 0.3, sway * 0.6 + bend * 0.5 + curl * 0.35, shk);
        this._fk("spine", "hips");
        const cs = 1 + 0.02 * breath;
        this.bones.chest.scale.set(cs, cs, 1);
        this._turn("chest", stretchK * 0.5, sway * 0.8 + bend * 0.5 + curl * 0.35, -shk * 0.6);
        this._fk("chest", "spine");

        // The feet. On the floor: under their own hip where it is now, plus
        // the stance's reach and the stride. Hanging: from the hip.
        const target = (this._t ||= new THREE.Vector3());
        const mouthM = groom >= 0 || paw >= 0 ? this._modelMouth() : null;
        for (const leg of this.legs) {
            const parent = leg.kind === "fl" ? "chest" : "hips";
            const pm = this.M[parent];
            const hip = this._v.copy(this.rest[leg.up]).applyQuaternion(pm.q).add(pm.p);
            const reach = (leg.kind === "fl" ? P.front : P.hind) * leg.len;
            let fz = 0, fy = 0;
            const rel = clamp(P.rel + this.air * upright, 0, 1);
            if (hopper && this.move > 0.01) {
                // Hind legs drive back off the floor, then swing through
                // under the body; the front ones reach for the landing.
                if (leg.kind === "hl") fz = flight ? lerp(-0.9, 0.5, smooth(u)) * leg.len : lerp(0.2, -0.3, this.phase / 0.3) * leg.len;
                else fz = flight ? lerp(-0.2, 0.7, smooth(u)) * leg.len : 0;
            } else if (!hopper) {
                const walk = WALK_PHASE[leg.id], trot = TROT_PHASE[leg.id];
                const ph = (this.phase + lerp(walk, trot, this.trot) + 1) % 1;
                const duty = lerp(st.duty, 0.5, this.trot);
                const S = (this._stride || 0) * this.move * upright;
                if (ph < duty) fz = S * (0.5 - ph / duty);
                else {
                    const w = (ph - duty) / (1 - duty);
                    fz = S * (-0.5 + smooth(w));
                    fy = st.lift * leg.len * Math.sin(Math.PI * w) * this.move * upright;
                }
            }
            // On the floor: where the foot rests, moved with the hip.
            const fx = leg.foot.x + (hip.x - this.restM[leg.up].x) * 0.5;
            target.set(fx, leg.foot.y + fy, hip.z + leg.off.z + reach + fz);
            if (rel > 0) {
                // Hanging from the hip: a share of the leg's length below
                // it, drawn up by `tuck`.
                const hang = this._q2 ||= new THREE.Vector3();
                const down = leg.len * (1 - lerp(P.tuck, 0.3, this.air * upright));
                hang.set(leg.off.x, -down, leg.off.z + reach + fz).applyQuaternion(pm.q).add(hip);
                if (inp.pose === "dangle") hang.z += Math.sin(t * 7 + (leg.side === "L" ? 0 : 2) + (leg.kind === "fl" ? 0 : 1)) * leg.len * 0.12;
                target.lerp(hang, rel);
            }
            // A paw up to the mouth to wash, or out to bat at something.
            if (leg.id === "fl_L" && groom >= 0 && mouthM) {
                const k = smooth(Math.min(groom * 6, (1 - groom) * 6, 1));
                target.lerp(this._v.copy(mouthM).add(this._q3 ||= new THREE.Vector3(0.012, -0.012 + 0.012 * Math.sin(groom * 38), -0.01)), k * 0.92);
            }
            if (leg.id === "fl_R" && paw >= 0) {
                const k = bump(paw);
                target.y += leg.len * 0.75 * k;
                target.z += leg.len * 0.6 * k;
            }
            this._leg(leg, target, parent, rel);
        }

        // Neck and head: level whatever the trunk does, then where it's
        // looking, then the one-offs.
        const level = -(P.pitch + hopPitch * upright * 0.6);
        const sing = voice >= 0 ? bump(voice) : 0;
        const eat = nom >= 0 ? smooth(Math.min(nom * 5, (1 - nom) * 5, 1)) : 0;
        const wash = groom >= 0 ? smooth(Math.min(groom * 6, (1 - groom) * 6, 1)) : 0;
        const nuz = nuzzle >= 0 ? bump(nuzzle) : 0;
        const nodX = P.head + eat * (0.55 + 0.1 * Math.sin(nom * 40)) + wash * (0.3 + 0.08 * Math.sin(groom * 38)) - sing * 0.4
            - this.move * upright * 0.04 * Math.cos(this.phase * TAU * 2);
        const yaw = this.lookYaw * (st.lookK ?? 1) * (1 - eat) * (1 - wash) + curl * 0.25;
        this._turn("neck", level * 0.5 + nodX * 0.5 - this.lookPitch * 0.4, yaw * 0.45, nuz * 0.25 * Math.sin(nuzzle * 12));
        this._turn("head", level * 0.5 + nodX * 0.5 - this.lookPitch * 0.6, yaw * 0.55, shk * 0.8 + nuz * 0.35 * Math.sin(nuzzle * 12) + (inp.tilt || 0));
        this._eyes(Math.max(sing * 0.8, nuz, wash * 0.9, inp.happy > 0.8 ? 0.35 : 0));

        this._ears(dt);
        this._tail(dt);
        // An elephant's trunk: swaying as it walks, curling slowly at rest,
        // thrown up to trumpet.
        for (let i = 0; i < this.trunk.length; i++) {
            const k = (i + 1) / this.trunk.length;
            const curl = 0.1 * Math.sin(t * 0.8 - i * 0.7) + 0.16 * inp.happy * Math.sin(t * 1.5 - i * 0.5) - sing * 0.75 - eat * 0.3;
            this._turn(this.trunk[i], curl * (0.5 + k), (0.07 * Math.sin(t * 0.6 - i * 0.6) + 0.1 * this.move * Math.sin(this.phase * TAU - i * 0.5)) * k, 0);
        }
        // A frog's throat swells as it calls; a dog's tongue lolls and pants.
        const throat = this.bones.throat;
        if (throat) throat.scale.setScalar(1 + 0.05 * Math.sin(t * 9) + 0.75 * sing);
        const tongue = this.bones.tongue;
        if (tongue) {
            const pant = inp.pant ? 1 : 0.25;
            tongue.quaternion.setFromEuler(this._e.set(0.18 * Math.sin(t * 13) * pant, 0, 0));
            tongue.scale.set(1, 1, 0.85 + 0.2 * pant + 0.08 * Math.sin(t * 13) * pant);
        }
    }

    _modelMouth() {
        const head = this.bones.head;
        if (!head || !this._mouth) return null;
        const out = (this._mm ||= new this.THREE.Vector3());
        head.updateWorldMatrix(true, false);
        this.root.updateWorldMatrix(true, false);
        return this.root.worldToLocal(head.localToWorld(out.copy(this._mouth)));
    }

    _ears(dt) {
        const st = this.style, inp = this.in;
        for (const side of ["L", "R"]) {
            const name = `ear_${side}`;
            if (!this.bones[name]) continue;
            const s = side === "L" ? 1 : -1;
            const e = this.ear[side];
            if (e.t < 0) {
                if ((e.next -= dt) <= 0) e.t = 0;
            } else if ((e.t += dt / 0.22) >= 1) {
                e.t = -1;
                e.next = rand(2, 8);
            }
            const flick = e.t >= 0 ? bump(e.t) : 0;
            if (st.ears === "claw") {
                // A crab's claws (its "ears"; they reach out along -X):
                // held a little up, snapping now and then; both thrown
                // up and clacked when it calls.
                const voice = this.shot("voice"), hop = this.shot("hop");
                const up = Math.max(voice >= 0 ? bump(voice) : 0, hop >= 0 ? bump(hop) : 0);
                const snap = voice >= 0 ? Math.sin(voice * 26) * 0.35 * bump(voice) : flick * 0.45;
                this._turn(name, 0, s * (0.12 * Math.sin(this.t * 1.3 + s) + snap), -(0.15 + 0.08 * Math.sin(this.t * 1.7 + s * 2) + 0.75 * up));
            } else if (st.ears === "lop") {
                // A lop's ears lift out as it hops and swing as it turns.
                e.fly = damp(e.fly || 0, this.air * 0.9 + (this.shot("hop") >= 0 ? 0.7 : 0), 9, dt);
                this._turn(name, 0.12 * Math.sin(this.t * 2 + s), 0, s * (e.fly + flick * 0.15));
            } else if (st.ears === "flap") {
                // An elephant's: fanned slowly, wider when it's pleased.
                this._turn(name, 0, s * (0.25 + 0.3 * inp.happy) * (0.5 + 0.5 * Math.sin(this.t * 1.7 + s)) - s * flick * 0.3, 0);
            } else {
                // Pricked ears: a flick now and then; back when asleep.
                const back = inp.asleep ? 0.35 : 0;
                this._turn(name, -back - flick * 0.1, s * flick * 0.5, s * (flick * 0.25 - back * 0.4));
            }
        }
    }

    _tail(dt) {
        const st = this.style, inp = this.in, t = this.t, n = this.tail.length;
        if (!n) return;
        const down = clamp(this.P.drop, 0, 1);
        this._wag = damp(this._wag || 0, inp.happy, 4, dt);
        for (let i = 0; i < n; i++) {
            const k = (i + 1) / n;
            let x = 0, y = 0;
            if (st.tail === "wag") {
                // A dog's: side to side, faster and wider the happier.
                y = (0.1 + 0.5 * this._wag) * Math.sin(t * (7 + 9 * this._wag) - i * 0.7) * (0.5 + 0.5 * k);
                x = -0.25 * (1 - this._wag) * (i === 0 ? 1 : 0.3) - down * 0.3 * (i === 0 ? 1 : 0);
            } else if (st.tail === "swish") {
                // A horse's or a bull's: hanging, a swish now and then.
                const sw = Math.max(0, Math.sin(t * 0.9 + 1)) ** 6;
                y = (0.08 * Math.sin(t * 1.3 - i * 0.5) + 0.7 * sw * Math.sin(t * 9 - i * 0.6)) * k;
                x = 0.05 * Math.sin(t * 1.1 - i * 0.4);
            } else if (st.tail === "trunk") {
                // An elephant's trunk: curling and uncurling slowly.
                x = (0.12 * Math.sin(t * 0.8 - i * 0.6) + 0.35 * inp.happy * Math.sin(t * 1.4)) * k;
                y = 0.1 * Math.sin(t * 0.6 - i * 0.5) * k;
            } else {
                // A cat's: a slow curve travelling up it, its tip flicking;
                // down and round the body when it's lying.
                y = (0.16 + 0.12 * this._wag) * Math.sin(t * 1.5 - i * 0.9) * (0.4 + 0.6 * k) + down * 0.75;
                x = -down * (i === 0 ? 1.15 : 0.12) + 0.05 * Math.sin(t * 1.1 - i * 0.6) + (i === n - 1 ? 0.25 * Math.max(0, Math.sin(t * 2.3)) ** 4 : 0);
            }
            this._turn(this.tail[i], x, y, 0);
        }
    }
}

// ── birds ────────────────────────────────────────────────────────────────

// A wing at rest lies down the flank (its shoulder turned by FOLD), the
// outer half folded back over the inner (WRIST), its tip swept toward the
// tail (SWEEP); all by eye.
const FOLD = 1.42, WRIST = 2.75, SWEEP = 0.5;

class BirdRig extends Rig {
    constructor(THREE, root, meta, style) {
        super(THREE, root, meta, { flapHz: 7, flapUp: 0.85, ...style });
        this.F = 0;       // 0 on its feet, 1 flying
        this.open = 0;    // the wings: 0 folded, 1 out
        this.tiltT = rand(2, 6);
        this.tilt = 0;
    }

    update(dt) {
        const inp = this.in, st = this.style, t = this.t;
        this._tick(dt);
        const flying = inp.pose === "fly";
        this.F = damp(this.F, flying ? 1 : 0, 6, dt);
        const voice = this.shot("voice"), flap = this.shot("flap"), preen = this.shot("preen"), nom = this.shot("nom"), nod = this.shot("nod");
        const hop = this.shot("hop");
        const sing = voice >= 0 ? bump(voice) : 0;
        const ruffle = flap >= 0 ? bump(flap) : 0;
        const peck = nom >= 0 ? smooth(Math.min(nom * 5, (1 - nom) * 5, 1)) : 0;
        const held = inp.pose === "held" ? 1 : 0;
        this.open = damp(this.open, Math.max(this.F, ruffle * 0.75, sing * 0.15, inp.pose === "dangle" ? 0.6 : 0), 12, dt);
        const speed = Math.max(0, inp.speed || 0);
        const walking = !flying && speed > 0.01 ? 1 : 0;
        this.phase = (this.phase + dt * (flying ? st.flapHz : walking ? 3.2 : 0)) % 1;
        const beat = Math.sin(this.phase * TAU);

        // The body: upright on its feet, leant into its flight; a bob as
        // it hops along the floor, a squat and spring for joy.
        const body = this.bones.body;
        const joy = hop >= 0 ? bump(hop) : 0;
        body.position.copy(this.rest.body);
        body.position.y += walking * 0.012 * Math.abs(beat) - this.F * 0.012 * beat + joy * 0.07 + 0.002 * Math.sin(t * 2.4);
        const asleep = inp.asleep ? 1 : 0;
        this._turn("body", this.F * 0.95 + peck * (0.75 + 0.12 * Math.sin(nom * 36)) + (inp.climb ? -clamp(inp.climb, -1, 1) * 0.35 * this.F : 0) + asleep * 0.08,
            walking * 0.12 * beat, clamp((inp.turn || 0) * -0.25, -0.6, 0.6) * this.F + walking * 0.08 * beat);
        // Fluffed up a little when asleep, breathing.
        const puff = 1 + asleep * 0.06 + 0.012 * Math.sin(t * (asleep ? 1.5 : 2.6));
        body.scale.set(puff, 1, puff);

        // The wings.
        const fold = 1 - this.open;
        const flapping = this.F > 0.05 ? beat : ruffle > 0 ? Math.sin(flap * 38) : 0;
        const lag = this.F > 0.05 ? Math.sin(this.phase * TAU - 0.9) : flapping;
        for (const side of ["L", "R"]) {
            const s = side === "L" ? 1 : -1;
            const w = this.bones[`wing_${side}`], w2 = this.bones[`wing2_${side}`];
            if (!w) continue;
            const up = st.flapUp * flapping * this.open;
            // Folded down the flank and swept back; open, beating.
            this._q.setFromEuler(this._e.set(SWEEP * fold, 0, 0));
            w.quaternion.setFromEuler(this._e.set(0, 0, s * (-FOLD * fold + up + 0.12 * this.F))).premultiply(this._q);
            if (w2) w2.quaternion.setFromEuler(this._e.set(0, s * WRIST * fold, s * 0.45 * lag * this.open));
        }

        // Legs: tucked back in flight, stepping on the floor.
        for (const side of ["L", "R"]) {
            const s = side === "L" ? 1 : -1;
            this._turn(`leg_${side}`, this.F * 1.1 + walking * 0.45 * beat * s - peck * 0.5 + held * 0.6, 0, 0);
            this._turn(`foot_${side}`, -this.F * 0.5 - walking * 0.3 * beat * s + this.F * 0.9, 0, 0);
        }
        this._turn("tail1", -this.F * 0.5 + 0.05 * Math.sin(t * 1.8) + sing * 0.25 - peck * 0.5, 0.06 * Math.sin(t * 1.1), 0);
        this._turn("tail2", -this.F * 0.2 + ruffle * 0.2, 0, 0);

        // The head: kept up whatever the body does, turned to what it's
        // looking at, tilted to one side now and then; tucked to preen.
        if ((this.tiltT -= dt) <= 0) {
            this.tiltT = rand(1.5, 6);
            this._tiltTo = Math.random() < 0.5 ? 0 : rand(-0.45, 0.45) * (st.tilt || 1);
        }
        this.tilt = damp(this.tilt, this._tiltTo || 0, 8, dt);
        const pr = preen >= 0 ? smooth(Math.min(preen * 5, (1 - preen) * 5, 1)) : 0;
        const nodK = nod >= 0 ? Math.sin(nod * TAU * 2) * 0.3 * bump(nod) : 0;
        const level = -(this.F * 0.95 + peck * 0.4);
        const yaw = clamp(this.lookYaw, -(st.headTurn || 1.6), st.headTurn || 1.6) * (1 - pr) + pr * 2.3;
        this._turn("neck", level * 0.5 - this.lookPitch * 0.4 - sing * 0.25 + pr * 0.35 + nodK + asleep * 0.25 + walking * 0.06 * Math.cos(this.phase * TAU * 2),
            yaw * 0.5, 0);
        this._turn("head", level * 0.5 - this.lookPitch * 0.6 - sing * 0.3 + pr * (0.5 + 0.1 * Math.sin(preen * 40)) + asleep * 0.3,
            yaw * 0.5, this.tilt * (1 - pr) * (1 - asleep));
        this._eyes(Math.max(sing * 0.5, pr * 0.8));
    }
}

// ── Gerald ───────────────────────────────────────────────────────────────

class FishRig extends Rig {
    update(dt) {
        const inp = this.in, t = this.t;
        this._tick(dt);
        const speed = Math.max(0, inp.speed || 0);
        const go = clamp(speed / 0.9, 0, 1.4);
        // The tail beats faster and wider the faster he swims.
        this.phase = (this.phase + dt * (0.9 + 2.4 * go)) % 1;
        const a = 0.10 + 0.22 * go;
        const w = (lag) => Math.sin(this.phase * TAU - lag);
        const chomp = this.shot("chomp"), spin = this.shot("spin"), voice = this.shot("voice"), nuzzle = this.shot("nuzzle");
        const held = inp.pose === "held" || inp.pose === "dangle" ? 1 : 0;
        const wig = held ? Math.sin(t * 9) * 0.25 : 0;
        const bank = clamp((inp.turn || 0) * -0.3, -0.6, 0.6);
        const body = this.bones.body;
        body.position.copy(this.rest.body);
        this._turn("body", -clamp(inp.climb || 0, -1, 1) * 0.5 + (nuzzle >= 0 ? 0.2 * bump(nuzzle) : 0),
            a * 0.35 * w(0) + wig * 0.4 + (spin >= 0 ? smooth(spin) * TAU : 0), bank);
        this._turn("head", -this.lookPitch * 0.5, -a * 0.45 * w(0) + this.lookYaw * 0.6, nuzzle >= 0 ? 0.3 * Math.sin(nuzzle * 14) * bump(nuzzle) : 0);
        this._turn("tail1", 0, a * 0.8 * w(0.9) + wig, 0);
        this._turn("tail2", 0, a * 1.1 * w(1.8) + wig, 0);
        this._turn("tail3", 0, a * 1.3 * w(2.7) + wig, 0);
        for (const side of ["L", "R"]) {
            const s = side === "L" ? 1 : -1;
            this._turn(`fin_${side}`, 0.15 * Math.sin(t * 2.2 + s), s * 0.1 * w(0.5), s * (0.1 + 0.18 * Math.sin(t * 1.7 + (s > 0 ? 0 : 1.3))) - bank * 0.6);
        }
        // His jaw: nearly shut in a grin; a chomp opens wide and snaps,
        // twice.
        let jaw = -0.16 + 0.03 * Math.sin(t * 1.3);
        if (chomp >= 0) jaw = 0.42 * Math.abs(Math.sin(chomp * TAU)) ** 0.6 - 0.2;
        else if (voice >= 0) jaw = 0.3 * bump(voice) - 0.16;
        this._turn("jaw", jaw, 0, 0);
        this._eyes(nuzzle >= 0 ? bump(nuzzle) : 0);
    }
}

/** The rig for a pet's model: `root` its scene, `meta` the model's own
 *  notes (its GLB's extras), `style` how this animal carries itself. */
export function createPetRig(THREE, root, meta = {}, style = {}) {
    if (meta.rig === "bird") return new BirdRig(THREE, root, meta, style);
    if (meta.rig === "fish") return new FishRig(THREE, root, meta, style);
    return new QuadRig(THREE, root, meta, style);
}
