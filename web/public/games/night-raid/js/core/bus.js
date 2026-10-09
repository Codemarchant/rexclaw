// Rexmaw Raids' event bus (Night Helm's, copied): one small, synchronous publish/subscribe channel
// that the HUD, the title, the scene and the audio use to hear the run
// without importing each other. No three.js, no DOM: the node tests can use
// it as it is.
//
// API
//   const bus = createBus({ types, strict })    // types: names this bus carries (default: BUS_TYPES)
//   bus.on(type, fn)          → off()            fn(payload, type), called in subscription order
//   bus.on("*", fn)           → off()            every emit, after the typed listeners (debug taps)
//   bus.once(type, fn)        → off()
//   bus.off(type, fn)
//   bus.emit(type, payload)   → number           how many listeners ran
//   bus.intent(name, payload) → number           shorthand for emit("intent", { name, payload })
//   bus.next(type, filter?)   → Promise<payload> the next emit of `type` that passes `filter`
//   bus.has(type)             → boolean          anyone listening?
//   bus.clear()                                  drops every listener (dispose)
//
// Behaviour
// - Emits are synchronous and depth-first: a listener that emits runs that
//   emit to completion before the next listener of the outer one.
// - A listener added during an emit hears the next emit, not this one; a
//   listener removed during an emit is not called again, even in this one.
// - A listener that throws doesn't stop the others. The error is logged with
//   console.debug and re-emitted as "error" { type, error } (never from an
//   "error" listener itself, so a broken error handler can't loop).
// - Types are checked against `types`: an unknown type is logged once with
//   console.debug, or throws a TypeError when `strict` is on (the tests).
//
// The channels the game uses (payloads are typed below):
//   "intent"   the user's intents, HUD → run (INTENTS)
//   EVENTS     the run's domain events (run.on), re-emitted on the app bus by main.js
//   UI_EVENTS  page-level traffic: settings changes, toasts, boot progress, views

/** The user's intents (run.input). */
export const INTENTS = Object.freeze([
  "start", "again", "quit", "retire", "sail", "sprint", "wheel", "aim", "fire", "brace", "swivel", "spyglass", "order",
  "suggestion", "proposal", "board", "boarding_move", "pause", "resume", "camera", "mode", "loaded",
  "companion", "captain_line", "speech_end", "skip",
  // v3: the manual briefing, the crew modes, right-click marking.
  "start_voyage", "back", "crew_mode", "mark",
  // v4: the target lock, the deck fight's pistol / rally / orders.
  "lock", "lock_cycle", "pistol", "rally", "boarding_order",
]);

/** The run's domain events (run.on): see the core API in nightraid-interfaces.md. */
export const EVENTS = Object.freeze([
  "phase", "tick", "contact", "volley", "ports", "impact", "fire", "leak", "sink", "surrender", "brace", "brace_call",
  "swivel", "order", "suggestion", "board", "bank", "plunder", "heat", "hazard", "overboard",
  "end", "say", "crew_line", "medal", "results", "camera", "pause", "tell", "force", "cancel_force", "error",
  "salvage", "spyglass", "mark", "log", "spawn", "wave", "escaped", "captured", "known", "weak", "gun_down", "gun_up",
  "cove", "pickup", "crew_move", "dry_fire", "weapon", "barrel", "mortar_shot", "job", "heading_call", "danger",
  "objective", "mission", "spotted", "sprint", "split",
  // v3
  "crew_mode", "contrib",
  // v4
  "boardfight", "lock", "sea_event",
  // v4.2: power-ups (spawn / pickup / use / expire)
  "powerup",
  // v1 names kept so old listeners don't warn (never emitted in v2).
  "proposal", "reward", "dawn", "override", "legend", "jettison",
]);

/** Page-level events that are not the run's. */
export const UI_EVENTS = Object.freeze(["state", "settings", "toast", "boot", "view", "tally", "avatar_beat", "avatar_work",
  "crew_progress", "crew_overboard", "crew_splash", "look", "mortar_mode",
  // v3: the pointer-lock state (ui/input.js → settings) and the side the last hit landed on (ui/shipstatus.js → hud).
  "mouse_lock", "hit_side"]);

/** Everything the app bus carries. */
export const BUS_TYPES = Object.freeze(["intent", ...EVENTS, ...UI_EVENTS]);

