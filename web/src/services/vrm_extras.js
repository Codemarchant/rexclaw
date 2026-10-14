/**
 * SOULFLAME_vrm_extras: optional hints that SoulFlame VRM Exporter writes
 * into a VRM it converts from a VRChat avatar. Other VRM apps ignore them.
 * The format follows the exporter's SoulFlameExtras.cs and
 * VrmFileValidator.Extras.cs (spec 1.0). This file uses three of its parts:
 *
 * - eyelids: the lookUp / lookDown expressions are eyelid shapes. They
 *   follow the eyes' vertical turn and reach full weight at
 *   `fullWeightDegrees`. A blink takes them along as it closes the eyes.
 * - idleLoops: glTF animations of non-humanoid nodes (ears, tails,
 *   props) that the avatar's FX layers loop at rest in VRChat.
 * - animatedSpringJoints: spring joints whose rest is the animated pose
 *   (PhysBone "Is Animated"). Their rest is re-read from those loops each
 *   frame.
 *
 * The fourth part, physicalMaterials (glass twins), is not used. Those
 * materials keep their MToon look.
 */

export const SOULFLAME_EXTRAS = "SOULFLAME_vrm_extras";

const index = (v, count) => Number.isInteger(v) && v >= 0 && v < count;
const degrees = (side) => {
    const d = side?.fullWeightDegrees;
    return typeof d === "number" && d > 0 && d <= 90 ? d : null;
};

/** The hints in a parsed glTF JSON, or null when it has none (or another
 *  spec version). Entries that point at nothing are dropped. */
export function readVrmExtras(json) {
    const ext = json?.extensions?.[SOULFLAME_EXTRAS];
    if (!ext || typeof ext !== "object" || ext.specVersion !== "1.0") return null;
    const up = degrees(ext.eyelids?.lookUp);
    const down = degrees(ext.eyelids?.lookDown);
    const animations = json.animations?.length || 0;
    const nodes = json.nodes?.length || 0;
    const idleLoops = [...new Set((ext.idleLoops || []).map((l) => l?.animation))]
        .filter((i) => index(i, animations));
    const springJoints = new Set((ext.animatedSpringJoints || []).filter((n) => index(n, nodes)));
    return { eyelids: up || down ? { up, down } : null, idleLoops, springJoints };
}

/** Starts a loaded avatar's hints. Its idle loops play on `mixer` at full
 *  weight beside every other clip, since they touch no humanoid bone. The
 *  marked spring joints have their rest pose captured. Call after
 *  springBoneManager.reset(). Returns the per-avatar state, or null. */
export function startVrmExtras(gltf, vrm, mixer, THREE) {
    const extras = readVrmExtras(gltf.parser?.json);
    if (!extras) return null;
    const idle = extras.idleLoops.map((i) => gltf.animations?.[i]).filter(Boolean).map((clip) => {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        return action.play();
    });
    const rest = [];
    if (extras.springJoints.size && idle.length) {
        for (const joint of vrm.springBoneManager?.joints || []) {
            const node = gltf.parser.associations.get(joint.bone)?.nodes;
            if (!extras.springJoints.has(node)) continue;
            rest.push({
                joint,
                position: joint.bone.position.clone(),
                quaternion: joint.bone.quaternion.clone(),
                scale: joint.bone.scale.clone(),
            });
        }
    }
    return { eyelids: extras.eyelids, rest };
}

/** Before the mixer update: puts each marked spring bone back at its rest.
 *  A bone that no loop moves then doesn't carry the last frame's swing into
 *  its rest. */
export function restoreSpringRest(state) {
    for (const r of state?.rest || []) {
        r.joint.bone.position.copy(r.position);
        r.joint.bone.quaternion.copy(r.quaternion);
        r.joint.bone.scale.copy(r.scale);
    }
}

/** After the mixer update, before vrm.update: the animated pose becomes each
 *  marked joint's spring rest. three-vrm keeps the rest in the joint's
 *  private fields (3.5.5). These are the fields setInitState() writes, minus
 *  the tail reset, which would stop the swing. */
export function takeSpringRest(state) {
    for (const { joint } of state?.rest || []) {
        joint.bone.updateMatrix();
        joint._initialLocalMatrix.copy(joint.bone.matrix);
        joint._initialLocalRotation.copy(joint.bone.quaternion);
        const child = joint.child;
        if (child && !child.position.equals(joint._initialLocalChildPosition)) {
            joint._initialLocalChildPosition.copy(child.position);
            joint._boneAxis.copy(child.position).normalize();
        }
    }
}

/** Before the expression update: sets lookUp / lookDown from the gaze's
 *  vertical angle. three-vrm's pitch is in degrees, negative up. The
 *  weights shrink as a blink closes the eyes. */
export function applyEyelids(vrm, state) {
    const lids = state?.eyelids;
    const em = vrm.expressionManager;
    if (!lids || !em || !vrm.lookAt) return;
    const pitch = vrm.lookAt.pitch;
    const blink = Math.max(em.getValue("blink") || 0, em.getValue("blinkLeft") || 0, em.getValue("blinkRight") || 0);
    const open = 1 - Math.min(1, blink);
    if (lids.up) em.setValue("lookUp", Math.min(1, Math.max(0, -pitch) / lids.up) * open);
    if (lids.down) em.setValue("lookDown", Math.min(1, Math.max(0, pitch) / lids.down) * open);
}
