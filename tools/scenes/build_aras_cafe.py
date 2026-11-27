"""Build Ara's Café and export it as a GLB background (step 2 of 2).

    python3 aras_cafe/paint_textures.py <tex_dir>
    blender -b --factory-startup --python build_aras_cafe.py -- <out_dir> <tex_dir> [blend]

The dockside café, on the quiet morning shift. The counter runs across the
back with the big quay window behind it: the harbour at sunrise, the Rexmaw
at her berth. The door and the bench with tables five and six are on the
left, the stove and its two armchairs on the right, the half door to the
herb boxes in the back right corner, the noticeboard and the dresser on the
wall behind the camera. There is no clock: not facing the counter, not
anywhere.

Blender coords (scene_kit.py): Z up, spawn at the origin facing -Y, the
window wall at +Y. Walls and ceiling are one-sided, so a camera that backs
out through one still sees the room. What moves: the ceiling fan, the lamps
and plants that hang, steam, the stove's fire and the candles, the fairy
lights, the sign and the bell on the door, a drip of coffee, butterflies in
the yard, and outside the boats, the gulls and the sun on the water.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_kit as kit
from scene_kit import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = argv[0] if argv else os.path.join(HERE, 'aras_cafe', 'out')
kit.init('cafe', OUT, argv[1] if len(argv) > 1 else os.path.join(OUT, 'textures'), fps=12, loop=36.0, seed=11)

# ════════════════════════════════════════════════════════════════════════
# Layout
# ════════════════════════════════════════════════════════════════════════
HW = 4.6              # half the room's width, wall to wall
BACK = 3.9            # the quay wall, with the window
FRONT = -4.3          # the wall behind the camera
CEIL = 3.25
DADO = 1.0            # top of the panelling
TILE_Y = 1.0          # the floor is tiled from here back, boards in front
INSET = 0.3           # navmesh clearance: about a body's half width (the app keeps 0.25 m for the shoulders)
WIN_HW = 2.3          # the window: half its width, its sill, its head
SILL = 1.06
WIN_TOP = 2.9
CF, CB, CX, CTOP = 1.6, 2.25, 3.0, 1.06    # the counter: its front and back faces, half its length, its top
BF, BT, BX1 = BACK - 0.6, 0.92, 3.6        # the back bar under the window: its front face, its top, its right end
YARD = (2.45, 3.3, 1.05, 2.08)             # the open top half of the yard door, in the right-hand wall
YARD_Y = (YARD[0] + YARD[1]) / 2
DOOR_Y = -2.55                             # the street door, in the left-hand wall
STOVE_Y = -0.6
BEAM_Y = -1.3
# The view: a picture 14 m wide bent in a half circle round the window (so no angle through the
# window finds its edge), its horizon at eye height.
VIEW_W = 14.0
VIEW_R = VIEW_W / math.pi
VIEW_SKY = 0.25       # the picture carries that much more sky above its own top (paint_textures.py)
HORIZON = 1.5
# The harbour picture: where its horizon and the sun are (fractions from the left, from the top),
# and the bearing the sun is given from the window: left of the companion, seen from the spawn.
PIC_HORIZON = 0.545
PIC_SUN = (0.2356, 0.4505)
PIC_LAMP = (0.110, 0.354)     # the lighthouse's lamp
VIEW_SUN = math.radians(-38)
N = Vector((0, -1, 0))        # what faces the room from the window wall
S = Vector((0, 1, 0))         # … from the wall behind the camera
E = Vector((1, 0, 0))         # … from the left wall
Wst = Vector((-1, 0, 0))      # … from the right wall
UP = Vector((0, 0, 1))

# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
log("materials")
M['floor'] = make_mat('FloorBoards', img='floor', nrm='floor_n', rough=0.6, glow=0.10)
M['floor_tiles'] = make_mat('FloorTiles', img='floor_tiles', rough=0.35, glow=0.16)
M['brick'] = make_mat('Brick', img='brick', nrm='brick_n', rough=0.9, glow=0.26, single=True)
M['wall'] = make_mat('Plaster', img='wall', rough=0.9, glow=0.30, single=True)
M['wainscot'] = make_mat('Panelling', img='wainscot', rough=0.7, glow=0.26, single=True)
M['ceiling'] = make_mat('CeilingBoards', img='ceiling', rough=0.8, glow=0.30, single=True)
for key, name, g in (('oak', 'Oak', 0.16), ('walnut', 'Walnut', 0.14), ('beam', 'Beam', 0.12), ('green_wood', 'GreenPaint', 0.26),
                     ('white_wood', 'CreamPaint', 0.30), ('marble', 'Marble', 0.20), ('slate', 'Slate', 0.16),
                     ('leather', 'Leather', 0.20), ('basket', 'Wicker', 0.2), ('spines', 'Books', 0.2),
                     ('counter', 'CounterFront', 0.26), ('cabinet', 'CabinetDoor', 0.26), ('cabinet_cream', 'DresserDoor', 0.30),
                     ('door', 'Door', 0.28), ('half_door', 'HalfDoor', 0.28), ('chalk', 'Chalkboard', 0.5),
                     ('board', 'Noticeboard', 0.42), ('register', 'TillFace', 0.34), ('machine', 'MachineFace', 0.30),
                     ('open', 'OpenSign', 0.4), ('num5', 'TableFive', 0.4), ('num6', 'TableSix', 0.4), ('rug', 'Rug', 0.22),
                     ('ship', 'ShipPainting', 0.45), ('embers', 'Embers', 1.0)):
    M[key] = make_mat(name, img=key, rough=0.8, glow=g)
for c in ('green', 'mustard', 'cream', 'terracotta', 'teal'):
    M['linen_' + c] = make_mat('Linen' + c.capitalize(), img='linen_' + c, rough=0.95, spec=0.2, glow=0.24)
M['harbour'] = make_mat('HarbourView', img='harbour', rough=1.0, spec=0.0, glow=0.9, single=True)
M['high'] = make_mat('SkyOverhead', img='high', rough=1.0, spec=0.0, glow=0.9, single=True)
M['quay'] = make_mat('QuayDark', img='quay', rough=1.0, spec=0.0, glow=0.9, single=True)
M['sky'] = make_mat('SkyPane', img='sky', rough=0.3, glow=0.85, single=True)
M['yard'] = make_mat('Yard', img='yard', rough=1.0, spec=0.0, glow=0.9, single=True)
M['pictures'] = make_mat('Pictures', img='pictures', rough=0.6, glow=0.5, alpha='MASK', single=True)
M['lettering'] = make_mat('WindowLettering', img='lettering', rough=0.4, glow=0.6, alpha='MASK')
M['plants'] = make_mat('Plants', img='plants', rough=0.9, spec=0.1, glow=0.3, alpha='MASK')
M['things'] = make_mat('Things', img='things', rough=0.8, glow=0.35, alpha='MASK')
M['tins'] = make_mat('Tins', img='tins', rough=0.6, glow=0.35, alpha='MASK')
M['pastries'] = make_mat('Pastries', img='pastries', rough=0.8, glow=0.42, alpha='MASK')
M['postcards'] = make_mat('Postcards', img='postcards', rough=0.8, glow=0.4, alpha='MASK')
M['boats'] = make_mat('Boats', img='boats', rough=1.0, spec=0.0, glow=0.8, alpha='MASK')
M['gull'] = make_mat('Gull', img='gull', rough=1.0, spec=0.0, glow=0.5, alpha='MASK')
M['butterfly'] = make_mat('Butterfly', img='butterfly', rough=1.0, spec=0.0, glow=0.8, alpha='MASK')
M['shade'] = make_mat('LampShade', img='shade', rough=0.9, glow=1.0)
for key in ('glow', 'glow_soft', 'glow_white', 'steam', 'flame', 'boats_wake', 'pane'):
    M[key] = make_mat(key.capitalize(), color=(0, 0, 0), img=key, rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['bulb'] = make_mat('Bulb', color=(1.0, 0.9, 0.7), glow=1.0, glow_color=(1.0, 0.86, 0.58))
M['lamp_in'] = make_mat('ShadeInside', color=(1.0, 0.94, 0.80), glow=0.9, glow_color=(1.0, 0.90, 0.68))
M['wire'] = make_mat('Wire', color=(0.10, 0.12, 0.10), rough=0.8)
M['brass'] = make_mat('Brass', color=(0.80, 0.60, 0.28), rough=0.3, glow=0.28)
M['copper'] = make_mat('Copper', color=(0.78, 0.45, 0.28), rough=0.3, glow=0.26)
M['iron'] = make_mat('BlackIron', color=(0.08, 0.08, 0.09), rough=0.5, glow=0.03)
M['steel'] = make_mat('Steel', color=(0.72, 0.74, 0.76), rough=0.3, glow=0.2)
M['black'] = make_mat('Black', color=(0.02, 0.02, 0.025), rough=0.4)
M['enamel'] = make_mat('GreenEnamel', color=(0.14, 0.34, 0.28), rough=0.3, glow=0.26)
M['paper'] = make_mat('Paper', color=(0.93, 0.90, 0.80), rough=0.9, glow=0.34)
M['terracotta'] = make_mat('Terracotta', color=(0.76, 0.42, 0.28), rough=0.9, glow=0.2)
M['coffee'] = make_mat('Coffee', color=(0.20, 0.11, 0.06), rough=0.3, glow=0.1)
M['tea'] = make_mat('Tea', color=(0.62, 0.32, 0.10), rough=0.2, glow=0.24)
M['wax'] = make_mat('Wax', color=(0.96, 0.92, 0.80), rough=0.6, glow=0.4)
M['flame_hot'] = make_mat('CandleFlame', color=(1.0, 0.9, 0.6), glow=1.0, glow_color=(1.0, 0.80, 0.45))
M['glass_jar'] = make_mat('JarGlass', color=(0.80, 0.90, 0.88), rough=0.1, glow=0.3)
for key, colour in (('white', (0.95, 0.94, 0.90)), ('cream', (0.93, 0.88, 0.74)), ('teal', (0.30, 0.56, 0.58)),
                    ('coral', (0.90, 0.48, 0.40)), ('mustard', (0.88, 0.68, 0.26)), ('navy', (0.20, 0.28, 0.46)),
                    ('green', (0.42, 0.62, 0.36))):
    M['c_' + key] = make_mat('Glaze' + key.capitalize(), color=colour, rough=0.35, glow=0.26)


# ════════════════════════════════════════════════════════════════════════
# The café's own shapes
# ════════════════════════════════════════════════════════════════════════
PENDANTS = []
CANDLES = []


def pendant(x, y, z, r=0.20, glow=1.2):
    """An enamel shade on its flex, the lamp's rim at height z."""
    name = f'Pendant{len(PENDANTS)}'
    top = Vector((x, y, CEIL - 0.01))
    with part(name, top):
        tube('wire', top, (x, y, z + 0.22), 0.005, segs=4)
        lathe('enamel', [(0.025, 0.25), (0.035, 0.20), (0.08, 0.14), (r, 0.0)], (x, y, z), segs=18)
        lathe('lamp_in', [(r - 0.008, 0.004), (0.075, 0.135)], (x, y, z), segs=18)
        sphere('bulb', (x, y, z + 0.05), 0.04, segs=8, rings=6)
        halo('glow', (x, y, z + 0.03), glow)
    PENDANTS.append((name, top.z - z))


