#!/usr/bin/env python
"""dlp3d.ai ``motion_data.zip`` → VRMA clip library for Rexclaw.

Digital Life Project 2 (github.com/dlp3d-ai) ships its motion database as
Blender-exported ``.npz`` clips: per frame, one 3×3 ``matrix_basis`` per bone
(the pose delta in the bone's own rest frame) plus the hips translation, on an
MMD-style rig (``Hips/Spine/Chest/Neck/Head/Left_arm/…``). A separate rest
skeleton ``.npz`` per avatar carries every bone's armature-space rest matrix.

This tool turns one avatar's clips into ``.vrma`` files plus a
``manifest.json`` (timing, states, loop ranges, English labels and tags)
that the Rexclaw motion director reads.

Maths (column vectors, world = armature space):

    Blender pose:      W_j = W_parent · L_parent⁻¹ · L_j · B_j
    rest-relative:     Ŵ_j = W_j · L_j⁻¹ = Ŵ_parent · (L_j B_j L_j⁻¹)
    frame change:      Blender Z-up / faces -Y  →  glTF Y-up / faces +Z
                       via C = [[1,0,0],[0,0,1],[0,-1,0]]  (x, z, -y)
    T-pose calibration: G_j = minimal arc taking the rest direction of bone
                       j's primary segment to its canonical T-pose direction
                       (+Y spine, +X left arm, -X right arm, -Y legs);
                       unlisted bones inherit their parent's G.
    written global:    T_j = Ŵ_j · G_jᵀ ; rest offsets o_c = G_j (p_c - p_j)

so target bone vectors equal source bone vectors every frame while the
written rest pose is a T-pose (what @pixiv/three-vrm-animation expects).

The VRMA serialisation itself is the writer from the sibling project
``kimodo_NPZ_to_fbx_and_vrma`` (pure numpy/scipy); point ``--kimodo`` at it.

Usage:
    python tools/motion/dlp3d_npz2vrma.py motion_data.zip \
        --avatar Ani-default --out assets/motion/dlp3d-ani \
        [--kimodo /path/to/kimodo_NPZ_to_fbx_and_vrma] [--ids 721,722] [--in-place]

``assets/motion/`` is the shipped library (tracked, packaged into the Docker
image and the desktop build); ``data/assets/motion/`` is the user drop-in
folder, and a library there shadows a shipped one of the same name.

Provenance: the dlp3d code is MIT (S-Lab, Nanyang Technological University),
but the motion archive is a separate Google Drive / Baidu download that
carries no licence text of its own. Credited in README.md and in the app's
Settings → Credits.
"""

from __future__ import annotations

import argparse
import io
import json
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np

FPS = 30.0
LIBRARY_VERSION = 1

# Blender armature frame → glTF: x' = x, y' = z, z' = -y.
C = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])

DLP_TO_VRM = {
    "Hips": "hips", "Spine": "spine", "Chest": "chest", "Neck": "neck", "Head": "head",
    "Left_shoulder": "leftShoulder", "Left_arm": "leftUpperArm",
    "Left_elbow": "leftLowerArm", "Left_wrist": "leftHand",
    "Right_shoulder": "rightShoulder", "Right_arm": "rightUpperArm",
    "Right_elbow": "rightLowerArm", "Right_wrist": "rightHand",
    "Left_leg": "leftUpperLeg", "Left_knee": "leftLowerLeg",
    "Left_ankle": "leftFoot", "Left_toe": "leftToes",
    "Right_leg": "rightUpperLeg", "Right_knee": "rightLowerLeg",
    "Right_ankle": "rightFoot", "Right_toe": "rightToes",
}
for _side, _S in (("L", "left"), ("R", "right")):
    DLP_TO_VRM[f"Thumb0_{_side}"] = f"{_S}ThumbMetacarpal"
    DLP_TO_VRM[f"Thumb1_{_side}"] = f"{_S}ThumbProximal"
    DLP_TO_VRM[f"Thumb2_{_side}"] = f"{_S}ThumbDistal"
    for _dlp, _vrm in (("IndexFinger", "Index"), ("MiddleFinger", "Middle"),
                       ("RingFinger", "Ring"), ("LittleFinger", "Little")):
        DLP_TO_VRM[f"{_dlp}1_{_side}"] = f"{_S}{_vrm}Proximal"
        DLP_TO_VRM[f"{_dlp}2_{_side}"] = f"{_S}{_vrm}Intermediate"
        DLP_TO_VRM[f"{_dlp}3_{_side}"] = f"{_S}{_vrm}Distal"

