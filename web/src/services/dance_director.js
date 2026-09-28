/**
 * Dance director: makes the companion dance in time with a song.
 *
 * Every dance clip (a bundled/uploaded VRMA, or an MMD .vmd converted by
 * vmd_loader.js) is analysed for its MOTION BEATS: the moments the body
 * momentarily slows, i.e. local minima of the joints' mean angular speed,
 * Gaussian-smoothed (the motion-beat definition behind Shiratori et al.
 * 2004/2006 and the AIST++ beat-alignment metric; smoothing σ = 5 frames at
 * 60 fps there → 2.5 at our 30). Its period comes from the speed curve's
 * autocorrelation and its phase from where the minima fall on that grid.
 *
 * Playback then time-warps the clip onto the music (Kim, Park & Shin 2003:
 * motion beats as key times, matched to music beats) phrase by phrase: a
 * phrase plays from one of the clip's beats to the one `need` beats later
 * at a single steady rate, so its first and last steps land on the music.
 * Warping beat by beat instead played every detected beat gap into one
 * music beat, and the detected gaps are uneven (±8–70 % in the bundled
 * dances, measured), so the dance rushed and crawled from beat to beat.
 * The clip is played at the whole-number ratio of
 * motion beats per music beat that needs the least stretch; Shiratori 2006
 * keeps that stretch within ±10 %, and clips that fit inside it are
 * preferred.
 *
 * The song is cut into phrases on bar lines (4 bars, the length of most
 * pop phrases). Each phrase picks a clip by how loud that stretch of music
 * is (the beat energy from music_analysis.py or song_synth.py): the
 * calmest phrases get only the groove — a whole-body bounce on the beat and
 * a sway across the bar, laid over the idle — and louder ones the dances,
 * the more energetic the clip the louder the phrase. Clip changes cross-
 * fade over a beat. A dance made for this very song (an MMD motion linked
 * to it, with its offset) plays straight through instead, unwarped.
 */

const SAMPLE_FPS = 30;
const SMOOTH_SIGMA = 2.5;              // frames at 30 fps (σ = 5 at 60 fps)
const STRETCH_OK = 0.1;                // Shiratori 2006: s ∈ [0.9, 1.1]
const PHRASE_BARS = 4;
const CROSSFADE_BEATS = 1;
const MIN_MOTION_PERIOD = 0.25;        // s: motion beats faster than 240/min are jitter
const MAX_MOTION_PERIOD = 1.5;
const RECENT_PHRASES = 3;              // a clip rests this many phrases before it repeats (design)
const GROOVE_SHARE = 0.2;             // the song's quietest fifth of phrases only groove (design)

// Groove amplitudes (see setGrooveParams): design values until sourced.
const GROOVE = {
    bounceM: 0.012,        // hips down on each beat
    swayRad: 0.035,        // hips/spine roll across two beats
    nodRad: 0.06,          // head nod on the beat
    lag: 0.0,              // s: lowest point relative to the beat
};

function gaussSmooth(x, sigma) {
    const r = Math.ceil(sigma * 3);
    const k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); sum += v; }
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) {
            const idx = Math.min(x.length - 1, Math.max(0, i + j));
            acc += x[idx] * k[j + r];
        }
        out[i] = acc / sum;
    }
    return out;
}

/** Motion analysis of one clip → { period, phase, energy, duration }.
 *
 *  Each joint's angular speed is smoothed and its prominent local minima —
 *  the joint stopping — become pulses; summed over the body they form a
 *  "motion onset" curve whose autocorrelation shows the beat, the way an
 *  audio onset envelope does. Summing raw speeds first hides it (measured
 *  on an MMD dance: no beat peak at all, against a clean one from the
 *  pulses). The period is scored as a comb over one, two and four beats,
 *  then period and phase are fitted by least squares to every pulse, so a
 *  long dance doesn't drift off the grid. */
