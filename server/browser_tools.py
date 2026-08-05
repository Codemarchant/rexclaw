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

# Offered only when the agent has Grok Imagine tools enabled — the snapshot's
# whole purpose is feeding create_video (source_image / reference_images).
# Browser-side: the dispatcher captures the live WebGL canvas and uploads it
# via /api/voice/session/<id>/selfie.
SELFIE_TOOL = {
    "name": "take_selfie",
    "description": (
        "Capture a snapshot of yourself exactly as you appear right now — "
        "avatar, outfit, pose, and anyone else in the call. By default the "
        "shot has a transparent background (just the characters); set "
        "include_background=true to keep the current scene backdrop in "
        "frame — nice for 'selfie at this place' moments. The image is "
        "saved to the Imagine library and returned as image_url + "
        "imagine_image_id. A selfie is usually step one — the natural "
        "follow-up is generating from it: create_video (reference_images "
        "to star in a clip, source_image to animate the shot itself) or "
        "create_image (source_images to restyle, remix or place yourself "
        "in a scene). When generating from a selfie, match the avatar's "
        "art style as captured — stylized anime/cel-shaded 3D, NOT "
        "photorealistic — unless the user explicitly asks for a different "
        "style. Use when the user asks for a selfie or a photo/video "
        "featuring you as you currently look."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "include_background": {
                "type": "boolean",
                "description": (
                    "true = include the current scene backdrop in the shot; "
                    "false/omitted = transparent background (default)."
                ),
            },
        },
        "required": [],
    },
}

# Screen capture is armed by the USER — browser security demands a share
# picker plus a user gesture, so the model can never see a screen nobody
# offered. Once armed (Share-screen button in the voice view) the dispatcher
# grabs frames from the live stream on demand. Gated with the imagine set
# because captures land in the files library, and VOICE MODE ONLY in the
# standalone — text mode has no browser-tool round-trip here.
SCREENSHOT_TOOL = {
    "name": "take_screenshot",
    "description": (
        "Capture a screenshot of the user's screen from their live "
        "screen-share and post it to the transcript. Requires the user to "
        "have started sharing via the Share-screen button (desktop icon) in "
        "the call header — if sharing is not active this returns an error; "
        "ask them to click it, then call the tool again. You cannot see the "
        "screenshot yourself: pass the returned imagine_image_id to "
        "delegate_task in files to read/analyze what is on screen. Use when "
        "the user asks you to look at their screen, an error message, a "
        "document or app they have open, or anything they are currently "
        "looking at."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": (
                    "Optional short label for the capture, e.g. 'Invoice "
                    "error dialog'. Defaults to 'Screenshot'."
                ),
            },
        },
        "required": [],
    },
}

# Screen recording rides the same user-armed share as take_screenshot: no
# share, no capture. Duration is model-supplied and capped at 90 s browser-
# side (web/src/lib/screen_capture.js MAX_CLIP_SECONDS — keep in sync). The
# clip stores locally in the files library only; xAI upload happens lazily
# if delegate_task is asked to watch it.
RECORD_SCREEN_CLIP_TOOL = {
    "name": "record_screen_clip",
    "description": (
        "Record the user's screen (their live screen-share) for a set number "
        "of seconds and post the clip to the transcript as a playable video. "
        "Requires the user to have started sharing via the Share-screen "
        "button (desktop icon) in the call header — if sharing is not "
        "active this returns an error; ask them to click it. IMPORTANT: if "
        "the user did not say how long to record, ASK them for the number "
        "of seconds before calling this tool — do not guess. Max 90 "
        "seconds. The tool blocks for the whole recording plus upload, so "
        "tell the user you're recording and that they should perform "
        "whatever they want captured. Audio: the clip includes sound only "
        "if the user ticked 'share audio' when they started the share (tab "
        "shares support audio everywhere; whole-monitor audio is "
        "Windows-only) — the result reports has_audio, and if the user "
        "wants sound but has_audio came back false, ask them to re-share "
        "with the audio box ticked. During a voice call, shared system "
        "audio also captures YOUR own spoken replies. You cannot watch the "
        "clip yourself: pass the returned imagine_image_id to delegate_task "
        "in files to have its content analyzed. Use when the user wants to "
        "capture a sequence a screenshot can't — reproducing a bug, "
        "demonstrating a workflow, recording an animation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "duration_seconds": {
                "type": "integer",
                "description": (
                    "How long to record, in seconds (1-90). Ask the user "
                    "for this if they didn't specify it."
                ),
            },
            "name": {
                "type": "string",
                "description": (
                    "Optional short label for the clip, e.g. 'Invoice "
                    "posting bug repro'. Defaults to 'Screen recording'."
                ),
            },
        },
        "required": ["duration_seconds"],
    },
}

