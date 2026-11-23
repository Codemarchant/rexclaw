# Copyright 2026 Codemarchant
"""Venice AI as an engine behind the Imagine tools (create_image,
create_video, change_background) and PNG looks: the third choice beside
Grok Imagine (xai_client) and the user's ComfyUI (local_gen).

Venice serves many image and video models behind one API, and a video
model there is one MODE of a family (its text-to-video, image-to-video,
reference-to-video and editing variants are separate model ids). So the
user picks one model per capability slot in Settings, the way ComfyUI
takes one workflow per slot; a slot left empty is a capability the tools
don't offer.

Which sizes, lengths and shapes a model accepts differs per model and is
published in Venice's model list (model_spec.constraints). Requests are
fitted to it here, so the tools keep Grok Imagine's parameters whatever
model is picked: a length the model doesn't offer becomes its nearest one,
a size becomes the largest one it offers at or below the ask (sizes are
price tiers), a shape becomes its closest one.

API facts are from Venice's OpenAPI spec (api.venice.ai/doc/api/swagger.yaml,
version 20261121) and its media guides (docs.venice.ai/guides/media).
"""
import base64
import logging
import re
import threading
import time

import requests

from .errors import UserError

_logger = logging.getLogger(__name__)

# `safe_mode` is sent as false on every image request: Venice's default
# blurs pictures it classes as adult, and which model draws (a moderated
# one or not) is the user's pick in Settings, not this filter's.
BASE_URL = 'https://api.venice.ai/api/v1'
KEYS_URL = 'https://venice.ai/settings/api'

# Capability slots; each one's model is config.venice_<slot>_model.
SLOTS = ('image', 'image_edit', 'video', 'video_i2v', 'video_ref', 'video_edit', 'video_extend')

# What the app's own defaults fall back to when a model has no entry in
# Venice's list (a new id, or the list could not be fetched).
_DEFAULT_VIDEO_SECONDS = 8
_DEFAULT_EXTEND_SECONDS = 5   # the app's default added length (imagine_tools)

# Still-image requests are answered in the response itself, so the
# connection stays open for the whole render.
_IMAGE_TIMEOUT = 300
# Venice's guide polls a queued video every 5 s.
_VIDEO_POLL_SECONDS = 5
# How long a video may take: three times the wait Venice itself estimates
# for the job (average_execution_time, its P80), within these bounds.
_VIDEO_MIN_WAIT = 600
_VIDEO_MAX_WAIT = 1800


def model_for(config, slot):
    return (config[f'venice_{slot}_model'] or '').strip()


def ready(config, slot):
    """Whether a slot can render: a key and a model for it."""
    return bool(config['venice_api_key'] and model_for(config, slot))


# ---------------------------------------------------------------------------
# Model list (public, no key)
# ---------------------------------------------------------------------------

_LIST_TTL = 6 * 3600
_LIST_RETRY = 60     # after a failed fetch
_lists = {}          # kind -> (fetched_at, ok, {model id: model_spec})
_lists_lock = threading.Lock()
_refreshing = set()  # kinds a background refresh is running for


def _refresh(kind):
    try:
        models(kind)
    finally:
        with _lists_lock:
            _refreshing.discard(kind)


def models(kind, wait=True):
    """{model id: model_spec} of Venice's 'image', 'inpaint' (image edit)
    or 'video' list. Kept for six hours; a fetch that fails keeps the last
    list, or leaves it empty, and requests then go out as asked.
    `wait=False` never fetches on the caller's time: it answers with what
    is held (possibly nothing yet) and refreshes in the background — for
    building a session's tools, which must not stall on Venice."""
    now = time.monotonic()
    with _lists_lock:
        cached = _lists.get(kind)
        if cached and now - cached[0] < (_LIST_TTL if cached[1] else _LIST_RETRY):
            return cached[2]
        if not wait:
            if kind not in _refreshing:
                _refreshing.add(kind)
                threading.Thread(target=_refresh, args=(kind,), daemon=True).start()
            return cached[2] if cached else {}
    try:
        resp = requests.get(f'{BASE_URL}/models', params={'type': kind}, timeout=15)
        resp.raise_for_status()
        found = {m['id']: m.get('model_spec') or {} for m in resp.json()['data']}
        ok = True
    except Exception as e:
        _logger.warning('Venice model list (%s) could not be fetched: %s', kind, e)
        found, ok = (cached[2] if cached else {}), False
    with _lists_lock:
        _lists[kind] = (now, ok, found)
    return found


