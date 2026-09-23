/**
 * Face motion — the face director's face and head, for the base avatar.
 *
 * models/face_director.js reads each line (server/face_director.py) and
 * hands the answer to the renderer, which passes it here (react). This
 * turns it into motion, frame by frame (update): face morphs it writes
 * itself, blink / wink / preset / gaze values the renderer applies (blink,
 * wink, presets, gaze), and head moves and posture on the idle engine
 * (idle_motion.js). It sits UNDER the companion's own set_emotion — the
 * whole-face presets in avatar_renderer.js — and stands aside while one of
 * those plays.
 *
 * The server reads what a line means — its feeling (a blend of the
 * FACE_FEELINGS below), how much that shows (level 1–3), what the line does
 * (acts: asks, negates, affirms, …) and which of its words the stress and
 * each act land on — and this turns it into motion, composed per frame:
 *   mood    — the feeling, held as a resting expression through the reply
 *             and the few seconds after it
 *   signals — brow raises and knits, glances, a wink, a turn away: what the
 *             line's acts and feeling bring, timed to the line
 *   beats   — brow flicks on stressed syllables, off the voice
 *   micro   — slow small brow drift, so a held face never freezes
 * and the head: nods, shakes and sweeps on their words, a posture.
 *
 * Faces are built from the avatar's OWN expressions and shapes, whichever
 * of three conventions it carries — the five emotion expressions every VRM
 * has, split into an upper half and a mouth half (face_regions.js); VRoid's
 * region morphs (Fcl_BRW_ / Fcl_EYE_ / Fcl_MTH_); the 52 ARKit shapes of a
 * "perfect sync" model (browInnerUp, mouthSmileLeft, …) — plus the VRM's
 * own one-eye blinks for a wink. Each channel takes the finest the model
 * has (FACE_ACCENTS).
 */

import { GAZE_AMP } from "./idle_motion";
import { expressionSize, splitEmotionExpressions } from "./face_regions";

// Each feeling's parts: [channel, from level, to level (default 3)]. A
// channel is an expression half ("sad:upper") or an accent (FACE_ACCENTS).
// Levels: 1 a light trace, 2 clear, 3 taking over the face — a peak on top
// of the mood, which itself rests at 2 at most. A light trace keeps to the
// upper face, so a hint of a feeling never pulls the mouth against the
// speech (design choice).
// Smiles follow FACS: a social smile is the mouth alone (AU12); the eyes
// joining in (AU6, the cheek raise that narrows them) marks a felt one
// (Ekman, Davidson & Friesen 1990), and the jaw drops for a laugh — so a
// closed smile carries light and clear happiness, and the `happy`
// expression's open grin and crescent eyes only its peak. The rest are
// FACS readings: excitement = happily surprised, brows up over the smile
// (AU 1+2+12+25, Du, Tao & Martinez 2014); worry = the sad brow (AU 1+4);
// puzzlement = the brow knit (AU 4, Rozin & Cohen 2003); embarrassment = a
// smile with the gaze and head down and away (Keltner 1995); pride = a
// small smile with the head up (Tracy & Robins 2004), one-sided where the
// model can (the unilateral lip corner of smugness, Ekman & Friesen 1986).
// Interest has no face of its own here.
// The anime displays are design calls, built from those same parts:
// teasing = the smug smile; flustered embarrassment adds the worried brow;
// a huffy "hmph" = a knit brow, a pout (puffed cheeks where the model has
// them) and the head turned away, chin up. The wink is not one of these:
// it is a line's act, asked for on its own (see the acts below).
// `mark` is the manga mark (mood_marks.js) a feeling pops beside the head
// when it arrives showing clearly. Kept deliberately sparse: a mark is
// punctuation, and one beside every other sentence stops reading as
// punctuation at all. The director reads a feeling off most lines, so a
// mark per feeling put one on screen far too often. What is left is the
// five set_emotion uses, plus the ones that say something the face does
// not — the puzzled "?", the worried sweat drop (worry reads as sadness
// without it), the huffy breath (the pout needs a cheek-puff morph the
// model may not have) and, only on a model that cannot blush, the
// flustered steam. Excited is the one that went for good: it is among the
// commonest feelings read, and its face — a full smile and a raised brow —
// was already saying it. Measured over 65 lines of three demo scripts, the
// set below fires 1 mark per 5 lines; excited alone took that to 1 in 3.8,
// and it cannot be thinned by asking for a stronger feeling instead,
// because excitement that strong gets read as happy or surprised (it
// reached level 3 zero times in those 65 lines).
const FACE_FEELINGS = {
    warm:        { parts: [["smile", 1], ["relaxed:upper", 3]] },
    happy:       { parts: [["smile", 1, 2], ["happy:mouth", 3], ["happy:upper", 3]], mark: "happy" },
    teasing:     { parts: [["smirk", 1, 2], ["happy:mouth", 3], ["happy:upper", 3]] },
    excited:     { parts: [["smile", 1, 2], ["happy:mouth", 3], ["happy:upper", 3], ["brow_raise", 1]] },
    proud:       { parts: [["smirk", 1, 2], ["happy:mouth", 3]] },
    interested:  { parts: [] },
    puzzled:     { parts: [["brow_knit", 1]], mark: "puzzled" },
    surprised:   { parts: [["brow_raise", 1], ["eye_widen", 2], ["surprised:mouth", 3]], mark: "surprised" },
    // `markUnless` names a channel that says it better: the steam mark
    // stands in for a blush only on a model with no blush shape rigged.
    embarrassed: { parts: [["smile", 1], ["brow_sad", 2], ["blush", 2]],
        mark: "flustered", markUnless: "blush", turn: "down" },
    huffy:       { parts: [["brow_knit", 1], ["pout", 1]], mark: "huffy", turn: "away" },
    worried:     { parts: [["sad:upper", 1]], mark: "worried" },
    sad:         { parts: [["sad:upper", 1], ["sad:mouth", 2]], mark: "sad" },
    annoyed:     { parts: [["angry:upper", 1], ["angry:mouth", 2]], mark: "angry" },
};
const FACE_BRIGHT = new Set(["warm", "happy", "teasing", "excited", "proud"]);
// Channels — the first option the rig has: VRoid's region morphs, then the
// ARKit shapes, then the nearest expression half. A sided channel picks one
// side per use.
const FACE_ACCENTS = {
    brow_raise: [{ Fcl_BRW_Surprised: 1 },
        { browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1 }, { "rx:surprised:upper": 1 }],
    brow_knit:  [{ Fcl_BRW_Angry: 1 }, { browDownLeft: 1, browDownRight: 1 }, { "rx:angry:upper": 1 }],
    eye_widen:  [{ Fcl_EYE_Spread: 1 }, { eyeWideLeft: 1, eyeWideRight: 1 }, { "rx:surprised:upper": 1 }],
    brow_sad:   [{ Fcl_BRW_Sorrow: 1 }, { browInnerUp: 1 }, { "rx:sad:upper": 1 }],
    // The mouth had no VRoid option at all, so on a VRoid model — most VRM
    // avatars — every smile was a split-out half of the `relaxed`
    // expression rather than the shape its author drew. Same strength, since
    // `relaxed` binds Fcl_ALL_Fun and VRoid's ALL_ shapes are composites of
    // these region ones (both peak at 0.57 cm on the models measured): this
    // only trades the mask and height split for the authored original.
    smile:      [{ Fcl_MTH_Fun: 1 }, { mouthSmileLeft: 1, mouthSmileRight: 1 },
        { "rx:relaxed:mouth": 1 }],
    smirk:      [{ side: ["mouthSmileLeft", "mouthSmileRight"] }, { mouthSmileLeft: 1, mouthSmileRight: 1 },
        { "rx:relaxed:mouth": 1 }],
    // The huffy pout: VRoid's own angry mouth, the closed downturned "へ"
    // its author drew (what the angry expression's mouth half is made of).
    pout:       [{ Fcl_MTH_Angry: 1 }, { mouthPucker: 1, cheekPuff: 1 }, { "rx:angry:mouth": 1 }],
    // The anime smiling eye (^^) and its brow, as authored. Again the same
    // strength as the half they replace — `happy` binds Fcl_ALL_Joy, and
    // both it and Fcl_EYE_Joy peak at 1.25 cm.
    "happy:upper": [{ Fcl_EYE_Joy: 1, Fcl_BRW_Joy: 1 }, { "rx:happy:upper": 1 }],
    "happy:mouth": [{ Fcl_MTH_Joy: 1 }, { "rx:happy:mouth": 1 }],
    // A wink, when the model has a one-eyed SMILING close. The fallback is
    // the VRM's own blinkLeft/blinkRight, which is a plain eye shut — an
    // anime wink is the joy eye, and VRoid draws one per side.
    wink:       [{ side: ["Fcl_EYE_Joy_L", "Fcl_EYE_Joy_R"] }],
    // A blush has no standard to fall back on: VRM defines no cheek
    // expression, VRoid's 57 region morphs have none, and ARKit's cheek
    // shapes are puff and squint, which are muscles rather than colour. So
    // this channel only works on a model whose author rigged one — and
    // those are named plainly, usually as an expression rather than a raw
    // morph. Nothing shows on a model without it, which is the same
    // contract as every other channel here.
    blush:      [{ expr: ["blush", "Blush", "blushing", "Blushing", "照れ", "赤面", "頬染め",
        "tere", "cheek", "Cheek", "cheeks", "Cheeks"] },
    { Blush: 1 }, { blush: 1 }, { 照れ: 1 }, { 赤面: 1 }],
};
// Per-look tuning (the avatar editor's Tune face): a strength per channel,
// 1 = the numbers above on the shapes the model's author drew, and per
// own-emotion expression (`emotion:<state>`, set_emotion's cap). Models
// that share VRoid's shape names do not share their sizes — the same
// smile is 0.46 cm on one and 2.18 cm on another — so a heavily sculpted
// model can come out grotesque where the weights read right on another.
// `ref` is a typical VRoid model's size for each channel at full weight, in
// metres (the eyes' turn in degrees): the median over 11 distinct VRoid
// characters (Ara, Eve, Leo, Marin, Miles, Ochako, Chika, Kaguya, Makima,
// Saber, Riko; halves measured through face_regions' split). Auto-tune
// scales a model bigger than typical down to it, never up — a small one
// is as its author drew it.
export const FACE_TUNING = [
    { group: "Brows", channels: [
        { id: "brow_raise", label: "Raised", ref: 0.0103 },
        { id: "brow_knit", label: "Knitted", ref: 0.0164 },
        { id: "brow_sad", label: "Worried", ref: 0.0151 },
    ] },
    { group: "Eyes", channels: [
        { id: "eye_widen", label: "Widened", ref: 0.0053 },
        { id: "happy:upper", label: "Smiling eyes", ref: 0.0148 },
        { id: "relaxed:upper", label: "Soft eyes", ref: 0.0109 },
        { id: "sad:upper", label: "Sad eyes", ref: 0.0151 },
        { id: "angry:upper", label: "Angry eyes", ref: 0.0164 },
        { id: "wink", label: "Wink", ref: 0.0167 },
        // Not a shape: how far the eyes turn (glances, saccades), on the
        // look-at ranges the model's author set — degrees, not metres.
        { id: "gaze", label: "Eye movement", ref: 12, unit: "deg" },
    ] },
    { group: "Mouth", channels: [
        { id: "smile", label: "Smile", ref: 0.0115 },
        { id: "smirk", label: "Smirk", ref: 0.0115 },
        { id: "pout", label: "Pout", ref: 0.0055 },
        { id: "happy:mouth", label: "Grin", ref: 0.0159 },
        { id: "sad:mouth", label: "Sad mouth", ref: 0.0123 },
        { id: "angry:mouth", label: "Angry mouth", ref: 0.0055 },
        { id: "surprised:mouth", label: "Shocked mouth", ref: 0.0200 },
        { id: "blush", label: "Blush" },
    ] },
    { group: "Their own emotions (set_emotion)", channels: [
        { id: "emotion:happy", label: "Happy", ref: 0.0159 },
        { id: "emotion:relaxed", label: "Relaxed", ref: 0.0115 },
        { id: "emotion:sad", label: "Sad", ref: 0.0151 },
        { id: "emotion:angry", label: "Angry", ref: 0.0164 },
        { id: "emotion:surprised", label: "Surprised", ref: 0.0200 },
    ] },
];

