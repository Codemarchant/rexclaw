# Copyright 2026 Codemarchant
"""Local generation backend: drive a ComfyUI server with the user's own
exported workflows, as a drop-in engine behind the Imagine tools.

Why ComfyUI and not in-process weights: every open image/video model ships
with day-zero ComfyUI nodes, and ComfyUI already handles quantisation,
offloading and model downloads. Rexclaw only needs its HTTP API, which is
the same for every model — upload a reference image, queue a graph, poll
the history, fetch the output file. What differs per model is the graph,
and that is exactly what the user exports from ComfyUI's own editor.

Setup is deliberately "export and drop in": the user loads an official
template in ComfyUI, gets it running once, exports it in API format
(Workflow → Export (API)) and loads that JSON into Settings. Nothing in
the graph has to be renamed. The inputs Rexclaw fills are DETECTED:

  * positive prompt  — traced upstream from the sampler's `positive`
    input to the first node with a text field (CLIPTextEncode,
    TextEncodeQwenImageEditPlus, …). A `{prompt}` marker inside the
    existing text keeps the rest as a fixed prefix/suffix (style tokens,
    LoRA triggers); without one the whole text is replaced.
  * reference images — the LoadImage nodes, in node-id order. Fewer
    references than loaders: the surplus loaders are pruned (so a
    template's example pictures never leak into a generation). More
    references than loaders: extra loaders are cloned onto free IMAGE
    inputs of the node the last loader feeds (Qwen-Image-Edit's
    image1/2/3), or the request is refused with the count.
  * seeds — every `seed` / `noise_seed` input is re-rolled per call,
    otherwise ComfyUI's cache would hand back the previous result.
  * size — nodes with literal width+height inputs (latent creators) are
    re-shaped to a requested aspect ratio at the same pixel budget.
  * duration — `length` (frames) inputs are set from seconds × the
    workflow's fps (CreateVideo / VHS_VideoCombine), rounded to 4n+1.

Titles `rexclaw_prompt`, `rexclaw_negative` and `rexclaw_ref_N` on nodes
override the detection for anyone who wants to be explicit.

Outputs are whatever the workflow's Save* node writes: the first image or
video file (by extension) among the history outputs, preferring the
`output` folder over previews.
"""
import base64
import copy
import json
import logging
import math
import random
import re
import time
import uuid

import requests

from .errors import UserError

_logger = logging.getLogger(__name__)

DEFAULT_URL = 'http://127.0.0.1:8188'

# Workflow slots ↔ config columns local_gen_<slot>_workflow.
SLOTS = {
    'image': 'Text to image',
    'image_edit': 'Image edit (references)',
    'video': 'Text to video',
    'video_i2v': 'Image to video',
}
VIDEO_SLOTS = {'video', 'video_i2v'}

# String inputs a prompt may live in, in order of preference.
_TEXT_FIELDS = ('text', 'prompt', 'text_g', 'text_l', 't5xxl', 'clip_l')
_IMAGE_LOADER_CLASSES = {'LoadImage', 'LoadImageOutput'}
_IMAGE_SAVER_CLASSES = {'SaveImage', 'SaveImageAdvanced', 'PreviewImage', 'SaveImageWebsocket'}
_VIDEO_SAVER_CLASSES = {'SaveVideo', 'VHS_VideoCombine', 'SaveWEBM'}
_IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp')
_VIDEO_EXTS = ('.mp4', '.webm', '.mov', '.mkv')
_MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
}
_DEFAULT_FPS = 16
_POLL_INTERVAL = 2.0
_TIMEOUTS = {'image': 20 * 60, 'video': 60 * 60}
_UNREACHABLE_GRACE = 30      # seconds without an answer before giving up on a running job
_QUEUE_CHECK_EVERY = 5       # empty history polls between "is the job still queued?" checks


# ---------------------------------------------------------------------------
# Workflow parsing
# ---------------------------------------------------------------------------

def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))


def _node_sort_key(node_id):
    """Node ids are ints, or "170:41" once a subgraph is flattened."""
    parts = []
    for p in str(node_id).split(':'):
        parts.append((0, int(p)) if p.isdigit() else (1, p))
    return parts


def _title(node):
    return str((node.get('_meta') or {}).get('title') or '')


