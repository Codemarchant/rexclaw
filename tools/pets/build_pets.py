"""The toy box's pets (web/src/models/toys/pets.js): each one modelled in
code and written as a rigged GLB to assets/toys/pets/<id>.glb.

A pet's body is a signed distance field: a handful of soft shapes (balls,
eggs, tapered limbs) melted into one another, the way clay is worked, then
skinned by marching cubes. Because every shape knows which bone it hangs
from and what colour it is, the mesh gets its skin weights and its coat
from the same description: no unwrapping, no weight painting. Eyes,
whiskers, teeth and claws are small meshes of their own, pinned to a bone.

The GLB holds one skinned mesh in two primitives (materials named `toon`
and `glow`; the app swaps in its own, pets3d.js), vertex colours (linear),
a skeleton whose joints all rest unrotated (so the app can pose them about
the model's own axes), and no clips: the app animates the bones itself
(pet_rig.js). Model space: +Y up, +Z the way the pet faces, +X its left,
metres; the origin on the floor under its middle (a swimmer's: its middle).

    python tools/pets/build_pets.py [all|<pet id>...] [--step 0.004] [--out <dir>]

Needs numpy and scikit-image (its marching cubes); nothing the app needs
at run time. After a rebuild, render the animals' pictures again (their
tray tiles and the desktop's sprites): tools/pets/sprites.html.
"""

import json
import math
import os
import struct
import sys

import numpy as np
from skimage import measure

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(REPO, "assets", "toys", "pets")


# ── colours ──────────────────────────────────────────────────────────────

def rgb(hexstr):
    """'#rrggbb' as sRGB floats."""
    v = int(hexstr.lstrip("#"), 16)
    return np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255], dtype=np.float64) / 255.0


def to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def tint(col, target, mask):
    """`col` (N, 3) toward colour `target` by `mask` (N,) 0-1."""
    m = np.clip(mask, 0.0, 1.0)[:, None]
    return col * (1 - m) + np.asarray(target)[None, :] * m


def wobble(P, freq, seed=0.0):
    """A smooth pseudo-random value in -1 … 1 over space (summed sines)."""
    x, y, z = P[:, 0] * freq, P[:, 1] * freq, P[:, 2] * freq
    s = seed * 12.9898
    return (np.sin(x * 1.7 + y * 2.3 + s) + np.sin(y * 1.9 - z * 2.1 + s * 1.3) + np.sin(z * 1.3 + x * 2.9 - s * 0.7)
            + 0.5 * np.sin(x * 4.1 - y * 3.7 + z * 3.3 + s * 2.1)) / 3.5


def spots(P, cell, radius, seed=0.0, jitter=0.35):
    """Round spots scattered through space: 1 inside one, 0 outside (one
    spot a cell of a jittered grid, `radius` as a share of the cell)."""
    q = P / cell
    base = np.floor(q)
    best = np.full(len(P), 9.0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                c = base + np.array([dx, dy, dz])
                h = np.sin(c @ np.array([127.1, 311.7, 74.7]) + seed * 17.0) * 43758.5453
                h2 = np.sin(c @ np.array([269.5, 183.3, 246.1]) + seed * 31.0) * 43758.5453
                h3 = np.sin(c @ np.array([113.5, 271.9, 124.6]) + seed * 7.0) * 43758.5453
                off = np.stack([h - np.floor(h), h2 - np.floor(h2), h3 - np.floor(h3)], axis=1)
                centre = c + 0.5 + (off - 0.5) * 2 * jitter
                best = np.minimum(best, np.linalg.norm(q - centre, axis=1))
    return 1.0 - sstep(radius * 0.8, radius, best)


# ── shapes (signed distance fields) ──────────────────────────────────────

def rot_matrix(rx=0.0, ry=0.0, rz=0.0):
    """Rotation by degrees about x, then y, then z."""
    a, b, c = (math.radians(v) for v in (rx, ry, rz))
    mx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    my = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    mz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    return mz @ my @ mx


class Shape:
    """A distance function with a box that holds it."""

    def __init__(self, fn, lo, hi):
        self.fn = fn
        self.lo = np.asarray(lo, dtype=np.float64)
        self.hi = np.asarray(hi, dtype=np.float64)

    def __call__(self, P):
        return self.fn(P)


def ball(c, r):
    c = np.asarray(c, dtype=np.float64)
    return Shape(lambda P: np.linalg.norm(P - c, axis=1) - r, c - r, c + r)


def egg(c, radii, rot=None):
    """An ellipsoid at `c` with half-axes `radii`, turned by `rot` degrees
    (x, y, z)."""
    c = np.asarray(c, dtype=np.float64)
    r = np.asarray(radii, dtype=np.float64)
    R = rot_matrix(*rot) if rot else np.eye(3)

    def fn(P):
        q = (P - c) @ R          # into the egg's own frame (R is orthonormal)
        k0 = np.linalg.norm(q / r, axis=1)
        k1 = np.linalg.norm(q / (r * r), axis=1)
        return np.where(k1 > 1e-9, k0 * (k0 - 1.0) / np.maximum(k1, 1e-9), -r.min())
    m = r.max()
    return Shape(fn, c - m, c + m)


def limb(a, b, ra, rb=None):
    """A rod from `a` to `b`, `ra` thick at one end and `rb` at the other,
    its ends rounded."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    rb = ra if rb is None else rb
    ab = b - a
    L2 = max(float(ab @ ab), 1e-12)

    def fn(P):
        t = np.clip(((P - a) @ ab) / L2, 0.0, 1.0)
        return np.linalg.norm(P - (a + t[:, None] * ab), axis=1) - (ra + (rb - ra) * t)
    m = max(ra, rb)
    return Shape(fn, np.minimum(a, b) - m, np.maximum(a, b) + m)


def squash(shape, c, scale, rot=None):
    """`shape` squashed about `c` by `scale` per axis (in a frame turned by
    `rot`), e.g. an ear or a fin flattened to a blade."""
    c = np.asarray(c, dtype=np.float64)
    s = np.asarray(scale, dtype=np.float64)
    R = rot_matrix(*rot) if rot else np.eye(3)

    def fn(P):
        q = ((P - c) @ R) / s
        return shape(q @ R.T + c) * s.min()
    return Shape(fn, shape.lo, shape.hi)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


class Part:
    """One shape of a body: which bone it hangs from, its colour, and how
    softly it melts into what's already there (`k`, metres). `cut`: carved
    out instead. `tag`: a name the painter can ask for (defaults to the
    bone)."""

    def __init__(self, shape, bone, color, k=0.02, cut=False, tag=None):
        self.shape = shape
        self.bone = bone
        self.color = rgb(color) if isinstance(color, str) else np.asarray(color, dtype=np.float64)
        self.k = k
        self.cut = cut
        self.tag = tag or bone


def body_field(parts, P):
    d = None
    for p in parts:
        di = p.shape(P)
        if d is None:
            d = di
        elif p.cut:
            d = smax(d, -di, p.k)
        else:
            d = smin(d, di, p.k)
    return d


def on_surface(parts, origin, direction, far=0.4, lift=0.0):
    """Where the ray from `origin` (inside the body) along `direction`
    comes out through its skin, `lift` metres further on: for things that
    sit on the surface (a collar, a tooth, a mouth's line)."""
    o = np.asarray(origin, dtype=np.float64)
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    lo, hi = 0.0, far
    for _ in range(40):
        mid = (lo + hi) / 2
        if body_field(parts, (o + d * mid)[None, :])[0] < 0:
            lo = mid
        else:
            hi = mid
    return o + d * (hi + lift)


# ── little meshes ────────────────────────────────────────────────────────

def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / max(np.linalg.norm(v), 1e-12)


def sphere_mesh(c, radii, nu=20, nv=14, rot=None):
    """A UV ellipsoid: (verts, normals, faces, unit directions in its own
    frame turned to the model's)."""
    c = np.asarray(c, dtype=np.float64)
    r = np.asarray(radii, dtype=np.float64) * np.ones(3)
    R = rot_matrix(*rot) if rot else np.eye(3)
    V, U = [], []
    for j in range(nv + 1):
        th = math.pi * j / nv
        for i in range(nu):
            ph = 2 * math.pi * i / nu
            u = np.array([math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph)])
            V.append(c + R @ (u * r))
            n = R @ (u / r)
            U.append(n / np.linalg.norm(n))
    F = []
    for j in range(nv):
        for i in range(nu):
            a, b = j * nu + i, j * nu + (i + 1) % nu
            d, e = a + nu, b + nu
            F += [[a, b, d], [b, e, d]]
    V = np.array(V)
    N = np.array(U)
    return V, N, np.array(F, dtype=np.int64), N.copy()


def tube_mesh(points, radius, seg=5):
    """A thin tube along `points` (a whisker, a toe), `radius` a number or
    one per point; closed with a point at each end."""
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    n = len(pts)
    rs = radius if isinstance(radius, (list, tuple)) else [radius] * n
    V, N, F = [], [], []
    up = np.array([0.0, 1.0, 0.0])
    for i, p in enumerate(pts):
        t = _unit(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)])
        a = np.cross(t, up)
        if np.linalg.norm(a) < 1e-6:
            a = np.cross(t, np.array([1.0, 0.0, 0.0]))
        a = _unit(a)
        b = np.cross(t, a)
        for s in range(seg):
            ang = 2 * math.pi * s / seg
            d = math.cos(ang) * a + math.sin(ang) * b
            V.append(p + d * rs[i])
            N.append(d)
    for i in range(n - 1):
        for s in range(seg):
            a0, a1 = i * seg + s, i * seg + (s + 1) % seg
            b0, b1 = a0 + seg, a1 + seg
            F += [[a0, b0, a1], [a1, b0, b1]]
    # End caps: a point a little past each end.
    for end, i, sign in ((pts[0], 0, -1), (pts[-1], n - 1, 1)):
        t = _unit(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]) * sign
        tip = len(V)
        V.append(end + t * rs[i])
        N.append(t)
        for s in range(seg):
            a0, a1 = i * seg + s, i * seg + (s + 1) % seg
            F.append([a0, a1, tip] if sign < 0 else [a1, a0, tip])
    return np.array(V), np.array(N), np.array(F, dtype=np.int64)


def cone_mesh(base, tip, radius, seg=6):
    """A cone from a disc at `base` to a point at `tip` (a tooth, a claw)."""
    base = np.asarray(base, dtype=np.float64)
    tip = np.asarray(tip, dtype=np.float64)
    t = _unit(tip - base)
    a = np.cross(t, np.array([0.0, 1.0, 0.0]))
    if np.linalg.norm(a) < 1e-6:
        a = np.cross(t, np.array([1.0, 0.0, 0.0]))
    a = _unit(a)
    b = np.cross(t, a)
    V, N, F = [], [], []
    for s in range(seg):
        ang = 2 * math.pi * s / seg
        d = math.cos(ang) * a + math.sin(ang) * b
        V.append(base + d * radius)
        N.append(_unit(d + t * 0.35))
    V.append(tip)
    N.append(t)
    V.append(base)
    N.append(-t)
    for s in range(seg):
        s1 = (s + 1) % seg
        F += [[s, seg, s1], [s1, seg + 1, s]]
    return np.array(V), np.array(N), np.array(F, dtype=np.int64)


class Extra:
    """A small mesh pinned to one bone. `glow`: drawn unlit (a glint)."""

    def __init__(self, V, N, F, color, bone, glow=False):
        self.V, self.N, self.F = V, N, F
        c = rgb(color) if isinstance(color, str) else np.asarray(color, dtype=np.float64)
        self.C = np.tile(c, (len(V), 1)) if c.ndim == 1 else c
        self.bone = bone
        self.glow = glow


