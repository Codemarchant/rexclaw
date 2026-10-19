// Roam gags through the year (models/roam_director.js), the third batch:
// the weather (storms, hail, gales, fog), things to do in each season
// (snowmen, skating, ice creams, water fights, blossom), the holidays, and
// a boomerang. How often each comes is the season's (models/roam_seasons.js).
// Same shape as roam_gags.js: methods of the director, one table of actions.

import { _t } from "../lib/i18n";
import {
    ROAM, LIB, rand, pick, clamp, bonePage, headPage, centre, faces, floorSpot, besideIt, everyFrame, ground,
} from "./roam_gags";
import { season, easterTime, halloweenTime, christmasTime, newYearTime, toNewYearS } from "./roam_seasons";

// Thunder comes after the flash by the strike's distance over the speed of
// sound (343 m/s in air at 20 °C); the strikes land this far off (km, by
// eye: near enough to jump at).
const SOUND_MPS = 343;
const STRIKE_KM = [0.3, 1.5];
// The snowman's balls as shares of the standing body (by eye: the base
// about knee high, each ball above about three quarters of the one below,
// sitting a sixth into it).
const SNOW_BASE = 0.4;
const SNOW_STEP = 0.72;
const SNOW_SINK = 0.15;

/** The screen jolts (thunder): the overlay shoved `px` and back. */
function shake(d, px) {
    d.root.animate([{ transform: "translate(0,0)" }, { transform: `translate(${px * (Math.random() - 0.5)}px, ${px * 0.6}px)` },
        { transform: `translate(${-px * 0.4}px, ${-px * 0.3}px)` }, { transform: "translate(0,0)" }], { duration: 380 });
}

/** A cloud of their own over their head, following it, until the action
 *  ends. */
function ownCloud(d, opts) {
    const w = d.body * (opts.storm ? 1.1 : 0.9), lift = d.body * 0.55;
    const h = headPage(d);
    const cloud = d.fx.rainCloud(h.x, h.y - lift, w, opts);
    const stop = everyFrame(d, () => { const q = headPage(d); cloud.move(q.x, q.y - lift); });
    const end = () => { stop(); cloud.stop(); };
    d.onEnd(end);
    return { end, w, lift };
}

/** Somewhere a strike can land: a window's top edge, or the floor. */
function strikePoint(d) {
    const l = pick(d.world.ledges(d.body * 0.5));
    if (l && Math.random() < 0.6) return { x: rand(l.x0, l.x1), y: l.y };
    return { x: rand(d.world.area.width * 0.08, d.world.area.width * 0.92), y: d.world.floor().y };
}

// ── weather ──────────────────────────────────────────────────────────────

/** A thunderstorm: the screen darkens, a storm cloud of their own,
 *  lightning, and after it the thunder (BOOM, the screen shakes). They
 *  jump at the first, get the umbrella out, and hurry about under it,
 *  looking up at every flash, flinching at every boom. */
async function thunderstorm(ctx) {
    if (!ground(this)) return;
    const { height } = this.world.area;
    const dim = this.fx.dim(0.3);
    this.onEnd(() => dim.stop());
    const cloud = ownCloud(this, { storm: true });
    this._face(0);
    await this._play(LIB("LookAround"), ctx, { maxMs: 2200 });
    for (let i = 0; i < 4; i++) {
        const at = strikePoint(this);
        this.fx.lightning(at.x + rand(-120, 120), 0, at.x, at.y);
        this.r.lookAtPoint?.({ x: at.x, y: 0 }, 1800);
        await this._wait((rand(...STRIKE_KM) * 1000 / SOUND_MPS) * 1000, ctx);
        shake(this, 10);
        this.fx.comic(_t("BOOM!"), at.x, height * 0.2, { size: 64, color: "#e0e7ff" });
        const h = headPage(this);
        if (i === 0) {
            this.fx.say(_t("eek!"), h.x, h.y - this.body * 0.12, 1200);
            await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
            await this.prop("umbrella");
        } else {
            if (i === 2) this.fx.say(_t("is it over…?"), h.x, h.y - this.body * 0.12, 1500);
            await this._play(LIB("Surprised"), ctx, { maxMs: 800 });
        }
        // Somewhere else, quick, under the umbrella.
        const s = this.b.surf || this.world.floor();
        const pad = this.body * (s.id === "floor" ? 0.4 : 0.2);
        if (s.x1 - s.x0 > pad * 3) {
            let x = rand(s.x0 + pad, s.x1 - pad);
            if (Math.abs(x - this.b.x) < this.body * 0.6) x = this.b.x < (s.x0 + s.x1) / 2 ? s.x1 - pad : s.x0 + pad;
            await this._walkTo(x, ctx, { rate: 1.6, upper: ROAM("umbrella") });
        }
        this._face(0);
        await this._play(ROAM("umbrella"), ctx, { loop: true });
        await this._wait(rand(700, 1600), ctx);
    }
    cloud.end();
    dim.stop();
    await this._wait(800, ctx);
    this._rest();
    await this._play(LIB("Relax"), ctx);
}

