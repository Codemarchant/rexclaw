# Copyright 2026 Codemarchant
"""Grok Imagine tools: change_background + create_image + edit_image +
create_video.

All are server-side function tools — they call xAI's image/video endpoints
with the configured Imagine models, persist the result as an imagine_images
row (bytes on disk under the data dir), and return a small payload the model
can speak about and the browser can act on:

  - `change_background` is voice-mode only. Its returned image is picked up by
    the browser's tool dispatcher post-result hook, which calls
    avatar_renderer.setBackground() to swap the live fullscreen scene. With
    `animated: true` it generates a short looping VIDEO backdrop instead of a
    still (kind 'background_video', rendered as a muted <video> layer).

  - `create_image` is offered in both voice and text mode. The browser side
    surfaces the link in the transcript.

  - `edit_image` is text-mode only. It targets /v1/images/edits and picks up
    the user's most-recent message's image attachments (up to 3) as source
    images. No upload surface exists in voice mode, so the tool is omitted
    there.

  - `create_video` mirrors create_image in both modes — the transcript
    surfaces an inline playable clip. Grok Imagine videos carry native audio.
    Optional params (at most one) reuse the Imagine library:
    `source_image` (image-to-video: the clip starts FROM that exact frame),
    `reference_images` (reference-to-video: the people/objects in those
    images appear in the clip without locking the first frame),
    `extend_video` (/videos/extensions: continue an existing clip;
    duration_seconds is the ADDED length), or `edit_video` (/videos/edits:
    modify an existing clip in place — xAI ignores duration/aspect there).

Video generation is asynchronous on xAI's side (poll-until-done) and priced
per second, so durations are capped conservatively here.
"""
import base64
import copy
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
        "overlays. Set animated=true to generate a living background — a "
        "short looping video (gentle motion: drifting clouds, rain on "
        "glass, flickering neon) — instead of a still image; animated "
        "takes ~30-60 seconds to render and costs a few cents, so mention "
        "it's on the way and don't spam it. The result is saved to this "
        "agent's Imagine library and becomes the user's preferred "
        "background until they pick a different one."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': 'One-sentence scene description for the background.',
            },
            'animated': {
                'type': 'boolean',
                'description': (
                    'true = looping video background (slower, costs more); '
                    'false/omitted = still image (fast, default).'
                ),
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
        "Optional `source_images` builds the new image FROM up to 3 "
        "Imagine-library entries (pass the image_url or imagine_image_id "
        "a previous tool call or user upload provided) — restyle, remix "
        "or combine them; with multiple sources, reference them in the "
        "prompt as <IMAGE_0>, <IMAGE_1>, <IMAGE_2> in the order passed. "
        "Does NOT change the avatar background — use change_background "
        "for that when the user wants a new scene behind the avatar."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': (
                    'Description of the image to generate — or, with '
                    'source_images, the edit/remix instruction.'
                ),
            },
            'source_images': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': (
                    'Optional, up to 3. image_url (/files/...) or '
                    'imagine_image_id values of library images to edit, '
                    'restyle or combine into the new image.'
                ),
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


_CREATE_VIDEO_TOOL = {
    'type': 'function',
    'name': 'create_video',
    'description': (
        "Generate a short video clip (with native sound) from a prompt and "
        "post it in the transcript for the user to play. Good for little "
        "gifts, jokes, and 'show me' moments. Optional ways to build on "
        "the Imagine library (pass the image_url/video_url or "
        "imagine_image_id that a previous tool call returned or a user "
        "upload provided — pick AT MOST ONE of these): "
        "`source_image` animates that exact image — the clip "
        "starts from it; `reference_images` makes the people/characters/"
        "objects from those images appear in the clip without copying the "
        "framing; `extend_video` continues an existing clip (the prompt "
        "describes what happens NEXT, duration_seconds is the length of "
        "the added part); `edit_video` modifies an existing clip while "
        "keeping the rest intact (the prompt describes the change, e.g. "
        "'add sunglasses'). Takes ~30-60 seconds to render and costs a "
        "few cents per second, so keep clips short and don't spam it. "
        "Does NOT change the avatar background — use "
        "change_background(animated=true) for that."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': (
                    'What to generate — or, with extend_video, what happens '
                    'next; with edit_video, the change to make.'
                ),
            },
            'duration_seconds': {
                'type': 'integer',
                'description': (
                    'Clip length in seconds, 1-15 (default 8). For '
                    'extend_video: length of the ADDED portion (default 5). '
                    'Ignored for edit_video.'
                ),
            },
            'source_image': {
                'type': 'string',
                'description': (
                    'Optional. image_url (/files/...) or imagine_image_id '
                    'of a library image to animate — the video starts from '
                    'this exact frame.'
                ),
            },
            'reference_images': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': (
                    'Optional, up to 3. image_url (/files/...) or '
                    'imagine_image_id values of library images whose '
                    'subjects should appear in the video.'
                ),
            },
            'extend_video': {
                'type': 'string',
                'description': (
                    'Optional. video_url (/files/...mp4) or imagine_image_id '
                    'of a library video to continue.'
                ),
            },
            'edit_video': {
                'type': 'string',
                'description': (
                    'Optional. video_url (/files/...mp4) or imagine_image_id '
                    'of a library video to modify.'
                ),
            },
        },
        'required': ['prompt'],
    },
}


