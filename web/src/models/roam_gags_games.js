// Game references for roam mode (models/roam_director.js): an old school
// MMO and a blocky sandbox, played out on the desktop. Same shape as the
// other gag files (methods of the director, one table of actions); the
// drawings are models/roam_fx_games.js, all made here.
//
// The old school: chopping a tree to a level-up that turns out to be half
// way, the three random events that turn up while they mind their own
// business (the evil chicken, the genie and his lamp, the sandwich lady),
// and a party hat out of a cracker. The sandbox: a creeper with opinions
// about the desktop, digging straight down, and a tall dark thing moving
// the furniture.
//
// What's quoted is short and is the joke: a message the game prints, or
// what players type at each other. The timings that have a source say so.
// Neither game is named anywhere the user sees, the action ids included.

import { _t } from "../lib/i18n";
import {
    ROAM, LIB, rand, pick, clamp, bonePage, headPage, everyFrame, dropDown, ground,
} from "./roam_gags";
import { christmasTime } from "./roam_seasons";
import { blockTexture } from "./roam_fx_games";

// The old school game's clock: everything in it happens on a 0.6 s tick.
const TICK = 600;
// Experience for a level, by the game's own sum: a quarter of the total of
// ⌊l + 300 · 2^(l/7)⌋ over the levels below it. 99 comes to 13,034,431 and
// 92 to 6,517,253: half way, seven levels from the end.
function xpFor(level) {
    let points = 0;
    for (let l = 1; l < level; l++) points += Math.floor(l + 300 * 2 ** (l / 7));
    return Math.floor(points / 4);
}
// The most coins one stack holds: a signed 32-bit integer's worth.
const MAX_CASH = 2 ** 31 - 1;
const HAT_COLOURS = ["#2563eb", "#dc2626", "#facc15", "#16a34a", "#9333ea", "#f8fafc"];

// The sandbox. Breaking by hand takes 1.5 s per point of a block's
// hardness: dirt's 0.5 makes 0.75 s. A creeper's fuse is 30 game ticks,
// 1.5 s, and it sets off within 3 blocks.
const BREAK_DIRT_MS = 750;
const FUSE_MS = 1500;
// A block's side: half a body (a player is 1.8 blocks tall), but never
// more than a tenth of the screen.
const blockSize = (d) => Math.min(d.body * 0.5, d.world.area.height * 0.1);

function say(d, text, ms = 1600) {
    const h = headPage(d);
    d.fx.say(text, h.x, h.y - d.body * 0.14, ms);
}

function shake(d, px) {
    d.root.animate([{ transform: "translate(0,0)" }, { transform: `translate(${px * (Math.random() - 0.5)}px, ${px * 0.6}px)` },
        { transform: `translate(${-px * 0.4}px, ${-px * 0.3}px)` }, { transform: "translate(0,0)" }], { duration: 380 });
}

const myName = (d) => (d.agentName || "").trim() || _t("adventurer");

/** Words over their own head, the old school way, following it. */
function shout(d, text, effects = [], ms = 3000) {
    const h = headPage(d);
    const o = d.fx.overhead(text, h.x, h.y - d.body * 0.2, { effects, ms });
    const follow = everyFrame(d, () => { const p = headPage(d); o.moveTo(p.x, p.y - d.body * 0.2); });
    setTimeout(follow, ms + 300);
    d.onEnd(() => { follow(); o.remove(); });
    return o;
}

/** A piece of the screen (`rect`, page px) as a data URL off a fresh
 *  capture (null without one). */
async function screenPiece(d, rect) {
    if (!d.tricks || !d.bridge?.roamCapture) return null;
    const cap = await d.bridge.roamCapture().catch(() => null);
    if (!cap) return null;
    const img = new Image();
    img.src = cap.dataUrl;
    try { await img.decode(); } catch (e) { return null; }
    const sx = cap.width / cap.frame.width, sy = cap.height / cap.frame.height;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(rect.width));
    c.height = Math.max(1, Math.round(rect.height));
    c.getContext("2d").drawImage(img, (rect.x - cap.frame.x) * sx, (rect.y - cap.frame.y) * sy, rect.width * sx, rect.height * sy,
        0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
}

/** A figure walking along the floor from x0 to x1 at `speed` px/s, with a
 *  little bob. */
