# Copyright 2026 Codemarchant
"""The decision model behind the face director, the speech gesture
selector, live memory and the turn director: TypeSafe's Jev, or another
model that speaks the same request format.

Settings picks one of three (config `decision_provider`):
  jev    TypeSafe's hosted Jev, on the user's TypeSafe key.
  api    any server with a System One endpoint (the request format Jev
         introduced): a hosted open model, or one the user runs themselves
         with llama-server or Ollama. Text questions only.
  local  Valen-Decision as a child process of this server
         (decision_local.py), an optional download. Like Jev it takes
         images and answers Box questions.

One request carries a state (the JSON the questions read) and a set of
questions, each answered independently and in parallel with a calibrated
probability: a `noul` is yes/no, a `choice` is a distribution over options
code supplies, a `score` is a position on a ladder of levels. The round
trip is ~250-300 ms whether the request holds one question or twenty, so
everything a caller wants to know about a line goes in one call.

Reading the answers, per TypeSafe's own guidance: a yes/no counts at 0.5
(their threshold example), a Choice is the way to extract one of a set of
candidates the code already knows, and a Score is read as a level, never
as a magnitude interpolated between its levels.
"""

import threading
import time

import requests

from . import decision_local

JEV_URL = 'https://api.typesafe.ai/v1/systemone'
# The config's jev_model, when the Settings field is left empty.
JEV_MODEL = 'jev-latest'
# TypeSafe bills input tokens only: $0.042 per million (docs.typesafe.ai/models),
# as xAI-style usd ticks (store.USD_TICKS_PER_USD = 1e10 per dollar).
TICKS_PER_INPUT_TOKEN = 420
# An answer about a line already spoken is useless, so no retries and a
# short read timeout; the connect timeout covers a cold TLS handshake.
TIMEOUT = (3, 4)
PROVIDERS = ('jev', 'api', 'local')
# A yes/no answered at or above this counts as yes (the docs' example).
YES = 0.5

# One pooled HTTPS session per server worker thread: after the first call
# the connection is kept alive, so a per-sentence request skips the TLS
# handshake — a large share of a few-hundred-ms round trip.
_local = threading.local()


def _session():
    s = getattr(_local, 'session', None)
    if s is None:
        s = _local.session = requests.Session()
    return s


def to_request(qs):
    """A caller's question set in TypeSafe's request shape. Choice criteria
    are {id: text} and Score criteria [(id, level)] lowest first; the ids
    are for code, and Jev sees only the words."""
    out = {}
    for qid, q in qs.items():
        out[qid] = {'type': q['type'], 'instructions': q['instructions']}
        if q['type'] == 'choice':
            out[qid]['criteria'] = dict(q['criteria'])
        elif q['type'] == 'score':
            out[qid]['criteria'] = [text for _, text in q['criteria']]
    return out


def provider(config):
    which = config['decision_provider']
    return which if which in PROVIDERS else 'jev'


def ready(config):
    """Can the chosen decision model be asked at all? What the features
    that need one are gated on."""
    which = provider(config)
    if which == 'jev':
        return bool(config['typesafe_api_key'])
    if which == 'api':
        return bool((config['decision_api_url'] or '').strip())
    return decision_local.installed(config['decision_local_model'])


def can_box(config):
    """Can it take images and answer Box questions (point_at_screen, a
    roaming companion's looks at the screen)? Jev does, and so does the
    local model (Valen has a Box head). A server reached over the API is
    not asked: each of them takes images its own way."""
    which = provider(config)
    if which == 'jev':
        return bool(config['typesafe_api_key'])
    return which == 'local' and decision_local.installed(config['decision_local_model'])


def endpoint(url):
    """A server's System One endpoint from what the user typed: its base
    URL with or without the /v1 that LM Studio, llama-server and Ollama
    addresses usually end in, or the endpoint itself."""
    url = (url or '').strip().rstrip('/')
    if url.endswith(('/systemone', '/decide')):
        return url
    return url + ('/systemone' if url.endswith('/v1') else '/v1/systemone')


def _target(config):
    """(provider, url, api key, model) for the chosen decision model."""
    which = provider(config)
    if which == 'api':
        return which, endpoint(config['decision_api_url']), config['decision_api_key'], \
            (config['decision_api_model'] or '').strip()
    if which == 'local':
        return which, endpoint(decision_local.base_url(config['decision_local_model'])), '', ''
    return which, JEV_URL, config['typesafe_api_key'], (config['jev_model'] or '').strip() or JEV_MODEL


