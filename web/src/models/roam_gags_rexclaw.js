// Rexclaw's own set pieces for roam mode (models/roam_director.js): the
// crew's world come to the desktop. The Rexmaw sails in on a sea that rises
// over the bottom of the screen and takes them aboard; the Kraken grabs a
// window; a treasure map of this very screen leads to a chest of doubloons;
// Gerald the megalodon swallows them and spits them back out; the sky whale
// loops the loop and belly-flops; and the crew drop by — Sal, Rex and the
// Seagull Admiral. Same shape as roam_gags.js: methods of the director,
// one table of actions. The drawings are models/roam_fx_rexclaw.js.

import { _t } from "../lib/i18n";
import { ROAM, LIB, rand, pick, clamp, bonePage, headPage, everyFrame, dropDown, ground } from "./roam_gags";
import "./roam_fx_rexclaw";

/** The screen jolts: the overlay shoved `px` and back. */
function shake(d, px) {
    d.root.animate([{ transform: "translate(0,0)" }, { transform: `translate(${px * (Math.random() - 0.5)}px, ${px * 0.6}px)` },
        { transform: `translate(${-px * 0.4}px, ${-px * 0.3}px)` }, { transform: "translate(0,0)" }], { duration: 380 });
}

const say = (d, text, ms = 1600) => {
    const h = headPage(d);
    d.fx.say(text, h.x, h.y - d.body * 0.14, ms);
};

/** A planned leap from where they are to `to()` (a point that may move,
 *  page px), `ms` long and `lift` high, landing there scripted. */
async function leapTo(d, to, ms, lift, ctx) {
    d.b.mode = "scripted";
    const x0 = d.b.x, y0 = d.b.y;
    await d._play(ROAM("fall"), ctx, { loop: true });
    await d._tween(ms, (s) => {
        const p = to();
        d.b.x = x0 + (p.x - x0) * s;
        d.b.y = y0 + (p.y - y0) * s - Math.sin(s * Math.PI) * lift;
    });
    d._check(ctx);
}

// ── the Rexmaw ───────────────────────────────────────────────────────────

/** The sea comes up over the bottom of the screen and the Rexmaw sails
 *  in under full canvas. They jump aboard, the guns fire a salute, and
 *  off they sail; a while later they parachute back in. */
async function rexmawSails(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const sea = this.fx.sea();
    this.onEnd(() => sea.stop());
    this._face(0);
    await sea.rise(this.body * 0.32, 1800);
    say(this, _t("a ship…?"));
    await this._play(LIB("LookAround"), ctx, { maxMs: 2500 });
    const shipW = Math.min(width * 0.7, this.body * 3.4);
    const ship = this.fx.rexmaw(shipW);
    this.onEnd(() => ship.fade(400));
    const t0 = performance.now();
    let shipX = width + shipW * 0.6;
    const bob = () => {
        const t = (performance.now() - t0) / 1000;
        ship.moveTo(shipX, sea.surface + Math.sin(t * 1.3) * this.body * 0.02, Math.sin(t * 0.9) * 1.6);
    };
    const sailing = everyFrame(this, bob);
    this.onEnd(sailing);
    // Heave to with the deck between the masts beside them.
    const deckU = 165;
    bob();
    const off = ship.deck(deckU).x - shipX;
    const stopX = clamp(this.b.x + this.body * 0.9 - off, shipW * 0.45, width + shipW * 0.2);
    const x1 = shipX;
    this.fx.comic(_t("AHOY!"), width * 0.75, this.world.area.height * 0.25, { size: 48, color: "#fde68a" });
    await this._tween(4200, (s) => { shipX = x1 + (stopX - x1) * (1 - (1 - s) ** 3); });
    this._check(ctx);
    // Aboard.
    this._face(1);
    await leapTo(this, () => ship.deck(deckU), 750, this.body * 0.5, ctx);
    const aboard = everyFrame(this, () => { const p = ship.deck(deckU); this.b.x = p.x; this.b.y = p.y; });
    this.onEnd(aboard);
    await this._play(ROAM("land"), ctx);
    this._face(0);
    say(this, _t("all aboard!"));
    await this._play(LIB("Wave"), ctx, { maxMs: 2500 });
    // A salute from the guns.
    for (const i of [0, 2, 4]) {
        const p = ship.port(i);
        this.fx.puff(p.x - this.body * 0.08, p.y, this.body * 0.22);
        this.fx.puff(p.x - this.body * 0.16, p.y - 4, this.body * 0.16);
        this.fx.comic(_t("BOOM!"), p.x, p.y - this.body * 0.25, { size: 30, color: "#fde68a" });
        shake(this, 4);
        const splashX = p.x - this.body * rand(1.2, 2.2);
        this.fx.projectile("cannonball", p, { x: splashX, y: sea.surface }, { ms: 520, lift: this.body * 0.4 })
            .then(() => this.fx.bigSplash(splashX, sea.surface, this.body * 0.35)).catch(() => {});
        await this._wait(520, ctx);
    }
    this._play(LIB("VRMA_03_peace_sign"), ctx).catch(() => {});
    // Off she goes, bow first, and them with her.
    const x2 = shipX;
    await this._tween(4500, (s) => { shipX = x2 - (x2 + shipW * 0.7) * s * s; });
    this._check(ctx);
    aboard();
    sailing();
    ship.remove();
    this.host.style.opacity = "0";
    await sea.drain(1500);
    await this._wait(1500, ctx);
    await this.parachuteDown(rand(width * 0.2, width * 0.8), ctx);
}

