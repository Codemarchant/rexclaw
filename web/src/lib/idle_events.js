// Idle events: when a voice call goes quiet, draw one of the companion's
// configured events by weight and hand its prompt to the companion as a
// hidden note — a check-in after a silence, a topic to riff on, a message
// from the stream's chat to answer. The server stores the list
// (agents.idle_events, cleaned by server/idle_events.py) and sends the
// usable events with the call's start payload; the clock lives here,
// because only the browser knows when the companion's audio actually
// finished playing and when the user last spoke or typed.
//
// Timing:
//   - the quiet stretch counts from the end of PLAYBACK, not from when the
//     reply text arrives, so an event never fires over a line still being
//     spoken;
//   - with a min-max range, every quiet stretch re-rolls its length, so
//     events don't land like clockwork;
//   - a streak of events nobody answers pauses them until someone speaks,
//     types or chats. That is also what lets the idle-hangup watchdog end a
//     forgotten call: every companion turn counts as call activity.
//   - silent chat injections ('silent_chat') sit outside the draw: after
//     their own quiet time the newest chat is queued as background for the
//     companion's next reply, without asking for one.
import { rpc } from "./rpc";
import { _t } from "./i18n";
import { notification } from "./notification";

// Keep in sync with server/idle_events.py NOTE_PREFIX: the saved copy of a
// note is a system row the transcript hides by this prefix.
const NOTE_PREFIX = "[Idle event";
const TICK_MS = 500;
// Chat state poll while the companion has a chat event — the Minecraft
// pump's cadence. Each poll also keeps the server's chat readers running.
const CHAT_POLL_MS = 4000;
const PLATFORM_LABELS = { twitch: "Twitch", youtube: "YouTube" };

/** A chat block: one heading naming the platform ("Stream chat" only when a
 *  read mixes Twitch and YouTube), then a "[name]: message" line each - the
 *  group-call relay's speaker format. */
