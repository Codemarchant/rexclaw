"""Paint the textures of Ara's Café (step 1 of 2; build_aras_cafe.py is step 2).

    python3 paint_textures.py <out_dir>

Runs with a system Python (numpy, Pillow, scipy), not Blender's. Surfaces,
cloth, the chalkboard, the noticeboard and the lettering are painted here;
the pictures come from art/ (made with an image generator) and none has a
stand-in:
    harbour.jpg            the view from the window, 2:1
    yard.jpg               the herb boxes out the back, through the half door
    painting_ship.jpg, rug.jpg (seen flat from above, edge to edge)
    crew.jpg, marguerite.jpg, ara_*.jpg, rex_cup.jpg, sal_tea.jpg,
    leo_window.jpg, evie_counter.jpg, print_*.jpg, poster_tea.jpg
                           the framed photographs and prints
and six sheets of cut-outs, 4 × 2 on a flat magenta ground:
    plants.jpg, things.jpg, tins.jpg, pastries.jpg, postcards.jpg,
    boats.jpg (side-on, whole to the keel)
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import paint_kit as kit
from paint_kit import (INK, arr, art, atlas, boards, c8, canvas, centred, cover, down, fbm, font, glow, gull, img, lampshade,
                       linen, normal_from_height, note, panel_door, paper, photo, pin, planks, plaster, rng, save, spines,
                       sprites, stick, weave, wisp, woodgrain)

kit.init(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'textures'), os.path.join(HERE, 'art'))

GREEN = (0.17, 0.33, 0.27)        # the woodwork: bottle green
CREAM = (0.95, 0.90, 0.78)
MUSTARD = (0.88, 0.68, 0.26)
TERRA = (0.80, 0.42, 0.28)
TEAL = (0.30, 0.52, 0.54)
CHALK = (236, 232, 220)
PICTURES = ['crew', 'marguerite', 'ara_eve', 'ara_keys', 'rex_cup', 'sal_tea', 'leo_window', 'evie_counter',
            'print_tea', 'print_herbs', 'poster_tea', 'print_cliff']


# ── Brick, tile, stone, leather ─────────────────────────────────────────
def brick(seed, size=1024, across=8, courses=24):
    """Old red brick in running bond, lime mortar. Returns (albedo, normal)."""
    r = rng(seed)
    bw, bh = size / across, size / courses
    gap = max(2, int(size * 0.007)) // 2
    col = np.zeros((size, size, 3), np.float32) + np.array((0.78, 0.72, 0.62), np.float32)
    ht = np.zeros((size, size), np.float32)
    tones = [(0.62, 0.30, 0.20), (0.56, 0.26, 0.18), (0.68, 0.36, 0.24), (0.50, 0.24, 0.18), (0.70, 0.42, 0.30)]
    for j in range(courses):
        y0, y1 = int(j * bh) + gap, int((j + 1) * bh) - gap
        for i in range(-1, across + 1):
            x0 = int(i * bw + (j % 2) * bw / 2)
            xs = np.arange(x0 + gap, int(x0 + bw) - gap) % size
            col[y0:y1, xs] = np.array(tones[int(r.integers(len(tones)))], np.float32) * (0.9 + 0.2 * r.random())
            ht[y0:y1, xs] = 1.0
    grime = fbm(size, size, 6, 6, 4, r)
    speck = fbm(size, size, 120, 120, 2, r)
    col *= (0.80 + 0.26 * grime + 0.14 * (speck - 0.5))[..., None]
    return col, normal_from_height(ht * 0.6 + 0.08 * speck, 3.0)


def floor_tiles(seed, size=512, n=4):
    """Encaustic floor tiles: a terracotta lozenge on cream, a teal quarter
    round in each corner (four of them make a ring where tiles meet)."""
    r = rng(seed)
    ss = 2
    im, d = canvas(size, size, c8(CREAM), ss)
    p = size * ss // n
    for j in range(n):
        for i in range(n):
            x, y = i * p, j * p
            cx, cy = x + p / 2, y + p / 2
            d.rectangle((x, y, x + p, y + p), fill=c8([v * (0.94 + 0.06 * r.random()) for v in CREAM]))
            for qx, qy in ((x, y), (x + p, y), (x, y + p), (x + p, y + p)):
                d.ellipse((qx - p * 0.30, qy - p * 0.30, qx + p * 0.30, qy + p * 0.30), fill=c8(TEAL))
                d.ellipse((qx - p * 0.17, qy - p * 0.17, qx + p * 0.17, qy + p * 0.17), fill=c8(CREAM))
            k = p * 0.30
            d.polygon([(cx, cy - k), (cx + k, cy), (cx, cy + k), (cx - k, cy)], fill=c8(TERRA))
            k = p * 0.11
            d.polygon([(cx, cy - k), (cx + k, cy), (cx, cy + k), (cx - k, cy)], fill=c8((0.22, 0.24, 0.26)))
    a = arr(down(im.convert('RGB'), ss))
    q = size // n
    for k in range(n):
        a[k * q:k * q + 2, :] *= 0.6; a[:, k * q:k * q + 2] *= 0.6
    return a * (0.88 + 0.16 * fbm(size, size, 6, 6, 4, r))[..., None]


def marble(seed, size=512):
    r = rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    warp = fbm(size, size, 4, 4, 4, r)
    vein = np.clip(1 - np.abs(np.sin((xx + 0.6 * yy) / size * 2 * math.pi * 2 + warp * 9)) * 16, 0, 1)
    fine = np.clip(1 - np.abs(np.sin((xx - 0.4 * yy) / size * 2 * math.pi * 3 + warp * 14 + 2)) * 30, 0, 1)
    shade = (0.93 + 0.08 * fbm(size, size, 6, 6, 3, r)) * (1 - 0.22 * vein - 0.10 * fine)
    return np.array((0.95, 0.93, 0.88), np.float32) * shade[..., None]


def leather(seed, colour, size=256):
    r = rng(seed)
    big = fbm(size, size, 4, 4, 4, r)
    pore = fbm(size, size, 96, 96, 2, r)
    crease = np.clip(1 - np.abs(fbm(size, size, 9, 9, 3, r) - 0.5) * 40, 0, 1)
    return np.array(colour, np.float32) * (0.80 + 0.26 * big + 0.10 * (pore - 0.5) - 0.16 * crease)[..., None]


def panelled(seed, colour, size=512, panels=((0.07, 0.10, 0.93, 0.90),), bevel=0.035):
    """Joinery seen from across a room: sunk panels, each with a bevel that
    is dark where it turns from the light and pale where it turns to it."""
    a = planks(seed, colour, n=1, size=size, vary=0.0)
    for x0, y0, x1, y1 in panels:
        X0, Y0, X1, Y1 = (int(v * size) for v in (x0, y0, x1, y1))
        b = int(bevel * size)
        a[Y0:Y1, X0:X1] *= 0.84                               # the sunk field
        a[Y0:Y0 + b, X0:X1] *= 0.62; a[Y0:Y1, X0:X0 + b] *= 0.72              # under the top rail, beside the left stile
        a[Y1 - b:Y1, X0:X1] *= 1.42; a[Y0:Y1, X1 - b:X1] *= 1.25              # the lit bevels
    return a


# ── Chalk, paper, paint ─────────────────────────────────────────────────
def chalked(board, draw):
    """Draw on a board in chalk: draw(d) on a clear layer, which is then
    rubbed thin here and there before it is laid on."""
    layer = Image.new('RGBA', board.size, (0, 0, 0, 0))
    draw(ImageDraw.Draw(layer))
    rub = 0.62 + 0.38 * fbm(board.height, board.width, 80, 80, 2, rng(41))
    a = arr(layer)
    a[..., 3] *= rub
    board.alpha_composite(img(a))


def chalkboard(w=1152, h=1024):
    """The menu. What is not on it is on purpose: the bitter blend is
    offered, never listed."""
    r = rng(40)
    slate = np.array((0.12, 0.15, 0.14), np.float32) * (0.75 + 0.5 * fbm(h, w, 5, 5, 4, r) + 0.2 * fbm(h, w, 40, 40, 2, r))[..., None]
    board = img(slate).convert('RGBA')
    yellow, pink, mint = (246, 214, 120), (240, 168, 160), (160, 214, 196)

    def draw(d):
        centred(d, 26, 'TODAY', font(96, hand=True), CHALK, w)
        d.line([(w / 2 - 190 + k * 20, 150 + 7 * math.sin(k * 0.9)) for k in range(20)], fill=yellow, width=6)
        col = {0: 70, 1: 620}
        y = {0: 190, 1: 190}

        def head(c, text, colour):
            d.text((col[c], y[c]), text, font=font(58, hand=True), fill=colour)
            y[c] += 78

        def row(c, text, price):
            f = font(40, hand=True)
            d.text((col[c] + 8, y[c]), text, font=f, fill=CHALK)
            d.text((col[c] + 440, y[c]), price, font=f, fill=CHALK)
            y[c] += 56

        head(0, 'Tea', mint)
        for item in (('Harbour breakfast', '2'), ('Jasmine pearls', '3'), ('Mint from the yard', '2'), ('Chamomile & honey', '2')):
            row(0, *item)
        y[0] += 22
        head(0, 'Coffee', yellow)
        for item in (('Pot of coffee', '2'), ('Flat white', '3'), ('The strong one', '3')):
            row(0, *item)
        head(1, 'Bakes', pink)
        for item in (('Croissant', '2'), ('Cinnamon bun', '3'), ('Lemon tart', '3'), ('Scone, jam & cream', '3'),
                     ('Strawberry cake', '4'), ('Blueberry muffin', '2')):
            row(1, *item)
        # A cup, steaming.
        cx, cy = 870, 730
        d.arc((cx - 90, cy - 70, cx + 90, cy + 110), 0, 180, fill=CHALK, width=7)
        d.line((cx - 90, cy + 20, cx + 90, cy + 20), fill=CHALK, width=7)
        d.arc((cx + 70, cy + 22, cx + 140, cy + 82), 270, 90, fill=CHALK, width=7)
        d.line((cx - 120, cy + 118, cx + 120, cy + 118), fill=CHALK, width=6)
        for k in (-1, 0, 1):
            d.line([(cx + k * 40 + 12 * math.sin(t * 0.8 + k), cy - 4 - t * 9) for t in range(11)], fill=mint, width=5)
        centred(d, h - 122, 'No clock in here.  Take your time.', font(46, hand=True), yellow, w)

    chalked(board, draw)
    return board.convert('RGB')


def postcard_back(w=300, h=200):
    """Marguerite's card, as it comes once a year."""
    im = paper(w, h, 43, (0.96, 0.94, 0.86))
    d = ImageDraw.Draw(im)
    d.line((w * 0.56, 16, w * 0.56, h - 16), fill=(150, 140, 130), width=2)
    d.rectangle((w - 62, 14, w - 16, 70), outline=(150, 90, 80), width=3)
    for k in range(3):
        d.line((w * 0.62, 104 + k * 26, w - 18, 104 + k * 26), fill=(150, 140, 130), width=1)
    d.text((w * 0.62, 80), 'Ara', font=font(24, hand=True), fill=(40, 60, 120))
    d.text((16, 40), 'Knees fine.', font=font(30, hand=True), fill=(40, 60, 120))
    d.text((16, 86), 'Mornings?', font=font(30, hand=True), fill=(40, 60, 120))
    d.text((70, 140), '— M.', font=font(28, hand=True), fill=(40, 60, 120))
    return im