def _constraints(kind, model):
    return (models(kind).get(model) or {}).get('constraints') or {}


# Video models whose request needs fields this module does not send, so
# they are kept out of the pickers (typing the id by hand still works as
# far as the model accepts a plain request). From Venice's queue spec:
# Kling O3 / V3 4K reference-to-video take `elements` and
# `scene_image_urls`, PixVerse C1 takes `image_references` objects,
# transitions and first-last-frame models need `end_image_url`,
# multi-angle takes a `camera_trajectory`.
_UNSUPPORTED_REFERENCE_FAMILIES = ('kling-o3-', 'kling-v3-4k-', 'pixverse-c1-')
_UNSUPPORTED_VIDEO_KINDS = ('transition', 'first-last-frame', 'multi-angle')


def _video_slot(model_id, spec):
    """The slot a video model belongs in. Venice files reference-to-video
    under model_type 'image-to-video' and everything that takes a clip
    under 'video', so the id tells those apart."""
    if any(word in model_id for word in _UNSUPPORTED_VIDEO_KINDS):
        return None
    if 'reference-to-video' in model_id and model_id.startswith(_UNSUPPORTED_REFERENCE_FAMILIES):
        return None
    kind = (spec.get('constraints') or {}).get('model_type')
    if kind == 'text-to-video':
        return 'video'
    if kind == 'image-to-video':
        return 'video_ref' if 'reference-to-video' in model_id else 'video_i2v'
    if kind == 'video':
        if 'extend' in model_id:
            return 'video_extend'
        if any(word in model_id for word in ('video-to-video', 'edit-video')):
            return 'video_edit'
    return None


# Reference-to-video families whose own guides on Venice have them edit
# and extend a clip passed as a reference video (docs.venice.ai/guides/
# media: wan-3-0, seedance-2-0), so they are listed for those slots too.
_EDITS_BY_REFERENCE = ('wan-3-0', 'seedance-2')


def slot_models():
    """{slot: [{id, name}]} for the Settings pickers."""
    out = {slot: [] for slot in SLOTS}
    for slot, kind in (('image', 'image'), ('image_edit', 'inpaint')):
        # `qualities`: the levels a model offers, so Settings shows the
        # quality choice only for a model that takes one.
        out[slot] = [{'id': mid, 'name': spec.get('name') or mid,
                      'qualities': (spec.get('constraints') or {}).get('qualities') or []}
                     for mid, spec in models(kind).items()]
    for mid, spec in models('video').items():
        slot = _video_slot(mid, spec)
        if slot:
            entry = {'id': mid, 'name': spec.get('name') or mid}
            out[slot].append(entry)
            if slot == 'video_ref' and mid.startswith(_EDITS_BY_REFERENCE):
                out['video_edit'].append(entry)
                out['video_extend'].append(entry)
    return out


# ---------------------------------------------------------------------------
# Fitting a request to a model
# ---------------------------------------------------------------------------

def _ratio(text):
    found = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*', str(text or ''))
    if not found or not float(found.group(2)):
        return None
    return float(found.group(1)) / float(found.group(2))


def _closest_ratio(offered, wanted):
    """`wanted` if the model lists it, else its listed shape nearest to it
    ('auto' and 'adaptive' are not shapes)."""
    if wanted in offered:
        return wanted
    target = _ratio(wanted)
    if not target:
        return None
    shapes = [(abs(_ratio(r) - target), r) for r in offered if _ratio(r)]
    return min(shapes)[1] if shapes else None


def _picture_shape(data_uri):
    """'width:height' of a picture given as a data URI, or None."""
    try:
        import io
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(_bare_base64(data_uri)))) as img:
            return f'{img.width}:{img.height}'
    except Exception:
        return None


