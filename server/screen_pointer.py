# Copyright 2026 Codemarchant
"""point_at_screen: find what the companion names on the user's shared
screen, for the highlight drawn around it.

Jev locates, it doesn't reason. The companion has already worked out WHAT
to point at (analyze_screen and its own thinking) and names each target by
what is visibly there. Per target, one request asks a Box (where it is) and
a Noul (is it there at all: a Box has no "not found" answer, so TypeSafe's
docs pair the two). A second Box per visible target then looks again on a
window of the full-resolution frame centred on the first answer, TypeSafe's
recipe for small targets in a large image.

Probe 2026-10-17, 20 targets on rendered test pages with known positions,
1920 and 3840 px wide: the first Box alone put its centre on the target
10/20; with the second look 16/20 at a window of 1/3 or 1/2 of the screen
(1/3 drew tighter boxes, mean IoU 0.49 vs 0.44). A tight crop around the
first box failed on grids: it cut away the rows and columns a "row 3,
column 5" description counts. Centres land better than edges, so the
highlight is a padded ring around the box, not its outline.
"""

import base64
import io
import uuid
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFont

from . import jev

# Jev takes 280-1568 px per side and never resizes (docs.typesafe.ai/images).
MAX_SIDE = 1568
MIN_SIDE = 280
# Second look: a window this fraction of the frame's width and height,
# centred on the first box (probe above).
WINDOW = 1 / 3
# Image requests run longer than the text-only calls: 420-620 ms per
# request in the probe, 1.1 s at worst.
TIMEOUT = (3, 8)
# Second looks run side by side on long-lived threads: jev keeps one pooled
# connection per thread, so a new thread per call would pay a TLS handshake
# on every look. One worker per target the tool accepts.
_pool = ThreadPoolExecutor(max_workers=9, thread_name_prefix='screen-pointer')
# The frame stored for the transcript, like the other captures.
STORED_MAX_SIDE = 2048
# Ring around a found box: padded by a quarter of each side (at least
# RING_PAD_MIN px) and never smaller than RING_MIN px. Mirrored by the
# desktop overlay in desktop/main.js (pointOverlayHtml).
RING_PAD = 0.25
RING_PAD_MIN = 10
RING_MIN = 36
RING_COLOR = (255, 204, 0)


def _scaled(img, side):
    """`img` with its long side at `side` px, kept inside Jev's limits."""
    s = side / max(img.size)
    w, h = max(1, round(img.width * s)), max(1, round(img.height * s))
    if min(w, h) < MIN_SIDE:
        s = MIN_SIDE / min(w, h)
        w, h = round(w * s), round(h * s)
    return img.resize((w, h), Image.LANCZOS) if (w, h) != img.size else img


def _ask(api_key, model, img, qs):
    ref = f'{uuid.uuid4()}-screen'
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'JPEG', quality=90)
    return jev.ask(api_key, model, {'screen': ref}, qs, timeout=TIMEOUT, assets={
        ref: {'type': 'image', 'format': 'jpg', 'data_base64': base64.b64encode(buf.getvalue()).decode()}})


def _look_again(api_key, model, frame, box, target):
    """Box again on the window centred on `box`, mapped back to the frame."""
    cx, cy = (box['left'] + box['right']) / 2, (box['top'] + box['bottom']) / 2
    left = min(max(0.0, cx - WINDOW / 2), 1 - WINDOW)
    top = min(max(0.0, cy - WINDOW / 2), 1 - WINDOW)
    crop = frame.crop((round(left * frame.width), round(top * frame.height),
                       round((left + WINDOW) * frame.width), round((top + WINDOW) * frame.height)))
    qs = {'b': {'type': 'box', 'instructions': f'{target} in `screen`'}}
    body = _ask(api_key, model, _scaled(crop, MAX_SIDE), qs)
    got = jev.answers(body, qs).get('b')
    if not got:
        return box, jev.input_ticks(body)
    e = got['box']
    return ({'left': left + e['left'] * WINDOW, 'top': top + e['top'] * WINDOW,
             'right': left + e['right'] * WINDOW, 'bottom': top + e['bottom'] * WINDOW},
            jev.input_ticks(body))


def locate(api_key, model, frame, targets):
    """Find each target on `frame` (a PIL image of the shared screen).
    Returns ([{'target', 'visible', 'box'}], usd_ticks); a box's edges are
    fractions of the frame, and None when the target wasn't found."""
    qs = {}
    for i, target in enumerate(targets):
        qs[f'b{i}'] = {'type': 'box', 'instructions': f'{target} in `screen`'}
        qs[f'v{i}'] = {'type': 'noul', 'instructions': f'Is {target} visible in `screen`?'}
    body = _ask(api_key, model, _scaled(frame, min(MAX_SIDE, max(frame.size))), qs)
    ticks = jev.input_ticks(body)
    got = jev.answers(body, qs)
    results = []
    for i, target in enumerate(targets):
        visible = (got.get(f'v{i}') or {}).get('yes', 0) >= jev.YES and f'b{i}' in got
        results.append({'target': target, 'visible': visible,
                        'box': got[f'b{i}']['box'] if visible else None})
    found = [r for r in results if r['visible']]
    if found:
        # The second looks are independent: one round trip for all of them.
        futures = [_pool.submit(_look_again, api_key, model, frame, r['box'], r['target']) for r in found]
        for r, f in zip(found, futures):
            try:
                r['box'], t = f.result()
                ticks += t
            except Exception:
                pass  # keep the first look's box
    return results, ticks


def ring(box, width, height):
    """The highlight ring around `box` in px of a width x height image, as
    (left, top, right, bottom)."""
    w, h = (box['right'] - box['left']) * width, (box['bottom'] - box['top']) * height
    pw = max(RING_PAD_MIN, w * RING_PAD, (RING_MIN - w) / 2)
    ph = max(RING_PAD_MIN, h * RING_PAD, (RING_MIN - h) / 2)
    return (box['left'] * width - pw, box['top'] * height - ph,
            box['right'] * width + pw, box['bottom'] * height + ph)


def annotate(frame, results):
    """The frame with numbered rings around the found targets, as a JPEG
    data URL for the transcript."""
    img = frame.convert('RGB')
    if max(img.size) > STORED_MAX_SIDE:
        img = _scaled(img, STORED_MAX_SIDE)
    draw = ImageDraw.Draw(img)
    stroke = max(3, round(max(img.size) / 400))
    font = ImageFont.load_default(size=stroke * 4)
    numbered = len(results) > 1
    for n, r in enumerate(results, 1):
        if not r['visible']:
            continue
        x0, y0, x1, y1 = ring(r['box'], img.width, img.height)
        draw.rounded_rectangle((x0 - 1, y0 - 1, x1 + 1, y1 + 1), radius=stroke * 4, outline=(0, 0, 0), width=stroke + 2)
        draw.rounded_rectangle((x0, y0, x1, y1), radius=stroke * 4, outline=RING_COLOR, width=stroke)
        if numbered:
            # Off the ring's top-left corner, clear of what it surrounds.
            rad = stroke * 3
            cx, cy = max(rad, x0 - rad * 0.6), max(rad, y0 - rad * 0.6)
            draw.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=RING_COLOR, outline=(0, 0, 0), width=2)
            draw.text((cx, cy), str(n), fill=(0, 0, 0), font=font, anchor='mm')
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=90)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
