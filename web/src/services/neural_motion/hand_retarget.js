/** Finger retarget between a motion model's rest hand and the avatar's.
 *
 *  A model may rotate its fingers about its own rest hand (one with fanned
 *  fingers, where a VRoid hand rests straight), and then names that rest as
 *  `hand_rest`: per finger bone, the direction to its next bone, VRM 1.0
 *  axes. Copied as is, a curl about a fanned finger's axis bends a straight
 *  one partly sideways.
 *
 *  Per finger bone j, C_j is the smallest rotation taking the avatar's rest
 *  bone direction onto the model's, and the avatar's rotation is
 *      q'_j = C_parent⁻¹ · q_j · C_j        (C = identity at the hand)
 *  so every finger bone points where the model's does. Distal bones have no
 *  next bone on either rig and take their parent's C. The avatar's rest is
 *  its normalized rig's (three-vrm), turned into VRM 1.0 axes for 0.x rigs
 *  the way the renderer turns every rotation (x, z negated). */

const FINGERS = {
    Thumb: ["Metacarpal", "Proximal", "Distal"],
    Index: ["Proximal", "Intermediate", "Distal"],
    Middle: ["Proximal", "Intermediate", "Distal"],
    Ring: ["Proximal", "Intermediate", "Distal"],
    Little: ["Proximal", "Intermediate", "Distal"],
};

/** Map bone name -> { c, cInv, p, pInv } for the avatar (null when the model
 *  names no rest hand). */
export function handCorrections(THREE, humanoid, flip, handRest) {
    if (!handRest || !humanoid) return null;
    const rest = humanoid.normalizedRestPose;
    const C = {};
    const parentOf = {};
    for (const side of ["left", "right"]) {
        for (const [finger, segs] of Object.entries(FINGERS)) {
            const names = segs.map((s) => `${side}${finger}${s}`);
            for (let k = 0; k < 2; k++) {
                const s = handRest[names[k]];
                const child = rest[names[k + 1]]?.position;
                if (!s || !child) continue;
                const t = new THREE.Vector3(flip ? -child[0] : child[0], child[1], flip ? -child[2] : child[2]);
                if (t.lengthSq() < 1e-12) continue;
                C[names[k]] = new THREE.Quaternion().setFromUnitVectors(t.normalize(),
                    new THREE.Vector3(...s).normalize());
            }
            if (C[names[1]]) C[names[2]] = C[names[1]];
            parentOf[names[1]] = names[0];
            parentOf[names[2]] = names[1];
        }
    }
    const out = new Map();
    for (const [name, c] of Object.entries(C)) {
        const p = C[parentOf[name]] || new THREE.Quaternion();
        out.set(name, { c, cInv: c.clone().invert(), p, pInv: p.clone().invert() });
    }
    return out;
}

/** Model rotation -> avatar rotation (both VRM 1.0 axes), in place. */
export function toAvatar(q, fix) {
    return q.premultiply(fix.pInv).multiply(fix.c);
}

/** Avatar rotation -> model rotation (both VRM 1.0 axes), in place. */
export function toModel(q, fix) {
    return q.premultiply(fix.p).multiply(fix.cInv);
}