// Which written shapes belong to the mouth (they give way to the lip-sync)
// and which CLOSE the eyes (a blink gives way to them, VRM's overrideBlink
// "blend" rule). Only the closing ones: a raised brow or widened eyes lift
// the lids, leaving a blink more to close rather than less, and counting
// those clipped every blink and wink that happened while the brows were up.
const MOUTH_SHAPE = /(:mouth$|^Fcl_MTH_|^mouth|^cheekPuff|^jaw)/;
const EYE_SHAPE = /(^rx:(happy|relaxed|sad|angry):upper$|^Fcl_EYE_(Joy|Close|Angry|Sorrow|Fun)|^eyeSquint|^cheekSquint)/;
// How strong. A conversational signal plays at 0.5–1.0 of its shape, the
// band dialogue systems run facial gestures in — below ~0.4 most
// expressions stop being recognised at all. A mood is the lighter resting
// layer: 0.45–0.6, where a resting expression reads as friendly (0.2 is
// invisible, past 0.7 a fixed grin) — a light one at the low end, a clear
// one at the top. A peak plays at the signal band's top.
const FACE_SIGNAL_BAND = [0.5, 1.0];
const FACE_MOOD_BAND = [0.45, 0.6];
// When and how long, in seconds, from measured conversation: the median
// length of each signal and how far ahead of its words it starts (Nota,
// Trujillo & Holler 2021). Brow shapes rise 0.1 s and fall 0.2 s, the
// talking-head raise tuned "distinctive although not too obvious"
// (Granström et al. 1999); a glance takes the median rise and fall of
// professionally authored reaction clips, 0.27 / 0.33 s. A peak runs like
// an amused smile: ~4 s (Ambadar et al. 2009), in over ~0.56 s (Schmidt et
// al. 2003), out over ~1.1 s (Guo et al. 2018).
const FACE_SIGNALS = {
    brow_raise:  { lead: 0.2,  dur: 0.64, rise: 0.1,  fall: 0.2 },
    frown:       { lead: 0.2,  dur: 0.96, rise: 0.1,  fall: 0.2 },
    look_away:   { lead: 0.5,  dur: 0.92, rise: 0.27, fall: 0.33 },
};
const FACE_PEAK = { lead: 0.89, dur: 4.0, rise: 0.56, fall: 1.1 };
// What a line's acts bring, after the USC nonverbal behaviour generator's
// rules (Lee & Marsella 2006) and the conversation studies behind them
// (McClave 2000, Kendon 2002): a "no" shakes the head under a knit brow; a
// "yes" nods under a raised one; a hedge nods under a knit; stress nods,
// the brow raised if the feeling is bright and knit if not; "everyone"
// sweeps the head; a search for a word raises the brows and looks away.
// A question lifts the brows in 20% of cases and knits them in 13% (Nota
// et al. 2021, 6778 questions). Hearing a question, they look away to
// think of the answer (speakers look away as they plan, Kendon 1967); what
// they agree with gets a nod — the commonest visible answer (Stivers et
// al. 2009) — and news worth taking in gets a brow raise (Chovil 1991; the
// `learns` act below). The stressed word itself carries a movement 60% of
// the time (Graf et al. 2002: 42% of pitch accents take a nod and 18% a nod
// with overshoot), which FACE_STRESS_SHAPES then picks the shape of.
// The rest of the generator's rules keep the head from answering
// everything the same way: a contrast ("but", "instead") moves the head to
// one side under raised brows, a list walks it from one side to the other,
// something that has to happen ("we need to") takes a single nod, and a
// check on the listener ("you know?") moves it aside under raised brows; a
// search for a word tilts it, as far as Greta's default lateral roll
// (0.11 of its 60° range).
const FACE_QUESTION_RAISE_P = 0.20;
const FACE_QUESTION_FROWN_P = 0.13;
const FACE_STRESS_NOD_P = 0.6;
const FACE_HEAD_TILT = 0.115;
// The head moves, radians peak to peak, as minimum-jerk keyframes (idle
// engine). A conversational nod: 3.5° over 0.94 s when single — 42% are —
// and up to 5 cycles in 1.53 s, later cycles smaller (~2.4° against ~4.4°
// for the first) (Mori, Den & Jokinen 2025, 9,223 nods); measured nods
// elsewhere run about half a second (Hömke et al. 2018: 499 ms), and the
// realizers a whole second (SmartBody's default nod is 15° over 1.0 s,
// VMagicMirror's 15-20° over 1.0-1.8 s). A head shake is the same cyclic
// movement on the other axis (Hadar et al. 1985) — no one has measured its
// size in conversation, so it takes Greta's default, 2.9° to each side.
// A nod's return overshoots by a tenth and settles, the way Greta ends
// every stroke (EaseOutBack) and the second of Graf et al. 2002's nod
// shapes ("nod with an overshoot at the return"). A stress nod is smaller
// (~2.5°, read off Graf's Fig. 4), peaks 0.32 s in and is back by 0.73 s
// (Esteve-Gibert et al. 2014, head gestures on accented syllables). A
// sweep swings as far as the head's whole range on the side axes in
// neutral speech, ~2.3° (Busso et al. 2007), over that same gesture span.
// Every move is drawn at 0.7-1.0 of its size and takes that share of its
// time with it, so a smaller one is quicker (VMagicMirror's rule). Each is
// placed so its peak lands on its word.
const FACE_HEAD_NOD = { amp: 0.0611, dur: 0.94, single: 0.42, maxCycles: 5, maxDur: 1.53, lastScale: 0.55 };
const FACE_HEAD_SHAKE = { ...FACE_HEAD_NOD, amp: 0.1012 };
const FACE_HEAD_STRESS = { amp: 0.0436, rise: 0.322, fall: 0.411 };
const FACE_HEAD_SWEEP = { amp: 0.0401, dur: 0.733 };
const FACE_HEAD_OVERSHOOT = 0.1;
const FACE_HEAD_SIZE = [0.7, 1.0];
// A stressed word does not always get the same movement. Graf et al. 2002
// counted three, as shares of the pitch accents that carry one: a plain
// nod (42%), a nod that overshoots coming back (18%), and a swing one way
// that does not come back — it drifts home "slowly, barely visible"
// (20%). Nor is it always a nod: across a spoken sentence the head moves
// about 3.32° on the nodding axis against 0.88° and 0.81° on the other two
// (Busso et al. 2007, Table I, neutral speech), so the axis is drawn in
// that proportion and the size follows it. Roll — a tilt — is the rarest,
// which matches Graf ("significant rotations around the z-axis are rare").
const FACE_STRESS_SHAPES = [["nod", 0.42], ["overshoot", 0.18], ["swing", 0.20]];
const FACE_STRESS_AXES = [["pitch", 3.32], ["yaw", 0.88], ["roll", 0.81]];
const FACE_SWING_HOME_S = 1.6;          // the swing's slow drift home (unsourced)
// Emotional speech moves the head more: velocity ~1.4× neutral when sad,
// ~1.9× happy, ~2.25× angry (Busso et al. 2007, Table I) — the gain on
// every head move while the feeling shows (half at a light trace).
const FACE_HEAD_GAIN = { happy: 1.875, teasing: 1.875, excited: 1.875, proud: 1.875, sad: 1.375, annoyed: 2.25 };
// Posture (radians, + bows the head) at a clear showing, half at a light
// one: a bowed head reads as sad or embarrassed, a raised one as proud
// (Mignault & Chaudhuri 2003; Keltner 1995; Tracy & Robins 2004), at 10° —
// the size Witkower & Tracy call one of the smallest head-tilt
// manipulations studied. A huffy "hmph" lifts the chin the same way.
const FACE_BEARING = {
    sad: { pitch: 0.1745 }, embarrassed: { pitch: 0.1745 }, proud: { pitch: -0.1745 }, huffy: { pitch: -0.1745 },
};
// The turn away of embarrassment and of a huff, for the line: as far as
// the idle engine's full gaze aversion turns the head
// (GAZE_AVERT_HEAD_YAW), the eyes going with it. Embarrassment runs in
// order, and that order is most of what makes it read as embarrassment
// rather than amusement: the gaze goes down 0.71 s in, the head turns
// aside at 2.24 s, and the whole display is over in about 5 s (Keltner
// 1995, 35 embarrassed targets). The turn is to their left in 50% of
// cases against 20% to the right — 0.71 of the ones that go either way.
const FACE_TURN_YAW = 0.13;
const FACE_SHY_GAZE_S = 0.71;
const FACE_SHY_TURN_S = 2.24;
const FACE_SHY_LEFT = 0.71;
// A wink is one of the line's acts, like a head shake: the server asks
// whether the line carries the aside a wink marks, and it lands as that
// line ends — a wink comes after the remark it is about. Once per reply,
// on the first line that carries it: a wink punctuates a remark, and a run
// of sentences making one joke is one remark, not three. Measured on a
// playful exchange, the same reply answered yes on three sentences
// running.
// Closed then open again: a voluntary blink takes 572 ms in all —
// down in about 110 ms, shut for ~58 ms, most of the way back up by 400 ms
// (Kwon et al. 2013, 25 adults at 600 fps). A closure this long reads as
// deliberate: the long blinks in conversation run ~607 ms against ~208 ms
// for ordinary ones (Hömke et al. 2018).
const FACE_WINK = { close: 0.11, hold: 0.06, open: 0.4 };
// A new signal or mood overshoots to 1.4× for its first 0.25 s, then
// settles: the change catches the eye without raising what is held.
const FACE_BURST = 1.4;
const FACE_BURST_S = 0.25;
const FACE_MOOD_S = 1.5;                // a mood eases in and out over 1.5 s
// Gaze, in the idle engine's aversion geometry (idle_motion.js: sideways
// 0.6-1.0, down 0.25-0.7), so the director's glances are the size of the
// idle's: aside is a mid-range sideways look at the shallowest dip, down
// is the idle's deepest dip.
const FACE_GAZE = {
    glance_away: { x: 0.8, y: -0.25 },
    look_down: { x: 0, y: -0.7 },
};
// While they talk the mouth belongs to the lip-sync: the open-jawed halves
// (a laugh, a gasp) wait for the pauses, and the rest never pass 1 − the
// jaw's opening, smoothed over a syllable (~200 ms in spontaneous speech,
// Greenberg 1999) so a smile holds through a sentence instead of
// flickering with every vowel. Talking ramps 0.15 s up and 0.4 s down,
// bridging the gaps between words; "talking" is the motion director's
// speaking threshold.
const FACE_JAW_SHAPES = new Set(["rx:happy:mouth", "rx:surprised:mouth"]);
const FACE_JAW_TAU_S = 0.2;
const FACE_TALK_ON = 0.05;
const FACE_TALK_UP_S = 0.15;
const FACE_TALK_DOWN_S = 0.4;
// Beats: a syllable counts as stressed when the voice's loudness crosses
// the 90th percentile of recent speech. About one stressed syllable in
// seven carries a brow raise (~15% measured), never two within 0.5 s, each
// 0.1 s up, 0.2 s held, 0.2 s down, at 0.5–1.0 of the shape.
const FACE_BEAT_P = 0.15;
const FACE_BEAT_GAP_S = 0.5;
const FACE_BEAT_WINDOW = 600;           // loudness samples kept, ~10 s of frames (unsourced)
// Micro drift: each channel wanders on its own — a new move 0.1–5 s after
// the last, rising over 0.1–0.5 s, holding 1–5 s, to 0.3 × r² of the shape
// (so mostly tiny: median 0.075). The fall mirrors the rise (unsourced).
// Brows only: drift in the lids reads as a squint.
const FACE_MICRO_CHANNELS = ["brow_sad", "brow_raise"];
const FACE_MICRO_AMP = 0.3;
// Around the hand-over. Looking at the listener climbs from ~57% of the
// time 3 s before a long utterance ends to ~77% at its end, and is back to
// ~56% 3 s after (Kendon 1967, Fig. 2) — glances and aversions thinned by
// up to 1 − 23/43.5 ≈ 0.47 on that curve. A reply ending on a question
// waits with the brows: a ~0.3 s flash invites an answer to a joke, a
// 0.62–2.3 s hold pursues one to a challenge (Clift & Rossi 2023) — the
// flash after a bright line, the hold otherwise. The mood stays up at full
// strength for 8 s once the voice stops (Jonathan's call; an embarrassment
// display runs ~5 s, Keltner 1995, and a silence past ~1 s mostly ends by
// 2–3 s, Jefferson 1989) — and then it does not go out: it thins to a
// trace, just above the weight where an expression stops being visible at
// all, and that stays until the next exchange brings another feeling. A
// face that snaps to neutral while the other person is still thinking is
// what the wait exists to avoid. The head itself goes quiet:
// it moves in ~90% of frames while speaking and ~13% in pauses and while
// listening (Hadar et al. 1983). A listener nods ~13 times a minute
// (attentive-listening corpus, Kyoto 2025).
const FACE_TURN_GAZE_HOLD = 0.47;
const FACE_TURN_GAZE_S = 3;
const FACE_REPLY_FLASH_S = 0.3;
const FACE_REPLY_HOLD_S = [0.62, 2.3];
const FACE_WAIT_S = 8;
const FACE_TRACE_W = 0.25;
const FACE_LISTEN_NOD_GAP_S = 60 / 13;

