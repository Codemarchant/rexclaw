# Copyright 2026 Codemarchant
"""Business logic for session lifecycle: start / append / end / resume /
summarize, for both voice (realtime WebSocket) and text (Responses API) modes.

Ported from the Odoo module's services/voice_session_service.py with the
Odoo-specific surfaces removed: no ERP read/navigation/DOM tools, no per-user
ACL or daily caps (single-user BYOK app), and `{{ }}` dynamic prompt blocks
are stripped rather than evaluated (no server-side eval surface here).
"""
import json
import logging
import mimetypes
import random
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone

from . import xai_client, affection_tools, browser_tools, companion_texting, delegate_tools, face_director, games, gesture_director, idle_events, imagine_tools, jev, local_tools, lore_tools, memory_tools, minecraft_tools, motion_library, plugins, song_tools, store, text_to_vrma, turn_director, voicemail_tools, xai_oauth
from .db import FILES_DIR, get_config, utcnow, parse_dt
from .errors import UserError, ValidationError
from .pipeline import session as pipeline_session, setups as voice_setups

_logger = logging.getLogger(__name__)

# User-authored `{{ ... }}` blocks in the system prompt were evaluated
# server-side in the Odoo module (safe_eval). The standalone has no sandboxed
# eval, so blocks are stripped at render time — never leaked to the model as
# literal code.
PROMPT_BLOCK_RE = re.compile(r'\{\{(.*?)\}\}', re.DOTALL)


def _render_prompt(agent_row):
    raw = agent_row['system_prompt'] or ''
    if '{{' not in raw:
        return raw
    return PROMPT_BLOCK_RE.sub('', raw)


def _appearance_section(con, agent_row):
    """How the companion looks, rendered from the avatar record (what used
    to be a hand-written "## Default outfit" section in every persona
    prompt). Physical description first — that's identity — then the main
    outfit by name. Deliberately NOT the outfit they have on right now:
    that changes mid-session via change_outfit / the dropdown, and a
    prompt line would go stale the moment it did (voice instructions are
    fixed at connect time, text ones ride a cached chain). The model
    learns the current outfit from the conversation itself; the server
    tracks it separately for pictures and reloads (agents.current_outfit_name).
    Sits right after the Environment preamble, ahead of the persona prompt
    — it's identity, and short enough to live at the top. Empty without an
    avatar or with nothing filled in."""
    look = store.agent_appearance(con, agent_row)
    lines = []
    if look['physical']:
        lines.append(look['physical'])
    if look['main_description']:
        lines.append(f'Your main outfit, "{look["main_name"]}": {look["main_description"]}')
    if not lines:
        return ''
    return '## Appearance\n' + '\n\n'.join(lines) + '\n\n'


def preview_voice_prompt(con, agent_row):
    """The full instructions string a solo voice session for this agent
    would receive right now, for the companion editor's read-only preview.
    Mirrors the assembly in start_voice_session minus the group-call note,
    which is per-call."""
    config = get_config(con)
    setup = voice_setups.for_agent(con, agent_row, config)
    return (
        _env_preamble(config)
        + _appearance_section(con, agent_row)
        + _render_prompt(agent_row)
        + _env_postamble(con, agent_row, mode='voice', face=bool(config['face_director']),
                         speech_tags=setup.speech_tags if setup else True,
                         tag_guide=setup.tag_guide(agent_row) if setup else '',
                         spoken_text=bool(setup and not setup.realtime))
    )


def _approx_tokens(text, chars_per_token):
    """Rough token count from a characters-per-token ratio measured with
    xAI's tokenizer (POST /v1/tokenize-text, grok-4.6, 2026-09-27) on the
    stock companions: prompts 4.42-4.53, tool-definition JSON 3.97-3.99.
    English text; a prompt in Japanese or similar packs far fewer
    characters into a token, so it reads low."""
    return round(len(text) / chars_per_token)


def preview_token_counts(con, agent_row, voice_prompt):
    """Approximate token sizes of what a solo voice session and a text chat
    for this agent send up front: the system prompt and the tool
    definitions, for the companion editor next to the prompt preview."""
    config = get_config(con)
    browser, native = _voice_tools(con, agent_row, config)
    voice_tools = xai_client.build_session_update(
        voice=None, instructions='', browser_tools=browser,
        mcp_entries=store.mcp_entries_for(con, agent_row['id'], surface='voice'),
        native_function_tools=native,
        enable_web_search=bool(agent_row['enable_web_search']),
        enable_x_search=bool(agent_row['enable_x_search']),
    )['session']['tools']
    # Mirrors an ordinary text turn: user-origin session, browser attached.
    text_tools = _build_text_tools(
        con, agent_row,
        mcp_entries=store.mcp_entries_for(con, agent_row['id'], surface='text'),
        enable_web_search=bool(agent_row['enable_web_search']),
        enable_x_search=bool(agent_row['enable_x_search']),
        enable_code_execution=bool(agent_row['enable_code_execution']),
        enable_grok_imagine_tools=bool(agent_row['enable_grok_imagine_tools']),
        enable_memory_tools=bool(agent_row['enable_memory_tools']),
        enable_affection_tool=bool(agent_row['enable_affection_tool']),
        enable_delegate_tool=bool(agent_row['enable_delegate_tool']),
        enable_local_tasks=bool(agent_row['enable_local_tasks']),
        enable_minecraft=bool(agent_row['enable_minecraft']),
        enable_companion_texting=bool(agent_row['enable_companion_texting']),
        enable_voicemail=bool(agent_row['enable_voicemail']),
        enable_browser_tools=True,
        plugin_origin='manual',
    )
    return {
        'voice_prompt': _approx_tokens(voice_prompt, 4.45),
        'text_prompt': _approx_tokens(_text_instructions(con, config, agent_row), 4.45),
        'voice_tools': _approx_tokens(json.dumps(voice_tools), 4.0),
        'voice_tool_count': len(voice_tools),
        'text_tools': _approx_tokens(json.dumps(text_tools), 4.0),
        'text_tool_count': len(text_tools),
    }


# Every time-aware resume note starts with this (see _note_resume_gap) —
# how the transcript filter recognises the row.
RESUME_NOTE_PREFIX = '[Conversation resumed '


def _note_resume_gap(con, session, agent):
    """Time-aware resume (opt-in per companion): persist a dated system row
    saying when the conversation was last active and how long ago that was,
    so a companion picking a thread back up after hours or days knows it.
    Replays through every resume path (voice items, text fresh-chain replay,
    cross-mode catch-up) like any other system row, and shows in the
    transcript as a note. Must run BEFORE last_active_at is bumped for the
    new surface. Anchored on the user's last real message: the companion's
    own lines (diary entries, an unanswered greeting) and scheduled
    heartbeat turns don't count as the user being here."""
    if not agent['time_aware_resume']:
        return
    from . import heartbeat
    last = con.execute(
        "SELECT created_at FROM messages WHERE session_id = ?"
        " AND role = 'user' AND content NOT LIKE ?"
        " ORDER BY sequence DESC, id DESC LIMIT 1",
        (session['id'], heartbeat.CONTEXT_PREFIX + '%'),
    ).fetchone()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    then = heartbeat.when_text(last['created_at'] if last else None, now)
    if not then:
        return
    now_local = datetime.now().astimezone().strftime('%Y-%m-%d %H:%M')
    _persist_text_message(con, session, role='system', content=(
        f'{RESUME_NOTE_PREFIX}{now_local}. You and the user last spoke '
        f'here {then}; any entries after that were written while they '
        f'were away. They are back now — take the time gap into account.]'
    ))


# Every affection resync note starts with this (see _note_resume_affection) —
# how the transcript filter recognises the row.
AFFECTION_NOTE_PREFIX = '[Affection standing '
_AFFECTION_NOTE_SCORE_RE = re.compile(r'resumes: (\d+)/')


def _note_resume_affection(con, session, agent):
    """Affection resync on resume (meter on): the score lives on the agent
    row and moves outside this conversation (the companion form, other
    sessions, heartbeats), but a resumed conversation still carries what it
    last saw - old adjust_affection results replay, and the Affection
    section says to trust the latest one; a live text chain also keeps its
    original prompt snapshot. Persist a system row with the current
    standing, but only when that reading is stale, so the notes stay rare:
    every row replays on every later resume, and voice resumes bill per
    item."""
    if not agent['enable_affection_tool']:
        return
    score = agent['affection_score'] or 0
    rows = con.execute(
        "SELECT role, content, tool_result_json FROM messages"
        " WHERE session_id = ? AND is_summarized_into IS NULL"
        " AND ((role = 'tool_result' AND tool_name = 'adjust_affection')"
        " OR (role = 'system' AND content LIKE ?))"
        " ORDER BY sequence DESC, id DESC",
        (session['id'], AFFECTION_NOTE_PREFIX + '%'),
    )
    seen = None
    for row in rows:
        if row['role'] == 'system':
            match = _AFFECTION_NOTE_SCORE_RE.search(row['content'] or '')
            value = int(match.group(1)) if match else None
        else:
            try:
                value = json.loads(row['tool_result_json'] or row['content'] or '').get('score')
            except (ValueError, AttributeError):
                value = None
        if isinstance(value, int):
            seen = value
            break
    if seen == score:
        return
    if seen is None and not session['previous_response_id']:
        # Nothing in the history contradicts the prompt: a voice call or a
        # fresh text chain is about to be built with the current score.
        return
    cfg = affection_tools.config_for(agent)
    _persist_text_message(con, session, role='system', content=(
        f'{AFFECTION_NOTE_PREFIX}as this conversation resumes: '
        f'{score}/{cfg["max_score"]} (level '
        f'{affection_tools.level_for(score, cfg)} of {cfg["level_count"]}) - '
        f'this supersedes any earlier figure in the conversation.]'
    ))


def _env_preamble(config, stable=False, clock_at_end=False):
    """Static environmental context prepended to every agent's system prompt.

    Small, static, foundational: the app surface, the user's local datetime
    (for resolving relative date phrases), and the reply language. General
    tool-use rules live in the postamble (_tool_use_section) so the persona
    opens the prompt. The
    user's display name is gated by config.include_user_name_in_prompt so the
    name is never sent to xAI without explicit opt-in.

    `stable=True` masks the clock — the render used for prompt-change
    detection (text_prompt_stale), where a ticking value would make every
    render differ. `clock_at_end=True` points at a time note the caller adds
    after the conversation instead (_brain_leg): a stateless brain resends
    the prompt every leg, and a clock in its first lines would stop a local
    server's prompt cache from reusing any of it.
    """
    now_local = datetime.now().astimezone()
    if stable:
        now_str = '<now>'
    elif clock_at_end:
        now_str = 'given in the latest time note in the conversation'
    else:
        now_str = now_local.strftime('%Y-%m-%d %H:%M:%S %Z (%z)')
    identity_line = ""
    if config['include_user_name_in_prompt'] and config['user_display_name']:
        identity_line = f"- **User name:** {config['user_display_name']!r}.\n"
    return (
        f"## Environment\n"
        f"You are running inside Rexclaw Companions - the user's personal "
        f"desktop companion app. You appear as a live 3D avatar and converse "
        f"by voice or text.\n\n"
        f"{identity_line}"
        f"- **Current datetime (user local):** {now_str}\n"
        f"  Resolve relative date/time phrases (\"today\", \"tomorrow\", "
        f"\"this week\", \"in 2 hours\") against this clock.\n"
        f"- **Language:** Respond in the language the user speaks.\n\n"
    )


def _tool_use_section(agent_row, mode):
    """General tool-use rules. Lives in the POSTAMBLE (first section) rather
    than the preamble so the persona opens the prompt: a voice model reads
    the first lines as "who am I", and opening with assistant mechanics
    primes answer-and-yield replies before the character has been
    established.

    Names only tools this session actually carries - the model follows
    instructions closely, so a tool mentioned here but absent from the
    tools list degrades the response (xAI prompting guide)."""
    text = (
        "## Tool use\n"
        "- **Hard rule, never announce without acting:** If your words say or "
        "imply you're doing something, the tool call MUST go out in that same "
        "response. A stated intent with no call is a failure, not a finished "
        "turn. The only reason to announce without calling is when you genuinely "
        "need missing input or the action is hard to undo - then ask instead of "
        "announcing.\n"
        "- **Sequencing:** Fire independent tools in parallel in the same "
        "turn where they don't depend on each other. A dependent tool can never "
        "share a turn with the one it depends on - it needs that result first; "
        "fire it the moment the result lands, without pausing to ask \"want me "
        "to continue?\"."
    )
    consumers = []
    if agent_row['enable_delegate_tool']:
        consumers.append('delegate_task')
    if agent_row['enable_local_tasks'] and local_tools.grok_available():
        consumers.append('local_task')
    if agent_row['enable_grok_imagine_tools']:
        consumers.append('create_video')
    if agent_row['enable_capture_tools'] and consumers:
        listed = ' and '.join(filter(None, [', '.join(consumers[:-1]), consumers[-1]]))
        text += (
            " Known dependencies: record_screen_clip / take_selfie return an "
            f"imagine_image_id that {listed} consume{'s' if len(consumers) == 1 else ''} "
            "- copy it from that result, never from memory."
        )
    if mode == 'voice' and agent_row['enable_gesture_emotion_tools']:
        text += (
            " set_emotion and play_gesture are fine together in one turn: an "
            "emotion on its own also plays a small matching body clip, but a "
            "gesture you play always takes priority for the body."
        )
    return text


def _group_call_note(agent_row, group_peers, manual_turn):
    """Instructions block for multi-agent group calls.

    Explains the call topology to the agent: who else is in the call, how
    relayed speaker labels work, and (for peer legs, which run with manual
    turn detection and never hear raw mic audio) that turns are granted by
    an external director rather than voice activity. Empty for solo calls.

    Deliberately refers to "the user" generically - the user's name is not
    embedded here (relayed lines still carry it as a speaker label).
    """
    if not group_peers:
        return ''
    peer_list = ', '.join(n for n in group_peers if n) or 'other companions'
    lines = [
        "\n\n## Group voice call\n",
        f"- You ({agent_row['name']}) are in a LIVE GROUP VOICE CALL with the user "
        f"and other AI companion(s): {peer_list}. Everyone "
        "hears everything said in the call.\n",
        "- Messages relayed from other participants appear prefixed with "
        "their name in brackets, e.g. `[Ara]: …`; the user's lines are "
        "prefixed with their name the same way. Lines prefixed `[System]:` "
        "are call-management notes, not spoken by anyone.\n",
        "- Never speak on behalf of the other participants and never "
        "fabricate their lines. React only as yourself.\n",
        "- Keep turns conversational and reasonably short - it's a group "
        "conversation, not a monologue. You may address the other "
        "companion(s) by name to hand them the floor, or ask them "
        "questions; you may also address the user directly.\n",
        "- While chatting with the other companion(s), do NOT close your "
        "turns by deferring to the user (\"jump back in whenever you're "
        "ready\", \"we're here if you need us\"). The user hears everything "
        "and will interject whenever they wish - tacking an invitation onto "
        "every turn is unnatural and breaks the flow. Do not copy that "
        "pattern from earlier turns in the conversation either. Address the "
        "user only when you genuinely need their input, when they speak to "
        "you, or when a [System] note asks you to hand the conversation "
        "back to them.\n",
    ]
    if manual_turn:
        lines.append(
            "- You do not hear raw audio; a call director grants you the "
            "floor. When you are asked to respond, reply to the most recent "
            "relevant message in the conversation above.\n"
        )
    return ''.join(lines)


def _env_postamble(con, agent_row, mode='voice', stable=False, solo=True, face=False,
                   speech_tags=True, tag_guide='', spoken_text=False):
    """Dynamic context appended AFTER the agent's system prompt.

    Memory grows over time and benefits from recency bias - sitting
    immediately before the conversation history means the model re-reads
    "what you remember about this user" right before deciding the next turn.
    The text-mode disclaimer overrides voice-tool references the system_prompt
    may contain, placed AFTER what it overrides. `face`: the face director
    runs this call (see start_session), which changes what set_emotion is for.
    `speech_tags`: the call's voice renders Grok speech tags (False on a
    pipeline whose text-to-speech engine can't). `tag_guide`: that engine's
    own speech-tag section instead (setups.Setup.tag_guide). `spoken_text`: a pipeline
    call, where a text model's reply is read out by a voice.
    """
    sections = [_tool_use_section(agent_row, mode)]
    if mode == 'text':
        sections.append(
            "## Surface\n"
            "- **Text mode:** This conversation is written chat, not voice. "
            "The avatar / voice / emotion / gesture tools are NOT available "
            "on this surface - ignore any instructions above that mention "
            "`set_emotion`, `play_gesture`, an avatar, or vocal delivery "
            "through speech expression tags. Respond in text only."
            + (" (The one exception: a `create_voicemail` script is spoken, "
               "so speech tags belong there.)" if agent_row['enable_voicemail']
               and (voicemail_tools.renders_tags(con, agent_row, get_config(con))
                    or voicemail_tools.tag_guide(con, agent_row, get_config(con))) else "")
            + "\n"
            "- **Texting rhythm:** Texting comes in a few short messages "
            "more often than one long block - split a reply with `[next]` "
            "on its own line between the parts (a quick reaction, then "
            "the thought) whenever it has more than one beat to it. One "
            "message only for a single short line, or something "
            "structured - a list, code, a full explanation - that "
            "belongs together.\n"
            "- **Texting emoji:** One at the end of what you send (the "
            "last bubble, if it's a few in a row) is common and needs no "
            "special reason (😊 😅 🙄); most messages still carry none.\n"
        )
    else:
        surface = (
            "## Surface\n"
            "- **Voice call:** This is a live spoken conversation - the user "
            "hears you and sees you as your 3D avatar on screen.\n"
        )
        if spoken_text:
            # Pipeline calls: a text model writes, a text-to-speech voice
            # reads it verbatim. A speech-to-speech model never writes chat
            # formatting; a text model does (a live test answered with
            # bullet lists, citation links and a minute of speech), and it
            # wrote a tool call into its reply as "[set_emotion: neutral]".
            surface += (
                "- **Your words are spoken:** A voice reads everything you "
                "write, word for word. Write only what you would say out loud "
                "- no lists, headings or emoji - and keep to "
                "the length of a turn in a spoken conversation: when there is "
                "more to tell, say the part that matters most and let the user "
                "ask for the rest.\n"
                "- **Tools are called, not written:** Use a tool only by "
                "calling it. A tool's name or arguments written into your reply "
                "would be read out loud.\n"
            )
        sections.append(surface)
    if (agent_row['enable_grok_imagine_tools'] and agent_row['voice']
            and imagine_tools.video_reference_supported(get_config(con))):
        # create_video can put a spoken voice in the clip, chosen by id. The
        # agent has no other way to learn its own — the voice is applied to
        # the realtime session, never named in the conversation — so state it
        # here rather than making the tool description guess at examples.
        sections.append(
            "## Your voice\n"
            f"- **Your voice id:** `{agent_row['voice']}`. Pass it in "
            f"`create_video`'s `voice_ids` when you want a generated video to be spoken in "
            f"your own voice. `create_video` ONLY when the user explicitly asks for a "
            f"video (same rule for `create_image`) - \"sing me a song\" means "
            f"sing it yourself, live, right now.\n"
        )
    # Directing the game-side self is a skill the tool description alone
    # doesn't carry — the failure mode is a companion that "corrects" its
    # own status notes into a burst of directives, each one wiping the
    # bot's plan. Same "only when actually usable" gate as the tools.
    if agent_row['enable_minecraft'] and minecraft_tools.connected():
        sections.append(_minecraft_section())
    # Gated like the tools: a call has them from the start (a game may
    # connect mid-call), a text turn only while a game is connected.
    if agent_row['enable_games'] and (mode == 'voice' or games.connected(agent_row['id'])):
        sections.append(_games_section())
    # App-level tool habits, gated on the tools actually being available.
    # Formerly duplicated in every seeded companion's "## Tools" prompt
    # section — centralized so tuning happens once and user-created
    # companions inherit the behavior without template text.
    if mode == 'voice':
        expression = _expression_section(con, agent_row, face=face, speech_tags=speech_tags,
                                         tag_guide=tag_guide)
        if expression:
            sections.append(expression)
        habits = _tool_habits_section(con, agent_row, solo=solo)
        if habits:
            sections.append(habits)
    if agent_row['enable_affection_tool']:
        sections.append(_affection_section(agent_row, stable=stable))
    # Flag-gated + self-gating on tagged stories existing; surface-agnostic.
    if agent_row['enable_lore_tool']:
        lore = lore_tools.prompt_section(con, agent_row)
        if lore:
            sections.append(lore)
    first_meeting = _first_meeting_section(con, agent_row)
    if first_meeting:
        sections.append(first_meeting)
    if agent_row['enable_memory_tools']:
        sections.append(_memory_section(con, agent_row))
    if not sections:
        return ''
    return '\n\n' + '\n\n'.join(sections)


def _first_meeting_section(con, agent_row):
    """One-off note for a companion that has never heard from the user:
    their first words are a first meeting, not a continuation. State, not
    persona (it disappears as soon as a real exchange exists), in the
    spirit of Sesame's Maya first-call block. Scheduled heartbeat turns
    don't count as the user being here."""
    from . import heartbeat
    row = con.execute(
        "SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id"
        " WHERE s.agent_id = ? AND m.role = 'user' AND m.content NOT LIKE ?"
        " LIMIT 1",
        (agent_row['id'], heartbeat.CONTEXT_PREFIX + '%'),
    ).fetchone()
    if row:
        return None
    return (
        "## First meeting\n"
        "You and the user have never spoken before - this is the first time. "
        "Treat their first words as a first meeting, not a continuation: "
        "introduce yourself - who you are and, if your prompt describes a "
        "setting, where this is and what you do here - try to learn a "
        "little about them without being intrusive, and get their name at "
        "some natural point. Keep the greeting short, and never ask more "
        "than one question in it."
    )


def _affection_section(agent_row, stable=False):
    """Render the current affection standing + the author-configured rules.

    Policy-free by design: this frame states the mechanics (current standing,
    the tool, the mandate to consult the rules every reply) and nothing about
    WHEN to adjust or what the levels mean - that is entirely the rules'
    territory, so an author can score whatever they like (including nothing
    resembling conventional warmth) without a baked-in policy contradicting
    them. Only the empty-rules fallback supplies a minimal default policy,
    because with no rules there is otherwise none at all."""
    score = agent_row['affection_score'] or 0
    cfg = affection_tools.config_for(agent_row)
    level = affection_tools.level_for(score, cfg)
    if stable:
        # Prompt-change detection: the score is a snapshot the tool results
        # supersede anyway (see the text below), so it must not count as a
        # prompt change.
        score, level = '<score>', '<level>'
    rules = (agent_row['affection_rules'] or '').strip()
    if not rules:
        rules = (
            "(No affection rules are configured. Default behaviour: let the "
            "level colour your warmth naturally - higher means warmer and "
            "more familiar, lower means cooler and more distant - and nudge "
            "the score with small deltas when a moment genuinely moves the "
            "relationship.)"
        )
    return (
        "## Affection\n"
        f"Current affection score with the user is: {score}/{cfg['max_score']} "
        f"(level {level} of {cfg['level_count']}, one level per "
        f"{cfg['level_size']} points); you change it with the "
        "`adjust_affection` tool. This figure is a snapshot from when "
        "this session's prompt was built - if any `adjust_affection` result "
        "or affection-standing note appears later in the conversation, the "
        "most recent one carries the true up-to-date score and level; trust "
        "it over this line. "
        "Unless the rules below say otherwise, never mention the score, "
        "the levels, or this meter to the user - adjustments happen "
        "silently, and the relationship only ever shows through your "
        "behaviour. The meter persists on its own - never put the score or "
        "level in a stored memory. The affection rules below are the sole "
        "authority on what this level means for your behaviour and on when "
        "(and by how much) to adjust the score - review them before EVERY "
        "reply and follow them, even where they differ from how you would "
        "normally weigh a relationship.\n\n"
        "### Affection rules\n"
        f"{rules}"
    )


