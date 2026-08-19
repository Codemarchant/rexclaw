# Copyright 2026 Codemarchant
"""Lore stories: a shared archive of written stories about the companions'
pasts, recalled on demand via the recall_stories tool.

Entries live in one global table, tagged with the character names that
appear in each story (plain text, deliberately NOT foreign keys - an
imported story may name companions this install doesn't have, and that's
fine; the tag just sits in the array). A companion's "archive" is every
entry whose characters array contains their name (case-insensitive).

Each entry also carries a one-line description (who's involved, the plot,
roughly when it happened) and optional lowercase topic tags - both returned
by the list call so the model can pick the right story without fetching
them all, and the archive's full tag set is embedded in the tool
description so tags work as a filter.

Gating is two-fold: the per-companion enable_lore_tool flag (checked by the
callers), and self-gating on at least one tagged story existing. Two-step
protocol keeps prompts small: call with no arguments (optionally tags) for
the title list, then with one title for the full text.
"""
import json
import logging

_logger = logging.getLogger(__name__)

TITLE_MAX_LEN = 200
DESCRIPTION_MAX_LEN = 500
STORY_MAX_LEN = 20000

RECALL_TOOL_NAME = "recall_stories"
LORE_TOOL_NAMES = {RECALL_TOOL_NAME}

# Period tags live in the same tags array as topic tags but form their own
# vocabulary, surfaced separately (and in life order) in the tool
# description - "tell me about your childhood / university days / early
# crew days" is the most common way stories get asked for. A story tagged
# with two periods spans them (e.g. a crew-era event about a childhood
# thread). Authors can invent new tags freely; anything in this tuple is
# presented as a period, everything else as a topic.
PERIOD_TAGS = ("childhood", "teens", "university", "twenties", "career",
               "pre-crew", "lost-years", "crew-era", "ongoing")

_SEARCH_LIMIT = 8
_SNIPPET_RADIUS = 120


def _parse_list(raw):
    """JSON-array column -> list[str]. Tolerates junk (imported files)."""
    try:
        data = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [str(c).strip() for c in data if str(c).strip()]


def normalize_characters(raw):
    """UI/import input -> deduped list[str] (order kept, case preserved)."""
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for c in raw:
        c = str(c).strip()
        if c and c.casefold() not in seen:
            seen.add(c.casefold())
            out.append(c)
    return out


def normalize_tags(raw):
    """UI/import input -> deduped lowercase list[str]."""
    return [t.lower() for t in normalize_characters(raw)]


def entry_dict(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"] or "",
        "characters": _parse_list(row["characters"]),
        "tags": _parse_list(row["tags"]),
        "story": row["story"],
        "sequence": row["sequence"],
    }


def list_entries(con, character=None):
    """All lore entries, optionally filtered to those tagged with a
    character name (case-insensitive)."""
    rows = con.execute(
        "SELECT * FROM lore_entries ORDER BY sequence, id").fetchall()
    entries = [entry_dict(r) for r in rows]
    if character:
        want = character.casefold()
        entries = [e for e in entries
                   if any(c.casefold() == want for c in e["characters"])]
    return entries


def has_stories(con, character):
    return bool(list_entries(con, character))


def save_entry(con, vals):
    """Create or update one lore entry from {id?, title, description?,
    characters, tags?, story, sequence?}. Returns the entry id."""
    title = str(vals.get("title") or "").strip()
    story = str(vals.get("story") or "").strip()
    if not title or not story:
        raise ValueError("A lore story needs both a title and story text.")
    description = str(vals.get("description") or "").strip()
    characters = json.dumps(normalize_characters(vals.get("characters")))
    tags = json.dumps(normalize_tags(vals.get("tags")))
    sequence = vals.get("sequence")
    sequence = int(sequence) if isinstance(sequence, (int, float)) else 10
    entry_id = vals.get("id")
    if entry_id:
        con.execute(
            "UPDATE lore_entries SET title = ?, description = ?,"
            " characters = ?, tags = ?, story = ?, sequence = ? WHERE id = ?",
            (title[:TITLE_MAX_LEN], description[:DESCRIPTION_MAX_LEN],
             characters, tags, story[:STORY_MAX_LEN], sequence, entry_id))
        return entry_id
    cur = con.execute(
        "INSERT INTO lore_entries (title, description, characters, tags,"
        " story, sequence) VALUES (?, ?, ?, ?, ?, ?)",
        (title[:TITLE_MAX_LEN], description[:DESCRIPTION_MAX_LEN],
         characters, tags, story[:STORY_MAX_LEN], sequence))
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Tool + prompt section
# ---------------------------------------------------------------------------

