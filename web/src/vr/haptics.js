/**
 * Controller rumble.
 *
 * The WebXR Gamepad extension exposes two different vibration surfaces and
 * headset browsers are inconsistent about which one they implement, so a buzz
 * is attempted against each in turn and stops at the first that accepts it:
 *
 *   1. `gamepad.hapticActuators[0]` — per-actuator, present on most standalone
 *      headsets (Quest, Pico).
 *   2. `gamepad.vibrationActuator` — the whole-device fallback.
 *
 * Within each surface, `playEffect` is preferred and the legacy `pulse` is the
 * fallback (early Quest/Pico builds shipped only `pulse`).
 *
 * Every call is fire-and-forget. Both entry points return a promise that some
 * runtimes reject while an earlier effect is still playing, and a dropped buzz
 * must never surface as an unhandled rejection inside a session the user is
 * wearing on their face — so rejections are swallowed deliberately.
 */

// Guard rails: sub-10ms requests are inaudible on real hardware, and a runaway
// duration would leave a controller buzzing after the interaction that caused it.
const MIN_MS = 10;
const MAX_MS = 1000;

/**
 * Rumble one input source.
 *
 * @param inputSource  XRInputSource (the object from a `connected` event, or an
 *                     entry of `session.inputSources`)
 * @param strength     0..1, clamped
 * @param durationMs   clamped to [MIN_MS, MAX_MS]
 * @returns            true when an actuator accepted the call
 */
export function buzz(inputSource, strength = 0.5, durationMs = 100) {
    const pad = inputSource?.gamepad;
    if (!pad) return false;

    const amount = Math.min(1, Math.max(0, strength));
    const ms = Math.min(MAX_MS, Math.max(MIN_MS, Math.round(durationMs)));
    // "dual-rumble" and this parameter shape are the Gamepad spec's own
    // vocabulary, not ours — both actuator surfaces take the same descriptor.
    const effect = {
        startDelay: 0,
        duration: ms,
        weakMagnitude: amount,
        strongMagnitude: amount,
    };

    for (const actuator of [pad.hapticActuators?.[0], pad.vibrationActuator]) {
        if (!actuator) continue;

        let pending = null;
        if (typeof actuator.playEffect === "function") {
            pending = actuator.playEffect("dual-rumble", effect);
        } else if (typeof actuator.pulse === "function") {
            pending = actuator.pulse(amount, ms);
        } else {
            continue;   // an actuator object with neither entry point
        }

        Promise.resolve(pending).catch(() => {});
        return true;
    }

    return false;
}

/**
 * The input source three.js has bound to controller `index`.
 *
 * Only a fallback: callers that already hold the source (captured from the
 * controller's `connected` event) should pass it to `buzz` directly, since
 * that binding is authoritative and survives a mid-session reconnect.
 */
export function sourceAt(renderer, index) {
    const sources = renderer?.xr?.getSession?.()?.inputSources;
    return sources?.[index] ?? null;
}
