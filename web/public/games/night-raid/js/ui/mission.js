// The mission on the glass (v3 §A4): the briefing card at the pier, and the
// stamp when it's won or lost. (The objective while she sails is objective.js.)
//
//   briefing  (phase `briefing`, `state.briefing` from the core) a parchment
//             card on the left that waits for the Captain: day/night and the
//             limit, the mission and tonight's variant, a one-paragraph
//             summary, YOUR ORDERS (the step chain, numbered), YOU LOSE IF
//             (every fail condition, in red), the bonus, the medal marks, the
//             shot in the locker, a tip, the companion's part, and the two
//             buttons: Set sail (Enter) and Back (Esc, to the mission list).
//             No timer: nothing happens until the Captain chooses.
//   stamp     (ending) "Mission complete" / "Mission failed" and why.

import { h, fill, show, replay, clock, crewName, crewColor, withName, MISSIONS, MISSION_LINES, MEDAL_CATS, MEDAL_TIERS, ICONS, medalSvg } from "./dom.js";

const REASONS = {
  objective: "The job's done.", sunk: "The Rexmaw went down.", time: "Time ran out.", escaped: "They got away.",
  retired: "Back in port.", home: "Home with the haul.", spotted: "The patrol raised the alarm.", lost: "The prize was lost.",
};

/**
 * @param {object} ctx  the UI context
 * @param {{briefing: HTMLElement, stamp: HTMLElement}} where
 */