def eye(c, r, look, bone, iris="#3a2a1c", pupil="round", iris_a=0.95, pupil_a=0.5, rim="#16100c", up=(0, 1, 0),
        shine=0.24, lid=None):
    """An eye at `c`, radii `r`, looking along `look`: a dark ball with an
    iris and a pupil ("round", "slit" or None) drawn on it by angle from
    `look` (radians), and a glint. Returns its meshes. `lid`: a colour for
    its top above the angle `lid[1]` (an eyelid's line)."""
    look = _unit(look)
    V, N, F, U = sphere_mesh(c, r, 28, 18)
    side = _unit(np.cross(np.asarray(up, dtype=np.float64), look))
    upv = np.cross(look, side)
    ang = np.arccos(np.clip(U @ look, -1, 1))
    a, b = U @ side, U @ upv
    col = np.tile(rgb(rim), (len(V), 1))
    iris_c = rgb(iris)
    # The iris, a little darker toward its edge.
    m = 1.0 - sstep(iris_a * 0.88, iris_a, ang)
    shade = 0.72 + 0.28 * (1.0 - sstep(0.0, iris_a, ang))
    col = col * (1 - m[:, None]) + (iris_c[None, :] * shade[:, None]) * m[:, None]
    if pupil == "round":
        col = tint(col, rgb("#0b0908"), 1.0 - sstep(pupil_a * 0.85, pupil_a, ang))
    elif pupil == "slit":
        e = np.sqrt((a / (pupil_a * 0.32)) ** 2 + (b / (pupil_a * 1.25)) ** 2)
        col = tint(col, rgb("#0b0908"), 1.0 - sstep(0.85, 1.0, e))
    if lid:
        col = tint(col, rgb(lid[0]), sstep(lid[1], lid[1] + 0.12, b))
    out = [Extra(V, N, F, col, bone)]
    if shine:
        rr = np.asarray(r, dtype=np.float64) * np.ones(3)
        d = _unit(look + upv * 0.55 + np.array([0.3, 0.0, 0.0]))
        p = np.asarray(c, dtype=np.float64) + d * rr * 0.93
        gv, gn, gf, _ = sphere_mesh(p, rr.mean() * shine, 10, 8)
        out.append(Extra(gv, gn, gf, "#ffffff", bone, glow=True))
        d2 = _unit(look - upv * 0.45 - np.array([0.25, 0.0, 0.0]))
        gv, gn, gf, _ = sphere_mesh(np.asarray(c) + d2 * rr * 0.95, rr.mean() * shine * 0.42, 8, 6)
        out.append(Extra(gv, gn, gf, "#ffffff", bone, glow=True))
    return out


def tube(points, radius, color, bone, seg=5, glow=False):
    V, N, F = tube_mesh(points, radius, seg)
    return Extra(V, N, F, color, bone, glow)


def cone(base, tip, radius, color, bone, seg=6):
    V, N, F = cone_mesh(base, tip, radius, seg)
    return Extra(V, N, F, color, bone)


def mirror_x(p):
    return (-p[0], p[1], p[2])


# ── a pet ────────────────────────────────────────────────────────────────

class Pet:
    """`bones`: name → (parent or None, rest position). `bodies`: lists of
    Parts, each list skinned as one surface of its own (a bird's wings are
    apart from its body, so they can open). `extras`: Extra meshes.
    `paint(P, N, col, tag)` → col: the coat's markings over the parts' own
    colours (`tag(name)`: how much of each vertex belongs to that bone or
    tag, 0-1). `blend`: how far a joint's bend spreads (m); `edge`: how
    soft the line between two parts' colours is (m). `meta`: for the app."""

    def __init__(self, pid, bones, bodies, extras=(), paint=None, step=0.004, blend=0.012, edge=0.004, meta=None):
        self.id = pid
        self.bones = bones
        self.bodies = bodies
        self.extras = list(extras)
        self.paint = paint
        self.step = step
        self.blend = blend
        self.edge = edge
        self.meta = meta or {}


def skin_body(pet, parts, step):
    """One surface from `parts`: (V, N, C, F, weights by bone)."""
    adds = [p for p in parts if not p.cut]
    lo = np.min([p.shape.lo for p in adds], axis=0) - 3 * step
    hi = np.max([p.shape.hi for p in adds], axis=0) + 3 * step
    n = np.ceil((hi - lo) / step).astype(int) + 1
    xs = lo[0] + np.arange(n[0]) * step
    ys = lo[1] + np.arange(n[1]) * step
    zs = lo[2] + np.arange(n[2]) * step
    vol = np.empty((n[0], n[1], n[2]), dtype=np.float32)
    yy, zz = np.meshgrid(ys, zs, indexing="ij")
    plane = np.stack([np.zeros(yy.size), yy.ravel(), zz.ravel()], axis=1)
    for i, x in enumerate(xs):
        plane[:, 0] = x
        vol[i] = body_field(parts, plane).reshape(n[1], n[2]).astype(np.float32)
    V, F, _, _ = measure.marching_cubes(vol, level=0.0, spacing=(step, step, step))
    V = V + lo
    # Normals from the field itself: smooth however coarse the mesh.
    e = step * 0.5
    g = np.stack([body_field(parts, V + d) - body_field(parts, V - d) for d in (np.array([e, 0, 0]), np.array([0, e, 0]), np.array([0, 0, e]))], axis=1)
    N = g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)
    # Triangles wound so their faces look out along those normals.
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    flip = np.einsum("ij,ij->i", fn, N[F[:, 0]] + N[F[:, 1]] + N[F[:, 2]]) < 0
    F[flip] = F[flip][:, [0, 2, 1]]
    D = np.stack([p.shape(V) for p in adds])
    dmin = D.min(axis=0)
    Ww = np.exp(-(D - dmin) / pet.blend)
    Wc = np.exp(-(D - dmin) / pet.edge)
    names = list(pet.bones)
    W = np.zeros((len(V), len(names)))
    tags = {}
    for p, ww, wc in zip(adds, Ww, Wc):
        W[:, names.index(p.bone)] += ww
        tags[p.tag] = tags.get(p.tag, 0) + wc
    W /= W.sum(axis=1, keepdims=True)
    total = Wc.sum(axis=0)
    C = sum(wc[:, None] * p.color[None, :] for p, wc in zip(adds, Wc)) / total[:, None]
    tagw = {k: v / total for k, v in tags.items()}
    if pet.paint:
        C = pet.paint(V, N, C, lambda name: tagw.get(name, np.zeros(len(V))))
    return V, N, np.clip(C, 0, 1), F, W


def build(pet, step=None):
    names = list(pet.bones)
    prims = {False: [], True: []}
    for parts in pet.bodies:
        V, N, C, F, W = skin_body(pet, parts, step or pet.step)
        prims[False].append((V, N, C, F, W))
    for x in pet.extras:
        W = np.zeros((len(x.V), len(names)))
        W[:, names.index(x.bone)] = 1.0
        prims[x.glow].append((x.V, x.N, x.C, x.F, W))
    out = []
    for glow in (False, True):
        if not prims[glow]:
            continue
        Vs, Ns, Cs, Fs, Ws = [], [], [], [], []
        base = 0
        for V, N, C, F, W in prims[glow]:
            Vs.append(V)
            Ns.append(N)
            Cs.append(C)
            Ws.append(W)
            Fs.append(F + base)
            base += len(V)
        out.append(("glow" if glow else "toon", np.concatenate(Vs), np.concatenate(Ns), np.concatenate(Cs), np.concatenate(Fs),
                    np.concatenate(Ws)))
    return out


# ── GLB ──────────────────────────────────────────────────────────────────

def write_glb(pet, prims, path):
    names = list(pet.bones)
    world = {n: np.asarray(pet.bones[n][1], dtype=np.float64) for n in names}
    buf = bytearray()
    views, accessors = [], []

    def push(arr, target=None, ctype=5126, atype="VEC3", normalized=False, minmax=False):
        while len(buf) % 4:
            buf.append(0)
        raw = arr.tobytes()
        view = {"buffer": 0, "byteOffset": len(buf), "byteLength": len(raw)}
        if target:
            view["target"] = target
        views.append(view)
        buf.extend(raw)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": atype}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [float(v) for v in arr.min(axis=0)]
            acc["max"] = [float(v) for v in arr.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    gl_prims, materials = [], []
    for name, V, N, C, F, W in prims:
        # The four bones that hold each vertex most.
        order = np.argsort(-W, axis=1)[:, :4]
        w4 = np.take_along_axis(W, order, axis=1)
        w4 = w4 / w4.sum(axis=1, keepdims=True)
        order = np.where(w4 > 0, order, 0)
        col = np.concatenate([to_linear(C), np.ones((len(C), 1))], axis=1)
        attrs = {
            "POSITION": push(V.astype(np.float32), 34962, minmax=True),
            "NORMAL": push(N.astype(np.float32), 34962),
            "COLOR_0": push(np.round(col * 255).astype(np.uint8), 34962, ctype=5121, atype="VEC4", normalized=True),
            "JOINTS_0": push(order.astype(np.uint8), 34962, ctype=5121, atype="VEC4"),
            "WEIGHTS_0": push(np.round(w4 * 255).astype(np.uint8), 34962, ctype=5121, atype="VEC4", normalized=True),
        }
        big = len(V) > 65535
        idx = push(F.astype(np.uint32 if big else np.uint16).reshape(-1), 34963, ctype=5125 if big else 5123, atype="SCALAR")
        mat = {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1}}
        if name == "glow":
            mat["extensions"] = {"KHR_materials_unlit": {}}
        materials.append(mat)
        gl_prims.append({"attributes": attrs, "indices": idx, "material": len(materials) - 1})

    ibm = np.zeros((len(names), 16), dtype=np.float32)
    for i, n in enumerate(names):
        m = np.eye(4)
        m[:3, 3] = -world[n]
        ibm[i] = m.T.reshape(-1)        # column-major
    ibm_acc = push(ibm, atype="MAT4")

    # Nodes: 0 the pet, 1 its mesh, then its bones.
    nodes = [{"name": pet.id, "children": [1], "extras": {"pet": pet.meta}}, {"name": f"{pet.id}_mesh", "mesh": 0, "skin": 0}]
    first = len(nodes)
    for n in names:
        parent, pos = pet.bones[n]
        rel = world[n] - (world[parent] if parent else 0)
        nodes.append({"name": n, "translation": [float(v) for v in rel]})
    for i, n in enumerate(names):
        parent = pet.bones[n][0]
        if parent:
            nodes[first + names.index(parent)].setdefault("children", []).append(first + i)
        else:
            nodes[0]["children"].append(first + i)
    gltf = {
        "asset": {"version": "2.0", "generator": "rexclaw tools/pets/build_pets.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
        "meshes": [{"name": pet.id, "primitives": gl_prims}], "materials": materials,
        "skins": [{"joints": [first + i for i in range(len(names))], "inverseBindMatrices": ibm_acc}],
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(buf)}],
    }
    if any(m.get("extensions") for m in materials):
        gltf["extensionsUsed"] = ["KHR_materials_unlit"]
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    while len(buf) % 4:
        buf.append(0)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(buf)))
        fh.write(struct.pack("<I4s", len(js), b"JSON"))
        fh.write(js)
        fh.write(struct.pack("<I4s", len(buf), b"BIN\x00"))
        fh.write(bytes(buf))


# ── skeletons ────────────────────────────────────────────────────────────
# The app's rigs (pet_rig.js) go by these bone names.

def quad_bones(hips, spine, chest, neck, head, eyes, fl, hl, ears=None, tail=(), extra=None):
    """A four-legged skeleton. `fl` / `hl`: the left front and hind leg as
    (upper, lower, paw) joints (a hind leg's: hip, knee, hock); `ears`,
    `eyes`: the left one's; `tail`: its joints from the root out."""
    b = {"hips": (None, hips), "spine": ("hips", spine), "chest": ("spine", chest), "neck": ("chest", neck), "head": ("neck", head)}
    for side, s in (("L", 1.0), ("R", -1.0)):
        m = (lambda p: p) if s > 0 else mirror_x
        if ears:
            b[f"ear_{side}"] = ("head", m(ears))
        b[f"eye_{side}"] = ("head", m(eyes))
        b[f"fl_upper_{side}"] = ("chest", m(fl[0]))
        b[f"fl_lower_{side}"] = (f"fl_upper_{side}", m(fl[1]))
        b[f"fl_paw_{side}"] = (f"fl_lower_{side}", m(fl[2]))
        b[f"hl_upper_{side}"] = ("hips", m(hl[0]))
        b[f"hl_lower_{side}"] = (f"hl_upper_{side}", m(hl[1]))
        b[f"hl_paw_{side}"] = (f"hl_lower_{side}", m(hl[2]))
    prev = "hips"
    for i, p in enumerate(tail):
        b[f"tail{i + 1}"] = (prev, p)
        prev = f"tail{i + 1}"
    for name, (parent, pos) in (extra or {}).items():
        b[name] = (parent, pos)
    return b


def bird_bones(body, neck, head, eyes, wing, wing2, tail1, tail2, leg, foot):
    """A bird's skeleton, its wings out to the sides (they fold in the
    app). `eyes`, `wing`, `wing2`, `leg`, `foot`: the left one's."""
    b = {"body": (None, body), "neck": ("body", neck), "head": ("neck", head), "tail1": ("body", tail1), "tail2": ("tail1", tail2)}
    for side, s in (("L", 1.0), ("R", -1.0)):
        m = (lambda p: p) if s > 0 else mirror_x
        b[f"eye_{side}"] = ("head", m(eyes))
        b[f"wing_{side}"] = ("body", m(wing))
        b[f"wing2_{side}"] = (f"wing_{side}", m(wing2))
        b[f"leg_{side}"] = ("body", m(leg))
        b[f"foot_{side}"] = (f"leg_{side}", m(foot))
    return b


def sides():
    return (("L", 1.0), ("R", -1.0))


