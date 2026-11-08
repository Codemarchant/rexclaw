/**
 * Foot IK for neural body motion.
 *
 * Whether a foot is planted is judged on the MODEL's rig, from the ball of
 * the foot (the `feet` frames), because that is where the motion was drawn;
 * the avatar's retargeted foot would read proportions as sliding. A planted
 * ball locks to its floor spot with a smoothstepped blend, and a foot left
 * too far behind releases until it next leaves the floor. Each ankle target
 * comes from the ball target, the pelvis drops if a leg can't reach, a
 * two-bone solve with a soft reach limit places the leg, and the heel and
 * toe are then rotated up out of the floor. Distances are in leg lengths.
 *
 * All of it works in normalized bone space (T-pose = identity), walking the
 * hierarchy by hand, and everything scales with `weight`: at 0 nothing here
 * changes the pose, so handing the legs back to the idle is a fade.
 */

const ENTER_HEIGHT = 0.02;
const EXIT_HEIGHT = 0.05;
const ENTER_SPEED = 0.15;
const EXIT_SPEED = 0.35;
const SIGNAL_RISE = 30;
const SIGNAL_FALL = 12;
const MAX_LOCK_DISTANCE = 0.3;
const LOCK_BLEND_IN_S = 0.1;
const LOCK_BLEND_OUT_S = 0.2;
const MAX_LOCK_YAW = (25 * Math.PI) / 180;
const MAX_PELVIS_DROP = 0.15;
const PELVIS_DROP_RISE = 20;
const PELVIS_DROP_FALL = 8;
const GROUND_EASE_BAND = 0.005;
const MAX_GROUND_ANGLE = (30 * Math.PI) / 180;
const HEEL_BEHIND = 0.5;
// A VRM's toe bone is usually a leaf, so the tip is estimated from the
// foot's length; and a step sized for a wider pelvis could bring the feet
// together on a narrow avatar, so each stays this share of the hip joint's
// width out from the pelvis.
const TOE_LENGTH = 0.6;
const MIN_STANCE = 0.9;
// On a VRM bound in a straight T-pose, a leg stopped at 97% of its length
// bent the knees to 33-35 degrees where the model itself stands at 6-10
// (measured on two avatars). These bring the IK's knees to about 9 and keep
// the feet as planted.
const PELVIS_ASSIST_REACH = 0.995;
const SOFT_REACH = 0.998;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t) => t * t * (3 - 2 * t);
const towards = (from, to, rise, fall, dt) => from + (to - from)
    * (1 - Math.exp(-(to > from ? rise : fall) * dt));
const triangleAngle = (opposite, a, b) => Math.acos(clamp((a * a + b * b - opposite * opposite) / (2 * a * b), -1, 1));

class Leg {
    constructor(THREE, thigh, shin, foot, toes, hipsBaseY) {
        this.thigh = thigh;
        this.shin = shin;
        this.foot = foot;
        this.toes = toes;
        this.upper = shin.position.length();
        this.lower = foot.position.length();
        this.length = this.upper + this.lower;
        this.ankleBindY = hipsBaseY + thigh.position.y + shin.position.y + foot.position.y;
        // Foot-space offsets; bones have no rest rotation in normalized space.
        this.ballOffset = toes ? toes.position.clone() : new THREE.Vector3();
        this.ballBindY = this.ankleBindY + this.ballOffset.y;
        const ahead = new THREE.Vector3(this.ballOffset.x, 0, this.ballOffset.z);
        this.heel = new THREE.Vector3(0, -this.ankleBindY, 0).addScaledVector(ahead, -HEEL_BEHIND);
        this.toeTip = ahead.clone().multiplyScalar(TOE_LENGTH).setY(-this.ballBindY);
        this.lift = 0;
        this.speed = 0;
        this.inContact = false;
        this.locked = false;
        this.blocked = false;      // released too far: stays off until it lifts
        this.blend = 0;
        this.anchorX = 0;
        this.anchorZ = 0;
        this.anchorRotation = new THREE.Quaternion();
        this.a = new THREE.Vector3();    // hip, knee, ankle, ball in root space
        this.b = new THREE.Vector3();
        this.c = new THREE.Vector3();
        this.ball = new THREE.Vector3();
        this.thighQ = new THREE.Quaternion();
        this.shinQ = new THREE.Quaternion();
        this.footQ = new THREE.Quaternion();
        this.ankleTarget = new THREE.Vector3();
        this.footTarget = new THREE.Quaternion();
        this.kneeAxis = new THREE.Vector3();     // thigh space
    }
}