def noticeboard(cards, w=1408, h=960):
    """The board by the door: Marguerite's postcards, and what the harbour
    and the crew have pinned up."""
    r = rng(44)
    cork = np.array((0.66, 0.48, 0.30), np.float32) * (0.80 + 0.30 * fbm(h, w, 90, 90, 3, r) + 0.12 * fbm(h, w, 6, 6, 3, r))[..., None]
    board = img(cork).convert('RGBA')
    card = lambda k, wd: Image.fromarray((np.clip(cards[k], 0, 1) * 255).astype(np.uint8), 'RGBA').resize((wd, int(wd * cards[k].shape[0] / cards[k].shape[1])), Image.LANCZOS)
    stick(board, card(0, 300), 50, 50, -4.0)
    stick(board, card(5, 300), 250, 150, 3.0)
    stick(board, card(2, 300), 60, 300, 2.0)
    stick(board, postcard_back(), 330, 370, -3.0)
    tide = paper(260, 250, 45, (0.95, 0.95, 0.92))
    d = ImageDraw.Draw(tide)
    centred(d, 10, 'HIGH WATER', font(24, 'b'), INK, 260)
    for k, t in enumerate(('Mon   06:12   18:40', 'Tue   07:03   19:28', 'Wed   07:51   20:15', 'Thu   08:36   21:02', 'Fri   09:20   21:47')):
        d.text((18, 52 + k * 36), t, font=font(21), fill=INK)
    stick(board, tide, 640, 50, 2.0)
    stick(board, note(330, 170, 46, ['REXMAW sails Thursday.', 'Muster 06:00.', '                  — Rex'], (0.80, 0.90, 0.95), 27), 960, 60, -2.5)
    stick(board, note(310, 150, 47, ['Table six is kept', "when Miren's boat is in."], (0.98, 0.93, 0.62), 28), 1030, 290, 3.0)
    stick(board, note(330, 230, 48, ['LOST:', 'one very small', "admiral's hat.", 'Ask the seagull.'], (0.97, 0.86, 0.84), 27), 660, 340, -3.5)
    bill = paper(280, 360, 49, (0.94, 0.90, 0.78))
    d = ImageDraw.Draw(bill)
    d.rectangle((10, 10, 270, 350), outline=(120, 40, 40), width=4)
    centred(d, 30, 'OPERA', font(50, 'b'), (120, 40, 40), 280)
    centred(d, 88, 'HOUSE', font(50, 'b'), (120, 40, 40), 280)
    centred(d, 170, 'the new season', font(28, 'i'), INK, 280)
    d.line((60, 222, 220, 222), fill=(120, 40, 40), width=3)
    centred(d, 244, 'stage door:', font(22), INK, 280)
    centred(d, 276, 'ask for Leo', font(24, 'i'), INK, 280)
    stick(board, bill, 60, 560, 3.0)
    stick(board, photo('evie_counter', 190, 190, 12, 44), 400, 620, -5.0)
    stick(board, note(300, 130, 50, ['Evie has had her treat.', 'One.  (She will say none.)'], (0.84, 0.92, 0.96), 23), 640, 630, 2.0)
    stick(board, note(250, 170, 51, ['Thurs, 6pm.', 'Bring the napkin.', '                — E'], (0.96, 0.93, 0.80), 25), 700, 770, -2.0)
    stick(board, note(340, 150, 52, ['Rosemary cuttings: free.', 'Ask at the counter.'], (0.86, 0.94, 0.84), 27), 1010, 520, -3.0)
    stick(board, card(7, 280), 1040, 720, 4.0)
    d = ImageDraw.Draw(board)
    for k, p in enumerate(((200, 62), (400, 160), (210, 312), (480, 382), (770, 62), (1125, 72), (1185, 300), (825, 362), (200, 572),
                           (495, 632), (790, 610), (825, 790), (1180, 532), (1180, 732))):
        pin(d, *p, colour=((190, 50, 46), (40, 90, 150), (220, 170, 40), (60, 130, 90))[k % 4])
    return board.convert('RGB')


