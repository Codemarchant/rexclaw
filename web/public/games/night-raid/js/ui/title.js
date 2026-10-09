// The title card (v2 spec §2): the gilt REXMAW RAIDS logotype over the live
// bay (or the cover art without WebGL), who's at the Captain's side, the
// kit's record line and its mode tabs — Day / Night / Free Roam — and under
// them that tab's mission cards (each with its medals won and best time);
// the chosen mission's briefing (objective, medal marks) and Set sail, with
// How to play, Settings and the "{Name} off a call: Help / Solo" toggle.
//
// The kit mounts its record line and mode tabs into #title-record and
// #title-modes before this module runs, so the card is rebuilt AROUND those
// nodes; they are moved, never recreated. The tab picks `ctx.game.mode`
// (day | night | free); the mission card picks the mission inside it
// (remembered per tab); Set sail sends `start {mission}`.
//
// Records are read forgivingly from the save (core/save.js owns its shape):
//   saved.missions[id] = { plays, done, bestTime, best: {time, hull, loot}, score }
//   saved.totals.{missions, done, gold, sunk, captured}

import { h, fill, flag, asset, soundButtons, nameOf, withName, store, clock, gold, num, MISSIONS, TABS, TAB_IDS, DEFAULT_TAB,
  MEDAL_CATS, MEDAL_TIERS, TIER_LABEL, ICONS, medalSvg } from "./dom.js";
import { openSettings, getSettings, COMPANION_CHOICES, companionLine } from "./settings.js";
import { createGuide } from "./guide.js";
import * as coreMissions from "../core/missions.js";

const PICK_KEY = "rx-rexmaw-raids-mission";

/**
 * Take over the title card in `ctx.dom.title`.
 * @param {object} ctx  the UI context
 * @returns {{el: HTMLElement, show: () => void, hide: () => void, refresh: () => void, mission: () => string}}
 */