def candle(c):
    """A candle in a glass."""
    c = Vector(c)
    name = f'Candle{len(CANDLES)}'
    lathe('glass_jar', [(0.03, 0), (0.035, 0.01), (0.035, 0.07)], c, segs=10, capb=True)
    lathe('wax', [(0.028, 0.004), (0.028, 0.04), (0.0, 0.04)], c, segs=8)
    with part(name, c + Vector((0, 0, 0.04))):
        lathe('flame_hot', [(0.0, 0.0), (0.008, 0.011), (0.005, 0.027), (0.0, 0.04)], c + Vector((0, 0, 0.042)), segs=6)
        halo('glow_soft', c + Vector((0, 0, 0.06)), 0.42)
    CANDLES.append(name)


def teapot(c, key='c_cream', s=1.0, towards=(1, 0, 0)):
    c = Vector(c); d = Vector(towards).normalized()
    lathe(key, [(0.05 * s, 0), (0.085 * s, 0.04 * s), (0.09 * s, 0.09 * s), (0.05 * s, 0.13 * s), (0.03 * s, 0.14 * s), (0.0, 0.15 * s)],
          c, segs=14, capb=True)
    sphere(key, c + Vector((0, 0, 0.158 * s)), 0.014 * s, segs=6, rings=4)
    tube(key, c + d * 0.075 * s + UP * 0.06 * s, c + d * 0.15 * s + UP * 0.12 * s, 0.016 * s, 0.009 * s, segs=6)
    rope(key, [c - d * (0.08 + 0.045 * math.sin(a)) * s + UP * (0.075 + 0.045 * math.cos(a)) * s for a in
               [math.pi * j / 6 for j in range(7)]], 0.007 * s, segs=4)


def cup(c, key='c_cream', full='tea'):
    """A cup on its saucer."""
    c = Vector(c)
    lathe(key, [(0.0, 0.0), (0.062, 0.0), (0.074, 0.010), (0.0, 0.010)], c, segs=14)
    lathe(key, [(0.022, 0.010), (0.042, 0.058), (0.038, 0.058), (0.020, 0.016)], c, segs=12, capb=True)
    if full:
        lathe(full, [(0.037, 0.05)], c, segs=12, capt=True)
    rope(key, [c + Vector((0.042 + 0.018 * math.sin(a), 0, 0.036 + 0.018 * math.cos(a))) for a in [math.pi * j / 4 for j in range(5)]],
         0.004, segs=4)


def cafe_table(pos, r=0.32, h=0.74, top='marble'):
    """A round table on an iron foot."""
    pos = Vector(pos)
    lathe(top, [(0.0, h - 0.03), (r, h - 0.03), (r, h), (0.0, h)], pos, segs=24, tile=0.8)
    lathe(top, [(r, h)], pos, segs=24, capt=True)
    lathe('iron', [(0.22, 0), (0.20, 0.025), (0.045, 0.06), (0.03, 0.30), (0.03, h - 0.08), (0.10, h - 0.03)], pos, segs=12)
    return pos + Vector((0, 0, h))


def stool(pos):
    """A bar stool: a leather seat on four iron legs, a brass ring to rest the feet on."""
    pos = Vector(pos)
    lathe('leather', [(0.0, 0.72), (0.15, 0.72), (0.175, 0.745), (0.17, 0.775), (0.10, 0.79), (0.0, 0.79)], pos, segs=16, tile=0.5)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        tube('iron', pos + d * 0.11 + UP * 0.72, pos + d * 0.20, 0.014, segs=6)
    rope('brass', [pos + Vector((0.165 * math.cos(a), 0.165 * math.sin(a), 0.26)) for a in [2 * math.pi * j / 16 for j in range(17)]],
         0.009, segs=5)


def armchair(pos, yaw, cushion='linen_mustard'):
    """A deep leather armchair; unturned, it faces +Y."""
    with place(pos, yaw):
        soft('leather', (0, 0.02, 0.30), (0.62, 0.66, 0.26), n=6, segs=16, rings=6, tile=0.5)
        soft('leather', (0, -0.30, 0.62), (0.70, 0.20, 0.72), n=5, segs=16, rings=8, tile=0.5, R=Matrix.Rotation(-0.16, 3, 'X'))
        for sx in (-1, 1):
            soft('leather', (sx * 0.36, 0.0, 0.40), (0.18, 0.74, 0.50), n=5, segs=14, rings=8, tile=0.5)
            for sy in (-1, 1):
                tube('walnut', (sx * 0.30, sy * 0.28, 0.16), (sx * 0.32, sy * 0.30, 0), 0.03, 0.02, segs=6)
        soft('leather', (0, 0.04, 0.46), (0.52, 0.56, 0.12), n=5, segs=14, rings=6, tile=0.5)
        soft(cushion, (0.02, -0.16, 0.68), (0.38, 0.12, 0.36), n=3.2, segs=14, rings=8, tile=0.3, R=Matrix.Rotation(-0.3, 3, 'X'))


def shelf_y(x0, x1, z, depth=0.22, key='oak'):
    """A shelf on the window wall, on iron brackets."""
    wood(((x0 + x1) / 2, BACK - depth / 2, z - 0.0125), (x1 - x0, depth, 0.025), key)
    for x in (x0 + 0.15, x1 - 0.15):
        beam('iron', (x, BACK - 0.01, z - 0.17), (x, BACK - depth + 0.03, z - 0.027), 0.012, 0.012)
    return z


