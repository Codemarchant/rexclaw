import { buzz, sourceAt } from "./haptics";
import { AvatarProximity } from "./proximity";
import { VRPanel } from "./vr_panel";
import { VRRagdoll } from "./vr_ragdoll";
import { EMOTIONS, EMOTION_GESTURE_MAP } from "../models/avatar_catalog";
import { emotionDecayEnabled } from "../models/avatar_catalog";

// Grip mechanics (research-grounded: variable-grip / graduated escalation).
const GRAB_RADIUS = 0.18;      // metres — squeeze this close to a region = a "grab"
const HOLD_INTERVAL_MS = 5000; // sustained-grip re-trigger cadence (arousal builds)
// Move mode (avatar placement): thumbstick-X turn rate for the last-placed
// character, and the fingertip spring-bone collider size (hands physically
// push hair / chest / clothing around).
const MOVE_ROT_SPEED = 1.8;        // rad/s
const MOVE_STICK_DEADZONE = 0.2;
const HAND_COLLIDER_RADIUS = 0.07; // metres

// Rumble profile for a passive proximity touch — the lightest cue in the set,
// well under the grab/confirm buzzes fired elsewhere so the escalation reads.
const TOUCH_BUZZ_STRENGTH = 0.7;
const TOUCH_BUZZ_MS = 120;

// Both hands landing on the same place at once is just how people touch, and
// the sensor correctly calls that two contacts — each hand gets its own buzz.
// The *reaction* must not double up though, or one two-handed head pat sets
// the expression and fires the gesture twice. Debounced per region+tier so
// grab/hold/release keep their own cadence, and short enough that a deliberate
// repeat poke still lands.
const REACTION_DEBOUNCE_MS = 800;

/**
 * Body-region → tiered reaction map. Each touch fires a multisensory-congruent
 * reaction (emotion blendshape + body-language gesture + controller haptic +
 * a hidden in-character context note so they react by VOICE).
 *
 * Tiers: `light` is a proximity touch or a trigger-reach; `grab` / `hold` /
 * `release` come from the grip button (see _grip). A region with no entry —
 * or an entry with no matching tier — is inert: the physical response
 * (haptic + spring-bone displacement) still plays, but nothing is said.
 * boneRegion() classifies more regions than are wired up here on purpose, so
 * adding a reaction is a matter of adding one line.
 *
 * The emotion doubles as the gesture: setEmotion drives the blendshape and
 * EMOTION_GESTURE_MAP plays the matching VRMA clip (surprised → Surprised).
 *
 * `settle` softens the pose after the reaction beat, with a per-reaction
 * timing/target instead of the renderer's default decay (setEmotion settles
 * every emotion after EMOTION_DECAY_MS on its own — a settle here just gets
 * there sooner or lands on a warmer pose). Both respect the avatar's
 * `emotion_decay` config (on by default) — an avatar that opts out holds its
 * touch reactions too.
 */
const TOUCH_REACTIONS = {
    head: {
        light: {
            emotion: "happy",
            text: "[The user gently pats your head.]",
            settle: { to: "relaxed", afterMs: 4000 },
        },
    },
    belly: {
        // Surprised is a snap expression (blendDuration 0.15, mouth open) —
        // it reads as a flinch for a beat and as frozen shock after that.
        light: {
            emotion: "surprised",
            text: "[The user pokes your belly — it tickles.]",
            settle: { to: "relaxed", afterMs: 2500 },
        },
    },
};

/**
 * VRManager — WebXR controllers, mute toggle, and haptics for the avatar
 * companion.
 *
 *  - The AvatarRenderer singleton owns viewer placement, the render-loop switch,
 *    and the session lifecycle (viewer placement + recenter are WebXR-native
 *    reference-space offsets, no dolly). This manager attaches via
 *    renderer.addXRSessionListener / addXRFrameCallback and parents its
 *    controllers to ctx.scene. It does NOT enable xr, request the session,
 *    add a VRButton, or call setAnimationLoop.
 *  - The grip button is a simple mute toggle (one press flips the live xAI
 *    mic via voice.setMuted()), not push-to-talk. Mute is also on the panel.
 *  - three.js is taken from the session-start ctx (lazy-loaded by the
 *    renderer) — this module imports no heavy libs.
 *
 * Hand markers are simple spheres; AvatarProximity recolours them by distance
 * via userData.{sphere,glow}, and reports contact back here — the haptic and
 * the reaction policy stay in this class.
 */

