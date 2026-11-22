# Copyright 2026 Codemarchant
"""PNG looks made with Grok Imagine, or with the user's ComfyUI when that is
create_image's engine (its "Text to image" and "Image edit (references)"
workflows, Settings → Local generation): one image of the character plus the
three PNGtuber frames (mouth open, eyes closed, both) the web renderer swaps
between (web/src/services/png_puppet.js).

The method is AITuber OnAir's (shinshin86/aituber-onair, MIT,
skills/create-pngtuber-avatar-states): generate one anchor image, then make
every other state as an EDIT of that anchor that changes only the mouth or
eyes — never four fresh generations, which drift in pose and line. Its
prompt templates (references/prompts.md) are adapted below, and the
background removal starts from its background_to_alpha.py: key colour from
the corners, pixels connected to the border within `threshold` of the key
go transparent, a `feather` band beyond that goes partly transparent. The
backdrop asked for is a chroma screen in a colour the character doesn't
contain — green, or blue for a character with green in them, and the
image is asked to keep that colour off the character — so every pixel can
be keyed by colour difference, the standard method — see _backdrop and
_background_alpha.

Two steps of our own keep the frames from flickering against each other:
an edit's pixels that barely differ from the anchor are replaced by the
anchor's (Imagine re-encodes the whole image, so untouched areas still
shift by a few levels), and every frame takes the anchor's cut-out, so the
outline never moves.

The prompts are fixed here, not written by the companion: the tools pass
only who the character is or what they wear, and the template holds the
likeness, pose and canvas. Used by the avatar editor's Generate button
(routes/avatars.py), the create_outfit tool and create_character.
"""
import base64
import io
import logging
import re
from concurrent.futures import ThreadPoolExecutor

from . import avatar_packs, xai_client
from .errors import UserError

_logger = logging.getLogger(__name__)

# Portrait canvas: a full-body character stands beside VRM companions.
ASPECT_RATIO = "2:3"

# AITuber OnAir background_to_alpha.py defaults: corner sample size (px),
# key distance that goes fully transparent, feather band beyond it.
KEY_SAMPLE = 12
KEY_THRESHOLD = 22
KEY_FEATHER = 24
# (On a green or blue backdrop the same two numbers set the
# colour-difference key's margins — see _background_alpha.)
# How far into the figure (px) the screen colour's spill is taken out: the width of the
# rim the model paints along the outline, read off generated looks
# (2026-11-21) — a judgement call, not a measured constant.
SPILL_BAND = 3
# A border this uneven (RGB standard deviation) is a scene, not a flat
# backdrop — kept rather than cut (their Background Transparency Rule).
FLAT_BORDER_MAX_STD = 30
# Edit pixels within this of the anchor (max channel difference, 0-255)
# are taken from the anchor.
STABLE_DIFF = 24

_BACKDROP = ("a plain, flat, solid bright {screen} background with no "
              "shadows, gradients, floor, scenery, text or objects")
_SCREENS = {"green": "green (#00FF00)", "blue": "blue (#0000FF)"}
# Asked of the anchor with its screen, as a real green screen asks of the
# wardrobe: the key takes any of the screen colour for backdrop.
_SCREEN_RULE = (" Use no {name} anywhere on the character - hair, eyes, skin, "
                "clothes or accessories - so the background can be keyed out cleanly.")

# The screen is the colour the character doesn't contain: green, or blue
# for a character with green in them — named in the description or
# outfit, or covering more than COLOUR_IN_REFERENCE of a reference
# picture's visible pixels with an excess over COLOUR_EXCESS (a pair of
# green eyes on a full-body picture is about 0.05%). A character with both
# gets the colour it has less of, without the rule (it would redraw them).
# Judgement calls, not measured constants.
_COLOUR_WORDS = {
    "green": re.compile(r"\b(green|emerald|lime|mint|jade|olive|chartreuse|teal|sage|"
                        r"verdant)\b", re.I),
    "blue": re.compile(r"\b(blue|navy|azure|cobalt|sapphire|cyan|denim|indigo|"
                       r"turquoise|teal)\b", re.I),
}
COLOUR_EXCESS = 60
COLOUR_IN_REFERENCE = 0.0002

_STYLE_LOCK = ("same art style, line art, colours and shading as the reference. "
               "Pose: standing, full body from head to feet, facing the viewer, "
               "centred, arms relaxed at the sides; the whole character fits "
               "inside the canvas with a small margin. ")

