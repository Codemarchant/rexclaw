"""Tool motions: the waiting animations a companion plays while one of its
slow voice tools runs (texting another companion, a new background, an
image or a video, a delegated or local task). Authored here, procedurally,
and exported as VRMA with the VRM Add-on for Blender.

Run headless with the Windows Blender (the VRM add-on must be installed):

    blender.exe -b --python tools/motion/tool_motions/build_tool_motions.py -- \
        <repo root> [all|<motion id>...] [--preview <dir>] [--no-export]

Every motion is three clips — `<id>_in` (into the pose, a prop appears),
`<id>_loop` (seamless, held for as long as the tool runs) and `<id>_out`
(back towards the idle stance, the prop goes away) — written to
assets/vrma/tool_motions/ with a manifest.json the web client reads (clip files,
prop timings, prop grips). Props are built here as well (props/*.glb).

How a pose is authored (all positions and directions in the CHARACTER's
frame: right / up / forward-towards-the-viewer, metres from the feet):

  * spine chain, neck, head: (pitch, yaw, roll) degrees, parent-relative
    (pitch + leans forward / nods down, yaw + turns to the character's
    left, roll + tilts the top towards the character's left);
  * arms: a wrist target, an elbow pole hint and the hand's finger
    direction + palm normal, solved with two-bone IK each frame;
  * legs: two-bone IK keeping the feet planted where they stand at rest,
    so the hips can shift weight;
  * fingers: curl 0..1 per finger, plus thumb curl / opposition.

Rotations are keyed on every frame (30 fps) from a continuous pose
function, so the clip is exactly what the function says; loops are built
from sine terms whose periods divide the loop length, so the last frame
meets the first.

The VRMA stores rotations (plus the hips' translation), so the motions
retarget onto any humanoid VRM; they are authored on Eve's maid outfit
(VRM 1.0, one of the bundled avatars).
"""

import json
import math
import os
import sys

import addon_utils
import bpy
from mathutils import Matrix, Quaternion, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = ARGS[0] if ARGS else os.getcwd()
WANTED = [a for a in ARGS[1:] if not a.startswith("--")]
PREVIEW_DIR = None
if "--preview" in ARGS:
    PREVIEW_DIR = ARGS[ARGS.index("--preview") + 1]
    WANTED = [a for a in WANTED if a != PREVIEW_DIR]
if "--close" in ARGS:
    WANTED = [a for a in WANTED if a != ARGS[ARGS.index("--close") + 1]]
EXPORT = "--no-export" not in ARGS
OUT_DIR = os.path.join(REPO, "assets", "vrma", "tool_motions")
AUTHOR_VRM = os.path.join(REPO, "assets", "avatars", "Eve", "eve_maid_outfit.vrm")
FPS = 30


# ── character frame ─────────────────────────────────────────────────────
# Blender armature space for an imported VRM: Z up, the character faces −Y,
# its left is +X. glTF / VRM 1.0: Y up, faces +Z, left +X.

def V(right=0.0, up=0.0, fwd=0.0):
    """A vector in the character's frame, as Blender armature space."""
    return Vector((-right, -fwd, up))


def to_gltf(v):
    """Blender armature-space vector → glTF (x, y, z)."""
    return [v.x, v.z, -v.y]


def q_to_gltf(q):
    """Blender armature-space rotation → glTF quaternion [x, y, z, w]."""
    return [q.x, q.z, -q.y, q.w]


def rot(pitch=0.0, yaw=0.0, roll=0.0):
    """Character-frame rotation from degrees (see the module docstring)."""
    return (Quaternion((0, 0, 1), math.radians(yaw))
            @ Quaternion((1, 0, 0), math.radians(pitch))
            @ Quaternion((0, 1, 0), math.radians(roll)))


def frame(a, b):
    """Orthonormal basis with first axis a and second axis b (made ⟂ a)."""
    a = a.normalized()
    b = (b - a * a.dot(b)).normalized()
    return Matrix((a, b, a.cross(b))).transposed()


def swing_to(a, b):
    """Shortest rotation taking direction a to direction b."""
    return a.normalized().rotation_difference(b.normalized())


def smooth(s):
    s = min(1.0, max(0.0, s))
    return s * s * (3 - 2 * s)


def smoother(s):
    s = min(1.0, max(0.0, s))
    return s * s * s * (s * (s * 6 - 15) + 10)


def seg(t, a, b, ease=smoother):
    """0 before a, 1 after b, eased in between."""
    if b <= a:
        return 1.0 if t >= b else 0.0
    return ease((t - a) / (b - a))


def wave(t, period, phase=0.0):
    return math.sin(2 * math.pi * (t / period + phase))


# ── rig ─────────────────────────────────────────────────────────────────

HUMAN = [
    "hips", "spine", "chest", "upper_chest", "neck", "head",
    "left_shoulder", "left_upper_arm", "left_lower_arm", "left_hand",
    "right_shoulder", "right_upper_arm", "right_lower_arm", "right_hand",
    "left_upper_leg", "left_lower_leg", "left_foot", "left_toes",
    "right_upper_leg", "right_lower_leg", "right_foot", "right_toes",
]
FINGERS = ["thumb", "index", "middle", "ring", "little"]
FINGER_SEGS = {
    "thumb": ["metacarpal", "proximal", "distal"],
    "index": ["proximal", "intermediate", "distal"],
    "middle": ["proximal", "intermediate", "distal"],
    "ring": ["proximal", "intermediate", "distal"],
    "little": ["proximal", "intermediate", "distal"],
}
for _side in ("left", "right"):
    for _f, _segs in FINGER_SEGS.items():
        for _s in _segs:
            HUMAN.append(f"{_side}_{_f}_{_s}")

SIDES = {"L": "left", "R": "right"}


class Rig:
    def __init__(self, arm):
        self.arm = arm
        hb = arm.data.vrm_addon_extension.vrm1.humanoid.human_bones
        self.bone = {}
        for h in HUMAN:
            name = getattr(hb, h).node.bone_name
            if name and name in arm.data.bones:
                self.bone[h] = name
        self.parent = {}
        for h, name in self.bone.items():
            p = arm.data.bones[name].parent
            while p is not None and p.name not in self.bone.values():
                p = p.parent
            self.parent[h] = next((k for k, v in self.bone.items() if p and v == p.name), None)
        self.rest_q = {h: arm.data.bones[n].matrix_local.to_quaternion() for h, n in self.bone.items()}
        self.head = {h: arm.data.bones[n].head_local.copy() for h, n in self.bone.items()}
        self.tail = {h: arm.data.bones[n].tail_local.copy() for h, n in self.bone.items()}
        self.order = []
        seen = set()

        def visit(h):
            if h in seen:
                return
            if self.parent.get(h):
                visit(self.parent[h])
            seen.add(h)
            self.order.append(h)
        for h in self.bone:
            visit(h)
        for pbone in arm.pose.bones:
            pbone.rotation_mode = "QUATERNION"

    def child_dir(self, h, child):
        return (self.head[child] - self.head[h]).normalized()

    def length(self, h, child):
        return (self.head[child] - self.head[h]).length


def import_author_vrm():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable("bl_ext.blender_org.vrm", default_set=True)
    bpy.ops.import_scene.vrm(filepath=AUTHOR_VRM)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    return Rig(arm)


# ── pose model ──────────────────────────────────────────────────────────

class Pose(dict):
    """A full-body pose: see the module docstring for the keys."""


def solve_two_bone(S, T, l1, l2, pole):
    """Elbow/knee position for root S, end target T, a pole hint."""
    d_vec = T - S
    d = min(d_vec.length, (l1 + l2) * 0.9995)
    d = max(d, abs(l1 - l2) + 1e-4)
    u = d_vec.normalized()
    T = S + u * d
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    p = pole - u * u.dot(pole)
    if p.length < 1e-6:
        p = Vector((0, 0, -1)) - u * u.dot(Vector((0, 0, -1)))
    p.normalize()
    # The bend plane's normal (the elbow/knee hinge axis), taken from the
    # pole rather than from the bent limb: a nearly straight limb has no
    # well-defined bend of its own, and reading it from the limb flipped
    # the elbow 180° between frames.
    return S + u * a + p * h, T, p.cross(u).normalized()