async function trot(d, fig, x0, x1, y, speed, ctx, { hop = 3 } = {}) {
    const dir = Math.sign(x1 - x0) || 1;
    const t0 = performance.now();
    await d._tween(Math.abs(x1 - x0) / speed * 1000, (s) => {
        fig.moveTo(x0 + (x1 - x0) * s, y - Math.abs(Math.sin((performance.now() - t0) / 110)) * hop, dir);
    });
    d._check(ctx);
}

// ── the old school ───────────────────────────────────────────────────────

/** Woodcutting. Fists first (no), then the axe, a swing a time until the
 *  tree is a stump and a nest lands on them; a level, fireworks — and the
 *  sums: 92 is half of 99. */
async function chopTree(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const h = Math.min(this.body * 1.3, this.world.area.height * 0.5);
    const side = this.b.x < width / 2 ? 1 : -1;
    const tx = clamp(this.b.x + side * this.body * 1.5, this.body * 0.8, width - this.body * 0.8);
    const tree = this.fx.figure("tree", h, { under: true });
    tree.moveTo(tx, floorY);
    tree.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
    let standing = tree;
    this.onEnd(() => standing.fade(500));
    const chat = this.fx.chatBox();
    this.onEnd(() => chat.remove());
    await this._walkTo(tx - side * this.body * 0.45, ctx);
    this._face(side);
    // It works in the other game.
    await this._play(ROAM("punch"), ctx, { maxMs: 1200 });
    chat.line(_t("You need an axe to chop down this tree."));
    this._face(0);
    await this._play(LIB("Thinking"), ctx, { maxMs: 2000 });
    this._face(side);
    const axe = await this.prop("hatchet");
    chat.line(_t("You swing your axe at the tree."));
    const hit = { x: tx - side * h * 0.06, y: floorY - h * 0.22 };
    for (let i = 0; i < 4; i++) {
        const swing = this._play(ROAM("throw"), ctx).catch(() => {});
        await this._wait(500, ctx);
        tree.el.querySelector(".top")?.animate([{ transform: "translateX(0)" }, { transform: `translateX(${side * 5}px)` }, { transform: "translateX(0)" }], { duration: 220 });
        this.fx.crumbs(hit.x, hit.y, "#8b5a2b", 5);
        if (i > 0) {
            chat.line(_t("You get some logs."));
            this.fx.xpDrop(_t("+%s xp", 25), tx, floorY - h * 0.75);
        }
        await swing;
        await this._wait(TICK, ctx);
    }
    // Felled: a stump, and what was living in it.
    const stump = this.fx.figure("stump", h, { under: true });
    stump.moveTo(tx, floorY);
    standing = stump;
    tree.fade(250);
    axe?.hide();
    this._rest();
    this._face(0);
    const nest = this.fx.figure("nest", this.body * 0.12);
    this.onEnd(() => nest.fade(300));
    const top = headPage(this);
    const from = { x: tx, y: floorY - h * 0.8 };
    await this._tween(520, (s) => nest.moveTo(from.x + (top.x - from.x) * s, from.y + (top.y - this.body * 0.07 - from.y) * s * s, 1, s * 200));
    this._check(ctx);
    chat.line(_t("A bird's nest falls out of the tree."));
    this.fx.stars(top.x, top.y - this.body * 0.1);
    const wear = everyFrame(this, () => { const p = headPage(this); nest.moveTo(p.x, p.y - this.body * 0.07); });
    this.onEnd(wear);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
    // The level.
    for (let i = 0; i < 4; i++) {
        this.fx.firework(this.b.x + rand(-1, 1) * this.body * 0.6, top.y - this.body * rand(0.1, 0.6), floorY);
    }
    chat.line(_t("Congratulations, you just advanced a Woodcutting level."), "level");
    chat.line(_t("Your Woodcutting level is now %s.", 92), "level");
    await this._play(LIB("Jump"), ctx);
    say(this, _t("92! nearly there!"));
    await this._play(LIB("Clapping"), ctx, { maxMs: 2600 });
    await this._wait(600, ctx);
    chat.line(_t("%s of %s xp: 92 is half of 99.", xpFor(92).toLocaleString("en-US"), xpFor(99).toLocaleString("en-US")), "bad");
    this.r.setEmotion?.("sad", { explicit: false });
    await this._play(LIB("Sad"), ctx, { maxMs: 3500 });
    say(this, _t("…half."), 1800);
    await this._wait(2000, ctx);
}

