// How to play (v3 §C11): the title's guide, a parchment sheet over the title
// (the "How to play" button beside Settings). Five short sections:
//
//   Controls          the key map (settings.js KEYS) and the two mouse modes
//   Missions          the step chain, the gilt markers, the fail counters, medals
//   Your crew         Hold / Attack / Defend, marking a target, what they report
//   Boarding          when B works and how the deck fight goes (v4)
//   Your companion    what to say or type, with example lines and what each does,
//                     and what they do on their own (brace calls, the dark)
//
// Esc or × closes it. It reads nothing from the run; the companion's name
// comes from the kit (ctx.name()).

import { h, fill, soundButtons, nameOf, ICONS } from "./dom.js";
import { KEYS } from "./settings.js";
import { CREW_MODES } from "./crewmodes.js";

/** Lines to say or type to the companion, and what each one gets you (v3 §C11). */
export const SAY_LINES = Object.freeze([
  ["Keep the port guns on that frigate", "a gun crew takes the port battery and fires every time she bears"],
  ["Chain shot on the runner", "the bow chasers load chain: masts and sails, so she slows"],
  ["Patch the hull", "Ara's party runs to the damage and hammers it shut (guns reload slower meanwhile)"],
  ["Bail her out", "Sal mans the pumps until the water's gone"],
  ["What's that ship?", "the spyglass on her: class, guns, cargo, her weak side"],
  ["Which way through the reef?", "a heading on your compass and the gaps in the reef band"],
  ["Mark the rocks", "a red danger area on your chart and a faint glow on the water"],
  ["Switch to defend", "the crew mode changes: repairs and pumps on their own"],
]);

/**
 * @param {object} ctx  the UI context
 * @returns {{open: () => void, close: () => void, isOpen: () => boolean}}
 */
export function createGuide(ctx) {
  const root = document.getElementById("guide") || (ctx.dom.overlay || document.body).appendChild(h("div#guide", { hidden: true }));
  root.classList.add("nr-modal", "nr-guide");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "nr-guide-title");
  soundButtons(root);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  let lastFocus = null;

  function section(id, icon, title, ...body) {
    return h(`section.nr-gsec.${id}`, null, h("h3", null, h("span.ic", { html: ICONS[icon] }), title), ...body);
  }

  function render() {
    const name = nameOf(ctx);
    fill(root, h("div.nr-sheet.nr-guide-sheet.nr-parchment", null,
      h("button.nr-close", { type: "button", "aria-label": "Close", onclick: () => close() }, "×"),
      h("h2.gilt#nr-guide-title", null, "How to play"),
      h("p.nr-glead", null, `You captain the Rexmaw: you steer, aim and fire. ${name} is your first mate: they run the crew on your word, read ships through the spyglass and, in the dark, navigate.`),
      h("div.nr-gcols", null,
        h("div.nr-gcol", null,
          section("missions", "flag", "Missions",
            h("ul", null,
              h("li", null, h("b", null, "Read the briefing. "), "Every mission is 2–4 steps, and the card lists every way to lose. Nothing starts until you Set sail."),
              h("li", null, h("b", null, "Follow the gilt. "), "The banner up top is your step; a gilt pillar or chevron marks it at sea, an arrow at the screen's edge points to it, and a flag sits on the compass."),
              h("li", null, h("b", null, "Watch the counters. "), "Under the banner, each way to lose counts down (\"Spotted 1/3\"). Amber at half way, red near the end, and the crew shouts."),
              h("li", null, h("b", null, "Medals "), "for time, hull left and loot. Each night is different: the prize, the cape and the escorts change."))),
          section("crew", "hand", "Your crew",
            h("ul.nr-gmodes", null, CREW_MODES.map((m) => h("li", null, h("kbd", null, m.key), h("b", null, m.label), m.line))),
            h("p", null, h("b", null, "Right-click a ship "), "(or ", h("kbd", null, "Tab"), ") to lock her as THE target: your arcs snap to her, and the gun crews and ", name, " work on her. ", h("kbd", null, "Esc"), " or a right-click on open sea lets go. The crew report (top left) counts what they've done for you, and \"+12 Leo's guns\" floats off the ship they hit.")),
          section("boarding", "swivel", "Boarding",
            h("p", null, h("b", null, "Disable a ship "), "(hull ≤ 25 %, or chain her masts down, or make her strike) and sail into the ring round her. A small ", h("kbd", null, "B"), " chip shows under her tag: press B once and the grapples fly."),
            h("ol", null,
              h("li", null, "Your crew swing across and fight on their own. Click an enemy to fire your pistol (1.2 s reload); ", h("kbd", null, "F"), " rallies the crew once: a heal and a burst."),
              h("li", null, `Their captain comes on deck once half the crew is down (on big ships, from the start). Down the captain and she strikes: the loot and her ammunition are yours. ${name} can call the crew's focus: the captain, the crew, or hold.`)))),
        h("div.nr-gcol", null,
          section("companion", "spyglass", `Playing with ${name}`,
            h("p", null, "Say it on a call or type it in the chat at the bottom. Plain words work; these are a good start:"),
            h("ul.nr-gsay", null, SAY_LINES.map(([line, what]) => h("li", null, h("q", null, line), h("span", null, what)))),
            h("p", null, h("b", null, "On their own "), `${name} calls BRACE when a broadside is coming (press Space just before it lands), and at night or in fog they call headings and paint the hidden reefs red on your chart. Now and then they suggest a target or a route: `, h("kbd", null, "Y"), " takes it, ", h("kbd", null, "N"), " waves it off."),
            h("p", null, h("b", null, "Rather sail alone? "), `Pick Solo under Set sail (or in Settings → Companion): off a call ${name} sits out, with no reports and no turns, and the crew modes run the crew. On a call they're back.`)),
          section("controls", "compass", "Controls",
            h("dl.nr-gkeys", null, KEYS(name).map(([k, what]) => [h("dt", null, h("kbd", null, k)), h("dd", null, what)])),
            h("p.nr-fine", null, "Mouse: cursor aim by default (no click needed). Prefer a captured mouse? Settings → Mouse → Free look."))))));
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  }

  function open() {
    if (!root.hidden) return;
    lastFocus = document.activeElement;
    render();
    root.hidden = false;
    document.body.classList.add("nr-modal-open");
    document.addEventListener("keydown", onKey, true);
    root.querySelector(".nr-close")?.focus({ preventScroll: true });
  }

  function close() {
    if (root.hidden) return;
    document.removeEventListener("keydown", onKey, true);
    root.hidden = true;
    document.body.classList.remove("nr-modal-open");
    if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }

  ctx.bus.on("view", ({ name } = {}) => { if (name !== "title") close(); });
  return { open, close, isOpen: () => !root.hidden };
}
