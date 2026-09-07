/**
 * Idle physiology — the signal generator behind the procedural idle.
 *
 * This module produces NUMBERS, not poses: one `sig` bundle per frame that
 * avatar_renderer writes onto bones and expressions. Keeping it separate is
 * what lets breath, posture, gaze, blink and mouth be COUPLED — a sigh has
 * to lift the shoulders and part the lips, a gaze aversion has to turn the
 * head and trigger a blink — which is impossible when each of those lives
 * in its own independent sine wave.
 *
 * WHY NOT SINES. The previous idle was a bank of sin(t·ω) terms with a
 * second incommensurate sine stacked on to hide the period. It still read as
 * a machine, for two reasons the research on standing posture is unanimous
 * about:
 *
 *   1. A person standing still is not oscillating. They HOLD a posture for
 *      several seconds and then CHANGE it — a weight transfer onto the other
 *      foot, a head reorientation — and hold again. The motion is
 *      piecewise-static with discrete events, not continuous. A sine has no
 *      events, so the eye reads "swaying" instead of "standing".
 *   2. What continuous drift there is, is band-limited NOISE (postural sway),
 *      not a periodic wave. Any sine, however slow, eventually shows the eye
 *      its period.
 *
 * So the model here is: fBm value noise for continuous drift + a hold/shift
 * state machine for postural events + second-order springs for everything
 * that has mass. The springs are what give follow-through for free — the
 * head chases a target derived from the torso, so it lags and overshoots the
 * way a head on a neck actually does, with no hand-authored offsets.
 *
 * Reference points: the 40-second hand-authored idle loops that commercial
 * companion apps ship (long enough that the viewer never catches the loop);
 * this is the procedural equivalent, with a period of never.
 *
 * COUPLINGS worth knowing about, because they are the whole point:
 *   breath  → chest/spine/shoulders/head-Y, and a lip part at the top of a
 *             deep inhale; rate rises and depth falls while speaking, and a
 *             recovery breath follows a long turn.
 *   weight  → hip roll, alternating knee bend, and a COUNTER-tilt in the
 *             chest (contrapposto: the shoulders drop toward the raised hip).
 *   gaze    → head yaw/pitch share on the big aversions, and a gaze-evoked
 *             blink, both of which are real and both of which are most of
 *             why a staring avatar looks dead.
 *   swallow → a mouth close plus a small head-pitch dip.
 *
 * Everything scales toward zero as `speak` rises where it should (the idle
 * mouth yields to lipsync entirely) and up where it should (body gain).
 */

// ── Value noise ────────────────────────────────────────────────────────
// Deterministic 1-D value noise with a smootherstep fade and three octaves
// of fBm. Each signal draws from its own `row` so channels never correlate
// — the giveaway of a shared noise source is limbs drifting in unison.

function hash1(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453123;
    return s - Math.floor(s);
}

/** Smootherstep: 0→1 with zero first AND second derivative at both ends,
 *  so anything eased with it starts and stops without a corner. */
function smootherstep(t) {
    const u = Math.max(0, Math.min(1, t));
    return u * u * u * (u * (u * 6 - 15) + 10);
}

function vnoise(x, row) {
    const i = Math.floor(x);
    const f = x - i;
    const u = smootherstep(x - i);                   // C² continuous
    const a = hash1(i + row * 131.7);
    const b = hash1(i + 1 + row * 131.7);
    return (a + (b - a) * u) * 2 - 1;                 // → −1..1
}

/** Smooth aperiodic drift, roughly −1..1.
 *
 *  A primary plus a SLOWER secondary at a third of the rate — deliberately
 *  the same recipe as the sine idle this replaced (which was a primary at
 *  0.18–0.30 Hz plus a secondary at 0.071), because that recipe is what made
 *  the old sway read as smooth. All the energy sits at or below the primary,
 *  so there is nothing fast in here to chatter.
 *
 *  It is NOT fBm, and an earlier version that was — octaves at 2.2× and 4.6×
 *  the base rate — is what made the arms jerky. Upper octaves look like
 *  "detail" in a plot and like a tremor on a character: at these rates the
 *  third octave sat above 1 Hz, which is fast enough for the eye to read as
 *  twitching rather than as drifting.
 *
 *  What the noise buys over the two sines is the thing the sines got wrong:
 *  they beat against each other in a fixed pattern, so the sway was
 *  symmetrical and eventually recognisable. This has the same smoothness
 *  with no pattern to find. */
function drift(x, row) {
    return vnoise(x, row) * 0.74
        + vnoise(x * 0.31, row + 7) * 0.40;
}