// Smooth start/stop easing (the renderer's emotion cross-fade curve).
function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const side = () => (Math.random() < 0.5 ? -1 : 1);

/** One entry of [[value, weight], …], drawn in proportion to the weights. */
function draw(table) {
    let r = Math.random() * table.reduce((a, [, w]) => a + w, 0);
    return table.find(([, w]) => (r -= w) <= 0) || table[table.length - 1];
}

export class FaceMotion {
    /** `renderer` owns the avatar: this reads its VRM, voice level,
     *  lip-sync, manual emotion and clip state, settles a held emotion and
     *  pops its mood marks. `emotions` is its EMOTION_STATES (the preset
     *  names, and neutral's blend time for standing aside). */
    constructor(renderer, emotions) {
        this.r = renderer;
        this.emotions = emotions;
        this.emotionNames = Object.values(emotions).map((s) => s.name).filter(Boolean);
        this.on = false;                  // a call with the director is running
        this.items = [];                  // timed moods, signals and beats (_env)
        this.moodItem = null;             // the one of them that is the current mood
        this.traceItem = null;            // what is left of it once the wait is over
        this.moodKey = null;
        this.markAt = null;               // when this mood's manga mark pops (performance s)
        this.markName = null;
        this.markFeel = null;             // the feeling whose mark has already popped
        this.micro = null;                // per-channel drift state
        this.beat = null;                 // recent loudness, for stressed syllables
        this.talk = 0;                    // 0..1 talking, ramped
        this.jaw = 0;                     // lip-sync jaw opening, smoothed
        this.yield = 1;                   // 0 while a manual emotion or clip owns the face
        this.turnEndAt = null;            // when this turn's voice stops (Date.now ms)
        this.turnAt = null;               // the last hand-over, for the gaze curve
        this.waitFrom = null;             // the voice stopped here; the waiting face runs
        this.lastLine = null;             // the last spoken line's { asks, bright }
        this.winkedLast = false;          // the line just gone carried the aside a wink marks
        this.hearing = false;             // the user holds the floor
        this.nextNodAt = 0;               // a listener's next nod (performance s)
        this.rig = null;
        // Read by the renderer each frame.
        this.blink = 1;                   // how far a blink may close the lids
        this.wink = null;                 // { blinkLeft | blinkRight: weight }
        this.presets = null;              // whole-expression fallback weights
        this.gaze = { x: 0, y: 0 };       // look-at offset on top of the saccades
    }