export function analyseClip(clip) {
    const n = Math.max(8, Math.floor(clip.duration * SAMPLE_FPS));
    const qTracks = clip.tracks.filter((t) => t.name.endsWith(".quaternion")
        && !/Thumb|Index|Middle|Ring|Little|Eye|Jaw|Toes/i.test(t.name));
    const dt = 1 / SAMPLE_FPS;
    const pulse = new Float32Array(n);
    let energy = 0;
    for (const tr of qTracks) {
        const it = tr.createInterpolant();
        const sp = new Float32Array(n);
        let px = 0, py = 0, pz = 0, pw = 1;
        for (let i = 0; i < n; i++) {
            const v = it.evaluate(i * dt);
            if (i > 0) {
                const dot = Math.min(1, Math.abs(px * v[0] + py * v[1] + pz * v[2] + pw * v[3]));
                sp[i] = (2 * Math.acos(dot)) / dt;
            }
            px = v[0]; py = v[1]; pz = v[2]; pw = v[3];
        }
        sp[0] = sp[1];
        const s = gaussSmooth(sp, 1.5);
        let m = 0;
        for (let i = 0; i < n; i++) m += s[i];
        m /= n;
        energy += m;
        if (m < 0.05) continue;             // a joint that barely moves carries no beat
        for (let i = 2; i < n - 2; i++) {
            if (!(s[i] < s[i - 1] && s[i] <= s[i + 1])) continue;
            let l = s[i], r = s[i];
            for (let k = 1; k <= 6 && i - k >= 0; k++) l = Math.max(l, s[i - k]);
            for (let k = 1; k <= 6 && i + k < n; k++) r = Math.max(r, s[i + k]);
            const prom = Math.min(l, r) - s[i];
            if (prom > 0.15 * m) pulse[i] += Math.min(1, prom / m);
        }
    }
    energy /= Math.max(1, qTracks.length);
    const ps = gaussSmooth(pulse, 1.0);
    let pm = 0;
    for (let i = 0; i < n; i++) pm += ps[i];
    pm /= n;
    const d = ps.map((v) => v - pm);
    let d0 = 0;
    for (let i = 0; i < n; i++) d0 += d[i] * d[i];
    const acAt = (lag) => {
        const L = Math.round(lag);
        if (L < 1 || L >= n - 4) return 0;
        let acc = 0;
        for (let i = 0; i + L < n; i++) acc += d[i] * d[i + L];
        return (acc / (d0 || 1)) * n / (n - L);
    };
    const lo = Math.round(MIN_MOTION_PERIOD * SAMPLE_FPS), hi = Math.round(MAX_MOTION_PERIOD * SAMPLE_FPS / 1.5);
    let best = lo, bestScore = -Infinity;
    for (let L = lo; L <= hi; L++) {
        const score = acAt(L) + 0.5 * acAt(2 * L) + 0.25 * acAt(4 * L);
        if (score > bestScore) { bestScore = score; best = L; }
    }
    // Sub-frame refinement: the peaks at 4, 8 and 16 beats pin the period far
    // tighter than one frame at the first peak can.
    const acFrac = (lag) => {
        const a = Math.floor(lag), f = lag - a;
        return acAt(a) * (1 - f) + acAt(a + 1) * f;
    };
    let fine = best, fineScore = -Infinity;
    for (let L = best - 1; L <= best + 1; L += 0.02) {
        let score = 0;
        for (const m of [1, 2, 4, 8, 16]) if (m * L < n / 2) score += acFrac(m * L);
        if (score > fineScore) { fineScore = score; fine = L; }
    }
    const beats = trackBeats(ps, fine).map((f) => f * dt);
    if (beats.length < 4) {
        const P = fine * dt;
        for (let t = 0; t < clip.duration; t += P) beats.push(t);
    }
    const period = median(diff(beats));
    return { beats, period, energy, duration: clip.duration };
}

/** Ellis 2007 dynamic-programming beat tracker on a (motion) onset curve,
 *  period in frames, librosa's tightness 100 → beat frames (sub-frame, by
 *  a parabola through each chosen peak). Like the audio tracker in
 *  server/music_analysis.py: the beats follow the dance's own timing
 *  instead of a fixed grid that would drift over a long dance. */
