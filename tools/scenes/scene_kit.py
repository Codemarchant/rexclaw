"""What the scene build scripts share (build_eves_room.py,
build_aras_cafe.py, build_sals_hut.py, build_rexs_cabin.py): materials, meshes gathered one per material and moving
part, the shapes things are built from, a room's furnishings, the
navigation mesh, the animation loop and the GLB export. Runs inside Blender.

    import scene_kit as kit
    from scene_kit import *
    kit.init('room', out_dir, tex_dir)

Blender coords: Z up, the floor at z=0, the companion's spawn at the origin
facing -Y (the app's default camera sits at -Y looking +Y). The glTF export
turns this into three.js Y-up with the camera on +Z.

What the app reads from a scene beyond its looks:
- its animations, all looped (every object here is keyed over one loop of
  LOOP seconds, so they stay in step);
- the node whose name ends "-navmesh": where feet may go;
- nothing else: lights come from the app, so anything that must read in
  the dark carries its own glow (emissive, never above 1 — there is no tone
  mapping to catch more).
"""
import bpy, bmesh, json, math, os, random, time
from mathutils import Vector, Matrix

T0 = time.time()
TAG = 'scene'
OUT = ''
TEX = ''
FPS = 12
LOOP = 36.0
M = {}                # materials by key: M['oak'] = make_mat(...)
UVFIT = set()         # keys whose picture goes once across each box face
SPR = {}              # sprites.json: where each cut-out sits in its sheet
XF = [Matrix.Identity(4)]
PART = [None]
PIVOT = {}
MBS = {}
PARTS = {}            # the moving parts' empties, once finalise() has run
EXPORT = []
WHOLE = []            # objects built whole (those with shape keys)
_IMG = {}


def init(tag, out, tex, fps=12, loop=36.0, seed=1):
    global TAG, OUT, TEX, FPS, LOOP
    TAG, OUT, TEX, FPS, LOOP = tag, out, tex, fps, loop
    os.makedirs(OUT, exist_ok=True)
    random.seed(seed)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    p = os.path.join(TEX, 'sprites.json')
    if os.path.exists(p):
        SPR.update(json.load(open(p)))


def log(*a):
    print(f"[{TAG} {time.time() - T0:6.1f}s]", *a, flush=True)


# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
def srgb_to_lin(c):
    return tuple(((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c)


def one_sided(key):
    """The same material seen from its front only, as M[key + '_1s']."""
    if key + '_1s' not in M:
        m = M[key].copy()
        m.name = M[key].name + 'OneSided'
        m.use_backface_culling = True
        M[key + '_1s'] = m
    return key + '_1s'


def IMG(name, noncolor=False):
    if name not in _IMG:
        im = bpy.data.images.load(os.path.join(TEX, name + '.png'))
        if noncolor:
            im.colorspace_settings.name = 'Non-Color'
        im.pack()
        _IMG[name] = im
    return _IMG[name]


def make_mat(name, color=(0.8, 0.8, 0.8), img=None, nrm=None, rough=0.8, metal=0.0, spec=0.5,
             glow=0.0, glow_img=None, glow_color=None, alpha=None, single=False, lit=True):
    """glow: how brightly the surface shows with the lights off — its own
    picture (or glow_img / glow_color) as emission. alpha: 'MASK' cuts the
    picture out along its alpha, 'BLEND' fades with it. single: seen from
    its front only (a wall the camera may stand behind, a figure's face).
    lit=False: it shows by its glow alone, the same under any lights (what
    is out of doors at an hour of its own)."""
    m = bpy.data.materials.new(name)
    m.use_backface_culling = single
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*srgb_to_lin(color if lit else (0, 0, 0)), 1)
    bsdf.inputs['Roughness'].default_value = rough if lit else 1.0
    bsdf.inputs['Metallic'].default_value = metal
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec if lit else 0.0
    tex = None
    if img:
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = IMG(img)
        if lit and alpha != 'BLEND':
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if nrm:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = IMG(nrm, True)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if glow:
        if glow_img:
            g = nt.nodes.new('ShaderNodeTexImage'); g.image = IMG(glow_img)
            nt.links.new(g.outputs['Color'], bsdf.inputs['Emission Color'])
        elif tex and not glow_color:
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
        else:
            bsdf.inputs['Emission Color'].default_value = (*srgb_to_lin(glow_color or color), 1)
        bsdf.inputs['Emission Strength'].default_value = glow
    if alpha and tex:
        a = tex.outputs['Alpha']
        if alpha == 'MASK':
            rnd = nt.nodes.new('ShaderNodeMath'); rnd.operation = 'ROUND'
            nt.links.new(a, rnd.inputs[0])
            a = rnd.outputs[0]
        nt.links.new(a, bsdf.inputs['Alpha'])
        for attr, val in (('blend_method', 'CLIP' if alpha == 'MASK' else 'BLEND'),
                          ('surface_render_method', 'DITHERED' if alpha == 'MASK' else 'BLENDED')):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    return m


# ════════════════════════════════════════════════════════════════════════
# Mesh accumulation: one mesh per material — and per moving part
# ════════════════════════════════════════════════════════════════════════
class MB:
    def __init__(self):
        self.v = []; self.f = []; self.uv = []; self.sm = []

    def tx(self, p):
        return XF[-1] @ Vector(p)

    def face(self, pts, uvs, smooth=False):
        base = len(self.v)
        self.v.extend(self.tx(p) for p in pts)
        self.f.append(tuple(range(base, base + len(pts))))
        self.uv.append(list(uvs)); self.sm.append(smooth)

    def grid(self, P, UV, smooth=True):
        R = len(P); C = len(P[0]); base = len(self.v)
        for row in P:
            self.v.extend(self.tx(p) for p in row)
        for i in range(R - 1):
            for j in range(C - 1):
                a = base + i * C + j
                self.f.append((a, a + 1, a + C + 1, a + C))
                self.uv.append([UV[i][j], UV[i][j + 1], UV[i + 1][j + 1], UV[i + 1][j]])
                self.sm.append(smooth)


def mb(key):
    k = (PART[-1], key)
    if k not in MBS:
        MBS[k] = MB()
    return MBS[k]


class part:
    """with part('Ship', pivot): ... — geometry that moves as one, about its pivot."""
    def __init__(self, name, pivot):
        self.name = name; PIVOT[name] = XF[-1] @ Vector(pivot)

    def __enter__(self):
        PART.append(self.name)

    def __exit__(self, *a):
        PART.pop()


class place:
    """with place(pos, yaw): ... — things built in their own coords."""
    def __init__(self, pos=(0, 0, 0), yaw=0.0, scale=1.0):
        self.m = Matrix.Translation(Vector(pos)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)

    def __enter__(self):
        XF.append(XF[-1] @ self.m)

    def __exit__(self, *a):
        XF.pop()


def here(p):
    """A point given in the current place(), in world coords."""
    return XF[-1] @ Vector(p)


# ════════════════════════════════════════════════════════════════════════
# Shapes
# ════════════════════════════════════════════════════════════════════════
def box(key, c, size, R=None, grain=None, tile=2.0, skip=None):
    """skip: leave out the face that looks that way (the back of something
    hung on a one-sided wall, so it cannot be seen from behind the wall)."""
    m = mb(key)
    c = Vector(c)
    R = R if R is not None else Matrix.Identity(3)
    hs = [s / 2 for s in size]
    fit = key in UVFIT
    if grain is None:
        grain = 0 if fit else max(range(3), key=lambda k: size[k])
    off = (random.random() * tile, random.random() * tile)
    ax = [R.col[k] for k in range(3)]
    for k in range(3):
        for sgn in (-1, 1):
            if skip is not None and (ax[k] * sgn).dot(Vector(skip)) > 0.99:
                continue
            i, j = [a for a in range(3) if a != k]
            loc = []
            for si, sj in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                l = [0.0, 0.0, 0.0]; l[k] = sgn * hs[k]; l[i] = si * hs[i]; l[j] = sj * hs[j]
                loc.append(l)
            ua, va = (grain, (j if grain == i else i)) if grain in (i, j) else (i, j)
            pts = [c + ax[0] * l[0] + ax[1] * l[1] + ax[2] * l[2] for l in loc]
            if fit:
                uvs = [((l[ua] + hs[ua]) / size[ua], (l[va] + hs[va]) / size[va]) for l in loc]
            else:
                uvs = [((l[ua] + off[0]) / tile, (l[va] + off[1]) / tile) for l in loc]
            if (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(ax[k] * sgn) < 0:    # every face looks outward: a one-sided
                pts.reverse(); uvs.reverse()                                     # material would hide the ones that do not
            m.face(pts, uvs)


def basis_from(d, up=(0, 0, 1)):
    x = Vector(d).normalized(); u = Vector(up)
    if abs(x.dot(u)) > 0.99:
        u = Vector((1, 0, 0)) if abs(x.x) < 0.9 else Vector((0, 1, 0))
    y = u.cross(x).normalized(); z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def beam(key, p1, p2, w, h, up=(0, 0, 1), tile=2.0, skip=None):
    p1 = Vector(p1); p2 = Vector(p2)
    box(key, (p1 + p2) / 2, ((p2 - p1).length, w, h), basis_from(p2 - p1, up), grain=0, tile=tile, skip=skip)


def lathe(key, prof, base=(0, 0, 0), axis=(0, 0, 1), segs=16, tile=1.0, capb=False, capt=False, smooth=True):
    """A profile [(radius, height), ...] turned about an axis. A cap takes
    the whole picture, as a disc."""
    m = mb(key)
    base = Vector(base); ax = Vector(axis).normalized()
    e1 = ax.orthogonal().normalized(); e2 = ax.cross(e1)
    rmax = max(r for r, _ in prof) or 0.01
    P = []; UV = []; s = 0.0
    for idx, (r, h) in enumerate(prof):
        if idx:
            s += math.hypot(r - prof[idx - 1][0], h - prof[idx - 1][1])
        row = []; uvr = []
        for j in range(segs + 1):
            a = 2 * math.pi * j / segs
            row.append(base + ax * h + (e1 * math.cos(a) + e2 * math.sin(a)) * r)
            uvr.append((2 * math.pi * rmax * j / segs / tile, s / tile))
        P.append(row); UV.append(uvr)
    m.grid(P, UV, smooth)
    for cap, idx, bottom in ((capb, 0, True), (capt, len(prof) - 1, False)):
        if cap and prof[idx][0] > 1e-4:
            ring = P[idx][:segs]
            uvs = [(0.5 + 0.5 * math.cos(2 * math.pi * j / segs), 0.5 + 0.5 * math.sin(2 * math.pi * j / segs)) for j in range(segs)]
            if bottom:                                         # the bottom cap looks back along the axis, the top one along it
                ring = ring[::-1]; uvs = uvs[::-1]
            m.face(ring, uvs)


def tube(key, p1, p2, r1, r2=None, segs=8, caps=False, tile=1.0, smooth=True):
    p1 = Vector(p1); p2 = Vector(p2)
    L = (p2 - p1).length
    if L < 1e-6:
        return
    lathe(key, [(r1, 0), (r2 if r2 is not None else r1, L)], p1, p2 - p1, segs, tile, caps, caps, smooth)


def rope(key, pts, r, segs=5):
    for a, b in zip(pts[:-1], pts[1:]):
        tube(key, a, b, r, r, segs)


def sag(p1, p2, amount, n=10):
    p1 = Vector(p1); p2 = Vector(p2)
    return [p1.lerp(p2, t / n) - Vector((0, 0, amount * 4 * (t / n) * (1 - t / n))) for t in range(n + 1)]


def sphere(key, c, r, segs=10, rings=6, sz=1.0):
    prof = [(r * math.sin(math.pi * k / rings), -r * sz * math.cos(math.pi * k / rings)) for k in range(rings + 1)]
    lathe(key, prof, c, (0, 0, 1), segs)


def soft(key, c, size, n=4.0, segs=16, rings=8, tile=1.0, R=None):
    """Something stuffed: a box swollen toward a ball (a superellipsoid;
    n = 2 is the ball, the larger n the squarer). Its picture is laid on
    flat from whichever side each patch faces."""
    m = mb(key)
    c = Vector(c)
    R = R if R is not None else Matrix.Identity(3)
    e = 2.0 / n
    f = lambda v: math.copysign(abs(v) ** e, v)
    hs = [s / 2 for s in size]
    P = []
    for i in range(rings + 1):
        la = -math.pi / 2 + math.pi * i / rings
        P.append([Vector((hs[0] * f(math.cos(la)) * f(math.cos(2 * math.pi * j / segs)),
                          hs[1] * f(math.cos(la)) * f(math.sin(2 * math.pi * j / segs)),
                          hs[2] * f(math.sin(la)))) for j in range(segs + 1)])
    for i in range(rings):
        for j in range(segs):
            q = [P[i][j], P[i][j + 1], P[i + 1][j + 1], P[i + 1][j]]
            if i == 0:                                         # the poles: triangles
                q = [P[0][j], P[1][j + 1], P[1][j]]
            elif i == rings - 1:
                q = [P[i][j], P[i][j + 1], P[i + 1][j]]
            nrm = (q[1] - q[0]).cross(q[-1] - q[0])
            k = max(range(3), key=lambda a: abs(nrm[a]))
            a, b = [x for x in range(3) if x != k]
            m.face([c + R @ l for l in q], [(l[a] / tile, l[b] / tile) for l in q], True)


def ring(c, r, n=24):
    c = Vector(c)
    return [c + Vector((r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), 0)) for k in range(n + 1)]


def card(key, c, normal, w, h, up=(0, 0, 1), u0=0.0, u1=1.0, v0=0.0, v1=1.0):
    """A picture: a flat quad at c facing `normal`, read the right way up
    from that side."""
    c = Vector(c); n = Vector(normal).normalized(); up = Vector(up)
    r = (-n).cross(up).normalized()
    t = r.cross(-n).normalized()
    mb(key).face([c - r * w / 2 - t * h / 2, c + r * w / 2 - t * h / 2, c + r * w / 2 + t * h / 2, c - r * w / 2 + t * h / 2],
                 [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])


def sprite(sheet, idx, foot, normal, h, mirror=False, backs=False, centre=False, up=(0, 0, 1), key=None):
    """One cut-out from a sheet, h tall, standing on `foot` (or centred on
    it) and facing `normal`. backs: a shaded copy facing the other way, for
    a figure that is looked at from behind too. Returns its width."""
    s = SPR[sheet][idx]
    w = h * s['aspect']
    foot = Vector(foot); n = Vector(normal).normalized()
    c = foot if centre else foot + Vector(up).normalized() * h / 2
    u0, u1 = (s['u1'], s['u0']) if mirror else (s['u0'], s['u1'])
    card(key or sheet, c, n, w, h, up, u0=u0, u1=u1, v0=s['v0'], v1=s['v1'])
    if backs:
        card(sheet + '_back', c - n * 0.01, -n, w, h, up, u0=u1, u1=u0, v0=s['v0'], v1=s['v1'])
    return w


def crossed(sheet, idx, foot, h, yaw=0.0):
    """A cut-out stood up as two cards at right angles: a plant, seen from
    any side."""
    for a in (yaw, yaw + math.pi / 2):
        sprite(sheet, idx, foot, (math.sin(a), -math.cos(a), 0), h)


def halo(key, c, size):
    """A light's glow, seen from any side: three crossed cards."""
    for n, up in (((0, 1, 0), (0, 0, 1)), ((1, 0, 0), (0, 0, 1)), ((0, 0, 1), (0, 1, 0))):
        card(key, c, n, size, size, up)


def poly(key, pts, tile, axes, facing=None):
    """A flat polygon mapped by its world coordinates (two of x, y, z).
    facing: the side it must be seen from, if its material is one-sided."""
    pts = [Vector(p) for p in pts]
    if facing is not None and (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(Vector(facing)) < 0:
        pts.reverse()
    a, b = axes
    mb(key).face(pts, [(p[a] / tile, p[b] / tile) for p in pts])


def floor(key, x0, x1, y0, y1, z, tile=4.0, facing=(0, 0, 1)):
    poly(key, [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], tile, (0, 1), facing)


def wall_y(key, x0, x1, z0, z1, y, tile=2.0, facing=(0, -1, 0)):
    poly(key, [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], tile, (0, 2), facing)


def wall_x(key, y0, y1, z0, z1, x, tile=2.0, facing=(1, 0, 0)):
    poly(key, [(x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1)], tile, (1, 2), facing)


def ribbon(key, A, B, U, v0=0.0, v1=1.0, smooth=True):
    """A band between two lines of points."""
    mb(key).grid([A, B], [[(u, v0) for u in U], [(u, v1) for u in U]], smooth)


def drape(key, x0, x1, y, z0, z1, pleats, amp, tile=1.0, bottom=None, folds=False):
    """A pleated hanging in the plane y. bottom(x) → its lower edge, if not
    straight. folds: its picture is one painted fold (paint_kit.cloth_folds),
    laid once across each pleat and every two metres down."""
    nu = max(8, int(pleats * 8)); nv = 6
    P = []; UV = []
    for j in range(nv + 1):
        row = []; uvr = []
        for i in range(nu + 1):
            u = i / nu
            x = x0 + (x1 - x0) * u
            zb = bottom(x) if bottom else z0
            z = zb + (z1 - zb) * j / nv
            row.append(Vector((x, y + amp * math.sin(u * pleats * 2 * math.pi), z)))
            uvr.append((u * pleats, z / 2.0) if folds else (u * abs(x1 - x0) * 1.6 / tile, z / tile))
        P.append(row); UV.append(uvr)
    mb(key).grid(P, UV)


def whole(name, key, verts, faces, uvs, shapes=None, smooth=True):
    """An object of its own, for what moves by changing shape. uvs: one per
    vertex. shapes: {name: [positions]} — shape keys, each a slider that
    runs -1 … 1."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in verts], [], faces)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', [c for f in faces for i in f for c in uvs[i]])
    me.polygons.foreach_set('use_smooth', [smooth] * len(faces))
    me.materials.append(M[key])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if shapes:
        ob.shape_key_add(name='Basis')
        for kname, pos in shapes.items():
            sk = ob.shape_key_add(name=kname)
            sk.slider_min = -1.0
            for i, p in enumerate(pos):
                sk.data[i].co = p
    WHOLE.append(ob)
    return ob


# ════════════════════════════════════════════════════════════════════════
# Furnishings: what a room is filled with. They name the materials they
# use (oak, brass, spines, shade, glow, glow_soft, bulb, wire, steam,
# coffee, the pictures / plants sheets), so a scene makes those first.
# ════════════════════════════════════════════════════════════════════════
def wood(c, size, key='oak', R=None, tile=0.9):
    box(key, c, size, R, tile=tile)


def pierced_x(key, y0, y1, z0, z1, x, holes=(), tile=2.0, facing=(1, 0, 0)):
    """A wall in the plane x, less rectangular holes (y0, y1, z0, z1)."""
    ys = sorted({y0, y1} | {v for h in holes for v in h[:2] if y0 < v < y1})
    for ya, yb in zip(ys[:-1], ys[1:]):
        z = z0
        for lo, hi in sorted((h[2], h[3]) for h in holes if h[0] <= ya and h[1] >= yb) + [(z1, z1)]:
            if lo > z + 1e-6:
                wall_x(key, ya, yb, z, lo, x, tile, facing)
            z = max(z, hi)


def pierced_y(key, x0, x1, z0, z1, y, holes=(), tile=2.0, facing=(0, -1, 0)):
    """A wall in the plane y, less rectangular holes (x0, x1, z0, z1)."""
    xs = sorted({x0, x1} | {v for h in holes for v in h[:2] if x0 < v < x1})
    for xa, xb in zip(xs[:-1], xs[1:]):
        z = z0
        for lo, hi in sorted((h[2], h[3]) for h in holes if h[0] <= xa and h[1] >= xb) + [(z1, z1)]:
            if lo > z + 1e-6:
                wall_y(key, xa, xb, z, lo, y, tile, facing)
            z = max(z, hi)


def frame(idx, c, normal, w, key='oak', sheet='pictures', border=0.035, depth=0.03):
    """A framed picture from the pictures sheet (or (material, aspect)), w
    wide, its middle at c on a wall that faces `normal`. It has no back and
    is one-sided, like the wall it hangs on: a camera behind that wall
    looks straight through both. Returns its height."""
    s = SPR[sheet][idx] if isinstance(idx, int) else None
    h = w / s['aspect'] if s else w / idx[1]
    c = Vector(c); n = Vector(normal).normalized(); up = Vector((0, 0, 1))
    r = (-n).cross(up).normalized()
    R = Matrix((r, n, up)).transposed()
    mid = c + n * depth / 2
    for sx, sz, size in ((0, 1, (w + 2 * border, depth, border)), (0, -1, (w + 2 * border, depth, border)),
                         (1, 0, (border, depth, h)), (-1, 0, (border, depth, h))):
        box(one_sided(key), mid + r * sx * (w + border) / 2 + up * sz * (h + border) / 2, size, R, tile=0.6, skip=-n)
    if s:
        card(sheet, c + n * 0.014, n, w, h, u0=s['u0'], u1=s['u1'], v0=s['v0'], v1=s['v1'])
    else:
        card(one_sided(idx[0]), c + n * 0.014, n, w, h)
    return h


def standing(idx, foot, normal, w, key='brass', sheet='pictures'):
    """A framed photograph standing on a shelf or table."""
    h = w / SPR[sheet][idx]['aspect']
    n = Vector(normal).normalized()
    c = Vector(foot) + Vector((0, 0, h / 2 + 0.025))
    frame(idx, c, n, w, key, sheet, border=0.022, depth=0.02)
    r = (-n).cross(Vector((0, 0, 1))).normalized()
    box(key, c - n * 0.003, (w + 0.044, 0.006, h + 0.044), Matrix((r, n, Vector((0, 0, 1)))).transposed())       # its back
    beam(key, c - n * 0.004 + Vector((0, 0, h * 0.2)), Vector(foot) - n * 0.09, 0.03, 0.008)


SPINES = 28           # the spines picture: that many book spines side by side in its first 7/8, page edge in the rest
_EDGE = [(0.90, 0.1), (0.98, 0.1), (0.98, 0.9), (0.90, 0.9)]


def book(c, along, out, t, h, d, col):
    """One book standing: c the middle of its foot, t thick along `along`,
    d deep back from its spine, which faces `out`; col picks its spine."""
    a = Vector(along).normalized(); o = Vector(out).normalized(); up = Vector((0, 0, 1))
    cu = (col + 0.08) / SPINES * 7 / 8; cv = (col + 0.92) / SPINES * 7 / 8
    m = mb('spines')
    P = lambda i, j, k: Vector(c) + a * (i * t / 2) + o * ((j - 1) * d / 2) + up * (k * h)
    m.face([P(-1, 1, 0), P(1, 1, 0), P(1, 1, 1), P(-1, 1, 1)], [(cu, 0), (cv, 0), (cv, 1), (cu, 1)])               # spine
    for i in (-1, 1):                                                                                             # covers
        m.face([P(i, -1, 0), P(i, 1, 0), P(i, 1, 1), P(i, -1, 1)], [(cu, 0.02), (cv, 0.02), (cv, 0.08), (cu, 0.08)])
    for k in (0, 1):                                                                                              # page edges
        m.face([P(-1, -1, k), P(1, -1, k), P(1, 1, k), P(-1, 1, k)], _EDGE)
    m.face([P(-1, -1, 0), P(1, -1, 0), P(1, -1, 1), P(-1, -1, 1)], _EDGE)


def books(start, along, out, length, max_h=0.27, depth=0.17, fill=1.0):
    """A row of books standing on a shelf from `start` for `length`."""
    a = Vector(along).normalized(); s = 0.0; start = Vector(start)
    while True:
        t = random.uniform(0.022, 0.052)
        if s + t > length * fill:
            break
        h = min(max_h, random.uniform(0.17, 0.27)); d = random.uniform(0.12, depth)
        book(start + a * (s + t / 2), a, out, t, h, d, random.randrange(SPINES))
        s += t + random.choice((0.001, 0.001, 0.002, 0.012))


def pile(c, out, n=3, yaw=0.0):
    """Books lying in a pile; returns its height."""
    z = 0.0
    m = mb('spines')
    for _ in range(n):
        t = random.uniform(0.025, 0.05)
        a = yaw + random.uniform(-0.25, 0.25)
        o = Vector((math.cos(a) * out[0] - math.sin(a) * out[1], math.sin(a) * out[0] + math.cos(a) * out[1], 0))
        al = Vector((-o.y, o.x, 0))
        col = random.randrange(SPINES)
        cu = (col + 0.08) / SPINES * 7 / 8; cv = (col + 0.92) / SPINES * 7 / 8
        w, d = random.uniform(0.15, 0.2), random.uniform(0.21, 0.26)
        P = lambda i, j, k, z=z, t=t: Vector(c) + al * (i * d / 2) + o * (j * w / 2) + Vector((0, 0, z + k * t))
        for j in (-1, 1):
            m.face([P(-1, j, 0), P(1, j, 0), P(1, j, 1), P(-1, j, 1)], [(cu, 0), (cu, 1), (cv, 1), (cv, 0)] if j == 1 else _EDGE)
        for i in (-1, 1):
            m.face([P(i, -1, 0), P(i, 1, 0), P(i, 1, 1), P(i, -1, 1)], _EDGE)
        for k in (0, 1):
            m.face([P(-1, -1, k), P(1, -1, k), P(1, 1, k), P(-1, 1, k)], [(cu, 0.02), (cv, 0.02), (cv, 0.08), (cu, 0.08)])
        z += t
    return z


def mug(c, key='c_white', r=0.04, h=0.09, full='coffee'):
    c = Vector(c)
    lathe(key, [(r * 0.8, 0), (r, 0.01), (r, h), (r * 0.9, h), (r * 0.9, 0.012)], c, segs=10, capb=True)
    if full:
        lathe(full, [(r * 0.9, h * 0.82)], c, segs=10, capt=True)
    rope(key, [c + Vector((r + 0.028 * math.sin(a), 0, h * 0.5 + 0.028 * math.cos(a))) for a in
               [math.pi * j / 5 for j in range(6)]], 0.006, segs=4)


def lamp(foot, r=0.17, h=0.22, stem=0.3, base='c_white', glow=0.9):
    """A table lamp: a turned base, a cloth shade lit from inside."""
    foot = Vector(foot)
    lathe(base, [(0.07, 0), (0.075, 0.02), (0.04, 0.06), (0.055, stem * 0.5), (0.02, stem), (0.012, stem + 0.05)], foot, segs=12, capb=True)
    lathe('shade', [(r, stem), (r * 0.72, stem + h)], foot, segs=16, tile=2 * math.pi * r)
    halo('glow', foot + Vector((0, 0, stem + h * 0.5)), glow)


def chair(pos, yaw, cushion='linen_coral', key='oak'):
    """A slat-backed chair; unturned, it faces +Y."""
    with place(pos, yaw):
        wood((0, 0, 0.45), (0.42, 0.42, 0.035), key)
        for sx in (-1, 1):
            beam(key, (sx * 0.18, 0.18, 0), (sx * 0.18, 0.18, 0.44), 0.035, 0.035)
            beam(key, (sx * 0.18, -0.19, 0), (sx * 0.19, -0.23, 0.92), 0.035, 0.035)
        for z in (0.62, 0.74, 0.86):
            wood((0, -0.215 - (z - 0.45) * 0.085, z), (0.36, 0.02, 0.06), key)
        soft(cushion, (0, 0, 0.495), (0.38, 0.38, 0.06), n=5, segs=12, rings=4, tile=0.3)


def plant(idx, foot, h, yaw=0.3, sheet='plants'):
    crossed(sheet, idx, foot, h, yaw)


def swags(p1, p2, n, depth):
    """A line hung in n swags between two points."""
    p1 = Vector(p1); p2 = Vector(p2); pts = []
    for k in range(n):
        seg = sag(p1.lerp(p2, k / n), p1.lerp(p2, (k + 1) / n), depth, 8)
        pts += seg if not pts else seg[1:]
    return pts


LIGHTS = {'A': [], 'B': [], 'C': []}      # where the fairy lights' bulbs are, in three sets
_light = [0]
_OCT = [Vector(v) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
_OCT_F = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]


def fairy(pts, spacing=0.15):
    """A string of fairy lights along a line of points."""
    rope('wire', pts, 0.004, segs=3)
    left = spacing / 2
    for a, b in zip(pts[:-1], pts[1:]):
        a = here(a); b = here(b)
        L = (b - a).length
        while left <= L:
            LIGHTS['ABC'[_light[0] % 3]].append(a.lerp(b, left / L) - Vector((0, 0, 0.022)))
            _light[0] += 1
            left += spacing
        left -= L


def fairy_bulbs():
    """Every fairy() bulb so far, as objects: per set a mesh of bulbs and a
    mesh of their glows, each with a 'Dim' shape key that shrinks every one
    about its own middle (a scene cannot fade a material). Call before
    finalise(); twinkle() then sets them breathing."""
    obs = []
    for g, pts in LIGHTS.items():
        v = []; dim = []; f = []; uv = []
        for p in pts:
            b = len(v)
            v += [p + o * 0.02 for o in _OCT]; dim += [p + o * 0.008 for o in _OCT]
            f += [tuple(b + i for i in t) for t in _OCT_F]; uv += [(0.5, 0.5)] * 6
        obs.append(whole(f'Fairy{g}', 'bulb', v, f, uv, {'Dim': dim}, smooth=False))
        v = []; dim = []; f = []; uv = []
        for p in pts:
            for r, t in ((Vector((1, 0, 0)), Vector((0, 0, 1))), (Vector((0, 1, 0)), Vector((0, 0, 1)))):
                b = len(v)
                for sr, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    v.append(p + (r * sr + t * st) * 0.085); dim.append(p + (r * sr + t * st) * 0.03)
                    uv.append(((sr + 1) / 2, (st + 1) / 2))
                f.append((b, b + 1, b + 2, b + 3))
        obs.append(whole(f'FairyGlow{g}', 'glow_soft', v, f, uv, {'Dim': dim}, smooth=False))
    log(f"fairy lights: {sum(len(p) for p in LIGHTS.values())} bulbs")
    return obs


def twinkle(obs, periods=(4, 6, 9)):
    """Each set of fairy_bulbs() breathes on its own count."""
    for k, ob in enumerate(obs):
        g = k // 2
        animate_shapes(ob, lambda t, g=g: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / periods[g] + 2.1 * g)})


WISPS = []


def steam(name, pos, n=3, size=0.11, tall=None):
    """Wisps of steam over `pos`; rising() sets them going. tall: each wisp
    is two upright cards that many times taller than wide, not a round puff."""
    pos = Vector(pos)
    for k in range(n):
        with part(f'{name}{k}', pos):
            if tall:
                for nrm in ((0, -1, 0), (1, 0, 0)):
                    card('steam', pos + Vector((0, 0, size * (tall - 1) / 2)), nrm, size, size * tall)
            else:
                halo('steam', pos, size)
        WISPS.append((f'{name}{k}', k / n))


def rising(height=0.26, every=3.0):
    """Every steam() wisp rises, spreads and thins away, over and over."""
    def puff(start):
        def fn(t):
            u = ((t / every) + start) % 1.0
            s = (0.35 + 0.75 * u) * (1.0 if u < 0.6 else (1 - u) / 0.4)
            return {'loc': (0.02 * math.sin(2 * math.pi * u * 1.5 + 6 * start), 0, height * u), 'scale': max(0.001, s)}
        return fn
    for name, start in WISPS:
        animate(PARTS[name], puff(start))


# ════════════════════════════════════════════════════════════════════════
# Finalise, navigation mesh, animation, export
# ════════════════════════════════════════════════════════════════════════
def finalise(collection):
    """Turn everything gathered into objects: one mesh per material, and
    one per material under each moving part's empty."""
    coll = bpy.data.collections.new(collection); bpy.context.scene.collection.children.link(coll)
    for name, pivot in PIVOT.items():
        e = bpy.data.objects.new(name, None)
        e.location = pivot
        coll.objects.link(e)
        PARTS[name] = e
        EXPORT.append(e)
    for (pname, key), m in MBS.items():
        pivot = PIVOT[pname] if pname else Vector((0, 0, 0))
        name = f'{pname}_{key}' if pname else key
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v - pivot) for v in m.v], [], m.f)
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', [c for face in m.uv for uv in face for c in uv])
        me.polygons.foreach_set('use_smooth', m.sm)
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        for e in bm.edges:
            lf = e.link_faces
            if len(lf) == 2 and lf[0].smooth != lf[1].smooth:
                e.smooth = False
            elif len(lf) == 2 and lf[0].smooth and lf[1].smooth and lf[0].normal.angle(lf[1].normal, 0) > math.radians(60):
                e.smooth = False
        bm.to_mesh(me); bm.free()
        me.materials.append(M[key])
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        if pname:
            ob.parent = PARTS[pname]
        EXPORT.append(ob)
    EXPORT.extend(WHOLE)
    tri = sum(len(o.data.polygons) for o in EXPORT if o.type == 'MESH')
    log(f"{len(EXPORT)} objects, {tri} polys")
    return coll


