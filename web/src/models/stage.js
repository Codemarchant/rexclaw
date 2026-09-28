/**
 * The karaoke stage: plays a song, and the companion performs it.
 *
 *   audio     the backing and the companion's sung vocal stem (server
 *             singing.py) start together on one AudioContext; the song
 *             clock is what the listener is hearing now (output timestamp)
 *   singing   the mouth follows the stem: its level (a 50 fps envelope the
 *             server measured) opens it, the vowel of the syllable being
 *             sung (from the lyric's spelling) shapes it, with the
 *             lipsync's own attack/release smoothing
 *   dancing   dance_director.js beat-warps the dances onto the music; the
 *             renderer's groove layer bounces and sways where none plays
 *   camera    cuts on bar lines between close, waist and wide shots
 *   you       the mic's pitch (McLeod pitch method) is scored against the
 *             notes the way UltraStar Deluxe scores: octave-independent,
 *             within ±2/±1/0 semitones on easy/medium/hard, 10 000 points
 *             of which 1 000 are line bonuses and golden notes count
 *             double; freestyle notes score nothing, rap notes any voice
 *
 * Modes: "companion" (they sing, you can sing along), "solo" (you sing,
 * they dance) and "duet" (a duet chart's second part — or every other line
 * — is yours; their voice drops out there).
 */
import { reactive } from "../lib/reactive";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { DanceDirector } from "../services/dance_director";
import { MASCOT_MODE } from "../lib/ui_state";

const LIP_ATTACK_RATE = 50;         // lipsync_service.js (airi's rates)
const LIP_RELEASE_RATE = 30;
const VOWELS = ["aa", "ih", "ou", "ee", "oh"];
// Fallback when the server's list (assets/vrma/dances) can't be fetched.
const BUILTIN_DANCES = [
    { key: "builtin:dance", url: "/assets/vrma/Dance.vrma", kind: "vrma" },
    { key: "builtin:belly", url: "/assets/vrma/BellyDance.vrma", kind: "vrma" },
];

// Camera: live music TV averages ~50 cuts in a song of just under three
// minutes (~3.4 s a shot, Fuji TV switcher report); switchers aim for the
// head of the bar and land ~0.16 s before it. Singer close-ups are 35-39 %
// of shots in the most-viewed music videos (Sedeño et al. 2016).
const CUT_SECONDS = 3.4;
const CUT_EARLY = 0.16;
const SHOT_WEIGHTS = { face: 0.35, waist: 0.30, full: 0.35 };
const DRIFT = 0.03;                  // rad/s slow orbit within a shot (design)
const LONG_NOTE = 1.2;               // s: a held note gets the close-up (design)

// UltraStar Deluxe scoring (src/base/UNote.pas): tolerance 2 − difficulty
// semitones, 10 000 points, 1 000 of them line bonus. Like USDX, a note is
// scored beat by beat, each beat whole when the voice is on the note in it,
// so consonants, scoops and vibrato don't eat into a note sung in tune.
const TOLERANCE = { easy: 2, medium: 1, hard: 0 };
const MAX_SCORE = 10000;
const LINE_BONUS = 1000;
const FACTOR = { f: 0, n: 1, g: 2, r: 1, rg: 2 };

// McLeod pitch method: key-maximum cut-off and the clarity a pitch needs
// (pitchy's default, 0.9).
const MPM_K = 0.9;
const MPM_CLARITY = 0.9;
// Design: below this (−50 dBFS) the mic is silence. Kept low so a quiet mic
// still scores; the clarity check above is what rejects noise.
const MIC_MIN_RMS = 0.003;

class Stage {
    constructor() {
        this.state = reactive({
            open: false,
            loading: false,
            status: "idle",          // idle | loading | ready | playing | paused | ended
            song: null,              // stage payload (see /api/songs/stage)
            mode: "companion",
            // mic: score the user's singing (You sing and Duet only)
            options: { dance: true, camera: true, lane: true, mic: true, difficulty: "medium", vocalDb: 0 },
            score: null,             // { total, notes, lines } while scoring
            render: null,            // { job, stage, done, total, error }
            error: null,
            duration: 0,
            lineIndex: -1,
        });
        this.renderer = null;
        this.ctx = null;
        this.director = null;
        this._t0 = 0;
        this._offset = 0;
        this._vowels = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        this._pitchTrail = [];
        this._raf = 0;
    }

