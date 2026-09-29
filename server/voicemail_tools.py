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
    guide = audio_studio.guide_text(audio_studio.rules_text(get_config(con)),
                                    audio_sounds.catalog(con), agent)
    return {
        'type': 'function',
        'name': CREATE_VOICEMAIL_TOOL_NAME,
        'description': _INTRO + '\n\n' + guide,
        'parameters': _PARAMETERS,
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
        result = audio_studio.render(con, config, script, voice=agent['voice'], language=language,
                                     pace=_clamp_pace(agent['voice_speed']))
    except UserError as e:
        return {'error': str(e)}
    except Exception as e:
        # Anything unforeseen must come back as a tool error, not abort the
        # whole text turn (the tool_call row is already committed).
        _logger.exception('create_voicemail render failed')
        return {'error': f'The recording could not be rendered: {e}'}
    rec_id = store_recording(con, name=title, source='voicemail', script=script,
                             voice=agent['voice'], result=result,
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
