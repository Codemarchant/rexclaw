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
// With the face director on, that steady speaking nod and tilt give way to
// the director's head: timed moves (nods on stressed words and on a "yes",
// shakes on a "no", sweeps — see addHeadMove) and a posture the line's
// feeling holds the head in; the sizes and timings are face_motion.js's
// FACE_HEAD_* constants. The moves ride outside the neck spring, like the
// speaking nod did: they are authored curves, and the spring would round a
// nod away.
// A real nod bends the whole neck, not just the skull on top of it, and
// every realizer spreads it: half to the neck and half to the head
// (VMagicMirror), a third each across two spine joints and the skull
// (SmartBody), a share per cervical vertebra (Greta). With one neck joint
// to work with, half and half.
const DIRECTOR_NECK_SHARE = 0.5;

// ── Torso / limb amplitudes (radians) ──────────────────────────────────
const SPINE_BREATH_PITCH = 0.013;       // spine extends a little on the inhale
const CHEST_BREATH_PITCH = 0.017;
const SHOULDER_BREATH_LIFT = 0.021;
// Contrapposto: the shoulders tilt opposite the lean, so a weight shift
// reads as weight rather than as the whole torso tipping over.
const CHEST_COUNTER_ROLL = 0.013;
const HEAD_BREATH_Y = 0.011;            // metres of head rise on a full inhale

// ── Arms ───────────────────────────────────────────────────────────────
// The arms do not sway. They used to, on the body's sine waveform, and it
// read as a machine: nothing supports it — measured upper-arm motion in
// quiet standing is a few hundredths of a m/s² (Kutilek et al. 2017, Acta
// Gymnica 47:24), and freeing or restraining the arms changes nothing
// about two-footed standing (Objero et al. 2019, Gait Posture 74:71); the
// reference idles' arms move 1–2.5° in 40 s. They HANG — the renderer sets
// them against gravity (idle_pose.js hangArm), so the torso's sway moves past them —
// and now and then one re-settles (see ARM_GAP_MEAN). The drag chain that
// was once here — a cascade of springs staggering shoulder, elbow and
// wrist — is what read as the arms snapping between positions, so it is
// gone; the settles are the held-posture version of it, without springs.

// ── Legs ───────────────────────────────────────────────────────────────
// The leg ANGLES here are the neutral stance and never change. What moves
// is the weight: `stance` (−1..1, > 0 loads the left leg) says which foot
// carries the body, and idle_pose.js plantFeet moves the pelvis over
// that foot and solves both legs back onto their planted spots with IK.
// Before that IK existed the pelvis had to be a constant — the feet are
// children of the hips, so anything it did slid them across the floor —
// and the legs were the one part of the idle that never moved.
//
// The stance is piecewise-static, the way prolonged standing is: the
// weight sits on both legs, or mostly on one, holds, and changes.
//   STANCE — a stance held at least 7.5 s and then changed: about twice a
//            minute (17–22 per 10 min, Wiggermann & Keyserling 2013, Human
//            Factors 55:764; ~2/min, Duarte, Harvey & Zatsiorsky 2000;
//            2.2/min, Freitas et al. 2005), so ~30 s a stance. Where it
//            lands is bimodal — even, or ~87/13 onto one leg — with 27% of
//            the time on one leg across the sample (women 37%, men 14%;
//            Prado-Rico & Duarte 2019, Motor Control 23:553). Even is the
//            DEFAULT: a draw lands on one leg with that 27%, so the
//            companion mostly stands square and rests on a leg for tens of
//            seconds now and then (one recorded trace: 40–90 s rests).
//   FIDGET — the weight goes out and comes back: every 49 ± 16 s
//            sideways, a change of over 10% of body weight lasting
//            0.75–7.5 s (Duarte & Zatsiorsky 1999, Motor Control 3:12;
//            Rekant et al. 2019's detection window).
// (The slow drift between those is pink noise; the torso's sway covers
// it.)
//
// How long a shift takes and what the free foot does have no figure in
// that literature, so they are measured off the authored idles (their feet
// are locked to the millimetre while the pelvis travels, so they were made
// with foot IK too): the weight crosses in about one and a half seconds,
// and two weight events in five also lift the freed heel — pivoting on the
// toes, about 2 cm — and set the foot down 2–3 cm away, outward and
// forward. That shuffle is the nearest thing to "the legs doing
// something" the references have.
const KNEE_BEND = 0.13;                 // ~7.5 deg; locked legs read as stiff
const HIP_PITCH = -0.06;                // slight forward tilt at the hip
const STANCE_GAP_MEAN = 30;             // s a stance is held
const STANCE_GAP_MIN = 7.5;             // the definition of a held stance
const STANCE_GAP_MAX = 120;
const STANCE_P_ASYM = 0.27;             // a change lands on one leg; else on both
const STANCE_MOVE_MIN = 1.2;            // s the weight takes to move across
const STANCE_MOVE_MAX = 2.0;
const FIDGET_GAP_MEAN = 49;             // s, 49 ± 16
const FIDGET_GAP_SD = 16;
const FIDGET_GAP_MIN = 12;
const FIDGET_AMP_MIN = 0.3;             // of a full stance (37% of body weight): over 10%
const FIDGET_AMP_MAX = 0.6;
const FIDGET_OUT = 0.8;                 // s; out + hold + back stays inside 0.75–7.5
const FIDGET_HOLD_MAX = 2.0;
const FIDGET_BACK = 1.0;
// The shuffle is an OUT-AND-BACK, not a reposition: in both references
// that have one, the foot lifts, drifts 2.2–2.7 cm out and 1.8–2.4 cm
// forward with the heel up 2.2–2.3 cm, and sets down again exactly where
// it started — 4.2 s in all, 2.7 s of it going out and 1.5 s coming home.
// Each shuffle draws its own size and length around those.
const SHUFFLE_P = 0.4;                  // a weight event that also lifts the free foot
const SHUFFLE_AT = 0.6;                 // of the shift, when the heel leaves
const SHUFFLE_DUR = 4.2;                // s, out and home
const SHUFFLE_RISE = 0.64;              // of it spent going out
const SHUFFLE_LIFT = 0.022;             // m, heel rise at the far point
const SHUFFLE_OUT = 0.024;              // m, outward at the far point
const SHUFFLE_FWD = 0.021;              // m, forward at the far point


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
export const GAZE_AMP = 0.26;           // world units of look-at offset
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
// Its curve is the reference's, frame by frame (the one with its squeeze):
// 0.35 s to close, about 0.45 s held, 0.3 s to open — and held at 0.9, not shut: the
// lids rest just short of closed, which is much of why it reads as soft.
// (It was 0.26 / 0.34 / 0.38 to fully shut, and read as quick.)
const SLOW_BLINK_GAP_MIN = 38;
const SLOW_BLINK_GAP_MAX = 95;
const SLOW_BLINK_CLOSE = 0.35;
const SLOW_BLINK_HOLD = 0.45;
const SLOW_BLINK_OPEN = 0.30;
const SLOW_BLINK_PEAK = 0.9;
const SLOW_BLINK_MOUTH = 0.09;          // the mouth movement that goes with it