export function createTitle(ctx) {
  const { bus } = ctx;
  const root = ctx.dom.title;
  const keep = (sel, fallbackTag) => root.querySelector(sel) || h(fallbackTag);
  const record = keep("#title-record", "div#title-record");
  const modes = keep("#title-modes", "div#title-modes");
  const status = keep("#title-status", "div#title-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  root.classList.add("nr-title");
  soundButtons(root);

  const logo = h("img.nr-logo", { src: asset("assets/img/logo.webp"), alt: "Rexmaw Raids", draggable: "false", decoding: "async" });
  const word = h("h1.gilt.nr-word", { hidden: true }, "Rexmaw Raids");
  logo.addEventListener("error", () => { logo.remove(); word.hidden = false; });
  const who = h("p.nr-who-line");
  const cards = h("div.nr-mcards", { role: "listbox", "aria-label": "Missions" });
  const detail = h("div.nr-mdetail", { "aria-live": "polite" });
  const start = h("button#title-start.nr-start", { type: "button" });
  const gear = h("button.nr-btn.nr-gear", { type: "button", "aria-label": "Settings", title: "Settings" }, "Settings");
  const howBtn = h("button.nr-btn.nr-how", { type: "button", title: "Controls, missions, the crew, boarding, and what to say to your companion" }, h("span.ic", { html: ICONS.map }), "How to play");
  const keyline = h("div.nr-keyline", null,
    h("span", null, h("kbd", null, "Mouse"), " look · guns follow"),
    h("span", null, h("kbd", null, "RMB"), "/", h("kbd", null, "Q"), " aim"),
    h("span", null, h("kbd", null, "Click"), " fire"),
    h("span", null, h("kbd", null, "A"), h("kbd", null, "D"), " steer"),
    h("span", null, h("kbd", null, "W"), h("kbd", null, "S"), " sails"),
    h("span", null, h("kbd", null, "1"), h("kbd", null, "2"), h("kbd", null, "3"), " crew"),
    h("span", null, h("kbd", null, "Space"), " brace"));
  const records = h("div.nr-records", { "aria-label": "Your records" });
  // Companion off a call: Help / Solo (the same choice as Settings → Companion).
  const offcallLabel = h("span.nr-offlabel", { id: "nr-title-offcall" });
  const offcallSeg = h("div.nr-offseg", { role: "radiogroup", "aria-labelledby": "nr-title-offcall" });
  const offcall = h("div.nr-offcall", null, offcallLabel, offcallSeg);

  const card = h("div.card.nr-title-card", null,
    h("div.nr-brand", null, logo, word),
    who,
    record,
    modes,
    cards,
    detail,
    h("div.row.nr-go", null, start, howBtn, gear),
    offcall,
    keyline,
    records,
    status);
  fill(root, h("div.nr-title-back", { "aria-hidden": "true" }), card);

  // ---- Choosing ----------------------------------------------------------------------

  const tab = () => {
    const m = ctx.game?.mode;
    return TAB_IDS.includes(m) ? m : DEFAULT_TAB;
  };
  const picks = () => store.get(PICK_KEY, {}) || {};
  function missionOf(t = tab()) {
    const list = TABS[t]?.missions || [];
    const p = picks()[t];
    return list.includes(p) ? p : list[0];
  }
  function choose(id) {
    const t = tab();
    store.set(PICK_KEY, { ...picks(), [t]: id });
    sig = "";
    refresh();
  }
  const guard = (b) => { b.disabled = true; setTimeout(() => { b.disabled = booting; }, 1200); };

  start.addEventListener("click", () => {
    if (booting) return;
    guard(start);
    const id = missionOf();
    bus.intent("start", { mission: id, mode: tab(), night: MISSIONS[id]?.time === "night" });
  });
  gear.addEventListener("click", () => openSettings(ctx));
  // How to play: glows until it has been opened once on this browser.
  const guide = createGuide(ctx);
  const HOW_KEY = "rx-rexmaw-raids-guide-seen";
  flag(howBtn, "fresh", !store.get(HOW_KEY, false));
  howBtn.addEventListener("click", () => { store.set(HOW_KEY, true); flag(howBtn, "fresh", false); guide.open(); });
  modes.addEventListener("click", () => setTimeout(() => { sig = ""; refresh(); }, 0));
  cards.addEventListener("keydown", (e) => {
    const list = TABS[tab()]?.missions || [];
    const i = list.indexOf(missionOf());
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { choose(list[(i + 1) % list.length]); e.preventDefault(); cards.querySelector(".on")?.focus(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { choose(list[(i - 1 + list.length) % list.length]); e.preventDefault(); cards.querySelector(".on")?.focus(); }
  });

  // ---- Rendering -------------------------------------------------------------------

  let sig = "";
  function refresh() {
    const saved = ctx.saved() || {};
    const t = tab(), id = missionOf(t);
    const s = [nameOf(ctx), t, id, JSON.stringify(saved.missions || null), JSON.stringify(saved.totals || null)].join("|");
    if (s === sig) return;
    sig = s;
    root.dataset.tab = t;
    fill(who, h("b.nr-who", { "data-companion": "" }, nameOf(ctx)), t === "night" ? " navigates: they call the headings and mark the reefs your chart can't see."
      : t === "free" ? " sails with you: plunder the open bay and bank it at home port."
        : " is your gunnery partner: give them a battery and a target.");
    const list = TABS[t]?.missions || [];
    fill(cards, list.map((mid) => missionCard(mid, saved.missions?.[mid], mid === id)));
    renderDetail(id, saved.missions?.[id]);
    const m = MISSIONS[id] || {};
    fill(start, h("span", null, "Set sail"), h("small", null, m.label || ""));
    renderOffcall();
    renderRecords(saved);
  }

  function medalsRow(best, { big = false } = {}) {
    return h(`span.nr-mmedals${big ? ".big" : ""}`, null, Object.keys(MEDAL_CATS).map((cat) => {
      const tier = best?.[cat] || null;
      return h("i.nr-mmedal", { html: medalSvg(tier), title: `${MEDAL_CATS[cat].label}: ${tier ? TIER_LABEL[tier] : "not yet"}` });
    }));
  }

  function missionCard(id, rec, on) {
    const m = MISSIONS[id] || { label: id };
    const night = m.time === "night";
    const b = h(`button.nr-mcard${on ? ".on" : ""}${rec?.done ? ".done" : ""}`, {
      type: "button", role: "option", "aria-selected": String(on), dataset: { id, time: m.time || "day" },
      onclick: () => choose(id), ondblclick: () => { choose(id); start.click(); },
    },
    h("span.nr-mcic", { html: night ? ICONS.moon : ICONS.sun }),
    h("span.nr-mctext", null, h("b", null, m.label?.replace(/^Legendary: /, "") || id),
      m.label?.startsWith("Legendary") ? h("i.nr-legend", null, "Legendary") : null,
      h("small", null, m.hint || "")),
    h("span.nr-mcside", null, medalsRow(rec?.best), rec?.bestTime ? h("small", null, `best ${clock(rec.bestTime)}`) : rec?.plays ? h("small", null, `${rec.plays} tr${rec.plays === 1 ? "y" : "ies"}`) : h("small.nr-new", null, "new")));
    return b;
  }

  function renderDetail(id, rec) {
    const m = MISSIONS[id];
    if (!m) { fill(detail); return; }
    const marks = m.medals || {};
    let info = null;
    try { info = coreMissions.missionInfo?.(id) || null; } catch { info = null; }
    const steps = Array.isArray(info?.steps) ? info.steps : [];
    fill(detail,
      h("p.nr-mobj", null, info?.summary || m.objective || ""),
      steps.length ? h("ol.nr-msteps", { "aria-label": "The steps" }, steps.map((st) => h("li", null, st.text || ""))) : null,
      h("div.nr-mmarks", null,
        Object.entries(MEDAL_CATS).map(([cat, def]) => {
          const tier = rec?.best?.[cat] || null;
          const v = Array.isArray(marks[cat]) ? marks[cat][0] : null;
          return h("span.nr-mmark", { title: v != null ? `Gold: ${def.better === "under" ? "under" : "at least"} ${def.unit(v)}` : "" },
            h("i", { html: medalSvg(tier) }), h("b", null, def.label),
            v != null ? h("small", null, `gold ${def.better === "under" ? "≤" : "≥"} ${def.unit(v)}`) : null);
        }),
        m.limit ? h("span.nr-mmark.limit", null, h("i", { html: ICONS.compass }), h("b", null, "Limit"), h("small", null, clock(m.limit))) : null));
  }

  function renderRecords(saved) {
    const totals = saved.totals || {};
    const done = Object.values(saved.missions || {}).filter((r) => r?.done).length;
    const medals = Object.values(saved.missions || {}).reduce((n, r) => n + MEDAL_TIERS.reduce((k, t) => k + Object.values(r?.best || {}).filter((x) => x === t).length, 0), 0);
    const cells = [];
    if (done) cells.push(h("span.nr-rec", null, h("b", null, String(done)), ` mission${done === 1 ? "" : "s"} done`));
    if (medals) cells.push(h("span.nr-rec", null, h("b", null, String(medals)), ` medal${medals === 1 ? "" : "s"}`));
    if (num(totals.gold)) cells.push(h("span.nr-rec", null, h("b", null, gold(totals.gold)), " gold taken"));
    if (num(totals.sunk) || num(totals.captured)) cells.push(h("span.nr-rec", null, h("b", null, String(num(totals.sunk))), " sunk · ", h("b", null, String(num(totals.captured))), " taken"));
    fill(records, cells.length ? cells : h("span.nr-muted", null, withName(ctx, "No missions logged yet. {Name} is waiting at the pier.")));
  }

  // ---- Status line (boot progress, then presence) ------------------------------------

  let booting = true;
  bus.on("boot", ({ stage, progress } = {}) => {
    booting = progress < 1;
    start.disabled = booting;
    if (booting && stage) status.textContent = stage;
    else statusLine();
    if (!booting) root.classList.toggle("nr-flat", !ctx.R);
  });

  function statusLine() {
    if (booting) return;
    const waiting = new URLSearchParams(location.search).get("offcall") === "wait";
    const solo = getSettings(ctx).current().companion === "solo";
    const onCall = !!ctx.state()?.onCall;
    status.textContent = solo && !onCall
      ? `Sailing solo: ${nameOf(ctx)} joins you when you start a call.`
      : waiting && !onCall
        ? `Start a call with ${nameOf(ctx)}, or sail solo: the crew modes (1 / 2 / 3) run the crew without them.`
        : "";
  }

  /** The off-call toggle under Set sail: the Settings choice, set from here too. */
  function renderOffcall() {
    const name = nameOf(ctx);
    const now = getSettings(ctx).current().companion;
    offcallLabel.textContent = `${name} off a call`;
    offcall.title = companionLine(now, name);
    fill(offcallSeg, COMPANION_CHOICES.map(([id, label]) => h(`button${now === id ? ".on" : ""}`, {
      type: "button", role: "radio", "aria-checked": String(now === id),
      onclick: () => { if (getSettings(ctx).current().companion !== id) getSettings(ctx).set({ companion: id }); },
    }, label)));
  }

  bus.on("settings", (s = {}) => { if (s.companion) { renderOffcall(); statusLine(); } });
  bus.on("state", () => { if (!root.hidden) { refresh(); statusLine(); } });
  bus.on("view", ({ name } = {}) => { if (name === "title") showCard(); });

  let poll = 0;
  function showCard() {
    sig = "";
    refresh();
    statusLine();
    clearInterval(poll);
    poll = setInterval(() => { if (root.hidden) clearInterval(poll); else refresh(); }, 1200);
    root.classList.remove("in"); void root.offsetWidth; root.classList.add("in");
    setTimeout(() => { if (!root.hidden && !document.activeElement?.closest?.(".rxk-floatbar, .rx-dock")) start.focus({ preventScroll: true }); }, 400);
  }

  showCard();

  return {
    el: root,
    show() { root.hidden = false; showCard(); },
    hide() { root.hidden = true; clearInterval(poll); },
    refresh() { sig = ""; refresh(); },
    mission: () => missionOf(),
  };
}
