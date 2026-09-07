/**
 * Motion director — rule-driven motion for the base avatar from a clip
 * library, under the companion's own tools (play_gesture / set_emotion
 * always pre-empt anything here).
 *
 * Two layers, both global switches in Settings (config.idle_fidgets,
 * config.fidget_interval, config.speech_gestures) and mirrored in the
 * mascot window. They belong to the clip library rather than to any one
 * character, and they are the kind of thing you turn on and off by mood:
 *
 *   IDLE FIDGETS (`idle_fidgets`, `fidget_interval`). While the companion is
 *   quietly idle (nobody speaking, no reply being composed, no audio
 *   playing) a small clip from the library's idle-safe pool plays every so
 *   often — a weight shift, folded arms, a hair touch — an occasional beat
 *   on top of Rexclaw's own idle, nothing more. `fidget_interval` is the
 *   AVERAGE seconds between them; the actual gap is drawn uniformly from
 *   0.5× to 1.5× of it so the rhythm never reads as a metronome.
 *
 *   SPEECH GESTURES (`speech_gestures`). As the companion's transcript
 *   streams in, each finished sentence goes to a fast text model on the
 *   server (/api/voice/speech_gesture) together with the library's gesture
 *   list; it names one clip that expresses the line's meaning or tone, or
 *   nothing. The clip plays while the line is still being spoken. This is
 *   the retrieval design of clip-library companions: the speaking model
 *   is never asked to browse a large library — a side model reads meaning
 *   and picks, with a no-repeat memory.
 *
 * The clip library comes from /api/motion/libraries (folders under
 * data/assets/motion/, see tools/motion/dlp3d_npz2vrma.py). Without a
 * library this module is inert.
 */

import { rpc } from "../lib/rpc";

const TICK_MS = 250;
const SPEAK_ON = 0.05;            // renderer speaking intensity that counts as talking
const SPEAK_RELEASE_MS = 1500;    // hangover after audio stops before "idle" resumes
const DEFAULT_INTERVAL_S = 60;    // average fidget gap when config has none
const MIN_INTERVAL_S = 3;
const FIDGET_PREFER_LEN_S = 9;    // prefer an annotated cut point up to this long
const FIDGET_MIN_CUT_S = 2.5;     // shortest acceptable cut point
const NO_REPEAT_MS = 90_000;      // no fidget twice within this window
const POOL_TAG = "idle_safe";     // manifest tag of clips curated for quiet standing

// Shorter fragments never get a pick. Word counting is whitespace-based,
// which is meaningless for Japanese, Chinese and Thai — they are written
// without spaces, so every sentence counts as one "word" and would be
// rejected outright. Those scripts fall back to a character count.
const SPEECH_MIN_WORDS = 3;
const SPEECH_MIN_CHARS_UNSPACED = 6;
const UNSPACED_SCRIPT_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿]/;

