# Copyright 2026 Codemarchant
"""Face director: what the companion's face and head do while they speak,
and as they hear the user.

One call per spoken sentence (the browser sends them as the reply streams
in, timed by the motion director), plus one as the user's words come in
(the listening face). session_service.face_director_select runs it; the
renderer turns the answers into a face, head movements and a posture. It
sits UNDER the companion's own set_emotion: that stays the big whole-face
beat for a real shift in mood, and this is the constant movement between.

What it asks is what the line MEANS, never what a muscle does: the feeling
behind it, how strongly that shows, and the few things a line can do that
bodies answer in fixed ways — a question lifts the brows and waits for the
answer, a "no" shakes the head, a "yes" nods, an "everyone" sweeps, a
search for a word looks away — and which of the line's words each of those
lands on. The renderer maps them to motion with published numbers. Asked
instead "do the eyes narrow a little?", a judgment model finds that
plausible for most lines: an earlier version did, and its faces squinted
and flicked their brows on nearly every sentence.

TypeSafe's Jev answers, and only Jev: every question goes in one request
and comes back in parallel, ~250-300 ms whether it holds one question or
nineteen, with a calibrated probability per option. The feeling keeps that
whole distribution — a line mostly fond and a little amused gets the blend
— a yes/no counts at 0.5 (the docs' threshold example), and magnitudes are
never read between a Score's levels, which the docs warn against.

The director model answered the same questions until this was measured
against it: 1.4-1.6 s a line, where the face is handed over 890 ms BEFORE
its line is spoken, and a heavy yes: nineteen judgments in one JSON reply
came back with acts on lines that have none ("affirms" on a pressure
reading). The engine switch went with it — this feature needs a TypeSafe
key, and says so.
"""

import re

from .jev import YES

# A feeling this unlikely is noise, not a shade of the line's feeling.
FEELING_FLOOR = 0.2
# A word the line's acts land on is taken at the docs' confidence floor;
# below it the move goes at the start of the line. The stressed word is
# always taken: it is a judgment with no wrong answer, only better ones.
PICK_FLOOR = 0.5
# Lines longer than this in words get no word questions (their options
# would crowd the request; the moves go at the line's start instead).
MAX_WORDS = 40

# The feelings, named the way people name them. The renderer builds each
# from the avatar's own VRM expressions (happy / relaxed / sad / angry /
# surprised) plus whatever finer shapes the model carries — this set is
# what those can show between them. Teasing, flustered embarrassment and
# the huffy "hmph" are the anime-style displays: the characters are anime
# characters, and Jev reads them off the persona as well as the line.
FEELINGS = {
    'calm': 'Calm or matter-of-fact - no particular feeling',
    'warm': 'Warm, fond, tender or grateful',
    'happy': 'Happy, cheerful or amused',
    'teasing': 'Teasing, playful or mischievous',
    'excited': 'Excited, thrilled or delighted',
    'proud': 'Proud, confident or smug',
    'interested': 'Interested or curious',
    'puzzled': 'Puzzled, unsure or thinking hard',
    'surprised': 'Surprised, amazed or caught off guard',
    'embarrassed': 'Embarrassed, flustered, shy or sheepish',
    'huffy': 'Huffy or pouting - acting cross without meaning it, "hmph"',
    'worried': 'Worried, anxious or nervous',
    'sad': 'Sad, hurt, sorry or disappointed',
    'annoyed': 'Annoyed, irritated, frustrated or angry',
}
# Feelings a face can't hold at once: a laugh over a glare reads as a broken
# face, not a mixed one. Warm stays possible beside sad or worried — a sorry,
# sympathetic smile is real — but not beside annoyed.
_BRIGHT = {'happy', 'teasing', 'excited', 'proud'}
_DARK = {'worried', 'sad', 'annoyed'}
_CLASHES = [(_BRIGHT, _DARK), ({'warm'}, {'annoyed'})]

# The word each act's head move lands on, asked as a Choice over the line's
# own words (the browser splits them, in any language) — the docs' way to
# extract: code lists the candidates, the model picks one.
WORD_QUESTIONS = {
    'negates': 'Which word in `line` says no, denies or refuses?',
    'affirms': 'Which word in `line` says yes, agrees or confirms?',
    'inclusive': 'Which word in `line` means everyone, everything or always?',
    'contrasts': 'Which word in `line` turns to the other side of the matter - but, however, instead?',
}