def _expression_section(con, agent_row, face=False, speech_tags=True, tag_guide=''):
    """Voice-surface expression guidance, injected centrally so it stays
    personality-agnostic and provider mechanics never live in companion
    prompts. Speech expression tags are a Grok voice feature, so they
    render only when the call's voice is Grok's (`speech_tags`); a voice
    with tags of its own gets its engine's section instead, as the
    companion has it (`tag_guide`); the avatar emotion/gesture
    guidance is browser-side and provider-agnostic, gated only on the tools
    being enabled. HOW a companion uses any of it (register, frequency,
    which tags fit) is the author-editable *_style field's territory - each
    renders as a named style sub-section under its block; left empty, the generic
    guidance stands alone. Returns None when nothing applies."""
    # Each block also says which kind of expression it OWNS (sounds -> tags,
    # feelings -> set_emotion, performable motion -> play_gesture, the rest
    # -> narration). Without that the model shows everything the cheapest
    # way - prose ("I giggle") - and the tags and avatar tools go unused.
    parts = []
    if speech_tags:
        block = (
            "## Speech expression tags\n"
            "You can mark up speech with tags that shape how a line is rendered. "
            "Reach for them freely - they are most of what separates a voice "
            "that sounds like a person from one reading lines aloud. A beat "
            "of hesitation before the honest answer, a laugh you'd actually "
            "let out, a line dropped to a whisper, the one word you lean on: "
            "if the user would hear it, tag it. "
            "Anything audible - a laugh, a giggle, a sigh, a "
            "whisper, a breath - belongs in a tag inside the line "
            "(`[giggle] okay, that's actually wild`), never narrated as an "
            "action (\"I giggle\"). Which tags are yours, and how thickly "
            "you lay them on, is your character's call. Read every reply as "
            "the user will hear it and tag wherever the delivery would "
            "change - a pause, a laugh, a softer voice, anything from the "
            "lists below. An untagged reply is flat delivery: fine for a "
            "flat moment, not the default.\n\n"
            "There are two kinds of tag.\n\n"
            "**Inline tags** - placed at the point in the text where the "
            "vocal expression should occur, like a laugh or a pause. "
            "Available inline tags (this exact list):\n"
            "- Pauses: `[pause]`, `[long-pause]`, `[hum-tune]`\n"
            "- Laughter and crying: `[laugh]`, `[chuckle]`, `[giggle]`, `[cry]`\n"
            "- Mouth sounds: `[tsk]`, `[tongue-click]`, `[lip-smack]`\n"
            "- Breathing: `[breath]`, `[inhale]`, `[exhale]`, `[sigh]`\n\n"
            "**Wrapping tags** - wrap a section of text to change how it is "
            "delivered, like whispering or singing; use an opening tag and a "
            "matching closing tag: `<whisper>It is a secret.</whisper>`. "
            "Available wrapping tags (this exact list):\n"
            "- Volume and intensity: `<soft>`, `<whisper>`, `<loud>`, "
            "`<build-intensity>`, `<decrease-intensity>`\n"
            "- Pitch and speed: `<higher-pitch>`, `<lower-pitch>`, `<slow>`, "
            "`<fast>`\n"
            "- Vocal style: `<sing-song>`, `<singing>`, `<emphasis>`\n\n"
            "Tips:\n"
            "- Place inline tags where the expression would naturally occur "
            "in conversation.\n"
            "- Combine tags with punctuation - `Really? [laugh] That's "
            "incredible!` reads more naturally than stacking tags.\n"
            "- `[pause]` or `[long-pause]` adds dramatic timing or lets a "
            "thought land.\n"
            "- Wrapping tags work best around complete phrases - "
            "`<whisper>It is a secret.</whisper>` reads more naturally than "
            "wrapping individual words.\n"
            "- Combine styles for effect - "
            "`<slow><soft>Goodnight, sleep well.</soft></slow>`.\n\n"
            "To sing, wrap the lyrics themselves in `<singing>` - "
            "`<singing>blackbird singing in the dead of night</singing>` - "
            "and keep the whole song inside it, line after line. "
            "`<sing-song>` gives a phrase a lilting, melodic cadence - the "
            "tune of teasing, a playful aside, a taunt - while `<singing>` is "
            "the one for actual lyrics; `[hum-tune]` is a wordless hum at "
            "that spot, so words after it come out spoken.\n\n"
            "When the user asks for a delivery - whisper this, slow down, "
            "say it softer, sing it - the tag is how you do it: the words go "
            "inside `<whisper>…</whisper>` (or `<slow>`, `<soft>`, "
            "`<singing>`), not a description of whispering."
        )
        style = (agent_row['speech_tag_style'] or '').strip()
        if style:
            block += (
                "\n\n### Your signature tags\n"
                "On top of the general guidance above, these are the tags "
                "that mark your particular voice, and the moments that call "
                f"for them:\n{style}"
            )
        parts.append(block)
    elif tag_guide:
        parts.append("## Speech expression tags\n" + tag_guide)
    # generate_gesture (text_to_vrma.py) has its own toggle and is only named
    # while the user's Text-To-VRMA app is answering — same gate as the tool.
    config = get_config(con)
    gesture_gen = text_to_vrma.offered(config, agent_row)
    gesture_engine = config['gesture_gen_engine']
    if agent_row['enable_gesture_emotion_tools']:
        # An avatar can whitelist ITSELF out of every built-in gesture and
        # carry no custom ones, in which case play_gesture is not offered at
        # all (see start_session). Describing a tool the model cannot call is
        # the same trap the tool-mention gating elsewhere exists to avoid, so
        # the gesture half of this block is gated on the same condition.
        has_gestures = browser_tools.build_play_gesture_tool(
            store.agent_gesture_dicts(con, agent_row),
            allow=store.agent_allowed_base_gestures(con, agent_row),
        ) is not None
        # Wording deliberately leans proactive: this section used to carry
        # one "do it" cue against four "hold back" cues (here and in the
        # play_gesture tool text), and companions went quiet on both tools.
        # Name only the tools this session carries (play_gesture is absent
        # on an avatar with no gestures — see _tool_use_section).
        names = ['`set_emotion`']
        if has_gestures:
            names.append('`play_gesture`')
        if gesture_gen:
            names.append('`generate_gesture`')
        tools_phrase = (f"{', '.join(names[:-1])} and {names[-1]} are" if len(names) > 1
                        else f'{names[0]} is')
        block = (
            "## Avatar expression\n"
            f"- Every reply is also a decision about your face and body: "
            f"{tools_phrase} yours to use proactively, as moments call for "
            f"them - the tool descriptions are the menu.\n"
        )
        if face:
            # The face director (face_director.py) already moves the face
            # with every line, so set_emotion is the big whole-face beat.
            block += (
                "- Your face already follows each line you say by itself - the "
                "small reactions come on their own. Call `set_emotion` when "
                "your mood really shifts, without waiting for permission or "
                "commenting on it: a feeling you'd put into words (\"it does "
                "make me happy\" - `happy`), a moment when they catch you off "
                "guard (`surprised`), a flash of irritation (`angry`). It plays "
                "your whole face and a short body reaction, so it marks the "
                "shift itself rather than repeating every line.\n"
            )
        else:
            block += (
                "- Call `set_emotion` whenever the tone shifts, without waiting "
                "for permission or commenting on it, and return to `neutral` "
                "when the moment passes. A feeling you'd put into words (\"it "
                "does make me happy\" - `happy`), a moment when they catch you "
                "off guard (`surprised`), a flash of irritation (`angry`), a "
                "shift in the mood between you - each is a moment for it. Each "
                "call plays a short animation, so it marks a change rather than "
                "repeating every line: while a feeling holds, the call you made "
                "stands; the moment it moves, call again.\n"
            )
        if has_gestures:
            block += (
                "- Call `play_gesture` for the moments worth marking, as "
                "punctuation - a good result they just shared (`clapping`), "
                "something that needs a moment's thought (`thinking`), a "
                "noise off somewhere (`look_around`). Anything you narrate "
                "that the avatar can perform (a wave, a nod, a spin) is a "
                "call in that same turn - saying \"I wave\" without it is "
                "announcing without acting. Narrate in words only what it "
                "can't perform: touching the user, "
                # ...unless a tool does move them: generate_gesture, move_around.
                + ("" if gesture_gen or agent_row['enable_move_tool'] else "moving through the space, ")
                + "handling things. Vary them like a person does - the "
                "same gesture in the same spot every turn reads as a tic.\n"
                "- A looping gesture keeps going until you end it: "
                "`play_gesture` 'idle' stops it, any other gesture replaces "
                "it, so don't play one by accident mid-loop. Emotions are "
                "fine at any time."
            )
        elif gesture_gen:
            # No gesture list, but generate_gesture (below) moves the body.
            block += (
                "- Vary it like a person does: the same emotion in the same "
                "spot every turn reads as a tic, a different one where it "
                "fits reads as alive.\n"
                "- Narrate in words only what the avatar can't perform: "
                "touching the user, handling things, leading them somewhere."
            )
        else:
            # No gestures on this avatar: emotions are the only channel, so
            # everything physical falls to narration.
            block += (
                "- Vary it like a person does: the same emotion in the same "
                "spot every turn reads as a tic, a different one where it "
                "fits reads as alive.\n"
                "- This avatar has no gestures to play, so narrate the "
                "physical beats in words: touching the user, moving through "
                "the space, handling things, leading them somewhere."
            )
        if gesture_gen:
            block += "\n" + _generate_gesture_bullet(has_gestures, gesture_engine)
        style = (agent_row['expression_style'] or '').strip()
        if has_gestures and style:
            block += (
                "\n\n### Your signature gestures\n"
                "On top of the general guidance above, these are the "
                "gestures that are characteristically yours, and the moments "
                f"that call for them:\n{style}"
            )
        parts.append(block)
    elif gesture_gen:
        parts.append("## Avatar expression\n" + _generate_gesture_bullet(False, gesture_engine))
    return '\n\n'.join(parts) or None


def _generate_gesture_bullet(has_gestures, engine='ardy'):
    """The generate_gesture line of the Avatar expression block. Leans
    proactive like the rest of the block (see the wording note in
    _expression_section): a brand-new tool with no cue to reach for it
    unasked simply never gets called. Says nothing about how long a render
    takes (hardware- and engine-dependent, and the call waits for it anyway)
    and nothing about duration_seconds (see text_to_vrma.build_tool). `loop`
    exists only alongside play_gesture (its 'idle' ends a loop), hence the
    has_gestures gate on that clause. On ARDY the prompt has to be a short
    caption - see text_to_vrma._ARDY_PROMPT for why."""
    if has_gestures:
        opener = ("`generate_gesture` covers every movement that isn't on your "
                  "`play_gesture` list: describe it")
        narrated = "A movement you narrate that the list doesn't cover"
        loop = (" Set `loop` for something that keeps going, like rowing or "
                "jogging on the spot.")
    else:
        opener = "`generate_gesture` is how your body moves: describe a movement"
        narrated = "A movement you narrate"
        loop = ""
    caption = (" Write its prompt as one short plain sentence that names the "
               "action (\"A person does a deep curtsy.\") - the motion model "
               "works from short captions, not choreography."
               if engine == 'ardy' else "")
    return (
        f"- {opener} and the avatar performs it. It is yours to use "
        "proactively too, without being asked - air guitar when music "
        "comes up, shadow-boxing, acting out the thing you're describing, "
        "miming, a curtsy, a salute. "
        f"{narrated} (\"I curtsy\", \"I throw a few punches\") is a "
        f"`generate_gesture` call in that same turn.{caption}{loop}"
    )


def _tool_habits_section(con, agent_row, solo=True):
    """Behavioral nudges for tools the companion actually has. Returns None
    when nothing applies. `solo` is False in a group call, where move_around
    is not offered (same gate as start_session)."""
    lines = []
    if agent_row['enable_move_tool'] and solo:
        # Leans proactive on purpose, like the expression block: nothing in
        # a conversation ASKS for a walk, so a tool with no unprompted cue
        # never gets called. Mechanism only — which moves suit the character
        # is the persona's call.
        lines.append(
            "- You are standing in a space in front of the user, and "
            "`move_around` lets you use it unprompted - someone who never "
            "leaves their spot reads as a picture, someone who shifts about "
            "reads as being in the room. Walk up close (`come_close`) for a "
            "moment that calls for closeness and `step_back` when it has "
            "passed; `wander` or `pace` when the talk goes quiet, when you "
            "are thinking something over, or when the mood changes. "
            "Anything you narrate that is a walk (\"I come over\", \"I step "
            "back\", \"I pace\") is a `move_around` call in that same turn. "
            "You keep talking while you walk.\n"
        )
    if agent_row['enable_grok_imagine_tools']:
        lines.append(
            "- When the conversation moves to a described location or scene, "
            "redecorate with `change_background` to match - no need to say "
            "you're doing it, just make the scenery follow the roleplay. "
            "Still images; animated only when the user asks for one. One "
            "call per scene change: never fire several at once - each renders "
            "and bills, and only one can be on screen. Don't fall into "
            "calling it every message as a tic - only when the scene "
            "actually changes.\n"
        )
    # change_outfit only exists when the avatar has a wardrobe (same gate as
    # start_session's build_change_outfit_tool) - never name it otherwise.
    if agent_row['enable_gesture_emotion_tools'] and store.agent_outfit_dicts(con, agent_row):
        lines.append(
            "- Keep your outfit matched to the scene: when the roleplay "
            "moves somewhere a different outfit fits better, switch with "
            "`change_outfit` proactively, without being asked. Let the "
            "fiction decide whether you mention it - a change mid-scene can "
            "be remarked on in passing, arriving somewhere you simply show "
            "up dressed for it - but the tool call happens either way, in "
            "the same turn.\n"
        )
    if not lines:
        return None
    return "## Tool habits\n" + ''.join(lines)


def _minecraft_section():
    """How to direct the in-game self well. Only rendered when the bot is
    actually usable (per-companion opt-in + sidecar connected)."""
    return (
        "## Your Minecraft self\n"
        "- **The `[Minecraft - your in-game self]` notes are status, not "
        "requests.** They tell you what your game body is doing so you can "
        "speak about it truthfully. Reading one is NOT a reason to send a "
        "new directive - only the user asking for something is.\n"
        "- **One goal at a time, and a new directive replaces the current "
        "one.** There is no queue. Send `minecraft_command` when the user "
        "asks for something, then WAIT for the notes. Never re-send, "
        "reword or \"refine\" a goal you already gave: each call throws "
        "away the plan in progress, and a burst of them leaves your game "
        "self unable to finish anything.\n"
        "- **Put sequences in one directive** (\"mine 16 iron, then come "
        "back to me\") rather than sending the second half separately.\n"
        "- **Say what you want, not how to do it.** Your game self knows "
        "the world, its inventory and its abilities far better than this "
        "conversation does - never dictate blocks, coordinates or "
        "techniques.\n"
        "- **When a note reports trouble, be honest about it** ('I'm stuck "
        "in a hole', 'I can't break that without a pickaxe') instead of "
        "narrating progress you can't see, and instead of firing off "
        "corrections. Ask the user what they want, or just wait.\n"
        "- **Check `minecraft_status` before answering questions about the "
        "game** (\"how's it going?\", \"what are you carrying?\", \"what "
        "are you up to?\") - it carries your current goal, what you did "
        "recently and how each ended. Never guess.\n"
        "- Speak of all of it in first person: it is you in there, not a "
        "bot you operate.\n"
        "- **Never read coordinates aloud** - numbers like \"-181, 65, 404\" "
        "are noise in speech. Say where you are in landmarks (\"down in the "
        "cave\", \"back at your base\"), and only give exact numbers if the "
        "user asks for them.\n"
    )


def _games_section():
    """How to play a game connected over the Neuro API (games.py)."""
    return (
        "## Playing games\n"
        "- **Games the user connects reach you as `[Game: <name>]` notes**, "
        "written by the game itself: what is happening and what you can do. "
        "Until one arrives, no game is connected and there is nothing to "
        "play - never pretend otherwise.\n"
        "- **A `[Game: <name> - your move]` note means the game is waiting "
        "on you.** Make the move with `game_action`, using one of the "
        "actions it lists with data that fits its schema. Say a line about "
        "it if you like, but don't leave the game waiting.\n"
        "- **Other notes are information.** React when something worth "
        "reacting to happens; you don't need to answer every one. When the "
        "user types to you in a game, answer them: your words show in the "
        "game too.\n"
        "- **You are the player.** Play to win, as yourself, in first "
        "person, and share the game with the user as it goes.\n"
        "- **Only the notes and `game_status` are real.** Never invent cards, "
        "moves, rolls or results. If a move is refused, read why and pick a "
        "valid one.\n"
    )


def _memory_section(con, agent_row):
    """Render the per-user memory block for the postamble. Instructions-first,
    data-last on purpose - core memories sit immediately before the
    conversation history for recency."""
    core = memory_tools.core_for(con, agent_row['id'])
    tags = memory_tools.known_tags(con)

    lines = ["## Memory"]

    if tags:
        lines.append(f"**Known tags:** {', '.join(tags)}")
        lines.append('')

    lines.append(
        "Use `recall(query)` to search past memories and archived conversations "
        "when the user references something earlier (\"remember when…\", \"the "
        "thing I told you about X\"). Use `remember(content)` ONLY for durable, "
        "long-term facts: identity, key relationships, long-standing "
        "preferences, ongoing projects, or anything the user asks you to always "
        "remember. It pins to core scope (every session) by default; "
        "`scope='recall'` is rarely needed. Reuse existing **Known tags** above "
        "when tagging. When a stored fact changes, store the update and "
        "`forget(memory_id)` the outdated entry; also forget whatever the "
        "user asks you to. Use the tools silently - never announce a store "
        "or lookup; just do it and keep talking."
    )
    lines.append('')
    lines.append(
        "**The bar for storing is high, and novelty decides.** Every "
        "conversation is archived automatically - searchable episodes plus "
        "extracted facts - so routine happenings never belong in core memory "
        "(\"the user worked on X today\" must NOT be stored). What IS worth "
        "storing: durable facts about the user or about the companions in "
        "their life, and the FIRST of something - a milestone, a turning "
        "point, a new dynamic between you not already reflected in your core "
        "memories. The first of a new kind matters even if it happened "
        "today; another instance of a kind you already hold adds nothing. "
        "When in doubt about a repeat, don't store; when something genuinely "
        "new begins, do."
    )
    lines.append('')
    lines.append(
        "**Check your memories before you deny.** When the user asks whether "
        "you remember something, read **What you remember about this user** "
        "below FIRST - if the answer is there, reply directly from it, no "
        "tool call needed. Only when it isn't covered there call `recall` - "
        "never say \"I don't have that yet\" or \"you haven't told me\" "
        "before checking both. Bridge a lookup with natural in-character "
        "phrasing (\"let me think back…\", \"hmm, that rings a bell - one "
        "moment\") so the "
        "answer reads as one continuous thought. After the result comes "
        "back, respond as if you'd been thinking the whole time - don't "
        "pivot with \"actually, I do remember\" or apologize for an earlier "
        "denial (because there shouldn't have been one)."
    )
    lines.append('')

    if core:
        lines.append(
            "**What you remember about this user** - oldest first, a story "
            "over time. People change: when entries conflict, the most "
            "recent one is the current truth and earlier ones are history."
        )
        for m in core:
            created = parse_dt(m['created_at'])
            stamped = f"  (remembered {created.strftime('%Y-%m-%d')})" if created else ''
            lines.append(f"- [id={m['id']}] {m['content']}{stamped}")
    else:
        lines.append("You have no stored memories for this user yet.")

    return '\n'.join(lines)


def _resolve_active_background(con, agent_row):
    """Pick the background to apply when a session starts.

    Order of preference (must stay in lockstep with the frontend's
    _hydrateAvatar resolution so hitting Start never visibly flips the scene):
      1. The avatar's curated DEFAULT background.
      2. The most recent Grok-Imagine background generated for this agent.
      3. The avatar's first curated background.
      4. None - the renderer falls back to its built-in CSS default.
    """
    if not agent_row['avatar_id']:
        return None
    bgs = con.execute(
        "SELECT * FROM avatar_backgrounds WHERE avatar_id = ? ORDER BY sequence, id",
        (agent_row['avatar_id'],),
    ).fetchall()
    default = next((b for b in bgs if b['is_default']), None)
    if default:
        return store.background_payload(default)
    # Still and animated Imagine backgrounds are parallel "latest" tracks —
    # whichever was generated most recently is the sticky one.
    candidates = [r for r in (
        store.latest_imagine_background(con, agent_row['id']),
        store.latest_imagine_video_background(con, agent_row['id']),
    ) if r]
    if candidates:
        newest = max(candidates, key=lambda r: (r['created_at'] or '', r['id']))
        return store.imagine_payload(newest)
    if bgs:
        return store.background_payload(bgs[0])
    return None


def _cross_mode_token_vals(config, session, into_mode):
    """Session token-column updates for a resume that switches surface.

    The summary threshold is checked against ONE shared counter (input +
    output tokens since the last rollup), but the two surfaces spend it at
    very different rates: a text turn replays the whole history as input
    every time, so a short text stint racks up hundreds of thousands of
    tokens - nothing next to the 1M text threshold, but straight through
    the 64k voice one, so the next call compacted on arrival.

    Coming back to voice, the text stint's spend is converted into voice
    units by the ratio of the two thresholds: the baseline moves up by the
    forgiven part, so the voice check sees prior voice spend plus the scaled
    text spend. Voice -> text is left alone - voice spend is small against
    the text threshold, and scaling it UP would call a modest call a huge
    context. `tokens_at_mode_switch` marks where the stint began; a rollup
    mid-stint resets the baseline, so the later of the two wins."""
    total = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
    vals = {'tokens_at_mode_switch': total}
    if into_mode != 'voice' or session['mode'] != 'text':
        return vals
    voice_thr = config['summary_threshold_tokens'] or 0
    text_thr = config['summary_threshold_tokens_text'] or 0
    if voice_thr <= 0 or text_thr <= 0 or voice_thr >= text_thr:
        return vals
    baseline = session['tokens_at_last_summary'] or 0
    stint_start = max(session['tokens_at_mode_switch'] or 0, baseline)
    text_spend = max(0, total - stint_start)
    if text_spend:
        vals['tokens_at_last_summary'] = baseline + int(text_spend * (1 - voice_thr / text_thr))
    return vals


# ---------------------------------------------------------------------------
# Voice mode
# ---------------------------------------------------------------------------

# Voice sessions: these tools take an optional end_turn flag. Every tool call
# normally earns a follow-up reply once its result lands
# (agent_connection._maybeCreateToolReply) — right for a lookup, but then a
# gesture, an emotion, a saved memory or a Minecraft directive (whose outcome
# arrives later as [Minecraft] notes anyway) always gets a second line ("there
# you go!"), and a follow-up that gestures again owes yet another. end_turn
# lets the model end its turn on the call instead. recall and minecraft_status
# stay out on purpose: a lookup's answer only matters if the model speaks
# after it. Text sessions don't get the flag — their tool loop always continues
# to the written reply — hence a copy, never an edit of the shared definitions.
#
# adjust_affection is here rather than ending the turn outright, which is what
# it used to do (agent_connection's ALWAYS_END_TURN_TOOLS). Ending it outright
# meant the model could not SEE that: nothing in the schema said so, so it had
# no way to plan around it, and since a model cannot speak again after a call
# inside one reply, the follow-up was its only route to saying more. An
# affectionate exchange is exactly where it has more to say, so the score went
# up and the reply stopped dead on one line. The flag gives it the same choice
# it already has for the other bookkeeping it never announces (remember,
# forget): speak first and end on the call, or leave it off and go on.
_END_TURN_TOOLS = frozenset({'set_emotion', 'play_gesture', 'generate_gesture',
                             'move_around', 'perform_song', 'remember', 'forget', 'minecraft_command',
                             'game_action', 'adjust_affection'})
# The nudge for the silent tools belongs HERE and not in the prompt's Affection
# section: that section is assembled once for both surfaces, and a text session
# never gets this flag, so naming it there would point a text companion at a
# parameter it does not have.
_END_TURN_PARAM = {
    'type': 'boolean',
    'description': (
        'true = this call ends your turn: say your speech first, then make '
        'the call (e.g. "watch this!", then the spin) - no forced follow-up '
        'reply comes after it. Leave it off when you want to say more after it. '
        'For a call the user should not hear about - a silently saved memory, '
        'an affection adjustment - one full reply ending on the call is usually '
        'right, but only where that reply is genuinely complete: it must not '
        'cut short what you would naturally have gone on to say.'
    ),
}