// ── Hand fidgets ───────────────────────────────────────────────────────
// What the authored idles' hands actually do, measured off the four local
// reference clips (40 s loops; see the stance note for the method): the
// fingers hold still almost all of the time — median finger speed is
// zero — and roughly once a loop one hand does ONE thing, while the other
// hand answers with a small ripple at the same instant. Three kinds, drawn
// per event:
//   squeeze — a slow, nearly full fist and open again, often both hands.
//             Measured: the fingers first open a touch (6–8° over 0.4 s),
//             then close over 2.2 s — mostly at the middle and end joints
//             (+88°, +60°), the knuckles only 12° at the index rising to
//             60° at the little finger — peak for about 0.3 s and open
//             over 1.8 s, the two hands within 0.2 s of each other, the
//             thumb still. Every finger moves together.
//   rub     — measured: the index hooks at its middle joint (+96° in 0.4 s),
//             the thumb comes across to it 0.3 s later (+26°), the wrist
//             flexes 8°, the pair holds about 1.4 s and lets go over 0.8 s
//             with a flick through the other fingers on the way out.
//   ripple  — a quick wave across the fingers, little to index.
// The literature agrees on the stillness — in everyday life every hand
// joint is under 10°/s about half the time (Ingram et al. 2008, Exp Brain
// Res 188:223) — but has no rate or size for a resting squeeze or rub, so
// the gap is the reference's one-a-loop, averaged.
// Hands are busier around a change of speaker: small self-touches and
// fidgets run at 0.024/s mid-turn and 0.041/s within ±2 s of a turn change
// (Żywiczyński et al. 2017, Interaction Studies 18(2); seated interviews).
// The difference over that 4 s window is 0.068 extra events per change —
// so at each start or end of the companion's own speech, that chance of a
// fidget inside the next 2 s. Speech "ends" after a quiet stretch, not at
// every pause between words; the stretch is a design choice.
const HAND_P_TURN = 0.068;
const HAND_TURN_WINDOW = 2;             // s
const TURN_QUIET_S = 0.7;
const HAND_GAP_MEAN = 40;               // s between events, either hand
const HAND_GAP_MIN = 10;
const HAND_GAP_MAX = 120;
const HAND_P_RUB = 0.3;
const HAND_P_RIPPLE = 0.25;             // the rest are squeezes
const HAND_P_ANSWER = 0.5;              // the other hand ripples with a rub
const HAND_P_BOTH = 0.5;                // a squeeze in both hands, as the reference's
const HAND_BOTH_LAG = 0.2;              // s, the second hand at most this late
const FINGER_STAGGER = 0.07;            // s between neighbouring fingers (ripple)
const SQUEEZE_PREOPEN = 0.4;            // s
const SQUEEZE_OPEN = -0.35;             // of the rest curl: the 6–8° opening first
const SQUEEZE_IN = 2.2;
const SQUEEZE_HOLD_MAX = 0.4;
const SQUEEZE_OUT = 1.8;
const SQUEEZE_DEPTH_MIN = 0.6;          // of the full fist (the renderer's IDLE_FIST_*)
// Each joint's window, as [start, end] shares of the close and of the
// open. The ORDER is measured (see _handPose); the overlaps are not.
const FIST_MIDDLE_CLOSE = [0, 0.85];
const FIST_END_CLOSE = [0.1, 0.95];
const FIST_KNUCKLE_CLOSE = [0.15, 1];
const FIST_MIDDLE_OPEN = [0.15, 1];
const FIST_END_OPEN = [0, 0.85];
const FIST_KNUCKLE_OPEN = [0, 0.85];
// The reference's close (2.2 s) is slower than a clinical "make a fist"
// (0.5–1.0 s median, Mentzel et al. 2011) — an idle squeeze is not a test —
// and its timing is the one kept.
const RUB_HOOK = 1.0;                   // rad added at the index's middle joint
const RUB_HOOK_IN = 0.4;
const RUB_THUMB_DELAY = 0.3;
const RUB_THUMB_IN = 0.5;
const RUB_HOLD_MIN = 1.0;
const RUB_HOLD_MAX = 1.8;
const RUB_OUT = 0.8;
const RUB_WRIST = 0.14;                 // rad of wrist flexion
// The face goes with the hands. In every reference the hand's event is a
// MOMENT, not a hand on its own:
//   squeeze — a soft closed smile starts with it (the mouth corners
//            to ~0.25, in over 1.6 s, then fading slowly — still ~0.1 three
//            seconds later), a slow blink at +0.75 s (closed by +1.0, held
//            ~0.5 s), and the eyes change fixation under the closed lids.
//   rub — the eyes go down and aside toward the hand (look-
//            down ~0.5) with a double blink at +0.7 and +1.5 s.
// The smile goes through the face director's per-model smile channel
// (FaceMotion.idleSmile), never the whole-face `happy`.
const MOMENT_SMILE = 0.25;              // smile channel weight at the peak
const MOMENT_SMILE_RISE = 1.6;          // s
const MOMENT_SMILE_HOLD = 0.3;
const MOMENT_SMILE_FALL = 3.5;
const MOMENT_SLOW_BLINK_AT = 0.75;      // s after the squeeze starts
const MOMENT_RUB_BLINKS = [0.7, 1.5];   // s after the rub starts
const MOMENT_RUB_GAZE_X = 0.5;          // toward the hand, of the gaze range
const MOMENT_RUB_GAZE_Y = -0.9;         // down
const RIPPLE_DUR = 0.4;                 // each finger's flick
const RIPPLE_DEPTH = 0.5;