    /** A call with the director starts (true) or ends (false). The beats,
     *  the micro drift and the head moves only run while it is on; turning
     *  it off eases everything shown back out. */
    setOn(on) {
        this.on = !!on;
        if (!on) this.clear();
    }

    /** One line's face: `face` is server/face_director.normalize's shape
     *  ({top, feelings, level, acts, words}). `lineAt` / `lineEnd` are when
     *  the voice reaches the line and leaves it (Date.now() ms) — each
     *  signal starts its own lead ahead of its moment — `wordAt`
     *  {stress | act: ms} the words the stress and each act land on,
     *  `first` whether it opens an exchange (a reply's first line, or the
     *  listening face before it), `listening` that it is a line they hear
     *  rather than say. */
    react(face, { lineAt = Date.now(), lineEnd = lineAt, first = false, listening = false, wordAt = {} } = {}) {
        const r = this.r;
        if (!face || !r.vrm) return;
        // A manual emotion keeps the face for its beat (the decay timer is
        // still pending) and update stands aside meanwhile. One that is
        // only being HELD — Eve's happy parked at relaxed, an avatar with
        // decay off — hands the face back at the next line.
        if (r._currentEmotion !== "neutral" && !r._emotionDecayTimer) {
            r.setEmotion("neutral", { explicit: false, settle: true });
        }
        const rig = this._rigFor();
        const now = performance.now() / 1000;
        const secsTo = (ms) => Math.max(0, (ms - Date.now()) / 1000);
        const lineIn = secsTo(lineAt);
        // When a manga mark pops: on the line's STRESSED word, not at its
        // first character. The stress is the beat of the sentence, which is
        // where a mark belongs — and a sentence boundary is the worst place
        // to aim for, because the sentence times are estimated from a
        // character count against the turn's audio (motion_director
        // _retimeQueue), so a mark aimed at the boundary surfaces a beat
        // early over the tail of the line before: the bulb landing on
        // "...at all" rather than on "Oh, hang on". Aiming inside the line
        // leaves room for that error either way.
        const markIn = secsTo((!listening && wordAt.stress) || lineAt);
        const acts = new Set(face.acts || []);
        const feelings = face.feelings || {};
        const level = Object.keys(feelings).length ? Math.max(0, Math.min(3, face.level || 0)) : 0;
        this.waitFrom = null;             // a new line: whatever wait was running is over
        if (first) this.winkedLast = false;   // a new reply: last turn's tail is not this remark
        const timed = (t, at = lineIn) => ({
            start: now + Math.max(0, at - t.lead),
            rise: t.rise, hold: Math.max(0, t.dur - t.rise - t.fall), fall: t.fall, burst: true,
        });

        // The mood carries through a reply — a calm line inside a warm reply
        // leaves the warmth — and an exchange's first read restates it, so a
        // mood never leaks into the next exchange unless it is still there.
        // Resting at most at "clear": a strong feeling is a peak on top.
        const rest = Math.min(level, 2);
        const moodKey = rest ? `${face.top}/${rest}` : null;
        if (moodKey !== this.moodKey && (moodKey || first)) {
            for (const old of [this.moodItem, this.traceItem]) {
                if (old) this._retire(old, now, FACE_MOOD_S);
            }
            this.moodItem = null;
            this.traceItem = null;
            this.moodKey = moodKey;
            // A mood that never arrived takes its pending mark with it.
            this.markAt = null;
            if (moodKey) {
                const band = FACE_MOOD_BAND[rest - 1];
                this.moodItem = {
                    ...this._mix(rig, feelings, rest, band),
                    ...this._bearing(feelings, rest),
                    feelings, level: rest, band,
                    start: now, rise: FACE_MOOD_S, hold: Infinity, fall: FACE_MOOD_S, burst: true,
                };
                this.items.push(this.moodItem);
                // The anime displays pop their manga mark as the feeling
                // arrives — but ON the line, not with this hand-over.
                // Everything here is handed over FACE_LEAD_MS early on
                // purpose, because a face leads its words; a mark is a
                // popped graphic rather than a ramp, so the same lead puts
                // it beside the head a beat before the sentence it belongs
                // to (the anger vein landing in the tail of the line
                // before the "No."). It waits for the line instead.
                const feel = FACE_FEELINGS[face.top];
                const mark = feel?.mark
                    && (!feel.markUnless || !this._channel(rig, feel.markUnless, 1))
                    ? feel.mark : null;
                // A mark says a feeling ARRIVED, so it follows the feeling
                // alone — not the mood key, which carries the level too. A
                // feeling that merely ticks between "clear" and "light"
                // makes a new key every line, and marking each one put
                // four "!" in a row across a single run of surprise.
                if (rest >= 2) {
                    if (mark && face.top !== this.markFeel) {
                        this.markAt = now + markIn;
                        this.markName = mark;
                    }
                    this.markFeel = face.top;
                }
            } else {
                // Back to calm: the next time a feeling shows, it is
                // arriving again and may mark again.
                this.markFeel = null;
            }
        }
        // Arriving at something is a MOMENT, not a mood, so its mark comes
        // off the line's acts rather than off a feeling — the same shape of
        // thing as the wink. It takes the line from any mood mark that was
        // also due: a realisation usually lands on a mood change too, and
        // the generic "!" says much less than the bulb does. No level to
        // clear and no once-a-reply rule, because it is rare on its own
        // terms (twice in a 27-line script, measured).
        if (acts.has("realises") && !listening) {
            this.markAt = now + markIn;
            this.markName = "idea";
        }

        // A strong feeling (a laugh, a glare, a gasp) peaks with the line's
        // start and settles back to the mood.
        if (level === 3) {
            this.items.push({ ...this._mix(rig, feelings, 3, FACE_SIGNAL_BAND[1]), ...timed(FACE_PEAK) });
        }

        // What the line does (the rules above FACE_QUESTION_RAISE_P): brows
        // and glances on the line, head moves on their words.
        const bright = FACE_BRIGHT.has(face.top);
        const signal = (name, t) => {
            const [lo, hi] = FACE_SIGNAL_BAND;
            const got = this._channel(rig, name, lo + Math.random() * (hi - lo));
            if (got) this.items.push({ ...got, ...timed(t) });
        };
        const brows = (kind) => {
            if (kind === "raise") signal("brow_raise", FACE_SIGNALS.brow_raise);
            else if (kind === "knit") signal("brow_knit", FACE_SIGNALS.frown);
        };
        const glance = (kind, dir = side()) => {
            const g = FACE_GAZE[kind];
            this.items.push({
                shapes: {}, presets: {}, gaze: { x: g.x * dir * GAZE_AMP, y: g.y * GAZE_AMP },
                ...timed(FACE_SIGNALS.look_away),
            });
        };
        const gain = this._gain();
        const at = (key) => (!listening && wordAt[key]) || lineAt;
        if (acts.has("negates")) {
            brows("knit");
            this._move("shake", at("negates"), gain);
        } else if (acts.has("unsure")) {
            brows("knit");
            this._move("nod", at("stress"), gain);
        }
        if (acts.has("affirms")) {
            brows("raise");
            this._move("nod", at("affirms"), gain);
        }
        if (acts.has("stresses") && !acts.has("negates") && !acts.has("affirms")) {
            brows(bright ? "raise" : "knit");
        }
        // The line's stressed word: a stress nod, unless the word already
        // carries a shake or a nod.
        const stressAt = wordAt.stress;
        if (!listening && stressAt && Math.random() < FACE_STRESS_NOD_P
            && stressAt !== wordAt.negates && stressAt !== wordAt.affirms) {
            this._move("stress", stressAt, gain);
        }
        if (acts.has("inclusive")) this._move("sweep", at("inclusive"), gain);
        if (acts.has("contrasts")) {
            brows("raise");
            this._move("sweep", at("contrasts"), gain);
        }
        // Once per REMARK, not once per reply. A run of sentences making
        // one joke is one remark, so a wink is held back only from the
        // line immediately after one — two asides eight lines apart are
        // two remarks and get two winks each.
        //
        // This was once-per-reply, added when the old wording winked three
        // times inside a single joke. Sharpening the question is what
        // actually fixed that: the same three lines now read 0.34-0.39 and
        // fire none of them. With the cause gone the wider scope was only
        // throwing away real asides — on both demo scripts it discarded a
        // second one, and on neither did the two ever land adjacent.
        const winking = acts.has("winks") && !listening;
        if (winking && !this.winkedLast) {
            const w = FACE_WINK;
            // The model's own winking eye when it has one, else the VRM's
            // one-eye blink. Either way it is one eye, on one side.
            const eye = this._channel(rig, "wink", 1);
            this.items.push({
                shapes: eye?.shapes || {}, presets: {},
                wink: eye ? null : pick(["blinkLeft", "blinkRight"]),
                start: now + secsTo(lineEnd), rise: w.close, hold: w.hold, fall: w.open, burst: false,
            });
        }
        // Set from whether the line CARRIED the aside, not from whether it
        // winked: three sentences of one joke are one remark, so the third
        // is held back by the second even though the second never winked.
        this.winkedLast = winking;
        if (acts.has("obliges") && !acts.has("affirms")) this._move("nod", at("stress"), gain, 1);
        if (acts.has("checks")) {
            brows("raise");
            this._move("sweep", at("stress"), gain);
        }
        const span = Math.max(FACE_SIGNALS.look_away.dur, (lineEnd - lineAt) / 1000);
        const held = (bearing, from, dur) => this.items.push({
            shapes: {}, presets: {}, bearing,
            ...timed({ ...FACE_SIGNALS.look_away, dur }, lineIn + from),
        });
        if (acts.has("lists")) {
            // Through the list: over to one side, then across to the other.
            const dir = side();
            held({ pitch: 0, yaw: FACE_HEAD_SWEEP.amp * dir * gain, roll: 0 }, 0, span / 2);
            held({ pitch: 0, yaw: -FACE_HEAD_SWEEP.amp * dir * gain, roll: 0 }, span / 2, span / 2);
        }
        if (acts.has("recalls")) {
            brows("raise");
            glance("glance_away");
            held({ pitch: 0, yaw: 0, roll: FACE_HEAD_TILT * side() }, 0, span);
        }
        if (acts.has("asks") && !acts.has("negates") && !acts.has("recalls")) {
            const roll = Math.random();
            if (roll < FACE_QUESTION_RAISE_P) brows("raise");
            else if (roll < FACE_QUESTION_RAISE_P + FACE_QUESTION_FROWN_P) brows("knit");
        }
        if (acts.has("asked")) glance("glance_away");
        if (acts.has("agrees")) this._move("nod", Date.now(), 1);
        // Told something worth taking in: the listener's brow raise
        // (Chovil 1991 — among recipients a raise works as a response and a
        // backchannel). It is a BURST and not a mood because Dix & Groß
        // 2023 separate the two practices: brows that move and come back
        // receipt news as understood and keep the talk going, brows that
        // are HELD mark it as worth dwelling on, "a salient visual news
        // mark displaying surprise or astonishment".
        //
        // The hold is already what a surprised mood does here — its parts
        // carry brow_raise — so the flash stands down when the mood has
        // the brows. Playing both is neither practice, and their weights
        // (the signal band over the mood band) would only clip.
        const browsHeld = (FACE_FEELINGS[face.top]?.parts || [])
            .some(([part, from, to = 3]) => part === "brow_raise" && rest >= from && rest <= to);
        if (acts.has("learns") && !browsHeld) brows("raise");

        // The anime displays' timed parts, once the feeling shows clearly:
        // the turn away (embarrassment down and aside, a huff away with the
        // eyes following) for the line, and a teasing wink as it ends.
        const top = FACE_FEELINGS[face.top];
        if (top?.turn && rest >= 2) {
            // A huff turns away at once; embarrassment takes Keltner's
            // order — the gaze down first, the head aside a beat later,
            // more often to their left (+ yaw turns the face that way on
            // either VRM generation).
            const shy = top.turn === "down";
            const dir = shy ? (Math.random() < FACE_SHY_LEFT ? 1 : -1) : side();
            held({ pitch: 0, yaw: FACE_TURN_YAW * dir, roll: 0 }, shy ? FACE_SHY_TURN_S : 0, span);
            const g = FACE_GAZE[shy ? "look_down" : "glance_away"];
            this.items.push({
                shapes: {}, presets: {}, gaze: { x: g.x * (shy ? 0 : dir) * GAZE_AMP, y: g.y * GAZE_AMP },
                ...timed({ ...FACE_SIGNALS.look_away, dur: span }, lineIn + (shy ? FACE_SHY_GAZE_S : 0)),
            });
        }
        // Remembered for the end of the turn (_turn): a reply that ends on
        // a question waits for its answer with the brows.
        if (!listening) this.lastLine = { asks: acts.has("asks"), bright };
    }

