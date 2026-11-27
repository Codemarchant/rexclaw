"""Build the Opera House scene and export it as a GLB background (step 2 of 2).

    python3 opera_house/paint_textures.py <tex_dir>
    blender -b --factory-startup --python build_opera_house.py -- <out_dir> <tex_dir> [blend]

Blender coords: Z up, the stage floor at z=0, the companion's spawn at the
origin facing -Y (the app's default camera sits at -Y looking +Y). Upstage
and the scenery are at +Y; the proscenium, the pit and the auditorium at -Y.
glTF export turns this into three.js Y-up with the camera on +Z.

Three things in the file are read by the app beyond its looks:
- its animation (one looping clip, LOOP seconds: the wave machine and the
  ship, the swaying drapes and chandelier, the sandbags, the cue lights);
- the node named "Stage-navmesh": where feet may go. It is the stage floor
  drawn in from every wall, drape and piece of furniture by INSET;
- nothing else: lights come from the app, so anything that must read in the
  dark carries its own glow (emissive, never above 1 — there is no tone
  mapping to catch more).
"""
import bpy, bmesh, json, math, random, sys, os, time
from mathutils import Vector, Matrix

T0 = time.time()
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = argv[0] if argv else os.path.join(HERE, 'opera_house', 'out')
TEX = argv[1] if len(argv) > 1 else os.path.join(OUT, 'textures')
SAVE_BLEND = 'blend' in argv[2:]
os.makedirs(OUT, exist_ok=True)
random.seed(11)


