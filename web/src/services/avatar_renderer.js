
/**
 * Avatar renderer service.
 *
 * Singleton three.js WebGLRenderer + scene + active VRM model. Both the systray
 * mini canvas and the full-screen client action share this single instance to
 * avoid hitting Chrome's 16-WebGL-context cap.
 *
 * Three.js gotchas worth flagging (from prior project memory):
 * - NEVER use lookAt() then mutate rotation.z/.x — corrupts the rotation matrix.
 *   We use manual rotation.set(0, atan2(dx,dz), 0) for the head tracker.
 * - Floating animations: use position.y = baseY + sin(t) — never +=.
 */

// three.js + VRM libs are bundled by Vite (npm deps) — previously they were
// fetched at runtime from esm.sh, which broke the avatar in browsers that
// block third-party scripts (Brave shields, strict tracking protection).
// Bundling also makes the avatar work fully offline.
import * as THREE_NS from "three";
import {
    VRMLoaderPlugin,
    VRMUtils,
    VRMExpressionPresetName,
    VRMSpringBoneCollider,
    VRMSpringBoneColliderShapeSphere,
} from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
    EMOTION_DECAY_MS,
    emotionDecayEnabled,
    emotionSettleTarget,
} from "../models/avatar_catalog";

// Kept async + memoized so the renderer code below stays identical to the
// CDN-loading version it was ported from.
async function loadLibs() {
    return {
        THREE: THREE_NS,
        VRMLoaderPlugin,
        VRMUtils,
        VRMExpressionPresetName,
        VRMSpringBoneCollider,
        VRMSpringBoneColliderShapeSphere,
        VRMAnimationLoaderPlugin,
        createVRMAnimationClip,
        GLTFLoader,
        OrbitControls,
    };
}

// Camera framing — auto-fit to the loaded VRM's actual world-space bounding
// box (captured in loadVRM). The "head" bone in VRM lives at the chin/neck
// pivot, not the top of the skull, so models with tall hair / hats / horns /
// accessories that extend well above the head bone were getting clipped by
// the fixed-distance approach. Now we compute the framed region from the
// mesh bounds and solve for the distance that makes it fit at the chosen
// FOV — works for any avatar size or proportion. See _cameraPreset().
const FACE_FALLBACK_HEAD_Y = 1.35;  // typical adult VRM head Y, used pre-load
const FACE_FOV = 20;
const FULL_FOV = 35;
// Padding factors expand the framed region so subjects don't kiss the
// viewport edges. ~20% margin for face shot reads as portrait composition;
// 10% for full body keeps feet+top with a touch of breathing room.
const FACE_FRAME_PADDING = 1.20;
const FULL_FRAME_PADDING = 1.10;
// Some avatars read wider than the height-driven face solve accounts for —
// Sal's silhouette especially — so their face shot clips at the sides of
// narrow hosts (the mascot window above all). Zoom their face preset out a
// touch. Word-match on the avatar name so user copies ("Sal Copy") inherit
// it.
const WIDE_FACE_AVATAR_RE = /\bSal\b/;
const WIDE_FACE_EXTRA_PADDING = 1.25;
// Lower bound for the face shot region — extends frame this far below the
// head bone so the upper chest is visible (otherwise framing reads as a
// floating disembodied head).
const FACE_LOWER_OFFSET = 0.18;
// Hard floors so degenerate/tiny models don't end up with the camera
// inside the mesh. Picked from the previous fixed values for continuity.
const FACE_MIN_DISTANCE = 1.2;
const FULL_MIN_DISTANCE = 2.5;

// Background presets for the avatar canvas. Keys MUST match the
// `preset_style` Selection on rexclaw.voice.avatar.background
// (models/voice_avatar_background.py). Presets (gradients/solids) apply to
// BOTH mini and full hosts — they scale fine. Image backgrounds are
// full-only because at 200px mini they read as unrecognisable noise; see
// _applyBackgroundToActiveHost.
//
// Vignettes place their bright spot at `50% 35%` — pro-headshot convention
// puts the key-light behind the subject's head, and the avatar's head sits
// in the upper third of the 80vh full canvas. Centering the ellipse there
// reads as a soft studio rim-light instead of a flat-lit cyclorama.
const BACKGROUND_PRESETS = {
    gradient_indigo: "linear-gradient(135deg, #1e293b 0%, #312e81 100%)",
    gradient_slate: "linear-gradient(135deg, #475569 0%, #1e293b 100%)",
    gradient_studio: "linear-gradient(180deg, #f8fafc 0%, #cbd5e1 100%)",
    vignette_charcoal: "radial-gradient(ellipse 80% 90% at 50% 35%, #3b424f 0%, #1c2230 55%, #0a0d14 100%)",
    vignette_studio: "radial-gradient(ellipse 80% 90% at 50% 35%, #f1f5f9 0%, #cbd5e1 60%, #94a3b8 100%)",
    vignette_navy: "radial-gradient(ellipse 80% 90% at 50% 35%, #1e3a8a 0%, #1e293b 55%, #0a0f24 100%)",
    solid_dark: "#0f172a",
    solid_light: "#f5f5f5",
};

// Animation constants — chosen from human-physiology and VTuber-rendering research:
// - Blink: humans blink every 2-10s (avg ~4); biphasic 80ms close + 100ms open feels natural.
//   Range [3, 6] hides the variability without feeling robotic.
// - Breath: subtle, 0.012 of head-bone Y position; ~0.27 Hz (= 16 breaths/min, restful).
// - Look-at: at the camera. "Cursor follow" breaks eye contact, so it stays off
//   everywhere except the mascot overlay (opt-in, via setCursorFollow) — there
//   the cursor IS the user's attention, and tracking it reads as attentiveness.
// - Procedural idle: tiny sinusoidal bone rotations on hips/spine/shoulders/arms.
//   Runs whenever no VRMA clip is loaded so the avatar isn't stuck in T-pose.
//   Amplitudes are deliberately small so it looks like a relaxed standing person,
//   not a swaying drunk.
const BLINK_INTERVAL_MIN = 3.0;
const BLINK_INTERVAL_MAX = 6.0;
const BLINK_CLOSE_DURATION = 0.08;
const BLINK_OPEN_DURATION = 0.10;
const BREATH_AMPLITUDE = 0.012;
const BREATH_FREQUENCY_HZ = 0.27;

// Idle bone deltas in radians; SHOULDER_DOWN is rotation.z to drop arms from T-pose.
const IDLE_HIP_SWAY_AMP = 0.025;
const IDLE_HIP_SWAY_HZ = 0.18;
const IDLE_SPINE_SWAY_AMP = 0.015;
const IDLE_SPINE_SWAY_HZ = 0.22;
const IDLE_SHOULDER_DOWN = 1.15;        // ~66deg, brings arms down from T-pose
const IDLE_ARM_SWAY_AMP = 0.04;
const IDLE_ARM_SWAY_HZ = 0.30;
const IDLE_HEAD_TURN_AMP = 0.05;
const IDLE_HEAD_TURN_HZ = 0.15;

// Compound-frequency layer added on top of primary sway. A second sine at an
// incommensurate frequency makes the motion read as quasi-random instead of
// a clean periodic loop — the single-sine version gave away the "robot" feel.
const IDLE_SECONDARY_HZ = 0.071;
const IDLE_SECONDARY_AMP_RATIO = 0.45;  // multiplier of the primary amplitude

// Phase offsets so left/right limbs aren't perfect mirrors. Prime-ish radian
// values keep the asymmetry from re-aligning into visible sync periodically.
const IDLE_ASYMMETRY_PHASE_L = 0.41;
const IDLE_ASYMMETRY_PHASE_R = 1.13;

// Relaxed hand pose. VRM normalized fingers curl on rotation.z with sign
// flipped for left vs right; thumbs curl on rotation.y. These values are
// roughly the "loose grip on nothing" pose of a human at rest — flat hands
// read as mannequin-stiff.
const IDLE_FINGER_CURL_PROXIMAL = 0.18;
const IDLE_FINGER_CURL_INTERMEDIATE = 0.36;
const IDLE_FINGER_CURL_DISTAL = 0.30;
const IDLE_THUMB_OPPOSE = 0.28;          // thumb out from palm
const IDLE_THUMB_CURL = 0.10;

// Lower body. A small permanent knee bend prevents locked-leg stiffness, and
// a very slow weight shift between feet rolls the hips and alternates which
// knee bends more — basic contrapposto, the default standing pose for humans.
const IDLE_KNEE_BEND = 0.07;
const IDLE_WEIGHT_SHIFT_AMP = 0.022;
const IDLE_WEIGHT_SHIFT_HZ = 0.08;       // ~12s per full L↔R cycle

// Speaking-state amplifiers. Multiplied INTO the idle amplitudes when the
// avatar is "speaking" (audio intensity > ~0.1). Tuned to look animated but
// not jittery — exceeding ~2x starts looking caffeinated.
const SPEAK_BODY_GAIN = 1.6;
const SPEAK_HEAD_NOD_AMP = 0.06;
const SPEAK_HEAD_NOD_HZ = 0.7;
const SPEAK_HEAD_TILT_AMP = 0.04;
const SPEAK_HEAD_TILT_HZ = 0.45;
const SPEAK_INTENSITY_ATTACK = 0.25;    // smoothing factor when ramping up
const SPEAK_INTENSITY_RELEASE = 0.05;   // slower when ramping down (no whiplash on interrupt)

// Idle eye saccades. Real eyes never hold perfectly still — they micro-dart
// (saccade) to new fixation points even while "staring". Without this the
// avatar's gaze reads as glassy/dead. The jitter is deliberately small and
// centred on the camera so eye CONTACT is preserved (this is not cursor
// follow — see the look-at note above). EYE_SACCADE_AMP is in world units of
// offset around the eye-contact point; the interval model below is ported
// from moeru-ai/airi (utils/eye-motions.ts): a probability table that biases
// toward short fixations with a long tail, so the timing never feels periodic.
const EYE_SACCADE_AMP = 0.16;
const EYE_SACCADE_INT_STEP = 400;       // ms granularity of the interval buckets
const EYE_SACCADE_INT_P = [
    [0.075, 800], [0.110, 0], [0.125, 0], [0.140, 0], [0.125, 0],
    [0.050, 0], [0.040, 0], [0.030, 0], [0.020, 0], [1.000, 0],
];
for (let i = 1; i < EYE_SACCADE_INT_P.length; i++) {
    EYE_SACCADE_INT_P[i][0] += EYE_SACCADE_INT_P[i - 1][0];
    EYE_SACCADE_INT_P[i][1] = EYE_SACCADE_INT_P[i - 1][1] + EYE_SACCADE_INT_STEP;
}
/** Random fixation interval in ms, weighted toward short holds. */
function randomSaccadeInterval() {
    const r = Math.random();
    for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
        if (r <= EYE_SACCADE_INT_P[i][0]) {
            return EYE_SACCADE_INT_P[i][1] + Math.random() * EYE_SACCADE_INT_STEP;
        }
    }
    return EYE_SACCADE_INT_P[EYE_SACCADE_INT_P.length - 1][1] + Math.random() * EYE_SACCADE_INT_STEP;
}

// Mascot cursor follow (opt-in, mascot overlay only — see the look-at note).
// The gaze leaves the camera and rides the desktop cursor: the shell's cursor
// feed (window-relative px) maps to NDC over the active canvas, a ray through
// that point gives a world target just in front of the camera, and the
// look-at eases toward it. Eyes are clamped by the VRM's own lookAt range
// maps; the head adds a clamped share of the deflection in _applyIdle so a
// far-off cursor reads as attention instead of side-eye. A cursor that stops
// moving releases the gaze back to eye contact.
const CURSOR_FOLLOW_DEPTH = 0.8;        // target distance in front of the camera
const CURSOR_FOLLOW_RATE = 7;           // gaze ease, k = 1 - exp(-RATE * dt)
const CURSOR_FOLLOW_IDLE_S = 4;         // cursor still this long → eye contact
const CURSOR_FOLLOW_NDC_MAX = 2.5;      // clamp for cursors far outside the window
const CURSOR_FOLLOW_HEAD_SHARE = 0.5;   // fraction of the deflection the head takes
const CURSOR_FOLLOW_HEAD_YAW = 0.22;    // head clamp, radians
const CURSOR_FOLLOW_HEAD_PITCH = 0.12;

// Smooth start/stop easing for emotion cross-fades (ported from airi's
// expression.ts). Reads more natural than a flat linear ramp.
function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Emotion definitions. `cap` is the peak weight for the primary expression —
// kept below 1.0 because full-weight VRoid expressions read as "too raw" /
// over-smiley. `secondary` couples a subtle mouth shape into the emotion so
// faces aren't eyes-only (e.g. a happy face parts the lips slightly). The
// secondary viseme is MAX-blended against live lipsync so speech still wins.
// `blendDuration` is the cross-fade time in seconds. Modelled on airi's
// emotionStates, mapped to the emotions our setEmotion() accepts.
const EMOTION_STATES = {
    neutral:   { name: null,        cap: 0,    blendDuration: 0.6,  secondary: null },
    happy:     { name: "happy",     cap: 0.75, blendDuration: 0.4,  secondary: { aa: 0.2 } },
    sad:       { name: "sad",       cap: 0.7,  blendDuration: 0.4,  secondary: { oh: 0.15 } },
    angry:     { name: "angry",     cap: 0.7,  blendDuration: 0.3,  secondary: { ee: 0.3 } },
    surprised: { name: "surprised", cap: 0.8,  blendDuration: 0.15, secondary: { oh: 0.4 } },
    relaxed:   { name: "relaxed",   cap: 0.7,  blendDuration: 0.5,  secondary: null },
};

// Locomotion. The walk loop is the bundled VRMA below — baked in by design,
// no per-avatar config. Movement is kinematic "treadmill + slide":
// the walk clip plays in place (hips X/Z stripped at load) while the
// controller translates vrm.scene.position and turns toward the travel
// direction. Deliberately no pathfinding/collision — intended for open scenes
// like the grid playground; furnished GLBs will clip through props (a navmesh
// is the future upgrade if that starts to matter).
const WALK_VRMA_URL = "/assets/vrma/walking.vrma";
const MOVE_SPEED = 1.4;               // m/s — casual walk
const MOVE_TURN_SPEED = 6.0;          // rad/s toward the travel direction
const MOVE_ARRIVAL_THRESHOLD = 0.12;  // m — walkTo() stop distance
// Keep the avatar inside the playable area. The grid playground's sky shell
// sits at r=80 and the camera far plane at 100 — past ~35 m the floor's light
// pool is gone and there's nothing to walk to anyway.
const MOVE_BOUNDS_RADIUS = 35;
const WALK_FADE_IN = 0.25;            // s — idle/gesture → walk crossfade
const WALK_FADE_OUT = 0.35;           // s — walk → idle settle
// Camera follow smoothing: per-frame lerp factor 1 - exp(-RATE·dt). 5 settles
// in ~0.6 s — a soft trailing dolly rather than a rigid lock.
const CAM_FOLLOW_RATE = 5;

// Parsed walking.vrma, shared across avatar swaps (module-level: the FILE is
// avatar-independent; the AnimationClip built from it is not — see
// _ensureWalkAction, which re-binds per VRM).
let walkVrmaPromise = null;

// ── Multi-agent call layout ─────────────────────────────────────────────
// When peer avatars join (multi-agent calls), all characters are spread
// horizontally with this spacing, each turned slightly toward the group
// centre so the composition reads as people standing together, not a
// police lineup. The camera preset widens automatically to fit the row.
const CALL_SPACING_X = 1.1;          // metres between adjacent characters
const CALL_INWARD_YAW = 12 * Math.PI / 180;
const CALL_FRAME_SIDE_MARGIN = 0.6;  // metres of breathing room past the outermost head

// ── WebXR constants ─────────────────────────────────────────────────────
const XR_DOLLY_DISTANCE = 0.8;   // metres in front of the avatar for the VR camera rig
const XR_VR_BG = 0x0e1015;       // solid backdrop for immersive-vr (no passthrough)
// Humanoid bones the proximity touch-detector samples.
const XR_TOUCH_BONES = [
    "head", "neck", "upperChest", "chest", "spine", "hips",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
];

class AvatarRenderer {
    constructor() {
        this.libs = null;
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.mixer = null;
        this.idleClipAction = null;
        this._idleVrmaData = null;       // raw idle VRMA — retargetable onto a spawned combo partner at teardown
        this.vrm = null;
        this._vrmLoadGeneration = 0;     // monotonic — newest loadVRM wins; older results are disposed silently
        this.clock = null;
        this.activeCanvas = null;
        this.rafHandle = null;

        this._lookAtTarget = null;       // THREE.Object3D
        this._headBaseY = 0;             // local head bone Y (for breath anim)
        this._headWorldY = null;         // world head Y (for camera framing)
        this._meshTopY = null;           // top of VRM bounding box (hair / accessories)
        this._meshBottomY = null;        // bottom of VRM bounding box (feet)
        this._nextBlinkAt = 0;
        this._saccadeOffset = null;          // THREE.Vector3, created in _ensureRenderer
        this._nextSaccadeAt = undefined;     // scheduled gaze re-fixation time
        this._currentVowels = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        this._currentEmotion = "neutral";
        this._emotionTransitionProgress = 1; // 0..1; 1 = settled
        this._emotionTransitionStart = null; // {exprName: weight} captured on transition start
        this._emotionDecayTimer = null;      // pending settle-toward-neutral (see setEmotion)
        this._rawSpeakingIntensity = 0;   // set by setSpeakingIntensity()
        this._speakingIntensity = 0;      // smoothed for animation
        this._fullBody = false;           // false = face shot, true = full-body + orbit
        this._orbitControls = null;       // OrbitControls when fullBody mode active
        this._room = null;                // optional GLB environment behind the avatar (see loadRoom)
        this._loadedRoomUrl = null;       // url of the currently-loaded room — idempotency for repeated applies
        this._roomLoadGeneration = 0;     // monotonic — newest loadRoom/clearRoom wins; superseded in-flight loads self-dispose
        this._bgVideoEl = null;           // looping <video> backdrop for 'imagine_video' backgrounds
        this._bgVideoUrl = null;          // its url — idempotency for repeated applies/reparents

        // Locomotion state (see the MOVE_* constants above).
        this._moveMode = false;           // manual (WASD) input enabled by the full view toggle
        this._moveActorId = "base";       // which character WASD drives: "base" or a peer id (number keys)
        this._moveInput = { x: 0, z: 0 }; // camera-relative manual direction (x = strafe right, z = forward)
        this._moveTarget = null;          // THREE.Vector3 — walkTo() destination, or null
        this._moving = false;             // walk clip + slide currently active
        this._walkAction = null;          // looping walk action, bound to the current VRM's mixer
        this._baseQuat = null;            // vrm.scene orientation as normalised at load (see _setMoveYaw)
        this._moveYaw = 0;                // world yaw locomotion has applied on top of _baseQuat
        this._returnFacingY = null;       // target yaw for the ease-back-to-camera after stopping
        this._camFollowPos = null;        // THREE.Vector3 — smoothed avatar XZ the camera rig is anchored to

        // Peer avatars (multi-agent calls) — peerId → actor object holding
        // its own vrm/mixer/facial-animation state. Unlike the transient
        // combo partner below, peers are persistent call participants with
        // full blink/lipsync/emotion/gesture animation. The facial/idle
        // helpers (_applyIdle/_applyBlink/_applyVowels/_applyEmotion/…) are
        // parameterized over an "actor" — the base avatar's actor is `this`
        // (all the fields already live here), and each peer object carries
        // the same field names.
        this._peers = new Map();

        // Combo (two-character) gesture state — see playComboGesture.
        this._comboPartner = null;        // { vrm, mixer, action } — SPAWNED second VRM while a combo runs
        this._comboLivePeer = null;       // { peer, action, restore } — live call peer borrowed as the combo partner
        this._comboGeneration = 0;        // monotonic — newest playComboGesture wins; bumped on unload so in-flight loads self-cancel
        this._comboBaseRestore = null;    // { position, quaternion } — base avatar transform to restore on combo end
        this._comboAutoFullBody = false;  // combo auto-enabled full-body framing; undo on unload

        // Hardcoded vowel weight multipliers, calibrated for VRoid Studio's
        // standard viseme blendshapes. Used by _applyVowels to scale lipsync.
        this.expressionMap = { aa: 1.0, ih: 0.7, ou: 0.7, ee: 0.6, oh: 0.8 };

        // ── WebXR / VR state ────────────────────────────────────────────
        this._xrActive = false;           // true while an immersive session is presenting
        this._xrMode = null;              // "immersive-vr" | "immersive-ar"
        this._xrEnvMode = "skybox";       // "passthrough" (AR) | "skybox" — toggled in-session
        this._xrListenersWired = false;   // renderer.xr session listeners attached once
        // Viewer placement + recenter use the WebXR-native reference-space
        // offset (getOffsetReferenceSpace) — no dolly Group. See recenterXR().
        this._xrBaseRefSpace = null;      // base XRReferenceSpace captured at session start (for reset)
        this._xrPendingRecenter = false;  // place the viewer in front on the first XR frame
        this._savedSceneBackground = undefined;
        this._xrFrameCallbacks = new Set(); // per-XR-frame consumers (controllers, touch detection)
        this._xrSessionListeners = new Set(); // VR add-ons notified on session start/end (vr_manager)
        this._preVRMUpdateCallbacks = new Set(); // run after animation poses bones, before vrm.update (ragdoll write-back)
        this._xrHandColliderGroup = null; // runtime spring-bone collider group for the VR hands (see attachSpringBoneColliders)
        this._headWorldScratch = null;    // reused Vector3 for getHeadWorldPosition
        this._eyeScratch = null;          // reused Vector3 for the XR eye-contact base
    }

