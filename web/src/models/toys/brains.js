// What the companion does with each toy. The toys are "smart objects": the
// toy carries the know-how for playing with it, and the companion only
// needs a body that can walk somewhere, play a clip, hold something and
// say a word. Both stages give one (models/toys/screen_stage.js on the
// roaming desktop, models/toys/scene_stage.js in the 3D view), in metres
// with y up, so every routine here runs unchanged on either.
//
// A body (see ScreenBody / SceneBody):
//   key, pos(), head(), mouth(), chest(), hand(side), reach, userPoint(), inCall
//   goTo(point, ctx, {run, gap}) → bool, face(point), faceUser(), lookAt(point, ms)
//   play(url, ctx, {loop, maxMs}), rest(), wait(ms, ctx), check(ctx), emotion(name)
//   hold(toy, grip), letGo(toy, velocity), say(text, ms), fx(name, ...args)
//   openMouth(shape, ms), note(text, {respond}), stage (the toys' world)

import { _t } from "../../lib/i18n";
import { TOYS, HOOP, GOAL, POSTS, tasteOf } from "./catalog";
import { GRAVITY, MAX_THROW, add, dist, flatDist, len, norm, scale, solveLaunch, sub, v3 } from "./physics";
import { toySfx } from "./sfx";

const VRMA = "/assets/vrma";
const TOY = (n) => `${VRMA}/toys/${n}.vrma`;
const LIB = (n) => `${VRMA}/${n}.vrma`;
const ROAM = (n) => `${VRMA}/roam/${n}.vrma`;

export const CLIP = {
    pickup: TOY("pickup"), hold: TOY("hold"), catch: TOY("catch"), shoot: TOY("shoot"),
    toss: TOY("toss"), breeze: TOY("breeze"),
    dryHair: TOY("dry_hair"), waft: TOY("waft"), hug: TOY("hug"), blow: TOY("blow"),
    read: TOY("read"), spicy: TOY("spicy"), open: TOY("open"), rub: TOY("rub_head"),
    popIn: TOY("pop_in"), peel: TOY("peel"), lick: TOY("lick"),
    tossUp: TOY("toss_up"), mouthCatch: TOY("mouth_catch"),
    slurp: TOY("slurp"), sip: TOY("sip"), swig: TOY("swig"), bottle: TOY("bottle"), clapPop: TOY("clap_pop"),
    holdSmall: TOY("hold_small"), catchSmall: TOY("catch_small"), pickupSmall: TOY("pickup_small"),
    warmHands: TOY("warm_hands"), stargaze: TOY("stargaze"), peerIn: TOY("peer_in"), sprinkle: TOY("sprinkle"),
    eat: ROAM("eat"), kick: LIB("Kick"),
    clap: LIB("Clapping"), jump: LIB("Jump"), surprised: LIB("Surprised"), sad: LIB("Sad"),
    thinking: LIB("Thinking"), peace: LIB("VRMA_03_peace_sign"), spin: LIB("VRMA_05_spin"),
    // Dances that stay on the spot (BellyDance carries the hips a metre).
    dances: [LIB("Dance"), ...["girl-groove", "hip-hop", "locking", "house"].map((n) => `${VRMA}/dances/${n}.vrma`)],
};

// When the hands meet the toy or let it go, into each clip (ms), as the
// clips are authored (tools/motion/roam_motions/build_roam_motions.py).
// The bundled Kick swings the left leg up to its peak at 1.04 s; the foot
// meets the ball on the way up.
const GRAB_MS = { pickup: 620, catch: 260 };
// Something smaller than this across (by eye: under a hand's span) is
// picked up, caught and held with the hands close round it (the _small
// clips, same moments); a ball, between them.
const SMALL_R = 0.075;              // m
const sized = (toy, clip) => (toy.radius < SMALL_R ? CLIP[`${clip}Small`] : CLIP[clip]);
const RELEASE_MS = { shoot: 560, toss: 520, kick: 950, tossUp: 300 };
// Eating, per catalog food style: which hand holds it, and the moments in
// the clips: pop_in at the mouth, each strip of peel down, the lick up the
// scoop (into each lick loop), the head snapping onto a catch; a mouthful
// into each loop of the drinking clips (and how long a loop is), and the
// bottle's cap off and gulps.
const EAT_GRIP = {
    bite: "both", peel: "left", pop: "right", lick: "right", catch: "right",
    slurp: "left", sip: "both", swig: "right", bottle: "right",
};
const POP_MS = 420;
// The eat clip's hands are at the mouth once its 0.25 s fade in (the
// renderer's gesture crossfade) is through, give or take a frame or two.
const EAT_REACH_MS = 350;
const PEEL_MS = [600, 1300, 2000];
const LICK_MS = 850, LICK_LOOP_MS = 1600;
const CATCH_MS = 550;
const DRINK = {
    slurp: { clip: "slurp", loop: 2200, at: 1100, tip: 0 },
    sip: { clip: "sip", loop: 5000, at: 2100, tip: 0.6 },
    swig: { clip: "swig", loop: 1800, at: 800, tip: 1.0 },
};
const BOTTLE_CAP_MS = 850, BOTTLE_UP_MS = 1500, BOTTLE_GULP_MS = [1800, 2300, 2800], BOTTLE_DOWN_MS = 3100, BOTTLE_MS = 4000;
// A clap round a bubble: the hands meet ≈0.45 s in.
const CLAP_MS = 450;
// Fish food: the pinch rubbed out over the water ≈0.9 s into the clip.
const SPRINKLE_MS = 900;
// Now and then one has gone off (by eye: about one in eight); then it's
// that one, not the food, they turn their nose up at.
const OFF_ODDS = 1 / 8;
// A coffee: they're buzzing for a couple of minutes after (by eye),
// running everywhere and up for play twice as often.
const WIRED_MS = 120000;
// A grape tossed up for themselves: 3.2 m/s up from the hand (by eye: a
// half-metre toss), aimed to come down on the mouth give or take 12 cm
// (by eye). Caught when it comes within MOUTH_R of the mouth (by eye: a
// mouth's gape and a lunge at it); one thrown at them is gone for when it
// comes down within MOUTH_REACH (by eye: a step or two and a lean).
const TOSS_UP_SPEED = 3.2;
const TOSS_UP_ERR = 0.12;          // m
const MOUTH_R = 0.09;              // m
const MOUTH_REACH = 1.2;           // m
// Ice cream: now and then they eat it too fast (by eye).
const BRAIN_FREEZE_ODDS = 0.35;

// A basketball shot: released at 52° above level (Tran & Silverberg 2008,
// optimal free throw), within ±1.5° and ±1.5 % of the speed it needs — a
// good amateur's spread (by eye), so most go in and some rattle out.
const SHOT_ANGLE = 52 * Math.PI / 180;
const SHOT_ANGLE_ERR = 1.5 * Math.PI / 180;
const SHOT_SPEED_ERR = 0.015;
// Where they shoot from: about a mini court's free-throw distance from the
// board (by eye).
const SHOT_DISTANCE = 4.0;
// Idle in the room, they go to toys this close at most (by eye).
const IDLE_REACH = 2.5;            // m
// Nor on their own while either of you is talking, or for this long after
// the last word (by eye: a pause that's a pause, not a breath).
const QUIET_MS = 10000;
// A penalty: from futsal's penalty mark (catalog GOAL.spot), a driven kick
// at 18° above level (by eye) somewhere in the goal mouth, as fast as it
// needs up to 25 m/s; its aim off by ±0.25 m (by eye), so the post gets
// hit now and then.
const KICK_ANGLE = 18 * Math.PI / 180;
const KICK_MAX = 25;               // m/s
const KICK_AIM_ERR = 0.25;         // m
// A rugby place kick off the tee (catalog POSTS): up at 45°, or 15° above
// the line to where it's aimed when that's steeper (by eye), as fast as it
// needs up to 28 m/s; aimed between the posts and 0.3-1.2 m over the bar,
// off by up to ±2.6 m across and ±1 m up (by eye). That puts about 7 in 10
// over, 1.5 under the bar and 1 wide or off a post (the 3D room; on the
// desktop, side on, a kick can't go wide).
const PLACE_ANGLE = 45 * Math.PI / 180;
const PLACE_ABOVE_SIGHT = 15 * Math.PI / 180;
const PLACE_MAX = 28;              // m/s
const PLACE_ERR_ACROSS = 2.6;      // m
const PLACE_ERR_UP = 1.0;          // m
const RUN_UP_BACK = 2.2, RUN_UP_SIDE = 0.9;
// A kicked rugby ball turns end over end this fast (by eye).
const PLACE_TUMBLE = 12;           // rad/s
// Chewing at 1.29 chews a second (habitual chewing, measured in healthy
// adults, University of Brasília); a few chews a bite (by eye).
const CHEW_HZ = 1.29;
const CHEWS_PER_BITE = 3;
// Bubbles from a wand: how many breaths a go, and how many a breath (by
// eye); then a few popped.
const BREATHS = [6, 9];
const BUBBLES_PER_BREATH = [3, 9];
const POPS = [1, 3];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// ── what the call is told ─────────────────────────────────────────────────
// A note as a routine starts (toybox.js note): how the toy came to them,
// what they're about to do with it and about how long that takes (for
// their timing; said aloud it reads oddly), asking for a reaction when the
// user started it. After: the result, as context only, unless it's
// something they couldn't have known at the start (a surprise).