    /** The voice will stop at `endMs` (Date.now() ms): the waiting face
     *  takes over from there (_turn). */
    turnEnd(endMs) {
        this.turnEndAt = Number.isFinite(endMs) ? endMs : null;
    }

    /** The user holds the floor (true) or let it go. While they talk the
     *  companion listens, with a nod now and then (FACE_LISTEN_NOD_GAP_S). */
    listening(on) {
        this.hearing = !!on;
        if (on) {
            this.waitFrom = null;
            this.turnEndAt = null;
            this.nextNodAt = performance.now() / 1000 + FACE_LISTEN_NOD_GAP_S * (0.5 + Math.random());
        }
    }

    /** Back to neutral: eased like any other ending when a call ends,
     *  `snap` for a companion switch, where the incoming character must not
     *  inherit the outgoing one's face. */
    clear({ snap = false } = {}) {
        if (snap) {
            this.items = [];
        } else {
            const now = performance.now() / 1000;
            for (const it of this.items) this._retire(it, now, this.emotions.neutral.blendDuration);
        }
        this.moodItem = null;
        this.traceItem = null;
        this.moodKey = null;
        this.markAt = null;
        this.markFeel = null;
        this.waitFrom = null;
        this.turnEndAt = null;
        this.turnAt = null;
        this.lastLine = null;
        this.winkedLast = false;
        this.hearing = false;
        this.r._idle?.clearHeadMoves();
    }

