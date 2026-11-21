// Face the viewer: a character turns head and shoulders toward you when you
// come close, over whatever is posing them (the idle, a clip, the neural
// model mid-line). The look-at layer game characters get — Unity's humanoid
// LookAt and RootMotion's Final IK LookAtIK are the two common
// implementations — laid on last, so the motion underneath keeps playing
// relative to a torso that is now turned your way.
//
// Measured against the BODY's facing (the hips), not the head's: the share
// below is of where you stand relative to their body, so a nod or head turn
// the motion underneath makes rides on top unchanged instead of being
// cancelled out. Eyes are not touched: the VRM look-at already holds eye
// contact with the camera and takes whatever is left over.
//
// Numbers:
// - Weights are Final IK IKSolverLookAt's field defaults: bodyWeight 0.5,
//   headWeight 0.5, with the spine share spread over the spine bones by its
//   default spineWeightCurve (0.3 at the first bone → 1 at the last).
//   https://www.root-motion.com/finalikdox/html/class_root_motion_1_1_final_i_k_1_1_i_k_solver_look_at.html
// - Range: Unity's default clampWeight 0.5 = "half of the possible range
//   (180 degrees)", i.e. up to 90° either side of facing. Past 90° the turn
//   holds at the limit and the layer fades out toward 180°, so someone
//   walking behind them doesn't get a head twisted round to the shoulder.
//   https://docs.unity3d.com/520/Documentation/ScriptReference/Animator.SetLookAtWeight.html
// - Distance: Hall's proxemics. Full attention inside the far phase of
//   social distance (≤ 3.7 m, 12 ft — the range conversation happens in),
//   fading out across the close phase of public distance (to 7.6 m, 25 ft).
//   Hall, "The Hidden Dimension" (1966); https://en.wikipedia.org/wiki/Proxemics
// - Easing: 0.5 s to 99%, the aim damping the auto camera uses
//   (Cinemachine's default), so turns read as attention, not a snap.

const BODY_WEIGHT = 0.5;
const HEAD_WEIGHT = 0.5;
const SPINE_CURVE = [0.3, 1];            // first → last spine bone
const MAX_YAW = Math.PI / 2;             // clampWeight 0.5
const MAX_PITCH = Math.PI / 2;
const NEAR_M = 3.7;                      // social distance, far phase
const FAR_M = 7.6;                       // public distance, close phase
const EASE_S = 0.5;

// The switch, per browser: the Movement panel and the VR panel share it.
// On unless switched off.
const PREF_KEY = "rexclaw.face_viewer";

export function loadFaceViewerPref() {
    try { return localStorage.getItem(PREF_KEY) !== "0"; } catch (e) { return true; }
}

export function saveFaceViewerPref(on) {
    try { localStorage.setItem(PREF_KEY, on ? "1" : "0"); } catch (e) { /* private mode */ }
}

const SPINE = ["spine", "chest", "upperChest"];
const HEAD = ["neck", "head"];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t) => t * t * (3 - 2 * t);

export class FaceViewer {
    constructor(THREE) {
        this.THREE = THREE;
        this._up = new THREE.Vector3(0, 1, 0);
        this._axis = new THREE.Vector3();
        this._v = new THREE.Vector3();
        this._head = new THREE.Vector3();
        this._q = new THREE.Quaternion();
        this._r = new THREE.Quaternion();
        this._p = new THREE.Quaternion();
        this._pi = new THREE.Quaternion();
    }