ANCHOR_FROM_REFERENCE = (
    "Create a full-body character image of the same character as the "
    "reference. Keep their face, hairstyle, eye design, body proportions, "
    "colours and accessories exactly. " + _STYLE_LOCK +
    "Eyes open, mouth closed, a natural friendly expression. "
    "Outfit: {outfit}. Background: " + _BACKDROP + ".{rule}"
)

ANCHOR_FROM_TEXT = (
    "Create a full-body character image. Character: {character}. Outfit: "
    "{outfit}. Pose: standing, full body from head to feet, facing the "
    "viewer, centred, arms relaxed at the sides; the whole character fits "
    "inside the canvas with a small margin. Eyes open, mouth closed, a "
    "natural friendly expression. Illustrated anime-style character art. "
    "Background: " + _BACKDROP + ".{rule}"
)

_KEEP = ("Do not change the head angle, face outline, hair, hands, clothing, "
         "accessories, canvas size, character position, line art, colours or "
         "background. The result must align perfectly with the original "
         "when the two are switched.")

FRAME_PROMPTS = {
    "mouth_open": ("Edit this image to create the mouth-open speaking state. "
                   "Change only the mouth area. Keep the eyes open. " + _KEEP),
    "eyes_closed": ("Edit this image to create the eyes-closed blinking state. "
                    "Change only the eye area. Keep the mouth closed. " + _KEEP),
    "mouth_open_eyes_closed": ("Edit this image to create the speaking-and-blinking "
                               "state. Change only the mouth area and the eye area. "
                               "The eyes are closed and the mouth is open. " + _KEEP),
}


def _image_from_body(body):
    from PIL import Image
    item = body['data'][0]
    b64 = item.get('b64_json')
    if not b64:
        raise UserError("Imagine returned no image data.")
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def _data_uri(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _on_comfyui(config):
    """Looks follow create_image's engine (Settings → Local generation):
    the user's ComfyUI, or Grok Imagine."""
    from .imagine_tools import backend_for
    return backend_for(config, 'create_image') == 'local'


def available(config, *, from_text=False):
    """Whether looks can be drawn right now: on ComfyUI its "Image edit
    (references)" workflow (every frame is an edit) plus, to draw from a
    description alone, its "Text to image" one; on Imagine an xAI key."""
    if _on_comfyui(config):
        def ready(slot):
            return bool((config[f'local_gen_{slot}_workflow'] or '').strip())
        return ready('image_edit') and (ready('image') or not from_text)
    return bool(config['xai_api_key'])


def _render(config, prompt, reference_uris=(), aspect_ratio=None):
    """One image from the chosen engine: an edit of `reference_uris`, or
    drawn from the prompt alone without any."""
    from PIL import Image
    if _on_comfyui(config):
        from . import local_gen
        data, _mime, _ext = local_gen.generate(
            config, 'image_edit' if reference_uris else 'image', prompt=prompt,
            image_data_uris=list(reference_uris), aspect_ratio=aspect_ratio)
        return Image.open(io.BytesIO(data)).convert("RGB")
    key = config['xai_api_key']
    if not key:
        raise UserError("xAI API key is not configured.")
    if reference_uris:
        body = xai_client.edit_image(
            xai_api_key=key, edits_url=config['xai_images_edits_url'],
            model=config['imagine_model'], prompt=prompt,
            image_data_uris=list(reference_uris), aspect_ratio=aspect_ratio,
            quality=config['imagine_quality'])
    else:
        body = xai_client.generate_image(
            xai_api_key=key, images_url=config['xai_images_url'],
            model=config['imagine_model'], prompt=prompt,
            aspect_ratio=aspect_ratio, quality=config['imagine_quality'])
    return _image_from_body(body)


def _colour_share(reference_uris):
    """{"green": share, "blue": share} of the reference pictures' visible
    pixels where that channel leads the other two by COLOUR_EXCESS."""
    import numpy as np
    from PIL import Image
    shares = {"green": 0.0, "blue": 0.0}
    for uri in reference_uris:
        try:
            img = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))).convert("RGBA")
        except Exception:
            continue
        px = np.asarray(img, dtype=np.int32)
        visible = px[..., 3] > 128   # a cut-out look's clear backdrop isn't the character
        if not visible.any():
            continue
        r, g, b = px[..., 0], px[..., 1], px[..., 2]
        for name, excess in (("green", g - np.maximum(r, b)), ("blue", b - np.maximum(r, g))):
            shares[name] = max(shares[name], float((excess[visible] > COLOUR_EXCESS).mean()))
    return shares