/** Hail: stones bouncing off their head (ow!) and the floor, until the
 *  umbrella's up and they bounce off that instead. */
async function hailstorm(ctx) {
    if (!ground(this)) return;
    const cloud = ownCloud(this, { drops: false });
    let shielded = false;
    const pelt = setInterval(() => {
        const q = headPage(this);
        const x = q.x + rand(-cloud.w * 0.45, cloud.w * 0.45);
        const near = Math.abs(x - q.x);
        // Stopped by the umbrella's canopy, the head, or the ground.
        const stopY = shielded && near < this.body * 0.32 ? q.y - this.body * 0.3
            : near < this.body * 0.07 ? q.y - this.body * 0.07 : this.b.y;
        this.fx.hailstone(x, q.y - cloud.lift + cloud.w * 0.15, stopY);
    }, 90);
    this.onEnd(() => clearInterval(pelt));
    this._face(0);
    await this._wait(600, ctx);
    for (let i = 0; i < 3; i++) {
        const q = headPage(this);
        this.fx.hailstone(q.x + rand(-5, 5), q.y - cloud.lift, q.y - this.body * 0.07);
        await this._wait(240, ctx);
    }
    const h = headPage(this);
    this.fx.say(_t("ow ow ow!"), h.x, h.y - this.body * 0.12, 1300);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
    await this.prop("umbrella");
    await this._play(ROAM("umbrella"), ctx, { loop: true });
    shielded = true;
    await this._wait(rand(4000, 6000), ctx);
    clearInterval(pelt);
    cloud.end();
    await this._wait(900, ctx);
    this._rest();
}

/** A gale: gusts across the screen with leaves and scraps in them; they
 *  lean into it under the umbrella till a gust takes it, and run after it. */
async function galeDay(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const dir = Math.random() < 0.5 ? 1 : -1;   // the way it blows
    const wind = this.fx.wind(dir);
    this.onEnd(() => wind.stop());
    this._face(-dir);
    const umbrella = await this.prop("umbrella");
    await this._play(ROAM("umbrella"), ctx, { loop: true });
    // Leaning into the wind, from the feet.
    this.originFeet = true;
    await this._tween(700, (s) => { this.tilt = -dir * 9 * s; });
    await this._wait(rand(2500, 3500), ctx);
    wind.gust();
    await this._tween(260, (s) => { this.tilt = -dir * 9 + dir * 16 * s; });
    const hand = bonePage(this, "rightHand") || headPage(this);
    umbrella?.hide();
    this.fx.fling("☂️", hand, { x: dir > 0 ? width + 80 : -80, y: hand.y - rand(120, 260) }, { ms: 1900, spin: 3, size: this.body * 0.3 });
    const h = headPage(this);
    this.fx.say(_t("my umbrella!"), h.x, h.y - this.body * 0.12, 1600);
    await this._tween(300, (s) => { this.tilt = dir * 7 * (1 - s); });
    this.tilt = 0;
    this._rest();
    await this._walkTo(clamp(this.b.x + dir * this.body * 1.8, this.body * 0.4, width - this.body * 0.4), ctx, { rate: 1.7 });
    this._face(0);
    await this._play(LIB("Sad"), ctx, { maxMs: 2500 });
    wind.stop();
}

/** Fog rolls in; out comes a lantern, carried low at the side, and a
 *  careful walk about. */