/** A random event, the evil chicken: out of a puff of smoke, a few pecks
 *  that hardly count and one that does. A gravestone, and a walk back to
 *  it. */
async function evilChicken(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const chat = this.fx.chatBox();
    this.onEnd(() => chat.remove());
    const dir = this.b.x < width / 2 ? 1 : -1;
    const h = this.body * 0.4;
    const cx = this.b.x + dir * this.body * 0.8;
    this.fx.puff(cx, floorY - h / 2, h * 1.6);
    const hen = this.fx.figure("chicken", h);
    this.onEnd(() => hen.fade(300));
    hen.moveTo(cx, floorY, -dir);
    this._face(dir);
    const cluck = (text, effects = [], ms = 1800) => this.fx.overhead(text, hen.x, floorY - h * 1.25, { effects, ms });
    cluck("Bwuk bwuk bwuk!");
    await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
    say(this, _t("it's a chicken?"));
    const peck = async (n, size) => {
        await this._tween(200, (s) => hen.moveTo(cx - dir * this.body * 0.3 * Math.sin(Math.PI * s), floorY - Math.sin(Math.PI * s) * h * 0.3, -dir));
        const chest = bonePage(this, "chest") || bonePage(this, "hips") || headPage(this);
        this.fx.hitsplat(n, chest.x, chest.y, size);
    };
    for (const n of [1, 0, 2]) {
        await peck(n, this.body * 0.16);
        await this._wait(TICK * 2 - 200, ctx);
    }
    cluck(_t("Flee from me, %s!", myName(this)), ["shake"], 2000);
    await this._wait(TICK * 2, ctx);
    await peck(99, this.body * 0.26);
    shake(this, 10);
    chat.line(_t("Oh dear, you are dead!"));
    const spot = this.b.x;
    await this._play(ROAM("sleep"), ctx, { loop: true });
    await this._wait(1300, ctx);
    await this._tween(500, (s) => { this.host.style.opacity = String(1 - s); });
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    const grave = this.fx.figure("grave", this.body * 0.3, { under: true });
    this.onEnd(() => grave.fade(600));
    grave.moveTo(spot, floorY);
    grave.el.animate([{ translate: "0 100%" }, { translate: "0 0" }], { duration: 400, easing: "ease-out" });
    cluck("Bwuk.", [], 1600);
    await this._wait(1200, ctx);
    await trot(this, hen, cx, dir > 0 ? width + h : -h, floorY, this.body * 0.9, ctx, { hop: 6 });
    hen.remove();
    // Back at the other side of the screen, and over to pay respects.
    this._rest();
    const back = spot < width / 2 ? rand(width * 0.65, width * 0.85) : rand(width * 0.15, width * 0.35);
    await this._appear(() => this._stand(this.world.floor(), back), ctx);
    await this._walkTo(spot + (back > spot ? 1 : -1) * this.body * 0.5, ctx);
    this._face(spot - this.b.x);
    say(this, _t("…it was a chicken."), 2000);
    await this._play(LIB("Thinking"), ctx, { maxMs: 2600 });
}

/** A random event, the genie: a lamp, a wish, and experience in the one
 *  skill they would pick. */