// ── Arm settles ────────────────────────────────────────────────────────
// The reference whose arms read most alive re-poses an elbow about five
// times a minute — 3–10° of bend, each move about two seconds — and HOLDS
// between; the other two references barely move their arms at all.
// The posture literature has no figure for the arms of a person standing
// (passive arm sway has been recorded but not reported), so that
// reference's rate and sizes are the ones used. Piecewise-static, like the stance. Every so
// often one arm eases to a slightly different hang (upper arm fore/aft, elbow bend, forearm roll,
// wrist) along a minimum-jerk path and stays there. This is NOT the old
// stepped "adjustment" that read as snapping: that one went through a
// cascade of fast springs, which overshoot; a two-second smootherstep has
// zero velocity and acceleration at both ends and cannot.
const ARM_GAP_MEAN = 12;                // s, per arm
const ARM_GAP_MIN = 3;
const ARM_GAP_MAX = 40;
const ARM_MOVE_MIN = 1.5;
const ARM_MOVE_MAX = 2.4;
const ARM_PITCH = 0.05;                 // rad, ± range of each new hang
const ARM_FLEX = 0.09;
const ARM_TWIST = 0.12;
const ARM_WRIST = 0.06;
const ARM_P_WITH_STANCE = 0.5;          // a weight shift re-hangs an arm too

// ── Hand on hip ────────────────────────────────────────────────────────
// Now and then one hand goes to the hip and rests there, then comes back:
// a posture change, held, not a gesture. The renderer places it (IK onto
// the model's own hip surface); this only says when and how far along.
// The movement is measured — a self-paced reach of about 30 cm takes
// 1.21 ± 0.22 s with its peak speed 34% of the way in, and the hand's
// return to rest 1.00 ± 0.14 s on a bell (Alt Murphy et al. 2006, J
// NeuroEng Rehabil 3:18; seated, the nearest there is). How often and how
// long the hand stays are NOT: no study has counted hands on hips, so
// those are authored.
// It comes with the weight: the body shifts onto the leg on the hand's
// side — the hip that juts out is the one the hand goes to — for as long
// as the hand stays, and back after (the stance clock waits for it). The
// fingers lie flat on the hip: the resting curl would tuck them into it.
const HIP_GAP_MEAN = 150;               // s between, a session's pace applied
const HIP_GAP_MIN = 40;
const HIP_GAP_MAX = 420;
const HIP_RETRY = 3;                    // s before a busy turn tries again
const HIP_FINGERS_FLAT = 0.6;           // share of the resting curl let go on the hip (authored)
const HIP_REACH = 1.21;                 // s to get there
const HIP_REACH_SD = 0.22;
const HIP_REACH_SKEW = 1.5;             // time warp putting the peak speed at 34%
const HIP_HOLD_MIN = 6;                 // s it rests
const HIP_HOLD_MAX = 20;
const HIP_RETURN = 1.0;                 // s back to the side
const HIP_RETURN_SD = 0.14;

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

// ── Variety ────────────────────────────────────────────────────────────
// Nobody does the same thing twice. Every limb event draws its own size,
// speed and hold around the measured value (`vary`), and its gap at random
// around the measured mean: from the measured spread where there is one
// (`normalGap`), else from an exponential (`expGap`, as the blink and the
// listener's nods do), so runs of two close together and long still
// stretches both happen. The variety is per event only: nothing is rolled
// once and held for a session (a per-load "temperament" was tried, and
// read as a companion that had simply stopped doing things).
// The spreads are a design choice: the literature gives a variability for
// the timing (the fidget interval's SD is a third of its mean, Duarte &
// Zatsiorsky 1999, which the exponential's spread covers) and none for
// the size of a person's movements from one time to the next.
const VARY = 0.25;                      // ± share an event's size or speed varies

/** `center` jittered by up to ± `spread` of itself. */
function vary(center = 1, spread = VARY) {
    return center * (1 + (Math.random() * 2 - 1) * spread);
}

/** Normal draw, mean `m` and SD `sd`, no shorter than `lo`. */
function normalGap(m, sd, lo) {
    const g = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    return Math.max(lo, m + g * sd);
}

/** Exponential draw with mean `m`, clamped — heavy-tailed inter-event gaps. */
function expGap(m, lo, hi) {
    const g = -Math.log(1 - Math.random() * 0.999) * m;
    return Math.max(lo, Math.min(hi, g));
}

/** The mean of expGap(m, lo, hi): lo plus P(X > x) integrated over [lo, hi]. */
function expGapMean(m, lo, hi) {
    return lo + m * (Math.exp(-lo / m) - Math.exp(-hi / m));
}

/** The idle events a look can switch off (pose_tuning[id] === false; the
 *  tuning dialog lists them), with roughly how many start per hour of
 *  standing idle, worked out from the gaps above. The events wait on each
 *  other now and then, so it is a guide, not a count.
 *  - weight_shift: the stance draws a new spot every gap and moves with
 *    odds 2a − 1.5a² (a = STANCE_P_ASYM: the weight rests on one leg a of
 *    the time), a move adding its own length to the wait; plus the
 *    fidgets, out and back on their own gap.
 *  - hand_on_hip: its gap runs from one start to the next. */
const STANCE_P_MOVE = 2 * STANCE_P_ASYM - 1.5 * STANCE_P_ASYM ** 2;
export const IDLE_EVENTS = [
    {
        id: "weight_shift",
        perHour: 3600 * STANCE_P_MOVE / (expGapMean(STANCE_GAP_MEAN, STANCE_GAP_MIN, STANCE_GAP_MAX)
            + STANCE_P_MOVE * (STANCE_MOVE_MIN + STANCE_MOVE_MAX) / 2)
            + 3600 / (FIDGET_GAP_MEAN + FIDGET_OUT + FIDGET_HOLD_MAX / 2 + FIDGET_BACK),
    },
    { id: "hand_on_hip", perHour: 3600 / expGapMean(HIP_GAP_MEAN, HIP_GAP_MIN, HIP_GAP_MAX) },
];

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

/** A held value that moves: `from` until `start`, `to` after `start +
 *  dur`, a minimum-jerk path between (smootherstep is that polynomial,
 *  Flash & Hogan 1985). */
function glide(m, t) {
    return m.from + (m.to - m.from) * smootherstep((t - m.start) / m.dur);
}

/** Ease a channel from wherever it is now to `to`. */
function glideTo(m, to, start, dur) {
    m.from = glide(m, start);
    m.to = to;
    m.start = start;
    m.dur = dur;
}

function held(v = 0) {
    return { from: v, to: v, start: 0, dur: 1 };
}

