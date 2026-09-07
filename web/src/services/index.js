// Service container — replaces Odoo's registry/useService plumbing with a
// plain singleton map shaped like `env.services` so the ported service code
// runs unchanged.
import { notification } from "../lib/notification";
import { avatarRenderer } from "./avatar_renderer";
import { lipsync } from "./lipsync_service";
import { VoiceService } from "./voice_service";
import { TextService } from "./text_service";
import { MotionDirector } from "../models/motion_director";

export const services = {
    notification,
    voice_avatar_renderer: avatarRenderer,
    voice_lipsync: lipsync,
    // The Odoo action service has no standalone equivalent — the ported
    // dispatcher no longer carries navigation tools.
    action: null,
};

const env = { services };

// Rule-driven avatar motion (state idles, fidgets, word gestures). Started
// at boot so a companion standing outside a call fidgets too, and again by
// the voice service at every call start (fresh library scan). Inert without
// a clip library.
services.motion_director = new MotionDirector(env);

export const voice = new VoiceService(env);
export const text = new TextService(env);
services.voice_companion = voice;
services.text_companion = text;

services.motion_director.start().catch(() => {});

export { avatarRenderer, lipsync, notification };
