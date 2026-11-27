"""Paint the textures of Sal's Hut (step 1 of 2; build_sals_hut.py is step 2).

    python3 paint_textures.py <out_dir>

Runs with a system Python (numpy, Pillow, scipy), not Blender's. Wood, cloth,
the den's dials, screens, drawers and pinboard, the water and the small
things that fly are painted here; the pictures come from art/ (made with an
image generator) and none has a stand-in:
    marsh.jpg              the marsh at dusk all round the hut, 2:1, its
                           horizon level across the middle, nothing near
    rug.jpg                seen flat from above, edge to edge
    photo_*.jpg, crew.jpg, sal_tea.jpg, print_*.jpg, blueprint.jpg,
    poster_chum.jpg        the framed photographs and prints
and sheets of cut-outs on a flat magenta ground, 4 × 2 (trees.jpg: 3 × 1):
    creatures.jpg, flora.jpg, trees.jpg (side-on, whole to the waterline),
    pads.jpg (from straight above), plants.jpg, things.jpg, things2.jpg
and one cut-out alone: monster.jpg (from the front, cut off at the waist)
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import paint_kit as kit
from paint_kit import (INK, arr, art, atlas, boards, c8, canvas, centred, cover, down, fbm, font, glow, img, lampshade, linen,
                       note, paper, photo, pin, plaster, rng, save, spines, sprites, stick, weave, wisp, woodgrain)

kit.init(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'textures'), os.path.join(HERE, 'art'))

TEAL = (0.26, 0.46, 0.45)         # the paintwork: a faded marsh teal
ORANGE = (0.90, 0.50, 0.18)       # … and the orange of Sal's own hands
CREAM = (0.93, 0.88, 0.74)
MOSS = (0.36, 0.44, 0.24)
PICTURES = ['photo_porch', 'photo_father', 'photo_boat', 'photo_calib', 'crew', 'sal_tea',
            'print_foodweb', 'print_map', 'print_tides', 'blueprint', 'poster_chum']
# The marsh round the hut, as build_sals_hut.py sets it up (it reads these back from sprites.json):
# the picture bent in a half circle of this radius, laid again mirrored behind; the eye that far
# over the floor, the water that far under it; that much more sky carried above the picture's top.
RADIUS = 40.0
EYE = 1.5
WATER = -1.1
SKY = 0.25
DUSK = (0.66, 0.78, 0.90)         # what the hour does to anything out of doors


# ── Wood, metal, cloth ──────────────────────────────────────────────────
def siding(seed, colour, n=8, size=1024, vary=0.07):
    """Bare boards running up the picture: each its own tone, the grain
    along it, a knot here and there, a dark gap between."""
    r = rng(seed)
    bw = size // n
    a = np.zeros((size, size, 3), np.float32)
    for i in range(n):
        a[:, i * bw:(i + 1) * bw if i < n - 1 else size] = np.array(colour, np.float32) * (1 + r.normal(0, vary)) * (1 + r.normal(0, 0.02, 3))
    a *= (0.78 + 0.32 * fbm(size, size, 6, 220, 3, r) + 0.12 * fbm(size, size, 5, 5, 4, r))[..., None]
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    for _ in range(n + 2):
        cx, cy, rad = r.integers(0, size), r.integers(0, size), r.integers(6, 15)
        a *= (1 - 0.5 * np.exp(-(np.hypot(xx - cx, (yy - cy) / 1.8) / rad) ** 2))[..., None]
    for i in range(n):
        x = i * bw
        a[:, x:x + 3] *= 0.35
        a[:, x + 3:x + 5] *= 1.08
    return a


def tin(seed, size=512, n=12):
    """Corrugated sheet from underneath: galvanised, rusting where the rain sits."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    wave = 0.72 + 0.28 * np.sin(xx / size * 2 * math.pi * n)
    rust = np.clip(fbm(size, size, 5, 5, 4, r) * 1.8 - 0.75, 0, 1)[..., None]
    a = np.array((0.50, 0.54, 0.55), np.float32) * (1 - rust) + np.array((0.48, 0.28, 0.16), np.float32) * rust
    return a * (wave * (0.88 + 0.14 * fbm(size, size, 40, 4, 2, r)))[..., None]


def stripes(seed, size=256):
    """Hammock canvas: broad stripes running along the picture."""
    r = rng(seed)
    bands = [CREAM, ORANGE, CREAM, CREAM, TEAL, CREAM, ORANGE, CREAM, CREAM, TEAL, CREAM, CREAM, ORANGE, CREAM, TEAL, CREAM]
    a = np.zeros((size, size, 3), np.float32)
    for k, c in enumerate(bands):
        a[k * size // len(bands):(k + 1) * size // len(bands)] = c
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cloth = 0.86 + 0.07 * np.sin(xx * math.pi / 2) + 0.07 * np.sin(yy * math.pi / 2)
    return a * (cloth * (0.92 + 0.12 * fbm(size, size, 5, 5, 3, r)))[..., None]


def leather(seed, colour, size=256):
    r = rng(seed)
    big = fbm(size, size, 4, 4, 4, r)
    pore = fbm(size, size, 96, 96, 2, r)
    crease = np.clip(1 - np.abs(fbm(size, size, 9, 9, 3, r) - 0.5) * 40, 0, 1)
    return np.array(colour, np.float32) * (0.80 + 0.26 * big + 0.10 * (pore - 0.5) - 0.16 * crease)[..., None]


def slats(seed, colour, size=256, n=24):
    """A rolled blind's bamboo slats, running across the picture."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rod = 0.62 + 0.38 * np.abs(np.sin(yy / size * math.pi * n))
    return np.array(colour, np.float32) * (rod * (0.88 + 0.16 * fbm(size, size, 60, 3, 2, r)))[..., None]


# ── What glows, drifts and flies ────────────────────────────────────────
def mist(w=512, h=128):
    """A bank of mist lying on the water: thick in its middle, gone at every edge."""
    r = rng(60)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    body = np.clip(1 - ((yy / h - 0.55) / 0.45) ** 2, 0, 1) * np.clip(1 - ((xx / w - 0.5) / 0.5) ** 2, 0, 1) ** 0.7
    out = np.ones((h, w, 4), np.float32)
    out[..., :3] = MIST
    out[..., 3] = 0.55 * body * (0.35 + 0.65 * fbm(h, w, 3, 8, 4, r))
    return out


def ring(size=256):
    """Where something touched the water: two rings going out."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    out = np.ones((size, size, 4), np.float32)
    out[..., :3] = (0.72, 0.84, 0.92)
    out[..., 3] = 0.55 * np.exp(-((rr - 0.88) / 0.035) ** 2) + 0.35 * np.exp(-((rr - 0.55) / 0.03) ** 2)
    return out


def moon(size=256):
    """The moon a day past full, low and a little warm."""
    r = rng(61)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size * 0.46)
    seas = np.clip(fbm(size, size, 4, 4, 4, r) * 2.2 - 0.9, 0, 1)
    out = np.ones((size, size, 4), np.float32)
    out[..., :3] = np.array((1.0, 0.95, 0.82), np.float32) * (0.92 - 0.24 * seas + 0.06 * fbm(size, size, 30, 30, 2, r))[..., None]
    out[..., :3] *= (1 - 0.18 * np.clip(rr, 0, 1) ** 3)[..., None]
    out[..., 3] = np.clip((1 - rr) * size * 0.2, 0, 1)
    return out


