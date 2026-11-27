"""Build Rex's Cabin and export it as a GLB background (step 2 of 2).

    python3 rexs_cabin/paint_textures.py <tex_dir>
    blender -b --factory-startup --python build_rexs_cabin.py -- <out_dir> <tex_dir> [blend]

The quartermaster's cabin aboard the Rexmaw, on a quiet evening at her
berth: where Rex lives when the crew has gone ashore. The stern windows run
across the back over a cushioned seat, and look out on the harbour a quarter
of an hour after sunset: the pier and the town to port, the lighthouse to
starboard. The old logbooks stand on their shelf left of the windows, the
board of what is booked hangs right of them over the sea chest with Ma's
basket on it. The berth is built in along the left wall, the washstand and
the fishing gear forward of it; the desk with the manifest stands against
the right wall, the stove and the armchair forward of that. The crew's
photographs hang on the wall behind the camera.

Blender coords (scene_kit.py): Z up, spawn at the origin facing -Y, the
stern at +Y. Walls and ceiling are one-sided, so a camera that backs out
through one still sees the cabin. What moves: she rolls a little at her
moorings, so everything that hangs swings together and the horizon tilts
with it; the stove's fire, steam, the lamps; the bunting (it spells REXMAW
in signal flags); out of the windows boats, gulls, the lamps on the water
and the lighthouse; and twice to the loop the Duchess comes up under the
stern to look in.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_kit as kit
from scene_kit import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = argv[0] if argv else os.path.join(HERE, 'rexs_cabin', 'out')
kit.init('cabin', OUT, argv[1] if len(argv) > 1 else os.path.join(OUT, 'textures'), fps=12, loop=36.0, seed=7)

# ════════════════════════════════════════════════════════════════════════
# Layout
# ════════════════════════════════════════════════════════════════════════
HW = 4.3              # half the cabin's width, side to side
BACK = 3.5            # the stern, with the windows
FRONT = -4.1          # the bulkhead behind the camera
CEIL = 2.8            # the deck planks overhead; the beams hang 0.22 below
BEAM_Z = CEIL - 0.22
DADO = 0.95           # top of the panelling, and the window sill
INSET = 0.3           # navmesh clearance: about a body's half width (the app keeps 0.25 m for the shoulders)
WIN_HW = 2.6          # the stern windows: half their width, their sill, their head
SILL = DADO
WIN_TOP = 2.3
BEAMS = [FRONT + 0.45 + 0.95 * k for k in range(8)]       # where the deck beams cross
# The view: a picture 14 m wide bent in a half circle round the windows (so no angle through them
# finds its edge), its horizon at eye height.
VIEW_W = 14.0
VIEW_R = VIEW_W / math.pi
VIEW_H = VIEW_W / 2
VIEW_MID = math.radians(-10)       # the bearing of the picture's middle from the windows: the lighthouse just shows from the spawn
HORIZON = 1.5
PIC_HORIZON = SPR['view']['horizon']
PIC_LAMP = SPR['view']['lamp']     # the lighthouse's lamp, as fractions from the picture's left and top
VIEW_SKY = SPR['view']['sky']      # the picture carries that much more sky above its own top
AXIS = Vector((0, BACK, HORIZON))  # what is out of doors turns about this line fore and aft as she rolls
N = Vector((0, -1, 0))             # what faces the room from the stern
S = Vector((0, 1, 0))              # … from the bulkhead behind the camera
E = Vector((1, 0, 0))              # … from the left wall
Wst = Vector((-1, 0, 0))           # … from the right wall
UP = Vector((0, 0, 1))
LX, RX, FY = -HW + 0.014, HW - 0.014, FRONT + 0.014      # where pictures hang on the left, right and front walls

# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
log("materials")
M['floor'] = make_mat('DeckBoards', img='floor', nrm='floor_n', rough=0.55, glow=0.10)
M['wall'] = make_mat('PaintedPlanks', img='wall', rough=0.85, glow=0.28, single=True)
M['wainscot'] = make_mat('Panelling', img='wainscot', rough=0.6, glow=0.22, single=True)
M['ceiling'] = make_mat('DeckHead', img='ceiling', rough=0.8, glow=0.28, single=True)
for key, name, g in (('mahogany', 'Mahogany', 0.18), ('oak', 'Oak', 0.16), ('beam', 'Beam', 0.12), ('navy_wood', 'NavyPaint', 0.26),
                     ('white_wood', 'CreamPaint', 0.30), ('leather', 'Leather', 0.20), ('ledger', 'LedgerCloth', 0.20),
                     ('basket', 'Wicker', 0.2), ('net', 'Netting', 0.2), ('spines', 'Books', 0.2), ('logs', 'LogSpines', 0.3),
                     ('tiles', 'StoveTiles', 0.16), ('slate', 'Slate', 0.16), ('door', 'Door', 0.24), ('drawer', 'Drawer', 0.22),
                     ('locker', 'LockerDoor', 0.26), ('manifest', 'Manifest', 0.42), ('old_log', 'OldLog', 0.40),
                     ('first_page', 'FirstPage', 0.42), ('party_slip', 'PartySlip', 0.42), ('orders', 'Orders', 0.40),
                     ('board', 'JobsBoard', 0.42), ('crate', 'Crate', 0.26), ('morale', 'MoraleLabel', 0.4), ('plate', 'BrassPlate', 0.4),
                     ('rug', 'Rug', 0.22), ('quilt', 'Quilt', 0.26), ('chart', 'Chart', 0.42), ('ballad', 'Ballad', 0.42),
                     ('ticking', 'Ticking', 0.26), ('knit', 'Knit', 0.24), ('curtain', 'Curtain', 0.24), ('flags', 'SignalFlags', 0.42),
                     ('embers', 'Embers', 1.0)):
    M[key] = make_mat(name, img=key, rough=0.8, glow=g)
for c in ('navy', 'rust', 'mustard', 'cream', 'oilskin'):
    M['linen_' + c] = make_mat('Linen' + c.capitalize(), img='linen_' + c, rough=0.95, spec=0.2, glow=0.24)
M['chart_hole'] = make_mat('ChartWithAHole', img='chart_hole', rough=0.8, glow=0.42, alpha='MASK')
M['harbour'] = make_mat('HarbourView', img='harbour', rough=1.0, spec=0.0, glow=0.95, single=True)
M['high'] = make_mat('SkyOverhead', img='high', rough=1.0, spec=0.0, glow=0.95, single=True)
M['deep'] = make_mat('WaterUnder', img='deep', rough=1.0, spec=0.0, glow=0.95, single=True)
M['sky'] = make_mat('SkyPane', img='sky', rough=0.3, glow=0.9)
M['pictures'] = make_mat('Pictures', img='pictures', rough=0.6, glow=0.5, alpha='MASK', single=True)
M['plants'] = make_mat('Plants', img='plants', rough=0.9, spec=0.1, glow=0.3, alpha='MASK')
M['things'] = make_mat('Things', img='things', rough=0.8, glow=0.36, alpha='MASK')
M['things2'] = make_mat('Things2', img='things2', rough=0.8, glow=0.36, alpha='MASK')
M['boats'] = make_mat('Boats', img='boats', rough=1.0, spec=0.0, glow=0.9, alpha='MASK')
M['duchess'] = make_mat('Duchess', img='duchess', rough=0.7, spec=0.2, glow=0.7, alpha='MASK')
M['gull'] = make_mat('Gull', img='gull', rough=1.0, spec=0.0, glow=0.6, alpha='MASK')
for key in ('glow', 'glow_soft', 'glow_white', 'glow_amber', 'steam', 'flame', 'boats_wake', 'pane'):
    M[key] = make_mat(key.capitalize(), color=(0, 0, 0), img=key, rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['bulb'] = make_mat('Bulb', color=(1.0, 0.9, 0.7), glow=1.0, glow_color=(1.0, 0.86, 0.58))
M['lamp_glass'] = make_mat('LampGlass', color=(1.0, 0.88, 0.60), rough=0.2, glow=1.0, glow_color=(1.0, 0.82, 0.50))
M['wire'] = make_mat('Wire', color=(0.10, 0.12, 0.10), rough=0.8)
M['rope'] = make_mat('Rope', color=(0.72, 0.60, 0.40), rough=0.95, glow=0.22)
M['brass'] = make_mat('Brass', color=(0.80, 0.60, 0.28), rough=0.3, glow=0.28)
M['copper'] = make_mat('Copper', color=(0.78, 0.45, 0.28), rough=0.3, glow=0.26)
M['pewter'] = make_mat('Pewter', color=(0.62, 0.63, 0.64), rough=0.35, glow=0.2)
M['iron'] = make_mat('BlackIron', color=(0.08, 0.08, 0.09), rough=0.5, glow=0.03)
M['black'] = make_mat('Black', color=(0.02, 0.02, 0.025), rough=0.4)
M['paper'] = make_mat('Paper', color=(0.93, 0.90, 0.80), rough=0.9, glow=0.34)
M['scroll'] = make_mat('RolledPaper', color=(0.80, 0.70, 0.50), rough=0.9, glow=0.22)
M['cane'] = make_mat('Cane', color=(0.62, 0.44, 0.22), rough=0.5, glow=0.2)
M['coffee'] = make_mat('Coffee', color=(0.20, 0.11, 0.06), rough=0.3, glow=0.1)
M['tea'] = make_mat('Tea', color=(0.62, 0.32, 0.10), rough=0.2, glow=0.24)
M['wax'] = make_mat('Wax', color=(0.96, 0.92, 0.80), rough=0.6, glow=0.4)
M['flame_hot'] = make_mat('CandleFlame', color=(1.0, 0.9, 0.6), glow=1.0, glow_color=(1.0, 0.80, 0.45))
M['glass_jar'] = make_mat('JarGlass', color=(0.80, 0.90, 0.88), rough=0.1, glow=0.3)
for key, colour in (('green', (0.20, 0.52, 0.40)), ('blue', (0.22, 0.46, 0.62)), ('amber', (0.80, 0.52, 0.18))):
    M['float_' + key] = make_mat('Float' + key.capitalize(), color=colour, rough=0.08, glow=0.5)
for key, colour in (('white', (0.95, 0.94, 0.90)), ('cream', (0.93, 0.88, 0.74)), ('teal', (0.30, 0.56, 0.58)),
                    ('rust', (0.78, 0.36, 0.26)), ('mustard', (0.88, 0.68, 0.26)), ('navy', (0.20, 0.28, 0.46))):
    M['c_' + key] = make_mat('Glaze' + key.capitalize(), color=colour, rough=0.35, glow=0.26)


# ════════════════════════════════════════════════════════════════════════
# The cabin's own shapes
# ════════════════════════════════════════════════════════════════════════
UVFIT.add('crate')    # its stencil goes once across each face
LAMPS = []            # what hangs free of a beam, and swings as she rolls: (part, how far it answers)
FLICKER = []          # lamp and candle flames
FLAMES = []


def dado(p0, p1, facing, h=DADO, w=0.72):
    """Panelling along the foot of a wall from p0 to p1 (x, y): one sunk
    panel to every w or so, and a rail along its top."""
    a = Vector((p0[0], p0[1], 0)); b = Vector((p1[0], p1[1], 0)); f = Vector(facing)
    n = max(1, round((b - a).length / w))
    pts = [a + f * 0.012, b + f * 0.012, b + f * 0.012 + UP * h, a + f * 0.012 + UP * h]
    uvs = [(0, 0), (n, 0), (n, 1), (0, 1)]
    if (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(f) < 0:
        pts.reverse(); uvs.reverse()
    mb('wainscot').face(pts, uvs)
    beam(one_sided('mahogany'), a + f * 0.03 + UP * (h + 0.02), b + f * 0.03 + UP * (h + 0.02), 0.05, 0.045, tile=0.9)


def hoop(key, c, axis, R, r=0.012, n=20, segs=5):
    """A ring about an axis."""
    c = Vector(c); ax = Vector(axis).normalized()
    e1 = ax.orthogonal().normalized(); e2 = ax.cross(e1)
    rope(key, [c + (e1 * math.cos(2 * math.pi * k / n) + e2 * math.sin(2 * math.pi * k / n)) * R for k in range(n + 1)], r, segs)


def porthole(c, normal, r=0.2, glass='sky'):
    """A brass-rimmed port in a wall that faces `normal`: sky through it."""
    c = Vector(c); n = Vector(normal).normalized()
    lathe(one_sided(glass), [(r, 0.0)], c + n * 0.012, n, segs=20, capt=True)
    hoop('brass', c + n * 0.02, n, r, 0.024)
    for k in range(6):
        a = k * math.pi / 3 + 0.3
        e1 = n.orthogonal().normalized(); e2 = n.cross(e1)
        sphere('brass', c + n * 0.03 + (e1 * math.cos(a) + e2 * math.sin(a)) * r, 0.012, segs=5, rings=3)


def ship_lamp(x, y, top=BEAM_Z, glow=1.15, answers=3.6):
    """A brass lantern hung from a deck beam by its ring."""
    name = f'Lamp{len(LAMPS)}'
    top = Vector((x, y, top))
    c = top - UP * 0.47                                                # the lantern's foot
    with part(name, top):
        tube('brass', top, top - UP * 0.10, 0.004, segs=4)
        rope('brass', [c + Vector((0.07 * math.cos(a), 0, 0.30 + 0.07 * math.sin(a))) for a in [math.pi * j / 6 for j in range(7)]], 0.005, segs=4)
        lathe('brass', [(0.085, 0), (0.09, 0.02), (0.06, 0.05)], c, segs=12, capb=True)
        lathe('lamp_glass', [(0.055, 0.05), (0.07, 0.13), (0.055, 0.22)], c, segs=12)
        lathe('brass', [(0.06, 0.22), (0.075, 0.24), (0.04, 0.29), (0.015, 0.31)], c, segs=12)
        for k in range(4):
            d = Vector((math.cos(k * math.pi / 2 + 0.78), math.sin(k * math.pi / 2 + 0.78), 0)) * 0.078
            tube('brass', c + d + UP * 0.04, c + d + UP * 0.23, 0.004, segs=3)
        halo('glow', c + UP * 0.13, glow)
    LAMPS.append((name, answers))


def lantern(c, glow=0.9):
    """A storm lantern standing on c. Its glow is a part of its own, to gutter."""
    c = Vector(c)
    lathe('iron', [(0.065, 0), (0.07, 0.02), (0.045, 0.05)], c, segs=10, capb=True)
    lathe('lamp_glass', [(0.042, 0.05), (0.06, 0.12), (0.042, 0.20)], c, segs=10)
    lathe('iron', [(0.048, 0.20), (0.056, 0.22), (0.028, 0.26), (0.0, 0.27)], c, segs=10)
    rope('iron', [c + Vector((0.075 * math.cos(a), 0, 0.20 + 0.16 * math.sin(a))) for a in [math.pi * j / 6 for j in range(7)]], 0.004, segs=3)
    name = f'Flicker{len(FLICKER)}'
    with part(name, c + UP * 0.12):
        halo('glow', c + UP * 0.12, glow)
    FLICKER.append(name)


def candle(c):
    """A candle in a glass."""
    c = Vector(c)
    name = f'Flicker{len(FLICKER)}'
    lathe('glass_jar', [(0.03, 0), (0.035, 0.01), (0.035, 0.07)], c, segs=10, capb=True)
    lathe('wax', [(0.028, 0.004), (0.028, 0.04), (0.0, 0.04)], c, segs=8)
    with part(name, c + UP * 0.04):
        lathe('flame_hot', [(0.0, 0.0), (0.008, 0.011), (0.005, 0.027), (0.0, 0.04)], c + UP * 0.042, segs=6)
        halo('glow_soft', c + UP * 0.06, 0.42)
    FLICKER.append(name)


def tankard(x, y, top=BEAM_Z):
    """A pewter tankard hung by its handle from a hook under a beam."""
    name = f'Lamp{len(LAMPS)}'
    top = Vector((x, y, top))
    c = top - UP * 0.20
    with part(name, top):
        rope('iron', [top, top - UP * 0.035, top - UP * 0.05 + Vector((0.012, 0, 0))], 0.004, segs=3)
        lathe('pewter', [(0.042, 0), (0.046, 0.012), (0.040, 0.13), (0.036, 0.13), (0.036, 0.014)], c + Vector((0.055, 0, 0)), segs=10, capb=True)
        rope('pewter', [c + Vector((0.012 - 0.03 * math.sin(a), 0, 0.075 + 0.05 * math.cos(a))) for a in [math.pi * j / 5 for j in range(6)]], 0.006, segs=4)
    LAMPS.append((name, 4.5))


def teapot(c, key='c_cream', s=1.0, towards=(1, 0, 0)):
    c = Vector(c); d = Vector(towards).normalized()
    lathe(key, [(0.05 * s, 0), (0.085 * s, 0.04 * s), (0.09 * s, 0.09 * s), (0.05 * s, 0.13 * s), (0.03 * s, 0.14 * s), (0.0, 0.15 * s)],
          c, segs=14, capb=True)
    sphere(key, c + Vector((0, 0, 0.158 * s)), 0.014 * s, segs=6, rings=4)
    tube(key, c + d * 0.075 * s + UP * 0.06 * s, c + d * 0.15 * s + UP * 0.12 * s, 0.016 * s, 0.009 * s, segs=6)
    rope(key, [c - d * (0.08 + 0.045 * math.sin(a)) * s + UP * (0.075 + 0.045 * math.cos(a)) * s for a in
               [math.pi * j / 6 for j in range(7)]], 0.007 * s, segs=4)


def armchair(pos, yaw, cushion='linen_mustard'):
    """A deep leather armchair; unturned, it faces +Y."""
    with place(pos, yaw):
        soft('leather', (0, 0.02, 0.30), (0.62, 0.66, 0.26), n=6, segs=16, rings=6, tile=0.5)
        soft('leather', (0, -0.30, 0.62), (0.70, 0.20, 0.72), n=5, segs=16, rings=8, tile=0.5, R=Matrix.Rotation(-0.16, 3, 'X'))
        for sx in (-1, 1):
            soft('leather', (sx * 0.36, 0.0, 0.40), (0.18, 0.74, 0.50), n=5, segs=14, rings=8, tile=0.5)
            for sy in (-1, 1):
                tube('mahogany', (sx * 0.30, sy * 0.28, 0.16), (sx * 0.32, sy * 0.30, 0), 0.03, 0.02, segs=6)
        soft('leather', (0, 0.04, 0.46), (0.52, 0.56, 0.12), n=5, segs=14, rings=6, tile=0.5)
        soft(cushion, (0.02, -0.16, 0.68), (0.38, 0.12, 0.36), n=3.2, segs=14, rings=8, tile=0.3, R=Matrix.Rotation(-0.3, 3, 'X'))


def ledger(c, k, t=0.08, h=0.30, d=0.22, lean=0.0):
    """One of the old logbooks standing on a shelf, its spine to the room:
    c the middle of its foot, k its number."""
    c = Vector(c)
    R = Matrix.Rotation(lean, 3, 'Y')
    box('ledger', c + R @ Vector((0, 0, h / 2)), (t, d, h), R, tile=0.5)
    card('logs', c + R @ Vector((0, -d / 2 - 0.002, h / 2)), N, t, h, up=R @ UP, u0=k / 16, u1=(k + 1) / 16)


def lockers(x0, x1, y, facing, z=0.24, h=0.40, key='locker'):
    """A run of panelled locker doors across a front that faces `facing`."""
    n = max(1, round((x1 - x0) / 0.62))
    for k in range(n):
        x = x0 + (k + 0.5) * (x1 - x0) / n
        card(key, (x, y, z), facing, (x1 - x0) / n - 0.03, h)
        sphere('brass', (x, y + Vector(facing).y * 0.012, z + h / 2 - 0.05), 0.013, segs=6, rings=4)


def bunting(p1, p2, n_swag, depth, spacing=0.27, w=0.20, h=0.15):
    """Signal flags on a line hung in swags, as one object: 'Sway' carries
    every flag's foot along the line, 'Flutter' each its own way across it."""
    pts = swags(p1, p2, n_swag, depth)
    rope('rope', pts, 0.004, segs=3)
    v = []; sway = []; flut = []; f = []; uv = []
    left = spacing / 2; k = 0
    for a, b in zip(pts[:-1], pts[1:]):
        L = (b - a).length
        d = (b - a).normalized()
        while left <= L:
            c = a.lerp(b, left / L)
            s = SPR['flags'][k % len(SPR['flags'])]
            base = len(v)
            for sr, st in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
                p = c + d * sr * w / 2 - UP * st * h
                v.append(p)
                sway.append(p + Vector((0.07 * st, 0, 0.006 * st)))
                flut.append(p + Vector((0, (0.04 if k % 2 else -0.04) * st, 0)))
                uv.append((s['u0'] if sr < 0 else s['u1'], 1.0 - st))
            f.append((base, base + 1, base + 2, base + 3))
            k += 1; left += spacing
        left -= L
    log(f"bunting: {k} flags")
    return whole('Bunting', 'flags', v, f, uv, {'Sway': sway, 'Flutter': flut}, smooth=False)


