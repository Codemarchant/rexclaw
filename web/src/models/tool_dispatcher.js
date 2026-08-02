import { rpc } from "../lib/rpc";
import { EMOTION_GESTURE_MAP, GESTURE_FILE_MAP, GESTURE_LOOP_MAP } from "./avatar_catalog";
// The shared renderer singleton (imported directly, not via services/index,
// to avoid an import cycle through voice_service). take_selfie snapshots the
// whole live canvas, not one agent's model, so it bypasses the per-agent
// avatarApi adapter.
import { avatarRenderer } from "../services/avatar_renderer";
// Screen-share singleton for take_screenshot / record_screen_clip — same
// direct-import pattern as the renderer.
import { screenCapture } from "../lib/screen_capture";
import { storeOutfitPref } from "../lib/outfit_pref";

/**
 * Browser-side tool dispatcher.
 *
 * xAI's session config declares browser tools as `type: function`. When Grok
 * emits a `response.function_call_arguments.done` event, this dispatcher
 * routes the call to a JS handler and sends back a `conversation.item.create`
 * (function_call_output) over the WebSocket per the xAI spec.
 *
 * Ported from the Odoo module with the ERP navigation / DOM automation tools
 * removed. What remains: the avatar-control tools (set_emotion, play_gesture,
 * change_outfit) handled in the browser, and the server-side native tools
 * (Grok Imagine + memory) proxied through /api/voice/session/<id>/tool_call.
 *
 * Critical: with parallel function calls we MUST resolve all of them before
 * sending `response.create`. The voice service tracks pending calls and only
 * triggers a response when the queue empties.
 */

// Default avatars whose `happy` blendshape squints both eyes shut and holds
// the mouth open — a frozen cartoon pose if it lingers. Matched as a whole
// word so user copies ("Eve Copy") count but "Evelyn"/"Sara" don't. Shared
// with the VR touch reactions (vr_manager), which trigger `happy` outside
// this dispatcher.
const SQUINTY_HAPPY_RE = /\b(Eve|Leo|Ara)\b/;
export function isSquintyHappyAvatar(name) {
    return SQUINTY_HAPPY_RE.test(name || "");
}

const NATIVE_TOOL_NAMES = new Set([
    // Grok Imagine tools execute server-side (xAI API key required) and come
    // back with an image/video URL. Side effects (swap background) are
    // applied in dispatch() after the result.
    "change_background",
    "create_image",
    "create_video",
    // Memory tools execute server-side. No browser-side side effects.
    "remember",
    "recall",
    "forget",
    // Task delegation runs entirely server-side (spawns/continues a hidden
    // text-mode task session). Slow — seconds to minutes — but dispatch()
    // already runs server tools without blocking the UI.
    "delegate_task",
]);

export class ToolDispatcher {
    constructor({ avatarApi, avatarRenderer, sendWs, conversationState, sessionId, callManager }) {
        // Voice call manager (the voice service singleton) — powers the
        // add_agent_to_call tool. Null on surfaces without group calls
        // (text mode), where the tool isn't offered anyway.
        this.callManager = callManager || null;
        // Avatar tools route through an adapter so each agent in a
        // multi-agent call drives ITS OWN model (base avatar vs. peer slot).
        // Legacy callers may still pass a raw renderer — wrap it.
        this.avatarApi = avatarApi || (avatarRenderer ? {
            setEmotion: (e, o) => avatarRenderer.setEmotion?.(e, o),
            playGesture: (u, o) => avatarRenderer.playGesture?.(u, o),
            playComboGesture: (c) => avatarRenderer.playComboGesture?.(c),
            stopGesture: () => avatarRenderer.stopGesture?.(),
            setOutfit: (u, i) => avatarRenderer.setOutfit?.(u, i),
            setBackground: (bg) => avatarRenderer.setBackground?.(bg),
        } : null);
        this.sendWs = sendWs;
        this.conversationState = conversationState;
        this.sessionId = sessionId;
        this._pending = new Set();    // call_ids awaiting handler resolution
    }

    /** Returns true if any tool calls are still resolving. */
    hasPending() {
        return this._pending.size > 0;
    }

    /** Drop tracking for in-flight calls. Used on WS close/teardown so a
     *  stuck _invoke doesn't leave hasPending() stuck true after reconnect —
     *  which would block response.create on every subsequent turn. */
    clearPending() {
        this._pending.clear();
    }