# ── the pets ─────────────────────────────────────────────────────────────
# Sizes are an animal's own where given, drawn with a youngster's big head
# and eyes; the rest by eye.

def evie():
    """Evie: Eve's scrappy grey stray, a tabby with a white bib and socks,
    green eyes, and a notch out of her left ear. A domestic cat is about
    46 cm head and body and 23-25 cm at the shoulder; this one is a little
    under that, with a kitten's head."""
    grey, dark, white, pink = "#8d939c", "#565c66", "#f4f1ea", "#f2a3a8"
    fl = ((0.046, 0.135, 0.082), (0.046, 0.075, 0.076), (0.046, 0.022, 0.084))
    hl = ((0.054, 0.135, -0.112), (0.058, 0.078, -0.094), (0.056, 0.022, -0.118))
    tail = [(0, 0.185, -0.172), (0, 0.238, -0.220), (0, 0.300, -0.238), (0, 0.358, -0.226)]
    bones = quad_bones((0, 0.170, -0.105), (0, 0.175, -0.02), (0, 0.175, 0.065), (0, 0.205, 0.112), (0, 0.245, 0.145),
                       (0.037, 0.268, 0.226), fl, hl, ears=(0.054, 0.310, 0.150), tail=tail)
    P = Part
    body = [
        P(egg((0, 0.168, -0.100), (0.076, 0.074, 0.086)), "hips", grey, 0.0),
        P(egg((0, 0.168, -0.012), (0.070, 0.068, 0.090)), "spine", grey, 0.04),
        P(egg((0, 0.172, 0.066), (0.072, 0.076, 0.078)), "chest", grey, 0.04),
        P(limb((0, 0.192, 0.100), (0, 0.235, 0.140), 0.054, 0.052), "neck", grey, 0.03),
        P(egg((0, 0.265, 0.165), (0.094, 0.082, 0.084)), "head", grey, 0.025),
        P(ball((0.054, 0.236, 0.192), 0.038), "head", grey, 0.03, tag="cheek"),
        P(ball((-0.054, 0.236, 0.192), 0.038), "head", grey, 0.03, tag="cheek"),
        P(egg((0, 0.238, 0.232), (0.036, 0.026, 0.027)), "head", white, 0.02, tag="muzzle"),
        P(egg((0, 0.249, 0.257), (0.011, 0.008, 0.008)), "head", pink, 0.004, tag="nose"),
    ]
    for side, s in sides():
        ear = squash(limb((s * 0.054, 0.308, 0.152), (s * 0.072, 0.386, 0.146), 0.038, 0.005), (s * 0.06, 0.34, 0.15), (1, 1, 0.42))
        body.append(P(ear, f"ear_{side}", grey, 0.012, tag="ear"))
        x = s * fl[0][0]
        body += [
            P(limb((x, 0.140, 0.080), (x, fl[1][1], fl[1][2]), 0.036, 0.028), f"fl_upper_{side}", grey, 0.03, tag="leg"),
            P(limb((x, fl[1][1], fl[1][2]), (x, 0.030, 0.082), 0.027, 0.024), f"fl_lower_{side}", grey, 0.012, tag="leg"),
            P(egg((x, 0.020, 0.092), (0.028, 0.020, 0.034)), f"fl_paw_{side}", white, 0.012, tag="paw"),
            P(egg((s * hl[0][0], 0.125, -0.108), (0.038, 0.052, 0.050)), f"hl_upper_{side}", grey, 0.03, tag="leg"),
            P(limb((s * hl[1][0], hl[1][1], hl[1][2]), (s * hl[2][0], 0.030, hl[2][2]), 0.027, 0.024), f"hl_lower_{side}", grey, 0.014, tag="leg"),
            P(egg((s * hl[2][0], 0.020, hl[2][2] + 0.012), (0.028, 0.020, 0.036)), f"hl_paw_{side}", white, 0.012, tag="paw"),
        ]
    # The notch in her left ear.
    body.append(P(ball((0.096, 0.352, 0.148), 0.014), "ear_L", grey, 0.004, cut=True))
    pts = tail + [(0, 0.395, -0.198)]
    for i in range(4):
        body.append(P(limb(pts[i], pts[i + 1], 0.021 - i * 0.002, 0.019 - i * 0.002), f"tail{i + 1}", grey, 0.02 if i == 0 else 0.006, tag="tail"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        fur = 1.0 - np.clip(tag("muzzle") + tag("nose") + tag("paw"), 0, 1)
        # Tabby stripes down from the spine, rings on the tail and legs,
        # and the lines of an M on the forehead.
        back = sstep(-0.35, 0.25, N[:, 1])
        trunk = np.clip(1.0 - tag("head") - tag("cheek") - tag("ear") - tag("tail") - tag("leg") - tag("neck"), 0, 1)
        stripe = sstep(0.35, 0.75, np.sin((z + 0.012 * wobble(V, 38, 1)) * 86.0 + 0.9 * np.abs(x) * 40.0))
        m = stripe * back * trunk
        m = np.maximum(m, tag("tail") * sstep(0.3, 0.7, np.sin((y * 0.9 - z * 0.6) * 95.0)))
        m = np.maximum(m, tag("leg") * sstep(0.45, 0.8, np.sin(y * 150.0 + 1.0)) * sstep(0.035, 0.06, y))
        brow = sstep(0.290, 0.315, y) * sstep(0.14, 0.18, z) * (1 - sstep(0.215, 0.24, z)) * tag("head")
        m = np.maximum(m, brow * sstep(0.4, 0.8, np.cos(x * 150.0)) * (1 - sstep(0.045, 0.06, np.abs(x))))
        # A darker line along the spine.
        m = np.maximum(m, 0.8 * trunk * sstep(0.85, 0.99, N[:, 1]) * (1 - sstep(0.008, 0.02, np.abs(x))))
        C = tint(C, rgb(dark), m * fur * 0.9)
        # White: the bib down her chest, her belly, chin and the tip of
        # her tail.
        bib = sstep(0.02, 0.06, z) * (1 - sstep(0.165, 0.21, y)) * sstep(0.35, 0.75, N[:, 2] * 0.7 - N[:, 1] * 0.5 + 0.35) * (1 - tag("leg"))
        belly = sstep(0.45, 0.8, -N[:, 1]) * trunk
        chin = tag("head") * sstep(0.2, 0.6, -N[:, 1]) * sstep(0.17, 0.2, z)
        tailtip = tag("tail") * sstep(0.365, 0.385, y)
        C = tint(C, rgb(white), np.clip(np.maximum.reduce([bib, belly, chin, tailtip]), 0, 1) * (1 - tag("nose")))
        # Pink inside the ears (the side that faces forward).
        inner = tag("ear") * sstep(0.2, 0.6, N[:, 2]) * sstep(0.325, 0.34, y) * (1 - sstep(0.362, 0.378, y))
        return tint(C, rgb("#e9a9ab"), inner * 0.9)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.037, 0.268, 0.228), (0.027, 0.030, 0.017), (s * 0.2, 0.02, 1.0), f"eye_{side}", iris="#86c552",
                      pupil="slit", iris_a=1.08, pupil_a=0.6)
        for dy, dz in ((0.012, 0.0), (0.0, -0.004), (-0.012, -0.002)):
            a = (s * 0.030, 0.238 + dy * 0.3, 0.248)
            b = (s * 0.078, 0.238 + dy * 1.4, 0.238 + dz)
            c = (s * 0.120, 0.234 + dy * 2.6 - 0.006, 0.214 + dz)
            extras.append(tube([a, b, c], [0.0011, 0.0009, 0.0004], "#f8f8f4", "head", seg=4))
        # Her mouth: a little w under the nose.
        extras.append(tube([(0, 0.242, 0.2600), (0, 0.232, 0.2585), (s * 0.011, 0.227, 0.2555), (s * 0.020, 0.231, 0.2490)],
                           0.0015, "#3a2a26", "head", seg=4))
    return Pet("evie", bones, [body], extras, paint, step=0.0045, blend=0.014, edge=0.004,
               meta={"rig": "quad", "rump": 0.074, "mouth": [0, 0.232, 0.262], "back": 0.245, "top": 0.385, "length": 0.42})


def scupper():
    """Scupper: the Rexmaw's ship's dog, a corgi puppy in a red collar. A
    Pembroke Welsh corgi stands 25-30 cm at the shoulder; a puppy's size,
    its ears already full grown."""
    tan, white, black, red = "#e6a05c", "#fbf5ea", "#221a18", "#d6332e"
    fl = ((0.055, 0.115, 0.090), (0.055, 0.066, 0.086), (0.055, 0.022, 0.094))
    hl = ((0.060, 0.115, -0.140), (0.064, 0.068, -0.122), (0.062, 0.022, -0.142))
    tail = [(0, 0.185, -0.215), (0, 0.238, -0.256), (0, 0.292, -0.268)]
    bones = quad_bones((0, 0.150, -0.135), (0, 0.152, -0.03), (0, 0.155, 0.085), (0, 0.195, 0.135), (0, 0.243, 0.165),
                       (0.040, 0.272, 0.242), fl, hl, ears=(0.062, 0.312, 0.165), tail=tail,
                       extra={"tongue": ("head", (0, 0.228, 0.262))})
    P = Part
    body = [
        P(egg((0, 0.150, -0.130), (0.082, 0.078, 0.090)), "hips", tan, 0.0),
        P(egg((0, 0.150, -0.025), (0.078, 0.075, 0.105)), "spine", tan, 0.04),
        P(egg((0, 0.155, 0.085), (0.080, 0.082, 0.085)), "chest", tan, 0.04),
        P(limb((0, 0.180, 0.120), (0, 0.235, 0.155), 0.060, 0.055), "neck", tan, 0.03),
        P(egg((0, 0.264, 0.178), (0.090, 0.082, 0.082)), "head", tan, 0.025),
        P(ball((0.060, 0.236, 0.192), 0.040), "head", tan, 0.03, tag="cheek"),
        P(ball((-0.060, 0.236, 0.192), 0.040), "head", tan, 0.03, tag="cheek"),
        P(limb((0, 0.246, 0.215), (0, 0.240, 0.282), 0.040, 0.029), "head", white, 0.02, tag="muzzle"),
        P(egg((0, 0.252, 0.309), (0.015, 0.011, 0.011)), "head", black, 0.004, tag="nose"),
    ]
    for side, s in sides():
        ear = squash(limb((s * 0.062, 0.312, 0.166), (s * 0.096, 0.420, 0.156), 0.046, 0.012), (s * 0.075, 0.36, 0.162), (1, 1, 0.4))
        body.append(P(ear, f"ear_{side}", tan, 0.012, tag="ear"))
        x = s * fl[0][0]
        body += [
            P(limb((x, 0.118, 0.090), (x, fl[1][1], fl[1][2]), 0.038, 0.032), f"fl_upper_{side}", tan, 0.03, tag="leg"),
            P(limb((x, fl[1][1], fl[1][2]), (x, 0.030, 0.092), 0.031, 0.028), f"fl_lower_{side}", white, 0.012, tag="leg"),
            P(egg((x, 0.021, 0.102), (0.032, 0.021, 0.038)), f"fl_paw_{side}", white, 0.012, tag="paw"),
            P(egg((s * hl[0][0], 0.118, -0.135), (0.042, 0.052, 0.054)), f"hl_upper_{side}", tan, 0.03, tag="leg"),
            P(limb((s * hl[1][0], hl[1][1], hl[1][2]), (s * hl[2][0], 0.030, hl[2][2]), 0.031, 0.028), f"hl_lower_{side}", white, 0.014, tag="leg"),
            P(egg((s * hl[2][0], 0.021, hl[2][2] + 0.012), (0.032, 0.021, 0.040)), f"hl_paw_{side}", white, 0.012, tag="paw"),
        ]
    pts = tail + [(0, 0.335, -0.252)]
    for i, (ra, rb) in enumerate(((0.030, 0.036), (0.036, 0.034), (0.034, 0.014))):
        body.append(P(limb(pts[i], pts[i + 1], ra, rb), f"tail{i + 1}", tan, 0.02 if i == 0 else 0.008, tag="tail"))
    tongue = [P(egg((0, 0.214, 0.284), (0.017, 0.006, 0.026), rot=(28, 0, 0)), "tongue", "#f28a9a", 0.0)]

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        keep = 1 - np.clip(tag("nose"), 0, 1)
        trunk = np.clip(1.0 - tag("head") - tag("cheek") - tag("ear") - tag("tail") - tag("leg"), 0, 1)
        # White: a blaze up the forehead, the cheeks under the eyes, the
        # chest and belly, and the tip of the tail.
        blaze = tag("head") * (1 - sstep(0.010, 0.022 + 0.6 * np.clip(0.30 - y, 0, 1) * 0.12, np.abs(x))) * sstep(0.19, 0.21, z)
        jowl = (tag("cheek") + tag("head")) * sstep(0.262, 0.240, y) * sstep(0.185, 0.21, z)
        bib = sstep(0.03, 0.08, z) * (1 - sstep(0.15, 0.20, y)) * sstep(0.3, 0.7, N[:, 2] * 0.7 - N[:, 1] * 0.5 + 0.35) * (1 - tag("leg"))
        belly = sstep(0.5, 0.85, -N[:, 1]) * trunk
        tailtip = tag("tail") * sstep(0.300, 0.318, y)
        C = tint(C, rgb(white), np.clip(np.maximum.reduce([blaze, jowl, bib, belly, tailtip]), 0, 1) * keep)
        # A darker saddle along the back, and the ears' insides.
        saddle = trunk * sstep(0.55, 0.95, N[:, 1]) * 0.35
        C = tint(C, rgb("#c97f3e"), saddle * keep)
        inner = tag("ear") * sstep(0.2, 0.6, N[:, 2]) * sstep(0.335, 0.352, y) * (1 - sstep(0.392, 0.408, y))
        return tint(C, rgb("#f0c7a8"), inner * 0.9)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.040, 0.272, 0.243), (0.021, 0.023, 0.014), (s * 0.22, 0.02, 1.0), f"eye_{side}", iris="#4a2c16",
                      pupil="round", iris_a=1.1, pupil_a=0.62)
        # A smile along the muzzle.
        extras.append(tube([(0, 0.243, 0.3105), (0, 0.229, 0.305), (s * 0.016, 0.222, 0.292), (s * 0.028, 0.226, 0.268)],
                           0.0017, "#2a1e1c", "head", seg=4))
    # A collar: a band lying on the neck's own surface all the way round,
    # square to the neck, with a brass tag at the throat.
    mid, axis = np.array([0, 0.200, 0.132]), np.array([0, 0.055, 0.035])
    axis = axis / np.linalg.norm(axis)
    side_v = np.array([1.0, 0.0, 0.0])
    down_v = np.cross(side_v, axis)
    ring = [on_surface(body, mid, math.cos(a) * side_v + math.sin(a) * down_v, lift=0.003) for a in np.linspace(0, 2 * math.pi, 37)]
    extras.append(tube(ring, 0.0085, red, "neck", seg=8))
    throat = on_surface(body, mid, down_v if down_v[2] > 0 else -down_v, lift=0.012)
    gv, gn, gf, _ = sphere_mesh(throat + np.array([0, -0.012, 0.002]), (0.012, 0.014, 0.005), 12, 8)
    extras.append(Extra(gv, gn, gf, "#e8c25a", "neck"))
    return Pet("scupper", bones, [body, tongue], extras, paint, step=0.0048, blend=0.014, edge=0.004,
               meta={"rig": "quad", "rump": 0.078, "mouth": [0, 0.236, 0.315], "back": 0.228, "top": 0.42, "length": 0.55})