class Solver:
    """Turns a Pose into parent-relative rotations (armature-aligned) for
    every humanoid bone, plus the hips offset."""

    def __init__(self, rig):
        self.rig = rig
        r = rig
        self.finger_axis = {}
        self.finger_dir = {}
        for side in ("left", "right"):
            hand = f"{side}_hand"
            mid = f"{side}_middle_proximal"
            fdir = (r.head[mid] - r.head[hand]).normalized()
            self.hand_rest = getattr(self, "hand_rest", {})
            # Rest palms face down in the VRM T-pose.
            self.hand_rest[side] = (fdir, Vector((0, 0, -1)))
            for f, segs in FINGER_SEGS.items():
                for i, s in enumerate(segs):
                    h = f"{side}_{f}_{s}"
                    if h not in r.bone:
                        continue
                    nxt = f"{side}_{f}_{segs[i + 1]}" if i + 1 < len(segs) else None
                    d = (r.head[nxt] - r.head[h]).normalized() if nxt and nxt in r.bone else (r.tail[h] - r.head[h]).normalized()
                    self.finger_dir[h] = d

    # FK helper: world rotation delta D and head position P per bone.
    def fk(self, local, hips_off):
        r = self.rig
        D, P = {}, {}
        for h in r.order:
            p = r.parent.get(h)
            q = local.get(h, Quaternion())
            if p is None:
                D[h] = q
                P[h] = r.head[h] + hips_off
            else:
                D[h] = D[p] @ q
                P[h] = P[p] + D[p] @ (r.head[h] - r.head[p])
        return D, P

    def solve(self, pose):
        if isinstance(pose, Blend):
            if pose.s <= 0:
                return self.solve(pose.a)
            if pose.s >= 1:
                return self.solve(pose.b)
            la, ha = self.solve(pose.a)
            lb, hb = self.solve(pose.b)
            out = {}
            for h in set(la) | set(lb):
                qa, qb = la.get(h, Quaternion()), lb.get(h, Quaternion())
                if qa.dot(qb) < 0:
                    qb = -qb
                out[h] = qa.slerp(qb, pose.s)
            return out, ha.lerp(hb, pose.s)
        r = self.rig
        local = {}
        hips_off = pose.get("hips_off", Vector())
        local["hips"] = pose.get("hips", Quaternion())
        for h in ("spine", "chest", "upper_chest", "neck", "head"):
            if h in pose:
                local[h] = pose[h]
        for side in ("left", "right"):
            key = f"shoulder_{side[0].upper()}"
            if key in pose:
                local[f"{side}_shoulder"] = pose[key]
        # Look-at: neck + head share the turn towards a point.
        if pose.get("look") is not None:
            D, P = self.fk(local, hips_off)
            head_pos = P["head"] + D["head"] @ V(up=0.08)
            want = (pose["look"] - head_pos).normalized()
            # Partial by default: people drop their eyes as much as their
            # head, so the head only goes part of the way.
            sw = Quaternion().slerp(swing_to(D["head"] @ V(fwd=1), want), pose.get("look_weight", 0.6))
            # The neck takes its share of the turn, the head the rest.
            Dn = Quaternion().slerp(sw, pose.get("look_neck", 0.4)) @ D["neck"]
            Dh = sw @ D["head"]
            local["neck"] = D[r.parent["neck"]].inverted() @ Dn
            local["head"] = Dn.inverted() @ Dh
        # Arms.
        D, P = self.fk(local, hips_off)
        for side in ("left", "right"):
            spec = pose.get(f"arm_{side[0].upper()}")
            if not spec:
                continue
            up, lo, hand = f"{side}_upper_arm", f"{side}_lower_arm", f"{side}_hand"
            S = P[up]
            l1, l2 = r.length(up, lo), r.length(lo, hand)
            E, T, n = solve_two_bone(S, spec["hand"], l1, l2, spec["pole"])
            d1, d2 = (E - S).normalized(), (T - E).normalized()
            r1, r2 = r.child_dir(up, lo), r.child_dir(lo, hand)
            # Bend plane normal; at rest the elbow folds forward.
            n_rest = r1.cross(V(fwd=1)).normalized()
            W1 = (frame(d1, n) @ frame(r1, n_rest).inverted()).to_quaternion()
            W2 = (frame(d2, n) @ frame(r2, n_rest).inverted()).to_quaternion()
            # Hand orientation from finger direction + palm normal.
            f_rest, n_rest_h = self.hand_rest[side]
            H = (frame(spec["fdir"], spec["palm"]) @ frame(f_rest, n_rest_h).inverted()).to_quaternion()
            # Share the forearm's roll with the hand (no twist bones on
            # VRoid rigs): half of the hand's twist about the forearm goes
            # into the forearm so the wrist doesn't candy-wrap.
            rel = W2.inverted() @ H
            axis_rest = r2
            twist = Quaternion((rel.w, *(axis_rest * axis_rest.dot(Vector(rel[1:])))))
            if twist.magnitude > 1e-6:
                twist.normalize()
                tw_axis, tw_ang = twist.to_axis_angle()
                if tw_axis.dot(axis_rest) < 0:
                    tw_ang = -tw_ang
                # The short way round, either sign: a −286° twist is +74°.
                tw_ang = (tw_ang + math.pi) % (2 * math.pi) - math.pi
                W2 = W2 @ Quaternion(axis_rest, tw_ang * spec.get("twist_share", 0.5))
            parent = D[r.parent[up]]
            local[up] = parent.inverted() @ W1
            local[lo] = W1.inverted() @ W2
            local[hand] = W2.inverted() @ H
            D, P = self.fk(local, hips_off)
        # Legs: keep the feet planted at their rest spots.
        for side in ("left", "right"):
            up, lo, foot = f"{side}_upper_leg", f"{side}_lower_leg", f"{side}_foot"
            if up not in r.bone:
                continue
            S = P[up]
            T = r.head[foot] + pose.get(f"foot_{side[0].upper()}", Vector())
            l1, l2 = r.length(up, lo), r.length(lo, foot)
            K, T, _ = solve_two_bone(S, T, l1, l2, V(fwd=1) + V(right=-0.15 if side == "left" else 0.15))
            d1, d2 = (K - S).normalized(), (T - K).normalized()
            r1, r2 = r.child_dir(up, lo), r.child_dir(lo, foot)
            W1 = swing_to(r1, d1)
            W2 = swing_to(W1 @ r2, d2) @ W1
            parent = D[r.parent[up]]
            local[up] = parent.inverted() @ W1
            local[lo] = W1.inverted() @ W2
            local[foot] = W2.inverted()            # foot stays level
        # Fingers.
        for side in ("left", "right"):
            spec = pose.get(f"fingers_{side[0].upper()}")
            if not spec:
                continue
            palm = Vector((0, 0, -1))
            for f, segs in FINGER_SEGS.items():
                curl = spec.get(f, 0.0)
                for i, s in enumerate(segs):
                    h = f"{side}_{f}_{s}"
                    if h not in r.bone:
                        continue
                    d = self.finger_dir[h]
                    if f == "thumb":
                        # Thumb: flexion folds it across the palm (about the
                        # palm normal), opposition lifts it towards the palm
                        # side; mostly at the base joint.
                        flex_axis = -palm if side == "left" else palm
                        # Same axis rule as the finger curl (d × palm turns
                        # d towards the palm side on either hand). It was
                        # mirrored for the right hand, which lifted that
                        # thumb out of the back of the hand instead.
                        opp_axis = d.cross(palm).normalized()
                        w = (0.55, 0.3, 0.25)[i]
                        q = (Quaternion(flex_axis, math.radians(55 * spec.get("thumb", 0.0) * w))
                             @ Quaternion(opp_axis, math.radians(50 * spec.get("thumb_op", 0.0) * (1 if i == 0 else 0.3))))
                    else:
                        axis = d.cross(palm).normalized()
                        maxdeg = (75, 95, 65)[i]
                        spread = spec.get("spread", 0.0)
                        # One curl for the whole finger, or one per joint
                        # (base, middle, tip), e.g. flat under a phone with
                        # only the tips round its edge.
                        c = curl[i] if isinstance(curl, (list, tuple)) else curl
                        q = Quaternion(axis, math.radians(maxdeg * c))
                        if i == 0 and spread:
                            fan = {"index": 1, "middle": 0.3, "ring": -0.4, "little": -1}[f]
                            s_axis = palm if side == "left" else -palm
                            q = Quaternion(s_axis, math.radians(8 * spread * fan)) @ q
                    local[h] = q
        return local, hips_off


def mix(a, b, s):
    """Blend two poses: positions lerp, rotations slerp, dicts recurse. A
    key only one side has is kept as it is — except the look-at, whose
    weight fades in from (or out to) the side without one."""
    s = min(1.0, max(0.0, s))
    a, b = dict(a), dict(b)
    if a.get("look") is None and b.get("look") is not None:
        a["look"], a["look_weight"] = b["look"], 0.0
    if b.get("look") is None and a.get("look") is not None:
        b["look"], b["look_weight"] = a["look"], 0.0
    out = Pose()
    for k in set(a) | set(b):
        va, vb = a.get(k), b.get(k)
        if va is None or vb is None:
            out[k] = vb if va is None else va
        elif isinstance(va, Quaternion):
            out[k] = va.slerp(vb, s)
        elif isinstance(va, Vector):
            out[k] = va.lerp(vb, s)
        elif isinstance(va, dict) and "fdir" in va and "fdir" in vb:
            # An arm: the hand turns as one rotation. Mixing its finger and
            # palm directions as vectors passes through zero when they turn
            # far (fingers down at the side → up at the ear) and the hand
            # flipped mid-way.
            arm_mix = mix({k2: v for k2, v in va.items() if k2 not in ("fdir", "palm")},
                          {k2: v for k2, v in vb.items() if k2 not in ("fdir", "palm")}, s)
            # The wrist swings round the shoulder (direction turns, reach
            # changes steadily) instead of cutting straight across: a
            # straight line from the hip to the face passes right by the
            # shoulder, which crumpled the elbow mid-way and flipped the hand.
            sh = SHOULDERS.get(k[-1]) if k in ("arm_L", "arm_R") else None
            if sh is not None:
                da, db = va["hand"] - sh, vb["hand"] - sh
                if da.length > 1e-6 and db.length > 1e-6:
                    turn = da.normalized().rotation_difference(db.normalized())
                    direction = Quaternion().slerp(turn, s) @ da.normalized()
                    arm_mix["hand"] = sh + direction * (da.length + (db.length - da.length) * s)
            qa = frame(va["fdir"], va["palm"]).to_quaternion()
            qb = frame(vb["fdir"], vb["palm"]).to_quaternion()
            q = qa.slerp(qb, s)
            arm_mix["fdir"] = q @ Vector((1, 0, 0))
            arm_mix["palm"] = q @ Vector((0, 1, 0))
            out[k] = arm_mix
        elif isinstance(va, dict):
            out[k] = mix(va, vb, s)
        elif isinstance(va, (list, tuple)) or isinstance(vb, (list, tuple)):
            # Per-joint finger curls; a single number is the same curl on all.
            la = list(va) if isinstance(va, (list, tuple)) else [va] * 3
            lb = list(vb) if isinstance(vb, (list, tuple)) else [vb] * 3
            out[k] = [x + (y - x) * s for x, y in zip(la, lb)]
        elif isinstance(va, (int, float)):
            out[k] = va + (vb - va) * s
        else:
            out[k] = vb if s > 0.5 else va
    return out


class Blend:
    """A transition between two poses in JOINT space: both are solved on
    their own and every joint turns from one to the other the short way
    (Solver.solve), as keyframe interpolation does. Blending the targets
    instead (mix) let the hand pass through a half-turn against the
    forearm on the way to the ear or the camera frame, and the elbow
    flipped. Holds and loops still use target poses."""

    def __init__(self, a, b, s):
        self.a, self.b, self.s = a, b, min(1.0, max(0.0, s))


