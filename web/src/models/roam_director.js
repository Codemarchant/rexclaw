// Roam mode: between calls, the mascot companion leaves its little window
// and wanders the whole screen. They walk along the bottom of the screen
// and along the tops of other windows, hop up and drop down, sit with
// their legs over an edge, nap when you're away, peek in from the side,
// doodle on the screen, travel by portal, and (with a TypeSafe key) look
// at what's on the screen and play with it: tear a link off a page and eat
// it, run off with a window's close button, sit on a video to watch it,
// slide down a scrollbar, take a bath in a search box.
//
// The shape is a desktop pet's: named actions in groups with a condition
// and a cooldown, picked at random but never two of one group in a row,
// plus a handful of entrances (falling in from the top, running in,
// peeking in).
// What's new is the screen: the window list (desktop/roam_windows.js) gives
// the surfaces, and Jev boxes (server/routes/voice.py roam_look) give the
// things on them. Every desktop pet that walks on windows reads window
// rectangles; none uses vision to touch things on the screen.
//
// The overlay window covers the display's work area; the avatar's host
// element (a small box) is slid around inside it every frame, and the
// renderer keeps one fixed full-body shot of the character in it
// (avatar_renderer setRoam / roamMetrics / roamBonePx). Positions here are
// page CSS px. The body is tracked by its feet (b.x, b.y), or, for poses
// that hang off something, pinned by a bone to a point on the screen.

import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { RoamWorld } from "./roam_world";
import { RoamFx, DOODLE_KINDS } from "./roam_fx";
import { GAG_ACTIONS, installGags } from "./roam_gags";
import { MORE_GAG_ACTIONS, installMoreGags, lateNight } from "./roam_gags_more";
import { RoamEars } from "./roam_ears";

const VRMA = "/assets/vrma";
const CLIP = {
    sit: `${VRMA}/roam/sit.vrma`, hang: `${VRMA}/roam/hang.vrma`, fall: `${VRMA}/roam/fall.vrma`,
    land: `${VRMA}/roam/land.vrma`, eat: `${VRMA}/roam/eat.vrma`, carry: `${VRMA}/roam/carry.vrma`,
    sleep: `${VRMA}/roam/sleep.vrma`, peekL: `${VRMA}/roam/peek_l.vrma`, peekR: `${VRMA}/roam/peek_r.vrma`,
    throw: `${VRMA}/roam/throw.vrma`, paint: `${VRMA}/tool_motions/paint_canvas_loop.vrma`,
};
const IDLE_CLIPS = ["LookAround", "Thinking", "Relax", "Stretch", "Yawning"].map((n) => `${VRMA}/${n}.vrma`);
const EMOTE_CLIPS = ["Clapping", "Jump", "VRMA_03_peace_sign", "VRMA_05_spin", "Backflip", "BlowKiss",
    "VRMA_06_model_pose", "VRMA_02_greeting", "Surprised", "Blush"].map((n) => `${VRMA}/${n}.vrma`);
const DANCE_CLIPS = ["Dance", "BellyDance"].map((n) => `${VRMA}/${n}.vrma`);
const EXERCISE_CLIPS = ["PushUp", "Squat"].map((n) => `${VRMA}/${n}.vrma`);

// Body size while roaming, as the standing body's share of the screen
// height (the settings window's S / M / L).
export const ROAM_SIZES = [0.22, 0.3, 0.4];
// The host box's width per height: room for raised arms and a backflip.
const HOST_ASPECT = 0.8;
// The standing body's share of the host's height: the renderer's
// ROAM_BODY_FRAC (avatar_renderer.js), unless a gag asks for headroom.
const BODY_FRAC = 0.62;

// Motion. Gravity is the real one through the shot's px per metre (the
// body is drawn at its true height in metres). The stroll is the
// renderer's STAGE_SPEED (1.25 m/s, Epic's Behavior Tree Quick Start NPC
// patrol), and the walk clip's own pace MOVE_SPEED, so the feet keep pace.
const GRAVITY = 9.81;          // m/s²
const STROLL = 1.25;           // m/s
const WALK_CLIP_PACE = 1.4;    // m/s
const RUN_RATE = 1.7;          // × the stroll, running in (by eye)
const TURN_YAW = 70 * Math.PI / 180;   // walking three-quarters, face still showing (by eye)
// Pause between actions: Wait 4 s ± 1, the same Quick Start NPC.
const PAUSE_MIN_MS = 3000;
const PAUSE_MAX_MS = 5000;
// A hop reaches a ledge up to this many body heights above the feet and
// this far to the side; anything further is a portal trip. Cartoon
// physics, set by eye.
const HOP_UP_MAX = 2.0;
const HOP_SIDE_MAX = 2.5;
// A window pulled faster than this (px per update) throws them off
// instead of carrying them along — eSheep falls when its window moves,
// MateEngine's avatars ride along; a drag does the one, a jump the other.
const YANK_PX = 80;
// Moving slower than that but more than this, they wobble on it (by eye).
const SURF_PX = 10;
// The poses' contact points, as a share of the standing body height: the
// seat sits below the hips joint, the grip above the wrists (by eye on the
// authoring avatar).
const SEAT_BELOW_HIPS = 0.06;
const GRIP_ABOVE_WRIST = 0.035;
// How long a change of anchor (feet ↔ a pinned bone) blends, matching the
// gesture crossfade it rides on.
const ANCHOR_BLEND_S = 0.35;

// Looking at the screen (Jev boxes): at most this often, and a look counts
// for this long, while the foreground window hasn't moved. One look is two
// Jev requests (the boxes, and what the user is doing) plus a second look
// per thing found, ~4,000 input tokens a frame: about $0.0004-0.001 at
// $0.042 per million (jev.py), so ~$0.1 an hour at this rate.
const LOOK_EVERY_MS = 20000;
const LOOK_TTL_MS = 15000;
// Margin round the small things, as a share of their longer side (by eye,
// against Jev's loose box edges: a close button came out clipped).
const LOOK_PAD = { close: 0.35, icon: 0.2, taskbar: 0.2, button: 0.15, tab: 0.08, link: 0.1 };
// What stealClose may run off with, and how often each.
const STEALABLE = { close: 3, tab: 3, button: 2, address: 1 };
// Away long enough that coming back gets a hello (twice the nap's).
const AWAY_S = 600;
// Napping: after five minutes without input, Microsoft Teams' "Away"
// threshold, and awake again as soon as there is any.
const SLEEP_IDLE_S = 300;

// Two looks count as the same screen below this mean difference of a 32×18
// grey thumbnail (0-255 per pixel; by eye: a blinking caret or a clock
// ticking stays under it, a scroll or a new page doesn't).
const SAME_SCREEN = 2.5;

function screenSignature(canvas) {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 18;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    const out = new Uint8Array(32 * 18);
    for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) | 0;
    return out;
}

function sigDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const now = () => performance.now();

class Interrupt extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

export class RoamDirector {
    /** renderer: avatarRenderer. host: its canvas host element (moved
     *  around). root: the overlay root (CSS vars for the island). under /
     *  over: effect layers. bridge: window.rexclawDesktop. */
    /** agentId: the companion (their memories). onCallRequest: the
     *  page starts a call (the "call me?" sign was clicked). */
    constructor({ renderer, host, root, under, over, follow, bridge, agentName = "", agentId = null, tricks = true,
        size = 1, onCallRequest = null }) {
        this.r = renderer;
        this.host = host;
        this.root = root;
        this.bridge = bridge;
        this.fx = new RoamFx(under, over, follow || over);
        this.world = new RoamWorld();
        this.agentName = agentName;
        this.agentId = agentId;
        this.onCallRequest = onCallRequest;
        this.clipRect = null;         // page rect the body is cut to (inside a photo, a video)
        this.behindAll = false;       // hidden by every window (a kaiju behind them)
        this.music = false;           // music playing on the computer (roam_ears.js)
        this.tricks = tricks;
        this.sizeIdx = size;
        // Gags reshape the host for a while: size × sizeMul, width × aspect
        // (a sunbed, a kart), or a fixed box (a jump scare fills the screen);
        // tilt (deg) leans it (flying), originFeet scales it about the feet.
        this.sizeMul = 1;
        this.aspect = HOST_ASPECT;
        this.bodyFrac = BODY_FRAC;
        this.boxOverride = null;
        this.tilt = 0;
        this.originFeet = false;
        this.originPx = null;         // or {x, y} in host px: what tilt and scale turn about
        this._props = new Set();      // roam props out this action
        this.b = { x: 0, y: 0, vx: 0, vy: 0, mode: "ground", surf: null, surfAt: null };
        this.pin = null;            // {x, y, bones, dy, win, winRect}
        this.anchorW = 0;           // 0 = feet, 1 = pinned bone (eased)
        this.anchorTo = 0;
        this.scale = 1;
        this.clipLine = null;       // y below which the body is hidden (a bath)
        this.held = null;           // {sticker, bones, dy}
        this.cursor = null;
        this.walk = null;           // {to, dir, rate, offscreen}
        this.box = { left: 0, top: 0, width: 0, height: 0 };
        this.running = false;
        this.ctx = null;
        this._frameWaiters = [];
        this._lastGroup = null;
        this._cooldowns = new Map();
        this._look = null;          // last look: {at, fgId, fgRect, found, shot, scene, call}
        this._lookAt = 0;
        this._looking = false;
        this._lookOff = false;      // no TypeSafe key / no capture: stop asking
        this._captureFails = 0;
        this._zzz = null;
        this._last = 0;
    }

