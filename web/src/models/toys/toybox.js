// The toy box a view hands to its tray (components/ToyTray.jsx): which stage
// the toys go to now (the desktop while roaming, the 3D scene otherwise),
// the tray's own state, and the companion being told about the toys while
// a call is live.
//
// What the companion is told is a hidden note in the call, in the stage's
// karaoke notes' form ("[System] (toys) ..."). A note that asks for a
// spoken reaction is held back to one at a time (NOTE_GAP_MS): a toy fight
// shouldn't turn every catch into a speech, nor bill a reply for each. A
// surprise (what they couldn't have known when the first note went: it had
// gone off, the pepper's fire) gets its reaction even inside the gap.
//
// What the user does to them (food held out, a toy thrown at them, their
// hair blow-dried) cuts in on what they're saying, as if the user had
// spoken: the reaction comes now, not after the reply. Only in a solo
// call; in a group call it would take the floor from whoever the user
// was talking to.
//
// In a group call each companion is told: the one it's about (`who`) as
// above, a group call or not; the others the same line as context, marked
// as someone else's so they don't take it as their own.

import { reactive } from "../../lib/reactive";
import { TOYS } from "./catalog";
import { toySfx } from "./sfx";

const NOTE_GAP_MS = 12000;
// "Keep playing with toys": off, the companion only reacts to what the user
// does (drops, throws, offers, switches), never goes for a toy on their
// own. Kept per browser.
const IDLE_KEY = "rexclaw.toy_idle_play";

function loadIdle() {
    try { return localStorage.getItem(IDLE_KEY) !== "0"; } catch (e) { return true; }
}

/** Whether pointer event `e` is over the toy tray (a toy dropped there goes
 *  back in the box). */
export function overTray(e) {
    const r = e && document.querySelector(".rx_toytray")?.getBoundingClientRect();
    return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/** Who's in `voice`'s live call, for setCall: the main companion, then
 *  each peer (by its connection id, the id its avatar has in the
 *  renderer). Notes go straight in, without the call's 4 s spacing. */
export function callMembers(voice) {
    const send = (conn) => (text, respond) => conn.sendContextEvent(text, { minIntervalMs: 0, promptResponse: respond });
    const cut = (conn) => () => conn.cancelActiveResponse("toy: user did something to them");
    const main = voice.primary;
    return [
        ...(main ? [{ id: null, name: main.agentName, key: null, send: send(main), cut: cut(main) }] : []),
        ...voice.activePeers().map((c) => ({ id: c.connId, name: c.agentName, key: c.lastAgentId ?? c.agentName, send: send(c), cut: cut(c) })),
    ];
}

export class ToyBox {
    constructor() {
        this.state = reactive({ open: false, cat: "treats", count: 0, sounds: toySfx.enabled, idle: loadIdle(), stage: null });
        this.stage = null;
        this._call = null;
        this._lastAsk = new Map();
    }

    /** The stage toys go to (null: none); the caller disposes the old one. */
    setStage(stage) {
        if (stage === this.stage) return;
        this.stage = stage;
        if (stage) stage.box = this;
        this.state.stage = stage?.kind || null;
        this.changed();
    }

    /** members() → who's in the live call (null: no call), the main
     *  companion first: [{id (null for the main one, else the peer's
     *  connection id), name, key (their taste's), send(text, respond)}]. */
    setCall(members) { this._call = members; }

    /** Taste key of the companion in the call with peer id `id`. */
    keyOf(id) { return this._call?.().find((m) => m.id === id)?.key ?? null; }

    /** heardAt() → when anyone was last heard talking (Date.now() ms; 0:
     *  never), so the companion doesn't wander off to a toy mid-chat. */
    setHeard(heardAt) { this._heardAt = heardAt; }

    quietMs() {
        const at = this._heardAt?.() || 0;
        return at ? Date.now() - at : Infinity;
    }

    get inCall() { return !!this._call; }

    /** `who`: the peer id of the companion it's about (null: the main one).
     *  `interrupt`: the user did it to them; the reaction asked for cuts in
     *  on their reply (solo calls only). */
    note(text, { respond = false, surprise = false, interrupt = false, who = null } = {}) {
        let members = [];
        try { members = this._call?.() || []; } catch (e) { /* call gone */ }
        // (Not there: they've left the call since; it isn't anyone else's.)
        const them = members.find((m) => m.id === who);
        if (!them) return;
        const key = them.id ?? "main";
        const ask = surprise || (respond && performance.now() - (this._lastAsk.get(key) || 0) > NOTE_GAP_MS);
        if (ask) this._lastAsk.set(key, performance.now());
        // (Before the note: the reply it asks for waits for the cut one to
        // wind down, agent_connection cancelActiveResponse.)
        if (ask && interrupt && members.length === 1) {
            try { them.cut(); } catch (e) { /* call gone */ }
        }
        for (const m of members) {
            const line = m === them ? `[System] (toys) ${text}`
                : `[System] (toys) This is what ${them.name || "another companion"} was just told (it's about them, not you): "${text}"`;
            try { m.send(line, m === them && ask); } catch (e) { /* call gone */ }
        }
    }

    changed() {
        const n = this.stage ? this.stage.count((t) => t.def.cat) : 0;
        if (this.state.count === n) return;
        const was = this.state.count;
        this.state.count = n;
        // The last one put away: back where they stood, facing you.
        if (was > 0 && n === 0) this.stage?.goHome?.();
    }

    toggle(open = !this.state.open) { this.state.open = open; }

    setCat(cat) { this.state.cat = cat; }

    toss(id) { if (TOYS[id]) this.stage?.toss(TOYS[id]); }

    /** A tile pressed: the toy follows the pointer out of the tray. */
    startDrag(id, ev) { if (TOYS[id]) this.stage?.spawnDrag(TOYS[id], ev); }

    clear() {
        this.stage?.clear();
        this.changed();
    }

    setSounds(on) {
        toySfx.setEnabled(on);
        this.state.sounds = toySfx.enabled;
    }

    setIdlePlay(on) {
        this.state.idle = !!on;
        try { localStorage.setItem(IDLE_KEY, on ? "1" : "0"); } catch (e) { /* private mode */ }
    }

    /** Everything put away and the tray closed (the companion popped out
     *  to the desktop: toys left running in a hidden window would still
     *  hum). */
    putAll() {
        this.stage?.clear();
        this.state.open = false;
        this.changed();
    }
}
