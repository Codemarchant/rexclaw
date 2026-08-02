// Cross-window transcript mirror over a BroadcastChannel (same origin — works
// between Electron windows and plain browser tabs alike). The page that owns
// the live call is the "owner": it answers snapshot requests, streams
// throttled updates as the call progresses, and relays text typed in a mirror
// back into the call. A /#transcript window is a passive mirror with a send
// box (TranscriptWindowView).
import { subscribe } from "../lib/reactive";
import { attachmentNote } from "../lib/attachments";
import { voice } from "./index";

export const TRANSCRIPT_CHANNEL = "rexclaw-transcript";

// Reactive state is Proxy-wrapped and Proxies don't structured-clone —
// flatten to plain JSON before posting.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

let started = false;

export function startTranscriptOwner() {
    if (started || typeof BroadcastChannel === "undefined") return;
    started = true;
    const ch = new BroadcastChannel(TRANSCRIPT_CHANNEL);
    let timer = null;
    let lastSent = 0;
    let lastStatus = voice.state.status;

    const active = () => ["connecting", "live", "ending"].includes(voice.state.status);
    const snapshot = () => plain({
        type: "transcript",
        sessionId: voice.state.sessionId || null,
        agentName: voice.state.agentName || "",
        status: voice.state.status,
        thinking: !!voice.state.thinking,
        truncated: !!voice.state.transcriptTruncated,
        messages: voice.state.messages || [],
    });
    const send = () => {
        lastSent = Date.now();
        try { ch.postMessage(snapshot()); } catch (e) { /* non-fatal */ }
    };
    // The reactive store is coarse-grained (any mutation notifies), so
    // updates are trailing-throttled to ~3/s while a call is active.
    const schedule = () => {
        if (!active() || timer) return;
        timer = setTimeout(() => {
            timer = null;
            send();
        }, Math.max(0, 300 - (Date.now() - lastSent)));
    };
    subscribe(voice.state, () => {
        const st = voice.state.status;
        if (st !== lastStatus) {
            // Status flips (live → ended, errors) always broadcast, even
            // outside an active call, so mirrors show the final state.
            lastStatus = st;
            send();
            return;
        }
        schedule();
    });
    ch.onmessage = (ev) => {
        const d = ev.data || {};
        // Only the active-call owner answers requests — idle pages stay
        // quiet so two open windows never fight over a mirror.
        if (d.type === "request" && active()) {
            send();
        } else if (d.type === "send_text") {
            if (voice.state.status !== "live") return;
            // Same shape as VoiceView's send: attachments arrive as a hidden
            // context note (uploaded server-side by the mirror already —
            // this just tells the model), then the visible turn.
            const text = typeof d.text === "string" ? d.text.trim() : "";
            const images = Array.isArray(d.images) ? d.images : [];
            const docs = Array.isArray(d.docs) ? d.docs : [];
            if (!text && !images.length && !docs.length) return;
            if (images.length || docs.length) {
                voice.sendContextEvent?.(attachmentNote(images, docs), {
                    ...(text ? { promptResponse: false } : {}),
                    minIntervalMs: 0,
                });
            }
            if (text) voice.sendText?.(text);
        }
    };
}
