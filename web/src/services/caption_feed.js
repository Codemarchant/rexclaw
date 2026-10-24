// Stream captions — the companion's spoken words, shown as they are heard
// (the live subtitles AI streamers run along the bottom of the screen).
// Off by default; two surfaces show them: the full-screen view's overlay
// (reads `captions` directly) and the desktop captions window that comes
// with the mascot (/#captions, fed over CAPTIONS_CHANNEL). Only the page that
// owns the call has connections feeding this, so mirror windows stay quiet.
//
// Pacing: the transcript streams seconds ahead of the voice, so text is
// never shown as it arrives. Each reply's characters are mapped onto the
// voice actually PLAYED so far (scheduled minus still queued, read off the
// connection's own audio clock), which pauses with an underrun and stops
// dead on a barge-in. Until the reply's audio is fully scheduled its length
// is unknown, so the mapping runs on a speaking rate learned from earlier
// replies — the motion director's model, seeds and bounds — and switches to
// the exact even-rate mapping once output_audio.done says how long it is.
import { reactive } from "../lib/reactive";
import { loadCaptionPrefs } from "../lib/caption_prefs";
import { SPEECH_RATE_MAX, SPEECH_RATE_MIN, SPEECH_RATE_SEED, UNSPACED_SCRIPT_RE } from "../models/motion_director";

export const CAPTIONS_CHANNEL = "rexclaw-captions";

// How long a reply's line stays up once its voice has finished is the
// user's `hold` pref (caption_prefs.js, default 7 s) — counted per reply,
// so a short answer doesn't keep the one before it on screen.
const TICK_MS = 100;
// Replies kept on screen. The display clips to the lines it has room for
// anyway (four in the full-screen view) — this just bounds what is sent
// around.
const MAX_LINES = 4;

/** What every caption display renders: [{id, speaker, text}], oldest first. */
export const captions = reactive({ lines: [] });

const active = new Map();   // connection → its reply being revealed
const expiresAt = new Map();   // line id → when it leaves (its reply has finished)
const rate = { ...SPEECH_RATE_SEED };
let seq = 0;
let timer = null;
let channel = null;

function broadcast() {
    try {
        channel ??= new BroadcastChannel(CAPTIONS_CHANNEL);
        channel.postMessage({ type: "captions", lines: JSON.parse(JSON.stringify(captions.lines)) });
    } catch (e) { /* no BroadcastChannel — the in-page overlay still works */ }
}

function ensureTicking() {
    if (!timer) timer = setInterval(tick, TICK_MS);
}

/** This connection's reply is over: its line's hold starts now. */
function finish(conn) {
    const entry = active.get(conn);
    if (!entry) return;
    expiresAt.set(entry.id, Date.now() + (Number(loadCaptionPrefs().hold) || 7) * 1000);
    active.delete(conn);
}

// Speech cues a voice performs but never says, which captions (showing
// what is heard) leave out; the transcript keeps them. Only the forms the
// voices document, in every language: square-bracket cues — Grok's fixed
// [laugh] set, the free-form ones Fish S2 and ElevenLabs v3/v4 take, like
// [soft, tired voice] or [笑い] — and Grok's wrapping tags
// (<whisper>…</whisper>), whose words stay. Full-width ［］【】 and
// parentheses are no engine's cues: the voice reads them, so they show.
const BRACKET_CUE_RE = /\s*\[+[^[\]\n]*\]+\s*/g;
const WRAP_TAG_RE = /<\/?[a-z][a-z-]*>/gi;
// A cue still being written at the end of the stream ("[soft, tir",
// "<whis"): held back until it closes. Only a recent bracket, as the
// server's chunker does, so a stray "[" can't hide the rest of a reply.
const PARTIAL_CUE_RE = /\s*\[[^\]\n]{0,80}$|<\/?[a-z-]*$/i;
// Where a bracket cue sat, words close up rather than keep a space: before
// closing punctuation ("okay [laughs]." → "okay.") and beside text written
// without spaces ("やった！[laughing] すごい" → "やった！すごい").
const CLOSING_PUNCT_RE = /[.,!?;:…)\]」』）】、。！？，；：]/;

function cueGap(match, offset, text) {
    const before = text[offset - 1];
    const after = text[offset + match.length];
    if (before === undefined || after === undefined || CLOSING_PUNCT_RE.test(after)
        || UNSPACED_SCRIPT_RE.test(before) || UNSPACED_SCRIPT_RE.test(after)) return "";
    return " ";
}

/** A reply's transcript as it is heard. */
function spokenText(raw) {
    const cut = raw.search(PARTIAL_CUE_RE);
    return (cut >= 0 ? raw.slice(0, cut) : raw)
        .replace(BRACKET_CUE_RE, cueGap)
        .replace(WRAP_TAG_RE, "")
        .replace(/[ \t]{2,}/g, " ");
}

/** Seconds of this reply's voice that have actually played. */
function playedSec(conn) {
    const left = conn._audioLookaheadSec?.() ?? 0;
    return Math.max(0, (conn._turnAudioSec || 0) - left);
}