/** How `toy` came to them, by `why` (see playWith). */
function cameBy(toy, why) {
    const n = toy.def.note;
    switch (why) {
        case "offer": return `The user just held out ${n} to you and you took it.`;
        case "caught": return `The user just threw you ${n} and you caught it.`;
        case "hit": return `The user just threw ${n} and it bumped into you.`;
        case "dropped": return `The user just put ${n} down near you.`;
        case "on": return `The user just switched on ${n} near you.`;
        default: return `You've picked up ${n} on your own.`;
    }
}

/** "It takes about …" for `ms`. */
function takes(ms) {
    const s = ms / 1000;
    const t = s < 6 ? "a few seconds" : s < 22 ? `about ${Math.round(s / 5) * 5} seconds`
        : s < 45 ? "about half a minute" : s < 90 ? "about a minute" : `about ${Math.round(s / 60)} minutes`;
    return ` It takes ${t} (so you know how long; no need to mention the time).`;
}

// How a toy came to them when the user did it to them: their reaction cuts
// in on what they're saying (toybox.js note).
const HANDED = new Set(["offer", "caught", "hit", "thrown"]);

/** The note as it starts: a reaction asked for when the user started it. */
function startNote(body, why, text, ms) {
    body.note(text + (ms ? takes(ms) : ""), { respond: why !== "idle", interrupt: HANDED.has(why) });
}

/** A ball game is told a go at a time, as each one starts (they run long:
 *  a few at once would be old news by the last). The first go is the start
 *  note; later ones are context. Each go's result asks for a reaction
 *  (a surprise: not known when it started). */
function goNote(body, toy, why, go, first, next, ms) {
    if (go === 0) startNote(body, why, `${cameBy(toy, why)} ${first}`, ms);
    else body.note(next + takes(ms));
}

// What they're about to do with a treat, by its style, and roughly how
// long that takes: the clips' and chews' own lengths (consts above), plus
// a moment between (by eye).
const CHEW_S = CHEWS_PER_BITE / CHEW_HZ;
// A go at each ball game, in seconds: the walk to the mark, the clip, the
// flight and the cheer or groan after (timed in the room view, 2026-10-23).
const GAME_S = { hoops: 19, penalties: 21, conversion: 25 };
const EATING = {
    bite: ["eat it", (f) => 0.8 + f.bites * (CHEW_S + 0.2)],
    pop: ["pop it in your mouth", () => 3.5],
    catch: ["toss it up and catch it in your mouth", () => 3],
    peel: ["peel it and eat it", (f) => 2.4 + f.bites * (CHEW_S + 0.2)],
    lick: ["lick it, then crunch the cone", (f) => f.licks * 1.6 + f.bites * CHEW_S],
    slurp: ["eat them, a slurp at a time", (f) => f.bites * 2.2],
    sip: ["drink it slowly, a sip at a time", (f) => 1.3 + f.bites * 5],
    swig: ["drink it in a few quick swigs", (f) => f.bites * 1.8],
    bottle: ["open it and have a drink", () => 4],
};

/** Wait for a clip's moment (ms in) while it plays. */
async function at(body, ms, ctx) { await body.wait(ms, ctx); }

/** Walk over and pick `toy` up off whatever it lies on. False when it got
 *  away (taken, eaten, gone) before they got there. */
async function fetchToy(body, toy, ctx, grip = "both") {
    for (let tries = 0; tries < 3; tries++) {
        if (!toy.alive || toy.heldBy === "user") return false;
        if (toy.heldBy === "companion") return true;
        // In the air: wait for it to come down (a few seconds at most).
        if (!toy.resting) {
            const t0 = performance.now();
            while (!toy.resting && toy.alive && toy.heldBy == null && performance.now() - t0 < 4000) await body.wait(100, ctx);
            if (!toy.alive || toy.heldBy) return false;
        }
        const ok = await body.goTo(toy.p, ctx, { gap: body.reach * 0.55 });
        if (!ok) return false;
        if (!toy.alive || toy.heldBy) return false;
        // It rolled off meanwhile: after it again.
        if (flatDist(body.pos(), toy.p) > body.reach * 1.3) continue;
        body.face(toy.p);
        body.lookAt(toy.p, 1500);
        const low = toy.p.y - body.pos().y < body.height * 0.45;
        if (low) {
            const clip = body.play(sized(toy, "pickup"), ctx, { maxMs: 2200 });
            await at(body, GRAB_MS.pickup, ctx);
            if (!toy.alive || toy.heldBy === "user") { await clip.catch(() => {}); return false; }
            body.hold(toy, grip);
            await clip;
        } else {
            body.hold(toy, grip);
        }
        await body.play(sized(toy, "hold"), ctx, { loop: true });
        return true;
    }
    return false;
}

// ── treats ────────────────────────────────────────────────────────────────

/** Wait until `t` (performance.now() ms). */
async function until(body, t, ctx) { await body.wait(Math.max(0, t - performance.now()), ctx); }

/** Chewing for `ms`, the jaw going at CHEW_HZ. */
async function chew(body, ms, ctx) {
    const end = performance.now() + ms, every = 1000 / CHEW_HZ;
    while (performance.now() < end) {
        body.openMouth({ aa: 0.3 }, every * 0.35);
        await body.wait(Math.min(every, end - performance.now()), ctx);
    }
}

/** Eaten the way that treat is eaten (catalog food.style). `why`
 *  "missed": a grape that got away is just popped in this time. */
async function eat(body, toy, ctx, why) {
    const def = toy.def, food = def.food;
    const style = food.style || "bite";
    const grip = EAT_GRIP[style] || "both";
    if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx, grip))) return;
    toy.grip = grip;
    const taste = tasteFor(body, toy);
    // (A grape that got away was told about as it went.)
    if (why !== "missed") {
        // A grape held out to their mouth is just popped in.
        const [how, secs] = food.hard ? ["try to bite into it (ship's biscuit is famously hard)", () => 8]
            : EATING[style === "catch" && why === "offer" ? "pop" : style];
        const fave = tasteOf(body.key, def.id) >= 2 ? " It's one of your favourite things." : "";
        startNote(body, why, `${cameBy(toy, why)} You're about to ${how}.${fave}`, secs(food) * 1000);
    }
    body.faceUser();
    body.lookAt(body.hand(grip === "left" ? "left" : "right"), 900);
    await body.wait(400, ctx);
    if (style === "catch" && why !== "offer" && why !== "missed") return tossAndCatch(body, toy, ctx, taste, why);
    if (style === "peel" && !toy.peeled) await peelIt(body, toy, ctx);
    if (food.hard) {
        // Ship's biscuit: famously hard. Two goes before it gives.
        await body.play(CLIP.eat, ctx, { loop: true });
        for (let i = 0; i < 2; i++) {
            await body.wait(600, ctx);
            toySfx.clank();
            body.fx("comic", i ? _t("CLONK") : _t("CLANK"), body.head());
            await body.play(CLIP.surprised, ctx, { maxMs: 1400 });
            await body.play(CLIP.eat, ctx, { loop: true });
        }
    }
    const eaten = style === "pop" || style === "catch" ? await popIn(body, toy, ctx)
        : style === "lick" ? await lickIt(body, toy, ctx, taste)
            : style === "bottle" ? await bottleIt(body, toy, ctx)
                : DRINK[style] ? await drink(body, toy, ctx, style, taste)
                    : await bites(body, toy, ctx, taste);
    if (!eaten) return;
    toy.remove();
    body.rest();
    if (food.spicy) { await spicy(body, ctx, def, why); return; }
    if (food.cold && taste >= 0 && Math.random() < BRAIN_FREEZE_ODDS) { await brainFreeze(body, ctx, def); return; }
    if (food.wired && taste >= 0) { await wired(body, ctx, def); return; }
    await enjoyed(body, ctx, def, taste, why);
}

