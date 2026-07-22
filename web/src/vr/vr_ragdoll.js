
/**
 * VRRagdoll — full-body ragdoll physics for the companion avatar, built on
 * Jolt Physics (the engine behind Horizon Forbidden West; its JS port ships
 * the same API as the C++ engine).
 *
 * Jolt was chosen over Rapier because its JS bindings expose the constraint
 * types a humanoid ragdoll actually needs — Rapier's JS API has NO limits or
 * motors on ball joints, which is why heads/spines could spin 360°:
 *  - SwingTwistConstraint: cone + twist limits, models shoulders/hips/neck/
 *    spine anatomically, with built-in joint friction (mMaxFrictionTorque).
 *  - HingeConstraint with limits: elbows and knees (1 DOF, no backward bend).
 *  - GroupFilterTable: Jolt's native ragdoll self-collision mechanism —
 *    parts collide with each other EXCEPT directly-jointed pairs.
 *
 * The engine (WASM, ~2 MB) is lazy-loaded from the same CDN pattern as
 * three/three-vrm, only when ragdoll is first enabled.
 *
 * While enabled, ~16 humanoid bones are mirrored by dynamic capsule bodies;
 * each frame the simulated pose is written back onto the VRM's normalized
 * bones via the renderer's pre-vrm-update hook. Grabbing attaches a
 * kinematic hand body to the nearest limb with a point constraint. Disable
 * blends back to the captured pre-ragdoll pose, then resets the rig.
 *
 * Real-room collision (passthrough MR): at enable time, WebXR detected
 * planes (tables, seats, walls from the headset's room setup) are snapshotted
 * into static box colliders where the browser exposes the plane-detection
 * module. The floor plane at y=0 (local-floor space) is always present.
 */

// jolt-physics is bundled by Vite (npm dep, wasm-compat build with the WASM
// inlined) — same offline/Brave-shields rationale as bundling three.js. The
// dynamic import keeps it code-split so the ~2 MB module only downloads when
// the ragdoll toggle is first used. CDN candidates remain as a reachability
// fallback in case the local chunk is unavailable (e.g. a stale build).
const JOLT_URLS = [
    "https://cdn.jsdelivr.net/npm/jolt-physics@1.1.0/dist/jolt-physics.wasm-compat.js",
    "https://esm.sh/jolt-physics@1.1.0/wasm-compat",
];

const STEP = 1 / 90;            // physics timestep (Pico 4 native refresh)
const MAX_STEPS = 4;            // per-frame catch-up cap (avoid death spiral)
const RECOVER_S = 0.8;          // ragdoll → animation blend time on disable
const GRAB_RADIUS = 0.30;       // m — how close a hand must be to grab a limb
const DENSITY = 985;            // kg/m³ — human body, real limb masses
const LIN_DAMPING = 0.2;
const ANG_DAMPING = 0.6;
const LAYER_NON_MOVING = 0;     // floor + detected room planes
const LAYER_MOVING = 1;         // body parts + grab hands
const DEG = Math.PI / 180;

