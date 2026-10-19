// More roam gags (models/roam_director.js), the second batch: what happens
// when the window under them goes away, more things to do with what Jev
// finds on the screen, reacting to what the computer plays (models/
// roam_ears.js), the companion's own world (their memories, coming back to
// you), the seasons and the time of day, and a few big rare set pieces.
// Same shape as roam_gags.js: methods of the director, one table of actions.

import { _t } from "../lib/i18n";
import {
    ROAM, LIB, TOOL, rand, pick, clamp, bonePage, headPage, centre, faces, floorSpot, besideIt,
    everyFrame, dropDown, ground, lookedAt,
} from "./roam_gags";
import { season, night } from "./roam_seasons";

const DANCES = ["freestyle-1", "freestyle-3", "freestyle-4", "girl-groove",
    "hip-hop", "house", "locking", "pop-groove"].map((n) => `/assets/vrma/dances/${n}.vrma`);
// The music dance is fresh when music starts, and wears off as it plays on:
// its odds halve with every song's length of music heard, one song being
// 197 s (the average song released in 2020; UCLA's analysis of Spotify),
// down to MUSIC_FLOOR of them. What was heard fades in the quiet with a
// MUSIC_RECOVER_S half-life (by eye: the gaps between tracks barely
// count, a quarter of an hour off and it's new again).
const MUSIC_SONG_S = 197;
const MUSIC_FLOOR = 0.2;
const MUSIC_RECOVER_S = 300;
// What's heard stops counting once the odds are at their floor (~2.3
// songs): an hour of music wears it off no more than ten minutes do.
const MUSIC_CAP_S = MUSIC_SONG_S * Math.log2(1 / MUSIC_FLOOR);
// Music starting with the dance at least this fresh (a first track, or
// after a good break) is an event: the dance comes next.
const MUSIC_START_FRESH = 0.5;
// A tantrum needs this long out roaming since the last call…
const LONELY_MS = 60 * 60 * 1000;
// …and kaiju steps shake the screen this hard (px, by eye).
const STOMP_PX = 9;
// What a rocket goes for, and how often each: ads and errors first.
const ROCKETABLE = { ad: 3, error: 3, picture: 1, button: 1, icon: 1 };
// Riding the pointer: a flick faster than this throws them off (m/s at
// their scale; by eye, past an ordinary move across the screen).
const THROW_OFF = 7;

const ledgeOrFloor = (d) => d.b.mode === "ground";

/** Seconds of music heard lately (d._musicHeard, kept by onMusic in the
 *  director): growing while it plays, fading while it doesn't. */
function musicHeard(d) {
    const h = d._musicHeard;
    if (!h) return 0;
    const dt = (performance.now() - h.at) / 1000;
    return d.music ? Math.min(MUSIC_CAP_S, h.s + dt) : h.s * 0.5 ** (dt / MUSIC_RECOVER_S);
}

/** Music started or stopped (roam_ears.js): what was heard so far is
 *  settled, and goes on from there. Started with the dance still fresh,
 *  they react to it at once. */
export function noteMusic(d, on) {
    const s = musicHeard(d);
    const started = on && !d.music;
    d._musicHeard = { s, at: performance.now() };
    d.music = on;
    // Stopped before they could get to it: nothing to dance to.
    if (!on && d._pendingReact === "music_dance") d._pendingReact = null;
    if (started && d.tricks && freshness(s) >= MUSIC_START_FRESH) d._react("music_dance");
}

const freshness = (s) => Math.max(MUSIC_FLOOR, 0.5 ** (s / MUSIC_SONG_S));

/** The music dance's share of its weight now. */
function musicFresh(d) {
    return freshness(musicHeard(d));
}

// ── when the window under them goes ──────────────────────────────────────

/** Their window was closed under them: a cartoon moment in mid-air, a
 *  "help!" sign, then the drop. */
async function helpSign(ctx) {
    this.b.mode = "scripted";
    this._face(0);
    const h = headPage(this);
    this.r.lookAtPoint?.({ x: this.b.x, y: this.world.area.height }, 1600);
    const sign = this.fx.sign(_t("help!"), h.x, h.y - this.body * 0.08);
    this.onEnd(() => sign.remove());
    await this._wait(1400, ctx);
    sign.remove();
    await dropDown(this, ctx);
}

/** Their window was minimized with them on it: sucked down into the
 *  taskbar with it, popping back out a moment later. */
async function suckedAway(ctx) {
    this.b.mode = "scripted";
    const y0 = this.b.y;
    const floor = this.world.area.height;
    this.fx.say(_t("whoa!"), headPage(this).x, headPage(this).y - this.body * 0.1, 900);
    await this._tween(700, (s) => {
        this.b.y = y0 + (floor + this.body * 0.4 - y0) * s * s;
        this.scale = 1 - s;
        this.tilt = s * 540;
    });
    this.tilt = 0;
    this.host.style.opacity = "0";
    await this._wait(rand(1500, 2500), ctx);
    this._stand(this.world.floor(), clamp(this.b.x, this.body * 0.4, this.world.area.width - this.body * 0.4));
    this.host.style.opacity = "";
    await this._tween(300, (s) => { this.scale = s; });
    this.scale = 1;
    await this._play(LIB("Surprised"), ctx);
}

// ── things on the screen ─────────────────────────────────────────────────

/** Monkey bars: hand over hand along a progress bar, a cheer at the end. */
async function monkeyBars(ctx) {
    const f = pick(this.seen("progress").filter((x) => x.rect.width > this.body * 0.6 && x.rect.y > this.body * 0.2));
    if (!f) return;
    f.used = true;
    const { rect } = f;
    const y = rect.y + rect.height / 2;
    await this._vanish();
    await this._play(ROAM("hang"), ctx, { loop: true });
    await this._appear(() => this._pinTo(rect.x + 10, y, ["leftHand", "rightHand"], 0.035, f.win), ctx);
    const x0 = rect.x + 10, x1 = rect.x + rect.width - 10;
    const ms = Math.max(1500, ((x1 - x0) / (0.5 * this.m.pxPerM)) * 1000);
    await this._tween(ms, (s) => {
        if (!this.pin) return;
        this.pin.x = x0 + (x1 - x0) * s;
        // Hand over hand: a little hitch each reach.
        this.pin.y = y + 3 * Math.abs(Math.sin(s * Math.PI * Math.max(2, Math.round((x1 - x0) / 40))));
    });
    this._check(ctx);
    this.fx.comic(_t("100%!"), x1, rect.y - 20, { size: 30 });
    await dropDown(this, ctx);
    await this._play(LIB("Clapping"), ctx);
}

