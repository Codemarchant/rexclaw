# Copyright 2026 Codemarchant
"""Text between the brain and the voice: streaming sentence chunking, and
the Grok speech tags ([laugh], <whisper>…</whisper>) a reply may carry.

The tag set is xAI's (docs.x.ai → Text to Speech, the same list the voice
prompt's "Speech expression tags" section teaches). A voice that renders
them gets them; every other voice, and every transcript, gets them removed.
"""
import re

INLINE_TAGS = ('pause', 'long-pause', 'hum-tune', 'laugh', 'chuckle', 'giggle', 'cry',
               'tsk', 'tongue-click', 'lip-smack', 'breath', 'inhale', 'exhale', 'sigh')
WRAP_TAGS = ('soft', 'whisper', 'loud', 'build-intensity', 'decrease-intensity',
             'higher-pitch', 'lower-pitch', 'slow', 'fast', 'sing-song', 'singing', 'emphasis')

_INLINE_RE = re.compile(r'\s*\[(?:%s)\]' % '|'.join(map(re.escape, INLINE_TAGS)), re.IGNORECASE)
_WRAP_RE = re.compile(r'<(/?)(%s)>' % '|'.join(map(re.escape, WRAP_TAGS)), re.IGNORECASE)
_THINK_OPEN, _THINK_CLOSE = '<think>', '</think>'

# Kana, kanji and hangul: text written without spaces between words.
CJK_CHARS = r'぀-ヿ㐀-鿿가-힯'
_CJK_CHAR = re.compile(f'[{CJK_CHARS}]')

# Sentence ends: Latin punctuation followed by a space (or a closing quote /
# bracket / wrapping tag and then a space), CJK full stops on their own, and
# line breaks. Japanese also ends sentences with half-width ?! and with … or
# ～ straight before the next word ("本当?すごい!", "そうか…じゃあ"; AIRI's
# tts-chunker counts …～ as sentence ends too).
_CLOSERS = r'(?:["\'”’)\]]|</[a-z-]+>)*'
_BOUNDARY = re.compile(r'[.!?…]+%s(?=\s)|[!?…～〜]+%s(?=[%s])|[。！？]+(?:[」』”’）]|</[a-z-]+>)*|\n+'
                       % (_CLOSERS, _CLOSERS, CJK_CHARS))
# A reply's first chunk may also end at a clause break, so the voice starts
# on "Once upon a time," instead of waiting for a long first sentence.
_CLAUSE = re.compile(r'[,;:—]+%s(?=\s)|[、，；：]+' % _CLOSERS)
# "Mr. Smith", "e.g. this", "J. R. R." — a full stop that isn't an ending.
_ABBREV = re.compile(r'(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|no)|\b[A-Z])\.$',
                     re.IGNORECASE)
# LiveKit Agents' sentence tokenizer default (min_sentence_len=20): shorter
# pieces join the next sentence, so "Oh!" doesn't become its own TTS call
# with its own prosody reset. 20 characters is about four English words —
# AIRI's tts-chunker minimum is four words too — and a CJK character counts
# double (_chunk_len), as Japanese words run about two characters: 20 kana
# would be some three seconds of speech before the voice could start.
MIN_CHUNK_CHARS = 20


def _chunk_len(text):
    text = strip_speech_tags(text)
    return len(text) + len(_CJK_CHAR.findall(text))


_TAG_FORMS = tuple([f'[{t}]' for t in INLINE_TAGS] + [f'<{t}>' for t in WRAP_TAGS]
                   + [f'</{t}>' for t in WRAP_TAGS])


def partial_tag_at(text):
    """Where a speech tag still being written ends `text` ("…<whis",
    "…[laug"), or -1. Only a real tag's beginning counts: an "I <3 you"
    must not hold back the rest of the reply."""
    for opener in '<[':
        at = text.rfind(opener)
        if at >= 0:
            tail = text[at:].lower()
            if any(len(tail) < len(form) and form.startswith(tail) for form in _TAG_FORMS):
                return at
    return -1