def dragonfly(w=128, h=96):
    """A dragonfly from above: a blue needle of a body, four glassy wings."""
    im, d = canvas(w, h, (110, 140, 156, 0), 4)
    W, H = w * 4, h * 4
    for sy in (-1, 1):
        for x0, x1 in ((0.34, 0.48), (0.50, 0.64)):
            box = (W * x0, H / 2 + (sy * H * 0.46 if sy < 0 else H * 0.03), W * x1, H / 2 + (-H * 0.03 if sy < 0 else H * 0.46))
            d.ellipse(box, fill=(112, 142, 158, 255), outline=(50, 76, 92, 255), width=5)
    d.line((W * 0.10, H / 2, W * 0.62, H / 2), fill=(36, 104, 160, 255), width=16)
    d.ellipse((W * 0.56, H / 2 - 24, W * 0.70, H / 2 + 24), fill=(24, 70, 96, 255))
    return down(im, 4)


def moth(size=64):
    """A pale moth, wings spread, seen flat."""
    im, d = canvas(size, size, (236, 226, 200, 0), 4)
    S = size * 4
    for sx in (-1, 1):
        d.polygon([(S / 2, S * 0.30), (S / 2 + sx * S * 0.44, S * 0.14), (S / 2 + sx * S * 0.40, S * 0.56), (S / 2, S * 0.60)],
                  fill=(238, 228, 204, 255), outline=(110, 96, 80, 255))
        d.polygon([(S / 2, S * 0.56), (S / 2 + sx * S * 0.30, S * 0.58), (S / 2 + sx * S * 0.22, S * 0.86), (S / 2, S * 0.74)],
                  fill=(222, 208, 180, 255), outline=(110, 96, 80, 255))
    d.line((S / 2, S * 0.24, S / 2, S * 0.78), fill=(90, 76, 64, 255), width=14)
    return down(im, 4)


def fish(w=96, h=48):
    """A small silver fish, mid-leap."""
    im, d = canvas(w, h, (170, 190, 200, 0), 4)
    W, H = w * 4, h * 4
    d.ellipse((W * 0.20, H * 0.22, W * 0.92, H * 0.78), fill=(176, 196, 206, 255))
    d.ellipse((W * 0.24, H * 0.42, W * 0.90, H * 0.78), fill=(220, 230, 232, 255))
    d.polygon([(W * 0.26, H * 0.5), (W * 0.04, H * 0.14), (W * 0.04, H * 0.86)], fill=(150, 172, 184, 255))
    d.ellipse((W * 0.76, H * 0.36, W * 0.82, H * 0.48), fill=(30, 34, 40, 255))
    return down(im, 4)


def lighthouse(w=96, h=256):
    """The lighthouse on its headland, a long way off: a shape in the haze."""
    im, d = canvas(w, h, c8(HAZE, 0), 4)
    W, H = w * 4, h * 4
    shade = c8([v * 0.62 for v in HAZE])
    d.polygon([(W * 0.30, H), (W * 0.38, H * 0.24), (W * 0.62, H * 0.24), (W * 0.70, H)], fill=shade)
    d.rectangle((W * 0.30, H * 0.19, W * 0.70, H * 0.24), fill=shade)
    d.rectangle((W * 0.38, H * 0.10, W * 0.62, H * 0.19), fill=(250, 236, 190, 255))
    d.polygon([(W * 0.34, H * 0.10), (W * 0.5, H * 0.02), (W * 0.66, H * 0.10)], fill=shade)
    return down(im, 4)


def town(w=512, h=64):
    """The port town beyond the marsh: roofs in the haze, windows lit."""
    r = rng(62)
    im, d = canvas(w, h, c8(HAZE, 0), 2)
    W, H = w * 2, h * 2
    shade = c8([v * 0.66 for v in HAZE])
    x = W * 0.04
    while x < W * 0.96:
        bw, bh = r.integers(22, 60), r.integers(int(H * 0.2), int(H * 0.62)) * (1 - abs(x / W - 0.5) * 1.2)
        d.rectangle((x, H - bh, x + bw, H), fill=shade)
        if r.random() < 0.5:
            d.polygon([(x, H - bh), (x + bw / 2, H - bh - bw * 0.4), (x + bw, H - bh)], fill=shade)
        for _ in range(int(r.integers(0, 3))):
            wx, wy = x + r.integers(4, max(5, bw - 6)), H - r.integers(6, max(7, int(bh)))
            d.rectangle((wx, wy, wx + 5, wy + 6), fill=(255, 214, 140, 255))
        x += bw + r.integers(0, 10)
    return down(im, 2)


# ── The den's instruments ───────────────────────────────────────────────
def dial(size, face, draw):
    """A round instrument face: draw(d, S) on it, the corners cut away."""
    ss = 4
    im, d = canvas(size, size, face + (0,), ss)
    S = size * ss
    d.ellipse((2, 2, S - 2, S - 2), fill=face + (255,), outline=(120, 92, 48, 255), width=18)
    draw(d, S)
    return down(im, ss)


def ray(S, ang, r0, r1):
    """A line on a dial from r0 to r1 (fractions of its radius), ang clockwise from the top."""
    a = math.radians(ang)
    return (S / 2 + math.sin(a) * S / 2 * r0, S / 2 - math.cos(a) * S / 2 * r0, S / 2 + math.sin(a) * S / 2 * r1, S / 2 - math.cos(a) * S / 2 * r1)


def around(d, S, ang, rad, text, f, fill):
    """A word set on a dial at an angle, read from its middle."""
    a = math.radians(ang)
    tw = d.textlength(text, font=f)
    d.text((S / 2 + math.sin(a) * S / 2 * rad - tw / 2, S / 2 - math.cos(a) * S / 2 * rad - f.size / 2), text, font=f, fill=fill)