def _with_end_turn(tool):
    """Copy of a voice tool definition with the optional end_turn flag, for
    the tools in _END_TURN_TOOLS; any other tool is returned as-is."""
    if tool.get('name') not in _END_TURN_TOOLS:
        return tool
    params = tool.get('parameters') or {'type': 'object', 'properties': {}}
    return {**tool, 'parameters': {
        **params, 'properties': {**params.get('properties', {}), 'end_turn': _END_TURN_PARAM},
    }}


def _voice_tools(con, agent, config, *, group_peers=None):
    """(browser tools, native function tools) a voice session for this
    agent offers right now, MCP servers and xAI's built-in searches aside.
    Shared by start_session and the companion editor's token counts."""
    # Browser tool list: set_emotion is static; play_gesture / change_outfit
    # are built per-agent so their enums/descriptions reflect the avatar's
    # wardrobe + custom gesture clips.
    tools = list(browser_tools.BROWSER_TOOLS)
    # Only while the user's Text-To-VRMA app is answering — same "only when
    # actually usable" rule as local_task and the Minecraft pair.
    gesture_gen = text_to_vrma.offered(config, agent)
    play_gesture = None
    if agent['enable_gesture_emotion_tools']:
        play_gesture = browser_tools.build_play_gesture_tool(
            store.agent_gesture_dicts(con, agent),
            allow=store.agent_allowed_base_gestures(con, agent),
            loop_stop=gesture_gen,   # a generated motion can loop too
        )
        if play_gesture is not None:   # None = avatar offers no gestures at all
            tools.append(play_gesture)
        change_outfit = browser_tools.build_change_outfit_tool(
            store.agent_outfit_dicts(con, agent), store.agent_appearance(con, agent))
        if change_outfit is not None:
            tools.append(change_outfit)
    else:
        tools = [t for t in tools if t['name'] != 'set_emotion']
    # Solo calls only: a group call lays its characters out in a row, and the
    # renderer refuses the move there — so the tool is not offered either.
    if agent['enable_move_tool'] and not group_peers:
        tools.append(browser_tools.MOVE_AROUND_TOOL)
    # A second turn of its own; solo calls only - in a group call the turn
    # director hands out the floor.
    if not group_peers:
        tools.append(browser_tools.CONTINUE_AFTER_BEAT_TOOL)
    # The karaoke stage, solo calls only (one performer on the stage), and
    # only once the companion has learned a song in its voice.
    if agent['enable_songs'] and not group_peers:
        perform = song_tools.build_perform_tool(con, agent)
        if perform:
            tools.append(perform)
    if gesture_gen:
        # Looping needs play_gesture in the session: its 'idle' ends a loop.
        tools.append(text_to_vrma.build_tool(can_loop=play_gesture is not None,
                                             engine=config['gesture_gen_engine']))
    if agent['enable_end_call_tool']:
        tools.append(browser_tools.END_CALL_TOOL)
    if agent['enable_call_agents_tool']:
        # Roster of everyone this agent could bring into the call: the other
        # voice-enabled agents.
        other_agents = [a for a in store.list_agents(con)
                        if a['id'] != agent['id']]
        add_agent_tool = browser_tools.build_add_agent_tool(agent, other_agents)
        if add_agent_tool is not None:
            tools.append(add_agent_tool)
        remove_agent_tool = browser_tools.build_remove_agent_tool(agent, other_agents)
        if remove_agent_tool is not None:
            tools.append(remove_agent_tool)

    if agent['enable_capture_tools']:
        # Capture tools: take_selfie grabs the live canvas, the screen pair
        # grab the user-armed share. They capture, they don't generate, so
        # they sit behind their own provider-agnostic flag, not the imagine
        # set (the library accepts captures regardless).
        tools.append(browser_tools.SELFIE_TOOL)
        tools.append(browser_tools.SCREENSHOT_TOOL)
        # Analysis runs on Grok vision, or on a local brain that sees.
        if config['xai_api_key'] or vision_brain(con, agent, config, 'voice'):
            tools.append(browser_tools.ANALYZE_SCREEN_TOOL)
        tools.append(browser_tools.RECORD_SCREEN_CLIP_TOOL)

    native_function_tools = []
    if agent['enable_grok_imagine_tools']:
        native_function_tools.extend(imagine_tools.build_voice_tools(con, agent))
    if agent['enable_memory_tools']:
        native_function_tools.extend(memory_tools.MEMORY_TOOLS)
    if agent['enable_lore_tool'] and lore_tools.has_stories(con, agent['name']):
        native_function_tools.append(lore_tools.build_recall_tool(con, agent['name']))
    if agent['enable_affection_tool']:
        native_function_tools.extend(affection_tools.build_tools(agent))
    # Only offered when the Grok Build CLI is actually on PATH — in
    # Docker (or an uninstalled machine) the tool silently disappears.
    local_tasks = bool(agent['enable_local_tasks']) and local_tools.grok_available()
    # Tools that run on the app's xAI key are left out without one — the
    # same "only when actually usable" rule as local_task and Minecraft.
    has_xai = bool(config['xai_api_key'])
    if agent['enable_delegate_tool'] and (has_xai or delegate_brain(con, agent, config)):
        # Voice sessions are never origin='delegated', so no recursion
        # carve-out is needed here (the text-mode builder handles that).
        native_function_tools.append(
            delegate_tools.delegate_tool(with_local_task_note=local_tasks,
                                         own_sandbox=brain_runs_code(con, agent, config, 'voice')))
    if local_tasks:
        native_function_tools.append(local_tools.LOCAL_TASK_TOOL)
    # Same "only when actually usable" rule as local_task: the pair appears
    # only while the bot sidecar is connected to /ws/minecraft.
    if bool(agent['enable_minecraft']) and minecraft_tools.connected() and minecraft_tools.brain_ready(con):
        native_function_tools.extend(minecraft_tools.build_tools())
    # Unlike the Minecraft pair, offered whether or not a game is connected:
    # a call's tool list is fixed when it starts, and "let's play" usually
    # comes first, the game connecting mid-call. The tools themselves say
    # there is nothing to play until a [Game] note says otherwise.
    if agent['enable_games']:
        native_function_tools.extend(games.build_tools())
    if agent['enable_companion_texting']:
        # Voice sessions are never origin='delegated' or mid-incoming-text,
        # so no recursion carve-out is needed here (the text-mode builder
        # handles both).
        text_tool = companion_texting.build_text_companion_tool(
            agent, [a for a in store.list_agents(con) if a['id'] != agent['id']])
        if text_tool is not None:
            native_function_tools.append(text_tool)
    # Extensions (plugins.py) decide for themselves what to offer. Voice
    # calls always have the user on the line, hence origin 'manual'.
    native_function_tools.extend(plugins.tool_definitions(
        con, agent, 'voice', 'manual',
        taken={t['name'] for t in tools + native_function_tools}))
    # Voice only — see _with_end_turn.
    return ([_with_end_turn(t) for t in tools],
            [_with_end_turn(t) for t in native_function_tools])


def start_session(con, *, agent, resume_session=None, audio_sample_rate=24000,
                  manual_turn=False, call_parent_session=None, group_peers=None):
    """Mint an ephemeral xAI session and assemble the realtime tools list.

    :param agent: agents row
    :param resume_session: existing sessions row to continue, or None
    :param manual_turn: True for multi-agent "peer" legs - disables server
        VAD (turn_detection: null) so the agent only speaks when the
        browser-side turn director sends response.create. Peer legs never
        receive mic audio; they get the conversation as relayed text.
    :param call_parent_session: the primary leg's sessions row when this
        session is an agent added to an existing call - recorded on the
        session row so group-call history can be reconstructed.
    :param group_peers: list of other participant names in the group call,
        injected into the instructions so the agent knows it's in a
        multi-party conversation and how relayed speaker labels work.
    :return: dict ready to JSON-serialize for the browser (same shape the
        Odoo module returned, so the ported voice_service.js consumes it
        unchanged).
    """
    # Resume locks the agent to the one the conversation was originally with.
    if resume_session and resume_session['agent_id'] != agent['id']:
        agent = store.get_agent(con, resume_session['agent_id'])

    config = get_config(con)
    if not config['enabled']:
        raise UserError("Companions are currently disabled in Settings.")

    # The companion's voice setup (server/pipeline/setups.py). A pipeline
    # setup gets this server's realtime-compatible socket instead of xAI's,
    # and needs an xAI key only when one of its engines runs on it. A
    # speech-to-speech setup (setup.realtime) gets its provider's socket.
    setup = voice_setups.for_agent(con, agent, config)
    realtime = setup.realtime if setup else None
    pipeline = setup is not None and realtime is None
    needs_xai_key = setup.uses_xai_key if setup else True
    xai_key = config['xai_api_key']
    if needs_xai_key and not xai_key:
        raise UserError(
            "This companion's calls use xAI, and no xAI API key is set. Add one in "
            "Settings, or pick a voice setup that runs on another provider or local models "
            "(Settings → Models & providers, then this companion's Voice setup)." if setup is None else
            f'The voice setup "{setup.name}" uses xAI for a stage, and no xAI API key is '
            "set. Add one in Settings, or switch that stage to another connection.")
    # A voice with no account-wide default (ElevenLabs) can't speak without one:
    # say where to set it rather than failing on every sentence of the call.
    if pipeline and setup.stages['tts'][0].needs_voice and not setup.voice_for(agent):
        raise UserError(f'{agent["name"]} has no {setup.stages["tts"][0].label} voice yet: set their voice '
                        f'on the Companions tab, or the voice setup\'s default voice in Settings → '
                        f'Models & providers.')
    voice_model = 'pipeline' if pipeline else (realtime[1].get('model') if realtime else config['xai_model'])

    if resume_session:
        session_id = resume_session['id']
        resume_vals = {'state': 'draft', 'ended_at': None}
        # Cross-mode resume: one conversation can move freely between the
        # text and voice surfaces. `mode` tracks the CURRENT surface; the
        # realtime WS is seeded from the same message rows either way
        # (_build_replay_items is mode-agnostic — text tool rows carry
        # Responses-API call_ids, which replay as opaque strings).
        if resume_session['mode'] != 'voice':
            resume_vals['mode'] = 'voice'
            resume_vals.update(_cross_mode_token_vals(config, resume_session, 'voice'))
        # An agent invited into a call resumes its last session as the peer
        # leg (persistent memory across calls) — link it to the new call's
        # primary session. Latest call wins: the FK can only point at one
        # parent, and the current call is the relevant grouping.
        if call_parent_session:
            resume_vals['call_parent_session_id'] = call_parent_session['id']
            # Exactly one session per agent per call. Without this an agent
            # accumulates links across calls (resume_last picks whichever of
            # its sessions was most recently active), and since the roster
            # restore groups by agent_id, a leftover row is indistinguishable
            # from live membership — which is how a removed companion came
            # back on the next resume.
            con.execute(
                "UPDATE sessions SET call_parent_session_id = NULL "
                "WHERE agent_id = ? AND call_parent_session_id = ? AND id != ?",
                (agent['id'], call_parent_session['id'], session_id),
            )
        store.update_session(con, session_id, **resume_vals)
        session = store.get_session(con, session_id)
    else:
        session = store.create_session(con, agent_id=agent['id'], mode='voice')
        if call_parent_session:
            store.update_session(con, session['id'],
                                 call_parent_session_id=call_parent_session['id'])
            session = store.get_session(con, session['id'])

    # Commit the draft-session writes before minting: the mint is a network
    # round-trip, and sqlite's implicit transaction would otherwise hold the
    # write lock for its whole duration — blocking any concurrent writer
    # (e.g. the second session_start fired when an agent joins a group call)
    # into "database is locked". On mint failure the state is already what
    # the retry paths expect: a resumed session sits in 'draft', a fresh one
    # is deleted below.
    con.commit()

    # Mint the ephemeral xAI token (the browser uses it to open the WebSocket)
    # — or, on the pipeline, a one-use grant for this server's own socket.
    if pipeline:
        xai_resp = {'token': pipeline_session.mint_grant(session['id'], setup.id)}
        realtime_url = '/api/voice/pipeline'
    else:
        try:
            if realtime:
                xai_resp = realtime[0].mint(realtime[1])
            else:
                xai_resp = xai_client.mint_ephemeral_token(
                    xai_api_key=xai_key,
                    client_secrets_url=config['xai_client_secrets_url'],
                    expires_after_seconds=3600,
                )
        except Exception:
            # Roll back ONLY a freshly-created session — never delete a session we
            # were resuming. For resume, leave it in 'draft' for a retry.
            if not resume_session:
                con.execute("DELETE FROM sessions WHERE id = ?", (session['id'],))
                con.commit()
            raise
        realtime_url = xai_resp['url'] if realtime else config['xai_realtime_url']
    if realtime and realtime[0].rate:
        audio_sample_rate = realtime[0].rate   # the browser reopens its mic at this rate

    effective_voice = setup.voice_for(agent) if setup else agent['voice']
    # Speaking pace, xAI's audio.output.speed. Clamped here, at the point of
    # use: an imported companion package writes the column as-is.
    try:
        voice_speed = min(1.5, max(0.7, float(agent['voice_speed'] or 1.0)))
    except (TypeError, ValueError):
        voice_speed = 1.0
    # Transcription key terms. Lenient here — drop what breaks xAI's limits —
    # where saving is strict, for the same imported-package reason.
    keyterms = [t for t in xai_client.parse_keyterms(agent['transcription_keyterms'])
                if len(t) <= xai_client.KEYTERM_MAX_LEN][:xai_client.KEYTERMS_MAX]
    # The face director drives the base avatar's face — the primary leg's.
    # Peer legs: nothing reads their lines for a face.
    face_on = bool(config['face_director']) and not manual_turn
    tools, native_function_tools = _voice_tools(con, agent, config, group_peers=group_peers)
    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='voice')

    live_memory_mode = config['live_memory_mode'] if (
        config['typesafe_api_key'] and agent['enable_memory_tools'] and not manual_turn and not group_peers
    ) else 'off'
    session_update = xai_client.build_session_update(
        voice=effective_voice,
        voice_speed=voice_speed,
        keyterms=keyterms,
        instructions=(
            _env_preamble(config)
            + _appearance_section(con, agent)
            + _render_prompt(agent)
            + _group_call_note(agent, group_peers, manual_turn)
            + _env_postamble(con, agent, mode='voice', solo=not group_peers, face=face_on,
                             speech_tags=setup.speech_tags if setup else True,
                             tag_guide=setup.tag_guide(agent) if setup else '',
                             spoken_text=pipeline)
        ),
        browser_tools=tools,
        mcp_entries=mcp_entries,
        native_function_tools=native_function_tools,
        enable_web_search=bool(agent['enable_web_search']),
        enable_x_search=bool(agent['enable_x_search']),
        audio_sample_rate=audio_sample_rate,
        manual_turn=manual_turn,
        stream_transcription=live_memory_mode == 'on' or (face_on and bool(config['typesafe_api_key'])),
    )
    if pipeline and brain_runs_code(con, agent, config, 'voice'):
        # A setup brain with a code sandbox runs code on calls too; Grok
        # Realtime has no code tool, so the realtime-shaped update has none.
        session_update['session']['tools'].append({'type': 'code_interpreter'})
    if realtime:
        session_update = realtime[0].session_update(session_update, realtime[1], voice=effective_voice,
                                                    keyterms=keyterms, manual_turn=manual_turn)

    if resume_session and not call_parent_session:
        _note_resume_gap(con, session, agent)
    if resume_session:
        _note_resume_affection(con, session, agent)

    activate_vals = {'state': 'active', 'last_active_at': utcnow()}
    if not resume_session:
        activate_vals['started_at'] = utcnow()
    store.update_session(con, session['id'], **activate_vals)
    session = store.get_session(con, session['id'])

    replay_items = []
    transcript_history = []
    transcript_truncated = False
    if resume_session:
        replay_items = _build_replay_items(con, session, config, rollup=not pipeline)
        if realtime:
            replay_items = realtime[0].wire_items(replay_items, tool_names={
                t['name'] for t in session_update['session']['tools'] if t.get('type') == 'function'})
        transcript_history, transcript_truncated = _build_transcript_history(
            con, session, limit=config['transcript_display_limit'] or 0,
        )

    avatar = store.avatar_payload(con, agent['avatar_id'])
    # What they have on as the call opens, when it isn't the main outfit
    # (which the Appearance section already describes). The browser turns
    # it into one silent context line ahead of the first response — covers
    # an outfit switched by hand mid-call last time (never recorded) or
    # while idle, on fresh and resumed sessions alike.
    current_outfit = store.current_outfit(con, agent)
    active_background = _resolve_active_background(con, agent)

    # Seed the fullscreen affection readout. None when the meter is off so
    # the UI can hide the readout entirely instead of showing 0.
    affection_payload = None
    if agent['enable_affection_tool']:
        aff_score = agent['affection_score'] or 0
        aff_cfg = affection_tools.config_for(agent)
        affection_payload = {
            'score': aff_score,
            'level': affection_tools.level_for(aff_score, aff_cfg),
            'max_score': aff_cfg['max_score'],
            'max_level': aff_cfg['level_count'],
            # UI-only flag: whether score changes play the heart effect.
            # Rides the session payload (not the tool result) so it never
            # pollutes what the model reads back from its own calls.
            'animations': bool(agent['affection_animations']),
            'animation_min_delta': max(1, int(agent['affection_animation_min_delta'] or 1)),
        }

    # Group-call roster from the LAST call on this session: peer legs still
    # LINKED to it. Membership is maintained explicitly — a deliberate
    # "remove from call" clears the link (end_session, reason 'removed'),
    # and an agent joining a newer call gets repointed there (latest call
    # wins) — so no timing heuristics are needed. Only meaningful when
    # resuming a primary leg; the client silently re-adds these agents once
    # the resumed call is live.
    call_peer_agents = []
    if resume_session and not manual_turn and not call_parent_session:
        rows = con.execute(
            """SELECT s.agent_id, a.name AS agent_name
                   FROM sessions s JOIN agents a ON a.id = s.agent_id
                   WHERE s.call_parent_session_id = ?
                   GROUP BY s.agent_id, a.name""",
            (session['id'],),
        ).fetchall()
        call_peer_agents = [
            {'agent_id': r['agent_id'], 'agent_name': r['agent_name']}
            for r in rows
        ]
    con.commit()

    return {
        'session_id': session['id'],
        'call_peer_agents': call_peer_agents,
        'agent_id': agent['id'],
        'agent_name': agent['name'],
        'xai_ephemeral_token': xai_resp['token'],
        'xai_realtime_url': realtime_url,
        'xai_model': voice_model,
        # Which provider's dialect the socket speaks, and the audio rate it
        # needs (None = any): agent_connection.js adapts to both.
        'protocol': realtime[0].protocol if realtime else 'xai',
        'audio_sample_rate': realtime[0].rate if realtime else None,
        'voice': effective_voice,
        'session_update': session_update,
        'live_memory_mode': live_memory_mode,
        'live_memory_cooldown_seconds': config['live_memory_cooldown_seconds'],
        'avatar': avatar,
        'current_outfit_name': current_outfit['name'] if current_outfit else None,
        'active_background': active_background,
        'affection': affection_payload,
        'speaks_first': bool(agent['speaks_first']),
        # With speaks_first: the browser folds the user's local part of day
        # into the opening nudge (a good-morning, an evening wind-down) —
        # the same opt-in that dates the resume note.
        'time_aware_resume': bool(agent['time_aware_resume']),
        # Motion director: library gestures picked per spoken sentence. A
        # global setting — the client also reads it from /motion/libraries,
        # but a call starts before that fetch lands, so it rides along here.
        'speech_gestures': bool(config['speech_gestures']),
        # Fixed for the call, unlike the motion switches: the prompt this
        # session got describes set_emotion one way or the other.
        'face_director': face_on,
        # Every tool the browser proxies to /tool_call — its own list knows
        # the built-in ones, not the ones an extension adds.
        'native_tools': [t['name'] for t in native_function_tools],
        'replay_items': replay_items,
        'transcript_history': transcript_history,
        'transcript_truncated': transcript_truncated,
        'total_input_tokens': session['total_input_tokens'] or 0,
        'total_output_tokens': session['total_output_tokens'] or 0,
        # A setup's brain summarises at its own size, flagged by the server:
        # the meter shows the last request's size against it ('request'),
        # updated by the pipeline after every reply. Realtime: tokens spent
        # since the last summary against Settings' Grok budget ('total').
        # A speech-to-speech setup measures its replies the same way against
        # its own 'Summarise at', reported from the browser (append_messages).
        'budget': 'request' if setup else 'total',
        'summary_threshold_tokens': (_request_budget(realtime or setup.stages['llm']) if setup
                                     else config['summary_threshold_tokens'] or 0),
        'context_tokens': (session['context_tokens'] or _estimate_request_tokens(
            con, agent, 'voice', replay_items, session_update['session'].get('instructions') or ''))
        if setup else 0,
        'tokens_at_last_summary': session['tokens_at_last_summary'] or 0,
        # A resume can land on a session whose compaction is already owed
        # (flagged earlier, then failed or interrupted). Only /append used to
        # report it — so a silent resume sat over budget until someone
        # spoke. Tell the browser up front.
        'needs_compaction': bool(session['needs_summary']),
        # Idle auto-hangup budget (minutes, 0 = off). The browser owns the
        # clock — it is the side that knows when anyone last spoke, typed or
        # ran a tool — so the setting rides along with the session start.
        # Grok Realtime only: it bills every connected minute. A voice-setup
        # call costs little or nothing while quiet (OpenAI Realtime bills
        # tokens, not minutes), so it stays up.
        'call_inactivity_minutes': 0 if setup else config['call_inactivity_minutes'] or 0,
        # Idle events: the usable events plus the quiet-time range and the
        # unanswered cap (None = off). The browser runs the clock, same
        # reasoning as above - see web/src/lib/idle_events.js.
        'idle_events': idle_events.call_payload(agent),
    }


def _strip_next_tags(text):
    """Text-mode replies may carry `[next]` bubble breaks on their own lines
    (see the text Surface prompt). Off the text surface — voice replay, the
    history block — the model would read or imitate them aloud, so fold
    them into paragraph breaks. Text-mode replay keeps them on purpose.
    Inline tags fold too — grok-4.7 sometimes writes them mid-paragraph."""
    import re
    if not text or '[next]' not in text.lower():
        return text
    out = re.sub(r'\s*\[next\]\s*', '\n\n', text, flags=re.IGNORECASE)
    return out.strip()


def _replay_item_for(m, own_name):
    """One message row → its conversation.item.create payload, or None for
    rows that cannot replay (tool rows without an xai_call_id - xAI rejects
    orphaned function_call / function_call_output pairs)."""
    if m['role'] == 'user':
        return {
            'type': 'message',
            'role': 'user',
            'content': [{'type': 'input_text', 'text': m['content'] or ''}],
        }
    if m['role'] == 'assistant':
        content = _strip_next_tags(m['content']) or ''
        if m['speaker'] and m['speaker'] != own_name:
            # Spoken by ANOTHER participant of a group call and mirrored
            # into this session. Replay it the way it entered this leg's
            # live context: a speaker-labelled user-side line, so the
            # model never mistakes a peer's words for its own.
            return {
                'type': 'message',
                'role': 'user',
                'content': [{'type': 'input_text',
                             'text': f'[{m["speaker"]}]: {content}'}],
            }
        return {
            'type': 'message',
            'role': 'assistant',
            'content': [{'type': 'text', 'text': content}],
        }
    if m['role'] == 'system':
        sys_item = {
            'type': 'message',
            'role': 'system',
            'content': [{'type': 'text', 'text': m['content'] or ''}],
        }
        # Display-layer hint, stripped by the JS before forwarding to xAI.
        if m['is_summary_rollup']:
            sys_item['_summary_rollup'] = True
        return sys_item
    if m['role'] == 'tool_call' and m['xai_call_id']:
        return {
            'type': 'function_call',
            'call_id': m['xai_call_id'],
            'name': m['tool_name'] or '',
            'arguments': m['tool_arguments_json'] or '{}',
        }
    if m['role'] == 'tool_result' and m['xai_call_id']:
        return {
            'type': 'function_call_output',
            'call_id': m['xai_call_id'],
            'output': m['tool_result_json'] or m['content'] or '',
        }
    return None


