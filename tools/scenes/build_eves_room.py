"""Build Eve's Room and export it as a GLB background (step 2 of 2).

    python3 eves_room/paint_textures.py <tex_dir>
    blender -b --factory-startup --python build_eves_room.py -- <out_dir> <tex_dir> [blend]

The room over the harbour records office: one long attic under the roof,
gable to gable. The window in the far gable looks over the harbour at blue
hour; the television and the fish tank are to its left, the desk and the
evidence board to its right, the kitchen along the right-hand wall, the bed
in the near left corner. Evie's things are everywhere; Evie herself is in
the app's toy box (the cat among its pets), not built in.

Blender coords (scene_kit.py): Z up, spawn at the origin facing -Y, the
window wall at +Y. Walls and ceiling are one-sided, so a camera that backs
out through one still sees the room. What moves: the television's pictures,
the fish, the fairy lights, steam, curtains, the clock's pendulum, the
record, the lamps and plants that hang, and outside the lighthouse and gulls.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_kit as kit
from scene_kit import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = argv[0] if argv else os.path.join(HERE, 'eves_room', 'out')
kit.init('room', OUT, argv[1] if len(argv) > 1 else os.path.join(OUT, 'textures'), fps=12, loop=36.0, seed=7)

# ════════════════════════════════════════════════════════════════════════
# Layout
# ════════════════════════════════════════════════════════════════════════
HW = 5.0              # half the room's width, wall to wall
BACK = 3.6            # the window gable
FRONT = -4.4          # the door gable
EAVE = 2.25           # where the roof meets the side walls
RIDGE = 4.75
SLOPE = (RIDGE - EAVE) / HW
WIN_HW = 1.4          # the window: half its width, its sill, its head
SILL = 0.62
WIN_TOP = 3.0
DADO = 0.95           # top of the panelling
INSET = 0.3           # navmesh clearance: about a body's half width (the app keeps 0.25 m for the shoulders)
# The view: a picture 12 m wide bent in a half circle round the window (so no angle through the
# window finds its edge), its horizon at eye height.
VIEW_W = 12.0
VIEW_R = VIEW_W / math.pi
VIEW_LAMP = math.radians(14.4)  # the lighthouse's bearing from the window: just right of the companion, seen from the spawn
VIEW_FOLD = 0.87      # past the picture's right-hand edge it is laid again, mirrored, back to here (short of the lighthouse)
VIEW_SKY = 0.25       # the picture carries that much more sky above its own top (paint_textures.py)
HORIZON = 1.5
# The harbour picture: where its horizon and the lighthouse's lamp are (fractions from the left, from the top).
PIC_HORIZON = 0.42
PIC_LAMP = (0.819, 0.286)
ROD_Z = 3.12
N = Vector((0, -1, 0))        # what faces the room from the window wall
S = Vector((0, 1, 0))         # … from the door wall
E = Vector((1, 0, 0))         # … from the left wall
Wst = Vector((-1, 0, 0))      # … from the right wall


def roof(x):
    return RIDGE - SLOPE * abs(x)


# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
log("materials")
M['floor'] = make_mat('FloorBoards', img='floor', nrm='floor_n', rough=0.6, glow=0.10)
M['wall'] = make_mat('Plaster', img='wall', rough=0.9, glow=0.30, single=True)
M['wall_blue'] = make_mat('PlasterBlue', img='wall_blue', rough=0.9, glow=0.30, single=True)
M['wainscot'] = make_mat('Panelling', img='wainscot', rough=0.7, glow=0.26, single=True)
M['ceiling'] = make_mat('CeilingBoards', img='ceiling', rough=0.8, glow=0.30, single=True)
for key, name, g in (('oak', 'Oak', 0.16), ('walnut', 'Walnut', 0.14), ('white_wood', 'WhitePaint', 0.30), ('beam', 'Beam', 0.14),
                     ('basket', 'Wicker', 0.2), ('sisal', 'Sisal', 0.2), ('tiles', 'Tiles', 0.28), ('spines', 'Books', 0.2),
                     ('knit_blue', 'KnitBlue', 0.24), ('knit_cream', 'KnitCream', 0.26), ('rug', 'Rug', 0.2),
                     ('quilt', 'Quilt', 0.26), ('vinyl', 'Record', 0.1), ('hob', 'Hob', 0.12), ('file', 'EvidenceFile', 0.3),
                     ('chart', 'Chart', 0.4), ('evidence', 'EvidenceBoard', 0.42), ('fridge', 'FridgeDoor', 0.32),
                     ('clock', 'ClockFace', 0.4), ('door', 'Door', 0.3), ('cabinet', 'CabinetDoor', 0.24),
                     ('wardrobe', 'WardrobeDoor', 0.28), ('coat_white', 'LabCoat', 0.32), ('coat_yellow', 'Raincoat', 0.3)):
    M[key] = make_mat(name, img=key, rough=0.8, glow=g)
for c in ('oat', 'teal', 'coral', 'mustard', 'white', 'navy', 'pink', 'sage', 'grey'):
    M['linen_' + c] = make_mat('Linen' + c.capitalize(), img='linen_' + c, rough=0.95, spec=0.2, glow=0.24)
M['sheer'] = make_mat('Sheer', img='sheer', rough=0.9, spec=0.2, glow=0.5)
M['harbour'] = make_mat('HarbourView', img='harbour', rough=1.0, spec=0.0, glow=0.9, single=True)
M['night'] = make_mat('Night', img='night', rough=1.0, spec=0.0, glow=0.9, single=True)
M['quay'] = make_mat('QuayDark', img='quay', rough=1.0, spec=0.0, glow=0.9, single=True)
M['sky'] = make_mat('SkyPane', img='sky', rough=0.3, glow=0.85, single=True)
M['pictures'] = make_mat('Pictures', img='pictures', rough=0.6, glow=0.5, alpha='MASK', single=True)
M['tv'] = make_mat('TvPicture', img='tv', rough=0.4, glow=1.0)
M['screen'] = make_mat('LaptopScreen', img='screen', rough=0.4, glow=1.0)
M['tank'] = make_mat('TankBack', img='tank', rough=0.6, glow=0.9)
M['plants'] = make_mat('Plants', img='plants', rough=0.9, spec=0.1, glow=0.3, alpha='MASK')
M['fish'] = make_mat('Fish', img='fish', rough=0.6, glow=0.75, alpha='MASK')
M['things'] = make_mat('Things', img='things', rough=0.8, glow=0.35, alpha='MASK')
M['braided'] = make_mat('BraidedRug', img='braided', rough=1.0, spec=0.1, glow=0.2, alpha='MASK')
M['gull'] = make_mat('Gull', img='gull', rough=1.0, spec=0.0, glow=0.5, alpha='MASK')
M['shade'] = make_mat('LampShade', img='shade', rough=0.9, glow=1.0)
M['shade_green'] = make_mat('BankerShade', img='shade_green', rough=0.3, glow=0.9)
for key in ('glow', 'glow_soft', 'glow_white', 'steam'):
    M[key] = make_mat(key.capitalize(), color=(0, 0, 0), img=key, rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['bulb'] = make_mat('Bulb', color=(1.0, 0.9, 0.7), glow=1.0, glow_color=(1.0, 0.86, 0.58))
M['flame'] = make_mat('Flame', color=(1.0, 0.9, 0.6), glow=1.0, glow_color=(1.0, 0.80, 0.45))
M['wire'] = make_mat('Wire', color=(0.10, 0.12, 0.10), rough=0.8)
M['brass'] = make_mat('Brass', color=(0.80, 0.60, 0.28), rough=0.3, glow=0.28)
M['iron'] = make_mat('BlackIron', color=(0.08, 0.08, 0.09), rough=0.5, glow=0.03)
M['steel'] = make_mat('Steel', color=(0.72, 0.74, 0.76), rough=0.3, glow=0.2)
M['black'] = make_mat('Black', color=(0.02, 0.02, 0.025), rough=0.4)
M['mint'] = make_mat('MintEnamel', color=(0.74, 0.87, 0.80), rough=0.3, glow=0.3)
M['teal_paint'] = make_mat('TealPaint', color=(0.36, 0.55, 0.57), rough=0.6, glow=0.24)
M['paper'] = make_mat('Paper', color=(0.93, 0.90, 0.80), rough=0.9, glow=0.34)
M['kraft'] = make_mat('Kraft', color=(0.80, 0.66, 0.44), rough=0.9, glow=0.26)
M['terracotta'] = make_mat('Terracotta', color=(0.76, 0.42, 0.28), rough=0.9, glow=0.2)
M['sand'] = make_mat('Gravel', color=(0.78, 0.68, 0.50), rough=1.0, glow=0.5)
M['water'] = make_mat('Water', color=(0.55, 0.78, 0.90), rough=0.1, glow=0.4)
M['coffee'] = make_mat('Coffee', color=(0.20, 0.11, 0.06), rough=0.3, glow=0.1)
M['kibble'] = make_mat('Kibble', color=(0.50, 0.32, 0.18), rough=0.9, glow=0.15)
M['biscuit'] = make_mat('Biscuit', color=(0.84, 0.62, 0.34), rough=0.9, glow=0.22)
M['glass_jar'] = make_mat('JarGlass', color=(0.80, 0.90, 0.88), rough=0.1, glow=0.3)
for key, colour in (('white', (0.95, 0.94, 0.90)), ('teal', (0.30, 0.56, 0.58)), ('coral', (0.90, 0.48, 0.40)),
                    ('mustard', (0.88, 0.68, 0.26)), ('navy', (0.20, 0.28, 0.46)), ('pink', (0.94, 0.70, 0.74)),
                    ('orange', (0.94, 0.56, 0.16)), ('red', (0.80, 0.20, 0.18)), ('lemon', (0.96, 0.84, 0.30)),
                    ('green', (0.42, 0.62, 0.36))):
    M['c_' + key] = make_mat('Glaze' + key.capitalize(), color=colour, rough=0.35, glow=0.26)


# ════════════════════════════════════════════════════════════════════════
# The room's own shapes
# ════════════════════════════════════════════════════════════════════════
def wood(c, size, key='oak', R=None, tile=0.9):
    box(key, c, size, R, tile=tile)


def gable(key, y, facing, holes=(), z0=0.0, top=None, x0=-HW, x1=HW, tile=2.0):
    """An end wall up to the roof (or to `top`), less rectangular holes
    (x0, x1, z0, z1)."""
    xs = sorted({x0, x1} | ({0.0} if x0 < 0 < x1 else set()) | {v for h in holes for v in h[:2]})
    for xa, xb in zip(xs[:-1], xs[1:]):
        z = z0
        for lo, hi in sorted((h[2], h[3]) for h in holes if h[0] <= xa and h[1] >= xb) + [(None, None)]:
            ta, tb = (lo, lo) if lo is not None else ((top, top) if top else (roof(xa), roof(xb)))
            if max(ta, tb) > z + 1e-6:
                poly(key, [(xa, y, z), (xb, y, z), (xb, y, tb), (xa, y, ta)], tile, (0, 2), facing)
            if lo is None:
                break
            z = hi


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


def standing(idx, foot, normal, w, key='brass'):
    """A framed photograph standing on a shelf or table."""
    h = w / SPR['pictures'][idx]['aspect']
    n = Vector(normal).normalized()
    c = Vector(foot) + Vector((0, 0, h / 2 + 0.025))
    frame(idx, c, n, w, key, border=0.022, depth=0.02)
    r = (-n).cross(Vector((0, 0, 1))).normalized()
    box(key, c - n * 0.003, (w + 0.044, 0.006, h + 0.044), Matrix((r, n, Vector((0, 0, 1)))).transposed())       # its back
    beam(key, c - n * 0.004 + Vector((0, 0, h * 0.2)), Vector(foot) - n * 0.09, 0.03, 0.008)


def book(c, along, out, t, h, d, col):
    """One book standing: c the middle of its foot, t thick along `along`,
    d deep back from its spine, which faces `out`; col picks its spine."""
    a = Vector(along).normalized(); o = Vector(out).normalized(); up = Vector((0, 0, 1))
    cu = (col + 0.08) / 28 * 7 / 8; cv = (col + 0.92) / 28 * 7 / 8
    edge = [(0.90, 0.1), (0.98, 0.1), (0.98, 0.9), (0.90, 0.9)]
    m = mb('spines')
    P = lambda i, j, k: Vector(c) + a * (i * t / 2) + o * ((j - 1) * d / 2) + up * (k * h)
    m.face([P(-1, 1, 0), P(1, 1, 0), P(1, 1, 1), P(-1, 1, 1)], [(cu, 0), (cv, 0), (cv, 1), (cu, 1)])               # spine
    for i in (-1, 1):                                                                                             # covers
        m.face([P(i, -1, 0), P(i, 1, 0), P(i, 1, 1), P(i, -1, 1)], [(cu, 0.02), (cv, 0.02), (cv, 0.08), (cu, 0.08)])
    for k in (0, 1):                                                                                              # page edges
        m.face([P(-1, -1, k), P(1, -1, k), P(1, 1, k), P(-1, 1, k)], edge)
    m.face([P(-1, -1, 0), P(1, -1, 0), P(1, -1, 1), P(-1, -1, 1)], edge)


def books(start, along, out, length, max_h=0.27, depth=0.17, fill=1.0):
    """A row of books standing on a shelf from `start` for `length`."""
    a = Vector(along).normalized(); s = 0.0; start = Vector(start)
    while True:
        t = random.uniform(0.022, 0.052)
        if s + t > length * fill:
            break
        h = min(max_h, random.uniform(0.17, 0.27)); d = random.uniform(0.12, depth)
        book(start + a * (s + t / 2), a, out, t, h, d, random.randrange(28))
        s += t + random.choice((0.001, 0.001, 0.002, 0.012))


def pile(c, out, n=3, yaw=0.0):
    """Books lying in a pile; returns its height."""
    z = 0.0
    for k in range(n):
        t = random.uniform(0.025, 0.05)
        a = yaw + random.uniform(-0.25, 0.25)
        o = Vector((math.cos(a) * out[0] - math.sin(a) * out[1], math.sin(a) * out[0] + math.cos(a) * out[1], 0))
        al = Vector((-o.y, o.x, 0))
        m = mb('spines')
        col = random.randrange(28)
        cu = (col + 0.08) / 28 * 7 / 8; cv = (col + 0.92) / 28 * 7 / 8
        w, d = random.uniform(0.15, 0.2), random.uniform(0.21, 0.26)
        P = lambda i, j, k2: Vector(c) + al * (i * d / 2) + o * (j * w / 2) + Vector((0, 0, z + k2 * t))
        for j in (-1, 1):
            m.face([P(-1, j, 0), P(1, j, 0), P(1, j, 1), P(-1, j, 1)],
                   [(cu, 0), (cu, 1), (cv, 1), (cv, 0)] if j == 1 else [(0.90, 0.1), (0.98, 0.1), (0.98, 0.9), (0.90, 0.9)])
        for i in (-1, 1):
            m.face([P(i, -1, 0), P(i, 1, 0), P(i, 1, 1), P(i, -1, 1)], [(0.90, 0.1), (0.98, 0.1), (0.98, 0.9), (0.90, 0.9)])
        for k2 in (0, 1):
            m.face([P(-1, -1, k2), P(1, -1, k2), P(1, 1, k2), P(-1, 1, k2)], [(cu, 0.02), (cv, 0.02), (cv, 0.08), (cu, 0.08)])
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


def chair(pos, yaw, cushion='linen_coral'):
    with place(pos, yaw):                                           # it faces +Y
        wood((0, 0, 0.45), (0.42, 0.42, 0.035))
        for sx in (-1, 1):
            beam('oak', (sx * 0.18, 0.18, 0), (sx * 0.18, 0.18, 0.44), 0.035, 0.035)
            beam('oak', (sx * 0.18, -0.19, 0), (sx * 0.19, -0.23, 0.92), 0.035, 0.035)
        for z in (0.62, 0.74, 0.86):
            wood((0, -0.215 - (z - 0.45) * 0.085, z), (0.36, 0.02, 0.06))
        soft(cushion, (0, 0, 0.495), (0.38, 0.38, 0.06), n=5, segs=12, rings=4, tile=0.3)


def plant(idx, foot, h, yaw=0.3):
    crossed('plants', idx, foot, h, yaw)


BULBS = {'A': [], 'B': [], 'C': []}
_bulb = [0]


def fairy(pts, spacing=0.15):
    """A string of fairy lights along a line of points."""
    rope('wire', pts, 0.004, segs=3)
    left = spacing / 2
    for a, b in zip(pts[:-1], pts[1:]):
        a = here(a); b = here(b)
        L = (b - a).length
        while left <= L:
            BULBS['ABC'[_bulb[0] % 3]].append(a.lerp(b, left / L) - Vector((0, 0, 0.022)))
            _bulb[0] += 1
            left += spacing
        left -= L


def swags(p1, p2, n, depth):
    """A line hung in n swags between two points."""
    p1 = Vector(p1); p2 = Vector(p2); pts = []
    for k in range(n):
        seg = sag(p1.lerp(p2, k / n), p1.lerp(p2, (k + 1) / n), depth, 8)
        pts += seg if not pts else seg[1:]
    return pts


STEAM = []


def steam(name, pos, n=3, size=0.11):
    for k in range(n):
        with part(f'{name}{k}', pos):
            halo('steam', pos, size)
        STEAM.append((f'{name}{k}', k / n))


# ════════════════════════════════════════════════════════════════════════
# The shell: floor, gables, side walls, roof
# ════════════════════════════════════════════════════════════════════════
log("shell")
floor('floor', -HW, HW, FRONT, BACK, 0, tile=3.2)
WIN = (-WIN_HW, WIN_HW, SILL, WIN_TOP)
gable('wall_blue', BACK, N, holes=[WIN])
gable('wall', FRONT, S)
wall_x('wall', FRONT, BACK, 0, EAVE, -HW, facing=E)
wall_x('wall', FRONT, BACK, 0, EAVE, HW, facing=Wst)
# Panelling to dado height, a finger's width off the plaster.
gable('wainscot', BACK - 0.012, N, holes=[(-WIN_HW - 0.08, WIN_HW + 0.08, SILL, DADO)], top=DADO, tile=1.0)
gable('wainscot', FRONT + 0.012, S, top=DADO, tile=1.0)
wall_x('wainscot', FRONT, BACK, 0, DADO, -HW + 0.012, tile=1.0, facing=E)
wall_x('wainscot', FRONT, BACK, 0, DADO, HW - 0.012, tile=1.0, facing=Wst)
for x0, x1 in ((-HW, -WIN_HW - 0.08), (WIN_HW + 0.08, HW)):
    wood(((x0 + x1) / 2, BACK - 0.03, DADO + 0.02), (x1 - x0, 0.045, 0.04), 'white_wood')
wood((0, FRONT + 0.03, DADO + 0.02), (2 * HW, 0.045, 0.04), 'white_wood')
for sx in (-1, 1):
    wood((sx * (HW - 0.03), (FRONT + BACK) / 2, DADO + 0.02), (0.045, BACK - FRONT, 0.04), 'white_wood')
# The roof: two slopes of painted boards on rafters, a ridge, purlins, two ties with king posts.
for sx in (-1, 1):
    poly('ceiling', [(sx * HW, FRONT, EAVE), (0, FRONT, RIDGE), (0, BACK, RIDGE), (sx * HW, BACK, EAVE)], 1.6, (0, 1),
         facing=(-sx * SLOPE, 0, -1))
    for k in range(8):
        y = FRONT + 0.5 + k
        beam('beam', (sx * HW, y, EAVE - 0.08), (0, y, RIDGE - 0.08), 0.09, 0.14, tile=1.2)
    beam('beam', (sx * 2.5, FRONT, roof(2.5) - 0.20), (sx * 2.5, BACK, roof(2.5) - 0.20), 0.10, 0.12, tile=1.2)
    beam('beam', (sx * (HW - 0.06), FRONT, EAVE - 0.06), (sx * (HW - 0.06), BACK, EAVE - 0.06), 0.10, 0.10, tile=1.2)
beam('beam', (0, FRONT, RIDGE - 0.20), (0, BACK, RIDGE - 0.20), 0.14, 0.20, tile=1.2)
TIE_Z = 3.35
TIES = (-1.9, 1.1)
for y in TIES:
    beam('beam', (-2.72, y, TIE_Z), (2.72, y, TIE_Z), 0.12, 0.16, tile=1.2)
    beam('beam', (0, y, TIE_Z + 0.08), (0, y, RIDGE - 0.3), 0.10, 0.10, tile=1.2)


def round_window(c, normal, r=0.42):
    c = Vector(c); n = Vector(normal)
    lathe('sky', [(r, 0.0)], c + n * 0.004, n, segs=28, capt=True)
    lathe(one_sided('white_wood'), [(r - 0.01, 0.0), (r - 0.01, 0.05), (r + 0.08, 0.05), (r + 0.08, 0.0)], c, n, segs=28, tile=0.5)
    for a in (0, math.pi / 2):
        d = Vector((math.cos(a), 0, math.sin(a)))
        beam(one_sided('white_wood'), c + n * 0.02 - d * r, c + n * 0.02 + d * r, 0.03, 0.03, up=n, skip=-n)


round_window((0, BACK - 0.012, 3.88), N)
round_window((0, FRONT + 0.012, 3.75), S)

# ════════════════════════════════════════════════════════════════════════
# The window, its seat, and the harbour beyond
# ════════════════════════════════════════════════════════════════════════
log("window")
VIEW_H = VIEW_W / 2
VIEW_TOP = HORIZON + PIC_HORIZON * VIEW_H                           # the top of the picture proper; its extra sky goes above
SKY_TOP = VIEW_TOP + VIEW_SKY * VIEW_H
VIEW_BOT = VIEW_TOP - VIEW_H


def view_u(a):
    """Which part of the picture is at bearing `a` from the window. Past
    its right-hand edge the last stretch of headland and sea is laid again,
    back and forth, to carry the horizon on round."""
    u = PIC_LAMP[0] + (a - VIEW_LAMP) / math.pi
    if u > 1:
        u = 1 - (u - 1)
        if u < VIEW_FOLD:
            u = VIEW_FOLD + (VIEW_FOLD - u)
    return u


def view_at(a, z, r=VIEW_R):
    return Vector((r * math.sin(a), BACK + r * math.cos(a), z))


NA = 48
P = []; UV = []
for z, v in ((VIEW_BOT, 0.0), (SKY_TOP, 1.0)):
    P.append([view_at(-math.pi / 2 + math.pi * k / NA, z) for k in range(NA + 1)])
    UV.append([(view_u(-math.pi / 2 + math.pi * k / NA), v) for k in range(NA + 1)])
mb('harbour').grid(P, UV, True)
for z, up in ((SKY_TOP, -1), (VIEW_BOT, 1)):                        # night overhead, the dark of the quay underfoot
    poly('night' if up < 0 else 'quay', [(-VIEW_R, BACK, z), (VIEW_R, BACK, z), (VIEW_R, BACK + VIEW_R, z), (-VIEW_R, BACK + VIEW_R, z)],
         1.0, (0, 1), facing=(0, 0, up))
LAMP = view_at(VIEW_LAMP, VIEW_TOP - PIC_LAMP[1] * VIEW_H, VIEW_R - 0.06)
with part('LighthouseGlow', LAMP):
    card('glow_white', LAMP, (-math.sin(VIEW_LAMP), -math.cos(VIEW_LAMP), 0), 1.0, 1.0)
GULLS = []
for k, (z, size) in enumerate(((2.9, 0.42), (2.35, 0.30), (3.3, 0.24))):
    p = Vector((0, BACK + 1.6 + 0.4 * k, z))
    with part(f'Gull{k}', p):
        card('gull', p, N, size, size / 2)
    GULLS.append(f'Gull{k}')
# The frame: jambs, head, sill, two mullions, a transom and a glazing bar.
FY = BACK + 0.03
for sx in (-1, 1):
    wood((sx * (WIN_HW + 0.03), FY, (SILL + WIN_TOP) / 2), (0.10, 0.16, WIN_TOP - SILL + 0.16), 'white_wood')
    wood((sx * 0.47, FY, (SILL + WIN_TOP) / 2), (0.05, 0.07, WIN_TOP - SILL), 'white_wood')
wood((0, FY, WIN_TOP + 0.03), (2 * WIN_HW + 0.16, 0.16, 0.10), 'white_wood')
wood((0, FY - 0.04, SILL - 0.02), (2 * WIN_HW + 0.24, 0.26, 0.05), 'white_wood')
wood((0, FY, 2.36), (2 * WIN_HW, 0.07, 0.06), 'white_wood')
wood((0, FY, 1.46), (2 * WIN_HW, 0.06, 0.035), 'white_wood')
# The seat under it: a panelled box, a long cushion, pillows, and Evie's bed.
SEAT_Y = BACK - 0.30
wood((0, SEAT_Y, 0.25), (2 * WIN_HW + 0.1, 0.58, 0.50), 'white_wood')
for k in range(3):
    wood((-0.95 + k * 0.95, SEAT_Y - 0.295, 0.25), (0.78, 0.012, 0.34), 'white_wood')
soft('linen_teal', (0, SEAT_Y - 0.01, 0.555), (2 * WIN_HW, 0.56, 0.13), n=8, segs=20, rings=6, tile=0.4)
for x, key, yaw, lean in ((-1.2, 'linen_mustard', 0.5, 0.35), (-0.86, 'linen_white', 0.25, 0.2), (1.22, 'linen_coral', -0.45, 0.3)):
    Rm = (Matrix.Rotation(yaw, 3, 'Z') @ Matrix.Rotation(-lean, 3, 'X'))
    soft(key, (x, SEAT_Y + 0.08, 0.80), (0.40, 0.13, 0.40), n=3.2, segs=14, rings=8, tile=0.3, R=Rm)
CATBED = Vector((0.62, SEAT_Y - 0.02, 0.615))
lathe('knit_cream', [(0.10, 0.03), (0.20, 0.0), (0.27, 0.04), (0.28, 0.10), (0.24, 0.15), (0.19, 0.12), (0.16, 0.05), (0.0, 0.04)],
      CATBED, segs=20, tile=0.3)
soft('knit_blue', (-0.25, SEAT_Y - 0.03, 0.66), (0.42, 0.34, 0.08), n=5, segs=12, rings=4, tile=0.25)
pile((-0.25, SEAT_Y - 0.03, 0.70), (0, -1), 2, 0.3)
mug((0.16, SEAT_Y - 0.14, 0.62), 'c_mustard')
steam('SteamSeat', Vector((0.16, SEAT_Y - 0.14, 0.76)), 2, 0.09)
# The curtain rod, and fairy lights hung along it and down both sides.
CUR_Y = BACK - 0.11
tube('brass', (-1.78, CUR_Y, ROD_Z), (1.78, CUR_Y, ROD_Z), 0.014, segs=8)
for sx in (-1, 1):
    sphere('brass', (sx * 1.8, CUR_Y, ROD_Z), 0.03, segs=8, rings=5)
    tube('brass', (sx * 1.66, CUR_Y, ROD_Z), (sx * 1.66, BACK, ROD_Z), 0.008, segs=5)
fairy(swags((-1.74, CUR_Y - 0.03, ROD_Z - 0.01), (1.74, CUR_Y - 0.03, ROD_Z - 0.01), 6, 0.13), 0.13)
for sx in (-1, 1):
    fairy([Vector((sx * (1.66 + 0.03 * math.sin(k * 1.3)), CUR_Y - 0.03 - 0.02 * math.cos(k * 0.9), ROD_Z - 0.02 - k * 0.12))
           for k in range(17)], 0.15)

CURTAINS = []


def curtain(name, x0, x1, z0=0.70, pleats=5, amp=0.045):
    """A sheer panel on the rod. Its own object: two shape keys a quarter
    turn apart make a breath of air that travels down it."""
    NU, NV = pleats * 8, 14
    verts = []; uvs = []; d1 = []; d2 = []
    for j in range(NV + 1):
        v = j / NV
        z = z0 + v * (ROD_Z - 0.02 - z0)
        free = 1 - v ** 2                                           # held on the rod
        for i in range(NU + 1):
            u = i / NU
            x = x0 + (x1 - x0) * u
            verts.append(Vector((x, CUR_Y + amp * math.sin(u * pleats * 2 * math.pi) * (0.6 + 0.4 * free), z)))
            uvs.append((u * pleats, z / 2.0))
            ph = 2 * math.pi * (u * 0.7 + v * 0.9)
            a = 0.05 * free
            d1.append(verts[-1] + Vector((0.2 * a * math.sin(ph), a * math.sin(ph), 0)))
            d2.append(verts[-1] + Vector((0.2 * a * math.cos(ph), a * math.cos(ph), 0)))
    faces = [(j * (NU + 1) + i, j * (NU + 1) + i + 1, (j + 1) * (NU + 1) + i + 1, (j + 1) * (NU + 1) + i)
             for j in range(NV) for i in range(NU)]
    CURTAINS.append(whole(name, 'sheer', verts, faces, uvs, {'SwayA': d1, 'SwayB': d2}))


curtain('CurtainL', -1.60, -0.98)
curtain('CurtainR', 0.98, 1.60)

# ════════════════════════════════════════════════════════════════════════
# Left of the window: the television, the fish tank, the sofa
# ════════════════════════════════════════════════════════════════════════
log("television corner")
SB_Y = BACK - 0.26                                                  # the sideboard's middle
SB_TOP = 0.62
wood((-3.0, SB_Y, 0.39), (2.0, 0.44, 0.46), 'walnut')
for k in range(3):
    wood((-3.66 + k * 0.66, SB_Y - 0.225, 0.39), (0.62, 0.012, 0.40), 'white_wood')
    sphere('brass', (-3.66 + k * 0.66 + 0.22, SB_Y - 0.24, 0.42), 0.015, segs=6, rings=4)
for x in (-3.9, -2.1):
    for y in (SB_Y - 0.17, SB_Y + 0.17):
        tube('walnut', (x, y, 0.16), (x, y, 0.0), 0.025, 0.014, segs=6)
# The television: a wooden set, its screen well back in the cabinet.
TV = Vector((-2.60, SB_Y - 0.18, SB_TOP))                           # the middle of its front, at its foot
SCREEN = TV + Vector((-0.09, 0.07, 0.26))
SHOTS = []
with place(TV):
    wood((0, 0.20, 0.04), (0.92, 0.40, 0.08), 'walnut')
    wood((0, 0.20, 0.48), (0.92, 0.40, 0.08), 'walnut')
    wood((-0.43, 0.20, 0.26), (0.06, 0.40, 0.36), 'walnut')
    wood((0.34, 0.20, 0.26), (0.24, 0.40, 0.36), 'walnut')
    wood((0, 0.39, 0.26), (0.92, 0.02, 0.52), 'walnut')
    card('black', (-0.09, 0.075, 0.26), N, 0.66, 0.37)
    for z in (0.34, 0.24):
        lathe('brass', [(0.028, 0), (0.028, 0.02), (0.018, 0.03), (0.0, 0.03)], (0.34, 0, z), N, segs=10)
    for k in range(5):
        wood((0.34, -0.002, 0.10 + k * 0.016), (0.14, 0.006, 0.006), 'black')
    for sx in (-1, 1):
        tube('brass', (0.1, 0.2, 0.52), (0.1 + sx * 0.26, 0.2, 0.92), 0.005, 0.003, segs=5)
    sphere('brass', (0.1, 0.2, 0.53), 0.03, segs=8, rings=5)
for k in range(6):
    s = SPR['tv'][k]
    with part(f'TvShot{k}', SCREEN):
        card('tv', SCREEN, N, 0.68, 0.3825, u0=s['u0'], u1=s['u1'], v0=s['v0'], v1=s['v1'])
    SHOTS.append(f'TvShot{k}')
# The fish tank.
TK = Vector((-3.56, SB_Y + 0.02, SB_TOP))                           # the middle of its foot
TK_W, TK_D, TK_H = 0.72, 0.30, 0.44
FISH = []
wood(TK + Vector((0, 0, 0.02)), (TK_W + 0.02, TK_D + 0.02, 0.04), 'black')
wood(TK + Vector((0, 0, TK_H - 0.03)), (TK_W + 0.02, TK_D + 0.02, 0.06), 'black')
wood(TK + Vector((0, 0, TK_H - 0.064)), (TK_W - 0.04, TK_D - 0.06, 0.008), 'bulb')
for sx in (-1, 1):
    for sy in (-1, 1):
        wood(TK + Vector((sx * TK_W / 2, sy * TK_D / 2, TK_H / 2)), (0.012, 0.012, TK_H), 'black')
    card('tank', TK + Vector((sx * (TK_W / 2 - 0.004), 0, TK_H / 2)), (-sx, 0, 0), TK_D, TK_H - 0.08, u0=0.0, u1=0.3)
card('tank', TK + Vector((0, TK_D / 2 - 0.004, TK_H / 2)), N, TK_W, TK_H - 0.08)
wood(TK + Vector((0, 0, 0.055)), (TK_W - 0.01, TK_D - 0.01, 0.03), 'sand')
for k, (idx, size) in enumerate(((0, 0.11), (2, 0.09), (1, 0.08), (4, 0.11), (3, 0.09), (6, 0.07), (5, 0.10), (7, 0.08))):
    c = TK + Vector((random.uniform(-0.12, 0.12), -0.10 + 0.026 * k, 0.12 + 0.24 * ((k * 5) % 8) / 8))
    with part(f'Fish{k}', c):
        sprite('fish', idx, c, N, size, centre=True)
    FISH.append(f'Fish{k}')
BUB = TK + Vector((0.27, 0.06, 0.07))
with part('Bubbles', BUB):
    for k in range(5):
        sphere('water', BUB + Vector((0.008 * math.sin(k * 2.1), 0.006 * math.cos(k * 1.7), k * 0.07)), 0.006 + 0.001 * (k % 3), segs=6, rings=4)
# The wall of photographs above them, stepping up under the roof.
GALLERY = [(1, -3.74, 1.60, 0.48, 'oak'), (4, -3.16, 1.72, 0.38, 'white_wood'), (6, -3.52, 2.24, 0.60, 'walnut'),
           (7, -2.70, 1.74, 0.34, 'brass'), (3, -2.86, 2.28, 0.34, 'white_wood'), (5, -2.24, 1.84, 0.46, 'oak'),
           (0, -2.30, 2.38, 0.50, 'walnut')]
for idx, x, z, w, key in GALLERY:
    frame(idx, (x, BACK - 0.014, z), N, w, key)
# A fiddle-leaf fig between the sideboard and the window.
plant(1, (-1.74, BACK - 0.32, 0), 1.3)
# The sofa along the left wall, a rug, a low table, a pouffe, a standard lamp.
SOFA = Vector((-4.5, 1.6, 0))
with place(SOFA):                                                   # it faces +X
    soft('linen_oat', (0, 0, 0.27), (0.90, 2.2, 0.30), n=8, segs=20, rings=6, tile=0.4)
    soft('linen_oat', (-0.34, 0, 0.60), (0.22, 2.2, 0.56), n=6, segs=20, rings=8, tile=0.4)
    for sy in (-1, 1):
        soft('linen_oat', (0, sy * 1.02, 0.42), (0.90, 0.20, 0.50), n=5, segs=16, rings=8, tile=0.4)
        soft('linen_oat', (0.08, sy * 0.47, 0.47), (0.66, 0.90, 0.16), n=6, segs=16, rings=6, tile=0.4)
        soft('linen_oat', (-0.19, sy * 0.47, 0.72), (0.18, 0.88, 0.40), n=5, segs=16, rings=8, tile=0.4,
             R=Matrix.Rotation(0.18, 3, 'Y'))
        for sx in (-1, 1):
            tube('oak', (sx * 0.36, sy * 0.98, 0.12), (sx * 0.38, sy * 1.0, 0), 0.03, 0.02, segs=6)
    for y, key, a in ((0.72, 'linen_teal', 0.3), (-0.75, 'linen_coral', -0.25), (-0.40, 'linen_navy', 0.1)):
        soft(key, (-0.02, y, 0.74), (0.13, 0.40, 0.40), n=3.2, segs=14, rings=8, tile=0.3,
             R=Matrix.Rotation(a, 3, 'Z') @ Matrix.Rotation(0.3, 3, 'Y'))
    soft('knit_blue', (0.0, 1.02, 0.68), (0.80, 0.26, 0.05), n=6, segs=12, rings=4, tile=0.25)        # a throw over the arm
    soft('knit_blue', (0.22, 1.13, 0.48), (0.36, 0.04, 0.40), n=6, segs=12, rings=4, tile=0.25)
for idx, y in ((8, 1.14), (9, 2.06)):
    frame(idx, (-HW + 0.014, y, 1.62), E, 0.40, 'white_wood')
RUG = Vector((-3.1, 1.55, 0.006))
card('rug', RUG, (0, 0, 1), 3.0, 2.0, up=(1, 0, 0))
TABLE = Vector((-3.25, 1.55, 0))
lathe('oak', [(0.0, 0.40), (0.42, 0.40), (0.42, 0.435), (0.0, 0.435)], TABLE, segs=24, tile=0.9)
lathe('oak', [(0.42, 0.435)], TABLE, segs=24, capt=True)
for k in range(3):
    a = 2 * math.pi * k / 3 + 0.4
    tube('oak', TABLE + Vector((0.2 * math.cos(a), 0.2 * math.sin(a), 0.40)), TABLE + Vector((0.34 * math.cos(a), 0.34 * math.sin(a), 0)),
         0.022, 0.014, segs=6)
mug(TABLE + Vector((0.16, -0.12, 0.435)), 'c_coral')
steam('SteamTable', TABLE + Vector((0.16, -0.12, 0.57)), 2, 0.09)
pile(TABLE + Vector((-0.14, 0.12, 0.435)), (1, 0), 3, 0.4)
lathe('c_white', [(0.0, 0.0), (0.09, 0.0), (0.11, 0.012), (0.0, 0.012)], TABLE + Vector((0.12, 0.2, 0.435)), segs=14)
for k in range(5):
    a = k * 1.3
    lathe('biscuit', [(0.0, 0.0), (0.028, 0.0), (0.028, 0.008), (0.0, 0.008)],
          TABLE + Vector((0.12 + 0.045 * math.cos(a), 0.2 + 0.045 * math.sin(a), 0.447 + 0.004 * (k % 2))), segs=8)
wood(TABLE + Vector((-0.1, -0.22, 0.445)), (0.05, 0.16, 0.018), 'black', R=Matrix.Rotation(0.5, 3, 'Z'))       # the remote
plant(5, TABLE + Vector((-0.2, -0.08, 0.435)), 0.15)
POUFFE = Vector((-1.95, 1.3, 0))
soft('knit_cream', POUFFE + Vector((0, 0, 0.19)), (0.52, 0.52, 0.38), n=3, segs=16, rings=8, tile=0.25)
FLAMP = Vector((-4.62, BACK - 0.34, 0))
lathe('iron', [(0.16, 0), (0.16, 0.02), (0.02, 0.04), (0.012, 0.06)], FLAMP, segs=14, capb=True)
tube('brass', FLAMP + Vector((0, 0, 0.05)), FLAMP + Vector((0, 0, 1.38)), 0.012, segs=6)
lathe('shade', [(0.23, 1.32), (0.15, 1.62)], FLAMP, segs=18, tile=1.4)
halo('glow', FLAMP + Vector((0, 0, 1.45)), 1.5)
for k, (x, y, key) in enumerate(((-2.55, 0.75, 'c_coral'), (-3.85, 0.42, 'c_mustard'))):                      # Evie's balls of wool
    sphere(key, (x, y, 0.05), 0.05, segs=10, rings=6)

# ════════════════════════════════════════════════════════════════════════
# Right of the window: the desk, the evidence board, the clock, the books
# ════════════════════════════════════════════════════════════════════════
log("desk corner")
DESK = Vector((2.9, BACK - 0.36, 0))
DT = 0.77                                                           # the desk top's surface
with place(DESK):
    wood((0, 0, DT - 0.02), (1.6, 0.66, 0.04))
    wood((0.56, 0, 0.375), (0.42, 0.60, 0.75))
    for k in range(3):
        wood((0.56, -0.305, 0.14 + k * 0.235), (0.38, 0.012, 0.21), 'walnut')
        sphere('brass', (0.56, -0.32, 0.14 + k * 0.235), 0.014, segs=6, rings=4)
    for y in (-0.28, 0.28):
        wood((-0.74, y, 0.375), (0.05, 0.05, 0.75))
    wood((-0.1, 0.3, 0.5), (1.3, 0.02, 0.3))
    card('chart', (-0.34, -0.04, DT + 0.002), (0, 0, 1), 0.72, 0.48, up=(0.12, 1, 0))
    # The laptop, on the archive job.
    wood((0.3, -0.08, DT + 0.008), (0.34, 0.24, 0.016), 'steel')
    Rl = Matrix.Rotation(-0.26, 3, 'X')
    wood((0.3, 0.07, DT + 0.12), (0.34, 0.012, 0.23), 'steel', R=Rl)
    card('screen', Vector((0.3, 0.062, DT + 0.12)) + Rl @ Vector((0, -0.002, 0)), Rl @ Vector((0, -1, 0)), 0.32, 0.20,
         up=Rl @ Vector((0, 0, 1)))
    # A banker's lamp.
    lathe('brass', [(0.07, 0), (0.07, 0.015), (0.015, 0.03), (0.012, 0.26)], (-0.62, 0.18, DT), segs=10, capb=True)
    lathe('shade_green', [(0.055, -0.13), (0.07, 0.0), (0.055, 0.13)], (-0.62, 0.15, DT + 0.28), (1, 0, 0), segs=10, tile=0.3)
    card('glow_soft', (-0.5, 0.0, DT + 0.004), (0, 0, 1), 0.9, 0.7, up=(0, 1, 0))
    mug((-0.02, 0.2, DT), 'c_teal')
    # The evidence file: three fat folders, the top one labelled.
    for k in range(3):
        wood((0.62 + 0.01 * k, 0.16 - 0.01 * k, DT + 0.02 + k * 0.04), (0.24, 0.32, 0.038), 'kraft', R=Matrix.Rotation(0.1 * k - 0.1, 3, 'Z'))
    card('file', (0.64, 0.14, DT + 0.121), (0, 0, 1), 0.24, 0.32, up=(-0.1, 1, 0))
    lathe('c_navy', [(0.035, 0), (0.04, 0.1), (0.035, 0.1), (0.032, 0.01)], (0.02, -0.2, DT), segs=10, capb=True)
    for k in range(4):
        tube(('c_mustard', 'c_red', 'c_teal', 'c_mustard')[k], (0.02 + 0.012 * math.cos(k * 1.6), -0.2 + 0.012 * math.sin(k * 1.6), DT + 0.01),
             (0.02 + 0.03 * math.cos(k * 1.6), -0.2 + 0.03 * math.sin(k * 1.6), DT + 0.17), 0.004, segs=5)
steam('SteamDesk', DESK + Vector((-0.02, 0.2, DT + 0.14)), 2, 0.09)
standing(5, DESK + Vector((-0.12, 0.24, DT)), (-0.25, -1, 0), 0.2)
chair((2.72, 2.42, 0), 0.3)
# The board above the desk.
BOARD = Vector((2.9, BACK - 0.014, 1.80))
frame(('evidence', 1280 / 832), BOARD, N, 1.44, 'oak', border=0.04)
# The pendulum clock.
CLK = Vector((1.86, BACK - 0.014, 2.02))
box(one_sided('walnut'), CLK + Vector((0, -0.045, 0.0)), (0.26, 0.09, 0.60), tile=0.9, skip=-N)
box(one_sided('walnut'), CLK + Vector((0, -0.05, 0.32)), (0.32, 0.11, 0.04), tile=0.9, skip=-N)
card(one_sided('clock'), CLK + Vector((0, -0.092, 0.16)), N, 0.21, 0.21)
card(one_sided('black'), CLK + Vector((0, -0.0915, -0.14)), N, 0.14, 0.26)
PEND = CLK + Vector((0, -0.097, -0.03))
with part('Pendulum', PEND):
    tube('brass', PEND, PEND + Vector((0, 0, -0.19)), 0.004, segs=5)
    lathe('brass', [(0.0, 0.0), (0.034, 0.0), (0.034, 0.008), (0.0, 0.008)], PEND + Vector((0, 0.002, -0.20)), N, segs=14)
# The tall bookcase in the corner.
BC = Vector((4.36, BACK - 0.17, 0))
BC_H = 2.10
with place(BC):
    for sx in (-1, 1):
        wood((sx * 0.49, 0, BC_H / 2), (0.025, 0.32, BC_H))
    wood((0, 0.15, BC_H / 2), (1.0, 0.012, BC_H), 'walnut')
    for k in range(6):
        z = 0.06 + k * 0.404
        wood((0, 0, z), (0.96, 0.31, 0.025))
        if k == 5:
            break
        if k in (0, 1, 3):
            books((-0.47, 0.13, z + 0.0125), (1, 0, 0), (0, -1, 0), 0.94, 0.34, fill=random.uniform(0.85, 1.0))
        elif k == 2:
            books((-0.47, 0.13, z + 0.0125), (1, 0, 0), (0, -1, 0), 0.52)
            sprite('things', 1, (0.26, 0.0, z + 0.0125), N, 0.24)                      # the ship in a bottle
        else:
            sprite('things', 2, (-0.33, 0.02, z + 0.0125), N, 0.27)                     # a bottle with a message in it
            books((-0.18, 0.13, z + 0.0125), (1, 0, 0), (0, -1, 0), 0.38)
            sprite('things', 3, (0.33, 0.0, z + 0.0125), N, 0.30)                       # a ship's lantern
            halo('glow_soft', (0.33, -0.02, z + 0.14), 0.5)
    plant(6, (-0.2, -0.02, BC_H + 0.085), 0.2)
# Rolled charts in a basket under the clock.
BSK = Vector((1.84, BACK - 0.3, 0))
lathe('basket', [(0.13, 0), (0.17, 0.2), (0.16, 0.42), (0.145, 0.42), (0.12, 0.02)], BSK, segs=14, tile=0.3, capb=True)
for k in range(5):
    a = k * 1.26
    tube('paper', BSK + Vector((0.06 * math.cos(a), 0.06 * math.sin(a), 0.03)),
         BSK + Vector((0.13 * math.cos(a), 0.13 * math.sin(a), random.uniform(0.7, 0.9))), 0.024, segs=7, caps=True)

# ════════════════════════════════════════════════════════════════════════
# The kitchen along the right-hand wall, and the table
# ════════════════════════════════════════════════════════════════════════
log("kitchen")
KX = HW - 0.02                                                      # the wall's face
K0, K1 = -1.30, 2.60                                                # the run of cupboards
CT = 0.90                                                           # the worktop's surface
# The fridge.
FR = Vector((KX - 0.31, -1.66, 0))
soft('mint', FR + Vector((0, 0, 0.83)), (0.62, 0.66, 1.62), n=14, segs=20, rings=10)
card('fridge', FR + Vector((-0.314, 0, 0.83)), Wst, 0.62, 1.52)
tube('steel', FR + Vector((-0.34, 0.26, 0.55)), FR + Vector((-0.34, 0.26, 1.0)), 0.012, segs=6)
tube('steel', FR + Vector((-0.34, 0.26, 1.28)), FR + Vector((-0.34, 0.26, 1.52)), 0.012, segs=6)
plant(4, FR + Vector((0.0, 0.05, 1.64)), 0.42)
# Cupboards, worktop, oven.
wood((KX - 0.29, (K0 + K1) / 2, 0.48), (0.58, K1 - K0, 0.76), 'teal_paint')
wood((KX - 0.27, (K0 + K1) / 2, 0.05), (0.54, K1 - K0, 0.10), 'black')
wood((KX - 0.31, (K0 + K1) / 2, CT - 0.02), (0.64, K1 - K0 + 0.04, 0.04))
OVEN = 0.975                                                        # the middle of the oven, under the hob
n_doors = 0
y = K0
while y < K1 - 0.1:
    w = 0.65
    if abs(y + w / 2 - OVEN) < 0.33:
        card('black', (KX - 0.584, y + w / 2, 0.47), Wst, w - 0.04, 0.70)
        card('glow_soft', (KX - 0.586, y + w / 2, 0.42), Wst, 0.36, 0.26)                    # the oven light
        tube('steel', (KX - 0.62, y + 0.08, 0.76), (KX - 0.62, y + w - 0.08, 0.76), 0.01, segs=6)
        wood((KX - 0.635, y + 0.25, 0.63), (0.012, 0.2, 0.28), 'linen_coral')              # a tea towel on the rail
    else:
        card('cabinet', (KX - 0.584, y + w / 2, 0.47), Wst, w - 0.03, 0.72)
        sphere('brass', (KX - 0.60, y + w / 2 + (0.2 if n_doors % 2 else -0.2), 0.70), 0.015, segs=6, rings=4)
    n_doors += 1
    y += w
wall_x(one_sided('tiles'), K0, K1, CT, 1.44, KX - 0.004, tile=0.52, facing=Wst)
# The sink and its tap.
SINK = Vector((KX - 0.31, -0.45, CT))
wood(SINK + Vector((0, 0, 0.004)), (0.42, 0.56, 0.008), 'steel')
card('iron', SINK + Vector((0, 0, 0.0085)), (0, 0, 1), 0.36, 0.48, up=(0, 1, 0))
tube('steel', SINK + Vector((0.24, 0, 0)), SINK + Vector((0.24, 0, 0.26)), 0.012, segs=6)
rope('steel', [SINK + Vector((0.24 - 0.09 * math.sin(a), 0, 0.26 + 0.09 * (1 - math.cos(a)) * 0.6)) for a in [math.pi * j / 10 for j in range(7)]],
     0.010, segs=6)
lathe('c_green', [(0.025, 0), (0.028, 0.12), (0.012, 0.15), (0.012, 0.18)], SINK + Vector((0.2, 0.2, 0)), segs=8, capb=True)
# The hob, the kettle on it.
card('hob', (KX - 0.33, OVEN, CT + 0.003), (0, 0, 1), 0.52, 0.56, up=(0, 1, 0))
KET = Vector((KX - 0.19, OVEN + 0.12, CT + 0.004))
lathe('c_teal', [(0.085, 0), (0.105, 0.03), (0.10, 0.10), (0.06, 0.15), (0.03, 0.16), (0.0, 0.16)], KET, segs=14, capb=True)
sphere('black', KET + Vector((0, 0, 0.175)), 0.016, segs=6, rings=4)
tube('c_teal', KET + Vector((-0.08, 0, 0.07)), KET + Vector((-0.16, 0, 0.14)), 0.02, 0.011, segs=7)
rope('black', [KET + Vector((0, 0.07 * math.cos(a), 0.14 + 0.09 * math.sin(a))) for a in [math.pi * j / 8 for j in range(9)]], 0.008, segs=5)
steam('SteamKettle', KET + Vector((-0.18, 0, 0.22)), 3, 0.17)
# On the worktop: fruit, the coffee things, a toaster, a board, a crock of spoons.
FRUIT = Vector((KX - 0.3, -1.0, CT))
lathe('oak', [(0.06, 0), (0.15, 0.06), (0.16, 0.07), (0.14, 0.05), (0.05, 0.012), (0.0, 0.012)], FRUIT, segs=14, tile=0.5, capb=True)
for k, key in enumerate(('c_orange', 'c_red', 'c_lemon', 'c_orange', 'c_green')):
    a = k * 1.3
    sphere(key, FRUIT + Vector((0.06 * math.cos(a) * (k < 4), 0.06 * math.sin(a) * (k < 4), 0.075 + 0.045 * (k == 4))), 0.04, segs=8, rings=6)
COF = Vector((KX - 0.2, 0.32, CT))
lathe('glass_jar', [(0.05, 0), (0.06, 0.02), (0.06, 0.07), (0.035, 0.10), (0.045, 0.13)], COF, segs=12, capb=True)        # the carafe
lathe('coffee', [(0.056, 0.012), (0.056, 0.06)], COF, segs=12, capt=True)
lathe('c_white', [(0.02, 0.13), (0.065, 0.20), (0.07, 0.20)], COF, segs=12)                                               # the dripper
wood(COF + Vector((0.0, 0.26, 0.09)), (0.11, 0.11, 0.18), 'walnut')                                                      # the grinder
lathe('brass', [(0.05, 0.18), (0.035, 0.22), (0.0, 0.22)], COF + Vector((0.0, 0.26, 0)), segs=10)
beam('brass', COF + Vector((0.0, 0.26, 0.225)), COF + Vector((-0.07, 0.31, 0.235)), 0.008, 0.008)
sphere('walnut', COF + Vector((-0.07, 0.31, 0.25)), 0.014, segs=6, rings=4)
soft('steel', (KX - 0.22, 2.15, CT + 0.09), (0.18, 0.28, 0.18), n=6, segs=14, rings=6)                                    # the toaster
wood((KX - 0.045, 1.9, CT + 0.17), (0.02, 0.26, 0.34), R=Matrix.Rotation(0.12, 3, 'Y'))                                   # a chopping board
CRK = Vector((KX - 0.14, 1.5, CT))
lathe('c_white', [(0.045, 0), (0.055, 0.12), (0.048, 0.12), (0.045, 0.01)], CRK, segs=10, capb=True)
for k in range(4):
    tube('oak', CRK + Vector((0.01 * math.cos(k * 1.6), 0.01 * math.sin(k * 1.6), 0.01)),
         CRK + Vector((0.035 * math.cos(k * 1.6), 0.035 * math.sin(k * 1.6), 0.27 + 0.02 * k)), 0.006, 0.009, segs=5)
# Two shelves over it, and what is on them.
SH = (1.48, 1.84)
for z in SH:
    wood((KX - 0.12, (K0 + K1) / 2, z), (0.24, K1 - K0 - 0.2, 0.028))
    for yb in (K0 + 0.3, (K0 + K1) / 2, K1 - 0.3):
        beam('iron', (KX - 0.01, yb, z - 0.16), (KX - 0.2, yb, z - 0.014), 0.012, 0.012)
wood((KX - 0.12, (K0 + K1) / 2, SH[0] - 0.02), (0.02, K1 - K0 - 0.4, 0.012), 'bulb')                                      # a strip light under the lower one
card('glow_soft', (KX - 0.008, (K0 + K1) / 2, 1.18), Wst, K1 - K0, 0.62)
for k, key in enumerate(('c_coral', 'c_teal', 'c_mustard', 'c_white', 'c_navy', 'c_pink')):
    mug((KX - 0.13, K0 + 0.32 + k * 0.13, SH[0] + 0.014), key, full=None)
for k in range(5):                                                                                                       # plates, bowls
    lathe('c_white', [(0.0, 0.0), (0.10, 0.0), (0.115, 0.012), (0.0, 0.012)], (KX - 0.13, 0.25, SH[0] + 0.014 + k * 0.013), segs=14)
for k in range(3):
    lathe(('c_teal', 'c_white', 'c_coral')[k], [(0.04, 0), (0.075, 0.045), (0.07, 0.045), (0.035, 0.008)],
          (KX - 0.13, 0.52, SH[0] + 0.014 + k * 0.024), segs=12, capb=True)
for k, fill_key in enumerate(('coffee', 'c_lemon', 'c_green', 'biscuit', 'kibble')):                                     # jars
    c = Vector((KX - 0.13, 0.95 + k * 0.17, SH[0] + 0.014))
    lathe('glass_jar', [(0.055, 0), (0.06, 0.02), (0.06, 0.17), (0.05, 0.19)], c, segs=12, capb=True)
    lathe(fill_key, [(0.061, 0.01), (0.061, 0.12 - 0.02 * (k % 3))], c, segs=12)
    lathe('oak', [(0.05, 0.19), (0.05, 0.215), (0.0, 0.215)], c, segs=12, tile=0.3)
books((KX - 0.03, K0 + 0.25, SH[1] + 0.014), (0, 1, 0), (-1, 0, 0), 0.62, 0.26, 0.17)
plant(3, (KX - 0.12, 0.05, SH[1] + 0.014), 0.30)
lathe('c_white', [(0.05, 0), (0.085, 0.04), (0.09, 0.09), (0.05, 0.13), (0.03, 0.14), (0.0, 0.15)], (KX - 0.13, 0.75, SH[1] + 0.014),
      segs=14, capb=True)                                                                                               # the teapot
tube('c_white', (KX - 0.13, 0.83, SH[1] + 0.074), (KX - 0.13, 0.90, SH[1] + 0.124), 0.016, 0.009, segs=6)
sprite('things', 4, (KX - 0.13, 1.5, SH[1] + 0.014), Wst, 0.24)                                                           # a basket of wool
plant(7, (KX - 0.12, 2.25, SH[1] + 0.014), 0.34)
# Evie's bowls, by the wall past the fridge.
MAT = Vector((KX - 0.26, -2.62, 0))
soft('linen_teal', MAT + Vector((0, 0, 0.008)), (0.34, 0.56, 0.016), n=8, segs=12, rings=4, tile=0.3)
for sy, key in ((-1, 'water'), (1, 'kibble')):
    c = MAT + Vector((0, sy * 0.13, 0.016))
    lathe('c_white', [(0.06, 0), (0.085, 0.045), (0.078, 0.045), (0.055, 0.012)], c, segs=12, capb=True)
    lathe(key, [(0.0, 0.034), (0.074, 0.034)], c, segs=12)
# The table for two, a lamp hanging over it.
DT_C = Vector((3.05, -0.45, 0))
lathe('oak', [(0.0, 0.725), (0.46, 0.725), (0.46, 0.76), (0.0, 0.76)], DT_C, segs=24, tile=0.9)
lathe('oak', [(0.46, 0.76)], DT_C, segs=24, capt=True)
lathe('oak', [(0.24, 0), (0.22, 0.03), (0.05, 0.08), (0.04, 0.70), (0.10, 0.725)], DT_C, segs=12, tile=0.9)
chair((3.05, -1.02, 0), 0.0, 'linen_teal')
chair((3.05, 0.12, 0), math.pi, 'linen_mustard')
lathe('c_navy', [(0.035, 0), (0.05, 0.05), (0.03, 0.12), (0.036, 0.15)], DT_C + Vector((0.0, 0.05, 0.76)), segs=10, capb=True)
plant(7, DT_C + Vector((0.0, 0.05, 0.86)), 0.26, 0.9)
mug(DT_C + Vector((-0.2, -0.15, 0.76)), 'c_white')
pile(DT_C + Vector((0.2, -0.16, 0.76)), (0, -1), 2, 0.2)
card('glow_soft', DT_C + Vector((0, 0, 0.765)), (0, 0, 1), 1.0, 1.0, up=(0, 1, 0))
PEND_T = Vector((DT_C.x, DT_C.y, roof(DT_C.x) - 0.02))
PT_Z = 1.95
with part('PendantTable', PEND_T):
    tube('wire', PEND_T, (DT_C.x, DT_C.y, PT_Z + 0.2), 0.005, segs=4)
    lathe('basket', [(0.04, PT_Z + 0.2), (0.20, PT_Z + 0.12), (0.27, PT_Z - 0.04)], (DT_C.x, DT_C.y, 0), segs=18, tile=0.25)
    sphere('bulb', (DT_C.x, DT_C.y, PT_Z + 0.04), 0.05, segs=8, rings=6)
    halo('glow', (DT_C.x, DT_C.y, PT_Z + 0.02), 1.1)

# ════════════════════════════════════════════════════════════════════════
# The bed corner, the drawers, the door wall
# ════════════════════════════════════════════════════════════════════════
log("bed corner")
BED = Vector((-4.2, -3.27, 0))                                      # its middle
BW, BL, BZ = 1.5, 2.1, 0.54                                         # width, length, the mattress top
with place(BED):
    wood((0, -BL / 2 + 0.03, 0.55), (BW, 0.06, 1.10))
    wood((0, BL / 2 - 0.025, 0.28), (BW, 0.05, 0.50))
    for sx in (-1, 1):
        wood((sx * (BW / 2 - 0.02), 0, 0.26), (0.04, BL - 0.1, 0.16))
    soft('linen_white', (0, 0, BZ - 0.12), (BW - 0.08, BL - 0.14, 0.26), n=10, segs=20, rings=6, tile=0.4)
    # The quilt: over the top, down both sides and the foot.
    hw, drop, y0, L = BW / 2 - 0.02, 0.30, -BL / 2 + 0.62, BL - 0.62 - 0.05
    NU, NV = 28, 24
    P = []; UV = []
    for j in range(NV + 1):
        t = (L + drop) * j / NV
        row = []; uvr = []
        for i in range(NU + 1):
            s = -(hw + drop) + 2 * (hw + drop) * i / NU
            over_s = max(0.0, abs(s) - hw); over_t = max(0.0, t - L)
            x = math.copysign(min(abs(s), hw) + 0.03 * min(1, over_s / 0.06), s)
            yq = y0 + min(t, L) + 0.03 * min(1, over_t / 0.06)
            z = BZ + 0.035 - over_s - over_t + 0.012 * math.sin(s * 9.5) * math.sin(t * 9.5) * (over_s == 0) * (over_t == 0)
            row.append(Vector((x, yq, max(z, 0.2)))); uvr.append((i / NU, 1 - j / NV))
        P.append(row); UV.append(uvr)
    mb('quilt').grid(P, UV)
    for sx in (-1, 1):
        soft('linen_white', (sx * 0.36, -BL / 2 + 0.30, BZ + 0.13), (0.62, 0.40, 0.17), n=3.5, segs=16, rings=8, tile=0.3,
             R=Matrix.Rotation(0.35, 3, 'X'))
    soft('linen_teal', (0.05, -BL / 2 + 0.52, BZ + 0.16), (0.36, 0.12, 0.34), n=3.2, segs=14, rings=8, tile=0.3,
         R=Matrix.Rotation(0.3, 3, 'X'))
    soft('knit_cream', (0, BL / 2 - 0.38, BZ + 0.075), (1.36, 0.42, 0.07), n=6, segs=16, rings=4, tile=0.25)
# Bedside: a small table, a lamp, Evie asleep on a chart in a frame, books.
BST = Vector((-3.14, FRONT + 0.26, 0))
wood(BST + Vector((0, 0, 0.27)), (0.42, 0.38, 0.54))
wood(BST + Vector((0, 0.196, 0.40)), (0.36, 0.012, 0.16), 'walnut')
sphere('brass', BST + Vector((0, 0.21, 0.40)), 0.014, segs=6, rings=4)
lamp(BST + Vector((-0.08, -0.04, 0.54)), r=0.13, h=0.17, stem=0.2, base='c_teal', glow=1.0)
standing(2, BST + Vector((0.1, 0.08, 0.54)), (0.2, 1, 0), 0.17, 'white_wood')
# Above the bed.
frame(7, (-4.42, FRONT + 0.014, 1.80), S, 0.36, 'white_wood')
frame(2, (-3.78, FRONT + 0.014, 1.74), S, 0.48, 'oak')
fairy(swags((-4.92, FRONT + 0.04, 2.30), (-3.0, FRONT + 0.04, 2.42), 4, 0.14), 0.14)
# A braided rug to step out onto, slippers.
lathe('braided', [(0.8, 0.008)], (-2.75, -3.05, 0), segs=28, capt=True)
for dx in (0, 0.13):
    soft('linen_pink', (-3.28 + dx, -3.5, 0.05), (0.10, 0.26, 0.09), n=3.5, segs=10, rings=6, tile=0.2, R=Matrix.Rotation(0.2, 3, 'Z'))
# The chest of drawers.
CH = Vector((-2.25, FRONT + 0.25, 0))
wood(CH + Vector((0, 0, 0.44)), (1.0, 0.46, 0.84), 'white_wood')
wood(CH + Vector((0, 0, 0.875)), (1.06, 0.50, 0.03))
for k in range(3):
    wood(CH + Vector((0, 0.236, 0.17 + k * 0.265)), (0.92, 0.012, 0.235), 'white_wood')
    for sx in (-1, 1):
        sphere('brass', CH + Vector((sx * 0.26, 0.25, 0.17 + k * 0.265)), 0.016, segs=6, rings=4)
plant(0, CH + Vector((-0.3, -0.04, 0.89)), 0.5)
standing(4, CH + Vector((0.1, 0.02, 0.89)), (0.15, 1, 0), 0.17)
wood(CH + Vector((0.36, 0.0, 0.93)), (0.16, 0.12, 0.08), 'walnut')
CANDLE = CH + Vector((0.34, 0.14, 0.89))
lathe('c_white', [(0.03, 0), (0.03, 0.09), (0.0, 0.09)], CANDLE, segs=8, capb=True)
with part('Candle', CANDLE + Vector((0, 0, 0.09))):
    lathe('flame', [(0.0, 0.0), (0.009, 0.012), (0.006, 0.03), (0.0, 0.045)], CANDLE + Vector((0, 0, 0.092)), segs=6)
    halo('glow_soft', CANDLE + Vector((0, 0, 0.11)), 0.5)
# The big chart, framed, on the door wall.
frame(('chart', 1.5), (-0.35, FRONT + 0.014, 1.95), S, 2.0, 'oak', border=0.05, depth=0.04)
# The door, coats on their pegs, boots under them.
DOOR_X = 2.05
card(one_sided('door'), (DOOR_X, FRONT + 0.03, 1.025), S, 0.9, 2.05)
for sx in (-1, 1):
    box(one_sided('white_wood'), (DOOR_X + sx * 0.49, FRONT + 0.03, 1.07), (0.08, 0.06, 2.14), tile=0.9, skip=-S)
box(one_sided('white_wood'), (DOOR_X, FRONT + 0.03, 2.10), (1.06, 0.06, 0.08), tile=0.9, skip=-S)
sphere('brass', (DOOR_X - 0.36, FRONT + 0.075, 1.0), 0.03, segs=8, rings=5)
soft('linen_grey', (DOOR_X, FRONT + 0.42, 0.008), (0.8, 0.5, 0.016), n=8, segs=12, rings=4, tile=0.3)
PEG_Z = 1.74
wood((3.2, FRONT + 0.03, PEG_Z), (0.94, 0.03, 0.09))
for k in range(4):
    tube('brass', (2.86 + k * 0.23, FRONT + 0.04, PEG_Z), (2.86 + k * 0.23, FRONT + 0.11, PEG_Z + 0.02), 0.01, segs=6, caps=True)
drape('coat_white', 2.70, 3.02, FRONT + 0.12, 0.72, PEG_Z, 3, 0.03, folds=True)
drape('coat_yellow', 3.18, 3.44, FRONT + 0.11, 0.92, PEG_Z, 2, 0.03, folds=True)
drape('knit_blue', 3.50, 3.62, FRONT + 0.10, 0.95, PEG_Z, 1, 0.015, tile=0.25)
wood((3.2, FRONT + 0.18, 0.40), (0.94, 0.32, 0.03))
for sx in (-1, 1):
    wood((3.2 + sx * 0.45, FRONT + 0.18, 0.2), (0.03, 0.32, 0.4))
for x, key, h in ((2.92, 'linen_navy', 0.30), (3.05, 'linen_navy', 0.30), (3.32, 'linen_white', 0.11), (3.45, 'linen_white', 0.11)):
    soft(key, (x, FRONT + 0.2, h / 2 + 0.005), (0.10, 0.26, h), n=4, segs=10, rings=6, tile=0.2)
# The wardrobe in the corner, a case and a basket on top.
WR = Vector((4.3, FRONT + 0.31, 0))
wood(WR + Vector((0, 0, 1.0)), (1.1, 0.6, 2.0), 'white_wood')
for sx in (-1, 1):
    card('wardrobe', WR + Vector((sx * 0.27, 0.303, 1.02)), S, 0.52, 1.88)
    sphere('brass', WR + Vector((sx * 0.05, 0.32, 1.05)), 0.016, segs=6, rings=4)
soft('linen_navy', WR + Vector((-0.1, 0, 2.09)), (0.6, 0.4, 0.17), n=8, segs=14, rings=6, tile=0.3)
plant(0, (1.2, FRONT + 0.36, 0), 0.95, 0.6)

# ════════════════════════════════════════════════════════════════════════
# The left wall between bed and sofa: low shelves, the record player, Evie's tree
# ════════════════════════════════════════════════════════════════════════
log("left wall")
LS = Vector((-HW + 0.17, -1.1, 0))
LS_H = 0.92
with place(LS):
    for sy in (-1, 1):
        wood((0, sy * 0.79, LS_H / 2), (0.32, 0.025, LS_H))
    wood((-0.15, 0, LS_H / 2), (0.012, 1.58, LS_H), 'walnut')
    for z in (0.05, 0.47, LS_H - 0.0125):
        wood((0, 0, z), (0.32, 1.6, 0.025))
    books((0.13, -0.77, 0.0625), (0, 1, 0), (1, 0, 0), 1.54, 0.36, fill=0.95)
    books((0.13, -0.77, 0.4825), (0, 1, 0), (1, 0, 0), 1.0, 0.36)
    pile((0.0, 0.5, 0.4825), (1, 0), 4, 0.1)
    # The record player, a record on.
    wood((0.0, 0.28, LS_H + 0.035), (0.30, 0.40, 0.07), 'walnut')
    tube('steel', (0.11, 0.42, LS_H + 0.07), (0.11, 0.42, LS_H + 0.10), 0.012, segs=6)
    beam('steel', (0.11, 0.42, LS_H + 0.10), (0.03, 0.30, LS_H + 0.088), 0.008, 0.006)
    for k in range(6):
        wood((-0.08 + 0.004 * k, -0.02 - 0.012 * k, LS_H + 0.16), (0.31, 0.006, 0.31),
             ('c_coral', 'c_navy', 'c_mustard', 'c_teal', 'c_white', 'c_pink')[k], R=Matrix.Rotation(-0.12, 3, 'X'))
    sprite('things', 3, (0.0, -0.55, LS_H), E, 0.3)
    halo('glow_soft', (0.02, -0.55, LS_H + 0.14), 0.6)
VINYL = LS + Vector((-0.02, 0.26, LS_H + 0.074))
with part('Vinyl', VINYL):
    lathe('vinyl', [(0.14, 0.004)], VINYL, segs=24, capt=True)
    lathe('black', [(0.14, 0.0), (0.14, 0.004)], VINYL, segs=24)
frame(10, (-HW + 0.014, -1.1, 1.62), E, 0.44, 'walnut')
# Evie's tree: posts wound in rope, a den, a perch, a toy on a string.
CT_C = Vector((-4.45, 0.02, 0))
TOY = None
with place(CT_C):
    soft('linen_grey', (0, 0, 0.03), (0.62, 0.62, 0.06), n=8, segs=12, rings=4, tile=0.3)
    tube('sisal', (-0.16, -0.16, 0.05), (-0.16, -0.16, 1.02), 0.045, segs=10, tile=0.25)
    tube('sisal', (0.16, 0.16, 0.05), (0.16, 0.16, 0.62), 0.045, segs=10, tile=0.25)
    soft('linen_grey', (0.12, 0.14, 0.64), (0.42, 0.40, 0.05), n=8, segs=12, rings=4, tile=0.3)
    soft('linen_grey', (0.12, -0.14, 0.22), (0.36, 0.34, 0.32), n=6, segs=12, rings=6, tile=0.3)
    lathe('black', [(0.10, 0.0)], (0.302, -0.14, 0.22), (1, 0, 0), segs=12, capt=True)
    lathe('linen_grey', [(0.0, 1.02), (0.20, 1.02), (0.25, 1.07), (0.24, 1.10), (0.18, 1.06), (0.0, 1.05)], (-0.16, -0.16, 0), segs=16, tile=0.3)
    soft('knit_cream', (-0.16, -0.16, 1.075), (0.34, 0.34, 0.05), n=3, segs=12, rings=4, tile=0.25)
    TOY = here((0.33, 0.14, 0.615))
sprite('things', 6, (-3.85, -0.62, 0.012), (0, 0, 1), 0.34, centre=True, up=(0.3, 1, 0))       # a feather on a stick, a mouse: left on the floor
with part('CatToy', TOY):
    tube('wire', TOY, TOY + Vector((0, 0, -0.30)), 0.003, segs=3)
    sphere('c_coral', TOY + Vector((0, 0, -0.33)), 0.035, segs=8, rings=6)
# A mobile of fish over it, turning.
MOB = Vector((CT_C.x + 0.25, CT_C.y, roof(CT_C.x + 0.25) - 0.02))
MOB_Z = 2.05
with part('Mobile', MOB):
    tube('wire', MOB, (MOB.x, MOB.y, MOB_Z), 0.003, segs=3)
    for a in (0, math.pi / 2):
        d = Vector((math.cos(a), math.sin(a), 0)) * 0.2
        tube('oak', Vector((MOB.x, MOB.y, MOB_Z)) - d, Vector((MOB.x, MOB.y, MOB_Z)) + d, 0.006, segs=5)
    for k, idx in enumerate((0, 3, 2, 4)):
        a = k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        tip = Vector((MOB.x, MOB.y, MOB_Z)) + d * 0.2
        drop = 0.14 + 0.05 * (k % 2)
        tube('wire', tip, tip - Vector((0, 0, drop)), 0.002, segs=3)
        sprite('fish', idx, tip - Vector((0, 0, drop + 0.05)), d, 0.11, centre=True)

# ════════════════════════════════════════════════════════════════════════
# Under the roof: the big lamp, hanging plants, lights along the tie
# ════════════════════════════════════════════════════════════════════════
log("under the roof")
TY = TIES[1]
PEND_C = Vector((0, TY, TIE_Z - 0.08))
PC_Z = 2.62
with part('PendantRoom', PEND_C):
    tube('wire', PEND_C, (0, TY, PC_Z + 0.33), 0.006, segs=4)
    lathe('basket', [(0.05, 0.33), (0.22, 0.26), (0.33, 0.08), (0.34, -0.06), (0.26, -0.22), (0.14, -0.30)], (0, TY, PC_Z),
          segs=20, tile=0.25)
    sphere('bulb', (0, TY, PC_Z), 0.07, segs=10, rings=6)
    halo('glow', (0, TY, PC_Z), 1.7)
HANG = []
for k, x in enumerate((-1.95, 1.95)):
    top = Vector((x, TY, TIE_Z - 0.08))
    with part(f'Hanging{k}', top):
        crossed('plants', 2, top - Vector((0, 0, 0.95)), 0.95, 0.4 + k)
    HANG.append(f'Hanging{k}')
fairy(swags((-2.66, TY - 0.07, TIE_Z - 0.06), (2.66, TY - 0.07, TIE_Z - 0.06), 7, 0.16), 0.15)
fairy(swags((-2.66, TIES[0] + 0.07, TIE_Z - 0.06), (2.66, TIES[0] + 0.07, TIE_Z - 0.06), 7, 0.16), 0.15)

# The fairy lights' bulbs: three sets, each one object that dims by shrinking every bulb about its own middle.
TWINKLE = []
OCT = [Vector(v) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
OCT_F = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
for g, pts in BULBS.items():
    v = []; dim = []; f = []; uv = []
    for p in pts:
        b = len(v)
        v += [p + o * 0.02 for o in OCT]; dim += [p + o * 0.008 for o in OCT]
        f += [tuple(b + i for i in t) for t in OCT_F]; uv += [(0.5, 0.5)] * 6
    TWINKLE.append(whole(f'Fairy{g}', 'bulb', v, f, uv, {'Dim': dim}, smooth=False))
    v = []; dim = []; f = []; uv = []
    for p in pts:
        for r, t in ((Vector((1, 0, 0)), Vector((0, 0, 1))), (Vector((0, 1, 0)), Vector((0, 0, 1)))):
            b = len(v)
            for sr, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                v.append(p + (r * sr + t * st) * 0.085); dim.append(p + (r * sr + t * st) * 0.03)
                uv.append(((sr + 1) / 2, (st + 1) / 2))
            f.append((b, b + 1, b + 2, b + 3))
    TWINKLE.append(whole(f'FairyGlow{g}', 'glow_soft', v, f, uv, {'Dim': dim}, smooth=False))
log(f"fairy lights: {sum(len(p) for p in BULBS.values())} bulbs")

# ════════════════════════════════════════════════════════════════════════
# Finalise; the navigation mesh: the floor, less everything that stands on it
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
COLL = finalise('EvesRoom')
I = INSET
WALK = [(-HW + I, HW - I, FRONT + I, BACK - I)]
FOOT = [                                                           # (x0, x1, y0, y1) of what stands on the floor
    (-WIN_HW - 0.05, WIN_HW + 0.05, BACK - 0.6, BACK),                  # window seat
    (-4.0, -2.0, BACK - 0.5, BACK),                                     # sideboard
    (-1.98, -1.5, BACK - 0.55, BACK),                                   # the fig
    (-4.85, -4.4, BACK - 0.56, BACK),                                   # standard lamp
    (-HW, -4.05, 0.42, 2.78),                                           # sofa
    (TABLE.x - 0.42, TABLE.x + 0.42, TABLE.y - 0.42, TABLE.y + 0.42),   # low table
    (POUFFE.x - 0.26, POUFFE.x + 0.26, POUFFE.y - 0.26, POUFFE.y + 0.26),
    (2.1, 3.7, BACK - 0.7, BACK),                                       # desk
    (2.44, 3.0, 2.14, 2.72),                                            # its chair
    (3.86, 4.86, BACK - 0.34, BACK),                                    # bookcase
    (1.66, 2.02, BACK - 0.48, BACK),                                    # chart basket
    (KX - 0.64, HW, -2.0, K1 + 0.02),                                   # fridge and cupboards
    (KX - 0.45, HW, -2.92, -2.32),                                      # Evie's bowls
    (DT_C.x - 0.48, DT_C.x + 0.48, -1.3, 0.4),                          # table and chairs
    (-HW, BED.x + BW / 2 + 0.03, FRONT, BED.y + BL / 2 + 0.03),         # bed
    (BST.x - 0.21, BST.x + 0.21, FRONT, FRONT + 0.46),                  # bedside table
    (CH.x - 0.53, CH.x + 0.53, FRONT, FRONT + 0.5),                     # chest of drawers
    (0.9, 1.5, FRONT, FRONT + 0.66),                                    # the monstera
    (2.73, 3.67, FRONT, FRONT + 0.36),                                  # boots under the pegs
    (WR.x - 0.55, HW, FRONT, FRONT + 0.62),                             # wardrobe
    (-HW, -HW + 0.34, -1.9, -0.3),                                      # low shelves
    (CT_C.x - 0.32, CT_C.x + 0.36, CT_C.y - 0.32, CT_C.y + 0.32),       # Evie's tree
]
navmesh('Room-navmesh', COLL, WALK, [(a - I, b + I, c - I, d + I) for a, b, c, d in FOOT])

# ════════════════════════════════════════════════════════════════════════
# Animation: one loop
# ════════════════════════════════════════════════════════════════════════
log("animation")
LOOP = kit.LOOP
SHOT = LOOP / len(SHOTS)                                            # six seconds a picture


def shot(k):
    """One of the television's pictures: on for its six seconds, drifting
    and closing in a little the while (the cabinet hides what spills over)."""
    dx, dz = ((1, 0.5), (-1, -0.5), (0.5, -1), (-1, 0.5), (1, -0.5), (-0.5, 1))[k]

    def fn(t):
        u = (t - k * SHOT) / SHOT
        if not 0 <= u < 1:
            return {'loc': (0, 0, 0), 'scale': 0.001}
        return {'loc': (0.012 * dx * (2 * u - 1), 0, 0.006 * dz * (2 * u - 1)), 'scale': 1.0 + 0.03 * u}
    return fn


for k, name in enumerate(SHOTS):
    animate(PARTS[name], shot(k))


def swim(k):
    """A fish: along the tank and back, turning at each end."""
    period = (9, 12, 18, 6, 12, 9, 18, 12)[k]
    reach = (TK_W / 2 - 0.09) * (0.75 + 0.03 * k)
    ph = 0.9 * k
    x0 = PARTS[f'Fish{k}'].location.x - TK.x

    def fn(t):
        th = 2 * math.pi * t / period + ph
        x = reach * math.sin(th) - x0
        head = 0.5 + 0.5 * max(-1.0, min(1.0, math.cos(th) * 5))      # 0 swimming left, 1 swimming right
        return {'loc': (x, 0, 0.012 * math.sin(2 * math.pi * t / 3 + k)), 'rot': (0, 0, math.pi * head)}
    return fn


for k, name in enumerate(FISH):
    animate(PARTS[name], swim(k))
animate(PARTS['Bubbles'], lambda t: {'loc': (0.004 * math.sin(2 * math.pi * t / 1.5), 0, 0.07 * ((t % 2.0) / 2.0))})


def puff(start):
    """Steam: a wisp that rises, spreads and thins away, every three seconds."""
    def fn(t):
        u = ((t / 3.0) + start) % 1.0
        s = (0.35 + 0.75 * u) * (1.0 if u < 0.6 else (1 - u) / 0.4)
        return {'loc': (0.02 * math.sin(2 * math.pi * u * 1.5 + 6 * start), 0, 0.26 * u), 'scale': max(0.001, s)}
    return fn


for name, start in STEAM:
    animate(PARTS[name], puff(start))
# Fairy lights: each set breathes on its own count.
for k, ob in enumerate(TWINKLE):
    g = k // 2
    animate_shapes(ob, lambda t, g=g: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / (4, 6, 9)[g] + 2.1 * g)})
for ob, ph in zip(CURTAINS, (0.0, 1.9)):
    animate_shapes(ob, lambda t, ph=ph: {'SwayA': math.cos(2 * math.pi * t / 9 + ph), 'SwayB': math.sin(2 * math.pi * t / 9 + ph)})
# A pendulum's period is 2π√(L/g). The clock's is a quarter of a metre: one second.
animate(PARTS['Pendulum'], lambda t: {'rot': (0, math.radians(7) * W(1.0)(t), 0)})
# The record: 33⅓ turns a minute is one turn in 1.8 s.
animate(PARTS['Vinyl'], lambda t: {'rot': (0, 0, -2 * math.pi * t / 1.8)})
# What hangs, by its length: the table lamp on 1.26 m (2.25 s), the room's on 0.8 m (1.8 s),
# the plants on 0.56 m (1.5 s), Evie's toy on 0.36 m (1.2 s).
animate(PARTS['PendantTable'], lambda t: {'rot': (math.radians(0.8) * W(2.25)(t), math.radians(0.5) * W(2.25, 1.2)(t), 0)})
animate(PARTS['PendantRoom'], lambda t: {'rot': (math.radians(0.7) * W(1.8)(t), math.radians(0.5) * W(1.8, 1.0)(t), 0)})
for k, name in enumerate(HANG):
    animate(PARTS[name], lambda t, k=k: {'rot': (math.radians(1.6) * W(1.5, 2.0 * k)(t), 0, math.radians(3) * W(9, k)(t))})
animate(PARTS['CatToy'], lambda t: {'rot': (math.radians(7) * W(1.2)(t) * (0.6 + 0.4 * W(12)(t)), math.radians(3) * W(1.2, 1.0)(t), 0)})
animate(PARTS['Mobile'], lambda t: {'rot': (0, 0, 2 * math.pi * t / LOOP)})
animate(PARTS['Candle'], lambda t: {'scale': 1.0 + 0.10 * W(0.75)(t) * W(4, 1.0)(t) + 0.05 * W(1.5, 2.0)(t)})


def lighthouse(t):
    """The lamp comes round every six seconds."""
    u = (t % 6.0) / 6.0
    return {'scale': 0.35 + 1.1 * math.exp(-((u - 0.5) / 0.09) ** 2)}


animate(PARTS['LighthouseGlow'], lighthouse)


def glide(k):
    """A gull crossing the window, wings beating; it turns back out of sight."""
    period = (18, 36, 12)[k]
    span = 3.4

    def fn(t):
        u = (t / period + 0.3 * k) % 1.0
        sgn = 1 if k % 2 == 0 else -1
        x = sgn * span * (2 * u - 1)
        return {'loc': (x, 0, 0.25 * math.sin(2 * math.pi * u * 2 + k)), 'scale': (1.0, 1.0, 0.55 + 0.45 * math.sin(2 * math.pi * t / 0.75 + k) ** 2)}
    return fn


for k, name in enumerate(GULLS):
    animate(PARTS[name], glide(k))

kit.export('eves_room.glb', blend='blend' in argv[2:])
log("done")
