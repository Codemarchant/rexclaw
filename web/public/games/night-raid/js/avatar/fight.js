// Rexmaw Raids: one of our crew in a boarding fight (boardfight.js directs; this moves and poses).
//
// It takes a member's body over (member.takeover) for the fight: their root rides the enemy ship's
// deck (the director's stage group), and every frame it moves them (runs on the walk clip, the
// swing across on a grapple line, a lunge, a knockdown) and poses the VRM over its idle by hand:
//
//   stance   the cutlass up in guard, the off hand out for balance, a lean in, a bob; the face set
//            (the legs keep the idle's footing).
//   swing    windup over the shoulder → a diagonal chop with the torso turning into it → recover.
//   stab     drawn back → a lunge and a thrust along the blade.
//   block    the blade across, high; a clash.
//   hit      thrown back a step, the sword arm flung out, a wince.
//   down     knocked flat (a topple away from the blow, a bounce, arms out on the deck), and getting
//            back up (knee, then up).
//   leap     the swing across: one hand high on the line, the cutlass out, knees tucked; a crouch on
//            landing.
//   heal     (Ara) kneeling beside someone, the tonic held out over them.
//   charge   (Rex) head down at a run, the shoulder leading.
//   cheer    the cutlass thrust up, a hurrah.
//
// The paper standee (Portrait setting) still moves, leaps and falls; only the VRM is posed.
//
// API: createFighter(member, {deckY}) → {id, begin(stage), end(parent, pos, yaw), moveTo(x, z, opts), stop(),
// faceTo(x, z), act(name, opts) → hit delay (s), down(dir), getup(), leap(from, to, opts), cheer(on),
// heal(at|null), charge(x, z), lookAt(world), x, z, y, yaw, isDown, busy, leaping, headWorld(out),
// handWorld(out), bladeWorld(out), chestWorld(out)}.

import * as THREE from "three";
import { armIK, rotateInSpace, clamp, damp, wrapAngle, finite3, UP } from "./rig.js";