def navmesh(name, coll, walk, block):
    """The walkable floor: the `walk` rectangles (x0, x1, y0, y1) less the
    `block` ones, as a mesh of cells. The name must end "-navmesh"."""
    gx = sorted({v for r in walk + block for v in r[:2]})
    gy = sorted({v for r in walk + block for v in r[2:]})
    inside = lambda rects, x, y: any(r[0] < x < r[1] and r[2] < y < r[3] for r in rects)
    nv = {}; verts = []; faces = []

    def vert(x, y):
        if (x, y) not in nv:
            nv[(x, y)] = len(verts); verts.append((x, y, 0.0))
        return nv[(x, y)]

    for x0, x1 in zip(gx[:-1], gx[1:]):
        for y0, y1 in zip(gy[:-1], gy[1:]):
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if inside(walk, cx, cy) and not inside(block, cx, cy):
                faces.append((vert(x0, y0), vert(x1, y0), vert(x1, y1), vert(x0, y1)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    EXPORT.append(ob)
    log(f"navmesh: {len(faces)} cells")
    return ob


def W(period, phase=0.0):
    """A sine of that period (seconds; it must divide LOOP)."""
    return lambda t: math.sin(2 * math.pi * t / period + phase)


def frames():
    return int(FPS * LOOP)


def animate(ob, fn):
    """fn(t) → {'loc': offset, 'rot': euler, 'scale': s or (sx, sy, sz)} for each frame of the loop."""
    scn = bpy.context.scene
    scn.render.fps = FPS; scn.frame_start = 0; scn.frame_end = frames()
    base = ob.location.copy()
    for f in range(frames() + 1):
        r = fn(f / FPS)
        if 'loc' in r:
            ob.location = base + Vector(r['loc']); ob.keyframe_insert('location', frame=f)
        if 'rot' in r:
            ob.rotation_euler = r['rot']; ob.keyframe_insert('rotation_euler', frame=f)
        if 'scale' in r:
            s = r['scale']
            ob.scale = s if isinstance(s, (tuple, list)) else (s,) * 3; ob.keyframe_insert('scale', frame=f)


def animate_shapes(ob, fn):
    """fn(t) → {shape key name: value} for each frame of the loop."""
    scn = bpy.context.scene
    scn.render.fps = FPS; scn.frame_start = 0; scn.frame_end = frames()
    kb = ob.data.shape_keys.key_blocks
    for f in range(frames() + 1):
        for name, v in fn(f / FPS).items():
            kb[name].value = v; kb[name].keyframe_insert('value', frame=f)


def export(filename, blend=False):
    bpy.context.scene.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT')
    for o in EXPORT:
        o.select_set(True)
    bpy.context.view_layer.objects.active = EXPORT[0]
    glb = os.path.join(OUT, filename)
    # export_apply stays off: applying modifiers would drop the shape keys.
    opts = dict(filepath=glb, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                export_image_format='WEBP', export_image_quality=88, export_lights=False, export_cameras=False,
                export_animations=True, export_animation_mode='SCENE', export_force_sampling=True, export_frame_range=True,
                export_morph=True, export_morph_normal=False, export_morph_tangent=False,
                export_optimize_animation_size=True, export_extras=False)
    known = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    for k in [k for k in opts if k not in known]:
        log("exporter has no option", k); del opts[k]
    bpy.ops.export_scene.gltf(**opts)
    log(f"exported {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, os.path.splitext(filename)[0] + '.blend'))
        log("saved .blend")
