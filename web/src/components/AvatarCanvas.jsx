import React, { useEffect, useRef } from "react";
import { avatarRenderer } from "../services/avatar_renderer";

/** Host element for the shared three.js renderer canvas. The renderer is a
 *  singleton — mount() transplants its canvas into this host; unmount() pops
 *  back to the previous host (or pauses the render loop). */
export default function AvatarCanvas({ size = "full" }) {
    const hostRef = useRef(null);

    useEffect(() => {
        const el = hostRef.current;
        if (el) avatarRenderer.mount(el);
        return () => {
            if (el) avatarRenderer.unmount(el);
        };
    }, []);

    // Cursor touch physics: every pointer sample over the host feeds the
    // renderer's cursor collider; a click without a drag is a tap (impulse).
    // The mascot's ghost mode gets no native pointer events — MascotView
    // feeds the shell's global cursor stream instead.
    useEffect(() => {
        const el = hostRef.current;
        if (!el) return undefined;
        let down = null;
        const onMove = (ev) => avatarRenderer.touchCursor?.({ x: ev.clientX, y: ev.clientY });
        const onLeave = () => { down = null; avatarRenderer.touchCursor?.(null); };
        const onDown = (ev) => {
            if (ev.button !== 0) return;
            down = { x: ev.clientX, y: ev.clientY, at: performance.now() };
        };
        const onUp = (ev) => {
            if (!down) return;
            const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
            const quick = performance.now() - down.at < 400 && dx * dx + dy * dy < 36;
            down = null;
            if (quick) avatarRenderer.touchTap?.({ x: ev.clientX, y: ev.clientY });
        };
        el.addEventListener("pointermove", onMove, { passive: true });
        el.addEventListener("pointerleave", onLeave);
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onLeave);
        return () => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerleave", onLeave);
            el.removeEventListener("pointerdown", onDown);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onLeave);
            avatarRenderer.touchCursor?.(null);
        };
    }, []);

    // full: fullscreen Voice tab · mini: compact embed · mascot: transparent
    // desktop-overlay host (no backdrop of any kind — see avatar_renderer
    // _applyBackgroundToActiveHost).
    const variant = ["full", "mini", "mascot"].includes(size) ? size : "full";
    return <div ref={hostRef} className={`o_voice_avatar_canvas o_voice_avatar_canvas--${variant}`} />;
}
