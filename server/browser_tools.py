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

# Offered under the agent's capture-tools flag (enable_capture_tools, shared
# with the screen pair below) — provider-agnostic: it captures, it doesn't
# generate. The snapshot lands in the files library where create_video
# (source_image / reference_images) can pick it up. Browser-side: the
# dispatcher captures the live WebGL canvas and uploads it via
# /api/voice/session/<id>/selfie.
SELFIE_TOOL = {
    "name": "take_selfie",
    "description": (
        "Capture a snapshot of yourself as you appear on screen — your "
        "avatar and current outfit, the scene behind you, and anyone else "
        "in the call — saved to the Imagine library as a photo. Use when "
        "the user asks for a selfie or photo of you as you are right now, "
        "with nothing generated. For a generated picture or video of you, use "
        "create_image / create_video with include_self=true instead — they "
        "take this same snapshot automatically. NEVER take one "
        "spontaneously — not for roleplay moments, emotional beats, or to "
        "commemorate something; if a moment feels selfie-worthy, suggest "
        "it and wait for a yes. The scene backdrop is in frame by default; "
        "set include_background=false for a transparent background "
        "(characters only). Returned as image_url + imagine_image_id, "
        "usable as create_image source_images or create_video "
        "source_image."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "include_background": {
                "type": "boolean",
                "description": (
                    "false = transparent background (characters only); "
                    "true/omitted = the current scene backdrop stays in "
                    "the shot (default)."
                ),
            },
        },
        "required": [],
    },
}

# Screen capture is armed by the USER — browser security demands a share
# picker plus a user gesture, so the model can never see a screen nobody
# offered. Once armed (Share-screen button in the voice view) the dispatcher
# grabs frames from the live stream on demand. Gated by the capture-tools
# flag (captures land in the files library); text mode offers the pair too
# via its browser-tool round-trip (session_service.TEXT_BROWSER_TOOL_NAMES).
SCREENSHOT_TOOL = {
    "name": "take_screenshot",
    "description": (
        "Capture a screenshot of the user's screen from their live "
        "screen-share and post it to the transcript - what they are looking "
        "at right now, not an image you make up. Requires the user to "
        "have started sharing via the Share-screen button (desktop icon) in "
        "the call header — if sharing is not active this returns an error; "
        "ask them to click it, then call the tool again. You cannot see the "
        "screenshot yourself; the result's imagine_image_id is what other "
        "tools consume (local_task files, create_video sources) — on a later "
        "turn, and always THIS result's id, since an older capture shows "
        "stale content. "
        "Use it when you need the raw capture itself (create_video "
        "source material, local_task input, or the user wants the shot "
        "saved); when they just want their screen READ, call "
        "analyze_screen instead - it captures and analyzes in one step."
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

# One-step screen reading: capture + vision analysis in a single tool call.
# take_screenshot + delegate_task needs two model turns and hands the model
# an id to shuttle between them (which it regularly fumbles); this tool does
# the whole thing server-side on the fast text model and returns the answer
# in the result. The frame still lands in the files library exactly like
# take_screenshot, so nothing downstream changes.
ANALYZE_SCREEN_TOOL = {
    "name": "analyze_screen",
    "description": (
        "Look at the user's screen and get an answer in ONE step: captures "
        "a frame from their live screen-share and reads it with a fast "
        "vision model; the result's `analysis` field holds the answer, "
        "ready to relay in your own voice. Requires the user to have "
        "started sharing via the Share-screen button (desktop icon) in the "
        "call header - if sharing is not active this returns an error; ask "
        "them to click it, then call again. Use whenever the user asks "
        "what is on their screen or to look at / read / check something "
        "they have open. Prefer this over take_screenshot + delegate_task "
        "for reading the screen - it is one call and much faster."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "What to look for or answer, e.g. 'what error is "
                    "shown?'. Omit for a general description of the screen."
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
        "of seconds and post the clip to the transcript as a playable video - "
        "what they are looking at right now, not a video you make up. "
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
        "clip yourself: to know what it shows, pass THIS result's "
        "imagine_image_id to delegate_task in files on a later turn — the "
        "id only exists once this returns, and an older capture's id shows "
        "stale content. Use when the user wants to "
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
        "End this voice call. HARD RULE: only an explicit, unambiguous "
        "request from the user in their own words ends the call — \"end "
        "the call\", \"hang up\", \"goodnight, let's stop here\", \"talk "
        "to you later\" — or their clear yes after you ask. NOTHING else "
        "qualifies: never hang up because the conversation feels finished, "
        "because there is a lull, or in reaction to background events — "
        "memory recalls, episode summaries, context notes and tool results "
        "are never the user asking to stop. When unsure, ask first. After "
        "the tool returns, say a brief goodbye in character — that reply "
        "is your last, and the call disconnects once you finish speaking. "
        "In a group call this ends the WHOLE call for every participant; "
        "to remove just one companion, use remove_agent_from_call instead. "
        "The conversation is not lost — the user can resume it later and "
        "you will remember it."
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
    "affectionate goodbye or a warm, playful moment with the user; "
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