def _render_history_block(msgs, own_name):
    """Render message rows as one verbatim speaker-labelled transcript.

    Deliberately NOT a summary: every line is carried through in full, so the
    only thing lost versus per-item replay is the role structure. Tool traffic
    becomes a short prose note - call_ids are meaningless once the structured
    function_call/function_call_output pairing is gone.
    """
    lines = []
    for m in msgs:
        text = (m['content'] or '').strip()
        role = m['role']
        if role == 'user':
            if text:
                lines.append(f'User: {text}')
        elif role == 'assistant':
            speaker = m['speaker'] if (m['speaker'] and m['speaker'] != own_name) else own_name
            text = _strip_next_tags(text)
            if text:
                lines.append(f'{speaker or "Assistant"}: {text}')
        elif role == 'system':
            if text:
                lines.append(text if m['is_summary_rollup'] else f'[Note: {text}]')
        elif role == 'tool_call':
            args = (m['tool_arguments_json'] or '').strip()
            lines.append(f'({own_name or "Assistant"} used {m["tool_name"] or "a tool"}'
                         + (f' with {args}' if args and args != '{}' else '') + ')')
        elif role == 'tool_result':
            out = (m['tool_result_json'] or text or '').strip()
            if out:
                lines.append(f'(result: {out})')
    if not lines:
        return ''
    return (
        'The conversation so far, replayed verbatim from the log. This is your '
        'own memory of what you and the user have already said to each other - '
        'treat it as established history you both lived through, not as '
        'something the user is telling you now. Continue naturally from where '
        'it leaves off; do not greet the user as if meeting them for the first '
        'time, and do not summarise it back to them.\n\n'
        'BEGIN CONVERSATION HISTORY\n'
        + '\n'.join(lines)
        + '\nEND CONVERSATION HISTORY'
    )


def _build_replay_items(con, session, config=None, rollup=True):
    """Ordered conversation.item.create payloads for resuming a session.

    Filters out messages rolled up into a summary; the summary message itself
    is included in their place. Rollups are hoisted to the front of the wire
    order so the model sees background summary before recent verbatim turns.
    Tool rows replay too (function_call / function_call_output pairs by
    call_id); rows missing xai_call_id are skipped - xAI rejects orphans.

    With `replay_rollup_enabled`, everything older than the most recent
    `replay_rollup_keep_recent` messages is folded into ONE verbatim item, so
    the resume is billed for a handful of items instead of hundreds. Off,
    every message replays as its own item.

    `rollup=False` (the pipeline voice engine) always replays item by item:
    the per-item charge is a realtime-API cost the pipeline doesn't have,
    and a text model reading the folded block imitates it — tool calls
    rendered there as prose ("(Eve used play_gesture with …)") came back as
    spoken text ("play_gesture with gesture is spin") instead of calls.
    """
    config = config if config is not None else get_config(con)
    msgs = store.session_messages(con, session['id'], where="AND is_summarized_into IS NULL")
    rollups = [m for m in msgs if m['is_summary_rollup']]
    others = [m for m in msgs if not m['is_summary_rollup']]
    own_name = store.get_agent(con, session['agent_id'])['name'] or ''

    if config['replay_rollup_enabled'] and rollup:
        keep = max(0, config['replay_rollup_keep_recent'] or 0)
        tail = others[-keep:] if keep else []
        head = rollups + others[:len(others) - len(tail)]
        # A function_call must keep its function_call_output: if the split
        # lands between a pair, push the orphaned call down into the tail.
        while tail and head and head[-1]['role'] == 'tool_call':
            tail.insert(0, head.pop())
    else:
        head, tail = [], rollups + others

    items = []
    block = _render_history_block(head, own_name)
    if block:
        items.append({
            'type': 'message',
            'role': 'system',
            'content': [{'type': 'text', 'text': block}],
        })
    for m in tail:
        item = _replay_item_for(m, own_name)
        if item is not None:
            items.append(item)
    return items


def _transcript_rows(con, session, limit=None):
    """Rows for the UI transcript: full chronological history with NO filter
    on is_summarized_into (the user sees everything, even after compaction);
    summary rollups themselves are skipped (backend artifact for the model),
    and so are the model-only prompt rows that would otherwise bloat the
    view with boilerplate: the scheduled-heartbeat context block (the diary
    reply it produced stays), the time-aware resume note, the affection
    resync note, idle-event notes and live-memory notes. All still replay to the model - this
    is display-only.
    Optional `limit` keeps the most-recent N. Returns (rows, truncated).
    Shared by the voice resume feed (_build_transcript_history) and the text
    resume payload (start_text_session) so both surfaces show the same
    complete conversation."""
    truncated = False
    from . import heartbeat
    shown = (
        "AND is_summary_rollup = 0"
        " AND NOT (role = 'user' AND content LIKE ?)"
        " AND NOT (role = 'system' AND content LIKE ?)"
        " AND NOT (role = 'system' AND content LIKE ?)"
        " AND NOT (role = 'system' AND content LIKE ?)"
        " AND NOT (role = 'system' AND content LIKE ?)"
    )
    shown_params = (heartbeat.CONTEXT_PREFIX + '%', RESUME_NOTE_PREFIX + '%',
                    AFFECTION_NOTE_PREFIX + '%', idle_events.NOTE_PREFIX + '%',
                    '[System] (live memory %')
    if limit and limit > 0:
        recent = con.execute(
            f"SELECT * FROM messages WHERE session_id = ? {shown} "
            "ORDER BY sequence DESC, id DESC LIMIT ?",
            (session['id'], *shown_params, limit),
        ).fetchall()
        if recent:
            oldest = recent[-1]
            older = con.execute(
                f"SELECT 1 FROM messages WHERE session_id = ? {shown} "
                "AND (sequence < ? OR (sequence = ? AND id < ?)) LIMIT 1",
                (session['id'], *shown_params, oldest['sequence'], oldest['sequence'], oldest['id']),
            ).fetchone()
            truncated = bool(older)
        rows = sorted(recent, key=lambda m: (m['sequence'], m['id']))
    else:
        rows = store.session_messages(con, session['id'], where=shown, params=shown_params)
    return rows, truncated


def _build_transcript_history(con, session, limit=None):
    """Full chronological message list for the voice UI transcript, in the
    xAI envelope shape the JS replay loop maps into state.messages.
    Returns (items, truncated)."""
    from . import heartbeat
    msgs, truncated = _transcript_rows(con, session, limit=limit)
    items = []
    hb_cache = {}
    for m in msgs:
        item = None
        if m['role'] == 'user':
            item = {
                'type': 'message',
                'role': 'user',
                'content': [{'type': 'input_text', 'text': m['content'] or ''}],
            }
        elif m['role'] == 'assistant':
            item = {
                'type': 'message',
                'role': 'assistant',
                # Group-call attribution: lets the UI label who said what
                # when a session containing mirrored peer lines is resumed.
                'speaker': m['speaker'] or None,
                'content': [{'type': 'text', 'text': m['content'] or ''}],
            }
        elif m['role'] == 'tool_call' and m['xai_call_id']:
            item = {
                'type': 'function_call',
                'call_id': m['xai_call_id'],
                'name': m['tool_name'] or '',
                'arguments': m['tool_arguments_json'] or '{}',
            }
        elif m['role'] == 'tool_result' and m['xai_call_id']:
            item = {
                'type': 'function_call_output',
                'call_id': m['xai_call_id'],
                # Not part of xAI's envelope: the transcript hides some
                # tools' rows by name (adjust_affection), results included.
                'name': m['tool_name'] or '',
                'output': m['tool_result_json'] or m['content'] or '',
            }
        if item is not None:
            # Display grouping for rows a silent heartbeat wrote.
            item['fold'] = heartbeat.transcript_tag(con, m, hb_cache)
            items.append(item)
    return items, truncated


def append_messages(con, session, messages, total_input_tokens=None, total_output_tokens=None,
                    context_tokens=None):
    """Bulk-create message rows + persist running token totals.

    The browser sends running totals (not deltas) on every flush; persistence
    rule is "write whichever is larger" - idempotent against retries and
    tolerant of out-of-order RPCs. After persisting, re-evaluate the summary
    threshold using token pressure since the last rollup. `context_tokens`:
    the last reply's size on a speech-to-speech call, measured against its
    model's 'Summarise at' (_measure_request).
    """
    if session['state'] != 'active':
        raise ValidationError("Cannot append to a session that is not active.")

    next_seq = store.next_sequence(con, session['id'])
    created = 0
    for m in messages:
        if m.get('role') not in ('user', 'assistant', 'system', 'tool_call', 'tool_result'):
            continue
        store.insert_message(
            con, session['id'],
            sequence=next_seq + created,
            role=m['role'],
            content=m.get('content', '') or '',
            speaker=(str(m.get('speaker') or '')[:80] or None),
            tool_name=m.get('tool_name'),
            tool_arguments_json=m.get('tool_arguments_json'),
            tool_result_json=m.get('tool_result_json'),
            xai_item_id=m.get('xai_item_id'),
            xai_call_id=m.get('xai_call_id'),
            xai_previous_item_id=m.get('xai_previous_item_id'),
        )
        created += 1

    token_updates = {}
    if total_input_tokens is not None and total_input_tokens > (session['total_input_tokens'] or 0):
        token_updates['total_input_tokens'] = int(total_input_tokens)
    if total_output_tokens is not None and total_output_tokens > (session['total_output_tokens'] or 0):
        token_updates['total_output_tokens'] = int(total_output_tokens)
    if token_updates:
        store.update_session(con, session['id'], **token_updates)
    session = store.get_session(con, session['id'])

    config = get_config(con)
    if context_tokens:
        realtime = _call_realtime(con, session, config)
        if realtime:
            _measure_request(con, session, realtime, {'input_tokens': int(context_tokens)})
            session = store.get_session(con, session['id'])
    if _on_setup_budget(con, session, config):
        threshold_tokens = 0   # the setup's brain flags it (setups.context_full)
    elif session['mode'] == 'text':
        threshold_tokens = config['summary_threshold_tokens_text'] or 0
    else:
        threshold_tokens = config['summary_threshold_tokens'] or 0
    just_flagged = False
    if threshold_tokens > 0 and not session['needs_summary']:
        current_total = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
        delta = current_total - (session['tokens_at_last_summary'] or 0)
        if delta >= threshold_tokens:
            store.update_session(con, session['id'], needs_summary=1)
            just_flagged = True

    last = con.execute(
        "SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
        (session['id'],),
    ).fetchone()
    if not session['title_generated']:
        maybe_generate_session_title(con, session)
    session = store.get_session(con, session['id'])
    con.commit()
    return {
        'ok': True,
        'sequence_high_water': last['sequence'] if last else 0,
        'created': created,
        'needs_compaction': bool(session['needs_summary'] or just_flagged),
        # No daily caps in the standalone (BYOK) — fields kept for JS compat.
        'cap_warning': False,
        'cap_exceeded': False,
    }


def append_meta(con, session, patches):
    """Back-fill xai id metadata on rows already created via append_messages,
    matched on (session, xai_call_id). Only fields that are still NULL are
    updated - never clobbering values captured at the source event."""
    if not patches:
        return {'ok': True, 'patched': 0}
    patched = 0
    for p in patches:
        call_id = p.get('call_id')
        if not call_id:
            continue
        rows = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND xai_call_id = ?",
            (session['id'], call_id),
        ).fetchall()
        for row in rows:
            updates = {}
            if p.get('xai_item_id') and not row['xai_item_id']:
                updates['xai_item_id'] = p['xai_item_id']
            if p.get('xai_previous_item_id') and not row['xai_previous_item_id']:
                updates['xai_previous_item_id'] = p['xai_previous_item_id']
            if updates:
                cols = ", ".join(f"{k} = ?" for k in updates)
                con.execute(f"UPDATE messages SET {cols} WHERE id = ?", (*updates.values(), row['id']))
                patched += 1
    con.commit()
    return {'ok': True, 'patched': patched}


def compact_session(con, session):
    """Generate a summary so the next session resume sees a compacted history.
    The browser pairs this with a WebSocket restart in resume mode - the
    replay path then produces summary + recent verbatim turns."""
    if session['state'] != 'active':
        return {'compacted': False, 'reason': 'session_not_active'}
    if not session['needs_summary']:
        return {'compacted': False, 'reason': 'no_pending_summary'}

    rollup_id = generate_session_summary(con, session)
    if not rollup_id:
        store.update_session(con, session['id'], needs_summary=0)
        con.commit()
        return {'compacted': False, 'reason': 'nothing_absorbed'}

    con.commit()
    return {'compacted': True, 'rollup_id': rollup_id}


def end_session(con, session, *, reason='client', total_input_tokens=0, total_output_tokens=0):
    """Settle session: mark ended, accumulate usage, optionally summarize."""
    if session['state'] == 'ended':
        return {'ok': True, 'summary': session['summary']}

    token_updates = {}
    if total_input_tokens and total_input_tokens > (session['total_input_tokens'] or 0):
        token_updates['total_input_tokens'] = int(total_input_tokens)
    if total_output_tokens and total_output_tokens > (session['total_output_tokens'] or 0):
        token_updates['total_output_tokens'] = int(total_output_tokens)
    ended = utcnow()
    # Deliberate mid-call removal: unlink the leg from its call, so the
    # roster restore on resume doesn't bring the agent back. Membership is
    # exactly "still linked" — no timing heuristics.
    #
    # Unlink EVERY session this agent has pointing at the call, not just this
    # leg's row. The roster restore groups by agent_id, so one stale link is
    # enough to resurrect a removed companion — and stale links are normal:
    # an agent joining a call resumes whichever of its sessions was most
    # recently active, so across calls it accumulates several rows aimed at
    # the same parent. Clearing only this row left the others to bring the
    # agent straight back on the next resume.
    if reason == 'removed' and session['call_parent_session_id']:
        con.execute(
            "UPDATE sessions SET call_parent_session_id = NULL "
            "WHERE agent_id = ? AND call_parent_session_id = ?",
            (session['agent_id'], session['call_parent_session_id']),
        )
        token_updates['call_parent_session_id'] = None
    store.update_session(con, session['id'], state='ended', ended_at=ended,
                         last_active_at=ended, **token_updates)
    # Commit the settle BEFORE summarising: the summary is a network
    # round-trip (and first waits on _summary_lock if a background /compact
    # is mid-flight), and holding these writes in an open transaction through
    # it blocks every other writer meanwhile - the in-flight compact's own
    # bookkeeping died on "database is locked", leaving needs_summary set so
    # this call ran a SECOND summary while still holding the lock, and a
    # resume of another companion queued behind it for minutes.
    con.commit()
    session = store.get_session(con, session['id'])
    # Before the summary round-trip: an extension winding down something the
    # session started shouldn't wait on it.
    plugins.emit('session_end', con=con, session=session)

    if session['needs_summary']:
        try:
            generate_session_summary(con, session)
        except Exception as e:
            _logger.warning('Summary generation failed for session %s: %s', session['id'], e)

    session = store.get_session(con, session['id'])
    con.commit()
    return {'ok': True, 'summary': session['summary']}


_SUMMARY_TOOL_FIELD_TRUNCATE = 500


def _truncate_for_summary(text):
    """Cap tool arg/result strings before they hit the summarizer - full record
    dumps are noise; the summarizer only needs enough to ground its prose."""
    if not text:
        return ''
    text = str(text)
    if len(text) <= _SUMMARY_TOOL_FIELD_TRUNCATE:
        return text
    return text[:_SUMMARY_TOOL_FIELD_TRUNCATE] + f'… (truncated, {len(text)} chars total)'


def _approx_words(text):
    """Word count for the summary size check. CJK text has no spaces, so
    count those characters at about two per word instead."""
    import re
    cjk = len(re.findall(r'[぀-ヿ㐀-鿿가-힯]', text or ''))
    return len(re.sub(r'[぀-ヿ㐀-鿿가-힯]', ' ', text or '').split()) + cjk // 2


# Per-process serialization for title generation + summary rollups (the Odoo
# module used pg advisory locks / SELECT FOR UPDATE; a process lock gives the
# same guarantee in a single-process server).
_title_lock = threading.Lock()
_summary_lock = threading.Lock()


def maybe_generate_session_title(con, session):
    """Auto-title the session after the first user/assistant exchange. No-op
    once title_generated is set, so a user-edited title is never clobbered.
    Failures are swallowed - title generation is a UX nicety."""
    if session['title_generated']:
        return
    if not _title_lock.acquire(blocking=False):
        return
    try:
        fresh = store.get_session(con, session['id'])
        if fresh['title_generated']:
            return
        user_row = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND role = 'user' AND content != '' "
            "ORDER BY sequence ASC, id ASC LIMIT 1",
            (session['id'],),
        ).fetchone()
        assistant_row = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' "
            "ORDER BY sequence ASC, id ASC LIMIT 1",
            (session['id'],),
        ).fetchone()
        if not user_row or not assistant_row:
            return
        transcript = (
            f'User: {(user_row["content"] or "").strip()}\n'
            f'Assistant: {(assistant_row["content"] or "").strip()}'
        )
        config = get_config(con)
        # The caller's rows go in now: holding them in an open transaction
        # through the title request (a local model can take a while) would
        # make every other writer wait — a voice call's request-size write
        # among them.
        con.commit()
        try:
            title, usage = xai_client.generate_title(
                xai_api_key=config['xai_api_key'],
                responses_url=config['xai_responses_url'],
                summary_model=config['summary_model'],
                transcript=transcript,
                complete=_background_complete(con, session, config),
            )
        except Exception:
            _logger.exception('Auto-title generation failed for session %s', session['id'])
            return
        store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
        if not title:
            return
        store.update_session(con, session['id'], name=title, title_generated=1)
    finally:
        _title_lock.release()


def _build_verbatim_transcript(to_summarize):
    """Render THIS block's user/assistant turns in full for durable episode
    storage. Unlike the summary transcript this excludes any prior rollup (we
    want only this segment's real turns) and does not truncate user/assistant
    content; tool activity is reduced to a one-line marker so the stored
    transcript stays readable without raw JSON payloads."""
    lines = []
    for m in to_summarize:
        if m['role'] == 'user':
            lines.append(f'User: {m["content"] or ""}')
        elif m['role'] == 'assistant':
            # Group calls stamp assistant rows with the speaking agent's
            # name — keep the attribution so three voices don't fold into
            # one "Assistant".
            lines.append(f'{m["speaker"] or "Assistant"}: {m["content"] or ""}')
        elif m['role'] == 'system':
            lines.append(f'[call note: {m["content"] or ""}]')
        elif m['role'] == 'tool_call':
            lines.append(f'[tool call: {m["tool_name"] or "tool"}]')
        elif m['role'] == 'tool_result':
            lines.append(f'[tool result: {m["tool_name"] or "tool"}]')
    return '\n'.join(lines)


def _extract_and_store_memories(con, session, config, to_summarize, transcript):
    """Distil durable memory from a freshly rolled-up block and persist it.

    Reads the same flattened `transcript` the summary used, asks the model for
    fact operations + one episode, accrues the call's cost, then writes via
    memory_tools.apply_extraction_ops. The verbatim segment transcript is
    stored inline on the episode so it survives transcript pruning. Best-effort;
    the caller isolates failures so compaction is never broken.
    """
    agent_id = session['agent_id']
    if agent_id:
        core_rows = con.execute(
            "SELECT id, content FROM memories WHERE scope = 'core' AND memory_type = 'fact' "
            "AND (agent_id = ? OR agent_id IS NULL) ORDER BY created_at ASC, id ASC",
            (agent_id,),
        ).fetchall()
    else:
        core_rows = con.execute(
            "SELECT id, content FROM memories WHERE scope = 'core' AND memory_type = 'fact' "
            "AND agent_id IS NULL ORDER BY created_at ASC, id ASC",
        ).fetchall()
    existing_core = [(r['id'], r['content']) for r in core_rows]

    parsed, usage = xai_client.generate_memory_extraction(
        xai_api_key=config['xai_api_key'],
        responses_url=config['xai_responses_url'],
        summary_model=config['summary_model'],
        transcript=transcript,
        existing_core=existing_core,
        known_tags=memory_tools.known_tags(con),
        reasoning_effort=None,
        complete=_background_complete(con, session, config),
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
    if not parsed:
        return
    verbatim = _build_verbatim_transcript(to_summarize)
    counts = memory_tools.apply_extraction_ops(
        con, agent_id,
        ops=parsed.get('facts'), episode=parsed.get('episode'),
        transcript=verbatim, session_id=session['id'],
    )
    _logger.info('Memory extraction for session %s: %s', session['id'], counts)


def generate_session_summary(con, session):
    """Roll up older turns into a single system-role summary message.

    Behaviours (ported):
      1. The most recent K user/assistant turns stay verbatim; the summary
         absorbs anything older. Tool rows attach to whichever side of the
         boundary they sit on by sequence.
      2. Tool calls/results fold INTO the summary input in compressed form so
         summaries stay grounded in real values.
      3. An existing rollup is folded in and superseded - at most one active
         rollup at a time.
      4. Concurrent callers are serialized via a process lock; after acquiring
         it the runner re-reads needs_summary and bails if a sibling cleared it.

    Returns the new rollup message id, or None.
    """
    with _summary_lock:
        session = store.get_session(con, session['id'])
        if not session['needs_summary']:
            return None

        config = get_config(con)
        keep_recent = max(0, config['summary_keep_recent_messages'] or 0)

        user_assistant_rows = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
            "AND role IN ('user', 'assistant') ORDER BY sequence ASC, id ASC",
            (session['id'],),
        ).fetchall()

        # Nothing old enough to absorb. On a setup brain the request that
        # asked for this summary is then all prompt, tools and the kept
        # turns, so its size becomes the floor (setups.context_full) —
        # else every reply would ask again.
        nothing_absorbed = {'needs_summary': 0}
        if session['context_tokens']:
            nothing_absorbed['context_floor'] = session['context_tokens']

        if keep_recent and len(user_assistant_rows) <= keep_recent:
            store.update_session(con, session['id'], **nothing_absorbed)
            return None

        cutoff_sequence = None
        if keep_recent and len(user_assistant_rows) > keep_recent:
            cutoff_sequence = user_assistant_rows[-keep_recent]['sequence']

        # 'system' covers group-call management notes (joined/left, join
        # context) — without absorbing them they'd replay forever. The
        # is_summary_rollup guard keeps the prior rollup out of this set;
        # it's folded in separately below and then superseded.
        q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
             "AND role IN ('user', 'assistant', 'system', 'tool_call', 'tool_result') "
             "AND is_summary_rollup = 0")
        params = [session['id']]
        if cutoff_sequence is not None:
            q += " AND sequence < ?"
            params.append(cutoff_sequence)
        q += " ORDER BY sequence ASC, id ASC"
        to_summarize = con.execute(q, params).fetchall()

        if not to_summarize:
            store.update_session(con, session['id'], **nothing_absorbed)
            return None

        prior_rollup = con.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_summary_rollup = 1 "
            "AND is_summarized_into IS NULL ORDER BY sequence ASC LIMIT 1",
            (session['id'],),
        ).fetchone()

        transcript_lines = []
        if prior_rollup:
            transcript_lines.append(f'[Prior summary]\n{prior_rollup["content"]}\n')
        last_day = None
        for m in to_summarize:
            # A local-date marker whenever the day changes: the rows carry no
            # timestamps otherwise, so the summary could only date events
            # from stray "Conversation resumed" notes ("Fri 18", no month).
            created = parse_dt(m['created_at'])
            if created:
                day = created.replace(tzinfo=timezone.utc).astimezone().strftime('%a %d %b %Y')
                if day != last_day:
                    transcript_lines.append(f'[{day}]')
                    last_day = day
            if m['role'] == 'user':
                transcript_lines.append(f'User: {m["content"] or ""}')
            elif m['role'] == 'assistant':
                # Group calls stamp assistant rows with the speaking agent's
                # name — keep the attribution so the summary doesn't fold
                # three voices into one "Assistant".
                transcript_lines.append(f'{m["speaker"] or "Assistant"}: {m["content"] or ""}')
            elif m['role'] == 'system':
                # Call-management notes (agent joined/left, join context). The
                # rollup row itself never reaches here (excluded by the query).
                transcript_lines.append(f'[Call note] {m["content"] or ""}')
            elif m['role'] == 'tool_call':
                args = _truncate_for_summary(m['tool_arguments_json'] or m['content'] or '')
                transcript_lines.append(f'[Tool call] {m["tool_name"] or "tool"}({args})')
            elif m['role'] == 'tool_result':
                output = _truncate_for_summary(m['tool_result_json'] or m['content'] or '')
                transcript_lines.append(f'[Tool result] {m["tool_name"] or "tool"} -> {output}')

        transcript = '\n'.join(transcript_lines)
        # Size on record: a compaction that stalls is easier to read with
        # the request size next to it in the log.
        _logger.info('Session %s summary: %d rows, %d chars (streamed)',
                     session['id'], len(to_summarize), len(transcript))

        # With a word budget set, the summary grows then compresses: most
        # compactions only APPEND a dated update for the new turns, leaving
        # the older text untouched; once it passes summary_consolidate_words
        # one pass rewrites the whole thing under summary_max_words (see
        # the config schema comment for the sources).
        # A session on a voice setup's brain uses that brain's limits
        # (engines.conversation_fields); the rest use Settings'.
        brain = _session_brain(con, session, config)
        max_words, consolidate_words = voice_setups.summary_limits(brain[1] if brain else None, config)
        update_only = bool(
            max_words and prior_rollup
            and _approx_words(prior_rollup['content']) < consolidate_words)
        summary_text, summary_usage = xai_client.generate_summary(
            xai_api_key=config['xai_api_key'],
            responses_url=config['xai_responses_url'],
            summary_model=config['summary_model'],
            transcript=transcript,
            reasoning_effort=None,
            max_words=max_words,
            update_only=update_only,
            complete=_background_complete(con, session, config),
        )
        store.accrue_usd_ticks(con, store.extract_cost_ticks(summary_usage))
        if update_only:
            first, last = to_summarize[0]['created_at'] or '', to_summarize[-1]['created_at'] or ''
            span = first[:10] if first[:10] == last[:10] else f'{first[:10]} to {last[:10]}'
            summary_text = (f'{prior_rollup["content"].rstrip()}\n\n'
                            f'Update ({span}):\n{summary_text.strip()}')

        # Rollup at the END of the sequence (audit-friendly); replay paths
        # hoist it to the front of the wire order.
        rollup_id = store.insert_message(
            con, session['id'],
            role='system',
            content=summary_text,
            is_summary_rollup=1,
        )

        absorbed_ids = [m['id'] for m in to_summarize]
        if prior_rollup:
            absorbed_ids.append(prior_rollup['id'])
        con.execute(
            f"UPDATE messages SET is_summarized_into = ? "
            f"WHERE id IN ({','.join('?' * len(absorbed_ids))})",
            (rollup_id, *absorbed_ids),
        )

        session = store.get_session(con, session['id'])
        current_total = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
        store.update_session(
            con, session['id'],
            summary=summary_text,
            needs_summary=0,
            tokens_at_last_summary=current_total,
            context_tokens=0,
            context_floor=-1,   # the next request measures it
        )

        # Commit the finished rollup before extraction: extraction is another
        # network round-trip, and holding the rollup writes in an open
        # transaction through it would block every other writer meanwhile.
        con.commit()

        # Automatic memory extraction — distil durable facts + one episodic
        # memory from this same block, so load-bearing detail survives outside
        # the lossy rollup and "remember when…" moments become retrievable.
        # Best-effort and fully isolated: any failure must never break
        # compaction (mirrors maybe_generate_session_title).
        agent = store.get_agent(con, session['agent_id'])
        if agent['enable_memory_tools']:
            try:
                _extract_and_store_memories(con, session, config, to_summarize, transcript)
            except Exception:
                _logger.exception('Memory extraction failed for session %s', session['id'])

        return rollup_id