/**
 * The intents' payloads and the run's events are documented in the core API
 * (nightraid-interfaces.md) and on createRun (run.js).
 */

const MAX_DEPTH = 32;

/**
 * Make a bus.
 * @param {{types?: readonly string[]|null, strict?: boolean, name?: string}} [opts]
 *   `types`: the names this bus accepts (null accepts anything); `strict`:
 *   throw on an unknown type instead of logging it; `name`: shown in logs.
 * @returns {{
 *   on(type: string, fn: (payload: any, type: string) => void): () => void,
 *   once(type: string, fn: (payload: any, type: string) => void): () => void,
 *   off(type: string, fn: Function): void,
 *   emit(type: string, payload?: any): number,
 *   intent(name: IntentName, payload?: object): number,
 *   next(type: string, filter?: (payload: any) => boolean): Promise<any>,
 *   has(type: string): boolean,
 *   clear(): void,
 * }}
 */
export function createBus({ types = BUS_TYPES, strict = false, name = "bus" } = {}) {
  const known = types ? new Set(types) : null;
  const warned = new Set();
  /** @type {Map<string, Array<{fn: Function, live: boolean}>>} */
  const lists = new Map();
  let depth = 0;

  function check(type) {
    if (typeof type !== "string" || !type) throw new TypeError(`${name}: event type must be a non-empty string`);
    if (type === "*" || !known || known.has(type)) return;
    if (strict) throw new TypeError(`${name}: unknown event type "${type}"`);
    if (!warned.has(type)) { warned.add(type); console.debug(`[rexmaw-raids] ${name}: unknown event type "${type}"`); }
  }

  function on(type, fn) {
    check(type);
    if (typeof fn !== "function") throw new TypeError(`${name}: listener for "${type}" must be a function`);
    const entry = { fn, live: true };
    // Copy-on-write: an emit in progress keeps iterating its own snapshot.
    lists.set(type, [...(lists.get(type) || []), entry]);
    return () => remove(type, entry);
  }

  function remove(type, entry) {
    entry.live = false;
    const list = lists.get(type);
    if (!list) return;
    const rest = list.filter((e) => e !== entry);
    if (rest.length) lists.set(type, rest); else lists.delete(type);
  }

  function off(type, fn) {
    for (const entry of lists.get(type) || []) if (entry.fn === fn) remove(type, entry);
  }

  function once(type, fn) {
    const stop = on(type, (payload, t) => { stop(); fn(payload, t); });
    return stop;
  }

  function run(entries, type, payload) {
    let n = 0;
    for (const entry of entries) {
      if (!entry.live) continue;
      n++;
      try {
        entry.fn(payload, type);
      } catch (error) {
        console.debug(`[rexmaw-raids] ${name}: a "${type}" listener threw`, error);
        if (type !== "error") emit("error", { type, error });
      }
    }
    return n;
  }

  function emit(type, payload) {
    check(type);
    if (type === "*") throw new TypeError(`${name}: "*" is for listening, not emitting`);
    if (depth >= MAX_DEPTH) {
      console.debug(`[rexmaw-raids] ${name}: "${type}" dropped, emits nested ${MAX_DEPTH} deep (a listener loop?)`);
      return 0;
    }
    depth++;
    try {
      const typed = lists.get(type);
      const wild = lists.get("*");
      return (typed ? run(typed, type, payload) : 0) + (wild ? run(wild, type, payload) : 0);
    } finally {
      depth--;
    }
  }

  function intent(intentName, payload) {
    if (!INTENTS.includes(intentName)) {
      if (strict) throw new TypeError(`${name}: unknown intent "${intentName}"`);
      console.debug(`[rexmaw-raids] ${name}: unknown intent "${intentName}"`);
    }
    return emit("intent", payload === undefined ? { name: intentName } : { name: intentName, payload });
  }

  function next(type, filter = null) {
    return new Promise((resolve) => {
      const stop = on(type, (payload) => {
        if (filter && !filter(payload)) return;
        stop();
        resolve(payload);
      });
    });
  }

  return {
    on, once, off, emit, intent, next,
    has: (type) => !!lists.get(type)?.length,
    clear: () => { for (const list of lists.values()) for (const e of list) e.live = false; lists.clear(); },
  };
}
