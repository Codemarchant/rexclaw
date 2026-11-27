"""Paint the textures of Rex's Cabin (step 1 of 2; build_rexs_cabin.py is step 2).

    python3 paint_textures.py <out_dir>

Runs with a system Python (numpy, Pillow, scipy), not Blender's. Surfaces,
cloth, the papers, the ledgers and the signal flags are painted here; the
pictures come from art/ (made with an image generator) and none has a
stand-in:
    harbour.jpg            the view astern, 2:1: the pier and the town, the
                           afterglow, the lighthouse
    rug.jpg, quilt.jpg     seen flat from above, edge to edge
    chart.jpg, chart_hole.jpg, ballad.jpg
                           framed on the walls
    crew.jpg, ma_*.jpg, rex_boy.jpg, rosa.jpg, birthday.jpg, quiz.jpg,
    duchess_pier.jpg, renaming.jpg, photo_porch.jpg, photo_calib.jpg,
    rex_cup.jpg            the framed photographs
four sheets of cut-outs, 4 × 2 on a flat magenta ground:
    things.jpg, things2.jpg, plants.jpg, boats.jpg (side-on, whole to the keel)
and one cut-out alone: duchess.jpg (from the front, cut off below).
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import paint_kit as kit
from paint_kit import (INK, arr, art, atlas, boards, c8, canvas, centred, cloth_folds, cover, down, fbm, font, glow, gull, img, linen,
                       normal_from_height, note, panel_door, paper, photo, pin, planks, plaster, rng, save, spines, sprites,
                       stick, weave, wisp, woodgrain)

kit.init(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'textures'), os.path.join(HERE, 'art'))

NAVY = (0.13, 0.20, 0.34)         # the paintwork and the cloth: navy, cream, rust
CREAM = (0.94, 0.90, 0.78)
RUST = (0.70, 0.27, 0.18)
MUSTARD = (0.86, 0.66, 0.26)
MAHOGANY = (0.46, 0.23, 0.13)
BLUE = (40, 60, 120)              # ink in a pen
RED = (150, 40, 36)
PICTURES = ['crew', 'ma_rex', 'ma_shop', 'ma_pie', 'rex_boy', 'rosa', 'birthday', 'quiz', 'duchess_pier', 'renaming',
            'photo_porch', 'photo_calib', 'rex_cup']
SKY = 0.25                        # the view carries that much more sky above the picture's own top
LAMP_BOX = (0.80, 0.96, 0.30, 0.46)     # where in the harbour picture to look for the lighthouse's lamp (u0, u1, v0, v1)
SIGNAL = 'REXMAW'                 # what the bunting spells, in the flags of the signal code


# ── Wood, cloth, leather ────────────────────────────────────────────────
def panelled(seed, colour, size=512, panels=((0.08, 0.09, 0.92, 0.91),), bevel=0.03):
    """Joinery in varnished wood, its grain running up: sunk panels, each
    with a bevel that is dark where it turns from the light and pale where
    it turns to it."""
    a = np.rot90(woodgrain(seed, colour, size)).copy()
    for x0, y0, x1, y1 in panels:
        X0, Y0, X1, Y1 = (int(v * size) for v in (x0, y0, x1, y1))
        b = int(bevel * size)
        a[Y0:Y1, X0:X1] *= 0.86
        a[Y0:Y0 + b, X0:X1] *= 0.60; a[Y0:Y1, X0:X0 + b] *= 0.72
        a[Y1 - b:Y1, X0:X1] *= 1.40; a[Y0:Y1, X1 - b:X1] *= 1.24
    return a


def ticking(seed, size=256, n=8):
    """Mattress ticking: cream, with navy stripes in pairs."""
    a = linen(seed, (0.93, 0.90, 0.82), size)
    p = size // n
    navy = np.array(NAVY, np.float32)
    for k in range(n):
        x = k * p + p // 2
        for x0, x1, s in ((x - 4, x + 2, 0.7), (x + 6, x + 8, 0.6)):
            a[:, x0:x1] = a[:, x0:x1] * (1 - s) + navy * s
    return a


def leather(seed, colour, size=256):
    r = rng(seed)
    big = fbm(size, size, 4, 4, 4, r)
    pore = fbm(size, size, 96, 96, 2, r)
    crease = np.clip(1 - np.abs(fbm(size, size, 9, 9, 3, r) - 0.5) * 40, 0, 1)
    return np.array(colour, np.float32) * (0.80 + 0.26 * big + 0.10 * (pore - 0.5) - 0.16 * crease)[..., None]


def tiles(seed, size=256, n=4):
    """The stove's surround: cream tiles, a small navy figure on each."""
    r = rng(seed)
    ss = 2
    im, d = canvas(size, size, c8(CREAM), ss)
    p = size * ss // n
    navy = c8(NAVY)
    for j in range(n):
        for i in range(n):
            x, y = i * p, j * p
            d.rectangle((x, y, x + p, y + p), fill=c8([v * (0.95 + 0.05 * r.random()) for v in (0.95, 0.93, 0.86)]))
            cx, cy = x + p / 2, y + p / 2
            if (i + j) % 2 == 0:                               # an anchor
                d.line((cx, cy - p * 0.24, cx, cy + p * 0.22), fill=navy, width=7)
                d.line((cx - p * 0.12, cy - p * 0.12, cx + p * 0.12, cy - p * 0.12), fill=navy, width=7)
                d.arc((cx - p * 0.22, cy - p * 0.14, cx + p * 0.22, cy + p * 0.26), 20, 160, fill=navy, width=7)
                d.ellipse((cx - p * 0.05, cy - p * 0.33, cx + p * 0.05, cy - p * 0.23), outline=navy, width=6)
            else:                                              # a fish
                d.ellipse((cx - p * 0.22, cy - p * 0.10, cx + p * 0.12, cy + p * 0.10), outline=navy, width=7)
                d.polygon([(cx + p * 0.10, cy), (cx + p * 0.26, cy - p * 0.12), (cx + p * 0.26, cy + p * 0.12)], outline=navy, width=6)
            for qx, qy in ((x, y), (x + p, y), (x, y + p), (x + p, y + p)):
                d.ellipse((qx - p * 0.07, qy - p * 0.07, qx + p * 0.07, qy + p * 0.07), fill=navy)
    a = arr(down(im.convert('RGB'), ss))
    q = size // n
    for k in range(n):
        a[k * q:k * q + 2, :] *= 0.62; a[:, k * q:k * q + 2] *= 0.62
    return a * (0.90 + 0.14 * fbm(size, size, 6, 6, 4, r))[..., None]


