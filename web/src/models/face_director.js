/**
 * Face director, browser half — see server/face_director.py.
 *
 * Every sentence of the companion's reply is sent to /api/voice/face_director
 * the moment the transcript has it, and its answer goes to the renderer
 * shortly before the voice reaches that sentence: conversational face
 * signals start ahead of their words (a smile ~0.9 s early), so the renderer
 * gets the line's time and starts each signal on its own lead. The motion
 * director owns the sentence timing (`item.spokenAt`, re-stamped once the
 * turn's audio is fully scheduled) and hands each sentence here.
 *
 * The answer says what the line does (asks, says no, says yes, …) and
 * which of its words each of those lands on — a head shake goes with the
 * "no" it belongs to (McClave 2000) — so the line goes up split into its
 * words (the browser's own word segmenter: any language, no word lists),
 * the model picks among them, and each picked word's time is worked out
 * here from the same character timing the speech gestures' strokes use.
 *
 * Unlike speech gestures there is no cooldown and nothing is skipped: every
 * line gets a face. The requests run side by side, since the transcript is
 * seconds ahead of the voice and a queue would fall behind it.
 *
 * The user's words get a face too (listen): the companion reacting to what
 * they hear, in the gap before they answer. It only lands while that gap is
 * still open — with a fast engine it usually is; a slow read, or a
 * transcript that arrives after the reply has started, is dropped.
 */

import { rpc } from "../lib/rpc";
import { splitWords } from "../lib/words";

const FACE_TIMEOUT_MS = 6000;   // same budget as a speech-gesture pick
// Hand-over this far before the line: the earliest-starting signal's lead
// (a peak's, see FACE_PEAK in face_motion.js).
const FACE_LEAD_MS = 890;

export class FaceDirector {
    constructor(motionDirector) {
        this.md = motionDirector;
        this.enabled = false;
        this._items = [];   // this turn's lines not yet shown, oldest first
        this._said = [];    // this turn's lines so far, sent along as context
        this._seq = 0;
        this._replyShown = false;   // a line of the reply has shown its face
        this._spokenAt = null;      // exact char → time, once the turn's audio is scheduled
    }

    /** Per call: the session decided it (its prompt describes set_emotion
     *  as the big-shift tool accordingly). */
    setEnabled(on) {
        const next = !!on;
        if (next === this.enabled) return;
        this.enabled = next;
        console.log(`[face] director: ${next ? "ON" : "off"}`);
        if (!next) this.clear();
        this.md.renderer?.setFaceDirector?.(next);
    }

    newTurn() {
        this.clear();
        this._said = [];
        this._spokenAt = null;
    }

    /** Drop every line not yet shown (barge-in, a new turn, stop). The face
     *  already on screen stays and settles by itself. */
    clear() {
        for (const e of this._items) clearTimeout(e.timer);
        this._items = [];
    }

    /** The user holds the floor (their voice is on) or has let it go. */
    setListening(on) {
        if (this.enabled) this.md.renderer?.setFaceListening?.(!!on);
    }

    /** The user just said `text`: react as they hear it, shown at once. */
    listen(text) {
        if (!this.enabled || !text?.trim()) return;
        const sessionId = this.md.env.services.voice_companion?.primary?.state?.sessionId;
        if (!sessionId) return;
        const seq = ++this._seq;
        const started = Date.now();
        // A new exchange: whatever the last reply showed is over.
        this._replyShown = false;
        Promise.race([
            rpc("/api/voice/face_director", { session_id: sessionId, line: text, listening: true }),
            new Promise((resolve) => setTimeout(() => resolve(null), FACE_TIMEOUT_MS)),
        ]).then((res) => {
            const took = Date.now() - started;
            const r = this.md.renderer;
            if (!this.enabled || !res?.face) {
                console.log(`[face] #${seq} listening: no change — ${res ? res.reason : "timed out"}`);
                return;
            }
            // Only while they are still waiting to answer: once the reply's
            // face is up or their voice is audible, the moment has passed.
            if (this._replyShown || (r?._rawSpeakingIntensity || 0) > 0.05) {
                console.log(`[face] #${seq} listening: too late (read ${took}ms)`);
                return;
            }
            this._log(seq, "listening", res.face, text, took);
            r?.setFaceReaction?.(res.face, { lineAt: Date.now(), first: true, listening: true });
        }).catch((e) => console.warn("[face] listening read failed", e));
    }

