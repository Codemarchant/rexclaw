# Copyright 2026 Codemarchant
"""Companion tools that draw new looks mid-call, on PNG looks
(png_looks.py):

  * create_outfit — a new 2D outfit for the companion's avatar (2D or
    VRM), drawn from its current picture so the likeness holds, saved to
    its wardrobe and put on. Its own switch, off by default.
  * create_character — a new character for a roleplay: a companion record
    marked auto-generated, with a 2D avatar drawn from a description, a
    voice picked from the creating companion's character voices and a
    prompt in the new-companion template's sections, filled from what the
    companion wrote (character_prompt). The browser then invites
    it into the call (tool_dispatcher.js). Memory and the call-companion
    tools (to leave the call itself) but no others; the user
    can keep it, edit it or delete it like any companion. What its
    characters run on is the creating companion's `character_settings`
    (the Characters dialog by its switch): voice setup, text chat brain
    and the voices to pick from.

The image prompts are fixed in png_looks.py; the companion supplies only
what is worn or who the character is. Voice calls only — both show their
result on the stage.
"""
import json
import logging
import threading

from . import avatar_packs, languages, png_looks, store
from .db import get_config
from .errors import UserError

_logger = logging.getLogger(__name__)

CREATE_OUTFIT_TOOL_NAME = "create_outfit"
CREATE_CHARACTER_TOOL_NAME = "create_character"
LOOK_TOOL_NAMES = {CREATE_OUTFIT_TOOL_NAME, CREATE_CHARACTER_TOOL_NAME}

# The voices a companion's characters pick from on Grok's voice, when its
# Characters dialog has no list of its own: xAI's built-in voices.
#   - tone and use: xAI's voice page (x.ai/news/new-flagship-voices, the
#     five originals' table and the 21 voices added July 2026);
#   - accents: only those xAI's TTS voice table tags (docs.x.ai
#     text-to-speech): eve and leo British, rigel Australian, naksh Indian;
#   - gender: the five originals from xAI's own older voice guide (Sal
#     "neutral"); the newer voices from the creativeclaw.co xAI voice
#     catalogue, xAI publishes none — helix is left out, its sample sits
#     at a pitch that contradicts the catalogue's label;
#   - deep / low / high / light: the median pitch of xAI's own doc sample
#     of each voice, measured 2026-11-21 (very deep under ~92 Hz, deep
#     under ~110, low under ~115 for the men; high over ~230 Hz for the
#     women), only where the reading was clean.
GROK_CHARACTER_VOICES = [
    {"voice": "ara", "description": "Female. Warm and friendly. General purpose."},
    {"voice": "eve", "description": "Female, British accent. Energetic and upbeat."},
    {"voice": "leo", "description": "Male, low, British accent. Authoritative and strong; sounds official."},
    {"voice": "rex", "description": "Male, low. Confident and clear; clarity over character."},
    {"voice": "sal", "description": "Gender-neutral, on the low side. Smooth and balanced. General purpose."},
    {"voice": "carina", "description": "Female, high. Soft, empathetic and soothing (wellness, support)."},
    {"voice": "zagan", "description": "Male. Powerful, dramatic and unmistakable (characters, narration)."},
    {"voice": "helix", "description": "Bold, dynamic and adrenaline-fuelled (commentary, podcast)."},
    {"voice": "orion", "description": "Male, very deep. Rich, cinematic and resonant (narration, audiobooks)."},
    {"voice": "luna", "description": "Female. Gentle, patient and deeply nurturing (education, assistant)."},
    {"voice": "iris", "description": "Female. Friendly, upbeat and naturally charming (sales, support)."},
    {"voice": "altair", "description": "Male, deep. Elegant, refined and effortlessly premium (advertising, narration)."},
    {"voice": "zenith", "description": "Male, low. Sharp, focused and driven (sales, advertising)."},
    {"voice": "perseus", "description": "Male, deep. Strong, confident and trustworthy (advertising, narration)."},
    {"voice": "helios", "description": "Male, very deep. Upbeat, energetic and endlessly versatile (assistant, wellness)."},
    {"voice": "lux", "description": "Male, deep. Grounded, calm and quietly wise (wellness, narration)."},
    {"voice": "kepler", "description": "Male. Inventive, forward-thinking and charismatic (advertising, podcast)."},
    {"voice": "rigel", "description": "Male, Australian accent. Precise, professional and calmly confident (assistant, support)."},
    {"voice": "cosmo", "description": "Male. Bright, curious and easy to follow (education, podcast)."},
    {"voice": "celeste", "description": "Female, high. Compassionate, confident and reassuring (support, assistant)."},
    {"voice": "ursa", "description": "Female. Friendly, warm and steadfast (assistant, podcast)."},
    {"voice": "sirius", "description": "Male, light. Quick-witted, clever and playful (commentary, characters)."},
    {"voice": "lumen", "description": "Male. Warm, articulate and engaging (education, advertising)."},
    {"voice": "castor", "description": "Male, deep. Charismatic, down-to-earth and easygoing (sales, support)."},
    {"voice": "naksh", "description": "Male, Indian accent. Warm, thoughtful and wise (assistant, support)."},
    {"voice": "atlas", "description": "Male. Confident, commanding and reassuring (sales, assistant)."},
    {"voice": "aurora", "description": "Female. Serene, steady and radiant (support, assistant)."},
    {"voice": "liora", "description": "Female, low for a female voice. Calm, grounded and luminous (wellness, assistant)."},
]