def strip_speech_tags(text):
    """Text as it would be heard, for transcripts and tagless voices."""
    text = _INLINE_RE.sub('', text or '')
    text = _WRAP_RE.sub('', text)
    return re.sub(r'[ \t]{2,}', ' ', text).strip()


_CITATION = re.compile(r'\[\[?\d+\]?\](?:\([^)\s]*\))?')      # [[2]](https://…), [3]
_MD_LINK = re.compile(r'\[([^\]\[]*)\]\([^)\s]*\)')            # [text](https://…) → text
_URL = re.compile(r'\b(?:https?://|www\.)\S+')
_LIST_MARK = re.compile(r'^\s*(?:[-•]|\d+[.)])\s+', re.MULTILINE)
_HEADING = re.compile(r'^\s*#+\s*', re.MULTILINE)


def speakable(text):
    """Chat formatting a voice would read out loud: links, citations,
    list and heading markers, emphasis. Text for a voice passes through a
    filter like this in any cascaded pipeline (Pipecat's MarkdownTextFilter).
    Only what is spoken: the transcript keeps the text as written
    (Sentence.written)."""
    text = _CITATION.sub('', text)
    text = _MD_LINK.sub(r'\1', text)
    text = _URL.sub('', text)
    text = _LIST_MARK.sub('', text)
    text = _HEADING.sub('', text)
    text = text.replace('*', '').replace('`', '').replace('__', '')
    text = re.sub(r'[ \t]+([.,!?;:])', r'\1', text)   # "make [1]." → "make."
    return re.sub(r'[ \t]{2,}', ' ', text).strip()


class ThinkFilter:
    """Reasoning models served locally (Qwen3, DeepSeek-R1) write their
    thinking inside <think>…</think> in the reply stream. feed() returns
    only the reply, so thinking is never spoken, shown or kept."""

    def __init__(self):
        self._in_think = False
        self._carry = ''

    def feed(self, delta):
        delta, self._carry = self._carry + delta, ''
        out = ''
        while delta:
            marker = _THINK_CLOSE if self._in_think else _THINK_OPEN
            at = delta.find(marker)
            if at < 0:
                # A marker split across deltas ("<thi" + "nk>") waits for
                # the rest before anything around it is used.
                for n in range(len(marker) - 1, 0, -1):
                    if delta.endswith(marker[:n]):
                        self._carry, delta = delta[-n:], delta[:-n]
                        break
                if not self._in_think:
                    out += delta
                break
            if not self._in_think:
                out += delta[:at]
            delta = delta[at + len(marker):]
            self._in_think = not self._in_think
        return out

    def flush(self):
        out = '' if self._in_think else self._carry
        self._carry = ''
        return out


_CUE = re.compile(r'\[\s*([a-z_]+)\s*[:(]\s*["\']?([^\]\)"\']*?)["\']?\s*\)?\s*\]')
_CUE_START = re.compile(r'\[\s*[a-z_]*(?:\s*[:(][^\]\n]{0,80})?')   # a cue not yet closed


class CueFilter:
    """Avatar tool calls a model writes into its reply instead of making
    them — "[set_emotion: happy]", "[play_gesture(spin)]". Text models do
    this on an expressive voice prompt, local ones especially; cascaded
    companion apps (Open-LLM-VTuber, AITuberKit) take inline emotion tags as
    their protocol. `tools` maps a tool name to its one argument; a cue
    naming one comes out as ('cue', name, {arg: value}) at its place in the
    reply and is never spoken. Anything else — speech tags included —
    passes through as ('text', ...)."""

    def __init__(self, tools):
        self.tools = tools
        self._buf = ''

    def feed(self, text):
        self._buf += text
        # An unclosed bracket may be the start of a cue: wait for the rest
        # (only while it still reads like one, so a stray "[" doesn't hold
        # back the reply).
        at = self._buf.rfind('[')
        hold = at if at > self._buf.rfind(']') and _CUE_START.fullmatch(self._buf, at) else len(self._buf)
        ready, self._buf = self._buf[:hold], self._buf[hold:]
        return self._split(ready)

    def flush(self):
        ready, self._buf = self._buf, ''
        return self._split(ready)

    def _split(self, text):
        out, pos = [], 0
        for m in _CUE.finditer(text):
            arg = self.tools.get(m.group(1))
            if not arg:
                continue
            if text[pos:m.start()]:
                out.append(('text', text[pos:m.start()]))
            out.append(('cue', m.group(1), {arg: m.group(2).strip()}))
            pos = m.end()
        if text[pos:]:
            out.append(('text', text[pos:]))
        return out


