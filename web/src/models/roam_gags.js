// Gags for roam mode (models/roam_director.js): the prop pieces, the memes
// and the rare big moments, on top of the director's walking, sitting and
// screen tricks. Each is an action the director picks like any other (the
// GAG_ACTIONS table at the bottom joins its own); they run as its methods,
// with its primitives (walk, play a clip, portal out and in, grab something
// off the screen) and its effects layer (models/roam_fx.js).
//
// Props come from the roam set (tools/motion/roam_motions → assets/vrma/
// roam/props.json): out for one action, gone when it ends, however it
// ends. The face gags only ever aim at a face Jev found in a picture or a
// video, and never on a video call: that is a real person, live.

import { _t } from "../lib/i18n";

const VRMA = "/assets/vrma";
const ROAM = (n) => `${VRMA}/roam/${n}.vrma`;
const LIB = (n) => `${VRMA}/${n}.vrma`;
const TOOL = (n) => `${VRMA}/tool_motions/${n}.vrma`;

// Same pace as the director (the 1.25 m/s stroll on the 1.4 m/s walk clip).
const STROLL = 1.25;
const WALK_CLIP_PACE = 1.4;
// Climbing: two steps of about a quarter metre per cycle of the 1.2 s climb
// clip, so the hands keep hold of the wall.
const CLIMB_SPEED = 0.42;      // m/s
// Flying about like a screen saver, and the kart. By eye.
const FLY_SPEED = 2.4;         // m/s
const KART_SPEED = 3.6;        // m/s
// A giant is this many screen heights tall.
const GIANT_SCREENS = 1.6;
// A buried thing is dug up after this (by eye: long enough to wonder about
// the X, short enough not to clutter), or the mound goes by itself.
const DIG_UP_AFTER_MS = 15000;
const BURIED_MAX_MS = 50000;
// Fishing and the balloon ride (by eye).
const RISE_SPEED = 0.7;        // m/s, carried off by balloons
const CHUTE_SPEED = 1.1;       // m/s, drifting down
const REEL_SPEED = 0.6;        // m/s, the catch coming up
// What they fish for, and how often each: icons (the desktop's over the
// taskbar's), and only with none of those, whatever else is small.
const FISHABLE = { icon: 3, taskbar: 1 };
const FISHABLE_ELSE = { close: 1, link: 1, picture: 1, tab: 1, button: 1 };
// Window titles of video calls: the face gags stay away from those.
const CALL_TITLE = /zoom|teams|meet|webex|facetime|skype|discord|slack huddle|whereby/i;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (s) => s * s * (3 - 2 * s);

/** Where a bone is drawn, in page px. */
function bonePage(d, name) {
    const p = d.r.roamBonePx(name);
    return p ? { x: d.box.left + p.x, y: d.box.top + p.y } : null;
}

function headPage(d) {
    return bonePage(d, "head") || { x: d.b.x, y: d.b.y - d.body * 0.9 };
}

function centre(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Faces Jev found, unless a video call is in front. */
function faces(d) {
    if (d._look?.call || CALL_TITLE.test(d.world.foreground?.title || "")) return [];
    return d.seen("face").filter((f) => f.rect.width > 24);
}

/** A floor x with `half` px clear to each side. */
function floorSpot(d, half) {
    return rand(half, Math.max(half + 1, d.world.area.width - half));
}

/** Stand at x on the floor beside `target` (page px), facing it. */
async function besideIt(d, target, gap, ctx) {
    const { width } = d.world.area;
    let x = target.x + (target.x > width / 2 ? -gap : gap);
    x = clamp(x, d.body * 0.3, width - d.body * 0.3);
    await d._walkTo(x, ctx);
    d._face(target.x - d.b.x);
}

/** A picture of `rect` (page px) off a fresh capture with the companion
 *  drawn into it (a screen capture may or may not include the overlay
 *  window they're in, so they're added from their own frame), or null. */
async function snapRegion(d, rect) {
    const me = d.r.roamSnapshot?.();
    const meBox = { ...d.box };
    const cap = await d.bridge?.roamCapture?.();
    if (!cap) return null;
    const img = new Image();
    img.src = cap.dataUrl;
    try { await img.decode(); } catch (e) { return null; }
    const sx = cap.width / cap.frame.width, sy = cap.height / cap.frame.height;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(rect.width * sx));
    c.height = Math.max(1, Math.round(rect.height * sy));
    const g = c.getContext("2d");
    g.drawImage(img, (rect.x - cap.frame.x) * sx, (rect.y - cap.frame.y) * sy,
        rect.width * sx, rect.height * sy, 0, 0, c.width, c.height);
    if (me) g.drawImage(me, (meBox.left - rect.x) * sx, (meBox.top - rect.y) * sy, meBox.width * sx, meBox.height * sy);
    return c.toDataURL("image/jpeg", 0.9);
}

/** Run `fn` every frame until the returned stop() (or the director stops). */
function everyFrame(d, fn) {
    let on = true;
    (async () => {
        while (on && d.running) {
            await d._nextFrame();
            if (!on) return;
            try { fn(); } catch (e) { /* the next frame tries again */ }
        }
    })();
    return () => { on = false; };
}

/** Leave the floor on purpose: a planned fall, landing wherever. */
async function dropDown(d, ctx, { vx = 0, vy = 0 } = {}) {
    d._hopping = true;
    try {
        d._toAir({ vx, vy });
        await d._until(() => d.b.mode === "ground", ctx, 10000);
    } finally {
        d._hopping = false;
    }
}

// ── props and weather ────────────────────────────────────────────────────

/** Pulls out a sunbed and shades, and lies in the sun a while. */
async function sunbathe(ctx) {
    if (!this.onFloor) return;
    await this._walkTo(floorSpot(this, this.body * 0.9), ctx);
    this.aspect = 1.45;
    this._applySize();
    this.r.roamFace(Math.PI / 2);   // side-on: the bed runs along the floor
    await this.prop("sunbed");
    await this._play(ROAM("lounge"), ctx, { loop: true });
    await this.prop("sunglasses");
    const sun = this.fx.sun(this.b.x + this.body * 0.7, this.b.y - this.body * 1.05, this.body * 0.55);
    this.onEnd(() => sun.stop());
    await this._wait(rand(18000, 32000), ctx);
    this._rest();
    this._face(0);
    await this._wait(800, ctx);
}

