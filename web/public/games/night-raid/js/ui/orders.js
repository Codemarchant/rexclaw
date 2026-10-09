// The crew report (v2 §4 order feed; v3 §C10 companion value): the left
// column. What the crew is doing, what it has done for you, and who asked.
//
//   tally     the crew's running totals this mission (`state.contrib`): damage
//             their guns dealt, hull repaired, water pumped out, reefs called,
//             hits a brace call saved you. Each number bumps when it grows.
//   jobs      standing orders (state.orders): "Leo · Port guns on the Sea Wren ·
//             fire as she bears", "Ara · Repairing the hull ▰▰▰▱▱", who gave it
//             (the companion's name or "you") and why.
//   ticker    the last few things that happened, newest first: the crew's
//             contributions ("+12 Leo's guns on the Wasp", "+8 hull · Ara"),
//             headings and dangers called, brace calls, mode changes, jobs
//             done, refusals. Each fades after a few seconds.
//   pops      every contribution also floats up off the ship it touched
//             ("+12 Leo's guns" over the target; "+8 hull Ara" off the Rexmaw).
//
// Read-only: the Captain runs the crew with the crew modes (crewmodes.js), a
// right-click mark, or by asking the companion.

import { h, fill, text, flag, prop, clamp, num, replay, byName, crewName, crewColor, ORDER_KIND, GUN_SIDES, ORDER_MODES, REPAIR_WHAT, AMMO, ICONS, reducedMotion, seaBand } from "./dom.js";

const PASS_MS = 6500;
const MAX_PASS = 4;
const KIND_ICON = { man_guns: "cannon", repair: "hammer", bail: "pump", heading: "compass", danger: "warning", brace_call: "warning", suggest: "flag", done: "star", stale: "flag", refused: "warning", spyglass: "spyglass",
  guns: "cannon", hull: "hammer", water: "pump", fire: "flame", leak: "drop", brace: "star", reef: "compass", crew_mode: "hand" };

/** The tally's counters: key in state.contrib, icon, label, format. */
const TALLY = [
  { key: "guns", icon: "cannon", label: "damage by the crew's guns", read: (c) => num(c?.guns?.damage) },
  { key: "hull", icon: "hammer", label: "hull repaired", read: (c) => num(c?.hullRepaired) },
  { key: "water", icon: "pump", label: "water pumped out", read: (c) => num(c?.waterBailed) },
  { key: "reefs", icon: "compass", label: "reefs and rocks called", read: (c) => num(c?.reefsCalled) },
  { key: "braces", icon: "star", label: "hits braced after a call", read: (c) => num(c?.bracesBeforeHits) },
];

/** One job in words. */
export function jobText(o = {}) {
  if (o.kind === "man_guns") {
    const side = GUN_SIDES[o.side] || "The guns";
    const tgt = o.targetName || (o.target === "nearest" || !o.target ? "the nearest ship" : o.target === "marked" ? "the marked ship" : o.target);
    const ammo = o.ammo && o.ammo !== "round" ? ` · ${AMMO[o.ammo]?.tag || o.ammo}` : "";
    return `${side} on ${tgt}${ammo}`;
  }
  if (o.kind === "repair") return `Repairing ${REPAIR_WHAT[o.what] || "her"}`;
  if (o.kind === "bail") return "Pumping her out";
  return o.text || ORDER_KIND[o.kind] || String(o.kind || "");
}

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent  the left column
 * @param {{root?: HTMLElement}} [opts]  `root` for the floating pops (the HUD)
 */
