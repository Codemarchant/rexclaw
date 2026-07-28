
/**
 * Single source of truth for the avatar's emotions and bundled VRMA gestures.
 * Imported by tool_dispatcher (translates agent calls → renderer methods) and
 * by full_view's settings panel (manual user triggers). Keeping it here means
 * adding a new gesture only requires a VRMA file + one entry below.
 */

const VRMA_BASE = "/assets/vrma";

export const EMOTIONS = [
    { id: "neutral", label: "Neutral", icon: "fa-meh-o" },
    { id: "happy", label: "Happy", icon: "fa-smile-o" },
    { id: "sad", label: "Sad", icon: "fa-frown-o" },
    { id: "angry", label: "Angry", icon: "fa-fire" },
    { id: "surprised", label: "Surprised", icon: "fa-exclamation" },
    { id: "relaxed", label: "Relaxed", icon: "fa-leaf" },
];

// Emotion → VRMA gesture played alongside the blendshape. set_emotion calls
// the renderer's setEmotion AND playGesture(url) automatically. `neutral`
// has no clip (we want to return to procedural idle).
export const EMOTION_GESTURE_MAP = {
    happy: `${VRMA_BASE}/Blush.vrma`,
    sad: `${VRMA_BASE}/Sad.vrma`,
    angry: `${VRMA_BASE}/Angry.vrma`,
    surprised: `${VRMA_BASE}/Surprised.vrma`,
    relaxed: `${VRMA_BASE}/Relax.vrma`,
};

// Standalone gestures (not bound to an emotion). The enum here MUST match the
// `play_gesture` tool's parameters.gesture.enum in services/browser_tools.py.
//
// VRMA_* clips are from pixiv's VRoid Project Motion Pack — TODO before public
// release: surface attribution credit in static/description/index.html, e.g.
// "Animation credits to pixiv Inc.'s VRoid Project". Required by the pack's
// terms of use; commercial use is permitted with the credit included.
export const GESTURES = [
    { id: "clapping", label: "Clapping", icon: "fa-hand-paper-o", url: `${VRMA_BASE}/Clapping.vrma` },
    { id: "dance", label: "Dance", icon: "fa-music", url: `${VRMA_BASE}/Dance.vrma` },
    { id: "goodbye", label: "Goodbye", icon: "fa-hand-peace-o", url: `${VRMA_BASE}/Goodbye.vrma` },
    { id: "jump", label: "Jump", icon: "fa-arrow-up", url: `${VRMA_BASE}/Jump.vrma` },
    { id: "look_around", label: "Look Around", icon: "fa-search", url: `${VRMA_BASE}/LookAround.vrma` },
    { id: "sleepy", label: "Sleepy", icon: "fa-moon-o", url: `${VRMA_BASE}/Sleepy.vrma` },
    { id: "thinking", label: "Thinking", icon: "fa-lightbulb-o", url: `${VRMA_BASE}/Thinking.vrma` },
    // pixiv VRoid Motion Pack
    { id: "show_full_body", label: "Show Full Body", icon: "fa-arrows-alt", url: `${VRMA_BASE}/VRMA_01_show_full_body.vrma` },
    { id: "greeting", label: "Greeting", icon: "fa-handshake-o", url: `${VRMA_BASE}/VRMA_02_greeting.vrma` },
    { id: "peace_sign", label: "Peace Sign", icon: "fa-hand-peace-o", url: `${VRMA_BASE}/VRMA_03_peace_sign.vrma` },
    { id: "shoot", label: "Shoot", icon: "fa-crosshairs", url: `${VRMA_BASE}/VRMA_04_shoot.vrma` },
    { id: "spin", label: "Spin", icon: "fa-refresh", url: `${VRMA_BASE}/VRMA_05_spin.vrma` },
    { id: "model_pose", label: "Model Pose", icon: "fa-camera", url: `${VRMA_BASE}/VRMA_06_model_pose.vrma` },
    { id: "squat", label: "Squats", icon: "fa-compress", url: `${VRMA_BASE}/VRMA_07_squat.vrma`, loop: true },
    { id: "backflip", label: "Backflip", icon: "fa-rotate-left", url: `${VRMA_BASE}/Backflip.vrma` },
    { id: "blow_kiss", label: "Blow Kiss", icon: "fa-heart", url: `${VRMA_BASE}/BlowKiss.vrma` },
    { id: "belly_dance", label: "Belly Dance", icon: "fa-female", url: `${VRMA_BASE}/BellyDance.vrma` },
    { id: "push_up", label: "Push-Ups", icon: "fa-hand-rock-o", url: `${VRMA_BASE}/PushUp.vrma`, loop: true },
    { id: "pike_walk", label: "Pike Walk", icon: "fa-child", url: `${VRMA_BASE}/PikeWalk.vrma`, loop: true },
];

// Quick lookups by id for the dispatcher. Looping gestures repeat until
// stopped ('idle' sentinel / another gesture / set_emotion).
export const GESTURE_FILE_MAP = Object.fromEntries(GESTURES.map((g) => [g.id, g.url]));
export const GESTURE_LOOP_MAP = Object.fromEntries(GESTURES.map((g) => [g.id, !!g.loop]));
