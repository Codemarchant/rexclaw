# Copyright 2026 Codemarchant
"""Sound effects in voice calls: play_sound_effect.

A companion's soundboard: short one-shots (a drum roll, a rimshot, a crowd
laughing) it plays to flavour the conversation. The sound plays in the
browser (web/src/models/sound_effects.js), in whichever window holds the
call. This module serves what it plays:

  effects   a companion's effects: its avatar's own (avatar_sound_effects,
            the manifest "sound_effects" list) plus, unless the avatar opts
            out (sound_effects_library = 0), the sound effect library: the
            user's call sound effects (History → Recordings → Your sounds,
            the "Call sound effect" kind, which the recording studio and
            voice messages never see) and the bundled ones
            (assets/audio/effects), less the ones the avatar switches off
            (sound_effects_off)
  level     the gain that plays an effect at the call's effect level

Each effect has a name, a file and a description that says what it sounds
like and when to use it; the tool lists them, like the outfits and the
music tracks.
"""
import json
import math
import threading

import numpy as np

from . import audio_sounds, audio_studio, call_music, media_fetch
from .db import ASSETS_DIR
from .errors import UserError

TOOL_NAME = 'play_sound_effect'
# When an effect plays against the caller's own speech (the browser does the
# timing, models/sound_effects.js): after the words already said in the
# reply, or at once, over them.
TIMINGS = ('after', 'during')
BUNDLED_DIR = ASSETS_DIR / 'audio' / 'effects'

# An effect plays as loud as the voice it punctuates: one loudness for every
# part of the programme, which is what loudness normalisation is for
# (EBU R 128). Measured like the music (BS.1770), and never lifted past the
# studio's true-peak ceiling, so a quiet recording is not pushed into clipping.
EFFECT_LUFS = call_music.VOICE_LUFS
PEAK_CEILING_DB = audio_studio.PEAK_CEILING_DB
MEASURE_SECONDS = 60       # of a long file; effects are seconds long