// ── Breathing ──────────────────────────────────────────────────────────
// Quiet respiration at rest is 12–16 breaths/min. The curve is NOT a sine:
// inhale is shorter than exhale and there is a pause at the bottom (I:E of
// about 1:2 including the pause). Getting that asymmetry right is most of
// the difference between "breathing" and "pulsing".
const BREATH_PERIOD_QUIET = 3.9;        // s per breath ≈ 15/min
const BREATH_PERIOD_SPEAK = 2.9;        // faster and shallower while talking
const BREATH_PERIOD_JITTER = 0.16;      // ± fraction, re-rolled every breath
const BREATH_INHALE_END = 0.34;         // fraction of the cycle
const BREATH_EXHALE_END = 0.82;         // the rest is the pause at empty
const BREATH_DEPTH_SPEAK = 0.55;        // depth multiplier at full speech
// A sigh — one deeper, slower breath — is the single cheapest "alive" tell.
// Humans sigh every few minutes at rest; a little more often reads better on
// an avatar you are looking straight at.
const SIGH_GAP_MIN = 70;
const SIGH_GAP_MAX = 180;
const SIGH_DEPTH = 2.0;
const SIGH_PERIOD_SCALE = 1.5;
// After a long spoken turn the character takes one deep breath back. Same
// mechanism as a sigh, triggered by the release instead of the clock.
const RECOVERY_SPEAK_S = 6;             // speech this long earns a recovery breath
const RECOVERY_DEPTH = 1.6;

/** Lung fullness 0..1 for a phase 0..1. Inhale, exhale, pause. */
function breathCurve(p) {
    if (p < BREATH_INHALE_END) {
        const u = p / BREATH_INHALE_END;
        return 0.5 - 0.5 * Math.cos(Math.PI * u);
    }
    if (p < BREATH_EXHALE_END) {
        const u = (p - BREATH_INHALE_END) / (BREATH_EXHALE_END - BREATH_INHALE_END);
        return 0.5 + 0.5 * Math.cos(Math.PI * u);
    }
    return 0;
}

// ── Body sway ──────────────────────────────────────────────────────────
// The original sine bank, restored verbatim. A primary sine per channel plus
// a second at an incommensurate 0.071 Hz at 45% of the amplitude, so the two
// beat against each other and the motion never lands on an obvious period.
//
// This replaced, and was then replaced BY, a noise-plus-state-machine model
// that tried to be more physically honest — discrete weight transfers, a
// held stance, postural sway drawn from band-limited noise. It measured
// better and looked worse. The sines give a consistent, gentle left-right
// sway that reads as a person standing there, which is the entire job.
//
// One deliberate difference from the original: these drive the SPINE and
// CHEST rather than the hips. There is no IK, so anything the pelvis does
// slides the feet across the floor; applying the same waveforms one joint
// higher gives the same sway over a base that stays put.
const SWAY_SECONDARY_HZ = 0.071;
const SWAY_SECONDARY_RATIO = 0.45;
const SWAY_YAW_AMP = 0.025;             // was the hips' yaw
const SWAY_YAW_HZ = 0.18;
const SWAY_ROLL_AMP = 0.015;            // was the spine's roll
const SWAY_ROLL_HZ = 0.22;
const SWAY_WEIGHT_AMP = 0.022 * 0.6;    // the slow left-right weight lean
const SWAY_WEIGHT_HZ = 0.08;            // ~12 s per full L<->R cycle
const SWAY_ARM_AMP = 0.04;
const SWAY_ARM_HZ = 0.30;
// Phase offsets so left and right limbs are not perfect mirrors. Prime-ish
// radian values keep the asymmetry from re-aligning into visible sync.
const SWAY_PHASE_L = 0.41;
const SWAY_PHASE_R = 1.13;

/** Primary sine + the slower secondary. The original `sway()` helper. */
function sway(t, hz, amp, phase = 0) {
    const TAU = Math.PI * 2;
    return Math.sin(t * hz * TAU + phase) * amp
        + Math.sin(t * SWAY_SECONDARY_HZ * TAU + phase * 0.7) * amp * SWAY_SECONDARY_RATIO;
}

// ── Head ───────────────────────────────────────────────────────────────
// The head chases a target built from the torso plus its own drift, through
// a spring. The lag IS the follow-through.
// The neck is a low-pass filter: it must be fast enough to pass the drift's
// upper octaves (or the head goes back to looking static) and slow enough
// still to lag the torso. 0.9 Hz against a 0.16 Hz drive passes the detail
// and keeps roughly a quarter-second of lag.
const HEAD_SPRING_HZ = 0.9;
const HEAD_SPRING_ZETA = 0.72;
const HEAD_COUNTER_YAW = 0.25;          // share of hip yaw the head cancels
const HEAD_COUNTER_ROLL = 0.35;         // share of spine roll ditto
const HEAD_DRIFT_YAW = 0.085;
const HEAD_DRIFT_PITCH = 0.030;
const HEAD_DRIFT_ROLL = 0.028;
const HEAD_NOD_SPEAK = 0.055;           // extra nod amplitude at full speech
const HEAD_TILT_SPEAK = 0.038;

// ── Torso / limb amplitudes (radians) ──────────────────────────────────
const SPINE_BREATH_PITCH = 0.013;       // spine extends a little on the inhale
const CHEST_BREATH_PITCH = 0.017;
const SHOULDER_BREATH_LIFT = 0.021;
// Contrapposto: the shoulders tilt opposite the lean, so a weight shift
// reads as weight rather than as the whole torso tipping over.
const CHEST_COUNTER_ROLL = 0.013;
const HEAD_BREATH_Y = 0.011;            // metres of head rise on a full inhale

