/**
 * AvatarProximity — turns "a controller got near the avatar" into contact events.
 *
 * Each frame every controller grip is tested against the VRM's humanoid bone
 * nodes; the closest one decides both the hand indicator's colour and whether a
 * contact fires. Contacts are edge-triggered (a hand resting inside the range
 * fires once, not every frame) and rate-limited per hand.
 *
 * This class deliberately owns no haptics and no speech — it reports contact
 * and paints the indicator, and the caller decides what a contact means. That
 * keeps the reaction policy (which regions talk, which only buzz) in one place
 * in vr_manager rather than split across two files.
 *
 * Ranges are in metres, derived from hand geometry rather than tuned by feel:
 *   - a relaxed adult palm is roughly 10cm across, and the grip space origin
 *     sits at the centre of the fist, so 0.10 is "the hand is on it";
 *   - a deliberate reach with the trigger held adds about a hand-and-wrist
 *     again, hence 0.30.
 */

const CONTACT_RANGE = 0.10;
const REACH_RANGE = 0.30;

// Release threshold — deliberately wider than CONTACT_RANGE, giving the
// contact test a hysteresis band (a Schmitt trigger). With one shared
// threshold, a hand held near the boundary crosses it back and forth every
// frame from ordinary tracking jitter, and each crossing looks like a brand
// new touch. You make contact at 0.10 but have to withdraw past 0.14 to break
// it, so a resting hand stays in exactly one state. The band is far wider than
// controller jitter yet well inside REACH_RANGE.
const RELEASE_RANGE = 0.14;

// The head bone's origin sits at the base of the skull, which puts the "pat"
// zone somewhere around the ear. Lift the test point along the head's own up
// axis so it lands on the crown where a pat actually goes.
const CROWN_LIFT = 0.12;

// Per-bone radius, subtracted from the joint distance so ranges are measured
// against the body's SURFACE rather than its skeleton.
//
// Without this the torso is effectively untouchable, because two offsets stack
// against it: the spine/chest joints sit at the centre of the body (~8cm
// behind the navel on a slim VRoid build), and the probe is the grip origin —
// the centre of the fist — which trails the touch marker the user is aiming
// with by another ~7cm. Reaching out and visibly touching the belly therefore
// measures ~15cm joint-to-grip and never crosses a 10cm threshold. The head
// escaped this only because CROWN_LIFT already shoves its test point outward.
//
// Values approximate the flesh around each joint. They are deliberately in the
// same ballpark within a limb chain so the nearest-joint contest still picks
// the anatomically right bone rather than whichever has the fattest number.
// `head` stays 0 — CROWN_LIFT is its offset and doubling up would make it
// swallow touches aimed at the neck and shoulders.
const BONE_RADIUS = {
    head: 0,
    neck: 0.05,
    hips: 0.11,
    spine: 0.12,
    chest: 0.11,
    upperChest: 0.10,
    leftShoulder: 0.06, rightShoulder: 0.06,
    leftUpperArm: 0.05, rightUpperArm: 0.05,
    leftLowerArm: 0.04, rightLowerArm: 0.04,
    leftHand: 0.03, rightHand: 0.03,
    leftUpperLeg: 0.08, rightUpperLeg: 0.08,
    leftLowerLeg: 0.05, rightLowerLeg: 0.05,
    leftFoot: 0.04, rightFoot: 0.04,
};

// Per-hand refractory between touches. Only genuine re-entries are affected —
// a hand simply left resting is held off by the contact-episode latch, not by
// this — so it can be short enough to keep repeat poking responsive.
const REARM_MS = 1200;

// Indicator palette: neutral at rest, warming as the hand closes, mint on
// contact. Kept low-saturation so it reads against both light and dark scenes.
const TINT_REST = 0x9aa7b8;
const TINT_CLOSE = 0xe0a34a;
const TINT_CONTACT = 0x6fe3a0;

const GLOW_REST = 0.08;
const GLOW_CLOSE = 0.28;
const GLOW_CONTACT = 0.42;