def parse_workflow(text):
    """API-format graph dict from stored JSON text, or a UserError that
    names the fix (the editor's default save is a different format)."""
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as e:
        raise UserError(f'Workflow is not valid JSON: {e}')
    if isinstance(data, dict) and isinstance(data.get('nodes'), list) and 'links' in data:
        raise UserError(
            'This is the editor workflow format. In ComfyUI use Workflow → '
            'Export (API) and load that file instead.'
        )
    if (not isinstance(data, dict) or not data
            or not all(isinstance(v, dict) and 'class_type' in v for v in data.values())):
        raise UserError('Workflow JSON does not look like a ComfyUI API-format graph.')
    return data


def _text_field(node):
    inputs = node.get('inputs') or {}
    for field in _TEXT_FIELDS:
        if isinstance(inputs.get(field), str):
            return field
    return None


def _trace_text_node(wf, link, *, prefer, avoid, visited):
    """Follow `link` upstream to the first node carrying a text field."""
    node_id = str(link[0])
    if node_id in visited or node_id not in wf:
        return None
    visited.add(node_id)
    node = wf[node_id]
    if _text_field(node):
        return node_id
    inputs = node.get('inputs') or {}
    ordered = [k for k in prefer if _is_link(inputs.get(k))]
    ordered += [k for k, v in inputs.items() if _is_link(v) and k not in ordered and k not in avoid]
    for key in ordered:
        found = _trace_text_node(wf, inputs[key], prefer=prefer, avoid=avoid, visited=visited)
        if found:
            return found
    return None


def _find_prompt_nodes(wf):
    """(positive_id, negative_id, guessed) — ids may be None. `guessed`
    is True when the positive was picked by plain node order rather than
    an explicit title or a trace from the sampler, so inspect can warn."""
    positive = negative = None
    for node_id, node in wf.items():
        title = _title(node).lower()
        if title == 'rexclaw_prompt' and _text_field(node):
            positive = node_id
        elif title == 'rexclaw_negative' and _text_field(node):
            negative = node_id
    if positive:
        return positive, negative, False
    # Trace from every node that takes both conditionings (samplers,
    # guiders, WanImageToVideo, …); the first hit wins. A negative that
    # lands on the SAME encoder is the ConditioningZeroOut(positive)
    # pattern — a positive with no negative text, not a failed trace.
    for node_id in sorted(wf, key=_node_sort_key):
        inputs = wf[node_id].get('inputs') or {}
        if not (_is_link(inputs.get('positive')) and _is_link(inputs.get('negative'))):
            continue
        pos = _trace_text_node(wf, inputs['positive'], prefer=('positive', 'conditioning'),
                               avoid=('negative',), visited=set())
        neg = negative or _trace_text_node(wf, inputs['negative'], prefer=('negative', 'conditioning'),
                                           avoid=('positive',), visited=set())
        if pos:
            return pos, (neg if neg != pos else None), False
    # Title hints, then plain order.
    text_nodes = [nid for nid in sorted(wf, key=_node_sort_key) if _text_field(wf[nid])]
    for nid in text_nodes:
        t = _title(wf[nid]).lower()
        if 'positive' in t and not positive:
            positive = nid
        elif 'negative' in t and not negative:
            negative = nid
    if positive:
        return positive, negative, False
    if text_nodes:
        positive = text_nodes[0]
        if not negative and len(text_nodes) > 1:
            negative = text_nodes[1]
    return positive, negative, len(text_nodes) > 1


def _image_loaders(wf):
    """LoadImage node ids: rexclaw_ref_N titles first (by N), then the rest
    in node-id order."""
    loaders = [nid for nid, n in wf.items() if n.get('class_type') in _IMAGE_LOADER_CLASSES]
    explicit, implicit = [], []
    for nid in loaders:
        m = re.fullmatch(r'rexclaw_ref_(\d+)', _title(wf[nid]).strip().lower())
        (explicit.append((int(m.group(1)), nid)) if m else implicit.append(nid))
    return [nid for _, nid in sorted(explicit)] + sorted(implicit, key=_node_sort_key)


def _seed_inputs(wf):
    return [(nid, key) for nid, n in wf.items() for key in ('seed', 'noise_seed')
            if isinstance((n.get('inputs') or {}).get(key), int)]