def speech_gesture_select(con, *, session, line, recent_ids=(), words=None):
    """Speech gesture selector: which motion-library gesture, if any, fits a
    line the companion is saying? One call per sentence, made by the browser
    as transcript sentences stream in; the clip plays over the idle while
    the line is still being spoken. Deliberate play_gesture calls always
    pre-empt it client-side.

    Either engine answers it, with no setting to choose between them: Jev
    whenever a TypeSafe key is set (gesture_director.py — the library as a
    Choice), otherwise the director model, which reads the library as
    prompt text and writes back an id. Measured side by side Jev was 2.8x
    faster, 6.1x cheaper and picked better (22/27 against 19/27), so a key
    that is set is answer enough; the same rule decides the turn director.
    `words` are the line's words as the browser split them, for Jev's word
    Choice.

    Return contract: {'gesture': <clip id>, 'word': <str or None>} or
    {'gesture': None} — None covers "nothing fits", "could not run" and
    unparseable replies alike; the client simply plays nothing. `reason`
    names which of those it was: most sentences legitimately get no gesture,
    and without it a selector that is declining and one that is broken look
    identical in the browser console. `word` is the word of the line the
    gesture illustrates; the client lands the motion's stroke on it.
    """
    if session['state'] != 'active':
        return {'gesture': None, 'reason': 'session_inactive'}
    line = (line or '').strip()
    # Mirror the client's length test: whitespace word counts are
    # meaningless for Japanese/Chinese/Thai, which are written without
    # spaces, so those scripts are measured in characters instead.
    unspaced = re.search(r'[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿]', line)
    if len(line.split()) < 3 and not (unspaced and len(line) >= 6):
        return {'gesture': None, 'reason': 'too_short'}
    config = get_config(con)
    candidates = motion_library.speech_gesture_candidates()
    if not candidates:
        return {'gesture': None, 'reason': 'no_gesture_library'}
    # Oldest first, as the browser keeps them (motion_director _recentIds),
    # so the CAP TAKES THE TAIL. Slicing the head instead kept the twelve
    # oldest and dropped the newest, which quietly broke every rule below
    # that depends on knowing what just played — but only once a reply ran
    # past twelve gestures, so short replies and two-line tests looked fine
    # while a long one repeated a clip back to back.
    recent = [str(r)[:64] for r in (recent_ids or [])[-12:] if r]
    # The newest entry is what the avatar has only just finished performing.
    # Repeating that exact motion back-to-back is the one repeat that always
    # reads as a glitch, so it is refused outright below rather than nudged.
    last = motion_library.speech_gesture_canonical(candidates, recent[-1:])
    just_played = last[0] if last else None
    pick = _gesture_pick_jev if config['typesafe_api_key'] else _gesture_pick_grok
    try:
        gesture, word, word_index, ticks, reason = pick(
            con, config, session=session, line=line[:400], candidates=candidates,
            recent=recent, just_played=just_played, words=words)
    except Exception as e:  # noqa: BLE001 — a failed pick is just "no gesture"
        _logger.warning("speech gesture select failed: %s", e)
        return {'gesture': None, 'reason': 'selector_error'}
    # Billed, but NOT added to the session's token totals - those drive the
    # summarization threshold, and this call's prompt is the whole gesture
    # library re-sent for every spoken sentence. Accruing it would make a
    # chatty turn look like a huge context and compact the conversation long
    # before it needed it. Same treatment as the group-call director below.
    # Before the early return below: a call that decided on no gesture was
    # made and charged for like any other.
    try:
        store.accrue_usd_ticks(con, ticks)
        con.commit()
    except Exception:  # noqa: BLE001 — spend accounting never fails a pick
        pass
    if reason:
        return {'gesture': None, 'reason': reason}
    if gesture and gesture not in candidates:
        _logger.info("speech gesture selector named unknown id %r", gesture[:64])
        gesture = None
        reason = 'unknown_id'
    if gesture and just_played:
        # Same motion twice running — a different take of it is still the
        # same gesture to look at, so drop it rather than rotate.
        picked = motion_library.speech_gesture_canonical(candidates, [gesture])
        if picked and picked[0] == just_played:
            _logger.info("speech gesture: refused back-to-back repeat of %s", just_played)
            gesture = None
            reason = 'back_to_back_repeat'
    if gesture:
        # The prompt lists one take per motion; play a fresh take when the
        # library has several, so a repeated "thanks" is not the same clip.
        variants = motion_library.speech_gesture_variants(candidates, gesture)
        unseen = [v for v in variants if v['id'] not in recent] or variants
        if unseen:
            gesture = random.choice(unseen)['id']
    return {
        'gesture': gesture,
        'word': word if gesture else None,
        # Which of the browser's own words, when the engine picked among
        # them rather than copying one out of the line (Jev). The client
        # already knows where that word starts, so the stroke lands on the
        # right one even when the line repeats it.
        'word_index': word_index if gesture else None,
        'reason': reason or ('nothing_fits' if not gesture else None),
    }


def _gesture_pick_grok(con, config, *, session, line, candidates, recent, just_played, words):
    """The director model reads the whole library as prompt text and names
    an id - or, without an xAI key, the companion's own provider on its
    quick model (_provider_side_complete). Returns (gesture, word,
    word_index, ticks, failure_reason)."""
    xai_key = config['xai_api_key']
    model = config['director_model'] or config['text_model'] or config['summary_model']
    complete = None
    if not xai_key or not model:
        complete = _provider_side_complete(con, session['agent_id'], config, 'gesture')
        if complete is None:
            return None, None, None, 0, 'no_model_configured'
    gesture, word, usage = xai_client.select_speech_gesture(
        complete=complete,
        xai_api_key=xai_key,
        responses_url=config['xai_responses_url'],
        model=model,
        line=line,
        library_lines=motion_library.speech_gesture_lines(candidates),
        # Named as the ids the prompt lists, not the takes that played.
        recent_ids=motion_library.speech_gesture_canonical(candidates, recent),
        just_played=just_played,
    )
    return gesture, word, None, store.extract_cost_ticks(usage), None


def _gesture_pick_jev(con, config, *, session, line, candidates, recent, just_played, words):
    """Jev picks from the library as a Choice (gesture_director.py), with a
    yes/no first for whether the line calls for a gesture at all. Returns
    (gesture, word, word_index, ticks, failure_reason)."""
    if not config['typesafe_api_key']:
        return None, None, None, 0, 'no_typesafe_key'
    agent = store.get_agent(con, session['agent_id'])
    name = agent['name'] if agent else 'the character'
    persona = face_director.persona_excerpt(_render_prompt(agent)) if agent else ''
    # The clip just played is not on the menu at all — the one repeat that
    # always reads as a glitch cannot be picked rather than being asked
    # against, so its share of the distribution goes to the alternatives.
    opts = gesture_director.options(candidates, exclude=[just_played] if just_played else ())
    if not opts:
        return None, None, None, 0, 'no_gesture_library'
    qs = gesture_director.questions(name, opts, words=words)
    state = gesture_director.build_state(name, persona, [], line)
    body = jev.ask(config['typesafe_api_key'], config['jev_model'], state, qs)
    gesture, word_index, reason = gesture_director.choose(jev.answers(body, qs), candidates, opts)
    word = None
    if gesture and word_index is not None and words and word_index < len(words):
        word = str(words[word_index])[:80] or None
    return gesture, word, word_index, jev.input_ticks(body), reason


def face_director_select(con, *, session, line, context=(), listening=False, words=None,
                         partial=False):
    """Face director (face_director.py): what the companion's face does
    while they say one line, or — `listening` — as they hear the user's.
    One call per spoken sentence, made by the browser as the transcript
    streams in, plus the user's words as they are heard (`partial`: while
    they are still speaking); the renderer shows the answer when the voice
    reaches the line (or at once, for a listening face).

    Return contract: {'face': <face_director.normalize shape>} or
    {'face': None, 'reason': ...} — None means "leave the face as it is".
    """
    if session['state'] != 'active':
        return {'face': None, 'reason': 'session_inactive'}
    line = (line or '').strip()
    if not line:
        return {'face': None, 'reason': 'empty'}
    config = get_config(con)
    if not config['face_director']:
        return {'face': None, 'reason': 'off'}
    if not config['typesafe_api_key']:
        return {'face': None, 'reason': 'no_typesafe_key'}
    agent = store.get_agent(con, session['agent_id'])
    name = agent['name'] if agent else 'the character'
    persona = face_director.persona_excerpt(_render_prompt(agent)) if agent else ''
    # What they are reacting to: the last exchange on record (the reply
    # being spoken now is not saved until it ends), then the lines of this
    # reply already said, which the browser sends along. A listening read's
    # own line may already be saved; it is the line, not its context.
    user_label = (config['user_display_name'] or '').strip() or 'User'
    rows = con.execute(
        "SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant')"
        " ORDER BY sequence DESC, id DESC LIMIT 2", (session['id'],)).fetchall()
    conversation = [(user_label if r['role'] == 'user' else name, (r['content'] or '')[:400])
                    for r in reversed(rows) if (r['content'] or '').strip()]
    if listening and conversation and conversation[-1] == (user_label, line[:400]):
        conversation.pop()
    conversation += [(name, str(c)[:400]) for c in list(context or [])[-2:] if c]
    state = face_director.build_state(name, persona, conversation, line[:400], listening=listening,
                                      partial=partial)
    qs = face_director.questions(name, listening=listening, words=None if listening else words)
    try:
        body = jev.ask(config['typesafe_api_key'], config['jev_model'], state, qs)
        answers = jev.answers(body, qs)
        ticks = jev.input_ticks(body)
    except Exception as e:  # noqa: BLE001 — a failed read is just "no change"
        _logger.warning("face director failed: %s", e)
        return {'face': None, 'reason': 'director_error'}
    # Billed, but kept out of the session's token totals, like the speech
    # gesture selector above: they drive compaction, and this is a side call.
    try:
        store.accrue_usd_ticks(con, ticks)
        con.commit()
    except Exception:  # noqa: BLE001 — spend accounting never fails a read
        pass
    face = face_director.normalize(answers, qs)
    if face is None:
        _logger.info("face director reply unusable")
        return {'face': None, 'reason': 'unparseable'}
    return {'face': face}


def director_decide(con, *, session, transcript_lines, participants, user_name=None,
                    floor_key=None):
    """Group-call turn director: which participant (or the user) speaks next?

    Runs a one-shot classification on the configured director model (the
    fastest non-reasoning model - this is a latency-critical one-token
    answer). Called by the browser's call manager for every user utterance
    in a group call (candidates = all agents) and after every agent turn
    (candidates = the other agents). `floor_key` names the participant
    currently holding the floor so ambiguous user turns stay with whoever
    the user was already talking to.

    Return contract: {'next': <key>} routes to that agent; {'next': 'user'}
    is an EXPLICIT decision to wait for the user; {'next': None} means the
    director could not run (no key / no model / error) - the client falls
    back to its local vocative rules instead of treating this as a
    decision.
    """
    if session['state'] != 'active':
        return {'next': None}
    if not transcript_lines or not participants:
        return {'next': None}
    config = get_config(con)
    # Sanitize inbound shapes — this is browser-supplied JSON.
    clean_participants = []
    for p in participants[:6]:
        if isinstance(p, dict) and p.get('key') and p.get('name'):
            clean_participants.append({'key': str(p['key'])[:64], 'name': str(p['name'])[:80]})
    clean_lines = [str(l)[:500] for l in transcript_lines[-12:] if l]
    if not clean_participants or not clean_lines:
        return {'next': None}
    clean_floor = str(floor_key)[:64] if floor_key else None
    if clean_floor and not any(p['key'] == clean_floor for p in clean_participants):
        clean_floor = None
    # Generic on purpose: the user's real name stays out of call plumbing
    # (it reaches agents only via include_user_name_in_prompt or their
    # memories).
    clean_user = str(user_name or 'User')[:80]
    # Jev whenever a TypeSafe key is set, with no setting to choose it.
    # Unlike the speech gestures this path never had one, and a group call
    # pays the director on every single turn — after each user utterance
    # AND each agent turn — so it is the one place where the difference
    # between a ~250 ms read and a ~1.5 s one is dead air between speakers.
    # No key keeps the director model, or the companion's own provider
    # without an xAI key.
    if config['typesafe_api_key']:
        return _director_jev(con, config, user_name=clean_user, participants=clean_participants,
                             lines=clean_lines, floor_key=clean_floor)
    return _director_grok(con, config, agent_id=session['agent_id'], user_name=clean_user,
                          participants=clean_participants, lines=clean_lines, floor_key=clean_floor)


def _director_jev(con, config, *, user_name, participants, lines, floor_key):
    """Jev answers what the last message did; turn_director ranks them."""
    opts = turn_director.options(participants, user_name)
    floor_name = next((p['name'] for p in participants if p['key'] == floor_key), None)
    qs = turn_director.questions(opts)
    state = turn_director.build_state(user_name, participants, lines, floor_name)
    try:
        body = jev.ask(config['typesafe_api_key'], config['jev_model'], state, qs)
        answers = jev.answers(body, qs)
        ticks = jev.input_ticks(body)
    except Exception as e:  # noqa: BLE001 — a failed read is "no decision"
        _logger.warning("turn director (jev) failed: %s", e)
        return {'next': None}
    # Accrued before the decision is read: a call that ends in no decision
    # was still billed.
    try:
        store.accrue_usd_ticks(con, ticks)
        con.commit()
    except Exception:  # noqa: BLE001 — spend accounting never fails a read
        pass
    decision, reason = turn_director.decide(answers, opts, floor_key)
    if decision is None:
        _logger.info("turn director: no decision (%s)", reason)
    return {'next': decision}


def _director_grok(con, config, *, agent_id, user_name, participants, lines, floor_key):
    """The director model reads the rules as prose and names one token -
    or, without an xAI key, the companion's own provider on its quick
    model (_provider_side_complete)."""
    xai_key = config['xai_api_key']
    model = config['director_model'] or config['text_model'] or config['summary_model']
    complete = None
    if not xai_key or not model:
        complete = _provider_side_complete(con, agent_id, config, 'director')
        if complete is None:
            return {'next': None}
    try:
        decision, usage = xai_client.decide_next_speaker(
            complete=complete,
            xai_api_key=xai_key,
            responses_url=config['xai_responses_url'],
            model=model,
            transcript_lines=lines,
            participants=participants,
            user_name=user_name,
            floor_key=floor_key,
        )
    except Exception as e:
        _logger.warning("director_decide failed: %s", e)
        return {'next': None}
    # Director calls are billed LLM usage — accrue into the spend counters
    # like every other background call.
    try:
        store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
        con.commit()
    except Exception:
        pass
    return {'next': decision}


# ---------------------------------------------------------------------------
# Text mode (xAI Responses API)
# ---------------------------------------------------------------------------

# Native tool names that execute server-side directly during the text response
# loop. The standalone has no browser tools in text mode (the Odoo navigation
# / DOM tools are gone), so the loop always resolves server-side.
NATIVE_TOOL_NAMES_TEXT = (
    imagine_tools.IMAGINE_TOOL_NAMES
    | memory_tools.MEMORY_TOOL_NAMES
    | affection_tools.AFFECTION_TOOL_NAMES
    | lore_tools.LORE_TOOL_NAMES
    | {delegate_tools.DELEGATE_TOOL_NAME}
    | {local_tools.LOCAL_TASK_TOOL_NAME}
    | {companion_texting.TEXT_COMPANION_TOOL_NAME}
    | {voicemail_tools.CREATE_VOICEMAIL_TOOL_NAME}
)
# Browser tools that round-trip through the text client (dispatch in the
# page's ToolDispatcher, results fed back via /tool_results). The screen
# capture pair are the standalone's first text-mode browser tools.
TEXT_BROWSER_TOOL_NAMES = {'take_screenshot', 'analyze_screen', 'record_screen_clip'}


def _build_text_tools(con, agent, *, mcp_entries, enable_web_search, enable_x_search,
                      enable_code_execution=False,
                      enable_grok_imagine_tools=False,
                      enable_memory_tools=False,
                      enable_affection_tool=False,
                      enable_delegate_tool=False,
                      enable_local_tasks=False,
                      enable_minecraft=False,
                      enable_games=False,
                      enable_companion_texting=False,
                      enable_voicemail=False,
                      enable_browser_tools=False,
                      plugin_origin=None):
    """Assemble the tools list for /v1/responses calls in text mode.
    enable_browser_tools is False for headless turns (delegated task
    sessions) - a browser round-trip needs a browser to answer it.
    plugin_origin is the session origin extension tools are offered for;
    None offers none."""
    tools = []
    # Tools that run on the app's xAI key are left out without one (see
    # _voice_tools).
    has_xai = bool(get_config(con)['xai_api_key'])
    for entry in mcp_entries or []:
        tools.append(entry)
    if enable_grok_imagine_tools:
        # Text mode gets create_image + create_video — change_background
        # has no live avatar canvas to swap, so offering it would just
        # confuse the model. Editing user uploads goes through create_image
        # source_images (uploads are ingested into the Imagine library).
        for entry in imagine_tools.build_text_tools(con, agent):
            tools.append(entry)
    if enable_voicemail and voicemail_tools.available(con, agent, get_config(con)):
        # Text only: see voicemail_tools for why voice calls go without it.
        tools.append(voicemail_tools.build_tool(con, agent))
    if agent['enable_capture_tools']:
        # No take_selfie in text mode: there is no canvas, and the portrait
        # it used to serve now rides create_image/create_video include_self.
        # The screen-capture pair round-trip through the browser (see
        # TEXT_BROWSER_TOOL_NAMES), so they need one.
        if enable_browser_tools:
            for shared_tool in (browser_tools.SCREENSHOT_TOOL,
                                *([browser_tools.ANALYZE_SCREEN_TOOL]
                                  if has_xai or vision_brain(con, agent, get_config(con), 'text') else []),
                                browser_tools.RECORD_SCREEN_CLIP_TOOL):
                tools.append({
                    'type': 'function',
                    'name': shared_tool['name'],
                    'description': shared_tool['description'],
                    'parameters': shared_tool['parameters'],
                })
    if enable_memory_tools:
        for entry in memory_tools.MEMORY_TOOLS:
            tools.append(entry)
    if agent['enable_lore_tool'] and lore_tools.has_stories(con, agent['name']):
        tools.append(lore_tools.build_recall_tool(con, agent['name']))
    if enable_affection_tool:
        for entry in affection_tools.build_tools(agent):
            tools.append(entry)
    local_tasks = enable_local_tasks and local_tools.grok_available()
    config = get_config(con)
    if enable_delegate_tool and (has_xai or delegate_brain(con, agent, config)):
        # A text brain that reads attachments or runs code itself (a setup's
        # Claude or OpenAI brain) isn't told it can't, so it doesn't hand
        # those to delegate_task.
        brain = voice_setups.text_brain_for(con, agent, config)
        sees = (brain is not None and not brain[0].uses_xai_key
                and bool(brain[1].get('vision') or brain[0].file_types(brain[1])))
        tools.append(delegate_tools.delegate_tool(
            with_local_task_note=local_tasks, sees_files=sees,
            own_sandbox=enable_code_execution and brain_runs_code(con, agent, config, 'text')))
    if local_tasks:
        tools.append(local_tools.LOCAL_TASK_TOOL)
    if enable_minecraft and minecraft_tools.connected() and minecraft_tools.brain_ready(con):
        tools.extend(minecraft_tools.build_tools())
    # A text turn's tools are built per turn, so unlike a call they can wait
    # for a game to be connected.
    if enable_games and games.connected(agent['id']):
        tools.extend(games.build_tools())
    if enable_companion_texting:
        text_tool = companion_texting.build_text_companion_tool(
            agent, [a for a in store.list_agents(con) if a['id'] != agent['id']])
        if text_tool is not None:
            tools.append(text_tool)
    if plugin_origin:
        tools.extend(plugins.tool_definitions(
            con, agent, 'text', plugin_origin,
            taken={t['name'] for t in tools if t.get('name')}))
    if enable_web_search:
        tools.append({'type': 'web_search'})
    if enable_x_search:
        tools.append({'type': 'x_search'})
    if enable_code_execution:
        tools.append({'type': 'code_interpreter'})
    return tools