    /**
     * Handle a fully-arrived function call. callId is xAI's correlation id.
     * Returns a promise that resolves once the function_call_output has been sent.
     */
    async dispatch({ callId, name, argumentsJson }) {
        this._pending.add(callId);
        let args = {};
        try {
            args = argumentsJson ? JSON.parse(argumentsJson) : {};
        } catch (e) {
            args = {};
        }
        let result;
        try {
            result = await this._invoke(name, args);
        } catch (e) {
            result = { error: String(e?.message || e) };
        }
        // Apply post-result UI side effects BEFORE acknowledging the call
        // upstream — keeps the visual change tightly correlated with the
        // model's "done" beat.
        if (result && !result.error) {
            // change_background returns image_url (still) or video_url
            // (animated=true) — each side swaps the live backdrop and
            // updates its own "latest Imagine" picker slot.
            if (name === "change_background" && result.video_url) {
                this._applyImagineVideoBackground(result);
            } else if (name === "change_background" && result.image_url) {
                this._applyImagineBackground(result);
            }
        }
        this._pending.delete(callId);
        // Send the result back to the model.
        this.sendWs({
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify(result ?? { ok: true }),
            },
        });
        return result;
    }

    /** Swap the live background to the freshly-generated Imagine image and
     *  reflect it in the shared conversation state so the fullscreen picker
     *  shows 'Imagine background' as the current selection. */
    _applyImagineBackground(result) {
        const bg = {
            type: "imagine",
            preset_style: false,
            image_url: result.image_url,
            id: result.imagine_image_id,
            name: result.name || "Imagine background",
            prompt: result.prompt || "",
        };
        this.avatarApi?.setBackground?.(bg);
        if (this.conversationState) {
            this.conversationState.activeBackground = bg;
            const agentId = this.conversationState.agentId;
            if (agentId) {
                this.conversationState.latestImagineBackgroundByAgent[agentId] = bg;
            }
        }
    }

    /** Swap the live background to the freshly-animated Imagine clip. Same
     *  state plumbing as _applyImagineBackground, but type 'imagine_video'
     *  routes the renderer to a looping <video> layer instead of a CSS
     *  backdrop, and the entry lands in the parallel animated-latest picker
     *  slot — still and animated backgrounds coexist in the dropdown. */
    _applyImagineVideoBackground(result) {
        const bg = {
            type: "imagine_video",
            preset_style: false,
            video_url: result.video_url,
            id: result.imagine_image_id,
            name: result.name || "Animated background",
            prompt: result.prompt || "",
            created_at: result.created_at || new Date().toISOString(),
        };
        this.avatarApi?.setBackground?.(bg);
        if (this.conversationState) {
            this.conversationState.activeBackground = bg;
            const agentId = this.conversationState.agentId;
            if (agentId) {
                this.conversationState.latestImagineVideoBackgroundByAgent[agentId] = bg;
            }
        }
    }

    async _invoke(name, args) {
        if (NATIVE_TOOL_NAMES.has(name)) {
            if (!this.sessionId) {
                throw new Error("Native tool dispatch requires sessionId.");
            }
            return await rpc(`/api/voice/session/${this.sessionId}/tool_call`, {
                tool_name: name,
                arguments: args,
            });
        }
        switch (name) {
            case "set_emotion":
                return this._setEmotion(args);
            case "play_gesture":
                return this._playGesture(args);
            case "change_outfit":
                return this._changeOutfit(args);
            case "take_selfie":
                return this._takeSelfie(args);
            case "take_screenshot":
                return this._takeScreenshot(args);
            case "record_screen_clip":
                return this._recordScreenClip(args);
            case "add_agent_to_call":
                return this._addAgentToCall(args);
            case "remove_agent_from_call":
                return this._removeAgentFromCall(args);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    /** take_selfie: snapshot the live canvas and persist it server-side as
     *  an Imagine-library image the model can feed straight into
     *  create_video. Awaited (not fire-and-forget) — the whole point is
     *  returning the image_url in the function_call_output. */
    async _takeSelfie({ include_background } = {}) {
        if (!this.sessionId) {
            return { ok: false, error: "take_selfie requires an active session." };
        }
        const dataUrl = await avatarRenderer.captureSnapshot?.({
            includeBackground: !!include_background,
        });
        if (!dataUrl) {
            return { ok: false, error: "No live avatar canvas to capture." };
        }
        const result = await rpc(`/api/voice/session/${this.sessionId}/selfie`, {
            image_data_url: dataUrl,
        });
        return {
            ok: true,
            ...result,
            note: "Snapshot saved. Pass image_url (or imagine_image_id) to "
                + "create_video as reference_images or source_image.",
        };
    }

    /** Shared precondition for the screen-capture tools. Returns an error
     *  result when capture can't proceed, null when it can. Distinguishes
     *  "this device can never do it" (mobile/headset browsers have no
     *  Screen Capture API — steer the model toward the paperclip fallback)
     *  from "the user just hasn't armed sharing yet". */
    _screenCaptureUnavailable() {
        if (!screenCapture.isSupported) {
            return {
                ok: false,
                error: "Screen capture is not supported on this device's "
                    + "browser (mobile browsers don't allow it) — there is "
                    + "no Share-screen button to click. Instead, suggest the "
                    + "user take a screenshot or screen recording with their "
                    + "device and attach it via the paperclip; you can then "
                    + "analyze it via delegate_task.",
            };
        }
        if (!screenCapture.isArmed) {
            return {
                ok: false,
                error: "Screen sharing is not active. Ask the user to click the "
                    + "Share-screen button (desktop icon) in the header, then "
                    + "call this tool again.",
            };
        }
        return null;
    }

    /** Resolve once no call leg is audibly speaking, or after maxMs. Polling
     *  (150 ms) rather than event plumbing: _assistantAudioActive() is a
     *  live computation on each connection and this only runs once per
     *  recording. */
    async _waitForSpeechIdle(maxMs) {
        const connections = this.callManager?.connections;
        if (!connections) return;
        const anySpeaking = () => [...connections.values()].some(
            (c) => !c.isTerminal && c._assistantAudioActive?.());
        const deadline = Date.now() + maxMs;
        while (anySpeaking() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
        }
    }

    /** take_screenshot: grab a frame from the user's armed screen share and
     *  persist it as a files-library image (kind 'screenshot'). The capture
     *  can't be initiated from here — getDisplayMedia needs a user gesture
     *  — so when sharing isn't armed the tool returns an error telling the
     *  model to ask the user for the Share-screen button. */
    async _takeScreenshot({ name } = {}) {
        if (!this.sessionId) {
            return { ok: false, error: "take_screenshot requires an active session." };
        }
        const unavailable = this._screenCaptureUnavailable();
        if (unavailable) return unavailable;
        const dataUrl = screenCapture.grabFrame();
        if (!dataUrl) {
            return {
                ok: false,
                error: "The shared screen has not produced a frame yet — "
                    + "try again in a moment.",
            };
        }
        const result = await rpc(`/api/voice/session/${this.sessionId}/screenshot`, {
            image_data_url: dataUrl,
            ...(typeof name === "string" && name.trim() ? { name } : {}),
        });
        return {
            ok: true,
            ...result,
            note: "Screenshot captured — the user can see it in the "
                + "transcript. You cannot see it yourself: pass the "
                + "imagine_image_id to delegate_task in files to "
                + "read/analyze what is on the screen.",
        };
    }

    /** record_screen_clip: record the armed screen share for N seconds and
     *  store the clip in the files library (kind 'screen_clip'). Same
     *  arming contract as take_screenshot; the tool blocks for the whole
     *  recording, which the schema warns the model about. Multipart, not a
     *  data URI — clips run to tens of MB. */
    async _recordScreenClip({ duration_seconds, name } = {}) {
        if (!this.sessionId) {
            return { ok: false, error: "record_screen_clip requires an active session." };
        }
        const unavailable = this._screenCaptureUnavailable();
        if (unavailable) return unavailable;
        const seconds = Number(duration_seconds);
        if (!Number.isFinite(seconds) || seconds < 1) {
            return {
                ok: false,
                error: "duration_seconds must be a number of seconds (1-90). "
                    + "Ask the user how long to record if they didn't say.",
            };
        }
        // The function call lands while the agent's own "I'll start
        // recording now…" is still playing out — starting immediately both
        // eats into the requested duration before the user can act and,
        // with shared system audio, literally records the agent talking.
        // Wait for every call leg to finish speaking first (capped so a
        // stuck audio flag can't hang the tool).
        await this._waitForSpeechIdle(12000);
        let clip;
        try {
            clip = await screenCapture.recordClip(seconds);
        } catch (e) {
            return { ok: false, error: String(e?.message || e) };
        }
        if (!clip?.blob) {
            return { ok: false, error: "Recording produced no clip — is the share still active?" };
        }
        const blob = clip.blob;
        const ext = (blob.type || "").includes("mp4") ? "mp4" : "webm";
        const fd = new FormData();
        fd.append("file", blob, `screen-recording.${ext}`);
        if (typeof name === "string" && name.trim()) {
            fd.append("name", name.trim());
        }
        const resp = await fetch(`/api/voice/session/${this.sessionId}/screen_clip`, {
            method: "POST",
            body: fd,
            credentials: "same-origin",
        });
        const meta = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            return { ok: false, error: meta.error || meta.detail || `Clip upload failed (${resp.status}).` };
        }
        return {
            ok: true,
            ...meta,
            has_audio: clip.hasAudio,
            note: "Clip recorded"
                + (clip.hasAudio
                    ? " with audio"
                    : " WITHOUT audio (the user didn't tick 'share audio' "
                      + "when starting the share, or their platform doesn't "
                      + "support audio for the shared surface — e.g. "
                      + "whole-monitor shares carry audio on Windows only)")
                + " — the user can play it in the transcript. You cannot "
                + "watch it yourself: pass the imagine_image_id to "
                + "delegate_task in files to have its content analyzed.",
        };
    }

    _setEmotion({ emotion }) {
        if (!emotion) return { ok: false, error: "No emotion specified" };
        this.avatarApi?.setEmotion?.(emotion);
        // Auto-play matching VRMA gesture if one exists. Fire-and-forget — we
        // don't await the load so the function_call_output round-trip stays fast.
        const url = EMOTION_GESTURE_MAP[emotion];
        if (url) {
            this.avatarApi?.playGesture?.(url);
        }
        if (this.conversationState) {
            this.conversationState.emotion = emotion;
        }
        // Cancel any in-flight decay from a previous emotion call so a
        // happy → angry transition doesn't get clobbered back to relaxed
        // 4 seconds later.
        if (this._emotionDecayTimer) {
            clearTimeout(this._emotionDecayTimer);
            this._emotionDecayTimer = null;
        }
        // Eve/Leo/Ara-specific decay: settle into `relaxed` so the warmth
        // remains but the squinty pose softens after the reaction beat.
        // Keyed off the avatar's name (not the agent's).
        const avatarName = this.conversationState?.avatar?.name;
        if (emotion === "happy" && isSquintyHappyAvatar(avatarName)) {
            this._emotionDecayTimer = setTimeout(() => {
                this.avatarApi?.setEmotion?.("relaxed");
                if (this.conversationState) {
                    this.conversationState.emotion = "relaxed";
                }
                this._emotionDecayTimer = null;
            }, 4000);
        }
        return { ok: true, emotion, gesture: url ? emotion : null };
    }

    _playGesture({ gesture }) {
        if (!gesture) return { ok: false, error: "No gesture specified" };
        // Reserved sentinel: stop any running gesture (notably a continuous
        // loop, which never ends on its own) and return to the idle animation.
        if (gesture === "idle") {
            this.avatarApi?.stopGesture?.();
            return { ok: true, gesture: "idle" };
        }
        // Built-in gestures live in the static catalog; custom ones come from
        // the avatar's gesture rows, passed through on the avatar payload so
        // their VRMA URL resolves without an RPC.
        let url = GESTURE_FILE_MAP[gesture];
        let loop = !!GESTURE_LOOP_MAP[gesture];
        if (!url) {
            const customs = this.conversationState?.avatar?.custom_gestures || [];
            const custom = customs.find((g) => g.gesture_enum === gesture);
            // Combo gestures stage a second VRM character alongside the base
            // avatar — the payload entry carries both clip URLs plus the
            // placement config, so hand the whole record to the renderer.
            // Fire-and-forget like playGesture below: the partner VRM
            // download can take a while and the function_call_output
            // round-trip must not wait on it.
            if (custom?.type === "combo" && custom.partner_vrm_url && custom.partner_vrma_url) {
                if (this.avatarApi?.playComboGesture) {
                    this.avatarApi.playComboGesture(custom);
                } else if (custom.vrma_url) {
                    // Peer avatars can't stage a combo partner — play the
                    // base clip solo rather than failing the tool call.
                    this.avatarApi?.playGesture?.(custom.vrma_url, { loop: !!custom.loop });
                }
                return { ok: true, gesture };
            }
            if (custom?.vrma_url) {
                url = custom.vrma_url;
                loop = !!custom.loop;
            }
        }
        if (!url) return { ok: false, error: `Unknown gesture: ${gesture}` };
        this.avatarApi?.playGesture?.(url, { loop });
        return { ok: true, gesture };
    }

    /** Swap the avatar's VRM to the chosen outfit. outfit_id=0 reverts to the
     *  avatar's default VRM; other values map to outfit records embedded in
     *  conversationState.avatar.outfits. */
    _changeOutfit({ outfit_id }) {
        if (outfit_id == null || !Number.isInteger(outfit_id)) {
            return { ok: false, error: "change_outfit requires integer `outfit_id` (0 for default)." };
        }
        if (!this.avatarApi?.setOutfit) {
            return { ok: false, error: "No avatar renderer attached — outfit changes are only available in voice mode with an avatar visible." };
        }
        const avatar = this.conversationState?.avatar;
        const outfits = avatar?.outfits || [];
        const outfit = outfits.find(o => Number(o.id) === Number(outfit_id));
        if (!outfit) {
            return { ok: false, error: `Unknown outfit_id ${outfit_id}. Valid ids: ${outfits.map(o => o.id).join(", ")}.` };
        }
        if (!outfit.vrm_url) {
            return { ok: false, error: `Outfit ${outfit_id} has no VRM file uploaded.` };
        }
        // Write the new selection onto the shared reactive state so the
        // pickers re-render to match, and persist it so fresh page
        // instances (mascot pop-out, reloads) hydrate with this outfit.
        if (this.conversationState) {
            this.conversationState.selectedOutfitId = Number(outfit_id);
        }
        storeOutfitPref(avatar?.id, outfit_id);
        // Fire-and-forget: setOutfit is async (VRM load), but the model just
        // needs the ack to continue speaking.
        Promise.resolve(this.avatarApi.setOutfit(outfit.vrm_url, avatar?.vrma_idle_url || null)).catch((e) => {
            console.error("[voice] change_outfit setOutfit failed", e);
        });
        return { ok: true, outfit_id: Number(outfit_id), name: outfit.name };
    }

    /** Bring another companion into the live group call. The join itself
     *  takes seconds (session mint + websocket + avatar load + greeting), so
     *  it runs fire-and-forget: blocking here would hold this call's
     *  function_call_output — and the calling agent's spoken follow-up —
     *  hostage until after the newcomer had already greeted. Synchronous
     *  pre-checks (call live? already present?) run first so the model gets
     *  a truthful immediate result. */
    _addAgentToCall({ agent_id }) {
        if (!Number.isInteger(agent_id) || agent_id <= 0) {
            return {
                ok: false,
                error: "add_agent_to_call requires `agent_id` (integer) from the roster in the tool description.",
            };
        }
        if (!this.callManager?.addAgentToCall) {
            return { ok: false, error: "Group calls are not available on this surface." };
        }
        const check = this.callManager.canAddAgentToCall(agent_id);
        if (!check.ok) {
            return { ok: false, error: check.reason };
        }
        this.callManager.addAgentToCall(agent_id)
            .then((ok) => {
                if (!ok) console.warn("[voice] add_agent_to_call: join failed for agent", agent_id);
            })
            .catch((e) => console.error("[voice] add_agent_to_call failed", e));
        return {
            ok: true,
            status: "joining",
            note: "The companion is connecting now and will greet the call in a few "
                + "seconds. Acknowledge briefly and continue naturally — do not "
                + "speak on their behalf or wait silently for them.",
        };
    }

    /** Disconnect a companion from the group call — agent_id 0 means the
     *  CALLING agent disconnects itself (user dismissed it). Like
     *  _addAgentToCall this is fire-and-forget after synchronous checks:
     *  the manager waits out the farewell (for a self-disconnect, the
     *  caller's post-tool reply is the goodbye) before ending the leg. */
    _removeAgentFromCall({ agent_id }) {
        if (!Number.isInteger(agent_id) || agent_id < 0) {
            return {
                ok: false,
                error: "remove_agent_from_call requires `agent_id` (integer; 0 disconnects yourself).",
            };
        }
        if (!this.callManager?.removeAgentFromCallWhenIdle) {
            return { ok: false, error: "Group calls are not available on this surface." };
        }
        const selfId = Number(this.conversationState?.agentId) || 0;
        const isSelf = agent_id === 0 || agent_id === selfId;
        const targetId = agent_id === 0 ? selfId : agent_id;
        const check = this.callManager.canRemoveAgentFromCall(targetId);
        if (!check.ok) {
            return { ok: false, error: check.reason };
        }
        this.callManager.removeAgentFromCallWhenIdle(check.connId)
            .catch((e) => console.error("[voice] remove_agent_from_call failed", e));
        return {
            ok: true,
            status: "disconnecting",
            note: isSelf
                ? "You are being disconnected from the call. Your next reply is your "
                  + "last — say a brief goodbye, then you will leave the conversation."
                : "The companion will be disconnected once any current speech "
                  + "finishes. Acknowledge briefly and continue with the remaining "
                  + "participants — do not address the departing companion further.",
        };
    }
}
