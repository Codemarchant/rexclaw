// Toy sounds, synthesised on the spot with Web Audio (no sound files):
// bounces, squeaks, pops, chomps, the fan's hum and the dryer's roar. Quiet
// on purpose (a toy on the desktop shouldn't startle anyone), and off with
// the tray's speaker toggle (`enabled`, kept per browser).
//
// While roaming, the companion's ears hear what this computer plays: `lastAt`
// lets the director tell its own toys' noise from a startling sound.

const MASTER = 0.22;   // overall level (by ear)
const KEY = "rexclaw.toy_sounds";

class ToySfx {
    constructor() {
        this.ctx = null;
        this.lastAt = 0;
        this._loops = new Map();
        try { this.enabled = localStorage.getItem(KEY) !== "0"; } catch (e) { this.enabled = true; }
    }

    setEnabled(on) {
        this.enabled = !!on;
        try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) { /* private mode */ }
        if (!on) for (const id of [...this._loops.keys()]) this.loop(id, false);
    }

    _ac() {
        if (!this.enabled) return null;
        if (!this.ctx) {
            try {
                this.ctx = new AudioContext();
                this.out = this.ctx.createGain();
                this.out.gain.value = MASTER;
                this.out.connect(this.ctx.destination);
            } catch (e) { return null; }
        }
        if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
        this.lastAt = performance.now();
        return this.ctx;
    }

    _noise(ac, seconds) {
        const n = Math.max(1, Math.floor(ac.sampleRate * seconds));
        const buf = ac.createBuffer(1, n, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        return buf;
    }

    /** A pitched blip: `type` wave from f0 to f1 over `dur`, `vol` peak. */
    _tone(f0, f1, dur, { type = "sine", vol = 1, at = 0 } = {}) {
        const ac = this._ac();
        if (!ac) return;
        const t = ac.currentTime + at;
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur / 4));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.out);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    /** Filtered noise: a thud, a swish, a crunch. */
    _hiss(dur, { freq = 1200, q = 0.8, type = "bandpass", vol = 1, sweep = null, at = 0 } = {}) {
        const ac = this._ac();
        if (!ac) return;
        const t = ac.currentTime + at;
        const src = ac.createBufferSource();
        src.buffer = this._noise(ac, dur);
        const f = ac.createBiquadFilter();
        f.type = type;
        f.frequency.setValueAtTime(freq, t);
        if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
        f.Q.value = q;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(this.out);
        src.start(t);
    }

    /** A bounce, louder for a harder hit; `kind` sets the material. */
    bounce(speed, kind = "ball") {
        const v = Math.min(1, speed / 6);
        if (v < 0.08) return;
        if (kind === "basketball") {
            this._tone(150, 70, 0.18, { type: "sine", vol: 0.9 * v });
            this._hiss(0.06, { freq: 900, vol: 0.4 * v });
        } else if (kind === "rugby") {
            this._tone(120, 80, 0.12, { type: "sine", vol: 0.7 * v });
            this._hiss(0.07, { freq: 600, type: "lowpass", vol: 0.5 * v });
        } else if (kind === "coin") {
            this._tone(2400 + Math.random() * 600, 2200, 0.12, { type: "triangle", vol: 0.35 * v });
            this._tone(3600, 3400, 0.08, { type: "sine", vol: 0.2 * v, at: 0.01 });
        } else if (kind === "bottle") {
            this._tone(900, 820, 0.2, { type: "sine", vol: 0.4 * v });
        } else {
            this._hiss(0.08, { freq: 400, type: "lowpass", vol: 0.7 * v });
        }
    }

    squeak() {
        this._tone(700, 1500, 0.09, { type: "square", vol: 0.25 });
        this._tone(1500, 900, 0.12, { type: "square", vol: 0.2, at: 0.09 });
    }

    pop() { this._tone(1400 + Math.random() * 500, 300, 0.05, { type: "sine", vol: 0.5 }); }

    chomp() {
        this._hiss(0.07, { freq: 2200, q: 0.6, vol: 0.6 });
        this._hiss(0.05, { freq: 1600, q: 0.6, vol: 0.45, at: 0.09 });
    }

    /** A crisp bite (an apple). */
    crunch() {
        this._hiss(0.05, { freq: 3200, q: 0.9, vol: 0.7 });
        this._hiss(0.04, { freq: 2600, q: 0.9, vol: 0.55, at: 0.05 });
        this._hiss(0.05, { freq: 2000, q: 0.9, vol: 0.4, at: 0.11 });
    }

    /** A strip of banana peel pulled down. */
    peel() { this._hiss(0.22, { freq: 2400, q: 0.7, vol: 0.3, sweep: 700 }); }

    /** Caught in the mouth. */
    gulp() {
        this._tone(420, 180, 0.09, { type: "sine", vol: 0.5 });
        this._tone(260, 140, 0.08, { type: "sine", vol: 0.35, at: 0.1 });
    }

    lick() { this._hiss(0.12, { freq: 1800, q: 1.2, vol: 0.18, sweep: 2600 }); }

    /** Noodles drawn in off the chopsticks. */
    slurp() { this._hiss(0.45, { freq: 900, q: 2.5, vol: 0.3, sweep: 2800 }); }

    /** A careful sip of something hot. */
    sip() { this._hiss(0.25, { freq: 2600, q: 1.6, vol: 0.16, sweep: 1400 }); }

    /** A blow across a hot drink. */
    blow() { this._hiss(0.6, { freq: 700, q: 0.6, type: "lowpass", vol: 0.25 }); }

    /** A bottle cap twisted off, its seal cracking. */
    cap() {
        for (let i = 0; i < 4; i++) this._hiss(0.02, { freq: 3800, q: 1.5, vol: 0.4, at: i * 0.035 });
    }

    clank() {
        this._tone(520, 500, 0.25, { type: "square", vol: 0.25 });
        this._tone(1240, 1200, 0.2, { type: "triangle", vol: 0.25 });
    }

    swish() { this._hiss(0.35, { freq: 3000, q: 0.5, type: "highpass", vol: 0.35, sweep: 7000 }); }

    whoosh() { this._hiss(0.5, { freq: 300, q: 0.7, vol: 0.6, sweep: 2400 }); }

    rim() { this._tone(620, 600, 0.3, { type: "triangle", vol: 0.45 }); }

    click() { this._tone(1800, 1700, 0.02, { type: "square", vol: 0.25 }); }

    sizzle() { this._hiss(0.9, { freq: 5000, q: 0.4, type: "highpass", vol: 0.35 }); }

    cork() {
        this._tone(500, 1400, 0.06, { type: "sine", vol: 0.6 });
        this._hiss(0.05, { freq: 2500, vol: 0.3 });
    }

    chime() {
        [880, 1109, 1319, 1760].forEach((f, i) => this._tone(f, f, 0.5, { type: "sine", vol: 0.25, at: i * 0.07 }));
    }

    /** Fish flakes rubbed out over the water. */
    sprinkle() {
        for (let i = 0; i < 5; i++) this._hiss(0.05, { freq: 5200, q: 1.4, vol: 0.12, at: i * 0.07 });
    }

    /** A jack-o'-lantern's scare: a low thump, then a cackle, a sawtooth
     *  through two vowel formants falling syllable by syllable, with bats'
     *  wings and squeaks over it (by ear). */
    boo() {
        const ac = this._ac();
        if (!ac) return;
        this._tone(90, 34, 0.9, { vol: 1 });
        this._hiss(0.5, { freq: 240, q: 0.7, type: "lowpass", vol: 0.6 });
        const start = ac.currentTime + 0.12;
        for (let i = 0; i < 9; i++) {
            const t = start + i * 0.115 + Math.random() * 0.012, dur = 0.1;
            const f0 = (640 - i * 34) * (1 + Math.random() * 0.05);
            const o = ac.createOscillator();
            o.type = "sawtooth";
            o.frequency.setValueAtTime(f0 * 1.12, t);
            o.frequency.exponentialRampToValueAtTime(f0 * 0.82, t + dur);
            const g = ac.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            for (const [hz, q] of [[1050, 5], [2400, 7]]) {
                const f = ac.createBiquadFilter();
                f.type = "bandpass";
                f.frequency.value = hz;
                f.Q.value = q;
                o.connect(f).connect(g);
            }
            g.connect(this.out);
            o.start(t);
            o.stop(t + dur + 0.02);
        }
        for (let i = 0; i < 18; i++) this._hiss(0.04, { freq: 1500, q: 1, vol: 0.14, at: 0.2 + i * 0.075 });
        for (let i = 0; i < 6; i++) {
            const f = 3200 + Math.random() * 1600;
            this._tone(f, f * 0.75, 0.05, { vol: 0.08, at: 0.3 + Math.random() * 1.1 });
        }
    }

    /** `n` samples that loop without a click: made `n + k` long by `fill`,
     *  the extra `k` crossfaded into the start. */
    _seamless(ac, seconds, fill) {
        const n = Math.floor(ac.sampleRate * seconds), k = Math.floor(ac.sampleRate * 0.05);
        const tmp = new Float32Array(n + k);
        fill(tmp, ac.sampleRate);
        const buf = ac.createBuffer(1, n, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = i < k ? tmp[i] * (i / k) + tmp[n + i] * (1 - i / k) : tmp[i];
        return buf;
    }

    /** A wood fire, 8 s round: a low roar, crackles and now and then a pop
     *  (by ear). */
    _fireBuffer(ac) {
        return this._seamless(ac, 8, (d, sr) => {
            let b = 0;
            for (let i = 0; i < d.length; i++) {
                b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
                d[i] = b * 3.5;
            }
            for (let c = 0; c < 56; c++) {
                const at = Math.floor(Math.random() * d.length), pop = Math.random() < 0.12;
                const len = Math.floor(sr * (pop ? 0.03 : 0.006)), amp = pop ? 0.9 : 0.15 + Math.random() * 0.35;
                for (let i = 0; i < len && at + i < d.length; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (len / 4));
            }
        });
    }

    /** An aquarium's air stone, 6 s round: each bubble rings as it pinches
     *  off at its Minnaert frequency, 3.28 / R Hz for a radius of R metres
     *  in water (Minnaert 1933), here 1-3 mm; about a dozen a second, ringing
     *  down in a few milliseconds, over the water's low murmur (by ear). */
    _bubbleBuffer(ac) {
        return this._seamless(ac, 6, (d, sr) => {
            let b = 0;
            for (let i = 0; i < d.length; i++) {
                b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
                d[i] = b * 0.8;
            }
            for (let c = 0; c < 72; c++) {
                const at = Math.floor(Math.random() * d.length);
                const f = 3.28 / (0.001 + Math.random() * 0.002), tau = 0.004 + Math.random() * 0.003, amp = 0.08 + Math.random() * 0.12;
                const len = Math.floor(sr * tau * 5);
                let ph = 0;
                for (let i = 0; i < len && at + i < d.length; i++) {
                    // Rising a little as it rings.
                    ph += (2 * Math.PI * f * (1 + 0.1 * i / len)) / sr;
                    d[at + i] += Math.sin(ph) * amp * Math.exp(-i / (sr * tau));
                }
            }
        });
    }

    /** A haunted night, 12 s round: wind rising and falling, a low pair of
     *  notes a semitone apart beating under it, a candle's tick now and then
     *  (by ear). */
    _hauntBuffer(ac) {
        return this._seamless(ac, 12, (d, sr) => {
            let b = 0;
            for (let i = 0; i < d.length; i++) {
                const t = i / sr;
                b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
                const gust = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 6 - 1) * Math.sin((2 * Math.PI * t) / 4);
                d[i] = b * 3 * (0.25 + gust) + 0.1 * Math.sin(2 * Math.PI * 55 * t) + 0.08 * Math.sin(2 * Math.PI * 58.3 * t);
            }
            for (let c = 0; c < 10; c++) {
                const at = Math.floor(Math.random() * d.length), len = Math.floor(sr * 0.005);
                for (let i = 0; i < len && at + i < d.length; i++) d[at + i] += (Math.random() * 2 - 1) * 0.2 * Math.exp(-i / (len / 4));
            }
        });
    }

    /** A sound that runs while a gadget is on: the fan's hum, the dryer's
     *  roar, the smoke machine's hiss, a campfire, an aquarium's bubbles, a
     *  jack-o'-lantern's night. `level` 0-1 scales it. */
    loop(id, on, kind = "fan", level = 1) {
        const cur = this._loops.get(id);
        if (!on) {
            if (!cur) return;
            this._loops.delete(id);
            try {
                cur.gain.gain.setTargetAtTime(0.0001, cur.ac.currentTime, 0.08);
                setTimeout(() => { try { cur.src.stop(); } catch (e) { /* stopped */ } }, 600);
            } catch (e) { /* closed */ }
            return;
        }
        if (cur) {
            cur.gain.gain.setTargetAtTime(cur.base * level, cur.ac.currentTime, 0.1);
            return;
        }
        const ac = this._ac();
        if (!ac) return;
        const src = ac.createBufferSource();
        src.buffer = kind === "fire" ? this._fireBuffer(ac) : kind === "bubbler" ? this._bubbleBuffer(ac) : kind === "haunt" ? this._hauntBuffer(ac) : this._noise(ac, 2);
        src.loop = true;
        const f = ac.createBiquadFilter();
        // [filter Hz, Q, level]: the fan a low hum, the dryer a soft rush,
        // the smoke machine a hiss under the rest; the fire and the bubbles
        // made whole above, only their harshest top taken off (by ear).
        const spec = {
            fan: [220, 0.7, 0.35], dryer: [700, 0.6, 0.1], fogger: [1400, 0.5, 0.06], fire: [6000, 0.5, 0.5], bubbler: [5000, 0.5, 0.35], haunt: [1600, 0.5, 0.4],
        }[kind] || [400, 1, 0.3];
        f.type = kind === "fogger" ? "bandpass" : "lowpass";
        f.frequency.value = spec[0];
        f.Q.value = spec[1];
        const gain = ac.createGain();
        gain.gain.value = 0.0001;
        gain.gain.setTargetAtTime(spec[2] * level, ac.currentTime, 0.15);
        src.connect(f).connect(gain).connect(this.out);
        src.start();
        this._loops.set(id, { src, gain, ac, base: spec[2] });
    }

    stopAll() {
        for (const id of [...this._loops.keys()]) this.loop(id, false);
    }
}

export const toySfx = new ToySfx();