# ── Ledgers and flags ───────────────────────────────────────────────────
def logs(w=1024, h=256, n=16):
    """The old logbooks' spines, side by side: bound alike, numbered in
    order, a paper label on each."""
    r = rng(60)
    im = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(im)
    cw = w // n
    cloth = [(0.40, 0.14, 0.12), (0.30, 0.20, 0.13), (0.38, 0.16, 0.12), (0.26, 0.18, 0.13), (0.42, 0.18, 0.12)]
    numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI']
    for k in range(n):
        c = np.clip(np.array(cloth[k % len(cloth)]) * (0.85 + 0.3 * r.random()), 0, 1)
        x0 = k * cw
        d.rectangle((x0, 0, x0 + cw, h), fill=c8(c)[:3])
        for y in (int(h * 0.06), int(h * 0.10), int(h * 0.88), int(h * 0.92)):
            d.line((x0 + 3, y, x0 + cw - 3, y), fill=(196, 160, 90), width=2)
        d.rectangle((x0 + 7, int(h * 0.18), x0 + cw - 7, int(h * 0.52)), fill=(232, 222, 196))
        centred(d, h * 0.20, 'LOG', font(15, 'b'), INK, cw, x0)
        centred(d, h * 0.32, numerals[k], font(19, 'b'), RED, cw, x0)
        d.line((x0, 0, x0, h), fill=tuple(int(v * 0.5) for v in c8(c)[:3]), width=2)
        d.line((x0 + cw - 1, 0, x0 + cw - 1, h), fill=tuple(int(v * 0.7) for v in c8(c)[:3]), width=1)
    return arr(im) * (0.90 + 0.14 * fbm(h, w, 6, 24, 3, r))[..., None]