/** How this one goes down: -1 when it has gone off (decided the first
 *  time they try it), else their taste for the food. */
function tasteFor(body, toy) {
    if (toy.bad === undefined) toy.bad = !!toy.def.food?.off && Math.random() < OFF_ODDS;
    return toy.bad ? -1 : tasteOf(body.key, toy.def.id);
}

/** Mouthfuls, chewed in between. False when it had gone off and was
 *  tossed away after the first. */
async function bites(body, toy, ctx, taste) {
    const def = toy.def, food = def.food;
    await body.play(CLIP.eat, ctx, { loop: true });
    // The hands up at the mouth first (the clip's fade in).
    await body.wait(EAT_REACH_MS, ctx);
    const chewMs = (CHEWS_PER_BITE / CHEW_HZ) * 1000;
    for (let i = 1; i <= food.bites; i++) {
        if (food.crunch) toySfx.crunch(); else toySfx.chomp();
        body.openMouth({ aa: 0.7 }, 160);
        toy.bite(1 - i / food.bites);
        body.fx("crumbs", body.hand("right"), food.crumbs);
        // Gone off: one bite and they're done, and it goes.
        if (taste < 0 && i === 1) {
            await chew(body, chewMs * 0.6, ctx);
            await handBack(body, toy, ctx, "took a bite");
            return false;
        }
        // A hot pepper: a few chews before it hits.
        if (food.spicy) { await chew(body, chewMs * 0.6, ctx); break; }
        await chew(body, chewMs, ctx);
    }
    return true;
}

/** Something small, in one go: up to the mouth and gone. */
async function popIn(body, toy, ctx) {
    const clip = body.play(CLIP.popIn, ctx, { maxMs: 1400 });
    await at(body, POP_MS - 150, ctx);
    body.openMouth({ aa: 0.75 }, 220);
    await at(body, 150, ctx);
    toySfx.chomp();
    toy.remove();
    await clip.catch(() => {});
    await chew(body, (CHEWS_PER_BITE / CHEW_HZ) * 1000, ctx);
    return true;
}

/** A banana: three strips of peel down, then it's eaten in bites. */
async function peelIt(body, toy, ctx) {
    const clip = body.play(CLIP.peel, ctx, { maxMs: 3000 });
    const t0 = performance.now();
    for (let i = 0; i < PEEL_MS.length; i++) {
        await until(body, t0 + PEEL_MS[i], ctx);
        if (toy.heldBy !== "companion") break;
        toySfx.peel();
        toy.peeled = (i + 1) / PEEL_MS.length;
        body.stage.onPeel?.(toy);
    }
    await clip.catch(() => {});
    toy.grip = "both";
}

/** Ice cream: licked down, then the cone crunched. */
async function lickIt(body, toy, ctx, taste) {
    const food = toy.def.food;
    await body.play(CLIP.lick, ctx, { loop: true });
    const t0 = performance.now();
    for (let i = 0; i < food.licks; i++) {
        await until(body, t0 + i * LICK_LOOP_MS + LICK_MS, ctx);
        toySfx.lick();
        body.openMouth({ aa: 0.35, ih: 0.3 }, 350);
        // The scoop goes down to a little left in the cone.
        toy.bite(1 - (0.6 * (i + 1)) / food.licks);
        if (taste < 0 && i === 0) {
            await body.wait(600, ctx);
            await handBack(body, toy, ctx, "had a lick of it");
            return false;
        }
        if (taste >= 2 && i === 1) body.fx("hearts", body.head());
    }
    await body.wait(LICK_LOOP_MS - LICK_MS, ctx);
    await body.play(CLIP.eat, ctx, { loop: true });
    const chewMs = (CHEWS_PER_BITE / CHEW_HZ) * 1000;
    for (let i = 1; i <= food.bites; i++) {
        toySfx.crunch();
        body.openMouth({ aa: 0.6 }, 160);
        toy.bite(0.4 * (1 - i / food.bites));
        body.fx("crumbs", body.hand("right"), food.crumbs);
        await chew(body, chewMs, ctx);
    }
    return true;
}

/** Noodles slurped off the chopsticks, a tea sipped (slowly: it's hot, and
 *  blown on first), a coffee swigged: a mouthful a loop of its clip, the
 *  bowl or cup tipped to the mouth for each (toy.tip, drawn by the stage). */
async function drink(body, toy, ctx, style, taste) {
    const d = DRINK[style], food = toy.def.food;
    if (style === "sip") {
        body.lookAt(toy.p, 1500);
        body.openMouth({ ou: 0.6 }, 900);
        toySfx.blow();
        await body.wait(1300, ctx);
    }
    await body.play(CLIP[d.clip], ctx, { loop: true });
    const t0 = performance.now();
    for (let i = 0; i < food.bites; i++) {
        const at0 = t0 + i * d.loop + d.at;
        // Up to the mouth: tipped as it gets there.
        await until(body, at0 - 300, ctx);
        toy.tip = d.tip;
        await until(body, at0, ctx);
        if (style === "slurp") toySfx.slurp(); else if (style === "sip") toySfx.sip(); else toySfx.gulp();
        body.openMouth(style === "slurp" ? { ou: 0.7 } : { oh: 0.4 }, 380);
        toy.bite(1 - (i + 1) / food.bites);
        await body.wait(400, ctx);
        toy.tip = 0;
        if (taste < 0 && i === 0) {
            await body.wait(500, ctx);
            await handBack(body, toy, ctx, style === "slurp" ? "had a mouthful" : "had a sip");
            return false;
        }
        // A tea between sips: warm all the way down.
        if (style === "sip" && i === 1) {
            body.emotion("relaxed");
            body.say(taste >= 2 ? pick([_t("perfect tea~"), _t("just how I like it")]) : pick([_t("ahh~"), _t("so warm…")]), 1800);
            if (taste >= 2) body.fx("hearts", body.head());
        }
    }
    await until(body, t0 + food.bites * d.loop, ctx);
    return true;
}

/** A water bottle: the cap twisted off, head back and gulped, the back of
 *  the hand across the mouth. */
async function bottleIt(body, toy, ctx) {
    const food = toy.def.food;
    const clip = body.play(CLIP.bottle, ctx, { maxMs: BOTTLE_MS + 400 });
    const t0 = performance.now();
    await until(body, t0 + BOTTLE_CAP_MS, ctx);
    toySfx.cap();
    toy.opened = true;
    await until(body, t0 + BOTTLE_UP_MS, ctx);
    toy.tip = 1.6;
    for (let i = 0; i < BOTTLE_GULP_MS.length; i++) {
        await until(body, t0 + BOTTLE_GULP_MS[i], ctx);
        toySfx.gulp();
        body.openMouth({ oh: 0.35 }, 250);
        toy.bite(1 - (i + 1) / food.bites);
    }
    await until(body, t0 + BOTTLE_DOWN_MS, ctx);
    toy.tip = 0;
    await clip.catch(() => {});
    return true;
}

/** A coffee down: buzzing for a couple of minutes (the main companion's
 *  body.wiredUntil: stage.wired()). */
async function wired(body, ctx, def) {
    body.wiredUntil = performance.now() + WIRED_MS;
    body.emotion("surprised");
    body.fx("comic", _t("BZZT"), body.head());
    body.note(`You finished ${def.note} and the caffeine has hit: you're buzzing with energy for a couple of minutes.`, { surprise: true });
    await body.wait(500, ctx);
    body.emotion("happy");
    body.say(pick([_t("I can hear colours!"), _t("let's GO!"), _t("wide awake!!")]), 1800);
    await body.play(CLIP.jump, ctx, { maxMs: 2600 });
}

/** Gone off: a face, and it's tossed away, crumbling to bits where it
 *  lands (they won't go back for it). */
async function handBack(body, toy, ctx, what) {
    toy.refused = true;
    toy.tip = 0;
    body.note(`You ${what} and that one had gone off: it was ${toy.def.food.off}. You're tossing it away.`, { surprise: true });
    body.rest();
    body.emotion("sad");
    body.say(toy.def.vessel ? pick([_t("blegh!"), _t("ugh, that's not right…")])
        : pick([_t("blegh, a bad one!"), _t("ew, it's gone off")]), 1800);
    await body.play(CLIP.sad, ctx, { maxMs: 2200 });
    toy.grip = "both";
    await tossBack(body, toy, ctx);
    const t0 = performance.now();
    while (toy.alive && !toy.resting && !toy.heldBy && performance.now() - t0 < 3000) await body.wait(100, ctx);
    if (toy.alive && !toy.heldBy) crumble(body, toy);
}