def questions(name, listening=False, words=None):
    """The question set, for a line the companion says (`line`) or one they
    hear (`user_line`). Choice criteria are {id: text}, Score criteria
    [(id, level)] lowest first; the ids are for code, Jev sees only the
    words. Each is one literal judgment about the line.
    `words` are the spoken line's words, in order, for the word Choices."""
    if listening:
        return {
            'feeling': {
                'type': 'choice',
                'instructions': f'Which feeling does hearing `user_line` stir in {name}?',
                'criteria': {k: v for k, v in FEELINGS.items() if k != 'proud'},
            },
            'shows': _shows(name, 'as they hear `user_line`'),
            'asked': {'type': 'noul', 'instructions': f'Does `user_line` ask {name} a question?'},
            'agrees': {'type': 'noul', 'instructions': f'Does {name} agree with or like what `user_line` says?'},
            # A listener's brow raise on being told something (Chovil 1991;
            # Dix & Groß 2023 — see face_motion.js for what the raise does
            # and why it is a flash rather than a hold).
            #
            # The trap here is that the obvious wording is right and
            # useless: asked as "does `user_line` tell {name} something
            # they did not already know", it fires on half of all turns,
            # because half of all turns ARE informings. That is a true
            # answer and a twitchy face. Asked as "does it tell them
            # something they did not know, and is it not a question", it
            # still takes 10-12 of 23 and receipts "talk in a bit".
            #
            # What works is naming the KIND of thing worth receipting and
            # ruling out the three near neighbours by name: routine chat,
            # details of something already said, and goodbyes. That puts it
            # at 6-7 turns in 23 across two personas, on the decisions, the
            # plans, the booked trip and the admission of nerves, with all
            # four questions (0.13-0.48), every backchannel ("Rude!" 0.17,
            # "thanks, that helps" 0.15) and both closings ("talk in a bit"
            # 0.06) left alone. Wordings without "details of something
            # already said" receipt each half of one piece of news twice.
            'learns': {'type': 'noul',
                       'instructions': (f'Does `user_line` bring {name} something new that matters'
                                        ' - news, a decision, a change of plan, something the person'
                                        ' reveals about themselves? Routine chat, questions, details'
                                        ' of something already said, and goodbyes are not this.')},
        }
    qs = {
        'feeling': {
            'type': 'choice',
            'instructions': f'Which feeling does {name} have while saying `line`?',
            'criteria': FEELINGS,
        },
        'shows': _shows(name, 'while saying `line`'),
        'asks': {'type': 'noul',
                 'instructions': 'Does `line` ask the listener a question or invite them to answer?'},
        'negates': {'type': 'noul',
                    'instructions': f'Does {name} say no, deny, refuse or disagree in `line`?'},
        'affirms': {'type': 'noul',
                    'instructions': f'Does {name} say yes, agree or confirm something in `line`?'},
        'stresses': {'type': 'noul',
                     'instructions': f'Does {name} stress a point hard or exclaim in `line`?'},
        'unsure': {'type': 'noul',
                   'instructions': f'Is {name} unsure or hedging in `line` - guessing, or saying maybe or I think?'},
        'recalls': {'type': 'noul',
                    'instructions': (f'Does {name} stop to search their memory or think in `line`'
                                     ' - like "let me think", "hmm" or "what was it"?')},
        # The other end of `recalls`: that one is the search, this is the
        # find. A moment rather than a mood, which is why it is asked as an
        # act and shows as a mark rather than joining FEELINGS - there is
        # no "realisation" mood, and adding one would only compete with
        # puzzled and surprised in the same Choice.
        #
        # Narrower than it first looks, because the mark it fires is the
        # manga lightbulb, and that glyph means one specific thing: the
        # sudden idea, the ピコーン. Conversation analysis separates two
        # things this wording has to keep apart - a change of state of
        # knowledge (Heritage 1984's "oh": learning something, including
        # from the other person) and the COGNITIVE kind of it, the one
        # German marks with "ach" rather than "oh". Only the second is a
        # lightbulb.
        #
        # So the four things it is NOT are all ruled out by name, and each
        # one is there because a wording without it lit the bulb somewhere
        # wrong. "Still looking for it" - asked as "does something occur to
        # them", the word search "let me think, what was the other thing"
        # read 0.63, which is the SEARCH and belongs to `recalls` above.
        # "Being told it" - Heritage's "oh" again. "Announcing they have
        # one" - "leave the next one to me, I've got ideas", 0.56. "Saying
        # how something turned out" - asked as "arrive at something", "it
        # actually worked on the first take!" read 0.62 and the bulb lit
        # over a verdict. With all four, those sit at 0.17, 0.18 and 0.18
        # while a real find ("hang on, I've got it") stays at 0.66; over 14
        # labelled lines no wrong answer reaches 0.26.
        'realises': {'type': 'noul',
                     'instructions': (f'In `line`, does {name} suddenly SEE the answer or the idea,'
                                      ' having not seen it a moment ago? The instant it lands - "oh!",'
                                      ' "hang on", "that\'s it", "of course". Still looking for it,'
                                      ' being told it, announcing they have one, or saying how'
                                      ' something turned out, are all not this.')},
        'inclusive': {'type': 'noul',
                      'instructions': ('Does `line` talk about everyone, everything, always,'
                                       ' or a whole range of things?')},
        'contrasts': {'type': 'noul',
                      'instructions': ('Does `line` set one thing against another'
                                       ' - but, however, instead, on the other hand?')},
        'lists': {'type': 'noul',
                  'instructions': 'Does `line` run through a list of things, or weigh up alternatives?'},
        'obliges': {'type': 'noul',
                    'instructions': ('Does `line` say something has to happen'
                                     ' - must, need to, should, have to?')},
        'checks': {'type': 'noul',
                   'instructions': ('Does `line` check the listener is with them'
                                    ' - you know?, right?, yeah?, see what I mean?')},
        # A wink is an emblem with a settled meaning: an aside to one
        # person carrying what the words do not say - "take this as a
        # joke", "this is between us" (Ekman & Friesen's emblems; a wink
        # "quietly send[s] a message that third parties are not aware of").
        # So the question is whether the line is SIGNALLED rather than
        # said, and each clause below was earned by a measured misfire.
        #
        # Asking what the line CARRIES, rather than "would they wink",
        # dropped plain lines from 0.31 to 0.08. Asking for what is NOT
        # SAID ALOUD separated an aside from a mock refusal. Ruling out
        # what MEANS EXACTLY WHAT IT SAYS dropped sincere affection from 1
        # line in 6 to none - without it an affectionate conversation
        # winked every third sentence, because "a bit of flirting" reads as
        # true of anything fond - and "however much the two of them share
        # the reference" is what finally settled "we are not doing the
        # dance again", whose whole pull was the shared history.
        #
        # The last clause is about SINCERITY, and it is there because the
        # first three are all about audience: an aside for one person,
        # something kept between them. A sincere confidence satisfies every
        # one of those structurally - "I'm a little nervous about how this
        # reads to people" sets an in-group against an out-group exactly
        # the way an aside does, and read 0.49, close enough to fire on a
        # good day. Naming sincerity puts it at 0.42 and a confession ("a
        # long stretch where none of this worked") at 0.31, while the real
        # asides hold at 0.69.
        #
        # NOTE for anyone retuning this: measure with the conversation
        # context the server actually sends. Every threshold here moves by
        # ~0.05-0.10 between an empty `conversation` and a populated one,
        # which is the difference between these lines firing and not.
        'winks': {'type': 'noul',
                  'instructions': (f'Does `line` carry something {name} is NOT saying out loud - an aside'
                                   ' meant for this person only, a joke flagged as a joke, something kept'
                                   ' between the two of them? A line that means exactly what it says is'
                                   ' not this, however fond, however playful, and however much the two of'
                                   ' them share the reference. Saying something sincerely, however'
                                   ' private, is not this either.')},
    }
    words = [str(w) for w in (words or []) if str(w).strip()]
    if 0 < len(words) <= MAX_WORDS:
        # "(word n)" keeps a repeated word ("no, no") two different options.
        options = {f'w{i}': f'"{w}" (word {i + 1})' for i, w in enumerate(words)}
        qs['stress_word'] = {
            'type': 'choice',
            'instructions': f'Which word in `line` does {name} stress most when saying it?',
            'criteria': options,
        }
        for act, text in WORD_QUESTIONS.items():
            qs[f'{act}_word'] = {'type': 'choice', 'instructions': text,
                                 'criteria': {'none': 'None of them', **options}}
    return qs


