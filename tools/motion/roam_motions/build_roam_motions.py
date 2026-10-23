"""Roam motions: the poses a companion uses while roaming the desktop in
mascot mode (web/src/models/roam_director.js) — sitting on a window's top
edge, hanging from something on the screen, falling and landing, eating
what they grabbed, carrying it off, napping, peeking in from a screen edge
and throwing. Walking is the bundled walk loop; these are the contact poses
it can't give, the ones that have to line up with an edge on the screen.

Built with the tool motions' rig, IK solver and keying (imported from
../tool_motions/build_tool_motions.py), run the same way:

    blender.exe -b --python tools/motion/roam_motions/build_roam_motions.py -- \
        <repo root> [all|<clip id>...] [--preview <dir>] [--no-export]

Each clip is one file in assets/vrma/roam/: loops are seamless (sine
terms whose periods divide the loop), one-shots start from the pose the app
fades out of and end on the standing stance. How the app pins each pose to
the screen (feet on a ledge, hips on it, hands round it) is decided there,
from the bones' live positions, so the clips stay plain VRMA.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tool_motions"))
import build_tool_motions as tm  # noqa: E402
from build_tool_motions import (  # noqa: E402
    CLAW, FIST, FLAT, OPEN, RELAXED_FINGERS, V, Body, Pose, Solver, add, arm, at, blend, mix, rot, seg,
    smooth, stand, wave,
)
from mathutils import Matrix, Quaternion, Vector  # noqa: E402

OUT_DIR = os.path.join(tm.REPO, "assets", "vrma", "roam")
CLIPS = {}


def clip(cid, dur):
    def deco(fn):
        CLIPS[cid] = (dur, fn)
        return fn
    return deco


class RoamSolver(Solver):
    """The tool motions' solver, plus:
    * `feet_free`: the feet follow the shins instead of staying level with
      the floor (lying down, mid-air), where a level foot would bend the
      ankle a right angle;
    * `leg_pole_L` / `leg_pole_R`: which way that knee bends, for poses the
      standing solver's forward knee gets wrong (on the back, knee up; on
      the stomach, knees down)."""

    def solve(self, pose):
        # A blend solves both ends through here and slerps the joints, so
        # the foot eases between level and free on its own.
        local, hips_off = super().solve(pose)
        if isinstance(pose, tm.Blend):
            return local, hips_off
        if pose.get("leg_pole_L") is not None or pose.get("leg_pole_R") is not None:
            self._legs(local, hips_off, pose)
        if pose.get("feet_free"):
            for side in ("left", "right"):
                local[f"{side}_foot"] = rot(pitch=pose["feet_free"])
        return local, hips_off

    def _legs(self, local, hips_off, pose):
        """The standing solver's leg IK again, with the pose's knee poles."""
        r = self.rig
        D, P = self.fk(local, hips_off)
        for side in ("left", "right"):
            pole = pose.get(f"leg_pole_{side[0].upper()}")
            up, lo, foot = f"{side}_upper_leg", f"{side}_lower_leg", f"{side}_foot"
            if pole is None or up not in r.bone:
                continue
            S = P[up]
            T = r.head[foot] + pose.get(f"foot_{side[0].upper()}", Vector())
            l1, l2 = r.length(up, lo), r.length(lo, foot)
            K, T, _ = tm.solve_two_bone(S, T, l1, l2, pole)
            d1, d2 = (K - S).normalized(), (T - K).normalized()
            r1, r2 = r.child_dir(up, lo), r.child_dir(lo, foot)
            W1 = tm.swing_to(r1, d1)
            W2 = tm.swing_to(W1 @ r2, d2) @ W1
            local[up] = D[r.parent[up]].inverted() @ W1
            local[lo] = W1.inverted() @ W2
            local[foot] = W2.inverted()


class Legs:
    """Leg landmarks of the authoring avatar."""

    def __init__(self, rig):
        h = rig.head
        self.rig = rig
        self.hip = {"L": h["left_upper_leg"], "R": h["right_upper_leg"]}
        self.foot = {"L": h["left_foot"], "R": h["right_foot"]}
        self.thigh = rig.length("left_upper_leg", "left_lower_leg")
        self.shin = rig.length("left_lower_leg", "left_foot")
        self.hips = h["hips"]


def foot_at(legs, side, target):
    """The `foot_<side>` offset that puts that foot at `target`."""
    return target - legs.foot[side]


def moved(legs, point, hips_off, hips_q):
    """Where a point of the rest skeleton lands after the hips turn by
    hips_q (about the hips joint) and shift by hips_off."""
    return legs.hips + hips_off + hips_q @ (point - legs.hips)


# ── poses ───────────────────────────────────────────────────────────────

def standing(b):
    """The tool motions' stance with every key a roam pose moves named, so
    a one-shot that ends on it really gets back there: a blend keeps the
    keys only its start has (hips drop, foot offsets, free feet)."""
    return Pose(stand(b), hips=rot(), hips_off=V(), foot_L=V(), foot_R=V(), feet_free=0)


def sit_pose(b, legs, swing_l=0.0, swing_r=0.0):
    """Sitting on an edge, thighs out over it, shins hanging; hands on the
    edge beside the hips. `swing_*` swings a lower leg forward (+) / back."""
    drop = legs.shin * 0.95
    hips_off = V(up=-drop)
    feet = {}
    for side, swing in (("L", swing_l), ("R", swing_r)):
        hip = legs.hip[side] + hips_off
        knee = hip + V(fwd=legs.thigh * 0.92, right=0.02 if side == "R" else -0.02)
        a = math.radians(swing)
        shin = V(up=-math.cos(a), fwd=math.sin(a)) * (legs.shin * 0.97)
        feet[side] = foot_at(legs, side, knee + shin)
    hipL, hipR = legs.hip["L"] + hips_off, legs.hip["R"] + hips_off
    return Pose(
        hips=rot(pitch=-4), hips_off=hips_off,
        spine=rot(pitch=8), chest=rot(pitch=4), upper_chest=rot(pitch=2), neck=rot(), head=rot(pitch=4),
        foot_L=feet["L"], foot_R=feet["R"],
        # Heels of the hands on the edge, fingers forward over it.
        arm_L=arm("L", at(hipL, right=-0.13, up=0.0, fwd=0.07), V(fwd=1, up=-0.35), V(right=1),
                  V(right=-0.4, fwd=-1)),
        arm_R=arm("R", at(hipR, right=0.13, up=0.0, fwd=0.07), V(fwd=1, up=-0.35), V(right=-1),
                  V(right=0.4, fwd=-1)),
        fingers_L={"thumb": 0.2, "thumb_op": 0.3, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42},
        fingers_R={"thumb": 0.2, "thumb_op": 0.3, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42},
        feet_free=-25,
    )


@clip("sit", 3.2)
def sit(b, legs):
    """On a window's top edge: legs swinging in turn, a slow sway."""
    def loop(t):
        L = 3.2
        p = sit_pose(b, legs, swing_l=14 * wave(t, L / 2), swing_r=14 * wave(t, L / 2, 0.5))
        return add(p, spine=rot(roll=1.5 * wave(t, L)), head=rot(roll=3 * wave(t, L, 0.3), yaw=4 * wave(t, L, 0.6)))
    return loop


def hang_pose(b, legs, sway=0.0, kick=0.0):
    """Hanging by both hands from something above the head."""
    reach = sum(b.arm_len) * 0.96
    hand_l = at(b.sh_L, right=-0.07, up=reach)
    hand_r = at(b.sh_R, right=0.07, up=reach)
    return Pose(
        hips=rot(roll=sway), hips_off=V(),
        spine=rot(pitch=-3, roll=-sway * 0.5), chest=rot(), upper_chest=rot(pitch=-2), head=rot(pitch=-6),
        # Overhand grip: palms away from the face, thumbs in.
        arm_L=arm("L", hand_l, V(up=1, fwd=0.1), V(right=1), V(right=-1, fwd=-0.25), twist=0.3),
        arm_R=arm("R", hand_r, V(up=1, fwd=0.1), V(right=-1), V(right=1, fwd=-0.25), twist=0.3),
        fingers_L=dict(FIST), fingers_R=dict(FIST),
        foot_L=V(up=0.06 + 0.05 * max(0.0, kick), fwd=-0.05 + 0.08 * kick),
        foot_R=V(up=0.06 + 0.05 * max(0.0, -kick), fwd=-0.05 - 0.08 * kick),
        feet_free=-30,
    )


@clip("hang", 2.4)
def hang(b, legs):
    """Dangling: a small pendulum swing, the legs kicking."""
    def loop(t):
        L = 2.4
        return hang_pose(b, legs, sway=3 * wave(t, L), kick=wave(t, L / 2, 0.25))
    return loop


def fall_pose(b, legs, t):
    """Mid-air: arms windmilling overhead, legs pedalling."""
    P = 0.5
    def flail(side, phase):
        s = 1 if side == "R" else -1
        sh = b.sh_R if side == "R" else b.sh_L
        ang = 2 * math.pi * (t / P + phase)
        hand = at(sh, right=s * (0.32 + 0.07 * math.cos(ang)), up=0.3 + 0.1 * math.sin(ang), fwd=0.05)
        return arm(side, hand, V(right=s * 0.5, up=1), V(right=-s * 0.3, fwd=1), V(right=s, up=-0.3, fwd=-0.5))
    return Pose(
        hips_off=V(),
        spine=rot(pitch=-6), chest=rot(pitch=-3), upper_chest=rot(pitch=-2),
        head=rot(pitch=-8 + 3 * wave(t, P), roll=4 * wave(t, 2 * P)),
        arm_L=flail("L", 0.0), arm_R=flail("R", 0.5),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
        foot_L=V(up=0.2 + 0.07 * wave(t, P), fwd=0.1 * wave(t, P, 0.25)),
        foot_R=V(up=0.2 + 0.07 * wave(t, P, 0.5), fwd=0.1 * wave(t, P, 0.75)),
        feet_free=-35,
    )


@clip("fall", 1.0)
def fall(b, legs):
    return lambda t: fall_pose(b, legs, t)