def barometer(size=256):
    """The barometer with opinions."""
    def draw(d, S):
        ink = INK + (255,)
        for k in range(41):
            ang = -120 + k * 6
            d.line(ray(S, ang, 0.80 if k % 5 else 0.74, 0.88), fill=ink, width=5 if k % 5 else 9)
        f = font(int(S * 0.046), 'b')
        for ang, rad, text in ((-104, 0.52, 'NO.'), (-58, 0.50, 'DOUBTFUL'), (0, 0.60, "WE'LL SEE"), (58, 0.54, 'FINE'), (104, 0.46, 'TOLD YOU')):
            around(d, S, ang, rad, text, f, ink)
        centred(d, S * 0.72, 'barometer', font(int(S * 0.05), 'i'), ink, S)
        d.line(ray(S, -30, -0.14, 0.70), fill=(150, 40, 36, 255), width=12)
        d.ellipse((S / 2 - 22, S / 2 - 22, S / 2 + 22, S / 2 + 22), fill=(120, 92, 48, 255))
    return dial(size, (240, 232, 208), draw)


def tide_dial(size=256):
    """The tide clock's face, as tide clocks are marked: high water at the
    top, low at the foot, the hours still to go counted down either side."""
    def draw(d, S):
        ink = (228, 236, 232, 255)
        centred(d, S * 0.10, 'HIGH', font(int(S * 0.085), 'b'), ink, S)
        centred(d, S * 0.80, 'LOW', font(int(S * 0.085), 'b'), ink, S)
        f = font(int(S * 0.075), 'b')
        for k in range(1, 6):
            around(d, S, 30 * k, 0.74, str(6 - k), f, ink)
            around(d, S, -30 * k, 0.74, str(k), f, ink)
        for k in range(12):
            d.line(ray(S, 30 * k, 0.86, 0.94), fill=ink, width=8)
        centred(d, S * 0.30, 'hours to', font(int(S * 0.045), 'i'), ink, S)
        around(d, S, 90, 0.44, 'falling', font(int(S * 0.045), 'i'), ink)
        around(d, S, -90, 0.44, 'rising', font(int(S * 0.045), 'i'), ink)
    return dial(size, (30, 62, 66), draw)


def screen_tide(w=512, h=320):
    """The tide, on a monitor: the week's water as the hut's own gauge reads it."""
    ss = 2
    im, d = canvas(w, h, (10, 22, 28, 255), ss)
    W, H = w * ss, h * ss
    cyan, dim, amber = (110, 226, 220, 255), (50, 96, 104, 255), (250, 190, 90, 255)
    d.text((24, 16), 'TIDE GAUGE · MARSH EDGE', font=font(34, 'b'), fill=cyan)
    d.text((W - 250, 22), 'live', font=font(28, 'i'), fill=amber)
    x0, x1, y0, y1 = 30, W - 30, 96, H - 150
    for k in range(8):
        x = x0 + (x1 - x0) * k / 7
        d.line((x, y0, x, y1), fill=dim, width=2)
    for k in range(5):
        y = y0 + (y1 - y0) * k / 4
        d.line((x0, y, x1, y), fill=dim, width=2)
    level = lambda u: 0.5 - 0.30 * math.sin(u * 2 * math.pi * 6.8) * (0.7 + 0.3 * math.sin(u * 2 * math.pi * 0.5)) - 0.10 * math.sin(u * 2 * math.pi * 13.1 + 1)
    pts = [(x0 + (x1 - x0) * k / 300, y0 + (y1 - y0) * level(k / 300)) for k in range(301)]
    d.line(pts[:182], fill=cyan, width=6)
    d.line(pts[181:], fill=dim, width=5)
    nx, ny = pts[181]
    d.line((nx, y0, nx, y1), fill=amber, width=3)
    d.ellipse((nx - 10, ny - 10, nx + 10, ny + 10), fill=amber)
    for k, (label, value) in enumerate((('now', '+0.42 m'), ('next low', '03:47'), ('next high', '10:19'), ('wander', 'yes'))):
        x = 30 + k * (W - 60) / 4
        d.text((x, H - 124), label, font=font(26, 'i'), fill=dim)
        d.text((x, H - 88), value, font=font(40, 'b'), fill=cyan)
    return down(im.convert('RGB'), ss)


def screen_work(w=512, h=320):
    """The other monitor: a balance sheet for the ship, and the old graph he
    keeps where he can see it."""
    ss = 2
    im, d = canvas(w, h, (16, 18, 24, 255), ss)
    W, H = w * ss, h * ss
    green, grey, amber, red = (130, 220, 140, 255), (120, 130, 140, 255), (250, 190, 90, 255), (240, 110, 90, 255)
    f = font(27)
    for k, (text, colour) in enumerate((('$ balance --ship rexmaw --run thursday', grey), ('ballast      3.2 t     ok', green),
                                        ('load         port +40    trim it', amber), ('weather      front, 19:00    beat it', green),
                                        ('             …or unload in the dark', grey), ('second-order effects: 2', amber),
                                        ('$ _', green))):
        d.text((24, 20 + k * 40), text, font=f, fill=colour)
    gx0, gy0, gx1, gy1 = W * 0.55, H * 0.56, W - 30, H - 56
    d.rectangle((gx0, gy0, gx1, gy1), outline=grey, width=2)
    days = [0.80, 0.82, 0.78, 0.66, 0.52, 0.40, 0.22, 0.10, 0.03]
    pts = [(gx0 + 20 + (gx1 - gx0 - 40) * k / 8, gy1 - 14 - (gy1 - gy0 - 30) * v) for k, v in enumerate(days)]
    d.line(pts, fill=red, width=6)
    for p in pts:
        d.ellipse((p[0] - 7, p[1] - 7, p[0] + 7, p[1] + 7), fill=red)
    d.text((gx0, gy1 + 8), 'one number · nine days', font=font(24, 'i'), fill=grey)
    return down(im.convert('RGB'), ss)


def scope_face(size=256):
    """An oscilloscope's screen: the graticule (the trace itself is built, and moves)."""
    im, d = canvas(size, size, (8, 26, 20, 255), 2)
    S = size * 2
    for k in range(1, 8):
        d.line((S * k / 8, 0, S * k / 8, S), fill=(30, 88, 66, 255), width=2 if k != 4 else 4)
        d.line((0, S * k / 8, S, S * k / 8), fill=(30, 88, 66, 255), width=2 if k != 4 else 4)
    return down(im.convert('RGB'), 2)


def keyboard(w=256, h=96):
    im, d = canvas(w, h, (44, 46, 50, 255), 4)
    W, H = w * 4, h * 4
    for j in range(4):
        for i in range(13):
            x, y = 14 + i * (W - 28) / 13 + j * 8, 14 + j * (H - 28) / 4
            d.rounded_rectangle((x, y, x + (W - 28) / 13 - 8, y + (H - 28) / 4 - 8), radius=8, fill=(214, 208, 190, 255))
    d.rounded_rectangle((W * 0.26, H * 0.775, W * 0.70, H * 0.93), radius=8, fill=(236, 150, 60, 255))
    return down(im.convert('RGB'), 4)