# The effects that ship with the app (provenance in the CREDITS.md beside
# them). name → (file, description): what it sounds like, then when to use it.
# MP3 on purpose: the browser decodes an effect with decodeAudioData, and MP3
# is the one compressed format every engine decodes there (WebKit's Ogg
# support is recent and unproven on that path).
BUNDLED = {
    'drumroll-crash': ('drumroll-crash.mp3',
                       'a drum roll that ends in a kick and a cymbal crash; for a reveal, an '
                       'announcement or a grand entrance'),
    'rimshot': ('rimshot.mp3',
                'the "ba-dum-tss" drum sting; right after a joke or a pun, yours or the user\'s'),
    'crowd-laugh': ('crowd-laugh.mp3',
                    'a small audience bursting into laughter; when something funny was just said'),
    'applause': ('applause.mp3',
                 'a small audience clapping; for an achievement, good news or a fine performance'),
    'crowd-cheer': ('crowd-cheer.mp3',
                    'a small crowd cheering and clapping; for a win, a big announcement or a welcome'),
    'crowd-aww': ('crowd-aww.mp3',
                  'a small audience going "awww"; for something cute, sweet or touching'),
    'crowd-gasp': ('crowd-gasp.mp3',
                   'a group gasping in shock; for a twist, a scandalous remark or a close call'),
    'crowd-boo': ('crowd-boo.mp3',
                  'a small crowd booing; for a terrible pun, a villain or a bad idea, in jest'),
    'honk': ('honk.mp3',
             'a squeeze bicycle horn, one honk; for clowning around, a silly moment or to get attention'),
    'air-horn': ('air-horn.mp3',
                 'a loud, bright air horn blast; for hype, a victory or a rowdy celebration'),
    'bonk': ('bonk.mp3',
             'a low, short drum thump; a playful knock on the head for a silly or cheeky remark'),
    'boing': ('boing.mp3',
              'a twangy jaw-harp boing; for a bounce, a sudden idea or something springing up'),
    'yippee': ('yippee.mp3',
               'a little cartoon voice cheering "yippee!"; for a small happy win or pure delight'),
    'scream': ('scream.mp3',
               'a man\'s over-the-top comic scream; for mock horror, a jump scare or a dramatic fall'),
    'wilhelm-scream': ('wilhelm-scream.mp3',
                       'the Wilhelm scream, the famous stock movie scream of a man yelping as he falls; '
                       'for a slapstick tumble, someone getting knocked out of the picture, or a nod '
                       'to old films'),
    'sad-trombone': ('sad-trombone.mp3',
                     'the descending "wah wah wah waaah" on a trombone; for a fail, a letdown or a joke '
                     'that flopped'),
    'tada': ('tada.mp3',
             'a short brass "ta-da!" fanfare; for presenting something, or a task finished'),
    'ding': ('ding.mp3',
             'a single bright bell ding; for a correct answer, a good point or an idea landing'),
    'buzzer': ('buzzer.mp3',
               'a harsh game-show buzzer; for a wrong answer or a firm no'),
    'record-scratch': ('record-scratch.mp3',
                       'a needle scratching across a vinyl record; for a "wait, what?" moment that '
                       'stops everything'),
    'crickets': ('crickets.mp3',
                 'four seconds of crickets chirping; for an awkward silence, or a joke nobody laughed at'),
    'slide-whistle-up': ('slide-whistle-up.mp3',
                         'a slide whistle sliding up; for something rising, taking off or a hopeful '
                         'build-up'),
    'slide-whistle-down': ('slide-whistle-down.mp3',
                           'a slide whistle sliding down; for something falling, deflating or going '
                           'wrong'),
    'dramatic-sting': ('dramatic-sting.mp3',
                       'one heavy, sustained orchestral hit; for a shocking reveal or mock drama'),
    'whoopee-cushion': ('whoopee-cushion.mp3',
                        'two short toots from a whoopee cushion; for toilet humour and pranks'),
    'party-horn': ('party-horn.mp3',
                   'a party blower toot; for birthdays, congratulations and small celebrations'),
    'cash-register': ('cash-register.mp3',
                      'a cash register ringing up a sale, "ka-ching"; for money, a bargain or a deal '
                      'closed'),
    'magic-sparkle': ('magic-sparkle.mp3',
                      'a chime tree glissando running from high to low, with reverb; for magic, a wish '
                      'or a transformation'),
    'gong': ('gong.mp3',
             'a big gong struck once and left to ring; for a grand entrance, a solemn moment or time '
             'being up'),
    'kiss': ('kiss.mp3',
             'a cartoon "mwah" kiss; for a playful or affectionate kiss'),
    'pop': ('pop.mp3',
            'a champagne cork popping; for a celebration, a toast or opening something'),
    'squeak': ('squeak.mp3',
               'a squeaky dog toy, one squeak; for a poke, a squeeze or something small and cute'),
    'thunder': ('thunder.mp3',
                'a thunder clap with a rolling rumble; for an ominous or dramatic moment'),
    'evil-laugh': ('evil-laugh.mp3',
                   'a hammy villain\'s laugh; for a wicked plan or mock villainy'),
    'heavenly-choir': ('heavenly-choir.mp3',
                       'voices holding one angelic chord; for something heavenly, a blessing or a '
                       'perfect moment'),
}

_level_cache = {}   # disk path → (mtime, LUFS or None, peak dBFS or None)
_lock = threading.Lock()


def library_effects(con):
    """The sound effect library: the user's call sound effects, then the
    bundled ones (a user's effect of the same name replaces a bundled one)."""
    out = [{'name': r['name'], 'url': r['file_path'], 'description': r['description'] or '',
            'credit': r['credit'] or '', 'source': 'library', 'level': r['level'] or 0.0}
           for r in audio_sounds.call_effects(con)]
    taken = {e['name'].lower() for e in out}
    out += [{'name': name, 'url': f'/assets/audio/effects/{fname}', 'description': desc, 'credit': '',
             'source': 'bundled', 'level': 0.0}
            for name, (fname, desc) in BUNDLED.items()
            if name not in taken and (BUNDLED_DIR / fname).is_file()]
    return out


def effects(con, avatar_id, whole_library=False):
    """A companion's effects (see the module docstring); an avatar's own
    come first and win a name clash. whole_library: all of the library,
    even when the avatar opts out of it or switches effects off (the
    avatar editor's list)."""
    avatar = con.execute("SELECT sound_effects_library, sound_effects_off FROM avatars WHERE id = ?",
                         (avatar_id,)).fetchone() if avatar_id else None
    # An effect the avatar took from Your sounds keeps the level set there.
    levels = {r['file_path']: r['level'] or 0.0
              for r in con.execute("SELECT file_path, level FROM audio_sounds").fetchall()}
    out = [{'name': r['name'], 'url': r['file_path'], 'description': r['description'],
            'credit': r['credit'], 'source': 'avatar', 'level': levels.get(r['file_path'], 0.0)}
           for r in con.execute("SELECT * FROM avatar_sound_effects WHERE avatar_id = ? ORDER BY sequence, id",
                                (avatar_id,)).fetchall()] if avatar_id else []
    if whole_library or avatar is None or avatar['sound_effects_library']:
        taken = {e['name'].lower() for e in out}
        if avatar is not None and not whole_library:
            try:
                taken |= {str(n).lower() for n in json.loads(avatar['sound_effects_off'] or '[]')}
            except ValueError:
                pass
        out += [e for e in library_effects(con) if e['name'].lower() not in taken]
    return out