/** Is this line substantial enough to be worth a gesture pick? */
function longEnough(line) {
    const words = line.split(/\s+/).filter(Boolean).length;
    if (words >= SPEECH_MIN_WORDS) return true;
    return UNSPACED_SCRIPT_RE.test(line) && line.length >= SPEECH_MIN_CHARS_UNSPACED;
}
// Minimum gap between two speech gestures. Kept close to the shortest
// clips: a long cooldown does not just thin the gestures out, it holds due
// sentences past SPEECH_LATE_MS and silently kills them, so the two
// numbers together define a dead zone after every gesture.
const SPEECH_COOLDOWN_MS = 1500;
// Recently-played gestures are named to the selector so it doesn't reach
// for the same one out of laziness. A SLIDING TIME WINDOW, as the reference
// implementation uses: a count-based list never forgets, so testing the
// same line twice quietly suppressed the right gesture for the rest of the
// session. Repeats are not forbidden — a nod twice in a minute is correct
// — and the visible problem (the identical take replaying) is handled
// mechanically by the server's variant rotation, not by this hint.
const SPEECH_RECENT_MS = 60_000;
const SPEECH_TIMEOUT_MS = 6000;   // a late pick is a pick for a line already gone
// Sentences wait their turn instead of being dropped. The transcript
// streams far faster than the audio plays — a whole reply's text can land
// in a second — so considering only what arrives while the picker is free
// meant every sentence after the first was thrown away, and a turn could
// never produce more than one gesture. Queue them and drain one per
// cooldown for as long as she is still talking, which also spreads the
// gestures across the spoken turn rather than bunching them at the front.
// Generous: a whole reply's text lands in a couple of seconds while the
// picker works through it at roughly one per second, so the queue holds
// most of the turn at once. Capping tightly clipped the closing sentences
// of a long reply — exactly the ones with the strongest gestures.
const SPEECH_QUEUE_MAX = 24;
const SPEECH_TAIL_MS = 1000;      // keep draining this long past the last audio
// Queued sentences are paced against the SPOKEN turn, not the round trip:
// the transcript is fully known seconds before she says most of it, and a
// pick that finds no gesture costs no cooldown, so an unpaced queue empties
// within a second of the turn starting and every later sentence is spent
// before it is ever heard.
//
// Every serious avatar stack (BML realizers, Inworld, HeyGen) aligns a
// gesture's stroke to a WORD TIMESTAMP from the TTS. The realtime API gives
// us no such marks — but the client schedules the audio itself, so at the
// moment a sentence's text arrives we know exactly how far ahead of the
// voice the transcript is running (`_audioLookaheadSec`). Stamping each
// sentence with "play this when the audio reaches here" is the same idea
// measured from the real schedule, so it self-corrects across pauses,
// underruns and any speaking rate. An earlier attempt predicted the timing
// from character counts and a guessed words-per-second — it fired
// everything late and is exactly the trap this replaces.
// Fire this far ahead of the line so the pick is back by the time it is
// spoken. Seeded low and then tracked against the selector's REAL
// round-trip time (see _notePick): a fixed guess of 600 ms against a
// ~1100 ms selector put every gesture half a second late.
const SPEECH_LEAD_SEED_MS = 900;
const SPEECH_LEAD_MIN_MS = 300;
const SPEECH_LEAD_MAX_MS = 2500;
// Speaking rate, in transcript characters per second of voice. Used to
// place sentences BEFORE the turn's audio is fully scheduled — until that
// moment there is nothing exact to measure against, and the audio-lookahead
// reading that used to stand in for it is an under-estimate by design (the
// transcript runs seconds ahead of the voice describing it), which put the
// opening sentences of a long reply early every time.
//
// Learned per turn and kept per script, because the two are nowhere near
// each other: the same sentence is far fewer characters in Japanese than in
// English, and one blended average would mis-time every turn after a
// language switch. Seeds are rough — two turns of either script and the
// measured value has taken over.
const SPEECH_RATE_SEED = { spaced: 15, unspaced: 7 };
const SPEECH_RATE_MIN = 2;
const SPEECH_RATE_MAX = 60;
// Past this much of its moment, a sentence is abandoned rather than played
// late. The cooldown can hold a due sentence back (two beats close
// together), and a gesture that arrives after its line has been spoken is
// worse than no gesture — it reads as a reaction to whatever she is saying
// NOW. Skipping keeps the queue honest instead of running behind.
const SPEECH_LATE_MS = 1500;
// Per-sentence timing trace: queued → retimed → played/skipped, numbered so
// one sentence can be followed the whole way through. Off by default; flip
// it on when gesture alignment needs tuning. `window.__motionDirector`
// cannot show what happened after the fact, and the queue/fire pair is what
// proves whether the audio-schedule estimate matches the voice. Every
// no-gesture outcome names its reason, so a selector that is declining and
// a pipeline that is broken stay distinguishable.
const SPEECH_DEBUG = false;
// Sentence splitting is Intl.Segmenter's job. It is the engine's own ICU
// implementation of the Unicode segmentation algorithm: locale-aware, and
// it already knows which full stops end a sentence and which belong to
// "3.5" or "Dr. Smith". Baseline across all three engines since April 2024,
// so every browser we run in has it — the hand-rolled rule below is only a
// fallback.
//
// That fallback is the same idea in miniature: a terminator . ! ? … or a
// full-width 。！？, plus any closing quote or bracket. The two scripts need
// different boundary rules — a Latin terminator must be followed by
// whitespace or the end of the text, while CJK is written without spaces
// between sentences and so 。！？ end one on their own.
const SENTENCE_RE =
    /[^.!?…。！？]+(?:[。！？]+[”’」』）】"')\]]*|[.!?…]+["'”’)\]]*(?:\s+|$))/g;

const SEGMENTER = (() => {
    try {
        return new Intl.Segmenter(undefined, { granularity: "sentence" });
    } catch {
        return null;   // pre-2024 engine: fall back to SENTENCE_RE
    }
})();

/** Split a streaming transcript buffer into [finished sentences, tail].
 *
 *  The last segment is always held back. Mid-stream it is a partial
 *  sentence — the segmenter cannot know whether more text is coming — and
 *  the next delta, or the end of the turn, completes it. Deltas arrive in
 *  tens of milliseconds, so this costs nothing in practice. */
function splitSentences(buf) {
    if (SEGMENTER) {
        const segs = [...SEGMENTER.segment(buf)].map((s) => s.segment);
        return [segs.slice(0, -1), segs.length ? segs[segs.length - 1] : ""];
    }
    SENTENCE_RE.lastIndex = 0;
    const out = [];
    let consumed = 0;
    let m;
    while ((m = SENTENCE_RE.exec(buf)) !== null) {
        out.push(m[0]);
        consumed = m.index + m[0].length;
    }
    return [out, buf.slice(consumed)];
}

function randomBetween(a, b) {
    return a + Math.random() * (b - a);
}

export class MotionDirector {
    constructor(env) {
        this.env = env;
        this.enabled = false;
        this.clips = [];
        this._byId = new Map();
        this._pool = [];
        this._state = { listening: false, thinking: false };
        this._speakingUntil = 0;
        this._timer = null;
        this._nextFidgetAt = 0;
        this._lastPlayed = new Map();   // clip.id → timestamp (fidget no-repeat)
        // speech gestures
        this._buf = "";
        this._inflight = false;
        this._lastSpeechAt = 0;
        this._recent = [];              // [{ id, at }], newest last; see SPEECH_RECENT_MS
        this._turnUsedExpressionTool = false;
        this._pending = [];             // sentences waiting for the picker
        this._turnActive = false;       // a reply is streaming / being spoken
        this._lookaheadSec = 0;         // how far the transcript leads the voice
        this._turnChars = 0;            // transcript characters seen this turn
        this._turnAudioSec = 0;         // this turn's voice, once fully scheduled
        this._turnAnchorMs = null;      // when this turn's voice reached char 0
        this._turnScript = "spaced";    // which _rate bucket this turn belongs to
        this._seq = 0;                  // per-turn sentence number, for the trace
        this._speechGestures = false;   // all three from config, see applySettings
        this._fidgets = false;
        this._fidgetInterval = DEFAULT_INTERVAL_S;
        this._leadMs = SPEECH_LEAD_SEED_MS;   // rolling selector round trip
        this._rate = { ...SPEECH_RATE_SEED };  // chars/sec of voice, per script

        // Debug handle, mirroring window.__voiceRenderer / __voiceCall.
        if (typeof window !== "undefined") {
            window.__motionDirector = this;
        }
    }

    get renderer() {
        return this.env.services.voice_avatar_renderer;
    }

    /** Fetch the libraries and start ticking. Safe to call repeatedly (each
     *  call start reloads, so a library dropped into the folder is picked up
     *  on the next call). */
    async start() {
        this.stop({ keepLibrary: true });
        let payload = null;
        try {
            const res = await fetch("/api/motion/libraries", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            if (res.ok) payload = await res.json();
        } catch (e) {
            console.warn("[motion] library fetch failed", e);
        }
        const clips = [];
        for (const lib of payload?.libraries || []) {
            for (const c of lib.clips || []) {
                // fps rides along per clip: the manifest's cutoff / startup /
                // recovery marks are in seconds, but trimming converts them
                // back to frames, so a library authored at anything other
                // than the default rate would cut in the wrong place.
                clips.push({
                    ...c, url: `${lib.url_base}${c.file}`, library: lib.key,
                    fps: Number(lib.fps) > 0 ? Number(lib.fps) : null,
                });
            }
        }
        this.applySettings(payload?.settings);
        this.clips = clips;
        this._byId = new Map(clips.map((c) => [c.id, c]));
        this._pool = clips.filter((c) => (c.tags || []).includes(POOL_TAG));
        this.enabled = clips.length > 0;
        const r = this.renderer;
        if (!r) return;
        r.setMotionLibrary?.(this.enabled ? this.clips : []);
        if (!this.enabled) return;
        this._scheduleFidget();
        this._timer = setInterval(() => this._tick(), TICK_MS);
        console.log(`[motion] library on: ${clips.length} clips, ${this._pool.length} in the fidget pool`);
    }

    stop({ keepLibrary = false } = {}) {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._state = { listening: false, thinking: false };
        this._speakingUntil = 0;
        this._buf = "";
        if (!keepLibrary) {
            this.enabled = false;
            this.clips = [];
            this._byId = new Map();
            this._pool = [];
            this.renderer?.setMotionLibrary?.([]);
        }
    }

    /** The global motion settings (config, via /motion/libraries). Both are
     *  properties of the clip library rather than of any one character, and
     *  both are things you turn on and off by mood — so they live in
     *  Settings and in the mascot window, not per companion or per avatar. */
    _settings() {
        return {
            fidgets: this._fidgets,
            speech: this._speechGestures,
            interval: this._fidgetInterval,
        };
    }

    /** Current settings, config-shaped — for the settings surfaces to show. */
    motionSettings() {
        return {
            speech_gestures: this._speechGestures,
            idle_fidgets: this._fidgets,
            fidget_interval: this._fidgetInterval,
        };
    }

    /** Apply the settings block from /motion/libraries, or from the settings
     *  UI the moment a toggle is flipped (no restart, no reload). */
    applySettings(s) {
        if (!s) return;
        if ("speech_gestures" in s) this.setSpeechGestures(s.speech_gestures);
        if ("idle_fidgets" in s) this._fidgets = !!s.idle_fidgets;
        if ("fidget_interval" in s) {
            const n = Number(s.fidget_interval);
            this._fidgetInterval = Number.isFinite(n) && n > 0
                ? Math.max(MIN_INTERVAL_S, n) : DEFAULT_INTERVAL_S;
        }
    }

    setSpeechGestures(enabled) {
        const next = !!enabled;
        if (next === this._speechGestures) return;
        this._speechGestures = next;
        // Stated whenever it changes: with it off nothing else in the speech
        // path logs at all, which is indistinguishable from the picker
        // simply finding no gestures.
        console.log(`[motion] speech gestures: ${next ? "ON" : "off"}`);
    }

    // ── signals from the call ──────────────────────────────────────────

    /** Partial update: { listening, thinking, responseStarted, responseDone,
     *  interrupted }. */
    setConversationState(partial) {
        if (!partial) return;
        if ("listening" in partial) this._state.listening = !!partial.listening;
        if ("thinking" in partial) this._state.thinking = !!partial.thinking;
        if (partial.interrupted) {
            // Barge-in: her audio was cut mid-sentence, so a gesture still
            // acting that sentence out is left performing to nobody. Drop
            // the buffered tail and the queue with it — those words were
            // never spoken.
            this._buf = "";
            this._pending.length = 0;
            this._turnActive = false;
            this.renderer?.stopLayerClip?.();
        }
        if (partial.responseStarted) {
            this._buf = "";
            this._pending.length = 0;
            this._turnUsedExpressionTool = false;
            this._turnActive = true;
            this._lookaheadSec = 0;
            this._turnChars = 0;
            this._turnAudioSec = 0;
            this._turnAnchorMs = null;
            this._turnScript = "spaced";
            this._seq = 0;
        }
        if (partial.audioTotalSec > 0 && this._turnAudioSec <= 0) {
            this._turnAudioSec = partial.audioTotalSec;
            // Take the buffered tail FIRST. This arrives on
            // response.output_audio.done, which the API sends after the
            // matching transcript.done — so the text is complete, and the
            // last sentence is only still in the buffer because the
            // splitter holds its final segment back. Retiming without it
            // divides by a short character total and pushes every offset
            // late (a six-sentence reply came out ~15% behind).
            this._flushSentences(true);
            this._retimeQueue(partial.audioTotalSec, partial.audioEndsInSec || 0);
            this._noteRate();
        }
        if (partial.responseDone) {
            // Normally a no-op — the audio-done pass above has already taken
            // everything. It stands for the case where that event never
            // came, so a turn is never left on provisional timing.
            this._flushSentences(true);
            this._turnActive = false;
        }
    }

    /** The companion drove its own body this turn (play_gesture or
     *  set_emotion). Its choices outrank ours for the rest of the turn —
     *  a picked gesture landing between two deliberate ones reads as the
     *  character contradicting itself. Cleared when the next reply starts. */
    noteExpressionTool() {
        this._turnUsedExpressionTool = true;
    }

    /** Assistant transcript delta (the companion's own words, streamed).
     *  `lookaheadSec` is how much scheduled audio still has to play before
     *  these words are heard — see the pacing note at the top. */
    onAssistantTranscript(delta, lookaheadSec = 0) {
        if (!this.enabled || !delta || !this._settings().speech) return;
        this._lookaheadSec = Number.isFinite(lookaheadSec) ? Math.max(0, lookaheadSec) : 0;
        // The turn's first words: the voice starts on them about now, which
        // fixes where character 0 of the reply sits in wall-clock time. Every
        // provisional stamp is measured from here (see _dueFor). Taken at the
        // first DELTA rather than the first gesture-worthy sentence, so a
        // reply that opens with "Wait." does not shift the whole turn.
        if (this._turnAnchorMs === null) this._turnAnchorMs = Date.now();
        this._buf += delta;
        this._flushSentences(false);
    }

    // ── idle fidgets ───────────────────────────────────────────────────

    _tick() {
        const r = this.renderer;
        if (!r || !this.enabled) return;
        const now = Date.now();
        if ((r._rawSpeakingIntensity || 0) > SPEAK_ON) {
            this._speakingUntil = now + SPEAK_RELEASE_MS;
        }
        // Queued sentences drain here as well as on arrival — this is what
        // starts the next one the moment the cooldown expires.
        this._drain();
        const quiet = now >= this._speakingUntil && !this._state.listening && !this._state.thinking;
        if (!quiet) {
            // Any activity pushes the next fidget out so one never lands in
            // the first seconds after the conversation goes quiet.
            this._scheduleFidget();
            return;
        }
        if (now < this._nextFidgetAt) return;
        this._scheduleFidget();
        if (this._settings().fidgets) this._playFidget();
    }

    _scheduleFidget() {
        const avg = this._settings().interval;
        this._nextFidgetAt = Date.now() + randomBetween(0.5 * avg, 1.5 * avg) * 1000;
    }

    _playFidget() {
        const r = this.renderer;
        if (!r?.vrm || r.isGestureBusy?.() || r.isLayerClipRunning?.()) return;
        const now = Date.now();
        let pool = this._pool.filter((c) => (now - (this._lastPlayed.get(c.id) || 0)) > NO_REPEAT_MS);
        if (!pool.length) pool = this._pool;
        const clip = pool[Math.floor(Math.random() * pool.length)];
        if (!clip) return;
        this._lastPlayed.set(clip.id, now);
        r.playLibraryClip?.(clip, { cut: this._cutFor(clip) }).catch?.(() => {});
    }

    /** Where to end a fidget. Only ever at a point the clip itself marks
     *  as safe: one of its annotated cut points (`cutoffs`, the library's
     *  own "safe to stop here" frames — preferring those up to
     *  FIDGET_PREFER_LEN_S, else the earliest), otherwise its `recovery`
     *  frame (where the motion has settled back to rest). Never an
     *  arbitrary time — a mid-motion cut reads as an aborted move. null =
     *  play the whole clip (the renderer still ends it at `recovery`). */
    _cutFor(clip) {
        const duration = clip.duration || 0;
        if (duration <= FIDGET_PREFER_LEN_S) return null;
        const cuts = (clip.cutoffs || []).filter((t) => t >= FIDGET_MIN_CUT_S);
        const short = cuts.filter((t) => t <= FIDGET_PREFER_LEN_S);
        if (short.length) return short[Math.floor(Math.random() * short.length)];
        if (cuts.length) return Math.min(...cuts);
        if (clip.recovery && clip.recovery >= FIDGET_MIN_CUT_S) return clip.recovery;
        return null;
    }

    // ── speech gestures ────────────────────────────────────────────────

    /** Cut finished sentences off the transcript buffer and consider each.
     *  `final` also takes whatever is left (the reply ended mid-sentence). */
    _flushSentences(final) {
        const [sentences, tail] = splitSentences(this._buf);
        for (const s of sentences) this._consider(s);
        if (final) {
            if (tail.trim()) this._consider(tail);
            this._buf = "";
        } else {
            this._buf = tail;
        }
    }

    _consider(sentence) {
        // The companion's own play_gesture / set_emotion stands the picker
        // down for the whole turn, not just while its clip runs.
        if (this._turnUsedExpressionTool) return;
        const line = sentence.replace(/\s+/g, " ").trim();
        if (!line) return;
        if (this._turnScript === "spaced" && UNSPACED_SCRIPT_RE.test(line)) {
            this._turnScript = "unspaced";
        }
        // Where this line starts in the reply, in characters. Counted for
        // EVERY sentence, including the ones too short to gesture on: the
        // offset is only meaningful against the whole spoken turn, and
        // skipping the short ones pulled every later line's timing earlier
        // by however much had been left out.
        const at = this._turnChars;
        this._turnChars += line.length;
        if (!longEnough(line)) {
            if (SPEECH_DEBUG) console.log(`[motion] — skipped (too short) "${line}"`);
            return;
        }
        if (this._pending.length < SPEECH_QUEUE_MAX) {
            const seq = ++this._seq;
            const dueAt = this._dueFor(at);
            this._pending.push({ line, dueAt, at, seq, queuedAt: Date.now() });
            if (SPEECH_DEBUG) {
                console.log(`[motion] #${seq} queued "${line.slice(0, 60)}" `
                    + `→ due in ${((dueAt - Date.now()) / 1000).toFixed(1)}s `
                    + `(${this._rate[this._turnScript].toFixed(1)} ch/s)`);
            }
        }
        this._drain();   // the opening line is due immediately and goes now
    }

    /** When the voice will reach character `at` of this turn.
     *
     *  The turn's real length is not known until all of its audio has been
     *  scheduled, so until then this runs on a speaking rate learned from
     *  previous turns, anchored to the first sentence — where the audio
     *  lookahead IS accurate, because barely anything has been scheduled
     *  yet. _retimeQueue replaces every stamp with the exact figure once
     *  the whole turn is in. */
    _dueFor(at) {
        const rate = this._rate[this._turnScript];
        if (this._turnAnchorMs === null) this._turnAnchorMs = Date.now();
        return this._turnAnchorMs + (at / rate) * 1000 - this._leadMs;
    }

    /** Learn this turn's speaking rate, now that its text and its voice are
     *  both complete. Bounds reject the degenerate cases (a one-word reply,
     *  a turn whose audio never arrived) rather than letting them drag the
     *  average somewhere useless. */
    _noteRate() {
        if (!this._turnChars || this._turnAudioSec <= 0) return;
        const rate = this._turnChars / this._turnAudioSec;
        if (rate < SPEECH_RATE_MIN || rate > SPEECH_RATE_MAX) return;
        const k = this._turnScript;
        this._rate[k] = this._rate[k] * 0.6 + rate * 0.4;
        if (SPEECH_DEBUG) {
            console.log(`[motion] rate ${k}: ${rate.toFixed(1)} ch/s this turn`
                + ` → ${this._rate[k].toFixed(1)} ch/s`);
        }
    }

    /** Seconds of this turn's voice still queued to play. */
    _audioLeftSec() {
        const left = this.env.services.voice_companion?.primary?.avatarApi?.audioLookahead?.();
        return Number.isFinite(left) ? left : 0;
    }

    /** The turn's voice is fully scheduled, so its real length is known:
     *  re-time every queued sentence against it.
     *
     *  Playback ends at `now + endsInSec` and lasts `totalSec`, which fixes
     *  when it started; a sentence's share of the transcript then says when
     *  it is spoken. Assuming an even speaking rate across one utterance is
     *  a far smaller error than the provisional stamps, which were made
     *  from the fraction of audio that had arrived — the last line of a
     *  45-second reply was coming out due at about 19 seconds.
     */
    _retimeQueue(totalSec, endsInSec) {
        if (!this._pending.length || !this._turnChars) return;
        const now = Date.now();
        const endMs = now + endsInSec * 1000;
        const totalMs = totalSec * 1000;
        const startMs = endMs - totalMs;
        for (const item of this._pending) {
            const was = item.dueAt;
            item.dueAt = startMs + (item.at / this._turnChars) * totalMs - this._leadMs;
            if (SPEECH_DEBUG) {
                console.log(`[motion] #${item.seq} retimed "${item.line.slice(0, 60)}" `
                    + `${((was - now) / 1000).toFixed(1)}s → ${((item.dueAt - now) / 1000).toFixed(1)}s `
                    + `(turn ${totalSec.toFixed(1)}s)`);
            }
        }
    }

    /** Ease the lead toward the selector's observed round trip, so future
     *  sentences are requested early enough to land on their line. Every
     *  completed pick counts, including ones that chose no gesture — the
     *  round trip is the same either way. */
    _notePick(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        const clamped = Math.min(SPEECH_LEAD_MAX_MS, Math.max(SPEECH_LEAD_MIN_MS, ms));
        this._leadMs = Math.round(this._leadMs * 0.6 + clamped * 0.4);
    }

    /** Ids played inside the recency window, oldest first — anything older
     *  is dropped as it expires. */
    _recentIds() {
        const cutoff = Date.now() - SPEECH_RECENT_MS;
        while (this._recent.length && this._recent[0].at < cutoff) this._recent.shift();
        return this._recent.map((r) => r.id);
    }

    /** Send the oldest queued sentence to the picker, if everything is
     *  clear. Called on each new sentence and from _tick, so a queue that
     *  was only waiting on the cooldown gets going the moment it expires. */
    _drain() {
        if (!this._pending.length) return;
        if (this._turnUsedExpressionTool) {
            this._pending.length = 0;
            return;
        }
        if (this._inflight) return;
        const now = Date.now();
        if (now - this._lastSpeechAt < SPEECH_COOLDOWN_MS) return;
        // Hold until the voice actually reaches this sentence. Checked
        // BEFORE the staleness test below: a sentence that is not due yet
        // still has audio scheduled ahead of it by definition, so it must
        // never be dropped for looking old.
        const next = this._pending[0];
        if (now < next.dueAt) return;
        // Its moment has passed (held back by the cooldown, or a slow
        // pick) — drop it rather than gesture over a later line.
        //
        // Lateness runs from whichever came LAST: the line's moment, or the
        // moment we first knew about it. A sentence that arrives already
        // overdue has not been sat on — there was nothing to sit on. The
        // opening line of every turn is exactly that case, overdue by the
        // lead plus however long it took to stream in, which put it within
        // a couple of hundred milliseconds of being dropped on arrival.
        const late = now - Math.max(next.dueAt, next.queuedAt);
        if (late > SPEECH_LATE_MS) {
            this._pending.shift();
            if (SPEECH_DEBUG) {
                console.log(`[motion] #${next.seq} dropped — ${(late / 1000).toFixed(1)}s`
                    + ` past its line "${next.line.slice(0, 60)}"`);
            }
            return;
        }
        // Due, but the turn is over and she has stopped talking — that line
        // came and went, and a gesture for it now is just a random gesture.
        // Drop only this one: sentences behind it have their own due times
        // and may still be ahead of the voice.
        if (!this._turnActive && now > this._speakingUntil + SPEECH_TAIL_MS) {
            this._pending.shift();
            if (SPEECH_DEBUG) {
                console.log(`[motion] #${next.seq} dropped — turn already over`
                    + ` "${next.line.slice(0, 60)}"`);
            }
            return;
        }
        // A gesture already playing is NOT a reason to skip: the newer line
        // is the one being spoken now, so its gesture replaces the old one
        // (playLibraryClip crossfades). Only a deliberate play_gesture or a
        // combo blocks. The cooldown above is what stops rapid-fire.
        const r = this.renderer;
        if (!r?.vrm || r.isGestureBusy?.()) return;
        const sessionId = this.env.services.voice_companion?.primary?.state?.sessionId;
        if (!sessionId) return;
        const { line, seq } = this._pending.shift();
        this._inflight = true;
        const started = now;
        // Every outcome is traced, not just the hits. Most sentences get no
        // gesture — the selector declining is the normal case, by far the
        // largest filter in the chain, and indistinguishable from a broken
        // pipeline unless it says so.
        const trace = (what) => {
            if (SPEECH_DEBUG) console.log(`[motion] #${seq} ${what} "${line.slice(0, 60)}"`);
        };
        Promise.race([
            rpc("/api/voice/speech_gesture", { session_id: sessionId, line, recent: this._recentIds() }),
            new Promise((resolve) => setTimeout(() => resolve(null), SPEECH_TIMEOUT_MS)),
        ]).then((res) => {
            const took = Date.now() - started;
            if (res !== null) this._notePick(took);   // null = our own timeout
            if (res === null) return trace(`no gesture — selector timed out (${SPEECH_TIMEOUT_MS}ms)`);
            const clip = res.gesture ? this._byId.get(res.gesture) : null;
            if (!clip) return trace(`no gesture — ${res.reason || "declined"} (${took}ms)`);
            if (took > SPEECH_TIMEOUT_MS) return trace(`no gesture — pick too slow (${took}ms)`);
            // Re-check: a tool call may have landed during the round trip.
            if (this._turnUsedExpressionTool) return trace("no gesture — companion drove its own body");
            if (r.isGestureBusy?.()) return trace("no gesture — another clip took the body");
            this._lastSpeechAt = Date.now();
            this._recent.push({ id: clip.id, at: Date.now() });
            // `audioLeft` is the giveaway for alignment: it says how much of
            // this turn's voice is still queued at the instant the gesture
            // plays. Compare it against where the line sits in the reply —
            // a gesture for the last sentence should fire with only a
            // second or two left, not twenty.
            console.log(`[motion] #${seq} ▶ ${clip.en || clip.id} "${line.slice(0, 60)}"`
                + ` (pick ${took}ms, lead now ${this._leadMs}ms`
                + `, audioLeft ${this._audioLeftSec().toFixed(1)}s)`);
            r.playLibraryClip?.(clip, { trimLeadIn: true }).catch?.(() => {});
        }).catch((e) => {
            console.warn("[motion] speech gesture select failed", e);
        }).finally(() => {
            this._inflight = false;
        });
    }
}