/** A treat gone to crumbs where it lies. */
function crumble(body, toy) {
    body.fx("crumbs", toy.p, toy.def.food.crumbs);
    toy.remove();
}

/** After it's gone: how it went down. */
async function enjoyed(body, ctx, def, taste, why) {
    if (taste < 0) {
        // Gone in one before they could tell (a grape, a strawberry).
        body.note(`You ate ${def.note}, but that one had gone off: it was ${def.food.off}.`, { surprise: true });
        body.emotion("sad");
        body.say(pick([_t("blegh, a bad one!"), _t("ew, it's gone off")]), 1600);
        await body.play(CLIP.sad, ctx, { maxMs: 2200 });
        return;
    }
    // As it should be: they knew it was coming, so just the fact.
    body.note(`You finished ${def.note}.`);
    if (def.vessel) {
        body.emotion("happy");
        if (taste >= 2) body.fx("hearts", body.head());
        body.say(def.food.style === "bottle" ? pick([_t("ahh, refreshing"), _t("needed that")])
            : taste >= 2 ? pick([_t("so good!!"), _t("my favourite!")]) : pick([_t("thanks!"), _t("just what I needed")]), 1600);
        await body.play(CLIP.peace, ctx, { maxMs: 2400 });
    } else if (taste >= 2) {
        body.emotion("happy");
        body.fx("hearts", body.head());
        body.say(pick([_t("so good!!"), _t("my favourite!"), _t("mmm!!")]), 1800);
        await body.play(pick([CLIP.jump, CLIP.clap, CLIP.peace]), ctx, { maxMs: 2600 });
    } else {
        body.emotion("happy");
        body.say(pick([_t("yum!"), _t("thanks!"), _t("tasty")]), 1500);
        await body.play(CLIP.peace, ctx, { maxMs: 2400 });
    }
}

/** Ice cream eaten too fast. */
async function brainFreeze(body, ctx, def) {
    await body.wait(500, ctx);
    body.emotion("surprised");
    body.fx("comic", _t("BRAIN FREEZE"), body.head());
    body.note(`You ate ${def.note} too fast and got brain freeze.`, { surprise: true });
    body.say(pick([_t("brain freeze!!"), _t("ow ow, cold!")]), 1800);
    await body.play(CLIP.rub, ctx, { maxMs: 2200 });
    body.emotion("happy");
    body.say(_t("…worth it"), 1500);
    await body.wait(1200, ctx);
}

/** Where a small falling thing will be when it comes down to height `y`
 *  (and how long until then), flown with its drag; null if it won't. */
function comingDown(toy, y) {
    let p = { ...toy.p }, v = { ...toy.v }, t = 0;
    const dt = 1 / 120, g = GRAVITY * (1 - (toy.def.buoyancy || 0));
    for (let i = 0; i < 360; i++) {
        const sp = len(v);
        v = { x: v.x - toy.k * sp * v.x * dt, y: v.y - (g + toy.k * sp * v.y) * dt, z: v.z - toy.k * sp * v.z * dt };
        p = add(p, scale(v, dt));
        t += dt;
        if (v.y < 0 && p.y <= y) return { p, t };
    }
    return null;
}

/** Something small dropping toward them: under it, chin up, mouth open,
 *  and a snap at it. True when it's in. */
async function mouthCatch(body, toy, ctx) {
    const meet = comingDown(toy, body.mouth().y);
    if (!meet || flatDist(meet.p, body.pos()) > MOUTH_REACH) return false;
    const arrive = performance.now() + meet.t * 1000;
    // A step under it, when there's time (the mouth is a little in front
    // of their feet).
    if (flatDist(meet.p, body.pos()) > 0.2 && meet.t > 0.6) {
        await body.goTo(meet.p, ctx, { gap: 0.12, run: true });
    }
    toy.mouthCatch = true;
    toy.inMouth = false;
    try {
        await until(body, arrive - CATCH_MS, ctx);
        const clip = body.play(CLIP.mouthCatch, ctx, { maxMs: 1600 });
        body.openMouth({ aa: 0.9 }, Math.max(200, arrive - performance.now()));
        let got = false;
        while (performance.now() < arrive + 300) {
            await body.wait(16, ctx);
            if (!toy.alive || toy.heldBy) break;
            if (toy.inMouth || dist(toy.p, body.mouth()) < MOUTH_R) { got = true; break; }
        }
        if (got) {
            toySfx.gulp();
            toy.remove();
            body.openMouth({ ou: 0.5 }, 300);
        }
        await clip.catch(() => {});
        return got;
    } finally {
        toy.mouthCatch = false;
        if (toy.alive && toy.inMouth) { toy.hovering = false; toy.wake(); }
    }
}

/** A grape for themselves: up it goes, and down into the mouth (or not). */
async function tossAndCatch(body, toy, ctx, taste, why) {
    body.faceUser();
    const clip = body.play(CLIP.tossUp, ctx, { maxMs: 1200 });
    await at(body, RELEASE_MS.tossUp, ctx);
    if (toy.heldBy !== "companion") { await clip.catch(() => {}); return; }
    // Straight ballistics over half a metre (a grape's drag hardly counts
    // there): up at TOSS_UP_SPEED, across to come down on the mouth.
    const from = toy.p, mouth = body.mouth();
    const drop = from.y - mouth.y;
    const T = (TOSS_UP_SPEED + Math.sqrt(TOSS_UP_SPEED ** 2 + 2 * GRAVITY * drop)) / GRAVITY;
    const off = () => (Math.random() * 2 - 1) * TOSS_UP_ERR;
    const v = { x: (mouth.x + off() - from.x) / T, y: TOSS_UP_SPEED, z: body.stage.dims === 2 ? 0 : (mouth.z + off() - from.z) / T };
    body.letGo(toy, v);
    await clip.catch(() => {});
    if (await mouthCatch(body, toy, ctx)) return caught(body, toy.def, ctx, taste, why);
    await missed(body, toy, ctx);
}

/** Into the mouth, out of the air. */
async function caught(body, def, ctx, taste, why) {
    body.fx("comic", _t("NOM!"), body.head());
    await chew(body, 900, ctx);
    body.rest();
    await enjoyed(body, ctx, def, taste, why);
}

async function missed(body, toy, ctx) {
    body.note(`You missed the catch; ${toy.def.note} fell, and you're picking it up to eat.`);
    body.emotion("surprised");
    body.say(pick([_t("aww!"), _t("missed!"), _t("so close")]), 1300);
    await body.play(CLIP.thinking, ctx, { maxMs: 1500 });
    // Off the floor, and just eaten this time.
    if (toy.alive && !toy.heldBy) await eat(body, toy, ctx, "missed");
}

/** The pepper: a beat of nothing, then it hits. Its own reaction, cutting
 *  in on the one to the catch when the user gave it them (the start note
 *  doesn't say how hot: told there, they'd act the burn out early). */
async function spicy(body, ctx, def, why) {
    await body.wait(900, ctx);
    body.emotion("surprised");
    await body.wait(500, ctx);
    toySfx.sizzle();
    body.fx("fire", body.head());
    body.fx("steam", body.head());
    body.note(`You bit into ${def.note} and it's MUCH hotter than you expected.`, { surprise: true, interrupt: HANDED.has(why) });
    body.say(_t("HOT HOT HOT"), 2200);
    body.emotion("angry");
    await body.play(CLIP.spicy, ctx, { loop: true });
    const until = performance.now() + 3200;
    while (performance.now() < until) {
        await body.wait(700, ctx);
        body.fx("steam", body.head());
        body.fx("sweat", body.head());
    }
    body.rest();
    body.emotion("relaxed");
    body.say(_t("…water"), 1600);
    await body.wait(1200, ctx);
}

// ── balls ─────────────────────────────────────────────────────────────────

/** Underhand back to the user, gently. */
async function tossBack(body, toy, ctx) {
    if (toy.heldBy !== "companion") return;
    const to = body.userPoint();
    body.face(to);
    const clip = body.play(CLIP.toss, ctx, { maxMs: 1800 });
    await at(body, RELEASE_MS.toss, ctx);
    const from = toy.p;
    const v = solveLaunch(from, to, 50 * Math.PI / 180, toy.k ?? 0, { vmax: 9 })
        || { ...scale(sub(to, from), 0.8), y: 3 };
    body.letGo(toy, v);
    await clip.catch(() => {});
}

