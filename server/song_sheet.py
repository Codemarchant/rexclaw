# Copyright 2026 Codemarchant
"""Song sheets: songs written in ABC notation.

The built-in songs (song_examples.py) are each one ABC tune: melody, lyrics
(w: lines), chord symbols ("Am"), key, meter and tempo in a plain text
standard (ABC 2.1, abcnotation.com/wiki/abc:standard:v2.1). This module
reads the subset songs need and returns

  chart    the karaoke chart (singing.py sings it, the stage shows it)
  chords   the harmony timeline song_synth.py arranges the backing from
  grid     beats and bar lines at the written tempo (no analysis needed)

Supported: X T C M L Q K headers and inline [K:] [M:] [L:] [Q:] fields;
notes with accidentals (^ _ = persisting to the bar line), octave marks,
lengths (2, 3/2, /2, /), rests z/x, whole-bar rests Z, ties, broken rhythm
(> <), tuplets (3abc, chords [CEG] (the top note is sung), grace notes and
decorations (skipped), repeats |: :| with [1 [2 endings, and w: lyrics
(- between syllables, _ holds a syllable over the next note, * skips a
note, ~ joins words under one note, | jumps to the next bar).
"""
import math
import re
from fractions import Fraction

from .errors import UserError

_NOTE_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
_SHARPS = 'FCGDAEB'
_MODE_SHIFT = {'': 0, 'maj': 0, 'major': 0, 'ion': 0, 'ionian': 0, 'm': -3, 'min': -3,
               'minor': -3, 'aeo': -3, 'aeolian': -3, 'mix': -5, 'mixolydian': -5,
               'dor': -2, 'dorian': -2, 'phr': -4, 'phrygian': -4, 'lyd': -1,
               'lydian': -1, 'loc': -6, 'locrian': -6}
# Major keys by number of sharps (negative = flats).
_FIFTHS = {'Cb': -7, 'Gb': -6, 'Db': -5, 'Ab': -4, 'Eb': -3, 'Bb': -2, 'F': -1, 'C': 0,
           'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7}
# Mode → how many fifths below its relative major (dorian D = C major, …).
_MODE_FIFTHS = {'': 0, 'maj': 0, 'major': 0, 'ion': 0, 'ionian': 0, 'm': -3, 'min': -3,
                'minor': -3, 'aeo': -3, 'aeolian': -3, 'mix': -1, 'mixolydian': -1,
                'dor': -2, 'dorian': -2, 'phr': -4, 'phrygian': -4, 'lyd': 1, 'lydian': 1,
                'loc': -5, 'locrian': -5}
_ROOT_PC = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6,
            'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11, 'Cb': 11,
            'E#': 5, 'Fb': 4, 'B#': 0}


def key_signature(spec):
    """'G', 'Em', 'D dor', 'Bb' … → ({letter: +1/-1}, tonic pc, is_minor)."""
    spec = (spec or 'C').strip()
    m = re.match(r'^([A-G])([#b]?)\s*([A-Za-z]*)', spec)
    if not m or spec.lower().startswith('none'):
        return {}, 0, False
    root = m.group(1) + m.group(2)
    mode = m.group(3).lower()
    mode = mode if mode in _MODE_FIFTHS else ('m' if mode.startswith('m') and not mode.startswith('mi') else '')
    # Fifths of the key = fifths of the root as a major key + the mode's offset.
    fifths = _FIFTHS.get(root, 0) + _MODE_FIFTHS[mode]
    acc = {}
    if fifths > 0:
        for letter in _SHARPS[:min(7, fifths)]:
            acc[letter] = 1
    elif fifths < 0:
        for letter in _SHARPS[::-1][:min(7, -fifths)]:
            acc[letter] = -1
    return acc, _ROOT_PC.get(root, 0), mode in ('m', 'min', 'minor', 'aeo', 'aeolian')


def _meter(spec):
    spec = (spec or '4/4').strip()
    if spec == 'C':
        return Fraction(4, 4), 4, Fraction(1, 4)
    if spec == 'C|':
        return Fraction(2, 2), 2, Fraction(1, 2)
    m = re.match(r'^(\d+)/(\d+)', spec)
    if not m:
        return Fraction(4, 4), 4, Fraction(1, 4)
    num, den = int(m.group(1)), int(m.group(2))
    bar = Fraction(num, den)
    if den == 8 and num % 3 == 0 and num > 3:          # compound: dotted-quarter beats
        return bar, num // 3, Fraction(3, 8)
    return bar, num, Fraction(1, den)