async function genieLamp(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const chat = this.fx.chatBox();
    this.onEnd(() => chat.remove());
    const dir = this.b.x < width / 2 ? 1 : -1;
    const h = this.body * 0.95;
    const gx = this.b.x + dir * this.body * 0.85;
    this.fx.puff(gx, floorY - h * 0.5, h);
    const genie = this.fx.figure("genie", h);
    this.onEnd(() => genie.fade(300));
    const t0 = performance.now();
    const hover = everyFrame(this, () => genie.moveTo(gx, floorY - this.body * 0.08 + Math.sin((performance.now() - t0) / 380) * 5, -dir));
    this.onEnd(hover);
    this._face(dir);
    this.fx.overhead(_t("Ah, so you are there, %s. Take this lamp and make your wish.", myName(this)), gx, floorY - h * 1.12, { ms: 3800 });
    await this._play(LIB("Surprised"), ctx, { maxMs: 1500 });
    await this._wait(2200, ctx);
    const lamp = this.fx.figure("lamp", this.body * 0.11);
    this.onEnd(() => lamp.fade(300));
    const hands = () => bonePage(this, "leftHand") || headPage(this);
    const from = { x: gx - dir * h * 0.3, y: floorY - h * 0.5 };
    await this._tween(600, (s) => {
        const to = hands();
        lamp.moveTo(from.x + (to.x - from.x) * s, from.y + (to.y + 8 - from.y) * s - Math.sin(Math.PI * s) * 30, dir);
    });
    this._check(ctx);
    hover();
    this.fx.puff(gx, floorY - h * 0.5, h);
    genie.remove();
    this._face(0);
    const hold = everyFrame(this, () => { const p = hands(); lamp.moveTo(p.x, p.y + 8, dir); });
    this.onEnd(hold);
    chat.line(_t("You rub the lamp…"));
    await this._play(ROAM("pat"), ctx, { loop: true });
    await this._wait(1400, ctx);
    const head = headPage(this);
    const skills = [_t("Agility"), _t("Runecraft"), _t("Napping"), _t("Cancel")];
    const menu = this.fx.optionMenu(skills, head.x + dir * this.body * 0.7, head.y - this.body * 0.1, _t("Choose a skill"));
    this.onEnd(() => menu.remove());
    for (const i of [0, 1, 0, 2]) {
        menu.choose(i);
        await this._wait(650, ctx);
    }
    await this._wait(500, ctx);
    menu.remove();
    hold();
    lamp.remove();
    this._rest();
    chat.line(_t("Your wish has been granted."), "level");
    chat.line(_t("You have been awarded %s Napping experience!", "500"), "level");
    this.fx.xpDrop(_t("+%s xp", 500), head.x, head.y - this.body * 0.2);
    this.r.setEmotion?.("relaxed", { explicit: false });
    await this._play(LIB("Yawning"), ctx);
    say(this, _t("worth it."));
    await this._wait(1500, ctx);
}

/** A random event, the sandwich lady. Ignored, she gets louder; the offer
 *  is a baguette, and what gets taken is the chocolate bar — so it's the
 *  baguette after all, round the head, and waking up somewhere else. */
async function sandwichLady(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const dir = this.b.x < width / 2 ? 1 : -1;
    const h = this.body * 0.95;
    const lx = this.b.x + dir * this.body * 0.85;
    // Busy, back turned.
    this._face(-dir);
    this._play(LIB("Relax"), ctx, { maxMs: 7000 }).catch(() => {});
    await this._wait(700, ctx);
    this.fx.puff(lx, floorY - h * 0.5, h);
    const lady = this.fx.figure("lady", h);
    this.onEnd(() => lady.fade(300));
    lady.moveTo(lx, floorY, -dir);
    const call = (text, effects = [], ms = 2400) => this.fx.overhead(text, lx, floorY - h * 1.1, { effects, ms });
    call(_t("Sandwiches, %s!", myName(this)), [], 2000);
    await this._wait(2200, ctx);
    call(_t("You think I made these just for fun?!!?"), ["shake"]);
    await this._wait(1500, ctx);
    this._rest();
    this._face(dir);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1400 });
    call(_t("You look hungry to me. I tell you what - have a baguette on me."), [], 3800);
    await this._wait(2000, ctx);
    const head = headPage(this);
    const tray = [_t("Baguette"), _t("Meat pie"), _t("Chocolate bar"), _t("Doughnut")];
    const menu = this.fx.optionMenu(tray, head.x - dir * this.body * 0.75, head.y - this.body * 0.1, _t("Take your pick"));
    this.onEnd(() => menu.remove());
    for (const i of [0, 1, 0, 2]) {
        menu.choose(i);
        await this._wait(650, ctx);
    }
    say(this, _t("ooh, chocolate."), 1500);
    await this._wait(900, ctx);
    menu.remove();
    call(_t("Hey, I didn't say you could have that!"), ["shake"], 2200);
    await this._wait(900, ctx);
    // The baguette, then.
    const bread = this.fx.figure("baguette", this.body * 0.09);
    this.onEnd(() => bread.fade(200));
    const from = { x: lx - dir * h * 0.25, y: floorY - h * 0.55 };
    const to = headPage(this);
    await this._tween(260, (s) => bread.moveTo(from.x + (to.x - from.x) * s, from.y + (to.y - from.y) * s - Math.sin(Math.PI * s) * this.body * 0.3,
        -dir, -dir * (70 - 150 * s)));
    this._check(ctx);
    this.fx.comic(_t("BONK!"), to.x, to.y - this.body * 0.2, { size: 38 });
    this.fx.stars(to.x, to.y);
    bread.fade(400);
    await this._play(ROAM("sleep"), ctx, { loop: true });
    await this._wait(1200, ctx);
    this.fx.puff(lx, floorY - h * 0.5, h);
    lady.remove();
    await this._tween(500, (s) => { this.host.style.opacity = String(1 - s); });
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    await this._wait(900, ctx);
    // Somewhere else entirely, still out cold.
    const elsewhere = this.b.x < width / 2 ? rand(width * 0.65, width * 0.88) : rand(width * 0.12, width * 0.35);
    await this._appear(() => this._stand(this.world.floor(), elsewhere), ctx);
    await this._wait(1600, ctx);
    this._rest();
    this._face(0);
    await this._play(LIB("LookAround"), ctx, { maxMs: 2400 });
    say(this, _t("…where am I?"), 2000);
    await this._play(LIB("Thinking"), ctx, { maxMs: 2400 });
}