def lettering(w=2304, h=256):
    """What is painted on the window glass, in gold, as it reads from the
    quay (from inside it is seen from behind, back to front)."""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    gold, edge = (236, 196, 104, 255), (70, 46, 22, 255)
    for k, (text, size) in enumerate((('TEA', 120), ('DOCKSIDE CAFÉ', 96), ('COFFEE', 120))):
        f = font(size, 'b')
        tw = d.textlength(text, font=f)
        d.text((k * w / 3 + (w / 3 - tw) / 2, (h - size) / 2 - 10), text, font=f, fill=gold, stroke_width=5, stroke_fill=edge)
    return im


def register_face(size=256):
    """The till's front: a little window for the sum, rows of round keys."""
    ss = 2
    im, d = canvas(size, size, c8((0.92, 0.88, 0.76)), ss)
    S = size * ss
    brass = c8((0.80, 0.62, 0.30))
    d.rounded_rectangle((S * 0.10, S * 0.07, S * 0.90, S * 0.30), radius=14, fill=(34, 40, 38, 255), outline=brass, width=10)
    centred(d, S * 0.105, '2.00', font(int(S * 0.15), 'b'), (240, 232, 200, 255), S)
    for j in range(4):
        for i in range(5):
            cx, cy = S * (0.18 + i * 0.16), S * (0.44 + j * 0.135)
            d.ellipse((cx - S * 0.055, cy - S * 0.05, cx + S * 0.055, cy + S * 0.05), fill=(250, 248, 240, 255), outline=(60, 54, 50, 255), width=6)
    d.rectangle((S * 0.04, S * 0.955, S * 0.96, S), fill=brass)
    return down(im.convert('RGB'), ss)


