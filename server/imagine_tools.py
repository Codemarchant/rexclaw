# Copyright 2026 Codemarchant
"""Grok Imagine tools: change_background + create_image + edit_image.

All three are server-side function tools — they call xAI's image endpoints
with the configured Imagine model, persist the result as an imagine_images row
(bytes on disk under the data dir), and return a small payload the model can
speak about and the browser can act on:

  - `change_background` is voice-mode only. Its returned image is picked up by
    the browser's tool dispatcher post-result hook, which calls
    avatar_renderer.setBackground() to swap the live fullscreen scene.

  - `create_image` is offered in both voice and text mode. The browser side
    surfaces the link in the transcript.

  - `edit_image` is text-mode only. It targets /v1/images/edits and picks up
    the user's most-recent message's image attachments (up to 3) as source
    images. No upload surface exists in voice mode, so the tool is omitted
    there.
"""
import base64
import logging
import uuid

from . import xai_client, store
from .db import FILES_DIR, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)


_CHANGE_BACKGROUND_TOOL = {
    'type': 'function',
    'name': 'change_background',
    'description': (
        "Generate a new scene background and apply it to the user's "
        "fullscreen view immediately. Good prompts describe a setting in "
        "one short sentence (e.g. 'a minimalist Tokyo office at dusk with "
        "soft city bokeh'). Avoid people, busy foregrounds, and text "
        "overlays. The image is saved to this agent's Imagine library and "
        "becomes the user's preferred background until they pick a "
        "different one."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': 'One-sentence scene description for the background.',
            },
        },
        'required': ['prompt'],
    },
}

_CREATE_IMAGE_TOOL = {
    'type': 'function',
    'name': 'create_image',
    'description': (
        "Generate an image from a prompt and post a link to it in the "
        "transcript. The image is saved to this agent's Imagine library; "
        "the user can click the transcript link to open it full-size. "
        "Does NOT change the avatar background — use change_background "
        "for that when the user wants a new scene behind the avatar."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': 'Description of the image to generate.',
            },
        },
        'required': ['prompt'],
    },
}

_EDIT_IMAGE_TOOL = {
    'type': 'function',
    'name': 'edit_image',
    'description': (
        "Edit the image(s) the user just attached to their message. Use "
        "when the user asks to modify, restyle, remix, or combine images "
        "they uploaded — e.g. 'make this black and white', 'put this dog "
        "into a forest scene', 'combine these two photos'. The server "
        "automatically picks up to 3 images from the user's most recent "
        "message in upload order. If the user uploaded more than one image, "
        "reference them in your prompt as <IMAGE_0>, <IMAGE_1>, <IMAGE_2> "
        "(xAI's convention) so the model knows which is which. Result is "
        "saved to the agent's Imagine library and surfaced as a thumbnail "
        "in the transcript."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': (
                    'Editing instruction. For multi-image edits, refer to '
                    'inputs as <IMAGE_0>, <IMAGE_1>, etc.'
                ),
            },
        },
        'required': ['prompt'],
    },
}


# Voice mode gets background + image generation. Text mode swaps
# change_background (no canvas) for edit_image (uses uploaded files).
IMAGINE_TOOLS = [_CHANGE_BACKGROUND_TOOL, _CREATE_IMAGE_TOOL]
IMAGINE_TEXT_TOOLS = [_CREATE_IMAGE_TOOL, _EDIT_IMAGE_TOOL]
IMAGINE_TOOL_NAMES = (
    {t['name'] for t in IMAGINE_TOOLS}
    | {_EDIT_IMAGE_TOOL['name']}
)

_EXT_BY_MIME = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
}


def _truncate_name(prompt, limit=60):
    """Short label used as the record name + transcript link text."""
    s = (prompt or '').strip().replace('\n', ' ')
    if len(s) <= limit:
        return s or 'Imagine result'
    return s[:limit].rstrip() + '…'


def _collect_recent_user_images(con, session, max_count=3):
    """Return up to `max_count` xai_file_ids from the most-recent user message
    in the session whose attachments are images. Order matches attachment
    upload order so the model's <IMAGE_0> / <IMAGE_1> references line up."""
    row = con.execute(
        "SELECT id FROM messages WHERE session_id = ? AND role = 'user' "
        "ORDER BY sequence DESC, id DESC LIMIT 1",
        (session['id'],),
    ).fetchone()
    if not row:
        return []
    atts = con.execute(
        "SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id",
        (row['id'],),
    ).fetchall()
    images = [
        a['xai_file_id']
        for a in atts
        if a['xai_file_id'] and (a['mimetype'] or '').startswith('image/')
    ]
    return images[:max_count]