/** Climbs into a photo and stands in it, coloured to match, like they
 *  were always there; a wink, and out again. */
async function hideInPhoto(ctx) {
    const f = pick(this.seen("picture").filter((x) => x.rect.height > this.body * 0.45 && x.rect.width > this.body * 0.3));
    if (!f) return;
    f.used = true;
    const { rect } = f;
    const back = { x: this.b.x };
    await this._vanish();
    // Small enough to stand in the picture.
    this.sizeMul = (rect.height * 0.72) / this.body;
    this._applySize();
    await this._nextFrame();
    this.clipRect = rect;
    this.host.style.filter = "sepia(.25) saturate(.75) contrast(.9) brightness(.97)";
    this.b.mode = "scripted";
    await this._appear(() => {
        this.b.x = rect.x + rect.width * rand(0.35, 0.65);
        this.b.y = rect.y + rect.height * 0.94;
    }, ctx);
    this._face(0);
    await this._wait(rand(4500, 7000), ctx);
    this.r.setEmotion?.("happy", { explicit: false });
    const h = headPage(this);
    this.fx.say("😉", h.x, h.y - 6, 1200);
    await this._wait(1300, ctx);
    await this._vanish();
    this.clipRect = null;
    this.host.style.filter = "";
    this.sizeMul = 1;
    this._applySize();
    await this._nextFrame();
    await this._appear(() => this._stand(this.world.floor(), clamp(back.x, this.body * 0.4, this.world.area.width - this.body * 0.4)), ctx);
}

/** Reads over your shoulder with a magnifying glass, then gasps or giggles. */
async function magnifier(ctx) {
    const f = pick(this.seen("text"));
    if (!f || !this.onFloor || !this._look?.shot) return;
    f.used = true;
    const { rect } = f;
    await besideIt(this, centre(rect), rect.width / 2 + this.body * 0.4, ctx);
    await this._play(TOOL("watch_closely_loop"), ctx, { loop: true });
    const { canvas, frame } = this._look.shot;
    const lens = this.fx.lens(canvas.toDataURL("image/jpeg", 0.85), frame, Math.max(70, Math.min(140, rect.height * 1.4)));
    this.onEnd(() => lens.remove());
    const lines = [0.25, 0.55, 0.85].map((u) => rect.y + rect.height * u);
    for (const y of lines) {
        await this._tween(1500, (s) => lens.at(rect.x + rect.width * s, y + Math.sin(s * 9) * 2));
        this._check(ctx);
    }
    lens.remove();
    this._rest();
    this._face(0);
    const h = headPage(this);
    if (Math.random() < 0.5) {
        this.fx.say("!?", h.x, h.y - this.body * 0.1, 1400);
        await this._play(LIB("Surprised"), ctx);
    } else {
        this.fx.say(_t("hehe"), h.x, h.y - this.body * 0.1, 1400);
        this.fx.hearts(h.x, h.y - this.body * 0.1);
        await this._wait(1400, ctx);
    }
}

/** Crosses out an ad with a big red marker X. NOPE. */
async function adAttack(ctx) {
    const f = pick(this.seen("ad").filter((x) => x.rect.width > 60 && x.rect.height > 30));
    if (!f || !this.onFloor) return;
    f.used = true;
    const c = centre(f.rect);
    await besideIt(this, c, f.rect.width / 2 + this.body * 0.45, ctx);
    await this._play(TOOL("paint_canvas_loop"), ctx, { loop: true });
    await this.fx.doodle({ kind: "x", x: c.x, y: c.y, size: f.rect.height, width: f.rect.width, ink: "#ef1c1c",
        tilt: false, drawMs: 1100, lifeMs: 7000 });
    this._check(ctx);
    this.fx.comic(_t("NOPE"), c.x, c.y, { size: Math.min(90, Math.max(36, f.rect.height * 0.5)), color: "#ef1c1c", ms: 1600 });
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
}

/** Shoulders a rocket launcher, sights, and blows up an ad (or an error,
 *  or whatever's handy): FWOOSH, BOOM, the bits of it fly, the screen
 *  shakes, and a moment later it's mended. */