export function createMission(ctx, where) {
  const { bus } = ctx;

  // ---- Briefing ------------------------------------------------------------------------------
  const brief = h("section.nr-briefing.nr-parchment", { hidden: true, role: "dialog", "aria-label": "Mission briefing" });
  where.briefing.append(brief);
  let briefKey = null;

  function medalTable(medals) {
    if (!medals) return null;
    return h("table.nr-medaltable", null,
      h("thead", null, h("tr", null, h("th"), MEDAL_TIERS.map((t) => h("th", { html: medalSvg(t), title: t })))),
      h("tbody", null, Object.entries(MEDAL_CATS).map(([cat, def]) => {
        const marks = medals[cat];
        if (!Array.isArray(marks)) return null;
        return h("tr", null, h("th", null, def.label), marks.map((v) => h("td", null, `${def.better === "under" ? "≤ " : "≥ "}${def.unit(v)}`)));
      })));
  }

  /** The briefing data: the core's `state.briefing`, else the mission table (v2). */
  function briefingOf(s) {
    const b = s?.briefing;
    const id = b?.mission || s?.mission?.id;
    const m = MISSIONS[id] || {};
    return {
      id, label: b?.label || s?.mission?.label || m.label || "The raid", time: b?.time || m.time || s?.mission?.time || "day",
      tab: b?.tab || m.tab, limit: b?.limit ?? m.limit, summary: b?.summary || m.objective || s?.mission?.objective || "",
      variant: b?.variant?.label || "", steps: Array.isArray(b?.steps) ? b.steps : (s?.mission?.objectives || []).filter((o) => !o.optional),
      fail: Array.isArray(b?.fail) ? b.fail : [], bonus: b?.bonus || null, medals: b?.medals || m.medals, tip: b?.tip || "",
      ammo: b?.ammo || m.ammo || {}, boarding: b?.boarding || "", crewModes: b?.crewModes || "",
    };
  }

  function renderBrief(s) {
    const B = briefingOf(s);
    const night = B.time === "night";
    const free = B.tab === "free";
    const [who, line] = MISSION_LINES[B.id] || [];
    const go = h("button.nr-btn.nr-primary.nr-setsail", { type: "button", onclick: () => bus.intent("start_voyage") }, "Set sail ", h("kbd", null, "Enter"));
    const back = h("button.nr-btn.nr-ghost.nr-briefback", { type: "button", onclick: () => bus.intent("back") }, "Back ", h("kbd", null, "Esc"));
    fill(brief,
      h("div.nr-briefkick", null, h("span.ic", { html: night ? ICONS.moon : ICONS.sun }), free ? "Free roam" : night ? "Night mission" : "Day mission",
        B.limit ? h("small", null, ` · ${clock(B.limit)} on the clock`) : null),
      h("h2.nr-brieftitle", null, B.label),
      B.variant ? h("p.nr-briefvariant", null, B.variant) : null,
      B.summary ? h("p.nr-briefobj", null, B.summary) : null,
      B.steps.length ? h("div.nr-briefsec", null, h("small.nr-briefhead", null, "Your orders"),
        h("ol.nr-briefsteps", null, B.steps.map((st) => h("li", null, st.text || "")))) : null,
      B.fail.length ? h("div.nr-briefsec.fail", null, h("small.nr-briefhead", null, "You lose if"),
        h("ul.nr-brieffail", null, B.fail.map((f) => h("li", null, h("span.ic", { html: ICONS.warning }), f.text || "")))) : null,
      B.bonus ? h("p.nr-briefbonus", null, h("span.ic", { html: ICONS.star }), h("b", null, "Bonus: "), B.bonus.text || "", B.bonus.reward ? h("em", null, ` (${B.bonus.reward})`) : null) : null,
      h("div.nr-briefrow", null,
        medalTable(B.medals),
        h("div.nr-loadout", null, h("small", null, "In the locker"),
          h("span", null, h("span.ic", { html: ICONS.cannon }), "Round & heavy ∞"),
          B.ammo.chain ? h("span", null, h("span.ic", { html: ICONS.chain }), `Chain ${B.ammo.chain}`) : null,
          B.ammo.mortar ? h("span", null, h("span.ic", { html: ICONS.mortar }), `Mortar ${B.ammo.mortar}`) : null,
          B.ammo.barrels ? h("span", null, h("span.ic", { html: ICONS.barrel }), `Barrels ${B.ammo.barrels}`) : null)),
      B.tip ? h("p.nr-brieftip", null, h("b", null, "Tip: "), B.tip) : null,
      who ? h("p.nr-briefline", { style: `--c:${crewColor(who)}` }, h("b", null, `${crewName(ctx, who)}:`), ` “${line}”`) : null,
      h("p.nr-briefmate", null, withName(ctx, night ? "{Name} navigates tonight: they call the headings and mark the reefs your chart can't show. Ask them anything."
        : "{Name} runs the crew on your word: a battery on a ship, repairs, the pumps, a look through the spyglass.")),
      h("div.nr-briefgo", null, go, back));
    setTimeout(() => { if (!brief.hidden && !document.activeElement?.closest?.(".rx-dock")) go.focus({ preventScroll: true }); }, 60);
  }

  // ---- Stamp ----------------------------------------------------------------------------------
  const stamp = h("div.nr-mstamp", { hidden: true, role: "status", "aria-live": "assertive" });
  where.stamp.append(stamp);

  function update(s) {
    if (!s) return;
    const phase = s.phase;
    const briefing = phase === "briefing" || (phase === "moored" && s.mission?.status === "briefing");
    if (briefing) {
      const key = `${s.briefing?.mission || s.mission?.id}|${s.briefing?.seed ?? s.seed}|${s.briefing?.variant?.id || ""}`;
      if (brief.hidden || briefKey !== key) { briefKey = key; renderBrief(s); show(brief, true); replay(brief, "in"); }
    } else if (!brief.hidden) show(brief, false);
    if (phase !== "ending" && !stamp.hidden && phase !== "results") show(stamp, false);
  }

  function showStamp({ stage, reason, text } = {}) {
    const win = stage === "success";
    fill(stamp, h("b.gilt", null, win ? "Mission complete" : "Mission failed"), h("small", null, text || REASONS[reason] || ""));
    stamp.className = `nr-mstamp ${win ? "win" : "lose"}`;
    show(stamp, true);
    replay(stamp, "in");
  }

  // A failed mission's stamp says exactly why (the core's `objective {stage:"fail", text}` comes first).
  let stampWhy = "";
  const offs = [
    bus.on("objective", (p = {}) => { if (p.stage === "fail" && !p.bonus && p.text) stampWhy = p.text; }),
    bus.on("mission", (p = {}) => { if (p.stage === "success" || p.stage === "fail") showStamp(p.stage === "fail" && stampWhy ? { ...p, text: stampWhy } : p); }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { show(stamp, false); briefKey = null; stampWhy = ""; } }),
  ];

  return { update, brief, stamp, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