def _heading(p):
    """The pose a blend is on its way to (the pose itself otherwise)."""
    return _heading(p.b) if isinstance(p, Blend) else p


def blend(a, b, s):
    """Joint-space transition from a to b. `b` may name only what changes:
    the rest is carried over from where `a` is heading."""
    if isinstance(b, Blend):
        return Blend(a, b, s)
    return Blend(a, mix(_heading(a), b, 1.0), s)


def add(pose, **deltas):
    """Additive layer: rotations pre-multiplied, vectors summed."""
    out = Pose(pose)
    for k, d in deltas.items():
        if isinstance(d, dict):
            base = dict(out.get(k) or {})
            for kk, dv in d.items():
                if isinstance(dv, Vector):
                    base[kk] = base.get(kk, Vector()) + dv
                else:
                    base[kk] = base.get(kk, 0.0) + dv
            out[k] = base
        elif isinstance(d, Quaternion):
            out[k] = d @ out.get(k, Quaternion())
        elif isinstance(d, Vector):
            out[k] = out.get(k, Vector()) + d
    return out


# ── landmarks + shared poses ────────────────────────────────────────────

SHOULDERS = {}   # "L"/"R" → shoulder joint, for mix()'s wrist arcs


class Body:
    """Landmarks of the authoring avatar, for writing targets."""

    def __init__(self, rig):
        h = rig.head
        self.sh_L = h["left_upper_arm"]
        self.sh_R = h["right_upper_arm"]
        SHOULDERS["L"], SHOULDERS["R"] = self.sh_L, self.sh_R
        # Upper arm / forearm lengths, for poses that need the elbow.
        self.arm_len = rig.length("right_upper_arm", "right_lower_arm"), rig.length("right_lower_arm", "right_hand")
        self.chest = h["upper_chest"]
        self.neck = h["neck"]
        self.head = h["head"]
        self.hips = h["hips"]
        self.eye = h["head"] + V(up=0.07, fwd=0.07)


def at(base, right=0.0, up=0.0, fwd=0.0):
    return base + V(right, up, fwd)


RELAXED_FINGERS = {"thumb": 0.25, "thumb_op": 0.2, "index": 0.18, "middle": 0.25, "ring": 0.3, "little": 0.35}


def stand(b):
    """The neutral standing stance the in/out clips start and end on —
    close to the app's procedural idle (arms down, slight bend)."""
    return Pose(
        spine=rot(), chest=rot(), upper_chest=rot(), neck=rot(), head=rot(),
        arm_L={"hand": at(b.sh_L, right=-0.07, up=-0.385, fwd=0.03), "pole": V(right=0.3, up=-0.2, fwd=-1),
               "fdir": V(up=-1, fwd=0.15, right=0.1), "palm": V(right=1)},
        arm_R={"hand": at(b.sh_R, right=0.07, up=-0.385, fwd=0.03), "pole": V(right=-0.3, up=-0.2, fwd=-1),
               "fdir": V(up=-1, fwd=0.15, right=-0.1), "palm": V(right=-1)},
        fingers_L=dict(RELAXED_FINGERS), fingers_R=dict(RELAXED_FINGERS),
    )


# ── motions ─────────────────────────────────────────────────────────────

MOTIONS = {}


def motion(mid, tool, props=()):
    def deco(fn):
        MOTIONS[mid] = {"tool": tool, "build": fn, "props": list(props)}
        return fn
    return deco


@motion("phone_text", "text_companion", props=["phone"])
def phone_text(b):
    rest = stand(b)
    # Holding the phone at the lower chest, screen up towards the face,
    # head bowed over it; the other hand loose at the side.
    hold_hand = at(b.sh_R, right=-0.08, up=-0.13, fwd=0.25)
    hold = mix(rest, Pose(
        spine=rot(pitch=4), chest=rot(pitch=3), upper_chest=rot(pitch=2),
        arm_R={"hand": hold_hand, "pole": V(right=0.6, up=-1, fwd=-0.2),
               "fdir": V(right=-0.55, up=0.35, fwd=0.75), "palm": V(up=0.75, fwd=-0.55, right=-0.3),
               "twist_share": 0.5},
        # Fingers flat under the phone, tips round its edge; thumb raised
        # over the screen and reaching across it.
        fingers_R={"thumb": 0.75, "thumb_op": 0.55, "index": [0.05, 0.6, 0.7], "middle": [0.08, 0.65, 0.7],
                   "ring": [0.1, 0.68, 0.7], "little": [0.12, 0.7, 0.7]},
        look=hold_hand + V(right=-0.05, up=0.02, fwd=0.03), look_neck=0.45,
    ), 1.0)
    pocket = Pose(
        arm_R={"hand": at(b.hips, right=0.15, up=-0.04, fwd=-0.01), "pole": V(right=0.4, up=-0.2, fwd=-1),
               "fdir": V(up=-1, right=0.1), "palm": V(right=-1, fwd=0.2)},
        fingers_R={"thumb": 0.3, "thumb_op": 0.3, "index": 0.5, "middle": 0.55, "ring": 0.6, "little": 0.6},
        look=None,
    )

    def intro(t):
        # 0-0.45 reach to the pocket, 0.45-0.6 grab, 0.6-1.5 raise + look down.
        p = blend(rest, pocket, seg(t, 0.0, 0.5))
        p = blend(p, hold, seg(t, 0.62, 1.45))
        return p

    def loop(t):
        L = 4.0
        # Thumb taps (about three a second, a pause in the middle), a little
        # wrist play, breath-sized sway, an occasional head tilt.
        pause = seg(t, 1.6, 1.85) * (1 - seg(t, 2.25, 2.5))
        tap = max(0.0, wave(t, L / 13)) * (0.6 + 0.4 * wave(t, L / 2, 0.25)) * (1 - pause)
        return add(hold,
                   # A tap presses down onto the glass (less lift) and
                   # moves the tip a little across.
                   fingers_R={"thumb_op": -0.14 * tap, "thumb": 0.08 * tap},
                   arm_R={"hand": V(up=0.006 * wave(t, L / 2), fwd=0.004 * wave(t, L, 0.3))},
                   hips=rot(roll=0.8 * wave(t, L)), hips_off=V(right=0.006 * wave(t, L)),
                   head=rot(roll=2.5 * wave(t, L, 0.1), yaw=-2 * wave(t, L / 2, 0.2)))

    def outro(t):
        # 0-0.7 lower to the pocket, 0.7-1.3 hand back to the side.
        p = blend(hold, pocket, seg(t, 0.0, 0.7))
        return blend(p, rest, seg(t, 0.75, 1.4))

    return {
        "in": (1.5, intro), "loop": (4.0, loop), "out": (1.4, outro),
        # When the phone shows / goes: at the pocket, on the way in and out.
        "prop_times": {"phone": {"show_in": 0.5, "hide_out": 0.72}},
    }


def palm_of(side, fingers, thumb):
    """Palm normal for a hand whose fingers and thumb side point as given
    (the hand's axes are right-handed on the right, mirrored on the left)."""
    f, t = fingers.normalized(), thumb.normalized()
    t = (t - f * f.dot(t)).normalized()
    return t.cross(f) if side == "R" else f.cross(t)


def arm(side, hand, fingers, thumb, pole, twist=0.5):
    return {"hand": hand, "fdir": fingers, "palm": palm_of(side, fingers, thumb), "pole": pole,
            "twist_share": twist}


FIST = {"thumb": 0.55, "thumb_op": 0.5, "index": 0.85, "middle": 0.9, "ring": 0.92, "little": 0.95}
CLAW = {"thumb": 0.15, "thumb_op": 0.45, "index": 0.32, "middle": 0.36, "ring": 0.4, "little": 0.44, "spread": 1.0}
OPEN = {"thumb": -0.1, "thumb_op": 0.15, "index": 0.04, "middle": 0.06, "ring": 0.08, "little": 0.1, "spread": 1.2}
L_SHAPE = {"thumb": -0.45, "thumb_op": 0.1, "index": 0.0, "middle": 0.9, "ring": 0.95, "little": 0.95}
FLAT = {"thumb": 0.05, "thumb_op": 0.35, "index": 0.1, "middle": 0.12, "ring": 0.14, "little": 0.16}


def pocket_pose(b):
    """Right hand at the right hip, as if reaching into a pocket."""
    return Pose(
        arm_R={"hand": at(b.hips, right=0.15, up=-0.04, fwd=-0.01), "pole": V(right=0.4, up=-0.2, fwd=-1),
               "fdir": V(up=-1, right=0.1), "palm": V(right=-1, fwd=0.2)},
        fingers_R={"thumb": 0.3, "thumb_op": 0.3, "index": 0.5, "middle": 0.55, "ring": 0.6, "little": 0.6},
    )


