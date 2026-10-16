/**
 * Tool motions — what the companion's body does while one of its slow
 * voice tools runs. Texting another companion pulls out a phone and taps
 * away, a new background is conjured as an orb of light between the
 * hands and flung open when it lands, a picture is painted on the air
 * with palette and brush, and so on (assets/vrma/tool_motions/manifest.json,
 * built by tools/motion/tool_motions/build_tool_motions.py).
 *
 * Each motion is three clips: `in` (into the pose; a prop appears), `loop`
 * (held for as long as the call runs) and `out` (back to the idle; the
 * prop goes). They play through the same playGesture path as the
 * companion's own gestures, so anything deliberate — a play_gesture, an
 * emotion's clip, a manual trigger, walking, the karaoke stage — simply
 * takes the body, and the motion stands down (its props go with it).
 *
 * Only when ONE slow tool is called in a reply: two different ones in the
 * same reply leave the body alone, and while a motion plays, a slow tool
 * from a later reply doesn't replace it. The same tool called again joins
 * the running motion, which then lasts until the last of its calls is
 * answered. A call answered within START_DELAY_MS (an error, a quick
 * refusal) plays nothing.
 *
 * Global switch: config.tool_animations, one of the motion settings
 * (Settings → Motion and the mascot window), read through the motion
 * director like the others.
 */

import { UPPER_BODY_GESTURE_URLS } from "./avatar_catalog";

const BASE_URL = "/assets/vrma/tool_motions/";
// Parallel calls in one reply land within a few hundred milliseconds of
// each other, and an instant answer is an error rather than a wait: a
// short delay keeps both from flashing a motion on and off.
const START_DELAY_MS = 400;
// The loop (and the outro) start this far before the clip ahead of them
// ends: their crossfade covers the seam, and the intro never reaches its
// last frame, whose release would hand the body back to the idle first.
const SEAM_LEAD_S = 0.2;
const WATCH_MS = 200;          // how often a running motion checks it still owns the body
const BUSY_RETRY_MS = 250;     // a deliberate gesture is playing: try again this soon

let manifestPromise = null;

