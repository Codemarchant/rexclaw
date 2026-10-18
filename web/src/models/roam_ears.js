// A roaming companion's ears (models/roam_director.js): what the computer is
// playing, heard through the desktop app's system-audio loopback (Windows),
// analysed right here and nowhere else — nothing is recorded or sent. It
// tells the director that something is playing at all (you're there,
// watching), music is playing (and its beats), a sudden loud sound, a
// bass drop.
//
// Beats are the classic energy detector (Frédéric Patin, "Beat Detection
// Algorithms", GameDev.net 2003): a beat when the low-end energy jumps past
// C × its average over the last second, C ≈ 1.3, with a minimum gap so one
// kick isn't two. Beats alone also come from talking (syllables) and other
// voices, so music must be steady too: few "low-energy" moments, ones under
// half the last second's mean loudness (Scheirer & Slaney, "Construction and
// Evaluation of a Robust Multifeature Speech/Music Discriminator", ICASSP
// 1997: speech has many, music few). The cut is measured: on 25 voice
// recordings (speech, vocal sounds) and 26 pieces of music, the moments the
// beats alone called music sat above 0.24 for 95 % of the voice and below
// 0.17 for 75 % of the music; 0.20 kept 85 % of the music, 2 % of the voice.
// Everything else here is set by ear.

const BEAT_C = 1.3;              // Patin's sensitivity constant
const BEAT_GAP_MS = 250;         // ≤ 240 BPM
const HISTORY_S = 1;             // Patin's averaging window
const MUSIC_WINDOW_S = 6;        // "music" = beats keep coming over this long…
const MUSIC_MIN_BEATS = 6;       // …at least this many of them…
const LOW_ENERGY_MAX = 0.2;      // …and under this share of quiet moments (see above)
const SILENCE = 0.004;           // RMS below this is quiet
const LOUD_RATIO = 5;            // a sound 5× the last two seconds' level…
const LOUD_MIN = 0.12;           // …and loud in itself
const DROP_RATIO = 2.2;          // low end 2.2× its last 8 s while music plays
const DROP_GAP_MS = 60000;
const TICK_HZ = 60;              // how often it listens (the measurement's rate)

export class RoamEars {
    constructor({ onMusic, onBeat, onStartle, onDrop }) {
        this.on = { onMusic, onBeat, onStartle, onDrop };
        this.music = false;
        this.playingAt = 0;       // last time something was playing (performance.now)
        this._stream = null;
        this._ctx = null;
        this._timer = 0;
    }

    /** Start listening; resolves false where there's nothing to listen to
     *  (not Windows, or the grant failed). */
    async start(bridge) {
        if (!bridge?.roamAudioArm || !(await bridge.roamAudioArm())) return false;
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } catch (e) {
            return false;
        }
        // Only the sound is wanted.
        stream.getVideoTracks().forEach((t) => t.stop());
        if (!stream.getAudioTracks().length) return false;
        this._stream = stream;
        const ctx = this._ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0;
        src.connect(an);
        const wave = new Float32Array(an.fftSize);
        const freq = new Uint8Array(an.frequencyBinCount);
        // Bins under ~150 Hz: the kick and the bass.
        const lowBins = Math.max(2, Math.round(150 / (ctx.sampleRate / an.fftSize)));
        const hist = [];          // [t, lowEnergy, rms] over the last 8 s
        const beats = [];
        const lowEnergy = [];     // [t, share of quiet moments in the second before], not silent ones
        let lastBeat = 0, lastDrop = 0;
        const tick = () => {
            const t = performance.now();
            an.getFloatTimeDomainData(wave);
            let s = 0;
            for (let i = 0; i < wave.length; i++) s += wave[i] * wave[i];
            const rms = Math.sqrt(s / wave.length);
            an.getByteFrequencyData(freq);
            let low = 0;
            for (let i = 1; i <= lowBins; i++) low += freq[i] * freq[i];
            low /= lowBins * 65025;
            while (hist.length && t - hist[0][0] > 8000) hist.shift();
            const recent = hist.filter((h) => t - h[0] <= HISTORY_S * 1000);
            const avgLow = recent.reduce((a, h) => a + h[1], 0) / Math.max(1, recent.length);
            const twoS = hist.filter((h) => t - h[0] <= 2000);
            const avgRms = twoS.reduce((a, h) => a + h[2], 0) / Math.max(1, twoS.length);
            const avg8 = hist.reduce((a, h) => a + h[1], 0) / Math.max(1, hist.length);
            hist.push([t, low, rms]);
            if (recent.length > 20 && rms > SILENCE && low > avgLow * BEAT_C && t - lastBeat > BEAT_GAP_MS) {
                lastBeat = t;
                beats.push(t);
                this.on.onBeat?.();
            }
            while (beats.length && t - beats[0] > MUSIC_WINDOW_S * 1000) beats.shift();
            // Quiet moments in the last second, over the beats' window.
            const second = hist.filter((h) => t - h[0] <= 1000);
            const mean = second.reduce((a, h) => a + h[2], 0) / second.length;
            if (mean >= SILENCE) lowEnergy.push([t, second.filter((h) => h[2] < mean / 2).length / second.length]);
            while (lowEnergy.length && t - lowEnergy[0][0] > MUSIC_WINDOW_S * 1000) lowEnergy.shift();
            const quiet = lowEnergy.reduce((a, h) => a + h[1], 0) / Math.max(1, lowEnergy.length);
            const music = beats.length >= MUSIC_MIN_BEATS && lowEnergy.length > 0 && quiet < LOW_ENERGY_MAX;
            // Sound through most of the last five seconds: something is
            // playing (a stream, a video, music), not just a notification.
            const five = hist.filter((h) => t - h[0] <= 5000);
            if (five.length > 60 && five.filter((h) => h[2] > SILENCE).length > five.length / 2) this.playingAt = t;
            if (music !== this.music) {
                this.music = music;
                this.on.onMusic?.(music);
            }
            if (twoS.length > 60 && rms > LOUD_MIN && rms > avgRms * LOUD_RATIO && !music) this.on.onStartle?.();
            if (music && hist.length > 300 && t - lastDrop > DROP_GAP_MS && avgLow > avg8 * DROP_RATIO) {
                lastDrop = t;
                this.on.onDrop?.();
            }
        };
        // A fixed TICK_HZ, not the display's frame rate: the music cut was
        // measured at it, and a 144 Hz screen would walk 2.4× the history.
        this._timer = setInterval(tick, 1000 / TICK_HZ);
        return true;
    }

    stop() {
        clearInterval(this._timer);
        this._stream?.getTracks().forEach((t) => t.stop());
        this._stream = null;
        this._ctx?.close().catch(() => {});
        this._ctx = null;
    }
}