def _size_nodes(wf):
    """Nodes with literal width+height ints — latent creators and the
    video-conditioning nodes that carry the output size."""
    out = []
    for nid, n in wf.items():
        inputs = n.get('inputs') or {}
        if (isinstance(inputs.get('width'), int) and isinstance(inputs.get('height'), int)
                and not isinstance(inputs.get('width'), bool)
                and n.get('class_type') not in _IMAGE_LOADER_CLASSES):
            out.append(nid)
    return out


def _length_nodes(wf):
    return [nid for nid, n in wf.items()
            if isinstance((n.get('inputs') or {}).get('length'), int)
            and not isinstance(n['inputs']['length'], bool)]


def _fps(wf):
    for n in wf.values():
        inputs = n.get('inputs') or {}
        for key in ('fps', 'frame_rate'):
            v = inputs.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                return float(v)
    return float(_DEFAULT_FPS)


def _saver_kinds(wf):
    kinds = set()
    for n in wf.values():
        ct = n.get('class_type') or ''
        if ct in _VIDEO_SAVER_CLASSES or 'Video' in ct and ct.startswith('Save'):
            kinds.add('video')
        elif ct in _IMAGE_SAVER_CLASSES:
            kinds.add('image')
    return kinds


def inspect_workflow(text, slot=None):
    """What Rexclaw would drive in this workflow — shown in Settings so
    the user can see the detection before a companion relies on it."""
    wf = parse_workflow(text)
    positive, negative, guessed = _find_prompt_nodes(wf)
    loaders = _image_loaders(wf)
    kinds = _saver_kinds(wf)
    warnings = []
    if not positive:
        warnings.append('No prompt text node found - the prompt cannot be filled in.')
    elif guessed:
        warnings.append(
            'Several text nodes and no sampler to trace from - the first one was '
            'picked as the prompt. Title the right node "rexclaw_prompt" if that is wrong.'
        )
    if slot in VIDEO_SLOTS and 'video' not in kinds:
        warnings.append('No video save node found (SaveVideo / VHS_VideoCombine) - the result may not be a video.')
    if slot and slot not in VIDEO_SLOTS and kinds and 'image' not in kinds:
        warnings.append('No image save node found (SaveImage) - the result may not be an image.')
    if slot in ('image_edit', 'video_i2v') and not loaders:
        warnings.append('No LoadImage node - this slot needs one to receive the reference image.')
    if slot in ('image', 'video') and loaders:
        warnings.append(
            'Has LoadImage nodes, but this slot generates from the prompt alone - they '
            'will be pruned. An edit / image-to-video workflow cannot run here; load it '
            'in the references or image-to-video slot instead.'
        )
    if not _seed_inputs(wf):
        warnings.append('No seed input found - ComfyUI may return the cached previous result for a repeated prompt.')

    def _label(nid):
        n = wf[nid]
        return _title(n) or n.get('class_type')

    return {
        'ok': True,
        'nodes': len(wf),
        'prompt': _label(positive) if positive else None,
        'prompt_has_marker': bool(positive and '{prompt}' in (wf[positive]['inputs'].get(_text_field(wf[positive])) or '')),
        'negative': _label(negative) if negative else None,
        'image_inputs': len(loaders),
        'seed_inputs': len(_seed_inputs(wf)),
        'size_inputs': len(_size_nodes(wf)),
        'length_inputs': len(_length_nodes(wf)),
        'fps': _fps(wf) if _length_nodes(wf) else None,
        'outputs': sorted(kinds),
        'warnings': warnings,
    }


# ---------------------------------------------------------------------------
# Workflow editing
# ---------------------------------------------------------------------------

def _fill_prompt(wf, positive, prompt):
    node = wf[positive]
    field = _text_field(node)
    current = node['inputs'].get(field) or ''
    node['inputs'][field] = current.replace('{prompt}', prompt) if '{prompt}' in current else prompt


def _reroll_seeds(wf):
    for nid, key in _seed_inputs(wf):
        wf[nid]['inputs'][key] = random.getrandbits(32)


def _apply_aspect(wf, aspect_ratio):
    """Re-shape every literal width×height to `aspect_ratio` ("16:9") at
    the same pixel budget, on multiples of 16."""
    try:
        rw, rh = (int(p) for p in aspect_ratio.split(':'))
    except (ValueError, AttributeError):
        return
    if rw <= 0 or rh <= 0:
        return
    for nid in _size_nodes(wf):
        inputs = wf[nid]['inputs']
        area = inputs['width'] * inputs['height']
        if area <= 0:
            continue
        w = math.sqrt(area * rw / rh)
        inputs['width'] = max(16, int(round(w / 16)) * 16)
        inputs['height'] = max(16, int(round((w * rh / rw) / 16)) * 16)