// ── Arms ───────────────────────────────────────────────────────────────
// The original: a single sway per arm on the same compound waveform as the
// body, offset in phase so the two are not mirrors. The drag chain that was
// here — a cascade of springs staggering shoulder, elbow and wrist, plus an
// occasional stepped "adjustment" — is what read as the arms snapping
// between positions, so it is gone.
const ARM_ELBOW_SHARE = 0.5;            // elbow carries half the upper arm's swing

// ── Legs ───────────────────────────────────────────────────────────────
// Legs are STATIC. Not a stance that shifts, not driven by the weight — a
// fixed, symmetric standing pose that never changes.
//
// This is forced by the rig, not by taste: there is no IK here, so the feet
// are children of the hips and inherit everything the hips do. Any pelvis
// rotation or translation slides them across the floor, and any weight-driven
// leg angle swings them. The only way feet genuinely never move is for the
// hips and the leg angles to be constants — so they are, and every bit of the
// idle's motion lives above the pelvis instead.
const KNEE_BEND = 0.13;                 // ~7.5 deg; locked legs read as stiff
const HIP_PITCH = -0.06;                // slight forward tilt at the hip


// Noise rates, matched to the sine idle these replaced — that one ran the
// hips at 0.18 Hz, the spine at 0.22, the arms at 0.30 and the head at 0.15,
// and its liveliness came from those rates, not from its amplitude.
//
// A first pass set these near 0.05 Hz on the theory that subtle means slow.
// It does not: SUBTLE IS AMPLITUDE, and slow at the same amplitude just
// reads as static — measured against the old model it moved 6–24× less per
// second while covering the same range, so the character got where it was
// going and then sat there. These are the rates the motion is actually
// visible at; the amplitudes below are what keep it subtle.
const DRIFT_HZ_BODY = 0.78;
const DRIFT_HZ_ARM = 0.75;
const DRIFT_HZ_HEAD = 0.34;    // tuned so the head turns at the original's ~9/min

// ── Gaze ───────────────────────────────────────────────────────────────
// The fixation-interval table is ported from moeru-ai/airi
// (utils/eye-motions.ts): a probability table biased toward short holds with
// a long tail, so re-fixation never falls into a rhythm.
const GAZE_AMP = 0.26;                  // world units of look-at offset
const GAZE_INT_STEP = 400;              // ms granularity of the buckets
const GAZE_INT_P = [
    [0.075, 800], [0.110, 0], [0.125, 0], [0.140, 0], [0.125, 0],
    [0.050, 0], [0.040, 0], [0.030, 0], [0.020, 0], [1.000, 0],
];
for (let i = 1; i < GAZE_INT_P.length; i++) {
    GAZE_INT_P[i][0] += GAZE_INT_P[i - 1][0];
    GAZE_INT_P[i][1] = GAZE_INT_P[i - 1][1] + GAZE_INT_STEP;
}
// Saccades are not all the same size. Most are micro-corrections around the
// fixation point; a few are real glances; a few per minute are AVERSIONS —
// the character looks away and down for a beat. Unbroken eye contact is one
// of the strongest uncanny signals there is, so the aversions matter more
// than their rarity suggests.
// The common case is sized to match the flat ±GAZE_AMP dart the previous
// idle used (whose mean magnitude was half its range), so the eyes stay as
// busy as they were — the improvement here is the DISTRIBUTION of sizes on
// top, not a quieter gaze. A first pass at 0.20 cut mean eye movement to a
// third of the old idle's and read as glassy.
const GAZE_MICRO = 0.62;                 // amplitude scale of the common case
const GAZE_GLANCE = 0.8;
const GAZE_P_GLANCE = 0.20;             // probability of at least a glance
const GAZE_P_AVERT = 0.055;             // probability of a full aversion
const GAZE_AVERT_HOLD_MIN = 0.7;        // s the aversion is held before re-fixation
const GAZE_AVERT_HOLD_MAX = 2.2;
const GAZE_AVERT_HEAD_YAW = 0.13;       // head share of an aversion
const GAZE_AVERT_HEAD_PITCH = 0.055;
const GAZE_HEAD_SPRING_HZ = 1.1;        // head follows the gaze faster than it drifts
const GAZE_HEAD_SPRING_ZETA = 0.85;