# Canonical T-pose direction of the segment leaving each bone (glTF frame),
# keyed by VRM name → (primary child VRM name, direction).
CANONICAL = {
    "hips": ("spine", (0, 1, 0)),
    "spine": ("chest", (0, 1, 0)),
    "chest": ("neck", (0, 1, 0)),
    "neck": ("head", (0, 1, 0)),
    "leftShoulder": ("leftUpperArm", (1, 0, 0)),
    "leftUpperArm": ("leftLowerArm", (1, 0, 0)),
    "leftLowerArm": ("leftHand", (1, 0, 0)),
    "leftHand": ("leftMiddleProximal", (1, 0, 0)),
    "rightShoulder": ("rightUpperArm", (-1, 0, 0)),
    "rightUpperArm": ("rightLowerArm", (-1, 0, 0)),
    "rightLowerArm": ("rightHand", (-1, 0, 0)),
    "rightHand": ("rightMiddleProximal", (-1, 0, 0)),
    "leftUpperLeg": ("leftLowerLeg", (0, -1, 0)),
    "leftLowerLeg": ("leftFoot", (0, -1, 0)),
    "rightUpperLeg": ("rightLowerLeg", (0, -1, 0)),
    "rightLowerLeg": ("rightFoot", (0, -1, 0)),
}

