# Copyright 2026 Codemarchant
"""Meaning-based search over recall memories, beside keyword search.

EmbeddingGemma 2 (Google DeepMind, Apache 2.0): its text encoder as the 4-bit
ONNX export from onnx-community, at assets/models/embeddinggemma-2/ —
fetched into release packages by scripts/fetch_embed_model.py. Without it,
available() is False and recall stays keyword-only.

Vectors live in memory_vectors, stamped with the memory's recall_revision so
an edit re-embeds it. One daemon thread owns the backfill; recall and live
memory embed their query inline (an onnxruntime session runs safely from
several threads).
"""
import logging
import queue
import re
import threading

import numpy as np

from . import memory_index
from .db import ASSETS_DIR, connect

_logger = logging.getLogger(__name__)

MODEL_DIR = ASSETS_DIR / 'models' / 'embeddinggemma-2'
# Stamped on every vector: a different model makes them all stale.
MODEL_ID = 'embeddinggemma-2-q4'
# The model card's retrieval (SearchQuery) prefixes.
QUERY_PREFIX = 'task: search result | query: '
DOCUMENT_PREFIX = 'title: none | text: '
# The model's context window, in tokens.
CONTEXT_TOKENS = 8192
# Floor for meaning matches after the best one (see search), applied before
# the merge with keyword results.
# On a real archive (2026-10-10, 866 recall memories, this model build and
# prompts), random user lines scored 0.636 ± 0.040 against memories, and
# 0.78 is the 99.9th percentile of those 173,708 pairs: an ~800-memory
# search admits under one chance match. Short chatter still tops out higher
# (a bare name against a short fact naming them: 0.84). Re-measure if the
# model, its quantisation or the prompts change.
MIN_SIMILARITY = 0.78
# The lower floor for the best match (see search): the 95th percentile of
# those same random pairs (0.702), so a best match no closer than a
# commonplace random pairing yields nothing. Every planted subtle match
# cleared it (lowest 0.703).
BEST_MIN_SIMILARITY = 0.70
# A word for live_search's window: a run of a spaced script, or one
# kanji/kana character (those scripts write without spaces).
_KANA = 'ぁ-ゟ'
_WORD = re.compile(f'[{memory_index.CJK_CHARS}{_KANA}]|[^\\W{memory_index.CJK_CHARS}{_KANA}]+')

_lock = threading.Lock()
_model = None
_tasks = queue.Queue()
_worker = None


def available():
    return (MODEL_DIR / 'model_q4.onnx').is_file() and (MODEL_DIR / 'tokenizer.json').is_file()


def initialize(con):
    con.execute("CREATE TABLE IF NOT EXISTS memory_vectors ("
                "memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, "
                "model TEXT NOT NULL, revision INTEGER NOT NULL, vector BLOB NOT NULL)")
    # Galaxy label candidates, embedded once: a word costs ~10 ms, and a map
    # asks for hundreds.
    con.execute("CREATE TABLE IF NOT EXISTS word_vectors ("
                "word TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (word, model))")


def _load():
    global _model
    with _lock:
        if _model is None:
            import onnxruntime as ort
            from tokenizers import Tokenizer
            session = ort.InferenceSession(str(MODEL_DIR / 'model_q4.onnx'),
                                           providers=['CPUExecutionProvider'])
            tokenizer = Tokenizer.from_file(str(MODEL_DIR / 'tokenizer.json'))
            tokenizer.enable_padding(pad_id=tokenizer.token_to_id('<pad>'), pad_token='<pad>')
            tokenizer.enable_truncation(CONTEXT_TOKENS)
            _model = (session, tokenizer)
    return _model