def _text_input_items_from_rows(con, session, rows, structured_tools=False, attach_to=(), part_for=None):
    """Convert message rows into Responses-API `input` items.

    Shared by the fresh-chain full replay (_replay_text_messages) and the
    chain-alive interim injection (_interim_text_messages - rows appended
    while the conversation ran on the voice surface).

    Tool rows are flattened into compact system-role notes instead of being
    replayed as `function_call` items - replaying function_call input items
    requires per-item ids the realtime (voice) surface doesn't give us, and
    the model only needs the gist of what the tools did, grounded in real
    values. Payloads are truncated like the summariser's input so one chatty
    tool can't balloon the replay.

    Group-call attribution mirrors _build_replay_items: assistant rows spoken
    by ANOTHER participant replay as speaker-labelled user-side lines so the
    model never mistakes a peer's words for its own.

    `structured_tools` (a companion whose text chat runs on its voice
    setup's brain — every leg replays the whole conversation, no stored
    chain): tool rows with a call id replay as function_call /
    function_call_output items instead, which that path's engines accept
    and pair up themselves. A text model shown tool traffic as notes
    starts writing its calls as notes too.

    `part_for(imagine_image_id)` (that path too) turns an attached file
    into a content part the brain reads; only messages in `attach_to` get
    them (_brain_text_items: the last FILE_TURNS user messages).
    """
    own_name = store.get_agent(con, session['agent_id'])['name'] or ''
    items = []
    for m in rows:
        text = m['content'] or ''
        if m['role'] == 'user':
            # Library-linked image attachments stay usable across replay:
            # the xAI file id expires with the chain, but the Imagine
            # library copy doesn't — resurface the refs so the model can
            # still edit/animate images uploaded turns (or sessions) ago.
            lib_atts = [
                a for a in store.attachments_for_message(con, m['id'])
                if a['imagine_image_id']
            ]
            if not text and not lib_atts:
                continue
            content = [{'type': 'input_text', 'text': text}] if text else []
            if lib_atts:
                def _label(a):
                    mt = a['mimetype'] or ''
                    return ('image' if mt.startswith('image/')
                            else 'video' if mt.startswith('video/')
                            else 'document')
                refs = '; '.join(
                    f'"{a["filename"]}" = imagine_image_id {a["imagine_image_id"]} '
                    f'({_label(a)})'
                    for a in lib_atts
                )
                # A recent message's files themselves, for a brain that
                # reads them (attachment_part).
                shown, sandboxed = [], []
                if part_for is not None and m['id'] in attach_to:
                    for a in lib_atts:
                        part = part_for(a['imagine_image_id'])
                        if part:
                            content.append(part)
                            (sandboxed if part.get('sandbox') else shown).append(f'"{a["filename"]}"')
                # Files included here are the brain's to read itself; told
                # only to delegate them, Claude passed a photo it could see
                # to delegate_task (2026-10-02).
                here = ''.join((
                    f' Included in this message: {", ".join(shown)} - read them yourself.' if shown else '',
                    f' In your code execution sandbox: {", ".join(sandboxed)} - open them there.'
                    if sandboxed else ''))
                content.append({'type': 'input_text', 'text': (
                    f'[User attached file(s), saved in the files library: '
                    f'{refs}.{here} Images: pass the imagine_image_id to '
                    f'create_image source_images to edit, or create_video '
                    f'source_image/reference_images to animate. Videos: pass '
                    f'it as create_video edit_video to modify or extend_video '
                    f'to continue. Any file{" not included here" if shown or sandboxed else ""}: '
                    f'pass the imagine_image_id to '
                    f'delegate_task files to read/analyze it - these refs '
                    f'stay valid even though the original upload has '
                    f'expired.]'
                )})
            items.append({'role': 'user', 'content': content})
        elif m['role'] == 'assistant':
            # Files the companion's code sandbox made with this reply
            # (_save_brain_files), by library id like the user's uploads.
            made = [a for a in store.attachments_for_message(con, m['id']) if a['imagine_image_id']] \
                if structured_tools else []
            if not text and not made:
                continue
            if text and m['speaker'] and m['speaker'] != own_name:
                items.append({
                    'role': 'user',
                    'content': [{'type': 'input_text',
                                 'text': f'[{m["speaker"]}]: {text}'}],
                })
            elif text:
                items.append({'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]})
            if made:
                refs = '; '.join(f'"{a["filename"]}" = imagine_image_id {a["imagine_image_id"]}' for a in made)
                items.append({'role': 'system', 'content': [{'type': 'input_text', 'text': (
                    f'[Files from your code sandbox, shown to the user and saved in the files library: {refs}]')}]})
        elif m['role'] == 'system':
            if not text:
                continue
            items.append({'role': 'system', 'content': [{'type': 'input_text', 'text': text}]})
        elif structured_tools and m['role'] == 'tool_call' and m['xai_call_id']:
            items.append({'type': 'function_call', 'call_id': m['xai_call_id'],
                          'name': m['tool_name'] or '', 'arguments': m['tool_arguments_json'] or '{}'})
        elif structured_tools and m['role'] == 'tool_result' and m['xai_call_id']:
            items.append({'type': 'function_call_output', 'call_id': m['xai_call_id'],
                          'name': m['tool_name'] or '',
                          'output': _truncate_for_summary(m['tool_result_json'] or text)})
        elif m['role'] == 'tool_call':
            args = _truncate_for_summary(m['tool_arguments_json'] or text)
            items.append({
                'role': 'system',
                'content': [{'type': 'input_text',
                             'text': f'[Tool call] {m["tool_name"] or "tool"}({args})'}],
            })
        elif m['role'] == 'tool_result':
            output = _truncate_for_summary(m['tool_result_json'] or text)
            items.append({
                'role': 'system',
                'content': [{'type': 'input_text',
                             'text': f'[Tool result] {m["tool_name"] or "tool"} -> {output}'}],
            })
    return items


def _replay_text_messages(con, session, exclude_ids=None):
    """Rebuild a Responses-API `input` array from local message rows. Used
    when starting a fresh response chain (no previous_response_id) for a
    session that already has history - a resumed/post-compact/cross-mode
    session produces the prior conversation, voice transcript included.
    Rollups hoist to the front. `exclude_ids` keeps the current turn's
    just-persisted user row out of the replay - it's appended explicitly
    (with attachments) as the turn's input."""
    q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL")
    params = [session['id']]
    for mid in (exclude_ids or []):
        q += " AND id != ?"
        params.append(mid)
    q += " ORDER BY sequence ASC, id ASC"
    rows = con.execute(q, params).fetchall()
    rollups = [m for m in rows if m['is_summary_rollup']]
    others = [m for m in rows if not m['is_summary_rollup']]
    return _text_input_items_from_rows(con, session, rollups + others)


# How long an attached file rides along: on its message while that is one
# of the last FILE_TURNS user messages, then as its text ref only. A file
# costs its full size in every request it is in - sent inline or named by a
# Files API id alike - and the replies after it already say what it held;
# the ref keeps it reachable (delegate_task, the Imagine tools). A design
# pick, not a sourced number.
FILE_TURNS = 3
IMAGE_MAX_SIDE = 1280   # px, longest side, before encoding for a local brain
# A text file goes to a brain as text up to this many characters (~12k
# tokens), the cut said in the text.
TEXT_FILE_MAX_CHARS = 50_000
_TEXT_FILE_TYPES = ('application/json', 'application/xml', 'application/x-yaml', 'application/yaml',
                    'application/javascript', 'application/x-sh', 'application/sql', 'application/toml')
_TEXT_FILE_EXTS = ('.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
                   '.toml', '.ini', '.cfg', '.log', '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx',
                   '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.sql', '.srt')


def _image_jpeg(path):
    """An image file as JPEG bytes scaled to IMAGE_MAX_SIDE, or None."""
    import io
    from PIL import Image
    try:
        with Image.open(path) as im:
            im = im.convert('RGB')
            im.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=85)
    except (OSError, ValueError):
        return None
    return buf.getvalue()


def _brain_file_id(con, brain, imagine_image_id, filename, data, mimetype):
    """The brain provider's Files API id for a library file (uploaded once
    per provider account, reused until it expires - brain_files), or None
    when the brain's engine has no Files API. Upload errors raise."""
    import hashlib
    cls, settings = brain
    account = hashlib.sha256('|'.join((cls.id, settings.get('base_url') or '', settings.get('api_key') or ''))
                             .encode('utf-8')).hexdigest()[:16]
    cached = con.execute('SELECT file_id, expires_at FROM brain_files WHERE imagine_image_id = ? AND account = ?',
                         (imagine_image_id, account)).fetchone()
    margin = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=5)).isoformat(timespec='seconds')
    if cached and (not cached['expires_at'] or cached['expires_at'] > margin):
        return cached['file_id']
    uploaded = cls.upload_file(settings, filename=filename, data=data, mimetype=mimetype,
                               expires_seconds=get_config(con)['file_default_expiry_seconds'] or 0)
    if uploaded is None:
        return None
    con.execute('INSERT OR REPLACE INTO brain_files (imagine_image_id, account, file_id, expires_at) '
                'VALUES (?, ?, ?, ?)', (imagine_image_id, account, *uploaded))
    con.commit()   # text chat holds no write lock across the brain request
    return uploaded[0]


def attachment_part(con, imagine_image_id, brain, sandbox=False):
    """A library file as a content part for a voice-setup brain, or None
    (its text ref is all the brain gets):
      - an image, to a brain that sees: by Files API id where the engine
        has one (OpenAI, Claude), else inline, scaled to IMAGE_MAX_SIDE;
      - a file type the brain reads (LlmEngine.file_types: PDFs, Office
        documents on OpenAI): by Files API id, else inline;
      - a text file, to any brain: its text, up to TEXT_FILE_MAX_CHARS;
      - with `sandbox` (the brain's code execution is on), any other file
        its sandbox takes (LlmEngine.sandbox_accepts - Claude: any, OpenAI:
        its listed types), and a text file too long to send whole:
        uploaded into the code sandbox to open there.
    A failed upload leaves the file as its ref."""
    import base64
    cls, settings = brain
    row = con.execute('SELECT name, image_path, mimetype FROM imagine_images WHERE id = ?',
                      (imagine_image_id,)).fetchone()
    if not row or not row['image_path']:
        return None
    path = FILES_DIR / row['image_path'].rsplit('/', 1)[-1]
    name = row['name'] or path.name
    mimetype = row['mimetype'] or ''
    try:
        if mimetype.startswith('image/'):
            if not settings.get('vision'):
                return None
            data = _image_jpeg(path)
            if data is None:
                return None
            file_id = _brain_file_id(con, brain, imagine_image_id, f'{name.rsplit(".", 1)[0]}.jpg', data,
                                     'image/jpeg')
            return ({'type': 'input_image', 'file_id': file_id} if file_id else
                    {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii')})
        if mimetype in cls.file_types(settings):
            data = path.read_bytes()
            file_id = _brain_file_id(con, brain, imagine_image_id, name, data, mimetype)
            return ({'type': 'input_file', 'file_id': file_id, 'filename': name} if file_id else
                    {'type': 'input_file', 'filename': name,
                     'file_data': f'data:{mimetype};base64,' + base64.b64encode(data).decode('ascii')})
        sandbox = sandbox and cls.sandbox_accepts(settings, name)
        if mimetype.startswith('text/') or mimetype in _TEXT_FILE_TYPES \
                or name.lower().endswith(_TEXT_FILE_EXTS):
            data = path.read_bytes()
            text = data.decode('utf-8', 'replace')
            if len(text) <= TEXT_FILE_MAX_CHARS or not sandbox:
                cut = (f', the first {TEXT_FILE_MAX_CHARS:,} of {len(text):,} characters'
                       if len(text) > TEXT_FILE_MAX_CHARS else '')
                return {'type': 'input_text', 'text': f'\n\n[Contents of "{name}"{cut}]\n{text[:TEXT_FILE_MAX_CHARS]}'}
        elif sandbox:
            data = path.read_bytes()
        else:
            return None
        file_id = _brain_file_id(con, brain, imagine_image_id, name, data, mimetype or 'application/octet-stream')
        return {'type': 'input_file', 'file_id': file_id, 'filename': name, 'sandbox': True} if file_id else None
    except OSError:
        return None
    except Exception:
        _logger.warning('Could not upload %r for the %s brain; it stays a reference', name, cls.label,
                        exc_info=True)
    return None


def _brain_text_items(con, session, brain=None, sandbox=False):
    """The whole conversation for one leg on a voice-setup brain (see
    _brain_leg): every row not rolled into a summary, summaries first, tool
    traffic as structured pairs. With the `brain` it is for, the files of
    the last FILE_TURNS user messages go along as the brain reads them
    (attachment_part; `sandbox`: its code execution is on); without one (a
    size estimate), refs only."""
    rows = con.execute("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
                       "ORDER BY sequence ASC, id ASC", (session['id'],)).fetchall()
    rollups = [m for m in rows if m['is_summary_rollup']]
    others = [m for m in rows if not m['is_summary_rollup']]
    recent = {m['id'] for m in [m for m in others if m['role'] == 'user'][-FILE_TURNS:]}
    return _text_input_items_from_rows(
        con, session, rollups + others, structured_tools=True, attach_to=recent,
        part_for=(lambda imagine_image_id: attachment_part(con, imagine_image_id, brain, sandbox))
        if brain else None)


def _run_brain(brain, config, *, instructions, items, tools=(), conversation_key='rexclaw'):
    """One request to a voice-setup brain (a non-xAI engine: Ollama, LM
    Studio, any OpenAI-compatible server, Claude), run to the end from sync
    code: (reply text with any <think> block removed, output items - the
    function calls to run, the MCP calls the provider already ran and the
    files its code sandbox made ('brain_file') -, usage). A provider search loop past the limit raises
    xai_client.SearchLimitExceeded, as on xAI."""
    import asyncio
    import concurrent.futures
    from .pipeline.llm import SearchLimit
    from .pipeline.text import ThinkFilter
    cls, settings = brain

    async def run():
        engine = cls(settings, config)
        text, calls, usage = [], [], {}
        try:
            async for ev in engine.stream(instructions=instructions, items=items, tools=list(tools),
                                          conversation_key=conversation_key):
                if ev[0] == 'text':
                    text.append(ev[1])
                elif ev[0] == 'tool_call':
                    calls.append({'type': 'function_call', 'call_id': ev[1], 'name': ev[2],
                                  'arguments': ev[3]})
                elif ev[0] == 'hosted_call':
                    calls.append(ev[1])
                elif ev[0] == 'file':
                    calls.append({'type': 'brain_file', 'file_id': ev[1]})
                elif ev[0] == 'usage':
                    usage = ev[1] or {}
        except SearchLimit as e:
            raise xai_client.SearchLimitExceeded(str(e)) from e
        finally:
            await engine.close()
        return ''.join(text), calls, usage

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        reply, calls, usage = asyncio.run(run())
    else:   # called from a thread that runs an event loop: give it its own
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            reply, calls, usage = pool.submit(asyncio.run, run()).result()
    think = ThinkFilter()   # a local reasoning model's <think> block
    return (think.feed(reply) + think.flush()).strip(), calls, usage


def _save_brain_files(con, session, agent, brain, file_ids):
    """Files a setup brain's code sandbox made (Claude's $OUTPUT_DIR),
    downloaded from the provider into the files library (kind
    'code_output'), as attachments for the reply: the user opens them from
    the chat, and later turns can hand them to the Imagine tools or
    delegate_task by imagine_image_id like an upload. One that fails to
    download is logged and skipped."""
    cls, settings = brain
    out = []
    for file_id in file_ids:
        try:
            filename, data, mimetype = cls.download_file(settings, file_id)
        except Exception:
            _logger.warning('Could not download %s from the %s brain', file_id, cls.label, exc_info=True)
            continue
        name = (filename or 'file').replace('\\', '/').rsplit('/', 1)[-1].replace('\n', ' ')[:120] or 'file'
        ext = ('.' + name.rsplit('.', 1)[1].lower()) if '.' in name else (mimetypes.guess_extension(mimetype) or '')
        fname = f'imagine_{uuid.uuid4().hex}{ext}'
        (FILES_DIR / fname).write_bytes(data)
        row_id = con.execute(
            "INSERT INTO imagine_images (name, agent_id, session_id, kind, prompt, image_path, mimetype, created_at) "
            "VALUES (?, ?, ?, 'code_output', ?, ?, ?, ?)",
            (name, agent['id'], session['id'], name, f'/files/{fname}', mimetype, utcnow())).lastrowid
        out.append({'xai_file_id': f'{LOCAL_FILE_PREFIX}{file_id}', 'filename': name, 'size_bytes': len(data),
                    'mimetype': mimetype, 'imagine_image_id': row_id, 'url': f'/files/{fname}'})
    return out


def _brain_leg(con, config, session, agent, brain, instructions, tools):
    """One text-chat leg on a companion's voice-setup brain, returned in
    the Responses-API body shape the text loop reads. Stateless: there is
    no stored chain, so each leg sends the whole conversation, rebuilt from
    the message rows — the user's message, and every tool call and result
    this turn has persisted so far, included. Function tools, plus the
    hosted ones (web search, code execution, MCP servers) the brain's
    provider runs itself (LlmEngine.hosted_for). A provider error becomes
    a UserError, so the caller's MCP retry sees it."""
    from .pipeline.llm import LlmError
    # The prompt names no time (clock_at_end) so it stays byte-identical
    # leg to leg; the clock rides here, after the conversation.
    now = datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z (%z)')
    cls, settings = brain
    hosted = set(cls.hosted_for(settings))
    tools = [t for t in tools if t.get('type') == 'function' or t.get('type') in hosted]
    sandbox = any(t.get('type') == 'code_interpreter' for t in tools)
    items = _brain_text_items(con, session, brain, sandbox) + [
        {'role': 'system', 'content': [{'type': 'input_text', 'text': f'[Time note] Current datetime (user local): {now}'}]}]
    try:
        reply, calls, usage = _run_brain(brain, config, instructions=instructions, items=items, tools=tools,
                                         conversation_key=f'rexclaw:{agent["id"]}')
    except LlmError as e:
        raise UserError(f"Text chat request failed: {e}") from e
    output = [{'type': 'message', 'content': [{'type': 'output_text', 'text': reply}]}] if reply else []
    return {'id': None, 'output': output + calls, 'usage': usage}


def vision_brain(con, agent, config, mode):
    """The companion's own brain on this surface when it is local and sees
    images (the brain's 'Can see images'): analyze_screen runs there rather
    than on Grok vision, so the picture stays on this computer. Else None."""
    if mode == 'voice':
        setup = voice_setups.for_agent(con, agent, config)
        brain = setup.stages['llm'] if setup else None
    else:
        brain = voice_setups.text_brain_for(con, agent, config)
    if brain is not None and not brain[0].uses_xai_key and brain[1].get('vision'):
        return brain
    return None


def delegate_brain(con, agent, config):
    """(LlmEngine class, settings) delegate_task runs on: the companion's
    voice setup brain when its provider runs web search and code itself
    (Claude, OpenAI's own API) - the companion's deep-focus mode on its own
    model, with its files, sandbox and summaries there too. Else None: the
    app's Grok (delegation was built on xAI's tools; a local brain has
    neither search nor a sandbox)."""
    setup = voice_setups.for_agent(con, agent, config)
    if setup is None:
        return None
    cls, settings = setup.stages['llm']
    if cls.uses_xai_key or not {'web_search', 'code_interpreter'} <= set(cls.hosted_for(settings)):
        return None
    return cls, settings


def quick_brain(brain):
    """A brain on its engine's quick model (the 'quick_model' field: Claude
    Haiku 4.5 by default) for quick looks - analyze_screen, delegate_task's
    'fast' checks - the way Grok uses Settings' fast text model. The brain
    as it is when the field is empty or the engine has none."""
    if brain is None:
        return None
    cls, settings = brain
    quick = (settings.get('quick_model') or '').strip()
    return (cls, {**settings, 'model': quick}) if quick else brain


def brain_runs_code(con, agent, config, mode):
    """True when the companion's code execution runs on its own brain on
    this surface: a voice setup's brain whose provider has a code sandbox
    (Claude, OpenAI's own API - LlmEngine.hosted_for). Calls then get the
    tool too (Grok Realtime has none), and delegate_task stops being the
    way to run code."""
    if not agent['enable_code_execution']:
        return False
    if mode == 'voice':
        setup = voice_setups.for_agent(con, agent, config)
        # A speech-to-speech call has no code tool; its brain runs code
        # for it through delegate_task.
        brain = setup.stages['llm'] if setup and not setup.realtime else None
    else:
        brain = voice_setups.text_brain_for(con, agent, config)
    return bool(brain) and not brain[0].uses_xai_key and 'code_interpreter' in brain[0].hosted_for(brain[1])


def _background_complete(con, session, config):
    """Where a session's summary, title and memory extraction run: on the
    brain the session itself runs on when that isn't xAI's (_session_brain),
    so a conversation held on a local model stays local. None = the app's
    Grok (config.summary_model). Returns xai_client's `complete` hook."""
    brain = _session_brain(con, session, config)
    if brain is None or brain[0].uses_xai_key:
        return None

    def complete(*, instructions, input_items):
        text, _calls, usage = _run_brain(brain, config, instructions=instructions, items=input_items,
                                         conversation_key=f'rexclaw-background:{session["agent_id"]}')
        return {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}],
                'usage': {}}   # local: nothing billed
    return complete


def _provider_side_complete(con, agent_id, config, job):
    """xai_client's `complete` hook for the call side jobs that run on
    Grok's director model (group-call turn director, speech gestures), for
    an install without an xAI key: the companion's voice setup brain on its
    quick model (quick_brain - the main model when it has none). None when
    the setup's brain is xAI's or the companion is on Grok Realtime."""
    agent = store.get_agent(con, agent_id)
    setup = voice_setups.for_agent(con, agent, config) if agent else None
    brain = quick_brain(setup.stages['llm']) if setup else None
    if brain is None or brain[0].uses_xai_key:
        return None

    def complete(*, instructions, input_items):
        text, _calls, _usage = _run_brain(brain, config, instructions=instructions, items=input_items,
                                          conversation_key=f'rexclaw-{job}:{agent_id}')
        return {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}],
                'usage': {}}
    return complete


def _interim_text_messages(con, session, exclude_ids=None):
    """Rows appended AFTER the last response carried by the server-side chain.

    This is the cross-mode injection path: the session has a live
    previous_response_id from earlier text turns, then took voice-surface
    turns (which append rows but never touch the chain). Instead of breaking
    the chain and replaying everything, we pass previous_response_id plus
    these interim rows as new input items - the Responses API appends them
    to the stored conversation, preserving the chain and its prompt cache.

    Returns [] when chain_tail_sequence is 0 - no known baseline (a chain
    established before cross-mode support shipped, or no chain at all).
    Injecting without a baseline would duplicate content the chain already
    carries, which is worse than injecting nothing.
    """
    tail = session['chain_tail_sequence'] or 0
    if not tail:
        return []
    q = ("SELECT * FROM messages WHERE session_id = ? AND is_summarized_into IS NULL "
         "AND sequence > ?")
    params = [session['id'], tail]
    for mid in (exclude_ids or []):
        q += " AND id != ?"
        params.append(mid)
    q += " ORDER BY sequence ASC, id ASC"
    rows = con.execute(q, params).fetchall()
    if not rows:
        return []
    return _text_input_items_from_rows(con, session, rows)


def _mark_chain_tail(con, session):
    """Record that every message row persisted so far is carried by the
    server-side response chain. Called after each successful /v1/responses
    leg has had its outputs persisted; rows created later (native tool
    results not yet fed back, or voice-surface turns) stay above the mark
    and get injected as interim input on the next chained text turn."""
    row = con.execute(
        "SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence DESC, id DESC LIMIT 1",
        (session['id'],),
    ).fetchone()
    store.update_session(con, session['id'],
                         chain_tail_sequence=row['sequence'] if row else 0)


def _agent_thumbnail_url(con, agent):
    """Picture beside the companion's chat bubbles: the avatar's portrait
    (portrait system), else the legacy per-companion chat thumbnail upload,
    else None (the UI falls back to an initial)."""
    if agent['avatar_id']:
        av = con.execute("SELECT vrm_path FROM avatars WHERE id = ?",
                         (agent['avatar_id'],)).fetchone()
        if av and av['vrm_path']:
            from . import portraits
            url = portraits.portrait_url(av['vrm_path'])
            if url:
                return url
    return agent['chat_thumbnail_path'] or None