def machine_face(w=512, h=288):
    """The coffee machine's front: brushed steel, two gauges, its switches."""
    r = rng(53)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    steel = (0.66 + 0.16 * np.sin(yy / h * math.pi) + 0.10 * (fbm(h, w, 3, 200, 2, r) - 0.5))[..., None] * np.array((0.96, 0.98, 1.0), np.float32)
    ss = 2
    im = img(steel).convert('RGBA').resize((w * ss, h * ss), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    W, H = w * ss, h * ss
    for cx, ang in ((W * 0.36, -0.7), (W * 0.64, 0.5)):
        cy, rad = H * 0.34, H * 0.20
        d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=(246, 244, 236, 255), outline=(60, 60, 64, 255), width=10)
        for k in range(9):
            a = math.radians(-120 + k * 30)
            d.line((cx + math.sin(a) * rad * 0.70, cy - math.cos(a) * rad * 0.70, cx + math.sin(a) * rad * 0.86, cy - math.cos(a) * rad * 0.86),
                   fill=(60, 60, 64, 255), width=4)
        d.line((cx, cy, cx + math.sin(ang) * rad * 0.7, cy - math.cos(ang) * rad * 0.7), fill=(190, 50, 46, 255), width=7)
    for k in range(4):
        cx = W * (0.12 + 0.045 * k)
        d.ellipse((cx - 16, H * 0.72 - 16, cx + 16, H * 0.72 + 16), fill=((90, 200, 130, 255) if k == 0 else (40, 40, 44, 255)), outline=(40, 40, 44, 255), width=4)
    d.rounded_rectangle((W * 0.40, H * 0.70, W * 0.60, H * 0.82), radius=8, fill=c8((0.80, 0.62, 0.30)))
    for k in range(6):
        d.line((W * (0.80 + 0.022 * k), H * 0.62, W * (0.80 + 0.022 * k), H * 0.86), fill=(50, 52, 56, 255), width=6)
    return down(im.convert('RGB'), ss)