// Resting tint of the hand marker. Must match proximity.js's TINT_REST so a
// freshly built hand doesn't flash a different colour before the first frame
// of proximity painting lands on it.
const HAND_COLOR_IDLE = 0x9aa7b8;

export class VRManager {
    /** @param avatarRenderer the AvatarRenderer singleton; opts: voice service +
     *  getGestures() → [{id,label,url,loop}] for the panel's Gestures tab. */
    constructor(avatarRenderer, { voice, getGestures } = {}) {
        this.avatar = avatarRenderer;
        this.voice = voice || null;
        this._getGestures = getGestures || null;
        this._grab = null;       // { i, region, next } while a grip-grab is held

        this._unsubSession = null;
        this._unsubFrame = null;
        this._attached = false;

        this.gl = null;          // three WebGLRenderer (from ctx) — needed for haptics
        this._scene = null;      // three scene (from ctx) — parent for controllers/panel
        // Everything per-hand is indexed 0/1 throughout: target-ray spaces
        // (input events), grip spaces (hand pose/visuals), the hand models, and
        // the XRInputSource the platform bound to each hand — the last is the
        // authoritative handle for gamepad axes/buttons, handedness and rumble.
        this.controllers = [null, null];
        this.grips = [null, null];
        this.handMarkers = [null, null];
        this._sources = [null, null];
        this._debugStr = "";     // pressed-button-index readout shown on the panel

        // Set by Phase 4 (touch reactions). Optional — guarded everywhere.
        this.touchDetector = null;
        this.panel = null;          // world-space UI (exit + emotions)

        // Feature toggles (panel → Options tab). Reaction gestures are ON by
        // default — panel → Options turns them off if the canned gestures get
        // repetitive; the physical response (spring-bone hand colliders,
        // ragdoll) plays either way.
        this.reactionsEnabled = true;
        this.moveMode = false;         // point at the floor + trigger = walk there
        this.ragdoll = null;           // VRRagdoll, created on first toggle
        this._ragdollBusy = false;     // ragdoll enable in flight (first-use WASM download)
        this._lastError = "";          // last load/physics error, shown on the panel footer
        this._lastMovedActorId = "base"; // thumbstick rotation target in move mode
        this._reticle = null;          // floor marker shown in move mode
        this._hp = [null, null];       // per-hand world-position scratches
        this._touchDecayTimer = null;  // expression settle beat (see _reactToTouch)
        this._reactedAt = new Map();   // "region:tier" → last reaction time
        this._panelBtnDown = false;    // A/X → toggle the settings panel
        this._exitBtnDown = false;     // B/Y → exit VR
        this._recenterBtnDown = false; // thumbstick press → recenter the view

        // One bound handler set per hand, kept so add/removeEventListener pair
        // up cleanly. `connected` captures the XRInputSource, which is what
        // gives us the gamepad (grip value → hand pose, thumbstick, buttons)
        // and the handedness the hand model mirrors itself from.
        this._handlers = [0, 1].map((hand) => ({
            squeezestart: () => this._grip(hand, true),
            squeezeend: () => this._grip(hand, false),
            select: () => this._select(hand),
            connected: (e) => {
                this._sources[hand] = e.data;
                this._applyHandedness(hand, e.data?.handedness);
            },
            disconnected: () => { this._sources[hand] = null; },
        }));
    }

    /** Wire into the renderer's XR lifecycle. Call once (e.g. on full-view mount). */
    attach() {
        if (this._attached) return;
        this._attached = true;
        this._unsubSession = this.avatar.addXRSessionListener({
            onStart: (ctx) => this._enterSession(ctx),
            onEnd: () => this._leaveSession(),
        });
        this._unsubFrame = this.avatar.addXRFrameCallback((delta, now) => this._update(delta, now));
    }