def speaker(kind, w=256, h=384):
    """Three generations of loudspeaker: a cloth-fronted wooden one, a black
    box with two cones, a small pale one with a light on it."""
    ss = 2
    W, H = w * ss, h * ss
    if kind == 0:
        im = img(woodgrain(70, (0.50, 0.32, 0.18))).resize((W, H), Image.LANCZOS).convert('RGBA')
        d = ImageDraw.Draw(im)
        d.rounded_rectangle((W * 0.12, H * 0.10, W * 0.88, H * 0.78), radius=60, fill=(196, 170, 120, 255), outline=(60, 38, 22, 255), width=10)
        for k in range(1, 12):
            d.line((W * 0.12 + (W * 0.76) * k / 12, H * 0.10, W * 0.12 + (W * 0.76) * k / 12, H * 0.78), fill=(160, 134, 90, 255), width=4)
        for k in (-1, 0, 1):
            d.arc((W * 0.20, H * 0.18 + k * 30, W * 0.80, H * 0.70 + k * 30), 200, 340, fill=(60, 38, 22, 255), width=12)
        d.ellipse((W * 0.42, H * 0.84, W * 0.58, H * 0.84 + W * 0.16), fill=(196, 160, 84, 255), outline=(60, 38, 22, 255), width=6)
    elif kind == 1:
        im, d = canvas(w, h, (26, 26, 30, 255), ss)
        for cy, rad in ((H * 0.24, W * 0.20), (H * 0.64, W * 0.38)):
            d.ellipse((W / 2 - rad, cy - rad, W / 2 + rad, cy + rad), fill=(52, 52, 58, 255), outline=(170, 172, 178, 255), width=12)
            d.ellipse((W / 2 - rad * 0.4, cy - rad * 0.4, W / 2 + rad * 0.4, cy + rad * 0.4), fill=(20, 20, 24, 255), outline=(80, 80, 88, 255), width=6)
        d.rectangle((W * 0.34, H * 0.92, W * 0.66, H * 0.955), fill=(170, 172, 178, 255))
    else:
        im, d = canvas(w, h, (226, 226, 220, 255), ss)
        d.rounded_rectangle((W * 0.10, H * 0.07, W * 0.90, H * 0.93), radius=70, fill=(204, 206, 200, 255))
        rad = W * 0.30
        d.ellipse((W / 2 - rad, H * 0.44 - rad, W / 2 + rad, H * 0.44 + rad), fill=(70, 74, 78, 255), outline=(240, 150, 60, 255), width=10)
        d.ellipse((W / 2 - 10, H * 0.84 - 10, W / 2 + 10, H * 0.84 + 10), fill=(110, 230, 150, 255))
    return down(im.convert('RGB'), ss)


def reel(size=256):
    """A tape reel: three windows in its flange, the tape wound on."""
    im, d = canvas(size, size, (190, 194, 198, 0), 4)
    S = size * 4
    d.ellipse((4, 4, S - 4, S - 4), fill=(196, 200, 204, 255), outline=(110, 114, 120, 255), width=10)
    d.ellipse((S * 0.14, S * 0.14, S * 0.86, S * 0.86), fill=(84, 54, 36, 255))
    for k in range(3):
        a = math.radians(90 + 120 * k)
        cx, cy = S / 2 + math.cos(a) * S * 0.27, S / 2 + math.sin(a) * S * 0.27
        d.ellipse((cx - S * 0.11, cy - S * 0.11, cx + S * 0.11, cy + S * 0.11), fill=(196, 200, 204, 255), outline=(110, 114, 120, 255), width=6)
    d.ellipse((S * 0.40, S * 0.40, S * 0.60, S * 0.60), fill=(40, 42, 46, 255), outline=(196, 200, 204, 255), width=10)
    return down(im, 4)


def record(size=256):
    """A record on the turntable: an orange label, the light caught across it."""
    r = rng(71)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    ang = np.arctan2(yy - size / 2, xx - size / 2)
    sheen = np.clip(np.cos(ang * 2 - 0.6), 0, 1) ** 8
    a = np.zeros((size, size, 4), np.float32)
    a[..., :3] = (0.05 + 0.03 * np.sin(rr * 260) + 0.22 * sheen)[..., None]
    lab = rr < 0.34
    a[lab, :3] = np.array(ORANGE, np.float32) * (0.9 + 0.1 * (np.sin(ang[lab] * 3) > 0))[..., None]
    a[rr < 0.03, :3] = 0.1
    a[..., 3] = (rr < 0.98).astype(np.float32)
    return a


def deck_face(size=256):
    """The tape machine's panel: two meters, a row of keys."""
    im, d = canvas(size, size, (176, 178, 176, 255), 2)
    S = size * 2
    for cx in (S * 0.28, S * 0.72):
        d.rounded_rectangle((cx - S * 0.19, S * 0.14, cx + S * 0.19, S * 0.48), radius=10, fill=(244, 232, 190, 255), outline=(50, 50, 54, 255), width=6)
        d.arc((cx - S * 0.14, S * 0.26, cx + S * 0.14, S * 0.62), 215, 325, fill=(50, 50, 54, 255), width=5)
        d.line((cx, S * 0.46, cx + S * 0.06, S * 0.24), fill=(190, 50, 46, 255), width=6)
    for k in range(5):
        x = S * (0.10 + 0.165 * k)
        d.rounded_rectangle((x, S * 0.66, x + S * 0.13, S * 0.88), radius=8, fill=((240, 150, 60, 255) if k == 2 else (60, 62, 66, 255)))
    return down(im.convert('RGB'), 2)


def amp_face(w=384, h=96):
    """The amplifier: a lit tuning strip, four knobs."""
    im, d = canvas(w, h, (40, 38, 36, 255), 2)
    W, H = w * 2, h * 2
    d.rounded_rectangle((W * 0.05, H * 0.16, W * 0.56, H * 0.52), radius=8, fill=(250, 214, 130, 255))
    for k in range(26):
        x = W * 0.07 + (W * 0.47) * k / 25
        d.line((x, H * 0.22, x, H * (0.40 if k % 5 else 0.48)), fill=(70, 50, 30, 255), width=3)
    d.line((W * 0.33, H * 0.16, W * 0.33, H * 0.52), fill=(200, 50, 40, 255), width=5)
    for k in range(4):
        cx = W * (0.64 + 0.095 * k)
        d.ellipse((cx - H * 0.20, H * 0.30, cx + H * 0.20, H * 0.70), fill=(190, 188, 180, 255), outline=(20, 20, 22, 255), width=5)
        d.line((cx, H * 0.50, cx + H * 0.12 * math.sin(k * 1.3), H * 0.50 - H * 0.16 * math.cos(k * 1.3)), fill=(20, 20, 22, 255), width=6)
    return down(im.convert('RGB'), 2)


