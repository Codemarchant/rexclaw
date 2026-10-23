// Toys on the desktop, for a roaming companion (models/roam_director.js):
// the toys' world (models/toys/world.js) at z = 0, drawn as the toys' own
// SVG (models/toys/art.js) on the mascot overlay's effect layers. Metres
// map to the screen through the roam shot's px per metre, so a ball is a
// real ball's size next to the companion and falls at a real ball's pace.
// The floor is the bottom of the screen and the window tops are ledges,
// as they are for the companion: toys land on windows, ride along when a
// window is dragged, and fall when it goes.
//
// The overlay is click-through; MascotView asks hitTest() whether the
// pointer is over a toy (then the window takes the click), and feeds the
// cursor in cursorAt() even while it doesn't (where to throw things back).

import { ToyWorld, headY } from "./world";
import { TOYS, HOOP, GOAL, POSTS, lampLight, puffHz } from "./catalog";
import { toyArt, fanBox } from "./art";
import { add, bounce, sub, v3 } from "./physics";
import { playWith, idleAppeal } from "./brains";
import { reactionFor } from "./react";
import { overTray } from "./toybox";
import { bodyFx } from "./body_fx";
import { toySfx } from "./sfx";
import { el } from "../roam_fx";

const UP = v3(0, 1, 0);
const RIGHT = v3(1, 0, 0);
const LEFT = v3(-1, 0, 0);
// A click (not a drag) on a toy: this little movement, this quick.
const CLICK_PX = 5;
const CLICK_MS = 350;
// A fan's stand goes up or down this much per wheel notch (by eye).
const RAISE_STEP = 0.05;           // m
// Fog: puffs per second from the nozzle while it fires, how long a puff
// lives and how big it grows (by eye); the most on screen at once.
const FOG_RATE = 26;
const FOG_LIFE = [5, 8];
const FOG_MAX = 260;
// Mirror ball: spots across the screen, beams fanning from it, glints on
// it, all turning colour and pulsing to a 120 bpm beat (by eye).
const FLECKS = 90;
const BEAMS = 8;
const DISCO_BPM = 120;
// A campfire's or the galaxy projector's night on the desktop: the screen
// darkened this share of what the room view's backdrop is (it's the user's
// desktop), the fire's glow this far round it, its embers, the projector's
// stars and clouds, a shooting star one every SHOOT_EVERY seconds crossing
// in SHOOT_S (all by eye).
const DESK_NIGHT = 0.55;
const FIRE_GLOW_M = 2.2;
const EMBERS = 26;
const SKY_STARS = 220;
const SKY_CLOUDS = 8;
const SHOOT_S = 0.9;
const SHOOT_EVERY = [15, 40];