# ════════════════════════════════════════════════════════════════════════
# The shell: deck, sides, deckhead
# ════════════════════════════════════════════════════════════════════════
log("shell")
floor('floor', -HW, HW, FRONT, BACK, 0, tile=3.0)
WIN = (-WIN_HW, WIN_HW, SILL, WIN_TOP)
pierced_y('wall', -HW, HW, 0, CEIL, BACK, [WIN], tile=1.2, facing=N)
wall_y('wall', -HW, HW, 0, CEIL, FRONT, tile=1.2, facing=S)
wall_x('wall', FRONT, BACK, 0, CEIL, -HW, tile=1.2, facing=E)
wall_x('wall', FRONT, BACK, 0, CEIL, HW, tile=1.2, facing=Wst)
dado((-HW, BACK), (HW, BACK), N)
dado((-HW, FRONT), (HW, FRONT), S)
dado((-HW, FRONT), (-HW, BACK), E)
dado((HW, FRONT), (HW, BACK), Wst)
# The deckhead: painted planks on beams, a knee under each beam's end.
poly('ceiling', [(-HW, FRONT, CEIL), (HW, FRONT, CEIL), (HW, BACK, CEIL), (-HW, BACK, CEIL)], 1.6, (0, 1), facing=(0, 0, -1))
for y in BEAMS:
    beam('beam', (-HW, y, CEIL - 0.11), (HW, y, CEIL - 0.11), 0.16, 0.22, tile=1.2)
    for sx in (-1, 1):
        beam('beam', (sx * (HW - 0.02), y, CEIL - 0.60), (sx * (HW - 0.46), y, CEIL - 0.20), 0.12, 0.12, up=(0, 1, 0), tile=1.2)