def embed(texts, prefix):
    """Unit-length float32 vectors, one row per text."""
    session, tokenizer = _load()
    encoded = tokenizer.encode_batch([prefix + t for t in texts])
    feed = {'input_ids': np.array([e.ids for e in encoded], dtype=np.int64),
            'attention_mask': np.array([e.attention_mask for e in encoded], dtype=np.int64)}
    # The multimodal export also takes image/video/audio tokens; text has none.
    for spec in session.get_inputs():
        if spec.name not in feed:
            feed[spec.name] = np.zeros((0, spec.shape[-1]), dtype=np.float32)
    vectors = session.run(['sentence_embedding'], feed)[0].astype(np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def _document(row):
    # An episode's keyword index names what it is about; its summary tells it.
    parts = (row['keywords'], row['content']) if row['memory_type'] == 'episode' else (row['content'],)
    return '\n'.join(p for p in parts if p)


def search(con, agent_id, query, ids=None, limit=10):
    """This agent's (and the shared) recall memories closest in meaning to
    `query`, best first, as (memory_id, similarity): the single best by rank
    when it clears BEST_MIN_SIMILARITY, then any others clearing
    MIN_SIMILARITY. `ids` narrows the pool. Empty when nothing clears, or
    the model is missing or fails — callers keep keyword results.

    Rank, not score, carries the subtle match: memories planted in a real
    archive and asked about in other words ("kitchen appliance problems"
    for a burnt-toast habit, "rice balls" for onigiri) came 1st in 17 of 18
    queries, yet most scored 0.72-0.78, no higher than the best unrelated
    memory reaches for other queries."""
    if not available() or not query:
        return []
    notify()
    try:
        rows = con.execute(
            "SELECT v.memory_id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id "
            "WHERE m.scope = 'recall' AND v.model = ? AND v.revision = m.recall_revision "
            "AND (m.agent_id IS ? OR m.agent_id IS NULL)", (MODEL_ID, agent_id)).fetchall()
        if ids is not None:
            rows = [r for r in rows if r['memory_id'] in ids]
        if not rows:
            return []
        matrix = np.frombuffer(b''.join(r['vector'] for r in rows), dtype=np.float32).reshape(len(rows), -1)
        similarity = matrix @ embed([query], QUERY_PREFIX)[0]
    except Exception:
        _logger.warning('Meaning search failed; keyword results only', exc_info=True)
        return []
    order = np.argsort(-similarity)[:limit]
    best = [i for rank, i in enumerate(order)
            if similarity[i] >= (BEST_MIN_SIMILARITY if rank == 0 else MIN_SIMILARITY)]
    return [(rows[i]['memory_id'], float(similarity[i])) for i in best]


def start():
    """Run the worker and catch up on memories without a current vector."""
    global _worker
    if _worker or not available():
        return
    _worker = threading.Thread(target=_run, name='memory-vectors', daemon=True)
    _worker.start()
    notify()


def notify():
    """Embed new or edited memories soon (no-op until start())."""
    if _worker:
        _tasks.put(('sweep',))


def live_search(con, agent_id, session_id, text):
    """Live memory's meaning candidate: of the memories a spontaneous
    callback may use, the single closest to the utterance's latest words
    (the keyword path's window size; embedding time grows with length).

    Its best, by rank, under only the low BEST_MIN_SIMILARITY floor: subtle
    callbacks planted in a real archive (an established habit, a coined
    joke, a nickname, a cat greeted in Japanese, all said in other words)
    ranked 1st of 481 every time yet scored 0.70-0.78 — the band a random
    line's best match also reaches. So rank picks the one candidate, and
    Jev's gates decide whether it is the same distinctive thing or only a
    shared topic."""
    words = list(_WORD.finditer(text))
    if len(words) > memory_index.WORDS_MAX:
        text = text[words[-memory_index.WORDS_MAX].start():]
    where, params = memory_index.live_filter(agent_id, session_id)
    eligible = {r[0] for r in con.execute(f'SELECT m.id FROM memories m WHERE {where}', params)}
    return search(con, agent_id, text, ids=eligible, limit=1)


def neighbours(con, ids, k):
    """Each of `ids`' `k` closest others among `ids` by meaning, as
    {id: [[id, similarity], ...]}, best first — the Memory Galaxy's graph.
    None until every one has a current vector, so a half-indexed archive
    keeps the word-based map."""
    wanted = set(ids)
    if not available() or not wanted:
        return None
    rows = [r for r in con.execute(
        "SELECT v.memory_id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id "
        "WHERE v.model = ? AND v.revision = m.recall_revision", (MODEL_ID,)) if r['memory_id'] in wanted]
    if len(rows) < len(wanted):
        notify()
        return None
    matrix = np.frombuffer(b''.join(r['vector'] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    similarity = matrix @ matrix.T
    np.fill_diagonal(similarity, -np.inf)
    k = min(k, len(rows) - 1)
    result = {}
    for i, row in enumerate(rows):
        best = np.argsort(-similarity[i])[:k]
        result[row['memory_id']] = [[rows[j]['memory_id'], round(float(similarity[i, j]), 4)] for j in best]
    return result


def topic_terms(con, topics):
    """BERTopic's KeyBERTInspired re-ranking for the Memory Galaxy's names:
    `topics` = [(representative memory ids, candidate words)], and each
    topic's words come back ordered by closeness to the mean embedding of
    its representative memories. None when the model or any of those
    memories' vectors is missing."""
    if not available():
        return None
    ids = sorted({i for docs, _ in topics for i in docs})
    found = {r['memory_id']: np.frombuffer(r['vector'], dtype=np.float32) for r in con.execute(
        "SELECT v.memory_id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id "
        f"WHERE v.model = ? AND v.revision = m.recall_revision AND v.memory_id IN ({','.join('?' * len(ids))})",
        (MODEL_ID, *ids))} if ids else {}
    if len(found) < len(ids):
        notify()
        return None
    words = _word_vectors(con, sorted({w for _, ws in topics for w in ws}))
    ranked = []
    for docs, ws in topics:
        if not docs or not ws:
            ranked.append(list(ws))
            continue
        topic = np.mean([found[i] for i in docs], axis=0)
        topic /= np.linalg.norm(topic)
        ranked.append(_mmr(ws, np.stack([words[w] for w in ws]), topic))
    return ranked


# BERTopic's MaximalMarginalRelevance defaults, chained after KeyBERTInspired
# as its docs suggest: a little diversity so near-synonyms ("cooking",
# "cooked") don't take both places in a name.
MMR_DIVERSITY = 0.1
MMR_TOP_N = 10


def _mmr(words, vectors, topic):
    """Maximal Marginal Relevance (BERTopic's mmr()): the best word for the
    topic first, then each next one trading closeness to the topic against
    closeness to the words already picked."""
    to_topic = vectors @ topic
    between = vectors @ vectors.T
    picked = [int(np.argmax(to_topic))]
    rest = [i for i in range(len(words)) if i != picked[0]]
    while rest and len(picked) < MMR_TOP_N:
        score = (1 - MMR_DIVERSITY) * to_topic[rest] - MMR_DIVERSITY * between[np.ix_(rest, picked)].max(axis=1)
        picked.append(rest.pop(int(np.argmax(score))))
    return [words[i] for i in picked]


def _word_vectors(con, words):
    """{word: vector} with each word embedded as a search query (the word
    looking for the memories it names), cached in word_vectors."""
    vectors = {}
    for i in range(0, len(words), 500):
        chunk = words[i:i + 500]
        vectors.update((r['word'], np.frombuffer(r['vector'], dtype=np.float32)) for r in con.execute(
            f"SELECT word, vector FROM word_vectors WHERE model = ? AND word IN ({','.join('?' * len(chunk))})",
            (MODEL_ID, *chunk)))
    missing = [w for w in words if w not in vectors]
    for i in range(0, len(missing), 64):
        chunk = missing[i:i + 64]
        for w, v in zip(chunk, embed(chunk, QUERY_PREFIX)):
            vectors[w] = v
            con.execute("INSERT OR REPLACE INTO word_vectors (word, model, vector) VALUES (?, ?, ?)",
                        (w, MODEL_ID, v.tobytes()))
    if missing:
        con.commit()
    return vectors


def _run():
    # Load the model now, not on the first search: loading takes ~2 s, and a
    # live memory lookup that pays it misses its 900 ms deadline.
    try:
        _load()
    except Exception:
        _logger.warning('Memory search model failed to load', exc_info=True)
    while True:
        _tasks.get()
        try:
            _sweep()
        except Exception:
            _logger.warning('Memory vectors sweep failed', exc_info=True)


def _sweep():
    con = connect()
    try:
        while True:
            # Newest first: recent memories are the likeliest to be asked
            # about. Core ones too — search skips them, the Galaxy maps them.
            rows = con.execute(
                "SELECT m.id, m.memory_type, m.keywords, m.content, m.recall_revision FROM memories m "
                "LEFT JOIN memory_vectors v ON v.memory_id = m.id "
                "WHERE (v.memory_id IS NULL OR v.model != ? OR v.revision != m.recall_revision) "
                "ORDER BY m.id DESC LIMIT 8", (MODEL_ID,)).fetchall()
            if not rows:
                return
            vectors = embed([_document(r) for r in rows], DOCUMENT_PREFIX)
            # A memory deleted mid-batch is skipped rather than tripping the FK.
            con.executemany(
                "INSERT OR REPLACE INTO memory_vectors (memory_id, model, revision, vector) "
                "SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)",
                [(r['id'], MODEL_ID, r['recall_revision'], v.tobytes(), r['id'])
                 for r, v in zip(rows, vectors)])
            con.commit()
    finally:
        con.close()

