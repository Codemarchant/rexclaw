// The end of a mission (v2 spec §2): the SHIP'S LOG and the medals.
//
// Left, on parchment: the bay chart with the Rexmaw's track inking itself in
// (every reef revealed now it's over), and under it the ship's log, every
// order with who gave it and why ("02:14 · Eve: port guns on the Sea Wren,
// fire as she bears · “she's the slow one”"), the Captain's own, and the big
// moments.
// Right: the stamp (Mission complete / Mission failed, and exactly why, with
// what to try next time: results.failure), the three medals — time, hull,
// loot — each with what you did against its marks, YOUR CREW (what the crew
// and the companion did for you: results.crew, and the companion's best
// moment), the steps ticked or struck, ships sunk and taken, the loot counting up,
// the score rows (a `tally` bus event per step for the score's music), the
// stars, and the ways on: Try again, Next mission, Back to port.
//
// results.show(run.results() + {world, best, newMedals}) resolves with the
// Captain's choice ("again" | "next" | "title" | "close"); the intents go out
// on the bus too (`again {same:false}`, `start {mission}`, `quit`).

import { h, fill, countUp, replay, reducedMotion, soundButtons, nameOf, byName, crewName, CLASSES, clock, clamp, gold, num,
  MISSIONS, MISSION_ORDER, MEDAL_CATS, MEDAL_TIERS, TIER_LABEL, ICONS, medalSvg } from "./dom.js";
import { drawBay } from "./chart.js";

const WHY = {
  objective: "The job's done.", sunk: "The Rexmaw went down. Everyone's in the jolly boat.", time: "Time ran out.",
  escaped: "They got away.", retired: "Back in port with the haul.", home: "Home with the haul.",
  spotted: "The patrol raised the alarm.", lost: "The prize was lost.",
};

/**
 * Build the results card into `ctx.dom.results`.
 * @param {object} ctx  the UI context
 */