def ask(config, state, qs, *, timeout=None, assets=None):
    """POST one request to the decision model `config` (the config row)
    chooses; returns the parsed body. Raises on HTTP errors.
    `assets` maps a reference string used in the state to an image
    ({'type': 'image', 'format': 'jpg', 'data_base64': ...}); images and Box
    questions are opt-in per request (docs.typesafe.ai/images). The local
    model's process takes the same request (decision_sidecar.py)."""
    which, url, api_key, model = _target(config)
    if (assets or any(q['type'] == 'box' for q in qs.values())) and not can_box(config):
        raise RuntimeError('The chosen decision model does not take images and Box questions.')
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    body = {'state': state, 'questions': to_request(qs)}
    if model:
        body['model'] = model
    if assets:
        headers['TypeSafe-Danger-Zone-Images'] = 'true'
        body['assets'] = assets
    timeout = timeout or TIMEOUT
    if which == 'local':
        # How long this caller waits: the local model answers one request
        # at a time, and drops one that is still queued by then.
        headers['X-Rexclaw-Wait'] = str(timeout[1])
    resp = _session().post(url, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    out = resp.json()
    if which != 'jev' and isinstance(out, dict):
        # input_ticks prices TypeSafe's tokens; nobody else's are billed here.
        out.pop('usage', None)
    return out


def answers(body, qs):
    """Jev's answers as {qid: {'level': int} | {'probs', 'pick', 'confidence'}
    | {'yes': p} | {'box', 'confidence'}}. A Box's edges are fractions of the
    image, from its top-left corner. A Score is rounded to its nearest level — its `score` is a
    probability-weighted position, good for a threshold and not for a
    magnitude — and a Choice keeps its whole distribution and its pick."""
    got = (body or {}).get('answers') or {}
    out = {}
    for qid, q in qs.items():
        a = got.get(qid) or {}
        if q['type'] == 'score' and isinstance(a.get('score'), (int, float)):
            out[qid] = {'level': int(round(a['score']))}
        elif q['type'] == 'choice' and isinstance(a.get('probabilities'), dict):
            out[qid] = {'probs': {k: float(p) for k, p in a['probabilities'].items()
                                  if k in q['criteria'] and isinstance(p, (int, float))},
                        'pick': a.get('choice'), 'confidence': float(a.get('confidence') or 0)}
        elif q['type'] == 'noul' and isinstance(a.get('noul'), (int, float)):
            out[qid] = {'yes': float(a['noul'])}
        elif q['type'] == 'box' and isinstance(a.get('box'), dict) and all(
                isinstance(a['box'].get(k), (int, float)) for k in ('left', 'top', 'right', 'bottom')):
            out[qid] = {'box': {k: float(a['box'][k]) for k in ('left', 'top', 'right', 'bottom')},
                        'confidence': float(a.get('confidence') or 0)}
    return out


def input_ticks(body):
    usage = (body or {}).get('usage') or {}
    try:
        return max(0, int(usage.get('input_tokens') or 0)) * TICKS_PER_INPUT_TOKEN
    except (TypeError, ValueError):
        return 0


def test(config):
    """Settings "Test": does the chosen decision model answer, and how fast
    is a round trip from here — once cold, once on the warm connection a
    call reuses. It waits as long as the features do (TIMEOUT), so a model
    too slow for them fails here too. `config` holds the form's values
    (unsaved ones included)."""
    which = provider(config)
    if which == 'jev' and not config['typesafe_api_key']:
        return {'ok': False, 'error': 'No TypeSafe API key.'}
    if which == 'api' and not (config['decision_api_url'] or '').strip():
        return {'ok': False, 'error': 'No server address.'}
    try:
        _, url, api_key, model = _target(config)
    except RuntimeError as e:  # the local model is not installed, or still loading
        return {'ok': False, 'error': str(e)}
    who = 'TypeSafe' if which == 'jev' else 'The decision model server'
    body = {'state': {'line': 'Hello there!'},
            'questions': {'q': {'type': 'noul', 'instructions': 'Is `line` a greeting?'}}}
    if model:
        body['model'] = model
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    if which == 'local':
        headers['X-Rexclaw-Wait'] = str(TIMEOUT[1])  # as ask() does
    times = []
    try:
        for _ in range(2):
            t0 = time.perf_counter()
            resp = _session().post(url, headers=headers, json=body, timeout=TIMEOUT)
            times.append(round((time.perf_counter() - t0) * 1000))
            if resp.status_code == 401:
                return {'ok': False, 'error': f'{who} rejected the key (401).'}
            if 400 <= resp.status_code < 500:
                # The request is fixed but for the key and the model, so
                # anything else it refuses is most likely the model name.
                return {'ok': False, 'error': f'{who} rejected the request ({resp.status_code}): '
                                              f'{resp.text[:160]} Check the model name.'}
            resp.raise_for_status()
        if not isinstance((resp.json().get('answers') or {}).get('q', {}).get('noul'), (int, float)):
            return {'ok': False, 'error': f'{who} answered, but not in the System One format: {resp.text[:160]}'}
        return {'ok': True, 'model': resp.json().get('model') or model or '?',
                'cold_ms': times[0], 'warm_ms': times[1]}
    except (requests.RequestException, ValueError) as e:
        return {'ok': False, 'error': f'{who} unreachable: {e}'}