def _tempo(spec, beat_unit):
    """Q: → quarter-note BPM equivalent: seconds per whole note."""
    spec = (spec or '').strip()
    m = re.search(r'(\d+)/(\d+)\s*=\s*(\d+(?:\.\d+)?)', spec)
    if m:
        unit = Fraction(int(m.group(1)), int(m.group(2)))
        bpm = float(m.group(3))
    else:
        m = re.search(r'(\d+(?:\.\d+)?)', spec)
        unit, bpm = beat_unit, float(m.group(1)) if m else 100.0
    bpm = max(30.0, min(260.0, bpm))
    return 60.0 / bpm / float(unit)          # seconds per whole note


# ---------------------------------------------------------------------------
# Chord symbols
# ---------------------------------------------------------------------------

_QUALITIES = [
    ('maj7', (0, 4, 7, 11)), ('M7', (0, 4, 7, 11)), ('m7b5', (0, 3, 6, 10)),
    ('min7', (0, 3, 7, 10)), ('m7', (0, 3, 7, 10)), ('mM7', (0, 3, 7, 11)),
    ('dim7', (0, 3, 6, 9)), ('dim', (0, 3, 6)), ('°', (0, 3, 6)), ('aug', (0, 4, 8)),
    ('+', (0, 4, 8)), ('sus2', (0, 2, 7)), ('sus4', (0, 5, 7)), ('sus', (0, 5, 7)),
    ('add9', (0, 4, 7, 14)), ('madd9', (0, 3, 7, 14)), ('m9', (0, 3, 7, 10, 14)),
    ('maj9', (0, 4, 7, 11, 14)), ('9', (0, 4, 7, 10, 14)), ('m6', (0, 3, 7, 9)),
    ('6', (0, 4, 7, 9)), ('7', (0, 4, 7, 10)), ('min', (0, 3, 7)), ('m', (0, 3, 7)),
    ('maj', (0, 4, 7)), ('5', (0, 7)), ('', (0, 4, 7)),
]


def parse_chord(symbol):
    """'Am7', 'F/C', 'Bbmaj7' → {'root': pc, 'intervals': (…), 'bass': pc, 'name'}."""
    s = symbol.strip()
    m = re.match(r'^([A-G])([#b]?)(.*?)(?:/([A-G][#b]?))?$', s)
    if not m:
        return None
    root = _ROOT_PC[m.group(1) + m.group(2)]
    qual = m.group(3)
    for name, ivs in _QUALITIES:
        if qual == name or (name and qual.startswith(name) and name not in ('', 'm')):
            break
    else:
        ivs = (0, 3, 7) if qual.startswith('m') and not qual.startswith('maj') else (0, 4, 7)
    bass = _ROOT_PC.get(m.group(4), root) if m.group(4) else root
    return {'root': root, 'intervals': ivs, 'bass': bass, 'name': s}


# ---------------------------------------------------------------------------
# Tokeniser
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r'''
    (?P<chord>"[^"]*")
  | (?P<field>\[[A-Za-z]:[^\]]*\])
  | (?P<grace>\{[^}]*\})
  | (?P<deco>![^!]*!|\+[^+]*\+)
  | (?P<ending>\|\s*\[?[12](?:,[12])*|\[[12](?:,[12])*)
  | (?P<bar>:?\|\]|\|\||\[\||:\|:|::|:\||\|:|\|)
  | (?P<tuplet>\((?P<tp>\d)(?::(?P<tq>\d*))?(?::(?P<tr>\d*))?)
  | (?P<multi>\[(?:[=^_]*[A-Ga-g][',]*[\d/]*)+\][\d/]*-?)
  | (?P<note>[=^_]*[A-Ga-g][',]*[\d/]*-?)
  | (?P<rest>[zx][\d/]*)
  | (?P<mrest>Z\d*)
  | (?P<broken>[<>]+)
  | (?P<skip>[.~HLMOPSTuv()\s`\\])
''', re.X)