/** The manifest, keyed by the tool each motion is for. Loaded once. */
function loadManifest() {
    manifestPromise ||= fetch(`${BASE_URL}manifest.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
            const byTool = new Map();
            for (const [id, motion] of Object.entries(m?.motions || {})) {
                const clip = (part) => ({ url: `${BASE_URL}${motion[part].file}`, duration: motion[part].duration });
                const entry = {
                    id, tool: motion.tool, in: clip("in"), loop: clip("loop"), out: clip("out"),
                    effect: motion.effect || null,
                    props: Object.entries(motion.props || {}).map(([pid, times]) => ({
                        id: pid, ...times, ...m.props[pid], url: `${BASE_URL}${m.props[pid].file}`,
                    })),
                };
                byTool.set(motion.tool, entry);
                // All of them keep the hands at the chest or the face: the
                // face view's gesture zoom-out frames them from the waist.
                for (const part of ["in", "loop", "out"]) UPPER_BODY_GESTURE_URLS.add(entry[part].url);
            }
            return byTool;
        })
        .catch((e) => {
            console.warn("[tool-motion] manifest unavailable", e);
            manifestPromise = null;
            return new Map();
        });
    return manifestPromise;
}

export class ToolMotion {
    /** `director`: the MotionDirector of the avatar this moves (its
     *  `avatar` is the renderer or a peer-slot adapter). */
    constructor(director) {
        this.director = director;
        this._byTool = null;
        this._run = null;
        this._turn = undefined;
        this._turnTools = new Set();
        loadManifest().then((m) => { this._byTool = m; });
    }

    get avatar() {
        return this.director.avatar;
    }

    get _enabled() {
        return this.director._lib()._toolAnimations !== false;
    }

    _log(...args) {
        console.log(this.director._tag.replace("motion", "tool-motion"), ...args);
    }

    /** A tool call went out (`responseId`: the reply that made it). */
    started(callId, name, responseId) {
        const motion = this._byTool?.get(name);
        if (responseId !== this._turn) {
            this._turn = responseId;
            this._turnTools = new Set();
        }
        if (!motion || !this._enabled) return;
        this._turnTools.add(name);
        const run = this._run;
        if (this._turnTools.size > 1) {
            // Not the one slow tool of this reply: nobody gets the stage.
            if (run && run.turn === responseId) {
                this._log(`two slow tools in one reply (${[...this._turnTools].join(", ")}): standing down`);
                this._abort(run);
            }
            return;
        }
        if (run) {
            if (run.motion === motion) run.calls.add(callId);
            return;
        }
        this._begin(motion, callId, responseId);
    }

    /** A tool call's result is back. */
    ended(callId) {
        const run = this._run;
        if (!run || !run.calls.delete(callId) || run.calls.size) return;
        if (run.phase === "loop") this._outro(run);
        // "wait": _intro sees nothing left to wait for; "in": the step
        // after the intro goes straight to the outro.
    }

    /** Every call was dropped (the connection closed or was replaced). */
    cleared() {
        if (this._run) this._abort(this._run, { release: true });
        this._turnTools = new Set();
    }

    // ── a run ─────────────────────────────────────────────────────────

    _begin(motion, callId, turn) {
        const a = this.avatar;
        const run = {
            motion, turn, calls: new Set([callId]), phase: "wait", current: null,
            timers: [], watch: null, props: [], orb: null, vrm: a?.vrm || null,
        };
        this._run = run;
        // Clips and props load during the delay, so each step starts on time.
        for (const part of ["in", "loop", "out"]) a?.preloadGesture?.(motion[part].url);
        for (const p of motion.props) this.director.renderer?.preloadToolProp?.(p.url);
        this._later(run, START_DELAY_MS, () => this._intro(run));
    }

    _later(run, ms, fn) {
        run.timers.push(setTimeout(fn, Math.max(0, ms)));
    }

    _live(run) {
        return this._run === run && this.avatar?.vrm && this.avatar.vrm === run.vrm;
    }

    async _intro(run) {
        if (!this._live(run)) return this._abort(run);
        if (!run.calls.size) return this._finish(run);
        const a = this.avatar;
        // A gesture the companion (or the user) chose is playing: let it
        // finish, then take over if the call is still running.
        if (a.isGestureBusy?.()) {
            this._later(run, BUSY_RETRY_MS, () => this._intro(run));
            return;
        }
        run.introAt = performance.now();
        if (!(await this._play(run, "in"))) return;
        this._log(`${run.motion.id} for ${run.motion.tool}`);
        for (const p of run.motion.props) this._prop(run, p);
        const fx = run.motion.effect;
        if (fx?.kind === "orb") {
            this._later(run, fx.show_in * 1000, () => {
                if (this._live(run) && !run.orb) run.orb = this.avatar.startToolOrb?.() || null;
            });
        }
        run.watch = setInterval(() => this._check(run), WATCH_MS);
        this._later(run, (run.motion.in.duration - SEAM_LEAD_S) * 1000, () => this._afterIntro(run));
    }

    async _afterIntro(run) {
        if (!this._live(run)) return this._abort(run);
        if (!run.calls.size) return this._outro(run);
        await this._play(run, "loop", { loop: true });
    }

    async _outro(run) {
        if (!this._live(run) || run.phase === "out") return;
        if (!(await this._play(run, "out"))) return;
        for (const p of run.props) {
            this._later(run, (p.spec.hide_out ?? 0) * 1000, () => p.handle?.hide());
        }
        const fx = run.motion.effect;
        if (fx?.kind === "orb") this._later(run, (fx.burst_out ?? 0) * 1000, () => run.orb?.burst());
        // Its own release hands the body back to the idle; this only
        // tidies up after it.
        this._later(run, (run.motion.out.duration + 0.5) * 1000, () => this._finish(run));
    }

    /** Start one of the motion's clips; false (and the run is over) when
     *  the body didn't take it — walking, karaoke, a gesture got there first. */
    async _play(run, part, opts = {}) {
        const url = run.motion[part].url;
        run.phase = part;
        run.pending = url;
        await this.avatar.playGesture?.(url, opts);
        run.pending = null;
        if (this._run !== run) return false;
        if (this.avatar.gestureUrl?.() !== url) {
            this._abort(run);
            return false;
        }
        run.current = url;
        return true;
    }

    async _prop(run, spec) {
        const handle = await this.avatar.attachToolProp?.(spec.url, spec);
        if (!handle) return;
        if (this._run !== run) {
            handle.dispose();
            return;
        }
        const entry = { spec, handle };
        run.props.push(entry);
        // How far into the intro the hand reaches for it; at once if the
        // intro is already past that point (a slow first load).
        const due = (spec.show_in ?? 0) * 1000 - (performance.now() - run.introAt);
        this._later(run, due, () => {
            if (run.phase === "in" || run.phase === "loop") handle.show();
        });
    }

    /** Something else took the body: stand down. */
    _check(run) {
        if (this._run !== run) return;
        if (!this._live(run)) return this._abort(run);
        const now = this.avatar.gestureUrl?.() || null;
        if (now === run.current || (run.pending && now === run.pending)) return;
        // The outro ran out and released to the idle: done.
        if (run.phase === "out" && !now) return this._finish(run);
        this._abort(run);
    }

    _abort(run, { release = false } = {}) {
        if (release && this.avatar?.gestureUrl?.() === run.current && run.current) {
            this.avatar.stopGesture?.();
        }
        run.orb?.burst();
        this._finish(run);
    }

    _finish(run) {
        for (const t of run.timers) clearTimeout(t);
        run.timers = [];
        if (run.watch) clearInterval(run.watch);
        run.watch = null;
        for (const p of run.props) {
            p.handle.hide();
            setTimeout(() => p.handle.dispose(), 400);
        }
        run.props = [];
        run.orb?.burst();
        run.orb = null;
        if (this._run === run) this._run = null;
    }
}