def drawers(w=1024, h=832, cols=6, rows=5):
    """The wall of small drawers. Eleven are labelled, and one is labelled
    UNLABELED, which he maintains is accurate."""
    labels = {0: 'FUSES', 2: 'SPRINGS', 5: 'LENSES', 7: 'WIRE: OLD', 8: 'WIRE: OLDER', 9: 'WIRE: OLDEST', 13: 'HOOKS',
              16: 'BRASS', 20: 'TIDES', 23: 'SCREWS', 27: 'MAYBE', 15: 'UNLABELED'}
    r = rng(72)
    ss = 2
    im = img(woodgrain(73, (0.42, 0.28, 0.17), size=1024)).resize((w * ss, h * ss), Image.LANCZOS).convert('RGBA')
    d = ImageDraw.Draw(im)
    W, H = w * ss, h * ss
    cw, ch = W / cols, H / rows
    for j in range(rows):
        for i in range(cols):
            x, y = i * cw, j * ch
            tone = 0.86 + 0.24 * r.random()
            d.rectangle((x + 10, y + 10, x + cw - 10, y + ch - 10), fill=c8([min(1, v * tone) for v in (0.50, 0.34, 0.21)]), outline=(40, 26, 16, 255), width=6)
            d.line((x + 16, y + ch - 14, x + cw - 14, y + ch - 14), fill=(150, 108, 70, 255), width=4)
            d.rectangle((x + cw * 0.20, y + ch * 0.20, x + cw * 0.80, y + ch * 0.46), fill=(176, 136, 62, 255), outline=(90, 64, 26, 255), width=4)
            text = labels.get(j * cols + i)
            if text:
                d.rectangle((x + cw * 0.23, y + ch * 0.235, x + cw * 0.77, y + ch * 0.425), fill=(240, 232, 208, 255))
                f = font(int(ch * 0.115), 'b')
                centred(d, y + ch * 0.265, text, f, INK + (255,), cw, x)
            else:
                d.rectangle((x + cw * 0.23, y + ch * 0.235, x + cw * 0.77, y + ch * 0.425), fill=(120, 92, 44, 255))
            d.ellipse((x + cw / 2 - 20, y + ch * 0.60, x + cw / 2 + 20, y + ch * 0.60 + 40), fill=(196, 156, 76, 255), outline=(90, 64, 26, 255), width=4)
    return down(im.convert('RGB'), ss)


def pegboard(w=1024, h=512):
    """The tool board over the bench: every tool has its place, drawn round in white."""
    r = rng(74)
    a = np.array((0.60, 0.48, 0.32), np.float32) * (0.90 + 0.14 * fbm(h, w, 5, 5, 4, r))[..., None]
    a[12::24, 12::24] *= 0.35
    a[13::24, 12::24] *= 0.35
    a[12::24, 13::24] *= 0.35
    ss = 2
    im = img(a).resize((w * ss, h * ss), Image.LANCZOS).convert('RGBA')
    d = ImageDraw.Draw(im)
    steel, wood, white, dark = (188, 194, 200, 255), (150, 100, 56, 255), (244, 240, 226, 255), (34, 30, 28, 255)

    def bar(x0, y0, x1, y1, width, colour):
        """A tool's limb, on the outline that marks where it lives."""
        d.line((x0, y0, x1, y1), fill=white, width=width + 16)
        d.line((x0, y0, x1, y1), fill=colour, width=width)

    def blob(x, y, rad, colour):
        d.ellipse((x - rad - 8, y - rad - 8, x + rad + 8, y + rad + 8), fill=white)
        d.ellipse((x - rad, y - rad, x + rad, y + rad), fill=colour)

    bar(170, 150, 170, 560, 30, wood); bar(96, 130, 250, 130, 64, steel)                  # hammer
    for k in range(4):                                                                    # spanners, in order of size
        x, top = 400 + k * 110, 110 + k * 50
        bar(x, top, x, 560, 22 - 3 * k, steel)
        blob(x, top, 34 - 4 * k, steel); blob(x, 560, 26 - 3 * k, steel)
        d.ellipse((x - 14 + k, top - 14 + k, x + 14 - k, top + 14 - k), fill=white)
    d.polygon([(880, 170), (1560, 110), (1560, 300), (880, 280)], fill=white)             # the saw
    d.polygon([(894, 182), (1546, 126), (1546, 286), (894, 268)], fill=steel)
    for k in range(32):
        d.polygon([(900 + k * 20, 270 - k * 0.2), (910 + k * 20, 288), (920 + k * 20, 270)], fill=steel)
    blob(1640, 200, 96, wood)
    d.ellipse((1600, 160, 1680, 240), fill=white)
    for k, colour in enumerate(((236, 150, 60, 255), (66, 118, 114, 255), (190, 60, 50, 255), (226, 190, 70, 255))):   # screwdrivers
        x = 900 + k * 100
        bar(x, 620, x, 880, 12, steel)
        bar(x, 430, x, 620, 44, colour)
    bar(1340, 440, 1440, 880, 26, (236, 150, 60, 255)); bar(1460, 440, 1360, 880, 26, (236, 150, 60, 255))           # pliers
    bar(1380, 430, 1400, 560, 30, steel)
    d.rounded_rectangle((1580, 500, 1860, 780), radius=50, fill=white)                    # the tape measure
    d.rounded_rectangle((1594, 514, 1846, 766), radius=40, fill=(226, 190, 70, 255))
    d.ellipse((1660, 580, 1780, 700), fill=dark)
    bar(120, 700, 120, 900, 34, steel); bar(120, 900, 560, 900, 34, steel)                # the square
    bar(640, 720, 760, 720, 60, (190, 60, 50, 255))                                       # a level's stub of a brother
    return down(im.convert('RGB'), ss)


def tide_staff(w=64, h=512):
    """The tide gauge on its post: a tick every tenth of a metre, a red band where the porch gets wet."""
    im, d = canvas(w, h, (236, 232, 216, 255), 2)
    W, H = w * 2, h * 2
    d.rectangle((0, 0, W, H * 0.08), fill=(190, 50, 46, 255))
    for k in range(1, 25):
        y = H * k / 25
        d.rectangle((0, y, W * (0.75 if k % 5 == 0 else 0.4), y + 6), fill=(30, 30, 34, 255))
        if k % 5 == 0:
            d.text((W * 0.50, y - 44), str(25 - k), font=font(36, 'b'), fill=(30, 30, 34, 255))
    a = arr(down(im.convert('RGB'), 2))
    a[int(h * 0.72):] *= np.array((0.62, 0.72, 0.60), np.float32)      # weed, as far up as the water usually comes
    return a


