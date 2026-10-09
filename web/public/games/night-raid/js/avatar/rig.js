// Night Raid: bone helpers for the crew's work poses (from Night Helm's companion.js).
//
// Two-bone IK puts a hand on a point (a rammer, a pump handle, a line, a
// keg) over whatever clip is playing, bending the elbow toward a pole and
// blending with the clip by a weight; rotateInSpace / rotateWorld add a lean
// or a turn to a bone without detaching its children. Expressions are found
// by alias (VRM 1.0 presets, VRM 0.x and VRoid names).

import * as THREE from "three";

export const clamp = THREE.MathUtils.clamp;
export const deg = THREE.MathUtils.degToRad;
export const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const finite3 = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));

/** Expression names to try for each canonical emotion. */
export const EXPRESSIONS = {
  happy: ["happy", "joy", "Joy", "Fcl_ALL_Joy"],
  sad: ["sad", "sorrow", "Sorrow", "Fcl_ALL_Sorrow"],
  surprised: ["surprised", "Surprised", "Fcl_ALL_Surprised"],
  relaxed: ["relaxed", "fun", "Fun", "Fcl_ALL_Fun"],
  angry: ["angry", "Angry", "Fcl_ALL_Angry"],
  blink: ["blink", "Blink", "Fcl_EYE_Close"],
};
export const VISEMES = {
  aa: ["aa", "A", "viseme_aa", "Fcl_MTH_A", "mouth_a"],
  ih: ["ih", "I", "viseme_ih", "Fcl_MTH_I", "mouth_i"],
  ou: ["ou", "U", "viseme_ou", "Fcl_MTH_U", "mouth_u"],
  ee: ["ee", "E", "viseme_ee", "Fcl_MTH_E", "mouth_e"],
  oh: ["oh", "O", "viseme_oh", "Fcl_MTH_O", "mouth_o"],
};

/** First expression name the model actually has, from a list of aliases. */
export function findExpression(manager, aliases) {
  for (const name of aliases) if (manager?.getExpression?.(name)) return name;
  return null;
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _vd = new THREE.Vector3(), _ve = new THREE.Vector3(), _vf = new THREE.Vector3();

/** Multiply local quaternions from `stop` (exclusive) down to `node` (inclusive): node's orientation in stop's space. */
function chainQuat(node, stop, out) {
  out.identity();
  for (let n = node; n && n !== stop; n = n.parent) out.premultiply(n.quaternion);
  return out;
}

/** Rotate `bone` by `q`, expressed in `space` (the VRM's model space), keeping its children attached. */
export function rotateInSpace(bone, q, space) {
  if (!bone) return;
  const P = chainQuat(bone.parent, space, _q2);
  _q3.copy(P).invert().multiply(q).multiply(P);
  bone.quaternion.premultiply(_q3);
}

/** Rotate `bone` by the world-space rotation `q` (its world matrix must be current). */
export function rotateWorld(bone, q) {
  const P = bone.parent ? bone.parent.getWorldQuaternion(_q2) : _q2.identity();
  _q3.copy(P).invert().multiply(q).multiply(P);
  bone.quaternion.premultiply(_q3);
  bone.updateWorldMatrix(false, true);
}

/**
 * Two-bone IK: put `hand` at `target` (world), bending the elbow toward `pole`
 * (a world direction), then blend the result with the clip's pose by `w`.
 */
export function armIK(up, low, hand, target, pole, w) {
  if (!up || !low || !hand || w <= 0.001 || !finite3(target)) return;
  const q0u = _qa.copy(up.quaternion), q0l = _qb.copy(low.quaternion);
  up.updateWorldMatrix(true, true);
  const S = up.getWorldPosition(_v1), E = low.getWorldPosition(_v2), H = hand.getWorldPosition(_v3);
  const a = S.distanceTo(E), b = E.distanceTo(H);
  if (!(a > 1e-4 && b > 1e-4)) return;
  const toT = _v4.subVectors(target, S);
  const dist = clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const dir = toT.normalize();
  const cosA = clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const p = _v5.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (p.lengthSq() < 1e-8) return;
  p.normalize();
  const elbow = _ve.copy(S).addScaledVector(dir, a * cosA).addScaledVector(p, a * sinA);
  rotateWorld(up, _q1.setFromUnitVectors(_vd.subVectors(E, S).normalize(), _vf.subVectors(elbow, S).normalize()));
  const E2 = low.getWorldPosition(_v2), H2 = hand.getWorldPosition(_v3);
  rotateWorld(low, _q1.setFromUnitVectors(_vd.subVectors(H2, E2).normalize(), _vf.subVectors(target, E2).normalize()));
  if (w < 0.999) {
    _qc.copy(up.quaternion); up.quaternion.copy(q0u).slerp(_qc, w);
    _qc.copy(low.quaternion); low.quaternion.copy(q0l).slerp(_qc, w);
    up.updateWorldMatrix(false, true);
  }
}

/** +1 when raising rotation.z on the left upper arm lowers the hand (the rig's arm convention). */
export function armSign(vrm, lArm, lHand) {
  if (!lArm || !lHand) return 1;
  vrm.scene.updateMatrixWorld(true);
  const before = lHand.getWorldPosition(_v1).y;
  const saved = lArm.rotation.z;
  lArm.rotation.z = saved + 0.5;
  lArm.updateMatrixWorld(true);
  const after = lHand.getWorldPosition(_v2).y;
  lArm.rotation.z = saved;
  lArm.updateMatrixWorld(true);
  return after < before ? 1 : -1;
}