    // ── public ───────────────────────────────────────────────────────────

    start(area) {
        this.world.setArea(area);
        this.running = true;
        // Console handle: __roam.force("doodle") runs that action next.
        window.__roam = this;
        // Roaming starts between calls: an hour of this without one and
        // they sulk (the tantrum).
        this._lonelySince = now();
        // Listening to what plays (Windows; only with the screen-aware
        // tricks on, the same consent as looking at the screen).
        if (this.tricks) {
            this.ears = new RoamEars({
                onMusic: (on) => { this.music = on; },
                onBeat: () => { this._lastBeat = now(); },
                onStartle: () => this._react("startle"),
                onDrop: () => { if (this.music) this._react("air_guitar"); },
            });
            this.ears.start(this.bridge).catch(() => {});
        }
        this._applySize();
        this.host.style.opacity = "0";
        this._raf = requestAnimationFrame((t) => this._tick(t));
        this._brain().catch((e) => console.error("[roam] brain stopped", e));
    }

    /** Leave: a portal out (unless `fast`), then everything stops. */
    async stop({ fast = false } = {}) {
        if (!this.running) return;
        this._interrupt("stop");
        if (!fast && this.r.roamMetrics()) {
            try { await this._vanish(); } catch (e) { /* stopping anyway */ }
        }
        this.running = false;
        if (window.__roam === this) delete window.__roam;
        this.ears?.stop();
        this.ears = null;
        cancelAnimationFrame(this._raf);
        for (const w of this._frameWaiters) w();
        this._frameWaiters = [];
        this.r.roamWalk(false);
        this.r.stopGesture?.();
        this._zzz?.stop();
        for (const p of this._props) p.dispose();
        this._props.clear();
        if (this._buried) { clearTimeout(this._buried.expire); this._buried = null; }
        this.r.setRoamShot?.("full");
        this.fx.clear();
        // Still hidden: the caller shows them again once the window is back
        // to its own size (a frame in between would fill the whole screen).
        Object.assign(this.host.style, {
            position: "", left: "", top: "", width: "", height: "",
            transform: "", transformOrigin: "", clipPath: "", opacity: "0", filter: "",
        });
        this.root.style.removeProperty("--roam-island-x");
        this.root.style.removeProperty("--roam-island-y");
    }

    setEnv(env) {
        this.world.setEnv(env);
        if (this.world.fullscreen && this.ctx && !this._hidden) this._interrupt("hide");
        // Back at the keyboard: a napping companion wakes up — and after a
        // long time away, comes over to say hello.
        if (this.world.idle >= AWAY_S) this._wasAway = true;
        if (this.world.idle < 2) {
            if (this._napping) this._interrupt("wake");
            if (this._wasAway) {
                this._wasAway = false;
                this._forced ||= "welcome_back";
            }
        }
    }

    /** Something happened that they react to at once (a loud sound, the
     *  bass dropping): it runs next, cutting short what they're doing,
     *  unless they're asleep or already in the middle of a big moment. */
    _react(id) {
        if (!this.running || this._napping || this._forced) return;
        if (this.b.mode !== "ground" || this._currentId === "music_dance" && id !== "air_guitar") return;
        // Not every loud moment of a film: a reaction keeps its cooldown.
        const a = ACTIONS.find((x) => x.id === id);
        if (now() - (this._cooldowns.get(id) ?? -Infinity) < (a?.cooldown || 0) * 1000) return;
        this._forced = id;
        this._interrupt("forced");
    }

    /** The overlay moved to another display or the work area changed size. */
    setArea(area) {
        this.world.setArea(area);
        this._applySize();
        this._interrupt("area");
    }

    setCursor(c) {
        if (!c) { this.cursor = null; return; }
        const moved = !this.cursor || Math.abs(c.x - this.cursor.x) + Math.abs(c.y - this.cursor.y) > 2;
        this.cursor = { x: c.x, y: c.y, movedAt: moved ? now() : this.cursor.movedAt };
    }

    setPrefs({ tricks, size, agentName }) {
        if (tricks !== undefined) this.tricks = !!tricks;
        if (agentName !== undefined) this.agentName = agentName;
        if (size !== undefined && size !== this.sizeIdx) {
            this.sizeIdx = size;
            this._applySize();
        }
    }

    /** The host's on-screen rectangle (for the page's hover test). */
    get rect() { return { ...this.box }; }

    // ── frame loop ───────────────────────────────────────────────────────

    _applySize() {
        const frac = (ROAM_SIZES[this.sizeIdx] ?? ROAM_SIZES[1]) * this.sizeMul;
        // The renderer draws the standing body at bodyFrac of the host's
        // height (its ROAM_BODY_FRAC unless a gag wants room overhead); the
        // width goes with the body, not the headroom.
        const bodyPx = this.world.area.height * frac;
        let h = Math.round(bodyPx / this.bodyFrac);
        let w = Math.round((bodyPx / BODY_FRAC) * this.aspect);
        if (this.boxOverride) ({ width: w, height: h } = this.boxOverride);
        this.r.setRoamBodyFrac?.(this.bodyFrac);
        this.box.width = w;
        this.box.height = h;
        Object.assign(this.host.style, {
            position: "absolute", left: "0px", top: "0px", width: `${w}px`, height: `${h}px`,
        });
    }

    get m() { return this.r.roamMetrics(); }

    /** Standing body height in px (once the avatar has loaded). */
    get body() { return this.m?.bodyPx || this.box.height * this.bodyFrac; }

    _nextFrame() {
        return new Promise((resolve) => this._frameWaiters.push(resolve));
    }

    _tick(t) {
        if (!this.running) return;
        this._raf = requestAnimationFrame((tt) => this._tick(tt));
        const dt = Math.min(0.05, this._last ? (t - this._last) / 1000 : 0);
        this._last = t;
        const m = this.m;
        if (m) {
            this._physics(dt, m);
            this._place(dt, m);
        }
        const waiters = this._frameWaiters;
        this._frameWaiters = [];
        for (const w of waiters) w();
    }