# Voice mode gets background + image + video generation. Text mode swaps
# change_background (no live canvas) for edit_image (uses uploaded files).
# Session builders below clone create_video per-agent to append the avatar's
# outfit reference images to its description.
IMAGINE_TOOLS = [_CHANGE_BACKGROUND_TOOL, _CREATE_IMAGE_TOOL, _CREATE_VIDEO_TOOL]
IMAGINE_TEXT_TOOLS = [_CREATE_IMAGE_TOOL, _EDIT_IMAGE_TOOL, _CREATE_VIDEO_TOOL]
IMAGINE_TOOL_NAMES = (
    {t['name'] for t in IMAGINE_TOOLS}
    | {_EDIT_IMAGE_TOOL['name']}
)


def build_create_video_tool(*, voice_mode):
    """create_video for a session: the static schema, plus the take_selfie
    hint in voice mode (take_selfie is a browser tool, so text mode — which
    has no live canvas — never mentions it)."""
    if not voice_mode:
        return _CREATE_VIDEO_TOOL
    tool = copy.deepcopy(_CREATE_VIDEO_TOOL)
    tool['description'] += (
        " When the user wants a video featuring YOU, call take_selfie "
        "first to capture how you look right now and pass its image_url "
        "here (reference_images to star in a new scene, source_image to "
        "animate the shot itself)."
    )
    return tool


def build_voice_tools(con, agent):
    """Imagine function tools for a voice session."""
    return [
        _CHANGE_BACKGROUND_TOOL,
        _CREATE_IMAGE_TOOL,
        build_create_video_tool(voice_mode=True),
    ]


def build_text_tools(con, agent):
    """Imagine function tools for a text turn."""
    return [
        _CREATE_IMAGE_TOOL,
        _EDIT_IMAGE_TOOL,
        build_create_video_tool(voice_mode=False),
    ]

# Tools that only make sense with a live fullscreen canvas — gated out of
# text mode both in the tool list and at execution time.
VOICE_ONLY_TOOL_NAMES = {'change_background'}

# Video duration guardrails (xAI cap is 15s; priced per second).
_VIDEO_DEFAULT_SECONDS = 8
_VIDEO_MAX_SECONDS = 15
_EXTEND_DEFAULT_SECONDS = 5      # added-portion default for extend_video
_BACKGROUND_VIDEO_SECONDS = 10   # looping backdrop — fixed, not model-chosen
_MAX_REFERENCE_IMAGES = 3

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

    # Text mode has no fullscreen avatar canvas / audio surface — refuse
    # explicitly so a determined prompt-injection can't bypass the tool-list
    # gating.
    if tool_name in VOICE_ONLY_TOOL_NAMES and session['mode'] == 'text':
        return {'error': f'{tool_name} is not available in text mode.'}

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

    if tool_name == 'create_video' or (
            tool_name == 'change_background' and (arguments or {}).get('animated')):
        return _execute_video_tool(con, session, agent, config, xai_key, tool_name,
                                   prompt, arguments or {})

    # create_image from library sources → the images/edits endpoint with
    # data URIs (restyle/remix/combine). Distinct from edit_image, which
    # reads the text-mode message ATTACHMENTS via xAI file ids — this path
    # works in both modes and reaches everything in the Imagine library
    # (generated images, selfies, voice uploads).
    source_refs = (arguments or {}).get('source_images')
    if tool_name == 'create_image' and source_refs:
        if not isinstance(source_refs, list):
            source_refs = [source_refs]
        if len(source_refs) > _MAX_REFERENCE_IMAGES:
            return {'error': f'At most {_MAX_REFERENCE_IMAGES} source_images.'}
        source_uris = []
        for ref in source_refs:
            uri, err = _library_image_data_uri(con, ref)
            if err:
                return {'error': f'source_images: {err}'}
            source_uris.append(uri)
        try:
            body = xai_client.edit_image(
                xai_api_key=xai_key,
                edits_url=config['xai_images_edits_url'],
                model=config['imagine_model'],
                prompt=prompt,
                image_data_uris=source_uris,
                response_format='b64_json',
            )
        except UserError as e:
            return {'error': str(e)}
        except Exception as e:
            _logger.exception('Imagine library edit failed for session %s', session['id'])
            return {'error': f'Image edit failed: {e}'}
        result = _persist_imagine_result(con, session, agent, config, body, prompt, kind='edit')
        if 'error' not in result:
            result['source_image_count'] = len(source_uris)
        return result

    # change_background (still) / create_image branch.
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