function trackBeats(onset, period) {
    const n = onset.length;
    let mean = 0;
    for (const v of onset) mean += v;
    mean /= n;
    let sd = 0;
    for (const v of onset) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / Math.max(1, n - 1)) || 1;
    const R = Math.ceil(period);
    const win = [];
    for (let k = -R; k <= R; k++) win.push(Math.exp(-0.5 * (k * 32 / period) ** 2));
    const local = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = -R; k <= R; k++) {
            const j = i + k;
            if (j >= 0 && j < n) acc += (onset[j] / sd) * win[k + R];
        }
        local[i] = acc;
    }
    const lo = Math.round(-2 * period), hi = -Math.round(period / 2);
    const cum = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    let maxLocal = 0;
    for (const v of local) maxLocal = Math.max(maxLocal, v);
    let started = false;
    for (let i = 0; i < n; i++) {
        let bestV = -Infinity, bestJ = -1;
        for (let off = lo; off <= hi; off++) {
            const j = i + off;
            if (j < 0) continue;
            const v = cum[j] - 100 * Math.log(-off / period) ** 2;
            if (v > bestV) { bestV = v; bestJ = j; }
        }
        if (bestJ < 0 || (!started && local[i] < 0.01 * maxLocal)) {
            cum[i] = local[i];
        } else {
            cum[i] = local[i] + bestV;
            back[i] = bestJ;
            started = true;
        }
    }
    const peaks = [];
    for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) peaks.push(i);
    if (!peaks.length) return [];
    const med = median(peaks.map((i) => cum[i]));
    const good = peaks.filter((i) => cum[i] >= 0.5 * med);
    let i = good.length ? good[good.length - 1] : peaks[peaks.length - 1];
    const out = [];
    while (i >= 0) { out.push(i); i = back[i]; }
    out.reverse();
    return out.map((f) => {
        if (f <= 0 || f >= n - 1) return f;
        const a = local[f - 1], b = local[f], c = local[f + 1];
        const den = a - 2 * b + c;
        return den < 0 ? f + 0.5 * (a - c) / den : f;
    });
}

/** Ratio of motion beats per music beat needing the least stretch. */
function bestRatio(period, musicBeat) {
    let best = null;
    for (const q of [0.5, 1, 2]) {
        const rate = (q * period) / musicBeat;
        const cost = Math.abs(Math.log(rate));
        if (!best || cost < best.cost) best = { q, rate, cost };
    }
    return best;
}

export class DanceDirector {
    /** renderer: the avatar renderer; THREE from renderer.libs. */
    constructor(renderer) {
        this.r = renderer;
        this.clips = [];          // { key, clip, info, actions: [A, B], intensity }
        this.schedule = [];       // phrases
        this.songDance = null;    // { clip, action, offset }
        this.grid = null;
        this.groove = { ...GROOVE };
        this.bodyWeight = 0;
        this.enabled = true;
    }

    setGrooveParams(p) { Object.assign(this.groove, p || {}); }

    /** Load and analyse every dance for the current VRM. entries:
     *  [{ key, url, kind: 'vrma'|'vmd', armAngle, songDance, offsetMs }] */
    async load(entries) {
        const { THREE, GLTFLoader, VRMAnimationLoaderPlugin, createVRMAnimationClip } = this.r.libs;
        const vrm = this.r.vrm;
        this.clips = [];
        this.songDance = null;
        for (const e of entries) {
            let clip = null;
            try {
                if (e.kind === "vmd") {
                    const { parseVMD, vmdToClip } = await import("./vmd_loader.js");
                    const buf = await (await fetch(e.url)).arrayBuffer();
                    clip = vmdToClip(THREE, parseVMD(buf), vrm, { armAngleDeg: e.armAngle ?? 30, name: e.key });
                } else {
                    const loader = new GLTFLoader();
                    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
                    const gltf = await loader.loadAsync(e.url);
                    const vrma = gltf.userData.vrmAnimations?.[0];
                    if (!vrma) continue;
                    clip = createVRMAnimationClip(vrma, vrm);
                    clip.name = e.key;
                    // Expression tracks would fight the singing mouth.
                    clip.tracks = clip.tracks.filter((t) => /\.(quaternion|position)$/.test(t.name));
                }
            } catch (err) {
                console.warn("[stage] dance failed to load", e.url, err);
                continue;
            }
            if (!clip || clip.duration < 1) continue;
            if (e.songDance) {
                this.songDance = { key: e.key, clip, offset: (e.offsetMs || 0) / 1000 };
                continue;
            }
            const info = analyseClip(clip);
            this.clips.push({ key: e.key, clip, info });
        }
        // Rank by how much they move: the loudest phrases get the liveliest.
        const sorted = [...this.clips].sort((a, b) => a.info.energy - b.info.energy);
        sorted.forEach((c, i) => { c.intensity = sorted.length > 1 ? i / (sorted.length - 1) : 1; });
        return this.clips.length + (this.songDance ? 1 : 0);
    }

