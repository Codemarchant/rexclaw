# Copyright 2026 Codemarchant
"""Audio studio: render a script into one mixed audio recording.

Grok TTS cannot hold a silence — `[pause]` is ~1.2 s, `[long-pause]` ~2.0 s
and four stacked long-pauses still only ~2.7 s (measured 2026-09-26) — and
it can't count seconds for a breathing exercise either. So long pieces
(meditations, sleep stories, hypnosis-style inductions) are assembled here:
the script's speech goes to xAI TTS a paragraph at a time, with its native
speech tags passed straight through, and brace directives on their own
lines build the timeline around it. The companion's create_voicemail tool
and the History → Recordings playground share this renderer.

The script grammar is documented ONCE, as data (SPEECH_TAGS, DIRECTIVES,
HOW_IT_WORKS, WRITING_TIPS, EXAMPLE_SCRIPT below): guide() feeds the
playground's Full guide and guide_text() the tool description, so the
companion and the user always read the same, current rules.

Mixing runs in 60-second blocks and encodes as it goes, so a 30-minute
render never holds the whole mix in memory. Every procedural layer is a
pure function of absolute sample time (noise beds read a seamless FFT
loop), which makes the block edges invisible and the two passes —
loudness measurement, then the gained encode — identical.
"""
import concurrent.futures
import io
import logging
import math
import re
import time
import uuid
import wave
import zlib

import numpy as np
import requests

from . import audio_sounds, plugins, store, xai_client
from .db import FILES_DIR
from .errors import UserError

_logger = logging.getLogger(__name__)

SR = 24000  # xAI TTS default rate; everything is mixed at it

# --- Cost (docs.x.ai model pricing table: Text to Speech $15.00 / 1M chars)
TTS_USD_PER_CHAR = 15.0 / 1_000_000

# --- Limits
MAX_SECONDS = 2 * 60 * 60        # room for a whole sleep piece (Calm stories 25–40 min,
                                 # Headspace sleepcasts 45–55); mixing runs in blocks, so
                                 # length costs render time, not memory
MAX_LENGTH_TEXT = '2 hours'
MAX_SCRIPT_CHARS = 60_000        # xAI's own per-request text cap
MAX_SILENCE = 10 * 60
MAX_CHUNK_CHARS = 2000           # paragraphs longer than this split at sentences
TTS_WORKERS = 4

# --- Timing (seconds)
HEAD = 1.0          # ACX: 0.5–1 s room tone at the head
TAIL = 5.0          # ACX: 1–5 s room tone at the tail; moodscape 5 s fade-out
PARAGRAPH_GAP = 0.6  # Grok's own pause at a blank line inside one request (measured
                     # 0.49–0.63 s); used where speech has to split across requests
SPEECH_TAIL = 0.4   # trailing silence Grok leaves after a line (measured 0.26–0.44 s);
                    # trimmed off every clip, restored as timeline time
LAYER_FADE = 3.0    # moodscape: 3 s fade-in; also the crossfade between bed changes
FRAME = 100         # control-rate frames per second (ducking, breath swell)

# --- Levels (dBFS, RMS unless noted). Voice clips arrive around −20 LUFS
# (measured: −17..−22 plain, −27..−30 whispered).
ROOM_TONE_DB = -66      # measured TTS noise floor −60..−75; ACX floor < −60. Opt-in
                        # ({room-tone on}): levelled up it measured −61.5 dBFS, a steady hiss
                        # on headphones, while Grok's own gaps fall to −89
BED_DB = -36            # ducked by DUCK_DB under speech → ~24 dB below voice,
DUCK_DB = 8             # inside the 18–25 dB music-under-voice norm
DUCK_ATTACK = 0.05      # ducker 30–60 ms attack,
DUCK_RELEASE = 0.5      # 300–700 ms release
BINAURAL_DB = -48       # Lee et al. 2019: beat ~30 dB under the foreground
ISOCHRONIC_DB = -46
TICK_PEAK_DB = -28      # design: audible, never louder than a whisper
HEARTBEAT_PEAK_DB = -26
CHIME_PEAK_DB = -12
LEVEL_WORDS = {'soft': -6.0, 'medium': 0.0, 'loud': 6.0}
UNDERLAY_DB = -15       # subliminal/whisper layers sit 10–20 dB under the voice
TARGET_LUFS = -18.0     # AES TD1008: speech-only streaming content
PEAK_CEILING_DB = -1.0  # Apple Podcasts / Spotify true-peak ceiling

# --- Effects
BINAURAL_CARRIER = 200.0                                  # Silencio 200/210 Hz pair
BINAURAL_BANDS = {'delta': 2.0, 'theta': 6.0, 'alpha': 10.0}  # band centres: δ 0.5–4, θ 4–8, α 8–12
ECHO_DELAY = 0.4        # suggested 300–500 ms, feedback 0.3–0.45, repeats
ECHO_FEEDBACK = 0.35    # alternating ears (Harrold "stereo-echoed" affirmations)
REVERB_DECAY = 2.4      # ballad-hall decay 2.4–4 s
REVERB_PREDELAY = 0.05  # 35–70 ms keeps words intelligible
REVERB_HP = 250.0       # high-pass the return at 200–300 Hz
REVERB_WET_DB = -12     # design
DOUBLE_DELAY = 0.02     # vocal doubler ~20 ms (Haas zone 1–35 ms)
DOUBLE_DETUNE = 0.005   # ADT "slight pitch shift" — ~9 cents, design
DOUBLE_DB = -6          # second voice 3–6 dB under the first
CLOSE_SHELF_HZ = 150.0  # proximity effect: low shelf a few dB at 100–200 Hz
CLOSE_SHELF_DB = 4.0
ITD_MAX = 0.00065       # max interaural time difference 0.65 ms
SWEEP_SECONDS = 10.0    # default {pan sweep} cycle: ASMR ear-to-ear movement 0.1–0.3 Hz
                        # (a cycle every 3–10 s); the slow end. {pan sweep LENGTH} overrides
LAYERED_TAKES = (('whisper', -12.0, -0.6), ('soft', -6.0, 0.6))  # (tag, dB, pan):
                        # the line in several deliveries, stacked

VOICE_FX = ('echo', 'reverb', 'double', 'close', 'layered')
PROCEDURAL_BEDS = ('ocean', 'rain', 'brown', 'pink', 'drone')   # synthesised here
BEDS = PROCEDURAL_BEDS + tuple(audio_sounds.BUNDLED_BEDS)       # + recorded ones shipped in assets
LAYERS = ('bed', 'music', 'binaural', 'isochronic', 'tick', 'heartbeat', 'room-tone')
SOUND_PEAK_DB = CHIME_PEAK_DB  # uploaded one-shot effects land where the chime does
SOUND_CUT_FADE = 0.5           # design: fade-out when a LENGTH cap cuts an effect short
DEFAULT_CUES = {2: ('Breathe in.', 'And out.'),
                3: ('Breathe in.', 'Hold.', 'And out.'),
                4: ('Breathe in.', 'Hold.', 'And out.', 'Hold.')}

MAX_PRONOUNCE = 200     # xAI `replace` map: 200 entries, keys ≤ 100, values ≤ 128 chars


# ---------------------------------------------------------------------------
# The guide — single source for the tool description and the playground
# ---------------------------------------------------------------------------

# Exactly xAI's documented TTS tag set (docs.x.ai → Text to Speech → Speech
# tags), which is also the realtime voice set session_service teaches.
# Pause lengths measured 2026-09-26; <slow> measured 184 → 154 wpm.
SPEECH_TAGS = {
    'inline': [
        ('Pauses', [
            ('[pause]', 'an extra beat of about 1 second, for a deliberate hesitation where there is '
                        'no punctuation; right after a full stop it doubles the natural pause and '
                        'sounds like dead air'),
            ('[long-pause]', 'a longer beat, about 2 seconds; stacking them adds almost nothing, so use {silence} for more'),
            ('[hum-tune]', 'a short wordless hum; the words after it are spoken normally'),
        ]),
        ('Laughter & crying', [
            ('[laugh]', 'a real laugh'),
            ('[chuckle]', 'a quiet, amused laugh'),
            ('[giggle]', 'a light, playful giggle'),
            ('[cry]', 'a tearful break in the voice'),
        ]),
        ('Mouth sounds', [
            ('[tsk]', 'a disapproving tsk'),
            ('[tongue-click]', 'a click of the tongue'),
            ('[lip-smack]', 'a smack of the lips'),
        ]),
        ('Breathing', [
            ('[breath]', 'an audible breath'),
            ('[inhale]', 'a breath in'),
            ('[exhale]', 'a breath out'),
            ('[sigh]', 'a sigh'),
        ]),
    ],
    'wrapping': [
        ('Volume & intensity', [
            ('<soft>', 'gentle and quieter'),
            ('<whisper>', 'whispered'),
            ('<loud>', 'louder, projected'),
            ('<build-intensity>', 'energy rises through the phrase'),
            ('<decrease-intensity>', 'energy falls away through the phrase'),
        ]),
        ('Pitch & speed', [
            ('<higher-pitch>', 'higher voice'),
            ('<lower-pitch>', 'lower voice'),
            ('<slow>', 'about 15% slower; with {pace 0.7} it reaches meditation pace'),
            ('<fast>', 'quicker'),
        ]),
        ('Vocal style', [
            ('<sing-song>', 'a lilting, teasing, melodic cadence'),
            ('<singing>', 'actually sung; wrap the whole lyric, line after line'),
            ('<emphasis>', 'leans on the wrapped words'),
        ]),
    ],
    'tips': [
        'Inline tags go exactly where the sound happens: "Really? [laugh] That\'s wild."',
        'Wrapping tags go around whole phrases, with a closing tag: <whisper>It\'s a secret.</whisper>',
        'Wrapping tags nest to combine: <slow><soft>Goodnight, sleep well.</soft></slow>',
        'Punctuation does most of the pacing: a full stop already pauses about half a second, commas '
        'give a lighter breath, "?" and "!" change the tune, and "..." trails off. Reach for [pause] '
        'rarely; for real space, use {silence}.',
        'Write only words that should be heard. Never narrate actions ("*giggles*"); use the tag.',
    ],
}

HOW_IT_WORKS = [
    'A script is plain text. A line that is only {braces} is a directive, which the renderer acts on. '
    'Every other line is spoken.',
    'Everything spoken between two directives is voiced in one go, which gives the most natural '
    'delivery. A blank line starts a new paragraph, and the voice takes its own natural breath there '
    f'(about half a second). A stretch over {MAX_CHUNK_CHARS:,} characters is split at a paragraph or '
    'sentence end. For a longer pause, use {silence}.',
    'The voice itself cannot hold a silence: [pause] is about 1 second and [long-pause] about 2. '
    'Real silence, timed breathing and anything that has to last a set time come from directives.',
    'Three kinds of directive. Layers ({bed}, {music}, {binaural}, {isochronic}, {tick}, '
    '{heartbeat}, {room-tone}) start at that point and keep playing underneath until changed or '
    'turned off; they never hold up the script. Speech, {silence}, {breathe}, {scatter}, {dual} '
    'and {sound} take time: the next line waits for them ({sound ... under} opts out). {chime} and '
    '{underlay} drop in at the current moment and sound under whatever comes next.',
    f'The recording opens with {HEAD:g} second of quiet and ends with a {TAIL:g}-second fade. '
    f'Beds dip {DUCK_DB} dB whenever someone speaks. The finished file is levelled to {TARGET_LUFS:g} LUFS '
    f'(the speech streaming standard) with peaks kept under {PEAK_CEILING_DB:g} dB, and saved as a stereo MP3. '
    f'The limit is {MAX_LENGTH_TEXT} and {MAX_SCRIPT_CHARS:,} characters.',
    'Cost: xAI bills text-to-speech at $15 per million characters spoken, roughly a cent per minute '
    'of speech. Directives are free. {fx layered} lines are spoken three times, each distinct breath '
    'cue once.',
]