def open_sign(w=256, h=160):
    im, d = canvas(w, h, c8(CREAM), 2)
    W, H = w * 2, h * 2
    d.rounded_rectangle((8, 8, W - 8, H - 8), radius=20, outline=c8(GREEN), width=12)
    centred(d, H * 0.10, 'OPEN', font(int(H * 0.46), 'b'), c8(GREEN), W)
    centred(d, H * 0.66, "come in, the kettle's on", font(int(H * 0.13), 'i'), c8(TERRA), W)
    return down(im.convert('RGB'), 2)


def numeral(n, size=96):
    im, d = canvas(size, size, c8(CREAM), 2)
    S = size * 2
    d.rectangle((6, 6, S - 6, S - 6), outline=c8((0.80, 0.62, 0.30)), width=8)
    centred(d, S * 0.10, str(n), font(int(S * 0.66), 'b'), c8(GREEN), S)
    return down(im.convert('RGB'), 2)


def pane(size=64):
    """Glass, as far as it shows at all: a faint sheen, a streak across."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    out = np.ones((size, size, 4), np.float32)
    streak = np.clip(1 - np.abs((xx + yy) / size - 0.8) * 6, 0, 1)
    out[..., 3] = 0.06 + 0.14 * streak
    return out


def flame(w=64, h=128):
    """One tongue of flame: pale at its heart, orange out to the edge."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = 1 - yy / h                                             # 0 at the foot, 1 at the tip
    half = (np.sin(np.clip(t, 0, 1) ** 0.6 * math.pi) * 0.42 + 0.02) * (1 - 0.3 * t)
    x = np.abs(xx / w - 0.5 - 0.05 * np.sin(t * 5))
    inner = np.clip(1 - x / np.maximum(half, 1e-3), 0, 1)
    out = np.zeros((h, w, 4), np.float32)
    heat = inner * (1 - 0.55 * t)
    out[..., 0] = 1.0
    out[..., 1] = 0.42 + 0.56 * heat
    out[..., 2] = 0.10 + 0.60 * heat ** 2
    out[..., 3] = np.clip(inner * 1.6, 0, 1) ** 1.2 * np.clip(t * 12, 0, 1)
    return out