/** A rain cloud of their very own; out comes the umbrella. */
async function rainyDay(ctx) {
    if (this.b.mode !== "ground") return;
    const w = this.body * 0.8;
    let h = headPage(this);
    const lift = this.body * 0.55;
    const cloud = this.fx.rainCloud(h.x, h.y - lift, w);
    const follow = setInterval(() => {
        h = headPage(this);
        cloud.move(h.x, h.y - lift);
    }, 40);
    this.onEnd(() => { clearInterval(follow); cloud.stop(); });
    this._face(0);
    await this._wait(900, ctx);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
    await this.prop("umbrella");
    await this._play(ROAM("umbrella"), ctx, { loop: true });
    await this._wait(1500, ctx);
    const s = this.b.surf || this.world.floor();
    const pad = this.body * 0.3;
    if (s.x1 - s.x0 > pad * 4) await this._walkTo(rand(s.x0 + pad, s.x1 - pad), ctx, { upper: ROAM("umbrella") });
    this._face(0);
    await this._play(ROAM("umbrella"), ctx, { loop: true });
    await this._wait(rand(3000, 6000), ctx);
    clearInterval(follow);
    cloud.stop();
    await this._wait(900, ctx);
    this._rest();
    await this._play(LIB("Stretch"), ctx);
}

/** "Uh oh…" and they crumble away to dust, then gather back. */
async function dustAway(ctx) {
    if (this.b.mode !== "ground") return;
    this._face(0);
    await this._play(LIB("Sad"), ctx, { maxMs: 2200 });
    const h = headPage(this);
    this.fx.say(_t("uh oh…"), h.x, h.y - this.body * 0.12, 1800);
    await this._wait(1200, ctx);
    const snap = this.r.roamSnapshot?.();
    if (!snap) return;
    const rect = { x: this.box.left, y: this.box.top, width: this.box.width, height: this.box.height };
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    await this.fx.dust(snap, rect, { ms: 3000 });
    await this._wait(rand(3000, 6000), ctx);
    await this.fx.dust(snap, rect, { reverse: true, ms: 2200 });
    this.host.style.opacity = "";
    await this._play(LIB("Surprised"), ctx);
}

/** Vacuums a paragraph off the page. */
async function hooverText(ctx) {
    const f = pick(this.seen("text"));
    if (!f || !this.onFloor) return;
    f.used = true;
    const cut = this._cutOut(f.rect);
    const target = centre(f.rect);
    await besideIt(this, target, f.rect.width / 2 + this.body * 0.4, ctx);
    const vac = await this.prop("vacuum");
    await this._play(ROAM("vacuum"), ctx, { loop: true });
    await this._wait(700, ctx);
    const n = vac?.pointPx("nozzle");
    const nozzle = n ? { x: this.box.left + n.x, y: this.box.top + n.y } : headPage(this);
    this._patch = this.fx.patch(f.rect, cut.color);
    this.fx.comic(_t("VRRRR!"), nozzle.x, nozzle.y - 30, { size: 26, color: "#e0f2fe" });
    await this.fx.suck(cut.src, f.rect, nozzle.x, nozzle.y, 3000);
    this._check(ctx);
    this.r.setEmotion?.("happy", { explicit: false });
    await this._wait(900, ctx);
    this._rest();
    this._face(0);
    const h = headPage(this);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    await this._wait(1200, ctx);
}

/** Pulls up in a go-kart from off screen, honks, parks and hops out. */
async function kartDrive(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    await this._vanish();
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.aspect = 1.5;
    this._applySize();
    this._stand(this.world.floor(), dir > 0 ? -this.body : width + this.body);
    this.b.mode = "scripted";
    this.r.roamFace(dir * Math.PI / 2);
    const kart = await this.prop("kart");
    await this._play(ROAM("drive"), ctx, { loop: true });
    this.scale = 1;
    this.host.style.opacity = "";
    const stopAt = rand(width * 0.3, width * 0.7);
    const top = KART_SPEED * this.m.pxPerM;
    let v = top;
    let honked = false;
    let puffAt = 0;
    let last = performance.now();
    while (dir > 0 ? this.b.x < stopAt : this.b.x > stopAt) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        // Brakes over the last body length or so.
        const left = Math.abs(stopAt - this.b.x);
        v = Math.max(top * 0.12, Math.min(top, top * (left / (this.body * 1.4))));
        this.b.x += dir * v * dt;
        if (t > puffAt && kart) {
            const e = kart.pointPx("exhaust");
            if (e) this.fx.puff(this.box.left + e.x, this.box.top + e.y, this.body * 0.08);
            puffAt = t + (v > top * 0.5 ? 90 : 220);
        }
        if (!honked && Math.abs(this.b.x - width / 2) < this.body) {
            honked = true;
            const h = headPage(this);
            this.fx.comic(_t("BEEP BEEP!"), h.x, h.y - this.body * 0.2, { size: 30 });
        }
    }
    await this._wait(900, ctx);
    kart?.hide();
    this._rest();
    this.b.mode = "ground";
    this._face(0);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
}

// ── things off the screen ────────────────────────────────────────────────

/** Grabs something off the screen, shows it off, and runs off with it. */
async function showAndRun(ctx) {
    const { width } = this.world.area;
    const pool = ["picture", "link", "search", "close", "tab", "button"].flatMap((k) => this.seen(k))
        .filter((f) => f.rect.width < width * 0.45 && f.rect.height < this.body * 1.2);
    const f = pick(pool);
    if (!f) return;
    const { sticker } = await this._grab(f, ctx);
    this.held.dy = -0.04;
    this.held.keep = true;
    this._face(0);
    await this._play(ROAM("carry"), ctx, { loop: true });
    const h = headPage(this);
    this.fx.say(_t("look what I found!"), h.x, h.y - this.body * 0.3, 2000);
    await this._wait(2000, ctx);
    const out = this.b.x < width / 2 ? width + this.body : -this.body;
    try {
        await this._walkTo(out, ctx, { rate: 1.7, upper: ROAM("carry"), offscreen: true });
    } finally {
        sticker.remove();
        this.held = null;
    }
    await this._wait(rand(3000, 6000), ctx);
    // Back in, empty-handed (and what they took is back too).
    const p = this._patch;
    this._patch = null;
    p?.fade(400);
    await this._walkTo(out > 0 ? width - this.body * 0.8 : this.body * 0.8, ctx, { offscreen: true });
    this._face(0);
    const h2 = headPage(this);
    this.fx.say("♪", h2.x, h2.y - this.body * 0.15, 1400);
}