async function foggyDay(ctx) {
    if (!this.onFloor) return;
    const { height } = this.world.area;
    const fog = this.fx.fog(height * 0.35);
    this.onEnd(() => fog.stop());
    this._face(0);
    await this._play(LIB("LookAround"), ctx, { maxMs: 2500 });
    const lantern = await this.prop("lantern");
    await this._play(ROAM("lantern_carry"), ctx, { loop: true });
    const glow = this.fx.glow(this.body * 0.7);
    const follow = everyFrame(this, () => {
        const p = lantern?.pointPx("light");
        if (p) glow.move(this.box.left + p.x, this.box.top + p.y);
    });
    this.onEnd(() => { follow(); glow.stop(); });
    await this._walkTo(floorSpot(this, this.body * 0.6), ctx, { rate: 0.6, upper: ROAM("lantern_carry") });
    this._face(0);
    await this._play(ROAM("lantern_carry"), ctx, { loop: true });
    await this._wait(rand(2000, 3000), ctx);
    const h = headPage(this);
    this.fx.say(_t("hello…?"), h.x, h.y - this.body * 0.12, 1800);
    await this._wait(rand(2500, 3500), ctx);
    fog.stop();
    await this._wait(1800, ctx);
    follow();
    glow.stop();
    this._rest();
}

// ── seasons ──────────────────────────────────────────────────────────────

/** Roll a snowball along the floor toward `to` (its centre's x there),
 *  growing from a fistful to `size` across, bent over it pushing. */
async function rollSnowball(d, man, to, size, dir, ctx) {
    const reach = d.body * 0.22;   // from the feet to the ball's back, side-on
    const run = d.body * 1.3;
    await d._walkTo(to - dir * (run + reach + size / 2), ctx);
    d._face(dir);
    const ball = man.ball(size * 0.2);
    const x0 = d.b.x;
    let sz = size * 0.2;
    const follow = everyFrame(d, () => {
        const k = clamp(Math.abs(d.b.x - x0) / run, 0, 1);
        sz = size * (0.2 + 0.8 * Math.sqrt(k));
        ball.setSize(sz);
        const cx = d.b.x + dir * (reach + sz / 2);
        // Rolled, not slid: it turns by the way it went over its girth.
        ball.moveTo(cx, d.b.y, (dir * (cx - x0) / (Math.PI * sz)) * 360);
    });
    try {
        await d._walkTo(to - dir * (reach + size / 2), ctx, { rate: 0.7, upper: ROAM("push") });
    } finally {
        follow();
    }
    ball.setSize(size);
    ball.moveTo(to, d.b.y);
    await d._play(ROAM("push"), ctx, { loop: true });
    await d._wait(700, ctx);
    return ball;
}

/** Lift `ball` overhead and set it down on the stack at height `y` (its
 *  bottom, page px) over x. */
async function liftSnowball(d, ball, x, y, size, dir, ctx) {
    d._face(dir);
    await d._play(ROAM("carry"), ctx, { loop: true });
    const hold = everyFrame(d, () => {
        const hands = d._bonesPx(["leftHand", "rightHand"]);
        if (hands) ball.moveTo(d.box.left + hands.x, d.box.top + hands.y + size * 0.45);
    });
    await d._wait(500, ctx);
    await d._walkTo(x - dir * d.body * 0.32, ctx, { rate: 0.6, upper: ROAM("carry") });
    hold();
    d._face(dir);
    await d._play(ROAM("carry"), ctx, { loop: true });
    const from = d._bonesPx(["leftHand", "rightHand"]);
    const fx = from ? d.box.left + from.x : x, fy = from ? d.box.top + from.y + size * 0.45 : y - d.body;
    await d._tween(450, (s) => ball.moveTo(fx + (x - fx) * s, fy + (y - fy) * s - Math.sin(s * Math.PI) * size * 0.3));
    ball.moveTo(x, y);
    ball.settle();
}

/** Snow on the ground: a snowman — the base rolled along the floor, the
 *  middle rolled and lifted onto it, the head patted round in the hands —
 *  then the twig arms, coal, a carrot, a scarf and a hat. It stays a
 *  while after, then melts. */
