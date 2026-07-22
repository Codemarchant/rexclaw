
/**
 * VRPanel — a hand-anchored, toggleable settings panel for immersive sessions.
 *
 * CanvasTexture on a plane (no DOM in the headset framebuffer, no VR-UI dep).
 * Floats above the anchor hand and billboards to face the HMD. Point the OTHER
 * controller at a button (it highlights) and pull the trigger to activate.
 *
 * Layout: four controls (Exit / Mute / Recenter / Environment), a tab row
 * (Emotions | Gestures | Options), a paged 2×3 grid of the active tab's items,
 * and a Page button when the list overflows. A/X toggles the whole panel.
 * The Options tab hosts the VR feature toggles (move mode, touch reactions,
 * ragdoll) supplied by vr_manager via getOptions()/onOption().
 */

const CANVAS_W = 512;
const CANVAS_H = 748;
const PANEL_H = 0.36;                          // metres; width follows the canvas aspect
const PANEL_W = (CANVAS_W / CANVAS_H) * PANEL_H;
const PANEL_DIST = 0.5;                          // metres in front of the user
const PANEL_DROP = 0.18;                         // metres below eye level
const PANEL_DEADZONE = Math.PI / 5;             // ~36°: stay put until you turn away
const FOLLOW_LERP = 0.1;
const PER_PAGE = 6;                             // grid items per page (2×3)

function envLabel(mode) {
    return mode === "passthrough" ? "Passthrough" : "Virtual";
}

