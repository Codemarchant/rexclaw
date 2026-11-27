"""Paint the textures of Eve's Room (step 1 of 2; build_eves_room.py is step 2).

    python3 paint_textures.py <out_dir>

Runs with a system Python (numpy, Pillow, scipy), not Blender's. Surfaces,
cloth, paper and the pin boards are painted here; the pictures come from
art/ (made with an image generator) and none has a stand-in:
    harbour.jpg            the view from the window, 2:1
    rug.jpg, quilt.jpg     seen flat from above, edge to edge
    chart.jpg              the framed chart (and the sheets on the desk)
    evie_*.jpg, eve_*.jpg, crew.jpg, print_*.jpg, poster_lighthouse.jpg
                           the framed photographs and prints
    tv1.jpg … tv6.jpg      what is on the television, 16:9
and three sheets of cut-outs, 4 × 2 on a flat magenta ground:
    plants.jpg, fish.jpg (all facing left), things.jpg
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import paint_kit as kit
from paint_kit import (arr, art, atlas, boards, c8, canvas, centred, cloth_folds, cover, down, fbm, font, glow, img,
                       normal_from_height, paper, plaster, ramp, rng, save, sprites)

kit.init(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'textures'), os.path.join(HERE, 'art'))

SAGE = (0.55, 0.66, 0.56)
CREAM = (0.94, 0.89, 0.78)
DUSK = (0.47, 0.60, 0.68)
TEAL = (0.36, 0.55, 0.57)
INK = (44, 38, 46)
PICTURES = ['evie_window', 'evie_barrel', 'evie_charts', 'evie_face', 'eve_evie', 'eve_ara', 'crew', 'eve_kid',
            'print_seaweed', 'print_birds', 'poster_lighthouse']


# ── Wood, paint, cloth ──────────────────────────────────────────────────
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
    weave = 0.5 + 0.25 * np.sin(xx * math.pi / 2) + 0.25 * np.sin(yy * math.pi / 2)
    slub = fbm(size, size, 8, 128, 2, r) * 0.5 + fbm(size, size, 128, 8, 2, r) * 0.5
    return np.array(colour, np.float32) * (0.84 + 0.10 * weave + 0.14 * slub + 0.08 * fbm(size, size, 4, 4, 3, r))[..., None]


def knit(seed, colour, size=256, rows=16):
    """Stocking stitch: rows of little Vs."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    p = size / rows
    u = (xx % p) / p; v = (yy % p) / p
    vee = np.abs(u - 0.5) * 2                                   # 0 at the stitch's middle
    ridge = np.clip(1 - np.abs(v - (0.25 + 0.5 * vee)) * 3.2, 0, 1)
    shade = 0.70 + 0.34 * ridge + 0.08 * fbm(size, size, 6, 6, 3, r)
    return np.array(colour, np.float32) * shade[..., None]


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


def sisal(seed, size=128):
    """Rope wound round a post: turns stacked up the picture."""
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    turn = np.sin((yy + 0.2 * xx) * math.pi / 8) * 0.5 + 0.5
    return np.array((0.74, 0.62, 0.42), np.float32) * (0.62 + 0.40 * turn + 0.10 * fbm(size, size, 64, 64, 2, r))[..., None]