/** Hermite smoothstep — eases the approach glow in at both ends. */
function smoothstep(t) {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
}

/**
 * Coarse body region for a VRM humanoid bone name, used to pick a reaction.
 *
 * `chest` and `belly` are split along the VRM spine chain
 * (hips → spine → chest → upperChest): `spine` sits at roughly the navel, so
 * it is the belly, while `chest`/`upperChest` are the chest proper. Test
 * `chest` first — "upperChest" lowercases to a string containing "chest".
 */
export function boneRegion(boneName) {
    const n = (boneName || "").toLowerCase();
    if (n.includes("head") || n.includes("neck")) return "head";
    if (n.includes("hand")) return "hand";
    if (n.includes("shoulder")) return "shoulder";
    if (n.includes("arm")) return "arm";
    if (n.includes("chest")) return "chest";
    if (n.includes("spine")) return "belly";
    if (n.includes("hips")) return "hips";
    if (n.includes("foot")) return "foot";
    if (n.includes("upperleg")) return "thigh";
    if (n.includes("leg")) return "leg";
    return "body";
}

export class AvatarProximity {
    /**
     * @param avatar   AvatarRenderer singleton — supplies the humanoid bones
     * @param THREE    three namespace from the session ctx (no direct import)
     * @param parts    { grips: [Object3D, Object3D], indicators: [Group, Group] }
     * @param hooks    { onContact(region, boneName, hand) }
     */
    constructor(avatar, THREE, { grips, indicators }, { onContact } = {}) {
        this.avatar = avatar;
        this.grips = grips || [];
        this.indicators = indicators || [];
        this.onContact = onContact || null;

        this._vrm = avatar.vrm || null;
        this._bones = avatar.getHumanoidBones?.() || [];

        // Per-hand contact state. `_contact` is purely geometric (hysteretic);
        // `_firedRegion` is the region already reported during the CURRENT
        // contact episode, cleared the moment the hand breaks away; `_rearmAt`
        // is the refractory. Keeping the geometry and the firing bookkeeping
        // separate is what stops a suppressed touch from eating the entry.
        this._rearmAt = [0, 0];
        this._contact = [false, false];
        this._firedRegion = [null, null];

        this._probePoint = new THREE.Vector3();
        this._bonePoint = new THREE.Vector3();
        this._lift = new THREE.Vector3();
        this._headFacing = new THREE.Quaternion();

        this._tintRest = new THREE.Color(TINT_REST);
        this._tintClose = new THREE.Color(TINT_CLOSE);
        this._tintContact = new THREE.Color(TINT_CONTACT);
        this._blend = new THREE.Color();

        this._running = false;
    }

    start() { this._running = true; }
    stop() { this._running = false; }

    /**
     * Per-frame, from the renderer's XR loop (after vrm.update).
     *
     * Takes no timestamp on purpose: the render loop's `now` is a three.js
     * Clock elapsed-seconds value, and the re-arm bookkeeping here shares a
     * wall-clock millisecond epoch with `reachOut`. Mixing the two would arm
     * the cooldown thousands of "seconds" into the future.
     */
    tick() {
        if (!this._running) return;
        const now = Date.now();
        // An avatar swap rebuilds the humanoid, and a VRM can finish loading
        // after the session began. Stale nodes keep reporting positions from a
        // scene that is no longer attached, so contacts silently stop landing.
        if (this.avatar.vrm !== this._vrm) this._rebind();
        if (!this._bones.length) return;

        for (let hand = 0; hand < this.grips.length; hand++) {
            const near = this._closestTo(hand);
            if (!near) continue;

            this._paint(hand, near.distance);

            // Hysteresis: reach CONTACT_RANGE to make contact, withdraw past
            // the wider RELEASE_RANGE to break it.
            const touching = this._contact[hand]
                ? near.distance < RELEASE_RANGE
                : near.distance < CONTACT_RANGE;
            this._contact[hand] = touching;

            if (!touching) {
                // Breaking away ends the episode: the next entry is a new touch.
                this._firedRegion[hand] = null;
                continue;
            }

            // One report per (contact episode, region). Holding still won't
            // repeat, but sliding from belly to head without lifting off is a
            // new touch in a new place and does.
            //
            // The refractory gates only the report — `_firedRegion` stays null
            // through it, so a hand that arrives mid-refractory fires as soon
            // as it lapses. The previous version latched the contact flag even
            // when it suppressed the touch, which destroyed the pending entry
            // and left that hand needing two full in-and-out cycles to fire.
            const region = boneRegion(near.bone.name);
            if (region !== this._firedRegion[hand] && now >= this._rearmAt[hand]) {
                this._fire(hand, region, near.bone.name, now);
            }
        }
    }

