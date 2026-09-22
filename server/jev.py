# Copyright 2026 Codemarchant
"""TypeSafe Jev — the judgment model behind the face director and the
speech gesture selector.

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

JEV_URL = 'https://api.typesafe.ai/v1/systemone'
# The config's jev_model, when the Settings field is left empty.
JEV_MODEL = 'jev-latest'
# TypeSafe bills input tokens only: $0.042 per million (docs.typesafe.ai/models),
# as xAI-style usd ticks (store.USD_TICKS_PER_USD = 1e10 per dollar).
TICKS_PER_INPUT_TOKEN = 420
# An answer about a line already spoken is useless, so no retries and a
# short read timeout; the connect timeout covers a cold TLS handshake.
TIMEOUT = (3, 4)
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


def ask(api_key, model, state, qs):
    """POST one request; returns the parsed body. Raises on HTTP errors."""
    resp = _session().post(
        JEV_URL,
        headers={'Authorization': f'Bearer {api_key}'},
        json={'model': (model or '').strip() or JEV_MODEL, 'state': state, 'questions': to_request(qs)},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def answers(body, qs):
    """Jev's answers as {qid: {'level': int} | {'probs', 'pick', 'confidence'}
    | {'yes': p}}. A Score is rounded to its nearest level — its `score` is a
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
    return out


def input_ticks(body):
    usage = (body or {}).get('usage') or {}
    try:
        return max(0, int(usage.get('input_tokens') or 0)) * TICKS_PER_INPUT_TOKEN
    except (TypeError, ValueError):
        return 0


def test_key(api_key, model):
    """Settings "Test": does the key work, and how fast is a round trip
    from here — once cold, once on the warm connection a call reuses."""
    if not api_key:
        return {'ok': False, 'error': 'No TypeSafe API key.'}
    qs = {'q': {'type': 'noul', 'instructions': 'Is `line` a greeting?'}}
    times = []
    try:
        for _ in range(2):
            t0 = time.perf_counter()
            resp = _session().post(
                JEV_URL, headers={'Authorization': f'Bearer {api_key}'},
                json={'model': (model or '').strip() or JEV_MODEL, 'state': {'line': 'Hello there!'}, 'questions': qs},
                timeout=TIMEOUT)
            times.append(round((time.perf_counter() - t0) * 1000))
            if resp.status_code == 401:
                return {'ok': False, 'error': 'TypeSafe rejected the key (401).'}
            if 400 <= resp.status_code < 500:
                # The request is fixed but for the key and the model, so
                # anything else it refuses is most likely the model name.
                return {'ok': False, 'error': f'TypeSafe rejected the request ({resp.status_code}): '
                                              f'{resp.text[:160]} Check the Jev model name.'}
            resp.raise_for_status()
        return {'ok': True, 'model': resp.json().get('model'), 'cold_ms': times[0], 'warm_ms': times[1]}
    except requests.RequestException as e:
        return {'ok': False, 'error': f'TypeSafe unreachable: {e}'}
