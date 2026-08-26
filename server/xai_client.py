# Copyright 2026 Codemarchant
"""Server-side client for xAI's Grok Voice Realtime + Responses + Imagine APIs.

Ported from the Odoo module's services/xai_client.py — logic unchanged, only
the exception import differs. The browser never holds the long-lived xAI API
key: the server mints per-session ephemeral tokens and the browser opens the
WebSocket directly to xAI with the short-lived secret.

Tools come from independent sources mixed into `session.update`:
  * native function tools (imagine + memory) — executed by the
    /api/voice/session/<id>/tool_call route server-side;
  * browser function tools (set_emotion, play_gesture, change_outfit) —
    executed by the JS tool dispatcher in the web client;
  * remote MCP entries (`type:'mcp'`) — opaque to us; xAI connects directly
    to each declared `server_url` with the configured Bearer token.
"""
import json
import logging
import re
import time
from datetime import datetime, timezone

import requests

from .errors import UserError

_logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30
RETRY_BACKOFF = (0.5, 1.0)  # seconds — one attempt per entry

NO_KEY_MSG = "xAI API key is not configured. Set it in Settings."


def _post_with_retry(url, headers, payload, timeout=DEFAULT_TIMEOUT):
    last_exc = None
    resp = None
    for attempt, backoff in enumerate(RETRY_BACKOFF):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except requests.RequestException as e:
            last_exc = e
            _logger.warning('xAI request failed (attempt %s): %s', attempt + 1, e)
            time.sleep(backoff)
            continue
        if resp.status_code < 500:
            return resp
        _logger.warning('xAI returned %s, retrying...', resp.status_code)
        time.sleep(backoff)
    if last_exc and resp is None:
        raise last_exc
    return resp  # last 5xx response


def _post_multipart_with_retry(url, headers, files, data, timeout=DEFAULT_TIMEOUT):
    """Same retry envelope as _post_with_retry but for multipart/form-data
    uploads. Used for /v1/files which expects the binary body alongside form
    fields like `expires_after` and `purpose`."""
    last_exc = None
    resp = None
    for attempt, backoff in enumerate(RETRY_BACKOFF):
        try:
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=timeout)
        except requests.RequestException as e:
            last_exc = e
            _logger.warning('xAI upload failed (attempt %s): %s', attempt + 1, e)
            time.sleep(backoff)
            continue
        if resp.status_code < 500:
            return resp
        _logger.warning('xAI upload returned %s, retrying...', resp.status_code)
        time.sleep(backoff)
    if last_exc and resp is None:
        raise last_exc
    return resp


def _delete_with_retry(url, headers, timeout=DEFAULT_TIMEOUT):
    last_exc = None
    resp = None
    for attempt, backoff in enumerate(RETRY_BACKOFF):
        try:
            resp = requests.delete(url, headers=headers, timeout=timeout)
        except requests.RequestException as e:
            last_exc = e
            _logger.warning('xAI delete failed (attempt %s): %s', attempt + 1, e)
            time.sleep(backoff)
            continue
        if resp.status_code < 500:
            return resp
        _logger.warning('xAI delete returned %s, retrying...', resp.status_code)
        time.sleep(backoff)
    if last_exc and resp is None:
        raise last_exc
    return resp


