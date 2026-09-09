// Camera awareness: on-device presence and gesture sensing over the armed
// camera share, turned into sparse natural-language context notes for the
// companion ("the user waved", "the user stepped away").
//
// Everything runs locally — MediaPipe FaceLandmarker + GestureRecognizer
// (both Apache-2.0) in WASM. Release packages bundle the models
// (scripts/fetch_vision_model.py → assets/vision_models, served under
// /assets); source checkouts fall back to Google's model bucket, cached in
// the Cache API. No frame ever leaves the device from here; only the
// capture TOOLS (take_screenshot / analyze_screen, on the companion's
// request) send an image anywhere. Opt-in per browser via the share
// popover; runs only while the camera share is armed, so the OS camera
// indicator is always lit when this is.
//
// Event policy (2026-09 research on companions/social robots, then pruned
// hard by live testing): every event is something the companion should
// REACT to out loud — deliberate gestures made at the camera, plus
// presence. Cooldowns exist only to stop the SAME gesture looping: each
// event has a refractory, and firing any other event clears everyone
// else's, so a thumbs-up right after a wave lands, but holding the
// thumbs-up doesn't re-fire until it's been released and the refractory
// has passed. Never numbers, never "I am analysing your face" — the note
// wording tells the companion so.
import { reactive, subscribe } from "./reactive";
import { screenCapture } from "./screen_capture";

// Bundled with the app (Vite emits the loader + binary as hashed assets),
// so the WASM needs no CDN and works on the LAN/offline installs.
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

// Keep the remote URLs in sync with scripts/fetch_vision_model.py.
const MODELS = {
    face: {
        local: "/assets/vision_models/face_landmarker.task",
        remote: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    },
    hands: {
        local: "/assets/vision_models/gesture_recognizer.task",
        remote: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    },
};
const MODEL_CACHE = "rexclaw-vision-models";
const PREF_KEY = "rexclaw.camera_awareness";

// Analysis cadence: face ~20 fps, hands every other frame (a 2-3 Hz wave
// still gets 5 samples per second). On a slow tablet the loop simply
// degrades — the next frame is scheduled after this one ends.
const FRAME_INTERVAL_MS = 50;
const HANDS_EVERY_N = 2;

// Presence.
const AWAY_AFTER_MS = 20000;          // no face this long → "stepped away"
const SETTLE_BEFORE_EVENTS_MS = 2500; // ignore gestures right after arrival
const WAVE_GOODBYE_WINDOW_MS = 30000; // wave then away within this = goodbye

// Thresholds. Hand distances are normalized image coords (0-1) or
// fractions of hand size (wrist → middle knuckle). __cameraDebug.scores()
// and .hand() show the live values.
//   yawn  Mouth Aspect Ratio |13-14| / |78-308| > 0.5 sustained ≥ 1.5 s
//         (the standard drowsiness-detection recipe); speech opens the
//         mouth in sub-second bursts, a yawn holds.
const T = {
    mar: 0.5, marRise: 0.4, yawnHold: 1500,
    handHold: 700,        // canned labels / finger signs must hold this long
    waveAmp: 0.035, waveWindow: 2000, waveReversals: 2,
    okRing: 0.35,         // thumb tip to index tip, fraction of hand size
};

// FaceMesh landmark indices for MAR (inner lips / inner mouth corners).
const LIP_TOP = 13, LIP_BOTTOM = 14, MOUTH_L = 78, MOUTH_R = 308;

