/**
 * Idle pose — fitting the procedural idle to one model's own body.
 *
 * idle_motion.js decides WHAT the body does (a weight shift, an arm's
 * re-hang, a hand to the hip) as plain signals; avatar_renderer.js writes
 * the simple joints from them. What lives here is the part that has to know
 * the model: the foot IK that keeps the feet planted while the pelvis
 * shifts, the arm hung against gravity at an angle that clears this model's
 * own hips and clothes, the one-off scan of its body those are measured
 * from, and the arm IK that puts a hand on its hip.
 *
 * One instance per renderer (scratch vectors are reused frame to frame);
 * the per-model measurements are cached on the actor — `_armHang`,
 * `_bodyScan`, `_hipSpots` — and cleared by the renderer when the model
 * changes. Normalized VRM bones throughout: they rest at identity, so a
 * bone's rest axes are its root's.
 */

// The hang itself is set against GRAVITY, not the torso (hangArm): the
// upper arm points down, out to the side by the least angle that clears
// this model's own hips and clothes (_armHangAngle), and a little behind
// vertical. Measured on the authored reference idles, relative to world
// down: the upper arm 9–10° out in two of them and 13–14° in the third,
// and 3–8° behind vertical (13° in the third); over a whole 40 s loop it
// moves 1–2.5°. The old body-relative pose (IDLE_SHOULDER_DOWN above,
// still used to detect the rig's arm sign) hung it about 24° out and 9°
// forward, which is what read as arms held away from the body.
const IDLE_ARM_ABD_MIN = 0.165;          // rad (9.5°), the references' common hang
const IDLE_ARM_ABD_MAX = 0.38;           // rad (22°): past this, a wide skirt wins
const IDLE_ARM_ABD_STEP = 0.0175;        // rad (1°) per candidate
const IDLE_ARM_CLEAR = 0.01;             // m between arm and body, at a 25 cm forearm
const IDLE_ARM_BACK = 0.1;               // rad (5.7°) behind vertical
const IDLE_BODY_SCAN_VERTS = 60000;      // vertices read for that, and face samples, at most (sparser past it)
const IDLE_BODY_SCAN_STEP = 0.015;       // m: triangles wider than this are sampled across their face
const IDLE_BODY_SCAN_SPLIT = 40;         // samples along a triangle's edge, at most
// Cloth driven by spring bones (a skirt that sways) is not cleared: it moves,
// and clearing its widest flare would hold every skirted model's arms out.
// Where it clips, the look's arm spread is the fix (pose_tuning, see
// poseTuning) — the per-model offset every avatar app ends up with. Adding
// arm colliders to the model's cloth at runtime was tried and taken out: no
// app does it (a model's spring colliders are its author's), three-vrm only
// collides a joint's tip so the cloth between joints slipped through anyway,
// and it changed nothing where the author had already set arm collisions.

// Hand on the hip (handOnHip, _hipContact). No study or app gives this
// pose's numbers — the apps that have one use an authored, per-model
// offset — so these are authored; the contact itself is measured per model.
const IDLE_HIP_FINGERS_FWD = [1.0, 2.0, 4.0];   // fingers forward per unit down: 45°, 27°, 14° below level
const IDLE_HIP_ELBOW_OUT = 1.0;          // elbow direction: out to the side…
const IDLE_HIP_ELBOW_BACK = 0.2;         // …and back by this much, at most
const IDLE_HIP_ELBOW_CLEAR = 0.03;       // m the elbow stays in front of the torso's back
const IDLE_HIP_GAP = 0.004;              // m between palm and body, at a 25 cm forearm
// Two-handed postures (hands clasped in front, behind the back) were tried
// and taken out: two hands meeting in front of or behind the body have to
// clear every outfit's coats, skirts and sleeves at once, and clipped on
// too many. The hand on the hip only touches the side.

// Weight shift (the engine's `stance`; see plantFeet). In relaxed standing
// on one leg the unloaded knee flexes 22.3° [18.6, 25.9] more than in a
// symmetric stance, and the loaded knee does not lock (+0.95°, n.s.) —
// Leeuwis et al. 2026, J Appl Physiol 141:994. The pelvis's sideways travel
// has no figure in that literature (it reports the centre of pressure), so
// it is measured off the authored reference idles: a settled stance puts
// the pelvis 0.30 of the way from the midline to the loaded foot (2.0 of
// 6.65 cm in one, a 0.33 spread of the same ratio in another).
const IDLE_STANCE_SHIFT = 0.3;           // of the half stance width
const IDLE_STANCE_FREE_KNEE = 0.39;      // rad (22.3°) past rest, at full stance
const IDLE_STANCE_ROLL_MAX = 0.2;        // sin of the steepest pelvis tilt allowed (~11.5°)
const IDLE_STANCE_RISE_MAX = 0.003;      // m the pelvis may rise to keep that leg on its foot

export class IdlePose {
    constructor(THREE) {
        this.libs = { THREE };
    }