def crate(size=256):
    """A crate from the grocer, who keeps them behind the counter."""
    im = img(siding(75, (0.62, 0.48, 0.30), n=4, size=size, vary=0.05)).rotate(90).convert('RGBA')
    d = ImageDraw.Draw(im)
    centred(d, size * 0.24, 'CHUM', font(int(size * 0.17), 'b'), (40, 60, 70, 255), size)
    centred(d, size * 0.47, 'CRUNCH', font(int(size * 0.17), 'b'), (40, 60, 70, 255), size)
    centred(d, size * 0.76, '24 BAGS · KEEP DRY', font(int(size * 0.07), 'b'), (40, 60, 70, 255), size)
    return im.convert('RGB')


def frog_file(w=256, h=336):
    """The frog file: his notes on non-frogs."""
    im = paper(w, h, 76, (0.84, 0.72, 0.48))
    d = ImageDraw.Draw(im)
    d.rectangle((24, 40, w - 24, 150), outline=INK, width=3)
    centred(d, 58, 'FROG FILE', font(30, 'b'), INK, w)
    centred(d, 104, '(non-frogs)', font(22, 'i'), INK, w)
    d.text((30, 190), 'Rex:', font=font(24, hand=True), fill=(40, 60, 120))
    d.text((30, 226), 'under review', font=font(24, hand=True), fill=(40, 60, 120))
    d.text((30, 262), '(year four)', font=font(24, hand=True), fill=(40, 60, 120))
    return im


def meadow(w=640, h=480):
    """The positioning rig's first reading, framed: the Rexmaw, four hundred yards inland."""
    r = rng(77)
    a = np.array((0.90, 0.86, 0.72), np.float32) * (0.92 + 0.12 * fbm(h, w, 6, 6, 4, r))[..., None]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    shore = 0.36 * w + 0.07 * w * np.sin(yy / h * 5.0) + 0.03 * w * np.sin(yy / h * 17.0 + 1)
    a[xx < shore] = a[xx < shore] * np.array((0.70, 0.86, 0.90), np.float32)
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    for k in range(1, 8):
        d.line((w * k / 8, 0, w * k / 8, h * 0.80), fill=(170, 160, 140), width=1)
    for k in range(1, 5):
        d.line((0, h * 0.80 * k / 5, w, h * 0.80 * k / 5), fill=(170, 160, 140), width=1)
    d.line([(shore[int(y), 0], y) for y in range(0, int(h * 0.80), 4)], fill=(60, 70, 80), width=3)
    d.text((40, 60), 'harbour', font=font(22, 'i'), fill=(60, 70, 80))
    d.text((w * 0.56, 40), 'meadow', font=font(22, 'i'), fill=(60, 70, 80))
    cx, cy = w * 0.66, h * 0.40
    d.line((cx - 18, cy - 18, cx + 18, cy + 18), fill=(190, 50, 46), width=6)
    d.line((cx - 18, cy + 18, cx + 18, cy - 18), fill=(190, 50, 46), width=6)
    d.text((cx + 28, cy - 16), 'REXMAW', font=font(24, 'b'), fill=(190, 50, 46))
    for bx, by in ((w * 0.50, h * 0.58), (w * 0.80, h * 0.62), (w * 0.86, h * 0.22)):       # the theoretical cows
        d.ellipse((bx - 20, by - 11, bx + 20, by + 11), outline=(60, 70, 80), width=3)
        d.ellipse((bx + 16, by - 16, bx + 32, by - 2), outline=(60, 70, 80), width=3)
        for lx in (-12, -4, 6, 14):
            d.line((bx + lx, by + 10, bx + lx, by + 24), fill=(60, 70, 80), width=3)
    d.rectangle((0, h * 0.80, w, h), fill=(244, 240, 226))
    centred(d, h * 0.835, 'First position.  The cows remember.', font(34, hand=True), (40, 60, 120), w)
    return im


