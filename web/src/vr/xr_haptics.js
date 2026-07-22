
/**
 * `renderer` here is the three.js WebGLRenderer (i.e. AvatarRenderer.renderer),
 * not the AvatarRenderer singleton — it needs renderer.xr.getSession().
 */

export function getXRInputSourceByHandedness(renderer, handedness) {
    const session = renderer.xr.getSession?.();
    if (!session?.inputSources) return null;
    return [...session.inputSources].find((s) => s.handedness === handedness) || null;
}

export function pulseXRInputSource(source, intensity, duration) {
    const gamepad = source?.gamepad;
    if (!gamepad) return false;

    const actuator = gamepad.hapticActuators?.[0];
    if (actuator) {
        if (typeof actuator.playEffect === "function") {
            actuator.playEffect("dual-rumble", {
                startDelay: 0,
                duration,
                weakMagnitude: intensity,
                strongMagnitude: intensity,
            }).catch(() => {});
            return true;
        }
        if (typeof actuator.pulse === "function") {
            actuator.pulse(intensity, duration)?.catch?.(() => {});
            return true;
        }
    }

    const vibrationActuator = gamepad.vibrationActuator;
    if (vibrationActuator?.playEffect) {
        vibrationActuator.playEffect("dual-rumble", {
            startDelay: 0,
            duration,
            weakMagnitude: intensity,
            strongMagnitude: intensity,
        }).catch(() => {});
        return true;
    }
    if (vibrationActuator?.pulse) {
        vibrationActuator.pulse(intensity, duration)?.catch?.(() => {});
        return true;
    }

    return false;
}

/** controllerIndex 0 = left, 1 = right (matches getControllerGrip order). */
export function pulseXRController(renderer, controllerIndex, intensity, duration) {
    const handedness = controllerIndex === 0 ? "left" : "right";
    const source = getXRInputSourceByHandedness(renderer, handedness);
    return pulseXRInputSource(source, intensity, duration);
}