def generate_image(*, xai_api_key, images_url, model, prompt,
                   aspect_ratio=None, response_format='b64_json', user=None):
    """POST /v1/images/generations to generate an image with Grok Imagine.

    Returns the raw decoded response body. The caller is responsible for
    base64-decoding `data[0].b64_json` into bytes.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    if not prompt:
        raise UserError("Image prompt is required.")
    payload = {
        'model': model,
        'prompt': prompt,
        'response_format': response_format,
    }
    if aspect_ratio:
        payload['aspect_ratio'] = aspect_ratio
    if user:
        payload['user'] = str(user)
    headers = {
        'Authorization': f'Bearer {xai_api_key}',
        'Content-Type': 'application/json',
    }
    # Image generation is slower than chat — bump the timeout. 120s matches
    # typical Imagine latencies plus a safety margin for the 2k resolution path.
    resp = _post_with_retry(images_url, headers, payload, timeout=120)
    if resp.status_code >= 400:
        _logger.error('xAI image generation failed: %s %s', resp.status_code, resp.text)
        raise UserError(f"Image generation failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    if not isinstance(body, dict) or not isinstance(body.get('data'), list) or not body['data']:
        _logger.error('xAI image generation: unexpected response shape: %s', body)
        raise UserError(f"Image generation returned an unexpected response: {str(body)[:300]}")
    return body


def edit_image(*, xai_api_key, edits_url, model, prompt,
               image_data_uris=None, aspect_ratio=None,
               response_format='b64_json', user=None):
    """POST /v1/images/edits with one or more source images.

    Sources come as `image_data_uris` (base64 data URIs — the
    Imagine-library flow, since our files are local). xAI's endpoint
    accepts `image: {...}` (single) or `images: [{...}, ...]` (multi);
    the two are mutually exclusive in the request body, so we pick the
    form based on how many sources we have.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    if not prompt:
        raise UserError("Edit prompt is required.")
    if not image_data_uris:
        raise UserError("Image edit requires at least one source image.")
    payload = {
        'model': model,
        'prompt': prompt,
        'response_format': response_format,
    }
    entries = [{'url': u, 'type': 'image_url'} for u in image_data_uris]
    if len(entries) == 1:
        payload['image'] = entries[0]
    else:
        payload['images'] = entries
    if aspect_ratio:
        payload['aspect_ratio'] = aspect_ratio
    if user:
        payload['user'] = str(user)
    headers = {
        'Authorization': f'Bearer {xai_api_key}',
        'Content-Type': 'application/json',
    }
    resp = _post_with_retry(edits_url, headers, payload, timeout=120)
    if resp.status_code >= 400:
        _logger.error('xAI image edit failed: %s %s', resp.status_code, resp.text)
        raise UserError(f"Image edit failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    if not isinstance(body, dict) or not isinstance(body.get('data'), list) or not body['data']:
        _logger.error('xAI image edit: unexpected response shape: %s', body)
        raise UserError(f"Image edit returned an unexpected response: {str(body)[:300]}")
    return body


def generate_video(*, xai_api_key, videos_url, model, prompt,
                   mode='generate', image_data_uri=None,
                   reference_image_data_uris=None, reference_voice_ids=None,
                   video_data_uri=None,
                   duration_seconds=None,
                   aspect_ratio=None, resolution=None,
                   poll_interval=2.0, poll_timeout=240):
    """POST a video job, then poll GET /v1/videos/{request_id} until the
    clip is ready. Returns {'url', 'duration', 'model', 'raw'}.

    `mode` picks the endpoint (all share the request/poll protocol):
      * 'generate' → /v1/videos/generations — text-, image-
        (`image_data_uri`, first frame locked) or reference-to-video
        (`reference_image_data_uris`, subjects appear without locking the
        framing).
      * 'extend' → /v1/videos/extensions — `video_data_uri` required;
        `duration_seconds` is the length of the ADDED portion, the prompt
        describes what happens next.
      * 'edit' → /v1/videos/edits — `video_data_uri` required; the prompt
        describes the change. xAI ignores duration/aspect/resolution here
        (output inherits the input, capped at 720p) so they're omitted.

    Video jobs are asynchronous on xAI's side: the POST returns only a
    request_id and the result URL appears on the status endpoint once the
    status flips to 'done'. The mp4 lives at a TEMPORARY vidgen.x.ai URL —
    callers must download it promptly (see download_video_bytes) rather than
    storing the URL. xAI accepts public URLs or base64 data URIs in the
    `.url` fields — our source files are local, so the data-URI form is the
    only one that works here.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    if not prompt:
        raise UserError("Video prompt is required.")
    if mode in ('extend', 'edit') and not video_data_uri:
        raise UserError(f"Video {mode} requires a source video.")
    # All three endpoints hang off the same base path — derive it from the
    # configured generations URL so a proxy/base-URL override still works.
    base_url = videos_url.rstrip('/')
    if base_url.endswith('/generations'):
        base_url = base_url[: -len('/generations')]
    endpoint = {
        'generate': f'{base_url}/generations',
        'extend': f'{base_url}/extensions',
        'edit': f'{base_url}/edits',
    }.get(mode)
    if not endpoint:
        raise UserError(f"Unknown video mode {mode!r}.")

    payload = {
        'model': model,
        'prompt': prompt,
    }
    if video_data_uri:
        payload['video'] = {'url': video_data_uri}
    if image_data_uri:
        payload['image'] = {'url': image_data_uri}
    if reference_image_data_uris:
        payload['reference_images'] = [{'url': u} for u in reference_image_data_uris]
    if reference_voice_ids:
        # Reference audio picks a voice from xAI's built-in TTS roster by id —
        # uploading your own clip is not supported. Sending this (with or
        # without reference_images) puts the request in reference-to-video
        # mode. Regionally gated: outside the enabled set xAI answers
        # permission_denied, which surfaces to the caller as a UserError.
        payload['reference_audios'] = [{'voice_id': v} for v in reference_voice_ids]
    if mode != 'edit':
        if duration_seconds:
            payload['duration'] = int(duration_seconds)
        if aspect_ratio:
            payload['aspect_ratio'] = aspect_ratio
        if resolution:
            payload['resolution'] = resolution
    headers = {
        'Authorization': f'Bearer {xai_api_key}',
        'Content-Type': 'application/json',
    }
    resp = _post_with_retry(endpoint, headers, payload, timeout=120)
    if resp.status_code >= 400:
        _logger.error('xAI video %s failed: %s %s', mode, resp.status_code, resp.text)
        raise UserError(f"Video {mode} failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    request_id = body.get('request_id') or body.get('id')
    if not request_id:
        _logger.error('xAI video %s: no request_id in response: %s', mode, body)
        raise UserError(f"Video job returned no request id: {str(body)[:300]}")

    status_url = f"{base_url}/{request_id}"

    deadline = time.monotonic() + poll_timeout
    last_status = None
    while time.monotonic() < deadline:
        try:
            poll = requests.get(status_url, headers=headers, timeout=30)
        except requests.RequestException as e:
            _logger.warning('xAI video status poll failed: %s', e)
            time.sleep(poll_interval)
            continue
        if poll.status_code >= 400:
            _logger.error('xAI video status failed: %s %s', poll.status_code, poll.text)
            raise UserError(f"Video status check failed ({poll.status_code}): {poll.text[:300]}")
        status_body = poll.json()
        last_status = status_body.get('status')
        if last_status == 'done':
            video = status_body.get('video') or {}
            url = video.get('url') or status_body.get('url')
            if not url:
                _logger.error('xAI video done but no url: %s', status_body)
                raise UserError(f"Video finished but xAI returned no URL: {str(status_body)[:300]}")
            return {
                'url': url,
                'duration': video.get('duration'),
                'model': status_body.get('model') or model,
                'raw': status_body,
            }
        if last_status in ('failed', 'expired'):
            _logger.error('xAI video generation %s: %s', last_status, status_body)
            # Surface whatever reason the status body carries — without it
            # the model (and user) just see "failed" while the actual cause
            # (e.g. a moderation rejection of the source video) only lands
            # in the server log.
            reason = (status_body.get('error') or status_body.get('failure_reason')
                      or status_body.get('detail') or status_body.get('message') or '')
            if isinstance(reason, dict):
                reason = reason.get('message') or str(reason)
            raise UserError(
                f"Video generation {last_status}."
                + (f" Reason: {str(reason)[:300]}" if reason
                   else " xAI returned no reason — see the server log.")
            )
        time.sleep(poll_interval)
    raise UserError(
        f"Video generation timed out after {poll_timeout}s (last status: {last_status})."
    )


def download_video_bytes(url, *, xai_api_key=None, timeout=120):
    """Fetch the finished mp4 from its temporary vidgen.x.ai URL. The link is
    normally pre-signed (no auth), but retry once with the Bearer header in
    case xAI ever gates it."""
    try:
        resp = requests.get(url, timeout=timeout)
        if resp.status_code in (401, 403) and xai_api_key:
            resp = requests.get(
                url, headers={'Authorization': f'Bearer {xai_api_key}'}, timeout=timeout,
            )
    except requests.RequestException as e:
        raise UserError(f"Video download failed: {e}")
    if resp.status_code >= 400:
        raise UserError(f"Video download failed ({resp.status_code}).")
    if not resp.content:
        raise UserError("Video download returned no data.")
    return resp.content


def mint_ephemeral_token(*, xai_api_key, client_secrets_url, expires_after_seconds=900):
    """POST /v1/realtime/client_secrets to mint an ephemeral token for the browser.

    xAI's ephemeral-token endpoint accepts ONLY `{expires_after: {seconds: N}}`;
    session config (voice, tools, instructions) must be sent later via
    `session.update` on the WebSocket. We compose that config separately and
    return it alongside the token so the browser can send it as soon as the
    socket opens.

    :return: dict with `token` (the xai-client-secret.* string) and `expires_at`.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)

    payload = {'expires_after': {'seconds': int(expires_after_seconds)}}
    headers = {
        'Authorization': f'Bearer {xai_api_key}',
        'Content-Type': 'application/json',
    }
    resp = _post_with_retry(client_secrets_url, headers, payload)
    if resp.status_code >= 400:
        _logger.error('xAI token mint failed: %s %s', resp.status_code, resp.text)
        raise UserError(f"xAI token mint failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    # xAI returns `{"value": "...", "expires_at": ...}` at the top level. We
    # also accept a nested `client_secret.value` shape in case the API ever
    # shifts to OpenAI's wrapped variant.
    token = body.get('value')
    expires_at = body.get('expires_at')
    if not token:
        nested = body.get('client_secret')
        if isinstance(nested, dict):
            token = nested.get('value')
            expires_at = expires_at or nested.get('expires_at')
        elif isinstance(nested, str):
            token = nested
    if not token or not isinstance(token, str):
        _logger.error('xAI token mint: could not locate token in response: %s', body)
        raise UserError("xAI returned a response we couldn't parse — see server log.")
    return {
        'token': token,
        'expires_at': expires_at,
        'raw': body,
    }


def build_session_update(*, voice, instructions, browser_tools,
                         mcp_entries=None, native_function_tools=None,
                         enable_web_search=False, enable_x_search=False,
                         audio_sample_rate=24000, manual_turn=False):
    """Build the `session.update` JSON the browser will send over the WebSocket.

    Note: model goes in the WebSocket URL (?model=...), NOT in session.update —
    including it here causes xAI to silently reject the update and the assistant
    never replies even though user transcripts still flow.
    """
    tools = []
    for entry in mcp_entries or []:
        tools.append(entry)
    for entry in native_function_tools or []:
        tools.append(entry)
    for bt in browser_tools or []:
        tools.append({
            'type': 'function',
            'name': bt['name'],
            'description': bt['description'],
            'parameters': bt['parameters'],
        })
    # xAI handles web/X search itself — no MCP plumbing; the model can call
    # these tools directly and we just see the eventual answer text.
    if enable_web_search:
        tools.append({'type': 'web_search'})
    if enable_x_search:
        tools.append({'type': 'x_search'})

    return {
        'type': 'session.update',
        'session': {
            'voice': voice,
            'instructions': instructions,
            'tools': tools,
            # Bare {type: server_vad} lets xAI apply its tuned defaults for
            # threshold / silence_duration_ms / prefix_padding_ms — tighter
            # custom values were swallowing soft/quiet speech.
            #
            # manual_turn (multi-agent peer legs): {type: null} per xAI's
            # docs disables auto turn detection entirely — the session only
            # generates when the client sends response.create. Peer agents
            # in a group call never hear the mic and must only speak when
            # the turn director says so; server_vad would have nothing to
            # detect anyway, and any stray audio would trigger phantom turns.
            'turn_detection': {
                'type': None if manual_turn else 'server_vad',
            },
            # Sample rate is determined client-side from the browser's native
            # AudioContext rate (typically 48000 on desktop). Matching xAI's
            # input/output rate to the device's native rate eliminates the
            # silent resample pass on every mic frame and playback chunk.
            'audio': {
                'input': {'format': {'type': 'audio/pcm', 'rate': audio_sample_rate}},
                'output': {'format': {'type': 'audio/pcm', 'rate': audio_sample_rate}},
            },
        },
    }


SUMMARY_INSTRUCTIONS = (
    'You are a summarization service for an ongoing assistant conversation. '
    'Your ONLY task is to produce a summary of the transcript the user supplies. '
    'You are NOT participating in the conversation, NOT taking a turn as the '
    'assistant, and NOT answering any questions present in the transcript. '
    'Echoing or rephrasing the latest assistant message is incorrect output.\n\n'
    'The user message will contain a transcript wrapped in BEGIN TRANSCRIPT / '
    'END TRANSCRIPT markers. It may begin with a "[Prior summary]" block — that '
    'text stands in for earlier conversation you can no longer see, so treat it '
    'as established fact. Your output must be a superset of it: carry every '
    'load-bearing detail from the prior summary forward and fold the newer '
    'turns in alongside, as one updated summary. Tighten the wording freely, '
    'but keep all of the prior summary\'s coverage.\n\n'
    'Preserve user intent, decisions made, named entities, numbers, outcomes '
    'of notable tool calls or results, key relationship events with the user, '
    'and any open threads — unanswered user questions or pending actions the '
    'assistant agreed to take. Drop pleasantries and small talk. Do not '
    'include the literal "[Tool call]" / '
    '"[Tool result]" markers or XML tags like <function_call> in your output '
    '— describe tool activity in plain prose.\n\n'
    'Length should match the scope of the conversation. Do not pad — a brief, '
    'low-information session should produce a brief summary, while a long and '
    'substantive one warrants more space. This summary will itself be '
    're-summarized in future passes as the relationship continues, so favour '
    'concise wording — but concision means stating each fact briefly, never '
    'leaving facts out.\n\n'
    'Output plain text in third-person past tense, written in the same '
    'language the conversation was conducted in, so the assistant can read '
    'it later as context. Begin your output with "Conversation summary so far:".'
)


def _extract_response_text(body):
    """Pull the assistant's plain text out of a /v1/responses body."""
    if not isinstance(body, dict):
        return ''
    if isinstance(body.get('output_text'), str) and body['output_text']:
        return body['output_text']
    chunks = []
    for item in (body.get('output') or []):
        if not isinstance(item, dict):
            continue
        for part in (item.get('content') or []):
            if isinstance(part, dict) and part.get('type') == 'output_text':
                text = part.get('text')
                if text:
                    chunks.append(text)
    return ''.join(chunks).strip()


def create_response(*, xai_api_key, responses_url, model, input_items,
                    instructions=None, tools=None, reasoning_effort=None,
                    previous_response_id=None, max_output_tokens=None,
                    max_turns=None, prompt_cache_key=None,
                    user=None, store=True, timeout=600):
    """POST /v1/responses and return the parsed body dict.

    Behaviour notes (per xAI's spec):
      * `instructions` cannot be combined with `previous_response_id` (xAI
        carries forward the prior call's system prompt). We silently drop
        `instructions` when chaining.
      * `reasoning.effort` accepts `low | medium | high` per the spec, plus
        `xhigh` on the multi-agent model (it maps effort to agent count).
        Anything else (including 'none') omits the reasoning block entirely.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    payload = {
        'model': model,
        'input': input_items,
        'store': bool(store),
    }
    if previous_response_id:
        payload['previous_response_id'] = previous_response_id
    elif instructions:
        payload['instructions'] = instructions
    if tools:
        payload['tools'] = tools
    if reasoning_effort in ('low', 'medium', 'high', 'xhigh'):
        payload['reasoning'] = {'effort': reasoning_effort}
    if max_output_tokens:
        payload['max_output_tokens'] = int(max_output_tokens)
    if max_turns is not None:
        payload['max_turns'] = int(max_turns)
    if prompt_cache_key:
        payload['prompt_cache_key'] = prompt_cache_key
    if user:
        payload['user'] = user
    headers = {
        'Authorization': f'Bearer {xai_api_key}',
        'Content-Type': 'application/json',
    }
    resp = _post_with_retry(responses_url, headers, payload, timeout=timeout)
    if resp.status_code >= 400:
        _logger.error('xAI responses call failed: %s %s', resp.status_code, resp.text)
        raise UserError(f"xAI responses call failed ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


def upload_file(*, xai_api_key, files_url, filename, content_bytes, mimetype,
                expires_after_seconds, purpose='user_data'):
    """POST multipart /v1/files. Returns
    {file_id, filename, expires_at, size_bytes, mimetype, raw}.

    `expires_at` is normalized to an ISO naive-UTC string so callers can write
    it straight to the DB.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    headers = {'Authorization': f'Bearer {xai_api_key}'}
    data = {'purpose': purpose}
    if expires_after_seconds:
        data['expires_after'] = str(int(expires_after_seconds))
    safe_filename = str(filename or 'upload.bin')
    files = {'file': (safe_filename, content_bytes, mimetype or 'application/octet-stream')}
    resp = _post_multipart_with_retry(files_url, headers, files, data, timeout=300)
    if resp.status_code >= 400:
        _logger.error('xAI file upload failed: %s %s', resp.status_code, resp.text)
        raise UserError(f"xAI file upload failed ({resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    file_id = body.get('id') or body.get('file_id')
    if not file_id:
        raise UserError(f"xAI did not return a file id (got {body!r:.300}).")
    return {
        'file_id': str(file_id),
        'filename': str(body.get('filename') or safe_filename),
        'expires_at': _normalize_xai_timestamp(body.get('expires_at')),
        'size_bytes': int(body.get('bytes') or body.get('size_bytes') or len(content_bytes)),
        'mimetype': mimetype,
        'raw': body,
    }


def _normalize_xai_timestamp(value):
    """Convert an xAI-returned timestamp into an ISO naive-UTC string.
    Accepts unix int/float, ISO string, or None. Returns None when empty or
    unparseable."""
    if value is None or value is False:
        return None
    if isinstance(value, (int, float)):
        try:
            dt = datetime.fromtimestamp(int(value), tz=timezone.utc).replace(tzinfo=None)
            return dt.isoformat(timespec="seconds")
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.rstrip('Z')).isoformat(timespec="seconds")
        except ValueError:
            return None
    return None


def delete_file(*, xai_api_key, files_url, file_id):
    """DELETE /v1/files/{file_id}. Best-effort — logs failure but never raises."""
    if not xai_api_key or not file_id:
        return False
    headers = {'Authorization': f'Bearer {xai_api_key}'}
    url = files_url.rstrip('/') + '/' + file_id
    try:
        resp = _delete_with_retry(url, headers, timeout=30)
    except Exception as e:
        _logger.warning('xAI file delete crashed for %s: %s', file_id, e)
        return False
    if resp.status_code >= 400 and resp.status_code != 404:
        _logger.warning('xAI file delete failed (%s): %s', resp.status_code, resp.text[:300])
        return False
    return True


DIRECTOR_INSTRUCTIONS = (
    'You are the turn director for a live group voice call between a human '
    'user and multiple AI companions. The transcript is ordered oldest '
    'first — the most recent message is at the BOTTOM. Decide who '
    'naturally speaks next: one of the listed companions, or the user.\n\n'
    'Apply these rules IN PRIORITY ORDER:\n'
    '1. If the most recent message addresses a specific COMPANION by name '
    '(e.g. "Eve, how are you?", "what about you, Ara?"), that companion '
    'speaks next. This ALWAYS overrides whoever has been speaking so far, '
    'including the current floor holder.\n'
    '2. If the most recent message is FROM a companion and it addresses '
    'the user, asks the user something, or finishes the companion\'s '
    'thought, answer: user. The user is addressed by their name, a '
    'nickname or title (e.g. "Captain"), or "you" — any name that matches '
    'no companion in the participant list refers to the user, and the '
    'user is never a participant key.\n'
    '3. If the natural next speaker is not in the participant list (for '
    'example the companion who just spoke), answer: user.\n'
    '4. Otherwise the floor holder (the companion the user has been '
    'talking with, when listed) continues.\n\n'
    'Reply with exactly ONE token: user, or one participant key copied '
    'character-for-character from the participant list. No other text.'
)


def decide_next_speaker(*, xai_api_key, responses_url, model, transcript_lines,
                        participants, user_name='User', floor_key=None):
    """One-shot classification: who speaks next in a group voice call?

    :param transcript_lines: list of '[Name]: text' strings, oldest first
    :param participants: list of {'key': str, 'name': str} candidate agents
    :param floor_key: key of the participant currently holding the floor
        (the one the user has been talking with), if any
    :returns: (decision, usage_dict) where decision is a participant key,
        'user', or None when the reply named nothing recognizable — the
        caller must treat None as "no decision", not as "wait for the
        user".
    """
    roster = "\n".join(f"- key: {p['key']}  name: {p['name']}" for p in participants)
    floor = next((p for p in participants if p['key'] == floor_key), None)
    floor_line = (
        f'The current floor holder (the companion the user has been talking '
        f'with) is "{floor["name"]}" (key: {floor["key"]}).\n'
        if floor else ''
    )
    prompt = (
        f'Participants who could speak next:\n{roster}\n'
        f'The human user appears in the transcript as "{user_name}".\n'
        + floor_line + '\n'
        '--- RECENT TRANSCRIPT ---\n'
        + "\n".join(transcript_lines)
        + '\n--- END TRANSCRIPT ---\n\n'
        'Who should speak next in response to the most recent message '
        'above?\n'
        'Answer with exactly one token: user or one participant key from '
        'the list. Nothing else.'
    )
    body = create_response(
        xai_api_key=xai_api_key,
        responses_url=responses_url,
        model=model,
        input_items=[{
            'role': 'user',
            'content': [{'type': 'input_text', 'text': prompt}],
        }],
        instructions=DIRECTOR_INSTRUCTIONS,
        tools=None,
        reasoning_effort=None,
        store=False,
        timeout=15,
    )
    text = (_extract_response_text(body) or '').strip().strip('"\'').lower()
    valid = {p['key'].lower(): p['key'] for p in participants}
    # Display names as a drift net: the prompt forbids them, but a model
    # answering "Eve" instead of "peer-1" still names a real target.
    for p in participants:
        valid.setdefault(p['name'].strip().lower(), p['key'])
        valid.setdefault(p['name'].strip().split(' ')[0].lower(), p['key'])
    if text in valid:
        decision = valid[text]
    elif text == 'user':
        decision = 'user'
    else:
        # Tolerate mild format drift ("next: peer-1", "peer-1.") by
        # scanning tokens. A reply naming nothing recognizable is a parse
        # FAILURE (None) — the browser falls back to its local rules
        # rather than mistaking garbage for "wait for the user".
        tokens = [t.lower() for t in re.findall(r'[\w-]+', text)]
        decision = next((valid[t] for t in tokens if t in valid), None)
        if decision is None and 'user' in tokens:
            decision = 'user'
        if decision is None:
            _logger.warning("director reply unparseable: %r", text[:200])
    return decision, (body.get('usage') if isinstance(body, dict) else None) or {}


TITLE_INSTRUCTIONS = (
    'You name conversations. Given a short transcript of the opening turns of '
    'an assistant chat, produce a concise descriptive title for the conversation '
    '(4-8 words, sentence case, no surrounding quotes, no trailing period, no '
    'emoji). Focus on the user\'s subject of interest — not pleasantries. '
    'Examples: "Quarterly sales report for Acme", "Stock move debugging", '
    '"Drafting a partner welcome email". Reply with ONLY the title text.'
)


def generate_title(*, xai_api_key, responses_url, summary_model, transcript):
    """Produce a short descriptive title for a fresh conversation.

    Returns a (title_text, usage_dict) tuple — the usage block is surfaced so
    callers can track cost_in_usd_ticks.
    """
    body = create_response(
        xai_api_key=xai_api_key,
        responses_url=responses_url,
        model=summary_model,
        input_items=[{
            'role': 'user',
            'content': [{
                'type': 'input_text',
                'text': (
                    'Produce a 4-8 word descriptive title for the following '
                    'conversation opening. Reply with only the title.\n\n'
                    '--- BEGIN TRANSCRIPT ---\n'
                    f'{transcript}'
                    '\n--- END TRANSCRIPT ---'
                ),
            }],
        }],
        instructions=TITLE_INSTRUCTIONS,
        tools=None,
        reasoning_effort=None,
        store=False,
        timeout=30,
    )
    text = _extract_response_text(body) or ''
    text = text.strip().strip('"“”‘’').rstrip('.').strip()
    if len(text) > 80:
        text = text[:77].rstrip() + '...'
    return text, (body.get('usage') if isinstance(body, dict) else None) or {}


def generate_summary(*, xai_api_key, responses_url, summary_model, transcript,
                     reasoning_effort=None):
    """Compress a conversation transcript into a single rolled-up summary string.

    Wrapping the whole transcript inside one user message (rather than sending
    it as alternating user/assistant turns) is essential — without that, the
    model treats the transcript as a live dialog and "responds" as the next
    assistant turn instead of summarizing it.
    """
    body = create_response(
        xai_api_key=xai_api_key,
        responses_url=responses_url,
        model=summary_model,
        input_items=[{
            'role': 'user',
            'content': [{
                'type': 'input_text',
                'text': (
                    'Summarize the following assistant conversation. Follow '
                    'the system instructions precisely; do NOT respond to or '
                    'continue the conversation, and do NOT take a turn as the '
                    'assistant.\n\n'
                    '--- BEGIN TRANSCRIPT ---\n'
                    f'{transcript}'
                    '\n--- END TRANSCRIPT ---'
                ),
            }],
        }],
        instructions=SUMMARY_INSTRUCTIONS,
        tools=None,
        reasoning_effort=reasoning_effort,
        store=False,
        # A big rollup (long prior summary + a text-mode block) can take
        # well over a minute to write; at 120s the call timed out, retried
        # three times and 500'd — leaving needs_summary set so every turn
        # re-ran the same 6-minute failure.
        timeout=300,
    )
    text = _extract_response_text(body)
    if not text:
        raise UserError("xAI returned no text for the summary.")
    return text, (body.get('usage') if isinstance(body, dict) else None) or {}


EXTRACTION_INSTRUCTIONS = (
    'You are a memory-extraction service for an ongoing assistant relationship '
    'with a user. You are not participating in the conversation and not taking a '
    'turn — you read a transcript and emit durable memory as a single JSON '
    'object, nothing else.\n\n'
    'Output exactly one JSON object with this shape:\n'
    '{\n'
    '  "facts": [\n'
    '    {"op": "add", "scope": "recall", "content": "...", "tags": ["..."]},\n'
    '    {"op": "update", "target_id": 12, "content": "...", "tags": ["..."]},\n'
    '    {"op": "delete", "target_id": 34}\n'
    '  ],\n'
    '  "episode": {"summary": "...", "keywords": "...", "tags": ["..."]}\n'
    '}\n\n'
    'FACTS — durable statements about the user, written in third person. Reserve '
    'scope "core" for identity- and relationship-level facts that stay true '
    'across sessions (who they are, their role, key people, standing '
    'preferences, long-running projects). Use scope "recall" (prefer this) for '
    'everything else worth keeping — situational details, one-off context, '
    'casual preferences. The user message lists the existing core facts with '
    'their ids: when this conversation changes one, emit an "update" against its '
    'id; when it clearly contradicts or retires one, emit a "delete". Leave '
    'existing facts that are still accurate alone — do not re-add them. If '
    'nothing new is worth storing, return an empty "facts" list.\n\n'
    'EPISODE — always provide one. "summary" is a concise narrative of THIS '
    'block of conversation in third-person past tense. "keywords" is a short '
    'comma-separated index of the entities, people, places, topics and the '
    'kinds of referential phrases the user might later use to bring this moment '
    'back up ("the Lisbon trip", "that restaurant", "the budget argument") — '
    'this is what future recall searches match against, so make it rich with '
    'concrete names. Drop pleasantries.\n\n'
    'Reuse tags from the known-tags list in the user message where they fit, '
    'rather than inventing synonyms. Write all text in the same language the '
    'conversation was conducted in. Output only the JSON object.'
)


def _strip_json_fences(text):
    """Strip a leading ```json / ``` fence and trailing ``` if the model wrapped
    its JSON in a markdown code block, and trim any prose around the object."""
    if not text:
        return ''
    text = text.strip()
    if text.startswith('```'):
        # Drop the opening fence line (``` or ```json) and the closing fence.
        text = text.split('\n', 1)[1] if '\n' in text else ''
        if text.rstrip().endswith('```'):
            text = text.rstrip()[:-3]
    # Fall back to the outermost { … } span if there is leading/trailing prose.
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    return text.strip()


def generate_memory_extraction(*, xai_api_key, responses_url, summary_model,
                               transcript, existing_core=None, known_tags=None,
                               reasoning_effort=None):
    """Extract durable memory from a rolled-up transcript.

    Returns `(parsed_or_None, usage_dict)`. `parsed` is a dict
    `{'facts': [...], 'episode': {...}}` validated to that shape, or None on any
    HTTP/parse/shape failure — the caller treats None as "nothing to store" and
    must never let a hiccup here break compaction. Same Responses-API shape as
    generate_summary; the usage block is surfaced for cost accrual.

    `existing_core` is an iterable of (id, content) for the user's current core
    facts, rendered into the prompt so the model can emit update/delete ops
    against real ids. `known_tags` is a list of tag tokens to encourage reuse.
    """
    core_lines = '\n'.join(
        f'  [id={cid}] {ccontent}' for cid, ccontent in (existing_core or [])
    ) or '  (none yet)'
    tags_line = ', '.join(known_tags or []) or '(none yet)'

    body = create_response(
        xai_api_key=xai_api_key,
        responses_url=responses_url,
        model=summary_model,
        input_items=[{
            'role': 'user',
            'content': [{
                'type': 'input_text',
                'text': (
                    'Extract durable memory from the following assistant '
                    'conversation. Follow the system instructions precisely and '
                    'reply with only the JSON object.\n\n'
                    'Existing core facts (use their ids for update/delete):\n'
                    f'{core_lines}\n\n'
                    f'Known tags: {tags_line}\n\n'
                    '--- BEGIN TRANSCRIPT ---\n'
                    f'{transcript}'
                    '\n--- END TRANSCRIPT ---'
                ),
            }],
        }],
        instructions=EXTRACTION_INSTRUCTIONS,
        tools=None,
        reasoning_effort=reasoning_effort,
        store=False,
        timeout=120,
    )
    usage = (body.get('usage') if isinstance(body, dict) else None) or {}
    text = _extract_response_text(body)
    if not text:
        return None, usage
    try:
        parsed = json.loads(_strip_json_fences(text))
    except (ValueError, TypeError):
        _logger.warning('Memory extraction returned non-JSON output; skipping.')
        return None, usage
    if not isinstance(parsed, dict):
        return None, usage
    facts = parsed.get('facts')
    episode = parsed.get('episode')
    return {
        'facts': facts if isinstance(facts, list) else [],
        'episode': episode if isinstance(episode, dict) else {},
    }, usage


# Model discovery — the typed listing endpoints (language / image / video).
# There is no realtime-models endpoint, so voice models come from the flat
# /v1/models list filtered by id prefix.
MODEL_LIST_KINDS = {
    'language': ('language-models', None),
    'image': ('image-generation-models', None),
    'video': ('video-generation-models', None),
    'voice': ('models', 'grok-voice'),
}


def list_models(*, xai_api_key, base_url, kind, timeout=DEFAULT_TIMEOUT):
    """[{id, aliases}] for one model kind, sorted by id. `base_url` is the
    API root (https://api.x.ai/v1). Raises UserError with xAI's message."""
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    try:
        endpoint, prefix = MODEL_LIST_KINDS[kind]
    except KeyError:
        raise UserError(f"Unknown model kind: {kind}")
    url = f"{base_url.rstrip('/')}/{endpoint}"
    headers = {'Authorization': f'Bearer {xai_api_key}'}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
    except requests.RequestException as e:
        raise UserError(f"Could not reach xAI: {e}")
    if resp.status_code >= 400:
        raise UserError(f"Model list failed ({resp.status_code}): {resp.text[:300]}")
    try:
        body = resp.json()
    except ValueError:
        raise UserError("Model list returned a non-JSON response.")
    items = body.get('models') or body.get('data') or [] if isinstance(body, dict) else body
    out = []
    for item in items if isinstance(items, list) else []:
        model_id = item.get('id') if isinstance(item, dict) else None
        if not model_id or (prefix and not model_id.startswith(prefix)):
            continue
        aliases = [a for a in (item.get('aliases') or []) if isinstance(a, str) and a != model_id]
        out.append({'id': model_id, 'aliases': aliases})
    out.sort(key=lambda m: m['id'])
    return out