NAME_MAX = 40

# create_character's prompt fields: {field: (description, required)}, in
# the order of the new-companion template's sections (seeds.STARTER_PROMPT)
# they fill — see character_prompt.
CHARACTER_FIELDS = {
    "identity": ("Who they are in a sentence or two and the first impression they make, "
                 "starting \"You are <name> - \".", True),
    "scenario": ("Where they are and their part in the scene: how they know the user and the "
                 "others on the call, what they know of what has happened so far, what they "
                 "want here.", True),
    "personality": ("What they're like - their energy, their mood, how they come across, what "
                    "they care about. A few sentences.", True),
    "register": ("How they talk - pacing, contractions, the words they reach for, any accent "
                 "or dialect.", True),
    "quirks": ("Optional: two or three small habits that make them feel specific - a verbal "
               "tic, a tell, a running joke. One per line.", False),
    "boundaries": ("Optional: one thing they won't do or accept, and how they push back when "
                   "it's crossed.", False),
    "backstory": ("Optional: where they came from and what shaped them, in a short "
                  "paragraph.", False),
    "core_stories": ("Optional: a story or two they can tell about themselves - a formative "
                     "one, a recent one. One per line.", False),
    "day_to_day": ("Optional: what they do with their time - work, hobbies, where they "
                   "live.", False),
}
# Template heading → the field that fills it.
_SECTION_FIELDS = {
    "Identity": "identity", "Scenario": "scenario", "Personality": "personality",
    "Conversational style": "register", "Quirks": "quirks", "Boundaries": "boundaries",
    "Backstory": "backstory", "Core stories": "core_stories", "Day to day": "day_to_day",
}


def _clean_voices(value):
    return [v for v in ({"voice": str(v.get("voice") or "").strip()[:80],
                         "description": str(v.get("description") or "").strip()[:300]}
                        for v in (value if isinstance(value, list) else []) if isinstance(v, dict))
            if v["voice"]]


