// Floating ship tags (v4 §2): the Contacts panel's replacement. A small tag
// rides above each ship's masthead: her class silhouette, her name (or class
// until the spyglass has her), a slim hull bar and the range. Shown within
// 600 m, or at any range when she's the locked target or the guns' arcs are
// on her. The locked ship's tag wears a gilt bracket (the scene draws its own
// bracket round her hull too); the guns' target glows red; "ports open" or
// "ramming" puts a small red mark on it; a struck ship carries a white flag.
//
// "B · Board" (v4 §2): only while the Rexmaw is INSIDE a boardable ship's
// 30 m ring, as a small chip under that ship's tag (one press of B boards
// her; the scene's ring on the sea says the rest). A problem the core still
// reports (ramming speed) shows on the chip instead of the key.
//
// Anchors come from the scene: world.shipTagAnchors() → [{contactId, x, y,
// visible, dist}] (over the masthead, client pixels); without it the tag sits
// at world.screenPos(id, {lift}) by her class. Tags never cover the top
// banner or the helm strip (seaBand) and nudge apart when they'd overlap.
// They take no clicks (the sea under them is aimed at); the BOARD chip does.

import { h, fill, text, flag, prop, show, clamp, num, dist as metres, contactName, classIcon, lockOf, seaBand, CLASSES } from "./dom.js";
import * as C from "../core/const.js";

const SHOW_WITHIN = 600;            // m (spec §2)
const MAX_TAGS = 7;                 // the nearest few, plus the locked / targeted one
const RING = C.BOARD?.range || 30;  // m: the boarding ring
const LIFT = { tower: 18, gunboat: 15, merchant: 22, brig: 22, fireship: 18, frigate: 28, manowar: 34, gloam: 32 };
const PORTS_MS = 3000;

/**
 * @param {object} ctx  the UI context (bus, state(), world?)
 * @param {{root: HTMLElement, preview?: () => object|null}} where  `preview`: the guns' aim preview (gunnery.js)
 */
