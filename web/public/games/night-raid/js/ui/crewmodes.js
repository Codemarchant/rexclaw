// Crew modes (v3 §B7): three big toggles at the bottom left of the helm strip
// (keys 1 / 2 / 3), and under them, always, one line of what the crew is
// doing right now.
//
//   Hold    the hands only reload what you fire (the default)
//   Attack  the gun crews fire whichever battery bears on the marked ship
//           (else the nearest enemy) on their own
//   Defend  the crew repair, pump and fight fires on their own
//
// The companion can switch modes too (their `crew_mode` tool); the line says
// who set it ("Attack · port guns on Wasp — Rex's call"). Orders the
// companion gives on top (a battery on a ship, repairs) show in the crew
// report; the line here is the core's `state.crewMode.doing`.

import { h, text, flag, replay, byName, ICONS } from "./dom.js";

/** The modes, their keys and what each means (core const CREW_MODE_INFO says the same). */
export const CREW_MODES = Object.freeze([
  { id: "hold", key: "1", label: "Hold", icon: "hand", line: "The crew only reload what you fire." },
  { id: "attack", key: "2", label: "Attack", icon: "cannon", line: "Gun crews fire the battery that bears on the marked (or nearest) enemy." },
  { id: "defend", key: "3", label: "Defend", icon: "hammer", line: "The crew repair, pump and fight fires on their own." },
]);

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent  the helm strip
 */
export function createCrewModes(ctx, parent) {
  const { bus } = ctx;
  const btns = {};
  const group = h("div.nr-crewmodes", { role: "radiogroup", "aria-label": "Crew mode (1 / 2 / 3)" });
  for (const m of CREW_MODES) {
    btns[m.id] = h("button.nr-cmode", {
      type: "button", role: "radio", "aria-checked": "false", dataset: { mode: m.id }, title: `${m.label} (${m.key}): ${m.line}`,
      onclick: () => { bus.intent("crew_mode", { mode: m.id }); picked(m.id); },
    }, h("kbd", null, m.key), h("span.ic", { html: ICONS[m.icon] }), h("b", null, m.label));
    group.append(btns[m.id]);
  }
  const doing = h("div.nr-crewdoing", { role: "status", "aria-live": "polite" });
  const el = h("div.nr-crewbox", null, h("small.nr-crewhead", null, "Crew"), group);
  parent.append(el);

  let mode = "hold", wanted = null, wantedAt = 0;

  /** Light the button at once (the tick confirms it a moment later). */
  function picked(id) {
    wanted = id; wantedAt = performance.now();
    paint(id);
    replay(btns[id], "sent");
  }

  function paint(id) {
    for (const m of CREW_MODES) {
      flag(btns[m.id], "on", m.id === id);
      btns[m.id].setAttribute("aria-checked", String(m.id === id));
    }
    el.dataset.mode = id;
  }

  function update(s) {
    const cm = s?.crewMode || null;
    const now = cm?.mode || "hold";
    if (wanted && now !== wanted && performance.now() - wantedAt < 800) return;   // the click is on its way
    wanted = null;
    if (now !== mode) { mode = now; paint(now); } else if (el.dataset.mode !== now) paint(now);
    const by = cm?.by && cm.by !== "captain" ? byName(ctx, cm.by) : null;
    const line = cm?.doing || `${CREW_MODES.find((m) => m.id === now)?.label || "Hold"} · ${now === "hold" ? "reloading only" : now === "attack" ? "guns on the nearest enemy" : "repairs and the pumps"}`;
    text(doing, by ? `${line} — ${by}'s call` : line);
    flag(doing, "busy", now !== "hold");
  }

  const offs = [
    bus.on("crew_mode", (p = {}) => {
      if (!p.mode || !btns[p.mode]) return;
      mode = p.mode; wanted = null; paint(p.mode);
      if (p.by && p.by !== "captain") replay(btns[p.mode], "sent");
    }),
  ];

  paint("hold");
  return { el, doing, update, picked, mode: () => mode, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
