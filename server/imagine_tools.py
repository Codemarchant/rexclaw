# Copyright 2026 Codemarchant
"""Grok Imagine tools: change_background + create_image + create_video.

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
    just surfaces the thumbnail in the transcript. `source_images` targets
    /v1/images/edits with Imagine-library entries — generated images,
    selfies, AND user uploads (both surfaces ingest image uploads into the
    library at upload time), so creating, editing and remixing is one
    uniform tool across both modes.

  - `create_video` mirrors create_image in both modes — the transcript
    surfaces an inline playable clip. Grok Imagine videos carry native audio.
    Optional inputs select the mode, one at a time, and each mode accepts a
    different subset of aspect_ratio / resolution / duration (see the matrix
    in _execute_video_tool): `source_image` (Image-to-Video: the clip starts
    FROM that exact frame), `reference_images` and/or `voice_ids`
    (Reference-to-Video: those subjects and voices appear without locking the
    first frame — one mode, so they combine), `extend_video`
    (/videos/extensions: continue an existing clip; duration_seconds is the
    ADDED length), or `edit_video` (/videos/edits: modify in place, prompt
    only). Plain Generation takes all three knobs.

Video generation is asynchronous on xAI's side (poll-until-done) and priced
per second, so durations are capped conservatively here.
"""
import base64
import copy
import logging
import uuid
from datetime import datetime, timedelta, timezone
from textwrap import dedent

from . import xai_client, store
from .db import FILES_DIR, get_config, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)

# Video output shape — declared above the tool schemas because they enumerate
# these. xAI defaults `resolution` to 480p when omitted, which looks soft on a
# full-width transcript clip or a scene backdrop, so we always send one.
# Whether a given model/mode accepts the requested value is xAI's call: it
# answers with what is actually available, which beats guessing here.
_VIDEO_RESOLUTIONS = ('480p', '720p', '1080p')
_VIDEO_DEFAULT_RESOLUTION = '720p'
_VIDEO_ASPECT_RATIOS = ('1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3')


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
        "it's on the way and don't spam it. Call this ONCE per scene change "
        "- never several calls at the same time: each one renders and bills, "
        "and only the last to finish stays on screen. Pick the single best "
        "description. The "
        "result is saved to this agent's Imagine library and becomes the "
        "user's preferred background until they pick a different one."
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
                    'Set true ONLY for a looping video background (slower, '
                    'costs more per second). For a still image — the default '
                    '— omit this parameter entirely rather than passing a '
                    'value.'
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
        "Generate an image from a prompt. The image is saved to this agent's "
        "Imagine library and appears automatically in the transcript as "
        "a clickable thumbnail — NEVER say or write the URL, file name "
        "or link; just react to the result naturally in your own words. "
        "Optional `source_images` builds the new image FROM one or more "
        "Imagine-library entries (pass the image_url or imagine_image_id "
        "a previous tool call or user upload provided) — restyle, remix "
        "or combine them; with multiple sources, reference them in the "
        "prompt as <IMAGE_0>, <IMAGE_1>, <IMAGE_2> in the order passed. "
        "This is also how you EDIT images the user uploaded: their "
        "attachments are saved to the library and the imagine_image_id "
        "refs appear in the conversation next to the upload. "
        "When a source is an avatar selfie, match its art style in the "
        "prompt — stylized anime/cel-shaded 3D, NOT photorealistic — "
        "unless the user asks for a different style. "
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
                    'Optional. image_url (/files/...) or '
                    'imagine_image_id values of library images to edit, '
                    'restyle or combine into the new image. Omit this '
                    'parameter entirely when generating from the prompt '
                    'alone — never pass a placeholder value.'
                ),
            },
        },
        'required': ['prompt'],
    },
}

