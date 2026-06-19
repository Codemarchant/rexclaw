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
import time
from datetime import datetime, timezone

import requests

from .errors import UserError

_logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30
RETRY_BACKOFF = (0.5, 1.0, 2.0)  # seconds

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
        raise UserError("Image generation returned an unexpected response — see server log.")
    return body


def edit_image(*, xai_api_key, edits_url, model, prompt, image_file_ids,
               aspect_ratio=None, response_format='b64_json', user=None):
    """POST /v1/images/edits with one or more source images.

    `image_file_ids` is a list of xAI file_ids (1-3). xAI's endpoint accepts
    either `image: {file_id}` (single) or `images: [{file_id}, ...]` (multi);
    the two are mutually exclusive in the request body, so we pick the form
    based on how many ids we have.
    """
    if not xai_api_key:
        raise UserError(NO_KEY_MSG)
    if not prompt:
        raise UserError("Edit prompt is required.")
    if not image_file_ids:
        raise UserError("edit_image requires at least one source image.")
    if len(image_file_ids) > 3:
        image_file_ids = image_file_ids[:3]  # xAI cap
    payload = {
        'model': model,
        'prompt': prompt,
        'response_format': response_format,
    }
    if len(image_file_ids) == 1:
        payload['image'] = {'file_id': image_file_ids[0]}
    else:
        payload['images'] = [{'file_id': fid} for fid in image_file_ids]
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
        raise UserError("Image edit returned an unexpected response — see server log.")
    return body


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
                         audio_sample_rate=24000):
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
            'turn_detection': {
                'type': 'server_vad',
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
      * `reasoning.effort` accepts only `low | medium | high`. Anything else
        (including 'none') omits the reasoning block entirely.
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
    if reasoning_effort in ('low', 'medium', 'high'):
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
        timeout=120,
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