def _apply_duration(wf, seconds):
    fps = _fps(wf)
    frames = max(5, int(round(seconds * fps)))
    frames = 4 * round((frames - 1) / 4) + 1   # Wan/Hunyuan-style 4n+1
    for nid in _length_nodes(wf):
        wf[nid]['inputs']['length'] = frames


def _consumers(wf, node_id):
    """[(consumer_id, input_key)] for every link out of `node_id`."""
    out = []
    for nid, n in wf.items():
        for key, v in (n.get('inputs') or {}).items():
            if _is_link(v) and str(v[0]) == str(node_id):
                out.append((nid, key))
    return out


def _new_node_id(wf):
    top = 0
    for nid in wf:
        for p in str(nid).split(':'):
            if p.isdigit():
                top = max(top, int(p))
    return str(top + 1)


def _prune_nodes(wf, doomed, object_info):
    """Drop `doomed` nodes and everything that then loses a REQUIRED link
    input (an ImageScale between a pruned loader and the encoder, say);
    optional dangling links are simply unlinked."""
    doomed = set(map(str, doomed))
    while doomed:
        for nid in doomed:
            wf.pop(nid, None)
        next_round = set()
        for nid, n in wf.items():
            for key, v in list((n.get('inputs') or {}).items()):
                if _is_link(v) and str(v[0]) in doomed:
                    if object_info.is_required(n.get('class_type'), key):
                        next_round.add(nid)
                    else:
                        del n['inputs'][key]
        doomed = next_round


def _grow_loaders(wf, loaders, needed, object_info):
    """Clone the last loader (and any single-image chain after it) onto
    free IMAGE inputs of the node it feeds until `needed` loaders exist.
    Returns the extended loader list or raises with the accepted count."""
    loaders = list(loaders)
    if not loaders:
        raise UserError('The local workflow has no LoadImage node to receive a reference image.')
    template = loaders[-1]
    while len(loaders) < needed:
        # Follow the template loader through its single-consumer chain of
        # pass-through nodes (a scaler, say) to the node whose fan-out
        # matters, then mirror that fan-out: every consumer with a free
        # IMAGE input gets the new chain on its next free slot (the Qwen
        # edit templates feed BOTH text encoders the same images; a
        # VAEEncode that only takes the first is simply skipped).
        chain = []   # (node_id, input_key) pass-through nodes to clone
        cur = template
        for _ in range(4):
            cons = _consumers(wf, cur)
            if len(cons) != 1 or object_info.free_inputs(wf[cons[0][0]], 'IMAGE'):
                break
            chain.append(cons[0])
            cur = cons[0][0]
        targets = []
        for cid, _key in _consumers(wf, cur):
            free = object_info.free_inputs(wf[cid], 'IMAGE')
            if free and cid not in [t[0] for t in targets]:
                targets.append((cid, free[0]))
        if not targets:
            raise UserError(
                f'The local image-edit workflow accepts {len(loaders)} reference '
                f'image(s); this request has {needed}. Drop some references or add '
                f'LoadImage nodes to the workflow.'
            )
        new_loader = _new_node_id(wf)
        wf[new_loader] = copy.deepcopy(wf[template])
        wf[new_loader].setdefault('_meta', {})['title'] = f'rexclaw_ref_{len(loaders)}'
        prev = new_loader
        for cid, ckey in chain:
            clone_id = _new_node_id(wf)
            wf[clone_id] = copy.deepcopy(wf[cid])
            wf[clone_id]['inputs'][ckey] = [prev, 0]
            prev = clone_id
        for cid, key in targets:
            wf[cid]['inputs'][key] = [prev, 0]
        loaders.append(new_loader)
    return loaders


