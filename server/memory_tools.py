# Copyright 2026 Codemarchant
"""Memory tools exposed to xAI as `type:'function'` tools.

Three tools — `remember`, `recall`, `forget` — let a companion build up a
durable picture of the user across sessions. Core memories are injected into
the session preamble verbatim; recall memories live in a larger pool the agent
searches via the `recall` tool when the conversation references something past.

Search note: the Odoo original used Postgres FTS + pg_trgm. The standalone is
single-user with a small memory set, so recall scoring runs in Python: token
overlap (with prefix relaxation for plurals), substring bonus, and tag
matching. Same OR semantics, no extensions needed.
"""
import logging
import re
from datetime import datetime

from .db import utcnow, parse_dt
from . import store

_logger = logging.getLogger(__name__)

CONTENT_MAX_LEN = 1024
DEFAULT_CORE_CAP = 100

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


def search_recall(con, agent_id, query, limit=5, tags=None):
    """Score recall memories in Python. Signals (weighted sum, mirroring the
    original's FTS-dominant weighting):
      * distinct query tokens matched in content (x10)
      * literal query substring in content (+50)
      * query substring in tags (+0.3 — tag bonus)
    Optional `tags` list narrows results to memories carrying at least one of
    the given tag tokens (exact token match, not substring)."""
    query = (query or '').strip()
    if not query:
        return []
    limit = max(1, min(int(limit or 5), 25))
    q_lower = query.lower()
    q_tokens = _tokenize(query)

    clean_filter = sorted({
        t.strip().lower() for t in (tags or [])
        if isinstance(t, str) and t.strip()
    })

    if agent_id:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'recall' AND (agent_id = ? OR agent_id IS NULL)",
            (agent_id,),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM memories WHERE scope = 'recall' AND agent_id IS NULL",
        ).fetchall()

    scored = []
    for r in rows:
        row_tags = {t.strip().lower() for t in (r['tags'] or '').split(',') if t.strip()}
        if clean_filter and not (row_tags & set(clean_filter)):
            continue
        content_lower = (r['content'] or '').lower()
        h_tokens = list(dict.fromkeys(_tokenize(content_lower)))
        match_count = sum(
            1 for qt in q_tokens
            if any(_token_match(ht, qt) for ht in h_tokens)
        )
        score = match_count * 10.0
        if q_lower in content_lower:
            score += 50.0
        if r['tags'] and q_lower in r['tags'].lower():
            score += 0.3
        if score <= 0:
            continue
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
    return hits


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
    query = (arguments.get('query') or '').strip()
    limit = arguments.get('limit') or 5
    raw_tags = arguments.get('tags') or []
    if not query:
        return {'ok': False, 'reason': 'query_empty', 'message': 'recall query cannot be empty.'}

    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(',') if t.strip()]
    elif isinstance(raw_tags, (list, tuple)):
        tags = [t for t in raw_tags if isinstance(t, str) and t.strip()]
    else:
        tags = []

    agent_id = session['agent_id'] if session else None
    records = search_recall(con, agent_id, query, limit=limit, tags=tags)

    now = datetime.utcnow()
    hits = []
    for r in records:
        created = parse_dt(r['created_at'])
        age = (now - created).days if created else None
        hits.append({
            'id': r['id'],
            'content': r['content'],
            'tags': r['tags'] or '',
            'age_days': age,
            'scope_on_agent': bool(r['agent_id']),
        })
    return {'ok': True, 'query': query, 'count': len(hits), 'hits': hits}


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
            'Search the user\'s recall memories for facts relevant to a query. '
            'Call this when the user references something past ("remember when…", '
            '"the thing I told you about X", "what did I say about Y"). Matching '
            'combines keyword search (with OR semantics across your query words), '
            'substring matching, and tag matching. Returns up to `limit` hits with '
            'age in days so you can prefer fresh memories. Core memories are '
            'already in your prompt — no need to recall them.'
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
                        'and treats operator keywords as noise.'
                    ),
                },
                'tags': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': (
                        'Optional tag filter — when provided, only memories '
                        'tagged with at least one of these values are returned '
                        '(AND with the content match). Pick tags from the '
                        '**Known tags** list in your system prompt; using a '
                        'tag the user has never created will return no hits. '
                        'Omit when doing a broad keyword search across all '
                        'tagged and untagged memories.'
                    ),
                    'default': [],
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Maximum hits to return (default 5, max 25).',
                    'default': 5,
                },
            },
            'required': ['query'],
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