def flags(letters, w=128, h=96):
    """The bunting's flags, one after another in a strip: the letters of
    the international code of signals."""
    red, blue, yellow, white = (196, 44, 40), (32, 62, 146), (240, 200, 60), (244, 240, 230)
    strip = Image.new('RGB', (w * len(letters), h))
    for k, ch in enumerate(letters):
        im = Image.new('RGB', (w, h), white)
        d = ImageDraw.Draw(im)
        if ch == 'R':                                          # red, a yellow cross
            d.rectangle((0, 0, w, h), fill=red)
            d.rectangle((w * 0.4, 0, w * 0.6, h), fill=yellow); d.rectangle((0, h * 0.38, w, h * 0.62), fill=yellow)
        elif ch == 'E':                                        # blue over red
            d.rectangle((0, 0, w, h / 2), fill=blue); d.rectangle((0, h / 2, w, h), fill=red)
        elif ch == 'X':                                        # white, a blue cross
            d.rectangle((w * 0.4, 0, w * 0.6, h), fill=blue); d.rectangle((0, h * 0.38, w, h * 0.62), fill=blue)
        elif ch == 'M':                                        # blue, a white saltire
            d.rectangle((0, 0, w, h), fill=blue)
            d.line((0, 0, w, h), fill=white, width=18); d.line((0, h, w, 0), fill=white, width=18)
        elif ch == 'A':                                        # white and blue, side by side
            d.rectangle((w / 2, 0, w, h), fill=blue)
        elif ch == 'W':                                        # blue round white round red
            d.rectangle((0, 0, w, h), fill=blue)
            d.rectangle((w * 0.16, h * 0.18, w * 0.84, h * 0.82), fill=white)
            d.rectangle((w * 0.32, h * 0.36, w * 0.68, h * 0.64), fill=red)
        d.rectangle((0, 0, w, 5), fill=(236, 230, 214))        # the tape it is sewn to
        strip.paste(im, (k * w, 0))
    r = rng(61)
    a = arr(strip) * (0.86 + 0.20 * fbm(h, w * len(letters), 5, 30, 3, r))[..., None]
    kit.SPRITES['flags'] = [{'u0': k / len(letters), 'u1': (k + 1) / len(letters), 'v0': 0.0, 'v1': 1.0, 'aspect': w / h}
                            for k in range(len(letters))]
    return a


# ── Paper ───────────────────────────────────────────────────────────────
def ruled(w, h, seed, gap=34, top=60, margin=None):
    """A ledger page: feint lines, a red margin."""
    im = paper(w, h, seed, (0.95, 0.92, 0.82))
    d = ImageDraw.Draw(im)
    for y in range(top, h - 16, gap):
        d.line((12, y, w - 12, y), fill=(176, 192, 204), width=1)
    if margin:
        d.line((margin, 10, margin, h - 10), fill=(204, 120, 110), width=2)
    return im, d


def written(d, x, y, lines, size=26, fill=BLUE, gap=34, hand=True):
    f = font(size, hand=hand)
    for k, ln in enumerate(lines):
        d.text((x, y + k * gap), ln, font=f, fill=fill)


def tally_marks(d, x, y, n, per_row=5, fill=INK):
    """n strokes in fives, the fifth struck through the four."""
    k = 0; row = 0; col = 0
    while k < n:
        gx = x + col * 44; gy = y + row * 40
        for j in range(min(4, n - k)):
            d.line((gx + j * 7, gy, gx + j * 7 - 2, gy + 26), fill=fill, width=3)
        k += min(4, n - k)
        if k < n:
            d.line((gx - 6, gy + 20, gx + 28, gy + 5), fill=fill, width=3)
            k += 1
        col += 1
        if col == per_row:
            col = 0; row += 1