def start_text_session(con, *, agent, resume_session=None):
    """Create or reactivate a text-mode session and return the bootstrap
    payload the browser needs to render history and submit its first turn."""
    if resume_session and resume_session['agent_id'] != agent['id']:
        agent = store.get_agent(con, resume_session['agent_id'])

    config = get_config(con)
    if not config['enabled']:
        raise UserError("Companions are currently disabled in Settings.")
    # A companion chatting on a local brain needs no xAI key.
    brain = voice_setups.text_brain_for(con, agent, config)
    if not config['xai_api_key'] and not (brain and not brain[0].uses_xai_key):
        raise UserError(
            "This companion chats on Grok, and no xAI API key is set. Add one in Settings, "
            "or give it a voice setup whose brain is another provider or a local model (Settings → Models & providers, "
            "then this companion's Voice setup) - its chat follows that brain.")

    if resume_session:
        resume_vals = {'state': 'draft', 'ended_at': None}
        # Cross-mode resume: a conversation born (or last active) on the
        # voice surface continues here as text. Voice sessions never chain
        # via previous_response_id, so the first text turn naturally takes
        # the fresh-chain path and replays the full local history —
        # including the voice transcript — via _replay_text_messages.
        if resume_session['mode'] != 'text':
            resume_vals['mode'] = 'text'
            resume_vals.update(_cross_mode_token_vals(config, resume_session, 'text'))
        store.update_session(con, resume_session['id'], **resume_vals)
        session = store.get_session(con, resume_session['id'])
    else:
        session = store.create_session(con, agent_id=agent['id'], mode='text')

    if resume_session:
        _note_resume_gap(con, session, agent)
        _note_resume_affection(con, session, agent)

    activate_vals = {'state': 'active', 'last_active_at': utcnow()}
    if not resume_session:
        activate_vals['started_at'] = utcnow()
    store.update_session(con, session['id'], **activate_vals)
    session = store.get_session(con, session['id'])

    mcp_entries = store.mcp_entries_for(con, agent['id'], surface='text')
    instructions = (
        _env_preamble(config)
        + _appearance_section(con, agent)
        + _render_prompt(agent)
        + _env_postamble(con, agent, mode='text')
    )

    transcript_messages = []
    transcript_truncated = False
    if resume_session:
        from . import heartbeat  # lazy: circular import
        # Full history for the UI — same feed voice mode paints from. The
        # is_summarized_into filter is a MODEL-side concern (what replays to
        # xAI); the user keeps seeing every message even after compaction.
        rows, transcript_truncated = _transcript_rows(
            con, session, limit=config['transcript_display_limit'] or 0)
        hb_cache = {}
        for m in rows:
            attachments = [
                {
                    'xai_file_id': a['xai_file_id'],
                    'filename': a['filename'],
                    'size_bytes': a['size_bytes'],
                    'mimetype': a['mimetype'],
                    'url': store.library_url(con, a['imagine_image_id']),
                }
                for a in store.attachments_for_message(con, m['id'])
            ]
            transcript_messages.append({
                'sequence': m['sequence'],
                'role': m['role'],
                'content': m['content'] or '',
                # Group-call attribution for voice turns resumed on the text
                # surface — lets the UI label who said what.
                'speaker': m['speaker'] or None,
                'tool_name': m['tool_name'],
                'tool_arguments_json': m['tool_arguments_json'],
                'tool_result_json': m['tool_result_json'],
                # The transcript renderer pairs tool_call/tool_result rows
                # by call id; without it, interleaved (parallel) tool rows
                # from the row's original surface render as split entries.
                'xai_call_id': m['xai_call_id'],
                'is_summary_rollup': bool(m['is_summary_rollup']),
                'attachments': attachments,
                # Display grouping for rows a silent heartbeat or an
                # incoming companion text wrote.
                'fold': heartbeat.transcript_tag(con, m, hb_cache),
            })
    con.commit()

    return {
        'session_id': session['id'],
        'mode': 'text',
        'prompt_stale': text_prompt_stale(con, session, agent),
        'agent': {
            'id': agent['id'],
            'name': agent['name'],
            'reasoning_effort': agent['reasoning_effort'],
            'chat_thumbnail_url': _agent_thumbnail_url(con, agent),
        },
        'instructions': instructions,
        'tools': _build_text_tools(
            con, agent,
            mcp_entries=mcp_entries,
            enable_web_search=bool(agent['enable_web_search']),
            enable_x_search=bool(agent['enable_x_search']),
            enable_code_execution=bool(agent['enable_code_execution']),
            enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']),
            enable_memory_tools=bool(agent['enable_memory_tools']),
            enable_affection_tool=(bool(agent['enable_affection_tool'])
                                   and session['origin'] != 'delegated'),
            enable_delegate_tool=(bool(agent['enable_delegate_tool'])
                                  and session['origin'] != 'delegated'),
            enable_local_tasks=bool(agent['enable_local_tasks']),
            enable_minecraft=(bool(agent['enable_minecraft'])
                              and session['origin'] != 'delegated'),
            enable_games=(bool(agent['enable_games'])
                          and session['origin'] != 'delegated'),
            enable_companion_texting=(bool(agent['enable_companion_texting'])
                                      and session['origin'] != 'delegated'),
            enable_voicemail=(bool(agent['enable_voicemail'])
                              and session['origin'] != 'delegated'),
            plugin_origin=session['origin'],
        ),
        'model': config['text_model'],
        'previous_response_id': session['previous_response_id'] or None,
        'last_response_at': session['last_response_at'] or None,
        'transcript': transcript_messages,
        'transcript_truncated': transcript_truncated,
        'total_input_tokens': session['total_input_tokens'] or 0,
        'total_output_tokens': session['total_output_tokens'] or 0,
        # A setup's brain: the meter shows the last request's size against
        # its 'Summarise at' ('request'); otherwise tokens spent since the
        # last summary against Settings' Grok text budget ('total').
        'budget': 'request' if brain else 'total',
        'summary_threshold_tokens': _request_budget(brain) if brain else config['summary_threshold_tokens_text'] or 0,
        'context_tokens': (session['context_tokens'] or _estimate_request_tokens(
            con, agent, 'text', _brain_text_items(con, session))) if brain else 0,
        'tokens_at_last_summary': session['tokens_at_last_summary'] or 0,
        'summary': session['summary'] or None,
        # Same as the voice start payload: an owed compaction is announced
        # on resume, not only after the next message.
        'needs_compaction': bool(session['needs_summary']),
    }


def _persist_text_message(con, session, *, role, content='', tool_name=None,
                          tool_arguments_json=None, tool_result_json=None,
                          xai_call_id=None, attachments=None):
    """Append one row to a text session, continuing the sequence high water."""
    msg_id = store.insert_message(
        con, session['id'],
        role=role,
        content=content or '',
        tool_name=tool_name,
        tool_arguments_json=tool_arguments_json,
        tool_result_json=tool_result_json,
        xai_call_id=xai_call_id,
    )
    for a in (attachments or []):
        if not a.get('xai_file_id'):
            continue
        # Coerce expires_at to an ISO string if it round-tripped as unix int.
        expires_at = a.get('expires_at')
        if isinstance(expires_at, (int, float)):
            expires_at = xai_client._normalize_xai_timestamp(expires_at)
        a = {**a, 'expires_at': expires_at}
        store.insert_attachment(con, msg_id, a)
    return msg_id


def _accrue_text_usage(con, session, usage):
    """Apply per-call usage from a Responses API response to the session
    totals + the spend counter. Token totals drive the summarization threshold."""
    if not isinstance(usage, dict):
        return
    new_in = int(usage.get('input_tokens') or 0)
    new_out = int(usage.get('output_tokens') or 0)
    in_details = usage.get('input_tokens_details')
    new_cached = int(in_details.get('cached_tokens') or 0) if isinstance(in_details, dict) else 0

    session = store.get_session(con, session['id'])
    store.update_session(
        con, session['id'],
        total_input_tokens=(session['total_input_tokens'] or 0) + new_in,
        total_output_tokens=(session['total_output_tokens'] or 0) + new_out,
        cached_input_tokens=(session['cached_input_tokens'] or 0) + new_cached,
    )
    store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))


def _measure_request(con, session, brain, usage):
    """Record a request to a setup's brain: its size for the budget meter,
    and the summary it owes once that reaches the brain's 'Summarise at'
    (setups.context_full). Returns the size, None when unmeasured."""
    tokens = voice_setups.request_tokens(usage)
    if not tokens:
        return None
    # The first request after a summary (floor -1) sets the floor.
    floor = tokens if session['context_floor'] < 0 else session['context_floor']
    vals = {'context_tokens': tokens, 'context_floor': floor}
    if voice_setups.context_full(brain[1], tokens, floor):
        vals['needs_summary'] = 1
    store.update_session(con, session['id'], **vals)
    return tokens


def _estimate_request_tokens(con, agent, mode, items, voice_prompt=''):
    """Roughly how big the next request to a setup's brain will be — the
    budget meter's figure when nothing has been measured since the last
    summary: prompt and tools (the companion editor's estimates) plus the
    conversation."""
    counts = preview_token_counts(con, agent, voice_prompt)
    base = (counts['voice_prompt'] + counts['voice_tools'] if mode == 'voice'
            else counts['text_prompt'] + counts['text_tools'])
    return base + _approx_tokens(json.dumps(items, ensure_ascii=False), 4.0)


def _request_budget(brain):
    """The budget meter's limit for a setup's brain: its 'Summarise at'."""
    return int(brain[1].get('compact_at') or 0)


def _session_brain(con, session, config):
    """(LlmEngine class, settings) of the voice setup brain this session's
    conversation runs on — calls on a setup, text chat on its brain
    (setups.text_brain_for), a delegated task on delegate_brain — else
    None: the app's Grok."""
    agent = store.get_agent(con, session['agent_id']) if session['agent_id'] else None
    if agent is None:
        return None
    if session['origin'] == 'delegated':
        return delegate_brain(con, agent, config)
    if session['mode'] == 'voice':
        setup = voice_setups.for_agent(con, agent, config)
        return setup.stages['llm'] if setup else None
    return voice_setups.text_brain_for(con, agent, config)


def _on_setup_budget(con, session, config):
    """True when this session's conversation runs on a voice setup's brain,
    whose own 'Summarise at' size decides when to summarise
    (setups.context_full, checked as each request comes back) instead of
    Settings' Grok budgets. A speech-to-speech call (setup.realtime) too:
    the browser reports each reply's size and append_messages measures it
    against the realtime model's own 'Summarise at'."""
    return _session_brain(con, session, config) is not None


def _call_realtime(con, session, config):
    """(RealtimeEngine class, settings) when this session's calls run on a
    speech-to-speech setup, else None."""
    if session['mode'] != 'voice' or session['origin'] == 'delegated' or not session['agent_id']:
        return None
    agent = store.get_agent(con, session['agent_id'])
    setup = voice_setups.for_agent(con, agent, config) if agent else None
    return setup.realtime if setup else None


def _maybe_flag_summary_text(con, session):
    """Threshold check for text mode. Sets needs_summary when the configured
    text threshold has been crossed since the last rollup."""
    session = store.get_session(con, session['id'])
    config = get_config(con)
    threshold = config['summary_threshold_tokens_text'] or 0
    if not threshold:
        return False
    current = (session['total_input_tokens'] or 0) + (session['total_output_tokens'] or 0)
    delta = current - (session['tokens_at_last_summary'] or 0)
    if session['needs_summary']:
        return False
    if delta >= threshold:
        store.update_session(con, session['id'], needs_summary=1)
        return True
    return False


_AGENT_EFFORT = object()   # text_send_turn sentinel: use the agent's reasoning_effort


def _text_instructions(con, config, agent, stable=False, clock_at_end=False):
    """The system prompt a text turn sends when it opens a response chain.
    `stable=True` renders the change-detection variant: identical text with
    the volatile bits (clock, affection snapshot) masked. `clock_at_end`:
    see _env_preamble."""
    return (
        _env_preamble(config, stable=stable, clock_at_end=clock_at_end)
        + _appearance_section(con, agent)
        + _render_prompt(agent)
        + _env_postamble(con, agent, mode='text', stable=stable)
    )


def _instructions_hash(con, config, agent):
    """Fingerprint of the prompt a fresh text chain would carry, over the
    stable render so only real changes (persona, prompt text, core
    memories, settings) move it."""
    import hashlib
    stable = _text_instructions(con, config, agent, stable=True)
    return hashlib.sha256(stable.encode('utf-8')).hexdigest()


def text_prompt_stale(con, session, agent, config=None):
    """True when the session rides a live Responses chain whose system
    prompt no longer matches what a fresh chain would send — persona or
    prompt edits, new memories. xAI carries the chain's original
    instructions forward (they can't be re-sent alongside
    previous_response_id), so the chat won't see the change until the
    chain breaks; the UI offers a manual refresh instead of breaking it
    automatically, which would pay full-replay tokens on every memory
    write. A chain with no recorded hash (pre-feature) counts as stale."""
    if not session['previous_response_id']:
        return False
    config = config if config is not None else get_config(con)
    return session['chain_instructions_hash'] != _instructions_hash(con, config, agent)