// Humanoid parts. Bones missing on a model (chest/neck are optional in VRM)
// fall back up the `parents` chain. Each non-root part carries its joint to
// the parent part:
//  - st:    SwingTwistConstraint — cone half-angle, twist range, friction
//           torque (N·m; real units against real masses). Twist axis = the
//           part's own capsule direction.
//  - hinge: HingeConstraint — axis in bone-local space (== the character's
//           T-pose frame: three-vrm normalized rigs are guaranteed T-pose,
//           facing +Z, left arm +X) + anatomical limits in radians.
// Values follow the standard humanoid ragdoll tables (Jolt/Unity samples).
const PARTS = [
    { name: "hips", parents: [], radius: 0.08 },
    { name: "spine", parents: ["hips"], radius: 0.075,
      st: { cone: 25 * DEG, twist: 20 * DEG, friction: 2 } },
    { name: "chest", parents: ["spine", "hips"], radius: 0.075,
      st: { cone: 20 * DEG, twist: 15 * DEG, friction: 2 } },
    { name: "head", parents: ["neck", "upperChest", "chest", "spine"], radius: 0.08,
      leafLen: 0.16, leafDir: [0, 1, 0],
      st: { cone: 45 * DEG, twist: 45 * DEG, friction: 1 } },
    { name: "leftUpperArm", parents: ["upperChest", "chest", "spine"], radius: 0.04,
      st: { cone: 90 * DEG, twist: 45 * DEG, friction: 1 } },
    { name: "leftLowerArm", parents: ["leftUpperArm"], radius: 0.035,
      hinge: { axis: [0, 1, 0], limits: [-2.4, 0.05], friction: 0.5 } },
    { name: "leftHand", parents: ["leftLowerArm"], radius: 0.03,
      leafLen: 0.12, leafDir: [1, 0, 0],
      st: { cone: 40 * DEG, twist: 20 * DEG, friction: 0.3 } },
    { name: "rightUpperArm", parents: ["upperChest", "chest", "spine"], radius: 0.04,
      st: { cone: 90 * DEG, twist: 45 * DEG, friction: 1 } },
    { name: "rightLowerArm", parents: ["rightUpperArm"], radius: 0.035,
      hinge: { axis: [0, 1, 0], limits: [-0.05, 2.4], friction: 0.5 } },
    { name: "rightHand", parents: ["rightLowerArm"], radius: 0.03,
      leafLen: 0.12, leafDir: [-1, 0, 0],
      st: { cone: 40 * DEG, twist: 20 * DEG, friction: 0.3 } },
    { name: "leftUpperLeg", parents: ["hips"], radius: 0.05,
      st: { cone: 50 * DEG, twist: 30 * DEG, friction: 2 } },
    { name: "leftLowerLeg", parents: ["leftUpperLeg"], radius: 0.045,
      hinge: { axis: [1, 0, 0], limits: [-0.05, 2.35], friction: 0.5 } },
    { name: "leftFoot", parents: ["leftLowerLeg"], radius: 0.04,
      leafLen: 0.12, leafDir: [0, 0, 1],
      st: { cone: 30 * DEG, twist: 15 * DEG, friction: 0.3 } },
    { name: "rightUpperLeg", parents: ["hips"], radius: 0.05,
      st: { cone: 50 * DEG, twist: 30 * DEG, friction: 2 } },
    { name: "rightLowerLeg", parents: ["rightUpperLeg"], radius: 0.045,
      hinge: { axis: [1, 0, 0], limits: [-0.05, 2.35], friction: 0.5 } },
    { name: "rightFoot", parents: ["rightLowerLeg"], radius: 0.04,
      leafLen: 0.12, leafDir: [0, 0, 1],
      st: { cone: 30 * DEG, twist: 15 * DEG, friction: 0.3 } },
];

// Which child bone defines each part's capsule direction/length.
const CHILD_OF = {
    hips: "spine", spine: "chest", chest: "neck",
    leftUpperArm: "leftLowerArm", leftLowerArm: "leftHand",
    rightUpperArm: "rightLowerArm", rightLowerArm: "rightHand",
    leftUpperLeg: "leftLowerLeg", leftLowerLeg: "leftFoot",
    rightUpperLeg: "rightLowerLeg", rightLowerLeg: "rightFoot",
};

let joltPromise = null;
async function loadJolt() {
    if (!joltPromise) {
        joltPromise = (async () => {
            let lastErr = null;
            try {
                const mod = await import("jolt-physics/wasm-compat");
                const initJolt = mod.default ?? mod;
                const Jolt = await initJolt();   // instantiates the WASM module
                console.info("[voice] jolt physics loaded from bundled module");
                return Jolt;
            } catch (e) {
                console.warn("[voice] bundled jolt load failed", e);
                lastErr = e;
            }
            for (const url of JOLT_URLS) {
                try {
                    const mod = await import(/* @vite-ignore */ url);
                    const initJolt = mod.default ?? mod;
                    const Jolt = await initJolt();   // instantiates the WASM module
                    console.info("[voice] jolt physics loaded from", url);
                    return Jolt;
                } catch (e) {
                    console.warn("[voice] jolt load failed from", url, e);
                    lastErr = e;
                }
            }
            throw lastErr || new Error("jolt: no candidate loaded");
        })().catch((e) => { joltPromise = null; throw e; });
    }
    return joltPromise;
}

