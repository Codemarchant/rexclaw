# Copyright 2026 Codemarchant
"""Memory tools exposed to xAI as `type:'function'` tools.

Three tools — `remember`, `recall`, `forget` — let a companion build up a
durable picture of the user across sessions. Core memories are injected into
the session preamble verbatim; recall memories live in a larger pool the agent
searches via the `recall` tool when the conversation references something past.

Search note: the Odoo original used Postgres FTS + pg_trgm. The standalone is
single-user with a small memory set, so recall scoring runs in Python: token
overlap (with prefix relaxation for plurals), a pg_trgm-style trigram fallback
for tokens the prefix rule misses (spelling variants like colour/color, typos,
transcription-mangled names), substring bonus, and tag matching. Same OR
semantics, no extensions needed.
"""
import logging
import re
from datetime import datetime, timedelta
from functools import lru_cache

from .db import utcnow, parse_dt
from . import store

_logger = logging.getLogger(__name__)

CONTENT_MAX_LEN = 64000
DEFAULT_CORE_CAP = 100
# Additive boost when a memory's tags overlap a tag the agent passed to
# `recall`. Same magnitude as the query-substring tag bonus, so a passed tag
# only re-ranks query matches whose scores are already close — it never filters
# out untagged matches nor surfaces a memory the query didn't otherwise hit.
_PASSED_TAG_BONUS = 0.3

_TOKEN_SPLIT = re.compile(r'[^a-zA-Z0-9]+')
_DROP = {'and', 'or', 'not', 'the', 'is', 'of', 'a', 'to', 'in'}


def _tokenize(text):
    return [t.lower() for t in _TOKEN_SPLIT.split(text or '')
            if len(t) >= 2 and t.lower() not in _DROP]


def _normalize_tags(raw):
    """Accept tags as a list of strings or a comma-separated string. Returns a
    clean comma-separated string (lowercase, deduped, sorted), or None."""
    if not raw:
        return None
    if isinstance(raw, str):
        parts = raw.split(',')
    elif isinstance(raw, (list, tuple)):
        parts = list(raw)
    else:
        return None
    clean = sorted({t.strip().lower() for t in parts if isinstance(t, str) and t.strip()})
    return ','.join(clean) if clean else None


# ---------------------------------------------------------------------------
# Query helpers — used by the tool impls and the session preamble.
# ---------------------------------------------------------------------------

def core_for(con, agent_id):
    """Core memories for this agent (including global ones), oldest first.
    Bumps last_used_at on the returned set."""
    if agent_id:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'core' AND (agent_id = ? OR agent_id IS NULL) "
            "ORDER BY created_at ASC, id ASC",
            (agent_id,),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'core' AND agent_id IS NULL "
            "ORDER BY created_at ASC, id ASC",
        ).fetchall()
    if rows:
        ids = [r['id'] for r in rows]
        con.execute(
            f"UPDATE memories SET last_used_at = ? WHERE id IN ({','.join('?' * len(ids))})",
            (utcnow(), *ids),
        )
    return rows


def known_tags(con):
    """Sorted unique tag tokens stored across all memories (both scopes)."""
    rows = con.execute("SELECT tags FROM memories WHERE tags IS NOT NULL").fetchall()
    seen = set()
    for r in rows:
        for token in (r['tags'] or '').split(','):
            token = token.strip().lower()
            if token:
                seen.add(token)
    return sorted(seen)


def _token_match(haystack_token, query_token):
    """Equal OR one is a >=3-char prefix of the other — absorbs plurals
    without a stemmer (same relaxation the Odoo find_action search used)."""
    if haystack_token == query_token:
        return True
    if len(haystack_token) >= 3 and query_token.startswith(haystack_token):
        return True
    if len(query_token) >= 3 and haystack_token.startswith(query_token):
        return True
    return False


# Minimum trigram similarity for a fuzzy token match. Mirrors the Odoo
# module's pg_trgm tuning (word_similarity_threshold 0.3 — the 0.6 default is
# too strict for short words: colour/color scores ~0.44, a one-letter typo in
# an 8-letter word ~0.39).
_TRGM_THRESHOLD = 0.3