    /** Lay the dances out over the song. grid: {beats, downbeats, energy}. */
    plan(grid, duration) {
        this.grid = grid;
        this.schedule = [];
        const beats = grid?.beats || [];
        // Beats per bar from the song's own bar grid (a 6/8 song has six),
        // so the groove's bar-long sway wraps on the bar line.
        const d = grid?.downbeats || [];
        this.beatsPerBar = (d.length > 1 && beats.filter((b) => b >= d[0] - 1e-3 && b < d[1] - 1e-3).length) || 4;
        if (beats.length < 4 || (!this.clips.length && !this.songDance)) return;
        const musicBeat = median(diff(beats));
        const bars = (grid.downbeats || []).length ? grid.downbeats : beats.filter((_, i) => i % 4 === 0);
        const beatIndex = (t) => { let k = 0; while (k + 1 < beats.length && beats[k + 1] <= t + 1e-3) k++; return k; };
        const energyAt = (a, b) => {
            const ka = beatIndex(a), kb = Math.max(ka + 1, beatIndex(b));
            const e = (grid.energy || []).slice(ka, kb);
            return e.length ? e.reduce((x, y) => x + y, 0) / e.length : 0.6;
        };
        const cursor = new Map();   // clip key → next motion beat index to continue from
        const recent = [];          // clips of the last few danced phrases
        // Phrases, ranked by loudness within this song: the quietest share
        // only grooves, the rest take a dance as lively as their rank.
        const spans = [];
        for (let i = 0; i < bars.length; i += PHRASE_BARS) {
            const t0 = bars[i];
            const t1 = i + PHRASE_BARS < bars.length ? bars[i + PHRASE_BARS] : duration;
            spans.push({ t0, t1, e: energyAt(t0, t1) });
        }
        const order = [...spans].sort((a, b) => a.e - b.e);
        spans.forEach((s) => { s.rank = spans.length > 1 ? order.indexOf(s) / (spans.length - 1) : 1; });
        for (const { t0, t1, e, rank } of spans) {
            let pick = null;
            if (rank >= GROOVE_SHARE && this.clips.length) {
                const target = (rank - GROOVE_SHARE) / (1 - GROOVE_SHARE);
                let bestCost = Infinity;
                for (const c of this.clips) {
                    // Prefer clips that fit the tempo within the ±10 % stretch.
                    const r = bestRatio(c.info.period, musicBeat);
                    const stretch = 2 * Math.max(0, Math.abs(Math.log(r.rate)) - Math.log(1 + STRETCH_OK));
                    // Variety: a clip used in the last few phrases waits its turn.
                    const ago = recent.lastIndexOf(c);
                    const repeat = ago < 0 ? 0 : 0.3 * (1 - (recent.length - 1 - ago) / RECENT_PHRASES);
                    const cost = Math.abs(c.intensity - target) + stretch + repeat;
                    if (cost < bestCost) { bestCost = cost; pick = c; }
                }
            }
            const k0 = beatIndex(t0), k1 = beatIndex(t1 - 1e-3) + 1;
            // The phrase's mean music beat: the clip plays at one rate across it.
            const beatLen = k1 < beats.length ? (beats[k1] - beats[k0]) / (k1 - k0) : musicBeat;
            const phrase = { t0, t1, k0, k1, beatLen, clip: pick, energy: e };
            if (pick) {
                const q = bestRatio(pick.info.period, musicBeat).q;   // motion beats per music beat
                const need = (k1 - k0) * q;
                const mb = pick.info.beats;
                // Skip the clip's first beats: clips often start from a rest pose.
                const first = Math.max(0, mb.findIndex((b) => b >= 0.4));
                const last = mb.length - 2;
                let j0 = cursor.get(pick.key) ?? first;
                if (j0 + need > last) j0 = first;
                if (j0 + need > last) {
                    // Clip shorter than the phrase: loop it in whole bars,
                    // or whole beats when not even a bar fits.
                    const span = last - first;
                    phrase.loopBeats = Math.floor(span / (4 * q)) * 4 * q || Math.max(q, Math.floor(span / q) * q);
                }
                phrase.j0 = j0;
                phrase.q = q;
                phrase.need = need;
                cursor.set(pick.key, j0 + need);
            }
            this.schedule.push(phrase);
            if (pick) {
                recent.push(pick);
                if (recent.length > RECENT_PHRASES) recent.shift();
            }
        }
    }