def character_settings(agent):
    """The companion's Characters dialog: {voice_setup, text_brain, voices}.
    '' for voice_setup / text_brain = the same as the companion itself;
    voices [] = the voice's own list (Grok's), or none."""
    try:
        raw = json.loads(agent['character_settings'] or '{}')
    except (ValueError, TypeError, IndexError, KeyError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    return {"voice_setup": str(raw.get("voice_setup") or ""),
            "text_brain": raw.get("text_brain") if raw.get("text_brain") in ("app", "voice_setup") else "",
            "voices": _clean_voices(raw.get("voices"))}


def settings_json(value):
    """The Characters dialog as stored on agents.character_settings ('' when
    everything is on its default)."""
    if isinstance(value, str):
        try:
            value = json.loads(value or '{}')
        except ValueError:
            raise UserError("Invalid character settings.")
    if not isinstance(value, dict):
        raise UserError("Invalid character settings.")
    s = character_settings({"character_settings": json.dumps(value)})
    s = {k: v for k, v in s.items() if v}
    return json.dumps(s, ensure_ascii=False) if s else ""


def _character_setup(con, agent, config):
    """(voice_setup value, Setup or None for Grok Realtime) the companion's
    characters run on."""
    from .pipeline import setups as voice_setups
    choice = character_settings(agent)["voice_setup"] or agent['voice_setup'] or ''
    return choice, voice_setups.for_agent(con, {'voice_setup': choice}, config)


def _on_grok_voice(setup):
    from .pipeline import setups as voice_setups
    return setup is None or setup.call_connection == voice_setups.XAI


def character_voices(con, agent, config):
    """[{voice, description}] the companion picks a character's voice from:
    its own list, else Grok's voices when its characters talk on Grok's
    voice, else none (the setup's default voice)."""
    voices = character_settings(agent)["voices"]
    if voices:
        return voices
    _choice, setup = _character_setup(con, agent, config)
    return GROK_CHARACTER_VOICES if _on_grok_voice(setup) else []


def _avatar_row(con, agent):
    if not agent['avatar_id']:
        return None
    return con.execute("SELECT * FROM avatars WHERE id = ?", (agent['avatar_id'],)).fetchone()


def _outfit_ready(con, agent, config):
    """The avatar create_outfit can add to — any look, 2D or VRM, in a pack
    the user made (bundled packs are read-only), with an engine to draw on
    (png_looks.available) — or None."""
    av = _avatar_row(con, agent)
    if not av or not png_looks.available(config) or not av['pack_key']:
        return None
    if not avatar_packs.pack_is_editable(av['pack_key']):
        return None
    return av


def build_create_outfit_tool(con, agent, config):
    """Offered per companion (enable_create_outfit, off by default). On a
    VRM avatar the new outfit is a 2D look in the same wardrobe: the model
    itself can't be redressed, so the companion turns into a picture of
    itself in it, and change_outfit takes it back to a 3D one."""
    av = _outfit_ready(con, agent, config) if agent['enable_create_outfit'] else None
    if not av:
        return None
    flat = "" if avatar_packs.is_png_look(av['vrm_path']) else (
        " Your 3D model can't change clothes, so in a new outfit you appear "
        "as a drawn 2D picture of yourself; change_outfit back to one of "
        "your other outfits returns you to 3D.")
    return {
        "type": "function",
        "name": CREATE_OUTFIT_TOOL_NAME,
        "description": (
            "Design a new outfit and change into it. A new picture of you "
            "wearing it is drawn from how you look now, saved to your "
            "wardrobe, and you are wearing it once it is ready - about a "
            "minute, so keep talking meanwhile. Use it when the user asks you "
            "to wear something you don't have, or the moment calls for it. "
            "For an outfit you already own, use change_outfit instead. "
            "Describe only the clothes: your face, hair and build stay as "
            "they are." + flat
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string",
                         "description": "A short name for the outfit, e.g. \"Rain jacket\"."},
                "clothes": {"type": "string",
                            "description": "What you wear: garments, colours, materials, "
                                           "shoes and accessories."},
            },
            "required": ["name", "clothes"],
        },
    }