def execute_imagine_tool(con, session, tool_name, arguments):
    """Call Grok Imagine, persist the result, return a payload for the model
    and the browser. Errors are returned as {'error': str} so the realtime
    model receives a structured failure instead of an exception."""
    if tool_name not in IMAGINE_TOOL_NAMES:
        return {'error': f'Unknown imagine tool: {tool_name}'}

    agent = store.get_agent(con, session['agent_id'])
    if not agent['enable_grok_imagine_tools']:
        return {'error': 'Grok Imagine tools are disabled on this agent.'}

    # Text mode has no fullscreen avatar canvas — refuse explicitly so a
    # determined prompt-injection can't bypass the tool-list gating.
    if tool_name == 'change_background' and session['mode'] == 'text':
        return {'error': 'change_background is not available in text mode.'}

    prompt = (arguments or {}).get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        return {'error': 'prompt is required.'}
    prompt = prompt.strip()

    config = con.execute("SELECT * FROM config WHERE id = 1").fetchone()
    xai_key = config['xai_api_key']
    if not xai_key:
        return {'error': 'xAI API key is not configured.'}

    if tool_name == 'edit_image':
        if session['mode'] != 'text':
            return {'error': 'edit_image is only available in text mode.'}
        file_ids = _collect_recent_user_images(con, session, max_count=3)
        if not file_ids:
            return {'error': (
                'No images found on latest message. Tell the user to '
                're-attach the image(s) — image edits only work on files '
                'uploaded in the current turn.'
            )}
        try:
            body = xai_client.edit_image(
                xai_api_key=xai_key,
                edits_url=config['xai_images_edits_url'],
                model=config['imagine_model'],
                prompt=prompt,
                image_file_ids=file_ids,
                response_format='b64_json',
            )
        except UserError as e:
            return {'error': str(e)}
        except Exception as e:
            _logger.exception('Imagine edit failed for session %s', session['id'])
            return {'error': f'Image edit failed: {e}'}
        result = _persist_imagine_result(con, session, agent, config, body, prompt, kind='edit')
        if 'error' not in result:
            result['source_image_count'] = len(file_ids)
        return result

    # change_background / create_image branch.
    aspect_ratio = '16:9' if tool_name == 'change_background' else None
    try:
        body = xai_client.generate_image(
            xai_api_key=xai_key,
            images_url=config['xai_images_url'],
            model=config['imagine_model'],
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            response_format='b64_json',
        )
    except UserError as e:
        return {'error': str(e)}
    except Exception as e:
        _logger.exception('Imagine generation failed for session %s', session['id'])
        return {'error': f'Image generation failed: {e}'}
    kind = 'background' if tool_name == 'change_background' else 'image'
    return _persist_imagine_result(con, session, agent, config, body, prompt, kind=kind)


def _persist_imagine_result(con, session, agent, config, body, prompt, *, kind):
    """Decode the b64 image in `body`, write the bytes under the data dir,
    insert an imagine_images row, accrue the xAI-reported cost, and return the
    small payload shape the model + browser both consume."""
    first = body['data'][0]
    b64 = first.get('b64_json')
    if not b64:
        return {'error': 'Image generation returned no inline image data.'}
    try:
        raw_bytes = base64.b64decode(b64)
    except Exception as e:
        _logger.exception('Imagine response b64 decode failed')
        return {'error': f'Could not decode generated image: {e}'}
    mimetype = first.get('mime_type') or 'image/jpeg'
    ext = _EXT_BY_MIME.get(mimetype, '.jpg')
    fname = f'imagine_{uuid.uuid4().hex}{ext}'
    (FILES_DIR / fname).write_bytes(raw_bytes)
    image_path = f'/files/{fname}'
    actual_model = body.get('model') or config['imagine_model']
    cur = con.execute(
        """INSERT INTO imagine_images
               (name, agent_id, session_id, kind, prompt, image_path, mimetype, xai_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (_truncate_name(prompt), agent['id'], session['id'], kind, prompt,
         image_path, mimetype, actual_model, utcnow()),
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(body.get('usage') or {}))
    return {
        'imagine_image_id': cur.lastrowid,
        'kind': kind,
        'image_url': image_path,
        'prompt': prompt,
        'name': _truncate_name(prompt),
    }