    detach() {
        if (!this._attached) return;
        this._attached = false;
        if (this.avatar.isInXR) this._leaveSession();
        this._unsubSession?.();
        this._unsubFrame?.();
        this._unsubSession = null;
        this._unsubFrame = null;
    }

    _enterSession(ctx) {
        const { THREE, renderer, scene } = ctx;
        this.gl = renderer;
        this._scene = scene;
        this._THREE = THREE;
        const xr = renderer.xr;

        for (let hand = 0; hand < 2; hand++) {
            // Grip space drives hand pose/visuals; the target-ray space is what
            // raises the input events.
            this.grips[hand] = xr.getControllerGrip(hand);
            this.controllers[hand] = xr.getController(hand);

            // Handedness starts as a guess and is corrected by the `connected`
            // event, which rebuilds the model mirrored the right way.
            const model = this._makeHand(THREE, hand === 0 ? "left" : "right");
            this.handMarkers[hand] = model;
            this.grips[hand].add(model);

            // Both spaces live in the scene; three re-poses them each frame
            // from the (reference-space-offset) input source poses.
            scene.add(this.grips[hand], this.controllers[hand]);

            // Grip = grab when near a body region, mute in open air (see _grip).
            for (const [event, fn] of Object.entries(this._handlers[hand])) {
                this.controllers[hand].addEventListener(event, fn);
            }
        }

        // Proximity touch → physical + verbal reaction (the headline feature).
        // The sensor reports contact; the haptic and the reaction policy are
        // ours, so both stay here rather than inside it.
        this.touchDetector = new AvatarProximity(
            this.avatar, THREE,
            { grips: this.grips, indicators: this.handMarkers },
            {
                onContact: (region, boneName, hand) => {
                    this._buzz(hand, TOUCH_BUZZ_STRENGTH, TOUCH_BUZZ_MS);
                    this._reactToTouch(region, "light");
                },
            },
        );
        this.touchDetector.start();

        // Hands are spring-bone colliders: touching hair / chest / clothing
        // physically displaces it (survives avatar swaps — the renderer
        // re-registers the group after each load). Hosted on the GRIP spaces,
        // not the hand meshes, so a handedness rebuild can't destroy them —
        // the grip origin is the fist centre, so no offset is needed.
        this.avatar.attachSpringBoneColliders?.(
            this.grips.map((object) => ({ object, radius: HAND_COLLIDER_RADIUS })),
        );

        // Floor reticle for move mode (hidden until the mode is on).
        this._reticle = this._makeReticle(THREE);
        scene.add(this._reticle);

        // World-space UI panel (exit/env/recenter/mute + emotions & gestures).
        this.panel = new VRPanel(THREE, {
            emotions: EMOTIONS,
            getGestures: this._getGestures,
            getOptions: () => [
                { id: "move", label: `Move: ${this.moveMode ? "On" : "Off"}` },
                { id: "reactions", label: `Reactions: ${this.reactionsEnabled ? "On" : "Off"}` },
                { id: "ragdoll", label: this._ragdollBusy ? "Ragdoll: loading…"
                    : `Ragdoll: ${this.ragdoll?.enabled ? "On" : "Off"}` },
            ],
            onOption: (id) => this._toggleOption(id),
            onExit: () => this.avatar.exitXR?.(),
            onEmotion: (id) => this._triggerEmotion(id),
            onGesture: (g) => this._triggerGesture(g),
            onEnv: () => this.avatar.toggleXREnvironment?.(),
            onRecenter: () => this.avatar.recenterXR?.(),
            onMute: () => this._toggleMute(),
            getEnvMode: () => this.avatar.xrEnvMode,
            getMuted: () => this.voice?.state?.muted,
            // Panel footer: load/physics errors (headsets hide the console)
            // + the pressed-button-index readout.
            getDebug: () => (this._lastError ? this._lastError + "  " : "") + this._debugStr,
        });
        scene.add(this.panel.mesh);

        // Position the companion's voice at their head (presence). No-op outside XR.
        this.voice?.enableSpatialAudio?.();
        // Mic stays in whatever state the flat session had it (live by default);
        // mute is a simple toggle (grip button or the panel), not push-to-talk.
    }

