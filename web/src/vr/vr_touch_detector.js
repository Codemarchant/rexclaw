import { pulseXRController } from "./xr_haptics";

/**
 * VRTouchDetector — proximity touch on the VRM avatar from VR controllers.
 */

const TOUCH_RADIUS = 0.09;          // metres — auto-touch proximity
const TRIGGER_TOUCH_RADIUS = 0.25;  // extended reach when the trigger is pressed
const TOUCH_COOLDOWN_MS = 2500;     // per-hand, so a resting hand doesn't spam
const HAPTIC_INTENSITY = 0.8;
const HAPTIC_DURATION = 150;

/** Map a VRM humanoid bone name to a coarse body region for reactions. */
export function mapBoneToRegion(boneName) {
    const n = (boneName || "").toLowerCase();
    if (n.includes("head") || n.includes("neck")) return "head";
    if (n.includes("hand")) return "hand";
    if (n.includes("shoulder")) return "shoulder";
    if (n.includes("arm")) return "arm";
    if (n.includes("chest") || n.includes("spine")) return "chest";
    if (n.includes("hips")) return "hips";
    if (n.includes("foot")) return "foot";
    if (n.includes("upperleg")) return "thigh";
    if (n.includes("leg")) return "leg";
    return "body";
}

export class VRTouchDetector {
    /**
     * @param avatar AvatarRenderer singleton (bone positions via getHumanoidBones)
     * @param gl     three WebGLRenderer (for haptics)
     * @param THREE  three lib (from the session ctx)
     * @param parts  { controllerGrips: [grip0, grip1], handIndicators: [g0, g1] }
     * @param hooks  { onTouch(region, boneName, idx) }
     */
    constructor(avatar, gl, THREE, { controllerGrips, handIndicators }, { onTouch } = {}) {
        this.avatar = avatar;
        this.gl = gl;
        this.controllerGrips = controllerGrips || [];
        this.handIndicators = handIndicators || [];
        this.onTouch = onTouch || null;

        this.bones = avatar.getHumanoidBones?.() || [];
        this.lastTouchTime = [0, 0];
        this.activeTouches = [false, false];

        this._gripPos = new THREE.Vector3();
        this._bonePos = new THREE.Vector3();
        this._colorIdle = new THREE.Color(0x88ccff);
        this._colorNear = new THREE.Color(0xffcc44);
        this._colorTouch = new THREE.Color(0x44ff88);
        this._enabled = false;
    }

    enable() { this._enabled = true; }
    disable() { this._enabled = false; }

    /** Re-read bone nodes after an avatar swap (the humanoid is rebuilt by loadVRM). */
    refreshBones() { this.bones = this.avatar.getHumanoidBones?.() || []; }

    /** Per-frame, from the renderer's XR loop (after vrm.update). */
    update() {
        if (!this._enabled || !this.bones.length) return;
        const now = Date.now();
        for (let i = 0; i < this.controllerGrips.length; i++) {
            const grip = this.controllerGrips[i];
            if (!grip) continue;
            grip.getWorldPosition(this._gripPos);
            const closest = this._findClosestBone(this._gripPos);
            this._updateHandVisual(i, closest.distance);
            if (now - this.lastTouchTime[i] >= TOUCH_COOLDOWN_MS) {
                if (closest.distance < TOUCH_RADIUS && !this.activeTouches[i]) {
                    this._triggerTouch(i, closest.bone, closest.distance, now);
                }
            }
            this.activeTouches[i] = closest.distance < TOUCH_RADIUS;
        }
    }

    /** Trigger button extends reach for an intentional touch. */
    handleTrigger(i) {
        if (!this._enabled) return;
        const grip = this.controllerGrips[i];
        if (!grip) return;
        const now = Date.now();
        if (now - this.lastTouchTime[i] < TOUCH_COOLDOWN_MS) return;
        grip.getWorldPosition(this._gripPos);
        const closest = this._findClosestBone(this._gripPos);
        if (closest.bone && closest.distance < TRIGGER_TOUCH_RADIUS) {
            this._triggerTouch(i, closest.bone, closest.distance, now);
        }
    }

    /** Nearest body region to a controller grip right now (for grip/grab from
     *  vr_manager). Returns { region, distance, boneName }. */
    nearestRegion(controllerIndex) {
        const grip = this.controllerGrips[controllerIndex];
        if (!grip || !this.bones.length) return { region: null, distance: Infinity, boneName: null };
        grip.getWorldPosition(this._gripPos);
        const closest = this._findClosestBone(this._gripPos);
        return {
            region: closest.bone ? mapBoneToRegion(closest.bone.name) : null,
            distance: closest.distance,
            boneName: closest.bone?.name || null,
        };
    }

    _findClosestBone(pos) {
        let bone = null;
        let dist = Infinity;
        for (const b of this.bones) {
            b.node.getWorldPosition(this._bonePos);
            const d = pos.distanceTo(this._bonePos);
            if (d < dist) { dist = d; bone = b; }
        }
        return { bone, distance: dist };
    }

    _triggerTouch(i, bone, distance, now) {
        this.activeTouches[i] = true;
        this.lastTouchTime[i] = now;
        const region = mapBoneToRegion(bone.name);
        pulseXRController(this.gl, i, HAPTIC_INTENSITY, HAPTIC_DURATION);
        this.onTouch?.(region, bone.name, i);
    }

    _updateHandVisual(i, distance) {
        const ud = this.handIndicators[i]?.userData;
        if (!ud?.sphere || !ud?.glow) return;
        let color;
        let glowOpacity;
        if (distance < TOUCH_RADIUS) {
            color = this._colorTouch;
            glowOpacity = 0.35;
        } else if (distance < TRIGGER_TOUCH_RADIUS) {
            const t = 1 - (distance - TOUCH_RADIUS) / (TRIGGER_TOUCH_RADIUS - TOUCH_RADIUS);
            color = this._colorIdle.clone().lerp(this._colorNear, t);
            glowOpacity = 0.1 + t * 0.15;
        } else {
            color = this._colorIdle;
            glowOpacity = 0.1;
        }
        ud.sphere.material.color.copy(color);
        ud.glow.material.color.copy(color);
        ud.glow.material.opacity = glowOpacity;
    }
}