async function rocketLauncher(ctx) {
    const pool = Object.entries(ROCKETABLE).flatMap(([k, w]) => this.seen(k)
        .filter((f) => f.rect.width > 24 && f.rect.height > 16)
        .flatMap((f) => Array(w).fill(f)));
    const f = pick(pool);
    if (!f || !this.onFloor || !this._look?.shot) return;
    f.used = true;
    const target = centre(f.rect);
    const cut = this._cutOut(f.rect);
    await besideIt(this, target, Math.max(this.body * 1.6, f.rect.width / 2 + this.body * 0.8), ctx);
    const tube = await this.prop("launcher");
    await this._play(ROAM("bazooka"), ctx, { loop: true });
    await this._wait(1300, ctx);
    const page = (p) => (p ? { x: this.box.left + p.x, y: this.box.top + p.y } : null);
    const from = page(tube?.pointPx("muzzle")) || headPage(this);
    const rear = page(tube?.pointPx("rear"));
    if (rear) this.fx.puff(rear.x, rear.y, this.body * 0.22);
    this.fx.comic(_t("FWOOSH!"), from.x, from.y - 26, { size: 22, color: "#ffffff" });
    await this.fx.projectile("rocket", from, target, { ms: 650, lift: 20 });
    this._check(ctx);
    this._patch = this.fx.patch(f.rect, cut.color);
    this.fx.debris(cut.src, f.rect, target.x, target.y);
    this.fx.explosion(target.x, target.y, Math.min(260, Math.max(120, Math.max(f.rect.width, f.rect.height) * 1.4)));
    this.fx.comic(_t("BOOM!"), target.x, f.rect.y - 16, { size: 48, color: "#ff8a1f" });
    this.root.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${STOMP_PX}px, ${-STOMP_PX / 2}px)` },
        { transform: `translate(${-STOMP_PX}px, ${STOMP_PX / 2}px)` }, { transform: "translate(0, 0)" }], { duration: 260 });
    await this._wait(1800, ctx);
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
    // Mended: the hole fills back in with the real thing.
    await this._wait(1500, ctx);
    const p = this._patch;
    this._patch = null;
    p?.fade(1500);
}

/** A swim across a video, as if it were a pool: in at one edge, front
 *  crawl across, splash out the other side. */
async function swimVideo(ctx) {
    const f = pick(this.seen("video").filter((x) => x.rect.width > this.body * 1.4 && x.rect.height > this.body * 0.45));
    if (!f) return;
    f.used = true;
    const { rect } = f;
    const dir = Math.random() < 0.5 ? 1 : -1;
    await this._vanish();
    await this._play(ROAM("swim"), ctx, { loop: true });
    this.r.roamFace(dir * Math.PI / 2);
    this.clipRect = rect;
    this.b.mode = "scripted";
    // The flat body's middle (half a body up from the feet's line) at the
    // video's middle.
    const y = rect.y + rect.height * 0.55 + this.body * 0.5;
    const x0 = dir > 0 ? rect.x - this.body * 0.3 : rect.x + rect.width + this.body * 0.3;
    const x1 = dir > 0 ? rect.x + rect.width + this.body * 0.3 : rect.x - this.body * 0.3;
    this.b.x = x0;
    this.b.y = y;
    this.scale = 1;
    this.host.style.opacity = "";
    this.fx.splash(dir > 0 ? rect.x : rect.x + rect.width, rect.y + rect.height * 0.55);
    const ms = Math.abs(x1 - x0) / (0.9 * this.m.pxPerM) * 1000;
    let bubbleAt = 0;
    await this._tween(ms, (s) => {
        this.b.x = x0 + (x1 - x0) * s;
        this.b.y = y + Math.sin(s * 20) * 2;
        if (performance.now() > bubbleAt) {
            bubbleAt = performance.now() + 500;
            this.fx.crumbs(this.b.x + dir * this.body * 0.45, y - this.body * 0.55, "rgba(224,242,254,.9)", 3);
        }
    });
    this._check(ctx);
    this.fx.splash(dir > 0 ? rect.x + rect.width : rect.x, rect.y + rect.height * 0.55);
    this.clipRect = null;
    this.host.style.opacity = "0";
    await this._wait(400, ctx);
    this._rest();
    this._face(0);
    const floor = this.world.floor();
    await this._appear(() => this._stand(floor, clamp(x1, this.body * 0.4, floor.x1 - this.body * 0.4)), ctx);
    this.r.setEmotion?.("happy", { explicit: false });
}

/** Holds up a 10/10 scorecard over your work. */
async function scorecard(ctx) {
    if (!ground(this)) return;
    this._face(0);
    await this._play(ROAM("carry"), ctx, { loop: true });
    const at = () => {
        const l = bonePage(this, "leftHand"), r = bonePage(this, "rightHand");
        return l && r ? { x: (l.x + r.x) / 2, y: Math.min(l.y, r.y) + this.body * 0.02 } : headPage(this);
    };
    const p = at();
    const card = this.fx.sign(pick(["10/10", "11/10", "A+", "✓✓✓"]), p.x, p.y, { big: true });
    const stop = everyFrame(this, () => { const q = at(); card.moveTo(q.x, q.y); });
    this.onEnd(() => { stop(); card.remove(); });
    this.fx.confetti(p.x, p.y - this.body * 0.2, 30);
    await this._wait(3200, ctx);
    stop();
    card.remove();
    this._rest();
}

/** Bonks red error text with a squeaky hammer. */
async function bonkError(ctx) {
    const f = pick(this.seen("error"));
    if (!f || !this.onFloor) return;
    f.used = true;
    const c = centre(f.rect);
    const cut = this._cutOut(f.rect);
    await besideIt(this, c, f.rect.width / 2 + this.body * 0.35, ctx);
    await this.prop("hammer");
    const swing = this._play(ROAM("throw"), ctx).catch(() => {});
    await this._wait(470, ctx);
    this._patch = this.fx.patch(f.rect, cut.color);
    const st = this.fx.sticker(cut.src, f.rect);
    this.fx.stars(c.x, c.y);
    this.fx.comic(_t("BONK!"), c.x, f.rect.y - 14, { size: 34 });
    this.fx.comic(_t("squeak"), c.x + 40, f.rect.y + f.rect.height + 10, { size: 16, color: "#ffffff" });
    await st.knock(c.x > this.b.x ? 1 : -1);
    st.remove();
    await swing;
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_06_model_pose"), ctx);
}

/** Picks an emoji off the page and juggles it. */
async function emojiJuggle(ctx) {
    const f = pick(this.seen("emoji").filter((x) => x.rect.width < 90));
    if (!f) return;
    const { sticker } = await this._grab(f, ctx);
    this.held = null;
    this._face(0);
    await this._play(ROAM("juggle"), ctx, { loop: true });
    const t0 = performance.now();
    const stop = everyFrame(this, () => {
        const l = bonePage(this, "leftHand"), r = bonePage(this, "rightHand");
        if (!l || !r) return;
        const ph = ((performance.now() - t0) / 700) % 1;    // one throw per 0.7 s, hand to hand
        const going = Math.floor((performance.now() - t0) / 700) % 2 === 0;
        const a = going ? l : r, b = going ? r : l;
        sticker.moveTo(a.x + (b.x - a.x) * ph, Math.min(a.y, b.y) - Math.sin(ph * Math.PI) * this.body * 0.45 - 8, ph * 360);
    });
    this.onEnd(stop);
    await this._wait(4200, ctx);
    stop();
    this._rest();
    await sticker.flyHome(800);
    sticker.fade(300);
    const p = this._patch;
    this._patch = null;
    p?.fade(300);
}

/** Pops up beside a face in a picture and draws it a moustache. */
async function moustache(ctx) {
    const f = pick(faces(this));
    if (!f) return;
    f.used = true;
    const face = centre(f.rect);
    const dir = face.x - f.rect.width / 2 - this.body * 0.5 > 0 ? 1 : -1;
    const { width } = this.world.area;
    await this._vanish();
    this.b.mode = "scripted";
    this.b.x = clamp(face.x - dir * (f.rect.width * 0.5 + this.body * 0.32), this.body * 0.2, width - this.body * 0.2);
    this.b.y = face.y + this.body * 0.75;
    this.r.roamFace(dir * Math.PI / 2);
    await this._play(TOOL("paint_canvas_loop"), ctx, { loop: true });
    await this._appear(() => {}, ctx);
    await this.fx.doodle({ kind: "moustache", x: face.x, y: f.rect.y + f.rect.height * 0.7, size: f.rect.height * 0.3,
        width: f.rect.width * 0.62, ink: "#141414", tilt: false, drawMs: 1300, lifeMs: 20000 });
    this._check(ctx);
    const h = headPage(this);
    this.fx.say(_t("hehe"), h.x, h.y - this.body * 0.1, 1300);
    await this._wait(700, ctx);
    await dropDown(this, ctx, { vx: -dir * this.m.pxPerM });
    await this._walkTo(this.b.x - dir * this.body * 1.5, ctx, { rate: 1.7 });
}

/** Rides your mouse pointer: on in a pop, then surfing it wherever you
 *  take it, leaning into the moves, until a fast flick throws them off or
 *  they hop off. With no pointer feed, a giant pointer to skate instead. */
async function cursorRide(ctx) {
    if (!this.cursor) return skatePointer.call(this, ctx);
    if (!this.onFloor) return;
    await this._vanish();
    await this._play(ROAM("skate"), ctx, { loop: true });
    this.b.mode = "scripted";
    this.originFeet = true;     // the lean pivots on the pointer
    this.riding = true;         // MascotView: no ghost fade from it being under them
    this.onEnd(() => { this.riding = false; });
    await this._appear(() => { this.b.x = this.cursor.x; this.b.y = this.cursor.y; }, ctx);
    const throwOff = THROW_OFF * this.m.pxPerM;
    let vx = 0, vy = 0, last = performance.now();
    const end = last + rand(10000, 16000);
    for (;;) {
        await this._nextFrame();
        this._check(ctx);
        const c = this.cursor;
        if (!c) break;
        const t = performance.now();
        const dt = Math.max(0.001, Math.min(0.05, (t - last) / 1000));
        last = t;
        // The feed comes at 30 Hz: eased after, not jumped to.
        const k = Math.min(1, dt * 18);
        const nx = this.b.x + (c.x - this.b.x) * k, ny = this.b.y + (c.y - this.b.y) * k;
        vx = vx * 0.8 + ((nx - this.b.x) / dt) * 0.2;
        vy = vy * 0.8 + ((ny - this.b.y) / dt) * 0.2;
        this.b.x = nx;
        this.b.y = ny;
        this.tilt = clamp((vx / this.m.pxPerM) * 6, -28, 28);
        if (Math.hypot(vx, vy) > throwOff) {
            const h = headPage(this);
            this.fx.say(_t("whoa!"), h.x, h.y - this.body * 0.1, 900);
            break;
        }
        if (t > end || t - c.movedAt > 5000) break;
    }
    this.tilt = 0;
    this.riding = false;
    this._rest();
    await dropDown(this, ctx, { vx: vx * 0.6, vy: Math.min(vy * 0.6, -this.m.pxPerM) });
}

/** A giant mouse pointer to ride along the floor like a skateboard. */
async function skatePointer(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    const size = this.body * 0.5;
    const board = this.fx.pointer(this.b.x + dir * this.body * 0.35, this.b.y - size * 0.15, size);
    this.onEnd(() => board.remove());
    await this._wait(500, ctx);
    // On it.
    this.b.mode = "scripted";
    const from = this.b.x, to = from + dir * this.body * 0.35, y0 = this.b.y;
    await this._play(ROAM("skate"), ctx, { loop: true });
    await this._tween(380, (s) => {
        this.b.x = from + (to - from) * s;
        this.b.y = y0 - size * 0.12 * s - Math.sin(s * Math.PI) * this.body * 0.2;
    });
    this.r.roamFace(dir * 0.35);
    const end = dir > 0 ? width - this.body * 0.6 : this.body * 0.6;
    const speed = 2.4 * this.m.pxPerM;
    let puff = 0;
    await this._tween(Math.abs(end - this.b.x) / speed * 1000, (s) => {
        const x = to + (end - to) * s;
        this.b.x = x;
        board.at(x, y0 - size * 0.15, dir);
        if (performance.now() > puff) { puff = performance.now() + 120; this.fx.puff(x - dir * size * 0.5, y0 - 6, 16); }
    });
    this._check(ctx);
    this.b.x = end;
    this.b.y = y0;
    this.b.mode = "ground";
    board.remove();
    this._rest();
    this._face(0);
    this.fx.comic(_t("click!"), end, y0 - this.body * 1.1, { size: 22, color: "#ffffff" });
}

// ── the cute and the hungry ──────────────────────────────────────────────
// Points on the face from the head bone, in metres on the authoring
// avatar (tools/motion: the eyes 7 cm up, the mouth half that, the crown
// 17 cm), for avatars without eye bones and for what has no bone at all.

// The double take's eye bulge, as extra size on the eye bones (by eye).
const EYE_POP = 0.4;
// A cat ear's flick, out and back (radians, by eye).
const EAR_FLICK = 0.3;

function eyesPage(d) {
    const l = bonePage(d, "leftEye"), r = bonePage(d, "rightEye");
    if (l && r) return l.x < r.x ? [l, r] : [r, l];
    const h = headPage(d), m = d.m.pxPerM;
    return [{ x: h.x - 0.03 * m, y: h.y - 0.07 * m }, { x: h.x + 0.03 * m, y: h.y - 0.07 * m }];
}

function mouthPage(d) {
    const [l, r] = eyesPage(d);
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 + 0.045 * d.m.pxPerM };
}

/** A cat on the screen: cat ears on, a "meow?" at it — and the cat meows
 *  back. */
async function catChat(ctx) {
    const f = pick(this.seen("cat"));
    if (!f || !ground(this)) return;
    f.used = true;
    const c = centre(f.rect);
    if (this.onFloor) await besideIt(this, c, f.rect.width / 2 + this.body * 0.5, ctx);
    this._face(c.x - this.b.x);
    this.r.lookAtPoint?.(c, 10000);
    // A cat-ear headband (fitted to their hair), the ears flicking now and
    // then, each on its own.
    const band = await this.prop("catears");
    const ears = ["catears_earl", "catears_earr"].map((n, i) => ({ node: band?.obj.getObjectByName(n), side: i ? -1 : 1, at: 0 }));
    const t0 = performance.now();
    const twitch = everyFrame(this, () => {
        const t = performance.now() - t0;
        for (const e of ears) {
            if (!e.node) continue;
            if (t > e.at + 2600) e.at = t + Math.random() * 2400;
            const k = (t - e.at) / 260;
            e.node.rotation.z = k > 0 && k < 1 ? e.side * EAR_FLICK * Math.sin(k * Math.PI) : 0;
        }
    });
    this.onEnd(twitch);
    const me = (t) => { const h = headPage(this); this.fx.say(t, h.x, h.y - this.body * 0.14, 1500); };
    const cat = (t) => this.fx.say(t, c.x, f.rect.y + f.rect.height * 0.2, 1500);
    me(_t("meow?"));
    await this._play(LIB("Thinking"), ctx, { maxMs: 1600 });
    cat(_t("mrrp!"));
    await this._wait(1700, ctx);
    me(_t("meow meow!"));
    await this._play(LIB("Jump"), ctx, { maxMs: 1600 });
    cat(_t("MEOW."));
    await this._wait(1700, ctx);
    this.fx.hearts(c.x, f.rect.y + 10);
    const h = headPage(this);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    this.r.setEmotion?.("happy", { explicit: false });
    await this._play(LIB("Clapping"), ctx);
}

/** A cute animal on the screen: heart eyes, "awww!", and over to pet it,
 *  the animal wiggling happily under their hand. */
async function petAnimal(ctx) {
    const f = pick([...this.seen("animal"), ...this.seen("cat")]);
    if (!f || !ground(this)) return;
    f.used = true;
    const c = centre(f.rect);
    const { width } = this.world.area;
    this._face(0);
    this.r.lookAtPoint?.(c, 3000);
    const eyes = this.fx.heartEyes(...eyesPage(this), this.body * 0.06);
    const follow = everyFrame(this, () => eyes.move(...eyesPage(this)));
    this.onEnd(() => { follow(); eyes.stop(); });
    let h = headPage(this);
    this.fx.say(_t("awww!"), h.x, h.y - this.body * 0.14, 1600);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    this.r.setEmotion?.("happy", { explicit: false });
    await this._play(LIB("Blush"), ctx, { maxMs: 2200 });
    follow();
    eyes.stop();
    // Over beside it, the stroking hand on its middle (as punchFace goes
    // up beside a face).
    const dir = c.x - f.rect.width / 2 - this.body * 0.45 > 0 ? 1 : -1;
    const cut = this._cutOut(f.rect);
    await this._vanish();
    const floorY = this.world.floor().y;
    const y = c.y + this.body * 0.72;
    this.b.x = clamp(c.x - dir * (f.rect.width * 0.3 + this.body * 0.3), this.body * 0.2, width - this.body * 0.2);
    if (y < floorY) {
        this.b.mode = "scripted";
        this.b.y = y;
    } else {
        this._stand(this.world.floor(), this.b.x);
    }
    this.r.roamFace(dir * Math.PI / 2);
    await this._play(ROAM("pet"), ctx, { loop: true });
    await this._appear(() => {}, ctx);
    this._patch = this.fx.patch(f.rect, cut.color);
    const st = this.fx.sticker(cut.src, f.rect);
    this.onEnd(() => st.remove());
    st.wiggle();
    const purr = setInterval(() => this.fx.hearts(c.x + rand(-0.3, 0.3) * f.rect.width, c.y - f.rect.height * 0.3), 800);
    this.onEnd(() => clearInterval(purr));
    await this._wait(rand(3500, 5000), ctx);
    clearInterval(purr);
    st.remove();
    h = headPage(this);
    this.fx.say(_t("good friend!"), h.x, h.y - this.body * 0.14, 1500);
    await this._wait(900, ctx);
    if (this.b.mode === "scripted") await dropDown(this, ctx, { vx: -dir * this.m.pxPerM * 0.5 });
}

/** Food on the screen: AWOOGA! — a double take, their own eyes bulging
 *  (the eye bones, boinging out and wobbling), mouth open, surprise lines,
 *  drool, the food in a thought bubble — then they tear it off the page
 *  and eat it. */
async function foodAwooga(ctx) {
    const f = pick(this.seen("food"));
    if (!f || !ground(this)) return;
    const c = centre(f.rect);
    const dish = this._cutOut(f.rect);
    this._face(0);
    this.r.lookAtPoint?.(c, 5000);
    this.r.setEmotion?.("surprised", { explicit: false });
    const h = headPage(this);
    this.fx.emanata(h.x, h.y - this.body * 0.04, this.body * 0.2);
    this.fx.comic(_t("AWOOGA!"), h.x, h.y - this.body * 0.34, { size: 46, color: "#f472b6", ms: 1700 });
    // Out with a jolt, then a wobble dying away (a damped spring); EYE_POP
    // at the most.
    const t0 = performance.now();
    let k = 1;
    const boing = everyFrame(this, () => {
        const t = (performance.now() - t0) / 1000;
        k = 1 + EYE_POP * (1 - Math.exp(-t * 7)) + 0.45 * EYE_POP * Math.exp(-t * 2.5) * Math.sin(t * 24);
        this.r.roamEyeScale?.(k);
    });
    const at = () => { const q = headPage(this); return { x: q.x + this.body * 0.08, y: q.y - this.body * 0.16 }; };
    const bubble = this.fx.thought(dish.src, at().x, at().y, this.body * 0.36);
    const follow = everyFrame(this, () => { const p = at(); bubble.move(p.x, p.y); });
    const drool = setInterval(() => {
        const m = mouthPage(this);
        this.fx.drip(m.x + rand(-3, 3), m.y, this.b.y, "#bae6fd");
    }, 500);
    const stop = () => { boing(); follow(); clearInterval(drool); bubble.stop(); this.r.roamEyeScale?.(1); };
    this.onEnd(stop);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1800 });
    this.fx.hearts(c.x, f.rect.y + 10);
    await this._wait(1500, ctx);
    boing();
    const k0 = k;
    await this._tween(260, (s) => this.r.roamEyeScale?.(k0 + (1 - k0) * s));
    stop();
    const { sticker, color } = await this._grab(f, ctx);
    this._face(0);
    await this._play(ROAM("eat"), ctx, { loop: true });
    this.held.dy = -0.02;
    for (let i = 1; i <= 6; i++) {
        await this._wait(480, ctx);
        sticker.bite(1 - i / 6);
        const hp = this._bonesPx(this.held.bones);
        if (hp) this.fx.crumbs(this.box.left + hp.x, this.box.top + hp.y, color);
    }
    sticker.remove();
    this.held = null;
    this._rest();
    const q = headPage(this);
    this.fx.say(_t("yum!"), q.x, q.y - this.body * 0.14, 1400);
    this.fx.hearts(q.x, q.y - this.body * 0.1);
    this.r.setEmotion?.("happy", { explicit: false });
    await this._wait(1200, ctx);
}

// ── sound ────────────────────────────────────────────────────────────────

/** Music's on: out comes a boombox, pulsing to the beat, and a dance. */
async function musicDance(ctx) {
    if (!ground(this) || !this.music) return;
    this._face(0);
    const box = await this.prop("boombox");
    await this._play(pick(DANCES), ctx, { loop: true });
    const stop = everyFrame(this, () => {
        if (!box) return;
        const k = Math.exp(-(performance.now() - (this._lastBeat || 0)) / 110);
        box.obj.scale.setScalar(1 + 0.12 * k);
    });
    this.onEnd(stop);
    const end = performance.now() + 45000;
    while (this.music && performance.now() < end) await this._wait(500, ctx);
    stop();
    this._rest();
}

/** A sudden loud sound: a jump, and a look at the speakers. */
async function startle(ctx) {
    if (!ground(this)) return;
    const { width, height } = this.world.area;
    this._face(0);
    this.r.lookAtPoint?.({ x: width - 160, y: height + 20 }, 2500);
    const h = headPage(this);
    this.fx.say("!?", h.x, h.y - this.body * 0.12, 1300);
    await this._play(LIB("Surprised"), ctx);
}

/** The bass drops: air guitar under spotlights. */
async function airGuitar(ctx) {
    if (!ground(this)) return;
    this._face(0);
    await this.prop("guitar");
    await this._play(ROAM("air_guitar"), ctx, { loop: true });
    const h = headPage(this);
    // In the spotlight.
    this.host.style.filter = "drop-shadow(0 0 18px rgba(255,255,255,.55))";
    this.fx.comic("🤘", h.x + this.body * 0.35, h.y - this.body * 0.1, { size: 40, ms: 1500 });
    await this._wait(rand(6000, 9000), ctx);
    this.host.style.filter = "";
    this._rest();
}

// ── their world ──────────────────────────────────────────────────────────

/** You're back after a long while: they come over, wave, and hold up a
 *  sign you can click to start a call. */
async function welcomeBack(ctx) {
    if (!ground(this)) return;
    const c = this.cursor;
    if (c && this.onFloor) await this._walkTo(clamp(c.x, this.body * 0.4, this.world.area.width - this.body * 0.4), ctx, { rate: 1.6 });
    this._face(0);
    await this._play(LIB("Wave"), ctx, { maxMs: 2500 });
    const h = headPage(this);
    let clicked = false;
    const sign = this.fx.sign(_t("call me? ☎"), h.x, h.y - this.body * 0.12, {
        onClick: () => { clicked = true; this.onCallRequest?.(); },
    });
    const stop = everyFrame(this, () => { const q = headPage(this); sign.moveTo(q.x, q.y - this.body * 0.12); });
    this.onEnd(() => { stop(); sign.remove(); });
    await this._until(() => clicked, ctx, 20000);
}

// ── seasons, time of day ─────────────────────────────────────────────────

/** Autumn: a pile of leaves, and a jump right into it. */
async function leafJump(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    const x = clamp(this.b.x + dir * this.body * 1.1, this.body * 0.5, width - this.body * 0.5);
    const pile = this.fx.leafPile(x, this.b.y, this.body * 0.8);
    this.onEnd(() => pile.remove());
    await this._walkTo(x - dir * this.body * 0.6, ctx);
    this.b.mode = "scripted";
    const from = { x: this.b.x, y: this.b.y };
    await this._play(ROAM("fall"), ctx, { loop: true });
    await this._tween(650, (s) => {
        this.b.x = from.x + (x - from.x) * s;
        this.b.y = from.y - Math.sin(s * Math.PI) * this.body * 0.6;
    });
    this.b.y = from.y;
    pile.burst();
    this.fx.say(_t("wheee!"), headPage(this).x, headPage(this).y - this.body * 0.1, 1300);
    this.b.mode = "ground";
    await this._play(ROAM("land"), ctx);
}

/** Winter: snowballs at a face Jev found on the screen. */
async function snowballs(ctx) {
    const f = pick(faces(this));
    if (!f || !this.onFloor) return;
    f.used = true;
    const face = centre(f.rect);
    await besideIt(this, face, this.body * 1.6, ctx);
    for (let i = 0; i < 3; i++) {
        const to = { x: face.x + rand(-0.2, 0.2) * f.rect.width, y: face.y + rand(-0.15, 0.15) * f.rect.height };
        this._face(to.x - this.b.x);
        const swing = this._play(ROAM("throw"), ctx).catch(() => {});
        await this._wait(480, ctx);
        const hand = bonePage(this, "rightHand") || headPage(this);
        await this.fx.projectile("snowball", hand, to, { ms: 650, lift: 90 });
        this.fx.snowSplat(to.x, to.y);
        if (i === 0) this.fx.comic(_t("POOF!"), to.x, f.rect.y - 10, { size: 30, color: "#f8fafc" });
        await swing;
    }
    this._rest();
    this._face(0);
    await this._play(LIB("Clapping"), ctx);
}

/** A summer-night (any night) moment: fireflies come round them. */
async function fireflyNight(ctx) {
    if (!ground(this)) return;
    const h = headPage(this);
    const ff = this.fx.fireflies(h.x, h.y, this.body * 0.6);
    const stop = everyFrame(this, () => { const q = headPage(this); ff.move(q.x, q.y); });
    this.onEnd(() => { stop(); ff.stop(); });
    this._face(0);
    await this._play(LIB("LookAround"), ctx);
    await this._wait(rand(4000, 7000), ctx);
    await this._play(LIB("Clapping"), ctx);
}

// ── big, rare ────────────────────────────────────────────────────────────

/** A kaiju walking across behind all your windows, the screen shaking. */
async function kaiju(ctx) {
    if (!this.onFloor) return;
    const { width, height } = this.world.area;
    const back = { x: this.b.x };
    await this._vanish();
    this.sizeMul = 1.25 / (this.body / height);
    this._applySize();
    await this._nextFrame();
    await this._nextFrame();
    const body = this.body;
    const dir = Math.random() < 0.5 ? 1 : -1;
    // Behind every window, like a city skyline, when most of the screen is
    // desktop; over a screen of windows that would hide it all but the
    // ROAR, so it stomps past in front of them instead.
    let open = 0;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 9; j++) {
        if (!this.world.windowAt((i + 0.5) * width / 16, (j + 0.5) * height / 9)) open++;
    }
    this.behindAll = open / (16 * 9) > 0.5;
    this.b.mode = "scripted";
    this.b.x = dir > 0 ? -body * 0.35 : width + body * 0.35;
    this.b.y = height + body * 0.3;
    this.scale = 1;
    this.host.style.opacity = "";
    this.r.roamFace(dir * Math.PI / 2);
    const rate = 0.45;
    this.r.roamWalk(true, { rate });
    const speed = 0.55 * this.m.pxPerM;
    const stepMs = 560 / rate;   // the walk loop's step at that pace (by eye)
    let nextStep = performance.now() + stepMs / 2;
    let roared = false;
    const x1 = dir > 0 ? width + body * 0.35 : -body * 0.35;
    let last = performance.now();
    while (dir > 0 ? this.b.x < x1 : this.b.x > x1) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        this.b.x += dir * speed * Math.min(0.05, (t - last) / 1000);
        last = t;
        if (t > nextStep) {
            nextStep = t + stepMs;
            this.root.animate([{ transform: "translate(0,0)" }, { transform: `translate(${STOMP_PX * (Math.random() - 0.5)}px, ${STOMP_PX}px)` },
                { transform: "translate(0,0)" }], { duration: 220 });
            this.fx.puff(this.b.x, height - 10, body * 0.08);
        }
        if (!roared && Math.abs(this.b.x - width / 2) < body * 0.1) {
            roared = true;
            this.fx.comic(_t("ROAR!"), width / 2, height * 0.25, { size: 90, color: "#a3e635", ms: 1600 });
        }
    }
    this.r.roamWalk(false);
    this.behindAll = false;
    this.host.style.opacity = "0";
    this.sizeMul = 1;
    this._applySize();
    await this._nextFrame();
    await this._appear(() => this._stand(this.world.floor(), clamp(back.x, this.body * 0.4, width - this.body * 0.4)), ctx);
    this.fx.say(_t("hehe"), headPage(this).x, headPage(this).y - this.body * 0.1, 1200);
}

/** A glitch: they break up and fall through the floor, and come down
 *  from the top of the screen. */
async function glitchOut(ctx) {
    if (!this.onFloor) return;
    const snap = this.r.roamSnapshot?.();
    if (!snap) return;
    const rect = { x: this.box.left, y: this.box.top, width: this.box.width, height: this.box.height };
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    await this.fx.glitch(snap, rect, 900);
    await this._wait(900, ctx);
    this._stand(this.world.floor(), this.b.x);
    this.b.y = -this.body * 0.05;
    this.host.style.opacity = "";
    await dropDown(this, ctx);
}

/** Out roaming for an hour with no call: a pillow fort and a KEEP OUT. */
async function tantrum(ctx) {
    if (!this.onFloor) return;
    await this._walkTo(floorSpot(this, this.body * 0.8), ctx);
    this._face(0);
    await this._play(LIB("Angry"), ctx);
    const fort = this.fx.fort(this.b.x, this.b.y, this.body * 1.2, _t("KEEP OUT"));
    this.onEnd(() => fort.collapse());
    this.fx.say(_t("hmph"), headPage(this).x, headPage(this).y - this.body * 0.1, 1500);
    await this._wait(rand(14000, 22000), ctx);
    fort.setSign(_t("…ok fine"));
    await this._wait(2000, ctx);
    await fort.collapse();
    this._lonelySince = performance.now();
}

/** Paparazzi: a red carpet, flashes from everywhere, the poses. */
async function paparazzi(ctx) {
    if (!this.onFloor) return;
    this._face(0);
    const carpet = this.fx.carpet(this.b.x - this.body * 1.4, this.b.x + this.body * 1.4, this.b.y);
    this.onEnd(() => carpet.roll());
    const flashes = setInterval(() => {
        this.fx.pop(this.b.x + (Math.random() - 0.5) * this.body * 2.4, this.b.y - Math.random() * this.body * 1.3, 40 + Math.random() * 40);
    }, 160);
    this.onEnd(() => clearInterval(flashes));
    for (const p of ["VRMA_06_model_pose", "VRMA_03_peace_sign", "BlowKiss", "VRMA_05_spin"]) {
        await this._play(LIB(p), ctx, { maxMs: 3000 });
    }
    clearInterval(flashes);
    await carpet.roll();
}

/** Ctrl+C, Ctrl+V: a see-through copy of them appears and copies their
 *  every move a beat late, until Del. */
async function cloneCopy(ctx) {
    if (!this.onFloor || !this.r.roamSnapshot) return;
    const { width } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    const h = headPage(this);
    this.fx.comic("Ctrl+C", h.x, h.y - this.body * 0.15, { size: 26, color: "#e0f2fe" });
    await this._wait(800, ctx);
    this.fx.comic("Ctrl+V", h.x + dir * this.body * 0.6, h.y - this.body * 0.15, { size: 26, color: "#e0f2fe" });
    const copy = this.fx.copyCanvas(this.box.width, this.box.height);
    // Twelve frames behind (~0.2 s): the copy is always just catching up.
    const ring = Array.from({ length: 12 }, () => document.createElement("canvas"));
    let n = 0;
    const stop = everyFrame(this, () => {
        const slot = ring[n % ring.length];
        if (!this.r.roamSnapshot(slot)) return;
        n++;
        if (n > ring.length) copy.draw(ring[n % ring.length], true);
        copy.place(this.box.left + dir * this.body * 0.7, this.box.top);
    });
    this.onEnd(() => { stop(); copy.remove(); });
    this._face(0);
    for (const p of ["Wave", "VRMA_05_spin", "Jump", "Clapping"]) await this._play(LIB(p), ctx, { maxMs: 3000 });
    this.fx.comic("Del", h.x + dir * this.body * 0.7, h.y - this.body * 0.15, { size: 26, color: "#fca5a5" });
    stop();
    copy.remove();
}

export function installMoreGags(proto) {
    Object.assign(proto, {
        helpSign, suckedAway, monkeyBars, hideInPhoto, magnifier, adAttack, swimVideo, scorecard, bonkError,
        emojiJuggle, moustache, cursorRide, catChat, petAnimal, foodAwooga, musicDance, startle, airGuitar, welcomeBack, leafJump, snowballs,
        fireflyNight, kaiju, glitchOut, tantrum, paparazzi, cloneCopy,
    });
}

const scene = (d, s) => d._look?.scene === s;

// helpSign / suckedAway / startle / welcome_back aren't picked: the
// director starts them when the thing happens (a window gone, a loud
// sound, you back). They're listed so "Try one now" has them.
// The tricks' groups (trick_*) are kinds of trick: two tricks can follow
// each other, two of a kind can't.
export const MORE_GAG_ACTIONS = [
    { id: "help_sign", group: "react", weight: 0, when: () => false, run: helpSign },
    { id: "sucked_away", group: "react", weight: 0, when: () => false, run: suckedAway },
    { id: "startle", group: "react", weight: 0, cooldown: 300, when: () => false, run: startle },
    { id: "welcome_back", group: "react", weight: 0, when: () => false, run: welcomeBack },
    { id: "monkey_bars", group: "trick_perch", weight: 24, cooldown: 120, when: (d) => lookedAt(d, "progress"), run: monkeyBars },
    { id: "hide_in_photo", group: "trick_perch", weight: 12, cooldown: 180, when: (d) => lookedAt(d, "picture"), run: hideInPhoto },
    { id: "magnifier", group: "trick_read", weight: (d) => (scene(d, "reading") ? 18 : 8), cooldown: 150, when: (d) => d.onFloor && lookedAt(d, "text"), run: magnifier },
    { id: "ad_attack", group: "trick_blast", weight: 26, cooldown: 120, when: (d) => d.onFloor && lookedAt(d, "ad"), run: adAttack },
    { id: "rocket", group: "trick_blast", weight: (d) => (lookedAt(d, "ad", "error") ? 20 : 10), cooldown: 240,
        when: (d) => d.onFloor && lookedAt(d, ...Object.keys(ROCKETABLE)), run: rocketLauncher },
    { id: "swim", group: "trick_perch", weight: (d) => (scene(d, "video") ? 24 : 10), cooldown: 180, when: (d) => lookedAt(d, "video"), run: swimVideo },
    { id: "scorecard", group: "emote", weight: (d) => (scene(d, "coding") ? 14 : 0), cooldown: 300, when: ground, run: scorecard },
    { id: "bonk_error", group: "trick_blast", weight: 30, cooldown: 90, when: (d) => d.onFloor && lookedAt(d, "error"), run: bonkError },
    { id: "emoji_juggle", group: "trick_grab", weight: 18, cooldown: 150, when: (d) => lookedAt(d, "emoji"), run: emojiJuggle },
    { id: "moustache", group: "trick_face", weight: 12, cooldown: 240, when: (d) => faces(d).length > 0, run: moustache },
    { id: "cursor_ride", group: "travel", weight: 5, cooldown: 240, when: (d) => d.onFloor, run: cursorRide },
    // A cat, an animal or food on the screen is a rare find: when there is
    // one, it's what they go for (the weights outrun the rest of the pool).
    { id: "cat_chat", group: "trick_cute", weight: 80, cooldown: 180, when: (d) => ground(d) && lookedAt(d, "cat"), run: catChat },
    { id: "pet_animal", group: "trick_cute", weight: (d) => (lookedAt(d, "animal") ? 80 : 30), cooldown: 180, when: (d) => ground(d) && lookedAt(d, "animal", "cat"), run: petAnimal },
    { id: "food_awooga", group: "trick_grab", weight: 90, cooldown: 150, when: (d) => ground(d) && lookedAt(d, "food"), run: foodAwooga },
    // Music on: a dance is one of the things they do, not the only one,
    // and less of one the longer it's been playing.
    { id: "music_dance", group: "dance", weight: (d) => (d.music ? 30 * musicFresh(d) : 0), cooldown: 90, when: (d) => d.tricks && ground(d) && d.music, run: musicDance },
    { id: "air_guitar", group: "dance", weight: 0, cooldown: 300, when: () => false, run: airGuitar },
    // By the season (models/roam_seasons.js): rarer out of it, not never.
    { id: "leaf_jump", group: "season", weight: () => 8 * season("leaves"), cooldown: 240, when: (d) => d.onFloor, run: leafJump },
    { id: "snowballs", group: "trick_face", weight: () => 14 * season("snow"), cooldown: 240, when: (d) => d.onFloor && faces(d).length > 0, run: snowballs },
    { id: "fireflies", group: "season", weight: () => 6 * season("fireflies"), cooldown: 300, when: (d) => ledgeOrFloor(d) && night(), run: fireflyNight },
    { id: "kaiju", group: "surprise", weight: 0.7, cooldown: 2400, when: (d) => d.onFloor, run: kaiju },
    { id: "glitch", group: "surprise", weight: 1.5, cooldown: 1200, when: (d) => d.onFloor, run: glitchOut },
    { id: "tantrum", group: "rest", weight: 30, cooldown: 3600,
      when: (d) => d.onFloor && d.world.idle < 60 && performance.now() - (d._lonelySince || 0) > LONELY_MS, run: tantrum },
    { id: "paparazzi", group: "meme", weight: 1, cooldown: 900, when: (d) => d.onFloor, run: paparazzi },
    { id: "clone", group: "meme", weight: 2, cooldown: 900, when: (d) => d.onFloor, run: cloneCopy },
];