/** Grabs something, digs a hole on the floor and buries it (an X marks
 *  the spot); digUp() brings it back later. */
async function buryTreasure(ctx) {
    const { width } = this.world.area;
    if (this._buried) return;
    const pool = ["picture", "link", "close", "tab", "button", "icon"].flatMap((k) => this.seen(k))
        .filter((f) => f.rect.width < width * 0.35 && f.rect.height < this.body * 0.8);
    const f = pick(pool);
    if (!f) return;
    const cut = this._cutOut(f.rect);
    const { sticker } = await this._grab(f, ctx);
    this.held.keep = true;
    const x = floorSpot(this, this.body * 0.7);
    try {
        await this._walkTo(x, ctx, { upper: ROAM("carry") });
        this._face(1);
        const spot = { x: this.b.x + this.body * 0.32, y: this.b.y };
        // Put down beside them, then the digging.
        this.held = null;
        sticker.moveTo(spot.x, spot.y - f.rect.height / 2);
        await this.prop("shovel");
        await this._play(ROAM("dig"), ctx, { loop: true });
        const mound = this.fx.mound(spot.x, spot.y, this.body * 0.42);
        for (let i = 0; i < 5; i++) {
            await this._wait(520, ctx);
            this.fx.dirt(spot.x, spot.y - 4);
            sticker.setScale(1 - (i + 1) / 5);
        }
        sticker.remove();
        mound.mark();
        const t = this._buried = { x: spot.x, cut, rect: f.rect, mound, at: performance.now() };
        // Not dug up by then (busy elsewhere, or off on a ledge): the mound
        // settles away and the treasure is quietly back where it was.
        t.expire = setTimeout(() => {
            if (this._buried !== t) return;
            this._buried = null;
            t.mound.fade(1500);
        }, BURIED_MAX_MS);
    } finally {
        if (!this._buried) sticker.remove();
    }
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_03_peace_sign"), ctx);
}

/** Back to the X: digs it up, holds it up, throws it home. */
async function digUp(ctx) {
    const t = this._buried;
    if (!t || !this.onFloor) return;
    await this._walkTo(t.x - this.body * 0.32, ctx);
    this._face(1);
    await this.prop("shovel");
    await this._play(ROAM("dig"), ctx, { loop: true });
    for (let i = 0; i < 4; i++) {
        await this._wait(520, ctx);
        this.fx.dirt(t.x, this.b.y - 4);
    }
    this._buried = null;
    clearTimeout(t.expire);
    t.mound.fade(800);
    for (const p of this._props) p.hide();
    this._rest();
    const sticker = this.fx.sticker(t.cut.src, t.rect);
    this.held = { sticker, bones: ["leftHand", "rightHand"], dy: -0.04, keep: true };
    this._face(0);
    try {
        await this._play(ROAM("carry"), ctx, { loop: true });
        const h = headPage(this);
        this.fx.say("!", h.x, h.y - this.body * 0.3, 1500);
        this.fx.confetti(h.x, h.y - this.body * 0.3, 24);
        await this._wait(1800, ctx);
        this._face(centre(t.rect).x < this.b.x ? -1 : 1);
        await this._play(ROAM("throw"), ctx, { maxMs: 600 });
    } finally {
        this.held = null;
    }
    await sticker.flyHome(850);
    sticker.fade(500);
    this._rest();
    this._face(0);
}

/** Dives into a picture or a video like water, and pops out of another. */
async function diveIn(ctx) {
    const pool = [...this.seen("picture"), ...this.seen("video")]
        .filter((f) => f.rect.width > this.body * 0.3 && f.rect.height > this.body * 0.25);
    const f = pick(pool);
    if (!f || this.b.mode !== "ground") return;
    f.used = true;
    const into = centre(f.rect);
    this._face(into.x - this.b.x);
    this._rest();
    await this._wait(300, ctx);
    this.b.mode = "scripted";
    const from = { x: this.b.x, y: this.b.y };
    const to = { x: into.x, y: into.y + this.body * 0.5 };
    const lift = Math.max(this.body * 0.4, from.y - to.y + this.body * 0.3) * 0.6;
    await this._play(ROAM("fall"), ctx, { loop: true });
    await this._tween(900, (s) => {
        this.b.x = from.x + (to.x - from.x) * s;
        this.b.y = from.y + (to.y - from.y) * s - Math.sin(Math.PI * s) * lift;
        this.scale = s < 0.6 ? 1 : 1 - (s - 0.6) / 0.4;
    });
    this.fx.ripple(f.rect, into.x, into.y);
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    await this._wait(rand(2500, 5000), ctx);
    const g = pick(pool.filter((x) => x !== f)) || f;
    const out = centre(g.rect);
    this.fx.ripple(g.rect, out.x, out.y);
    this.b.x = out.x;
    this.b.y = out.y + this.body * 0.5;
    this.host.style.opacity = "";
    await this._tween(380, (s) => { this.scale = s; });
    this.scale = 1;
    await dropDown(this, ctx, { vx: (Math.random() - 0.5) * this.m.pxPerM * 2, vy: -this.m.pxPerM * 2 });
}

/** Lies along the top edge of a picture or a video, kicking their feet,
 *  watching it. */
async function lieOnTop(ctx) {
    const pool = [...this.seen("picture"), ...this.seen("video")]
        .filter((f) => f.rect.y > this.body * 0.35 && f.rect.width > this.body * 0.9);
    const f = pick(pool);
    if (!f) return;
    f.used = true;
    const x = f.rect.x + f.rect.width / 2;
    await this._vanish();
    await this._play(ROAM("lie_front"), ctx, { loop: true });
    this.r.roamFace((Math.random() < 0.5 ? -1 : 1) * Math.PI / 2);
    await this._appear(() => this._pinTo(x, f.rect.y - this.body * 0.07, ["hips"], 0, f.win), ctx);
    const look = centre(f.rect);
    const end = performance.now() + rand(12000, 20000);
    while (performance.now() < end) {
        this.r.lookAtPoint?.(look, 4500);
        await this._wait(4000, ctx);
    }
    this._toAir();
}