export function createResults(ctx) {
  const { bus } = ctx;
  const root = ctx.dom.results;
  root.classList.add("nr-modal", "nr-results");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "nr-results-title");
  soundButtons(root);

  let resolveOpen = null, anim = 0, hideT = 0;
  bus.on("view", ({ name } = {}) => { if (name !== "result" && !root.hidden) finish("close"); });

  function finish(action) {
    if (root.hidden) return;
    cancelAnimationFrame(anim);
    document.removeEventListener("keydown", onKey, true);
    root.classList.add("closing");
    clearTimeout(hideT);
    hideT = setTimeout(() => { root.hidden = true; root.classList.remove("closing"); }, reducedMotion() ? 0 : 260);
    const r = resolveOpen;
    resolveOpen = null;
    r?.(action);
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish("close"); }
  }

  /** One ship's-log line. */
  function logRow(e) {
    const who = e.by || e.who;
    const kind = e.kind || "event";
    return h(`li.nr-logrow.${kind}${who === "captain" ? ".captain" : ""}`, null,
      h("time", null, Number.isFinite(e.t) ? clock(e.t) : ""),
      h("span.nr-logtext", null, who && kind !== "event" ? h("b", null, `${byName(ctx, who)}: `) : null, e.text || ""),
      e.why ? h("em", null, `“${e.why}”`) : null);
  }

  function shipList(list) {
    return list.map((x) => h("span.nr-shipchip", { dataset: { cls: x.cls || "" } }, h("i", null, CLASSES[x.cls]?.glyph || "?"), x.name || CLASSES[x.cls]?.name || "a ship"));
  }

  /**
   * "Your crew" (v3 §C10): what the crew and the companion did for you this mission (`results.crew`, the
   * core's contribution totals), and the companion's best moment. Only the rows that happened.
   */
  function crewPanel(c) {
    if (!c || typeof c !== "object") return null;
    const by = c.guns?.by || {};
    const gunners = Object.entries(by).filter(([, v]) => num(v) > 0).sort((x, y) => num(y[1]) - num(x[1]))
      .map(([who, v]) => `${crewName(ctx, who)} ${Math.round(num(v))}`).join(" · ");
    const rows = [
      ["cannon", "Damage by their guns", num(c.guns?.damage), gunners || (num(c.guns?.hits) ? `${num(c.guns.hits)} hits` : "")],
      ["flag", "Ships they finished", num(c.guns?.sunk), ""],
      ["hammer", "Hull repaired", num(c.hullRepaired), [num(c.firesOut) ? `${num(c.firesOut)} fires out` : "", num(c.leaksPatched) ? `${num(c.leaksPatched)} leaks patched` : ""].filter(Boolean).join(" · ")],
      ["pump", "Water pumped out", num(c.waterBailed), ""],
      ["compass", "Reefs and rocks called", num(c.reefsCalled), num(c.headingCalls) ? `${num(c.headingCalls)} headings` : ""],
      ["star", "Hits braced after a call", num(c.bracesBeforeHits), num(c.damageSaved) ? `${Math.round(num(c.damageSaved))} hull saved` : ""],
    ].filter(([, , v]) => v > 0);
    const best = c.best?.text ? c.best : null;
    if (!rows.length && !best) return h("section.nr-crewpanel.quiet", null, h("small.nr-sectionlabel", null, "Your crew"),
      h("p.nr-crewnone", null, `A quiet one for the crew. Next time, try Attack (2) or ask ${nameOf(ctx)} for a battery.`));
    return h("section.nr-crewpanel", null,
      h("small.nr-sectionlabel", null, "Your crew"),
      h("div.nr-crewrows", null, rows.map(([icon, label, v, sub]) => h("div.nr-crewrow", null,
        h("span.ic", { html: ICONS[icon] }), h("span.nr-crl", null, label, sub ? h("small", null, sub) : null), h("b", null, gold(v))))),
      best ? h("p.nr-bestmoment", null, h("span.ic", { html: ICONS.star }), h("b", null, `${nameOf(ctx)}'s best moment: `), best.text,
        Number.isFinite(best.t) ? h("time", null, ` · ${clock(best.t)}`) : null) : null);
  }

  /** What you did in a medal's category, in its units. */
  function achieved(cat, a) {
    if (cat === "time") return Number.isFinite(a.elapsed) ? clock(a.elapsed) : "—";
    if (cat === "hull") return `${Math.round(num(a.hull))} %`;
    return gold(num(a.loot ?? a.banked));
  }

  /** The mission's card. Takes the core's results object as it is. */
  function show(a = {}) {
    if (resolveOpen) finish("close");
    // A card closed moments ago must not hide this one when its fade-out timer lands.
    clearTimeout(hideT);
    root.classList.remove("closing");
    const m = MISSIONS[a.mission] || {};
    const win = a.outcome === "success" || a.outcome === "win";
    const free = !!m.free;
    const stampText = free ? (win ? "Home with the haul" : "Lost at sea") : win ? "Mission complete" : "Mission failed";
    const core = a.score && typeof a.score === "object" ? a.score : null;
    const score = Math.max(0, Math.round(num(core ? core.total : a.score)));
    const starsN = clamp(Math.round(num(core?.stars ?? a.stars)), 0, 3);
    const loot = Math.round(num(free ? a.banked : a.loot));
    const lost = Math.round(num(a.lostPlunder));
    const sunk = Array.isArray(a.sunk) ? a.sunk : [];
    const captured = Array.isArray(a.captured) ? a.captured : [];
    const log = Array.isArray(a.log) ? a.log : [];
    const objectives = Array.isArray(a.steps) && a.steps.length
      ? [...a.steps, ...(a.bonus ? [{ ...a.bonus, text: `Bonus: ${a.bonus.text || ""}`, failed: !a.bonus.done }] : [])]
      : Array.isArray(a.objectives) ? a.objectives : [];
    const medals = a.medals && typeof a.medals === "object" ? a.medals : {};
    const fresh = new Set((a.newMedals || []).map((x) => `${x.cat}:${x.tier}`));
    const rows = core && Array.isArray(core.lines) ? core.lines.filter((l) => Math.round(num(l.points)) !== 0 || num(l.count) > 0)
      .map((l) => ({ key: l.key, label: l.label || l.key, pts: Math.round(num(l.points)), detail: Number.isFinite(l.count) ? String(l.count) : "" })) : [];
    const doubloons = core?.doubloons ?? a.doubloons ?? null;
    const idx = MISSION_ORDER.indexOf(a.mission);
    const next = win && idx >= 0 && idx < MISSION_ORDER.length - 1 ? MISSION_ORDER[idx + 1] : null;

    // Left: chart + log.
    const canvas = h("canvas.nr-rchart", { role: "img", "aria-label": "The Rexmaw's track across the bay" });
    const orders = a.orders || {};
    const logList = h("ol.nr-log", null, log.length ? log.map(logRow) : h("li.nr-logrow.empty", null, "A quiet run. Nothing in the log."));
    const left = h("div.nr-logcol.nr-parchment", null,
      h("div.nr-rchartbox", null, canvas),
      h("div.nr-loghead", null, h("b", null, "Ship's log"),
        h("small", null, [Number.isFinite(orders.companion) ? `${orders.companion} order${orders.companion === 1 ? "" : "s"} from ${nameOf(ctx)}` : "", Number.isFinite(orders.captain) && orders.captain ? `${orders.captain} from you` : ""].filter(Boolean).join(" · "))),
      logList);

    // Right: the stamp, the medals, the tally.
    const total = h("b.nr-total", null, "0");
    const lootEl = h("b.nr-bankedbig", null, "0");
    const rowEls = rows.map((r) => h("div.nr-row-tally", { dataset: { key: r.key } }, h("span.nr-rl", null, r.label), h("span.nr-rd", null, r.detail), h("b.nr-rv", null, "")));
    const starRow = h("div.nr-stars", { "aria-label": `${starsN} of 3 stars` }, [0, 1, 2].map(() => h("i", { "aria-hidden": "true" }, "★")));
    const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long" });
    const medalEls = Object.entries(MEDAL_CATS).map(([cat, def]) => {
      const tier = medals[cat] || null;
      const marks = Array.isArray(m.medals?.[cat]) ? m.medals[cat] : [];
      return h(`div.nr-medalcard${tier ? `.${tier}` : ".none"}${fresh.has(`${cat}:${tier}`) ? ".fresh" : ""}`, { dataset: { cat } },
        h("i.nr-medalic", { html: medalSvg(tier) }),
        h("b", null, def.label),
        h("span.nr-medalval", null, achieved(cat, a)),
        h("small", null, tier ? TIER_LABEL[tier] : win ? "no medal" : "—"),
        marks.length ? h("small.nr-marks", null, MEDAL_TIERS.map((t, i) => `${t[0].toUpperCase()} ${def.better === "under" ? "≤" : "≥"}${def.unit(marks[i])}`).join(" · ")) : null);
    });
    const right = h("div.nr-tallycol", null,
      h("div.nr-kicker", null, h("span.ic", { html: m.time === "night" ? ICONS.moon : ICONS.sun }), [a.label || m.label || "", date].filter(Boolean).join(" · ")),
      h("h2.sr-only#nr-results-title", null, `${stampText}: ${score} points`),
      h("div.nr-stamp.gilt", { "aria-hidden": "true" }, stampText),
      h("p.nr-outline", null, (!win && a.failure?.text) || WHY[a.reason] || ""),
      !win && a.failure?.tip ? h("p.nr-tryline", null, h("b", null, "Next time: "), a.failure.tip) : null,
      a.variant?.label ? h("small.nr-variant", null, a.variant.label) : null,
      h("div.nr-medalrow", null, medalEls),
      crewPanel(a.crew),
      objectives.length ? h("ul.nr-objlist", null, objectives.map((o) => h(`li.${o.done ? "done" : o.failed ? "failed" : "open"}`, null,
        h("i.nr-check"), h("span", null, o.text), Number.isFinite(o.of) && o.of > 1 ? h("b", null, `${Math.min(num(o.count), o.of)}/${o.of}`) : null))) : null,
      h("div.nr-bankedrow", null, h("small", null, free ? "Plunder banked" : "Loot taken"), lootEl, lost ? h("small.nr-lost", null, `${gold(lost)} lost with the hold`) : null),
      sunk.length || captured.length ? h("div.nr-ships", null,
        sunk.length ? h("div", null, h("small.nr-sectionlabel", null, `Sunk · ${sunk.length}`), h("div.nr-shiplist", null, shipList(sunk))) : null,
        captured.length ? h("div", null, h("small.nr-sectionlabel", null, `Taken · ${captured.length}`), h("div.nr-shiplist", null, shipList(captured))) : null) : null,
      rows.length ? h("small.nr-sectionlabel", null, "The tally") : null,
      h("div.nr-tally", null, rowEls),
      h("div.nr-totalrow", null, h("span", null, "Score"), total),
      starRow,
      a.best ? h("div.nr-best", null, "A new best") : null,
      doubloons ? h("div.nr-doubloons", null, `+${doubloons} doubloons`) : null,
      a.quip ? h("p.nr-quip", null, a.quip) : null,
      h("div.nr-row.nr-ways", null,
        next ? h("button.nr-btn.nr-primary", { type: "button", onclick: () => { bus.intent("start", { mission: next, mode: MISSIONS[next]?.tab }); finish("next"); } }, "Next: ", MISSIONS[next]?.label?.replace(/^Legendary: /, "") || "mission") : null,
        h(`button.nr-btn${next ? "" : ".nr-primary"}`, { type: "button", onclick: () => { bus.intent("again", { same: false }); finish("again"); } }, win ? "Play again" : "Try again"),
        h("button.nr-btn.nr-ghost", { type: "button", onclick: () => { bus.intent("quit"); finish("title"); } }, "Back to port")));
    const card = h(`div.nr-sheet.nr-result-card.${win ? "arrived" : "lost"}`, null, left, right);
    fill(root, card);
    root.hidden = false;
    root.classList.remove("closing");
    replay(card, "in");
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => root.querySelector(".nr-primary")?.focus({ preventScroll: true }), 50);

    revealChart(canvas, { world: a.world || ctx.bayWorld?.() || null, track: a.track || ctx.hudWake?.() || [], state: null });
    setTimeout(() => sequence({ lootEl, loot, rows, rowEls, total, score, starRow, starsN, card, medalEls }), reducedMotion() ? 0 : 700);
    return new Promise((resolve) => { resolveOpen = resolve; });
  }

  async function revealChart(canvas, data) {
    await new Promise((r) => requestAnimationFrame(r));
    const box = canvas.parentElement;
    const r = box.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(r.width)), hh = Math.max(140, Math.round(r.height));
    canvas.width = w * dpr; canvas.height = hh * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${hh}px`;
    const g = canvas.getContext("2d");
    if (!g) return;
    const dur = reducedMotion() ? 0 : 3200;
    const t0 = performance.now();
    const step = (now) => {
      const k = dur ? clamp((now - t0) / dur, 0, 1) : 1;
      drawBay(g, data, { width: canvas.width, height: canvas.height, scale: dpr, big: true, reveal: 1 - (1 - k) ** 2, allReefs: true });
      if (k < 1 && !root.hidden) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  /** The medals land, the loot counts in, the rows count up, then the stars. */
  async function sequence({ lootEl, loot, rows, rowEls, total, score, starRow, starsN, card, medalEls }) {
    const fast = reducedMotion();
    let step = 0;
    for (const m of medalEls) {
      if (root.hidden) return;
      m.classList.add("on");
      const tier = MEDAL_TIERS.find((t) => m.classList.contains(t));
      bus.emit("tally", { step: step++, medal: tier || null });
      if (!fast) await wait(tier ? 360 : 160);
    }
    bus.emit("tally", { step: step++, banked: loot });
    await countUp(lootEl, loot, { ms: fast ? 0 : clamp(400 + loot / 4, 500, 1600), format: gold });
    let running = 0;
    for (let i = 0; i < rows.length; i++) {
      if (root.hidden) return;
      const r = rows[i], el = rowEls[i];
      el.classList.add("on");
      bus.emit("tally", { step: step++, row: r.key, points: r.pts });
      await countUp(el.querySelector(".nr-rv"), r.pts, { ms: fast ? 0 : Math.min(650, 200 + Math.abs(r.pts) / 4), format: (n) => (n > 0 ? `+${n}` : String(n)) });
      await countUp(total, running + r.pts, { from: running, ms: fast ? 0 : 240 });
      running += r.pts;
      if (!fast) await wait(100);
    }
    if (running !== score) await countUp(total, score, { from: running, ms: fast ? 0 : 400 });
    card.classList.add("stamped");
    bus.emit("tally", { step: step++, final: true, points: score, stars: starsN });
    const stars = [...starRow.children];
    for (let i = 0; i < starsN; i++) {
      if (root.hidden) return;
      if (!fast) await wait(320);
      stars[i].classList.add("on");
      bus.emit("tally", { step: step++, star: i + 1 });
    }
  }

  return { el: root, show, hide: () => finish("close"), isOpen: () => !root.hidden };
}