// Event table. `speak` = ask the model to reply now; `refractory` = the
// same event can't fire again for this long (and must be released in
// between); any OTHER event firing clears it.
//
// Dropped after live testing / for lack of a proven detector — don't
// re-add without a better signal: wink (blink asymmetry fires on ordinary
// blinks), kiss (mouthPucker fires on speech), shh + "I love you" sign +
// "call me" (unreliable), surprise + eyebrow raise (resting faces), eyes
// closed (looking down reads as closed), raise hand (awkward), nod/shake
// (never fired reliably from the head-pose matrix), fist bump + clapping
// (motion-based hand events other than the wave didn't register), head in
// hands (palm-over-face didn't register), and the keep-in-mind class
// (smile, laugh, frown, looking away) — context bloat with no
// behavioural payoff.
const EVENTS = {
    // --- presence -------------------------------------------------------
    away: { speak: false, refractory: 0,
        note: "The user has stepped away from the camera — nobody is in front "
            + "of the screen right now. Don't expect a reply until they're back." },
    goodbye: { speak: false, refractory: 0,
        note: "The user waved goodbye and left the camera. Nobody is in front of "
            + "the screen now; wrap up gracefully if you were mid-thought." },
    back: { speak: true, refractory: 0,
        note: "The user is back in front of the camera. Greet them briefly if "
            + "it fits the moment — one short line, not a big welcome." },
    // --- hand gestures ---------------------------------------------------
    wave: { speak: true, refractory: 15000,
        note: "The user waved at the camera — hello or goodbye, judge from the "
            + "conversation. Wave back in your own way; if it was a goodbye, "
            + "say a short goodbye." },
    thumbs_up: { speak: true, refractory: 10000,
        note: "The user gave a thumbs up — take it as approval of the last thing "
            + "you said or offered." },
    thumbs_down: { speak: true, refractory: 10000,
        note: "The user gave a thumbs down — take it as disapproval of the last "
            + "thing you said or offered; adjust." },
    peace: { speak: true, refractory: 15000,
        note: "The user flashed a peace sign at the camera. Light and playful." },
    ok_sign: { speak: true, refractory: 10000,
        note: "The user made an OK sign (thumb and index in a ring) at the "
            + "camera — take it as 'all good / agreed'." },
    rock_on: { speak: true, refractory: 15000,
        note: "The user threw the rock-on horns at the camera. Match the energy, "
            + "briefly." },
    middle_finger: { speak: true, refractory: 20000,
        note: "The user flipped you off (middle finger) at the camera. React in "
            + "character — hurt, cheeky or unimpressed, whatever suits you — "
            + "and keep it short." },
    // --- tiredness: a soft spoken remark, rarely ------------------------
    yawn: { speak: true, refractory: 600000,
        note: "The user just yawned. They may be tired — at most one soft remark, "
            + "then drop it." },
};

// User-facing list of the triggers above, for the share panel's info
// popover. Kept next to EVENTS so adding an event means adding a row here;
// the strings are _t() keys resolved at render time.
export const TRIGGER_HELP = [
    { group: "Hand signs · hold about a second", items: [
        ["wave", "Wave", "Waves back; hello or goodbye from context"],
        ["thumbs_up", "Thumbs up", "Takes it as approval"],
        ["thumbs_down", "Thumbs down", "Takes it as disapproval and adjusts"],
        ["ok_sign", "OK sign", "Takes it as 'all good'"],
        ["peace", "Peace sign", "Light, playful reaction"],
        ["rock_on", "Rock-on horns", "Matches the energy"],
        ["middle_finger", "Middle finger", "Reacts in character"],
    ] },
    { group: "Presence", items: [
        ["away", "Step away", "Knows nobody is there and waits"],
        ["back", "Come back", "A short greeting"],
        ["goodbye", "Wave, then leave", "Treats it as goodbye"],
    ] },
    { group: "Tiredness", items: [
        ["yawn", "Yawn", "One soft remark, rarely"],
    ] },
];

const PREFIX = "[Camera note] ";
const RULES = " (Never quote scores, never say you are analysing or watching their face.)";

function loadPref(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v === "1";
    } catch (e) { return fallback; }
}

/** Direction reversals of a value series — counted on excursions of at
 *  least `amp`, so it works at any frame rate. The wave detector. */
function reversals(series, amp) {
    let count = 0, dir = 0, ref = series[0]?.v ?? 0;
    for (const s of series) {
        const d = s.v - ref;
        if (Math.abs(d) < amp) continue;
        const nd = Math.sign(d);
        if (dir && nd !== dir) count++;
        dir = nd;
        ref = s.v;
    }
    return count;
}

/** Peak-to-peak span of a series. */
function peakToPeak(series) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) { if (s.v < lo) lo = s.v; if (s.v > hi) hi = s.v; }
    return series.length ? hi - lo : 0;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function mouthAspectRatio(lm) {
    const w = dist(lm[MOUTH_L], lm[MOUTH_R]);
    return w ? dist(lm[LIP_TOP], lm[LIP_BOTTOM]) / w : 0;
}