# ════════════════════════════════════════════════════════════════════════
# The shell: floor, walls, ceiling
# ════════════════════════════════════════════════════════════════════════
log("shell")
floor('floor', -HW, HW, FRONT, TILE_Y, 0, tile=3.2)
floor('floor_tiles', -HW, HW, TILE_Y, BACK, 0, tile=0.8)
wood((0, TILE_Y, 0.003), (2 * HW, 0.03, 0.006), 'brass')
WIN = (-WIN_HW, WIN_HW, SILL, WIN_TOP)
pierced_y('brick', -HW, HW, 0, CEIL, BACK, [WIN], tile=1.8, facing=N)
wall_y('wall', -HW, HW, 0, CEIL, FRONT, facing=S)
wall_x('wall', FRONT, BACK, 0, CEIL, -HW, facing=E)
pierced_x('wall', FRONT, BACK, 0, CEIL, HW, [YARD], facing=Wst)
# The chimney breast behind the stove: brick, standing a hand's width out of the wall.
CH0, CH1, CHX = STOVE_Y - 0.75, STOVE_Y + 0.75, HW - 0.14
wall_x('brick', CH0, CH1, 0, CEIL, CHX, tile=1.8, facing=Wst)
wall_y('brick', CHX, HW, 0, CEIL, CH0, tile=1.8, facing=N)
wall_y('brick', CHX, HW, 0, CEIL, CH1, tile=1.8, facing=S)
# Panelling to dado height, a finger's width off the plaster, and its rail.
wall_y('wainscot', -HW, HW, 0, DADO, FRONT + 0.012, tile=1.0, facing=S)
wood((0, FRONT + 0.03, DADO + 0.02), (2 * HW, 0.045, 0.04), 'green_wood')
wall_x('wainscot', FRONT, BF, 0, DADO, -HW + 0.012, tile=1.0, facing=E)
wood((-HW + 0.03, (FRONT + BF) / 2, DADO + 0.02), (0.045, BF - FRONT, 0.04), 'green_wood')
for y0, y1 in ((FRONT, CH0), (CH1, YARD[0] - 0.04), (YARD[1] + 0.04, BACK)):
    wall_x('wainscot', y0, y1, 0, DADO, HW - 0.012, tile=1.0, facing=Wst)
    wood((HW - 0.03, (y0 + y1) / 2, DADO + 0.02), (0.045, y1 - y0, 0.04), 'green_wood')
# The ceiling: painted boards on joists, one big beam across.
poly('ceiling', [(-HW, FRONT, CEIL), (HW, FRONT, CEIL), (HW, BACK, CEIL), (-HW, BACK, CEIL)], 1.6, (0, 1), facing=(0, 0, -1))
for k in range(10):
    x = -4.14 + k * 0.92
    beam('beam', (x, FRONT, CEIL - 0.07), (x, BACK, CEIL - 0.07), 0.09, 0.14, tile=1.2)
beam('beam', (-HW, BEAM_Y, CEIL - 0.13), (HW, BEAM_Y, CEIL - 0.13), 0.20, 0.26, tile=1.2)

# ════════════════════════════════════════════════════════════════════════
# The quay window, and the harbour beyond
# ════════════════════════════════════════════════════════════════════════
log("window")
VIEW_H = VIEW_W / 2
VIEW_TOP = HORIZON + PIC_HORIZON * VIEW_H                           # the top of the picture proper; its extra sky goes above
SKY_TOP = VIEW_TOP + VIEW_SKY * VIEW_H
VIEW_BOT = VIEW_TOP - VIEW_H


def view_u(a):
    """Which part of the picture is at bearing `a` from the window. Past
    either edge it is laid again, mirrored, to carry the horizon on round."""
    u = PIC_SUN[0] + (a - VIEW_SUN) / math.pi
    return -u if u < 0 else 2 - u if u > 1 else u


def view_at(a, z, r=VIEW_R):
    return Vector((r * math.sin(a), BACK + r * math.cos(a), z))


def view_z(v):
    """The height on the view of a point that far down the picture."""
    return VIEW_TOP - v * VIEW_H


NA = 56
P = []; UV = []
for z, v in ((VIEW_BOT, 0.0), (SKY_TOP, 1.0)):
    P.append([view_at(-math.pi / 2 + math.pi * k / NA, z) for k in range(NA + 1)])
    UV.append([(view_u(-math.pi / 2 + math.pi * k / NA), v) for k in range(NA + 1)])
mb('harbour').grid(P, UV, True)
for z, up in ((SKY_TOP, -1), (VIEW_BOT, 1)):                        # the morning sky overhead, the dark of the quay underfoot
    poly('high' if up < 0 else 'quay', [(-VIEW_R, BACK, z), (VIEW_R, BACK, z), (VIEW_R, BACK + VIEW_R, z), (-VIEW_R, BACK + VIEW_R, z)],
         1.0, (0, 1), facing=(0, 0, up))
# The lighthouse on the headland, its lamp still turning at this hour.
LAMP_A = VIEW_SUN + (PIC_LAMP[0] - PIC_SUN[0]) * math.pi
LAMP = view_at(LAMP_A, view_z(PIC_LAMP[1]), VIEW_R - 0.06)
with part('LighthouseGlow', LAMP):
    card('glow_white', LAMP, (-math.sin(LAMP_A), -math.cos(LAMP_A), 0), 0.8, 0.8)
# The sun on the water: glints down the path of light under it, in three sets that come and go.
GLINTS = []
for g in range(3):
    v = []; dim = []; f = []; uv = []
    for k in range(14):
        a = VIEW_SUN + math.radians(random.uniform(-3.2, 3.2))
        c = view_at(a, view_z(random.uniform(0.565, 0.68)), VIEW_R - 0.06)
        r = Vector((math.cos(a), -math.sin(a), 0))
        w, h = random.uniform(0.07, 0.16), random.uniform(0.022, 0.04)
        b = len(v)
        for sr, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            v.append(c + r * sr * w + UP * st * h); dim.append(c + r * sr * w * 0.15 + UP * st * h * 0.15)
            uv.append(((sr + 1) / 2, (st + 1) / 2))
        f.append((b, b + 1, b + 2, b + 3))
    GLINTS.append(whole(f'Glints{g}', 'glow_white', v, f, uv, {'Dim': dim}, smooth=False))
# Boats at their moorings, each with what the water gives back of it; one under sail, crossing.
BOATS = []


def boat(idx, x, depth, h, v, mirror=False):
    """A boat that far beyond the window, its waterline where the picture's
    water is at `v` down it, as seen from the spawn at eye height."""
    s = SPR['boats'][idx]
    reach = (BACK + depth) / (BACK + VIEW_R)                          # how far out it is, of the way to the picture
    foot = Vector((x, BACK + depth, HORIZON - (HORIZON - view_z(v)) * reach))
    name = f'Boat{len(BOATS)}'
    with part(name, foot):
        w = sprite('boats', idx, foot, N, h, mirror=mirror)
        u0, u1 = (s['u1'], s['u0']) if mirror else (s['u0'], s['u1'])
        card('boats_wake', foot - UP * h * 0.3, N, w, h * 0.6, u0=u0, u1=u1, v0=s['v1'], v1=s['v0'])
    BOATS.append(name)


boat(0, -0.75, 2.5, 0.40, 0.605)                                    # the blue fishing boat
boat(6, 0.55, 2.2, 0.12, 0.64, mirror=True)                         # a yellow rowing boat
boat(4, -2.35, 3.0, 0.34, 0.59)                                     # the tug
boat(5, 0.0, 3.4, 0.52, 0.575)                                      # the sloop under sail: the last one, it crosses
GULLS = []
for k, (z, size) in enumerate(((2.75, 0.44), (2.25, 0.30), (3.25, 0.24))):
    p = Vector((0, BACK + 1.7 + 0.4 * k, z))
    with part(f'Gull{k}', p):
        card('gull', p, N, size, size / 2)
    GULLS.append(f'Gull{k}')
# The frame: jambs, head, a deep sill, two mullions and a glazing bar; the lettering on the glass.
FY = BACK + 0.03
for sx in (-1, 1):
    wood((sx * (WIN_HW + 0.03), FY, (SILL + WIN_TOP) / 2), (0.10, 0.16, WIN_TOP - SILL + 0.16), 'green_wood')
    wood((sx * 0.767, FY, (SILL + WIN_TOP) / 2), (0.05, 0.07, WIN_TOP - SILL), 'green_wood')
wood((0, FY, WIN_TOP + 0.03), (2 * WIN_HW + 0.16, 0.16, 0.10), 'green_wood')
wood((0, FY - 0.06, SILL - 0.02), (2 * WIN_HW + 0.24, 0.30, 0.05), 'green_wood')
wood((0, FY, 2.42), (2 * WIN_HW, 0.06, 0.04), 'green_wood')
card('lettering', (0, BACK + 0.075, 2.66), S, 4.32, 0.48)
# Fairy lights along its head, ivy hanging at either side.
fairy(swags((-2.36, BACK - 0.07, WIN_TOP + 0.10), (2.36, BACK - 0.07, WIN_TOP + 0.10), 7, 0.13), 0.13)
HANG = []
for k, x in enumerate((-2.02, 2.02)):
    top = Vector((x, BACK - 0.24, CEIL - 0.16))
    with part(f'Ivy{k}', top):
        tube('wire', top, top + UP * 0.16, 0.003, segs=3)
        crossed('plants', 0, top - UP * 1.0, 1.0, 0.4 + k)
    HANG.append(f'Ivy{k}')