// ── Blink ──────────────────────────────────────────────────────────────
// Inter-blink intervals are heavy-tailed, not uniform: mostly a few seconds,
// occasionally a long stare, occasionally two in a row. An exponential draw
// reproduces that far better than the uniform [3,6] this replaces — the
// uniform version was the reason the blinking read as a metronome.
// Tuned so the resulting RATE lands on the old idle's ~13/min once the
// double blinks are counted — the heavy tail is the change here, not a
// busier eyelid.
const BLINK_MEAN_QUIET = 5.8;
const BLINK_MEAN_SPEAK = 3.0;           // blink rate roughly doubles during speech
const BLINK_GAP_MIN = 0.9;
const BLINK_GAP_MAX = 14;
const BLINK_CLOSE_S = 0.075;            // biphasic: fast close, slower open
const BLINK_OPEN_MIN = 0.15;
const BLINK_OPEN_MAX = 0.30;
const BLINK_DOUBLE_CHANCE = 0.10;
const BLINK_DOUBLE_GAP = 0.20;
const BLINK_ON_GAZE_CHANCE = 0.4;       // gaze-evoked blink on a big shift
// The slow blink: a long, soft close, a held beat with the eyes shut, and an
// unhurried opening — lifted from the authored idles, where it is the single
// most characterful thing the face does. It arrives with a small mouth
// movement, because in the reference the two happen together and the pair
// reads as a moment of thought rather than as an eyelid event.
const SLOW_BLINK_GAP_MIN = 38;
const SLOW_BLINK_GAP_MAX = 95;
const SLOW_BLINK_CLOSE = 0.26;
const SLOW_BLINK_HOLD = 0.34;
const SLOW_BLINK_OPEN = 0.38;
const SLOW_BLINK_MOUTH = 0.09;          // the mouth movement that goes with it

// An occasional hand squeeze: the fingers curl a little further and release.
// Rare — about once or twice in the time an authored loop runs — and slow
// enough to read as a settling grip rather than a grab.
const SQUEEZE_GAP_MIN = 55;
const SQUEEZE_GAP_MAX = 150;
const SQUEEZE_IN = 0.7;
const SQUEEZE_HOLD_MIN = 0.6;
const SQUEEZE_HOLD_MAX = 1.8;
const SQUEEZE_OUT = 1.1;
const SQUEEZE_DEPTH = 0.55;             // extra curl, as a fraction of the rest pose

// ── Idle mouth ─────────────────────────────────────────────────────────
// The explicit ask, and the reason a silent avatar looks embalmed: a real
// mouth at rest is never held on one shape. It carries a slow drift in the
// lip seal, opens fractionally at the top of an inhale, makes a small
// press / purse / part every ten seconds or so, and swallows every minute.
// All of it is tiny — the largest value here is 0.13 of a blendshape — and
// all of it is gated to zero the instant lipsync has something to say.
const MOUTH_BASE = 0.018;               // resting lip part
const MOUTH_BASE_DRIFT = 0.014;
const MOUTH_BREATH = 0.035;             // extra part at the top of an inhale
const MOUTH_EVENT_GAP_MIN = 6;
const MOUTH_EVENT_GAP_MAX = 18;
const SWALLOW_GAP_MIN = 26;
const SWALLOW_GAP_MAX = 70;
const SWALLOW_DUR = 0.55;
const SWALLOW_HEAD_PITCH = 0.022;       // the small dip that sells it
// [channel, peak, duration] — one is drawn per event.
// Sized to be SEEN. These were half this, which measured out at under 8%
// of a viseme once the renderer's per-viseme scaling was applied — present
// in the numbers and invisible on the face. The authored idles are no help
// here either: their own mouth curves peak around 0.03, so on a baked idle
// this is the only thing moving the mouth at all.
const MOUTH_EVENTS = [
    ["ih", 0.20, 0.50],                 // lips press / spread
    ["ou", 0.22, 0.60],                 // purse
    ["aa", 0.15, 0.70],                 // part
    ["ih", 0.11, 0.35],                 // a quick one
];

function rand(a, b) {
    return a + Math.random() * (b - a);
}

/** Exponential draw with mean `m`, clamped — heavy-tailed inter-event gaps. */
function expGap(m, lo, hi) {
    const g = -Math.log(1 - Math.random() * 0.999) * m;
    return Math.max(lo, Math.min(hi, g));
}

/** Fixation hold in seconds, from the weighted table above. */
function gazeInterval() {
    const r = Math.random();
    for (let i = 0; i < GAZE_INT_P.length; i++) {
        if (r <= GAZE_INT_P[i][0]) {
            return (GAZE_INT_P[i][1] + Math.random() * GAZE_INT_STEP) / 1000;
        }
    }
    return (GAZE_INT_P[GAZE_INT_P.length - 1][1] + Math.random() * GAZE_INT_STEP) / 1000;
}

/** Bell envelope 0→1→0 over u ∈ [0,1]. */
function bell(u) {
    return Math.sin(Math.PI * Math.max(0, Math.min(1, u)));
}

/** One second-order spring channel. */
function spring() {
    return { x: 0, v: 0 };
}

/** Integrate `s` toward `target`. f = natural frequency (Hz), z = damping
 *  ratio (< 1 overshoots and settles, which is what a body does). */
function springTo(s, target, f, z, dt) {
    const w = 2 * Math.PI * f;
    s.v += (w * w * (target - s.x) - 2 * z * w * s.v) * dt;
    s.x += s.v * dt;
}

export class IdleMotion {
    constructor() {
        // Taste knobs, live-editable from the console for A/B-ing a look:
        //   __voiceRenderer._idle.tuning.sway = 0.5
        // Each scales one layer to nothing at 0 and to its designed size at
        // 1 (above 1 works, and mostly looks silly).
        this.tuning = {
            sway: 1,        // the body's left-right sway and torso/head drift
            arms: 1,        // arm sway
            legs: 1,        // the fixed knee bend / ankle pose
            breath: 1,      // chest / shoulders / head rise
            gaze: 1,        // saccades and aversions
            mouth: 1,       // resting mouth
        };
        this.reset();
    }