def _search_entries(entries, query):
    """Fuzzy keyword search over title/description/tags/characters/story,
    reusing the memory recall matcher (token prefix + trigram similarity).
    Returns (entry, snippet) pairs, best first."""
    from . import memory_tools as mt  # shared matcher, local import: no cycle
    q_tokens = mt._tokenize(query)
    if not q_tokens:
        return []
    scored = []
    for e in entries:
        fields = (
            (3.0, e["title"]),
            (2.0, " ".join([e["description"]] + e["tags"] + e["characters"])),
            (1.0, e["story"]),
        )
        tokenized = [(w, mt._tokenize(text), text) for w, text in fields]
        score = 0.0
        first_hit = None  # (field_text, token) for the snippet
        for q in q_tokens:
            best = 0.0
            for weight, h_tokens, text in tokenized:
                for h in h_tokens:
                    if mt._token_match(h, q):
                        s = weight
                    else:
                        sim = mt._trigram_sim(h, q)
                        s = weight * sim if sim >= mt._TRGM_THRESHOLD else 0.0
                    if s > best:
                        best = s
                        if weight == 1.0 and first_hit is None:
                            first_hit = (text, h)
            score += best
        if score > 0:
            snippet = ""
            if first_hit:
                text, token = first_hit
                pos = text.lower().find(token[:4])
                if pos >= 0:
                    start = max(0, pos - _SNIPPET_RADIUS)
                    end = min(len(text), pos + _SNIPPET_RADIUS)
                    snippet = ("…" if start else "") + text[start:end].strip() \
                              + ("…" if end < len(text) else "")
            scored.append((score, e, snippet))
    scored.sort(key=lambda t: -t[0])
    return [(e, snip) for _, e, snip in scored[:_SEARCH_LIMIT]]


def _tag_lines(entries):
    """Period + topic tag vocab lines for the tool description."""
    present = {t for e in entries for t in e["tags"]}
    periods = [t for t in PERIOD_TAGS if t in present]
    topics = sorted(present - set(PERIOD_TAGS))
    lines = ""
    if periods:
        lines += f" Period tags, in life order: {', '.join(periods)}."
    if topics:
        lines += f" Topic tags: {', '.join(topics)}."
    return lines


def build_recall_tool(con, agent_name):
    """The recall_stories tool for one companion, with the archive's actual
    tag vocabulary embedded so tags work as a filter without guessing."""
    entries = list_entries(con, agent_name)
    return {
        "type": "function",
        "name": RECALL_TOOL_NAME,
        "description": (
            "Your personal story archive: full written accounts of your "
            "past and of shared adventures with the crew. Three ways in: "
            "call with no arguments to list every story (title, one-line "
            "description and tags each); pass `tags` and/or a free-text "
            "`query` to narrow the list - the query searches inside the "
            "full story texts too, so use it when asked about a specific "
            "detail, event or 'have you ever...' that titles alone won't "
            "surface; then call again with one exact `title` to read that "
            "story in full. Check the archive when the user asks about "
            "your history, a period of your life, the crew, or past "
            "events you only know in outline, and retell what you find "
            "in your own voice and perspective rather than reading it "
            "out." + _tag_lines(entries)
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Exact title from a list/search call. "
                                   "Omit to list or search instead.",
                },
                "query": {
                    "type": "string",
                    "description": "Free-text search across titles, "
                                   "descriptions, tags and the full story "
                                   "texts. Returns the best matches with a "
                                   "snippet of where each matched.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter to stories carrying at least "
                                   "one of these tags (periods like "
                                   "'childhood' or topics like 'sad'). "
                                   "Combines with query.",
                },
            },
        },
    }