    /** Lazily build the renderer/scene/camera, exactly once.
     *
     *  MUST be concurrency-safe: more than one caller can race the cold init.
     *  loadVRM, loadRoom (via configureFromAvatar → _applyBackgroundToActiveHost)
     *  and mount all call this, and _hydrateAvatar fires configureFromAvatar
     *  immediately before loadVRM — so on first paint two callers hit this with
     *  `this.renderer` still null. Without memoisation each would `new
     *  THREE.WebGLRenderer()` and overwrite this.scene/this.renderer, leaving
     *  the avatar added to an orphaned scene the render loop never draws (blank
     *  canvas, and the singleton stays wedged across agent switches). The
     *  in-flight promise makes every concurrent caller await the same init. */
    _ensureRenderer() {
        if (this.renderer) return Promise.resolve();
        if (!this._ensureRendererPromise) {
            this._ensureRendererPromise = this._initRenderer();
        }
        return this._ensureRendererPromise;
    }

    async _initRenderer() {
        this.libs = await loadLibs();
        const { THREE } = this.libs;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        // Soft fill light + key light from camera direction.
        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(0.5, 1.5, 1);
        this.scene.add(ambient, key);

        this.camera = new THREE.PerspectiveCamera(FACE_FOV, 1, 0.1, 100);

        // Look-at target: a small empty positioned at the camera by default.
        this._lookAtTarget = new THREE.Object3D();
        this.scene.add(this._lookAtTarget);
        // Per-frame gaze offset applied by _applyEyeSaccade.
        this._saccadeOffset = new THREE.Vector3();

        // Apply face preset using the fallback head Y. Once a VRM loads,
        // _captureHeadWorldY re-applies with the model's actual head height.
        this._applyCameraPreset();

        this.clock = new THREE.Clock();

        // mount() may have run before this lazy init completed (the AvatarCanvas
        // host is attached on Owl's child-first mount, while loadVRM kicks off
        // from the parent's onMounted). _reparent / _resize were no-ops back
        // then because this.renderer was null — finish the attach now so the
        // canvas isn't left floating, invisible, in the document.
        if (this.activeCanvas) {
            this._reparent(this.activeCanvas);
            this._resize(this.activeCanvas);
        }
    }

    async loadVRM(url) {
        if (this._loadedVrmUrl === url && this.vrm) {
            return;  // already loaded — idempotent
        }
        const generation = ++this._vrmLoadGeneration;
        // Track the in-flight load so concurrent loadVRMA() calls (the side
        // panel hydration fires both fire-and-forget) can await us instead
        // of bailing on `!this.vrm` mid-swap and leaving the new avatar
        // without its idle clip.
        this._loadingVrmPromise = this._doLoadVRM(url, generation);
        try {
            await this._loadingVrmPromise;
        } finally {
            if (this._vrmLoadGeneration === generation) {
                this._loadingVrmPromise = null;
            }
        }
    }

    async _doLoadVRM(url, generation) {
        await this._ensureRenderer();
        const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin } = this.libs;

        // Track what URL we're targeting so a rapid second loadVRM(sameUrl)
        // dedupes via the idempotency check at the top of loadVRM.
        this._loadedVrmUrl = url;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

        const gltf = await loader.loadAsync(url);

        // A newer loadVRM() started while we were awaiting. Dispose our
        // freshly-loaded gltf and bail without touching the live scene —
        // otherwise rapid agent-dropdown switching stacks avatars (each
        // late-arriving load would add itself on top of the current one).
        if (this._vrmLoadGeneration !== generation) {
            try { VRMUtils.deepDispose(gltf.scene); } catch (e) { /* non-fatal */ }
            return;
        }

        // We're the latest. NOW tear down the previous VRM (deferred until
        // here so the old avatar stays rendered during the load — no blank
        // canvas mid-swap). Cached gesture clips were built via
        // createVRMAnimationClip(vrma, oldVrm) which bakes track names
        // against that vrm's per-instance "Normalized_*" helper hierarchy —
        // replaying them on a new model produces a flood of `No target node
        // found for track: Normalized_Hips...` warnings and, worse,
        // _gestureAction.isRunning() stays true on the dead action so
        // _applyIdle bails and the new avatar is stuck in T-pose.
        if (this.vrm) {
            this.scene.remove(this.vrm.scene);
            VRMUtils.deepDispose(this.vrm.scene);
            this.vrm = null;
        }
        if (this.mixer) {
            try { this.mixer.stopAllAction(); } catch (e) { /* non-fatal */ }
            this.mixer = null;
        }
        this.idleClipAction = null;
        this._gestureAction = null;
        this._currentGestureUrl = null;
        if (this._gestureClips) this._gestureClips.clear();
        // Partner belongs to the outgoing scene composition — drop it with
        // no exit fade (the base VRM it was staged around is being disposed).
        // Clear the restore snapshot first: it captured the OLD model's
        // transform and must not be applied to the incoming one.
        this._comboBaseRestore = null;
        this._unloadComboPartner({ immediate: true });
        this._walkAction = null;          // was bound to the disposed model's mixer
        this._moving = false;
        this._moveTarget = null;
        this._returnFacingY = null;
        this._camFollowPos = null;        // new model spawns at the origin — re-anchor

        const vrm = gltf.userData.vrm;
        if (!vrm) {
            throw new Error("Loaded GLTF did not contain a VRM model.");
        }
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        vrm.scene.traverse((obj) => {
            if (obj.isMesh) obj.frustumCulled = false;
        });
        // Orient the model to face our +Z camera. Instead of hardcoding a
        // per-metaVersion flip (VRM 0.x ships facing +Z, VRM 1.0 facing -Z —
        // but non-standard Blender exports don't always honour that), derive
        // the rotation from the VRM's own declared front direction: rotate so
        // lookAt.faceFront maps onto +Z (toward the camera). For spec-compliant
        // models this reproduces the old metaVersion flip exactly; for odd
        // exports it self-corrects. Ported from moeru-ai/airi's core.ts.
        // NOTE: orientation is hard to unit-check — verify visually in the app
        // that every avatar still faces forward; the `else` branch preserves
        // the previous behaviour if a VRM has no lookAt module.
        const vrmMetaVersion = vrm.meta?.metaVersion;
        const faceFront = vrm.lookAt?.faceFront;
        if (faceFront) {
            const front = faceFront.clone().normalize();
            const q = new THREE.Quaternion().setFromUnitVectors(front, new THREE.Vector3(0, 0, 1));
            vrm.scene.quaternion.premultiply(q);
        } else {
            vrm.scene.rotation.y = vrmMetaVersion === "1" ? 0 : Math.PI;
        }
        vrm.scene.updateMatrixWorld(true);
        // Orientation as normalised above, kept as a QUATERNION. Locomotion
        // composes its travel yaw on top of this (R_y(yaw) ∘ base — see
        // _setMoveYaw) rather than writing rotation.y: the faceFront
        // premultiply can sync the euler to the (±π, ~0, ±π) representation
        // of a 180° turn, and a naive rotation.y write on top of hidden
        // x/z = π yields a MIRRORED yaw (R(π, θ, π) ≡ R_y(π − θ)) — A/D
        // walked the wrong way round while W/S looked fine (sin 0 = sin π).
        this._baseQuat = vrm.scene.quaternion.clone();
        this._moveYaw = 0;
        console.log(`[voice] VRM loaded: metaVersion=${vrmMetaVersion}, faceFront=${faceFront ? faceFront.toArray().map((n) => n.toFixed(2)).join(",") : "n/a"}`);

        this.scene.add(vrm.scene);
        this.vrm = vrm;
        this._armSign = undefined;  // reset — re-detected on first _applyIdle tick
        this._fingerCurl = undefined;  // re-detected per VRM (1.0 rigs may curl on a non-Z axis)
        this.mixer = new THREE.AnimationMixer(vrm.scene);

        // Wire look-at if the VRM has a lookAt module.
        if (vrm.lookAt && this._lookAtTarget) {
            vrm.lookAt.target = this._lookAtTarget;
        }

        // Capture geometry for camera framing:
        // - head bone local Y → breath animation
        // - head bone world Y → reference point for face-shot lower bound
        // - mesh world bounding box → top of hair/accessories + foot floor;
        //   this is what `_cameraPreset` actually fits the camera to. Models
        //   with tall hair, horns, hats or other extensions above the head
        //   bone were being clipped when we framed only by head bone Y.
        // VRMs vary in stature, so framing must follow the actual height.
        try {
            // World matrix wasn't recomputed yet this frame — force it so
            // getWorldPosition + bounding box reflect the y-flip rotation.
            vrm.scene.updateMatrixWorld(true);
            const head = vrm.humanoid?.getNormalizedBoneNode?.("head");
            if (head) {
                this._headBaseY = head.position.y;
                const worldPos = new THREE.Vector3();
                head.getWorldPosition(worldPos);
                this._headWorldY = worldPos.y;
            }
            // Captured once, in rest pose, before procedural idle starts —
            // otherwise breath/sway would jitter the camera each frame.
            const box = new THREE.Box3().setFromObject(vrm.scene);
            if (isFinite(box.min.y) && isFinite(box.max.y)) {
                this._meshBottomY = box.min.y;
                this._meshTopY = box.max.y;
            }
        } catch (e) { /* non-fatal */ }

        // Re-aim camera now that we know how tall this VRM is.
        this._applyCameraPreset();

        // Settle spring bones (hair / cloth / accessories) into the model's
        // final orientation + rest pose so they don't visibly lurch to catch
        // up on the first few frames after an avatar / outfit swap.
        try { vrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
        // VR-session hand colliders survive an avatar swap: the new spring
        // bone manager needs the shared group re-registered.
        this._applySpringCollidersToVRM(vrm);

        this._scheduleNextBlink(this);
        this._scheduleNextSaccade(this.clock?.elapsedTime || 0);
        this._buildVisemeMap(this);
    }

    /**
     * After a VRM loads, discover which expression names it actually exposes
     * for each canonical viseme (aa/ih/ou/ee/oh).
     *
     * VRM 1.0 uses lowercase presets; VRM 0.x uses uppercase A/I/U/E/O.
     * @pixiv/three-vrm v3 normalises most 0.x names automatically, but
     * custom exports from Blender sometimes omit the preset mapping entirely
     * and only include the raw blendshape names. We probe all known aliases
     * and record the first one that resolves so _applyVowels can use it.
     */
    _buildVisemeMap(actor) {
        actor._visemeMap = null;
        const exp = actor.vrm?.expressionManager;
        if (!exp) return;

        // Aliases to probe per canonical vowel, in preference order.
        const ALIASES = {
            aa: ["aa", "A", "viseme_aa", "Fcl_MTH_A", "mouth_a"],
            ih: ["ih", "I", "viseme_ih", "Fcl_MTH_I", "mouth_i"],
            ou: ["ou", "U", "viseme_ou", "Fcl_MTH_U", "mouth_u"],
            ee: ["ee", "E", "viseme_ee", "Fcl_MTH_E", "mouth_e"],
            oh: ["oh", "O", "viseme_oh", "Fcl_MTH_O", "mouth_o"],
        };

        const map = {};
        for (const [canonical, aliases] of Object.entries(ALIASES)) {
            for (const alias of aliases) {
                // getExpression returns undefined/null when unknown.
                if (exp.getExpression?.(alias)) {
                    map[canonical] = alias;
                    break;
                }
            }
        }
        actor._visemeMap = map;

        const found = Object.entries(map).map(([k, v]) => `${k}→${v}`).join(", ");
        const missing = Object.keys(ALIASES).filter((k) => !map[k]);
        console.log("[voice] viseme map:", found || "(none)");
        if (missing.length) {
            console.warn("[voice] missing viseme expressions in this VRM:", missing.join(", "),
                "— mouth will not animate for those vowels.");
        }
    }

    async loadVRMA(url) {
        if (!url) return;
        // Side panel / full view fire loadVRM and loadVRMA concurrently when
        // hydrating after an avatar swap; without this wait we'd see `!vrm`
        // mid-swap and bail, leaving the new model with no canned idle.
        if (this._loadingVrmPromise) {
            try { await this._loadingVrmPromise; } catch (e) { /* */ }
        }
        if (!this.vrm || !this.mixer) return;
        const { GLTFLoader, VRMAnimationLoaderPlugin, createVRMAnimationClip } = this.libs;
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        const gltf = await loader.loadAsync(url);
        const vrma = gltf.userData.vrmAnimations?.[0];
        if (!vrma) return;
        const clip = createVRMAnimationClip(vrma, this.vrm);
        // Keep the raw VRMA too — it retargets onto any humanoid, so the
        // combo teardown can give a spawned partner this same idle to blend
        // into (see _unloadComboPartner's T-pose note).
        this._idleVrmaData = vrma;
        if (this.idleClipAction) {
            this.idleClipAction.stop();
        }
        this.idleClipAction = this.mixer.clipAction(clip);
        this.idleClipAction.play();
    }

    /** Play a VRMA gesture clip that overrides idle. Crossfades on entry and
     *  exit so transitions don't snap. Cached by URL so re-triggering the same
     *  gesture doesn't reload the file.
     *
     *  With `{ loop: true }` the clip repeats continuously instead of playing
     *  once and fading back to idle — useful for sustained body-language loops
     *  (e.g. a swaying dance, a breathing-heavy stance). The loop owns the body
     *  until another gesture/emotion replaces it or the VRM is reloaded
     *  (outfit/agent swap). Default (`loop: false`) is the original one-shot. */
    async playGesture(url, { loop = false } = {}) {
        if (!this.vrm || !this.mixer || !url) return;
        // Locomotion owns the body while walking — drop body gestures rather
        // than fight the walk clip for bones (face/emotion blendshapes still
        // apply; they're expressionManager-level).
        if (this._moving) return;
        // Any new gesture replaces a running (or still-loading) combo — the
        // partner fades out and the base avatar returns to its spot. No-op
        // when no combo is active.
        this._unloadComboPartner();
        // Lazy cache of loaded gesture clips keyed by URL.
        if (!this._gestureClips) this._gestureClips = new Map();
        // If the same gesture is already running, restart it from the beginning
        // rather than ignoring (user clicks "wave" twice → wave twice).
        if (this._gestureAction && this._currentGestureUrl === url) {
            this._gestureAction.reset().fadeIn(0.2).play();
            return;
        }
        let clip = this._gestureClips.get(url);
        if (!clip) {
            try {
                const { GLTFLoader, VRMAnimationLoaderPlugin, createVRMAnimationClip, THREE } = this.libs;
                const loader = new GLTFLoader();
                loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                const gltf = await loader.loadAsync(url);
                const vrma = gltf.userData.vrmAnimations?.[0];
                if (!vrma) return;
                clip = createVRMAnimationClip(vrma, this.vrm);
                clip.rexclawExpressions = this._vrmaExpressionNames(vrma);
                this._gestureClips.set(url, clip);
            } catch (e) {
                console.error("[voice] gesture load failed", url, e);
                return;
            }
        }
        const { THREE } = this.libs;

        // Crossfade timings. fadeOut is intentionally longer than fadeIn so the
        // settle back to idle is the most generous part of the transition —
        // that's where the previous "snap back" was most jarring.
        const FADE_IN = 0.25;
        const FADE_OUT = 0.5;

        // Stop any in-flight gesture so we don't blend two clips simultaneously.
        if (this._gestureAction) {
            this._gestureAction.fadeOut(0.15);
            const old = this._gestureAction;
            setTimeout(() => { try { old.stop(); } catch (e) { /* */ } }, 200);
        }

        // Fade the idle VRMA clip out so the gesture isn't fighting it for
        // bone weight. With both at full weight the mixer blends additively
        // ("wave + sway") and the gesture-end transition is sharper because
        // idle is already at full strength when the gesture's weight drops.
        if (this.idleClipAction) {
            this.idleClipAction.fadeOut(FADE_IN);
        }

        const action = this.mixer.clipAction(clip);

        // Looping gesture: repeat until something else replaces it. LoopRepeat
        // keeps action.isRunning() true, so _applyIdle stays suppressed and the
        // loop owns the body; the idle clip we faded out above stays out. No
        // "finished" handler — it never fires for a repeating action.
        if (loop) {
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.reset().fadeIn(FADE_IN).play();
            this._gestureAction = action;
            this._currentGestureUrl = url;
            return;
        }

        action.setLoop(THREE.LoopOnce, 1);
        // Hold the gesture's last pose so fadeOut has something to fade FROM.
        // With clampWhenFinished=false the action's weight goes to 0 the
        // instant the clip ends, making any subsequent fadeOut a no-op — that
        // was the root cause of the snap back to idle.
        action.clampWhenFinished = true;
        action.reset().fadeIn(FADE_IN).play();
        this._gestureAction = action;
        this._currentGestureUrl = url;

        // On finish, crossfade gesture → idle over the same window so the two
        // truly overlap rather than the idle slamming back at full weight.
        const onFinished = (ev) => {
            if (ev.action !== action) return;
            this.mixer.removeEventListener("finished", onFinished);
            action.fadeOut(FADE_OUT);
            if (this.idleClipAction) {
                this.idleClipAction.reset().fadeIn(FADE_OUT).play();
            }
            setTimeout(() => {
                if (this._gestureAction === action) {
                    try { action.stop(); } catch (e) { /* */ }
                    this._gestureAction = null;
                    this._currentGestureUrl = null;
                }
            }, FADE_OUT * 1000);
        };
        this.mixer.addEventListener("finished", onFinished);
    }

    /** Stop the current gesture — including a looping one, which never ends on
     *  its own — and ease back to idle. Mirrors the one-shot finish crossfade:
     *  keep `_gestureAction` set (and `isRunning()`) through the fade so
     *  procedural idle stays suppressed mid-crossfade, then stop+clear it.
     *  No-op when nothing is playing. */
    stopGesture() {
        // Combos ride _gestureAction for the base clip, so the fade below
        // covers them too — this additionally retires the partner character
        // and cancels a combo still downloading. No-op when none is active.
        this._unloadComboPartner();
        const action = this._gestureAction;
        if (!action) return;
        const FADE_OUT = 0.5;
        try { action.fadeOut(FADE_OUT); } catch (e) { /* */ }
        if (this.idleClipAction) {
            try { this.idleClipAction.reset().fadeIn(FADE_OUT).play(); } catch (e) { /* */ }
        }
        setTimeout(() => {
            if (this._gestureAction === action) {
                try { action.stop(); } catch (e) { /* */ }
                this._gestureAction = null;
                this._currentGestureUrl = null;
            }
        }, FADE_OUT * 1000);
    }

    // ------------------------------------------------------------------
    // Combo (two-character) gestures
    // ------------------------------------------------------------------

    /** Play a two-character combo gesture: the base avatar plays
     *  `combo.vrma_url` while a second VRM (`combo.partner_vrm_url`) is
     *  loaded into the scene playing `combo.partner_vrma_url` at the same
     *  time. Placement fields (offsets in metres, yaw in degrees) position
     *  both characters so independently-authored clips line up — dancing
     *  together, hugging, etc.
     *
     *  Both mixers tick with the same delta in _animate, so the clips stay
     *  in sync for free. With `loop` both repeat until another gesture /
     *  'idle' / set_emotion replaces them; one-shot combos end when the BASE
     *  clip finishes. Either way the partner is then disposed and the base
     *  avatar returns to where it stood (see _unloadComboPartner).
     *
     *  Partner VRMs are intentionally NOT cached: clips bake track names
     *  against a specific VRM instance and the model is disposed on unload —
     *  the browser HTTP cache makes replays cheap without holding tens of MB
     *  of geometry between plays. */
    async playComboGesture(combo) {
        if (!this.vrm || !this.mixer) return;
        if (!combo?.vrma_url || !combo?.partner_vrm_url || !combo?.partner_vrma_url) return;
        // Locomotion owns the body while walking — same rule as playGesture.
        if (this._moving) return;
        const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin,
                createVRMAnimationClip } = this.libs;

        const generation = ++this._comboGeneration;
        const vrmAtCall = this.vrm;

        // If the combo's partner character is ALREADY standing in the call
        // as a live peer avatar, borrow that model for the combo instead of
        // spawning a duplicate copy of the same character.
        const livePeer = this._findLiveComboPartner(combo);

        let partnerGltf = null;
        let baseVrma = null;
        let partnerVrma = null;
        try {
            const loadClip = async (url) => {
                const loader = new GLTFLoader();
                loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                const gltf = await loader.loadAsync(url);
                return gltf.userData.vrmAnimations?.[0] || null;
            };
            if (livePeer) {
                [baseVrma, partnerVrma] = await Promise.all([
                    loadClip(combo.vrma_url),
                    loadClip(combo.partner_vrma_url),
                ]);
            } else {
                const partnerLoader = new GLTFLoader();
                partnerLoader.register((parser) => new VRMLoaderPlugin(parser));
                [partnerGltf, baseVrma, partnerVrma] = await Promise.all([
                    partnerLoader.loadAsync(combo.partner_vrm_url),
                    loadClip(combo.vrma_url),
                    loadClip(combo.partner_vrma_url),
                ]);
            }
        } catch (e) {
            console.error("[voice] combo gesture load failed", combo.gesture_enum, e);
            return;
        }

        const partnerVrm = livePeer ? livePeer.vrm : partnerGltf?.userData?.vrm;
        // Superseded while downloading — a newer combo started, something
        // unloaded us (another gesture / 'idle' bumps _comboGeneration via
        // _unloadComboPartner), the base VRM was swapped, or the live peer
        // left the call / swapped outfits mid-download. Dispose any freshly
        // loaded partner and bail without touching the scene.
        if (generation !== this._comboGeneration || this.vrm !== vrmAtCall
            || !partnerVrm || !baseVrma || !partnerVrma
            || (livePeer && (!this._peers.has(livePeer.id) || livePeer.vrm !== partnerVrm))) {
            if (partnerGltf) {
                try { VRMUtils.deepDispose(partnerGltf.scene); } catch (e) { /* non-fatal */ }
            }
            return;
        }

        // Replace whatever combo/gesture is running before staging the pair.
        this._unloadComboPartner({ immediate: true, keepGeneration: true });

        // Placement rotation from the combo's config (degrees → radians).
        // Euler order YXZ premultiplied over the face-the-camera base reads
        // as: yaw turns the character on the spot, pitch tips it forward /
        // backward (90 = lying on its back), roll tilts it sideways —
        // identity when all three are 0, so plain standing combos are
        // untouched.
        const DEG = Math.PI / 180;
        const comboRotation = (yaw, pitch, roll) => new THREE.Quaternion().setFromEuler(
            new THREE.Euler((pitch || 0) * DEG, (yaw || 0) * DEG, (roll || 0) * DEG, "YXZ"));