    _physics(dt, m) {
        const b = this.b;
        const g = GRAVITY * m.pxPerM;
        const headroom = this.body * 0.9;
        if (b.mode === "ground") {
            const s = this.world.refresh(b.surf, headroom, b.x);
            if (!s) { this._lostSurface(b.surf?.win); return; }
            if (s.id !== "floor") {
                // Ride along with the window, or get thrown off by a yank.
                const w = this.world.window(s.win);
                if (w && b.surfAt) {
                    const dx = w.x - b.surfAt.x, dy = w.y - b.surfAt.y;
                    if (Math.abs(dx) > YANK_PX || Math.abs(dy) > YANK_PX) {
                        // Flung the way the window went, with a little lift.
                        b.surfAt = null;
                        this._toAir({ vx: Math.sign(dx) * 1.8 * m.pxPerM, vy: -1.5 * m.pxPerM });
                        return;
                    }
                    // Surfing a window you drag about: they wobble.
                    if (Math.abs(dx) + Math.abs(dy) > SURF_PX) {
                        this._wobbleAt = now();
                        if (Math.abs(dx) > SURF_PX * 2.5 && now() - (this._whoaAt || 0) > 3000) {
                            this._whoaAt = now();
                            const head = this.r.roamBonePx("head");
                            if (head) this.fx.say(_t("whoa!"), this.box.left + head.x, this.box.top + head.y - this.body * 0.1, 1000);
                        }
                    }
                    b.x += dx;
                }
                if (w) b.surfAt = { x: w.x, y: w.y };
            }
            b.surf = s;
            b.y = s.y;
            if (this.walk) {
                const speed = STROLL * this.walk.rate * m.pxPerM;
                b.x += this.walk.dir * speed * dt;
                if ((this.walk.dir > 0 && b.x >= this.walk.to) || (this.walk.dir < 0 && b.x <= this.walk.to)) {
                    b.x = this.walk.to;
                    this.walk.done = true;
                }
                // Walked off a window's edge.
                if (s.id !== "floor" && (b.x < s.x0 || b.x > s.x1)) {
                    this._toAir({ vx: this.walk.dir * speed * 0.8 });
                }
            }
        } else if (b.mode === "air") {
            b.vy += g * dt;
            const ny = b.y + b.vy * dt;
            const nx = b.x + b.vx * dt;
            const land = b.vy > 0 ? this.world.landing(nx, b.y, ny, headroom) : null;
            b.x = Math.min(this.world.area.width + this.body, Math.max(-this.body, nx));
            if (land) {
                b.y = land.y;
                b.vx = b.vy = 0;
                b.mode = "ground";
                b.surf = land;
                const w = land.win ? this.world.window(land.win) : null;
                b.surfAt = w ? { x: w.x, y: w.y } : null;
                this._landed = now();
                if (!this._quietLanding) this.r.playGesture?.(CLIP.land);
                this._quietLanding = false;
            } else {
                b.y = ny;
            }
        } else if (b.mode === "scripted") {
            // A gag moves them itself.
        } else if (b.mode === "pinned") {
            const p = this.pin;
            if (p?.win) {
                const w = this.world.window(p.win);
                const r = p.winRect;
                if (!w) {
                    this._lostSurface(p.win);
                } else if (Math.abs(w.x - r.x) > 3 || Math.abs(w.y - r.y) > 3
                    || Math.abs(w.width - r.width) > 3 || Math.abs(w.height - r.height) > 3) {
                    this._toAir();
                }
            }
        }
    }