def tiles(seed, size=512, n=4):
    """Glazed wall tiles; here and there one with a little blue picture."""
    r = rng(seed)
    ss = 2
    im, d = canvas(size, size, c8((0.93, 0.93, 0.90)), ss)
    p = size * ss // n
    blue = c8((0.25, 0.42, 0.62))
    motifs = {(1, 0): 'fish', (3, 1): 'anchor', (0, 2): 'wave', (2, 3): 'fish', (3, 3): 'star'}
    for j in range(n):
        for i in range(n):
            x, y = i * p, j * p
            tone = 0.94 + 0.05 * r.random()
            d.rectangle((x + 5, y + 5, x + p - 5, y + p - 5), fill=c8((0.95 * tone, 0.95 * tone, 0.92 * tone)))
            cx, cy = x + p / 2, y + p / 2
            m = motifs.get((i, j))
            if m == 'fish':
                d.ellipse((cx - 62, cy - 30, cx + 40, cy + 30), outline=blue, width=7)
                d.polygon([(cx + 34, cy), (cx + 78, cy - 34), (cx + 78, cy + 34)], outline=blue, width=7)
                d.ellipse((cx - 40, cy - 12, cx - 28, cy), fill=blue)
            elif m == 'anchor':
                d.line((cx, cy - 60, cx, cy + 56), fill=blue, width=8)
                d.line((cx - 30, cy - 34, cx + 30, cy - 34), fill=blue, width=8)
                d.arc((cx - 52, cy - 10, cx + 52, cy + 62), 20, 160, fill=blue, width=8)
                d.ellipse((cx - 14, cy - 86, cx + 14, cy - 58), outline=blue, width=7)
            elif m == 'wave':
                for k in range(3):
                    yy = cy - 36 + k * 36
                    d.line([(cx - 76 + t * 8, yy + 12 * math.sin(t * 0.9)) for t in range(20)], fill=blue, width=7)
            elif m == 'star':
                pts = [(cx + (58 if k % 2 == 0 else 24) * math.sin(k * math.pi / 5),
                        cy - (58 if k % 2 == 0 else 24) * math.cos(k * math.pi / 5)) for k in range(10)]
                d.polygon(pts, outline=blue, width=7)
    a = arr(down(im.convert('RGB'), ss))
    grout = np.zeros((size, size), bool)
    q = size // n
    for k in range(n):
        grout[k * q:k * q + 3, :] = True; grout[:, k * q:k * q + 3] = True
    a[grout] = (0.70, 0.69, 0.66)
    return a * (0.95 + 0.08 * fbm(size, size, 6, 6, 3, r))[..., None]


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


# ── Paper and screens ───────────────────────────────────────────────────
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
    """A print with a white border (a deep one below: an instant photo)."""
    src = art(name)
    out = Image.new('RGB', (w + 2 * border, h + 2 * border + foot), (245, 242, 232))
    if src is not None:
        out.paste(cover(src, w, h), (border, border))
    return out


