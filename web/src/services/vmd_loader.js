/**
 * MMD motion (.vmd) → a three.js AnimationClip for a VRM humanoid.
 *
 * The clip uses the same track names createVRMAnimationClip produces
 * (`<normalized bone node>.quaternion`, hips `.position`), so the renderer
 * plays a converted dance exactly like a VRMA one.
 *
 * Format (little-endian): "Vocaloid Motion Data 0002" header (30 bytes),
 * model name (20), then bone keyframes of 111 bytes — name (15, Shift-JIS),
 * frame u32, position f32×3, rotation quaternion f32×4, 64 bytes of Bézier
 * interpolation — then morph (23 bytes), camera (61), light (28), shadow
 * (9) and IK on/off property frames. 30 frames per second. Each channel's
 * curve (X, Y, Z, rotation) is read at bytes 16k + {0, 4, 8, 12} as x1,
 * y1, x2, y2 in 0..127: the 16-byte rows repeat the table shifted by a byte,
 * and row 0's bytes 2-3 are overwritten by a physics flag, so reading
 * channel k from row k is the robust choice (mmd_tools does the same).
 *
 * Retargeting onto the VRM's normalized rig, whose bones have identity rest
 * rotations and world-aligned axes, like MMD bones:
 *   - handedness: position z → −z, quaternion (−x, −y, z, w) (three.js's
 *     MMD parser), which puts the model facing +Z like a VRM 1.0
 *   - hierarchy: 全ての親 · センター · グルーブ · 腰 · 下半身 → hips;
 *     上半身 is a sibling of 下半身 in MMD, so it is re-expressed under it;
 *     twist bones (腕捩, 手捩) fold into their parent
 *   - rest pose: MMD models stand in an A-pose, VRMs in a T-pose. The upper
 *     arm gets q·A and everything below it A⁻¹·q·A, with A the arm's rest
 *     tilt about Z (30° in vrm-dance-viewer, MIT; per-dance setting here)
 *   - scale: 1 MMD unit ≈ 8 cm (mmd_tools' default import scale), for a
 *     model ~20 units / 160 cm tall whose hip joint sits at ~0.53 of its
 *     height (Drillis & Contini 1966) → 0.85 m; offsets scale with the
 *     avatar's own hip height against that
 *   - legs: dances drive the feet with 足ＩＫ targets. Solved analytically
 *     (two-bone IK in the plane of the foot's forward direction, so the
 *     knee always bends forward), with the foot taking the IK bone's
 *     orientation. FK leg keys are used where the motion switches IK off.
 */

const FPS = 30;
const MMD_HIP_HEIGHT_M = 0.85;
const MMD_UNIT_M = 0.08;