# Herbs on the sill.
for idx, x, h in ((2, -2.02, 0.30), (7, -1.52, 0.33), (1, 2.06, 0.34)):
    plant(idx, (x, BACK - 0.07, SILL + 0.005), h, 0.3 + x)

# ════════════════════════════════════════════════════════════════════════
# The back bar under the window: the coffee machine, the kettle, the pots
# ════════════════════════════════════════════════════════════════════════
log("back bar")
BX0 = -HW
BL = BX1 - BX0
wood(((BX0 + BX1) / 2, BACK - 0.3, 0.50), (BL, 0.6, 0.80), 'green_wood')
wood(((BX0 + BX1) / 2, BACK - 0.28, 0.05), (BL, 0.56, 0.10), 'black')
wood(((BX0 + BX1) / 2, BACK - 0.32, BT - 0.02), (BL, 0.66, 0.04), 'marble', tile=1.2)
n_doors = int(BL / 0.63)
for k in range(n_doors):
    x = BX0 + (k + 0.5) * BL / n_doors
    card('cabinet', (x, BF - 0.004, 0.50), N, BL / n_doors - 0.03, 0.74)
    sphere('brass', (x + (0.2 if k % 2 else -0.2), BF - 0.02, 0.74), 0.015, segs=6, rings=4)
# The machine: two groups, a steam wand, cups warming on top.
EM = Vector((1.60, BACK - 0.30, BT))
with place(EM):
    wood((0, 0.0, 0.02), (0.76, 0.50, 0.04), 'steel')
    wood((0, -0.02, 0.045), (0.60, 0.30, 0.012), 'black')
    wood((0, 0.12, 0.17), (0.76, 0.26, 0.26), 'steel')
    wood((0, 0.0, 0.37), (0.76, 0.50, 0.16), 'steel')
    card('machine', (0, -0.252, 0.37), N, 0.74, 0.15)
    for sx in (-1, 1):
        tube('steel', (sx * 0.17, -0.10, 0.29), (sx * 0.17, -0.10, 0.22), 0.04, segs=10, caps=True)
        tube('black', (sx * 0.17, -0.13, 0.225), (sx * 0.20, -0.30, 0.20), 0.013, segs=6, caps=True)
        beam('brass', (sx * 0.375, -0.25, 0.30), (sx * 0.375, 0.25, 0.30), 0.012, 0.012)
    tube('steel', (0.33, -0.18, 0.30), (0.37, -0.27, 0.11), 0.007, segs=5)
    for k in range(7):
        lathe('c_cream', [(0.025, 0), (0.04, 0.055), (0.036, 0.055), (0.022, 0.008)], (-0.27 + 0.09 * k, 0.08 + 0.05 * (k % 2), 0.45), segs=10, capb=True)
steam('SteamWand', EM + Vector((0.37, -0.27, 0.16)), 3, 0.14, tall=1.8)
# The grinder beside it.
GR = Vector((2.36, BACK - 0.26, BT))
wood(GR + Vector((0, 0, 0.14)), (0.17, 0.22, 0.28), 'black')
lathe('glass_jar', [(0.03, 0.28), (0.085, 0.42), (0.085, 0.46)], GR, segs=12)
lathe('coffee', [(0.031, 0.285), (0.07, 0.385)], GR, segs=12, capt=True)
lathe('black', [(0.088, 0.46), (0.088, 0.475), (0.0, 0.475)], GR, segs=12)
sprite('tins', 5, (2.72, BACK - 0.22, BT), N, 0.20)
sprite('tins', 4, (2.96, BACK - 0.20, BT), N, 0.19)
sprite('things', 7, (0.74, BACK - 0.26, BT), N, 0.21)                 # cups and saucers, stacked
# The kettle on its ring, and the pots waiting.
KET = Vector((-1.30, BACK - 0.30, BT))
lathe('iron', [(0.11, 0), (0.11, 0.02), (0.0, 0.02)], KET, segs=14)
lathe('copper', [(0.085, 0.02), (0.105, 0.05), (0.10, 0.12), (0.06, 0.17), (0.03, 0.18), (0.0, 0.18)], KET, segs=14)
sphere('black', KET + Vector((0, 0, 0.195)), 0.016, segs=6, rings=4)
tube('copper', KET + Vector((0.08, 0, 0.09)), KET + Vector((0.17, 0, 0.17)), 0.02, 0.011, segs=7)
rope('black', [KET + Vector((0, 0.07 * math.cos(a), 0.16 + 0.09 * math.sin(a))) for a in [math.pi * j / 8 for j in range(9)]], 0.008, segs=5)
steam('SteamKettle', KET + Vector((0.19, 0, 0.24)), 3, 0.16, tall=1.8)
for k, key in enumerate(('c_teal', 'c_mustard', 'c_coral')):
    teapot((-0.80 + 0.30 * k, BACK - 0.34 + 0.05 * (k % 2), BT), key, 0.9, towards=(1, -0.4, 0))
for k in range(4):
    cup((0.16 + 0.15 * k, BACK - 0.40, BT), 'c_cream', None)

# ════════════════════════════════════════════════════════════════════════
# The wall either side of the window: shelves on the left, the menu on the right
# ════════════════════════════════════════════════════════════════════════
log("window wall")
SH = [shelf_y(-4.45, -2.5, z) for z in (1.42, 1.84, 2.26)]
BKS = BACK - 0.11                                                    # where things stand on those shelves
sprite('things', 0, (-2.95, BKS, SH[0]), N, 0.25)                     # the radio on the back shelf, in working order
plant(1, (-3.42, BKS, SH[0]), 0.34)                                   # … and rosemary beside it
sprite('things', 1, (-3.86, BKS, SH[0]), N, 0.20)                     # the tin of treats for Evie
sprite('things', 7, (-4.22, BKS, SH[0]), N, 0.20)
for k, idx in enumerate((0, 1, 2, 3)):
    sprite('tins', idx, (-4.22 + 0.30 * k, BKS, SH[1]), N, 0.20)
sprite('tins', 4, (-2.96, BKS, SH[1]), N, 0.19)
sprite('tins', 5, (-2.72, BKS, SH[1]), N, 0.19)
sprite('tins', 6, (-4.12, BKS, SH[2]), N, 0.19)                       # the crate the mountain leaf came in: the bitter blend, never listed
sprite('tins', 7, (-3.62, BKS, SH[2]), N, 0.24)
plant(4, (-3.08, BKS, SH[2]), 0.34)
for k, key in enumerate(('c_white', 'c_teal', 'c_mustard')):
    mug((-2.82 + 0.12 * k, BKS, SH[2]), key, full=None)
frame(('chalk', 1152 / 1024), (3.42, BACK - 0.014, 2.02), N, 1.56, 'oak', border=0.05)
fairy(swags((2.56, BACK - 0.05, 2.80), (4.28, BACK - 0.05, 2.80), 3, 0.10), 0.14)

# ════════════════════════════════════════════════════════════════════════
# The counter
# ════════════════════════════════════════════════════════════════════════
log("counter")
CM = (CF + CB) / 2
wood((0, CM, 0.56), (2 * CX, CB - CF, 0.90), 'green_wood')
wood((0, CM + 0.03, 0.055), (2 * CX - 0.04, CB - CF - 0.10, 0.11), 'black')
wood((0, CM - 0.02, CTOP - 0.025), (2 * CX + 0.12, CB - CF + 0.14, 0.05), 'oak', tile=1.4)
for k in range(6):                                                    # its front: six sunk panels between posts, a rail under the top
    card('counter', (-2.5 + k, CF - 0.004, 0.56), N, 1.0, 0.90)
for k in range(7):
    wood((-3.0 + k + (0.035 if k == 0 else -0.035 if k == 6 else 0), CF - 0.018, 0.56), (0.07, 0.036, 0.90), 'green_wood')
wood((0, CF - 0.03, 0.985), (2 * CX, 0.06, 0.05), 'oak', tile=1.4)
wood((0, CF - 0.02, 0.14), (2 * CX, 0.04, 0.06), 'green_wood')
tube('brass', (-CX + 0.1, CF - 0.13, 0.18), (CX - 0.1, CF - 0.13, 0.18), 0.018, segs=8, caps=True)
for x in (-2.8, -1.4, 0.0, 1.4, 2.8):
    beam('brass', (x, CF - 0.13, 0.18), (x, CF, 0.18), 0.02, 0.02)