    /** Where the host goes this frame: under the feet, or with the pinned
     *  bone on its point, eased between the two when that changes. */
    _place(dt, m) {
        const b = this.b;
        const feet = { left: b.x - m.footX, top: b.y - m.footY };
        let left = feet.left, top = feet.top;
        const step = dt / ANCHOR_BLEND_S;
        this.anchorW += Math.max(-step, Math.min(step, this.anchorTo - this.anchorW));
        // Eased all the way back onto the feet: the pin has done its job.
        if (this.pin && this.anchorW <= 0 && this.anchorTo === 0 && b.mode !== "pinned") this.pin = null;
        if (this.pin && this.anchorW > 0) {
            const bp = this._bonesPx(this.pin.bones);
            if (bp) {
                const pinned = { left: this.pin.x - bp.x, top: this.pin.y - (bp.y + this.pin.dy * this.body) };
                const w = this.anchorW * this.anchorW * (3 - 2 * this.anchorW);
                left = feet.left + (pinned.left - feet.left) * w;
                top = feet.top + (pinned.top - feet.top) * w;
            }
        }
        if (this.boxOverride) ({ left, top } = this.boxOverride);
        this.box.left = left;
        this.box.top = top;
        let ox = m.footX, oy = this.originFeet ? m.footY : m.footY - this.body * 0.5;
        if (this.originPx) ({ x: ox, y: oy } = this.originPx);
        this.host.style.transformOrigin = `${ox}px ${oy}px`;
        // A wobble while the window under them is dragged about.
        const since = this._wobbleAt ? now() - this._wobbleAt : Infinity;
        const tilt = this.tilt + (since < 1500 ? Math.sin(since / 45) * 7 * Math.exp(-since / 500) : 0);
        this.host.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) scale(${this.scale.toFixed(3)})`
            + (tilt ? ` rotate(${tilt.toFixed(1)}deg)` : "");
        this._occlude();
        if (this.held) {
            const hp = this._bonesPx(this.held.bones);
            if (hp) this.held.sticker.moveTo(left + hp.x, top + hp.y + this.held.dy * this.body, this.held.angle || 0);
        }
        if (this._zzz) {
            const head = this.r.roamBonePx("head");
            if (head) this._zzz.move(left + head.x + this.body * 0.06, top + head.y - this.body * 0.08);
        }
        // The controls island hangs just under the feet (or the box), kept on screen.
        const ix = Math.min(this.world.area.width - 120, Math.max(120, left + m.footX));
        const iy = Math.min(this.world.area.height - 44, Math.max(4, top + m.footY + 6));
        this.root.style.setProperty("--roam-island-x", `${ix}px`);
        this.root.style.setProperty("--roam-island-y", `${iy}px`);
    }

    _bonesPx(bones) {
        let x = 0, y = 0, n = 0;
        for (const name of bones) {
            const p = this.r.roamBonePx(name);
            if (p) { x += p.x; y += p.y; n++; }
        }
        return n ? { x: x / n, y: y / n } : null;
    }

    /** Hidden by the windows in front of the one they're on (or in), or by
     *  every window (behindAll), below a bath's waterline, and outside a
     *  clipRect (inside a photo or a video). */
    _occlude() {
        const depth = this.b.mode === "pinned" ? this.pin?.win : (this.b.mode === "ground" ? this.b.surf?.win : null);
        const { left, top, width, height } = this.box;
        const holes = [];
        for (const w of this.behindAll ? this.world.windows : this.world.inFront(depth ?? null)) {
            const x0 = Math.max(left, w.x), y0 = Math.max(top, w.y);
            const x1 = Math.min(left + width, w.x + w.width), y1 = Math.min(top + height, w.y + w.height);
            if (x1 > x0 && y1 > y0) holes.push([x0 - left, y0 - top, x1 - x0, y1 - y0]);
        }
        // The outline they're drawn within, in the host's own px.
        let ox0 = 0, oy0 = 0, ox1 = width;
        let oy1 = this.clipLine != null ? Math.max(0, Math.min(height, this.clipLine - top)) : height;
        if (this.clipRect) {
            const c = this.clipRect;
            ox0 = Math.max(ox0, c.x - left);
            oy0 = Math.max(oy0, c.y - top);
            ox1 = Math.min(ox1, c.x + c.width - left);
            oy1 = Math.min(oy1, c.y + c.height - top);
            if (ox1 <= ox0 || oy1 <= oy0) { ox1 = ox0; oy1 = oy0; }
        }
        if (!holes.length && ox0 <= 0 && oy0 <= 0 && ox1 >= width && oy1 >= height) {
            if (this._clipKey) { this.host.style.clipPath = ""; this._clipKey = ""; }
            return;
        }
        const d = `M${ox0.toFixed(1)} ${oy0.toFixed(1)}H${ox1.toFixed(1)}V${oy1.toFixed(1)}H${ox0.toFixed(1)}Z`
            + holes.map(([x, y, w, hh]) => `M${x.toFixed(1)} ${y.toFixed(1)}h${w.toFixed(1)}v${hh.toFixed(1)}h${(-w).toFixed(1)}Z`).join("");
        if (d !== this._clipKey) {
            this._clipKey = d;
            this.host.style.clipPath = `path(evenodd, "${d}")`;
        }
    }

    /** The window under them is gone. Minimized: they go down into the
     *  taskbar with it. Closed: a cartoon pause in mid-air, a "help!" sign,
     *  the drop. Anything else (moved, covered over): they just fall. */
    _lostSurface(win) {
        const gone = win != null && !this.world.window(win);
        const kind = !gone ? null : (this.world.minimized?.has(win) ? "sucked_away" : "help_sign");
        if (!kind || !this.running || this._hopping || this._surfaceGag) { this._toAir(); return; }
        const m = this.m;
        // Where the body is drawn now becomes where it stands (a pinned
        // pose's feet are wherever the pose put them).
        if (m && (this.b.mode === "pinned" || this.anchorW > 0)) {
            this.b.x = this.box.left + m.footX;
            this.b.y = this.box.top + m.footY;
        }
        this.pin = null;
        this.anchorW = this.anchorTo = 0;
        this.walk = null;
        this.b.mode = "scripted";
        this._surfaceGag = kind;
        this._interrupt("surface");
    }

    /** Lose the footing (or let go): fall from where the body is drawn now. */
    _toAir({ vx = 0, vy = 0 } = {}) {
        if (!this.running) return;
        const m = this.m;
        const b = this.b;
        // A pinned pose: the feet are wherever the pose put them.
        if (m && (b.mode === "pinned" || this.anchorW > 0)) {
            b.x = this.box.left + m.footX;
            b.y = this.box.top + m.footY;
        }
        b.vx = vx;
        b.vy = vy;
        b.mode = "air";
        b.surf = null;
        b.surfAt = null;
        this.pin = null;
        this.anchorW = this.anchorTo = 0;
        this.clipLine = null;
        this.walk = null;
        this.r.roamWalk(false);
        this.r.roamFace(0);
        if (!this._quietFall) this.r.playGesture?.(CLIP.fall, { loop: true });
        this._quietFall = false;
        if (this.ctx && !this._hopping) this._interrupt("fall");
    }

    // ── primitives ───────────────────────────────────────────────────────

    _interrupt(reason) {
        if (this.ctx && !this.ctx.cancelled) this.ctx.cancelled = reason;
    }

    _check(ctx) {
        if (!this.running) throw new Interrupt("stop");
        if (ctx?.cancelled) throw new Interrupt(ctx.cancelled);
    }

    async _wait(ms, ctx) {
        const end = now() + ms;
        while (now() < end) {
            await this._nextFrame();
            this._check(ctx);
        }
    }

    async _until(fn, ctx, maxMs = 20000) {
        const end = now() + maxMs;
        while (!fn() && now() < end) {
            await this._nextFrame();
            this._check(ctx);
        }
    }

    /** A pose clip. Loops hold until something else takes the body;
     *  one-shots resolve when they end (or after `maxMs`). */
    async _play(url, ctx, { loop = false, maxMs = 9000 } = {}) {
        this.r.roamWalk(false);
        const action = await this.r.playGesture?.(url, { loop });
        this._check(ctx);
        if (loop || !action) return;
        await this._until(() => !action.isRunning(), ctx, maxMs);
    }

    _rest() { this.r.stopGesture?.(); }

    _face(dir) { this.r.roamFace(dir ? Math.sign(dir) * TURN_YAW : 0); }

    /** Walk along the current surface to x (off its end with `offscreen`
     *  on the floor; a ledge's end drops them off). */
    async _walkTo(x, ctx, { rate = 1, upper = null, offscreen = false } = {}) {
        const b = this.b;
        if (b.mode !== "ground") return;
        const s = b.surf || this.world.floor();
        if (s.id === "floor" && !offscreen) {
            const pad = this.body * 0.3;
            x = Math.max(pad, Math.min(this.world.area.width - pad, x));
        }
        if (Math.abs(x - b.x) < 4) return;
        const dir = Math.sign(x - b.x);
        this._rest();
        this._face(dir);
        this.walk = { to: x, dir, rate, done: false };
        this.r.roamWalk(true, { rate: (STROLL * rate) / WALK_CLIP_PACE, upperUrl: upper });
        try {
            await this._until(() => this.walk?.done || b.mode !== "ground", ctx, 60000);
        } finally {
            this.walk = null;
            this.r.roamWalk(false);
            this._face(0);
        }
    }

    /** Hop onto `ledge` at x: a ballistic arc with its top a little above
     *  the ledge, tucked mid-air (the fall pose), landing on it. */
    async _hop(ledge, x, ctx) {
        const m = this.m;
        const b = this.b;
        const g = GRAVITY * m.pxPerM;
        const rise = b.y - ledge.y + this.body * 0.18;
        const vy = -Math.sqrt(2 * g * Math.max(this.body * 0.2, rise));
        const tUp = -vy / g;
        const tDown = Math.sqrt((2 * this.body * 0.18) / g);
        this._rest();
        this._hopping = true;
        try {
            this._toAir({ vx: (x - b.x) / (tUp + tDown), vy });
            await this._until(() => b.mode === "ground", ctx, 6000);
        } finally {
            this._hopping = false;
            this._face(0);
        }
    }

    /** Shrink into a portal where they are. */
    async _vanish() {
        const m = this.m;
        const cx = this.box.left + m.footX, cy = this.box.top + m.footY - this.body * 0.5;
        const ring = this.fx.portal(cx, cy, this.body * 0.9);
        await this._tween(220, (s) => { this.scale = 1 - 0.1 * s; });
        await this._tween(380, (s) => { this.scale = 0.9 * (1 - s); this.host.style.opacity = String(1 - s * 0.6); });
        this.host.style.opacity = "0";
        ring.close();
    }

    /** Pop out of a portal: `place()` puts the body at its destination
     *  first (feet on a surface, or a pinned pose). */
    async _appear(place, ctx) {
        place();
        this.scale = 0;
        await this._nextFrame();   // the new spot's box before the ring
        const m = this.m;
        const cx = this.box.left + m.footX, cy = this.box.top + m.footY - this.body * 0.5;
        const ring = this.fx.portal(cx, cy, this.body * 0.9);
        // Visible again: "" so ghost mode's fade class still applies.
        this.host.style.opacity = "";
        await this._tween(420, (s) => { this.scale = s * (1 + 0.12 * Math.sin(s * Math.PI)); });
        this.scale = 1;
        ring.close();
        this._check(ctx);
    }

    async _tween(ms, fn) {
        const start = now();
        for (;;) {
            const s = Math.min(1, (now() - start) / ms);
            fn(s);
            if (s >= 1 || !this.running) return;
            await this._nextFrame();
        }
    }

    _stand(surf, x) {
        const b = this.b;
        b.mode = "ground";
        b.surf = surf;
        b.x = x;
        b.y = surf.y;
        const w = surf.win ? this.world.window(surf.win) : null;
        b.surfAt = w ? { x: w.x, y: w.y } : null;
        this.pin = null;
        this.anchorW = this.anchorTo = 0;
    }

    /** Pin `bones` (averaged) to (x, y), `dy` body heights below it; on
     *  `win`, they fall off once that window moves. */
    _pinTo(x, y, bones, dy, win, { snap = true } = {}) {
        const w = win ? this.world.window(win) : null;
        this.pin = { x, y, bones, dy, win: w ? win : null, winRect: w ? { ...w } : null };
        this.b.mode = "pinned";
        this.anchorTo = 1;
        if (snap) this.anchorW = 1;
    }

    /** Off a pinned pose back onto the feet on `surf`, easing over (the pin
     *  goes once the ease is done, see _place). */
    _unpin(surf) {
        const b = this.b;
        b.mode = "ground";
        b.surf = surf;
        b.y = surf.y;
        const w = surf.win ? this.world.window(surf.win) : null;
        b.surfAt = w ? { x: w.x, y: w.y } : null;
        this.anchorTo = 0;
    }

    // ── brain ────────────────────────────────────────────────────────────

    async _brain() {
        await this._untilLoaded();
        let entered = false;
        while (this.running) {
            const ctx = this.ctx = { cancelled: null };
            try {
                if (this.world.fullscreen) {
                    await this._hide(ctx);
                    entered = false;
                    continue;
                }
                if (!entered) {
                    await this._entrance(ctx);
                    entered = true;
                }
                if (!this._forced) await this._wait(rand(PAUSE_MIN_MS, PAUSE_MAX_MS) * (this._sinceLanding() < 1500 ? 0.4 : 1), ctx);
                await this._maybeLook(ctx);
                const act = this._pick();
                if (act) {
                    if (this._pickedForced) await this._prepare(act, ctx);
                    this._lastGroup = act.group;
                    this._cooldowns.set(act.id, now());
                    this._currentId = act.id;
                    const t0 = now();
                    await act.run.call(this, ctx);
                    // Asked for ("Do it") and over at once: it found nothing
                    // to work with. A shrug says so, not nothing at all.
                    if (this._pickedForced && now() - t0 < 150) {
                        this._face(0);
                        const h = this._bonesPx(["head"]);
                        this.fx.say("?", this.box.left + (h?.x ?? this.box.width / 2),
                            this.box.top + (h?.y ?? this.box.height * 0.1) - this.body * 0.12, 1600);
                        await this._play(`${VRMA}/Thinking.vrma`, ctx, { maxMs: 2500 });
                    }
                }
            } catch (e) {
                if (!(e instanceof Interrupt)) console.error("[roam] action failed", e);
                if (e?.reason === "area") entered = false;
            } finally {
                this._currentId = null;
                this._cleanupAction();
                this.fx.endAction();
            }
            if (!this.running) return;
            // The window under them went (a minimize, a close): that
            // moment plays out first.
            if (this._surfaceGag) {
                const run = this[{ sucked_away: "suckedAway", help_sign: "helpSign" }[this._surfaceGag]];
                this._surfaceGag = null;
                const c = this.ctx = { cancelled: null };
                try { await run.call(this, c); } catch (e) { if (!(e instanceof Interrupt)) console.error("[roam] action failed", e); }
                finally { this._cleanupAction(); }
                if (!this.running) return;
            }
            // Down to earth before anything else.
            if (this.b.mode === "air") {
                const c = this.ctx = { cancelled: null };
                try { await this._until(() => this.b.mode !== "air", c, 15000); } catch (e) { /* next round */ }
                if (this.b.mode === "air") this._stand(this.world.floor(), Math.min(this.world.area.width - 50, Math.max(50, this.b.x)));
            }
            // Thrown off the side of the screen (a flick off the pointer):
            // back on before anything else, or the next gag plays unseen.
            const pad = this.body * 0.4, right = this.world.area.width - pad;
            if (this.b.mode === "ground" && (this.b.x < pad || this.b.x > right)) {
                const c = this.ctx = { cancelled: null };
                try {
                    await this._walkTo(Math.min(right, Math.max(pad, this.b.x)), c, { offscreen: true });
                } catch (e) { /* next round */ }
            }
        }
    }

    _cleanupAction() {
        // stop() has already put everything away.
        if (!this.running) return;
        this.walk = null;
        this.clipLine = null;
        this._napping = false;
        if (this._zzz) { this._zzz.stop(); this._zzz = null; }
        if (this._bubbles) { this._bubbles.stop(); this._bubbles = null; }
        if (this.held && !this.held.keep) { this.held.sticker.fade(250); this.held = null; }
        if (this._patch) { const p = this._patch; this._patch = null; setTimeout(() => p.fade(600), 900); }
        // A window just went from under them: they stay put for that moment
        // (the brain plays it next).
        if (this._surfaceGag) return;
        this._resetGag();
        if (this.b.mode === "pinned" || this.b.mode === "scripted") this._toAir();
        this.r.roamWalk(false);
    }

    /** Whatever a gag reshaped goes back: props away, the normal box. */
    _resetGag() {
        for (const p of this._props) {
            p.hide();
            setTimeout(() => p.dispose(), 300);
        }
        this._props.clear();
        this._gagStops?.forEach((f) => { try { f(); } catch (e) { /* gone */ } });
        this._gagStops = [];
        const resized = this.sizeMul !== 1 || this.aspect !== HOST_ASPECT || this.boxOverride || this.bodyFrac !== BODY_FRAC;
        this.sizeMul = 1;
        this.aspect = HOST_ASPECT;
        this.bodyFrac = BODY_FRAC;
        this.boxOverride = null;
        if (resized) this._applySize();
        this.tilt = 0;
        this.originFeet = false;
        this.originPx = null;
        this.clipRect = null;
        this.behindAll = false;
        this.r.setRoamShot?.("full");
        this.host.style.filter = "";
        if (this.scale !== 1 && this.b.mode !== "air") {
            this.scale = 1;
            this.host.style.opacity = "";
        }
    }

    /** A roam prop (props.json) out for this action, shown at once. */
    async prop(id) {
        const h = await this.r.roamProp?.(id);
        if (!h) return null;
        if (!this.running) { h.dispose(); return null; }
        this._props.add(h);
        h.show();
        return h;
    }

    /** Something to stop when the action ends (a rain cloud, a sun). */
    onEnd(fn) {
        (this._gagStops ||= []).push(fn);
    }

    _sinceLanding() { return this._landed ? now() - this._landed : Infinity; }

    async _untilLoaded() {
        while (this.running && !this.m) await this._nextFrame();
    }

    async _hide(ctx) {
        this.host.style.opacity = "0";
        this._hidden = true;
        try {
            await this._until(() => !this.world.fullscreen, ctx, 3600000);
        } finally {
            this._hidden = false;
        }
    }

    /** The entrances: falling in, peeking in, running in, a portal, a
     *  parachute. */
    async _entrance(ctx) {
        const { width } = this.world.area;
        const floor = this.world.floor();
        this.scale = 1;
        const kind = pick(["fall", "run", "peek", "portal", "parachute"]);
        if (kind === "parachute") {
            await this.parachuteDown(rand(width * 0.15, width * 0.85), ctx);
            return;
        }
        if (kind === "fall") {
            const x = rand(width * 0.15, width * 0.85);
            this._stand(floor, x);
            this.b.y = -this.body * 0.1;
            this.host.style.opacity = "";
            this._hopping = true;   // a planned fall, not an interruption
            try {
                this._toAir();
                await this._until(() => this.b.mode === "ground", ctx, 8000);
            } finally {
                this._hopping = false;
            }
            return;
        }
        if (kind === "portal") {
            await this._appear(() => this._stand(floor, rand(width * 0.2, width * 0.8)), ctx);
            return;
        }
        const fromLeft = Math.random() < 0.5;
        const off = this.body * 0.45;
        this._stand(floor, fromLeft ? -off : width + off);
        this.host.style.opacity = "";
        if (kind === "peek") {
            await this._peekAt(fromLeft, ctx, rand(2500, 4000));
        }
        await this._walkTo(fromLeft ? rand(width * 0.15, width * 0.4) : rand(width * 0.6, width * 0.85), ctx,
            { rate: kind === "run" ? RUN_RATE : 1, offscreen: true });
    }

    /** Peek in from a screen edge: body behind the edge, leaning out. */
    async _peekAt(fromLeft, ctx, ms) {
        const { width } = this.world.area;
        this.b.x = fromLeft ? -this.body * 0.12 : width + this.body * 0.12;
        await this._play(fromLeft ? CLIP.peekL : CLIP.peekR, ctx, { loop: true });
        await this._wait(ms, ctx);
        this._rest();
    }

    /** Run action `id` now, ignoring odds and cooldowns (interrupting what
     *  is running): the settings window's "Try one now". When it isn't
     *  possible as things are, they first try to make it so (_prepare). */
    force(id) {
        if (!ACTIONS.some((x) => x.id === id)) return false;
        this._forced = id;
        this._interrupt("forced");
        return true;
    }

    /** Before a forced action that can't run yet: a fresh look at the
     *  screen (it may need something Jev finds), down off a ledge (it may
     *  need the floor), and onto their feet. It runs either way after; one
     *  with nothing to work with just doesn't happen. */
    async _prepare(a, ctx) {
        // Asked for again on a screen that hasn't changed (no fresh look):
        // what the last one used is fair game again.
        for (const f of this._look?.found || []) f.used = false;
        if (this._ready(a)) return;
        if (this.tricks) {
            this._lookAt = 0;
            await this._maybeLook(ctx);
            if (this._ready(a)) return;
        }
        if (this.onLedge) {
            try {
                await this.dropDown(ctx);
            } catch (e) {
                if (!(e instanceof Interrupt) || e.reason !== "fall") throw e;
                ctx.cancelled = null;
            }
        }
        await this._until(() => this.b.mode === "ground", ctx, 8000);
    }

    _ready(a) {
        try { return !!a.when(this); } catch (e) { return false; }
    }

    /** Every action and whether it could run right now. */
    actionList() {
        return ACTIONS.map((a) => ({ id: a.id, ready: this._ready(a) }));
    }

    _pick() {
        const t = now();
        this._pickedForced = false;
        if (this._forced) {
            const a = ACTIONS.find((x) => x.id === this._forced);
            this._forced = null;
            if (a) { this._pickedForced = true; return a; }
        }
        const cands = ACTIONS.filter((a) => a.group !== this._lastGroup
            && t - (this._cooldowns.get(a.id) ?? -Infinity) >= (a.cooldown || 0) * 1000
            && a.when(this));
        // A weight may depend on the moment (what Jev saw the user doing).
        const weights = cands.map((a) => (typeof a.weight === "function" ? a.weight(this) : a.weight));
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        for (let i = 0; i < cands.length; i++) {
            r -= weights[i];
            if (r <= 0) return cands[i];
        }
        return cands[0] || null;
    }

    // ── conditions ───────────────────────────────────────────────────────

    get onFloor() { return this.b.mode === "ground" && this.b.surf?.id === "floor"; }
    get onLedge() { return this.b.mode === "ground" && this.b.surf && this.b.surf.id !== "floor"; }

    get cursorNear() {
        const c = this.cursor;
        if (!c || now() - c.movedAt > 1500) return false;
        const cx = this.b.x, cy = this.b.y - this.body * 0.6;
        return Math.hypot(c.x - cx, c.y - cy) < this.body * 0.9;
    }

    /** Ledges a hop reaches from here. */
    hopTargets() {
        if (this.b.mode !== "ground") return [];
        const out = [];
        for (const l of this.world.ledges(this.body * 0.9)) {
            if (l.id === this.b.surf?.id) continue;
            const up = this.b.y - l.y;
            if (up < this.body * 0.25 || up > this.body * HOP_UP_MAX) continue;
            const x = Math.max(l.x0 + this.body * 0.2, Math.min(l.x1 - this.body * 0.2, this.b.x));
            if (Math.abs(x - this.b.x) > this.body * HOP_SIDE_MAX) continue;
            out.push({ ledge: l, x });
        }
        return out;
    }

    /** Things the last look found, still believable (fresh, and the
     *  foreground window where it was). */
    seen(key) {
        const look = this._look;
        if (!this.tricks || !look || now() - look.at > LOOK_TTL_MS) return [];
        const fg = this.world.foreground;
        if (look.fgId !== this.world.fg) return [];
        if (fg && look.fgRect && (Math.abs(fg.x - look.fgRect.x) > 3 || Math.abs(fg.y - look.fgRect.y) > 3
            || Math.abs(fg.width - look.fgRect.width) > 3 || Math.abs(fg.height - look.fgRect.height) > 3)) return [];
        return look.found.filter((f) => f.key === key && !f.used);
    }

    // ── looking at the screen ────────────────────────────────────────────

    async _maybeLook(ctx) {
        if (!this.tricks || this._lookOff || !this.bridge?.roamCapture) return;
        if (now() - this._lookAt < LOOK_EVERY_MS) return;
        this._lookAt = now();
        const cap = await this.bridge.roamCapture();
        this._check(ctx);
        if (!cap) { this._lookOff = this._lookOff || this._captureFails++ > 2; return; }
        const img = new Image();
        img.src = cap.dataUrl;
        try { await img.decode(); } catch (e) { return; }
        const shot = document.createElement("canvas");
        shot.width = cap.width;
        shot.height = cap.height;
        shot.getContext("2d").drawImage(img, 0, 0);
        const sx = cap.width / cap.frame.width, sy = cap.height / cap.frame.height;
        // What Jev sees: the shot with the companion greyed out, so they
        // never find themself.
        const masked = document.createElement("canvas");
        masked.width = cap.width;
        masked.height = cap.height;
        const mc = masked.getContext("2d");
        mc.drawImage(shot, 0, 0);
        mc.fillStyle = "#808080";
        mc.fillRect((this.box.left - cap.frame.x) * sx, (this.box.top - cap.frame.y) * sy, this.box.width * sx, this.box.height * sy);
        // The screen hasn't changed since the last look (an idle desktop, a
        // page being read): what Jev found then is still there, no new ask.
        const sig = screenSignature(masked);
        if (this._look && this._lastSig && sigDiff(sig, this._lastSig) < SAME_SCREEN) {
            const fg = this.world.foreground;
            Object.assign(this._look, { at: now(), fgId: this.world.fg, fgRect: fg ? { ...fg } : null });
            return;
        }
        this._lastSig = sig;
        let res;
        try {
            res = await rpc("/api/voice/roam/look", { image_data_url: masked.toDataURL("image/jpeg", 0.88) });
        } catch (e) {
            return;
        }
        this._check(ctx);
        if (!res?.ok) {
            // No key, or a model without boxes: stop asking this session.
            if (res?.reason === "no_key" || res?.reason === "jev_error") this._lookOff = true;
            return;
        }
        const { width: aw, height: ah } = this.world.area;
        const found = (res.found || []).map((f) => {
            let rect = {
                x: cap.frame.x + f.box.left * cap.frame.width,
                y: cap.frame.y + f.box.top * cap.frame.height,
                width: (f.box.right - f.box.left) * cap.frame.width,
                height: (f.box.bottom - f.box.top) * cap.frame.height,
            };
            // Jev's centres land better than its edges (screen_pointer.py),
            // so small things are cut out with a margin: the whole X, not
            // most of it.
            const pad = LOOK_PAD[f.key];
            if (pad) {
                const p = Math.max(5, pad * Math.max(rect.width, rect.height));
                rect = { x: rect.x - p, y: rect.y - p, width: rect.width + 2 * p, height: rect.height + 2 * p };
            }
            const win = this.world.windowAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { key: f.key, rect, win: win?.id ?? null };
        }).filter((f) => {
            // Past the work area is only the taskbar, out of their reach but
            // for a fishing line.
            const cx = f.rect.x + f.rect.width / 2, cy = f.rect.y + f.rect.height / 2;
            return f.key === "taskbar" || (cx >= 0 && cx <= aw && cy >= 0 && cy <= ah);
        });
        const fgNow = this.world.foreground;
        this._look = {
            at: now(), fgId: this.world.fg, fgRect: fgNow ? { ...fgNow } : null, found,
            shot: { canvas: shot, frame: cap.frame, sx, sy }, scene: res.scene || null, call: res.call !== false,
        };
    }

    /** A picture of `rect` off the last look's shot, and the colour around it. */
    _cutOut(rect) {
        const { canvas, frame, sx, sy } = this._look.shot;
        const x = (rect.x - frame.x) * sx, y = (rect.y - frame.y) * sy;
        const w = Math.max(1, rect.width * sx), h = Math.max(1, rect.height * sy);
        const c = document.createElement("canvas");
        c.width = Math.round(w);
        c.height = Math.round(h);
        c.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
        // The border just outside the box, averaged.
        let color = "#ffffff";
        try {
            const ctx = canvas.getContext("2d");
            const pts = [];
            for (let i = 0; i <= 8; i++) {
                const px = x + (w * i) / 8;
                pts.push([px, y - 3], [px, y + h + 3]);
            }
            pts.push([x - 3, y + h / 2], [x + w + 3, y + h / 2]);
            let r = 0, g = 0, bl = 0, n = 0;
            for (const [px, py] of pts) {
                if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
                const d = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
                r += d[0]; g += d[1]; bl += d[2]; n++;
            }
            if (n) color = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(bl / n)})`;
        } catch (e) { /* keep white */ }
        return { src: c.toDataURL("image/png"), color };
    }

    // ── actions ──────────────────────────────────────────────────────────

    async stroll(ctx) {
        const s = this.b.surf || this.world.floor();
        const pad = s.id === "floor" ? this.body * 0.3 : this.body * 0.15;
        const lo = s.x0 + pad, hi = s.x1 - pad;
        if (hi - lo < this.body * 0.5) return;
        let x = rand(lo, hi);
        if (Math.abs(x - this.b.x) < this.body * 0.6) x = this.b.x < (lo + hi) / 2 ? hi : lo;
        await this._walkTo(x, ctx);
    }

    async idleClip(ctx) {
        await this._play(pick(IDLE_CLIPS), ctx);
    }

    async emote(ctx) {
        await this._play(pick(EMOTE_CLIPS), ctx);
    }

    async dance(ctx) {
        await this._play(pick(DANCE_CLIPS), ctx, { loop: true });
        await this._wait(rand(7000, 12000), ctx);
        this._rest();
    }

    async exercise(ctx) {
        await this._play(pick(EXERCISE_CLIPS), ctx, { loop: true });
        await this._wait(rand(5000, 9000), ctx);
        this._rest();
        await this._play(`${VRMA}/Stretch.vrma`, ctx);
    }

    async noticeCursor(ctx) {
        this._face(0);
        await this._play(pick([`${VRMA}/Wave.vrma`, `${VRMA}/Surprised.vrma`, `${VRMA}/VRMA_02_greeting.vrma`]), ctx);
    }

    /** Sit on the ledge's edge, legs over it, for a while. */
    async sitDown(ctx) {
        const s = this.b.surf;
        const x = Math.max(s.x0 + this.body * 0.2, Math.min(s.x1 - this.body * 0.2, this.b.x + rand(-1, 1) * this.body));
        await this._walkTo(x, ctx);
        await this._play(CLIP.sit, ctx, { loop: true });
        this._pinTo(this.b.x, s.y - SEAT_BELOW_HIPS * this.body, ["hips"], 0, s.win, { snap: false });
        await this._wait(rand(12000, 25000), ctx);
        // Stand back up on the ledge (if it's still there).
        const still = this.world.refresh(s, this.body * 0.9, this.b.x);
        if (!still) { this._toAir(); return; }
        this._unpin(still);
        this._rest();
        await this._wait(600, ctx);
    }

    async hopUp(ctx) {
        const t = pick(this.hopTargets());
        if (!t) return;
        // To the spot under it on this surface first, if it's off to the side.
        const s = this.b.surf;
        const near = Math.max(s.x0, Math.min(s.x1, t.x - Math.sign(t.x - this.b.x) * this.body * 0.6));
        if (Math.abs(near - this.b.x) > this.body * 0.8) await this._walkTo(near, ctx);
        const fresh = this.world.ledges(this.body * 0.9).find((l) => l.id === t.ledge.id);
        if (!fresh || this.b.mode !== "ground") return;
        await this._hop(fresh, Math.max(fresh.x0 + this.body * 0.2, Math.min(fresh.x1 - this.body * 0.2, t.x)), ctx);
    }

    /** Walk off the end of the ledge. */
    async dropDown(ctx) {
        const s = this.b.surf;
        const { width } = this.world.area;
        // Off whichever end lands them on the screen (a window flush with
        // its edge has only the one).
        const ends = [s.x0 - this.body * 0.3, s.x1 + this.body * 0.3];
        const onScreen = ends.filter((x) => x > this.body * 0.4 && x < width - this.body * 0.4);
        await this._walkTo(pick(onScreen.length ? onScreen : ends), ctx);
    }

    async portalTrip(ctx) {
        const spots = [this.world.floor(), ...this.world.ledges(this.body * 0.9)]
            .filter((s) => s.x1 - s.x0 > this.body * 0.6 && s.id !== this.b.surf?.id);
        const dest = pick(spots);
        if (!dest) return;
        const x = rand(dest.x0 + this.body * 0.3, dest.x1 - this.body * 0.3);
        this._face(0);
        await this._play(`${VRMA}/tool_motions/conjure_portal_in.vrma`, ctx, { maxMs: 1400 });
        await this._vanish();
        await this._wait(rand(400, 900), ctx);
        this._rest();
        await this._appear(() => this._stand(dest, x), ctx);
    }

    async peek(ctx) {
        const { width } = this.world.area;
        const fromLeft = this.b.x < width / 2;
        await this._walkTo(fromLeft ? -this.body * 0.45 : width + this.body * 0.45, ctx, { offscreen: true });
        await this._peekAt(fromLeft, ctx, rand(3500, 6000));
        await this._walkTo(fromLeft ? rand(width * 0.1, width * 0.3) : rand(width * 0.7, width * 0.9), ctx, { offscreen: true });
    }

    /** Draw something on the screen beside them. */
    async doodle(ctx) {
        const { width } = this.world.area;
        const side = this.b.x < width / 2 ? 1 : -1;
        const x = this.b.x + side * this.body * 0.62;
        const y = this.b.y - this.body * 0.62;
        if (x < this.body * 0.3 || x > width - this.body * 0.3) return;
        this._face(side);
        await this._play(CLIP.paint, ctx, { loop: true });
        const name = (this.agentName || "").trim();
        const texts = [_t("hi!"), "♪", ...(name ? [_t("%s was here", name)] : [])];
        // Now and then something they remember about you, as a drawing
        // (Jev picks the doodle that fits a memory; the words stay private).
        let remembered = null;
        if (this.agentId && Math.random() < 0.35) {
            try {
                remembered = (await rpc("/api/voice/roam/memory_doodle", { agent_id: this.agentId }))?.kind || null;
            } catch (e) { /* a random one, then */ }
            this._check(ctx);
        }
        const spec = remembered ? { kind: remembered, size: this.body * 0.42 }
            : Math.random() < 0.3
                ? { text: pick(texts), size: this.body * 0.32 }
                : { kind: pick(DOODLE_KINDS), size: this.body * 0.42 };
        // Done drawing, or 4 s at most.
        const cap = this._wait(4000, ctx);
        cap.catch(() => {});
        await Promise.race([this.fx.doodle({ ...spec, x, y, drawMs: 2600 }), cap]);
        this._check(ctx);
        this._rest();
        this._face(0);
        await this._wait(800, ctx);
        if (Math.random() < 0.5) await this._play(`${VRMA}/Clapping.vrma`, ctx);
    }

    async nap(ctx) {
        this._face(0);
        await this._play(CLIP.sleep, ctx, { loop: true });
        this._napping = true;
        const head = this.r.roamBonePx("head");
        this._zzz = this.fx.zzz(this.box.left + (head?.x || 0), this.box.top + (head?.y || 0));
        // Bedtime (after midnight): tucked in under a blanket.
        if (lateNight()) {
            await this._wait(900, ctx);
            const blanket = this.fx.blanket({
                x: this.b.x - this.body * 0.48, y: this.b.y - this.body * 0.3, width: this.body * 0.9, height: this.body * 0.3,
            });
            this.onEnd(() => blanket.stop());
        }
        try {
            await this._until(() => this.world.idle < 2, ctx, 3600000);
        } catch (e) {
            if (e.reason !== "wake") throw e;
        }
        this._napping = false;
        this._zzz?.stop();
        this._zzz = null;
        ctx.cancelled = null;   // the wake-up was the point
        this._rest();
        await this._wait(500, ctx);
        await this._play(`${VRMA}/Yawning.vrma`, ctx);
        await this._play(`${VRMA}/Stretch.vrma`, ctx);
    }

    // ── tricks (things on the screen, from the last look) ────────────────

    /** Grab hold of `f` (hanging from it), tear it off and fall with it. */
    async _grab(f, ctx) {
        const { rect } = f;
        f.used = true;
        const cut = this._cutOut(rect);
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        await this._vanish();
        this._check(ctx);
        await this._play(CLIP.hang, ctx, { loop: true });
        await this._appear(() => this._pinTo(cx, cy, ["leftHand", "rightHand"], GRIP_ABOVE_WRIST, f.win), ctx);
        await this._wait(rand(1200, 2200), ctx);
        // Rip.
        this._patch = this.fx.patch(rect, cut.color);
        const sticker = this.fx.sticker(cut.src, rect);
        this.held = { sticker, bones: ["leftHand", "rightHand"], dy: -GRIP_ABOVE_WRIST };
        this._quietLanding = false;
        this._hopping = true;   // a planned fall, not an interruption
        try {
            this._toAir();
            await this._until(() => this.b.mode === "ground", ctx, 8000);
        } finally {
            this._hopping = false;
        }
        await this._wait(700, ctx);
        return { sticker, color: cut.color };
    }

    async eatLink(ctx) {
        const f = pick(this.seen("link"));
        if (!f) return;
        const { sticker, color } = await this._grab(f, ctx);
        this._face(0);
        await this._play(CLIP.eat, ctx, { loop: true });
        this.held.dy = -0.02;
        for (let i = 1; i <= 5; i++) {
            await this._wait(520, ctx);
            sticker.bite(1 - i / 5);
            const hp = this._bonesPx(this.held.bones);
            if (hp) this.fx.crumbs(this.box.left + hp.x, this.box.top + hp.y, color);
        }
        sticker.remove();
        this.held = null;
        this._rest();
        this.r.setEmotion?.("happy", { explicit: false });
        const head = this.r.roamBonePx("head");
        if (head) this.fx.hearts(this.box.left + head.x, this.box.top + head.y - this.body * 0.1);
        await this._wait(1200, ctx);
    }

    /** Runs off with a window's close button, a browser tab, a button or
     *  the address bar, and throws it back. */
    async stealClose(ctx) {
        const pool = Object.entries(STEALABLE).flatMap(([k, w]) => this.seen(k)
            .filter((f) => f.rect.width < this.world.area.width * 0.5)
            .flatMap((f) => Array(w).fill(f)));
        const f = pick(pool);
        if (!f) return;
        const { sticker } = await this._grab(f, ctx);
        const { width } = this.world.area;
        const away = f.rect.x < width / 2 ? width - this.body * 0.8 : this.body * 0.8;
        this.held.dy = -0.04;
        this.held.keep = true;
        try {
            // Down off any window they landed on along the way: a planned
            // fall, not the end of the gag.
            this._hopping = true;
            try {
                for (let i = 0; i < 4 && Math.abs(this.b.x - away) > 8; i++) {
                    await this._walkTo(away, ctx, { rate: 1.3, upper: CLIP.carry });
                    await this._until(() => this.b.mode === "ground", ctx, 8000);
                }
            } finally {
                this._hopping = false;
            }
            this._face(0);
            await this._play(CLIP.carry, ctx, { loop: true });
            this.r.setEmotion?.("happy", { explicit: false });
            await this._wait(rand(1500, 2500), ctx);
            // Give it back: thrown home.
            this._face(f.rect.x < this.b.x ? -1 : 1);
            await this._play(CLIP.throw, ctx, { maxMs: 600 });
        } catch (e) {
            // Cut short anyway (a startle, the screen changing): it still
            // goes home, on its own.
            sticker.flyHome(850).then(() => sticker.remove());
            throw e;
        } finally {
            this.held = null;
        }
        await sticker.flyHome(850);
        sticker.remove();
        const patch = this._patch;
        this._patch = null;
        patch?.fade(200);
        this._rest();
        this._face(0);
        await this._wait(800, ctx);
    }

    /** Sit on the top edge of something (a video, a picture) for a while. */
    async _sitOn(f, ctx, ms, { happy = false } = {}) {
        const { rect } = f;
        f.used = true;
        const x = rect.x + rect.width / 2;
        await this._vanish();
        await this._play(CLIP.sit, ctx, { loop: true });
        await this._appear(() => this._pinTo(x, rect.y - SEAT_BELOW_HIPS * this.body, ["hips"], 0, f.win), ctx);
        const look = { x, y: rect.y + rect.height / 2 };
        const end = now() + ms;
        while (now() < end) {
            this.r.lookAtPoint?.(look, 4500);
            if (happy && Math.random() < 0.35) {
                const head = this.r.roamBonePx("head");
                if (head) this.fx.hearts(this.box.left + head.x, this.box.top + head.y - this.body * 0.08);
            }
            await this._wait(4000, ctx);
        }
        if (happy) this.r.setEmotion?.("happy", { explicit: false });
        // Hop off.
        this._toAir();
    }

    async watchVideo(ctx) {
        const f = pick(this.seen("video"));
        if (f) await this._sitOn(f, ctx, rand(15000, 25000));
    }

    async admirePicture(ctx) {
        const f = pick(this.seen("picture"));
        if (f) await this._sitOn(f, ctx, rand(8000, 12000), { happy: true });
    }

    /** Sit on top of a scrollbar's thumb and slide down the track. */
    async slideScrollbar(ctx) {
        const f = pick(this.seen("scrollbar"));
        if (!f) return;
        f.used = true;
        const { rect } = f;
        const x = rect.x + rect.width / 2;
        const win = f.win ? this.world.window(f.win) : null;
        const bottom = Math.min(this.world.area.height - this.body * 0.3, win ? win.y + win.height - this.body * 0.1 : rect.y + rect.height * 3);
        await this._vanish();
        await this._play(CLIP.sit, ctx, { loop: true });
        await this._appear(() => this._pinTo(x, rect.y - SEAT_BELOW_HIPS * this.body, ["hips"], 0, f.win), ctx);
        await this._wait(900, ctx);
        this.r.setEmotion?.("happy", { explicit: false });
        let v = 0;
        const g = GRAVITY * this.m.pxPerM * 0.35;   // a slide, not a drop
        while (this.pin && this.pin.y < bottom) {
            await this._nextFrame();
            this._check(ctx);
            v += g / 60;
            this.pin.y = Math.min(bottom, this.pin.y + v / 60);
        }
        this._toAir();
    }

    /** A bath in a search box: sat down in it, bubbles. */
    async bathSearch(ctx) {
        const f = pick(this.seen("search"));
        if (!f) return;
        f.used = true;
        const { rect } = f;
        const x = rect.x + rect.width / 2;
        await this._vanish();
        await this._play(CLIP.sit, ctx, { loop: true });
        await this._appear(() => {
            this._pinTo(x, rect.y + rect.height * 0.8, ["hips"], 0, f.win);
            this.clipLine = rect.y + rect.height * 0.55;
        }, ctx);
        this._bubbles = this.fx.bubbles({ x: rect.x + rect.width * 0.2, y: rect.y - 10, width: rect.width * 0.6, height: rect.height });
        this.r.setEmotion?.("relaxed", { explicit: false });
        await this._wait(rand(9000, 14000), ctx);
        this._bubbles.stop();
        this._bubbles = null;
        await this._vanish();
        this.clipLine = null;
        this._rest();
        const floor = this.world.floor();
        await this._appear(() => this._stand(floor, Math.max(this.body * 0.4, Math.min(floor.x1 - this.body * 0.4, x))), ctx);
    }
}