def _at_or_below(offered, wanted, size_of):
    """The largest offered size at or below `wanted`, else the smallest.
    Never above the ask: Venice prices images and videos by size."""
    want = size_of(wanted)
    sizes = sorted((size_of(r), r) for r in offered if size_of(r))
    if not sizes or not want:
        return None
    below = [r for size, r in sizes if size <= want]
    return below[-1] if below else sizes[0][1]


def _image_tier(text):
    """'1.5k' / '2K' -> 1.5 / 2.0."""
    found = re.fullmatch(r'(\d+(?:\.\d+)?)k', str(text or '').strip().lower())
    return float(found.group(1)) if found else None


def _video_height(text):
    """'720p' / '768P' / '2k' / '4k' -> lines."""
    text = str(text or '').strip().lower()
    if text in ('2k', '4k'):
        return {'2k': 1440, '4k': 2160}[text]
    found = re.fullmatch(r'(\d+)p', text)
    return int(found.group(1)) if found else None


def video_options(config):
    """What the picked video models offer between them, from Venice's
    model list, for the create_video schema: {'aspect_ratios': ['16:9',
    ...], 'resolutions': ['480p', ...], 'durations': [2, 5, ...]}. A list
    is empty when no picked model publishes it (or the list could not be
    read), and the schema then keeps its own values. Each request is still
    fitted to the one model that runs it."""
    shapes, sizes, lengths = [], {}, set()
    for slot in SLOTS:
        if not slot.startswith('video') or not ready(config, slot):
            continue
        constraints = (models('video', wait=False).get(model_for(config, slot)) or {}).get('constraints') or {}
        shapes +=[s for s in constraints.get('aspect_ratios') or () if _ratio(s) and s not in shapes]
        for size in constraints.get('resolutions') or ():
            if _video_height(size):
                sizes.setdefault(_video_height(size), str(size).lower())
        lengths.update(int(m.group(1)) for d in constraints.get('durations') or ()
                       if (m := re.fullmatch(r'(\d+)s', str(d))))
    return {'aspect_ratios': shapes, 'resolutions': [sizes[h] for h in sorted(sizes)],
            'durations': sorted(lengths)}


def _image_fields(constraints, *, aspect_ratio, resolution, quality):
    """Size and quality fields of an image request, for one model."""
    fields = {}
    shapes = constraints.get('aspectRatios')
    if aspect_ratio and shapes:
        shape = _closest_ratio(shapes, aspect_ratio)
        if shape:
            fields['aspect_ratio'] = shape
    elif aspect_ratio and constraints.get('widthHeightDivisor', 1) > 1 and _ratio(aspect_ratio):
        # A model sized in pixels (Venice's spec: each side at most 1280,
        # a multiple of the model's divisor).
        step, ratio = constraints['widthHeightDivisor'], _ratio(aspect_ratio)
        long_side = 1280 // step * step
        short_side = max(step, round(long_side / max(ratio, 1 / ratio) / step) * step)
        fields['width'], fields['height'] = ((long_side, short_side) if ratio >= 1
                                             else (short_side, long_side))
    elif aspect_ratio and not constraints:
        fields['aspect_ratio'] = aspect_ratio
    if resolution:
        if constraints.get('resolutions'):
            tier = _at_or_below(constraints['resolutions'], resolution, _image_tier)
            if tier:
                fields['resolution'] = tier
        elif not constraints:
            fields['resolution'] = str(resolution).upper()
    if quality in (constraints.get('qualities') or ()):
        fields['quality'] = quality
    return fields


def _video_duration(constraints, seconds, whole=False):
    """The `duration` to send. Venice requires one on every job. Without a
    length asked for (editing a clip): the model's own 'Auto' when it has
    one, else its length nearest the app's default. `whole`: `seconds` is
    a result that must fit in full (a clip plus what is added to it), so
    it becomes the next offered length up, and one past the model's
    longest is refused rather than cut short."""
    offered = constraints.get('durations') or []
    if seconds is None:
        auto = next((d for d in offered if str(d).lower() == 'auto'), None)
        if auto:
            return auto, None
        seconds = _DEFAULT_VIDEO_SECONDS
    lengths = [int(m.group(1)) for d in offered if (m := re.fullmatch(r'(\d+)s', str(d)))]
    if lengths and whole:
        fits = [n for n in lengths if n >= seconds]
        if not fits:
            raise UserError(f'That would make a {seconds} second clip, and this video model '
                            f'makes {max(lengths)} seconds at most.')
        seconds = min(fits)
    elif lengths:
        # Nearest offered length; the shorter of two equally near.
        seconds = min(lengths, key=lambda n: (abs(n - seconds), n))
    elif offered:
        return offered[0], None
    else:
        # A model the list doesn't describe: the longest `duration` the
        # queue endpoint itself accepts (its spec's enum ends at 30s).
        seconds = min(seconds, 30)
    return f'{int(seconds)}s', int(seconds)


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