export function createShipTags(ctx, { root, preview = () => null }) {
  const { bus } = ctx;
  const layer = h("div.nr-tags", { "aria-hidden": "true" });
  root.append(layer);
  const tags = new Map();           // contact id → {el, icon, name, hull, range, chip, chipKey, chipNote}
  const portsUntil = new Map();     // contact id → performance.now() until which "ports open" shows
  let snap = null, raf = 0;

  function tagFor(id) {
    let t = tags.get(id);
    if (t) return t;
    const icon = h("span.nr-tagic"), name = h("b.nr-tagname"), range = h("small.nr-tagrange"), hull = h("i");
    const chipKey = h("kbd", null, "B"), chipNote = h("span", null, "Board");
    const chip = h("button.nr-boardchip", { type: "button", hidden: true, title: "Board her (B)", "aria-label": "Board her (B)",
      onclick: (e) => { e.stopPropagation(); bus.intent("board"); } }, chipKey, chipNote);
    const el = h("div.nr-tag", { dataset: { id } }, h("div.nr-tagline", null, icon, name, range), h("span.nr-taghull", null, hull), chip);
    layer.append(el);
    t = { el, icon, name, hull, range, chip, chipKey, chipNote, cls: null, x: 0, y: 0, w: 0 };
    tags.set(id, t);
    return t;
  }

  function drop(id) { const t = tags.get(id); if (t) { t.el.remove(); tags.delete(id); } }

  // ---- Every frame while sailing --------------------------------------------------------------

  const liveNow = () => snap && (snap.phase === "sailing" || snap.phase === "moored") && !snap.paused && !snap.boardfight;
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (!liveNow()) { for (const id of [...tags.keys()]) drop(id); return; }
    place();
    schedule();
  }

  /** Where each ship's tag goes: the scene's masthead anchors, else her position lifted by class. */
  function anchors(list) {
    const out = new Map();
    let got = null;
    try { got = ctx.world?.shipTagAnchors?.() || null; } catch { got = null; }
    if (Array.isArray(got)) for (const a of got) if (a && a.contactId != null) out.set(a.contactId, a);
    if (!ctx.world?.screenPos) return out;
    for (const c of list) {
      if (out.has(c.id)) continue;
      try {
        const p = ctx.world.screenPos(c.id, { lift: LIFT[c.cls] ?? 22 });
        if (p) out.set(c.id, { contactId: c.id, x: p.x, y: p.y, visible: !!p.visible, dist: c.dist });
      } catch { /* the scene's not ready */ }
    }
    return out;
  }

  function place() {
    const s = snap;
    const lock = lockOf(s);
    const pv = preview() || null;
    const aimId = pv?.hit || s.gunnery?.aiming ? pv?.targetId || null : null;
    const ring = boardInRing(s);
    const all = (s.contacts || []).filter((c) => c && c.detected !== false && c.state !== "gone" && !c.cloaked && !(c.cls === "tower" && c.down));
    // The objective's ship already wears the scene's gilt marker (name + range): no second label unless she's
    // locked, aimed at or in reach of the grapples.
    const objShip = s.objective?.marker?.kind === "ship" && s.objective.marker.seen !== false ? s.objective.marker.contactId : null;
    const near = all.filter((c) => c.state !== "sinking" && c.id !== objShip && num(c.dist, 9e9) <= SHOW_WITHIN).sort((a, b) => num(a.dist) - num(b.dist)).slice(0, MAX_TAGS);
    const want = new Map(near.map((c) => [c.id, c]));
    for (const c of all) if ((c.id === lock || c.id === aimId || c.id === ring?.contactId) && c.state !== "sinking") want.set(c.id, c);
    const A = anchors([...want.values()]);
    const band = seaBand();
    const now = performance.now();
    const shown = [];
    for (const [id, c] of want) {
      let a = A.get(id);
      // The ship we're alongside keeps her tag (and the B chip) on screen: pinned to the edge on her side when her
      // masthead is out of frame (abeam, close in, while the chase looks ahead).
      if (id === ring?.contactId && (!a || !a.visible)) a = edgeAnchor(c) || a;
      if (!a || !a.visible || !Number.isFinite(a.x) || !Number.isFinite(a.y)) { drop(id); continue; }
      const t = tagFor(id);
      // The content.
      if (t.cls !== c.cls) { t.cls = c.cls; t.icon.innerHTML = classIcon(c.cls); t.icon.title = CLASSES[c.cls]?.name || ""; }
      text(t.name, c.derelict ? `Derelict${c.known && c.name ? ` ${c.name}` : ""}` : contactName(c, { article: false }));
      const d = num(c.dist, num(a.dist, NaN));
      text(t.range, metres(d));
      prop(t.hull, "--p", clamp(num(c.hull, 1), 0, 1));
      const struck = c.state === "surrender";
      t.el.dataset.side = c.derelict ? "derelict" : struck ? "struck" : c.hostile === false ? (c.cls === "merchant" ? "prize" : "friend") : c.navy ? "navy" : "foe";
      flag(t.el, "locked", id === lock || !!c.locked);
      flag(t.el, "aim", id === aimId);
      flag(t.el, "goal", !!c.objective || !!c.chest || !!c.prize);
      flag(t.el, "boss", c.cls === "gloam" || c.cls === "manowar");
      const ports = (c.portsOpen && (c.portsOpen.port || c.portsOpen.starboard)) || now < (portsUntil.get(id) || 0);
      flag(t.el, "danger", !struck && (ports || c.state === "ram" || (c.cls === "fireship" && c.lit) || !!c.spotted));
      flag(t.el, "known", !!c.known);
      prop(t.el, "--fade", clamp(1 - (num(d, 0) - 300) / 900, 0.62, 1));
      // The boarding chip: only inside her ring.
      const inRing = ring?.contactId === id;
      show(t.chip, inRing);
      if (inRing) {
        const ready = !ring.problem && ring.inRange !== false;
        flag(t.chip, "ready", ready);
        text(t.chipNote, ready ? "Board" : String(ring.problem || "Not yet"));
        show(t.chipKey, ready);
      }
      shown.push({ t, x: a.x, y: clamp(a.y, band.top + 18, band.bottom - (inRing ? 34 : 6)), d: num(d, 0) });
    }
    for (const id of [...tags.keys()]) if (!want.has(id) || !shown.some((r) => r.t === tags.get(id))) drop(id);
    // Nudge apart: nearer ships keep their spot, farther ones step up out of the way. The reticle's words count as
    // a tag already placed, so a ship under the crosshair gets her tag above them.
    shown.sort((a, b) => a.d - b.d);
    const placed = [];
    const rt = document.querySelector("#hud .nr-reticle:not(.quiet) .nr-rtext")?.getBoundingClientRect?.();
    if (rt && rt.width > 0) placed.push({ x: rt.left + rt.width / 2, y: rt.top + rt.height / 2, w: rt.width, h: rt.height + 6 });
    for (const r of shown) {
      const w = r.t.el.offsetWidth || 120, hgt = r.t.el.offsetHeight || 30;
      let y = r.y;
      for (let pass = 0; pass < 4; pass++) {
        const hit = placed.find((p) => Math.abs(p.x - r.x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < (p.h + hgt) / 2 + 2);
        if (!hit) break;
        y = hit.y - (hit.h + hgt) / 2 - 3;
      }
      y = Math.max(band.top + 18, y);
      placed.push({ x: r.x, y, w, h: hgt });
      const x = clamp(r.x, w / 2 + 6, innerWidth - w / 2 - 6);
      r.t.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    }
  }

  /** A tag spot for a ship out of frame: her hull (6 m up) clamped to the screen, or her side's edge when she's behind the lens. */
  function edgeAnchor(c) {
    let p = null;
    try { p = ctx.world?.screenPos?.(c.id, { lift: 6 }) || null; } catch { p = null; }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const off = ((num(c.rel, 0) - num(ctx.world?.look?.yaw, 0) + 540) % 360) - 180;   // her bearing off the look, ° (+ starboard)
    if (Math.abs(off) > 90) p = { x: off > 0 ? innerWidth : 0, y: innerHeight * 0.45 };
    return { contactId: c.id, x: clamp(p.x, 0, innerWidth), y: clamp(p.y, 0, innerHeight), visible: true, dist: c.dist };
  }

  /** The boardable ship whose 30 m ring the Rexmaw is inside (core v3 `state.boardable`, nearest first). */
  function boardInRing(s) {
    if (!s || s.phase !== "sailing") return null;
    for (const b of Array.isArray(s.boardable) ? s.boardable : []) {
      if (!b) continue;
      if (b.inRing === true || (b.inRing == null && num(b.dist, 9e9) <= RING)) return b;
    }
    return null;
  }

  const offs = [
    bus.on("ports", ({ id, open } = {}) => { if (!id) return; if (open === false) portsUntil.delete(id); else portsUntil.set(id, performance.now() + PORTS_MS); }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { portsUntil.clear(); for (const id of [...tags.keys()]) drop(id); } }),
  ];

  return {
    el: layer,
    update(s) { snap = s || null; if (liveNow()) schedule(); },
    /** The ship the Rexmaw can board right now (inside her ring), or null. */
    boardable: () => boardInRing(snap),
    dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); cancelAnimationFrame(raf); fill(layer); },
  };
}
