"""Build Sal's Hut and export it as a GLB background (step 2 of 2).

    python3 sals_hut/paint_textures.py <tex_dir>
    blender -b --factory-startup --python build_sals_hut.py -- <out_dir> <tex_dir> [blend]

The stilt-hut at the marsh edge, at dusk. The den (two weeks from finished
for four years) opens through a wide doorway onto the porch; from the porch
a jetty runs out over the water to a landing where the skiff is tied. The
workbench and the tide clock are on the left wall, the wall of small
drawers and the three generations of loudspeaker on the right, the pinboard
and the stretch of wall still in studs behind the camera.

Blender coords (scene_kit.py): Z up, spawn at the origin facing -Y, the
porch and the open marsh at +Y. The den's side walls, front wall and roof
are one-sided, so a camera that backs out through one still sees the room;
the wall onto the porch is a real wall from both sides, to be looked in
through from the jetty. The marsh is all round: the water as a disc under
everything, the far shore as a picture bent round it (the half behind the
hut is the same picture mirrored, without the afterglow).

What moves: indoors the tide clock and its pendulum, the record and the
tape reels, the oscilloscope's trace, a gimbal, the bulbs on their flexes;
on the porch the hammock, the lanterns and their moths, the wind chime, the
cups on the mast; out on the water the reeds, the mist, fireflies, frogs,
a heron, ducks, an alligator, an egret, dragonflies, a fish that jumps,
the float, the skiff, the moon's road, the stars and the lighthouse — and
something shy behind the far cypress, which now and then leans out to look.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_kit as kit
from scene_kit import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = argv[0] if argv else os.path.join(HERE, 'sals_hut', 'out')
kit.init('hut', OUT, argv[1] if len(argv) > 1 else os.path.join(OUT, 'textures'), fps=12, loop=36.0, seed=23)

# ════════════════════════════════════════════════════════════════════════
# Layout
# ════════════════════════════════════════════════════════════════════════
HW = 3.7              # half the den's width, wall to wall
FRONT = -3.6          # the wall behind the camera
BACK = 2.2            # the wall onto the porch
SKIN = 0.10           # … and its thickness
EAVE = 2.55           # the walls' height; the roof rises from there to the ridge
RIDGE = 3.7
RIDGE_Y = (FRONT + BACK) / 2
DOOR_HW, DOOR_TOP = 1.7, 2.3                   # the doorway onto the porch
WINS = ((-3.2, -2.3, 1.0, 2.05), (2.3, 3.2, 1.0, 2.05))   # a window either side of it
DX = 4.7              # half the deck's width
DECK = 5.6            # its far edge
AWN, AWN_Z = BACK + 1.5, 2.28                  # the porch roof's outer edge
RAIL = 0.92
JX0, JX1, JEND = 1.5, 2.9, 10.2                # the jetty
PLAT = (0.5, 3.9, JEND, 12.6)                  # the landing at its end
INSET = 0.3           # navmesh clearance: about a body's half width (the app keeps 0.25 m for the shoulders)
# The marsh (paint_textures.py set these up and painted the water to match).
MARSH = SPR['marsh']
R = MARSH['radius']                            # how far off the picture of the far shore stands
HORIZON = MARSH['eye']                         # its horizon is at eye height
WATER = MARSH['water']
CY = 3.0                                       # the middle of it all: the porch
VIEW_H = R * math.pi / 2                       # the picture, 2:1, takes half the circle
VIEW_TOP = HORIZON + MARSH['horizon'] * VIEW_H
SKY_TOP = VIEW_TOP + MARSH['sky'] * VIEW_H     # the picture carries that much more sky above its own top
VIEW_BOT = VIEW_TOP - VIEW_H
MOON_A, MOON_Z = math.radians(32), 7.4         # the moon: from the spawn it stands in the right-hand window
LIGHT_A = math.radians(-66)                    # the lighthouse, and the town beside it
N = Vector((0, -1, 0))        # what faces the room from the porch wall
S = Vector((0, 1, 0))         # … from the wall behind the camera
E = Vector((1, 0, 0))         # … from the left wall
Wst = Vector((-1, 0, 0))      # … from the right wall
UP = Vector((0, 0, 1))


SKIFF = Vector((JX1 + 0.78, 8.1, WATER))                               # the skiff lies alongside the jetty, a fender's width off
WALKWAY_Y = 3.5                                                        # the plank walk back to dry land leaves the deck's left side there


def dry(x, y, m=0.45):
    """Where nothing grows and nothing glints: under the hut, the deck, the jetty, the landing, the plank walk, the skiff."""
    return ((-HW - m < x < HW + m and FRONT - m < y < BACK + m) or (-DX - m < x < DX + m and BACK - m < y < DECK + m)
            or (JX0 - m < x < JX1 + m and DECK - m < y < JEND + m) or (PLAT[0] - m < x < PLAT[1] + m and PLAT[2] - m < y < PLAT[3] + m)
            or (-14 < x < -DX and WALKWAY_Y - 0.6 - m < y < WALKWAY_Y + 0.6 + m) or (abs(x - SKIFF.x) < 0.55 + m and abs(y - SKIFF.y) < 1.65 + m))


def out_at(a, r, z):
    """A point out in the marsh: bearing a (from +Y round toward +X), r from its middle."""
    return Vector((r * math.sin(a), CY + r * math.cos(a), z))


def inward(a):
    return Vector((-math.sin(a), -math.cos(a), 0))


def roof_z(y):
    return RIDGE - (RIDGE - EAVE) * abs(y - RIDGE_Y) / (BACK - RIDGE_Y)


def about(axis, ang):
    """A turn about any axis, as animate() takes it."""
    return tuple(Matrix.Rotation(ang, 3, Vector(axis).normalized()).to_euler())


# ════════════════════════════════════════════════════════════════════════
# Materials
# ════════════════════════════════════════════════════════════════════════
log("materials")
M['floor'] = make_mat('FloorBoards', img='floor', nrm='floor_n', rough=0.6, glow=0.14)
M['deck'] = make_mat('DeckBoards', img='deck', nrm='deck_n', rough=0.8, glow=0.10)
M['wall'] = make_mat('WallBoards', img='wall', rough=0.85, glow=0.30, single=True)
M['wall_out'] = make_mat('WallOutside', img='wall', rough=0.9, glow=0.10, single=True)
M['ceiling'] = make_mat('RoofBoards', img='ceiling', rough=0.85, glow=0.26, single=True)
M['tin'] = make_mat('TinRoof', img='tin', rough=0.6, metal=0.2, glow=0.16)
M['tarpaper'] = make_mat('TarPaper', img='tarpaper', rough=0.95, glow=0.3, single=True)
for key, name, g in (('oak', 'Oak', 0.18), ('walnut', 'Walnut', 0.16), ('beam', 'Beam', 0.14), ('pine', 'NewPine', 0.30),
                     ('drift', 'Driftwood', 0.10), ('pile', 'Piling', 0.06), ('teal_wood', 'TealPaint', 0.24),
                     ('leather', 'Leather', 0.22), ('basket', 'Wicker', 0.2), ('blind', 'Bamboo', 0.22), ('spines', 'Books', 0.2),
                     ('stripes', 'HammockCanvas', 0.22), ('drawers', 'Drawers', 0.30), ('pegboard', 'Pegboard', 0.34),
                     ('pinboard', 'Pinboard', 0.42), ('meadow', 'MeadowReading', 0.5), ('rug', 'Rug', 0.24),
                     ('screen_tide', 'ScreenTide', 1.0), ('screen_work', 'ScreenWork', 1.0), ('scope', 'ScopeScreen', 0.9),
                     ('keyboard', 'Keyboard', 0.3), ('speaker0', 'SpeakerOld', 0.28), ('speaker1', 'SpeakerBlack', 0.3),
                     ('speaker2', 'SpeakerNew', 0.3), ('deck_face', 'TapeDeckFace', 0.34), ('amp', 'AmpFace', 0.8),
                     ('tide_staff', 'TideStaff', 0.3), ('crate', 'Crate', 0.26), ('frog_file', 'FrogFile', 0.4)):
    M[key] = make_mat(name, img=key, rough=0.8, glow=g)
for c in ('orange', 'teal', 'cream', 'moss'):
    M['linen_' + c] = make_mat('Linen' + c.capitalize(), img='linen_' + c, rough=0.95, spec=0.2, glow=0.24)
# The marsh shows by its own light alone, whatever lights the app has on: the hour is its own.
for key in ('marsh', 'marsh_back', 'high', 'water'):
    M[key] = make_mat(key.capitalize(), img=key, glow=1.0, lit=False, single=key != 'water')
for key in ('creatures', 'flora', 'pads', 'trees', 'trees_far', 'monster', 'lighthouse', 'town', 'dragonfly', 'fish'):
    M[key] = make_mat(key.capitalize(), img=key, glow=1.0, lit=False, alpha='MASK')
M['pictures'] = make_mat('Pictures', img='pictures', rough=0.6, glow=0.5, alpha='MASK', single=True)
M['plants'] = make_mat('Plants', img='plants', rough=0.9, spec=0.1, glow=0.32, alpha='MASK')
M['things'] = make_mat('Things', img='things', rough=0.8, glow=0.36, alpha='MASK')
M['things2'] = make_mat('Things2', img='things2', rough=0.8, glow=0.36, alpha='MASK')
for key in ('barometer', 'tide_dial', 'reel', 'record', 'moth'):
    M[key] = make_mat(key.capitalize(), img=key, rough=0.5, glow=0.4, alpha='MASK')
M['shade'] = make_mat('LampShade', img='shade', rough=0.9, glow=1.0)
for key in ('glow', 'glow_soft', 'glow_white', 'glow_fly', 'glow_moon', 'steam', 'mist', 'ring', 'moon', 'trees_wake'):
    M[key] = make_mat(key.capitalize(), color=(0, 0, 0), img=key, rough=1.0, spec=0.0, glow=1.0, alpha='BLEND')
M['bulb'] = make_mat('Bulb', color=(1.0, 0.9, 0.7), glow=1.0, glow_color=(1.0, 0.86, 0.58))
M['lamp_glass'] = make_mat('LanternGlass', color=(1.0, 0.86, 0.6), glow=1.0, glow_color=(1.0, 0.78, 0.42))
M['trace'] = make_mat('ScopeTrace', color=(0.5, 1.0, 0.7), glow=1.0, glow_color=(0.45, 1.0, 0.62))
M['led'] = make_mat('Led', color=(0.4, 1.0, 0.5), glow=1.0, glow_color=(0.4, 1.0, 0.5))
M['red_light'] = make_mat('MastLight', color=(1.0, 0.2, 0.15), glow=1.0, glow_color=(1.0, 0.22, 0.16))
M['wire'] = make_mat('Wire', color=(0.10, 0.12, 0.10), rough=0.8)
M['wire_brown'] = make_mat('WireCloth', color=(0.40, 0.26, 0.14), rough=0.9, glow=0.2)
M['wire_red'] = make_mat('WireRed', color=(0.70, 0.16, 0.12), rough=0.6, glow=0.25)
M['wire_clear'] = make_mat('WireClear', color=(0.90, 0.90, 0.86), rough=0.3, glow=0.3)
M['rope'] = make_mat('Rope', color=(0.62, 0.52, 0.36), rough=0.95, glow=0.14)
M['brass'] = make_mat('Brass', color=(0.80, 0.60, 0.28), rough=0.3, glow=0.28)
M['copper'] = make_mat('Copper', color=(0.78, 0.45, 0.28), rough=0.3, glow=0.26)
M['iron'] = make_mat('BlackIron', color=(0.08, 0.08, 0.09), rough=0.5, glow=0.03)
M['steel'] = make_mat('Steel', color=(0.72, 0.74, 0.76), rough=0.3, glow=0.2)
M['black'] = make_mat('Black', color=(0.02, 0.02, 0.025), rough=0.4)
M['paper'] = make_mat('Paper', color=(0.93, 0.90, 0.80), rough=0.9, glow=0.34)
M['coffee'] = make_mat('Coffee', color=(0.20, 0.11, 0.06), rough=0.3, glow=0.1)
M['tea'] = make_mat('Tea', color=(0.50, 0.30, 0.10), rough=0.2, glow=0.24)
M['glass_jar'] = make_mat('JarGlass', color=(0.80, 0.90, 0.88), rough=0.1, glow=0.3)
for key, colour in (('white', (0.95, 0.94, 0.90)), ('cream', (0.93, 0.88, 0.74)), ('teal', (0.26, 0.50, 0.50)),
                    ('orange', (0.92, 0.50, 0.18)), ('green', (0.36, 0.60, 0.30))):
    M['c_' + key] = make_mat('Glaze' + key.capitalize(), color=colour, rough=0.35, glow=0.26)


# ════════════════════════════════════════════════════════════════════════
# The hut's own shapes
# ════════════════════════════════════════════════════════════════════════
BULBS = []
LANTERNS = []
HANG = []


def bulb(x, y, top, z, glow=1.1):
    """A bare bulb on its flex: the den is not finished."""
    name = f'Bulb{len(BULBS)}'
    top = Vector((x, y, top))
    with part(name, top):
        tube('wire', top, (x, y, z + 0.10), 0.005, segs=4)
        lathe('brass', [(0.016, 0.10), (0.02, 0.07), (0.02, 0.05)], (x, y, z), segs=8)
        sphere('bulb', (x, y, z), 0.045, segs=8, rings=6, sz=1.25)
        halo('glow', (x, y, z), glow)
    BULBS.append((name, top.z - z))


def lantern(c, glow=0.9, hung=False):
    """A storm lantern standing on c (or hung by its handle from c). The
    glow is a part of its own, to gutter."""
    c = Vector(c) - (UP * 0.36 if hung else UP * 0)
    lathe('iron', [(0.065, 0), (0.07, 0.02), (0.045, 0.05)], c, segs=10, capb=True)
    lathe('lamp_glass', [(0.042, 0.05), (0.06, 0.12), (0.042, 0.20)], c, segs=10)
    lathe('iron', [(0.048, 0.20), (0.056, 0.22), (0.028, 0.26), (0.0, 0.27)], c, segs=10)
    rope('iron', [c + Vector((0.075 * math.cos(a), 0, 0.20 + 0.16 * math.sin(a))) for a in [math.pi * j / 6 for j in range(7)]], 0.004, segs=3)
    name = f'Lantern{len(LANTERNS)}'
    with part(name, c + UP * 0.12):
        halo('glow', c + UP * 0.12, glow)
    LANTERNS.append(name)
    return c


def hanging(idx, top, h, drop=0.25, sheet='plants'):
    """A plant (or a strand of moss) hung from `top`, free to swing."""
    name = f'Hang{len(HANG)}'
    top = Vector(top)
    with part(name, top):
        tube('wire', top, top - UP * drop, 0.003, segs=3)
        crossed(sheet, idx, top - UP * (drop + h), h, 0.4 + len(HANG))
    HANG.append((name, drop + h * 0.6))


def specks(name, key, quads, shrink=0.12, drift=None):
    """Small lights that come and go, as one object: quads = [(centre,
    half-across, half-up)], each of which the 'Dim' shape key shrinks about
    its own middle (a scene cannot fade a material). drift: {key name: one
    offset per quad}, more shape keys, each of which carries every quad
    its own way."""
    v = []; dim = []; f = []; uv = []
    for c, r, t in quads:
        b = len(v)
        for sr, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            v.append(c + r * sr + t * st); dim.append(c + (r * sr + t * st) * shrink)
            uv.append(((sr + 1) / 2, (st + 1) / 2))
        f.append((b, b + 1, b + 2, b + 3))
    shapes = {'Dim': dim}
    for kname, offs in (drift or {}).items():
        shapes[kname] = [p + offs[i // 4] for i, p in enumerate(v)]
    return whole(name, key, v, f, uv, shapes, smooth=False)


class Leaning:
    """Cut-outs that give to the air, as one object: each stands (or hangs)
    as two crossed cards whose free end the 'Sway' shape key carries one way
    and 'Gust' another, each its own."""
    def __init__(self, name, key):
        self.name, self.key = name, key
        self.v = []; self.f = []; self.uv = []; self.sway = []; self.gust = []

    def add(self, idx, foot, h, yaw=None, hang=False):
        s = SPR[self.key][idx]
        w = h * s['aspect']
        foot = Vector(foot)
        yaw = random.uniform(0, math.pi) if yaw is None else yaw
        own = Vector((random.uniform(-1, 1), random.uniform(-1, 1), 0)) * 0.045 * h
        for a in (yaw, yaw + math.pi / 2):
            r = Vector((math.cos(a), math.sin(a), 0))
            b = len(self.v)
            for sr, st in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
                p = foot + r * sr * w / 2 + UP * (st - 1 if hang else st) * h
                free = (1 - st) if hang else st
                self.v.append(p)
                self.sway.append(p + Vector((0.055 * h * free, 0.015 * h * free, 0)))
                self.gust.append(p + own * free)
                self.uv.append((s['u0'] if sr < 0 else s['u1'], s['v0'] if st == 0 else s['v1']))
            self.f.append((b, b + 1, b + 2, b + 3))

    def build(self):
        return whole(self.name, self.key, self.v, self.f, self.uv, {'Sway': self.sway, 'Gust': self.gust}, smooth=False)


def recliner(pos, yaw):
    """The chair whose recline he has adjusted forty-one times; unturned, it faces +Y."""
    with place(pos, yaw):
        soft('leather', (0, 0.02, 0.30), (0.64, 0.68, 0.26), n=6, segs=16, rings=6, tile=0.5)
        soft('leather', (0, -0.40, 0.68), (0.70, 0.20, 0.86), n=5, segs=16, rings=8, tile=0.5, R=Matrix.Rotation(0.42, 3, 'X'))
        soft('linen_orange', (0, -0.50, 1.02), (0.40, 0.12, 0.22), n=3.2, segs=12, rings=6, tile=0.3, R=Matrix.Rotation(0.42, 3, 'X'))
        for sx in (-1, 1):
            soft('leather', (sx * 0.37, 0.0, 0.42), (0.18, 0.76, 0.48), n=5, segs=14, rings=8, tile=0.5)
        soft('leather', (0, 0.04, 0.46), (0.54, 0.58, 0.12), n=5, segs=14, rings=6, tile=0.5)
        soft('leather', (0, 0.66, 0.40), (0.52, 0.46, 0.10), n=5, segs=14, rings=6, tile=0.5, R=Matrix.Rotation(-0.10, 3, 'X'))     # the foot rest, out
        for sx in (-1, 1):
            beam('steel', (sx * 0.22, 0.34, 0.26), (sx * 0.22, 0.66, 0.35), 0.02, 0.02)
        tube('steel', (0.47, -0.16, 0.34), (0.47, -0.02, 0.58), 0.012, segs=6)                    # the lever
        sphere('black', (0.47, -0.02, 0.60), 0.028, segs=8, rings=5)
        lathe('walnut', [(0.30, 0.0), (0.30, 0.05)], (0, 0, 0.11), segs=14, capb=True)


def deck_chair(pos, yaw, key='teal_wood'):
    """A slatted porch chair with wide arms; unturned, it faces +Y."""
    with place(pos, yaw):
        Rs = Matrix.Rotation(0.16, 3, 'X')
        Rb = Matrix.Rotation(0.36, 3, 'X')
        for k in range(5):
            x = -0.24 + 0.12 * k
            wood((x, 0.0, 0.36), (0.105, 0.54, 0.022), key, R=Rs)
            wood((x, -0.40, 0.72), (0.105, 0.022, 0.82 - 0.05 * abs(k - 2)), key, R=Rb)
        for sx in (-1, 1):
            wood((sx * 0.30, 0.24, 0.26), (0.05, 0.08, 0.52), key)
            wood((sx * 0.30, -0.28, 0.20), (0.05, 0.08, 0.40), key)
            wood((sx * 0.33, -0.04, 0.535), (0.13, 0.70, 0.025), key)
        wood((0, -0.36, 0.50), (0.60, 0.03, 0.06), key)


def skiff(c, L=3.4, B=0.64, NS=16, NH=6):
    """A rowing skiff afloat at c (on her waterline), her bow toward +Y:
    a round-bilged hull lofted from stern to stem, teal outside and bare
    inside, ribs, bottom boards, three thwarts, her oars shipped, fenders
    over the side toward -X. Returns where her lines make fast: the stem
    head and the quarter."""
    P = 0.62                                                           # how square her sections are: 1 a half circle, less the boxier
    sheer = lambda t: 0.36 + 0.16 * t * t + 0.03 * (1 - t) ** 2        # her rail above the water: lowest aft of the middle, up to the bow
    # Her bottom: flat for most of her, rising to the stem. She rides light, and her bottom is thick: the water is one
    # sheet with no hole in it for a boat, so everything inside her has to be above it or it would lie under water.
    keel = lambda t: -0.03 + 0.33 * t ** 3.2
    FLOOR = 0.07                                                       # the inside of her bottom, above the outside
    along = lambda t: -L / 2 + L * t

    def half(t):
        """Half her breadth at the rail, t from the transom (0) to the stem (1)."""
        swell = 0.74 + 0.26 * math.sin(math.pi / 2 * min(1.0, t / 0.42))
        return B * swell * (1.0 if t < 0.42 else 1 - ((t - 0.42) / 0.58) ** 2.3)

    def section(t, inset=0.0, n=NH):
        """One of her sections, rail to keel to rail (inset: the same inside her planking)."""
        b, k = max(0.015, half(t) - inset), keel(t) + (FLOOR if inset else 0.0)
        pts = []
        for j in range(-n, n + 1):
            th = math.pi / 2 * abs(j) / n
            pts.append(c + Vector((math.copysign(b * math.sin(th) ** P, j), along(t), k + (sheer(t) - k) * (1 - math.cos(th) ** P))))
        return pts

    def inside(t, z, inset=0.03):
        """Half her breadth inside at that height."""
        k = keel(t) + FLOOR
        up = min(1.0, max(0.0, (z - k) / (sheer(t) - k)))
        return max(0.015, half(t) - inset) * (1 - (1 - up) ** (2 / P)) ** (P / 2)

    outer = [section(i / NS) for i in range(NS + 1)]
    inner = [section(i / NS, 0.03) for i in range(NS + 1)]
    uv = [[(i * 0.3, j * 0.11) for j in range(2 * NH + 1)] for i in range(NS + 1)]
    mb('teal_wood').grid(outer, uv, True)
    mb('oak').grid(inner, uv, True)
    for side in (0, 2 * NH):                                           # the rail: a capping, and a rubbing strake outside it
        ribbon('oak', [p[side] for p in outer], [p[side] for p in inner], [i * 0.3 for i in range(NS + 1)])
        rope('oak', [p[side] + Vector((math.copysign(0.012, p[side].x - c.x), 0, -0.012)) for p in outer], 0.02, segs=5)
    for side in (2, 2 * NH - 2):                                       # her one stripe
        rope('c_orange', [p[side] for p in outer[:-1]], 0.011, segs=4)
    flat = lambda pts: [((p.x - c.x) * 0.8, (p.z - c.z) * 0.8) for p in pts]
    mb('teal_wood').face(outer[0], flat(outer[0]))                     # the transom, and its capping
    stern_in = [p + Vector((0, 0.03, 0)) for p in inner[0]]
    mb('oak').face(stern_in, flat(stern_in))
    wood(c + Vector((0, along(0) + 0.015, sheer(0))), (2 * half(0) + 0.03, 0.055, 0.03), 'oak')
    stem_top = sheer(1) + 0.11
    wood(c + Vector((0, along(1) + 0.005, (keel(1) + stem_top) / 2)), (0.045, 0.06, stem_top - keel(1)), 'oak')
    ring_c = c + Vector((0, along(1) + 0.05, sheer(1) + 0.02))
    rope('brass', [ring_c + Vector((0.03 * math.cos(a), 0, 0.03 * math.sin(a))) for a in [2 * math.pi * j / 8 for j in range(9)]], 0.006, segs=4)
    for t in (0.12, 0.26, 0.40, 0.54, 0.68, 0.82):                     # ribs
        rope('oak', section(t, 0.036, 8), 0.012, segs=4)
    for x in (-0.21, -0.07, 0.07, 0.21):                               # bottom boards
        wood(c + Vector((x, along(0.28), keel(0.28) + FLOOR + 0.03)), (0.125, L * 0.44, 0.014), 'pine', tile=1.2)
    for t, deep in ((0.13, 0.34), (0.47, 0.22), (0.80, 0.24)):         # thwarts: stern sheets, the rowing thwart, the bow
        z = sheer(t) - 0.13
        wood(c + Vector((0, along(t), z)), (2 * inside(t, z) + 0.01, deep, 0.028), 'pine', tile=1.2)
    for sx in (-1, 1):
        lock = c + Vector((sx * (half(0.58) - 0.015), along(0.58), sheer(0.58)))          # rowlocks
        tube('brass', lock, lock + UP * 0.045, 0.008, segs=5)
        for sy in (-1, 1):
            tube('brass', lock + UP * 0.045, lock + Vector((0, sy * 0.035, 0.10)), 0.006, segs=4)
        blade = c + Vector((sx * 0.22, along(0) + 0.22, sheer(0.13) - 0.13 + 0.036))      # the oars, shipped: blades aft
        grip = c + Vector((sx * 0.13, along(0) + 2.75, sheer(0.80) - 0.13 + 0.036))
        beam('pine', blade, blade.lerp(grip, 0.2), 0.095, 0.014, tile=1.2)
        tube('pine', blade.lerp(grip, 0.18), grip, 0.019, 0.016, segs=6, caps=True)
        tube('walnut', grip, grip + (grip - blade).normalized() * 0.13, 0.014, segs=6, caps=True)
    lathe('tin', [(0.06, 0), (0.078, 0.12), (0.072, 0.12), (0.055, 0.012)], c + Vector((0.2, along(0.33), keel(0.33) + FLOOR + 0.038)), segs=10, tile=0.3, capb=True)   # the bailer
    for t in (0.30, 0.62):                                             # fenders, toward the jetty
        top = c + Vector((-half(t), along(t), sheer(t)))
        hang = top + Vector((-0.075, 0, -0.34))
        lathe('c_orange', [(0.0, 0.0), (0.055, 0.03), (0.062, 0.12), (0.055, 0.21), (0.0, 0.24)], hang, segs=10)
        tube('rope', hang + UP * 0.24, top, 0.005, segs=3)
    return c + Vector((0, along(1) + 0.03, stem_top - 0.03)), c + Vector((-half(0.02), along(0.02), sheer(0.02)))


def monitor(pos, yaw, key, w=0.54):
    """A monitor on its foot; unturned, its screen faces -Y."""
    h = w * 320 / 512
    with place(pos, yaw):
        lathe('black', [(0.11, 0.0), (0.11, 0.012), (0.02, 0.02), (0.02, 0.16)], (0, 0.03, 0), segs=12, capb=True)
        wood((0, 0.0, 0.14 + h / 2), (w + 0.03, 0.03, h + 0.03), 'black')
        card(key, (0, -0.0155, 0.14 + h / 2), N, w, h)


def stilt(x, y, top=-0.02, r=0.09):
    tube('pile', (x, y, WATER - 0.7), (x, y, top), r * 1.1, r, segs=7)


# ════════════════════════════════════════════════════════════════════════
# The shell: floor, walls, roof
# ════════════════════════════════════════════════════════════════════════
log("shell")
floor('floor', -HW, HW, FRONT, BACK + SKIN, 0, tile=3.0)
DOOR = (-DOOR_HW, DOOR_HW, 0, DOOR_TOP)
pierced_y('wall', -HW, HW, 0, EAVE, BACK, [DOOR, *WINS], facing=N)
pierced_y('wall_out', -HW, HW, 0, EAVE, BACK + SKIN, [DOOR, *WINS], facing=S)
STUDS = (2.2, HW)                                                      # the stretch of the front wall that is still in studs
pierced_y('wall', -HW, HW, 0, EAVE, FRONT, [(STUDS[0], STUDS[1], 0, EAVE)], facing=S)
wall_y('tarpaper', STUDS[0], STUDS[1], 0, EAVE, FRONT - 0.09, facing=S)
for sx, facing in ((-1, E), (1, Wst)):
    wall_x('wall', FRONT, BACK, 0, EAVE, sx * HW, facing=facing)
    poly('wall', [(sx * HW, FRONT, EAVE), (sx * HW, BACK, EAVE), (sx * HW, RIDGE_Y, RIDGE)], 2.0, (1, 2), facing=facing)
for y in (FRONT, BACK):                                                # the roof, from inside: boards on rafters
    poly('ceiling', [(-HW, y, EAVE), (HW, y, EAVE), (HW, RIDGE_Y, RIDGE), (-HW, RIDGE_Y, RIDGE)], 1.3, (0, 1), facing=(0, 0, -1))
    for k in range(9):
        x = -3.6 + k * 0.9
        beam('beam', (x, y, EAVE - 0.07), (x, RIDGE_Y, RIDGE - 0.07), 0.07, 0.13, up=(1, 0, 0), tile=1.2)
beam('beam', (-HW, RIDGE_Y, RIDGE - 0.10), (HW, RIDGE_Y, RIDGE - 0.10), 0.10, 0.18, tile=1.2)
# The slope over the porch has its tin on, to be looked back at from the jetty. The slope over the camera's side has
# none (nor have the side walls and the front wall an outside): from there the roof is looked in through.
OVER = 0.18
poly('tin', [(-HW - OVER, BACK + SKIN, EAVE + 0.03), (HW + OVER, BACK + SKIN, EAVE + 0.03), (HW + OVER, RIDGE_Y, RIDGE + 0.03),
             (-HW - OVER, RIDGE_Y, RIDGE + 0.03)], 1.2, (0, 1))
beam('drift', (-HW - OVER, RIDGE_Y, RIDGE + 0.05), (HW + OVER, RIDGE_Y, RIDGE + 0.05), 0.16, 0.05, tile=1.2)
for sx in (-1, 1):                                                     # a barge board at either end
    beam('drift', (sx * (HW + OVER), BACK + SKIN, EAVE - 0.03), (sx * (HW + OVER), RIDGE_Y, RIDGE - 0.03), 0.03, 0.14, up=(1, 0, 0), tile=1.2)
TIES = (-1.9, 1.9)                                                     # two tie beams, wall plate to wall plate
for x in TIES:
    beam('beam', (x, FRONT, EAVE), (x, BACK, EAVE), 0.12, 0.16, tile=1.2)
for y in (FRONT + 0.05, BACK - 0.05):
    beam('beam', (-HW, y, EAVE), (HW, y, EAVE), 0.10, 0.12, tile=1.2)
# The doorway: its frame in the wall's thickness, a bamboo blind rolled up under the head.
DM = BACK + SKIN / 2
for sx in (-1, 1):
    wood((sx * (DOOR_HW + 0.04), DM, DOOR_TOP / 2), (0.10, SKIN + 0.06, DOOR_TOP), 'teal_wood')
wood((0, DM, DOOR_TOP + 0.05), (2 * DOOR_HW + 0.18, SKIN + 0.06, 0.10), 'teal_wood')
wood((0, DM, 0.012), (2 * DOOR_HW, SKIN + 0.04, 0.024), 'oak')
tube('blind', (-DOOR_HW + 0.06, BACK - 0.075, DOOR_TOP - 0.09), (DOOR_HW - 0.06, BACK - 0.075, DOOR_TOP - 0.09), 0.065, segs=10, caps=True, tile=0.4)
for x in (-1.2, 0.0, 1.2):
    rope('rope', [(x, BACK - 0.075 + 0.07 * math.sin(a), DOOR_TOP - 0.09 + 0.07 * math.cos(a)) for a in [2 * math.pi * j / 8 for j in range(9)]], 0.006, segs=4)
soft('linen_moss', (0, BACK - 0.45, 0.008), (1.3, 0.6, 0.016), n=8, segs=12, rings=4, tile=0.3)
# The windows: no glass yet, a frame and one bar each way.
for x0, x1, z0, z1 in WINS:
    xm, zm = (x0 + x1) / 2, (z0 + z1) / 2
    for x in (x0 - 0.03, x1 + 0.03):
        wood((x, DM, zm), (0.06, SKIN + 0.05, z1 - z0 + 0.12), 'teal_wood')
    for z in (z0 - 0.03, z1 + 0.03):
        wood((xm, DM, z), (x1 - x0, SKIN + 0.05, 0.06), 'teal_wood')
    wood((xm, DM - 0.04, z0 - 0.02), (x1 - x0 + 0.2, SKIN + 0.16, 0.035), 'oak')
    wood((xm, DM, zm), (0.03, 0.04, z1 - z0), 'teal_wood')
    wood((xm, DM, zm), (x1 - x0, 0.04, 0.03), 'teal_wood')
# The wall in studs: tar paper behind, the first new boards on at the foot, a work lamp clipped on.
for x in (2.245, 2.72, 3.20, 3.655):
    box(one_sided('pine'), (x, FRONT - 0.045, EAVE / 2), (0.045, 0.09, EAVE), tile=0.9, skip=-S)
for x0, x1, z in ((2.245, 2.72, 1.3), (2.72, 3.20, 1.1), (3.20, 3.655, 1.3)):
    box(one_sided('pine'), ((x0 + x1) / 2, FRONT - 0.045, z), (x1 - x0, 0.09, 0.045), tile=0.9, skip=-S)
for k in range(4):
    box(one_sided('pine'), ((STUDS[0] + STUDS[1]) / 2 - 0.1 * (k == 3), FRONT + 0.011, 0.11 + 0.205 * k), (STUDS[1] - STUDS[0] - 0.2 * (k == 3), 0.022, 0.19),
        tile=1.4, skip=-S)
CLAMP = Vector((2.72, FRONT + 0.06, 1.92))
lathe('steel', [(0.02, 0.0), (0.085, 0.10)], CLAMP + Vector((0, 0.0, 0.0)), (0.2, 1, -0.5), segs=12)
sphere('bulb', CLAMP + Vector((0.012, 0.06, -0.03)), 0.035, segs=8, rings=5)
halo('glow', CLAMP + Vector((0.02, 0.10, -0.05)), 0.8)

# ════════════════════════════════════════════════════════════════════════
# The marsh: the far shore, the sky, the water
# ════════════════════════════════════════════════════════════════════════
log("marsh")
NA = 64
for key, a0, mirrored in (('marsh', -math.pi / 2, False), ('marsh_back', math.pi / 2, True)):
    P = []; UV = []
    for z, v in ((VIEW_BOT, 0.0), (SKY_TOP, 1.0)):
        P.append([out_at(a0 + math.pi * k / NA, R, z) for k in range(NA + 1)])
        UV.append([((1 - k / NA) if mirrored else k / NA, v) for k in range(NA + 1)])
    mb(key).grid(P, UV, True)
poly('high', [(-R, CY - R, SKY_TOP), (R, CY - R, SKY_TOP), (R, CY + R, SKY_TOP), (-R, CY + R, SKY_TOP)], 1.0, (0, 1), facing=(0, 0, -1))
NR, NS = 28, 96
P = []; UV = []
for i in range(NR + 1):                                                # rings as the square of the way out, as the water was painted
    s = i / NR
    P.append([out_at(-math.pi + 2 * math.pi * k / NS, R * 1.004 * s * s, WATER) for k in range(NS + 1)])
    UV.append([(k / NS, 1 - s) for k in range(NS + 1)])
mb('water').grid(P, UV, True)
# The moon, a day past full, just clear of the trees; its road on the water, in three sets that come and go.
MOON = out_at(MOON_A, R - 0.5, MOON_Z)
card('glow_moon', out_at(MOON_A, R - 0.45, MOON_Z), inward(MOON_A), 10.0, 10.0)
card('moon', MOON, inward(MOON_A), 2.0, 2.0)
TANG = Vector((math.cos(MOON_A), -math.sin(MOON_A), 0))
GLINTS = []
for g in range(3):
    quads = []
    for k in range(28):
        r = random.uniform(5.0, 38)
        c = out_at(MOON_A, r, WATER + 0.03) + TANG * random.uniform(-1, 1) * (0.3 + 0.035 * r)
        if dry(c.x, c.y, 0.6):                                         # none under the jetty, or in the skiff
            continue
        quads.append((c, TANG * random.uniform(0.3, 0.8) * (0.5 + r / 30), -inward(MOON_A) * random.uniform(0.25, 0.6) * (0.5 + r / 10)))
    GLINTS.append(specks(f'Glints{g}', 'glow_white', quads, shrink=0.15))
# More stars than the picture has, and these ones tremble.
STARS = []
for g in range(3):
    quads = []
    for k in range(18):
        a = random.uniform(-math.pi, math.pi)
        el = math.radians(random.uniform(13, 47))
        size = random.uniform(0.10, 0.22)
        quads.append((out_at(a, R - 0.6, HORIZON + R * math.tan(el)), Vector((math.cos(a), -math.sin(a), 0)) * size, UP * size))
    STARS.append(specks(f'Stars{g}', 'glow_white', quads, shrink=0.35))
# The lighthouse on its headland (its lamp comes round as it does from Eve's window and Ara's), the town beside it.
card('lighthouse', out_at(LIGHT_A, R - 0.7, HORIZON + 4.4), inward(LIGHT_A), 3.3, 8.8)
card('town', out_at(LIGHT_A + math.radians(15), R - 0.7, HORIZON + 0.8), inward(LIGHT_A + math.radians(15)), 12.8, 1.6)
LAMP = out_at(LIGHT_A, R - 0.9, HORIZON + 7.5)
with part('LighthouseGlow', LAMP):
    card('glow_white', LAMP, inward(LIGHT_A), 2.6, 2.6)
# Mist lying on the water, a long way out.
MISTS = []
for k, (deg, r, w) in enumerate(((-34, 24, 16), (8, 30, 20), (47, 21, 14), (-80, 27, 18), (118, 24, 18), (-150, 22, 16))):
    a = math.radians(deg)
    c = out_at(a, r, WATER + 0.75)
    with part(f'Mist{k}', c):
        card('mist', c, inward(a), w, 1.9)
    MISTS.append((f'Mist{k}', a))

# ════════════════════════════════════════════════════════════════════════
# Trees, reeds, lily pads
# ════════════════════════════════════════════════════════════════════════
log("growth")


def tree(deg, dist, idx, h, far=False, mirror=None):
    """A tree standing in the water that far out. A near one has what the
    water gives back of it too: the same cut-out laid flat toward the
    porch, as long as it looks from there at eye height (but no longer
    than eight metres: from anywhere else it is a shadow on the water)."""
    a = math.radians(deg)
    foot = out_at(a, dist, WATER - 0.05)
    s = SPR['trees'][idx]
    mirror = random.random() < 0.5 if mirror is None else mirror
    w = sprite('trees', idx, foot, inward(a), h, mirror=mirror, key='trees_far' if far else 'trees')
    if far:
        return
    reach = min(8.0, dist * h / (h + HORIZON - WATER))
    u0, u1 = (s['u0'], s['u1']) if mirror else (s['u1'], s['u0'])      # a flat card reads the other way round from a standing one
    card('trees_wake', foot + inward(a) * reach / 2 + UP * 0.07, (0, 0, 1), w, reach, up=inward(a), u0=u0, u1=u1, v0=s['v0'], v1=s['v1'])


# The bearings of the lighthouse and of the moon are kept clear, but for one dead tree across the moon's face.
for spec in ((-86, 30, 0, 13, True), (-92, 18, 2, 6, False), (-47, 27, 0, 12, True), (-38, 15.5, 1, 8, False), (-28, 33, 0, 12, True),
             (-13, 34, 2, 6, True), (33, 30, 1, 9, True), (60, 16, 2, 6.5, False), (50, 31, 0, 12, True),
             (73, 14, 0, 11, False), (85, 28, 1, 8, True),
             (101, 18, 0, 12, False), (118, 26, 2, 7, True), (131, 14, 0, 12, False), (148, 21, 1, 8, False), (163, 14, 2, 6.5, False),
             (177, 18, 0, 13, False), (-169, 25, 0, 12, True), (-154, 13, 0, 11, False), (-139, 18, 2, 7, False), (-126, 28, 0, 13, True),
             (-111, 15, 1, 7.5, False), (-96, 23, 2, 6, True)):
    tree(*spec)
# One more cypress, far out where the door looks — and behind it, what lives out there. It keeps the trunk between
# itself and the hut, and now and then leans out to look: the trunk is as wide as its shoulders, so only the head shows.
MON_A, MON_TREE, MON_H = math.radians(10), 11.0, 3.7
TRUNK = 0.52                                                           # where across the cypress cut-out its trunk stands, at head height
tree(10, 35, 0, MON_TREE, True, mirror=False)
MON_R = Vector((math.cos(MON_A), -math.sin(MON_A), 0))                 # to the right, as the porch sees it
MON = out_at(MON_A, 35.7, WATER - 0.3) + MON_R * (TRUNK - 0.5) * MON_TREE * SPR['trees'][0]['aspect']
with part('Monster', MON):
    MON_W = sprite('monster', 0, MON, inward(MON_A), MON_H)
    for across in (0.335, 0.615):                                      # its eyes, which are lamps
        card('glow_soft', MON + MON_R * (across - 0.5) * MON_W + UP * 0.84 * MON_H + inward(MON_A) * 0.06, inward(MON_A), 0.42, 0.42)
REEDS = Leaning('Reeds', 'flora')
TALL = {0: 2.1, 1: 2.5, 4: 1.5}                                        # cattails, reeds, flag iris: these stand over the deck's edge
LOW = {2: 1.0, 3: 1.25}                                                # marsh grass, pickerelweed
n = 0
while n < 74:
    r = random.uniform(1.0, 15.0) if n < 52 else random.uniform(15.0, 26.0)
    a = random.uniform(-math.pi, math.pi)
    p = out_at(a, r, WATER - 0.08)
    if n < 52:                                                         # most of it hugs the hut's own edges
        p = Vector((random.uniform(-9.5, 9.5), random.uniform(-7.5, 15.0), WATER - 0.08))
    if dry(p.x, p.y):
        continue
    open_water = abs(p.x - 0.3) < 2.6 and DECK < p.y < 17 or abs(p.x - 1.5) < 4.5 and 14 < p.y < 20   # the way the door looks: kept low
    idx = random.choice(list(LOW) if open_water else list(TALL) + list(TALL) + list(LOW))
    REEDS.add(idx, p, {**TALL, **LOW}[idx] * random.uniform(0.85, 1.2))
    n += 1
# Reeds for the ducks and the alligator to go behind at either end of their beats.
DUCKS = (Vector((-8.6, 12.4, WATER)), Vector((-2.4, 15.2, WATER)))
GATOR = (Vector((-2.2, 18.0, WATER)), Vector((5.4, 16.8, WATER)))      # … his, across the open water beyond the landing
for beat in (DUCKS, GATOR):
    for end in beat:
        back = (end - Vector((0, CY, WATER))).normalized()
        for k in range(3):
            REEDS.add(1 if k % 2 else 0, end - back * 0.9 + Vector((random.uniform(-0.5, 0.5), random.uniform(-0.3, 0.3), -0.08)), random.uniform(2.0, 2.5))
# Spanish moss from the porch roof's corners, and a stump with pale mushrooms by the plank walk.
MOSS = Leaning('Moss', 'flora')
for x, h in ((-4.62, 0.85), (-4.45, 0.6), (4.62, 0.8), (4.4, 0.55), (-2.1, 0.45)):
    MOSS.add(5, (x, AWN + 0.02, AWN_Z - 0.02), h, hang=True)
sprite('flora', 7, (-6.3, WALKWAY_Y + 1.5, WATER - 0.05), inward(math.radians(-75)), 1.3)
sprite('flora', 6, (-7.0, WALKWAY_Y + 1.9, WATER - 0.05), inward(math.radians(-75)), 1.0)
halo('glow_moon', (-6.25, WALKWAY_Y + 1.45, WATER + 1.15), 1.1)
# Lily pads, lying where the water is quiet.
PAD_SPOTS = []
n = 0
while n < 60:
    p = Vector((random.uniform(-11, 11), random.uniform(-6, 19), WATER + 0.02 + 0.002 * (n % 5)))
    if dry(p.x, p.y, 0.2) or any((p - q).length < 0.9 for q in PAD_SPOTS):
        continue
    a = random.uniform(0, 2 * math.pi)
    sprite('pads', random.randrange(8), p, (0, 0, 1), random.uniform(0.55, 1.25), centre=True, up=(math.cos(a), math.sin(a), 0))
    PAD_SPOTS.append(p)
    n += 1

# ════════════════════════════════════════════════════════════════════════
# What lives out there
# ════════════════════════════════════════════════════════════════════════
log("creatures")
facing_porch = lambda p: (Vector((0, 4.0, 0)) - Vector((p[0], p[1], 0))).normalized()
# Frogs on their pads, singing.
FROGS = []
for k, (x, y, idx, h) in enumerate(((-1.7, 6.9, 1, 0.20), (0.6, 6.5, 2, 0.19), (3.9, 11.2, 1, 0.21), (-3.6, 7.6, 2, 0.20), (5.6, 4.6, 1, 0.20))):
    foot = Vector((x, y, WATER + 0.035))
    sprite('pads', (0, 5, 6, 0, 5)[k], foot - UP * 0.01, (0, 0, 1), 0.8, centre=True, up=(math.cos(k), math.sin(k), 0))
    with part(f'Frog{k}', foot):
        sprite('creatures', idx, foot, facing_porch(foot), h, mirror=k % 2 == 1)
    FROGS.append(f'Frog{k}')
# A heron in the shallows on the left, entirely patient.
HERON = Vector((-5.4, 9.6, WATER - 0.10))
with part('Heron', HERON):
    sprite('creatures', 0, HERON, facing_porch(HERON), 1.3, mirror=True)
# A turtle on its log; an owl on the tall post by the plank walk.
TURTLE = Vector((5.0, 7.4, WATER - 0.03))
with part('Turtle', TURTLE):
    sprite('creatures', 3, TURTLE, facing_porch(TURTLE), 0.36)
OWL_POST = Vector((-5.5, 5.9, 0))
stilt(OWL_POST.x, OWL_POST.y, top=1.55, r=0.10)
sprite('creatures', 7, OWL_POST + UP * 1.50, facing_porch(OWL_POST), 0.46)
# The ducks and the alligator, each on a beat between two stands of reeds; they turn out of sight.
with part('Ducks', DUCKS[1]):
    sprite('creatures', 4, DUCKS[1] - UP * 0.07, facing_porch((DUCKS[0] + DUCKS[1]) / 2), 0.38)
with part('Gator', GATOR[1]):
    sprite('creatures', 5, GATOR[1] - UP * 0.07, facing_porch((GATOR[0] + GATOR[1]) / 2), 0.32)
# An egret going home, round the whole marsh once.
EGRET_R, EGRET_Z = 26.0, 9.5
EGRET = out_at(0, EGRET_R, EGRET_Z)
with part('Egret', EGRET):
    sprite('creatures', 6, EGRET, N, 1.5, centre=True)
# Dragonflies over the rail; a fish that jumps where the door looks.
FLIES = []
for k, p in enumerate((Vector((-0.8, 6.3, 0.75)), Vector((2.2, 7.6, 1.25)), Vector((-3.2, 6.0, 1.0)))):
    with part(f'Dragonfly{k}', p):
        card('dragonfly', p, (0, -0.55, 0.85), 0.09, 0.07)
    FLIES.append(f'Dragonfly{k}')
FISH = Vector((-0.5, 9.2, WATER))
with part('Fish', FISH):
    card('fish', FISH, N, 0.24, 0.12)
RINGS = []
for k, (p, size) in enumerate(((FISH + Vector((0.5, 0, 0)), 1.5), (Vector((-2.9, 8.4, WATER)), 1.2), (Vector((4.6, 5.9, WATER)), 1.0),
                               (Vector((0.9, 13.0, WATER)), 1.6))):
    with part(f'Ring{k}', p + UP * 0.04):
        card('ring', p + UP * 0.04, (0, 0, 1), size, size)
    RINGS.append(f'Ring{k}')
# Fireflies: nine sets, each flashing on its own count; every one of them wanders its own way.
FIREFLIES = []
for g in range(9):
    quads = []; dx = []; dy = []
    for k in range(12):
        while True:
            c = Vector((random.uniform(-9, 9), random.uniform(-1.5, 15), random.uniform(WATER + 0.3, 2.3)))
            inside = -HW < c.x < HW and FRONT < c.y < BACK + SKIN
            if not inside and (c.z > 0.25 or not dry(c.x, c.y, 0.1)):
                break
        a, b = (Vector((random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-0.5, 0.5))) * 0.45 for _ in range(2))
        for r, t in ((Vector((0.065, 0, 0)), UP * 0.065), (Vector((0, 0.065, 0)), UP * 0.065)):
            quads.append((c, r, t)); dx.append(a); dy.append(b)
    FIREFLIES.append(specks(f'Fireflies{g}', 'glow_fly', quads, shrink=0.06, drift={'DriftA': dx, 'DriftB': dy}))

# ════════════════════════════════════════════════════════════════════════
# The porch: deck, roof, rail
# ════════════════════════════════════════════════════════════════════════
log("porch")
poly('deck', [(-DX, BACK + SKIN, 0), (DX, BACK + SKIN, 0), (DX, DECK, 0), (-DX, DECK, 0)], 2.4, (1, 0), facing=(0, 0, 1))
for y in (DECK - 0.04, BACK + 1.7):                                    # what the boards lie on
    beam('drift', (-DX, y, -0.09), (DX, y, -0.09), 0.08, 0.16, tile=1.2)
for sx in (-1, 1):
    beam('drift', (sx * (DX - 0.04), BACK, -0.09), (sx * (DX - 0.04), DECK, -0.09), 0.08, 0.16, tile=1.2)
for x in (-4.5, -2.25, 0, 2.25, 4.5):
    for y in (BACK + 1.7, DECK - 0.15):
        stilt(x, y)
for x in (-3.5, -1.2, 1.2, 3.5):
    for y in (FRONT + 0.2, RIDGE_Y, BACK - 0.1):
        stilt(x, y)
# The porch roof: tin on rafters, on four posts, and seen from both sides.
poly('tin', [(-DX, BACK + SKIN, EAVE), (DX, BACK + SKIN, EAVE), (DX, AWN, AWN_Z), (-DX, AWN, AWN_Z)], 1.2, (0, 1))
POSTS = (-4.55, -1.95, 1.95, 4.55)
for x in POSTS:
    wood((x, AWN - 0.12, AWN_Z / 2 - 0.03), (0.10, 0.10, AWN_Z - 0.06), 'drift')
    beam('drift', (x, BACK + SKIN, EAVE - 0.07), (x, AWN, AWN_Z - 0.07), 0.06, 0.10, up=(1, 0, 0), tile=1.2)
beam('drift', (-DX, AWN - 0.12, AWN_Z - 0.10), (DX, AWN - 0.12, AWN_Z - 0.10), 0.09, 0.12, tile=1.2)
# The rail: posts, a top rail, one rope under it — light, so the water shows through. A gap for the jetty, a gate for the plank walk.
RUNS = [((-DX, DECK), (JX0, DECK)), ((JX1, DECK), (DX, DECK)), ((DX, DECK), (DX, BACK + SKIN)),
        ((-DX, DECK), (-DX, WALKWAY_Y + 0.55)), ((-DX, WALKWAY_Y - 0.55), (-DX, BACK + SKIN))]
for (x0, y0), (x1, y1) in RUNS:
    a, b = Vector((x0, y0, 0)), Vector((x1, y1, 0))
    n_posts = max(1, round((b - a).length / 1.55))
    for k in range(n_posts + 1):
        p = a.lerp(b, k / n_posts)
        wood(p + UP * (RAIL / 2), (0.08, 0.08, RAIL), 'drift')
    beam('drift', a + UP * RAIL, b + UP * RAIL, 0.11, 0.045, tile=1.2)
    for k in range(n_posts):
        rope('rope', sag(a.lerp(b, k / n_posts) + UP * 0.50, a.lerp(b, (k + 1) / n_posts) + UP * 0.50, 0.05, 6), 0.011, segs=4)
GATE = Vector((-DX - 0.06, WALKWAY_Y, 0))
for k in range(6):
    wood(GATE + Vector((0, -0.45 + 0.18 * k, 0.48)), (0.025, 0.15, 0.80), 'teal_wood')
for z in (0.22, 0.74):
    wood(GATE + Vector((0.02, 0, z)), (0.03, 1.06, 0.07), 'teal_wood')
# The plank walk back to dry land: two boards wide, on its own short posts, off into the reeds.
poly('deck', [(-13.5, WALKWAY_Y - 0.42, -0.04), (-DX, WALKWAY_Y - 0.42, -0.04), (-DX, WALKWAY_Y + 0.42, -0.04), (-13.5, WALKWAY_Y + 0.42, -0.04)],
     2.4, (1, 0), facing=(0, 0, 1))
for k in range(5):
    x = -DX - 0.9 - 1.9 * k
    for sy in (-1, 1):
        stilt(x, WALKWAY_Y + sy * 0.36, top=-0.05 if (k + sy) % 3 else 0.7, r=0.06)
rope('rope', swags((-DX - 0.9, WALKWAY_Y + 0.36, 0.66), (-DX - 8.5, WALKWAY_Y + 0.36, 0.66), 4, 0.16), 0.012, segs=4)
# The mast at the deck's corner: the cups that tell the wind, an aerial, a red light for the egrets.
MAST = Vector((-DX + 0.12, DECK - 0.12, 0))
MAST_TOP = 4.7
tube('drift', MAST, MAST + UP * MAST_TOP, 0.045, 0.03, segs=8)
beam('steel', MAST + Vector((-0.3, 0, 3.6)), MAST + Vector((0.55, 0, 3.6)), 0.014, 0.014)    # the aerial: a boom and its elements
for k in range(3):
    beam('steel', MAST + Vector((-0.2 + 0.3 * k, -0.24 + 0.04 * k, 3.6)), MAST + Vector((-0.2 + 0.3 * k, 0.24 - 0.04 * k, 3.6)), 0.008, 0.008)
CUPS = MAST + UP * (MAST_TOP + 0.05)
with part('Cups', CUPS):
    lathe('steel', [(0.0, -0.04), (0.02, -0.03), (0.02, 0.02), (0.0, 0.03)], CUPS, segs=8)
    for k in range(3):
        a = k * 2 * math.pi / 3
        d = Vector((math.cos(a), math.sin(a), 0))
        tube('steel', CUPS, CUPS + d * 0.17, 0.005, segs=4)
        sphere('c_orange', CUPS + d * 0.19 + Vector((-d.y, d.x, 0)) * 0.02, 0.04, segs=8, rings=5)
BEACON = MAST + UP * 4.25
with part('MastLight', BEACON):
    sphere('red_light', BEACON + Vector((0.06, 0, 0)), 0.03, segs=6, rings=4)
rope('wire', sag(MAST + UP * 3.3, (-HW + 0.2, BACK + SKIN, EAVE - 0.05), 0.35, 10), 0.006, segs=3)
# Lights: lanterns on the posts either side of the door, fairy lights along the eave.
HOOKS = []
for x in (POSTS[1], POSTS[2]):
    hook = Vector((x, AWN - 0.30, AWN_Z - 0.36))
    beam('iron', (x, AWN - 0.12, AWN_Z - 0.30), hook + UP * 0.02, 0.012, 0.012)
    HOOKS.append(lantern(hook, glow=1.0, hung=True))
fairy(swags((-DX + 0.1, AWN + 0.02, AWN_Z - 0.06), (DX - 0.1, AWN + 0.02, AWN_Z - 0.06), 9, 0.12), 0.14)
MOTHS = []
for k in range(3):
    c = HOOKS[1] + UP * 0.14
    with part(f'Moth{k}', c):
        card('moth', c + Vector((0.16 + 0.05 * k, 0, 0.03 * k)), (0, -0.5, 0.86), 0.05, 0.05)
    MOTHS.append(f'Moth{k}')
# The wind chime: five lengths of bamboo and the disc that knocks them.
CHIME = Vector((-0.75, AWN - 0.02, AWN_Z - 0.10))
with part('Chime', CHIME):
    tube('wire', CHIME, CHIME - UP * 0.10, 0.003, segs=3)
    lathe('oak', [(0.0, 0.0), (0.07, 0.0), (0.07, 0.012), (0.0, 0.012)], CHIME - UP * 0.112, segs=10)
    for k in range(5):
        a = k * 2 * math.pi / 5
        p = CHIME + Vector((0.055 * math.cos(a), 0.055 * math.sin(a), -0.13))
        tube('blind', p, p - UP * (0.22 + 0.04 * k), 0.011, segs=6, tile=0.3)
    tube('wire', CHIME - UP * 0.11, CHIME - UP * 0.52, 0.002, segs=3)
    lathe('oak', [(0.0, 0.0), (0.035, 0.0), (0.035, 0.01), (0.0, 0.01)], CHIME - UP * 0.30, segs=8)
    wood(CHIME - UP * 0.56, (0.05, 0.004, 0.08), 'teal_wood')
hanging(7, (4.0, AWN - 0.25, AWN_Z - 0.14), 0.62, drop=0.10)           # a pothos, and an orchid on its bark
hanging(3, (-3.1, AWN - 0.25, AWN_Z - 0.14), 0.50, drop=0.12)
# The good spot: two chairs facing the water, a crate between them — the bag, two drinks, a lantern.
deck_chair((-2.55, 4.55, 0), math.radians(-12), 'teal_wood')
deck_chair((-1.05, 4.55, 0), math.radians(12), 'teal_wood')
soft('linen_orange', (-2.53, 4.32, 0.56), (0.42, 0.10, 0.36), n=3.2, segs=12, rings=6, tile=0.3, R=Matrix.Rotation(0.36, 3, 'X'))
CRATE = Vector((-1.8, 4.75, 0))
wood(CRATE + UP * 0.21, (0.46, 0.46, 0.42), 'pine')
for nrm in (N, S, E, Wst):
    card('crate', CRATE + UP * 0.21 + nrm * 0.232, nrm, 0.46, 0.42)
sprite('things', 0, CRATE + Vector((-0.04, 0.06, 0.42)), N, 0.28)
mug(CRATE + Vector((-0.16, -0.12, 0.42)), 'c_orange', full='tea')
mug(CRATE + Vector((0.15, -0.13, 0.42)), 'c_teal', full='tea')
lantern(CRATE + Vector((0.14, 0.12, 0.42)), glow=0.8)
# The hammock, slung across the porch's left corner from the wall to the corner post.
HA, HB = Vector((-2.2, BACK + SKIN + 0.04, 1.42)), Vector((POSTS[0] + 0.05, AWN - 0.14, 1.42))
HM = (HA + HB) / 2
ALONG = (HB - HA).normalized()
ACROSS = Vector((-ALONG.y, ALONG.x, 0))
with part('Hammock', HM):
    NH, NW = 16, 6
    P = []; UV = []
    for i in range(NH + 1):
        t = i / NH
        u = 0.14 + 0.72 * t                                            # the cloth takes the middle of the span, ropes the rest
        mid = HA.lerp(HB, u) - UP * 0.78 * 4 * u * (1 - u)
        wide = 0.10 + 0.72 * math.sin(math.pi * t) ** 0.6
        P.append([mid + ACROSS * (j / NW - 0.5) * wide - UP * 0.16 * (1 - (2 * j / NW - 1) ** 2) * math.sin(math.pi * t) for j in range(NW + 1)])
        UV.append([(t * 2.4, 0.08 + 0.84 * j / NW) for j in range(NW + 1)])
    mb('stripes').grid(P, UV, True)
    for end, row in ((HA, P[0]), (HB, P[-1])):
        for p in row[::2]:
            tube('rope', end, p, 0.006, segs=3)
    soft('linen_teal', P[3][3] + UP * 0.04, (0.42, 0.30, 0.13), n=3.2, segs=12, rings=6, tile=0.3, R=Matrix.Rotation(math.atan2(ALONG.y, ALONG.x), 3, 'Z'))
lathe('iron', [(0.0, 0.0), (0.02, 0.0), (0.02, 0.03)], HA, (0, -1, 0), segs=6)
# The right end: the rain barrel under its pipe, an eel trap from Moss, waders by the door, rope and an anchor.
BARREL = Vector((4.15, BACK + SKIN + 0.42, 0))
lathe('walnut', [(0.27, 0), (0.33, 0.25), (0.34, 0.45), (0.31, 0.72), (0.27, 0.86)], BARREL, segs=16, tile=0.8, capb=True)
for z in (0.12, 0.45, 0.78):
    lathe('iron', [(0.305 + 0.035 * (z == 0.45), z - 0.02), (0.305 + 0.035 * (z == 0.45), z + 0.02)], BARREL, segs=16)
lathe('c_teal', [(0.26, 0.80)], BARREL, segs=16, capt=True)
tube('tin', (4.15, BACK + SKIN + 0.42, 0.98), (4.15, BACK + SKIN + 0.42, EAVE - 0.28), 0.04, segs=8, tile=0.4)
TRAP = Vector((3.1, BACK + SKIN + 0.45, 0.17))
lathe('basket', [(0.05, -0.36), (0.16, -0.30), (0.17, 0.26), (0.10, 0.36), (0.05, 0.30)], TRAP, (1, 0.15, 0), segs=12, tile=0.3)
sprite('things', 3, (2.1, BACK + SKIN + 0.22, 0), S, 0.50)
sprite('things2', 6, (4.05, DECK - 0.55, 0), facing_porch((4.05, DECK - 0.55)), 0.34)
sprite('things2', 1, (POSTS[3] - 0.22, AWN - 0.2, 0), N, 0.32)

# ════════════════════════════════════════════════════════════════════════
# The jetty, the landing, the skiff
# ════════════════════════════════════════════════════════════════════════
log("jetty")
poly('deck', [(JX0, DECK, 0), (JX1, DECK, 0), (JX1, JEND, 0), (JX0, JEND, 0)], 2.4, (1, 0), facing=(0, 0, 1))
poly('deck', [(PLAT[0], PLAT[2], 0), (PLAT[1], PLAT[2], 0), (PLAT[1], PLAT[3], 0), (PLAT[0], PLAT[3], 0)], 2.4, (1, 0), facing=(0, 0, 1))
for x in (JX0 + 0.05, JX1 - 0.05):
    beam('drift', (x, DECK, -0.08), (x, JEND, -0.08), 0.07, 0.14, tile=1.2)
for x0, y0, x1, y1 in ((PLAT[0], PLAT[2], PLAT[1], PLAT[2]), (PLAT[0], PLAT[3], PLAT[1], PLAT[3]), (PLAT[0], PLAT[2], PLAT[0], PLAT[3]),
                       (PLAT[1], PLAT[2], PLAT[1], PLAT[3])):
    beam('drift', (x0, y0, -0.08), (x1, y1, -0.08), 0.07, 0.14, tile=1.2)
JPOSTS = [DECK + 0.1 + k * (JEND - DECK - 0.2) / 3 for k in range(4)]
for k, y in enumerate(JPOSTS):                                         # tall posts and a rope on the left, mooring posts on the right
    stilt(JX0 + 0.02, y, top=RAIL, r=0.07)
    stilt(JX1 - 0.02, y, top=0.42 if k else RAIL, r=0.07)
for ya, yb in zip(JPOSTS[:-1], JPOSTS[1:]):
    rope('rope', sag((JX0 + 0.02, ya, RAIL - 0.08), (JX0 + 0.02, yb, RAIL - 0.08), 0.14, 8), 0.013, segs=4)
    fairy(sag((JX0 + 0.02, ya, RAIL + 0.02), (JX0 + 0.02, yb, RAIL + 0.02), 0.10, 8), 0.17)
for x, y in ((PLAT[0] + 0.06, PLAT[2] + 0.06), (PLAT[1] - 0.06, PLAT[2] + 0.06), (PLAT[0] + 0.06, PLAT[3] - 0.06), (PLAT[1] - 0.06, PLAT[3] - 0.06)):
    stilt(x, y, top=RAIL if y > PLAT[2] + 1 else 0.42, r=0.075)
beam('drift', (PLAT[0] + 0.06, PLAT[3] - 0.06, 0.08), (PLAT[1] - 0.06, PLAT[3] - 0.06, 0.08), 0.07, 0.10, tile=1.2)     # a kerb at the far edge
lantern((PLAT[0] + 0.06, PLAT[3] - 0.06, RAIL + 0.01), glow=1.0)
lantern((JX1 - 0.02, JPOSTS[0], RAIL + 0.01), glow=0.9)
# A bench on the landing, the tackle, a rod left fishing.
BENCH = Vector((2.9, PLAT[3] - 0.75, 0))
wood(BENCH + UP * 0.42, (1.3, 0.34, 0.04), 'drift')
for sx in (-1, 1):
    wood(BENCH + Vector((sx * 0.55, 0, 0.20)), (0.05, 0.30, 0.40), 'drift')
sprite('things', 2, BENCH + Vector((0.30, 0, 0.44)), N, 0.22)
sprite('things', 6, BENCH + Vector((-0.34, 0.02, 0.44)), N, 0.25)
lathe('basket', [(0.13, 0), (0.17, 0.12), (0.16, 0.26), (0.14, 0.26), (0.12, 0.02)], (3.55, PLAT[2] + 0.45, 0), segs=12, tile=0.3, capb=True)   # the creel
# The rod: its butt in a socket bolted to the boards, its middle in a forked rest on the kerb, out over the water at 32°.
ROD_X, ROD_UP = 1.25, math.radians(32)
ROD_DIR = Vector((0, math.cos(ROD_UP), math.sin(ROD_UP)))
ROD_FOOT = Vector((ROD_X, PLAT[3] - 0.95, 0.075))
ROD_TIP = ROD_FOOT + ROD_DIR * 3.2
REST = ROD_FOOT + ROD_DIR * ((PLAT[3] - 0.06 - ROD_FOOT.y) / ROD_DIR.y)    # where it crosses the kerb
wood((ROD_X, ROD_FOOT.y - 0.03, 0.04), (0.18, 0.26, 0.08), 'drift')
tube('iron', ROD_FOOT - ROD_DIR * 0.07, ROD_FOOT + ROD_DIR * 0.17, 0.027, segs=8, caps=True)
for sx in (-1, 1):
    wood((ROD_X + sx * 0.07, ROD_FOOT.y - 0.03, 0.085), (0.02, 0.10, 0.01), 'iron')
wood((ROD_X, PLAT[3] - 0.06, (REST.z - 0.05) / 2 + 0.05), (0.05, 0.05, REST.z - 0.15), 'drift')
for sx in (-1, 1):                                                     # the fork it lies in
    beam('drift', (ROD_X, PLAT[3] - 0.06, REST.z - 0.11), (ROD_X + sx * 0.075, PLAT[3] - 0.06, REST.z + 0.07), 0.028, 0.035)
tube('walnut', ROD_FOOT, ROD_FOOT.lerp(ROD_TIP, 0.2), 0.017, 0.012, segs=6)
tube('black', ROD_FOOT.lerp(ROD_TIP, 0.2), ROD_TIP, 0.012, 0.003, segs=5)
REEL = ROD_FOOT.lerp(ROD_TIP, 0.13) + Vector((0, 0.03, -0.05))
lathe('brass', [(0.0, -0.022), (0.04, -0.022), (0.04, 0.022), (0.0, 0.022)], REEL, (1, 0, 0), segs=12)
tube('wire', REEL + Vector((0, 0.02, 0.03)), ROD_TIP, 0.002, segs=3)
FLOAT = Vector((ROD_X - 0.1, ROD_TIP.y + 0.95, WATER))
with part('Float', FLOAT):
    tube('wire', ROD_TIP, FLOAT + UP * 0.10, 0.0025, segs=3)
    lathe('c_orange', [(0.0, 0.10), (0.022, 0.07), (0.028, 0.03), (0.0, -0.01)], FLOAT, segs=8)
    lathe('c_white', [(0.028, 0.03), (0.02, -0.01), (0.0, -0.05)], FLOAT, segs=8)
with part('RingFloat', FLOAT + UP * 0.03):
    card('ring', FLOAT + UP * 0.03, (0, 0, 1), 0.7, 0.7)
# The tide gauge on its post, off the landing's corner.
STAFF = Vector((4.45, PLAT[3] + 0.5, 0))
stilt(STAFF.x, STAFF.y + 0.09, top=1.95, r=0.07)
wood(STAFF + UP * (WATER - 0.6 + 1.3), (0.15, 0.03, 2.6), 'c_white')
card('tide_staff', STAFF + Vector((0, -0.017, WATER - 0.6 + 1.3)), N, 0.14, 2.56)
# The skiff, tied alongside by her bow and her quarter, at the foot of a ladder.
with part('Skiff', SKIFF):
    STEM, QUARTER = skiff(SKIFF)
rope('rope', sag(STEM, (JX1 - 0.02, JPOSTS[3], 0.36), 0.22, 8), 0.011, segs=4)
rope('rope', sag(QUARTER, (JX1 - 0.02, JPOSTS[1], 0.36), 0.22, 8), 0.011, segs=4)
LADDER = Vector((JX1 + 0.05, SKIFF.y - 0.55, 0))
for sy in (-1, 1):
    beam('drift', LADDER + Vector((0, sy * 0.21, 0.30)), LADDER + Vector((0.04, sy * 0.21, WATER - 0.4)), 0.05, 0.06, up=(1, 0, 0), tile=1.2)
for k in range(5):
    z = -0.12 - 0.27 * k
    beam('drift', LADDER + Vector((0.01, -0.21, z)), LADDER + Vector((0.01, 0.21, z)), 0.035, 0.035, tile=1.2)

# ════════════════════════════════════════════════════════════════════════
# The den, left wall: the workbench, the tide clock, the chair
# ════════════════════════════════════════════════════════════════════════
log("left wall")
LX = -HW + 0.014                                                       # where things hang on it
B0, B1, BD, BT = -3.05, -0.25, 0.74, 0.90                              # the bench: its two ends, its depth, its top
BX = -HW + BD / 2
wood((BX, (B0 + B1) / 2, BT - 0.025), (BD, B1 - B0, 0.05), 'oak', tile=1.4)
for y in (B0 + 0.12, (B0 + B1) / 2, B1 - 0.12):                        # on trestles of new pine
    for sx in (-1, 1):
        beam('pine', (BX + sx * 0.12, y, BT - 0.05), (BX + sx * 0.30, y, 0), 0.05, 0.07)
    beam('pine', (BX - 0.24, y, 0.32), (BX + 0.24, y, 0.32), 0.04, 0.06)
wood((BX, (B0 + B1) / 2, 0.345), (BD - 0.2, B1 - B0 - 0.3, 0.025), 'pine', tile=1.4)
for k, y in enumerate((-2.6, -1.95)):
    wood((BX, y, 0.50), (0.42, 0.46, 0.28), 'pine')
    card('crate', (BX + 0.211, y, 0.50), E, 0.46, 0.28, v0=0.2, v1=0.8)
# A box of his own on the shelf under the bench: lights that tick over.
NET = Vector((BX + 0.02, -1.05, 0.36))
wood(NET + UP * 0.07, (0.34, 0.40, 0.14), 'black')
LEDS = []
for g in range(2):
    quads = [(NET + Vector((0.172, -0.15 + 0.06 * k + 0.03 * g, 0.07 + 0.03 * (g * 2 - 1) * 0.5)), Vector((0, 0.009, 0)), UP * 0.009) for k in range(5)]
    LEDS.append(specks(f'Leds{g}', 'led', quads, shrink=0.25))
# On the bench, front to back: the lamp, two monitors and a keyboard, the frog file, the scope, the gimbal.
LAMP_FOOT = Vector((-HW + 0.16, B0 + 0.22, BT))
lathe('iron', [(0.08, 0), (0.08, 0.015), (0.012, 0.03)], LAMP_FOOT, segs=10, capb=True)
ELBOW, HEAD = LAMP_FOOT + Vector((0.02, 0.05, 0.42)), LAMP_FOOT + Vector((0.34, 0.26, 0.62))
tube('iron', LAMP_FOOT + UP * 0.03, ELBOW, 0.008, segs=5)
tube('iron', ELBOW, HEAD, 0.008, segs=5)
lathe('c_orange', [(0.03, 0.0), (0.045, -0.04), (0.10, -0.15)], HEAD, (-0.1, -0.1, 1), segs=12)
sphere('bulb', HEAD + Vector((0.01, 0.01, -0.09)), 0.035, segs=8, rings=5)
halo('glow', HEAD + Vector((0.02, 0.02, -0.16)), 0.9)
monitor((-HW + 0.24, -2.22, BT), math.pi / 2 - 0.22, 'screen_tide')
monitor((-HW + 0.22, -1.58, BT), math.pi / 2 + 0.12, 'screen_work')
card('keyboard', (-HW + 0.56, -1.86, BT + 0.0125), (0, 0, 1), 0.42, 0.15, up=(-1, 0, 0))
wood((-HW + 0.56, -1.86, BT + 0.006), (0.16, 0.43, 0.012), 'black')
card('frog_file', (-HW + 0.50, -2.72, BT + 0.004), (0, 0, 1), 0.23, 0.30, up=(-0.97, 0.26, 0))
MUG = Vector((-HW + 0.60, -1.40, BT))
mug(MUG, 'c_teal', full='tea')
steam('SteamBench', MUG + UP * 0.12, 2, 0.10, tall=1.8)
SCOPE = Vector((-HW + 0.24, -0.98, BT))
wood(SCOPE + UP * 0.15, (0.36, 0.34, 0.30), 'c_cream')
card('scope', SCOPE + Vector((0.181, 0.05, 0.16)), E, 0.20, 0.20)
for k in range(3):
    sphere('black', SCOPE + Vector((0.185, -0.12, 0.08 + 0.07 * k)), 0.016, segs=6, rings=4)
NT = 40                                                                # the trace: a wave that runs (two shape keys a quarter turn apart)
TY0, TW, TZ, AMP = SCOPE.y + 0.05 - 0.092, 0.184, SCOPE.z + 0.16, 0.05
tv = []; ta = []; tb = []; tf = []; tuv = []
for k in range(NT + 1):
    y = TY0 + TW * k / NT
    ph = 2 * math.pi * 2.5 * k / NT
    for dz in (-0.004, 0.004):
        tv.append(Vector((SCOPE.x + 0.183, y, TZ + dz)))
        ta.append(Vector((SCOPE.x + 0.183, y, TZ + dz + AMP * math.sin(ph))))
        tb.append(Vector((SCOPE.x + 0.183, y, TZ + dz + AMP * math.cos(ph))))
        tuv.append((0.5, 0.5))
    if k:
        tf.append((2 * k - 2, 2 * k, 2 * k + 1, 2 * k - 1))
TRACE = whole('Trace', 'trace', tv, tf, tuv, {'WaveA': ta, 'WaveB': tb}, smooth=False)
SOLDER = Vector((-HW + 0.50, -0.66, BT))
lathe('steel', [(0.04, 0), (0.04, 0.012), (0.006, 0.02), (0.006, 0.07)], SOLDER, segs=8, capb=True)
tube('c_orange', SOLDER + Vector((0, 0, 0.06)), SOLDER + Vector((0.10, 0.05, 0.10)), 0.011, segs=6)
tube('steel', SOLDER + Vector((-0.07, -0.035, 0.032)), SOLDER + Vector((0, 0, 0.06)), 0.004, segs=4)
steam('SteamSolder', SOLDER + Vector((-0.07, -0.035, 0.05)), 2, 0.04, tall=2.6)
GYRO = Vector((-HW + 0.30, -0.48, BT))                                 # the positioning rig's grandfather: a gimbal, still turning
lathe('walnut', [(0.09, 0), (0.09, 0.025), (0.02, 0.04), (0.02, 0.07)], GYRO, segs=12, capb=True)
GC = GYRO + UP * 0.20
rope('brass', [GC + Vector((0, 0.13 * math.cos(a), 0.13 * math.sin(a))) for a in [2 * math.pi * j / 20 for j in range(21)]], 0.007, segs=5)
with part('Gimbal', GC):
    rope('brass', [GC + Vector((0.105 * math.cos(a), 0, 0.105 * math.sin(a))) for a in [2 * math.pi * j / 18 for j in range(19)]], 0.006, segs=5)
    lathe('steel', [(0.0, -0.012), (0.075, -0.012), (0.085, 0.0), (0.075, 0.012), (0.0, 0.012)], GC, (0.35, 0, 1), segs=16)
    tube('steel', GC - Vector((0.035, 0, 0.1)), GC + Vector((0.035, 0, 0.1)), 0.006, segs=5)
# Over the bench: the tool board, a shelf with the radio and what he looks through.
frame(('pegboard', 2.0), (LX, -2.05, 1.72), E, 1.80, 'pine', border=0.04)
wood((-HW + 0.11, -0.66, 1.58), (0.22, 0.86, 0.025), 'pine')
for y in (-1.0, -0.32):
    beam('iron', (-HW + 0.01, y, 1.41), (-HW + 0.19, y, 1.565), 0.012, 0.012)
sprite('things', 1, (-HW + 0.11, -0.86, 1.593), E, 0.24)
sprite('things2', 3, (-HW + 0.11, -0.52, 1.593), E, 0.17)
sprite('things2', 4, (-HW + 0.11, -0.30, 1.593), E, 0.11)
# The tide clock he built from a bicycle wheel: the wheel ticks round, a pendulum keeps it honest.
HUB = Vector((-HW + 0.07, 1.10, 1.92))
WHEEL_R, SPOKES = 0.36, 24
with part('Wheel', HUB):
    rope('steel', [HUB + Vector((0, WHEEL_R * math.cos(a), WHEEL_R * math.sin(a))) for a in [2 * math.pi * j / 28 for j in range(29)]], 0.012, segs=5)
    rope('black', [HUB + Vector((0, (WHEEL_R + 0.022) * math.cos(a), (WHEEL_R + 0.022) * math.sin(a))) for a in [2 * math.pi * j / 28 for j in range(29)]],
         0.02, segs=6)                                                 # it still has its tyre
    for k in range(SPOKES):
        a = 2 * math.pi * k / SPOKES
        tube('steel', HUB + Vector(((0.02 if k % 2 else -0.02), 0, 0)), HUB + Vector((0, WHEEL_R * math.cos(a), WHEEL_R * math.sin(a))), 0.0022, segs=3)
    sphere('c_orange', HUB + Vector((0.0, 0, WHEEL_R - 0.05)), 0.016, segs=6, rings=4)                # one marked spoke, to see it go
tube('steel', (-HW, HUB.y, HUB.z), HUB + Vector((0.035, 0, 0)), 0.014, segs=6)
card('tide_dial', HUB + Vector((0.036, 0, 0)), E, 0.30, 0.30)
beam('brass', HUB + Vector((0.042, 0, 0)), HUB + Vector((0.042, 0.095, -0.055)), 0.012, 0.004, up=(1, 0, 0))     # two hours to low water
PIVOT_P = HUB + Vector((0.02, 0, -WHEEL_R - 0.04))
PEND_L = 0.56
with part('Pendulum', PIVOT_P):
    tube('brass', PIVOT_P, PIVOT_P - UP * PEND_L, 0.006, segs=4)
    lathe('brass', [(0.0, -0.014), (0.07, -0.014), (0.078, 0.0), (0.07, 0.014), (0.0, 0.014)], PIVOT_P - UP * PEND_L, (1, 0, 0), segs=14)
wood(PIVOT_P + Vector((-0.02, 0, 0.01)), (0.04, 0.05, 0.03), 'brass')
card('barometer', (LX + 0.02, 0.30, 1.86), E, 0.30, 0.30)              # the barometer with opinions
lathe('brass', [(0.155, 0.0), (0.155, 0.02)], (-HW, 0.30, 1.86), (1, 0, 0), segs=20)
frame(8, (LX, 0.30, 1.28), E, 0.34, 'walnut')                          # the tides, engraved
# The chair, turned to look out of the door; a table and a lamp at its elbow.
CHAIR = Vector((-2.72, 1.22, 0))
recliner(CHAIR, math.radians(-52))
SIDE = Vector((-3.32, 0.42, 0))
lathe('walnut', [(0.0, 0.50), (0.24, 0.50), (0.24, 0.53), (0.0, 0.53)], SIDE, segs=18, tile=0.8)
lathe('walnut', [(0.24, 0.53)], SIDE, segs=18, capt=True)
lathe('walnut', [(0.15, 0), (0.13, 0.03), (0.03, 0.07), (0.03, 0.50)], SIDE, segs=10, tile=0.8)
lamp(SIDE + Vector((-0.06, 0.06, 0.53)), r=0.15, h=0.20, stem=0.26, base='c_teal')
pile(SIDE + Vector((0.08, -0.10, 0.53)), (1, 0), 3, 0.4)
sprite('things2', 0, (-2.75, BACK - 0.10, WINS[0][2] + 0.02), N, 0.13)   # binoculars on the sill: fishing, he maintains, is observation

# ════════════════════════════════════════════════════════════════════════
# The den, right wall: the drawers, three generations of loudspeaker
# ════════════════════════════════════════════════════════════════════════
log("right wall")
RX = HW - 0.014
C0, C1, CD, CH = -3.15, -1.55, 0.42, 1.33                              # the wall of small drawers
CMID = (C0 + C1) / 2
wood((HW - CD / 2, CMID, 0.06), (CD - 0.04, C1 - C0 - 0.04, 0.12), 'black')
wood((HW - CD / 2, CMID, 0.12 + CH / 2), (CD, C1 - C0, CH), 'walnut')
card('drawers', (HW - CD - 0.003, CMID, 0.12 + CH / 2), Wst, C1 - C0, CH)
wood((HW - CD / 2 - 0.01, CMID, 0.12 + CH + 0.015), (CD + 0.05, C1 - C0 + 0.05, 0.03), 'oak')
CTOP = 0.12 + CH + 0.03
plant(0, (HW - 0.22, C0 + 0.24, CTOP), 0.46, 0.3)                      # a frog's house plants: they eat flies too
plant(1, (HW - 0.24, C0 + 0.62, CTOP), 0.26, 0.9)
sprite('things2', 5, (HW - 0.22, CMID + 0.22, CTOP), Wst, 0.17)
plant(6, (HW - 0.22, C1 - 0.22, CTOP), 0.34, 0.5)
frame(('meadow', 640 / 480), (RX, CMID, 2.13), Wst, 0.62, 'oak', border=0.045)       # first position: the cows remember
frame(1, (RX, CMID - 0.62, 2.10), Wst, 0.36, 'walnut')                 # rounds with his father
frame(2, (RX, CMID + 0.70, 2.12), Wst, 0.50, 'walnut')                 # the borrowed boat
# The console: the turntable, the tape machine, the amplifier; a loudspeaker of each generation, and all their wire.
H0, H1, HD, HH = -1.05, 0.95, 0.50, 0.60
HMID = (H0 + H1) / 2
HXc = HW - HD / 2
wood((HXc, HMID, HH - 0.02), (HD, H1 - H0, 0.04), 'walnut', tile=1.2)
wood((HXc, HMID, 0.20), (HD, H1 - H0, 0.03), 'walnut', tile=1.2)
for y in (H0 + 0.02, HMID, H1 - 0.02):
    wood((HXc, y, HH / 2 - 0.02), (HD, 0.04, HH - 0.04), 'walnut')
for y in (H0 + 0.12, H1 - 0.12):
    for sx in (-1, 1):
        tube('walnut', (HXc + sx * 0.17, y, 0.19), (HXc + sx * 0.19, y, 0), 0.025, 0.016, segs=6)
AMP_C = Vector((HXc + 0.02, HMID - 0.5, 0.32))
wood(AMP_C, (0.40, 0.84, 0.19), 'black')
card('amp', AMP_C + Vector((-0.201, 0, 0)), Wst, 0.84, 0.19)
books((HXc - 0.20, HMID + 0.06, 0.215), (0, 1, 0), (-1, 0, 0), 0.88, 0.33, 0.30)     # the records, on edge
TT = Vector((HXc - 0.01, HMID - 0.48, HH))
wood(TT + UP * 0.035, (0.40, 0.46, 0.07), 'oak')
lathe('black', [(0.155, 0.07), (0.155, 0.085)], TT, segs=24)
with part('Record', TT + UP * 0.09):
    card('record', TT + UP * 0.09, (0, 0, 1), 0.30, 0.30)
ARM = TT + Vector((0.16, 0.18, 0.07))
lathe('steel', [(0.02, 0.0), (0.02, 0.04)], ARM, segs=8, capt=True)
tube('steel', ARM + UP * 0.04, TT + Vector((-0.02, 0.09, 0.10)), 0.005, segs=4)
wood(TT + Vector((-0.03, 0.085, 0.098)), (0.03, 0.02, 0.012), 'black')
TAPE = Vector((HXc + 0.10, HMID + 0.52, HH))                           # the tape machine stands upright against the wall
wood(TAPE + UP * 0.26, (0.22, 0.50, 0.52), 'steel')
card('deck_face', TAPE + Vector((-0.111, 0, 0.12)), Wst, 0.46, 0.22)
REELS = []
for k, dy in enumerate((0.125, -0.125)):
    c = TAPE + Vector((-0.118, dy, 0.385))
    with part(f'Reel{k}', c):
        card('reel', c, Wst, 0.21, 0.21)
    REELS.append(f'Reel{k}')
tube('wire_brown', TAPE + Vector((-0.116, 0.125, 0.285)), TAPE + Vector((-0.116, -0.125, 0.285)), 0.004, segs=3)
SP0 = Vector((HW - 0.20, H0 - 0.30, 0))                                # the first: cloth and walnut, older than he is
wood(SP0 + UP * 0.38, (0.36, 0.48, 0.76), 'walnut')
card('speaker0', SP0 + Vector((-0.181, 0, 0.38)), Wst, 0.48, 0.76)
SP1 = Vector((HW - 0.20, H1 + 0.32, 0))                                # the second: black, two cones, loud
wood(SP1 + UP * 0.46, (0.34, 0.36, 0.92), 'black')
card('speaker1', SP1 + Vector((-0.171, 0, 0.46)), Wst, 0.36, 0.92)
SP2 = Vector((HXc + 0.02, HMID + 0.04, HH))                            # the third: small, pale, better than both, which is the disagreement
wood(SP2 + UP * 0.13, (0.15, 0.17, 0.26), 'c_white')
card('speaker2', SP2 + Vector((-0.076, 0, 0.13)), Wst, 0.17, 0.26)
WIRE_UP = Vector((TIES[1], 0.35, EAVE + 0.09))                         # all three lots go up over the tie beam and down again
for key, src, r in (('wire_brown', SP0 + Vector((0.0, 0.1, 0.76)), 0.006), ('wire_red', SP1 + Vector((0.0, -0.1, 0.92)), 0.005),
                    ('wire_clear', SP2 + Vector((0.03, 0.0, 0.26)), 0.003)):
    k = ('wire_brown', 'wire_red', 'wire_clear').index(key)
    over = WIRE_UP + Vector((0, 0.22 * (k - 1), 0))
    rope(key, sag(src, over, 0.25 + 0.1 * k, 12), r, segs=4)
    rope(key, sag(over, AMP_C + Vector((0.12, 0.3 - 0.15 * k, 0.10)), 0.9 - 0.2 * k, 14), r, segs=4)
sprite('things2', 7, (HW - 0.34, H1 + 0.86, 0), Wst, 0.42)             # more records, in their crate
frame(10, (RX, HMID - 0.42, 1.92), Wst, 0.50, 'oak')                   # the tin sign
frame(6, (RX, HMID + 0.38, 1.90), Wst, 0.52, 'walnut')                 # how a marsh balances itself
plant(4, (HW - 0.42, BACK - 0.42, 0), 1.55, 0.6)                       # papyrus in the corner
# A glass on a tripod at the right-hand window: observation.
TRI = Vector((2.72, BACK - 0.62, 0))
for k in range(3):
    a = math.pi / 2 + k * 2 * math.pi / 3
    tube('walnut', TRI + UP * 1.22, TRI + Vector((0.34 * math.cos(a), 0.34 * math.sin(a), 0)), 0.013, 0.016, segs=6)
lathe('brass', [(0.02, 1.22), (0.03, 1.26)], TRI, segs=8, capt=True)
tube('brass', TRI + Vector((0, -0.26, 1.28)), TRI + Vector((0, 0.10, 1.34)), 0.022, 0.03, segs=10, caps=True)
tube('brass', TRI + Vector((0, 0.10, 1.34)), TRI + Vector((0, 0.34, 1.38)), 0.036, 0.04, segs=10, caps=True)
plant(2, (3.0, BACK - 0.10, WINS[1][2] + 0.02), 0.34, 0.4)

# ════════════════════════════════════════════════════════════════════════
# The wall behind the camera: the pinboard, the books, the wall in studs
# ════════════════════════════════════════════════════════════════════════
log("front wall")
FY = FRONT + 0.014
frame(('pinboard', 1408 / 960), (-1.55, FY, 1.72), S, 1.70, 'oak', border=0.05)
frame(9, (0.42, FY, 1.90), S, 0.84, 'pine', border=0.03)               # the rig, drawn up
frame(7, (1.50, FY, 1.88), S, 0.60, 'walnut')                          # the marsh, charted
frame(0, (-0.18, FY, 1.22), S, 0.44, 'oak')                            # the porch, with Rex
frame(3, (0.42, FY, 1.22), S, 0.44, 'oak')                             # calibration day
frame(4, (1.02, FY, 1.22), S, 0.44, 'oak')                             # the crew
for k, z in enumerate((2.34, 2.44)):                                   # rods on their pegs, over everything
    tube('walnut' if k else 'black', (-0.5, FRONT + 0.06, z), (1.9, FRONT + 0.06, z + 0.02), 0.011, 0.004, segs=5)
    lathe('brass', [(0.0, -0.015), (0.03, -0.015), (0.03, 0.015), (0.0, 0.015)], (-0.32, FRONT + 0.07, z - 0.03), (0, 1, 0), segs=8)
for x in (-0.2, 1.4):
    wood((x, FRONT + 0.05, 2.36), (0.03, 0.10, 0.20), 'pine')
fairy(swags((-HW + 0.1, FRONT + 0.07, EAVE - 0.12), (STUDS[0] - 0.05, FRONT + 0.07, EAVE - 0.12), 6, 0.13), 0.15)
# Low shelves under the pictures: books, the flask, a sundew in its tin.
K0, K1, KD, KH = -0.35, 1.25, 0.28, 0.80
KM = (K0 + K1) / 2
with place((KM, FRONT + KD / 2, 0)):
    for sx in (-1, 1):
        wood((sx * (K1 - K0) / 2, 0, KH / 2), (0.025, KD, KH), 'pine')
    for z in (0.06, 0.43, KH):
        wood((0, 0, z), (K1 - K0, KD, 0.025), 'pine')
    books((-(K1 - K0) / 2 + 0.03, 0.02, 0.0725), (1, 0, 0), (0, 1, 0), K1 - K0 - 0.06, 0.30, 0.22)
    books((-(K1 - K0) / 2 + 0.03, 0.02, 0.4425), (1, 0, 0), (0, 1, 0), 0.9, 0.30, 0.22)
    pile(((K1 - K0) / 2 - 0.25, 0.0, 0.4425), (0, 1), 3, 0.2)
    plant(5, (-0.52, 0.0, KH + 0.0125), 0.28, 0.2)
    sprite('things', 6, (0.08, 0.0, KH + 0.0125), S, 0.25)
    sprite('things2', 2, (0.56, 0.0, KH + 0.0125), S, 0.26)             # a compass in its gimbals
sprite('things', 7, (-2.55, FRONT + 0.30, 0), S, 0.62)                 # charts, rolled, in their basket
# By the studs: a plank on two trestles, paint, the toolbox, the next boards.
T0, T1, TYc = 2.35, 3.55, FRONT + 0.62
wood(((T0 + T1) / 2, TYc, 0.72), (T1 - T0 + 0.3, 0.26, 0.035), 'pine', tile=1.4)
for x in (T0 + 0.1, T1 - 0.1):
    wood((x, TYc, 0.68), (0.06, 0.50, 0.05), 'pine')
    for sy in (-1, 1):
        beam('pine', (x, TYc + sy * 0.20, 0.66), (x, TYc + sy * 0.34, 0), 0.04, 0.05)
sprite('things', 4, (T0 + 0.30, TYc, 0.74), S, 0.34)
sprite('things', 5, (3.28, FRONT + 1.25, 0), (-0.5, 1, 0), 0.34)
for k in range(3):
    wood((2.95 + 0.02 * k, FRONT + 0.26, 0.012 + 0.024 * k), (1.3, 0.19, 0.022), 'pine', R=Matrix.Rotation(0.04 * k, 3, 'Z'), tile=1.4)

# ════════════════════════════════════════════════════════════════════════
# The middle of the room, and under the roof
# ════════════════════════════════════════════════════════════════════════
log("room")
card('rug', (0.0, -0.35, 0.006), (0, 0, 1), 2.7, 1.8, up=(0, 1, 0))
sprite('things', 3, (2.05, BACK - 0.24, 0), N, 0.50)                   # waders, inside the door
bulb(TIES[0], -1.9, EAVE - 0.08, 2.02)
bulb(TIES[1], -1.3, EAVE - 0.08, 2.06)
bulb(0.0, RIDGE_Y + 0.2, roof_z(RIDGE_Y + 0.2) - 0.16, 2.30, glow=1.3)
hanging(7, (TIES[0], 1.25, EAVE - 0.08), 0.60, drop=0.14)
# An oar and a coil of the oldest wire, kept up on the tie beams.
tube('pine', (TIES[0] - 0.1, -3.0, EAVE + 0.10), (TIES[1] + 0.3, -2.6, EAVE + 0.10), 0.02, segs=6)
wood((TIES[1] + 0.52, -2.57, EAVE + 0.10), (0.46, 0.13, 0.014), 'pine', R=Matrix.Rotation(0.1, 3, 'Z'))
rope('wire_brown', [Vector((TIES[0] + 0.02 + 0.13 * math.sin(a), 0.2 + 0.13 * math.cos(a), EAVE + 0.10 + 0.02 * (j % 3))) for j, a in
                    enumerate([2 * math.pi * j / 10 for j in range(31)])], 0.006, segs=4)
TWINKLE = fairy_bulbs()

# ════════════════════════════════════════════════════════════════════════
# Finalise; the navigation mesh: the den, the porch, the jetty and its landing
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
REEDS_OB = REEDS.build()
MOSS_OB = MOSS.build()
COLL = finalise('SalsHut')
I = INSET
WALK = [(-HW + I, HW - I, FRONT + I, BACK - I),
        (-DOOR_HW + I, DOOR_HW - I, BACK - I, BACK + SKIN + I),
        (-DX + I, DX - I, BACK + SKIN + I, DECK - I),
        (JX0 + I, JX1 - I, DECK - I, JEND + I),
        (PLAT[0] + I, PLAT[1] - I, PLAT[2] + I, PLAT[3] - I)]
FOOT = [                                                           # (x0, x1, y0, y1) of what stands on the boards
    (-HW, -HW + BD, B0, B1),                                            # workbench
    (CHAIR.x - 0.62, CHAIR.x + 0.80, CHAIR.y - 0.62, CHAIR.y + 0.55),   # the chair and its foot rest
    (SIDE.x - 0.26, SIDE.x + 0.26, SIDE.y - 0.26, SIDE.y + 0.26),       # its table
    (HW - CD, HW, C0, C1),                                              # drawers
    (HW - HD, HW, SP0.y - 0.26, SP1.y + 0.20),                          # the old loudspeaker, the console, the black one
    (HW - 0.60, HW, SP1.y + 0.20, BACK),                                # records, papyrus
    (TRI.x - 0.36, TRI.x + 0.36, TRI.y - 0.36, BACK),                   # the tripod
    (K0, K1, FRONT, FRONT + KD),                                        # low shelves
    (-2.85, -2.25, FRONT, FRONT + 0.6),                                 # chart basket
    (T0 - 0.2, HW, FRONT, FRONT + 1.0),                                 # the trestles and the plank
    (3.0, HW, FRONT + 1.0, FRONT + 1.5),                                # the toolbox
    (-2.95, -2.15, 4.1, 5.0), (-1.45, -0.65, 4.1, 5.0),                 # the porch chairs
    (CRATE.x - 0.25, CRATE.x + 0.25, CRATE.y - 0.25, CRATE.y + 0.25),   # the crate between them
    (POSTS[0] - 0.15, -2.0, BACK, AWN + 0.1),                           # the hammock's corner
    (-DX, -2.95, AWN, DECK),                                            # … and the dead end beyond the chairs, by the gate
    (BARREL.x - 0.36, DX, BACK, BARREL.y + 0.36),                       # rain barrel
    (TRAP.x - 0.40, TRAP.x + 0.40, BACK, TRAP.y + 0.22),                # eel trap
    *[(x - 0.08, x + 0.08, AWN - 0.20, AWN - 0.04) for x in POSTS[1:]], # the porch roof's posts
    (3.8, 4.3, DECK - 0.8, DECK),                                       # rope and anchor
    (BENCH.x - 0.7, BENCH.x + 0.7, BENCH.y - 0.2, BENCH.y + 0.2),       # the bench on the landing
    (3.35, 3.75, PLAT[2] + 0.25, PLAT[2] + 0.65),                       # the creel
]
navmesh('Hut-navmesh', COLL, WALK, [(a - I, b + I, c - I, d + I) for a, b, c, d in FOOT])

# ════════════════════════════════════════════════════════════════════════
# Animation: one loop
# ════════════════════════════════════════════════════════════════════════
log("animation")
LOOP = kit.LOOP
G = 9.81
# What hangs swings on its own length: 2π√(L/g), to the nearest count that divides the loop.
COUNTS = (0.75, 1.0, 1.2, 1.5, 1.8, 2.0, 2.25, 2.4, 3.0)
swing = lambda L: min(COUNTS, key=lambda c: abs(c - 2 * math.pi * math.sqrt(L / G)))
for k, (name, L) in enumerate(BULBS):
    T = swing(L)
    animate(PARTS[name], lambda t, k=k, T=T: {'rot': (math.radians(1.1) * W(T, 1.3 * k)(t), math.radians(0.8) * W(T, 1.0 + 0.7 * k)(t), 0)})
for k, (name, L) in enumerate(HANG):
    T = swing(L)
    animate(PARTS[name], lambda t, k=k, T=T: {'rot': (math.radians(2.0) * W(T, 2.0 * k)(t), math.radians(1.2) * W(T, 0.8 + k)(t),
                                                      math.radians(4) * W(9, k)(t))})
animate(PARTS['Chime'], lambda t: {'rot': (math.radians(3.0) * W(swing(0.35))(t) * (0.6 + 0.4 * W(12)(t)), math.radians(2.0) * W(swing(0.35), 1.2)(t), 0)})
animate(PARTS['Hammock'], lambda t: {'rot': about(ALONG, math.radians(2.6) * W(swing(0.6))(t) * (0.6 + 0.4 * W(18)(t)))})
for k, name in enumerate(LANTERNS):
    animate(PARTS[name], lambda t, k=k: {'scale': 1.0 + 0.07 * W(0.75, k)(t) * W(4, 1.0 + k)(t) + 0.04 * W(1.5, 2.0 * k)(t)})
# The tide clock: the pendulum beats once in a second and a half (its length says so), and each beat lets the
# wheel on by one spoke — twenty-four spokes, so once round to the loop.
BEAT = swing(PEND_L)


def tick(t):
    n, u = divmod(t / BEAT, 1.0)
    u = min(1.0, u / 0.22)
    return {'rot': (-2 * math.pi / SPOKES * (n + u * u * (3 - 2 * u)), 0, 0)}


animate(PARTS['Wheel'], tick)
animate(PARTS['Pendulum'], lambda t: {'rot': (math.radians(6.5) * W(BEAT)(t), 0, 0)})
# The record at 33⅓ turns a minute (1.8 s a turn); the reels at their two speeds, one filling, one emptying.
animate(PARTS['Record'], lambda t: {'rot': (0, 0, -2 * math.pi * t / 1.8)})
for k, name in enumerate(REELS):
    animate(PARTS[name], lambda t, k=k: {'rot': (2 * math.pi * t / (2.4, 3.6)[k], 0, 0)})
animate(PARTS['Gimbal'], lambda t: {'rot': (0, 0, 2 * math.pi * t / 4.0)})
animate_shapes(TRACE, lambda t: {'WaveA': math.cos(2 * math.pi * t / 1.5), 'WaveB': -math.sin(2 * math.pi * t / 1.5)})
for g, ob in enumerate(LEDS):
    animate_shapes(ob, lambda t, g=g: {'Dim': 1.0 if (t * (2.0, 3.0)[g] + 0.3 * g) % 1.0 < 0.35 else 0.0})
rising(0.24, 3.0)
twinkle(TWINKLE)
# The mast: the cups go round in what air there is; the light blinks once in three seconds.
animate(PARTS['Cups'], lambda t: {'rot': (0, 0, 2 * math.pi * t / 1.5)})
animate(PARTS['MastLight'], lambda t: {'scale': 1.0 if (t % 3.0) < 0.5 else 0.05})


def moth(k):
    """Round and round the lantern, never quite the same way up."""
    def fn(t):
        a = 2 * math.pi * t / (1.5, 2.0, 1.2)[k] * (1 if k % 2 else -1)
        return {'rot': (0.5 * math.sin(a * 0.5 + k), 0.4 * math.cos(a * 0.25), a), 'scale': (1.0, 0.3 + 0.7 * abs(math.sin(math.pi * t * 3)), 1.0)}
    return fn


for k, name in enumerate(MOTHS):
    animate(PARTS[name], moth(k))
# Out on the water. The reeds lean in a slow air and each stirs in its own; the moss the same, hanging.
for ob, k in ((REEDS_OB, 0), (MOSS_OB, 1)):
    animate_shapes(ob, lambda t, k=k: {'Sway': 0.5 * W(6, k)(t) + 0.3 * W(9, 1.0)(t) * W(4, 0.5)(t), 'Gust': 0.7 * W(4.5, 2.0 + k)(t) * (0.5 + 0.5 * W(18)(t))})
for g, ob in enumerate(GLINTS):
    animate_shapes(ob, lambda t, g=g: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / (2.0, 3.0, 4.5)[g] + 2.1 * g)})
for g, ob in enumerate(STARS):
    animate_shapes(ob, lambda t, g=g: {'Dim': 0.5 - 0.5 * math.sin(2 * math.pi * t / (1.5, 2.4, 4.0)[g] + 1.7 * g) * (0.5 + 0.5 * W(9, g)(t))})
# Fireflies: a flash of about half a second, every four to nine (the common firefly of a summer dusk flashes
# for half a second about every six); between flashes each one drifts.
FLASH = (4.0, 6.0, 4.5, 9.0, 6.0, 7.2, 4.5, 9.0, 6.0)


def firefly(g):
    def fn(t):
        x = (t + 0.77 * g * FLASH[g]) % FLASH[g]
        lit = x / 0.12 if x < 0.12 else max(0.0, 1 - (x - 0.12) / 0.5)
        return {'Dim': 1 - lit, 'DriftA': math.sin(2 * math.pi * t / (12, 18, 9)[g % 3] + g), 'DriftB': math.cos(2 * math.pi * t / (18, 12, 36)[g % 3] + 2 * g)}
    return fn


for g, ob in enumerate(FIREFLIES):
    animate_shapes(ob, firefly(g))
for k, (name, a) in enumerate(MISTS):
    tang = Vector((math.cos(a), -math.sin(a), 0))
    animate(PARTS[name], lambda t, k=k, tang=tang: {'loc': tuple(tang * 2.6 * W(36, 1.1 * k)(t)), 'scale': (1.0 + 0.10 * W(18, k)(t), 1.0, 1.0 + 0.12 * W(12, 2.0 * k)(t))})
for k, name in enumerate(FROGS):                                       # a frog sings in bursts: three or four calls, then it listens
    animate(PARTS[name], lambda t, k=k: {'scale': (1.0, 1.0, 1.0 + 0.07 * max(0.0, math.sin(2 * math.pi * t / 0.75)) * (1 if ((t + 2.5 * k) % 9) < 3 else 0))})
HERON_AX = Vector(facing_porch(HERON))
animate(PARTS['Heron'], lambda t: {'rot': about(HERON_AX, math.radians(4.0) * max(0.0, W(18, 1.0)(t)) ** 3 + math.radians(0.6) * W(6)(t))})
animate(PARTS['Turtle'], lambda t: {'loc': (0, 0, 0.008 * W(4.0)(t)), 'rot': about(facing_porch(TURTLE), math.radians(1.5) * W(6.0)(t))})
animate(PARTS['Skiff'], lambda t: {'loc': (0, 0, 0.010 * W(4.0)(t)), 'rot': (math.radians(0.6) * W(6.0, 1.0)(t), math.radians(1.4) * W(4.5)(t), 0)})


def beat(a, b):
    """From b along to a and back again, turning round behind the reeds at
    each end (the cut-outs are drawn heading left, and a is the left end
    as the porch sees it: on the way back they are turned about)."""
    def fn(t):
        u = (t / LOOP) % 1.0
        back = u >= 0.5
        k = min(1.0, max(0.0, ((u % 0.5) / 0.5 - 0.06) / 0.88))        # a pause out of sight at each end
        k = k * k * (3 - 2 * k)
        p = a.lerp(b, k) if back else b.lerp(a, k)
        return {'loc': tuple(p - b + UP * 0.006 * math.sin(2 * math.pi * t / 2.0)), 'rot': (0, 0, math.pi if back else 0.0)}
    return fn


animate(PARTS['Ducks'], beat(*DUCKS))
animate(PARTS['Gator'], beat(*GATOR))


def peek(t):
    """Twice to the loop the thing behind the far cypress leans out to
    look at the hut — a short look, then a longer one — and is back behind
    its tree quicker than it came."""
    out = 0.0
    for at, stay in ((8.0, 2.4), (25.0, 4.5)):
        x = t - at
        if 0 <= x < stay + 0.4:
            out = min(1.0, x / 0.7) if x < stay else 1 - (x - stay) / 0.4
    out = out * out * (3 - 2 * out)
    return {'loc': tuple(MON_R * 0.25 * out), 'rot': about(inward(MON_A), -(math.radians(20) + math.radians(1.0) * W(3.0)(t)) * out)}


animate(PARTS['Monster'], peek)


def egret(t):
    """Once round the marsh to the loop: about five metres a second, an egret's easy pace."""
    a = -2 * math.pi * t / LOOP
    p = out_at(a, EGRET_R, EGRET_Z + 0.6 * math.sin(2 * math.pi * t / 12))
    return {'loc': tuple(p - EGRET), 'rot': (0, 0, -a), 'scale': (1.0, 1.0, 0.45 + 0.55 * math.sin(2 * math.pi * t / 0.75) ** 2)}