    /** Per frame, before blink and the emotion presets: compose the layers
     *  and write the face morphs. Layers MAX on a shared morph, the micro
     *  drift adds on top. Leaves `blink`, `wink`, `presets` and `gaze` for
     *  the renderer, and the head's posture and gaze hold on the idle
     *  engine for the next frame's pose. */
    update(delta) {
        const r = this.r;
        const rig = this._rigFor();
        const now = performance.now() / 1000;
        const dt = delta || 0;
        if (this.on) this._beats(rig, now);
        // The mood's mark, held back to its line (see react).
        if (this.markAt !== null && now >= this.markAt) {
            this.markAt = null;
            r._moodMarks?.show(this.markName);
        }
        const morphs = {};
        const presets = {};
        const bearing = { pitch: 0, yaw: 0, roll: 0 };
        let wink = null;
        let gx = 0, gy = 0;
        this.items = this.items.filter((it) => {
            const e = this._env(it, now);
            if (e < 0) return false;
            for (const [m, w] of Object.entries(it.shapes)) morphs[m] = Math.max(morphs[m] || 0, w * e);
            for (const [n, w] of Object.entries(it.presets)) presets[n] = Math.max(presets[n] || 0, w * e);
            if (it.gaze) {
                gx += it.gaze.x * e;
                gy += it.gaze.y * e;
            }
            if (it.bearing) for (const ax in bearing) bearing[ax] += it.bearing[ax] * Math.min(1, e);
            if (it.wink && e > 0) (wink ||= {})[it.wink] = Math.min(1, e);
            return true;
        });
        for (const [m, v] of Object.entries(this._microStep(now, rig))) {
            morphs[m] = (morphs[m] || 0) + v;
        }
        // Stand aside for set_emotion, a manual emotion or a clip that
        // animates the emotion presets itself — easing out and back in at
        // neutral's blend time rather than cutting.
        const ge = r._clipExpressions(r);
        const owned = (r._currentEmotion && r._currentEmotion !== "neutral")
            || (ge && this.emotionNames.some((n) => ge.has(n)));
        const step = dt / this.emotions.neutral.blendDuration;
        this.yield = owned ? Math.max(0, this.yield - step) : Math.min(1, this.yield + step);
        const y = this.yield;
        const talking = (r._rawSpeakingIntensity || 0) > FACE_TALK_ON;
        this.talk = Math.max(0, Math.min(1, this.talk + (talking ? dt / FACE_TALK_UP_S : -dt / FACE_TALK_DOWN_S)));
        // The jaw as the lip-sync opens it, smoothed over about a syllable
        // (FACE_JAW_TAU_S): a smile's corners follow the speech's overall
        // opening instead of flickering with every vowel.
        const v = r._currentVowels || {};
        const jawNow = Math.min(1, Math.max(v.aa || 0, v.oh || 0));
        this.jaw += (jawNow - this.jaw) * (1 - Math.exp(-dt / FACE_JAW_TAU_S));
        // Eyelids take VRM's overrideBlink "blend" rule — blink × (1 −
        // saturate(sum of the eye shapes)) — so a blink never closes lids an
        // expression has already half closed: summed, they overshoot and deform.
        let eyes = 0;
        for (const name of new Set([...Object.keys(morphs), ...rig.driven])) {
            let w = Math.min(1, morphs[name] || 0) * y;
            if (FACE_JAW_SHAPES.has(name)) w *= 1 - this.talk;
            else if (MOUTH_SHAPE.test(name)) w = Math.min(w, 1 - this.jaw);
            if (EYE_SHAPE.test(name)) eyes += w;
            for (const [mesh, idx] of rig.morphs[name] || []) mesh.morphTargetInfluences[idx] = w;
            if (w > 0) rig.driven.add(name);
            else rig.driven.delete(name);
        }
        this.blink = 1 - Math.min(1, eyes);
        this.wink = wink && y > 0 ? Object.fromEntries(Object.entries(wink).map(([k, w]) => [k, w * y])) : null;
        let out = null;
        for (const [n, w] of Object.entries(presets)) (out ||= {})[n] = Math.min(1, w) * y;
        this.presets = out;
        this.gaze = { x: gx * y, y: gy * y };
        const d = r._idle?.director;
        if (d) {
            d.on = this.on;
            d.down = rig.down;
            d.pitch = bearing.pitch * y;
            d.yaw = bearing.yaw * y;
            d.roll = bearing.roll * y;
            d.hold = this.on ? this._turn(rig, now, talking) : 0;
        }
    }

    // ── internals ─────────────────────────────────────────────────────

    /** Queue one head move on the idle engine as minimum-jerk keyframes,
     *  its (first) peak on `atMs` (Date.now() ms), scaled by `gain`.
     *  `cycles` forces a nod or shake's repeats (a rule that asks for one). */
    _move(kind, atMs, gain, cycles = 0) {
        const head = this.r._idle;
        if (!head) return;
        // One draw scales the move's size and its time together: a smaller
        // move is a quicker one.
        const [lo, hi] = FACE_HEAD_SIZE;
        const size = gain * (lo + Math.random() * (hi - lo));
        const time = lo + Math.random() * (hi - lo);
        let axis = "pitch";
        let keys;
        let peak;
        let settle;
        if (kind === "nod" || kind === "shake") {
            const n = kind === "nod" ? FACE_HEAD_NOD : FACE_HEAD_SHAKE;
            cycles ||= Math.random() < n.single ? 1 : 2 + Math.floor(Math.random() * (n.maxCycles - 1));
            const dur = (n.dur + (cycles - 1) * (n.maxDur - n.dur) / (n.maxCycles - 1)) * time;
            const period = dur / cycles;
            const amp = (c) => n.amp * size * (cycles > 1 ? 1 - (1 - n.lastScale) * c / (cycles - 1) : 1);
            keys = [[0, 0]];
            if (kind === "nod") {
                // Down to each cycle's depth and back up, stopping at both.
                for (let c = 0; c < cycles; c++) {
                    keys.push([(c + 0.5) * period, amp(c)], [(c + 1) * period, 0]);
                }
                peak = period / 2;
            } else {
                // Out to one side and the other, peak to peak, then home.
                axis = "yaw";
                const dir = side();
                for (let c = 0; c < cycles; c++) {
                    keys.push([(c + 0.25) * period, dir * amp(c) / 2], [(c + 0.75) * period, -dir * amp(c) / 2]);
                }
                keys.push([dur, 0]);
                peak = period / 4;
            }
            settle = period / 4;
        } else if (kind === "stress") {
            const s = FACE_HEAD_STRESS;
            // Which axis, and which of Graf's three shapes.
            const [axisName, axisSize] = draw(FACE_STRESS_AXES);
            axis = axisName;
            // Sized in the same proportion, and to either side off the nod.
            let amp = s.amp * size * (axisSize / FACE_STRESS_AXES[0][1]);
            if (axis !== "pitch") amp *= side();
            const [shape] = draw(FACE_STRESS_SHAPES);
            keys = [[0, 0], [s.rise * time, amp]];
            peak = s.rise * time;
            if (shape === "swing") {
                // Out and then home so slowly it barely reads as a return.
                keys.push([s.rise * time + FACE_SWING_HOME_S, 0]);
                settle = 0;
            } else {
                keys.push([(s.rise + s.fall) * time, 0]);
                settle = shape === "overshoot" ? s.fall * time / 2 : 0;
            }
        } else if (kind === "sweep") {
            axis = "yaw";
            const s = FACE_HEAD_SWEEP;
            keys = [[0, 0], [s.dur * time / 2, side() * s.amp * size], [s.dur * time, 0]];
            peak = s.dur * time / 2;
            settle = s.dur * time / 4;
        } else {
            return;
        }
        // Where it returns, the return carries past rest by a tenth and
        // settles back.
        if (settle > 0) {
            const [endAt] = keys.pop();
            const last = keys[keys.length - 1][1];
            keys.push([endAt, -last * FACE_HEAD_OVERSHOOT], [endAt + settle, 0]);
        }
        head.addHeadMove({ axis, keys, delay: (atMs - Date.now()) / 1000 - peak });
    }

    /** A feeling blend as face shapes: each feeling's parts (FACE_FEELINGS)
     *  that belong at `level`, at `w` × its share. Returns { shapes, presets }
     *  — presets for an avatar whose expressions couldn't be split. */
    _mix(rig, feelings, level, w) {
        const shapes = {};
        const presets = {};
        for (const [feeling, share] of Object.entries(feelings)) {
            for (const [part, from, to = 3] of FACE_FEELINGS[feeling]?.parts || []) {
                if (level < from || level > to) continue;
                const got = this._channel(rig, part, share * w);
                for (const [m, v] of Object.entries(got?.shapes || {})) shapes[m] = (shapes[m] || 0) + v;
                for (const [n, v] of Object.entries(got?.presets || {})) presets[n] = (presets[n] || 0) + v;
            }
        }
        return { shapes, presets };
    }