    /** Weight shift with the feet planted: a two-bone IK per leg.
     *
     *  The idle used to hold the pelvis still because, with no IK, anything
     *  it did slid the feet across the floor. This solves the legs instead,
     *  which is how the authored idles do it — their pelvis wanders by
     *  centimetres while the feet do not move by a millimetre.
     *
     *  The legs arrive here in the NEUTRAL stance (pelvis at rest, rest
     *  angles), so the ankles' positions and the feet's orientations now
     *  are the planted ones. The pelvis then takes the frame's weight
     *  shift — it moves toward the loaded foot and drops on the free side
     *  (the hip of the unloaded leg sags; the chest counter-rolls so the
     *  shoulders stay level) — and each leg is solved back onto its spot:
     *  the knee by the law of cosines, the thigh by swinging the ankle
     *  onto the target, the foot by restoring its planted orientation. The
     *  free knee's extra bend is not authored: it is what the geometry
     *  gives once that hip has dropped.
     *
     *  A shuffle moves the free foot's spot (`footL`/`footR`: outward and
     *  forward in metres, `lift` the heel's rise, pivoting on the toes). */
    plantFeet(actor, get, sig, fz) {
        const { THREE } = this.libs;
        const hips = get("hips");
        const parent = hips?.parent;
        if (!parent) return;
        const legs = [];
        for (const side of ["left", "right"]) {
            const up = get(`${side}UpperLeg`);
            const lo = get(`${side}LowerLeg`);
            const ft = get(`${side}Foot`);
            if (!up || !lo || !ft) return;
            legs.push({ up, lo, ft, toes: get(`${side}Toes`), foot: side === "left" ? sig.footL : sig.footR });
        }
        const s = (this._ikScratch ||= {
            t: [new THREE.Vector3(), new THREE.Vector3()],
            q: [new THREE.Quaternion(), new THREE.Quaternion()],
            u: new THREE.Vector3(), k: new THREE.Vector3(), f: new THREE.Vector3(),
            v1: new THREE.Vector3(), v2: new THREE.Vector3(), tg: new THREE.Vector3(),
            qa: new THREE.Quaternion(), qb: new THREE.Quaternion(), qc: new THREE.Quaternion(),
            sc: new THREE.Vector3(), x: new THREE.Vector3(1, 0, 0),
        });

        // Neutral pass: the planted ankles, in the pelvis's PARENT space so
        // the shift and the shuffle offsets are plain local metres.
        parent.getWorldScale(s.sc);
        const scale = s.sc.y || 1;
        for (let i = 0; i < 2; i++) {
            const L = legs[i];
            L.ft.updateWorldMatrix(true, false);
            parent.worldToLocal(L.ft.getWorldPosition(s.t[i]));
            L.ft.getWorldQuaternion(s.q[i]);
            L.toeLen = L.toes ? L.toes.position.length() : 0;
        }
        const [tl, tr] = s.t;
        const halfW = Math.abs(tl.x - tr.x) / 2;
        if (halfW < 1e-4) return;

        // Leg lengths, off the neutral pose, and the hip-to-ankle reach a
        // given knee bend leaves (law of cosines).
        legs[0].up.getWorldPosition(s.u);
        legs[0].lo.getWorldPosition(s.k);
        legs[0].ft.getWorldPosition(s.f);
        const la = s.u.distanceTo(s.k);
        const lb = s.k.distanceTo(s.f);
        const reach = (bend) => Math.sqrt(la * la + lb * lb + 2 * la * lb * Math.cos(bend));
        const rest = Math.abs(sig.kneeL);
        // A foot's planted spot in world space, moved by a shuffle: outward
        // is away from the other foot, forward is the rig's facing.
        const spot = (i, lift, out) => {
            const foot = legs[i].foot;
            const side = Math.sign(s.t[i].x - s.t[1 - i].x) || 1;
            return parent.localToWorld(out.set(
                s.t[i].x + side * foot.out,
                s.t[i].y + lift,
                s.t[i].z + fz * foot.fwd,
            ));
        };
        const hipsAt = (L, out) => {
            hips.updateWorldMatrix(true, false);
            L.up.updateWorldMatrix(false, false);
            return L.up.getWorldPosition(out);
        };

        // The pelvis: toward the loaded foot, free hip dropped. `stance` > 0
        // loads the left leg. Rotating about z by `roll` raises the side of
        // the pelvis at +x for roll > 0, so the free side drops with the sign
        // of the direction toward the loaded foot.
        const a = Math.min(1, Math.abs(sig.stance));
        const support = sig.stance > 0 ? legs[0] : legs[1];
        if (a > 1e-4) {
            const free = sig.stance > 0 ? legs[1] : legs[0];
            const dir = Math.sign((sig.stance > 0 ? tl.x : tr.x) - (sig.stance > 0 ? tr.x : tl.x)) || 1;
            hips.position.x += dir * a * IDLE_STANCE_SHIFT * halfW;
            // How far down the free hip goes is set by the free knee: drop
            // it until that knee has bent IDLE_STANCE_FREE_KNEE past rest.
            // Half the drop is the roll itself and half the pelvis settling
            // to keep the loaded leg at its own length (below), so the roll
            // is taken over the full width between the hip joints.
            const span = hipsAt(free, s.u).distanceTo(hipsAt(support, s.k));
            const ankle = spot(sig.stance > 0 ? 1 : 0, 0, s.tg);
            const drop = s.u.distanceTo(ankle) - reach(rest + IDLE_STANCE_FREE_KNEE * a);
            const roll = dir * Math.asin(Math.max(0, Math.min(IDLE_STANCE_ROLL_MAX, drop / Math.max(span, 1e-4))));
            hips.rotation.z += roll;
            // The chest keeps the shoulders level over the tilted pelvis.
            const spine = get("spine");
            if (spine) spine.rotation.z -= roll;
        }

        // Height: the loaded leg keeps its rest bend — a weight-bearing knee
        // does not lock — and the pelvis settles to whatever height that
        // leaves.
        const have = hipsAt(support, s.u).distanceTo(spot(sig.stance > 0 ? 0 : 1, 0, s.v1));
        hips.position.y += Math.min(IDLE_STANCE_RISE_MAX, (reach(rest) - have) / scale);
        hips.updateWorldMatrix(true, false);

        for (let i = 0; i < 2; i++) {
            const L = legs[i];
            const foot = L.foot;
            const target = spot(i, foot.lift, s.tg);
            this._solveLeg(L, target, s, fz);
            // The foot keeps its planted orientation; a heel lift pitches
            // it toe-down by the angle that keeps the toes on the floor.
            const pitch = L.toeLen > 1e-4 ? Math.asin(Math.min(0.9, foot.lift / L.toeLen)) : 0;
            L.lo.updateWorldMatrix(true, false);
            L.lo.getWorldQuaternion(s.qa).invert();
            s.qb.setFromAxisAngle(s.x, fz * pitch);
            L.ft.quaternion.copy(s.qa.multiply(s.qc.copy(s.q[i]).multiply(s.qb)));
        }
    }

