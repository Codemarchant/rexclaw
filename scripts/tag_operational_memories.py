#!/usr/bin/env python3
"""Tag existing recall memories that record operating the app, not living a life.

New episodes get the `operational` tag from the extractor. This is the one-off
pass for everything written before that, which on a developer's own archive is
most of it: a cue like "get mad at me again" otherwise finds the last time the
feature was exercised, and answers with that take.

Tagging only — nothing is deleted or rewritten, and deliberate `recall` still
finds these. `memory_index.VETO_TAGS` is what keeps them out of spontaneous
recall.

    python scripts/tag_operational_memories.py --db data/rexclaw.sqlite3
    python scripts/tag_operational_memories.py --db data/rexclaw.sqlite3 --apply

Reads the TypeSafe key and Jev model from the database's own config.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import jev  # noqa: E402

# Judged on a real archive: every memory worth recalling scored at or below
# .52, while the sessions behind every bad callback scored .64 upwards. The
# band between is genuinely mixed — one session that both tested a feature and
# mattered — so the default leaves it alone and takes only the clear cases.
THRESHOLD = .80
BATCH = 10
QUESTION = (
    'Is `rows.{key}` mostly low-value mechanics - repeated commands, exercising tools, generating '
    'test assets, reciting demo scripts, debugging, releasing - with little of the companion in it '
    'beyond carrying them out?')


def classify(key, model, rows):
    """{memory_id: probability} for one batch, skipping anything unanswered."""
    state = {'rows': {f'r{r["id"]}': {'text': (r['content'] or '')[:600],
                                      'keywords': (r['keywords'] or '')[:150]} for r in rows}}
    qs = {f'r{r["id"]}_op': {'type': 'noul', 'instructions': QUESTION.format(key=f'r{r["id"]}')}
          for r in rows}
    answers = jev.answers(jev.ask(key, model, state, qs, timeout=(3, 30)), qs)
    return {r['id']: answers.get(f'r{r["id"]}_op', {}).get('yes') for r in rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--apply', action='store_true',
                        help='write the tags (otherwise report what would change)')
    parser.add_argument('--threshold', type=float, default=THRESHOLD)
    parser.add_argument('--agent', type=int, help='one companion only, by id')
    parser.add_argument('--report', type=Path, help='write every score here as JSON')
    args = parser.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    key, model = con.execute('SELECT typesafe_api_key,jev_model FROM config WHERE id=1').fetchone()
    if not key:
        raise SystemExit('Configure a TypeSafe key first.')
    scope = 'AND m.agent_id=?' if args.agent else ''
    rows = con.execute(
        "SELECT m.id,m.memory_type,m.keywords,m.content,m.tags FROM memories m "
        "WHERE m.scope='recall' AND COALESCE(m.tags,'') NOT LIKE '%operational%' " + scope +
        ' ORDER BY m.id', (args.agent,) if args.agent else ()).fetchall()
    print(f'{len(rows)} untagged recall memories, {len(rows) // BATCH + 1} requests, '
          f'threshold {args.threshold}')
    scores, tag = {}, []
    try:
        for start in range(0, len(rows), BATCH):
            batch = rows[start:start + BATCH]
            for memory_id, p in classify(key, model, batch).items():
                scores[memory_id] = p
                if p is not None and p >= args.threshold:
                    tag.append(memory_id)
            print(f'  judged {min(start + BATCH, len(rows))}/{len(rows)}', flush=True)
    except Exception as exc:                      # partial progress is still worth keeping
        print(f'stopped early: {type(exc).__name__} {exc}')
    unanswered = [m for m, p in scores.items() if p is None]
    by_type = {}
    for r in rows:
        if r['id'] in tag:
            by_type[r['memory_type']] = by_type.get(r['memory_type'], 0) + 1
    print(f'\noperational: {len(tag)} of {len(scores)} judged '
          f'({len(tag) / max(1, len(scores)):.0%}) — ' +
          ', '.join(f'{n} {t}' for t, n in sorted(by_type.items())))
    if unanswered:
        print(f'unanswered (left alone): {len(unanswered)}')
    if args.report:
        args.report.write_text(json.dumps(scores, indent=1) + '\n', encoding='utf-8')
        print(f'scores written to {args.report}')
    if not args.apply:
        print('\nnothing written. Re-run with --apply to tag these.')
        return
    con.executemany("UPDATE memories SET tags=TRIM(COALESCE(tags||',','')||'operational',',') "
                    'WHERE id=?', [(m,) for m in tag])
    con.commit()
    print(f'\ntagged {len(tag)} memories. Deliberate recall still finds them; '
          'spontaneous recall no longer offers them.')
    con.close()


if __name__ == '__main__':
    main()