// ── the Kraken ───────────────────────────────────────────────────────────

/** The Kraken: a rumble, the sea, tentacles up out of it — two grab a
 *  window's top edge, two wave about. They punch one, get swatted by
 *  another, and see it off with a potato in the eye. */
async function krakenAttack(ctx) {
    if (!this.onFloor) return;
    const { width, height } = this.world.area;
    const sea = this.fx.sea();
    this.onEnd(() => sea.stop());
    for (let i = 0; i < 3; i++) { shake(this, 6); await this._wait(500, ctx); }
    say(this, _t("…what was that?"));
    await sea.rise(this.body * 0.24, 1200);
    const below = height + this.body * 0.5;
    const win = this.world.ledges(this.body * 0.5)
        .filter((l) => l.y > height * 0.12 && l.x1 - l.x0 > this.body * 1.4)
        .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
    const tw = this.body * 0.2;
    const arms = [];
    const arm = (base, target, curl) => {
        const a = { t: this.fx.tentacle(tw), base, tip: { ...target }, target, curl, amp: 16, reach: 0 };
        arms.push(a);
        return a;
    };
    if (win) {
        const span = win.x1 - win.x0;
        arm({ x: win.x0 + span * 0.15, y: below }, { x: win.x0 + span * 0.3, y: win.y }, -1);
        arm({ x: win.x1 - span * 0.15, y: below }, { x: win.x1 - span * 0.3, y: win.y }, 1);
    }
    const side = this.b.x < width / 2 ? 1 : -1;
    const waverA = arm({ x: this.b.x + side * this.body * 1.1, y: below }, { x: this.b.x + side * this.body * 0.9, y: height - this.body * 1.4 }, 0);
    const waverB = arm({ x: this.b.x - side * this.body * 1.3, y: below }, { x: this.b.x - side * this.body * 1.0, y: height - this.body * 1.6 }, 0);
    const t0 = performance.now();
    const writhe = everyFrame(this, () => {
        const t = (performance.now() - t0) / 1000;
        for (const a of arms) {
            const strain = a.curl ? Math.sin(t * 17 + a.base.x) * 2.5 : 0;
            const sway = a.curl ? 0 : Math.sin(t * 1.4 + a.base.x * 0.01) * this.body * 0.25;
            a.tip.x += (a.target.x + sway - a.tip.x) * 0.12;
            a.tip.y += (a.target.y + strain - a.tip.y) * 0.12;
            a.amp += (16 - a.amp) * 0.04;
            a.t.set(a.base, a.tip, a.reach, t, { curl: a.curl, amp: a.amp });
        }
    });
    this.onEnd(() => { writhe(); arms.forEach((a) => a.t.stop()); });
    await this._tween(2400, (s) => arms.forEach((a) => { a.reach = s * (2 - s); }));
    this.fx.comic(_t("KRAKEN!"), width / 2, height * 0.22, { size: 72, color: "#c4b5fd", ms: 1800 });
    await this._play(LIB("Surprised"), ctx, { maxMs: 1800 });
    // Up to the nearest one, and punch it.
    await this._walkTo(waverA.base.x - side * this.body * 0.55, ctx, { rate: 1.4 });
    this._face(side);
    for (let i = 0; i < 2; i++) {
        const swing = this._play(ROAM("punch"), ctx).catch(() => {});
        await this._wait(300, ctx);
        const p = bonePage(this, "rightHand") || headPage(this);
        this.fx.comic(_t("POW!"), p.x + side * 20, p.y, { size: 44 });
        waverA.tip.x += side * this.body * 0.5;
        waverA.amp = 40;
        await swing;
    }
    // Swatted.
    const target = headPage(this);
    waverB.target = { x: target.x, y: target.y };
    await this._wait(420, ctx);
    say(this, _t("whoa!"), 1000);
    await dropDown(this, ctx, { vx: side * 3.2 * this.m.pxPerM, vy: -4 * this.m.pxPerM });
    waverB.target = { x: waverB.base.x + side * this.body * 0.2, y: height - this.body * 1.5 };
    await this._play(ROAM("land"), ctx);
    const h = headPage(this);
    this.fx.stars(h.x, h.y);
    // The eye comes up for a look: a potato in it.
    const eye = this.fx.krakenEye(this.body * 1.1);
    this.onEnd(() => eye.fade(400));
    const ex = clamp(width / 2, this.body, width - this.body), eBottom = sea.surface + this.body * 0.12;
    await this._tween(1200, (s) => eye.moveTo(ex, eBottom - eye.h * 0.5 * s * (2 - s) + eye.h * 0.5 * (1 - s)));
    eye.blink();
    await this._walkTo(clamp(ex - side * this.body * 1.6, this.body * 0.4, width - this.body * 0.4), ctx);
    this._face(ex - this.b.x);
    const gun = await this.prop("spudgun");
    await this._play(ROAM("aim"), ctx, { loop: true });
    await this._wait(800, ctx);
    const mz = gun?.pointPx("muzzle");
    const from = mz ? { x: this.box.left + mz.x, y: this.box.top + mz.y } : headPage(this);
    const aim = { x: ex, y: eBottom - eye.h * 0.38 };
    this.fx.puff(from.x, from.y, this.body * 0.14);
    await this.fx.projectile("potato", from, aim, { ms: 600, lift: 60 });
    this._check(ctx);
    this.fx.splat(aim.x, aim.y, this.body * 0.35);
    this.fx.comic(_t("SPLAT!"), aim.x, aim.y - this.body * 0.3, { size: 46 });
    eye.squint(true);
    await this._wait(700, ctx);
    // Off it goes, in a cloud of ink.
    for (const a of arms) this.fx.ink(a.base.x, sea.surface, this.body * 0.5);
    await Promise.all([
        this._tween(1300, (s) => arms.forEach((a) => { a.reach = 1 - s; })),
        this._tween(1100, (s) => eye.moveTo(ex, eBottom - eye.h * 0.5 + eye.h * s)),
    ]);
    writhe();
    arms.forEach((a) => a.t.stop());
    eye.remove();
    this._rest();
    await sea.drain(1300);
    this._face(0);
    say(this, _t("and STAY out!"));
    await this._play(LIB("VRMA_03_peace_sign"), ctx, { maxMs: 2500 });
}