    attach(renderer) { this.renderer = renderer; }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    /** who: { agentId } (the server picks that companion's voice profile
     *  or xAI voice) or a plain voice id. */
    async load(songId, who) {
        this.stop();
        this.state.loading = true;
        this.state.error = null;
        this.state.status = "loading";
        try {
            const params = typeof who === "object" && who ? { id: songId, agent_id: who.agentId } : { id: songId, voice: who };
            const song = await rpc("/api/songs/stage", params);
            this.state.song = song;
            this.state.duration = song.duration_seconds || song.analysis?.duration || 0;
            this.state.status = "ready";
            this.state.lineIndex = -1;
            return song;
        } catch (e) {
            this.state.error = e.message;
            this.state.status = "idle";
            return null;
        } finally {
            this.state.loading = false;
        }
    }

    /** Teach the companion's voice the song (server render job), polling
     *  its progress; resolves when done. */
    async teach(songId, agentId) {
        const { job } = await rpc("/api/songs/render", { id: songId, agent_id: agentId });
        this.state.render = { job, stage: "voice", done: 0, total: 0, error: null };
        for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            let st;
            try {
                st = await rpc("/api/songs/render/status", { job });
            } catch (e) {
                this.state.render = { job, error: e.message };
                throw e;
            }
            this.state.render = { job, stage: st.stage, done: st.done, total: st.total, error: st.error };
            if (st.state === "done") { this.state.render = null; return st.result; }
            if (st.state === "error") throw new Error(st.error || _t("Singing failed."));
        }
    }

    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    async play({ agentName = "", call = null } = {}) {
        const song = this.state.song;
        const r = this.renderer;
        if (!song || !r?.vrm) return;
        const mode = this.state.mode;
        const wantsVocal = mode !== "solo";
        if (wantsVocal && !song.vocal) {
            this.state.error = _t("They haven't learned this song yet.");
            return;
        }
        this.state.status = "loading";
        this._call = call;
        this._agentName = agentName;
        try {
            this.ctx ||= new AudioContext({ latencyHint: "playback" });
            if (this.ctx.state === "suspended") await this.ctx.resume();
            const decode = async (url) => this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
            const [backing, vocal] = await Promise.all([
                decode(song.backing_url),
                wantsVocal ? decode(song.vocal.url) : Promise.resolve(null),
            ]);
            this._buffers = { backing, vocal };
            // Dances for this avatar.
            this.director?.dispose();
            this.director = new DanceDirector(r);
            if (this.state.options.dance) {
                const own = await rpc("/api/songs/bootstrap", {}).catch(() => ({ dances: [] }));
                const entries = [...(own.builtin_dances || BUILTIN_DANCES)];
                for (const d of own.dances || []) {
                    if (d.song_id && d.song_id !== song.id) continue;
                    entries.push({ key: `dance:${d.id}`, url: d.file_path, kind: d.kind, armAngle: d.arm_angle,
                        songDance: d.song_id === song.id, offsetMs: d.offset_ms });
                }
                await this.director.load(entries);
                this.director.plan(this._grid(), this.state.duration);
            } else {
                this.director.enabled = false;
            }
            this._vrm = r.vrm;
            this._prepareScoring();
            this._planCamera();
            if (this._scoring) await this._startMic();
            if (call?.state?.status === "live" && !call.state.muted) {
                this._unmuteAfter = true;
                await call.setMuted(true);
            }
            this._start(0);
        } catch (e) {
            console.error("[stage] play failed", e);
            this.state.error = e.message || String(e);
            this.state.status = "ready";
        }
    }

    _grid() {
        const song = this.state.song;
        const a = song.analysis || {};
        return { beats: a.beats || [], downbeats: a.downbeats || [], energy: a.energy || [] };
    }

    _start(offset) {
        const ctx = this.ctx;
        const at = ctx.currentTime + 0.12;
        this._stopSources();
        const mk = (buf, gainDb) => {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const g = ctx.createGain();
            g.gain.value = Math.pow(10, gainDb / 20);
            src.connect(g).connect(ctx.destination);
            src.start(at, offset);
            return { src, gain: g };
        };
        this._backing = mk(this._buffers.backing, 0);
        this._vocal = this._buffers.vocal ? mk(this._buffers.vocal, this.state.options.vocalDb) : null;
        if (this._vocal && this.state.mode === "duet") this._automateDuet(at, offset);
        this._t0 = at;
        this._offset = offset;
        const r = this.renderer;
        const director = this.director;
        const self = this;
        director.ensureActions();
        r.beginPerformance({
            get bodyWeight() { return director.bodyWeight; },
            // The desktop mascot's window is framed around the avatar: dances
            // that travel (BellyDance's hips cover a metre) dance on the spot.
            stayInPlace: MASCOT_MODE,
            prepare(delta, opts) { self._frame(delta, opts); },
            groove() { return self._groove(); },
            dispose() { director.dispose(); },
        });
        r.setEmotion?.("happy", { explicit: false });
        this._nextCut = 0;
        this.state.status = "playing";
        this.state.score = this._scoring ? { total: 0, notes: 0, lines: 0 } : null;
    }

    /** Where the listener is in the song, in seconds. */
    now() {
        if (!this.ctx) return 0;
        let heard = this.ctx.currentTime;
        try {
            const ts = this.ctx.getOutputTimestamp?.();
            if (ts && ts.contextTime > 0) {
                heard = ts.contextTime;
                // The audio clock only moves once per audio callback (~10 ms):
                // measured in Electron, 16 % of frames saw it unchanged and the
                // next one jump double, so the dance held a frame and skipped
                // one. Carried on by the page clock since that timestamp, no
                // frame is frozen and it stays within 0.1 ms of the audio.
                if (this.ctx.state === "running" && ts.performanceTime > 0) {
                    heard += Math.max(0, (performance.now() - ts.performanceTime) / 1000);
                }
            }
        } catch (e) { /* older engines */ }
        return this._offset + Math.max(0, heard - this._t0);
    }

    pause() {
        if (this.state.status !== "playing") return;
        this.ctx?.suspend();
        this.state.status = "paused";
    }

    resume() {
        if (this.state.status !== "paused") return;
        this.ctx?.resume();
        this.state.status = "playing";
    }

    /** finished: the song played to the end. byUser: the user stopped it
     *  (a Stop button) — in a call the companion hears about either. */
    stop({ finished = false, byUser = false } = {}) {
        const cut = byUser && (this.state.status === "playing" || this.state.status === "paused");
        if (this.state.status === "playing" || this.state.status === "paused") {
            if (this.ctx?.state === "suspended") this.ctx.resume();
        }
        this._stopSources();
        this._stopMic();
        const wasPerforming = this.renderer?.isPerforming?.();
        this.renderer?.endPerformance?.();
        if (wasPerforming) this.renderer?.setEmotion?.("neutral", { explicit: false });
        this.renderer?.setVowels?.({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
        this.director = null;
        if (this._unmuteAfter && this._call) {
            this._unmuteAfter = false;
            this._call.setMuted(false);
        }
        if ((finished || cut) && this._call?.state?.status === "live") this._tellCompanion({ cut });
        this._call = null;
        if (this.state.status !== "idle" && this.state.status !== "loading") {
            this.state.status = finished ? "ended" : (this.state.song ? "ready" : "idle");
        }
        // The closing card (title, score) stays up for a few seconds.
        clearTimeout(this._endTimer);
        if (finished) {
            this._endTimer = setTimeout(() => {
                if (this.state.status === "ended") this.state.status = "ready";
            }, 8000);
        }
    }

    _stopSources() {
        for (const s of [this._backing, this._vocal]) {
            try { s?.src.stop(); } catch (e) { /* not started */ }
        }
        this._backing = this._vocal = null;
    }

    _tellCompanion({ cut = false } = {}) {
        const song = this.state.song;
        const mode = this.state.mode;
        const score = this.state.score;
        if (cut) {
            const text = `[System] (stage) The user stopped "${song.title}" partway through. Carry on the conversation naturally.`;
            try { this._call.sendContextEvent(text); } catch (e) { /* call gone */ }
            return;
        }
        const who = mode === "solo" ? "The user just sang" : mode === "duet" ? "You and the user just sang a duet of" : "You just sang";
        let text = `[System] (stage) ${who} "${song.title}" on the karaoke stage`;
        text += mode === "solo" ? ", with you dancing along." : " (in your own voice, dancing along).";
        if (score && mode !== "companion") text += ` The user's score: ${Math.round(score.total)} of 10000.`;
        text += " React naturally, in a line or two.";
        try { this._call.sendContextEvent(text); } catch (e) { /* call gone */ }
    }

    // ------------------------------------------------------------------
    // Per frame (called by the renderer before its mixer)
    // ------------------------------------------------------------------

    _frame(delta, opts) {
        const r = this.renderer;
        if (this.state.status !== "playing" && this.state.status !== "paused") return;
        if (r.vrm !== this._vrm) {           // avatar swapped mid-song
            queueMicrotask(() => this.stop());
            return;
        }
        const t = this.now();
        if (t >= this.state.duration + 0.5) {
            queueMicrotask(() => this.stop({ finished: true }));
            return;
        }
        this.director?.update(t, opts);
        this._mouth(t, delta);
        this._camera(t);
        if (this._mic) this._listen(t);
        const li = this._lineAt(t);
        if (li !== this.state.lineIndex) this.state.lineIndex = li;
    }

    _groove() {
        if (!this.director) return null;
        const p = this.director.phaseAt(this.now());
        if (!p || p.before) return null;
        return { beatPhase: p.beatPhase, beatInBar: p.beatInBar, beatsPerBar: p.beatsPerBar, amount: 1 };
    }

    _lineAt(t) {
        const lines = this.state.song?.chart?.lines || [];
        let li = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].start - 1.0 <= t) li = i;
            else break;
        }
        return li;
    }

    _companionSinging(t) {
        if (!this._vocal) return false;
        if (this.state.mode !== "duet") return true;
        const line = this._lineRaw(t);
        return !line || !this._isUserLine(line);
    }

    _lineRaw(t) {
        const lines = this.state.song?.chart?.lines || [];
        for (const ln of lines) if (t >= ln.start - 0.3 && t <= ln.end + 0.3) return ln;
        return null;
    }

    _mouth(t, delta) {
        const r = this.renderer;
        const timing = this.state.song?.vocal?.timing;
        const target = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
        if (timing && this._companionSinging(t)) {
            const env = timing.env || [];
            const fps = timing.env_fps || 50;
            const level = (env[Math.floor(t * fps)] || 0) / 255;
            const syl = this._syllableAt(timing.syllables, t);
            if (level > 0.05) {
                const shape = syl?.inVowel ? syl.v : (syl?.v || "aa");
                target[shape] = Math.min(1, level * (syl?.inVowel ? 1.0 : 0.5));
            }
        }
        const up = 1 - Math.exp(-LIP_ATTACK_RATE * delta);
        const down = 1 - Math.exp(-LIP_RELEASE_RATE * delta);
        for (const v of VOWELS) {
            const cur = this._vowels[v];
            this._vowels[v] = cur + (target[v] - cur) * (target[v] > cur ? up : down);
        }
        r.setVowels?.({ ...this._vowels });
    }

    _syllableAt(syls, t) {
        if (!syls?.length) return null;
        let lo = 0, hi = syls.length - 1, k = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (syls[mid].t0 <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (k < 0) return { v: syls[0].v, inVowel: false };
        const s = syls[k];
        return { v: s.v, inVowel: t < s.t1 };
    }

    // ------------------------------------------------------------------
    // Camera
    // ------------------------------------------------------------------

    _planCamera() {
        this._cuts = [];
        // No camera cuts on the desktop mascot: its window frames the avatar.
        if (!this.state.options.camera || MASCOT_MODE) return;
        const grid = this._grid();
        const bars = grid.downbeats.length ? grid.downbeats : grid.beats.filter((_, i) => i % 4 === 0);
        if (bars.length < 2) return;
        const barLen = bars[1] - bars[0];
        const per = Math.max(1, Math.round(CUT_SECONDS / barLen));
        const lines = this.state.song.chart.lines;
        const notes = lines.flatMap((ln) => ln.notes);
        let last = null;
        this._cuts.push({ t: 0, shot: "full", side: 1 });
        last = "full";
        let i = per;
        while (i < bars.length) {
            const t = bars[i] - CUT_EARLY;
            const until = bars[Math.min(bars.length - 1, i + per)] ?? t + CUT_SECONDS;
            const sung = notes.filter((n) => n.t >= t && n.t < until);
            const held = sung.some((n) => n.d >= LONG_NOTE);
            let shot;
            if (!sung.length) shot = "full";              // instrumental: show the dance
            else if (held && last !== "face") shot = "face";
            else {
                const pool = Object.entries(SHOT_WEIGHTS).filter(([s]) => s !== last);
                let roll = Math.random() * pool.reduce((a, [, w]) => a + w, 0);
                shot = (pool.find(([, w]) => (roll -= w) <= 0) || pool[0])[0];
            }
            if (shot === last && shot === "full") { i += per; continue; }
            this._cuts.push({ t, shot, side: Math.random() < 0.5 ? -1 : 1 });
            last = shot;
            // Vary the rhythm: sometimes a bar more or less (never below one).
            i += Math.max(1, per + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0));
        }
    }

    _camera(t) {
        if (!this._cuts?.length) return;
        while (this._nextCut < this._cuts.length && this._cuts[this._nextCut].t <= t) {
            const c = this._cuts[this._nextCut++];
            this.renderer.stageCut?.(c.shot, { side: c.side, drift: DRIFT });
        }
    }

    // ------------------------------------------------------------------
    // Duet
    // ------------------------------------------------------------------

    _isUserLine(line) {
        const chart = this.state.song.chart;
        if (chart.duet) return line.singer === 2;
        return chart.lines.indexOf(line) % 2 === 1;
    }

    /** The companion's voice drops out on the user's lines. */
    _automateDuet(at, offset) {
        const g = this._vocal.gain.gain;
        const on = Math.pow(10, this.state.options.vocalDb / 20);
        g.cancelScheduledValues(0);
        g.setValueAtTime(on, at);
        for (const ln of this.state.song.chart.lines) {
            if (!this._isUserLine(ln)) continue;
            const a = at + Math.max(0, ln.start - 0.25 - offset);
            const b = at + Math.max(0, ln.end + 0.3 - offset);
            if (b <= at) continue;
            g.setTargetAtTime(0, a, 0.05);
            g.setTargetAtTime(on, b, 0.05);
        }
    }

    // ------------------------------------------------------------------
    // Mic + scoring
    // ------------------------------------------------------------------

    _scoredNote(n, line) {
        if (this.state.mode === "solo") return true;
        return this._isUserLine(line);
    }

    _prepareScoring() {
        const mode = this.state.mode;
        this._scoring = mode !== "companion" && this.state.options.mic;
        if (!this._scoring) return;
        const chart = this.state.song.chart;
        const quarter = chart.bpm ? 60 / (chart.bpm * 4) : 0.125;
        let total = 0;
        const lines = [];
        for (const ln of chart.lines) {
            let max = 0;
            const notes = [];
            for (const n of ln.notes) {
                if (!this._scoredNote(n, ln)) continue;
                const f = FACTOR[n.k] ?? 1;
                if (!f) continue;
                max += n.d * f;
                notes.push({ n, f, hit: 0, beats: new Uint8Array(Math.max(1, Math.round(n.d / quarter))) });
            }
            if (!notes.length) continue;
            total += max;
            // USDX forgives two (quarter-)beats per line before the bonus drops.
            lines.push({ ln, notes, max, hit: 0, forgive: 2 * quarter });
        }
        this._score = { total, lines, last: 0 };
    }

    async _startMic() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
            });
            const src = this.ctx.createMediaStreamSource(stream);
            const an = this.ctx.createAnalyser();
            an.fftSize = 2048;
            src.connect(an);
            // What the analyser holds was sung this long before the song
            // time the listener hears now: the mic's input latency (as the
            // browser reports it) plus half the analysis window.
            const latency = stream.getAudioTracks()[0]?.getSettings?.().latency || 0;
            const delay = latency + an.fftSize / 2 / this.ctx.sampleRate;
            this._mic = { stream, src, an, buf: new Float32Array(an.fftSize), lastAt: 0, delay };
        } catch (e) {
            notification.add(_t("Microphone unavailable, so your singing is not scored."), { type: "warning" });
            this._mic = null;
        }
    }

    _stopMic() {
        if (!this._mic) return;
        try { this._mic.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* */ }
        try { this._mic.src.disconnect(); } catch (e) { /* */ }
        this._mic = null;
    }

    _listen(now) {
        const m = this._mic;
        if (m.lastAt && now - m.lastAt < 0.03 && now >= m.lastAt) return;   // ~30 detections a second
        m.lastAt = now;
        const t = now - (m.delay || 0);     // when the analysed voice was sung
        m.an.getFloatTimeDomainData(m.buf);
        const midi = detectPitch(m.buf, this.ctx.sampleRate);
        const note = this._noteAt(t);
        let hit = false;
        if (midi != null && note) {
            // Octave-independent: move the sung tone within ±6 of the target.
            let sung = Math.round(midi);
            while (sung - note.n.p > 6) sung -= 12;
            while (note.n.p - sung > 6) sung += 12;
            const tol = TOLERANCE[this.state.options.difficulty] ?? 1;
            hit = note.n.k === "r" || note.n.k === "rg" || Math.abs(note.n.p - sung) <= tol;
            const beats = note.s.beats;
            const k = Math.min(beats.length - 1, Math.floor(((t - note.n.t) / note.n.d) * beats.length));
            if (hit && !beats[k]) {
                beats[k] = 1;
                const pts = (note.n.d / beats.length) * note.s.f;
                note.s.hit += pts;
                note.line.hit += pts;
            }
        }
        this._pitchTrail.push({ t, midi, hit, target: note?.n.p ?? null });
        while (this._pitchTrail.length && this._pitchTrail[0].t < t - 2) this._pitchTrail.shift();
        if (t - this._score.last > 0.25) {
            this._score.last = t;
            this.state.score = this._totals(t);
        }
    }

    _noteAt(t) {
        for (const line of this._score?.lines || []) {
            if (t < line.ln.start - 0.05 || t > line.ln.end + 0.05) continue;
            for (const s of line.notes) {
                if (t >= s.n.t && t < s.n.t + s.n.d) return { n: s.n, s, line };
            }
        }
        return null;
    }

    _totals(t) {
        const sc = this._score;
        if (!sc || !sc.total) return { total: 0, notes: 0, lines: 0 };
        let hit = 0, bonus = 0;
        for (const line of sc.lines) {
            hit += line.hit;
            if (line.ln.end < t) {
                const perfection = Math.min(1, Math.max(0, line.hit / Math.max(1e-3, line.max - line.forgive)));
                bonus += (LINE_BONUS / sc.lines.length) * perfection;
            }
        }
        const notes = (MAX_SCORE - LINE_BONUS) * Math.min(1, hit / sc.total);
        return { total: notes + bonus, notes, lines: bonus };
    }

    /** For the overlay: the last two seconds of the user's pitch. */
    pitchTrail() { return this._pitchTrail; }
}

