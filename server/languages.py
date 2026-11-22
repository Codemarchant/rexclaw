# Copyright 2026 Codemarchant
"""Matching words in any language: one case fold for every script, and the
function words of the language an utterance is written in."""
import sqlite3
import unicodedata

from .language_data import STOPWORDS


def fold(text):
    """`text` as it matches another: case folded in every script (SQLite's
    LOWER, LIKE and NOCASE fold A-Z only, so "Алёна" never met "алёна"),
    composed (NFC), and with ё as е, as most Russian text writes it."""
    if not isinstance(text, str):
        return text
    return unicodedata.normalize('NFC', text.casefold()).replace('ё', 'е')


def install(con):
    """Make fold() callable from SQL on `con` as unicode_fold(). db.connect
    does this as it opens a connection; callers do it too, so any connection
    works. Only once: SQLite refuses to redefine a function while another
    statement on the connection is still open."""
    try:
        con.execute("SELECT unicode_fold('')").fetchone()
    except sqlite3.OperationalError:
        con.create_function('unicode_fold', 1, fold, deterministic=True)


def _stop_key(word):
    key = fold(word)
    # Lucene's Greek list has no accents (GreekLowerCaseFilter), and Greek
    # writing always has them, so a Greek word drops its marks to match.
    if any('\u0370' <= c <= '\u03ff' or '\u1f00' <= c <= '\u1fff' for c in key):
        key = unicodedata.normalize(
            'NFC', ''.join(c for c in unicodedata.normalize('NFD', key) if not unicodedata.combining(c)))
    return key


_STOP = {lang: frozenset(_stop_key(w) for w in words) for lang, words in STOPWORDS.items()}


def detect(words):
    """The language(s) `words` (a text's, lowercased) are written in, by
    their function words; [] for English or when the words don't say.

    The language is the one whose list holds the most of the words, more
    of them than the English list does. The lists hold no English words
    (language_data), but a name can still look like a function word ("Ani"
    is Polish for "nor"), so words in plain A-Z count only two different
    ones together; "что" counts alone. Lists tied for the most count
    together (Russian, Ukrainian and Bulgarian share many words)."""
    keys = [_stop_key(w) for w in words]
    best = sum(k in _STOP['en'] for k in keys)
    langs = []
    for lang, stop in _STOP.items():
        if lang == 'en':
            continue
        found = [k for k in keys if k in stop]
        hits = len(found) if len(set(found)) >= 2 or not all(k.isascii() for k in found) else 0
        if hits > best:
            best, langs = hits, [lang]
        elif hits == best and langs:
            langs.append(lang)
    return langs


def function_words(words):
    """Which of `words` (an utterance's) are function words of the language
    it is written in — "что", "ну", "und" — which match nearly everything
    written in that language. An English utterance keeps every word."""
    langs = detect(words)
    if not langs:
        return set()
    drop = frozenset().union(*(_STOP[lang] for lang in langs))
    return {w for w in words if _stop_key(w) in drop}