/** Climbs up the side of the screen, then lets go. */
async function climbWall(ctx) {
    if (!this.onFloor) return;
    const { width, height } = this.world.area;
    const left = this.b.x < width / 2;
    await this._walkTo(left ? this.body * 0.16 : width - this.body * 0.16, ctx, { offscreen: true });
    this.r.roamFace(left ? -Math.PI / 2 : Math.PI / 2);
    await this._play(ROAM("climb"), ctx, { loop: true });
    this.b.mode = "scripted";
    const top = rand(height * 0.3, height * 0.6);
    const speed = CLIMB_SPEED * this.m.pxPerM;
    let last = performance.now();
    while (this.b.y > top) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        this.b.y -= speed * Math.min(0.05, (t - last) / 1000);
        last = t;
    }
    const h = headPage(this);
    this.fx.say(_t("wheee!"), h.x + (left ? this.body * 0.4 : -this.body * 0.4), h.y - this.body * 0.1, 1400);
    await dropDown(this, ctx, { vx: (left ? 1 : -1) * this.m.pxPerM * 1.2, vy: -this.m.pxPerM * 1.5 });
}

// ── at faces in pictures ─────────────────────────────────────────────────

async function spudGun(ctx) {
    const f = pick(faces(this));
    if (!f || !this.onFloor) return;
    f.used = true;
    const face = centre(f.rect);
    await besideIt(this, face, this.body * 1.5, ctx);
    const gun = await this.prop("spudgun");
    await this._play(ROAM("aim"), ctx, { loop: true });
    await this._wait(1000, ctx);
    for (let i = 0; i < 2; i++) {
        const mz = gun?.pointPx("muzzle");
        const from = mz ? { x: this.box.left + mz.x, y: this.box.top + mz.y } : headPage(this);
        this.fx.puff(from.x, from.y, this.body * 0.14);
        this.fx.comic(_t("POMF!"), from.x, from.y - 24, { size: 20, color: "#ffffff" });
        await this.fx.projectile("potato", from, face, { ms: 620, lift: 50 });
        this._check(ctx);
        this.fx.splat(face.x, face.y, Math.min(140, Math.max(50, f.rect.width * 0.6)));
        this.fx.comic(_t("SPLAT!"), face.x, f.rect.y - 10, { size: 34 });
        await this._wait(1100, ctx);
    }
    this._rest();
    this._face(0);
    await this._play(LIB("Clapping"), ctx);
}

async function fireball(ctx) {
    const f = pick(faces(this));
    if (!f || !this.onFloor) return;
    f.used = true;
    const face = centre(f.rect);
    await besideIt(this, face, this.body * 1.4, ctx);
    await this._play(TOOL("conjure_portal_in"), ctx, { maxMs: 1400 });
    const orb = this.r.startToolOrb?.();
    this.onEnd(() => orb?.burst());
    await this._play(TOOL("conjure_portal_loop"), ctx, { loop: true });
    await this._wait(1300, ctx);
    this._play(TOOL("conjure_portal_out"), ctx, { maxMs: 1500 }).catch(() => {});
    await this._wait(230, ctx);
    const hands = this._bonesPx(["leftHand", "rightHand"]);
    const from = hands ? { x: this.box.left + hands.x, y: this.box.top + hands.y } : headPage(this);
    orb?.burst();
    await this.fx.projectile("fireball", from, face, { ms: 560, lift: 30 });
    this.fx.explosion(face.x, face.y, Math.min(220, Math.max(90, f.rect.width * 1.2)));
    this.fx.comic(_t("KABOOM!"), face.x, f.rect.y - 16, { size: 40, color: "#ff8a1f" });
    await this._wait(1600, ctx);
    this._rest();
    this._face(0);
    await this._play(LIB("VRMA_06_model_pose"), ctx);
}

/** Teleports up beside a face and bops it. */
async function punchFace(ctx) {
    const f = pick(faces(this));
    if (!f) return;
    f.used = true;
    const face = centre(f.rect);
    const { width } = this.world.area;
    const dir = face.x - f.rect.width / 2 - this.body * 0.45 > 0 ? 1 : -1;
    const cut = this._cutOut(f.rect);
    await this._vanish();
    this.b.mode = "scripted";
    // Shoulders at the face's height, the reach (~0.6 m) on it.
    this.b.x = clamp(face.x - dir * (f.rect.width * 0.35 + this.body * 0.32), this.body * 0.2, width - this.body * 0.2);
    this.b.y = face.y + this.body * 0.8;
    this.r.roamFace(dir * Math.PI / 2);
    await this._appear(() => {}, ctx);
    const swing = this._play(ROAM("punch"), ctx).catch(() => {});
    await this._wait(280, ctx);
    this._patch = this.fx.patch(f.rect, cut.color);
    const st = this.fx.sticker(cut.src, f.rect);
    this.fx.comic(_t("POW!"), face.x, face.y, { size: 58 });
    await st.knock(dir);
    st.remove();
    await swing;
    await dropDown(this, ctx, { vx: -dir * this.m.pxPerM * 0.8 });
}

// ── memes and big moments ────────────────────────────────────────────────

/** Flies about like an old screen saver, celebrating a corner hit. */
async function screensaver(ctx) {
    if (this.b.mode !== "ground") return;
    const { width, height } = this.world.area;
    await this.prop("cape");
    await this._play(ROAM("fly"), ctx, { loop: true });
    this.b.mode = "scripted";
    const speed = FLY_SPEED * this.m.pxPerM;
    const a = rand(0.5, 0.9);
    let vx = (Math.random() < 0.5 ? -1 : 1) * speed * Math.cos(a);
    let vy = -speed * Math.sin(a);
    const end = performance.now() + rand(14000, 22000);
    let last = performance.now();
    let lastX = -1e9, lastY = -1e9;
    while (performance.now() < end) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        this.b.x += vx * dt;
        this.b.y += vy * dt;
        // The flat body's centre stays on screen.
        const cx = this.b.x, cy = this.b.y - this.body * 0.53;
        const hx = this.body * 0.5, hy = this.body * 0.15;
        if (cx < hx || cx > width - hx) { vx = -vx; this.b.x = clamp(cx, hx, width - hx); lastX = t; }
        if (cy < hy || cy > height - hy) { vy = -vy; this.b.y = clamp(cy, hy, height - hy) + this.body * 0.53; lastY = t; }
        if (Math.abs(lastX - lastY) < 120 && (t === lastX || t === lastY)) {
            const h = headPage(this);
            this.fx.confetti(h.x, h.y, 50);
            this.fx.comic(_t("CORNER!"), clamp(h.x, 120, width - 120), clamp(h.y, 60, height - 60), { size: 46 });
            lastX = lastY = -1e9;
        }
        this.r.roamFace(Math.sign(vx) * Math.PI / 2);
        this.tilt = Math.sign(vx) * Math.atan(vy / Math.max(1, Math.abs(vx))) * 180 / Math.PI;
    }
    this.tilt = 0;
    await dropDown(this, ctx, { vx: vx * 0.3 });
}