for sx in (-1, 1):                                                    # the shelf the beams land on, along each side
    beam('beam', (sx * (HW - 0.05), FRONT, CEIL - 0.26), (sx * (HW - 0.05), BACK, CEIL - 0.26), 0.10, 0.10, tile=1.2)

# ════════════════════════════════════════════════════════════════════════
# The stern windows, and the harbour beyond
# ════════════════════════════════════════════════════════════════════════
log("windows")
VIEW_TOP = HORIZON + PIC_HORIZON * VIEW_H                           # the top of the picture proper; its extra sky goes above
SKY_TOP = VIEW_TOP + VIEW_SKY * VIEW_H
VIEW_BOT = VIEW_TOP - VIEW_H


def view_u(a):
    """Which part of the picture is at bearing `a` from the windows. Past
    either edge it is laid again, mirrored, to carry the horizon on round."""
    u = 0.5 + (a - VIEW_MID) / math.pi
    return -u if u < 0 else 2 - u if u > 1 else u


def view_a(u):
    """The bearing at which that part of the picture stands."""
    return VIEW_MID + (u - 0.5) * math.pi


def view_at(a, z, r=VIEW_R):
    return Vector((r * math.sin(a), BACK + r * math.cos(a), z))


def view_z(v):
    """The height on the view of a point that far down the picture."""
    return VIEW_TOP - v * VIEW_H


def inward(a):
    return Vector((-math.sin(a), -math.cos(a), 0))


NA = 56
with part('View', AXIS):
    P = []; UV = []
    for z, v in ((VIEW_BOT, 0.0), (SKY_TOP, 1.0)):
        P.append([view_at(-math.pi / 2 + math.pi * k / NA, z) for k in range(NA + 1)])
        UV.append([(view_u(-math.pi / 2 + math.pi * k / NA), v) for k in range(NA + 1)])
    mb('harbour').grid(P, UV, True)
    for z, up in ((SKY_TOP, -1), (VIEW_BOT, 1)):                    # the evening overhead, the dark water under the counter
        poly('high' if up < 0 else 'deep', [(-VIEW_R, BACK, z), (VIEW_R, BACK, z), (VIEW_R, BACK + VIEW_R, z), (-VIEW_R, BACK + VIEW_R, z)],
             1.0, (0, 1), facing=(0, 0, up))
# The lighthouse on the headland, its lamp coming round.
LAMP_A = view_a(PIC_LAMP[0])
LAMP = view_at(LAMP_A, view_z(PIC_LAMP[1]), VIEW_R - 0.06)
with part('LighthouseGlow', LAMP):
    card('glow_white', LAMP, inward(LAMP_A), 0.85, 0.85)
# Lamps on the water: under the pier's lamps and down the path of the afterglow, in three sets that come and go.
GLINTS = []
for g in range(3):
    v = []; dim = []; f = []; uv = []
    for k in range(22):
        if k < 14:                                                    # the pier and the town
            a = view_a(random.uniform(0.03, 0.46)); z = view_z(random.uniform(0.63, 0.84))
        else:                                                         # the afterglow
            a = view_a(random.uniform(0.47, 0.72)); z = view_z(random.uniform(0.60, 0.70))
        c = view_at(a, z, VIEW_R - 0.06)
        r = Vector((math.cos(a), -math.sin(a), 0))
        w, h = random.uniform(0.05, 0.12), random.uniform(0.014, 0.026)
        b = len(v)
        for sr, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            v.append(c + r * sr * w + UP * st * h); dim.append(c + r * sr * w * 0.15 + UP * st * h * 0.15)
            uv.append(((sr + 1) / 2, (st + 1) / 2))
        f.append((b, b + 1, b + 2, b + 3))
    GLINTS.append(whole(f'Glints{g}', 'glow_amber', v, f, uv, {'Dim': dim}, smooth=False))
# Boats at their moorings, each with a riding light and what the water gives back of it; one under sail, crossing.
BOATS = []


def boat(idx, x, depth, h, v, mirror=False, light=None):
    """A boat that far astern, its waterline where the picture's water is
    at `v` down it, as seen from the spawn at eye height. light: where on
    it (across, up; fractions) its riding light hangs."""
    s = SPR['boats'][idx]
    reach = (BACK + depth) / (BACK + VIEW_R)                          # how far out it is, of the way to the picture
    foot = Vector((x, BACK + depth, HORIZON - (HORIZON - view_z(v)) * reach))
    name = f'Boat{len(BOATS)}'
    with part(name, foot):
        w = sprite('boats', idx, foot, N, h, mirror=mirror)
        u0, u1 = (s['u1'], s['u0']) if mirror else (s['u0'], s['u1'])
        card('boats_wake', foot - UP * h * 0.3, N, w, h * 0.6, u0=u0, u1=u1, v0=s['v1'], v1=s['v0'])
        if light:
            card('glow_amber', foot + Vector(((light[0] - 0.5) * w, -0.02, light[1] * h)), N, 0.10, 0.10)
            card('glow_amber', foot + Vector(((light[0] - 0.5) * w, -0.02, -light[1] * h * 0.5)), N, 0.05, 0.14)
    BOATS.append((name, foot))