# Curated English metadata keyed by the database's Chinese description.
# tags: what the clip IS ("idle_safe" = the fidget pool); mask: whether the
# clip involves the legs/feet ("full") or only the upper body ("upper").
EN = {
    "OK手势": ("OK hand sign", ["agree", "ok"], "upper"),
    "一级害羞：摸后脑勺，躯干扭捏": ("shy: scratches back of head, squirms", ["shy", "fidget", "idle_safe"], "upper"),
    "上身前倾，五指尖轻拍": ("leans in, soft fingertip clap", ["clap", "encourage"], "upper"),
    "中幅鞠躬": ("medium bow", ["bow", "thanks", "apology"], "full"),
    "中立保底随机": ("neutral idle", ["idle", "neutral"], "full"),
    "举手问问题": ("raises a hand to ask", ["question"], "upper"),
    "二级害羞:挥手讨厌啦": ("shy: waves hand 'oh stop it'", ["shy", "flustered"], "upper"),
    "伸手邀请（弯腰郑重）": ("formal invitation with a bow", ["invite"], "full"),
    "侧肩食指捂嘴唇，你猜": ("finger to lips: 'guess'", ["tease", "secret"], "upper"),
    "侧身屈膝，划过头侧比枪": ("playful finger-gun pose", ["playful", "pose"], "full"),
    "侧身左手支住，右手收拢脸侧": ("side stance, hand at cheek", ["idle", "fidget", "idle_safe"], "upper"),
    "假装生气轻轻跺脚": ("mock-angry little stomp", ["annoyed", "fidget"], "full"),
    "元气体操": ("energetic warm-up stretch", ["idle", "energetic"], "full"),
    "前后脚，微侧身，单手叉腰，单手点嘴唇": ("hand on hip, finger on lips, thinking", ["think", "listen"], "upper"),
    "单手叉腰": ("one hand on hip", ["idle", "fidget", "waiting", "idle_safe"], "upper"),
    "单手叉腰脚尖频繁拍地": ("hand on hip, tapping a toe impatiently", ["impatient", "fidget"], "full"),
    "单手叉腰，单手头侧敬礼": ("hand on hip, playful salute", ["salute", "playful"], "upper"),
    "单手叉腰，单手自然下垂，侧顶胯站": ("hip-cocked stance, hand on hip", ["idle", "fidget"], "upper"),
    "单手扶腰，微侧身": ("hand on lower back, slight turn", ["idle", "fidget", "idle_safe"], "upper"),
    "单手抚胸，前后脚，膝盖并拢": ("hand on chest, knees together", ["idle", "fidget", "idle_safe"], "upper"),
    "单手抱胸捂嘴思考": ("arm across chest, hand over mouth, thinking", ["think", "listen"], "upper"),
    "单手抱胸看手摸头发": ("arm across chest, checks hand, touches hair", ["idle", "fidget", "idle_safe"], "upper"),
    "单手抱胸，单手扶额头，摇头": ("facepalm and head shake", ["facepalm", "no"], "upper"),
    "单手胸前夹握鼓起决心": ("fist to chest, resolve", ["resolve", "cheer"], "upper"),
    "单脚点地，握住手腕，斜肩侧身": ("toe tap, holds wrist, shy listening", ["listen", "shy"], "upper"),
    "单腿后踢翘高": ("one-leg back kick", ["playful"], "full"),
    "原地挥手打招呼": ("waves hello", ["greet", "wave"], "upper"),
    "原地跳，身体前倾，双手摸脸": ("hop forward, hands on cheeks", ["excited"], "full"),
    "双手一摊，抖肩摇头，侧头不忍直视": ("shrug, shake head, can't watch", ["shrug", "dismay"], "upper"),
    "双手两侧假装捏裙，下蹲表达谢谢": ("curtsy", ["thanks", "curtsy"], "full"),
    "双手交叉制止，双手下摆，身体前倾（生气）": ("crossed-arms stop, angry", ["refuse", "angry"], "upper"),
    "双手交叉，手掌向上微翘：不行": ("crossed arms: 'no'", ["refuse", "no"], "upper"),
    "双手叉腰": ("both hands on hips", ["idle", "fidget"], "upper"),
    "双手合十哈腰致谢": ("hands together, bow of thanks", ["thanks", "apology"], "full"),
    "双手头顶/面前/胸口/身侧比爱心": ("heart hands", ["love", "heart"], "upper"),
    "双手头顶大开，一脚前伸：好！": ("arms wide overhead: 'yes!'", ["celebrate"], "full"),
    "双手抚胸左右寻找": ("hands on chest, looking around", ["search"], "upper"),
    "双手抚胸深呼吸镇定": ("hands on chest, deep breath", ["calm"], "upper"),
    "双手抚胸深呼吸，失望缓缓落下双手": ("deep breath, hands fall, disappointed", ["sad", "disappointed"], "upper"),
    "双手抱肩，小幅旋转": ("hugs own shoulders, slight sway", ["idle", "fidget", "idle_safe"], "upper"),
    "双手抱臂，歪头撒娇": ("arms folded, coy head tilt", ["idle", "fidget", "idle_safe"], "upper"),
    "双手挥拳，生气地跺脚": ("fists and stomp, angry", ["angry"], "full"),
    "双手握拳托在下巴下，轻轻蹦跳": ("fists under chin, little bounces", ["excited", "cute"], "full"),
    "双手放在头顶做“兔耳朵”": ("bunny ears", ["cute", "playful"], "upper"),
    "双手比V": ("peace sign", ["peace", "celebrate"], "upper"),
    "双手端于腰，侧顶胯歪头，并拢双膝": ("hands at waist, hip cocked, head tilt", ["idle", "fidget"], "upper"),
    "双手背手": ("hands behind back", ["idle", "fidget"], "upper"),
    "双手背手，脚尖打圈，踢脚脚": ("hands behind back, toe circles, little kicks", ["shy", "fidget", "sulk"], "full"),
    "右手收拢抚胸，左手下垂": ("hand to chest", ["idle", "fidget", "idle_safe"], "upper"),
    "吃惊，被逗笑甩手（兰花指）": ("surprised laugh, flicks hand", ["laugh", "surprised"], "upper"),
    "后退手摆“不嘛”": ("steps back waving: 'no way'", ["refuse"], "full"),
    "大幅鞠躬": ("deep bow", ["bow", "thanks", "apology"], "full"),
    "委屈手指对戳": ("pokes fingers together, pouting", ["shy", "sulk", "fidget"], "upper"),
    "孙悟空式望远": ("shades eyes, scanning the distance", ["look", "search"], "upper"),
    "将手收拢夹住": ("hands clasped, bashful", ["shy"], "upper"),
    "小幅跳": ("little hop", ["happy", "jump"], "full"),
    "小拳拳锤胸口": ("playful little punches", ["playful", "tease"], "upper"),
    "左右歪头，若有所思听": ("head tilts side to side, pensive", ["think", "listen"], "upper"),
    "左手平放，右手转圈击毙你，吹烟": ("finger-gun 'bang', blows smoke", ["playful"], "upper"),
    "左脚点地，双手抱胸": ("toe tap, arms crossed", ["idle", "fidget", "idle_safe"], "upper"),
    "左脚点地，右手叉腰": ("toe tap, hand on hip", ["idle", "fidget", "idle_safe"], "upper"),
    "左脚点地，左手自然下垂，右手翘指摆于体侧": ("toe tap, hand flourish at side", ["idle", "fidget"], "upper"),
    "左脚点地，左手自然下垂，右手翘指轻扶下巴": ("toe tap, finger to chin", ["idle", "fidget", "think", "idle_safe"], "upper"),
    "左脚点地，左手自然下垂，右手腕撩头发外摆": ("toe tap, brushes hair back", ["idle", "fidget", "idle_safe"], "upper"),
    "开心元气加油": ("happy cheer, fist pump", ["cheer"], "upper"),
    "开心踮脚": ("happy tiptoe bounce", ["happy", "excited"], "full"),
    "得意叉腰，转圈锵锵": ("proud hands-on-hips spin: 'ta-da'", ["proud", "show"], "full"),
    "微微点头": ("small nod", ["nod", "agree"], "upper"),
    "快速歪头：对吧": ("quick head tilt: 'right?'", ["playful", "agree"], "upper"),
    "惊喜上身前倾双手后摆": ("leans in, hands back, curious", ["curious"], "upper"),
    "惊喜两侧抬手，胸前合手，难以置信地小幅摇头": ("hands up then clasped, disbelief", ["surprised"], "upper"),
    "惊喜捏下巴翘手指": ("delighted, pinches chin", ["happy", "surprised"], "upper"),
    "手从上落于水平，停止表达禁止": ("flat-hand 'stop'", ["refuse", "stop"], "upper"),
    "手指在脸侧一点：对吧": ("finger tap at cheek: 'right?'", ["idea", "playful"], "upper"),
    "手指点脸，转身捂嘴，叠手于腹部": ("touches face, turns away giggling", ["shy", "giggle"], "upper"),
    "手背掩眼哭泣": ("cries into back of hand", ["sad", "cry"], "upper"),
    "打响指潇洒转身离开": ("snaps fingers, turns to leave", ["leave"], "full"),
    "托腮（同？）": ("chin in hand", ["idle", "fidget", "idle_safe"], "upper"),
    "扭头不顾频繁回首": ("turns away, keeps glancing back", ["sulk", "fidget"], "upper"),
    "扮鬼脸": ("makes a funny face", ["playful"], "upper"),
    "抬头捂胸想象中": ("looks up, hand on heart, dreaming", ["dreamy"], "upper"),
    "抱胸": ("arms crossed", ["idle", "fidget", "idle_safe"], "upper"),
    "抱胸摇头叹气": ("arms crossed, head shake, sigh", ["disappointed", "no"], "upper"),
    "指向右侧": ("points right", ["point"], "upper"),
    "指向天上": ("points up at the sky", ["point"], "upper"),
    "指向左侧": ("points left", ["point"], "upper"),
    "指向自己：强调自己": ("points at self", ["self"], "upper"),
    "捂胸": ("hand on chest", ["idle", "fidget", "idle_safe"], "upper"),
    "捏拳空挥大喊跺脚": ("fist swing, shout, stomp", ["angry"], "full"),
    "握拳拍胸膛：交给我": ("fist to chest: 'leave it to me'", ["promise"], "upper"),
    "摊开双手：算了": ("open palms: 'forget it'", ["shrug"], "upper"),
    "摊手叹气": ("shrug and sigh", ["shrug", "sigh"], "upper"),
    "来回侧身展示自己": ("turns side to side, showing off", ["show"], "full"),
    "横比V，winkle": ("sideways V and wink", ["playful", "peace"], "upper"),
    "歪头专注倾听": ("head tilt, attentive listening", ["listen", "idle", "idle_safe"], "upper"),
    "歪头打量，摇头": ("sizes up, shakes head", ["doubt"], "upper"),
    "生气扭头，傲娇回头偷看": ("turns away in a huff, peeks back", ["sulk", "fidget"], "upper"),
    "用手背轻擦额头：“呼——”": ("wipes brow: 'phew'", ["relief"], "upper"),
    "用食指做“嘘”状": ("shush", ["quiet"], "upper"),
    "略下蹲，双手夹手庆祝": ("little crouch, hands clasped, celebrating", ["celebrate", "cute"], "full"),
    "竖起拇指": ("thumbs up", ["agree", "praise"], "upper"),
    "端手": ("hands folded in front", ["idle", "fidget", "idle_safe"], "upper"),
    "缩手紧缩侧头后退": ("shrinks back, scared", ["scared"], "full"),
    "耸肩后仰点头": ("shrug back, surprised nod", ["surprised"], "upper"),
    "自信得体双手抱胸": ("confident arms crossed", ["idle", "fidget", "confident", "idle_safe"], "upper"),
    "转圈": ("spins around", ["spin", "show"], "full"),
    "转身招手，双手收拢于胸前，跨后顶伸手邀请": ("turns, waves, invites", ["greet", "invite"], "full"),
    "转身边跑边回头招手": ("runs off waving back", ["leave"], "full"),
    "轻抚下巴略略吃惊": ("strokes chin, mildly surprised", ["surprised", "think"], "upper"),
    "轻抚胸口，前后脚下蹲": ("hand on chest, small curtsy", ["thanks"], "full"),
    "轻握双手感谢": ("hands gently clasped, grateful", ["idle", "fidget", "thanks", "idle_safe"], "upper"),
    "连续拍照姿势变换": ("cycles through photo poses", ["pose", "show"], "full"),
    "飞吻，单手抚髋，单手肩侧，侧身站": ("blows a kiss, hip pose", ["flirt", "idle"], "upper"),
    "（突然想到）握拳击掌": ("sudden idea, fist into palm", ["idea"], "upper"),
}