// Word boundaries in every language — the browser's own segmenter, which
// knows where Japanese, Chinese and Thai words break without spaces.
const WORDS = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** Whole words only: a word appears as it starts being said. */
function snap(entry, target) {
    const text = entry.text;
    if (target <= 0) return 0;   // the voice hasn't started yet
    if (target >= text.length) return text.length;
    if (WORDS) {
        const { index, segment } = WORDS.segment(text).containing(target);
        if (index === target) return target;   // the next word hasn't started
        const end = index + segment.length;
        // A word at the very end may still be arriving: the full text is
        // only known once done.
        return end < text.length || entry.doneSec !== null ? end : index;
    }
    if (entry.script === "unspaced") return Math.floor(target);
    const rest = text.slice(target).search(/\s/);
    if (rest >= 0) return target + rest;
    return entry.doneSec !== null ? text.length : Math.max(0, text.lastIndexOf(" ", target));
}

function tick() {
    const now = Date.now();
    let changed = false;
    for (const [conn, entry] of active) {
        const played = playedSec(conn);
        const target = entry.doneSec !== null
            ? entry.c0 + (entry.doneChars - entry.c0)
                * Math.min(1, (played - entry.s0) / Math.max(0.001, entry.doneSec - entry.s0))
            : entry.c0 + Math.max(0, played - entry.s0) * rate[entry.script];
        const shown = Math.max(entry.shown, snap(entry, Math.max(0, Math.round(target))));
        if (shown > entry.shown) {
            entry.shown = shown;
            const line = captions.lines.find((l) => l.id === entry.id);
            const text = entry.text.slice(0, shown).trim();
            if (line) line.text = text;
            else captions.lines = [...captions.lines, { id: entry.id, speaker: entry.speaker, text }].slice(-MAX_LINES);
            changed = true;
        }
        // Fully said: nothing more can come for this reply until the next,
        // and its hold runs from the end of the voice.
        if (entry.doneSec !== null && entry.shown >= entry.text.length && played >= entry.doneSec) {
            finish(conn);
        }
    }
    // Each line leaves its hold after its own reply finished; lines still
    // being spoken have no end time yet and stay.
    const kept = captions.lines.filter((l) => !(now > (expiresAt.get(l.id) ?? Infinity)));
    if (kept.length !== captions.lines.length) {
        captions.lines = kept;
        changed = true;
    }
    for (const id of expiresAt.keys()) {
        if (!captions.lines.some((l) => l.id === id)) expiresAt.delete(id);
    }
    if (changed) broadcast();
    // A reply that never spoke (tool calls only) keeps nothing ticking.
    const speaking = [...active.values()].some((e) => e.text);
    if (!speaking && !captions.lines.length) {
        clearInterval(timer);
        timer = null;
    }
}

export const captionFeed = {
    /** A reply starts (response.created): it gets its own caption line. */
    turnStart(conn) {
        finish(conn);   // a previous reply that never reported its end
        active.set(conn, {
            id: `${conn.connId}:${++seq}`,
            // Group calls name who is speaking, as the transcript does.
            speaker: conn.manager?.hasPeers?.() ? conn.agentName || "" : "",
            raw: "", text: "", shown: 0, script: "spaced",
            // Current mapping segment: from (c0 chars, s0 seconds played)…
            c0: 0, s0: 0,
            // …to its exact end once the audio so far is all scheduled.
            doneChars: null, doneSec: null,
        });
    },

    /** Transcript text for the reply in progress. */
    text(conn, delta) {
        const entry = active.get(conn);
        if (!entry || !delta) return;
        // More words after an audio.done (a reply that speaks in several
        // message items): a new segment starts where the last one ended.
        if (entry.doneSec !== null) {
            entry.c0 = entry.doneChars;
            entry.s0 = entry.doneSec;
            entry.doneChars = entry.doneSec = null;
        }
        entry.raw += delta;
        entry.text = spokenText(entry.raw);
        if (entry.script === "spaced" && UNSPACED_SCRIPT_RE.test(delta)) entry.script = "unspaced";
        ensureTicking();
    },

    /** All of the reply's voice so far is scheduled: its length is known. */
    audioDone(conn) {
        const entry = active.get(conn);
        if (!entry) return;
        entry.doneChars = entry.text.length;
        entry.doneSec = conn._turnAudioSec || 0;
        const chars = entry.doneChars - entry.c0;
        const secs = entry.doneSec - entry.s0;
        if (chars > 0 && secs > 0) {
            const r = chars / secs;
            if (r >= SPEECH_RATE_MIN && r <= SPEECH_RATE_MAX) {
                rate[entry.script] = rate[entry.script] * 0.6 + r * 0.4;
            }
        }
    },

    /** The voice was stopped (barge-in, cancel, call end): what was heard
     *  stays up, the unsaid rest never appears. */
    cut(conn) {
        finish(conn);
    },
};