export class FootIk {
    constructor(THREE, vrm, hipsBaseY, forwardZ) {
        this.THREE = THREE;
        const get = (name) => vrm.humanoid.getNormalizedBoneNode(name);
        this.hips = get("hips");
        this.legs = ["left", "right"].map((side) => {
            const [thigh, shin, foot] = [get(`${side}UpperLeg`), get(`${side}LowerLeg`), get(`${side}Foot`)];
            return thigh && shin && foot ? new Leg(THREE, thigh, shin, foot, get(`${side}Toes`), hipsBaseY) : null;
        });
        this.ok = !!this.hips && this.legs.every(Boolean);
        if (!this.ok) return;
        this.drop = 0;
        this.up = new THREE.Vector3(0, 1, 0);
        // The knee bends forward: a straight leg's hinge is across the body.
        for (const leg of this.legs) {
            leg.kneeAxis.set(forwardZ > 0 ? 1 : -1, 0, 0);
        }
    }

    reset() {
        this.drop = 0;
        for (const leg of this.legs) {
            leg.inContact = leg.locked = leg.blocked = false;
            leg.blend = 0;
            leg.lift = leg.speed = 0;
        }
    }

    _forward(leg) {
        const { hips } = this;
        leg.thighQ.copy(hips.quaternion).multiply(leg.thigh.quaternion);
        leg.shinQ.copy(leg.thighQ).multiply(leg.shin.quaternion);
        leg.footQ.copy(leg.shinQ).multiply(leg.foot.quaternion);
        leg.a.copy(leg.thigh.position).applyQuaternion(hips.quaternion).add(hips.position);
        leg.b.copy(leg.shin.position).applyQuaternion(leg.thighQ).add(leg.a);
        leg.c.copy(leg.foot.position).applyQuaternion(leg.shinQ).add(leg.b);
        leg.ball.copy(leg.ballOffset).applyQuaternion(leg.footQ).add(leg.c);
    }

    _yawDelta(leg, rotation) {
        const out = new this.THREE.Quaternion();
        const w = smoothstep(leg.blend);
        if (w <= 0.0001) return out;
        const d = rotation.clone().multiply(leg.anchorRotation.clone().invert());
        const sign = d.w < 0 ? -1 : 1;
        const y = d.y * sign;
        const dw = d.w * sign;
        if (dw * dw + y * y < 1e-12) return out;
        const yaw = clamp(2 * Math.atan2(y, dw), -MAX_LOCK_YAW, MAX_LOCK_YAW);
        return out.setFromAxisAngle(this.up, -yaw * w);
    }

    _lockedXZ(leg) {
        const w = smoothstep(leg.blend);
        return [leg.ball.x + (leg.anchorX - leg.ball.x) * w, leg.ball.z + (leg.anchorZ - leg.ball.z) * w];
    }

    _contact(leg, lift, speed, dt) {
        leg.lift = towards(leg.lift, lift, SIGNAL_RISE, SIGNAL_FALL, dt);
        leg.speed = towards(leg.speed, speed, SIGNAL_RISE, SIGNAL_FALL, dt);
        if (leg.inContact) {
            if (leg.lift > EXIT_HEIGHT || leg.speed > EXIT_SPEED) leg.inContact = false;
        } else if (leg.lift < ENTER_HEIGHT && leg.speed < ENTER_SPEED) {
            leg.inContact = true;
        }
        if (!leg.inContact) {
            leg.locked = leg.blocked = false;
        } else if (leg.locked) {
            const away = Math.hypot(leg.ball.x - leg.anchorX, leg.ball.z - leg.anchorZ);
            if (away > MAX_LOCK_DISTANCE * leg.length) {
                leg.locked = false;
                leg.blocked = true;
            }
        } else if (!leg.blocked) {
            const [x, z] = this._lockedXZ(leg);
            leg.anchorX = x;
            leg.anchorZ = z;
            leg.anchorRotation.copy(this._yawDelta(leg, leg.footQ)).multiply(leg.footQ);
            leg.locked = true;
        }
        const time = leg.locked ? LOCK_BLEND_IN_S : LOCK_BLEND_OUT_S;
        leg.blend = clamp(leg.blend + (leg.locked ? dt / time : -dt / time), 0, 1);
    }

    _targets(leg, lift) {
        const [x, z] = this._lockedXZ(leg);
        const height = leg.ballBindY + Math.max(0, lift * leg.length);
        const yaw = new this.THREE.Quaternion().slerp(this._yawDelta(leg, leg.footQ), this.weight);
        leg.footTarget.copy(yaw).multiply(leg.footQ);
        const fromAnkle = leg.ball.clone().sub(leg.c).applyQuaternion(yaw);
        leg.ankleTarget.set(x, height, z).sub(fromAnkle);
        const hip = leg.thigh.position.x;
        const edge = this.hips.position.x + hip * MIN_STANCE;
        leg.ankleTarget.x = hip > 0 ? Math.max(leg.ankleTarget.x, edge) : Math.min(leg.ankleTarget.x, edge);
    }

