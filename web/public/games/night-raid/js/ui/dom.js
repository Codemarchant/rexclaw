// Small DOM helpers shared by Rexmaw Raids' UI modules (hud, gunnery, compass,
// chart, orders, suggestions, contacts, boarding, briefing, title, results,
// coach, settings, input), copied from Night Helm's and given the raids'
// words: missions, weapons, orders, enemy classes, the compass. No three.js
// and no game rules: the core (js/core) is the source of truth; these only
// name and draw what its state says.

import { MISSIONS as CORE_MISSIONS, MODES as CORE_MODES, DAY_MISSIONS, NIGHT_MISSIONS, FREE_MISSIONS } from "../core/const.js";

/** The game folder, so asset paths work wherever the page is served from. */
export const BASE = new URL("../../", import.meta.url).href;

/** An asset under the game folder: `asset("assets/img/logo.webp")`. */
export const asset = (path) => new URL(path, BASE).href;

/** The kit, if it loaded. */
export const kit = () => window.RexGame || null;

/**
 * Build an element: `h("button.nr-btn#go", { type: "button", onclick }, "Set sail")`.
 * Props: `class`, `style` (object or string), `dataset`, `on<event>` handlers,
 * `html` (trusted markup), anything else becomes an attribute (false/null skip it).
 * @param {string} tag   "tag.class.class#id"
 * @param {object} [props]
 * @param {...(Node|string|number|null|false|Array)} kids
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || "div");
  for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/** Replace an element's children. */
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

/** Show or hide with the `hidden` attribute; returns the element. */
export function show(el, on) {
  if (el && el.hidden === !!on) el.hidden = !on;
  return el;
}

/** Set text only when it changed (the HUD repaints at 10 Hz). */
export function text(el, value) {
  const s = String(value ?? "");
  if (el && el.textContent !== s) el.textContent = s;
  return el;
}

/** Toggle a class only when it changed. */
export function flag(el, cls, on) {
  if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
  return el;
}

/** Set a CSS custom property only when it changed (a 0..1 bar, rounded to 0.1 %). */
export function prop(el, name, value) {
  if (!el) return el;
  const v = typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value);
  if (el.style.getPropertyValue(name) !== v) el.style.setProperty(name, v);
  return el;
}

/** Clamp `v` into [lo, hi]. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A finite number or the fallback. */
export const num = (v, fallback = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);

/** Ease-out cubic: fast start, gentle landing. */
export const easeOut = (t) => 1 - (1 - t) ** 3;

/** True when the person asked for less motion (OS setting or the game's Motion: Reduced). */
export function reducedMotion() {
  if (document.body.classList.contains("nr-reduced")) return true;
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/**
 * Count a number up in an element (score tallies). Resolves when it lands.
 * @param {HTMLElement} el
 * @param {number} to
 * @param {{from?: number, ms?: number, format?: (n: number) => string}} [opts]
 * @returns {Promise<void>}
 */
export function countUp(el, to, { from = 0, ms = 900, format = (n) => String(n) } = {}) {
  if (!el) return Promise.resolve();
  if (reducedMotion() || ms <= 0 || to === from) { el.textContent = format(to); return Promise.resolve(); }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const t = clamp((now - t0) / ms, 0, 1);
      el.textContent = format(Math.round(from + (to - from) * easeOut(t)));
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Restart a CSS animation class on an element (pulse, pop, shake). */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// A browser starts audio only inside a real gesture, and a hover isn't one: the
// kit's hover tick would wake its AudioContext too early (a console warning).
let gestured = false;
for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, () => { gestured = true; }, { capture: true, once: true });

/** The kit's UI sounds (hover, click, …), silently skipped when the kit is absent or muted, or before the first gesture. */
export function uiSound(name) {
  if (!gestured) return;
  try { kit()?.sfx?.[name]?.(); } catch { /* sound is a nicety */ }
}

/** Give buttons in `root` the kit's hover tick and click sound. */
export function soundButtons(root) {
  root.addEventListener("pointerenter", (e) => {
    if (e.target instanceof HTMLButtonElement && !e.target.disabled) uiSound("hover");
  }, true);
  root.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button") : null;
    if (b && !b.disabled && !b.dataset.silent) uiSound("click");
  });
}