// ── the treasure map ─────────────────────────────────────────────────────

/** A treasure map of this very screen unrolls — its windows sketched in,
 *  a dotted way to an X. They follow it, leaving a trail, dig where it
 *  says, and up comes a chest of doubloons. */
async function treasureHunt(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const pad = this.body * 0.9;
    const far = this.b.x < width / 2 ? rand(width * 0.62, width - pad) : rand(pad, width * 0.38);
    const toCentre = far < width / 2 ? 1 : -1;
    const spot = far + toCentre * this.body * 0.45;
    const map = this.fx.treasureMap(this.world.windows, { x: this.b.x, y: floorY - this.body * 0.2 }, { x: spot, y: floorY - 8 });
    let rolled = false;
    this.onEnd(() => { if (!rolled) map.roll(); });
    this._face(0);
    this.r.lookAtPoint?.({ x: map.rect.x + map.rect.width / 2, y: map.rect.y + map.rect.height / 2 }, 4500);
    say(this, _t("a treasure map!"));
    await this._play(LIB("Thinking"), ctx, { maxMs: 2600 });
    await this._wait(1600, ctx);
    rolled = true;
    await map.roll();
    say(this, _t("X marks the spot!"));
    const trail = this.fx.trail(this.b.x, floorY);
    this.onEnd(() => trail.fade());
    const draw = everyFrame(this, () => trail.to(this.b.x));
    await this._walkTo(far, ctx, { rate: 1.35 });
    draw();
    this._face(toCentre);
    await this.fx.doodle({ kind: "x", x: spot, y: floorY - this.body * 0.06, size: this.body * 0.18, ink: "#dc2626", tilt: false, drawMs: 500, lifeMs: 14000 });
    const shovel = await this.prop("shovel");
    await this._play(ROAM("dig"), ctx, { loop: true });
    const mound = this.fx.mound(spot, floorY, this.body * 0.5);
    this.onEnd(() => mound.fade(400));
    for (let i = 0; i < 7; i++) {
        await this._wait(420, ctx);
        this.fx.dirt(spot, floorY - 6);
    }
    this._rest();
    shovel?.hide();
    this.fx.comic(_t("CLUNK!"), spot, floorY - this.body * 0.4, { size: 30, color: "#fde68a" });
    mound.fade(500);
    const chest = this.fx.chest(spot, floorY, this.body * 0.42);
    this.onEnd(() => chest.remove());
    await this._wait(1200, ctx);
    this._face(0);
    const glow = chest.open();
    this.onEnd(() => glow.stop());
    this.fx.coins(spot, floorY - this.body * 0.3, floorY, 30);
    const n = 100 + Math.floor(Math.random() * 400);
    this.fx.comic(_t("+%s doubloons!", n), spot, floorY - this.body * 0.75, { size: 34, color: "#facc15", ms: 2600 });
    await this._play(LIB("Jump"), ctx);
    say(this, _t("the books balance!"), 2000);
    this.fx.hearts(headPage(this).x, headPage(this).y - this.body * 0.1);
    await this._play(LIB("Clapping"), ctx);
    await this._wait(1500, ctx);
    glow.stop();
    await chest.sink();
}