/** Hand landmark indices: [mcp, pip, dip, tip] per finger. */
const FINGERS = {
    index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
};

/** Is a finger extended (tip well past the middle joint, seen from the
 *  wrist) or curled (tip folded back toward the palm)? Orientation-free. */
function fingerState(lm, name) {
    const [, pip, , tip] = FINGERS[name];
    const wrist = lm[0];
    const dTip = dist(wrist, lm[tip]), dPip = dist(wrist, lm[pip]);
    if (dTip > dPip * 1.25) return "extended";
    if (dTip < dPip * 1.05) return "curled";
    return "between";
}

/** Hand size reference: wrist to middle-finger knuckle. */
const handScale = (lm) => dist(lm[0], lm[9]) || 1e-6;

/** Static finger-topology signs from the 21 landmarks — the class of
 *  gesture the research ranks most reliable (distinct finger shapes),
 *  which the canned recognizer doesn't cover. Returns a name or null. */
function fingerSign(lm) {
    const idx = fingerState(lm, "index"), mid = fingerState(lm, "middle");
    const ring = fingerState(lm, "ring"), pinky = fingerState(lm, "pinky");
    const scale = handScale(lm);
    // Middle finger: only the middle up.
    if (mid === "extended" && idx === "curled" && ring === "curled" && pinky === "curled") return "middle_finger";
    // Rock-on: index + pinky up, middle + ring down.
    if (idx === "extended" && pinky === "extended" && mid === "curled" && ring === "curled") return "rock_on";
    // OK: thumb tip touching index tip, the other three up.
    if (dist(lm[4], lm[8]) < scale * T.okRing && mid === "extended" && ring === "extended" && pinky === "extended") return "ok_sign";
    return null;
}

class CameraAwareness {
    constructor() {
        this.state = reactive({
            enabled: loadPref(PREF_KEY, false),
            // off | loading | running | error
            status: "off",
            handsStatus: "off",
            error: null,
            present: false,
            attentive: false,
            handGesture: null,
            // Last emitted event name — the popover shows it as a small
            // "last noticed" line so the user can see it working.
            lastEvent: null,
        });
        this._face = null;
        this._hands = null;
        this._loading = {};
        this._timer = null;
        this._sink = null;
        this._reset();
        // Follow the camera share: start when it arms (and the pref is on),
        // stop when it drops.
        subscribe(screenCapture.state, () => this._sync());
    }

    _reset() {
        this._presence = { since: 0, lastSeen: 0, away: false, lastWaveAt: 0 };
        this._hold = {};          // name → ms accumulated above threshold
        this._released = {};      // name → true once the trigger dropped again
        this._firedAt = {};       // name → last fire time (its refractory)
        this._series = { hand: [] };
        this._palmSeenAt = 0;
        // Per-user baseline (EMA of closed-mouth MAR).
        this._marBase = 0;
        this._lastTs = 0;
        this._lastNow = 0;
        this._frame = 0;
        this._lastScores = null;
    }

    /** The voice view hands us the live call's note channel; null when
     *  there is no call to tell (events are then just shown in the UI). */
    setSink(fn) {
        this._sink = typeof fn === "function" ? fn : null;
    }

    setEnabled(flag) {
        this.state.enabled = !!flag;
        try { localStorage.setItem(PREF_KEY, flag ? "1" : "0"); } catch (e) { /* ignore */ }
        this._sync();
    }

    _sync() {
        const want = this.state.enabled && !!screenCapture.cameraVideo;
        if (want && !this._timer) this._start();
        else if (!want && this._timer) this._stop();
    }

    async _start() {
        this.state.status = "loading";
        this.state.error = null;
        // Placeholder so a second _sync() during the load doesn't start twice.
        this._timer = -1;
        try {
            await this._ensureFace();
        } catch (e) {
            console.warn("[camera_awareness] face model failed", e);
            this.state.status = "error";
            this.state.error = String(e?.message || e);
            this._timer = null;
            return;
        }
        // The camera may have dropped while the model loaded.
        if (!this.state.enabled || !screenCapture.cameraVideo) {
            this._timer = null;
            this.state.status = "off";
            return;
        }
        this._reset();
        this._presence.lastSeen = Date.now();
        this.state.status = "running";
        this._loadHands();
        this._tick();
    }

