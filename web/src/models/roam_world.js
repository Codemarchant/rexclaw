// The desktop as a roaming companion sees it (models/roam_director.js):
// the bottom of the screen to walk along, the top edges of the other apps'
// windows to stand and sit on, and which windows are in front of a given
// one, so a companion on a window behind them is hidden by them.
//
// Built from the shell's window list (desktop/roam_windows.js): front
// window first, rectangles in the page's CSS px (the overlay covers the
// display's work area, so 0,0 is its top-left and the floor is its bottom
// edge, just above the taskbar). Without a list (macOS, Linux) only the
// floor exists.

// A ledge needs room for the feet: a window narrower than this, or a stretch
// of its top edge shorter than it, isn't one. Ends are kept clear by
// LEDGE_INSET so the feet never hang over a corner. Both px, by eye.
const LEDGE_MIN = 90;
const LEDGE_INSET = 14;

export class RoamWorld {
    constructor() {
        this.area = { width: 0, height: 0 };
        this.windows = [];        // front first
        this.fg = null;
        this.fullscreen = false;
        this.idle = 0;
        this._byId = new Map();
    }

    setArea(area) {
        this.area = { width: area.width, height: area.height };
    }

    setEnv(env) {
        this.windows = (env.windows || []).filter((w) => w.width > 0 && w.height > 0);
        this._byId = new Map(this.windows.map((w, i) => [w.id, { w, z: i }]));
        this.fg = env.fg ?? null;
        // Minimized windows, by id: their absence from the list is a
        // minimize, not a close.
        this.minimized = new Set(env.minimized || []);
        this.fullscreen = !!env.fullscreen;
        this.idle = Number(env.idle) || 0;
    }

    window(id) { return this._byId.get(id)?.w || null; }

    get foreground() { return this.window(this.fg); }

    floor() {
        return { id: "floor", win: null, y: this.area.height, x0: 0, x1: this.area.width };
    }

    /** The front-most window under a point (null: the desktop). */
    windowAt(x, y) {
        return this.windows.find((w) => x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) || null;
    }

    /** Windows in front of window `id` (all of them for null = nothing). */
    inFront(id) {
        if (id == null) return [];
        const z = this._byId.get(id)?.z;
        return z == null ? [] : this.windows.slice(0, z);
    }

    /** Every stretch of a window top a companion could stand on: the top
     *  edge on screen, uncovered by the windows in front, below `headroom`
     *  px from the top of the screen (so the head isn't cut off), not
     *  maximized (its top is the screen's). */
    ledges(headroom) {
        const out = [];
        const { width, height } = this.area;
        this.windows.forEach((w, z) => {
            if (w.maximized) return;
            const y = w.y;
            if (y < headroom || y > height - 40) return;
            let spans = [[Math.max(0, w.x + LEDGE_INSET), Math.min(width, w.x + w.width - LEDGE_INSET)]];
            for (let i = 0; i < z && spans.length; i++) {
                const f = this.windows[i];
                if (!(f.y <= y + 2 && f.y + f.height > y - 2)) continue;
                spans = cut(spans, f.x - LEDGE_INSET, f.x + f.width + LEDGE_INSET);
            }
            spans.forEach(([x0, x1], i) => {
                if (x1 - x0 >= LEDGE_MIN) out.push({ id: `${w.id}:${i}`, win: w.id, y, x0, x1 });
            });
        });
        return out;
    }

    /** The surface `s` as it stands now (its window may have moved, been
     *  covered, closed): the same ledge, refound by window and position,
     *  or null when it's gone. */
    refresh(s, headroom, x) {
        if (!s || s.id === "floor") return this.floor();
        return this.ledges(headroom).find((l) => l.win === s.win && x >= l.x0 - 4 && x <= l.x1 + 4) || null;
    }

    /** The first surface a falling body at x would meet between y0 and y1
     *  (screen y grows downward), the floor at the latest. */
    landing(x, y0, y1, headroom) {
        let best = null;
        for (const l of this.ledges(headroom)) {
            if (x < l.x0 || x > l.x1 || l.y < y0 || l.y > y1) continue;
            if (!best || l.y < best.y) best = l;
        }
        if (best) return best;
        const f = this.floor();
        return y1 >= f.y ? f : null;
    }
}

/** `spans` minus the interval [a, b]. */
function cut(spans, a, b) {
    const out = [];
    for (const [x0, x1] of spans) {
        if (b <= x0 || a >= x1) { out.push([x0, x1]); continue; }
        if (a > x0) out.push([x0, a]);
        if (b < x1) out.push([b, x1]);
    }
    return out;
}