// ── Gerald ───────────────────────────────────────────────────────────────

/** Gerald the megalodon: the sea comes up round their knees, a fin
 *  circles, closer each pass — then Gerald leaps right over them and
 *  swallows them whole, and a moment later spits them back out. */
async function geraldShark(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const sea = this.fx.sea();
    this.onEnd(() => sea.stop());
    await sea.rise(this.body * 0.4, 1600);
    const fin = this.fx.fin(this.body * 0.26);
    this.onEnd(() => fin.fade(300));
    const finY = () => sea.surface - fin.h * 0.32;
    for (let pass = 0; pass < 3; pass++) {
        const span = this.body * (2.6 - pass * 0.7);
        const dir = pass % 2 ? -1 : 1;
        const xa = this.b.x - dir * span, xb = this.b.x + dir * span;
        const t0 = performance.now();
        await this._tween(2400 - pass * 400, (s) => {
            const x = xa + (xb - xa) * s;
            // The fin is drawn swept back to the right (swimming left).
            fin.moveTo(x, finY() + Math.sin((performance.now() - t0) / 180) * 2, 0, -dir, 1);
            this.r.roamFace(Math.sign(x - this.b.x) * 0.9);
        });
        this._check(ctx);
        if (pass === 0) say(this, _t("uh oh…"));
        if (pass === 1) this._play(LIB("Surprised"), ctx, { maxMs: 1200 }).catch(() => {});
    }
    fin.fade(300);
    this.r.roamFace(0);
    await this._wait(900, ctx);
    // The leap: up behind them, over, and down the other side.
    const shark = this.fx.gerald(this.body * 1.5);
    this.onEnd(() => shark.fade(300));
    const dir = Math.random() < 0.5 ? 1 : -1;
    const xa = this.b.x - dir * this.body * 1.4, xb = this.b.x + dir * this.body * 1.4;
    const top = headPage(this).y - this.body * 0.15, low = sea.surface + this.body * 0.2;
    shark.mouth(true);
    let gulped = false;
    await this._tween(1300, (s) => {
        const x = xa + (xb - xa) * s, y = low - Math.sin(s * Math.PI) * (low - top);
        const slope = -Math.cos(s * Math.PI) * Math.PI * (low - top) / (xb - xa);
        shark.moveTo(x, y, Math.atan(slope) * 180 / Math.PI, dir, 1);
        if (!gulped && s > 0.5) {
            gulped = true;
            this.host.style.opacity = "0";
            shark.mouth(false);
            this.fx.comic(_t("CHOMP!"), this.b.x, top - this.body * 0.2, { size: 60, color: "#f8fafc" });
            shake(this, 6);
        }
    });
    this.fx.bigSplash(xb, sea.surface, this.body * 0.6);
    shark.moveTo(-9999, -9999);
    this.onEnd(() => { this.host.style.opacity = ""; });
    await this._wait(1600, ctx);
    // Back up, nose first — PTOOEY.
    const sx = clamp(this.b.x + dir * this.body * 0.6, this.body, width - this.body);
    await this._tween(500, (s) => shark.moveTo(sx, sea.surface + this.body * 0.3 - s * this.body * 0.45, -dir * 28, dir, 1));
    shark.mouth(true);
    const jaw = shark.jaw();
    this.fx.comic(_t("PTOOEY!"), jaw.x, jaw.y - this.body * 0.3, { size: 50, color: "#bbf7d0" });
    this.b.mode = "scripted";
    this.b.x = jaw.x;
    this.b.y = jaw.y + this.body * 0.3;
    this.host.style.opacity = "";
    this.scale = 1;
    const landing = dropDown(this, ctx, { vx: dir * 2.4 * this.m.pxPerM, vy: -4.8 * this.m.pxPerM });
    await this._wait(400, ctx);
    shark.wink(true);
    await this._wait(500, ctx);
    shark.mouth(false);
    await this._tween(900, (s) => shark.moveTo(sx, sea.surface - this.body * 0.15 + s * this.body * 0.8, -dir * 28 * (1 - s), dir, 1));
    shark.remove();
    await landing;
    await this._play(ROAM("land"), ctx);
    const h = headPage(this);
    this.fx.stars(h.x, h.y);
    say(this, _t("…thanks, Gerald?"), 2000);
    await sea.drain(1400);
    await this._play(LIB("Thinking"), ctx, { maxMs: 2000 });
}

