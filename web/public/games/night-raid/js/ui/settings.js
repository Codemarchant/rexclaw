// The Settings panel, which doubles as the pause menu while the Rexmaw is
// out on the raid (Night Helm's, with the raid's keys): the companion off a
// call (Help, or Solo: they sit out until a call; main gates the protocol on
// it), the sound faders (Master / Music / Effects / Voices, audio/mix.js), the mouse (cursor aim or
// free look), graphics tier, motion, avatar kind, the broadside cinematics,
// the frame-rate overlay, the keyboard map, and Resume / Restart / Abandon.
// One panel per page: the title and the HUD both open it through
// openSettings() / getSettings().
//
// Opened during a raid it pauses the sim (intent `pause {on: true}`) and
// closing it resumes (`resume`); Restart sends `again {same: true}` and
// Abandon `quit`. Choices persist in localStorage["rx-night-raid-settings"]
// and go out as `settings` bus events ({graphics, motion, avatar, showFps,
// cinematics, invertLook, mouse, companion}); main hands them to the renderer, the
// camera, the companion and the perf overlay; input.js reads `mouse`. The
// faders save themselves (mix.js) and need no event; v4: Effects is the kit's
// shared Effects volume (the ⚙ menu's slider), so the two always agree.

import { h, fill, store, soundButtons, nameOf } from "./dom.js";
import { mix, CHANNELS } from "../audio/mix.js";