def evidence_board(w=1280, h=832):
    """The evidence file, as far as it fits on a pin board: who is the
    captain, and what was the ship called before."""
    r = rng(51)
    cork = np.array((0.66, 0.48, 0.30), np.float32) * (0.80 + 0.30 * fbm(h, w, 90, 90, 3, r) + 0.12 * fbm(h, w, 6, 6, 3, r))[..., None]
    board = img(cork).convert('RGBA')
    chart = art('chart')
    if chart is not None:
        stick(board, cover(chart.crop((chart.width // 3, chart.height // 4, chart.width * 5 // 6, chart.height * 3 // 4)), 430, 300),
              60, 60, 2.5)
    # The middle: the captain, as far as anyone can describe them.
    card = paper(250, 310, 52, (0.95, 0.93, 0.86))
    d = ImageDraw.Draw(card)
    d.ellipse((75, 34, 175, 134), fill=(70, 66, 74))
    d.pieslice((35, 130, 215, 330), 180, 360, fill=(70, 66, 74))
    centred(d, 44, '?', font(84, 'b'), (236, 232, 220), 250)
    centred(d, 248, 'THE CAPTAIN', font(26, 'b'), INK, 250)
    stick(board, card, 520, 250, -2.0)
    stick(board, note(330, 150, 53, ["It's them.", 'Probably.  Ongoing.'], (0.98, 0.93, 0.62), 36), 800, 330, 3.0)
    stick(board, note(300, 190, 54, ['3 chapbooks', '2 ballads', 'deeds, never a face'], size=28, rule=True), 880, 60, -3.0)
    stick(board, note(280, 150, 55, ["the ship's OLD name:", 'in no registry.  why?'], (0.80, 0.90, 0.95), 26), 130, 420, -4.0)
    stick(board, note(270, 150, 56, ['paper: no maker', 'ink: cannot date', 'cork proves nothing'], (0.97, 0.86, 0.84), 24), 500, 620, 2.0)
    # The bottle, drawn.
    sk = paper(210, 290, 57, (0.94, 0.92, 0.84))
    d = ImageDraw.Draw(sk)
    d.rounded_rectangle((60, 90, 150, 262), radius=26, outline=INK, width=4)
    d.rectangle((88, 44, 122, 92), outline=INK, width=4)
    d.rectangle((84, 22, 126, 46), fill=(150, 110, 70), outline=INK, width=3)
    d.rounded_rectangle((82, 130, 128, 236), radius=8, outline=(120, 90, 60), width=3)
    centred(d, 266, 'exhibit A', font(18, 'i'), INK, 210)
    stick(board, sk, 560, 36, 4.0)
    crew = photo('crew', 300, 200)
    stick(board, crew, 900, 560, -3.5)
    tide = paper(250, 200, 58, (0.95, 0.95, 0.92))
    d = ImageDraw.Draw(tide)
    centred(d, 10, 'TIDES', font(24, 'b'), INK, 250)
    d.line([(14 + k * 4, 120 + 44 * math.sin(k * 0.21)) for k in range(56)], fill=(40, 90, 150), width=3)
    for k in range(5):
        d.line((14, 60 + k * 30, 236, 60 + k * 30), fill=(190, 190, 190), width=1)
    stick(board, tide, 200, 600, 3.0)
    d = ImageDraw.Draw(board)
    pins = {'chart': (275, 66), 'captain': (645, 262), 'its': (965, 340), 'tally': (1030, 70), 'name': (270, 430),
            'ink': (635, 630), 'bottle': (665, 46), 'crew': (1050, 570), 'tide': (325, 610)}
    for a, b in (('chart', 'captain'), ('captain', 'its'), ('bottle', 'captain'), ('name', 'captain'), ('ink', 'bottle'),
                 ('crew', 'its'), ('tally', 'bottle'), ('tide', 'name')):
        d.line((*pins[a], *pins[b]), fill=(176, 36, 40), width=4)
    for k, p in enumerate(pins.values()):
        pin(d, *p, colour=((190, 50, 46), (40, 90, 150), (220, 170, 40))[k % 3])
    return board.convert('RGB')


def fridge_door(w=512, h=1024, colour=(0.74, 0.87, 0.80)):
    """The fridge's front: enamel, and everything held on it by magnets."""
    r = rng(61)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = np.array(colour, np.float32) * (0.90 + 0.10 * np.sin(xx / w * math.pi)[..., None] + 0.05 * fbm(h, w, 5, 5, 3, r)[..., None])
    board = img(a).convert('RGBA')
    d = ImageDraw.Draw(board)
    d.line((0, int(h * 0.30), w, int(h * 0.30)), fill=(110, 130, 120), width=5)        # freezer door above, fridge below
    stick(board, photo('evie_face', 150, 150, 12, 36), 40, 40, -5.0)
    stick(board, photo('eve_ara', 190, 142, 10, 30), 250, 70, 4.0)
    stick(board, note(250, 250, 62, ['coffee', 'coffee filters', 'tuna (for Evie)', 'more coffee', 'biscuits'], size=27, rule=True),
          40, 350, -3.0)
    stick(board, note(190, 120, 63, ['gym w/ Ara', 'Thurs 6pm !!'], (0.98, 0.93, 0.62), 28), 300, 380, 5.0)
    stick(board, photo('evie_barrel', 180, 135, 10, 30), 280, 560, -4.0)
    tide = paper(210, 150, 64, (0.95, 0.95, 0.92))
    dd = ImageDraw.Draw(tide)
    centred(dd, 8, 'HIGH WATER', font(20, 'b'), INK, 210)
    for k, t in enumerate(('Mon  06:12   18:40', 'Tue  07:03   19:28', 'Wed  07:51   20:15')):
        dd.text((14, 44 + k * 32, ), t, font=font(18), fill=INK)
    stick(board, tide, 50, 660, 2.0)
    stick(board, note(230, 100, 65, ['Evie has been fed.', '(she will say otherwise)'], (0.84, 0.92, 0.96), 20), 150, 850, -2.0)
    d = ImageDraw.Draw(board)
    for (x, y), c in zip(((125, 46), (350, 76), (160, 356), (392, 388), (372, 566), (150, 664), (262, 856)),
                         ((220, 80, 70), (60, 120, 180), (240, 190, 60), (90, 160, 110), (220, 80, 70), (60, 120, 180),
                          (240, 190, 60))):
        d.ellipse((x - 16, y - 16, x + 16, y + 16), fill=c, outline=tuple(int(v * 0.6) for v in c), width=3)
    return board.convert('RGB')


def clock_face(size=256, hour=8, minute=40):
    ss = 2
    im, d = canvas(size, size, c8((0.96, 0.94, 0.86)), ss)
    S = size * ss
    c = S / 2
    f = font(int(S * 0.11), 'b')
    for k in range(1, 13):
        a = k * math.pi / 6
        t = str(k)
        tw = d.textlength(t, font=f)
        d.text((c + math.sin(a) * S * 0.37 - tw / 2, c - math.cos(a) * S * 0.37 - S * 0.065), t, font=f, fill=(46, 40, 40, 255))
    for k in range(60):
        a = k * math.pi / 30
        d.line([(c + math.sin(a) * S * 0.455, c - math.cos(a) * S * 0.455), (c + math.sin(a) * S * 0.48, c - math.cos(a) * S * 0.48)],
               fill=(46, 40, 40, 255), width=6 if k % 5 == 0 else 2)
    for ang, ln, wd in (((hour % 12 + minute / 60) * math.pi / 6, 0.23, 12), (minute * math.pi / 30, 0.35, 7)):
        d.line([(c, c), (c + math.sin(ang) * S * ln, c - math.cos(ang) * S * ln)], fill=(30, 26, 26, 255), width=wd)
    d.ellipse((c - 9, c - 9, c + 9, c + 9), fill=(150, 110, 50, 255))
    return down(im.convert('RGB'), ss)


def laptop_screen(w=512, h=320):
    """The archive job: a scanned ledger page, half catalogued."""
    im = Image.new('RGB', (w, h), (36, 42, 54))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w, 26), fill=(52, 60, 76))
    d.text((10, 4), 'Port archive  ·  ledger 1847, folio 212', font=font(15), fill=(210, 216, 226))
    page = paper(250, 270, 71, (0.90, 0.84, 0.70))
    pd = ImageDraw.Draw(page)
    r = rng(72)
    for k in range(13):
        y = 16 + k * 19
        pd.line((14, y + 12, 236, y + 12), fill=(150, 130, 100), width=1)
        x = 16
        while x < 220:
            l = int(r.integers(12, 46))
            pd.line((x, y + 6, x + l, y + 6), fill=(70, 52, 40), width=2)
            x += l + int(r.integers(5, 12))
    im.paste(page, (18, 38))
    for k, (label, done) in enumerate((('Vessel', True), ('Master', True), ('Cargo', True), ('Berth', False), ('Tide', False))):
        y = 44 + k * 50
        d.text((290, y), label, font=font(15, 'b'), fill=(170, 180, 196))
        d.rounded_rectangle((290, y + 20, 494, y + 42), radius=4, fill=(58, 68, 86) if done else (44, 50, 64),
                            outline=(96, 150, 200) if not done and k == 3 else (80, 90, 108))
        if done:
            d.line((298, y + 31, 298 + 60 + 30 * k, y + 31), fill=(214, 220, 230), width=3)
    d.rounded_rectangle((290, 290, 392, 312), radius=5, fill=(70, 140, 110))
    d.text((306, 292), 'Save entry', font=font(14, 'b'), fill=(240, 246, 240))
    return im


def tank(w=512, h=320):
    """The back of the aquarium: water, weed, gravel, light from above."""
    r = rng(81)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = ramp(yy / h, [(0.0, (0.42, 0.86, 0.90)), (0.55, (0.10, 0.52, 0.66)), (1.0, (0.04, 0.26, 0.40))])
    rays = np.clip(np.sin((xx + yy * 0.45) / 23.0) * 0.5 + 0.5, 0, 1) ** 3 * np.clip(1 - yy / h, 0, 1)
    a += 0.16 * rays[..., None]
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    for k in range(26):                                        # weed
        x = int(r.integers(10, w - 10)); top = int(r.integers(int(h * 0.25), int(h * 0.75)))
        g = (int(r.integers(20, 60)), int(r.integers(110, 170)), int(r.integers(60, 110)))
        d.line([(x + 12 * math.sin(t * 0.5 + k), h - 30 - t * (h - 30 - top) / 12) for t in range(13)], fill=g, width=int(r.integers(4, 9)))
    for k in range(5):                                         # rocks
        x = int(r.integers(20, w - 80)); s = int(r.integers(40, 90))
        d.ellipse((x, h - 34 - s // 2, x + s, h - 8), fill=(86 + k * 6, 92, 104))
    grav = arr(im)
    band = yy > h - 30
    speck = fbm(h, w, 100, 160, 2, r)
    grav[band] = (np.array((0.78, 0.68, 0.50), np.float32) * (0.6 + 0.6 * speck[..., None]))[band]
    return grav


def steam(size=128):
    r = rng(91)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2, yy - size / 2) / (size / 2)
    out = np.ones((size, size, 4), np.float32)
    out[..., 3] = np.clip(1 - rr, 0, 1) ** 1.4 * (0.45 + 0.55 * fbm(size, size, 5, 5, 3, r))
    return out


def gull(w=128, h=64):
    """A gull a long way off: two strokes."""
    ss = 4
    im, d = canvas(w, h, (60, 64, 84, 0), ss)
    W, H = w * ss, h * ss
    for sgn in (-1, 1):
        d.line([(W / 2, H * 0.62), (W / 2 + sgn * W * 0.22, H * 0.34), (W / 2 + sgn * W * 0.46, H * 0.50)],
               fill=(52, 56, 76, 255), width=14, joint='curve')
    return down(im, ss)


def vinyl(size=256):
    """A record: grooves, a label, a hole."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    ang = np.arctan2(yy - size / 2, xx - size / 2)
    a = np.zeros((size, size, 3), np.float32) + 0.05
    a += (0.035 * np.sin(rr * 260) + 0.10 * np.clip(np.cos(ang * 2 + 0.6), 0, 1) ** 6)[..., None]      # grooves, and the sheen across them
    label = rr < 0.36
    a[label] = (0.90, 0.48, 0.40)
    a[(rr < 0.36) & (np.abs(ang) < 0.5) & (rr > 0.12)] = (0.96, 0.90, 0.78)
    a[rr < 0.03] = 0.02
    return a


def braided(size=512, colours=((0.80, 0.72, 0.58), (0.44, 0.58, 0.62), (0.88, 0.60, 0.50), (0.93, 0.90, 0.82))):
    """A round braided rug: rings of plait."""
    r = rng(95)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    rr = np.hypot(xx - size / 2 + 0.5, yy - size / 2 + 0.5) / (size / 2)
    ang = np.arctan2(yy - size / 2, xx - size / 2)
    ring = np.floor(rr * 14).astype(int)
    a = np.array(colours, np.float32)[ring % len(colours)]
    plait = 0.80 + 0.22 * np.sin(ang * (10 + ring * 6) + ring) * np.sin((rr * 14 % 1) * math.pi)
    a = a * plait[..., None] * (0.92 + 0.12 * fbm(size, size, 8, 8, 3, r))[..., None]
    out = np.dstack([a, (rr < 0.985).astype(np.float32)])
    return out


def hob(size=256):
    ss = 2
    im, d = canvas(size, size, (22, 22, 26, 255), ss)
    S = size * ss
    for cx, cy, rad in ((0.30, 0.30, 0.19), (0.70, 0.30, 0.15), (0.30, 0.72, 0.15), (0.70, 0.72, 0.19)):
        for k, c in ((1.0, (70, 70, 78)), (0.72, (52, 52, 58))):
            d.ellipse((S * (cx - rad * k), S * (cy - rad * k), S * (cx + rad * k), S * (cy + rad * k)), outline=c + (255,), width=4)
    d.ellipse((S * 0.70 - S * 0.17, S * 0.72 - S * 0.17, S * 0.70 + S * 0.17, S * 0.72 + S * 0.17), outline=(220, 70, 40, 255), width=7)
    return down(im.convert('RGB'), ss)


def lampshade(colour=(1.0, 0.86, 0.62), w=128, h=128):
    """A cloth shade with the lamp lit inside it: brightest round the middle."""
    r = rng(97)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lit = 0.62 + 0.38 * np.exp(-((yy / h - 0.55) / 0.42) ** 2)
    return np.array(colour, np.float32) * (lit * (0.94 + 0.06 * np.sin(xx * 1.6)) * (0.95 + 0.08 * fbm(h, w, 6, 6, 2, r)))[..., None]


def file_cover(w=256, h=336):
    im = paper(w, h, 98, (0.84, 0.72, 0.50))
    d = ImageDraw.Draw(im)
    d.rectangle((30, 60, w - 30, 170), fill=(244, 238, 222), outline=(120, 96, 60), width=2)
    centred(d, 70, 'EVIDENCE', font(30, 'b'), (150, 30, 30), w)
    centred(d, 112, 'the Captain', font(24, 'i'), INK, w)
    centred(d, 140, 'vol. 3', font(18), INK, w)
    d.text((40, 220), 'do NOT file', font=font(26, hand=True), fill=(40, 60, 120))
    d.text((40, 258), '(still open)', font=font(24, hand=True), fill=(40, 60, 120))
    return im


# ── Go ──────────────────────────────────────────────────────────────────
a, n = boards(1, n=16, base=(0.74, 0.55, 0.34)); save('floor', a); save('floor_n', img(n).resize((1024, 1024), Image.LANCZOS))
save('wall', plaster(2, 512, CREAM))
save('wall_blue', plaster(3, 512, DUSK))
save('wainscot', planks(4, SAGE))
save('ceiling', planks(5, (0.92, 0.88, 0.78), n=4))
save('oak', woodgrain(6, (0.66, 0.47, 0.28)))
save('walnut', woodgrain(7, (0.40, 0.25, 0.16)))
save('white_wood', woodgrain(8, (0.95, 0.93, 0.88), depth=0.22))
save('beam', woodgrain(9, (0.52, 0.36, 0.22)))
for name, colour in (('oat', (0.84, 0.77, 0.64)), ('teal', TEAL), ('coral', (0.90, 0.50, 0.42)), ('mustard', (0.88, 0.68, 0.26)),
                     ('white', (0.96, 0.95, 0.91)), ('navy', (0.18, 0.25, 0.42)), ('pink', (0.94, 0.72, 0.74)),
                     ('sage', SAGE), ('grey', (0.62, 0.63, 0.66))):
    save('linen_' + name, linen(10 + len(name), colour))
save('knit_blue', knit(20, (0.56, 0.70, 0.82)))
save('knit_cream', knit(21, (0.93, 0.88, 0.76)))
save('basket', weave(22, (0.78, 0.62, 0.40)))
save('sisal', sisal(23))
save('sheer', cloth_folds(24, (0.97, 0.94, 0.86), 256, 512, depth=0.30, sheen=(0.03, 0.03, 0.02)))
save('coat_white', cloth_folds(25, (0.95, 0.95, 0.93), 256, 512, depth=0.34, sheen=(0.02, 0.02, 0.02)))
save('coat_yellow', cloth_folds(26, (0.95, 0.76, 0.20), 256, 512, depth=0.40, sheen=(0.05, 0.04, 0.0)))
save('tiles', tiles(27))
save('door', panel_door(28, (0.93, 0.91, 0.86), panels=((0.12, 0.05, 0.47, 0.44), (0.53, 0.05, 0.88, 0.44),
                                                          (0.12, 0.50, 0.47, 0.95), (0.53, 0.50, 0.88, 0.95))))
save('cabinet', panel_door(29, TEAL, 256, 256, panels=((0.10, 0.10, 0.90, 0.90),)))
save('wardrobe', panel_door(30, (0.90, 0.87, 0.78)))
save('spines', spines(31))
save('evidence', evidence_board())
save('fridge', fridge_door())
save('clock', clock_face())
save('screen', laptop_screen())
save('tank', tank())
save('steam', steam())
save('gull', gull())
save('vinyl', vinyl())
save('braided', braided())
save('hob', hob())
save('shade', lampshade())
save('shade_green', lampshade((0.42, 0.86, 0.60)))
save('file', file_cover())
save('glow', glow())
save('glow_soft', glow(colour=(1.0, 0.84, 0.58), power=1.5, peak=0.55))
save('glow_white', glow(colour=(1.0, 0.98, 0.92)))
# From art/: the view, the rug and quilt, the chart, and the sheets.
view = art('harbour')
# The view, with more sky over it: the top quarter turned over and laid above, melting into the plain
# night of the picture's top edge as it goes up — the colour of the lid over the view, so that looking
# up through the window never finds an edge. The dark at its foot likewise, for the ground under it.
low = arr(view)                                                        # at the size it was made: it is looked at closely
more = low.shape[0] // 4
night = low[:6].mean(axis=(0, 1))
k = np.linspace(1.0, 0.0, more, dtype=np.float32)[:, None, None]       # top of the strip … the seam
k = k * k * (3 - 2 * k)
save('harbour', np.concatenate([low[:more][::-1] * (1 - k) + night * k, low]))
save('night', np.tile(night, (8, 8, 1)))
save('quay', np.tile(low[-6:].mean(axis=(0, 1)), (8, 8, 1)))
save('sky', cover(view.crop((view.width // 3, 0, view.width * 2 // 3, view.height // 4)), 256, 256))
rug = art('rug')
save('rug', rug.crop((int(rug.width * 0.012), int(rug.height * 0.02), int(rug.width * 0.988), int(rug.height * 0.98))).resize((1024, 672), Image.LANCZOS))
save('quilt', art('quilt', 1024, 1024))
save('chart', art('chart', 1536, 1024))
save('pictures', atlas('pictures', [art(n) for n in PICTURES], 4, 512, bottom=False, pad=0.01))
save('tv', atlas('tv', [art(f'tv{k}', 512, 288) for k in range(1, 7)], 3, 512, bottom=False, pad=0.0, cell_h=288).convert('RGB'))
for name, cell, bottom in (('plants', 448, True), ('fish', 192, False), ('things', 320, True)):
    cells = sprites(name, 4, 2)
    if cells and len(cells) == 8:
        save(name, atlas(name, cells, 4, cell, bottom=bottom))
    else:
        print(f'!! {name}: found {len(cells or [])} cut-outs, wanted 8', flush=True)
kit.save_sprites()
print('done', flush=True)