/** A cracker pulled, a party hat in it: the most valuable hat there is,
 *  and at once everybody wants to borrow it. */
async function partyHat(ctx) {
    if (this.b.mode !== "ground") return;
    const { width } = this.world.area;
    this._face(0);
    const cracker = this.fx.figure("cracker", this.body * 0.1);
    this.onEnd(() => cracker.fade(200));
    const hands = () => {
        const l = bonePage(this, "leftHand"), r = bonePage(this, "rightHand");
        return l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 } : headPage(this);
    };
    await this._play(ROAM("carry"), ctx, { loop: true });
    const hold = everyFrame(this, () => { const p = hands(); cracker.moveTo(p.x, p.y + cracker.h / 2, 1); });
    this.onEnd(hold);
    await this._wait(1400, ctx);
    cracker.set("is-pulled", true);
    const at = hands();
    this.fx.comic(_t("SNAP!"), at.x, at.y - this.body * 0.2, { size: 34 });
    this.fx.confetti(at.x, at.y, 26);
    await this._wait(450, ctx);
    hold();
    cracker.fade(250);
    this._rest();
    const hat = await this.prop("partyhat");
    const colour = pick(HAT_COLOURS);
    hat?.obj.traverse((o) => o.material?.color?.set?.(colour));
    shout(this, _t("Hey! I got the cracker!"), [], 2600);
    await this._play(LIB("Jump"), ctx);
    const h = headPage(this);
    this.fx.comic(_t("+%s gp", MAX_CASH.toLocaleString("en-US")), h.x, h.y - this.body * 0.45, { size: 26, color: "#facc15", ms: 2600 });
    await this._play(LIB("VRMA_06_model_pose"), ctx, { maxMs: 3000 });
    // Word gets round.
    const asks = [["Buying phat 5gp", ["flash3", "wave"]], ["lend phat pls i give back", ["wave"]], ["Trimming phats free!!", ["glow1", "wave2"]]];
    const floorY = this.world.floor().y;
    for (let i = 0; i < asks.length; i++) {
        const x = clamp(this.b.x + (i % 2 ? 1 : -1) * this.body * (1.2 + i * 0.5), 150, width - 150);
        this.fx.overhead(asks[i][0], x, Math.min(floorY, this.b.y) - this.body * (0.5 + 0.25 * i), { effects: asks[i][1], ms: 3200 });
        await this._wait(700, ctx);
    }
    await this._play(LIB("LookAround"), ctx, { maxMs: 2400 });
    say(this, _t("mine."), 1600);
    await this._play(LIB("Angry"), ctx, { maxMs: 2400 });
    await this._wait(600, ctx);
}

// ── the sandbox ──────────────────────────────────────────────────────────

/** A creeper comes up behind them with a view on the desktop, and acts on
 *  it: a crater blown out of the screen in blocks (of the screen itself,
 *  with a capture), them blown clear, and the blocks put back. */