class Sentence(str):
    """A chunk as the voice speaks it (the str itself: speakable() applied)
    with `.written`, the same words as the brain wrote them — links,
    citations and formatting intact — for the transcript and the brain's
    own context. Either may be empty: a bare link says nothing."""
    written = ''

    def __new__(cls, spoken, written):
        obj = super().__new__(cls, spoken)
        obj.written = written
        return obj


class SentenceChunker:
    """Feed streamed reply text in, get whole sentences out as soon as they
    are complete — each becomes one TTS request, so speech starts after the
    first sentence instead of the whole reply. Each comes out as a
    Sentence: what is spoken, and what was written.

    With `keep_tags` (a voice that renders Grok's speech tags), a wrapping
    tag left open at a chunk boundary is closed there and reopened at the
    start of the next chunk: each chunk is a separate TTS request and must
    be well-formed on its own. Nothing the brain writes is removed either
    way: another voice isn't taught Grok's tags, so any it gets were meant.
    """

    def __init__(self, keep_tags=True, min_chars=MIN_CHUNK_CHARS):
        self.keep_tags = keep_tags
        self.min_chars = min_chars
        self._buf = ''
        self._open = []           # wrapping tags open at the start of _buf
        self._first = True        # no chunk out yet: clause breaks count too

    def feed(self, delta):
        self._buf += delta
        return self._take(final=False)

    def flush(self):
        return self._take(final=True)

    def _take(self, final):
        chunks = []
        while True:
            cut = self._next_cut()
            if cut is None:
                break
            chunks.append(self._emit(self._buf[:cut]))
            self._buf = self._buf[cut:].lstrip()
            self._first = self._first and not chunks[-1]
        if final and self._buf.strip():
            chunks.append(self._emit(self._buf))
            self._buf = ''
        return [c for c in chunks if c or c.written]

    def _next_cut(self):
        cuts = list(_BOUNDARY.finditer(self._buf))
        if self._first:
            cuts = sorted(cuts + list(_CLAUSE.finditer(self._buf)), key=lambda m: m.end())
        for m in cuts:
            end = m.end()
            piece = self._buf[:end]
            if _chunk_len(piece) < self.min_chars:
                continue
            if m.group().startswith('.') and _ABBREV.search(self._buf[:m.start() + 1]):
                continue
            # Never cut inside a tag still being written ("<whis" … "per>").
            if partial_tag_at(piece) >= 0:
                continue
            # Nor inside square brackets: a voice's own cue can hold a
            # comma ("[soft, tired voice]", Fish Audio). Only a recent
            # bracket counts, so one that never closes can't hold the rest.
            opened = piece.rfind('[')
            if opened > piece.rfind(']') and end - opened <= 80:
                continue
            return end
        return None

    def _emit(self, piece):
        if not self.keep_tags:
            return Sentence(speakable(piece), piece.strip())
        opened = list(self._open)
        for m in _WRAP_RE.finditer(piece):
            name = m.group(2).lower()
            if m.group(1):
                if name in opened:
                    opened.reverse()
                    opened.remove(name)
                    opened.reverse()
            else:
                opened.append(name)
        head = ''.join(f'<{t}>' for t in self._open)
        tail = ''.join(f'</{t}>' for t in reversed(opened))
        self._open = opened
        text = head + piece.strip() + tail
        return Sentence(speakable(text), text)