_FULL_HINTS = ("跳", "转", "踢", "蹲", "脚", "鞠躬", "后退", "跺", "跑")


def _minimal_arc(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotation matrix taking unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -1 + 1e-8:
        # opposite: rotate 180° about any axis orthogonal to a
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        axis /= np.linalg.norm(axis)
        K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
        return np.eye(3) + 2 * K @ K
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1.0 / (1.0 + c))


class DlpRig:
    """Rest skeleton of one dlp3d avatar, reduced to the animated joints."""

    def __init__(self, rest_npz: dict, joint_names: list[str]):
        all_names = [str(n) for n in rest_npz["joint_names"]]
        all_parents = [str(p) for p in rest_npz["parents"]]
        idx = {n: i for i, n in enumerate(all_names)}
        L = np.asarray(rest_npz["local_matrices"], dtype=np.float64)  # armature-space rest
        heads = np.asarray(rest_npz["rest_heads"], dtype=np.float64) * 0.01  # cm → m

        animated = [n for n in joint_names if n != "Root"]
        aset = set(animated)

        def nearest_animated_parent(name: str) -> str | None:
            p = all_parents[idx[name]]
            while p:
                if p in aset:
                    return p
                p = all_parents[idx[p]]
            return None

        # topological order: parents before children
        depth = {}
        for n in animated:
            d, p = 0, nearest_animated_parent(n)
            while p is not None:
                d += 1
                p = nearest_animated_parent(p)
            depth[n] = d
        self.names = sorted(animated, key=lambda n: (depth[n], n))
        self.index = {n: i for i, n in enumerate(self.names)}
        self.parents = [
            self.index[nearest_animated_parent(n)] if nearest_animated_parent(n) else -1
            for n in self.names
        ]
        self.rest_rot = np.stack([L[idx[n], :3, :3] for n in self.names])       # R_j (Blender)
        self.rest_pos = np.stack([C @ heads[idx[n]] for n in self.names])        # p_j (glTF, m)
        self.vrm = [DLP_TO_VRM.get(n) for n in self.names]
        self._calibrate()

    def _calibrate(self) -> None:
        by_vrm = {v: i for i, v in enumerate(self.vrm) if v}
        n = len(self.names)
        self.G = np.tile(np.eye(3), (n, 1, 1))
        for j in range(n):  # topological order → parent G already final
            v = self.vrm[j]
            spec = CANONICAL.get(v) if v else None
            child = by_vrm.get(spec[0]) if spec else None
            if spec is not None and child is not None:
                d = self.rest_pos[child] - self.rest_pos[j]
                if np.linalg.norm(d) > 1e-6:
                    self.G[j] = _minimal_arc(d, np.asarray(spec[1], dtype=np.float64))
                    continue
            p = self.parents[j]
            self.G[j] = self.G[p] if p >= 0 else np.eye(3)
        # T-posed rest positions: o_c = G_parent (p_c - p_parent)
        self.tpose_pos = self.rest_pos.copy()
        for j in range(n):
            p = self.parents[j]
            if p >= 0:
                self.tpose_pos[j] = self.tpose_pos[p] + self.G[p] @ (self.rest_pos[j] - self.rest_pos[p])
        self.ground_y = float(self.tpose_pos[:, 1].min())

    def globals_for(self, rotmat: np.ndarray, clip_joint_names: list[str]) -> np.ndarray:
        """(T, J, 3, 3) target world rotations T_j for the kimodo writer."""
        T = rotmat.shape[0]
        n = len(self.names)
        src = {str(nm): k for k, nm in enumerate(clip_joint_names)}
        what = np.empty((T, n, 3, 3))
        out = np.empty((T, n, 3, 3))
        for j, name in enumerate(self.names):
            B = rotmat[:, src[name]] if name in src else np.tile(np.eye(3), (T, 1, 1))
            R = self.rest_rot[j]
            D = np.einsum("mn,tno,po->tmp", R, B, R)  # R B Rᵀ
            p = self.parents[j]
            what[:, j] = D if p < 0 else np.einsum("tmn,tno->tmo", what[:, p], D)
            # frame change then calibration
            Wg = np.einsum("mn,tno,po->tmp", C, what[:, j], C)  # C Ŵ Cᵀ
            out[:, j] = np.einsum("tmn,on->tmo", Wg, self.G[j])  # Ŵ' G_jᵀ
        return out