def basil():
    """Basil: the lop-eared rabbit who lives in the herb boxes behind
    Ara's café, cream with caramel ears and patches. A Holland Lop is the
    smallest lop: about 1.8 kg, a body that fits in two hands."""
    cream, caramel, white, pink = "#f1e3cb", "#c58a52", "#fffaf2", "#f2a3a8"
    fl = ((0.040, 0.078, 0.066), (0.040, 0.046, 0.072), (0.040, 0.016, 0.082))
    hl = ((0.060, 0.100, -0.072), (0.068, 0.064, -0.022), (0.068, 0.020, -0.082))
    bones = quad_bones((0, 0.105, -0.068), (0, 0.122, -0.008), (0, 0.128, 0.052), (0, 0.160, 0.082), (0, 0.198, 0.102),
                       (0.049, 0.212, 0.166), fl, hl, ears=(0.058, 0.246, 0.100), tail=[(0, 0.118, -0.150)])
    P = Part
    body = [
        P(egg((0, 0.104, -0.064), (0.086, 0.090, 0.090)), "hips", cream, 0.0),
        P(egg((0, 0.120, 0.000), (0.078, 0.080, 0.085)), "spine", cream, 0.04),
        P(egg((0, 0.126, 0.054), (0.066, 0.070, 0.066)), "chest", cream, 0.04),
        P(limb((0, 0.150, 0.075), (0, 0.185, 0.098), 0.050, 0.050), "neck", cream, 0.03),
        P(egg((0, 0.206, 0.116), (0.076, 0.070, 0.077)), "head", cream, 0.025),
        P(ball((0.046, 0.182, 0.142), 0.035), "head", cream, 0.03, tag="cheek"),
        P(ball((-0.046, 0.182, 0.142), 0.035), "head", cream, 0.03, tag="cheek"),
        P(egg((0, 0.186, 0.180), (0.030, 0.024, 0.022)), "head", white, 0.02, tag="muzzle"),
        P(egg((0, 0.197, 0.199), (0.008, 0.006, 0.006)), "head", pink, 0.003, tag="nose"),
        P(ball((0, 0.122, -0.160), 0.033), "tail1", white, 0.012, tag="tail"),
    ]
    for side, s in sides():
        # A lop's ear hangs down the side of the head.
        ear = squash(limb((s * 0.056, 0.246, 0.102), (s * 0.104, 0.108, 0.088), 0.027, 0.036), (s * 0.08, 0.18, 0.095), (0.4, 1, 1), rot=(0, 0, -s * 19))
        body.append(P(ear, f"ear_{side}", caramel, 0.012, tag="ear"))
        x = s * fl[0][0]
        body += [
            P(limb((x, 0.085, 0.064), (x, fl[1][1], fl[1][2]), 0.030, 0.025), f"fl_upper_{side}", cream, 0.03, tag="leg"),
            P(limb((x, fl[1][1], fl[1][2]), (x, 0.024, 0.078), 0.024, 0.021), f"fl_lower_{side}", cream, 0.012, tag="leg"),
            P(egg((x, 0.016, 0.088), (0.023, 0.016, 0.030)), f"fl_paw_{side}", white, 0.012, tag="paw"),
            # Folded under: the thigh forward to the knee, back to the
            # hock, and the long foot forward along the floor.
            P(egg((s * 0.064, 0.082, -0.048), (0.040, 0.058, 0.064)), f"hl_upper_{side}", cream, 0.03, tag="leg"),
            P(limb((s * hl[1][0], hl[1][1], hl[1][2]), (s * hl[2][0], 0.026, hl[2][2]), 0.026, 0.022), f"hl_lower_{side}", cream, 0.016, tag="leg"),
            P(limb((s * 0.068, 0.019, -0.084), (s * 0.068, 0.017, 0.006), 0.019, 0.019), f"hl_paw_{side}", white, 0.012, tag="paw"),
        ]

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        fur = 1 - np.clip(tag("nose") + tag("ear") + tag("muzzle") + tag("paw") + tag("tail"), 0, 1)
        # Caramel: a saddle over the back, and a patch round each eye.
        saddle = sstep(0.25, 0.6, N[:, 1] + 0.25 * wobble(V, 24, 3)) * sstep(-0.13, -0.09, -np.abs(z + 0.02)) * (1 - tag("head")) * (1 - tag("leg"))
        d = np.sqrt((np.abs(x) - 0.050) ** 2 + (y - 0.214) ** 2 + (z - 0.160) ** 2)
        patch = (1 - sstep(0.030, 0.037, d)) * tag("head")
        C = tint(C, rgb(caramel), np.clip(np.maximum(saddle, patch), 0, 1) * fur)
        # White underneath, and a blaze down the nose.
        belly = sstep(0.4, 0.8, -N[:, 1] + 0.3 * sstep(0.02, 0.07, z)) * (1 - tag("head")) * (1 - tag("ear"))
        blaze = tag("head") * (1 - sstep(0.008, 0.018, np.abs(x))) * sstep(0.15, 0.17, z)
        C = tint(C, rgb(white), np.clip(np.maximum(belly, blaze), 0, 1) * (1 - tag("nose")) * (1 - tag("ear")))
        # The ears' insides (they face the head), a shade pinker.
        inner = tag("ear") * sstep(0.3, 0.7, -N[:, 0] * np.sign(x))
        return tint(C, rgb("#e7b99a"), inner * 0.8)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.049, 0.213, 0.167), (0.017, 0.020, 0.013), (s * 0.62, 0.03, 0.78), f"eye_{side}", iris="#2b1a12",
                      pupil=None, iris_a=1.2, shine=0.3)
        for dy in (0.008, -0.004):
            extras.append(tube([(s * 0.024, 0.186 + dy * 0.3, 0.194), (s * 0.062, 0.186 + dy * 1.5, 0.186), (s * 0.094, 0.182 + dy * 2.6, 0.166)],
                               [0.0009, 0.0007, 0.0003], "#fbfbf8", "head", seg=4))
        extras.append(tube([(0, 0.191, 0.2015), (0, 0.181, 0.2005), (s * 0.009, 0.176, 0.1975), (s * 0.016, 0.180, 0.1915)],
                           0.0013, "#5a3b34", "head", seg=4))
    return Pet("basil", bones, [body], extras, paint, step=0.004, blend=0.013, edge=0.004,
               meta={"rig": "quad", "rump": 0.09, "gait": "hop", "mouth": [0, 0.180, 0.204], "back": 0.205, "top": 0.28, "length": 0.36})


def pip():
    """Pip: a little green poison-dart frog from the marsh by Sal's
    stilt-hut, a green-and-black dart frog's colours. One is 2.5-4 cm
    long; drawn at about three times that so it reads across a room (by
    eye)."""
    skin, limbs, pale, black = "#3fbf4f", "#1e8f3e", "#cdeea0", "#0c1220"
    fl = ((0.030, 0.036, 0.020), (0.047, 0.021, 0.030), (0.051, 0.006, 0.043))
    hl = ((0.026, 0.030, -0.040), (0.056, 0.034, 0.000), (0.050, 0.011, -0.046))
    bones = quad_bones((0, 0.030, -0.035), (0, 0.036, -0.010), (0, 0.041, 0.015), (0, 0.046, 0.030), (0, 0.050, 0.040),
                       (0.024, 0.072, 0.048), fl, hl, extra={"throat": ("head", (0, 0.032, 0.046))})
    P = Part
    body = [
        P(egg((0, 0.031, -0.030), (0.032, 0.025, 0.031)), "hips", skin, 0.0),
        P(egg((0, 0.038, -0.004), (0.036, 0.028, 0.035)), "spine", skin, 0.015),
        P(egg((0, 0.044, 0.021), (0.034, 0.026, 0.028)), "chest", skin, 0.015),
        P(egg((0, 0.051, 0.046), (0.035, 0.024, 0.031)), "head", skin, 0.012),
        P(ball((0.023, 0.068, 0.046), 0.014), "head", skin, 0.008, tag="brow"),
        P(ball((-0.023, 0.068, 0.046), 0.014), "head", skin, 0.008, tag="brow"),
        P(ball((0, 0.034, 0.050), 0.018), "throat", pale, 0.006, tag="throat"),
    ]
    for side, s in sides():
        a, b, c = [(s * p[0], p[1], p[2]) for p in fl]
        body += [
            P(limb(a, b, 0.010, 0.008), f"fl_upper_{side}", limbs, 0.008, tag="leg"),
            P(limb(b, c, 0.008, 0.007), f"fl_lower_{side}", limbs, 0.004, tag="leg"),
            P(egg((s * 0.053, 0.005, 0.048), (0.011, 0.0045, 0.011)), f"fl_paw_{side}", limbs, 0.003, tag="leg"),
        ]
        for dx, dz in ((-0.010, 0.010), (0.001, 0.014), (0.011, 0.008)):
            body.append(P(ball((s * (0.053 + dx), 0.005, 0.048 + dz), 0.0052), f"fl_paw_{side}", limbs, 0.003, tag="leg"))
        h, k, f = [(s * p[0], p[1], p[2]) for p in hl]
        toes = (s * 0.068, 0.005, -0.008)
        body += [
            P(limb(h, k, 0.014, 0.012), f"hl_upper_{side}", limbs, 0.010, tag="leg"),
            P(limb(k, f, 0.011, 0.009), f"hl_lower_{side}", limbs, 0.004, tag="leg"),
            P(limb(f, toes, 0.008, 0.006), f"hl_paw_{side}", limbs, 0.004, tag="leg"),
        ]
        for dx, dz in ((-0.011, 0.008), (0.001, 0.014), (0.012, 0.006)):
            body.append(P(ball((toes[0] + s * dx, 0.005, toes[2] + dz), 0.0055), f"hl_paw_{side}", limbs, 0.003, tag="leg"))

    def paint(V, N, C, tag):
        # Black spots over the back and legs; paler underneath.
        up = sstep(-0.2, 0.3, N[:, 1])
        big = spots(V, 0.021, 0.30, 2) * up * (1 - tag("leg")) * (1 - tag("throat"))
        small = spots(V, 0.011, 0.27, 5) * tag("leg")
        C = tint(C, rgb(black), np.clip(big + small, 0, 1))
        belly = sstep(0.35, 0.8, -N[:, 1]) * (1 - tag("leg"))
        return tint(C, rgb(pale), belly * 0.85)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.0245, 0.0715, 0.0485), 0.0112, (s * 0.72, 0.28, 0.63), f"eye_{side}", iris="#d9a400", pupil="round",
                      iris_a=1.2, pupil_a=1.02, shine=0.3)
    # A wide, pleased mouth.
    mouth = [(x, 0.0445 - 0.004 * (1 - (x / 0.03) ** 2), 0.046 + 0.0325 * math.sqrt(max(0.0, 1 - (x / 0.0352) ** 2))) for x in np.linspace(-0.025, 0.025, 13)]
    extras.append(tube(mouth, 0.0007, "#0c1220", "head", seg=4))
    return Pet("pip", bones, [body], extras, paint, step=0.0016, blend=0.004, edge=0.0012,
               meta={"rig": "quad", "rump": 0.025, "gait": "hop", "mouth": [0, 0.043, 0.079], "back": 0.068, "top": 0.085, "length": 0.12})