def sound_users(con, file_path):
    """The avatars that play a library sound's file as one of their own
    effects, one line each: what they would lose without it."""
    return [f'{r["avatar"]}\'s sound effect "{r["name"]}"' for r in con.execute(
        """SELECT a.name AS avatar, e.name FROM avatar_sound_effects e JOIN avatars a ON a.id = e.avatar_id
           WHERE e.file_path = ? ORDER BY a.name, e.name""", (file_path,))]


def _measure(path):
    """(BS.1770 loudness in LUFS or None for silence, peak in dBFS or None)
    of an effect's file, cached per file. A sound shorter than BS.1770's
    400 ms window is measured over one window."""
    mtime = path.stat().st_mtime
    with _lock:
        hit = _level_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    sr = audio_studio.SR
    x = np.concatenate([b for _rate, b in media_fetch.decode(path, rate=sr, max_seconds=MEASURE_SECONDS)]
                       or [np.zeros((0, 2), np.float32)])
    peak = float(np.abs(x).max()) if len(x) else 0.0
    lufs = peak_db = None
    if peak > 0:
        peak_db = 20 * math.log10(peak)
        # Whole 100 ms blocks, four at least: _block_energies drops a partial
        # block, which is most of a short sound.
        hop = sr // 10
        blocks = max(4, math.ceil(len(x) / hop))
        x = np.concatenate([x, np.zeros((blocks * hop - len(x), 2), np.float32)])
        lufs = audio_studio._integrated_loudness(audio_studio._block_energies(x.T))
    with _lock:
        _level_cache[path] = (mtime, lufs, peak_db)
    return lufs, peak_db


def level(url, offset=0.0):
    """The gain (dB) that plays an effect's file at EFFECT_LUFS, plus
    `offset` (a library sound's own level), without passing the peak
    ceiling. A silent file gets 0."""
    lufs, peak_db = _measure(call_music.disk_path(url))
    if lufs is None:
        return 0.0
    try:
        offset = max(-24.0, min(12.0, float(offset or 0)))   # the library's own range
    except (TypeError, ValueError):
        offset = 0.0
    return round(min(EFFECT_LUFS + offset - lufs, PEAK_CEILING_DB - peak_db), 2)


def offered(con, agent):
    """Whether a voice call for this companion carries play_sound_effect:
    switched on, and there is something to play."""
    return bool(agent['enable_sound_effects']) and bool(effects(con, agent['avatar_id']))


def build_tool(con, agent):
    """play_sound_effect for a voice call, or None when the companion has
    no effects to play."""
    listed = effects(con, agent['avatar_id'])
    if not listed:
        return None
    lines = '\n'.join(f'- {e["name"]}' + (f': {e["description"][:200]}' if e['description'] else '')
                      for e in listed)
    description = (
        'Play a sound effect out loud in the call, like pressing a button on a soundboard, to '
        'punctuate the moment. The user hears it over the call. It plays once the words you have '
        'already said in this reply have been heard, so say the line first and the sound lands '
        'right after it; called before you have said anything, it plays at once and leads in to '
        'what you say next. Whatever you say after the call is heard once the sound has '
        'finished. Each sound below says what it is and when it fits.'
        '\n\nYour sound effects:\n' + lines
    )
    return {'type': 'function', 'name': TOOL_NAME, 'description': description,
            'parameters': {'type': 'object', 'properties': {
                'sound': {'type': 'string', 'enum': [e['name'] for e in listed],
                          'description': 'The sound effect to play.'},
                'timing': {'type': 'string', 'enum': list(TIMINGS),
                           'description': 'When it plays. "after" (the default): once the words you '
                                          'have said in this reply have been heard. "during": at '
                                          'once, over the line you are saying, for a sound that '
                                          'belongs under your words, like a crowd reacting while '
                                          'you talk; it lands somewhere within the line, not on a '
                                          'particular word, and what you say next does not wait '
                                          'for it.'},
            }, 'required': ['sound']}}