def _backdrop(reference_uris, text):
    """(screen colour, whether to ask that the character has none of it):
    green, or blue for a character with green in them."""
    shares = _colour_share(reference_uris)
    has = {c: bool(_COLOUR_WORDS[c].search(text or "")) or shares[c] > COLOUR_IN_REFERENCE
           for c in ("green", "blue")}
    if has["green"] and has["blue"]:
        return ("blue" if shares["blue"] < shares["green"] else "green"), False
    return ("blue" if has["green"] else "green"), True


def _anchor(config, *, reference_uris, character, outfit):
    outfit = (outfit or "").strip()
    colour, keep_off = _backdrop(reference_uris, f"{character} {outfit}")
    screen = _SCREENS[colour]
    rule = _SCREEN_RULE.format(name=colour) if keep_off else ""
    if reference_uris:
        return _render(config, ANCHOR_FROM_REFERENCE.format(
            outfit=outfit or "the same outfit as the reference", screen=screen, rule=rule),
            reference_uris, ASPECT_RATIO)
    return _render(config, ANCHOR_FROM_TEXT.format(
        character=character.strip(), outfit=outfit or "everyday clothes that suit them",
        screen=screen, rule=rule), aspect_ratio=ASPECT_RATIO)


def _frame(config, anchor_uri, key):
    return _render(config, FRAME_PROMPTS[key], [anchor_uri])


def _step(mask, keep):
    """One 4-neighbour step: `mask` and its neighbours where `keep`."""
    out = mask.copy()
    out[1:] |= mask[:-1]
    out[:-1] |= mask[1:]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out & keep


def _grow(seed, within):
    """The part of `within` connected to `seed`, grown a pixel a step."""
    reach = seed & within
    while True:
        grown = _step(reach, within)
        if (grown == reach).all():
            return reach
        reach = grown


def _screen_excess(key):
    """For a green or blue screen key: the colour-difference function (how
    far a pixel's screen channel exceeds the larger of the other two),
    else None — a backdrop that is no screen colour."""
    import numpy as np
    c = int(np.argmax(key))
    a, b = [i for i in range(3) if i != c]
    excess = lambda px: px[..., c] - np.maximum(px[..., a], px[..., b])
    return excess if c != 0 and excess(np.asarray(key)) > 2 * KEY_THRESHOLD + KEY_FEATHER else None


def _background_alpha(img):
    """The anchor's cut-out: (alpha as floats 0-1, 1 = character, key RGB),
    or None when its border is a scene rather than a flat backdrop.

    On a green or blue backdrop (the ones asked for, _backdrop) the key is
    colour-difference keying, the standard chroma-key method, applied to
    every pixel: how far the screen channel exceeds the larger of the other
    two. It holds across the backdrop's shading, which the model draws
    darker in places, where a plain distance from one key colour left olive
    patches opaque. A pixel at or past the backdrop's own weakest excess
    (its border's 1st percentile) is fully clear; one within KEY_THRESHOLD
    of no excess is fully kept; in between, the excess is the share of
    backdrop mixed into the pixel. Any other backdrop colour keeps AITuber
    OnAir's distance key."""
    import numpy as np
    rgb = np.asarray(img, dtype=np.int32)
    h, w, _ = rgb.shape
    s = max(1, min(KEY_SAMPLE, w, h))
    corners = np.concatenate([rgb[:s, :s], rgb[:s, -s:], rgb[-s:, :s], rgb[-s:, -s:]]).reshape(-1, 3)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    if border.std(axis=0).max() > FLAT_BORDER_MAX_STD:
        return None
    key = corners.mean(axis=0)
    excess = _screen_excess(key)
    if excess is not None:
        # Chroma key: every pixel by its own screen-colour excess, no flood
        # fill — the screen colour is kept off the character (_backdrop),
        # so any excess is backdrop, including the backdrop showing between
        # strands of hair, mixed with them, which no fill from the border
        # reaches.
        diff = excess(rgb).astype(np.float64)
        clear = max(np.percentile(excess(border), 1), KEY_THRESHOLD + 1)
        return np.clip((clear - diff) / (clear - KEY_THRESHOLD), 0, 1), key
    # Any other flat backdrop (white, grey): AITuber OnAir's distance key,
    # grown from the border so a character in the backdrop's colour keeps
    # whatever the backdrop doesn't touch.
    dist = np.sqrt(((rgb - key) ** 2).sum(axis=2))
    near = dist <= KEY_THRESHOLD + KEY_FEATHER
    level = np.clip((dist - KEY_THRESHOLD) / KEY_FEATHER, 0, 1)
    edge = np.zeros((h, w), dtype=bool)
    edge[0] = edge[-1] = True
    edge[:, 0] = edge[:, -1] = True
    reach = _grow(edge & near, near)
    alpha = np.ones((h, w))
    alpha[reach] = level[reach]
    return alpha, key