def _web_path_to_file(web_path):
    """Map a DB-stored /files web path onto its file under FILES_DIR (all
    Imagine library media lives there). Only ever called with paths read
    back OUT of the database, never with raw model input, so the prefix is
    trusted; the relative part is still resolved and checked to stay inside
    the root."""
    prefix = '/files/'
    if not web_path.startswith(prefix):
        return None
    candidate = (FILES_DIR / web_path[len(prefix):]).resolve()
    if str(candidate).startswith(str(FILES_DIR.resolve())):
        return candidate
    return None


def _imagine_row_for_ref(con, ref):
    """Imagine-library row for a model-supplied reference: a numeric
    imagine_image_id or an exact image_path/video_url string."""
    if ref.isdigit():
        return con.execute(
            "SELECT * FROM imagine_images WHERE id = ?", (int(ref),),
        ).fetchone()
    return con.execute(
        "SELECT * FROM imagine_images WHERE image_path = ?", (ref,),
    ).fetchone()


def _read_media_data_uri(web_path, mimetype):
    """(data_uri, None) for a DB-validated web path, or (None, error)."""
    path = _web_path_to_file(web_path)
    if path is None:
        return None, f'The path "{web_path}" is not servable.'
    try:
        raw = path.read_bytes()
    except OSError:
        _logger.warning('Library media file missing: %s', path)
        return None, f'The file "{web_path}" is missing on disk.'
    return f"data:{mimetype};base64,{base64.b64encode(raw).decode('ascii')}", None


def _library_video_data_uri(con, ref):
    """Resolve a model-supplied VIDEO reference (imagine_image_id or a
    /files/...mp4 video_url) into a base64 data URI for the extensions/edits
    endpoints. Videos resolve only from the Imagine library. Same
    DB-rows-only rule as images: never an arbitrary-file read."""
    ref = str(ref or '').strip()
    if not ref:
        return None, 'Empty video reference.'
    row = _imagine_row_for_ref(con, ref)
    if not row:
        return None, f'No Imagine library entry matches "{ref}".'
    if not (row['mimetype'] or '').startswith('video/'):
        return None, f'Library entry "{ref}" is not a video.'
    return _read_media_data_uri(row['image_path'], row['mimetype'])


def _library_image_data_uri(con, ref):
    """Resolve a model-supplied image reference — an imagine_image_id or an
    Imagine-library image_url like '/files/imagine_abc.jpg' — into a base64
    data URI. Returns (data_uri, None) or (None, error_string). The value is
    model-controlled, so resolution goes strictly through DB rows — it must
    never become an arbitrary-file read."""
    ref = str(ref or '').strip()
    if not ref:
        return None, 'Empty image reference.'
    row = _imagine_row_for_ref(con, ref)
    if not row:
        return None, f'No Imagine library entry matches "{ref}".'
    if not (row['mimetype'] or '').startswith('image/'):
        return None, f'Library entry "{ref}" is not an image.'
    return _read_media_data_uri(row['image_path'], row['mimetype'] or 'image/jpeg')


