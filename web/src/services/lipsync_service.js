
/**
 * Audio-driven viseme lipsync.
 *
 * Approach: with the Realtime API we receive raw audio (no phoneme stream), so
 * we estimate vowel weights from formants F1/F2 and overall RMS. The mapping
 * is deliberately coarse — "looks like talking" rather than phonetically
 * accurate, which is good enough at the latency the avatar runs at.
 *
 * Multi-agent calls: each live agent connection owns an independent
 * LipsyncChannel (created via createChannel()) with its own AnalyserNode on
 * that connection's playback gain node. One shared rAF loop ticks every
 * connected channel, and each channel notifies its own listeners — so two
 * avatars can speak (and move their mouths) independently.
 *
 * The service does NOT own any audio source — each connection attaches its
 * channel to the gain node it plays assistant audio through. When
 * `replayMode=true` is set (session history replay), every channel zeroes its
 * vowel weights so resumed history doesn't trigger phantom mouth movement.
 */

// Silence handling (ported from moeru-ai/airi's lip-sync.ts). A hard intensity
// floor plus a short hangover so brief gaps and low-level noise/breath between
// words snap the mouth shut instead of leaving it fluttering. Below the floor
// we keep the previous shape alive for the hangover window so a quick inter-
// syllable dip doesn't read as a stutter, then force closed.
const SILENCE_INTENSITY = 0.12;     // rawIntensity below this counts as "not speaking"
const SILENCE_HANGOVER_MS = 160;
// Attack/release rates for frame-rate-independent smoothing via
// 1 - exp(-rate * dt). Attack faster than release so the mouth opens crisply
// on a syllable and eases closed between them. Replaces the previous fixed
// per-tick coefficients, which tracked faster on high-refresh displays.
const LIP_ATTACK_RATE = 50;
const LIP_RELEASE_RATE = 30;

class LipsyncChannel {
    constructor(service) {
        this.service = service;
        this.audioContext = null;
        this.analyser = null;
        this.timeBuffer = null;
        this.freqBuffer = null;
        this.connected = false;
        this.smoothed = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        this.intensity = 0;
        this._lastTickAt = 0;       // ms timestamp of previous tick (for dt)
        this._lastActiveAt = 0;     // ms timestamp of last above-floor frame (silence hangover)
        this._listeners = new Set();
    }

    /** Tap an AnalyserNode off the given gain node. The gain node's own
     *  AudioContext is used, so channels on different contexts coexist. */
    attach(gainNode) {
        if (this.connected) this.detach();
        try {
            const ctx = gainNode.context;
            this.audioContext = ctx;
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0.6;
            this.timeBuffer = new Float32Array(this.analyser.fftSize);
            this.freqBuffer = new Float32Array(this.analyser.frequencyBinCount);
            gainNode.connect(this.analyser);
            this.connected = true;
            this._lastTickAt = 0;
            this.service._ensureLoop();
        } catch (e) {
            console.error("[voice] lipsync: failed to attach analyser", e);
        }
    }

    /** Stop analysing. Safe to call repeatedly; the analyser node is dropped
     *  (its context may be closing anyway). */
    detach() {
        this.connected = false;
        if (this.analyser) {
            try { this.analyser.disconnect(); } catch (e) { /* swallow */ }
        }
        this.analyser = null;
        this.audioContext = null;
        this._zero();
    }