    _assistPelvis(dt) {
        let wanted = 0;
        for (const leg of this.legs) {
            const reach = leg.length * PELVIS_ASSIST_REACH;
            const dx = leg.ankleTarget.x - leg.a.x;
            const dz = leg.ankleTarget.z - leg.a.z;
            const across = dx * dx + dz * dz;
            const need = reach * reach > across
                ? Math.max(0, -(leg.ankleTarget.y - leg.a.y) - Math.sqrt(reach * reach - across)) : 0;
            wanted = Math.max(wanted, Math.min(need, MAX_PELVIS_DROP * leg.length));
        }
        this.drop = towards(this.drop, wanted, PELVIS_DROP_RISE, PELVIS_DROP_FALL, dt);
        this.hips.position.y -= this.drop * this.weight;
    }

    _solve(leg) {
        const THREE = this.THREE;
        const { a, b, c } = leg;
        const target = leg.ankleTarget;
        const l1 = leg.upper;
        const l2 = leg.lower;
        if (l1 < 0.0001 || l2 < 0.0001) return;
        const to = target.clone().sub(a);
        let reach = to.length();
        if (reach < 0.0001) return;
        const full = l1 + l2;
        const soft = full * SOFT_REACH;
        if (reach > soft) {
            const range = Math.max(full - soft, 0.0001);
            const over = Math.min(reach - soft, 2 * range);
            const limited = soft + over - (over * over) / (4 * range);
            to.multiplyScalar(limited / reach);
            reach = limited;
        }
        const knee = triangleAngle(c.distanceTo(a), l1, l2) - triangleAngle(reach, l1, l2);
        const axis = leg.kneeAxis.clone().applyQuaternion(leg.thighQ).normalize();
        const bend = new THREE.Quaternion().setFromAxisAngle(axis, knee);
        const shinWorld = bend.clone().multiply(leg.shinQ);
        const swung = c.clone().sub(b).applyQuaternion(bend).add(b).sub(a);
        if (swung.lengthSq() < 1e-8) return;
        const swing = new THREE.Quaternion().setFromUnitVectors(swung.normalize(), to.clone().normalize());
        const thighWorld = swing.multiply(leg.thighQ);
        // Blended as a result: the reach limit bends a straight knee even
        // with the target on the ankle, which would pop at the end of a fade.
        const thigh = thighWorld.clone().premultiply(this.hips.quaternion.clone().invert());
        const shin = shinWorld.clone().premultiply(thighWorld.clone().invert());
        leg.thigh.quaternion.slerp(thigh, this.weight);
        leg.shin.quaternion.slerp(shin, this.weight);
    }

    /** Rotation about `pivot` that lifts `local` (in `rotation`'s frame) out
     *  of the floor, identity when it isn't under it. */
    _ground(pivot, rotation, local) {
        const THREE = this.THREE;
        const out = new THREE.Quaternion();
        const v = local.clone().applyQuaternion(rotation);
        const floorBelow = -(pivot.y + v.y);
        if (floorBelow <= 1e-5) return out;
        const length = v.length();
        const height = -pivot.y;
        const across = Math.hypot(v.x, v.z);
        if (length < 0.0001 || Math.abs(height) >= length * 0.999 || across < 0.0001) return out;
        const scale = Math.sqrt(length * length - height * height) / across;
        const lifted = new THREE.Vector3(v.x * scale, height, v.z * scale).divideScalar(length);
        out.setFromUnitVectors(v.divideScalar(length), lifted);
        const angle = 2 * Math.acos(clamp(Math.abs(out.w), -1, 1));
        if (angle > MAX_GROUND_ANGLE) out.slerp(new THREE.Quaternion(), 1 - MAX_GROUND_ANGLE / angle);
        const ease = smoothstep(clamp(floorBelow / GROUND_EASE_BAND, 0, 1));
        return new THREE.Quaternion().slerp(out, this.weight * ease);
    }

    _placeFoot(leg) {
        const THREE = this.THREE;
        this._forward(leg);
        const lift = this._ground(leg.c, leg.footTarget, leg.heel);
        const foot = lift.multiply(leg.footTarget);
        const shinWorld = new THREE.Quaternion().copy(leg.shinQ);
        leg.foot.quaternion.copy(shinWorld).invert().multiply(foot);
        if (!leg.toes) return;
        const ball = leg.ballOffset.clone().applyQuaternion(foot).add(leg.c);
        const toeWorld = foot.clone().multiply(leg.toes.quaternion);
        const toeLift = this._ground(ball, toeWorld, leg.toeTip);
        leg.toes.quaternion.copy(foot).invert().multiply(toeLift.multiply(toeWorld));
    }

    /** After the pose is on the bones. `feet` is the model rig's left lift,
     *  left speed, right lift, right speed, in leg lengths. */
    update(dt, weight, feet) {
        if (!this.ok || dt <= 0) return;
        this.weight = weight;
        this.legs.forEach((leg, i) => {
            this._forward(leg);
            this._contact(leg, feet[i * 2], feet[i * 2 + 1], dt);
            this._targets(leg, feet[i * 2]);
        });
        this._assistPelvis(dt);
        for (const leg of this.legs) {
            this._forward(leg);
            this._solve(leg);
            this._placeFoot(leg);
        }
    }
}