    /** Called by the renderer before the mixer runs. musicTime in s. */
    ensureActions() {
        const { THREE } = this.r.libs;
        const mixer = this.r.mixer;
        const make = (clip) => {
            const a = mixer.clipAction(clip);
            a.setLoop(THREE.LoopOnce, 1);
            a.clampWhenFinished = true;
            a.enabled = true;
            a.play();
            a.paused = true;
            a.setEffectiveWeight(0);
            return a;
        };
        for (const c of this.clips) {
            if (!c.decks) c.decks = [make(c.clip), make(c.clip.clone())];
        }
        if (this.songDance && !this.songDance.action) this.songDance.action = make(this.songDance.clip);
    }

    /** Motion beats into a phrase at music time t, at the phrase's steady
     *  rate (not yet wrapped for a looped clip). */
    _beatPos(ph, t) {
        return ((t - this.grid.beats[ph.k0]) / ph.beatLen) * ph.q;
    }

    /** Motion beats into a phrase that is fading out past its end: a looped
     *  clip doesn't wrap again, the pass under way carries on. */
    _tailBeat(ph, t) {
        const b = this._beatPos(ph, t);
        if (!ph.loopBeats) return b;
        const end = this._beatPos(ph, ph.t1 - 1e-3);
        return b - Math.floor(end / ph.loopBeats) * ph.loopBeats;
    }

    /** Clip time at a phrase's motion-beat position (default: music time t,
     *  wrapped for a looped clip). */
    _clipTime(ph, t, beat = null) {
        if (beat == null) {
            beat = this._beatPos(ph, t);
            if (ph.loopBeats) beat %= ph.loopBeats;
        }
        // One rate across the phrase's (or the loop pass's) span of the
        // clip's beats: its mean beat length there.
        const mb = ph.clip.info.beats;
        const span = Math.max(1, Math.floor(ph.loopBeats || ph.need));
        const a = mb[ph.j0], b = mb[Math.min(mb.length - 1, ph.j0 + span)];
        const ct = a + beat * ((b - a) / span);
        return Math.min(ph.clip.info.duration - 1e-3, Math.max(0, ct));
    }