    /** Turn a touched region + intensity tier into a reaction: emotion
     *  blendshape + body-language gesture + hidden voice context note.
     *  Gated ENTIRELY by the panel's Reactions toggle (off by default):
     *  when off, touches produce only the physical response (haptics +
     *  spring-bone displacement / ragdoll) — no gestures and NO speech.
     *  Haptic is fired by the caller (touch detector for `light`, _grip for
     *  grab/hold). */
    _reactToTouch(region, tier = "light") {
        if (!this.reactionsEnabled) return;
        const t = TOUCH_REACTIONS[region]?.[tier];
        if (!t) return;
        // Collapse the two hands' contacts into one reaction (see
        // REACTION_DEBOUNCE_MS). The buzz already fired per-hand upstream.
        const now = Date.now();
        const key = `${region}:${tier}`;
        if (now - (this._reactedAt.get(key) || 0) < REACTION_DEBOUNCE_MS) return;
        this._reactedAt.set(key, now);
        this.avatar.setEmotion?.(t.emotion, { explicit: false });
        // One timer across all reactions, so a second touch inside the settle
        // window restarts the beat rather than stacking timers that would
        // fight each other.
        if (this._touchDecayTimer) {
            clearTimeout(this._touchDecayTimer);
            this._touchDecayTimer = null;
        }
        if (this._shouldSettle(t)) {
            this._touchDecayTimer = setTimeout(() => {
                this._touchDecayTimer = null;
                // The agent may have set a different emotion in the meantime
                // (the renderer arms its own decay timer per setEmotion) —
                // only soften the expression THIS reaction left behind.
                if (this.avatar._currentEmotion === t.emotion) {
                    this.avatar.setEmotion?.(t.settle.to, { explicit: false });
                }
            }, t.settle.afterMs);
        }
        const gestureUrl = EMOTION_GESTURE_MAP[t.emotion];
        if (gestureUrl) this.avatar.playGesture?.(gestureUrl);
        this.voice?.sendContextEvent?.(t.text);
    }

    /** Whether a reaction's expression should soften after its beat — gated
     *  on the avatar's `emotion_decay` config (default on). */
    _shouldSettle(t) {
        if (!t.settle) return false;
        // Session state only carries the avatar once a call starts — fall
        // back to the renderer's hydrated payload so pats settle pre-call too.
        const avatar = this.voice?.state?.avatar
            ?? this.avatar._currentAvatarPayload;
        return emotionDecayEnabled(avatar);
    }

    /** Grip button: with ragdoll active, squeezing near the avatar physically
     *  grabs the nearest limb (a kinematic hand body drags it) — a purely
     *  physical interaction: haptics only, deliberately NO speech/reactions.
     *  Otherwise, if the hand is near a body region it's a "grab" reaction
     *  (firm haptic + escalated reaction, held for sustained escalation); a
     *  squeeze in open air just toggles mute. */
    _grip(controllerIndex, down) {
        if (down) {
            if (this.ragdoll?.enabled) {
                const wp = this._handWorldPos(controllerIndex);
                if (wp && this.ragdoll.tryGrab(controllerIndex, wp)) {
                    this._buzz(controllerIndex, 1.0, 200);
                    return;
                }
            }
            const near = this.touchDetector?.probe?.(controllerIndex);
            if (near?.region && near.distance < GRAB_RADIUS) {
                this._grab = { i: controllerIndex, region: near.region, next: 0 };
                this._buzz(controllerIndex, 1.0, 200);   // firm grab
                this._reactToTouch(near.region, "grab");
                return;
            }
            this._toggleMute(controllerIndex);   // open-air squeeze = mute
        } else {
            this.ragdoll?.release(controllerIndex);   // no-op unless a limb is held
            if (this._grab && this._grab.i === controllerIndex) {
                this._reactToTouch(this._grab.region, "release");
                this._grab = null;
            }
        }
    }

