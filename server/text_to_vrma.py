# Copyright 2026 Codemarchant
"""generate_gesture — brand-new avatar motions from a text description, made
by the user's own Text-To-VRMA app (https://github.com/Kirakun0328/text-to-vrma,
MIT) over its local HTTP API.

Rexclaw only speaks the app's API: POST /v1/motions with a prompt and
format=vrma answers with a finished .vrma. Which engine makes the motion
(the local NVIDIA ARDY model, or LLM keyframes through OpenAI / Claude /
Codex) is a Settings choice that mirrors the app's own engine picker — the
keys for the paid engines live in that app, never here. The companion
never picks the engine; it only describes the movement.

The API is off by default in the app ("Advanced settings → Local HTTP API")
and shows an access token once enabled, which it requires as a Bearer token
on every request, /health included.

Voice-surface only: the tool exists to move the on-screen avatar (same rule
as play_gesture / set_emotion). The call waits for the render: the browser
dispatcher plays the returned vrma_url the moment the result lands, so the
companion's next words line up with the motion. (Answering at once and
playing in the background was tried first — the motion arrived seconds
after the line it belonged to.)

Files go to data/assets/generated/text_to_vrma/: a sub-folder of the shared
asset library, so serving (/user-assets/…) and the avatar Library picker
come for free, and a clip worth keeping can be added to an avatar's custom
gestures from there.
"""
import logging
import re
import time
import uuid

import requests

from .db import DATA_DIR
from .errors import UserError

_logger = logging.getLogger(__name__)

DEFAULT_URL = 'http://127.0.0.1:8787'
GENERATED_DIR = DATA_DIR / 'assets' / 'generated' / 'text_to_vrma'
GENERATED_URL_PREFIX = '/user-assets/generated/text_to_vrma'

# Mirrors the app's own pickers (src/apiServer.js: ENGINES, planner, speed).
ENGINES = ('ardy', 'openai', 'claude', 'codex')
PLANNERS = ('none', 'codex', 'openai', 'claude')   # ardy only
SPEEDS = ('fast', 'balanced', 'quality')           # openai / codex only

GENERATE_GESTURE_TOOL_NAME = 'generate_gesture'

_LOOP_PARAM = {
    'type': 'boolean',
    'description': (
        'true = the motion repeats until you end it (play_gesture \'idle\' or '
        'any other gesture stops it) - for ongoing activity: jogging on the '
        'spot, rowing a boat, juggling, conducting an orchestra. Leave '
        'it off for a motion that happens once.'
    ),
}

# How the prompt should be written depends on what reads it.
#
# ARDY is a caption-conditioned motion model: ONE sentence embedding drives
# the whole clip, and it was trained on short mocap captions (Bones Rigplay;
# the sister SEED set's captions run from 2-4 word labels to ~15-20 word
# sentences). NVIDIA's own presets are all one short "A person ..." sentence
# ("A person jumps backwards.", "A person bows down and then stands
# upright."), the model card asks for "neutral, physical terms", and
# Text-To-VRMA's ARDY planner prompt (src/llm.js) writes every segment as a
# concise "A person ..." sentence, with specific wording for one-shot actions
# ("jumps up high with both feet leaving the ground" fires more reliably than
# "jumps"). A 60-word choreography is far outside that distribution, and the
# engine's auto-duration adds 3 s per comma/"and"/"then" on top.
_ARDY_PROMPT = (
    'ONE short, plain sentence, under about 15 words, starting with '
    '"A person ..." and naming the action in physical terms: "A person does '
    'a deep curtsy.", "A person throws two quick punches and ducks.", "A '
    'person tiptoes forward, then looks over their shoulder.". English works '
    'best. Name the action and at most one detail (which hand, how many '
    'times, fast or slow). The motion model works from short captions like '
    'these, not from step-by-step choreography: describing technique, body '
    'mechanics, feelings or style makes the motion worse, not better.'
)
# The LLM-keyframe engines (openai / claude / codex) are the opposite: a
# language model reads the description and writes the keyframes, so physical
# detail is what it has to work from.
_LLM_PROMPT = (
    'The movement to perform, described concretely and physically - which '
    'limbs, what rhythm, what feeling (any language works): "a deep curtsy, '
    'one foot tucked behind, skirt held out to both sides, head dipped".'
)