STOOLS = (-2.0, -1.2, -0.4)
for x in STOOLS:
    stool((x, CF - 0.36, 0))
# On it, from the left: the cold-drip tower, the till, Marguerite's card, the tips, flowers …
TOWER = Vector((-2.66, CM, CTOP))
TOWER_H = 0.62
sprite('things', 6, TOWER, N, TOWER_H)
DRIP = TOWER + Vector((0, -0.006, TOWER_H * 0.47))
with part('Drip', DRIP):
    sphere('coffee', DRIP, 0.007, segs=6, rings=4)
TILL = Vector((-1.72, CM + 0.04, CTOP))
with place(TILL):
    wood((0, 0, 0.10), (0.38, 0.36, 0.20), 'c_cream')
    wood((0, -0.185, 0.045), (0.34, 0.012, 0.07), 'brass')
    wood((0, 0.10, 0.26), (0.38, 0.16, 0.12), 'c_cream')
    Rt = Matrix.Rotation(-0.55, 3, 'X')                                # the keys' face leans back
    wood((0, -0.085, 0.255), (0.38, 0.012, 0.27), 'c_cream', R=Rt)
    card('register', Vector((0, -0.085, 0.255)) + Rt @ Vector((0, -0.008, 0)), Rt @ Vector((0, -1, 0)), 0.36, 0.26, up=Rt @ UP)
    tube('brass', (0.19, 0.06, 0.16), (0.25, 0.06, 0.16), 0.01, segs=6)
    sphere('black', (0.26, 0.06, 0.16), 0.02, segs=6, rings=4)
sprite('postcards', 1, (-1.30, CM - 0.10, CTOP), (0.2, -1, 0.35), 0.11)
JAR = Vector((-1.08, CM - 0.12, CTOP))                                # a saucer for the tips
lathe('c_mustard', [(0.0, 0.0), (0.045, 0.0), (0.062, 0.014), (0.058, 0.016), (0.042, 0.005), (0.0, 0.005)], JAR, segs=14)
for k in range(6):
    lathe('brass', [(0.0, 0.0), (0.012, 0.0), (0.012, 0.003), (0.0, 0.003)],
          JAR + Vector((0.02 * math.cos(k * 1.9), 0.02 * math.sin(k * 1.9), 0.006 + 0.003 * k)), segs=8)
plant(6, (-0.62, CM, CTOP), 0.36, 0.2)
# … tea for two in the middle, macarons, the pastry case, the biscotti, the bell at the end.
TEA = Vector((-0.12, CM + 0.06, CTOP))
teapot(TEA, 'c_cream', 1.0, towards=(-1, -0.5, 0))
cup(TEA + Vector((0.20, -0.14, 0)))
cup(TEA + Vector((0.36, 0.02, 0)))
steam('SteamCounter', TEA + Vector((-0.15, -0.075, 0.17)), 2, 0.11, tall=1.8)
sprite('things', 4, (0.66, CM + 0.02, CTOP), N, 0.31)
CASE = (1.02, 2.42, CF + 0.10, CB - 0.06, CTOP, CTOP + 0.44)          # x0, x1, y0, y1, z0, z1
cx0, cx1, cy0, cy1, cz0, cz1 = CASE
wood(((cx0 + cx1) / 2, (cy0 + cy1) / 2, cz0 + 0.008), (cx1 - cx0, cy1 - cy0, 0.016), 'marble')
wood(((cx0 + cx1) / 2, (cy0 + cy1) / 2 + 0.05, cz0 + 0.23), (cx1 - cx0 - 0.02, cy1 - cy0 - 0.12, 0.008), 'marble')
for x in (cx0, cx1):
    for y in (cy0, cy1):
        beam('brass', (x, y, cz0), (x, y, cz1), 0.014, 0.014)
    beam('brass', (x, cy0, cz1), (x, cy1, cz1), 0.014, 0.014)
for y in (cy0, cy1):
    beam('brass', (cx0, y, cz1), (cx1, y, cz1), 0.014, 0.014)
card('pane', ((cx0 + cx1) / 2, cy0, (cz0 + cz1) / 2), N, cx1 - cx0, cz1 - cz0)
card('pane', ((cx0 + cx1) / 2, (cy0 + cy1) / 2, cz1), (0, 0, 1), cx1 - cx0, cy1 - cy0, up=(0, 1, 0))
for sx, x in ((-1, cx0), (1, cx1)):
    card('pane', (x, (cy0 + cy1) / 2, (cz0 + cz1) / 2), (sx, 0, 0), cy1 - cy0, cz1 - cz0)
LEAN = (0, -1, 0.3)
for k, idx in enumerate((0, 1, 5, 7, 0, 5)):                           # croissants, buns, muffins, danishes below
    sprite('pastries', idx, (cx0 + 0.14 + k * 0.225, cy0 + 0.10 + 0.04 * (k % 2), cz0 + 0.018), LEAN, 0.115)
for k, idx in enumerate((2, 3, 4, 6, 2)):                              # tarts, cake, scones, loaf above
    sprite('pastries', idx, (cx0 + 0.19 + k * 0.255, cy0 + 0.20, cz0 + 0.236), LEAN, 0.12)
sprite('things', 2, (2.66, CM, CTOP), N, 0.27)
sprite('things', 5, (2.90, CM + 0.14, CTOP), N, 0.24)
for k, x in enumerate((-1.9, 0.0, 1.9)):
    pendant(x, CM - 0.05, 2.22)

# ════════════════════════════════════════════════════════════════════════
# The left wall: the street door, the bench with tables five and six, the photographs
# ════════════════════════════════════════════════════════════════════════
log("left wall")
LX = -HW + 0.014                                                      # where pictures hang on it
card(one_sided('door'), (-HW + 0.03, DOOR_Y, 1.025), E, 0.9, 2.05)
card('sky', (-HW + 0.036, DOOR_Y, 1.40), E, 0.62, 0.92)
card('sky', (-HW + 0.03, DOOR_Y, 2.32), E, 0.9, 0.30)
for sy in (-1, 1):
    box(one_sided('green_wood'), (-HW + 0.03, DOOR_Y + sy * 0.49, 1.27), (0.06, 0.08, 2.54), tile=0.9, skip=-E)
for z in (2.12, 2.50):
    box(one_sided('green_wood'), (-HW + 0.03, DOOR_Y, z), (0.06, 1.06, 0.08), tile=0.9, skip=-E)
for dy, dz, size in ((0, 0, (0.03, 0.03, 0.92)), (0, 0, (0.03, 0.62, 0.03))):
    box(one_sided('green_wood'), (-HW + 0.045, DOOR_Y + dy, 1.40 + dz), size, tile=0.9, skip=-E)
sphere('brass', (-HW + 0.075, DOOR_Y + 0.36, 1.0), 0.03, segs=8, rings=5)
soft('linen_terracotta', (-HW + 0.48, DOOR_Y, 0.008), (0.6, 0.85, 0.016), n=8, segs=12, rings=4, tile=0.3)
# The sign on the door glass, read from the street; the bell over the door.
SIGN = Vector((-HW + 0.07, DOOR_Y, 1.84))
with part('OpenSign', SIGN):
    for sy in (-1, 1):
        tube('wire', SIGN, SIGN + Vector((0, sy * 0.11, -0.12)), 0.002, segs=3)
    wood(SIGN + Vector((0, 0, -0.21)), (0.008, 0.30, 0.19), 'white_wood')
    card(one_sided('open'), SIGN + Vector((-0.0045, 0, -0.21)), -E, 0.30, 0.19)
BELL = Vector((-HW + 0.03, DOOR_Y - 0.30, 2.24))
rope('brass', [BELL + Vector((0.13 * math.sin(a), 0, 0.10 * (1 - math.cos(a)) - 0.0)) for a in [math.pi / 2 * j / 6 for j in range(7)]], 0.005, segs=4)
BELL_TOP = BELL + Vector((0.13, 0, 0.10))
with part('DoorBell', BELL_TOP):
    lathe('brass', [(0.008, 0.0), (0.02, -0.01), (0.03, -0.05), (0.045, -0.075), (0.04, -0.075)], BELL_TOP, segs=10)
    sphere('brass', BELL_TOP + Vector((0, 0, -0.07)), 0.011, segs=6, rings=4)