# Hang up on request. Disconnection is deliberately delayed browser-side
# until the post-tool spoken reply has fully played out — the goodbye IS the
# point; cutting it off would feel like the companion hung up on the user.
END_CALL_TOOL = {
    "name": "end_call",
    "description": (
        "End this voice call. Use ONLY when the user clearly asks to end "
        "the conversation — \"end the call\", \"hang up\", \"goodnight, "
        "let's stop here\", \"talk to you later\" — or confirms they are "
        "done when you ask. Do NOT call it for a mere lull in conversation "
        "or an ambiguous farewell inside an ongoing topic; when unsure, ask "
        "first. After the tool returns, say a brief goodbye in character — "
        "that reply is your last, and the call disconnects once you finish "
        "speaking. In a group call this ends the WHOLE call for every "
        "participant; to remove just one companion, use "
        "remove_agent_from_call instead. The conversation is not lost — "
        "the user can resume it later and you will remember it."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

# Built-in gesture ids shipped in web/src/models/avatar_catalog.js. Kept here
# verbatim so build_play_gesture_tool can produce the right enum without
# reading the JS.
_BUILTIN_GESTURE_IDS = (
    "clapping", "dance", "goodbye", "greeting", "jump",
    "look_around", "sleepy", "thinking", "peace_sign",
    "shoot", "spin", "show_full_body", "model_pose", "squat",
    "backflip", "blow_kiss", "belly_dance", "push_up", "pike_walk",
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
    "a brief showy pose; 'squat' for squat reps — workout scenes or "
    "exercising together (loops continuously until you stop it); "
    "'backflip' for an athletic show-off "
    "celebration or when asked to perform a trick; 'blow_kiss' for an "
    "affectionate goodbye or a flirty, warm moment with the user; "
    "'belly_dance' when asked to dance for the user or putting on a "
    "playful performance; 'push_up' for a workout flex, exercising "
    "together, or an energetic show of determination (loops continuously "
    "until you stop it); 'pike_walk' for a yoga stretch or a playful "
    "limbering-up moment (loops continuously until you stop it). "
    "Emotions (set_emotion) already play "
    "a matching gesture automatically — only use play_gesture for "
    "these standalones."
)


def build_play_gesture_tool(custom_gestures):
    """Return the play_gesture tool entry, with the avatar's custom VRMA
    gestures appended to the enum and described inline.

    :param custom_gestures: list of partner-resolved gesture dicts from
        store.agent_gesture_dicts. Solo and combo customs share the enum —
        a combo is just a gesture that stages a second character while it
        plays.
    """
    from . import store  # local import — store imports nothing from here

    description = _PLAY_GESTURE_BASE_DESCRIPTION
    enum = list(_BUILTIN_GESTURE_IDS)
    # push_up / pike_walk are looping builtins, so the loop-stop affordance
    # below is always relevant now (it used to depend on custom gestures).
    has_loop = True
    if custom_gestures:
        extra_lines = [
            "",
            "Additional gestures configured for this avatar (uploaded by the "
            "user — pick when the situation matches the description):",
        ]
        for g in custom_gestures:
            genum = (g.get("gesture_enum") or "").strip()
            if not genum or not store.gesture_is_playable(g):
                continue
            desc = (g.get("description") or "").strip() or "(no description)"
            loop_note = " (loops continuously until you stop it)" if g.get("loop") else ""
            combo_note = (
                " (a second character joins you on screen for this one)"
                if (g.get("gesture_type") or "solo") == "combo" else ""
            )
            if g.get("loop"):
                has_loop = True
            extra_lines.append(f"  - '{genum}' — {desc}{combo_note}{loop_note}")
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


def build_add_agent_tool(agent, other_agents):
    """Build the per-agent add_agent_to_call tool for group voice calls.

    The description embeds a roster of every OTHER voice-enabled companion,
    each with its `when_to_call_description`, so the model can resolve both
    direct requests ("call Bob") and descriptive ones ("get someone who
    knows about pricing") without a lookup tool.

    Returns None when there is nobody to call — no point exposing a tool
    with an empty roster. Rebuilt on every session start, so edits to
    names/descriptions flow in immediately (same rationale as
    build_change_outfit_tool).

    :param agent: agents row of the session's own agent
    :param other_agents: list of agents rows (voice-enabled, excluding agent)
    """
    others = [a for a in (other_agents or []) if a["id"] != agent["id"]]
    if not others:
        return None
    lines = [
        "Add another AI companion to this live voice call. They join with "
        "their own voice and avatar, hear the conversation from that point "
        "on, and can speak for themselves. Use this when the user asks to "
        "bring someone in by name (\"call Bob\", \"add Ara to the call\") "
        "or asks for someone matching a description — pick the best match "
        "from the roster below. Joining takes a few seconds and the "
        "companion greets the call when connected: acknowledge briefly and "
        "continue naturally. Never speak on the new companion's behalf.",
        "",
        "Companions you can call, and when to call them:",
    ]
    for a in others:
        desc = (a["when_to_call_description"] or "").strip() or "(no description provided)"
        lines.append(f"  - agent_id {a['id']} — {a['name']}: {desc}")
    return {
        "name": "add_agent_to_call",
        "description": "\n".join(lines),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "integer",
                    "enum": [a["id"] for a in others],
                    "description": (
                        "ID of the companion to add, from the roster embedded "
                        "in this tool's description."
                    ),
                },
            },
            "required": ["agent_id"],
        },
    }


