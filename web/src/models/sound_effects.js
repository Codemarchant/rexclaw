/**
 * Sound effects in calls (server/sound_effects.py serves the effects).
 *
 *   playing   each effect is decoded once and played as a one-shot on its
 *             own AudioContext, at the gain the server measured for it
 *             (every effect at the same loudness). Effects may overlap;
 *             they neither duck under voices nor touch the background music
 *   timing    a companion's effect waits for the words it has already said
 *             in that reply to be heard, so a line and its sound arrive in
 *             the order they were meant; if the user talks over the line,
 *             the sound is dropped with it. The reply after it is generated
 *             while the sound plays and held back until it ends
 *             (agent_connection.holdSpeechFor), so the two meet without a
 *             gap. Asked for "during", it plays at once instead, over the
 *             line
 *   who       the companion (play_sound_effect), or the avatar editor's
 *             ▶ / ■ buttons (preview)
 *
 * Lives in whichever window holds the call; a call ending cuts what is
 * still playing.
 */
import { rpc } from "../lib/rpc";
import { NEEDS_TAP_UNLOCK, UNLOCK_EVENTS } from "./background_music";

// The longest play_sound_effect keeps the next words back for a sound still
// playing, and the longest it waits past the moment the speech before it was due to
// end: the same safety net as agent_connection's wait for queued audio.
const WAIT_MAX_MS = 10000;
const POLL_MS = 50;
// Speech that ends this much sooner than its queue said was cut off (the
// user spoke over it), not finished. A judgment call: well past scheduling
// jitter, well short of a sentence.
const CUT_MARGIN_MS = 250;