@motion("phone_call", "delegate_task", props=["phone"])
def phone_call(b):
    """Calling someone to get it done: phone to the ear, listening, the
    other hand on the hip."""
    rest = stand(b)
    pocket = pocket_pose(b)
    # Wrist in front of the jaw and out from it: measured from the
    # shoulder so the elbow folds about 140° (a wrist right beside the ear
    # sits almost on the shoulder joint and folds it past what an arm can).
    ear = at(b.sh_R, right=0.03, up=0.08, fwd=0.115)
    hold = Pose(
        spine=rot(roll=-1.5), chest=rot(), upper_chest=rot(roll=-1),
        neck=rot(roll=-3), head=rot(roll=-5, pitch=3, yaw=-4),
        # Palm to the cheek; the fingers lean back so the phone reaches
        # from the ear down towards the mouth.
        arm_R={"hand": ear, "fdir": V(up=0.75, fwd=-0.6, right=-0.1), "palm": V(right=-1, fwd=-0.1),
               "pole": V(right=1, up=-0.7, fwd=0.15), "twist_share": 0.5},
        fingers_R={"thumb": 0.2, "thumb_op": 0.35, "index": 0.35, "middle": 0.42, "ring": 0.5, "little": 0.55},
        arm_L=arm("L", at(b.hips, right=-0.16, up=0.08, fwd=0.01), V(up=-0.6, fwd=0.75), V(up=1, fwd=0.2),
                  V(right=-1, up=-0.1, fwd=-0.35)),
        fingers_L={"thumb": 0.1, "thumb_op": 0.2, "index": 0.15, "middle": 0.2, "ring": 0.22, "little": 0.25},
        hips=rot(roll=1.5), hips_off=V(right=-0.012),
    )

    def intro(t):
        p = blend(rest, pocket, seg(t, 0.0, 0.5))
        p = blend(p, hold, seg(t, 0.6, 1.5))
        return p

    def loop(t):
        L = 5.0
        # "Mm-hm" nods twice in the loop, a slow weight shift, the free
        # hand's fingers drumming once.
        nod = math.exp(-((t - 1.2) / 0.18) ** 2) + math.exp(-((t - 3.6) / 0.2) ** 2)
        drum = sum(math.exp(-((t - c) / 0.07) ** 2) for c in (2.2, 2.35, 2.5, 2.65))
        return add(hold,
                   head=rot(pitch=5 * nod, roll=1.5 * wave(t, L, 0.2)),
                   hips=rot(roll=0.8 * wave(t, L)), hips_off=V(right=0.006 * wave(t, L)),
                   spine=rot(yaw=2 * wave(t, L, 0.6)),
                   fingers_L={"index": 0.25 * drum, "middle": 0.2 * drum, "ring": 0.15 * drum},
                   arm_R={"hand": V(up=0.003 * wave(t, L / 2))})

    def outro(t):
        # Phone down to the pocket while the free hand leaves the hip.
        p = blend(hold, pocket, seg(t, 0.0, 0.7))
        p = blend(p, Pose({k: rest[k] for k in rest if k.endswith("_L")}), seg(t, 0.1, 0.9))
        return blend(p, rest, seg(t, 0.75, 1.4))

    return {"in": (1.6, intro), "loop": (5.0, loop), "out": (1.4, outro),
            "prop_times": {"phone": {"show_in": 0.5, "hide_out": 0.72}}}