def _shows(name, when):
    return {
        'type': 'score',
        'instructions': f"How much does that feeling show on {name}'s face {when}?",
        'criteria': [
            ('none', 'None - their face stays neutral'),
            ('light', 'A light trace of it shows'),
            ('clear', 'It clearly shows on their face'),
            ('strong', 'It takes over their face - laughing, crying, glaring or gasping'),
        ],
    }


# ── State ──────────────────────────────────────────────────────────────

_SECTION_RE = re.compile(r'^#+\s*(.+?)\s*$', re.M)
_PERSONA_SECTIONS = ('identity', 'personality')
_PERSONA_FALLBACK_CHARS = 1200


def persona_excerpt(prompt):
    """Who the character is, for reading their reactions: the persona's
    Identity and Personality sections when it has them, else its opening.
    The rest of a companion prompt (conduct, tool habits, style rules) is
    unrelated to how a face reacts, and unrelated state costs a judgment
    model accuracy."""
    prompt = prompt or ''
    heads = list(_SECTION_RE.finditer(prompt))
    parts = []
    for i, m in enumerate(heads):
        if m.group(1).strip().lower() in _PERSONA_SECTIONS:
            end = heads[i + 1].start() if i + 1 < len(heads) else len(prompt)
            parts.append(prompt[m.end():end].strip())
    text = '\n'.join(p for p in parts if p) or prompt[:_PERSONA_FALLBACK_CHARS]
    return text.strip()