def _execute_video_tool(con, session, agent, config, xai_key, tool_name, prompt, arguments):
    """Shared branch for video generation — change_background(animated=true)
    and create_video (plain / image-to-video / reference-to-video). Builds
    the request, waits out xAI's async render, downloads the mp4, persists
    it as an imagine_images row. Same {'error': str} contract as the image
    tools."""
    mode = 'generate'
    image_data_uri = None
    reference_data_uris = None
    video_data_uri = None
    aspect_ratio = None
    if tool_name == 'change_background':
        kind = 'background_video'
        duration = _BACKGROUND_VIDEO_SECONDS
        aspect_ratio = '16:9'
    else:
        kind = 'video'

        source_ref = arguments.get('source_image')
        reference_refs = arguments.get('reference_images')
        extend_ref = arguments.get('extend_video')
        edit_ref = arguments.get('edit_video')
        picked = [name for name, value in (
            ('source_image', source_ref),
            ('reference_images', reference_refs),
            ('extend_video', extend_ref),
            ('edit_video', edit_ref),
        ) if value]
        if len(picked) > 1:
            return {'error': (
                f'{", ".join(picked)} are mutually exclusive — pick at most one.'
            )}

        duration = arguments.get('duration_seconds')
        default = _EXTEND_DEFAULT_SECONDS if extend_ref else _VIDEO_DEFAULT_SECONDS
        try:
            duration = int(duration) if duration else default
        except (TypeError, ValueError):
            duration = default
        duration = max(1, min(_VIDEO_MAX_SECONDS, duration))

        if source_ref:
            image_data_uri, err = _library_image_data_uri(con, source_ref)
            if err:
                return {'error': f'source_image: {err}'}
        elif reference_refs:
            if not isinstance(reference_refs, list):
                reference_refs = [reference_refs]
            if len(reference_refs) > _MAX_REFERENCE_IMAGES:
                return {'error': f'At most {_MAX_REFERENCE_IMAGES} reference_images.'}
            reference_data_uris = []
            for ref in reference_refs:
                uri, err = _library_image_data_uri(con, ref)
                if err:
                    return {'error': f'reference_images: {err}'}
                reference_data_uris.append(uri)
        elif extend_ref:
            mode = 'extend'
            video_data_uri, err = _library_video_data_uri(con, extend_ref)
            if err:
                return {'error': f'extend_video: {err}'}
        elif edit_ref:
            # xAI ignores duration/aspect/resolution for edits — the output
            # inherits the input (capped at 720p, ~8.7s max input).
            mode = 'edit'
            duration = None
            video_data_uri, err = _library_video_data_uri(con, edit_ref)
            if err:
                return {'error': f'edit_video: {err}'}

    try:
        video = xai_client.generate_video(
            xai_api_key=xai_key,
            videos_url=config['xai_videos_url'],
            model=config['imagine_video_model'],
            prompt=prompt,
            mode=mode,
            image_data_uri=image_data_uri,
            reference_image_data_uris=reference_data_uris,
            video_data_uri=video_data_uri,
            duration_seconds=duration,
            aspect_ratio=aspect_ratio,
        )
        raw_bytes = xai_client.download_video_bytes(video['url'], xai_api_key=xai_key)
    except UserError as e:
        return {'error': str(e)}
    except Exception as e:
        _logger.exception('Imagine video failed for session %s', session['id'])
        return {'error': f'Video generation failed: {e}'}

    fname = f'imagine_{uuid.uuid4().hex}.mp4'
    (FILES_DIR / fname).write_bytes(raw_bytes)
    video_path = f'/files/{fname}'
    actual_model = video.get('model') or config['imagine_video_model']
    created_at = utcnow()
    cur = con.execute(
        """INSERT INTO imagine_images
               (name, agent_id, session_id, kind, prompt, image_path, mimetype, xai_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (_truncate_name(prompt), agent['id'], session['id'], kind, prompt,
         video_path, 'video/mp4', actual_model, created_at),
    )
    # The status body hasn't been observed to carry a usage block, but accrue
    # it if xAI ever adds one — same informational-only tracking as images.
    raw_body = video.get('raw') or {}
    store.accrue_usd_ticks(con, store.extract_cost_ticks(raw_body.get('usage') or {}))
    return {
        'imagine_image_id': cur.lastrowid,
        'kind': kind,
        'video_url': video_path,
        'prompt': prompt,
        'name': _truncate_name(prompt),
        'duration_seconds': video.get('duration') or duration,
        'created_at': created_at,
    }


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
    created_at = utcnow()
    cur = con.execute(
        """INSERT INTO imagine_images
               (name, agent_id, session_id, kind, prompt, image_path, mimetype, xai_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (_truncate_name(prompt), agent['id'], session['id'], kind, prompt,
         image_path, mimetype, actual_model, created_at),
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(body.get('usage') or {}))
    return {
        'imagine_image_id': cur.lastrowid,
        'kind': kind,
        'image_url': image_path,
        'prompt': prompt,
        'name': _truncate_name(prompt),
        'created_at': created_at,
    }
