# Copyright 2026 Codemarchant
"""create_voicemail: the companion records a voice message in its own voice.

Text chat only, on purpose. On a voice call the companion is already
speaking, a long render would block the call, and every tool offered there
costs realtime context. In text chat (and heartbeat ticks, which run as
text turns) a recording is the one way the user can HEAR the companion,
from a ten-second teasing voice note up to a twenty-minute meditation.

Rendering lives in audio_studio.py (shared with the History → Recordings
playground). This module holds the tool schema, the executor and the
audio_recordings row helpers both callers use.
"""
import logging
from textwrap import dedent

from . import audio_sounds, audio_studio
from .pipeline import setups as voice_setups
from .db import get_config, utcnow
from .errors import UserError

_logger = logging.getLogger(__name__)

CREATE_VOICEMAIL_TOOL_NAME = 'create_voicemail'

_INTRO = dedent("""
        Record an audio message in your own voice and send it as a playable
        recording: a teasing voice note, a good-morning message, a bedtime
        story, a guided meditation, a breathing exercise, a relaxation or
        hypnosis-style session. Only when the user asks for a recording or
        voice message (or your instructions call for one). It appears in the
        chat automatically, so never write its URL or file name. Say a line
        about it instead. Short notes render in seconds; a long piece takes
        a minute or more. The result lists warnings when a directive was
        misread or the speech overran the target; fix and re-record if a
        warning matters.

        It is spoken in your own voice. The script is a small timeline
        language, fully described below.
    """).strip()

_PARAMETERS = {
    'type': 'object',
    'properties': {
        'title': {
            'type': 'string',
            'description': 'Short name for the recording, e.g. "Good morning, sleepyhead" '
                           'or "10-minute body scan".',
        },
        'script': {
            'type': 'string',
            'description': 'The full script: spoken lines with speech tags, plus '
                           'directive lines in braces.',
        },
        'language': {
            'type': 'string',
            'description': (
                'Language code of the script. Fully supported: '
                + ', '.join(f'{code} ({name})' for code, name in audio_studio.TTS_LANGUAGES)
                + '. Other languages also work, with varying accuracy: pass their '
                'BCP-47 code (e.g. "nl" for Dutch). Default: auto. Passing the '
                'code gives more consistent results than auto.'
            ),
        },
    },
    'required': ['title', 'script'],
}


def build_tool(con, agent=None):
    """create_voicemail for a text turn. Built per session because its
    description carries the user's writing rules (config.recording_rules)
    and uploaded sounds, both edited in History → Recordings, and the
    extension directives this companion has switched on."""
    config = get_config(con)
    speech_tags = renders_tags(con, agent, config) if agent else True
    # A voice without Grok's tags gets the default rules minus the lines
    # about tags (guide_text); the user's own rules are written for Grok's
    # voice, and a companion's prompt can carry rules for the others. A
    # voice with tags of its own gets the section its calls teach.
    rules = audio_studio.rules_text(config) if speech_tags else None
    own_tags = tag_guide(con, agent, config) if agent else ''
    guide = audio_studio.guide_text(rules, audio_sounds.catalog(con), agent, speech_tags=speech_tags,
                                    tag_guide=own_tags)
    parameters = _PARAMETERS
    if not (speech_tags or own_tags):
        # No tags on this voice: the script is described without them.
        script = {**_PARAMETERS['properties']['script'],
                  'description': 'The full script: spoken lines, plus directive lines in braces.'}
        parameters = {**_PARAMETERS, 'properties': {**_PARAMETERS['properties'], 'script': script}}
    return {
        'type': 'function',
        'name': CREATE_VOICEMAIL_TOOL_NAME,
        'description': _INTRO + '\n\n' + guide,
        'parameters': parameters,
    }