    /** One line of the reply: { line, at, spokenAt }. */
    queue(item) {
        if (!this.enabled) return;
        const sessionId = this.md.env.services.voice_companion?.primary?.state?.sessionId;
        if (!sessionId) return;
        const words = splitWords(item.line);
        const entry = { item, words, seq: ++this._seq, face: null, timer: null, took: 0, first: !this._said.length };
        this._items.push(entry);
        const context = this._said.slice(-2);
        this._said.push(item.line);
        const started = Date.now();
        Promise.race([
            rpc("/api/voice/face_director", {
                session_id: sessionId, line: item.line, context, words: words.map((w) => w.text),
            }),
            new Promise((resolve) => setTimeout(() => resolve(null), FACE_TIMEOUT_MS)),
        ]).then((res) => {
            if (!this._items.includes(entry)) return;   // cleared, or a later line showed
            if (!res?.face) {
                this._drop(entry);
                console.log(`[face] #${entry.seq} no change — ${res ? res.reason : "timed out"}`
                    + ` "${item.line.slice(0, 60)}"`);
                return;
            }
            entry.face = res.face;
            entry.took = Date.now() - started;
            this._schedule(entry);
        }).catch((e) => {
            console.warn("[face] director call failed", e);
            this._drop(entry);
        });
    }

    /** The turn's audio is fully scheduled: `spokenAt(at)` is the exact
     *  time the voice reaches character `at` (motion director _retimeQueue),
     *  and `endMs` when the voice stops — where the waiting face begins. */
    retime(spokenAt, endMs) {
        this._spokenAt = spokenAt;
        for (const e of this._items) {
            e.item.spokenAt = spokenAt(e.item.at);
            if (e.face) this._schedule(e);
        }
        if (this.enabled) this.md.renderer?.setFaceTurnEnd?.(endMs);
    }

    /** When the voice reaches character `i` of a line. */
    _timeOf(item, i) {
        return this._spokenAt ? this._spokenAt(item.at + i) : this.md._voiceAt(item.at + i);
    }

    _schedule(entry) {
        clearTimeout(entry.timer);
        const wait = entry.item.spokenAt - FACE_LEAD_MS - Date.now();
        if (wait <= 0) {
            this._show(entry);
            return;
        }
        entry.timer = setTimeout(() => this._show(entry), wait);
    }

    /** Show a line's face. Older lines still waiting are dropped — a slow
     *  answer must never land on top of a later line's face. */
    _show(entry) {
        const idx = this._items.indexOf(entry);
        if (idx < 0) return;
        for (const old of this._items.slice(0, idx)) clearTimeout(old.timer);
        this._items.splice(0, idx + 1);
        this._replyShown = true;
        const { item, face, words } = entry;
        const wordAt = {};
        for (const [key, i] of Object.entries(face.words || {})) {
            if (words[i]) wordAt[key] = this._timeOf(item, words[i].index);
        }
        this._log(entry.seq, "speaking", face, item.line, entry.took, words);
        this.md.renderer?.setFaceReaction?.(face, {
            lineAt: item.spokenAt, lineEnd: this._timeOf(item, item.line.length), first: entry.first, wordAt,
        });
    }

    _log(seq, how, f, line, took, words = []) {
        const feel = Object.entries(f.feelings || {}).map(([k, v]) => `${k}:${v}`).join(" ") || "calm";
        const on = Object.entries(f.words || {}).filter(([, i]) => words[i]).map(([k, i]) => `${k}→${words[i].text}`);
        console.log(`[face] #${seq} ${how}: ${feel}${f.level ? ` (${f.level})` : ""}`
            + `${f.acts?.length ? ` [${f.acts.join(" ")}]` : ""}${on.length ? ` {${on.join(" ")}}` : ""}`
            + ` "${line.slice(0, 60)}" (read ${took}ms)`);
    }

    _drop(entry) {
        const i = this._items.indexOf(entry);
        if (i >= 0) this._items.splice(i, 1);
    }
}