/** Basketball: out comes the hoop; walk to the line, shoot, celebrate. */
async function shootHoops(body, toy, ctx, why) {
    const shots = why === "idle" ? 2 : 3;
    goNote(body, toy, why, 0, "There's a mini basketball hoop; you're about to take a shot at it.", null, GAME_S.hoops * 1000);
    if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx))) return;
    const hoop = body.stage.ensureHoop(body.pos());
    for (let s = 0; s < shots; s++) {
        if (s) goNote(body, toy, why, s, null, "You're about to take another shot at the hoop.", GAME_S.hoops * 1000);
        if (toy.heldBy !== "companion") {
            if (!(await fetchToy(body, toy, ctx))) return;
        }
        const rim = hoop.rim;
        const spot = body.stage.shootingSpot(hoop, SHOT_DISTANCE, body.pos());
        await body.goTo(spot, ctx, { gap: 0.05 });
        if (toy.heldBy !== "companion") return;
        body.face(rim);
        body.lookAt(rim, 2500);
        await body.wait(350, ctx);
        const clip = body.play(CLIP.shoot, ctx, { maxMs: 2400 });
        await at(body, RELEASE_MS.shoot, ctx);
        if (toy.heldBy !== "companion") return;
        // Aim at the middle of the ring, a touch past the front edge.
        const target = { x: rim.x, y: rim.y + 0.02, z: rim.z };
        const angle = SHOT_ANGLE + rand(-1, 1) * SHOT_ANGLE_ERR;
        const v = solveLaunch(toy.p, target, angle, toy.k ?? 0);
        if (!v) { body.letGo(toy, v3(0, 2, 0)); await clip.catch(() => {}); return; }
        const k = 1 + rand(-1, 1) * SHOT_SPEED_ERR;
        toySfx.swish();
        body.stage.launched(toy);
        body.letGo(toy, scale(v, k));
        await clip.catch(() => {});
        const result = await body.stage.watchShot(toy, hoop, ctx, body);
        // How it went is news they couldn't have had when it started: a
        // reaction, right then.
        body.note(result === "score" ? "That shot went in." : "That shot missed.", { surprise: true });
        if (result === "score") {
            body.emotion("happy");
            body.say(pick([_t("swish!"), _t("nothing but net!"), _t("YES!")]), 1500);
            await body.play(pick([CLIP.jump, CLIP.clap, CLIP.peace]), ctx, { maxMs: 2600 });
        } else {
            body.say(pick([_t("aww"), _t("so close!"), _t("one more")]), 1300);
            await body.play(CLIP.thinking, ctx, { maxMs: 1600 });
        }
    }
    body.rest();
}

/** Football: out comes the goal; the ball carried to the penalty spot and
 *  set down, a step back, and a penalty at the goal. */
async function takePenalties(body, toy, ctx, why) {
    const goal = body.stage.ensureGoal(body.pos());
    const kicks = why === "idle" ? 2 : 3;
    for (let k = 0; k < kicks; k++) {
        goNote(body, toy, why, k, "There's a little football goal; you're about to take a penalty.",
            "You're about to take another penalty.", GAME_S.penalties * 1000);
        if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx))) return;
        const spot = body.stage.penaltySpot(goal);
        await body.goTo(spot, ctx, { gap: 0.05 });
        if (toy.heldBy !== "companion") return;
        // Set it down on the spot, in front of them, facing the goal.
        const aim = goal.base;
        body.face(aim);
        await body.wait(450, ctx);
        const down = body.play(CLIP.pickup, ctx, { maxMs: 1400 });
        await at(body, GRAB_MS.pickup, ctx);
        body.letGo(toy, v3());
        await down.catch(() => {});
        body.rest();
        const t0 = performance.now();
        while (!toy.resting && toy.alive && !toy.heldBy && performance.now() - t0 < 2500) await body.wait(80, ctx);
        if (!toy.alive || toy.heldBy) return;
        // A step back from it, a look at the goal, and in to kick (the
        // left foot: the ball a little left of them).
        const dir = norm({ x: aim.x - toy.p.x, y: 0, z: aim.z - toy.p.z });
        const left = { x: dir.z, y: 0, z: -dir.x };
        await body.goTo(sub(toy.p, scale(dir, 1.0)), ctx, { gap: 0.02 });
        body.face(aim);
        body.lookAt(add(aim, v3(0, 1, 0)), 1500);
        await body.wait(700, ctx);
        await body.goTo(sub(sub(toy.p, scale(dir, 0.32)), scale(left, 0.08)), ctx, { gap: 0.02, run: true });
        body.face(aim);
        const clip = body.play(CLIP.kick, ctx, { maxMs: 2600 });
        await at(body, RELEASE_MS.kick, ctx);
        if (!toy.alive || toy.heldBy || flatDist(toy.p, body.pos()) > 0.9) { await clip.catch(() => {}); continue; }
        const u = rand(-0.8, 0.8), vUp = rand(0.15, 0.85);
        const target = add(body.stage.goalTarget(goal, u, vUp),
            v3(rand(-1, 1) * KICK_AIM_ERR, rand(-1, 1) * KICK_AIM_ERR * 0.6, body.stage.dims === 2 ? 0 : rand(-1, 1) * KICK_AIM_ERR));
        const v = solveLaunch(toy.p, target, KICK_ANGLE, toy.k ?? 0, { vmax: KICK_MAX });
        body.stage.launched(toy);
        if (v) {
            toy.v = v;
            toy.releasedAt = performance.now();
            toy.wake();
            toySfx.bounce(7, "football");
            body.stage.noteHit(toy, "companion");
        }
        await clip.catch(() => {});
        const result = await body.stage.watchKick(toy, goal, ctx, body);
        body.note(result === "score" ? "That penalty went in." : toy._woodwork ? "That penalty hit the woodwork." : "That penalty missed.",
            { surprise: true });
        if (result === "score") {
            body.emotion("happy");
            body.fx("comic", _t("GOAL!"), add(goal.base, v3(0, 2.4, 0)));
            body.say(pick([_t("GOAL!!"), _t("top corner!"), _t("yes yes yes!")]), 1500);
            await body.play(pick([CLIP.jump, CLIP.peace, CLIP.clap]), ctx, { maxMs: 2600 });
        } else {
            body.say(toy._woodwork ? pick([_t("argh, the post!"), _t("off the bar!")]) : pick([_t("so close!"), _t("one more"), _t("argh!")]), 1300);
            await body.play(CLIP.thinking, ctx, { maxMs: 1600 });
        }
    }
    body.rest();
}

/** Rugby ball: out come the posts; the ball carried to the mark, stood on
 *  a tee, the walk back, the stare, the run-up and a place kick at the
 *  posts. */