const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Right hand [fwd, left, up] off the chest, the blade's direction [fwd, left, up], the left hand, spine lean / twist. */
const KEYS = {
  guard: { r: [0.3, -0.22, -0.06], b: [0.42, 0.05, 0.9], l: [0.24, 0.22, -0.2], lean: 0.12, twist: 0 },
  windup: { r: [-0.02, -0.34, 0.3], b: [-0.75, -0.15, 0.55], l: [0.32, 0.26, -0.05], lean: -0.04, twist: -0.42 },
  strike: { r: [0.56, 0.14, -0.3], b: [0.85, 0.3, -0.42], l: [-0.05, 0.32, -0.25], lean: 0.32, twist: 0.42 },
  draw: { r: [0.04, -0.3, -0.12], b: [1, 0, 0.08], l: [0.3, 0.22, -0.05], lean: 0.02, twist: -0.25 },
  thrust: { r: [0.74, -0.06, -0.04], b: [1, 0.04, 0.04], l: [-0.1, 0.3, -0.2], lean: 0.28, twist: 0.2 },
  block: { r: [0.38, -0.1, 0.22], b: [0.12, 1, 0.22], l: [0.36, 0.14, 0.18], lean: -0.06, twist: 0.08 },
  hit: { r: [0.08, -0.42, -0.12], b: [0.2, -0.55, 0.6], l: [0.05, 0.42, -0.1], lean: -0.32, twist: -0.25 },
  cheer: { r: [0.12, -0.18, 0.62], b: [0.08, 0, 1], l: [0.26, 0.24, -0.12], lean: -0.06, twist: 0 },
  heal: { r: [0.12, -0.26, -0.48], b: [0.55, -0.1, -0.6], l: [0.52, 0.06, -0.42], lean: 0.32, twist: 0.1 },
  charge: { r: [-0.04, -0.32, 0.02], b: [-0.75, -0.2, 0.45], l: [0.42, 0.14, -0.04], lean: 0.38, twist: 0.3 },
  leap: { r: [0.26, -0.46, 0.0], b: [0.55, -0.45, 0.55], l: [0.04, 0.08, 0.62], lean: 0.05, twist: 0 },
  getup: { r: [0.2, -0.3, -0.3], b: [0.6, 0, 0.6], l: [0.4, 0.25, -0.5], lean: 0.45, twist: 0 },
};
const ACTS = {
  swing: { dur: 0.62, keys: [[0, "guard"], [0.4, "windup"], [0.58, "strike"], [1, "guard"]], hitAt: 0.55, lunge: 0.32 },
  stab: { dur: 0.52, keys: [[0, "guard"], [0.36, "draw"], [0.56, "thrust"], [1, "guard"]], hitAt: 0.52, lunge: 0.45 },
  block: { dur: 0.48, keys: [[0, "guard"], [0.28, "block"], [0.7, "block"], [1, "guard"]], lunge: -0.1 },
  hit: { dur: 0.55, keys: [[0, "guard"], [0.16, "hit"], [1, "guard"]], lunge: -0.4 },
  stagger: { dur: 0.9, keys: [[0, "guard"], [0.2, "hit"], [0.6, "hit"], [1, "guard"]], lunge: -0.7 },
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _f = new THREE.Vector3(), _g = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

function lerp3(a, b, u, out) { out[0] = a[0] + (b[0] - a[0]) * u; out[1] = a[1] + (b[1] - a[1]) * u; out[2] = a[2] + (b[2] - a[2]) * u; return out; }
function blendKey(a, b, u, out) {
  lerp3(a.r, b.r, u, out.r); lerp3(a.b, b.b, u, out.b); lerp3(a.l, b.l, u, out.l);
  out.lean = a.lean + (b.lean - a.lean) * u; out.twist = a.twist + (b.twist - a.twist) * u;
  return out;
}
const copyKey = (k) => ({ r: [...k.r], b: [...k.b], l: [...k.l], lean: k.lean, twist: k.twist });

/**
 * @param {object} member  crew.js member (member.takeover)
 * @param {{deckY?: (x: number, z: number) => number}} [opts]  the stage's deck height (the enemy's deck)
 */
export function createFighter(member, { deckY = null } = {}) {
  let H = null, stage = null;
  const S = {
    x: 0, z: 0, y: 0, yaw: 0, yawGoal: 0, goal: null, vel: 0, run: false,
    act: null, lungeOff: 0, down: null, cheer: false, heal: null, charge: false, leap: null, dip: 0,
    pose: copyKey(KEYS.guard), tgt: copyKey(KEYS.guard), ikW: 0, faceT: 0, lookAt: null, looping: null,
  };

  const driver = {
    step(dt, h) { H = h; step(dt); },
    pose(st, dt, h) { H = h; poseVrm(st, dt); },
  };

  // ---- Movement --------------------------------------------------------------------------------

  function setLoop(tag, rate) {
    if (!H) return;
    if (S.looping === tag && tag) { H.V?.motions?.loopRate?.(tag, rate); return; }
    S.looping = tag;
    H.loop(tag, rate);
  }

  function step(dt) {
    const root = H.root, pose = H.pose;
    // The leap: along the arc, the line taut overhead; a crouch where they land.
    if (S.leap) {
      const L = S.leap;
      L.t += dt;
      const u = clamp(L.t / L.dur, 0, 1);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;          // ease in-out along the swing
      const k = 0.35 * u + 0.65 * e;
      const iu = 1 - k;
      root.position.set(
        iu * iu * L.from.x + 2 * iu * k * L.ctrl.x + k * k * L.to.x,
        iu * iu * L.from.y + 2 * iu * k * L.ctrl.y + k * k * L.to.y,
        iu * iu * L.from.z + 2 * iu * k * L.ctrl.z + k * k * L.to.z,
      );
      S.x = root.position.x; S.z = root.position.z;
      pose.rotation.set(0.25 * Math.sin(u * Math.PI), 0, 0);
      if (u >= 1) {
        S.leap = null;
        pose.rotation.set(0, 0, 0);
        S.dip = -0.22;
        L.onLand?.();
      }
      H.setYaw(S.yawGoal, true);
      return;
    }
    // Moving on her deck.
    if (S.goal && !S.down) {
      const dx = S.goal.x - S.x, dz = S.goal.z - S.z, d = Math.hypot(dx, dz);
      const r = S.goal.r ?? 0.15;
      const want = d > r ? Math.min(S.goal.speed ?? 2.6, d * 3.5) : 0;
      S.vel = damp(S.vel, want, S.charge ? 4 : 7, dt);
      if (d > 1e-3 && S.vel > 0.01) {
        const s = Math.min(d, S.vel * dt);
        S.x += (dx / d) * s; S.z += (dz / d) * s;
        if (!S.goal.keepFacing && d > 0.3) S.yawGoal = Math.atan2(dx, dz);
      }
      if (d <= r && S.vel < 0.08) { S.goal = null; S.charge = false; S.goalDone?.(); S.goalDone = null; }
    } else S.vel = damp(S.vel, 0, 9, dt);
    const moving = S.vel > 0.35 && !S.down;
    if (moving) setLoop("walk", clamp(S.vel / 1.35, 0.9, 2.4));
    else if (S.looping === "walk") setLoop(null);
    // The act's lunge (in along the facing, or back from a hit).
    const a = S.act;
    if (a) {
      a.t += dt;
      if (a.A.lunge) {
        const k = a.t / a.dur, at = a.A.hitAt ?? 0.2;
        const push = a.A.lunge * smooth(0, at, k) * (1 - smooth(at + 0.15, 1, k));
        const dy = push - S.lungeOff;
        S.lungeOff = push;
        S.x += Math.sin(S.yaw) * dy; S.z += Math.cos(S.yaw) * dy;
      }
      if (a.t >= a.dur) { S.act = null; S.lungeOff = 0; }
    }
    S.y = deckY ? deckY(S.x, S.z) : 0;
    root.position.set(S.x, S.y, S.z);
    // The knockdown: a topple about the feet away from the blow, a bounce; back up in two moves.
    const D = S.down;
    let tilt = 0, ax = 0, lift = 0;
    if (D) {
      D.t += dt;
      if (D.rising != null) {
        D.rising += dt;
        const k = smooth(0, 1.15, D.rising);
        tilt = D.th * (1 - k); ax = D.ax;
        lift = 0.13 * Math.sin(Math.min(Math.PI / 2, tilt));
        if (k >= 1) { S.down = null; S.dip = -0.12; }
      } else {
        if (!D.rest) {
          D.w += 9 * Math.sin(D.th + 0.12) * dt * 1.5;
          D.th += D.w * dt;
          if (D.th >= D.max) { D.th = D.max; D.w = -D.w * 0.24; if (Math.abs(D.w) < 0.35) { D.rest = true; D.w = 0; } }
          const sl = 0.5 * dt * (1 - smooth(0.4, 1.0, D.t));
          S.x += Math.sin(S.yaw + D.ax) * sl; S.z += Math.cos(S.yaw + D.ax) * sl;
        }
        tilt = D.th; ax = D.ax;
        lift = 0.13 * Math.sin(Math.min(Math.PI / 2, tilt));
      }
    }
    // The landing / getting-up dip eases back (exact decay: stable at any frame time).
    S.dip *= Math.exp(-7 * dt);
    if (tilt > 0) {
      _q1.setFromAxisAngle(_a.set(Math.cos(ax), 0, -Math.sin(ax)), tilt);
      pose.quaternion.copy(_q1);
    } else pose.rotation.set(0, 0, 0);
    pose.position.set(0, lift + Math.min(0, S.dip) * 0.6, 0);
    if (!S.down) S.yaw = S.yaw + wrapAngle(S.yawGoal - S.yaw) * (1 - Math.exp(-9 * dt));
    H.setYaw(S.yaw, true);
    // The face: set and determined; a wince on a hit; joy in a cheer.
    S.faceT -= dt;
    if (S.faceT <= 0) { S.faceT = 1.5; if (!S.cheer && !S.down) H.expression("angry", 0.3, 1.6); }
    if (S.lookAt && S.lookT > 0) { S.lookT -= dt; H.lookAt(S.lookAt, 0.6); }
  }

  // ---- The VRM's pose --------------------------------------------------------------------------

  function keyTarget() {
    const T = S.tgt;
    const a = S.act;
    if (S.leap) return Object.assign(T, copyKey(KEYS.leap));
    if (S.down) { return Object.assign(T, copyKey(S.down.rising != null && S.down.rising > 0.3 ? KEYS.getup : KEYS.hit)); }
    if (a) {
      const keys = a.A.keys, k = a.t / a.dur;
      let i = 0;
      while (i < keys.length - 2 && k > keys[i + 1][0]) i++;
      const [k0, n0] = keys[i], [k1, n1] = keys[i + 1];
      return blendKey(KEYS[n0], KEYS[n1], smooth(0, 1, (k - k0) / Math.max(1e-3, k1 - k0)), T);
    }
    if (S.cheer) return Object.assign(T, copyKey(KEYS.cheer));
    if (S.heal) return Object.assign(T, copyKey(KEYS.heal));
    if (S.charge) return Object.assign(T, copyKey(KEYS.charge));
    return Object.assign(T, copyKey(KEYS.guard));
  }

  /**
   * Undo last frame's relative changes (the hips dropped, the spine and chest turned) on bones the clips didn't
   * write again this frame: an idle without a hips translation or spine track would otherwise sink them into the
   * deck and spin the spine a little more every frame.
   */
  function restoreUntouched(st) {
    const M = st.__fightMod;
    if (!M) return;
    if (M.hips && st.hips && Math.abs(st.hips.position.y - M.hips[0]) < 1e-7) st.hips.position.y = M.hips[1];
    for (const [bone, after, before] of M.q) if (bone.quaternion.equals(after)) bone.quaternion.copy(before);
    st.__fightMod = null;
  }
  const noteBefore = (st, bone) => { if (!bone) return; (st.__fightPre || (st.__fightPre = new Map())).set(bone, bone.quaternion.clone()); };
  function noteAfter(st) {
    const M = st.__fightMod || (st.__fightMod = { hips: null, q: [] });
    for (const [bone, before] of st.__fightPre || []) M.q.push([bone, bone.quaternion.clone(), before]);
    st.__fightPre?.clear();
  }

  function poseVrm(st, dt) {
    const pose = H.pose, props = H.props;
    restoreUntouched(st);
    const T = keyTarget();
    const fast = !!S.act;
    const r = fast ? 26 : 10;
    const P = S.pose;
    for (const k of ["r", "b", "l"]) for (let i = 0; i < 3; i++) P[k][i] = damp(P[k][i], T[k][i], r, dt);
    P.lean = damp(P.lean, T.lean, r, dt); P.twist = damp(P.twist, T.twist, r, dt);
    const lying = S.down && S.down.rising == null;
    S.ikW = damp(S.ikW, 1, 6, dt);
    const W = S.ikW;
    pose.updateMatrixWorld(true);
    const fwd = _a.set(0, 0, 1).transformDirection(pose.matrixWorld);
    const left = _b.set(1, 0, 0).transformDirection(pose.matrixWorld);
    const up = _c.set(0, 1, 0).transformDirection(pose.matrixWorld);
    const anchor = st.chest || st.spine || st.hips;
    if (!anchor) return;
    // (The legs stay the idle's: a leg-IK fencer's crouch flipped knees on some rigs — the lean and the arms carry it.)
    // Spine: the lean and the turn into the blow.
    noteBefore(st, st.spine);
    if (st.chest !== st.spine) noteBefore(st, st.chest);
    if (st.spine) {
      const lean = lying ? 0 : P.lean;
      rotateInSpace(st.spine, _q1.setFromAxisAngle(st.left, lean * 0.6 * W), st.vrm.scene);
      rotateInSpace(st.spine, _q2.setFromAxisAngle(UP, P.twist * 0.55 * W), st.vrm.scene);
    }
    if (st.chest && st.chest !== st.spine) rotateInSpace(st.chest, _q1.setFromAxisAngle(UP, P.twist * 0.45 * W), st.vrm.scene);
    noteAfter(st);
    pose.updateMatrixWorld(true);
    const chestP = anchor.getWorldPosition(_g);
    const at = (out, v) => out.copy(chestP).addScaledVector(fwd, v[0]).addScaledVector(left, v[1]).addScaledVector(up, v[2]);
    const poleL = _f.copy(up).multiplyScalar(-1).addScaledVector(left, 0.55).addScaledVector(fwd, -0.3).normalize();
    const poleR = _e.copy(up).multiplyScalar(-1).addScaledVector(left, -0.55).addScaledVector(fwd, -0.3).normalize();
    if (lying) {
      // Flat on the deck: arms out to the sides, the cutlass still in the hand.
      const k = smooth(0.4, 1.2, S.down.th);
      const tr = at(_t1, [0.05, -0.55 * k - 0.2 * (1 - k), 0.12]), tl = at(_t2, [0.05, 0.55 * k + 0.2 * (1 - k), 0.12]);
      armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
      armIK(st.lArm, st.lLow, st.lHand, tl, poleL, W);
    } else {
      const bob = S.act || S.leap ? 0 : 0.025 * Math.sin(H.t * 3.3 + 0.4);
      const tr = at(_t1, [P.r[0], P.r[1], P.r[2] + bob]);
      const tl = at(_t2, [P.l[0], P.l[1], P.l[2] + bob]);
      armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
      armIK(st.lArm, st.lLow, st.lHand, tl, poleL, W * (S.heal ? 1 : 0.85));
    }
    // The cutlass along the blade direction; the tonic in Ara's left hand.
    const bd = _t3.set(0, 0, 0).addScaledVector(fwd, P.b[0]).addScaledVector(left, P.b[1]).addScaledVector(up, P.b[2]);
    if (!finite3(bd) || bd.lengthSq() < 1e-6) bd.copy(up);
    const show = S.heal ? ["cutlass", "flask"] : ["cutlass"];
    props.only(...show);
    const h = st.rHand?.getWorldPosition(_t1);
    if (h) {
      props.cutlass.position.copy(h);
      props.cutlass.quaternion.setFromUnitVectors(Y_AXIS, bd.normalize());
    }
    if (S.heal && st.lHand) {
      props.flask.position.copy(st.lHand.getWorldPosition(_t2)).addScaledVector(up, -0.04);
      props.flask.quaternion.copy(pose.getWorldQuaternion(_q1));
    }
  }

  // ---- Commands ----------------------------------------------------------------------------------

  const api = {
    get id() { return member.id; },
    get name() { return member.name; },
    member,
    get x() { return S.x; }, get z() { return S.z; }, get y() { return S.y; }, get yaw() { return S.yaw; },
    get isDown() { return !!S.down; },
    get leaping() { return !!S.leap; },
    get busy() { return !!S.act || !!S.leap || !!S.down; },
    get acting() { return S.act?.name || null; },
    get moving() { return !!S.goal; },
    get active() { return !!stage; },
    get height() { return H?.height || 1.7; },

    /** Take the body for the fight and put its root on `stage` (kept where it stands in the world). */
    begin(st) {
      stage = st;
      H = member.takeover(driver);
      const root = H.root;
      root.updateMatrixWorld(true);
      const w = root.getWorldPosition(_a);
      stage.updateMatrixWorld(true);
      stage.attach(root);
      root.position.copy(stage.worldToLocal(w.clone()));
      S.x = root.position.x; S.z = root.position.z; S.y = root.position.y;
      // Yaw in the stage's frame: from the root's world facing.
      const f = _b.set(0, 0, 1).transformDirection(root.matrixWorld);
      const inv = _m.copy(stage.matrixWorld).invert();
      f.transformDirection(inv);
      S.yaw = S.yawGoal = Math.atan2(f.x, f.z);
      root.rotation.set(0, S.yaw, 0);
      H.setYaw(S.yaw, true);
      S.act = null; S.down = null; S.leap = null; S.goal = null; S.cheer = false; S.heal = null; S.charge = false; S.looping = null;
      // A fighting blade reads at the fight's distance: a size up while it lasts.
      H.props?.cutlass?.scale.setScalar(1.35);
      return api;
    },

    /** Give the body back: the root under `parent` at `pos` (that frame) facing `yaw`; they walk to their station. */
    end(parent, pos = null, yaw = null) {
      if (!H) return;
      const root = H.root;
      if (parent) parent.attach(root);
      if (pos) root.position.copy(pos);
      if (yaw != null) { root.rotation.set(0, yaw, 0); H.setYaw(yaw, true); }
      else { const e = new THREE.Euler().setFromQuaternion(root.quaternion, "YXZ"); root.rotation.set(0, e.y, 0); H.setYaw(e.y, true); }
      stage = null;
      S.leap = null; S.down = null; S.act = null;
      if (H.V) restoreUntouched(H.V);
      H.props?.cutlass?.scale.setScalar(1);
      member.takeover(null);
    },

    moveTo(x, z, opts = {}) { if (!S.down && !S.leap) { S.goal = { x, z, ...opts }; S.goalDone = opts.then || null; } },
    /** Shove them aside (crowding: the director keeps bodies apart). */
    nudge(dx, dz) { if (!S.leap && !S.down) { S.x += dx; S.z += dz; } },
    /** Keep them on her deck: clamp(x, z) → [x, z]. */
    clampTo(fn) { if (S.leap) return; const [x, z] = fn(S.x, S.z); S.x = x; S.z = z; },
    stop() { S.goal = null; },
    faceTo(x, z) { S.yawGoal = Math.atan2(x - S.x, z - S.z); },
    /** Look at a world point (eyes and head) for a while. */
    lookAt(p, seconds = 1.2) { if (p) { S.lookAt = (S.lookAt || new THREE.Vector3()).copy(p); S.lookT = seconds; } },

    /** "swing" | "stab" | "block" | "hit" | "stagger": returns the seconds to the blow landing (swing / stab), else null. */
    act(name, opts = {}) {
      if (S.down || S.leap) return null;
      const A = ACTS[name];
      if (!A) return null;
      if (opts.at) api.faceTo(opts.at.x, opts.at.z);
      S.act = { name, t: 0, dur: A.dur / (opts.speed || 1), A };
      S.lungeOff = 0;
      if (name === "hit" || name === "stagger") { H?.face("flinch"); }
      return A.hitAt != null ? A.hitAt * S.act.dur : null;
    },

    /** Knocked flat, away from `dir` [dx, dz] (stage frame) — the blow's direction. */
    down(dir = null) {
      if (S.down || S.leap) return;
      const d = dir || [-Math.sin(S.yaw), -Math.cos(S.yaw)];
      const len = Math.hypot(d[0], d[1]) || 1;
      const lx = (d[0] * Math.cos(S.yaw) - d[1] * Math.sin(S.yaw)) / len, lz = (d[0] * Math.sin(S.yaw) + d[1] * Math.cos(S.yaw)) / len;
      S.down = { th: 0.05, w: 2.0 + Math.random() * 0.6, ax: Math.atan2(lx, lz), t: 0, max: Math.PI / 2 - 0.04, rest: false };
      S.act = null; S.goal = null; S.cheer = false; S.heal = null;
      H?.face("flinch");
      H?.expression("sad", 0.6, 2);
    },
    /** Back on their feet (from the knockdown). */
    getup() { if (S.down && S.down.rising == null) { S.down.rising = 0; H?.expression("angry", 0.5, 2); } },

    /**
     * The swing across: from `from` to `to` (stage frame), over `ctrl` (default: the midpoint, dipped low), in `dur` s.
     * onLand() when they touch down.
     */
    leap(from, to, { ctrl = null, dur = 1.3, onLand = null } = {}) {
      const c = ctrl || new THREE.Vector3().lerpVectors(from, to, 0.5).setY(Math.min(from.y, to.y) - 0.6);
      S.leap = { from: from.clone(), to: to.clone(), ctrl: c.clone(), dur, t: 0, onLand };
      S.goal = null; S.act = null; S.down = null;
      S.yawGoal = Math.atan2(to.x - from.x, to.z - from.z);
      S.yaw = S.yawGoal;
      H?.setYaw(S.yaw, true);
      if (S.looping) setLoop(null);
    },

    cheer(on = true) {
      S.cheer = !!on;
      if (on && !S.down) { H?.expression("happy", 0.9, 3); H?.play("hurrah", { cut: 2.4 }); }
    },
    /** Kneel and tend someone at `at` (stage frame), or stop (null). */
    heal(at) {
      S.heal = at ? { x: at.x, z: at.z } : null;
      if (at) { api.faceTo(at.x, at.z); H?.expression("relaxed", 0.6, 2); }
    },
    /** Head down at a run to (x, z): Rex's charge. */
    charge(x, z, opts = {}) { if (S.down || S.leap) return; S.charge = true; S.goal = { x, z, speed: 5.2, r: opts.r ?? 1.0 }; S.goalDone = opts.then || null; },

    headWorld(out = new THREE.Vector3()) {
      const V = H?.V;
      if (V?.headBone) { V.headBone.getWorldPosition(out); out.y += 0.28; return out; }
      return H ? H.root.localToWorld(out.set(0, (H.height || 1.7) + 0.2, 0)) : out.set(0, 0, 0);
    },
    chestWorld(out = new THREE.Vector3()) {
      const V = H?.V, b = V?.chest || V?.spine;
      if (b) return b.getWorldPosition(out);
      return H ? H.pose.localToWorld(out.set(0, (H.height || 1.7) * 0.72, 0)) : out.set(0, 0, 0);
    },
    handWorld(out = new THREE.Vector3(), side = "right") {
      const V = H?.V, b = side === "left" ? V?.lHand : V?.rHand;
      if (b) return b.getWorldPosition(out);
      return H ? H.pose.localToWorld(out.set(side === "left" ? 0.3 : -0.3, (H.height || 1.7) * 0.9, 0.15)) : out.set(0, 0, 0);
    },
    bladeWorld(out = new THREE.Vector3()) {
      const c = H?.props?.cutlass;
      if (c?.visible) { c.updateMatrixWorld(); return out.set(0, 0.62, 0).applyMatrix4(c.matrixWorld); }
      return api.handWorld(out);
    },
  };
  return api;
}