/** Walks off into the screen (smaller, a little higher), turns, comes
 *  back out past where they were (bigger), and steps back. */
async function depthWalk(ctx) {
    if (!this.onFloor) return;
    this.originFeet = true;
    this.b.mode = "scripted";
    const y0 = this.b.y;
    const rate = STROLL / WALK_CLIP_PACE;
    this.r.roamFace(Math.PI);
    this.r.roamWalk(true, { rate });
    await this._tween(3400, (s) => {
        this.scale = 1 - 0.55 * s;
        this.b.y = y0 - this.body * 0.3 * s;
    });
    this._check(ctx);
    this.r.roamWalk(false);
    this.r.roamFace(0);
    await this._wait(1100, ctx);
    await this._play(LIB("Wave"), ctx, { maxMs: 2500 });
    this.r.roamWalk(true, { rate });
    await this._tween(4000, (s) => {
        this.scale = 0.45 + 0.85 * s;
        this.b.y = y0 - this.body * 0.3 * (1 - s);
    });
    this._check(ctx);
    this.r.roamWalk(false);
    const h = headPage(this);
    this.fx.say(_t("hi!"), h.x, h.y - this.body * 0.2, 1500);
    await this._wait(1600, ctx);
    this.r.roamFace(Math.PI);
    this.r.roamWalk(true, { rate });
    await this._tween(1300, (s) => { this.scale = 1.3 - 0.3 * s; });
    this.r.roamWalk(false);
    this.r.roamFace(0);
    this.scale = 1;
    this.b.y = y0;
    this.b.mode = "ground";
}

/** A video thumbnail: the shocked face, the red circle and arrow, the caption. */
async function thumbnailMeme(ctx) {
    if (this.b.mode !== "ground") return;
    this._face(0);
    this.r.setEmotion?.("surprised", { explicit: false });
    this._play(LIB("Surprised"), ctx).catch(() => {});
    await this._wait(350, ctx);
    const rect = { x: this.b.x - this.body * 0.32, y: this.b.y - this.body * 1.05, width: this.body * 0.64, height: this.body * 1.08 };
    this.host.style.filter = "saturate(1.7) contrast(1.15)";
    const th = this.fx.thumbnail(rect, pick([_t("YOU WON'T BELIEVE THIS!"), _t("NOT CLICKBAIT"), _t("(GONE WRONG)"), "?!"]));
    this.onEnd(() => th.remove());
    this.originFeet = true;
    await this._tween(160, (s) => { this.scale = 1 + 0.2 * s; });
    await this._wait(2800, ctx);
    th.remove();
    this.host.style.filter = "";
    await this._tween(300, (s) => { this.scale = 1.2 - 0.2 * s; });
}

/** Rare: rises up from below the screen as a giant, waves, sinks back. */
async function giant(ctx) {
    if (!this.onFloor) return;
    const { width, height } = this.world.area;
    const x = this.b.x;
    await this._vanish();
    this.sizeMul = GIANT_SCREENS / (this.body / height);
    this._applySize();
    this.b.mode = "scripted";
    this.b.x = rand(width * 0.3, width * 0.7);
    await this._nextFrame();
    await this._nextFrame();
    const body = this.body;
    this.b.y = height + body * 1.02;
    this.scale = 1;
    this.host.style.opacity = "";
    this._face(0);
    await this._tween(2000, (s) => { this.b.y = height + body * (1.02 - 0.4 * ease(s)); });
    await this._play(LIB("Wave"), ctx, { maxMs: 3000 });
    await this._wait(1500, ctx);
    await this._tween(1500, (s) => { this.b.y = height + body * (0.62 + 0.4 * ease(s)); });
    this.host.style.opacity = "0";
    this.sizeMul = 1;
    this._applySize();
    await this._nextFrame();
    await this._appear(() => this._stand(this.world.floor(), clamp(x, this.body * 0.4, width - this.body * 0.4)), ctx);
}

/** Very rare: BOO! — their face right up against the screen. */
async function jumpScare(ctx) {
    if (this.b.mode !== "ground") return;
    const { width, height } = this.world.area;
    const back = { x: this.b.x, surf: this.b.surf || this.world.floor() };
    await this._vanish();
    const size = Math.min(width, height);
    const base = { left: (width - size) / 2, top: (height - size) / 2, width: size, height: size };
    this.boxOverride = { ...base };
    this._applySize();
    this.r.setRoamShot("face");
    this.b.mode = "scripted";
    this._face(0);
    this.r.setEmotion?.("angry", { explicit: false });
    await this._nextFrame();
    await this._nextFrame();
    this.scale = 0.25;
    this.host.style.opacity = "";
    this.fx.flash();
    await this._tween(130, (s) => { this.scale = 0.25 + 0.8 * s; });
    this.fx.comic(_t("BOO!"), width / 2, height * 0.85, { size: Math.round(size * 0.16), color: "#ff3b3b", ms: 1300 });
    await this._tween(650, (s) => {
        const k = (1 - s) * 16;
        this.boxOverride.left = base.left + Math.sin(s * 47) * k;
        this.boxOverride.top = base.top + Math.cos(s * 39) * k;
    });
    await this._wait(500, ctx);
    await this._tween(220, (s) => { this.scale = 1.05 * (1 - s); });
    this.host.style.opacity = "0";
    this.boxOverride = null;
    this.r.setRoamShot("full");
    this._applySize();
    this.r.setEmotion?.("happy", { explicit: false });
    await this._appear(() => this._stand(back.surf.id === "floor" ? this.world.floor() : back.surf, back.x), ctx);
    const h = headPage(this);
    this.fx.say(_t("hehe"), h.x, h.y - this.body * 0.15, 1600);
    await this._play(LIB("Clapping"), ctx);
}

/** A selfie with whatever's behind them: the camera-frame hands, a flash,
 *  and a polaroid of the moment left on the screen. */