_NOTE_PARTS = re.compile(r'^([=^_]*)([A-Ga-g])([\',]*)([\d/]*)(-?)$')


def _length(text):
    """ABC length suffix → Fraction multiplier of the unit length."""
    if not text:
        return Fraction(1)
    if '/' not in text:
        return Fraction(int(text))
    num, _, rest = text.partition('/')
    slashes = 1 + rest.count('/')
    rest = rest.replace('/', '')
    n = int(num) if num else 1
    d = int(rest) if rest else 2 ** slashes
    return Fraction(n, d)


class _Voice:
    """Parse state while walking the body."""

    def __init__(self, headers):
        self.bar_len, self.beats_per_bar, self.beat_unit = _meter(headers.get('M'))
        default_l = Fraction(1, 8) if float(self.bar_len) >= 0.75 else Fraction(1, 16)
        self.unit = Fraction(headers['L']) if re.fullmatch(r'\d+/\d+', headers.get('L', '')) else default_l
        self.whole = _tempo(headers.get('Q'), self.beat_unit)
        self.key_acc, self.tonic, self.minor = key_signature(headers.get('K'))
        self.bar_acc = {}


def _pitch(voice, acc, letter, octs):
    base = _NOTE_PC[letter.upper()]
    octave = 4 if letter.isupper() else 5
    octave += octs.count("'") - octs.count(',')
    key = (letter.upper(), octave)
    if acc:
        shift = {'^': 1, '^^': 2, '_': -1, '__': -2, '=': 0}.get(acc, 0)
        voice.bar_acc[key] = shift
    else:
        shift = voice.bar_acc.get(key, voice.key_acc.get(letter.upper(), 0))
    return 12 * (octave + 1) + base + shift


def _read_events(lines, voice, warnings):
    """Music lines → [(line_no, [event…])], events: note/rest/bar dicts with
    a length in whole notes. Repeats are expanded per line group."""
    out = []
    for ln_no, text in lines:
        text = re.sub(r'%.*$', '', text)
        events = []
        pos = 0
        tuplet = None
        broken = None
        chord = None
        while pos < len(text):
            m = _TOKEN.match(text, pos)
            if not m:
                warnings.append(f'Line {ln_no}: skipped "{text[pos]}".')
                pos += 1
                continue
            pos = m.end()
            kind = m.lastgroup
            tok = m.group(0)
            if kind == 'chord':
                sym = tok.strip('"')
                if sym and sym[0] in '^_<>@':   # annotations, not chords
                    continue
                chord = sym
            elif kind == 'field':
                k, _, v = tok[1:-1].partition(':')
                if k == 'K':
                    voice.key_acc, voice.tonic, voice.minor = key_signature(v)
                elif k == 'L' and re.fullmatch(r'\s*\d+/\d+\s*', v):
                    voice.unit = Fraction(v.strip())
                elif k == 'M':
                    voice.bar_len, voice.beats_per_bar, voice.beat_unit = _meter(v)
                elif k == 'Q':
                    voice.whole = _tempo(v, voice.beat_unit)
                    events.append({'t': 'tempo', 'whole': voice.whole})
            elif kind == 'ending':
                if '|' in tok:
                    voice.bar_acc = {}
                    events.append({'t': 'bar', 'kind': '|'})
                events.append({'t': 'ending', 'n': int(re.sub(r'\D', '', tok)[:1] or 1)})
            elif kind == 'bar':
                voice.bar_acc = {}
                events.append({'t': 'bar', 'kind': tok})
            elif kind == 'tuplet':
                p = int(m.group('tp'))
                compound = voice.bar_len in (Fraction(6, 8), Fraction(9, 8), Fraction(12, 8))
                q = int(m.group('tq')) if m.group('tq') else {2: 3, 3: 2, 4: 3, 6: 2, 8: 3}.get(p, 3 if compound else 2)
                r = int(m.group('tr')) if m.group('tr') else p
                tuplet = [Fraction(q, p), r]
            elif kind in ('note', 'multi', 'rest', 'mrest'):
                if kind == 'mrest':
                    bars = int(tok[1:] or 1)
                    length = voice.bar_len * bars
                    ev = {'t': 'rest', 'len': length, 'chord': chord}
                else:
                    if kind == 'multi':
                        # A written chord: sing its top note.
                        inner = re.findall(r'[=^_]*[A-Ga-g][\',]*', tok)
                        pitch = max(_pitch(voice, *_NOTE_PARTS.match(n).groups()[:3]) for n in inner)
                        suffix = re.search(r'\]([\d/]*)(-?)$', tok)
                        ln, tie = (suffix.group(1), suffix.group(2)) if suffix else ('', '')
                    elif kind == 'rest':
                        ln, tie, pitch = tok[1:], '', None
                    else:
                        acc, letter, octs, ln, tie = _NOTE_PARTS.match(tok).groups()
                        pitch = _pitch(voice, acc, letter, octs)
                    length = voice.unit * _length(ln)
                    ev = {'t': 'note' if pitch is not None else 'rest', 'len': length,
                          'pitch': pitch, 'tie': bool(tie), 'chord': chord}
                chord = None
                if tuplet and ev['t'] in ('note', 'rest') and kind != 'mrest':
                    ev['len'] *= tuplet[0]
                    tuplet[1] -= 1
                    if tuplet[1] <= 0:
                        tuplet = None
                if broken:
                    ev['len'] *= broken
                    broken = None
                events.append(ev)
            elif kind == 'broken':
                prev = next((e for e in reversed(events) if e['t'] in ('note', 'rest')), None)
                n = len(tok)
                long_f = Fraction(2 ** (n + 1) - 1, 2 ** n)
                short_f = Fraction(1, 2 ** n)
                if prev:
                    if tok[0] == '>':
                        prev['len'] *= long_f
                        broken = short_f
                    else:
                        prev['len'] *= short_f
                        broken = long_f
        out.append((ln_no, events))
    return out