boat(0, -1.05, 2.5, 0.40, 0.66, light=(0.42, 0.95))                 # the blue fishing boat
boat(6, 0.75, 1.9, 0.10, 0.70, mirror=True)                         # a rowing boat
boat(4, 1.95, 3.1, 0.34, 0.63, light=(0.40, 1.0))                   # the tug
boat(5, 0.0, 3.5, 0.50, 0.615)                                      # the sloop under sail: the last one, it crosses
GULLS = []
for k, (z, size) in enumerate(((2.55, 0.40), (2.15, 0.28), (3.0, 0.22))):
    p = Vector((0, BACK + 1.7 + 0.4 * k, z))
    with part(f'Gull{k}', p):
        card('gull', p, N, size, size / 2)
    GULLS.append((f'Gull{k}', p))
# The Duchess, who lives under the pier and has opinions about this ship: she comes up under the stern
# and looks in over the sill, a spoon in one arm. Down, the planking under the windows hides her.
DUCH_H = 0.86
DUCH_DROP = 1.0
DUCH = Vector((1.06, BACK + 0.30, SILL - 0.30))
with part('Duchess', DUCH):
    sprite('duchess', 0, DUCH, N, DUCH_H)
# The frame: jambs, head, a deep sill, four mullions between five lights, glazing bars across.
FYW = BACK + 0.03
LIGHT = 2 * WIN_HW / 5
for sx in (-1, 1):
    wood((sx * (WIN_HW + 0.04), FYW, (SILL + WIN_TOP) / 2), (0.12, 0.18, WIN_TOP - SILL + 0.20), 'mahogany')
for k in range(1, 5):
    wood((-WIN_HW + k * LIGHT, FYW, (SILL + WIN_TOP) / 2), (0.08, 0.10, WIN_TOP - SILL), 'mahogany')
for k in range(5):
    wood((-WIN_HW + (k + 0.5) * LIGHT, FYW, (SILL + WIN_TOP) / 2), (0.022, 0.03, WIN_TOP - SILL), 'mahogany')
for k in (1, 2):
    wood((0, FYW, SILL + k * (WIN_TOP - SILL) / 3), (2 * WIN_HW, 0.03, 0.022), 'mahogany')
wood((0, FYW, WIN_TOP + 0.05), (2 * WIN_HW + 0.32, 0.18, 0.12), 'mahogany')
wood((0, FYW - 0.07, SILL - 0.02), (2 * WIN_HW + 0.30, 0.32, 0.05), 'mahogany')
card('pane', (0, BACK + 0.02, (SILL + WIN_TOP) / 2), N, 2 * WIN_HW, WIN_TOP - SILL)
# Curtains drawn back at either side, on a brass rod; lights along the head.
tube('brass', (-WIN_HW - 0.42, BACK - 0.07, WIN_TOP + 0.20), (WIN_HW + 0.42, BACK - 0.07, WIN_TOP + 0.20), 0.012, segs=6, caps=True)
for sx in (-1, 1):
    x0, x1 = sorted((sx * (WIN_HW + 0.06), sx * (WIN_HW + 0.40)))
    drape('curtain', x0, x1, BACK - 0.07, 0.56, WIN_TOP + 0.19, 3, 0.03, folds=True)
    sphere('brass', (sx * (WIN_HW + 0.44), BACK - 0.07, WIN_TOP + 0.20), 0.022, segs=6, rings=4)
fairy(swags((-WIN_HW, BACK - 0.11, WIN_TOP + 0.13), (WIN_HW, BACK - 0.11, WIN_TOP + 0.13), 8, 0.09), 0.13)
# The seat under them: lockers below, a long cushion, pillows, Ma's knitting folded at one end.
SEAT_Y = BACK - 0.31
wood((0, SEAT_Y, 0.22), (2 * WIN_HW + 0.2, 0.62, 0.44), 'mahogany')
wood((0, SEAT_Y - 0.01, 0.455), (2 * WIN_HW + 0.24, 0.66, 0.03), 'mahogany')
lockers(-WIN_HW - 0.08, WIN_HW + 0.08, BACK - 0.624, N, key='drawer')
soft('linen_navy', (0, SEAT_Y - 0.01, 0.53), (2 * WIN_HW + 0.1, 0.60, 0.13), n=8, segs=24, rings=6, tile=0.4)
for x, key, a in ((-2.42, 'linen_rust', 0.35), (-2.06, 'linen_cream', 0.2), (2.42, 'linen_mustard', -0.35), (2.08, 'linen_navy', -0.2)):
    soft(key, (x, BACK - 0.17, 0.79), (0.44, 0.16, 0.42), n=2.7, segs=16, rings=10, tile=0.3,
         R=Matrix.Rotation(a, 3, 'Z') @ Matrix.Rotation(-0.25, 3, 'X'))
soft('knit', (-1.45, SEAT_Y - 0.03, 0.64), (0.52, 0.40, 0.10), n=6, segs=14, rings=6, tile=0.25)
soft('knit', (-1.45, SEAT_Y - 0.03, 0.72), (0.50, 0.38, 0.07), n=6, segs=14, rings=6, tile=0.25)
sprite('things', 7, (1.72, SEAT_Y - 0.08, 0.595), N, 0.24)             # the concertina, for the shanties
pile((-0.62, SEAT_Y - 0.06, 0.595), (0, -1), 3, 0.3)
# On the sill: the glass, the tin of what the Duchess has left him, a ship in a bottle, rosemary from the café.
SILL_Y = BACK - 0.10
sprite('things2', 4, (-2.28, SILL_Y, SILL + 0.005), N, 0.34)
sprite('things', 1, (-0.88, SILL_Y, SILL + 0.005), N, 0.20)
sprite('things', 2, (2.02, SILL_Y, SILL + 0.005), N, 0.22)
plant(1, (-1.72, SILL_Y, SILL + 0.005), 0.32, 0.4)
candle((0.42, SILL_Y, SILL + 0.005))
top = Vector((2.36, BACK - 0.46, BEAM_Z + 0.22))
with part('HangIvy', top):
    tube('wire', top, top - UP * 0.30, 0.003, segs=3)
    crossed('plants', 0, top - UP * 1.05, 0.75, 0.6)
LAMPS.append(('HangIvy', 3.0))

# ════════════════════════════════════════════════════════════════════════
# Left of the windows: the old logbooks
# ════════════════════════════════════════════════════════════════════════
log("log shelf")
SX0, SX1, SD, SHH = -4.22, -2.82, 0.30, 2.06                         # the case: its two sides, its depth, its height
SM = (SX0 + SX1) / 2
SYF = BACK - SD                                                      # its front
for x in (SX0, SX1):
    wood((x, BACK - SD / 2, SHH / 2), (0.03, SD, SHH), 'mahogany')
wood((SM, BACK - 0.008, SHH / 2), (SX1 - SX0, 0.012, SHH), 'navy_wood')
SHELF = [0.06 + 0.40 * k for k in range(6)]
for z in SHELF:
    wood((SM, BACK - SD / 2, z), (SX1 - SX0, SD, 0.026), 'mahogany')
ST0 = SX0 + 0.03                                                     # where a row starts
ROW = SX1 - SX0 - 0.06
SZ = lambda k: SHELF[k] + 0.013
SBY = BACK - 0.13                                                    # where things stand on a shelf
BKY = SYF + 0.04                                                     # … and where a row of books has its spines
# Bottom: the big ledgers lying, and Leo's complaints in a box of their own.
pile((ST0 + 0.22, SBY - 0.02, SZ(0)), (0, -1), 4, 0.1)
wood((ST0 + 0.62, SBY, SZ(0) + 0.15), (0.11, 0.26, 0.30), 'ledger')
card('morale', (ST0 + 0.62, SBY - 0.132, SZ(0) + 0.19), N, 0.10, 0.05)
wood((ST0 + 0.76, SBY, SZ(0) + 0.15), (0.11, 0.26, 0.30), 'ledger')
lathe('basket', [(0.13, 0), (0.16, 0.12), (0.155, 0.24), (0.14, 0.24), (0.12, 0.02)], (ST0 + 1.12, SBY - 0.01, SZ(0)), segs=12, tile=0.3, capb=True)
for k in range(5):                                                   # charts, rolled
    a = 0.5 + 1.3 * k
    tube('paper', (ST0 + 1.12 + 0.05 * math.cos(a), SBY - 0.01 + 0.05 * math.sin(a), SZ(0) + 0.03),
         (ST0 + 1.12 + 0.09 * math.cos(a), SBY - 0.01 + 0.09 * math.sin(a), SZ(0) + 0.33 - 0.02 * k), 0.022, segs=6, caps=True)
books((ST0, BKY, SZ(1)), (1, 0, 0), (0, -1, 0), ROW, 0.30, fill=0.94)
# The logs, in order: I to X, then XI to XVI with one gap, where the one on the footstool belongs.
for k in range(10):
    ledger((ST0 + 0.045 + 0.082 * k, SBY, SZ(2)), k)
sprite('things2', 3, (ST0 + 1.10, SBY, SZ(2)), N, 0.25)               # the sextant
for k in range(6):
    gap = 0.10 if k >= 4 else 0.0
    ledger((ST0 + 0.045 + 0.082 * k + gap, SBY, SZ(3)), 10 + k, lean=-0.16 if k == 3 else 0.0)