function chatLines(chat) {
    const platforms = [...new Set(chat.map((m) => m.platform))];
    return [
        platforms.length === 1 ? `${PLATFORM_LABELS[platforms[0]] || platforms[0]} chat:` : "Stream chat:",
        ...chat.map((m) => `[${m.user}]: ${m.text}`),
    ];
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

export class IdleEventScheduler {
    constructor(call) {
        this.call = call;   // VoiceCallService
        this.cfg = null;
        this._timer = null;
    }

    /** Arm for this call from the primary leg's start payload (null = the
     *  companion has idle events off). A compaction restart re-arms too. */
    configure(cfg) {
        this.stop();
        if (!cfg?.events?.length) return;
        this.cfg = cfg;
        this._drawn = cfg.events.filter((e) => e.type !== "silent_chat");
        this._silent = cfg.events.filter((e) => e.type === "silent_chat");
        this._usesChat = cfg.events.some((e) => e.type !== "prompt");
        this._injectedThisQuiet = false;
        this._quietSince = Date.now();
        this._quietTarget = null;
        this._unanswered = 0;
        this._capLogged = false;
        this._lastEvent = null;
        this._userSeq = 0;
        this._firing = false;
        this._chat = null;
        this._chatPolledAt = 0;
        this._warned = new Set();
        this._timer = setInterval(() => this._tick(), TICK_MS);
        console.log(`[idle_events] armed: ${cfg.events.length} event(s), `
            + `${cfg.min_seconds}-${cfg.max_seconds} s of quiet, `
            + `pause after ${cfg.max_unanswered || "∞"} unanswered`);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this.cfg = null;
    }

    /** The user spoke or typed: the quiet stretch starts over and the
     *  unanswered streak resets. */
    noteUser() {
        if (!this.cfg) return;
        this._userSeq += 1;
        this._unanswered = 0;
        this._restartQuiet();
    }

    _restartQuiet() {
        this._quietSince = Date.now();
        this._quietTarget = null;
        this._injectedThisQuiet = false;
    }

    /** Anything that holds an event back, on any leg of the call: a reply
     *  being generated or still playing, a tool round owing its follow-up,
     *  the user mid-utterance, a compaction restart. */
    _busy() {
        return [...this.call.connections.values()].some((c) => !c.isTerminal && (
            c._responseInFlight || c._pendingToolReply || c._toolReplyStarting
            || c._assistantAudioActive() || c._userSpeaking || c.state.compacting
            || c.toolDispatcher?.hasPending?.()));
    }

    _tick() {
        if (!this.cfg || this.call.state.status !== "live") return;
        if (this._usesChat && Date.now() - this._chatPolledAt >= CHAT_POLL_MS) this._pollChat();
        if (this._firing) return;
        if (this._busy()) {
            this._restartQuiet();
            return;
        }
        const quietMs = Date.now() - this._quietSince;
        // Silent chat injections keep their own quiet time, outside the
        // weighted draw and the unanswered pause (they ask for no reply).
        if (this._silent.length && !this._injectedThisQuiet) this._injectChat(quietMs);
        if (!this._drawn.length || this._firing) return;
        const { min_seconds: lo, max_seconds: hi, max_unanswered: cap } = this.cfg;
        if (cap > 0 && this._unanswered >= cap) {
            if (!this._capLogged) {
                this._capLogged = true;
                console.log(`[idle_events] ${cap} in a row went unanswered — paused until someone speaks, types or chats`);
            }
            return;
        }
        this._capLogged = false;
        if (this._quietTarget == null) this._quietTarget = (lo + Math.random() * (hi - lo)) * 1000;
        if (quietMs >= this._quietTarget) this._fire(quietMs);
    }

    /** Weighted draw among the events that can run now — chat events only
     *  while there is unread chat. A plain prompt doesn't fire twice in a
     *  row while another event could; chat events bring fresh messages
     *  each time, so they may repeat. */
    _pick() {
        const chatReady = (this._chat?.unread || 0) > 0;
        let pool = this._drawn.filter((e) => e.type !== "stream_chat" || chatReady);
        if (this._lastEvent?.type === "prompt" && pool.length > 1) {
            pool = pool.filter((e) => e !== this._lastEvent);
        }
        const total = pool.reduce((sum, e) => sum + e.weight, 0);
        let r = Math.random() * total;
        for (const e of pool) {
            r -= e.weight;
            if (r < 0) return e;
        }
        return null;
    }

    async _fire(quietMs) {
        const event = this._pick();
        if (!event) {
            // Only chat events, and nothing unread: wait out another stretch.
            this._restartQuiet();
            return;
        }
        this._firing = true;
        const userSeq = this._userSeq;
        try {
            let chat = [];
            if (event.type === "stream_chat") {
                const res = await rpc("/api/live_chat/take", { count: event.chat_messages });
                chat = res?.messages || [];
                if (this._chat) this._chat.unread = 0;   // a read empties the unread pool
                if (!chat.length) return;   // aged out, or a moderator cleared it meanwhile
            }
            // The floor may have changed hands while chat was fetched.
            if (!this.cfg || userSeq !== this._userSeq || this._busy()
                || this.call.state.status !== "live") return;
            const quietS = Math.round(quietMs / 1000);
            // How many nudges in a row nobody has answered, so the companion
            // can tell a fresh silence from a long one.
            const streak = this._unanswered
                ? `, ${ordinal(this._unanswered + 1)} in a row with no reply` : "";
            const lines = [`${NOTE_PREFIX} — quiet for ${quietS} s${streak}] ${event.prompt}`];
            if (chat.length) lines.push(...chatLines(chat));
            const note = lines.join("\n");
            const primary = this.call.primary;
            if (!primary.injectContextItem(note, { promptResponse: true })) return;
            // Also saved, as a hidden system row: a resumed conversation
            // still knows what the companion was answering.
            primary.recordMessage({ role: "system", content: note });
            this._lastEvent = event;
            this._unanswered += 1;
            console.log(`[idle_events] "${event.name || event.prompt.slice(0, 40)}" after ${quietS} s of quiet`
                + (chat.length ? ` with ${chat.length} chat message(s)` : "")
                + ` (${this._unanswered} unanswered)`);
        } catch (e) {
            console.warn("[idle_events] event failed", e);
        } finally {
            this._firing = false;
            this._restartQuiet();
        }
    }

    /** A silent chat injection: the newest unread messages go in as
     *  background for the companion's next reply, once per quiet stretch,
     *  without asking for one. Queued rather than sent now - the voice API
     *  hides text sent ahead of the user's next spoken turn from the reply
     *  to it (see VoiceCallService.queueSilentContext). */
    async _injectChat(quietMs) {
        const event = this._silent.find((e) => quietMs >= e.after_seconds * 1000);
        if (!event || !((this._chat?.unread || 0) > 0)) return;
        this._injectedThisQuiet = true;
        this._firing = true;
        try {
            const res = await rpc("/api/live_chat/take", { count: event.chat_messages });
            const chat = res?.messages || [];
            if (this._chat) this._chat.unread = 0;   // a read empties the unread pool
            if (!chat.length || !this.cfg || this.call.state.status !== "live") return;
            const note = [`${NOTE_PREFIX} — chat in the background]${event.prompt ? ` ${event.prompt}` : ""}`,
                ...chatLines(chat)].join("\n");
            this.call.queueSilentContext(note);
            this.call.primary.recordMessage({ role: "system", content: note });
            console.log(`[idle_events] "${event.name || "silent chat"}" queued ${chat.length} chat message(s) for the next reply`);
        } catch (e) {
            console.warn("[idle_events] chat injection failed", e);
        } finally {
            this._firing = false;
        }
    }

    async _pollChat() {
        this._chatPolledAt = Date.now();
        let state;
        try {
            state = await rpc("/api/live_chat/state", {});
        } catch (e) {
            return;   // server restarting — the next poll catches up
        }
        if (!this.cfg) return;
        // New chat counts as someone answering: a stream with a lively chat
        // never runs into the unanswered pause.
        if (this._chat && state.received > this._chat.received) this._unanswered = 0;
        this._chat = state;
        const platforms = Object.entries(state.platforms || {});
        if (!platforms.length) {
            this._warnOnce("setup", _t("This companion has chat idle events, but no live chat is set up — add a Twitch channel or a YouTube stream in Settings → Live chat."));
        }
        for (const [platform, p] of platforms) {
            if (p.status === "error" && p.error) {
                this._warnOnce(platform, _t("%s chat: %s", PLATFORM_LABELS[platform] || platform, p.error));
            }
        }
    }

    _warnOnce(key, message) {
        if (this._warned.has(key)) return;
        this._warned.add(key);
        notification.add(message, { type: "warning" });
    }
}