    /**
     * Deliberate reach — the trigger extends the range so the user can touch
     * without pressing their controller into the avatar's mesh.
     */
    reachOut(hand) {
        if (!this._running) return;
        const now = Date.now();
        if (now < this._rearmAt[hand]) return;
        const near = this._closestTo(hand);
        if (!near?.bone || near.distance >= REACH_RANGE) return;
        this._fire(hand, boneRegion(near.bone.name), near.bone.name, now);
    }

    /**
     * What this hand is closest to right now, for callers that need the region
     * without firing a contact (vr_manager's grip-to-grab check).
     */
    probe(hand) {
        const near = this._closestTo(hand);
        if (!near?.bone) return { region: null, distance: Infinity, boneName: null };
        return {
            region: boneRegion(near.bone.name),
            distance: near.distance,
            boneName: near.bone.name,
        };
    }

    /** Re-read bone nodes after an avatar swap (loadVRM rebuilds the humanoid). */
    _rebind() {
        this._vrm = this.avatar.vrm || null;
        this._bones = this.avatar.getHumanoidBones?.() || [];
    }

    /** Nearest bone to a hand's grip, or null when that grip is missing. */
    _closestTo(hand) {
        const grip = this.grips[hand];
        if (!grip || !this._bones.length) return null;
        grip.getWorldPosition(this._probePoint);

        let bone = null;
        let distance = Infinity;
        for (const candidate of this._bones) {
            candidate.node.getWorldPosition(this._bonePoint);
            if (candidate.name === "head") {
                candidate.node.getWorldQuaternion(this._headFacing);
                this._bonePoint.add(
                    this._lift.set(0, CROWN_LIFT, 0).applyQuaternion(this._headFacing),
                );
            }
            // Surface distance, not joint distance — see BONE_RADIUS. Clamped
            // at 0 so a hand pushed inside the body doesn't go negative and
            // beat every other bone by an ever-growing margin.
            const d = Math.max(
                0,
                this._probePoint.distanceTo(this._bonePoint) - (BONE_RADIUS[candidate.name] || 0),
            );
            if (d < distance) {
                distance = d;
                bone = candidate;
            }
        }
        return { bone, distance };
    }

    /** Report a touch and open this hand's refractory. */
    _fire(hand, region, boneName, now) {
        this._firedRegion[hand] = region;
        this._rearmAt[hand] = now + REARM_MS;
        this.onContact?.(region, boneName, hand);
    }

    /** Tint and glow the hand marker by how close it is. */
    _paint(hand, distance) {
        const marker = this.indicators[hand]?.userData;
        if (!marker?.sphere || !marker?.glow) return;

        let tint;
        let glow;
        if (distance < CONTACT_RANGE) {
            tint = this._tintContact;
            glow = GLOW_CONTACT;
        } else if (distance < REACH_RANGE) {
            const closeness = smoothstep(
                1 - (distance - CONTACT_RANGE) / (REACH_RANGE - CONTACT_RANGE),
            );
            tint = this._blend.copy(this._tintRest).lerp(this._tintClose, closeness);
            glow = GLOW_REST + (GLOW_CLOSE - GLOW_REST) * closeness;
        } else {
            tint = this._tintRest;
            glow = GLOW_REST;
        }

        marker.sphere.material.color.copy(tint);
        marker.glow.material.color.copy(tint);
        marker.glow.material.opacity = glow;
    }
}