    _stop() {
        if (this._timer && this._timer !== -1) clearTimeout(this._timer);
        this._timer = null;
        this.state.status = "off";
        this.state.handsStatus = "off";
        this.state.present = false;
        this.state.attentive = false;
        this.state.handGesture = null;
    }

    /** Hands load after the face model so presence starts sooner; a
     *  failure here is non-fatal — face events keep running. */
    async _loadHands() {
        if (this._hands) { this.state.handsStatus = "running"; return; }
        if (this._loading.hands) return;
        this.state.handsStatus = "loading";
        try {
            await this._ensureHands();
            this.state.handsStatus = "running";
        } catch (e) {
            console.warn("[camera_awareness] hand model failed", e);
            this.state.handsStatus = "error";
        }
    }

    _ensureFace() {
        return this._ensure("face", async (mp, modelAssetBuffer) => {
            this._face = await mp.FaceLandmarker.createFromOptions(
                { wasmLoaderPath, wasmBinaryPath },
                {
                    baseOptions: { modelAssetBuffer, delegate: "GPU" },
                    runningMode: "VIDEO",
                    numFaces: 1,
                    // Landmark geometry replaced the blendshapes — skip that
                    // extra network per frame.
                    outputFaceBlendshapes: false,
                    outputFacialTransformationMatrixes: true,
                },
            );
        });
    }

    _ensureHands() {
        return this._ensure("hands", async (mp, modelAssetBuffer) => {
            this._hands = await mp.GestureRecognizer.createFromOptions(
                { wasmLoaderPath, wasmBinaryPath },
                {
                    baseOptions: { modelAssetBuffer, delegate: "GPU" },
                    runningMode: "VIDEO",
                    numHands: 1,
                },
            );
        });
    }

    _ensure(key, build) {
        if (!this._loading[key]) {
            this._loading[key] = (async () => {
                const mp = await import("@mediapipe/tasks-vision");
                const bytes = await this._fetchModel(MODELS[key]);
                await build(mp, bytes);
            })().finally(() => { this._loading[key] = null; });
        }
        return this._loading[key];
    }

