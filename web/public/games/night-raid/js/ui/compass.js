// The compass tape (v2 spec §4 call_heading): v4 puts it back at the BOTTOM
// centre, just above the helm strip (as in v1/v2), with the heading read out
// beside it; the companion's heading banner sits right above it. The
// Rexmaw's heading in the middle, ±100° either side. On it:
//   ⚑ gilt     the current objective's bearing, its distance under it (v3)
//   ◆ gilt     the heading the companion called (call_heading), with the
//              banner under the tape: "Eve: steer NE (045) · reef band ahead"
//   ▮ red      danger areas they marked (mark_danger), as wide as they are
//   • pips     contacts (red hostile, gold prize, star for a mission target;
//              the locked target ringed in gilt)
//   ◇ small    v4 sea events within 1.2 km, in their colour (hollow: telegraphed)
//   ○ blue     an accepted suggestion's course
//   ▾ small    where the camera is looking (the guns follow the look)
// A marker past the tape's edge sticks to it with an arrow, so a call
// behind the ship still says which way to turn.

import { h, fill, text, flag, show, clamp, num, angleDiff, norm360, deg3, COMPASS16, bearingTo, byName, point8, dist as metres, lockOf, SEA_EVENTS, seaKind, seaStage } from "./dom.js";
import { readObjective } from "./objective.js";

const SPAN = 100;            // degrees either side of the heading
const TICK = 15;

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent
 * @param {{look?: () => object}} [opts]
 */