    /** Fresh state — called on construction and on every avatar swap so a
     *  new model starts from rest instead of inheriting the last one's
     *  half-completed weight transfer. */
    reset() {
        this.t = 0;
        this.seed = Math.random() * 1000;
        this._w = 0;                      // last frame's total weight, see _emit

        // breath
        this._breathPhase = Math.random();
        this._breathPeriod = BREATH_PERIOD_QUIET;
        this._breathDepth = 1;
        this._nextDeepAt = rand(SIGH_GAP_MIN, SIGH_GAP_MAX);
        this._deepPending = 0;            // 0 none, else the depth to use
        this._speakRun = 0;               // seconds of continuous speech






        // head springs
        this._headYaw = spring();
        this._headPitch = spring();
        this._headRoll = spring();

        // gaze
        this._gazeX = 0;
        this._gazeY = 0;
        this._nextGazeAt = 0;
        this._avertUntil = 0;
        this._gazeHeadYaw = spring();
        this._gazeHeadPitch = spring();

        // blink
        this._blink = 0;
        this._blinkStart = -1;
        this._blinkOpenDur = BLINK_OPEN_MIN;
        this._nextBlinkAt = expGap(BLINK_MEAN_QUIET, BLINK_GAP_MIN, BLINK_GAP_MAX);
        this._doublePending = false;
        this._slowBlink = null;
        this._nextSlowBlinkAt = rand(SLOW_BLINK_GAP_MIN, SLOW_BLINK_GAP_MAX);

        // hands
        this._squeeze = 0;
        this._squeezeStart = -1;
        this._squeezeHold = 0;
        this._nextSqueezeAt = rand(SQUEEZE_GAP_MIN, SQUEEZE_GAP_MAX);

        // mouth
        this._nextMouthAt = rand(2, MOUTH_EVENT_GAP_MAX);
        this._mouthEvent = null;
        this._nextSwallowAt = rand(SWALLOW_GAP_MIN, SWALLOW_GAP_MAX);
        this._swallowStart = -1;

        this.sig = this._blankSig();
    }

    _blankSig() {
        return {
            hipYaw: 0, hipRoll: 0,
            spineRoll: 0, spineYaw: 0, spinePitch: 0,
            chestPitch: 0, chestRoll: 0, chestYaw: 0, shoulderLift: 0,
            // arms, down the drag chain
            shoulderDragL: 0, shoulderDragR: 0,
            armL: 0, armR: 0, armPitchL: 0, armPitchR: 0,
            elbowL: 0, elbowR: 0, handL: 0, handR: 0,
            // legs: full angles, so the ankle compensation below is exact
            hipPitchL: 0, hipPitchR: 0, hipYawL: 0, hipYawR: 0,
            kneeL: 0, kneeR: 0,
            footPitchL: 0, footPitchR: 0, footRoll: 0,
            footYawL: 0, footYawR: 0,
            hipShiftX: 0, hipShiftZ: 0,
            weight: 0,
            headYaw: 0, headPitch: 0, headRoll: 0, headY: 0,
            breath: 0, breathDepth: 1,
            blink: 0, squeeze: 0,
            gazeX: 0, gazeY: 0,
            mouth: { aa: 0, ih: 0, ou: 0 },
        };
    }

    /**
     * Advance one frame and refresh `this.sig`.
     *
     * Called unconditionally — including while a clip owns the body — so
     * that blink, gaze and breath keep running under a gesture and the
     * procedural pose never resumes from a stale phase.
     *
     * @param {number} dt   seconds since the last frame
     * @param {number} speak eased speaking intensity, 0..1
     * @param {boolean} posing whether the procedural pose is actually driving
     *   the body this frame. Discrete events (a weight transfer, an arm
     *   adjustment) only START when it is — beginning one under a gesture
     *   clip means it is half over by the time anyone can see it, and the
     *   character appears to arrive mid-move.
     */
    update(dt, speak = 0, posing = true) {
        // Long frames (a tab that was backgrounded, a heavy VRM load) would
        // blow the springs up — they integrate explicitly. Substep instead
        // of clamping so the phase clocks stay honest across a stall.
        let left = Math.max(0, Math.min(1.0, dt || 0));
        while (left > 0) {
            const step = Math.min(left, 1 / 45);
            this._step(step, speak, posing);
            left -= step;
        }
        this._emit(speak);
    }