def build_create_character_tool(con, agent, config):
    if not agent['enable_create_character'] or not png_looks.available(config, from_text=True):
        return None
    voices = character_voices(con, agent, config)
    roster = "\n".join(f"- {v['voice']}: {v['description'] or '(no description)'}" for v in voices)
    text = lambda description: {"type": "string", "description": description}
    properties = {
        "name": text("The character's name."),
        **{key: text(description) for key, (description, _required) in CHARACTER_FIELDS.items()},
        "appearance": text("What they look like and wear, for their picture."),
    }
    if voices:
        properties["voice"] = {"type": "string", "enum": [v["voice"] for v in voices],
                               "description": "The voice from the list that best fits them."}
    required = ["name", *(k for k, (_d, req) in CHARACTER_FIELDS.items() if req), "appearance"]
    if voices:
        required.append("voice")
    return {
        "type": "function",
        "name": CREATE_CHARACTER_TOOL_NAME,
        "description": (
            "Create a new character for the story you and the user are "
            "playing, and bring them into this call: a picture of them is "
            "drawn, and they join with their own voice and their own mind, "
            "speaking for themselves. It takes about a minute, so keep the "
            "scene going meanwhile; they greet the call when they arrive. "
            "Use it for side characters the scene needs - a shop assistant, "
            "a rival, a guide - when the user is up for it. Never speak on "
            "their behalf once they are here. They are saved as a new "
            "companion the user can keep or delete later. Write every "
            "field to them, in the second person (\"you\"); the optional "
            "ones add depth to a character who may stay a while."
            + ("\n\nVoices to choose from:\n" + roster if voices else "")
        ),
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


def character_prompt(fields):
    """A created character's system prompt: the new-companion template's
    sections (seeds.STARTER_PROMPT) filled from create_character's fields.
    Conversational style is kept word for word but for its register line,
    which takes the character's own; Boundaries keeps the template's
    standing paragraph under the character's line, Core stories its
    lead-in. A section whose field was left out is dropped."""
    from .seeds import STARTER_PROMPT
    sections = []
    for block in STARTER_PROMPT.split("\n## "):
        heading, _, body = block.lstrip("# ").partition("\n")
        key = _SECTION_FIELDS.get(heading.strip())
        value = (fields.get(key) or "").strip() if key else ""
        if key == "register":
            body = "\n".join(f"- Your register: {value}" if line.startswith("- Your register:") and value
                             else line for line in body.splitlines())
        elif not value:
            continue
        elif key in ("quirks", "core_stories"):
            bullets = "\n".join(l if l.lstrip().startswith("-") else f"- {l.strip()}"
                                for l in value.splitlines() if l.strip())
            body = bullets if key == "quirks" else f"{body.splitlines()[0]}\n{bullets}"
        elif key == "boundaries":
            standing = body.split("\n\n", 1)[1] if "\n\n" in body else ""
            body = f"{value}\n\n{standing}".strip()
        else:
            body = value
        sections.append(f"## {heading.strip()}\n{body.strip()}")
    return "\n\n".join(sections)


def build_voice_tools(con, agent, config):
    return [t for t in (build_create_outfit_tool(con, agent, config),
                        build_create_character_tool(con, agent, config)) if t]


def _text(arguments, key, limit=4000):
    value = arguments.get(key)
    return value.strip()[:limit] if isinstance(value, str) else ""


_pack_locks = {}
_pack_locks_guard = threading.Lock()


def _pack_lock(pack_key):
    """One lock per avatar pack, for create_outfit's manifest update."""
    with _pack_locks_guard:
        return _pack_locks.setdefault(pack_key, threading.Lock())


def _create_outfit(con, agent, config, arguments):
    if not agent['enable_create_outfit']:
        return {"error": "Creating outfits is turned off for this companion."}
    av = _outfit_ready(con, agent, config)
    if not av:
        return {"error": "Your avatar can't take a new outfit (only one the user made or "
                         "copied in the app can)."}
    name = _text(arguments, "name", NAME_MAX)
    clothes = _text(arguments, "clothes")
    if not name or not clothes:
        return {"error": "name and clothes are required."}
    # Drawn from the look worn now, so the likeness carries over: its
    # full-body picture (a 2D look's image, a VRM's full-body portrait),
    # else its face portrait; the main look's when the current one has
    # neither.
    from . import portraits
    current = store.current_outfit(con, agent)
    found = None
    for look in ([current] if current else []) + [av]:
        found = portraits.fullbody_source(look['vrm_path']) or portraits.portrait_source(look['vrm_path'])
        if found:
            break
    if not found:
        return {"error": "There is no picture of you to work from: the user can generate "
                         "your portrait in the avatar editor."}
    import base64
    ref = f"data:{found[0]};base64,{base64.b64encode(found[1]).decode()}"
    images = png_looks.generate(config, reference_uris=[ref], outfit=clothes)

    pack_key = av['pack_key']
    # Read → add → write → look up under the pack's lock: two outfits
    # finishing together would otherwise each write a manifest without the
    # other's.
    with _pack_lock(pack_key):
        manifest = avatar_packs.read_manifest(pack_key)
        taken = {str(o.get("name") or "").lower() for o in manifest.get("outfits") or []}
        taken.add(str(manifest.get("main_outfit_name") or "").lower())
        unique, n = name, 2
        while unique.lower() in taken:
            unique, n = f"{name} {n}", n + 1
        fields = png_looks.save_to_pack(pack_key, f"{agent['name']}_{unique}", images)
        manifest.setdefault("outfits", []).append({"name": unique, "description": clothes, **fields})
        avatar_packs.write_manifest(con, pack_key, manifest)
        row = con.execute("SELECT * FROM avatar_outfits WHERE avatar_id = ? AND name = ?"
                          " ORDER BY id DESC LIMIT 1", (av['id'], unique)).fetchone()
    if not row:
        return {"error": "The outfit was drawn but could not be added to your wardrobe."}
    store.set_current_outfit(con, agent, row['id'])
    con.commit()
    return {
        "ok": True,
        "outfit_id": row['id'],
        "name": unique,
        "vrm_url": store.look_url(row),
        "avatar": store.avatar_payload(con, av['id']),
        "note": "You're wearing it now.",
    }


def _create_character(con, session, agent, config, arguments):
    if not agent['enable_create_character']:
        return {"error": "Creating characters is turned off for this companion."}
    name = _text(arguments, "name", NAME_MAX)
    appearance = _text(arguments, "appearance")
    voice = _text(arguments, "voice", 80)
    fields = {key: _text(arguments, key) for key in CHARACTER_FIELDS}
    missing = [k for k, (_d, req) in CHARACTER_FIELDS.items() if req and not fields[k]]
    if not name or not appearance or missing:
        return {"error": "Required: name, appearance, " + ", ".join(
            k for k, (_d, req) in CHARACTER_FIELDS.items() if req) + "."}
    prompt = character_prompt(fields)
    voices = [v["voice"] for v in character_voices(con, agent, config)]
    if voices and voice not in voices:
        voice = voices[0]
    # Where the character's voice goes: the Grok voice on xAI's voice,
    # else its voice on that setup's voice server (setups.pipeline_voice).
    settings = character_settings(agent)
    setup_choice, setup = _character_setup(con, agent, config)
    voice_cols = {}
    if voices and _on_grok_voice(setup):
        voice_cols["voice"] = voice
    elif voices:
        voice_cols["pipeline_voice"] = json.dumps({str(setup.call_connection): voice})

    unique, n = name, 2
    languages.install(con)
    while con.execute("SELECT 1 FROM agents WHERE unicode_fold(name) = unicode_fold(?)", (unique,)).fetchone():
        unique, n = f"{name} {n}", n + 1

    pack_key = avatar_packs.create_pack(unique)
    try:
        images = png_looks.generate(config, character=appearance)
        # The drawing takes a minute: a call hung up meanwhile has nobody to
        # join, so nothing is saved.
        live = con.execute("SELECT state FROM sessions WHERE id = ?", (session['id'],)).fetchone()
        if not live or live['state'] != 'active':
            avatar_packs.delete_pack(con, pack_key)
            return {"error": "The call ended before they were ready, so they weren't saved."}
        fields = png_looks.save_to_pack(pack_key, unique, images)
        avatar_id = avatar_packs.write_manifest(con, pack_key, {
            "name": unique,
            "physical_description": appearance,
            "outfits": [], "gestures": [], "backgrounds": [],
            **fields,
        })
    except Exception:
        avatar_packs.delete_pack(con, pack_key)
        raise

    # Every enable_ flag off (the two legacy mode flags aside, which
    # nothing reads) except: memory, so a character kept for later
    # remembers the scenes it was in; and the call-companion pair, so it
    # can leave the call itself (remove_agent_from_call with 0) when its
    # part is done. Not end_call: from a character in a group call it would
    # hang up the whole call, not just its own part. Time-aware resume
    # keeps its default (on); speaks_first is on, so a call started with
    # the character later opens in character.
    kept = {"enable_memory_tools": 1, "enable_call_agents_tool": 1}
    cols = [r[1] for r in con.execute("PRAGMA table_info(agents)")]
    off = {c: 0 for c in cols if c.startswith("enable_")
           and c not in ("enable_voice_mode", "enable_text_mode", *kept)}
    vals = {
        **off,
        **kept,
        "speaks_first": 1,
        **voice_cols,
        "name": unique,
        "system_prompt": prompt,
        "avatar_id": avatar_id,
        "auto_generated": 1,
        "sequence": 1000,
        "provider": agent['provider'],
        "voice_setup": setup_choice,
        "text_brain": settings["text_brain"] or agent['text_brain'],
        "when_to_call_description": f"A character {agent['name']} created for a roleplay.",
    }
    cur = con.execute(f"INSERT INTO agents ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                      tuple(vals.values()))
    con.commit()
    return {
        "ok": True,
        "agent_id": cur.lastrowid,
        "name": unique,
        "status": "joining",
        "note": (f"{unique} is joining the call now and will greet everyone in a few "
                 "seconds. Carry on the scene; don't speak for them."),
    }


def execute(con, session, tool_name, arguments):
    """Run a look tool for a voice session; {'error': ...} on failure."""
    if session['mode'] == 'text':
        return {"error": f"{tool_name} is only available on voice calls."}
    agent = store.get_agent(con, session['agent_id'])
    config = get_config(con)
    arguments = arguments or {}
    try:
        if tool_name == CREATE_OUTFIT_TOOL_NAME:
            return _create_outfit(con, agent, config, arguments)
        if tool_name == CREATE_CHARACTER_TOOL_NAME:
            return _create_character(con, session, agent, config, arguments)
    except UserError as e:
        return {"error": str(e)}
    except Exception as e:
        _logger.exception("%s failed for session %s", tool_name, session['id'])
        return {"error": f"{tool_name} failed: {e}"}
    return {"error": f"Unknown tool: {tool_name}"}