def _load_kimodo(root: Path):
    sys.path.insert(0, str(root))
    from backend import skeletons as sk  # noqa: WPS433
    from backend.kimodo_npz import Motion  # noqa: WPS433
    from backend.vrma_writer import write_vrma  # noqa: WPS433
    return sk, Motion, write_vrma


def convert_clip(rig: DlpRig, clip: dict, sk, Motion, write_vrma, in_place: bool) -> tuple[bytes, dict]:
    rotmat = np.asarray(clip["rotmat"], dtype=np.float64)
    transl = np.asarray(clip["transl"], dtype=np.float64)
    names = [str(n) for n in clip["joint_names"]]
    T = rotmat.shape[0]
    globals_ = rig.globals_for(rotmat, names)
    root = (transl @ C.T)  # C · transl per frame
    root[:, 1] -= rig.ground_y

    sk.SKELETON_TO_VRM_MAP["dlp3d"] = {n: v for n, v in zip(rig.names, rig.vrm) if v}
    skeleton = sk.Skeleton(
        name="dlp3d", names=list(rig.names), parents=list(rig.parents),
        neutral_joints=rig.tpose_pos.copy(), root_idx=rig.index["Hips"],
    )
    motion = Motion(skeleton=skeleton, global_rot_mats=globals_, root_positions=root, fps=FPS)
    data = write_vrma(motion, in_place=in_place)

    # sanity: FK of frame 0 and the middle frame in the written skeleton
    checks = {}
    for label, t in (("first", 0), ("mid", T // 2)):
        pos = np.empty_like(rig.tpose_pos)
        for j in range(len(rig.names)):
            p = rig.parents[j]
            if p < 0:
                pos[j] = root[t]
            else:
                pos[j] = pos[p] + globals_[t, p] @ (rig.tpose_pos[j] - rig.tpose_pos[p])
        checks[label] = {
            k: [round(float(x), 2) for x in pos[rig.index[n]]]
            for k, n in (("head", "Head"), ("lhand", "Left_wrist"), ("rhand", "Right_wrist"),
                         ("lfoot", "Left_ankle"), ("rfoot", "Right_ankle"))
        }
    return data, checks


def _frames_to_s(v):
    return None if v is None else round(float(v) / FPS, 3)


def query_records(db_path: Path, avatar: str):
    con = sqlite3.connect(db_path)
    q = """
    select mr.motion_record_id, mf.n_frames, mf.npz_oss_path, mr.states, mr.is_idle_long,
           l.loop_start_frame, l.loop_end_frame, rd.cutoff_frames, rd.cutoff_ranges,
           mr.is_random_quiet, mr.is_random_audio, mr.startup_frame, mr.recovery_frame,
           o.motion_description, mk.motion_keywords_ch, mk.motion_keyword_frame,
           sk.speech_keywords_ch, sk.speech_keyword_frame, mr.labels
    from motion_record mr
    join motion_file mf on mf.motion_file_id = mr.motion_file_id
    join armature a on a.armature_id = mf.armature_id
    join avatar av on av.avatar_id = a.avatar_id
    left join origin o on o.origin_id = mf.origin_id
    left join loopable l on l.loop_id = mr.loop_id
    left join random rd on rd.random_id = mr.random_id
    left join motion_keyword mk on mk.motion_keyword_id = mr.motion_keyword_id
    left join speech_keyword sk on sk.speech_keyword_id = mr.speech_keyword_id
    where av.avatar_name = ? and mr.enabled = 1
    order by mr.motion_record_id
    """
    cols = ["id", "n_frames", "npz", "states", "idle_long", "loop_start", "loop_end",
            "cutoff_frames", "cutoff_ranges", "random_quiet", "random_audio",
            "startup", "recovery", "zh", "motion_kw_zh", "kw_frame",
            "speech_kw_zh", "speech_kw_frame", "labels"]
    rows = [dict(zip(cols, r)) for r in con.execute(q, (avatar,))]
    con.close()
    return rows


def manifest_entry(row: dict, duration: float, file_name: str) -> dict:
    zh = row["zh"] or ""
    en, tags, mask = EN.get(zh, (zh, [], None))
    if mask is None:
        mask = "full" if any(h in zh for h in _FULL_HINTS) else "upper"
    states = [s.strip() for s in (row["states"] or "").split(",") if s.strip()]
    if row["idle_long"]:
        states.append("idle_long")
    cutoffs = []
    if row["cutoff_frames"]:
        try:
            cutoffs = [_frames_to_s(f) for f in json.loads(row["cutoff_frames"])]
        except (ValueError, TypeError):
            cutoffs = []
    loop = None
    if row["loop_start"] is not None and row["loop_end"] is not None:
        loop = [_frames_to_s(row["loop_start"]), _frames_to_s(row["loop_end"])]
    keyframe = _frames_to_s(row["kw_frame"]) if row["kw_frame"] is not None else None
    if keyframe is None and row["speech_kw_frame"] is not None:
        keyframe = _frames_to_s(row["speech_kw_frame"])
    return {
        "id": f"dlp3d_{row['id']}",
        "file": file_name,
        "duration": round(duration, 3),
        "states": states,
        "loop": loop,
        "cutoffs": cutoffs,
        "startup": _frames_to_s(row["startup"]),
        "recovery": _frames_to_s(row["recovery"]),
        "keyframe": keyframe,
        "mask": mask,
        "en": en,
        "tags": tags,
        "zh": zh,
        "motion_keywords_zh": row["motion_kw_zh"],
        "speech_keywords_zh": row["speech_kw_zh"],
        "random": bool(row["random_quiet"] or row["random_audio"]),
        "labels": [s for s in (row["labels"] or "").split(",") if s],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip", help="dlp3d motion_data.zip")
    ap.add_argument("--avatar", default="Ani-default", help="avatar_name in the database")
    ap.add_argument("--out", required=True, help="output folder (vrma files + manifest.json)")
    ap.add_argument("--kimodo", default="/mnt/c/pycharm/kimodo_NPZ_to_fbx_and_vrma",
                    help="path to the kimodo_NPZ_to_fbx_and_vrma project (VRMA writer)")
    ap.add_argument("--ids", help="comma-separated motion_record_ids to convert (default: all)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--in-place", action="store_true", help="strip horizontal hips drift")
    args = ap.parse_args()

    sk, Motion, write_vrma = _load_kimodo(Path(args.kimodo))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(args.zip) as z:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "motion_database.db"
            db_path.write_bytes(z.read("data/motion_database.db"))
            rows = query_records(db_path, args.avatar)
        if not rows:
            sys.exit(f"no enabled records for avatar {args.avatar!r}")
        if args.ids:
            keep = {int(x) for x in args.ids.split(",")}
            rows = [r for r in rows if r["id"] in keep]
        if args.limit:
            rows = rows[: args.limit]

        rest_name = next(
            n for n in z.namelist()
            if n.startswith("data/restpose_npz/") and n.split("/")[-1].startswith(args.avatar.split("-")[0] + "_")
        )
        rest = np.load(io.BytesIO(z.read(rest_name)), allow_pickle=True)
        first = np.load(io.BytesIO(z.read("data/" + rows[0]["npz"].replace("motion/match", "motion_files/motion/match"))), allow_pickle=True)
        rig = DlpRig(rest, [str(n) for n in first["joint_names"]])
        print(f"rig {args.avatar}: {len(rig.names)} joints, {sum(1 for v in rig.vrm if v)} VRM-mapped, "
              f"ground {rig.ground_y:.3f} m, hips rest {rig.tpose_pos[rig.index['Hips']][1] - rig.ground_y:.3f} m")

        clips = []
        for i, row in enumerate(rows, 1):
            member = "data/" + row["npz"].replace("motion/match", "motion_files/motion/match")
            try:
                clip = np.load(io.BytesIO(z.read(member)), allow_pickle=True)
            except KeyError:
                print(f"  [{i}/{len(rows)}] {row['id']}: missing {member}")
                continue
            data, checks = convert_clip(rig, clip, sk, Motion, write_vrma, args.in_place)
            fname = f"{row['id']}.vrma"
            (out / fname).write_bytes(data)
            duration = int(clip["rotmat"].shape[0]) / FPS
            entry = manifest_entry(row, duration, fname)
            clips.append(entry)
            print(f"  [{i}/{len(rows)}] {entry['id']} {duration:5.2f}s {entry['mask']:5} "
                  f"{','.join(entry['states']) or '-':14} {entry['en'][:48]}")
            if i <= 2:
                print("      fk:", json.dumps(checks))

    manifest = {
        "version": LIBRARY_VERSION,
        "library": out.name,
        "source": f"dlp3d.ai motion_data ({args.avatar} rig)",
        "fps": FPS,
        "clips": clips,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(clips)} clips + manifest.json → {out}")


if __name__ == "__main__":
    main()