    _step(dt, speak, posing) {
        this.t += dt;
        const t = this.t + this.seed;

        // ── breath ────────────────────────────────────────────────────
        // Track how long speech has run; a long turn earns one deep breath
        // when it ends, the way a person refills after talking.
        if (speak > 0.15) {
            this._speakRun += dt;
        } else {
            if (this._speakRun > RECOVERY_SPEAK_S) this._deepPending = RECOVERY_DEPTH;
            this._speakRun = 0;
        }
        if (this.t >= this._nextDeepAt) {
            this._deepPending = SIGH_DEPTH;
            this._nextDeepAt = this.t + rand(SIGH_GAP_MIN, SIGH_GAP_MAX);
        }
        this._breathPhase += dt / this._breathPeriod;
        while (this._breathPhase >= 1) {
            this._breathPhase -= 1;
            // Every breath re-rolls its own length, so even the quiet
            // rhythm never lands on the same beat twice.
            const base = BREATH_PERIOD_QUIET
                + (BREATH_PERIOD_SPEAK - BREATH_PERIOD_QUIET) * speak;
            const jitter = 1 + rand(-BREATH_PERIOD_JITTER, BREATH_PERIOD_JITTER);
            if (this._deepPending) {
                this._breathPeriod = base * jitter * SIGH_PERIOD_SCALE;
                this._breathDepth = this._deepPending;
                this._deepPending = 0;
            } else {
                this._breathPeriod = base * jitter;
                this._breathDepth = 1;
            }
        }

        // ── gaze ──────────────────────────────────────────────────────
        if (this.t >= this._nextGazeAt) {
            const r = Math.random();
            let scale = GAZE_MICRO;
            let avert = false;
            if (r < GAZE_P_AVERT) {
                scale = 1;
                avert = true;
            } else if (r < GAZE_P_AVERT + GAZE_P_GLANCE) {
                scale = GAZE_GLANCE;
            }
            // Focus tightens while speaking — a talking character that keeps
            // glancing away reads as distracted rather than alive.
            scale *= 1 - 0.4 * speak;
            if (avert) {
                // Away and slightly down, the direction people actually look
                // when they are thinking rather than avoiding.
                const side = Math.random() < 0.5 ? -1 : 1;
                this._gazeX = side * rand(0.6, 1.0) * scale;
                this._gazeY = -rand(0.25, 0.7) * scale;
                this._avertUntil = this.t + rand(GAZE_AVERT_HOLD_MIN, GAZE_AVERT_HOLD_MAX);
                this._nextGazeAt = this._avertUntil;
            } else {
                this._gazeX = rand(-1, 1) * scale;
                this._gazeY = rand(-1, 1) * scale;
                this._nextGazeAt = this.t + gazeInterval();
            }
            // Gaze-evoked blink: real, and it hides the jump the way it does
            // in a person. Only on the shifts big enough to need hiding.
            if (scale > GAZE_MICRO && Math.random() < BLINK_ON_GAZE_CHANCE
                && this._blinkStart < 0) {
                this._nextBlinkAt = this.t;
            }
        }
        const averting = this.t < this._avertUntil;
        springTo(this._gazeHeadYaw, averting ? this._gazeX * GAZE_AVERT_HEAD_YAW : 0,
            GAZE_HEAD_SPRING_HZ, GAZE_HEAD_SPRING_ZETA, dt);
        springTo(this._gazeHeadPitch, averting ? this._gazeY * GAZE_AVERT_HEAD_PITCH : 0,
            GAZE_HEAD_SPRING_HZ, GAZE_HEAD_SPRING_ZETA, dt);

        // ── blink ─────────────────────────────────────────────────────
        if (this._blinkStart < 0 && this.t >= this._nextBlinkAt) {
            this._blinkStart = this.t;
            this._blinkOpenDur = rand(BLINK_OPEN_MIN, BLINK_OPEN_MAX);
        }
        if (this._blinkStart >= 0) {
            const e = this.t - this._blinkStart;
            if (e < BLINK_CLOSE_S) {
                const u = e / BLINK_CLOSE_S;
                this._blink = 1 - (1 - u) * (1 - u);            // easeOutQuad
            } else if (e < BLINK_CLOSE_S + this._blinkOpenDur) {
                const u = (e - BLINK_CLOSE_S) / this._blinkOpenDur;
                this._blink = 1 - u * u;                        // easeInQuad
            } else {
                this._blink = 0;
                this._blinkStart = -1;
                if (this._doublePending) {
                    this._doublePending = false;
                    this._nextBlinkAt = this.t + BLINK_DOUBLE_GAP;
                } else {
                    this._doublePending = Math.random() < BLINK_DOUBLE_CHANCE;
                    const mean = BLINK_MEAN_QUIET
                        + (BLINK_MEAN_SPEAK - BLINK_MEAN_QUIET) * speak;
                    this._nextBlinkAt = this.t
                        + expGap(mean, BLINK_GAP_MIN, BLINK_GAP_MAX);
                }
            }
        }

        // ── slow blink ────────────────────────────────────────────────
        // Runs on its own clock and overrides the ordinary blink while it
        // lasts, so the two never stack into one long closure.
        if (!this._slowBlink && this._blinkStart < 0 && posing
            && this.t >= this._nextSlowBlinkAt) {
            this._slowBlink = { start: this.t };
            this._nextSlowBlinkAt = this.t + rand(SLOW_BLINK_GAP_MIN, SLOW_BLINK_GAP_MAX);
            // Push the ordinary blink clear of it.
            this._nextBlinkAt = Math.max(this._nextBlinkAt, this.t + 2.2);
        }
        if (this._slowBlink) {
            const e = this.t - this._slowBlink.start;
            const total = SLOW_BLINK_CLOSE + SLOW_BLINK_HOLD + SLOW_BLINK_OPEN;
            if (e < SLOW_BLINK_CLOSE) {
                this._blink = smootherstep(e / SLOW_BLINK_CLOSE);
            } else if (e < SLOW_BLINK_CLOSE + SLOW_BLINK_HOLD) {
                this._blink = 1;
            } else if (e < total) {
                this._blink = 1 - smootherstep(
                    (e - SLOW_BLINK_CLOSE - SLOW_BLINK_HOLD) / SLOW_BLINK_OPEN);
            } else {
                this._blink = 0;
                this._slowBlink = null;
            }
        }

        // ── hand squeeze ──────────────────────────────────────────────
        if (this._squeezeStart < 0 && posing && this.t >= this._nextSqueezeAt) {
            this._squeezeStart = this.t;
            this._squeezeHold = rand(SQUEEZE_HOLD_MIN, SQUEEZE_HOLD_MAX);
            this._nextSqueezeAt = this.t + rand(SQUEEZE_GAP_MIN, SQUEEZE_GAP_MAX);
        }
        if (this._squeezeStart >= 0) {
            const e = this.t - this._squeezeStart;
            const total = SQUEEZE_IN + this._squeezeHold + SQUEEZE_OUT;
            if (e < SQUEEZE_IN) this._squeeze = smootherstep(e / SQUEEZE_IN);
            else if (e < SQUEEZE_IN + this._squeezeHold) this._squeeze = 1;
            else if (e < total) {
                this._squeeze = 1 - smootherstep(
                    (e - SQUEEZE_IN - this._squeezeHold) / SQUEEZE_OUT);
            } else {
                this._squeeze = 0;
                this._squeezeStart = -1;
            }
        }

        // ── mouth events ──────────────────────────────────────────────
        if (!this._mouthEvent && this.t >= this._nextMouthAt) {
            const e = MOUTH_EVENTS[Math.floor(Math.random() * MOUTH_EVENTS.length)];
            this._mouthEvent = { ch: e[0], peak: e[1] * rand(0.7, 1.15), dur: e[2], start: this.t };
            this._nextMouthAt = this.t + rand(MOUTH_EVENT_GAP_MIN, MOUTH_EVENT_GAP_MAX);
        }
        if (this._mouthEvent && this.t - this._mouthEvent.start > this._mouthEvent.dur) {
            this._mouthEvent = null;
        }
        if (this._swallowStart < 0 && this.t >= this._nextSwallowAt) {
            this._swallowStart = this.t;
            this._nextSwallowAt = this.t + rand(SWALLOW_GAP_MIN, SWALLOW_GAP_MAX);
        }
        if (this._swallowStart >= 0 && this.t - this._swallowStart > SWALLOW_DUR) {
            this._swallowStart = -1;
        }

        // ── head, driven from everything above ────────────────────────
        const bodyYaw = sway(t, SWAY_YAW_HZ, SWAY_YAW_AMP);
        const bodyRoll = sway(t, SWAY_ROLL_HZ, SWAY_ROLL_AMP);
        const swallowU = this._swallowStart >= 0
            ? bell((this.t - this._swallowStart) / SWALLOW_DUR) : 0;
        springTo(this._headYaw,
            -bodyYaw * HEAD_COUNTER_YAW
            + drift(t * DRIFT_HZ_HEAD, 21) * HEAD_DRIFT_YAW
            + this._gazeHeadYaw.x,
            HEAD_SPRING_HZ, HEAD_SPRING_ZETA, dt);
        springTo(this._headPitch,
            drift(t * DRIFT_HZ_HEAD, 23) * HEAD_DRIFT_PITCH
            + this._gazeHeadPitch.x
            + swallowU * SWALLOW_HEAD_PITCH,
            HEAD_SPRING_HZ, HEAD_SPRING_ZETA, dt);
        springTo(this._headRoll,
            -bodyRoll * HEAD_COUNTER_ROLL
            + drift(t * DRIFT_HZ_HEAD, 25) * HEAD_DRIFT_ROLL,
            HEAD_SPRING_HZ, HEAD_SPRING_ZETA, dt);
    }