const dbToGain = (db) => Math.pow(10, db / 20);
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SoundEffects {
    constructor() {
        this._ctx = null;
        this._buffers = new Map();   // url → Promise<AudioBuffer>
        this._gains = new Map();     // url → Promise<gain dB>
        this._lists = new Map();     // agent id → the companion's effects
        this._playing = new Set();   // sources still sounding
        if (typeof document !== "undefined" && NEEDS_TAP_UNLOCK) {
            // WebKit starts an AudioContext only inside a tap, and effects
            // play after server round-trips, never inside one: the first tap
            // anywhere wakes the context, which may then play at any time.
            for (const type of UNLOCK_EVENTS) document.addEventListener(type, () => this._context(), true);
        }
    }

    /** A companion's effects: [{name, url, description, credit, source, level}]. */
    async list(agentId, { fresh = false } = {}) {
        const key = agentId ?? null;
        if (fresh || !this._lists.has(key)) {
            const { effects } = await rpc("/api/sound_effects/list", { agent_id: key });
            this._lists.set(key, effects || []);
        }
        return this._lists.get(key);
    }

    _context() {
        if (!this._ctx) this._ctx = new AudioContext();
        // "suspended", or iOS's "interrupted" (the microphone starting, the
        // app going to the background): wake it either way.
        if (this._ctx.state !== "running") this._ctx.resume().catch(() => {});
        return this._ctx;
    }

    _buffer(url) {
        if (!this._buffers.has(url)) {
            const loading = fetch(url)
                .then((r) => {
                    if (!r.ok) throw new Error(`The sound file is missing (${r.status}).`);
                    return r.arrayBuffer();
                })
                .then((data) => this._context().decodeAudioData(data));
            // A later call tries again (unless the cache has moved on since).
            loading.catch(() => { if (this._buffers.get(url) === loading) this._buffers.delete(url); });
            this._buffers.set(url, loading);
        }
        return this._buffers.get(url);
    }

    _gain(effect) {
        const key = `${effect.level || 0}|${effect.url}`;
        if (!this._gains.has(key)) {
            this._gains.set(key, rpc("/api/sound_effects/level", { url: effect.url, level: effect.level || 0 })
                .then((r) => r.gain_db || 0)
                .catch(() => 0));   // unmeasured: play as it is
        }
        return this._gains.get(key);
    }

    /** Play one effect now. Resolves once it has started, with
     *  {seconds: its length, stop(): cut it, ended: a promise for when it
     *  is over, either way}; throws when it could not be played. */
    async play(effect) {
        const ctx = this._context();
        const [buffer, gainDb] = await Promise.all([this._buffer(effect.url), this._gain(effect)]);
        if (ctx.state !== "running") {
            // A resume the browser is holding for a tap never settles.
            await Promise.race([ctx.resume().catch(() => {}), sleep(300)]);
            if (ctx.state !== "running") {
                const e = new Error("The user's device holds sound until their next touch on the screen.");
                e.name = "NotAllowedError";
                throw e;
            }
        }
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        gain.gain.value = dbToGain(gainDb);
        source.connect(gain);
        gain.connect(ctx.destination);
        this._playing.add(source);
        const ended = new Promise((resolve) => {
            source.onended = () => {
                this._playing.delete(source);
                try { source.disconnect(); gain.disconnect(); } catch (e) { /* gone */ }
                resolve();
            };
        });
        source.start();
        return {
            seconds: buffer.duration,
            ended,
            stop: () => { try { source.stop(); } catch (e) { /* already over */ } },
        };
    }

    /** The avatar editor's ▶ / ■: an effect by its file, at call level.
     *  Resolves like play(). */
    preview(url, level = 0) {
        return this.play({ url, level });
    }

    /** Cut everything still sounding. */
    stop() {
        for (const source of [...this._playing]) {
            try { source.stop(); } catch (e) { /* already over */ }
        }
        this._playing.clear();
    }

    /** The call is over (voice_service.onConnectionEnded): cut what still
     *  plays, and forget the lists and levels, which the user may edit
     *  before the next call. */
    callEnded() {
        this.stop();
        this._lists.clear();
        this._gains.clear();
        this._buffers.clear();
    }

    /** Wait until the speech queued at this moment has been heard
     *  (`lookahead`: seconds of the caller's voice still to play), however
     *  long the line is. False when it was cut short instead. */
    async _afterSpeech(lookahead) {
        const ahead = lookahead?.() ?? 0;
        if (!(ahead > 0)) return true;
        const due = performance.now() + ahead * 1000;
        // Past `due` only a stalled queue is still "playing": stop waiting.
        while (performance.now() < due + WAIT_MAX_MS) {
            const left = lookahead();
            if (!(left > 0)) return performance.now() >= due - CUT_MARGIN_MS;
            await sleep(Math.min(left * 1000, POLL_MS));
        }
        return true;
    }

    // ------------------------------------------------------------------
    // play_sound_effect (tool_dispatcher.js)
    // ------------------------------------------------------------------

    /** play_sound_effect. `timing` "after" (the default): the sound plays
     *  after the caller's queued speech, and the reply that follows comes
     *  after the sound. The result goes back as the sound starts, so that
     *  reply is generated while it plays, and `holdSpeech(seconds)` keeps
     *  the caller's voice from starting before it is over (without it, the
     *  result waits for the sound instead). "during": it plays at once, over
     *  the line being spoken, and nothing waits for it. */
    async runTool({ sound, timing }, { agentId, lookahead, holdSpeech }) {
        if (!sound) return { ok: false, error: "Pass `sound`: the name of the sound effect to play." };
        const during = timing === "during";
        // Loading runs while the speech before it plays out.
        const ready = (async () => {
            let effect = (await this.list(agentId)).find((e) => sameName(e.name, sound));
            // The user may have added it since the call's list was read.
            if (!effect) effect = (await this.list(agentId, { fresh: true })).find((e) => sameName(e.name, sound));
            if (effect) await Promise.all([this._buffer(effect.url), this._gain(effect)]);
            return effect;
        })();
        ready.catch(() => {});   // reported below
        const heard = during || await this._afterSpeech(lookahead);
        let effect;
        try {
            effect = await ready;
        } catch (e) {
            return { ok: false, error: `It could not be played: ${e.message || e}` };
        }
        if (!effect) return { ok: false, error: `No sound effect called "${sound}".` };
        if (!heard) {
            return { ok: false, sound: effect.name,
                     note: "Not played: the user spoke over the line it belonged to." };
        }
        let seconds;
        try {
            ({ seconds } = await this.play(effect));
        } catch (e) {
            return { ok: false, error: e?.name === "NotAllowedError" ? e.message
                : `It could not be played: ${e.message || e}` };
        }
        if (during) return { ok: true, sound: effect.name };
        const wait = Math.min(seconds * 1000, WAIT_MAX_MS);
        if (holdSpeech) holdSpeech(wait / 1000);
        else await sleep(wait);
        if (seconds * 1000 > wait) {
            return { ok: true, sound: effect.name,
                     note: `It is ${Math.round(seconds)} seconds long, so it will still be playing under what you say next.` };
        }
        return { ok: true, sound: effect.name };
    }
}

export const soundEffects = new SoundEffects();