def pinboard(w=1408, h=960):
    """The board on the den's front wall: the week's water, the two lists,
    and what the crew and the old pond have sent."""
    r = rng(78)
    cork = np.array((0.60, 0.44, 0.28), np.float32) * (0.80 + 0.30 * fbm(h, w, 90, 90, 3, r) + 0.12 * fbm(h, w, 6, 6, 3, r))[..., None]
    board = img(cork).convert('RGBA')
    blue = (40, 60, 120)
    tide = paper(300, 290, 80, (0.95, 0.95, 0.92))
    d = ImageDraw.Draw(tide)
    centred(d, 10, 'HIGH WATER', font(26, 'b'), INK, 300)
    centred(d, 42, 'marsh edge', font(20, 'i'), INK, 300)
    for k, t in enumerate(('Mon   03:47   17:02', 'Tue   05:19   16:11', 'Wed   04:02   19:36', 'Thu   06:58   18:05', 'Fri   05:31   20:44')):
        d.text((24, 78 + k * 34), t, font=font(22), fill=INK)
    d.text((40, 250), 'wanders.  good.', font=font(24, hand=True), fill=blue)
    stick(board, tide, 40, 40, -2.5)
    lists = paper(380, 330, 81, (0.96, 0.94, 0.86))
    d = ImageDraw.Draw(lists)
    d.text((24, 12), 'EXPECTED', font=font(24, 'b'), fill=INK)
    d.text((212, 12), 'ACTUAL', font=font(24, 'b'), fill=INK)
    d.line((196, 10, 196, 318), fill=INK, width=2)
    d.line((14, 48, 366, 48), fill=INK, width=2)
    for k, (a, b) in enumerate((('dam helps the', 'tadpoles in'), ('low pond', 'the pantry'), ('one number', 'nine days'),
                                ('rig: harbour', 'rig: meadow'), ('den: 2 weeks', 'den: year 4'), ('chair: done', 'chair: no. 41'))):
        d.text((20, 60 + k * 43), a, font=font(23, hand=True), fill=blue)
        d.text((208, 60 + k * 43), b, font=font(23, hand=True), fill=blue)
    stick(board, lists, 380, 30, 2.0)
    post = paper(270, 350, 82, (0.97, 0.97, 0.95))
    d = ImageDraw.Draw(post)
    centred(d, 30, 'POSTMORTEM', font(28, 'b'), INK, 270)
    d.line((40, 72, 230, 72), fill=INK, width=2)
    centred(d, 110, 'One', font(52, 'i'), INK, 270)
    centred(d, 168, 'Number', font(52, 'i'), INK, 270)
    for k, t in enumerate(('1. what I expected', '2. what happened', '3. why')):
        d.text((44, 250 + k * 28), t, font=font(20), fill=INK)
    stick(board, post, 800, 40, -3.0)
    stick(board, note(310, 150, 83, ['The lighthouse', 'agrees with me.       — L.'], (0.97, 0.95, 0.88), 27, hand=False), 1070, 50, 2.5)
    stick(board, note(290, 120, 84, ['The lighthouse', 'is signage.     — S.'], (0.98, 0.93, 0.62), 28), 1090, 215, -3.0)
    stick(board, note(330, 180, 85, ['Two Players, One Food Chain', 'Root cause: a mismatch', 'discovered in production.', 'Fix: photographs.'],
                      (0.95, 0.95, 0.93), 22, hand=False), 1050, 370, 2.0)
    todo = note(330, 300, 86, ['DEN — to do', 'shelf brackets:  2 weeks', 'wiring, 3rd lot:  2 weeks', 'label the drawer:  no',
                               'finish:  2 weeks'], (0.96, 0.93, 0.80), 27, rule=True)
    stick(board, todo, 40, 370, 2.5)
    sign = paper(300, 170, 87, (0.96, 0.82, 0.30))
    d = ImageDraw.Draw(sign)
    d.rectangle((8, 8, 292, 162), outline=INK, width=5)
    centred(d, 22, 'NO PATTING', font(42, 'b'), INK, 300)
    centred(d, 84, 'belly · head', font(28, 'i'), INK, 300)
    centred(d, 122, 'this means you', font(22), INK, 300)
    stick(board, sign, 420, 400, -2.0)
    stick(board, note(300, 130, 88, ['Run Thursday.', 'I have two bags.     — R'], (0.80, 0.90, 0.95), 27), 430, 610, 3.0)
    stick(board, note(300, 130, 89, ['Table fixed.', 'This never happened.  — E'], (0.97, 0.86, 0.84), 25), 760, 440, -2.5)
    stick(board, note(280, 130, 90, ['The bitter one.', 'For the porch.      — A'], (0.86, 0.94, 0.84), 26), 790, 610, 2.0)
    stick(board, note(320, 130, 91, ['Eels are fat this year.', 'Come and eat some.  — Moss'], (0.93, 0.90, 0.78), 24), 60, 720, -2.0)
    vote = paper(250, 190, 92, (0.95, 0.95, 0.93))
    d = ImageDraw.Draw(vote)
    d.rectangle((0, 0, 250, 62), fill=(190, 50, 46))
    centred(d, 6, 'VOTE PIP', font(40, 'b'), (250, 246, 236), 250)
    centred(d, 78, 'Pond Council', font(28, 'b'), INK, 250)
    centred(d, 126, "He'll talk you into it.", font(20, 'i'), INK, 250)
    stick(board, vote, 430, 760, 3.0)
    stick(board, note(310, 150, 93, ['Hut: half a degree', 'off level.  On purpose.', 'Leave it.'], (0.98, 0.93, 0.62), 25), 760, 780, -3.0)
    stick(board, photo('sal_tea', 190, 190, 12, 44), 1150, 640, 4.0)
    d = ImageDraw.Draw(board)
    for k, p in enumerate(((190, 54), (570, 44), (935, 54), (1225, 64), (1235, 228), (1215, 384), (205, 384), (570, 412), (580, 624),
                           (910, 452), (930, 622), (220, 732), (555, 772), (915, 792), (1255, 654))):
        pin(d, *p, colour=((190, 50, 46), (40, 90, 150), (220, 170, 40), (60, 130, 90))[k % 4])
    return board.convert('RGB')


# ── The marsh ───────────────────────────────────────────────────────────
def horizon_of(a):
    """How far down the picture its horizon is: the row about which its
    water mirrors its sky (where brightening going up matches brightening
    going down best)."""
    lum = a.mean(axis=2).mean(axis=1)
    H = len(lum)
    best = max(range(int(H * 0.44), int(H * 0.62)),
               key=lambda h: np.corrcoef(np.diff(lum[h - 200:h - 6][::-1]), np.diff(lum[h + 6:h + 200]))[0, 1])
    return best / H


def more_sky(low):
    """The picture with more sky over it: its top quarter turned over and
    laid above, melting into the plain colour of its top edge as it goes
    up — the colour of the lid over the view, so looking up finds no edge."""
    more = int(low.shape[0] * SKY)
    high = low[:6].mean(axis=(0, 1))
    k = np.linspace(1.0, 0.0, more, dtype=np.float32)[:, None, None]       # top of the strip … the seam
    k = k * k * (3 - 2 * k)
    return np.concatenate([low[:more][::-1] * (1 - k) + high * k, low]), high


def behind(low):
    """The half of the marsh behind the hut: the same picture (it is laid
    there mirrored), with the afterglow taken out of it — the west is one
    way only. Each row keeps its detail and takes the tone of the
    picture's own dim edges, so the two halves meet without a join."""
    wide = ndimage.gaussian_filter1d(low, low.shape[1] / 10, axis=1, mode='reflect')
    k = np.linspace(0.0, 1.0, low.shape[1], dtype=np.float32)[None, :, None]
    edges = wide[:, :1] * (1 - k) + wide[:, -1:] * k
    return np.clip(low * edges / np.maximum(wide, 1e-3), 0, 1)


def water(front, back, horizon, w=3072, h=768):
    """The water round the hut, as a disc: what it mirrors of the marsh,
    seen from the porch at eye height. Rows run from under the hut (top)
    out to the picture (bottom), as the square of the distance, so the
    near water gets most of the picture; columns run once round, from
    straight behind, through the left, the front and the right."""
    r = rng(63)
    front, back = (ndimage.gaussian_filter(p, (4, 8, 0)) for p in (front, back))     # water gives nothing back sharp
    rows, cols = front.shape[:2]
    s = (np.arange(h, dtype=np.float32) + 0.5) / h
    dist = RADIUS * s ** 2
    bearing = -math.pi + 2 * math.pi * (np.arange(w, dtype=np.float32) + 0.5) / w
    ripple = fbm(h, w, 48, 6, 3, r) - 0.5                                 # long ripples, lying across the line of sight
    up = RADIUS * (EYE - WATER) / np.maximum(dist, 0.5)[:, None] * (1 + 0.7 * ripple)   # how high on the picture each bit of water looks
    v = horizon - up / (RADIUS * math.pi / 2)                             # … as a fraction down the picture proper
    row = np.clip(((v + SKY) / (1 + SKY)) * (rows - 1), 0, rows - 1).astype(int)
    ahead = np.abs(bearing) <= math.pi / 2
    u = np.where(ahead, 0.5 + bearing / math.pi, 0.5 + (np.sign(bearing) * math.pi - bearing) / math.pi)
    col = np.clip(u * (cols - 1), 0, cols - 1).astype(int)
    seen = np.where(ahead[None, :, None], front[row, col[None, :]], back[row, col[None, :]])
    graze = (0.14 + 0.66 * s ** 2)[:, None, None]                         # water mirrors most where it is seen along
    deep = np.array((0.03, 0.085, 0.10), np.float32)
    out = ndimage.gaussian_filter(seen * graze + deep * (1 - graze), (2, 5, 0), mode=('nearest', 'wrap', 'nearest'))
    return out * (0.92 + 0.16 * fbm(h, w, 6, 24, 3, r))[..., None]