async function buildSnowman(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const snow = this.fx.snowfall();
    this.onEnd(() => snow.stop());
    const base = this.body * SNOW_BASE, mid = base * SNOW_STEP, head = mid * SNOW_STEP;
    const dir = this.b.x < width / 2 ? 1 : -1;
    // Room for the run-up behind it.
    const x = clamp(this.b.x + dir * this.body * 1.2, this.body * 2 + base, width - this.body * 2 - base);
    const floorY = this.b.y;
    const man = this.fx.snowman();
    this.onEnd(() => man.leave());
    await rollSnowball(this, man, x, base, dir, ctx);
    this._rest();
    // The middle: rolled up beside the base, then lifted on.
    const beside = x - dir * (base / 2 + mid / 2 + this.body * 0.05);
    const middle = await rollSnowball(this, man, beside, mid, dir, ctx);
    const midY = floorY - base * (1 - SNOW_SINK);
    await liftSnowball(this, middle, x, midY, mid, dir, ctx);
    this._rest();
    // The head: packed in the hands.
    await this._walkTo(x - dir * this.body * 0.45, ctx);
    this._face(dir);
    await this._play(ROAM("pat"), ctx, { loop: true });
    const top = man.ball(head * 0.3);
    const packing = everyFrame(this, () => {
        const hands = this._bonesPx(["leftHand", "rightHand"]);
        if (hands) top.moveTo(this.box.left + hands.x, this.box.top + hands.y + head * 0.4);
    });
    for (let i = 1; i <= 4; i++) {
        await this._wait(450, ctx);
        top.setSize(head * (0.3 + 0.7 * (i / 4)));
        this.fx.crumbs(top.x, top.y - head * 0.5, "#f8fafc", 4);
    }
    packing();
    const headY = midY - mid * (1 - SNOW_SINK);
    await liftSnowball(this, top, x, headY, head, dir, ctx);
    // Dressed: pat-pat, a piece at a time.
    const dress = man.dress(x, floorY, base, mid, head, SNOW_SINK);
    await this._play(ROAM("pat"), ctx, { loop: true });
    for (const part of ["arms", "buttons", "eyes", "nose", "smile", "scarf", "hat"]) {
        await this._wait(part === "hat" ? 600 : 420, ctx);
        dress.show(part);
    }
    this._rest();
    await this._walkTo(x - dir * this.body * 0.9, ctx);
    this._face(0);
    const h = headPage(this);
    this.fx.say(_t("ta-da!"), h.x, h.y - this.body * 0.12, 1600);
    await this._play(LIB("VRMA_03_peace_sign"), ctx, { maxMs: 2500 });
    await this._wait(1500, ctx);
    snow.stop();
}

/** Frost: an icy patch on the floor, skated on — gliding to and fro, a
 *  spin, and now and then a slip. */
async function iceSkate(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const half = Math.min(width * 0.3, this.body * 1.6);
    const cx = clamp(this.b.x, half + this.body * 0.4, width - half - this.body * 0.4);
    const ice = this.fx.ice(cx - half - this.body * 0.25, cx + half + this.body * 0.25, this.b.y);
    this.onEnd(() => ice.stop());
    await this._walkTo(cx, ctx);
    this.b.mode = "scripted";
    await this._play(ROAM("skate"), ctx, { loop: true });
    const T = 4000;
    const t0 = performance.now();
    let face = 0;
    while (performance.now() - t0 < T * 2) {
        await this._nextFrame();
        this._check(ctx);
        const ph = ((performance.now() - t0) / T) * Math.PI * 2;
        this.b.x = cx + half * Math.sin(ph);
        const v = Math.sign(Math.cos(ph)) || 1;
        if (v !== face) { face = v; this.r.roamFace(v * Math.PI / 2); }
    }
    this.b.x = cx;
    this.r.roamFace(0);
    this.b.mode = "ground";
    if (Math.random() < 0.3) {
        await this._play(ROAM("fall"), ctx, { maxMs: 700 });
        const h = headPage(this);
        this.fx.stars(h.x, h.y);
        this.fx.say(_t("oof!"), h.x, h.y - this.body * 0.12, 1300);
        await this._play(ROAM("land"), ctx);
    } else {
        await this._play(LIB("VRMA_05_spin"), ctx);
        await this._play(LIB("VRMA_06_model_pose"), ctx, { maxMs: 2500 });
    }
}

/** A sunny day: an ice cream, dripping as it melts — and now and then the
 *  whole thing ends up on the floor. */