def manifest(w=1024, h=660):
    """The manifest, open on the desk at today: what came aboard and what
    is owed on the left, the day's entries on the right."""
    im = Image.new('RGB', (w, h), (70, 30, 24))
    for k, x in enumerate((14, w // 2 + 4)):
        page, d = ruled(w // 2 - 18, h - 28, 62 + k, margin=70 if k == 0 else None)
        if k == 0:
            centred(d, 14, 'REXMAW — manifest', font(26, 'b'), INK, page.width)
            rows = (('12', 'casks lamp oil', 'stowed'), ('40', 'fathom rope, 3-strand', 'stowed'), ('6', 'crates, opera scenery', 'fwd hold'),
                    ('2', 'bags Chum Crunch', 'ballast'), ('1', 'tin mountain leaf', 'galley'), ('9', 'water barrels', 'full'),
                    ('1', 'fish pie', 'eaten'), ('5', 'hands', 'aboard'))
            for j, (n, what, where) in enumerate(rows):
                y = 66 + j * 68
                d.text((22, y), n, font=font(27, hand=True), fill=BLUE)
                d.text((86, y), what, font=font(27, hand=True), fill=BLUE)
                d.text((348, y), where, font=font(23, hand=True), fill=RED)
        else:
            written(d, 24, 30, ['Wind SW, light. Glass steady.', 'Chandler: quoted 9, paid 6.', 'Rope checked. Water checked.',
                                'Complaint no. 47 received (L.)', 'Filed: morale.', 'Tide window Thursday: tight.'], 26, gap=68)
            d.text((24, h - 150), 'All hands.', font=font(40, hand=True), fill=BLUE)
            d.text((24, h - 100), 'All accounted for.', font=font(40, hand=True), fill=BLUE)
        im.paste(page, (x, 14))
    d = ImageDraw.Draw(im)
    d.line((w // 2, 10, w // 2, h - 10), fill=(60, 30, 24), width=6)
    d.line((w // 2 - 6, 14, w // 2 - 6, h - 14), fill=(200, 190, 168), width=3)
    return im


def old_log(w=1024, h=660):
    """One of the old logbooks, open at its back cover: two columns of
    strokes with no heading, 61 to 58; on the page before, among the
    provisioning, a sprig pressed flat."""
    im = Image.new('RGB', (w, h), (52, 28, 22))
    page, d = ruled(w // 2 - 18, h - 28, 64)
    written(d, 24, 30, ['Provisioned at the island.', 'Limes, 2 baskets. Water, sweet.', 'Salt pork — refused. Rightly.', '', '', '', '',
                        'Captain owes me three coppers', 'and an apology.', 'Intend to collect both.'], 25, fill=(70, 54, 40), gap=56)
    for k in range(9):                                         # the sprig: a dry stem, a few faded flowers
        t = k / 8
        px, py = 150 + 210 * t, 330 - 60 * math.sin(t * 2.2)
        if k:
            d.line((qx, qy, px, py), fill=(112, 96, 60), width=4)
        if k % 2 == 1:
            for sgn in (-1, 1):
                d.line((px, py, px + 22, py + sgn * 26), fill=(112, 96, 60), width=3)
                d.ellipse((px + 12, py + sgn * 26 - 11, px + 34, py + sgn * 26 + 11), fill=(206, 150, 150), outline=(150, 100, 104))
        qx, qy = px, py
    im.paste(page, (14, 14))
    back = paper(w // 2 - 18, h - 28, 65, (0.80, 0.72, 0.56))
    d = ImageDraw.Draw(back)
    mid = back.width // 2
    d.line((mid, 40, mid, h - 130), fill=(70, 54, 40), width=3)
    tally_marks(d, 26, 50, 61, 5, (60, 46, 36))
    tally_marks(d, mid + 22, 50, 58, 5, (60, 46, 36))
    d.text((90, h - 120), '61', font=font(54, hand=True), fill=(60, 46, 36))
    d.text((mid + 90, h - 120), '58', font=font(54, hand=True), fill=(60, 46, 36))
    im.paste(back, (w // 2 + 4, 14))
    ImageDraw.Draw(im).line((w // 2, 10, w // 2, h - 10), fill=(40, 22, 18), width=6)
    return im


def first_page(w=420, h=520):
    """The first entry of the manifest he started the morning he woke: the
    page he keeps."""
    im, d = ruled(w, h, 66, gap=44, top=120, margin=54)
    centred(d, 24, 'MANIFEST', font(32, 'b'), INK, w)
    centred(d, 66, 'day one', font(24, 'i'), INK, w)
    written(d, 70, 124, ['Water: 9 barrels.', 'Lines: all.', "Ship's box: tallies.", ''], 27, gap=44)
    written(d, 70, 300, ['All accounted for.', 'Except me.', 'Working on it.'], 36, gap=60)
    return im


def party_slip(w=560, h=200):
    """The last line of the manifest that smuggled a birthday aboard, in a
    tidy hand that is not his."""
    im, d = ruled(w, h, 67, gap=40, top=52)
    d.text((22, 12), 'ballast, morale ............ 14 bags', font=font(22, 'i'), fill=INK)
    d.text((22, 62), 'One quartermaster.', font=font(38, 'i'), fill=INK)
    d.text((22, 116), 'All accounted for.', font=font(38, 'i'), fill=INK)
    return im


def orders(w=420, h=520):
    """What came in the first bottle: sensible orders, a word on wages,
    and for a signature a drawing of a chair."""
    im = paper(w, h, 68, (0.90, 0.85, 0.70))
    a = arr(im)
    stain = fbm(h, w, 5, 5, 3, rng(69))                         # it has been in the sea
    im = img(a * (0.82 + 0.26 * stain)[..., None]).convert('RGB')
    d = ImageDraw.Draw(im)
    brown = (76, 52, 36)
    written(d, 36, 40, ['Keep her fair.', 'Honest work first.', 'Pay the hands before', 'the chandler.', '',
                        'Wages: arranged,', 'as ever.'], 30, fill=brown, gap=46)
    x, y = w - 150, h - 150                                    # the chair
    for line in (((x, y), (x, y + 110)), ((x, y + 50), (x + 60, y + 50)), ((x + 60, y + 50), (x + 60, y + 110)),
                 ((x, y + 6), (x + 14, y + 6)), ((x, y + 28), (x + 14, y + 28)), ((x + 14, y), (x + 14, y + 50)),
                 ((x, y + 82), (x + 60, y + 82))):
        d.line(line, fill=brown, width=5)
    return im


def jobs_board(w=1408, h=960):
    """The board by the desk: what is booked, the week's water, and what
    the crew, the harbour and Ma have had to say."""
    r = rng(70)
    cork = np.array((0.62, 0.45, 0.28), np.float32) * (0.80 + 0.30 * fbm(h, w, 90, 90, 3, r) + 0.12 * fbm(h, w, 6, 6, 3, r))[..., None]
    board = img(cork).convert('RGBA')
    book = paper(430, 400, 71, (0.96, 0.94, 0.86))
    d = ImageDraw.Draw(book)
    centred(d, 12, 'BOOKED', font(34, 'b'), INK, 430)
    d.line((24, 58, 406, 58), fill=INK, width=2)
    for k, (day, job) in enumerate((('Tue', 'lamp oil to Gullwater'), ('Thu', 'survey charter (Eve)'), ('Sat', 'opera scenery, 6 crates'),
                                    ('Mon', 'the lighthouse stores'), ('—', 'one with the old smell:'), ('', 'ask the Captain first'))):
        d.text((24, 76 + k * 52), day, font=font(26, 'b'), fill=INK)
        d.text((104, 74 + k * 52), job, font=font(26, hand=True), fill=BLUE if k < 4 else RED)
    stick(board, book, 44, 40, -2.0)
    tide = paper(280, 270, 72, (0.95, 0.95, 0.92))
    d = ImageDraw.Draw(tide)
    centred(d, 10, 'HIGH WATER', font(26, 'b'), INK, 280)
    for k, t in enumerate(('Mon   06:12   18:40', 'Tue   07:03   19:28', 'Wed   07:51   20:15', 'Thu   08:36   21:02', 'Fri   09:20   21:47')):
        d.text((22, 56 + k * 36), t, font=font(22), fill=INK)
    d.ellipse((12, 160, 268, 200), outline=RED, width=3)
    stick(board, tide, 520, 36, 2.5)
    plaint = paper(330, 400, 73, (0.97, 0.97, 0.95))
    d = ImageDraw.Draw(plaint)
    centred(d, 16, 'FORMAL COMPLAINT', font(27, 'b'), INK, 330)
    centred(d, 52, 'No. 47', font(24, 'i'), INK, 330)
    d.line((30, 90, 300, 90), fill=INK, width=2)
    written(d, 26, 104, ['Re: the bell, which', 'has been rehung', 'one inch lower.', 'Again.', '', '               — L.'], 23, fill=INK, gap=34, hand=False)
    stamp = Image.new('RGBA', (240, 80), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stamp)
    sd.rectangle((3, 3, 236, 76), outline=RED + (220,), width=5)
    centred(sd, 16, 'FILED: MORALE', font(27, 'b'), RED + (220,), 240)
    plaint.paste(stamp.rotate(14, expand=True, resample=Image.BICUBIC), (60, 270), stamp.rotate(14, expand=True, resample=Image.BICUBIC))
    stick(board, plaint, 850, 40, -2.5)
    card = paper(330, 210, 74, (0.96, 0.94, 0.86))
    d = ImageDraw.Draw(card)
    d.rectangle((264, 14, 314, 74), outline=(150, 90, 80), width=3)
    written(d, 18, 22, ['You work too hard.', 'Eat.', '                    — Ma'], 30, fill=(60, 40, 40), gap=54)
    stick(board, card, 1050, 400, 3.0)
    stick(board, note(300, 130, 75, ['Tuesday. Two bags.', '                    — S.'], (0.80, 0.90, 0.95), 28), 60, 480, 2.5)
    stick(board, note(330, 150, 76, ['Tea is on the stove shelf.', 'Drink it while it is hot.', '                    — A'], (0.86, 0.94, 0.84), 24), 400, 350, -3.0)
    bill = paper(320, 250, 77, (0.94, 0.90, 0.78))
    d = ImageDraw.Draw(bill)
    d.rectangle((8, 8, 312, 242), outline=INK, width=3)
    centred(d, 20, 'HARBOUR MASTER', font(27, 'b'), INK, 320)
    centred(d, 70, 'To the dignity of', font(22, 'i'), INK, 320)
    centred(d, 100, 'one mooring buoy', font(22, 'i'), INK, 320)
    centred(d, 156, 'PAID', font(52, 'b'), RED, 320)
    stick(board, bill, 60, 660, -3.0)
    kids = paper(340, 290, 78, (0.97, 0.96, 0.92))
    d = ImageDraw.Draw(kids)                                   # the dock kids' drawing: a lobster, an octopus, a heart between
    d.ellipse((40, 90, 130, 200), fill=(214, 60, 50)); d.ellipse((20, 60, 62, 104), fill=(214, 60, 50)); d.ellipse((108, 60, 150, 104), fill=(214, 60, 50))
    d.ellipse((66, 108, 80, 124), fill=(250, 250, 250)); d.ellipse((90, 108, 104, 124), fill=(250, 250, 250))
    d.ellipse((220, 80, 310, 160), fill=(240, 140, 90))
    for k in range(5):
        d.line([(232 + k * 16, 150), (226 + k * 18, 190), (236 + k * 16, 214)], fill=(240, 140, 90), width=9, joint='curve')
    d.ellipse((244, 108, 258, 124), fill=(250, 250, 250)); d.ellipse((272, 108, 286, 124), fill=(250, 250, 250))
    for cx in (166, 190):
        d.ellipse((cx - 16, 96, cx + 16, 128), fill=(226, 70, 110))
    d.polygon([(151, 116), (205, 116), (178, 156)], fill=(226, 70, 110))
    centred(d, 228, 'REX + THE DUCHESS', font(26, hand=True), (60, 60, 150), 340)
    stick(board, kids, 440, 590, 4.0)
    quiz = paper(280, 330, 79, (0.95, 0.88, 0.60))
    d = ImageDraw.Draw(quiz)
    d.rectangle((8, 8, 272, 322), outline=INK, width=4)
    centred(d, 24, 'QUIZ', font(60, 'b'), INK, 280)
    centred(d, 92, 'NIGHT', font(60, 'b'), INK, 280)
    centred(d, 176, 'The Split Anchor', font(27, 'i'), INK, 280)
    centred(d, 220, 'Thursdays', font(25), INK, 280)
    centred(d, 266, 'Gerald sends regards', font(20, 'i'), RED, 280)
    stick(board, quiz, 820, 520, -3.0)
    stick(board, photo('rex_cup', 190, 190, 12, 44), 1140, 660, -4.0)
    d = ImageDraw.Draw(board)
    for k, p in enumerate(((250, 52), (660, 48), (1010, 54), (1215, 414), (205, 494), (560, 364), (215, 672), (610, 604),
                           (955, 534), (1240, 674))):
        pin(d, *p, colour=((190, 50, 46), (40, 90, 150), (220, 170, 40), (60, 130, 90))[k % 4])
    return board.convert('RGB')


def crate(size=256):
    """The crate by the door: what the manifest calls it."""
    r = rng(81)
    a = np.rot90(woodgrain(81, (0.70, 0.56, 0.36), size, depth=0.8)).copy()
    for k in range(1, 5):
        a[:, k * size // 5 - 2:k * size // 5 + 1] *= 0.5
    for y0, y1 in ((0, size // 7), (size - size // 7, size)):
        a[y0:y1] *= 0.78
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    centred(d, size * 0.30, 'BALLAST', font(int(size * 0.17), 'b'), (36, 30, 28), size)
    centred(d, size * 0.52, '(MORALE)', font(int(size * 0.13), 'b'), (36, 30, 28), size)
    return im


def label(text, sub, w=256, h=128):
    im = paper(w, h, 82, (0.93, 0.90, 0.80))
    d = ImageDraw.Draw(im)
    d.rectangle((5, 5, w - 5, h - 5), outline=INK, width=3)
    centred(d, h * 0.14, text, font(int(h * 0.30), 'b'), INK, w)
    centred(d, h * 0.58, sub, font(int(h * 0.19), 'i'), RED, w)
    return im


def plate(text, w=384, h=96):
    """An engraved brass plate."""
    r = rng(83)
    yy = np.mgrid[0:h, 0:w][0].astype(np.float32) / h
    a = np.array((0.82, 0.64, 0.30), np.float32) * (0.80 + 0.30 * np.sin(yy * math.pi) + 0.08 * (fbm(h, w, 3, 120, 2, r) - 0.5))[..., None]
    im = img(a).convert('RGB')
    d = ImageDraw.Draw(im)
    d.rectangle((6, 6, w - 6, h - 6), outline=(90, 62, 24), width=3)
    centred(d, h * 0.24, text, font(int(h * 0.40), 'b'), (70, 48, 20), w)
    return im


def pane(size=64):
    """Glass, as far as it shows at all: a faint sheen, a streak across."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    out = np.ones((size, size, 4), np.float32)
    streak = np.clip(1 - np.abs((xx + yy) / size - 0.8) * 6, 0, 1)
    out[..., 3] = 0.05 + 0.12 * streak
    return out


def flame(w=64, h=128):
    """One tongue of flame: pale at its heart, orange out to the edge."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = 1 - yy / h
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
    r = rng(84)
    n = fbm(h, w, 6, 12, 3, r)
    yy = np.mgrid[0:h, 0:w][0].astype(np.float32) / h
    heat = np.clip(n * 1.5 - 0.35 + 0.35 * yy, 0, 1)
    return np.stack([0.20 + 0.80 * heat, 0.05 + 0.50 * heat ** 2, 0.02 + 0.10 * heat ** 3], -1)


def burnt(im, cx, cy, rad, seed):
    """A chart with a hole in it: burnt through at (cx, cy), the edge
    ragged and scorched. Returns RGBA."""
    a = arr(im.convert('RGB'))
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rr = np.hypot(xx - cx * w, yy - cy * h) / (rad * w) + (fbm(h, w, 14, 14, 3, rng(seed)) - 0.5) * 0.55
    scorch = np.clip((1.75 - rr) / 0.75, 0, 1)
    a *= (1 - 0.85 * scorch ** 1.5)[..., None]
    alpha = (rr > 1.0).astype(np.float32)
    return np.dstack([a, alpha])


# ── The view astern ─────────────────────────────────────────────────────
def horizon_of(a, u0=0.50, u1=0.68):
    """How far down the picture its horizon is: where, across the open
    sea in its middle, the afterglow stops and the water starts."""
    from scipy import ndimage
    H, W = a.shape[:2]
    lum = ndimage.gaussian_filter1d(a[:, int(W * u0):int(W * u1)].mean(axis=(1, 2)), 2)
    r0, r1 = int(H * 0.50), int(H * 0.66)
    return (r0 + int(np.argmax(np.abs(np.diff(lum))[r0:r1]))) / H


def dusk(sheet, tint=(0.40, 0.46, 0.62)):
    """A sheet of cut-outs as the hour shows them: dimmed and cooled."""
    a = arr(sheet)
    a[..., :3] *= np.array(tint, np.float32)
    return img(a)


# ── Go ──────────────────────────────────────────────────────────────────
a, n = boards(1, n=14, base=(0.52, 0.35, 0.21)); save('floor', a); save('floor_n', img(n).resize((1024, 1024), Image.LANCZOS))
save('wall', planks(2, CREAM, n=6))
save('wainscot', panelled(3, MAHOGANY))
save('ceiling', planks(4, (0.95, 0.93, 0.86), n=4))
save('mahogany', woodgrain(5, MAHOGANY))
save('oak', woodgrain(6, (0.64, 0.45, 0.27)))
save('beam', woodgrain(7, (0.30, 0.19, 0.13)))
save('navy_wood', woodgrain(8, NAVY, depth=0.30))
save('white_wood', woodgrain(9, (0.95, 0.92, 0.84), depth=0.22))
save('leather', leather(10, (0.50, 0.20, 0.14)))
save('ledger', leather(11, (0.34, 0.15, 0.12)))
for k, (name, colour) in enumerate((('navy', (0.17, 0.25, 0.42)), ('rust', RUST), ('mustard', MUSTARD), ('cream', (0.95, 0.92, 0.84)),
                                    ('oilskin', (0.86, 0.68, 0.20)))):
    save('linen_' + name, linen(20 + k, colour))
save('curtain', cloth_folds(19, (0.17, 0.25, 0.42), depth=0.5))
save('ticking', ticking(26))
save('knit', weave(27, (0.62, 0.64, 0.66), 256, 16))
save('basket', weave(28, (0.76, 0.60, 0.38)))
save('net', weave(29, (0.70, 0.62, 0.46), 128, 6))
save('tiles', tiles(30))
save('slate', plaster(31, 256, (0.30, 0.32, 0.35)))
save('spines', spines(32))
save('logs', logs())
save('flags', flags(SIGNAL))
save('door', panel_door(33, MAHOGANY, 256, 512, panels=((0.12, 0.05, 0.88, 0.36), (0.12, 0.58, 0.88, 0.95))))
save('drawer', panel_door(34, MAHOGANY, 256, 128, panels=((0.06, 0.12, 0.94, 0.88),)))
save('locker', panel_door(35, NAVY, 256, 256, panels=((0.10, 0.10, 0.90, 0.90),)))
save('manifest', manifest())
save('old_log', old_log())
save('first_page', first_page())
save('party_slip', party_slip())
save('orders', orders())
save('board', jobs_board())
save('crate', crate())
save('morale', label('COMPLAINTS (L.)', 'filed under: MORALE'))
save('plate', plate('QUARTERMASTER'))
save('pane', pane())
save('flame', flame())
save('embers', embers())
save('steam', wisp())
save('gull', gull(colour=(30, 34, 58)))
save('glow', glow())
save('glow_soft', glow(colour=(1.0, 0.84, 0.58), power=1.5, peak=0.55))
save('glow_white', glow(colour=(1.0, 0.95, 0.80)))
save('glow_amber', glow(size=64, colour=(1.0, 0.74, 0.36), power=1.4))
# From art/. The view, with more sky over it: the top quarter turned over and laid above, melting into the plain
# colour of the picture's top edge as it goes up — the colour of the lid over the view, so that looking up through
# the stern windows never finds an edge. The dark at its foot likewise, for the water under the counter.
low = arr(art('harbour'))                                              # at the size it was made: it is looked at closely
more = int(low.shape[0] * SKY)
high = low[:6].mean(axis=(0, 1))
k = np.linspace(1.0, 0.0, more, dtype=np.float32)[:, None, None]
k = k * k * (3 - 2 * k)
save('harbour', np.concatenate([low[:more][::-1] * (1 - k) + high * k, low]))
save('high', np.tile(high, (8, 8, 1)))
save('deep', np.tile(low[-6:].mean(axis=(0, 1)), (8, 8, 1)))
H, W = low.shape[:2]
u0, u1, v0, v1 = LAMP_BOX
box = low[int(v0 * H):int(v1 * H), int(u0 * W):int(u1 * W)]
warm = np.asarray(img(box[..., 0] + box[..., 1] - 1.4 * box[..., 2]).filter(ImageFilter.GaussianBlur(4)), np.float32)
ly, lx = np.unravel_index(np.argmax(warm), warm.shape)
kit.SPRITES['view'] = {'horizon': horizon_of(low), 'sky': SKY, 'lamp': [u0 + lx / W, v0 + ly / H]}
print('view', kit.SPRITES['view'], flush=True)
sky = Image.fromarray((low[int(H * 0.05):int(H * 0.40), int(W * 0.52):int(W * 0.70)] * 255).astype(np.uint8))
save('sky', cover(sky, 256, 256))
rug = art('rug')
save('rug', rug.crop((int(rug.width * 0.012), int(rug.height * 0.02), int(rug.width * 0.988), int(rug.height * 0.98))).resize((1280, 853), Image.LANCZOS))
save('quilt', art('quilt', 1024, 1024))
save('chart', art('chart', 1280, 960))
save('ballad', art('ballad', 768, 1024))
save('chart_hole', img(burnt(art('chart_hole', 1024, 1024), 0.60, 0.44, 0.085, 85)))
save('pictures', atlas('pictures', [art(n) for n in PICTURES], 4, 512, bottom=False, pad=0.01))
for name, cell in (('plants', 448), ('things', 384), ('things2', 384), ('boats', 384)):
    cells = sprites(name, 4, 2)
    if cells and len(cells) == 8:
        sheet = atlas(name, cells, 4, cell)
        if name == 'boats':                                            # out on the water at this hour: dark shapes on the afterglow
            sheet = dusk(sheet)
            b = arr(sheet)
            b[..., 3] *= 0.30
            save('boats_wake', img(b).filter(ImageFilter.GaussianBlur(1.5)))
        save(name, sheet)
    else:
        print(f'!! {name}: found {len(cells or [])} cut-outs, wanted 8', flush=True)
cells = sprites('duchess', 1, 1)
save('duchess', dusk(atlas('duchess', cells, 1, 768, cell_h=768), (0.80, 0.74, 0.78)))    # the cabin's lamps reach her a little
kit.save_sprites()
print('done', flush=True)
