
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

// Emotion decay: nothing in the render loop fades an emotion on its own — a
// setEmotion blendshape holds until the next call, which reads as a frozen
// pose once the reaction beat has passed. Unless the avatar opts out
// (`emotion_decay: false` in its pack manifest), the renderer settles every
// emotion after this delay back to `neutral` — except the baked-in squinty
// companions (Eve/Leo/Ara, whose `happy` blendshape shuts both eyes): for
// them `happy` settles into `relaxed` and HOLDS there, the original warm-hold
// behaviour. Word-match on the avatar name so user copies ("Eve Copy")
// inherit it. Lives here (not in the renderer) because the VR touch
// reactions consult the same policy.
export const EMOTION_DECAY_MS = 4000;
export function emotionDecayEnabled(avatarPayload) {
    return avatarPayload?.emotion_decay !== false;
}
const SQUINTY_HAPPY_RE = /\b(Eve|Leo|Ara)\b/;
export function emotionSettleTarget(emotion, avatarName) {
    if (emotion === "neutral") return null;
    if (SQUINTY_HAPPY_RE.test(avatarName || "")) {
        // Legacy warm hold: happy parks at relaxed, and relaxed stays put.
        if (emotion === "relaxed") return null;
        if (emotion === "happy") return "relaxed";
    }
    return "neutral";
}

// Standalone gestures (not bound to an emotion). The enum here MUST match the
// `play_gesture` tool's parameters.gesture.enum in services/browser_tools.py.
//
// VRMA_* clips are from pixiv's VRoid Project Motion Pack. Its terms require
// a visible credit (commercial use is permitted with it): see README.md and
// docs/README.ja-JP.md "Animation credits", and keep the same line on every
// store page (Steam, itch) that distributes the bundled clips.
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