async function creeper(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const S = blockSize(this);
    const side = this.b.x < width / 2 ? 1 : -1;
    const cols = 6, rows = 4;
    // The crater starts just past their box, so they aren't in its picture.
    const x0 = side > 0 ? this.b.x + this.body * 0.68 : this.b.x - this.body * 0.68 - cols * S;
    const rect = { x: x0, y: floorY - rows * S, width: cols * S, height: rows * S };
    const stop = side > 0 ? x0 + S * 1.5 : x0 + (cols - 1.5) * S;
    this._face(-side);
    const src = await screenPiece(this, rect);
    this._check(ctx);
    this._play(LIB("Relax"), ctx, { maxMs: 6000 }).catch(() => {});
    const h = Math.min(this.body * 0.95, S * 1.7);
    const mob = this.fx.mob("creeper", h);
    this.onEnd(() => mob.fade(200));
    const edge = side > 0 ? width + h : -h;
    mob.walk(true);
    await trot(this, mob, edge, stop, floorY, this.body * 0.7, ctx, { hop: 0 });
    mob.walk(false);
    this.fx.say(_t("That'sss a very nice desktop you have there…"), stop, floorY - h * 1.15, 2600);
    await this._wait(1500, ctx);
    this._rest();
    this._face(side);
    this._play(LIB("Surprised"), ctx, { maxMs: 1400 }).catch(() => {});
    await this._wait(700, ctx);
    say(this, _t("aw man."), 1400);
    mob.set("is-fuse", true);
    await this._wait(FUSE_MS, ctx);
    // Bang.
    const blast = { x: stop, y: floorY - S };
    mob.remove();
    this.fx.explosion(blast.x, blast.y, S * 4);
    shake(this, 16);
    const tiles = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cx = rect.x + (c + 0.5) * S, cy = rect.y + (r + 0.5) * S;
            if (Math.hypot(cx - blast.x, (cy - blast.y) * 1.2) > S * rand(2.3, 3.2)) continue;
            tiles.push({ c, r, x: rect.x + c * S, y: rect.y + r * S });
        }
    }
    const hole = src ? this.fx.pit(tiles, S) : null;
    this.onEnd(() => hole?.remove());
    for (const t of tiles) {
        const kind = t.r === rows - 1 ? "dirt" : pick(["stone", "dirt"]);
        const b = src
            ? this.fx.block(null, t.x, t.y, S, { src, cut: { x: t.c * S, y: t.r * S, width: rect.width, height: rect.height }, layer: this.fx.over })
            : (Math.random() < 0.5 ? this.fx.block(kind, t.x, t.y, S * 0.6, { layer: this.fx.over }) : null);
        b?.fling(blast.x, blast.y + S).then(() => b.remove());
    }
    await dropDown(this, ctx, { vx: -side * 3.4 * this.m.pxPerM, vy: -5.2 * this.m.pxPerM });
    this.fx.worldChat(_t("%s was blown up by Creeper", myName(this)));
    await this._play(ROAM("land"), ctx);
    const hd = headPage(this);
    this.fx.stars(hd.x, hd.y);
    this._face(side);
    await this._play(LIB("Sad"), ctx, { maxMs: 2600 });
    // Every block back where it was.
    if (hole) {
        say(this, _t("…I'll fix it."), 1600);
        tiles.sort((a, b) => b.r - a.r || a.c - b.c);
        const back = [];
        for (const t of tiles) {
            const b = this.fx.block(null, t.x, t.y, S, { src, cut: { x: t.c * S, y: t.r * S, width: rect.width, height: rect.height }, layer: this.fx.under, flat: true });
            b.plop();
            back.push(b);
            await this._wait(90, ctx);
        }
        await this._wait(500, ctx);
        hole.remove();
        back.forEach((b) => b.fade(500));
    }
    this._face(0);
    await this._wait(800, ctx);
}

/** Straight down, which nobody should: through the floor, out of the
 *  bottom of the world and in again at the top — and, half the time, a
 *  bucket of water put down in the last instant. */