def build_tool(can_loop, engine='ardy'):
    """The generate_gesture tool entry. `loop` is only offered when the
    session also carries play_gesture, whose 'idle' is what ends a loop.
    `engine` (config.gesture_gen_engine) picks the prompt-writing guidance.

    Every example here is a movement the built-in play_gesture set
    (browser_tools._BUILTIN_GESTURES) and the speaking-gesture library do NOT
    have - an example that names a listed gesture (a dance, a spin, a wave,
    push-ups, a bow) teaches the model to generate what it could just play.

    duration_seconds is deliberately not pushed: asked to set it on most
    calls, companions picked lengths that did not fit the motion. Left out,
    the app works the length out from the prompt (ARDY: 5 s base, 3.5 s for a
    single gesture, longer for sequences and locomotion)."""
    properties = {
        'prompt': {
            'type': 'string',
            'description': _ARDY_PROMPT if engine == 'ardy' else _LLM_PROMPT,
        },
        'duration_seconds': {
            'type': 'number',
            'description': (
                'Optional length in seconds (1-15). Leave it out and the '
                'length is worked out from the motion itself; set it when a '
                'specific length is asked for ("do that for ten seconds").'
            ),
        },
    }
    if can_loop:
        properties['loop'] = _LOOP_PARAM
    return {
        'type': 'function',
        'name': GENERATE_GESTURE_TOOL_NAME,
        'description': (
            'Invent a brand-new full-body motion from a description and '
            'perform it on your avatar - for any movement your gesture list '
            'does not cover: shadow-boxing, playing air guitar, a curtsy, '
            'sneaking on tiptoe, acting out what you are describing, miming '
            'something.'
        ),
        'parameters': {'type': 'object', 'properties': properties, 'required': ['prompt']},
    }


def _base_url(config):
    return (config['gesture_gen_url'] or '').strip().rstrip('/') or DEFAULT_URL


def _headers(token):
    token = (token or '').strip()
    return {'Authorization': f'Bearer {token}'} if token else {}


def _api_error(resp):
    """The app's error body is {"error": {"message", "code"}}."""
    try:
        err = resp.json().get('error') or {}
        return f"{err.get('message') or resp.status_code} ({err.get('code') or resp.status_code})"
    except ValueError:
        return f'HTTP {resp.status_code}'


# start_session asks twice per call (tools list + prompt section) and a call
# restart asks again — one probe per few seconds is plenty.
_reachable_cache = {}   # (url, token) -> (checked_at, ok)
_REACHABLE_TTL = 10.0


def reachable(config):
    """Is the app's API answering right now? Same "only when actually usable"
    rule as local_task / the Minecraft pair: a tool that can only fail is not
    offered, and the prompt never describes it. A refused local connection
    fails instantly, so the probe costs nothing when the app is closed."""
    url, token = _base_url(config), config['gesture_gen_token']
    hit = _reachable_cache.get((url, token))
    now = time.monotonic()
    if hit and now - hit[0] < _REACHABLE_TTL:
        return hit[1]
    try:
        ok = requests.get(f'{url}/health', headers=_headers(token), timeout=1.5).ok
    except requests.RequestException:
        ok = False
    _reachable_cache[(url, token)] = (now, ok)
    return ok


def offered(config, agent_row):
    """generate_gesture is on this companion's voice tool list: the global
    Settings switch, the companion's own toggle, and the app answering."""
    return (bool(config['gesture_gen_enabled']) and bool(agent_row['enable_gesture_gen'])
            and reachable(config))


def test_connection(url, token):
    """Reachability + which engines the app can run, for the Settings button."""
    url = (url or '').strip().rstrip('/') or DEFAULT_URL
    try:
        resp = requests.get(f'{url}/health', headers=_headers(token), timeout=5)
    except requests.RequestException as e:
        raise UserError(f'Could not reach Text-To-VRMA at {url}: {e}')
    if resp.status_code in (401, 403):
        raise UserError('Text-To-VRMA refused the access token - copy it again from the app.')
    if not resp.ok:
        raise UserError(f'Text-To-VRMA at {url} answered {resp.status_code}.')
    try:
        health = resp.json()
    except ValueError:
        health = {}
    if health.get('service') != 'text-to-vrma':
        raise UserError(f'{url} did not answer like Text-To-VRMA.')
    _reachable_cache.clear()
    configured = health.get('configured') or {}
    return {
        'ok': True, 'url': url,
        'engines': health.get('engines') or [],
        'openai_key': bool(configured.get('openai')),
        'claude_key': bool(configured.get('claude')),
    }