def _expand_repeats(blocks):
    """Unroll |: … :| (with [1 / [2 endings) across the whole tune. Each
    event keeps its source line so lyrics still line up."""
    flat = []
    for ln_no, events in blocks:
        for ev in events:
            flat.append((ln_no, ev))
    out = []
    start = 0            # index in `flat` where the current repeat starts
    i = 0
    passes = {}
    ending = None
    while i < len(flat):
        ln_no, ev = flat[i]
        if ev['t'] == 'bar' and ev['kind'] in ('|:', '[|'):
            start = i + 1
        if ev['t'] == 'ending':
            ending = ev['n']
            pass_no = passes.get(start, 1)
            if ending != pass_no:
                # skip to the next bar line that ends this ending
                j = i + 1
                while j < len(flat) and not (flat[j][1]['t'] == 'bar' and flat[j][1]['kind'] in (':|', '::', ':|:', '||', '|]')):
                    j += 1
                i = j + 1 if j < len(flat) and flat[j][1]['kind'] in (':|', '::', ':|:') else j
                ending = None
                continue
        if ev['t'] == 'bar' and ev['kind'] in (':|', '::', ':|:'):
            out.append((ln_no, {'t': 'bar', 'kind': '|'}))
            if passes.get(start, 1) == 1:
                passes[start] = 2
                i = start
                continue
            if ev['kind'] in ('::', ':|:'):
                start = i + 1
            i += 1
            continue
        out.append((ln_no, ev))
        i += 1
    return out


def _lyric_tokens(text):
    """w: line → tokens: ('syl', text, word_end) | ('hold',) | ('skip',) | ('bar',)."""
    toks = []
    i = 0
    buf = ''
    text = text.strip()
    held = [None]   # index of a syllable whose word end waits on what follows its '_'

    def flush(word_end):
        nonlocal buf
        if buf:
            toks.append(('syl', buf.replace('~', ' ').replace('\\-', '-'), word_end))
            buf = ''

    def settle(word_end):
        # "ka-gi_-ri" continues the word after a hold; "me_ the" ends it.
        if held[0] is not None:
            kind, syl, _end = toks[held[0]]
            toks[held[0]] = (kind, syl, word_end)
            held[0] = None

    while i < len(text):
        c = text[i]
        if c == '\\' and i + 1 < len(text) and text[i + 1] == '-':
            buf += '\\-'
            i += 2
            continue
        if c == ' ' or c == '\t':
            flush(True)
            settle(True)
        elif c == '-':
            if buf:
                flush(False)
            elif held[0] is not None:
                settle(False)
            elif toks and toks[-1][0] == 'syl':
                pass   # "--" : extra hyphen, no new note
            else:
                toks.append(('skip',))
        elif c == '_':
            flush(True)
            if held[0] is None and toks and toks[-1][0] == 'syl':
                held[0] = len(toks) - 1
            toks.append(('hold',))
        elif c == '*':
            flush(True)
            toks.append(('skip',))
        elif c == '|':
            flush(True)
            toks.append(('bar',))
        else:
            buf += c
        i += 1
    flush(True)
    return toks