@motion("conjure_portal", "change_background")
def conjure_portal(b):
    """Magic for a new scene: an orb of light gathered between the hands,
    rolled while it grows, then flung open as the background changes."""
    rest = stand(b)
    c = at(b.chest, up=0.04, fwd=0.36)
    r = 0.16

    def orb(theta=0.0, rad=r, lift=0.0):
        q = Quaternion(V(fwd=1), math.radians(theta))
        pl = c + V(up=lift) + q @ V(right=-rad, fwd=-0.03)
        pr = c + V(up=lift) + q @ V(right=rad, fwd=-0.03)
        return Pose(
            spine=rot(pitch=2), upper_chest=rot(pitch=-2),
            # Palms to the orb: thumbs up and back towards the face.
            arm_L=arm("L", pl, q @ V(fwd=0.7, up=0.55, right=0.12), q @ V(up=1, fwd=-0.35), V(right=-0.7, up=-1, fwd=-0.2)),
            arm_R=arm("R", pr, q @ V(fwd=0.7, up=0.55, right=-0.12), q @ V(up=1, fwd=-0.35), V(right=0.7, up=-1, fwd=-0.2)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
            look=c + V(up=lift), look_weight=0.45,
        )
    hold = orb()
    fling = Pose(
        spine=rot(pitch=-2), upper_chest=rot(pitch=-4), head=rot(pitch=-4),
        arm_L=arm("L", at(b.sh_L, right=-0.33, up=0.05, fwd=0.2), V(right=-0.6, up=0.55, fwd=0.4), V(up=1),
                  V(right=-0.2, up=-1, fwd=-0.3)),
        arm_R=arm("R", at(b.sh_R, right=0.33, up=0.05, fwd=0.2), V(right=0.6, up=0.55, fwd=0.4), V(up=1),
                  V(right=0.2, up=-1, fwd=-0.3)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
        look=c + V(fwd=1.5, up=0.2), look_weight=0.3,
    )

    def intro(t):
        # The hands rise in an arc (out, then in) and cup the forming orb.
        s = seg(t, 0.05, 1.3)
        p = blend(rest, orb(theta=-50 * (1 - s), rad=r + 0.12 * (1 - s), lift=-0.15 * (1 - s)), s)
        return p

    def loop(t):
        L = 3.0
        theta = 32 * wave(t, L)
        p = orb(theta=theta, rad=r + 0.012 * wave(t, L / 2, 0.25), lift=0.01 * wave(t, L, 0.25))
        wig = {f: 0.07 * wave(t, 0.75, i * 0.2) for i, f in enumerate(["index", "middle", "ring", "little"])}
        return add(p, fingers_L=wig, fingers_R={k: -v for k, v in wig.items()},
                   hips=rot(roll=0.7 * wave(t, L, 0.1)), hips_off=V(right=0.005 * wave(t, L, 0.1)),
                   head=rot(roll=-3 * wave(t, L)))

    def outro(t):
        # 0-0.3 fling open, hold, 0.65-1.35 down to the sides.
        p = blend(hold, fling, seg(t, 0.0, 0.3, ease=smooth))
        return blend(p, rest, seg(t, 0.65, 1.35))

    # Wind-up for the reveal: the orb crushed small, she bears down on it.
    crush = add(orb(rad=0.085, lift=-0.03),
                spine=rot(pitch=7), head=rot(pitch=9),
                hips_off=V(up=-0.035, fwd=-0.012))
    # The tear: both arms ripped apart and up, chest open, chin lifted.
    tear = add(Pose(
        spine=rot(pitch=-3), upper_chest=rot(pitch=-8), head=rot(pitch=-8),
        arm_L=arm("L", at(b.sh_L, right=-0.3, up=0.24, fwd=0.17), V(right=-0.5, up=0.8, fwd=0.3), V(up=0.6, fwd=-0.7),
                  V(right=-0.35, up=-1, fwd=-0.3)),
        arm_R=arm("R", at(b.sh_R, right=0.3, up=0.15, fwd=0.2), V(right=0.6, up=0.65, fwd=0.35), V(up=0.6, fwd=-0.7),
                  V(right=0.35, up=-1, fwd=-0.3)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
        look=c + V(fwd=1.5, up=0.45), look_weight=0.3,
    ), hips_off=V(up=0.008))
    # Over the shoulder at what she just opened behind her.
    # Modest on purpose: a big head turn swings a ponytail over the shoulder,
    # and the arms coming down then pin it there.
    admire = add(tear, spine=rot(yaw=6), upper_chest=rot(yaw=5), head=rot(yaw=15, roll=4, pitch=2))

    def reveal(t):
        # 0-0.5 crush, 0.5-0.72 tear (the portal opens at 0.56), 0.72-1.6
        # held against the wind, 1.6-2.35 a look back at it, 2.35-3.3 down.
        strain = {"arm_L": {"hand": V(up=0.012 * wave(t, 0.7))}, "arm_R": {"hand": V(up=-0.012 * wave(t, 0.7))}}
        p = blend(hold, crush, seg(t, 0.0, 0.5, ease=smooth))
        p = blend(p, add(tear, **strain), seg(t, 0.5, 0.72, ease=smooth))
        p = blend(p, add(admire, **strain), seg(t, 1.55, 2.15))
        return blend(p, rest, seg(t, 2.35, 3.3))

    return {"in": (1.3, intro), "loop": (3.0, loop), "out": (1.4, outro), "reveal": (3.4, reveal),
            "prop_times": {},
            # The orb effect the client draws between the hands; the reveal
            # (a new background landed) tears it open into the portal.
            "effect": {"kind": "orb", "show_in": 0.55, "burst_out": 0.22, "tear_reveal": 0.56}}


def show_it(b, rest, hold):
    """A reveal: from `hold`, she holds what the tool made (a print with
    the picture, a film card playing the video) up beside her face, facing
    you, for a couple of seconds, then lowers it. One hand, so it reads the
    same on any proportions. Timing: 0.35-1.0 up, 1.0-3.0 showing it off
    with a little wag, 3.0-3.8 down to the side (props in at ~0.5, out at
    ~3.25)."""
    # Out to her right, so the print sits beside her face, not over it.
    show_wrist = at(b.sh_R, right=0.13, up=0.02, fwd=0.17)
    show = mix(rest, Pose(
        spine=rot(roll=-1.5, yaw=-4), upper_chest=rot(yaw=-3),
        head=rot(roll=-7, yaw=-6, pitch=2),
        # Palm to the viewer, fingers up behind the print, thumb across
        # its front edge.
        arm_R=arm("R", show_wrist, V(up=1, right=-0.1, fwd=0.15), V(right=-1), V(right=1, up=-1, fwd=-0.2)),
        # Fingers near straight behind the print (curled, they poked
        # through it), thumb lifted round to its front.
        fingers_R={"thumb": 0.35, "thumb_op": 0.6, "index": [0.04, 0.06, 0.04], "middle": [0.05, 0.07, 0.04],
                   "ring": [0.06, 0.08, 0.05], "little": [0.08, 0.1, 0.06]},
    ), 1.0)

    def reveal(t):
        wag = seg(t, 0.9, 1.2) * (1 - seg(t, 2.8, 3.0))
        shown = add(show, arm_R={"hand": V(right=0.012 * wave(t, 1.0) * wag, up=0.006 * wave(t, 0.5) * wag)},
                    head=rot(roll=2.5 * wave(t, 2.0) * wag))
        p = blend(hold, shown, seg(t, 0.35, 1.0))
        return blend(p, rest, seg(t, 3.0, 3.8))
    return reveal


@motion("paint_canvas", "create_image", props=["palette", "brush", "photo"])
def paint_canvas(b):
    """Painting the picture: palette on the left hand, brush strokes on an
    invisible canvas between the companion and the viewer."""
    rest = stand(b)
    canvas = at(b.chest, right=0.1, up=0.1, fwd=0.28)
    pal = at(b.sh_L, right=-0.08, up=-0.27, fwd=0.26)
    base = Pose(
        spine=rot(pitch=1), upper_chest=rot(yaw=6),
        # Palm up under the palette (a left hand's thumb then points out),
        # tipped a little towards her: dead level asked the forearm to
        # turn ~105°, past the ~90° it can.
        arm_L=arm("L", pal, V(fwd=0.85, right=0.45), V(right=-0.6, fwd=0.3, up=0.3), V(right=-0.4, up=-1, fwd=-0.4)),
        fingers_L=dict(FLAT),
        # Pencil grip: brush pinched by thumb and forefinger.
        fingers_R={"thumb": 0.4, "thumb_op": 0.65, "index": 0.35, "middle": 0.5, "ring": 0.8, "little": 0.85},
    )

    def brush_at(p, tilt=0.0):
        # Fingers (and the brush along them) carry on down the forearm,
        # tipped a little towards the canvas, so the wrist stays near
        # straight as the arm sweeps (a fixed direction bent it sideways
        # ~55° at the ends of a stroke).
        pole = V(right=0.9, up=-1, fwd=-0.3)
        elbow, _, _ = solve_two_bone(b.sh_R, p, *b.arm_len, pole)
        fingers = ((p - elbow).normalized() + V(fwd=0.25, up=-0.1 + tilt)).normalized()
        return arm("R", p, fingers, V(up=1, right=-0.2), pole)

    def stroke(t):
        """Figure-of-eight strokes over the canvas, period 3 s."""
        return canvas + V(right=0.08 * wave(t, 3.0), up=0.05 * wave(t, 1.5), fwd=0.015 * wave(t, 1.5, 0.25))

    def pose_at(p, look_pt):
        q = Pose(base)
        q["arm_R"] = brush_at(p)
        q["look"] = look_pt
        q["look_weight"] = 0.5
        return q

    hold = pose_at(canvas, canvas)
    # The palette's near edge: within the right arm's reach, so the elbow
    # stays bent on the way there.
    dab = at(pal, right=0.12, up=0.07, fwd=0.02)

    def intro(t):
        return blend(rest, hold, seg(t, 0.0, 1.2))

    def loop(t):
        L = 4.0
        if t < 3.0:
            p = stroke(t)
        else:
            # To the palette and back to where the strokes start again
            # (stroke(3) = stroke(0)), so the loop closes.
            go = seg(t, 3.0, 3.4) * (1 - seg(t, 3.6, 4.0))
            p = stroke(3.0).lerp(dab, go)
        look_pt = canvas.lerp(p, 0.6)
        q = pose_at(p, look_pt)
        return add(q, head=rot(roll=4 * wave(t, L, 0.1)),
                   hips=rot(roll=0.6 * wave(t, L)), hips_off=V(right=0.005 * wave(t, L)))

    def outro(t):
        return blend(hold, rest, seg(t, 0.15, 1.3))

    # The reveal (played instead of the outro when the picture is back):
    # brush and palette go, and she holds the finished print up beside her
    # face (show_it). The app puts the real image on the print.
    reveal = show_it(b, rest, hold)

    return {"in": (1.3, intro), "loop": (4.0, loop), "out": (1.4, outro), "reveal": (3.9, reveal),
            "reveal_props": ["photo"],
            "prop_times": {"palette": {"show_in": 0.35, "hide_out": 1.0, "hide_reveal": 0.3},
                           "brush": {"show_in": 0.35, "hide_out": 1.0, "hide_reveal": 0.3},
                           "photo": {"show_reveal": 0.5, "hide_reveal": 3.25}}}


@motion("frame_shot", "create_video", props=["film"])
def frame_shot(b):
    """Directing the video: thumbs and forefingers make a camera frame,
    peeking through it and scouting the shot."""
    rest = stand(b)
    fc = b.eye + V(fwd=0.34, up=-0.02)

    def framed(yaw=0.0, zoom=0.0, tilt=0.0):
        q = Quaternion(V(up=1), math.radians(yaw)) @ Quaternion(V(fwd=1), math.radians(tilt))
        # Close enough that both elbows stay well bent (at 34 cm the arms
        # were past full reach, and a straight arm's twist is undefined).
        # Frame height and elbow directions from a search over wrist
        # comfort: worst left at ~46° wrist flexion and ~22° sideways.
        ctr = b.eye + q @ (V(fwd=0.2 + zoom, up=-0.07))
        return Pose(
            spine=rot(yaw=yaw * 0.25), upper_chest=rot(yaw=yaw * 0.25),
            arm_R=arm("R", ctr + q @ V(right=0.09, up=-0.06), q @ V(right=-1), q @ V(up=1),
                      V(right=1, up=-0.4, fwd=-0.6)),
            arm_L=arm("L", ctr + q @ V(right=-0.09, up=0.06), q @ V(right=1), q @ V(up=-1),
                      V(right=-1, up=0.8)),
            fingers_R=dict(L_SHAPE), fingers_L=dict(L_SHAPE),
            head=rot(roll=tilt * 0.6, yaw=yaw * 0.3), look=ctr + q @ V(fwd=1.0), look_weight=0.4,
        )
    hold = framed()

    def intro(t):
        return blend(rest, hold, seg(t, 0.05, 1.2))

    def loop(t):
        L = 6.0
        # Scout left and right, push in once, a slight dutch tilt.
        return add(framed(yaw=9 * wave(t, L), zoom=0.04 * wave(t, L / 2, 0.75) + 0.0, tilt=-5 * wave(t, L, 0.25)),
                   hips=rot(roll=0.6 * wave(t, L, 0.5)))

    def outro(t):
        return blend(hold, rest, seg(t, 0.1, 1.2))

    # When the clip is back: the frame drops and she holds up a film card
    # with the video playing on it (the app plays it, muted).
    return {"in": (1.3, intro), "loop": (6.0, loop), "out": (1.3, outro),
            "reveal": (3.9, show_it(b, rest, hold)), "reveal_props": ["film"],
            "prop_times": {"film": {"show_reveal": 0.5, "hide_reveal": 3.25}}}


@motion("holo_type", "local_task", props=["holo"])
def holo_type(b):
    """Working the computer: typing on a holographic keyboard that
    materialises in front of them, eyes on the floating screen."""
    rest = stand(b)
    kb = at(b.hips, up=0.17, fwd=0.3)
    # The floating screen sits off to their left (keeps the face clear
    # for the viewer); see make_holo, which builds it at the same spot.
    SCREEN = at(b.hips, right=-HOLO_SCREEN[0], up=HOLO_SCREEN[1], fwd=HOLO_SCREEN[2])

    def typing(dx_l=0.0, dx_r=0.0, look_up=0.0):
        return Pose(
            spine=rot(pitch=5), chest=rot(pitch=2),
            arm_L=arm("L", kb + V(right=-0.11 + dx_l, up=0.015, fwd=-0.06), V(fwd=1, up=-0.25, right=0.15),
                      V(right=1, up=0.2), V(right=-0.8, up=-1, fwd=-0.3)),
            arm_R=arm("R", kb + V(right=0.11 + dx_r, up=0.015, fwd=-0.06), V(fwd=1, up=-0.25, right=-0.15),
                      V(right=-1, up=0.2), V(right=0.8, up=-1, fwd=-0.3)),
            fingers_L={"thumb": 0.2, "thumb_op": 0.3, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42, "spread": 0.4},
            fingers_R={"thumb": 0.2, "thumb_op": 0.3, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42, "spread": 0.4},
            look=kb.lerp(SCREEN, look_up), look_weight=0.55 + 0.15 * look_up,
        )
    hold = typing()

    def intro(t):
        return blend(rest, hold, seg(t, 0.1, 1.1))

    def loop(t):
        L = 4.0
        # Keystrokes: each finger presses on its own beat (incommensurate
        # sines, all dividing the loop so it closes), hands drift along
        # the keys, now and then a glance up at the screen.
        presses = {}
        for side, ph in (("L", 0.0), ("R", 0.37)):
            d = {}
            for i, (f, per) in enumerate((("index", 4 / 11), ("middle", 4 / 9), ("ring", 4 / 7), ("little", 4 / 5))):
                d[f] = 0.22 * max(0.0, wave(t, per, ph + i * 0.13)) ** 3
            d["thumb"] = 0.15 * max(0.0, wave(t, 4 / 6, ph + 0.5)) ** 4
            presses[side] = d
        glance = seg(t, 2.4, 2.7) * (1 - seg(t, 3.2, 3.5))
        p = typing(dx_l=0.02 * wave(t, L / 2), dx_r=0.02 * wave(t, L / 2, 0.4), look_up=0.85 * glance)
        return add(p, fingers_L=presses["L"], fingers_R=presses["R"],
                   arm_L={"hand": V(up=0.008 * wave(t, 4 / 11) ** 2)}, arm_R={"hand": V(up=0.008 * wave(t, 4 / 9, 0.3) ** 2)},
                   hips=rot(roll=0.6 * wave(t, L)), head=rot(roll=2 * wave(t, L, 0.3)))

    def outro(t):
        return blend(hold, rest, seg(t, 0.15, 1.2))

    return {"in": (1.2, intro), "loop": (4.0, loop), "out": (1.3, outro),
            "prop_times": {"holo": {"show_in": 0.55, "hide_out": 0.25}}}


@motion("watch_closely", "record_screen_clip")
def watch_closely(b):
    """Watching the screen recording: leaning in, hand at the chin, the
    other arm folded under the elbow."""
    rest = stand(b)
    chin = at(b.head, right=0.02, up=-0.0, fwd=0.15)
    hold = Pose(
        spine=rot(pitch=6), chest=rot(pitch=4), upper_chest=rot(pitch=2),
        neck=rot(pitch=-5), head=rot(pitch=-3, roll=4),
        look=at(b.eye, fwd=3.0), look_weight=0.85, look_neck=0.5,
        # Palm towards the chin (back, a little to her left): the thumb
        # then points out to her right.
        arm_R=arm("R", chin + V(right=0.0, up=-0.11, fwd=-0.01), V(up=0.9, right=-0.1, fwd=0.25),
                  V(right=0.92, up=0.18, fwd=-0.28), V(right=0.2, up=-1, fwd=0.1), twist=0.4),
        # Loose fist: the chin rests on the curled fingers.
        fingers_R={"thumb": 0.3, "thumb_op": 0.4, "index": 0.6, "middle": 0.8, "ring": 0.85, "little": 0.9},
        arm_L=arm("L", at(b.hips, right=0.1, up=0.15, fwd=0.17), V(right=1, fwd=0.15), V(up=1, fwd=0.2),
                  V(right=-1, up=-0.5, fwd=0.1)),
        fingers_L={"thumb": 0.2, "thumb_op": 0.3, "index": 0.3, "middle": 0.35, "ring": 0.4, "little": 0.45},
        hips_off=V(fwd=-0.01),
    )

    def intro(t):
        return blend(rest, hold, seg(t, 0.05, 1.2))

    def loop(t):
        L = 5.0
        nod = math.exp(-((t - 2.0) / 0.25) ** 2)
        return add(hold, head=rot(pitch=4 * nod, roll=2 * wave(t, L, 0.2), yaw=3 * wave(t, L / 2, 0.1)),
                   spine=rot(pitch=1.2 * wave(t, L, 0.6)),
                   fingers_R={"index": 0.15 * max(0.0, wave(t, L / 3)) ** 2},
                   hips=rot(roll=0.7 * wave(t, L)), hips_off=V(right=0.005 * wave(t, L)))

    def outro(t):
        return blend(hold, rest, seg(t, 0.05, 1.2))

    return {"in": (1.3, intro), "loop": (5.0, loop), "out": (1.3, outro), "prop_times": {}}


# ── props ───────────────────────────────────────────────────────────────

# Where each prop sits in the hand: a local transform under the hand bone,
# in the VRM 1.0 normalized frame (identity rest rotation, glTF axes:
# +X character's left, +Y up, +Z forward). Filled in from the Blender
# placement below so preview and app agree.
PROPS = {
    "phone": {"bone": "rightHand"},
    "palette": {"bone": "leftHand"},
    "brush": {"bone": "rightHand"},
    "holo": {"bone": "hips"},
    "photo": {"bone": "rightHand"},
    "film": {"bone": "rightHand"},
}
# glTF (x left, y up, z forward) of the holo screen centre, relative to the hips.
HOLO_SCREEN = (0.3, 0.42, 0.26)
BONE_OF = {"rightHand": "right_hand", "leftHand": "left_hand", "hips": "hips"}


def _material(name, color, rough=0.5, metal=0.0, emit=None, alpha=None, image=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if emit is not None:
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        if alpha is not None:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    elif emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
    if emit is not None:
        # The app renders without tone mapping: emission above 1 clips.
        bsdf.inputs["Emission Strength"].default_value = 1.0
    if alpha is not None:
        if image is None:
            bsdf.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


def _mesh_object(name, build):
    import bmesh
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _g(x, y, z):
    """glTF prop-space point → Blender object space (the exporter maps it
    back: Blender Z up becomes glTF Y up)."""
    return Vector((x, -z, y))


def _join(objs, name):
    for o in bpy.data.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def make_palette():
    """A painter's palette with paint dabs: 19 × 26 cm, face +Z (glTF)."""
    import bmesh

    def disc(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=0.5, radius2=0.5, depth=1.0)
        for v in bm.verts:
            x, y, z = v.co
            # Kidney-ish: pinch one side in.
            pinch = 1.0 - 0.18 * math.exp(-((math.atan2(y, x) - 2.6) / 0.45) ** 2)
            v.co = _g(x * 0.19 * pinch, y * 0.26 * pinch, z * 0.006)
    pal = _mesh_object("palette", disc)
    pal.data.materials.append(_material("palette_wood", (0.55, 0.36, 0.2), rough=0.6))
    blobs = []
    colors = [(0.85, 0.12, 0.12), (0.95, 0.75, 0.1), (0.15, 0.45, 0.9), (0.2, 0.7, 0.3), (0.95, 0.95, 0.95), (0.6, 0.2, 0.75)]
    for i, col in enumerate(colors):
        a = math.radians(-60 + i * 38)
        cx, cy = 0.065 * math.cos(a), 0.095 * math.sin(a)

        def blob(bm, cx=cx, cy=cy):
            bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=6, radius=1.0)
            for v in bm.verts:
                x, y, z = v.co
                v.co = _g(cx + x * 0.016, cy + y * 0.014, 0.003 + max(0.0, z) * 0.006)
        o = _mesh_object(f"blob{i}", blob)
        o.data.materials.append(_material(f"paint{i}", col, rough=0.25))
        blobs.append(o)
    return _join([pal] + blobs, "palette")


PHOTO_SIZE = (0.13, 0.155)      # an instant print, a little oversized so it reads on screen
PHOTO_WINDOW = 0.11             # the square picture window
PHOTO_TOP_MARGIN = 0.01


def make_photo():
    """An instant-photo print: white card, face +Z (glTF), long side +Y,
    and in front of its window a separate square panel named
    `photo_picture` (UVs 0..1, u to the right and v up as you face the
    print) that the app paints with the finished picture."""
    import bmesh
    w, h = PHOTO_SIZE

    def card(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            x, y, z = v.co
            v.co = _g(x * w, y * h, z * 0.002)
    frame = _mesh_object("photo", card)
    frame.data.materials.append(_material("photo_card", (0.95, 0.94, 0.9), rough=0.6))
    s = PHOTO_WINDOW
    cy = h / 2 - PHOTO_TOP_MARGIN - s / 2

    def window(bm):
        uv = bm.loops.layers.uv.new()
        corners = [(-s / 2, -s / 2), (s / 2, -s / 2), (s / 2, s / 2), (-s / 2, s / 2)]
        # 1.5 mm proud of the card face (0.2 mm z-fought into blotches).
        vs = [bm.verts.new(_g(x, cy + y, 0.0025)) for x, y in corners]
        f = bm.faces.new(vs)
        for loop, (x, y) in zip(f.loops, corners):
            loop[uv].uv = (x / s + 0.5, y / s + 0.5)
        f.normal_update()
    # Picture panels end in `_picture` (the app finds them by that), each
    # with its own name: a shared one came out as `photo_image.001` on
    # the second prop.
    image = _mesh_object("photo_picture", window)
    image.data.materials.append(_material("photo_picture", (0.5, 0.5, 0.5), rough=0.8))
    image.parent = frame
    return frame


FILM_SIZE = (0.17, 0.11)        # a landscape film card
FILM_WINDOW = (0.144, 0.081)    # 16:9, where the video plays


def make_film():
    """A film card for the video preview: dark card with sprocket holes
    along the top and bottom, landscape (long side +X glTF, face +Z), and
    a 16:9 `film_picture` panel in front for the app to play the clip on."""
    import bmesh
    w, h = FILM_SIZE

    def card(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            x, y, z = v.co
            v.co = _g(x * w, y * h, z * 0.003)
    frame = _mesh_object("film", card)
    frame.data.materials.append(_material("film_card", (0.06, 0.06, 0.07), rough=0.5))
    holes = []
    n = 9
    for row in (-1, 1):
        for i in range(n):
            cx = -w / 2 + (i + 0.5) * w / n
            cy = row * (h / 2 - 0.0075)

            def hole(bm, cx=cx, cy=cy):
                corners = [(-0.0045, -0.003), (0.0045, -0.003), (0.0045, 0.003), (-0.0045, 0.003)]
                bm.faces.new([bm.verts.new(_g(cx + x, cy + y, 0.0025)) for x, y in corners])
            o = _mesh_object(f"sprocket{row}{i}", hole)
            o.data.materials.append(_material(f"sprocket{row}{i}", (0.85, 0.85, 0.82), rough=0.6))
            holes.append(o)
    frame = _join([frame] + holes, "film")
    sw, sh = FILM_WINDOW

    def window(bm):
        uv = bm.loops.layers.uv.new()
        corners = [(-sw / 2, -sh / 2), (sw / 2, -sh / 2), (sw / 2, sh / 2), (-sw / 2, sh / 2)]
        f = bm.faces.new([bm.verts.new(_g(x, y, 0.003)) for x, y in corners])
        for loop, (x, y) in zip(f.loops, corners):
            loop[uv].uv = (x / sw + 0.5, y / sh + 0.5)
    image = _mesh_object("film_picture", window)
    image.data.materials.append(_material("film_picture", (0.2, 0.2, 0.22), rough=0.8))
    image.parent = frame
    return frame


def make_brush():
    """A paint brush, 21 cm, handle along +Y (glTF), loaded tip at +Y."""
    import bmesh

    def part(r0, r1, y0, y1):
        def b(bm):
            bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=r0, radius2=r1, depth=1.0)
            for v in bm.verts:
                x, y, z = v.co
                v.co = _g(x, y0 + (z + 0.5) * (y1 - y0), y)
        return b
    handle = _mesh_object("brush", part(0.0035, 0.0048, -0.095, 0.075))
    handle.data.materials.append(_material("brush_handle", (0.62, 0.1, 0.1), rough=0.35))
    ferrule = _mesh_object("ferrule", part(0.0048, 0.0042, 0.075, 0.098))
    ferrule.data.materials.append(_material("brush_ferrule", (0.75, 0.75, 0.78), rough=0.25, metal=1.0))
    tip = _mesh_object("tip", part(0.0042, 0.0004, 0.098, 0.124))
    tip.data.materials.append(_material("brush_tip", (0.15, 0.4, 0.9), rough=0.3))
    return _join([handle, ferrule, tip], "brush")


def holo_image(kind):
    """Glowing UI lines on a clear panel: a key grid, or a screen of
    abstract code rows."""
    W, H = (256, 96) if kind == "keys" else (256, 160)
    img = bpy.data.images.new(f"holo_{kind}", W, H, alpha=True)
    px = [0.0] * (W * H * 4)
    glow = (0.35, 0.85, 1.0)

    def put(x, y, a):
        if 0 <= x < W and 0 <= y < H:
            i = (y * W + x) * 4
            px[i:i + 4] = [glow[0], glow[1], glow[2], max(px[i + 3], a)]
    for y in range(H):
        for x in range(W):
            edge = x < 3 or y < 3 or x >= W - 3 or y >= H - 3
            put(x, y, 0.9 if edge else 0.12)
    if kind == "keys":
        rows, cols = 5, 14
        for r in range(rows):
            for c in range(cols):
                x0 = 8 + c * (W - 16) // cols
                y0 = 8 + r * (H - 16) // rows
                x1 = x0 + (W - 16) // cols - 3
                y1 = y0 + (H - 16) // rows - 3
                for x in range(x0, x1):
                    put(x, y0, 0.75)
                    put(x, y1, 0.75)
                for y in range(y0, y1):
                    put(x0, y, 0.75)
                    put(x1, y, 0.75)
    else:
        import random
        rnd = random.Random(7)
        y = H - 16
        while y > 12:
            x = 12 + rnd.randrange(0, 4) * 12
            length = rnd.randrange(30, W - 40 - x)
            for xx in range(x, x + length):
                for dy in (0, 1, 2):
                    put(xx, y - dy, 0.8)
            y -= 12
    img.pixels = px
    img.pack()
    return img


def make_holo():
    """A holographic keyboard at hand height and a floating screen above
    it, placed relative to the hips (the prop's origin)."""
    import bmesh

    def panel(w, h, center, tilt_deg, facing):
        """A quad w × h (glTF metres) centred at `center`, normal along
        `facing` tilted by `tilt_deg` about X."""
        def b(bm):
            uv = bm.loops.layers.uv.new()
            q = Quaternion((1, 0, 0), math.radians(tilt_deg))
            corners = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
            vs = []
            for cx, cy in corners:
                if facing == "up":
                    p = Vector((cx, 0, -cy))
                else:
                    p = Vector((cx, cy, 0))
                p = q @ p
                vs.append(bm.verts.new(_g(center[0] + p.x, center[1] + p.y, center[2] + p.z)))
            f = bm.faces.new(vs)
            for loop, (cx, cy) in zip(f.loops, corners):
                loop[uv].uv = (cx / w + 0.5, cy / h + 0.5)
        return b
    keys = _mesh_object("holo", panel(0.34, 0.12, (0.0, 0.165, 0.30), 12, "up"))
    keys.data.materials.append(_material("holo_keys", (0.35, 0.85, 1.0), emit=(0.35, 0.85, 1.0), alpha=0.6,
                                         image=holo_image("keys")))
    screen = _mesh_object("holo_screen", panel(0.3, 0.19, tuple(HOLO_SCREEN), -10, "front"))
    # Turned to face them from their left.
    for v in screen.data.vertices:
        c = _g(*HOLO_SCREEN)
        v.co = c + Quaternion((0, 0, 1), math.radians(-38)) @ (v.co - c)
    screen.data.materials.append(_material("holo_screen", (0.35, 0.85, 1.0), emit=(0.35, 0.85, 1.0), alpha=0.6,
                                           image=holo_image("screen")))
    obj = _join([keys, screen], "holo")
    for poly in obj.data.polygons:
        poly.use_smooth = False
    return obj


def make_phone():
    """A plain modern phone: 7.2 × 15 × 0.8 cm, dark body, lit chat screen.
    Local axes (glTF): long side +Y, screen faces +Z."""
    import bmesh
    w, h, d = 0.072, 0.15, 0.008
    mesh = bpy.data.meshes.new("phone")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        # Blender object axes for a glTF-exported prop: glTF +Y = Blender +Z,
        # glTF +Z = Blender −Y.
        v.co = Vector((v.co.x * w, v.co.y * d, v.co.z * h))
    # Round the four corners of the outline (the edges running through the
    # phone's thickness, Blender Y).
    corners = [e for e in bm.edges
               if abs(e.verts[0].co.x - e.verts[1].co.x) < 1e-6 and abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
    bmesh.ops.bevel(bm, geom=corners, offset=0.009, segments=5, affect="EDGES")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("phone", mesh)
    bpy.context.scene.collection.objects.link(obj)
    body = bpy.data.materials.new("phone_body")
    body.use_nodes = True
    body.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.06, 1)
    body.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
    screen = bpy.data.materials.new("phone_screen")
    screen.use_nodes = True
    nt = screen.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    img = phone_screen_image()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    obj.data.materials.append(body)
    obj.data.materials.append(screen)
    # Screen = the front face (−Y in Blender), inset a little.
    import bmesh as _bm
    bm = _bm.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    front = max(bm.faces, key=lambda f: (-f.normal.y) * f.calc_area())
    inset = _bm.ops.inset_individual(bm, faces=[front], thickness=0.0035, depth=0.0)
    front.material_index = 1
    uv = bm.loops.layers.uv.verify()
    for loop in front.loops:
        x, z = loop.vert.co.x, loop.vert.co.z
        loop[uv].uv = (x / (w - 0.007) + 0.5, z / (h - 0.007) + 0.5)
    bm.to_mesh(mesh)
    bm.free()
    return obj


def phone_screen_image():
    """A small chat screen: message bubbles on a dark background."""
    W, H = 128, 256
    img = bpy.data.images.new("phone_screen", W, H)
    px = [0.0] * (W * H * 4)

    def rect(x0, y0, x1, y1, c):
        for y in range(max(0, y0), min(H, y1)):
            for x in range(max(0, x0), min(W, x1)):
                i = (y * W + x) * 4
                px[i:i + 4] = [c[0], c[1], c[2], 1.0]
    rect(0, 0, W, H, (0.06, 0.07, 0.1))
    rect(0, H - 22, W, H, (0.12, 0.13, 0.18))          # header bar
    bubbles = [(1, 30, 70), (0, 60, 90), (1, 100, 120), (0, 132, 80), (1, 164, 100), (0, 196, 60)]
    for mine, y, wdt in bubbles:
        top = H - 26 - y
        c = (0.27, 0.55, 0.98) if mine else (0.24, 0.25, 0.3)
        x0 = W - 8 - wdt if mine else 8
        rect(x0, top - 22, x0 + wdt, top, c)
    rect(6, 6, W - 6, 22, (0.16, 0.17, 0.22))            # input field
    img.pixels = px
    img.pack()
    return img


PROP_BUILDERS = {"phone": make_phone, "palette": make_palette, "brush": make_brush, "holo": make_holo,
                 "photo": make_photo, "film": make_film}


# ── keying + export ─────────────────────────────────────────────────────

def key_clip(rig, solver, name, dur, fn):
    arm = rig.arm
    arm.animation_data_clear()
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    n = max(2, int(round(dur * FPS)) + 1)
    prev = {}
    for i in range(n):
        t = min(dur, i / FPS)
        local, hips_off = solver.solve(fn(t))
        for h, bname in rig.bone.items():
            pb = arm.pose.bones[bname]
            q = local.get(h, Quaternion())
            rq = rig.rest_q[h]
            basis = rq.inverted() @ q @ rq
            if h in prev:
                basis.make_compatible(prev[h])
            prev[h] = basis.copy()
            pb.rotation_quaternion = basis
            pb.keyframe_insert("rotation_quaternion", frame=i + 1)
        hips = arm.pose.bones[rig.bone["hips"]]
        rq = rig.rest_q["hips"]
        hips.location = rq.inverted() @ hips_off
        hips.keyframe_insert("location", frame=i + 1)
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = n
    return act, n


def export_vrma(rig, path):
    bpy.context.scene.render.fps = FPS
    bpy.context.view_layer.objects.active = rig.arm
    bpy.ops.export_scene.vrma(filepath=path, armature_object_name=rig.arm.name)


# ── preview ─────────────────────────────────────────────────────────────

def setup_preview(rig):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x = 360
    scene.render.resolution_y = 540
    scene.render.film_transparent = False
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(cam, pos, target):
    cam.location = pos
    d = (target - pos).normalized()
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_frames(name, frames, cam, views):
    out = []
    for vi, (pos, tgt) in enumerate(views):
        aim(cam, pos, tgt)
        for f in frames:
            bpy.context.scene.frame_set(f)
            path = os.path.join(PREVIEW_DIR, f"{name}_v{vi}_{f:03d}.png")
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            out.append(path)
    return out


def attach_preview_prop(rig, obj, bone_h, local_pos, local_rot):
    """Parent a prop to a hand bone the way the app does: a child of the
    normalized hand, i.e. rest transform = hand position + glTF offset."""
    arm = rig.arm
    bname = rig.bone[bone_h]
    # Rest world matrix the prop should have (pose at rest).
    p = rig.head[bone_h] + Vector((local_pos[0], -local_pos[2], local_pos[1]))
    gq = Quaternion((local_rot[3], local_rot[0], local_rot[1], local_rot[2]))
    # glTF→Blender basis change, then the prop's own glTF→Blender axes
    # (the exporter's +Y up conversion) so its Blender-space mesh lines up.
    C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
    R = C @ gq.to_matrix() @ C.inverted()
    obj.matrix_world = Matrix.Translation(p) @ R.to_4x4()
    # Bone parenting relative to the bone's REST pose.
    mw = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bname
    bone = arm.data.bones[bname]
    # A bone child sits at the bone TAIL; express the rest transform there.
    rest_tail = arm.matrix_world @ bone.matrix_local @ Matrix.Translation((0, bone.length, 0))
    obj.matrix_parent_inverse = rest_tail.inverted()
    obj.matrix_basis = mw


# ── main ────────────────────────────────────────────────────────────────

# Prop grips in the hand's normalized frame (glTF axes), authored against
# the poses above. Phone: palm-centre a few cm past the wrist along the
# fingers, laid in the palm with its screen facing out of it.
def grip(fingers, palm, thumb, along, toward_thumb, off_palm, long_tilt_deg, face="palm"):
    """A prop's local transform under the hand, from the hand's T-pose
    axes (glTF): `fingers` wrist→fingertips, `palm` out of the palm,
    `thumb` towards the thumb side. The prop's long side (+Y) runs along
    the fingers tilted `long_tilt_deg` towards the thumb; its face (+Z)
    looks out of the palm (or away from it)."""
    f, n, t = Vector(fingers), Vector(palm), Vector(thumb)
    a = math.radians(long_tilt_deg)
    y = (f * math.cos(a) + t * math.sin(a)).normalized()
    z = n if face == "palm" else -n
    x = y.cross(z).normalized()
    z = x.cross(y)
    q = Matrix((x, y, z)).transposed().to_quaternion()
    pos = f * along + t * toward_thumb + n * off_palm
    return {"position": [round(v, 4) for v in pos], "rotation": [round(v, 5) for v in (q.x, q.y, q.z, q.w)]}


# T-pose hands in glTF: right fingers −X, left +X; palms −Y; thumbs +Z.
GRIPS = {
    # In the palm, fingers wrapped round its left edge, thumb over the
    # screen, screen facing out of the palm.
    # Resting on the fingers (not sunk in the palm), so they cradle its
    # back and only their tips curl round its far edge.
    "phone": grip((-1, 0, 0), (0, -1, 0), (0, 0, 1), along=0.06, toward_thumb=0.01,
                  off_palm=0.028, long_tilt_deg=40),
    # Flat on the upturned left palm, reaching out past the thumb.
    "palette": grip((1, 0, 0), (0, -1, 0), (0, 0, 1), along=0.075, toward_thumb=0.05,
                    off_palm=0.022, long_tilt_deg=55),
    # Pinched between thumb and forefinger, tip out past the fingers.
    "brush": grip((-1, 0, 0), (0, -1, 0), (0, 0, 1), along=0.075, toward_thumb=0.022,
                  off_palm=0.014, long_tilt_deg=22),
    # Built in place around the hips.
    "holo": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0]},
    # Held up by its lower edge in front of the palm, picture facing out.
    "photo": grip((-1, 0, 0), (0, -1, 0), (0, 0, 1), along=0.085, toward_thumb=0.0,
                  off_palm=0.022, long_tilt_deg=0),
    # Same hold, landscape: the short side runs up the fingers, high
    # enough that the card covers the fingertips and clears the cuff.
    "film": grip((-1, 0, 0), (0, -1, 0), (0, 0, 1), along=0.085, toward_thumb=0.0,
                 off_palm=0.023, long_tilt_deg=0),
}


def _swing_twist(q, axis):
    """Split q into swing ⟂ axis and twist about it; twist angle in degrees."""
    axis = axis.normalized()
    proj = axis * axis.dot(Vector(q[1:]))
    tw = Quaternion((q.w, *proj))
    if tw.magnitude < 1e-9:
        return q, 180.0
    tw.normalize()
    ang = 2 * math.degrees(math.atan2(Vector(tw[1:]).dot(axis), tw.w))
    if ang > 180:
        ang -= 360
    if ang < -180:
        ang += 360
    return q @ tw.inverted(), ang


def report(rig, solver, body):
    """Joint check for every clip (`--report`): per arm, the elbow bend,
    the forearm's twist, the wrist's bend / sideways tilt / twist, and the
    worst frame-to-frame jump (a flip shows up as a jump)."""
    for mid in (WANTED if WANTED and WANTED != ["all"] else list(MOTIONS)):
        parts = MOTIONS[mid]["build"](body)
        for part in ("in", "loop", "out", "reveal"):
            if part not in parts:
                continue
            dur, fn = parts[part]
            stats = {}
            prev = {}
            n = int(round(dur * FPS)) + 1
            for i in range(n):
                local, _ = solver.solve(fn(min(dur, i / FPS)))
                for side in ("left", "right"):
                    up, lo, hand = f"{side}_upper_arm", f"{side}_lower_arm", f"{side}_hand"
                    r2 = rig.child_dir(lo, hand)
                    sw, fore_tw = _swing_twist(local[lo], r2)
                    elbow = math.degrees(sw.angle)
                    f_rest, palm_rest = solver.hand_rest[side]
                    hsw, wrist_tw = _swing_twist(local[hand], f_rest)
                    lateral = f_rest.cross(palm_rest).normalized()
                    sw_axis, sw_ang = hsw.to_axis_angle()
                    flex = math.degrees(sw_ang) * sw_axis.dot(lateral)
                    dev = math.degrees(sw_ang) * sw_axis.dot(palm_rest)
                    vals = {"elbow": elbow, "fore_tw": fore_tw, "wrist_flex": flex, "wrist_dev": dev, "wrist_tw": wrist_tw}
                    for k, v in vals.items():
                        s = stats.setdefault((side, k), [1e9, -1e9, 0.0])
                        s[0], s[1] = min(s[0], v), max(s[1], v)
                        if (side, k) in prev:
                            s[2] = max(s[2], abs(v - prev[(side, k)]))
                        prev[(side, k)] = v
            line = []
            for side in ("left", "right"):
                bits = [f"{k} {stats[(side, k)][0]:.0f}..{stats[(side, k)][1]:.0f} (jump {stats[(side, k)][2]:.0f})"
                        for k in ("elbow", "fore_tw", "wrist_flex", "wrist_dev", "wrist_tw")]
                line.append(f"  {side[0].upper()}: " + " | ".join(bits))
            print(f"REPORT {mid}_{part}\n" + "\n".join(line))


def main():
    rig = import_author_vrm()
    if "--report" in ARGS:
        report(rig, Solver(rig), Body(rig))
        return
    solver = Solver(rig)
    body = Body(rig)
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.join(OUT_DIR, "props"), exist_ok=True)
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    manifest = {"fps": FPS, "motions": {}, "props": {}}
    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    cam = setup_preview(rig) if PREVIEW_DIR else None
    if PREVIEW_DIR:
        os.makedirs(PREVIEW_DIR, exist_ok=True)
    wanted = WANTED if WANTED and WANTED != ["all"] else list(MOTIONS)
    props_built = {}
    for mid in wanted:
        spec = MOTIONS[mid]
        parts = spec["build"](body)
        for other in props_built.values():
            for o in [other, *other.children_recursive]:
                o.animation_data_clear()
                o.hide_render = True
        prop_objs = []
        for pid in spec["props"]:
            if pid not in props_built:
                obj = PROP_BUILDERS[pid]()
                props_built[pid] = obj
                if EXPORT:
                    for o in bpy.data.objects:
                        o.select_set(False)
                    obj.select_set(True)
                    for child in obj.children_recursive:   # a print's picture panel
                        child.select_set(True)
                    keep = obj.matrix_world.copy()
                    obj.matrix_world = Matrix()
                    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT_DIR, "props", f"{pid}.glb"),
                                              use_selection=True, export_format="GLB",
                                              export_apply=True, export_animations=False)
                    obj.matrix_world = keep
            obj = props_built[pid]
            g = GRIPS[pid]
            bone_h = BONE_OF[PROPS[pid]["bone"]]
            attach_preview_prop(rig, obj, bone_h, g["position"], g["rotation"])
            prop_objs.append(obj)
            manifest["props"][pid] = {"file": f"props/{pid}.glb", "bone": PROPS[pid]["bone"],
                                      "position": g["position"], "rotation": g["rotation"]}
        entry = {"tool": spec["tool"], "props": {}}
        reveal_props = parts.get("reveal_props", [])
        for part in ("in", "loop", "out", "reveal"):
            if part not in parts:
                continue
            dur, fn = parts[part]
            act, n = key_clip(rig, solver, f"{mid}_{part}", dur, fn)
            fname = f"{mid}_{part}.vrma"
            if EXPORT:
                export_vrma(rig, os.path.join(OUT_DIR, fname))
            entry[part] = {"file": fname, "duration": round((n - 1) / FPS, 3)}
            if PREVIEW_DIR:
                for obj in prop_objs:
                    # Keyed visibility for the preview: shown from the start
                    # of the part unless it appears in it (`show_<part>`),
                    # gone after `hide_<part>`. The intro's props come in at
                    # show_in; the reveal's own props only exist in it.
                    pt = parts["prop_times"].get(obj.name, {})
                    only_reveal = obj.name in reveal_props
                    visible_at_start = part in ("loop", "out", "reveal") and not only_reveal
                    keys = [(1, not visible_at_start)]
                    if f"show_{part}" in pt:
                        keys.append((int(pt[f"show_{part}"] * FPS) + 1, False))
                    if f"hide_{part}" in pt:
                        keys.append((int(pt[f"hide_{part}"] * FPS) + 1, True))
                    for o in [obj, *obj.children_recursive]:
                        o.animation_data_clear()
                        for frame, hidden in keys:
                            o.hide_render = hidden
                            o.keyframe_insert("hide_render", frame=frame)
                frames = sorted(set([1, n // 4, n // 2, (3 * n) // 4, n]))
                c = body.chest
                views = [(c + V(fwd=2.2, up=0.05, right=0.25), c + V(up=-0.1)),
                         (c + V(fwd=1.1, up=0.25, right=1.6), c + V(up=-0.1)),
                         (c + V(fwd=1.05, up=0.3, right=0.45), c + V(up=0.02, fwd=0.18))]
                if "--close" in ARGS:
                    # `--close right,up,fwd`: two close cameras on that point
                    # (character frame, metres from the feet) — over the
                    # shoulder and from the front-side.
                    x, y, z = (float(v) for v in ARGS[ARGS.index("--close") + 1].split(","))
                    p = V(right=x, up=y, fwd=z)
                    views = [(p + V(up=0.3, fwd=-0.12, right=-0.05), p),
                             (p + V(up=0.08, fwd=0.32, right=0.22), p)]
                render_frames(f"{mid}_{part}", frames, cam, views)
                for obj in prop_objs:
                    for o in [obj, *obj.children_recursive]:
                        o.animation_data_clear()
        for pid in spec["props"]:
            entry["props"][pid] = parts["prop_times"].get(pid, {})
        if reveal_props:
            entry["reveal_props"] = reveal_props
        if parts.get("effect"):
            entry["effect"] = parts["effect"]
        manifest["motions"][mid] = entry
    if EXPORT:
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
            fh.write("\n")
    print("TOOL MOTIONS DONE", wanted)


# The roam motions (tools/motion/roam_motions) import this file for its rig,
# solver and keying, so it only builds when run itself.
if __name__ == "__main__":
    main()