def _stabilise(frame, anchor):
    """`frame` with its near-unchanged pixels taken from the anchor."""
    import numpy as np
    from PIL import Image
    if frame.size != anchor.size:
        frame = frame.resize(anchor.size, Image.LANCZOS)
    a = np.asarray(anchor, dtype=np.int16)
    f = np.asarray(frame, dtype=np.int16)
    same = np.abs(f - a).max(axis=2) <= STABLE_DIFF
    out = np.where(same[..., None], a, f).astype(np.uint8)
    return Image.fromarray(out, "RGB")


def _png_bytes(img, cutout):
    """PNG of a frame, cut out with the anchor's `cutout` (alpha, key).
    An edge pixel is part character, part backdrop: the backdrop's share
    is taken back out of its colour (observed = alpha·colour + (1-alpha)·key),
    then the screen colour's spill along the outline is clamped (despill,
    below) so no green (or blue) rim is left round the character."""
    import numpy as np
    from PIL import Image
    buf = io.BytesIO()
    if cutout is not None:
        alpha, key = cutout
        rgb = np.asarray(img, dtype=np.float64)
        edge = (alpha > 0) & (alpha < 1)
        a = np.maximum(alpha[edge], 0.05)[:, None]
        rgb[edge] = np.clip((rgb[edge] - (1 - a) * key) / a, 0, 255)
        if _screen_excess(key) is not None:
            c = int(np.argmax(key))
            o1, o2 = [i for i in range(3) if i != c]
            ch = rgb[..., c]
            # Despill everywhere (the max limiter: the screen channel at
            # most the larger of the other two). It changes only pixels
            # where the screen colour leads, which the character has none
            # of (_backdrop), so yellows, skin and the rest are untouched.
            np.minimum(ch, np.maximum(rgb[..., o1], rgb[..., o2]), out=ch)
            # Along the outline the model also paints the backdrop's colour
            # into the line art as rim light, so a band SPILL_BAND px into
            # the figure takes the stronger average limiter too.
            band = alpha < 1
            for _ in range(SPILL_BAND):
                grown = band.copy()
                grown[1:] |= band[:-1]
                grown[:-1] |= band[1:]
                grown[:, 1:] |= band[:, :-1]
                grown[:, :-1] |= band[:, 1:]
                band = grown
            band &= alpha > 0
            # The average limiter (the screen channel at most the mean of
            # the other two), the stronger of the two usual despills: the
            # max limiter left the green-tinted outline khaki where it
            # should be brown. Only here: across the figure it would pull
            # the green out of yellows.
            ch[band] = np.minimum(ch[band], ((rgb[..., o1] + rgb[..., o2]) / 2)[band])
        out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
        img = Image.fromarray(out, "RGBA")
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def generate(config, *, reference_uris=None, character="", outfit=""):
    """Generate a PNG look. Returns {"base": png bytes, "mouth_open": ...,
    "eyes_closed": ..., "mouth_open_eyes_closed": ...}; a frame whose edit
    failed is left out (the look still works, it just skips that state).
    `reference_uris`: data URIs of the character's likeness (keeps the face
    and style); without one, `character` describes who to draw."""
    if not reference_uris and not (character or "").strip():
        raise UserError("Describe the character, or give a reference image.")
    anchor = _anchor(config, reference_uris=reference_uris or [], character=character or "",
                     outfit=outfit)
    anchor_uri = _data_uri(anchor)
    frames = {}
    with ThreadPoolExecutor(max_workers=len(FRAME_PROMPTS)) as pool:
        futures = {k: pool.submit(_frame, config, anchor_uri, k) for k in FRAME_PROMPTS}
        for k, fut in futures.items():
            try:
                frames[k] = _stabilise(fut.result(), anchor)
            except Exception as e:
                _logger.warning("png look: %s frame failed: %s", k, e)
    alpha = _background_alpha(anchor)
    out = {"base": _png_bytes(anchor, alpha)}
    for k, img in frames.items():
        out[k] = _png_bytes(img, alpha)
    return out


def save_to_pack(pack_key, stem, images):
    """Write a generated look into an editable pack. Returns the manifest
    look fields: {"vrm": base filename, "frames": {key: filename}}."""
    base = avatar_packs.save_upload(pack_key, "image", f"{stem}.png", images["base"])
    frames = {k: avatar_packs.save_upload(pack_key, "image", f"{stem}_{k}.png", images[k])
              for k in avatar_packs.PNG_FRAME_KEYS if k in images}
    return {"vrm": base, "frames": frames} if frames else {"vrm": base}