async function kickConversion(body, toy, ctx, why) {
    const st = body.stage;
    const posts = st.ensurePosts(body.pos());
    const kicks = why === "idle" ? 1 : 2;
    try {
        for (let k = 0; k < kicks; k++) {
            goNote(body, toy, why, k, "There are rugby posts; you're about to take a place kick at them.",
                "You're about to take another place kick.", GAME_S.conversion * 1000);
            if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx))) return;
            const spot = st.kickSpot(posts);
            await body.goTo(spot, ctx, { gap: 0.05 });
            if (toy.heldBy !== "companion") return;
            const aim = posts.base;
            const dir = norm({ x: aim.x - spot.x, y: 0, z: aim.z - spot.z });
            const right = { x: -dir.z, y: 0, z: dir.x };
            body.face(aim);
            await body.wait(400, ctx);
            // The tee down in front of them, and the ball stood on it.
            const down = body.play(CLIP.pickup, ctx, { maxMs: 1400 });
            await at(body, GRAB_MS.pickup, ctx);
            if (toy.heldBy !== "companion") { await down.catch(() => {}); return; }
            const tee = st.placeTee(add(body.pos(), scale(dir, 0.35)));
            body.letGo(toy, v3());
            st.standOnTee(toy, tee);
            await down.catch(() => {});
            body.rest();
            // Back and out to the side, a look at the posts, and in.
            const ball = { ...toy.p };
            const mark = add(sub(ball, scale(dir, RUN_UP_BACK)), scale(right, st.dims === 2 ? 0 : RUN_UP_SIDE));
            await body.goTo(mark, ctx, { gap: 0.02 });
            if (!toy.alive || toy.heldBy || !toy.upright) return;
            body.face(aim);
            body.lookAt(add(aim, v3(0, POSTS.bar + 0.5, 0)), 1800);
            await body.wait(1100, ctx);
            body.face(ball);
            await body.goTo(sub(sub(ball, scale(dir, 0.3)), scale(right, -0.08)), ctx, { gap: 0.02, run: true });
            body.face(aim);
            const clip = body.play(CLIP.kick, ctx, { maxMs: 2600 });
            await at(body, RELEASE_MS.kick, ctx);
            if (!toy.alive || toy.heldBy || flatDist(toy.p, body.pos()) > 0.9) { await clip.catch(() => {}); continue; }
            const target = st.postsTarget(posts, rand(-0.5, 0.5), rand(0.3, 1.2));
            const off = add(scale(posts.side, st.dims === 2 ? 0 : rand(-1, 1) * PLACE_ERR_ACROSS), v3(0, rand(-1, 1) * PLACE_ERR_UP, 0));
            const to = add(target, off);
            const sight = Math.atan2(to.y - toy.p.y, flatDist(to, toy.p));
            const v = solveLaunch(toy.p, to, Math.max(PLACE_ANGLE, sight + PLACE_ABOVE_SIGHT), toy.k ?? 0, { vmax: PLACE_MAX });
            st.launched(toy);
            toy.hovering = false;
            toy.upright = false;
            st.removeTee();
            if (v) {
                toy.v = v;
                // End over end: about the axis across the kick.
                toy.omega = st.dims === 2 ? v3(0, 0, -Math.sign(v.x || 1) * PLACE_TUMBLE) : scale(right, -PLACE_TUMBLE);
                toy.releasedAt = performance.now();
                toy.wake();
                toySfx.bounce(7, "rugby");
                st.noteHit(toy, "companion");
            }
            await clip.catch(() => {});
            body.lookAt(add(aim, v3(0, POSTS.bar, 0)), 2500);
            const result = await st.watchPosts(toy, posts, ctx, body);
            if (result !== "gone") {
                body.note({
                    score: "That kick went over the bar, between the posts.", wide: "That kick went wide.",
                    post: "That kick hit a post.", short: "That kick fell short, under the bar.",
                }[result] || "That kick missed.", { surprise: true });
            }
            if (result === "score") {
                body.emotion("happy");
                body.fx("comic", _t("OVER!"), add(aim, v3(0, POSTS.height + 0.4, 0)));
                body.say(pick([_t("right between the posts!"), _t("conversion!"), _t("yes!!")]), 1500);
                await body.play(pick([CLIP.jump, CLIP.peace, CLIP.clap]), ctx, { maxMs: 2600 });
            } else if (result !== "gone") {
                body.say({
                    wide: pick([_t("wide…"), _t("pulled it!")]),
                    post: pick([_t("off the post!"), _t("ugh, the woodwork")]),
                    short: pick([_t("under the bar…"), _t("not enough on it")]),
                }[result], 1400);
                await body.play(CLIP.thinking, ctx, { maxMs: 1600 });
            }
        }
    } finally {
        if (!st.disposed) st.removeTee();
    }
    body.rest();
}

/** Something coming at them: caught (in the mouth, a grape), then
 *  whatever that thing is for. */
async function catchBall(body, toy, ctx) {
    if (toy.def.food?.style === "catch") {
        const taste = tasteFor(body, toy);
        startNote(body, "thrown", `The user just tossed you ${toy.def.note} and you're trying to catch it in your mouth.`);
        body.faceUser();
        if (await mouthCatch(body, toy, ctx)) return caught(body, toy.def, ctx, taste, "thrown");
        return missed(body, toy, ctx);
    }
    if (!CATCHABLE.has(toy.def.kind)) return;
    body.face(toy.p);
    const clip = body.play(sized(toy, "catch"), ctx, { maxMs: 1600 });
    const t0 = performance.now();
    while (performance.now() - t0 < 900) {
        await body.wait(16, ctx);
        if (!toy.alive || toy.heldBy) break;
        // In reach of the hands, or it just bumped into them.
        const bumped = toy._hitAt && performance.now() - toy._hitAt < 300;
        if (bumped || dist(toy.p, body.chest()) < body.reach * 0.75) {
            body.hold(toy, "both");
            toySfx.bounce(3, toy.def.id);
            break;
        }
    }
    await clip.catch(() => {});
    if (toy.heldBy !== "companion") {
        // Missed: they'll fetch it once it's down. This is them going for
        // the thrown thing, so its landing doesn't send them for it again.
        toy._fresh = false;
        if (toy.alive && !toy.heldBy) return playWith(body, toy, "dropped", ctx);
        return;
    }
    await body.play(sized(toy, "hold"), ctx, { loop: true });
    body.say(pick([_t("got it!"), _t("nice throw!")]), 1300);
    await body.wait(700, ctx);
    if (toy.def.hoop) await shootHoops(body, toy, ctx, "caught");
    else if (toy.def.goal) await takePenalties(body, toy, ctx, "caught");
    else if (toy.def.posts) await kickConversion(body, toy, ctx, "caught");
    else if (toy.def.kind === "ball") await tossBack(body, toy, ctx);
    else await playWith(body, toy, "caught", ctx);
}

const CATCHABLE = new Set(["food", "ball", "plush", "bottle", "wand"]);

/** Food held out to their mouth: taken, and eaten from the hand. */
async function takeOffered(body, toy, ctx) {
    body.lookAt(toy.p, 900);
    body.emotion("happy");
    body.take(toy, EAT_GRIP[toy.def.food?.style] || "both");
    await body.play(sized(toy, "hold"), ctx, { loop: true });
    await eat(body, toy, ctx, "offer");
}

/** The user's basket. */
async function cheer(body, ctx) {
    body.faceUser();
    body.emotion("happy");
    body.say(pick([_t("nice shot!"), _t("woah!"), _t("you're good!")]), 1500);
    await body.play(CLIP.clap, ctx, { maxMs: 2600 });
}

// ── play things ───────────────────────────────────────────────────────────

async function hugPlush(body, toy, ctx, why) {
    if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx))) return;
    startNote(body, why, `${cameBy(toy, why)} You're about to give it a big hug.`, 7000);
    body.faceUser();
    await body.play(CLIP.hug, ctx, { loop: true });
    toySfx.squeak();
    body.emotion("happy");
    body.fx("hearts", body.head());
    body.say(pick([_t("Gerald!!"), _t("so squishy"), _t("chomp chomp")]), 1600);
    await body.wait(1500, ctx);
    toySfx.squeak();
    await body.wait(rand(1800, 3000), ctx);
    await body.play(CLIP.hold, ctx, { loop: true });
    await tossBack(body, toy, ctx);
}

async function blowBubbles(body, toy, ctx, why) {
    if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx, "right"))) return;
    // Caught in both hands: into the right fist to blow.
    toy.grip = "right";
    startNote(body, why, `${cameBy(toy, why)} You're about to blow bubbles with it, then pop a few.`, 20000);
    body.faceUser();
    await body.play(CLIP.blow, ctx, { loop: true });
    const breaths = Math.round(rand(...BREATHS));
    for (let breath = 0; breath < breaths; breath++) {
        // Each breath a little to one side or the other, some soft and
        // some hard.
        const dir = body.facing(), turn = rand(-0.5, 0.5);
        const aim = norm(v3(dir.x * Math.cos(turn) - dir.z * Math.sin(turn), 0, dir.x * Math.sin(turn) + dir.z * Math.cos(turn)));
        const n = Math.round(rand(...BUBBLES_PER_BREATH)), puff = rand(0.5, 1.3);
        await body.wait(rand(500, 900), ctx);
        for (let i = 0; i < n; i++) {
            body.stage.blowBubble(toy, aim, puff * rand(0.7, 1.15));
            await body.wait(rand(60, 140), ctx);
        }
        await body.wait(rand(500, 900), ctx);
    }
    body.rest();
    body.letGo(toy, v3(0, 0, 0));
    // Then a few clapped: over to one, and the hands round it.
    const pops = Math.round(rand(...POPS));
    for (let n = 0; n < pops; n++) {
        const b = body.stage.nearestBubble(body.head(), 2.5);
        if (!b) break;
        body.lookAt(b.p, 1500);
        if (flatDist(b.p, body.pos()) > body.reach * 0.7) await body.goTo(b.p, ctx, { gap: body.reach * 0.5, run: true });
        if (!b.alive) continue;
        body.face(b.p);
        body.lookAt(b.p, 1200);
        const clip = body.play(CLIP.clapPop, ctx, { maxMs: 1600 });
        await at(body, CLAP_MS, ctx);
        if (b.alive && dist(b.p, body.chest()) < body.reach * 1.4) body.stage.popBubble(b, "companion");
        await clip.catch(() => {});
    }
    body.emotion("happy");
}