# The bench: a boxed seat along the wall, cushioned, tables five and six in front of it.
B0, B1 = -1.70, 1.00
BM = (B0 + B1) / 2
wood((-HW + 0.25, BM, 0.21), (0.50, B1 - B0, 0.42), 'green_wood')
soft('linen_green', (-HW + 0.26, BM, 0.47), (0.50, B1 - B0, 0.11), n=8, segs=20, rings=6, tile=0.4)
soft('linen_green', (-HW + 0.075, BM, 0.80), (0.11, B1 - B0, 0.46), n=7, segs=20, rings=8, tile=0.4)
for y, key, a in ((1.12, 'linen_mustard', -0.3), (0.0, 'linen_terracotta', 0.15), (-1.10, 'linen_cream', 0.35)):
    soft(key, (-HW + 0.20, BM + y, 0.72), (0.13, 0.38, 0.38), n=3.2, segs=14, rings=8, tile=0.3,
         R=Matrix.Rotation(a, 3, 'Z') @ Matrix.Rotation(0.3, 3, 'Y'))
TABLES = {5: Vector((-3.72, BM + 0.68, 0)), 6: Vector((-3.72, BM - 0.68, 0))}
CHAIR_X = -3.18
for n_table, pos in TABLES.items():
    top = cafe_table(pos)
    chair((CHAIR_X, pos.y, 0), math.pi / 2, 'linen_mustard' if n_table == 5 else 'linen_terracotta')
    beam('brass', top + Vector((0.20, 0.16, 0)), top + Vector((0.20, 0.16, 0.05)), 0.006, 0.006)
    for nrm in (E, -E):
        card(f'num{n_table}', top + Vector((0.20, 0.16, 0.085)) + nrm * 0.002, nrm, 0.07, 0.07)
    candle(top + Vector((-0.14, -0.16, 0)))
    pendant(pos.x, pos.y, 1.95, r=0.17, glow=1.0)
# Table six: a pot and two cups, kept warm.
SIX = TABLES[6] + Vector((0, 0, 0.74))
teapot(SIX + Vector((0.0, 0.10, 0)), 'c_teal', 0.9, towards=(0.3, -1, 0))
cup(SIX + Vector((-0.13, 0.02, 0)), 'c_white')
cup(SIX + Vector((0.12, -0.12, 0)), 'c_white')
steam('SteamSix', SIX + Vector((-0.13, 0.02, 0.12)), 2, 0.10, tall=1.8)
FIVE = TABLES[5] + Vector((0, 0, 0.74))
mug(FIVE + Vector((0.06, -0.08, 0)), 'c_mustard')
pile(FIVE + Vector((-0.06, 0.12, 0)), (1, 0), 2, 0.3)
# The photographs over the bench.
for idx, y, z, w, key in ((0, 0.0, 1.95, 0.72, 'walnut'), (7, 0.0, 1.45, 0.28, 'brass'), (1, 0.78, 2.00, 0.50, 'oak'),
                          (5, 0.62, 1.52, 0.40, 'white_wood'), (3, 1.28, 1.62, 0.30, 'brass'), (2, -0.75, 2.02, 0.48, 'white_wood'),
                          (6, -0.60, 1.54, 0.40, 'walnut'), (4, -1.30, 1.66, 0.30, 'oak')):
    frame(idx, (LX, BM + y, z), E, w, key)

# ════════════════════════════════════════════════════════════════════════
# The right wall: the yard door, the ship, the stove and its armchairs, the books
# ════════════════════════════════════════════════════════════════════════
log("right wall")
RX = HW - 0.014
# The half door: its lower leaf shut, the upper one open on the herb boxes.
card(one_sided('half_door'), (HW - 0.02, YARD_Y, YARD[2] / 2), Wst, YARD[1] - YARD[0], YARD[2])
wood((HW - 0.04, YARD_Y, YARD[2] + 0.015), (0.14, YARD[1] - YARD[0], 0.03))
for y in (YARD[0] - 0.035, YARD[1] + 0.035):
    box(one_sided('green_wood'), (HW - 0.03, y, (YARD[3] + 0.08) / 2), (0.06, 0.07, YARD[3] + 0.08), tile=0.9, skip=-Wst)
box(one_sided('green_wood'), (HW - 0.03, YARD_Y, YARD[3] + 0.04), (0.06, YARD[1] - YARD[0] + 0.14, 0.08), tile=0.9, skip=-Wst)
plant(7, (HW - 0.04, YARD_Y + 0.26, YARD[2] + 0.03), 0.24, 0.8)
YD = 0.9                                                              # how far beyond the wall the yard's picture stands
YW, YH = 2.25, 3.0
card('yard', (HW + YD, YARD_Y, YH / 2 - 0.2), Wst, YW, YH)
for sy in (-1, 1):
    wall_y('wall', HW, HW + YD, -0.2, YH - 0.2, YARD_Y + sy * YW / 2, facing=(0, -sy, 0))
poly('wall', [(HW, YARD_Y - YW / 2, YH - 0.2), (HW + YD, YARD_Y - YW / 2, YH - 0.2), (HW + YD, YARD_Y + YW / 2, YH - 0.2),
              (HW, YARD_Y + YW / 2, YH - 0.2)], 2.0, (0, 1), facing=(0, 0, -1))
FLY = []
for k in range(2):
    p = Vector((HW + 0.45 + 0.15 * k, YARD_Y - 0.1 + 0.2 * k, 1.55 + 0.2 * k))
    with part(f'Butterfly{k}', p):
        card('butterfly', p, Wst, 0.09, 0.09)
    FLY.append(f'Butterfly{k}')
# The Rexmaw under sail, in oils.
frame(('ship', 1.5), (RX, 1.22, 1.95), Wst, 1.10, 'walnut', border=0.06, depth=0.04)
# The stove on its hearth: a fire behind the glass, a kettle on top, logs to hand.
STX = CHX - 0.34
wood((CHX - 0.42, STOVE_Y, 0.02), (0.84, 1.6, 0.04), 'slate')
soft('iron', (STX, STOVE_Y, 0.50), (0.46, 0.56, 0.70), n=8, segs=16, rings=8)
wood((STX, STOVE_Y, 0.865), (0.52, 0.62, 0.03), 'iron')
for sx in (-1, 1):
    for sy in (-1, 1):
        tube('iron', (STX + sx * 0.18, STOVE_Y + sy * 0.22, 0.17), (STX + sx * 0.20, STOVE_Y + sy * 0.24, 0.04), 0.025, 0.018, segs=6)
tube('iron', (STX + 0.08, STOVE_Y, 0.88), (STX + 0.08, STOVE_Y, CEIL), 0.07, segs=12)
lathe('iron', [(0.085, 0.0), (0.085, 0.04)], (STX + 0.08, STOVE_Y, 2.0), segs=12)
FX = STX - 0.236                                                      # the stove's front
card('embers', (FX, STOVE_Y, 0.52), Wst, 0.32, 0.22)
for z in (0.40, 0.64):
    wood((FX - 0.004, STOVE_Y, z), (0.012, 0.38, 0.025), 'iron')
for sy in (-1, 1):
    wood((FX - 0.004, STOVE_Y + sy * 0.175, 0.52), (0.012, 0.025, 0.24), 'iron')
wood((FX - 0.004, STOVE_Y, 0.27), (0.012, 0.30, 0.08), 'iron')
sphere('brass', (FX - 0.02, STOVE_Y + 0.21, 0.52), 0.016, segs=6, rings=4)
FLAMES = []
for k, (dy, h) in enumerate(((-0.09, 0.15), (0.0, 0.19), (0.09, 0.14), (-0.045, 0.11), (0.05, 0.12))):
    p = Vector((FX - 0.006 - 0.002 * k, STOVE_Y + dy, 0.415))
    with part(f'Flame{k}', p):
        card('flame', p + UP * h / 2, Wst, h * 0.5, h)
    FLAMES.append(f'Flame{k}')
halo('glow_soft', (FX - 0.05, STOVE_Y, 0.52), 0.9)
SK = Vector((STX - 0.02, STOVE_Y - 0.12, 0.88))
lathe('copper', [(0.07, 0), (0.09, 0.03), (0.085, 0.09), (0.05, 0.13), (0.025, 0.14), (0.0, 0.14)], SK, segs=12, capb=True)
tube('copper', SK + Vector((-0.07, 0, 0.07)), SK + Vector((-0.14, 0, 0.13)), 0.017, 0.009, segs=6)
rope('black', [SK + Vector((0, 0.06 * math.cos(a), 0.12 + 0.075 * math.sin(a))) for a in [math.pi * j / 8 for j in range(9)]], 0.007, segs=5)
steam('SteamStove', SK + Vector((-0.16, 0, 0.18)), 2, 0.14, tall=1.8)
LOGS = Vector((CHX - 0.30, STOVE_Y - 0.58, 0.04))
lathe('basket', [(0.17, 0), (0.21, 0.16), (0.20, 0.30), (0.185, 0.30), (0.16, 0.02)], LOGS, segs=14, tile=0.3, capb=True)
for k in range(5):
    a = 0.4 + k * 0.5
    c = LOGS + Vector((0.05 * math.cos(k * 2.3), 0.05 * math.sin(k * 2.3), 0.16 + 0.06 * (k % 3)))
    d = Vector((math.cos(a), math.sin(a), 0.25)) * 0.19
    tube('beam', c - d, c + d, 0.045, segs=7, tile=0.4)
    for sgn in (-1, 1):                                                # the sawn ends
        lathe('oak', [(0.045, 0.0)], c + d * sgn, d * sgn, segs=7, capt=True)