    /** Fire an emotion picked from the world-space panel — same effect as the
     *  flat-view emotion buttons (blendshape + matching body-language clip). */
    _triggerEmotion(id) {
        this.avatar.setEmotion?.(id, { explicit: true });
        const gestureUrl = EMOTION_GESTURE_MAP[id];
        if (gestureUrl) this.avatar.playGesture?.(gestureUrl);
    }

    /** Play a gesture picked from the panel's Gestures tab. Combo entries
     *  carry their full payload record (see full_view._vrGestures) and stage
     *  a second character alongside the avatar. */
    _triggerGesture(g) {
        if (g?.combo) {
            this.avatar.playComboGesture?.(g.combo);
            return;
        }
        if (!g?.url) return;
        this.avatar.playGesture?.(g.url, { loop: !!g.loop });
    }

    _leaveSession() {
        for (let hand = 0; hand < this.controllers.length; hand++) {
            const controller = this.controllers[hand];
            if (!controller) continue;
            for (const [event, fn] of Object.entries(this._handlers[hand])) {
                controller.removeEventListener(event, fn);
            }
        }
        this._grab = null;
        this._sources = [null, null];
        // A settle beat left in flight would call setEmotion after the session
        // is gone, dragging the flat view's expression around seconds later.
        if (this._touchDecayTimer) {
            clearTimeout(this._touchDecayTimer);
            this._touchDecayTimer = null;
        }
        this._reactedAt.clear();
        // Physics/placement teardown: unhook the hand colliders from every
        // VRM, drop any ragdoll instantly (animation takes back over), and
        // reset move mode for the next session.
        this.avatar.detachSpringBoneColliders?.();
        this.ragdoll?.dispose();
        this.ragdoll = null;
        this.moveMode = false;
        this._lastMovedActorId = "base";
        this.avatar.stopMoving?.();
        // VR placement selects walk actors; hand the flat walk mode back its
        // "starts on the main avatar" invariant.
        this.avatar.setMoveActor?.("base");
        this._disposeObject(this._reticle);
        this._reticle = null;
        this._hp = [null, null];
        for (const h of this.handMarkers) this._disposeObject(h);
        this.handMarkers = [null, null];
        this.touchDetector?.stop?.();
        this.touchDetector = null;
        this.panel?.dispose();
        this.panel = null;
        this.voice?.disableSpatialAudio?.();
        if (this._scene) {
            for (const o of [...this.grips, ...this.controllers]) {
                if (o) this._scene.remove(o);
            }
        }
        this.grips = [null, null];
        this.controllers = [null, null];
        this._scene = null;
        this.gl = null;
    }

    /**
     * Rumble one hand. Prefers the XRInputSource captured from the `connected`
     * event — that binding is authoritative — and falls back to the session's
     * input source list for the window before the event has landed.
     */
    _buzz(hand, strength, ms) {
        const source = this._sources[hand] || sourceAt(this.gl, hand);
        return buzz(source, strength, ms);
    }

    /** Simple mute toggle (replaces push-to-talk): one press flips the mic. */
    _toggleMute(controllerIndex = 0) {
        const muted = this.voice?.state?.muted;
        this.voice?.setMuted?.(!muted);
        this._buzz(controllerIndex, 0.4, 80);
    }