const KEY = "rx-night-raid-settings";
const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const TIERS = [["auto", "Auto"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["ultra", "Ultra"]];
/** Phases with the ship in the water (the panel pauses them). */
export const UNDERWAY = new Set(["moored", "sailing", "boarding", "ending"]);

/** The stored choices, with defaults (Reduced motion when the OS asks for it). */
export function readSettings() {
  let osReduced = false;
  try { osReduced = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* old browser */ }
  const s = store.get(KEY, {}) || {};
  return {
    graphics: TIERS.some(([id]) => id === s.graphics) ? s.graphics : "auto",
    motion: s.motion === "reduced" || s.motion === "full" ? s.motion : (osReduced ? "reduced" : "full"),
    avatar: s.avatar === "portrait" ? "portrait" : "3d",
    cinematics: s.cinematics !== false,
    showFps: !!s.showFps,
    invertLook: !!s.invertLook,
    /** "cursor": the look follows where the cursor is (default, no capture); "free": pointer lock, the mouse swings the camera. */
    mouse: s.mouse === "free" ? "free" : "cursor",
    /** Off a call: "solo" (default) they sit out until a call; "help" the companion gets the game's reports and may play. */
    companion: s.companion === "help" ? "help" : "solo",
  };
}

/** The "Companion off a call" choice (Settings and the title share it). */
export const COMPANION_CHOICES = [["help", "Help"], ["solo", "Solo"]];
/** What each choice means, in a line. */
export const companionLine = (choice, name = "Your companion") => (choice === "solo"
  ? `Off a call, ${name} sits out: no reports, no turns. The crew modes (1 / 2 / 3) run the crew. On a call they're back as usual.`
  : `Off a call, ${name} keeps following the raid and plays along in the chat, as the games deck's off-call choice allows. On a call they're with you either way.`);

/** The key map (Settings' Keyboard list and the title's How to play share it). */
export const KEYS = (name = "your companion") => [
  ["Mouse", "Look round the ship: the guns follow the look (ahead chain shot, the sides broadsides, astern fire barrels)"],
  ["Right mouse  or  Q (hold)", "Aim: the arcs show where the shot lands (red = a hit); higher aims farther"],
  ["Click  or  F", "Fire (a tap without aiming on a side: the heavy point-blank volley); on a glowing weak point, the swivel gun"],
  ["Right-click a ship", `Lock her as THE target: the arcs snap to her, the crew and ${name} work on her (open sea: let go)`],
  ["Tab  or  middle click", "Cycle the lock through the ships in sight (Shift+Tab: back); Esc lets go"],
  ["1 / 2 / 3", "Crew mode: Hold · Attack · Defend"],
  ["Mouse wheel", "Zoom: close on the deck ⇄ wide and tactical"],
  ["M", "Mortar mode on / off"],
  ["A / D  or  ← / →", "The wheel (hold)"],
  ["W / S  or  ↑ / ↓", "Sails: furled, half, full"],
  ["Shift (hold)", "Sprint at full sail (drains the wind bar)"],
  ["Space", "Brace for impact (just before it lands: a perfect brace)"],
  ["E (hold)", "Spyglass"],
  ["Y / N", `Take or wave off ${name}'s suggestion`],
  ["B", "Board her: inside a beaten ship's ring, when the B chip shows"],
  ["Boarding: click", "Fire your pistol at the enemy under the cursor (1.2 s reload)"],
  ["Boarding: F", "Rally the crew, once per fight"],
  ["C", "Helm view / chase view"],
  ["Esc", "Let go of the lock; with none, pause, sound and this panel"],
];

let panel = null;

/**
 * The page's settings panel, made on first use.
 * @param {object} ctx  the UI context
 * @returns {{open: () => void, close: (o?: {resume?: boolean}) => void, toggle: () => void, isOpen: () => boolean, current: () => object}}
 */
export function getSettings(ctx) {
  if (!panel) panel = createPanel(ctx);
  return panel;
}

/** Open the settings panel (the pause menu, during a raid). */
export function openSettings(ctx) { getSettings(ctx).open(); }

function createPanel(ctx) {
  const root = ctx.dom.settings || document.body.appendChild(h("div#settings", { hidden: true }));
  let current = readSettings();
  let confirming = false;
  let lastFocus = null;
  let paused = false;

  root.classList.add("nr-modal");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "nr-settings-title");
  soundButtons(root);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  applyBody();
  const stored = () => {
    const s = { ...current };
    if (s.graphics === "auto") delete s.graphics;
    return s;
  };
  queueMicrotask(() => ctx.bus.emit("settings", stored()));
  ctx.bus.on("boot", ({ progress } = {}) => { if (progress >= 1) ctx.bus.emit("settings", stored()); });
  ctx.bus.on("view", ({ name } = {}) => { if (name === "result" || name === "title") close({ resume: false }); });
  ctx.bus.on("mouse_lock", () => { if (!root.hidden) render(); });
  // A fader moved elsewhere (the kit's ⚙ Effects volume, another tab): the open panel's sliders follow.
  mix.on(() => {
    if (root.hidden) return;
    for (const c of CHANNELS) {
      const input = root.querySelector(`#nr-fader-${c.id}`);
      if (!input || document.activeElement === input) continue;
      const pct = Math.round(mix.get(c.id) * 100);
      input.value = String(pct);
      const out = root.querySelector(`output[for="nr-fader-${c.id}"]`);
      if (out) out.textContent = `${pct} %`;
    }
  });

  function set(patch) {
    current = { ...current, ...patch };
    store.set(KEY, current);
    applyBody();
    ctx.bus.emit("settings", patch);
    render();
  }

  function applyBody() {
    document.body.classList.toggle("nr-reduced", current.motion === "reduced");
  }

  const underway = () => UNDERWAY.has(ctx.state()?.phase);

  function tierLine() {
    const q = ctx.R?.quality;
    const perf = ctx.R?.perf?.();
    if (!q && !perf) return "The 3D bay isn't running on this device.";
    const tier = q?.tier || perf?.tier;
    const name = TIERS.find(([id]) => id === tier)?.[1] || tier;
    const dpr = perf?.dpr ? ` at ${perf.dpr.toFixed(2)}× resolution` : "";
    if (current.graphics !== "auto" && tier && tier !== current.graphics) return `Lowered to ${name}${dpr} to keep the frame rate smooth.`;
    return current.graphics === "auto" ? `Auto picked ${name}${dpr}.` : `Running at ${name}${dpr}.`;
  }

  function seg(key, options, label) {
    return h("div.nr-field", null,
      h("span.nr-label", { id: `nr-set-${key}` }, label),
      h("div.nr-seg", { role: "radiogroup", "aria-labelledby": `nr-set-${key}` },
        options.map(([id, txt]) => h("button", {
          type: "button", role: "radio", "aria-checked": String(current[key] === id),
          class: current[key] === id ? "on" : null,
          onclick: () => set({ [key]: id }),
        }, txt))));
  }

  /** One fader: label, slider, the value; it moves the mix live and saves itself (no re-render while dragging). */
  function fader(c) {
    const pct = () => Math.round(mix.get(c.id) * 100);
    const out = h("output.nr-faderval", { for: `nr-fader-${c.id}` }, `${pct()} %`);
    const input = h("input", {
      type: "range", id: `nr-fader-${c.id}`, min: "0", max: "100", step: "5", value: String(pct()),
      "aria-label": `${c.label} volume`, title: c.hint || "",
      oninput: (e) => { mix.set({ [c.id]: Number(e.target.value) / 100 }); out.textContent = `${pct()} %`; },
    });
    return h(`div.nr-fader.${c.id}`, null, h("label", { for: `nr-fader-${c.id}` }, c.label), input, out);
  }

  /** Under the mouse choice: what it does, and whether this window allowed the capture. */
  function mouseLine() {
    if (current.mouse === "free") {
      return document.body.dataset.lock === "denied"
        ? "This window refused to capture the mouse, so cursor aim is standing in. In the Rexclaw desktop app this needs the app's pointer-lock permission; a browser tab allows it."
        : "Click the sea to capture the mouse; moving it swings the camera. Esc lets go.";
    }
    return "The camera looks where the cursor is: middle = ahead, left half = port, right half = starboard, the far edges = astern. Higher on screen aims farther.";
  }

  function render() {
    const raid = underway();
    const title = h("h2.gilt#nr-settings-title", null, raid ? "Heave to" : "Settings");
    const body = [];
    if (raid && confirming) {
      body.push(h("div.nr-confirm", null,
        h("p", null, "Abandon this mission? Nothing from it is logged."),
        h("div.nr-row", null,
          h("button.nr-btn.nr-danger", { type: "button", onclick: abandon }, "Abandon the mission"),
          h("button.nr-btn", { type: "button", onclick: () => { confirming = false; render(); } }, "Keep sailing"))));
    } else if (raid) {
      body.push(h("p.nr-muted", null, `The bay holds still while this is open. ${nameOf(ctx)} keeps the crew at their posts.`),
        h("div.nr-row", null,
          h("button.nr-btn.nr-primary", { type: "button", onclick: () => close() }, "Resume"),
          h("button.nr-btn", { type: "button", onclick: restart, title: "Start this mission again from the pier" }, "Restart"),
          h("button.nr-btn", { type: "button", onclick: () => { confirming = true; render(); } }, "Abandon…")));
    }
    body.push(
      h("section.nr-group", null,
        h("h3", null, "Companion"),
        seg("companion", COMPANION_CHOICES, `${nameOf(ctx)} off a call`),
        h("p.nr-fine", { "aria-live": "polite" }, companionLine(current.companion, nameOf(ctx)))),
      h("section.nr-group.nr-sound", { "aria-labelledby": "nr-sound-title" },
        h("h3#nr-sound-title", null, h("span.ic", { html: SPEAKER }), "Sound"),
        CHANNELS.map((c) => fader(c)),
        h("p.nr-fine", null, `Music and Effects are the same sliders as Volume and Effects in the ⚙ menu (every game shares them). Voices covers the crew's barks and ${nameOf(ctx)}'s recorded lines; on a live call their voice plays in the Rexclaw app.`)),
      h("section.nr-group", null,
        h("h3", null, "Mouse"),
        seg("mouse", [["cursor", "Cursor aim"], ["free", "Free look"]], "How the mouse looks round the ship"),
        h("p.nr-fine", { "aria-live": "polite" }, mouseLine()),
        h("label.nr-toggle", null,
          h("input", { type: "checkbox", checked: current.invertLook, onchange: (e) => set({ invertLook: e.target.checked }) }),
          h("span", null, "Invert up and down"))),
      h("section.nr-group", null,
        h("h3", null, "Graphics"),
        seg("graphics", TIERS, "Quality"),
        h("p.nr-fine", { "aria-live": "polite" }, tierLine()),
        seg("motion", [["full", "Full"], ["reduced", "Reduced"]], "Motion"),
        h("p.nr-fine", null, "Reduced calms the camera shake, the roll and the hit flashes."),
        seg("avatar", [["3d", "3D"], ["portrait", "Portrait"]], `${nameOf(ctx)} on deck`),
        h("label.nr-toggle", null,
          h("input", { type: "checkbox", checked: current.cinematics, onchange: (e) => set({ cinematics: e.target.checked }) }),
          h("span", null, "Broadside cinematics (a side-on shot of big volleys)")),
        h("label.nr-toggle", null,
          h("input", { type: "checkbox", checked: current.showFps, onchange: (e) => set({ showFps: e.target.checked }) }),
          h("span", null, "Show frame rate"))),
      h("details.nr-group.nr-keys", null,
        h("summary", null, "Keyboard"),
        h("dl", null, KEYS(nameOf(ctx)).map(([k, what]) => key(k, what))),
        h("p.nr-fine", null, `You aim and fire; ${nameOf(ctx)} runs the crew on your word, calls headings in the dark and marks the dangers. The track and crew cameos live under the ⚙ at the top right.`)),
    );
    fill(root, h("div.nr-sheet.nr-parchment", null,
      h("button.nr-close", { type: "button", "aria-label": "Close", onclick: () => close() }, "×"),
      title, ...body));
  }

  function key(k, what) {
    return [h("dt", null, h("kbd", null, k)), h("dd", null, what)];
  }

  function restart() {
    confirming = false;
    close({ resume: false });
    ctx.bus.intent("again", { same: true });
  }

  function abandon() {
    confirming = false;
    close({ resume: false });
    ctx.bus.intent("quit");
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") trapFocus(e);
  }

  function trapFocus(e) {
    const items = [...root.querySelectorAll("button, input, summary, select")].filter((el) => !el.disabled && el.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open() {
    if (!root.hidden) return;
    confirming = false;
    lastFocus = document.activeElement;
    if (underway()) { paused = true; ctx.bus.intent("pause", { on: true }); }
    render();
    root.hidden = false;
    document.body.classList.add("nr-modal-open");
    root.classList.remove("closing");
    document.addEventListener("keydown", onKey, true);
    root.querySelector(".nr-primary, .nr-seg button.on")?.focus({ preventScroll: true });
  }

  function close({ resume = true } = {}) {
    if (root.hidden) return;
    document.removeEventListener("keydown", onKey, true);
    root.hidden = true;
    document.body.classList.remove("nr-modal-open");
    if (paused) { paused = false; if (resume) ctx.bus.intent("resume"); }
    if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }

  return {
    open, close,
    toggle: () => (root.hidden ? open() : close()),
    isOpen: () => !root.hidden,
    current: () => ({ ...current }),
    /** Change and save choices from elsewhere (the title's off-call toggle). */
    set,
  };
}