    /** How a feeling blend holds the head: a posture (FACE_BEARING) and a
     *  gain on the head's moves (FACE_HEAD_GAIN), both scaled by how much
     *  the feeling shows. */
    _bearing(feelings, level) {
        const k = level / 2;
        const bearing = { pitch: 0, yaw: 0, roll: 0 };
        let gain = 1;
        for (const [feeling, share] of Object.entries(feelings)) {
            const b = FACE_BEARING[feeling];
            if (b) for (const ax of ["pitch", "yaw", "roll"]) bearing[ax] += (b[ax] || 0) * share * k;
            gain += ((FACE_HEAD_GAIN[feeling] ?? 1) - 1) * share * k;
        }
        return { bearing, gain };
    }

    /** The current mood's head gain (1 when there is no mood). */
    _gain() {
        return this.moodItem?.gain ?? 1;
    }

    /** One face channel on this rig, at weight `w`: an expression half
     *  ("happy:mouth") or an accent ("brow_raise") — the first of its
     *  options the rig has (a sided option picks a side). An unsplit
     *  expression falls back to the whole preset, upper halves only. Null
     *  when the rig can't show it. */
    _channel(rig, name, w) {
        this._recording?.add(name);
        const got = this._resolve(rig, name, w * this.r.faceTuning(name));
        // A shape can also be tuned on its own (`shape:<morph>`), for a
        // channel made of several (the smiling eyes: eye and brow shapes).
        if (got) {
            for (const m of Object.keys(got.shapes)) {
                this._recording?.add(`shape:${m}`);
                got.shapes[m] *= this.r.faceTuning(`shape:${m}`);
            }
        }
        return got;
    }

    /** The tuning channels and shapes `fn` plays, as it plays them. */
    record(fn) {
        const seen = (this._recording = new Set());
        try {
            fn();
        } finally {
            this._recording = null;
        }
        return seen;
    }

    /** The morphs the tunable channels write on this model (not the split
     *  expression halves, which are channels themselves): [{ id:
     *  "shape:<morph>", morph, size, channels }], for tuning one shape of
     *  a channel made of several. */
    tuningShapes() {
        const rig = this._rigFor();
        const found = new Map();
        for (const { channels } of FACE_TUNING) {
            for (const { id } of channels) {
                if (id === "gaze" || id.startsWith("emotion:")) continue;
                const opts = FACE_ACCENTS[id];
                const got = this._resolve(rig, id, 1);
                // Both sides of a one-sided option, not just the one drawn.
                const side = opts?.find((o) => o.side && o.side.every((m) => rig.morphs[m]))?.side;
                for (const m of side || Object.keys(got?.shapes || {})) {
                    if (m.startsWith("rx:")) continue;
                    if (!found.has(m)) found.set(m, { id: `shape:${m}`, morph: m, size: this._shapesSize(rig, { [m]: 1 }), channels: [] });
                    found.get(m).channels.push(id);
                }
            }
        }
        return [...found.values()];
    }

    /** `_channel` before the look's tuning. */
    _resolve(rig, name, w) {
        const options = FACE_ACCENTS[name] || [{ [`rx:${name}`]: 1 }];
        for (const opt of options) {
            if (opt.side) {
                if (!opt.side.every((m) => rig.morphs[m])) continue;
                return { shapes: { [pick(opt.side)]: w }, presets: {} };
            }
            // A named expression the model's author rigged, rather than a
            // morph we drive ourselves — the first of the names it has.
            if (opt.expr) {
                const found = opt.expr.find((n) => rig.exprs.has(n));
                if (!found) continue;
                return { shapes: {}, presets: { [found]: w } };
            }
            if (!Object.keys(opt).every((m) => rig.morphs[m])) continue;
            return { shapes: Object.fromEntries(Object.entries(opt).map(([m, k]) => [m, k * w])), presets: {} };
        }
        const [preset, half] = name.split(":");
        if (half === "upper" && !rig.parts[preset] && this.emotions[preset]) {
            return { shapes: {}, presets: { [this.emotions[preset].name]: w } };
        }
        return null;
    }

    /** Each tunable channel's size on this model at full weight (metres),
     *  as the director would play it — the option the rig takes, before
     *  tuning — or null where the model can't show it. For auto-tune and
     *  the tuning dialog. */
    tuningSizes() {
        const rig = this._rigFor();
        const vrm = this.r.vrm;
        const out = {};
        for (const { channels } of FACE_TUNING) {
            for (const { id } of channels) {
                const [kind, state] = id.split(":");
                if (kind === "emotion") {
                    const name = this.emotions[state]?.name;
                    out[id] = name && vrm?.expressionManager?.getExpression?.(name)
                        ? expressionSize(vrm, name) : null;
                    continue;
                }
                if (id === "gaze") {
                    out[id] = this.r.eyeRange();
                    continue;
                }
                const got = this._resolve(rig, id, 1);
                if (!got) {
                    out[id] = null;
                } else if (Object.keys(got.shapes).length) {
                    out[id] = this._shapesSize(rig, got.shapes);
                } else {
                    const preset = Object.keys(got.presets)[0];
                    out[id] = preset ? expressionSize(vrm, preset) : null;
                }
            }
        }
        return out;
    }

    /** Largest vertex displacement of morphs written together at weights
     *  {morph: k}: summed per shared vertex buffer, like the GPU does. */
    _shapesSize(rig, shapes) {
        const sums = new Map();
        for (const [m, k] of Object.entries(shapes)) {
            const seen = new Set();
            for (const [mesh, idx] of rig.morphs[m] || []) {
                const g = mesh.geometry;
                const attr = g?.morphAttributes?.position?.[idx];
                if (!attr || seen.has(attr)) continue;
                seen.add(attr);
                const key = g.attributes.position;
                let d = sums.get(key);
                if (!d) sums.set(key, (d = new Float32Array(attr.count * 3)));
                for (let i = 0; i < attr.count; i++) {
                    d[i * 3] += k * attr.getX(i);
                    d[i * 3 + 1] += k * attr.getY(i);
                    d[i * 3 + 2] += k * attr.getZ(i);
                }
            }
        }
        let max = 0;
        for (const d of sums.values()) {
            for (let i = 0; i < d.length; i += 3) max = Math.max(max, Math.hypot(d[i], d[i + 1], d[i + 2]));
        }
        return max;
    }

    /** The tuning dialog: one channel alone at full strength (its tuning
     *  applied) for a couple of seconds, over whatever else is showing. */
    previewChannel(id) {
        const [kind, state] = id.split(":");
        if (kind === "emotion") {
            this.r.setEmotion(state);
            return;
        }
        const now = performance.now() / 1000;
        const timing = { start: now, rise: 0.15, hold: 1.6, fall: 0.3, burst: false };
        if (id === "gaze") {
            // A full glance to one side and back; the range tuning applies.
            this.items.push({ shapes: {}, presets: {}, gaze: { x: side() * GAZE_AMP, y: 0 }, ...timing });
            return;
        }
        if (kind === "shape") {
            const m = id.slice(6);
            this.items.push({ shapes: { [m]: this.r.faceTuning(id) }, presets: {}, ...timing });
            return;
        }
        const rig = this._rigFor();
        const got = this._channel(rig, id, 1);
        if (!got) return;
        this.items.push({ ...got, ...timing });
    }

