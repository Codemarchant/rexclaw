# Copyright 2026 Codemarchant
"""Hardcoded browser-side function tools.

These run in the user's browser (handled by tool_dispatcher.js), not on the
server. Ported from the Odoo module with the Odoo-specific navigation and DOM
automation tools removed — the standalone app has no ERP to drive.
"""

BROWSER_TOOLS = [
    {
        "name": "set_emotion",
        "description": (
            "Blend a facial expression onto your VRM avatar. Use when you "
            "feel a relevant emotion in the conversation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "emotion": {
                    "type": "string",
                    "enum": ["neutral", "happy", "sad", "angry", "surprised", "relaxed"],
                    "description": "The expression to apply.",
                },
            },
            "required": ["emotion"],
        },
    },
    # play_gesture lives outside BROWSER_TOOLS — its enum + description are
    # extended at session-start with the agent's custom VRMA gestures (see
    # build_play_gesture_tool below).
]

# Built-in gesture ids shipped in web/src/models/avatar_catalog.js. Kept here
# verbatim so build_play_gesture_tool can produce the right enum without
# reading the JS.
_BUILTIN_GESTURE_IDS = (
    "clapping", "dance", "goodbye", "greeting", "jump",
    "look_around", "sleepy", "thinking", "peace_sign",
    "shoot", "spin", "show_full_body", "model_pose", "squat",
)

_PLAY_GESTURE_BASE_DESCRIPTION = (
    "Play a one-shot body-language animation on your avatar. Use "
    "sparingly — these are punctuation, not background motion. Pick: "
    "'clapping' for celebrating with the user; 'dance' for high-energy "
    "celebration when the user achieves something big; 'goodbye' for farewells; "
    "'greeting' for hellos / first contact in a session; 'jump' for "
    "excitement; 'look_around' when searching or curious; 'sleepy' for "
    "low-energy or 'I don't know' moments; 'thinking' while a tool call "
    "is running and you want to indicate work in progress; "
    "'peace_sign' for casual agreement / 'cool'; 'shoot' (finger-gun) "
    "for a confident 'got it' / acknowledgement; 'spin' for a playful "
    "twirl on success; 'show_full_body' when introducing yourself or "
    "the user explicitly asks to see your full body; 'model_pose' for "
    "a brief showy pose; 'squat' is a low/grounded gesture — rarely "
    "appropriate in conversation. Emotions (set_emotion) already play "
    "a matching gesture automatically — only use play_gesture for "
    "these standalones."
)


def build_play_gesture_tool(custom_gestures):
    """Return the play_gesture tool entry, with the avatar's custom VRMA
    gestures appended to the enum and described inline.

    :param custom_gestures: list of dicts {gesture_enum, description, loop,
        vrma_path} from the avatar's gesture rows.
    """
    description = _PLAY_GESTURE_BASE_DESCRIPTION
    enum = list(_BUILTIN_GESTURE_IDS)
    has_loop = False
    if custom_gestures:
        extra_lines = [
            "",
            "Additional gestures configured for this avatar (uploaded by the "
            "user — pick when the situation matches the description):",
        ]
        for g in custom_gestures:
            genum = (g.get("gesture_enum") or "").strip()
            if not genum or not g.get("vrma_path"):
                continue
            desc = (g.get("description") or "").strip() or "(no description)"
            loop_note = " (loops continuously until you stop it)" if g.get("loop") else ""
            if g.get("loop"):
                has_loop = True
            extra_lines.append(f"  - '{genum}' — {desc}{loop_note}")
            if genum not in enum:
                enum.append(genum)
        if len(extra_lines) > 2:  # at least one valid custom row
            description = description + "\n" + "\n".join(extra_lines)
    # Only surface the loop-stop affordance when a looping gesture actually
    # exists for this avatar — otherwise it's noise in the enum/description.
    if has_loop:
        if "idle" not in enum:
            enum.append("idle")
        description = description + (
            "\n\nGestures marked \"loops continuously\" keep repeating until you "
            "change them — they do NOT stop on their own. To end a loop and "
            "return to your normal resting idle motion, call play_gesture with "
            "'idle'. Playing any other gesture, or calling set_emotion, also "
            "replaces a running loop."
        )
    return {
        "name": "play_gesture",
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "gesture": {
                    "type": "string",
                    "enum": enum,
                    "description": "Which gesture to play.",
                },
            },
            "required": ["gesture"],
        },
    }


def build_change_outfit_tool(outfits):
    """Build a per-agent change_outfit tool whose description lists this
    agent's avatar wardrobe inline so the LLM can pick contextually.

    :param outfits: list of dicts {id, name, outfit_description} (additional
        outfits only — the default outfit is the implicit id 0).
    Returns None when the wardrobe is empty so the caller omits the tool.
    """
    if not outfits:
        return None

    lines = [
        "Swap your avatar into one of the wardrobe options configured for "
        "this character. Use sparingly — outfit changes are a deliberate "
        "beat, not background motion. Good moments: the conversation "
        "shifts register (work → casual, daytime → evening), the user "
        "asks you to change, or a topic genuinely calls for a different "
        "look. Don't change on a whim mid-sentence.",
        "",
        "Pass `outfit_id` from this list:",
        "  - 0 — Default outfit (the look described in your system prompt). "
        "Use this to revert.",
    ]
    for o in outfits:
        desc = (o.get("outfit_description") or "").strip() or "(no description)"
        lines.append(f"  - {o['id']} — {o['name']}: {desc}")

    return {
        "name": "change_outfit",
        "description": "\n".join(lines),
        "parameters": {
            "type": "object",
            "properties": {
                "outfit_id": {
                    "type": "integer",
                    "enum": [0] + [o["id"] for o in outfits],
                    "description": (
                        "ID of the outfit to switch to. 0 reverts to the "
                        "avatar's default outfit; other values come from the "
                        "list embedded in this tool's description."
                    ),
                },
            },
            "required": ["outfit_id"],
        },
    }
