// Is the companion on a call right now? (Copied from Night Helm.) Night Raid
// runs a little differently when they are: on a call the briefs come every
// 8 s at most and the world keeps its full pace; off one (text turns are
// slower) briefs wait 18 s, the world runs at 0.8× and telegraphs last ×1.4.
// The Captain's latest spoken line also rides into the briefs.
//
// Two sources, cheapest first:
// - the app's transcript mirror (BroadcastChannel "rexclaw-transcript"):
//   a live call with this companion shows up the moment it starts, and the
//   Captain's latest spoken line comes with it;
// - a poll every 6 s (and when the tab comes back into view) of the voice
//   line endpoint with an empty text, which answers {on_call} before doing
//   any speech work.
//
// Touches the kit's endpoints and BroadcastChannel, so it is not pure; the
// run only ever sees `onCall()`.

/** How often the server is asked, in ms. */
export const POLL_MS = 6000;
/** The app's transcript channel (web/src/services/transcript_sync.js). */
export const TRANSCRIPT_CHANNEL = "rexclaw-transcript";

/**
 * @typedef {Object} Presence
 * @property {() => boolean} onCall                   on a call with this companion
 * @property {(fn: (on: boolean) => void) => () => void} onChange
 * @property {(fn: () => void) => () => void} onLine  the Captain said a new line on the call
 * @property {() => string|null} lastUserText         the Captain's latest spoken or typed line on the call since mark()
 * @property {() => void} mark                        forget lines said before now
 * @property {() => Promise<boolean>} poll            ask the server now
 * @property {() => void} dispose
 */

/**
 * Watch the companion's call status.
 * @param {Object} deps
 * @param {object|null} deps.game         the kit's game handle (companionId, companion)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.pollMs]
 * @returns {Presence}
 */
export function createPresence({ game = null, fetchImpl = globalThis.fetch?.bind(globalThis), pollMs = POLL_MS } = {}) {
  let on = false;
  let disposed = false;
  let inFlight = null;
  let lastUser = null;      // { key, text }
  let markedKey = null;
  const listeners = new Set();
  const lineListeners = new Set();

  function set(value) {
    const v = !!value;
    if (v === on) return;
    on = v;
    for (const fn of [...listeners]) { try { fn(on); } catch (error) { console.debug("[rexmaw-raids] presence listener threw", error); } }
  }

  function poll() {
    if (disposed) return Promise.resolve(on);
    const agent = game?.companionId;
    if (!agent || typeof fetchImpl !== "function") return Promise.resolve(on);
    if (inFlight) return inFlight;
    inFlight = fetchImpl("/api/games/voiceline", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent, text: "", record: false }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => { if (res) set(!!res.on_call); return on; })
      .catch(() => on)
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  const timer = setInterval(poll, pollMs);
  const onVisible = () => { if (!document.hidden) poll(); };
  try { document.addEventListener("visibilitychange", onVisible); } catch { /* no document: tests */ }

  // The transcript mirror: instant on-call, plus the Captain's latest line.
  let channel = null;
  const sameCompanion = (name) => !!name && !!game?.companion && String(name).trim().toLowerCase() === String(game.companion).trim().toLowerCase();
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(TRANSCRIPT_CHANNEL);
      channel.onmessage = (ev) => {
        const d = ev?.data;
        if (!d || d.type !== "transcript") return;
        if (!sameCompanion(d.agentName)) return;
        if (d.status === "live") set(true);
        else poll();
        const msgs = Array.isArray(d.messages) ? d.messages : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role === "user" && typeof m.content === "string" && m.content.trim()) {
            const key = `${i}:${m.content}`;
            // Only a new line is news: the mirror re-sends the whole transcript on every change.
            if (lastUser?.key !== key) {
              lastUser = { key, text: m.content.trim() };
              for (const fn of [...lineListeners]) { try { fn(); } catch (error) { console.debug("[rexmaw-raids] presence line listener threw", error); } }
            }
            break;
          }
        }
      };
      channel.postMessage({ type: "request" });
    }
  } catch (error) {
    console.debug("[rexmaw-raids] transcript channel unavailable", error);
  }

  poll();

  return {
    onCall: () => on,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onLine(fn) {
      lineListeners.add(fn);
      return () => lineListeners.delete(fn);
    },
    lastUserText: () => (on && lastUser && lastUser.key !== markedKey ? lastUser.text : null),
    mark: () => { markedKey = lastUser?.key ?? null; },
    poll,
    dispose() {
      disposed = true;
      clearInterval(timer);
      try { document.removeEventListener("visibilitychange", onVisible); } catch { /* no document */ }
      try { channel?.close(); } catch { /* already closed */ }
      listeners.clear();
      lineListeners.clear();
    },
  };
}