books((ST0 + 0.66, BKY, SZ(3)), (1, 0, 0), (0, -1, 0), ROW - 0.66, 0.30, fill=0.9)
books((ST0, BKY, SZ(4)), (1, 0, 0), (0, -1, 0), 0.70, 0.30)
sprite('things', 6, (ST0 + 1.04, SBY, SZ(4)), N, 0.22)                # the glass and the ship's clock
plant(4, (SM - 0.36, SBY, SZ(5)), 0.36)
pile((SM + 0.30, SBY, SZ(5)), (0, -1), 3, 0.4)

# ════════════════════════════════════════════════════════════════════════
# Right of the windows: what is booked, and the sea chest with Ma's basket
# ════════════════════════════════════════════════════════════════════════
log("board and chest")
BDX = 3.52
frame(('board', 1408 / 960), (BDX, BACK - 0.014, 1.74), N, 1.40, 'mahogany', border=0.05)
CH = Vector((BDX, BACK - 0.32, 0))
with place(CH):
    wood((0, 0, 0.21), (1.04, 0.50, 0.42), 'navy_wood')
    soft('navy_wood', (0, 0, 0.44), (1.06, 0.52, 0.14), n=6, segs=16, rings=6, tile=0.9)
    for x in (-0.36, 0.36):
        wood((x, 0, 0.26), (0.05, 0.53, 0.53), 'iron')
    wood((0, -0.262, 0.36), (0.09, 0.012, 0.11), 'brass')
    for sx in (-1, 1):
        rope('rope', [Vector((sx * 0.53, -0.12 + 0.24 * j / 6, 0.30 - 0.07 * math.sin(math.pi * j / 6))) for j in range(7)], 0.012, segs=4)
    soft('linen_rust', (0.10, -0.02, 0.515), (0.60, 0.40, 0.012), n=8, segs=10, rings=3, tile=0.3)
    sprite('things', 0, (-0.14, 0.02, 0.518), N, 0.30)                 # the basket: bait, and a fish pie
    sprite('things2', 7, (0.30, -0.08, 0.518), N, 0.12)                # last year's dish, washed, waiting to go back

# ════════════════════════════════════════════════════════════════════════
# The left side: the berth; forward of it the pegs, the washstand, the fishing gear
# ════════════════════════════════════════════════════════════════════════
log("berth")
BY0, BY1, BW = 0.55, 2.80, 1.05                                      # the berth: its foot, its head, its width
BYM = (BY0 + BY1) / 2
BXF = -HW + BW                                                       # its front
BXM = -HW + BW / 2
wood((BXM, BYM, 0.29), (BW, BY1 - BY0, 0.58), 'mahogany')
for k in range(3):
    y = BY0 + (k + 0.5) * (BY1 - BY0) / 3
    card('drawer', (BXF + 0.004, y, 0.30), E, 0.68, 0.36)
    for sy in (-0.2, 0.2):
        sphere('brass', (BXF + 0.02, y + sy, 0.30), 0.014, segs=6, rings=4)
wood((BXF - 0.02, BYM, 0.63), (0.04, BY1 - BY0, 0.12), 'mahogany')     # the leeboard that keeps him in
soft('ticking', (BXM - 0.02, BYM, 0.66), (BW - 0.10, BY1 - BY0 - 0.08, 0.16), n=8, segs=16, rings=6, tile=0.4)
soft('quilt', (BXM - 0.02, BYM - 0.28, 0.75), (BW - 0.06, 1.62, 0.10), n=7, segs=16, rings=6, tile=1.0)
soft('linen_cream', (BXM - 0.02, BY1 - 0.34, 0.80), (0.70, 0.42, 0.15), n=3.4, segs=14, rings=8, tile=0.3)
soft('knit', (BXM - 0.02, BY0 + 0.26, 0.82), (0.80, 0.34, 0.07), n=6, segs=14, rings=6, tile=0.25)
for y in (BY0, BY1):
    wood((BXM, y, 1.11), (BW, 0.04, 2.22), 'mahogany')
wood((BXF - 0.02, BYM, 2.08), (0.04, BY1 - BY0, 0.28), 'mahogany')     # the head board over the opening
wood((BXM, BYM, 2.235), (BW + 0.04, BY1 - BY0 + 0.04, 0.03), 'mahogany')
with place((BXF + 0.02, 0, 0), math.pi / 2):                          # its curtains, drawn back to either end
    drape('curtain', BY0 + 0.04, BY0 + 0.36, 0, 0.66, 1.95, 3, 0.03, folds=True)
    drape('curtain', BY1 - 0.36, BY1 - 0.04, 0, 0.66, 1.95, 3, 0.03, folds=True)
# Inside, against the ship's side: a shelf with Rosa's diary and her photograph, a candle, a port over it.
wood((-HW + 0.10, BYM + 0.25, 1.22), (0.18, 0.95, 0.025), 'mahogany')
standing(5, (-HW + 0.10, BYM + 0.55, 1.2325), E, 0.15)
box('ledger', (-HW + 0.11, BYM + 0.20, 1.2475), (0.13, 0.19, 0.03), Matrix.Rotation(0.3, 3, 'Z'), tile=0.3)
candle((-HW + 0.10, BYM - 0.08, 1.2325))
porthole((-HW, BYM - 0.35, 1.72), E, 0.19)
halo('glow_soft', (-HW + 0.3, BYM + 0.1, 1.45), 0.9)

log("left wall")
# Pegs: his oilskin, a coil of line.
PEG_Y = 0.0
wood((-HW + 0.03, PEG_Y, 1.78), (0.03, 0.74, 0.09), 'mahogany')
for dy in (-0.26, 0.0, 0.26):
    tube('brass', (-HW + 0.04, PEG_Y + dy, 1.78), (-HW + 0.12, PEG_Y + dy, 1.80), 0.009, segs=6, caps=True)
OIL = Vector((-HW + 0.11, PEG_Y - 0.26, 0))                          # the oilskin: skirts, shoulders, sleeves, the collar on the peg
soft('linen_oilskin', OIL + UP * 1.16, (0.13, 0.46, 0.86), n=6, segs=14, rings=10, tile=0.4)
soft('linen_oilskin', OIL + UP * 1.58, (0.15, 0.50, 0.24), n=3.5, segs=14, rings=8, tile=0.4)
for sy in (-1, 1):
    soft('linen_oilskin', OIL + Vector((0.02, sy * 0.265, 1.26)), (0.10, 0.11, 0.66), n=4, segs=10, rings=8, tile=0.4,
         R=Matrix.Rotation(sy * 0.06, 3, 'X'))
soft('linen_oilskin', OIL + Vector((0.02, 0, 1.74)), (0.12, 0.20, 0.14), n=3, segs=10, rings=6, tile=0.4)
for z in (1.50, 1.32, 1.14, 0.96):
    sphere('brass', OIL + Vector((0.068, 0.0, z)), 0.014, segs=6, rings=4)
lathe('linen_oilskin', [(0.0, 0.11), (0.06, 0.10), (0.09, 0.04), (0.16, 0.01), (0.18, 0.0)], (-HW + 0.05, PEG_Y, 1.72), E, segs=14,
      tile=0.4)                                                      # and the sou'wester that goes with it
hoop('rope', (-HW + 0.11, PEG_Y + 0.26, 1.60), E, 0.17, 0.022, n=16)
hoop('rope', (-HW + 0.13, PEG_Y + 0.27, 1.59), E, 0.15, 0.022, n=16)
# The washstand: basin and jug, and the glass he keeps the moustache in order by.
WS = Vector((-HW + 0.23, -1.25, 0))
with place(WS):
    wood((0, 0, 0.40), (0.44, 0.72, 0.80), 'navy_wood')
    wood((0.01, 0, 0.815), (0.50, 0.78, 0.03), 'white_wood')
    card('locker', (0.224, 0, 0.42), E, 0.64, 0.66)
    sphere('brass', (0.24, 0.22, 0.56), 0.014, segs=6, rings=4)
    lathe('c_white', [(0.06, 0), (0.16, 0.05), (0.17, 0.085), (0.16, 0.085), (0.06, 0.012)], (0.04, -0.12, 0.83), segs=16, capb=True)
    lathe('c_white', [(0.05, 0), (0.075, 0.06), (0.06, 0.15), (0.035, 0.20), (0.05, 0.24)], (0.0, 0.24, 0.83), segs=12, capb=True)
    sprite('things2', 2, (-0.12, -0.02, 0.83), E, 0.34)
    tube('brass', (0.23, -0.30, 0.70), (0.23, -0.02, 0.70), 0.008, segs=5, caps=True)
    soft('linen_rust', (0.235, -0.16, 0.56), (0.03, 0.22, 0.32), n=5, segs=10, rings=6, tile=0.3)
# Ma, on the wall over it.
for idx, y, z, w, key in ((1, -1.25, 1.98, 0.62, 'mahogany'), (2, -0.60, 2.04, 0.42, 'oak'), (3, -1.90, 2.04, 0.42, 'oak'),
                          (4, -0.62, 1.56, 0.36, 'brass'), (9, -1.88, 1.56, 0.36, 'brass')):
    frame(idx, (LX, y, z), E, w, key)