    /** Model bytes: the bundled same-origin copy when the package ships
     *  one, else Google's bucket via the Cache API so that download
     *  happens once per browser (the bucket only allows an hour of HTTP
     *  caching). */
    async _fetchModel({ local, remote }) {
        try {
            const resp = await fetch(local);
            // A missing file may come back as the SPA's index.html from a
            // catch-all route — insist on a binary body, not just resp.ok.
            const type = resp.headers.get("content-type") || "";
            if (resp.ok && !type.includes("text/html")) {
                return new Uint8Array(await resp.arrayBuffer());
            }
        } catch (e) { /* offline or not bundled — fall through */ }
        let cache = null;
        try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* no Cache API (http) */ }
        let resp = cache ? await cache.match(remote) : null;
        if (!resp) {
            resp = await fetch(remote);
            if (!resp.ok) throw new Error(`Model download failed (${resp.status}).`);
            if (cache) { try { await cache.put(remote, resp.clone()); } catch (e) { /* quota */ } }
        }
        return new Uint8Array(await resp.arrayBuffer());
    }

    // ------------------------------------------------------------------
    // Frame loop
    // ------------------------------------------------------------------

    _tick() {
        if (!this._timer) return;
        try {
            this._analyze();
        } catch (e) {
            console.warn("[camera_awareness] frame failed", e);
        }
        this._timer = setTimeout(() => this._tick(), FRAME_INTERVAL_MS);
    }

    _analyze() {
        const video = screenCapture.cameraVideo;
        if (!video || !video.videoWidth || video.readyState < 2) return;
        // MediaPipe wants strictly increasing timestamps.
        const ts = Math.max(performance.now(), this._lastTs + 1);
        this._lastTs = ts;
        const now = Date.now();
        // Real elapsed time for the hold accumulators — the loop slows down
        // on weak hardware, so a fixed per-frame increment would drift.
        const dt = this._lastNow ? Math.min(500, now - this._lastNow) : FRAME_INTERVAL_MS;
        this._lastNow = now;
        this._frame++;
        const face = this._face.detectForVideo(video, ts);
        const hasFace = !!face?.faceLandmarks?.length;
        this._updatePresence(hasFace, now);
        if (hasFace) {
            this._analyzeFace(face, now, dt);
        } else {
            this.state.attentive = false;
            this._hold.yawn = 0;
        }
        if (this._hands && this._frame % HANDS_EVERY_N === 0) {
            this._analyzeHands(this._hands.recognizeForVideo(video, ts), now, dt * HANDS_EVERY_N);
        }
    }

    // ------------------------------------------------------------------
    // Presence
    // ------------------------------------------------------------------

    _updatePresence(hasFace, now) {
        const p = this._presence;
        if (hasFace) {
            if (!this.state.present) {
                this.state.present = true;
                p.since = now;
                if (p.away) {
                    p.away = false;
                    this._fire("back", now);
                }
            }
            p.lastSeen = now;
        } else {
            if (this.state.present) this.state.present = false;
            if (!p.away && now - p.lastSeen > AWAY_AFTER_MS) {
                p.away = true;
                const wavedGoodbye = p.lastWaveAt && (p.lastSeen - p.lastWaveAt) < WAVE_GOODBYE_WINDOW_MS;
                this._fire(wavedGoodbye ? "goodbye" : "away", now);
            }
        }
    }

    // ------------------------------------------------------------------
    // Face: attention + yawn
    // ------------------------------------------------------------------

    _analyzeFace(result, now, dt) {
        const lm = result.faceLandmarks[0];
        const pose = this._headPose(result.facialTransformationMatrixes?.[0]);
        this.state.attentive = pose ? Math.abs(pose.yaw) < 30 && Math.abs(pose.pitch) < 25 : true;
        // Skip everything until the user has been in frame a moment —
        // arriving/leaving produces junk at the frame edge.
        if (now - this._presence.since < SETTLE_BEFORE_EVENTS_MS) return;

        // Yawn: MAR sustained well above the closed-mouth baseline (an EMA
        // of non-yawning frames, seeded on arrival).
        const mar = mouthAspectRatio(lm);
        if (!this._marBase) this._marBase = mar;
        const yawning = mar > Math.max(T.mar, this._marBase + T.marRise);
        if (!yawning) this._marBase += (mar - this._marBase) * 0.02;
        this._accumulate("yawn", yawning, T.yawnHold, now, dt);

        this._lastScores = {
            mar: +mar.toFixed(3), marBase: +this._marBase.toFixed(3),
            pitch: pose && +pose.pitch.toFixed(1), yaw: pose && +pose.yaw.toFixed(1),
            hold: { ...this._hold },
        };
    }

    // ------------------------------------------------------------------
    // Hands
    // ------------------------------------------------------------------

    _analyzeHands(result, now, dt) {
        const primary = result?.landmarks?.[0] || null;
        const label = result?.gestures?.[0]?.[0]?.categoryName || null;
        const sign = primary ? fingerSign(primary) : null;
        this.state.handGesture = sign || (label && label !== "None" ? label : (primary ? "hand" : null));

        // Canned labels, held to confirm intent (the Zoom/FaceTime rule).
        this._accumulate("thumbs_up", label === "Thumb_Up", T.handHold, now, dt);
        this._accumulate("thumbs_down", label === "Thumb_Down", T.handHold, now, dt);
        this._accumulate("peace", label === "Victory", T.handHold, now, dt);
        // Finger-topology signs, same hold.
        for (const name of ["middle_finger", "rock_on", "ok_sign"]) {
            this._accumulate(name, sign === name, T.handHold, now, dt);
        }

        if (!primary) {
            this._series.hand = [];
            return;
        }

        // Wave: a hand swinging side to side, seen as an open palm at some
        // point in the window (the label flickers mid-swing, so don't
        // demand it on every sample). Middle fingertip travels furthest.
        if (label === "Open_Palm") this._palmSeenAt = now;
        this._series.hand.push({ t: now, v: primary[12].x });
        this._series.hand = this._series.hand.filter((e) => now - e.t < T.waveWindow);
        if (now - this._palmSeenAt < T.waveWindow
            && reversals(this._series.hand, T.waveAmp) >= T.waveReversals) {
            if (this._fire("wave", now)) {
                this._presence.lastWaveAt = now;
                this._series.hand = [];
            }
        }
    }

    // ------------------------------------------------------------------
    // Event plumbing
    // ------------------------------------------------------------------

    /** Sustain-then-fire helper: `active` must hold for `holdMs` before the
     *  event fires, and must drop again before it can re-fire. */
    _accumulate(name, active, holdMs, now, dt) {
        if (!active) {
            this._hold[name] = 0;
            this._released[name] = true;
            return;
        }
        this._hold[name] = (this._hold[name] || 0) + dt;
        if (this._hold[name] >= holdMs && this._released[name] !== false) {
            if (this._fire(name, now)) this._released[name] = false;
        }
    }

    /** Fire an event, honouring its own refractory. A different event
     *  firing clears every other refractory — cooldowns only exist to stop
     *  one gesture looping, never to mute the next one. */
    _fire(name, now, { force = false } = {}) {
        const ev = EVENTS[name];
        if (!ev) return false;
        if (!force && ev.refractory && now - (this._firedAt[name] || 0) < ev.refractory) return false;
        this._firedAt = { [name]: now };
        this.state.lastEvent = name;
        this._send(name, ev.note, ev.speak);
        return true;
    }

    _send(name, body, speak) {
        const text = PREFIX + body + RULES;
        if (!this._sink) {
            console.log(`[camera_awareness] ${name} — no live call, note not sent`);
            return;
        }
        let sent = false;
        try { sent = this._sink(text, { minIntervalMs: 0, promptResponse: !!speak }); } catch (e) { /* sink errors never stop sensing */ }
        console.log(`[camera_awareness] ${name} → context note ${sent ? "sent" : "NOT sent (dropped by the call)"}`
            + ` (speak=${!!speak})`);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Head pose from the 4x4 face transform (column-major): yaw about Y,
     *  pitch about X, degrees. Only used for the "facing the screen"
     *  status line now. */
    _headPose(matrix) {
        const m = matrix?.data;
        if (!m || m.length < 16) return null;
        const yaw = Math.atan2(m[8], m[10]) * 180 / Math.PI;
        const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9]))) * 180 / Math.PI;
        return { yaw, pitch };
    }
}

