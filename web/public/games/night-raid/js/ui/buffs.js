// Power-ups on the glass (v4.2): the buffs on the Rexmaw as small chips just above the helm strip — the kind's icon
// in its colour, a clock ring draining with the time left (Hot Shot: the volleys left), blinking through the last
// 4 s — and a short card over them when one's taken ("Swift Wind · +30 % speed · 20 s"). From `state.buffs[]` and
// the run's `powerup` events. The chart (chart.js) draws the ones afloat; the scene, their beams.

import { h, fill, text, flag, show, num, replay, prop, POWERUPS } from "./dom.js";

const CARD_MS = 2600;

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent  the bottom stack (the chips sit just above the helm strip)
 */
export function createBuffs(ctx, parent) {
  const { bus } = ctx;
  const box = h("div.nr-buffs", { hidden: true });
  const card = h("div.nr-pwcard", { hidden: true, role: "status", "aria-live": "polite" });
  const row = h("div.nr-buffrow", { role: "list", "aria-label": "Power-ups on us" });
  box.append(card, row);
  parent.append(box);
  const chips = new Map();   // buff id → {el, kind}
  let cardT = 0;

  function chip(b) {
    const P = POWERUPS[b.kind] || { label: b.label || b.kind, color: "#ffffff", icon: "" };
    const el = h("div.nr-buff", { role: "listitem", title: `${P.label}: ${P.short || ""}`, dataset: { k: b.kind } },
      h("i.nr-buffic", { html: P.icon }), h("b"));
    prop(el, "--c", P.color);
    row.append(el);
    replay(el, "in");
    return { el, kind: b.kind };
  }

  function update(s) {
    const on = !!s && (s.phase === "sailing" || s.phase === "moored") && !s.boardfight;
    const list = on && Array.isArray(s.buffs) ? s.buffs.filter((b) => b && POWERUPS[b.kind]) : [];
    const keep = new Set();
    for (const b of list) {
      keep.add(b.id);
      let c = chips.get(b.id);
      if (!c) { c = chip(b); chips.set(b.id, c); }
      const t = Math.max(0, num(b.t)), dur = Math.max(1, num(b.dur, 1));
      prop(c.el, "--k", Math.min(1, t / dur).toFixed(3));
      text(c.el.querySelector("b"), b.kind === "hot_shot" && num(b.charges) > 0 ? `×${num(b.charges)}` : `${Math.ceil(t)}s`);
      flag(c.el, "low", t < 4);
    }
    for (const [id, c] of chips) {
      if (keep.has(id)) continue;
      chips.delete(id);
      c.el.classList.add("out");
      setTimeout(() => c.el.remove(), 380);
    }
    show(box, on && (chips.size > 0 || !card.hidden));
  }

  function taken(p) {
    const P = POWERUPS[p.kind];
    if (!P) return;
    fill(card, h("i.nr-buffic", { html: P.icon }), h("b", null, P.label), h("small", null, [P.short, num(p.dur) > 0 ? `${Math.round(num(p.dur))} s` : ""].filter(Boolean).join(" · ")));
    prop(card, "--c", P.color);
    show(card, true); show(box, true);
    replay(card, "in");
    clearTimeout(cardT);
    cardT = setTimeout(() => { show(card, false); if (!chips.size) show(box, false); }, CARD_MS);
    for (const c of chips.values()) if (c.kind === p.kind) replay(c.el, "kick");
  }

  const offs = [
    bus.on("powerup", (p = {}) => { if (p.stage === "pickup") taken(p); }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { chips.clear(); fill(row); show(card, false); show(box, false); } }),
  ];
  return { el: box, update, dispose() { clearTimeout(cardT); offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
