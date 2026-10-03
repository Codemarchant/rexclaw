# Copyright 2026 Codemarchant
"""Mini-game voice lines: short reactions ("Okay, that one stung.") spoken
in a companion's own voice, recorded once and kept.

The lines themselves live with the games (web/public/games/lib/lines.js).
A line is rendered the way a voicemail is (voicemail_tools.call_voice +
audio_studio.render: the companion's call voice, Grok's or its voice
setup's engine) and cached under FILES_DIR/game-voice/, named by a hash of
the companion, its voice and the text. A voice change records afresh;
an unchanged line is never billed twice.
"""
import hashlib
import logging
import os

from . import audio_studio, voicemail_tools
from .db import FILES_DIR, get_config

_logger = logging.getLogger(__name__)

VOICE_DIR = FILES_DIR / 'game-voice'
MAX_LINE_CHARS = 240


def _key(agent, voice, text):
    raw = f'{agent["id"]}|{voice}|{agent["voice_speed"]}|{text}'
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:24]


def line(con, agent, text, *, record=False):
    """{'url'} of `text` in the companion's voice: the cached recording, a
    fresh one when `record`, else {'url': None}. Raises UserError when it
    can't be rendered (no key, no voice)."""
    text = ' '.join((text or '').split())[:MAX_LINE_CHARS]
    if not text:
        return {'url': None}
    config = get_config(con)
    voice, speaker = voicemail_tools.call_voice(con, agent, config)
    key = _key(agent, voice, text)
    path = VOICE_DIR / f'{key}.mp3'
    if path.is_file():
        return {'url': f'/files/game-voice/{key}.mp3'}
    if not record:
        return {'url': None}
    # The render writes /files/audio_<id>.mp3 (and extensions may add
    # <stem>.* beside it); everything it made moves under the cache name.
    result = audio_studio.render(con, config, text, voice=voice,
                                 pace=voicemail_tools._clamp_pace(agent['voice_speed']), speaker=speaker)
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    made = FILES_DIR / result['audio_url'].rsplit('/', 1)[-1]
    for extra in FILES_DIR.glob(f'{made.stem}.*'):
        os.replace(extra, VOICE_DIR / (key + extra.name[len(made.stem):]))
    _logger.info('game voice line recorded for %s (%d chars)', agent['name'], len(text))
    return {'url': f'/files/game-voice/{key}.mp3'}
