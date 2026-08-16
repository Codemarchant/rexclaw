# Copyright 2026 Codemarchant
"""Affection tool: the companion adjusts its persistent affection score.

Mirrors memory_tools' shape: name set + executor, but the tool schema is
built per companion (build_tools) because the scale is per-companion config.
The score and its scale live directly on the agents row (single-user app —
no per-user dimension): affection_max_score split into affection_level_count
tiers, at most affection_max_delta movement per tool call. The score and the
author-configured affection rules are injected into the session prompt by
session_service, so the companion always knows where the friendship stands.
The browser-side dispatcher watches this tool's result to play the heart
effect around the avatar.
"""
import logging

_logger = logging.getLogger(__name__)

# Baked-in defaults for the per-companion scale, also the fallbacks when a
# stored value is missing or nonsense. There is deliberately NO default-score
# config: the editable affection_score field on the companion form IS the
# starting score (its column default is 150 — mid level 2 of the default
# scale, a buffer above the level-1 "Cold" fall-from-grace zone).
DEFAULT_MAX_SCORE = 1000
DEFAULT_LEVEL_COUNT = 10
DEFAULT_MAX_DELTA = 5
DEFAULT_MAX_DELTA_MAJOR = 200


def config_for(agent_row):
    """The companion's affection scale, sanitized against bad stored values.

    Returns {max_score, level_count, level_size, max_delta}. level_size is
    always derived (max_score // level_count) — it is not stored, so it can
    never drift out of step with the other two.
    """
    def _pos_int(value, fallback):
        try:
            v = int(value)
        except (TypeError, ValueError):
            return fallback
        return v if v > 0 else fallback

    level_count = _pos_int(agent_row['affection_level_count'], DEFAULT_LEVEL_COUNT)
    # max_score below level_count would make level_size 0 (division tiers of
    # nothing) — floor it at one point per level.
    max_score = max(level_count, _pos_int(agent_row['affection_max_score'], DEFAULT_MAX_SCORE))
    max_delta = min(max_score, _pos_int(agent_row['affection_max_delta'], DEFAULT_MAX_DELTA))
    # The major clamp is never below the everyday one — a "major" event that
    # can move less than a normal call would be nonsense config.
    max_delta_major = max(max_delta, min(max_score, _pos_int(
        agent_row['affection_max_delta_major'], DEFAULT_MAX_DELTA_MAJOR)))
    return {
        'max_score': max_score,
        'level_count': level_count,
        'level_size': max_score // level_count,
        'max_delta': max_delta,
        'max_delta_major': max_delta_major,
    }


def level_for(score, cfg):
    return min(cfg['level_count'], max(0, score or 0) // cfg['level_size'] + 1)


def _impl_adjust_affection(con, session, arguments):
    row = con.execute(
        "SELECT * FROM agents WHERE id = ?", (session['agent_id'],)
    ).fetchone()
    if not row:
        return {'ok': False, 'reason': 'no_agent',
                'message': 'This companion no longer exists.'}
    cfg = config_for(row)
    severity = arguments.get('severity') or 'normal'
    if severity not in ('normal', 'major'):
        return {'ok': False, 'reason': 'invalid_severity',
                'message': "severity must be 'normal' or 'major'."}
    bound = cfg['max_delta_major'] if severity == 'major' else cfg['max_delta']
    delta = arguments.get('delta')
    if not isinstance(delta, int) or isinstance(delta, bool) or delta == 0:
        return {'ok': False, 'reason': 'invalid_delta',
                'message': f"delta must be a non-zero integer between "
                           f"-{bound} and {bound}."}
    # Clamp the delta to the severity's per-call bound and the resulting
    # score to 0..max_score, so delta_applied may be smaller than requested
    # when the score sits near a bound.
    delta = max(-bound, min(bound, delta))
    score = row['affection_score'] or 0
    new_score = max(0, min(cfg['max_score'], score + delta))
    applied = new_score - score
    if applied:
        con.execute(
            "UPDATE agents SET affection_score = ? WHERE id = ?",
            (new_score, session['agent_id']),
        )
    return {
        'ok': True,
        'delta_applied': applied,
        'severity': severity,
        'score': new_score,
        'level': level_for(new_score, cfg),
        'max_score': cfg['max_score'],
        'max_level': cfg['level_count'],
    }


_IMPLS = {
    'adjust_affection': _impl_adjust_affection,
}


AFFECTION_TOOL_NAMES = set(_IMPLS)


def build_tools(agent_row):
    """The affection tool list for one companion — the delta bounds in the
    schema come from its configured scale.

    The description is deliberately mechanical: what the tool does, plus a
    pointer to the prompt's Affection rules. WHEN to adjust (and what raises
    or lowers the score) is policy, and policy belongs solely to the
    author-editable rules — a baked-in example here would fight any ruleset
    that scores unconventionally.
    """
    cfg = config_for(agent_row)
    return [
        {
            'type': 'function',
            'name': 'adjust_affection',
            'description': (
                f'Change your persistent affection score toward the user by '
                f'a signed delta; the score stays within 0..'
                f'{cfg["max_score"]} and the updated score and level come '
                f'back in the result. With severity "normal" (the default) '
                f'the delta is clamped to ±{cfg["max_delta"]} per call. '
                f'severity "major" widens the clamp to '
                f'±{cfg["max_delta_major"]}, but exists ONLY for the '
                f'exceptional, relationship-defining events your Affection '
                f'rules explicitly describe — NEVER use it for ordinary '
                f'good or bad moments, and when in doubt it is "normal". '
                f'When to call this at all — and what raises or lowers the '
                f'score — is defined entirely by the Affection rules in '
                f'your system prompt; follow them rather than any general '
                f'intuition.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'delta': {
                        'type': 'integer',
                        'minimum': -cfg['max_delta_major'],
                        'maximum': cfg['max_delta_major'],
                        'description': f'Signed change to apply. Clamped to '
                                       f'±{cfg["max_delta"]} at severity '
                                       f'"normal", ±{cfg["max_delta_major"]} '
                                       f'at "major".',
                    },
                    'severity': {
                        'type': 'string',
                        'enum': ['normal', 'major'],
                        'default': 'normal',
                        'description': '"normal" for everyday adjustments. '
                                       '"major" only for the rare events '
                                       'your Affection rules explicitly '
                                       'name as relationship-defining.',
                    },
                },
                'required': ['delta'],
            },
        },
    ]


def execute_affection_tool(con, session, tool_name, arguments):
    """Run an affection tool for the session's companion."""
    impl = _IMPLS.get(tool_name)
    if not impl:
        return {'ok': False, 'reason': 'unknown_tool',
                'message': f'Unknown affection tool: {tool_name}'}
    try:
        return impl(con, session, arguments or {})
    except Exception as e:
        _logger.exception('Affection tool %s failed', tool_name)
        return {'ok': False, 'reason': 'internal_error',
                'message': f'Internal error: {e}'}
