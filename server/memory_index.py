# Copyright 2026 Codemarchant
"""Read-only ranked retrieval over the durable archive, maintained by SQLite.

Deliberate recall keeps its existing ranking. This index serves speculative
recall without updating last_used_at or loading whole transcripts into Python.
"""
import itertools
import logging
import re
import sqlite3
import time
import unicodedata

_logger = logging.getLogger(__name__)
STOP = set('i me my we our you your the a an and or to of in on is are was were '
           'it its this that for with has have had be been again another can '
           'do did how what when where im ive going got here just about'.split())
# How long a memory rests after being used. A callback wears out by repetition,
# so this expires rather than holding for good, and a session resumed for months
# never loses a memory permanently. Longer than the weekly cadence users report
# as repetitive; an experimental default, to revisit from real logs.
REPEAT_AFTER_DAYS = 14
# The most candidates a caller may ask for. A candidate's place in the request
# does not move its answer within this span, and judging more of them costs
# one question each.
CANDIDATE_MAX = 8
# The latest words of an utterance retrieval reads.
WORDS_MAX = 32
# Tags that put a memory out of reach of a spontaneous callback, whatever it
# matches: a ritual the user ended, text they quoted rather than lived, and a
# session spent operating the app rather than living a life. The last one earns
# its place on a developer's own archive, where testing sessions outnumber
# everything else and a cue like "get mad at me again" finds the last time the
# feature was exercised.
VETO_TAGS = ('retired', 'quoted-content', 'operational')


def vetoed_by_tags(tags):
    """Is this memory tagged out of spontaneous recall? (Deliberate recall is
    unaffected: asked directly, the companion should still find it.)"""
    written = ',' + (tags or '').replace(' ', '').lower() + ','
    return any(f',{tag},' in written for tag in VETO_TAGS)