async function digStraightDown(ctx) {
    if (!this.onFloor) return;
    const floorY = this.world.floor().y;
    const S = blockSize(this);
    const x = this.b.x;
    this._face(0);
    say(this, _t("straight down. what could go wrong."), 2200);
    await this._wait(1600, ctx);
    const bar = this.fx.hotbar();
    this.onEnd(() => bar.remove());
    await this.prop("shovel");
    await this._play(ROAM("dig"), ctx, { loop: true });
    this.b.mode = "scripted";
    this.clipLine = floorY;
    const dirt = blockTexture("dirt");
    const depth = Math.ceil((this.body * 1.15) / S);
    for (let i = 0; i < depth; i++) {
        this.fx.dirt(x, floorY - 4, 5);
        const y0 = this.b.y;
        await this._tween(BREAK_DIRT_MS, (s) => { this.b.y = y0 + S * s; });
        this._check(ctx);
        const item = this.fx.blockItem(dirt, x + rand(-S, S) * 0.4, floorY - S * 0.3, S);
        item.flyTo(this.fx._w / 2 - 160, this.fx._h - 30, 420).then(() => bar.give(dirt));
    }
    this.host.style.opacity = "0";
    this.onEnd(() => { this.host.style.opacity = ""; });
    for (const p of this._props) p.hide();
    this._rest();
    this.fx.comic(_t("aaaaaaAAAA"), x, floorY - S, { size: 22, color: "#f8fafc", ms: 1500 });
    await this._wait(1700, ctx);
    // Out of the bottom of the world: in at the top.
    const clutch = Math.random() < 0.5;
    this.clipLine = null;
    this._stand(this.world.floor(), x);
    this.b.y = -this.body * 0.1;
    this.host.style.opacity = "";
    let water = null;
    this._hopping = true;
    this._quietLanding = !clutch;
    try {
        this._toAir();
        if (clutch) {
            await this._until(() => this.b.mode === "ground" || this.b.y > floorY - this.body * 2.2, ctx, 8000);
            water = this.fx.block("water", x - S / 2, floorY - S, S, { layer: this.fx.over });
            this.onEnd(() => water.remove());
            water.plop();
        }
        await this._until(() => this.b.mode === "ground", ctx, 8000);
    } finally {
        this._hopping = false;
    }
    if (clutch) {
        this.fx.splash(x, floorY - S * 0.6);
        this.fx.splash(x, floorY - S * 0.6);
        await this._wait(350, ctx);
        water.fade(250);
        this.fx.toast(_t("Advancement Made!"), _t("Caves & Cliffs"), "water");
        say(this, _t("planned that."), 1800);
        await this._play(LIB("VRMA_03_peace_sign"), ctx, { maxMs: 2600 });
        return;
    }
    shake(this, 8);
    const hd = headPage(this);
    this.fx.stars(hd.x, hd.y);
    this.fx.worldChat(_t("%s hit the ground too hard", myName(this)));
    await this._play(ROAM("sleep"), ctx, { loop: true });
    await this._wait(2200, ctx);
    this._rest();
    say(this, _t("ow."), 1500);
    await this._play(LIB("Stretch"), ctx, { maxMs: 3000 });
}

/** A tall dark thing helps itself to a block of the screen. Looked at,
 *  it's off; chased, it's off again; and the block goes back down
 *  somewhere it doesn't belong, for them to put right. */