// ── the sky whale ────────────────────────────────────────────────────────

/** The sky whale: swimming through the air along the top of the screen,
 *  a loop-the-loop, then a belly-flop onto the floor — a wave that knocks
 *  them over, and treasure raining down. */
async function skyWhale(ctx) {
    if (!ground(this)) return;
    const { width, height } = this.world.area;
    const floorY = this.world.floor().y;
    const w = Math.min(width * 0.42, this.body * 3.4);
    const whale = this.fx.whale(w);
    this.onEnd(() => whale.fade(400));
    const dir = Math.random() < 0.5 ? 1 : -1;
    const sx = dir;   // drawn facing right
    this._face(0);
    this.r.lookAtPoint?.({ x: width / 2, y: 0 }, 6000);
    say(this, _t("whoa…"), 1800);
    // In along the top.
    const x0 = dir > 0 ? -w * 0.7 : width + w * 0.7;
    const cx = width / 2 - dir * w * 0.15, cy = height * 0.16, R = height * 0.15;
    const t0 = performance.now();
    await this._tween(3800, (s) => {
        const t = (performance.now() - t0) / 1000;
        whale.moveTo(x0 + (cx - x0) * s, cy + Math.sin(t * 1.6) * 10, Math.sin(t * 1.6) * 4, sx, 1);
    });
    this._check(ctx);
    // A loop-the-loop.
    await this._tween(2600, (s) => {
        const a = s * Math.PI * 2;
        whale.moveTo(cx + dir * R * Math.sin(a), cy + R - R * Math.cos(a), -dir * (a * 180 / Math.PI), sx, 1);
    });
    this._check(ctx);
    // The belly-flop, right beside them.
    const hitX = clamp(this.b.x + dir * this.body * 1.2, w * 0.4, width - w * 0.4);
    const hitY = floorY - whale.h * 0.32;
    await this._tween(1100, (s) => {
        const e = s * s;
        whale.moveTo(cx + (hitX - cx) * s, cy + (hitY - cy) * e, dir * 18 * (1 - s), sx, 1);
    });
    this._check(ctx);
    whale.moveTo(hitX, hitY + whale.h * 0.06, 0, sx * 1.08, 0.82);
    shake(this, 14);
    this.fx.bigSplash(hitX, floorY - 10, w * 0.6);
    this.fx.comic(_t("SPLOOSH!"), hitX, floorY - whale.h * 1.1, { size: 64, color: "#bfdbfe" });
    const sea = this.fx.sea();
    this.onEnd(() => sea.stop());
    sea.rise(this.body * 0.5, 260).then(() => sea.drain(1600)).catch(() => {});
    this.fx.coins(hitX, 0, floorY, 34, { rain: true, spread: width * 0.35 });
    let knocked = null;
    if (this.onFloor) knocked = dropDown(this, ctx, { vx: Math.sign(this.b.x - hitX || 1) * 3 * this.m.pxPerM, vy: -3.2 * this.m.pxPerM });
    await this._wait(250, ctx);
    whale.moveTo(hitX, hitY, 0, sx, 1);
    // A spout of joy, and away up into the sky.
    for (let i = 0; i < 4; i++) {
        const p = whale.spout();
        this.fx.splash(p.x, p.y);
        await this._wait(140, ctx);
    }
    const x1 = dir > 0 ? width + w : -w;
    const fly = this._tween(2600, (s) => whale.moveTo(hitX + (x1 - hitX) * s, hitY - (hitY + w * 0.5) * s * (2 - s), -dir * 20, sx, 1));
    if (knocked) { await knocked; await this._play(ROAM("land"), ctx); }
    await fly;
    whale.remove();
    this._face(0);
    say(this, _t("best day ever!"), 2000);
    this.fx.hearts(headPage(this).x, headPage(this).y - this.body * 0.1);
    await this._play(LIB("Jump"), ctx);
}

