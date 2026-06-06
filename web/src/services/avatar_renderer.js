
/**
 * Avatar renderer service.
 *
 * Singleton three.js WebGLRenderer + scene + active VRM model. Both the systray
 * mini canvas and the full-screen client action share this single instance to
 * avoid hitting Chrome's 16-WebGL-context cap.
 *
 * three.js + @pixiv/three-vrm + three-vrm-animation are loaded from esm.sh on
 * first mount — keeps the backend asset bundle minimal for users who never
 * open the avatar.
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
import { VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Kept async + memoized so the renderer code below stays identical to the
// CDN-loading version it was ported from.
async function loadLibs() {
    return {
        THREE: THREE_NS,
        VRMLoaderPlugin,
        VRMUtils,
        VRMExpressionPresetName,
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
// - Look-at: always at camera. "Cursor follow" is gimmicky and breaks eye contact.
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

class AvatarRenderer {
    constructor() {
        this.libs = null;
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.mixer = null;
        this.idleClipAction = null;
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
        this._rawSpeakingIntensity = 0;   // set by setSpeakingIntensity()
        this._speakingIntensity = 0;      // smoothed for animation
        this._fullBody = false;           // false = face shot, true = full-body + orbit
        this._orbitControls = null;       // OrbitControls when fullBody mode active
        this._room = null;                // optional GLB environment behind the avatar (see loadRoom)
        this._loadedRoomUrl = null;       // url of the currently-loaded room — idempotency for repeated applies
        this._roomLoadGeneration = 0;     // monotonic — newest loadRoom/clearRoom wins; superseded in-flight loads self-dispose

        // Locomotion state (see the MOVE_* constants above).
        this._moveMode = false;           // manual (WASD) input enabled by the full view toggle
        this._moveInput = { x: 0, z: 0 }; // camera-relative manual direction (x = strafe right, z = forward)
        this._moveTarget = null;          // THREE.Vector3 — walkTo() destination, or null
        this._moving = false;             // walk clip + slide currently active
        this._walkAction = null;          // looping walk action, bound to the current VRM's mixer
        this._baseQuat = null;            // vrm.scene orientation as normalised at load (see _setMoveYaw)
        this._moveYaw = 0;                // world yaw locomotion has applied on top of _baseQuat
        this._returnFacingY = null;       // target yaw for the ease-back-to-camera after stopping
        this._camFollowPos = null;        // THREE.Vector3 — smoothed avatar XZ the camera rig is anchored to

        // Hardcoded vowel weight multipliers, calibrated for VRoid Studio's
        // standard viseme blendshapes. Used by _applyVowels to scale lipsync.
        this.expressionMap = { aa: 1.0, ih: 0.7, ou: 0.7, ee: 0.6, oh: 0.8 };
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

        this._scheduleNextBlink();
        this._scheduleNextSaccade(this.clock?.elapsedTime || 0);
        this._buildVisemeMap();
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
    _buildVisemeMap() {
        this._visemeMap = null;
        const exp = this.vrm?.expressionManager;
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
        this._visemeMap = map;

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
        }
    }

    /** Manual movement direction, camera-relative: x = strafe right, z =
     *  forward (away from the camera). (0,0) = no input. Fed on key change by
     *  the full view's WASD handler; consumed per-frame in _updateMovement. */
    setMoveInput(x, z) {
        this._moveInput.x = Math.max(-1, Math.min(1, x || 0));
        this._moveInput.z = Math.max(-1, Math.min(1, z || 0));
    }

    /** Walk to a world-space XZ position: turn toward it, advance, settle to
     *  idle on arrival. The foundation the future semantic move tool
     *  (approach / step_back / anchors) will compose on. */
    walkTo(x, z) {
        if (!this.vrm || !this.libs) return;
        const { THREE } = this.libs;
        // Clamp the destination into the playable area, preserving direction.
        const r = Math.hypot(x, z);
        if (r > MOVE_BOUNDS_RADIUS) {
            x *= MOVE_BOUNDS_RADIUS / r;
            z *= MOVE_BOUNDS_RADIUS / r;
        }
        this._moveTarget = new THREE.Vector3(x, 0, z);
    }

    /** Stop any walking (manual or walkTo) and ease back to idle. */
    stopMoving() {
        this._moveTarget = null;
        if (this._moving) this._stopWalkAnim();
    }

    /** Lazily build the looping walk action for the CURRENT vrm. The parsed
     *  walking.vrma is cached module-wide (avatar-independent), but the
     *  AnimationClip is baked against a specific model's normalized bones, so
     *  it's rebuilt after every avatar/outfit swap (_doLoadVRM nulls it). */
    async _ensureWalkAction() {
        if (this._walkAction) return this._walkAction;
        if (!this.vrm || !this.mixer) return null;
        const vrmAtCall = this.vrm;
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
            if (!vrma || this.vrm !== vrmAtCall || !this.mixer) return null;
            const clip = createVRMAnimationClip(vrma, this.vrm);
            this._stripWalkRootMotion(clip);
            const action = this.mixer.clipAction(clip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            this._walkAction = action;
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
    _stripWalkRootMotion(clip) {
        const hipsName = this.vrm.humanoid?.getNormalizedBoneNode?.("hips")?.name;
        if (!hipsName) return;
        for (const track of clip.tracks) {
            if (track.name !== `${hipsName}.position`) continue;
            for (let i = 0; i < track.values.length; i += 3) {
                track.values[i] = 0;
                track.values[i + 2] = 0;
            }
        }
    }

    /** Crossfade into the walk loop. Async because the first walk lazily
     *  loads walking.vrma — `_moving` is set synchronously so per-frame
     *  callers don't re-enter while the file downloads. */
    async _startWalkAnim() {
        if (this._moving) return;
        this._moving = true;
        this._returnFacingY = null;
        // Movement owns the body: ease out any in-flight gesture first.
        this.stopGesture();
        const action = await this._ensureWalkAction();
        if (!action) return;             // load failed — slide without the clip
        if (!this._moving) return;       // stopped while the clip downloaded
        if (this.idleClipAction) this.idleClipAction.fadeOut(WALK_FADE_IN);
        action.reset().fadeIn(WALK_FADE_IN).play();
    }

    /** Crossfade walk → idle and queue the ease-back-to-camera facing. Same
     *  fade-then-stop pattern as gestures (a faded-out action still counts as
     *  isRunning, which would wedge the procedural-idle guard). */
    _stopWalkAnim() {
        this._moving = false;
        const action = this._walkAction;
        if (action) {
            action.fadeOut(WALK_FADE_OUT);
            setTimeout(() => {
                if (!this._moving) { try { action.stop(); } catch (e) { /* */ } }
            }, WALK_FADE_OUT * 1000);
        }
        if (this.idleClipAction) this.idleClipAction.reset().fadeIn(WALK_FADE_OUT).play();
        // A companion turns to face you when she stops — not frozen
        // mid-stride aimed at a wall. Eased per-frame in _applyReturnFacing.
        if (this.vrm && this.camera) {
            const p = this.vrm.scene.position;
            this._returnFacingY =
                Math.atan2(this.camera.position.x - p.x, this.camera.position.z - p.z);
        }
    }

    /** Per-frame locomotion. Manual input wins over a walkTo target. Steering
     *  is kinematic: rotate toward the travel direction at
     *  MOVE_TURN_SPEED while advancing at MOVE_SPEED — the walk clip plays in
     *  place; THIS is what moves the avatar. */
    _updateMovement(delta) {
        if (!this.vrm || !this.libs) return;
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
            const d = new THREE.Vector3().subVectors(this._moveTarget, this.vrm.scene.position);
            d.y = 0;
            if (d.length() < MOVE_ARRIVAL_THRESHOLD) {
                this.stopMoving();
                return;
            }
            dir = d.normalize();
        }

        if (!dir) {
            if (this._moving) this._stopWalkAnim();  // keys released mid-walk
            this._applyReturnFacing(delta);
            return;
        }

        if (!this._moving) this._startWalkAnim();
        this._returnFacingY = null;

        // Turn the shortest way toward the travel direction, then advance.
        // Yaw is composed onto the base quaternion (_setMoveYaw) — never
        // written through rotation.y; see the _baseQuat note in _doLoadVRM.
        const targetYaw = Math.atan2(dir.x, dir.z);
        let diff = targetYaw - this._moveYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const turnStep = MOVE_TURN_SPEED * delta;
        this._setMoveYaw(Math.abs(diff) <= turnStep
            ? targetYaw
            : this._moveYaw + Math.sign(diff) * turnStep);

        const pos = this.vrm.scene.position;
        pos.addScaledVector(dir, MOVE_SPEED * delta);
        const r = Math.hypot(pos.x, pos.z);
        if (r > MOVE_BOUNDS_RADIUS) {
            pos.x *= MOVE_BOUNDS_RADIUS / r;
            pos.z *= MOVE_BOUNDS_RADIUS / r;
        }
    }

    /** After stopping, ease the avatar around to face the camera again —
     *  gentler than travel turns so it reads as a casual turn, not a snap. */
    _applyReturnFacing(delta) {
        if (this._returnFacingY == null || !this.vrm) return;
        let diff = this._returnFacingY - this._moveYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const step = MOVE_TURN_SPEED * 0.6 * delta;
        if (Math.abs(diff) <= step) {
            this._setMoveYaw(this._returnFacingY);
            this._returnFacingY = null;
        } else {
            this._setMoveYaw(this._moveYaw + Math.sign(diff) * step);
        }
    }

    /** Point the avatar at a world yaw by composing R_y(yaw) onto the
     *  load-time base orientation: quaternion = R_y(yaw) ∘ _baseQuat. The
     *  base may be a euler-hostile 180° flip ((±π, ~0, ±π) representation),
     *  so rotation.y is never written directly — quaternion composition is
     *  representation-proof. yaw 0 = facing +Z (toward the default camera). */
    _setMoveYaw(yaw) {
        this._moveYaw = yaw;
        if (!this.vrm || !this._baseQuat || !this.libs) return;
        const { THREE } = this.libs;
        if (!this._yawQuat) {
            this._yawQuat = new THREE.Quaternion();
            this._yawAxis = new THREE.Vector3(0, 1, 0);
        }
        this._yawQuat.setFromAxisAngle(this._yawAxis, yaw);
        this.vrm.scene.quaternion.copy(this._yawQuat).multiply(this._baseQuat);
    }

    /** Trailing camera dolly: translate the camera AND the orbit target by
     *  the avatar's smoothed XZ displacement. Pure translation — height, zoom
     *  and orbit angle are untouched, so face-shot and full-body framings
     *  both keep their composition while following. Cheap no-op when the
     *  avatar isn't moving. */
    _updateFollowCamera(delta) {
        if (!this.vrm || !this.camera || !this.libs) return;
        const { THREE } = this.libs;
        const p = this.vrm.scene.position;
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
        if (this._moving) this._stopWalkAnim();
        this._returnFacingY = null;  // _stopWalkAnim queues one — home needs none
        this.vrm.scene.position.set(0, 0, 0);
        this._setMoveYaw(0);  // base orientation = facing the default camera
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
     *  only). Also reachable manually via the window.odoo.__voiceRenderer debug
     *  handle, e.g.:
     *    odoo.__voiceRenderer?.loadRoom("/web/content/.../scene_file",
     *                                   { position: [0,0,-1], scale: 1 })
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
        if (this.vrm && (this._moving || this.vrm.scene.position.lengthSq() > 1e-6)) {
            this._resetAvatarHome();
        }

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

    mount(canvas) {
        if (!this._hostStack) this._hostStack = [];
        // Track host order so unmounts can fall back to the next-most-recent.
        const idx = this._hostStack.indexOf(canvas);
        if (idx !== -1) this._hostStack.splice(idx, 1);
        this._hostStack.push(canvas);
        this.activeCanvas = canvas;
        this._reparent(canvas);
        this._resize(canvas);
        if (!this.rafHandle) {
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
            } else {
                if (this.rafHandle) {
                    cancelAnimationFrame(this.rafHandle);
                    this.rafHandle = null;
                }
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
        // bindings become useless — dispose and rebind to the new host.
        if (this._fullBody && this._orbitControls) {
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
        const ax = this.vrm?.scene?.position?.x || 0;
        const az = this.vrm?.scene?.position?.z || 0;

        if (this._fullBody) {
            const center = (meshTopY + meshBottomY) / 2;
            const height = (meshTopY - meshBottomY) * FULL_FRAME_PADDING;
            const distance = Math.max(
                FULL_MIN_DISTANCE,
                height / (2 * Math.tan((FULL_FOV * Math.PI) / 360)),
            );
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
        const height = (frameTop - frameBottom) * FACE_FRAME_PADDING;
        const distance = Math.max(
            FACE_MIN_DISTANCE,
            height / (2 * Math.tan((FACE_FOV * Math.PI) / 360)),
        );
        return {
            position: [ax, center, az + distance],
            target: [ax, center, az],
            fov: FACE_FOV,
        };
    }

    _applyCameraPreset() {
        if (!this.camera) return;
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

    _scheduleNextBlink() {
        const span = BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN;
        this._nextBlinkAt = (this.clock?.elapsedTime || 0) + BLINK_INTERVAL_MIN + Math.random() * span;
    }

    _applyBlink(now) {
        if (!this.vrm?.expressionManager) return;
        if (now >= this._nextBlinkAt) {
            const t = now - this._nextBlinkAt;
            if (t < BLINK_CLOSE_DURATION) {
                this.vrm.expressionManager.setValue("blink", t / BLINK_CLOSE_DURATION);
            } else if (t < BLINK_CLOSE_DURATION + BLINK_OPEN_DURATION) {
                const phase = (t - BLINK_CLOSE_DURATION) / BLINK_OPEN_DURATION;
                this.vrm.expressionManager.setValue("blink", 1 - phase);
            } else {
                this.vrm.expressionManager.setValue("blink", 0);
                this._scheduleNextBlink();
            }
        } else {
            this.vrm.expressionManager.setValue("blink", 0);
        }
    }

    _applyBreath(now) {
        if (!this.vrm) return;
        try {
            const head = this.vrm.humanoid?.getNormalizedBoneNode?.("head");
            if (head && this._headBaseY) {
                // baseY + sin(t*ω) — never += to avoid drift accumulation.
                head.position.y = this._headBaseY + Math.sin(now * BREATH_FREQUENCY_HZ * 2 * Math.PI) * BREATH_AMPLITUDE;
            }
        } catch (e) { /* non-fatal */ }
    }

    /** Procedural idle pose + speaking gestures. Drops arms from T-pose and
     *  adds subtle sway. When `_speakingIntensity > 0`, body sway scales up
     *  and a head nod/tilt is layered in so the avatar visibly "talks with
     *  her body". Skipped entirely if a VRMA mixer action is playing, so
     *  user-supplied animation clips win.
     */
    _applyIdle(now) {
        if (!this.vrm?.humanoid) return;
        if (this.idleClipAction && this.idleClipAction.isRunning()) return;
        // A one-shot gesture is animating — let it own the bones; procedural
        // idle would fight it and produce a weird blend.
        if (this._gestureAction && this._gestureAction.isRunning()) return;
        // Walking — the walk clip owns the bones (procedural idle would
        // overwrite the mixer output every frame; see _loop's update order).
        if (this._moving) return;

        // Smooth raw intensity into animation-driving intensity.
        const target = this._rawSpeakingIntensity;
        const a = target > this._speakingIntensity ? SPEAK_INTENSITY_ATTACK : SPEAK_INTENSITY_RELEASE;
        this._speakingIntensity = this._speakingIntensity * (1 - a) + target * a;
        const speak = this._speakingIntensity;
        // Body gain ranges 1.0 (idle) → SPEAK_BODY_GAIN (peak speaking).
        const bodyGain = 1 + (SPEAK_BODY_GAIN - 1) * speak;

        try {
            const h = this.vrm.humanoid;
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
            if (this._armSign === undefined && ls) {
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
                    this._armSign = _after.y > _before.y ? -1 : 1;
                } else {
                    this._armSign = 1;  // safe default for standard VRM
                }
            }
            const _as = this._armSign ?? 1;
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
            if (this._fingerCurl === undefined && lIdxP && lIdxI && lIdxD && ls) {
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
                this._fingerCurl = bestAxis
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
            this._applyRelaxedHand("left");
            this._applyRelaxedHand("right");

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
    _applyRelaxedHand(side) {
        const h = this.vrm?.humanoid;
        if (!h) return;
        const sideSign = side === "left" ? 1 : -1;
        // Detected curl axis/sign is for the LEFT hand; right hand flips
        // sign for x/z axes (body mirror) and keeps it for y (longitudinal).
        const curl = this._fingerCurl;
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

    _applyVowels() {
        const exp = this.vrm?.expressionManager;
        if (!exp) return;
        const m = this.expressionMap;
        const vm = this._visemeMap;
        for (const canonical of ["aa", "ih", "ou", "ee", "oh"]) {
            // Use the discovered alias if available, fall back to canonical name.
            const exprName = vm?.[canonical] ?? canonical;
            exp.setValue(exprName, (this._currentVowels[canonical] || 0) * (m[canonical] ?? 1));
        }
    }

    _applyEmotion(delta) {
        const exp = this.vrm?.expressionManager;
        if (!exp) return;
        const state = EMOTION_STATES[this._currentEmotion] || EMOTION_STATES.neutral;

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
        if (!this._emotionTransitionStart) {
            this._emotionTransitionStart = {};
            for (const exprName of Object.keys(targets)) {
                this._emotionTransitionStart[exprName] = exp.getValue?.(exprName) || 0;
            }
        }

        const dur = state.blendDuration || 0.4;
        this._emotionTransitionProgress = Math.min(
            1, this._emotionTransitionProgress + (delta || 0) / Math.max(dur, 0.001),
        );
        const t = easeInOutCubic(this._emotionTransitionProgress);

        for (const exprName of Object.keys(targets)) {
            const start = this._emotionTransitionStart[exprName] ?? 0;
            exp.setValue(exprName, start + (targets[exprName] - start) * t);
        }

        // Secondary mouth-shape coupling. MAX against the current value —
        // _applyVowels already wrote live lipsync this frame, so speech wins;
        // in silence the emotion's subtle mouth shape shows through. Resolve
        // through the discovered viseme map so it targets the same expression
        // the lipsync path uses on this VRM.
        if (state.secondary) {
            for (const [vis, weight] of Object.entries(state.secondary)) {
                const visName = this._visemeMap?.[vis] ?? vis;
                const cur = exp.getValue?.(visName) || 0;
                exp.setValue(visName, Math.max(cur, weight * t));
            }
        }
    }

    _scheduleNextSaccade(now) {
        this._nextSaccadeAt = now + randomSaccadeInterval() / 1000;
    }

    /** Idle eye saccades. Nudges the look-at target by a small random offset
     *  around the eye-contact point (the camera) on a biologically-weighted
     *  interval, so the gaze re-fixates with quick darts instead of staring
     *  glassily. Offset stays small to preserve eye contact (not cursor
     *  follow); darts shrink while speaking for more focused engagement. The
     *  eyes are driven by vrm.update(delta) in the loop, which reads this
     *  target. Runs every frame regardless of idle/gesture state. */
    _applyEyeSaccade(now) {
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
        // Gaze sits on the (possibly orbiting) camera plus the saccade offset.
        const cam = this.camera.position;
        this._lookAtTarget.position.set(
            cam.x + this._saccadeOffset.x,
            cam.y + this._saccadeOffset.y,
            cam.z,
        );
    }

    _loop() {
        this.rafHandle = requestAnimationFrame(() => this._loop());
        if (!this.renderer || !this.activeCanvas) return;
        this._resize(this.activeCanvas);

        // OrbitControls with damping needs per-frame update() to interpolate.
        if (this._orbitControls) {
            try { this._orbitControls.update(); } catch (e) { /* non-fatal */ }
        }

        const delta = this.clock.getDelta();
        const now = this.clock.elapsedTime;

        // Steering first so the mixer + camera see this frame's position.
        this._updateMovement(delta);
        if (this.mixer) this.mixer.update(delta);
        if (this.vrm) {
            // Order matters: idle bones first (sets base pose), then mixer if any
            // overrides them, then face-level adjustments on top.
            this._applyIdle(now);
            this._applyBlink(now);
            this._applyBreath(now);
            this._applyEyeSaccade(now);
            this._applyVowels();
            this._applyEmotion(delta);
            try {
                this.vrm.expressionManager?.update?.();
                this.vrm.update(delta);
            } catch (e) { /* non-fatal */ }
        }
        // After movement so the dolly tracks the freshly advanced position.
        this._updateFollowCamera(delta);

        this.renderer.render(this.scene, this.camera);
    }
}

// Singleton — every surface (canvas hosts, voice service, tool dispatcher)
// shares one renderer to stay under Chrome's WebGL context cap. The window
// handle is a debug escape hatch (loadRoom()/clearRoom() etc.).
export const avatarRenderer = new AvatarRenderer();
if (typeof window !== "undefined") {
    window.__voiceRenderer = avatarRenderer;
}