/** localStorage, never throwing (private windows, blocked storage). */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

/** Is keyboard focus in a text field (so game keys stand down)? */
export function typing(target = document.activeElement) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** Where the reticle sits (fraction of the height): the screen point the guns, the swivel and the spyglass use with the mouse locked. */
export const RETICLE_Y = 0.46;
export const reticlePoint = () => ({ x: innerWidth / 2, y: innerHeight * RETICLE_Y });

/**
 * The open sea between the HUD's top furniture (compass, objective, fail chips) and the helm strip:
 * {top, bottom} in client pixels, re-measured at most four times a second. Things pinned over the
 * world (the BOARD prompt, the objective arrow, a target's bar) stay inside it.
 */
let band = { top: 160, bottom: 600, at: -1e9 };
export function seaBand() {
  const now = performance.now();
  if (now - band.at < 250) return band;
  const topEl = document.querySelector("#hud .nr-top"), botEl = document.querySelector("#hud .nr-bottom");
  const t = topEl?.getBoundingClientRect?.(), b = botEl?.getBoundingClientRect?.();
  band = {
    top: t && t.height > 0 ? Math.round(t.bottom + 8) : 160,
    bottom: b && b.height > 0 ? Math.round(b.top - 8) : innerHeight - 220,
    at: now,
  };
  if (band.bottom - band.top < 120) band.bottom = band.top + 120;
  return band;
}

/** The companion's display name with a fallback. */
export const nameOf = (ctx) => (ctx?.name?.() || "Your companion");

/** Insert the companion's name into a template: "{Name} calls the reefs". */
export const withName = (ctx, s) => String(s).replaceAll("{Name}", nameOf(ctx));

// ---- The raids' words --------------------------------------------------------------

/** The missions (the core's table: label, time, tab, hint, objective, limit, medals, ammo). */
export const MISSIONS = CORE_MISSIONS;
/** The title's tabs, in order, with their missions (the kit's mode tabs are these ids). */
export const TABS = Object.freeze({
  day: { id: "day", label: CORE_MODES?.day?.label || "Day", hint: CORE_MODES?.day?.hint || "", missions: DAY_MISSIONS },
  night: { id: "night", label: CORE_MODES?.night?.label || "Night", hint: CORE_MODES?.night?.hint || "", missions: NIGHT_MISSIONS },
  free: { id: "free", label: CORE_MODES?.free?.label || "Free Roam", hint: CORE_MODES?.free?.hint || "", missions: FREE_MISSIONS },
});
export const TAB_IDS = Object.freeze(["day", "night", "free"]);
export const DEFAULT_TAB = "day";
/** Mission order for "next mission" (day, then night; free roam has no next). */
export const MISSION_ORDER = Object.freeze([...DAY_MISSIONS, ...NIGHT_MISSIONS]);
/** One line of crew colour per mission for the briefing card ("Leo: …"), shown under the objective. */
export const MISSION_LINES = Object.freeze({
  spice_fleet: ["leo", "Three fat merchants and one far cape. Chain shot stops a runner."],
  silence_fort: ["rex", "Towers don't dodge. Mortars from out of their reach, Captain."],
  navy_convoy: ["leo", "Frigate first, or slip past her for the chest brig. Your call."],
  iron_duke: ["leo", "The Iron Duke. Biggest guns in the navy. Keep moving."],
  smugglers_run: ["eve", "Fog and reefs all the way. Listen for my headings."],
  the_gloam: ["eve", "She hides in her own fog. Watch for the lanterns going out."],
  krakens_wake: ["ara", "Two wrecks, one very hungry sea. Shoot the arms, not the deck."],
  free_day: ["sal", "Open water, good wind. Bank it before the sun goes down."],
  free_night: ["eve", "Lanterns low. The bay's ours till dawn."],
});
/** Medal categories (results.medals keys), with how each threshold reads. */
export const MEDAL_CATS = Object.freeze({
  time: { label: "Time", unit: (v) => clock(v), better: "under" },
  hull: { label: "Hull", unit: (v) => `${Math.round(v)} %`, better: "over" },
  loot: { label: "Loot", unit: (v) => gold(v), better: "over" },
});
export const MEDAL_TIERS = Object.freeze(["gold", "silver", "bronze"]);
export const TIER_LABEL = Object.freeze({ gold: "Gold", silver: "Silver", bronze: "Bronze" });