def embers(w=128, h=64):
    r = rng(54)
    n = fbm(h, w, 6, 12, 3, r)
    yy = np.mgrid[0:h, 0:w][0].astype(np.float32) / h
    heat = np.clip(n * 1.5 - 0.35 + 0.35 * yy, 0, 1)
    return np.stack([0.20 + 0.80 * heat, 0.05 + 0.50 * heat ** 2, 0.02 + 0.10 * heat ** 3], -1)


def butterfly(size=64):
    """A small white butterfly, wings spread, seen flat."""
    im, d = canvas(size, size, (250, 246, 230, 0), 4)
    S = size * 4
    for sx in (-1, 1):
        d.ellipse((S / 2 + sx * S * 0.05 - (S * 0.38 if sx < 0 else 0), S * 0.10, S / 2 + sx * S * 0.05 + (S * 0.38 if sx > 0 else 0), S * 0.56),
                  fill=(252, 248, 232, 255), outline=(90, 80, 70, 255), width=5)
        d.ellipse((S / 2 + sx * S * 0.04 - (S * 0.28 if sx < 0 else 0), S * 0.48, S / 2 + sx * S * 0.04 + (S * 0.28 if sx > 0 else 0), S * 0.86),
                  fill=(250, 240, 200, 255), outline=(90, 80, 70, 255), width=5)
    d.line((S / 2, S * 0.16, S / 2, S * 0.84), fill=(60, 50, 44, 255), width=12)
    return down(im, 4)


# ── Go ──────────────────────────────────────────────────────────────────
a, n = boards(1, n=16, base=(0.64, 0.45, 0.27)); save('floor', a); save('floor_n', img(n).resize((1024, 1024), Image.LANCZOS))
a, n = brick(2); save('brick', a); save('brick_n', n)
save('floor_tiles', floor_tiles(3))
save('wall', plaster(4, 512, CREAM))
save('wainscot', planks(5, GREEN))
save('ceiling', planks(6, (0.93, 0.89, 0.79), n=4))
save('oak', woodgrain(7, (0.66, 0.47, 0.28)))
save('walnut', woodgrain(8, (0.38, 0.24, 0.15)))
save('beam', woodgrain(9, (0.36, 0.25, 0.16)))
save('green_wood', woodgrain(10, GREEN, depth=0.30))
save('white_wood', woodgrain(11, (0.95, 0.92, 0.84), depth=0.22))
save('marble', marble(12))
save('slate', plaster(13, 256, (0.36, 0.38, 0.40)))
save('leather', leather(14, (0.58, 0.31, 0.16)))
for k, (name, colour) in enumerate((('green', (0.24, 0.42, 0.34)), ('mustard', MUSTARD), ('cream', (0.95, 0.92, 0.84)),
                                    ('terracotta', TERRA), ('teal', TEAL))):
    save('linen_' + name, linen(20 + k, colour))