// MMD bone name → VRM humanoid bone. Twist bones fold into their parent.
const BONE_MAP = {
    "上半身2": "chest", "上半身3": "upperChest", "首": "neck", "頭": "head",
    "左肩": "leftShoulder", "右肩": "rightShoulder",
    "左腕": "leftUpperArm", "右腕": "rightUpperArm",
    "左ひじ": "leftLowerArm", "右ひじ": "rightLowerArm",
    "左手首": "leftHand", "右手首": "rightHand",
    "左親指０": "leftThumbMetacarpal", "左親指１": "leftThumbProximal", "左親指２": "leftThumbDistal",
    "右親指０": "rightThumbMetacarpal", "右親指１": "rightThumbProximal", "右親指２": "rightThumbDistal",
    "左足": "leftUpperLeg", "右足": "rightUpperLeg",
    "左ひざ": "leftLowerLeg", "右ひざ": "rightLowerLeg",
    "左足首": "leftFoot", "右足首": "rightFoot",
    "左つま先": "leftToes", "右つま先": "rightToes",
};
for (const [jp, en] of [["人指", "Index"], ["中指", "Middle"], ["薬指", "Ring"], ["小指", "Little"]]) {
    for (const [side, s] of [["左", "left"], ["右", "right"]]) {
        BONE_MAP[`${side}${jp}１`] = `${s}${en}Proximal`;
        BONE_MAP[`${side}${jp}２`] = `${s}${en}Intermediate`;
        BONE_MAP[`${side}${jp}３`] = `${s}${en}Distal`;
    }
}
const ARM_CHAIN = {
    left: ["leftLowerArm", "leftHand", "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
        ...["Index", "Middle", "Ring", "Little"].flatMap((f) => [`left${f}Proximal`, `left${f}Intermediate`, `left${f}Distal`])],
    right: ["rightLowerArm", "rightHand", "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
        ...["Index", "Middle", "Ring", "Little"].flatMap((f) => [`right${f}Proximal`, `right${f}Intermediate`, `right${f}Distal`])],
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

let _sjis = null;
function sjis(bytes) {
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    _sjis ||= new TextDecoder("shift_jis");
    // A 15-byte name can be cut inside a two-byte character.
    return _sjis.decode(bytes.subarray(0, end)).replace(/�+$/, "");
}

export function parseVMD(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const magic = new TextDecoder("ascii").decode(u8.subarray(0, 20));
    if (!magic.startsWith("Vocaloid Motion Data")) throw new Error("Not an MMD motion file (.vmd).");
    let o = 30;
    const modelName = sjis(u8.subarray(o, o + 20));
    o += 20;
    const bones = new Map();
    const nBones = dv.getUint32(o, true); o += 4;
    let maxFrame = 0;
    for (let i = 0; i < nBones && o + 111 <= u8.length; i++) {
        const name = sjis(u8.subarray(o, o + 15));
        const frame = dv.getUint32(o + 15, true);
        const pos = [dv.getFloat32(o + 19, true), dv.getFloat32(o + 23, true), dv.getFloat32(o + 27, true)];
        let rot = [dv.getFloat32(o + 31, true), dv.getFloat32(o + 35, true),
            dv.getFloat32(o + 39, true), dv.getFloat32(o + 43, true)];
        if (!rot[0] && !rot[1] && !rot[2] && !rot[3]) rot = [0, 0, 0, 1];
        const ip = u8.subarray(o + 47, o + 111);
        const curves = [0, 1, 2, 3].map((k) => [ip[16 * k] / 127, ip[16 * k + 4] / 127,
            ip[16 * k + 8] / 127, ip[16 * k + 12] / 127]);
        o += 111;
        if (!bones.has(name)) bones.set(name, []);
        bones.get(name).push({ frame, pos, rot, curves });
        if (frame > maxFrame) maxFrame = frame;
    }
    // Morphs, camera, light and shadow are skipped over; the IK switches
    // after them decide where the legs are FK.
    const ikOff = new Map();   // IK bone name → [[frame, enabled]]
    try {
        const nMorph = dv.getUint32(o, true); o += 4 + nMorph * 23;
        const nCam = dv.getUint32(o, true); o += 4 + nCam * 61;
        const nLight = dv.getUint32(o, true); o += 4 + nLight * 28;
        const nShadow = dv.getUint32(o, true); o += 4 + nShadow * 9;
        const nProp = dv.getUint32(o, true); o += 4;
        for (let i = 0; i < nProp; i++) {
            const frame = dv.getUint32(o, true); o += 4;
            o += 1;   // visible
            const nIk = dv.getUint32(o, true); o += 4;
            for (let k = 0; k < nIk; k++) {
                const name = sjis(u8.subarray(o, o + 20));
                const on = u8[o + 20] !== 0;
                o += 21;
                if (!ikOff.has(name)) ikOff.set(name, []);
                ikOff.get(name).push([frame, on]);
            }
        }
    } catch (e) { /* trailing sections are optional */ }
    for (const keys of bones.values()) keys.sort((a, b) => a.frame - b.frame);
    for (const keys of ikOff.values()) keys.sort((a, b) => a[0] - b[0]);
    return { modelName, bones, maxFrame, ikSwitches: ikOff };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** MMD Bézier: control points (x1,y1), (x2,y2) in 0..1 → eased fraction. */
function bezier(c, x) {
    const [x1, y1, x2, y2] = c;
    if (x1 === y1 && x2 === y2) return x;          // linear
    let lo = 0, hi = 1, s = x;
    for (let i = 0; i < 16; i++) {
        const inv = 1 - s;
        const bx = 3 * inv * inv * s * x1 + 3 * inv * s * s * x2 + s * s * s;
        if (Math.abs(bx - x) < 1e-5) break;
        if (bx < x) lo = s; else hi = s;
        s = (lo + hi) / 2;
    }
    const inv = 1 - s;
    return 3 * inv * inv * s * y1 + 3 * inv * s * s * y2 + s * s * s;
}

function makeSampler(THREE, keys) {
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    let seg = 0;
    return (frame, outPos, outQuat) => {
        if (!keys || !keys.length) {
            outPos.set(0, 0, 0);
            outQuat.identity();
            return;
        }
        if (frame <= keys[0].frame) {
            outPos.fromArray(keys[0].pos);
            outQuat.fromArray(keys[0].rot);
            return;
        }
        const last = keys[keys.length - 1];
        if (frame >= last.frame) {
            outPos.fromArray(last.pos);
            outQuat.fromArray(last.rot);
            return;
        }
        if (seg >= keys.length - 1 || keys[seg].frame > frame) seg = 0;
        while (seg < keys.length - 2 && keys[seg + 1].frame <= frame) seg++;
        const a = keys[seg], b = keys[seg + 1];
        // The curve stored on a key shapes the segment that ends at it.
        const x = (frame - a.frame) / Math.max(1, b.frame - a.frame);
        outPos.set(
            a.pos[0] + (b.pos[0] - a.pos[0]) * bezier(b.curves[0], x),
            a.pos[1] + (b.pos[1] - a.pos[1]) * bezier(b.curves[1], x),
            a.pos[2] + (b.pos[2] - a.pos[2]) * bezier(b.curves[2], x));
        qa.fromArray(a.rot);
        qb.fromArray(b.rot);
        outQuat.slerpQuaternions(qa, qb, bezier(b.curves[3], x));
    };
}

function ikEnabledAt(switches, frame) {
    if (!switches || !switches.length) return true;
    let on = true;
    for (const [f, enabled] of switches) {
        if (f <= frame) on = enabled; else break;
    }
    return on;
}

// ---------------------------------------------------------------------------
// Retargeting
// ---------------------------------------------------------------------------

/** Build the clip. `armAngleDeg`: the MMD model's rest arm tilt. */
export function vmdToClip(THREE, vmd, vrm, { armAngleDeg = 30, name = "vmd" } = {}) {
    const h = vrm.humanoid;
    const vrm0 = vrm.meta?.metaVersion === "0";
    const node = (b) => h.getNormalizedBoneNode?.(b) || null;
    const has = (b) => !!node(b);
    // Rest positions (model space, normalized rig: sum of local offsets),
    // in VRM 1.0 facing (+Z) whatever the model's version.
    const rest = {};
    const restLocal = h.normalizedRestPose || {};
    const parentOf = {
        hips: null, spine: "hips", chest: "spine", upperChest: "chest", neck: "upperChest", head: "neck",
        leftUpperLeg: "hips", leftLowerLeg: "leftUpperLeg", leftFoot: "leftLowerLeg", leftToes: "leftFoot",
        rightUpperLeg: "hips", rightLowerLeg: "rightUpperLeg", rightFoot: "rightLowerLeg", rightToes: "rightFoot",
    };
    const restPos = (b) => {
        if (rest[b]) return rest[b];
        const p = restLocal[b]?.position || node(b)?.position?.toArray() || [0, 0, 0];
        let v = new THREE.Vector3(...p);
        if (vrm0) v.set(-v.x, v.y, -v.z);
        let par = parentOf[b];
        while (par && !has(par)) par = parentOf[par];
        if (par) v.add(restPos(par));
        rest[b] = v;
        return v;
    };
    const H = restPos("hips");
    const scale = MMD_UNIT_M * Math.max(0.3, H.y) / MMD_HIP_HEIGHT_M;
    const legs = {};
    for (const side of ["left", "right"]) {
        const UL = restPos(`${side}UpperLeg`), LL = restPos(`${side}LowerLeg`), F = restPos(`${side}Foot`);
        legs[side] = { UL, LL, F, a: UL.distanceTo(LL), b: LL.distanceTo(F),
            u0: LL.clone().sub(UL).normalize(), v0: F.clone().sub(LL).normalize() };
    }

    // Some motions spell the IK bones with half-width letters.
    const keysOf = (jp) => vmd.bones.get(jp) || vmd.bones.get(jp.replace("ＩＫ", "IK"));
    const samplers = {};
    const get = (jp) => (samplers[jp] ||= makeSampler(THREE, keysOf(jp)));
    const hasKeys = (jp) => (keysOf(jp) || []).length > 0;
    const jpOf = Object.fromEntries(Object.entries(BONE_MAP).map(([jp, bone]) => [bone, jp]));
    const conv = (q) => q.set(-q.x, -q.y, q.z, q.w);       // MMD → three (left → right handed)
    const convP = (p) => p.set(p.x, p.y, -p.z);
    const theta = armAngleDeg * Math.PI / 180;
    const A = {
        left: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -theta),
        right: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), theta),
    };
    const Ainv = { left: A.left.clone().invert(), right: A.right.clone().invert() };

    const nFrames = vmd.maxFrame + 1;
    const times = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) times[f] = f / FPS;
    const out = {};              // vrm bone → Float32Array quats
    const want = (b) => has(b) && (out[b] ||= new Float32Array(nFrames * 4));
    const hipsPos = new Float32Array(nFrames * 3);

    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    const pr = new THREE.Vector3(), qr = new THREE.Quaternion();
    const pc = new THREE.Vector3(), qc = new THREE.Quaternion();
    const pg = new THREE.Vector3(), qg = new THREE.Quaternion();
    const qw = new THREE.Quaternion(), qlow = new THREE.Quaternion(), qup = new THREE.Quaternion();
    const qtmp = new THREE.Quaternion(), qtmp2 = new THREE.Quaternion();
    const qs = {};
    const tmpV = new THREE.Vector3();
    const put = (b, f, quat) => {
        if (!want(b)) return;
        let x = quat.x, y = quat.y, z = quat.z, w = quat.w;
        if (vrm0) { x = -x; z = -z; }
        const arr = out[b];
        arr[f * 4] = x; arr[f * 4 + 1] = y; arr[f * 4 + 2] = z; arr[f * 4 + 3] = w;
    };
    const local = (jp, f, quat) => {
        get(jp)(f, tmpV, quat);
        return conv(quat);
    };

    // Rotation that turns rest frame (u0, forward0) into (u1, forward1).
    const basis = (u, fwd) => {
        const y = u.clone().normalize();
        const z = fwd.clone().sub(y.clone().multiplyScalar(fwd.dot(y)));
        if (z.lengthSq() < 1e-8) z.set(0, 0, 1).sub(y.clone().multiplyScalar(y.z));
        z.normalize();
        const x = new THREE.Vector3().crossVectors(y, z);
        return new THREE.Matrix4().makeBasis(x, y, z);
    };
    const fwd0 = new THREE.Vector3(0, 0, 1);
    const restBasis = {};
    for (const side of ["left", "right"]) {
        restBasis[side] = {
            thigh: basis(legs[side].u0, fwd0).invert(),
            shin: basis(legs[side].v0, fwd0).invert(),
        };
    }
    const m4 = new THREE.Matrix4();

    for (let f = 0; f < nFrames; f++) {
        // Root chain → hips.
        get("全ての親")(f, pr, qr); convP(pr); conv(qr);
        get("センター")(f, pc, qc); convP(pc); conv(qc);
        get("グルーブ")(f, pg, qg); convP(pg); conv(qg);
        local("腰", f, qw);
        local("下半身", f, qlow);
        local("上半身", f, qup);
        const center = qr.clone().multiply(qc).multiply(qg).multiply(qw);
        const hipsWorld = center.clone().multiply(qlow);
        // Hips position: root offset + the centre's translations, pivoting
        // about the hips' rest position.
        const off = pc.clone().add(pg.clone().applyQuaternion(qc)).multiplyScalar(scale);
        const hp = H.clone().add(off).applyQuaternion(qr).add(pr.clone().multiplyScalar(scale));
        let hx = hp.x, hz = hp.z;
        if (vrm0) { hx = -hx; hz = -hz; }
        hipsPos[f * 3] = hx; hipsPos[f * 3 + 1] = hp.y; hipsPos[f * 3 + 2] = hz;
        put("hips", f, hipsWorld);
        // Spine chain: 上半身 re-expressed under 下半身.
        const spine = qlow.clone().invert().multiply(qup);
        const q2 = local("上半身2", f, qtmp.identity());
        if (has("chest")) {
            put("spine", f, spine);
            if (has("upperChest") && hasKeys("上半身3")) {
                put("chest", f, q2);
                put("upperChest", f, local("上半身3", f, qtmp2.identity()));
            } else {
                put("chest", f, q2);
            }
        } else {
            put("spine", f, spine.multiply(q2));
        }
        put("neck", f, local("首", f, q));
        put("head", f, local("頭", f, q));
        // Arms.
        for (const side of ["left", "right"]) {
            const S = side === "left" ? "左" : "右";
            const shoulder = local(`${S}肩`, f, qs.sh ||= new THREE.Quaternion());
            const arm = local(`${S}腕`, f, qs.arm ||= new THREE.Quaternion())
                .multiply(local(`${S}腕捩`, f, qtmp.identity()));
            const armA = arm.clone().multiply(A[side]);
            if (has(`${side}Shoulder`)) {
                put(`${side}Shoulder`, f, shoulder);
                put(`${side}UpperArm`, f, armA);
            } else {
                put(`${side}UpperArm`, f, shoulder.clone().multiply(armA));
            }
            const elbow = local(`${S}ひじ`, f, qs.el ||= new THREE.Quaternion())
                .multiply(local(`${S}手捩`, f, qtmp.identity()));
            put(`${side}LowerArm`, f, Ainv[side].clone().multiply(elbow).multiply(A[side]));
            for (const bone of ARM_CHAIN[side].slice(1)) {
                const jp = jpOf[bone];
                if (!jp) continue;
                put(bone, f, Ainv[side].clone().multiply(local(jp, f, qtmp)).multiply(A[side]));
            }
        }
        // Legs: IK when the motion drives the IK bone and hasn't switched it off.
        for (const side of ["left", "right"]) {
            const S = side === "left" ? "左" : "右";
            const ikName = `${S}足ＩＫ`;
            const L = legs[side];
            const useIk = hasKeys(ikName) && ikEnabledAt(
                vmd.ikSwitches.get(ikName) || vmd.ikSwitches.get(ikName.replace("ＩＫ", "IK")), f);
            if (!useIk) {
                put(`${side}UpperLeg`, f, local(`${S}足`, f, q));
                put(`${side}LowerLeg`, f, local(`${S}ひざ`, f, q));
                put(`${side}Foot`, f, local(`${S}足首`, f, q));
                continue;
            }
            const pik = new THREE.Vector3(), qik = new THREE.Quaternion();
            get(ikName)(f, pik, qik); convP(pik); conv(qik);
            const ikWorld = qr.clone().multiply(qik);
            const target = L.F.clone().add(pik.multiplyScalar(scale)).applyQuaternion(qr).add(pr.clone().multiplyScalar(scale));
            // Hip joint in the world.
            const hipJoint = L.UL.clone().sub(H).applyQuaternion(hipsWorld).add(hp);
            const toT = target.clone().sub(hipJoint);
            let d = toT.length();
            const a = L.a, b = L.b;
            d = Math.min(Math.max(d, Math.abs(a - b) + 1e-4), a + b - 1e-4);
            const dir = toT.lengthSq() > 1e-10 ? toT.normalize() : new THREE.Vector3(0, -1, 0);
            // The knee bends towards where the foot points.
            const footFwd = fwd0.clone().applyQuaternion(ikWorld);
            let pole = footFwd.sub(dir.clone().multiplyScalar(footFwd.dot(dir)));
            if (pole.lengthSq() < 1e-8) pole = fwd0.clone().applyQuaternion(hipsWorld);
            pole.normalize();
            const x = (a * a - b * b + d * d) / (2 * d);
            const hgt = Math.sqrt(Math.max(0, a * a - x * x));
            const knee = hipJoint.clone().add(dir.clone().multiplyScalar(x)).add(pole.clone().multiplyScalar(hgt));
            const ankle = hipJoint.clone().add(dir.clone().multiplyScalar(d));
            const thighW = new THREE.Quaternion().setFromRotationMatrix(
                m4.copy(basis(knee.clone().sub(hipJoint), pole)).multiply(restBasis[side].thigh));
            const shinW = new THREE.Quaternion().setFromRotationMatrix(
                m4.copy(basis(ankle.clone().sub(knee), pole)).multiply(restBasis[side].shin));
            put(`${side}UpperLeg`, f, hipsWorld.clone().invert().multiply(thighW));
            put(`${side}LowerLeg`, f, thighW.clone().invert().multiply(shinW));
            put(`${side}Foot`, f, shinW.clone().invert().multiply(ikWorld));
        }
    }

    const tracks = [];
    for (const [bone, arr] of Object.entries(out)) {
        const n = node(bone);
        if (!n) continue;
        tracks.push(new THREE.QuaternionKeyframeTrack(`${n.name}.quaternion`, times, arr));
    }
    const hipsNode = node("hips");
    if (hipsNode) tracks.push(new THREE.VectorKeyframeTrack(`${hipsNode.name}.position`, times, hipsPos));
    return new THREE.AnimationClip(name, nFrames / FPS, tracks);
}