/** The named crew, with their colours and roles. */
export const CREW = Object.freeze({
  rex: { name: "Rex", role: "Quartermaster", color: "#ff8a5c" },
  eve: { name: "Eve", role: "Chartkeeper", color: "#7fd3ff" },
  ara: { name: "Ara", role: "Steward", color: "#ffb3d1" },
  sal: { name: "Sal", role: "Engineer", color: "#9be37a" },
  leo: { name: "Leo", role: "Officer of the watch", color: "#d6b4ff" },
});

/** The Captain's weapons (core gunnery `weapon`): label, the look that picks it, reload (s) and what it does. */
export const WEAPONS = Object.freeze({
  broadside: { label: "Broadside", short: "Guns", look: "look to the side", does: "aimed volley: hold to aim, click to fire" },
  heavy: { label: "Heavy shot", short: "Heavy", look: "side, not aiming", does: "point-blank volley (≤ 90 m)" },
  chain: { label: "Chain shot", short: "Chain", look: "look ahead", does: "masts and sails: she slows" },
  barrels: { label: "Fire barrels", short: "Barrels", look: "look astern", does: "burning barrels in your wake" },
  mortar: { label: "Mortar", short: "Mortar", look: "M, or a far target", does: "three shells, 2.5 s to land" },
  swivel: { label: "Swivel gun", short: "Swivel", look: "a glowing weak point", does: "click the weak point" },
  none: { label: "", short: "", look: "", does: "" },
});
/** Ammunition counts on `ship.ammo` (round and heavy never run out). */
export const AMMO = Object.freeze({
  round: { label: "Round shot", tag: "Round" }, heavy: { label: "Heavy shot", tag: "Heavy" },
  chain: { label: "Chain shot", tag: "Chain" }, mortar: { label: "Mortar shells", tag: "Mortar" }, barrels: { label: "Fire barrels", tag: "Barrels" },
});

/** Order kinds (state.orders / `order` events) as the feed says them. */
export const ORDER_KIND = Object.freeze({
  man_guns: "Guns", repair: "Repairs", bail: "Pumps", heading: "Heading", danger: "Danger", brace_call: "Brace", suggest: "Suggests",
  done: "Done", stale: "Stood down", refused: "Can't", spyglass: "Spyglass",
});
export const GUN_SIDES = Object.freeze({ port: "Port guns", starboard: "Starboard guns", bow: "Bow chasers", mortar: "The mortar" });
export const ORDER_MODES = Object.freeze({ once: "one volley", keep_firing: "fire as she bears", hold: "laid, on your word" });
export const REPAIR_WHAT = Object.freeze({ hull: "the hull", masts: "the masts", leaks: "the leaks", fires: "the fires", all: "everything" });

/** Suggestion kinds (state.suggestion): the card's headline. */
export const SUGGEST = Object.freeze({
  target: "Take her", loot: "Loot ahead", route: "A way through", flee: "Run for it", board: "Board her",
});

/** Danger kinds (mark_danger) for the chart labels. */
export const DANGERS = Object.freeze({ reef: "Reef", rocks: "Rocks", shoal: "Shoal", patrol: "Patrol", whirlpool: "Whirlpool", wreck: "Wreck" });

/** Pickup kinds (collectables). */
export const PICKUPS = Object.freeze({
  crate: { label: "Supply crate", glyph: "▣" }, barrel: { label: "Repair barrel", glyph: "◍" }, bottle: { label: "Message in a bottle", glyph: "◊" },
  chest: { label: "Treasure chest", glyph: "◆" }, flotsam: { label: "Flotsam", glyph: "▪" }, ring: { label: "Maelstrom chest", glyph: "◆" },
});

/** Enemy classes: name, a one-line gist and a glyph for the chart and the contacts. */
export const CLASSES = Object.freeze({
  merchant: { name: "Merchant", gist: "fat and slow", glyph: "M" },
  gunboat: { name: "Gunboat", gist: "darts in pairs", glyph: "g" },
  brig: { name: "Brig", gist: "rams", glyph: "B" },
  frigate: { name: "Frigate", gist: "crosses your T", glyph: "F" },
  fireship: { name: "Fire ship", gist: "rams and explodes", glyph: "!" },
  manowar: { name: "Man-o'-war", gist: "heavy guns, mortars", glyph: "W" },
  gloam: { name: "The Gloam", gist: "the legend", glyph: "G" },
  tower: { name: "Gun tower", gist: "the fort's guns", glyph: "T" },
});

