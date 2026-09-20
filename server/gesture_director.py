# Copyright 2026 Codemarchant
"""Speech gesture selector, Jev edition — which clip from the motion
library, if any, fits a line the companion is saying, and which word it
lands on.

The same job as xai_client.select_speech_gesture, asked the way a judgment
model is meant to be asked (jev.py). Where the director model reads the
whole library as prompt text and writes back an id, this is three
questions in one request:

  shows   a yes/no: is there anything in the line a body would show at all?
          Most sentences have none, and this is the question that says so.
  gesture a Choice over the library — the docs' way to extract one of a set
          of candidates the code already holds. Every clip is an option, so
          the answer is always a real id and there is no unknown-id case.
  word    a Choice over the line's own words, for the stroke to land on.
          The browser splits them, so it works in any script.

The two gates are deliberately different questions. `shows` asks whether
the line calls for a gesture; the Choice's own confidence says how well
any ONE clip matches, which is a different thing and low for a line whose
meaning several clips share. Near-identical clips split the vote — four
refusals share the mass of one refusal — so the pick is made on the
probability the library puts on a MOTION FAMILY (the clips' first tag),
not on a single row, and the best member of that family plays.

Unlike the prompt version, "don't repeat what you just did" is not asked
for as a favour: the clip just played is dropped from the options, so it
cannot be picked.
"""

from . import jev

# The family (see the module docstring) must carry at least this much of
# the distribution — the "nothing here fits" case, where the library's
# mass is spread across unrelated motions. Swept over 58 labelled lines
# and two personas: 0.25 removes every line the gate wrongly let through
# without costing a single real gesture, while 0.30 starts dropping them
# (a genuine "it actually worked!" sits at 0.27). Uniform over a 66-clip
# library is 0.015, so even this is ~16x chance.
FAMILY_FLOOR = 0.25
# Lines longer than this in words get no word question (its options would
# crowd the request); the gesture plays from the start of the line, which
# is what a pick with no word does anyway.
MAX_WORDS = 40
# Only the clip that just played is kept off the menu, not the last few.
# Widening it looked necessary while a long reply was repeating a clip
# back to back, but that turned out to be session_service slicing the
# recent list from the wrong end, so "just played" was not the clip that
# just played. With that fixed, excluding one and excluding three give
# the same picks on the demo script — so one it is.


def options(candidates, exclude=()):
    """{clip id: 'motion (tags)'} for the Choice, one row per distinct
    motion — libraries carry several takes of the same gesture and the
    caller spreads plays across them (motion_library.speech_gesture_variants).

    Sorted by family so related motions sit together, which is how the
    library's rows read as a list, and `exclude` drops ids outright (the
    clip just played).
    """
    best = {}
    for clip in candidates.values():
        key = (clip.get('en') or '').strip().lower()
        if key and key not in best:
            best[key] = clip
    rows = sorted(best.values(), key=lambda c: (family(c), c.get('en') or ''))
    return {c['id']: _describe(c) for c in rows if c['id'] not in set(exclude)}


def family(clip):
    """The motion's family: its first tag. Clips inside one are alternative
    ways to say the same thing (four ways to refuse, three to thank)."""
    return (clip.get('tags') or [''])[0]


def _describe(clip):
    tags = ', '.join(clip.get('tags') or [])
    return f"{clip['en']} ({tags})" if tags else clip['en']


def questions(name, opts, words=None):
    """The question set for one spoken line. `opts` is options() above."""
    qs = {
        # The gate, and the question that does the real work: most
        # sentences get no gesture. Naming the quiet end of the range
        # ("giving up", "weighing it over") is worth 4 lines in 58 against
        # the same question without them — without it the reader takes the
        # question to mean an emphatic display and passes over a shrug at
        # "I don't know, I really don't" or a pensive tilt at "let me
        # think", which are the most common co-speech gestures there are.
        'shows': {'type': 'noul',
                  'instructions': (f'Is there something in `line` that {name} would show with their'
                                   ' hands or body as they say it - thanks, refusal, delight, giving'
                                   ' up, weighing it over, pointing something out? Plainly stated'
                                   ' information is not this.')},
        'gesture': {'type': 'choice',
                    'instructions': f'Which of these body motions fits what {name} is doing in `line`?',
                    'criteria': opts},
    }
    words = [str(w) for w in (words or []) if str(w).strip()]
    if 0 < len(words) <= MAX_WORDS:
        # "(word n)" keeps a repeated word ("no, no") two different options.
        qs['word'] = {
            'type': 'choice',
            'instructions': (f'Which word in `line` carries what {name} means most'
                             ' - the word a hand movement would land on?'),
            'criteria': {f'w{i}': f'"{w}" (word {i + 1})' for i, w in enumerate(words)},
        }
    return qs


def build_state(name, persona, conversation, line):
    """The one JSON state every question reads. `conversation` is
    [(speaker, text)], oldest first."""
    return {
        'character': {'name': name, 'personality': persona},
        'conversation': [{'speaker': s, 'text': t} for s, t in conversation],
        'line': line,
    }


def choose(answers, candidates, opts):
    """Answers → (clip id or None, word index or None, reason).

    `reason` names why there is no gesture, since most lines legitimately
    get none and a selector that is declining must stay distinguishable
    from one that is broken.
    """
    if not answers:
        return None, None, 'unparseable'
    if answers.get('shows', {}).get('yes', 0) < jev.YES:
        return None, None, 'nothing_to_show'
    probs = (answers.get('gesture') or {}).get('probs') or {}
    if not probs:
        return None, None, 'unparseable'
    # Mass per family, then the likeliest clip inside the best family.
    mass = {}
    for cid, p in probs.items():
        clip = candidates.get(cid)
        if clip:
            mass[family(clip)] = mass.get(family(clip), 0) + p
    if not mass:
        return None, None, 'unparseable'
    best = max(mass, key=mass.get)
    if mass[best] < FAMILY_FLOOR:
        return None, None, 'no_clear_fit'
    inside = {cid: p for cid, p in probs.items()
              if cid in opts and family(candidates.get(cid) or {}) == best}
    if not inside:
        return None, None, 'no_clear_fit'
    gesture = max(inside, key=inside.get)
    pick = (answers.get('word') or {}).get('pick')
    word = int(pick[1:]) if isinstance(pick, str) and pick.startswith('w') and pick[1:].isdigit() else None
    return gesture, word, None