@lru_cache(maxsize=4096)
def _trigrams(token):
    """pg_trgm-style trigram set: two spaces padded before the token and one
    after, so word starts weigh more than interiors."""
    padded = f'  {token} '
    return frozenset(padded[i:i + 3] for i in range(len(padded) - 2))


def _trigram_sim(a, b):
    """Jaccard similarity of trigram sets — same formula as pg_trgm's
    similarity() for single words."""
    ta, tb = _trigrams(a), _trigrams(b)
    inter = len(ta & tb)
    if not inter:
        return 0.0
    return inter / (len(ta) + len(tb) - inter)


def _search_text(row):
    """Text recall scores against: an episode's keyword index (falling back to
    its narrative), or a fact's content. Keeps long episode narratives out of
    the ranking signal — mirrors the Odoo module's stored `search_text`."""
    if row['memory_type'] == 'episode':
        return row['keywords'] or row['content'] or ''
    return row['content'] or ''


def search_recall(con, agent_id, query, limit=10, tags=None, memory_type=None,
                  newer_than_days=None, older_than_days=None):
    """Score recall memories in Python. Signals (weighted sum, mirroring the
    original's FTS-dominant weighting):
      * distinct query tokens matched in search-text (x10; a token with no
        exact/prefix match falls back to its best trigram similarity >= 0.3
        against any search-text token, contributing similarity x10 — so a
        fuzzy hit always scores below an exact one)
      * literal query substring in search-text (+50)
      * query substring in tags (+0.3 — tag bonus)
      * overlap with a passed `tags` token (+_PASSED_TAG_BONUS — re-rank only)
    `tags` is a SOFT signal: passing tags lifts matching memories but never
    hides untagged or content-only matches. `memory_type` ('fact' | 'episode')
    optionally narrows the result set.

    `newer_than_days` / `older_than_days` bound created_at as a HARD filter
    (unlike tags): the caller is explicitly scoping time ("a few weeks
    ago"). With a date bound set, `query` may be empty — browse mode:
    memories in the window, episodes first, newest first. Fallback-on-empty
    lives in _impl_recall, not here, so extraction/internal callers keep
    strict semantics.

    Returns (hits, truncated) — `truncated` is True when more memories
    matched than `limit` allowed, so callers can tell a quiet period from
    a clipped one."""
    query = (query or '').strip()
    has_window = newer_than_days is not None or older_than_days is not None
    if not query and not has_window:
        return [], False
    limit = max(1, min(int(limit or 10), 100))

    now = datetime.utcnow()
    min_created = now - timedelta(days=newer_than_days) if newer_than_days is not None else None
    max_created = now - timedelta(days=older_than_days) if older_than_days is not None else None

    def _in_window(r):
        if min_created is None and max_created is None:
            return True
        created = parse_dt(r['created_at'])
        if not created:
            return False
        if min_created is not None and created < min_created:
            return False
        if max_created is not None and created > max_created:
            return False
        return True
    q_lower = query.lower()
    q_tokens = _tokenize(query)

    clean_tags = {
        t.strip().lower() for t in (tags or [])
        if isinstance(t, str) and t.strip()
    }

    # Recall scope only — core memories live in the session preamble, and the
    # deny-despite-knowing failure is handled where it happens: the memory
    # amble says to read the preamble first, and an empty result here carries
    # a note redirecting the model back to it (see _impl_recall).
    if agent_id:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'recall' AND (agent_id = ? OR agent_id IS NULL)",
            (agent_id,),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'recall' AND agent_id IS NULL",
        ).fetchall()

    if not query:
        # Browse mode: a time window with no keywords ("what happened a few
        # weeks ago"). Episodes first — they ARE the what-happened record —
        # then newest first within each type.
        pool = [
            r for r in rows
            if not (memory_type in ('fact', 'episode') and r['memory_type'] != memory_type)
            and _in_window(r)
        ]
        pool.sort(key=lambda r: (parse_dt(r['created_at']) or datetime.min, r['id']),
                  reverse=True)
        pool.sort(key=lambda r: r['memory_type'] != 'episode')  # stable — episodes first
        hits = pool[:limit]
        if hits:
            ids = [r['id'] for r in hits]
            con.execute(
                f"UPDATE memories SET last_used_at = ? WHERE id IN ({','.join('?' * len(ids))})",
                (utcnow(), *ids),
            )
        return hits, len(pool) > limit

    scored = []
    for r in rows:
        if memory_type in ('fact', 'episode') and r['memory_type'] != memory_type:
            continue
        if not _in_window(r):
            continue
        content_lower = _search_text(r).lower()
        h_tokens = list(dict.fromkeys(_tokenize(content_lower)))
        score = 0.0
        for qt in q_tokens:
            if any(_token_match(ht, qt) for ht in h_tokens):
                score += 10.0
                continue
            best = max((_trigram_sim(ht, qt) for ht in h_tokens), default=0.0)
            if best >= _TRGM_THRESHOLD:
                score += best * 10.0
        if q_lower in content_lower:
            score += 50.0
        if r['tags'] and q_lower in r['tags'].lower():
            score += 0.3
        if score <= 0:
            # No content/substring/tag-text signal — a passed tag alone never
            # surfaces a memory (it only re-ranks ones the query already hit).
            continue
        if clean_tags:
            row_tags = {t.strip().lower() for t in (r['tags'] or '').split(',') if t.strip()}
            if row_tags & clean_tags:
                score += _PASSED_TAG_BONUS
        last_used = parse_dt(r['last_used_at']) or datetime.min
        scored.append((score, last_used, r['id'], r))

    scored.sort(key=lambda t: (-t[0], -t[1].timestamp() if t[1] != datetime.min else 0, -t[2]))
    hits = [t[3] for t in scored[:limit]]
    if hits:
        ids = [r['id'] for r in hits]
        con.execute(
            f"UPDATE memories SET last_used_at = ? WHERE id IN ({','.join('?' * len(ids))})",
            (utcnow(), *ids),
        )
    return hits, len(scored) > limit