        let partnerMixer;
        if (livePeer) {
            // ── Live peer as partner ─────────────────────────────────────
            // Snapshot its call-layout pose so _unloadComboPartner can put
            // it back where it stood, then apply the combo placement. Its
            // facial pipeline (lipsync/blink/emotion) keeps running — only
            // the body animation is taken over by the combo clip.
            this._comboLivePeer = {
                peer: livePeer,
                action: null,   // filled below once the action exists
                restore: {
                    position: partnerVrm.scene.position.clone(),
                    quaternion: partnerVrm.scene.quaternion.clone(),
                    scale: partnerVrm.scene.scale.clone(),
                },
            };
            partnerVrm.scene.quaternion.copy(livePeer._baseQuat || partnerVrm.scene.quaternion)
                .premultiply(comboRotation(combo.partner_yaw, combo.partner_pitch, combo.partner_roll));
            partnerVrm.scene.position.set(
                combo.partner_offset_x || 0,
                combo.partner_offset_y || 0,
                combo.partner_offset_z || 0,
            );
            const liveScale = combo.partner_scale || 1;
            if (liveScale !== 1) partnerVrm.scene.scale.setScalar(liveScale);
            partnerVrm.scene.updateMatrixWorld(true);
            try { partnerVrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
            // The peers render loop already ticks this mixer every frame —
            // _comboPartner stays null so it isn't double-ticked.
            partnerMixer = livePeer.mixer;
        } else {
            // ── Spawned partner setup — mirrors parts of _doLoadVRM ──────
            VRMUtils.removeUnnecessaryVertices(partnerGltf.scene);
            VRMUtils.combineSkeletons(partnerGltf.scene);
            partnerVrm.scene.traverse((obj) => {
                if (obj.isMesh) obj.frustumCulled = false;
            });
            // Normalise facing exactly like the base avatar (VRM 0.x vs 1.0),
            // then compose the configured rotation + placement on top.
            const faceFront = partnerVrm.lookAt?.faceFront;
            if (faceFront) {
                const front = faceFront.clone().normalize();
                const q = new THREE.Quaternion().setFromUnitVectors(front, new THREE.Vector3(0, 0, 1));
                partnerVrm.scene.quaternion.premultiply(q);
            } else {
                partnerVrm.scene.rotation.y = partnerVrm.meta?.metaVersion === "1" ? 0 : Math.PI;
            }
            partnerVrm.scene.quaternion.premultiply(
                comboRotation(combo.partner_yaw, combo.partner_pitch, combo.partner_roll));
            partnerVrm.scene.position.set(
                combo.partner_offset_x || 0,
                combo.partner_offset_y || 0,
                combo.partner_offset_z || 0,
            );
            const partnerScale = combo.partner_scale || 1;
            if (partnerScale !== 1) partnerVrm.scene.scale.setScalar(partnerScale);
            partnerVrm.scene.updateMatrixWorld(true);
            try { partnerVrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
            this.scene.add(partnerVrm.scene);
            partnerMixer = new THREE.AnimationMixer(partnerVrm.scene);
        }

        // ── Base placement — restored by _unloadComboPartner ─────────────
        this._comboBaseRestore = {
            position: this.vrm.scene.position.clone(),
            quaternion: this.vrm.scene.quaternion.clone(),
        };
        this.vrm.scene.position.set(
            combo.base_offset_x || 0,
            combo.base_offset_y || 0,
            combo.base_offset_z || 0,
        );
        // Compose the config rotation over the load-time orientation the same
        // way locomotion does (R ∘ _baseQuat) — see the mirrored-yaw note in
        // _doLoadVRM.
        this.vrm.scene.quaternion.copy(this._baseQuat).premultiply(
            comboRotation(combo.base_yaw, combo.base_pitch, combo.base_roll));
        this.vrm.scene.updateMatrixWorld(true);

        // Two characters need the wide shot; restore the face-shot on unload
        // only if we were the ones who switched. HMDs own the camera in XR.
        if (!this._fullBody && !this._xrActive) {
            this._comboAutoFullBody = true;
            this.setFullBodyMode(true);
        }

        // ── Actions — mirrors playGesture's crossfade choreography ───────
        const FADE_IN = 0.25;
        const FADE_OUT = 0.5;
        if (this._gestureAction) {
            const old = this._gestureAction;
            old.fadeOut(0.15);
            setTimeout(() => { try { old.stop(); } catch (e) { /* */ } }, 200);
        }
        if (this.idleClipAction) {
            this.idleClipAction.fadeOut(FADE_IN);
        }
        if (livePeer) {
            // The combo clip takes over the peer's body: retire any running
            // peer gesture and fade its idle out, exactly like the base side.
            if (livePeer._gestureAction) {
                const oldPeer = livePeer._gestureAction;
                oldPeer.fadeOut(0.15);
                setTimeout(() => { try { oldPeer.stop(); } catch (e) { /* */ } }, 200);
            }
            if (livePeer.idleClipAction) {
                livePeer.idleClipAction.fadeOut(FADE_IN);
            }
        }
        const baseAction = this.mixer.clipAction(createVRMAnimationClip(baseVrma, this.vrm));
        const partnerAction = partnerMixer.clipAction(createVRMAnimationClip(partnerVrma, partnerVrm));
        for (const action of [baseAction, partnerAction]) {
            if (combo.loop) {
                action.setLoop(THREE.LoopRepeat, Infinity);
                action.clampWhenFinished = false;
            } else {
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;  // hold last pose so fadeOut has a source
            }
            action.reset().fadeIn(FADE_IN).play();
        }
        // The base action doubles as _gestureAction so every existing rule —
        // procedural-idle suppression, stopGesture's 'idle' sentinel, the
        // replace-on-new-gesture path — applies to combos unmodified. The
        // synthetic URL key can't collide with a solo replay of the same file.
        this._gestureAction = baseAction;
        this._currentGestureUrl = `combo:${combo.gesture_enum || combo.vrma_url}`;
        if (livePeer) {
            // Registering the action as the peer's gesture keeps its
            // procedural idle suppressed for the duration; _comboPartner
            // stays null so the peers render loop remains the only ticker.
            livePeer._gestureAction = partnerAction;
            livePeer._currentGestureUrl = this._currentGestureUrl;
            this._comboLivePeer.action = partnerAction;
            this._comboPartner = null;
        } else {
            this._comboPartner = { vrm: partnerVrm, mixer: partnerMixer, action: partnerAction };
            // A partner staged mid-VR-session gets the hand colliders too,
            // like every other character.
            this._applySpringCollidersToVRM(partnerVrm);
            // Re-frame now that the partner is registered: the earlier
            // full-body switch ran before _comboPartner was set, so its
            // preset framed the base alone — with a wide partner_offset (or a
            // base_offset shifting the pair) the partner could sit outside
            // the shot. _cameraPreset counts the combo partner like a peer.
            if (!this._xrActive) this._applyCameraPreset();
        }

        if (combo.loop) return;  // loops end only by replacement — no finish event

        const onFinished = (ev) => {
            if (ev.action !== baseAction) return;
            this.mixer.removeEventListener("finished", onFinished);
            baseAction.fadeOut(FADE_OUT);
            if (this.idleClipAction) {
                this.idleClipAction.reset().fadeIn(FADE_OUT).play();
            }
            setTimeout(() => {
                if (this._gestureAction === baseAction) {
                    try { baseAction.stop(); } catch (e) { /* */ }
                    this._gestureAction = null;
                    this._currentGestureUrl = null;
                }
            }, FADE_OUT * 1000);
            this._unloadComboPartner();
        };
        this.mixer.addEventListener("finished", onFinished);
    }

    /** Find a live call peer whose avatar IS the combo's partner character
     *  (matched by avatar id when the combo references a stored avatar,
     *  falling back to the VRM url for file-upload partners). Returns the
     *  peer actor, or null → the combo spawns its own copy as before. */
    _findLiveComboPartner(combo) {
        for (const peer of this._peers.values()) {
            if (!peer.vrm || !peer.mixer) continue;
            const payload = peer.avatarPayload || {};
            if (combo.partner_avatar_id && Number(payload.id) === Number(combo.partner_avatar_id)) {
                return peer;
            }
            if (combo.partner_vrm_url
                && (peer._loadedVrmUrl === combo.partner_vrm_url
                    || payload.vrm_url === combo.partner_vrm_url)) {
                return peer;
            }
        }
        return null;
    }

    /** Tear down combo state: cancel any in-flight combo load, fade out and
     *  dispose the partner VRM (or hand a borrowed live peer back to its
     *  call-layout spot), put the base avatar back where it stood, and
     *  undo the auto full-body switch. Safe to call when no combo is active —
     *  playGesture/stopGesture call it unconditionally.
     *
     *  `immediate` skips the exit fade (used when the whole scene is being
     *  torn down anyway, e.g. _doLoadVRM). `keepGeneration` is for
     *  playComboGesture's own replace path, which has already claimed the
     *  latest generation and must not invalidate itself. */
    _unloadComboPartner({ immediate = false, keepGeneration = false } = {}) {
        if (!keepGeneration) this._comboGeneration++;
        // Base restore + camera revert are DEFERRED to the partner's dispose
        // in the fade path: snapping the base home and re-framing while the
        // partner is still fading out reads as the characters sliding
        // sideways before vanishing. One coherent cut at dispose instead.
        const restoreBase = () => {
            if (this._comboBaseRestore && this.vrm) {
                this.vrm.scene.position.copy(this._comboBaseRestore.position);
                this.vrm.scene.quaternion.copy(this._comboBaseRestore.quaternion);
                this.vrm.scene.updateMatrixWorld(true);
            }
            this._comboBaseRestore = null;
            if (this._comboAutoFullBody) {
                this._comboAutoFullBody = false;
                if (this._fullBody) this.setFullBodyMode(false);
            }
        };
        // Borrowed live peer: put it back where it stood in the call layout
        // and ease its own idle back in. It is NOT disposed — it's a call
        // participant, not a prop. Restore is immediate here — the peer
        // stays on screen, so there's no fade window to glitch through.
        const liveCombo = this._comboLivePeer;
        if (liveCombo) {
            restoreBase();
            this._comboLivePeer = null;
            const { peer, action, restore } = liveCombo;
            if (this._peers.has(peer.id) && peer.vrm) {
                peer.vrm.scene.position.copy(restore.position);
                peer.vrm.scene.quaternion.copy(restore.quaternion);
                peer.vrm.scene.scale.copy(restore.scale);
                peer.vrm.scene.updateMatrixWorld(true);
                try { peer.vrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
                if (action) {
                    if (immediate) {
                        try { action.stop(); } catch (e) { /* non-fatal */ }
                        if (peer._gestureAction === action) {
                            peer._gestureAction = null;
                            peer._currentGestureUrl = null;
                        }
                        if (peer.idleClipAction) {
                            try { peer.idleClipAction.reset().play(); } catch (e) { /* non-fatal */ }
                        }
                    } else {
                        try { action.fadeOut(0.5); } catch (e) { /* non-fatal */ }
                        if (peer.idleClipAction) {
                            try { peer.idleClipAction.reset().fadeIn(0.5).play(); } catch (e) { /* non-fatal */ }
                        }
                        setTimeout(() => {
                            if (peer._gestureAction === action) {
                                try { action.stop(); } catch (e) { /* non-fatal */ }
                                peer._gestureAction = null;
                                peer._currentGestureUrl = null;
                            }
                        }, 600);
                    }
                }
            }
        }
        const partner = this._comboPartner;
        if (!partner) {
            restoreBase();
            return;
        }
        const dispose = () => {
            // Identity check: a newer combo may have replaced us while the
            // exit fade ran — never clobber its partner (or its freshly
            // captured base placement) from a stale timeout.
            if (this._comboPartner === partner) {
                this._comboPartner = null;
                restoreBase();
                // Re-tighten the framing now the second character is gone.
                // (restoreBase's auto-full-body revert may have re-applied a
                // preset already; this covers the manual-full-body case.)
                if (!this._xrActive) this._applyCameraPreset();
            }
            try { partner.mixer.stopAllAction(); } catch (e) { /* non-fatal */ }
            try { this.scene.remove(partner.vrm.scene); } catch (e) { /* non-fatal */ }
            try { this.libs.VRMUtils.deepDispose(partner.vrm.scene); } catch (e) { /* non-fatal */ }
        };
        if (immediate) {
            dispose();
            return;
        }
        // Keep _comboPartner set through the fade — _animate ticks its mixer,
        // which is what actually animates the fadeOut — then dispose. The
        // fading flag makes _cameraPreset stop counting the partner, so any
        // mid-fade re-frame won't chase a character that's on its way out.
        partner.fading = true;
        // Crossfade the partner into the stock idle rather than just fading
        // its action out: with nothing else on the mixer a fadeOut blends the
        // skeleton back to its bind pose, which reads as a T-pose flash
        // before the dispose cut. The base avatar's idle VRMA retargets onto
        // the partner's humanoid, so both characters settle the same way.
        try {
            const makeClip = this.libs?.createVRMAnimationClip;
            if (this._idleVrmaData && makeClip) {
                partner.mixer.clipAction(makeClip(this._idleVrmaData, partner.vrm))
                    .reset().fadeIn(0.5).play();
                partner.action.fadeOut(0.5);
            }
            // No idle VRMA available: leave the action clamped on its final
            // pose until dispose — a held pose beats a T-pose blend.
        } catch (e) { /* non-fatal */ }
        setTimeout(dispose, 600);
    }

    // ------------------------------------------------------------------
    // Peer avatars (multi-agent calls)
    // ------------------------------------------------------------------
    //
    // A peer is a persistent second (third, …) character standing beside
    // the base avatar, each driven by its own agent connection: its own
    // lipsync feed, emotions, gestures and outfit. Structurally a peer is
    // an "actor" object carrying the same animation-state field names as
    // the renderer itself, so every parameterized helper
    // (_applyIdle/_applyBlink/_applyVowels/_applyEmotion/…) runs unchanged
    // on either. Unlike the combo partner (a transient animation prop),
    // peers live until removePeer().

    _makePeerActor(peerId) {
        return {
            id: peerId,
            vrm: null,
            mixer: null,
            idleClipAction: null,
            avatarPayload: null,
            _baseQuat: null,             // facing-normalised orientation (layout composes yaw on top)
            _loadGeneration: 0,          // newest load wins; superseded loads self-dispose
            _loadedVrmUrl: null,
            _gestureAction: null,
            _currentGestureUrl: null,
            _gestureClips: new Map(),
            // Locomotion state — peers are walkable too (number keys in
            // walk mode select which character WASD drives).
            _moving: false,
            _walkAction: null,
            _moveYaw: 0,
            _returnFacingY: null,
            _armSign: undefined,
            _fingerCurl: undefined,
            _currentVowels: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
            _currentEmotion: "neutral",
            _emotionTransitionProgress: 1,
            _emotionTransitionStart: null,
            _emotionDecayTimer: null,
            _rawSpeakingIntensity: 0,
            _speakingIntensity: 0,
            _headBaseY: 0,
            _nextBlinkAt: 0,
            _visemeMap: null,
        };
    }

    /** Load (or swap) a peer's avatar from its server payload and stand it
     *  beside the base avatar. Idempotent per (peerId, vrm_url). */
    async setPeerAvatar(peerId, avatarPayload) {
        if (!peerId || !avatarPayload?.vrm_url) return;
        await this._ensureRenderer();
        let peer = this._peers.get(peerId);
        if (!peer) {
            peer = this._makePeerActor(peerId);
            this._peers.set(peerId, peer);
        }
        peer.avatarPayload = avatarPayload;
        await this._loadPeerModel(peer, avatarPayload.vrm_url, avatarPayload.vrma_idle_url || null);
    }

    /** Swap a peer's outfit (same character, different VRM). */
    async setPeerOutfit(peerId, vrmUrl, vrmaIdleUrl = null) {
        const peer = this._peers.get(peerId);
        if (!peer || !vrmUrl) return;
        await this._loadPeerModel(peer, vrmUrl, vrmaIdleUrl || peer.avatarPayload?.vrma_idle_url || null);
    }

    async _loadPeerModel(peer, vrmUrl, idleUrl) {
        if (peer._loadedVrmUrl === vrmUrl && peer.vrm) return;  // idempotent
        const generation = ++peer._loadGeneration;
        peer._loadedVrmUrl = vrmUrl;
        const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin,
                createVRMAnimationClip } = this.libs;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        let gltf;
        try {
            gltf = await loader.loadAsync(vrmUrl);
        } catch (e) {
            console.error("[voice] peer VRM load failed", vrmUrl, e);
            if (peer._loadGeneration === generation) peer._loadedVrmUrl = null;
            return;
        }
        // Superseded while downloading (newer load / removePeer) — discard.
        if (peer._loadGeneration !== generation || !this._peers.has(peer.id)) {
            try { VRMUtils.deepDispose(gltf.scene); } catch (e) { /* non-fatal */ }
            return;
        }
        const vrm = gltf.userData.vrm;
        if (!vrm) {
            console.error("[voice] peer GLTF did not contain a VRM model");
            return;
        }
        // Tear down the previous model only now (deferred so the old avatar
        // stays rendered during the download — no blank slot mid-swap).
        this._disposePeerModel(peer);

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        vrm.scene.traverse((obj) => {
            if (obj.isMesh) obj.frustumCulled = false;
        });
        // Normalise facing exactly like the base avatar (VRM 0.x vs 1.0).
        const faceFront = vrm.lookAt?.faceFront;
        if (faceFront) {
            const front = faceFront.clone().normalize();
            const q = new THREE.Quaternion().setFromUnitVectors(front, new THREE.Vector3(0, 0, 1));
            vrm.scene.quaternion.premultiply(q);
        } else {
            vrm.scene.rotation.y = vrm.meta?.metaVersion === "1" ? 0 : Math.PI;
        }
        vrm.scene.updateMatrixWorld(true);
        peer._baseQuat = vrm.scene.quaternion.clone();

        this.scene.add(vrm.scene);
        peer.vrm = vrm;
        peer.mixer = new THREE.AnimationMixer(vrm.scene);
        // Fresh per-model animation state — the detectors re-run on the new rig.
        peer._armSign = undefined;
        peer._fingerCurl = undefined;
        peer._gestureAction = null;
        peer._currentGestureUrl = null;
        peer._gestureClips.clear();

        // Shared look-at target: peers make eye contact with the camera too.
        if (vrm.lookAt && this._lookAtTarget) {
            vrm.lookAt.target = this._lookAtTarget;
        }
        try {
            const head = vrm.humanoid?.getNormalizedBoneNode?.("head");
            if (head) peer._headBaseY = head.position.y;
        } catch (e) { /* non-fatal */ }
        try { vrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
        this._applySpringCollidersToVRM(vrm);

        this._scheduleNextBlink(peer);
        this._buildVisemeMap(peer);

        // Idle VRMA (optional).
        if (idleUrl) {
            try {
                const idleLoader = new GLTFLoader();
                idleLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                const idleGltf = await idleLoader.loadAsync(idleUrl);
                const vrma = idleGltf.userData.vrmAnimations?.[0];
                if (vrma && peer._loadGeneration === generation && peer.vrm === vrm) {
                    peer.idleClipAction = peer.mixer.clipAction(createVRMAnimationClip(vrma, vrm));
                    peer.idleClipAction.play();
                }
            } catch (e) {
                console.warn("[voice] peer idle VRMA load failed", idleUrl, e);
            }
        }

        this._layoutCallAvatars();
        console.log(`[voice] peer avatar loaded (${peer.id}):`, vrmUrl);
    }

    _disposePeerModel(peer) {
        if (!peer.vrm) return;
        // If this peer is currently borrowed as a combo partner, retire the
        // whole combo first — otherwise the base avatar keeps performing a
        // two-character clip alone in combo placement. Covers both peer
        // removal and mid-combo outfit swaps (both route through here).
        if (this._comboLivePeer?.peer === peer) {
            this._unloadComboPartner({ immediate: true });
        }
        const { VRMUtils } = this.libs || {};
        try { peer.mixer?.stopAllAction(); } catch (e) { /* non-fatal */ }
        try {
            this.scene.remove(peer.vrm.scene);
            VRMUtils?.deepDispose?.(peer.vrm.scene);
        } catch (e) { /* non-fatal */ }
        peer.vrm = null;
        peer.mixer = null;
        peer.idleClipAction = null;
        peer._gestureAction = null;
        peer._currentGestureUrl = null;
        peer._gestureClips.clear();
        // Bound to the disposed model's mixer — rebuilt on the next walk.
        peer._walkAction = null;
        peer._moving = false;
        peer._returnFacingY = null;
    }

    /** Remove a peer from the scene (agent left the call). Restores the
     *  solo layout when the last peer leaves. */
    removePeer(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) return;
        peer._loadGeneration++;   // cancel any in-flight load
        if (peer._emotionDecayTimer) clearTimeout(peer._emotionDecayTimer);
        this._disposePeerModel(peer);
        this._peers.delete(peerId);
        this._layoutCallAvatars();
    }

    get peerCount() {
        return this._peers.size;
    }

    setPeerVowels(peerId, vowels) {
        const peer = this._peers.get(peerId);
        if (peer) peer._currentVowels = vowels;
    }

    setPeerSpeakingIntensity(peerId, value) {
        const peer = this._peers.get(peerId);
        if (peer) peer._rawSpeakingIntensity = Math.max(0, Math.min(1, value || 0));
    }

    setPeerEmotion(peerId, name) {
        const peer = this._peers.get(peerId);
        if (!peer || !EMOTION_STATES[name]) return;
        peer._currentEmotion = name;
        peer._emotionTransitionProgress = 0;
        peer._emotionTransitionStart = null;
        // Same decay policy as the base avatar's setEmotion, scoped to the
        // peer and keyed off the peer's own avatar config.
        if (peer._emotionDecayTimer) {
            clearTimeout(peer._emotionDecayTimer);
            peer._emotionDecayTimer = null;
        }
        const settleTo = emotionSettleTarget(name, peer.avatarPayload?.name);
        if (settleTo && emotionDecayEnabled(peer.avatarPayload)) {
            peer._emotionDecayTimer = setTimeout(() => {
                peer._emotionDecayTimer = null;
                this.setPeerEmotion(peerId, settleTo);
            }, EMOTION_DECAY_MS);
        }
    }

    /** Play a VRMA gesture on a peer. Mirrors playGesture's crossfade
     *  choreography, scoped to the peer's mixer/idle action. Combos are
     *  base-avatar-only (the dispatcher falls back to the solo clip). */
    async playPeerGesture(peerId, url, { loop = false } = {}) {
        const peer = this._peers.get(peerId);
        if (!peer?.vrm || !peer.mixer || !url) return;
        // This peer may currently be borrowed as a combo partner — a fresh
        // gesture on it retires the whole combo first (both characters),
        // mirroring how a new base gesture replaces a running combo.
        if (this._comboLivePeer?.peer === peer) {
            this._unloadComboPartner();
        }
        const { THREE, GLTFLoader, VRMAnimationLoaderPlugin, createVRMAnimationClip } = this.libs;
        if (peer._gestureAction && peer._currentGestureUrl === url) {
            peer._gestureAction.reset().fadeIn(0.2).play();
            return;
        }
        let clip = peer._gestureClips.get(url);
        if (!clip) {
            try {
                const loader = new GLTFLoader();
                loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                const gltf = await loader.loadAsync(url);
                const vrma = gltf.userData.vrmAnimations?.[0];
                if (!vrma || !peer.vrm) return;
                clip = createVRMAnimationClip(vrma, peer.vrm);
                clip.rexclawExpressions = this._vrmaExpressionNames(vrma);
                peer._gestureClips.set(url, clip);
            } catch (e) {
                console.error("[voice] peer gesture load failed", url, e);
                return;
            }
        }
        const FADE_IN = 0.25;
        const FADE_OUT = 0.5;
        if (peer._gestureAction) {
            const old = peer._gestureAction;
            old.fadeOut(0.15);
            setTimeout(() => { try { old.stop(); } catch (e) { /* */ } }, 200);
        }
        if (peer.idleClipAction) {
            peer.idleClipAction.fadeOut(FADE_IN);
        }
        const action = peer.mixer.clipAction(clip);
        if (loop) {
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.reset().fadeIn(FADE_IN).play();
            peer._gestureAction = action;
            peer._currentGestureUrl = url;
            return;
        }
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;   // hold last pose so fadeOut has a source
        action.reset().fadeIn(FADE_IN).play();
        peer._gestureAction = action;
        peer._currentGestureUrl = url;
        const onFinished = (ev) => {
            if (ev.action !== action) return;
            peer.mixer.removeEventListener("finished", onFinished);
            action.fadeOut(FADE_OUT);
            if (peer.idleClipAction) {
                peer.idleClipAction.reset().fadeIn(FADE_OUT).play();
            }
            setTimeout(() => {
                if (peer._gestureAction === action) {
                    try { action.stop(); } catch (e) { /* */ }
                    peer._gestureAction = null;
                    peer._currentGestureUrl = null;
                }
            }, FADE_OUT * 1000);
        };
        peer.mixer.addEventListener("finished", onFinished);
    }

    /** Stop a peer's gesture (incl. loops) and ease back to its idle. */
    stopPeerGesture(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) return;
        // Borrowed as a combo partner: 'idle' retires the whole combo (both
        // characters return to their spots) — same as stopGesture on base.
        if (this._comboLivePeer?.peer === peer) {
            this._unloadComboPartner();
            return;
        }
        const action = peer._gestureAction;
        if (!action) return;
        const FADE_OUT = 0.5;
        try { action.fadeOut(FADE_OUT); } catch (e) { /* */ }
        if (peer.idleClipAction) {
            try { peer.idleClipAction.reset().fadeIn(FADE_OUT).play(); } catch (e) { /* */ }
        }
        setTimeout(() => {
            if (peer._gestureAction === action) {
                try { action.stop(); } catch (e) { /* */ }
                peer._gestureAction = null;
                peer._currentGestureUrl = null;
            }
        }, FADE_OUT * 1000);
    }