// ── gadgets ───────────────────────────────────────────────────────────────

/** In front of the fan: the breeze, and the voice into it. */
async function enjoyFan(body, fan, ctx, why) {
    startNote(body, why, why === "idle" ? "You've gone over to stand in the fan's breeze on your own."
        : `${cameBy(fan, why)} You're going to stand in its breeze for a bit.`, 8000);
    const spot = body.stage.inFrontOf(fan, 1.1);
    await body.goTo(spot, ctx, { gap: 0.05 });
    if (!fan.on) return;
    body.face(fan.p);
    await body.play(CLIP.breeze, ctx, { loop: true });
    body.emotion("relaxed");
    body.fx("wobble", pick([_t("aaaaaaaa~"), _t("we come in peace~"), _t("ahhhh")]), body.head());
    const until = performance.now() + rand(5000, 8000);
    while (performance.now() < until && fan.on) await body.wait(300, ctx);
    body.rest();
    body.emotion("happy");
}

async function blowDry(body, dryer, ctx) {
    // As long as the user keeps it there: no time to give.
    body.note("The user is blow-drying your hair with a hair dryer.", { respond: true, interrupt: true });
    body.lookAt(dryer.p, 1200);
    body.emotion("relaxed");
    await body.play(CLIP.dryHair, ctx, { loop: true });
    const t0 = performance.now();
    while (dryer.on && dryer.blowingAt(body.head()) && performance.now() - t0 < 12000) await body.wait(200, ctx);
    body.rest();
    if (performance.now() - t0 > 4000) body.say(pick([_t("so fluffy now"), _t("ahh, warm"), _t("thank you~")]), 1600);
}

/** A lamp switched on near them: a look, and how it feels. */
async function admireLamp(body, lamp, ctx) {
    const glow = add(lamp.p, v3(...lamp.def.lamp.at));
    body.lookAt(glow, 1800);
    body.emotion(lamp.def.id === "neon" ? "happy" : "relaxed");
    const lines = {
        lava: [_t("so mesmerising…"), _t("look at it go")],
        neon: [_t("that's us!"), _t("ooh, neon!")],
        candles: [_t("candlelight~"), _t("so cosy…")],
        moon: [_t("a little moon!"), _t("so pretty")],
        jar: [_t("fairy lights!"), _t("like fireflies")],
    }[lamp.def.id] || [_t("cosy~"), _t("ooh, nice light"), _t("so warm")];
    body.say(pick(lines), 1600);
    await body.wait(1800, ctx);
    const shade = lamp.def.shades?.[lamp.shade || 0]?.name;
    body.note(`The user switched on ${lamp.def.note}${shade ? ` (${shade.toLowerCase()})` : ""} near you.`, { respond: false });
}

/** In the room, the shot widened (never narrowed) to take in `toy`, from
 *  the floor to `top` metres up, and them where they stand. */
function frameWith(body, toy, top) {
    const p = body.pos();
    body.stage.frameTo?.([{ ...toy.p, y: toy.p.y - toy.radius }, add(toy.p, v3(0, top - toy.radius, 0)), p, add(p, v3(0, body.height, 0))]);
}

/** A campfire lit: everything else has gone dark, and they go over to warm
 *  their hands at it. */
async function byTheFire(body, fire, ctx, why) {
    startNote(body, why, why === "idle" ? "You've gone back to the campfire to warm your hands."
        : `${cameBy(fire, why)} Everything else has gone dark. You're going over to warm your hands at it.`, 16000);
    // Stood a step back from its stones (by eye).
    const ok = await body.goTo(fire.p, ctx, { gap: fire.radius + 0.45 });
    if (!fire.alive || !fire.on || (!ok && flatDist(fire.p, body.pos()) > 2.5)) return;
    frameWith(body, fire, 0.9);
    body.face(fire.p);
    body.lookAt(add(fire.p, v3(0, 0.1, 0)), 2000);
    body.emotion("relaxed");
    await body.play(CLIP.warmHands, ctx, { loop: true });
    body.say(pick([_t("so warm…"), _t("ahh, toasty"), _t("I love a campfire")]), 1800);
    const until = performance.now() + rand(11000, 15000);
    while (performance.now() < until && fire.on && fire.alive) await body.wait(300, ctx);
    body.rest();
}

/** The galaxy projector on: the room dark and full of stars. They gaze up
 *  at them, and see a shooting star if one goes. */
async function stargaze(body, proj, ctx, why) {
    const st = body.stage;
    startNote(body, why, why === "idle" ? "You've stopped to gaze up at the projected stars again."
        : `${cameBy(proj, why)} The room has gone dark, and stars and nebula clouds are turning slowly across it. You're gazing up at them.`, 16000);
    body.emotion("surprised");
    body.say(pick([_t("woah…"), _t("so many stars…"), _t("it's beautiful")]), 1800);
    // Up and ahead of them.
    const sky = () => add(body.head(), add(scale(body.facing(), 1.5), v3(0, 2, 0)));
    body.lookAt(sky(), 2500);
    await body.play(CLIP.stargaze, ctx, { loop: true });
    await body.wait(1200, ctx);
    body.emotion("relaxed");
    const until = performance.now() + rand(12000, 16000);
    const seen = st.shootingAt || 0;
    let told = false;
    while (performance.now() < until && proj.on && proj.alive) {
        await body.wait(300, ctx);
        if (!told && (st.shootingAt || 0) > seen) {
            told = true;
            body.emotion("surprised");
            body.say(pick([_t("a shooting star!"), _t("quick, make a wish!")]), 1800);
            body.note("A shooting star just streaked across the projected sky.", { surprise: true });
        }
    }
    body.rest();
}

/** The aquarium: over to watch the fish, feeding them the first time. */
async function visitTank(body, tank, ctx, why) {
    const feed = !tank.fed;
    const doing = feed ? "You're going over to feed the fish and watch them." : "You're going over to watch the fish.";
    startNote(body, why, why === "idle" ? `You've wandered over to the aquarium. ${doing}` : `${cameBy(tank, why)} ${doing}`, feed ? 16000 : 12000);
    const ok = await body.goTo(tank.p, ctx, { gap: tank.radius + 0.35 });
    if (!tank.alive || (!ok && flatDist(tank.p, body.pos()) > 2.5)) return;
    frameWith(body, tank, 1.1);
    body.face(tank.p);
    // The middle of the tank (catalog: its stand 72 cm, the tank 30 cm).
    const inside = add(tank.p, v3(0, 0.87 - tank.radius, 0));
    body.lookAt(inside, 2000);
    body.emotion("happy");
    if (feed) {
        const clip = body.play(CLIP.sprinkle, ctx, { maxMs: 2600 });
        await body.wait(SPRINKLE_MS, ctx);
        tank.fed = true;
        body.stage.feedFish?.(tank);
        toySfx.sprinkle();
        await clip.catch(() => {});
        body.say(pick([_t("dinner time!"), _t("here you go, fishies")]), 1600);
    }
    await body.play(CLIP.peerIn, ctx, { loop: true });
    if (!feed) body.say(pick([_t("look at them go"), _t("so peaceful…"), _t("hi, little fish!")]), 1600);
    const until = performance.now() + rand(8000, 11000);
    while (performance.now() < until && tank.alive) {
        await body.wait(1500, ctx);
        body.lookAt(inside, 1600);
    }
    body.rest();
}

async function partyTime(body, ctx, why) {
    const st = body.stage;
    body.emotion("happy");
    if (st.fogOn() && !st.discoOn()) {
        await body.play(CLIP.waft, ctx, { loop: true });
        body.say(pick([_t("*cough*"), _t("so foggy…")]), 1300);
        await body.wait(2200, ctx);
        body.rest();
        return;
    }
    if (!st.discoOn()) return;
    const lights = "a disco ball" + (st.fogOn() ? " and a smoke machine" : "");
    startNote(body, why, why === "idle" ? `You've started dancing to ${lights} on your own.`
        : `The user just put on ${lights}. You're about to dance.`, 12000);
    body.say(pick([_t("party!!"), _t("let's dance!")]), 1400);
    await body.play(pick(CLIP.dances), ctx, { loop: true });
    const until = performance.now() + rand(9000, 14000);
    while (performance.now() < until && st.discoOn()) await body.wait(300, ctx);
    body.rest();
}