export class VRRagdoll {
    /** @param avatar AvatarRenderer singleton
     *  @param THREE  three lib (from the XR session ctx)
     *  @param getHandWorldPos (i) => THREE.Vector3|null — live controller grip
     *         positions, used by held grabs each physics tick.
     *  @param opts { getXR?: () => ({ frame, refSpace }) } — access to the
     *         live XRFrame for detected-plane (real furniture) colliders. */
    constructor(avatar, THREE, getHandWorldPos, opts = {}) {
        this.avatar = avatar;
        this.THREE = THREE;
        this.getHandWorldPos = getHandWorldPos || (() => null);
        this.getXR = opts.getXR || (() => ({}));

        this.enabled = false;
        this._Jolt = null;
        this._jolt = null;           // JoltInterface (owns the PhysicsSystem)
        this._system = null;
        this._bodies = null;         // BodyInterface
        this._parts = [];            // [{ name, node, body, isHips, initialQ, initialP }]
        this._hands = [null, null];  // { body, constraint, part } while a limb is held
        this._vrm = null;            // vrm the ragdoll was built for (swap guard)
        this._acc = 0;
        this._recover = null;        // { t, entries, vrm } while blending out
        this._unsubTick = null;
        this._planeColliders = 0;    // diagnostic: real-room planes snapshotted

        this._q1 = new THREE.Quaternion();
        this._q2 = new THREE.Quaternion();
        this._v1 = new THREE.Vector3();
        this._v2 = new THREE.Vector3();
        this._v3 = new THREE.Vector3();
    }

