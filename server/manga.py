# Copyright 2026 Codemarchant
"""Manga Diary: an episode of a conversation retold as a manga page,
starring the companion.

The source is one EPISODE memory — the stretch of conversation a compaction
rolled up, with its verbatim turns stored inline — or the latest stretch no
episode covers yet. Never a whole session: a companion's continuous
conversation runs to thousands of messages over months, and a page is a
chapter, not the series.

The server writes the storyboard; the browser shoots it. The text model
reads the transcript and plans the panels — which moments, the shot and
angle, the companion's face and pose, which outfit from their wardrobe, the
balloons, a caption, a sound effect, and a scene/action description. The
browser then poses the live avatar for every panel, photographs it, inks
the photos into screentone art and letters the page (web/src/lib/manga_*.js).
Optionally Grok Imagine paints each panel's scene behind the live pose, or
the whole panel from the outfit's portrait (paint_panel). Only the finished
PNG, the painted art and the script come back here, so a page can be
re-shot later without paying for a new script.

The vocabularies below are the contract with the photoshoot: every enum
value has a meaning on the renderer side, and anything else the model
writes is replaced with the neutral choice rather than rejected.
"""
import base64
import json
import logging
import math
import uuid

from . import heartbeat, imagine_tools, store, xai_client
from .db import FILES_DIR, get_config, utcnow
from .errors import UserError
from .face_director import persona_excerpt

_logger = logging.getLogger(__name__)

SOURCES = ('episode', 'recent')
LAYOUTS = ('page', 'yonkoma')
STYLES = ('mono', 'color')
# photo: the live photoshoot only. scenes: Imagine paints each panel's
# setting and the live pose stands in it. illustrated: Imagine draws the
# whole panel from the outfit's portrait; a panel it can't draw falls back
# to the live photo.
ARTS = ('photo', 'scenes', 'illustrated')
SHOTS = ('closeup', 'bust', 'waist', 'full', 'wide')
ANGLES = ('front', 'left', 'right', 'low', 'high', 'dutch')
EMOTIONS = ('neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed')
# Held mid-clip for the photo, so only one-shot clips with a readable key
# pose — no loops (squats, push-ups), nothing that leaves the spot.
POSES = ('none', 'greeting', 'goodbye', 'peace_sign', 'thinking', 'clapping',
         'blow_kiss', 'jump', 'model_pose', 'shoot', 'look_around', 'sleepy',
         'show_full_body', 'spin')
# Manga symbols (漫符) drawn beside the head; the painters are the mood
# marks' (services/mood_marks.js) plus a heart.
MARKS = ('none', 'note', 'anger', 'exclaim', 'gloom', 'puff', 'sweat',
         'question', 'huff', 'steam', 'bulb', 'heart')
EFFECTS = ('none', 'focus', 'speed', 'sparkle', 'gloom', 'flowers')
SIZES = ('small', 'medium', 'large')
BALLOONS = ('speech', 'shout', 'thought', 'whisper')

PAGE_PANELS = (4, 6)
YONKOMA_PANELS = 4
MAX_LINES = 3
MAX_LINE_CHARS = 160
MAX_CAPTION_CHARS = 120
MAX_SFX_CHARS = 16
MAX_SCENE_CHARS = 220
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# The latest stretch no episode covers is bounded by the compaction
# threshold — unless compaction is off, when it is the whole history. Keep
# its most recent part, about the size of a large episode (the biggest
# stored episode ran to ~110k characters).
RECENT_MAX_CHARS = 120_000
ART_DIR = 'manga/art'
# Aspect ratios Grok Imagine is asked for (the set the video tools already
# use); each panel takes the nearest.
IMAGINE_ASPECTS = {'1:1': 1.0, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3,
                   '3:4': 3 / 4, '3:2': 3 / 2, '2:3': 2 / 3}