/** McLeod pitch method (McLeod & Wyvill 2005, "A smarter way to find
 *  pitch"): normalised square difference function, first key maximum above
 *  K × the highest, parabolic interpolation. → MIDI note or null. */
export function detectPitch(buf, sampleRate) {
    const n = buf.length;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < MIC_MIN_RMS) return null;
    const maxLag = Math.min(n - 1, Math.floor(sampleRate / 65));     // down to C2
    const minLag = Math.floor(sampleRate / 1100);
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = 0; tau <= maxLag; tau++) {
        let acf = 0, m = 0;
        for (let i = 0; i + tau < n; i++) {
            const a = buf[i], b = buf[i + tau];
            acf += a * b;
            m += a * a + b * b;
        }
        nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }
    // Key maxima: the highest point between each pair of positive zero crossings.
    const peaks = [];
    let pos = false, best = -1;
    for (let tau = 1; tau <= maxLag; tau++) {
        if (nsdf[tau] > 0 && nsdf[tau - 1] <= 0) { pos = true; best = tau; }
        else if (nsdf[tau] <= 0 && nsdf[tau - 1] > 0) { if (pos && best >= minLag) peaks.push(best); pos = false; }
        if (pos && nsdf[tau] > nsdf[best]) best = tau;
    }
    if (!peaks.length) return null;
    let highest = 0;
    for (const p of peaks) highest = Math.max(highest, nsdf[p]);
    const pick = peaks.find((p) => nsdf[p] >= MPM_K * highest);
    if (pick == null || nsdf[pick] < MPM_CLARITY) return null;
    const a = nsdf[pick - 1], b = nsdf[pick], c = nsdf[pick + 1] ?? b;
    const den = a - 2 * b + c;
    const tau = den < 0 ? pick + 0.5 * (a - c) / den : pick;
    const hz = sampleRate / tau;
    return 69 + 12 * Math.log2(hz / 440);
}

export const stage = new Stage();
if (typeof window !== "undefined") window.__stage = stage;
