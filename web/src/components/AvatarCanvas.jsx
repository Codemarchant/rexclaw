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

    const cls =
        size === "full"
            ? "o_voice_avatar_canvas o_voice_avatar_canvas--full"
            : "o_voice_avatar_canvas o_voice_avatar_canvas--mini";
    return <div ref={hostRef} className={cls} />;
}