MANGA_INSTRUCTIONS = (
    'You are a manga storyboard artist. You adapt a real conversation between '
    'a user and their companion character into ONE manga page, and you reply '
    'with a JSON storyboard only.\n\n'
    'What to draw\n'
    '- Choose the moments that carry this stretch of conversation: a joke '
    'that landed, a confession, a small victory, a tease, a warm goodbye. '
    'Skip logistics and tool chatter.\n'
    '- Shape the page as kishotenketsu: set-up, development, twist, payoff. '
    'The last panel lands the page (a punchline, a reaction, a quiet beat).\n'
    '- Only what happened. Balloons quote or tightly condense real lines, in '
    'the speaker\'s own voice. Never invent events, facts or promises. '
    'Captions may bridge time ("Later that night...").\n'
    '- The companion is the star. The user is shown only where the '
    'user message says they can be (with_user); otherwise their lines are '
    'balloons from off-panel (who "user"). Any other speaker belongs in a '
    'caption.\n'
    '- Manga lettering is short: at most 18 words per balloon, at most '
    f'{MAX_LINES} balloons in a panel, and most panels need one or two.\n'
    '- Keep it safe for work: anything suggestive becomes a blush and a '
    'cut-away.\n\n'
    'Directing each panel (use the exact values listed)\n'
    f'- shot: {"|".join(SHOTS)}. closeup = the face fills the panel, for '
    'emotional peaks. bust = head and shoulders, the talking shot. waist = '
    'gestures. full = the whole body, for poses. wide = the character small '
    'in the scene, for establishing or lonely beats. Vary the shots; never '
    'the same one three panels running.\n'
    f'- angle: {"|".join(ANGLES)}. low = looking up (confidence, drama), '
    'high = looking down (smallness, sadness), dutch = tilted frame (tension, '
    'chaos). Mostly front, left or right.\n'
    f'- emotion: {"|".join(EMOTIONS)} - the companion\'s face.\n'
    f'- pose: {"|".join(POSES)}. A held body pose; "none" for most talking '
    'panels, at most two poses on the page, and only where the pose means '
    'something (a wave hello, a peace sign at a win, thinking at a question).\n'
    f'- mark: {"|".join(MARKS)}. A manga symbol by the head: note = cheerful, '
    'anger = the cross-shaped vein, exclaim = startled, gloom = dark cloud, '
    'puff = sigh, sweat = nervous drop, question = puzzled, huff = pout, '
    'steam = flustered, bulb = an idea, heart = smitten. Usually "none".\n'
    f'- effect: {"|".join(EFFECTS)}. focus = speed lines converging on the '
    'face (shock, realisation), speed = motion streaks, sparkle = shoujo '
    'sparkles, gloom = vertical shadow lines, flowers = blossoms of happiness. '
    'Usually "none"; one or two per page.\n'
    '- sfx: optional onomatopoeia painted into the art ("Ba-dump", "Gasp", '
    '"ドキッ"), short, empty on most panels.\n'
    '- caption: optional narration box text, short.\n'
    f'- size: {"|".join(SIZES)}. One "large" panel at most, for the '
    'climax. Ignored for a four-panel strip.\n'
    f'- lines: [{{"who": "companion"|"user", "text": "...", "style": '
    f'"{"|".join(BALLOONS)}"}}] in reading order. shout = spiky balloon, '
    'thought = cloud (unspoken), whisper = dashed.\n\n'
    'Wardrobe\n'
    '- outfit (page level): what the companion wears, by exact name from the '
    'Wardrobe list. Pick what fits what happened: an outfit the conversation '
    'shows them changing into, else one that suits the setting (sleepwear '
    'for a bedtime talk, swimwear at the beach, something smart for a night '
    'out), else the default outfit given. The page is safe for work: pick '
    'only an outfit that keeps them clothed, and where the conversation '
    'calls for less, stay with a clothed one.\n'
    '- outfit (panel level): "" to keep the page\'s, or a wardrobe name only '
    'where the conversation shows a change part-way through. Rare.\n\n'
    'Scene and action (they may be painted by an image generator)\n'
    '- scene: where the panel happens, for an illustrator, 8 to 25 words: '
    'place, time of day, props, light. Infer it from the conversation (they '
    'talked while the user cooked: a kitchen); when nothing implies a place, '
    'a cosy setting that fits the mood.\n'
    '- action: what the companion is visibly doing, 5 to 15 words ("leaning '
    'on the counter, laughing, holding a mug").\n'
    '- The image generator has a strict content filter. Describe only fully '
    'clothed, everyday, wholesome visuals: never bodies, underwear, nudity, '
    'people in bed, kissing or anything suggestive. Turn intimate moments '
    'into symbols (a blush, two mugs side by side, a sunset through a '
    'window). No real people, brands or logos.\n\n'
    'Pages\n'
    '- Draw the number of pages the user message asks for. Over several '
    'pages, spread the moments across them in the order they happened, and '
    'let each page still land on a beat (a small payoff, or a hook into the '
    'next page). A long chapter may slow down the way manga does: a big '
    'moment can take a whole page, a quiet one a row of reaction panels. '
    'But if the stretch cannot fill the pages without inventing events, '
    'draw fewer pages and end where the stretch ends. Give each page a '
    'short subtitle; a single page may leave it empty.\n'
    '- When pages from this stretch were drawn before, continue after them: '
    'pick up where the last one ended and never redraw a moment they show. '
    'If little remains, use fewer panels rather than inventing.\n\n'
    'Write every text field (title, subtitle, captions, lines, sfx) in the '
    'language the conversation was held in; write scene and action in '
    'English. Output exactly this JSON object and nothing else:\n'
    '{"title": "short chapter title", "outfit": "wardrobe name", "pages": '
    '[{"subtitle": "", "panels": [{"beat": "what this panel shows, one short '
    'line", "shot": "...", "angle": "...", "emotion": "...", "pose": "...", '
    '"mark": "...", "effect": "...", "sfx": "", "caption": "", "size": "...", '
    '"outfit": "", "scene": "...", "action": "...", "with_user": false, '
    '"user_emotion": "neutral", "user_outfit": "", "with": [], "lines": [...]}]}]}'
)
MAX_PAGES = 20   # a whole manga chapter
MAX_COMBINED = 12                # episodes read together for one chapter
COMBINED_MAX_CHARS = 300_000     # their transcripts together (~75k tokens)
SCRIPT_MAX_CHARS = 150_000       # a script the user pastes in

# Added to the user message when the source is the user's own script.
SCRIPT_NOTE = (
    'The source below is a script the user wrote, not a recorded '
    'conversation. Follow its events, order and dialogue: "only what '
    'happened" means only what the script says. Lines the script gives the '
    'companion are theirs, lines it gives the user are the user\'s, and '
    'anyone else speaks as a cast member or from a caption.\n'
)
MAX_CAST = 5   # other companions a page may show; a panel holds three of them at most

# Added to the user message when other companions may appear.
CAST_NOTE = (
    'Other companions who can appear (the cast):\n{cast}\n'
    'Put a cast member in the panels where they took part: "with": '
    '[{{"name": "<exact cast name>", "emotion": "<{emotions}>", "outfit": ""}}], '
    'at most three a panel. Their lines use their exact name as "who". Panels '
    'with more than one character are group shots: bust, waist, full or wide, '
    'never closeup. Leave "with" empty where only the companion (and maybe '
    'the user) is there, and never add a cast member the conversation does '
    'not involve. A cast member\'s "outfit" is "" for the one picked for them, '
    'or a name from their own wardrobe where the conversation shows them in '
    'something else (a scene change, a change of clothes); same rules as the '
    'companion\'s outfits, clothed only.\n'
)

# Added to the user message when the user has a likeness to draw.
WITH_USER_NOTE = (
    'The user can appear in person: set "with_user": true on the panels '
    'where they and the companion share the moment (two or three panels at '
    'most, the ones where being together matters) and give "user_emotion" '
    f'({"|".join(EMOTIONS)}). Those panels are two-shots, so use bust, '
    'waist, full or wide there, never closeup. Everywhere else "with_user" '
    'is false and the user stays off-panel.{wardrobe}\n'
)