def gerald():
    """Gerald: the megalodon of chapter nine, pocket-sized, swimming through
    the air. The plush's colours (art.js): slate above, white below, pink
    cheeks."""
    slate, dark, white = "#94a3b8", "#64748b", "#f1f5f9"
    bones = {
        "body": (None, (0, 0, 0)), "head": ("body", (0, 0, 0.065)), "jaw": ("head", (0, -0.032, 0.070)),
        "eye_L": ("head", (0.064, 0.024, 0.118)), "eye_R": ("head", (-0.064, 0.024, 0.118)),
        "tail1": ("body", (0, 0, -0.070)), "tail2": ("tail1", (0, 0.002, -0.130)), "tail3": ("tail2", (0, 0.005, -0.185)),
        "fin_L": ("body", (0.074, -0.034, 0.030)), "fin_R": ("body", (-0.074, -0.034, 0.030)),
    }
    P = Part
    mouth = egg((0, -0.036, 0.150), (0.075, 0.013, 0.075), rot=(9, 0, 0))
    body = [
        P(egg((0, 0, 0.000), (0.086, 0.080, 0.110)), "body", slate, 0.0),
        P(egg((0, 0.002, 0.085), (0.083, 0.074, 0.088)), "head", slate, 0.04),
        P(egg((0, 0.014, 0.150), (0.052, 0.040, 0.046)), "head", slate, 0.03, tag="snout"),
        P(egg((0, -0.050, 0.104), (0.060, 0.022, 0.062)), "jaw", white, 0.012, tag="jaw"),
        P(limb((0, 0, -0.070), (0, 0.002, -0.130), 0.062, 0.042), "tail1", slate, 0.04, tag="tail"),
        P(limb((0, 0.002, -0.130), (0, 0.005, -0.185), 0.042, 0.022), "tail2", slate, 0.02, tag="tail"),
        P(squash(limb((0, 0.005, -0.180), (0, 0.092, -0.252), 0.026, 0.006), (0, 0.04, -0.21), (0.32, 1, 1)), "tail3", dark, 0.012, tag="fin"),
        P(squash(limb((0, 0.005, -0.180), (0, -0.052, -0.232), 0.024, 0.006), (0, -0.02, -0.2), (0.32, 1, 1)), "tail3", dark, 0.012, tag="fin"),
        P(squash(limb((0, 0.060, 0.012), (0, 0.158, -0.044), 0.046, 0.006), (0, 0.1, -0.01), (0.28, 1, 1)), "body", dark, 0.014, tag="fin"),
        P(mouth, "head", white, 0.004, cut=True),
    ]
    for side, s in sides():
        fin = squash(limb((s * 0.070, -0.036, 0.032), (s * 0.158, -0.082, -0.024), 0.034, 0.008), (s * 0.11, -0.055, 0.0), (1, 0.3, 1), rot=(0, 0, -s * 26))
        body.append(P(fin, f"fin_{side}", dark, 0.012, tag="fin"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        skin = 1 - tag("fin")
        # White below a wavy line; the inside of the mouth; gills; cheeks.
        line = -0.018 + 0.006 * np.sin(z * 55.0) + 0.02 * sstep(0.05, 0.16, z)
        C = tint(C, rgb(white), (1 - sstep(line - 0.006, line + 0.006, y)) * skin)
        inside = 1 - sstep(0.0005, 0.004, mouth(V))
        C = tint(C, rgb("#8e2233"), inside)
        gills = sstep(0.75, 0.95, np.sin((z - 0.018) * 260.0)) * sstep(0.012, 0.02, z) * (1 - sstep(0.052, 0.06, z)) \
            * sstep(0.055, 0.07, np.abs(x)) * sstep(-0.035, -0.02, y) * (1 - sstep(0.02, 0.035, y))
        C = tint(C, rgb("#55617a"), gills * skin)
        d = np.sqrt(((np.abs(x) - 0.070) / 1.0) ** 2 + ((y + 0.004) / 0.6) ** 2 + ((z - 0.098) / 1.0) ** 2)
        return tint(C, rgb("#f6a5b4"), (1 - sstep(0.012, 0.02, d)) * 0.85 * (1 - inside))

    extras = []
    for side, s in sides():
        extras += eye((s * 0.064, 0.024, 0.120), 0.021, (s * 0.80, 0.10, 0.59), f"eye_{side}", iris="#141a26", pupil=None, iris_a=1.3, shine=0.3)
    # Teeth: set on the roof and the floor of the mouth itself (the carved
    # shape's own surfaces), just inside the lips, wherever round the front
    # the mouth is open; the lower row between the upper ones.
    solid = [p for p in body if not p.cut]
    R, c, mr, mh = rot_matrix(9, 0, 0), np.array([0, -0.036, 0.150]), 0.075, 0.013
    # (In the mouth's own frame: x across it, z out of it, y its roof.)
    for i, x in enumerate(np.linspace(-0.066, 0.066, 25)):
        deep = c + R @ np.array([x, 0.0, -0.06])
        if body_field(solid, deep[None, :])[0] >= 0:
            continue
        # The lip here (where the mouth's mid-plane meets the skin), and a
        # tooth's place a little inside it.
        lip = on_surface(solid, deep, R @ np.array([0.0, 0.0, 1.0]))
        z = float((R.T @ (lip - c))[2]) - 0.007
        e = (x / mr) ** 2 + (z / mr) ** 2
        if e >= 1:
            continue        # (closed here: the mouth doesn't reach the skin)
        h = mh * math.sqrt(1 - e)
        if h < 0.003:
            continue
        at = np.array([x, 0.0, z])
        if i % 2 == 0:
            long = min(0.011, h * 1.5)
            extras.append(cone(c + R @ (at + np.array([0, h + 0.002, 0])), c + R @ (at + np.array([0, h - long, 0])), 0.0052, "#ffffff", "head", seg=5))
        else:
            long = min(0.008, h * 1.2)
            extras.append(cone(c + R @ (at + np.array([0, -h - 0.002, -0.002])), c + R @ (at + np.array([0, -h + long, -0.002])), 0.0045, "#ffffff", "jaw", seg=5))
    return Pet("gerald", bones, [body], extras, paint, step=0.004, blend=0.016, edge=0.004,
               meta={"rig": "fish", "mouth": [0, -0.036, 0.205], "back": 0.08, "top": 0.16, "length": 0.45, "floats": True})


def _toes(extras, side, s, at, color, front, back, spread, r=0.0042, claw=None):
    """A bird's foot at `at`: toes forward and back along the floor."""
    x, y, z = at
    for i in range(front):
        dx = (i - (front - 1) / 2) * spread
        tip = (x + s * dx * 2.2, 0.004, z + 0.034 - abs(dx) * 0.4)
        extras.append(tube([(x, y, z), (x + s * dx, 0.006, z + 0.016), tip], [r, r * 0.9, r * 0.6], color, f"foot_{side}", seg=5))
        if claw:
            extras.append(cone(tip, (tip[0], 0.001, tip[2] + 0.008), r * 0.6, claw, f"foot_{side}", seg=4))
    for i in range(back):
        dx = (i - (back - 1) / 2) * spread
        extras.append(tube([(x, y, z), (x + s * dx, 0.006, z - 0.012), (x + s * dx * 2, 0.004, z - 0.026)], [r, r * 0.9, r * 0.6], color, f"foot_{side}", seg=5))


def biscuit():
    """Biscuit: the ship's parrot, a scarlet macaw's colours (red, a yellow
    band and blue flight feathers on the wing, a bare white face) on a
    conure's small frame: a macaw is 81-96 cm with its tail."""
    red, yellow, blue, face, bone_c, grey = "#d93030", "#f6c62f", "#2a60d8", "#f6f1e7", "#eadcbf", "#5d6068"
    bones = bird_bones((0, 0.112, 0.0), (0, 0.186, 0.020), (0, 0.216, 0.030), (0.031, 0.228, 0.058),
                       (0.048, 0.166, 0.004), (0.135, 0.166, -0.004), (0, 0.076, -0.046), (0, 0.034, -0.102),
                       (0.028, 0.066, 0.006), (0.028, 0.016, 0.012))
    P = Part
    body = [
        P(egg((0, 0.118, 0.000), (0.052, 0.072, 0.054), rot=(-16, 0, 0)), "body", red, 0.0),
        P(limb((0, 0.166, 0.012), (0, 0.206, 0.028), 0.038, 0.037), "neck", red, 0.02),
        P(egg((0, 0.223, 0.035), (0.044, 0.043, 0.046)), "head", red, 0.015),
        P(squash(limb((0, 0.224, 0.068), (0, 0.213, 0.098), 0.021, 0.014), (0, 0.22, 0.08), (0.72, 1, 1)), "head", bone_c, 0.004, tag="beak"),
        P(squash(limb((0, 0.213, 0.098), (0, 0.188, 0.100), 0.014, 0.004), (0, 0.2, 0.1), (0.72, 1, 1)), "head", bone_c, 0.003, tag="beak"),
        P(egg((0, 0.198, 0.074), (0.013, 0.011, 0.016)), "head", "#2a2626", 0.004, tag="beak2"),
        P(squash(limb((0, 0.076, -0.046), (0, 0.034, -0.102), 0.030, 0.024), (0, 0.055, -0.07), (1.15, 0.7, 1), rot=(35, 0, 0)), "tail1", red, 0.02, tag="tail"),
        P(squash(limb((0, 0.034, -0.102), (0, 0.016, -0.200), 0.024, 0.010), (0, 0.025, -0.15), (1.1, 0.6, 1)), "tail2", blue, 0.01, tag="tail"),
    ]
    extras = []
    wings = []
    for side, s in sides():
        body.append(P(limb((s * 0.028, 0.074, 0.006), (s * 0.028, 0.022, 0.012), 0.014, 0.008), f"leg_{side}", grey, 0.012, tag="leg"))
        # The wing, open: shoulder to wrist, wrist to tip, a flat blade
        # whose trailing edge is the flight feathers.
        wings.append([
            P(egg((s * 0.090, 0.166, -0.016), (0.052, 0.0085, 0.050)), f"wing_{side}", red, 0.0, tag="wing"),
            P(egg((s * 0.168, 0.166, -0.030), (0.058, 0.0075, 0.046), rot=(0, -s * 12, 0)), f"wing2_{side}", yellow, 0.02, tag="wing"),
            P(egg((s * 0.222, 0.166, -0.050), (0.042, 0.0065, 0.030), rot=(0, -s * 24, 0)), f"wing2_{side}", blue, 0.016, tag="wing"),
        ])
        extras += eye((s * 0.0315, 0.2285, 0.059), 0.0098, (s * 0.86, 0.06, 0.5), f"eye_{side}", iris="#f4ebb0", pupil="round",
                      iris_a=1.15, pupil_a=0.6, shine=0.3)
        _toes(extras, side, s, (s * 0.028, 0.016, 0.012), grey, 2, 2, 0.011)

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        # The bare white face round each eye, with its fine feather lines.
        d = np.sqrt((np.abs(x) - 0.030) ** 2 + (y - 0.224) ** 2 + ((z - 0.060) * 0.8) ** 2)
        patch = (1 - sstep(0.020, 0.025, d)) * tag("head") * (1 - tag("beak")) * (1 - tag("beak2"))
        C = tint(C, rgb(face), patch)
        C = tint(C, rgb("#d93030"), patch * sstep(0.8, 0.98, np.sin(y * 900.0)) * 0.55)
        # The wing: red at the shoulder, a yellow band, blue flight
        # feathers along the trailing edge and the tip.
        w = tag("wing")
        ax = np.abs(x)
        band = sstep(0.105, 0.125, ax) * (1 - sstep(0.165, 0.185, ax))
        C = tint(C, rgb(yellow), w * band)
        flight = np.clip(sstep(0.165, 0.19, ax) + sstep(-0.040, -0.058, z + 0.1 * (ax - 0.1)), 0, 1)
        C = tint(C, rgb(blue), w * flight)
        C = tint(C, rgb("#1f48a8"), w * flight * sstep(0.5, 0.9, np.sin(ax * 420.0)) * 0.5)
        # Blue coming in down the tail; red thighs.
        C = tint(C, rgb(blue), tag("tail") * sstep(-0.075, -0.12, z))
        return tint(C, rgb(red), tag("leg") * sstep(0.045, 0.058, y))

    return Pet("biscuit", bones, [body] + wings, extras, paint, step=0.003, blend=0.009, edge=0.0028,
               meta={"rig": "bird", "mouth": [0, 0.200, 0.104], "back": 0.19, "top": 0.268, "length": 0.30})


def encore():
    """Encore: the little owl who roosts in the fly loft of the opera
    house where Leo calls the show. A little owl stands about 22 cm; brown
    above, cream below with brown flecks, a pale face, yellow eyes."""
    brown, dark, cream, beak, foot = "#8b5e3c", "#5c3d26", "#f3e6cc", "#e2b54a", "#d9b56e"
    bones = bird_bones((0, 0.092, 0.0), (0, 0.150, 0.004), (0, 0.176, 0.008), (0.032, 0.187, 0.062),
                       (0.058, 0.136, 0.000), (0.138, 0.136, -0.006), (0, 0.062, -0.050), (0, 0.040, -0.086),
                       (0.030, 0.046, 0.010), (0.030, 0.013, 0.014))
    P = Part
    body = [
        P(egg((0, 0.096, 0.000), (0.067, 0.076, 0.061)), "body", brown, 0.0),
        P(limb((0, 0.140, 0.004), (0, 0.165, 0.008), 0.052, 0.054), "neck", brown, 0.02),
        P(egg((0, 0.184, 0.012), (0.072, 0.061, 0.060)), "head", brown, 0.02),
        P(egg((0.032, 0.186, 0.053), (0.037, 0.037, 0.016)), "head", cream, 0.008, tag="disc"),
        P(egg((-0.032, 0.186, 0.053), (0.037, 0.037, 0.016)), "head", cream, 0.008, tag="disc"),
        P(limb((0, 0.180, 0.066), (0, 0.158, 0.073), 0.011, 0.004), "head", beak, 0.003, tag="beak"),
        P(squash(limb((0, 0.062, -0.050), (0, 0.040, -0.086), 0.034, 0.028), (0, 0.05, -0.07), (1.2, 0.6, 1), rot=(30, 0, 0)), "tail1", brown, 0.02, tag="tail"),
        P(squash(limb((0, 0.040, -0.086), (0, 0.024, -0.118), 0.028, 0.016), (0, 0.03, -0.1), (1.25, 0.55, 1), rot=(25, 0, 0)), "tail2", dark, 0.01, tag="tail"),
    ]
    extras = []
    wings = []
    for side, s in sides():
        tuft = squash(limb((s * 0.046, 0.226, 0.010), (s * 0.066, 0.266, 0.002), 0.017, 0.004), (s * 0.055, 0.245, 0.006), (1, 1, 0.5))
        body.append(P(tuft, "head", dark, 0.008, tag="tuft"))
        body.append(P(limb((s * 0.030, 0.052, 0.010), (s * 0.030, 0.018, 0.014), 0.019, 0.013), f"leg_{side}", cream, 0.012, tag="leg"))
        wings.append([
            P(egg((s * 0.100, 0.136, -0.012), (0.056, 0.0095, 0.052)), f"wing_{side}", brown, 0.0, tag="wing"),
            P(egg((s * 0.176, 0.136, -0.022), (0.058, 0.0085, 0.044), rot=(0, -s * 10, 0)), f"wing2_{side}", brown, 0.02, tag="wing"),
        ])
        extras += eye((s * 0.032, 0.188, 0.0645), (0.022, 0.022, 0.011), (s * 0.10, 0.0, 1.0), f"eye_{side}", iris="#f4ac1e", pupil="round",
                      iris_a=1.15, pupil_a=0.6, shine=0.26)
        _toes(extras, side, s, (s * 0.030, 0.013, 0.014), foot, 3, 1, 0.011, claw="#3a2c20")

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        w = tag("wing")
        plain = 1 - np.clip(tag("disc") + tag("beak") + tag("leg") + w, 0, 1)
        # Cream down the front, flecked with brown; the back mottled.
        front = sstep(0.1, 0.55, N[:, 2] + 0.25) * (1 - sstep(0.155, 0.17, y)) * (1 - tag("tail"))
        C = tint(C, rgb(cream), front * plain)
        C = tint(C, rgb(brown), front * plain * spots(V * np.array([1.0, 0.55, 1.0]), 0.017, 0.22, 4) * 0.9)
        C = tint(C, rgb(cream), (1 - front) * plain * spots(V, 0.016, 0.16, 9) * 0.8 * (1 - tag("tuft")))
        # A dark rim round the face, and a line between the eyes.
        d = np.sqrt((np.abs(x) - 0.032) ** 2 + (y - 0.186) ** 2)
        rim = sstep(0.031, 0.035, d) * (1 - sstep(0.038, 0.042, d)) * sstep(0.035, 0.05, z) * tag("head")
        C = tint(C, rgb(dark), rim * (1 - tag("beak")))
        # Bars across the wings, a paler edge on each.
        bars = sstep(0.4, 0.8, np.sin(np.abs(x) * 240.0 + z * 60.0))
        C = tint(C, rgb(dark), w * bars * 0.75)
        return tint(C, rgb(cream), w * spots(V, 0.02, 0.14, 12) * 0.7)

    return Pet("encore", bones, [body] + wings, extras, paint, step=0.003, blend=0.009, edge=0.0028,
               meta={"rig": "bird", "mouth": [0, 0.160, 0.076], "back": 0.17, "top": 0.27, "length": 0.2})


def barnacle():
    """Barnacle: a small red shore crab who came aboard on the Rexmaw's
    anchor chain. Built looking out of its own side (its face to -X, its
    walking legs fore and aft of the model) so that going "forward" it
    scuttles sideways, as a crab does. A shore crab's shell is 6-8 cm
    across; drawn at about twice that. The four-legged rig's bones: its
    claws are the "ears" (pet_rig.js `ears: "claw"`)."""
    red, dark, pale = "#e2552f", "#a8361c", "#f6d9b8"
    # Two walking legs out of each side (the model's front and back), one
    # nearer its face than the other: hip, knee (up and out), foot.
    legs = {"L": 0.034, "R": -0.010}
    bones = {
        "hips": (None, (0, 0.050, -0.025)), "spine": ("hips", (0, 0.050, 0.0)), "chest": ("spine", (0, 0.050, 0.025)),
        "neck": ("chest", (0, 0.058, 0.0)), "head": ("neck", (-0.030, 0.066, 0.0)),
        "eye_L": ("head", (-0.050, 0.104, 0.022)), "eye_R": ("head", (-0.050, 0.104, -0.022)),
        "ear_L": ("spine", (-0.036, 0.046, 0.056)), "ear_R": ("spine", (-0.036, 0.046, -0.056)),
    }
    P = Part
    body = [
        P(egg((0, 0.050, 0.0), (0.052, 0.031, 0.076)), "spine", red, 0.0, tag="shell"),
        P(egg((-0.030, 0.048, 0.0), (0.030, 0.024, 0.050)), "spine", red, 0.012, tag="shell"),
    ]
    for kind, parent, sz in (("fl", "chest", 1.0), ("hl", "hips", -1.0)):
        for side, x in legs.items():
            hip, knee, foot = (x, 0.046, sz * 0.058), (x * 1.25, 0.078, sz * 0.104), (x * 1.4, 0.007, sz * 0.136)
            bones[f"{kind}_upper_{side}"] = (parent, hip)
            bones[f"{kind}_lower_{side}"] = (f"{kind}_upper_{side}", knee)
            bones[f"{kind}_paw_{side}"] = (f"{kind}_lower_{side}", foot)
            body += [
                P(limb(hip, knee, 0.012, 0.010), f"{kind}_upper_{side}", red, 0.010, tag="leg"),
                P(limb(knee, foot, 0.009, 0.0035), f"{kind}_lower_{side}", red, 0.004, tag="leg"),
                P(ball(foot, 0.0045), f"{kind}_paw_{side}", dark, 0.002, tag="tip"),
            ]
    for side, sz in (("L", 1.0), ("R", -1.0)):
        # A claw: its arm out and forward, the pincer's two fingers.
        body += [
            P(limb((-0.036, 0.046, sz * 0.056), (-0.076, 0.050, sz * 0.072), 0.012, 0.011), f"ear_{side}", red, 0.010, tag="claw"),
            P(egg((-0.100, 0.056, sz * 0.066), (0.031, 0.021, 0.019)), f"ear_{side}", red, 0.008, tag="claw"),
            P(limb((-0.118, 0.066, sz * 0.064), (-0.144, 0.060, sz * 0.060), 0.010, 0.003), f"ear_{side}", dark, 0.004, tag="pincer"),
            P(limb((-0.116, 0.046, sz * 0.064), (-0.140, 0.047, sz * 0.060), 0.008, 0.003), f"ear_{side}", dark, 0.004, tag="pincer"),
            # Its eye, on a stalk.
            P(limb((-0.044, 0.070, sz * 0.021), (-0.050, 0.100, sz * 0.022), 0.006, 0.005), "head", red, 0.004, tag="stalk"),
        ]

    def paint(V, N, C, tag):
        # Paler underneath; a darker mottle over the top of the shell.
        C = tint(C, rgb(pale), sstep(0.35, 0.8, -N[:, 1]) * tag("shell"))
        C = tint(C, rgb(dark), sstep(0.3, 0.8, N[:, 1]) * tag("shell") * spots(V, 0.022, 0.26, 6) * 0.55)
        return tint(C, rgb(dark), tag("leg") * (1 - sstep(0.012, 0.03, V[:, 1])))

    extras = []
    for side, sz in (("L", 1.0), ("R", -1.0)):
        extras += eye((-0.052, 0.104, sz * 0.022), 0.0095, (-1.0, 0.15, sz * 0.25), f"eye_{side}", iris="#1a1210", pupil=None, iris_a=1.3, shine=0.32)
    # A small smile across its face.
    smile = [on_surface(body, (0, 0.046, 0), (-1.0, -0.18 - 0.10 * (1 - (z / 0.018) ** 2), z / 0.05), lift=0.0008) for z in np.linspace(-0.018, 0.018, 9)]
    extras.append(tube(smile, 0.0011, "#5a1f12", "spine", seg=4))
    return Pet("barnacle", bones, [body], extras, paint, step=0.0024, blend=0.006, edge=0.002,
               meta={"rig": "quad", "rump": 0.031, "mouth": [-0.085, 0.044, 0], "back": 0.085, "top": 0.115, "length": 0.28})


# ── the mounts ───────────────────────────────────────────────────────────
# Ridden by the companion (web/src/models/toys/mounts.js), who sits astride
# with their hips over `seat` (the riding clips: the pelvis rests about
# 0.11 m under the hips bone, the knees 0.25 m ahead and to the sides). All
# drawn small for their kind, a child's pony beside a real horse, so a rider
# stays in the shot; proportions by eye.

def _legs(body, fl, hl, col, hoof, r_up, r_lo, thigh, foot, paint_tag="leg"):
    """Four straight, hoofed legs: `r_up` / `r_lo` the (top, bottom) radii
    of the upper and lower leg, `thigh` the haunch's radii, `foot` the
    hoof's."""
    P = Part
    for side, s in sides():
        a, b, c = [(s * p[0], p[1], p[2]) for p in fl]
        h, k, f = [(s * p[0], p[1], p[2]) for p in hl]
        body += [
            P(limb((a[0], a[1] + r_up[0] * 0.8, a[2]), b, r_up[0], r_up[1]), f"fl_upper_{side}", col, r_up[0] * 0.7, tag=paint_tag),
            P(limb(b, (c[0], c[1] + foot[1], c[2]), r_lo[0], r_lo[1]), f"fl_lower_{side}", col, r_lo[0] * 0.4, tag=paint_tag),
            P(egg((c[0], foot[1] * 0.95, c[2] + foot[2] * 0.2), foot), f"fl_paw_{side}", hoof, r_lo[1] * 0.25, tag="hoof"),
            P(egg((h[0], h[1] - thigh[1] * 0.1, h[2]), thigh), f"hl_upper_{side}", col, thigh[0] * 0.6, tag=paint_tag),
            P(limb(h, k, thigh[0] * 0.7, r_lo[0] * 1.15), f"hl_upper_{side}", col, r_lo[0] * 0.6, tag=paint_tag),
            P(limb(k, (f[0], f[1] + foot[1], f[2]), r_lo[0] * 1.05, r_lo[1]), f"hl_lower_{side}", col, r_lo[0] * 0.5, tag=paint_tag),
            P(egg((f[0], foot[1] * 0.95, f[2] + foot[2] * 0.2), foot), f"hl_paw_{side}", hoof, r_lo[1] * 0.25, tag="hoof"),
        ]


def _cloth(V, N, C, tag, z0, half, top, drop, main, trim, stripes=None):
    """A saddle cloth painted over the back: `half` its half length round
    z0, from the spine `drop` metres down each side (the back's top at
    `top`); edged in `trim`, striped along its length if `stripes`."""
    y, z = V[:, 1], V[:, 2]
    trunk = np.clip(tag("spine") + tag("hips") + tag("chest") + tag("hump"), 0, 1)
    inside = (1 - sstep(half - 0.012, half, np.abs(z - z0))) * sstep(top - drop, top - drop + 0.012, y) * trunk
    C = tint(C, rgb(main), inside)
    if stripes:
        C = tint(C, rgb(stripes), inside * sstep(0.55, 0.8, np.sin((z - z0) * 62.0)))
    edge = inside * np.clip(sstep(half - 0.05, half - 0.035, np.abs(z - z0)) + (1 - sstep(top - drop + 0.035, top - drop + 0.05, y)), 0, 1)
    return tint(C, rgb(trim), edge)


def horse():
    """A chestnut pony with a flaxen mane and tail, a white blaze and
    socks, saddled: 1.2 m at the withers (a Welsh mountain pony's height)."""
    coat, mane, white, hoof, leather = "#b8733d", "#f1dfb6", "#fbf6ea", "#3b2c24", "#6f4326"
    fl = ((0.150, 0.800, 0.360), (0.150, 0.430, 0.345), (0.150, 0.060, 0.365))
    hl = ((0.170, 0.820, -0.440), (0.176, 0.450, -0.385), (0.170, 0.060, -0.455))
    tail = [(0, 1.110, -0.715), (0, 0.860, -0.830), (0, 0.560, -0.850)]
    bones = quad_bones((0, 1.050, -0.420), (0, 1.060, -0.050), (0, 1.040, 0.350), (0, 1.200, 0.500), (0, 1.540, 0.715),
                       (0.105, 1.535, 0.800), fl, hl, ears=(0.072, 1.650, 0.660), tail=tail)
    P = Part
    body = [
        P(egg((0, 1.000, -0.420), (0.245, 0.265, 0.300)), "hips", coat, 0.0),
        P(egg((0, 0.975, -0.020), (0.250, 0.265, 0.400)), "spine", coat, 0.12),
        P(egg((0, 0.990, 0.350), (0.235, 0.285, 0.280)), "chest", coat, 0.12),
        P(limb((0, 1.090, 0.440), (0, 1.490, 0.690), 0.175, 0.125), "neck", coat, 0.09),
        P(limb((0, 1.555, 0.700), (0, 1.385, 0.960), 0.118, 0.080), "head", coat, 0.05),
        P(ball((0.062, 1.495, 0.745), 0.092), "head", coat, 0.05, tag="cheek"),
        P(ball((-0.062, 1.495, 0.745), 0.092), "head", coat, 0.05, tag="cheek"),
        P(egg((0, 1.362, 0.990), (0.078, 0.068, 0.078)), "head", "#8a5a36", 0.03, tag="muzzle"),
        # The mane down the crest of the neck, and a forelock.
        P(squash(limb((0, 1.690, 0.600), (0, 1.520, 0.470), 0.085, 0.085), (0, 1.6, 0.53), (0.42, 1, 1)), "neck", mane, 0.02, tag="mane"),
        P(squash(limb((0, 1.520, 0.470), (0, 1.300, 0.345), 0.085, 0.080), (0, 1.4, 0.4), (0.42, 1, 1)), "neck", mane, 0.03, tag="mane"),
        P(squash(limb((0, 1.300, 0.345), (0, 1.180, 0.260), 0.080, 0.050), (0, 1.24, 0.3), (0.42, 1, 1)), "chest", mane, 0.03, tag="mane"),
        P(egg((0, 1.640, 0.745), (0.052, 0.066, 0.055)), "head", mane, 0.02, tag="mane"),
        # The saddle: its seat, the pommel and the cantle.
        P(egg((0, 1.238, -0.040), (0.150, 0.042, 0.200)), "spine", leather, 0.012, tag="saddle"),
        P(ball((0, 1.262, 0.135), 0.052), "spine", leather, 0.02, tag="saddle"),
        P(egg((0, 1.268, -0.215), (0.125, 0.052, 0.042)), "spine", leather, 0.02, tag="saddle"),
    ]
    for side, s in sides():
        ear = squash(limb((s * 0.072, 1.650, 0.662), (s * 0.090, 1.790, 0.650), 0.052, 0.012), (s * 0.08, 1.72, 0.656), (1, 1, 0.6))
        body.append(P(ear, f"ear_{side}", coat, 0.02, tag="ear"))
    _legs(body, fl, hl, coat, hoof, (0.105, 0.066), (0.060, 0.054), (0.135, 0.245, 0.175), (0.072, 0.052, 0.088))
    pts = tail + [(0, 0.330, -0.830)]
    for i, (ra, rb) in enumerate(((0.065, 0.090), (0.090, 0.085), (0.085, 0.035))):
        body.append(P(limb(pts[i], pts[i + 1], ra, rb), f"tail{i + 1}", mane, 0.05 if i == 0 else 0.02, tag="tail"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        plain = 1 - np.clip(tag("mane") + tag("saddle") + tag("tail") + tag("hoof"), 0, 1)
        # A white blaze down the face; socks on three legs; a paler belly.
        blaze = (tag("head") + tag("muzzle")) * (1 - sstep(0.022, 0.04, np.abs(x))) * sstep(0.30, 0.55, N[:, 2] + N[:, 1] * 0.6)
        sock = tag("leg") * (1 - sstep(0.26, 0.31, y)) * (1 - sstep(-0.1, 0.0, x) * sstep(0.0, 0.1, z))
        C = tint(C, rgb(white), np.clip(blaze + sock, 0, 1) * plain)
        C = tint(C, rgb("#c98a52"), sstep(0.5, 0.9, -N[:, 1]) * tag("spine") * plain * 0.6)
        # The saddle cloth and its girth.
        C = _cloth(V, N, C, tag, -0.04, 0.27, 1.24, 0.30, "#b8322b", "#e8c25a")
        girth = (1 - sstep(0.028, 0.036, np.abs(z - 0.02))) * tag("spine") * (1 - sstep(0.93, 0.95, y))
        C = tint(C, rgb(leather), girth)
        inner = tag("ear") * sstep(0.2, 0.6, N[:, 2]) * sstep(1.68, 1.70, y) * (1 - sstep(1.755, 1.775, y))
        return tint(C, rgb("#e3b08a"), inner * 0.8)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.106, 1.535, 0.802), (0.030, 0.034, 0.030), (s * 0.90, 0.05, 0.42), f"eye_{side}", iris="#3a2414", pupil=None,
                      iris_a=1.3, shine=0.26)
        # Nostrils, and the line of the mouth.
        gv, gn, gf, _ = sphere_mesh((s * 0.036, 1.375, 1.060), (0.012, 0.016, 0.008), 10, 8)
        extras.append(Extra(gv, gn, gf, "#3a2418", "head"))
        extras.append(tube([(0, 1.318, 1.050), (s * 0.045, 1.316, 1.030), (s * 0.074, 1.330, 0.985)], 0.004, "#3a2418", "head", seg=4))
    return Pet("horse", bones, [body], extras, paint, step=0.014, blend=0.04, edge=0.012,
               meta={"rig": "quad", "mouth": [0, 1.33, 1.07], "back": 1.28, "top": 1.8, "length": 1.9, "seat": [0, 1.278, -0.04], "halfWidth": 0.25})


def bull():
    """A dark bull with a ring in his nose, broad horns and a woven
    blanket: 1.2 m at the shoulder, about a small breed's (a Dexter bull)."""
    coat, pale, horn, hoof = "#4a342b", "#d8b48c", "#efe6cf", "#241a16"
    fl = ((0.195, 0.730, 0.380), (0.195, 0.390, 0.370), (0.195, 0.060, 0.390))
    hl = ((0.205, 0.750, -0.470), (0.210, 0.410, -0.415), (0.205, 0.060, -0.480))
    tail = [(0, 1.120, -0.770), (0, 0.800, -0.835), (0, 0.520, -0.835)]
    bones = quad_bones((0, 1.020, -0.450), (0, 1.060, -0.050), (0, 1.080, 0.380), (0, 1.110, 0.600), (0, 1.030, 0.840),
                       (0.150, 1.075, 0.985), fl, hl, ears=(0.215, 1.070, 0.830), tail=tail)
    P = Part
    body = [
        P(egg((0, 0.980, -0.450), (0.300, 0.300, 0.320)), "hips", coat, 0.0),
        P(egg((0, 0.980, -0.020), (0.330, 0.330, 0.420)), "spine", coat, 0.14),
        P(egg((0, 1.030, 0.380), (0.320, 0.370, 0.320)), "chest", coat, 0.14),
        P(ball((0, 1.330, 0.300), 0.165), "chest", coat, 0.12, tag="hump"),
        P(limb((0, 1.120, 0.540), (0, 1.060, 0.790), 0.250, 0.195), "neck", coat, 0.10),
        P(egg((0, 1.010, 0.900), (0.175, 0.195, 0.200)), "head", coat, 0.06),
        P(egg((0, 0.905, 1.055), (0.122, 0.102, 0.102)), "head", pale, 0.04, tag="muzzle"),
        P(egg((0, 1.312, -0.050), (0.215, 0.040, 0.225)), "spine", "#7a2f2a", 0.012, tag="saddle"),
    ]
    for side, s in sides():
        body += [
            P(limb((s * 0.150, 1.140, 0.860), (s * 0.340, 1.200, 0.860), 0.052, 0.042), "head", horn, 0.02, tag="horn"),
            P(limb((s * 0.340, 1.200, 0.860), (s * 0.425, 1.370, 0.900), 0.042, 0.010), "head", horn, 0.012, tag="horn"),
            P(egg((s * 0.290, 1.060, 0.820), (0.105, 0.055, 0.032), rot=(0, s * 20, -s * 15)), f"ear_{side}", coat, 0.03, tag="ear"),
        ]
    _legs(body, fl, hl, coat, hoof, (0.125, 0.085), (0.078, 0.072), (0.165, 0.250, 0.190), (0.090, 0.055, 0.100))
    pts = tail + [(0, 0.360, -0.820)]
    for i in range(3):
        body.append(P(limb(pts[i], pts[i + 1], 0.038 - i * 0.004, 0.034 - i * 0.004), f"tail{i + 1}", coat, 0.03 if i == 0 else 0.01, tag="tail"))
    body.append(P(egg((0, 0.385, -0.822), (0.062, 0.085, 0.062)), "tail3", "#1c1411", 0.02, tag="tuft"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        plain = 1 - np.clip(tag("saddle") + tag("horn") + tag("hoof") + tag("tuft") + tag("muzzle"), 0, 1)
        # Paler round the eyes and down the brisket; a curl of darker hair
        # on the forehead; dark tips to the horns.
        d = np.sqrt((np.abs(x) - 0.150) ** 2 + (y - 1.075) ** 2 + ((z - 0.99) * 0.7) ** 2)
        C = tint(C, rgb("#6b4a3a"), (1 - sstep(0.045, 0.075, d)) * tag("head") * plain)
        C = tint(C, rgb("#33231d"), sstep(0.3, 0.8, wobble(V, 9, 2)) * 0.5 * plain * (1 - tag("leg")))
        C = tint(C, rgb("#5a4035"), sstep(0.5, 0.9, -N[:, 1]) * (tag("spine") + tag("chest")) * plain * 0.7)
        C = tint(C, rgb("#3a2a22"), tag("horn") * sstep(1.30, 1.36, y))
        C = _cloth(V, N, C, tag, -0.05, 0.30, 1.31, 0.34, "#2f6f8f", "#f0d27a", stripes="#c8452f")
        inner = tag("ear") * sstep(0.2, 0.6, N[:, 2])
        return tint(C, rgb("#c9a183"), inner * 0.8)

    extras = []
    for side, s in sides():
        extras += eye((s * 0.150, 1.075, 0.987), (0.032, 0.034, 0.026), (s * 0.62, 0.08, 0.78), f"eye_{side}", iris="#2a1a12", pupil=None,
                      iris_a=1.3, shine=0.26, lid=("#3a2a22", 0.55))
        gv, gn, gf, _ = sphere_mesh((s * 0.052, 0.925, 1.148), (0.017, 0.020, 0.010), 10, 8)
        extras.append(Extra(gv, gn, gf, "#3a2a22", "head"))
    # The ring through his nose.
    ring = [(0.045 * math.sin(a), 0.855 - 0.045 * math.cos(a) + 0.045, 1.150) for a in np.linspace(0.5, 2 * math.pi - 0.5, 15)]
    extras.append(tube(ring, 0.007, "#e8c25a", "head", seg=6))
    return Pet("bull", bones, [body], extras, paint, step=0.016, blend=0.045, edge=0.013,
               meta={"rig": "quad", "mouth": [0, 0.87, 1.16], "back": 1.33, "top": 1.5, "length": 2.0, "seat": [0, 1.352, -0.05], "halfWidth": 0.33,
                     "wide": True})


def camel():
    """A dromedary under a striped saddle cloth, sat on the hump: 1.45 m at
    the shoulder (a real one is 1.8 to 2 m), long in the leg and neck."""
    sand, dark, pale, pad = "#d6ac68", "#b88a4b", "#ecd3a0", "#8a6a45"
    fl = ((0.150, 1.020, 0.420), (0.150, 0.560, 0.400), (0.150, 0.060, 0.420))
    hl = ((0.160, 1.040, -0.520), (0.166, 0.590, -0.445), (0.160, 0.060, -0.525))
    tail = [(0, 1.350, -0.790), (0, 1.050, -0.865)]
    bones = quad_bones((0, 1.300, -0.500), (0, 1.340, -0.050), (0, 1.290, 0.410), (0, 1.330, 0.560), (0, 1.990, 0.900),
                       (0.088, 2.035, 0.985), fl, hl, ears=(0.075, 2.085, 0.880), tail=tail)
    P = Part
    body = [
        P(egg((0, 1.270, -0.500), (0.240, 0.270, 0.300)), "hips", sand, 0.0),
        P(egg((0, 1.270, -0.030), (0.260, 0.290, 0.420)), "spine", sand, 0.12),
        P(egg((0, 1.250, 0.400), (0.230, 0.280, 0.260)), "chest", sand, 0.12),
        P(egg((0, 1.600, -0.060), (0.205, 0.250, 0.310)), "spine", dark, 0.10, tag="hump"),
        # The neck: down and forward from the chest, then up.
        P(limb((0, 1.270, 0.500), (0, 1.480, 0.850), 0.165, 0.125), "neck", sand, 0.08),
        P(limb((0, 1.480, 0.850), (0, 1.960, 0.900), 0.125, 0.100), "neck", sand, 0.06),
        P(limb((0, 2.010, 0.895), (0, 1.950, 1.150), 0.102, 0.072), "head", sand, 0.05),
        P(egg((0, 1.925, 1.190), (0.072, 0.066, 0.072)), "head", pale, 0.03, tag="muzzle"),
        P(egg((0, 2.110, 0.900), (0.060, 0.045, 0.070)), "head", dark, 0.03, tag="tuft"),
        P(egg((0, 1.852, -0.060), (0.180, 0.040, 0.220)), "spine", "#6f4326", 0.012, tag="saddle"),
        P(ball((0, 1.885, 0.140), 0.050), "spine", "#6f4326", 0.02, tag="saddle"),
    ]
    for side, s in sides():
        body.append(P(egg((s * 0.085, 2.085, 0.880), (0.034, 0.045, 0.022), rot=(0, 0, -s * 25)), f"ear_{side}", sand, 0.015, tag="ear"))
    _legs(body, fl, hl, sand, pad, (0.090, 0.056), (0.050, 0.045), (0.125, 0.250, 0.165), (0.076, 0.045, 0.092))
    body.append(P(limb(tail[0], tail[1], 0.036, 0.030), "tail1", sand, 0.03, tag="tail"))
    body.append(P(egg((0, 0.960, -0.875), (0.045, 0.085, 0.045)), "tail2", dark, 0.02, tag="tuft"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        plain = 1 - np.clip(tag("saddle") + tag("hoof") + tag("tuft") + tag("muzzle"), 0, 1)
        C = tint(C, rgb(pale), sstep(0.45, 0.9, -N[:, 1]) * (tag("spine") + tag("chest") + tag("hips")) * plain * 0.8)
        C = tint(C, rgb(dark), tag("leg") * sstep(0.52, 0.6, y) * (1 - sstep(0.62, 0.7, y)) * 0.6)
        # The cloth over the hump, striped, with a fringe of tassels.
        C = _cloth(V, N, C, tag, -0.06, 0.29, 1.85, 0.36, "#c8452f", "#f0d27a", stripes="#2f6f8f")
        return C

    extras = []
    for side, s in sides():
        extras += eye((s * 0.088, 2.035, 0.987), (0.027, 0.028, 0.024), (s * 0.85, 0.05, 0.52), f"eye_{side}", iris="#2a1a12", pupil=None,
                      iris_a=1.3, shine=0.26, lid=(sand, 0.3))
        gv, gn, gf, _ = sphere_mesh((s * 0.030, 1.945, 1.253), (0.010, 0.014, 0.007), 10, 8)
        extras.append(Extra(gv, gn, gf, "#6a4a30", "head"))
        extras.append(tube([(0, 1.890, 1.250), (s * 0.040, 1.888, 1.232), (s * 0.068, 1.902, 1.190)], 0.004, "#6a4a30", "head", seg=4))
    return Pet("camel", bones, [body], extras, paint, step=0.015, blend=0.04, edge=0.012,
               meta={"rig": "quad", "mouth": [0, 1.9, 1.26], "back": 1.89, "top": 2.15, "length": 2.2, "seat": [0, 1.892, -0.06], "halfWidth": 0.24})


def elephant():
    """A young elephant in a howdah cloth, ridden on its neck as a mahout
    does: 1.55 m at the shoulder (a grown Asian elephant is 2.4 to 3 m)."""
    grey, pale, ivory, nail = "#9aa5b1", "#b9c2cc", "#f4ecd8", "#e6dcc6"
    fl = ((0.260, 0.860, 0.420), (0.260, 0.470, 0.420), (0.260, 0.070, 0.430))
    hl = ((0.270, 0.860, -0.560), (0.276, 0.480, -0.520), (0.270, 0.070, -0.560))
    tail = [(0, 1.360, -0.940), (0, 1.000, -1.000), (0, 0.740, -1.000)]
    trunk = [(0, 1.380, 1.220), (0, 1.090, 1.340), (0, 0.810, 1.380), (0, 0.570, 1.340)]
    extra = {}
    prev = "head"
    for i, p in enumerate(trunk):
        extra[f"trunk{i + 1}"] = (prev, p)
        prev = f"trunk{i + 1}"
    bones = quad_bones((0, 1.300, -0.550), (0, 1.380, -0.080), (0, 1.400, 0.420), (0, 1.440, 0.640), (0, 1.500, 0.880),
                       (0.225, 1.570, 1.150), fl, hl, ears=(0.285, 1.560, 0.850), tail=tail, extra=extra)
    P = Part
    body = [
        P(egg((0, 1.220, -0.550), (0.400, 0.420, 0.400)), "hips", grey, 0.0),
        P(egg((0, 1.220, -0.050), (0.440, 0.460, 0.500)), "spine", grey, 0.16),
        P(egg((0, 1.240, 0.420), (0.420, 0.460, 0.380)), "chest", grey, 0.16),
        P(limb((0, 1.380, 0.580), (0, 1.480, 0.830), 0.345, 0.305), "neck", grey, 0.12),
        P(egg((0, 1.520, 0.980), (0.300, 0.330, 0.300)), "head", grey, 0.08),
        P(ball((0.125, 1.780, 0.950), 0.145), "head", grey, 0.08, tag="dome"),
        P(ball((-0.125, 1.780, 0.950), 0.145), "head", grey, 0.08, tag="dome"),
        P(egg((0, 1.702, 0.300), (0.270, 0.045, 0.260)), "chest", "#7a2f5a", 0.012, tag="saddle"),
    ]
    pts = trunk + [(0, 0.430, 1.240)]
    for i, (ra, rb) in enumerate(((0.135, 0.112), (0.112, 0.092), (0.092, 0.076), (0.076, 0.058))):
        body.append(P(limb(pts[i], pts[i + 1], ra, rb), f"trunk{i + 1}", grey, 0.08 if i == 0 else 0.025, tag="trunk"))
    for side, s in sides():
        body += [
            P(limb((s * 0.140, 1.300, 1.160), (s * 0.205, 1.100, 1.370), 0.042, 0.014), "head", ivory, 0.012, tag="tusk"),
            P(egg((s * 0.455, 1.500, 0.810), (0.270, 0.310, 0.040), rot=(0, s * 28, 0)), f"ear_{side}", grey, 0.05, tag="ear"),
        ]
    _legs(body, fl, hl, grey, grey, (0.180, 0.155), (0.152, 0.150), (0.215, 0.300, 0.230), (0.165, 0.072, 0.172))
    tp = tail + [(0, 0.640, -0.990)]
    for i in range(3):
        body.append(P(limb(tp[i], tp[i + 1], 0.040 - i * 0.006, 0.034 - i * 0.006), f"tail{i + 1}", grey, 0.04 if i == 0 else 0.01, tag="tail"))
    body.append(P(egg((0, 0.640, -0.990), (0.045, 0.075, 0.045)), "tail3", "#59616b", 0.02, tag="tuft"))

    def paint(V, N, C, tag):
        x, y, z = V[:, 0], V[:, 1], V[:, 2]
        plain = 1 - np.clip(tag("saddle") + tag("tusk") + tag("tuft"), 0, 1)
        C = tint(C, rgb(pale), sstep(0.4, 0.9, -N[:, 1]) * (tag("spine") + tag("chest") + tag("hips")) * plain * 0.8)
        # Wrinkles round the trunk; toenails; the ears' pink insides.
        C = tint(C, rgb("#828d99"), tag("trunk") * sstep(0.7, 0.95, np.sin(y * 95.0)) * 0.7)
        toes = tag("hoof") * sstep(0.3, 0.7, N[:, 2]) * (1 - sstep(0.075, 0.095, y)) * sstep(0.45, 0.8, np.cos(x * 78.0))
        C = tint(C, rgb(nail), toes)
        inner = tag("ear") * sstep(0.15, 0.6, N[:, 2]) * (1 - sstep(0.22, 0.27, np.sqrt((np.abs(x) - 0.47) ** 2 * 1.2 + (y - 1.49) ** 2)))
        C = tint(C, rgb("#e3aeb4"), inner * 0.75 * plain)
        # The cloth over the back, from the neck to the rump.
        C = _cloth(V, N, C, tag, 0.02, 0.50, 1.70, 0.50, "#a3324f", "#f0d27a", stripes=None)
        y2 = (1 - sstep(0.035, 0.05, np.abs(np.abs(z - 0.02) - 0.25))) * sstep(1.26, 1.3, y) * np.clip(tag("spine") + tag("chest") + tag("hips"), 0, 1)
        return tint(C, rgb("#f0d27a"), y2 * (1 - tag("saddle")))

    extras = []
    for side, s in sides():
        extras += eye((s * 0.226, 1.570, 1.152), (0.030, 0.033, 0.026), (s * 0.70, 0.05, 0.71), f"eye_{side}", iris="#2a1a12", pupil=None,
                      iris_a=1.3, shine=0.28, lid=(grey, 0.4))
    return Pet("elephant", bones, [body], extras, paint, step=0.02, blend=0.05, edge=0.014,
               meta={"rig": "quad", "mouth": [0, 1.25, 1.2], "back": 1.72, "top": 1.95, "length": 2.5, "seat": [0, 1.745, 0.30], "halfWidth": 0.42,
                     "wide": True, "seatBone": "chest"})


PETS = {"evie": evie, "gerald": gerald, "pip": pip, "basil": basil, "scupper": scupper, "biscuit": biscuit, "encore": encore,
        "barnacle": barnacle, "horse": horse, "bull": bull, "camel": camel, "elephant": elephant}


def main(argv):
    opts = {}
    want = []
    it = iter(argv)
    for a in it:
        if a in ("--step", "--out"):
            opts[a] = next(it)
        else:
            want.append(a)
    step = float(opts["--step"]) if "--step" in opts else None
    out = opts.get("--out", OUT_DIR)
    ids = list(PETS) if not want or "all" in want else want
    os.makedirs(out, exist_ok=True)
    for pid in ids:
        pet = PETS[pid]()
        prims = build(pet, step)
        path = os.path.join(out, f"{pid}.glb")
        write_glb(pet, prims, path)
        nv = sum(len(p[1]) for p in prims)
        nf = sum(len(p[4]) for p in prims)
        print(f"{pid}: {nv} vertices, {nf} triangles, {os.path.getsize(path) / 1024:.0f} KB -> {path}")


if __name__ == "__main__":
    main(sys.argv[1:])