    /** One frame for one character. `viewer` is the viewer's eye in world
     *  space, or null; `on` false (the switch is off, or something that
     *  must not be turned — a dance, a tool motion — owns the body) eases
     *  the layer out rather than cutting it. Call after every other layer
     *  has posed the bones and before vrm.update. */
    apply(actor, viewer, delta, on) {
        const humanoid = actor.vrm?.humanoid;
        // Not `_faceViewer`: the base actor is the renderer, which keeps
        // this class's instance under that name.
        const st = (actor._faceViewerState ||= { w: 0, yaw: 0, pitch: 0, pre: new Map(), post: new Map(), vrm: null });
        if (st.vrm !== actor.vrm) {
            st.vrm = actor.vrm;
            st.pre.clear();
            st.post.clear();
            st.w = 0;
        }
        if (!humanoid) return;
        const bones = this._chain(humanoid);
        // A bone nothing re-posed since our last write still holds our
        // turn: put it back first, or the turn would pile up frame on frame.
        for (const [name, node] of bones) {
            const post = st.post.get(name);
            if (post && node.quaternion.equals(post)) node.quaternion.copy(st.pre.get(name));
        }

        let wantW = 0;
        let yaw = 0;
        let pitch = 0;
        const hips = humanoid.getNormalizedBoneNode("hips");
        const headNode = humanoid.getNormalizedBoneNode("head");
        if (on && viewer && hips && headNode) {
            headNode.getWorldPosition(this._head);
            const dx = viewer.x - this._head.x;
            const dz = viewer.z - this._head.z;
            const dist = Math.hypot(dx, dz);
            const near = dist <= NEAR_M ? 1 : dist >= FAR_M ? 0 : smooth(1 - (dist - NEAR_M) / (FAR_M - NEAR_M));
            // Body facing: the hips' world rotation applied to the rest
            // facing (+Z turned by the walk yaw, see _setMoveYaw), so a
            // neural shuffle that turned the hips counts.
            const facing = this._bodyYaw(actor, hips);
            const off = wrap(Math.atan2(dx, dz) - facing);
            const behind = Math.abs(off) <= MAX_YAW ? 1
                : Math.max(0, Math.cos(((Math.abs(off) - MAX_YAW) / (Math.PI - MAX_YAW)) * (Math.PI / 2)));
            wantW = near * behind;
            yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, off));
            pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(viewer.y - this._head.y, Math.max(dist, 1e-3))));
        }
        const k = 1 - Math.exp(-4.605 * (delta || 0.016) / EASE_S);
        st.w += (wantW - st.w) * k;
        // Angles only move while there's someone to look at, so fading out
        // returns along the last direction instead of swinging through 0.
        if (wantW > 0) {
            st.yaw += wrap(yaw - st.yaw) * k;
            st.pitch += (pitch - st.pitch) * k;
        }
        if (st.w < 0.002) {
            st.pre.clear();
            st.post.clear();
            return;
        }

        // Shares of the angle: the spine takes bodyWeight of it, spread
        // along the curve; the neck and head take headWeight of the rest.
        const spine = bones.filter(([n]) => SPINE.includes(n));
        const head = bones.filter(([n]) => HEAD.includes(n));
        const curve = spine.map((_, i) => SPINE_CURVE[0]
            + (SPINE_CURVE[1] - SPINE_CURVE[0]) * (spine.length > 1 ? i / (spine.length - 1) : 1));
        const curveSum = curve.reduce((a, b) => a + b, 0) || 1;
        const shares = new Map();
        spine.forEach(([n], i) => shares.set(n, BODY_WEIGHT * curve[i] / curveSum));
        const headShare = HEAD_WEIGHT * (1 - (spine.length ? BODY_WEIGHT : 0));
        head.forEach(([n]) => shares.set(n, headShare / head.length));

        // Pitch is the head's alone: tipping the spine at someone shorter
        // reads as a bow. Its axis lies across the line to the viewer.
        const pitchShare = (BODY_WEIGHT + headShare) / (head.length || 1);
        const faceYaw = this._bodyYaw(actor, hips) + st.yaw;
        this._axis.set(Math.sin(faceYaw), 0, Math.cos(faceYaw)).cross(this._up).normalize();

        for (const [name, node] of bones) {
            st.pre.set(name, (st.pre.get(name) || new this.THREE.Quaternion()).copy(node.quaternion));
            const a = (shares.get(name) || 0) * st.yaw * st.w;
            const b = HEAD.includes(name) ? pitchShare * st.pitch * st.w : 0;
            // World rotation R (the turn, then the tilt about the axis across
            // the turned facing) into the bone's local frame: P⁻¹ R P q.
            this._r.setFromAxisAngle(this._axis, b).multiply(this._q.setFromAxisAngle(this._up, a));
            node.parent.getWorldQuaternion(this._p);
            this._pi.copy(this._p).invert();
            node.quaternion.premultiply(this._q.copy(this._pi).multiply(this._r).multiply(this._p));
            st.post.set(name, (st.post.get(name) || new this.THREE.Quaternion()).copy(node.quaternion));
        }
    }

    /** A bone as the frame posed it under this layer, for anything that
     *  reads the pose to carry it on (the neural model's seed) — null when
     *  the layer isn't turning it. */
    preLayer(actor, name) {
        return actor._faceViewerState?.pre.get(name) || null;
    }

    _chain(humanoid) {
        const out = [];
        for (const name of [...SPINE, ...HEAD]) {
            const node = humanoid.getNormalizedBoneNode(name);
            if (node?.parent) out.push([name, node]);
        }
        return out;
    }

    _bodyYaw(actor, hips) {
        const yaw = actor._moveYaw || 0;
        // Rest facing in world is +Z turned by the walk yaw; the hips' turn
        // away from rest is their world rotation against their parent's
        // (the normalized root, identity at rest).
        hips.getWorldQuaternion(this._q);
        hips.parent?.getWorldQuaternion(this._p);
        this._pi.copy(this._p).invert().premultiply(this._q);   // q · p⁻¹
        this._v.set(Math.sin(yaw), 0, Math.cos(yaw)).applyQuaternion(this._pi);
        return Math.atan2(this._v.x, this._v.z);
    }
}