def execute_generate_gesture(con, session, agent, arguments):
    """Generate, store and return a VRMA gesture. Errors are returned as
    {'error': str} so the realtime model gets a structured failure."""
    if not agent['enable_gesture_gen']:
        return {'error': 'Gesture generation is disabled on this agent.'}
    if session['mode'] == 'text':
        return {'error': 'generate_gesture is not available in text mode.'}
    prompt = (arguments or {}).get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        return {'error': 'prompt is required.'}
    prompt = prompt.strip()[:4000]

    config = con.execute("SELECT * FROM config WHERE id = 1").fetchone()
    if not config['gesture_gen_enabled']:
        return {'error': 'Gesture generation is switched off in Settings.'}
    engine = config['gesture_gen_engine'] if config['gesture_gen_engine'] in ENGINES else 'ardy'
    loop = (arguments or {}).get('loop') is True
    duration = (arguments or {}).get('duration_seconds')
    try:
        duration = max(1.0, min(15.0, float(duration))) if duration is not None else None
    except (TypeError, ValueError):
        duration = None
    # The API has no loop field (the app decides looping on its own and a
    # .vrma answer does not carry it): looping is this side's playback, so
    # all the app can be given is a motion that closes on itself. For ARDY
    # that is NVIDIA's own preset wording ("A ballet dancer, performs a
    # forward, turn joining feet, in a repeating loop"); an LLM engine can
    # take the explicit instruction.
    sent_prompt = prompt
    if loop:
        sent_prompt = (prompt.rstrip(' .') + ', in a repeating loop.' if engine == 'ardy'
                       else prompt + ' (a repeating motion: one clean cycle that ends in '
                                     'the same pose it starts in)')
    body = {'engine': engine, 'format': 'vrma'}
    if engine == 'ardy':
        # The app's own default planner is codex — always say which one, or
        # every call would first try a Codex login the user may not have.
        planner = config['gesture_gen_planner']
        body['planner'] = planner if planner in PLANNERS else 'none'
        if duration:
            body['duration'] = duration
    else:
        # `duration` is an ardy-only field; the LLM engines read the length
        # from the description.
        if duration:
            sent_prompt += f' (about {duration:g} seconds long)'
        if engine in ('openai', 'codex') and config['gesture_gen_speed'] in SPEEDS:
            body['speed'] = config['gesture_gen_speed']
    body['prompt'] = sent_prompt[:4000]
    model = (config['gesture_gen_model'] or '').strip()
    if model and (engine != 'ardy' or body['planner'] != 'none'):
        body['model'] = model

    url = _base_url(config)
    try:
        # ARDY answers in seconds on a GPU; an LLM engine with its review
        # pass can take minutes.
        resp = requests.post(f'{url}/v1/motions', json=body,
                             headers=_headers(config['gesture_gen_token']), timeout=(5, 300))
    except requests.RequestException as e:
        return {'error': f'Could not reach Text-To-VRMA at {url}: {e}'}
    if not resp.ok:
        _logger.warning('Text-To-VRMA %s for session %s: %s', resp.status_code, session['id'], resp.text[:300])
        return {'error': f'Text-To-VRMA could not make that motion: {_api_error(resp)}'}
    if not resp.content.startswith(b'glTF'):
        return {'error': 'Text-To-VRMA did not answer with a .vrma file.'}

    slug = re.sub(r'[^a-zA-Z0-9]+', '-', prompt).strip('-').lower()[:32] or 'motion'
    fname = f'{slug}_{uuid.uuid4().hex[:8]}.vrma'
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    (GENERATED_DIR / fname).write_bytes(resp.content)
    return {
        'ok': True, 'vrma_url': f'{GENERATED_URL_PREFIX}/{fname}', 'loop': loop,
        'note': ('The motion is playing on your avatar now.'
                 + (" It repeats until you call play_gesture 'idle' or play another gesture."
                    if loop else '')),
    }