class _ObjectInfo:
    """Lazy, per-run view of ComfyUI's node schemas (GET /object_info/X)."""

    def __init__(self, base_url, headers=None):
        self.base_url = base_url
        self.headers = headers or {}
        self._cache = {}

    def _get(self, class_type):
        if class_type in self._cache:
            return self._cache[class_type]
        info = None
        try:
            resp = requests.get(f'{self.base_url}/object_info/{class_type}',
                                headers=self.headers, timeout=10)
            if resp.ok:
                info = (resp.json() or {}).get(class_type)
        except (requests.RequestException, ValueError):
            info = None
        self._cache[class_type] = info
        return info

    def is_required(self, class_type, key):
        info = self._get(class_type)
        if not info:
            return False
        return key in ((info.get('input') or {}).get('required') or {})

    def free_inputs(self, node, type_name):
        """Unlinked inputs of `type_name` (e.g. IMAGE) on `node`, required
        first, in declared order."""
        info = self._get(node.get('class_type'))
        if not info:
            return []
        out = []
        for group in ('required', 'optional'):
            for key, spec in ((info.get('input') or {}).get(group) or {}).items():
                if isinstance(spec, (list, tuple)) and spec and spec[0] == type_name \
                        and key not in (node.get('inputs') or {}):
                    out.append(key)
        return out


def prepare_workflow(text, base_url, *, prompt, image_names=(), aspect_ratio=None,
                     duration_seconds=None, headers=None):
    """Parsed, filled copy of the workflow ready to queue."""
    wf = parse_workflow(text)
    positive, _negative, _guessed = _find_prompt_nodes(wf)
    if not positive:
        raise UserError('The local workflow has no prompt text node to fill in.')
    object_info = _ObjectInfo(base_url, headers)
    loaders = _image_loaders(wf)
    image_names = list(image_names)
    if len(image_names) > len(loaders):
        loaders = _grow_loaders(wf, loaders, len(image_names), object_info)
    elif len(image_names) < len(loaders):
        _prune_nodes(wf, loaders[len(image_names):], object_info)
        loaders = loaders[:len(image_names)]
        if not _saver_kinds(wf) or positive not in wf:
            # The cascade took the sampler and saver with it: this graph
            # needs its reference image (an edit / image-to-video workflow
            # loaded in a prompt-only slot).
            raise UserError(
                'This local workflow depends on its LoadImage input and cannot run '
                'without a reference image - load it in the "Image edit (references)" '
                'or "Image to video" slot instead.'
            )
    for nid, name in zip(loaders, image_names):
        wf[nid]['inputs']['image'] = name
    _fill_prompt(wf, positive, prompt)
    _reroll_seeds(wf)
    if aspect_ratio:
        _apply_aspect(wf, aspect_ratio)
    if duration_seconds:
        _apply_duration(wf, duration_seconds)
    return wf


# ---------------------------------------------------------------------------
# ComfyUI HTTP client
# ---------------------------------------------------------------------------

def base_url(config):
    return (config['local_gen_url'] or '').strip().rstrip('/') or DEFAULT_URL


def auth_headers(raw):
    """The optional "Name: value" auth header as a requests headers dict —
    a rented pod behind a proxy password, or a hosted service's API key.
    Empty / malformed = no extra header."""
    name, sep, value = (raw or '').strip().partition(':')
    if not sep or not name.strip() or not value.strip():
        return {}
    return {name.strip(): value.strip()}


def test_connection(url, auth_header=None):
    """Reachability + what is on the other end, for the Settings button."""
    url = (url or '').strip().rstrip('/') or DEFAULT_URL
    try:
        resp = requests.get(f'{url}/system_stats', headers=auth_headers(auth_header), timeout=5)
    except requests.RequestException as e:
        raise UserError(f'Could not reach ComfyUI at {url}: {e}')
    if resp.status_code in (401, 403):
        raise UserError(f'ComfyUI at {url} refused the request ({resp.status_code}) - check the auth header.')
    if not resp.ok:
        raise UserError(f'ComfyUI at {url} answered {resp.status_code}.')
    try:
        stats = resp.json()
    except ValueError:
        raise UserError(f'{url} did not answer like ComfyUI (no JSON on /system_stats).')
    system = stats.get('system') or {}
    devices = []
    for d in stats.get('devices') or []:
        devices.append({
            'name': d.get('name'),
            'vram_total_gb': round((d.get('vram_total') or 0) / 1e9, 1),
            'vram_free_gb': round((d.get('vram_free') or 0) / 1e9, 1),
        })
    return {'ok': True, 'url': url, 'version': system.get('comfyui_version'), 'devices': devices}


def _data_uri_bytes(uri):
    header, _, b64 = uri.partition(',')
    mimetype = header[len('data:'):].split(';', 1)[0] or 'image/png'
    return base64.b64decode(b64), mimetype