/** Who did something, for a toast or the log: the companion's name, the Captain, or a crew member. */
export function byName(ctx, by) {
  if (!by || by === "companion" || by === "me" || by === "first_mate") return nameOf(ctx);
  if (by === "captain" || by === "user") return "Captain";
  if (by === "crew") return "The crew";
  if (CREW[by]) return CREW[by].name;
  return String(by);
}

/** A crew id's display name ("me" is the companion). */
export function crewName(ctx, id) {
  if (id === "me") return nameOf(ctx);
  if (id === "hands") return "Hands";
  return CREW[id]?.name || String(id);
}

/** A crew id's chip colour ("me" is gilt). */
export const crewColor = (id) => (id === "me" ? "#ffcf6b" : CREW[id]?.color || "#c9d3e6");

/**
 * The locked target's contact id (v4 `state.lock`: an id, or {id | contactId}; v3's `marked` is its alias
 * and stands in when the core has no `lock` yet). null when nothing is locked.
 */
export function lockOf(s) {
  const L = s?.lock;
  if (L && typeof L === "object") return L.id ?? L.contactId ?? L.target ?? null;
  if (typeof L === "string" || typeof L === "number") return L;
  return s?.marked ?? null;
}

/** v4 random sea events (`state.events[]`, `sea_event`): one word per kind, its label and its chart / chip colour. */
export const SEA_EVENTS = Object.freeze({
  spout: { label: "Waterspout", warn: "Waterspout forming", color: "#7fb8ff" },
  squall: { label: "Squall", warn: "Squall coming", color: "#9fb4ff" },
  waves: { label: "Rogue waves", warn: "Rogue waves building", color: "#8cc8ff" },
  derelict: { label: "Derelict", warn: "A derelict adrift", color: "#d8a860" },
  treasure: { label: "Treasure afloat", warn: "Something glinting", color: "#ffd35a" },
  kraken_arm: { label: "Kraken arm", warn: "Something stirs below", color: "#3ff3e0" },
  fog: { label: "Fog bank", warn: "Fog rolling in", color: "#c9d3e6" },
  // v4: the whacky ones.
  gerald: { label: "Gerald", warn: "A fin circling", color: "#ff7a5a" },
  sky_whale: { label: "Sky whale", warn: "Whale blowing", color: "#8fd0ff" },
  dolphins: { label: "Dolphin pod", warn: "Dolphins!", color: "#7fe6ff" },
  flying_fish: { label: "Flying fish", warn: "Flying fish", color: "#9fc8ff" },
  jellyfish: { label: "Jellyfish bloom", warn: "A glow below", color: "#c08bff" },
  turtle: { label: "Island turtle", warn: "An island moving", color: "#9fdc8a" },
  admiral: { label: "The Seagull Admiral", warn: "Gulls in formation", color: "#ffe08a" },
});
/** A sea event's kind in one word ("waterspout" / "whirlwind" → spout, "rogue_waves" → waves, …). */
export function seaKind(k) {
  const s = String(k || "").toLowerCase();
  if (/spout|whirl/.test(s)) return "spout";
  if (/squall|gust/.test(s)) return "squall";
  if (/wave/.test(s)) return "waves";
  if (/derelict|wreck|ghost/.test(s)) return "derelict";
  if (/treasure|flotsam|loot|chest/.test(s)) return "treasure";
  if (/kraken|arm|tentacle/.test(s)) return "kraken_arm";
  if (/fog|mist/.test(s)) return "fog";
  return s || "event";
}
/** A sea event's stage in one word: "warn" (telegraphed), "active" or "end". */
export function seaStage(ev) {
  const s = String(ev?.stage ?? ev?.state ?? "").toLowerCase();
  if (/warn|telegraph|forming|soon/.test(s)) return "warn";
  if (/end|done|over|gone|fade/.test(s)) return "end";
  if (!s && Number(ev?.eta) > 0) return "warn";
  return "active";
}