animate(PARTS['Egret'], egret)


def dragonfly(k):
    """Hang, dart, hang: a new place every second and a half."""
    spots = [Vector((random.uniform(-0.9, 0.9), random.uniform(-0.6, 0.6), random.uniform(-0.2, 0.3))) for _ in range(6)]

    def fn(t):
        n, u = divmod((t + 0.4 * k) / 1.5, 1.0)
        a, b = spots[int(n) % 6], spots[(int(n) + 1) % 6]
        u = min(1.0, u / 0.18)
        p = a.lerp(b, u * u * (3 - 2 * u)) + Vector((0, 0, 0.012 * math.sin(2 * math.pi * t / 0.75)))
        return {'loc': tuple(p), 'scale': (1.0, 0.55 + 0.45 * abs(math.sin(math.pi * t * 6)), 1.0)}
    return fn


for k, name in enumerate(FLIES):
    animate(PARTS[name], dragonfly(k))
JUMP_AT, JUMP_FOR = 7.0, 0.75                                          # the fish: once every twelve seconds, where the door looks


def fish(t):
    x = (t % 12.0) - JUMP_AT
    if not 0 <= x <= JUMP_FOR:
        return {'loc': (0, 0, -0.3), 'rot': (0, 0, 0), 'scale': 0.001}
    u = x / JUMP_FOR
    return {'loc': (0.5 * u, 0, 0.42 * 4 * u * (1 - u) - 0.02), 'rot': about((0, 1, 0), -math.radians(60) * (1 - 2 * u)), 'scale': 1.0}


