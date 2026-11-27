"""What the scene texture painters share (eves_room/paint_textures.py,
aras_cafe/paint_textures.py, sals_hut/paint_textures.py,
rexs_cabin/paint_textures.py):
noise, a room's plain surfaces, paper, and the handling of pictures supplied in
a scene's art/ folder — whole pictures, and sheets of cut-outs painted on a
flat magenta ground.

Needs numpy and Pillow (scipy too, for the sheets), so it runs with a system
Python, not Blender's. Call init(out_dir, art_dir) first.
"""
import json, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = ''
ART = ''
FONTS = '/mnt/c/Windows/Fonts' if os.path.isdir('/mnt/c/Windows/Fonts') else 'C:/Windows/Fonts'
SPRITES = {}        # written out as sprites.json: where each cut-out sits in its atlas, and its shape


def init(out_dir, art_dir):
    global OUT, ART
    OUT, ART = out_dir, art_dir
    os.makedirs(OUT, exist_ok=True)


def font(size, style='', hand=False):
    """Georgia (style '', 'b', 'i'), or a handwriting face."""
    names = ('Inkfree.ttf', 'segoepr.ttf', 'comic.ttf') if hand else (f'georgia{style}.ttf', 'georgia.ttf', 'times.ttf')
    for name in names:
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
    """Noise that repeats at the picture's edges, 0-1."""
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


def save_sprites():
    json.dump(SPRITES, open(os.path.join(OUT, 'sprites.json'), 'w'), indent=1)


def canvas(w, h, colour, ss=2):
    """A supersampled RGBA canvas and its pen."""
    im = Image.new('RGBA', (w * ss, h * ss), colour)
    return im, ImageDraw.Draw(im)