def log(*a):
    print(f"[opera {time.time() - T0:6.1f}s]", *a, flush=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
SCN = bpy.context.scene

# ════════════════════════════════════════════════════════════════════════
# Layout
# ════════════════════════════════════════════════════════════════════════
SW = 11.0             # stage half width, wall to wall
BACK_Y = 8.0          # stage back wall
GRID_Z = 13.0         # top of the stage house
PROS_Y = -4.0         # proscenium wall, stage face
PROS_T = 0.8          # its thickness: the house face is at PROS_Y - PROS_T
HOUSE_Y = PROS_Y - PROS_T
PROS_HW = 5.5         # half the opening
SPRING = 6.0          # where the arch springs
RISE = 1.6            # and how far it rises to the crown
APRON_Y = -6.2        # front edge of the stage
APRON_HW = 6.5
PIT_Y = -9.4          # pit rail
PIT_Z = -2.3
STALLS_Z = -1.1       # stalls floor at the pit rail; it rakes up toward the back
CUR_Y = -3.55         # the house curtain
ROWS_Y = (4.7, 5.4, 6.2)        # the wave machine's three rows, nearest first
ROWS_H = (0.70, 0.95, 1.20)
DROP_Y = 7.2          # painted backdrop
# Auditorium: a horseshoe. Its arc is centred on (0, HCY); the arms close in
# toward the proscenium by CONV.
HCY = -17.0
HR = 9.5
CONV = 1.9
NB = 21               # bays round the horseshoe (odd: one faces the stage)
SEG = 6               # segments per bay
DEPTH = 3.0           # tier depth, front to back wall
TIERS = (2.0, 4.9, 7.8)         # tier floor heights
SLAB = 0.4
CORNICE_Z = 10.4
CEIL_Z = 10.8
DOME = Vector((0.0, -16.5))
DOME_R = 7.6
DOME_RISE = 1.5
GHOST = Vector((-3.0, -2.6, 0.0))                 # the ghost light
INSET = 0.3           # navmesh clearance: about a body's half width (the app keeps 0.25 m for the shoulders)
# The loop every animation divides into.
FPS = 12
LOOP = 36.0
NF = int(FPS * LOOP)
# A pendulum's period is 2π√(L/g): 6 s is a 9 m drop, which is what the
# chandelier's chain and the sandbags' lines have above them.
SWING = 6.0


def zs(y):
    """Stalls floor height."""
    return STALLS_Z + 0.9 * min(1.0, max(0.0, (PIT_Y - y) / 16.0))


def in_house(x, y, margin=0.0):
    if y > HCY:
        return abs(x) < HR - CONV * ((y - HCY) / (HOUSE_Y - HCY)) ** 2 - margin
    return math.hypot(x, y - HCY) < HR - margin


# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
def srgb_to_lin(c):
    return tuple(((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c)


_IMG = {}


def IMG(name, noncolor=False):
    if name not in _IMG:
        im = bpy.data.images.load(os.path.join(TEX, name + '.png'))
        if noncolor:
            im.colorspace_settings.name = 'Non-Color'
        im.pack()
        _IMG[name] = im
    return _IMG[name]


def make_mat(name, color=(0.8, 0.8, 0.8), img=None, nrm=None, rough=0.8, metal=0.0, spec=0.5,
             glow=0.0, glow_img=None, glow_color=None, alpha=None, single=False):
    """glow: how brightly the surface shows with the lights off — its own
    picture (or glow_img / glow_color) as emission. alpha: 'MASK' cuts the
    picture out along its alpha, 'BLEND' fades with it. single: seen from
    its front only (a figure's face one way, its back the other)."""
    m = bpy.data.materials.new(name)
    m.use_backface_culling = single
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*srgb_to_lin(color), 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    tex = None
    if img:
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = IMG(img)
        if alpha != 'BLEND':
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


log("materials")
M = {}
M['floor'] = make_mat('StageBoards', img='floor', nrm='floor_n', rough=0.55)
M['brick'] = make_mat('StageBrick', img='brick', nrm='brick_n', rough=0.9, glow=0.06)
M['black'] = make_mat('BlackVelour', color=(0.035, 0.035, 0.04), rough=1.0, spec=0.1)
M['velvet'] = make_mat('CrimsonVelvet', img='velvet', rough=0.9, spec=0.25, glow=0.22)
M['gold'] = make_mat('Gilt', img='gold', rough=0.35, glow=0.34)
M['plaster'] = make_mat('Plaster', img='plaster', rough=0.9, glow=0.28)
M['tier'] = make_mat('TierFront', img='tier', rough=0.7, glow=1.0, glow_img='tier_glow')
M['wall'] = make_mat('BoxWall', img='wall', rough=0.85, glow=0.2)
M['partition'] = make_mat('BoxPartition', color=(0.50, 0.09, 0.11), rough=0.9, glow=0.16)
M['carpet'] = make_mat('Carpet', img='carpet', rough=1.0, spec=0.1, glow=0.12)
M['ceiling'] = make_mat('CeilingFresco', img='ceiling', rough=0.9, glow=0.5)
M['cartouche'] = make_mat('Cartouche', img='cartouche', rough=0.4, glow=0.45, alpha='MASK')
M['backdrop'] = make_mat('Backdrop', img='backdrop', rough=1.0, spec=0.0, glow=0.55)
for k in (1, 2, 3):
    M[f'waves{k}'] = make_mat(f'Waves{k}', img=f'waves{k}', rough=0.9, spec=0.1, glow=0.5, alpha='MASK')
M['ship'] = make_mat('ShipFlat', img='ship', rough=0.9, spec=0.1, glow=0.5, alpha='MASK')
M['cloud1'] = make_mat('CloudFlat1', img='cloud1', rough=0.9, spec=0.1, glow=0.55, alpha='MASK')
M['cloud2'] = make_mat('CloudFlat2', img='cloud2', rough=0.9, spec=0.1, glow=0.55, alpha='MASK')
M['glow'] = make_mat('Glow', color=(0, 0, 0), img='glow', rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['glow_blue'] = make_mat('GlowBlue', color=(0, 0, 0), img='glow_blue', rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['bulb'] = make_mat('Bulb', color=(1.0, 0.9, 0.7), glow=1.0, glow_color=(1.0, 0.88, 0.62))
M['bulb_blue'] = make_mat('BulbBlue', color=(0.5, 0.65, 1.0), glow=1.0, glow_color=(0.42, 0.60, 1.0))
M['moon'] = make_mat('Moon', color=(1.0, 0.96, 0.84), glow=0.95, glow_color=(1.0, 0.95, 0.82))
M['globe'] = make_mat('SconceGlobe', color=(1.0, 0.93, 0.78), rough=0.2, glow=0.95, glow_color=(1.0, 0.90, 0.70))
M['flame'] = make_mat('CandleFlame', color=(1.0, 0.9, 0.6), glow=1.0, glow_color=(1.0, 0.86, 0.55))
M['crystal'] = make_mat('Crystal', color=(0.95, 0.96, 1.0), rough=0.05, spec=1.0, glow=0.6, glow_color=(1.0, 0.93, 0.80))
M['cue_red'] = make_mat('CueRed', color=(1.0, 0.15, 0.1), glow=1.0, glow_color=(1.0, 0.12, 0.08))
M['cue_green'] = make_mat('CueGreen', color=(0.2, 1.0, 0.35), glow=1.0, glow_color=(0.15, 1.0, 0.30))
M['tape_glow'] = make_mat('GlowTape', color=(0.75, 1.0, 0.55), rough=0.6, glow=0.85, glow_color=(0.70, 1.0, 0.50))
M['tape_white'] = make_mat('SpikeTapeWhite', color=(0.92, 0.92, 0.88), rough=0.6, glow=0.15)
M['tape_red'] = make_mat('SpikeTapeRed', color=(0.85, 0.16, 0.14), rough=0.6, glow=0.15)
M['tape_blue'] = make_mat('SpikeTapeBlue', color=(0.18, 0.40, 0.85), rough=0.6, glow=0.15)
M['mote'] = make_mat('DustMote', color=(1.0, 0.95, 0.85), glow=0.9, glow_color=(1.0, 0.93, 0.80))
M['wood'] = make_mat('Timber', color=(0.50, 0.34, 0.20), rough=0.7, glow=0.10)
M['wood_dark'] = make_mat('Mahogany', color=(0.34, 0.17, 0.10), rough=0.5, glow=0.12)
M['brass'] = make_mat('Brass', color=(0.80, 0.60, 0.28), rough=0.3, glow=0.28)
M['copper'] = make_mat('Copper', color=(0.78, 0.42, 0.24), rough=0.3, glow=0.25)
M['iron'] = make_mat('BlackIron', color=(0.07, 0.07, 0.075), rough=0.55, glow=0.03)
M['rope'] = make_mat('Hemp', color=(0.62, 0.50, 0.34), rough=0.95, glow=0.10)
M['canvas'] = make_mat('SandbagCanvas', color=(0.62, 0.56, 0.44), rough=0.95, glow=0.10)
M['cream'] = make_mat('Cream', color=(0.93, 0.88, 0.76), rough=0.7, glow=0.3)
M['cork'] = make_mat('Cork', color=(0.62, 0.44, 0.27), rough=0.95, glow=0.14)
M['ceramic'] = make_mat('Ceramic', color=(0.90, 0.92, 0.95), rough=0.25, glow=0.15)
M['string'] = make_mat('HarpString', color=(0.92, 0.86, 0.70), rough=0.4, glow=0.4)
for name, g in (('poster1', 0.32), ('poster2', 0.32), ('callsheet', 0.34), ('book', 0.6), ('clock', 0.3),
                ('sheet', 0.6), ('sign', 0.3)):
    M[name] = make_mat(name.capitalize(), img=name, rough=0.8, glow=g)
UVFIT = {'poster1', 'poster2', 'callsheet', 'book', 'clock', 'sheet', 'sign'}    # one picture per box face
M['legs'] = make_mat('MidnightVelvet', img='velvet_blue', rough=0.9, spec=0.25, glow=0.42)
M['glow_white'] = make_mat('Flash', color=(0, 0, 0), img='glow_white', rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
# The cut-out figures and set pieces (paint_textures.py notes where each sits in its sheet).
SPR = {}
if os.path.exists(os.path.join(TEX, 'sprites.json')):
    SPR = json.load(open(os.path.join(TEX, 'sprites.json')))
for name, g in (('audience', 0.5), ('musicians', 0.45)):
    if name in SPR:
        M[name] = make_mat(name.capitalize(), img=name, rough=0.9, spec=0.1, glow=g, alpha='MASK', single=True)
        M[name + '_back'] = make_mat(name.capitalize() + 'Backs', img=name + '_back', rough=0.9, spec=0.1, glow=0.6,
                                     alpha='MASK', single=True)
for name, g in (('emotes', 0.9), ('props', 0.5)):
    if name in SPR:
        M[name] = make_mat(name.capitalize(), img=name, rough=0.9, spec=0.1, glow=g, alpha='MASK')


# ════════════════════════════════════════════════════════════════════════
# Mesh accumulation: one mesh per material — and per moving part
# ════════════════════════════════════════════════════════════════════════
XF = [Matrix.Identity(4)]
PART = [None]
PIVOT = {}


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


MBS = {}


def mb(key):
    k = (PART[-1], key)
    if k not in MBS:
        MBS[k] = MB()
    return MBS[k]


class part:
    """with part('Ship', pivot): ... — geometry that moves as one, about its pivot."""
    def __init__(self, name, pivot):
        self.name = name; PIVOT[name] = Vector(pivot)

    def __enter__(self):
        PART.append(self.name)

    def __exit__(self, *a):
        PART.pop()


class place:
    """with place(pos, yaw): ... — props built in local coords."""
    def __init__(self, pos=(0, 0, 0), yaw=0.0, scale=1.0):
        self.m = Matrix.Translation(Vector(pos)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)

    def __enter__(self):
        XF.append(XF[-1] @ self.m)

    def __exit__(self, *a):
        XF.pop()


def box(key, c, size, R=None, grain=None, tile=2.0):
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
            m.face(pts, uvs)


def basis_from(d, up=(0, 0, 1)):
    x = Vector(d).normalized(); u = Vector(up)
    if abs(x.dot(u)) > 0.99:
        u = Vector((1, 0, 0)) if abs(x.x) < 0.9 else Vector((0, 1, 0))
    y = u.cross(x).normalized(); z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def beam(key, p1, p2, w, h, up=(0, 0, 1), tile=2.0):
    p1 = Vector(p1); p2 = Vector(p2)
    box(key, (p1 + p2) / 2, ((p2 - p1).length, w, h), basis_from(p2 - p1, up), grain=0, tile=tile)


def lathe(key, prof, base=(0, 0, 0), axis=(0, 0, 1), segs=16, tile=1.0, capb=False, capt=False, smooth=True):
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
            uvr.append((s / tile, 2 * math.pi * rmax * j / segs / tile))
        P.append(row); UV.append(uvr)
    m.grid(P, UV, smooth)
    for cap, idx in ((capb, 0), (capt, len(prof) - 1)):
        if cap and prof[idx][0] > 1e-4:
            ring = P[idx][:segs]
            uvs = [(0.5 + 0.5 * math.cos(2 * math.pi * j / segs), 0.5 + 0.5 * math.sin(2 * math.pi * j / segs)) for j in range(segs)]
            if idx == 0:
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


def sprite(sheet, idx, foot, normal, h, mirror=False, backs=False, centre=False):
    """One cut-out from a sheet, h tall, standing on `foot` (or centred on
    it) and facing `normal`. backs: a shaded copy facing the other way, for
    a figure that is looked at from behind too. Returns its width."""
    s = SPR[sheet][idx]
    w = h * s['aspect']
    foot = Vector(foot); n = Vector(normal).normalized()
    c = foot if centre else foot + Vector((0, 0, h / 2))
    u0, u1 = (s['u1'], s['u0']) if mirror else (s['u0'], s['u1'])
    card(sheet, c, n, w, h, u0=u0, u1=u1, v0=s['v0'], v1=s['v1'])
    if backs:
        card(sheet + '_back', c - n * 0.01, -n, w, h, u0=u1, u1=u0, v0=s['v0'], v1=s['v1'])
    return w


def halo(key, c, size):
    """A light's glow, seen from any side: three crossed cards."""
    for n, up in (((0, 1, 0), (0, 0, 1)), ((1, 0, 0), (0, 0, 1)), ((0, 0, 1), (0, 1, 0))):
        card(key, c, n, size, size, up)


def plane(key, pts, tile, axes):
    """A flat polygon mapped by its world coordinates (two of x, y, z)."""
    a, b = axes
    mb(key).face(pts, [(p[a] / tile, p[b] / tile) for p in pts])


def floor(key, x0, x1, y0, y1, z, tile=4.0):
    plane(key, [Vector((x0, y0, z)), Vector((x1, y0, z)), Vector((x1, y1, z)), Vector((x0, y1, z))], tile, (0, 1))


def wall_y(key, x0, x1, z0, z1, y, tile=2.0):
    plane(key, [Vector((x0, y, z0)), Vector((x1, y, z0)), Vector((x1, y, z1)), Vector((x0, y, z1))], tile, (0, 2))


def wall_x(key, y0, y1, z0, z1, x, tile=2.0):
    plane(key, [Vector((x, y0, z0)), Vector((x, y1, z0)), Vector((x, y1, z1)), Vector((x, y0, z1))], tile, (1, 2))


def ribbon(key, A, B, U, v0=0.0, v1=1.0, smooth=True):
    """A band between two lines of points."""
    mb(key).grid([A, B], [[(u, v0) for u in U], [(u, v1) for u in U]], smooth)


def drape(key, x0, x1, y, z0, z1, pleats, amp, tile=1.0, bottom=None, folds=False):
    """A pleated hanging in the plane y. bottom(x) → its lower edge, if not
    straight. folds: its picture is one painted fold (velvet_folds), laid
    once across each pleat and every two metres down."""
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


# ════════════════════════════════════════════════════════════════════════
# The stage house
# ════════════════════════════════════════════════════════════════════════
log("stage house")
floor('floor', -SW, SW, PROS_Y, BACK_Y, 0)
floor('floor', -PROS_HW, PROS_HW, HOUSE_Y, PROS_Y, 0)
floor('floor', -APRON_HW, APRON_HW, APRON_Y, HOUSE_Y, 0)
wall_x('brick', PROS_Y, BACK_Y, 0, GRID_Z, -SW)
wall_x('brick', PROS_Y, BACK_Y, 0, GRID_Z, SW)
wall_y('brick', -SW, SW, 0, GRID_Z, BACK_Y)
floor('black', -SW, SW, PROS_Y, BACK_Y, GRID_Z)


def arch(z0=0.0, n=28):
    """The proscenium opening, up one jamb, over the arch, down the other:
    (x, z, outward normal x, outward normal z)."""
    pts = [(PROS_HW, z0, 1, 0), (PROS_HW, SPRING * 0.5, 1, 0)]
    for k in range(n + 1):
        a = math.pi * k / n
        nx, nz = math.cos(a) / PROS_HW, math.sin(a) / RISE
        l = math.hypot(nx, nz)
        pts.append((PROS_HW * math.cos(a), SPRING + RISE * math.sin(a), nx / l, nz / l))
    pts += [(-PROS_HW, SPRING * 0.5, -1, 0), (-PROS_HW, z0, -1, 0)]
    return pts


def pros_face(key, y, half, top, tile):
    """The wall round the opening: strips from the arch out to its edges."""
    A = arch()
    inner = []; outer = []
    for x, z, _, _ in A:
        inner.append(Vector((x, y, z)))
        if z <= SPRING + 1e-6:
            outer.append(Vector((half if x > 0 else -half, y, z)))
        else:
            dx, dz = x, z - SPRING
            s = min(half / abs(dx) if abs(dx) > 1e-6 else 1e9, (top - SPRING) / dz)
            outer.append(Vector((dx * s, y, SPRING + dz * s)))
    m = mb(key)
    for a, b, c, d in zip(inner[:-1], inner[1:], outer[1:], outer[:-1]):
        m.face([a, b, c, d], [(p.x / tile, p.z / tile) for p in (a, b, c, d)])


pros_face('brick', PROS_Y, SW, GRID_Z, 2.0)
pros_face('plaster', HOUSE_Y, 13.0, CEIL_Z, 3.0)
A = arch()
ribbon('plaster', [Vector((x, HOUSE_Y, z)) for x, z, _, _ in A], [Vector((x, PROS_Y, z)) for x, z, _, _ in A],
       [k * 0.3 for k in range(len(A))], 0, 0.27)
# The gilt frame round the opening, on the house side.
FRAME = [(0.0, 0.0), (0.0, 0.10), (0.10, 0.17), (0.26, 0.10), (0.36, 0.15), (0.50, 0.04), (0.50, 0.0)]
rows = [[Vector((x + nx * a, HOUSE_Y - b, z + nz * a)) for a, b in FRAME] for x, z, nx, nz in arch()]
mb('gold').grid(rows, [[(i * 0.5, j * 0.2) for j in range(len(FRAME))] for i in range(len(rows))])
card('cartouche', (0, HOUSE_Y - 0.22, SPRING + RISE + 0.75), (0, -1, 0), 2.0, 2.0)
# Gilt pilasters either side of it, under an entablature.
ENT_Z = 9.6
for sgn in (-1, 1):
    x = sgn * (PROS_HW + 1.05)
    box('gold', (x, HOUSE_Y - 0.07, ENT_Z / 2), (0.55, 0.14, ENT_Z), tile=1.0)
    box('gold', (x, HOUSE_Y - 0.10, 0.25), (0.75, 0.20, 0.5), tile=1.0)
    box('gold', (x, HOUSE_Y - 0.10, ENT_Z - 0.2), (0.80, 0.22, 0.4), tile=1.0)
box('gold', (0, HOUSE_Y - 0.11, ENT_Z + 0.16), (2 * PROS_HW + 3.6, 0.22, 0.32), tile=1.0)
box('plaster', (0, HOUSE_Y - 0.08, ENT_Z + 0.50), (2 * PROS_HW + 3.4, 0.16, 0.36), tile=3.0)
box('gold', (0, HOUSE_Y - 0.14, ENT_Z + 0.75), (2 * PROS_HW + 3.9, 0.28, 0.14), tile=1.0)

# Masking: black legs at the sides, borders overhead.
LEG_Y = (-0.8, 1.8, 4.3)
for y in LEG_Y:
    for sgn in (-1, 1):
        drape('legs', sgn * 6.6, sgn * 9.0, y, 0.02, 9.2, 6, 0.10, folds=True)
    drape('legs', -SW, SW, y - 0.25, 7.9, 11.5, 44, 0.07, folds=True)
    wall_y('gold', -SW, SW, 7.80, 7.93, y - 0.33, tile=0.5)             # a gold hem on each border
# Fly lines down to the borders.
for y in LEG_Y:
    for x in (-7.5, -2.5, 2.5, 7.5):
        tube('rope', (x, y - 0.25, 11.5), (x, y - 0.25, GRID_Z), 0.012, segs=4)

# Lighting bar over the stage, behind the valance.
BAR = Vector((0, -2.7, 8.5))
tube('iron', BAR + Vector((-7, 0, 0)), BAR + Vector((7, 0, 0)), 0.03, segs=8)
for x in (-6.5, 0, 6.5):
    tube('rope', BAR + Vector((x, 0, 0)), (x, BAR.y, GRID_Z), 0.012, segs=4)
for k in range(8):
    x = -5.6 + k * 1.6
    aim = Vector((-x * 0.12, 0.42, -1)).normalized()
    top = BAR + Vector((x, 0, -0.16))
    tube('iron', BAR + Vector((x, 0, 0)), top, 0.012, segs=5)
    tube('iron', top - aim * 0.02, top + aim * 0.36, 0.13, 0.15, segs=10, caps=True)
    lathe('bulb', [(0.0, 0.0), (0.125, 0.0)], top + aim * 0.365, aim, segs=10)
    card('glow', top + aim * 0.40, aim, 0.75, 0.75, up=(0, 1, 0))

# ── The scenery: a painted harbour, a wave machine and a ship ───────────
log("scenery")
card('backdrop', (0, DROP_Y, 0.1 + 4.84), (0, -1, 0), 17.2, 9.675)
for k, (y, h) in enumerate(zip(ROWS_Y, ROWS_H)):
    with part(f'Waves{k + 1}', (0, y, 0)):
        card(f'waves{k + 1}', (0, y, h / 2), (0, -1, 0), 15.6, h, u0=0.13 * k, u1=1.5 + 0.13 * k)
        box('wood', (0, y + 0.05, 0.05), (15.6, 0.06, 0.10))
# The ship works to and fro to one side of centre, clear of whoever stands there.
SHIP = Vector((2.7, 5.8, 0.55))
SHIP_W = 4.0
with part('Ship', SHIP + Vector((0, 0, 0.45))):
    card('ship', SHIP + Vector((0, 0, SHIP_W / 2)), (0, -1, 0), SHIP_W, SHIP_W)
for k, (c, w) in enumerate((((-4.3, 6.75, 7.3), 4.4), ((4.7, 6.85, 6.5), 3.6))):
    with part(f'Cloud{k + 1}', (c[0], c[1], GRID_Z)):
        card(f'cloud{k + 1}', c, (0, -1, 0), w, w / 2)
        for dx in (-w * 0.3, w * 0.3):
            tube('rope', (c[0] + dx, c[1], c[2] + w * 0.12), (c[0] + dx, c[1], GRID_Z), 0.006, segs=4)
MOON = Vector((3.3, 7.05, 6.9))
lathe('moon', [(0.0, 0.0), (0.42, 0.0)], MOON, (0, -1, 0), segs=28)
tube('rope', MOON + Vector((0, 0, 0.42)), (MOON.x, MOON.y, GRID_Z), 0.005, segs=4)
with part('MoonGlow', MOON + Vector((0, -0.03, 0))):
    card('glow', MOON + Vector((0, -0.03, 0)), (0, -1, 0), 2.6, 2.6)
# Set pieces along the quay, between the acting area and the waves, and gulls on wires.
PROP_GULL, PROP_GLIDE, PROP_CRATES, PROP_ANCHOR, PROP_LAMP, PROP_BOAT, PROP_RAIL = 0, 1, 3, 4, 5, 6, 7
GULLS = []
LAMP = None
if 'props' in SPR:
    Q = (0, -1, 0)
    sprite('props', PROP_CRATES, (-5.6, 4.15, 0), Q, 1.35)
    sprite('props', PROP_CRATES, (6.1, 3.95, 0), Q, 1.10, mirror=True)
    sprite('props', PROP_ANCHOR, (4.7, 4.30, 0), Q, 1.25)
    sprite('props', PROP_BOAT, (-2.3, 4.40, 0), Q, 0.95)
    w = sprite('props', PROP_LAMP, (-4.1, 4.36, 0), Q, 2.2)
    LAMP = Vector((-4.1 + w * 0.22, 4.30, 1.48))                # the lantern itself hangs off the post
    with part('LanternGlow', LAMP):
        halo('glow', LAMP, 1.1)
    sprite('props', PROP_RAIL, (9.75, 3.75, 0), Q, 1.8)
    for k, (c, idx, h, mirror) in enumerate((((-2.6, 6.50, 5.3), PROP_GULL, 1.25, False), ((1.0, 6.62, 6.5), PROP_GLIDE, 0.42, False),
                                             ((5.9, 6.45, 4.7), PROP_GULL, 1.0, True))):
        name = f'Gull{k + 1}'
        GULLS.append(name)
        with part(name, (c[0], c[1], GRID_Z)):
            w = sprite('props', idx, c, Q, h, mirror=mirror, centre=True)
            tube('rope', (c[0], c[1], c[2] + h * 0.2), (c[0], c[1], GRID_Z), 0.004, segs=4)

# ── The ghost light ─────────────────────────────────────────────────────
lathe('iron', [(0.22, 0.0), (0.22, 0.025), (0.05, 0.05), (0.018, 0.08), (0.018, 1.52)], GHOST, segs=14, capb=True)
BULB = GHOST + Vector((0, 0, 1.62))
tube('brass', GHOST + Vector((0, 0, 1.50)), GHOST + Vector((0, 0, 1.57)), 0.03, segs=8, caps=True)
sphere('bulb', BULB, 0.05, segs=10, rings=6, sz=1.25)
for k in range(6):                                            # wire cage
    a = k * math.pi / 3
    d = Vector((math.cos(a), math.sin(a), 0))
    rope('iron', [GHOST + Vector((0, 0, 1.56)) + d * 0.035, BULB + d * 0.085 - Vector((0, 0, 0.02)),
                  BULB + d * 0.085 + Vector((0, 0, 0.05)), BULB + Vector((0, 0, 0.12))], 0.003, segs=3)
with part('GhostGlow', BULB):
    halo('glow', BULB, 1.3)

# Dust in the light: three slow drifts of motes.
for name, c, rad, n in (('MotesA', BULB + Vector((0, 0, 0.1)), 1.5, 70), ('MotesB', Vector((0.4, -0.6, 2.4)), 3.4, 90),
                        ('MotesC', Vector((0, -4.6, 1.5)), 2.6, 60)):
    with part(name, c):
        for k in range(n):
            a = random.random() * 2 * math.pi
            r = rad * math.sqrt(random.random())
            p = c + Vector((math.cos(a) * r, math.sin(a) * r, (random.random() - 0.5) * 2.2))
            sphere('mote', p, 0.003 + 0.003 * random.random(), segs=4, rings=2)

# Spike marks: glow tape on the centre line, coloured corners where the furniture goes.
for y in (-5.4, -4.4, -3.0, -2.0, -1.0, 1.0, 2.0, 3.0):
    box('tape_glow', (0, y, 0.003), (0.03, 0.14, 0.002))
box('tape_glow', (0, -5.55, 0.003), (0.30, 0.03, 0.002))
for (x, y, key) in ((-1.9, 1.3, 'tape_red'), (-0.7, 1.3, 'tape_red'), (1.6, 0.4, 'tape_blue'), (2.6, 0.4, 'tape_blue'),
                    (-4.2, 2.6, 'tape_white'), (4.4, 2.9, 'tape_white')):
    box(key, (x + 0.06, y, 0.003), (0.14, 0.022, 0.002))
    box(key, (x, y + 0.06, 0.003), (0.022, 0.14, 0.002))

# ── The fly rail and its sandbags (stage right) ─────────────────────────
log("fly rail, prompt corner")
RAIL_X = -SW + 0.55
beam('wood', (RAIL_X, -2.2, 1.05), (RAIL_X, 6.2, 1.05), 0.16, 0.14)
for y in (-2.0, 0.0, 2.0, 4.0, 6.0):
    box('wood', (RAIL_X, y, 0.5), (0.12, 0.12, 1.0))
    beam('wood', (RAIL_X, y, 0.75), (-SW, y, 0.75), 0.08, 0.08)
for k in range(17):
    y = -1.8 + k * 0.48
    tube('wood_dark', (RAIL_X, y, 0.92), (RAIL_X, y, 1.30), 0.017, 0.022, segs=6, caps=True)
    tube('rope', (RAIL_X + 0.03, y, 1.12), (RAIL_X + 0.12 + 0.05 * (k % 3), y + 0.05, GRID_Z), 0.011, segs=4)
    if k % 2 == 0:                                             # the spare line, coiled on its pin
        c = Vector((RAIL_X + 0.09, y, 0.84))
        for turn in range(5):
            ry, rz = 0.055 + 0.012 * random.random(), 0.17 + 0.04 * random.random()
            rope('rope', [c + Vector((0.02 * turn, ry * math.sin(a), rz * math.cos(a) - 0.01 * turn))
                          for a in [2 * math.pi * j / 12 for j in range(13)]], 0.011, segs=4)
BAGS = []
for k, y in enumerate((-0.9, 1.1, 3.0, 5.1)):
    x = -SW + 1.5 + 0.25 * (k % 2)
    z = 2.75 + 0.3 * (k % 3)
    name = f'Sandbag{k + 1}'
    BAGS.append(name)
    with part(name, (x, y, z + 0.5 + 9.0)):
        tube('rope', (x, y, z + 0.5), (x, y, GRID_Z), 0.011, segs=4)
        lathe('canvas', [(0.0, 0.0), (0.11, 0.03), (0.16, 0.18), (0.15, 0.34), (0.06, 0.46), (0.03, 0.50)], (x, y, z), segs=10)
        tube('iron', (x, y, z + 0.47), (x, y, z + 0.54), 0.018, segs=6)

# ── The prompt corner (stage left) ──────────────────────────────────────
DESK = Vector((8.6, -2.9, 0.0))
box('wood_dark', DESK + Vector((0, 0, 1.0)), (0.75, 1.4, 0.05))
box('wood_dark', DESK + Vector((0, 0, 0.35)), (0.65, 1.3, 0.03))
for sx in (-0.33, 0.33):
    for sy in (-0.64, 0.64):
        box('wood_dark', DESK + Vector((sx, sy, 0.5)), (0.06, 0.06, 1.0))
# The book, open on a slope, facing the stool.
TILT = math.radians(22)
BOOK = DESK + Vector((0.06, 0.1, 1.11))
bn = Vector((math.sin(TILT), 0, math.cos(TILT)))               # its face: up and toward +x
bup = Vector((-math.cos(TILT), 0, math.sin(TILT)))             # up the page: away from the reader
beam('wood_dark', BOOK - bn * 0.035 + Vector((0, -0.36, 0)), BOOK - bn * 0.035 + Vector((0, 0.36, 0)), 0.44, 0.03, up=bn)
beam('cream', BOOK - bn * 0.012 + Vector((0, -0.33, 0)), BOOK - bn * 0.012 + Vector((0, 0.33, 0)), 0.40, 0.02, up=bn)
card('book', BOOK, bn, 0.66, 0.41, up=bup)
# Reading lamp: a blue bulb under a hood, on a gooseneck.
LAMP = DESK + Vector((-0.22, 0.62, 1.025))
neck = [LAMP, LAMP + Vector((0, 0, 0.30)), LAMP + Vector((0.06, -0.10, 0.42)), LAMP + Vector((0.14, -0.26, 0.44))]
rope('brass', neck, 0.012, segs=6)
lathe('brass', [(0.08, 0.0), (0.08, 0.02)], LAMP, segs=12, capt=True)
lathe('iron', [(0.035, 0.0), (0.10, -0.10)], neck[-1] + Vector((0, 0, 0.02)), segs=12)
sphere('bulb_blue', neck[-1] + Vector((0, 0, -0.04)), 0.03, segs=8, rings=5)
halo('glow_blue', neck[-1] + Vector((0, 0, -0.06)), 0.55)
# Cue lights: a standby red over a go green.
CUE = DESK + Vector((-0.25, -0.5, 1.025))
box('iron', CUE + Vector((0, 0, 0.14)), (0.10, 0.16, 0.28))
for name, key, z in (('CueRed', 'cue_red', 0.20), ('CueGreen', 'cue_green', 0.08)):
    p = CUE + Vector((0.055, 0, z))
    with part(name, p):
        sphere(key, p, 0.03, segs=10, rings=6)
        card('glow', p + Vector((0.035, 0, 0)), (1, 0, 0), 0.22, 0.22)
lathe('ceramic', [(0.0, 0.0), (0.035, 0.0), (0.04, 0.09), (0.036, 0.09), (0.032, 0.012), (0.0, 0.012)],
      DESK + Vector((0.2, -0.52, 1.025)), segs=12)
# Stool.
ST = DESK + Vector((0.85, 0.1, 0))
lathe('wood_dark', [(0.0, 0.66), (0.17, 0.66), (0.18, 0.69), (0.17, 0.72), (0.0, 0.72)], ST, segs=14)
for k in range(3):
    a = k * 2 * math.pi / 3 + 0.4
    tube('wood_dark', ST + Vector((0.07 * math.cos(a), 0.07 * math.sin(a), 0.66)),
         ST + Vector((0.21 * math.cos(a), 0.21 * math.sin(a), 0)), 0.018, segs=6)
# The call board, on the back of the proscenium wall.
WY = PROS_Y + 0.02
box('cork', (9.3, WY + 0.02, 1.75), (2.5, 0.04, 1.3))
for dx, dz in ((-1.25, 0), (1.25, 0)):
    box('wood_dark', (9.3 + dx, WY + 0.03, 1.75), (0.06, 0.06, 1.36))
for dz in (-0.65, 0.65):
    box('wood_dark', (9.3, WY + 0.03, 1.75 + dz), (2.56, 0.06, 0.06))
card('poster1', (10.05, WY + 0.045, 1.76), (0, 1, 0), 0.62, 0.93)
card('callsheet', (9.28, WY + 0.045, 1.80), (0, 1, 0), 0.56, 0.84)
card('poster2', (8.52, WY + 0.045, 1.74), (0, 1, 0), 0.62, 0.93)
card('sign', (9.3, WY + 0.02, 2.62), (0, 1, 0), 1.0, 0.25)
lathe('wood_dark', [(0.0, 0.0), (0.23, 0.0), (0.23, 0.04), (0.20, 0.05)], (7.5, WY, 2.5), (0, 1, 0), segs=24)
card('clock', (7.5, WY + 0.052, 2.5), (0, 1, 0), 0.40, 0.40)

# ════════════════════════════════════════════════════════════════════════
# The house curtain: gathered open, under a swagged valance
# ════════════════════════════════════════════════════════════════════════
log("curtain")
TIE_Z = 2.7
CUR_TOP = 8.0
CURTAINS = []


def curtain(name, sgn):
    """One half of the house curtain, drawn back to a tie. Its own object:
    two shape keys a quarter turn apart make a ripple that travels."""
    NU, NV = 40, 30
    verts = []; uvs = []; d1 = []; d2 = []
    for j in range(NV + 1):
        v = j / NV
        z = 0.04 + v * (CUR_TOP - 0.04)
        if z >= TIE_Z:
            inner = 4.95 - 1.75 * ((z - TIE_Z) / (CUR_TOP - TIE_Z)) ** 1.5
        else:
            inner = 4.95 - 0.55 * math.sin((TIE_Z - z) / TIE_Z * math.pi / 2)
        outer = 6.15
        pinch = math.exp(-((z - TIE_Z) / 0.45) ** 2)
        free = min(1.0, abs(z - TIE_Z) / 1.6) * (1 - v ** 6)            # held at the tie and the track
        for i in range(NU + 1):
            u = i / NU
            x = sgn * (outer + (inner - outer) * u)
            fold = math.sin(u * 2 * math.pi * 9) * (0.12 - 0.07 * pinch) + 0.04 * math.sin(u * 2 * math.pi * 2.5 + 1.0)
            verts.append(Vector((x, CUR_Y + fold - 0.10 * pinch * u, z)))
            uvs.append((u * 3.2, z / 1.0))
            ph = 2 * math.pi * (u * 1.3 + v * 1.6)
            a = 0.07 * free * (0.4 + 0.6 * u)
            d1.append(Vector((0.25 * a * math.sin(ph), a * math.sin(ph), 0)))
            d2.append(Vector((0.25 * a * math.cos(ph), a * math.cos(ph), 0)))
    faces = []
    for j in range(NV):
        for i in range(NU):
            a = j * (NU + 1) + i
            faces.append((a, a + 1, a + NU + 2, a + NU + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in verts], [], faces)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', [c for f in faces for i in f for c in uvs[i]])
    me.polygons.foreach_set('use_smooth', [True] * len(faces))
    me.materials.append(M['velvet'])
    ob = bpy.data.objects.new(name, me)
    SCN.collection.objects.link(ob)
    ob.shape_key_add(name='Basis')
    for kname, d in (('SwayA', d1), ('SwayB', d2)):
        key = ob.shape_key_add(name=kname)
        key.slider_min = -1.0
        for i, p in enumerate(verts):
            key.data[i].co = p + d[i]
    CURTAINS.append(ob)


curtain('CurtainL', -1)
curtain('CurtainR', 1)
for sgn in (-1, 1):                                            # the tie-backs: a gold cord round the gather, a tassel
    c = Vector((sgn * 5.55, CUR_Y - 0.03, TIE_Z))
    for dz in (-0.035, 0.035):
        rope('gold', [c + Vector((0.66 * math.cos(a), 0.21 * math.sin(a), dz + sgn * 0.06 * math.cos(a))) for a in
                      [2 * math.pi * j / 18 for j in range(19)]], 0.028, segs=6)
    lathe('gold', [(0.0, 0.0), (0.05, -0.04), (0.06, -0.12), (0.03, -0.16), (0.07, -0.20), (0.08, -0.44), (0.0, -0.46)],
          c + Vector((-sgn * 0.50, -0.22, -0.06)), segs=10)
SWAG = 12.6 / 6
valance_bottom = lambda x: 6.55 + 0.75 * abs(math.sin(math.pi * (x + 6.3) / SWAG)) ** 0.8
drape('velvet', -6.3, 6.3, CUR_Y - 0.22, 0, 8.6, 30, 0.07, bottom=valance_bottom)
N = 120                                                        # gold fringe along the swags
fr = [Vector((-6.3 + 12.6 * k / N, CUR_Y - 0.24 + 0.07 * math.sin(k / N * 30 * 2 * math.pi), 0)) for k in range(N + 1)]
ribbon('gold', [p + Vector((0, 0, valance_bottom(p.x) - 0.14)) for p in fr],
       [p + Vector((0, 0, valance_bottom(p.x) + 0.02)) for p in fr], [k * 0.2 for k in range(N + 1)], 0, 0.3)

# ════════════════════════════════════════════════════════════════════════
# Footlights, apron and pit
# ════════════════════════════════════════════════════════════════════════
log("apron, pit")
FOOT_Y = APRON_Y + 0.12
for k in range(15):
    x = -5.6 + k * 0.8
    sphere('brass', (x, FOOT_Y, 0.03), 0.11, segs=10, rings=6, sz=0.9)
    sphere('bulb', (x, FOOT_Y + 0.07, 0.075), 0.04, segs=8, rings=5)
    card('glow', (x, FOOT_Y + 0.10, 0.12), (0, 1, 0), 0.55, 0.55)
box('brass', (0, FOOT_Y - 0.05, 0.015), (11.8, 0.05, 0.03))
# Stage front, down into the pit, and the pit's own walls.
wall_y('wood_dark', -APRON_HW, APRON_HW, PIT_Z, 0, APRON_Y, 1.5)
floor('wood_dark', -APRON_HW, APRON_HW, PIT_Y, APRON_Y, PIT_Z, 2.0)
for sgn in (-1, 1):
    wall_x('wood_dark', PIT_Y, APRON_Y, PIT_Z, STALLS_Z + 0.9, sgn * APRON_HW, 1.5)
    wall_x('plaster', APRON_Y, HOUSE_Y, STALLS_Z - 0.2, 0, sgn * APRON_HW, 3.0)
    floor('carpet', sgn * APRON_HW, sgn * 13.0, PIT_Y, HOUSE_Y, STALLS_Z, 1.5)
    wall_y('plaster', sgn * APRON_HW, sgn * 13.0, STALLS_Z - 0.2, 0, HOUSE_Y, 3.0)
wall_y('wood_dark', -APRON_HW, APRON_HW, PIT_Z, STALLS_Z + 0.9, PIT_Y, 1.5)
box('velvet', (0, PIT_Y, STALLS_Z + 0.93), (2 * APRON_HW + 0.2, 0.2, 0.07))
tube('brass', (-APRON_HW, PIT_Y - 0.04, STALLS_Z + 1.07), (APRON_HW, PIT_Y - 0.04, STALLS_Z + 1.07), 0.02, segs=8)
for k in range(14):
    x = -APRON_HW + 0.25 + k * (2 * APRON_HW - 0.5) / 13
    tube('brass', (x, PIT_Y - 0.04, STALLS_Z + 0.96), (x, PIT_Y - 0.04, STALLS_Z + 1.07), 0.012, segs=6)
# The orchestra: stands with their lamps, chairs, the podium, a harp, timpani.
COND = Vector((0, PIT_Y + 0.75, PIT_Z))


def chair(pos, yaw):
    with place(pos, yaw):
        box('wood_dark', (0, 0, 0.45), (0.40, 0.40, 0.04))
        box('wood_dark', (0, -0.19, 0.72), (0.38, 0.03, 0.30))
        for sx in (-0.17, 0.17):
            box('wood_dark', (sx, -0.19, 0.44), (0.03, 0.03, 0.88))
            box('wood_dark', (sx, 0.17, 0.22), (0.03, 0.03, 0.44))


def stand(pos, facing, big=False, h=1.08):
    """A music stand at pos, its desk facing `facing` (a unit vector on the floor)."""
    pos = Vector(pos); f = Vector(facing).normalized()
    lathe('iron', [(0.16, 0.0), (0.16, 0.012), (0.012, 0.03), (0.012, h)], pos, segs=8, capb=True)
    n = (f + Vector((0, 0, 0.5))).normalized()                 # leaning back
    c = pos + Vector((0, 0, h + 0.10))
    w = 0.62 if big else 0.46
    card('iron', c - n * 0.006, n, w + 0.04, 0.36)
    card('sheet', c, n, w, 0.32)
    lip = c + n.cross(f.cross(n)).normalized() * 0.0
    lamp = c + Vector((0, 0, 0.21)) + f * 0.05
    box('brass', lamp, (0.16, 0.05, 0.03), basis_from(f.cross(Vector((0, 0, 1)))))
    sphere('bulb', lamp + Vector((0, 0, -0.025)), 0.014, segs=6, rings=4)
    card('glow', c + n * 0.03 + Vector((0, 0, 0.1)), n, 0.5, 0.5)


# The sheet's players, in its reading order: violin, cello, flute, double bass, (the conductor), trumpet,
# clarinet, horn, kettle drums. Each is used twice, the second time mirrored.
BAND = [0, 1, 2, 5, 6, 7, 3, 8]
BAND_H = {1: 1.35, 3: 1.6, 8: 1.3}
PLAYERS = []
for row_y, xs in ((PIT_Y + 2.45, [x * 1.15 for x in range(-4, 5)]), (PIT_Y + 1.45, [x * 1.15 + 0.57 for x in range(-5, 4)])):
    for x in xs:
        if abs(x) < 0.9 and row_y < PIT_Y + 2.0:
            continue
        p = Vector((x, row_y, PIT_Z))
        to = (COND - p); to.z = 0; to.normalize()
        stand(p + to * 0.62, -to)
        if 'musicians' in SPR:
            # A player, facing the conductor (their own chair is in the picture):
            # seen in the face from the house, as a shaded back from the stage.
            k = len(PLAYERS)
            idx = BAND[k % len(BAND)]
            PLAYERS.append(k)
            with part(f'Band{k % 3}', (0, PIT_Y + 2.0, PIT_Z)):
                sprite('musicians', idx, p - to * 0.1, to, BAND_H.get(idx, 1.25), mirror=k >= len(BAND), backs=True)
        else:
            chair(p, math.atan2(-to.x, to.y))
if 'musicians' in SPR:
    with part('Conductor', COND + Vector((0, 0, 0.32))):      # on the podium, facing the stage
        sprite('musicians', 4, COND + Vector((0, 0, 0.32)), (0, 1, 0), 1.35, backs=True)
box('wood_dark', COND + Vector((0, 0, 0.16)), (1.0, 0.9, 0.32))
tube('brass', COND + Vector((-0.45, -0.4, 0.32)), COND + Vector((-0.45, -0.4, 1.25)), 0.015, segs=6)
tube('brass', COND + Vector((0.45, -0.4, 0.32)), COND + Vector((0.45, -0.4, 1.25)), 0.015, segs=6)
tube('brass', COND + Vector((-0.45, -0.4, 1.25)), COND + Vector((0.45, -0.4, 1.25)), 0.015, segs=6)
stand(COND + Vector((0, 0.62, 0)), (0, -1, 0), big=True, h=0.80)      # the score, low enough not to hide the conductor from the stage
HARP = Vector((-5.5, PIT_Y + 0.9, PIT_Z))
tube('gold', HARP, HARP + Vector((0, 0, 1.75)), 0.035, 0.03, segs=8)
neck = [HARP + Vector((0, 0, 1.75)), HARP + Vector((0.25, 0, 1.82)), HARP + Vector((0.55, 0, 1.62)), HARP + Vector((0.85, 0, 1.55))]
rope('gold', neck, 0.03, segs=6)
beam('wood', HARP + Vector((0.88, 0, 1.55)), HARP + Vector((0.12, 0, 0.12)), 0.20, 0.07)
box('wood', HARP + Vector((0.1, 0, 0.05)), (0.5, 0.32, 0.10))
for k in range(14):
    t = (k + 1) / 15
    top_p = HARP + Vector((0.08 + 0.74 * t, 0, 1.76 - 0.2 * t + 0.07 * math.sin(t * math.pi)))
    bot_p = HARP + Vector((0.88, 0, 1.55)).lerp(Vector((0.12, 0, 0.12)), 1 - t)
    tube('string', top_p, bot_p, 0.0018, segs=3)
for x, r in (() if 'musicians' in SPR else ((5.3, 0.36), (4.45, 0.32))):     # kettle drums, when no player brings their own
    c = Vector((x, PIT_Y + 0.95 + (0.3 if r < 0.35 else 0), PIT_Z))
    lathe('copper', [(0.04, 0.42), (r * 0.6, 0.48), (r * 0.92, 0.66), (r, 0.86)], c, segs=18)
    lathe('cream', [(0.0, 0.865), (r, 0.865)], c, segs=18)
    tube('brass', c + Vector((0, 0, 0.855)), c + Vector((0, 0, 0.875)), r + 0.01, segs=18)
    for k in range(3):
        a = k * 2 * math.pi / 3
        tube('iron', c + Vector((r * 0.5 * math.cos(a), r * 0.5 * math.sin(a), 0.55)),
             c + Vector((r * 0.9 * math.cos(a), r * 0.9 * math.sin(a), 0)), 0.012, segs=5)

# ════════════════════════════════════════════════════════════════════════
# The auditorium
# ════════════════════════════════════════════════════════════════════════
log("auditorium")


def horseshoe():
    """The line of the tier fronts, in points an equal distance apart, with
    its outward normals and the distance run."""
    N = 100
    arm = lambda y: HR - CONV * ((y - HCY) / (HOUSE_Y - HCY)) ** 2
    d = [(arm(HOUSE_Y + (HCY - HOUSE_Y) * k / N), HOUSE_Y + (HCY - HOUSE_Y) * k / N) for k in range(N)]
    d += [(HR * math.cos(math.pi * k / (2 * N)), HCY - HR * math.sin(math.pi * k / (2 * N))) for k in range(2 * N + 1)]
    d += [(-arm(HCY + (HOUSE_Y - HCY) * k / N), HCY + (HOUSE_Y - HCY) * k / N) for k in range(1, N + 1)]
    run = [0.0]
    for a, b in zip(d[:-1], d[1:]):
        run.append(run[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    n = NB * SEG + 1
    pts = []; j = 0
    for i in range(n):
        s = run[-1] * i / (n - 1)
        while j < len(run) - 2 and run[j + 1] < s:
            j += 1
        t = (s - run[j]) / max(1e-9, run[j + 1] - run[j])
        pts.append(Vector((d[j][0] + (d[j + 1][0] - d[j][0]) * t, d[j][1] + (d[j + 1][1] - d[j][1]) * t)))
    out = []
    for i in range(n):
        t = (pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized()
        out.append((pts[i], Vector((-t.y, t.x)), run[-1] * i / (n - 1)))
    return out


CURVE = horseshoe()
NP = len(CURVE)


def cv(i, off, z):
    p, n, _ = CURVE[i]
    return Vector((p.x + n.x * off, min(HOUSE_Y - 0.02, p.y + n.y * off), z))     # never through the proscenium wall


def line(off, z):
    return [cv(i, off, z) for i in range(NP)]


UB = [i / SEG for i in range(NP)]                              # in bays
UL = lambda tile: [CURVE[i][2] / tile for i in range(NP)]      # in metres

# Stalls: the raked floor, the wall under the first tier, the seats.
xs = [-13 + 2 * k for k in range(14)]
ys = [PIT_Y - 1.5 * k for k in range(15)]
mb('carpet').grid([[Vector((x, y, zs(y))) for x in xs] for y in ys], [[(x / 1.5, y / 1.5) for x in xs] for y in ys], False)
ribbon('wall', line(DEPTH, STALLS_Z - 0.2), line(DEPTH, TIERS[0] - SLAB), UB, 0, 1)


def seat(pos, yaw):
    with place(pos, yaw):
        box('velvet', (0, -0.22, 0.66), (0.50, 0.09, 0.60), tile=1.0)
        box('wood_dark', (0, -0.22, 0.98), (0.53, 0.11, 0.05))
        box('velvet', (0, 0.0, 0.43), (0.46, 0.42, 0.10), tile=1.0)
        for sx in (-0.265, 0.265):
            box('wood_dark', (sx, -0.03, 0.33), (0.04, 0.50, 0.66))


FOCUS = Vector((0.0, 2.0))
# The audience: cut-out figures, each in one of a few groups that move a
# little differently, so no two neighbours bob in step.
CROWD = 8
MEMBERS = []


def member(foot, to, h):
    """An opera-goer whose picture stands on `foot`, facing along `to` (toward the stage)."""
    n = Vector((to.x, to.y, 0))
    with part(f'Crowd{random.randrange(CROWD)}', (0, HCY, 0)):
        sprite('audience', random.randrange(len(SPR['audience'])), Vector(foot) + n * 0.02, n, h,
               mirror=random.random() < 0.5, backs=True)
    MEMBERS.append(Vector(foot))


n_seats = 0
rho = 12.4
while 2.0 - rho > -27.5:
    step = 0.57 / rho
    k = 0
    while k * step < 1.2:
        for sgn in ((1,) if k == 0 else (-1, 1)):
            a = sgn * (k + 0.5) * step + (0.62 / rho) * sgn
            x, y = rho * math.sin(a), 2.0 - rho * math.cos(a)
            if y < PIT_Y - 0.9 and in_house(x, y, 1.15):
                to = Vector((FOCUS.x - x, FOCUS.y - y)).normalized()
                seat((x, y, zs(y)), math.atan2(-to.x, to.y))
                n_seats += 1
                if 'audience' in SPR and random.random() < 0.86:
                    member((x, y, zs(y) + 0.50), to, 0.72)
        k += 1
    rho += 0.95
log(f"{n_seats} stalls seats")

for li, F in enumerate(TIERS):
    top = TIERS[li + 1] - SLAB if li < len(TIERS) - 1 else CORNICE_Z
    ribbon('tier', line(0, F - SLAB), line(0, F + 0.85), UB, 0, 1)
    ribbon('velvet', line(-0.07, F + 0.86), line(0.17, F + 0.86), UL(1.0), 0, 0.24)
    ribbon('velvet', line(-0.07, F + 0.79), line(-0.07, F + 0.86), UL(1.0), 0, 0.07)
    ribbon('carpet', line(0, F), line(DEPTH, F), UL(1.5), 0, DEPTH / 1.5)
    ribbon('plaster', line(0, F - SLAB), line(DEPTH, F - SLAB), UL(3.0), 0, DEPTH / 3.0)
    ribbon('wall', line(DEPTH, F), line(DEPTH, top), UB, 0, 1)
    for off in (0.95, 1.95):                                    # two rows of seats, as bands
        ribbon('velvet', line(off, F), line(off, F + 0.98), UL(1.0), 0, 0.98)
        ribbon('velvet', line(off - 0.44, F + 0.45), line(off, F + 0.45), UL(1.0), 0, 0.44)
        ribbon('wood_dark', line(off - 0.44, F), line(off - 0.44, F + 0.45), UL(1.0), 0, 0.45)
    for b in range(NB + 1):
        i = b * SEG
        p, n, _ = CURVE[i]
        n3 = Vector((n.x, n.y, 0)); t3 = Vector((-n.y, n.x, 0))
        tube('gold', cv(i, 0.05, F + 0.86), cv(i, 0.05, top), 0.055, segs=8)
        lathe('gold', [(0.055, 0.0), (0.12, 0.13), (0.13, 0.18)], cv(i, 0.05, top - 0.18), segs=8)
        lathe('gold', [(0.10, 0.0), (0.09, 0.06), (0.055, 0.10)], cv(i, 0.05, F + 0.86), segs=8)
        if li == 0:
            mb('partition').face([cv(i, 0.22, F), cv(i, DEPTH, F), cv(i, DEPTH, top), cv(i, 0.22, top)],
                                 [(0, 0), (1, 0), (1, 1), (0, 1)])
        elif li == 1:
            mb('partition').face([cv(i, 0.22, F), cv(i, DEPTH, F), cv(i, DEPTH, F + 1.25), cv(i, 0.22, F + 1.25)],
                                 [(0, 0), (1, 0), (1, 1), (0, 1)])
        if 0 < b < NB:                                          # sconce: three globes on a bracket
            c = cv(i, -0.20, F + 0.52)
            tube('brass', cv(i, 0.0, F + 0.30), c + Vector((0, 0, -0.10)), 0.014, segs=5)
            tube('brass', c + Vector((0, 0, -0.10)) - t3 * 0.16, c + Vector((0, 0, -0.10)) + t3 * 0.16, 0.012, segs=5)
            for dt, dz in ((-0.16, 0.0), (0.0, 0.07), (0.16, 0.0)):
                tube('brass', c + t3 * dt + Vector((0, 0, -0.10)), c + t3 * dt + Vector((0, 0, dz - 0.05)), 0.01, segs=5)
                sphere('globe', c + t3 * dt + Vector((0, 0, dz)), 0.062, segs=8, rings=5)
            card('glow', cv(i, -0.34, F + 0.56), -n3, 1.25, 1.25)
ribbon('gold', line(DEPTH - 0.02, CORNICE_Z), line(DEPTH - 0.25, CEIL_Z), UL(0.5), 0, 0.9)
# The tiers' front rows, leaning on the rail.
if 'audience' in SPR:
    run = CURVE[-1][2]
    for F in TIERS:
        s = 0.45
        while s < run - 0.45:
            f = s / run * (NP - 1)
            i = min(NP - 2, int(f))
            p = cv(i, 0.5, F + 0.58).lerp(cv(i + 1, 0.5, F + 0.58), f - i)
            if 0.07 < (s / run * NB) % 1 < 0.93 and random.random() < 0.8:        # not behind a column
                member(p, Vector((FOCUS.x - p.x, FOCUS.y - p.y)).normalized(), 0.68)
            s += 0.72
    log(f"{len(MEMBERS)} in the audience")
# What rises from the crowd: reaction icons floating up, the pop of a camera
# flash here and there, and now and then a rose thrown onto the stage.
EMOTES = []; FLASHES = []; ROSES = []
ICON_ROSE = 5
if 'emotes' in SPR and MEMBERS:
    for k in range(20):
        c = random.choice(MEMBERS) + Vector((0, 0, 1.1))
        EMOTES.append(f'Emote{k}')
        with part(EMOTES[-1], c):
            sprite('emotes', random.choice([i for i in range(len(SPR['emotes'])) if i != ICON_ROSE]), c,
                   (FOCUS.x - c.x, FOCUS.y - c.y, 0), 0.7, centre=True)
    for k in range(16):
        c = random.choice(MEMBERS) + Vector((0, 0, 0.55))
        FLASHES.append(f'Flash{k}')
        with part(FLASHES[-1], c):
            halo('glow_white', c, 0.9)
    for k, (x0, x1) in enumerate(((-4.5, -2.4), (1.0, 0.3), (5.0, 2.6))):
        land = Vector((x1, APRON_Y + 0.75, 0.2))
        start = Vector((x0, PIT_Y - 2.5 - k, zs(PIT_Y - 2.5 - k) + 1.3))
        ROSES.append((f'Rose{k}', start - land))
        with part(f'Rose{k}', land):
            sprite('emotes', ICON_ROSE, land, (0, 1, 0), 0.42, centre=True)

# Ceiling: a flat plaster field round a shallow painted dome.
NA = 64
dome_ring = [Vector((DOME.x + DOME_R * math.cos(2 * math.pi * k / NA), DOME.y + DOME_R * math.sin(2 * math.pi * k / NA), CEIL_Z))
             for k in range(NA + 1)]
far = []
for p in dome_ring:
    dx, dy = p.x - DOME.x, p.y - DOME.y
    s = min(13.5 / abs(dx) if abs(dx) > 1e-6 else 1e9,
            ((HOUSE_Y - DOME.y) / dy) if dy > 1e-6 else ((-31.0 - DOME.y) / dy if dy < -1e-6 else 1e9))
    far.append(Vector((DOME.x + dx * s, DOME.y + dy * s, CEIL_Z)))
m = mb('plaster')
for a, b, c, d in zip(dome_ring[:-1], dome_ring[1:], far[1:], far[:-1]):
    m.face([a, b, c, d], [(p.x / 3.0, p.y / 3.0) for p in (a, b, c, d)])
NR = 8
P = []; UV = []
for j in range(NR + 1):
    r = j / NR
    row = []; uvr = []
    for k in range(NA + 1):
        a = 2 * math.pi * k / NA
        row.append(Vector((DOME.x + DOME_R * r * math.cos(a), DOME.y + DOME_R * r * math.sin(a),
                           CEIL_Z + DOME_RISE * (1 - r * r))))
        uvr.append((0.5 + 0.5 * r * math.cos(a), 0.5 + 0.5 * r * math.sin(a)))
    P.append(row); UV.append(uvr)
mb('ceiling').grid(P, UV)
rope('gold', [p + Vector((0, 0, -0.02)) for p in dome_ring], 0.09, segs=6)

# The chandelier.
log("chandelier")
CH_TOP = Vector((DOME.x, DOME.y, CEIL_Z + DOME_RISE))
with part('Chandelier', CH_TOP):
    c0 = Vector((DOME.x, DOME.y, 0))
    tube('brass', CH_TOP, c0 + Vector((0, 0, 9.95)), 0.022, segs=6)
    lathe('brass', [(0.0, 9.95), (0.10, 9.90), (0.06, 9.70), (0.20, 9.45), (0.26, 9.25), (0.10, 9.05), (0.14, 8.75),
                    (0.05, 8.45), (0.0, 8.40)], c0, segs=14)
    sphere('crystal', c0 + Vector((0, 0, 8.26)), 0.15, segs=8, rings=4)
    for R, z, n, drop in ((1.75, 8.75, 18, 0.5), (1.05, 9.35, 12, 0.35)):
        rope('brass', ring(c0 + Vector((0, 0, z)), R, 36), 0.025, segs=5)
        for k in range(n):
            a = 2 * math.pi * k / n
            d = Vector((math.cos(a), math.sin(a), 0))
            p = c0 + d * R + Vector((0, 0, z))
            if k % 2 == 0:                                      # an arm in from the stem
                rope('brass', sag(c0 + d * 0.16 + Vector((0, 0, z + 0.35)), p, 0.16, 6), 0.014, segs=5)
            lathe('brass', [(0.0, 0.0), (0.05, 0.02), (0.02, 0.05)], p, segs=8)
            tube('cream', p + Vector((0, 0, 0.04)), p + Vector((0, 0, 0.20)), 0.016, segs=6)
            lathe('flame', [(0.0, 0.0), (0.016, 0.02), (0.013, 0.045), (0.0, 0.08)], p + Vector((0, 0, 0.20)), segs=6)
            halo('glow', p + Vector((0, 0, 0.24)), 0.42)
            for t in (0.25, 0.5, 0.75):                         # crystal swags from candle to candle
                a2 = 2 * math.pi * (k + t) / n
                q = c0 + Vector((math.cos(a2), math.sin(a2), 0)) * R + Vector((0, 0, z - drop * 4 * t * (1 - t) * 0.5 - 0.04))
                sphere('crystal', q, 0.028, segs=4, rings=2, sz=1.4)
            sphere('crystal', p + Vector((0, 0, -0.10)), 0.032, segs=4, rings=2, sz=1.8)
    halo('glow', c0 + Vector((0, 0, 9.0)), 6.5)

# ════════════════════════════════════════════════════════════════════════
# Finalise meshes
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
COLL = bpy.data.collections.new('OperaHouse'); SCN.collection.children.link(COLL)
EXPORT = []
PARTS = {}
for name, pivot in PIVOT.items():
    e = bpy.data.objects.new(name, None)
    e.location = pivot
    COLL.objects.link(e)
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
    COLL.objects.link(ob)
    if pname:
        ob.parent = PARTS[pname]
    EXPORT.append(ob)
EXPORT += CURTAINS
tri = sum(len(o.data.polygons) for o in EXPORT if o.type == 'MESH')
log(f"{len(EXPORT)} objects, {tri} polys")

# ════════════════════════════════════════════════════════════════════════
# The navigation mesh: the stage floor, less everything that stands on it
# ════════════════════════════════════════════════════════════════════════
I = INSET
WALK = [                                                       # (x0, x1, y0, y1), already drawn in
    (RAIL_X + 0.15 + I, SW - I, PROS_Y + I, 3.6 - I),                       # the stage, fly rail to wall, up to the quay's set pieces
    (-PROS_HW + I, PROS_HW - I, FOOT_Y + 0.11 + I, PROS_Y + I),             # through the proscenium
    (-APRON_HW + I, APRON_HW - I, FOOT_Y + 0.11 + I, HOUSE_Y - I),          # the apron
]
BLOCK = [                                                      # (x0, x1, y0, y1), drawn out
    (GHOST.x - 0.22 - I, GHOST.x + 0.22 + I, GHOST.y - 0.22 - I, GHOST.y + 0.22 + I),
    (DESK.x - 0.40 - I, DESK.x + 1.05 + I, DESK.y - 0.72 - I, DESK.y + 0.72 + I),
]
for sgn in (-1, 1):
    a, b = sorted((sgn * 4.35, sgn * 6.3))
    BLOCK.append((a - I if sgn > 0 else a, b if sgn > 0 else b + I, CUR_Y - 0.30 - I, CUR_Y + 0.20 + I))   # the drawn curtain
    for y in LEG_Y:
        a, b = sorted((sgn * 6.6, sgn * 9.0))
        BLOCK.append((a - I, b + I, y - 0.12 - I, y + 0.12 + I))                                            # the legs
gx = sorted({v for r in WALK + BLOCK for v in r[:2]})
gy = sorted({v for r in WALK + BLOCK for v in r[2:]})
inside = lambda rects, x, y: any(r[0] < x < r[1] and r[2] < y < r[3] for r in rects)
nv = {}; nverts = []; nfaces = []


def nvert(x, y):
    if (x, y) not in nv:
        nv[(x, y)] = len(nverts); nverts.append((x, y, 0.0))
    return nv[(x, y)]


for x0, x1 in zip(gx[:-1], gx[1:]):
    for y0, y1 in zip(gy[:-1], gy[1:]):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if inside(WALK, cx, cy) and not inside(BLOCK, cx, cy):
            nfaces.append((nvert(x0, y0), nvert(x1, y0), nvert(x1, y1), nvert(x0, y1)))
me = bpy.data.meshes.new('Stage-navmesh')
me.from_pydata(nverts, [], nfaces)
NAV = bpy.data.objects.new('Stage-navmesh', me)
COLL.objects.link(NAV)
EXPORT.append(NAV)
log(f"navmesh: {len(nfaces)} cells")

# ════════════════════════════════════════════════════════════════════════
# Animation: one loop
# ════════════════════════════════════════════════════════════════════════
log("animation")
SCN.render.fps = FPS
SCN.frame_start = 0
SCN.frame_end = NF
W = lambda period, phase=0.0: (lambda t: math.sin(2 * math.pi * t / period + phase))


def animate(ob, fn):
    """fn(t) → {'loc': offset, 'rot': euler, 'scale': s} for each frame of the loop."""
    base = ob.location.copy()
    for f in range(NF + 1):
        r = fn(f / FPS)
        if 'loc' in r:
            ob.location = base + Vector(r['loc']); ob.keyframe_insert('location', frame=f)
        if 'rot' in r:
            ob.rotation_euler = r['rot']; ob.keyframe_insert('rotation_euler', frame=f)
        if 'scale' in r:
            ob.scale = (r['scale'],) * 3; ob.keyframe_insert('scale', frame=f)


# The wave machine: each row slides against its neighbours and lifts a little.
for k, ph in enumerate((0.0, math.pi, 0.6 * math.pi)):
    animate(PARTS[f'Waves{k + 1}'], lambda t, ph=ph: {'loc': (0.30 * W(6, ph)(t), 0, 0.03 + 0.03 * W(3, ph)(t))})
# The ship rides them: rocking, rising, and working slowly across the bay.
animate(PARTS['Ship'], lambda t: {'loc': (1.1 * W(36)(t), 0, 0.07 * W(6, 2.0)(t)),
                                  'rot': (0, math.radians(3.5) * W(6, 0.5)(t), 0)})
for k, ph in enumerate((0.0, 2.1)):
    animate(PARTS[f'Cloud{k + 1}'], lambda t, ph=ph: {'rot': (0, math.radians(0.5) * W(18, ph)(t), 0)})
animate(PARTS['MoonGlow'], lambda t: {'scale': 1 + 0.05 * W(9)(t)})
animate(PARTS['GhostGlow'], lambda t: {'scale': 1 + 0.06 * W(4)(t)})
animate(PARTS['Chandelier'], lambda t: {'rot': (math.radians(0.45) * W(SWING)(t), math.radians(0.3) * W(SWING, 1.3)(t), 0)})
for k, name in enumerate(BAGS):
    animate(PARTS[name], lambda t, k=k: {'rot': (math.radians(0.55) * W(SWING, 1.7 * k)(t), 0, 0)})
for name, turns, ph in (('MotesA', 1, 0.0), ('MotesB', -1, 1.0), ('MotesC', 2, 2.0)):
    animate(PARTS[name], lambda t, turns=turns, ph=ph: {'rot': (0, 0, 2 * math.pi * turns * t / LOOP),
                                                        'loc': (0, 0, 0.12 * W(12, ph)(t))})


for k, name in enumerate(GULLS):                               # gulls swing on their wires
    animate(PARTS[name], lambda t, k=k: {'rot': (0, math.radians(2.2) * W(SWING, 2.0 * k)(t), 0),
                                         'loc': (0, 0, 0.10 * W(4, 1.3 * k)(t))})
if LAMP is not None:
    animate(PARTS['LanternGlow'], lambda t: {'scale': 1 + 0.07 * W(3)(t) + 0.04 * W(2, 1.0)(t)})

# The pit: three desks of players swaying to their own bowing, the conductor beating two seconds to the bar.
if PLAYERS:
    for g in range(3):
        animate(PARTS[f'Band{g}'], lambda t, g=g: {'loc': (0.012 * W((2, 3, 4)[g], g)(t), 0, 0.006 + 0.006 * W(3, 2.0 * g)(t))})
    animate(PARTS['Conductor'], lambda t: {'rot': (0, math.radians(5) * W(2)(t), 0), 'loc': (0, 0, 0.012 + 0.012 * W(1)(t))})


def crowd(g):
    """One group of the audience: a small bob of its own, and every twelve
    seconds a cheer that runs through the house group by group."""
    per, ph = (2, 3, 4, 6)[g % 4], 0.8 * g

    def fn(t):
        z = 0.011 + 0.011 * W(per, ph)(t)
        u = ((t - 5.0 - 0.16 * g) % 12.0) / 0.55
        if u < 1:
            z += 0.15 * math.sin(math.pi * u)
        return {'loc': (0.012 * W(4, ph)(t), 0, z)}
    return fn


def emote(period, start):
    """A reaction icon: pops up over the crowd, floats up, fades (by shrinking)."""
    def fn(t):
        u = ((t + start) % period) / period
        s = u / 0.1 if u < 0.1 else 1.0 if u < 0.65 else (0.88 - u) / 0.23
        return {'loc': (0.12 * math.sin(4 * math.pi * u), 0, 1.7 * u), 'scale': max(0.001, s)}
    return fn


def rose(away, start):
    """A rose from the stalls: a second and a half in the air, a while on the stage, gone."""
    def fn(t):
        u = (t - start) % 18.0
        if u < 1.5:
            s = u / 1.5
            return {'loc': tuple(away * (1 - s) + Vector((0, 0, 3.0 * 4 * s * (1 - s)))),
                    'rot': (0, 4 * math.pi * s, 0), 'scale': 1.0}
        if u < 8.0:
            return {'loc': (0, 0, 0), 'rot': (0, 0, 0), 'scale': 1.0 if u < 7.5 else max(0.001, (8.0 - u) / 0.5)}
        return {'loc': tuple(away), 'rot': (0, 0, 0), 'scale': 0.001}
    return fn


if MEMBERS:
    for g in range(CROWD):
        if f'Crowd{g}' in PARTS:
            animate(PARTS[f'Crowd{g}'], crowd(g))
for k, name in enumerate(EMOTES):
    animate(PARTS[name], emote((6, 9, 12)[k % 3], random.random() * 12))
for name in FLASHES:
    pops = [random.randrange(NF - 6) / FPS for _ in range(2)]
    animate(PARTS[name], lambda t, pops=pops: {'scale': 1.0 if any(0 <= t - p < 0.17 for p in pops) else 0.001})
for k, (name, away) in enumerate(ROSES):
    animate(PARTS[name], rose(away, 6.0 * k))


def cue(t):
    """Twelve seconds: standby flashes red, go holds green, dark."""
    t = t % 12.0
    red = t < 4.5 and (t % 1.0) < 0.5
    green = 4.5 <= t < 8.0
    return red, green


animate(PARTS['CueRed'], lambda t: {'scale': 1.0 if cue(t)[0] else 0.001})
animate(PARTS['CueGreen'], lambda t: {'scale': 1.0 if cue(t)[1] else 0.001})
for ob, ph in zip(CURTAINS, (0.0, 1.9)):
    kb = ob.data.shape_keys.key_blocks
    for f in range(NF + 1):
        t = f / FPS
        kb['SwayA'].value = math.cos(2 * math.pi * t / 12 + ph); kb['SwayA'].keyframe_insert('value', frame=f)
        kb['SwayB'].value = math.sin(2 * math.pi * t / 12 + ph); kb['SwayB'].keyframe_insert('value', frame=f)
SCN.frame_set(0)

# ════════════════════════════════════════════════════════════════════════
# Export
# ════════════════════════════════════════════════════════════════════════
bpy.ops.object.select_all(action='DESELECT')
for o in EXPORT:
    o.select_set(True)
bpy.context.view_layer.objects.active = EXPORT[0]
glb = os.path.join(OUT, 'opera_house.glb')
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
if SAVE_BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'opera_house.blend'))
    log("saved .blend")
log("done")