# The armchairs, a rug, a small table between them.
NOOK = Vector((3.05, STOVE_Y, 0))
card('rug', NOOK + Vector((0, 0, 0.006)), (0, 0, 1), 2.4, 1.6, up=(1, 0, 0))
armchair((2.92, STOVE_Y + 0.95, 0), math.radians(-116.6), 'linen_mustard')
armchair((2.92, STOVE_Y - 0.95, 0), math.radians(-63.4), 'linen_teal')
ST = Vector((3.30, STOVE_Y, 0))
lathe('walnut', [(0.0, 0.47), (0.25, 0.47), (0.25, 0.50), (0.0, 0.50)], ST, segs=20, tile=0.8)
lathe('walnut', [(0.25, 0.50)], ST, segs=20, capt=True)
lathe('walnut', [(0.16, 0), (0.14, 0.03), (0.03, 0.07), (0.03, 0.47)], ST, segs=10, tile=0.8)
mug(ST + Vector((-0.10, 0.08, 0.50)), 'c_teal', full='tea')
steam('SteamNook', ST + Vector((-0.10, 0.08, 0.63)), 2, 0.10, tall=1.8)
pile(ST + Vector((0.07, -0.08, 0.50)), (-1, 0), 3, 0.5)
candle(ST + Vector((0.10, 0.13, 0.50)))
# Books to borrow, by the wall.
BC = Vector((HW - 0.16, -2.75, 0))
BC_H = 1.9
with place(BC):
    for sy in (-1, 1):
        wood((0, sy * 0.54, BC_H / 2), (0.30, 0.025, BC_H))
    wood((0.14, 0, BC_H / 2), (0.012, 1.08, BC_H), 'walnut')
    for k in range(6):
        z = 0.06 + k * 0.364
        wood((0, 0, z), (0.30, 1.06, 0.025))
        if k == 5:
            break
        if k == 2:
            books((-0.12, -0.52, z + 0.0125), (0, 1, 0), (-1, 0, 0), 0.56, 0.30)
            sprite('things', 3, (0.0, 0.30, z + 0.0125), Wst, 0.19)
        else:
            books((-0.12, -0.52, z + 0.0125), (0, 1, 0), (-1, 0, 0), 1.04, 0.30, fill=random.uniform(0.82, 1.0))
    plant(4, (0.0, -0.22, BC_H + 0.085), 0.36)
    pile((0.0, 0.26, BC_H + 0.085), (-1, 0), 3, 0.2)

# ════════════════════════════════════════════════════════════════════════
# The wall behind the camera: the noticeboard over a bench, the dresser, a table for two
# ════════════════════════════════════════════════════════════════════════
log("front wall")
NB = -1.6                                                             # the noticeboard's middle, and the bench's under it
frame(('board', 1408 / 960), (NB, FRONT + 0.014, 1.78), S, 1.62, 'oak', border=0.05)
tube('brass', (NB - 0.5, FRONT + 0.13, 2.44), (NB + 0.5, FRONT + 0.13, 2.44), 0.016, segs=8, caps=True)       # a picture light over it
for sx in (-1, 1):
    tube('brass', (NB + sx * 0.3, FRONT + 0.13, 2.44), (NB + sx * 0.3, FRONT + 0.02, 2.40), 0.006, segs=5)
wood((NB, FRONT + 0.13, 2.428), (0.94, 0.012, 0.006), 'bulb')
wood((NB, FRONT + 0.22, 0.21), (2.2, 0.44, 0.42), 'green_wood')
soft('linen_mustard', (NB, FRONT + 0.23, 0.47), (2.2, 0.44, 0.10), n=8, segs=20, rings=6, tile=0.4)
soft('linen_green', (NB, FRONT + 0.07, 0.78), (2.2, 0.10, 0.40), n=7, segs=20, rings=8, tile=0.4)
for sx in (-1, 1):
    top = cafe_table((NB + sx * 0.55, -3.44, 0), r=0.30)
    candle(top + Vector((0.08, 0.10, 0)))
mug((NB - 0.60, -3.52, 0.74), 'c_coral')
cup((NB + 0.50, -3.50, 0.74), 'c_cream')
for idx, x, w, key in ((11, 0.35, 0.50, 'white_wood'), (8, 1.25, 0.44, 'oak'), (9, 1.95, 0.44, 'oak'), (10, 3.35, 0.60, 'walnut')):
    frame(idx, (x, FRONT + 0.014, 1.80), S, w, key)
plant(7, (-4.1, -3.8, 0), 0.62, 0.4)
# The dresser, on the left wall by the way in behind the counter (nothing tall stands against this
# wall: a camera that backs out through it would be looking at its back): cupboards below, the
# good plates above. Built facing +Y, then turned to face the room.
DR = Vector((-HW + 0.225, 2.5, 0))
with place(DR, -math.pi / 2):
    wood((0, 0, 0.45), (1.6, 0.45, 0.90), 'white_wood')
    wood((0, 0.01, 0.915), (1.66, 0.49, 0.03))
    for k in range(3):
        card('cabinet_cream', (-0.53 + 0.53 * k, 0.228, 0.47), S, 0.50, 0.78)
        sphere('brass', (-0.53 + 0.53 * k + 0.18, 0.245, 0.70), 0.015, segs=6, rings=4)
    for sx in (-1, 1):
        wood((sx * 0.785, -0.085, 1.53), (0.03, 0.26, 1.20), 'white_wood')
    wood((0, -0.205, 1.53), (1.6, 0.012, 1.20), 'green_wood')
    wood((0, -0.085, 2.145), (1.66, 0.30, 0.03), 'white_wood')
    for z in (1.32, 1.72):
        wood((0, -0.085, z), (1.54, 0.25, 0.022), 'white_wood')
    for k in range(6):                                                 # plates stood on edge along the top shelf
        lathe(('c_white', 'c_teal', 'c_cream')[k % 3], [(0.0, 0.0), (0.105, 0.0), (0.125, 0.014), (0.0, 0.014)],
              (-0.62 + 0.25 * k, -0.17, 1.86), (0, 1, 0.12), segs=16)
    for k, key in enumerate(('c_coral', 'c_teal', 'c_mustard', 'c_white', 'c_navy')):
        mug((-0.64 + 0.14 * k, -0.06, 1.331), key, full=None)
    sprite('things', 3, (0.30, -0.06, 1.331), S, 0.19)
    sprite('tins', 1, (0.58, -0.06, 1.331), S, 0.17)
    books((-0.70, 0.02, 0.93), (1, 0, 0), (0, 1, 0), 0.40, 0.24)
    sprite('things', 4, (0.0, -0.05, 0.93), S, 0.28)
    plant(2, (0.52, -0.04, 0.93), 0.30)
plant(5, (4.05, -3.78, 0), 1.55, 0.5)                                 # an olive tree in one corner, a fig by the yard door
plant(3, (4.18, BACK - 0.36, 0), 1.20, 0.6)
# A table for two.
T2 = cafe_table((1.9, -2.48, 0), r=0.34)
chair((1.9, -3.08, 0), 0.0, 'linen_teal')
chair((1.9, -1.88, 0), math.pi, 'linen_terracotta')
plant(6, T2 + Vector((0.0, 0.02, 0)), 0.26, 0.9)
cup(T2 + Vector((-0.13, -0.16, 0)), 'c_cream')
cup(T2 + Vector((0.14, 0.17, 0)), 'c_cream', 'coffee')
pendant(1.9, -2.48, 1.95, r=0.19, glow=1.0)

