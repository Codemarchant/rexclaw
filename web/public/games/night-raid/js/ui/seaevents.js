// Random sea events on the glass (v4 §3): a small chip per event under the
// mission strip, from `state.events[]` (core v4) and the `sea_event` events.
//
//   telegraphed  "Waterspout forming · NE 340 m · in 8 s" (dashed, its colour)
//   under way    "Waterspout · NE 340 m · 40 s left"; red and pulsing once
//                it's on us (the Rexmaw inside its radius); per kind: the
//                derelict's salvage, the Kraken arm's HP, the wave count
//   ended        the chip fades out
//
// The chart (chart.js) draws their icons and the compass tape their marks;
// the crew call them (audio/barks.js) and sfx.js telegraphs them.

import { h, fill, text, flag, show, num, replay, point8, bearingTo, dist as metres, SEA_EVENTS, seaKind, seaStage } from "./dom.js";

const MAX_CHIPS = 3;

/** A point's distance and compass word from the ship ("NE 40 m"), or "". */
const off = (ship, p) => (ship && p && Number.isFinite(p.x) && Number.isFinite(p.z) ? `${point8(bearingTo(ship.x, ship.z, p.x, p.z))} ${metres(Math.hypot(p.x - ship.x, p.z - ship.z))}` : "");
/**
 * The whacky ones' live lines: (row, ship, {where, left}) → {where, extra, danger (red), good (gilt)}.
 * Their own telegraphs (the landing spot, the flop, the pace) are what the Captain acts on.
 */
const WHACKY_LINE = {
  gerald: (r, ship, o) => {
    const ev = r.ev, ph = String(ev.phase || "");
    if ((ph === "rise" || ph === "air") && ev.land) {
      const d = ship ? Math.hypot(ev.land.x - ship.x, ev.land.z - ship.z) : NaN;
      const close = d <= num(ev.land.r, 12) + 18;
      return { where: `lands ${off(ship, ev.land)}`, extra: close ? `in ${Math.max(1, Math.ceil(num(ev.landIn, 0)))} s · turn away!` : `in ${Math.max(1, Math.ceil(num(ev.landIn, 0)))} s`, danger: close, good: false };
    }
    return { where: o.where, extra: "swimming off", danger: false, good: false };
  },
  sky_whale: (r, ship, o) => {
    const ev = r.ev;
    if (!ev.ring && Number.isFinite(Number(ev.flopIn))) return { where: `flops ${off(ship, ev.flop)}`, extra: `in ${Math.ceil(num(ev.flopIn))} s`, danger: false, good: false };
    if (ev.ring && ship && num(ev.ring.r) < Math.hypot(ship.x - ev.flop.x, ship.z - ev.flop.z) + 10) return { where: "ring wave coming", extra: "meet it bow or stern on", danger: true, good: false };
    return { where: o.where, extra: num(ev.afloat, 0) > 0 ? `${num(ev.afloat)} afloat · haul them in` : "", danger: false, good: true };
  },
  dolphins: (r, ship, o) => {
    const ev = r.ev;
    if (ev.boosted) return { where: "bow wave", extra: num(ev.boostLeft, 0) > 0 ? `+25 % speed · ${Math.ceil(num(ev.boostLeft))} s` : "", danger: false, good: true };
    if (!ev.joined) return { where: r.inside ? "alongside" : o.where, extra: "coming alongside", danger: false, good: true };
    return { where: r.inside ? "alongside" : o.where, extra: `keep pace ${Math.round(num(ev.pace, 0) * 100)} %`, danger: false, good: true };
  },
  flying_fish: (r, ship, o) => ({ where: o.where, extra: r.ev.caught ? "supper's aboard" : "steer into them", danger: false, good: true }),
  jellyfish: (r, ship, o) => ({ where: r.inside ? "stinging us!" : o.where, extra: r.inside ? `every 3 s` : "they sting hulls", danger: !!r.inside, good: false }),
  turtle: (r, ship, o) => {
    const ev = r.ev;
    if (ev.taken) return { where: o.where, extra: "chest taken", danger: false, good: true };
    return { where: o.where, extra: num(ev.grab, 0) > 0 ? `chest ${Math.round(num(ev.grab) * 100)} %` : "alongside, slowly, for the chest", danger: false, good: true };
  },
  admiral: (r, ship, o) => {
    const ev = r.ev;
    if (ev.targetName && ev.mode !== "inspect") return { where: `bombing ${ev.targetName}`, extra: `pass ${num(ev.passes, 0)}/3`, danger: false, good: true };
    if (ev.medal) return { where: o.where, extra: "inspection passed", danger: false, good: true };
    return { where: o.where, extra: "inspecting us", danger: false, good: true };
  },
};

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent  the top stack
 */