def build_remove_agent_tool(agent, other_agents):
    """Build the per-agent remove_agent_from_call tool (the counterpart to
    build_add_agent_tool).

    agent_id 0 means "disconnect yourself" — that's how a companion that was
    added to the call bows out when the user dismisses it ("okay Bob, you
    can go"). The main companion the call was started with can never be
    removed; the user ends the whole call instead. Which companions are
    actually IN the call varies at runtime, so validation happens
    client-side — the roster here just gives the model the id↔name mapping.

    Returns None when there are no other agents (no group call can exist).
    """
    others = [a for a in (other_agents or []) if a["id"] != agent["id"]]
    if not others:
        return None
    lines = [
        "Disconnect a companion from this live group voice call. Use it "
        "when the user asks to remove someone (\"let Bob go\", \"drop Ara "
        "from the call\"), or pass agent_id 0 to disconnect YOURSELF when "
        "the user dismisses you or your part in the conversation is "
        "clearly finished. Disconnection happens after current speech "
        "finishes — if you are disconnecting yourself, say a brief goodbye "
        "in your next reply; it will be your last. The main companion the "
        "call was started with cannot be removed (the user ends the call "
        "themselves), and only companions currently in the call can be "
        "disconnected.",
        "",
        "Companion ids (same as add_agent_to_call):",
        "  - agent_id 0 — yourself",
    ]
    for a in others:
        lines.append(f"  - agent_id {a['id']} — {a['name']}")
    return {
        "name": "remove_agent_from_call",
        "description": "\n".join(lines),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "integer",
                    "enum": [0] + [a["id"] for a in others],
                    "description": (
                        "ID of the companion to disconnect, or 0 to "
                        "disconnect yourself."
                    ),
                },
            },
            "required": ["agent_id"],
        },
    }