    /** Build the physics mirror from the avatar's CURRENT pose and take over
     *  the mapped bones. Async only on first use (WASM download + init). */
    async enable() {
        if (this.enabled) return true;
        const vrm = this.avatar.vrm;
        const humanoid = vrm?.humanoid;
        if (!humanoid) return false;
        const Jolt = (this._Jolt ||= await loadJolt());
        if (this.enabled || this.avatar.vrm !== vrm) return this.enabled; // raced

        this.avatar.stopMoving?.();
        this._recover = null;
        this._vrm = vrm;
        vrm.scene.updateMatrixWorld(true);

        // ── World: two object layers (static room / moving body) ─────────
        const settings = new Jolt.JoltSettings();
        const pairFilter = new Jolt.ObjectLayerPairFilterTable(2);
        pairFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
        pairFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
        const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(0));
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(1));
        settings.mObjectLayerPairFilter = pairFilter;
        settings.mBroadPhaseLayerInterface = bpInterface;
        settings.mObjectVsBroadPhaseLayerFilter =
            new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpInterface, 2, pairFilter, 2);
        this._jolt = new Jolt.JoltInterface(settings);
        Jolt.destroy(settings);
        this._system = this._jolt.GetPhysicsSystem();
        this._bodies = this._system.GetBodyInterface();

        // Floor at y=0 (local-floor keeps the real/virtual floor there; the
        // AR recenter is yaw-only so this stays glued to the physical floor).
        this._addStaticBox(Jolt, 0, -0.5, 0, 50, 0.5, 50, null);
        // Real-room geometry: snapshot WebXR detected planes (tables, seats,
        // walls — headset room setup) into static colliders where supported.
        this._planeColliders = this._addDetectedPlanes(Jolt);

        // ── Body parts: capsules in the bones' world frames ──────────────
        // Jolt's ragdoll self-collision filter: parts collide except pairs
        // that share a joint. (Refcounted by the bodies; not destroyed here.)
        const groupFilter = new Jolt.GroupFilterTable(PARTS.length);

        const bone = (n) => humanoid.getNormalizedBoneNode?.(n) || null;
        const byName = new Map();
        this._parts = [];
        for (const spec of PARTS) {
            const node = bone(spec.name);
            if (!node) continue;
            const p = node.getWorldPosition(new this.THREE.Vector3());
            const q = node.getWorldQuaternion(new this.THREE.Quaternion());

            // Capsule from this bone toward its child (or a fixed leaf stub),
            // in the body's local frame; Jolt capsules run along local Y.
            const childNode = CHILD_OF[spec.name] ? bone(CHILD_OF[spec.name]) : null;
            let local;
            if (childNode) {
                const cp = childNode.getWorldPosition(this._v1);
                local = cp.sub(p).applyQuaternion(this._q1.copy(q).invert());
            } else {
                const d = spec.leafDir || [0, -1, 0];
                local = this._v1.set(d[0], d[1], d[2]).multiplyScalar(spec.leafLen || 0.1);
            }
            const len = local.length();
            const half = Math.max(len / 2 - spec.radius, 0.01);
            const rot = this._q2;
            if (len > 1e-4) {
                rot.setFromUnitVectors(this._v2.set(0, 1, 0), this._v3.copy(local).normalize());
            } else {
                rot.identity();
            }
            const capsule = new Jolt.CapsuleShapeSettings(half, spec.radius);
            capsule.mDensity = DENSITY;
            const jOff = new Jolt.Vec3(local.x / 2, local.y / 2, local.z / 2);
            const jRot = new Jolt.Quat(rot.x, rot.y, rot.z, rot.w);
            const offset = new Jolt.RotatedTranslatedShapeSettings(jOff, jRot, capsule);
            const shape = offset.Create().Get();

            const jPos = new Jolt.RVec3(p.x, p.y, p.z);
            const jQuat = new Jolt.Quat(q.x, q.y, q.z, q.w);
            const bcs = new Jolt.BodyCreationSettings(
                shape, jPos, jQuat, Jolt.EMotionType_Dynamic, LAYER_MOVING,
            );
            const idx = this._parts.length;
            const group = new Jolt.CollisionGroup(groupFilter, 0, idx);
            bcs.mCollisionGroup = group;
            const body = this._bodies.CreateBody(bcs);
            this._bodies.AddBody(body.GetID(), Jolt.EActivation_Activate);
            const motion = body.GetMotionProperties();
            motion.SetLinearDamping(LIN_DAMPING);
            motion.SetAngularDamping(ANG_DAMPING);
            body.SetFriction(0.8);
            body.SetRestitution(0);
            for (const o of [bcs, group, jQuat, jPos, offset, jRot, jOff]) Jolt.destroy(o);

            const part = {
                name: spec.name, spec, node, body, idx,
                isHips: spec.name === "hips",
                // World capsule direction = the joint's twist axis.
                twistDir: len > 1e-4
                    ? this._v3.copy(local).normalize().applyQuaternion(q).clone()
                    : new this.THREE.Vector3(0, 1, 0).applyQuaternion(q),
                initialQ: node.quaternion.clone(),
                initialP: spec.name === "hips" ? node.position.clone() : null,
            };
            byName.set(spec.name, part);
            this._parts.push(part);
        }

        // ── Anatomical joints (world-space settings at build pose) ───────
        for (const part of this._parts) {
            if (part.isHips) continue;
            let parent = null;
            for (const pn of part.spec.parents) {
                if (byName.has(pn)) { parent = byName.get(pn); break; }
            }
            if (!parent) continue;
            groupFilter.DisableCollision(part.idx, parent.idx);

            const pivot = part.node.getWorldPosition(this._v1);
            const jPivot = new Jolt.RVec3(pivot.x, pivot.y, pivot.z);
            let cSettings;
            if (part.spec.hinge) {
                const h = part.spec.hinge;
                // Axis is constant in bone-local space (== T-pose character
                // frame); world axis = bone rotation applied to it.
                part.node.getWorldQuaternion(this._q1);
                const axis = this._v2.set(h.axis[0], h.axis[1], h.axis[2])
                    .applyQuaternion(this._q1).normalize();
                const normal = this._perpendicular(axis, this._v3);
                const jAxis = new Jolt.Vec3(axis.x, axis.y, axis.z);
                const jNormal = new Jolt.Vec3(normal.x, normal.y, normal.z);
                const hs = new Jolt.HingeConstraintSettings();
                hs.mPoint1 = jPivot; hs.mPoint2 = jPivot;
                hs.mHingeAxis1 = jAxis; hs.mHingeAxis2 = jAxis;
                hs.mNormalAxis1 = jNormal; hs.mNormalAxis2 = jNormal;
                hs.mLimitsMin = h.limits[0]; hs.mLimitsMax = h.limits[1];
                hs.mMaxFrictionTorque = h.friction;
                cSettings = hs;
                Jolt.destroy(jAxis);
                Jolt.destroy(jNormal);
            } else {
                const st = part.spec.st || { cone: 45 * DEG, twist: 30 * DEG, friction: 1 };
                const twist = part.twistDir;
                const plane = this._perpendicular(twist, this._v3);
                const jTwist = new Jolt.Vec3(twist.x, twist.y, twist.z);
                const jPlane = new Jolt.Vec3(plane.x, plane.y, plane.z);
                const ss = new Jolt.SwingTwistConstraintSettings();
                ss.mPosition1 = jPivot; ss.mPosition2 = jPivot;
                ss.mTwistAxis1 = jTwist; ss.mTwistAxis2 = jTwist;
                ss.mPlaneAxis1 = jPlane; ss.mPlaneAxis2 = jPlane;
                ss.mNormalHalfConeAngle = st.cone;
                ss.mPlaneHalfConeAngle = st.cone;
                ss.mTwistMinAngle = -st.twist;
                ss.mTwistMaxAngle = st.twist;
                ss.mMaxFrictionTorque = st.friction;
                cSettings = ss;
                Jolt.destroy(jTwist);
                Jolt.destroy(jPlane);
            }
            const constraint = this._bodies.CreateConstraint(
                cSettings, parent.body.GetID(), part.body.GetID());
            this._system.AddConstraint(constraint);
            Jolt.destroy(cSettings);
            Jolt.destroy(jPivot);
        }

        this._acc = 0;
        this.enabled = true;
        if (!this._unsubTick) {
            this._unsubTick = this.avatar.addPreVRMUpdateCallback((delta) => this._tick(delta));
        }
        return true;
    }

    /** Hand the body back to the animation system: blend the ragdoll's final
     *  pose back to the PRE-RAGDOLL pose, then reset the normalized rig so
     *  every bone (including ones no animation track drives) returns to its
     *  default, and let the mixer/idle re-pose from there. */
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.release(0);
        this.release(1);
        const entries = this._parts.map((part) => ({
            node: part.node,
            qFrom: part.node.quaternion.clone(),                   // ragdoll final
            qTo: part.initialQ,                                    // pre-ragdoll
            pFrom: part.isHips ? part.node.position.clone() : null,
            pTo: part.initialP,
        }));
        this._recover = { t: 0, entries, vrm: this._vrm };
        this._freeWorld();
    }

    /** Grip pressed near the avatar: attach the nearest limb to this hand.
     *  Returns the grabbed part name, or null when nothing is in reach. */
    tryGrab(i, worldPos) {
        if (!this.enabled || !this._jolt) return null;
        const Jolt = this._Jolt;
        let best = null;
        let bestD = GRAB_RADIUS;
        for (const part of this._parts) {
            const t = part.body.GetPosition();
            const d = Math.hypot(worldPos.x - t.GetX(), worldPos.y - t.GetY(), worldPos.z - t.GetZ());
            if (d < bestD) { bestD = d; best = part; }
        }
        if (!best) return null;
        this.release(i);
        // Kinematic sensor sphere that the controller drags around; a point
        // constraint pins the limb to it at the grab point.
        const shape = new Jolt.SphereShape(0.02);
        const bcs = new Jolt.BodyCreationSettings(
            shape,
            new Jolt.RVec3(worldPos.x, worldPos.y, worldPos.z),
            Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Kinematic,
            LAYER_MOVING,
        );
        bcs.mIsSensor = true;
        const handBody = this._bodies.CreateBody(bcs);
        this._bodies.AddBody(handBody.GetID(), Jolt.EActivation_Activate);
        Jolt.destroy(bcs);
        const ps = new Jolt.PointConstraintSettings();
        const jp = new Jolt.RVec3(worldPos.x, worldPos.y, worldPos.z);
        ps.mPoint1 = jp; ps.mPoint2 = jp;
        const constraint = this._bodies.CreateConstraint(
            ps, handBody.GetID(), best.body.GetID());
        this._system.AddConstraint(constraint);
        Jolt.destroy(ps);
        Jolt.destroy(jp);
        this._hands[i] = { body: handBody, constraint, part: best };
        return best.name;
    }

    release(i) {
        const h = this._hands[i];
        if (!h) return;
        this._hands[i] = null;
        if (!this._jolt) return;
        try {
            this._system.RemoveConstraint(h.constraint);
            this._bodies.RemoveBody(h.body.GetID());
            this._bodies.DestroyBody(h.body.GetID());
        } catch (e) { /* non-fatal */ }
    }

    /** Per-frame, from the renderer's pre-vrm-update hook: step the world and
     *  overwrite the animated pose with the simulated one (or blend out of it
     *  while recovering). */
    _tick(delta) {
        // Recover blend: overwrite the mapped bones entirely, easing from the
        // ragdoll's final pose (k=1) back to the pre-ragdoll pose (k=0), then
        // hand control back with a clean rig reset.
        if (this._recover) {
            this._recover.t += delta / RECOVER_S;
            const t = Math.min(this._recover.t, 1);
            const k = 1 - easeInOutCubic(t);
            for (const e of this._recover.entries) {
                e.node.quaternion.slerpQuaternions(e.qTo, e.qFrom, k);
                if (e.pFrom) e.node.position.lerpVectors(e.pTo, e.pFrom, k);
            }
            if (t >= 1) {
                const vrm = this._recover.vrm;
                try { vrm?.humanoid?.resetNormalizedPose?.(); } catch (e) { /* non-fatal */ }
                try { vrm?.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
                this._recover = null;
                if (!this.enabled && this._unsubTick) {
                    this._unsubTick();
                    this._unsubTick = null;
                }
            }
            return;
        }
        if (!this.enabled || !this._jolt) return;
        // Avatar swapped mid-ragdoll: the bone nodes are orphaned — drop the
        // simulation without a blend (the new model starts clean).
        if (this.avatar.vrm !== this._vrm) {
            this.enabled = false;
            this._hands = [null, null];
            this._freeWorld();
            if (this._unsubTick) { this._unsubTick(); this._unsubTick = null; }
            return;
        }

        const Jolt = this._Jolt;
        this._acc = Math.min(this._acc + delta, STEP * MAX_STEPS);
        while (this._acc >= STEP) {
            this._acc -= STEP;
            // Held limbs chase the live controller pose every physics tick.
            for (let i = 0; i < 2; i++) {
                const h = this._hands[i];
                if (!h) continue;
                const p = this.getHandWorldPos(i);
                if (!p) continue;
                const jp = new Jolt.RVec3(p.x, p.y, p.z);
                // sIdentity() returns an engine-owned temporary — never
                // destroy it (that would free static WASM memory).
                this._bodies.MoveKinematic(h.body.GetID(), jp, Jolt.Quat.prototype.sIdentity(), STEP);
                Jolt.destroy(jp);
            }
            this._jolt.Step(STEP, 1);
        }

        // Write the simulated pose onto the normalized bones, parents first
        // (PARTS is ordered root→leaf). Body rotations ARE bone world
        // rotations — bodies were created in the bones' world frames.
        for (const part of this._parts) {
            const node = part.node;
            if (!node.parent) continue;
            node.parent.updateWorldMatrix(true, false);
            node.parent.getWorldQuaternion(this._q1);
            const r = part.body.GetRotation();
            this._q2.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
            node.quaternion.copy(this._q1.invert().multiply(this._q2));
            if (part.isHips) {
                const t = part.body.GetPosition();
                node.position.copy(node.parent.worldToLocal(
                    this._v1.set(t.GetX(), t.GetY(), t.GetZ())));
            }
        }
    }

    /** Static box collider (floor / detected room planes). */
    _addStaticBox(Jolt, x, y, z, hx, hy, hz, quat) {
        const half = new Jolt.Vec3(hx, hy, hz);
        const shape = new Jolt.BoxShape(half);
        // sIdentity() is an engine-owned temporary; only destroy quats WE made.
        const rot = quat ? new Jolt.Quat(quat.x, quat.y, quat.z, quat.w) : null;
        const pos = new Jolt.RVec3(x, y, z);
        const bcs = new Jolt.BodyCreationSettings(
            shape, pos, rot || Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Static, LAYER_NON_MOVING,
        );
        const body = this._bodies.CreateBody(bcs);
        this._bodies.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
        Jolt.destroy(bcs);
        Jolt.destroy(pos);
        Jolt.destroy(half);
        if (rot) Jolt.destroy(rot);
    }

    /** Snapshot WebXR detected planes (real tables/seats/walls from the
     *  headset room setup) as thin static boxes, in scene coordinates.
     *  No-op where the browser doesn't expose plane-detection (e.g. current
     *  Pico 4 browser) — only the y=0 floor exists then. Returns the count. */
    _addDetectedPlanes(Jolt) {
        let count = 0;
        try {
            const { frame, refSpace } = this.getXR() || {};
            const planes = frame?.detectedPlanes;
            if (!planes || !refSpace) return 0;
            const q = this._q1;
            for (const plane of planes) {
                const pose = frame.getPose(plane.planeSpace, refSpace);
                if (!pose || !plane.polygon?.length) continue;
                // Plane-local: polygon in XZ, +Y is the plane normal.
                let maxX = 0, maxZ = 0;
                for (const pt of plane.polygon) {
                    maxX = Math.max(maxX, Math.abs(pt.x));
                    maxZ = Math.max(maxZ, Math.abs(pt.z));
                }
                if (maxX < 0.05 || maxZ < 0.05) continue;
                const p = pose.transform.position;
                const o = pose.transform.orientation;
                q.set(o.x, o.y, o.z, o.w);
                this._addStaticBox(Jolt, p.x, p.y, p.z, maxX, 0.02, maxZ, q);
                count++;
            }
        } catch (e) { /* plane detection is best-effort */ }
        return count;
    }

    /** Unit vector perpendicular to `axis`, into `out`. */
    _perpendicular(axis, out) {
        out.set(1, 0, 0);
        if (Math.abs(axis.x) > 0.9) out.set(0, 1, 0);
        return out.cross(axis).normalize();
    }

    _freeWorld() {
        if (this._jolt) {
            // Destroying the JoltInterface frees the physics system and every
            // body/constraint it owns.
            try { this._Jolt.destroy(this._jolt); } catch (e) { /* non-fatal */ }
        }
        this._jolt = null;
        this._system = null;
        this._bodies = null;
        this._parts = [];
        this._hands = [null, null];
        this._vrm = null;
        this._planeColliders = 0;
    }

    /** Immediate teardown (session end): no blend — reset the rig to its
     *  default pose right away so the flat view doesn't inherit a deformed
     *  ragdoll pose on bones the animation doesn't drive. */
    dispose() {
        this.enabled = false;
        this._recover = null;
        try { this._vrm?.humanoid?.resetNormalizedPose?.(); } catch (e) { /* non-fatal */ }
        try { this._vrm?.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
        this._freeWorld();
        if (this._unsubTick) { this._unsubTick(); this._unsubTick = null; }
    }
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