save('basket', weave(26, (0.78, 0.62, 0.40)))
save('shade', lampshade())
save('spines', spines(27))
save('counter', panelled(28, GREEN))
save('cabinet', panel_door(29, GREEN, 256, 256, panels=((0.10, 0.10, 0.90, 0.90),)))
save('cabinet_cream', panel_door(30, (0.93, 0.90, 0.80), 256, 256, panels=((0.10, 0.10, 0.90, 0.90),)))
save('door', panel_door(31, GREEN, 256, 512, panels=((0.12, 0.60, 0.88, 0.95),)))
save('half_door', panel_door(32, GREEN, 256, 256, panels=((0.10, 0.10, 0.48, 0.90), (0.52, 0.10, 0.90, 0.90))))
save('chalk', chalkboard())
save('lettering', lettering())
save('register', register_face())
save('machine', machine_face())
save('open', open_sign())
save('num5', numeral(5)); save('num6', numeral(6))
save('pane', pane())
save('flame', flame())
save('embers', embers())
save('butterfly', butterfly())
save('steam', wisp())
save('gull', gull(colour=(74, 64, 70)))
save('glow', glow())
save('glow_soft', glow(colour=(1.0, 0.84, 0.58), power=1.5, peak=0.55))
save('glow_white', glow(colour=(1.0, 0.97, 0.86)))
# From art/. The view, with more sky over it: the top quarter turned over and laid above, melting into the
# plain colour of the picture's top edge as it goes up — the colour of the lid over the view, so that
# looking up through the window never finds an edge. The dark at its foot likewise, for the ground.
view = art('harbour')
low = arr(view)                                                        # at the size it was made: it is looked at closely
more = low.shape[0] // 4
high = low[:6].mean(axis=(0, 1))
k = np.linspace(1.0, 0.0, more, dtype=np.float32)[:, None, None]       # top of the strip … the seam
k = k * k * (3 - 2 * k)
save('harbour', np.concatenate([low[:more][::-1] * (1 - k) + high * k, low]))
save('high', np.tile(high, (8, 8, 1)))
save('quay', np.tile(low[-6:].mean(axis=(0, 1)), (8, 8, 1)))
save('sky', cover(view.crop((view.width * 6 // 20, 0, view.width * 10 // 20, view.height * 3 // 10)), 256, 256))
save('yard', cover(art('yard'), 960, 1280))
save('ship', art('painting_ship', 1200, 800))
rug = art('rug')
save('rug', rug.crop((int(rug.width * 0.012), int(rug.height * 0.015), int(rug.width * 0.988), int(rug.height * 0.985))).resize((1024, 683), Image.LANCZOS))
save('pictures', atlas('pictures', [art(n) for n in PICTURES], 4, 512, bottom=False, pad=0.01))
cards = sprites('postcards', 4, 2)
save('board', noticeboard(cards))
save('postcards', atlas('postcards', cards, 4, 256, bottom=False))
for name, cell, bottom in (('plants', 448, True), ('things', 320, True), ('tins', 256, True), ('pastries', 256, True), ('boats', 384, True)):
    cells = sprites(name, 4, 2)
    if cells and len(cells) == 8:
        sheet = atlas(name, cells, 4, cell, bottom=bottom)
        save(name, sheet)
        if name == 'boats':                                            # what the water gives back of them: dim, and a little blue
            b = arr(sheet)
            b[..., :3] = b[..., :3] * 0.5 + np.array((0.16, 0.20, 0.26), np.float32)
            b[..., 3] *= 0.34
            save('boats_wake', img(b).filter(ImageFilter.GaussianBlur(1.5)))
    else:
        print(f'!! {name}: found {len(cells or [])} cut-outs, wanted 8', flush=True)
kit.save_sprites()
print('done', flush=True)