# The fishing gear, in the corner by the bulkhead.
CORNER = Vector((-HW + 0.10, FRONT + 0.10, 0))
for k, (fx, fy, h) in enumerate(((0.42, 0.62, 2.35), (0.62, 0.36, 2.2), (0.30, 0.86, 2.05))):
    foot = CORNER + Vector((fx, fy, 0)); tip = CORNER + Vector((0.03 + 0.04 * k, 0.03 + 0.03 * k, h))
    tube('cane', foot, foot.lerp(tip, 0.25), 0.014, 0.011, segs=6, caps=True)
    tube('cane', foot.lerp(tip, 0.25), tip, 0.010, 0.003, segs=5)
    reel = foot.lerp(tip, 0.16)
    lathe('brass', [(0.0, -0.014), (0.036, -0.014), (0.036, 0.014), (0.0, 0.014)], reel + Vector((0.03, 0.02, 0)), (1, 0.6, 0), segs=10)
    for t in (0.4, 0.6, 0.8, 0.98):
        hoop('brass', foot.lerp(tip, t) + Vector((0.012, 0.008, 0)), tip - foot, 0.009, 0.002, n=8, segs=3)
NET = CORNER + Vector((0.92, 0.18, 0))                                # the landing net, leaning on the bulkhead
tube('cane', NET, NET + Vector((-0.12, -0.08, 1.15)), 0.013, segs=6, caps=True)
hoop('cane', NET + Vector((-0.14, -0.09, 1.40)), (0.3, 1, 0.1), 0.25, 0.009, n=18)
lathe('net', [(0.25, 0.0), (0.20, 0.16), (0.10, 0.30), (0.0, 0.36)], NET + Vector((-0.14, -0.09, 1.40)), (0.2, 0.6, -1), segs=14, tile=0.25)
TOWARDS = Vector((0.8, 0.6, 0)).normalized()                          # how what stands in the corner is turned: to the room
sprite('things', 4, CORNER + Vector((0.95, 0.80, 0)), TOWARDS, 0.26)   # the tackle box
wood(CORNER + Vector((0.42, 1.32, 0.19)), (0.42, 0.42, 0.38), 'crate', tile=0.42)
sprite('things2', 6, CORNER + Vector((0.44, 1.32, 0.382)), E, 0.21)    # Ma's bait, and the sardines that are a decoy measure
sprite('things', 5, (LX + 0.03, -2.42, 1.10), E, 0.36, key=one_sided('things'))     # the creel, on its peg
tube('brass', (-HW + 0.01, -2.42, 1.47), (-HW + 0.07, -2.42, 1.49), 0.008, segs=6, caps=True)
frame(8, (LX, -3.02, 1.88), E, 0.50, 'oak')                           # the far end of the pier
top = Vector((-3.55, BEAMS[0], BEAM_Z))                               # glass floats in a net, slung from the first beam
with part('Floats', top):
    tube('rope', top, top - UP * 0.26, 0.006, segs=4)
    for key, (dx, dy, dz), r in (('float_green', (0.0, 0.0, -0.40), 0.105), ('float_blue', (0.13, 0.05, -0.50), 0.085),
                                 ('float_amber', (-0.10, 0.07, -0.53), 0.075)):
        sphere(key, top + Vector((dx, dy, dz)), r, segs=12, rings=8)
        for ax in ((1, 0, 0), (0, 1, 0)):
            hoop('rope', top + Vector((dx, dy, dz)), ax, r + 0.004, 0.004, n=14, segs=3)
        tube('rope', top - UP * 0.26, top + Vector((dx, dy, dz + r)), 0.004, segs=3)
LAMPS.append(('Floats', 3.5))

# ════════════════════════════════════════════════════════════════════════
# The right side: the desk and the manifest; forward of it the stove and the armchair
# ════════════════════════════════════════════════════════════════════════
log("desk")
DY0, DY1, DD, DT = 0.62, 2.52, 0.74, 0.76                            # the desk: its two ends, its depth, its top
DYM = (DY0 + DY1) / 2
DXF = HW - DD                                                        # its front edge
DXM = HW - DD / 2
wood((DXM, DYM, DT - 0.02), (DD + 0.04, DY1 - DY0 + 0.06, 0.04), 'mahogany', tile=1.2)
for y in (DY0 + 0.25, DY1 - 0.25):                                   # a pedestal of drawers at either end
    wood((DXM + 0.02, y, 0.37), (DD - 0.08, 0.48, 0.74), 'mahogany')
    for k in range(3):
        card('drawer', (DXF + 0.056, y, 0.14 + 0.23 * k), Wst, 0.42, 0.20)
        sphere('brass', (DXF + 0.04, y, 0.14 + 0.23 * k), 0.013, segs=6, rings=4)
wood((HW - 0.04, DYM, 0.40), (0.03, DY1 - DY0 - 0.96, 0.66), 'mahogany')
# The hutch along its back: pigeonholes, papers in most of them.
HD, HZ0, HZ1 = 0.22, DT, DT + 0.50
HXM = HW - HD / 2
wood((HXM, DYM, HZ1 + 0.012), (HD + 0.02, DY1 - DY0, 0.024), 'mahogany')
wood((HXM, DYM, (HZ0 + HZ1) / 2), (HD, DY1 - DY0 - 0.02, 0.014), 'mahogany')
NH = 8
for k in range(NH + 1):
    wood((HXM, DY0 + 0.012 + k * (DY1 - DY0 - 0.024) / NH, (HZ0 + HZ1) / 2), (HD, 0.018, HZ1 - HZ0), 'mahogany')
for k in range(NH):
    for j in range(2):
        if random.random() < 0.8:
            y = DY0 + 0.012 + (k + 0.5) * (DY1 - DY0 - 0.024) / NH
            z = HZ0 + j * 0.25 + 0.012
            for m in range(random.randint(1, 3)):
                back = random.uniform(0.0, 0.05)                       # some pushed further in than others
                tube('scroll', (HW - HD + 0.012 + back, y - 0.06 + 0.05 * m, z + 0.022 + 0.018 * (m % 2)),
                     (HW - 0.02, y - 0.06 + 0.05 * m, z + 0.022 + 0.018 * (m % 2)), 0.017, segs=8, caps=True)
HT = HZ1 + 0.024
sprite('things2', 5, (HXM, DY0 + 0.26, HT), Wst, 0.21)                # the ship's box: every coin tallies
sprite('things2', 1, (HXM, DY1 - 0.24, HT), Wst, 0.27)                # the first bottle. The rest are in the hold, labelled INBOX
pile((HXM, DYM - 0.40, HT), (-1, 0), 3, 0.2)
plant(6, (HXM, DYM + 0.36, HT), 0.24, 0.5)
# On it: the manifest open at today, ink and a pen, the lamp, his name in brass, tea that he did not ask for.
wood((DXM - 0.10, DYM, DT + 0.014), (0.40, 0.64, 0.028), 'ledger', tile=0.5)
card('manifest', (DXM - 0.10, DYM, DT + 0.030), (0, 0, 1), 0.62, 0.40, up=(1, 0, 0))
INK_AT = Vector((DXM + 0.06, DYM + 0.46, DT))
lathe('brass', [(0.034, 0), (0.038, 0.012), (0.034, 0.045), (0.016, 0.055), (0.016, 0.062)], INK_AT, segs=10, capb=True)
lathe('black', [(0.016, 0.060)], INK_AT, segs=10, capt=True)
QUILL = INK_AT + Vector((-0.09, 0.06, 0.25))                           # a pen standing in it, its feather a flat blade
tube('black', INK_AT + UP * 0.05, INK_AT.lerp(QUILL, 0.35) + UP * 0.03, 0.002, segs=4)
box('white_wood', INK_AT.lerp(QUILL, 0.66), ((QUILL - INK_AT).length * 0.66, 0.036, 0.003), basis_from(QUILL - INK_AT), tile=0.3)
lantern((DXM + 0.10, DY1 - 0.20, DT), 0.9)
wood((DXF + 0.07, DYM - 0.52, DT + 0.03), (0.05, 0.26, 0.06), 'mahogany', R=Matrix.Rotation(0.5, 3, 'Y'))
card('plate', Vector((DXF + 0.07, DYM - 0.52, DT + 0.03)) + Matrix.Rotation(0.5, 3, 'Y') @ Vector((-0.027, 0, 0)),
     Matrix.Rotation(0.5, 3, 'Y') @ Wst, 0.24, 0.055, up=Matrix.Rotation(0.5, 3, 'Y') @ UP)
MUG = Vector((DXM - 0.12, DY0 + 0.24, DT))
mug(MUG, 'c_navy', full='tea')
steam('SteamDesk', MUG + UP * 0.13, 2, 0.10, tall=1.8)
chair((DXF - 0.36, DYM, 0), -math.pi / 2, 'linen_rust', 'mahogany')
# Over the desk: the coast, and three pieces of paper he keeps.
frame(('chart', 4 / 3), (RX, DYM, 1.93), Wst, 1.06, 'mahogany', border=0.05)
frame(('orders', 420 / 520), (RX, DY0 - 0.22, 1.95), Wst, 0.30, 'oak')          # what came in the first bottle
frame(('first_page', 420 / 520), (RX, DY1 + 0.22, 1.98), Wst, 0.30, 'oak')      # 'All accounted for. Except me. Working on it.'
frame(('party_slip', 560 / 200), (RX, DY1 + 0.26, 1.52), Wst, 0.42, 'brass')    # 'One quartermaster. All accounted for.'