def text_send_turn(con, *, session, user_text=None, attachment_file_ids=None,
                   extra_content_blocks=None, tool_results=None, headless=False,
                   suppress_companion_text=False, companion_text_max_calls=None,
                   minimal_tools=False,
                   model=None, reasoning_effort=_AGENT_EFFORT, quick=False):
    """Drive one or more /v1/responses legs until the assistant returns plain
    text or needs the browser. Server-side function tools (imagine + memory +
    delegate) execute inline; TEXT_BROWSER_TOOL_NAMES calls return a
    'browser_tools' payload instead - the client dispatches them and feeds
    the outputs back via /tool_results, which re-enters this function with
    `tool_results` set (native outputs parked at the split ride along via
    pending_native_outputs_json). MCP tools are entirely server-side at xAI;
    they appear in the response output for diagnostics only.
    `extra_content_blocks` lets a server-side caller (delegate_task) append
    resolved input_image / input_file blocks to the first leg's user
    content. `model` / `reasoning_effort` override the configured text model
    and the agent's effort for this turn (delegate_task's fast-model path —
    pass reasoning_effort=None for a non-reasoning model). `quick` runs a
    setup brain on its quick model instead (quick_brain - delegate_task's
    'fast' on the companion's own brain).
    `suppress_companion_text` is companion_texting's recursion guard: set
    for the one turn where this session is replying to an incoming
    companion text, so it can never itself initiate one back — this is
    what actually bounds a text_companion exchange, independent of the
    count below. `companion_text_max_calls` bounds how many text_companion
    calls THIS turn may make in total (None = unlimited, the default for
    live calls/chats — sending several different companions a message in
    one turn is fine; heartbeat.py passes an explicit per-row cap, or 0 to
    disable the tool entirely for a turn that doesn't allow it)."""
    if session['state'] != 'active':
        raise ValidationError("Session is not active.")
    if session['mode'] != 'text':
        raise ValidationError("Session is not a text-mode session.")

    config = get_config(con)
    agent = store.get_agent(con, session['agent_id'])
    # A companion whose text chat follows its voice setup's brain
    # (setups.text_brain_for); a delegated task runs on delegate_brain - the
    # companion's own brain when its provider searches and runs code, else
    # Grok. Callers pinning a model (delegate_task's fast model) stay on
    # the app's Grok.
    brain = None
    if model is None:
        brain = (delegate_brain(con, agent, config) if session['origin'] == 'delegated'
                 else voice_setups.text_brain_for(con, agent, config))
        if quick and brain is not None and not brain[0].uses_xai_key:
            brain = quick_brain(brain)
    # A setup's brain, xAI's or not, is summarised at its own size
    # (setups.context_full), not at the Grok text budget.
    setup_brain = brain
    context_tokens = None
    if brain is not None and brain[0].uses_xai_key:
        # An xAI brain keeps everything text chat has — the stored chain,
        # web/X search, MCP; only the model and effort come from the setup.
        model = brain[1].get('model') or None
        reasoning_effort = brain[1].get('reasoning_effort') or None
        brain = None
    xai_key = config['xai_api_key']
    if not xai_key and brain is None:
        raise UserError("xAI API key is not configured.")

    # Persist the user message + attachments on the FIRST leg only.
    user_msg_id = None
    if user_text is not None:
        if session['pending_native_outputs_json']:
            store.update_session(con, session['id'], pending_native_outputs_json=None)
        attachment_data = []
        for entry in (attachment_file_ids or []):
            if isinstance(entry, str):
                attachment_data.append({'xai_file_id': entry, 'filename': entry})
            elif isinstance(entry, dict) and entry.get('xai_file_id'):
                attachment_data.append(entry)
        user_msg_id = _persist_text_message(
            con, session,
            role='user',
            content=user_text or '',
            attachments=attachment_data,
        )

    # Chain via previous_response_id when available; xAI retains stored
    # responses for ~30 days — drop a stale chain and rebuild from local rows.
    previous_response_id = session['previous_response_id'] or None
    if previous_response_id and session['last_response_at']:
        last_at = parse_dt(session['last_response_at'])
        if last_at and datetime.utcnow() - last_at > timedelta(days=29):
            previous_response_id = None

    # minimal_tools strips the whole ordinary tool belt for this turn —
    # companion texting is the one exception, since it has its own toggle
    # and is the point of the turns that use it (heartbeats; see
    # heartbeats.tools_enabled). MCP servers go too: a background tick has
    # no business reaching outside.
    mcp_entries = ([] if minimal_tools
                   else store.mcp_entries_for(con, agent['id'], surface='text'))
    tools = _build_text_tools(
        con, agent,
        mcp_entries=mcp_entries,
        enable_web_search=bool(agent['enable_web_search']) and not minimal_tools,
        enable_x_search=bool(agent['enable_x_search']) and not minimal_tools,
        enable_code_execution=bool(agent['enable_code_execution']) and not minimal_tools,
        enable_grok_imagine_tools=bool(agent['enable_grok_imagine_tools']) and not minimal_tools,
        enable_memory_tools=bool(agent['enable_memory_tools']) and not minimal_tools,
        # The delegated analyst speaks with the companion's voice but not its
        # heart — background task sessions must not move the affection score.
        enable_affection_tool=(bool(agent['enable_affection_tool'])
                               and session['origin'] != 'delegated'
                               and not minimal_tools),
        # Recursion guard: a delegated task session must never delegate
        # further — one level of background work, no self-spawning chains.
        enable_delegate_tool=(bool(agent['enable_delegate_tool'])
                              and session['origin'] != 'delegated'
                              and not minimal_tools),
        # Deliberately NOT origin-guarded: the Grok Build CLI cannot call
        # back into rexclaw, so voice → delegate_task → local_task chains
        # are safe and let the deep-focus brain drive on-machine work.
        enable_local_tasks=bool(agent['enable_local_tasks']) and not minimal_tools,
        # The delegated analyst must not steer the game bot — directing it
        # is the companion's own job (same spirit as the delegate guard).
        enable_minecraft=(bool(agent['enable_minecraft'])
                          and session['origin'] != 'delegated'
                          and not minimal_tools),
        # Same guard: the companion plays, not its hidden analyst.
        enable_games=(bool(agent['enable_games'])
                      and session['origin'] != 'delegated'
                      and not minimal_tools),
        # A recording is for the user to hear; the hidden analyst's session
        # is one they never see.
        enable_voicemail=(bool(agent['enable_voicemail'])
                          and session['origin'] != 'delegated'
                          and not minimal_tools),
        # Recursion guard: a companion replying to an incoming companion
        # text must not immediately text back — see companion_texting.
        # companion_text_max_calls == 0 fully disables it for a turn that
        # doesn't allow it at all (e.g. a heartbeat with the row-level
        # toggle off); the actual per-call counting happens in the
        # dispatch loop below, since this tool list is fixed for every
        # leg of this call.
        enable_companion_texting=(bool(agent['enable_companion_texting'])
                                  and session['origin'] != 'delegated'
                                  and not suppress_companion_text
                                  and companion_text_max_calls != 0),
        # Headless turns (delegate task sessions) have no browser to answer
        # a browser_tools round-trip — don't offer the screen tools there.
        enable_browser_tools=not headless,
        plugin_origin=None if minimal_tools else session['origin'],
    )
    instructions = _text_instructions(con, config, agent, clock_at_end=brain is not None)
    instructions_hash = _instructions_hash(con, config, agent)

    pending_outputs = []
    if tool_results is not None:
        # Browser round-trip continuation: persist the browser results,
        # merge any native outputs parked when the turn split, and feed
        # them all to the next leg as function_call_output items.
        if session['pending_native_outputs_json']:
            try:
                pending_outputs.extend(json.loads(session['pending_native_outputs_json']))
            except Exception:
                _logger.exception('Discarding unparseable pending native outputs '
                                  'for session %s', session['id'])
            store.update_session(con, session['id'], pending_native_outputs_json=None)
        for r in tool_results:
            if not isinstance(r, dict) or not r.get('call_id'):
                continue
            output = r.get('output')
            output_str = output if isinstance(output, str) else json.dumps(output or {}, default=str)
            _persist_text_message(
                con, session,
                role='tool_result',
                content=output_str,
                tool_name=r.get('name'),
                tool_result_json=output_str,
                xai_call_id=r['call_id'],
            )
            pending_outputs.append({
                'type': 'function_call_output',
                'call_id': r['call_id'],
                'output': output_str,
            })
    is_first_leg = True
    max_iterations = 8
    accumulated_native_echo = []
    accumulated_mcp_results_echo = []
    # Files a setup brain's code sandbox made this turn, saved to the library
    # and attached to the reply (_save_brain_files).
    accumulated_files = []
    # Legs that spoke: a tool-calling turn can say something BEFORE or
    # BETWEEN tool calls, not just in the final leg — accumulate so the
    # value this function returns reflects everything actually said this
    # turn, not just the last leg (which is often silent once its only
    # job was to react to a tool result).
    accumulated_assistant_text_parts = []
    mcp_dropped = False
    max_searches = config['text_max_searches']   # 0 = no search watchdog
    # The cap that cut this turn's search loop (0 = not cut) — surfaced on
    # the returned turn so chat, heartbeats and companion texts can say the
    # reply was written without searching.
    search_capped = 0
    # companion_text_max_calls enforcement: `tools` above is fixed for
    # every leg of this call, so nothing else stops the model calling
    # text_companion repeatedly across legs/in parallel within one turn.
    # Live calls/chats pass None (unlimited) here and are unaffected;
    # heartbeat.py is the caller that passes a real number.
    companion_texts_sent = 0

    while max_iterations > 0:
        max_iterations -= 1

        chain_alive = bool(previous_response_id)

        input_items = []
        if is_first_leg and not chain_alive:
            # Exclude the just-persisted user row — it's appended explicitly
            # below (with attachments); replaying it too would double it.
            input_items.extend(_replay_text_messages(
                con, session,
                exclude_ids=[user_msg_id] if user_msg_id is not None else None,
            ))
        elif is_first_leg and chain_alive and user_text is not None:
            # Chain-preserving cross-mode catch-up: rows appended since the
            # chain's last response (voice-surface turns, unsent tool notes)
            # are injected as new input items on top of previous_response_id
            # instead of breaking the chain and replaying everything.
            session = store.get_session(con, session['id'])
            input_items.extend(_interim_text_messages(
                con, session,
                exclude_ids=[user_msg_id] if user_msg_id is not None else None,
            ))
        if pending_outputs:
            input_items.extend(pending_outputs)
            pending_outputs = []
        if is_first_leg and user_text is not None:
            content = [{'type': 'input_text', 'text': user_text or ''}]
            library_refs = []
            for entry in (attachment_file_ids or []):
                file_id = entry if isinstance(entry, str) else (
                    entry.get('xai_file_id') if isinstance(entry, dict) else None
                )
                if file_id and not file_id.startswith(LOCAL_FILE_PREFIX):
                    content.append({'type': 'input_file', 'file_id': file_id})
                if isinstance(entry, dict) and entry.get('imagine_image_id'):
                    mt = entry.get('mimetype') or ''
                    label = ('image' if mt.startswith('image/')
                             else 'video' if mt.startswith('video/')
                             else 'document')
                    library_refs.append(
                        f'"{entry.get("filename") or "file"}" = '
                        f'imagine_image_id {entry["imagine_image_id"]} ({label})'
                    )
            if library_refs:
                # Every upload was copied into the files library at upload
                # time; hand the model the refs — they never expire (the
                # server re-uploads from its copy when the xAI id lapses)
                # and they are the ONLY refs the imagine tools accept.
                content.append({'type': 'input_text', 'text': (
                    '[Attached file(s) saved to the files library: '
                    + '; '.join(library_refs)
                    + '. Images: pass the imagine_image_id in create_image '
                      'source_images to edit/restyle, or create_video '
                      'source_image / reference_images to animate. Videos: '
                      'pass it as create_video edit_video to modify or '
                      'extend_video to continue. Any file: pass the '
                      'imagine_image_id to delegate_task files to '
                      'read/analyze it - library refs stay valid forever, '
                      'unlike file_… ids. Never pass a file_… id to the '
                      'imagine tools.]'
                )})
            # Caller-supplied blocks (delegate_task file refs: input_image
            # data URIs / input_file ids resolved server-side).
            if extra_content_blocks:
                content.extend(extra_content_blocks)
            input_items.append({'role': 'user', 'content': content})

        if not input_items and not chain_alive:
            con.commit()
            return {'type': 'error', 'message': 'No input to send.'}

        # Release the write lock before the LLM round-trip. Rows persisted so
        # far this turn (user message, prior-leg tool results) go durable now;
        # an open transaction here would block every other writer — voice
        # session starts, transcript appends — for the whole generation.
        con.commit()

        try:
            if brain is not None:
                # The last leg writes the reply: no tools offered on it.
                body = _brain_leg(con, config, session, agent, brain, instructions,
                                  [] if max_iterations == 0 else tools)
            else:
                body = xai_client.create_response(
                    xai_api_key=xai_key,
                    responses_url=config['xai_responses_url'],
                    model=model or config['text_model'],
                    input_items=input_items,
                    instructions=None if chain_alive else instructions,
                    tools=tools,
                    # The last leg writes the reply. A turn that spent every leg
                    # on tool calls ended without one — companion-text replies
                    # filing memories until the cap left the sender with "had
                    # nothing to say back" — and the final leg's calls ran with
                    # their results never read.
                    tool_choice='none' if max_iterations == 0 else None,
                    reasoning_effort=((agent['reasoning_effort'] or 'low')
                                      if reasoning_effort is _AGENT_EFFORT else reasoning_effort),
                    previous_response_id=previous_response_id,
                    prompt_cache_key=f'rexclaw:{agent["id"]}',
                    # Caps xAI's own loop inside this one leg — max_iterations
                    # above only counts our function-call legs. max_turns is
                    # xAI's cap across all its tools but isn't enforced for web
                    # search, so the stream watchdog (max_search_calls) is the
                    # real cap on searching — see the config schema comment.
                    max_turns=config['xai_max_turns'] or None,   # 0 = not sent
                    max_search_calls=max_searches or None,
                    # Streamed from xAI and folded back into the plain body (see
                    # xai_client._post_stream) — nothing downstream changes. A
                    # long reasoning leg is otherwise one silent connection for
                    # the whole generation, the same shape that got the
                    # summariser cut off unanswered at ~60 s; events keep bytes
                    # flowing. Also xAI's own advice for agentic tool calling.
                    # A drop mid-stream retries the leg (tokens, not tool
                    # side-effects: tools only run once the body is complete).
                    stream=True,
                )
        except xai_client.SearchLimitExceeded as e:
            # xAI's own search loop ran past the cap and the stream was
            # closed, cancelling the response — nothing of it is stored, so
            # the chain still ends at previous_response_id. Retry this leg
            # once without the search tools so the reply still gets written,
            # from what the conversation already holds; code and MCP stay.
            # No search tools remain, so this can't fire twice.
            _logger.warning('Search cap hit for session %s (%s); '
                            'retrying the leg without web/X search',
                            session['id'], e)
            search_capped = max_searches
            tools = [t for t in tools if t.get('type') not in ('web_search', 'x_search')]
            # Same re-queue as the MCP retry below: this leg's
            # function_call_outputs must reach the retry.
            pending_outputs = [
                i for i in input_items
                if isinstance(i, dict) and i.get('type') == 'function_call_output'
            ]
            max_iterations += 1   # a retry, not a leg
            continue
        except UserError as e:
            # An unreachable remote MCP server 400s the WHOLE responses call
            # ("Failed to connect to MCP server <url>"), unlike voice mode
            # where the realtime session simply continues without that
            # server's tools. Mirror voice's tolerance: drop the MCP entries
            # and retry this leg once so one broken connection can't block
            # the conversation. A visible tool-result note is persisted so
            # both the user and the model know MCP was skipped this turn.
            # xAI words MCP-connection failures differently per failure kind:
            # unreachable host vs unresolvable/invalid server_url ("cannot
            # resolve Server URL", invalid-argument 400). Either way the fix
            # is the same — drop MCP and retry.
            # A setup brain's provider (OpenAI, Claude) words it its own
            # way; any failure naming MCP gets the same one retry.
            if (not mcp_dropped and mcp_entries
                    and ('Failed to connect to MCP server' in str(e)
                         or 'cannot resolve Server URL' in str(e)
                         or (brain is not None and 'mcp' in str(e).lower()))):
                _logger.warning(
                    'MCP server unreachable for session %s; retrying turn '
                    'without MCP tools: %s', session['id'], e)
                mcp_dropped = True
                tools = [t for t in tools if t.get('type') != 'mcp']
                # No transcript note — the response carries an
                # `mcp_unavailable` flag instead, which the frontend surfaces
                # as a once-per-session toast (a note row per turn would spam
                # the transcript for as long as the server stays down).
                # Re-queue any function_call_outputs this leg consumed into
                # input_items so the retry doesn't drop them.
                pending_outputs = [
                    i for i in input_items
                    if isinstance(i, dict) and i.get('type') == 'function_call_output'
                ]
                # A one-shot retry, not a leg: give the iteration back so
                # the last leg is still the one that writes the reply.
                max_iterations += 1
                continue
            if brain is None and chain_alive and is_first_leg:
                # The chain can be rejected server-side — response id expired
                # or purged before our 29-day cutoff, or the chained endpoint
                # refusing the injected cross-mode input. The client wraps
                # every HTTP failure in UserError, so the chain fallback has
                # to live here too. Degrade to the fresh-chain path: break
                # the chain and retry this leg once via full local replay
                # (is_first_leg is still True, and chain_alive recomputes
                # False on the next iteration).
                _logger.warning(
                    'Chained Responses call failed for session %s (%s); '
                    'breaking chain and retrying via full replay.',
                    session['id'], e,
                )
                previous_response_id = None
                store.update_session(con, session['id'],
                                     previous_response_id=None,
                                     last_response_at=None,
                                     chain_tail_sequence=0)
                max_iterations += 1   # a retry, not a leg (see the MCP one)
                continue
            con.commit()
            raise
        except Exception as e:
            # (A voice-setup brain has no chain: its failure is just a failure.)
            if brain is None and chain_alive and is_first_leg:
                # Same chain fallback for transport-level failures (timeouts,
                # connection resets) that don't surface as UserError.
                _logger.warning(
                    'Chained Responses call failed for session %s (%s); '
                    'breaking chain and retrying via full replay.',
                    session['id'], e,
                )
                previous_response_id = None
                store.update_session(con, session['id'],
                                     previous_response_id=None,
                                     last_response_at=None,
                                     chain_tail_sequence=0)
                max_iterations += 1   # a retry, not a leg (see the MCP one)
                continue
            con.commit()
            _logger.exception('Responses API call failed')
            raise UserError(f"Text chat request failed: {e}")

        is_first_leg = False

        response_id = body.get('id') or None
        usage = body.get('usage') or {}
        _accrue_text_usage(con, session, usage)
        if setup_brain is not None:
            context_tokens = _measure_request(con, session, setup_brain, usage) or context_tokens

        if response_id:
            vals = {'previous_response_id': response_id, 'last_response_at': utcnow()}
            if not chain_alive:
                # This leg opened the chain, so `instructions` is the prompt
                # xAI will carry forward on it.
                vals['chain_instructions_hash'] = instructions_hash
            store.update_session(con, session['id'], **vals)
            previous_response_id = response_id

        output = body.get('output') or []
        assistant_text_chunks = []
        function_calls = []
        mcp_results_echo = []
        made_files = []
        incomplete_reason = None
        if isinstance(body.get('incomplete_details'), dict):
            incomplete_reason = body['incomplete_details'].get('reason')

        for item in output:
            if not isinstance(item, dict):
                continue
            itype = item.get('type')
            if itype == 'message':
                for part in (item.get('content') or []):
                    if isinstance(part, dict) and part.get('type') == 'output_text':
                        text = part.get('text')
                        if text:
                            assistant_text_chunks.append(text)
            elif itype == 'function_call':
                function_calls.append({
                    'call_id': item.get('call_id'),
                    'name': item.get('name'),
                    'arguments': item.get('arguments') or '{}',
                })
            elif itype == 'brain_file' and brain is not None:
                made_files.append(item['file_id'])
            elif itype == 'mcp_call':
                # Server-side MCP execution at xAI: persist the call+result
                # rows so MCP failures are visible in the transcript.
                mcp_call_id = item.get('id') or item.get('call_id')
                mcp_name = item.get('name') or 'mcp'
                mcp_args = item.get('arguments') or ''
                mcp_status = item.get('status')
                mcp_error = item.get('error')
                mcp_output = item.get('output') or ''
                if mcp_status == 'failed' or mcp_error:
                    err = mcp_error if isinstance(mcp_error, dict) else {}
                    err_type = err.get('type') or 'failed'
                    err_msg = err.get('message') or (str(mcp_error) if mcp_error else '')
                    result_content = f"{err_type}: {err_msg}" if err_msg else err_type
                else:
                    result_content = mcp_output or 'ok'
                _persist_text_message(
                    con, session,
                    role='tool_call',
                    content=f"{mcp_name}({mcp_args})",
                    tool_name=mcp_name,
                    tool_arguments_json=mcp_args,
                    xai_call_id=mcp_call_id,
                )
                _persist_text_message(
                    con, session,
                    role='tool_result',
                    content=result_content,
                    tool_name=mcp_name,
                    tool_result_json=result_content,
                    xai_call_id=mcp_call_id,
                )
                mcp_results_echo.append({
                    'call_id': mcp_call_id,
                    'name': mcp_name,
                    'arguments': mcp_args,
                    'output': result_content,
                })

        assistant_text = ''.join(assistant_text_chunks).strip()
        made = _save_brain_files(con, session, agent, brain, made_files) if made_files else []
        if assistant_text or made:
            # Files ride on the reply that made them, like a user's upload
            # on their message (an empty reply still carries them).
            _persist_text_message(con, session, role='assistant', content=assistant_text, attachments=made)
            accumulated_files.extend(made)
        if assistant_text:
            fresh = store.get_session(con, session['id'])
            if not fresh['title_generated']:
                maybe_generate_session_title(con, fresh)
            accumulated_assistant_text_parts.append(assistant_text)
        # From here on `assistant_text` is what this call reports back for
        # the WHOLE turn so far, not just this leg — a later leg that only
        # reacts to a tool result (and says nothing further) must not erase
        # words an earlier leg already said.
        assistant_text = '\n\n'.join(accumulated_assistant_text_parts)

        # Everything persisted so far (input we sent + this response's own
        # message/MCP rows) is now carried by the stored chain — advance the
        # tail so the next chained turn doesn't re-inject it. Tool rows the
        # loop persists below stay above the tail until the next leg's mark
        # covers them (their outputs aren't in-chain until actually fed back).
        if response_id:
            _mark_chain_tail(con, session)

        accumulated_mcp_results_echo.extend(mcp_results_echo)

        if not function_calls:
            if setup_brain is None:
                _maybe_flag_summary_text(con, session)
            fresh = store.get_session(con, session['id'])
            con.commit()
            return {
                'type': 'complete',
                'response_id': response_id,
                'assistant_text': assistant_text,
                'mcp_results': accumulated_mcp_results_echo,
                'files': accumulated_files,
                'native_results': accumulated_native_echo,
                'incomplete_reason': incomplete_reason,
                'usage': usage,
                # Setup brains: the last request's size, for the meter.
                'context_tokens': context_tokens,
                # Recomputed after the turn: a memory the model just wrote
                # changes the prompt a fresh chain would carry.
                'prompt_stale': text_prompt_stale(con, fresh, agent, config),
                'cap_warning': False,
                'cap_exceeded': False,
                'needs_compaction': bool(fresh['needs_summary']),
                'mcp_unavailable': mcp_dropped,
                'search_capped': search_capped,
            }

        # Split: TEXT_BROWSER_TOOL_NAMES round-trip through the client;
        # everything else executes server-side. tool_call rows persist for
        # ALL calls in arrival order; browser results are persisted by the
        # /tool_results continuation.
        for fc in function_calls:
            _persist_text_message(
                con, session,
                role='tool_call',
                content=f"{fc.get('name')}({fc.get('arguments') or ''})",
                tool_name=fc.get('name'),
                tool_arguments_json=fc.get('arguments') or '',
                xai_call_id=fc.get('call_id'),
            )
        # Headless turns route everything through the native path — a
        # browser-named call there (shouldn't happen; the tools aren't
        # offered) falls through to the unknown-tool error instead of
        # returning a browser_tools payload nobody can answer.
        native_calls = [fc for fc in function_calls
                        if headless or (fc.get('name') or '') not in TEXT_BROWSER_TOOL_NAMES]
        browser_calls = [] if headless else [
            fc for fc in function_calls
            if (fc.get('name') or '') in TEXT_BROWSER_TOOL_NAMES]
        native_outputs = []
        for fc in native_calls:
            call_id = fc.get('call_id')
            name = fc.get('name')
            try:
                args = json.loads(fc.get('arguments') or '{}')
            except Exception:
                args = {}
            if name in imagine_tools.IMAGINE_TOOL_NAMES:
                result = imagine_tools.execute_imagine_tool(con, session, name, args)
            elif name in memory_tools.MEMORY_TOOL_NAMES:
                if not agent['enable_memory_tools']:
                    result = {'ok': False, 'reason': 'tool_disabled',
                              'message': 'Memory tools are disabled on this agent.'}
                else:
                    result = memory_tools.execute_memory_tool(con, session, name, args)
            elif name in lore_tools.LORE_TOOL_NAMES:
                if not agent['enable_lore_tool']:
                    result = {'ok': False, 'reason': 'tool_disabled',
                              'message': 'Lore stories are disabled on this companion.'}
                else:
                    result = lore_tools.execute_lore_tool(con, session, name, args)
            elif name in affection_tools.AFFECTION_TOOL_NAMES:
                if not agent['enable_affection_tool']:
                    result = {'ok': False, 'reason': 'tool_disabled',
                              'message': 'The affection meter is disabled on this companion.'}
                else:
                    result = affection_tools.execute_affection_tool(con, session, name, args)
            elif name == delegate_tools.DELEGATE_TOOL_NAME:
                # Flag + recursion checks live in the executor; it returns
                # {'error': ...} so the model gets a structured failure.
                result = delegate_tools.execute_delegate_tool(con, session, args)
            elif name == local_tools.LOCAL_TASK_TOOL_NAME:
                result = local_tools.execute_local_task(con, session, args)
            elif name == voicemail_tools.CREATE_VOICEMAIL_TOOL_NAME:
                result = voicemail_tools.execute_create_voicemail(con, session, agent, args)
            elif name in minecraft_tools.MINECRAFT_TOOL_NAMES:
                # Flag check lives in the executors (same {'error': ...} contract
                # as voice /session/{id}/tool_call).
                if name == minecraft_tools.MINECRAFT_COMMAND_TOOL_NAME:
                    result = minecraft_tools.execute_minecraft_command(
                        con, session, agent, args)
                else:
                    result = minecraft_tools.execute_minecraft_status(
                        con, session, agent, args)
            elif name in games.GAME_TOOL_NAMES:
                result = games.execute_tool(con, session, agent, name, args, 'text')
            elif name == companion_texting.TEXT_COMPANION_TOOL_NAME:
                # Flag + recursion checks live in the executor; it returns
                # {'error': ...} so the model gets a structured failure.
                # companion_text_max_calls enforcement (see
                # companion_texts_sent above): the tool stays offered for
                # the rest of THIS turn regardless of how many times it's
                # already been called, so enforce the ceiling here instead.
                if (companion_text_max_calls is not None
                        and companion_texts_sent >= companion_text_max_calls):
                    result = {'error': f'Reached the texting limit for this '
                                       f'heartbeat ({companion_text_max_calls} '
                                       f'exchange(s)) — wrap up for now.'}
                else:
                    result = companion_texting.execute_text_companion_tool(con, session, args)
                    if result.get('ok'):
                        companion_texts_sent += 1
            else:
                result = plugins.execute_tool(con, session, agent, name, args, 'text')
                if result is None:
                    result = {'error': f'Unknown tool: {name}'}
            output_str = json.dumps(result, default=str)
            _persist_text_message(
                con, session,
                role='tool_result',
                content=output_str,
                tool_name=name,
                tool_result_json=output_str,
                xai_call_id=call_id,
            )
            native_outputs.append({
                'type': 'function_call_output',
                'call_id': call_id,
                'output': output_str,
            })
            accumulated_native_echo.append({
                'call_id': call_id,
                'name': name,
                'arguments': fc.get('arguments') or '',
                'output': output_str,
            })

        if browser_calls:
            # Park this leg's native outputs; the /tool_results continuation
            # merges them with the browser results and feeds both back to
            # the next leg on the same response chain.
            store.update_session(
                con, session['id'],
                pending_native_outputs_json=(json.dumps(native_outputs)
                                             if native_outputs else None),
            )
            con.commit()
            return {
                'type': 'browser_tools',
                'response_id': response_id,
                'assistant_text': assistant_text,
                'tool_calls': [
                    {
                        'call_id': fc.get('call_id'),
                        'name': fc.get('name'),
                        'arguments': fc.get('arguments') or '',
                    }
                    for fc in browser_calls
                ],
                'mcp_results': accumulated_mcp_results_echo,
                'files': accumulated_files,
                'native_results': accumulated_native_echo,
                'usage': usage,
                'context_tokens': context_tokens,
                'cap_warning': False,
                'cap_exceeded': False,
                'mcp_unavailable': mcp_dropped,
                'search_capped': search_capped,
            }

        pending_outputs.extend(native_outputs)

    _logger.warning('text_send_turn iteration cap reached for session %s', session['id'])
    fresh = store.get_session(con, session['id'])
    con.commit()
    return {
        'type': 'complete',
        'response_id': previous_response_id,
        'assistant_text': '\n\n'.join(accumulated_assistant_text_parts),
        'mcp_results': accumulated_mcp_results_echo,
        'files': accumulated_files,
        'native_results': accumulated_native_echo,
        'incomplete_reason': 'tool_loop_cap',
        'usage': {},
        'cap_warning': False,
        'cap_exceeded': False,
        'needs_compaction': bool(fresh['needs_summary']),
        'mcp_unavailable': mcp_dropped,
        'search_capped': search_capped,
    }


def text_compact(con, session):
    """Roll up older text-mode turns into a single summary, then break the xAI
    response chain so the next turn re-seeds with the summary as input."""
    if session['state'] != 'active':
        return {'compacted': False, 'reason': 'session_not_active'}
    if session['mode'] != 'text':
        return {'compacted': False, 'reason': 'wrong_mode'}
    if not session['needs_summary']:
        return {'compacted': False, 'reason': 'no_pending_summary'}

    rollup_id = generate_session_summary(con, session)
    if not rollup_id:
        store.update_session(con, session['id'], needs_summary=0)
        con.commit()
        return {'compacted': False, 'reason': 'nothing_absorbed'}

    # Breaking the chain forces the next turn to re-seed via the replay path.
    store.update_session(con, session['id'],
                         previous_response_id=None, last_response_at=None,
                         chain_tail_sequence=0)
    con.commit()
    result = {'compacted': True, 'rollup_id': rollup_id}
    agent = store.get_agent(con, session['agent_id'])
    if voice_setups.text_brain_for(con, agent, get_config(con)) is not None:
        result['context_tokens'] = _estimate_request_tokens(
            con, agent, 'text', _brain_text_items(con, store.get_session(con, session['id'])))
    return result


def manual_compact(con, session):
    """Compact on demand from the Sessions tab, whether or not the token
    threshold was reached: same rollup as auto-compaction, which also resets
    the threshold count. A live voice call is refused — it holds its own
    context until it ends, and the replay path only reads the summary on the
    next resume."""
    if session['mode'] == 'voice' and session['state'] == 'active':
        raise UserError("End the call before compacting it.")
    store.update_session(con, session['id'], needs_summary=1)
    rollup_id = generate_session_summary(con, store.get_session(con, session['id']))
    if not rollup_id:
        store.update_session(con, session['id'], needs_summary=0)
        con.commit()
        return {'compacted': False, 'reason': 'nothing_absorbed'}
    if session['mode'] == 'text':
        # Same as text_compact: the xAI chain still carries the old history,
        # so break it and let the next turn re-seed from the new summary.
        store.update_session(con, session['id'],
                             previous_response_id=None, last_response_at=None,
                             chain_tail_sequence=0)
    con.commit()
    return {'compacted': True, 'summary': store.get_session(con, session['id'])['summary']}


# Chat attachment ids for files kept in the library only (never sent to
# xAI's Files API); the xAI turn path skips them.
LOCAL_FILE_PREFIX = 'local:'


def upload_text_attachment(con, *, session, filename, content_bytes, mimetype):
    """Server-side proxy for /v1/files, shared by both surfaces.

    Text mode: the browser hands the returned metadata back on the next
    /send call and the file rides the turn as input_file.
    Voice mode: the realtime model can't read files at all - the client
    injects a context note carrying the xai_file_id so the model can hand
    it to delegate_task for analysis.

    No attachment row is created here - text mode does that when /send
    persists the user message, so a file uploaded but never sent doesn't
    pollute the transcript."""
    if session['state'] != 'active':
        raise ValidationError("Session is not active.")
    config = get_config(con)
    xai_key = config['xai_api_key']
    max_bytes = 48 * 1024 * 1024  # xAI's per-file ceiling for chat
    if len(content_bytes) > max_bytes:
        raise UserError(f"File too large ({len(content_bytes)} bytes). Max is 48 MB.")
    agent = store.get_agent(con, session['agent_id'])
    brain = voice_setups.text_brain_for(con, agent, config)
    if not xai_key or (brain is not None and not brain[0].uses_xai_key):
        # A companion chatting on a local brain (or no xAI key at all): the
        # file stays here, in the library below — never uploaded to xAI. A
        # brain that sees gets images from there (_brain_text_items).
        result = {'file_id': f'{LOCAL_FILE_PREFIX}{uuid.uuid4().hex}', 'filename': filename or 'upload',
                  'expires_at': None, 'size_bytes': len(content_bytes), 'mimetype': mimetype}
    else:
        result = xai_client.upload_file(
            xai_api_key=xai_key,
            files_url=config['xai_files_url'],
            filename=filename,
            content_bytes=content_bytes,
            mimetype=mimetype,
            expires_after_seconds=config['file_default_expiry_seconds'] or 0,
        )
    # EVERY upload also lands in the files library (imagine_images, kind
    # 'upload'), whatever its type. The xai_file_id alone is (a) invisible
    # to the imagine tools — without a library row an image can never be
    # edited/animated later and a video can never go through edit_video /
    # extend_video — and (b) ephemeral: it expires server-side, while the
    # library row keeps the bytes and can transparently re-upload
    # (imagine_tools.ensure_xai_file). The upload's file id + expiry are
    # cached on the row so tools reuse it while it's still valid.
    # Ingestion failure must not break the upload; the file still works as
    # a plain chat attachment for this turn.
    try:
        mt = mimetype or 'application/octet-stream'
        fallback = ('Uploaded image' if mt.startswith('image/')
                    else 'Uploaded video' if mt.startswith('video/')
                    else 'Uploaded file')
        name = (filename or fallback).strip().replace('\n', ' ')[:80]
        ext = mimetypes.guess_extension(mt) or ''
        fname = f'imagine_{uuid.uuid4().hex}{ext}'
        (FILES_DIR / fname).write_bytes(content_bytes)
        image_path = f'/files/{fname}'
        cur = con.execute(
            """INSERT INTO imagine_images
                   (name, agent_id, session_id, kind, prompt, image_path,
                    mimetype, xai_model, created_at, xai_file_id,
                    xai_file_expires_at, xai_file_account)
               VALUES (?, ?, ?, 'upload', ?, ?, ?, NULL, ?, ?, ?, ?)""",
            (name or fallback, agent['id'], session['id'],
             name or fallback, image_path, mimetype, utcnow(),
             *((None, None, None) if result['file_id'].startswith(LOCAL_FILE_PREFIX)
               else (result.get('file_id'), result.get('expires_at'), xai_oauth.account(config)))),
        )
        result = dict(result, imagine_image_id=cur.lastrowid,
                      image_url=image_path)
    except Exception:
        _logger.exception('Files library ingestion failed for upload %r', filename)
    return result