@clip("land", 0.9)
def land(b, legs):
    """Touchdown from the fall pose: knees take it, arms out for balance,
    then up to the standing stance."""
    rest = standing(b)
    # Hands down and forward towards the knees: out to the sides they read
    # as a T-pose on screen.
    crouch = mix(rest, Pose(
        hips_off=V(up=-0.2, fwd=-0.04),
        spine=rot(pitch=18), chest=rot(pitch=6), head=rot(pitch=-14),
        arm_L=arm("L", at(b.hips, right=-0.19, up=-0.1, fwd=0.3), V(fwd=0.6, up=-0.8), V(right=1, fwd=0.2), V(right=-1, up=0.3, fwd=-0.6)),
        arm_R=arm("R", at(b.hips, right=0.19, up=-0.1, fwd=0.3), V(fwd=0.6, up=-0.8), V(right=-1, fwd=0.2), V(right=1, up=0.3, fwd=-0.6)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
        feet_free=0,   # level again: blends carry the fall's free feet over otherwise
    ), 1.0)

    def one(t):
        p = blend(fall_pose(b, legs, 0.0), crouch, seg(t, 0.0, 0.14, ease=smooth))
        return blend(p, rest, seg(t, 0.32, 0.9))
    return one


@clip("eat", 2.0)
def eat(b, legs):
    """Holding something to the mouth in both hands and munching."""
    mouth = b.head + V(up=0.0, fwd=0.1)
    rest = stand(b)

    def loop(t):
        L = 2.0
        chew = abs(wave(t, L / 6))
        hold = mix(rest, Pose(
            spine=rot(pitch=5), chest=rot(pitch=2), head=rot(pitch=4 + 4 * chew),
            arm_L=arm("L", mouth + V(right=-0.05, up=-0.05 + 0.012 * chew, fwd=0.08), V(up=0.55, fwd=0.45, right=0.45),
                      V(up=1, fwd=-0.2), V(right=-0.7, up=-1, fwd=-0.2)),
            arm_R=arm("R", mouth + V(right=0.05, up=-0.05 + 0.012 * chew, fwd=0.08), V(up=0.55, fwd=0.45, right=-0.45),
                      V(up=1, fwd=-0.2), V(right=0.7, up=-1, fwd=-0.2)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        ), 1.0)
        return add(hold, hips=rot(roll=0.8 * wave(t, L)), hips_off=V(right=0.006 * wave(t, L)))
    return loop


@clip("carry", 1.0)
def carry(b, legs):
    """Something held overhead in both hands. The app plays only the arms
    of this over the walk loop."""
    top = b.head + V(up=0.3, fwd=0.03)

    def loop(t):
        bob = 0.012 * wave(t, 0.5)
        return Pose(
            arm_L=arm("L", top + V(right=-0.13, up=bob), V(right=1, up=0.35), V(fwd=1), V(right=-1, up=0.2, fwd=-0.3)),
            arm_R=arm("R", top + V(right=0.13, up=bob), V(right=-1, up=0.35), V(fwd=1), V(right=1, up=0.2, fwd=-0.3)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        )
    return loop


@clip("sleep", 4.0)
def sleep(b, legs):
    """Curled up on the right side, facing the viewer, head on the arm."""
    q = rot(roll=-90)
    # Hips down to the floor. Lying on the side, the body's height off the
    # floor is half the shoulders' width (facing the viewer, that's what
    # the screen shows), so the hips sit that high; nudged sideways so the
    # lying body is about centred over the feet's spot.
    hips_off = V(up=-(legs.hips.z - 0.3), right=-0.12)

    def loop(t):
        L = 4.0
        breath = wave(t, L)
        feet = {}
        for side in ("L", "R"):
            hip = moved(legs, legs.hip[side], hips_off, q)
            # Knees drawn up towards the chest: thigh forward, shin back down.
            knee = hip + q @ V(up=-legs.thigh * 0.55, fwd=legs.thigh * 0.8)
            foot = knee + q @ V(up=-legs.shin * 0.85, fwd=-legs.shin * 0.45)
            feet[side] = foot_at(legs, side, foot + (q @ V(right=-0.03)) * (1 if side == "L" else 0))
        head = moved(legs, b.head, hips_off, q)
        chest = moved(legs, b.chest, hips_off, q)
        return Pose(
            hips=q, hips_off=hips_off + V(up=0.003 * breath),
            spine=rot(pitch=10), chest=rot(pitch=6 + 1.2 * breath), upper_chest=rot(pitch=3),
            neck=rot(roll=8), head=rot(roll=10, pitch=4),
            foot_L=feet["L"], foot_R=feet["R"],
            # Under arm: forearm on the floor under the head. Top arm: the
            # hand resting on the floor in front of the chest.
            arm_R=arm("R", head + V(up=-0.13, fwd=0.14, right=0.05), V(right=1, fwd=0.4), V(up=-1),
                      V(up=-1, fwd=-0.3)),
            arm_L=arm("L", chest + V(up=-0.16, fwd=0.22, right=0.05), V(right=1, fwd=0.4), V(up=1, fwd=0.2),
                      V(up=1, fwd=-0.6)),
            fingers_L=dict(RELAXED_FINGERS), fingers_R=dict(RELAXED_FINGERS),
            look=None, feet_free=-30,
        )
    return loop


def peek_pose(b, legs, side, t):
    """Leaning out from behind an edge on the character's `side`... the
    lean goes the other way, the hand on that side holds the edge by the
    face. side "R": the edge is on their right (the screen's left)."""
    s = 1 if side == "R" else -1   # +1: lean to the character's left
    L = 3.0
    bob = wave(t, L)
    sh = b.sh_R if side == "R" else b.sh_L
    return Pose(
        hips=rot(roll=6 * s), hips_off=V(right=-0.04 * s),
        spine=rot(roll=16 * s), chest=rot(roll=13 * s), upper_chest=rot(roll=9 * s + 2 * s * bob),
        neck=rot(roll=-7 * s), head=rot(roll=-10 * s + 3 * s * wave(t, L, 0.3), yaw=4 * s * wave(t, L, 0.6)),
        **{f"arm_{side}": arm(side, at(sh, right=0.14 * (1 if side == "R" else -1), up=0.17, fwd=0.08),
                              V(up=1, fwd=0.15), V(right=-s * 0.3, fwd=1),
                              V(right=0.9 * (1 if side == "R" else -1), up=-0.4, fwd=-0.3)),
           f"fingers_{side}": {"thumb": 0.3, "thumb_op": 0.4, "index": 0.6, "middle": 0.62, "ring": 0.64, "little": 0.66}},
    )


@clip("peek_l", 3.0)
def peek_l(b, legs):
    """Peeking in from the screen's LEFT edge: the edge is on their right."""
    rest = stand(b)
    return lambda t: mix(rest, peek_pose(b, legs, "R", t), 1.0)


@clip("peek_r", 3.0)
def peek_r(b, legs):
    """Peeking in from the screen's RIGHT edge: the edge is on their left."""
    rest = stand(b)
    return lambda t: mix(rest, peek_pose(b, legs, "L", t), 1.0)


@clip("throw", 1.2)
def throw(b, legs):
    """Overhand throw with the right hand (released at ~0.5 s), then back
    to the stance."""
    rest = standing(b)
    wind = mix(rest, Pose(
        spine=rot(yaw=-14, pitch=-3), chest=rot(yaw=-8), head=rot(yaw=14),
        arm_R=arm("R", at(b.sh_R, right=0.12, up=0.18, fwd=-0.12), V(up=1, fwd=-0.3), V(right=-1),
                  V(right=1, up=-0.2, fwd=-0.6)),
        fingers_R=dict(FIST),
        arm_L=arm("L", at(b.sh_L, right=-0.15, up=-0.05, fwd=0.3), V(fwd=1, right=-0.2), V(up=1), V(right=-1, fwd=-0.5)),
        hips_off=V(fwd=-0.02),
    ), 1.0)
    release = mix(rest, Pose(
        spine=rot(yaw=10, pitch=6), chest=rot(yaw=6), head=rot(yaw=-6),
        arm_R=arm("R", at(b.sh_R, right=-0.05, up=0.12, fwd=0.45), V(fwd=1, up=0.4), V(up=1), V(right=1, up=-0.3, fwd=-0.2)),
        fingers_R=dict(OPEN),
        arm_L=arm("L", at(b.hips, right=-0.2, up=0.05, fwd=0.05), V(up=-1, fwd=0.2), V(right=1), V(right=-1, fwd=-0.5)),
        hips_off=V(fwd=0.03),
    ), 1.0)
    follow = mix(release, Pose(
        spine=rot(yaw=14, pitch=12),
        arm_R=arm("R", at(b.hips, right=-0.12, up=0.12, fwd=0.3), V(fwd=1, up=-0.6), V(up=1), V(right=1, up=-0.5, fwd=-0.2)),
    ), 1.0)

    def one(t):
        p = blend(rest, wind, seg(t, 0.0, 0.35))
        p = blend(p, release, seg(t, 0.35, 0.5, ease=smooth))
        p = blend(p, follow, seg(t, 0.5, 0.68))
        return blend(p, rest, seg(t, 0.72, 1.2))
    return one


# ── toys ────────────────────────────────────────────────────────────────
# Playing with the toy box (web/src/models/toys/brains.js): picking a toy
# up, holding, catching and throwing it, the basketball shot, a beach-ball
# volley, a fan's breeze, a hair dryer,
# smoke, a hug, blowing bubbles, reading a note, a hot pepper, opening a
# chest, a bonk on the head. Written to assets/vrma/toys/. The toy itself
# is placed by the app between the hands (or in the right one), so these
# only have to bring the hands where a toy would be; the moments the app
# attaches or lets go of it are noted per clip (brains.js GRAB_MS /
# RELEASE_MS).

TOYS_DIR = os.path.join(tm.REPO, "assets", "vrma", "toys")
TOY_CLIPS = set()


def toy_clip(cid, dur):
    TOY_CLIPS.add(cid)
    return clip(cid, dur)


def hold_pose(b, gap=0.12):
    """Something held in both hands in front of the chest, palms to its
    sides `gap` out from its middle (0.12: a ball 0.22 m across; SMALL_GAP:
    a snack, a cup)."""
    return Pose(
        spine=rot(pitch=3), chest=rot(), upper_chest=rot(), neck=rot(), head=rot(pitch=4),
        arm_L=arm("L", at(b.chest, right=-gap, up=-0.14, fwd=0.3), V(fwd=1, up=0.3), V(up=1),
                  V(right=-1, up=-0.5, fwd=-0.3)),
        arm_R=arm("R", at(b.chest, right=gap, up=-0.14, fwd=0.3), V(fwd=1, up=0.3), V(up=1),
                  V(right=1, up=-0.5, fwd=-0.3)),
        fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        hips=rot(), hips_off=V(), foot_L=V(), foot_R=V(), feet_free=0,
    )


# Small things (brains.js SMALL_R, under 15 cm across): the hands' middles
# this far out from theirs, so the palms close on a donut-sized snack.
SMALL_GAP = 0.065


def floor_reach(b, legs, ahead=0.36, height=0.14, gap=0.11):
    """Squatting, trunk well over, both hands down to something on the
    floor `ahead` in front of the feet, its sides `gap` out."""
    # Hand targets are in the armature's own space: the floor between the
    # feet is its origin.
    hips_off = V(up=-0.5, fwd=-0.1)
    return Pose(
        hips=rot(pitch=8), hips_off=hips_off,
        spine=rot(pitch=34), chest=rot(pitch=16), upper_chest=rot(pitch=10), neck=rot(pitch=-4), head=rot(pitch=-8),
        arm_L=arm("L", V(right=-gap, up=height, fwd=ahead), V(up=-1, fwd=0.5), V(fwd=1, right=0.2),
                  V(right=-1, up=0.2, fwd=-0.4)),
        arm_R=arm("R", V(right=gap, up=height, fwd=ahead), V(up=-1, fwd=0.5), V(fwd=1, right=-0.2),
                  V(right=1, up=0.2, fwd=-0.4)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
    )


def picking_up(b, legs, gap, floor_gap):
    """Squat, both hands to the floor, close them (≈0.62 s), and up with it
    held at the chest (ends on the hold)."""
    rest, hold = standing(b), hold_pose(b, gap)
    reach = floor_reach(b, legs, gap=floor_gap)
    grip = add(reach, fingers_L={"index": 0.3, "middle": 0.32, "ring": 0.34, "little": 0.36},
               fingers_R={"index": 0.3, "middle": 0.32, "ring": 0.34, "little": 0.36})

    def one(t):
        p = blend(rest, reach, seg(t, 0.0, 0.55))
        p = blend(p, grip, seg(t, 0.55, 0.66, ease=smooth))
        return blend(p, hold, seg(t, 0.72, 1.4))
    return one


@toy_clip("pickup", 1.4)
def toy_pickup(b, legs):
    return picking_up(b, legs, 0.12, 0.11)


@toy_clip("pickup_small", 1.4)
def toy_pickup_small(b, legs):
    return picking_up(b, legs, SMALL_GAP, SMALL_GAP)


def holding(b, gap):
    """Holding it at the chest, a small bob and sway."""
    hold = hold_pose(b, gap)

    def loop(t):
        L = 2.0
        return add(hold, hips=rot(roll=0.8 * wave(t, L)), spine=rot(yaw=2 * wave(t, L, 0.3)),
                   arm_L={"hand": V(up=0.006 * wave(t, L / 2))}, arm_R={"hand": V(up=0.006 * wave(t, L / 2))},
                   head=rot(roll=1.5 * wave(t, L, 0.6)))
    return loop


@toy_clip("hold", 2.0)
def toy_hold(b, legs):
    return holding(b, 0.12)


@toy_clip("hold_small", 2.0)
def toy_hold_small(b, legs):
    return holding(b, SMALL_GAP)


def catching(b, gap):
    """Hands up and out to meet it (≈0.26 s), then in to the chest."""
    rest, hold = standing(b), hold_pose(b, gap)
    reach = Pose(
        spine=rot(pitch=-2), head=rot(pitch=-4),
        arm_L=arm("L", at(b.chest, right=-gap - 0.01, up=0.04, fwd=0.44), V(fwd=1, up=0.6), V(up=1, right=0.3),
                  V(right=-1, up=-0.6, fwd=-0.2)),
        arm_R=arm("R", at(b.chest, right=gap + 0.01, up=0.04, fwd=0.44), V(fwd=1, up=0.6), V(up=1, right=-0.3),
                  V(right=1, up=-0.6, fwd=-0.2)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN), hips_off=V(fwd=0.015),
    )

    def one(t):
        p = blend(rest, reach, seg(t, 0.0, 0.24, ease=smooth))
        return blend(p, hold, seg(t, 0.3, 0.9))
    return one


@toy_clip("catch", 0.9)
def toy_catch(b, legs):
    return catching(b, 0.12)


@toy_clip("catch_small", 0.9)
def toy_catch_small(b, legs):
    return catching(b, SMALL_GAP)


@toy_clip("shoot", 1.3)
def toy_shoot(b, legs):
    """A one-handed set shot from the held ball: dip, the ball to the set
    point above the right eye, up onto the toes and the arm out up and
    forward, released at ≈0.56 s, the wrist flicking over and holding."""
    hold, rest = hold_pose(b), standing(b)
    dip = add(hold, hips_off=V(up=-0.09, fwd=-0.01), spine=rot(pitch=4))
    setpt = Pose(
        hips_off=V(up=-0.07), spine=rot(pitch=-2), head=rot(pitch=-10),
        arm_R=arm("R", at(b.head, right=0.07, up=0.13, fwd=0.14), V(up=1, fwd=0.2), V(right=-1, fwd=0.2),
                  V(right=0.3, up=-0.4, fwd=1)),
        arm_L=arm("L", at(b.head, right=-0.06, up=0.2, fwd=0.17), V(up=1, fwd=0.3), V(fwd=-1),
                  V(right=-1, up=-0.3, fwd=0.4)),
        fingers_R=dict(OPEN), fingers_L=dict(OPEN),
    )
    release = Pose(
        hips_off=V(up=0.04), spine=rot(pitch=-4), head=rot(pitch=-14),
        arm_R=arm("R", at(b.sh_R, right=-0.06, up=0.5, fwd=0.32), V(up=1, fwd=0.5), V(right=-1),
                  V(right=0.2, up=-0.2, fwd=1)),
        arm_L=arm("L", at(b.head, right=-0.12, up=0.22, fwd=0.2), V(up=1, fwd=0.3), V(fwd=-1),
                  V(right=-1, up=-0.3, fwd=0.4)),
        fingers_R=dict(OPEN), fingers_L=dict(OPEN),
    )
    # The follow-through: the wrist flicked over, fingers pointing down at
    # the basket.
    follow = Pose(release, hips_off=V(),
                  arm_R=arm("R", at(b.sh_R, right=-0.06, up=0.48, fwd=0.34), V(fwd=1, up=-0.6), V(right=-1),
                            V(right=0.2, up=-0.2, fwd=1)))

    def one(t):
        p = blend(hold, dip, seg(t, 0.0, 0.22, ease=smooth))
        p = blend(p, setpt, seg(t, 0.2, 0.42, ease=smooth))
        p = blend(p, release, seg(t, 0.42, 0.56, ease=smooth))
        p = blend(p, follow, seg(t, 0.56, 0.68, ease=smooth))
        return blend(p, rest, seg(t, 0.9, 1.3))
    return one


@toy_clip("toss", 1.3)
def toy_toss(b, legs):
    """An underhand toss from the held ball: swing down between the knees,
    up and out (let go ≈0.52 s), hands following through."""
    hold, rest = hold_pose(b), standing(b)

    def both(base, right, up, fwd, fdir):
        return dict(
            arm_L=arm("L", at(base, right=-right, up=up, fwd=fwd), fdir, V(up=1, right=0.2), V(right=-1, up=-0.4, fwd=-0.3)),
            arm_R=arm("R", at(base, right=right, up=up, fwd=fwd), fdir, V(up=1, right=-0.2), V(right=1, up=-0.4, fwd=-0.3)))
    low = Pose(hips_off=V(up=-0.12, fwd=-0.02), spine=rot(pitch=18), head=rot(pitch=-10),
               fingers_L=dict(CLAW), fingers_R=dict(CLAW), **both(b.hips, 0.11, -0.08, 0.28, V(fwd=1, up=-0.5)))
    out = Pose(hips_off=V(up=0.01, fwd=0.02), spine=rot(pitch=-2), head=rot(pitch=-4),
               fingers_L=dict(OPEN), fingers_R=dict(OPEN), **both(b.chest, 0.11, 0.0, 0.46, V(fwd=1, up=0.8)))
    high = Pose(spine=rot(pitch=-4), **both(b.head, 0.13, 0.08, 0.34, V(fwd=0.6, up=1)))

    def one(t):
        p = blend(hold, low, seg(t, 0.0, 0.34, ease=smooth))
        p = blend(p, out, seg(t, 0.34, 0.52, ease=smooth))
        p = blend(p, high, seg(t, 0.52, 0.7, ease=smooth))
        return blend(p, rest, seg(t, 0.85, 1.3))
    return one


@toy_clip("breeze", 3.0)
def toy_breeze(b, legs):
    """Face into a fan's breeze: chest open, chin up, arms a little out and
    back, palms to the wind."""
    rest = stand(b)

    def loop(t):
        L = 3.0
        return mix(rest, Pose(
            hips=rot(roll=1.2 * wave(t, L)), spine=rot(pitch=-3), upper_chest=rot(pitch=-5),
            neck=rot(pitch=-4), head=rot(pitch=-12, roll=3 * wave(t, L, 0.3)),
            arm_L=arm("L", at(b.hips, right=-0.3, up=0.04 + 0.01 * wave(t, L, 0.5), fwd=-0.02), V(up=-1, right=-0.4), V(fwd=1),
                      V(right=-1, up=0.1, fwd=-0.6)),
            arm_R=arm("R", at(b.hips, right=0.3, up=0.04 + 0.01 * wave(t, L, 0.5), fwd=-0.02), V(up=-1, right=0.4), V(fwd=1),
                      V(right=1, up=0.1, fwd=-0.6)),
            fingers_L=dict(OPEN), fingers_R=dict(OPEN),
        ), 1.0)
    return loop


@toy_clip("dry_hair", 1.6)
def toy_dry_hair(b, legs):
    """Fingers in the hair at both sides of the head, ruffling it in the
    hair dryer's air, the head rolling with it."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        ruffle = wave(t, L / 4)
        curl = {"index": 0.4 + 0.25 * ruffle, "middle": 0.42 + 0.25 * ruffle, "ring": 0.44 + 0.25 * ruffle,
                "little": 0.46 + 0.25 * ruffle, "thumb": 0.2, "thumb_op": 0.3, "spread": 1.0}
        return mix(rest, Pose(
            neck=rot(roll=-4 * wave(t, L)), head=rot(roll=-8 * wave(t, L), pitch=6),
            arm_L=arm("L", at(b.head, right=-0.12, up=0.07 + 0.015 * ruffle, fwd=0.0), V(up=1, fwd=-0.2), V(fwd=1),
                      V(right=-1, up=0.2, fwd=0.4)),
            arm_R=arm("R", at(b.head, right=0.12, up=0.07 - 0.015 * ruffle, fwd=0.0), V(up=1, fwd=-0.2), V(fwd=1),
                      V(right=1, up=0.2, fwd=0.4)),
            fingers_L=curl, fingers_R=dict(curl),
        ), 1.0)
    return loop


@toy_clip("waft", 0.9)
def toy_waft(b, legs):
    """Clearing smoke from in front of the face: the right hand waves
    across, the left at the chest, a little cough."""
    rest = stand(b)

    def loop(t):
        L = 0.9
        sway = wave(t, L)
        cough = max(0.0, wave(t, L, 0.1)) ** 4
        return mix(rest, Pose(
            spine=rot(pitch=4 + 6 * cough), head=rot(yaw=12, pitch=6 + 4 * cough),
            arm_R=arm("R", at(b.head, right=0.02 + 0.09 * sway, up=-0.04, fwd=0.24), V(up=1, right=-0.2 * sway), V(right=-1, fwd=-0.3),
                      V(right=1, up=-1, fwd=0.1)),
            fingers_R=dict(OPEN),
            arm_L=arm("L", at(b.chest, right=-0.02, up=-0.06, fwd=0.14), V(right=1, up=0.3), V(up=1),
                      V(right=-1, up=-1, fwd=-0.1)),
            fingers_L=dict(FIST),
        ), 1.0)
    return loop


@toy_clip("hug", 2.4)
def toy_hug(b, legs):
    """Arms wrapped round something held to the chest, swaying."""
    rest = stand(b)

    def loop(t):
        L = 2.4
        s = wave(t, L)
        return mix(rest, Pose(
            hips=rot(roll=2.5 * s), spine=rot(yaw=6 * s, pitch=4), chest=rot(pitch=3),
            neck=rot(roll=4 * s), head=rot(roll=8 * s, pitch=10),
            arm_L=arm("L", at(b.chest, right=0.07, up=-0.12, fwd=0.2), V(right=1, fwd=-0.2), V(up=1),
                      V(right=-1, up=-0.6, fwd=0.1)),
            arm_R=arm("R", at(b.chest, right=-0.06, up=-0.06, fwd=0.22), V(right=-1, fwd=-0.2), V(up=1),
                      V(right=1, up=-0.6, fwd=0.1)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        ), 1.0)
    return loop


@toy_clip("blow", 1.6)
def toy_blow(b, legs):
    """A bubble wand held up in the right fist, its ring in front of the
    mouth; a breath in, and blown out through it."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        breath = wave(t, L)
        return mix(rest, Pose(
            upper_chest=rot(pitch=-2 * breath), head=rot(pitch=4 - 3 * breath),
            arm_R=rod_arm("R", at(b.head, right=0.02, up=-0.13, fwd=0.22), V(up=1, fwd=0.1), V(right=-1, fwd=0.3),
                          V(right=1, up=-0.8, fwd=0.2)),
            fingers_R=dict(FIST),
        ), 1.0)
    return loop


@toy_clip("read", 3.0)
def toy_read(b, legs):
    """A note held open in both hands, read line by line."""
    rest = stand(b)

    def loop(t):
        L = 3.0
        line = (t % 1.0) / 1.0
        return mix(rest, Pose(
            spine=rot(pitch=3), neck=rot(pitch=6), head=rot(pitch=14, yaw=-7 + 14 * line),
            arm_L=arm("L", at(b.chest, right=-0.14, up=-0.08, fwd=0.3), V(up=1, right=0.2), V(right=1, fwd=-0.6),
                      V(right=-1, up=-0.6, fwd=-0.2)),
            arm_R=arm("R", at(b.chest, right=0.14, up=-0.08, fwd=0.3), V(up=1, right=-0.2), V(right=-1, fwd=-0.6),
                      V(right=1, up=-0.6, fwd=-0.2)),
            fingers_L={"thumb": 0.1, "thumb_op": 0.5, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42},
            fingers_R={"thumb": 0.1, "thumb_op": 0.5, "index": 0.35, "middle": 0.38, "ring": 0.4, "little": 0.42},
            hips=rot(roll=0.6 * wave(t, L)),
        ), 1.0)
    return loop


@toy_clip("spicy", 0.6)
def toy_spicy(b, legs):
    """Too hot: fanning the mouth with both hands, hopping foot to foot."""
    rest = standing(b)

    def loop(t):
        L = 0.6
        flap = wave(t, L / 2)
        hop = wave(t, L)
        return mix(rest, Pose(
            hips=rot(roll=3 * hop), hips_off=V(up=0.02 * abs(hop)),
            head=rot(yaw=10 * wave(t, L, 0.25), pitch=-6),
            arm_L=arm("L", at(b.head, right=-0.09, up=-0.08 + 0.03 * flap, fwd=0.17), V(up=1, right=-0.3), V(right=1, fwd=0.4),
                      V(right=-1, up=-1, fwd=0.1)),
            arm_R=arm("R", at(b.head, right=0.09, up=-0.08 + 0.03 * flap, fwd=0.17), V(up=1, right=0.3), V(right=-1, fwd=0.4),
                      V(right=1, up=-1, fwd=0.1)),
            fingers_L=dict(OPEN), fingers_R=dict(OPEN),
            foot_L=V(up=0.06 * max(0.0, hop)), foot_R=V(up=0.06 * max(0.0, -hop)),
        ), 1.0)
    return loop


@toy_clip("open", 1.6)
def toy_open(b, legs):
    """Down to a little chest, fingers under the lid's front, flip it up
    (open ≈0.7 s), and up with the arms out: ta-da."""
    rest = standing(b)
    under = floor_reach(b, legs, ahead=0.4, height=0.24, gap=0.13)
    under = add(under, hips_off=V(up=0.08))
    lift = Pose(
        hips_off=V(up=-0.2), spine=rot(pitch=14), head=rot(pitch=-6),
        arm_L=arm("L", at(b.chest, right=-0.18, up=-0.05, fwd=0.4), V(fwd=1, up=0.8), V(right=1),
                  V(right=-1, up=-0.6, fwd=-0.2)),
        arm_R=arm("R", at(b.chest, right=0.18, up=-0.05, fwd=0.4), V(fwd=1, up=0.8), V(right=-1),
                  V(right=1, up=-0.6, fwd=-0.2)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
    )
    tada = Pose(
        spine=rot(pitch=-4), head=rot(pitch=-8),
        arm_L=arm("L", at(b.sh_L, right=-0.38, up=0.3, fwd=0.12), V(up=0.6, right=-1), V(fwd=1),
                  V(right=-0.4, up=-1, fwd=-0.2)),
        arm_R=arm("R", at(b.sh_R, right=0.38, up=0.3, fwd=0.12), V(up=0.6, right=1), V(fwd=1),
                  V(right=0.4, up=-1, fwd=-0.2)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
    )

    def one(t):
        p = blend(rest, under, seg(t, 0.0, 0.5))
        p = blend(p, lift, seg(t, 0.55, 0.8, ease=smooth))
        p = blend(p, tada, seg(t, 0.85, 1.15, ease=smooth))
        return blend(p, rest, seg(t, 1.3, 1.6))
    return one


@toy_clip("rub_head", 1.8)
def toy_rub_head(b, legs):
    """Ow: the right hand rubbing the top of the head."""
    rest = standing(b)

    def rub(t):
        a = 2 * math.pi * t / 0.3
        return Pose(
            spine=rot(pitch=4), neck=rot(pitch=6), head=rot(pitch=10, roll=-6),
            arm_R=arm("R", at(b.head, right=0.03 + 0.02 * math.cos(a), up=0.16, fwd=0.03 + 0.02 * math.sin(a)),
                      V(right=-1, up=0.2), V(fwd=1), V(right=1, up=0.3, fwd=-0.2)),
            fingers_R=dict(FLAT),
        )

    def one(t):
        p = blend(rest, rub(t), seg(t, 0.0, 0.3, ease=smooth))
        return blend(p, rest, seg(t, 1.35, 1.8))
    return one


# Eating, a way per food (brains.js EAT_STYLES): a fingertip pinch, a pop
# into the mouth, peeling, licking, munching along a slice, and a catch in
# the mouth.
PINCH = {"thumb": 0.3, "thumb_op": 0.6, "index": 0.45, "middle": 0.6, "ring": 0.7, "little": 0.75}


@toy_clip("pop_in", 1.0)
def toy_pop_in(b, legs):
    """Something small from the held pose up into the mouth with the right
    fingertips (in ≈0.42 s), the head tipping back to it, the left hand
    down; then the arm back down."""
    hold, rest = hold_pose(b), standing(b)
    mouth = at(b.head, up=0.0, fwd=0.1)
    up = Pose(
        spine=rot(pitch=-1), neck=rot(pitch=-3), head=rot(pitch=-8),
        arm_R=arm("R", mouth + V(right=0.02, up=-0.03, fwd=0.03), V(right=-1, up=0.2, fwd=0.5), V(up=1, fwd=0.2),
                  V(right=1, up=-1, fwd=0.1)),
        fingers_R=dict(PINCH),
        arm_L=rest["arm_L"], fingers_L=dict(RELAXED_FINGERS),
    )

    def one(t):
        p = blend(hold, up, seg(t, 0.0, 0.42, ease=smooth))
        return blend(p, rest, seg(t, 0.55, 1.0))
    return one


@toy_clip("peel", 2.4)
def toy_peel(b, legs):
    """A banana upright in the left fist at the chest, the right fingers
    pinching its tip and pulling a strip of peel down, three times (each
    strip down by ≈0.6, 1.3 and 2.0 s), the eyes on it."""
    rest = stand(b)
    fist = at(b.chest, right=-0.03, up=-0.1, fwd=0.26)
    tip = fist + V(up=0.17, right=0.01)
    left = dict(
        spine=rot(pitch=3), neck=rot(pitch=8), head=rot(pitch=16),
        arm_L=arm("L", fist, V(right=1, fwd=0.2), V(up=1), V(right=-1, up=-0.6, fwd=-0.2)),
        fingers_L=dict(FIST),
    )

    def right(hand):
        return arm("R", hand, V(right=-1, up=0.3, fwd=0.2), V(up=1, fwd=0.2), V(right=1, up=-0.7, fwd=-0.1))

    # Down the right side, the front, the left side of the fruit.
    sides = [V(right=0.05), V(fwd=0.05), V(right=-0.03, fwd=0.04)]
    hold = Pose(rest, **left)

    def one(t):
        p = hold
        for i, side in enumerate(sides):
            t0 = 0.1 + 0.7 * i
            at_tip = Pose(left, arm_R=right(tip + side * 0.3), fingers_R=dict(PINCH))
            pulled = Pose(left, arm_R=right(fist + side + V(up=0.01)), fingers_R=dict(PINCH))
            p = blend(p, at_tip, seg(t, t0, t0 + 0.22, ease=smooth))
            p = blend(p, pulled, seg(t, t0 + 0.25, t0 + 0.5, ease=smooth))
        return blend(p, Pose(left, arm_R=right(fist + V(right=0.12, up=-0.04)), fingers_R=dict(RELAXED_FINGERS)),
                     seg(t, 2.15, 2.4, ease=smooth))
    return one


@toy_clip("lick", 1.6)
def toy_lick(b, legs):
    """An ice cream cone in the right fist under the chin; the head comes
    down to the scoop and licks up it once a loop."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        s = (t % L) / L
        # Down to it (0.15-0.4), the lick up it (0.4-0.65), back (0.65-0.9).
        down = seg(s, 0.15, 0.4, ease=smooth) * (1 - seg(s, 0.65, 0.9, ease=smooth))
        up = seg(s, 0.4, 0.65, ease=smooth) * (1 - seg(s, 0.65, 0.9, ease=smooth))
        return mix(rest, Pose(
            spine=rot(pitch=3 + 3 * down), neck=rot(pitch=4 + 6 * down - 4 * up),
            head=rot(pitch=6 + 10 * down - 12 * up, roll=3 * wave(t, L)),
            arm_R=rod_arm("R", at(b.head, right=0.03, up=-0.16 + 0.02 * up, fwd=0.18), V(up=1, fwd=0.05),
                          V(right=-1, fwd=0.3), V(right=1, up=-0.8, fwd=0.2)),
            fingers_R=dict(FIST),
            arm_L=arm("L", at(b.chest, right=-0.03, up=-0.16, fwd=0.14), V(right=1, up=0.2), V(up=1),
                      V(right=-1, up=-0.8, fwd=-0.1)),
            fingers_L=dict(RELAXED_FINGERS), hips=rot(roll=0.6 * wave(t, L)),
        ), 1.0)
    return loop


@toy_clip("toss_up", 0.9)
def toy_toss_up(b, legs):
    """Something small in the right hand flicked up over the head (let go
    ≈0.3 s), the eyes going up after it."""
    rest = standing(b)
    low = Pose(
        hips_off=V(up=-0.03), head=rot(pitch=4),
        arm_R=arm("R", at(b.chest, right=0.1, up=-0.2, fwd=0.24), V(fwd=1, up=0.3), V(up=1, right=-0.3),
                  V(right=1, up=-1, fwd=-0.1)),
        fingers_R=dict(PINCH),
    )
    flick = Pose(
        hips_off=V(up=0.01), head=rot(pitch=-18), neck=rot(pitch=-6),
        arm_R=arm("R", at(b.chest, right=0.1, up=0.04, fwd=0.3), V(up=1, fwd=0.3), V(right=-1),
                  V(right=1, up=-1, fwd=-0.1)),
        fingers_R=dict(OPEN),
    )

    def one(t):
        p = blend(rest, low, seg(t, 0.0, 0.18, ease=smooth))
        p = blend(p, flick, seg(t, 0.18, 0.3, ease=smooth))
        return blend(p, Pose(rest, head=rot(pitch=-20), neck=rot(pitch=-6)), seg(t, 0.45, 0.9))
    return one


@toy_clip("mouth_catch", 1.3)
def toy_mouth_catch(b, legs):
    """Under something small dropping toward them: knees dip, chin up, arms
    out for balance, and the head snapping forward on it (≈0.55 s), then a
    little bounce up."""
    rest = standing(b)
    ready = Pose(
        hips_off=V(up=-0.06), spine=rot(pitch=-4), upper_chest=rot(pitch=-4),
        neck=rot(pitch=-12), head=rot(pitch=-22),
        arm_L=arm("L", at(b.hips, right=-0.3, up=0.04, fwd=0.06), V(up=-1, right=-0.6), V(fwd=1),
                  V(right=-1, up=0.2, fwd=-0.4)),
        arm_R=arm("R", at(b.hips, right=0.3, up=0.04, fwd=0.06), V(up=-1, right=0.6), V(fwd=1),
                  V(right=1, up=0.2, fwd=-0.4)),
        fingers_L=dict(OPEN), fingers_R=dict(OPEN),
    )
    chomp = Pose(ready, hips_off=V(up=-0.03), neck=rot(pitch=2), head=rot(pitch=8))
    pop = Pose(rest, hips_off=V(up=0.02), head=rot(pitch=-4))

    def one(t):
        p = blend(rest, ready, seg(t, 0.0, 0.4, ease=smooth))
        p = blend(p, chomp, seg(t, 0.48, 0.6, ease=smooth))
        p = blend(p, pop, seg(t, 0.7, 0.95, ease=smooth))
        return blend(p, rest, seg(t, 0.95, 1.3))
    return one


# Drinks and noodles (brains.js DRINK / bottleIt): what's in hand comes up
# to the mouth once a loop, and the app tips it there.

@toy_clip("slurp", 2.2)
def toy_slurp(b, legs):
    """A noodle bowl on the left palm at the chest, chopsticks in the right
    fingers: down into the bowl (≈0.3-0.5 s), up to the mouth with the head
    coming down to meet them (≈1.0 s), the slurp drawing them in (to ≈1.4
    s), and back down."""
    rest = stand(b)
    bowl = at(b.chest, right=-0.02, up=-0.12, fwd=0.27)
    mouth = at(b.head, right=0.02, up=-0.07, fwd=0.11)

    def right(hand):
        return arm("R", hand, V(right=-1, up=0.2, fwd=0.4), V(up=1, fwd=0.3), V(right=1, up=-0.8, fwd=-0.1))

    def loop(t):
        L = 2.2
        s = t % L
        dip = seg(s, 0.15, 0.45, ease=smooth) * (1 - seg(s, 0.5, 0.95, ease=smooth))
        up = seg(s, 0.5, 0.95, ease=smooth) * (1 - seg(s, 1.45, 1.95, ease=smooth))
        pull = seg(s, 1.0, 1.4, ease=smooth) * (1 - seg(s, 1.45, 1.95, ease=smooth))
        lift = 0.05 * up
        hand = bowl + V(right=0.06, up=0.1) + (bowl + V(up=0.02) - (bowl + V(right=0.06, up=0.1))) * dip
        hand = hand + (mouth + V(up=0.02 * pull) - hand) * up
        return mix(rest, Pose(
            spine=rot(pitch=4 + 3 * up), neck=rot(pitch=6 + 6 * up - 4 * pull), head=rot(pitch=10 + 8 * up - 8 * pull),
            arm_L=arm("L", bowl + V(up=lift, right=0.02 * up), V(up=1, right=0.2), V(right=1, fwd=-0.2),
                      V(right=-1, up=-0.6, fwd=-0.2)),
            fingers_L=dict(OPEN),
            arm_R=right(hand), fingers_R=dict(PINCH),
            hips=rot(roll=0.5 * wave(t, L)),
        ), 1.0)
    return loop


@toy_clip("sip", 5.0)
def toy_sip(b, legs):
    """A mug cradled in both hands at the chest; up to the lips (1.0-1.8 s),
    a slow sip with the head tipping back a little (≈2.1 s), down again
    (2.6-3.4 s), and held, warm, swaying a touch."""
    rest = stand(b)
    low = at(b.chest, up=-0.1, fwd=0.24)
    lips = at(b.head, up=-0.09, fwd=0.11)

    def hands(c):
        return dict(
            arm_L=arm("L", c + V(right=-0.045), V(right=1, fwd=0.3), V(up=1), V(right=-1, up=-0.7, fwd=-0.1)),
            arm_R=arm("R", c + V(right=0.045), V(right=-1, fwd=0.3), V(up=1), V(right=1, up=-0.7, fwd=-0.1)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        )

    def loop(t):
        L = 5.0
        s = t % L
        up = seg(s, 1.0, 1.8, ease=smooth) * (1 - seg(s, 2.6, 3.4, ease=smooth))
        sip = seg(s, 1.8, 2.2, ease=smooth) * (1 - seg(s, 2.3, 2.6, ease=smooth))
        c = low + (lips - low) * up + V(up=0.01 * sip)
        return mix(rest, Pose(
            spine=rot(pitch=3), neck=rot(pitch=4 + 4 * up - 4 * sip), head=rot(pitch=8 + 4 * up - 10 * sip, roll=2 * wave(t, L)),
            hips=rot(roll=0.6 * wave(t, L)), **hands(c),
        ), 1.0)
    return loop


@toy_clip("swig", 1.8)
def toy_swig(b, legs):
    """A coffee to go in the right fist: up to the mouth (0.2-0.6 s), a quick
    swig with the head back (≈0.8 s), down by 1.4 s."""
    rest = stand(b)
    low = at(b.chest, right=0.1, up=-0.13, fwd=0.24)
    lips = at(b.head, right=0.02, up=-0.09, fwd=0.1)

    def loop(t):
        L = 1.8
        s = t % L
        up = seg(s, 0.2, 0.6, ease=smooth) * (1 - seg(s, 1.0, 1.4, ease=smooth))
        back = seg(s, 0.6, 0.8, ease=smooth) * (1 - seg(s, 0.9, 1.1, ease=smooth))
        hand = low + (lips - low) * up + V(up=0.02 * back)
        return mix(rest, Pose(
            neck=rot(pitch=2 - 6 * back), head=rot(pitch=4 - 12 * back),
            arm_R=rod_arm("R", hand, V(up=1), V(right=-1, fwd=0.4), V(right=1, up=-0.8, fwd=0.1)),
            fingers_R=dict(FIST),
        ), 1.0)
    return loop


@toy_clip("bottle", 4.0)
def toy_bottle(b, legs):
    """A water bottle in the right fist at the chest, the left hand twisting
    its cap (off ≈0.85 s) and dropping away; up to the mouth with the head
    back (from ≈1.5 s), three gulps, down by 3.1 s, and the back of the
    left hand across the mouth."""
    rest = stand(b)
    low = at(b.chest, right=0.04, up=-0.12, fwd=0.25)
    lips = at(b.head, right=0.02, up=-0.05, fwd=0.09)
    cap = low + V(up=0.12)

    def one(t):
        twist = wave(t, 0.3) * seg(t, 0.2, 0.3) * (1 - seg(t, 0.8, 0.9))
        up = seg(t, 1.0, 1.5, ease=smooth) * (1 - seg(t, 3.0, 3.4, ease=smooth))
        gulp = max(0.0, wave(t - 1.8, 0.5)) * seg(t, 1.6, 1.7) * (1 - seg(t, 2.9, 3.0))
        wipe = seg(t, 3.3, 3.55, ease=smooth) * (1 - seg(t, 3.75, 4.0, ease=smooth))
        hand = low + (lips - low) * up
        left_hand = cap + V(right=-0.005 * twist)
        left_hand = left_hand + (at(b.hips, right=-0.2, up=0.1, fwd=0.05) - left_hand) * seg(t, 0.85, 1.2, ease=smooth)
        left_hand = left_hand + (at(b.head, right=-0.02, up=-0.08, fwd=0.1) - left_hand) * wipe
        return mix(rest, Pose(
            spine=rot(pitch=-3 * up), neck=rot(pitch=-10 * up), head=rot(pitch=-22 * up + 2 * gulp),
            arm_R=rod_arm("R", hand + V(up=0.03 * up), V(up=1 - 0.6 * up, fwd=-0.5 * up), V(right=-1, fwd=0.4),
                          V(right=1, up=-0.8, fwd=0.1)),
            fingers_R=dict(FIST),
            arm_L=arm("L", left_hand, V(right=1, up=0.2 * (1 - wipe), fwd=0.2), V(up=1 - wipe, fwd=wipe),
                      V(right=-1, up=-0.7, fwd=-0.1)),
            fingers_L=dict(PINCH if t < 0.9 else RELAXED_FINGERS),
        ), 1.0)
    return one


@toy_clip("clap_pop", 1.1)
def toy_clap_pop(b, legs):
    """Both hands up and apart in front of the face, eyes on a bubble, and
    clapped together round it (≈0.45 s), then down."""
    rest = standing(b)

    def hands(gap, up):
        return dict(
            arm_L=arm("L", at(b.head, right=-gap, up=up, fwd=0.32), V(right=1, fwd=0.4), V(up=1, fwd=0.2),
                      V(right=-1, up=-0.5, fwd=-0.2)),
            arm_R=arm("R", at(b.head, right=gap, up=up, fwd=0.32), V(right=-1, fwd=0.4), V(up=1, fwd=0.2),
                      V(right=1, up=-0.5, fwd=-0.2)),
            fingers_L=dict(FLAT), fingers_R=dict(FLAT),
        )
    ready = Pose(spine=rot(pitch=-2), head=rot(pitch=-8), hips_off=V(up=-0.02), **hands(0.16, 0.0))
    clap = Pose(spine=rot(pitch=-1), head=rot(pitch=-6), hips_off=V(up=-0.03), **hands(0.012, -0.01))

    def one(t):
        p = blend(rest, ready, seg(t, 0.0, 0.32, ease=smooth))
        p = blend(p, clap, seg(t, 0.36, 0.45, ease=smooth))
        return blend(p, rest, seg(t, 0.6, 1.1))
    return one


@toy_clip("warm_hands", 6.0)
def toy_warm_hands(b, legs):
    """Hands held out to a campfire, palms to its warmth, fingers spread and
    flexing; once a loop rubbed together, then held out again."""
    rest = stand(b)

    def out_pose(t):
        flex = 0.12 * (0.5 + 0.5 * wave(t, 1.5))
        fingers = dict(OPEN, index=0.04 + flex, middle=0.06 + flex, ring=0.08 + flex, little=0.1 + flex)
        return mix(rest, Pose(
            hips=rot(roll=1.0 * wave(t, 3.0)), spine=rot(pitch=5), chest=rot(pitch=2), neck=rot(pitch=4),
            head=rot(pitch=8, roll=2 * wave(t, 6.0)),
            arm_L=arm("L", at(b.hips, right=-0.15, up=0.06 + 0.01 * wave(t, 3.0), fwd=0.36), V(up=1, fwd=0.4), V(right=1),
                      V(right=-0.6, up=-1, fwd=-0.2)),
            arm_R=arm("R", at(b.hips, right=0.15, up=0.06 + 0.01 * wave(t, 3.0, 0.25), fwd=0.36), V(up=1, fwd=0.4), V(right=-1),
                      V(right=0.6, up=-1, fwd=-0.2)),
            fingers_L=fingers, fingers_R=dict(fingers),
        ), 1.0)

    def rub_pose(t):
        # Palm to palm in front of the stomach, rubbed (≈3 Hz, by eye).
        rub = 0.025 * wave(t, 0.3)
        return mix(rest, Pose(
            hips=rot(roll=1.0 * wave(t, 3.0)), spine=rot(pitch=6), chest=rot(pitch=3), neck=rot(pitch=4), head=rot(pitch=10),
            arm_L=arm("L", at(b.hips, right=-0.026, up=0.16 + rub, fwd=0.28), V(fwd=1, up=0.6), V(up=1),
                      V(right=-1, up=-0.6, fwd=-0.2)),
            arm_R=arm("R", at(b.hips, right=0.026, up=0.16 - rub, fwd=0.28), V(fwd=1, up=0.6), V(up=1),
                      V(right=1, up=-0.6, fwd=-0.2)),
            fingers_L=dict(FLAT), fingers_R=dict(FLAT),
        ), 1.0)

    def loop(t):
        s = seg(t, 4.0, 4.4, ease=smooth) * (1 - seg(t, 5.4, 6.0, ease=smooth))
        return blend(out_pose(t), rub_pose(t), s)
    return loop


@toy_clip("stargaze", 4.0)
def toy_stargaze(b, legs):
    """Gazing up at a sky of stars: chin up, chest open, hands clasped
    behind the back, swaying a little and looking slowly about."""
    rest = stand(b)

    def loop(t):
        L = 4.0
        return mix(rest, Pose(
            hips=rot(roll=1.0 * wave(t, L)), spine=rot(pitch=-3), upper_chest=rot(pitch=-5),
            neck=rot(pitch=-14, yaw=4 * wave(t, L, 0.1)), head=rot(pitch=-26 + 2 * wave(t, L / 2), yaw=8 * wave(t, L, 0.1), roll=3 * wave(t, L, 0.35)),
            arm_L=arm("L", at(b.hips, right=-0.05, up=0.0, fwd=-0.17), V(right=1, up=-0.3), V(up=1, fwd=-0.3),
                      V(right=-1, up=-0.2, fwd=-0.6)),
            arm_R=arm("R", at(b.hips, right=0.04, up=0.01, fwd=-0.175), V(right=-1, up=-0.3), V(up=1, fwd=-0.3),
                      V(right=1, up=-0.2, fwd=-0.6)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        ), 1.0)
    return loop


@toy_clip("peer_in", 3.0)
def toy_peer_in(b, legs):
    """Bent forward with the hands on the knees, looking into an aquarium,
    the head tilting as the fish go by."""
    rest = standing(b)

    def loop(t):
        L = 3.0
        return mix(rest, Pose(
            hips=rot(pitch=6, roll=0.8 * wave(t, L)), hips_off=V(up=-0.05 + 0.005 * wave(t, L / 2), fwd=-0.04),
            spine=rot(pitch=16), chest=rot(pitch=8), upper_chest=rot(pitch=4),
            neck=rot(pitch=-8), head=rot(pitch=-12, roll=6 * wave(t, L, 0.2), yaw=6 * wave(t, L, 0.45)),
            arm_L=arm("L", at(b.hips, right=-0.12, up=-0.33, fwd=0.16), V(up=-1, fwd=0.3), V(right=1, fwd=0.2),
                      V(right=-1, up=0.1, fwd=-0.4)),
            arm_R=arm("R", at(b.hips, right=0.12, up=-0.33, fwd=0.16), V(up=-1, fwd=0.3), V(right=-1, fwd=0.2),
                      V(right=1, up=0.1, fwd=-0.4)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
        ), 1.0)
    return loop


@toy_clip("sprinkle", 2.0)
def toy_sprinkle(b, legs):
    """A pinch of fish food: the right hand out over the water, palm down,
    the pinch rubbed out (≈0.9 s, brains.js SPRINKLE_MS), back down."""
    rest = standing(b)

    def over(rub):
        return Pose(
            spine=rot(pitch=6), neck=rot(pitch=4), head=rot(pitch=12),
            arm_R=arm("R", at(b.hips, right=0.06, up=0.14, fwd=0.4), V(fwd=1), V(right=-1),
                      V(right=1, up=-0.6, fwd=-0.2)),
            fingers_R=dict(PINCH, thumb_op=0.6 - 0.15 * rub, index=0.45 + 0.1 * rub),
        )

    def one(t):
        # The fingers rubbing (≈6 a second, by eye) from 0.8 s to 1.45 s.
        rub = max(0.0, wave(t, 0.16)) * seg(t, 0.8, 0.85) * (1 - seg(t, 1.4, 1.45))
        p = blend(rest, over(rub), seg(t, 0.0, 0.6, ease=smooth))
        return blend(p, rest, seg(t, 1.5, 2.0))
    return one


# ── prop poses ──────────────────────────────────────────────────────────
# Poses that hold or sit in a prop. Props are built after the poses, from
# the same landmarks (a kart's wheel where the drive pose's hands are), and
# each clip names the props its preview shows.

PROP_CLIPS = {}   # clip id → props shown in its preview


def with_props(cid, *props):
    PROP_CLIPS[cid] = list(props)


def rod_arm(side, hand, along, fingers, pole):
    """A fist round a rod that runs along `along` (the thumb's way)."""
    return arm(side, hand, fingers, along, pole, twist=0.4)


def lying_points(b, legs, q, hips_off):
    """Landmarks of a body turned by q about the hips (spine bends ignored)."""
    return {
        "head": moved(legs, b.head, hips_off, q),
        "chest": moved(legs, b.chest, hips_off, q),
        "hip_L": moved(legs, legs.hip["L"], hips_off, q),
        "hip_R": moved(legs, legs.hip["R"], hips_off, q),
        "sh_L": moved(legs, b.sh_L, hips_off, q),
        "sh_R": moved(legs, b.sh_R, hips_off, q),
    }


# Sunbed: reclined 25° up from flat, the seat this high.
SUNBED_TOP = 0.38
LOUNGE_TILT = 25


def lounge_frame(b, legs):
    q = rot(pitch=-(90 - LOUNGE_TILT))
    hips_off = V(up=-(legs.hips.z - SUNBED_TOP - 0.09))
    return q, hips_off


@clip("lounge", 4.0)
def lounge(b, legs):
    """On a sunbed, hands behind the head, one knee up, the face turned to
    the viewer (the app shows this side-on: facing screen right, the right
    side is the near one)."""
    q, hips_off = lounge_frame(b, legs)
    pts = lying_points(b, legs, q, hips_off)
    reach = legs.thigh + legs.shin

    def loop(t):
        L = 4.0
        breath = wave(t, L)
        bed = V(up=SUNBED_TOP + 0.07)
        foot_r = V(right=-0.1, fwd=reach * 0.92) + bed
        foot_l = V(right=0.08, fwd=reach * 0.5) + bed
        tap = 0.015 * max(0.0, wave(t, L / 2))
        return Pose(
            hips=q, hips_off=hips_off + V(up=0.002 * breath),
            spine=rot(pitch=4), chest=rot(pitch=3 + 1.2 * breath), upper_chest=rot(pitch=2),
            neck=rot(pitch=8), head=rot(pitch=10, yaw=-30, roll=-4),
            # Hands under the back of the head, elbows out.
            arm_L=arm("L", pts["head"] + V(right=-0.08, fwd=-0.06, up=-0.02), V(right=-1, up=0.2), V(fwd=1),
                      V(right=1, up=0.3, fwd=-0.3)),
            arm_R=arm("R", pts["head"] + V(right=0.08, fwd=-0.06, up=-0.02), V(right=1, up=0.2), V(fwd=1),
                      V(right=-1, up=0.3, fwd=-0.3)),
            fingers_L=dict(RELAXED_FINGERS), fingers_R=dict(RELAXED_FINGERS),
            foot_R=foot_at(legs, "R", foot_r), foot_L=foot_at(legs, "L", foot_l + V(up=tap)),
            leg_pole_L=V(up=1, fwd=0.3), leg_pole_R=V(up=1, fwd=0.3),
            feet_free=25, look=None,
        )
    return loop


with_props("lounge", "sunbed", "sunglasses")


@clip("umbrella", 3.0)
def umbrella(b, legs):
    """Holding an umbrella up: right fist at the chest, shaft straight up.
    The app plays its arms over the walk loop too."""
    rest = stand(b)

    def loop(t):
        L = 3.0
        hand = at(b.sh_R, right=-0.08, up=-0.2, fwd=0.2) + V(up=0.006 * wave(t, L))
        return mix(rest, Pose(
            arm_R=rod_arm("R", hand, V(up=1, fwd=0.08), V(right=-1, fwd=0.3), V(right=1, up=-0.6, fwd=-0.4)),
            fingers_R=dict(FIST),
            head=rot(pitch=-4, roll=2 * wave(t, L)),
        ), 1.0)
    return loop


with_props("umbrella", "umbrella")

# Rod props held along the thumb: where the thumb points in each pose.
VACUUM_AIM = V(fwd=0.87, up=0.5)


@clip("vacuum", 1.6)
def vacuum(b, legs):
    """A stick vacuum held out front and up, sweeping a little side to side."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        sweep = wave(t, L)
        hand = at(b.hips, right=0.12, up=0.12, fwd=0.28) + V(right=0.03 * sweep)
        aim = (VACUUM_AIM + V(right=0.12 * sweep)).normalized()
        return mix(rest, Pose(
            spine=rot(pitch=-2, yaw=-4 * sweep), chest=rot(pitch=-2),
            arm_R=rod_arm("R", hand, aim, V(right=-1, up=0.2), V(right=1, up=-0.8, fwd=-0.3)),
            fingers_R=dict(FIST),
            arm_L=arm("L", at(b.hips, right=-0.17, up=0.06, fwd=0.02), V(up=-0.6, fwd=0.75), V(up=1, fwd=0.2),
                      V(right=-1, up=-0.1, fwd=-0.35)),
            look=hand + aim * 1.4, look_weight=0.5,
            hips=rot(roll=1.2 * sweep),
        ), 1.0)
    return loop


with_props("vacuum", "vacuum")

GUN_AIM = V(fwd=0.94, up=0.34)


@clip("aim", 2.0)
def aim(b, legs):
    """A potato cannon shouldered in both hands, aimed up and ahead."""
    rest = stand(b)

    def loop(t):
        L = 2.0
        hand = at(b.sh_R, right=-0.06, up=-0.12, fwd=0.26) + V(up=0.005 * wave(t, L))
        dirn = GUN_AIM.normalized()
        return mix(rest, Pose(
            spine=rot(pitch=-3, yaw=6), chest=rot(yaw=4), head=rot(yaw=-8, pitch=-6, roll=-6),
            arm_R=rod_arm("R", hand, dirn, V(right=-1, up=0.3), V(right=1, up=-0.7, fwd=-0.5)),
            fingers_R=dict(FIST),
            # The other hand under the barrel, further along.
            arm_L=arm("L", hand + dirn * 0.26 + V(up=-0.04), dirn, V(right=1, up=0.2), V(right=-1, up=-1, fwd=0.1)),
            fingers_L={"thumb": 0.3, "thumb_op": 0.4, "index": 0.55, "middle": 0.6, "ring": 0.62, "little": 0.65},
            hips_off=V(fwd=-0.02), hips=rot(yaw=4),
        ), 1.0)
    return loop


with_props("aim", "spudgun")


LAUNCHER_AIM = V(fwd=0.98, up=0.16)


@clip("bazooka", 2.0)
def bazooka(b, legs):
    """A rocket launcher on the right shoulder, head down to sight along it,
    feet braced."""
    rest = stand(b)

    def loop(t):
        L = 2.0
        dirn = LAUNCHER_AIM.normalized()
        # The fist just ahead of the shoulder: the tube runs back over it.
        hand = at(b.sh_R, right=-0.02, up=0.03, fwd=0.16) + V(up=0.004 * wave(t, L))
        return mix(rest, Pose(
            spine=rot(pitch=2, yaw=8), chest=rot(yaw=6), head=rot(yaw=-12, pitch=6, roll=-12),
            arm_R=rod_arm("R", hand, dirn, V(right=-1, up=0.3), V(right=1, up=-1, fwd=-0.3)),
            fingers_R=dict(FIST),
            # The other hand under the tube, out along it.
            arm_L=arm("L", hand + dirn * 0.32 + V(up=-0.06), dirn, V(right=1, up=0.2), V(right=-1, up=-1, fwd=0.1)),
            fingers_L={"thumb": 0.3, "thumb_op": 0.4, "index": 0.55, "middle": 0.6, "ring": 0.62, "little": 0.65},
            hips_off=V(fwd=-0.03), hips=rot(yaw=6),
            foot_L=V(right=-0.04, fwd=0.1), foot_R=V(right=0.04, fwd=-0.08),
        ), 1.0)
    return loop


with_props("bazooka", "launcher")


def shovel_line(b, depth):
    """Blade end on the ground ahead (`depth` below it when dug in), right
    hand low on the shaft, the shaft's way up towards the left hand."""
    blade = V(right=0.05, fwd=0.55, up=0.05 - depth)
    right = at(b.hips, right=0.12, up=-0.02, fwd=0.28)
    return blade, right, (right - blade).normalized()


@clip("dig", 1.6)
def dig(b, legs):
    """Digging: shove the shovel in, lever it back, again."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        s = 0.5 + 0.5 * wave(t, L, 0.25)   # 1 = pushed in
        blade, right, way = shovel_line(b, 0.12 * s)
        right = right + V(up=-0.1 * s, fwd=-0.04 * (1 - s))
        way = (right - blade).normalized()
        left = right + way * 0.4
        return mix(rest, Pose(
            spine=rot(pitch=14 + 10 * s), chest=rot(pitch=6), head=rot(pitch=-12),
            hips_off=V(up=-0.05 * s, fwd=-0.03),
            arm_R=rod_arm("R", right, way, V(right=-1, fwd=0.2), V(right=1, up=-0.5, fwd=-0.5)),
            arm_L=rod_arm("L", left, way, V(right=1, fwd=0.2), V(right=-1, up=-0.5, fwd=-0.6)),
            fingers_R=dict(FIST), fingers_L=dict(FIST),
            look=blade, look_weight=0.4,
        ), 1.0)
    return loop


with_props("dig", "shovel")


def kart_points(b, legs):
    """Seat and wheel of the kart, from where the drive pose sits."""
    hips_off = V(up=-(legs.hips.z - 0.3))
    chest = b.chest + hips_off
    wheel = chest + V(fwd=0.34, up=-0.16)
    return hips_off, wheel


@clip("drive", 1.0)
def drive(b, legs):
    """At the wheel of a go-kart, legs out to the pedals, steering."""
    hips_off, wheel = kart_points(b, legs)
    reach = legs.thigh + legs.shin

    def loop(t):
        L = 1.0
        steer = math.radians(12) * wave(t, L)
        hands = {}
        for side, s in (("L", 1), ("R", -1)):
            # Round the wheel's rim at ten-to-two, turning with it.
            a = math.radians(55) * s + steer
            hands[side] = wheel + V(right=-0.13 * math.sin(a), up=0.13 * math.cos(a) * 0.7, fwd=-0.03)
        feet = {s: foot_at(legs, s, legs.hip[s] + hips_off + V(fwd=reach * 0.86, up=-0.13)) for s in ("L", "R")}
        return Pose(
            hips=rot(pitch=-8), hips_off=hips_off,
            spine=rot(pitch=6), chest=rot(pitch=3), head=rot(pitch=-4, roll=4 * wave(t, L)),
            arm_L=arm("L", hands["L"], V(fwd=0.6, up=0.4, right=0.3), V(up=1, fwd=0.3), V(right=-1, up=-0.8)),
            arm_R=arm("R", hands["R"], V(fwd=0.6, up=0.4, right=-0.3), V(up=1, fwd=0.3), V(right=1, up=-0.8)),
            fingers_L=dict(FIST), fingers_R=dict(FIST),
            foot_L=feet["L"], foot_R=feet["R"],
            leg_pole_L=V(up=1, fwd=0.4, right=-0.2), leg_pole_R=V(up=1, fwd=0.4, right=0.2),
            feet_free=-20,
        )
    return loop


with_props("drive", "kart")


@clip("fly", 1.2)
def fly(b, legs):
    """Flying like a superhero: flat out, one fist ahead, cape behind. The
    app turns them side-on to the way they fly."""
    q = rot(pitch=90)
    hips_off = V()
    pts = lying_points(b, legs, q, hips_off)

    def loop(t):
        L = 1.2
        bob = wave(t, L)
        return Pose(
            hips=q, hips_off=hips_off + V(up=0.01 * bob),
            spine=rot(pitch=-6), chest=rot(pitch=-4), head=rot(pitch=-55),
            # Fist out past the head, the other arm along the side.
            arm_R=arm("R", pts["head"] + V(fwd=0.42, up=0.04, right=0.04), V(fwd=1), V(right=-1),
                      V(right=1, up=0.5)),
            fingers_R=dict(FIST),
            arm_L=arm("L", pts["hip_L"] + V(right=-0.16, up=0.04, fwd=0.08), V(fwd=-1, up=0.1), V(up=1),
                      V(right=-1, up=0.6)),
            fingers_L=dict(RELAXED_FINGERS),
            foot_L=foot_at(legs, "L", moved(legs, legs.foot["L"], hips_off, q) + V(up=0.02 * bob)),
            foot_R=foot_at(legs, "R", moved(legs, legs.foot["R"], hips_off, q) + V(up=0.06 - 0.02 * bob)),
            leg_pole_L=V(up=-1), leg_pole_R=V(up=-1),
            feet_free=50, look=None,
        )
    return loop


with_props("fly", "cape")


@clip("climb", 1.2)
def climb(b, legs):
    """Climbing a wall in front of them: hand over hand, feet stepping up.
    The app turns them to face the screen edge and moves them up a step
    each half cycle."""
    wall = 0.3

    def loop(t):
        L = 1.2
        ph = 2 * math.pi * t / L
        hands = {}
        feet = {}
        for side, s, off in (("L", -1, 0.0), ("R", 1, math.pi)):
            lift = 0.5 + 0.5 * math.cos(ph + off)   # 1 = reaching high
            sh = b.sh_L if side == "L" else b.sh_R
            hands[side] = at(sh, right=0.06 * s, up=0.12 + 0.28 * lift, fwd=wall - 0.04)
            feet[side] = foot_at(legs, side, legs.foot[side] + V(fwd=wall - 0.12, up=0.12 + 0.3 * (1 - lift), right=0.06 * s))
        return Pose(
            hips_off=V(fwd=0.04, up=-0.04), spine=rot(pitch=-4), chest=rot(pitch=-2), head=rot(pitch=-14),
            arm_L=arm("L", hands["L"], V(up=1, fwd=0.2), V(right=1), V(right=-1, up=-0.6, fwd=-0.3)),
            arm_R=arm("R", hands["R"], V(up=1, fwd=0.2), V(right=-1), V(right=1, up=-0.6, fwd=-0.3)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
            foot_L=feet["L"], foot_R=feet["R"],
            leg_pole_L=V(fwd=1, right=-0.6), leg_pole_R=V(fwd=1, right=0.6),
            feet_free=-20,
        )
    return loop


@clip("lie_front", 3.0)
def lie_front(b, legs):
    """On the stomach along an edge, chin in the hands, feet kicking up
    behind (the app shows it side-on)."""
    q = rot(pitch=90)
    hips_off = V(up=-(legs.hips.z - 0.13))
    pts = lying_points(b, legs, q, hips_off)

    def loop(t):
        L = 3.0
        feet = {}
        for side, ph in (("L", 0.0), ("R", 0.5)):
            a = math.radians(30 * wave(t, L / 2, ph))
            # Knee on the surface behind the hip, the shin swinging up.
            knee = pts[f"hip_{side}"] + V(fwd=-legs.thigh * 0.95, up=-0.06)
            feet[side] = foot_at(legs, side, knee + V(up=legs.shin * 0.92 * math.cos(a), fwd=-legs.shin * 0.92 * math.sin(a) + 0.04))
        chin = pts["head"] + V(up=-0.06, fwd=0.04)
        return Pose(
            hips=q, hips_off=hips_off,
            spine=rot(pitch=-14), chest=rot(pitch=-10), upper_chest=rot(pitch=-6), head=rot(pitch=-30, yaw=-20),
            arm_L=arm("L", chin + V(right=-0.05, up=-0.07, fwd=0.04), V(up=1, fwd=0.2), V(right=1),
                      V(right=-0.5, up=-1, fwd=0.2)),
            arm_R=arm("R", chin + V(right=0.05, up=-0.07, fwd=0.04), V(up=1, fwd=0.2), V(right=-1),
                      V(right=0.5, up=-1, fwd=0.2)),
            fingers_L=dict(RELAXED_FINGERS), fingers_R=dict(RELAXED_FINGERS),
            foot_L=feet["L"], foot_R=feet["R"],
            leg_pole_L=V(up=-1, fwd=-0.6), leg_pole_R=V(up=-1, fwd=-0.6),
            feet_free=40, look=None,
        )
    return loop


# Fishing off a ledge: the rod held up and out the way they face.
ROD_AIM = V(fwd=0.77, up=0.64)


def fish_pose(b, legs, t, reel):
    """Sat on an edge with a rod; `reel` > 0 cranks the reel (turns/s)."""
    p = sit_pose(b, legs, swing_l=10 * wave(t, 1.5), swing_r=10 * wave(t, 1.5, 0.5))
    hips_off = p["hips_off"]
    hip = b.hips + hips_off
    hand = hip + V(right=0.1, fwd=0.26, up=0.2) + V(up=0.01 * wave(t, 1.5))
    aim = ROD_AIM.normalized()
    # The other hand on the reel's crank, just in front of the right fist.
    a = 2 * math.pi * t * reel
    crank = hand + aim * 0.06 + V(right=-0.07) + V(fwd=0.035 * math.cos(a), up=0.035 * math.sin(a)) * (1 if reel else 0)
    return Pose(
        p,
        spine=rot(pitch=6), head=rot(pitch=6),
        arm_R=rod_arm("R", hand, aim, V(right=-1, up=0.1), V(right=1, up=-0.6, fwd=-0.6)),
        fingers_R=dict(FIST),
        arm_L=arm("L", crank, V(right=1, fwd=0.2), V(up=1), V(right=-1, up=-0.7, fwd=-0.4)),
        fingers_L={"thumb": 0.4, "thumb_op": 0.4, "index": 0.6, "middle": 0.65, "ring": 0.7, "little": 0.7},
    )


@clip("fish", 3.0)
def fish(b, legs):
    """Waiting for a bite."""
    return lambda t: fish_pose(b, legs, t, 0)


@clip("reel", 1.5)
def reel(b, legs):
    """Reeling it in, two turns a second."""
    return lambda t: fish_pose(b, legs, t, 2)


with_props("fish", "rod")
with_props("reel", "rod")


@clip("float", 2.0)
def float_up(b, legs):
    """Carried off by balloons: one fist up holding the strings, the other
    hand waving, legs dangling."""
    reach = sum(b.arm_len) * 0.95

    def loop(t):
        L = 2.0
        wv = wave(t, L / 2)
        return Pose(
            hips_off=V(), hips=rot(roll=2 * wave(t, L)),
            spine=rot(pitch=-3, roll=-2 * wave(t, L)), head=rot(pitch=-8, roll=4 * wave(t, L, 0.3)),
            arm_R=rod_arm("R", at(b.sh_R, right=0.04, up=reach), V(up=1), V(right=-1, fwd=0.3), V(right=1, fwd=-0.3)),
            fingers_R=dict(FIST),
            arm_L=arm("L", at(b.sh_L, right=-0.3, up=0.22 + 0.04 * wv, fwd=0.08), V(up=1, right=-0.3 * wv), V(right=1, fwd=0.4),
                      V(right=-1, up=-0.6)),
            fingers_L=dict(OPEN),
            foot_L=V(up=0.05 + 0.04 * max(0.0, wv), fwd=-0.04),
            foot_R=V(up=0.05 + 0.04 * max(0.0, -wv), fwd=-0.04),
            feet_free=-30,
        )
    return loop


with_props("float", "balloons")


@clip("swing", 1.2)
def swing(b, legs):
    """Swinging on a line: the right fist straight up round it, the left
    arm out for balance, knees tucked. The app hangs them from the line by
    that fist and turns them with it."""
    reach = sum(b.arm_len) * 0.97

    def loop(t):
        L = 1.2
        k = wave(t, L)
        return Pose(
            hips_off=V(), hips=rot(pitch=-6),
            spine=rot(pitch=4, roll=-3), chest=rot(roll=-2), head=rot(pitch=-12, yaw=-6),
            arm_R=rod_arm("R", at(b.sh_R, right=-0.02, up=reach), V(up=1), V(right=-1, fwd=0.3), V(right=1, fwd=-0.3)),
            fingers_R=dict(FIST),
            arm_L=arm("L", at(b.sh_L, right=-0.38, up=0.02 + 0.03 * k, fwd=0.12), V(right=-1, up=0.1), V(fwd=1),
                      V(right=-1, up=-0.8)),
            fingers_L=dict(OPEN),
            foot_L=V(up=0.24 + 0.03 * k, fwd=-0.16), foot_R=V(up=0.3 - 0.03 * k, fwd=-0.22),
            leg_pole_L=V(fwd=1), leg_pole_R=V(fwd=1),
            feet_free=-35,
        )
    return loop


@clip("swim", 1.6)
def swim(b, legs):
    """Front crawl, flat out: the arms turning over in turn, a flutter kick.
    The app turns them side-on and moves them along a video."""
    q = rot(pitch=90)
    hips_off = V()
    pts = lying_points(b, legs, q, hips_off)
    reach = sum(b.arm_len) * 0.9
    ahead, down = V(fwd=1), V(up=-1)

    def loop(t):
        L = 1.6
        hands = {}
        for side, ph in (("R", 0.0), ("L", math.pi)):
            # Round the shoulder: reach ahead, pull down and back under the
            # body, out and over the top (out of the water) again.
            a = 2 * math.pi * t / L + ph
            sh = pts["sh_R"] if side == "R" else pts["sh_L"]
            hands[side] = sh + (ahead * math.cos(a) + down * math.sin(a) * 0.7) * reach
        kick = wave(t, L / 4)
        return Pose(
            hips=q, hips_off=hips_off + V(up=0.01 * wave(t, L / 2)),
            spine=rot(roll=4 * wave(t, L)), chest=rot(roll=5 * wave(t, L)), head=rot(pitch=-40, yaw=25 * max(0.0, wave(t, L, 0.1))),
            arm_R=arm("R", hands["R"], V(fwd=1, up=-0.3), V(right=-1), V(right=1, up=0.6)),
            arm_L=arm("L", hands["L"], V(fwd=1, up=-0.3), V(right=1), V(right=-1, up=0.6)),
            fingers_L=dict(FLAT), fingers_R=dict(FLAT),
            foot_L=foot_at(legs, "L", moved(legs, legs.foot["L"], hips_off, q) + V(up=0.06 * kick)),
            foot_R=foot_at(legs, "R", moved(legs, legs.foot["R"], hips_off, q) + V(up=-0.06 * kick)),
            leg_pole_L=V(up=-1), leg_pole_R=V(up=-1),
            feet_free=50, look=None,
        )
    return loop


@clip("skate", 1.0)
def skate(b, legs):
    """Riding something along the floor: knees bent, arms out for balance."""
    def loop(t):
        L = 1.0
        s = wave(t, L)
        return Pose(
            hips_off=V(up=-0.12 + 0.01 * s, fwd=-0.02), hips=rot(yaw=20, roll=2 * s),
            spine=rot(pitch=8, yaw=-10), chest=rot(roll=-3 * s), head=rot(yaw=-14, pitch=-4),
            # Low and loose, one ahead and one behind (arms level with the
            # shoulders read as a T-pose on screen).
            arm_L=arm("L", at(b.sh_L, right=-0.34, up=-0.26 + 0.03 * s, fwd=0.22), V(right=-0.6, up=-0.6, fwd=0.4), V(fwd=1, up=0.3),
                      V(right=-0.4, up=0.3, fwd=-1)),
            arm_R=arm("R", at(b.sh_R, right=0.3, up=-0.32 - 0.03 * s, fwd=-0.2), V(right=0.6, up=-0.7, fwd=-0.3), V(fwd=1, up=0.3),
                      V(right=0.4, up=0.3, fwd=1)),
            fingers_L=dict(OPEN), fingers_R=dict(OPEN),
            foot_L=V(fwd=0.12, right=-0.03), foot_R=V(fwd=-0.1, right=0.03),
        )
    return loop


@clip("push", 1.2)
def push(b, legs):
    """Rolling a snowball along: bent over it, both palms on its back,
    shoving in turn. The app plays its arms over the walk loop too."""
    rest = stand(b)

    def loop(t):
        L = 1.2
        hands = {}
        for side, s, ph in (("L", -1, 0.0), ("R", 1, 0.5)):
            shove = wave(t, L, ph)
            hands[side] = at(b.hips, right=0.13 * s, up=-0.12, fwd=0.4 + 0.04 * shove)
        return mix(rest, Pose(
            spine=rot(pitch=30), chest=rot(pitch=10), head=rot(pitch=-22),
            hips_off=V(up=-0.06, fwd=-0.05),
            arm_L=arm("L", hands["L"], V(up=0.75, fwd=0.45), V(right=1), V(right=-1, up=-0.3, fwd=-0.6)),
            arm_R=arm("R", hands["R"], V(up=0.75, fwd=0.45), V(right=-1), V(right=1, up=-0.3, fwd=-0.6)),
            fingers_L=dict(FLAT), fingers_R=dict(FLAT),
            look=at(b.hips, up=-0.3, fwd=0.8), look_weight=0.4,
        ), 1.0)
    return loop


@clip("pat", 1.0)
def pat(b, legs):
    """Shaping something in front of them: bent a little, patting it with
    flat hands in turn, palms down."""
    rest = stand(b)

    def loop(t):
        L = 1.0
        hands = {}
        for side, s, ph in (("L", -1, 0.0), ("R", 1, 0.5)):
            lift = max(0.0, wave(t, L, ph))
            hands[side] = at(b.hips, right=0.11 * s, up=0.0 + 0.08 * lift, fwd=0.3)
        return mix(rest, Pose(
            spine=rot(pitch=20), chest=rot(pitch=6), head=rot(pitch=-14),
            hips_off=V(up=-0.03),
            arm_L=arm("L", hands["L"], V(fwd=1, right=0.15), V(right=1), V(right=-1, up=-1, fwd=-0.2)),
            arm_R=arm("R", hands["R"], V(fwd=1, right=-0.15), V(right=-1), V(right=1, up=-1, fwd=-0.2)),
            fingers_L=dict(FLAT), fingers_R=dict(FLAT),
            look=at(b.hips, up=0.1, fwd=0.6), look_weight=0.5,
        ), 1.0)
    return loop


@clip("lantern_carry", 2.4)
def lantern_carry(b, legs):
    """Carrying a lantern low at the side by its bail: the right arm down
    and a little forward, the fist knuckles-up so the lantern hangs below
    it, a slow sway; peering ahead into the dark. The app plays its arms
    over the walk loop too."""
    rest = stand(b)

    def loop(t):
        L = 2.4
        hand = at(b.sh_R, right=0.11, up=-0.36, fwd=0.2) + V(fwd=0.01 * wave(t, L))
        return mix(rest, Pose(
            arm_R=rod_arm("R", hand, V(up=1), V(right=-1, fwd=0.35), V(right=1, up=-0.2, fwd=-1)),
            fingers_R=dict(FIST),
            head=rot(pitch=4, yaw=3 * wave(t, L / 2)), spine=rot(pitch=3),
            look=at(b.head, up=-0.25, fwd=1.6), look_weight=0.3,
        ), 1.0)
    return loop


with_props("lantern_carry", "lantern")


@clip("pet", 1.6)
def pet(b, legs):
    """Reaching out to stroke something: the right hand out and up, palm
    down, stroking to and fro; leaning in, the head tilted fondly, the
    left hand at the chest."""
    rest = stand(b)

    def loop(t):
        L = 1.6
        s = wave(t, L)
        hand = at(b.sh_R, right=-0.07 + 0.07 * s, up=-0.16 + 0.02 * abs(s), fwd=0.38)
        return mix(rest, Pose(
            spine=rot(pitch=8, yaw=-6), chest=rot(pitch=3), head=rot(roll=10, pitch=-4),
            arm_R=arm("R", hand, V(fwd=1, up=-0.1), V(right=-1), V(right=1, up=-1, fwd=-0.1)),
            fingers_R=dict(FLAT),
            arm_L=arm("L", at(b.chest, right=-0.06, up=-0.05, fwd=0.12), V(right=1, up=0.3), V(up=1),
                      V(right=-1, up=-0.8, fwd=-0.2)),
            fingers_L=dict(RELAXED_FINGERS),
        ), 1.0)
    return loop


@clip("juggle", 1.2)
def juggle(b, legs):
    """Juggling: hands at the waist out front bobbing in turn, palms up,
    eyes up on what's in the air."""
    rest = stand(b)

    def loop(t):
        L = 1.2
        hands = {}
        for side, s, ph in (("L", -1, 0.0), ("R", 1, 0.5)):
            bob = wave(t, L / 2, ph)
            hands[side] = at(b.hips, right=0.17 * s, up=0.16 + 0.06 * bob, fwd=0.3)
        return mix(rest, Pose(
            head=rot(pitch=-18),
            arm_L=arm("L", hands["L"], V(fwd=1, right=0.2), V(right=-1, up=0.3), V(right=-1, up=-0.6, fwd=-0.6)),
            arm_R=arm("R", hands["R"], V(fwd=1, right=-0.2), V(right=1, up=0.3), V(right=1, up=-0.6, fwd=-0.6)),
            fingers_L=dict(CLAW), fingers_R=dict(CLAW),
            look=at(b.head, up=0.45, fwd=0.4), look_weight=0.6,
        ), 1.0)
    return loop


# The fretting hand this far up the neck from the guitar's origin (the
# body's middle): about the 4th fret of make_guitar's 0.65 m scale.
GUITAR_NECK_HAND = 0.36


def guitar_frame(b):
    """Where the air guitar sits (Blender armature space): its origin at the
    right hip, the neck up to the left at the 30° players hold it, face
    out. Also its axes: x toward its top edge, y up the neck, z out of its
    face (make_guitar's)."""
    body = at(b.hips, right=0.11, up=0.1, fwd=0.17)
    gy = V(right=-0.82, up=0.5, fwd=0.28).normalized()
    gz = V(fwd=1)
    gz = (gz - gy * gy.dot(gz)).normalized()
    gx = gy.cross(gz)
    if gx.dot(V(up=1)) < 0:
        gx = -gx
    return body, body + gy * GUITAR_NECK_HAND, (gx, gy, gz)


@clip("air_guitar", 1.0)
def air_guitar(b, legs):
    """Shredding: left hand round the neck, right hand strumming over the
    pickups, head banging."""
    body, fret, (gx, gy, gz) = guitar_frame(b)

    def on(x, y, z):
        """A point on the guitar (its own axes) in armature space."""
        return body + gx * x + gy * y + gz * z

    def loop(t):
        L = 1.0
        strum = wave(t, L / 4)
        bang = max(0.0, wave(t, L / 2))
        # The guitar rides the hips bone: the hands go with it.
        dip = V(up=-0.05 * bang)
        return Pose(
            hips_off=dip, spine=rot(pitch=4 + 6 * bang), chest=rot(pitch=2), head=rot(pitch=18 * bang - 6),
            # Wrist under the neck, fingers over the fretboard, thumb behind.
            arm_L=arm("L", on(-0.06, GUITAR_NECK_HAND - 0.02 + 0.01 * wave(t, L / 2, 0.2), -0.01) + dip,
                      gx * 0.75 + gz * 0.65, gy * 0.6 + gx * 0.6 - gz * 0.3, V(up=-1, fwd=-0.2, right=-0.3)),
            fingers_L=dict(CLAW),
            # Wrist over the strings by the middle pickup, the pick hand
            # sweeping across them.
            arm_R=arm("R", on(0.075 + 0.045 * strum, -0.04, 0.065) + dip,
                      -gx * 0.75 - gz * 0.55, gy * 0.7 - gx * 0.3, V(right=1, up=-0.3, fwd=-0.5)),
            fingers_R={"thumb": 0.4, "thumb_op": 0.6, "index": 0.5, "middle": 0.8, "ring": 0.85, "little": 0.9},
            foot_L=V(right=-0.05, fwd=0.06), foot_R=V(right=0.05, fwd=-0.04),
        )
    return loop


with_props("air_guitar", "guitar")


@clip("punch", 0.9)
def punch(b, legs):
    """Guard up, a right straight, back to the stance."""
    rest = standing(b)
    guard = mix(rest, Pose(
        spine=rot(yaw=-8), chest=rot(yaw=-4),
        arm_L=arm("L", at(b.sh_L, right=0.05, up=-0.08, fwd=0.26), V(up=0.7, fwd=0.7), V(right=1), V(right=-1, up=-1)),
        arm_R=arm("R", at(b.sh_R, right=0.02, up=-0.12, fwd=0.2), V(up=0.7, fwd=0.7), V(right=-1), V(right=1, up=-1)),
        fingers_L=dict(FIST), fingers_R=dict(FIST),
    ), 1.0)
    hit = mix(guard, Pose(
        spine=rot(yaw=16, pitch=4), chest=rot(yaw=8), head=rot(yaw=-10),
        arm_R=arm("R", at(b.sh_R, right=-0.12, up=0.02, fwd=0.58), V(fwd=1), V(right=-1), V(right=1, up=-0.3)),
        hips_off=V(fwd=0.04),
    ), 1.0)

    def one(t):
        p = blend(rest, guard, seg(t, 0.0, 0.18))
        p = blend(p, hit, seg(t, 0.2, 0.3, ease=smooth))
        p = blend(p, guard, seg(t, 0.38, 0.55))
        return blend(p, rest, seg(t, 0.6, 0.9))
    return one


# ── props ───────────────────────────────────────────────────────────────
# Built in glTF prop space (x the character's left, y up, z forward) with
# the tool motions' mesh helpers. Hand props run along the fist's thumb
# (the grip's +Y); `root` props stand on the floor with the avatar, in its
# frame (they turn with it). Each may carry empties named `<prop>_<point>`
# the app looks up (a muzzle, a nozzle).

T_PALM = {"R": ((-1, 0, 0), (0, -1, 0), (0, 0, 1)), "L": ((1, 0, 0), (0, -1, 0), (0, 0, 1))}


def rod_grip(side, off_palm=0.028, along=0.05):
    """A rod through the fist along the thumb's way."""
    f, p, t = T_PALM[side]
    return tm.grip(f, p, t, along=along, toward_thumb=0.0, off_palm=off_palm, long_tilt_deg=90)


def _cyl(name, r0, r1, y0, y1, color, segments=16, rough=0.5, metal=0.0, x=0.0, z=0.0):
    import bmesh

    def b(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r0, radius2=r1, depth=1.0)
        for v in bm.verts:
            vx, vy, vz = v.co
            v.co = tm._g(x + vx, y0 + (vz + 0.5) * (y1 - y0), z + vy)
    o = tm._mesh_object(name, b)
    o.data.materials.append(tm._material(name, color, rough=rough, metal=metal))
    return o


def _box(name, size, centre, color, rough=0.5, metal=0.0, tilt_x=0.0):
    import bmesh
    sx, sy, sz = size
    cx, cy, cz = centre
    ca, sa = math.cos(math.radians(tilt_x)), math.sin(math.radians(tilt_x))

    def b(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            x, y, z = v.co.x * sx, v.co.y * sy, v.co.z * sz
            y, z = y * ca - z * sa, y * sa + z * ca
            v.co = tm._g(cx + x, cy + y, cz + z)
    o = tm._mesh_object(name, b)
    o.data.materials.append(tm._material(name, color, rough=rough, metal=metal))
    return o


def _point(prop, name, x, y, z):
    e = tm.bpy.data.objects.new(f"{prop}_{name}", None)
    tm.bpy.context.scene.collection.objects.link(e)
    e.location = tm._g(x, y, z)
    return e


def make_umbrella(b, legs):
    import bmesh
    parts = [_cyl("umbrella_shaft", 0.009, 0.009, -0.14, 0.8, (0.15, 0.12, 0.12), metal=0.3)]

    def canopy(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0)
        for v in list(bm.verts):
            if v.co.z < -0.05:
                bm.verts.remove(v)
        for v in bm.verts:
            x, y, z = v.co
            # Scalloped rim: a little lower between the ribs.
            ang = math.atan2(y, x)
            dip = 0.04 * (1 - abs(math.cos(4 * ang))) * (1 - z)
            v.co = tm._g(x * 0.55, 0.6 + max(0.0, z) * 0.22 - dip, y * 0.55)
    c = tm._mesh_object("umbrella_canopy", canopy)
    c.data.materials.append(tm._material("umbrella_canopy", (0.95, 0.35, 0.55), rough=0.6))
    parts.append(c)
    parts.append(_cyl("umbrella_tip", 0.012, 0.0, 0.8, 0.86, (0.9, 0.85, 0.7), metal=0.5))
    parts.append(_cyl("umbrella_handle", 0.016, 0.016, -0.2, -0.13, (0.45, 0.25, 0.12)))
    return tm._join(parts, "umbrella")


def make_vacuum(b, legs):
    parts = [
        _cyl("vacuum_grip", 0.017, 0.017, -0.07, 0.06, (0.12, 0.12, 0.14)),
        _cyl("vacuum_motor", 0.05, 0.044, 0.05, 0.24, (0.85, 0.12, 0.25), rough=0.35),
        _cyl("vacuum_bin", 0.042, 0.042, 0.1, 0.22, (0.6, 0.75, 0.9), rough=0.15, z=0.055),
        _cyl("vacuum_wand", 0.016, 0.016, 0.24, 0.96, (0.75, 0.75, 0.8), rough=0.25, metal=0.8),
        _box("vacuum_head", (0.22, 0.04, 0.07), (0.0, 0.98, 0.0), (0.12, 0.12, 0.14)),
    ]
    obj = tm._join(parts, "vacuum")
    _point("vacuum", "nozzle", 0.0, 1.0, 0.0).parent = obj
    return obj


def make_spudgun(b, legs):
    parts = [
        _cyl("spud_chamber", 0.05, 0.05, -0.2, 0.06, (0.92, 0.92, 0.9), rough=0.4),
        _cyl("spud_reducer", 0.05, 0.03, 0.06, 0.12, (0.92, 0.92, 0.9), rough=0.4),
        _cyl("spud_barrel", 0.03, 0.03, 0.12, 0.62, (0.85, 0.85, 0.82), rough=0.4),
        _cyl("spud_cap", 0.055, 0.055, -0.23, -0.2, (0.2, 0.45, 0.85), rough=0.4),
        _box("spud_igniter", (0.025, 0.05, 0.03), (0.0, -0.08, -0.06), (0.95, 0.75, 0.1)),
    ]
    obj = tm._join(parts, "spudgun")
    _point("spudgun", "muzzle", 0.0, 0.62, 0.0).parent = obj
    return obj


def make_launcher(b, legs):
    """A shoulder rocket launcher along the thumb: the fist round its rear
    third, the open front ahead, the flared back over the shoulder."""
    olive, dark = (0.3, 0.34, 0.18), (0.16, 0.18, 0.1)
    parts = [
        _cyl("launcher_tube", 0.055, 0.055, -0.38, 0.55, olive, segments=20, rough=0.6),
        _cyl("launcher_front", 0.055, 0.066, 0.55, 0.6, dark, segments=20, rough=0.6),
        _cyl("launcher_bore", 0.046, 0.046, 0.598, 0.602, (0.03, 0.03, 0.03), segments=20, rough=0.9),
        _cyl("launcher_back", 0.072, 0.055, -0.46, -0.38, dark, segments=20, rough=0.6),
        _cyl("launcher_band0", 0.058, 0.058, 0.08, 0.11, dark, segments=20, rough=0.6),
        _cyl("launcher_band1", 0.058, 0.058, 0.44, 0.48, (0.95, 0.78, 0.1), segments=20, rough=0.5),
    ]
    obj = tm._join(parts, "launcher")
    _point("launcher", "muzzle", 0.0, 0.6, 0.0).parent = obj
    _point("launcher", "rear", 0.0, -0.46, 0.0).parent = obj
    return obj


def make_shovel(b, legs):
    parts = [
        _cyl("shovel_shaft", 0.015, 0.015, -0.72, 0.42, (0.6, 0.4, 0.22), rough=0.7),
        _box("shovel_grip", (0.12, 0.025, 0.025), (0.0, 0.46, 0.0), (0.15, 0.15, 0.15)),
        _box("shovel_blade", (0.2, 0.26, 0.012), (0.0, -0.84, 0.0), (0.55, 0.58, 0.62), rough=0.3, metal=0.9),
    ]
    return tm._join(parts, "shovel")


def make_cape(b, legs):
    """A cape off the shoulders, in the upper chest's frame: hangs down the
    back (in flight the body is flat, so it streams behind)."""
    import bmesh
    top_y = (b.sh_R.z - b.chest.z) + 0.02

    def cape(bm):
        rows, cols = 6, 8
        grid = []
        for i in range(rows + 1):
            v = i / rows
            w = 0.19 + 0.2 * v
            y = top_y - 0.95 * v
            z = -0.11 - 0.12 * v
            row = []
            for j in range(cols + 1):
                u = j / cols * 2 - 1
                ripple = 0.025 * math.sin(u * 3.0 + v * 4.0) * v
                row.append(bm.verts.new(tm._g(u * w, y, z - 0.03 * (1 - u * u) + ripple)))
            grid.append(row)
        for i in range(rows):
            for j in range(cols):
                bm.faces.new([grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]])
    o = tm._mesh_object("cape", cape)
    m = tm._material("cape", (0.8, 0.08, 0.12), rough=0.55)
    m.use_backface_culling = False
    o.data.materials.append(m)
    return o


def make_sunglasses(b, legs):
    """Round shades in the head's frame, over the eyes."""
    eye = b.eye - b.head
    ey, ez = eye.z, -eye.y + 0.02
    parts = []
    for s in (1, -1):
        parts.append(_box(f"shade{s}", (0.05, 0.034, 0.006), (0.034 * s, ey, ez), (0.04, 0.04, 0.07), rough=0.1))
        parts.append(_box(f"shade_arm{s}", (0.004, 0.006, 0.1), (0.064 * s, ey + 0.004, ez - 0.05), (0.1, 0.1, 0.1)))
    parts.append(_box("shade_bridge", (0.022, 0.005, 0.005), (0.0, ey + 0.008, ez), (0.1, 0.1, 0.1)))
    return tm._join(parts, "sunglasses")


def make_sunbed(b, legs):
    """A sun lounger under the lounge pose: flat seat to the feet end
    (+z), backrest raised at the head end, striped canvas."""
    top = SUNBED_TOP
    parts = []
    stripes = [(0.2, 0.55, 0.95), (0.97, 0.97, 0.95)]
    n = 6
    for i in range(n):
        z0 = -0.15 + i * (1.15 / n)
        parts.append(_box(f"bed_seat{i}", (0.6, 0.03, 1.15 / n), (0.0, top - 0.015, z0 + 0.5 * 1.15 / n), stripes[i % 2], rough=0.8))
    # Backrest: from the seat's head end up and back.
    length = 0.85
    ang = LOUNGE_TILT
    cz = -0.15 - math.cos(math.radians(ang)) * length / 2
    cy = top - 0.015 + math.sin(math.radians(ang)) * length / 2
    parts.append(_box("bed_back", (0.6, 0.03, length), (0.0, cy, cz), stripes[0], rough=0.8, tilt_x=ang))
    for x in (-0.31, 0.31):
        for z in (-0.75, 0.95):
            parts.append(_cyl(f"bed_leg{x}{z}", 0.014, 0.014, 0.0, top - 0.02, (0.8, 0.8, 0.82), metal=0.8, x=x, z=z))
        parts.append(_box(f"bed_rail{x}", (0.025, 0.025, 1.75), (x, top - 0.04, 0.1), (0.8, 0.8, 0.82), metal=0.8))
    return tm._join(parts, "sunbed")


def make_kart(b, legs):
    """A go-kart round the drive pose: seat under the hips, the wheel where
    the hands are."""
    hips_off, wheel = kart_points(b, legs)
    w = tm.to_gltf(wheel)
    red, black, grey = (0.85, 0.1, 0.12), (0.06, 0.06, 0.07), (0.5, 0.5, 0.55)
    parts = [
        _box("kart_floor", (0.7, 0.05, 1.45), (0.0, 0.12, 0.25), red, rough=0.4),
        _box("kart_nose", (0.55, 0.14, 0.32), (0.0, 0.2, 0.92), red, rough=0.4, tilt_x=12),
        _box("kart_seat", (0.42, 0.08, 0.4), (0.0, 0.2, -0.05), black, rough=0.7),
        _box("kart_back", (0.42, 0.42, 0.06), (0.0, 0.42, -0.27), black, rough=0.7, tilt_x=-12),
        _box("kart_engine", (0.3, 0.2, 0.2), (0.0, 0.24, -0.5), grey, metal=0.7),
        _box("kart_exhaust", (0.05, 0.05, 0.16), (0.14, 0.3, -0.66), grey, metal=0.8),
        _cyl("kart_column", 0.015, 0.015, 0.14, w[1] - 0.02, grey, metal=0.8, z=w[2] + 0.06),
    ]

    def steering(bm):
        # A disc tilted back towards the driver, round the hands' rim.
        import bmesh
        bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.135, radius2=0.135, depth=0.025)
        axis = Vector((0.0, 0.6, -0.8))
        u = Vector((1.0, 0.0, 0.0))
        side = axis.cross(u)
        for v in bm.verts:
            vx, vy, vz = v.co
            p = Vector(w) + u * vx + side * vy + axis * vz
            v.co = tm._g(p.x, p.y, p.z)
    rim = tm._mesh_object("kart_wheel", steering)
    rim.data.materials.append(tm._material("kart_wheel", black, rough=0.6))
    parts.append(rim)
    for x in (-0.46, 0.46):
        for z in (-0.42, 0.88):
            def tyre(bm, x=x, z=z):
                import bmesh
                bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.13, radius2=0.13, depth=0.14)
                for v in bm.verts:
                    vx, vy, vz = v.co
                    # Axle across the kart (glTF x).
                    v.co = tm._g(x + vz, 0.13 + vy, z + vx)
            o = tm._mesh_object(f"kart_tyre{x}{z}", tyre)
            o.data.materials.append(tm._material(f"kart_tyre{x}{z}", black, rough=0.9))
            parts.append(o)
    obj = tm._join(parts, "kart")
    _point("kart", "exhaust", 0.14, 0.3, -0.76).parent = obj
    return obj


def make_rod(b, legs):
    """A fishing rod along the thumb: butt behind the fist, tip 1.5 m out."""
    parts = [
        _cyl("rod_butt", 0.016, 0.014, -0.28, 0.08, (0.15, 0.15, 0.17), rough=0.6),
        _cyl("rod_blank", 0.011, 0.003, 0.08, 1.5, (0.2, 0.35, 0.75), rough=0.3),
        _cyl("rod_reel", 0.035, 0.035, -0.06, 0.0, (0.75, 0.75, 0.78), metal=0.8, z=-0.045),
    ]
    obj = tm._join(parts, "rod")
    _point("rod", "tip", 0.0, 1.5, 0.0).parent = obj
    return obj


def make_balloons(b, legs):
    """Three balloons on strings up from the fist (along the thumb)."""
    import bmesh
    parts = []
    spec = [(-0.13, 0.86, 0.02, (0.92, 0.15, 0.2)), (0.12, 0.92, -0.03, (0.98, 0.78, 0.12)), (0.0, 1.06, 0.04, (0.2, 0.5, 0.95))]
    for i, (x, y, z, col) in enumerate(spec):
        def balloon(bm, x=x, y=y, z=z):
            bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
            for v in bm.verts:
                vx, vy, vz = v.co
                # A little egg-shaped, narrower at the knot.
                k = 0.13 * (1 - 0.12 * min(0.0, vz))
                v.co = tm._g(x + vx * k, y + vz * 0.16, z + vy * k)
        o = tm._mesh_object(f"balloon{i}", balloon)
        o.data.materials.append(tm._material(f"balloon{i}", col, rough=0.2))
        parts.append(o)

        def string(bm, x=x, y=y, z=z):
            n = 6
            prev = None
            verts = []
            for j in range(n + 1):
                s = j / n
                verts.append(bm.verts.new(tm._g(x * s + 0.004, (y - 0.17) * s, z * s)))
                verts.append(bm.verts.new(tm._g(x * s - 0.004, (y - 0.17) * s, z * s)))
            for j in range(n):
                bm.faces.new([verts[2 * j], verts[2 * j + 1], verts[2 * j + 3], verts[2 * j + 2]])
        s = tm._mesh_object(f"balloon_string{i}", string)
        m = tm._material(f"balloon_string{i}", (0.95, 0.95, 0.95), rough=0.8)
        m.use_backface_culling = False
        s.data.materials.append(m)
        parts.append(s)
    return tm._join(parts, "balloons")


def make_hammer(b, legs):
    """A squeaky toy hammer along the thumb: handle in the fist, head out."""
    import bmesh
    parts = [_cyl("hammer_handle", 0.016, 0.016, -0.08, 0.3, (0.98, 0.8, 0.15), rough=0.4)]

    # The head: a fat cylinder across the handle's end.

    def head(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.06, radius2=0.06, depth=0.2)
        for v in bm.verts:
            vx, vy, vz = v.co
            v.co = tm._g(vz, 0.33 + vy, vx)
    h = tm._mesh_object("hammer_head", head)
    h.data.materials.append(tm._material("hammer_head", (0.9, 0.12, 0.15), rough=0.35))
    parts.append(h)
    obj = tm._join(parts, "hammer")
    _point("hammer", "head", 0.0, 0.33, 0.0).parent = obj
    return obj


def _outline(pts, n=6):
    """A closed Catmull-Rom curve through `pts` ((x, y) pairs), `n` points
    a segment."""
    out = []
    k = len(pts)
    for i in range(k):
        p0, p1, p2, p3 = (pts[(i + j - 1) % k] for j in range(4))
        for s in range(n):
            t = s / n
            out.append(tuple(0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t
                                    + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t ** 3) for a in (0, 1)))
    return out


def _ccw(ring):
    area = sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))
    return ring if area > 0 else list(reversed(ring))


def _inset(ring, d):
    """A counter-clockwise `ring` moved in by `d` (the inside is on the left
    of the way round)."""
    out = []
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i - 1], ring[(i + 1) % len(ring)]
        tx, ty = bx - ax, by - ay
        l = math.hypot(tx, ty) or 1.0
        out.append((ring[i][0] - ty / l * d, ring[i][1] + tx / l * d))
    return out


def _slab(name, ring, z0, z1, color, chamfer=0.0, rough=0.5, metal=0.0):
    """The shape `ring` ((x, y), glTF) as a solid from z0 to z1, its edges
    chamfered by `chamfer`."""
    import bmesh
    ring = _ccw(ring)
    c = chamfer
    layers = ([(_inset(ring, c), z0), (ring, z0 + c), (ring, z1 - c), (_inset(ring, c), z1)] if c
              else [(ring, z0), (ring, z1)])

    def b(bm):
        loops = [[bm.verts.new(tm._g(x, y, z)) for x, y in r] for r, z in layers]
        for lo, hi in zip(loops, loops[1:]):
            for i in range(len(ring)):
                j = (i + 1) % len(ring)
                bm.faces.new([lo[i], lo[j], hi[j], hi[i]])
        bm.faces.new(list(reversed(loops[0])))
        bm.faces.new(loops[-1])
    o = tm._mesh_object(name, b)
    o.data.materials.append(tm._material(name, color, rough=rough, metal=metal))
    return o


def _rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _strip(p0, p1, w):
    """A band `w` wide from p0 to p1."""
    (x0, y0), (x1, y1) = p0, p1
    l = math.hypot(x1 - x0, y1 - y0)
    nx, ny = -(y1 - y0) / l * w / 2, (x1 - x0) / l * w / 2
    return [(x0 - nx, y0 - ny), (x1 - nx, y1 - ny), (x1 + nx, y1 + ny), (x0 + nx, y0 + ny)]


def _circle(x, y, r, n=16):
    return [(x + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def make_guitar(b, legs):
    """An electric guitar in a double-cutaway solid body's proportions (a
    0.46 m body, a 0.65 m scale, about 0.96 m long): the body's middle at
    the origin, the neck along +Y (glTF), face +Z, its top edge (the long
    horn, the tuners' side) -X."""
    body = _outline([
        (0.0, -0.30), (0.10, -0.285), (0.16, -0.23), (0.175, -0.14), (0.145, -0.05), (0.14, 0.02), (0.165, 0.10),
        (0.165, 0.185), (0.135, 0.205), (0.10, 0.13), (0.06, 0.08), (0.028, 0.10), (-0.028, 0.10), (-0.06, 0.085),
        (-0.10, 0.15), (-0.135, 0.155), (-0.148, 0.09), (-0.128, 0.02), (-0.14, -0.04), (-0.172, -0.13),
        (-0.16, -0.225), (-0.10, -0.285)])
    guard = _outline([
        (0.035, 0.095), (0.07, 0.07), (0.10, 0.115), (0.12, 0.10), (0.115, 0.0), (0.10, -0.08), (0.06, -0.15),
        (0.0, -0.19), (-0.07, -0.21), (-0.12, -0.19), (-0.125, -0.12), (-0.10, -0.05), (-0.11, 0.02),
        (-0.085, 0.07), (-0.035, 0.095)])
    head = _outline([
        (-0.0215, 0.485), (0.0215, 0.485), (0.03, 0.50), (0.05, 0.56), (0.055, 0.62), (0.045, 0.665),
        (0.02, 0.672), (0.0, 0.66), (-0.015, 0.62), (-0.028, 0.55), (-0.03, 0.51)])
    top = 0.0225                    # the body's face
    nut, bridge = 0.48, -0.155      # 0.635 m between, near enough the scale
    board = 0.036                   # the fretboard's face

    def width(y):
        """The neck's width: 56 mm at the body, 43 mm at the nut."""
        return 0.056 + (0.043 - 0.056) * (y - 0.06) / (nut - 0.06)

    red, black, white = (0.75, 0.06, 0.08), (0.04, 0.04, 0.045), (0.95, 0.94, 0.9)
    maple, rosewood, chrome = (0.86, 0.66, 0.4), (0.22, 0.12, 0.07), (0.82, 0.82, 0.84)
    parts = [
        _slab("guitar_body", body, -top, top, red, chamfer=0.007, rough=0.25),
        _slab("guitar_guard", guard, top, top + 0.002, black, rough=0.3),
        _slab("guitar_neck", [(-width(0.02) / 2, 0.02), (width(0.02) / 2, 0.02), (0.0215, nut), (-0.0215, nut)],
              0.0, board - 0.006, maple, chamfer=0.006, rough=0.5),
        _slab("guitar_board", [(-width(0.02) / 2, 0.02), (width(0.02) / 2, 0.02), (0.0215, nut), (-0.0215, nut)],
              board - 0.006, board, rosewood, rough=0.7),
        _slab("guitar_nut", _rect(-0.0215, nut, 0.0215, nut + 0.005), board - 0.006, board + 0.003, white, rough=0.4),
        _slab("guitar_head", head, 0.012, 0.026, maple, chamfer=0.003, rough=0.5),
        _slab("guitar_bridge", _rect(-0.04, bridge - 0.025, 0.04, bridge + 0.01), top, top + 0.011, chrome,
              chamfer=0.002, rough=0.2, metal=0.9),
    ]
    for i, y in enumerate((0.03, -0.035, -0.10)):
        parts.append(_slab(f"guitar_pickup{i}", _rect(-0.035, y - 0.009, 0.035, y + 0.009), top + 0.002, top + 0.008,
                           white, chamfer=0.002, rough=0.4))
    for i, (x, y) in enumerate(((-0.085, -0.105), (-0.105, -0.15), (-0.115, -0.195))):
        parts.append(_slab(f"guitar_knob{i}", _circle(x, y, 0.011), top + 0.002, top + 0.016, white, chamfer=0.002, rough=0.4))
    for i in range(6):
        parts.append(_slab(f"guitar_tuner{i}", _circle(0.012 + i * 0.004, 0.505 + i * 0.029, 0.004, 10), 0.026, 0.036,
                           chrome, rough=0.2, metal=0.9))
    # Frets where equal temperament puts them, and the dots between.
    fret_y = [nut - 0.65 * (1 - 2 ** (-n / 12)) for n in range(22)]
    for n in range(1, 22):
        y = fret_y[n]
        parts.append(_slab(f"guitar_fret{n}", _strip((-width(y) / 2, y), (width(y) / 2, y), 0.0018), board, board + 0.0018,
                           chrome, rough=0.3, metal=0.8))
    for n in (3, 5, 7, 9, 12, 15, 17, 19, 21):
        y = (fret_y[n - 1] + fret_y[n]) / 2
        for x in ((-0.012, 0.012) if n == 12 else (0.0,)):
            parts.append(_slab(f"guitar_dot{n}_{x}", _circle(x, y, 0.003, 10), board, board + 0.0004, white, rough=0.4))
    for i in range(6):
        s = (i - 2.5) / 2.5
        parts.append(_slab(f"guitar_string{i}", _strip((0.026 * s, bridge), (0.0175 * s, nut), 0.0015),
                           board + 0.0025, board + 0.004, (0.9, 0.9, 0.88), rough=0.3, metal=0.8))
    obj = tm._join(parts, "guitar")
    # Drawn with its top edge at +X, which is the character's left in glTF:
    # held, it hung upside down (knobs up). Mirrored, the top edge is -X.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def guitar_grip(b):
    """The guitar's place on the hips bone (glTF, relative to its head)."""
    body, fret, _ = guitar_frame(b)
    y = Vector(tm.to_gltf((fret - body).normalized()))
    z = Vector(tm.to_gltf(V(fwd=1)))
    z = (z - y * y.dot(z)).normalized()
    x = y.cross(z).normalized()
    q = Matrix((x, y, z)).transposed().to_quaternion()
    pos = tm.to_gltf(body - b.hips)
    return {"position": [round(v, 4) for v in pos], "rotation": [round(v, 5) for v in (q.x, q.y, q.z, q.w)]}


def make_boombox(b, legs):
    """A boombox on the floor beside them (root prop, their right)."""
    x0, y0 = -0.42, 0.13
    parts = [
        _box("boombox_case", (0.46, 0.24, 0.14), (x0, y0, 0.05), (0.12, 0.12, 0.14), rough=0.5),
        _box("boombox_handle", (0.34, 0.025, 0.03), (x0, y0 + 0.16, 0.05), (0.7, 0.7, 0.72), metal=0.8),
        _box("boombox_deck", (0.1, 0.06, 0.01), (x0, y0 + 0.06, 0.122), (0.25, 0.75, 0.95), rough=0.2),
    ]
    for dx in (-0.14, 0.14):
        def cone(bm, dx=dx):
            import bmesh
            bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.075, radius2=0.04, depth=0.02)
            for v in bm.verts:
                vx, vy, vz = v.co
                v.co = tm._g(x0 + dx + vx, y0 - 0.02 + vy, 0.125 + vz)
        o = tm._mesh_object(f"boombox_spk{dx}", cone)
        o.data.materials.append(tm._material(f"boombox_spk{dx}", (0.35, 0.35, 0.38), rough=0.6, metal=0.3))
        parts.append(o)
    return tm._join(parts, "boombox")


def _ball(name, x, y, z, r, color, rough=0.6, emit=None, sy=1.0):
    import bmesh

    def b(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
        for v in bm.verts:
            vx, vy, vz = v.co
            v.co = tm._g(x + vx * r, y + vz * r * sy, z + vy * r)
    o = tm._mesh_object(name, b)
    o.data.materials.append(tm._material(name, color, rough=rough, emit=emit))
    return o


def make_icecream(b, legs):
    """A cone along the thumb, two scoops on top (the umbrella pose holds it
    up at the chest)."""
    parts = [
        _cyl("icecream_cone", 0.006, 0.034, -0.05, 0.11, (0.82, 0.58, 0.3), segments=14, rough=0.8),
        _ball("icecream_scoop0", 0.0, 0.13, 0.0, 0.038, (0.98, 0.72, 0.8), sy=0.85),
        _ball("icecream_scoop1", 0.004, 0.185, 0.002, 0.033, (0.97, 0.93, 0.8), sy=0.9),
        _ball("icecream_cherry", 0.0, 0.226, 0.0, 0.011, (0.85, 0.06, 0.12), rough=0.3),
    ]
    obj = tm._join(parts, "icecream")
    _point("icecream", "drip", 0.0, 0.105, 0.03).parent = obj
    return obj


def make_waterpistol(b, legs):
    """A pump water blaster along the thumb (the aim pose shoulders it):
    tank on top, grip down, a long nozzle."""
    blue, orange, yellow = (0.15, 0.45, 0.95), (0.98, 0.5, 0.1), (0.98, 0.85, 0.15)
    parts = [
        _cyl("blaster_body", 0.032, 0.032, -0.16, 0.2, blue, rough=0.35),
        _cyl("blaster_tank", 0.045, 0.045, -0.12, 0.06, (0.55, 0.85, 1.0), rough=0.1, z=0.07),
        _cyl("blaster_nozzle", 0.012, 0.01, 0.2, 0.34, orange, rough=0.35),
        _cyl("blaster_pump", 0.024, 0.024, 0.06, 0.16, yellow, rough=0.4, z=-0.045),
        _box("blaster_grip", (0.03, 0.04, 0.09), (0.0, -0.08, -0.06), orange, rough=0.4),
    ]
    obj = tm._join(parts, "waterpistol")
    _point("waterpistol", "muzzle", 0.0, 0.34, 0.0).parent = obj
    return obj


def _tube(name, path, radius, color, seg=10, rough=0.4, metal=0.0):
    """A round wire along `path` (glTF points), `radius` thick."""
    def b(bm):
        rings = []
        n = len(path) - 1
        for i, p in enumerate(path):
            t = (path[min(n, i + 1)] - path[max(0, i - 1)]).normalized()
            ref = Vector((0.0, 0.0, 1.0)) if abs(t.z) < 0.9 else Vector((1.0, 0.0, 0.0))
            e1 = (ref - t * t.dot(ref)).normalized()
            e2 = t.cross(e1)
            rings.append([bm.verts.new(tm._g(*(p + (e1 * math.cos(a) + e2 * math.sin(a)) * radius)))
                          for a in (2 * math.pi * k / seg for k in range(seg))])
        for lo, hi in zip(rings, rings[1:]):
            for k in range(seg):
                bm.faces.new([lo[k], lo[(k + 1) % seg], hi[(k + 1) % seg], hi[k]])
    o = tm._mesh_object(name, b)
    o.data.materials.append(tm._material(name, color, rough=rough, metal=metal))
    return o


def make_lantern(b, legs):
    """A hurricane lantern hanging from the fist by its wire bail (the
    lantern pose holds it low at the side): a brass cap and base, a glass
    globe in a four-post cage, the flame lit inside."""
    brass, dark = (0.78, 0.56, 0.2), (0.22, 0.16, 0.1)
    # The bail: a half ring over the cap, its top in the fist.
    bail = [Vector((0.034 * math.cos(a), -0.05 + 0.034 * math.sin(a), 0.0)) for a in (math.pi * k / 12 for k in range(13))]
    parts = [
        _tube("lantern_bail", bail, 0.0022, dark, metal=0.6, rough=0.3),
        _cyl("lantern_vent", 0.01, 0.012, -0.072, -0.058, brass, metal=0.85, rough=0.25),
        _cyl("lantern_cap", 0.013, 0.046, -0.094, -0.07, brass, metal=0.85, rough=0.25),
        _cyl("lantern_rim", 0.048, 0.048, -0.1, -0.093, dark, metal=0.6, rough=0.35),
        _ball("lantern_globe", 0.0, -0.155, 0.0, 0.039, (1.0, 0.9, 0.62), rough=0.08, emit=(0.95, 0.72, 0.36), sy=1.45),
        _ball("lantern_flame", 0.0, -0.158, 0.0, 0.011, (1.0, 0.85, 0.4), emit=(1.0, 0.82, 0.4), sy=1.9),
        _cyl("lantern_wick", 0.006, 0.006, -0.19, -0.172, dark, rough=0.6),
        _cyl("lantern_base", 0.05, 0.046, -0.232, -0.205, brass, metal=0.85, rough=0.25),
        _cyl("lantern_foot", 0.052, 0.052, -0.238, -0.232, dark, metal=0.6, rough=0.35),
    ]
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        parts.append(_cyl(f"lantern_post{k}", 0.0028, 0.0028, -0.205, -0.1, dark, segments=6, metal=0.6, rough=0.35,
                          x=0.045 * math.cos(a), z=0.045 * math.sin(a)))
    obj = tm._join(parts, "lantern")
    _point("lantern", "light", 0.0, -0.155, 0.0).parent = obj
    return obj


def _ear(name, s, R, Hd, y0, z0, outer, inner, tuft):
    """One cat ear on the reference crown (the santa hat's ellipsoid): its
    own object, its origin at the base so the app can twitch it."""
    import bmesh
    th = math.radians(36)
    # On the crown's surface, a little sunk into the hair.
    p = Vector((s * R * math.sin(th) * 0.96, y0 + Hd * math.cos(th) * 0.96, z0 + 0.012))
    n = Vector((s * math.sin(th) / R, math.cos(th) / Hd, 0.0)).normalized()
    up = (n + Vector((s * 0.14, 0.0, 0.0))).normalized()
    fwd = Vector((0.0, 0.0, 1.0))
    side = up.cross(fwd).normalized()

    def shell(bm, w, d, h, lift, front):
        rings = []
        for i in range(7):
            t = i / 6
            k = (1 - t) ** 0.9
            rings.append([bm.verts.new(tm._g(*(side * (w * k * math.cos(a)) + up * (lift + h * t)
                                                  + fwd * (front + d * k * math.sin(a) + 0.009 * t * t))))
                          for a in (2 * math.pi * j / 14 for j in range(14))])
        for lo, hi in zip(rings, rings[1:]):
            for j in range(14):
                bm.faces.new([lo[j], lo[(j + 1) % 14], hi[(j + 1) % 14], hi[j]])
        bm.faces.new(list(reversed(rings[0])))

    out = tm._mesh_object(f"{name}_outer", lambda bm: shell(bm, 0.034, 0.011, 0.078, 0.0, 0.0))
    out.data.materials.append(tm._material(f"{name}_outer", outer, rough=0.9))
    inn = tm._mesh_object(f"{name}_inner", lambda bm: shell(bm, 0.02, 0.005, 0.06, 0.008, 0.008))
    inn.data.materials.append(tm._material(f"{name}_inner", inner, rough=0.7))
    tufts = []
    for j, dx in enumerate((-0.008, 0.0, 0.008)):
        def tb(bm, dx=dx, j=j):
            bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.0035, radius2=0.0, depth=0.03)
            lean = (side * dx * 1.5 + up).normalized()
            for v in bm.verts:
                vx, vy, vz = v.co
                q = side * (dx + vx) + fwd * (0.014 + vy) + lean * (0.012 + (vz + 0.5) * 0.03 + 0.004 * j)
                v.co = tm._g(*q)
        t = tm._mesh_object(f"{name}_tuft{j}", tb)
        t.data.materials.append(tm._material(f"{name}_tuft{j}", tuft, rough=0.9))
        tufts.append(t)
    ear = tm._join([out, inn, *tufts], name)
    # Origin at the base: the vertices are about it, the object there.
    ear.location = tm._g(*p)
    return ear


def make_catears(b, legs):
    """A cat-ear headband in the head's frame, on the santa hat's reference
    crown so the app fits it to each avatar's hair the same way: a thin
    band over the top, two cupped ears with pink insides and pale tufts."""
    R, Hd, y0, z0 = HAT_R, HAT_DOME, HAT_BRIM_Y, HAT_BRIM_Z
    arc = [Vector((R * math.sin(a) * 0.99, y0 + Hd * math.cos(a) * 0.99, z0 + 0.012))
           for a in (math.radians(-96 + 192 * k / 24) for k in range(25))]
    band = _tube("catears_band", arc, 0.0045, (0.08, 0.08, 0.09), seg=8, rough=0.35)
    fur, pink, pale = (0.14, 0.13, 0.15), (0.98, 0.62, 0.72), (0.96, 0.92, 0.9)
    for s, tag in ((1, "earl"), (-1, "earr")):
        _ear(f"catears_{tag}", s, R, Hd, y0, z0, fur, pink, pale).parent = band
    return band


# The Santa hat's own measures (glTF, the head's frame): its brim's centre
# and radius and how high its crown rises over the brim. The app fits these
# to each avatar's hair (props.json `fit`, avatar_renderer _fitCrown).
HAT_BRIM_Y, HAT_BRIM_Z = 0.12, -0.01
HAT_R, HAT_DOME = 0.118, 0.10


def make_santahat(b, legs):
    """A Santa hat in the head's frame: a soft crown over the top of the
    head (a dome, so a full head of hair stays under it), the tip flopping
    back and down to a bobble, a white brim round it."""
    import bmesh
    y0, z0, R, Hd = HAT_BRIM_Y, HAT_BRIM_Z, HAT_R, HAT_DOME

    def crown(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=1.0)
        for v in list(bm.verts):
            if v.co.z < -0.02:
                bm.verts.remove(v)
        for v in bm.verts:
            vx, vy, vz = v.co
            v.co = tm._g(vx * R, y0 + max(0.0, vz) * Hd, z0 + vy * R)
    c = tm._mesh_object("santahat_crown", crown)
    red = tm._material("santahat_crown", (0.82, 0.06, 0.1), rough=0.8)
    red.use_backface_culling = False
    c.data.materials.append(red)

    # The tip: rings along a curve from the crown's top, up and back, then
    # flopping down behind, thinning to the bobble.
    p0 = Vector((0.0, y0 + Hd * 0.8, z0 - 0.02))
    p1 = Vector((0.01, y0 + Hd + 0.08, z0 - 0.1))
    p2 = Vector((0.03, y0 + Hd - 0.03, z0 - 0.21))
    n, seg = 12, 16
    path = [((1 - s) ** 2) * p0 + 2 * (1 - s) * s * p1 + (s ** 2) * p2 for s in (i / n for i in range(n + 1))]

    def tail(bm):
        rings = []
        for i, p in enumerate(path):
            t = (path[min(n, i + 1)] - path[max(0, i - 1)]).normalized()
            e1 = (Vector((1.0, 0.0, 0.0)) - t * t.x).normalized()
            e2 = t.cross(e1)
            r = 0.072 * (1 - i / n) + 0.012 * (i / n)
            rings.append([bm.verts.new(tm._g(*(p + (e1 * math.cos(a) + e2 * math.sin(a)) * r)))
                          for a in (2 * math.pi * k / seg for k in range(seg))])
        for lo, hi in zip(rings, rings[1:]):
            for k in range(seg):
                bm.faces.new([lo[k], lo[(k + 1) % seg], hi[(k + 1) % seg], hi[k]])
    t = tm._mesh_object("santahat_tip", tail)
    t.data.materials.append(red)

    # The brim's caps sit inside the head and the crown.
    brim = _cyl("santahat_brim", R + 0.008, R + 0.008, y0 - 0.02, y0 + 0.022, (0.97, 0.97, 0.95), segments=24, rough=0.95, z=z0)
    tip = path[-1]
    parts = [c, t, brim, _ball("santahat_bobble", tip.x, tip.y, tip.z, 0.028, (0.97, 0.97, 0.95), rough=0.95)]
    return tm._join(parts, "santahat")


# id → (builder, bone, grip). Grips are in the bone's normalized frame.
ROAM_PROPS = {
    "umbrella": (make_umbrella, "rightHand", lambda: rod_grip("R")),
    "vacuum": (make_vacuum, "rightHand", lambda: rod_grip("R")),
    "spudgun": (make_spudgun, "rightHand", lambda: rod_grip("R")),
    "launcher": (make_launcher, "rightHand", lambda: rod_grip("R", along=0.0)),
    "shovel": (make_shovel, "rightHand", lambda: rod_grip("R")),
    "rod": (make_rod, "rightHand", lambda: rod_grip("R")),
    "hammer": (make_hammer, "rightHand", lambda: rod_grip("R")),
    "guitar": (make_guitar, "hips", None),
    "boombox": (make_boombox, "root", lambda: {"position": [0, 0, 0], "rotation": [0, 0, 0, 1]}),
    "balloons": (make_balloons, "rightHand", lambda: rod_grip("R")),
    "cape": (make_cape, "upperChest", lambda: {"position": [0, 0, 0], "rotation": [0, 0, 0, 1]}),
    "sunglasses": (make_sunglasses, "head", lambda: {"position": [0, 0, 0], "rotation": [0, 0, 0, 1]}),
    "sunbed": (make_sunbed, "root", lambda: {"position": [0, 0, 0], "rotation": [0, 0, 0, 1]}),
    "kart": (make_kart, "root", lambda: {"position": [0, 0, 0], "rotation": [0, 0, 0, 1]}),
    "icecream": (make_icecream, "rightHand", lambda: rod_grip("R")),
    "waterpistol": (make_waterpistol, "rightHand", lambda: rod_grip("R")),
    "lantern": (make_lantern, "rightHand", lambda: rod_grip("R")),
    "santahat": (make_santahat, "head", lambda: {
        "position": [0, 0, 0], "rotation": [0, 0, 0, 1],
        "fit": {"kind": "crown", "brim": [0.0, HAT_BRIM_Y, HAT_BRIM_Z], "radius": HAT_R + 0.008, "height": HAT_DOME},
    }),
    # The same crown, fitted the same way; the ears keep their own shape.
    "catears": (make_catears, "head", lambda: {
        "position": [0, 0, 0], "rotation": [0, 0, 0, 1],
        "fit": {"kind": "crown", "brim": [0.0, HAT_BRIM_Y, HAT_BRIM_Z], "radius": HAT_R, "height": HAT_DOME,
                "uniform": ["catears_earl", "catears_earr"]},
    }),
}
BONE_KEY = {"rightHand": "right_hand", "leftHand": "left_hand", "upperChest": "upper_chest", "head": "head", "hips": "hips"}


def export_prop(obj, path):
    bpy = tm.bpy
    for o in bpy.data.objects:
        o.select_set(False)
    for o in [obj, *obj.children_recursive]:
        o.select_set(True)
    keep = obj.matrix_world.copy()
    parent = obj.parent
    obj.parent = None
    obj.matrix_world = Matrix()
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format="GLB",
                              export_apply=True, export_animations=False)
    obj.parent = parent
    obj.matrix_world = keep


# ── main ────────────────────────────────────────────────────────────────

def main():
    rig = tm.import_author_vrm()
    solver = RoamSolver(rig)
    body = Body(rig)
    legs = Legs(rig)
    os.makedirs(OUT_DIR, exist_ok=True)
    cam = None
    if tm.PREVIEW_DIR:
        os.makedirs(tm.PREVIEW_DIR, exist_ok=True)
        cam = tm.setup_preview(rig)
        bpy = tm.bpy
        bpy.context.scene.render.resolution_x = 540
        bpy.context.scene.render.resolution_y = 540
    wanted = list(tm.WANTED) or ["all"]
    # Props: built (and exported, with props.json) whenever a clip that
    # shows one is built, or for `props`.
    # Prop ids among them: only those GLBs are written (props.json still
    # lists every prop), so the others aren't re-exported for nothing.
    only = [w for w in wanted if w in ROAM_PROPS]
    want_props = bool(only) or "props" in wanted or "all" in wanted or any(PROP_CLIPS.get(c) for c in wanted)
    wanted = list(CLIPS) if "all" in wanted else [c for c in wanted if c != "props" and c not in ROAM_PROPS]
    props = {}
    if want_props:
        os.makedirs(os.path.join(OUT_DIR, "props"), exist_ok=True)
        manifest = {}
        for pid, (build, bone, grip) in ROAM_PROPS.items():
            obj = build(body, legs)
            # A grip of None: the prop sits where its pose puts it (guitar).
            g = grip() if grip else guitar_grip(body)
            if tm.EXPORT and (not only or pid in only):
                export_prop(obj, os.path.join(OUT_DIR, "props", f"{pid}.glb"))
            manifest[pid] = {"file": f"props/{pid}.glb", "bone": bone, "position": g["position"], "rotation": g["rotation"]}
            if g.get("fit"):
                manifest[pid]["fit"] = g["fit"]
            if bone != "root":
                tm.attach_preview_prop(rig, obj, BONE_KEY[bone], g["position"], g["rotation"])
            props[pid] = obj
        if tm.EXPORT:
            with open(os.path.join(OUT_DIR, "props.json"), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2)
                fh.write("\n")
    for cid in wanted:
        dur, build = CLIPS[cid]
        fn = build(body, legs)
        act, n = tm.key_clip(rig, solver, f"roam_{cid}", dur, fn)
        if tm.EXPORT:
            out = TOYS_DIR if cid in TOY_CLIPS else OUT_DIR
            os.makedirs(out, exist_ok=True)
            tm.export_vrma(rig, os.path.join(out, f"{cid}.vrma"))
        if cam:
            for pid, obj in props.items():
                for o in [obj, *obj.children_recursive]:
                    o.hide_render = pid not in PROP_CLIPS.get(cid, [])
            c = body.hips
            views = [(c + V(fwd=3.4, up=0.1), c + V(up=-0.1)),
                     (c + V(fwd=0.6, up=0.1, right=3.3), c + V(up=-0.1))]
            frames = sorted(set([1, n // 3, (2 * n) // 3, n]))
            tm.render_frames(cid, frames, cam, views)
    print("ROAM MOTIONS DONE", wanted)


main()