export class VRPanel {
    /**
     * @param THREE three lib (from session ctx)
     * @param opts  { emotions:[{id,label}], getGestures():[{id,label,url,loop}],
     *                getOptions():[{id,label}], onOption(id),
     *                onExit(), onEmotion(id), onGesture(item), onEnv(),
     *                onRecenter(), onMute(), getEnvMode(), getMuted() }
     */
    constructor(THREE, opts = {}) {
        this.THREE = THREE;
        this.emotions = opts.emotions || [];
        this.getGestures = opts.getGestures || null;
        this.getOptions = opts.getOptions || null;
        this.onOption = opts.onOption || null;
        this.onExit = opts.onExit || null;
        this.onEmotion = opts.onEmotion || null;
        this.onGesture = opts.onGesture || null;
        this.onEnv = opts.onEnv || null;
        this.onRecenter = opts.onRecenter || null;
        this.onMute = opts.onMute || null;
        this.getEnvMode = opts.getEnvMode || null;
        this.getMuted = opts.getMuted || null;
        this.getDebug = opts.getDebug || null;   // optional: string drawn at the top (button-index readout)

        this._hovered = null;
        this._placed = false;
        this._debug = "";
        this._visible = false;                 // hidden on session start; A/X summons it
        this._tab = "emotions";
        this._page = 0;
        this._envMode = (this.getEnvMode && this.getEnvMode()) || "skybox";
        this._muted = !!(this.getMuted && this.getMuted());
        this.buttons = [];

        this.canvas = document.createElement("canvas");
        this.canvas.width = CANVAS_W;
        this.canvas.height = CANVAS_H;
        this.ctx = this.canvas.getContext("2d");

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.anisotropy = 4;
        this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.FrontSide });
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), this.material);
        this.mesh.renderOrder = 999;
        this.mesh.name = "vr-panel";
        this.mesh.visible = this._visible;

        this._ray = new THREE.Raycaster();
        this._p = new THREE.Vector3();
        this._q = new THREE.Quaternion();
        this._dir = new THREE.Vector3();
        this._hmdPos = new THREE.Vector3();
        this._pos = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._target = new THREE.Vector3();
        this._tmp = new THREE.Vector3();

        this._rebuild();
    }

    setVisible(v) {
        this._visible = !!v;
        this.mesh.visible = this._visible;
        if (this._visible) this._placed = false;   // re-snap in front when reopened
    }

    toggle() {
        this.setVisible(!this._visible);
        return this._visible;
    }

    /** Recompute the button list for the current tab/page/labels. */
    _rebuild() {
        const controls = [
            { id: "__exit", label: "Exit", kind: "exit", rect: [24, 24, 224, 72] },
            { id: "__mute", label: this._muted ? "Unmute" : "Mute", kind: "mute", rect: [264, 24, 224, 72] },
            { id: "__recenter", label: "Recenter", kind: "recenter", rect: [24, 108, 224, 72] },
            { id: "__env", label: envLabel(this._envMode), kind: "env", rect: [264, 108, 224, 72] },
            { id: "__tab_em", label: "Emotions", kind: "tab", tab: "emotions", rect: [24, 192, 146, 64] },
            { id: "__tab_ge", label: "Gestures", kind: "tab", tab: "gestures", rect: [182, 192, 146, 64] },
            { id: "__tab_op", label: "Options", kind: "tab", tab: "options", rect: [340, 192, 148, 64] },
        ];
        const list = this._tab === "gestures" ? (this.getGestures?.() || [])
            : this._tab === "options" ? (this.getOptions?.() || [])
            : this.emotions;
        const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
        if (this._page >= pages) this._page = 0;
        const slice = list.slice(this._page * PER_PAGE, this._page * PER_PAGE + PER_PAGE);
        const grid = slice.map((it, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            return {
                id: (this._tab === "gestures" ? "g:" : this._tab === "options" ? "o:" : "e:") + it.id,
                label: it.label,
                kind: this._tab === "gestures" ? "gesture" : this._tab === "options" ? "option" : "emotion",
                item: it,
                rect: [24 + col * 240, 272 + row * 130, 224, 118],
            };
        });
        const extra = [];
        if (pages > 1) {
            extra.push({ id: "__page", label: `Page ${this._page + 1}/${pages} ▸`, kind: "page", rect: [24, 664, 464, 64] });
        }
        this.buttons = [...controls, ...grid, ...extra];
    }

    update({ hmd, controllers = [] } = {}) {
        if (!this._visible || !hmd) { this.mesh.visible = false; return; }
        this.mesh.visible = true;
        hmd.getWorldPosition(this._hmdPos);
        // Float in front of the head, below eye level, with a dead-zone follow
        // (world-locked while roughly in front; glides back when you turn away).
        hmd.getWorldDirection(this._fwd);
        this._fwd.y = 0;
        if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
        this._fwd.normalize();
        this._target.copy(this._hmdPos).addScaledVector(this._fwd, PANEL_DIST);
        this._target.y = this._hmdPos.y - PANEL_DROP;
        if (!this._placed) {
            this._pos.copy(this._target);
            this._placed = true;
        } else {
            this._tmp.copy(this._pos).sub(this._hmdPos);
            this._tmp.y = 0;
            let outside = true;
            if (this._tmp.lengthSq() > 1e-6) {
                this._tmp.normalize();
                outside = this._tmp.dot(this._fwd) < Math.cos(PANEL_DEADZONE);
            }
            if (outside) this._pos.lerp(this._target, FOLLOW_LERP);
            else this._pos.y += (this._target.y - this._pos.y) * FOLLOW_LERP;
        }
        this.mesh.position.copy(this._pos);
        this.mesh.lookAt(this._hmdPos);   // +Z (front) faces the viewer, upright

        let dirty = false;
        const mode = this.getEnvMode?.();
        if (mode && mode !== this._envMode) { this._envMode = mode; dirty = true; }
        const muted = !!this.getMuted?.();
        if (muted !== this._muted) { this._muted = muted; dirty = true; }
        // Option labels can change asynchronously (e.g. ragdoll finishes
        // loading its physics engine) — poll while the tab is showing.
        if (this._tab === "options") {
            const sig = (this.getOptions?.() || []).map((o) => o.label).join("|");
            if (sig !== this._optSig) { this._optSig = sig; dirty = true; }
        }
        if (dirty) this._rebuild();
        const dbg = this.getDebug?.() || "";
        if (dbg !== this._debug) { this._debug = dbg; dirty = true; }

        let hovered = null;
        for (const c of controllers) {
            if (!c) continue;
            const btn = this._raycastButton(c);
            if (btn) { hovered = btn.id; break; }
        }
        if (hovered !== this._hovered) { this._hovered = hovered; dirty = true; }
        if (dirty) this._draw();
    }

    handleSelect(controller) {
        if (!this._visible) return false;
        const btn = this._raycastButton(controller);
        if (!btn) return false;
        switch (btn.kind) {
            case "exit": this.onExit?.(); break;
            case "env": this.onEnv?.(); break;
            case "recenter": this.onRecenter?.(); break;
            case "mute": this.onMute?.(); break;
            case "tab": this._tab = btn.tab; this._page = 0; this._rebuild(); this._draw(); break;
            case "page": this._page += 1; this._rebuild(); this._draw(); break;
            case "emotion": this.onEmotion?.(btn.item.id); break;
            case "gesture": this.onGesture?.(btn.item); break;
            // Toggle labels ("Move: Off" → "Move: On") come from getOptions,
            // so rebuild right away to reflect the new state.
            case "option": this.onOption?.(btn.item.id); this._rebuild(); this._draw(); break;
        }
        return true;
    }

    _raycastButton(controller) {
        if (!this.mesh.visible) return null;
        controller.getWorldPosition(this._p);
        controller.getWorldQuaternion(this._q);
        this._dir.set(0, 0, -1).applyQuaternion(this._q).normalize();
        this._ray.set(this._p, this._dir);
        const hits = this._ray.intersectObject(this.mesh, false);
        if (!hits.length || !hits[0].uv) return null;
        const px = hits[0].uv.x * CANVAS_W;
        const py = (1 - hits[0].uv.y) * CANVAS_H;
        return this.buttons.find((b) => {
            const [x, y, w, h] = b.rect;
            return px >= x && px <= x + w && py >= y && py <= y + h;
        }) || null;
    }

    _draw() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        this._roundRect(0, 0, CANVAS_W, CANVAS_H, 28);
        ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
        ctx.fill();

        for (const b of this.buttons) {
            const [x, y, w, h] = b.rect;
            const hot = this._hovered === b.id;
            const active = b.kind === "tab" && b.tab === this._tab;
            this._roundRect(x, y, w, h, 14);
            ctx.fillStyle = this._colorFor(b, hot, active);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 28px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(b.label, x + w / 2, y + h / 2);
        }
        if (this._debug) {
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = "18px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(this._debug, CANVAS_W / 2, CANVAS_H - 6);
        }
        this.texture.needsUpdate = true;
    }

    _colorFor(b, hot, active) {
        switch (b.kind) {
            case "exit": return hot ? "rgba(239,68,68,0.95)" : "rgba(220,38,38,0.82)";
            case "env": return hot ? "rgba(20,184,166,0.95)" : "rgba(13,148,136,0.82)";
            case "recenter": return hot ? "rgba(129,140,248,0.95)" : "rgba(99,102,241,0.82)";
            case "mute":
                if (this._muted) return hot ? "rgba(249,115,22,0.95)" : "rgba(234,88,12,0.85)";
                return hot ? "rgba(100,116,139,0.95)" : "rgba(71,85,105,0.82)";
            case "tab": return active ? "rgba(37,99,235,0.95)" : (hot ? "rgba(71,85,105,0.95)" : "rgba(51,65,85,0.7)");
            case "gesture": return hot ? "rgba(168,85,247,0.95)" : "rgba(126,34,206,0.4)";
            case "option": {
                const on = /: On$/.test(b.label);
                if (on) return hot ? "rgba(34,197,94,0.95)" : "rgba(22,163,74,0.75)";
                return hot ? "rgba(100,116,139,0.95)" : "rgba(51,65,85,0.7)";
            }
            case "page": return hot ? "rgba(100,116,139,0.95)" : "rgba(51,65,85,0.7)";
            default: return hot ? "rgba(37,99,235,0.95)" : "rgba(255,255,255,0.12)"; // emotion
        }
    }

    _roundRect(x, y, w, h, r) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    dispose() {
        this.mesh.parent?.remove(this.mesh);
        this.mesh.geometry?.dispose?.();
        this.material?.dispose?.();
        this.texture?.dispose?.();
    }
}