export function createSeaEvents(ctx, parent) {
  const { bus } = ctx;
  const box = h("div.nr-seaevents", { role: "status", "aria-live": "polite", "aria-label": "Sea events" });
  parent.append(box);
  const chips = new Map();     // event key → {el, label, where}
  const fresh = new Set();     // keys whose warning just came in (they kick once)

  const keyOf = (ev) => String(ev.id ?? `${seaKind(ev.kind)}@${Math.round(num(ev.x))},${Math.round(num(ev.z))}`);

  /** The events worth a chip: telegraphed or under way, nearest first. */
  function live(s) {
    const ship = s?.ship;
    const list = [];
    for (const ev of Array.isArray(s?.events) ? s.events : []) {
      if (!ev) continue;
      const stage = seaStage(ev);
      if (stage === "end") continue;
      const has = ship && Number.isFinite(ev.x) && Number.isFinite(ev.z);
      const d = has ? Math.hypot(ev.x - ship.x, ev.z - ship.z) : NaN;
      list.push({ ev, stage, kind: seaKind(ev.kind), d, brg: has ? bearingTo(ship.x, ship.z, ev.x, ev.z) : NaN, inside: has && d <= num(ev.r, 0) });
    }
    return list.sort((a, b) => (a.inside === b.inside ? num(a.d, 9e9) - num(b.d, 9e9) : a.inside ? -1 : 1)).slice(0, MAX_CHIPS);
  }

  function update(s) {
    const on = s && (s.phase === "sailing" || s.phase === "moored") && !s.boardfight;
    show(box, !!on);
    if (!on) return;
    const keep = new Set();
    for (const r of live(s)) {
      const key = keyOf(r.ev);
      keep.add(key);
      let c = chips.get(key);
      if (!c) {
        c = { el: h("div.nr-seaev", { dataset: { k: r.kind } }, h("i.nr-seadot"), h("b"), h("small")), stage: null };
        box.append(c.el);
        chips.set(key, c);
        replay(c.el, "in");
      }
      const info = SEA_EVENTS[r.kind] || { label: r.ev.label || r.kind, warn: r.ev.label || r.kind };
      const label = r.stage === "warn" ? info.warn || r.ev.label : r.ev.label || info.label;
      let where = !Number.isFinite(r.d) ? "" : !r.inside ? `${point8(r.brg)} ${metres(r.d)}`
        : r.stage === "warn" ? "here" : r.kind === "squall" || r.kind === "fog" ? "visibility down" : "on us!";
      const eta = num(r.ev.eta, NaN), left = num(r.ev.left, NaN);
      // What's worth a glance per kind (core v4 fields): the derelict's salvage, the arm's HP, the treasure's time.
      let extra = "", danger = false, good = r.kind === "treasure" || r.kind === "derelict";
      if (r.stage === "warn") extra = Number.isFinite(eta) && eta > 0 ? `in ${Math.ceil(eta)} s` : "";
      else if (r.kind === "derelict" && num(r.ev.salvage, 0) > 0) extra = `salvage ${Math.round(num(r.ev.salvage) * 100)} %`;
      else if (r.kind === "derelict") extra = "stop alongside to salvage";
      else if (r.kind === "kraken_arm" && Number.isFinite(Number(r.ev.hp))) extra = `${Math.max(0, Math.round(num(r.ev.hp)))} hp · shoot it off`;
      else if (r.kind === "waves" && Number.isFinite(Number(r.ev.n))) extra = `${Math.min(num(r.ev.done), num(r.ev.n))}/${num(r.ev.n)} · bow-on`;
      else if (r.kind in WHACKY_LINE) ({ where, extra, danger, good } = WHACKY_LINE[r.kind](r, s.ship, { where, left }));
      else if (Number.isFinite(left) && left > 0 && left < 600) extra = `${Math.ceil(left)} s left`;
      text(c.el.querySelector("b"), label);
      text(c.el.querySelector("small"), [where, extra].filter(Boolean).join(" · "));
      flag(c.el, "warn", r.stage === "warn");
      flag(c.el, "near", r.stage !== "warn" && (danger || (r.inside && !good && !(r.kind in WHACKY_LINE))));
      flag(c.el, "good", good);
      if (c.stage !== r.stage || fresh.has(key)) { fresh.delete(key); replay(c.el, "kick"); }
      c.stage = r.stage;
    }
    for (const [key, c] of chips) {
      if (keep.has(key)) continue;
      chips.delete(key);
      c.el.classList.add("out");
      setTimeout(() => c.el.remove(), 400);
    }
  }

  const offs = [
    bus.on("sea_event", (p = {}) => { if (p.stage === "warn" || p.stage === "start") fresh.add(keyOf(p)); }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { chips.clear(); fill(box); } }),
  ];
  return { el: box, update, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