# ════════════════════════════════════════════════════════════════════════
# Under the ceiling: the fan, lights along the beam
# ════════════════════════════════════════════════════════════════════════
log("ceiling")
FAN = Vector((0, 0.45, 2.76))
tube('brass', (FAN.x, FAN.y, CEIL), FAN + UP * 0.06, 0.014, segs=8)
lathe('brass', [(0.02, 0.0), (0.07, -0.02), (0.07, -0.05)], (FAN.x, FAN.y, CEIL), segs=12)
with part('Fan', FAN):
    lathe('brass', [(0.0, 0.07), (0.07, 0.06), (0.10, 0.02), (0.10, -0.03), (0.06, -0.06), (0.0, -0.065)], FAN, segs=14)
    for k in range(4):
        a = k * math.pi / 2
        d = Vector((math.cos(a), math.sin(a), 0))
        Rb = Matrix.Rotation(a, 3, 'Z') @ Matrix.Rotation(0.21, 3, 'X')
        wood(FAN + d * 0.14, (0.12, 0.035, 0.008), 'brass', R=Matrix.Rotation(a, 3, 'Z'))
        wood(FAN + d * 0.52, (0.66, 0.15, 0.012), 'walnut', R=Rb)
lathe('shade', [(0.05, -0.065), (0.10, -0.10), (0.09, -0.16), (0.0, -0.19)], FAN, segs=14, tile=0.5)
fairy(swags((-HW + 0.1, BEAM_Y - 0.12, CEIL - 0.24), (HW - 0.1, BEAM_Y - 0.12, CEIL - 0.24), 10, 0.15), 0.15)
TWINKLE = fairy_bulbs()

# ════════════════════════════════════════════════════════════════════════
# Finalise; the navigation mesh: the floor, less everything that stands on it
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
COLL = finalise('ArasCafe')
I = INSET
WALK = [(-HW + I, HW - I, FRONT + I, BACK - I)]
FOOT = [                                                           # (x0, x1, y0, y1) of what stands on the floor
    (BX0, BX1, BF, BACK),                                               # back bar
    (-CX, CX, CF - 0.05, CB + 0.03),                                    # counter
    (STOOLS[0] - 0.2, STOOLS[-1] + 0.2, CF - 0.55, CF),                 # its stools
    (-HW, -HW + 0.52, B0, B1),                                          # the bench
    *[(p.x - 0.32, p.x + 0.32, p.y - 0.32, p.y + 0.32) for p in TABLES.values()],       # tables five and six
    *[(CHAIR_X - 0.24, CHAIR_X + 0.22, p.y - 0.22, p.y + 0.22) for p in TABLES.values()],  # their chairs
    (NB - 1.12, NB + 1.12, FRONT, -3.12),                               # bench and tables under the noticeboard
    (-HW, -HW + 0.48, DR.y - 0.83, DR.y + 0.83),                        # dresser
    (-4.35, -3.85, -4.05, -3.55),                                       # lavender
    (1.56, 2.24, -3.32, -1.64),                                         # table for two
    (3.75, 4.35, -4.08, -3.48),                                         # olive tree
    (3.90, HW, BACK - 0.64, BACK),                                      # the fig
    (HW - 0.32, HW, -3.30, -2.20),                                      # bookcase
    (CHX - 0.84, HW, STOVE_Y - 0.80, STOVE_Y + 0.80),                   # hearth, stove, logs
    (2.50, 3.36, STOVE_Y + 0.55, STOVE_Y + 1.35),                       # armchairs
    (2.50, 3.36, STOVE_Y - 1.35, STOVE_Y - 0.55),
    (ST.x - 0.25, ST.x + 0.25, ST.y - 0.25, ST.y + 0.25),               # the table between them
]
navmesh('Cafe-navmesh', COLL, WALK, [(a - I, b + I, c - I, d + I) for a, b, c, d in FOOT])

# ════════════════════════════════════════════════════════════════════════
# Animation: one loop
# ════════════════════════════════════════════════════════════════════════
log("animation")
LOOP = kit.LOOP
G = 9.81
# The fan, on its slowest setting: a turn every three seconds.
animate(PARTS['Fan'], lambda t: {'rot': (0, 0, 2 * math.pi * t / 3.0)})
# What hangs swings on its own length: 2π√(L/g), to the nearest count that divides the loop.
COUNTS = (0.75, 1.0, 1.2, 1.5, 1.8, 2.0, 2.25, 2.4, 3.0)
swing = lambda L: min(COUNTS, key=lambda c: abs(c - 2 * math.pi * math.sqrt(L / G)))
for k, (name, L) in enumerate(PENDANTS):
    T = swing(L)
    animate(PARTS[name], lambda t, k=k, T=T: {'rot': (math.radians(0.7) * W(T, 1.3 * k)(t), math.radians(0.5) * W(T, 1.0 + 0.7 * k)(t), 0)})
for k, name in enumerate(HANG):
    animate(PARTS[name], lambda t, k=k: {'rot': (math.radians(1.4) * W(swing(0.8), 2.0 * k)(t), 0, math.radians(3) * W(9, k)(t))})
animate(PARTS['OpenSign'], lambda t: {'rot': (math.radians(2.2) * W(swing(0.12))(t) * (0.55 + 0.45 * W(12)(t)), 0, 0)})
animate(PARTS['DoorBell'], lambda t: {'rot': (math.radians(3) * W(0.75)(t) * max(0.0, W(18)(t)) ** 2, 0, 0)})
rising()
twinkle(TWINKLE)
for k, ob in enumerate(GLINTS):
    animate_shapes(ob, lambda t, k=k: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / (2.0, 3.0, 4.5)[k] + 2.1 * k)})
for k, name in enumerate(CANDLES):
    animate(PARTS[name], lambda t, k=k: {'scale': 1.0 + 0.10 * W(0.75, k)(t) * W(4, 1.0 + k)(t) + 0.05 * W(1.5, 2.0 * k)(t)})
for k, name in enumerate(FLAMES):
    animate(PARTS[name], lambda t, k=k: {'scale': (1.0, 1.0 + 0.12 * W(1.0, 2.0 * k)(t),
                                                   0.85 + 0.22 * W(0.75, 1.7 * k)(t) * W(4.5, k)(t) + 0.14 * W(1.2, 0.9 * k)(t))})


def drip(t):
    """A drop forms, falls into the flask, and the next one forms."""
    u = (t % 1.5) / 1.5
    return {'loc': (0, 0, -0.15 * max(0.0, u - 0.5) ** 2 * 4), 'scale': min(1.0, u * 4) if u < 0.96 else 0.001}


animate(PARTS['Drip'], drip)


def flutter(k):
    """A butterfly over the herb boxes: a slow wander, wings beating."""
    def fn(t):
        a = 2 * math.pi * t / (12, 18)[k] + 2.0 * k
        beat = abs(math.sin(math.pi * t * 3))                        # three beats a second, as fast as the loop's twelve frames show
        return {'loc': (0.10 * math.sin(2 * a), 0.30 * math.sin(a), 0.16 * math.sin(3 * a + k)), 'scale': (1.0, 0.25 + 0.75 * beat, 1.0)}
    return fn


for k, name in enumerate(FLY):
    animate(PARTS[name], flutter(k))
# Outside: the moored boats ride the swell, the sloop crosses (the picture hides her beyond its
# edges, where the loop turns her round), gulls pass.
for k, name in enumerate(BOATS[:-1]):
    T = (4.0, 6.0, 4.5)[k]
    animate(PARTS[name], lambda t, k=k, T=T: {'loc': (0, 0, 0.010 * W(T, k)(t)), 'rot': (0, math.radians(1.8) * W(T, 1.2 + k)(t), 0)})
animate(PARTS[BOATS[-1]], lambda t: {'loc': (3.3 * (2 * t / LOOP - 1), 0, 0.006 * W(4.0)(t)), 'rot': (0, math.radians(1.2) * W(6.0)(t), 0)})


def lighthouse(t):
    """The lamp comes round every six seconds (as it does from Eve's window), paler in the daylight."""
    u = (t % 6.0) / 6.0
    return {'scale': 0.25 + 0.85 * math.exp(-((u - 0.5) / 0.09) ** 2)}


animate(PARTS['LighthouseGlow'], lighthouse)


def glide(k):
    """A gull crossing the window, wings beating; it turns back out of sight."""
    period = (18, 36, 12)[k]
    span = 4.4

    def fn(t):
        u = (t / period + 0.3 * k) % 1.0
        sgn = 1 if k % 2 == 0 else -1
        x = sgn * span * (2 * u - 1)
        return {'loc': (x, 0, 0.25 * math.sin(2 * math.pi * u * 2 + k)), 'scale': (1.0, 1.0, 0.55 + 0.45 * math.sin(2 * math.pi * t / 0.75 + k) ** 2)}
    return fn


for k, name in enumerate(GULLS):
    animate(PARTS[name], glide(k))

kit.export('aras_cafe.glb', blend='blend' in argv[2:])
log("done")
