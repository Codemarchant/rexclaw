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

    // full: fullscreen Voice tab · mini: compact embed · mascot: transparent
    // desktop-overlay host (no backdrop of any kind — see avatar_renderer
    // _applyBackgroundToActiveHost).
    const variant = ["full", "mini", "mascot"].includes(size) ? size : "full";
    return <div ref={hostRef} className={`o_voice_avatar_canvas o_voice_avatar_canvas--${variant}`} />;
}