async function selfie(ctx) {
    if (!this.tricks || !this.bridge?.roamCapture || this.b.mode !== "ground") return;
    this._face(0);
    await this._play(TOOL("frame_shot_in"), ctx, { maxMs: 1600 });
    await this._play(TOOL("frame_shot_loop"), ctx, { loop: true });
    await this._wait(900, ctx);
    // A square round them, kept on the screen (past its edge there's no
    // picture, only black).
    const side = Math.min(this.body * 1.5, this.world.area.width, this.world.area.height);
    const r = {
        x: clamp(this.b.x - side / 2, 0, this.world.area.width - side),
        y: clamp(this.b.y - side * 0.83, 0, this.world.area.height - side),
        width: side, height: side,
    };
    const src = await snapRegion(this, r);
    this._check(ctx);
    this.fx.flash();
    this._play(TOOL("frame_shot_out"), ctx).catch(() => {});
    if (src) {
        const side = this.b.x < this.world.area.width / 2 ? 1 : -1;
        this.fx.polaroid(src, this.b.x + side * this.body * 0.75, this.b.y - this.body * 0.45, this.body * 0.42, 8000);
    }
    await this._wait(1800, ctx);
}

/** Throws a paper plane that loops off across the screen. */
async function paperPlane(ctx) {
    if (this.b.mode !== "ground") return;
    const { width, height } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    this._face(dir);
    const swing = this._play(ROAM("throw"), ctx).catch(() => {});
    await this._wait(480, ctx);
    const hand = bonePage(this, "rightHand") || headPage(this);
    const to = { x: dir > 0 ? width + 60 : -60, y: rand(height * 0.1, height * 0.5) };
    this.fx.projectile("plane", hand, to, { ms: 2600, lift: height * 0.25 }).catch(() => {});
    await swing;
    this._face(0);
    await this._wait(1500, ctx);
}

// ── fishing, balloons, parachute ─────────────────────────────────────────

/** Where to fish `f` from: a window ledge above it with room to sit, the
 *  rod reaching out over it — or, with none, a cloud to sit on. */
function fishingSeat(d, f) {
    const c = centre(f.rect);
    const reach = d.body * 0.85;    // the rod's tip, out from the hips, side-on
    // In the taskbar, below the screen: from its bottom edge, legs over.
    const floor = d.world.floor();
    if (c.y > floor.y) {
        const dir = c.x > d.world.area.width / 2 ? 1 : -1;
        return { x: clamp(c.x - dir * reach, d.body * 0.4, d.world.area.width - d.body * 0.4), y: floor.y, dir, ledge: floor };
    }
    for (const dir of Math.random() < 0.5 ? [1, -1] : [-1, 1]) {
        const x = c.x - dir * reach;
        const ledge = d.world.ledges(d.body * 0.55)
            .filter((l) => l.y < f.rect.y - d.body * 0.3 && x >= l.x0 + d.body * 0.15 && x <= l.x1 - d.body * 0.15)
            .sort((a, b) => b.y - a.y)[0];
        if (ledge) return { x, y: ledge.y, dir, ledge };
    }
    const dir = c.x > d.world.area.width / 2 ? 1 : -1;
    const y = f.rect.y - d.body * 0.5;
    if (y < d.body * 0.6) return null;
    return { x: clamp(c.x - dir * reach, d.body * 0.4, d.world.area.width - d.body * 0.4), y, dir, ledge: null };
}

/** Sits on a ledge (or a cloud) above something on the screen, casts,
 *  waits for a bite, reels it up, admires it, and lets it go home. */
async function goFishing(ctx) {
    const pool = (table) => Object.entries(table).flatMap(([k, w]) => this.seen(k)
        .filter((f) => f.rect.width < this.body * 1.1 && f.rect.height < this.body * 0.8)
        .flatMap((f) => Array(w).fill(f)));
    const icons = pool(FISHABLE);
    const f = pick(icons.length ? icons : pool(FISHABLE_ELSE));
    const seat = f && fishingSeat(this, f);
    if (!seat) return;
    f.used = true;
    const cut = this._cutOut(f.rect);
    await this._vanish();
    this.aspect = 1.7;
    this._applySize();
    const rod = await this.prop("rod");
    await this._play(ROAM("fish"), ctx, { loop: true });
    this.r.roamFace(seat.dir * Math.PI / 2);
    if (!seat.ledge) {
        const cloud = this.fx.cloudSeat(seat.x, seat.y, this.body * 0.95);
        this.onEnd(() => cloud.stop());
    }
    await this._appear(() => this._pinTo(seat.x, seat.y - this.body * 0.06, ["hips"], 0, seat.ledge?.win ?? null), ctx);
    const line = this.fx.line();
    this.onEnd(() => line.stop());
    const tipPage = () => {
        const p = rod?.pointPx("tip");
        return p ? { x: this.box.left + p.x, y: this.box.top + p.y } : headPage(this);
    };
    const target = centre(f.rect);
    const hook = { ...tipPage() };
    let sticker = null;
    const stopTrack = everyFrame(this, () => {
        line.set(tipPage(), hook);
        if (sticker) sticker.moveTo(hook.x, hook.y + f.rect.height / 2 - 4, 6 * Math.sin(performance.now() / 260));
    });
    this.onEnd(stopTrack);
    // Cut short with it on the line: it still goes home.
    this.onEnd(() => {
        if (!sticker) return;
        const st = sticker;
        sticker = null;
        st.flyHome(800).then(() => st.fade(300));
    });
    // Cast: the hook drops to just above it.
    const from = { ...hook };
    const to = { x: target.x, y: f.rect.y + 4 };
    await this._tween(1100, (s) => {
        hook.x = from.x + (to.x - from.x) * s;
        hook.y = from.y + (to.y - from.y) * s * s;
    });
    // Waiting, the bobber bobbing.
    const end = performance.now() + rand(2500, 5500);
    while (performance.now() < end) {
        await this._nextFrame();
        this._check(ctx);
        hook.y = to.y + 3 * Math.sin(performance.now() / 300);
    }
    // A bite!
    this.fx.say("!", headPage(this).x, headPage(this).y - this.body * 0.15, 900);
    this._patch = this.fx.patch(f.rect, cut.color);
    sticker = this.fx.sticker(cut.src, f.rect);
    await this._play(ROAM("reel"), ctx, { loop: true });
    const speed = REEL_SPEED * this.m.pxPerM;
    let last = performance.now();
    for (;;) {
        await this._nextFrame();
        this._check(ctx);
        const tip = tipPage();
        const t = performance.now();
        const step = speed * Math.min(0.05, (t - last) / 1000);
        last = t;
        const dx = tip.x - hook.x, dy = tip.y + this.body * 0.08 - hook.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= step) break;
        hook.x += (dx / dist) * step;
        hook.y += (dy / dist) * step;
    }
    await this._play(ROAM("fish"), ctx, { loop: true });
    this.r.setEmotion?.("happy", { explicit: false });
    const h = headPage(this);
    this.fx.hearts(h.x, h.y - this.body * 0.1);
    this.fx.comic(_t("CATCH!"), hook.x, hook.y - 30, { size: 30 });
    await this._wait(2200, ctx);
    // Catch and release: back where it came from.
    stopTrack();
    line.stop();
    const st = sticker;
    sticker = null;
    await st.flyHome(800);
    st.fade(300);
    const p = this._patch;
    this._patch = null;
    p?.fade(300);
    this._rest();
    if (seat.ledge) {
        const still = this.world.refresh(seat.ledge, this.body * 0.55, this.b.x);
        if (still) {
            this._unpin(still);
            this._face(0);
            await this._wait(600, ctx);
            return;
        }
    }
    this._toAir();
}