def remember_or_get(con, agent_id, content, scope, tags, source):
    """Create a memory, or return the existing one if (agent, content) already
    matches case-insensitively. Returns (row, created_bool)."""
    content = (content or '').strip()
    if agent_id:
        existing = con.execute(
            "SELECT * FROM memories WHERE agent_id = ? AND LOWER(content) = LOWER(?) LIMIT 1",
            (agent_id, content),
        ).fetchone()
    else:
        existing = con.execute(
            "SELECT * FROM memories WHERE agent_id IS NULL AND LOWER(content) = LOWER(?) LIMIT 1",
            (content,),
        ).fetchone()
    if existing:
        return existing, False
    cur = con.execute(
        "INSERT INTO memories (agent_id, scope, content, tags, source, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (agent_id, scope or 'recall', content, tags, source or 'agent_inferred', utcnow()),
    )
    row = con.execute("SELECT * FROM memories WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row, True


def apply_extraction_ops(con, agent_id, ops, episode, transcript=None, session_id=None):
    """Apply automatic-extraction output to the memory store.

    `ops` is a list of fact operations:
      {op:'add', scope:'core'|'recall', content, tags[]}
      {op:'update', target_id, content, tags[]}   (supersede a core fact)
      {op:'delete', target_id}                     (retire a core fact)

    `episode` is {summary, keywords, tags[]} — stored as one recall-scoped
    `memory_type='episode'` row carrying the verbatim `transcript` and a
    `session_id` backlink.

    Best-effort and self-defended: bad/oob ids are skipped, content is
    length-clamped, and a `core` add that would breach the cap is downgraded to
    `recall` rather than raising — the caller runs this as a fire-and-forget
    side effect that must never break compaction. Returns a counts dict.
    """
    counts = {'added': 0, 'updated': 0, 'deleted': 0, 'episode': 0,
              'downgraded': 0, 'skipped': 0}

    def _clamp(text):
        text = (text or '').strip()
        return text[:CONTENT_MAX_LEN] if text else ''

    core_cap = None
    if agent_id:
        agent = con.execute(
            "SELECT core_memory_cap FROM agents WHERE id = ?", (agent_id,)
        ).fetchone()
        core_cap = (agent['core_memory_cap'] if agent else None) or DEFAULT_CORE_CAP

    for op in (ops or []):
        if not isinstance(op, dict):
            counts['skipped'] += 1
            continue
        action = (op.get('op') or 'add').strip().lower()

        if action == 'add':
            content = _clamp(op.get('content'))
            if not content:
                counts['skipped'] += 1
                continue
            scope = op.get('scope') if op.get('scope') in ('core', 'recall') else 'recall'
            # Cap pre-flight: downgrade rather than fail.
            if scope == 'core' and agent_id:
                core_count = con.execute(
                    "SELECT COUNT(*) AS c FROM memories WHERE agent_id = ? AND scope = 'core'",
                    (agent_id,),
                ).fetchone()['c']
                if core_count >= core_cap:
                    scope = 'recall'
                    counts['downgraded'] += 1
            _, created = remember_or_get(
                con, agent_id, content, scope,
                _normalize_tags(op.get('tags')), 'agent_inferred',
            )
            counts['added'] += 1 if created else 0
            counts['skipped'] += 0 if created else 1

        elif action in ('update', 'delete'):
            target_id = op.get('target_id')
            if not isinstance(target_id, int) or target_id <= 0:
                counts['skipped'] += 1
                continue
            # Restrict supersede/retire to core facts so a hallucinated id can
            # never touch recall episodes.
            row = con.execute(
                "SELECT id FROM memories WHERE id = ? AND scope = 'core' AND memory_type = 'fact'",
                (target_id,),
            ).fetchone()
            if not row:
                counts['skipped'] += 1
                continue
            if action == 'delete':
                con.execute("DELETE FROM memories WHERE id = ?", (target_id,))
                counts['deleted'] += 1
            else:
                content = _clamp(op.get('content'))
                if not content:
                    counts['skipped'] += 1
                    continue
                new_tags = _normalize_tags(op.get('tags'))
                if new_tags:
                    con.execute("UPDATE memories SET content = ?, tags = ? WHERE id = ?",
                                (content, new_tags, target_id))
                else:
                    con.execute("UPDATE memories SET content = ? WHERE id = ?",
                                (content, target_id))
                counts['updated'] += 1
        else:
            counts['skipped'] += 1

    # Episode — one recall-scoped narrative row per rollup.
    if isinstance(episode, dict):
        summary = _clamp(episode.get('summary'))
        if summary:
            con.execute(
                "INSERT INTO memories (agent_id, scope, memory_type, content, keywords, "
                "tags, transcript, session_id, source, created_at) "
                "VALUES (?, 'recall', 'episode', ?, ?, ?, ?, ?, 'agent_inferred', ?)",
                (
                    agent_id, summary,
                    (episode.get('keywords') or '').strip() or None,
                    _normalize_tags(episode.get('tags')),
                    transcript or None, session_id, utcnow(),
                ),
            )
            counts['episode'] += 1

    return counts


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _impl_remember(con, session, arguments):
    content = (arguments.get('content') or '').strip()
    scope = arguments.get('scope') or 'recall'
    tags = _normalize_tags(arguments.get('tags'))

    if not content:
        return {'ok': False, 'reason': 'content_empty', 'message': 'Memory content cannot be empty.'}
    if len(content) > CONTENT_MAX_LEN:
        return {
            'ok': False,
            'reason': 'content_too_long',
            'message': f'Memory content exceeds {CONTENT_MAX_LEN} characters '
                       f'(got {len(content)}). Summarise it before storing.',
        }
    if scope not in ('core', 'recall'):
        return {'ok': False, 'reason': 'invalid_scope',
                'message': "scope must be 'core' or 'recall'."}

    agent_id = session['agent_id'] if session else None

    # Pre-flight the core cap so the agent gets a structured response it can
    # react to (forget oldest, then retry) instead of a hard failure.
    if scope == 'core' and agent_id:
        agent = store.get_agent(con, agent_id)
        cap = agent['core_memory_cap'] or DEFAULT_CORE_CAP
        existing_core = con.execute(
            "SELECT * FROM memories WHERE agent_id = ? AND scope = 'core' "
            "ORDER BY created_at ASC, id ASC",
            (agent_id,),
        ).fetchall()
        if len(existing_core) >= cap:
            return {
                'ok': False,
                'reason': 'core_full',
                'cap': cap,
                'oldest_id': existing_core[0]['id'],
                'oldest_content': existing_core[0]['content'],
                'message': (
                    f'Core memory cap of {cap} reached. Call `forget` on an '
                    f'existing core memory (oldest id={existing_core[0]["id"]}) '
                    f'or use scope="recall" instead.'
                ),
            }

    row, created = remember_or_get(con, agent_id, content, scope, tags, 'agent_inferred')
    return {
        'ok': True,
        'id': row['id'],
        'scope': row['scope'],
        'created': created,
        'duplicate_of': None if created else row['id'],
    }


def _impl_recall(con, session, arguments):
    limit_arg = arguments.get('limit')
    raw_tags = arguments.get('tags') or []

    # Expansion mode: episode_id supplied → return that episode's full verbatim
    # transcript instead of running a search.
    episode_id = arguments.get('episode_id')
    if episode_id:
        if not isinstance(episode_id, int) or episode_id <= 0:
            return {'ok': False, 'reason': 'invalid_id',
                    'message': 'episode_id must be a positive integer.'}
        row = con.execute(
            "SELECT * FROM memories WHERE id = ? AND memory_type = 'episode'",
            (episode_id,),
        ).fetchone()
        if not row:
            return {'ok': False, 'reason': 'not_found',
                    'message': f'Episode {episode_id} does not exist or is not an episode.'}
        con.execute("UPDATE memories SET last_used_at = ? WHERE id = ?", (utcnow(), episode_id))
        return {
            'ok': True,
            'id': row['id'],
            'memory_type': 'episode',
            'summary': row['content'],
            'transcript': row['transcript'] or '',
            'tags': row['tags'] or '',
        }

    query = (arguments.get('query') or '').strip()

    def _days(name):
        raw = arguments.get(name)
        if raw is None:
            return None
        try:
            val = int(raw)
        except (TypeError, ValueError):
            return None
        return max(0, min(val, 3650))

    newer_than_days = _days('newer_than_days')
    older_than_days = _days('older_than_days')
    # A window where older > newer ("at least 45 days old AND within the last
    # 10 days") is empty — the model inverted the pair; the intended window
    # between the two numbers is unambiguous, so swap rather than fail.
    if (newer_than_days is not None and older_than_days is not None
            and older_than_days > newer_than_days):
        newer_than_days, older_than_days = older_than_days, newer_than_days
    has_window = newer_than_days is not None or older_than_days is not None

    if not query and not has_window:
        return {'ok': False, 'reason': 'query_empty',
                'message': 'recall needs a query, a date range, or an episode_id.'}

    # Browsing a period wants coverage; keyword search wants precision.
    limit = limit_arg or (25 if (has_window and not query) else 10)

    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(',') if t.strip()]
    elif isinstance(raw_tags, (list, tuple)):
        tags = [t for t in raw_tags if isinstance(t, str) and t.strip()]
    else:
        tags = []

    agent_id = session['agent_id'] if session else None
    records, truncated = search_recall(con, agent_id, query, limit=limit, tags=tags,
                                       newer_than_days=newer_than_days,
                                       older_than_days=older_than_days)

    # Mis-expressed browse rescue: a window plus a query full of time-words
    # ("what we did last week or recent activities") keyword-matches nothing
    # even though the period has plenty. The user asked about the PERIOD, so
    # before looking outside it, return what the period actually contains.
    window_browse = False
    if not records and has_window and query:
        records, truncated = search_recall(con, agent_id, '',
                                           limit=limit_arg or 25,
                                           newer_than_days=newer_than_days,
                                           older_than_days=older_than_days)
        window_browse = bool(records)

    # Soft landing: the window itself is empty, but the keywords DO match
    # something outside it. The model's date arithmetic is fuzzy ("a few
    # weeks" could be two months) — surface the near-misses with their ages
    # instead of a confident empty result.
    window_fallback = False
    if not records and has_window and query:
        records, _ = search_recall(con, agent_id, query, limit=limit, tags=tags)
        window_fallback = bool(records)
        truncated = False

    now = datetime.utcnow()
    hits = []
    for r in records:
        created = parse_dt(r['created_at'])
        age = (now - created).days if created else None
        hit = {
            'id': r['id'],
            'content': r['content'],
            'tags': r['tags'] or '',
            'age_days': age,
            'scope_on_agent': bool(r['agent_id']),
            'memory_type': r['memory_type'],
        }
        # Episodes carry a verbatim transcript — flag it so the agent knows it
        # can re-call recall with this id to read the full conversation.
        if r['memory_type'] == 'episode':
            hit['expandable'] = True
        hits.append(hit)
    result = {'ok': True, 'query': query, 'count': len(hits), 'hits': hits}
    if has_window:
        result['window'] = {
            'newer_than_days': newer_than_days,
            'older_than_days': older_than_days,
        }
    notes = []
    if truncated and has_window:
        result['truncated'] = True
        notes.append(
            f'More memories exist in this window than the {len(hits)} '
            'returned — this period was busier than it looks here. If the '
            'user wants the full picture, narrow the date range, or re-call '
            'with a higher limit (max 100).'
        )
    if window_browse:
        notes.append(
            'The query keywords matched nothing in this period, so this is '
            'everything the period contains instead (episodes first, newest '
            'first). Tip: for time-only questions ("what did we do last '
            'week?") omit `query` and pass just the date range.'
        )
    if notes:
        result['note'] = ' '.join(notes)
    if window_fallback:
        result['note'] = (
            'Nothing matched INSIDE the requested date range — these are the '
            'closest keyword matches from outside it. Check each hit\'s '
            'age_days before presenting: human time estimates are fuzzy, so '
            'a near-miss may still be what the user means.'
        )
    elif not hits:
        # Models over-trust an empty tool result and deny knowledge that is
        # sitting in their own preamble — nudge them back to it before they
        # tell the user "you never told me".
        if has_window and not query:
            result['note'] = (
                'No stored memories were created in that period. Consider '
                'widening the range, or re-calling with keywords.'
            )
        else:
            result['note'] = (
                'No stored memories matched this query. Before telling the user '
                'you do not know: re-read "What you remember about this user" in '
                'your instructions — the answer may already be there, possibly '
                'under different wording.'
            )
    return result


