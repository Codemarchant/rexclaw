import { rpc } from "../lib/rpc";
import { EMOTION_GESTURE_MAP, GESTURE_FILE_MAP } from "./avatar_catalog";

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

const NATIVE_TOOL_NAMES = new Set([
    // Grok Imagine tools execute server-side (xAI API key required) and come
    // back with an image URL. Side effects (swap background) are applied in
    // dispatch() after the result.
    "change_background",
    "create_image",
    // Memory tools execute server-side. No browser-side side effects.
    "remember",
    "recall",
    "forget",
]);

export class ToolDispatcher {
    constructor({ avatarRenderer, sendWs, conversationState, sessionId }) {
        this.avatarRenderer = avatarRenderer;
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
            if (name === "change_background" && result.image_url) {
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
        this.avatarRenderer?.setBackground?.(bg);
        if (this.conversationState) {
            this.conversationState.activeBackground = bg;
            const agentId = this.conversationState.agentId;
            if (agentId) {
                this.conversationState.latestImagineBackgroundByAgent[agentId] = bg;
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
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    _setEmotion({ emotion }) {
        if (!emotion) return { ok: false, error: "No emotion specified" };
        this.avatarRenderer?.setEmotion?.(emotion);
        // Auto-play matching VRMA gesture if one exists. Fire-and-forget — we
        // don't await the load so the function_call_output round-trip stays fast.
        const url = EMOTION_GESTURE_MAP[emotion];
        if (url) {
            this.avatarRenderer?.playGesture?.(url);
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
        // Eve/Leo/Ara-specific decay: these default avatars' `happy`
        // blendshape squints both eyes shut and holds the mouth open, which
        // reads as a frozen cartoon pose if it lingers after the reaction
        // beat. Settle into `relaxed` so the warmth remains but the pose
        // softens. Keyed off the avatar's name (not the agent's).
        const avatarName = this.conversationState?.avatar?.name;
        const squintyHappyAvatars = new Set(["Eve", "Leo", "Ara"]);
        if (emotion === "happy" && squintyHappyAvatars.has(avatarName)) {
            this._emotionDecayTimer = setTimeout(() => {
                this.avatarRenderer?.setEmotion?.("relaxed");
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
            this.avatarRenderer?.stopGesture?.();
            return { ok: true, gesture: "idle" };
        }
        // Built-in gestures live in the static catalog; custom ones come from
        // the avatar's gesture rows, passed through on the avatar payload so
        // their VRMA URL resolves without an RPC.
        let url = GESTURE_FILE_MAP[gesture];
        let loop = false;
        if (!url) {
            const customs = this.conversationState?.avatar?.custom_gestures || [];
            const custom = customs.find((g) => g.gesture_enum === gesture);
            if (custom?.vrma_url) {
                url = custom.vrma_url;
                loop = !!custom.loop;
            }
        }
        if (!url) return { ok: false, error: `Unknown gesture: ${gesture}` };
        this.avatarRenderer?.playGesture?.(url, { loop });
        return { ok: true, gesture };
    }

    /** Swap the avatar's VRM to the chosen outfit. outfit_id=0 reverts to the
     *  avatar's default VRM; other values map to outfit records embedded in
     *  conversationState.avatar.outfits. */
    _changeOutfit({ outfit_id }) {
        if (outfit_id == null || !Number.isInteger(outfit_id)) {
            return { ok: false, error: "change_outfit requires integer `outfit_id` (0 for default)." };
        }
        if (!this.avatarRenderer) {
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
        // pickers re-render to match.
        if (this.conversationState) {
            this.conversationState.selectedOutfitId = Number(outfit_id);
        }
        // Fire-and-forget: setOutfit is async (VRM load), but the model just
        // needs the ack to continue speaking.
        this.avatarRenderer.setOutfit(outfit.vrm_url, avatar?.vrma_idle_url || null).catch((e) => {
            console.error("[voice] change_outfit setOutfit failed", e);
        });
        return { ok: true, outfit_id: Number(outfit_id), name: outfit.name };
    }
}