// The action table. `when` decides availability, `weight` the odds among
// the available ones, `cooldown` (s) how soon the same one may come back;
// never two of one group in a row.
const ACTIONS = [
    { id: "stroll", group: "walk", weight: 30, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.stroll },
    { id: "idle", group: "idle", weight: 18, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.idleClip },
    { id: "emote", group: "emote", weight: 12, cooldown: 20, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.emote },
    { id: "dance", group: "dance", weight: 6, cooldown: 120, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.dance },
    { id: "exercise", group: "exercise", weight: 4, cooldown: 180, when: (d) => d.onFloor, run: RoamDirector.prototype.exercise },
    { id: "notice", group: "social", weight: 40, cooldown: 45, when: (d) => d.b.mode === "ground" && d.cursorNear, run: RoamDirector.prototype.noticeCursor },
    { id: "sit", group: "rest", weight: 16, cooldown: 40, when: (d) => d.onLedge, run: RoamDirector.prototype.sitDown },
    { id: "hop", group: "travel", weight: 14, cooldown: 15, when: (d) => d.hopTargets().length > 0, run: RoamDirector.prototype.hopUp },
    { id: "drop", group: "travel", weight: 8, cooldown: 30, when: (d) => d.onLedge, run: RoamDirector.prototype.dropDown },
    { id: "portal", group: "travel", weight: 6, cooldown: 90, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.portalTrip },
    { id: "peek", group: "peek", weight: 5, cooldown: 150, when: (d) => d.onFloor, run: RoamDirector.prototype.peek },
    { id: "doodle", group: "art", weight: 6, cooldown: 90, when: (d) => d.b.mode === "ground", run: RoamDirector.prototype.doodle },
    // After midnight a minute of quiet is enough.
    { id: "nap", group: "rest", weight: 60, cooldown: 30,
      when: (d) => d.onFloor && (d.world.idle >= SLEEP_IDLE_S || (lateNight() && d.world.idle >= 60)), run: RoamDirector.prototype.nap },
    // Naps happen on the floor: down off a ledge first.
    { id: "drop_to_nap", group: "travel", weight: 60, when: (d) => d.onLedge && d.world.idle >= SLEEP_IDLE_S, run: RoamDirector.prototype.dropDown },
    { id: "eat_link", group: "trick", weight: 30, cooldown: 60, when: (d) => d.seen("link").length > 0, run: RoamDirector.prototype.eatLink },
    { id: "steal", group: "trick", weight: 26, cooldown: 90, when: (d) => Object.keys(STEALABLE).some((k) => d.seen(k).length > 0), run: RoamDirector.prototype.stealClose },
    { id: "watch_video", group: "trick", weight: 26, cooldown: 90, when: (d) => d.seen("video").some((f) => f.rect.y > d.body * 0.6), run: RoamDirector.prototype.watchVideo },
    { id: "admire_picture", group: "trick", weight: 18, cooldown: 60, when: (d) => d.seen("picture").some((f) => f.rect.y > d.body * 0.6 && f.rect.width > d.body * 0.4), run: RoamDirector.prototype.admirePicture },
    { id: "slide", group: "trick", weight: 16, cooldown: 90, when: (d) => d.seen("scrollbar").some((f) => f.rect.y > d.body * 0.6), run: RoamDirector.prototype.slideScrollbar },
    { id: "bath", group: "trick", weight: 14, cooldown: 120, when: (d) => d.seen("search").some((f) => f.rect.y > d.body * 0.5 && f.rect.width > d.body * 0.35), run: RoamDirector.prototype.bathSearch },
    // The props, memes and big moments (models/roam_gags.js, roam_gags_more.js).
    ...GAG_ACTIONS,
    ...MORE_GAG_ACTIONS,
];
installGags(RoamDirector.prototype);
installMoreGags(RoamDirector.prototype);