/** Drifts down under a parachute at x from above the screen, landing on
 *  whatever is below. */
async function parachuteDown(x, ctx) {
    this.b.mode = "scripted";
    this.b.x = x;
    this.b.y = -this.body * 0.05;
    this.scale = 1;
    this._face(0);
    await this._play(ROAM("hang"), ctx, { loop: true });
    this.host.style.opacity = "";
    const chute = this.fx.parachute(this.body * 1.1);
    const lines = (tilt) => {
        const l = bonePage(this, "leftHand"), r = bonePage(this, "rightHand");
        if (l && r) chute.set(l, r, tilt);
    };
    lines(0);
    let landed = false;
    this.onEnd(() => { if (!landed) chute.collapse(); });
    const fall = CHUTE_SPEED * this.m.pxPerM;
    const x0 = x;
    let last = performance.now();
    const headroom = this.body * 0.9;
    for (;;) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        const sway = Math.sin(t / 900);
        const ny = this.b.y + fall * dt;
        const nx = x0 + sway * this.body * 0.3;
        const land = this.world.landing(nx, this.b.y, ny, headroom);
        this.b.x = nx;
        if (land) {
            this._stand(land, nx);
            break;
        }
        this.b.y = ny;
        lines(sway * 8);
    }
    landed = true;
    chute.collapse();
    await this._play(ROAM("land"), ctx);
}

/** A bunch of balloons carries them up and off the top of the screen;
 *  a while later they parachute back down somewhere else. */
async function balloonRide(ctx) {
    if (this.b.mode !== "ground") return;
    const { width } = this.world.area;
    this._face(0);
    // A taller shot: the balloons float a body length over the head.
    this.bodyFrac = 0.42;
    this._applySize();
    const balloons = await this.prop("balloons");
    await this._play(ROAM("float"), ctx, { loop: true });
    const h = headPage(this);
    this.fx.say(_t("whoa!"), h.x, h.y - this.body * 0.2, 1400);
    await this._wait(1100, ctx);
    this.b.mode = "scripted";
    const x0 = this.b.x;
    const rise = RISE_SPEED * this.m.pxPerM;
    let v = 0;
    let last = performance.now();
    // Up until they're gone off the top, feet and all.
    while (this.b.y > -this.body * 0.05) {
        await this._nextFrame();
        this._check(ctx);
        const t = performance.now();
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        v = Math.min(rise, v + rise * dt);   // lifting off gently
        this.b.y -= v * dt;
        this.b.x = x0 + Math.sin(t / 1100) * this.body * 0.25;
        this.tilt = Math.sin(t / 1100 + 0.6) * 4;
    }
    this.tilt = 0;
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    balloons?.hide();
    this.bodyFrac = 0.62;
    this._applySize();
    await this._wait(rand(4000, 8000), ctx);
    await this.parachuteDown(rand(width * 0.15, width * 0.85), ctx);
}

/** Swings right across the screen on web lines: a leap up, a line to the
 *  top of the screen (or a window's top edge), a pendulum swing, the next
 *  line, and so on, letting go at the far side. Each arc is half a
 *  pendulum's swing, π√(L/g) for a line of length L, with real gravity. */
async function webSwing(ctx) {
    if (this.b.mode !== "ground") return;
    const { width, height } = this.world.area;
    const dir = this.b.x < width / 2 ? 1 : -1;
    const g = 9.81 * this.m.pxPerM;
    const body = this.body;
    this._face(dir);
    await this._play(ROAM("swing"), ctx, { loop: true });
    this.r.roamFace(dir * Math.PI / 2);
    // Up off the ground first (a line from standing hangs nearly straight).
    this.b.mode = "scripted";
    const from = { x: this.b.x, y: this.b.y };
    const apex = { x: from.x + dir * body * 0.5, y: Math.min(from.y - body * 0.9, height * 0.55) };
    await this._tween(520, (s) => {
        const e = 1 - (1 - s) * (1 - s);
        this.b.x = from.x + (apex.x - from.x) * s;
        this.b.y = from.y + (apex.y - from.y) * e;
    });
    this._check(ctx);
    const web = this.fx.web();
    this.onEnd(() => web.stop());
    const handNow = () => bonePage(this, "rightHand") || headPage(this);
    let hand = handNow();
    this._pinTo(hand.x, hand.y, ["rightHand"], 0, null);
    // Tilt and scale turn about the hand, so it stays on the line.
    const keepOrigin = everyFrame(this, () => {
        const p = this.r.roamBonePx("rightHand");
        if (p) this.originPx = p;
    });
    this.onEnd(keepOrigin);
    const anchorY = (x) => {
        // A window's top edge above, when there is one; else the screen's.
        const w = this.world.windows.find((win) => x > win.x + 10 && x < win.x + win.width - 10
            && win.y > 12 && win.y < hand.y - body * 0.6 && !win.maximized);
        return w ? w.y : 6;
    };
    let release = null;
    const edge = dir > 0 ? width - body * 0.45 : body * 0.45;
    for (let arc = 0; arc < 8 && !release; arc++) {
        const room = Math.abs(edge - hand.x);   // how far an arc may still carry them
        if (room < body * 0.5) break;
        let ay = anchorY(hand.x + dir * body);
        // As long a line as fits: the body swinging under it stays on screen.
        const Lmax = height - ay - body * 1.05;
        let L = Math.max(body * 0.8, Lmax * rand(0.75, 1));
        let a0 = Math.acos(clamp((hand.y - ay) / L, 0.5, 0.95));
        let last = false;
        if (2 * L * Math.sin(a0) > room - body * 0.6) {
            // Not room for a whole arc: a shorter line that lands the end of
            // the swing at the edge, and the last one.
            a0 = 0.8;
            L = room / 2 / Math.sin(a0);
            ay = Math.max(6, hand.y - L * Math.cos(a0));
            L = Math.hypot(room / 2, hand.y - ay);
            a0 = Math.asin(clamp((room / 2) / L, 0.2, 0.95));
            last = true;
        }
        const anchor = { x: hand.x + dir * L * Math.sin(a0), y: ay };
        const hand0 = { ...hand };
        await this._tween(140, (s) => web.set({ x: hand0.x + (anchor.x - hand0.x) * s, y: hand0.y + (anchor.y - hand0.y) * s }, handNow()));
        this.fx.webSplat(anchor.x, anchor.y);
        if (arc === 0) this.fx.comic(_t("THWIP!"), anchor.x, anchor.y + 30, { size: 24, color: "#ffffff" });
        const T = Math.PI * Math.sqrt(L / g) * 1000;
        // The last one is let go near its end, still moving a little.
        const end = last ? 0.88 : 1;
        let th = 0;
        await this._tween(T * end, (k) => {
            const s = k * end;
            th = -dir * a0 * Math.cos(Math.PI * s);
            hand = { x: anchor.x + L * Math.sin(th), y: anchor.y + L * Math.cos(th) };
            this.pin.x = hand.x;
            this.pin.y = hand.y;
            // The body hangs along the line.
            this.tilt = -th * 180 / Math.PI;
            web.set(anchor, handNow());
        });
        this._check(ctx);
        if (last) {
            // Off the line with the swing's speed: L·θ' along its tangent.
            const w = dir * a0 * (Math.PI / (T / 1000)) * Math.sin(Math.PI * end);
            release = { vx: L * w * Math.cos(th), vy: -L * w * Math.sin(th) };
        }
    }
    web.stop();
    keepOrigin();
    this.originPx = null;
    this.tilt = 0;
    await dropDown(this, ctx, release || { vx: dir * body });
}