/** 0→1→0 over u ∈ [0,1] as a raised cosine: unlike `bell`, it leaves and
 *  arrives with zero velocity, so a flick does not start with a jolt. */
function hump(u) {
    return u > 0 && u < 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * u) : 0;
}

/** In, hold, out: 0→1, 1, 1→0 on smootherstep ramps; 0 outside. */
function plateau(e, tin, hold, tout) {
    if (e <= 0) return 0;
    if (e < tin) return smootherstep(e / tin);
    if (e < tin + hold) return 1;
    return 1 - smootherstep((e - tin - hold) / tout);
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
            arms: 1,        // arm settles
            hands: 1,       // finger fidgets
            legs: 1,        // the knee bend / ankle pose, weight shifts, shuffles
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

        // face director's head (set per frame by the renderer; see
        // addHeadMove). `pitch` > 0 bows the head; `down` is the sign of a
        // head-pitch rotation that looks down on this rig (it flips with
        // the way the model faces). `hold` 0..1 keeps the eyes on the
        // viewer: the glances and aversions thin out toward none.
        this.director = { on: false, down: 1, pitch: 0, yaw: 0, roll: 0, hold: 0 };
        this._moves = [];

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

        // hands: the event running on each, [left, right]
        this._hand = [null, null];
        // a hand moment's face: queued blinks, a forced glance, and cues
        // for the renderer (a smile) — see MOMENT_*
        this._blinkQueue = [];
        this._glanceAt = -1;
        this._cues = [];
        this._turnSpeaking = false;       // the companion's turn, with hysteresis
        this._turnQuiet = 0;
        this._turnFidgetAt = -1;
        // a hand resting on the hip, [left, right], and the sides this
        // model can't do (the renderer says so: blockHip)
        this._hip = [null, null];
        this._hipBlocked = [false, false];
        this._nextHipAt = expGap(HIP_GAP_MEAN, HIP_GAP_MIN, HIP_GAP_MAX);
        this._nextHandAt = expGap(HAND_GAP_MEAN / 2, HAND_GAP_MIN, HAND_GAP_MAX);

        // arms: each channel a held value that glides to a new one
        this._arm = [0, 1].map(() => ({
            pitch: held(), flex: held(), twist: held(), wrist: held(),
            next: expGap(ARM_GAP_MEAN, ARM_GAP_MIN, ARM_GAP_MAX),
        }));

        // stance and the feet's spots
        this._weightOn = true;            // the look allows weight shifts (setEventAllowed)
        this._forceStance = false;        // the next shift is a played one (playEvent)
        this._stance = held();
        this._nextStanceAt = expGap(STANCE_GAP_MEAN, STANCE_GAP_MIN, STANCE_GAP_MAX);
        this._fidget = null;
        this._nextFidgetAt = normalGap(FIDGET_GAP_MEAN, FIDGET_GAP_SD, FIDGET_GAP_MIN);
        this._foot = [null, null];        // the shuffle running on each foot

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
            // arms: the settle's hang (pitch), forearm roll (elbow), bend
            // (flex) and wrist
            armPitchL: 0, armPitchR: 0,
            elbowL: 0, elbowR: 0,
            flexL: 0, flexR: 0, wristL: 0, wristR: 0,
            hipL: 0, hipR: 0,                         // a hand on the hip, 0..1
            // per hand: extra curl per finger [index, middle, ring, little],
            // the index's hook, the thumb coming across
            // the fist per joint, [knuckle, middle, end], the same on every finger
            fingersL: { curl: [0, 0, 0, 0], fist: [0, 0, 0], hook: 0, thumb: 0 },
            fingersR: { curl: [0, 0, 0, 0], fist: [0, 0, 0], hook: 0, thumb: 0 },
            // legs: full angles, so the ankle compensation below is exact
            hipPitchL: 0, hipPitchR: 0, hipYawL: 0, hipYawR: 0,
            kneeL: 0, kneeR: 0,
            footPitchL: 0, footPitchR: 0, footRoll: 0,
            footYawL: 0, footYawR: 0,
            hipShiftX: 0, hipShiftZ: 0,
            weight: 0,
            // which leg carries the body (> 0 left), and each foot's spot
            // relative to its rest one: metres outward / forward, heel lift
            stance: 0,
            footL: { out: 0, fwd: 0, lift: 0 },
            footR: { out: 0, fwd: 0, lift: 0 },
            headYaw: 0, headPitch: 0, headRoll: 0, headY: 0,
            neckPitch: 0, neckYaw: 0, neckRoll: 0,   // the director's share of a head move
            breath: 0, breathDepth: 1,
            blink: 0,
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

    /** A head move from the face director (face_motion.js builds them):
     *  `keys` [[seconds, radians], …] on one axis — "pitch" (+ bows the
     *  head), "yaw" or "roll" — starting `delay` seconds from now. Between
     *  keys the head follows a minimum-jerk path: smootherstep is that
     *  polynomial (Flash & Hogan 1985), so each swing leaves and arrives
     *  with no jolt in speed or acceleration. Moves add together. */
    addHeadMove({ axis, keys, delay = 0 }) {
        if (!keys?.length || !["pitch", "yaw", "roll"].includes(axis)) return;
        this._moves.push({ axis, keys, start: this.t + Math.max(0, delay) });
    }

    /** Drop moves not yet started (a barge-in cut the line they belong to). */
    clearHeadMoves() {
        this._moves = this._moves.filter((m) => m.start <= this.t);
    }

    /** The moves' summed head offset now: [pitch, yaw, roll]. Finished
     *  moves go. */
    _headMoves() {
        const out = { pitch: 0, yaw: 0, roll: 0 };
        this._moves = this._moves.filter((m) => {
            const t = this.t - m.start;
            const last = m.keys[m.keys.length - 1];
            if (t >= last[0]) return false;
            if (t < 0) return true;
            let i = 1;
            while (m.keys[i][0] <= t) i++;
            const [t0, v0] = m.keys[i - 1];
            const [t1, v1] = m.keys[i];
            out[m.axis] += v0 + (v1 - v0) * smootherstep((t - t0) / (t1 - t0));
            return true;
        });
        return out;
    }

    /** Move the weight and leave it there: onto one leg (either, which may
     *  be the other one) or onto both. A draw that lands where the weight
     *  already is just keeps the stance — the clock still restarts. */
    _shiftStance() {
        const now = this.t;
        const cur = this._stance.to;
        let to = Math.random() < STANCE_P_ASYM ? (Math.random() < 0.5 ? 1 : -1) : 0;
        // A played one always shows: onto the other leg, or from both onto one.
        if (this._forceStance) {
            to = -Math.sign(cur) || (Math.random() < 0.5 ? 1 : -1);
            this._forceStance = false;
        }
        this._nextStanceAt = now + expGap(STANCE_GAP_MEAN, STANCE_GAP_MIN, STANCE_GAP_MAX);
        if (to === Math.sign(cur)) return;
        const dur = rand(STANCE_MOVE_MIN, STANCE_MOVE_MAX);
        // How far onto the leg varies a little too: the bimodal stance is
        // a mode, not a fixed point.
        glideTo(this._stance, to * Math.min(1, vary(1, 0.12)), now, dur);
        this._nextStanceAt += dur;
        // The leg that just came free sometimes re-places its foot.
        if (to) this._maybeShuffle(to, now + dur * SHUFFLE_AT);
        // A body re-organising its weight re-hangs an arm as it goes: brought
        // forward on the arm's own clock, so the settle starts from where the
        // arm is then (a start set in the future would glide from where its
        // current move will be by then, and jump there now).
        if (Math.random() < ARM_P_WITH_STANCE) {
            const a = this._arm[Math.random() < 0.5 ? 0 : 1];
            a.next = Math.min(a.next, now + 0.3);
        }
    }

    /** Weight out toward one leg and back, the stance unchanged after. */
    _startFidget() {
        const now = this.t;
        const cur = this._stance.to;
        // Toward a leg the stance does not already rest on fully.
        const side = cur >= 0.99 ? -1 : cur <= -0.99 ? 1 : (Math.random() < 0.5 ? 1 : -1);
        const amp = side * rand(FIDGET_AMP_MIN, FIDGET_AMP_MAX);
        const out = FIDGET_OUT * vary();
        const back = FIDGET_BACK * vary();
        let hold = rand(0, FIDGET_HOLD_MAX);
        // Only a foot the weight actually leaves can shuffle, and the
        // weight stays off it until the foot is home again.
        if (Math.sign(cur + amp) === side) {
            const d = this._maybeShuffle(side, now + out * SHUFFLE_AT);
            if (d) hold = Math.max(hold, d - out * (1 - SHUFFLE_AT));
        }
        this._fidget = { start: now, out, hold, back, amp };
        this._nextFidgetAt = now + out + hold + back
            + normalGap(FIDGET_GAP_MEAN, FIDGET_GAP_SD, FIDGET_GAP_MIN);
    }

    /** With SHUFFLE_P, the foot the weight is moving off (`toward` > 0 is
     *  toward the left leg, which frees the right) shuffles: the heel
     *  rises on the toes, the foot drifts out and forward, and it comes
     *  home to the same spot. Returns how long that takes, or 0. */
    _maybeShuffle(toward, at) {
        if (Math.random() >= SHUFFLE_P) return 0;
        const i = toward > 0 ? 1 : 0;
        if (this._foot[i]) return 0;
        const size = vary();
        this._foot[i] = {
            start: at,
            dur: SHUFFLE_DUR * vary(),
            rise: SHUFFLE_RISE * vary(1, 0.1),
            lift: SHUFFLE_LIFT * size,
            out: SHUFFLE_OUT * size * vary(),
            fwd: SHUFFLE_FWD * size * vary(),
        };
        return this._foot[i].dur;
    }

    /** Ease one arm (0 left, 1 right) to a new hang and hold it. Each
     *  channel is drawn around the rest pose, not from the last hang, so
     *  the arm never wanders off. */
    _settleArm(i, start) {
        const a = this._arm[i];
        const dur = rand(ARM_MOVE_MIN, ARM_MOVE_MAX);
        glideTo(a.pitch, rand(-1, 1) * ARM_PITCH, start, dur);
        glideTo(a.flex, rand(-1, 1) * ARM_FLEX, start, dur);
        glideTo(a.twist, rand(-1, 1) * ARM_TWIST, start, dur);
        glideTo(a.wrist, rand(-1, 1) * ARM_WRIST, start, dur);
        a.next = start + dur + expGap(ARM_GAP_MEAN, ARM_GAP_MIN, ARM_GAP_MAX);
    }

    /** Start a hand fidget: `kind` or one drawn by the HAND_P_* odds, on
     *  hand `i` or either. A squeeze takes both hands half the time; a rub
     *  is answered by a ripple in the other hand half the time. Returns
     *  whether anything started (a busy hand refuses). */
    fidgetHands(kind = null, i = Math.random() < 0.5 ? 0 : 1) {
        if (this._hand[i] || this._hip[i]) return false;
        if (!kind) {
            const r = Math.random();
            kind = r < HAND_P_RUB ? "rub" : r < HAND_P_RUB + HAND_P_RIPPLE ? "ripple" : "squeeze";
        }
        this._hand[i] = this._handEvent(kind);
        this._moment(kind, i, this._hand[i]);
        const other = 1 - i;
        if (!this._hand[other] && !this._hip[other]) {
            if (kind === "squeeze" && Math.random() < HAND_P_BOTH) {
                this._hand[other] = this._handEvent("squeeze", rand(0, HAND_BOTH_LAG));
            } else if (kind === "rub" && Math.random() < HAND_P_ANSWER) {
                this._hand[other] = this._handEvent("ripple");
            }
        }
        return true;
    }

    /** The face that goes with a hand event on hand `i` (see MOMENT_*). */
    _moment(kind, i, e) {
        const now = this.t;
        if (kind === "squeeze") {
            this._cues.push({
                kind: "smile",
                weight: MOMENT_SMILE * vary(1, 0.2),
                rise: MOMENT_SMILE_RISE * vary(1, 0.15),
                hold: MOMENT_SMILE_HOLD,
                fall: MOMENT_SMILE_FALL * vary(1, 0.2),
            });
            const at = now + MOMENT_SLOW_BLINK_AT * vary(1, 0.15);
            this._nextSlowBlinkAt = Math.min(this._nextSlowBlinkAt, at);
            // The eyes move on while the lids are shut.
            this._glanceAt = at + SLOW_BLINK_CLOSE;
        } else if (kind === "rub") {
            for (const at of MOMENT_RUB_BLINKS) this._blinkQueue.push(now + at * vary(1, 0.15));
            // A look down at the hand — unless the face director is
            // holding eye contact.
            if (this.director.hold < 0.5) {
                this._gazeX = (i === 0 ? 1 : -1) * MOMENT_RUB_GAZE_X;
                this._gazeY = MOMENT_RUB_GAZE_Y;
                this._avertUntil = now + RUB_HOOK_IN * e.k + e.hold;
                this._nextGazeAt = this._avertUntil;
            }
        }
    }

    /** The renderer can't put hand `i` (0 left, 1 right) on this model's
     *  hip: drop an event running there — its weight shift goes back to
     *  both legs — and never pick that side again for this model (reset()
     *  runs on every avatar swap). */
    blockHip(i) {
        this._hipBlocked[i] = true;
        if (this._hip[i]) {
            this._hip[i] = null;
            glideTo(this._stance, 0, this.t, rand(STANCE_MOVE_MIN, STANCE_MOVE_MAX));
        }
    }

    /** Whether this look lets the idle put a hand on the hip at all (the
     *  renderer reads the look's pose_tuning.hand_on_hip). Off blocks both
     *  sides — a hand already on its way or resting there goes home from
     *  where it is, on its own return — and on clears the blocks and
     *  restarts the clock; a side the model can't do blocks itself again. */
    setHipAllowed(on) {
        if (!on) {
            for (let i = 0; i < 2; i++) {
                this._hipBlocked[i] = true;
                const h = this._hip[i];
                if (h && h.cut === undefined) {
                    h.from = this._hipU(h, this.t);
                    h.cut = this.t;
                    glideTo(this._stance, 0, this.t, rand(STANCE_MOVE_MIN, STANCE_MOVE_MAX));
                }
            }
            return;
        }
        this._hipBlocked = [false, false];
        if (this._nextHipAt === Infinity) {
            this._nextHipAt = this.t + expGap(HIP_GAP_MEAN, HIP_GAP_MIN, HIP_GAP_MAX);
        }
    }

    /** Whether this look allows idle event `id` (IDLE_EVENTS; the renderer
     *  reads the look's pose_tuning[id]). Weight shifts off: none start,
     *  and the weight goes back onto both legs whenever no hand is on the
     *  hip (that pose leans onto its own side as part of it). */
    setEventAllowed(id, on) {
        if (id === "hand_on_hip") this.setHipAllowed(on);
        else if (id === "weight_shift") this._weightOn = on;
    }

    /** The tuning dialog's ▶: start idle event `id` as soon as the body is
     *  free (a fidget or a hand on the hip finishes first). */
    playEvent(id) {
        if (id === "hand_on_hip") {
            this._nextHipAt = 0;
        } else if (id === "weight_shift") {
            this._forceStance = true;
            this._nextStanceAt = 0;
        }
    }

    /** How far hand-on-hip event `h` is toward the hip at `t`, 0..1: out on
     *  the skewed reach, home on a plain bell — or, cut short
     *  (setHipAllowed), home from where it was on the same return. */
    _hipU(h, t) {
        const e = t - h.start;
        if (h.cut !== undefined) return h.from * (1 - smootherstep((t - h.cut) / h.back));
        if (e < h.reach) return smootherstep(1 - Math.pow(1 - Math.max(0, e / h.reach), HIP_REACH_SKEW));
        return plateau(e, h.reach, h.hold, h.back);
    }

    /** Cues for the renderer since the last call (a moment's smile). */
    takeCues() {
        if (!this._cues.length) return null;
        const out = this._cues;
        this._cues = [];
        return out;
    }

    _handEvent(kind, delay = 0) {
        const e = { kind, start: this.t + delay, hold: 0, k: vary() };
        if (kind === "squeeze") {
            // A full fist sometimes, a half one other times.
            e.depth = rand(SQUEEZE_DEPTH_MIN, 1);
            e.pre = SQUEEZE_PREOPEN * vary();
            e.tin = SQUEEZE_IN * vary();
            e.tout = SQUEEZE_OUT * vary();
            e.hold = rand(0, SQUEEZE_HOLD_MAX);
            e.total = delay + e.pre + e.tin + e.hold + e.tout;
        } else if (kind === "rub") {
            e.depth = vary(1, 0.15);
            e.hold = rand(RUB_HOLD_MIN, RUB_HOLD_MAX);
            e.total = (RUB_HOOK_IN + RUB_OUT + RIPPLE_DUR + 3 * FINGER_STAGGER) * e.k + e.hold + 0.2;
        } else {
            e.depth = vary();
            e.total = (RIPPLE_DUR + 3 * FINGER_STAGGER) * e.k;
        }
        return e;
    }

    /** One hand's fidget now, written into `f`; returns its wrist flexion.
     *  Fingers run index..little, and the ripples start at the little
     *  finger — the order the reference's run in. Every curve here leaves
     *  and arrives with zero velocity (smootherstep ramps, cosine humps). */
    _handPose(e, f) {
        f.curl.fill(0);
        f.fist.fill(0);
        f.hook = 0;
        f.thumb = 0;
        if (!e) return 0;
        const x = this.t - e.start;
        if (x < 0) return 0;
        const k = e.k;
        const lag = (i) => (3 - i) * FINGER_STAGGER * k;
        if (e.kind === "squeeze") {
            // Open a touch, then close, peak, open. The fingers move
            // together, but the joints of each do not: closing, the middle
            // joint leads, the end joint trails it and the knuckle finishes
            // last; opening runs the other way, end joint and knuckle
            // first (Mentzel et al. 2011; Li et al. 2023). The windows are
            // [start, end] shares of the close and of the open.
            const open = SQUEEZE_OPEN * plateau(x, e.pre, 0, e.tin * 0.3);
            const x2 = x - e.pre;
            const joint = ([c0, c1], [o0, o1]) => {
                if (x2 <= 0) return 0;
                const shut = e.tin + e.hold;
                if (x2 < shut) return smootherstep((x2 - c0 * e.tin) / ((c1 - c0) * e.tin));
                return 1 - smootherstep((x2 - shut - o0 * e.tout) / ((o1 - o0) * e.tout));
            };
            f.curl.fill(open);
            f.fist[0] = e.depth * joint(FIST_KNUCKLE_CLOSE, FIST_KNUCKLE_OPEN);
            f.fist[1] = e.depth * joint(FIST_MIDDLE_CLOSE, FIST_MIDDLE_OPEN);
            f.fist[2] = e.depth * joint(FIST_END_CLOSE, FIST_END_OPEN);
            return 0;
        }
        if (e.kind === "rub") {
            // The index hooks, the thumb follows it in and lets go a beat
            // after it, and the other fingers flick as the hand releases.
            const hookIn = RUB_HOOK_IN * k;
            const out = RUB_OUT * k;
            const delay = RUB_THUMB_DELAY * k;
            const release = hookIn + e.hold;
            f.hook = RUB_HOOK * e.depth * plateau(x, hookIn, e.hold, out);
            f.thumb = plateau(x - delay, RUB_THUMB_IN * k,
                release + 0.2 - delay - RUB_THUMB_IN * k, out);
            for (let i = 1; i < 4; i++) {
                f.curl[i] = RIPPLE_DEPTH * hump((x - release - lag(i)) / (RIPPLE_DUR * k));
            }
            return RUB_WRIST * e.depth * plateau(x, hookIn + delay, e.hold - delay, out);
        }
        for (let i = 0; i < 4; i++) {
            f.curl[i] = RIPPLE_DEPTH * e.depth * hump((x - lag(i)) / (RIPPLE_DUR * k));
        }
        return 0;
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
        // A moment's glance under a slow blink (see _moment).
        let glance = false;
        if (this._glanceAt >= 0 && this.t >= this._glanceAt) {
            this._glanceAt = -1;
            this._nextGazeAt = this.t;
            glance = true;
        }
        if (this.t >= this._nextGazeAt) {
            const r = Math.random();
            let scale = GAZE_MICRO;
            let avert = false;
            // The director's hold thins the glances and aversions out.
            const open = 1 - this.director.hold;
            if (glance) {
                scale = GAZE_GLANCE;
            } else if (r < GAZE_P_AVERT * open) {
                scale = 1;
                avert = true;
            } else if (r < (GAZE_P_AVERT + GAZE_P_GLANCE) * open) {
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
        // A moment's queued blinks go first (see _moment).
        const q = this._blinkQueue;
        if (q.length && this.t >= q[0] && this._blinkStart < 0 && !this._slowBlink) {
            q.shift();
            this._nextBlinkAt = this.t;
        }
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
                this._blink = SLOW_BLINK_PEAK * smootherstep(e / SLOW_BLINK_CLOSE);
            } else if (e < SLOW_BLINK_CLOSE + SLOW_BLINK_HOLD) {
                this._blink = SLOW_BLINK_PEAK;
            } else if (e < total) {
                this._blink = SLOW_BLINK_PEAK * (1 - smootherstep(
                    (e - SLOW_BLINK_CLOSE - SLOW_BLINK_HOLD) / SLOW_BLINK_OPEN));
            } else {
                this._blink = 0;
                this._slowBlink = null;
            }
        }

        // ── stance, arm settles, hand fidgets ─────────────────────────
        // All three are discrete events, so all three only START while the
        // body is visible (see `posing`); one already running finishes.
        // Not while a foot is off the floor (a fidget's or the last
        // shift's shuffle): the weight could land on it. Nor while a hand
        // is on the hip, which holds its own lean.
        const hipBusy = this._hip[0] || this._hip[1];
        if (posing && this._weightOn && this.t >= this._nextStanceAt && !this._fidget
            && !this._foot[0] && !this._foot[1] && !hipBusy) {
            this._shiftStance();
        }
        if (!this._weightOn && !hipBusy && this._stance.to !== 0) {
            glideTo(this._stance, 0, this.t, rand(STANCE_MOVE_MIN, STANCE_MOVE_MAX));
        }
        const fg = this._fidget;
        if (fg && this.t > fg.start + fg.out + fg.hold + fg.back) this._fidget = null;
        if (posing && this._weightOn && !this._fidget && !hipBusy && this.t >= this._nextFidgetAt
            && this.t > this._stance.start + this._stance.dur) {
            this._startFidget();
        }
        for (let i = 0; i < 2; i++) {
            const f = this._foot[i];
            if (f && this.t > f.start + f.dur) this._foot[i] = null;
        }
        for (let i = 0; i < 2; i++) {
            if (posing && this.t >= this._arm[i].next) this._settleArm(i, this.t);
        }
        // A change of speaker: the companion starts talking, or has gone
        // quiet for TURN_QUIET_S.
        const talking = speak > 0.15;
        this._turnQuiet = talking ? 0 : this._turnQuiet + dt;
        const turn = talking ? !this._turnSpeaking : this._turnSpeaking && this._turnQuiet > TURN_QUIET_S;
        if (turn) {
            this._turnSpeaking = talking;
            if (Math.random() < HAND_P_TURN) this._turnFidgetAt = this.t + rand(0, HAND_TURN_WINDOW);
        }
        if (this._turnFidgetAt >= 0 && this.t >= this._turnFidgetAt) {
            if (posing) this.fidgetHands();
            this._turnFidgetAt = -1;
        }
        if (posing && this.t >= this._nextHandAt) {
            this.fidgetHands();
            this._nextHandAt = this.t + expGap(HAND_GAP_MEAN, HAND_GAP_MIN, HAND_GAP_MAX);
        }
        for (let i = 0; i < 2; i++) {
            const h = this._hand[i];
            if (h && this.t - h.start > h.total) this._hand[i] = null;
        }
        // A hand to the hip: one at a time, never over a hand fidget. A turn
        // that finds the hands or the weight busy waits a moment and tries
        // again, rather than losing the turn to a whole new gap — that is
        // what made it far rarer in use than its mean.
        const hipSides = [0, 1].filter((j) => !this._hipBlocked[j]);
        if (!hipSides.length) this._nextHipAt = Infinity;   // this model can't do it at all
        if (posing && this.t >= this._nextHipAt) {
            const i = hipSides[Math.floor(Math.random() * hipSides.length)];
            // The weight goes onto that side's leg, so its foot must be down.
            if (!this._hip[0] && !this._hip[1] && !this._hand[i] && !this._fidget && !this._foot[i]) {
                const h = {
                    start: this.t,
                    reach: normalGap(HIP_REACH, HIP_REACH_SD, 0.6),
                    hold: rand(HIP_HOLD_MIN, HIP_HOLD_MAX),
                    back: normalGap(HIP_RETURN, HIP_RETURN_SD, 0.6),
                };
                this._hip[i] = h;
                // Onto that side's leg (> 0 loads the left) as the hand
                // goes, and the stance holds until it is back.
                const side = i === 0 ? 1 : -1;
                glideTo(this._stance, side * Math.min(1, vary(1, 0.12)), this.t,
                    rand(STANCE_MOVE_MIN, STANCE_MOVE_MAX));
                this._nextStanceAt = Math.max(this._nextStanceAt, h.start + h.reach + h.hold);
                this._nextHipAt = this.t + expGap(HIP_GAP_MEAN, HIP_GAP_MIN, HIP_GAP_MAX);
            } else {
                this._nextHipAt = this.t + HIP_RETRY;
            }
        }
        for (let i = 0; i < 2; i++) {
            const h = this._hip[i];
            if (h && this.t > (h.cut ?? h.start + h.reach + h.hold) + h.back) this._hip[i] = null;
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
        // The director's posture goes through the neck spring: it eases in
        // like any reorientation.
        const dir = this.director;
        springTo(this._headYaw,
            -bodyYaw * HEAD_COUNTER_YAW
            + drift(t * DRIFT_HZ_HEAD, 21) * HEAD_DRIFT_YAW
            + this._gazeHeadYaw.x
            + (dir.on ? dir.yaw : 0),
            HEAD_SPRING_HZ, HEAD_SPRING_ZETA, dt);
        springTo(this._headPitch,
            drift(t * DRIFT_HZ_HEAD, 23) * HEAD_DRIFT_PITCH
            + this._gazeHeadPitch.x
            + swallowU * SWALLOW_HEAD_PITCH
            + (dir.on ? dir.pitch * dir.down : 0),
            HEAD_SPRING_HZ, HEAD_SPRING_ZETA, dt);
        springTo(this._headRoll,
            -bodyRoll * HEAD_COUNTER_ROLL
            + drift(t * DRIFT_HZ_HEAD, 25) * HEAD_DRIFT_ROLL
            + (dir.on ? dir.roll : 0),
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
        // No sway: the arms hang (see the Arms note). What moves them is
        // the settles — the hang each arm last eased to — with the
        // forearm's roll on the elbow's x.
        const a = k.arms;
        const now = this.t;
        const [al, ar] = this._arm;
        s.elbowL = glide(al.twist, now) * a;
        s.elbowR = glide(ar.twist, now) * a;
        s.armPitchL = glide(al.pitch, now) * a;
        s.armPitchR = glide(ar.pitch, now) * a;
        s.flexL = glide(al.flex, now) * a;
        s.flexR = glide(ar.flex, now) * a;

        // ── hands ─────────────────────────────────────────────────────
        const hk = k.hands;
        const rubL = this._handPose(this._hand[0], s.fingersL);
        const rubR = this._handPose(this._hand[1], s.fingersR);
        for (const f of [s.fingersL, s.fingersR]) {
            for (let i = 0; i < 4; i++) f.curl[i] *= hk;
            for (let i = 0; i < 3; i++) f.fist[i] *= hk;
            f.hook *= hk;
            f.thumb *= hk;
        }
        s.wristL = glide(al.wrist, now) * a + rubL * hk;
        s.wristR = glide(ar.wrist, now) * a + rubR * hk;
        s.hipL = this._hip[0] ? this._hipU(this._hip[0], now) * a : 0;
        s.hipR = this._hip[1] ? this._hipU(this._hip[1], now) * a : 0;
        // A hand on the hip lies along it: most of its resting curl
        // straightens out, not all — a fully straight hand held for seconds
        // reads as stretched, not resting (HIP_FINGERS_FLAT).
        for (const [f, w] of [[s.fingersL, s.hipL], [s.fingersR, s.hipR]]) {
            if (w > 0) for (let i = 0; i < 4; i++) f.curl[i] = Math.min(f.curl[i], -HIP_FINGERS_FLAT * w);
        }

        // ── legs ──────────────────────────────────────────────────────
        // The neutral stance is identical every frame — the ankle pitch is
        // the exact negation of the hip and knee pitches, so the soles sit
        // flat. The weight and the feet's spots ride on top of it; the
        // renderer's IK turns them into a pelvis and two solved legs.
        const g = k.legs;
        const fg = this._fidget;
        const out = fg ? fg.amp * plateau(now - fg.start, fg.out, fg.hold, fg.back) : 0;
        s.stance = Math.max(-1, Math.min(1, glide(this._stance, now) + out)) * g;
        for (let i = 0; i < 2; i++) {
            const f = this._foot[i];
            const o = i ? s.footR : s.footL;
            // Out to the far point and home again, each leg of it a
            // minimum-jerk move, so the foot leaves and lands with no jolt.
            const e = f ? plateau(now - f.start, f.dur * f.rise, 0, f.dur * (1 - f.rise)) * g : 0;
            o.out = f ? f.out * e : 0;
            o.fwd = f ? f.fwd * e : 0;
            o.lift = f ? f.lift * e : 0;
        }
        s.hipPitchL = s.hipPitchR = HIP_PITCH * g;
        s.kneeL = s.kneeR = KNEE_BEND * g;
        s.hipYawL = s.hipYawR = 0;
        s.footPitchL = s.footPitchR = -(HIP_PITCH + KNEE_BEND) * g;
        s.footYawL = s.footYawR = 0;
        s.footRoll = 0;
        // No pelvis channels of its own: where the pelvis goes follows from
        // `stance` and the feet, which only the renderer can measure.
        s.hipYaw = 0;
        s.hipRoll = 0;
        s.hipShiftX = 0;
        s.hipShiftZ = 0;

        if (this.director.on) {
            const move = this._headMoves();
            const k = DIRECTOR_NECK_SHARE;
            s.neckPitch = move.pitch * k * this.director.down;
            s.neckYaw = move.yaw * k;
            s.neckRoll = move.roll * k;
            s.headYaw = this._headYaw.x + move.yaw * (1 - k);
            s.headPitch = this._headPitch.x + move.pitch * (1 - k) * this.director.down;
            s.headRoll = this._headRoll.x + move.roll * (1 - k);
        } else {
            s.neckPitch = 0;
            s.neckYaw = 0;
            s.neckRoll = 0;
            s.headYaw = this._headYaw.x;
            s.headPitch = this._headPitch.x
                + Math.sin(this.t * 0.7 * 2 * Math.PI) * HEAD_NOD_SPEAK * speak;
            s.headRoll = this._headRoll.x
                + Math.sin(this.t * 0.45 * 2 * Math.PI) * HEAD_TILT_SPEAK * speak;
        }
        s.headY = breath * depth * HEAD_BREATH_Y;

        s.blink = this._blink;
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