# The value types directives share, defined once and referred to by name.
# (name, definition)
VALUE_TYPES = [
    ('LENGTH',
     'A duration: 20s, 90s, 2m, 1.5m, 1m30s, or a bare number of seconds (90). Case does not matter.'),
    ('LEVEL',
     'Optional loudness change for a layer or underlay, written after its other values: soft '
     '(6 dB quieter), medium (as designed, the default), loud (6 dB louder), or a number of dB '
     'from -24 to 12 (e.g. -3).'),
    ('BAND',
     f'A brainwave band for {{binaural}} and {{isochronic}}: delta '
     f'({BINAURAL_BANDS["delta"]:g} Hz, deep sleep), theta ({BINAURAL_BANDS["theta"]:g} Hz, deep '
     f'relaxation), alpha ({BINAURAL_BANDS["alpha"]:g} Hz, calm focus).'),
    ('OFF',
     'off, none or stop (all the same). Turns a layer off; it fades out over its fade= time.'),
    ('fade=LENGTH',
     'Optional on every layer directive, anywhere among its values: how long this change takes. '
     'It is the fade-in when a layer starts, the fade-out on OFF, and the crossfade when it '
     f'replaces the same kind of layer. Default {LAYER_FADE:g}s; fade=0 cuts instantly; up to '
     f'{MAX_SILENCE // 60} minutes, e.g. fade=2m for a slow drift.'),
]

DIRECTIVE_RULES = [
    'A directive is a line holding nothing but {name values}. Names and values are not '
    'case-sensitive. A line that isn\'t a known directive is skipped, and the result lists a warning.',
    '{voice}, {pace}, {fx} and {pan} are settings: they apply to every spoken line after them until '
    'changed, including lines inside blocks.',
    'Layers ({bed}, {binaural}, {isochronic}, {tick}, {heartbeat}, {room-tone}) keep playing from '
    'that point until changed or turned off, or until the end. Every change fades, over '
    f'{LAYER_FADE:g} seconds unless its fade= says otherwise. Each kind is one layer: a second '
    '{bed} replaces the first; a {bed} and a {binaural} play together.',
    'Blocks ({scatter}, {underlay}, {dual}) hold spoken lines, one phrase per line (blank lines are '
    'ignored). Inside a block only the settings are allowed; {silence}, {breathe}, {chime} and layer '
    'changes go outside it. Blocks do not nest, and one left open is closed at the end.',
]