def _upload_image(url, data_uri, headers):
    raw, mimetype = _data_uri_bytes(data_uri)
    ext = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(mimetype, '.png')
    name = f'rexclaw_{uuid.uuid4().hex}{ext}'
    try:
        resp = requests.post(
            f'{url}/upload/image',
            files={'image': (name, raw, mimetype)},
            data={'overwrite': 'true', 'type': 'input'},
            headers=headers,
            timeout=60,
        )
    except requests.RequestException as e:
        raise UserError(f'Uploading a reference image to ComfyUI failed: {e}')
    if not resp.ok:
        raise UserError(f'ComfyUI refused the reference image upload ({resp.status_code}): {resp.text[:200]}')
    body = resp.json()
    name = body.get('name') or name
    sub = body.get('subfolder') or ''
    return f'{sub}/{name}' if sub else name


def _queue(url, wf, headers):
    try:
        resp = requests.post(f'{url}/prompt', json={'prompt': wf, 'client_id': 'rexclaw'},
                             headers=headers, timeout=60)
    except requests.RequestException as e:
        raise UserError(f'Could not reach ComfyUI at {url}: {e}')
    if resp.status_code in (401, 403):
        raise UserError(f'ComfyUI at {url} refused the request ({resp.status_code}) - check the auth header.')
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except ValueError:
            body = {}
        raise UserError('ComfyUI rejected the workflow: ' + _format_node_errors(body, resp.text))
    body = resp.json()
    prompt_id = body.get('prompt_id')
    if not prompt_id:
        raise UserError(f'ComfyUI queued nothing: {str(body)[:300]}')
    return prompt_id


def _format_node_errors(body, fallback):
    parts = []
    err = body.get('error')
    if isinstance(err, dict) and err.get('message'):
        parts.append(err['message'])
    for nid, info in (body.get('node_errors') or {}).items():
        ct = info.get('class_type') or nid
        for e in info.get('errors') or []:
            msg = e.get('message') or ''
            details = e.get('details') or ''
            parts.append(f'{ct}: {msg}' + (f' ({details})' if details else ''))
    return ' | '.join(parts)[:600] or (fallback or '')[:300]


def _job_known(url, prompt_id, headers):
    """Is the job still in ComfyUI's running/pending queue? True on any
    doubt (a failed /queue read) — only a clear "not there" is trusted."""
    try:
        resp = requests.get(f'{url}/queue', headers=headers, timeout=10)
        body = resp.json() if resp.ok else None
    except (requests.RequestException, ValueError):
        return True
    if not isinstance(body, dict):
        return True
    for key in ('queue_running', 'queue_pending'):
        for item in body.get(key) or []:
            if isinstance(item, list) and len(item) > 1 and item[1] == prompt_id:
                return True
    return False


def _wait(url, prompt_id, timeout, headers):
    """Poll /history until the job lands. Two ways out besides success:
    the server stops answering for _UNREACHABLE_GRACE seconds (ComfyUI
    closed mid-render), or it answers but has forgotten the job (it was
    restarted or the queue was cleared) — both fail fast instead of
    sitting out the full timeout with the companion's turn hanging."""
    deadline = time.monotonic() + timeout
    unreachable_since = None
    misses = 0
    while time.monotonic() < deadline:
        try:
            resp = requests.get(f'{url}/history/{prompt_id}', headers=headers, timeout=30)
            if resp.status_code in (401, 403):
                raise UserError(f'ComfyUI at {url} refused the status check ({resp.status_code}) - check the auth header.')
            if not resp.ok:
                # A proxy answering 502/504 for a server that went away is
                # as good as no answer — count it against the grace period.
                raise requests.RequestException(f'HTTP {resp.status_code} from /history')
            entry = (resp.json() or {}).get(prompt_id)
            unreachable_since = None
        except (requests.RequestException, ValueError) as e:
            _logger.warning('ComfyUI history poll failed: %s', e)
            unreachable_since = unreachable_since or time.monotonic()
            if time.monotonic() - unreachable_since >= _UNREACHABLE_GRACE:
                raise UserError(
                    f'Lost contact with ComfyUI at {url} while the job was running - '
                    f'is it still open? Try again once it is back.'
                )
            time.sleep(_POLL_INTERVAL)
            continue
        if entry:
            status = entry.get('status') or {}
            if status.get('status_str') == 'error':
                raise UserError('ComfyUI run failed: ' + _execution_error(status))
            if status.get('completed') or entry.get('outputs'):
                return entry.get('outputs') or {}
        else:
            misses += 1
            # Every few empty polls, make sure the job still exists. A job
            # can finish between the two reads, so re-check history once
            # before calling it lost.
            if misses % _QUEUE_CHECK_EVERY == 0 and not _job_known(url, prompt_id, headers):
                try:
                    resp = requests.get(f'{url}/history/{prompt_id}', headers=headers, timeout=30)
                    if resp.ok and (resp.json() or {}).get(prompt_id):
                        continue
                except (requests.RequestException, ValueError):
                    pass
                raise UserError(
                    'ComfyUI no longer has this job - it was probably restarted or its '
                    'queue was cleared. Try again.'
                )
        time.sleep(_POLL_INTERVAL)
    raise UserError(f'ComfyUI did not finish within {timeout // 60} minutes.')