// ── the crew's ────────────────────────────────────────────────────────────

async function openChest(body, chest, ctx) {
    if (chest.opened) return collectCoins(body, ctx);
    const ok = await body.goTo(chest.p, ctx, { gap: body.reach * 0.75 });
    if (!ok || !chest.alive) return;
    body.face(chest.p);
    const clip = body.play(CLIP.open, ctx, { maxMs: 2400 });
    await body.wait(700, ctx);
    body.stage.openChest(chest);
    toySfx.chime();
    body.emotion("surprised");
    await clip.catch(() => {});
    body.say(pick([_t("treasure!!"), _t("doubloons!"), _t("we're rich!")]), 1600);
    body.emotion("happy");
    await body.play(CLIP.jump, ctx, { maxMs: 2000 });
    body.note("You opened a little treasure chest the user gave you and gold doubloons spilled out.", { respond: true });
    await collectCoins(body, ctx);
}

async function collectCoins(body, ctx) {
    // Let the spill settle first (a couple of seconds at most).
    const t0 = performance.now();
    while (body.stage.count((t) => t.def.kind === "coin" && !t.resting) && performance.now() - t0 < 2500) await body.wait(100, ctx);
    let got = 0;
    for (let i = 0; i < 4; i++) {
        const coin = body.stage.nearest((t) => t.def.kind === "coin" && t.resting && !t.heldBy, body.pos(), 3);
        if (!coin) break;
        if (!(await body.goTo(coin.p, ctx, { gap: body.reach * 0.5 }))) break;
        if (!coin.alive || coin.heldBy) continue;
        const clip = body.play(CLIP.pickupSmall, ctx, { maxMs: 2200 });
        await at(body, GRAB_MS.pickup, ctx);
        if (!coin.alive || coin.heldBy) { await clip.catch(() => {}); continue; }
        coin.remove();
        toySfx.bounce(4, "coin");
        got++;
        body.fx("comic", `+${got}`, body.head());
        await clip.catch(() => {});
    }
    if (got > 1) {
        body.say(_t("%s doubloons!", got), 1500);
        await body.play(CLIP.peace, ctx, { maxMs: 2400 });
    }
}

async function readBottle(body, toy, ctx) {
    if (toy.heldBy !== "companion" && !(await fetchToy(body, toy, ctx))) return;
    body.faceUser();
    toySfx.cork();
    body.fx("comic", _t("POP"), body.hand("right"));
    await body.wait(500, ctx);
    toy.remove();
    await body.play(CLIP.read, ctx, { loop: true });
    body.fx("scroll", body.hand("right"));
    body.emotion("surprised");
    await body.wait(2600, ctx);
    body.rest();
    if (body.inCall) {
        body.note("You found a message in a bottle and opened it. Read out what the note says - make it up, in character, a line or two.", { respond: true });
        return;
    }
    if (body.stage.followUp?.("treasure_map")) {
        body.say(_t("it's a map!"), 1600);
        return;
    }
    body.say(pick([_t("\"X marks the spot…\""), _t("\"help, I'm stuck in a bottle factory\""), _t("\"ahoy from the Rexmaw!\"")]), 2600);
    await body.wait(1800, ctx);
}

// ── hit by a toy ──────────────────────────────────────────────────────────

async function bonked(body, toy, ctx, part) {
    const soft = toy.def.kind === "plush" || toy.def.kind === "food";
    body.emotion("surprised");
    if (part === "head" && !soft) {
        body.fx("stars", body.head());
        body.say(pick([_t("ow!"), _t("hey!!")]), 1300);
        await body.play(CLIP.rub, ctx, { maxMs: 2200 });
    } else {
        body.say(pick([_t("hey!"), _t("eep!"), _t("heh")]), 1100);
        await body.play(CLIP.surprised, ctx, { maxMs: 1500 });
    }
    // Throw it right back (a little revenge), when it's something to throw.
    if (["ball", "plush"].includes(toy.def.kind) && toy.alive && !toy.heldBy) {
        if (await fetchToy(body, toy, ctx)) {
            if (toy.def.hoop) return shootHoops(body, toy, ctx, "hit");
            if (toy.def.goal) return takePenalties(body, toy, ctx, "hit");
            if (toy.def.posts) return kickConversion(body, toy, ctx, "hit");
            await tossBack(body, toy, ctx);
        }
    }
}

// ── what to do with what ──────────────────────────────────────────────────

/** Run the routine for `toy`, for reason `why`: "dropped" (the user just put
 *  it in), "thrown" (coming at them), "caught" (in their hands now), "hit"
 *  (it hit them; `part` head/body), "offer" (held out to their mouth),
 *  "on" (a gadget switched on), "idle" (they spotted it lying about),
 *  "cheer" (the user scored). */
export async function playWith(body, toy, why, ctx, part = null) {
    if (why === "cheer") return cheer(body, ctx);
    if (!toy?.alive) return undefined;
    const kind = toy.def.kind;
    if (why === "hit") return bonked(body, toy, ctx, part);
    if (why === "offer") return takeOffered(body, toy, ctx);
    if (why === "thrown") return catchBall(body, toy, ctx);
    switch (kind) {
        case "food": return eat(body, toy, ctx, why);
        case "ball":
            if (toy.def.posts) return kickConversion(body, toy, ctx, why);
            return toy.def.goal ? takePenalties(body, toy, ctx, why) : shootHoops(body, toy, ctx, why);
        case "plush": return hugPlush(body, toy, ctx, why);
        case "wand": return blowBubbles(body, toy, ctx, why);
        case "fan": return toy.on ? enjoyFan(body, toy, ctx, why) : undefined;
        case "dryer": return toy.on ? blowDry(body, toy, ctx) : undefined;
        case "fogger":
        case "disco": return partyTime(body, ctx, why);
        case "lamp":
            if (toy.def.lamp.fire) return toy.on ? byTheFire(body, toy, ctx, why) : undefined;
            if (toy.def.lamp.stars) return toy.on ? stargaze(body, toy, ctx, why) : undefined;
            if (toy.def.id === "aquarium") return visitTank(body, toy, ctx, why);
            return toy.on && why === "on" ? admireLamp(body, toy, ctx) : undefined;
        case "chest": return openChest(body, toy, ctx);
        case "bottle": return readBottle(body, toy, ctx);
        case "coin": return collectCoins(body, ctx);
        default: return undefined;
    }
}

/** How much a toy lying about calls to them when they're idle (0: not at
 *  all), so the director can weigh it against its other actions. In the
 *  room, only what's near them (IDLE_REACH): they don't wander off across
 *  it on their own. */
export function idleAppeal(toy, stage, from = null) {
    const w = appeal(toy, stage, from);
    return w && stage.wired?.() ? w * 2 : w;
}

function appeal(toy, stage, from) {
    if (!toy.alive || toy.heldBy) return 0;
    // "Keep playing with toys" off in the tray: only what the user does.
    if (stage.box && !stage.box.state.idle) return 0;
    // Not while anyone's talking, nor straight after.
    if (stage.box && stage.box.quietMs() < QUIET_MS) return 0;
    const k = toy.def.kind;
    if (from && stage.dims === 3 && flatDist(toy.p, from) > IDLE_REACH) return 0;
    if (k === "food") return toy.resting && !toy.refused ? 30 : 0;
    if (k === "ball" || k === "wand") return toy.resting ? 12 : 0;
    // A hug for the plush now and then, not every few minutes.
    if (k === "plush") return toy.resting ? 4 : 0;
    if (k === "chest") return toy.opened ? (stage.count((t) => t.def.kind === "coin") ? 8 : 0) : 20;
    if (k === "bottle") return toy.resting ? 18 : 0;
    if (k === "fan") return toy.on ? 10 : 0;
    if (k === "disco" || k === "fogger") return toy.on ? 14 : 0;
    // A fire to sit by, a sky to look up at; fish to feed, then to watch.
    if (k === "lamp" && toy.def.lamp.fire) return toy.on ? 10 : 0;
    if (k === "lamp" && toy.def.lamp.stars) return toy.on ? 8 : 0;
    if (toy.def.id === "aquarium") return toy.resting ? (toy.fed ? 6 : 16) : 0;
    if (k === "coin") return 0;
    return 0;
}

export { GRAVITY, MAX_THROW, TOYS, HOOP, GOAL };