    /** Two-bone IK: bend the knee until hip-to-ankle is the target's
     *  distance, then swing the thigh so the ankle lands on it. The knee
     *  turns on its own hinge (lower leg x), so the leg keeps its plane;
     *  two passes absorb a rest pose that is not perfectly straight. */
    _solveLeg(L, target, s, fz) {
        for (let pass = 0; pass < 2; pass++) {
            L.ft.updateWorldMatrix(true, false);
            L.up.getWorldPosition(s.u);
            L.lo.getWorldPosition(s.k);
            L.ft.getWorldPosition(s.f);
            const a = s.u.distanceTo(s.k);
            const b = s.k.distanceTo(s.f);
            const c = Math.max(Math.abs(a - b) + 1e-4, Math.min(a + b - 1e-4, s.u.distanceTo(target)));
            const have = s.v1.subVectors(s.u, s.k).angleTo(s.v2.subVectors(s.f, s.k));
            const want = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b))));
            // A smaller inner angle is a deeper bend, toward the back of the
            // leg: +x on a +Z-facing rig, −x on a −Z one. The inner angle
            // alone cannot tell the two apart — a knee bent backwards by the
            // same amount has the same angle — so the facing decides.
            L.lo.rotation.x += fz * (have - want);
        }
        L.ft.updateWorldMatrix(true, false);
        L.up.getWorldPosition(s.u);
        L.ft.getWorldPosition(s.f);
        s.v1.subVectors(s.f, s.u).normalize();
        s.v2.subVectors(target, s.u).normalize();
        s.qb.setFromUnitVectors(s.v1, s.v2);
        L.up.getWorldQuaternion(s.qc);
        L.up.parent.getWorldQuaternion(s.qa).invert();
        L.up.quaternion.copy(s.qa.multiply(s.qb).multiply(s.qc));
    }

    /** World orientation for a normalized bone that carries its rest axes
     *  (`restAlong` down the bone, `restAcross` across it) onto `along` and
     *  `across` (world, unit). Normalized bones rest at identity, so their
     *  rest axes are the root's: `qr` is the root's world rotation. */
    _mapRest(restAlong, restAcross, along, across, qr, out) {
        const { THREE } = this.libs;
        const s = (this._mapScratch ||= {
            a0: new THREE.Vector3(), h0: new THREE.Vector3(), c0: new THREE.Vector3(),
            h1: new THREE.Vector3(), c1: new THREE.Vector3(),
            m0: new THREE.Matrix4(), m1: new THREE.Matrix4(),
        });
        s.a0.copy(restAlong).normalize().applyQuaternion(qr);
        s.h0.copy(restAcross).applyQuaternion(qr);
        s.h0.addScaledVector(s.a0, -s.h0.dot(s.a0)).normalize();
        s.c0.crossVectors(s.a0, s.h0);
        s.h1.copy(across).addScaledVector(along, -across.dot(along)).normalize();
        s.c1.crossVectors(along, s.h1);
        s.m0.makeBasis(s.a0, s.h0, s.c0);
        s.m1.makeBasis(along, s.h1, s.c1);
        s.m1.multiply(s.m0.transpose());
        return out.setFromRotationMatrix(s.m1).multiply(qr);
    }

    /** Hang one upper arm off gravity rather than off the torso: down, out
     *  to the side by the model's own clearance angle (_armHangAngle) and
     *  a little behind vertical (IDLE_ARM_BACK, plus the engine's settle
     *  `pitch`), with the elbow's hinge across the arm's fore-aft plane so
     *  the forearm still bends forward and the palm faces the thigh. Set
     *  in world space, the arm stays plumb while the torso above it sways
     *  and the pelvis shifts, the way a hanging arm does. */
    hangArm(actor, get, side, pitch, fz, spreadDeg = 0) {
        const { THREE } = this.libs;
        const up = get(`${side}UpperArm`);
        const lo = get(`${side}LowerArm`);
        const root = get("hips")?.parent;
        if (!up || !lo || !root || !up.parent) return;
        // The measured hang, plus the look's own spread (pose_tuning) — what
        // the measurement cannot see, such as a skirt that slips between its
        // physics joints, is the user's to set per look.
        const abd = Math.max(0, this._armHangAngle(actor, get, side, fz)
            + spreadDeg * Math.PI / 180);
        const s = (this._hangScratch ||= {
            qr: new THREE.Quaternion(), qp: new THREE.Quaternion(), q: new THREE.Quaternion(),
            out: new THREE.Vector3(), fwd: new THREE.Vector3(), down: new THREE.Vector3(0, -1, 0),
            d: new THREE.Vector3(), h: new THREE.Vector3(), fwd0: new THREE.Vector3(),
            hinge0: new THREE.Vector3(),
        });
        root.getWorldQuaternion(s.qr);
        // Outward is the way the arm points at rest (away from the body);
        // forward the rig's facing — both flattened onto the floor.
        s.out.set(Math.sign(lo.position.x) || 1, 0, 0).applyQuaternion(s.qr);
        s.out.y = 0;
        s.out.normalize();
        s.fwd.set(0, 0, fz).applyQuaternion(s.qr);
        s.fwd.y = 0;
        s.fwd.normalize();
        const back = IDLE_ARM_BACK - pitch;
        s.d.copy(s.down).multiplyScalar(Math.cos(abd)).addScaledVector(s.out, Math.sin(abd));
        s.d.multiplyScalar(Math.cos(back)).addScaledVector(s.fwd, -Math.sin(back)).normalize();
        s.h.crossVectors(s.d, s.fwd).normalize();
        s.fwd0.set(0, 0, fz);
        s.hinge0.crossVectors(lo.position, s.fwd0);
        this._mapRest(lo.position, s.hinge0, s.d, s.h, s.qr, s.q);
        up.parent.updateWorldMatrix(true, false);
        up.parent.getWorldQuaternion(s.qp).invert();
        up.quaternion.copy(s.qp.multiply(s.q));
    }

    /** How far out from vertical this model's arm must hang to clear its
     *  own body — hips, thighs, a skirt — measured once from the mesh in
     *  its bind pose: every vertex not carried by an arm or by the head
     *  and neck (hair falls in front of the arms and behind them) gives
     *  the body's half-width at its height, near the arm's depth. The arm
     *  is a line from the shoulder joint at the candidate angle, as thick
     *  as its own sleeve and hand vertices, tested from mid forearm down —
     *  the part beside the hips; the first angle from
     *  IDLE_ARM_ABD_MIN up that clears by IDLE_ARM_CLEAR wins, capped at
     *  IDLE_ARM_ABD_MAX. Cached per actor and side. */
    _armHangAngle(actor, get, side, fz) {
        const cache = (actor._armHang ||= {});
        if (side in cache) return cache[side];
        cache[side] = IDLE_ARM_ABD_MIN;
        try {
            cache[side] = this._measureArmHang(actor, get, side) ?? IDLE_ARM_ABD_MIN;
        } catch (e) { /* keep the default */ }
        console.log(`[voice] ${side} arm hangs ${(cache[side] * 180 / Math.PI).toFixed(1)}° out (clears the body)`);
        return cache[side];
    }

    _measureArmHang(actor, get, side) {
        const { THREE } = this.libs;
        const h = actor.vrm?.humanoid;
        const hips = get("hips");
        const root = hips?.parent;
        const up = get(`${side}UpperArm`);
        const lo = get(`${side}LowerArm`);
        const hand = get(`${side}Hand`);
        if (!h || !root || !up || !lo || !hand || !actor._hipsBasePos) return null;
        // Rest positions in the root's frame: normalized bones rest at
        // identity, so a joint is the sum of the offsets above it.
        const restPos = (node) => {
            const p = new THREE.Vector3();
            for (let n = node; n && n !== hips; n = n.parent) p.add(n.position);
            return p.add(actor._hipsBasePos);
        };
        const shoulder = restPos(up);
        const outSign = Math.sign(lo.position.x) || 1;
        const la = lo.position.length();
        const lb = hand.position.length();
        // Hand length to the fingertip, middle finger.
        let lc = 0;
        for (const seg of ["Proximal", "Intermediate", "Distal"]) {
            const b = get(`${side}Middle${seg}`);
            if (b) lc += b.position.length();
        }
        lc = lc ? lc * 1.25 : lb * 0.8;
        const scan = (actor._bodyScan ||= this._scanBody(actor, root));
        if (!scan?.body.length) return null;
        const { body } = scan;
        const elbowR = scan[side].fore;
        const handT = scan[side].hand;
        const pct = (a, q) => {
            if (!a.length) return 0;
            a.sort((x, y) => x - y);
            return a[Math.min(a.length - 1, Math.floor(a.length * q))];
        };
        // Median thickness: a sleeve's widest folds give way against the
        // body; its typical radius is what has to clear.
        const armR = pct(elbowR, 0.5) || la * 0.15;
        const handR = pct(handT, 0.5) || armR * 0.6;
        const sx = shoulder.x * outSign;
        // Half-width of the body around height y, within the arm's depth:
        // the widest vertex per height bin, read with its neighbours.
        const band = 0.015 * (la / 0.25);
        const depth = armR + 0.06 * (la / 0.25);
        const bins = new Map();
        for (let i = 0; i < body.length; i += 3) {
            if (Math.abs(body[i + 2] - shoulder.z) >= depth) continue;
            const k = Math.floor(body[i + 1] / band);
            const x = body[i] * outSign;
            if (!(bins.get(k) >= x)) bins.set(k, x);
        }
        const width = (y) => {
            const k = Math.floor(y / band);
            return Math.max(bins.get(k - 1) ?? -Infinity, bins.get(k) ?? -Infinity, bins.get(k + 1) ?? -Infinity);
        };
        // Sample down the arm (straight, the elbow bend is small) from the
        // lower forearm to the fingertip: the wrist and hand, beside the
        // hips, thighs and skirt, are what visibly clip. Above that, an arm
        // rests against the ribcage and waist — and the clothes there — in
        // a person too, so it is not tested.
        const total = la + lb + lc;
        const step = IDLE_ARM_ABD_STEP;
        for (let a = IDLE_ARM_ABD_MIN; a <= IDLE_ARM_ABD_MAX + 1e-6; a += step) {
            let ok = true;
            for (let r = la + lb * 0.6; r <= total && ok; r += total / 24) {
                const x = sx + r * Math.sin(a);
                const y = shoulder.y - r * Math.cos(a);
                const thick = r > la + lb ? handR : armR;
                if (x - thick < width(y) + IDLE_ARM_CLEAR * (la / 0.25)) ok = false;
            }
            if (ok) return a;
        }
        return IDLE_ARM_ABD_MAX;
    }

    /** One pass over a model's skinned vertices in the rig's rest pose, in
     *  the root's frame: `body` [x, y, z, …] for everything not carried by
     *  an arm, the head and neck (hair falls in front of the arms and
     *  behind them) or a spring joint (cloth, kept apart in `clothPts`),
     *  and per side the forearm's thickness samples (distance from its
     *  bone line) and the hand's (distance along the palm's normal).
     *
     *  Skinned through the raw bones — a mesh's bind pose need not match
     *  the normalized rest — but with them put at rest for the pass: the
     *  measurements are read against rest positions (restPos,
     *  `_hipsBasePos`), and whatever the last frame left (a clip's final
     *  bow or turn) would be cached as the body's shape. Big meshes are
     *  sampled. */
    _scanBody(actor, root) {
        const h = actor.vrm?.humanoid;
        if (!h || !actor.vrm?.scene) return null;
        const saved = Object.values(h.humanBones || {}).map((b) => b?.node).filter(Boolean)
            .map((n) => [n, n.position.clone(), n.quaternion.clone()]);
        h.resetRawPose?.();
        try {
            return this._scanRest(actor, root);
        } finally {
            for (const [n, p, q] of saved) {
                n.position.copy(p);
                n.quaternion.copy(q);
            }
            actor.vrm.scene.updateMatrixWorld(true);
        }
    }

    _scanRest(actor, root) {
        const { THREE } = this.libs;
        const h = actor.vrm.humanoid;
        // Bones whose vertices are not body: both arms, and everything
        // from the neck up (hair).
        const armRaw = new Set();
        const headRaw = new Set();
        const armNames = ["UpperArm", "LowerArm", "Hand", "ThumbMetacarpal", "ThumbProximal", "ThumbDistal",
            "IndexProximal", "IndexIntermediate", "IndexDistal", "MiddleProximal", "MiddleIntermediate",
            "MiddleDistal", "RingProximal", "RingIntermediate", "RingDistal", "LittleProximal",
            "LittleIntermediate", "LittleDistal"];
        for (const sd of ["left", "right"]) {
            for (const n of armNames) {
                const b = h.getRawBoneNode?.(`${sd}${n}`);
                if (b) armRaw.add(b);
            }
        }
        const neck = h.getRawBoneNode?.("neck") || h.getRawBoneNode?.("head");
        neck?.traverse((o) => headRaw.add(o));
        // Every arm bone's descendants count as arm too (twist and sleeve
        // helpers hang off them).
        for (const sd of ["left", "right"]) h.getRawBoneNode?.(`${sd}UpperArm`)?.traverse((o) => armRaw.add(o));
        // The flesh round the shoulder joint is the arm's, not the body's.
        for (const sd of ["left", "right"]) {
            const b = h.getRawBoneNode?.(`${sd}Shoulder`);
            if (b) armRaw.add(b);
        }
        actor.vrm.scene.updateMatrixWorld(true);
        const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
        const at = (name) => {
            const b = h.getRawBoneNode?.(name);
            return b ? b.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv) : null;
        };
        const out = { body: [], cloth: 0, clothPts: [] };
        // Cloth: anything carried by a spring joint, or by a bone under one.
        // It moves, so the arm's hang does not clear it (see
        // IDLE_BODY_SCAN_VERTS); a hand on the hip still rests on it.
        const spring = new Set();
        for (const j of actor.vrm.springBoneManager?.joints || []) spring.add(j.bone);
        const clothOf = new Map();
        const isCloth = (bone) => {
            let c = clothOf.get(bone);
            if (c === undefined) {
                c = false;
                for (let b = bone; b && !c; b = b.parent) c = spring.has(b);
                clothOf.set(bone, c);
            }
            return c;
        };
        const arms = new Map();     // raw bone → [side record, "fore" | "hand"]
        for (const sd of ["left", "right"]) {
            const e0 = at(`${sd}LowerArm`);
            const e1 = at(`${sd}Hand`);
            const p1 = at(`${sd}IndexProximal`);
            const p2 = at(`${sd}LittleProximal`);
            const rec = {
                fore: [], hand: [], e1,
                line: e0 && e1 ? new THREE.Line3(e0, e1) : null,
                palmN: e1 && p1 && p2
                    ? new THREE.Vector3().crossVectors(p1.clone().sub(e1), p2.clone().sub(e1)).normalize() : null,
            };
            out[sd] = rec;
            const lower = h.getRawBoneNode?.(`${sd}LowerArm`);
            const hand = h.getRawBoneNode?.(`${sd}Hand`);
            if (lower) arms.set(lower, [rec, "fore"]);
            if (hand) arms.set(hand, [rec, "hand"]);
        }
        // Each triangle of `mesh` with an edge longer than `step` (metres),
        // with that edge.
        const ta = new THREE.Vector3();
        const tb = new THREE.Vector3();
        const tc = new THREE.Vector3();
        const eachWide = (mesh, step, fn) => {
            const pos = mesh.geometry.attributes.position;
            const idx = mesh.geometry.index;
            const tris = (idx ? idx.count : pos.count) / 3;
            const scaleW = mesh.matrixWorld.getMaxScaleOnAxis();
            for (let t = 0; t < tris; t++) {
                const ia = idx ? idx.getX(3 * t) : 3 * t;
                const ib = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
                const ic = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
                ta.fromBufferAttribute(pos, ia);
                tb.fromBufferAttribute(pos, ib);
                tc.fromBufferAttribute(pos, ic);
                const edge = Math.max(ta.distanceTo(tb), tb.distanceTo(tc), tc.distanceTo(ta)) * scaleW;
                if (edge > step) fn(ia, ib, ic, edge);
            }
        };
        const samples = (edge, step) => {
            const n = Math.min(IDLE_BODY_SCAN_SPLIT, Math.ceil(edge / step));
            return (n + 1) * (n + 2) / 2;
        };
        let count = 0;
        let faces = 0;
        actor.vrm.scene.traverse((mesh) => {
            if (!mesh.isSkinnedMesh || !mesh.visible || !mesh.geometry?.attributes?.position) return;
            count += mesh.geometry.attributes.position.count;
            eachWide(mesh, IDLE_BODY_SCAN_STEP, (ia, ib, ic, edge) => { faces += samples(edge, IDLE_BODY_SCAN_STEP); });
        });
        const stride = Math.max(1, Math.ceil(count / IDLE_BODY_SCAN_VERTS));
        // The face samples are held to the same budget by spacing them
        // wider: a dense outfit of triangles just past IDLE_BODY_SCAN_STEP
        // would otherwise add hundreds of thousands, all inside one frame.
        // Its vertices are close enough without them.
        const faceStep = IDLE_BODY_SCAN_STEP * Math.sqrt(Math.max(1, faces / IDLE_BODY_SCAN_VERTS));
        const m = new THREE.Matrix4();
        const v = new THREE.Vector3();
        const tmp = new THREE.Vector3();
        actor.vrm.scene.traverse((mesh) => {
            if (!mesh.isSkinnedMesh || !mesh.visible) return;
            const g = mesh.geometry;
            const pos = g?.attributes?.position;
            const si = g?.attributes?.skinIndex;
            const sw = g?.attributes?.skinWeight;
            if (!pos || !si || !sw) return;
            m.multiplyMatrices(rootInv, mesh.matrixWorld);
            const bones = mesh.skeleton.bones;
            // The bone that carries most of vertex i.
            const boneOf = (i) => {
                let best = 0;
                let bone = null;
                for (let k = 0; k < 4; k++) {
                    const wt = sw.getComponent(i, k);
                    if (wt > best) { best = wt; bone = bones[si.getComponent(i, k)]; }
                }
                return bone;
            };
            // A low-poly body (a few thousand vertices: Rex, Sal) is big
            // triangles whose corners sit far above and below any one height
            // — one vertex within 3 cm of Sal's waist — so its vertices alone
            // say the belly is a fraction of its width, and the arm hangs
            // and the hand on the hip rests inside it. Every triangle wider
            // than IDLE_BODY_SCAN_STEP (faceStep, on a big model) is sampled
            // across its face too, the samples taking the class of its first
            // corner. A dense mesh has almost none that wide.
            const skinned = new Map();
            const at = (vi) => {
                let p = skinned.get(vi);
                if (!p) {
                    p = mesh.applyBoneTransform(vi, new THREE.Vector3().fromBufferAttribute(pos, vi)).applyMatrix4(m);
                    skinned.set(vi, p);
                }
                return p;
            };
            eachWide(mesh, faceStep, (ia, ib, ic, edge) => {
                const bone = boneOf(ia);
                if (!bone || headRaw.has(bone) || armRaw.has(bone)) return;
                const list = isCloth(bone) ? out.clothPts : out.body;
                const A = at(ia);
                const B = at(ib);
                const C = at(ic);
                const n = Math.min(IDLE_BODY_SCAN_SPLIT, Math.ceil(edge / faceStep));
                for (let i = 0; i <= n; i++) {
                    for (let j = 0; j <= n - i; j++) {
                        const u = i / n;
                        const w2 = j / n;
                        const z = 1 - u - w2;
                        list.push(A.x * z + B.x * u + C.x * w2, A.y * z + B.y * u + C.y * w2, A.z * z + B.z * u + C.z * w2);
                    }
                }
            });
            for (let i = 0; i < pos.count; i += stride) {
                const bone = boneOf(i);
                if (!bone || headRaw.has(bone)) continue;
                // Skinning only: the morphs are the face's.
                mesh.applyBoneTransform(i, v.fromBufferAttribute(pos, i)).applyMatrix4(m);
                if (armRaw.has(bone)) {
                    const hit = arms.get(bone);
                    if (!hit) continue;
                    const [rec, part] = hit;
                    if (part === "fore" && rec.line) {
                        rec.fore.push(v.distanceTo(rec.line.closestPointToPoint(v, true, tmp)));
                    } else if (part === "hand" && rec.palmN) {
                        rec.hand.push(Math.abs(tmp.subVectors(v, rec.e1).dot(rec.palmN)));
                    }
                    continue;
                }
                if (isCloth(bone)) {
                    out.cloth++;
                    out.clothPts.push(v.x, v.y, v.z);
                    continue;
                }
                out.body.push(v.x, v.y, v.z);
            }
        });
        return out;
    }

    /** A hand resting on the side of the hip, blended over the idle arm by
     *  `w` (0..1). False when this model can't take the pose on that side.
     *
     *  The contact is the model's own surface (_hipContact), kept in the
     *  pelvis's frame so the hand rides a weight shift with the hip. The
     *  palm sits on it with the fingers pointing forward and down
     *  (IDLE_HIP_FINGERS_*), and the elbow goes out to the side and a
     *  little back (IDLE_HIP_ELBOW_*).
     *
     *  The arm is solved as a hinge, not swung: the upper arm turns so the
     *  elbow lands where the law of cosines puts it, with the elbow's hinge
     *  across the plane of the arm, and the forearm then bends on that
     *  hinge only. Aiming a forearm at its target any other way twists the
     *  elbow. Each bone is placed by mapping its rest axes (along the bone,
     *  across the hinge) onto the solved ones — normalized bones rest at
     *  identity, so their rest axes are the root's. */
    handOnHip(actor, get, side, w, fz) {
        const { THREE } = this.libs;
        const up = get(`${side}UpperArm`);
        const lo = get(`${side}LowerArm`);
        const hand = get(`${side}Hand`);
        const hips = get("hips");
        if (!up || !lo || !hand || !hips?.parent) return false;
        const contact = this._hipContact(actor, get, side);
        if (!contact) {
            console.log(`[voice] ${side} hand on hip can't be worked out on this model (no body to measure)`);
            return false;
        }
        const s = (this._hipScratch ||= {
            p: new THREE.Vector3(), out: new THREE.Vector3(), fwd: new THREE.Vector3(),
            down: new THREE.Vector3(), a: new THREE.Vector3(), n: new THREE.Vector3(),
            sh: new THREE.Vector3(), el: new THREE.Vector3(), wr: new THREE.Vector3(),
            dir: new THREE.Vector3(), pole: new THREE.Vector3(), u: new THREE.Vector3(),
            g: new THREE.Vector3(), h: new THREE.Vector3(), v: new THREE.Vector3(),
            leg: new THREE.Vector3(), sc: new THREE.Vector3(),
            qr: new THREE.Quaternion(), qp: new THREE.Quaternion(), qd: new THREE.Quaternion(),
            qUp: new THREE.Quaternion(), qLo: new THREE.Quaternion(), qHand: new THREE.Quaternion(),
            q0: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
            fwd0: new THREE.Vector3(), hinge0: new THREE.Vector3(), palm0: new THREE.Vector3(0, -1, 0),
        });
        const root = hips.parent;
        root.getWorldQuaternion(s.qr);
        root.getWorldScale(s.sc);
        const scale = s.sc.y || 1;
        // The body's own directions, in world space.
        s.fwd.set(0, 0, fz).applyQuaternion(s.qr);
        s.down.set(0, -1, 0).applyQuaternion(s.qr);
        hips.updateWorldMatrix(true, false);
        const leg = get(`${side}UpperLeg`);
        leg?.updateWorldMatrix(false, false);
        s.out.copy(leg ? leg.getWorldPosition(s.leg) : s.leg.set(0, 0, 0))
            .sub(hips.getWorldPosition(s.v));
        s.out.addScaledVector(s.down, -s.out.dot(s.down)).normalize();
        // The palm on the contact, fingers forward-down, palm facing in.
        hips.localToWorld(s.p.copy(contact.p));
        s.a.copy(s.down).multiplyScalar(Math.cos(contact.phi)).addScaledVector(s.fwd, Math.sin(contact.phi)).normalize();
        s.n.copy(s.out).negate().addScaledVector(s.a, s.out.dot(s.a)).normalize();
        const mid = get(`${side}MiddleProximal`);
        const palm = (mid ? mid.position.length() : hand.position.length() * 0.35) * scale;
        // The contact is the palm's centre (thickness included); the wrist
        // is half a palm back from it.
        s.wr.copy(s.p).addScaledVector(s.a, -palm * 0.5);

        // Elbow: out to the side, a little back, where the two lengths allow
        // — but never behind the torso. On a deep body with narrow
        // shoulders a fixed backward lean takes the upper arm round the back
        // (Shinano's elbow sat 0.6 cm behind her back surface), so the lean
        // is walked forward until the elbow clears the back by
        // IDLE_HIP_ELBOW_CLEAR, the back measured per model (_hipContact).
        up.updateWorldMatrix(true, false);
        up.getWorldPosition(s.sh);
        const la = lo.position.length() * scale;
        const lb = hand.position.length() * scale;
        const d = Math.max(Math.abs(la - lb) + 1e-4, Math.min(la + lb - 1e-4, s.sh.distanceTo(s.wr)));
        s.dir.subVectors(s.wr, s.sh).normalize();
        const alpha = Math.acos(Math.max(-1, Math.min(1, (la * la + d * d - lb * lb) / (2 * la * d))));
        const limit = contact.back + IDLE_HIP_ELBOW_CLEAR * (lo.position.length() / 0.25);
        // Places the elbow for a lean and returns its depth in the pelvis's
        // frame, forward positive (it falls as the lean goes back).
        const elbowAt = (back) => {
            s.pole.copy(s.out).multiplyScalar(IDLE_HIP_ELBOW_OUT).addScaledVector(s.fwd, -back);
            s.pole.addScaledVector(s.dir, -s.pole.dot(s.dir)).normalize();
            s.el.copy(s.sh).addScaledVector(s.dir, la * Math.cos(alpha)).addScaledVector(s.pole, la * Math.sin(alpha));
            return hips.worldToLocal(s.v.copy(s.el)).z * fz;
        };
        // The most lean that keeps the elbow clear, found continuously
        // (bisection): stepping it in tenths made the elbow jump a step
        // whenever the body's sway carried it across one.
        if (elbowAt(IDLE_HIP_ELBOW_BACK) < limit) {
            let lo2 = -1;
            let hi2 = IDLE_HIP_ELBOW_BACK;
            for (let n = 0; n < 16; n++) {
                const mid2 = (lo2 + hi2) / 2;
                if (elbowAt(mid2) >= limit) lo2 = mid2;
                else hi2 = mid2;
            }
            elbowAt(lo2);
        }
        this._poseArm(get, side, w, s, fz);
        return true;
    }

    /** Pose one arm onto a solved shoulder–elbow–wrist (s.sh, s.el, s.wr,
     *  world) with the hand along `s.a` and its palm facing `s.n`, blended
     *  over the bones' current (idle) pose by `w`. `s` is the caller's
     *  scratch (see handOnHip), with s.qr the root's world rotation and
     *  s.fwd the body's forward. Kept apart from the hand-on-hip's target
     *  so another arm pose can reuse it. */
    _poseArm(get, side, w, s, fz) {
        const up = get(`${side}UpperArm`);
        const lo = get(`${side}LowerArm`);
        const hand = get(`${side}Hand`);
        const mid = get(`${side}MiddleProximal`);
        // Keep the idle pose to blend from.
        s.q0[0].copy(up.quaternion);
        s.q0[1].copy(lo.quaternion);
        s.q0[2].copy(hand.quaternion);
        s.u.subVectors(s.el, s.sh).normalize();
        s.g.subVectors(s.wr, s.el).normalize();
        s.h.crossVectors(s.u, s.g);
        if (s.h.lengthSq() < 1e-8) s.h.crossVectors(s.u, s.fwd);
        s.h.normalize();

        // Each bone's rest axes (along it, across its hinge) onto the
        // solved ones.
        s.fwd0.set(0, 0, fz);
        this._mapRest(lo.position, s.hinge0.crossVectors(lo.position, s.fwd0), s.u, s.h, s.qr, s.qUp);
        this._mapRest(hand.position, s.hinge0.crossVectors(hand.position, s.fwd0), s.g, s.h, s.qr, s.qLo);
        // The hand: along the fingers, and the palm's normal (rest: down).
        const handAlong = mid ? mid.position : hand.position;
        this._mapRest(handAlong, s.palm0, s.a, s.n, s.qr, s.qHand);

        // To locals, then blend from the idle pose.
        up.parent.getWorldQuaternion(s.qp).invert();
        up.quaternion.copy(s.q0[0]).slerp(s.qd.copy(s.qp).multiply(s.qUp), w);
        // The lower arm and hand sit on the BLENDED parents, so each local
        // is taken against the pose actually above it.
        up.updateWorldMatrix(false, false);
        up.getWorldQuaternion(s.qp).invert();
        const loIk = s.qd.copy(s.qp).multiply(s.qLo);
        lo.quaternion.copy(s.q0[1]).slerp(loIk, w);
        lo.updateWorldMatrix(false, false);
        lo.getWorldQuaternion(s.qp).invert();
        const handIk = s.qd.copy(s.qp).multiply(s.qHand);
        hand.quaternion.copy(s.q0[2]).slerp(handIk, w);
    }

    /** Where the palm of a hand on the hip sits, in the pelvis's frame,
     *  from the body scan (_scanBody: body and clothes, not the arms or
     *  hair). The hand lies flat against the side at the waist (the spine
     *  joint's height), fingers forward and down (IDLE_HIP_FINGERS_FWD) —
     *  and the waist is narrower than the hips just below it, so a hand
     *  placed on the waist alone drives its fingertips into the hips. So
     *  the heel of the palm, its middle, the knuckles and points down the
     *  fingers to the tip are each checked against the body's width at
     *  their own height and depth, and the hand stands out from the
     *  widest of them by its own half-thickness. That is the earlier
     *  raycast's failure, which touched one point and clipped the rest.
     *  Cached on the actor; null without a scan. */
    _hipContact(actor, get, side) {
        // Not `_hipContact`: the main actor is the renderer itself, and when
        // these methods lived on it a cache by the method's name hid it.
        const cache = (actor._hipSpots ||= {});
        if (side in cache) return cache[side];
        cache[side] = null;
        const { THREE } = this.libs;
        const hips = get("hips");
        const spine = get("spine");
        const lo = get(`${side}LowerArm`);
        const hand = get(`${side}Hand`);
        const root = hips?.parent;
        if (!hips || !spine || !lo || !hand || !root || !actor._hipsBasePos) return null;
        const scan = (actor._bodyScan ||= this._scanBody(actor, root));
        if (!scan?.body.length) return null;
        const fz = actor.vrm.meta?.metaVersion === "0" ? -1 : 1;
        const outSign = Math.sign(lo.position.x) || 1;
        // Whether the pose suits a model (a belt that drapes over the arm, an
        // outfit that holds the hand far out) is the look's own call — its
        // "Hand on hip" tickbox — not guessed here. Only a model this can't
        // be worked out for at all comes back null.
        const k = lo.position.length() / 0.25;           // the model's scale, by forearm
        // Body and clothes, as the widest point per (height, depth) cell.
        const cell = 0.015 * k;
        const bins = new Map();
        const put = (pts) => {
            for (let i = 0; i < pts.length; i += 3) {
                const key = `${Math.floor(pts[i + 1] / cell)},${Math.floor(pts[i + 2] / cell)}`;
                const x = pts[i] * outSign;
                if (!(bins.get(key) >= x)) bins.set(key, x);
            }
        };
        put(scan.body);
        put(scan.clothPts);
        const width = (y, z) => {
            const ky = Math.floor(y / cell);
            const kz = Math.floor(z / cell);
            let w = -Infinity;
            for (let a = -1; a <= 1; a++) {
                for (let b = -1; b <= 1; b++) w = Math.max(w, bins.get(`${ky + a},${kz + b}`) ?? -Infinity);
            }
            return w;
        };
        // The waist, at rest in the root's frame: normalized bones rest at
        // identity, so the spine joint sits at the hips plus its offset.
        const yc = actor._hipsBasePos.y + spine.position.y;
        const zc = actor._hipsBasePos.z + spine.position.z;
        // The hand's own sizes, and its lie: fingers forward and down.
        let fingers = 0;
        for (const seg of ["Proximal", "Intermediate", "Distal"]) {
            const b = get(`${side}Middle${seg}`);
            if (b) fingers += b.position.length();
        }
        const mid = get(`${side}MiddleProximal`);
        const palm = mid ? mid.position.length() : hand.position.length() * 0.35;
        fingers = fingers ? fingers * 1.15 : palm;
        const half = scan[side]?.hand?.length
            ? [...scan[side].hand].sort((a, b) => a - b)[Math.floor(scan[side].hand.length / 2)]
            : 0.012 * k;
        // Where the fingers point along the side, as an angle from straight
        // down toward forward: from forward-and-down to nearly level,
        // whichever lets the hand sit closest (a flared skirt below the
        // waist wants them level).
        let best = null;
        for (const phi of IDLE_HIP_FINGERS_FWD.map((f) => Math.atan(f))) {
            const a = new THREE.Vector3(0, -Math.cos(phi), Math.sin(phi) * fz);
            let need = -Infinity;
            for (let s = -0.5; s <= 0.5 + fingers / palm + 1e-6; s += 0.25) {
                need = Math.max(need, width(yc + a.y * palm * s, zc + a.z * palm * s));
            }
            if (Number.isFinite(need) && (!best || need < best.need)) best = { need, phi };
        }
        if (!best) return null;
        const x = best.need + half + IDLE_HIP_GAP * k;
        // The torso's back, where the elbow will be (the waist up to the
        // chest, inside the shoulders), as depth from the pelvis, forward
        // positive — the elbow is kept in front of it.
        let shoulderX = 0;
        for (let n = get(`${side}UpperArm`); n && n !== hips; n = n.parent) shoulderX += n.position.x;
        let back = Infinity;
        const b = scan.body;
        for (let i = 0; i < b.length; i += 3) {
            if (Math.abs(b[i]) > Math.abs(shoulderX) || b[i + 1] < yc - 0.05 * k || b[i + 1] > yc + 0.25 * k) continue;
            back = Math.min(back, (b[i + 2] - actor._hipsBasePos.z) * fz);
        }
        cache[side] = {
            p: new THREE.Vector3(x * outSign, yc, zc).sub(actor._hipsBasePos),
            phi: best.phi,
            back: Number.isFinite(back) ? back : -Infinity,
        };
        return cache[side];
    }
}