def _execution_error(status):
    for msg in status.get('messages') or []:
        if isinstance(msg, list) and len(msg) == 2 and msg[0] == 'execution_error':
            data = msg[1] or {}
            return f"{data.get('node_type') or ''}: {data.get('exception_message') or ''}".strip(': ')[:500]
    return 'see the ComfyUI console.'


def _pick_output(outputs, kind):
    exts = _VIDEO_EXTS if kind == 'video' else _IMAGE_EXTS
    candidates = []
    for node_id, node_out in outputs.items():
        if not isinstance(node_out, dict):
            continue
        for entries in node_out.values():
            if not isinstance(entries, list):
                continue
            for e in entries:
                if not isinstance(e, dict) or not e.get('filename'):
                    continue
                fname = e['filename']
                if fname.lower().endswith(exts):
                    rank = 0 if e.get('type') == 'output' else 1
                    candidates.append((rank, _node_sort_key(node_id), e))
    if not candidates:
        raise UserError(
            f'The ComfyUI run finished but wrote no {kind} file - check that the '
            f'workflow ends in a Save{"Video" if kind == "video" else "Image"} node.'
        )
    candidates.sort(key=lambda c: (c[0], c[1]))
    return candidates[0][2]


def _download(url, entry, headers):
    params = {'filename': entry['filename'], 'subfolder': entry.get('subfolder') or '',
              'type': entry.get('type') or 'output'}
    try:
        resp = requests.get(f'{url}/view', params=params, headers=headers, timeout=300)
    except requests.RequestException as e:
        raise UserError(f'Downloading the result from ComfyUI failed: {e}')
    if resp.status_code in (401, 403):
        raise UserError(f'ComfyUI refused the result download ({resp.status_code}) - check the auth header.')
    if not resp.ok or not resp.content:
        raise UserError(f'Downloading the result from ComfyUI failed ({resp.status_code}).')
    ext = '.' + entry['filename'].rsplit('.', 1)[-1].lower()
    mimetype = _MIME_BY_EXT.get(ext) or resp.headers.get('Content-Type', '').split(';')[0] or 'application/octet-stream'
    return resp.content, mimetype, ext


def generate(config, slot, *, prompt, image_data_uris=(), aspect_ratio=None,
             duration_seconds=None):
    """Run the configured workflow for `slot` and return (bytes, mimetype,
    ext). Raises UserError with a message the companion can relay."""
    text = config[f'local_gen_{slot}_workflow'] or ''
    if not text.strip():
        raise UserError(
            f'No "{SLOTS[slot]}" workflow is set up for local generation - load '
            f'one in Settings → Local generation.'
        )
    url = base_url(config)
    headers = auth_headers(config['local_gen_auth_header'])
    kind = 'video' if slot in VIDEO_SLOTS else 'image'
    names = [_upload_image(url, uri, headers) for uri in image_data_uris]
    wf = prepare_workflow(text, url, prompt=prompt, image_names=names,
                          aspect_ratio=aspect_ratio, duration_seconds=duration_seconds,
                          headers=headers)
    prompt_id = _queue(url, wf, headers)
    _logger.info('ComfyUI %s job %s queued (%d nodes)', slot, prompt_id, len(wf))
    outputs = _wait(url, prompt_id, _TIMEOUTS[kind], headers)
    return _download(url, _pick_output(outputs, kind), headers)
