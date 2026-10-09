// The Rexmaw's state, front and centre (v3 §C9): the top of the helm strip.
//
//   hull      one big bar (the number on it), red under 30 %; it flashes white
//             on every hit and a ghost bar shows the chunk that hit took
//   masts / water   slim bars under it (water fills blue, amber from 40 %, red
//             and pulsing from 70 %)
//   fire / leak     icons with their counts, lit only while there are any
//   hit side  a red arc round the strip's edge on the side the shot came from
//             (port, starboard, bow, stern) for a second and a half, and the
//             same side of the screen glows (the HUD's vignette)
//   low hull  under 30 % a red vignette breathes at the screen's edges (under
//             15 % faster); the loot and the hands sit at the bar's right end.
//
// Reads the tick (ship.hull/hullMax/masts/water/fires/leaks/crewHands, plunder)
// and the run's `impact {target:"rexmaw", x, z, dmg}` / `fire` / `leak` events.

import { h, fill, text, flag, prop, clamp, num, replay, angleDiff, bearingTo, gold, ICONS } from "./dom.js";

/**
 * @param {object} ctx  the UI context
 * @param {{parent: HTMLElement, root: HTMLElement}} where  `parent` the helm strip, `root` the HUD (for the low-hull vignette)
 */
export function createShipStatus(ctx, { parent, root }) {
  const { bus } = ctx;
  const hullFill = h("i.nr-hullfill"), hullGhost = h("i.nr-hullghost"), hullVal = h("b.nr-hullval");
  const hull = h("div.nr-hullbar", { role: "meter", "aria-label": "Hull", "aria-valuemin": "0", "aria-valuemax": "100" }, hullGhost, hullFill, h("span.nr-hulllabel", null, "Hull"), hullVal);
  const sub = (key, label) => { const f = h("i"), v = h("b"); return { row: h(`div.nr-subbar.${key}`, { title: label }, h("small", null, label), h("span", null, f), v), fill: f, val: v }; };
  const masts = sub("masts", "Masts"), water = sub("water", "Water");
  const fires = h("span.nr-dmgic.fire", { title: "Fires aboard" }), leaks = h("span.nr-dmgic.leak", { title: "Leaks below the waterline" });
  const loot = h("span.nr-lootmini", { title: "Loot this mission" }), hands = h("span.nr-handsmini", { title: "Hands aboard" });
  const hitArc = h("i.nr-hitarc", { "aria-hidden": "true" });
  const el = h("div.nr-shipstat", null,
    h("div.nr-hullrow", null, hull, fires, leaks),
    h("div.nr-subrow", null, masts.row, water.row, h("span.nr-statextra", null, hands, loot)),
    hitArc);
  parent.prepend(el);
  const lowVig = h("div.nr-lowhull", { "aria-hidden": "true" });
  root.prepend(lowVig);

  let lastHull = null, ghostT = 0, snap = null;

  function update(s) {
    snap = s;
    const ship = s?.ship || {};
    const max = Math.max(1, num(ship.hullMax, 100));
    const hp = clamp(num(ship.hull) / max, 0, 1);
    prop(hull, "--p", hp);
    text(hullVal, `${Math.round(num(ship.hull))}`);
    hull.setAttribute("aria-valuenow", String(Math.round(hp * 100)));
    flag(hull, "low", hp < 0.3);
    flag(hull, "crit", hp < 0.15);
    if (lastHull != null && num(ship.hull) < lastHull - 0.5) {
      prop(hull, "--g", clamp(lastHull / max, 0, 1));
      replay(hull, "hit");
      clearTimeout(ghostT);
      ghostT = setTimeout(() => prop(hull, "--g", hp), 700);
    } else if (lastHull == null || num(ship.hull) > lastHull) prop(hull, "--g", hp);
    lastHull = num(ship.hull);
    // Masts and water.
    const m = clamp(num(ship.masts) / 100, 0, 1), w = clamp(num(ship.water) / 100, 0, 1);
    prop(masts.row, "--p", m); text(masts.val, `${Math.round(m * 100)}`);
    flag(masts.row, "low", m < 0.5);
    prop(water.row, "--p", w); text(water.val, `${Math.round(w * 100)}`);
    flag(water.row, "warn", w >= 0.4 && w < 0.7);
    flag(water.row, "danger", w >= 0.7);
    // Fires and leaks.
    icon(fires, ICONS.flame, Math.round(num(ship.fires)));
    icon(leaks, ICONS.drop, Math.round(num(ship.leaks)));
    // Loot and hands.
    const free = !!s?.mission?.id?.startsWith?.("free");
    const lootN = Math.round(num(free ? s?.plunder?.hold : s?.plunder?.loot ?? s?.plunder?.hold));
    const ls = gold(lootN);
    if (loot.dataset.v !== ls) {
      const up = lootN > num(loot.dataset.raw, 0);
      loot.dataset.v = ls; loot.dataset.raw = String(lootN);
      fill(loot, h("span.ic", { html: ICONS.chest }), h("b", null, ls));
      if (up && lootN) replay(loot, "bump");
    }
    const hn = String(Math.round(num(ship.crewHands)));
    if (hands.dataset.v !== hn) { hands.dataset.v = hn; fill(hands, h("span.ic", { html: ICONS.hand }), h("b", null, hn)); }
    // The low-hull vignette.
    const sailing = s?.phase === "sailing" || s?.phase === "boarding";
    flag(lowVig, "on", sailing && hp < 0.3);
    flag(lowVig, "crit", sailing && hp < 0.15);
  }

  function icon(node, svg, n) {
    const sig = String(n);
    if (node.dataset.n === sig) return;
    const up = n > num(node.dataset.n, 0);
    node.dataset.n = sig;
    fill(node, h("span.ic", { html: svg }), h("b", null, sig));
    flag(node, "on", n > 0);
    if (up) replay(node, "bump");
  }

  /** Which side a hit came from, relative to the hull: port / starboard / bow / stern. */
  function sideOf(p) {
    const ship = snap?.ship;
    if (!ship || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    // From the impact point (or the shooter's position) toward the ship's centre: the bearing of the source.
    const src = Number.isFinite(p.fromX) ? { x: p.fromX, z: p.fromZ } : { x: p.x, z: p.z };
    const rel = angleDiff(bearingTo(ship.x, ship.z, src.x, src.z), num(ship.heading));
    const a = Math.abs(rel);
    return a < 40 ? "bow" : a > 140 ? "stern" : rel > 0 ? "starboard" : "port";
  }

  const offs = [
    bus.on("impact", (p = {}) => {
      if (p.target !== "rexmaw" || p.kind === "splash") return;
      const side = sideOf(p);
      if (!side) return;
      hitArc.dataset.side = side;
      replay(hitArc, "go");
      bus.emit("hit_side", { side, dmg: num(p.dmg) });
    }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") lastHull = null; }),
  ];

  return { el, update, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