export const cameraAwareness = new CameraAwareness();
export const CAMERA_EVENTS = Object.keys(EVENTS);

// Console harness for testing during a live call (same idea as
// __gestureDebug):
//   __cameraDebug.emit("wave")    fire any event now, refractory ignored
//   __cameraDebug.events          all event names
//   __cameraDebug.scores()        live mouth/pose values + hold timers
//   __cameraDebug.hand()          current hand label, wave accumulator, holds
//   __cameraDebug.fps()           effective analysis rate
//   __cameraDebug.state           the reactive status object
//   __cameraDebug.thresholds      the live threshold table (editable)
if (typeof window !== "undefined") {
    window.__cameraDebug = {
        emit: (name) => {
            if (!EVENTS[name]) return `unknown event; one of: ${CAMERA_EVENTS.join(", ")}`;
            cameraAwareness._fire(name, Date.now(), { force: true });
            return `emitted ${name}`;
        },
        events: CAMERA_EVENTS,
        scores: () => cameraAwareness._lastScores || null,
        hand: () => {
            const s = cameraAwareness._series.hand;
            return { label: cameraAwareness.state.handGesture, samples: s.length,
                     swing: peakToPeak(s).toFixed(3), reversals: reversals(s, T.waveAmp),
                     hold: { ...cameraAwareness._hold } };
        },
        fps: () => {
            const dt = cameraAwareness._lastNow ? Date.now() - cameraAwareness._lastNow : 0;
            return dt ? +(1000 / Math.max(dt, FRAME_INTERVAL_MS)).toFixed(1) : 0;
        },
        get state() { return cameraAwareness.state; },
        thresholds: T,
    };
}
