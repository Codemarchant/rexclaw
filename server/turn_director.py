# Copyright 2026 Codemarchant
"""Group-call turn director, Jev edition — who speaks next.

The same job as xai_client.decide_next_speaker, asked the way a judgment
model is meant to be asked (jev.py). The director model gets the rules as
prose and returns one token; this asks what the last message DID and lets
the code rank the answers.

That split is the point. The prose version carries four rules "IN PRIORITY
ORDER", and a generative model re-derives that ranking on every call, under
latency pressure, from scratch — which is the part that comes out
inconsistent, not the judgment underneath it. Here rule 1 beats rule 2 by
construction, because `decide` is an if-chain. TypeSafe's own guidance says
the same: break a decision into atomic questions and combine them with your
own formula, rather than asking one comprehensive one.

The rules themselves are unchanged, and they are Sacks, Schegloff &
Jefferson's (1974) turn-allocation set: the current speaker selects the
next, failing that someone self-selects, failing that whoever held the
floor carries on.

  selects    a yes/no: did the last message turn to one particular person?
             The Choice below always returns a name — it is a closed set —
             so its confidence says "Eve rather than Ara", not "anyone at
             all". This is the question that says "anyone at all", the same
             pair as gesture_director's shows/gesture.
  addressed  a Choice over everyone in the call, the user included. Every
             option is a real key, so the answer is always routable and
             there is no unparseable case to recover from.
  wants      a Choice over the same set: self-selection, read over the whole
             transcript because who is owed a turn is often set up several
             lines back ("so Ara, tell Eve about our date").

THE USER IS ONE OF THE OPTIONS, and that is load-bearing rather than tidy.
An earlier version kept the roster companions-only and asked a separate
yes/no for "does this hand back to the user". After an agent turn the
caller's candidates are the OTHER agents, so in a two-companion call the
Choices had a roster of ONE: both came back at confidence 1.00 naming the
only option they had, which is a tautology, and the entire decision fell
through to that one yes/no. A companion finishing a long story read 0.52 on
it and the floor went to the user in the middle of a conversation. With the
user in the set the real question — them or me — is the one actually being
asked, and a calibrated distribution answers it.

Anything the questions leave ambiguous returns None, which is already a
first-class outcome on this path: the browser falls back to its own local
rules (voice_service._askDirector — user turns keep the floor holder, agent
turns wait).
"""

import re

from . import jev

# A Choice this spread is not a decision. TypeSafe puts the abstain band
# below 0.5 and says to test it against your own data rather than take the
# number; measured over the labelled transcripts this is the floor where
# every wrong route goes away and no right one does.
PICK_FLOOR = 0.5
# The user's option key. Participant keys are browser-minted connection
# ids, and the browser already treats this value as the user (see
# voice_service._askDirector), so it is the one name that cannot be a peer.
USER = 'user'

# The browser formats transcript lines as "[Name]: text".
_LINE_RE = re.compile(r'^\[([^\]]{1,80})\]:\s*(.*)$', re.S)


def options(participants, user_name):
    """{key: name} for the Choices — the caller's roster plus the user."""
    opts = {p['key']: p['name'] for p in participants}
    opts.pop(USER, None)
    opts[USER] = user_name
    return opts


def questions(opts):
    """The question set for one decision. `opts` is options() above, so the
    user is one of the names throughout."""
    names = ', '.join(opts.values())
    return {
        # Rule 1, the gate. "Turns to" rather than "names": someone is
        # selected by being asked something or looked to, not only by having
        # their name said.
        'selects': {
            'type': 'noul',
            'instructions': ('Does `last_message` turn to one particular person of these'
                             f' - {names} - naming them, asking them something, or putting'
                             ' something to them? Talking to everyone, or to nobody in'
                             ' particular, is not this.'),
        },
        # "Turns to", not "is spoken to": when one speaker hands off to
        # another ("Eve, you'd know this one") the speaker is in the option
        # list too, and "spoken to" splits between the two of them - the
        # right name came back at 0.12 confidence, which the floor below
        # then overrode. Naming the ACT instead puts it where it belongs.
        'addressed': {
            'type': 'choice',
            'instructions': ('Who does `last_message` turn to - the one being asked, invited'
                             ' to answer, or called on by name?'),
            'criteria': opts,
        },
        # Rule 2, self-selection, and with the user among the options this
        # is also what decides a handback: a story told for someone else's
        # benefit leaves them the obvious next speaker, a question put to
        # the user leaves the user.
        'wants': {
            'type': 'choice',
            'instructions': ('Going by the conversation so far, and `last_message` most of'
                             ' all, who would naturally speak next?'),
            'criteria': opts,
        },
    }


def _line(text):
    """'[Eve]: hello' -> {'speaker': 'Eve', 'text': 'hello'}. Structured
    rather than passed through as a string, so a question never has to work
    out who said what from punctuation."""
    m = _LINE_RE.match(text)
    return {'speaker': m.group(1), 'text': m.group(2)} if m else {'speaker': '', 'text': text}


def build_state(user_name, participants, transcript, floor_name=None):
    """The one JSON state every question reads. `transcript` is the recent
    lines, oldest first, as the browser formats them."""
    lines = [_line(str(l)) for l in transcript]
    return {
        'call': {
            'user': user_name,
            'companions': [p['name'] for p in participants],
            # Who the user has been talking with, when there is one. Named
            # rather than keyed: the questions are about people.
            'talking_with': floor_name,
        },
        'transcript': lines[:-1],
        'last_message': lines[-1] if lines else {'speaker': '', 'text': ''},
    }


def _pick(answer):
    """A Choice answer → its key, or None when the distribution is too
    spread to be a decision."""
    answer = answer or {}
    pick = answer.get('pick')
    if isinstance(pick, str) and answer.get('confidence', 0) >= PICK_FLOOR:
        return pick
    return None


def decide(answers, opts, floor_key=None):
    """Answers → (key | 'user' | None, reason).

    The ranking the prose used to carry, as code. `reason` names which rule
    fired, so a decision stays distinguishable from a fallback in the logs.
    """
    if not answers:
        return None, 'unparseable'
    # 1. The last speaker selected who goes next.
    if (answers.get('selects') or {}).get('yes', 0) >= jev.YES:
        key = _pick(answers.get('addressed'))
        if key in opts:
            return key, 'selected'
    # 2. Nobody was selected: whoever the conversation leaves the turn to.
    key = _pick(answers.get('wants'))
    if key in opts:
        return key, 'self_selected'
    # 3. Too close to call: whoever the user has been talking with carries
    #    on, which is what the prose rules defaulted to.
    if floor_key in opts:
        return floor_key, 'floor'
    # 4. No floor holder either — the opening of a call, or a turn that has
    #    moved around. Take the leaning even though it is under the gate:
    #    TypeSafe's own advice is to scale the threshold to what being
    #    wrong costs, and here being wrong means a different companion
    #    answers, while abstaining means NOBODY does. There is no local
    #    fallback to catch that case (voice_service._askDirector defaults a
    #    user turn to the floor holder, and there isn't one), so silence is
    #    the worse error by a distance.
    pick = (answers.get('wants') or {}).get('pick')
    if pick in opts:
        return pick, 'leaning'
    return None, 'no_clear_turn'
