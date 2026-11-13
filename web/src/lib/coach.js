// Conversation coach, browser side: after a companion finishes a reply, ask
// the server whether its coach has a note (server/coach.py), and hand the
// note to that companion once it arrives.
//
//   - a review can take a while (the coach model reads the whole call), so
//     the note goes in whenever it is ready and never holds a reply back:
//     it is background for the companion's next reply, not a request for one.
//   - one review per companion at a time; replies that finish meanwhile are
//     counted and covered by the next one.
//   - each review names the tools the companion called since the last, so
//     rules can wait on "replies since the last gesture".
//   - if the user spoke while the coach was thinking, the server is asked
//     whether the note still fits before it goes in.
//   - every leg of a group call runs its own companion's coach, on that
//     leg's own saved copy of the conversation.
import { rpc } from "./rpc";

// How long a review may take before this leg stops waiting for it: the
// server gives the coach model 120 s (server/coach.py _COACH_TIMEOUT), plus
// room for the decision model's read. A coach brain that never answers
// would otherwise keep the leg's one review slot for the rest of the call.
const REVIEW_TIMEOUT_MS = 150000;

export class Coach {
    constructor(call) {
        this.call = call;   // VoiceCallService
        this._userSeq = 0;
    }

    /** The user said or typed something. */
    noteUser() {
        this._userSeq += 1;
    }

    /** `conn`'s companion called a tool: the server counts replies since
     *  each one (server/coach.py), and most avatar tools are never saved as
     *  rows, so the names ride along with the next review. */
    noteTool(conn, name) {
        if (!conn.coachOn) return;
        (conn._coachTools ??= new Set()).add(name);
    }

    /** `conn`'s companion finished a reply. */
    async review(conn) {
        if (!conn.coachOn || conn.isTerminal || !conn.state.sessionId) return;
        conn._coachReplies = (conn._coachReplies || 0) + 1;
        if (conn._coachBusy) return;
        conn._coachBusy = true;
        // Everything since the last review this leg sent.
        const since = { replies: conn._coachReplies, tools: [...(conn._coachTools || [])] };
        conn._coachReplies = 0;
        conn._coachTools = new Set();
        const sessionId = conn.state.sessionId;
        const userSeq = this._userSeq;
        const name = conn.agentName || "companion";
        try {
            // The server reads the saved rows, and the reply that just
            // finished is still in the append queue.
            await conn._flushAppendQueue({ holdOpenUserRow: true });
            const res = await rpc(`/api/voice/session/${sessionId}/coach`, since,
                                  { signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS) });
            const note = res?.note;
            if (!note || !this._live(conn, sessionId)) return;
            if (userSeq !== this._userSeq) {
                const check = await rpc(`/api/voice/session/${sessionId}/coach/fits`, { note });
                if (!this._live(conn, sessionId)) return;
                if (!check?.fits) {
                    console.log(`[coach] ${name}: note dropped, the conversation moved on`, { note });
                    return;
                }
            }
            // The primary has live audio input, where text sent ahead of
            // the user's next spoken turn is hidden from the reply to it,
            // so its note is queued (VoiceCallService.queueSilentContext);
            // a peer takes it straight away.
            if (conn === this.call.primary) this.call.queueSilentContext(note);
            else if (!conn.injectContextItem(note, { promptResponse: false })) return;
            // Saved as a hidden system row: a resumed conversation keeps
            // it, and the coach's next review sees what it already said.
            conn.recordMessage({ role: "system", content: note });
            // "Since the coach's last thought" counts from here: a thought
            // dropped above never reached the companion.
            rpc(`/api/voice/session/${sessionId}/coach/delivered`, {}).catch(() => {});
            console.log(`[coach] ${name}: note for the next reply (${(res.rules || []).join(", ")})`, { note });
        } catch (e) {
            console.warn(`[coach] ${name}: review failed`, e);
        } finally {
            conn._coachBusy = false;
        }
    }

    _live(conn, sessionId) {
        return this.call.state.status === "live" && !conn.isTerminal && conn.state.sessionId === sessionId;
    }
}