    /** Trigger: light haptic; the world-space UI gets first refusal, then in
     *  move mode a floor-pointing trigger walks the nearest character to the
     *  aimed spot; otherwise it's an extended-reach touch (Phase 4). */
    _select(controllerIndex) {
        this._buzz(controllerIndex, 0.8, 150);
        // World-space UI gets first refusal on the trigger; if it consumed the
        // press (a button was hit), don't also fire a touch interaction.
        const controllerObj = this.controllers[controllerIndex];
        if (this.panel?.handleSelect?.(controllerObj)) return;
        if (this.moveMode) {
            // Prefer the triggering hand's own floor hit; fall back to the
            // previewed reticle spot so the walk always lands where the ring
            // showed (even if this hand was aiming elsewhere).
            const hit = this._floorHit(controllerObj) || this._placementHit();
            if (hit) {
                // The character standing closest to the aimed spot walks there
                // — with peers in the call this places each one individually.
                const actors = this.avatar.listActors?.() || [];
                let best = null;
                let bestD = Infinity;
                for (const a of actors) {
                    const p = a.node.position;
                    const d = Math.hypot(p.x - hit.x, p.z - hit.z);
                    if (d < bestD) { bestD = d; best = a; }
                }
                if (best && this.avatar.walkActorTo?.(best.id, hit.x, hit.z)) {
                    this._lastMovedActorId = best.id;
                    this._buzz(controllerIndex, 0.5, 80);
                }
                return;
            }
        }
        this.touchDetector?.reachOut?.(controllerIndex);
    }

    /** Toggle a panel Options item. Ragdoll enable is async (first use
     *  downloads the physics engine) — the panel label updates on completion
     *  via its per-frame options polling. */
    _toggleOption(id) {
        if (id === "move") {
            this.moveMode = !this.moveMode;
            if (!this.moveMode) {
                if (this._reticle) this._reticle.visible = false;
                this.avatar.stopMoving?.();
            }
        } else if (id === "reactions") {
            this.reactionsEnabled = !this.reactionsEnabled;
        } else if (id === "ragdoll") {
            if (this._ragdollBusy) return;   // first-use engine download in flight
            // Ragdoll is a purely physical mode — no speech on toggle or grabs.
            if (this.ragdoll?.enabled) {
                this.ragdoll.disable();
            } else {
                if (!this.ragdoll && this._THREE) {
                    this.ragdoll = new VRRagdoll(
                        this.avatar, this._THREE, (i) => this._handWorldPos(i),
                        // Live XRFrame access → real-room plane colliders
                        // (tables/seats/walls) where the browser supports it.
                        { getXR: () => ({
                            frame: this.gl?.xr?.getFrame?.(),
                            refSpace: this.gl?.xr?.getReferenceSpace?.(),
                        }) },
                    );
                }
                if (!this.ragdoll) return;
                this._ragdollBusy = true;
                this._lastError = "";
                this.ragdoll.enable().catch((e) => {
                    console.error("[voice] ragdoll enable failed", e);
                    // Headsets hide the console — put the reason on the panel.
                    this._lastError = "ragdoll: " + String(e?.message || e).slice(0, 60);
                }).finally(() => { this._ragdollBusy = false; });
            }
        }
        this._buzz(0, 0.4, 80);
    }

    /** World-space position of a hand grip (reused scratch per hand). */
    _handWorldPos(i) {
        const grip = this.grips[i];
        if (!grip || !this._THREE) return null;
        const v = (this._hp[i] ||= new this._THREE.Vector3());
        return grip.getWorldPosition(v);
    }

    /** The floor spot move mode is currently indicating: the right hand's
     *  floor hit when it has one, else the left's. Shared by the reticle
     *  preview and the trigger fallback so they can never disagree. */
    _placementHit() {
        const rightHand = this._sources.findIndex((s) => s?.handedness === "right");
        const primary = rightHand === -1 ? 0 : rightHand;
        const right = this.controllers[primary];
        const other = this.controllers[primary === 0 ? 1 : 0];
        const hit = this._floorHit(right);
        if (hit) return hit;
        return this._floorHit(other);
    }

    /** Intersect a controller's pointing ray with the floor plane (y=0).
     *  Returns a THREE.Vector3 or null when aiming at the sky / too far. */
    _floorHit(controller) {
        if (!controller || !this._THREE) return null;
        const THREE = this._THREE;
        const o = (this._fhO ||= new THREE.Vector3());
        const q = (this._fhQ ||= new THREE.Quaternion());
        const d = (this._fhD ||= new THREE.Vector3());
        controller.getWorldPosition(o);
        controller.getWorldQuaternion(q);
        d.set(0, 0, -1).applyQuaternion(q);
        if (d.y > -0.05) return null;            // aiming level or upward
        const t = -o.y / d.y;
        if (t <= 0 || t > 12) return null;       // behind, or absurdly far
        return (this._fhHit ||= new THREE.Vector3()).copy(o).addScaledVector(d, t);
    }