export function createCompass(ctx, parent, { look = () => null } = {}) {
  const { bus } = ctx;
  const tape = h("div.nr-tape");
  const marks = h("div.nr-tapemarks");
  const lookTick = h("i.nr-looktick", { title: "Where you're looking" });
  const hdg = h("b.nr-hdgread");
  const el = h("section.nr-compass", { role: "group", "aria-label": "Compass" },
    h("div.nr-tapebox", null, tape, marks, lookTick, h("i.nr-lubber", { "aria-hidden": "true" })), hdg);
  const banner = h("div.nr-callbanner", { hidden: true, role: "status", "aria-live": "polite" });
  parent.append(el, banner);

  // The tape's ticks, drawn once for 0..360 three times over (so it can slide).
  const ticks = [];
  for (let d = -360; d < 720; d += TICK) {
    const n = norm360(d), major = n % 45 === 0;
    ticks.push(h(`i.nr-tick${major ? ".major" : ""}`, { style: `--d:${d}` }, major ? h("span", null, COMPASS16[Math.round(n / 22.5) % 16]) : null));
  }
  fill(tape, ticks);

  let snap = null, callKey = "", bannerTimer = 0;

  const xOf = (rel) => clamp(rel / SPAN, -1, 1);   // −1 left edge … 1 right edge

  function marker(cls, rel, title, extra = null, widthDeg = 0) {
    const off = Math.abs(rel) > SPAN;
    const m = h(`i.nr-mk.${cls}${off ? ".off" : ""}${off && rel < 0 ? ".left" : off ? ".right" : ""}`, { title, style: `--x:${xOf(rel)};--w:${clamp(widthDeg / (SPAN * 2), 0, 1)}` }, extra);
    return m;
  }

  function update(s) {
    snap = s;
    const ship = s?.ship;
    if (!ship) return;
    const head = norm360(num(ship.heading));
    tape.style.setProperty("--h", String(head));
    text(hdg, `${deg3(head)}° ${COMPASS16[Math.round(head / 22.5) % 16]}`);
    const L = look();
    if (L && Number.isFinite(L.yaw)) { lookTick.style.setProperty("--x", String(xOf(L.yaw))); show(lookTick, Math.abs(L.yaw) <= SPAN); }
    const items = [];
    // Danger areas within 700 m: a red band as wide as the area looks from here.
    for (const d of s.dangers || []) {
      const dd = Math.hypot(d.x - ship.x, d.z - ship.z);
      if (dd > 700) continue;
      const rel = angleDiff(bearingTo(ship.x, ship.z, d.x, d.z), head);
      const half = dd > (d.r || 40) ? Math.asin(clamp((d.r || 40) / dd, 0, 1)) * 180 / Math.PI : 60;
      items.push(marker("danger", rel, `${d.label || d.kind || "Danger"} · ${Math.round(dd)} m`, null, half * 2));
    }
    // Contacts (the locked one ringed in gilt).
    const lock = lockOf(s);
    for (const c of s.contacts || []) {
      if (!c || c.detected === false || c.state === "sinking" || c.cloaked) continue;
      const rel = Number.isFinite(c.rel) ? c.rel : angleDiff(bearingTo(ship.x, ship.z, c.x, c.z), head);
      const cls = c.objective || c.chest ? "goal" : c.hostile === false || c.state === "surrender" ? "prize" : "foe";
      items.push(marker(`pip.${cls}${c.id === lock ? ".locked" : ""}`, rel, c.name || c.cls));
    }
    // v4 sea events within 1.2 km: a small diamond in the event's colour (hollow while telegraphed).
    for (const ev of Array.isArray(s.events) ? s.events : []) {
      if (!ev || !Number.isFinite(ev.x) || seaStage(ev) === "end") continue;
      const d = Math.hypot(ev.x - ship.x, ev.z - ship.z);
      if (d > 1200) continue;
      const k = seaKind(ev.kind);
      const m = marker(`ev${seaStage(ev) === "warn" ? ".warn" : ""}`, angleDiff(bearingTo(ship.x, ship.z, ev.x, ev.z), head), `${SEA_EVENTS[k]?.label || k} · ${metres(d)}`);
      m.style.setProperty("--c", SEA_EVENTS[k]?.color || "#9fb4ff");
      items.push(m);
    }
    // The objective (v3): a gilt flag on its bearing with the distance under it.
    const mk = readObjective(s)?.marker;
    if (mk) {
      const brg = Number.isFinite(mk.bearing) ? mk.bearing : Number.isFinite(mk.x) ? bearingTo(ship.x, ship.z, mk.x, mk.z) : null;
      const rel = Number.isFinite(mk.rel) ? mk.rel : brg != null ? angleDiff(brg, head) : null;
      if (rel != null) items.push(marker("obj", rel, `${mk.label || "Objective"} · ${metres(num(mk.dist, NaN))}`, h("b", null, metres(num(mk.dist, NaN)))));
    }
    // The course.
    if (s.course && Number.isFinite(s.course.x)) {
      items.push(marker("course", angleDiff(bearingTo(ship.x, ship.z, s.course.x, s.course.z), head), s.course.label || "Course"));
    }
    // The called heading.
    const call = s.headingCall;
    if (call && Number.isFinite(call.deg) && num(call.expiresIn, 1) > 0) {
      const rel = angleDiff(call.deg, head);
      items.push(marker("call", rel, `Steer ${call.word || point8(call.deg)} (${deg3(call.deg)})`, h("b", null, call.word || point8(call.deg))));
      flag(el, "oncourse", Math.abs(rel) < 8);
      const key = `${call.deg}|${call.reason}|${call.by}`;
      if (key !== callKey) { callKey = key; showBanner(call); }
    } else {
      flag(el, "oncourse", false);
      if (callKey) { callKey = ""; hideBanner(); }
    }
    const sig = items.map((m) => m.className + m.getAttribute("style")).join("|");
    if (marks.dataset.sig !== sig) { marks.dataset.sig = sig; fill(marks, items); }
  }

  function showBanner(call) {
    const who = byName(ctx, call.by || "companion");
    fill(banner, h("span.nr-cbwho", null, who), h("b", null, `Steer ${call.word || point8(call.deg)} `, h("small", null, `(${deg3(call.deg)}°)`)),
      call.reason ? h("em", null, call.reason) : null);
    show(banner, true);
    banner.classList.remove("in"); void banner.offsetWidth; banner.classList.add("in");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.add("dim"), 7000);
    banner.classList.remove("dim");
  }
  function hideBanner() { clearTimeout(bannerTimer); show(banner, false); }

  const offs = [
    bus.on("heading_call", (p = {}) => { if (Number.isFinite(p.deg)) { callKey = `${p.deg}|${p.reason}|${p.by}`; showBanner(p); } }),
    bus.on("phase", (p = {}) => { if (p.phase !== "sailing") { callKey = ""; hideBanner(); } }),
  ];
  void snap;
  return { el, update, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