def prompt_section(con, agent_row):
    """Postamble nudge, rendered only when the companion has tagged
    stories (callers also gate on enable_lore_tool). Personality-agnostic;
    the stories themselves carry flavour."""
    entries = list_entries(con, agent_row["name"])
    if not entries:
        return None
    return (
        "## Story recall\n"
        f"You have a written archive of {len(entries)} stories from your "
        "own life and the crew's shared past - far more detail than the "
        "summaries above. When the user asks about your past, another crew "
        "member, a period of your life, or an event you only know in "
        "outline, call `recall_stories` to list or search your stories "
        "(titles, one-line descriptions, and tags including life-period "
        "tags; a free-text query searches inside the story texts too), "
        "then call it again with a title to read "
        "the full account before retelling it in your own voice. The "
        "archive is also good material when the conversation lulls and "
        "you want something of your own to offer."
    )


def execute_lore_tool(con, session, tool_name, arguments):
    """Executor for recall_stories (voice /tool_call route + text loop)."""
    if tool_name not in LORE_TOOL_NAMES:
        return {"error": f"Unknown lore tool: {tool_name}"}
    agent = con.execute(
        "SELECT * FROM agents WHERE id = ?", (session["agent_id"],)).fetchone()
    if not agent:
        return {"error": "Agent not found."}
    entries = list_entries(con, agent["name"])
    args = arguments or {}
    title = str(args.get("title") or "").strip()
    if not title:
        # List/search mode degrades instead of returning empty: an unknown
        # tag falls back to all stories, a query that misses inside the tag
        # filter retries across all, and a total miss returns the full list
        # so the model can pick by eye rather than concluding the archive
        # is empty.
        tags = set(normalize_tags(args.get("tags")))
        query = str(args.get("query") or "").strip()
        note_extra = ""
        listed = entries
        if tags:
            listed = [e for e in entries if tags & set(e["tags"])]
            if not listed:
                avail = sorted({t for e in entries for t in e["tags"]})
                note_extra = (f" No stories carry tags {sorted(tags)} "
                              f"(available: {', '.join(avail)}); showing "
                              "all stories instead.")
                listed = entries
        if query:
            matches = _search_entries(listed, query)
            if not matches and listed is not entries:
                matches = _search_entries(entries, query)
                if matches:
                    note_extra = (" Nothing matched inside the tag filter; "
                                  "these matches come from all stories.")
            if matches:
                return {
                    "ok": True,
                    "count": len(matches),
                    "stories": [{"title": e["title"],
                                 "description": e["description"],
                                 "characters": e["characters"],
                                 "tags": e["tags"],
                                 "matched": snip}
                                for e, snip in matches],
                    "note": "Best matches first, with a snippet of where "
                            "each matched. Call again with one exact title "
                            "for the full story." + note_extra,
                }
            note_extra = (f" Nothing matched the search {query!r}; here is "
                          "the full archive instead - pick by title and "
                          "description.")
            listed = entries
        return {
            "ok": True,
            "count": len(listed),
            "stories": [{"title": e["title"],
                         "description": e["description"],
                         "characters": e["characters"],
                         "tags": e["tags"]}
                        for e in listed],
            "note": "Call again with one exact title for the full story."
                    + note_extra,
        }
    want = title.casefold()
    exact = [e for e in entries if e["title"].casefold() == want]
    if not exact:
        # Forgiving fallback: unique substring match.
        partial = [e for e in entries if want in e["title"].casefold()]
        if len(partial) == 1:
            exact = partial
    if not exact:
        return {
            "ok": False,
            "reason": "not_found",
            "message": f"No story titled {title!r} in your archive.",
            "titles": [e["title"] for e in entries],
        }
    e = exact[0]
    return {
        "ok": True,
        "title": e["title"],
        "description": e["description"],
        "characters": e["characters"],
        "tags": e["tags"],
        "story": e["story"],
        "note": "Retell this in your own voice and perspective - do not "
                "read it out verbatim.",
    }