export function createOrders(ctx, parent, { root = null } = {}) {
  const { bus } = ctx;
  const tally = h("div.nr-tallybar", { "aria-label": "What the crew has done this mission" });
  const cells = {};
  for (const t of TALLY) {
    cells[t.key] = h(`span.nr-tcell.${t.key}`, { title: t.label }, h("span.ic", { html: ICONS[t.icon] }), h("b", null, "0"));
    tally.append(cells[t.key]);
  }
  const list = h("div.nr-jobs");
  const pass = h("div.nr-passing", { "aria-live": "polite" });
  const el = h("section.nr-orders", { role: "group", "aria-label": "Crew report" },
    h("div.nr-panelhead", null, h("b", null, "Crew report"), h("small.nr-ocount")), tally, list, pass);
  parent.append(el);
  const rows = new Map();
  const shown = {};

  function whoChips(who) {
    const ids = Array.isArray(who) ? who : who ? [who] : [];
    return ids.slice(0, 2).map((id) => h("i.nr-whochip", { style: `--c:${crewColor(id)}`, title: crewName(ctx, id) }, crewName(ctx, id)));
  }

  function rowFor(o) {
    let r = rows.get(o.id);
    if (r) return r;
    r = { el: h(`div.nr-job.${o.kind}`, { dataset: { id: o.id } }), sig: "" };
    rows.set(o.id, r);
    replay(r.el, "in");
    return r;
  }

  function update(s) {
    // The tally.
    const c = s?.contrib || null;
    let any = false;
    for (const t of TALLY) {
      const v = Math.round(t.read(c));
      if (v > 0) any = true;
      if (shown[t.key] !== v) {
        const up = v > (shown[t.key] ?? 0);
        shown[t.key] = v;
        text(cells[t.key].querySelector("b"), String(v));
        flag(cells[t.key], "on", v > 0);
        if (up && v > 0) replay(cells[t.key], "bump");
      }
    }
    flag(tally, "empty", !any);
    // Jobs.
    const jobs = Array.isArray(s?.orders) ? s.orders.filter((o) => o && o.status !== "done") : [];
    const keep = new Set();
    let i = 0;
    for (const o of jobs) {
      const id = o.id ?? `${o.kind}:${o.side || o.what || ""}`;
      o.id = id;
      keep.add(id);
      const r = rowFor(o);
      const by = o.by === "captain" ? "you" : byName(ctx, o.by || "companion");
      const mode = o.kind === "man_guns" ? ORDER_MODES[o.mode] || "" : "";
      const status = o.status && !["active", "working"].includes(o.status) ? String(o.status).replace(/_/g, " ") : "";
      const sig = [jobText(o), by, o.why, mode, status, (o.who || []).join(",")].join("|");
      if (sig !== r.sig) {
        r.sig = sig;
        fill(r.el,
          h("span.ic", { html: ICONS[KIND_ICON[o.kind]] || ICONS.flag }),
          h("div.nr-jobmain", null,
            h("div.nr-jobline", null, whoChips(o.who), h("span.nr-jobtext", null, jobText(o))),
            h("div.nr-jobsub", null, status ? h("i.nr-jstatus", { title: mode }, status) : mode ? h("i.nr-mode", null, mode) : null,
              h("small", null, status || mode ? `· ${by}` : by)),
            o.why ? h("em.nr-why", null, `“${o.why}”`) : null),
          o.kind === "repair" || o.kind === "bail" ? h("span.nr-jobbar", null, h("i")) : null);
      }
      flag(r.el, "captain", o.by === "captain");
      flag(r.el, "firing", !!o.firing || o.status === "firing");
      const bar = r.el.querySelector(".nr-jobbar");
      if (bar) prop(bar, "--p", clamp(num(o.progress, 0), 0, 1));
      if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] || null);
      i++;
    }
    for (const [id, r] of rows) if (!keep.has(id)) { r.el.classList.add("out"); setTimeout(() => r.el.remove(), 380); rows.delete(id); }
    text(el.querySelector(".nr-ocount"), jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "");
    flag(el, "quiet", !any && !jobs.length && !pass.children.length);
  }

  /** A ticker line: shown for a few seconds. */
  function passing(p = {}) {
    if (!p.kind) return;
    const by = p.by === "captain" ? "You" : p.by ? byName(ctx, p.by) : "";
    const line = p.text || ORDER_KIND[p.kind] || "";
    if (!line) return;
    const row = h(`div.nr-pass.${p.kind}`, null, h("span.ic", { html: ICONS[KIND_ICON[p.kind]] || ICONS.flag }),
      h("span", null, by ? h("b", null, `${by}: `) : null, line), p.why && p.why !== line ? h("em.nr-why", null, `“${p.why}”`) : null);
    pass.prepend(row);
    while (pass.children.length > MAX_PASS) pass.lastChild.remove();
    flag(el, "quiet", false);
    setTimeout(() => { row.classList.add("out"); setTimeout(() => row.remove(), 400); }, p.kind === "refused" ? PASS_MS + 2000 : PASS_MS);
  }

  /** A contribution floats up off the ship it touched. */
  function pop(p) {
    if (!root || !p.text) return;
    let at = null;
    try {
      const w = ctx.world;
      // The scene's anchor near what did it (the battery that fired, the damage station, the pumps, the reef).
      at = w?.popAnchor?.(p) || null;
      if (!at?.visible && p.kind === "guns" && p.target) at = w?.screenPos?.(p.target, { lift: 18 });
      if (!at?.visible) at = w?.screenPos?.("rexmaw", { lift: 10 });
    } catch { at = null; }
    if (!at?.visible) return;
    const n = h(`div.nr-cpop.${p.kind || "guns"}`, null, p.text);
    n.style.left = `${Math.round(at.x + (reducedMotion() ? 0 : (Math.random() - 0.5) * 40))}px`;
    // The batteries and damage stations sit on the deck, under the helm strip in the chase view: start above it.
    const band = seaBand();
    n.style.top = `${Math.round(clamp(at.y, band.top + 20, band.bottom - 14))}px`;
    root.append(n);
    setTimeout(() => n.remove(), 1900);
  }

  const offs = [
    bus.on("order", (p = {}) => {
      // Jobs show as rows from the state; everything else passes through.
      if (["man_guns", "repair", "bail"].includes(p.kind)) return;
      passing(p);
    }),
    bus.on("contrib", (p = {}) => {
      pop(p);
      const who = p.who || p.by;
      passing({ kind: p.kind || "guns", by: null, text: p.text || `${crewName(ctx, who)}: +${Math.round(num(p.amount))}` });
    }),
    bus.on("crew_mode", (p = {}) => {
      if (!p.mode) return;
      passing({ kind: "crew_mode", by: p.by === "captain" ? "captain" : p.by || null, text: p.text || `Crew to ${p.mode}` });
    }),
    bus.on("job", (p = {}) => {
      if (p.stage === "done") passing({ kind: "done", by: Array.isArray(p.who) ? p.who[0] : p.who || "crew", text: p.kind === "repair" ? "Repairs done." : p.kind === "bail" ? "She's pumped dry." : "Done." });
    }),
    bus.on("phase", (p = {}) => {
      if (p.phase === "briefing" || p.phase === "title") {
        pass.replaceChildren();
        for (const r of rows.values()) r.el.remove();
        rows.clear();
        for (const k of Object.keys(shown)) delete shown[k];
      }
    }),
  ];

  return { el, update, passing, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