async function iceCream(ctx) {
    if (!ground(this)) return;
    this._face(0);
    const cone = await this.prop("icecream");
    await this._play(ROAM("umbrella"), ctx, { loop: true });
    this.r.setEmotion?.("happy", { explicit: false });
    const drips = setInterval(() => {
        const p = cone?.pointPx("drip");
        if (p) this.fx.drip(this.box.left + p.x, this.box.top + p.y, this.b.y, "#fbcfe8");
    }, 850);
    this.onEnd(() => clearInterval(drips));
    await this._wait(rand(4500, 6500), ctx);
    clearInterval(drips);
    const hand = bonePage(this, "rightHand") || headPage(this);
    const h = headPage(this);
    cone?.hide();
    this._rest();
    if (Math.random() < 0.35) {
        await this.fx.fling("🍦", hand, { x: hand.x + rand(-20, 20), y: this.b.y - 8 }, { ms: 500, spin: 0.5, lift: 10, size: this.body * 0.14 });
        this.fx.splat(hand.x, this.b.y - 6, this.body * 0.18, "#f9a8d4");
        this.fx.say(_t("noooo…"), h.x, h.y - this.body * 0.12, 1800);
        await this._play(LIB("Sad"), ctx, { maxMs: 2500 });
    } else {
        this.fx.crumbs(hand.x, hand.y, "#d6a35c", 6);
        this.fx.say(_t("yum!"), h.x, h.y - this.body * 0.12, 1300);
        this.fx.hearts(h.x, h.y - this.body * 0.1);
        await this._wait(1500, ctx);
    }
}

/** A sunny day: a water blaster, and a face Jev found on the screen gets
 *  soaked. */
async function waterFight(ctx) {
    const f = pick(faces(this));
    if (!f || !this.onFloor) return;
    f.used = true;
    const face = centre(f.rect);
    await besideIt(this, face, this.body * 1.5, ctx);
    const gun = await this.prop("waterpistol");
    await this._play(ROAM("aim"), ctx, { loop: true });
    await this._wait(600, ctx);
    for (let i = 0; i < 2; i++) {
        const m = gun?.pointPx("muzzle");
        const from = m ? { x: this.box.left + m.x, y: this.box.top + m.y } : headPage(this);
        const to = { x: face.x + rand(-0.15, 0.15) * f.rect.width, y: face.y + rand(-0.1, 0.1) * f.rect.height };
        await this.fx.squirt(from, to, { ms: 1000 });
        this._check(ctx);
        this.fx.splash(to.x, to.y);
        this.fx.runs(to.x, to.y);
        this.fx.comic(_t("SPLOOSH!"), to.x, f.rect.y - 10, { size: 32, color: "#7dd3fc" });
        await this._wait(700, ctx);
    }
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
}

/** Spring: blossom drifting down over the screen, and a petal caught. */
async function blossom(ctx) {
    if (!ground(this)) return;
    const petals = this.fx.petals();
    this.onEnd(() => petals.stop());
    this._face(0);
    await this._play(LIB("LookAround"), ctx);
    await this._play(LIB("Clapping"), ctx, { maxMs: 1600 });
    await this._play(LIB("Clapping"), ctx, { maxMs: 1600 });
    const h = headPage(this);
    this.fx.say(_t("caught one!"), h.x, h.y - this.body * 0.12, 1600);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    await this._wait(rand(2500, 4000), ctx);
    petals.stop();
}

// ── holidays ─────────────────────────────────────────────────────────────

/** Easter: painted eggs hidden about the floor, found one by one. */
async function eggHunt(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const pad = this.body * 0.5;
    const xs = [0, 1, 2].map((i) => rand(pad + (i * (width - 2 * pad)) / 3, pad + ((i + 1) * (width - 2 * pad)) / 3))
        .sort((a, b) => Math.abs(a - this.b.x) - Math.abs(b - this.b.x));
    const eggs = xs.map((x) => this.fx.egg(x, this.b.y, this.body * 0.13));
    this.onEnd(() => eggs.forEach((e) => e.remove()));
    let h = headPage(this);
    this.fx.say(_t("eggs!"), h.x, h.y - this.body * 0.12, 1300);
    await this._play(LIB("Jump"), ctx);
    for (let i = 0; i < eggs.length; i++) {
        const e = eggs[i];
        const side = e.x > this.b.x ? -1 : 1;
        await this._walkTo(e.x + side * this.body * 0.28, ctx, { rate: 1.3 });
        this._face(e.x - this.b.x);
        await this._play(LIB("Squat"), ctx, { maxMs: 1100 });
        e.collect(bonePage(this, "rightHand") || headPage(this));
        h = headPage(this);
        this.fx.comic(`${i + 1}/${eggs.length}`, h.x, h.y - this.body * 0.2, { size: 26, color: "#fde68a" });
    }
    this._face(0);
    h = headPage(this);
    this.fx.say(_t("found them all!"), h.x, h.y - this.body * 0.12, 1800);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    await this._play(LIB("Clapping"), ctx);
}