log("stove")
STY = -1.78                                                          # the stove's place along the right wall
STX = HW - 0.42
TZ0, TZ1 = DADO + 0.07, 1.87                                         # the tiled panel behind it, in a mahogany frame
poly(one_sided('tiles'), [(HW - 0.012, STY - 0.72, TZ0), (HW - 0.012, STY + 0.72, TZ0), (HW - 0.012, STY + 0.72, TZ1),
                          (HW - 0.012, STY - 0.72, TZ1)], 0.6, (1, 2), facing=Wst)
for sy in (-1, 1):
    box(one_sided('mahogany'), (HW - 0.025, STY + sy * 0.745, (TZ0 + TZ1) / 2), (0.03, 0.05, TZ1 - TZ0 + 0.10), tile=0.9, skip=E)
box(one_sided('mahogany'), (HW - 0.025, STY, TZ1 + 0.025), (0.03, 1.54, 0.05), tile=0.9, skip=E)
wood((HW - 0.46, STY, 0.02), (0.92, 1.44, 0.04), 'slate')
soft('iron', (STX, STY, 0.50), (0.46, 0.56, 0.70), n=8, segs=16, rings=8)
wood((STX, STY, 0.865), (0.52, 0.62, 0.03), 'iron')
for sx in (-1, 1):
    for sy in (-1, 1):
        tube('iron', (STX + sx * 0.18, STY + sy * 0.22, 0.17), (STX + sx * 0.20, STY + sy * 0.24, 0.04), 0.025, 0.018, segs=6)
        tube('brass', (STX + sx * 0.25, STY + sy * 0.30, 0.88), (STX + sx * 0.25, STY + sy * 0.30, 0.95), 0.006, segs=4)
for sy in (-1, 1):                                                   # the fiddle rail that keeps the kettle aboard in a sea
    tube('brass', (STX - 0.25, STY + sy * 0.30, 0.95), (STX + 0.25, STY + sy * 0.30, 0.95), 0.007, segs=5)
for sx in (-1, 1):
    tube('brass', (STX + sx * 0.25, STY - 0.30, 0.95), (STX + sx * 0.25, STY + 0.30, 0.95), 0.007, segs=5)
tube('iron', (STX + 0.10, STY, 0.88), (STX + 0.10, STY, CEIL), 0.07, segs=12)
lathe('brass', [(0.085, 0.0), (0.085, 0.04)], (STX + 0.10, STY, 2.0), segs=12)
FX = STX - 0.236                                                     # the stove's front
card('embers', (FX, STY, 0.52), Wst, 0.32, 0.22)
for z in (0.40, 0.64):
    wood((FX - 0.004, STY, z), (0.012, 0.38, 0.025), 'iron')
for sy in (-1, 1):
    wood((FX - 0.004, STY + sy * 0.175, 0.52), (0.012, 0.025, 0.24), 'iron')
wood((FX - 0.004, STY, 0.27), (0.012, 0.30, 0.08), 'iron')
sphere('brass', (FX - 0.02, STY + 0.21, 0.52), 0.016, segs=6, rings=4)
for k, (dy, h) in enumerate(((-0.09, 0.15), (0.0, 0.19), (0.09, 0.14), (-0.045, 0.11), (0.05, 0.12))):
    p = Vector((FX - 0.006 - 0.002 * k, STY + dy, 0.415))
    with part(f'Flame{k}', p):
        card('flame', p + UP * h / 2, Wst, h * 0.5, h)
    FLAMES.append(f'Flame{k}')
halo('glow_soft', (FX - 0.05, STY, 0.52), 0.9)
SK = Vector((STX - 0.04, STY - 0.10, 0.88))
lathe('copper', [(0.07, 0), (0.09, 0.03), (0.085, 0.09), (0.05, 0.13), (0.025, 0.14), (0.0, 0.14)], SK, segs=12, capb=True)
tube('copper', SK + Vector((-0.07, 0, 0.07)), SK + Vector((-0.14, 0, 0.13)), 0.017, 0.009, segs=6)
rope('black', [SK + Vector((0, 0.06 * math.cos(a), 0.12 + 0.075 * math.sin(a))) for a in [math.pi * j / 8 for j in range(9)]], 0.007, segs=5)
steam('SteamStove', SK + Vector((-0.16, 0, 0.18)), 2, 0.14, tall=1.8)
SCUT = Vector((HW - 0.30, STY - 0.56, 0.04))                         # the coal scuttle
lathe('copper', [(0.10, 0), (0.13, 0.02), (0.17, 0.26), (0.16, 0.26), (0.12, 0.03)], SCUT, segs=12, capb=True)
lathe('black', [(0.155, 0.22), (0.05, 0.27), (0.0, 0.28)], SCUT, segs=10)
# The stove shelf: tea. He never asks, he always drinks it.
TSY = STY + 1.22
wood((HW - 0.11, TSY, 1.42), (0.20, 0.66, 0.025), 'mahogany')
for y in (TSY - 0.26, TSY + 0.26):
    beam('iron', (HW - 0.012, y, 1.27), (HW - 0.18, y, 1.405), 0.012, 0.012)
for k, key in enumerate(('c_teal', 'c_mustard', 'c_rust')):
    lathe(key, [(0.045, 0), (0.05, 0.01), (0.05, 0.13), (0.03, 0.14), (0.0, 0.14)], (HW - 0.11, TSY - 0.22 + 0.13 * k, 1.4325), segs=12, capb=True)
teapot((HW - 0.12, TSY + 0.20, 1.4325), 'c_cream', 0.85, towards=(-0.3, -1, 0))
# The armchair, turned to the fire; a crate for his feet with one of the old logs open on it; Chum Crunch to hand.
FACE = Vector((0.55, -0.835, 0)).normalized()                         # the way the chair looks
ARM = Vector((2.55, -0.72, 0))
armchair(ARM, math.atan2(-FACE.x, FACE.y), 'linen_mustard')
STOOL = ARM + FACE * 0.92
YAW = math.atan2(-FACE.x, FACE.y)
with place(STOOL, YAW):
    wood((0, 0, 0.19), (0.52, 0.44, 0.38), 'crate', tile=0.5)
    wood((0, 0, 0.392), (0.34, 0.50, 0.024), 'ledger', R=Matrix.Rotation(0.2, 3, 'Z'), tile=0.5)
    card('old_log', (0, 0, 0.406), (0, 0, 1), 0.50, 0.32, up=Matrix.Rotation(0.2, 3, 'Z') @ Vector((0, 1, 0)))
SIDE = ARM + Vector((FACE.y, -FACE.x, 0)) * -0.66 + FACE * 0.10       # the table at his left hand
lathe('mahogany', [(0.0, 0.47), (0.26, 0.47), (0.26, 0.50), (0.0, 0.50)], SIDE, segs=20, tile=0.8)
lathe('mahogany', [(0.26, 0.50)], SIDE, segs=20, capt=True)
lathe('mahogany', [(0.16, 0), (0.14, 0.03), (0.03, 0.07), (0.03, 0.47)], SIDE, segs=10, tile=0.8)
sprite('things', 3, SIDE + Vector((0.05, 0.08, 0.50)), (-0.5, -0.85, 0), 0.25)                   # the bag. He buys two now
mug(SIDE + Vector((-0.10, -0.08, 0.50)), 'c_white', full='tea')
mug(SIDE + Vector((0.12, -0.10, 0.50)), 'c_teal', full=None)
for x in (2.10, 2.36, 2.62):                                          # tankards on the beam over it
    tankard(x, BEAMS[3])

# ════════════════════════════════════════════════════════════════════════
# The bulkhead behind the camera: the door, the crew, the ballad
# ════════════════════════════════════════════════════════════════════════
log("bulkhead")
DOOR_X = 2.35
card(one_sided('door'), (DOOR_X, FRONT + 0.03, 1.0), S, 0.86, 2.0)
for sx in (-1, 1):
    box(one_sided('mahogany'), (DOOR_X + sx * 0.47, FRONT + 0.03, 1.04), (0.08, 0.06, 2.08), tile=0.9, skip=-S)
box(one_sided('mahogany'), (DOOR_X, FRONT + 0.03, 2.10), (1.02, 0.06, 0.09), tile=0.9, skip=-S)
box(one_sided('mahogany'), (DOOR_X, FRONT + 0.05, 0.06), (0.86, 0.10, 0.12), tile=0.9, skip=-S)       # the coaming a ship's door steps over
porthole((DOOR_X, FRONT + 0.03, 1.55), S, 0.14, glass='black')
sphere('brass', (DOOR_X - 0.33, FRONT + 0.07, 1.02), 0.03, segs=8, rings=5)
# The crew.
for idx, x, z, w, key in ((0, -0.70, 1.98, 0.92, 'mahogany'), (6, -1.66, 2.02, 0.62, 'oak'), (7, 0.26, 2.02, 0.62, 'oak'),
                          (10, -1.52, 1.46, 0.46, 'brass'), (11, -0.94, 1.44, 0.46, 'oak'), (12, 0.20, 1.46, 0.30, 'brass')):
    frame(idx, (x, FY, z), S, w, key)