/** A ship class's small silhouette (SVG, currentColor): masts by size, the fire ship's flame, the tower. */
export function classIcon(cls) {
  const mast = (x, hgt) => `<path d="M${x - 0.55} ${15.4 - hgt}h1.1v${hgt}h-1.1Z"/><path d="M${x + 0.9} ${15.9 - hgt}h${(hgt * 0.42).toFixed(1)}l-.6 ${(hgt * 0.62).toFixed(1)}h-${(hgt * 0.36).toFixed(1)}Z" opacity=".8"/>`;
  const hull = (big = false) => (big ? '<path d="M1.5 14.6h21l-2.4 5.4H3.9Z"/>' : '<path d="M3 15.4h18l-2.4 4H5.4Z"/>');
  let body;
  switch (cls) {
    case "tower": body = '<path d="M7 21V9l-1-2V4h2v2h2V4h4v2h2V4h2v3l-1 2v12Z"/><rect x="10.5" y="11" width="3" height="4" rx="1" fill="rgba(0,0,0,.45)"/>'; break;
    case "fireship": body = `${hull()}<path d="M12 3c.8 2.8 4.3 4.3 4.3 8.4a4.3 4.3 0 0 1-8.6 0c0-2 1.1-3.3 2-4.2.2 1.2.7 2.2 1.6 2.5C11 7.3 11.2 5 12 3Z"/>`; break;
    case "gunboat": body = `${hull()}${mast(11, 8)}`; break;
    case "merchant": body = `${hull(true)}${mast(8, 8)}${mast(14, 9)}`; break;
    case "brig": body = `${hull()}${mast(8, 9)}${mast(14, 10)}`; break;
    case "frigate": body = `${hull(true)}${mast(6, 8)}${mast(11, 11)}${mast(16, 9)}`; break;
    case "manowar": body = `${hull(true)}${mast(6, 9)}${mast(11, 12)}${mast(16, 10)}<path d="M4 17h16v.9H4Z" fill="rgba(0,0,0,.45)"/>`; break;
    case "gloam": body = `${hull(true)}${mast(6, 9)}${mast(11, 12)}${mast(16, 10)}<circle cx="18.5" cy="4.5" r="2.2"/>`; break;
    default: body = `${hull()}${mast(11, 9)}`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** A contact's display name: her name once known, else "the brig". */
export function contactName(c, { article = true } = {}) {
  if (!c) return article ? "her" : "Her";
  if (c.known && c.name) return c.name;
  const n = (CLASSES[c.cls]?.name || "ship").toLowerCase();
  return article ? `the ${n}` : n[0].toUpperCase() + n.slice(1);
}

// ---- The compass (heading 0 = +Z north, increasing toward −X east) ----------------------

export const COMPASS16 = Object.freeze(["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]);
export const COMPASS8 = Object.freeze(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

/** Normalise any heading to 0..360. */
export const norm360 = (deg) => ((Number(deg) || 0) % 360 + 360) % 360;

/** Signed smallest difference a − b in degrees (−180..180). */
export const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** Three-digit degrees: 45 → "045". */
export const deg3 = (deg) => String(Math.round(norm360(deg)) % 360).padStart(3, "0");

/** The compass bearing (0..360) from (x, z) toward (tx, tz). */
export const bearingTo = (x, z, tx, tz) => norm360(Math.atan2(-(tx - x), tz - z) * 180 / Math.PI);

/** The 8-point abbreviation of a bearing. */
export const point8 = (deg) => COMPASS8[Math.round(norm360(deg) / 45) % 8];

/** A relative bearing (+ = starboard) as the sailor's words: "dead ahead", "starboard bow", "port beam", "astern". */
export function sideWord(rel) {
  const r = angleDiff(rel, 0), a = Math.abs(r);
  if (a < 12) return "dead ahead";
  if (a > 165) return "astern";
  const s = r > 0 ? "starboard" : "port";
  return a < 60 ? `${s} bow` : a < 120 ? `${s} beam` : `${s} quarter`;
}

/** Metres for the HUD: "640 m", "1.2 km". */
export const dist = (m) => (!Number.isFinite(m) ? "" : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/** Seconds as "m:ss". */
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Gold with a thousands separator: 1250 → "1,250". */
export const gold = (n) => Math.round(Number(n) || 0).toLocaleString("en-GB");

/** A contact's relative bearing and distance from the ship, from the state (the core's own `rel`/`dist` first). */
export function relOf(ship, c) {
  if (!ship || !c) return { rel: 0, dist: Infinity, bearing: 0 };
  const bearing = bearingTo(ship.x, ship.z, c.x, c.z);
  const rel = Number.isFinite(c.rel) ? c.rel : angleDiff(bearing, ship.heading || 0);
  const d = Number.isFinite(c.dist) ? c.dist : Math.hypot(c.x - ship.x, c.z - ship.z);
  return { rel, dist: d, bearing };
}

/** Small inline SVG icons (currentColor). */
export const ICONS = Object.freeze({
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  skull: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c-4.8 0-8 3.3-8 7.6 0 2.6 1.2 4.4 2.8 5.5v2.6c0 .9.7 1.6 1.6 1.6h.9v1.7h1.6v-1.7h2.2v1.7h1.6v-1.7h.9c.9 0 1.6-.7 1.6-1.6v-2.6c1.6-1.1 2.8-2.9 2.8-5.5 0-4.3-3.2-7.6-8-7.6Zm-3.2 10.6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm6.4 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM12 13.6l1.1 2.1h-2.2Z"/></svg>',
  coin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="6" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.4"/></svg>',
  chest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v1H3Z"/><path d="M3 12h18v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><rect x="10.5" y="10" width="3" height="4" rx=".8" fill="rgba(0,0,0,.45)"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.6 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.2 2.6-5.4.2 1.6.9 2.8 2 3.2C10.8 8 11 5 12 2Z"/></svg>',
  drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5S5.5 10 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10 12 2.5 12 2.5Z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.5"/><path d="M5 20c0-4 3.1-7 7-7s7 3 7 7Z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/><circle cx="12" cy="12" r="1.8"/></svg>',
  spyglass: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2.5 15.5 13-7.5 2 3.5-13 7.5Z"/><path d="m16 6.8 3.6-2.1 2.4 4.1-3.6 2.1Z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h2v20H5Z"/><path d="M7 3h12l-3 4.5L19 12H7Z"/></svg>',
  cannon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5 16 6l1.2 4.6-13 3.5A2.2 2.2 0 0 1 3 9.5Z"/><path d="M17 5.6l2.6-.7 1.2 4.6-2.6.7Z"/><circle cx="9" cy="16.5" r="3.4"/><circle cx="9" cy="16.5" r="1.2" fill="rgba(0,0,0,.45)"/></svg>',
  chain: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="3.6"/><circle cx="18" cy="12" r="3.6"/><path d="M8.5 11h7v2h-7Z"/></svg>',
  mortar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 20h12l-1.5-4h-9Z"/><path d="m9 15 3.5-10 4 1.5L13 16Z"/><circle cx="18" cy="4" r="1.6"/></svg>',
  barrel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10c1.4 2.4 2 5 2 8s-.6 5.6-2 8H7c-1.4-2.4-2-5-2-8s.6-5.6 2-8Z"/><path d="M5.6 8.5h12.8M5.6 15.5h12.8" stroke="rgba(0,0,0,.4)" stroke-width="1.4"/><path d="M12 1.5c.6 1.4 2 2 2 3.6a2 2 0 0 1-4 0c0-1 .7-1.6 1-2.2.2.6.5 1 1 1.2Z"/></svg>',
  swivel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12v3H4Z"/><path d="M16 11h4v5h-4Z"/><path d="M8 15v5h2v-5Z"/></svg>',
  wind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h11a3 3 0 1 0-3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3 14h15a3 3 0 1 1-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  hammer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3h7v5h-7Z"/><path d="m14 8-9.5 9.5 2 2L16 10Z"/></svg>',
  pump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3H8Z"/><path d="M10 7h4v13h-4Z"/><path d="M14 9h5v2h-5Z"/><path d="M5 21h14v-1.5H5Z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m12 4 2.6 8H9.4Z"/><path d="m12 20-2.6-8h5.2Z" opacity=".45"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21Z"/><path d="M11 9h2v6h-2Zm0 7.5h2v2h-2Z" fill="rgba(0,0,0,.55)"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.5 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.6"/><path d="M12 1.5v3.2M12 19.3v3.2M1.5 12h3.2M19.3 12h3.2M4.6 4.6l2.2 2.2M17.2 17.2l2.2 2.2M4.6 19.4l2.2-2.2M17.2 6.8l2.2-2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 2.8A9.5 9.5 0 1 0 21.2 15 7.6 7.6 0 0 1 15.5 2.8Z"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5 9 3l6 2.5L21 3v15.5L15 21l-6-2.5L3 21Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 3v15.5M15 5.5V21" stroke="currentColor" stroke-width="1.4"/></svg>',
});

/** The medal icon: a coloured disc on a ribbon, for the tier (or an empty outline). */
export function medalSvg(tier) {
  const fill = tier === "gold" ? "#ffcf4a" : tier === "silver" ? "#d6dde8" : tier === "bronze" ? "#d08a52" : "none";
  const rim = tier ? "#3a2408" : "rgba(255,207,107,.45)";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 1.5h4l1 5-3 1.5Z" fill="${tier ? "#a8261a" : "none"}" stroke="${rim}" stroke-width=".8"/><path d="M17 1.5h-4l-1 5 3 1.5Z" fill="${tier ? "#1d4f7a" : "none"}" stroke="${rim}" stroke-width=".8"/><circle cx="12" cy="15" r="7" fill="${fill}" stroke="${rim}" stroke-width="1.3"/>${tier ? '<path d="m12 10.6 1.4 2.9 3.1.4-2.3 2.1.6 3.1L12 17.6l-2.8 1.5.6-3.1-2.3-2.1 3.1-.4Z" fill="rgba(60,36,8,.55)"/>' : ""}</svg>`;
}

/** v4.2 power-ups: name, colour (the scene's own), a few words on what it does, and its icon (SVG, currentColor). */
const pwSvg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
export const POWERUPS = Object.freeze({
  swift_wind: { label: "Swift Wind", color: "#5fe3ff", short: "+30 % speed", icon: pwSvg('<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 14h15a3 3 0 1 1-3 3"/><path d="M3 19h7"/></g>') },
  quick_hands: { label: "Quick Hands", color: "#ff9a3c", short: "reload ×2", icon: pwSvg('<path d="M13.5 2 4.5 13.5h6l-1.5 8.5 9.5-12h-6.2Z"/>') },
  hot_shot: { label: "Hot Shot", color: "#ff4a2a", short: "volleys set fires", icon: pwSvg('<path d="M12 2c1 3.6 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.2 2.6-5.4.2 1.6.9 2.8 2 3.2C10.8 8 11 5 12 2Z"/>') },
  iron_hull: { label: "Iron Hull", color: "#a8bcff", short: "half damage", icon: pwSvg('<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5Z"/>') },
  patch_kit: { label: "Patch Kit", color: "#5ee07a", short: "+20 hull", icon: pwSvg('<path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5Z"/>') },
  powder_keg: { label: "Powder Keg", color: "#c486ff", short: "shot topped up, guns loaded", icon: pwSvg('<path d="M7 5h10c1.3 2.2 1.9 4.6 1.9 7.4S18.3 17.8 17 20H7c-1.3-2.2-1.9-4.8-1.9-7.6S5.7 7.2 7 5Z"/><path d="M5 9.3h14M5 15.6h14" stroke="rgba(0,0,0,.45)" stroke-width="1.5"/>') },
  double_doubloons: { label: "Double Doubloons", color: "#ffd23a", short: "gold ×2", icon: pwSvg('<circle cx="9" cy="13" r="6.2"/><circle cx="15.5" cy="10" r="6.2"/><circle cx="15.5" cy="10" r="3.6" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1.3"/>') },
  kraken_ink: { label: "Kraken Ink", color: "#7a66ff", short: "their shots scatter", icon: pwSvg('<path d="M12 2.5S5.5 10 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10 12 2.5 12 2.5Z"/><circle cx="9.6" cy="14.2" r="1.7" fill="rgba(0,0,0,.45)"/>') },
  mermaid_kiss: { label: "Mermaid's Kiss", color: "#ff6fcf", short: "fires out, leaks plugged, dry", icon: pwSvg('<path d="M12 21s-7.6-4.6-9.5-9.4C1 7.9 3.6 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.4 0 6 3.4 4.5 7.1C19.6 16.4 12 21 12 21Z"/>') },
});