/** Halloween: a bedsheet ghost drifting in from the side, BOO!, and the
 *  sheet whisked off — it was them all along. */
async function sheetGhost(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floor = this.world.floor();
    const pumpkins = [-1, 1].map((s) => this.fx.token("🎃", clamp(this.b.x + s * this.body * 1.1, 30, width - 30), floor.y, this.body * 0.16));
    this.onEnd(() => pumpkins.forEach((p) => p.remove()));
    const x = this.b.x;
    await this._vanish();
    const ghost = this.fx.ghost(this.body * 0.6, this.body * 0.95);
    this.onEnd(() => ghost.remove());
    const dir = x < width / 2 ? 1 : -1;
    const x0 = dir > 0 ? -this.body : width + this.body;
    const t0 = performance.now();
    await this._tween(2600, (s) => {
        const t = (performance.now() - t0) / 1000;
        ghost.moveTo(x0 + (x - x0) * (1 - (1 - s) ** 2), floor.y - this.body * 0.1 - Math.sin(t * 3) * this.body * 0.05, dir);
    });
    this._check(ctx);
    this.fx.comic(_t("BOO!"), x, floor.y - this.body * 1.25, { size: 56, color: "#f8fafc" });
    shake(this, 4);
    await this._wait(1400, ctx);
    ghost.whisk();
    this._stand(floor, x);
    this.scale = 1;
    this.host.style.opacity = "";
    this._face(0);
    const h = headPage(this);
    this.fx.say(_t("hehe, got you!"), h.x, h.y - this.body * 0.12, 1800);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
}

/** Christmas: a Santa hat, a present on the floor, opened. */
async function christmasPresent(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const snow = this.fx.snowfall();
    this.onEnd(() => snow.stop());
    await this.prop("santahat");
    const dir = this.b.x < width / 2 ? 1 : -1;
    const x = clamp(this.b.x + dir * this.body * 0.6, this.body * 0.4, width - this.body * 0.4);
    const gift = this.fx.present(x, this.b.y, this.body * 0.28);
    this.onEnd(() => gift.remove());
    this._face(0);
    let h = headPage(this);
    this.fx.say(_t("merry Christmas!"), h.x, h.y - this.body * 0.12, 2000);
    await this._play(LIB("Jump"), ctx);
    this._face(dir);
    await this._play(LIB("Squat"), ctx, { maxMs: 1100 });
    gift.open();
    this._face(0);
    h = headPage(this);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    await this._play(LIB("Clapping"), ctx);
    await this._wait(2000, ctx);
    snow.stop();
}

/** New Year's Eve: fireworks over the screen — and, when it's the time,
 *  the countdown to midnight first. */
async function newYearFireworks(ctx) {
    if (!ground(this)) return;
    const { width, height } = this.world.area;
    this._face(0);
    if (toNewYearS() <= 15) {
        let shown = null;
        for (let left = toNewYearS(); left > 0.05; left = toNewYearS()) {
            const n = Math.ceil(left);
            if (n <= 10 && n !== shown) {
                shown = n;
                this.fx.comic(String(n), width / 2, height * 0.35, { size: 130, color: "#fde047", ms: 900 });
            }
            await this._wait(50, ctx);
        }
        this.fx.comic(_t("HAPPY NEW YEAR!"), width / 2, height * 0.3, { size: 84, color: "#fde047", ms: 3600 });
        this.fx.confetti(width / 2, height * 0.3, 60);
    }
    const end = performance.now() + rand(8000, 11000);
    let cheer = this._play(LIB("Jump"), ctx).catch(() => {});
    while (performance.now() < end) {
        this.fx.firework(rand(width * 0.1, width * 0.9), rand(height * 0.08, height * 0.35), height);
        await this._wait(rand(350, 900), ctx);
        if (Math.random() < 0.15) { await cheer; cheer = this._play(LIB(pick(["Clapping", "Jump", "VRMA_05_spin"])), ctx).catch(() => {}); }
    }
    await cheer;
}

// ── anytime ──────────────────────────────────────────────────────────────

/** A boomerang: thrown out in a wide loop and back — caught, or now and
 *  then a bonk on the head. */