    /** Build the frame's signal bundle from the integrated state. */
    _emit(speak) {
        const t = this.t + this.seed;
        const s = this.sig;
        const k = this.tuning;

        // Depth falls while speaking — you breathe shallow and fast when you
        // are using the air to talk — but a sigh keeps its size.
        const depth = this._breathDepth * (1 - (1 - BREATH_DEPTH_SPEAK) * speak) * k.breath;
        const breath = breathCurve(this._breathPhase);
        s.breath = breath;
        s.breathDepth = depth;

        // ── body sway ─────────────────────────────────────────────────
        // The original three terms — a yaw, a roll, and the slow left-right
        // weight lean — on the spine and chest rather than the hips, so the
        // feet stay planted. Split 60/40 between the two joints so the curve
        // through the torso reads as a bend rather than a hinge.
        const yaw = sway(t, SWAY_YAW_HZ, SWAY_YAW_AMP) * k.sway;
        const roll = sway(t, SWAY_ROLL_HZ, SWAY_ROLL_AMP) * k.sway;
        const lean = Math.sin(t * SWAY_WEIGHT_HZ * 2 * Math.PI) * SWAY_WEIGHT_AMP * k.sway;
        const w = lean / Math.max(SWAY_WEIGHT_AMP, 1e-6);   // −1..1, for the couplings

        s.spineYaw = yaw * 0.6;
        s.spineRoll = (roll + lean) * 0.6;
        s.spinePitch = -breath * depth * SPINE_BREATH_PITCH;
        s.chestYaw = yaw * 0.4;
        // Contrapposto: the shoulders tilt opposite the lean, so a weight
        // shift reads as weight rather than as the whole torso tipping.
        s.chestRoll = (roll + lean) * 0.4 - lean * CHEST_COUNTER_ROLL;
        s.chestPitch = -breath * depth * CHEST_BREATH_PITCH;
        s.shoulderLift = breath * depth * SHOULDER_BREATH_LIFT;
        s.weight = w;

        // ── arms ──────────────────────────────────────────────────────
        // One sway per arm on the same compound waveform, phase-offset so
        // they are not mirrors. The elbow carries half of it, which keeps
        // the forearm part of the same limb without the lag chain that read
        // as snapping.
        const a = k.arms;
        s.armL = sway(t, SWAY_ARM_HZ, SWAY_ARM_AMP, SWAY_PHASE_L) * a;
        s.armR = sway(t, SWAY_ARM_HZ, SWAY_ARM_AMP, SWAY_PHASE_R) * a;
        s.elbowL = s.armL * ARM_ELBOW_SHARE;
        s.elbowR = s.armR * ARM_ELBOW_SHARE;
        s.armPitchL = s.armPitchR = 0;
        s.shoulderDragL = s.shoulderDragR = 0;
        s.handL = s.handR = 0;

        // ── legs: constant ────────────────────────────────────────────
        // Identical every frame. The ankle pitch is the exact negation of the
        // hip and knee pitches, so the soles sit flat; nothing else here
        // varies, so the feet cannot move.
        const g = k.legs;
        s.hipPitchL = s.hipPitchR = HIP_PITCH * g;
        s.kneeL = s.kneeR = KNEE_BEND * g;
        s.hipYawL = s.hipYawR = 0;
        s.footPitchL = s.footPitchR = -(HIP_PITCH + KNEE_BEND) * g;
        s.footYawL = s.footYawR = 0;
        s.footRoll = 0;
        // The pelvis is an anchor, not a moving part — see the note by
        // KNEE_BEND. The weight shift reads through the torso above it.
        s.hipYaw = 0;
        s.hipRoll = 0;
        s.hipShiftX = 0;
        s.hipShiftZ = 0;

        s.headYaw = this._headYaw.x;
        s.headPitch = this._headPitch.x
            + Math.sin(this.t * 0.7 * 2 * Math.PI) * HEAD_NOD_SPEAK * speak;
        s.headRoll = this._headRoll.x
            + Math.sin(this.t * 0.45 * 2 * Math.PI) * HEAD_TILT_SPEAK * speak;
        s.headY = breath * depth * HEAD_BREATH_Y;

        s.blink = this._blink;
        s.squeeze = this._squeeze * SQUEEZE_DEPTH * k.arms;
        s.gazeX = this._gazeX * GAZE_AMP * k.gaze;
        s.gazeY = this._gazeY * GAZE_AMP * k.gaze;

        // ── mouth ─────────────────────────────────────────────────────
        // Silent only. Anything above a whisper of lipsync and the idle
        // mouth is gone entirely — it exists to fill silence, never to
        // fight speech for the same blendshapes.
        const m = s.mouth;
        m.aa = 0; m.ih = 0; m.ou = 0;
        const gate = (1 - Math.min(1, speak * 3)) * k.mouth;
        if (gate > 0.001) {
            const swallowU = this._swallowStart >= 0
                ? bell((this.t - this._swallowStart) / SWALLOW_DUR) : 0;
            // A swallow closes the mouth first, so it suppresses the resting
            // part rather than adding on top of it.
            const open = 1 - swallowU;
            m.aa = (MOUTH_BASE + drift(t * 0.08, 51) * MOUTH_BASE_DRIFT
                + breath * depth * MOUTH_BREATH) * open;
            m.ou = swallowU * 0.12;
            // The slow blink's companion mouth movement — a small purse
            // that peaks with the held beat, so the two land together.
            if (this._slowBlink) {
                const e = this.t - this._slowBlink.start;
                const total = SLOW_BLINK_CLOSE + SLOW_BLINK_HOLD + SLOW_BLINK_OPEN;
                m.ou = Math.max(m.ou, bell(e / total) * SLOW_BLINK_MOUTH * open);
            }
            const ev = this._mouthEvent;
            if (ev) {
                const v = ev.peak * bell((this.t - ev.start) / ev.dur) * open;
                m[ev.ch] = Math.max(m[ev.ch], v);
            }
            m.aa = Math.max(0, m.aa) * gate;
            m.ih *= gate;
            m.ou *= gate;
        }
    }
}