const rgba = (hex, a) => {
    const v = parseInt(String(hex).replace("#", ""), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${Math.max(0, a).toFixed(3)})`;
};

const rand = (a, b) => a + Math.random() * (b - a);
const now = () => performance.now();
// Drawn no smaller than this across, so a strawberry stays something you
// can see and grab next to a small companion (by eye); its physics keeps
// its real size.
const MIN_PX = 26;
// A toy's drawing box: its own (a fan raised or lowered), or its kind's.
const artOf = (t) => t.art || t.def.art;
const drawScale = (t, k) => { const a = artOf(t); return Math.max(1, MIN_PX / (Math.max(a.w, a.h) * k)); };
// The middle of a toy's drawing (a pedestal fan's is well above its base).
const artCentre = (t) => { const a = artOf(t); return a?.cy ? { x: t.p.x, y: t.p.y + a.cy, z: 0 } : t.p; };

export class ScreenStage extends ToyWorld {
    /** director: the RoamDirector. root: the overlay root (the pointer). */
    constructor({ director, root, box = null }) {
        super({ dims: 2 });
        this.kind = "screen";
        this.d = director;
        this.root = root;
        this.box = box;
        this.back = el("rx_toys rx_toys--back", director.fx.under);
        this.fxCanvas = el("rx_toys_fx", director.fx.over, "canvas");
        this.layer = el("rx_toys", director.fx.over);
        this.front = el("rx_toys rx_toys--front", director.fx.over);
        this.fog = [];
        this.flecks = Array.from({ length: FLECKS }, () => ({
            a: Math.random() * Math.PI * 2, y: Math.random(), s: rand(3, 8), hue: Math.random(),
        }));
        this.bodyApi = new ScreenBody(this, director);
        this._ledges = [];
        this._cursor = null;
        this._ptr = null;
        this.dragging = false;
        this._last = 0;
        this.on((evt) => this._onEvent(evt));
        this._bindPointer();
        this._raf = requestAnimationFrame((t) => this._frame(t));
        // Console handle: __toys.toss(__toys.TOYS.donut).
        window.__toys = this;
    }

    get TOYS() { return TOYS; }

    dispose() {
        cancelAnimationFrame(this._raf);
        this._unbind?.();
        this.clear();
        toySfx.stopAll();
        this.d.r.setToyWind?.(null);
        for (const e of [this.back, this.fxCanvas, this.layer, this.front]) e.remove();
        this.disposed = true;
        if (window.__toys === this) delete window.__toys;
    }

    // ── units ────────────────────────────────────────────────────────────

    get k() { return this.d.m?.pxPerM || (this.d.body || 300) / 1.6; }
    get H() { return this.d.world.area.height; }
    get W() { return this.d.world.area.width; }

    toPx(p) { return { x: p.x * this.k, y: this.H - p.y * this.k }; }
    fromPx(x, y) { return { x: x / this.k, y: (this.H - y) / this.k, z: 0 }; }

    // ── the world (ToyWorld's hooks) ─────────────────────────────────────

    body() {
        const d = this.d;
        if (!d.m || d._hidden || d.host.style.opacity === "0" || d.b.mode === "air") return null;
        const k = this.k;
        return { pos: this.fromPx(d.b.x, d.b.y), height: d.body / k, facing: v3(this.bodyApi.facingSign(), 0, 0) };
    }

    holdPoint(t) {
        const d = this.d;
        const one = t.grip === "right" || t.grip === "left" ? t.grip : null;
        const p = d._bonesPx(one ? [`${one}MiddleProximal`] : ["leftMiddleProximal", "rightMiddleProximal"])
            || d._bonesPx(one ? [`${one}Hand`] : ["leftHand", "rightHand"]);
        if (!p) return null;
        const q = this.fromPx(d.box.left + p.x, d.box.top + p.y);
        // A wand is held by its handle: the ring stands above the fist; a
        // banana up out of it to peel, an ice cream's cone in it.
        if (t.def.kind === "wand") q.y += t.radius * 0.5;
        if (t.def.food?.style === "peel") q.y += t.radius * 2.2;
        if (t.def.food?.style === "lick") q.y += t.radius * 0.6;
        // A bottle by its middle (its drawing's centre, above its foot).
        if (t.def.food?.style === "bottle") q.y -= t.def.art.cy;
        return q;
    }

    collideWorld(t) {
        const r = t.radius;
        let floor = null;
        if (t.p.y - r < 0) {
            const sp = bounce(t, UP, r - t.p.y);
            this._impact(t, sp);
            floor = UP;
            t.surf = null;
        } else if (t.v.y <= 0) {
            for (const l of this._ledges) {
                if (t.p.x < l.x0 || t.p.x > l.x1) continue;
                const bottom = t.p.y - r, prev = (t._prevY ?? t.p.y) - r;
                if (prev >= l.y - 0.02 && bottom < l.y) {
                    const sp = bounce(t, UP, l.y - bottom);
                    this._impact(t, sp);
                    floor = UP;
                    if (t.surf?.id !== l.id) {
                        const w = this.d.world.window(l.win);
                        t.surf = { id: l.id, win: l.win, at: w ? { x: w.x, y: w.y } : null };
                    }
                    break;
                }
            }
        }
        const right = this.W / this.k;
        if (t.p.x - r < 0) this._impact(t, bounce(t, RIGHT, r - t.p.x));
        else if (t.p.x + r > right) this._impact(t, bounce(t, LEFT, t.p.x + r - right));
        return floor;
    }

    _impact(t, sp) {
        if (sp <= 0.4) return;
        if (t.view) t.view.sq = Math.min(1, sp / 5);
        if (sp > 0.8) toySfx.bounce(sp, t.def.kind === "coin" ? "coin" : t.def.id);
    }

    placeHoop(near) {
        // On the side of the screen with more room, its board toward the
        // middle, so the shot is across the screen.
        const right = this.W / this.k;
        const leftSide = near.x > right / 2;
        const x = leftSide ? 0.1 : right - 0.1;
        return { x, y: 0, z: 0, face: v3(leftSide ? 1 : -1, 0, 0) };
    }

    shootingSpot(hoop, d) {
        const right = this.W / this.k;
        const x = Math.max(0.4, Math.min(right - 0.4, hoop.base.x + hoop.face.x * Math.min(d, right * 0.6)));
        return { x, y: 0, z: 0 };
    }

    placeGoal(near) {
        // Like the hoop: at the side with more room, its mouth toward the
        // middle of the screen.
        const right = this.W / this.k;
        const leftSide = near.x > right / 2;
        const x = leftSide ? GOAL.depth + 0.15 : right - GOAL.depth - 0.15;
        return { x, y: 0, z: 0, face: v3(leftSide ? 1 : -1, 0, 0) };
    }

    /** The penalty spot, on the screen. */
    penaltySpot(goal) {
        const right = this.W / this.k;
        const d = Math.min(GOAL.spot, right * 0.6);
        return { x: Math.max(0.4, Math.min(right - 0.4, goal.base.x + goal.face.x * d)), y: 0, z: 0 };
    }

    placePosts(near) {
        // Like the goal: at the side with more room, facing the middle.
        const right = this.W / this.k;
        const leftSide = near.x > right / 2;
        return { x: leftSide ? 0.6 : right - 0.6, y: 0, z: 0, face: v3(leftSide ? 1 : -1, 0, 0) };
    }

    /** The kicking mark, on the screen. */
    kickSpot(posts) {
        const right = this.W / this.k;
        const d = Math.min(POSTS.spot, right * 0.6);
        return { x: Math.max(0.4, Math.min(right - 0.4, posts.base.x + posts.face.x * d)), y: 0, z: 0 };
    }

    /** Where to stand to be blown on: `d` in front of it, on its level. */
    inFrontOf(t, d) {
        const right = this.W / this.k;
        return { x: Math.max(0.3, Math.min(right - 0.3, t.p.x + Math.sign(t.aim.x || 1) * d)), y: t.p.y - t.radius, z: 0 };
    }

    userPoint() {
        const c = this._cursor;
        if (c && now() - c.at < 4000) return { x: c.p.x, y: Math.max(0.6, c.p.y), z: 0 };
        // No pointer about: toward the middle of the screen, about head high.
        const b = this.body();
        const mid = this.W / this.k / 2;
        return { x: b ? b.pos.x + Math.sign(mid - b.pos.x || 1) * 2.2 : mid, y: 1.3, z: 0 };
    }

    /** What the toys left could set off among the roam's own gags. */
    followUp(id) { return this.d.force?.(id) || false; }

    // ── reactions (the roam director runs them, as actions) ──────────────

    _onEvent(evt) {
        if (evt.type === "taken" && this.d._toyNow?.toy === evt.toy) this.d._interrupt("toy");
        if (evt.type === "add" || evt.type === "remove") this.box?.changed?.();
        if ((evt.type === "switch" || evt.type === "shade") && evt.toy.def.kind === "lamp") this._redraw(evt.toy);
        const r = reactionFor(evt);
        if (r) this.d.toyReact?.(r);
    }

    /** Run reaction `r` (from the director's action). */
    async run(r, ctx) {
        await this.d._until(() => this.d.b.mode === "ground", ctx, 8000);
        await playWith(this.bodyApi, r.toy, r.why, ctx, r.part);
    }

    /** The toy most worth a look while idle, weighted; null when none. */
    idlePick() {
        const from = this.body()?.pos || null;
        const cands = this.toys.map((t) => [t, idleAppeal(t, this, from)]).filter(([, w]) => w > 0);
        if (!cands.length) return null;
        let r = Math.random() * cands.reduce((s, [, w]) => s + w, 0);
        for (const [t, w] of cands) { r -= w; if (r <= 0) return t; }
        return cands[0][0];
    }

    idleWeight() {
        const from = this.body()?.pos || null;
        return this.toys.reduce((s, t) => s + idleAppeal(t, this, from), 0);
    }

    /** The action ended: anything still in their hands drops. */
    releaseHeld() {
        for (const t of this.toys) if (t.heldBy === "companion") this.bodyApi.letGo(t, v3(0, 0.3, 0));
    }

    // ── the tray ─────────────────────────────────────────────────────────

    /** A tray tile pressed: the toy appears under the pointer, held. */
    spawnDrag(def, ev) {
        const t = this.add(def, this.fromPx(ev.clientX, ev.clientY));
        this._startDrag(t, ev, { fromTray: true });
        return t;
    }

    /** A tray tile clicked: lobbed in from the bottom of the screen to them. */
    toss(def) {
        const b = this.body();
        const from = this.fromPx(this.W / 2, this.H - 30);
        const t = this.add(def, from);
        if (def.kind === "lamp") {
            // Set down (or hung up) on the floor a little way from them,
            // where no other lamp is, off.
            const right = this.W / this.k, at = b ? b.pos.x : right / 2;
            const spots = [1.1, -1.1, 1.8, -1.8, 2.5, -2.5, 3.2, -3.2, 3.9, -3.9, 4.6, -4.6].map((d) => at + d).filter((x) => x > 0.3 && x < right - 0.3);
            const x = spots.find((sx) => this.toys.every((o) => o === t || o.def.kind !== "lamp" || Math.abs(o.p.x - sx) > 0.45)) ?? at;
            t.p = { x, y: def.hang ?? def.radius, z: 0 };
            t.v = v3();
            t.hovering = !!def.hovers;
            return t;
        }
        if (!b) {
            // They're out of sight (mid-gag): it drops in, for later.
            if (!def.gadget && !def.tool) this.emit("drop", t);
            return t;
        }
        if (def.gadget || def.tool || def.placed) {
            // Gadgets are set down beside them instead.
            t.p = { x: b.pos.x + (b.pos.x < this.W / this.k / 2 ? 1.2 : -1.2), y: def.hovers ? b.height * 0.9 : 1.5, z: 0 };
            t.v = v3();
            t.hovering = !!def.hovers;
            // A chest set down: they'll come and see once it has landed.
            if (def.placed) this.emit("drop", t);
            if (def.kind === "fan" || def.kind === "dryer") t.aim = t.baseAim = v3(Math.sign(b.pos.x - t.p.x), 0, 0);
            return t;
        }
        this.lob(t, from);
        return t;
    }

    // ── pointer ──────────────────────────────────────────────────────────

    /** The toy under a page point (generously), or null. */
    toyAt(x, y) {
        const k = this.k;
        let best = null, bd = Infinity;
        for (const t of this.toys) {
            if (!t.alive || t.def.kind === "bubble") continue;
            const c = this.toPx(artCentre(t));
            const a = artOf(t);
            const r = Math.max(a.w, a.h) * k * drawScale(t, k) * 0.5 + 6;
            const d = Math.hypot(x - c.x, y - c.y);
            if (d < r && d < bd) { bd = d; best = t; }
        }
        return best;
    }

    /** The soap bubble under a page point (a little generously), or null. */
    bubbleAt(x, y) {
        const k = this.k;
        let best = null, bd = Infinity;
        for (const t of this.toys) {
            if (!t.alive || t.def.kind !== "bubble") continue;
            const c = this.toPx(t.p);
            const d = Math.hypot(x - c.x, y - c.y);
            if (d < t.radius * k + 8 && d < bd) { bd = d; best = t; }
        }
        return best;
    }

    /** For MascotView's click-through switch: is the pointer on a toy (or
     *  a bubble)? */
    hitTest(x, y) { return this.dragging || !!this.toyAt(x, y) || !!this.bubbleAt(x, y); }

    /** The global cursor (every sample, clicks or not): where the user is,
     *  to throw things back to. */
    cursorAt(c) {
        this._cursor = c ? { p: this.fromPx(c.x, c.y), at: now() } : null;
    }

    _bindPointer() {
        const root = this.root;
        const down = (ev) => {
            if (ev.button !== 0 || this.dragging) return;
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t) {
                // A bubble: popped.
                const b = this.bubbleAt(ev.clientX, ev.clientY);
                if (!b) return;
                ev.stopPropagation();
                ev.preventDefault();
                this.popBubble(b, "user");
                return;
            }
            ev.stopPropagation();
            ev.preventDefault();
            this._startDrag(t, ev);
        };
        const wheel = (ev) => {
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t?.def.jet && !t?.def.shades) return;
            ev.preventDefault();
            ev.stopPropagation();
            // A lamp: its next shade. Shift: the fan's stand up or down;
            // plain: turn it round.
            if (t.def.shades) this.shade(t, Math.sign(ev.deltaY || ev.deltaX) || 1);
            else if (ev.shiftKey && t.def.headRange) this.raise(t, -Math.sign(ev.deltaY || ev.deltaX) * RAISE_STEP);
            else this.turn(t, Math.sign(ev.deltaY));
        };
        // Right-click a toy: put it away.
        const menu = (ev) => {
            const t = this.toyAt(ev.clientX, ev.clientY);
            if (!t) return;
            ev.stopPropagation();
            ev.preventDefault();
            this.putAway(t);
        };
        root.addEventListener("pointerdown", down, true);
        root.addEventListener("wheel", wheel, { capture: true, passive: false });
        root.addEventListener("contextmenu", menu, true);
        this._unbind = () => {
            root.removeEventListener("pointerdown", down, true);
            root.removeEventListener("wheel", wheel, true);
            root.removeEventListener("contextmenu", menu, true);
            this._endDrag?.();
        };
    }

    /** One toy back in the box (a right-click, or dropped on the tray):
     *  whatever they were doing with it stops. */
    putAway(t) {
        toySfx.pop();
        if (this.d._toyNow?.toy === t) this.d._interrupt("toy");
        this.remove(t);
    }

    /** The fan's drawing redrawn at its new height. */
    onRaise(t) {
        t.art = fanBox(headY(t));
        this._redraw(t);
    }

    /** A toy's drawing as it is now (a fan's height, a lamp on or off in
     *  its shade, a banana's peel). */
    _redraw(t) {
        if (t.view) t.view.e.innerHTML = toyArt(t.def.id, { headY: headY(t), on: t.on, shade: t.shade || 0, peeled: t.peeled || 0 });
    }

    onPeel(t) { this._redraw(t); }

    _startDrag(t, ev, { fromTray = false } = {}) {
        const start = { x: ev.clientX, y: ev.clientY, at: now(), moved: fromTray, hovered: t.hovering };
        const grabOffset = fromTray ? v3() : sub(t.p, this.fromPx(ev.clientX, ev.clientY));
        this.grab(t);
        this.dragging = true;
        const move = (e) => {
            if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX) start.moved = true;
            const p = add(this.fromPx(e.clientX, e.clientY), grabOffset);
            p.y = Math.max(t.radius, p.y);
            this.dragTo(p);
        };
        const up = (e) => {
            this._endDrag();
            // Let go over the tray: back in the box.
            if (overTray(e)) { this.drag = null; this.putAway(t); return; }
            if (!start.moved && now() - start.at < CLICK_MS) {
                // A click: switch it, and put it back as it was.
                this.drag = null;
                t.heldBy = null;
                t.v = v3();
                t.hovering = start.hovered;
                this.toggle(t);
                if (t.def.kind === "plush") toySfx.squeak();
                return;
            }
            this.release();
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
        this._endDrag = () => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", up, true);
            this.dragging = false;
            this._endDrag = null;
        };
    }

    // ── frames ───────────────────────────────────────────────────────────

    _frame(ts) {
        if (this.disposed) return;
        this._raf = requestAnimationFrame((t) => this._frame(t));
        const dt = Math.min(0.05, this._last ? (ts - this._last) / 1000 : 0);
        this._last = ts;
        if (!this.d.running || !this.d.m) return;
        // Nothing out (most of a roam): nothing to do. (One more step once
        // the last toy goes, so a mirror ball's light on the fx canvas is
        // cleared.)
        if (!(this.toys.length || this.fog.length || this.hoop || this.goal || this.fxCanvas?._drawn)) {
            if (this._wind) { this._wind = null; this.d.r.setToyWind?.(null); }
            return;
        }
        this._refreshLedges();
        this._ride();
        this.step(dt);
        // The breeze on their hair: whatever blows where their head is.
        const b = this.body();
        const w = b && this.toys.some((t) => t.on && t.def.jet) ? this.windAt(add(b.pos, v3(0, b.height * 0.9, 0))) : null;
        this._wind = w;
        this.d.r.setToyWind?.(w ? () => w : null);
    }

    _refreshLedges() {
        const k = this.k, H = this.H;
        this._ledges = this.d.world.ledges(12).map((l) => ({
            id: l.id, win: l.win, y: (H - l.y) / k, x0: l.x0 / k, x1: l.x1 / k,
        }));
    }

    /** Toys on a window move with it, and fall when it's gone. */
    _ride() {
        const k = this.k;
        for (const t of this.toys) {
            if (!t.surf || t.heldBy) continue;
            const w = this.d.world.window(t.surf.win);
            const l = this._ledges.find((x) => x.win === t.surf.win && t.p.x >= x.x0 - 0.05 && t.p.x <= x.x1 + 0.05);
            if (!w || !l) { t.surf = null; t.wake(); continue; }
            if (t.surf.at && (w.x !== t.surf.at.x || w.y !== t.surf.at.y)) {
                t.p = { x: t.p.x + (w.x - t.surf.at.x) / k, y: t.p.y - (w.y - t.surf.at.y) / k, z: 0 };
                t.surf.at = { x: w.x, y: w.y };
            }
        }
    }

    // ── drawing ──────────────────────────────────────────────────────────

    viewAdd(t) {
        // Lamps stand behind the rest (a desk behind a ball).
        const e = el(`rx_toy rx_toy--${t.def.kind} rx_toy--${t.def.id}`, t.def.kind === "lamp" ? this.back : this.layer);
        if (t.def.headY) t.art = fanBox(headY(t));
        t.view = { e, sq: 0, w: 0, h: 0, cls: "" };
        if (t.def.kind !== "bubble") this._redraw(t);
        e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    }

    viewRemove(t) {
        const e = t.view?.e;
        t.view = null;
        if (!e) return;
        if (t.def.kind === "bubble") {
            e.animate([{ transform: e.style.transform, opacity: 1 }, { transform: `${e.style.transform} scale(1.4)`, opacity: 0 }],
                { duration: 140, fill: "forwards" }).finished.then(() => e.remove(), () => e.remove());
        } else {
            e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" }).finished.then(() => e.remove(), () => e.remove());
        }
    }

    onBite() { /* drawn per frame from t.left */ }

    onChestOpen(t) { t.view?.e.classList.add("is-open"); }

    /** Flakes drifting down an aquarium's water (art.js .rx_flakes). */
    feedFish(t) {
        const e = t.view?.e;
        if (!e) return;
        e.classList.remove("is-feeding");
        void e.getBoundingClientRect();
        e.classList.add("is-feeding");
        clearTimeout(t._feedTimer);
        t._feedTimer = setTimeout(() => e.classList.remove("is-feeding"), 8000);
    }

    /** A drawing behind the toys and one in front of them, for the hoop or
     *  the goal (`name`), each in its own box on its layer. */
    _pieces(name) {
        this._piece ||= {};
        if (!this._piece[name]) {
            this._piece[name] = { back: el(`rx_toys_piece`, this.back), front: el(`rx_toys_piece`, this.front) };
        }
        return this._piece[name];
    }

    viewHoop(h) {
        const pc = this._pieces("hoop");
        pc.back.innerHTML = "";
        pc.front.innerHTML = "";
        if (!h) return;
        const k = this.k;
        const P = (p) => this.toPx(p);
        const base = P(h.base), rim = P(h.rim);
        const boardTop = P({ x: h.base.x, y: h.rim.y - HOOP.boardBelowRim + HOOP.boardH, z: 0 });
        const boardBot = P({ x: h.base.x, y: h.rim.y - HOOP.boardBelowRim, z: 0 });
        const R = HOOP.rimRadius * k, ry = Math.max(4, R * 0.18), net = HOOP.net * k;
        const dir = h.face.x;
        const pole = base.x - dir * 0.12 * k;
        const thick = Math.max(4, 0.05 * k);
        // Behind them: the pole, its arm, the board, the far side of the ring.
        pc.back.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">
<rect x="${pole - thick}" y="${boardBot.y - 0.2 * k}" width="${thick * 2}" height="${base.y - boardBot.y + 0.2 * k}" fill="#64748b"/>
<path d="M${pole} ${boardBot.y + 0.1 * k} L${base.x} ${boardBot.y - 0.05 * k}" stroke="#64748b" stroke-width="${thick}"/>
<rect x="${base.x - thick / 2}" y="${boardTop.y}" width="${thick}" height="${boardBot.y - boardTop.y}" rx="2" fill="#f8fafc" stroke="#ef4444" stroke-width="2"/>
<path d="M${rim.x - R} ${rim.y} A${R} ${ry} 0 0 1 ${rim.x + R} ${rim.y}" fill="none" stroke="#c2410c" stroke-width="${Math.max(2.5, 0.02 * k)}"/>
<path d="M${base.x} ${rim.y} L${rim.x - dir * R} ${rim.y}" stroke="#c2410c" stroke-width="3"/></svg>`;
        // In front of the ball: the near side of the ring and the net.
        let mesh = "";
        for (let i = 0; i <= 6; i++) {
            const x0 = rim.x - R + (2 * R * i) / 6;
            const x1 = rim.x - R * 0.55 + (1.1 * R * i) / 6;
            mesh += `M${x0} ${rim.y} L${x1} ${rim.y + net}`;
        }
        for (let j = 1; j <= 3; j++) {
            const y = rim.y + (net * j) / 3.4, w = R * (1 - 0.45 * (j / 3.4));
            mesh += `M${rim.x - w} ${y} L${rim.x + w} ${y}`;
        }
        pc.front.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">
<path d="${mesh}" fill="none" stroke="rgba(15,23,42,.45)" stroke-width="3"/>
<path class="rx_toys_net" d="${mesh}" fill="none" stroke="rgba(248,250,252,.95)" stroke-width="1.4"/>
<path d="M${rim.x - R} ${rim.y} A${R} ${ry} 0 0 0 ${rim.x + R} ${rim.y}" fill="none" stroke="#ea580c" stroke-width="${Math.max(3, 0.022 * k)}"/></svg>`;
    }

    /** The goal side on: the near post and the bar behind the toys, the
     *  net in front of them (a ball in it shows through the mesh). */
    viewGoal(g) {
        const pc = this._pieces("goal");
        pc.back.innerHTML = "";
        pc.front.innerHTML = "";
        if (!g) return;
        const k = this.k;
        const P = (x, y) => this.toPx({ x, y, z: 0 });
        const dir = g.face.x;
        const line = g.base.x, back = g.base.x - dir * GOAL.depth;
        const top = GOAL.height + GOAL.post;
        const post = Math.max(4, GOAL.post * 2 * k);
        const a = P(line, 0), b = P(line, top), c = P(back + dir * 0.15, top - 0.12), d = P(back, 0);
        pc.back.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">
<path d="M${b.x} ${b.y} L${c.x} ${c.y} L${d.x} ${d.y}" fill="none" stroke="#cbd5e1" stroke-width="${post * 0.45}" stroke-linejoin="round"/>
<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#1e293b" stroke-width="${post + 2}" stroke-linecap="round"/>
<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#f8fafc" stroke-width="${post}" stroke-linecap="round"/></svg>`;
        // The net: the roof from the bar back, and the back down to the floor.
        let mesh = "";
        const rows = 7, cols = 5;
        for (let i = 0; i <= rows; i++) {
            const y = top - (top * i) / rows;
            const x0 = line, x1 = back + dir * 0.15 * (y / top);
            const p0 = P(x0, y), p1 = P(x1, Math.max(0, y - 0.12 * (y / top)));
            mesh += `M${p0.x} ${p0.y} L${p1.x} ${p1.y}`;
        }
        for (let j = 0; j <= cols; j++) {
            const x = line + (back - line) * (j / cols);
            const p0 = P(x, top - 0.12 * (j / cols)), p1 = P(x, 0);
            mesh += `M${p0.x} ${p0.y} L${p1.x} ${p1.y}`;
        }
        pc.front.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">
<path d="${mesh}" fill="none" stroke="rgba(15,23,42,.35)" stroke-width="2.6"/>
<path d="${mesh}" fill="none" stroke="rgba(248,250,252,.85)" stroke-width="1.2"/>
<path d="M${a.x} ${a.y} L${b.x} ${b.y} L${P(line - dir * 0.02, top).x} ${b.y}" fill="none" stroke="#f8fafc" stroke-width="${post}" stroke-linecap="round" opacity=".95"/></svg>`;
    }

    /** The rugby posts side on, a little turned so the H reads: the far
     *  post and the bar behind the ball, the near post in front of it. */
    viewPosts(g) {
        const pc = this._pieces("posts");
        pc.back.innerHTML = "";
        pc.front.innerHTML = "";
        if (!g) return;
        const k = this.k;
        const P = (x, y) => this.toPx({ x, y, z: 0 });
        const dir = g.face.x;
        // The far post drawn this far back and up the screen (by eye).
        const skew = { x: -dir * 0.35, y: 0.3 };
        const w = Math.max(4, POSTS.post * 2 * k), pad = Math.max(8, POSTS.padR * 2 * k);
        const near = [P(g.base.x, 0), P(g.base.x, POSTS.height)];
        const far = [P(g.base.x + skew.x, skew.y), P(g.base.x + skew.x, POSTS.height + skew.y)];
        const barN = P(g.base.x, POSTS.bar - POSTS.post), barF = P(g.base.x + skew.x, POSTS.bar - POSTS.post + skew.y);
        const post = ([a, b], col, op = 1) => `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#1e293b" stroke-width="${w + 2}" stroke-linecap="round" opacity="${op}"/>
<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#f8fafc" stroke-width="${w}" stroke-linecap="round" opacity="${op}"/>
<rect x="${a.x - pad / 2}" y="${a.y - POSTS.padH * k}" width="${pad}" height="${POSTS.padH * k}" rx="${pad / 3}" fill="${col}" stroke="#1e293b" stroke-width="1.5" opacity="${op}"/>`;
        pc.back.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">${post(far, "#1d4ed8", 0.75)}
<path d="M${barN.x} ${barN.y} L${barF.x} ${barF.y}" stroke="#1e293b" stroke-width="${w + 2}" stroke-linecap="round"/><path d="M${barN.x} ${barN.y} L${barF.x} ${barF.y}" stroke="#f8fafc" stroke-width="${w}" stroke-linecap="round"/></svg>`;
        pc.front.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%">${post(near, "#dc2626")}</svg>`;
    }

    viewTee(tee) {
        const pc = this._pieces("tee");
        pc.back.innerHTML = "";
        if (!tee) return;
        const k = this.k;
        const a = this.toPx(tee.p), h = Math.max(4, POSTS.tee * k), w = Math.max(6, 0.12 * k);
        pc.back.innerHTML = `<svg class="rx_toys_hoop" width="100%" height="100%"><path d="M${a.x - w / 2} ${a.y} L${a.x - w / 5} ${a.y - h} H${a.x + w / 5} L${a.x + w / 2} ${a.y} Z" fill="#f97316" stroke="#7c2d12" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    }

    render(dt) {
        const k = this.k;
        for (const t of this.toys) {
            const v = t.view;
            if (!v) continue;
            const def = t.def;
            const bub = def.kind === "bubble";
            const art = artOf(t);
            const grow = bub ? 1 : drawScale(t, k);
            const w = bub ? t.radius * 2 * k : art.w * k * grow;
            const h = bub ? w : art.h * k * grow;
            if (Math.abs(v.w - w) > 0.5 || Math.abs(v.h - h) > 0.5) {
                v.e.style.width = `${w}px`;
                v.e.style.height = `${h}px`;
                v.w = w;
                v.h = h;
            }
            const c = this.toPx(artCentre(t));
            // Drawn bigger than life: grown up from its real bottom.
            if (!bub) c.y -= (h - art.h * k) / 2;
            v.sq = Math.max(0, v.sq - dt * 6);
            let deg = (-t.angle * 180) / Math.PI;
            // Things that don't roll settle back upright once they're still;
            // a rugby ball on its tee stands on end, a banana held up to
            // peel is stem up, an ice cream upright.
            const style = t.heldBy === "companion" ? def.food?.style : null;
            if ((!def.spins && !def.shell && t.resting) || style === "lick" || (style && def.vessel)) {
                t.angle *= Math.exp(-dt * 10);
                deg = (-t.angle * 180) / Math.PI;
            }
            if (t.upright) deg = -90;
            else if (style === "peel") deg = 55;
            // A cup, bowl or bottle tipped back to their mouth.
            if (style && def.vessel) {
                v.tip = (v.tip || 0) + ((t.tip || 0) - (v.tip || 0)) * Math.min(1, dt * 10);
                deg -= (v.tip * 180 / Math.PI) * this.bodyApi.facingSign();
            }
            const flip = def.jet && t.aim.x < 0 ? -1 : 1;
            const sq = 0.2 * v.sq;
            v.e.style.transform = `translate(${(c.x - w / 2).toFixed(1)}px, ${(c.y - h / 2).toFixed(1)}px) rotate(${deg.toFixed(1)}deg) scale(${(flip * (1 + sq)).toFixed(3)}, ${(1 - sq).toFixed(3)})`;
            v.e.style.transformOrigin = sq ? "50% 100%" : "50% 50%";
            const cls = `${t.on ? " is-on" : ""}${t.mode === 2 ? " is-sweep" : ""}${t.heldBy ? " is-held" : ""}${t.puffing ? " is-puffing" : ""}`;
            if (cls !== v.cls) {
                v.e.classList.toggle("is-on", !!t.on);
                v.e.classList.toggle("is-sweep", t.mode === 2);
                v.e.classList.toggle("is-held", !!t.heldBy);
                v.e.classList.toggle("is-puffing", !!t.puffing);
                v.cls = cls;
            }
            if (def.vessel) {
                // What's in it goes down (art.js .rx_fill); a bottle's cap
                // comes off.
                if (v.fill !== t.left) v.e.style.setProperty("--fill", (v.fill = t.left).toFixed(3));
                v.e.classList.toggle("is-open", !!t.opened);
            } else if (def.kind === "food" && t.left < 1) {
                // Bitten from the side; an ice cream licked down from the
                // top, a peeled banana eaten down from its top.
                v.e.style.clipPath = def.food.style === "lick" || def.food.style === "peel"
                    ? `inset(${Math.round((1 - t.left) * (def.food.style === "peel" ? 55 : 60))}% 0 0 0 round 40% 40% 0 0)`
                    : `inset(0 ${Math.round((1 - t.left) * 100)}% 0 0 round 0 40% 40% 0)`;
            }
        }
        this._drawFx(dt);
    }

    /** The night, fog and mirror-ball spots, on one canvas. */
    _drawFx(dt) {
        const cv = this.fxCanvas;
        const disco = this.toys.find((t) => t.def.kind === "disco" && t.on);
        const night = this.toys.filter((t) => t.on && t.def.lamp?.night);
        // New fog from every machine that's firing.
        for (const t of this.toys) {
            if (t.def.kind !== "fogger" || !t.puffing) continue;
            const dir = t.aim.x < 0 ? -1 : 1;
            for (let n = Math.floor(FOG_RATE * dt + Math.random()); n > 0 && this.fog.length < FOG_MAX; n--) {
                this.fog.push({
                    p: { x: t.p.x + dir * t.radius * 1.3, y: t.p.y + t.radius * 0.1 },
                    v: { x: dir * rand(1.2, 2.2), y: rand(-0.05, 0.25) },
                    r: rand(0.06, 0.12), grow: rand(0.08, 0.14), age: 0, life: rand(FOG_LIFE[0], FOG_LIFE[1]),
                });
            }
        }
        if (!this.fog.length && !disco && !night.length) {
            if (cv._drawn) { cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); cv._drawn = false; }
            return;
        }
        const W = this.W, H = this.H, k = this.k;
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const g = cv.getContext("2d");
        g.clearRect(0, 0, W, H);
        cv._drawn = true;
        if (night.length) this._drawNight(g, night, W, H, dt);
        // Fog drifts with the air and slowly rises as it warms (by eye).
        this.fog = this.fog.filter((f) => (f.age += dt) < f.life);
        for (const f of this.fog) {
            const air = this.windAt({ x: f.p.x, y: f.p.y, z: 0 }) || { x: 0, y: 0 };
            const relax = 1 - Math.exp(-1.2 * dt);
            f.v.x += (air.x - f.v.x) * relax;
            f.v.y += (air.y + 0.06 - f.v.y) * relax;
            f.p.x += f.v.x * dt;
            f.p.y = Math.max(f.r * 0.5, f.p.y + f.v.y * dt);
            f.r += f.grow * dt;
            const s = f.age / f.life;
            const a = 0.16 * Math.min(1, f.age * 3) * (1 - s);
            const c = this.toPx(f.p), rr = f.r * k;
            const grad = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, rr);
            grad.addColorStop(0, `rgba(226,232,240,${a})`);
            grad.addColorStop(1, "rgba(226,232,240,0)");
            g.fillStyle = grad;
            g.fillRect(c.x - rr, c.y - rr, rr * 2, rr * 2);
        }
        if (disco) this._drawDisco(g, disco, W, H);
    }

    /** The mirror ball on the desktop: beams fanning from it in turning
     *  colours (stronger in fog), spots of light sweeping the screen as it
     *  turns, glints flashing on it, all pulsing on the beat. */
    _drawDisco(g, disco, W, H) {
        const bc = this.toPx(disco.p);
        const spin = disco.spinAngle || 0;
        const time = this.time;
        const beat = Math.exp(-((time * DISCO_BPM / 60) % 1) * 5);
        const foggy = Math.min(1, this.fog.length / (FOG_MAX * 0.4));
        const reach = Math.hypot(W, H);
        g.save();
        g.globalCompositeOperation = "lighter";
        // Beams: long soft wedges, swinging as the ball turns.
        for (let i = 0; i < BEAMS; i++) {
            const a = Math.PI / 2 + Math.sin(spin * 3 + (i * Math.PI * 2) / BEAMS) * 1.25 + 0.15 * Math.sin(time * 0.9 + i);
            const hue = Math.round(((time * 0.08 + i / BEAMS) % 1) * 360);
            const alpha = (0.05 + 0.16 * foggy) * (0.6 + 0.4 * beat);
            const x1 = bc.x + Math.cos(a) * reach, y1 = bc.y + Math.sin(a) * reach;
            const spread = 0.045;
            const grad = g.createLinearGradient(bc.x, bc.y, x1, y1);
            grad.addColorStop(0, `hsla(${hue}, 95%, 70%, ${alpha})`);
            grad.addColorStop(0.6, `hsla(${hue}, 95%, 70%, ${alpha * 0.35})`);
            grad.addColorStop(1, `hsla(${hue}, 95%, 70%, 0)`);
            g.fillStyle = grad;
            g.beginPath();
            g.moveTo(bc.x, bc.y);
            g.lineTo(bc.x + Math.cos(a - spread) * reach, bc.y + Math.sin(a - spread) * reach);
            g.lineTo(bc.x + Math.cos(a + spread) * reach, bc.y + Math.sin(a + spread) * reach);
            g.closePath();
            g.fill();
        }
        // Spots: dots of light on a sphere round the ball, moving across
        // the screen as it turns (faster at its equator), in colour.
        for (const f of this.flecks) {
            const a = (f.a + spin * 6 * (1.2 - Math.abs(f.y - 0.5))) % (Math.PI * 2);
            const x = (a / (Math.PI * 2)) * W * 1.2 - W * 0.1;
            const y = f.y * H;
            const tw = 0.55 + 0.45 * Math.sin(time * 7 + f.a * 9);
            const hue = Math.round(((f.hue + time * 0.03) % 1) * 360);
            const r = f.s * (2 + beat);
            const grad = g.createRadialGradient(x, y, 0, x, y, r);
            grad.addColorStop(0, `hsla(${hue}, 90%, 82%, ${0.75 * tw})`);
            grad.addColorStop(1, "rgba(255,255,255,0)");
            g.fillStyle = grad;
            g.fillRect(x - r, y - r, r * 2, r * 2);
        }
        // Glints on the ball: four-point stars flashing.
        const R = disco.radius * this.k;
        for (let i = 0; i < 5; i++) {
            const ph = (time * 1.3 + i * 0.37) % 1;
            const life = Math.sin(Math.PI * ph);
            const a = i * 2.4 + Math.floor(time * 1.3 + i * 0.37) * 1.7;
            const x = bc.x + Math.cos(a) * R * 0.7, y = bc.y + Math.sin(a) * R * 0.7;
            const l = R * (0.25 + 0.35 * life);
            g.strokeStyle = `rgba(255,255,255,${0.9 * life})`;
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(x - l, y); g.lineTo(x + l, y);
            g.moveTo(x, y - l); g.lineTo(x, y + l);
            g.stroke();
        }
        g.restore();
    }

    /** A campfire's or the galaxy projector's night: the screen darkened,
     *  the fire's glow round it and its embers rising, the projector's
     *  stars and nebula turning round it, now and then a shooting star. */
    _drawNight(g, night, W, H, dt) {
        g.fillStyle = `rgba(6,8,22,${(Math.max(...night.map((t) => t.def.lamp.night)) * DESK_NIGHT).toFixed(3)})`;
        g.fillRect(0, 0, W, H);
        g.save();
        g.globalCompositeOperation = "lighter";
        for (const t of night) {
            const L = t.def.lamp;
            if (L.fire) this._fire2d(g, t, dt);
            if (L.stars) this._sky2d(g, t, W, H, dt);
        }
        g.restore();
    }

    _fire2d(g, t, dt) {
        const L = t.def.lamp, k = this.k, time = this.time;
        const c = this.toPx(add(t.p, v3(...L.at)));
        // Breathing with its puffing (catalog puffHz), as in the room.
        const w = 2 * Math.PI * puffHz(L.fire) * time;
        const flick = 0.82 + 0.12 * Math.sin(w) + 0.06 * Math.sin(2.7 * w + 1.1);
        const col = lampLight(t.def, t.shade || 0).color;
        const R = FIRE_GLOW_M * k;
        const grad = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
        grad.addColorStop(0, rgba(col, 0.35 * flick));
        grad.addColorStop(0.4, rgba(col, 0.12 * flick));
        grad.addColorStop(1, rgba(col, 0));
        g.fillStyle = grad;
        g.fillRect(c.x - R, c.y - R, R * 2, R * 2);
        // Embers off the bed, as models3d's: rising on the eddies, slowing
        // as they cool, fading out.
        const bed = { x: t.p.x, y: t.p.y - t.radius };
        const spawn = (e, age = 0) => {
            Object.assign(e, {
                x: bed.x + rand(-0.13, 0.13), y: bed.y + rand(0.1, 0.3), vx: rand(-0.06, 0.06), vy: rand(0.5, 1.1),
                life: rand(1, 2.4), ph: rand(0, 6),
            });
            e.age = age * e.life;
            return e;
        };
        const list = (t._embers ||= Array.from({ length: EMBERS }, () => spawn({}, Math.random())));
        const ember = t.def.shades[t.shade || 0].flame[1];
        const r = Math.max(1.2, 0.006 * k);
        for (const e of list) {
            e.age += dt;
            if (e.age > e.life) spawn(e);
            e.x += (e.vx + 0.08 * Math.sin(time * 3 + e.ph)) * dt;
            e.y += e.vy * dt;
            e.vy *= 1 - 0.4 * dt;
            const p = this.toPx(e);
            g.fillStyle = rgba(ember, (1 - e.age / e.life) * (0.6 + 0.4 * Math.sin(time * 20 + e.ph * 3)));
            g.beginPath();
            g.arc(p.x, p.y, r, 0, Math.PI * 2);
            g.fill();
        }
    }

    _sky2d(g, t, W, H, dt) {
        const time = this.time;
        const c = this.toPx(t.p);
        t._spin = (t._spin || 0) + (dt * 2 * Math.PI) / t.def.lamp.turn;
        const spin = t._spin;
        const R = Math.hypot(W, H);
        // Clouds in the shade's colours, then the stars, all turning round
        // the projector.
        const sky = t.def.shades[t.shade || 0].sky;
        this._clouds ||= Array.from({ length: SKY_CLOUDS }, (_, i) => ({ a: rand(0, Math.PI * 2), r: rand(0.15, 0.75), s: rand(0.18, 0.35), i }));
        if (sky.length) {
            for (const cl of this._clouds) {
                const x = c.x + Math.cos(cl.a + spin) * cl.r * R, y = c.y + Math.sin(cl.a + spin) * cl.r * R, s = cl.s * R;
                const col = sky[cl.i % sky.length];
                const grad = g.createRadialGradient(x, y, 0, x, y, s);
                grad.addColorStop(0, rgba(col, 0.14));
                grad.addColorStop(1, rgba(col, 0));
                g.fillStyle = grad;
                g.fillRect(x - s, y - s, s * 2, s * 2);
            }
        }
        this._stars ||= Array.from({ length: SKY_STARS }, () => ({ a: rand(0, Math.PI * 2), r: Math.sqrt(Math.random()), s: rand(0.6, 1.8), ph: rand(0, 6), tw: rand(1.5, 4.5) }));
        for (const s of this._stars) {
            const x = c.x + Math.cos(s.a + spin) * s.r * R, y = c.y + Math.sin(s.a + spin) * s.r * R;
            if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
            g.fillStyle = `rgba(235,240,255,${(0.55 + 0.45 * Math.sin(time * s.tw + s.ph)).toFixed(3)})`;
            g.beginPath();
            g.arc(x, y, s.s, 0, Math.PI * 2);
            g.fill();
        }
        // A shooting star now and then, across the top half of the screen.
        const sh = (this._shoot ||= { next: rand(4, 10), t: -1 });
        if (sh.t < 0 && (sh.next -= dt) <= 0) {
            const dir = Math.random() < 0.5 ? -1 : 1;
            sh.a = { x: rand(0.15, 0.85) * W, y: rand(0.05, 0.35) * H };
            sh.b = { x: sh.a.x + dir * rand(0.15, 0.3) * W, y: sh.a.y + rand(0.05, 0.12) * H };
            sh.t = 0;
            this.shootingAt = now();
        }
        if (sh.t >= 0) {
            sh.t += dt / SHOOT_S;
            if (sh.t >= 1) {
                sh.t = -1;
                sh.next = rand(...SHOOT_EVERY);
                return;
            }
            const at = (u) => ({ x: sh.a.x + (sh.b.x - sh.a.x) * u, y: sh.a.y + (sh.b.y - sh.a.y) * u });
            const head = at(sh.t), tail = at(Math.max(0, sh.t - 0.35));
            const grad = g.createLinearGradient(tail.x, tail.y, head.x, head.y);
            const a = Math.sin(Math.PI * sh.t);
            grad.addColorStop(0, "rgba(255,255,255,0)");
            grad.addColorStop(1, `rgba(255,255,255,${(0.95 * a).toFixed(3)})`);
            g.strokeStyle = grad;
            g.lineWidth = 2;
            g.lineCap = "round";
            g.beginPath();
            g.moveTo(tail.x, tail.y);
            g.lineTo(head.x, head.y);
            g.stroke();
        }
    }
}

// ── the companion's body, for the toy routines (brains.js) ──────────────

class ScreenBody {
    constructor(stage, director) {
        this.stage = stage;
        this.d = director;
    }

    get rfx() { return this.d.fx; }
    get key() { return String(this.d.agentId ?? this.d.agentName ?? "companion"); }
    get inCall() { return false; }
    get height() { return this.d.body / this.stage.k; }
    get reach() { return this.height * 0.4; }

    page(p) { return this.stage.toPx(p); }

    _bone(names, fallbackUp) {
        const d = this.d;
        const p = d._bonesPx(names);
        if (!p) return add(this.pos(), v3(0, this.height * fallbackUp, 0));
        return this.stage.fromPx(d.box.left + p.x, d.box.top + p.y);
    }

    pos() { return this.stage.fromPx(this.d.b.x, this.d.b.y); }
    head() { return this._bone(["head"], 0.9); }

    /** The mouth: a little up from the head bone's root and toward the
     *  way they face (by eye). */
    mouth() { return add(this.head(), v3(0.04 * this.facingSign(), 0.05, 0)); }

    openMouth(shape, ms) { this.d.r.toyMouth?.(shape, ms); }
    chest() { return this._bone(["upperChest"], 0.7); }
    hand(side) { return this._bone([side === "left" ? "leftHand" : "rightHand"], 0.5); }
    facingSign() { const y = this.d.r._roam?.yaw || 0; return Math.abs(y) < 0.2 ? 1 : Math.sign(y); }
    facing() { return v3(this.facingSign(), 0, 0); }

    userPoint() { return this.stage.userPoint(); }

    async goTo(point, ctx, { gap = 0.3, run = false, chase = null } = {}) {
        const d = this.d, st = this.stage, k = st.k;
        await d._until(() => d.b.mode === "ground", ctx, 8000);
        // The surface under the point: a window top, or the floor.
        const want = st._ledges.find((l) => point.x >= l.x0 && point.x <= l.x1 && Math.abs(point.y - l.y) < 0.6) || null;
        const onId = d.b.surf?.id ?? "floor";
        if (want && want.id !== onId) {
            const surf = d.world.ledges(d.body * 0.9).find((l) => l.id === want.id);
            if (!surf) return false;
            const x = Math.max(surf.x0 + d.body * 0.2, Math.min(surf.x1 - d.body * 0.2, point.x * k));
            const hop = d.hopTargets().find((h) => h.ledge.id === surf.id);
            if (hop) await d._hop(surf, x, ctx);
            else {
                await d._vanish();
                await d._wait(250, ctx);
                d._rest();
                await d._appear(() => d._stand(surf, x), ctx);
            }
        } else if (!want && onId !== "floor") {
            // Down to the floor first, off the nearer end.
            const s = d.b.surf;
            const end = Math.abs(d.b.x - s.x0) < Math.abs(d.b.x - s.x1) ? s.x0 - d.body * 0.3 : s.x1 + d.body * 0.3;
            d._hopping = true;
            try {
                await d._walkTo(end, ctx);
                await d._until(() => d.b.mode === "ground", ctx, 8000);
            } finally { d._hopping = false; }
        }
        const rate = run || st.wired() ? 1.7 : 1;
        const target = (p) => {
            const px = p.x * k;
            const side = Math.sign(d.b.x - px) || 1;
            return px + side * gap * k;
        };
        if (chase) {
            await this._chase(chase, gap, rate, ctx);
        } else {
            await d._walkTo(target(point), ctx, { rate });
        }
        return Math.abs(d.b.x - point.x * k) < (gap + 0.45) * k;
    }

    /** Walk after a moving point until within `gap` of it. */
    async _chase(chase, gap, rate, ctx) {
        const d = this.d, k = this.stage.k;
        const b = d.b;
        d._rest();
        d.walk = { to: b.x, dir: 1, rate, done: true };
        d.r.roamWalk(true, { rate: (1.25 * rate) / 1.4 });
        const t0 = now();
        try {
            while (now() - t0 < 12000) {
                await d._nextFrame();
                d._check(ctx);
                const p = chase();
                if (!p || b.mode !== "ground") break;
                const to = p.x * k + Math.sign(b.x - p.x * k || 1) * gap * k;
                if (Math.abs(to - b.x) < 5) break;
                const dir = Math.sign(to - b.x);
                Object.assign(d.walk, { to, dir, done: false });
                d._face(dir);
            }
        } finally {
            d.walk = null;
            d.r.roamWalk(false);
            d._face(0);
        }
    }

    face(point) {
        const dx = point.x * this.stage.k - this.d.b.x;
        this.d._face(Math.abs(dx) < 2 ? 0 : dx);
    }

    faceUser() { this.d._face(0); }

    lookAt(point, ms) { this.d.r.lookAtPoint?.(this.page(point), ms); }

    play(url, ctx, { loop = false, maxMs = 9000 } = {}) {
        const p = this.d._play(url, ctx, { loop, maxMs });
        p.catch(() => {});
        return p;
    }

    rest() { this.d._rest(); }

    wait(ms, ctx) { return this.d._wait(ms, ctx); }

    check(ctx) { this.d._check(ctx); }

    // A toy's moment shows on the face only: no mood marks or bursts.
    emotion(name) { this.d.r.setEmotion?.(name, { explicit: false, marks: false }); }

    hold(toy, grip = "both") {
        toy.heldBy = "companion";
        toy.grip = grip;
        toy.hovering = false;
        // In their hands: no longer something the user just put down.
        toy._fresh = false;
        toy.wake();
        toy.surf = null;
    }

    /** From the user's hand to theirs. */
    take(toy, grip = "both") {
        if (this.stage.drag?.toy === toy) {
            this.stage.drag = null;
            this.stage._endDrag?.();
        }
        this.hold(toy, grip);
    }

    letGo(toy, v) {
        if (toy.heldBy !== "companion") return;
        toy.heldBy = null;
        toy.v = { ...v, z: 0 };
        toy.thrownAt = 0;
        toy.releasedAt = performance.now();
        toy.wake();
        this.stage.noteHit(toy, "companion");
    }

    say(text, ms = 1600) {
        const h = this.page(this.head());
        this.d.fx.say(text, h.x, h.y - this.d.body * 0.12, ms);
    }

    fx(name, a, b) { bodyFx(this, name, a, b); }

    note(text, opts) { this.stage.box?.note?.(text, opts); }
}

export { TOYS };