    addListener(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _zero() {
        this.smoothed = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        this.intensity = 0;
        this._lastActiveAt = 0;
        this._notify();
    }

    _notify() {
        for (const fn of this._listeners) {
            try { fn(this.smoothed, this.intensity); } catch (e) { /* swallow */ }
        }
    }

    /** One analysis step. Public so the XR render loop can drive it: an
     *  immersive WebXR session pauses window.requestAnimationFrame, which would
     *  otherwise freeze the mouth in VR. Safe to call when idle (guards on the
     *  analyser / replay mode). */
    tick() {
        if (!this.analyser || !this.connected || this.service.replayMode) return;
        this.analyser.getFloatTimeDomainData(this.timeBuffer);
        this.analyser.getFloatFrequencyData(this.freqBuffer);

        // RMS → master mouth-open. Multiplier and ceiling tuned so a typical
        // TTS voice (xAI/OpenAI realtime) hits 0.7–1.0 reliably during speech
        // and decays to 0 in silence. With the previous *4 multiplier the
        // mouth barely moved at all because nominal RMS was around 0.05–0.15.
        let sumSq = 0;
        for (let i = 0; i < this.timeBuffer.length; i++) {
            sumSq += this.timeBuffer[i] * this.timeBuffer[i];
        }
        const rms = Math.sqrt(sumSq / this.timeBuffer.length);
        const rawIntensity = Math.min(1, Math.pow(rms * 8, 0.85));

        // Frame-rate-independent timestep. Clamp so a backgrounded tab
        // (huge gap between rAF callbacks) doesn't snap the mouth.
        const now = performance.now();
        const dt = this._lastTickAt ? Math.min(0.1, (now - this._lastTickAt) / 1000) : 0.016;
        this._lastTickAt = now;

        // Silence gate with hangover. Stay "active" for SILENCE_HANGOVER_MS
        // after the last above-floor frame so a brief inter-syllable dip
        // doesn't read as the mouth slamming shut; past that, force closed.
        if (rawIntensity >= SILENCE_INTENSITY) this._lastActiveAt = now;
        const silent = !this._lastActiveAt || (now - this._lastActiveAt) > SILENCE_HANGOVER_MS;

        let target;
        let intensityTarget;
        if (silent) {
            target = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
            intensityTarget = 0;
        } else {
            const sampleRate = this.audioContext.sampleRate;
            const binHz = sampleRate / this.analyser.fftSize;
            const f1 = this._findPeakHz(200, 1000, binHz);
            const f2 = this._findPeakHz(800, 2800, binHz);
            target = this._formantToVowels(f1, f2, rawIntensity);
            intensityTarget = rawIntensity;
        }

        // Asymmetric, frame-rate-independent smoothing: faster attack,
        // slower release. Mouth opening tracks the audio crisply; closing
        // eases so gaps between syllables don't look like stutters.
        const smooth = (cur, tgt) => {
            const rate = tgt > cur ? LIP_ATTACK_RATE : LIP_RELEASE_RATE;
            return cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
        };
        this.smoothed.aa = smooth(this.smoothed.aa, target.aa);
        this.smoothed.ih = smooth(this.smoothed.ih, target.ih);
        this.smoothed.ou = smooth(this.smoothed.ou, target.ou);
        this.smoothed.ee = smooth(this.smoothed.ee, target.ee);
        this.smoothed.oh = smooth(this.smoothed.oh, target.oh);
        this.intensity = smooth(this.intensity, intensityTarget);

        this._notify();
    }

    _findPeakHz(minHz, maxHz, binHz) {
        const minBin = Math.floor(minHz / binHz);
        const maxBin = Math.min(Math.floor(maxHz / binHz), this.freqBuffer.length - 1);
        let peakBin = minBin;
        let peakDb = -Infinity;
        for (let i = minBin; i <= maxBin; i++) {
            const db = this.freqBuffer[i];
            if (db > peakDb) {
                peakDb = db;
                peakBin = i;
            }
        }
        return peakBin * binHz;
    }

    /**
     * Map (F1, F2) → vowel weights. Master `aa` weight is driven primarily by
     * audio intensity so the mouth visibly opens/closes; formants only bias
     * which vowel shape gets picked. This is much more legible than the
     * previous "split intensity equally across 5 vowels" approach, which left
     * each vowel at <=0.2 weight even at peak loudness.
     */
    _formantToVowels(f1, f2, intensity) {
        const targets = {
            aa: { f1: 700, f2: 1200 },
            ee: { f1: 300, f2: 2300 },
            ou: { f1: 300, f2: 900 },
            ih: { f1: 400, f2: 1700 },
            oh: { f1: 500, f2: 1000 },
        };
        // Rank vowels by distance in formant space.
        const ranked = Object.entries(targets)
            .map(([vowel, t]) => {
                const df1 = (Math.log2(f1 || 1) - Math.log2(t.f1)) * 1.5;
                const df2 = Math.log2(f2 || 1) - Math.log2(t.f2);
                return [vowel, Math.sqrt(df1 * df1 + df2 * df2)];
            })
            .sort((a, b) => a[1] - b[1]);
        // Blend only the WINNER + single RUNNER-UP rather than spreading the
        // remainder across all four losers. Spreading kept every viseme partly
        // open and — because `aa` has the largest deformation — biased the
        // visible mouth shape toward "aa" mush. Top-2 gives crisp, legible
        // shapes (the fix moeru-ai/airi's lip-sync.ts makes explicit).
        const weights = { aa: 0, ee: 0, ou: 0, ih: 0, oh: 0 };
        weights[ranked[0][0]] = intensity * 0.7;
        if (ranked[1]) weights[ranked[1][0]] = intensity * 0.25;
        return weights;
    }
}

class LipsyncService {
    constructor(env) {
        this.env = env;
        this.replayMode = false;
        this._channels = new Set();
        this._rafHandle = null;
    }

    /** Allocate an independent analysis channel. The caller attaches it to a
     *  playback gain node and subscribes for vowel updates. Release with
     *  removeChannel() (or channel.detach() to keep the slot). */
    createChannel() {
        const ch = new LipsyncChannel(this);
        this._channels.add(ch);
        return ch;
    }

    removeChannel(ch) {
        if (!ch) return;
        ch.detach();
        this._channels.delete(ch);
        if (![...this._channels].some((c) => c.connected)) this._stopLoop();
    }

    setReplayMode(active) {
        this.replayMode = !!active;
        if (active) {
            for (const ch of this._channels) ch._zero();
        }
    }

    /** Detach every channel (legacy teardown hook — the manager calls this on
     *  full session end). Channels stay registered so a later re-attach on the
     *  same channel object works. */
    disconnect() {
        for (const ch of this._channels) ch.detach();
        this._stopLoop();
    }

    /** One analysis step across every connected channel. Public so the XR
     *  render loop can drive it (immersive sessions pause window rAF). */
    tick() {
        for (const ch of this._channels) {
            if (ch.connected) ch.tick();
        }
    }

    _ensureLoop() {
        if (this._rafHandle) return;
        const loop = () => {
            const anyConnected = [...this._channels].some((c) => c.connected);
            if (!anyConnected) { this._rafHandle = null; return; }
            this._rafHandle = requestAnimationFrame(loop);
            this.tick();
        };
        loop();
    }

    _stopLoop() {
        if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
    }
}

export const lipsync = new LipsyncService();