def down(im, ss=2):
    return im.resize((im.width // ss, im.height // ss), Image.LANCZOS)


def c8(c, a=255):
    return tuple(int(round(v * 255)) for v in c) + (a,)


# ── Plain surfaces ──────────────────────────────────────────────────────
def boards(seed, size=2048, n=20, base=(0.66, 0.50, 0.32)):
    """Floor boards running along image y. Returns (albedo, normal)."""
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


def plaster(seed, size=1024, colour=(0.93, 0.88, 0.76)):
    r = rng(seed)
    m = fbm(size, size, 5, 5, 5, r)
    f = fbm(size, size, 80, 80, 2, r)
    return np.array(colour, np.float32) * (0.86 + 0.2 * m + 0.06 * f)[..., None]


def cloth_folds(seed, colour, w=512, h=1024, depth=0.64, sheen=(0.07, 0.09, 0.13)):
    """Cloth hanging in folds — one fold to the picture's width, and it
    repeats across and down. Shade in each hollow, a pale sheen where the
    cloth turns away from the eye, a fold that wanders a little on its way
    down. The crest is at three quarters across, to sit on the crest of the
    pleat it is laid over. depth: how dark the hollows go."""
    r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    f = xx / w + 0.05 * np.sin(2 * np.pi * yy / h + 1.0) + 0.02 * np.sin(6 * np.pi * yy / h + 2.2)
    front = 0.5 - 0.5 * np.sin(2 * np.pi * f)                 # 1 on the crest, 0 in the hollow
    turn = np.abs(np.cos(2 * np.pi * f))                      # 1 on the fold's flanks
    shade = (0.90 - depth) + depth * front ** 0.8 + 0.30 * turn ** 4 * (0.35 + 0.65 * front)
    nap = fbm(h, w, 4, 96, 3, r)                              # streaks along the fall
    soft = fbm(h, w, 6, 4, 3, r)
    a = np.array(colour, np.float32) * (shade * (0.86 + 0.20 * nap + 0.12 * soft))[..., None]
    return a + np.array(sheen, np.float32) * (turn ** 6 * front)[..., None]


def glow(size=128, colour=(1.0, 0.86, 0.60), power=2.2, peak=1.0):
    """A light's halo: its colour, fading out from the middle."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    out = np.zeros((size, size, 4), np.float32)
    out[..., :3] = colour
    out[..., 3] = peak * np.clip(1 - rr, 0, 1) ** power
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


# ── A room's surfaces ───────────────────────────────────────────────────
def planks(seed, colour, n=8, size=512, vary=0.035):
    """Painted tongue-and-groove boards running up the picture."""
    r = rng(seed)
    bw = size // n
    a = np.zeros((size, size, 3), np.float32)
    brush = fbm(size, size, 4, 160, 3, r)                     # brush marks along the boards
    for i in range(n):
        a[:, i * bw:(i + 1) * bw] = np.array(colour, np.float32) * (1 + r.normal(0, vary))
    a *= (0.90 + 0.14 * brush + 0.06 * fbm(size, size, 5, 5, 3, r))[..., None]
    for i in range(n):
        x = i * bw
        a[:, x:x + 2] *= 0.62                                 # the groove, and the lit edge beside it
        a[:, x + 2:x + 4] *= 1.06
    return a


def woodgrain(seed, colour, size=512, depth=1.0):
    """Grain running along image x. depth: how strongly it shows (under
    paint, hardly)."""
    r = rng(seed)
    grain = fbm(size, size, 200, 5, 3, r)
    fig = np.sin((np.arange(size, dtype=np.float32)[:, None] * 0.11) + fbm(size, size, 4, 3, 3, r) * 26) * 0.5 + 0.5
    soft = fbm(size, size, 4, 4, 3, r)
    shade = 0.22 * grain + 0.12 * fig + 0.10 * soft
    return np.array(colour, np.float32) * (1 - depth * (0.22 - shade))[..., None]


def linen(seed, colour, size=256):
    """A plain weave."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    weave_ = 0.5 + 0.25 * np.sin(xx * math.pi / 2) + 0.25 * np.sin(yy * math.pi / 2)
    slub = fbm(size, size, 8, 128, 2, r) * 0.5 + fbm(size, size, 128, 8, 2, r) * 0.5
    return np.array(colour, np.float32) * (0.84 + 0.10 * weave_ + 0.14 * slub + 0.08 * fbm(size, size, 4, 4, 3, r))[..., None]


def weave(seed, colour, size=256, n=8):
    """Basketwork."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    p = size / n
    cx = np.floor(xx / p); cy = np.floor(yy / p)
    over = ((cx + cy) % 2) == 0
    u = (xx % p) / p; v = (yy % p) / p
    bump = np.where(over, np.sin(u * math.pi), np.sin(v * math.pi))
    fibre = np.where(over, np.sin(yy * 1.9), np.sin(xx * 1.9)) * 0.5 + 0.5
    return np.array(colour, np.float32) * (0.55 + 0.42 * bump + 0.08 * fibre + 0.06 * fbm(size, size, 6, 6, 2, r))[..., None]


def panel_door(seed, colour, w=256, h=512, panels=((0.12, 0.06, 0.88, 0.42), (0.12, 0.48, 0.88, 0.94))):
    """A framed-and-panelled door or cabinet front (panels as fractions:
    x0, y0 from the top, x1, y1)."""
    a = planks(seed, colour, n=1, size=max(w, h), vary=0.0)[:h, :w]
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    lo = c8([v * 0.62 for v in colour])[:3]; hi = c8([min(1, v * 1.10) for v in colour])[:3]
    for x0, y0, x1, y1 in panels:
        box = (x0 * w, y0 * h, x1 * w, y1 * h)
        d.rectangle(box, outline=lo, width=3)
        d.line((box[0] + 3, box[3] - 2, box[2] - 2, box[3] - 2), fill=hi, width=2)
        d.line((box[2] - 2, box[1] + 3, box[2] - 2, box[3] - 2), fill=hi, width=2)
        d.rectangle((box[0] + 12, box[1] + 12, box[2] - 12, box[3] - 12), outline=lo, width=1)
    return im


def spines(seed, w=1024, h=256, n=28):
    """A shelf's worth of book spines side by side (each takes one of n
    columns in the first 7/8 of the picture); the last eighth is page edge."""
    r = rng(seed)
    im = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(im)
    cw = w * 7 // 8 // n
    cloth = [(0.20, 0.28, 0.44), (0.52, 0.16, 0.16), (0.18, 0.36, 0.30), (0.62, 0.46, 0.22), (0.30, 0.22, 0.36),
             (0.80, 0.72, 0.56), (0.24, 0.40, 0.50), (0.70, 0.36, 0.26), (0.36, 0.36, 0.38), (0.86, 0.82, 0.74),
             (0.50, 0.58, 0.44), (0.16, 0.18, 0.24), (0.84, 0.58, 0.52), (0.44, 0.60, 0.70)]
    for k in range(n):
        c = np.array(cloth[int(r.integers(len(cloth)))]) * (0.85 + 0.3 * r.random())
        x0 = k * cw
        d.rectangle((x0, 0, x0 + cw, h), fill=c8(np.clip(c, 0, 1))[:3])
        gold = (212, 176, 96) if c.mean() < 0.55 else (60, 44, 36)
        style = int(r.integers(4))
        if style in (0, 1):
            for y in (int(h * 0.10), int(h * 0.16), int(h * 0.84), int(h * 0.90)):
                d.line((x0 + 3, y, x0 + cw - 3, y), fill=gold, width=2)
        if style in (1, 2):
            d.rectangle((x0 + 5, int(h * 0.24), x0 + cw - 5, int(h * 0.46)), fill=tuple(int(v * 0.6) for v in c8(c)[:3]))
        for y in range(int(h * 0.28), int(h * (0.44 if style != 3 else 0.72)), 7):   # the title, as strokes
            if r.random() < 0.8:
                d.line((x0 + 8, y, x0 + cw - 8 - int(r.integers(0, 8)), y), fill=gold, width=2)
        d.line((x0, 0, x0, h), fill=tuple(int(v * 0.55) for v in c8(c)[:3]), width=2)
        d.line((x0 + cw - 1, 0, x0 + cw - 1, h), fill=tuple(int(v * 0.7) for v in c8(c)[:3]), width=1)
    a = arr(im)
    px = w * 7 // 8
    yy, xx = np.mgrid[0:h, 0:w - px].astype(np.float32)
    a[:, px:] = (np.array((0.93, 0.90, 0.80), np.float32) * (0.88 + 0.10 * np.sin(xx * 2.2))[..., None])
    return a * (0.93 + 0.10 * fbm(h, w, 6, 24, 3, r))[..., None]


def lampshade(colour=(1.0, 0.86, 0.62), w=128, h=128):
    """A cloth shade with the lamp lit inside it: brightest round the middle."""
    r = rng(97)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lit = 0.62 + 0.38 * np.exp(-((yy / h - 0.55) / 0.42) ** 2)
    return np.array(colour, np.float32) * (lit * (0.94 + 0.06 * np.sin(xx * 1.6)) * (0.95 + 0.08 * fbm(h, w, 6, 6, 2, r)))[..., None]


def wisp(size=128):
    """A wisp of steam."""
    r = rng(91)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2, yy - size / 2) / (size / 2)
    out = np.ones((size, size, 4), np.float32)
    out[..., 3] = np.clip(1 - rr, 0, 1) ** 1.4 * (0.45 + 0.55 * fbm(size, size, 5, 5, 3, r))
    return out


def gull(w=128, h=64, colour=(52, 56, 76)):
    """A gull a long way off: two strokes."""
    ss = 4
    im, d = canvas(w, h, colour + (0,), ss)
    W, H = w * ss, h * ss
    for sgn in (-1, 1):
        d.line([(W / 2, H * 0.62), (W / 2 + sgn * W * 0.22, H * 0.34), (W / 2 + sgn * W * 0.46, H * 0.50)],
               fill=colour + (255,), width=14, joint='curve')
    return down(im, ss)


# ── Paper ───────────────────────────────────────────────────────────────
INK = (44, 38, 46)


def paper(w, h, seed, colour=(0.93, 0.88, 0.74)):
    a = np.array(colour, np.float32) * (0.92 + 0.12 * fbm(h, w, 6, 6, 4, rng(seed)))[..., None]
    return img(a).convert('RGB')


def centred(d, y, text, f, fill, w, x0=0):
    tw = d.textlength(text, font=f)
    d.text((x0 + (w - tw) / 2, y), text, font=f, fill=fill)


def pin(d, x, y, colour=(190, 50, 46), r=9):
    d.ellipse((x - r + 2, y - r + 4, x + r + 2, y + r + 4), fill=(40, 30, 22))
    d.ellipse((x - r, y - r, x + r, y + r), fill=colour)
    d.ellipse((x - r // 2, y - r // 2 - 1, x, y - 1), fill=tuple(min(255, c + 70) for c in colour))


def note(w, h, seed, lines, colour=(0.96, 0.93, 0.80), size=30, ink=INK, hand=True, rule=False):
    """A slip of paper with a few written lines."""
    im = paper(w, h, seed, colour)
    d = ImageDraw.Draw(im)
    f = font(size, hand=hand)
    y = 14
    for ln in lines:
        if rule:
            d.line((10, y + size + 6, w - 10, y + size + 6), fill=(170, 190, 205), width=1)
        d.text((16, y), ln, font=f, fill=ink)
        y += size + 10
    return im


def stick(board, im, x, y, angle=0.0, shadow=True):
    """Paste a paper onto a board, a little askew, with a shadow under it."""
    im = im.convert('RGBA').rotate(angle, expand=True, resample=Image.BICUBIC)
    if shadow:
        sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
        sh.putalpha(im.getchannel('A').point(lambda v: v * 0.35))
        board.alpha_composite(sh.filter(ImageFilter.GaussianBlur(4)), (int(x + 5), int(y + 7)))
    board.alpha_composite(im, (int(x), int(y)))


def photo(name, w, h, border=10, foot=0):
    """A print from art/ with a white border (a deep one below: an instant
    photo)."""
    src = art(name)
    out = Image.new('RGB', (w + 2 * border, h + 2 * border + foot), (245, 242, 232))
    if src is not None:
        out.paste(cover(src, w, h), (border, border))
    return out


# ── Pictures from art/ ──────────────────────────────────────────────────
def art(name, w=None, h=None):
    """A picture supplied in art/ (made with an image generator, say), or
    None. Given a size, it is scaled to it."""
    for ext in ('.jpg', '.png'):
        p = os.path.join(ART, name + ext)
        if os.path.exists(p):
            im = Image.open(p).convert('RGB')
            return im.resize((w, h), Image.LANCZOS) if w else im
    return None


def cover(im, w, h):
    """The picture scaled and cropped about its middle to fill w × h."""
    k = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * k)), max(h, round(im.height * k))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def keyed(name):
    """A cut-out supplied in art/, painted on a flat magenta ground: the
    picture as RGBA with the ground keyed out, or None. The ground is
    wherever red and blue both stand well clear of green; the edge is
    drawn in a little so no pink fringe is left."""
    p = os.path.join(ART, name + '.jpg')
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


def atlas(name, cells, cols, cell_px, bottom=True, pad=0.06, cell_h=None):
    """Lay pictures out in a grid texture and note where each landed.
    cells: RGBA arrays (cut-outs) or PIL pictures (taken whole)."""
    cw, ch = cell_px, cell_h or cell_px
    rows = -(-len(cells) // cols)
    out = Image.new('RGBA', (cols * cw, rows * ch), (0, 0, 0, 0))
    iw, ih = int(cw * (1 - 2 * pad)), int(ch * (1 - 2 * pad))
    notes = []
    for k, c in enumerate(cells):
        src = c.convert('RGBA') if isinstance(c, Image.Image) else \
            Image.fromarray((np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
        s = min(iw / src.width, ih / src.height)
        src = src.resize((max(1, int(src.width * s)), max(1, int(src.height * s))), Image.LANCZOS)
        cx, cy = (k % cols) * cw, (k // cols) * ch
        x = cx + (cw - src.width) // 2
        y = cy + (ch - int(ch * pad) - src.height if bottom else (ch - src.height) // 2)
        out.paste(src, (x, y))
        notes.append({'u0': x / out.width, 'u1': (x + src.width) / out.width,
                      'v0': 1 - (y + src.height) / out.height, 'v1': 1 - y / out.height,
                      'aspect': src.width / src.height})
    SPRITES[name] = notes
    return solid_under(out)


def bbox(a, floor=0.5):
    ys, xs = np.where(a[..., 3] > floor)
    return xs.min(), xs.max() + 1, ys.min(), ys.max() + 1


def solid_under(im):
    """Carry each cut-out's edge colour out under its transparent part, so
    the cut line never samples black."""
    a = arr(im)
    rgb = img(a[..., :3] * a[..., 3:4]).filter(ImageFilter.GaussianBlur(6))
    wt = img(a[..., 3]).filter(ImageFilter.GaussianBlur(6))
    spread = arr(rgb) / np.maximum(arr(wt), 1e-3)[..., None]
    a[..., :3] = np.where(a[..., 3:4] > 0.5, a[..., :3], np.clip(spread, 0, 1))
    return img(a)