_CREATE_VIDEO_TOOL = {
    'type': 'function',
    'name': 'create_video',
    'description': dedent("""
        Generate a short video clip (with native sound) from a prompt.

        The finished clip appears automatically in the transcript as a playable
        thumbnail — NEVER say or write the URL, file name or link; just react
        to the result naturally in your own words.

        Rendering takes a while, so never call this silently: say what you
        are creating as you start, keep chatting while it renders, and react
        when it lands. Only create videos at the users explicit request.

        MODES — the optional inputs select exactly one mode, and each mode
        accepts only its own extra parameters:

          Generation          nothing extra. Invented from the prompt alone.
                              Takes aspect_ratio, resolution, duration_seconds.

          Image-to-Video      source_image. The clip STARTS from that exact
                              frame.
                              Takes resolution, duration_seconds.

          __REFERENCE_MODE__

          Video Editing       edit_video. Changes the clip in place, keeping
                              the rest intact; the prompt describes the change
                              ("add sunglasses").
                              Takes NO other parameters.

          Video Extension     extend_video. Continues the clip; the prompt
                              describes what happens NEXT.
                              Takes duration_seconds (the ADDED length) only.

        Library inputs take the image_url / video_url or imagine_image_id that
        a previous tool call returned or a user upload provided.

        OMIT every parameter you are not using — leave it out of the arguments
        entirely. Never pass a placeholder like "false", "none" or "" to say
        you don't want a mode; that reads as selecting it.

        When a source or reference image is an avatar selfie, match its art
        style in the prompt — stylized anime/cel-shaded 3D, NOT photorealistic
        — unless the user asks for a different style.
    """).strip(),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': dedent("""
                    What to generate.
                    With extend_video: what happens NEXT in the continued clip.
                    With edit_video: the change to make, e.g. "add sunglasses".
                    When reference_images or voice_ids are set, address them
                    positionally as <IMAGE_0>, <IMAGE_1>, <AUDIO_0>, ... so you
                    control who does and says what — e.g. "<IMAGE_0> hands the
                    cup to <IMAGE_1>".
                """).strip(),
            },
            'duration_seconds': {
                'type': 'integer',
                'description': dedent("""
                    Clip length in seconds, 1-15 (default 8).
                    Accepted by Generation, Image-to-Video, Reference-to-Video
                    and Video Extension — for Extension it is the length of the
                    ADDED part (default 5), not the total.
                    Not accepted by Video Editing.
                """).strip(),
            },
            'source_image': {
                'type': 'string',
                'description': dedent("""
                    image_url (/files/...) or imagine_image_id of a library
                    image to animate: the clip starts from this exact frame.
                    Use ALONE — not with reference_images, voice_ids,
                    extend_video or edit_video.
                """).strip(),
            },
            'reference_images': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': dedent("""
                    image_url (/files/...) or imagine_image_id values whose
                    people, characters or objects should appear in the clip,
                    without copying their framing.
                    Address them in the prompt as <IMAGE_0>, <IMAGE_1>, ... in
                    the order passed.
                    May be combined with voice_ids — but not with source_image,
                    extend_video or edit_video.
                """).strip(),
            },
            'voice_ids': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': dedent("""
                    xAI voice ids that speak in the clip. Your own voice id is
                    given in your system prompt — pass it for a clip spoken in
                    your voice.
                    Address them in the prompt as <AUDIO_0>, <AUDIO_1>, ... in
                    the order passed.
                    May be combined with reference_images — but not with
                    source_image, extend_video or edit_video.
                """).strip(),
            },
            'aspect_ratio': {
                'type': 'string',
                'enum': list(_VIDEO_ASPECT_RATIOS),
                'description': dedent("""
                    Shape of the clip (default 16:9). Use 9:16 for phone-style
                    vertical, 1:1 for square.
                    Accepted by Generation and Reference-to-Video only.
                    Not accepted by Image-to-Video (the clip takes the source
                    image's own shape), Video Editing or Video Extension.
                """).strip(),
            },
            'resolution': {
                'type': 'string',
                'enum': list(_VIDEO_RESOLUTIONS),
                'description': dedent("""
                    Output quality (default 720p); 480p renders fastest.
                    Accepted by Generation, Image-to-Video and
                    Reference-to-Video.
                    Not accepted by Video Editing or Video Extension.
                """).strip(),
            },
            'extend_video': {
                'type': 'string',
                'description': dedent("""
                    video_url (/files/...mp4) or imagine_image_id of a library
                    video to continue — generated clips and user uploads alike
                    (uploads are ingested into the library; a file_… id never
                    works here).
                    Use ALONE — not with edit_video, source_image,
                    reference_images or voice_ids.
                """).strip(),
            },
            'edit_video': {
                'type': 'string',
                'description': dedent("""
                    video_url (/files/...mp4) or imagine_image_id of a library
                    video to modify — generated clips and user uploads alike
                    (uploads are ingested into the library; a file_… id never
                    works here).
                    Use ALONE — not with extend_video, source_image,
                    reference_images or voice_ids.
                """).strip(),
            },
        },
        'required': ['prompt'],
    },
}


# Voice mode gets background + image + video generation. Text mode drops
# change_background (no live canvas). Session builders below clone
# create_video per-surface (voice appends the take_selfie hint). Editing
# user uploads needs no dedicated tool: both surfaces ingest image uploads
# into the Imagine library at upload time, so create_image's source_images
# reaches them like any other library entry.
IMAGINE_TOOLS = [_CHANGE_BACKGROUND_TOOL, _CREATE_IMAGE_TOOL, _CREATE_VIDEO_TOOL]
# Every tool name — used by the voice tool_call route's name-based dispatch
# and by the text loop's native-tool routing.
IMAGINE_TOOL_NAMES = {t['name'] for t in IMAGINE_TOOLS}


# Video-model capability gating. Video models KNOWN to lack Reference-to-Video
# (reference_images + voice_ids) get those parameters removed from the
# create_video schema — and refused at execution — so the companion can't call
# what the configured model can't do. Anything not listed (aliases, newer
# releases) gets the full schema: the API's own error, which names the model,
# is the signal there, so a new xAI release is never blocked by this table.
_VIDEO_MODELS_WITHOUT_REFERENCE = {'grok-imagine-video'}

# The mode-table entry for Reference-to-Video, spliced into the description
# only when the configured model supports it (the other mentions of the two
# parameters are "not with…" exclusions — harmless once the params are gone).
_REFERENCE_MODE_BLOCK = (
    "Reference-to-Video  reference_images and/or voice_ids. Those\n"
    "                      subjects and voices appear WITHOUT locking the\n"
    "                      opening frame — these two are one mode, so they\n"
    "                      are the only pair that may be used together.\n"
    "                      Takes aspect_ratio, resolution, duration_seconds."
)


def video_reference_supported(config):
    """Whether the configured video model takes reference_images / voice_ids."""
    model = (config['imagine_video_model'] or '').strip()
    return model not in _VIDEO_MODELS_WITHOUT_REFERENCE


def build_create_video_tool(*, voice_mode, reference=True):
    """create_video for a session: the static schema, plus the take_selfie
    hint in voice mode (take_selfie is a browser tool, so text mode — which
    has no live canvas — never mentions it), minus the Reference-to-Video
    parameters when the configured video model lacks them."""
    tool = copy.deepcopy(_CREATE_VIDEO_TOOL)
    if reference:
        tool['description'] = tool['description'].replace('__REFERENCE_MODE__', _REFERENCE_MODE_BLOCK)
    else:
        tool['description'] = tool['description'].replace('  __REFERENCE_MODE__\n\n', '')
        del tool['parameters']['properties']['reference_images']
        del tool['parameters']['properties']['voice_ids']
    if voice_mode:
        tool['description'] += (
            " When the user wants a video featuring YOU, call take_selfie "
            "first to capture how you look right now and pass its image_url "
            "here ("
            + ("reference_images to star in a new scene, source_image to "
               "animate the shot itself)." if reference else
               "source_image — the clip animates the shot itself).")
        )
    return tool


def build_voice_tools(con, agent):
    """Imagine function tools for a voice session."""
    return [
        _CHANGE_BACKGROUND_TOOL,
        _CREATE_IMAGE_TOOL,
        build_create_video_tool(voice_mode=True,
                                reference=video_reference_supported(get_config(con))),
    ]


def build_text_tools(con, agent):
    """Imagine function tools for a text turn."""
    return [
        _CREATE_IMAGE_TOOL,
        build_create_video_tool(voice_mode=False,
                                reference=video_reference_supported(get_config(con))),
    ]

# Tools that only make sense with a live fullscreen canvas — gated out of
# text mode both in the tool list and at execution time.
VOICE_ONLY_TOOL_NAMES = {'change_background'}

# Video duration guardrails (xAI cap is 15s; priced per second).
_VIDEO_DEFAULT_SECONDS = 8
_VIDEO_MAX_SECONDS = 15
_EXTEND_DEFAULT_SECONDS = 5      # added-portion default for extend_video
_BACKGROUND_VIDEO_SECONDS = 10   # looping backdrop — fixed, not model-chosen

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


def execute_imagine_tool(con, session, tool_name, arguments):
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

    if tool_name == 'create_video' or (
            tool_name == 'change_background'
            and _truthy((arguments or {}).get('animated'))):
        return _execute_video_tool(con, session, agent, config, xai_key, tool_name,
                                   prompt, arguments or {})

    # create_image from library sources → the images/edits endpoint with
    # data URIs (restyle/remix/combine). Works in both modes and reaches
    # everything in the Imagine library (generated images, selfies, uploads).
    source_refs = _library_ref_list((arguments or {}).get('source_images'))
    if tool_name == 'create_image' and source_refs:
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
    imagine_image_id — bare or labelled like "imagine_image_id:139", the way
    tool results print it — or an exact image_path/video_url string."""
    ref = ref.strip()
    if ref.lower().startswith('imagine_image_id'):
        ref = ref[len('imagine_image_id'):].lstrip(' :=')
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


def ensure_xai_file(con, row):
    """Usable /v1/files id for a library row — the cached one while it is
    still valid (5-minute safety margin), else a fresh upload of the locally
    stored bytes, refreshing the cache. This is what makes library refs
    durable: the original upload's file id expires with xAI, the local copy
    doesn't. Raises UserError when the row has no usable bytes."""
    keys = row.keys()
    file_id = row['xai_file_id'] if 'xai_file_id' in keys else None
    expires = row['xai_file_expires_at'] if 'xai_file_expires_at' in keys else None
    if file_id:
        margin = (datetime.now(timezone.utc).replace(tzinfo=None)
                  + timedelta(minutes=5)).isoformat(timespec='seconds')
        if not expires or expires > margin:
            return file_id
    path = _web_path_to_file(row['image_path'])
    if path is None:
        raise UserError(f'Library entry {row["id"]} has no servable file.')
    try:
        data = path.read_bytes()
    except OSError:
        raise UserError(f'Library entry {row["id"]} file is missing on disk.')
    config = get_config(con)
    xai_key = config['xai_api_key']
    if not xai_key:
        raise UserError("xAI API key is not configured.")
    result = xai_client.upload_file(
        xai_api_key=xai_key,
        files_url=config['xai_files_url'],
        filename=row['name'] or f'file-{row["id"]}',
        content_bytes=data,
        mimetype=row['mimetype'] or 'application/octet-stream',
        expires_after_seconds=config['file_default_expiry_seconds'] or 0,
    )
    con.execute(
        "UPDATE imagine_images SET xai_file_id = ?, xai_file_expires_at = ? WHERE id = ?",
        (result['file_id'], result.get('expires_at'), row['id']),
    )
    return result['file_id']


# Models routinely fill in every property a schema advertises rather than
# omitting the ones they don't want, so an unused mode arrives as the STRING
# "false" (or "", "null", "none") — all truthy in Python. Left as-is that reads
# as a third mode being selected and the call is rejected as ambiguous, which
# the model cannot see how to fix: observed live as an identical retry loop.
_FALSEY_STRINGS = {'', 'false', 'none', 'null', 'n/a', 'undefined', '0', 'no', 'off'}
# For a library reference a literal "true" is as meaningless as "false".
_ABSENT_REF_VALUES = _FALSEY_STRINGS | {'true', 'yes'}


def _truthy(value):
    """Read a boolean property that may arrive as a string.

    A model answering "false" to a boolean must not read as True. For
    `animated` that would silently swap a still background for a video —
    billed per second — so this is a cost bug, not just a wrong flag.
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() not in _FALSEY_STRINGS


def _library_ref(value):
    """Normalise one optional library reference to its value or None."""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    return None if text.lower() in _ABSENT_REF_VALUES else text


def _library_ref_list(value):
    """Same for the list-valued params, dropping placeholder entries."""
    if value is None or isinstance(value, bool):
        return None
    if not isinstance(value, list):
        value = [value]
    cleaned = [ref for ref in (_library_ref(v) for v in value) if ref]
    return cleaned or None


def _execute_video_tool(con, session, agent, config, xai_key, tool_name, prompt, arguments):
    """Shared branch for video generation — change_background(animated=true)
    and create_video (plain / image-to-video / reference-to-video). Builds
    the request, waits out xAI's async render, downloads the mp4, persists
    it as an imagine_images row. Same {'error': str} contract as the image
    tools."""
    mode = 'generate'
    image_data_uri = None
    reference_data_uris = None
    reference_voice_ids = None
    video_data_uri = None
    aspect_ratio = None
    resolution = _VIDEO_DEFAULT_RESOLUTION
    if tool_name == 'change_background':
        kind = 'background_video'
        duration = _BACKGROUND_VIDEO_SECONDS
        aspect_ratio = '16:9'
    else:
        kind = 'video'

        aspect_ratio = arguments.get('aspect_ratio') or None
        resolution = arguments.get('resolution') or resolution

        reference_voice_ids = _library_ref_list(arguments.get('voice_ids'))

        source_ref = _library_ref(arguments.get('source_image'))
        reference_refs = _library_ref_list(arguments.get('reference_images'))
        # Schema-pruned for these models (see build_create_video_tool);
        # refuse here too so a stale or injected call can't slip through.
        if (reference_refs or reference_voice_ids) and not video_reference_supported(config):
            return {'error': (
                f'reference_images / voice_ids are not supported by the configured '
                f'video model ({config["imagine_video_model"]}).'
            )}
        extend_ref = _library_ref(arguments.get('extend_video'))
        edit_ref = _library_ref(arguments.get('edit_video'))
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
        # Voices ride only with Reference-to-Video — xAI rejects them for
        # the image/video-input modes, so say what to change instead of
        # relaying its 400.
        if reference_voice_ids and (source_ref or extend_ref or edit_ref):
            return {'error': (
                'voice_ids only works in Reference-to-Video mode — pass the image '
                'as reference_images instead of source_image (and drop '
                'extend_video / edit_video).'
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
            mode = 'edit'
            video_data_uri, err = _library_video_data_uri(con, edit_ref)
            if err:
                return {'error': f'edit_video: {err}'}

        # Each xAI video mode accepts a different subset of the output knobs;
        # sending one the mode doesn't take is an error, so drop them here
        # rather than relying on the model to omit them:
        #   Generation / Reference-to-Video  aspect_ratio, resolution, duration
        #   Image-to-Video                   resolution, duration
        #   Video Extension                  duration (of the added part)
        #   Video Editing                    none — prompt only
        if mode == 'edit':
            duration = aspect_ratio = resolution = None
        elif mode == 'extend':
            aspect_ratio = resolution = None
        elif image_data_uri:
            aspect_ratio = None

    try:
        video = xai_client.generate_video(
            xai_api_key=xai_key,
            videos_url=config['xai_videos_url'],
            model=config['imagine_video_model'],
            prompt=prompt,
            mode=mode,
            image_data_uri=image_data_uri,
            reference_image_data_uris=reference_data_uris,
            reference_voice_ids=reference_voice_ids,
            video_data_uri=video_data_uri,
            duration_seconds=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
        )
        raw_bytes = xai_client.download_video_bytes(video['url'], xai_api_key=xai_key)
    except UserError as e:
        return {'error': f'{e} (video model: {config["imagine_video_model"]})'}
    except Exception as e:
        _logger.exception('Imagine video failed for session %s', session['id'])
        return {'error': f'Video generation failed (video model: {config["imagine_video_model"]}): {e}'}

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
        'note': (
            'The animated background is already applied to the scene — do '
            'not say or write the URL or file name, just react to it.'
            if kind == 'background_video' else
            'The clip is already visible in the transcript — do not say '
            'or write the URL or file name, just react to it.'
        ),
    }


def _persist_imagine_result(con, session, agent, config, body, prompt, *, kind):
    """Decode the b64 image in `body`, write the bytes under the data dir,
    insert an imagine_images row, accrue the xAI-reported cost, and return the
    small payload shape the model + browser both consume."""
    first = body['data'][0]
    b64 = first.get('b64_json')
    if not b64:
        # Name the fields that DID arrive — when xAI declines a generation
        # (e.g. moderation) the refusal often rides in an unexpected field,
        # and the keys tell the model (and us) where to look.
        return {'error': 'Image generation returned no inline image data '
                         f'(response fields: {sorted(first)}).'}
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
        'note': (
            'The new background is already applied to the scene — do not '
            'say or write the URL or file name, just react to it.'
            if kind == 'background' else
            'The image is already visible in the transcript — do not say '
            'or write the URL or file name, just react to it.'
        ),
    }