def initialize(con):
    """Install triggers on existing archives and backfill once, after migrations."""
    existed = con.execute("SELECT 1 FROM sqlite_master WHERE name='memory_recall_fts'").fetchone()
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_fts USING fts5("
                    "keywords,content,transcript,content='memories',content_rowid='id',tokenize='unicode61')")
    except sqlite3.OperationalError as exc:
        if 'no such module' not in str(exc).lower():
            raise
        _logger.warning('Live memory recall unavailable: SQLite has no FTS5')
        return
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_recall_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_recall_fts(rowid,keywords,content,transcript)
        VALUES(new.id,new.keywords,new.content,new.transcript); END""")
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_recall_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memory_recall_fts(memory_recall_fts,rowid,keywords,content,transcript)
        VALUES('delete',old.id,old.keywords,old.content,old.transcript); END""")
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_recall_update
        AFTER UPDATE OF keywords,content,transcript ON memories BEGIN
        INSERT INTO memory_recall_fts(memory_recall_fts,rowid,keywords,content,transcript)
        VALUES('delete',old.id,old.keywords,old.content,old.transcript);
        INSERT INTO memory_recall_fts(rowid,keywords,content,transcript)
        VALUES(new.id,new.keywords,new.content,new.transcript);
        UPDATE memories SET recall_revision=old.recall_revision+1 WHERE id=new.id; END""")
    if not existed:
        con.execute("INSERT INTO memory_recall_fts(memory_recall_fts) VALUES('rebuild')")
    # A second, raw-text index supplies substring matches without requiring
    # a language-specific word segmenter or a Python function in SQL triggers.
    existed = con.execute("SELECT 1 FROM sqlite_master WHERE name='memory_recall_chars'").fetchone()
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_chars USING fts5("
                    "keywords,content,transcript,content='memories',content_rowid='id',tokenize='trigram')")
    except sqlite3.OperationalError as exc:
        if 'tokenizer' not in str(exc).lower():
            raise
        _logger.warning('Substring memory retrieval unavailable: SQLite has no trigram tokenizer')
        return
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_chars_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_recall_chars(rowid,keywords,content,transcript)
        VALUES(new.id,new.keywords,new.content,new.transcript); END""")
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_chars_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memory_recall_chars(memory_recall_chars,rowid,keywords,content,transcript)
        VALUES('delete',old.id,old.keywords,old.content,old.transcript); END""")
    con.execute("""CREATE TRIGGER IF NOT EXISTS memory_chars_update
        AFTER UPDATE OF keywords,content,transcript ON memories BEGIN
        INSERT INTO memory_recall_chars(memory_recall_chars,rowid,keywords,content,transcript)
        VALUES('delete',old.id,old.keywords,old.content,old.transcript);
        INSERT INTO memory_recall_chars(rowid,keywords,content,transcript)
        VALUES(new.id,new.keywords,new.content,new.transcript); END""")
    if not existed:
        con.execute("INSERT INTO memory_recall_chars(memory_recall_chars) VALUES('rebuild')")
    con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_char_vocab "
                "USING fts5vocab(memory_recall_chars,'row')")


def character_terms(text):
    """Bounded overlapping Unicode trigrams, including combining marks.

    Only non-ASCII runs use this path, leaving ordinary English retrieval
    unchanged. This is lexical overlap, not translation or fuzzy matching.
    """
    grams = list(dict.fromkeys(run[i:i + 3] for run in word_runs(text.lower()) if not run.isascii()
                               for i in range(len(run) - 2)))
    return _bounded(grams)


def word_runs(text):
    """Runs of letters, digits and combining marks. Marks count as part of a
    word, so Hindi or Thai vowel signs never split one."""
    runs, run = [], ''
    for char in text:
        if unicodedata.category(char)[0] in 'LNM':
            run += char
        elif run:
            runs.append(run)
            run = ''
    if run:
        runs.append(run)
    return runs


TERMS_MAX = 96


def _bounded(terms):
    # Cover both early cues and later continuations in a long utterance.
    half = TERMS_MAX // 2
    return terms if len(terms) <= TERMS_MAX else terms[:half] + terms[-half:]


# Kanji and katakana (with 々 and the long-vowel mark). Japanese and Chinese
# are written without spaces, so search splits a run into overlapping
# two-character pieces — the dictionary-free cjk_bigram approach of Lucene and
# Elasticsearch. Most Japanese nouns are two kanji (大阪, 旅行). Hiragana is
# left out: it mostly carries particles and verb endings, which would match
# nearly everything.
CJK_CHARS = ('々㐀-䶿一-鿿豈-﫿'
             'ァ-ヺー-ヿㇰ-ㇿｦ-ﾟ')
_CJK_RUN = re.compile(f'[{CJK_CHARS}]+')


def cjk_pieces(text):
    """Search pieces for the kanji/katakana in `text`: a lone character stays
    whole (犬, 猫), a longer run becomes overlapping pairs."""
    pieces = []
    for run in _CJK_RUN.findall(text):
        pieces += [run] if len(run) == 1 else [run[i:i + 2] for i in range(len(run) - 1)]
    return pieces


def _character_passage(text, snippet, cap):
    # Trigram snippet tokens are characters, so expand the best matched
    # window in the original text to keep the event's surrounding outcome.
    anchor = max(snippet.split('\x1f'), key=len, default='')
    offset = text.find(anchor) if anchor else 0
    start = max(0, offset - cap // 4)
    return ('… ' if start else '') + text[start:start + cap - 4] + (' …' if start + cap - 4 < len(text) else '')


def live_filter(agent_id, session_id):
    """Which memories a spontaneous callback may use: SQL conditions on `m`
    (memories) and their params, shared by keyword retrieval and the meaning
    search shadow."""
    sql = ("m.scope='recall' AND (m.agent_id=? OR m.agent_id IS NULL) "
           # Resumed sessions can span months: only exclude fresh episodes
           # from this session, not its whole historical archive.
           "AND (m.session_id IS NULL OR m.session_id != ? OR m.created_at < "
           "strftime('%Y-%m-%dT%H:%M:%f','now','-3 minutes')) "
           # Wear-out, not a one-shot: this companion's own deliveries
           # exclude a memory in any session, and only until they age out.
           'AND NOT EXISTS (SELECT 1 FROM live_memory_deliveries d '
           'JOIN sessions ds ON ds.id=d.session_id '
           'WHERE d.memory_id=m.id AND ds.agent_id=? AND d.delivered_at > '
           f"strftime('%Y-%m-%dT%H:%M:%f','now','-{REPEAT_AFTER_DAYS} days')) "
           # A memory the user retired, or text they only quoted, is out
           # of reach here however well it matches.
           + ''.join(f" AND ','||REPLACE(LOWER(COALESCE(m.tags,'')),' ','')||',' NOT LIKE '%,{tag},%'"
                     for tag in VETO_TAGS))
    return sql, (agent_id, session_id or -1, agent_id)


def search(con, agent_id, text, *, session_id=None, exclude=(), limit=3, budget_ms=40, meaning=()):
    """Candidates for a spontaneous callback: the two keyword indexes plus
    `meaning` — (memory_id, similarity) pairs from memory_vectors, best
    first — merged by reciprocal rank, each path's leader kept."""
    cap = max(1, min(limit, CANDIDATE_MAX))
    text = text[-1200:]
    tokens = list(dict.fromkeys(t for t in re.findall(r'\w+', text.lower())
                                if len(t) >= 2 and t not in STOP))[-WORDS_MAX:]
    grams = character_terms(text)
    if not tokens and not grams and not meaning:
        return []
    excluded = [int(i) for i in list(exclude)[:100] if isinstance(i, int) and i > 0]
    clause = (' AND m.id NOT IN (' + ','.join('?' for _ in excluded) + ')') if excluded else ''
    deadline = time.monotonic() + budget_ms / 1000
    con.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    try:
        # CROSS JOIN makes FTS drive the query, avoiding a MATCH probe for
        # every archive row. Scope/exclusions must precede LIMIT.
        sources = [('memory_recall_fts', tokens)] if tokens else []
        if grams and con.execute("SELECT 1 FROM sqlite_master WHERE name='memory_recall_chars'").fetchone():
            # Long ordinary phrases contribute many overlapping trigrams.
            # Summing all of them can bury a single distinctive name. Start
            # with four rare indexed grams, then fill from the broader query.
            # This chooses query terms; it is not a new admission threshold.
            counts = dict(con.execute('SELECT term,doc FROM memory_recall_char_vocab WHERE term IN (' +
                                      ','.join('?' for _ in grams) + ')', grams).fetchall())
            indexed = [g for g in grams if g in counts]
            # A kanji/katakana piece is shorter than a trigram, so it reaches
            # the index as the indexed trigrams it begins (大阪 → 大阪旅, 大阪に).
            # A piece that only ends a field begins none and stays out of
            # reach. Taking each piece's commonest continuation before any
            # piece's second keeps every piece in within the same bound.
            continuations = []
            for piece in _bounded(list(dict.fromkeys(cjk_pieces(text)))):
                rows = con.execute('SELECT term,doc FROM memory_recall_char_vocab '
                                   'WHERE term >= ? AND term < ? ORDER BY doc DESC',
                                   (piece, piece + '\U0010ffff')).fetchall()
                counts.update(rows)
                continuations.append([term for term, _ in rows])
            ranked = [t for tier in itertools.zip_longest(*continuations) for t in tier if t]
            indexed = list(dict.fromkeys(indexed + list(dict.fromkeys(ranked))[:TERMS_MAX]))
            rare = sorted(indexed, key=lambda g: counts[g])[:4]
            if rare:
                sources.append(('memory_recall_chars', rare))
                if len(indexed) > len(rare):
                    sources.append(('memory_recall_chars', indexed))
        matches = {}
        leaders = []
        char_candidates = set()
        for table, terms in sources:
            if time.monotonic() >= deadline:
                return []
            if table == 'memory_recall_chars' and len(char_candidates) >= cap:
                continue
            query = ' OR '.join('"' + t + '"' for t in terms)
            where, where_params = live_filter(agent_id, session_id)
            rows = con.execute(
                'SELECT m.id,m.content,m.transcript,m.keywords,m.memory_type,m.created_at,m.agent_id,'
                'm.session_id,m.recall_revision '
                f'FROM {table} CROSS JOIN memories m ON m.id={table}.rowid '
                f'WHERE {table} MATCH ? AND {where}' + clause +
                f' ORDER BY bm25({table},8.0,3.0,1.0),m.id LIMIT ?',
                (query, *where_params, *excluded, cap)).fetchall()
            for rank, row in enumerate(rows):
                if table == 'memory_recall_chars':
                    char_candidates.add(row['id'])
                # Reciprocal ranks combine the two independently scaled BM25
                # lists. Duplicate IDs produce one candidate and one judgment.
                entry = matches.setdefault(row['id'], {'score': 0, 'row': row, 'table': table, 'query': query})
                entry['score'] += 1 / (60 + rank + 1)
                # Substring windows locate cues inside unsegmented text.
                if table == 'memory_recall_chars' and entry['table'] != table:
                    entry.update(row=row, table=table, query=query)
            if rows and table not in [t for t, _ in leaders]:
                leaders.append((table, rows[0]['id']))
        similarity = dict(meaning)
        ids = [i for i in similarity if i not in excluded]
        if ids:
            where, where_params = live_filter(agent_id, session_id)
            found = {r['id']: r for r in con.execute(
                'SELECT m.id,m.content,m.transcript,m.keywords,m.memory_type,m.created_at,m.agent_id,'
                'm.session_id,m.recall_revision FROM memories m '
                f'WHERE m.id IN ({",".join("?" for _ in ids)}) AND {where}', (*ids, *where_params))}
            rows = [found[i] for i in ids if i in found]
            for rank, row in enumerate(rows):
                entry = matches.setdefault(row['id'], {'score': 0, 'row': row, 'table': 'meaning', 'query': None})
                entry['score'] += 1 / (60 + rank + 1)
            if rows:
                leaders.append(('meaning', rows[0]['id']))
        hits = []
        # Reserve the best candidate from each retrieval path. Otherwise
        # generic results present in both lists can crowd out a rare cue.
        leading_ids = [i for _, i in reversed(leaders)]
        ranked_ids = [e['row']['id'] for e in sorted(matches.values(), key=lambda e: (-e['score'], e['row']['id']))]
        selected = list(dict.fromkeys(leading_ids + ranked_ids))[:cap]
        for memory_id in selected:
            if time.monotonic() >= deadline:
                return []
            entry = matches[memory_id]
            row, table, query = entry['row'], entry['table'], entry['query']
            hit = dict(row)
            transcript = hit.pop('transcript') or ''
            # Carried for the logs: how far clear of the next candidate this
            # one ranked is the cheapest signal for skipping a judgment
            # altogether, and its threshold has to come from real calls.
            hit['retrieval_score'] = round(entry['score'], 6)
            if memory_id in similarity:
                hit['similarity'] = round(similarity[memory_id], 4)
            if table == 'meaning':
                # No matched words to centre a window on: the summary the
                # vector was made from stands in, the keyword index beside it.
                hit['content'] = (hit['content'] or '')[:600]
                hit['excerpt'] = ''
                hits.append(hit)
                continue
            # Select both passages around query matches, rather than giving
            # Jev the opening of a potentially unrelated episode summary.
            # FTS tokens are word-like units, not LLM tokens; 64 is SQLite's
            # maximum snippet window. Character caps bound unusual long tokens.
            passages = con.execute(
                f"SELECT snippet({table},1,'','',char(31),40),"
                f"snippet({table},2,'','',char(31),64) FROM {table} "
                f'WHERE {table} MATCH ? AND rowid=?', (query, row['id'])).fetchone()
            if table == 'memory_recall_chars':
                hit['content'] = _character_passage(hit['content'] or '', passages[0] or '', 600)
                hit['excerpt'] = _character_passage(transcript, passages[1] or '', 1000)
            else:
                hit['content'] = (passages[0] or '').replace('\x1f', ' … ')[:600]
                hit['excerpt'] = (passages[1] or '').replace('\x1f', ' … ')[:1000]
            hits.append(hit)
        return hits
    except sqlite3.OperationalError as exc:
        if 'interrupted' in str(exc) or 'no such table' in str(exc):
            return []  # Optional work expires; ordinary recall still works.
        raise
    finally:
        con.set_progress_handler(None, 0)