def dusk(sheet, k=1.0, haze=0.0):
    """A sheet of cut-outs as the hour shows them: cooled and dimmed, and
    for what stands far off, half gone into the haze."""
    a = arr(sheet)
    a[..., :3] = a[..., :3] * (1 - k + k * np.array(DUSK, np.float32) * 0.82)
    a[..., :3] = a[..., :3] * (1 - haze) + np.array(HAZE, np.float32) * haze
    return img(a)


# ── Go ──────────────────────────────────────────────────────────────────
view = arr(art('marsh'))                                               # at the size it was made: it is looked at closely
PIC_HORIZON = horizon_of(view)
rows_at = lambda v0, v1: view[int(view.shape[0] * (PIC_HORIZON + v0)):int(view.shape[0] * (PIC_HORIZON + v1))].mean(axis=(0, 1))
HAZE = tuple(float(v) for v in rows_at(-0.045, -0.010))                # the far treeline's colour: what distance turns things into
MIST = tuple(float(v) for v in rows_at(0.006, 0.020))                  # … and the mist lying under it
print(f'horizon {PIC_HORIZON:.4f}  haze {HAZE}', flush=True)
front, high = more_sky(view)
back, _ = more_sky(behind(view))
save('marsh', front)
save('marsh_back', img(back).resize((back.shape[1] // 2, back.shape[0] // 2), Image.LANCZOS))
save('high', np.tile(high, (8, 8, 1)))
save('water', water(front, back, PIC_HORIZON))
kit.SPRITES['marsh'] = {'horizon': PIC_HORIZON, 'radius': RADIUS, 'eye': EYE, 'water': WATER, 'sky': SKY}

a, n = boards(1, n=12, base=(0.44, 0.31, 0.20)); save('floor', a); save('floor_n', img(n).resize((1024, 1024), Image.LANCZOS))
a, n = boards(2, n=16, base=(0.47, 0.44, 0.39)); save('deck', img(a).resize((1024, 1024), Image.LANCZOS)); save('deck_n', img(n).resize((1024, 1024), Image.LANCZOS))
save('wall', siding(3, (0.62, 0.46, 0.29)))
save('ceiling', siding(4, (0.40, 0.30, 0.20), size=512, n=4))
save('tin', tin(5))
a = plaster(6, 256, (0.36, 0.30, 0.22))                                # building paper, lapped, where the boards are still to come
a[::64] *= 0.6
a[1::64] *= 1.15
save('tarpaper', a)
save('oak', woodgrain(7, (0.60, 0.43, 0.26)))
save('walnut', woodgrain(8, (0.36, 0.23, 0.15)))
save('beam', woodgrain(9, (0.31, 0.22, 0.15)))
save('pine', woodgrain(10, (0.84, 0.70, 0.48), depth=0.6))
save('drift', woodgrain(11, (0.47, 0.45, 0.41)))
save('pile', woodgrain(12, (0.20, 0.21, 0.17)))
save('teal_wood', woodgrain(13, TEAL, depth=0.35))
save('leather', leather(14, (0.55, 0.32, 0.17)))
for k, (name, colour) in enumerate((('orange', ORANGE), ('teal', TEAL), ('cream', CREAM), ('moss', MOSS))):
    save('linen_' + name, linen(20 + k, colour))
save('stripes', stripes(25))
save('basket', weave(26, (0.74, 0.58, 0.36)))
save('blind', slats(27, (0.70, 0.56, 0.34)))
save('shade', lampshade())
save('spines', spines(28))
save('drawers', drawers())
save('pegboard', pegboard())
save('screen_tide', screen_tide())
save('screen_work', screen_work())
save('scope', scope_face())
save('keyboard', keyboard())
for k in range(3):
    save(f'speaker{k}', speaker(k))
save('reel', reel())
save('record', record())
save('deck_face', deck_face())
save('amp', amp_face())
save('barometer', barometer())
save('tide_dial', tide_dial())
save('tide_staff', tide_staff())
save('crate', crate())
save('frog_file', frog_file())
save('meadow', meadow())
save('pinboard', pinboard())
save('mist', mist())
save('ring', ring())
save('moon', moon())
save('dragonfly', dragonfly())
save('moth', moth())
save('fish', fish())
save('lighthouse', lighthouse())
save('town', town())
save('steam', wisp())
save('glow', glow())
save('glow_soft', glow(colour=(1.0, 0.84, 0.58), power=1.5, peak=0.55))
save('glow_white', glow(colour=(1.0, 0.97, 0.86)))
save('glow_fly', glow(size=64, colour=(0.84, 1.0, 0.42), power=1.6))
save('glow_moon', glow(colour=(0.86, 0.90, 1.0), power=2.6, peak=0.42))
rug = art('rug')
save('rug', rug.crop((int(rug.width * 0.012), int(rug.height * 0.02), int(rug.width * 0.988), int(rug.height * 0.98))).resize((1024, 683), Image.LANCZOS))
save('pictures', atlas('pictures', [art(n) for n in PICTURES], 4, 512, bottom=False, pad=0.01))
for name, cols, cell, bottom, out_of_doors in (('creatures', 4, 512, True, 0.8), ('flora', 4, 448, True, 0.9), ('pads', 4, 320, False, 0.9),
                                               ('trees', 3, 768, True, 0.6), ('plants', 4, 448, True, 0), ('things', 4, 320, True, 0),
                                               ('things2', 4, 320, True, 0)):
    cells = sprites(name, cols, 2 if cols == 4 else 1)
    want = cols * (2 if cols == 4 else 1)
    if not cells or len(cells) != want:
        print(f'!! {name}: found {len(cells or [])} cut-outs, wanted {want}', flush=True)
        continue
    sheet = atlas(name, cells, cols, cell, bottom=bottom)
    save(name, dusk(sheet, out_of_doors) if out_of_doors else sheet)
    if name == 'trees':                                                # the same trees a long way off
        save('trees_far', dusk(sheet, 0.8, haze=0.55))
        b = arr(dusk(sheet, 0.6))                                      # … and what the water gives back of them: dim, soft
        b[..., :3] = b[..., :3] * 0.55 + np.array((0.02, 0.05, 0.06), np.float32)
        b[..., 3] *= 0.6
        save('trees_wake', img(b).filter(ImageFilter.GaussianBlur(2.5)))
save('monster', dusk(atlas('monster', sprites('monster', 1, 1), 1, 512, cell_h=1024), 0.8, haze=0.3))     # it stands a long way off
kit.save_sprites()
print('done', flush=True)