def build_state(name, persona, conversation, line, listening=False, partial=False):
    """The one JSON state every question reads. `conversation` is
    [(speaker, text)], oldest first. `partial`: the user is still speaking
    and `user_line` is what they have said so far."""
    state = {
        'character': {'name': name, 'personality': persona},
        'conversation': [{'speaker': s, 'text': t} for s, t in conversation],
    }
    state['user_line' if listening else 'line'] = line
    if listening and partial:
        state['user_line_status'] = 'still speaking - what they have said so far'
    return state


# ── The renderer's shape ───────────────────────────────────────────────

def blend(probs):
    """A feeling distribution → {feeling: share} summing to 1, or {} when
    the line carries none. Noise below FEELING_FLOOR goes; of two feelings
    a face can't hold at once, the less likely side goes; calm stays in as
    a share with nothing to show, so a line that is half calm shows half
    as much."""
    kept = {k: p for k, p in probs.items() if p >= FEELING_FLOOR}
    for a, b in _CLASHES:
        pa = sum(p for k, p in kept.items() if k in a)
        pb = sum(p for k, p in kept.items() if k in b)
        if pa and pb:
            loser = b if pa >= pb else a
            kept = {k: p for k, p in kept.items() if k not in loser}
    total = sum(kept.values())
    if not total or max(kept, key=kept.get) == 'calm':
        return {}
    return {k: round(p / total, 3) for k, p in kept.items() if k != 'calm'}


def normalize(answers, qs):
    """Answers → {top, feelings, level, acts, words}, or None when the line
    was not read at all.

    top: the likeliest feeling id (for logs and posture), or None.
    feelings: {feeling: share} — see blend. Empty when calm or not showing.
    level: 0 none .. 3 strong — how much the feeling shows.
    acts: the yes/no questions answered yes, e.g. ['asks', 'negates'].
    words: {'stress' | act: index into the line's words} — where the
        stress and each act's head move land, when the line was asked.
    """
    if not answers:
        return None
    probs = answers.get('feeling', {}).get('probs') or {}
    level = min(3, max(0, answers.get('shows', {}).get('level', 0)))
    feelings = blend(probs) if level else {}
    acts = [qid for qid, q in qs.items() if q['type'] == 'noul'
            and answers.get(qid, {}).get('yes', 0) >= YES]
    words = {}
    for key, qid, floor in [('stress', 'stress_word', 0)] + [(a, f'{a}_word', PICK_FLOOR) for a in WORD_QUESTIONS]:
        a = answers.get(qid) or {}
        pick = a.get('pick')
        if isinstance(pick, str) and pick.startswith('w') and pick[1:].isdigit() and a.get('confidence', 0) >= floor:
            words[key] = int(pick[1:])
    return {
        'top': max(feelings, key=feelings.get) if feelings else None,
        'feelings': feelings,
        'level': level if feelings else 0,
        'acts': acts,
        'words': words,
    }