def store_recording(con, *, name, source, script, voice, result, agent_id=None,
                    session_id=None, category=None):
    """Insert the audio_recordings row for a finished render; returns its id."""
    cur = con.execute(
        """INSERT INTO audio_recordings
               (name, source, category, agent_id, session_id, voice, script, audio_path,
                duration_seconds, tts_chars, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, source, category, agent_id, session_id, voice, script, result['audio_url'],
         result['duration_seconds'], result['tts_chars'], utcnow()))
    return cur.lastrowid


def _clamp_pace(value):
    """The companion's voice_speed within xAI's 0.7-1.5; an imported
    companion package writes the column as-is (same guard as session_service)."""
    try:
        return max(0.7, min(1.5, float(value or 1.0)))
    except (TypeError, ValueError):
        return 1.0


def call_voice(con, agent, config):
    """(voice, speaker) recordings use: the voice the companion has on
    calls. On a voice setup whose voice isn't Grok's, that setup's engine
    speaks (audio_studio.engine_speaker), no xAI needed; otherwise xAI TTS
    with its Grok voice (speaker None)."""
    setup = voice_setups.for_agent(con, agent, config)
    if setup is None or setup.tts_connection == voice_setups.XAI:
        return agent['voice'], None
    # The voice stage's own voice, not setup.voice_for: on a speech-to-speech
    # setup that is the call model's voice, which this engine may not have.
    cls, settings = setup.stages['tts']
    voice = cls.voice_for(settings, agent['voice'], voice_setups.pipeline_voice(agent, setup.tts_connection))
    if cls.needs_voice and not voice:
        raise UserError(f'{agent["name"]} has no {cls.label} voice yet: set their voice on the Companions '
                        f'tab, or the voice setup\'s default voice in Settings → Models & providers.')
    return voice, audio_studio.engine_speaker(setup.stages['tts'], config, voice)


def renders_tags(con, agent, config):
    """Whether the voice recordings use (call_voice) renders Grok's speech
    tags — only then are they taught (audio_studio.guide_text)."""
    setup = voice_setups.for_agent(con, agent, config)
    if setup is None or setup.tts_connection == voice_setups.XAI:
        return True
    return bool(setup.stages['tts'][0].speech_tags)


def tag_guide(con, agent, config):
    """The speech-tag section of the voice recordings use, when that voice
    has tags of its own rather than Grok's (setups.Setup.tag_guide): the
    same text the companion's calls teach. '' = none."""
    setup = voice_setups.for_agent(con, agent, config)
    if setup is None or setup.tts_connection == voice_setups.XAI:
        return ''
    return setup.tag_guide(agent)


def available(con, agent, config):
    """Whether create_voicemail can render for this companion: a local
    call voice, or an xAI key for Grok's. Not while its engine voice is
    missing (call_voice) - every recording would fail."""
    try:
        speaker = call_voice(con, agent, config)[1]
    except UserError:
        return False
    return bool(config['xai_api_key']) or speaker is not None


def execute_create_voicemail(con, session, agent, arguments):
    """Render and store the recording. Errors come back as {'error': str}."""
    if not agent['enable_voicemail']:
        return {'error': 'Voice messages are disabled on this companion.'}
    if session['mode'] != 'text':
        return {'error': 'create_voicemail is only available in text chat.'}
    if session['origin'] == 'delegated':
        return {'error': 'Background task sessions cannot record voice messages.'}
    arguments = arguments or {}
    script = arguments.get('script')
    if not isinstance(script, str) or not script.strip():
        return {'error': 'script is required.'}
    title = (arguments.get('title') or '').strip()[:80] or 'Voice message'
    language = audio_studio.normalize_language(arguments.get('language')) or 'auto'
    config = get_config(con)
    # A long render takes a while. The text loop calls this inside the
    # transaction that persisted the tool_call row, so commit first, or
    # SQLite holds the write lock for the whole render (see imagine_tools
    # _execute_local_tool).
    con.commit()
    try:
        voice, speaker = call_voice(con, agent, config)
        result = audio_studio.render(con, config, script, voice=voice, language=language,
                                     pace=_clamp_pace(agent['voice_speed']), speaker=speaker)
    except UserError as e:
        return {'error': str(e)}
    except Exception as e:
        # Anything unforeseen must come back as a tool error, not abort the
        # whole text turn (the tool_call row is already committed).
        _logger.exception('create_voicemail render failed')
        return {'error': f'The recording could not be rendered: {e}'}
    rec_id = store_recording(con, name=title, source='voicemail', script=script,
                             voice=voice, result=result,
                             agent_id=agent['id'], session_id=session['id'])
    payload = {
        'recording_id': rec_id,
        'audio_url': result['audio_url'],
        'name': title,
        'duration_seconds': result['duration_seconds'],
        'note': ('The recording is already in the chat as a playable attachment. Do not '
                 'say or write the URL or file name; just talk about it naturally.'),
    }
    if result['warnings']:
        payload['warnings'] = result['warnings']
    if result['notes']:
        payload['extensions'] = result['notes']
    return payload
