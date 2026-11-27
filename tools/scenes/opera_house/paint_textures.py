"""Paint the Opera House scene's textures (step 1 of 2; build_opera_house.py is step 2).

    python3 paint_textures.py <out_dir>

Needs numpy and Pillow, so it runs with a system Python, not Blender's.
The surfaces, ornament and paper are painted here. The pictures come from
art/ (made with an image generator), and each has a painted stand-in used
when its file is missing:
    backdrop.jpg   the painted drop, 16:9
    ceiling.jpg    the ceiling fresco, square, a circle touching the edges
    ship.jpg       the ship flat, in profile, bow to the right   ┐ on a flat
    waves.jpg      one row of waves, edge to edge                │ magenta
    clouds.jpg     two cloud pieces, side by side                ┘ ground
and these sheets of cut-outs in a grid, on the same magenta ground, with no
stand-in (leave one out and that part of the scene is not built):
    audience1.jpg, audience2.jpg   4 × 3 opera-goers each, waist up
    musicians.jpg                  3 × 3 pit players, the conductor in the middle
    emotes.jpg                     4 × 3 reaction icons
    props.jpg                      4 × 2 set pieces
Needs scipy for the sheets.
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'textures')
os.makedirs(OUT, exist_ok=True)
FONTS = '/mnt/c/Windows/Fonts' if os.path.isdir('/mnt/c/Windows/Fonts') else 'C:/Windows/Fonts'


def font(size, style=''):
    for name in (f'georgia{style}.ttf', 'georgia.ttf', 'times.ttf'):
        try:
            return ImageFont.truetype(os.path.join(FONTS, name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def rng(seed):
    return np.random.default_rng(seed)


def vnoise(h, w, ch, cw, r):
    g = r.random((ch, cw)).astype(np.float32)
    ys = np.arange(h) * ch / h; xs = np.arange(w) * cw / w
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    fy = ys - y0; fx = xs - x0
    fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
    y1 = (y0 + 1) % ch; x1 = (x0 + 1) % cw
    a = g[y0][:, x0]; b = g[y0][:, x1]; c = g[y1][:, x0]; d = g[y1][:, x1]
    fx = fx[None, :]; fy = fy[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(h, w, ch, cw, octaves, r, p=0.5):
    tot = np.zeros((h, w), np.float32); amp = 1.0; s = 0.0
    for o in range(octaves):
        tot += amp * vnoise(h, w, min(h, ch * 2 ** o), min(w, cw * 2 ** o), r)
        s += amp; amp *= p
    return tot / s


def normal_from_height(ht, strength=2.0):
    dx = (np.roll(ht, -1, 1) - np.roll(ht, 1, 1)) * 0.5 * strength
    dy = (np.roll(ht, 1, 0) - np.roll(ht, -1, 0)) * 0.5 * strength     # image rows run downwards
    n = np.stack([-dx, -dy, np.ones_like(ht)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def arr(im):
    return np.asarray(im, np.float32) / 255.0


def img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def save(name, a):
    im = a if isinstance(a, Image.Image) else img(a)
    im.save(os.path.join(OUT, name + '.png'))
    print('painted', name, im.size, im.mode, flush=True)


def canvas(w, h, colour, ss=2):
    """A supersampled RGBA canvas and its pen."""
    im = Image.new('RGBA', (w * ss, h * ss), colour)
    return im, ImageDraw.Draw(im)


def down(im, ss=2):
    return im.resize((im.width // ss, im.height // ss), Image.LANCZOS)


def c8(c, a=255):
    return tuple(int(round(v * 255)) for v in c) + (a,)


GOLD = (0.86, 0.66, 0.28)
GOLD_HI = (1.0, 0.90, 0.58)
GOLD_LO = (0.50, 0.33, 0.10)
CREAM = (0.93, 0.88, 0.76)
CRIMSON = (0.62, 0.07, 0.10)


# ── Plain surfaces ──────────────────────────────────────────────────────
def boards(seed, size=2048, n=20, base=(0.66, 0.50, 0.32)):
    """Stage boards running along image y. Returns (albedo, normal)."""
    r = rng(seed)
    bw = size // n
    col = np.zeros((size, size, 3), np.float32)
    ht = np.ones((size, size), np.float32)
    grain = fbm(size, size, 6, 256, 3, r)                     # streaks along y
    fine = np.sin(np.arange(size, dtype=np.float32)[None, :] * 1.7 + fbm(size, size, 4, 40, 2, r) * 50) * 0.5 + 0.5
    base = np.array(base, np.float32)
    for i in range(n):
        x0, x1 = i * bw, (i + 1) * bw if i < n - 1 else size
        cuts = [0] + sorted(int(c) for c in r.integers(40, size - 40, size=2)) + [size]
        for a, b in zip(cuts[:-1], cuts[1:]):
            c = base * (1 + r.normal(0, 0.07)) * (1 + r.normal(0, 0.025, 3))
            col[a:b, x0:x1] = c
            ht[a:a + 2, x0:x1] = 0.55                         # butt joint
            for nx in (x0 + bw // 4, x1 - bw // 4):           # nail heads
                col[a + 9:a + 13, nx:nx + 4] *= 0.45
        ht[:, x0:x0 + 2] = 0.35; ht[:, x1 - 1:x1] = 0.35      # seams
    col *= (0.82 + 0.3 * grain)[..., None] * (0.93 + 0.1 * fine)[..., None]
    wear = fbm(size, size, 5, 5, 4, r)                        # traffic: paler where feet go
    col = col * (0.86 + 0.28 * wear)[..., None] + 0.03 * (wear[..., None] - 0.5)
    scuff = np.clip(fbm(size, size, 24, 24, 3, r) - 0.62, 0, 1) * 2.2
    col *= (1 - 0.45 * scuff)[..., None]
    col *= (0.45 + 0.55 * ht)[..., None]
    return col, normal_from_height(ht + 0.05 * grain, 3.0)


def velvet(seed, colour, size=512):
    r = rng(seed)
    nap = fbm(size, size, 4, 128, 3, r)
    soft = fbm(size, size, 6, 6, 3, r)
    c = np.array(colour, np.float32)
    return c * (0.78 + 0.3 * nap + 0.18 * soft)[..., None]


def velvet_folds(seed, colour, w=512, h=1024):
    """Velvet hanging in folds — one fold to the picture's width, and it
    repeats across and down. Shade in each hollow, the pile's pale sheen
    where the cloth turns away from the eye, a fold that wanders a little
    on its way down. The crest is at three quarters across, to sit on the
    crest of the pleat it is laid over (build_opera_house.py, drape)."""
    r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    f = xx / w + 0.05 * np.sin(2 * np.pi * yy / h + 1.0) + 0.02 * np.sin(6 * np.pi * yy / h + 2.2)
    front = 0.5 - 0.5 * np.sin(2 * np.pi * f)                 # 1 on the crest, 0 in the hollow
    turn = np.abs(np.cos(2 * np.pi * f))                      # 1 on the fold's flanks
    shade = 0.26 + 0.64 * front ** 0.8 + 0.30 * turn ** 4 * (0.35 + 0.65 * front)
    nap = fbm(h, w, 4, 96, 3, r)                              # streaks along the fall
    soft = fbm(h, w, 6, 4, 3, r)
    a = np.array(colour, np.float32) * (shade * (0.86 + 0.20 * nap + 0.12 * soft))[..., None]
    return a + np.array((0.07, 0.09, 0.13), np.float32) * (turn ** 6 * front)[..., None]


def gold_leaf(seed, size=512):
    r = rng(seed)
    leaf = fbm(size, size, 10, 10, 4, r)
    speck = np.clip(fbm(size, size, 96, 96, 2, r) - 0.55, 0, 1) * 1.5
    c = np.array(GOLD, np.float32) * (0.78 + 0.45 * leaf)[..., None]
    c = c * (1 - 0.35 * speck)[..., None] + np.array((0.25, 0.05, 0.02), np.float32) * (0.2 * speck)[..., None]
    return c


def plaster(seed, size=1024, colour=CREAM):
    r = rng(seed)
    m = fbm(size, size, 5, 5, 5, r)
    f = fbm(size, size, 80, 80, 2, r)
    return np.array(colour, np.float32) * (0.86 + 0.2 * m + 0.06 * f)[..., None]


def brick(seed, size=1024, rows=16):
    """Painted-over brickwork. Returns (albedo, normal)."""
    r = rng(seed)
    rh = size // rows
    bw = rh * 3
    col = np.zeros((size, size, 3), np.float32)
    ht = np.ones((size, size), np.float32)
    for j in range(rows):
        off = (j % 2) * bw // 2
        for i in range(-1, size // bw + 1):
            x0 = i * bw + off; x1 = x0 + bw
            a, b = max(0, x0), min(size, x1)
            if a >= b:
                continue
            col[j * rh:(j + 1) * rh, a:b] = np.array((0.30, 0.27, 0.26), np.float32) * (1 + r.normal(0, 0.12))
            ht[j * rh:(j + 1) * rh, max(0, x0):max(0, x0) + 3] = 0.3
        ht[j * rh:j * rh + 3, :] = 0.3
    grime = fbm(size, size, 6, 6, 4, r)
    col *= (0.7 + 0.5 * grime)[..., None]
    col = col * (0.55 + 0.45 * ht)[..., None] + (1 - ht)[..., None] * 0.05
    return col, normal_from_height(ht, 2.5)


def carpet(seed, size=512):
    r = rng(seed)
    n = fbm(size, size, 64, 64, 2, r)
    m = fbm(size, size, 4, 4, 3, r)
    return np.array((0.50, 0.08, 0.10), np.float32) * (0.8 + 0.25 * n + 0.15 * m)[..., None]


# ── Ornament ────────────────────────────────────────────────────────────
def emboss(d, shape, pts, width=None, ss=2, lift=3):
    """A gilt relief: shadow below, body, highlight above."""
    for dy, colour in ((lift, GOLD_LO), (0, GOLD), (-lift // 2 - 1, None)):
        p = [(x, y + dy * ss) for x, y in pts]
        if colour is None:
            continue
        if shape == 'line':
            d.line(p, fill=c8(colour), width=width, joint='curve')
        elif shape == 'poly':
            d.polygon(p, fill=c8(colour))
        else:
            (x0, y0), (x1, y1) = p
            d.ellipse((x0, y0, x1, y1), fill=c8(colour))
    if shape == 'line':
        d.line([(x, y - width * 0.22) for x, y in pts], fill=c8(GOLD_HI), width=max(1, width // 4), joint='curve')
    elif shape == 'ellipse':
        (x0, y0), (x1, y1) = pts
        d.ellipse((x0 + (x1 - x0) * 0.2, y0 + (y1 - y0) * 0.12, x1 - (x1 - x0) * 0.4, y0 + (y1 - y0) * 0.5),
                  fill=c8(GOLD_HI))


def beads(d, x0, x1, y, r, ss=2):
    n = int((x1 - x0) / (r * 2.6))
    for k in range(n):
        cx = x0 + (k + 0.5) * (x1 - x0) / n
        emboss(d, 'ellipse', [(cx - r, y - r), (cx + r, y + r)], ss=ss, lift=1)


def moulding(d, x0, x1, y0, y1, ss=2):
    """A gilt band with a shaded profile."""
    h = y1 - y0
    for k in range(int(h)):
        t = k / max(1, h - 1)
        s = 0.5 + 0.5 * math.sin(t * math.pi * 3 - 0.6)
        c = [lo + (hi - lo) * s for lo, hi in zip(GOLD_LO, GOLD_HI)]
        d.line([(x0, y0 + k), (x1, y0 + k)], fill=c8(c))


def leaf_chain(d, pts, size, ss=2):
    """Laurel leaves along a path."""
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        a = math.atan2(y1 - y0, x1 - x0)
        for side in (-1, 1):
            b = a + side * 0.6
            cx = (x0 + x1) / 2 + math.cos(b) * size * 0.6
            cy = (y0 + y1) / 2 + math.sin(b) * size * 0.6
            p = [(cx + math.cos(b) * size, cy + math.sin(b) * size),
                 (cx + math.cos(b + 1.57) * size * 0.35, cy + math.sin(b + 1.57) * size * 0.35),
                 (cx - math.cos(b) * size, cy - math.sin(b) * size),
                 (cx - math.cos(b + 1.57) * size * 0.35, cy - math.sin(b + 1.57) * size * 0.35)]
            emboss(d, 'poly', p, ss=ss, lift=2)


def tier_front(seed, w=2048, h=512):
    """One bay of a balcony front: cream panel, gilt mouldings, a laurel
    swag between rosettes, a cartouche. Returns (albedo, glow)."""
    ss = 2
    im, d = canvas(w, h, c8(CREAM), ss)
    W, H = w * ss, h * ss
    moulding(d, 0, W, 0, int(H * 0.10))
    moulding(d, 0, W, int(H * 0.86), H)
    beads(d, 0, W, H * 0.135, H * 0.022)
    beads(d, 0, W, H * 0.83, H * 0.018)
    # panel line
    d.rounded_rectangle((W * 0.07, H * 0.2, W * 0.93, H * 0.76), radius=H * 0.06, outline=c8(GOLD_LO), width=6)
    d.rounded_rectangle((W * 0.07, H * 0.2 - 4, W * 0.93, H * 0.76 - 4), radius=H * 0.06, outline=c8(GOLD), width=5)
    # swags: two catenaries from the rosettes at the bay's ends to the cartouche
    for a, b in ((0.0, 0.42), (1.0, 0.58)):
        pts = []
        for k in range(25):
            t = k / 24
            x = (a + (b - a) * t) * W
            y = H * (0.30 + 0.30 * 4 * t * (1 - t) * 0.9 + 0.06 * t)
            pts.append((x, y))
        emboss(d, 'line', pts, width=int(H * 0.035), ss=ss)
        leaf_chain(d, pts[::2], H * 0.045, ss)
    for cx in (0.0, 1.0):                                    # rosettes, split across the seam
        for rr, colr in ((0.11, None), (0.06, None)):
            emboss(d, 'ellipse', [(cx * W - rr * H, H * 0.30 - rr * H), (cx * W + rr * H, H * 0.30 + rr * H)], ss=ss)
        for k in range(8):
            a = k * math.pi / 4
            px, py = cx * W + math.cos(a) * H * 0.15, H * 0.30 + math.sin(a) * H * 0.15
            emboss(d, 'ellipse', [(px - H * 0.04, py - H * 0.04), (px + H * 0.04, py + H * 0.04)], ss=ss, lift=2)
    # cartouche: oval shield with a lyre
    cx, cy = W * 0.5, H * 0.49
    emboss(d, 'ellipse', [(cx - H * 0.26, cy - H * 0.24), (cx + H * 0.26, cy + H * 0.24)], ss=ss, lift=5)
    d.ellipse((cx - H * 0.20, cy - H * 0.18, cx + H * 0.20, cy + H * 0.18), fill=c8((0.55, 0.10, 0.12)))
    for sgn in (-1, 1):
        arm = [(cx + sgn * H * 0.03, cy + H * 0.11), (cx + sgn * H * 0.10, cy + H * 0.02),
               (cx + sgn * H * 0.09, cy - H * 0.08), (cx + sgn * H * 0.05, cy - H * 0.12)]
        emboss(d, 'line', arm, width=int(H * 0.022), ss=ss, lift=2)
    for k in (-1, 0, 1):
        d.line([(cx + k * H * 0.025, cy - H * 0.09), (cx + k * H * 0.025, cy + H * 0.10)], fill=c8(GOLD_HI), width=3)
    emboss(d, 'line', [(cx - H * 0.07, cy - H * 0.09), (cx + H * 0.07, cy - H * 0.09)], width=int(H * 0.02), ss=ss, lift=2)
    for sgn in (-1, 1):                                      # scrolls beside the shield
        pts = [(cx + sgn * H * (0.28 + 0.10 * t + 0.05 * math.sin(t * 6)), cy + H * (0.16 * math.cos(t * 5) * (1 - t)))
               for t in np.linspace(0, 1, 20)]
        emboss(d, 'line', pts, width=int(H * 0.025), ss=ss, lift=2)
    a = arr(down(im.convert('RGB'), ss))
    r = rng(seed)
    a *= (0.9 + 0.16 * fbm(h, w, 4, 12, 4, r))[..., None]
    # Glow: the sconces sit on the columns at the bay's ends, at the top.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pool = np.zeros((h, w), np.float32)
    for cx in (0, w):
        d2 = ((xx - cx) / (w * 0.22)) ** 2 + ((yy - h * 0.05) / (h * 0.75)) ** 2
        pool += np.exp(-d2 * 1.6)
    glow = a * (0.20 + 0.75 * np.clip(pool, 0, 1))[..., None] * np.array((1.0, 0.86, 0.66), np.float32)
    return a, glow


def damask_tile(seed, w=256, h=384):
    ss = 2
    base = (0.47, 0.07, 0.09)
    lite = (0.60, 0.13, 0.13)
    im, d = canvas(w, h, c8(base), ss)
    W, H = w * ss, h * ss
    for ox, oy in ((0, 0), (W / 2, H / 2), (-W / 2, H / 2), (W / 2, -H / 2), (-W / 2, -H / 2), (0, H), (0, -H), (W, 0), (-W, 0)):
        cx, cy = W / 2 + ox, H / 2 + oy
        left = [(cx - W * 0.42 * math.sin(math.pi * t) ** 0.8, cy - H * 0.48 + H * 0.96 * t) for t in np.linspace(0, 1, 30)]
        right = [(2 * cx - x, y) for x, y in left]
        d.line(left, fill=c8(lite), width=5, joint='curve')
        d.line(right, fill=c8(lite), width=5, joint='curve')
        for k in range(6):                                   # flower
            a = k * math.pi / 3
            px, py = cx + math.cos(a) * W * 0.13, cy + math.sin(a) * W * 0.13
            d.ellipse((px - W * 0.075, py - W * 0.075, px + W * 0.075, py + W * 0.075), fill=c8(lite))
        d.ellipse((cx - W * 0.06, cy - W * 0.06, cx + W * 0.06, cy + W * 0.06), fill=c8(base))
        for sgn in (-1, 1):                                  # leaves above and below
            for side in (-1, 1):
                px, py = cx + side * W * 0.12, cy + sgn * H * 0.25
                d.ellipse((px - W * 0.05, py - H * 0.07, px + W * 0.05, py + H * 0.07), fill=c8(lite))
            d.ellipse((cx - W * 0.035, cy + sgn * H * 0.36 - H * 0.05, cx + W * 0.035, cy + sgn * H * 0.36 + H * 0.05), fill=c8(lite))
    return down(im.convert('RGB'), ss)


def box_wall(seed, w=1024, h=1024):
    """One bay of the wall behind a tier: damask, a wainscot, the box's
    door, gilt pilasters at the bay's ends."""
    ss = 2
    tile = damask_tile(seed)
    im = Image.new('RGB', (w, h))
    for y in range(0, h, tile.height // 2):
        for x in range(0, w, tile.width // 2):
            im.paste(tile.resize((tile.width // 2, tile.height // 2), Image.LANCZOS), (x, y))
    im = im.resize((w * ss, h * ss), Image.LANCZOS).convert('RGBA')
    d = ImageDraw.Draw(im)
    W, H = w * ss, h * ss
    d.rectangle((0, H * 0.70, W, H), fill=c8((0.30, 0.16, 0.09)))          # wainscot
    for k in range(4):
        x0 = W * (0.06 + k * 0.235)
        d.rectangle((x0, H * 0.75, x0 + W * 0.18, H * 0.95), outline=c8((0.16, 0.08, 0.04)), width=8)
        d.rectangle((x0 + 6, H * 0.75 + 6, x0 + W * 0.18 + 6, H * 0.95 + 6), outline=c8((0.42, 0.24, 0.13)), width=3)
    moulding(d, 0, W, int(H * 0.685), int(H * 0.715))
    # door
    dx0, dx1, dy0 = W * 0.36, W * 0.64, H * 0.16
    d.rectangle((dx0 - 14, dy0 - 14, dx1 + 14, H), fill=c8(GOLD_LO))
    d.rectangle((dx0 - 8, dy0 - 8, dx1 + 8, H), fill=c8(GOLD))
    d.rectangle((dx0, dy0, dx1, H), fill=c8((0.26, 0.12, 0.07)))
    for (a, b) in ((0.20, 0.52), (0.57, 0.95)):
        d.rectangle((dx0 + W * 0.03, H * a, dx1 - W * 0.03, H * b), outline=c8((0.13, 0.06, 0.03)), width=8)
        d.rectangle((dx0 + W * 0.03 + 6, H * a + 6, dx1 - W * 0.03 + 6, H * b + 6), outline=c8((0.40, 0.21, 0.12)), width=3)
    emboss(d, 'ellipse', [(dx1 - W * 0.05, H * 0.55), (dx1 - W * 0.025, H * 0.55 + W * 0.025)], ss=ss, lift=2)
    for x0, x1 in ((0, W * 0.045), (W * 0.955, W)):                         # pilasters
        moulding(d, 0, H, 0, 1)                                             # (keeps the pen warm)
        for k in range(int(x1 - x0)):
            t = k / max(1, x1 - x0 - 1)
            s = 0.5 + 0.5 * math.sin(t * math.pi * 2 + 0.5)
            c = [lo + (hi - lo) * s for lo, hi in zip(GOLD_LO, GOLD_HI)]
            d.line([(x0 + k, 0), (x0 + k, H)], fill=c8(c))
    moulding(d, 0, W, 0, int(H * 0.035))
    a = arr(down(im.convert('RGB'), ss))
    a *= (0.88 + 0.2 * fbm(h, w, 5, 5, 4, rng(seed)))[..., None]
    return a


def cartouche(w=512, h=512):
    """The emblem over the proscenium: a gilt shield with a lyre and laurel."""
    ss = 2
    im, d = canvas(w, h, (0, 0, 0, 0), ss)
    W, H = w * ss, h * ss
    cx, cy = W / 2, H * 0.5
    for sgn in (-1, 1):                                                     # laurel sprays
        pts = [(cx + sgn * W * (0.10 + 0.36 * math.sin(t * 1.9)), cy + H * (0.40 - 0.66 * t)) for t in np.linspace(0, 1, 16)]
        emboss(d, 'line', pts, width=int(W * 0.02), ss=ss)
        leaf_chain(d, pts, W * 0.05, ss)
    emboss(d, 'ellipse', [(cx - W * 0.27, cy - H * 0.33), (cx + W * 0.27, cy + H * 0.33)], ss=ss, lift=8)
    d.ellipse((cx - W * 0.22, cy - H * 0.28, cx + W * 0.22, cy + H * 0.28), fill=c8((0.55, 0.10, 0.12)))
    for sgn in (-1, 1):
        arm = [(cx + sgn * W * 0.03, cy + H * 0.16), (cx + sgn * W * 0.13, cy + H * 0.04),
               (cx + sgn * W * 0.12, cy - H * 0.11), (cx + sgn * W * 0.06, cy - H * 0.18)]
        emboss(d, 'line', arm, width=int(W * 0.03), ss=ss)
    for k in (-1.5, -0.5, 0.5, 1.5):
        d.line([(cx + k * W * 0.03, cy - H * 0.14), (cx + k * W * 0.03, cy + H * 0.15)], fill=c8(GOLD_HI), width=5)
    emboss(d, 'line', [(cx - W * 0.09, cy - H * 0.14), (cx + W * 0.09, cy - H * 0.14)], width=int(W * 0.026), ss=ss)
    emboss(d, 'ellipse', [(cx - W * 0.07, cy - H * 0.47), (cx + W * 0.07, cy - H * 0.33)], ss=ss)   # crown knob
    return down(im, ss)


# ── Scenery ─────────────────────────────────────────────────────────────
def paint_noise(a, seed, amount=0.16):
    """Brush texture over a painted flat."""
    h, w = a.shape[:2]
    r = rng(seed)
    n = fbm(h, w, 40, 10, 3, r) * 0.6 + fbm(h, w, 6, 6, 3, r) * 0.4
    a[..., :3] *= (1 - amount + 2 * amount * n)[..., None]
    return a


def waves(seed, base, crest, w=2048, h=256, n=9):
    """A row of painted waves (a groundrow): transparent above the crests."""
    ss = 2
    im, d = canvas(w, h, (0, 0, 0, 0), ss)
    W, H = w * ss, h * ss
    r = rng(seed)
    top = []
    for k in range(W + 1):
        t = (k / W * n) % 1.0
        swell = (0.5 - 0.5 * math.cos(2 * math.pi * (t + 0.10 * math.sin(2 * math.pi * t)))) ** 1.4
        top.append(H * (0.62 - 0.50 * swell))
    for k in range(W):                                                       # body, column by column
        y0 = top[k]
        d.line([(k, y0), (k, H)], fill=c8(base))
    a = arr(down(im, ss))
    yy = np.mgrid[0:h, 0:w][0].astype(np.float32)
    tp = np.array(top[::ss][:w], np.float32)[None, :] / ss
    depth = np.clip((yy - tp) / (h * 0.55), 0, 1)                            # 0 at the crest
    body = np.array(base, np.float32)[None, None] * (1.25 - 0.55 * depth)[..., None]
    foam = np.clip(1 - (yy - tp) / (h * 0.07), 0, 1) ** 1.5
    body = body * (1 - foam[..., None]) + np.array(crest, np.float32) * foam[..., None]
    # curling strokes under each crest
    xx = np.mgrid[0:h, 0:w][1].astype(np.float32)
    stroke = 0.5 + 0.5 * np.sin((yy - tp) * 0.22 + np.sin(xx * 2 * math.pi * n / w) * 2.5)
    body *= (0.90 + 0.16 * stroke * (1 - depth))[..., None]
    edge = np.clip(1 - np.abs(yy - tp - 1.5) / 2.5, 0, 1) * 0.0
    a[..., :3] = body * (1 - edge[..., None])
    a = paint_noise(a, seed)
    return a


def ship(w=1024, h=1024):
    """The ship flat: a three-master in profile, bow to the right, cut out."""
    ss = 2
    im, d = canvas(w, h, (0, 0, 0, 0), ss)
    W, H = w * ss, h * ss
    X = lambda u: u * W
    Y = lambda v: (1 - v) * H                                                 # v up
    hull = (0.20, 0.13, 0.09); wale = (0.60, 0.13, 0.10); ochre = (0.80, 0.60, 0.26)
    sail = (0.93, 0.88, 0.76); spar = (0.36, 0.24, 0.14); line = (0.16, 0.11, 0.08)
    # rigging first (behind sails)
    masts = [(0.30, 0.74), (0.50, 0.92), (0.69, 0.80)]
    for mx, top in masts:
        d.line([(X(mx), Y(0.20)), (X(mx), Y(top))], fill=c8(spar), width=int(W * 0.012))
        for sgn in (-1, 1):
            for k in (0.07, 0.10):
                d.line([(X(mx), Y(top - 0.06)), (X(mx + sgn * k), Y(0.24))], fill=c8(line), width=3)
    d.line([(X(0.76), Y(0.26)), (X(0.97), Y(0.36))], fill=c8(spar), width=int(W * 0.010))      # bowsprit
    for a, b in (((0.69, 0.80), (0.97, 0.36)), ((0.69, 0.66), (0.90, 0.33)), ((0.50, 0.92), (0.69, 0.80)),
                 ((0.30, 0.74), (0.50, 0.92)), ((0.30, 0.74), (0.10, 0.30))):
        d.line([(X(a[0]), Y(a[1])), (X(b[0]), Y(b[1]))], fill=c8(line), width=3)
    # jibs
    for p in ([(0.71, 0.74), (0.93, 0.37), (0.71, 0.36)], [(0.71, 0.62), (0.86, 0.35), (0.71, 0.34)]):
        d.polygon([(X(u), Y(v)) for u, v in p], fill=c8(sail), outline=c8(line))
    # square sails, slightly bellied
    for mx, top in masts:
        levels = [(0.27, top - 0.33, 0.115), (top - 0.31, top - 0.14, 0.092), (top - 0.12, top - 0.02, 0.066)]
        for v0, v1, hw in levels:
            if v1 - v0 < 0.06:
                continue
            pts = [(mx - hw, v1), (mx + hw, v1)]
            pts += [(mx + hw * (1.0 + 0.10 * math.sin(math.pi * t)), v1 + (v0 - v1) * t) for t in np.linspace(0, 1, 9)]
            pts += [(mx + hw - 2 * hw * t, v0 - 0.012 * math.sin(math.pi * t)) for t in np.linspace(0, 1, 9)]
            pts += [(mx - hw * (1.0 - 0.06 * math.sin(math.pi * t)), v0 + (v1 - v0) * t) for t in np.linspace(0, 1, 9)]
            d.polygon([(X(u), Y(v)) for u, v in pts], fill=c8(sail), outline=c8(line))
            for k in (-0.5, 0, 0.5):                                            # seams
                d.line([(X(mx + k * hw), Y(v1)), (X(mx + k * hw * 1.05), Y(v0))], fill=c8((0.78, 0.72, 0.60)), width=3)
            d.line([(X(mx - hw * 1.08), Y(v1)), (X(mx + hw * 1.08), Y(v1))], fill=c8(spar), width=int(W * 0.008))
    # spanker on the mizzen (stern, left)
    d.polygon([(X(u), Y(v)) for u, v in ((0.29, 0.56), (0.29, 0.29), (0.12, 0.31), (0.16, 0.62))], fill=c8(sail), outline=c8(line))
    # pennant
    d.polygon([(X(0.50), Y(0.955)), (X(0.50), Y(0.925)), (X(0.40), Y(0.935))], fill=c8((0.75, 0.12, 0.10)))
    # hull: stern castle on the left, sheer rising to the bow
    deck = [(0.08, 0.34), (0.10, 0.345), (0.24, 0.345), (0.25, 0.285), (0.62, 0.262), (0.70, 0.27),
            (0.71, 0.305), (0.80, 0.315), (0.86, 0.30)]
    keel = [(0.82, 0.14), (0.60, 0.10), (0.30, 0.10), (0.13, 0.13), (0.07, 0.24)]
    d.polygon([(X(u), Y(v)) for u, v in deck + keel], fill=c8(hull))
    wl = [(u, v - 0.035) for u, v in deck]                                      # red bulwark band under the rail
    d.polygon([(X(u), Y(v)) for u, v in deck + wl[::-1]], fill=c8(wale))
    d.line([(X(u), Y(v)) for u, v in deck], fill=c8(ochre), width=int(W * 0.007), joint='curve')
    d.line([(X(u), Y(v - 0.075)) for u, v in deck[1:]], fill=c8(ochre), width=int(W * 0.004), joint='curve')
    for u in np.linspace(0.30, 0.62, 6):                                        # gunports
        d.rectangle((X(u), Y(0.215), X(u + 0.024), Y(0.190)), fill=c8(ochre), outline=c8(line))
    for u in (0.13, 0.18):                                                      # stern windows, lit
        d.rectangle((X(u), Y(0.305), X(u + 0.03), Y(0.265)), fill=c8((1.0, 0.82, 0.42)), outline=c8(ochre), width=3)
    d.ellipse((X(0.055), Y(0.40), X(0.085), Y(0.36)), fill=c8((1.0, 0.85, 0.45)), outline=c8(ochre), width=3)  # stern lantern
    a = arr(down(im, ss))
    # painter's shading: light from the right, darker toward the stern and the keel
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a[..., :3] *= (0.80 + 0.28 * (xx / w))[..., None] * (0.88 + 0.16 * (1 - yy / h))[..., None]
    a = paint_noise(a, 5, 0.12)
    a[..., 3] = (a[..., 3] > 0.5).astype(np.float32)
    return a


def clouds(seed, w=1024, h=512):
    """A hanging cloud piece, lit from below, cut out."""
    r = rng(seed)
    ss = 2
    m, d = canvas(w, h, (0, 0, 0, 0), ss)
    W, H = w * ss, h * ss
    blobs = []
    for k in range(9):
        t = k / 8
        cx = W * (0.14 + 0.72 * t)
        rad = H * (0.20 + 0.16 * math.sin(math.pi * t) + 0.05 * r.random())
        cy = H * (0.60 - 0.14 * math.sin(math.pi * t)) - rad * 0.15 * r.random()
        blobs.append((cx, cy, rad))
        d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=(255, 255, 255, 255))
    d.rectangle((W * 0.12, H * 0.60, W * 0.88, H * 0.74), fill=(255, 255, 255, 255))
    d.ellipse((W * 0.06, H * 0.52, W * 0.30, H * 0.78), fill=(255, 255, 255, 255))
    d.ellipse((W * 0.70, H * 0.52, W * 0.94, H * 0.78), fill=(255, 255, 255, 255))
    alpha = arr(down(m, ss))[..., 3]
    yy = np.mgrid[0:h, 0:w][0].astype(np.float32) / h
    soft = arr(img(alpha).filter(ImageFilter.GaussianBlur(18)))
    topc = np.array((0.80, 0.74, 0.84), np.float32); lowc = np.array((1.0, 0.80, 0.60), np.float32)
    t = np.clip((yy - 0.25) / 0.5, 0, 1)[..., None]
    col = topc * (1 - t) + lowc * t
    col *= (0.72 + 0.34 * soft)[..., None]                                        # darker toward the edge
    out = np.dstack([col, alpha])
    out = paint_noise(out, seed, 0.10)
    out[..., 3] = (alpha > 0.5).astype(np.float32)
    return out


def glow(size=128, colour=(1.0, 0.86, 0.60)):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    a = np.clip(1 - rr, 0, 1) ** 2.2
    out = np.zeros((size, size, 4), np.float32)
    out[..., :3] = colour
    out[..., 3] = a
    return out


def ramp(t, stops):
    """Colour along a gradient: stops = [(position, rgb), ...], t an array."""
    out = np.zeros(t.shape + (3,), np.float32)
    for (p0, c0), (p1, c1) in zip(stops[:-1], stops[1:]):
        k = np.clip((t - p0) / (p1 - p0), 0, 1)
        k = (k * k * (3 - 2 * k))[..., None]
        seg = np.array(c0, np.float32) * (1 - k) + np.array(c1, np.float32) * k
        out = np.where(((t >= p0) & (t <= p1))[..., None], seg, out)
    out = np.where((t < stops[0][0])[..., None], np.array(stops[0][1], np.float32), out)
    return np.where((t > stops[-1][0])[..., None], np.array(stops[-1][1], np.float32), out)


def art(name, w, h):
    """A picture supplied in art/ (made with an image generator, say), or None."""
    for ext in ('.jpg', '.png'):
        p = os.path.join(HERE, 'art', name + ext)
        if os.path.exists(p):
            return Image.open(p).convert('RGB').resize((w, h), Image.LANCZOS)
    return None


def keyed(name):
    """A cut-out supplied in art/, painted on a flat magenta ground: the
    picture as RGBA with the ground keyed out, or None. The ground is
    wherever red and blue both stand well clear of green; the edge is
    drawn in a little so no pink fringe is left."""
    p = os.path.join(HERE, 'art', name + '.jpg')
    if not os.path.exists(p):
        return None
    a = arr(Image.open(p).convert('RGB'))
    # The ground's own colour is read off the top edge; reds, pinks and
    # purples in the picture differ from it in blue or in green.
    top = a[:6].reshape(-1, 3)
    b0, b1 = top[:, 2].min() - 0.14, top[:, 2].max() + 0.14
    ground = (a[..., 0] > 0.68) & (a[..., 1] < 0.22) & (a[..., 2] > b0) & (a[..., 2] < b1)
    alpha = img((~ground).astype(np.float32)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(0.8))
    return np.dstack([a, arr(alpha)])


SPRITES = {}        # written out as sprites.json: where each cut-out sits in its atlas, and its shape


def sprites(name, cols, rows):
    """The cut-outs on a sheet from art/ laid out as a grid, in reading
    order: every painted piece goes to the cell its centre falls in."""
    from scipy import ndimage
    a = keyed(name)
    if a is None:
        return None
    solid = a[..., 3] > 0.5
    labels, n = ndimage.label(ndimage.binary_dilation(solid, iterations=6))
    H, W = solid.shape
    boxes = {}
    for sl in ndimage.find_objects(labels):
        ys, xs = sl
        if (ys.stop - ys.start) * (xs.stop - xs.start) < 400:
            continue
        cell = (min(rows - 1, (ys.start + ys.stop) * rows // (2 * H)), min(cols - 1, (xs.start + xs.stop) * cols // (2 * W)))
        b = boxes.get(cell)
        boxes[cell] = (ys.start, ys.stop, xs.start, xs.stop) if b is None else \
            (min(b[0], ys.start), max(b[1], ys.stop), min(b[2], xs.start), max(b[3], xs.stop))
    return [a[b[0]:b[1], b[2]:b[3]] for _, b in sorted(boxes.items())]


def atlas(name, cells, cols, cell_px, bottom=True, pad=0.06):
    """Lay cut-outs out in a grid texture and note where each landed."""
    rows = -(-len(cells) // cols)
    out = Image.new('RGBA', (cols * cell_px, rows * cell_px), (0, 0, 0, 0))
    inner = int(cell_px * (1 - 2 * pad))
    notes = []
    for k, c in enumerate(cells):
        src = Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
        s = min(inner / src.width, inner / src.height)
        src = src.resize((max(1, int(src.width * s)), max(1, int(src.height * s))), Image.LANCZOS)
        cx, cy = (k % cols) * cell_px, (k // cols) * cell_px
        x = cx + (cell_px - src.width) // 2
        y = cy + (cell_px - int(cell_px * pad) - src.height if bottom else (cell_px - src.height) // 2)
        out.paste(src, (x, y))
        notes.append({'u0': x / out.width, 'u1': (x + src.width) / out.width,
                      'v0': 1 - (y + src.height) / out.height, 'v1': 1 - y / out.height,
                      'aspect': src.width / src.height})
    SPRITES[name] = notes
    return solid_under(out)


def backs(im, level=0.36):
    """The same figures seen from behind in a dim house: their outlines, in shade."""
    a = arr(im)
    grey = a[..., :3].mean(axis=-1, keepdims=True)
    a[..., :3] = arr(img((a[..., :3] * 0.45 + grey * 0.55) * level).filter(ImageFilter.GaussianBlur(3)))
    return img(a).resize((im.width // 2, im.height // 2), Image.LANCZOS)


def bbox(a, floor=0.5):
    ys, xs = np.where(a[..., 3] > floor)
    return xs.min(), xs.max() + 1, ys.min(), ys.max() + 1


def fit(a, w, h, bottom=True):
    """A keyed picture's content, scaled to fill a w×h canvas (centred, and
    standing on the bottom edge), alpha cut hard."""
    x0, x1, y0, y1 = bbox(a)
    src = Image.fromarray((np.clip(a[y0:y1, x0:x1], 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    k = min(w / src.width, h / src.height)
    src = src.resize((max(1, int(src.width * k)), max(1, int(src.height * k))), Image.LANCZOS)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.paste(src, ((w - src.width) // 2, h - src.height if bottom else (h - src.height) // 2))
    return out


def solid_under(im):
    """Carry each cut-out's edge colour out under its transparent part, so
    the cut line never samples black."""
    a = arr(im)
    rgb = img(a[..., :3] * a[..., 3:4]).filter(ImageFilter.GaussianBlur(6))
    wt = img(a[..., 3]).filter(ImageFilter.GaussianBlur(6))
    spread = arr(rgb) / np.maximum(arr(wt), 1e-3)[..., None]
    a[..., :3] = np.where(a[..., 3:4] > 0.5, a[..., :3], np.clip(spread, 0, 1))
    return img(a)


def ship_art(size=1024):
    a = keyed('ship')
    return None if a is None else solid_under(fit(a, size, size))


def waves_art(tint, mirror, w=2048, h=256):
    """The wave row from art/: the strip and its mirror image side by side,
    so it repeats without a seam. Each of the machine's rows gets its own tint."""
    a = keyed('waves')
    if a is None:
        return None
    x0, x1, y0, y1 = bbox(a)
    strip = Image.fromarray((np.clip(a[y0:, :], 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    flip = strip.transpose(Image.FLIP_LEFT_RIGHT)
    pair = Image.new('RGBA', (strip.width * 2, strip.height))
    pair.paste(flip if mirror else strip, (0, 0)); pair.paste(strip if mirror else flip, (strip.width, 0))
    out = arr(solid_under(pair.resize((w, h), Image.LANCZOS)))
    out[..., :3] *= np.array(tint, np.float32)
    return out


def clouds_art(w=1024, h=512):
    """The two cloud pieces from art/, split at the gap between them."""
    a = keyed('clouds')
    if a is None:
        return None
    cols = (a[..., 3] > 0.5).any(axis=0)
    mid = a.shape[1] // 2
    gap = [x for x in range(mid - a.shape[1] // 4, mid + a.shape[1] // 4) if not cols[x]]
    cut = gap[len(gap) // 2] if gap else mid
    return [solid_under(fit(part, w, h, bottom=False)) for part in (a[:, :cut], a[:, cut:])]


def backdrop(w=2048, h=1152):
    """The painted drop: a harbour bay at dusk, a lighthouse on the headland
    to the left, the port town small on the right."""
    given = art('backdrop', w, h)
    if given is None:
        r = rng(3)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        up = 1 - yy / h                                               # 0 at the bottom
        HZ = 0.30                                                     # horizon
        sky = ramp((up - HZ) / (1 - HZ), [(0.0, (1.0, 0.80, 0.48)), (0.10, (0.99, 0.62, 0.40)), (0.30, (0.74, 0.40, 0.48)),
                                          (0.55, (0.36, 0.28, 0.50)), (1.0, (0.06, 0.19, 0.30))])
        sun_x = 0.60 * w
        sun = np.exp(-(((xx - sun_x) / (w * 0.30)) ** 2 + ((up - HZ) / 0.16) ** 2))
        sky += np.array((0.30, 0.22, 0.08), np.float32) * sun[..., None]
        # Towering clouds, lit from underneath.
        dens = fbm(h, w, 5, 7, 5, r) * 0.65 + fbm(h, w, 12, 24, 3, r) * 0.35
        band = np.clip((up - HZ - 0.06) / 0.25, 0, 1) * np.clip((1.02 - up) / 0.35, 0, 1)
        cover = np.clip((dens - 0.50 + 0.10 * band) * 6.0, 0, 1) * band
        below = np.roll(dens, -14, axis=0)                            # the same cloud, a little lower
        lit = np.clip((dens - below) * 9.0 + 0.45, 0, 1)
        cloud = ramp(lit, [(0.0, (0.34, 0.26, 0.42)), (0.5, (0.78, 0.50, 0.50)), (1.0, (1.0, 0.86, 0.62))])
        cloud *= (0.75 + 0.5 * np.clip(1 - (up - HZ) / 0.6, 0, 1))[..., None]
        a = sky * (1 - cover[..., None]) + cloud * cover[..., None]
        # The sea: the sky mirrored and darkened, in long strokes, with the sun's path on it.
        depth = np.clip((HZ - up) / HZ, 0, 1)
        mirror = ramp(depth * 0.55, [(0.0, (0.98, 0.72, 0.46)), (0.15, (0.78, 0.46, 0.48)), (0.35, (0.34, 0.30, 0.50)),
                                     (0.55, (0.08, 0.22, 0.34))])
        streak = fbm(h, w, 90, 6, 3, r)
        sea = mirror * (0.72 + 0.4 * streak)[..., None]
        path = np.exp(-((xx - sun_x) / (w * (0.03 + 0.10 * depth))) ** 2) * (streak > 0.52) * (1 - 0.6 * depth)
        sea += np.array((0.45, 0.32, 0.14), np.float32) * path[..., None]
        a = np.where((up < HZ)[..., None], sea, a)
        im = img(a).convert('RGBA')
        ss = 2
        big = im.resize((w * ss, h * ss), Image.LANCZOS)
        d = ImageDraw.Draw(big)
        W, H = w * ss, h * ss
        hy = H * (1 - HZ)
        # The far hills and the town.
        ridge = fbm(1, W, 1, 7, 4, r)[0]
        for k in range(int(W * 0.56), W):
            t = (k - W * 0.56) / (W * 0.44)
            top = hy - H * (0.010 + 0.085 * math.sin(t * math.pi * 0.62) ** 1.2 * (0.7 + 0.6 * ridge[k]))
            d.line([(k, top), (k, hy)], fill=c8((0.30, 0.24, 0.38)))
        for k in range(150):
            t = 0.60 + 0.38 * r.random()
            x = W * t
            y = hy - H * (0.004 + 0.045 * r.random() * math.sin((t - 0.56) / 0.44 * math.pi * 0.62))
            s = H * (0.006 + 0.006 * r.random())
            d.rectangle((x, y - s, x + s * 1.5, y), fill=c8((0.56, 0.44, 0.48)))
            d.polygon([(x - 1, y - s), (x + s * 0.75, y - s * 1.7), (x + s * 1.5 + 1, y - s)], fill=c8((0.40, 0.24, 0.26)))
            if r.random() < 0.6:
                d.rectangle((x + s * 0.5, y - s * 0.7, x + s * 0.9, y - s * 0.3), fill=c8((1.0, 0.82, 0.42)))
        # The headland and its lighthouse.
        land = []
        for k in range(int(W * 0.36)):
            t = k / (W * 0.36)
            land.append((k, hy - H * (0.20 * (1 - t) ** 1.3 * (0.75 + 0.5 * ridge[k * 3 % W]) + 0.012 * (1 - t))))
        d.polygon(land + [(W * 0.36, hy), (0, hy)], fill=c8((0.16, 0.13, 0.22)))
        d.line(land, fill=c8((0.62, 0.38, 0.36)), width=5)
        lx, base = W * 0.115, land[int(W * 0.115)][1]
        th = H * 0.17
        d.polygon([(lx - th * 0.085, base + 6), (lx + th * 0.085, base + 6), (lx + th * 0.055, base - th), (lx - th * 0.055, base - th)],
                  fill=c8((0.93, 0.89, 0.84)))
        for b in (0.30, 0.62):                                        # the red bands
            wd = 0.085 - 0.03 * b
            d.polygon([(lx - th * wd, base - th * b), (lx + th * wd, base - th * b),
                       (lx + th * (wd - 0.004), base - th * (b + 0.12)), (lx - th * (wd - 0.004), base - th * (b + 0.12))],
                      fill=c8((0.70, 0.18, 0.15)))
        d.polygon([(lx + th * 0.01, base + 6), (lx + th * 0.085, base + 6), (lx + th * 0.055, base - th), (lx + th * 0.01, base - th)],
                  fill=(60, 40, 70, 70))                              # its shaded side
        d.rectangle((lx - th * 0.075, base - th * 1.02, lx + th * 0.075, base - th), fill=c8((0.20, 0.16, 0.20)))
        d.rectangle((lx - th * 0.045, base - th * 1.13, lx + th * 0.045, base - th * 1.02), fill=c8((1.0, 0.90, 0.55)))
        d.polygon([(lx - th * 0.06, base - th * 1.13), (lx + th * 0.06, base - th * 1.13), (lx, base - th * 1.22)],
                  fill=c8((0.20, 0.16, 0.20)))
        a = arr(big.resize((w, h), Image.LANCZOS).convert('RGB'))
        lamp_x, lamp_y = lx / ss, (base - th * 1.075) / ss
        halo = np.exp(-(((xx - lamp_x) / (w * 0.035)) ** 2 + ((yy - lamp_y) / (w * 0.035)) ** 2))
        beam = np.exp(-((yy - lamp_y) / (h * 0.008 + (xx - lamp_x).clip(0) * 0.035)) ** 2) * (xx > lamp_x) * np.exp(-(xx - lamp_x) / (w * 0.22))
        a += np.array((1.0, 0.85, 0.50), np.float32) * (0.75 * halo + 0.22 * beam)[..., None]
        # Scenic brushwork: break the gradients into strokes.
        a = arr(img(a).filter(ImageFilter.ModeFilter(7)).filter(ImageFilter.GaussianBlur(1.2)))
        a = paint_noise(a, 3, 0.07)
    else:
        a = arr(given)
    yy, xx = np.mgrid[0:h, 0:w]
    weave = (np.sin(xx * math.pi / 1.5) * np.sin(yy * math.pi / 1.5)).astype(np.float32)
    return a * (1 + 0.035 * weave)[..., None]


def ceiling(size=1536):
    """The auditorium's ceiling, seen from below: a painted sky inside a
    gilt ring, with a rosette where the chandelier hangs."""
    given = art('ceiling', size, size)
    if given is not None:
        return given
    r = rng(17)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    c = size / 2
    rr = np.hypot(xx - c, yy - c) / c
    th = np.arctan2(yy - c, xx - c)
    sky = ramp(rr, [(0.0, (1.0, 0.92, 0.74)), (0.30, (0.96, 0.84, 0.76)), (0.60, (0.66, 0.78, 0.90)), (0.86, (0.50, 0.62, 0.84))])
    dens = fbm(size, size, 5, 5, 5, r) * 0.6 + fbm(size, size, 14, 14, 3, r) * 0.4
    swirl = 0.5 + 0.5 * np.sin(th * 3 + rr * 7 + dens * 5)
    cover = np.clip((dens * 0.75 + swirl * 0.25 - 0.47) * 5.5, 0, 1) * np.clip((rr - 0.16) / 0.2, 0, 1)
    inner = np.roll(np.roll(dens, 8, axis=0), 8, axis=1)
    lit = np.clip((dens - inner) * 9.0 + 0.55, 0, 1)
    cloud = ramp(lit, [(0.0, (0.80, 0.62, 0.66)), (0.55, (0.98, 0.86, 0.80)), (1.0, (1.0, 0.97, 0.90))])
    a = sky * (1 - cover[..., None]) + cloud * cover[..., None]
    a = arr(img(a).filter(ImageFilter.ModeFilter(5)).filter(ImageFilter.GaussianBlur(1.0)))
    ss = 2
    big = img(a).convert('RGBA').resize((size * ss, size * ss), Image.LANCZOS)
    d = ImageDraw.Draw(big)
    S = size * ss; C = S / 2
    for k in range(9):                                                    # seabirds
        ang, rad = r.random() * 2 * math.pi, C * (0.30 + 0.40 * r.random())
        bx, by, s = C + math.cos(ang) * rad, C + math.sin(ang) * rad, S * (0.010 + 0.008 * r.random())
        rot = r.random() * 2 * math.pi
        wing = lambda sx: [(bx + math.cos(rot + sx * (0.5 + 0.35 * t)) * s * t * 2.2, by + math.sin(rot + sx * (0.5 + 0.35 * t)) * s * t * 2.2)
                           for t in np.linspace(0, 1, 6)]
        d.line(wing(1), fill=c8((0.30, 0.28, 0.36)), width=4, joint='curve')
        d.line(wing(-1), fill=c8((0.30, 0.28, 0.36)), width=4, joint='curve')
    n = 28                                                                # the garland: roses and leaves, swagged
    for k in range(n * 6):
        ang = 2 * math.pi * k / (n * 6)
        rad = C * (0.775 - 0.030 * abs(math.sin(ang * n / 2)))
        px, py = C + math.cos(ang) * rad, C + math.sin(ang) * rad
        if k % 6 == 0:
            for q, colr in ((1.0, (0.80, 0.30, 0.36)), (0.6, (0.95, 0.60, 0.62)), (0.25, (0.99, 0.84, 0.80))):
                s = S * 0.016 * q
                d.ellipse((px - s, py - s, px + s, py + s), fill=c8(colr))
        else:
            s = S * 0.009
            a2 = ang + math.pi / 2 + (0.7 if k % 2 else -0.7)
            d.polygon([(px + math.cos(a2) * s * 2, py + math.sin(a2) * s * 2), (px + math.cos(a2 + 1.57) * s * 0.7, py + math.sin(a2 + 1.57) * s * 0.7),
                       (px - math.cos(a2) * s * 2, py - math.sin(a2) * s * 2), (px - math.cos(a2 + 1.57) * s * 0.7, py - math.sin(a2 + 1.57) * s * 0.7)],
                      fill=c8((0.36, 0.50, 0.32) if k % 2 else (0.46, 0.60, 0.38)))
    # The gilt ring, with a run of scrolls and beads.
    for rad0, rad1 in ((0.86, 1.02),):
        for k in range(int((rad1 - rad0) * C)):
            t = k / ((rad1 - rad0) * C)
            s = 0.5 + 0.5 * math.sin(t * math.pi * 5 - 0.8)
            colr = [lo + (hi - lo) * s for lo, hi in zip(GOLD_LO, GOLD_HI)]
            rad = rad0 * C + k
            d.ellipse((C - rad, C - rad, C + rad, C + rad), outline=c8(colr), width=2)
    for k in range(48):
        ang = 2 * math.pi * k / 48
        px, py = C + math.cos(ang) * C * 0.925, C + math.sin(ang) * C * 0.925
        s = S * 0.017
        d.ellipse((px - s, py - s + 3, px + s, py + s + 3), fill=c8(GOLD_LO))
        d.ellipse((px - s, py - s, px + s, py + s), fill=c8(GOLD))
        d.arc((px - s * 0.6, py - s * 0.6, px + s * 0.6, py + s * 0.6), math.degrees(ang) + 40, math.degrees(ang) + 300,
              fill=c8(GOLD_LO), width=4)
        d.ellipse((px - s * 0.45, py - s * 0.6, px + s * 0.05, py - s * 0.15), fill=c8(GOLD_HI))
        bx, by = C + math.cos(ang + math.pi / 48) * C * 0.875, C + math.sin(ang + math.pi / 48) * C * 0.875
        d.ellipse((bx - s * 0.35, by - s * 0.35, bx + s * 0.35, by + s * 0.35), fill=c8(GOLD_HI))
    for k in range(12):                                                   # the rosette
        ang = 2 * math.pi * k / 12
        px, py = C + math.cos(ang) * C * 0.055, C + math.sin(ang) * C * 0.055
        s = S * 0.022
        d.ellipse((px - s, py - s + 3, px + s, py + s + 3), fill=c8(GOLD_LO))
        d.ellipse((px - s, py - s, px + s, py + s), fill=c8(GOLD))
        d.ellipse((px - s * 0.5, py - s * 0.6, px + s * 0.1, py - s * 0.1), fill=c8(GOLD_HI))
    d.ellipse((C - S * 0.03, C - S * 0.03, C + S * 0.03, C + S * 0.03), fill=c8(GOLD_LO))
    out = arr(big.resize((size, size), Image.LANCZOS).convert('RGB'))
    out *= (0.92 + 0.14 * fbm(size, size, 6, 6, 4, r))[..., None]
    return out


# ── Paper ───────────────────────────────────────────────────────────────
def paper(w, h, seed, colour=(0.93, 0.88, 0.74)):
    a = np.array(colour, np.float32) * (0.92 + 0.12 * fbm(h, w, 6, 6, 4, rng(seed)))[..., None]
    return img(a).convert('RGB')


def centred(d, y, text, f, fill, w):
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, y), text, font=f, fill=fill)


def playbill(seed, title, sub, acts, w=512, h=768, ink=(0.16, 0.10, 0.08), accent=(0.55, 0.10, 0.10)):
    im = paper(w, h, seed)
    d = ImageDraw.Draw(im)
    ink8, acc8 = c8(ink)[:3], c8(accent)[:3]
    d.rectangle((18, 18, w - 18, h - 18), outline=ink8, width=5)
    d.rectangle((30, 30, w - 30, h - 30), outline=ink8, width=1)
    centred(d, 52, 'HARBOUR OPERA HOUSE', font(30, 'b'), ink8, w)
    d.line((70, 98, w - 70, 98), fill=ink8, width=2)
    centred(d, 110, 'the season\u2019s new production', font(20, 'i'), ink8, w)
    y = 170
    for ln in title:
        centred(d, y, ln, font(64 if len(ln) < 11 else 46, 'b'), acc8, w)
        y += 76
    centred(d, y + 6, sub, font(24, 'i'), ink8, w)
    y += 60
    d.line((120, y, w - 120, y), fill=ink8, width=2)
    d.ellipse((w / 2 - 7, y - 7, w / 2 + 7, y + 7), fill=acc8)
    y += 26
    for ln in acts:
        centred(d, y, ln, font(22), ink8, w)
        y += 34
    centred(d, h - 150, 'EVERY EVENING AT EIGHT', font(26, 'b'), ink8, w)
    centred(d, h - 110, 'Doors at half past seven', font(20, 'i'), ink8, w)
    centred(d, h - 70, 'Stage Manager \u2014 Leo', font(20), ink8, w)
    return im


def call_sheet(w=512, h=768):
    im = paper(w, h, 41, (0.95, 0.94, 0.90))
    d = ImageDraw.Draw(im)
    ink = (38, 34, 40)
    centred(d, 30, 'TONIGHT', font(44, 'b'), ink, w)
    centred(d, 86, 'Running order & calls', font(22, 'i'), ink, w)
    d.line((40, 124, w - 40, 124), fill=ink, width=3)
    rows = [('The Half', '7:25'), ('The Quarter', '7:40'), ('The Five', '7:50'), ('Beginners', '7:55'),
            ('Curtain up', '8:00'), ('Interval', '9:05'), ('Act Two', '9:25'), ('Curtain down', '10:20')]
    y = 146
    for name, t in rows:
        d.text((52, y), name, font=font(28), fill=ink)
        tw = d.textlength(t, font=font(28, 'b'))
        d.text((w - 52 - tw, y), t, font=font(28, 'b'), fill=ink)
        d.line((52, y + 40, w - 52, y + 40), fill=(170, 165, 160), width=1)
        y += 56
    d.text((52, y + 16), 'Quiet in the wings.', font=font(24, 'i'), fill=(150, 30, 30))
    d.text((52, y + 52), 'Check your props. Sign in.', font=font(22, 'i'), fill=ink)
    d.ellipse((w / 2 - 9, 8, w / 2 + 9, 26), fill=(170, 40, 40))             # drawing pin
    return im


def prompt_book(w=1024, h=640):
    """The book, open: the script on the left page, the cues on the right."""
    im = paper(w, h, 44, (0.96, 0.94, 0.88))
    d = ImageDraw.Draw(im)
    ink = (40, 36, 44)
    d.rectangle((w / 2 - 5, 0, w / 2 + 5, h), fill=(150, 140, 125))
    for k in range(4):                                                        # ring holes
        cy = h * (0.14 + 0.24 * k)
        for cx in (w / 2 - 26, w / 2 + 26):
            d.ellipse((cx - 9, cy - 9, cx + 9, cy + 9), fill=(70, 62, 55))
    r = rng(9)
    y = 44
    while y < h - 50:                                                         # script: speaker + lines
        n = int(r.integers(1, 4))
        d.rectangle((50, y, 50 + int(r.integers(60, 110)), y + 9), fill=(120, 40, 40))
        for k in range(n):
            y += 20
            d.rectangle((70, y, 70 + int(r.integers(220, 380)), y + 7), fill=(120, 116, 120))
        y += 30
    cues = [('LX 14', (196, 150, 20)), ('FLY 3', (40, 110, 160)), ('SND 6', (60, 130, 70)), ('LX 15', (196, 150, 20)),
            ('WAVES', (40, 110, 160)), ('LX 16', (196, 150, 20)), ('SHIP ON', (160, 50, 50)), ('SND 7', (60, 130, 70)),
            ('LX 17', (196, 150, 20))]
    y = 40
    d.text((w / 2 + 60, y - 6), 'ACT ONE  \u2014  the harbour', font=font(22, 'i'), fill=ink)
    y += 44
    for name, colr in cues:
        d.line((w / 2 + 50, y + 14, w / 2 + 250, y + 14), fill=(150, 150, 150), width=2)
        d.rectangle((w / 2 + 250, y, w / 2 + 380, y + 30), outline=colr, width=3)
        d.text((w / 2 + 262, y + 2), name, font=font(20, 'b'), fill=colr)
        d.text((w / 2 + 394, y + 2), 'standby \u2026 GO', font=font(18, 'i'), fill=ink)
        y += 58
    for k, colr in enumerate(((200, 60, 60), (60, 120, 190), (230, 180, 40), (70, 150, 90))):   # index tabs
        d.rectangle((w - 22, 60 + k * 120, w, 130 + k * 120), fill=colr)
    return im


def clock(size=256):
    ss = 2
    im, d = canvas(size, size, c8((0.95, 0.93, 0.86)), ss)
    S = size * ss
    c = S / 2
    d.ellipse((6, 6, S - 6, S - 6), outline=(40, 36, 34, 255), width=10)
    for k in range(12):
        a = k * math.pi / 6
        d.line([(c + math.sin(a) * S * 0.36, c - math.cos(a) * S * 0.36), (c + math.sin(a) * S * 0.43, c - math.cos(a) * S * 0.43)],
               fill=(40, 36, 34, 255), width=8 if k % 3 == 0 else 4)
    for ang, ln, wd in (((7 + 25 / 60) * math.pi / 6, 0.24, 12), (25 * math.pi / 30, 0.36, 7)):   # 7:25 — the Half
        d.line([(c, c), (c + math.sin(ang) * S * ln, c - math.cos(ang) * S * ln)], fill=(30, 26, 26, 255), width=wd)
    d.ellipse((c - 10, c - 10, c + 10, c + 10), fill=(150, 30, 30, 255))
    return down(im.convert('RGB'), ss)


def sheet_music(w=256, h=320):
    im = paper(w, h, 47, (0.97, 0.95, 0.88))
    d = ImageDraw.Draw(im)
    r = rng(12)
    for s in range(6):
        y0 = 26 + s * 48
        for k in range(5):
            d.line((16, y0 + k * 6, w - 16, y0 + k * 6), fill=(60, 56, 60), width=1)
        x = 30
        while x < w - 24:
            ny = y0 + int(r.integers(-4, 28))
            d.ellipse((x, ny, x + 7, ny + 5), fill=(30, 28, 32))
            d.line((x + 7, ny + 2, x + 7, ny - 16), fill=(30, 28, 32), width=1)
            x += int(r.integers(10, 22))
    return im


def sign(w=512, h=128):
    a = gold_leaf(21, 512)[:h, :w] * 0.9
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    d.rectangle((6, 6, w - 6, h - 6), outline=(70, 46, 14), width=3)
    centred(d, 22, 'PROMPT CORNER', font(40, 'b'), (52, 32, 10), w)
    centred(d, 76, 'quiet, please', font(26, 'i'), (52, 32, 10), w)
    return im


# ── Go ──────────────────────────────────────────────────────────────────
a, n = boards(1); save('floor', a); save('floor_n', img(n).resize((1024, 1024), Image.LANCZOS))
save('velvet', velvet(2, CRIMSON))
save('gold', gold_leaf(3))
save('plaster', plaster(4))
a, n = brick(5); save('brick', a); save('brick_n', n)
save('carpet', carpet(6))
a, g = tier_front(7); save('tier', a); save('tier_glow', img(g).resize((1024, 256), Image.LANCZOS))
save('wall', box_wall(8))
save('cartouche', cartouche())
# The scenery cut-outs: the pictures in art/ where there are any, else painted here.
rows = [waves_art((1.0, 1.0, 1.0), False), waves_art((0.84, 0.90, 0.98), True), waves_art((0.68, 0.78, 0.94), False)]
if rows[0] is None:
    rows = [waves(11, (0.10, 0.36, 0.44), (0.90, 0.95, 0.92), n=9), waves(12, (0.08, 0.29, 0.42), (0.84, 0.92, 0.92), n=8),
            waves(13, (0.07, 0.22, 0.38), (0.78, 0.88, 0.92), n=7)]
for k, a in enumerate(rows):
    save(f'waves{k + 1}', a)
save('ship', ship_art() or ship())
pair = clouds_art() or [clouds(14), clouds(15)]
save('cloud1', pair[0])
save('cloud2', pair[1])
# The house and the pit, peopled: sheets of cut-out figures from art/ (no
# painted stand-ins — without a sheet, that part of the scene is left out).
crowd = (sprites('audience1', 4, 3) or []) + (sprites('audience2', 4, 3) or [])
if crowd:
    a = atlas('audience', crowd, 6, 256); save('audience', a); save('audience_back', backs(a))
band = sprites('musicians', 3, 3)
if band:
    a = atlas('musicians', band, 3, 384); save('musicians', a); save('musicians_back', backs(a, 0.5))
icons = sprites('emotes', 4, 3)
if icons:
    save('emotes', atlas('emotes', icons, 4, 192, bottom=False))
things = sprites('props', 4, 2)
if things:
    save('props', atlas('props', things, 4, 384))
import json
json.dump(SPRITES, open(os.path.join(OUT, 'sprites.json'), 'w'), indent=1)
save('velvet_blue', velvet_folds(22, (0.12, 0.18, 0.42)))
save('glow', glow())
save('glow_blue', glow(colour=(0.45, 0.62, 1.0)))
save('glow_white', glow(colour=(1.0, 1.0, 1.0)))
save('backdrop', backdrop())
save('ceiling', ceiling())
save('poster1', playbill(31, ['THE', 'LIGHTHOUSE', 'KEEPER'], 'an opera in three acts',
                         ['Act I \u2014 The Harbour', 'Act II \u2014 The Storm', 'Act III \u2014 The Lamp']))
save('poster2', playbill(32, ['A NIGHT', 'ON THE TIDE'], 'a comic opera in two acts',
                         ['Act I \u2014 The Quay at Dusk', 'Act II \u2014 All Hands'], accent=(0.10, 0.24, 0.42)))
save('callsheet', call_sheet())
save('book', prompt_book())
save('clock', clock())
save('sheet', sheet_music())
save('sign', sign())
print('done', flush=True)