    /** Per frame: set clip times and weights. Returns the body weight the
     *  dances hold (0 = only the groove, over the idle). normalize: nothing
     *  else in the mixer holds the body, so the dances' weights must sum to
     *  one (the renderer blends them over the idle by bodyWeight itself);
     *  below one, three.js fills the rest with each bone's stale
     *  bind-time value. */
    update(t, { normalize = false } = {}) {
        if (!this.enabled) { this._silence(); return 0; }
        if (this.songDance?.action) {
            const a = this.songDance.action;
            const ct = t - this.songDance.offset;
            const inside = ct >= 0 && ct <= this.songDance.clip.duration;
            a.time = Math.min(Math.max(ct, 0), this.songDance.clip.duration - 1e-3);
            // fade in over the first beat, out at the end
            const w = Math.max(0, inside ? Math.min(1, ct / 0.5, (this.songDance.clip.duration - ct) / 0.5) : 0);
            a.setEffectiveWeight(normalize && w > 0 ? 1 : w);
            this.bodyWeight = w;
            return this.bodyWeight;
        }
        const idx = this.schedule.findIndex((p) => t >= p.t0 && t < p.t1);
        let total = 0;
        const weights = new Map();
        const assign = (ph, deck, w, beat = null) => {
            if (!ph?.clip || w <= 0) return;
            const a = ph.clip.decks[deck];
            a.time = this._clipTime(ph, t, beat);
            weights.set(a, (weights.get(a) || 0) + w);
        };
        if (idx >= 0) {
            const ph = this.schedule[idx];
            const beat = median(diff(this.grid.beats.slice(ph.k0, ph.k0 + 5))) || 0.5;
            const fade = CROSSFADE_BEATS * beat;
            const prev = this.schedule[idx - 1];
            const into = Math.min(1, (t - ph.t0) / fade);
            const deck = idx % 2;
            if (into < 1) {
                // Crossfade from the previous phrase (on the other deck, so a
                // clip can crossfade into a later part of itself), or in
                // from the groove when the song's first phrase dances.
                assign(prev, 1 - deck, 1 - into, prev?.clip ? this._tailBeat(prev, t) : null);
                assign(ph, deck, into);
                total = (prev?.clip ? 1 - into : 0) + (ph.clip ? into : 0);
            } else if (ph.loopBeats) {
                // A looped clip crossfades over its seam as well: the pass
                // that just ended plays on over the other deck (free once
                // the phrase's own crossfade is over) as the next fades in.
                const b = this._beatPos(ph, t);
                const inLoop = b % ph.loopBeats;
                const seam = Math.min(1, inLoop / (CROSSFADE_BEATS * ph.q));
                if (b >= ph.loopBeats && seam < 1) {
                    assign(ph, 1 - deck, 1 - seam, inLoop + ph.loopBeats);
                    assign(ph, deck, seam, inLoop);
                } else {
                    assign(ph, deck, 1, inLoop);
                }
                total = 1;
            } else {
                assign(ph, deck, 1);
                total = ph.clip ? 1 : 0;
            }
        } else if (this.schedule.length && t >= this.schedule[this.schedule.length - 1].t1) {
            // Past the song's end: the last phrase dances on until the stage
            // stops, and the renderer eases out of it the way a gesture ends
            // (dropping it here snapped the body to the idle mid-move).
            const last = this.schedule.length - 1;
            const ph = this.schedule[last];
            assign(ph, last % 2, 1, ph.clip ? this._tailBeat(ph, t) : null);
            total = ph.clip ? 1 : 0;
        }
        const scale = normalize && total > 0 ? 1 / total : 1;
        for (const c of this.clips) {
            for (const a of c.decks || []) a.setEffectiveWeight((weights.get(a) || 0) * scale);
        }
        this.bodyWeight = total;
        return total;
    }

    _silence() {
        for (const c of this.clips) for (const a of c.decks || []) a.setEffectiveWeight(0);
        this.songDance?.action?.setEffectiveWeight(0);
        this.bodyWeight = 0;
    }

    /** Beat phase for the groove: { beatPhase 0..1, barPhase 0..1 }. */
    phaseAt(t) {
        const beats = this.grid?.beats;
        if (!beats?.length) return null;
        let k = 0;
        while (k + 1 < beats.length && beats[k + 1] <= t) k++;
        const b0 = beats[k], b1 = beats[k + 1] ?? b0 + 0.5;
        const beatPhase = Math.min(1, Math.max(0, (t - b0) / (b1 - b0)));
        const downs = this.grid.downbeats || [];
        let bar = 0;
        while (bar + 1 < downs.length && downs[bar + 1] <= t) bar++;
        const beatsPerBar = this.beatsPerBar || 4;
        const inBar = downs.length ? Math.max(0, beats.filter((b) => b >= downs[bar] - 1e-3 && b <= t).length - 1) : k % beatsPerBar;
        return { beatPhase, beatInBar: inBar, beatsPerBar, beatIndex: k, before: t < b0 };
    }

    /** Remove the actions from the mixer. */
    dispose() {
        const mixer = this.r.mixer;
        const drop = (a) => {
            if (!a) return;
            try {
                a.stop();
                mixer?.uncacheAction(a.getClip(), a.getRoot());
                mixer?.uncacheClip(a.getClip());
            } catch (e) { /* gone */ }
        };
        for (const c of this.clips) for (const a of c.decks || []) drop(a);
        drop(this.songDance?.action);
        this.clips = [];
        this.songDance = null;
        this.schedule = [];
    }
}

function diff(a) {
    const out = [];
    for (let i = 1; i < a.length; i++) out.push(a[i] - a[i - 1]);
    return out;
}

function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}