// ── the crew drop by ─────────────────────────────────────────────────────

const SAL_LINES = [
    "Do you suppose the desktop dreams of us?",
    "Ribbit. Or is it?",
    "Every window is a pond, if you sit by it long enough.",
];
const REX_LINES = [
    "Captain! The books balance.",
    "All hands accounted for, Captain!",
    "Snip snip. Carry on, Captain.",
];

/** One of the crew drops by: Sal the frog hops over to share a thought,
 *  Rex scuttles in to report, or the Seagull Admiral lands on their head. */
async function crewCameo(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const kind = pick(["frog", "lobster", "gull"]);
    const fromLeft = this.b.x > width / 2;
    const edge = fromLeft ? -this.body * 0.5 : width + this.body * 0.5;
    const beside = this.b.x + (fromLeft ? -1 : 1) * this.body * 0.6;
    const towards = fromLeft ? 1 : -1;
    if (kind === "frog") {
        const w = this.body * 0.3;
        const sal = this.fx.crewmate("frog", w);
        this.onEnd(() => sal.fade(300));
        // Facing the way he hops (in, then out again).
        let facing = towards;
        const at = (x, lift = 0, sq = 1) => sal.moveTo(x, floorY - sal.h / 2 - lift + sal.h * (1 - sq) / 2, 0, facing, sq);
        // Three hops in.
        let x = edge;
        for (let i = 1; i <= 3; i++) {
            const nx = edge + (beside - edge) * (i / 3);
            const fx0 = x;
            await this._tween(480, (s) => at(fx0 + (nx - fx0) * s, Math.sin(s * Math.PI) * this.body * 0.28, 1 + 0.1 * Math.sin(s * Math.PI)));
            await this._tween(140, (s) => at(nx, 0, 1 - 0.18 * Math.sin(s * Math.PI)));
            x = nx;
        }
        this._check(ctx);
        this._face(-towards);
        this.fx.say(_t(pick(SAL_LINES)), x, floorY - sal.h * 1.1, 3200);
        await this._play(LIB("Thinking"), ctx, { maxMs: 3000 });
        say(this, _t("deep, Sal."));
        await this._wait(1500, ctx);
        facing = -towards;
        for (let i = 1; i <= 3; i++) {
            const nx = x + (edge - beside) * (1 / 3);
            const fx0 = x;
            await this._tween(480, (s) => at(fx0 + (nx - fx0) * s, Math.sin(s * Math.PI) * this.body * 0.28));
            x = nx;
        }
        sal.remove();
    } else if (kind === "lobster") {
        const w = this.body * 0.34;
        const rex = this.fx.crewmate("lobster", w);
        this.onEnd(() => rex.fade(300));
        const t0 = performance.now();
        const at = (x) => rex.moveTo(x, floorY - rex.h / 2 + Math.abs(Math.sin((performance.now() - t0) / 60)) * -3, Math.sin((performance.now() - t0) / 60) * 4);
        await this._tween(1600, (s) => at(edge + (beside - edge) * s));
        this._check(ctx);
        rex.set("is-snip", true);
        this._face(-towards);
        this.fx.say(_t(pick(REX_LINES)), beside, floorY - rex.h * 1.1, 2800);
        await this._play(LIB("VRMA_02_greeting"), ctx, { maxMs: 2500 });
        say(this, _t("thanks, Rex!"));
        await this._wait(1300, ctx);
        rex.set("is-snip", false);
        await this._tween(1400, (s) => at(beside + (edge - beside) * s));
        rex.remove();
    } else {
        const w = this.body * 0.32;
        const gull = this.fx.crewmate("gull", w);
        this.onEnd(() => gull.fade(300));
        gull.set("is-flying", true);
        const start = { x: fromLeft ? -w : width + w, y: -w };
        const perch = () => { const c = headPage(this); return { x: c.x, y: c.y - 0.17 * this.m.pxPerM - gull.h * 0.38 }; };
        await this._tween(1800, (s) => {
            const p = perch();
            gull.moveTo(start.x + (p.x - start.x) * s, start.y + (p.y - start.y) * s - Math.sin(s * Math.PI) * w, 0, towards, 1);
        });
        this._check(ctx);
        gull.set("is-flying", false);
        const sit = everyFrame(this, () => { const p = perch(); gull.moveTo(p.x, p.y, 0, towards, 1); });
        this.onEnd(sit);
        this.fx.comic(_t("SQUAWK!"), perch().x, perch().y - w * 0.6, { size: 30, color: "#f8fafc" });
        this.r.lookAtPoint?.({ x: this.b.x, y: 0 }, 2500);
        await this._play(LIB("Surprised"), ctx, { maxMs: 1600 });
        await this._wait(1200, ctx);
        say(this, _t("…Admiral?"), 1500);
        await this._wait(1600, ctx);
        sit();
        gull.set("is-flying", true);
        const from = perch();
        this.fx.fling("🪶", { x: from.x, y: from.y + gull.h * 0.3 }, { x: from.x + towards * 40, y: this.b.y - 10 }, { ms: 1800, spin: 1, size: 22, lift: -20 }).catch(() => {});
        // Turned round to fly back the way it came, beak first, nose up.
        await this._tween(1500, (s) => gull.moveTo(from.x - towards * width * 0.6 * s, from.y - this.body * 1.6 * s, towards * 10, -towards, 1));
        gull.remove();
        await this._play(LIB("Wave"), ctx, { maxMs: 2200 });
    }
}

export function installRexclawGags(proto) {
    Object.assign(proto, { rexmawSails, krakenAttack, treasureHunt, geraldShark, skyWhale, crewCameo });
}

// The crew's world: rare, long, the big moments.
export const REXCLAW_GAG_ACTIONS = [
    { id: "rexmaw_ship", group: "rexclaw", weight: 1, cooldown: 1200, when: (d) => d.onFloor, run: rexmawSails },
    { id: "kraken", group: "rexclaw", weight: 1.5, cooldown: 1500, when: (d) => d.onFloor, run: krakenAttack },
    { id: "treasure_map", group: "rexclaw", weight: 2.5, cooldown: 900, when: (d) => d.onFloor, run: treasureHunt },
    { id: "gerald_megalodon", group: "rexclaw", weight: 1.5, cooldown: 1500, when: (d) => d.onFloor, run: geraldShark },
    { id: "sky_whale", group: "rexclaw", weight: 1, cooldown: 1800, when: ground, run: skyWhale },
    { id: "crew_cameo", group: "rexclaw", weight: 3, cooldown: 600, when: (d) => d.onFloor, run: crewCameo },
];