def _headers(config):
    key = config['venice_api_key']
    if not key:
        raise UserError('Venice API key is not configured. Set it in Settings.')
    return {'Authorization': f'Bearer {key}'}


def _error_text(resp):
    """Venice's own message from an error reply."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:300]
    error = body.get('error') if isinstance(body, dict) else None
    if isinstance(error, dict):
        error = error.get('message') or str(error)
    details = body.get('details') if isinstance(body, dict) else None
    return (str(error or body)[:300] + (f' {str(details)[:300]}' if details else ''))


def _fail(resp, what, model):
    _logger.error('Venice %s failed: %s %s', what, resp.status_code, resp.text[:500])
    if resp.status_code == 401:
        raise UserError(f'Venice refused the API key ({_error_text(resp)}).')
    if resp.status_code == 402:
        raise UserError(f'The Venice balance is too low for this {what}. Add credits at {KEYS_URL}.')
    if resp.status_code == 409:
        # A provider's terms the account holder must accept in person
        # (Seedance); the app cannot agree to them on the user's behalf.
        raise UserError(f'{model} needs its provider\'s terms accepted on the Venice account '
                        f'before it can be used here: {_error_text(resp)}')
    raise UserError(f'Venice {what} failed ({resp.status_code}, model {model}): {_error_text(resp)}')


def _post(config, path, payload, what, model, timeout):
    try:
        resp = requests.post(f'{BASE_URL}{path}', headers=_headers(config), json=payload,
                             timeout=timeout)
    except requests.RequestException as e:
        raise UserError(f'Venice {what} failed: {e}')
    if resp.status_code >= 400:
        _fail(resp, what, model)
    return resp


def _check_moderation(resp, what):
    """Venice answers 200 with a blacked-out picture when a model's
    provider refuses the request; a header says so."""
    if (resp.headers.get('x-venice-is-content-violation') or '').lower() == 'true':
        raise UserError(f'Venice blocked this {what}: it violates the content policy of '
                        f'Venice or the model\'s provider.')


def _bare_base64(data_uri):
    return data_uri.split(',', 1)[1] if data_uri.startswith('data:') else data_uri


def generate_image(config, *, prompt, aspect_ratio=None, resolution=None, quality=None,
                   image_format='jpeg'):
    """One picture from the prompt alone -> (bytes, mimetype)."""
    model = model_for(config, 'image')
    if not model:
        raise UserError('No Venice image model is set in Settings.')
    payload = {'model': model, 'prompt': prompt, 'format': image_format, 'hide_watermark': True,
               'safe_mode': False}
    payload.update(_image_fields(_constraints('image', model), aspect_ratio=aspect_ratio,
                                 resolution=resolution, quality=quality))
    resp = _post(config, '/image/generate', payload, 'image generation', model, _IMAGE_TIMEOUT)
    _check_moderation(resp, 'image')
    try:
        images = resp.json().get('images') or []
        raw = base64.b64decode(images[0])
    except Exception:
        _logger.error('Venice image generation: unexpected reply: %s', resp.text[:300])
        raise UserError('Venice returned no image (its provider may have declined the prompt).')
    return raw, f'image/{image_format}'


def edit_image(config, *, prompt, image_data_uris, aspect_ratio=None, resolution=None,
               quality=None, image_format='jpeg'):
    """One picture made from reference images -> (bytes, mimetype). The
    multi-edit endpoint takes one image as well as several."""
    model = model_for(config, 'image_edit')
    if not model:
        raise UserError('No Venice image edit model is set in Settings.')
    constraints = _constraints('inpaint', model)
    if constraints:
        # Venice's image editing guide: without maxInputImages the cap is
        # 3, or 1 for a model that cannot combine images.
        limit = constraints.get('maxInputImages') or (3 if constraints.get('combineImages', True) else 1)
        if len(image_data_uris) > limit:
            raise UserError(f'{model} takes at most {limit} reference image(s) and this needs '
                            f'{len(image_data_uris)}. Use fewer, or pick an edit model that '
                            f'takes more in Settings.')
    payload = {'prompt': prompt, 'output_format': image_format, 'safe_mode': False}
    payload.update(_image_fields(constraints, aspect_ratio=aspect_ratio,
                                 resolution=resolution, quality=quality))
    if constraints and not constraints.get('combineImages', True):
        # A one-image editor is not served by multi-edit (its model list in
        # the spec leaves them out): the single-image endpoint, which has
        # no `quality` field.
        payload.pop('quality', None)
        payload.update(model=model, image=_bare_base64(image_data_uris[0]))
        path = '/image/edit'
    else:
        payload.update(modelId=model, images=[_bare_base64(u) for u in image_data_uris])
        path = '/image/multi-edit'
    resp = _post(config, path, payload, 'image edit', model, _IMAGE_TIMEOUT)
    _check_moderation(resp, 'image')
    served = (resp.headers.get('Content-Type') or '').split(';')[0].strip()
    if not served.startswith('image/') or not resp.content:
        _logger.error('Venice image edit: unexpected reply: %s', resp.text[:300])
        raise UserError('Venice returned no image (its provider may have declined the edit).')
    return resp.content, served


def generate_video(config, slot, *, prompt, image_data_uri=None, reference_image_data_uris=None,
                   video_data_uri=None, clip_seconds=None, duration_seconds=None,
                   aspect_ratio=None, resolution=None, audio=True):
    """Queue a clip on `slot`'s model, wait for it and download it ->
    (bytes, mimetype, model, seconds). `seconds` is the length asked of
    Venice after fitting, None when the model sets it itself.

    A clip to edit or extend (`video_data_uri`, `clip_seconds` long) goes
    to a video-to-video model as its input. A reference-driven model (Wan
    3.0, Seedance) has no such input: it takes the clip as a reference
    video, is told in the prompt to edit or extend @Video1, and `duration`
    is the length of the whole result (Venice's Wan 3.0 guide)."""
    model = model_for(config, slot)
    if not model:
        raise UserError('No Venice model is set in Settings for this kind of video.')
    constraints = _constraints('video', model)
    # Without the model list, the id says it: a reference-to-video model
    # takes clips as references.
    as_reference = bool(video_data_uri and (
        not constraints.get('video_input') if constraints else 'reference-to-video' in model))
    if as_reference:
        if not clip_seconds:
            raise UserError('The length of that clip could not be read, which this video model needs.')
        if slot == 'video_extend':
            added = duration_seconds or _DEFAULT_EXTEND_SECONDS
            prompt = f'Extend @Video1 by {added} seconds: {prompt}'
            # To the nearest second: a "10 second" clip measures 10.03, and
            # rounding that up would buy a whole longer length.
            duration_seconds = round(clip_seconds) + added
        else:
            prompt = f'Edit @Video1: {prompt}'
            duration_seconds = max(1, round(clip_seconds))
    duration, seconds = _video_duration(constraints, duration_seconds, whole=as_reference)
    payload = {'model': model, 'prompt': prompt, 'duration': duration}
    shapes = constraints.get('aspect_ratios')
    if not aspect_ratio and shapes:
        # Some models refuse a job without a shape (Wan 3.0). One made
        # from a picture or clip follows it where the model can, a clip
        # that opens on a picture takes the offered shape nearest the
        # picture's, and anything else gets Grok Imagine's default.
        follow = next((s for s in shapes if s in ('adaptive', 'auto')), None)
        has_input = image_data_uri or reference_image_data_uris or video_data_uri
        payload['aspect_ratio'] = (
            follow if follow and has_input
            else image_data_uri and _closest_ratio(shapes, _picture_shape(image_data_uri))
            or ('16:9' if '16:9' in shapes else shapes[0]))
    elif aspect_ratio:
        shape = _closest_ratio(shapes, aspect_ratio) if shapes else (None if constraints else aspect_ratio)
        if shape:
            payload['aspect_ratio'] = shape
    if resolution:
        sizes = constraints.get('resolutions')
        size = (_at_or_below(sizes, resolution, _video_height) if sizes
                else (None if constraints else resolution))
        if size:
            payload['resolution'] = size
    # A soundtrack is a paid extra on the models that let it be switched
    # off; the field is refused by the ones that don't.
    if constraints.get('audio_configurable'):
        payload['audio'] = bool(audio)
    if image_data_uri:
        payload['image_url'] = image_data_uri
    if reference_image_data_uris:
        payload['reference_image_urls'] = list(reference_image_data_uris)
    if video_data_uri:
        if as_reference:
            payload['reference_video_urls'] = [video_data_uri]
        else:
            payload['video_url'] = video_data_uri

    queued = _post(config, '/video/queue', payload, 'video', model, 120).json()
    queue_id = queued.get('queue_id')
    if not queue_id:
        raise UserError(f'Venice queued no video job: {str(queued)[:300]}')
    download_url = queued.get('download_url')
    headers = _headers(config)

    raw = None
    started = time.monotonic()
    wait = _VIDEO_MIN_WAIT
    while raw is None:
        if time.monotonic() - started > wait:
            raise UserError(f'Venice video timed out after {int(wait)}s (model {model}).')
        time.sleep(_VIDEO_POLL_SECONDS)
        try:
            poll = requests.post(f'{BASE_URL}/video/retrieve', headers=headers,
                                 json={'queue_id': queue_id}, timeout=300)
        except requests.RequestException as e:
            _logger.warning('Venice video status poll failed: %s', e)
            continue
        if poll.status_code == 429:
            continue
        if poll.status_code >= 400:
            # A failed job answers with its error here.
            _fail(poll, 'video', model)
        if (poll.headers.get('Content-Type') or '').startswith('video/'):
            raw = poll.content
            break
        try:
            status = poll.json()
        except ValueError:
            continue
        estimate = status.get('average_execution_time')
        if isinstance(estimate, (int, float)):
            wait = max(_VIDEO_MIN_WAIT, min(_VIDEO_MAX_WAIT, 3 * estimate / 1000))
        if status.get('status') == 'COMPLETED' and download_url:
            try:
                clip = requests.get(download_url, timeout=300)
            except requests.RequestException as e:
                raise UserError(f'Venice video download failed: {e}')
            if clip.status_code >= 400 or not clip.content:
                raise UserError(f'Venice video download failed ({clip.status_code}).')
            raw = clip.content
    if not raw:
        raise UserError('Venice video download returned no data.')
    # The clip is on disk here from now on: have Venice drop its copy.
    try:
        requests.post(f'{BASE_URL}/video/complete', headers=headers,
                      json={'queue_id': queue_id}, timeout=30)
        if download_url:
            requests.delete(download_url, timeout=30)
    except requests.RequestException as e:
        _logger.warning('Venice video cleanup failed: %s', e)
    return raw, 'video/mp4', model, seconds


def test_connection(key):
    """Settings "Test": does Venice accept the key, and what can it spend."""
    if not key:
        return {'ok': False, 'error': 'Enter a Venice API key first.'}
    try:
        resp = requests.get(f'{BASE_URL}/billing/balance',
                            headers={'Authorization': f'Bearer {key}'}, timeout=15)
    except requests.RequestException as e:
        return {'ok': False, 'error': f'Could not reach Venice: {e}'}
    if resp.status_code >= 400:
        return {'ok': False, 'error': f'Venice answered {resp.status_code}: {_error_text(resp)}'}
    try:
        body = resp.json()
    except ValueError:
        return {'ok': False, 'error': 'Venice sent an unexpected reply.'}
    balances = body.get('balances') or {}
    return {'ok': True, 'can_consume': bool(body.get('canConsume')),
            'usd': balances.get('usd'), 'diem': balances.get('diem')}