    /** The avatar's face morphs, found once per VRM: name → [[mesh, index]]
     *  across every primitive that carries it (a VRoid face is split into
     *  several) — the region and ARKit shapes the accents use where it has
     *  them, and, once the director first runs on it, its emotion
     *  expressions split into halves (face_regions.js). `driven` is what we
     *  wrote non-zero last frame, so it can be put back to 0 — no expression
     *  binds these morphs, so nothing else ever resets them. */
    _rigFor() {
        const vrm = this.r.vrm;
        let rig = this.rig;
        if (rig?.vrm !== vrm) {
            const morphs = {};
            const opts = Object.values(FACE_ACCENTS).flat();
            const wanted = new Set(opts
                .flatMap((o) => o.side || (o.expr ? [] : Object.keys(o)))
                .filter((m) => !m.startsWith("rx:")));
            vrm?.scene?.traverse((o) => {
                const dict = o.morphTargetDictionary;
                if (!dict || !o.morphTargetInfluences) return;
                for (const name of wanted) {
                    if (name in dict) (morphs[name] ||= []).push([o, dict[name]]);
                }
            });
            // Which of the expressions a channel can ask for by name this
            // model actually carries (getExpression is undefined for the
            // rest). Custom ones keep the name their author gave them, so
            // the lookup is by exact name and case.
            const em = vrm?.expressionManager;
            const exprs = new Set(opts.flatMap((o) => o.expr || [])
                .filter((n) => em?.getExpression?.(n)));
            // Which way a positive head pitch turns this rig: down when the
            // face looks along +Z in the head's frame, up along −Z (VRM 0.x).
            const fz = vrm?.lookAt?.faceFront?.z;
            const down = fz ? Math.sign(fz) : (vrm?.meta?.metaVersion === "1" ? 1 : -1);
            rig = this.rig = { vrm, morphs, exprs, parts: {}, split: false, down, driven: new Set() };
            if (exprs.size) console.log(`[face] rigged expressions: ${[...exprs].join(", ")}`);
        }
        if (this.on && !rig.split && vrm) {
            rig.split = true;
            const t0 = performance.now();
            try {
                const { morphs, parts } = splitEmotionExpressions(vrm, this.r.libs.THREE);
                Object.assign(rig.morphs, morphs);
                rig.parts = parts;
                const got = Object.entries(parts).map(([p, h]) => `${p}(${Object.keys(h).join("+")})`).join(" ");
                const extra = Object.keys(rig.morphs).filter((m) => !m.startsWith("rx:")).length;
                console.log(`[face] expressions split: ${got || "none"}; ${extra} finer shapes`
                    + ` (${Math.round(performance.now() - t0)} ms)`);
            } catch (e) {
                console.warn("[face] expression split failed", e);
            }
        }
        return rig;
    }

    /** A timed face item's level now: 0 before it starts, easing up (to the
     *  burst, then settling to 1), holding, easing down; -1 once it is over.
     *  A retired item fades from wherever it was. */
    _env(it, now) {
        if (it.fallStart !== undefined) {
            const u = (now - it.fallStart) / it.fall;
            return u >= 1 ? -1 : it.fallFrom * (1 - easeInOutCubic(Math.max(0, u)));
        }
        const t = now - it.start;
        if (t < 0) return 0;
        const peak = it.burst ? FACE_BURST : 1;
        if (t < it.rise) return peak * easeInOutCubic(t / it.rise);
        const h = t - it.rise;
        if (it.burst && h < FACE_BURST_S) return FACE_BURST - (FACE_BURST - 1) * easeInOutCubic(h / FACE_BURST_S);
        if (h < it.hold) return 1;
        const f = (h - it.hold) / it.fall;
        return f >= 1 ? -1 : 1 - easeInOutCubic(f);
    }

    /** End an item early, fading from its current level over `fall` s. */
    _retire(it, now, fall) {
        if (it.fallStart !== undefined) return;
        it.fallFrom = Math.max(0, this._env(it, now));
        it.fallStart = now;
        it.fall = fall;
    }

    /** Stressed syllables, read off the voice: log the loudness while they
     *  talk, and on a crossing of its 90th percentile maybe add a brow beat
     *  (FACE_BEAT_*). */
    _beats(rig, now) {
        const b = (this.beat ||= {
            buf: new Float32Array(FACE_BEAT_WINDOW), n: 0, i: 0, p90: Infinity, prev: 0, last: -Infinity, frames: 0,
        });
        const v = this.r._rawSpeakingIntensity || 0;
        if (v > FACE_TALK_ON) {
            b.buf[b.i] = v;
            b.i = (b.i + 1) % b.buf.length;
            b.n = Math.min(b.n + 1, b.buf.length);
            // A second of speech before the first percentile; then refreshed
            // every 15 frames, which is plenty for a level that moves slowly.
            if (b.n >= 60 && ++b.frames % 15 === 1) {
                const sorted = Array.from(b.buf.subarray(0, b.n)).sort((x, y) => x - y);
                b.p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
            }
            if (b.prev < b.p90 && v >= b.p90 && now - b.last >= FACE_BEAT_GAP_S && Math.random() < FACE_BEAT_P) {
                b.last = now;
                const [lo, hi] = FACE_SIGNAL_BAND;
                const got = this._channel(rig, "brow_raise", lo + Math.random() * (hi - lo));
                if (got) this.items.push({ ...got, start: now, rise: 0.1, hold: 0.2, fall: 0.2, burst: false });
            }
        }
        b.prev = v;
    }

    /** The micro drift's level per morph now (FACE_MICRO_*), starting a
     *  new move on a channel whose last one is done — only while the
     *  director is on, so turning it off lets the drift run out. */
    _microStep(now, rig) {
        const micro = (this.micro ||= Object.fromEntries(
            FACE_MICRO_CHANNELS.map((c) => [c, { start: 0, rise: 1, hold: 0, amp: 0, next: now + Math.random() * 5 }])));
        const out = {};
        for (const [channel, s] of Object.entries(micro)) {
            const shapes = this._channel(rig, channel, 1)?.shapes;
            if (!shapes || !Object.keys(shapes).length) continue;
            if (this.on && now >= s.next) {
                const r = Math.random();
                s.start = now;
                s.rise = 0.1 + Math.random() * 0.4;
                s.hold = 1 + Math.random() * 4;
                s.amp = FACE_MICRO_AMP * r * r;
                s.next = now + 2 * s.rise + s.hold + 0.1 + Math.random() * 4.9;
            }
            const t = now - s.start;
            let v = 0;
            if (t < s.rise) v = easeInOutCubic(t / s.rise);
            else if (t < s.rise + s.hold) v = 1;
            else if (t < 2 * s.rise + s.hold) v = 1 - easeInOutCubic((t - s.rise - s.hold) / s.rise);
            if (v > 0) for (const [m, k] of Object.entries(shapes)) out[m] = (out[m] || 0) + k * s.amp * v;
        }
        return out;
    }

    /** Around the end of a turn and while the user talks: the waiting face
     *  once the voice stops (a brow for the answer, the mood held for
     *  FACE_WAIT_S, then let go), eye contact peaking at the hand-over
     *  (FACE_TURN_GAZE_*), and a listener's nods while the user speaks.
     *  Returns the gaze hold, 0..1. */
    _turn(rig, now, talking) {
        const nowMs = Date.now();
        if (this.turnEndAt && nowMs >= this.turnEndAt && !talking) {
            this.waitFrom = this.turnEndAt;
            this.turnAt = this.turnEndAt;
            this.turnEndAt = null;
            // A reply that ends on a question waits for its answer: a brow
            // flash after a light one, a held raise after a pointed one.
            const last = this.lastLine;
            if (last?.asks) {
                const [lo, hi] = FACE_SIGNAL_BAND;
                const got = this._channel(rig, "brow_raise", lo + Math.random() * (hi - lo));
                const dur = last.bright ? FACE_REPLY_FLASH_S
                    : FACE_REPLY_HOLD_S[0] + Math.random() * (FACE_REPLY_HOLD_S[1] - FACE_REPLY_HOLD_S[0]);
                const t = FACE_SIGNALS.brow_raise;
                if (got) {
                    this.items.push({ ...got, start: now, rise: t.rise, hold: Math.max(0, dur - t.rise - t.fall),
                        fall: t.fall, burst: false });
                }
            }
            this.lastLine = null;
        }
        if (this.waitFrom && nowMs - this.waitFrom >= FACE_WAIT_S * 1000) {
            this.waitFrom = null;
            if (this.moodItem) {
                // The feeling thins to a trace rather than going out.
                const { feelings, level, band } = this.moodItem;
                this._retire(this.moodItem, now, FACE_MOOD_S);
                this.moodItem = null;
                this.moodKey = null;
                const thin = FACE_TRACE_W / band;
                const bearing = this._bearing(feelings, level).bearing;
                for (const ax in bearing) bearing[ax] *= thin;
                this.traceItem = {
                    ...this._mix(rig, feelings, level, FACE_TRACE_W), bearing, gain: 1,
                    start: now, rise: FACE_MOOD_S, hold: Infinity, fall: FACE_MOOD_S, burst: false,
                };
                this.items.push(this.traceItem);
            }
        }
        if (this.hearing && !talking && now >= this.nextNodAt) {
            if (this.nextNodAt) this._move("nod", nowMs, 1);
            this.nextNodAt = now - Math.log(1 - Math.random() * 0.999) * FACE_LISTEN_NOD_GAP_S;
        }
        const turnAt = this.turnEndAt || this.turnAt;
        if (!turnAt) return 0;
        return FACE_TURN_GAZE_HOLD * Math.max(0, 1 - Math.abs(nowMs - turnAt) / (FACE_TURN_GAZE_S * 1000));
    }
}