export function installGags(proto) {
    Object.assign(proto, {
        sunbathe, rainyDay, dustAway, hooverText, kartDrive, showAndRun, buryTreasure, digUp, diveIn,
        lieOnTop, climbWall, spudGun, fireball, punchFace, screensaver, depthWalk, thumbnailMeme, giant,
        jumpScare, selfie, paperPlane, goFishing, balloonRide, parachuteDown, webSwing,
    });
}

const ground = (d) => d.b.mode === "ground";
const lookedAt = (d, ...keys) => keys.some((k) => d.seen(k).length > 0);
// What the user is doing (Jev's scene answer) tips the odds a little.
const scene = (d, s, w, boost) => (d._look?.scene === s ? w * boost : w);

// Same table shape as the director's (its _pick reads `weight` as a
// number or as a function of the director).
export const GAG_ACTIONS = [
    { id: "sunbathe", group: "rest", weight: 7, cooldown: 300, when: (d) => d.onFloor, run: sunbathe },
    { id: "rain", group: "weather", weight: 6, cooldown: 240, when: ground, run: rainyDay },
    { id: "dust", group: "meme", weight: 3, cooldown: 600, when: ground, run: dustAway },
    { id: "kart", group: "vehicle", weight: 4, cooldown: 300, when: (d) => d.onFloor, run: kartDrive },
    { id: "climb", group: "travel", weight: 5, cooldown: 120, when: (d) => d.onFloor, run: climbWall },
    { id: "depth", group: "walk", weight: 5, cooldown: 180, when: (d) => d.onFloor, run: depthWalk },
    { id: "screensaver", group: "meme", weight: 2, cooldown: 900, when: ground, run: screensaver },
    { id: "thumbnail", group: "meme", weight: 2, cooldown: 900, when: ground, run: thumbnailMeme },
    { id: "paper_plane", group: "art", weight: 4, cooldown: 150, when: ground, run: paperPlane },
    { id: "selfie", group: "art", weight: 3, cooldown: 400, when: (d) => ground(d) && d.tricks, run: selfie },
    { id: "giant", group: "surprise", weight: 1, cooldown: 1800, when: (d) => d.onFloor, run: giant },
    { id: "jump_scare", group: "surprise", weight: 0.5, cooldown: 3600, when: ground, run: jumpScare },
    { id: "hoover", group: "trick", weight: (d) => scene(d, "reading", 22, 2), cooldown: 120, when: (d) => d.onFloor && lookedAt(d, "text"), run: hooverText },
    { id: "show_and_run", group: "trick", weight: 14, cooldown: 150, when: (d) => lookedAt(d, "picture", "link", "search", "close", "tab", "button"), run: showAndRun },
    { id: "bury", group: "trick", weight: 10, cooldown: 300, when: (d) => !d._buried && lookedAt(d, "picture", "link", "close", "tab", "button", "icon"), run: buryTreasure },
    { id: "dig_up", group: "trick", weight: 60, when: (d) => d.onFloor && d._buried && performance.now() - d._buried.at > DIG_UP_AFTER_MS, run: digUp },
    { id: "fishing", group: "trick", weight: (d) => (d.seen("icon").length ? 26 : 12), cooldown: 150, when: (d) => lookedAt(d, "icon", "taskbar", "close", "link", "picture", "tab", "button"), run: goFishing },
    { id: "balloons", group: "travel", weight: 4, cooldown: 400, when: ground, run: balloonRide },
    { id: "web_swing", group: "travel", weight: 5, cooldown: 240, when: ground, run: webSwing },
    { id: "dive", group: "trick", weight: (d) => scene(d, "pictures", 14, 2), cooldown: 120, when: (d) => ground(d) && lookedAt(d, "picture", "video"), run: diveIn },
    { id: "lie_on_top", group: "trick", weight: (d) => scene(d, "video", 14, 2), cooldown: 120, when: (d) => lookedAt(d, "picture", "video"), run: lieOnTop },
    { id: "spud_gun", group: "trick", weight: 14, cooldown: 180, when: (d) => d.onFloor && faces(d).length > 0, run: spudGun },
    { id: "fireball", group: "trick", weight: 12, cooldown: 180, when: (d) => d.onFloor && faces(d).length > 0, run: fireball },
    { id: "punch", group: "trick", weight: 12, cooldown: 180, when: (d) => faces(d).length > 0, run: punchFace },
];

// Shared with the second batch (models/roam_gags_more.js).
export {
    ROAM, LIB, TOOL, rand, pick, clamp, ease, bonePage, headPage, centre, faces, floorSpot, besideIt,
    everyFrame, dropDown, ground, lookedAt,
};