# Each directive, API-style. params: (NAME, 'required' | 'optional', what it
# accepts, its default and limits). Everything here matches parse().
DIRECTIVES = [
    ('Timing', [
        {'syntax': '{silence LENGTH}',
         'what': 'Quiet for exactly that long. Layers keep playing.',
         'params': [('LENGTH', 'required',
                     f'LENGTH, up to {MAX_SILENCE // 60} minutes. Add ~ straight after it (20s~) '
                     'to make the silence elastic: see {target}.')],
         'example': '{silence 8s}\n{silence 30s~}'},
        {'syntax': '{target LENGTH}',
         'what': 'The total length of the finished recording. Only elastic silences change to hit '
                 'it: each ~ gap is stretched or squeezed by the same factor, so a 30s~ gap stays '
                 'three times as long as a 10s~ one. Anywhere in the script; the last one counts. '
                 'If the fixed content alone runs longer, the elastic gaps shrink to nothing and a '
                 'warning says so; with no elastic gaps it is ignored, with a warning.',
         'params': [('LENGTH', 'required', f'LENGTH, up to {MAX_LENGTH_TEXT} (e.g. 90m).')],
         'example': '{target 12m}'},
        {'syntax': '{breathe PATTERN ROUNDS quiet cues=WORDS}',
         'what': 'Timed breathing on an exact clock. A soft spoken cue starts each phase (in the '
                 'current voice, pace and pan) and any bed swells up to 4 dB on the in-breath, holds, '
                 'and falls on the out-breath. Takes pattern total × rounds.',
         'params': [('PATTERN', 'required',
                     'Seconds per phase joined by dashes, each up to 20: two numbers = in, out; '
                     'three = in, hold, out; four = in, hold, out, hold (box breathing). Decimals '
                     'work (4.5-6).'),
                    ('ROUNDS', 'optional', 'x and a count, x1 to x30. Default x4.'),
                    ('quiet', 'optional', 'No spoken cues; only the bed swell marks the rhythm.'),
                    ('cues=WORDS', 'optional',
                     'Your own cue words, one per phase separated by |, in any language. Must come '
                     'last. Default: Breathe in. | Hold. | And out. | Hold.')],
         'example': '{breathe 4-7-8}\n{breathe 4-4-4-4 x6 quiet}\n{breathe 2-1-6 x5 cues=In|A little more|All the way out}'},
    ]),
    ('Voice settings', [
        {'syntax': '{voice ID}',
         'what': 'The speaker for every line after it. Starts as the recording\'s own voice.',
         'params': [('ID', 'required', 'Any xAI voice (eve, ara, rex, sal, leo, …) or a custom voice id.')],
         'example': '{voice rex}'},
        {'syntax': '{pace SPEED}',
         'what': 'Speaking speed for every line after it. At 1.0 a voice runs about 180 words a '
                 'minute; 0.8 with <slow> suits meditation.',
         'params': [('SPEED', 'required', 'A number from 0.7 to 1.5. Starts at the recording\'s base pace.')],
         'example': '{pace 0.8}'},
        {'syntax': '{fx EFFECTS}',
         'what': 'Voice effects for every line after it. Each {fx} replaces the previous set; list '
                 'several to combine them. Spoken breathing cues never get effects.',
         'params': [('EFFECTS', 'required',
                     'One or more of: echo (the line repeats every 0.4 s, about five times, fading, '
                     'alternating right and left ear); reverb (a dreamy 2.4-second hall); double '
                     '(two slightly detuned copies 20 ms behind, spread wide: a thicker, otherworldly '
                     'voice); close (warm bass lift, as if right by your ear: ASMR); layered (the '
                     'line is also whispered in the left ear and spoken softly in the right, all at '
                     'once; costs three times as much). Or none to clear them.')],
         'example': '{fx close}\n{fx echo reverb}\n{fx none}'},
        {'syntax': '{pan POSITION}  or  {pan sweep LENGTH}',
         'what': 'Where the voice sits between the ears, for every line after it. Starts centred. '
                 '{underlay} and {dual} place their own lines and ignore it.',
         'params': [('POSITION', 'required',
                     'left, right, center (or centre), a number from -1 (left) to 1 (right), or '
                     'sweep (the voice swings between the ears).'),
                    ('LENGTH', 'optional',
                     f'After sweep only: LENGTH of one full cycle, left to right and back, 2s to '
                     f'2m. Default {SWEEP_SECONDS:g}s; 4s feels like circling close by, 30s a slow '
                     'drift.')],
         'example': '{pan sweep}\n{pan sweep 4s}\n{pan -0.5}'},
        {'syntax': '{pronounce WORD = SAY-AS}',
         'what': 'Fixes how a word or name is said, everywhere in the script (position does not '
                 'matter). Matching ignores case and only hits whole words.',
         'params': [('WORD', 'required', 'The word as written: letters, digits, apostrophes and spaces, up to 100 characters.'),
                    ('SAY-AS', 'required', 'A respelling, or IPA between slashes, up to 128 characters. Up to 200 per script.')],
         'example': '{pronounce Rexclaw = Rex claw}\n{pronounce Siobhan = /ʃɪˈvɔːn/}'},
    ]),
    ('Blocks', [
        {'syntax': '{scatter LENGTH} … {/scatter}',
         'what': 'Spreads its lines across the window: the window is split evenly, one slot per '
                 'line, and each line starts at a loose, natural point in its slot. Time then moves '
                 'on by the window (or by the lines\' own length, if longer). For sparse whispers in '
                 'a long quiet stretch.',
         'params': [('LENGTH', 'required', f'LENGTH of the window, up to {MAX_SILENCE // 60} minutes.')],
         'example': '{scatter 3m}\n<whisper>Just the waves.</whisper>\n<whisper>Drifting.</whisper>\n{/scatter}'},
        {'syntax': '{underlay LENGTH LEVEL} … {/underlay}',
         'what': f'Plays its lines quietly UNDER whatever comes next: {abs(UNDERLAY_DB):g} dB below '
                 'the voice, alternating left and right ear, spread evenly across the window. Time does '
                 'not move on, so write the main speech after the block.',
         'params': [('LENGTH', 'required', f'LENGTH of the window, up to {MAX_SILENCE // 60} minutes.'),
                    ('LEVEL', 'optional', f'LEVEL, relative to the {abs(UNDERLAY_DB):g} dB below. soft = 6 dB quieter still.')],
         'example': '{underlay 90s}\n<whisper>Calm.</whisper>\n<whisper>Safe and steady.</whisper>\n{/underlay}\nThe main speech plays over them.'},
        {'syntax': '{dual VOICE} … {/dual}',
         'what': 'Dual induction: two scripts at once, one in each ear. Lines starting L: go to the '
                 'left ear, R: to the right; a line with neither goes left. Each side plays its lines '
                 'back to back from the start of the block, and time moves on by the longer side. '
                 'Needs headphones.',
         'params': [('VOICE', 'optional', 'The right ear\'s voice. Default: the current voice (left always uses it).')],
         'example': '{dual ara}\nL: Let your eyes close.\nR: Notice how heavy your hands feel.\n{/dual}'},
    ]),
    ('Soundscape layers', [
        {'syntax': '{bed TYPE LEVEL fade=LENGTH}',
         'what': f'A background bed. It dips {DUCK_DB} dB whenever someone speaks, and swells with '
                 '{breathe}.',
         'params': [('TYPE', 'required',
                     'Synthesised: ocean (slow wave swells), rain (soft rain with droplets), brown '
                     '(deep, warm rumble), pink (even, gentle hiss), drone (a warm low chord that '
                     'slowly beats). Recorded: '
                     + '; '.join(f'{name} ({desc})'
                                 for name, (_f, _k, desc) in audio_sounds.BUNDLED_BEDS.items())
                     + '. Or the name of an uploaded bed (see Your sounds), or OFF. Recorded beds '
                     'and uploads loop from their start; uploads add their own default level.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{bed ocean}\n{bed heartbeat-drone soft fade=10s}\n{bed off fade=30s}'},
        {'syntax': '{music NAME LEVEL fade=LENGTH}',
         'what': 'Plays a music track, looping seamlessly, from its start. A layer of its own, so '
                 'it plays alongside a {bed}: music on top, a low bed underneath. Dips under '
                 'speech like a bed, but doesn\'t swell with {breathe}.',
         'params': [('NAME', 'required',
                     'Recorded: '
                     + '; '.join(f'{name} ({desc})'
                                 for name, (_f, _k, desc) in audio_sounds.BUNDLED_MUSIC.items())
                     + '. Or the name of an uploaded music track (see Your sounds), or OFF.'),
                    ('LEVEL', 'optional', 'LEVEL, on top of an upload\'s own default level.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{music space-pad soft fade=8s}\n{music off fade=15s}'},
        {'syntax': '{binaural BAND to BAND LENGTH LEVEL fade=LENGTH}',
         'what': f'Binaural beat: a {BINAURAL_CARRIER:g} Hz tone in the left ear and a slightly '
                 'higher one in the right, which the brain hears as a slow beat. Very quiet by '
                 'design, about 30 dB under the voice. Needs headphones.',
         'params': [('BAND', 'required', 'BAND, or OFF.'),
                    ('to BAND LENGTH', 'optional',
                     'Glide from the first band to this one over LENGTH, starting here, then hold '
                     'it. Both BAND and LENGTH are needed.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{binaural theta}\n{binaural alpha to theta 4m}\n{binaural off fade=20s}'},
        {'syntax': '{isochronic BAND to BAND LENGTH LEVEL fade=LENGTH}',
         'what': f'A {BINAURAL_CARRIER:g} Hz tone pulsing gently at the band\'s rate. Works on '
                 'speakers too.',
         'params': [('BAND', 'required', 'BAND, or OFF.'),
                    ('to BAND LENGTH', 'optional', 'Glide, as for {binaural}. Not the same as '
                     'fade=, which only fades the layer\'s volume.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{isochronic alpha}\n{isochronic alpha soft}\n{isochronic off}'},
        {'syntax': '{tick BPM LEVEL fade=LENGTH}',
         'what': 'A wooden metronome click, swinging ear to ear like a pendulum. 60 is the classic '
                 'hypnosis tempo.',
         'params': [('BPM', 'required', 'Beats per minute, 20 to 160, or OFF.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{tick 60}\n{tick 60 soft}\n{tick off fade=0}'},
        {'syntax': '{heartbeat BPM LEVEL fade=LENGTH}',
         'what': 'A low lub-dub heartbeat.',
         'params': [('BPM', 'required', 'Beats per minute, 20 to 160, or OFF.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{heartbeat 55}\n{heartbeat off}'},
        {'syntax': '{room-tone on LEVEL fade=LENGTH}',
         'what': 'A very faint, steady hiss under everything, like the air of a real room, so the '
                 'quiet moments never drop to total digital silence (an audiobook convention). '
                 'Recommended at the top of long, quiet pieces (meditation, sleep, hypnosis-style), '
                 'where it fills the silences. Leave it off for short voice notes, where it can '
                 'sound like static on headphones.',
         'params': [('on', 'required', 'on, or OFF. A LEVEL alone also turns it on.'),
                    ('LEVEL', 'optional', 'LEVEL.'),
                    ('fade=LENGTH', 'optional', f'fade=LENGTH. Default {LAYER_FADE:g}s.')],
         'example': '{room-tone on}\n{room-tone soft}\n{room-tone off}'},
    ]),
    ('Sounds', [
        {'syntax': '{chime}',
         'what': 'A singing-bowl strike that rings for about 7 seconds. Unlike {sound}, it does not '
                 'wait: it rings under whatever follows, because a voice usually starts as the bell '
                 'fades. Add a {silence} to let it ring out alone. Traditional at the start and end '
                 'of a meditation, but not at the end of a sleep piece.',
         'params': [],
         'example': '{chime}\n{silence 4s}'},
        {'syntax': '{sound NAME LENGTH under LEVEL}', 'needs': 'sound',
         'what': 'Plays one of the uploaded sound effects once. The script waits for it to finish '
                 'before the next line, like speech, so it is heard on its own (each one\'s length '
                 'is listed under Your sounds). Short accents such as a snap or a knock usually '
                 'stand alone; add under for a longer texture to talk over.',
         'params': [('NAME', 'required', 'The name of an uploaded sound effect (see Your sounds).'),
                    ('LENGTH', 'optional',
                     f'LENGTH with a unit (5s, 1m): play at most this long, fading out over '
                     f'{SOUND_CUT_FADE:g}s; the script then waits only that long. Default: the whole '
                     'sound.'),
                    ('under', 'optional',
                     'Don\'t wait: the sound plays beneath whatever comes next.'),
                    ('LEVEL', 'optional',
                     'LEVEL, on top of the sound\'s own default level. A bare number is a level, '
                     'which is why LENGTH needs its unit here.')],
         'example': '{sound thunder}\n<soft>That storm is still far away.</soft>\n'
                    '{sound rain-stick 5s under}\n<soft>Listen to it trickle past.</soft>'},
    ]),
]

# The default writing rules. Settings can replace them wholesale
# (config.recording_rules): users bring their own style for recordings.
WRITING_TIPS = [
    'Pace: a normal voice is far too quick for relaxation. Guided meditations average 50 to 80 words '
    'a minute once the silences are counted. Use {pace 0.8}, <slow>, <soft>, and real {silence}.',
    'Promised length: put {target} at the top and make the gaps between sections elastic (~). '
    'Bigger numbers for longer settling moments.',
    'Hypnosis-style pacing: a 2 to 3-second pause after a suggestion, 5 to 8 before an important '
    'one or between phases, 10 to 15 to deepen, and slow the voice down as the piece goes on. '
    'Unless the piece is for falling asleep, close with a count-up from 1 to 5 back to wide awake.',
    'Sleep pieces never wake the listener: no count-up and no ending chime. Let them trail off into '
    'scattered whispers and silence.',
    'Short voice notes need no directives. Just write the lines with tags, like a real voicemail.',
    'Headphones matter for binaural beats, {dual}, {pan} and {fx layered}. Say so at the start.',
]

# Two examples: a voice note, to show that short pieces need nothing but
# tagged lines, and a full session whose every tool does a job at a natural
# moment (arrival → breathing → a chime-marked crossfade into the trance
# bed → deepener → layered suggestion → crossfade back → count-up).
EXAMPLE_NOTE = """\
Hey, it's me. You didn't pick up, so you get a voice message instead. [giggle]

<whisper>I was thinking about you.</whisper> Call me back when you're free, okay?
"""

# Every gap below is deliberate (hypnosis pacing: 2-3 s after a suggestion,
# 5-8 s before a key one or between phases, 10-15 s to deepen, slowing as
# it deepens; the count-up quickens). The soundtrack moves with the phases:
# space-pad music over ocean for the arrival, both handed over at a chime to
# heartbeat-drone alone for the trance, then ocean with cosmic-glow's gentle
# rhythm to lift the listener back up. The advanced voice effects each do a
# job: reverb then {fx layered} on the deepest numbers, a short
# {dual} overload deepener introduced first, a close {pan sweep} whisper,
# echo on the one key suggestion. No {tick} over heartbeat-drone: its own
# 60 bpm pulse is the metronome, and two unsynced pulses flam. No binaural:
# its effects build past ~9 minutes of exposure (Garcia-Argibay 2019), longer
# than this piece. The ending leaves room for the last chime to ring out.
EXAMPLE_SCRIPT = """\
{target 6m}
{room-tone on}
{bed ocean soft}
{music space-pad soft fade=8s}
{chime}
{silence 5s}
{pace 0.9}
<soft>Hey, you. I'm glad you're here. Find somewhere comfortable, where you can let go for a few minutes, and if you have headphones, put them on.</soft>
{silence 3s}
<soft>Let your eyes close whenever they're ready. There's nothing you need to do right now, except listen to my voice.</soft>
{silence 5s}
<soft>Let's slow your breathing down together. In through your nose for four, and out through your mouth for six. I'll guide you.</soft>
{silence 2s}
{breathe 4-6 x4}
{silence 6s~}
{pace 0.85}
<soft><slow>Good. Now let your breath find its own rhythm, and notice how your body feels.</slow></soft>
{silence 3s}
<soft><slow>Let your forehead smooth out. Let your jaw loosen.</slow></soft>
{silence 3s}
<soft><slow>Let your shoulders drop, a little further than you think they can.</slow></soft>
{silence 3s}
<soft><slow>And let your hands grow heavy and warm.</slow></soft>
{silence 8s~}
{chime}
{music off fade=15s}
{bed heartbeat-drone fade=15s}
{pace 0.8}
<soft><slow>Can you hear that slow heartbeat underneath? Let it set your pace. In a moment I'll count down from five, and with each number, you'll sink a little deeper.</slow></soft>
{silence 5s}
<soft><slow>Five. Heavier.</slow></soft>
{silence 4s}
<soft><slow>Four. Softer.</slow></soft>
{silence 5s}
{fx reverb}
<soft><slow>Three. Deeper still.</slow></soft>
{silence 6s}
{fx layered}
<whisper><slow>Two.</slow></whisper>
{silence 7s}
<whisper><slow>One. All the way down.</slow></whisper>
{fx none}
{silence 6s}
<soft><slow>Now there are two of me, one in each ear. You don't need to follow either. Just let the words wash over you.</slow></soft>
{silence 3s}
{dual}
L: <soft><slow>Drifting down, heavier with every breath.</slow></soft>
R: <soft><slow>Every word you miss takes you deeper.</slow></soft>
L: <soft><slow>Nothing to follow, nothing to hold.</slow></soft>
R: <soft><slow>Sinking into that slow heartbeat.</slow></soft>
L: <whisper><slow>Deeper.</slow></whisper>
R: <whisper><slow>Down.</slow></whisper>
{/dual}
{silence 12s~}
{underlay 40s}
<whisper>Calm.</whisper>
<whisper>Safe with me.</whisper>
<whisper>Let go.</whisper>
{/underlay}
<soft><slow>Here, there's nothing you need to hold on to. Every breath out carries a little more of the day away.</slow></soft>
{silence 3s}
<soft><slow>Your mind is quiet. Your body is heavy, and safe.</slow></soft>
{silence 3s}
{fx close}
{pan sweep 8s}
<whisper><slow>Let it all drift away.</slow></whisper>
{fx none}
{pan center}
{silence 6s}
{fx echo}
<soft><slow>You're allowed to rest.</slow></soft>
{fx none}
{silence 12s~}
{chime}
{bed ocean soft fade=10s}
{music cosmic-glow soft fade=10s}
{pace 0.9}
<soft>In a moment, I'll count from one to five. On five, you'll open your eyes, clear and rested, and bring this calm with you.</soft>
{silence 3s}
<soft>One. Feeling the weight of your body again.</soft>
{silence 2s}
<soft>Two. Wriggle your fingers and toes.</soft>
{silence 2s}
{pace 1.0}
Three. A deeper breath. [inhale]
{silence 2s}
Four. Clear, and awake.
{silence 1s}
Five. Eyes open. [chuckle] <soft>Welcome back.</soft>
{silence 2s}
{chime}
{music off fade=6s}
{bed off fade=6s}
{silence 4s}
"""


# docs.x.ai → Text to Speech → Languages: the 20 supported codes plus auto.
# Codes are case-insensitive at the API; these are the documented spellings.
# Not an allow-list: the docs add that the model "is also capable of
# generating speech in additional languages ... with varying degrees of
# accuracy", and an unlisted code is accepted (`nl` → 200 and correct
# Dutch, tested 2026-09-26).
TTS_LANGUAGES = [
    ('auto', 'Auto-detect'), ('en', 'English'), ('ar-EG', 'Arabic (Egypt)'),
    ('ar-SA', 'Arabic (Saudi Arabia)'), ('ar-AE', 'Arabic (United Arab Emirates)'),
    ('bn', 'Bengali'), ('zh', 'Chinese (Simplified)'), ('fr', 'French'), ('de', 'German'),
    ('hi', 'Hindi'), ('id', 'Indonesian'), ('it', 'Italian'), ('ja', 'Japanese'),
    ('ko', 'Korean'), ('pt-BR', 'Portuguese (Brazil)'), ('pt-PT', 'Portuguese (Portugal)'),
    ('ru', 'Russian'), ('es-MX', 'Spanish (Mexico)'), ('es-ES', 'Spanish (Spain)'),
    ('tr', 'Turkish'), ('vi', 'Vietnamese'),
]
LANGUAGE_CODES = [code for code, _name in TTS_LANGUAGES]


_LANGUAGE_TAG = re.compile(r'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$')


def normalize_language(code):
    """A documented code in its documented spelling, any other well-formed
    BCP-47 tag as given, or None for something that isn't a language code."""
    wanted = (code or '').strip()
    listed = next((c for c in LANGUAGE_CODES if c.lower() == wanted.lower()), None)
    return listed or (wanted if _LANGUAGE_TAG.match(wanted) else None)


def default_rules_text():
    return '\n'.join(f'- {tip}' for tip in WRITING_TIPS)


def rules_text(config):
    """The writing rules in force: the user's override, else the defaults."""
    custom = (config['recording_rules'] or '').strip()
    return custom or default_rules_text()


def _sound_list(sounds):
    """The user's uploads for the guide: what to call each one and what it is."""
    use = {'bed': '{bed %s}', 'music': '{music %s}', 'sound': '{sound %s}'}
    return [{'name': s['name'], 'kind': s['kind'], 'use': use[s['kind']] % s['name'],
             'description': s['description'], 'duration': s['duration_seconds'],
             # A one-shot's length is what its {silence} has to cover; beds
             # and music loop, so theirs doesn't matter.
             'length': f'{s["duration_seconds"]:g} s' if s['kind'] == 'sound' else ''}
            for s in (sounds or {}).values()]


def guide(config, sounds=None):
    """The whole guide as data, for the playground's Full guide panel."""
    return {
        'how_it_works': HOW_IT_WORKS,
        'tags': SPEECH_TAGS,
        'value_types': VALUE_TYPES,
        'directive_rules': DIRECTIVE_RULES,
        'directives': DIRECTIVES + plugins.directive_guides(),
        'sounds': _sound_list(sounds),
        'rules_default': default_rules_text(),
        'rules_custom': (config['recording_rules'] or '').strip() or None,
        'example_note': EXAMPLE_NOTE,
        'example': EXAMPLE_SCRIPT,
    }


def guide_text(rules=None, sounds=None, agent=None):
    """The same guide as plain text, for the create_voicemail description.
    `rules` replaces the default writing rules (the user's override);
    `sounds` lists the user's uploads. {music} / {sound} are left out while
    there is nothing of that kind to call, so they cost no context. `agent`
    limits extension directives to the ones that companion has switched on."""
    listed = _sound_list(sounds)
    kinds = {s['kind'] for s in listed}
    out = ['HOW A SCRIPT WORKS']
    out += [f'- {p}' for p in HOW_IT_WORKS]
    out += ['', 'SPEECH TAGS (inside spoken lines; this is the complete list)',
            'Inline, placed where the sound happens:']
    for group, tags in SPEECH_TAGS['inline']:
        out.append(f'  {group}: ' + '; '.join(f'{t} {d}' for t, d in tags))
    out.append('Wrapping, around whole phrases with a closing tag:')
    for group, tags in SPEECH_TAGS['wrapping']:
        out.append(f'  {group}: ' + '; '.join(f'{t} {d}' for t, d in tags))
    out += [f'- {t}' for t in SPEECH_TAGS['tips']]
    out += ['', 'DIRECTIVES']
    out += [f'- {r}' for r in DIRECTIVE_RULES]
    out.append('Values used below (UPPERCASE words are values you fill in):')
    out += [f'  {name}: {definition}' for name, definition in VALUE_TYPES]
    for section, entries in DIRECTIVES + plugins.directive_guides(agent):
        out += ['', f'{section}:']
        for d in entries:
            if d.get('needs') and d['needs'] not in kinds:
                continue
            out.append(d['syntax'])
            out.append(f'  {d["what"]}')
            for name, need, spec in d['params']:
                out.append(f'  {name} ({need}): {spec}')
            out.append('  Example: ' + d['example'].replace('\n', ' / '))
    if listed:
        out += ['', 'YOUR SOUNDS (uploaded by the user; call them exactly like this)']
        for s in listed:
            length = f' ({s["length"]})' if s['length'] else ''
            out.append(f'  {s["use"]}{length}: {s["description"] or "(no description)"}')
    out += ['', 'WRITING RULES', (rules or default_rules_text()).strip()]
    out += ['', 'EXAMPLE 1: a voice note (short pieces need no directives)', EXAMPLE_NOTE.rstrip()]
    out += ['', 'EXAMPLE 2: a six-minute hypnosis-style session (arrival with music over a '
                'bed, breathing, a chime-marked crossfade into the trance bed, countdown with '
                'reverb and layered '
                'voices, a dual-induction deepener, suggestions with underlay, a close sweeping '
                'whisper and one echoed key phrase, crossfade to wake-up music, count-up). Every gap follows '
                'the hypnosis pacing rules.', EXAMPLE_SCRIPT.rstrip()]
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_DIRECTIVE = re.compile(r'^\{\s*(/?[a-z][a-z-]*)\s*(.*?)\s*\}$', re.I)
# Directive names parse() handles itself; an extension can't take these.
_BUILT_IN = {'scatter', 'underlay', 'dual', 'target', 'silence', 'voice', 'pronounce', 'pace',
             'fx', 'pan', 'breathe', 'chime', 'sound', *LAYERS}
_DURATION = re.compile(r'^(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$', re.I)
_SENTENCE_END = re.compile(r'(?<=[.!?…])\s+')


def _seconds(text):
    """'30s' / '2m' / '1m30s' / '90' → seconds, or None."""
    text = (text or '').strip().lower()
    if re.fullmatch(r'\d+(?:\.\d+)?', text):
        return float(text)
    m = _DURATION.match(text)
    if not m or not (m[1] or m[2]):
        return None
    return float(m[1] or 0) * 60 + float(m[2] or 0)


def _level(tokens, warnings, where):
    """Optional level word / dB offset among directive tokens."""
    for tok in tokens:
        if tok in LEVEL_WORDS:
            return LEVEL_WORDS[tok]
        try:
            return max(-24.0, min(12.0, float(tok)))
        except ValueError:
            warnings.append(f'{where}: ignored "{tok}"')
    return 0.0


def _split_long(paragraphs):
    """Paragraphs → request-sized chunks. Paragraphs stay together in one
    request, blank line kept ("paragraph breaks create natural pauses",
    xAI's TTS best practices; ~0.6 s measured, where separate requests plus
    a fixed gap read as dead air). A chunk closes at MAX_CHUNK_CHARS, at a
    paragraph break when possible, else at a sentence end."""
    pieces = []  # (text, separator before it)
    for p in paragraphs:
        sentences = _SENTENCE_END.split(p) if len(p) > MAX_CHUNK_CHARS else [p]
        pieces += [(s, '\n\n' if i == 0 else ' ') for i, s in enumerate(sentences)]
    chunks, cur = [], ''
    for text, sep in pieces:
        if cur and len(cur) + len(sep) + len(text) > MAX_CHUNK_CHARS:
            chunks.append(cur)
            cur = text
        else:
            cur = f'{cur}{sep}{text}' if cur else text
    if cur:
        chunks.append(cur)
    return chunks


def parse(script, *, voice, pace=1.0, sounds=None):
    """Script text → (events, target_seconds, pronunciations, warnings).
    Pure — no I/O. `sounds` is the user's library (audio_sounds.catalog),
    name → row, so {bed}, {music} and {sound} can name uploads."""
    sounds = sounds or {}

    def own(kind):
        return sorted(n for n, r in sounds.items() if r['kind'] == kind)

    def wrong_kind(name, wanted):
        """Warning text for a name that isn't an uploaded `wanted` sound."""
        kind = (sounds[name]['kind'] if name in sounds
                else audio_sounds.BUNDLED[name][1] if name in audio_sounds.BUNDLED else None)
        if kind:
            use = {'bed': '{bed %s}', 'music': '{music %s}', 'sound': '{sound %s}'}[kind]
            return f'"{name}" is a {kind}: use {use % name}'
        names = own(wanted)
        return (f'no uploaded {wanted} called "{name}"'
                + (f' (yours: {", ".join(names)})' if names else ' (none uploaded yet)'))

    warnings = []
    events = []
    target = None
    pronounce = {}
    state = {'voice': voice, 'speed': pace, 'fx': (), 'pan': 0.0, 'sweep': SWEEP_SECONDS}
    para = []
    block = None  # open scatter / underlay / dual

    def line_event(text):
        return {'t': 'say', 'text': text, **state}

    # `para` holds the speech since the last directive: a list of
    # paragraphs, each a list of lines. A blank line opens a new paragraph
    # but stays in the same request; only a directive (or the end) flushes.
    def flush():
        if para:
            paragraphs = [' '.join(lines) for lines in para if lines]
            para.clear()
            for chunk in _split_long(paragraphs):
                events.append(line_event(chunk))

    for n, raw in enumerate((script or '').splitlines(), 1):
        line = raw.strip()
        m = _DIRECTIVE.match(line)
        if not m:
            if block:
                if not line:
                    continue
                if block['t'] == 'dual':
                    side = 'left'
                    if re.match(r'^[lr]\s*:', line, re.I):
                        side = 'left' if line[0] in 'lL' else 'right'
                        line = line.split(':', 1)[1].strip()
                    ev = line_event(line)
                    if side == 'right':
                        ev['voice'] = block['voice'] or state['voice']
                    block[side].append(ev)
                else:
                    block['lines'].append(line_event(line))
            elif line:
                if not para or para[-1] is None:
                    if para:
                        para.pop()
                    para.append([])
                para[-1].append(line)
            elif para and para[-1] is not None:
                para.append(None)  # blank line: the next line starts a paragraph
            continue

        flush()
        cmd, arg = m[1].lower(), m[2].strip()
        tokens = arg.lower().split()
        where = f'line {n} {{{cmd}}}'
        if cmd.startswith('/'):
            if block and cmd[1:] == block['t']:
                events.append(block)
                block = None
            else:
                warnings.append(f'{where}: no open block to close')
            continue
        extension = None if cmd in _BUILT_IN else plugins.directive(cmd)
        if block and (cmd in ('silence', 'breathe', 'chime', 'sound', *LAYERS) or extension):
            warnings.append(f'{where}: not allowed inside {{{block["t"]}}}; move it outside the block')
            continue
        if cmd in ('scatter', 'underlay', 'dual'):
            if block:
                warnings.append(f'{where}: blocks do not nest — closed the open {block["t"]}')
                events.append(block)
            if cmd == 'dual':
                block = {'t': 'dual', 'voice': arg.split()[0] if arg else None,
                         'left': [], 'right': []}
            else:
                secs = _seconds(tokens[0]) if tokens else None
                if not secs:
                    warnings.append(f'{where}: needs a length like 2m — using 60s')
                    secs = 60.0
                level = UNDERLAY_DB if cmd == 'underlay' else 0.0
                if cmd == 'underlay' and len(tokens) > 1:
                    level += _level(tokens[1:], warnings, where)
                elif len(tokens) > 1:
                    warnings.append(f'{where}: ignored "{" ".join(tokens[1:])}" (scatter takes only a length)')
                block = {'t': cmd, 'sec': min(secs, MAX_SILENCE), 'level': level, 'lines': []}
            continue
        if cmd == 'target':
            target = _seconds(arg)
            if target is None:
                warnings.append(f'{where}: could not read the length')
            else:
                target = min(target, MAX_SECONDS)
        elif cmd == 'silence':
            elastic = arg.endswith('~')
            secs = _seconds(arg.rstrip('~'))
            if secs is None:
                warnings.append(f'{where}: could not read the length')
                continue
            events.append({'t': 'silence', 'sec': min(secs, MAX_SILENCE), 'elastic': elastic})
        elif cmd == 'voice':
            if arg:
                state['voice'] = arg.split()[0]
        elif cmd == 'pronounce':
            word, _, said = (s.strip() for s in arg.partition('='))
            if not word or not said:
                warnings.append(f'{where}: write it as {{pronounce word = respelling}}')
            elif not re.fullmatch(r"[^\W_]+(?:[ '][^\W_]+)*'?", word) or len(word) > 100:
                warnings.append(f'{where}: the word may only hold letters, digits, apostrophes and spaces')
            elif len(said) > 128:
                warnings.append(f'{where}: the respelling is over 128 characters')
            elif len(pronounce) >= MAX_PRONOUNCE:
                warnings.append(f'{where}: over {MAX_PRONOUNCE} pronunciations, skipped')
            else:
                pronounce[word] = said
        elif cmd == 'pace':
            try:
                state['speed'] = max(0.7, min(1.5, float(arg)))
            except ValueError:
                warnings.append(f'{where}: pace is a number 0.7–1.5')
        elif cmd == 'fx':
            fx = tuple(t for t in tokens if t in VOICE_FX)
            unknown = [t for t in tokens if t not in VOICE_FX and t != 'none']
            if unknown:
                warnings.append(f'{where}: unknown effect(s) {", ".join(unknown)}')
            state['fx'] = fx
        elif cmd == 'pan':
            word = tokens[0] if tokens else 'center'
            pans = {'left': -1.0, 'right': 1.0, 'center': 0.0, 'centre': 0.0, 'sweep': 'sweep'}
            if word in pans:
                state['pan'] = pans[word]
                if word == 'sweep':
                    cycle = _seconds(tokens[1]) if len(tokens) > 1 else SWEEP_SECONDS
                    if cycle is None:
                        warnings.append(f'{where}: could not read the cycle length, using '
                                        f'{SWEEP_SECONDS:g}s')
                        cycle = SWEEP_SECONDS
                    state['sweep'] = max(2.0, min(120.0, cycle))
            else:
                try:
                    state['pan'] = max(-1.0, min(1.0, float(word)))
                except ValueError:
                    warnings.append(f'{where}: pan is left, right, center, sweep or -1..1')
        elif cmd == 'breathe':
            parts = re.findall(r'\d+(?:\.\d+)?', tokens[0]) if tokens else []
            phases = [min(20.0, float(p)) for p in parts][:4]
            if len(phases) < 2:
                warnings.append(f'{where}: needs a pattern like 4-7-8')
                continue
            reps = next((int(t[1:]) for t in tokens[1:] if re.fullmatch(r'x\d+', t)), 4)
            cues = None if 'quiet' in tokens else list(DEFAULT_CUES[len(phases)])
            cm = re.search(r'cues=(.+)$', arg, re.I)
            if cm:
                custom = [c.strip() for c in cm[1].split('|')]
                cues = (custom + cues[len(custom):] if cues else custom)[:len(phases)]
            events.append({'t': 'breathe', 'phases': phases, 'reps': max(1, min(30, reps)),
                           'cues': cues, **state, 'fx': ()})
        elif cmd in LAYERS:
            # fade=LENGTH may sit anywhere among the values: how long this
            # change takes (fade-in, fade-out, or crossfade into it).
            fade = LAYER_FADE
            for tok in [t for t in tokens if t.startswith('fade=')]:
                tokens.remove(tok)
                secs = _seconds(tok[5:])
                if secs is None:
                    warnings.append(f'{where}: could not read "{tok}", using {LAYER_FADE:g}s')
                else:
                    fade = min(secs, MAX_SILENCE)
            value = tokens[0] if tokens else 'off'
            rest = tokens[1:]
            if value in ('off', 'none', 'stop'):
                events.append({'t': 'layer', 'layer': cmd, 'value': None, 'fade': fade})
                continue
            params = {}
            level_offset = 0.0
            if cmd == 'bed':
                if value not in BEDS:
                    if sounds.get(value, {}).get('kind') != 'bed':
                        warnings.append(f'{where}: beds are {", ".join(BEDS)}, or your own: '
                                        + wrong_kind(value, 'bed'))
                        continue
                    level_offset = sounds[value]['level']
            elif cmd == 'music':
                if value not in audio_sounds.BUNDLED_MUSIC:
                    if sounds.get(value, {}).get('kind') != 'music':
                        warnings.append(f'{where}: recorded music is '
                                        f'{", ".join(audio_sounds.BUNDLED_MUSIC)}, or your own: '
                                        + wrong_kind(value, 'music'))
                        continue
                    level_offset = sounds[value]['level']
            elif cmd == 'room-tone':
                if value != 'on':        # {room-tone soft} = on, at that level
                    rest = tokens
                value = 'on'
            elif cmd in ('binaural', 'isochronic'):
                if value not in BINAURAL_BANDS:
                    warnings.append(f'{where}: bands are {", ".join(BINAURAL_BANDS)}')
                    continue
                params['hz'] = BINAURAL_BANDS[value]
                if len(rest) >= 3 and rest[0] == 'to' and rest[1] in BINAURAL_BANDS:
                    params['to_hz'] = BINAURAL_BANDS[rest[1]]
                    params['ramp'] = _seconds(rest[2]) or 60.0
                    rest = rest[3:]
            else:  # tick / heartbeat
                try:
                    params['bpm'] = max(20.0, min(160.0, float(value)))
                except ValueError:
                    warnings.append(f'{where}: needs beats per minute, e.g. 60')
                    continue
            events.append({'t': 'layer', 'layer': cmd, 'value': value, 'fade': fade,
                           'level': level_offset + _level(rest, warnings, where), **params})
        elif cmd == 'chime':
            events.append({'t': 'chime'})
        elif cmd == 'sound':
            name = tokens[0] if tokens else ''
            if sounds.get(name, {}).get('kind') != 'sound':
                warnings.append(f'{where}: ' + wrong_kind(name, 'sound'))
                continue
            # under = don't wait; LENGTH (with a unit, so a bare number stays
            # a level) caps how long it plays; anything else is the level.
            under, cap, rest = False, None, []
            for tok in tokens[1:]:
                if tok == 'under':
                    under = True
                elif re.search(r'[a-z]', tok) and _seconds(tok):
                    cap = min(_seconds(tok), MAX_SILENCE)
                else:
                    rest.append(tok)
            events.append({'t': 'sound', 'name': name, 'under': under, 'cap': cap,
                           'level': sounds[name]['level'] + _level(rest, warnings, where)})
        elif extension:
            # An extension's directive (plugins.py): it reads its own
            # arguments and its data rides the timeline as a mark.
            plugin_id, read = extension
            try:
                data = read(arg, warnings, where)
            except Exception as e:
                _logger.exception('extension %s: {%s} parse failed', plugin_id, cmd)
                warnings.append(f'{where}: {e}')
                continue
            if data is not None:
                events.append({'t': 'mark', 'directive': cmd, 'data': data})
        else:
            warnings.append(f'{where}: unknown directive, skipped')
    flush()
    if block:
        warnings.append(f'{{{block["t"]}}} was never closed — closed at the end')
        events.append(block)
    return events, target, pronounce, warnings


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

def _tts(config, text, voice, speed, language, pronounce=None):
    """One xAI TTS call → trimmed mono float32 at SR."""
    url = config['xai_tts_url'] or 'https://api.x.ai/v1/tts'
    headers = {'Authorization': f'Bearer {config["xai_api_key"]}',
               'Content-Type': 'application/json'}
    payload = {'text': text, 'voice_id': voice, 'language': language or 'auto',
               'speed': speed, 'output_format': {'codec': 'wav', 'sample_rate': SR}}
    if pronounce:
        payload['replace'] = pronounce
    # _post_with_retry covers 5xx; the docs also list 429 as retryable.
    for backoff in (1.0, 2.0, 4.0, None):
        resp = xai_client._post_with_retry(url, headers, payload, timeout=180)
        if resp.status_code != 429 or backoff is None:
            break
        time.sleep(backoff)
    if resp.status_code != 200:
        detail = (resp.text or '')[:300]
        raise UserError(f'TTS failed ({resp.status_code}) for voice "{voice}": {detail}')
    with wave.open(io.BytesIO(resp.content)) as w:
        if w.getframerate() != SR or w.getsampwidth() != 2:
            raise UserError('TTS returned an unexpected audio format.')
        pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        if w.getnchannels() > 1:
            pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1)
    return _trim(pcm.astype(np.float32) / 32768.0)


def _trim(x, thresh_db=-50.0):
    """Drop leading/trailing near-silence so the timeline owns every gap."""
    idx = np.flatnonzero(np.abs(x) > 10 ** (thresh_db / 20))
    if not len(idx):
        return x
    pad = int(0.03 * SR)
    return x[max(0, idx[0] - pad): idx[-1] + pad]


def _clip_requests(events):
    """Every distinct (text, voice, speed) the script needs spoken."""
    reqs = set()

    def add(ev):
        reqs.add((ev['text'], ev['voice'], ev['speed']))
        if 'layered' in ev['fx']:
            for tag, _db, _pan in LAYERED_TAKES:
                reqs.add((f'<{tag}>{ev["text"]}</{tag}>', ev['voice'], ev['speed']))

    for ev in events:
        if ev['t'] == 'say':
            add(ev)
        elif ev['t'] in ('scatter', 'underlay'):
            for line in ev['lines']:
                add(line)
        elif ev['t'] == 'dual':
            for line in ev['left'] + ev['right']:
                add(line)
        elif ev['t'] == 'breathe' and ev['cues']:
            for cue in ev['cues']:
                if cue:
                    reqs.add((f'<soft>{cue}</soft>', ev['voice'], ev['speed']))
    return reqs


# ---------------------------------------------------------------------------
# DSP helpers
# ---------------------------------------------------------------------------

def _db(x):
    return 10 ** (x / 20.0)


def _fft_filter(x, response):
    """Zero-phase filter: multiply the spectrum by response(freqs_hz)."""
    n = x.shape[-1]
    spec = np.fft.rfft(x, axis=-1)
    spec *= response(np.fft.rfftfreq(n, 1.0 / SR))
    return np.fft.irfft(spec, n, axis=-1).astype(np.float32)


def _shelf(freqs, corner, gain_db, low=True):
    """First-order-ish shelf magnitude: gain below (low) / above the corner."""
    ratio = (freqs / corner) ** 2
    g = _db(gain_db)
    return (g + ratio) / (1 + ratio) if low else (1 + g * ratio) / (1 + ratio)


def _highpass(freqs, corner, order=2):
    r = (freqs / corner) ** (2 * order)
    return np.sqrt(r / (1 + r))


def _lowpass(freqs, corner, order=2):
    return 1 / np.sqrt(1 + (freqs / corner) ** (2 * order))


def _pan_gains(p):
    """Constant-power pan, p in −1..1 → (left, right)."""
    angle = (np.asarray(p) + 1) * math.pi / 4
    return np.cos(angle), np.sin(angle)


def _place_pan(mono, pan, start, sweep=SWEEP_SECONDS):
    """Mono clip → stereo at a pan position, or sweeping between the ears
    once every `sweep` seconds."""
    if pan == 'sweep':
        t = (start + np.arange(len(mono))) / SR
        lg, rg = _pan_gains(0.85 * np.sin(2 * math.pi * t / sweep))
        return np.stack([mono * lg, mono * rg]).astype(np.float32)
    lg, rg = _pan_gains(pan)
    out = np.stack([mono * lg, mono * rg]).astype(np.float32)
    # Interaural time difference: the far ear hears it up to 0.65 ms late.
    lag = int(round(abs(pan) * ITD_MAX * SR))
    if lag:
        far = 1 if pan < 0 else 0
        out[far] = np.concatenate([np.zeros(lag, np.float32), out[far][:-lag]])
    return out


def _resample(x, ratio):
    """Linear-interpolation resample — only for the tiny doubler detune."""
    n = int(len(x) * ratio)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


_REVERB_IR = None


def _reverb_ir():
    """Synthetic stereo hall: pre-delay + exponentially decaying noise."""
    global _REVERB_IR
    if _REVERB_IR is None:
        rng = np.random.default_rng(11)
        n = int(REVERB_DECAY * SR)
        env = np.exp(-6.91 * np.arange(n) / n)  # −60 dB at the decay time
        tail = rng.standard_normal((2, n)).astype(np.float32) * env
        tail = _fft_filter(tail, lambda f: _highpass(f, REVERB_HP) * _lowpass(f, 6000))
        tail /= np.sqrt(np.sum(tail ** 2, axis=1, keepdims=True))
        pre = np.zeros((2, int(REVERB_PREDELAY * SR)), np.float32)
        _REVERB_IR = np.concatenate([pre, tail], axis=1)
    return _REVERB_IR


def _apply_fx(stereo, fx):
    """Post-pan effects on a stereo clip; may lengthen it (tails)."""
    if 'echo' in fx:
        d = int(ECHO_DELAY * SR)
        repeats = int(math.log(_db(-40)) / math.log(ECHO_FEEDBACK)) + 1
        out = np.zeros((2, stereo.shape[1] + d * repeats), np.float32)
        out[:, :stereo.shape[1]] += stereo
        mono = stereo.mean(axis=0)
        for k in range(1, repeats + 1):
            side = k % 2  # repeats alternate ears: right, left, right…
            out[side, k * d:k * d + len(mono)] += mono * ECHO_FEEDBACK ** k
        stereo = out
    if 'reverb' in fx:
        ir = _reverb_ir()
        n = stereo.shape[1] + ir.shape[1]
        wet = np.fft.irfft(np.fft.rfft(stereo.mean(axis=0), n)[None, :] * np.fft.rfft(ir, n, axis=1),
                           n, axis=1).astype(np.float32)
        out = np.zeros((2, n), np.float32)
        out[:, :stereo.shape[1]] += stereo
        stereo = out + wet * _db(REVERB_WET_DB)
    return stereo


def _voice_clip(mono, ev, start, takes=None):
    """A speech clip with its pre-pan (close, double, layered), pan and
    post-pan (echo, reverb) effects applied → stereo."""
    fx = ev['fx']
    if 'close' in fx:
        mono = _fft_filter(mono, lambda f: _shelf(f, CLOSE_SHELF_HZ, CLOSE_SHELF_DB))
    stereo = _place_pan(mono, ev['pan'], start, ev['sweep'])
    extras = []
    if 'double' in fx:
        d = int(DOUBLE_DELAY * SR)
        for sign, ratio in ((-1, 1 + DOUBLE_DETUNE), (1, 1 - DOUBLE_DETUNE)):
            copy = _resample(mono, ratio) * _db(DOUBLE_DB)
            extras.append((d, _place_pan(copy, sign * 0.7, start + d)))
    for (tag, db, pan), clip in zip(LAYERED_TAKES, takes or ()):
        extras.append((0, _place_pan(clip * _db(db), pan, start)))
    if extras:
        n = max([stereo.shape[1]] + [off + c.shape[1] for off, c in extras])
        out = np.zeros((2, n), np.float32)
        out[:, :stereo.shape[1]] += stereo
        for off, c in extras:
            out[:, off:off + c.shape[1]] += c
        stereo = out
    return _apply_fx(stereo, fx)


# --- procedural sources --------------------------------------------------

_LOOP_SECONDS = 60
_LOOPS = {}


def _noise_loop(kind):
    """A seamless 60 s stereo loop (FFT-shaped noise is circular), RMS 1."""
    if kind not in _LOOPS:
        rng = np.random.default_rng(zlib.crc32(kind.encode()))
        n = _LOOP_SECONDS * SR
        freqs = np.fft.rfftfreq(n, 1.0 / SR)
        f = np.maximum(freqs, 1.0)
        spec = rng.standard_normal((2, len(freqs))) + 1j * rng.standard_normal((2, len(freqs)))
        if kind == 'room':
            shape = 1 / np.sqrt(f)                               # pink
        elif kind == 'pink':
            shape = 1 / np.sqrt(f) * _highpass(freqs, 30)
        elif kind == 'brown':
            shape = 1 / f * _highpass(freqs, 25)
        elif kind == 'ocean':
            shape = 1 / f ** 0.8 * _highpass(freqs, 40) * _lowpass(freqs, 1800)
        elif kind == 'rain':
            shape = 1 / np.sqrt(f) * _highpass(freqs, 500, 1) * _lowpass(freqs, 7000)
        elif kind == 'drone':
            _LOOPS[kind] = _drone_loop(n)
            return _LOOPS[kind]
        else:
            raise ValueError(kind)
        x = np.fft.irfft(spec * shape, n, axis=1).astype(np.float32)
        if kind == 'rain':
            # Droplets: sparse short band-passed ticks baked into the loop.
            drops = np.zeros((2, n), np.float32)
            for ch in range(2):
                at = rng.integers(0, n, 30 * _LOOP_SECONDS)
                drops[ch, at] = rng.uniform(0.2, 1.0, len(at)) * rng.choice([-1, 1], len(at))
            drops = _fft_filter(drops, lambda fr: _highpass(fr, 1500) * _lowpass(fr, 6000))
            x = x / np.sqrt(np.mean(x ** 2)) + drops / np.sqrt(np.mean(drops ** 2)) * 0.35
        x /= np.sqrt(np.mean(x ** 2))
        _LOOPS[kind] = x
    return _LOOPS[kind]


def _drone_loop(n):
    """A1 root + fifth + octaves, left/right detuned ±0.15 Hz so they beat
    slowly across the ears. Every frequency (and the 0.05 Hz swell) is a
    multiple of 0.05 Hz, so the drone repeats exactly every 20 s and a
    60 s buffer loops seamlessly."""
    t = np.arange(n) / SR
    out = np.zeros((2, n), np.float32)
    for hz, amp in ((55.0, 1.0), (82.5, 0.6), (110.0, 0.5), (165.0, 0.25)):
        for ch, det in ((0, -0.15), (1, 0.15)):
            out[ch] += amp * np.sin(2 * math.pi * (hz + det) * t) * (
                0.8 + 0.2 * np.sin(2 * math.pi * 0.05 * t + hz))
    return out / np.sqrt(np.mean(out ** 2))


def _loop_read(kind, a, b):
    loop = _noise_loop(kind)
    return loop[:, np.arange(a, b) % loop.shape[1]]


def _bed_signal(kind, a, b):
    """Bed samples [a, b) at RMS ≈ 1, as a pure function of sample time."""
    x = _loop_read(kind, a, b)
    if kind == 'ocean':
        # Wave swells: two incommensurate periods so the pattern never repeats.
        t = np.arange(a, b) / SR
        swell = 0.25 + 0.75 * (0.5 + 0.5 * np.sin(2 * math.pi * t / 9.5)) ** 2 * (
            0.75 + 0.25 * np.sin(2 * math.pi * t / 23.3))
        phase = 0.25 + 0.75 * (0.5 + 0.5 * np.sin(2 * math.pi * t / 9.5 + 0.8)) ** 2 * (
            0.75 + 0.25 * np.sin(2 * math.pi * t / 23.3 + 0.8))
        x = x * np.stack([swell, phase]) * 1.9
    return x


def _chime_clip():
    """Singing-bowl strike: inharmonic partials, beating, long decay."""
    t = np.arange(int(7.0 * SR)) / SR
    out = np.zeros((2, len(t)), np.float32)
    for ratio, amp, decay in ((1.0, 1.0, 2.2), (2.76, 0.5, 1.4), (5.4, 0.25, 0.8), (8.9, 0.1, 0.45)):
        for ch, beat in ((0, 1.1), (1, 1.4)):
            out[ch] += amp * np.sin(2 * math.pi * 220.0 * ratio * t) * (
                1 + 0.15 * np.sin(2 * math.pi * beat * t)) * np.exp(-t / decay)
    out *= np.minimum(1.0, t / 0.004)
    return out / np.abs(out).max() * _db(CHIME_PEAK_DB)


def _tick_clip():
    """Wooden metronome click: a decaying ~1.6 kHz resonance, 60 ms."""
    t = np.arange(int(0.06 * SR)) / SR
    click = np.sin(2 * math.pi * 1600 * t) * np.exp(-t / 0.008) + \
        0.5 * np.sin(2 * math.pi * 2500 * t) * np.exp(-t / 0.004)
    return (click / np.abs(click).max()).astype(np.float32)


def _thump_clip():
    """One heartbeat sound: a low decaying thump."""
    t = np.arange(int(0.18 * SR)) / SR
    thump = np.sin(2 * math.pi * 52 * t) * np.exp(-t / 0.045) * np.minimum(1.0, t / 0.006)
    return (thump / np.abs(thump).max()).astype(np.float32)


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

def _layout(events, clips, target, warnings, library=None):
    """Place everything on the timeline. Returns (placements, segments,
    swell, duration_seconds, marks) — placements are (start_sample, stereo,
    is_voice); segments are layer spans for the block renderer; marks are
    where extension directives landed."""
    def dur(key):
        return len(clips[key]) / SR

    def say_len(ev):
        return dur((ev['text'], ev['voice'], ev['speed'])) + SPEECH_TAIL

    def seq_len(lines):
        return sum(say_len(l) for l in lines) + PARAGRAPH_GAP * max(0, len(lines) - 1) / 2

    def length(i, ev):
        t = ev['t']
        if t == 'say':
            nxt = events[i + 1] if i + 1 < len(events) else None
            return say_len(ev) + (PARAGRAPH_GAP if nxt and nxt['t'] == 'say' else 0)
        if t == 'silence':
            return ev['sec']
        if t == 'breathe':
            return sum(ev['phases']) * ev['reps']
        if t == 'scatter':
            return max(ev['sec'], seq_len(ev['lines']))
        if t == 'dual':
            return max(seq_len(ev['left']), seq_len(ev['right']))
        if t == 'sound' and not ev['under']:
            return sound_clip(ev).shape[1] / SR  # the script waits for it
        return 0.0

    def sound_clip(ev):
        """An effect at its level, cut to its LENGTH cap with a short fade."""
        clip = library[ev['name']] * _db(SOUND_PEAK_DB + ev['level'])
        if ev['cap'] and clip.shape[1] > ev['cap'] * SR:
            clip = clip[:, :int(ev['cap'] * SR)].copy()
            fade = min(int(SOUND_CUT_FADE * SR), clip.shape[1])
            clip[:, clip.shape[1] - fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        return clip

    fixed = HEAD + sum(length(i, ev) for i, ev in enumerate(events)
                       if not (ev['t'] == 'silence' and ev['elastic']))
    elastic = sum(ev['sec'] for ev in events if ev['t'] == 'silence' and ev['elastic'])
    scale = 1.0
    if target:
        if not elastic:
            warnings.append('{target} needs elastic silences ({silence 20s~}) to stretch — ignored')
        else:
            scale = max(0.0, (target - TAIL - fixed) / elastic)
            if scale == 0.0:
                warnings.append(
                    f'the fixed content alone runs {_mmss(fixed + TAIL)}, past the '
                    f'{_mmss(target)} target — elastic silences collapsed to nothing')
    rng = np.random.default_rng(7)
    placements = []
    swell_spans = []
    changes = []  # (time, event) for layers
    marks = []    # extension directives, for plugins.recording_rendered

    def place_say(ev, at, gain_db=0.0):
        key = (ev['text'], ev['voice'], ev['speed'])
        mono = clips[key] * _db(gain_db)
        takes = None
        if 'layered' in ev['fx']:
            takes = [clips[(f'<{tag}>{ev["text"]}</{tag}>', ev['voice'], ev['speed'])] * _db(gain_db)
                     for tag, _db_, _pan in LAYERED_TAKES]
        start = int(at * SR)
        placements.append((start, _voice_clip(mono, ev, start, takes), True))
        return dur(key) + SPEECH_TAIL

    def place_seq(lines, at, gain_db=0.0):
        for line in lines:
            at += place_say(line, at, gain_db) + PARAGRAPH_GAP / 2

    cur = HEAD
    for i, ev in enumerate(events):
        t = ev['t']
        if t == 'say':
            place_say(ev, cur)
        elif t == 'breathe':
            at = cur
            for _ in range(ev['reps']):
                for k, phase in enumerate(ev['phases']):
                    cue = ev['cues'][k] if ev['cues'] and k < len(ev['cues']) else None
                    if cue:
                        key = (f'<soft>{cue}</soft>', ev['voice'], ev['speed'])
                        s = int(at * SR)
                        placements.append((s, _place_pan(clips[key], ev['pan'], s, ev['sweep']), True))
                    # The bed swells on the inhale, holds, falls on the exhale.
                    kind = ('in', 'hold', 'out', 'rest')[k if len(ev['phases']) > 2 else k * 2]
                    swell_spans.append((at, at + phase, kind))
                    at += phase
        elif t == 'scatter':
            lines = ev['lines']
            if lines:
                slot = ev['sec'] / len(lines)
                prev_end = cur
                for k, line in enumerate(lines):
                    free = max(0.0, slot - say_len(line))
                    loose = cur + k * slot + rng.uniform(0.15, 0.45) * free
                    # Never over the previous line: lines longer than their
                    # slot run back to back (length() reserves that case).
                    start = max(loose, prev_end + (PARAGRAPH_GAP / 2 if k else 0.0))
                    prev_end = start + place_say(line, start)
        elif t == 'underlay':
            lines = ev['lines']
            if lines:
                slot = ev['sec'] / len(lines)
                for k, line in enumerate(lines):
                    line = {**line, 'pan': -0.7 if k % 2 == 0 else 0.7}
                    place_say(line, cur + k * slot + rng.uniform(0.0, 0.3) * slot, ev['level'])
        elif t == 'dual':
            place_seq(ev['left'], cur)
            place_seq(ev['right'], cur)
        elif t == 'chime':
            s = int(cur * SR)
            placements.append((s, _chime_clip(), False))
        elif t == 'sound':
            placements.append((int(cur * SR), sound_clip(ev), False))
        elif t == 'layer':
            changes.append((cur, ev))
        elif t == 'mark':
            marks.append({'at': round(cur, 3), 'directive': ev['directive'], 'data': ev['data']})
        if t == 'silence':
            cur += ev['sec'] * (scale if ev['elastic'] else 1.0)
        else:
            cur += length(i, ev)
    total = min(cur + TAIL, MAX_SECONDS + TAIL)
    if cur > MAX_SECONDS:
        warnings.append(f'the render is capped at {_mmss(MAX_SECONDS)}')

    # Layer spans: each change ends the previous span of the same layer.
    # The change's own fade= sets both halves of the transition: the old
    # span fades out over it from the change point while the new one fades
    # in over it, so a replacement crossfades and an off fades away.
    segments = []
    open_ = {}
    for at, ev in changes:
        prev = open_.pop(ev['layer'], None)
        if prev:
            prev['end'] = at
            prev['fade_out'] = ev['fade']
            segments.append(prev)
        if ev['value'] is not None:
            open_[ev['layer']] = {**ev, 'start': at, 'end': total,
                                  'fade_in': ev['fade'], 'fade_out': LAYER_FADE}
    segments.extend(open_.values())

    # Breath swell envelope at control rate.
    n_frames = int(total * FRAME) + 2
    swell = np.zeros(n_frames, np.float32)
    for a, b, kind in swell_spans:
        fa, fb = int(a * FRAME), int(b * FRAME)
        if fb <= fa or fa >= n_frames:
            continue
        ramp = {'in': np.linspace(0, 1, fb - fa), 'hold': np.ones(fb - fa),
                'out': np.linspace(1, 0, fb - fa), 'rest': np.zeros(fb - fa)}[kind]
        # Breathing that runs past the length cap is cut to fit.
        swell[fa:min(fb, n_frames)] = ramp[:n_frames - fa]
    return placements, segments, swell, total, marks


def _fix_dual_pans(events):
    """Dual lines always sit hard-ish left / right, whatever {pan} is in
    force: one script per ear is the whole effect."""
    for ev in events:
        if ev['t'] == 'dual':
            for line in ev['left']:
                line['pan'] = -0.9
            for line in ev['right']:
                line['pan'] = 0.9


def _mmss(sec):
    sec = int(round(sec))
    return f'{sec // 60}:{sec % 60:02d}'


# ---------------------------------------------------------------------------
# Block rendering
# ---------------------------------------------------------------------------

class _Mixer:
    def __init__(self, placements, segments, swell, total, library=None):
        self.placements = placements
        self.segments = segments
        self.library = library or {}
        self.swell = swell
        self.n = int(total * SR)
        self.duck = self._duck_envelope()
        self.tick = _tick_clip()
        self.thump = _thump_clip()

    def _duck_envelope(self):
        """Voice activity → smoothed 0..1 at control rate (attack/release)."""
        frames = len(self.swell)
        active = np.zeros(frames, bool)
        hop = SR // FRAME
        thr = _db(-45)
        for start, clip, is_voice in self.placements:
            if not is_voice:
                continue
            level = np.abs(clip).max(axis=0)
            m = len(level) // hop
            if not m:
                continue
            loud = level[:m * hop].reshape(m, hop).max(axis=1) > thr
            f0 = start // hop
            seg = active[f0:f0 + m]
            seg |= loud[:len(seg)]
        env = np.zeros(frames, np.float32)
        a = 1 - math.exp(-1 / (DUCK_ATTACK * FRAME))
        r = 1 - math.exp(-1 / (DUCK_RELEASE * FRAME))
        v = 0.0
        for i in range(frames):
            target = 1.0 if active[i] else 0.0
            v += (target - v) * (a if target > v else r)
            env[i] = v
        return env

    def _control(self, arr, a, b):
        t = np.arange(a, b) / SR * FRAME
        return np.interp(t, np.arange(len(arr)), arr).astype(np.float32)

    @staticmethod
    def _span_gain(seg, t):
        """Fade in over fade_in from the span start, out over fade_out past
        its end — neighbouring spans crossfade. fade=0 is a hard cut (the
        floor keeps the division finite)."""
        fin, fout = max(seg['fade_in'], 0.005), max(seg['fade_out'], 0.005)
        return (np.clip((t - seg['start']) / fin, 0, 1)
                * np.clip((seg['end'] + fout - t) / fout, 0, 1))

    def render(self, a, b):
        out = np.zeros((2, b - a), np.float32)
        t = np.arange(a, b) / SR
        duck = None
        for seg in self.segments:
            s0, s1 = int(seg['start'] * SR), int((seg['end'] + seg['fade_out']) * SR)
            if s1 <= a or s0 >= b:
                continue
            gain = self._span_gain(seg, t) * _db(seg.get('level', 0.0))
            layer = seg['layer']
            if layer == 'room-tone':
                out += _loop_read('room', a, b) * gain * _db(ROOM_TONE_DB)
            elif layer in ('bed', 'music'):
                if duck is None:
                    duck = 1 - (1 - _db(-DUCK_DB)) * self._control(self.duck, a, b)
                    swell = _db(4.0) ** self._control(self.swell, a, b)  # up to +4 dB on the inhale
                if seg['value'] in PROCEDURAL_BEDS:
                    signal = _bed_signal(seg['value'], a, b)
                else:
                    # An upload loops from its own start at the moment it was called.
                    loop = self.library[seg['value']]
                    signal = loop[:, (np.arange(a, b) - int(seg['start'] * SR)) % loop.shape[1]]
                out += signal * gain * duck * (swell if layer == 'bed' else 1.0) * _db(BED_DB)
            elif layer in ('binaural', 'isochronic'):
                tau = np.maximum(0.0, t - seg['start'])
                f0 = seg['hz']
                f1 = seg.get('to_hz', f0)
                T = seg.get('ramp', 1.0)
                # Beat phase = 2π∫beat dt, linear glide over T then held.
                inside = np.minimum(tau, T)
                phase = 2 * math.pi * (f0 * inside + (f1 - f0) * inside ** 2 / (2 * T)
                                       + f1 * np.maximum(0.0, tau - T))
                if layer == 'binaural':
                    left = np.sin(2 * math.pi * BINAURAL_CARRIER * t)
                    right = np.sin(2 * math.pi * BINAURAL_CARRIER * t + phase)
                    tone = np.stack([left, right]) * math.sqrt(2) * _db(BINAURAL_DB)
                else:
                    # Raised-cosine pulses avoid clicks. A pulsed sine's RMS
                    # is 0.707 × √(3/8) of its peak; scale so RMS = the level.
                    pulse = 0.5 - 0.5 * np.cos(phase)
                    tone = np.sin(2 * math.pi * BINAURAL_CARRIER * t) * pulse
                    tone = np.stack([tone, tone]) / (math.sqrt(0.5) * math.sqrt(3 / 8)) * _db(ISOCHRONIC_DB)
                out += tone * gain
            else:  # tick / heartbeat — events on the beat grid
                period = 60.0 / seg['bpm']
                clip = self.tick if layer == 'tick' else self.thump
                peak = _db(TICK_PEAK_DB if layer == 'tick' else HEARTBEAT_PEAK_DB) * _db(seg.get('level', 0.0))
                k0 = max(0, int(math.floor((a / SR - seg['start'] - 0.5) / period)))
                k = k0
                while True:
                    beat = seg['start'] + k * period
                    # Beats carry on through the fade-out, getting quieter.
                    if beat > seg['end'] + seg['fade_out'] or beat * SR >= b:
                        break
                    hits = [(beat, 1.0)] if layer == 'tick' else [(beat, 1.0), (beat + 0.28, 0.6)]
                    for when, amp in hits:
                        s = int(when * SR)
                        lo, hi = max(s, a), min(s + len(clip), b)
                        if hi > lo:
                            g = amp * peak * float(self._span_gain(seg, np.array([when]))[0])
                            piece = clip[lo - s:hi - s] * g
                            if layer == 'tick':  # the pendulum swings ear to ear
                                lg, rg = _pan_gains(-0.6 if k % 2 == 0 else 0.6)
                                out[0, lo - a:hi - a] += piece * lg
                                out[1, lo - a:hi - a] += piece * rg
                            else:
                                out[:, lo - a:hi - a] += piece
                    k += 1
        for start, clip, _voice in self.placements:
            lo, hi = max(start, a), min(start + clip.shape[1], b)
            if hi > lo:
                out[:, lo - a:hi - a] += clip[:, lo - start:hi - start]
        # Fade the whole mix out over the tail.
        fade0 = self.n - int(TAIL * SR)
        if b > fade0:
            idx = np.arange(a, b)
            out *= np.clip((self.n - idx) / (TAIL * SR), 0, 1)
        return out


_K_CACHE = {}


def _k_weight(freqs):
    """|H| of the BS.1770 K-weighting pre-filter (high shelf + RLB high-pass),
    via the RBJ biquad formulas pyloudnorm uses, evaluated at `freqs`
    (cached per block length: every full block shares one curve)."""
    if len(freqs) not in _K_CACHE:
        _K_CACHE[len(freqs)] = _k_weight_curve(freqs)
    return _K_CACHE[len(freqs)]


def _k_weight_curve(freqs):
    def biquad(b, a):
        z = np.exp(-1j * 2 * math.pi * freqs / SR)
        return np.abs((b[0] + b[1] * z + b[2] * z ** 2) / (a[0] + a[1] * z + a[2] * z ** 2))

    w0 = 2 * math.pi * 1500.0 / SR
    A = 10 ** (4.0 / 40)
    alpha = math.sin(w0) / (2 * (1 / math.sqrt(2)))
    c, sA = math.cos(w0), math.sqrt(A)
    shelf = biquad((A * ((A + 1) + (A - 1) * c + 2 * sA * alpha), -2 * A * ((A - 1) + (A + 1) * c),
                    A * ((A + 1) + (A - 1) * c - 2 * sA * alpha)),
                   ((A + 1) - (A - 1) * c + 2 * sA * alpha, 2 * ((A - 1) - (A + 1) * c),
                    (A + 1) - (A - 1) * c - 2 * sA * alpha))
    w0 = 2 * math.pi * 38.0 / SR
    alpha, c = math.sin(w0) / (2 * 0.5), math.cos(w0)
    hp = biquad(((1 + c) / 2, -(1 + c), (1 + c) / 2), (1 + alpha, -2 * c, 1 - alpha))
    return shelf * hp


def _integrated_loudness(block_energies):
    """BS.1770 gated loudness from per-100 ms K-weighted channel-summed
    mean squares (400 ms windows, 75 % overlap)."""
    e = np.asarray(block_energies)
    if len(e) < 4:
        return None
    z = np.convolve(e, np.ones(4) / 4, 'valid')
    loud = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[loud > -70]
    if not len(z):
        return None
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return -0.691 + 10 * math.log10(z.mean()) if len(z) else None


def _encode(mixer, gain):
    try:
        import lameenc  # imported here so a missing wheel can't stop the server
    except ImportError:
        raise UserError('The mp3 encoder (lameenc) is not installed — reinstall the app '
                        'dependencies (pip install -e .).')
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)       # 24 kHz stereo speech; MPEG-2 layer III tops out at 160
    enc.set_in_sample_rate(SR)
    enc.set_channels(2)
    enc.set_quality(5)         # LAME's middle setting; 2 cost ~1 s of encode per minute of audio
    out = bytearray()
    block = _LOOP_SECONDS * SR
    for a in range(0, mixer.n, block):
        b = min(a + block, mixer.n)
        x = np.clip(mixer.render(a, b) * gain, -1.0, 1.0)
        pcm = (x.T * 32767).astype('<i2')
        out += enc.encode(pcm.tobytes())
    out += enc.flush()
    return bytes(out)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def render(con, config, script, *, voice, language='auto', pace=1.0):
    """Render `script` to an mp3 under FILES_DIR.

    Returns {'audio_url', 'duration_seconds', 'tts_chars', 'usd', 'warnings',
    'notes'} — notes are what extensions' render hooks tell the companion.
    Raises UserError for anything the caller should show (no key, empty
    script, a TTS failure)."""
    if not config['xai_api_key']:
        raise UserError(xai_client.NO_KEY_MSG)
    script = (script or '').strip()
    if not script:
        raise UserError('The script is empty.')
    if len(script) > MAX_SCRIPT_CHARS:
        raise UserError(f'The script is too long ({len(script)} characters, max {MAX_SCRIPT_CHARS}).')
    sounds = audio_sounds.catalog(con)
    events, target, pronounce, warnings = parse(script, voice=voice, pace=pace, sounds=sounds)
    _fix_dual_pans(events)
    # Load only the recorded audio this script calls: bundled beds and uploads.
    used = {ev['name'] for ev in events if ev['t'] == 'sound'}
    used |= {ev['value'] for ev in events
             if ev['t'] == 'layer' and ev['layer'] in ('bed', 'music')
             and ev['value'] and ev['value'] not in PROCEDURAL_BEDS}
    library = {name: (audio_sounds.load_bundled(name) if name in audio_sounds.BUNDLED
                      else audio_sounds.load(sounds[name])) for name in used}
    requests_ = sorted(_clip_requests(events))
    if not requests_:
        raise UserError('The script has no spoken lines.')

    started = time.monotonic()
    clips = {}
    pool = concurrent.futures.ThreadPoolExecutor(TTS_WORKERS)
    futures = {pool.submit(_tts, config, text, v, s, language, pronounce): (text, v, s)
               for text, v, s in requests_}
    try:
        for fut, key in futures.items():
            clips[key] = fut.result()
    except requests.RequestException as e:
        raise UserError(f'Could not reach xAI TTS: {e}')
    finally:
        # On a failure, drop the queued requests instead of waiting them out.
        # Whatever was actually spoken is billed by xAI, so meter it either way.
        pool.shutdown(wait=False, cancel_futures=True)
        spoken = sum(len(key[0]) for fut, key in futures.items()
                     if fut.done() and not fut.cancelled() and fut.exception() is None)
        store.accrue_usd_ticks(con, int(spoken * TTS_USD_PER_CHAR * store.USD_TICKS_PER_USD))
    chars = sum(len(text) for text, _v, _s in requests_)
    usd = chars * TTS_USD_PER_CHAR

    placements, segments, swell, total, marks = _layout(events, clips, target, warnings, library)
    mixer = _Mixer(placements, segments, swell, total, library)

    # Pass 1: loudness + peak, block by block.
    energies, peak = [], 0.0
    block = _LOOP_SECONDS * SR
    hop = SR // 10
    for a in range(0, mixer.n, block):
        b = min(a + block, mixer.n)
        x = mixer.render(a, b)
        peak = max(peak, float(np.abs(x).max()))
        kw = _fft_filter(x, _k_weight)
        m = kw.shape[1] // hop
        energies.extend((kw[:, :m * hop] ** 2).reshape(2, m, hop).mean(axis=2).sum(axis=0))
    loudness = _integrated_loudness(energies)
    gain = _db(TARGET_LUFS - loudness) if loudness is not None else 1.0
    if peak * gain > _db(PEAK_CEILING_DB):
        gain = _db(PEAK_CEILING_DB) / peak

    # Pass 2: the gained mix, encoded as it renders.
    data = _encode(mixer, gain)
    fname = f'audio_{uuid.uuid4().hex}.mp3'
    (FILES_DIR / fname).write_bytes(data)
    # Extensions that follow the recording (plugins.py) get where everything
    # landed. voice_activity is the ducker's 0..1 speech envelope, FRAME/s.
    notes = plugins.recording_rendered(FILES_DIR / fname, {
        'duration': round(total, 3),
        'marks': marks,
        'speech': sorted([round(s / SR, 3), round((s + clip.shape[1]) / SR, 3)]
                         for s, clip, is_voice in placements if is_voice),
        'layers': [{k: v for k, v in seg.items() if k != 't'} for seg in segments],
        'voice_activity': mixer.duck,
        'frame_rate': FRAME,
    })
    _logger.info('audio render: %s, %d TTS chars, %.1f s wall', _mmss(total), chars,
                 time.monotonic() - started)
    return {
        'audio_url': f'/files/{fname}',
        'duration_seconds': round(total, 1),
        'tts_chars': chars,
        'usd': round(usd, 4),
        'warnings': warnings,
        'notes': notes,
    }