async function boomerang(ctx) {
    if (!ground(this)) return;
    const { width } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    this._face(dir);
    const swing = this._play(ROAM("throw"), ctx).catch(() => {});
    await this._wait(480, ctx);
    const from = bonePage(this, "rightHand") || headPage(this);
    const b = this.fx.boomerang(this.body * 0.22);
    this.onEnd(() => b.remove());
    const R = Math.min(width * 0.3, this.body * 2.4), ry = R * 0.4;
    const miss = Math.random() < 0.25;
    const ms = 2400;
    const t0 = performance.now();
    for (;;) {
        await this._nextFrame();
        this._check(ctx);
        const s = Math.min(1, (performance.now() - t0) / ms);
        const th = s * Math.PI * 2;
        let x = from.x + dir * R * (1 - Math.cos(th));
        let y = from.y - ry * Math.sin(th);
        // Home in on the hand (or the head) over the last stretch.
        if (s > 0.8) {
            const to = miss ? headPage(this) : (bonePage(this, "rightHand") || headPage(this));
            const k = (s - 0.8) / 0.2;
            x += (to.x - x) * k;
            y += (to.y - y) * k;
        }
        b.moveTo(x, y, s * 1800);
        if (s >= 1) break;
    }
    await swing;
    b.remove();
    const h = headPage(this);
    this._face(0);
    if (miss) {
        this.fx.stars(h.x, h.y);
        this.fx.say(_t("ow!"), h.x, h.y - this.body * 0.12, 1300);
        await this._play(LIB("Surprised"), ctx, { maxMs: 1800 });
    } else {
        this.fx.say(_t("got it!"), h.x, h.y - this.body * 0.12, 1300);
        await this._play(LIB("VRMA_03_peace_sign"), ctx, { maxMs: 2500 });
    }
}

export function installSeasonGags(proto) {
    Object.assign(proto, {
        thunderstorm, hailstorm, galeDay, foggyDay, buildSnowman, iceSkate, iceCream, waterFight,
        blossom, eggHunt, sheetGhost, christmasPresent, newYearFireworks, boomerang,
    });
}

// Same table shape as the director's. The weather and season weights are
// at their peak month, scaled by roam_seasons.js; holidays only in their
// days ("Try one now" runs them any day).
export const SEASON_GAG_ACTIONS = [
    { id: "storm", group: "weather", weight: () => 4 * season("thunder"), cooldown: 300, when: ground, run: thunderstorm },
    { id: "hail", group: "weather", weight: () => 3 * season("hail"), cooldown: 300, when: ground, run: hailstorm },
    { id: "gale", group: "weather", weight: () => 4 * season("gale"), cooldown: 300, when: (d) => d.onFloor, run: galeDay },
    { id: "fog", group: "weather", weight: () => 4 * season("fog"), cooldown: 300, when: (d) => d.onFloor, run: foggyDay },
    { id: "snowman", group: "season", weight: () => 6 * season("lying"), cooldown: 600, when: (d) => d.onFloor, run: buildSnowman },
    { id: "skate", group: "season", weight: () => 5 * season("frost"), cooldown: 300, when: (d) => d.onFloor, run: iceSkate },
    { id: "ice_cream", group: "season", weight: () => 5 * season("sun"), cooldown: 300, when: ground, run: iceCream },
    // At a face Jev found (roam_gags.js faces: never on a video call).
    { id: "water_fight", group: "trick_face", weight: () => 12 * season("sun"), cooldown: 240, when: (d) => d.onFloor && faces(d).length > 0, run: waterFight },
    { id: "blossom", group: "season", weight: () => 6 * season("blossom"), cooldown: 300, when: ground, run: blossom },
    { id: "easter_egg_hunt", group: "holiday", weight: 12, cooldown: 900, when: (d) => d.onFloor && easterTime(), run: eggHunt },
    { id: "halloween_bedsheet_ghost", group: "holiday", weight: 12, cooldown: 900, when: (d) => d.onFloor && halloweenTime(), run: sheetGhost },
    { id: "christmas_santa_hat", group: "holiday", weight: 12, cooldown: 900, when: (d) => d.onFloor && christmasTime(), run: christmasPresent },
    // Also started by the director in the last seconds of the year.
    { id: "new_year_fireworks", group: "holiday", weight: 10, cooldown: 600, when: (d) => ground(d) && newYearTime(), run: newYearFireworks },
    { id: "boomerang", group: "art", weight: 4, cooldown: 150, when: ground, run: boomerang },
];