    /** Arrange base + peers in a horizontal row, each turned slightly
     *  toward the group centre, then re-frame the camera. Solo layout
     *  (base at origin, facing camera) is restored when no peers remain. */
    _layoutCallAvatars() {
        const peers = [...this._peers.values()].filter((p) => p.vrm);
        const n = 1 + peers.length;
        if (n === 1) {
            if (this.vrm) {
                this.vrm.scene.position.set(0, 0, 0);
                this._setMoveYaw(this, 0);
                this.vrm.scene.updateMatrixWorld(true);
            }
            this._applyCameraPreset();
            return;
        }
        const { THREE } = this.libs;
        const xFor = (i) => (i - (n - 1) / 2) * CALL_SPACING_X;
        // Facing +Z (camera) is yaw 0; a character at x turns toward the
        // group centre by -sign(x) * inward yaw.
        const yawFor = (x) => (Math.abs(x) < 1e-6 ? 0 : -Math.sign(x) * CALL_INWARD_YAW);

        if (this.vrm) {
            const x = xFor(0);
            this.vrm.scene.position.set(x, 0, 0);
            this._setMoveYaw(this, yawFor(x));
            this.vrm.scene.updateMatrixWorld(true);
        }
        peers.forEach((peer, idx) => {
            const x = xFor(idx + 1);
            peer.vrm.scene.position.set(x, 0, 0);
            // Track the layout yaw so a later manual walk turn interpolates
            // from the pose the peer is actually standing in.
            peer._moveYaw = yawFor(x);
            if (peer._baseQuat) {
                const yawQuat = new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(0, 1, 0), yawFor(x));
                peer.vrm.scene.quaternion.copy(yawQuat).multiply(peer._baseQuat);
            }
            peer.vrm.scene.updateMatrixWorld(true);
            try { peer.vrm.springBoneManager?.reset(); } catch (e) { /* non-fatal */ }
        });
        this._applyCameraPreset();
    }

    // ------------------------------------------------------------------
    // Locomotion (see MOVE_* constants at the top of the file)
    // ------------------------------------------------------------------

    /** Enable/disable manual (WASD) movement. Disabling releases held input
     *  and settles the avatar to a stop. Driven by the full view's toggle. */
    setMoveMode(enabled) {
        this._moveMode = !!enabled;
        if (!enabled) {
            this._moveInput.x = 0;
            this._moveInput.z = 0;
            this.stopMoving();
            // Next walk session starts predictably on the main avatar.
            this._moveActorId = "base";
        }
    }

    /** The actor manual walk input currently steers: the base avatar or a
     *  live peer. Number keys in walk mode switch the selection
     *  (setMoveActor). Falls back to the base avatar if the selected peer
     *  left the call. */
    _moveActor() {
        if (this._moveActorId && this._moveActorId !== "base") {
            const peer = this._peers.get(this._moveActorId);
            if (peer?.vrm) return peer;
            this._moveActorId = "base";
        }
        return this;
    }

    /** Select which character walk input drives: "base" or a peer id.
     *  Releases the previous actor (its walk animation settles to idle)
     *  and re-anchors the follow camera on the new one. Returns true when
     *  the selection is valid. */
    setMoveActor(actorId) {
        const current = this._moveActor();
        let next;
        if (!actorId || actorId === "base") {
            this._moveActorId = "base";
            next = this;
        } else {
            const peer = this._peers.get(actorId);
            if (!peer?.vrm) return false;
            this._moveActorId = actorId;
            next = peer;
        }
        if (current !== next) {
            this._moveTarget = null;
            if (current._moving) this._stopWalkAnim(current);
            // Snap the camera onto the NEW actor, centred: keep the
            // camera's current offset vector from its look-target (same
            // viewing angle + zoom) but place the target on the actor.
            // Translating by the follow-anchor delta (previous approach)
            // preserved the group-framing offset — the rig looks at the
            // ROW's midpoint, not at any one character — so the selected
            // character ended up at the edge of frame instead of centred.
            if (next.vrm && this.camera && this.libs) {
                const np = next.vrm.scene.position;
                if (this._orbitControls) {
                    const t = this._orbitControls.target;
                    const ox = this.camera.position.x - t.x;
                    const oz = this.camera.position.z - t.z;
                    t.x = np.x;
                    t.z = np.z;
                    this.camera.position.x = np.x + ox;
                    this.camera.position.z = np.z + oz;
                    this._orbitControls.update?.();
                } else {
                    const anchor = this._camFollowPos
                        || (current.vrm ? current.vrm.scene.position : np);
                    this.camera.position.x += np.x - anchor.x;
                    this.camera.position.z += np.z - anchor.z;
                }
                this._camFollowPos = new this.libs.THREE.Vector3(np.x, 0, np.z);
            } else {
                this._camFollowPos = null;
            }
        }
        return true;
    }

    /** Manual movement direction, camera-relative: x = strafe right, z =
     *  forward (away from the camera). (0,0) = no input. Fed on key change by
     *  the full view's WASD handler; consumed per-frame in _updateMovement. */
    setMoveInput(x, z) {
        this._moveInput.x = Math.max(-1, Math.min(1, x || 0));
        this._moveInput.z = Math.max(-1, Math.min(1, z || 0));
    }

    /** Walk the SELECTED actor to a world-space XZ position: turn toward
     *  it, advance, settle to idle on arrival. The foundation the future
     *  semantic move tool (approach / step_back / anchors) will compose on. */
    walkTo(x, z) {
        if (!this._moveActor().vrm || !this.libs) return;
        const { THREE } = this.libs;
        // Clamp the destination into the playable area, preserving direction.
        const r = Math.hypot(x, z);
        if (r > MOVE_BOUNDS_RADIUS) {
            x *= MOVE_BOUNDS_RADIUS / r;
            z *= MOVE_BOUNDS_RADIUS / r;
        }
        this._moveTarget = new THREE.Vector3(x, 0, z);
    }

    /** Characters currently in the scene, for VR placement: the base avatar
     *  plus live peers. Each entry exposes the scene root so callers can read
     *  world positions without reaching into renderer internals. */
    listActors() {
        const out = [];
        if (this.vrm) out.push({ id: "base", node: this.vrm.scene });
        for (const [id, peer] of this._peers) {
            if (peer.vrm) out.push({ id, node: peer.vrm.scene });
        }
        return out;
    }

    /** Walk a specific character to a world XZ spot (VR move mode: point at
     *  the floor, pull the trigger). Selects the actor then reuses walkTo's
     *  turn-advance-settle locomotion. Returns false for unknown actors. */
    walkActorTo(actorId, x, z) {
        if (!this.setMoveActor(actorId)) return false;
        this.walkTo(x, z);
        return true;
    }

    /** Rotate a character in place by dYaw radians (VR move mode thumbstick).
     *  Composes onto the locomotion yaw so a later walk turns from the pose
     *  she's actually standing in. */
    turnActor(actorId, dYaw) {
        const actor = (!actorId || actorId === "base") ? this : this._peers.get(actorId);
        if (!actor?.vrm || !dYaw) return;
        this._setMoveYaw(actor, actor._moveYaw + dYaw);
    }

    /** Stop any walking (manual or walkTo) and ease back to idle — every
     *  actor, not just the selected one, so a mid-walk selection switch
     *  can't strand a character in its walk cycle. */
    stopMoving() {
        this._moveTarget = null;
        if (this._moving) this._stopWalkAnim(this);
        for (const peer of this._peers.values()) {
            if (peer._moving) this._stopWalkAnim(peer);
        }
    }

    /** Lazily build the looping walk action for an actor's CURRENT vrm. The
     *  parsed walking.vrma is cached module-wide (avatar-independent), but
     *  the AnimationClip is baked against a specific model's normalized
     *  bones, so it's rebuilt after every avatar/outfit swap. */
    async _ensureWalkAction(actor) {
        if (actor._walkAction) return actor._walkAction;
        if (!actor.vrm || !actor.mixer) return null;
        const vrmAtCall = actor.vrm;
        try {
            const { GLTFLoader, VRMAnimationLoaderPlugin, createVRMAnimationClip, THREE } = this.libs;
            if (!walkVrmaPromise) {
                const loader = new GLTFLoader();
                loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                walkVrmaPromise = loader.loadAsync(WALK_VRMA_URL)
                    .then((gltf) => gltf.userData.vrmAnimations?.[0] || null)
                    .catch((e) => {
                        walkVrmaPromise = null;  // allow a retry on next walk
                        throw e;
                    });
            }
            const vrma = await walkVrmaPromise;
            // Avatar swapped while the file downloaded — the caller's mixer is
            // gone; the next walk on the new model will rebuild.
            if (!vrma || actor.vrm !== vrmAtCall || !actor.mixer) return null;
            const clip = createVRMAnimationClip(vrma, actor.vrm);
            this._stripWalkRootMotion(actor, clip);
            const action = actor.mixer.clipAction(clip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            actor._walkAction = action;
            return action;
        } catch (e) {
            console.error("[voice] walk clip load failed", WALK_VRMA_URL, e);
            return null;
        }
    }

    /** Zero the hips-position X/Z tracks so the walk cycle runs in place —
     *  the movement controller owns world translation. Mixamo-converted walk
     *  clips usually advance the hips each cycle; unstripped, the avatar
     *  lurches forward and snaps back every loop. Y is kept (vertical bob). */
    _stripWalkRootMotion(actor, clip) {
        const hipsName = actor.vrm.humanoid?.getNormalizedBoneNode?.("hips")?.name;
        if (!hipsName) return;
        for (const track of clip.tracks) {
            if (track.name !== `${hipsName}.position`) continue;
            for (let i = 0; i < track.values.length; i += 3) {
                track.values[i] = 0;
                track.values[i + 2] = 0;
            }
        }
    }

    /** Crossfade an actor into the walk loop. Async because the first walk
     *  lazily loads walking.vrma — `_moving` is set synchronously so
     *  per-frame callers don't re-enter while the file downloads. */
    async _startWalkAnim(actor) {
        if (actor._moving) return;
        actor._moving = true;
        actor._returnFacingY = null;
        // Movement owns the body: ease out any in-flight gesture first
        // (for the base this also retires a running combo).
        if (actor === this) this.stopGesture();
        else this.stopPeerGesture(actor.id);
        const action = await this._ensureWalkAction(actor);
        if (!action) return;             // load failed — slide without the clip
        if (!actor._moving) return;      // stopped while the clip downloaded
        if (actor.idleClipAction) actor.idleClipAction.fadeOut(WALK_FADE_IN);
        action.reset().fadeIn(WALK_FADE_IN).play();
    }

    /** Crossfade walk → idle and queue the ease-back-to-camera facing. Same
     *  fade-then-stop pattern as gestures (a faded-out action still counts as
     *  isRunning, which would wedge the procedural-idle guard). */
    _stopWalkAnim(actor) {
        actor._moving = false;
        const action = actor._walkAction;
        if (action) {
            action.fadeOut(WALK_FADE_OUT);
            setTimeout(() => {
                if (!actor._moving) { try { action.stop(); } catch (e) { /* */ } }
            }, WALK_FADE_OUT * 1000);
        }
        if (actor.idleClipAction) actor.idleClipAction.reset().fadeIn(WALK_FADE_OUT).play();
        // A companion turns to face you when she stops — not frozen
        // mid-stride aimed at a wall. Eased per-frame in _applyReturnFacing.
        // In XR "you" is the headset, not the flat camera.
        if (actor.vrm) {
            const p = actor.vrm.scene.position;
            let cx = null, cz = null;
            if (this._xrActive && this.renderer?.xr?.getCamera && this.libs) {
                const v = (this._facingScratch ||= new this.libs.THREE.Vector3());
                this.renderer.xr.getCamera().getWorldPosition(v);
                cx = v.x; cz = v.z;
            } else if (this.camera) {
                cx = this.camera.position.x; cz = this.camera.position.z;
            }
            if (cx !== null) actor._returnFacingY = Math.atan2(cx - p.x, cz - p.z);
        }
    }

    /** Per-frame locomotion. Manual input wins over a walkTo target. Steering
     *  is kinematic: rotate toward the travel direction at
     *  MOVE_TURN_SPEED while advancing at MOVE_SPEED — the walk clip plays in
     *  place; THIS is what moves the avatar. */
    _updateMovement(delta) {
        const actor = this._moveActor();
        if (!actor.vrm || !this.libs) return;
        const { THREE } = this.libs;
        let dir = null;

        if (this._moveMode && (this._moveInput.x || this._moveInput.z)) {
            // Camera-relative axes: W walks away from the camera.
            const fwd = new THREE.Vector3();
            this.camera.getWorldDirection(fwd);
            fwd.y = 0;
            if (fwd.lengthSq() > 1e-6) {
                fwd.normalize();
                const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
                dir = new THREE.Vector3()
                    .addScaledVector(fwd, this._moveInput.z)
                    .addScaledVector(right, this._moveInput.x);
                dir = dir.lengthSq() > 1e-6 ? dir.normalize() : null;
            }
            this._moveTarget = null;  // live input overrides a queued walkTo
        } else if (this._moveTarget) {
            const d = new THREE.Vector3().subVectors(this._moveTarget, actor.vrm.scene.position);
            d.y = 0;
            if (d.length() < MOVE_ARRIVAL_THRESHOLD) {
                this.stopMoving();
                return;
            }
            dir = d.normalize();
        }

        if (!dir) {
            if (actor._moving) this._stopWalkAnim(actor);  // keys released mid-walk
            this._applyReturnFacing(actor, delta);
            return;
        }

        if (!actor._moving) this._startWalkAnim(actor);
        actor._returnFacingY = null;

        // Turn the shortest way toward the travel direction, then advance.
        // Yaw is composed onto the base quaternion (_setMoveYaw) — never
        // written through rotation.y; see the _baseQuat note in _doLoadVRM.
        const targetYaw = Math.atan2(dir.x, dir.z);
        let diff = targetYaw - actor._moveYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const turnStep = MOVE_TURN_SPEED * delta;
        this._setMoveYaw(actor, Math.abs(diff) <= turnStep
            ? targetYaw
            : actor._moveYaw + Math.sign(diff) * turnStep);

        const pos = actor.vrm.scene.position;
        pos.addScaledVector(dir, MOVE_SPEED * delta);
        const r = Math.hypot(pos.x, pos.z);
        if (r > MOVE_BOUNDS_RADIUS) {
            pos.x *= MOVE_BOUNDS_RADIUS / r;
            pos.z *= MOVE_BOUNDS_RADIUS / r;
        }
    }

    /** After stopping, ease the actor around to face the camera again —
     *  gentler than travel turns so it reads as a casual turn, not a snap. */
    _applyReturnFacing(actor, delta) {
        if (actor._returnFacingY == null || !actor.vrm) return;
        let diff = actor._returnFacingY - actor._moveYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const step = MOVE_TURN_SPEED * 0.6 * delta;
        if (Math.abs(diff) <= step) {
            this._setMoveYaw(actor, actor._returnFacingY);
            actor._returnFacingY = null;
        } else {
            this._setMoveYaw(actor, actor._moveYaw + Math.sign(diff) * step);
        }
    }

    /** Point an actor at a world yaw by composing R_y(yaw) onto its
     *  load-time base orientation: quaternion = R_y(yaw) ∘ _baseQuat. The
     *  base may be a euler-hostile 180° flip ((±π, ~0, ±π) representation),
     *  so rotation.y is never written directly — quaternion composition is
     *  representation-proof. yaw 0 = facing +Z (toward the default camera). */
    _setMoveYaw(actor, yaw) {
        actor._moveYaw = yaw;
        if (!actor.vrm || !actor._baseQuat || !this.libs) return;
        const { THREE } = this.libs;
        if (!this._yawQuat) {
            this._yawQuat = new THREE.Quaternion();
            this._yawAxis = new THREE.Vector3(0, 1, 0);
        }
        this._yawQuat.setFromAxisAngle(this._yawAxis, yaw);
        actor.vrm.scene.quaternion.copy(this._yawQuat).multiply(actor._baseQuat);
    }

    /** Trailing camera dolly: translate the camera AND the orbit target by
     *  the avatar's smoothed XZ displacement. Pure translation — height, zoom
     *  and orbit angle are untouched, so face-shot and full-body framings
     *  both keep their composition while following. Cheap no-op when the
     *  avatar isn't moving. */
    _updateFollowCamera(delta) {
        const actor = this._moveActor();
        if (!actor.vrm || !this.camera || !this.libs) return;
        const { THREE } = this.libs;
        const p = actor.vrm.scene.position;
        if (!this._camFollowPos) {
            // (Re-)anchor without moving the camera — set by VRM load and
            // _applyCameraPreset, both of which place the camera absolutely.
            this._camFollowPos = new THREE.Vector3(p.x, 0, p.z);
            return;
        }
        const k = 1 - Math.exp(-CAM_FOLLOW_RATE * delta);
        const dx = (p.x - this._camFollowPos.x) * k;
        const dz = (p.z - this._camFollowPos.z) * k;
        if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return;
        this.camera.position.x += dx;
        this.camera.position.z += dz;
        if (this._orbitControls) {
            this._orbitControls.target.x += dx;
            this._orbitControls.target.z += dz;
        }
        this._camFollowPos.x += dx;
        this._camFollowPos.z += dz;
    }

    /** Return the avatar (and framing) to the origin spawn. Used when the
     *  scene background is switched away — a flat backdrop has no "place", so
     *  a wandered-off avatar would otherwise be standing somewhere arbitrary
     *  relative to the freshly reset camera. */
    _resetAvatarHome() {
        if (!this.vrm) return;
        this._moveTarget = null;
        this._moveInput.x = 0;
        this._moveInput.z = 0;
        this._returnFacingY = null;
        if (this._moving) this._stopWalkAnim(this);
        this._returnFacingY = null;  // _stopWalkAnim queues one — home needs none
        this.vrm.scene.position.set(0, 0, 0);
        this._setMoveYaw(this, 0);  // base orientation = facing the default camera
        this._applyCameraPreset();
    }

    /** Dispose the current VRM and leave the canvas empty. Used when switching
     *  to an agent that has no avatar configured — without this, the previously
     *  loaded model would linger on screen. */
    clearVRM() {
        // Bump generation so any in-flight loadVRM resolves into the stale
        // branch and discards itself — otherwise a load that started just
        // before the user picked an avatarless agent would still arrive and
        // re-populate the canvas after this clear.
        this._vrmLoadGeneration++;
        if (!this.vrm) {
            this._loadedVrmUrl = null;
            return;
        }
        const { VRMUtils } = this.libs || {};
        try {
            this.scene.remove(this.vrm.scene);
            VRMUtils?.deepDispose?.(this.vrm.scene);
        } catch (e) { /* non-fatal */ }
        this.vrm = null;
        if (this.mixer) {
            try { this.mixer.stopAllAction(); } catch (e) { /* non-fatal */ }
            this.mixer = null;
        }
        this.idleClipAction = null;
        this._gestureAction = null;
        this._currentGestureUrl = null;
        if (this._gestureClips) this._gestureClips.clear();
        // The base VRM is gone — its restore snapshot is meaningless and the
        // partner has nothing to play against. Drop both without a fade.
        this._comboBaseRestore = null;
        this._unloadComboPartner({ immediate: true });
        this._walkAction = null;
        this._moving = false;
        this._moveTarget = null;
        this._returnFacingY = null;
        this._camFollowPos = null;
        this._baseQuat = null;
        this._moveYaw = 0;
        this._loadedVrmUrl = null;
        this._headBaseY = 0;
        this._headWorldY = null;
        this._meshTopY = null;
        this._meshBottomY = null;
        this.resetExpression();
    }

    /** Swap the visible outfit. Disposes the current VRM and loads `vrmUrl`
     *  in place; same character, different clothes. Re-applies the idle VRMA
     *  afterwards because loadVRM rebuilds the mixer and the previous
     *  idleClipAction is bound to the disposed model. */
    async setOutfit(vrmUrl, vrmaIdleUrl = null) {
        if (!vrmUrl) return;
        await this.loadVRM(vrmUrl);
        if (vrmaIdleUrl) {
            try { await this.loadVRMA(vrmaIdleUrl); } catch (e) { /* non-fatal */ }
        }
    }

    /** Load a GLB environment ("room") into the shared scene, behind the
     *  avatar. This is a true 3D scene object — distinct from, and complementary
     *  to, the CSS background system (setBackground / BACKGROUND_PRESETS):
     *  because our WebGLRenderer is `alpha: true`, the CSS background still
     *  shows through wherever the room geometry doesn't cover, so a room can be
     *  layered over a gradient/vignette host style. Rooms also carry into VR
     *  unchanged once that lands — they live in the same scene graph as the
     *  avatar and (future) XR dolly.
     *
     *  Arbitrary GLBs vary wildly in authored scale/origin, so transform is
     *  caller-supplied. One room at a time — loading a new one disposes the
     *  previous.
     *
     *  Driven by the background system: a `rexclaw.voice.avatar.background` of
     *  type 'scene' routes here from _applyBackgroundToActiveHost (full host
     *  only). Also reachable manually via the window.__voiceRenderer debug
     *  handle, e.g.:
     *    window.__voiceRenderer?.loadRoom("/assets/.../scene.glb",
     *                                     { position: [0,0,-1], scale: 1 })
     *
     *  Idempotent on `url`: the background applier re-runs on every host
     *  reparent/resize, so a no-op fast path avoids reloading the same GLB.
     *  The url is staked optimistically before the await so two near-
     *  simultaneous applies don't both fetch and stack two rooms.
     *
     *  @param {string} url
     *  @param {{position?: number[], rotation?: number[], scale?: number|number[]}} [opts]
     */
    async loadRoom(url, { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 } = {}) {
        if (!url) return;
        if (this._loadedRoomUrl === url && this._room) return;  // already loaded — idempotent
        // Stake a generation up front. clearRoom() and any newer loadRoom() bump
        // it, so if the background/agent changes while this (often multi-MB) GLB
        // is still downloading, we detect the supersede after each await and bail
        // WITHOUT adding the stale room. Mirrors loadVRM's _vrmLoadGeneration —
        // before this, a load that finished after a clearRoom would re-add its
        // room and "stick", which is why switching background/agent didn't clear.
        const generation = ++this._roomLoadGeneration;
        this._loadedRoomUrl = url;
        await this._ensureRenderer();
        if (this._roomLoadGeneration !== generation) return;  // superseded during init
        const { GLTFLoader } = this.libs;
        // Dispose any existing room first so swaps don't stack environments.
        // _disposeRoom (not clearRoom) so we don't bump our own generation.
        this._disposeRoom();
        let gltf;
        try {
            gltf = await new GLTFLoader().loadAsync(url);
        } catch (e) {
            console.error("[voice] room load failed", url, e);
            if (this._roomLoadGeneration === generation) this._loadedRoomUrl = null;
            return;
        }
        const { VRMUtils } = this.libs;
        if (this._roomLoadGeneration !== generation) {
            // A clearRoom()/newer loadRoom() landed while we downloaded — drop
            // this result on the floor instead of resurrecting a cleared room.
            try { VRMUtils?.deepDispose?.(gltf.scene); } catch (e) { /* non-fatal */ }
            return;
        }
        const model = gltf.scene;
        model.name = "room";
        model.position.set(...position);
        model.rotation.set(...rotation);
        const [sx, sy, sz] = Array.isArray(scale) ? scale : [scale, scale, scale];
        model.scale.set(sx, sy, sz);

        // Max out anisotropic filtering on the room's textures. glTF samplers
        // can't request anisotropy, and the trilinear default over-blurs any
        // texture seen at a grazing angle — a grid/tile FLOOR is the worst
        // case, washing out into fog a few metres ahead of the avatar. Aniso
        // keeps ground detail crisp into the distance (it's what Mixamo's own
        // viewer does). Cheap on every GPU from the last decade.
        const maxAniso = this.renderer.capabilities.getMaxAnisotropy?.() || 1;
        const TEXTURE_SLOTS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"];
        model.traverse((child) => {
            if (!child.isMesh) return;
            // The avatar casts/receives via its own setup; the room only
            // receives so it grounds the character without self-shadow cost.
            child.castShadow = false;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (!m) continue;
                for (const slot of TEXTURE_SLOTS) {
                    const tex = m[slot];
                    if (tex && tex.anisotropy !== maxAniso) {
                        tex.anisotropy = maxAniso;
                        tex.needsUpdate = true;
                    }
                }
            }
        });

        this.scene.add(model);
        this._room = model;
        console.log("[voice] room loaded:", url);
    }

    /** Clear the current GLB room AND cancel any in-flight load. Bumping the
     *  generation is what makes "switch background/agent away from a scene"
     *  actually stick: a loadRoom() still downloading sees the new generation
     *  after its await and discards its result instead of re-adding the room.
     *  No-op (beyond the bump) when nothing is loaded. Independent of the avatar
     *  lifecycle — a scene only clears when a caller explicitly switches away. */
    clearRoom() {
        this._roomLoadGeneration++;  // supersede any in-flight loadRoom()
        this._loadedRoomUrl = null;
        this._disposeRoom();
    }

    /** Tear down the live room object only — no generation bump. Used both by
     *  clearRoom and by loadRoom's internal swap (which must NOT cancel its own
     *  generation). */
    _disposeRoom() {
        if (!this._room) return;
        const { VRMUtils } = this.libs || {};
        try {
            this.scene.remove(this._room);
            // deepDispose walks geometries/materials/textures — works on any
            // Object3D, not just VRM scenes, so we reuse it for the room.
            VRMUtils?.deepDispose?.(this._room);
        } catch (e) { /* non-fatal */ }
        this._room = null;
    }

    configureFromAvatar(avatarPayload) {
        // Stash so _reparent can re-apply the background when the canvas
        // swaps hosts (mini ↔ full) without us needing to plumb the avatar
        // payload through every callsite. Background selection itself is
        // driven by setBackground() — callers pass the resolved
        // active_background from /voice/session/start (or null to fall back
        // to the avatar's default background).
        const prevAvatarId = this._currentAvatarPayload?.id ?? null;
        const nextAvatarId = avatarPayload?.id ?? null;
        this._currentAvatarPayload = avatarPayload || null;
        if (this._currentBackground === undefined || prevAvatarId !== nextAvatarId) {
            // First configure, or the user picked a different avatar — snap
            // to the new avatar's marked-default background so we don't carry
            // the previous avatar's scene (curated or Imagine) onto the new
            // character. voice_service.start() calls setBackground() right
            // after this with the server-resolved active_background, so
            // session boot still wins.
            this._currentBackground = this._resolveDefaultBackground();
        }
        this._applyBackgroundToActiveHost();
    }

    /** Set the active background and repaint. Accepts a payload shaped like
     *  rexclaw.voice.avatar.background.to_payload() or
     *  rexclaw.voice.imagine.image.to_payload() (both have
     *  {type, preset_style, image_url}). Pass null to clear.
     *
     *  Called from:
     *    - session-boot wiring after /voice/session/start returns
     *      `active_background`.
     *    - the fullscreen background picker.
     *    - the tool dispatcher's change_background post-result hook.
     */
    setBackground(bg) {
        this._currentBackground = bg || null;
        this._applyBackgroundToActiveHost();
    }

    /** Backwards-compat helper: pick the avatar payload's default background
     *  when setBackground hasn't been called yet. */
    _resolveDefaultBackground() {
        const payload = this._currentAvatarPayload;
        if (!payload || !Array.isArray(payload.backgrounds) || !payload.backgrounds.length) {
            return null;
        }
        const defaultId = payload.default_background_id;
        if (defaultId) {
            const found = payload.backgrounds.find((b) => b && b.id === defaultId);
            if (found) return found;
        }
        return payload.backgrounds[0] || null;
    }

    /** Apply the active background to the active host. Two distinct mechanisms,
     *  picked by background type:
     *    - 'image'/'imagine'/'static' → a CSS backdrop painted on the canvas
     *      host element (presets scale to any size; image URLs are full-only).
     *    - 'scene' → a GLB loaded *into* the three.js scene via loadRoom. The
     *      CSS backdrop is left transparent so the SCSS default shows through
     *      any gaps; like image backgrounds it's full-only (a 3D room at 200px
     *      isn't worth the draw cost), so the mini host tears the room down.
     *
     *  Runs on every host reparent/resize, so it must converge to the right
     *  state from any prior one: a non-scene background (or null) always
     *  clearRoom()s, and loadRoom is idempotent on url. */
    _applyBackgroundToActiveHost() {
        const host = this.activeCanvas;
        if (!host) return;
        // Desktop mascot overlay: the window itself is transparent, so the
        // host never paints a backdrop of any kind (the --mascot modifier
        // also suppresses the SCSS default gradient), and 3D rooms / video
        // backdrops tear down like on a mini host.
        if (host.classList?.contains("o_voice_avatar_canvas--mascot")) {
            host.style.background = "";
            host.style.backgroundImage = "";
            this._removeBackgroundVideo();
            this.clearRoom();
            return;
        }
        const isFull = host.classList?.contains("o_voice_avatar_canvas--full");
        // Clear inline styles first so the SCSS default can take over for
        // anything we don't override below (e.g. mini hosts in image mode).
        host.style.background = "";
        host.style.backgroundImage = "";
        host.style.backgroundSize = "";
        host.style.backgroundPosition = "";
        host.style.backgroundRepeat = "";
        const bg = this._currentBackground;

        // Scene (3D GLB) backgrounds are mutually exclusive with a loaded room;
        // any non-scene state (including null) tears the room down so switching
        // away from a scene reverts cleanly.
        if (bg && bg.type === "scene") {
            this._removeBackgroundVideo();
            if (isFull && bg.scene_url) {
                // rotation_y arrives in degrees (the record's human-facing
                // unit); three wants radians. Offsets/scale pass through.
                this.loadRoom(bg.scene_url, {
                    position: bg.scene_offset || [0, 0, 0],
                    rotation: [0, (bg.scene_rotation_y || 0) * Math.PI / 180, 0],
                    scale: bg.scene_scale ?? 1,
                }).catch((e) => console.error("[voice] scene background load failed", e));
            } else {
                // Mini host (or missing url) — no 3D room here.
                this.clearRoom();
            }
            return;  // scene leaves the CSS backdrop transparent
        }
        this.clearRoom();
        // Leaving a 3D scene: the avatar may have walked off-origin. A flat
        // backdrop has no notion of "place", so bring her home and re-frame.
        // Cheap no-op in the common case (already at the origin, not moving).
        // Two states where off-origin is INTENTIONAL, not walk drift:
        //   - an active combo owns everyone's placement — leave it alone;
        //   - a group call's row layout offsets the base by design — snapping
        //     it home would stack it onto a peer, so re-assert the row
        //     instead (idempotent when nobody walked).
        if (this._comboPartner || this._comboLivePeer) {
            // mid-combo placements are the combo's business
        } else if (this.vrm && (this._moving || this.vrm.scene.position.lengthSq() > 1e-6)) {
            const inCallLayout = [...(this._peers?.values() || [])].some((p) => p.vrm);
            if (inCallLayout) {
                this._moveTarget = null;
                this._moveInput.x = 0;
                this._moveInput.z = 0;
                this._returnFacingY = null;
                if (this._moving) this._stopWalkAnim(this);
                this._layoutCallAvatars();
            } else {
                this._resetAvatarHome();
            }
        }

        // 'imagine_video' (change_background with animated=true) — a muted
        // looping <video> layered between the host's CSS backdrop and the
        // WebGL canvas. Full-only like image backgrounds; the mini host
        // keeps its default.
        if (bg && bg.type === "imagine_video" && bg.video_url) {
            if (isFull) {
                this._ensureBackgroundVideo(host, bg.video_url);
            } else {
                this._removeBackgroundVideo();
            }
            return;
        }
        this._removeBackgroundVideo();

        if (!bg) return;
        // 'image' (uploaded by admin) and 'imagine' (generated by Grok Imagine)
        // both paint as URL backgrounds — the only practical difference is
        // origin, and the renderer doesn't need to care.
        if ((bg.type === "image" || bg.type === "imagine") && bg.image_url) {
            if (!isFull) return;  // mini keeps the SCSS gradient default
            host.style.backgroundImage = `url(${JSON.stringify(bg.image_url)})`;
            host.style.backgroundSize = "cover";
            host.style.backgroundPosition = "center";
            host.style.backgroundRepeat = "no-repeat";
        } else if (bg.type === "static" && bg.preset_style && BACKGROUND_PRESETS[bg.preset_style]) {
            host.style.background = BACKGROUND_PRESETS[bg.preset_style];
        }
    }

    /** Mount (or move) the looping backdrop <video> into `host`, behind the
     *  WebGL canvas. Idempotent on (url, host) — the background applier
     *  re-runs on every reparent/resize and must not restart the loop.
     *  Muted on purpose: an animated backdrop's soundtrack would fight the
     *  voice pipeline.
     *
     *  Layering: the video sits at z-index -1 and the host has
     *  `isolation: isolate` (avatar_canvas.scss), which makes the host a
     *  stacking context — the video paints above the host's own CSS
     *  background but below EVERYTHING else (canvas, overlay controls),
     *  with no z-index surgery on other elements. Do not "fix" stacking by
     *  raising the canvas instead: that buries the fullscreen overlay UI. */
    _ensureBackgroundVideo(host, url) {
        if (this._bgVideoEl && this._bgVideoUrl === url) {
            if (this._bgVideoEl.parentElement !== host) {
                host.insertBefore(this._bgVideoEl, host.firstChild);
            }
            return;
        }
        this._removeBackgroundVideo();
        const el = document.createElement("video");
        el.muted = true;
        el.loop = true;
        el.autoplay = true;
        el.playsInline = true;
        el.preload = "auto";
        el.src = url;
        el.style.position = "absolute";
        el.style.inset = "0";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "cover";
        el.style.zIndex = "-1";
        el.style.pointerEvents = "none";
        el.setAttribute("aria-hidden", "true");
        host.insertBefore(el, host.firstChild);
        el.play().catch((e) => console.warn("[voice] background video autoplay blocked", e));
        this._bgVideoEl = el;
        this._bgVideoUrl = url;
    }

    /** Snapshot the live scene (avatar, outfit, pose, peers) as a PNG data
     *  URL, downscaled to `maxSize` on the long edge. Renders one frame
     *  synchronously first: the WebGL context has preserveDrawingBuffer off
     *  (the default), so the drawing buffer is only readable immediately
     *  after an explicit render. Powers the take_selfie tool.
     *
     *  `includeBackground` composites the current 2D backdrop (animated
     *  video frame or image background) under the WebGL frame; without it
     *  the background stays transparent. Note a GLB room ('scene'
     *  backgrounds) lives IN the WebGL scene, so it appears either way. */
    async captureSnapshot({ maxSize = 1024, includeBackground = false } = {}) {
        if (!this.renderer || !this.scene || !this.camera) return null;
        this.renderer.render(this.scene, this.camera);
        const src = this.renderer.domElement;
        if (!src.width || !src.height) return null;
        const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
        const w = Math.max(1, Math.round(src.width * scale));
        const h = Math.max(1, Math.round(src.height * scale));
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const ctx = out.getContext("2d");
        if (includeBackground) {
            await this._drawBackdropOnto(ctx, w, h);
            // The awaited image load may have let the render loop overwrite
            // the drawing buffer — render again right before reading it.
            this.renderer.render(this.scene, this.camera);
        }
        ctx.drawImage(src, 0, 0, w, h);
        return out.toDataURL("image/png");
    }

    /** Hit-test the rendered avatar at host-relative CSS coordinates.
     *  Renders one frame and reads back a small alpha block around the point
     *  (the drawing buffer isn't preserved, so sampling must immediately
     *  follow an explicit render — same constraint as captureSnapshot).
     *
     *  Returns { exact, fuzzy }:
     *    exact — an opaque pixel sits within ~1px of the point;
     *    fuzzy — any opaque pixel within radiusCss (damps flicker when the
     *            cursor skims the model's edge).
     *  Cheap enough for the mascot's ~15 Hz ghost-mode poll: one readPixels
     *  of a ~50px square. */
    sampleAlphaRegion(clientX, clientY, radiusCss = 24, threshold = 10) {
        const host = this.activeCanvas;
        const none = { exact: false, fuzzy: false };
        if (!this.renderer || !this.scene || !this.camera || !host) return none;
        const canvas = this.renderer.domElement;
        const gl = this.renderer.getContext();
        if (!gl || !canvas.width || !canvas.height) return none;
        const sx = canvas.width / (host.clientWidth || 1);
        const cx = Math.round(clientX * sx);
        const cy = Math.round(clientY * (canvas.height / (host.clientHeight || 1)));
        const r = Math.max(2, Math.round(radiusCss * sx));
        const x0 = Math.max(0, cx - r);
        const y0 = Math.max(0, cy - r);
        const x1 = Math.min(canvas.width - 1, cx + r);
        const y1 = Math.min(canvas.height - 1, cy + r);
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (w <= 0 || h <= 0) return none;
        this.renderer.render(this.scene, this.camera);
        const buf = new Uint8Array(w * h * 4);
        // readPixels is bottom-left origin; client coords are top-left.
        gl.readPixels(x0, canvas.height - y0 - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let exact = false;
        let fuzzy = false;
        const r2 = r * r;
        for (let py = 0; py < h && !exact; py++) {
            for (let px = 0; px < w; px++) {
                if (buf[(py * w + px) * 4 + 3] < threshold) continue;
                const dx = x0 + px - cx;
                const dy = y0 + (h - 1 - py) - cy;   // un-flip the row
                if (dx * dx + dy * dy <= r2) fuzzy = true;
                if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) { exact = true; break; }
            }
        }
        if (exact) fuzzy = true;
        return { exact, fuzzy };
    }

    /** Paint the current 2D backdrop onto a snapshot canvas: the animated
     *  <video> frame if one is mounted, else the image/imagine background,
     *  else an approximation of the SCSS default studio gradient (static
     *  presets are CSS gradients we don't replicate individually). */
    async _drawBackdropOnto(ctx, w, h) {
        const video = this._bgVideoEl;
        if (video && video.readyState >= 2 && video.videoWidth) {
            this._drawCover(ctx, video, video.videoWidth, video.videoHeight, w, h);
            return;
        }
        const bg = this._currentBackground;
        if (bg && (bg.type === "image" || bg.type === "imagine") && bg.image_url) {
            const img = new Image();
            img.src = bg.image_url;
            await new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 3000);
            });
            if (img.complete && img.naturalWidth) {
                this._drawCover(ctx, img, img.naturalWidth, img.naturalHeight, w, h);
                return;
            }
        }
        const grad = ctx.createRadialGradient(
            w * 0.5, h * 0.35, 0,
            w * 0.5, h * 0.35, Math.max(w, h) * 0.9,
        );
        grad.addColorStop(0, "#3b424f");
        grad.addColorStop(0.55, "#1c2230");
        grad.addColorStop(1, "#0a0d14");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    /** drawImage with CSS background-size:cover semantics. */
    _drawCover(ctx, source, sw, sh, w, h) {
        if (!sw || !sh) return;
        const s = Math.max(w / sw, h / sh);
        const dw = sw * s;
        const dh = sh * s;
        ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }

    /** Tear down the backdrop video and release its decoder. No-op when
     *  nothing is mounted. */
    _removeBackgroundVideo() {
        const el = this._bgVideoEl;
        if (!el) return;
        try {
            el.pause();
            el.removeAttribute("src");
            el.load();
            el.remove();
        } catch (e) { /* non-fatal */ }
        this._bgVideoEl = null;
        this._bgVideoUrl = null;
    }

    mount(canvas) {
        if (!this._hostStack) this._hostStack = [];
        // Track host order so unmounts can fall back to the next-most-recent.
        const idx = this._hostStack.indexOf(canvas);
        if (idx !== -1) this._hostStack.splice(idx, 1);
        this._hostStack.push(canvas);
        this.activeCanvas = canvas;
        this._reparent(canvas);
        this._resize(canvas);
        // Don't start a second driver while XR owns the loop via setAnimationLoop.
        if (!this.rafHandle && !this._xrActive) {
            this._loop();
        }
    }

    unmount(canvas) {
        if (!this._hostStack) this._hostStack = [];
        const idx = this._hostStack.indexOf(canvas);
        if (idx !== -1) this._hostStack.splice(idx, 1);
        if (this.activeCanvas === canvas) {
            // Pop back to the next-most-recent mounted host so the canvas
            // doesn't end up orphaned (full view stays alive when side panel
            // closes; side panel stays alive when navigating to a new action).
            const fallback = this._hostStack[this._hostStack.length - 1] || null;
            this.activeCanvas = fallback;
            if (fallback) {
                this._reparent(fallback);
                this._resize(fallback);
                // The pending rAF may belong to a dying window (PiP close) —
                // reschedule on the new host's window so the loop can't strand.
                this._cancelRaf();
                if (!this._xrActive) this._loop();
            } else {
                this._cancelRaf();
            }
        }
    }

    _reparent(canvas) {
        // The renderer owns its own canvas; we transplant ours into the host element.
        if (!this.renderer) return;
        const ourCanvas = this.renderer.domElement;
        if (ourCanvas.parentElement !== canvas) {
            canvas.appendChild(ourCanvas);
        }
        // The active host just changed (or we just attached for the first
        // time after lazy renderer init) — re-paint the avatar background
        // onto whichever host is now active. _applyBackgroundToActiveHost
        // handles the mini-vs-full distinction internally.
        this._applyBackgroundToActiveHost();
        // OrbitControls is bound to the canvas DOM element for pointer input.
        // When the canvas reparents (e.g. side panel mini ↔ full view), the old
        // bindings become useless — dispose and rebind to the new host. Also
        // the cold-start attach: a setFullBodyMode() that ran before the lazy
        // renderer init (mascot restoring a persisted full-body pref) recorded
        // the flag but couldn't attach controls yet — without this, drag/zoom
        // stayed dead until the user toggled face view and back.
        if (this._fullBody && !this._xrActive) {
            this._disableOrbit();
            this._enableOrbit();
        }
    }

    _resize(host) {
        if (!this.renderer || !host) return;
        const w = host.clientWidth || 200;
        const h = host.clientHeight || 200;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(h, 1);
        this.camera.updateProjectionMatrix();
    }

    setVowels(vowels) {
        this._currentVowels = vowels;
    }

    /** 0..1 indicating how strongly the avatar is currently "speaking". The
     *  render loop smooths this into actual gesture amplitude — fast attack
     *  (look alive immediately) + slow release (no whiplash on interrupt). */
    setSpeakingIntensity(value) {
        this._rawSpeakingIntensity = Math.max(0, Math.min(1, value || 0));
    }

    /** Reset all transient expression state to a clean neutral baseline.
     *  Called when the user switches *agent* (different character, fresh
     *  personality) — not on outfit swap, because outfit changes don't
     *  imply the conversation's emotional state should drop. Without this,
     *  `_currentEmotion` (set by the LLM via setEmotion) lingered across
     *  agent swaps and `_applyEmotion` kept blending the previous agent's
     *  last face onto the new model. Also clears speaking intensity and
     *  vowel weights so we don't carry mid-syllable lipsync into a fresh
     *  character. _loggedExpressionInventory is reset so the new VRM logs
     *  its own expression catalog on the first explicit emotion call. */
    resetExpression() {
        this._currentEmotion = "neutral";
        if (this._emotionDecayTimer) {
            clearTimeout(this._emotionDecayTimer);
            this._emotionDecayTimer = null;
        }
        // progress=1 with a null start snaps the next _applyEmotion tick
        // straight to the neutral (all-zero) targets — a clean face for the
        // incoming character rather than inheriting the previous emotion.
        this._emotionTransitionProgress = 1;
        this._emotionTransitionStart = null;
        this._lastExplicitEmotionAt = null;
        this._currentVowels = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        this._rawSpeakingIntensity = 0;
        this._speakingIntensity = 0;
        this._loggedExpressionInventory = false;
    }

    /** Toggle between face-shot (default) and full-body mode. Full-body mode
     *  zooms out, raises FOV, and attaches OrbitControls so the user can drag
     *  to rotate, scroll to zoom, and pan with right-click/two-finger drag. */
    setFullBodyMode(enabled) {
        this._fullBody = !!enabled;
        if (!this.camera || !this.libs) return;
        // Ignored while in XR (the HMD owns the camera); the desired flag is
        // still recorded so exitXR can restore orbit framing on return.
        if (this._xrActive) return;
        this._applyCameraPreset();
        if (this._fullBody) {
            this._enableOrbit();
        } else {
            this._disableOrbit();
        }
    }

    /** Returns the active camera framing, auto-fitted to the loaded VRM's
     *  bounding box. Falls back to head-bone Y + reasonable defaults until
     *  loadVRM populates `_meshTopY` / `_meshBottomY`. Single source of
     *  truth for face/full presets — `_applyCameraPreset` and `_enableOrbit`
     *  both read from here.
     *
     *  Strategy: pick a vertical region we want visible (face-shot = upper
     *  chest → top of mesh; full-body = feet → top of mesh), pad it, then
     *  solve for the camera distance that makes that region fill the FOV.
     *  This automatically handles tall hair, hats, horns, and other things
     *  that extend above the head bone — they're part of the mesh box. */
    _cameraPreset() {
        const headY = this._headWorldY ?? FACE_FALLBACK_HEAD_Y;
        // Sensible fallbacks if the VRM hasn't loaded yet or the bounding
        // box capture failed — keeps the pre-load camera roughly framed.
        const meshTopY = this._meshTopY ?? (headY + 0.20);
        const meshBottomY = this._meshBottomY ?? 0;
        // Frame around wherever the avatar currently STANDS — with locomotion
        // it's no longer pinned to the origin, and a preset re-apply (face ↔
        // full toggle) must not snap the camera back to an empty spawn point.
        // (The captured Y heights stay valid: walking never changes Y.)
        let ax = this.vrm?.scene?.position?.x || 0;
        let az = this.vrm?.scene?.position?.z || 0;

        // Group calls: frame the whole row of characters. Centre on the
        // group midpoint and remember the half-width so the distance solve
        // below can widen the shot until everyone fits horizontally. A
        // spawned combo partner counts as a character too — otherwise the
        // shot stays centred on the base avatar and the partner can end up
        // outside the frame.
        let halfWidth = 0;
        const comboPartnerVrm =
            this._comboPartner?.vrm && !this._comboPartner.fading ? this._comboPartner.vrm : null;
        if (comboPartnerVrm && !this._peers.size) {
            // Solo combo: placement offsets are authored in world space
            // around the scene centre — anchor the shot there instead of
            // following the base, so a base x of 0 sits dead centre and a
            // negative x reads as "left of centre" exactly as typed. Widen
            // symmetrically until both characters fit.
            const xs = [ax, comboPartnerVrm.scene.position.x];
            az = Math.max(az, comboPartnerVrm.scene.position.z);
            ax = 0;
            halfWidth = Math.max(...xs.map(Math.abs)) + CALL_FRAME_SIDE_MARGIN;
        } else if (this._peers.size) {
            const xs = [ax];
            const zs = [az];
            for (const peer of this._peers.values()) {
                if (!peer.vrm) continue;
                xs.push(peer.vrm.scene.position.x);
                zs.push(peer.vrm.scene.position.z);
            }
            if (comboPartnerVrm) {
                xs.push(comboPartnerVrm.scene.position.x);
                zs.push(comboPartnerVrm.scene.position.z);
            }
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            ax = (minX + maxX) / 2;
            az = Math.max(...zs);
            halfWidth = (maxX - minX) / 2 + CALL_FRAME_SIDE_MARGIN;
        }

        // Horizontal fit: hFOV derives from vFOV via the aspect ratio; the
        // distance must be at least halfWidth / tan(hFOV/2) or the outer
        // characters clip at the viewport edges.
        const fitWidth = (fov, distance) => {
            if (!halfWidth) return distance;
            const aspect = this.camera?.aspect || 1;
            const halfTanH = Math.tan((fov * Math.PI) / 360) * aspect;
            if (halfTanH <= 1e-4) return distance;
            return Math.max(distance, halfWidth / halfTanH);
        };

        if (this._fullBody) {
            const center = (meshTopY + meshBottomY) / 2;
            const height = (meshTopY - meshBottomY) * FULL_FRAME_PADDING;
            const distance = fitWidth(FULL_FOV, Math.max(
                FULL_MIN_DISTANCE,
                height / (2 * Math.tan((FULL_FOV * Math.PI) / 360)),
            ));
            return {
                position: [ax, center, az + distance],
                target: [ax, center, az],
                fov: FULL_FOV,
            };
        }

        // Face shot: from a bit below the head bone (so upper chest is
        // visible, not a floating head) up to the top of the mesh.
        const frameBottom = headY - FACE_LOWER_OFFSET;
        // Guard against pathological VRMs where the bounding box happens to
        // sit below the head bone (no hair geometry, etc.) — give the head
        // at least some breathing room above the bone.
        const frameTop = Math.max(meshTopY, headY + FACE_LOWER_OFFSET);
        const center = (frameTop + frameBottom) / 2;
        let facePadding = FACE_FRAME_PADDING;
        if (WIDE_FACE_AVATAR_RE.test(this._currentAvatarPayload?.name || "")) {
            facePadding *= WIDE_FACE_EXTRA_PADDING;
        }
        const height = (frameTop - frameBottom) * facePadding;
        const distance = fitWidth(FACE_FOV, Math.max(
            FACE_MIN_DISTANCE,
            height / (2 * Math.tan((FACE_FOV * Math.PI) / 360)),
        ));
        return {
            position: [ax, center, az + distance],
            target: [ax, center, az],
            fov: FACE_FOV,
        };
    }

    _applyCameraPreset() {
        if (!this.camera) return;
        // In XR the HMD drives the camera pose; absolute world placement here
        // would fight the dolly rig. exitXR() re-runs this to restore framing.
        if (this._xrActive) return;
        const preset = this._cameraPreset();
        this.camera.position.set(...preset.position);
        this.camera.fov = preset.fov;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(...preset.target);
        if (this._lookAtTarget) {
            this._lookAtTarget.position.set(...preset.position);
        }
        if (this._orbitControls) {
            this._orbitControls.target.set(...preset.target);
            this._orbitControls.update();
        }
        // The camera was just placed absolutely (already avatar-relative via
        // _cameraPreset) — drop the follow anchor so _updateFollowCamera
        // re-anchors at the avatar's current spot instead of re-applying the
        // displacement on top.
        this._camFollowPos = null;
    }

    _enableOrbit() {
        if (this._orbitControls || !this.activeCanvas) return;
        const { OrbitControls } = this.libs;
        if (!OrbitControls) return;
        // OrbitControls binds to the renderer's DOM element for input. We pass
        // the canvas element (which is renderer.domElement, parented to the host).
        const controls = new OrbitControls(this.camera, this.renderer.domElement);
        const preset = this._cameraPreset();
        controls.target.set(...preset.target);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 1.2;
        controls.maxDistance = 6.0;
        // Don't let user flip below the floor or look straight up.
        controls.minPolarAngle = Math.PI * 0.1;
        controls.maxPolarAngle = Math.PI * 0.85;
        controls.update();
        this._orbitControls = controls;
    }

    _disableOrbit() {
        if (!this._orbitControls) return;
        try {
            this._orbitControls.dispose();
        } catch (e) { /* non-fatal */ }
        this._orbitControls = null;
    }

    setEmotion(name, { explicit = true } = {}) {
        if (!EMOTION_STATES[name]) return;
        this._currentEmotion = name;
        // Decay: settle back toward neutral after the reaction beat unless
        // the avatar's config opts out. Every call cancels the previous
        // pending settle, so a happy → angry transition isn't clobbered back
        // to neutral seconds later; the settle emotions themselves map to a
        // null target, so the chain always terminates.
        if (this._emotionDecayTimer) {
            clearTimeout(this._emotionDecayTimer);
            this._emotionDecayTimer = null;
        }
        const settleTo = emotionSettleTarget(name, this._currentAvatarPayload?.name);
        if (settleTo && emotionDecayEnabled(this._currentAvatarPayload)) {
            this._emotionDecayTimer = setTimeout(() => {
                this._emotionDecayTimer = null;
                this.setEmotion(settleTo, { explicit: false });
            }, EMOTION_DECAY_MS);
        }
        // Track when an explicit (LLM-driven) emotion was last set. The voice
        // service's transcript-based fallback heuristic checks this — recent
        // explicit calls suppress heuristic overrides so the LLM stays in charge.
        if (explicit) this._lastExplicitEmotionAt = Date.now();
        // Restart the eased cross-fade. start=null → _applyEmotion captures the
        // currently-displayed weights on its next tick so the blend runs from
        // the real face (not a snap to 0, which #590 in airi flagged).
        this._emotionTransitionProgress = 0;
        this._emotionTransitionStart = null;
        // Diagnostic: log the available expressions on first emotion change so
        // we can see what the loaded VRM actually supports. Some VRMs are
        // missing certain presets entirely (e.g. weak/missing 'surprised'),
        // which explains why two emotions can look identical.
        if (!this._loggedExpressionInventory && this.vrm?.expressionManager) {
            try {
                const exp = this.vrm.expressionManager;
                const inventory = {};
                for (const key of Object.keys(EMOTION_STATES)) {
                    const exprName = EMOTION_STATES[key].name;
                    if (!exprName) continue;
                    const e = exp.getExpression?.(exprName);
                    inventory[exprName] = e ? { found: true, isBinary: !!e.isBinary } : { found: false };
                }
                console.log("[voice] avatar expression inventory:", inventory);
                this._loggedExpressionInventory = true;
            } catch (e) { /* non-fatal */ }
        }
    }

    setReplayMode(replayMode) {
        // When replaying, lipsync will zero the vowels itself, so this is mostly a hint.
        this._replayMode = !!replayMode;
    }

    _scheduleNextBlink(actor) {
        const span = BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN;
        actor._nextBlinkAt = (this.clock?.elapsedTime || 0) + BLINK_INTERVAL_MIN + Math.random() * span;
    }

    _applyBlink(actor, now) {
        if (!actor.vrm?.expressionManager) return;
        // A gesture clip that choreographs its own blinks owns the eyelids
        // while it plays; auto-blink resumes when it ends.
        const ge = this._gestureExpressions(actor);
        if (ge && (ge.has("blink") || ge.has("blinkLeft") || ge.has("blinkRight"))) return;
        if (now >= actor._nextBlinkAt) {
            const t = now - actor._nextBlinkAt;
            if (t < BLINK_CLOSE_DURATION) {
                actor.vrm.expressionManager.setValue("blink", t / BLINK_CLOSE_DURATION);
            } else if (t < BLINK_CLOSE_DURATION + BLINK_OPEN_DURATION) {
                const phase = (t - BLINK_CLOSE_DURATION) / BLINK_OPEN_DURATION;
                actor.vrm.expressionManager.setValue("blink", 1 - phase);
            } else {
                actor.vrm.expressionManager.setValue("blink", 0);
                this._scheduleNextBlink(actor);
            }
        } else {
            actor.vrm.expressionManager.setValue("blink", 0);
        }
    }

    _applyBreath(actor, now) {
        if (!actor.vrm) return;
        try {
            const head = actor.vrm.humanoid?.getNormalizedBoneNode?.("head");
            if (head && actor._headBaseY) {
                // baseY + sin(t*ω) — never += to avoid drift accumulation.
                head.position.y = actor._headBaseY + Math.sin(now * BREATH_FREQUENCY_HZ * 2 * Math.PI) * BREATH_AMPLITUDE;
            }
        } catch (e) { /* non-fatal */ }
    }

    /** Procedural idle pose + speaking gestures. Drops arms from T-pose and
     *  adds subtle sway. When `_speakingIntensity > 0`, body sway scales up
     *  and a head nod/tilt is layered in so the avatar visibly "talks with
     *  her body". Skipped entirely if a VRMA mixer action is playing, so
     *  user-supplied animation clips win.
     */
    _applyIdle(actor, now) {
        if (!actor.vrm?.humanoid) return;
        if (actor.idleClipAction && actor.idleClipAction.isRunning()) return;
        // A one-shot gesture is animating — let it own the bones; procedural
        // idle would fight it and produce a weird blend.
        if (actor._gestureAction && actor._gestureAction.isRunning()) return;
        // Walking — the walk clip owns the bones (procedural idle would
        // overwrite the mixer output every frame; see _loop's update order).
        if (actor._moving) return;

        // Smooth raw intensity into animation-driving intensity.
        const target = actor._rawSpeakingIntensity;
        const a = target > actor._speakingIntensity ? SPEAK_INTENSITY_ATTACK : SPEAK_INTENSITY_RELEASE;
        actor._speakingIntensity = actor._speakingIntensity * (1 - a) + target * a;
        const speak = actor._speakingIntensity;
        // Body gain ranges 1.0 (idle) → SPEAK_BODY_GAIN (peak speaking).
        const bodyGain = 1 + (SPEAK_BODY_GAIN - 1) * speak;

        try {
            const h = actor.vrm.humanoid;
            const get = (name) => h.getNormalizedBoneNode?.(name);
            const TAU = Math.PI * 2;

            // Compound-frequency helper: primary sine + a slower secondary at
            // a coprime-ish frequency. Reads as quasi-random instead of a
            // clean periodic wave the eye locks onto.
            const sway = (primaryHz, primaryAmp, phase = 0) =>
                Math.sin(now * primaryHz * TAU + phase) * primaryAmp
                + Math.sin(now * IDLE_SECONDARY_HZ * TAU + phase * 0.7) * primaryAmp * IDLE_SECONDARY_AMP_RATIO;

            // Slow weight transfer between the two feet — drives both hip roll
            // and the alternating knee bend below. ~12s per full cycle so the
            // viewer never catches it as a "rhythm".
            const weightShift = Math.sin(now * IDLE_WEIGHT_SHIFT_HZ * TAU);

            const hips = get("hips");
            if (hips) {
                // .set() so x/y/z are written atomically — partial writes can
                // corrupt the quaternion under non-default Euler order.
                hips.rotation.set(
                    0,
                    sway(IDLE_HIP_SWAY_HZ, IDLE_HIP_SWAY_AMP) * bodyGain,
                    weightShift * IDLE_WEIGHT_SHIFT_AMP * 0.6,
                );
            }

            const spine = get("spine");
            if (spine) spine.rotation.z = sway(IDLE_SPINE_SWAY_HZ, IDLE_SPINE_SWAY_AMP) * bodyGain;

            // Arms with L/R phase offset so they don't move in lockstep.
            const ls = get("leftUpperArm");
            const rs = get("rightUpperArm");
            const armSwayL = sway(IDLE_ARM_SWAY_HZ, IDLE_ARM_SWAY_AMP, IDLE_ASYMMETRY_PHASE_L) * bodyGain;
            const armSwayR = sway(IDLE_ARM_SWAY_HZ, IDLE_ARM_SWAY_AMP, IDLE_ASYMMETRY_PHASE_R) * bodyGain;
            // Auto-detect arm orientation once per VRM load.
            // We can't rely on world-space X position because both standard and
            // non-standard models place the left shoulder at ~+0.1 X. Instead,
            // empirically test whether a small positive rotation.z raises or
            // lowers the elbow — that directly tells us the sign we need.
            if (actor._armSign === undefined && ls) {
                const le = get("leftLowerArm");
                if (le) {
                    const _V3 = this.libs.THREE.Vector3;
                    const _before = new _V3();
                    const _after  = new _V3();
                    le.getWorldPosition(_before);
                    const _savedZ = ls.rotation.z;
                    ls.rotation.z = _savedZ + 0.5;          // small positive test
                    ls.updateWorldMatrix(true, true);        // propagate to children
                    le.getWorldPosition(_after);
                    ls.rotation.z = _savedZ;                 // restore T-pose
                    ls.updateWorldMatrix(true, true);
                    // Positive rotation raised the elbow → we must negate to lower it.
                    actor._armSign = _after.y > _before.y ? -1 : 1;
                } else {
                    actor._armSign = 1;  // safe default for standard VRM
                }
            }
            const _as = actor._armSign ?? 1;
            if (ls) ls.rotation.z = _as * IDLE_SHOULDER_DOWN + armSwayL;
            if (rs) rs.rotation.z = -_as * IDLE_SHOULDER_DOWN - armSwayR;

            const lElbow = get("leftLowerArm");
            const rElbow = get("rightLowerArm");
            if (lElbow) lElbow.rotation.y = -0.15;
            if (rElbow) rElbow.rotation.y =  0.15;

            // Auto-detect the finger-curl axis. VRM 0.x rigs conventionally
            // curl fingers via rotation.z (Blender bone-roll convention), but
            // VRM 1.0 relaxed the spec so individual exporters may use a
            // different local axis (e.g. .x). When the axis is wrong, the
            // existing _applyRelaxedHand call is a no-op and the fingers
            // extend straight from the wrist instead of softly curling.
            //
            // Test by applying curl to the left index chain on each axis/sign
            // and picking the one that brings the fingertip closest to the
            // wrist — that's the curl direction by definition. Cached per
            // VRM load and reused for every finger / both hands.
            const lIdxP = get("leftIndexProximal");
            const lIdxI = get("leftIndexIntermediate");
            const lIdxD = get("leftIndexDistal");
            if (actor._fingerCurl === undefined && lIdxP && lIdxI && lIdxD && ls) {
                const _V3 = this.libs.THREE.Vector3;
                const _hp = new _V3();   // hand world pos
                const _tp = new _V3();   // fingertip world pos
                const _hips = new _V3(); // hips world pos (body midline reference)
                const lHandForCurl = get("leftHand");
                const hipsBone = get("hips");
                if (hipsBone) hipsBone.getWorldPosition(_hips);
                else _hips.set(0, 0, 0);
                const _savedShZ = ls.rotation.z;
                ls.rotation.z = _as * IDLE_SHOULDER_DOWN;
                const segs = [lIdxP, lIdxI, lIdxD];
                const savedRot = segs.map(b => b.rotation.clone());
                for (const b of segs) b.rotation.set(0, 0, 0);
                ls.updateWorldMatrix(true, true);
                lHandForCurl.getWorldPosition(_hp);
                lIdxD.getWorldPosition(_tp);
                const baseDist = _tp.distanceTo(_hp);
                // Horizontal distance from hips (ignore Y so the down-pointing
                // arm length doesn't dominate). The curl should pull the
                // fingertip toward the body's midline in this XZ plane.
                const baseInward = Math.hypot(_tp.x - _hips.x, _tp.z - _hips.z);
                const AXES = ['x', 'y', 'z'];
                const SIGNS = [1, -1];
                // Score each candidate by (distance-to-wrist reduction) +
                // (inward movement toward hips in XZ). Pure distance-to-wrist
                // was ambiguous — multiple axes/signs shorten that, and we'd
                // pick the one that curls outward or backward. Tying it to
                // the hips position is rotation.y-agnostic, so the same
                // heuristic works for VRM 0.x (loaded with rotation.y=π)
                // and VRM 1.0 (rotation.y=0) without per-version branches.
                let bestAxis = null, bestSign = 0, bestScore = 0;
                let bestDelta = 0, bestInward = 0;
                for (const axis of AXES) {
                    for (const sign of SIGNS) {
                        for (const b of segs) {
                            b.rotation.set(0, 0, 0);
                            b.rotation[axis] = sign * 0.6;
                        }
                        ls.updateWorldMatrix(true, true);
                        lIdxD.getWorldPosition(_tp);
                        const delta = baseDist - _tp.distanceTo(_hp);
                        const inward = baseInward - Math.hypot(_tp.x - _hips.x, _tp.z - _hips.z);
                        // Require a real curl AND fingertip movement toward
                        // the body's midline (inward). Outward / backward
                        // curls get filtered out at this gate.
                        if (delta <= 0.005 || inward <= 0) continue;
                        const score = delta + inward;
                        if (score > bestScore) {
                            bestScore = score;
                            bestAxis = axis;
                            bestSign = sign;
                            bestDelta = delta;
                            bestInward = inward;
                        }
                    }
                }
                for (let i = 0; i < segs.length; i++) segs[i].rotation.copy(savedRot[i]);
                ls.rotation.z = _savedShZ;
                ls.updateWorldMatrix(true, true);
                actor._fingerCurl = bestAxis
                    ? { axis: bestAxis, sign: bestSign }
                    : null;
                console.log(
                    `[voice] finger curl detection: ` + (bestAxis
                        ? `axis=${bestAxis} sign=${bestSign > 0 ? '+' : '-'} (Δdist=${bestDelta.toFixed(3)}m, Δinward=${bestInward.toFixed(3)}m)`
                        : "no inward curl axis found — leaving fingers straight")
                );
            }

            // Lower body: gentle constant knee bend + alternating extra bend
            // on the off-leg as weight shifts. Locked legs were a big part of
            // the "stiff" read.
            const lUpperLeg = get("leftUpperLeg");
            const rUpperLeg = get("rightUpperLeg");
            const lLowerLeg = get("leftLowerLeg");
            const rLowerLeg = get("rightLowerLeg");
            // weightShift > 0 → weight on left foot → right knee bends more.
            const leftKneeExtra = Math.max(0, -weightShift) * IDLE_KNEE_BEND * 0.8;
            const rightKneeExtra = Math.max(0, weightShift) * IDLE_KNEE_BEND * 0.8;
            if (lUpperLeg) lUpperLeg.rotation.set(-IDLE_KNEE_BEND * 0.4 - leftKneeExtra * 0.5, 0, 0);
            if (rUpperLeg) rUpperLeg.rotation.set(-IDLE_KNEE_BEND * 0.4 - rightKneeExtra * 0.5, 0, 0);
            if (lLowerLeg) lLowerLeg.rotation.set(IDLE_KNEE_BEND + leftKneeExtra, 0, 0);
            if (rLowerLeg) rLowerLeg.rotation.set(IDLE_KNEE_BEND + rightKneeExtra, 0, 0);

            // Relaxed hand pose. Flat T-pose hands read as mannequin; a soft
            // curl across all four fingers + an opposed thumb is the "loose
            // grip on nothing" rest pose humans default to. Skipped if a
            // gesture is animating (we already bailed at the top of this fn).
            this._applyRelaxedHand(actor, "left");
            this._applyRelaxedHand(actor, "right");

            const head = get("head");
            if (head) {
                // Always-on small turn + speaking-only nod (x) and tilt (z).
                // Multiplied by `speak` so nod/tilt fade in smoothly when
                // speech starts and fade out (slow release) on stop/interrupt.
                head.rotation.set(
                    Math.sin(now * SPEAK_HEAD_NOD_HZ * TAU) * SPEAK_HEAD_NOD_AMP * speak,
                    Math.sin(now * IDLE_HEAD_TURN_HZ * TAU) * IDLE_HEAD_TURN_AMP,
                    Math.sin(now * SPEAK_HEAD_TILT_HZ * TAU) * SPEAK_HEAD_TILT_AMP * speak,
                );
                // Mascot cursor follow: the head carries a clamped share of
                // the gaze deflection. Measured as yaw/pitch DELTAS between
                // the cursor gaze point and the camera as seen from the head,
                // in head-parent space — deltas around local Y/X compose the
                // same way whatever the rig's rest facing, so no faceFront
                // cases. Primary actor only; peers keep plain eye contact.
                const cf = actor === this ? this._cursorFollow : null;
                if (cf && cf.blend > 0.005 && this._cursorGazePoint && head.parent && this.camera) {
                    const THREE = this.libs.THREE;
                    this._headTgtScratch ||= new THREE.Vector3();
                    this._headCamScratch ||= new THREE.Vector3();
                    const t = head.parent.worldToLocal(this._headTgtScratch.copy(this._cursorGazePoint));
                    const c = head.parent.worldToLocal(this._headCamScratch.copy(this.camera.position));
                    const p = head.position;
                    const yawTo = (v) => Math.atan2(v.x - p.x, v.z - p.z);
                    const pitchTo = (v) => Math.atan2(v.y - p.y, Math.hypot(v.x - p.x, v.z - p.z));
                    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
                    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
                    head.rotation.y += clamp(
                        wrap(yawTo(t) - yawTo(c)) * CURSOR_FOLLOW_HEAD_SHARE,
                        CURSOR_FOLLOW_HEAD_YAW,
                    ) * cf.blend;
                    // Pitch sign depends on the rig's local facing (yaw
                    // around Y doesn't): with forward +Z, positive rotation.x
                    // pitches the face DOWN, with forward -Z it pitches UP.
                    // Which way the rig faces here = which side of the head
                    // the camera sits on in this same space.
                    const pitchSign = c.z > p.z ? -1 : 1;
                    head.rotation.x += clamp(
                        pitchSign * wrap(pitchTo(t) - pitchTo(c)) * CURSOR_FOLLOW_HEAD_SHARE,
                        CURSOR_FOLLOW_HEAD_PITCH,
                    ) * cf.blend;
                }
            }
        } catch (e) { /* non-fatal */ }
    }

    /** Apply a relaxed-curl pose to one hand. VRM 0.x rigs conventionally
     *  curl fingers via rotation.z; some VRM 1.0 rigs use a different local
     *  axis. _fingerCurl is auto-detected in _applyIdle on first tick and
     *  stores `{axis, sign}` for the left hand; the right hand mirrors. The
     *  thumb opposition is handled separately because the thumb has its own
     *  axes (the existing y/z dual rotation is a reasonable default and
     *  worth refining only if thumbs look off after the finger fix lands).
     *  Bones missing from a particular VRM are silently skipped. */
    _applyRelaxedHand(actor, side) {
        const h = actor.vrm?.humanoid;
        if (!h) return;
        const sideSign = side === "left" ? 1 : -1;
        // Detected curl axis/sign is for the LEFT hand; right hand flips
        // sign for x/z axes (body mirror) and keeps it for y (longitudinal).
        const curl = actor._fingerCurl;
        const axis = curl?.axis ?? "z";
        const baseSign = curl?.sign ?? 1;
        const mirrorSign = axis === "y" ? baseSign : baseSign * sideSign;
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        const segments = [
            ["Proximal", IDLE_FINGER_CURL_PROXIMAL],
            ["Intermediate", IDLE_FINGER_CURL_INTERMEDIATE],
            ["Distal", IDLE_FINGER_CURL_DISTAL],
        ];
        for (const finger of ["index", "middle", "ring", "little"]) {
            for (const [seg, curlAmt] of segments) {
                const bone = h.getNormalizedBoneNode?.(`${side}${cap(finger)}${seg}`);
                if (bone) {
                    bone.rotation.set(0, 0, 0);
                    bone.rotation[axis] = mirrorSign * curlAmt;
                }
            }
        }
        for (const seg of ["Proximal", "Intermediate", "Distal"]) {
            const bone = h.getNormalizedBoneNode?.(`${side}Thumb${seg}`);
            if (bone) {
                bone.rotation.set(0, sideSign * IDLE_THUMB_OPPOSE, sideSign * IDLE_THUMB_CURL);
            }
        }
    }

    /** Expression names (VRM preset/custom) animated by a VRMA. Stamped onto
     *  gesture clips so the facial pipeline can yield those channels to the
     *  clip while it plays. */
    _vrmaExpressionNames(vrma) {
        const names = new Set();
        try {
            for (const key of vrma?.expressionTracks?.preset?.keys?.() ?? []) names.add(key);
            for (const key of vrma?.expressionTracks?.custom?.keys?.() ?? []) names.add(key);
        } catch (e) { /* older three-vrm-animation — no expression info */ }
        return names;
    }

    /** Expression names owned by the actor's running gesture clip, or null
     *  when no gesture (or an expressionless one) is playing. While a clip
     *  animates a face channel, the procedural writers below skip it so the
     *  choreographed face actually shows (they run after the mixer and would
     *  otherwise overwrite it every frame). */
    _gestureExpressions(actor) {
        const action = actor._gestureAction;
        if (!action || !action.isRunning?.()) return null;
        const names = action.getClip?.()?.rexclawExpressions;
        return names?.size ? names : null;
    }

    _applyVowels(actor) {
        const exp = actor.vrm?.expressionManager;
        if (!exp) return;
        const m = this.expressionMap;
        const vm = actor._visemeMap;
        // Live speech always wins the mouth; in silence, a gesture clip that
        // animates a viseme keeps it (otherwise we'd zero it every frame).
        const ge = this._gestureExpressions(actor);
        const speaking = ["aa", "ih", "ou", "ee", "oh"]
            .some((v) => (actor._currentVowels[v] || 0) > 0.01);
        for (const canonical of ["aa", "ih", "ou", "ee", "oh"]) {
            if (ge && !speaking && ge.has(canonical)) continue;
            // Use the discovered alias if available, fall back to canonical name.
            const exprName = vm?.[canonical] ?? canonical;
            exp.setValue(exprName, (actor._currentVowels[canonical] || 0) * (m[canonical] ?? 1));
        }
    }

    _applyEmotion(actor, delta) {
        const exp = actor.vrm?.expressionManager;
        if (!exp) return;
        const state = EMOTION_STATES[actor._currentEmotion] || EMOTION_STATES.neutral;

        // Target weight for every primary emotion expression: its cap when it's
        // the active emotion, 0 otherwise. Tracking all of them (not just the
        // active one) gives correct cross-fades — the outgoing emotion eases
        // down while the incoming one eases up.
        const targets = {};
        for (const key of Object.keys(EMOTION_STATES)) {
            const exprName = EMOTION_STATES[key].name;
            if (exprName) targets[exprName] = 0;
        }
        if (state.name) targets[state.name] = state.cap;

        // Capture the starting weights once per transition so the ease runs
        // from whatever was actually on the face.
        if (!actor._emotionTransitionStart) {
            actor._emotionTransitionStart = {};
            for (const exprName of Object.keys(targets)) {
                actor._emotionTransitionStart[exprName] = exp.getValue?.(exprName) || 0;
            }
        }

        const dur = state.blendDuration || 0.4;
        actor._emotionTransitionProgress = Math.min(
            1, actor._emotionTransitionProgress + (delta || 0) / Math.max(dur, 0.001),
        );
        const t = easeInOutCubic(actor._emotionTransitionProgress);

        // Emotion channels a running gesture clip animates belong to the
        // clip (the mixer wrote them this frame, before us).
        const ge = this._gestureExpressions(actor);
        for (const exprName of Object.keys(targets)) {
            if (ge?.has(exprName)) continue;
            const start = actor._emotionTransitionStart[exprName] ?? 0;
            exp.setValue(exprName, start + (targets[exprName] - start) * t);
        }

        // Secondary mouth-shape coupling. MAX against the current value —
        // _applyVowels already wrote live lipsync this frame, so speech wins;
        // in silence the emotion's subtle mouth shape shows through. Resolve
        // through the discovered viseme map so it targets the same expression
        // the lipsync path uses on this VRM.
        if (state.secondary) {
            for (const [vis, weight] of Object.entries(state.secondary)) {
                if (ge?.has(vis)) continue; // gesture clip owns this mouth channel
                const visName = actor._visemeMap?.[vis] ?? vis;
                const cur = exp.getValue?.(visName) || 0;
                exp.setValue(visName, Math.max(cur, weight * t));
            }
        }
    }

    /** Mascot cursor follow: feed one window-relative cursor sample (CSS px),
     *  or null to disengage. State only — the easing/blending happens in
     *  _applyEyeSaccade, and _applyIdle reads the resulting gaze point for
     *  the head share. Null eases the blend out before dropping the state,
     *  so toggling off glides back to eye contact instead of snapping. */
    setCursorFollow(point) {
        if (!point) {
            if (this._cursorFollow) this._cursorFollow.off = true;
            return;
        }
        const canvas = this.activeCanvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const clampN = (v) =>
            Math.max(-CURSOR_FOLLOW_NDC_MAX, Math.min(CURSOR_FOLLOW_NDC_MAX, v));
        const ndcX = clampN(((point.x - rect.left) / rect.width) * 2 - 1);
        const ndcY = clampN(-(((point.y - rect.top) / rect.height) * 2 - 1));
        let cf = this._cursorFollow;
        if (!cf) {
            cf = this._cursorFollow = {
                ndcX, ndcY, sx: ndcX, sy: ndcY, blend: 0, off: false,
                lastX: point.x, lastY: point.y, movedAt: performance.now(),
            };
        }
        cf.off = false;
        cf.ndcX = ndcX;
        cf.ndcY = ndcY;
        // The ~30 Hz feed repeats identical positions — only real movement
        // counts as "recently moved" (a still cursor releases the gaze).
        if (Math.abs(point.x - cf.lastX) >= 1 || Math.abs(point.y - cf.lastY) >= 1) {
            cf.movedAt = performance.now();
            cf.lastX = point.x;
            cf.lastY = point.y;
        }
    }

    _scheduleNextSaccade(now) {
        this._nextSaccadeAt = now + randomSaccadeInterval() / 1000;
    }

    /** Idle eye saccades. Nudges the look-at target by a small random offset
     *  around the eye-contact point (the camera) on a biologically-weighted
     *  interval, so the gaze re-fixates with quick darts instead of staring
     *  glassily. Offset stays small to preserve eye contact; darts shrink
     *  while speaking for more focused engagement. Also home of the mascot
     *  cursor-follow blend, which moves the fixation point itself (the
     *  saccade jitter rides on top wherever the gaze is). The eyes are
     *  driven by vrm.update(delta) in the loop, which reads this target.
     *  Runs every frame regardless of idle/gesture state. */
    _applyEyeSaccade(now, delta) {
        if (!this.vrm?.lookAt || !this._lookAtTarget || !this.camera || !this._saccadeOffset) return;
        if (this._nextSaccadeAt === undefined) this._scheduleNextSaccade(now);
        if (now >= this._nextSaccadeAt) {
            const amp = EYE_SACCADE_AMP * (1 - 0.4 * this._speakingIntensity);
            this._saccadeOffset.set(
                (Math.random() * 2 - 1) * amp,
                (Math.random() * 2 - 1) * amp,
                0,
            );
            this._scheduleNextSaccade(now);
        }
        // Gaze sits on the eye-contact point plus the saccade offset. In XR
        // `this.camera` is a dolly child whose .position is local (~origin) —
        // the real viewpoint is the HMD, so read its world position instead so
        // the avatar makes eye contact as the user moves their head.
        let cam = this.camera.position;
        if (this._xrActive && this.renderer?.xr) {
            const xrCam = this.renderer.xr.getCamera?.();
            if (xrCam) {
                this._eyeScratch ||= new this.libs.THREE.Vector3();
                cam = xrCam.getWorldPosition(this._eyeScratch);
            }
        }
        // Mascot cursor follow: blend the eye-contact point toward a point
        // CURSOR_FOLLOW_DEPTH in front of the camera along the cursor's ray.
        // Both the blend (engage / idle-release / toggle-off) and the NDC
        // ease exponentially so the 30 Hz feed reads as a glide, not steps.
        // _cursorGazePoint doubles as _applyIdle's head-share input.
        let gx = cam.x, gy = cam.y, gz = cam.z;
        const cf = this._cursorFollow;
        if (cf && !this._xrActive) {
            const THREE = this.libs.THREE;
            const k = 1 - Math.exp(-CURSOR_FOLLOW_RATE * (delta || 0.016));
            const engaged = !cf.off
                && (performance.now() - cf.movedAt) / 1000 < CURSOR_FOLLOW_IDLE_S;
            cf.blend += ((engaged ? 1 : 0) - cf.blend) * k;
            cf.sx += (cf.ndcX - cf.sx) * k;
            cf.sy += (cf.ndcY - cf.sy) * k;
            if (cf.blend < 0.005) {
                // Fully back on eye contact; a toggle-off can now drop state.
                if (cf.off) { this._cursorFollow = null; this._cursorGazePoint = null; }
            } else {
                this._cursorRaycaster ||= new THREE.Raycaster();
                this._cursorNdcScratch ||= new THREE.Vector2();
                this._cursorGazePoint ||= new THREE.Vector3();
                this._cursorNdcScratch.set(cf.sx, cf.sy);
                this._cursorRaycaster.setFromCamera(this._cursorNdcScratch, this.camera);
                const ray = this._cursorRaycaster.ray;
                this._cursorGazePoint.copy(ray.direction)
                    .multiplyScalar(CURSOR_FOLLOW_DEPTH).add(ray.origin);
                gx += (this._cursorGazePoint.x - gx) * cf.blend;
                gy += (this._cursorGazePoint.y - gy) * cf.blend;
                gz += (this._cursorGazePoint.z - gz) * cf.blend;
            }
        }
        this._lookAtTarget.position.set(
            gx + this._saccadeOffset.x,
            gy + this._saccadeOffset.y,
            gz,
        );
    }

    _loop() {
        // XR owns the loop via renderer.setAnimationLoop while a session is
        // presenting — don't double-drive (and don't reschedule rAF).
        if (this._xrActive) { this.rafHandle = null; return; }
        // Schedule on the window that owns the active host: when the canvas
        // lives in a document picture-in-picture window, the MAIN window's
        // rAF stops as soon as its tab is hidden — which would freeze the
        // avatar in the very window the user popped out to keep watching.
        const win = this.activeCanvas?.ownerDocument?.defaultView || window;
        this._rafWindow = win;
        this.rafHandle = win.requestAnimationFrame(() => this._loop());
        this._renderFrame();
    }

    /** Cancel the pending rAF on whichever window scheduled it. The owning
     *  window may be a closing PiP window — swallow the throw. */
    _cancelRaf() {
        if (!this.rafHandle) return;
        try { (this._rafWindow || window).cancelAnimationFrame(this.rafHandle); } catch (e) { /* window gone */ }
        this.rafHandle = null;
    }

    /** One rendered frame. Driven by requestAnimationFrame in flat mode and by
     *  renderer.setAnimationLoop (HMD-paced) while an XR session is active. */
    _renderFrame() {
        if (!this.renderer) return;
        if (this._xrActive) {
            // The headset owns the framebuffer + projection — never _resize in
            // XR (it would fight the XR layer), and OrbitControls is disabled.
        } else {
            if (!this.activeCanvas) return;
            this._resize(this.activeCanvas);
            // OrbitControls with damping needs per-frame update() to interpolate.
            if (this._orbitControls) {
                try { this._orbitControls.update(); } catch (e) { /* non-fatal */ }
            }
        }

        const delta = this.clock.getDelta();
        const now = this.clock.elapsedTime;

        // Steering first so the mixer + camera see this frame's position.
        // Locomotion runs in XR too (walkTo-driven placement from the VR move
        // mode); only the follow-camera below stays flat-mode-only.
        this._updateMovement(delta);
        if (this.mixer) this.mixer.update(delta);
        // Combo partner ticks with the same delta as the base mixer, so the
        // two clips stay in sync; vrm.update drives its spring bones (hair /
        // clothes) — the partner gets no blink/lipsync/gaze, only animation.
        if (this._comboPartner) {
            this._comboPartner.mixer.update(delta);
            try { this._comboPartner.vrm.update(delta); } catch (e) { /* non-fatal */ }
        }
        if (this.vrm) {
            // Order matters: idle bones first (sets base pose), then mixer if any
            // overrides them, then face-level adjustments on top.
            this._applyIdle(this, now);
            this._applyBlink(this, now);
            this._applyBreath(this, now);
            this._applyEyeSaccade(now, delta);
            this._applyVowels(this);
            this._applyEmotion(this, delta);
            // Physics/ragdoll write-back: after animation has posed the
            // normalized bones, before vrm.update copies them to the raw rig.
            for (const cb of this._preVRMUpdateCallbacks) {
                try { cb(delta, now); } catch (e) { /* non-fatal */ }
            }
            try {
                this.vrm.expressionManager?.update?.();
                this.vrm.update(delta);
            } catch (e) { /* non-fatal */ }
        }
        // Peer avatars (multi-agent calls): full facial + idle animation,
        // same pipeline as the base avatar, driven per-actor.
        if (this._peers.size) {
            for (const peer of this._peers.values()) {
                if (!peer.vrm) continue;
                if (peer.mixer) peer.mixer.update(delta);
                this._applyIdle(peer, now);
                this._applyBlink(peer, now);
                this._applyBreath(peer, now);
                this._applyVowels(peer);
                this._applyEmotion(peer, delta);
                try {
                    peer.vrm.expressionManager?.update?.();
                    peer.vrm.update(delta);
                } catch (e) { /* non-fatal */ }
            }
        }
        if (!this._xrActive) {
            // After movement so the follow-cam tracks the freshly advanced position.
            this._updateFollowCamera(delta);
        } else {
            // Place the viewer in front of the avatar on the first frame the
            // reference space is available (it can be null at sessionstart).
            if (this._xrPendingRecenter && this.renderer.xr.getReferenceSpace?.()) {
                this._xrPendingRecenter = false;
                this.recenterXR();
            }
            // XR per-frame consumers (controllers, proximity touch) run AFTER
            // vrm.update so bone world matrices reflect this frame's pose.
            for (const cb of this._xrFrameCallbacks) {
                try { cb(delta, now); } catch (e) { /* non-fatal */ }
            }
        }

        this.renderer.render(this.scene, this.camera);
    }

    // ── WebXR ───────────────────────────────────────────────────────────

    /** Resolve true if the browser/headset can present an immersive VR session.
     *  Gates the "Enter VR" affordance in the UI. */
    static async isXRSupported() {
        if (typeof navigator === "undefined" || !navigator.xr) return false;
        try { return await navigator.xr.isSessionSupported("immersive-vr"); }
        catch (e) { return false; }
    }

    /** Enter an immersive session. mode is "immersive-vr" (skybox backdrop) or
     *  "immersive-ar" (passthrough — the companion appears in the real room).
     *  AR silently falls back to VR where unsupported. MUST be called from a
     *  user gesture (WebXR requirement). The heavy lifting (dolly rig, loop
     *  switch, environment) happens in _onXRSessionStart once the session is
     *  actually granted. */
    async enterXR(mode = "immersive-vr") {
        await this._ensureRenderer();
        if (!navigator.xr) throw new Error("WebXR is not available in this browser.");
        let useMode = mode;
        if (mode === "immersive-ar") {
            const arOk = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
            if (!arOk) useMode = "immersive-vr";
        }
        this.renderer.xr.enabled = true;
        this.renderer.xr.setReferenceSpaceType("local-floor");
        if (!this._xrListenersWired) {
            this.renderer.xr.addEventListener("sessionstart", () => this._onXRSessionStart());
            this.renderer.xr.addEventListener("sessionend", () => this._onXRSessionEnd());
            this._xrListenersWired = true;
        }
        const session = await navigator.xr.requestSession(useMode, {
            // plane-detection feeds real-room colliders (ragdoll vs actual
            // furniture) where the browser supports it — Quest browser does,
            // Pico 4's does not yet; unsupported optional features are
            // silently ignored per the WebXR spec.
            optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking",
                "plane-detection", "mesh-detection"],
        });
        this._xrMode = useMode;
        await this.renderer.xr.setSession(session);
        return useMode;
    }

    /** Recenter the view (DeoVR-style "reset view"): re-place the viewer so the
     *  CURRENT head pose ends up standing `distance` in front of the avatar,
     *  facing her — without reloading. Uses the WebXR-native reference-space
     *  offset (getOffsetReferenceSpace / setReferenceSpace), the robust standard
     *  approach; full-pose so it also works lying on your back. */
    recenterXR({ distance = XR_DOLLY_DISTANCE } = {}) {
        if (!this._xrActive || !this.renderer?.xr || !this.libs) return;
        if (typeof XRRigidTransform === "undefined") return;
        // Passthrough/AR sessions must stay gravity- and floor-aligned: the
        // real room is visible, so any vertical offset or tilt in the
        // reference space visibly detaches the virtual content (and the
        // physics floor at y=0) from the physical floor. Full-pose recenter
        // (below) is only for immersive-vr, where it enables lying-back use.
        if (this._xrMode === "immersive-ar") return this._recenterXRYawOnly(distance);
        const xr = this.renderer.xr;
        const refSpace = xr.getReferenceSpace?.();
        const xrCam = xr.getCamera?.();
        if (!refSpace || !xrCam) return;
        const { THREE } = this.libs;

        // Target head pose T: standing `distance` in front of the avatar at her
        // eye height, looking straight at her. Avatar faces +Z, so "in front" is
        // +Z. A full pose (position + orientation), so mapping the live head
        // onto it reorients everything — it works lying on your back too.
        const ax = this.vrm?.scene?.position?.x || 0;
        const az = this.vrm?.scene?.position?.z || 0;
        const head = this.getHeadWorldPosition(this._rcHead ||= new THREE.Vector3());
        const hy = head ? head.y : (this._headWorldY ?? FACE_FALLBACK_HEAD_Y);
        const eye = (this._rcEye ||= new THREE.Vector3()).set(ax, hy, az + distance);
        const tgt = (this._rcTgt ||= new THREE.Vector3()).set(ax, hy, az);
        const up = (this._rcUp ||= new THREE.Vector3()).set(0, 1, 0);
        const one = (this._rcOne ||= new THREE.Vector3()).set(1, 1, 1);
        const lookM = (this._rcLook ||= new THREE.Matrix4()).lookAt(eye, tgt, up);
        const tQuat = (this._rcTQ ||= new THREE.Quaternion()).setFromRotationMatrix(lookM);
        const T = (this._rcT ||= new THREE.Matrix4()).compose(eye, tQuat, one);

        // Live head pose C in current scene coords (== the current reference
        // space frame, since three renders the scene in reference-space coords).
        const cPos = xrCam.getWorldPosition(this._rcP ||= new THREE.Vector3());
        const cQuat = xrCam.getWorldQuaternion(this._rcQ ||= new THREE.Quaternion());
        const C = (this._rcC ||= new THREE.Matrix4()).compose(cPos, cQuat, one);

        // originOffset = C · T⁻¹, so the new viewer pose = offset⁻¹ · C = T.
        // This is the WebXR-native recenter (getOffsetReferenceSpace) — robust,
        // and it never "flings" the camera the way ad-hoc dolly math does.
        const Tinv = (this._rcTinv ||= new THREE.Matrix4()).copy(T).invert();
        const offset = (this._rcOff ||= new THREE.Matrix4()).copy(C).multiply(Tinv);
        const oPos = (this._rcOPos ||= new THREE.Vector3());
        const oQuat = (this._rcOQuat ||= new THREE.Quaternion());
        offset.decompose(oPos, oQuat, this._rcOScale ||= new THREE.Vector3());

        try {
            const xform = new XRRigidTransform(
                { x: oPos.x, y: oPos.y, z: oPos.z, w: 1 },
                { x: oQuat.x, y: oQuat.y, z: oQuat.z, w: oQuat.w },
            );
            xr.setReferenceSpace(refSpace.getOffsetReferenceSpace(xform));
        } catch (e) {
            console.error("[voice] recenter failed", e);
        }
    }

    /** Floor-preserving recenter for AR/passthrough sessions: the offset is
     *  built from the head's YAW and horizontal position only, with the
     *  target eye kept at the CURRENT physical head height — so it contains
     *  no vertical translation and no pitch/roll. local-floor's y=0 stays
     *  glued to the real floor, which passthrough alignment and the ragdoll
     *  floor both depend on. Same offset math as the full-pose version, with
     *  C and T reduced to gravity-aligned poses. */
    _recenterXRYawOnly(distance) {
        const xr = this.renderer.xr;
        const refSpace = xr.getReferenceSpace?.();
        const xrCam = xr.getCamera?.();
        if (!refSpace || !xrCam) return;
        const { THREE } = this.libs;
        const ax = this.vrm?.scene?.position?.x || 0;
        const az = this.vrm?.scene?.position?.z || 0;

        // Live head pose reduced to yaw + position.
        const cPos = xrCam.getWorldPosition(this._rcP ||= new THREE.Vector3());
        const cQuat = xrCam.getWorldQuaternion(this._rcQ ||= new THREE.Quaternion());
        const fwd = (this._rcFwd ||= new THREE.Vector3()).set(0, 0, -1).applyQuaternion(cQuat);
        fwd.y = 0;
        const yaw = fwd.lengthSq() > 1e-6 ? Math.atan2(-fwd.x, -fwd.z) : 0;
        const up = (this._rcUp ||= new THREE.Vector3()).set(0, 1, 0);
        const one = (this._rcOne ||= new THREE.Vector3()).set(1, 1, 1);
        const cYawQ = (this._rcTQ ||= new THREE.Quaternion()).setFromAxisAngle(up, yaw);
        const C = (this._rcC ||= new THREE.Matrix4()).compose(cPos, cYawQ, one);

        // Target: standing `distance` in front of the avatar (+Z side) at the
        // SAME physical eye height, facing her — facing -Z is yaw 0.
        const eye = (this._rcEye ||= new THREE.Vector3()).set(ax, cPos.y, az + distance);
        const tQuat = (this._rcTQ2 ||= new THREE.Quaternion()).identity();
        const T = (this._rcT ||= new THREE.Matrix4()).compose(eye, tQuat, one);

        const Tinv = (this._rcTinv ||= new THREE.Matrix4()).copy(T).invert();
        const offset = (this._rcOff ||= new THREE.Matrix4()).copy(C).multiply(Tinv);
        const oPos = (this._rcOPos ||= new THREE.Vector3());
        const oQuat = (this._rcOQuat ||= new THREE.Quaternion());
        offset.decompose(oPos, oQuat, this._rcOScale ||= new THREE.Vector3());
        try {
            const xform = new XRRigidTransform(
                { x: oPos.x, y: oPos.y, z: oPos.z, w: 1 },
                { x: oQuat.x, y: oQuat.y, z: oQuat.z, w: oQuat.w },
            );
            xr.setReferenceSpace(refSpace.getOffsetReferenceSpace(xform));
        } catch (e) {
            console.error("[voice] recenter (yaw-only) failed", e);
        }
    }

    /** Switch the XR backdrop within the active session. "passthrough" clears
     *  the scene so the headset's real-world feed shows; "skybox" paints an
     *  opaque backdrop that occludes passthrough for a contained VR look.
     *  In an immersive-ar session this toggles the AR↔VR feel with NO session
     *  restart (an immersive-vr session can only ever show the skybox). */
    setXREnvironment(envMode) {
        if (!this._xrActive) return;
        this._xrEnvMode = envMode === "passthrough" ? "passthrough" : "skybox";
        this._applyXREnvironment();
    }

    /** Flip passthrough ↔ skybox. Returns the new mode (or null if not in XR). */
    toggleXREnvironment() {
        if (!this._xrActive) return null;
        if (this._xrMode !== "immersive-ar") {
            // No passthrough available in a VR session — stay on skybox.
            this.setXREnvironment("skybox");
            return "skybox";
        }
        const next = this._xrEnvMode === "passthrough" ? "skybox" : "passthrough";
        this.setXREnvironment(next);
        return next;
    }

    _applyXREnvironment() {
        const room = this._room;
        if (this._xrEnvMode === "passthrough") {
            // Real-world passthrough: hide any GLB scene so it doesn't clip
            // with the headset's camera feed.
            this.scene.background = null;
            this.renderer.setClearAlpha?.(0);
            if (room) room.visible = false;
        } else {
            // Virtual world: show the GLB scene if one is loaded (it IS the
            // environment) with an opaque clear behind any gaps; otherwise
            // paint a solid skybox so it isn't an empty void.
            if (room) {
                room.visible = true;
                this.scene.background = null;
                this.renderer.setClearColor?.(XR_VR_BG, 1);
            } else {
                this.scene.background = new this.libs.THREE.Color(XR_VR_BG);
                this.renderer.setClearAlpha?.(1);
            }
        }
    }

    /** Leave the active immersive session. session.end() dispatches "sessionend",
     *  which routes to _onXRSessionEnd for teardown. */
    async exitXR() {
        const session = this.renderer?.xr?.getSession?.();
        if (session) {
            try { await session.end(); } catch (e) { /* _onXRSessionEnd still runs */ }
        } else if (this._xrActive) {
            this._onXRSessionEnd();
        }
    }

    _onXRSessionStart() {
        if (this._xrActive) return;
        this._xrActive = true;
        // Stop the flat rAF loop — the headset drives frames from here on.
        this._cancelRaf();
        this._disableOrbit();
        // Capture the base reference space (may be null until the first frame)
        // and defer initial placement to the first XR frame, when the viewer
        // pose is available. No dolly — placement is a reference-space offset.
        this._xrBaseRefSpace = this.renderer.xr.getReferenceSpace?.() || null;
        this._xrPendingRecenter = true;
        // Environment start state. A GLB scene background is itself the world,
        // so start in "virtual" (scene visible, passthrough off) — otherwise the
        // GLB geometry clips with passthrough. With no scene, an AR session
        // starts in passthrough (the companion in your real room).
        this._savedSceneBackground = this.scene.background;
        const hasScene = !!this._room || this._currentBackground?.type === "scene";
        this._xrEnvMode = (this._xrMode === "immersive-ar" && !hasScene) ? "passthrough" : "skybox";
        this._applyXREnvironment();
        this.renderer.setAnimationLoop(() => this._renderFrame());
        // Notify VR add-ons (renderer is the WebGLRenderer; controllers parent
        // to ctx.scene — their poses already include the reference-space offset).
        const ctx = {
            renderer: this.renderer,
            scene: this.scene,
            camera: this.camera,
            THREE: this.libs.THREE,
            mode: this._xrMode,
        };
        for (const l of this._xrSessionListeners) {
            try { l.onStart?.(ctx); } catch (e) { /* non-fatal */ }
        }
    }

    _onXRSessionEnd() {
        if (!this._xrActive) return;
        this.renderer.setAnimationLoop(null);
        // Let VR add-ons dispose their controllers/meshes BEFORE the dolly
        // (their parent) is torn down.
        for (const l of this._xrSessionListeners) {
            try { l.onEnd?.(); } catch (e) { /* non-fatal */ }
        }
        // Drop any recenter offset so the next session starts from a clean origin.
        if (this._xrBaseRefSpace) {
            try { this.renderer.xr.setReferenceSpace(this._xrBaseRefSpace); } catch (e) { /* non-fatal */ }
        }
        this._xrBaseRefSpace = null;
        this._xrPendingRecenter = false;
        if (this._savedSceneBackground !== undefined) {
            this.scene.background = this._savedSceneBackground;
            this._savedSceneBackground = undefined;
        }
        // Un-hide the GLB scene (passthrough mode may have hidden it) so the
        // flat view shows it again.
        if (this._room) this._room.visible = true;
        // alpha:true renderer composites over the CSS host background in flat mode.
        this.renderer.setClearAlpha?.(0);
        this._xrActive = false;
        this._xrMode = null;
        // Re-frame the flat camera and resume the rAF loop.
        this._applyCameraPreset();
        if (this._fullBody) this._enableOrbit();
        if (!this.rafHandle) this._loop();
    }

    /** World-space position of the VRM head bone, for positioning a spatial
     *  audio PannerNode at the avatar's mouth. Returns a (reused) Vector3 or
     *  null if no VRM is loaded. Valid after the per-frame vrm.update(). */
    getHeadWorldPosition(out) {
        const head = this.vrm?.humanoid?.getNormalizedBoneNode?.("head");
        if (!head || !this.libs) return null;
        const v = out || (this._headWorldScratch ||= new this.libs.THREE.Vector3());
        return head.getWorldPosition(v);
    }

    /** HMD listener pose for spatial audio: world position + forward/up unit
     *  vectors of the XR camera, as plain numbers (keeps three out of
     *  voice_service). Null outside an XR session. */
    getXRListenerPose() {
        const xrCam = this.renderer?.xr?.getCamera?.();
        if (!xrCam || !this.libs) return null;
        const { THREE } = this.libs;
        const p = (this._lp ||= new THREE.Vector3());
        const q = (this._lq ||= new THREE.Quaternion());
        const f = (this._lf ||= new THREE.Vector3());
        const u = (this._lu ||= new THREE.Vector3());
        xrCam.getWorldPosition(p);
        xrCam.getWorldQuaternion(q);
        f.set(0, 0, -1).applyQuaternion(q);
        u.set(0, 1, 0).applyQuaternion(q);
        return {
            px: p.x, py: p.y, pz: p.z,
            fx: f.x, fy: f.y, fz: f.z,
            ux: u.x, uy: u.y, uz: u.z,
        };
    }

    /** Humanoid bone nodes the proximity touch-detector tests hands against.
     *  Re-call after every avatar swap (the humanoid is rebuilt by loadVRM). */
    getHumanoidBones() {
        const h = this.vrm?.humanoid;
        if (!h) return [];
        const out = [];
        for (const name of XR_TOUCH_BONES) {
            const node = h.getNormalizedBoneNode?.(name);
            if (node) out.push({ name, node });
        }
        return out;
    }

    // ── Spring-bone hand colliders (VR touch physics) ───────────────────
    // The VR hands become real colliders for the avatar's spring bones
    // (hair / chest / clothing), so touching physically displaces them —
    // the FastSpringBone interaction feel, no physics engine required.

    /** Create sphere colliders parented to the given host objects (VR hand
     *  groups) and register them with every loaded VRM's spring bone manager.
     *  hosts: [{ object, radius?, offset? {x,y,z} }]. Call on XR session
     *  start; detachSpringBoneColliders() on session end. */
    attachSpringBoneColliders(hosts) {
        const { THREE, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere } = this.libs || {};
        if (!VRMSpringBoneCollider || !hosts?.length) return;
        this.detachSpringBoneColliders();
        const colliders = hosts.map(({ object, radius = 0.07, offset }) => {
            const shape = new VRMSpringBoneColliderShapeSphere({
                radius,
                offset: offset ? new THREE.Vector3(offset.x, offset.y, offset.z) : undefined,
            });
            const collider = new VRMSpringBoneCollider(shape);
            object.add(collider);
            return collider;
        });
        this._xrHandColliderGroup = { colliders, name: "xr-hands" };
        if (this.vrm) this._applySpringCollidersToVRM(this.vrm);
        for (const peer of this._peers.values()) {
            if (peer.vrm) this._applySpringCollidersToVRM(peer.vrm);
        }
        if (this._comboPartner?.vrm) this._applySpringCollidersToVRM(this._comboPartner.vrm);
    }

    /** Register the active hand-collider group with one VRM's spring bone
     *  joints. Re-adding a joint marks the manager's dependency sort dirty so
     *  the new collider is picked up. Safe no-op when no group is active. */
    _applySpringCollidersToVRM(vrm) {
        const group = this._xrHandColliderGroup;
        const mgr = vrm?.springBoneManager;
        if (!group || !mgr) return;
        try {
            for (const joint of mgr.joints) {
                if (!joint.colliderGroups.includes(group)) {
                    joint.colliderGroups.push(group);
                    mgr.addJoint(joint);
                }
            }
        } catch (e) { /* non-fatal — touch physics is a bonus, never break loading */ }
    }

    /** Undo attachSpringBoneColliders: unregister the group from every VRM
     *  and remove the collider objects from their hosts. */
    detachSpringBoneColliders() {
        const group = this._xrHandColliderGroup;
        if (!group) return;
        this._xrHandColliderGroup = null;
        const vrms = [this.vrm, ...[...this._peers.values()].map((p) => p.vrm), this._comboPartner?.vrm];
        for (const vrm of vrms) {
            const mgr = vrm?.springBoneManager;
            if (!mgr) continue;
            try {
                for (const joint of mgr.joints) {
                    const i = joint.colliderGroups.indexOf(group);
                    if (i >= 0) {
                        joint.colliderGroups.splice(i, 1);
                        mgr.addJoint(joint);   // re-dirty the dependency sort
                    }
                }
            } catch (e) { /* non-fatal */ }
        }
        for (const c of group.colliders) c.parent?.remove(c);
    }

    /** Register a callback that runs each frame AFTER animation has posed the
     *  normalized bones but BEFORE vrm.update() copies them to the raw rig —
     *  the only window where a physics write-back (ragdoll) can override the
     *  pose. Returns an unsubscribe fn. */
    addPreVRMUpdateCallback(cb) {
        this._preVRMUpdateCallbacks.add(cb);
        return () => this._preVRMUpdateCallbacks.delete(cb);
    }

    /** Register a per-XR-frame callback (controllers, touch detection). Runs
     *  after vrm.update each frame. Returns an unsubscribe fn. */
    addXRFrameCallback(cb) {
        this._xrFrameCallbacks.add(cb);
        return () => this._xrFrameCallbacks.delete(cb);
    }

    removeXRFrameCallback(cb) {
        this._xrFrameCallbacks.delete(cb);
    }

    /** Register a VR add-on (vr_manager) notified when an immersive session
     *  starts/ends. onStart(ctx) receives { renderer (WebGLRenderer), scene,
     *  camera, THREE, mode }; parent controllers to ctx.scene. onEnd() runs on
     *  session end. Returns an unsubscribe fn. */
    addXRSessionListener(listener) {
        this._xrSessionListeners.add(listener);
        return () => this._xrSessionListeners.delete(listener);
    }

    get isInXR() {
        return this._xrActive;
    }

    /** Current XR backdrop mode ("passthrough" | "skybox") — read by the
     *  world-space panel to label its environment button, incl. after the
     *  hardware A/X toggle. */
    get xrEnvMode() {
        return this._xrEnvMode;
    }

    /** Instance passthrough to the static support check, convenient for UI
     *  components that hold the service instance rather than the class. */
    checkXRSupport() {
        return AvatarRenderer.isXRSupported();
    }

    /** Resolve true if the browser/headset can present an immersive AR
     *  (passthrough / mixed-reality) session — Pico 4 and Quest browsers
     *  report this; desktop browsers generally don't. */
    static async isARSupported() {
        if (typeof navigator === "undefined" || !navigator.xr) return false;
        try { return await navigator.xr.isSessionSupported("immersive-ar"); }
        catch (e) { return false; }
    }

    checkARSupport() {
        return AvatarRenderer.isARSupported();
    }
}

// Singleton — every surface (canvas hosts, voice service, tool dispatcher)
// shares one renderer to stay under Chrome's WebGL context cap. The window
// handle is a debug escape hatch (loadRoom()/clearRoom() etc.).
export const avatarRenderer = new AvatarRenderer();
if (typeof window !== "undefined") {
    window.__voiceRenderer = avatarRenderer;
}
