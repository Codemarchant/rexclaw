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
        "fullscreen view immediately. Generates a still image by default. "
        "Set animated=true ONLY when the user explicitly asks for a moving, "
        "animated or video background - it takes 30-60 seconds to render "
        "and interrupts the conversation, so never choose it on your own. "
        "Good prompts describe a setting in one short sentence (e.g. 'a "
        "minimalist Tokyo office at dusk with soft city bokeh'). Avoid "
        "people, busy foregrounds, and text overlays. Call this ONCE per "
        "scene change - never several calls at the same time: each one "
        "renders and bills, and only the last to finish stays on screen. "
        "Pick the single best description. The result is saved to this "
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
                    'Only when the user asked for a moving background: a '
                    'short looping video with gentle motion (drifting clouds, '
                    'rain on glass, flickering neon). Slower and costs more. '
                    'For a still image - the default - omit this parameter '
                    'entirely rather than passing a value.'
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
        "Generate an image from a prompt, or edit/remix images from the "
        "Imagine library. The result is saved to the library and appears "
        "in the transcript as a clickable thumbnail — NEVER say or write "
        "the URL, file name or link; just react to it in your own words. "
        "To put YOURSELF in the picture set include_self=true - that alone "
        "answers 'send me a picture of you', no other call is needed. "
        "Other companions go in via include_companion, the user via "
        "include_user, library images (earlier results, user uploads - "
        "the imagine_image_id refs shown next to them in the conversation) "
        "via source_images. Does NOT change the avatar background — use "
        "change_background for that."
    ),
    'parameters': {
        'type': 'object',
        'properties': {
            'prompt': {
                'type': 'string',
                'description': (
                    'What to generate — or, with references attached, the '
                    'edit/remix instruction. Every reference image is '
                    'numbered in this order: you (include_self), then '
                    'companions (include_companion), then the user '
                    '(include_user), then source_images. Address them as '
                    '<IMAGE_0>, <IMAGE_1>, ... with the name alongside — '
                    'e.g. "<IMAGE_0> Eve sitting on a pier at sunset", '
                    'never just "me on a pier".'
                ),
            },
            'source_images': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': (
                    'image_url (/files/...) or imagine_image_id values of '
                    'library images to edit, restyle or combine. Omit '
                    'entirely when generating from the prompt alone — '
                    'never pass a placeholder value.'
                ),
            },
            'include_self': {
                'type': 'boolean',
                'description': (
                    'true = you are in the picture. On a voice call your '
                    'likeness is a live snapshot of you on screen (current '
                    'outfit, backdrop, anyone else on the call); in text '
                    'chat it is your full-body portrait in the outfit you '
                    'have on. Keep your art style - stylized anime/cel-'
                    'shaded 3D, NOT photorealistic - unless the user asks '
                    'for a different style. Omit when the picture is not '
                    'of you.'
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
# change_background (no live canvas). Text mode's take_selfie lives below
# too, but the session builder offers it under the capture-tools flag.
# Editing user uploads needs no dedicated tool: both surfaces ingest image
# uploads into the Imagine library at upload time, so create_image's
# source_images reaches them like any other library entry.
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


def build_create_video_tool(*, reference=True, selfie=True):
    """create_video for a session. With Reference-to-Video support the
    schema gains include_self (the companion's likeness as the first
    reference image); without it the reference parameters are pruned and,
    when `selfie` is set (voice mode — a live canvas exists to capture),
    the description falls back to the take_selfie → source_image route.
    Text mode passes selfie=False: it has no canvas, and include_self
    covers it wherever the model supports references."""
    tool = copy.deepcopy(_CREATE_VIDEO_TOOL)
    if reference:
        tool['description'] = tool['description'].replace('__REFERENCE_MODE__', _REFERENCE_MODE_BLOCK)
        tool['parameters']['properties']['include_self'] = {
            'type': 'boolean',
            'description': (
                'true = the clip features you: your likeness is added as '
                'the first reference image (<IMAGE_0>; any reference_images '
                'follow as <IMAGE_1>, ...) - on a voice call a live '
                'snapshot of you on screen (outfit, scene backdrop, call '
                'peers), in text chat your full-body portrait on a '
                'transparent background. Reference-to-Video only - not '
                'with source_image / extend_video / edit_video. Keep your '
                'art style unless the user asks otherwise.'
            ),
        }
        tool['description'] += (
            " When the user wants a video featuring YOU, set "
            "include_self=true - no other call is needed - and keep your "
            "art style in the prompt: stylized anime/cel-shaded 3D, NOT "
            "photorealistic, unless the user asks for a different style."
        )
    else:
        tool['description'] = tool['description'].replace('  __REFERENCE_MODE__\n\n', '')
        del tool['parameters']['properties']['reference_images']
        del tool['parameters']['properties']['voice_ids']
    if not reference and selfie:
        tool['description'] += (
            " When the user wants a video featuring YOU, call take_selfie "
            "first to capture how you look and pass its image_url here as "
            "source_image — the clip animates the shot itself."
        )
    return tool


# Names that mean "the main VRM's look" in an outfit pick, besides the
# avatar's own main_outfit_name: the generic fallback label, and the label
# the pickers used before appearance moved onto the avatar record (a
# resumed session's tool schema may still carry it).
_MAIN_OUTFIT_ALIASES = frozenset({store.MAIN_OUTFIT_FALLBACK_NAME.lower(), 'default outfit'})


def _is_main_outfit(name, main_name):
    """Does an outfit pick name the main look (case-insensitive)?"""
    key = (name or '').strip().lower()
    return bool(key) and (key == (main_name or '').strip().lower() or key in _MAIN_OUTFIT_ALIASES)


def _with_outfit_param(tool, outfits, main_name):
    """Add the include_self companion parameter `outfit` (enum of the
    avatar's outfit names, main outfit first) when the wardrobe has any.
    The likeness then comes from that outfit's portrait (full-body when
    generated) instead of the current look: in text mode that is the
    portrait of whatever they have on, in voice mode the live on-screen
    avatar — so on a call, naming an outfit swaps the live snapshot for a
    portrait without changing what is on screen. In place; returns the
    tool for chaining."""
    names = [o['name'] for o in outfits or () if o.get('name')]
    if names and 'include_self' in tool['parameters']['properties']:
        tool['parameters']['properties']['outfit'] = {
            'type': 'string',
            'enum': [main_name] + names,
            'description': (
                f'With include_self: which of your outfits to appear in '
                f'("{main_name}" is your main outfit). Pass it whenever the '
                f'picture is not about how you look right now - the user '
                f'names a look, or the scene calls for one (a beach wants '
                f'the swimsuit), even if it is what you already have on. '
                f'Omit it only for a picture of you as you are on screen '
                f'right now, backdrop and all.'
            ),
        }
    return tool


def _with_companion_param(tool, con, agent, other_agents, *, include_voice_roster):
    """Add include_companion (a list drawn from an enum of "Name: Outfit"
    entries, one per other active companion's own wardrobe — their main
    outfit by its own name first) when enable_cross_companion_imagine is
    on and there's anyone to reference. Their likeness comes from that outfit's
    own portrait via _portrait_bytes, same as include_self+outfit. A
    combined "Name: Outfit" string is the only way to let the model pick
    BOTH in one static enum — function-calling schemas can't make one
    parameter's choices depend on another's. Deliberately NOT baked into the system prompt
    (that would grow with every companion, every turn, tool-call or not) —
    it rides in the tool schema itself, same as outfit's own enum and
    text_companion's own roster, so the cost is paid only where the
    capability is actually offered. On create_video (include_voice_roster=
    True) a name -> voice_id roster is folded into voice_ids' own
    description for the same reason. In place; returns the tool for
    chaining."""
    if not agent['enable_cross_companion_imagine']:
        return tool
    others = [a for a in (other_agents or []) if a['id'] != agent['id']]
    entries = []
    for a in others:
        if not a['name']:
            continue
        outfit_names = [store.agent_appearance(con, a)['main_name']] + [
            o['name'] for o in store.agent_outfit_dicts(con, a) if o.get('name')
        ]
        entries.extend(f'{a["name"]}: {o}' for o in outfit_names)
    if entries and 'include_self' in tool['parameters']['properties']:
        tool['parameters']['properties']['include_companion'] = {
            'type': 'array',
            'items': {'type': 'string', 'enum': entries},
            'description': (
                'Other companions to feature (not yourself): one "Name: '
                'Outfit" entry per companion, from the roster. Each one '
                'is added as a reference image, in the order listed, right '
                'after your own likeness (or first without include_self). '
                'Always address them in the prompt by positional tag, '
                'name alongside: with include_self and one companion, '
                f'"<IMAGE_0> {agent["name"]} and <IMAGE_1> <their name> '
                'sitting on a pier at sunset". Their clothing comes from '
                'the reference image - do not describe it, you do not '
                'know their wardrobe. For companions who are not '
                'on the call — on a live call, include_self already shows '
                'everyone on screen.'
            ),
        }
    if include_voice_roster:
        voiced = [(a['name'], a['voice']) for a in others if a['voice']]
        if voiced and 'voice_ids' in tool['parameters']['properties']:
            roster = '; '.join(f'{n} = {v}' for n, v in voiced)
            tool['parameters']['properties']['voice_ids']['description'] += (
                f"\nOther companions' voice ids, for a clip where they "
                f"speak in THEIR own voice too: {roster}."
            )
    return tool


def _with_user_param(tool, config):
    """Add include_user (a plain boolean, no outfit/wardrobe concept — it's
    a real photo, not a VRM) when the user has uploaded their own likeness
    in Settings. No separate toggle: the photo's presence IS the gate. In
    place; returns the tool for chaining."""
    if not config['user_photo_path']:
        return tool
    if 'include_self' in tool['parameters']['properties']:
        tool['parameters']['properties']['include_user'] = {
            'type': 'boolean',
            'description': (
                'true = feature the USER (the person you are talking to), '
                'using the photo they uploaded of themselves in Settings. '
                'Lands after your own likeness and any include_companion, '
                'before other source/reference images. Only set this when '
                'the user has actually asked to be in the picture/clip '
                'themselves - never add them on your own initiative.'
            ),
        }
    return tool


def build_voice_tools(con, agent):
    """Imagine function tools for a voice session."""
    outfits = store.agent_outfit_dicts(con, agent)
    main_name = store.agent_appearance(con, agent)['main_name']
    other_agents = [a for a in store.list_agents(con) if a['id'] != agent['id']]
    config = get_config(con)
    return [
        _CHANGE_BACKGROUND_TOOL,
        _with_user_param(_with_companion_param(
            _with_outfit_param(copy.deepcopy(_CREATE_IMAGE_TOOL), outfits, main_name),
            con, agent, other_agents, include_voice_roster=False), config),
        _with_user_param(_with_companion_param(
            _with_outfit_param(
                build_create_video_tool(reference=video_reference_supported(config),
                                        selfie=bool(agent['enable_capture_tools'])),
                outfits, main_name),
            con, agent, other_agents, include_voice_roster=True), config),
    ]


def build_text_tools(con, agent):
    """Imagine function tools for a text turn. No take_selfie hint: text has
    no live canvas, so include_self is the only way to feature the
    companion."""
    outfits = store.agent_outfit_dicts(con, agent)
    main_name = store.agent_appearance(con, agent)['main_name']
    other_agents = [a for a in store.list_agents(con) if a['id'] != agent['id']]
    config = get_config(con)
    return [
        _with_user_param(_with_companion_param(
            _with_outfit_param(copy.deepcopy(_CREATE_IMAGE_TOOL), outfits, main_name),
            con, agent, other_agents, include_voice_roster=False), config),
        _with_user_param(_with_companion_param(
            _with_outfit_param(
                build_create_video_tool(reference=video_reference_supported(config),
                                        selfie=False),
                outfits, main_name),
            con, agent, other_agents, include_voice_roster=True), config),
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
    include_self = tool_name == 'create_image' and _truthy((arguments or {}).get('include_self'))
    include_companion = tool_name == 'create_image' and _library_ref_list((arguments or {}).get('include_companion'))
    include_user = tool_name == 'create_image' and _truthy((arguments or {}).get('include_user'))
    if tool_name == 'create_image' and (source_refs or include_self or include_companion or include_user):
        source_uris = []
        labels = []   # aligned with source_uris; None = plain library source
        self_note = None
        companion_note = None
        if include_self:
            # The companion's likeness goes first so it is <IMAGE_0>, as the
            # schema promises; explicit sources follow in the order passed.
            uri, err, self_note = _self_likeness_data_uri(con, agent, arguments or {})
            if err:
                return {'error': err}
            source_uris.append(uri)
            labels.append(agent['name'])
        if include_companion:
            entries, err, companion_note = _companion_portrait_data_uris(con, agent, include_companion)
            if err:
                return {'error': f'include_companion: {err}'}
            for uri, name in entries:
                source_uris.append(uri)
                labels.append(name)
        if include_user:
            uri, err = _user_photo_data_uri(config)
            if err:
                return {'error': f'include_user: {err}'}
            source_uris.append(uri)
            labels.append(_user_label(config))
        for ref in source_refs or ():
            uri, err = _library_image_data_uri(con, ref)
            if err:
                return {'error': f'source_images: {err}'}
            source_uris.append(uri)
            labels.append(None)
        try:
            body = xai_client.edit_image(
                xai_api_key=xai_key,
                edits_url=config['xai_images_edits_url'],
                model=config['imagine_model'],
                prompt=_reference_legend(labels) + prompt,
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
            note = ' '.join(n for n in (self_note, companion_note) if n)
            if note:
                result['note'] = note
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


_PORTRAIT_MIMETYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
}


def _vrm_likeness(web_path):
    """(mimetype, bytes) for one VRM: its full-body portrait when generated
    (shows the outfit), else its face portrait (sidecar or embedded
    thumbnail), else None."""
    from . import portraits
    found = portraits.fullbody_source(web_path) or portraits.portrait_source(web_path)
    return found if found and found[0] in _EXT_BY_MIME else None


def _portrait_bytes(con, agent, outfit=None):
    """The companion's likeness as (mimetype, bytes, outfit_matched), or
    None. With `outfit`, that outfit's VRM is tried first (full-body, then
    face); otherwise — or when it has no portrait — the main avatar:
    full-body sidecar, else the agent's chat thumbnail override, else the
    face portrait (sidecar or the thumbnail embedded in the VRM). Full-res
    sources throughout — this feeds image/video generation, not list rows."""
    from . import portraits
    # Naming the main outfit picks the main avatar explicitly — it IS the
    # fallback, so it always counts as matched (no "used instead" note).
    wants_default = _is_main_outfit(outfit, store.agent_appearance(con, agent)['main_name'])
    if outfit and not wants_default and agent['avatar_id']:
        row = con.execute(
            "SELECT vrm_path FROM avatar_outfits WHERE avatar_id = ?"
            " AND lower(name) = lower(?) ORDER BY sequence, id LIMIT 1",
            (agent['avatar_id'], outfit.strip()),
        ).fetchone()
        found = _vrm_likeness(row['vrm_path']) if row and row['vrm_path'] else None
        if found:
            return found[0], found[1], True
    main_vrm = None
    if agent['avatar_id']:
        av = con.execute("SELECT vrm_path FROM avatars WHERE id = ?",
                         (agent['avatar_id'],)).fetchone()
        main_vrm = av['vrm_path'] if av else None
    found = portraits.fullbody_source(main_vrm) if main_vrm else None
    if not found and agent['chat_thumbnail_path']:
        src = portraits.vrm_disk_path(agent['chat_thumbnail_path'])
        mimetype = _PORTRAIT_MIMETYPES.get(src.suffix.lower()) if src else None
        if mimetype:
            found = (mimetype, src.read_bytes())
    if not found and main_vrm:
        found = portraits.portrait_source(main_vrm)
    if not found or found[0] not in _EXT_BY_MIME:
        return None
    return found[0], found[1], wants_default


def _portrait_data_uri(con, agent, outfit=None):
    """include_self: the companion's likeness as a data URI. Returns
    (data_uri, error, note): error when no likeness exists at all; note
    when an outfit was asked for but the main avatar had to stand in, so
    the companion can say so instead of claiming the outfit."""
    found = _portrait_bytes(con, agent, outfit)
    if not found:
        return None, ("include_self: no portrait available — this companion's "
                      "avatar has no embedded thumbnail."), None
    mimetype, raw, matched = found
    note = None
    if outfit and not matched:
        note = (f'No portrait exists for the "{outfit}" outfit, so your '
                f'main outfit was used instead.')
    return f'data:{mimetype};base64,{base64.b64encode(raw).decode()}', None, note


def _self_likeness_data_uri(con, agent, arguments):
    """include_self's likeness -> (data_uri, error, note). On the voice
    surface the browser snapshots the live canvas and passes its library
    ref as `self_snapshot` (see tool_dispatcher._resolveIncludeSelf); that
    is the likeness, and it travels under the include_self flag rather
    than inside source_images so it keeps the <IMAGE_0> slot the schema
    promises ahead of any include_companion portraits. Without it, the
    static portrait: the named `outfit` if any, else the outfit the
    companion currently has on (agents.current_outfit_name — so "how you
    look right now" holds in text chat too), else the main look."""
    snapshot = _library_ref(arguments.get('self_snapshot'))
    if snapshot:
        uri, err = _library_image_data_uri(con, snapshot)
        if err:
            return None, f'include_self: {err}', None
        return uri, None, None
    # A plain strip, not _library_ref: that normaliser drops values like
    # "None" or "Off", which are legitimate outfit names.
    outfit = str(arguments.get('outfit') or '').strip() or None
    if not outfit:
        current = store.current_outfit(con, agent)
        if current:
            uri, err, _note = _portrait_data_uri(con, agent, current['name'])
            # No note: nobody asked for this outfit by name, and the main
            # portrait standing in for a missing one is not worth a remark.
            return uri, err, None
    return _portrait_data_uri(con, agent, outfit)


def _resolve_companion(con, agent, value):
    """include_companion's "Name: Outfit" -> (agent_row, outfit_or_None,
    error). Case-insensitive name match; excludes the calling agent. Outfit
    is None for "Name" alone or "Name: <their main outfit>" (both mean
    their base look — same convention _portrait_bytes already uses for
    include_self). Defence in depth: the flag also gates whether the
    parameter is offered at all (see _with_companion_param), so this only
    fires for a stale/injected call."""
    if not agent['enable_cross_companion_imagine']:
        return None, None, 'the companion roster is disabled on this agent.'
    name, _, outfit = (value or '').partition(':')
    name = name.strip()
    outfit = outfit.strip() or None
    row = con.execute(
        "SELECT * FROM agents WHERE active = 1 AND id != ? AND lower(name) = lower(?)",
        (agent['id'], name),
    ).fetchone()
    if not row:
        return None, None, f'no active companion named "{name}".'
    if outfit and _is_main_outfit(outfit, store.agent_appearance(con, row)['main_name']):
        outfit = None
    return row, outfit, None


def _companion_portrait_data_uris(con, agent, values):
    """include_companion's list of "Name: Outfit" entries -> (entries,
    error, note), each entry a (data_uri, companion_name) pair. One
    portrait per entry, in the order given; exact duplicate entries are
    collapsed so a repeated pick doesn't double a likeness. The note names
    the companion whose outfit had no portrait, since with several in one
    call "the default look was used" alone wouldn't say whose."""
    entries = []
    notes = []
    seen = set()
    for value in values:
        key = value.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        target, outfit, err = _resolve_companion(con, agent, value)
        if err:
            return None, err, None
        found = _portrait_bytes(con, target, outfit)
        if not found:
            return None, (f'no portrait available for {target["name"]} — their '
                          f'avatar has no embedded thumbnail.'), None
        mimetype, raw, matched = found
        if outfit and not matched:
            notes.append(f'No portrait exists for {target["name"]}\'s "{outfit}" '
                         f'outfit, so their default look was used instead.')
        entries.append((f'data:{mimetype};base64,{base64.b64encode(raw).decode()}',
                        target['name']))
    return entries, None, ' '.join(notes) or None


def _user_label(config):
    """How the user is named in the reference legend."""
    name = (config['user_display_name'] or '').strip()
    return f'{name} (the user)' if name else 'the user'


def _reference_legend(labels):
    """Prefix for the prompt sent to xAI: which reference image is who.
    `labels` is aligned with the image list — a name for a likeness
    (self, companions, user), None for a plain library source. The
    companion model is supposed to address people by <IMAGE_n> tag, but
    it often narrates by name instead (the voice model especially), and
    the image model then gets four references plus four names with no
    mapping between them — which face lands on which body is a coin flip.
    The server knows exactly who sits in each slot, so it says so here,
    whatever the model wrote. Just the mapping — the prompt itself says
    what to do with each reference. Empty when no likeness is involved —
    a plain restyle of library images has nothing to name."""
    if not any(labels):
        return ''
    parts = [f'<IMAGE_{i}> is {label or "a source image"}' for i, label in enumerate(labels)]
    return 'Reference images: ' + ', '.join(parts) + '.\n\n'


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


def _user_photo_data_uri(config):
    """include_user: the user's own Settings-uploaded photo as a data URI,
    or an error. No outfit/wardrobe concept — it's a real photo, not a VRM,
    so there's only ever one source to resolve."""
    path = config['user_photo_path']
    if not path:
        return None, 'no user photo has been uploaded in Settings.'
    f = _web_path_to_file(path)
    if not f or not f.is_file():
        return None, 'the uploaded user photo could not be found on disk.'
    mimetype = _PORTRAIT_MIMETYPES.get(f.suffix.lower())
    if not mimetype:
        return None, 'the uploaded user photo has an unsupported file type.'
    return f'data:{mimetype};base64,{base64.b64encode(f.read_bytes()).decode()}', None


def _imagine_row_for_ref(con, ref):
    """Imagine-library row for a model-supplied reference: a numeric
    imagine_image_id — bare or labelled like "imagine_image_id:139", the way
    tool results print it — or an exact image_path/video_url string."""
    ref = ref.strip()
    for label in ('imagine_image_id', 'image_url', 'video_url', 'id'):
        if ref.lower().startswith(label) and ref[len(label):len(label) + 1] in (':', '=', ' '):
            ref = ref[len(label):].lstrip(' :=')
            break
    if ref.isdigit():
        return con.execute(
            "SELECT * FROM imagine_images WHERE id = ?", (int(ref),),
        ).fetchone()
    row = con.execute(
        "SELECT * FROM imagine_images WHERE image_path = ?", (ref,),
    ).fetchone()
    if row or '/' in ref:
        return row
    # A bare stored filename ("imagine_<uuid>.jpg") — the tail of an image_url
    # a tool result printed. Every library file lives under /files/, so this
    # maps one-to-one.
    return con.execute(
        "SELECT * FROM imagine_images WHERE image_path = ?", (f'/files/{ref}',),
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
    legend = ''   # reference-to-video only: who is which <IMAGE_n>
    image_data_uri = None
    reference_data_uris = None
    reference_voice_ids = None
    video_data_uri = None
    aspect_ratio = None
    resolution = _VIDEO_DEFAULT_RESOLUTION
    self_note = None
    companion_note = None
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
        include_self = _truthy(arguments.get('include_self'))
        include_companion = _library_ref_list(arguments.get('include_companion'))
        include_user = _truthy(arguments.get('include_user'))
        # Schema-pruned for these models (see build_create_video_tool);
        # refuse here too so a stale or injected call can't slip through.
        if ((reference_refs or reference_voice_ids or include_self or include_companion or include_user)
                and not video_reference_supported(config)):
            return {'error': (
                f'reference_images / voice_ids are not supported by the configured '
                f'video model ({config["imagine_video_model"]}).'
            )}
        extend_ref = _library_ref(arguments.get('extend_video'))
        edit_ref = _library_ref(arguments.get('edit_video'))
        picked = [name for name, value in (
            ('source_image', source_ref),
            ('reference_images', reference_refs or include_self or include_companion or include_user),
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
        elif reference_refs or include_self or include_companion or include_user:
            reference_data_uris = []
            labels = []
            if include_self:
                # Likeness first → <IMAGE_0>, as the schema promises.
                uri, err, self_note = _self_likeness_data_uri(con, agent, arguments)
                if err:
                    return {'error': err}
                reference_data_uris.append(uri)
                labels.append(agent['name'])
            if include_companion:
                entries, err, companion_note = _companion_portrait_data_uris(con, agent, include_companion)
                if err:
                    return {'error': f'include_companion: {err}'}
                for uri, name in entries:
                    reference_data_uris.append(uri)
                    labels.append(name)
            if include_user:
                uri, err = _user_photo_data_uri(config)
                if err:
                    return {'error': f'include_user: {err}'}
                reference_data_uris.append(uri)
                labels.append(_user_label(config))
            for ref in reference_refs or ():
                uri, err = _library_image_data_uri(con, ref)
                if err:
                    return {'error': f'reference_images: {err}'}
                reference_data_uris.append(uri)
                labels.append(None)
            legend = _reference_legend(labels)
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
            prompt=legend + prompt,
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
        ) + ''.join(f' {n}' for n in (self_note, companion_note) if n),
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