def parse(text):
    """ABC tune → {'title', 'chart', 'chords', 'grid', 'key', 'warnings'}."""
    warnings = []
    headers = {}
    music = []           # [(line_no, text)]
    lyrics = {}          # music line index → w: text
    body = False
    for no, raw in enumerate((text or '').splitlines(), 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith('%'):
            continue
        m = re.match(r'^([A-Za-z]):\s?(.*)$', line)
        if m and (not body or m.group(1) in 'wWKLMQPTN'):
            key, value = m.group(1), m.group(2).strip()
            if key == 'w':
                if music:
                    idx = len(music) - 1
                    if idx in lyrics:
                        warnings.append(f'Line {no}: a second w: line under the same music is ignored; '
                                        'write each verse out as its own music line.')
                    else:
                        lyrics[idx] = value
                continue
            if key == 'W':
                continue
            if body and key in 'KLMQ':
                music.append((no, f'[{key}:{value}]'))
                continue
            if key in headers and key == 'T':
                continue
            headers[key] = value
            if key == 'K':
                body = True
            continue
        if not body:
            if 'K' not in headers:
                # Forgive a missing K: — the tune starts at the first music line.
                body = True
            else:
                continue
        music.append((no, line))
    if not music:
        raise UserError('The song sheet has no music lines (notes after the K: header).')
    voice = _Voice(headers)
    first_whole = voice.whole
    blocks = _read_events(music, voice, warnings)
    # Map each source line to its music-line index (for lyrics).
    line_index = {no: i for i, (no, _t) in enumerate(music)}
    flat = _expand_repeats(blocks)

    # Walk the timeline.
    t_whole = Fraction(0)
    whole = first_whole
    seconds = 0.0
    notes = []           # {'t','d','p','line','tie'}
    chords = []          # (t_seconds, symbol)
    bar_times = [0.0]
    since_bar = Fraction(0)
    bar_no = 0
    for ln_no, ev in flat:
        if ev['t'] == 'tempo':
            whole = ev['whole']
            continue
        if ev['t'] == 'bar':
            if since_bar > 0:
                bar_no += 1
                # A short first bar is a pickup; anything else should fill the meter.
                if since_bar != voice.bar_len and not (bar_no == 1 and since_bar < voice.bar_len):
                    units = since_bar / voice.unit
                    want = voice.bar_len / voice.unit
                    warnings.append(f'Line {ln_no}: bar {bar_no} has {float(units):g} units, '
                                    f'the meter needs {float(want):g}.')
                bar_times.append(round(seconds, 4))
            since_bar = Fraction(0)
            continue
        if ev['t'] not in ('note', 'rest'):
            continue
        dur = float(ev['len']) * whole
        if ev.get('chord'):
            chords.append((round(seconds, 4), ev['chord']))
        if ev['t'] == 'note':
            prev = notes[-1] if notes else None
            if prev and prev['tie'] and prev['p'] == ev['pitch'] and abs(prev['t'] + prev['d'] - seconds) < 1e-6:
                prev['d'] += dur
                prev['tie'] = ev['tie']
            else:
                notes.append({'t': seconds, 'd': dur, 'p': ev['pitch'], 'tie': ev['tie'],
                              'line': line_index.get(ln_no, 0)})
        seconds += dur
        since_bar += ev['len']
        t_whole += ev['len']
    total = seconds

    # Lyrics: per music line, align tokens to that line's notes in order.
    by_line = {}
    for n in notes:
        by_line.setdefault(n['line'], []).append(n)
    lines = []
    for idx in sorted(by_line):
        ln_notes = by_line[idx]
        toks = _lyric_tokens(lyrics.get(idx, ''))
        k = 0
        sung = []
        prev_syl = None
        for tok in toks:
            if k >= len(ln_notes):
                if tok[0] == 'syl':
                    warnings.append(f'Lyrics line {idx + 1}: more syllables than notes; "{tok[1]}" and after were dropped.')
                break
            if tok[0] == 'bar':
                # jump to the first note of the next bar
                if sung:
                    t_last = ln_notes[k - 1]['t'] if k else 0
                    nb = next((b for b in bar_times if b > t_last + 1e-6), None)
                    while k < len(ln_notes) and nb is not None and ln_notes[k]['t'] < nb - 1e-6:
                        k += 1
                continue
            n = ln_notes[k]
            k += 1
            if tok[0] == 'skip':
                continue
            if tok[0] == 'hold' and prev_syl is not None:
                sung.append({**n, 's': '~'})
                continue
            if tok[0] == 'syl':
                text = tok[1] + (' ' if tok[2] else '')
                sung.append({**n, 's': text})
                prev_syl = text
        if not toks:
            continue       # instrumental line
        if k < len(ln_notes) and toks:
            missing = len(ln_notes) - k
            warnings.append(f'Lyrics line {idx + 1}: {missing} note(s) at the end have no syllable (sung as a held vowel).')
            for n in ln_notes[k:]:
                sung.append({**n, 's': '~'})
        chart_notes = [{'t': round(n['t'], 4), 'd': round(n['d'], 4), 'p': n['p'],
                        's': n['s'], 'k': 'n'} for n in sung]
        # A leading '~' has nothing to hold: make it a plain vowel.
        if chart_notes and chart_notes[0]['s'] == '~':
            chart_notes[0]['s'] = 'ah '
        if chart_notes:
            lines.append({'singer': 1, 'notes': chart_notes, 'start': chart_notes[0]['t'],
                          'end': max(n['t'] + n['d'] for n in chart_notes)})
    if not lines:
        raise UserError('The song sheet has no lyrics: add a w: line under each sung music line.')

    beat_s = float(voice.beat_unit) * first_whole
    bpm = 60.0 / beat_s
    chord_list = []
    for i, (t, sym) in enumerate(chords):
        c = parse_chord(sym)
        if not c:
            warnings.append(f'Chord "{sym}" was not understood and is skipped.')
            continue
        chord_list.append({'t': t, 'symbol': sym, **c})
    for i, c in enumerate(chord_list):
        c['d'] = (chord_list[i + 1]['t'] if i + 1 < len(chord_list) else total) - c['t']
    if not chord_list:
        warnings.append('No chord symbols: the backing will only have drums and bass on the key\'s root.')
    beats = [round(i * beat_s, 4) for i in range(int(total / beat_s + 1e-6) + 1)]
    return {
        'title': headers.get('T', '').strip() or 'Untitled song',
        'composer': headers.get('C', '').strip(),
        'chart': {'lines': lines, 'bpm': round(bpm, 3), 'gap_ms': 0, 'duet': False},
        'chords': chord_list,
        'grid': {'bpm': round(bpm, 2), 'beat': beat_s, 'beats_per_bar': voice.beats_per_bar,
                 'beats': beats, 'downbeats': sorted(set(round(b, 4) for b in bar_times if b <= total)),
                 'duration': round(total, 3)},
        'key': {'tonic': voice.tonic, 'minor': voice.minor, 'text': headers.get('K', 'C')},
        'meter': headers.get('M', '4/4'),
        'duration': total,
        'warnings': warnings,
    }


def midi_name(p):
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return f'{names[p % 12]}{p // 12 - 1}'


def describe(result):
    """One-line summary of a sheet (the song picker's built-in entries)."""
    ch = result['chart']
    notes = [n for ln in ch['lines'] for n in ln['notes']]
    ps = [n['p'] for n in notes if n['p'] is not None]
    return (f"{len(ch['lines'])} sung lines, {len(notes)} notes, range "
            f"{midi_name(min(ps))}–{midi_name(max(ps))}, {result['grid']['bpm']:.0f} BPM, "
            f"{result['meter']}, {math.floor(result['duration'] / 60)}:{int(result['duration'] % 60):02d} long")