    /** Simple floor ring shown while move mode aims at a spot. */
    _makeReticle(THREE) {
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.12, 0.17, 32),
            new THREE.MeshBasicMaterial({
                color: 0x44ff88, transparent: true, opacity: 0.6,
                side: THREE.DoubleSide, depthWrite: false,
            }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.01;                  // just above the floor (no z-fight)
        ring.visible = false;
        return ring;
    }

    /** A stylised hand attached to a controller grip, aligned to the WebXR
     *  gripSpace convention: origin at the centre of the closed hand, -Z
     *  along the thumb / handle axis, +X out of the BACK of the right hand
     *  (-X for the left) — so the palm faces -X on the right hand and the
     *  whole model mirrors with handedness. Fingers wrap around the handle
     *  (Z) axis and tighten via userData.setGrip(0..1). Keeps a touch marker
     *  sphere+glow (userData.sphere/glow) for the touch detector.
     *  See https://immersive-web.github.io/webxr/input-explainer.html */
    _makeHand(THREE, handedness = "right") {
        const sign = handedness === "left" ? 1 : -1;   // palm faces sign·X
        const group = new THREE.Group();
        const skin = new THREE.MeshStandardMaterial({ color: 0xe8b48f, roughness: 0.9, metalness: 0 });
        // Palm slab: thin across the palm (X), knuckles spread along the
        // handle axis (Z), origin at the fist centre → no positional offset
        // from the real hand.
        group.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.09), skin));

        const joints = [];
        const fz = [-0.032, -0.011, 0.011, 0.032];     // index (thumb side) → pinky
        for (let i = 0; i < 4; i++) {
            const j = new THREE.Group();
            j.position.set(sign * 0.016, 0, fz[i]);    // knuckle on the palm side
            const seg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.015), skin);
            seg.position.set(sign * 0.025, 0, 0);
            j.add(seg);
            group.add(j);
            joints.push(j);
        }
        // Thumb runs along -Z (the gripSpace thumb direction).
        const thumb = new THREE.Group();
        thumb.position.set(sign * 0.02, 0.01, -0.045);
        const tseg = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.017, 0.05), skin);
        tseg.position.set(0, 0, -0.02);
        thumb.add(tseg);
        group.add(thumb);

        // Touch marker at the front of the fist (recoloured on proximity).
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 12, 12),
            new THREE.MeshBasicMaterial({ color: HAND_COLOR_IDLE, transparent: true, opacity: 0.9 }),
        );
        sphere.position.set(0, 0, -0.07);
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 12, 12),
            new THREE.MeshBasicMaterial({ color: HAND_COLOR_IDLE, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        glow.position.copy(sphere.position);
        group.add(sphere, glow);

        const setCurl = (v) => {
            // Fingers rotate about the handle (Z) axis, mirrored per hand;
            // resting pose keeps a relaxed pre-curl so it reads as a grip.
            const a = 0.35 + 1.05 * Math.max(0, Math.min(1, v));
            for (const j of joints) j.rotation.z = -sign * a;
        };
        setCurl(0);

        group.userData = { sphere, glow, handedness, setGrip: setCurl };
        return group;
    }

    /** The platform told us which hand a controller is in (connected event):
     *  rebuild that hand's model mirrored correctly if we guessed wrong. */
    _applyHandedness(i, handedness) {
        if ((handedness !== "left" && handedness !== "right") || !this._THREE) return;
        const current = this.handMarkers[i];
        if (!current || current.userData.handedness === handedness) return;
        const grip = this.grips[i];
        this._disposeObject(current);
        const fresh = this._makeHand(this._THREE, handedness);
        this.handMarkers[i] = fresh;
        grip?.add(fresh);
    }

    _disposeObject(obj) {
        if (!obj) return;
        obj.parent?.remove(obj);
        obj.traverse?.((n) => {
            n.geometry?.dispose?.();
            if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
            else n.material?.dispose?.();
        });
    }

    _update(delta, now) {
        // The touch detector owns hand-indicator visuals (proximity colour/glow).
        this.touchDetector?.tick?.();
        // Move mode: live floor reticle + thumbstick-X rotates the
        // last-placed character in place. The reticle follows whichever hand
        // is actually aiming at the floor (right hand wins when both are), so
        // the preview always matches the placement (_select uses the same
        // logic via _placementHit).
        if (this.moveMode && this._reticle) {
            const hit = this._placementHit();
            this._reticle.visible = !!hit;
            if (hit) this._reticle.position.set(hit.x, 0.01, hit.z);
            let stick = 0;
            for (const src of this._sources) {
                const x = src?.gamepad?.axes?.[2] ?? 0;
                if (Math.abs(x) > Math.abs(stick)) stick = x;
            }
            if (Math.abs(stick) > MOVE_STICK_DEADZONE) {
                this.avatar.turnActor?.(this._lastMovedActorId, -stick * MOVE_ROT_SPEED * delta);
            }
        } else if (this._reticle?.visible) {
            this._reticle.visible = false;
        }
        // Sustained grip: re-trigger the "hold" reaction on a cadence so a held
        // grab keeps escalating (the verbal note is debounced in voice_service).
        if (this._grab) {
            const t = Date.now();
            if (!this._grab.next) this._grab.next = t + HOLD_INTERVAL_MS;
            else if (t >= this._grab.next) {
                this._grab.next = t + HOLD_INTERVAL_MS;
                this._buzz(this._grab.i, 0.6, 120);
                this._reactToTouch(this._grab.region, "hold");
            }
        }
        // Pose each hand's fingers from its grip (squeeze) value → grip animation.
        for (let hand = 0; hand < this.handMarkers.length; hand++) {
            const squeeze = this._sources[hand]?.gamepad?.buttons?.[1]?.value ?? 0;
            this.handMarkers[hand]?.userData?.setGrip?.(squeeze);
        }

        if (this.panel) {
            this.panel.update({
                hmd: this.gl?.xr?.getCamera?.(),   // floats in front of you (not hand-mounted)
                controllers: this.controllers,
            });
        }
        this._checkButtons();
    }

    /** Poll the controller buttons (edge-detected so a held press fires once):
     *  A/X (gamepad index 4) toggles the settings panel; thumbstick press
     *  (index 3) recenters the view; B/Y (index 5) exits VR. The Pico
     *  system/home button also exits (renderer sessionend listener). */
    _checkButtons() {
        const session = this.gl?.xr?.getSession?.();
        if (!session?.inputSources) return;
        let panelBtn = false;
        let recenter = false;
        let exit = false;
        const pressed = new Set();
        for (const src of session.inputSources) {
            const b = src.gamepad?.buttons;
            if (!b) continue;
            for (let i = 0; i < b.length; i++) if (b[i]?.pressed) pressed.add(i);
            if (b?.[4]?.pressed) panelBtn = true;
            if (b?.[3]?.pressed) recenter = true;
            if (b?.[5]?.pressed) exit = true;
        }
        // Temporary diagnostic so we can confirm the Pico's button indices.
        this._debugStr = pressed.size ? "btn " + [...pressed].sort((a, b) => a - b).join(",") : "";
        if (panelBtn && !this._panelBtnDown) {
            this._panelBtnDown = true;
            this.panel?.toggle?.();
            this._buzz(0, 0.4, 80);
        } else if (!panelBtn) {
            this._panelBtnDown = false;
        }
        if (recenter && !this._recenterBtnDown) {
            this._recenterBtnDown = true;
            this.avatar.recenterXR?.();
            this._buzz(0, 0.5, 100);
        } else if (!recenter) {
            this._recenterBtnDown = false;
        }
        if (exit && !this._exitBtnDown) {
            this._exitBtnDown = true;
            this._buzz(1, 0.5, 120);
            this.avatar.exitXR?.();
        } else if (!exit) {
            this._exitBtnDown = false;
        }
    }
}