frame(('ballad', 3 / 4), (3.50, FY, 1.72), S, 0.56, 'oak', border=0.04)             # what the stories say he was
frame(('chart_hole', 1.0), (-3.15, FY, 1.74), S, 0.74, 'mahogany', border=0.05)     # a chart with a hole in it
# A locker bench under the photographs.
BN0, BN1 = -2.05, 0.62
BNM = (BN0 + BN1) / 2
wood((BNM, FRONT + 0.22, 0.21), (BN1 - BN0, 0.44, 0.42), 'navy_wood')
lockers(BN0, BN1, FRONT + 0.444, S, z=0.22, h=0.36)
soft('linen_rust', (BNM, FRONT + 0.23, 0.47), (BN1 - BN0, 0.44, 0.10), n=8, segs=20, rings=6, tile=0.4)
for x, key, a in ((BN0 + 0.24, 'linen_navy', 0.25), (BN1 - 0.24, 'linen_mustard', -0.25)):
    soft(key, (x, FRONT + 0.14, 0.70), (0.38, 0.12, 0.38), n=3.2, segs=14, rings=8, tile=0.3,
         R=Matrix.Rotation(a, 3, 'Z') @ Matrix.Rotation(0.25, 3, 'X'))

# ════════════════════════════════════════════════════════════════════════
# The middle of the cabin, and what hangs over it
# ════════════════════════════════════════════════════════════════════════
log("room")
card('rug', (0, 0.15, 0.006), (0, 0, 1), 3.3, 2.2, up=(0, 1, 0))
ship_lamp(-1.75, BEAMS[5])
ship_lamp(1.75, BEAMS[5])
ship_lamp(0.0, BEAMS[2], glow=1.0)
BUNTING = bunting(Vector((-HW + 0.06, BEAMS[6] - 0.10, BEAM_Z - 0.02)), Vector((HW - 0.06, BEAMS[6] - 0.10, BEAM_Z - 0.02)), 6, 0.11)
TWINKLE = fairy_bulbs()

# ════════════════════════════════════════════════════════════════════════
# Finalise; the navigation mesh: the deck, less everything that stands on it
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
COLL = finalise('RexsCabin')
I = INSET
WALK = [(-HW + I, HW - I, FRONT + I, BACK - I)]
FOOT = [                                                           # (x0, x1, y0, y1) of what stands on the deck
    (-WIN_HW - 0.12, WIN_HW + 0.12, BACK - 0.64, BACK),                 # the window seat
    (SX0, SX1, BACK - SD, BACK),                                        # the log shelf
    (CH.x - 0.56, CH.x + 0.56, BACK - 0.60, BACK),                      # the sea chest
    (-HW, BXF + 0.04, BY0 - 0.04, BY1 + 0.04),                          # the berth
    (-HW, -HW + 0.50, WS.y - 0.40, WS.y + 0.40),                        # the washstand
    (-HW, -HW + 0.75, FRONT, FRONT + 1.65),                             # the fishing gear
    (-HW + 0.75, -HW + 1.25, FRONT, FRONT + 1.10),                      # … the net and the tackle box
    (DXF, HW, DY0 - 0.03, DY1 + 0.03),                                  # the desk
    (DXF - 0.60, DXF - 0.12, DYM - 0.24, DYM + 0.24),                   # its chair
    (HW - 0.92, HW, STY - 0.74, STY + 0.74),                            # hearth, stove, scuttle
    (ARM.x - 0.40, ARM.x + 0.40, ARM.y - 0.40, ARM.y + 0.40),           # the armchair
    (STOOL.x - 0.30, STOOL.x + 0.30, STOOL.y - 0.30, STOOL.y + 0.30),   # the crate at its foot
    (SIDE.x - 0.26, SIDE.x + 0.26, SIDE.y - 0.26, SIDE.y + 0.26),       # the table beside it
    (BN0, BN1, FRONT, FRONT + 0.46),                                    # the bench under the photographs
]
navmesh('Cabin-navmesh', COLL, WALK, [(a - I, b + I, c - I, d + I) for a, b, c, d in FOOT])

# ════════════════════════════════════════════════════════════════════════
# Animation: one loop
# ════════════════════════════════════════════════════════════════════════
log("animation")
LOOP = kit.LOOP
ROLL_T = 6.0                       # she rolls once in six seconds at her moorings, more some times than others
TILT = math.radians(0.55)          # how far: what the horizon shows of it


def roll(t, lag=0.0):
    return math.sin(2 * math.pi * (t - lag) / ROLL_T) * (0.72 + 0.28 * math.sin(2 * math.pi * t / LOOP))


def rolled(pivot, fn=None):
    """An animation for something out of doors, carried round the fore
    and aft line with the horizon as she rolls."""
    p = Vector(pivot) - AXIS

    def out(t):
        r = dict(fn(t)) if fn else {}
        R = Matrix.Rotation(TILT * roll(t), 3, 'Y')
        r['loc'] = tuple(R @ (p + Vector(r.get('loc', (0, 0, 0)))) - p)
        rot = r.get('rot', (0, 0, 0))
        r['rot'] = (rot[0], rot[1] + TILT * roll(t), rot[2])
        return r
    return out


animate(PARTS['View'], rolled(AXIS))
# What hangs stays where it was while she moves under it: all of it swings together, each a little late in its own way.
for k, (name, answers) in enumerate(LAMPS):
    animate(PARTS[name], lambda t, k=k, answers=answers: {'rot': (math.radians(0.3) * W(2.0, 1.3 * k)(t), answers * TILT * roll(t, 0.25 + 0.12 * (k % 3)), 0)})
animate_shapes(BUNTING, lambda t: {'Sway': 0.75 * roll(t, 0.4), 'Flutter': 0.35 * W(3.0)(t) * (0.6 + 0.4 * W(9.0, 1.0)(t))})
rising()
twinkle(TWINKLE)
for k, name in enumerate(FLICKER):
    animate(PARTS[name], lambda t, k=k: {'scale': 1.0 + 0.08 * W(0.75, k)(t) * W(4, 1.0 + k)(t) + 0.04 * W(1.5, 2.0 * k)(t)})
for k, name in enumerate(FLAMES):
    animate(PARTS[name], lambda t, k=k: {'scale': (1.0, 1.0 + 0.12 * W(1.0, 2.0 * k)(t),
                                                   0.85 + 0.22 * W(0.75, 1.7 * k)(t) * W(4.5, k)(t) + 0.14 * W(1.2, 0.9 * k)(t))})
# Outside: the lamps on the water come and go, the moored boats ride, the sloop crosses (the picture hides her
# beyond its edges, where the loop turns her round), gulls pass, the light comes round.
for k, ob in enumerate(GLINTS):
    animate_shapes(ob, lambda t, k=k: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / (2.0, 3.0, 4.5)[k] + 2.1 * k)})
    animate(ob, rolled((0, 0, 0)))
for k, (name, foot) in enumerate(BOATS[:-1]):
    T = (4.0, 6.0, 4.5)[k]
    animate(PARTS[name], rolled(foot, lambda t, k=k, T=T: {'loc': (0, 0, 0.010 * W(T, k)(t)), 'rot': (0, math.radians(1.8) * W(T, 1.2 + k)(t), 0)}))
animate(PARTS[BOATS[-1][0]], rolled(BOATS[-1][1], lambda t: {'loc': (3.6 * (2 * t / LOOP - 1), 0, 0.006 * W(4.0)(t)),
                                                             'rot': (0, math.radians(1.2) * W(6.0)(t), 0)}))


def lighthouse(t):
    """The lamp comes round every six seconds (as it does from Eve's window and Ara's)."""
    u = (t % 6.0) / 6.0
    return {'scale': 0.30 + 0.80 * math.exp(-((u - 0.5) / 0.09) ** 2)}


animate(PARTS['LighthouseGlow'], rolled(LAMP, lighthouse))


def glide(k):
    """A gull crossing the windows, wings beating; it turns back out of sight."""
    period = (18, 36, 12)[k]
    span = 4.6

    def fn(t):
        u = (t / period + 0.3 * k) % 1.0
        sgn = 1 if k % 2 == 0 else -1
        return {'loc': (sgn * span * (2 * u - 1), 0, 0.25 * math.sin(2 * math.pi * u * 2 + k)),
                'scale': (1.0, 1.0, 0.55 + 0.45 * math.sin(2 * math.pi * t / 0.75 + k) ** 2)}
    return fn


for k, (name, p) in enumerate(GULLS):
    animate(PARTS[name], rolled(p, glide(k)))


def visit(t):
    """Twice to the loop the Duchess rises under the stern to look in — a
    short look, then a long one — and goes down again quicker than she came."""
    up = 0.0
    for at, stay in ((6.0, 4.0), (22.0, 7.0)):
        x = t - at
        if 0 <= x < stay + 0.7:
            up = min(1.0, x / 1.3) if x < stay else 1 - (x - stay) / 0.7
    up = up * up * (3 - 2 * up)
    return {'loc': (0.025 * math.sin(2 * math.pi * t / 3.0) * up, 0, DUCH_DROP * (up - 1) + 0.012 * math.sin(2 * math.pi * t / 2.0) * up),
            'rot': (0, math.radians(3.5) * math.sin(2 * math.pi * t / 4.5) * up, 0)}


animate(PARTS['Duchess'], rolled(DUCH, visit))

kit.export('rexs_cabin.glb', blend='blend' in argv[2:])
log("done")