async function blockThief(ctx) {
    if (!this.onFloor) return;
    const { width } = this.world.area;
    const floorY = this.world.floor().y;
    const S = blockSize(this);
    const far = this.b.x < width / 2 ? 1 : -1;
    const bx = clamp(this.b.x + far * width * rand(0.3, 0.42), S * 2, width - S * 3);
    const rect = { x: bx, y: floorY - S, width: S, height: S };
    const src = await screenPiece(this, rect);
    this._check(ctx);
    if (!src) return;
    const h = Math.min(this.body * 1.45, this.world.area.height * 0.5);
    const mob = this.fx.mob("enderman", h);
    this.onEnd(() => mob.fade(200));
    let ex = bx + S / 2 - far * S * 0.9;
    const warp = (x) => {
        this.fx.wisps(ex, floorY - h * 0.5, h);
        ex = x;
        mob.moveTo(ex, floorY, -far);
        this.fx.wisps(ex, floorY - h * 0.5, h);
    };
    mob.moveTo(ex, floorY, far);
    this.fx.wisps(ex, floorY - h * 0.5, h);
    await this._wait(900, ctx);
    // Out it comes.
    const hole = this.fx.pit([{ x: rect.x, y: rect.y }], S);
    this.onEnd(() => hole.remove());
    const block = this.fx.block(null, rect.x, rect.y, S, { src, cut: { x: 0, y: 0, width: S, height: S }, layer: this.fx.over });
    let dropped = false;
    this.onEnd(() => { if (!dropped) block.remove(); });
    const carried = everyFrame(this, () => block.moveTo(mob.x - S / 2, floorY - h * 0.55));
    this.onEnd(carried);
    await this._wait(900, ctx);
    this._face(far);
    say(this, _t("hey!"), 1200);
    mob.set("is-angry", true);
    await this._play(LIB("Surprised"), ctx, { maxMs: 1200 });
    for (let i = 0; i < 2; i++) {
        const to = clamp(this.b.x - Math.sign(ex - this.b.x) * width * rand(0.25, 0.4), h, width - h);
        const chase = this._walkTo(clamp(ex - Math.sign(ex - this.b.x) * this.body, this.body * 0.4, width - this.body * 0.4), ctx, { rate: 1.6 });
        chase.catch(() => {});
        await this._wait(1100, ctx);
        warp(to);
        await chase;
        this._face(ex - this.b.x);
        await this._wait(500, ctx);
    }
    // Set down wherever it happens to be standing, and gone.
    carried();
    const wrong = { x: clamp(ex + far * S * 0.2, S, width - S * 2), y: floorY - S };
    block.moveTo(wrong.x, wrong.y);
    block.plop();
    dropped = true;
    await this._wait(500, ctx);
    this.fx.wisps(ex, floorY - h * 0.5, h);
    mob.remove();
    await this._walkTo(wrong.x + S / 2 - Math.sign(wrong.x - this.b.x || 1) * (S * 0.5 + this.body * 0.3), ctx);
    this._face(wrong.x - this.b.x);
    say(this, _t("…that doesn't go there."), 2000);
    await this._play(LIB("Thinking"), ctx, { maxMs: 2200 });
    this._face(wrong.x - this.b.x);
    // Punched loose, and home it goes.
    await this._play(ROAM("punch"), ctx, { loop: true });
    for (let stage = 1; stage <= 9; stage++) {
        block.crack(stage);
        await this._wait(BREAK_DIRT_MS / 9, ctx);
    }
    block.crack(0);
    this._rest();
    try {
        await block.el.animate([{ translate: "0 0", rotate: "0deg" },
            { translate: `${(rect.x - wrong.x) / 2}px ${-S * 3}px`, rotate: "180deg", offset: 0.5 },
            { translate: `${rect.x - wrong.x}px ${rect.y - wrong.y}px`, rotate: "360deg" }], { duration: 750, easing: "ease-in-out", fill: "forwards" }).finished;
    } catch (e) { /* cleared */ }
    hole.remove();
    block.fade(400);
    this._face(0);
    this.fx.toast(_t("Advancement Made!"), _t("Interior Decorating"), "stone");
    await this._play(LIB("VRMA_03_peace_sign"), ctx, { maxMs: 2500 });
}

export function installGameGags(proto) {
    Object.assign(proto, { chopTree, evilChicken, genieLamp, sandwichLady, partyHat, creeper, digStraightDown, blockThief });
}

// One game's gag never follows another of the same game.
export const GAME_GAG_ACTIONS = [
    { id: "oldschool_woodcutting_level", group: "game_oldschool", weight: 3, cooldown: 900, when: (d) => d.onFloor, run: chopTree },
    { id: "oldschool_evil_chicken", group: "game_oldschool", weight: 2, cooldown: 1200, when: (d) => d.onFloor, run: evilChicken },
    { id: "oldschool_genie_lamp", group: "game_oldschool", weight: 2, cooldown: 1200, when: (d) => d.onFloor, run: genieLamp },
    { id: "oldschool_sandwich_lady", group: "game_oldschool", weight: 2, cooldown: 1200, when: (d) => d.onFloor, run: sandwichLady },
    { id: "oldschool_party_hat", group: "game_oldschool", weight: () => (christmasTime() ? 6 : 1.5), cooldown: 1800, when: ground, run: partyHat },
    { id: "blocks_creeper", group: "game_blocks", weight: 2.5, cooldown: 1200, when: (d) => d.onFloor, run: creeper },
    { id: "blocks_dig_straight_down", group: "game_blocks", weight: 2.5, cooldown: 900, when: (d) => d.onFloor, run: digStraightDown },
    { id: "blocks_block_thief", group: "game_blocks", weight: 2.5, cooldown: 1200, when: (d) => d.onFloor && d.tricks && !!d.bridge?.roamCapture, run: blockThief },
];