animate(PARTS['Fish'], fish)


def spread(every, at, life=3.0):
    """A ring going out from where the water was touched, then gone."""
    def fn(t):
        x = (t - at) % every
        return {'scale': 0.12 + 0.88 * (x / life) ** 0.6 if x < life else 0.001}
    return fn


animate(PARTS['Ring0'], spread(12.0, JUMP_AT + JUMP_FOR))
animate(PARTS['Ring1'], spread(9.0, 2.0))
animate(PARTS['Ring2'], spread(18.0, 11.0))
animate(PARTS['Ring3'], spread(12.0, 3.5))


def nibble(t):
    """The float rides the ripples; every eighteen seconds something tries the bait, twice, and thinks better of it."""
    x = t % 18.0
    dip = sum(math.exp(-((x - at) / 0.12) ** 2) for at in (12.0, 12.6))
    return {'loc': (0, 0, 0.006 * math.sin(2 * math.pi * t / 2.0) - 0.05 * dip)}


animate(PARTS['Float'], nibble)
animate(PARTS['RingFloat'], spread(18.0, 12.1, 2.5))


def lighthouse(t):
    """The lamp comes round every six seconds, as it does from Eve's window and Ara's."""
    u = (t % 6.0) / 6.0
    return {'scale': 0.22 + 0.85 * math.exp(-((u - 0.5) / 0.09) ** 2)}


animate(PARTS['LighthouseGlow'], lighthouse)

kit.export('sals_hut.glb', blend='blend' in argv[2:])
log("done")