# Prefix of every Imagine prompt. The storyboard already writes its scenes
# in clothed, everyday terms; this states the register once more at the
# image model itself.
SFW_FRAME = 'Wholesome, safe-for-work manga illustration; everyone is fully clothed. '
SHOT_WORDS = {
    'closeup': 'a close-up of the face', 'bust': 'a head-and-shoulders shot',
    'waist': 'a waist-up shot', 'full': 'a full-body shot',
    'wide': 'a wide shot, the character small in the scene',
}
ANGLE_WORDS = {'low': ', seen from a low angle', 'high': ', seen from above',
               'dutch': ', tilted camera'}
EMOTION_WORDS = {'neutral': 'calm', 'happy': 'happy, smiling', 'sad': 'sad',
                 'angry': 'annoyed', 'surprised': 'surprised', 'relaxed': 'relaxed, content'}


def _pick(value, allowed, default):
    value = str(value or '').strip().lower().replace(' ', '_').replace('-', '_')
    if value in allowed:
        return value
    # "close-up" → "closeup"
    return value.replace('_', '') if value.replace('_', '') in allowed else default


def _clip(value, limit):
    text = ' '.join(str(value or '').split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def _match_outfit(value, wardrobe):
    """A wardrobe name for `value` (case-insensitive), or ''. Without a
    wardrobe (re-saving a stored script) the name is kept as written."""
    name = _clip(value, 80)
    if wardrobe is None or not name:
        return name
    for w in wardrobe:
        if w.lower() == name.lower():
            return w
    return ''


def _art_url(value):
    url = str(value or '')
    return url if url.startswith(f'/files/{ART_DIR}/') and '..' not in url else ''


def normalize_script(raw, layout, wardrobe=None, default_outfit='', wardrobes=None):
    """Coerce the model's storyboard to the photoshoot contract: known enum
    values only, bounded text, the panel count the layout needs, outfits
    from the wardrobe (the companion's; `wardrobes` maps each cast name and
    'user' to theirs). Without wardrobes — re-saving a stored script —
    outfit names are kept as written. Returns None when nothing drawable
    survives."""
    if not isinstance(raw, dict):
        return None
    # The other companions this page may show, [{id, name, outfit}] — chosen
    # in the browser (outfit by name, '' = what they have on), carried by
    # the script so a re-shoot poses the same people in the same clothes.
    cast = []
    for c in raw.get('cast') or []:
        try:
            member = {'id': int(c['id']), 'name': _clip(c.get('name'), 60),
                      'outfit': _clip(c.get('outfit'), 80)}
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
        if member['name'] and all(m['id'] != member['id'] for m in cast):
            cast.append(member)
    cast = cast[:MAX_CAST]
    names = {m['name'].lower(): m['name'] for m in cast}
    panels = []
    for p in raw.get('panels') or []:
        if not isinstance(p, dict):
            continue
        lines = []
        for ln in p.get('lines') or []:
            if not isinstance(ln, dict):
                continue
            text = _clip(ln.get('text'), MAX_LINE_CHARS)
            if not text:
                continue
            said = str(ln.get('who') or '').strip()
            who = ('user' if said.lower() == 'user'
                   else names.get(said.lower(), 'companion'))
            lines.append({'who': who, 'text': text,
                          'style': _pick(ln.get('style'), BALLOONS, 'speech')})
        # Cast members standing in this panel (three at most), each with their face.
        present = []
        for w in p.get('with') or []:
            name = names.get(str((w.get('name') if isinstance(w, dict) else w) or '').strip().lower())
            if name and len(present) < 3 and all(x['name'] != name for x in present):
                present.append({'name': name, 'emotion': _pick(
                    w.get('emotion') if isinstance(w, dict) else None, EMOTIONS, 'neutral'),
                    # '' = the outfit picked for them in the cast.
                    'outfit': _match_outfit(w.get('outfit') if isinstance(w, dict) else '',
                                            None if wardrobes is None else wardrobes.get(name, []))})
        panels.append({
            'beat': _clip(p.get('beat'), 140),
            'shot': _pick(p.get('shot'), SHOTS, 'bust'),
            'angle': _pick(p.get('angle'), ANGLES, 'front'),
            'emotion': _pick(p.get('emotion'), EMOTIONS, 'neutral'),
            'pose': _pick(p.get('pose'), POSES, 'none'),
            'mark': _pick(p.get('mark'), MARKS, 'none'),
            'effect': _pick(p.get('effect'), EFFECTS, 'none'),
            'sfx': _clip(p.get('sfx'), MAX_SFX_CHARS),
            'caption': _clip(p.get('caption'), MAX_CAPTION_CHARS),
            'size': _pick(p.get('size'), SIZES, 'medium'),
            'outfit': _match_outfit(p.get('outfit'), wardrobe),
            'scene': _clip(p.get('scene'), MAX_SCENE_CHARS),
            'action': _clip(p.get('action'), MAX_SCENE_CHARS),
            # Imagine art already painted for this panel (paint_panel).
            'art_url': _art_url(p.get('art_url')),
            'with_user': p.get('with_user') is True,
            'user_emotion': _pick(p.get('user_emotion'), EMOTIONS, 'neutral'),
            # '' = the outfit set in Settings → "Your avatar".
            'user_outfit': _match_outfit(p.get('user_outfit'),
                                         None if wardrobes is None else wardrobes.get('user', [])),
            'with': present,
            'lines': lines[:MAX_LINES],
        })
        # A shot with anyone else in it can't be a face close-up.
        if (panels[-1]['with_user'] or present) and panels[-1]['shot'] == 'closeup':
            panels[-1]['shot'] = 'bust'
    if layout == 'yonkoma':
        panels = panels[:YONKOMA_PANELS]
        if len(panels) < YONKOMA_PANELS:
            return None
    else:
        panels = panels[:PAGE_PANELS[1]]
        if len(panels) < 3:
            return None
        # One climax at most: keep the first "large", demote the rest.
        seen_large = False
        for p in panels:
            if p['size'] == 'large':
                if seen_large:
                    p['size'] = 'medium'
                seen_large = True
    try:
        page_no = max(1, int(raw.get('page_no') or 1))
    except (TypeError, ValueError):
        page_no = 1
    try:
        chapter_id = int(raw['chapter_id']) if raw.get('chapter_id') else None
    except (TypeError, ValueError):
        chapter_id = None
    return {
        'title': _clip(raw.get('title'), 80) or 'Untitled',
        'subtitle': _clip(raw.get('subtitle'), 80),
        # A chapter is the pages drawn as one run from a stretch of
        # conversation (and any continued after them); page_no counts them.
        'chapter_id': chapter_id,
        'page_no': page_no,
        'layout': layout,
        'outfit': _match_outfit(raw.get('outfit'), wardrobe) or default_outfit,
        # Set by the browser, not the model: B&W or colour, the art mode,
        # and the date the page header prints.
        'style': _pick(raw.get('style'), STYLES, 'mono'),
        'art': _pick(raw.get('art'), ARTS, 'photo'),
        'date': _clip(raw.get('date'), 40),
        # The episodes it was drawn from, oldest first (several when they
        # were combined) — what "Next page" reads again.
        'episode_ids': [int(i) for i in (raw.get('episode_ids') or []) if str(i).isdigit()][:MAX_COMBINED],
        'cast': cast,
        'panels': panels,
    }


# ── sources ────────────────────────────────────────────────────────────

def list_sources(con):
    """What a page can be drawn from: every episode that kept its verbatim
    turns (newest first, flagged when a page already exists), and per
    conversation the latest stretch no episode covers yet."""
    drawn = dict(con.execute(
        "SELECT episode_id, COUNT(*) FROM manga_pages WHERE episode_id IS NOT NULL GROUP BY episode_id"))
    episodes = [{
        'id': r['id'],
        'agent_id': r['agent_id'],
        'agent_name': r['agent_name'],
        'session_id': r['session_id'],
        'summary': _clip(r['content'], 320),
        'created_at': r['created_at'],
        'chars': r['chars'],
        'drawn': drawn.get(r['id'], 0),   # pages already drawn from it
    } for r in con.execute(
        "SELECT m.id, m.agent_id, a.name AS agent_name, m.session_id, m.content,"
        " m.created_at, length(m.transcript) AS chars"
        " FROM memories m JOIN agents a ON a.id = m.agent_id"
        " WHERE m.memory_type = 'episode' AND m.transcript IS NOT NULL AND m.transcript != ''"
        " ORDER BY m.id DESC")]
    recent = [dict(r) for r in con.execute(
        "SELECT s.id AS session_id, s.name AS session_name, s.agent_id, a.name AS agent_name,"
        " COUNT(*) AS messages, MAX(m.created_at) AS last_at,"
        " EXISTS(SELECT 1 FROM memories e WHERE e.session_id = s.id"
        "        AND e.memory_type = 'episode') AS has_episodes"
        " FROM messages m JOIN sessions s ON s.id = m.session_id JOIN agents a ON a.id = s.agent_id"
        " WHERE m.is_summarized_into IS NULL AND m.is_summary_rollup = 0"
        " AND m.role IN ('user', 'assistant')"
        " AND s.call_parent_session_id IS NULL AND s.delegate_parent_session_id IS NULL"
        " AND s.origin NOT IN ('delegated', 'heartbeat')"
        " GROUP BY s.id HAVING COUNT(*) >= 4 ORDER BY last_at DESC")]
    config = get_config(con)
    return {'episodes': episodes, 'recent': recent,
            # Who stands in for the user in two-shots: their avatar (posed
            # in the photoshoot), or only their photo (Imagine art only).
            'user_avatar': user_avatar(con, config),
            'user_has_photo': bool(config['user_photo_path']),
            # The storyboard editor's dropdowns — the photoshoot's contract.
            'vocab': {'shot': SHOTS, 'angle': ANGLES, 'emotion': EMOTIONS, 'pose': POSES,
                      'mark': MARKS, 'effect': EFFECTS, 'size': SIZES, 'style': BALLOONS}}


def _is_hidden_note(text):
    return text.startswith(heartbeat.CONTEXT_PREFIX) or text.startswith('[System]')


def _episode_transcript(text, user_label, agent_name):
    """An episode's stored turns ("User: …" / "Assistant: …" or "<Name>: …"
    lines with one-line tool and call-note markers), reduced to the spoken
    conversation with both sides named. Notes about outfits stay — they say
    what the companion was wearing."""
    out = []
    for line in (text or '').splitlines():
        s = line.strip()
        if not s or s.startswith('[tool call:') or s.startswith('[tool result:'):
            continue
        if s.startswith('[call note:'):
            if 'outfit' in s.lower():
                out.append(s)
            continue
        if s.startswith('User:'):
            body = s[5:].strip()
            if _is_hidden_note(body):
                continue
            s = f'{user_label}: {body}'
        elif s.startswith('Assistant:'):
            s = f'{agent_name}:{s[len("Assistant:"):]}'
        out.append(s)
    return '\n'.join(out)


def _recent_transcript(con, session, agent, user_label):
    """The turns no episode has rolled up yet, spoken lines plus outfit
    changes. Returns (text, trimmed)."""
    rows = store.session_messages(
        con, session['id'], where="AND is_summarized_into IS NULL AND is_summary_rollup = 0")
    lines = []
    for m in rows:
        text = (m['content'] or '').strip()
        if text.startswith('[System]') and 'outfit' in text.lower():
            lines.append(f'[note: {text}]')
        elif m['role'] == 'user' and text and not _is_hidden_note(text):
            lines.append(f'{user_label}: {text}')
        elif m['role'] == 'assistant' and text:
            lines.append(f'{m["speaker"] or agent["name"]}: {text}')
        elif m['role'] == 'tool_result' and m['tool_name'] == 'change_outfit':
            try:
                res = json.loads(m['tool_result_json'] or '{}')
            except ValueError:
                res = {}
            if isinstance(res, dict) and res.get('ok') and res.get('name'):
                lines.append(f'[{agent["name"]} changed into "{res["name"]}"]')
    keep = []
    total = 0
    for line in reversed(lines):
        total += len(line) + 1
        if total > RECENT_MAX_CHARS and keep:
            break
        keep.append(line)
    return '\n'.join(reversed(keep)), len(keep) < len(lines)


def _wardrobe(con, agent):
    """[(name, description)] — the main outfit first."""
    appearance = store.agent_appearance(con, agent)
    items = [(appearance['main_name'], appearance['main_description'])]
    items += [(o['name'], (o.get('outfit_description') or '').strip())
              for o in store.agent_outfit_dicts(con, agent)]
    return items


def user_avatar(con, config=None):
    """The avatar standing in for the user (Settings → "Your avatar"), as
    the renderer's avatar payload with vrm_url set to the chosen outfit —
    or None when none is set (or it has since been deleted)."""
    config = config or get_config(con)
    payload = store.avatar_payload(con, config['user_avatar_id']) if config['user_avatar_id'] else None
    if not payload:
        return None
    want = (config['user_avatar_outfit'] or '').strip().lower()
    outfit = next((o for o in payload.get('outfits') or [] if want and o['name'].lower() == want), None)
    if outfit:
        payload = {**payload, 'vrm_url': outfit['vrm_url']}
    return payload


def _user_likeness_uri(con, config, outfit=''):
    """The user's likeness for an Imagine two-shot: their avatar's portrait
    (full-body first — it shows the outfit) in `outfit` when named, else in
    their Settings look; else their Settings photo. None when they have
    neither."""
    from . import portraits
    payload = user_avatar(con, config)
    if payload:
        want = next((o for o in payload.get('outfits') or []
                     if outfit and o['name'].lower() == outfit.lower()), None)
        vrm = want['vrm_url'] if want else payload['vrm_url']
        found = portraits.fullbody_source(vrm) or portraits.portrait_source(vrm)
        if found:
            return f'data:{found[0]};base64,{base64.b64encode(found[1]).decode()}'
    uri, _err = imagine_tools._user_photo_data_uri(config)
    return uri


def _chapter_so_far(con, chapter_id):
    """(title, last page_no, text) for the pages a chapter already has: per
    page its subtitle and each panel's beat with its first line, enough for
    the model to continue after them without redrawing a moment."""
    rows = con.execute(
        "SELECT page_no, script_json FROM manga_pages WHERE chapter_id = ? ORDER BY page_no, id",
        (chapter_id,)).fetchall()
    if not rows:
        raise UserError('That chapter no longer exists.')
    parts = []
    title = ''
    for r in rows:
        s = json.loads(r['script_json'] or '{}')
        title = title or s.get('title') or ''
        beats = []
        for p in s.get('panels') or []:
            first = next((ln.get('text') for ln in p.get('lines') or [] if ln.get('text')), '')
            beats.append(f'  - {p.get("beat") or "(panel)"}' + (f' ("{first}")' if first else ''))
        parts.append(f'Page {r["page_no"]}' + (f': {s["subtitle"]}' if s.get('subtitle') else '')
                     + '\n' + '\n'.join(beats))
    return title, rows[-1]['page_no'], '\n'.join(parts)


def _cast_members(con, agent, cast):
    """The chosen other companions ([{id, outfit}] from the browser) as
    [{id, name, outfit}], a prompt line each (who they are, briefly, what
    they wear and their wardrobe) and their wardrobes by name. The page's
    own companion is never cast."""
    members, lines, wardrobes = [], [], {}
    for c in (cast or [])[:MAX_CAST]:
        try:
            other = store.get_agent(con, int(c['id'] if isinstance(c, dict) else c))
        except (UserError, TypeError, ValueError, KeyError):
            continue
        if other['id'] == agent['id'] or any(m['id'] == other['id'] for m in members):
            continue
        names = [n for n, _ in _wardrobe(con, other)]
        current = store.current_outfit(con, other)
        picked = _match_outfit(c.get('outfit') if isinstance(c, dict) else '', names)
        members.append({'id': other['id'], 'name': other['name'], 'outfit': picked})
        wardrobes[other['name']] = names
        wearing = picked or (current['name'] if current else names[0])
        lines.append(f'- {other["name"]}: {_clip(persona_excerpt(other["system_prompt"]), 300)}\n'
                     f'  Wears "{wearing}". Wardrobe: {", ".join(names)}')
    return members, '\n'.join(lines), wardrobes


def generate_script(con, *, source, source_id=None, layout='page', focus='', art='photo',
                    pages=1, chapter_id=None, cast=None, source_ids=None, text='', agent_id=None):
    """Ask the text model for a storyboard of one episode ('episode'),
    several episodes of one companion read in order ('episodes',
    `source_ids`), a conversation's latest un-rolled-up stretch ('recent')
    or a script the user wrote themselves ('script': `text`, starring
    `agent_id`): `pages` pages, or with `chapter_id` that many more pages
    continuing the chapter. `cast` is the other companions who may appear.
    Returns {scripts, agent_id, session_id, episode_id, trimmed}; raises
    UserError when there is nothing to draw or the reply can't be used."""
    layout = layout if layout in LAYOUTS else 'page'
    try:
        pages = max(1, min(MAX_PAGES, int(pages)))
    except (TypeError, ValueError):
        pages = 1
    config = get_config(con)
    user_label = (config['user_display_name'] or '').strip() or 'User'
    summary = ''
    trimmed = False
    episode_ids = []
    written = source == 'script'
    if source == 'episodes':
        # Several episodes of the page's companion, oldest first, each
        # headed so the model sees where one stretch ends.
        ids = sorted({int(i) for i in (source_ids or []) if str(i).isdigit()})[:MAX_COMBINED]
        rows = [con.execute("SELECT * FROM memories WHERE id = ? AND memory_type = 'episode'",
                            (i,)).fetchone() for i in ids]
        rows = [r for r in rows if r and r['agent_id'] and r['transcript']]
        if not rows:
            raise UserError('Episode not found.')
        rows = [r for r in rows if r['agent_id'] == rows[0]['agent_id']]
        agent = store.get_agent(con, rows[0]['agent_id'])
        transcript = '\n\n'.join(
            f'=== Episode {k} ===\n{_episode_transcript(r["transcript"], user_label, agent["name"])}'
            for k, r in enumerate(rows, 1))
        if len(transcript) > COMBINED_MAX_CHARS:
            raise UserError(f'Those episodes run to {len(transcript) // 1000}k characters together; '
                            f'pick fewer (up to about {COMBINED_MAX_CHARS // 1000}k).')
        summary = '\n'.join(f'Episode {k}: {r["content"] or ""}' for k, r in enumerate(rows, 1))
        session_id, episode_id = rows[0]['session_id'], rows[0]['id']
        episode_ids = [r['id'] for r in rows]
        default_outfit = store.agent_appearance(con, agent)['main_name']
    elif written:
        agent = store.get_agent(con, agent_id)
        transcript = (text or '').strip()
        if len(transcript) > SCRIPT_MAX_CHARS:
            raise UserError(f'The script is {len(transcript) // 1000}k characters; '
                            f'keep it under {SCRIPT_MAX_CHARS // 1000}k.')
        session_id, episode_id = None, None
        current = store.current_outfit(con, agent)
        default_outfit = current['name'] if current else store.agent_appearance(con, agent)['main_name']
    elif source == 'episode':
        ep = con.execute(
            "SELECT * FROM memories WHERE id = ? AND memory_type = 'episode'", (source_id,)).fetchone()
        if not ep or not ep['agent_id']:
            raise UserError('Episode not found.')
        agent = store.get_agent(con, ep['agent_id'])
        transcript = _episode_transcript(ep['transcript'], user_label, agent['name'])
        summary = ep['content'] or ''
        session_id, episode_id = ep['session_id'], ep['id']
        episode_ids = [ep['id']]
        # An old episode says nothing of what they wore: the main look.
        default_outfit = store.agent_appearance(con, agent)['main_name']
    else:
        session = store.get_session(con, source_id)
        agent = store.get_agent(con, session['agent_id'])
        transcript, trimmed = _recent_transcript(con, session, agent, user_label)
        session_id, episode_id = session['id'], None
        current = store.current_outfit(con, agent)
        default_outfit = current['name'] if current else store.agent_appearance(con, agent)['main_name']
    if not transcript:
        raise UserError('The script is empty.' if written else 'There is no conversation here to draw yet.')
    wardrobe = _wardrobe(con, agent)
    wardrobe_text = '\n'.join(f'- {n}' + (f': {d}' if d else '') for n, d in wardrobe)
    appearance = store.agent_appearance(con, agent)
    if layout == 'yonkoma':
        shape = ('a four-panel strip (yonkoma): exactly 4 panels of equal '
                 'size, one per act of kishotenketsu')
    else:
        shape = (f'a full page of {PAGE_PANELS[0]} to {PAGE_PANELS[1]} panels, '
                 'with at most one large climax panel')
    shape = (f'up to {pages} pages, each {shape}.' if pages > 1 else f'1 page, {shape}.')
    chapter_title, first_page, so_far = '', 1, ''
    if chapter_id:
        chapter_title, last_page, so_far = _chapter_so_far(con, chapter_id)
        first_page = last_page + 1
    focus = _clip(focus, 300)
    members, cast_text, wardrobes = _cast_members(con, agent, cast)
    # The user's avatar wardrobe, when they have one: their panels can
    # change clothes too.
    you = user_avatar(con, config)
    user_names = [o['name'] for o in (you or {}).get('outfits') or []]
    wardrobes['user'] = user_names
    user_wardrobe_text = (
        f' Their "user_outfit" is "" for their usual look, or a name from their wardrobe '
        f'({", ".join(user_names)}) where the conversation shows them in something else; '
        'clothed only.' if len(user_names) > 1 else '')
    body = xai_client.create_response(
        xai_api_key=config['xai_api_key'],
        responses_url=config['xai_responses_url'],
        model=config['summary_model'],
        input_items=[{
            'role': 'user',
            'content': [{
                'type': 'input_text',
                'text': (
                    f'Storyboard this {"script" if written else "conversation"} as a manga. Draw {shape}\n\n'
                    + (SCRIPT_NOTE + '\n' if written else '')
                    + (f'The stretch spans {len(episode_ids)} episodes, in order; tell them as one '
                       'chapter, with captions to bridge the time between them.\n\n'
                       if len(episode_ids) > 1 else '')
                    + (f'Pages already drawn from this stretch, in the chapter "{chapter_title}" '
                       f'(continue after them, starting at page {first_page}):\n{so_far}\n\n'
                       if so_far else '')
                    + f'The companion (the star of the page) is {agent["name"]}.\n'
                    f'Who they are:\n{persona_excerpt(agent["system_prompt"])}\n'
                    + (f'Looks: {appearance["physical"]}\n' if appearance.get('physical') else '')
                    + f'\nWardrobe:\n{wardrobe_text}\nDefault outfit: {default_outfit}\n'
                    + f'\nThe user is "{user_label}".\n'
                    # An avatar can be posed; a photo alone only feeds Imagine-drawn panels.
                    + (WITH_USER_NOTE.format(wardrobe=user_wardrobe_text)
                       if you or (config['user_photo_path'] and art == 'illustrated')
                       else 'The user has no likeness to draw, so they stay off-panel '
                            '("with_user" is always false).\n')
                    + ('\n' + CAST_NOTE.format(cast=cast_text, emotions='|'.join(EMOTIONS))
                       if members else '\nNo other companions appear ("with" is always empty).\n')
                    + (f'\nWhat happened in this stretch (a summary):\n{summary}\n' if summary else '')
                    + (f'\nThe user asked the page to focus on: {focus}\n' if focus else '')
                    + ('\n--- BEGIN SCRIPT ---\n' if written else '\n--- BEGIN TRANSCRIPT ---\n')
                    + transcript
                    + ('\n--- END SCRIPT ---' if written else '\n--- END TRANSCRIPT ---')
                ),
            }],
        }],
        instructions=MANGA_INSTRUCTIONS,
        store=False,
        stream=True,
        timeout=600,
    )
    usage = (body.get('usage') if isinstance(body, dict) else None) or {}
    store.accrue_usd_ticks(con, store.extract_cost_ticks(usage))
    con.commit()
    text = xai_client._extract_response_text(body)
    try:
        raw = json.loads(xai_client._strip_json_fences(text))
    except (ValueError, TypeError):
        _logger.warning('Manga storyboard was not JSON: %.300s', text)
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    # One page may come back in the older single-page shape.
    raw_pages = raw.get('pages') if isinstance(raw.get('pages'), list) else [raw]
    scripts = []
    for p in raw_pages[:pages]:
        if not isinstance(p, dict):
            continue
        script = normalize_script(
            {**p, 'title': chapter_title or raw.get('title'), 'outfit': raw.get('outfit'),
             'chapter_id': chapter_id, 'page_no': first_page + len(scripts), 'cast': members,
             'episode_ids': episode_ids},
            layout, [n for n, _ in wardrobe], default_outfit, wardrobes)
        if script:
            scripts.append(script)
    if not scripts:
        raise UserError('The storyboard came back unusable. Try again.')
    return {'scripts': scripts, 'agent_id': agent['id'], 'session_id': session_id,
            'episode_id': episode_id, 'trimmed': trimmed}


# ── Imagine art ────────────────────────────────────────────────────────

def paint_panel(con, *, agent_id, script, index, mode, aspect):
    """Paint one panel with Grok Imagine. 'scenes': the setting alone, for
    the live pose to stand in. 'illustrated': the companion in the scene,
    drawn from their outfit's portrait as the reference. Returns
    {art_url}; raises UserError (a refusal included) for the browser to fall
    back on the live photo."""
    agent = store.get_agent(con, agent_id)
    config = get_config(con)
    panels = (script or {}).get('panels') or []
    if not isinstance(index, int) or not 0 <= index < len(panels) or mode not in ('scenes', 'illustrated'):
        raise UserError('Unknown panel or art mode.')
    p = panels[index]
    scene = _clip(p.get('scene'), MAX_SCENE_CHARS) or 'a cosy, softly lit room'
    try:
        aspect = float(aspect)
    except (TypeError, ValueError):
        aspect = 1.0
    ratio = min(IMAGINE_ASPECTS, key=lambda k: abs(math.log(IMAGINE_ASPECTS[k] / max(aspect, 0.05))))
    if mode == 'scenes':
        prompt = (f'{SFW_FRAME}Background art only, with no people or characters in it: '
                  f'{scene}. Anime background art, clean lines, soft natural light, open space '
                  'in the middle of the frame. No text.')
        body = xai_client.generate_image(
            xai_api_key=config['xai_api_key'], images_url=config['xai_images_url'],
            model=config['imagine_model'], prompt=prompt, aspect_ratio=ratio)
    else:
        outfit = _clip(p.get('outfit'), 80) or _clip(script.get('outfit'), 80) or None
        uri, err, _note = imagine_tools._portrait_data_uri(con, agent, outfit)
        if err:
            raise UserError(err)
        name = agent['name']
        action = _clip(p.get('action'), MAX_SCENE_CHARS) or 'talking'
        framing = (f'{SHOT_WORDS.get(p.get("shot"), SHOT_WORDS["bust"])}'
                   f'{ANGLE_WORDS.get(p.get("angle"), "")}, in {scene}. ')
        # Everyone else in the panel, left to right in the order the
        # photoshoot stands them (and the page expects): the cast members,
        # then the user. Each is drawn from their own portrait.
        others = []
        by_name = {c['name']: c for c in script.get('cast') or []}
        for w in p.get('with') or []:
            if w.get('name') in by_name:
                member = by_name[w['name']]
                other = store.get_agent(con, member['id'])
                # This panel's outfit for them, else the one picked in the
                # cast, else what they have on.
                current = store.current_outfit(con, other)
                outfit = w.get('outfit') or member.get('outfit') or (current['name'] if current else None)
                o_uri, _err, _note = imagine_tools._portrait_data_uri(con, other, outfit)
                if o_uri:
                    others.append((w['name'], o_uri, w.get('emotion'), w['name']))
        if p.get('with_user'):
            user_uri = _user_likeness_uri(con, config, p.get('user_outfit') or '')
            if user_uri:
                you = (config['user_display_name'] or '').strip() or 'the user'
                others.append((you, user_uri, p.get('user_emotion'), imagine_tools._user_label(config)))
        if others:
            group = [(name, uri, p.get('emotion'), name)] + others
            refs = [g[1] for g in group]
            drawn = ', '.join(f'{g[0]} from <IMAGE_{k}>' for k, g in enumerate(group))
            faces = '; '.join(f'{g[0]} looks {EMOTION_WORDS.get(g[2], "calm")}' for g in group)
            order = ', '.join(g[0] for g in group)
            prompt = (imagine_tools._reference_legend([g[3] for g in group])
                      + f'{SFW_FRAME}Draw {drawn} together in one manga panel, each keeping '
                      'their face, hair and outfit exactly as in their reference. '
                      f'{name} is {action}; {faces}; ' + framing
                      + f'From left to right: {order}; the upper middle kept plain. '
                      'Anime illustration, clean line art. No text, no speech bubbles, no panel borders.')
        else:
            # The side matches where the page puts the face (manga_page.js
            # photoOffset: even panels right, odd left), so the balloons
            # land in the space left for them.
            side = 'right' if index % 2 == 0 else 'left'
            prompt = (imagine_tools._reference_legend([name])
                      + f'{SFW_FRAME}Draw {name} from <IMAGE_0> as one manga panel, keeping their '
                      'face, hair and outfit exactly as in the reference. '
                      f'{name} is {action}, looking {EMOTION_WORDS.get(p.get("emotion"), "calm")}; '
                      + framing
                      + f'Place {name} in the {side} half of the frame and keep the upper '
                      f'{"left" if side == "right" else "right"} area plain. Anime illustration, '
                      'clean line art. No text, no speech bubbles, no panel borders.')
            refs = [uri]
        body = xai_client.edit_image(
            xai_api_key=config['xai_api_key'], edits_url=config['xai_images_edits_url'],
            model=config['imagine_model'], prompt=prompt, image_data_uris=refs,
            aspect_ratio=ratio)
    store.accrue_usd_ticks(con, store.extract_cost_ticks(body.get('usage') or {}))
    con.commit()
    first = body['data'][0]
    b64 = first.get('b64_json')
    if not b64:
        raise UserError('Grok Imagine returned no image for this panel (it may have been filtered).')
    mimetype = first.get('mime_type') or 'image/jpeg'
    ext = {'image/png': '.png', 'image/webp': '.webp'}.get(mimetype, '.jpg')
    folder = FILES_DIR / ART_DIR
    folder.mkdir(parents=True, exist_ok=True)
    fname = f'art_{uuid.uuid4().hex}{ext}'
    (folder / fname).write_bytes(base64.b64decode(b64))
    return {'art_url': f'/files/{ART_DIR}/{fname}'}


# ── pages ──────────────────────────────────────────────────────────────

def _row_payload(row):
    return {
        'id': row['id'],
        'agent_id': row['agent_id'],
        'agent_name': row['agent_name'],
        'session_id': row['session_id'],
        'session_name': row['session_name'],
        'episode_id': row['episode_id'],
        'chapter_id': row['chapter_id'] or row['id'],
        'page_no': row['page_no'],
        'title': row['title'],
        'layout': row['layout'],
        'script': json.loads(row['script_json'] or '{}'),
        'image_url': row['image_path'],
        'created_at': row['created_at'],
        'story_at': row['story_at'],
    }


_SELECT = ("SELECT p.*, a.name AS agent_name, s.name AS session_name, "
           # When the story happened: the episode's date (when its stretch
           # was rolled up), else the day the page was drawn.
           "COALESCE(e.created_at, p.created_at) AS story_at "
           "FROM manga_pages p JOIN agents a ON a.id = p.agent_id "
           "LEFT JOIN sessions s ON s.id = p.session_id "
           "LEFT JOIN memories e ON e.id = p.episode_id")


def list_pages(con):
    rows = con.execute(f"{_SELECT} ORDER BY p.id DESC").fetchall()
    # Newest first; the browser stacks a chapter's pages by chapter_id.
    return [_row_payload(r) for r in rows]


def _decode_png(image_data_url):
    data = image_data_url or ''
    if not isinstance(data, str) or not data.startswith('data:image/'):
        raise UserError('image_data_url must be a data:image/... URI.')
    header, _, b64 = data.partition(',')
    mimetype = header[len('data:'):].split(';', 1)[0]
    ext = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(mimetype)
    if not ext:
        raise UserError(f'Unsupported image type {mimetype!r}.')
    try:
        raw = base64.b64decode(b64 or '', validate=True)
    except Exception:
        raise UserError('image_data_url is not valid base64.')
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise UserError('The page image must be between 1 byte and 20 MB.')
    return raw, ext


def _unlink_web_path(web_path):
    if web_path and web_path.startswith('/files/') and '..' not in web_path:
        try:
            (FILES_DIR / web_path[len('/files/'):]).unlink(missing_ok=True)
        except OSError:
            _logger.warning('Could not delete %s', web_path)


def _art_urls(script):
    return {p.get('art_url') for p in (script or {}).get('panels') or [] if p.get('art_url')}


def save_page(con, *, agent_id, session_id, episode_id, script, image_data_url, page_id=None):
    """Store a composed page. With `page_id`, a re-shoot: the row keeps its
    id, the new image replaces the old file, and painted art the new script
    no longer uses is deleted."""
    raw, ext = _decode_png(image_data_url)
    layout = (script or {}).get('layout')
    script = normalize_script(script, layout if layout in LAYOUTS else 'page')
    if not script:
        raise UserError('The page script is incomplete.')
    folder = FILES_DIR / 'manga'
    folder.mkdir(parents=True, exist_ok=True)
    fname = f'manga_{uuid.uuid4().hex}{ext}'
    (folder / fname).write_bytes(raw)
    image_path = f'/files/manga/{fname}'
    if page_id:
        old = con.execute("SELECT image_path, script_json FROM manga_pages WHERE id = ?",
                          (page_id,)).fetchone()
        if not old:
            raise UserError('Manga page not found.')
        con.execute(
            "UPDATE manga_pages SET image_path = ?, script_json = ?, title = ? WHERE id = ?",
            (image_path, json.dumps(script), script['title'], page_id),
        )
        _unlink_web_path(old['image_path'])
        for url in _art_urls(json.loads(old['script_json'] or '{}')) - _art_urls(script):
            _unlink_web_path(url)
    else:
        agent = store.get_agent(con, agent_id)
        page_id = con.execute(
            """INSERT INTO manga_pages
                   (agent_id, session_id, episode_id, chapter_id, page_no, title, layout,
                    script_json, image_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (agent['id'], session_id or None, episode_id or None, script['chapter_id'],
             script['page_no'], script['title'], script['layout'],
             json.dumps(script), image_path, utcnow()),
        ).lastrowid
        # A chapter's first page opens it: its own id becomes the chapter id
        # the later pages (this run's, and any continued) are saved under.
        if not script['chapter_id']:
            script['chapter_id'] = page_id
            con.execute("UPDATE manga_pages SET chapter_id = ?, script_json = ? WHERE id = ?",
                        (page_id, json.dumps(script), page_id))
    con.commit()
    row = con.execute(f"{_SELECT} WHERE p.id = ?", (page_id,)).fetchone()
    return _row_payload(row)


def delete_page(con, page_id):
    row = con.execute("SELECT image_path, script_json FROM manga_pages WHERE id = ?",
                      (page_id,)).fetchone()
    if not row:
        return
    con.execute("DELETE FROM manga_pages WHERE id = ?", (page_id,))
    con.commit()
    _unlink_web_path(row['image_path'])
    for url in _art_urls(json.loads(row['script_json'] or '{}')):
        _unlink_web_path(url)