def _impl_forget(con, session, arguments):
    memory_id = arguments.get('memory_id')
    if not isinstance(memory_id, int) or memory_id <= 0:
        return {'ok': False, 'reason': 'invalid_id',
                'message': "memory_id must be a positive integer."}
    row = con.execute("SELECT id FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        return {'ok': False, 'reason': 'not_found',
                'message': f'Memory {memory_id} does not exist.'}
    con.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    return {'ok': True, 'id': memory_id}


_IMPLS = {
    'remember': _impl_remember,
    'recall': _impl_recall,
    'forget': _impl_forget,
}


MEMORY_TOOLS = [
    {
        'type': 'function',
        'name': 'remember',
        'description': (
            'Store a durable fact about the user so it survives across sessions. '
            'Use scope="core" for high-signal context that belongs in every future '
            'session prompt: identity facts (name, role, business), important '
            'relationships (family, team, key collaborators), long-standing '
            'preferences, ongoing projects, and anything the user explicitly asks '
            'you to always remember. Use scope="recall" (the default) for everything '
            'else worth keeping — past conversation context, one-off details, casual '
            'preferences — which the agent searches via `recall` on demand. '
            'On exact-content duplicates the existing memory is returned (created=false). '
            'When core scope hits the per-agent cap, returns {ok:false, reason:"core_full", '
            'oldest_id} — call `forget(oldest_id)` then retry.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'content': {
                    'type': 'string',
                    'description': f'The fact or memory detail to recall later '
                                   f'(max {CONTENT_MAX_LEN} chars). Write it as a '
                                   f'third-person statement about the user.',
                },
                'scope': {
                    'type': 'string',
                    'enum': ['core', 'recall'],
                    'description': 'core = always in prompt (cap per agent); recall = searched on demand.',
                    'default': 'recall',
                },
                'tags': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Optional short labels ("preferences", "business") '
                                   'that help future recall searches. Reuse existing '
                                   'tags from the **Known tags** list in your system '
                                   'prompt for consistency — only invent a new tag '
                                   'when none of the existing ones fit.',
                    'default': [],
                },
            },
            'required': ['content'],
        },
    },
    {
        'type': 'function',
        'name': 'recall',
        'description': (
            'Search the user\'s recall memories for facts and past-conversation '
            'episodes relevant to a query. Call this when the user references '
            'something past ("remember when…", "the thing I told you about X", '
            '"what did I say about Y"). Matching combines keyword search (with OR '
            'semantics across your query words), substring matching, and tag '
            'matching, optionally bounded by a date range. For purely '
            'time-anchored questions ("what did we do last week?", "what '
            'happened a few weeks ago?") pass ONLY a date range and NO query '
            '— e.g. {"newer_than_days": 10} for last week — which returns '
            'everything from that period, episodes first. Only combine a '
            'query WITH a range when the user names a topic as well ("the '
            'budget talk last month" → {"query": "budget", "older_than_days": '
            '14, "newer_than_days": 60}). Human time estimates are fuzzy, so '
            'err WIDE: "a few weeks ago" is roughly older_than_days=10, '
            'newer_than_days=45. Hits include `memory_type`: a `fact` is a '
            'one-line statement; an `episode` (marked `expandable`) is a summary '
            'of a past conversation block — call recall again with its '
            '`episode_id` to read the full verbatim conversation. This searches '
            'the recall archive only — your core memories are already in this '
            'prompt; check them first, they may answer without any tool call.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'query': {
                    'type': 'string',
                    'description': (
                        'Plain natural keywords describing what you\'re looking '
                        'for — e.g. `"favorite color"` or `"birthday plans"`. '
                        'Do NOT construct boolean expressions ("X OR Y", "A AND '
                        'B") — the search already ORs your words automatically '
                        'and treats operator keywords as noise. NEVER put time '
                        'words ("last week", "recently", "ago") or filler '
                        '("what we did", "activities") here — time belongs in '
                        'the date-range parameters, and for a purely '
                        'time-anchored question OMIT this field entirely and '
                        'pass only the range. Optional when `episode_id` or a '
                        'date range is given.'
                    ),
                },
                'newer_than_days': {
                    'type': 'integer',
                    'description': (
                        'Only memories created within the last N days. Pairs '
                        'with older_than_days to form a window — e.g. "a few '
                        'weeks ago" → newer_than_days=45, older_than_days=10.'
                    ),
                },
                'older_than_days': {
                    'type': 'integer',
                    'description': (
                        'Only memories created at least N days ago — e.g. '
                        '"recently" → omit this; "a while back" → 30+.'
                    ),
                },
                'episode_id': {
                    'type': 'integer',
                    'description': (
                        'Id of an episode from a previous recall hit. When set, '
                        'returns that episode\'s full verbatim transcript instead '
                        'of running a search — use it when an episode summary '
                        'omits a detail you need.'
                    ),
                },
                'tags': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': (
                        'Optional tag hints — memories tagged with any of these '
                        'rank higher, but tags never exclude: untagged and '
                        'content-only matches are still returned. Safe to pass '
                        'whenever a known tag fits; pick from the **Known tags** '
                        'list in your system prompt.'
                    ),
                    'default': [],
                },
                'limit': {
                    'type': 'integer',
                    'description': (
                        'Maximum hits to return, capped at 100. Defaults: 10 '
                        'for a keyword search, 25 when browsing a date range '
                        'without a query. Go above 25 only when the user '
                        'wants an exhaustive review of a period — episode '
                        'hits are whole conversation summaries, so large '
                        'results are slow to process in a live voice call; '
                        'prefer a narrower date range instead. If a result '
                        'comes back with truncated=true, the period held '
                        'more than was returned.'
                    ),
                },
            },
            'required': [],
        },
    },
    {
        'type': 'function',
        'name': 'forget',
        'description': (
            'Delete a memory by id. Use when the user contradicts a stored fact, '
            'tells you to forget something, or you need to free up a core slot '
            'before adding a new core memory. Ids come from `recall` hits, from '
            'the core list in your system prompt, or from a `core_full` response.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'memory_id': {
                    'type': 'integer',
                    'description': 'Numeric id of the memory to delete.',
                },
            },
            'required': ['memory_id'],
        },
    },
]


MEMORY_TOOL_NAMES = {t['name'] for t in MEMORY_TOOLS}


def execute_memory_tool(con, session, tool_name, arguments):
    """Run a memory tool. Returns the tool result on success or
    {ok:false, reason, message} on handled failure."""
    impl = _IMPLS.get(tool_name)
    if not impl:
        return {'ok': False, 'reason': 'unknown_tool',
                'message': f'Unknown memory tool: {tool_name}'}
    try:
        return impl(con, session, arguments or {})
    except Exception as e:
        _logger.exception('Memory tool %s failed', tool_name)
        return {'ok': False, 'reason': 'internal_error',
                'message': f'Internal error: {e}'}
