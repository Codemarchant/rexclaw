// Rexmaw Raids' HUD (v2 §2–§4, v3 §A–§C, v4 §1–§2): everything on the glass
// while the Rexmaw is out. The sea round the ship (the middle of the screen)
// stays clear but for the reticle, the small ship tags and the objective arrow.
//
//   top centre    the mission STRIP (one line: step, instruction, distance,
//                 clock; it opens for ~4 s on a new step), the fail chips (only
//                 from 50 %), the sea-event chips, hazard warnings, toasts, pops;
//                 in a boarding fight: their captain's HP and the enemies left
//   top left      (under the kit's crew toast) the pause button (beside it "Solo"
//                 while the companion sits out off a call) and the CREW
//                 REPORT: what the crew has done for you (totals), their jobs,
//                 a ticker of what just happened
//   top right     (under the kit's cog) the bay chart (with the sea events),
//                 the companion's suggestion card
//   over the sea  the reticle (it names the locked target); hit markers and
//                 damage numbers; a small tag over each ship within 600 m or
//                 locked (class, name, hull; a gilt bracket when locked) and,
//                 inside a boardable ship's ring, the small "B · Board" chip
//                 under her tag; the objective's edge arrow; contribution pops
//   bottom centre the companion's heading banner and the COMPASS tape (v4:
//                 back down here), then the HELM STRIP: the ship's state (big
//                 hull bar, masts, water, fire, leaks, where the last hit came
//                 from), the guns (reload bars, the weapon), the sails, speed and
//                 BRACE, and at its bottom-left the crew modes (1/2/3) with the
//                 line of what the crew is doing; a boarding fight takes the
//                 strip's place (the pistol, our fighters, the focus, RALLY)
//   left middle   the mission briefing card (phase `briefing`)
//   overlay       the BRACE prompt, the danger glow on the threatened side,
//                 hit flashes, the flooding tint, the low-hull vignette, the
//                 spyglass's ring, the mission stamp
//
// It renders from the core's `tick` snapshots (10 Hz) and the run's events;
// the Captain's input leaves as intents (input.js), never as calls into the sim.

import { h, fill, show, flag, prop, replay, clamp, soundButtons, byName, crewName, num, relOf, sideWord, point8,
  angleDiff, norm360, gold, contactName, nameOf, ICONS, PICKUPS } from "./dom.js";
import { getSettings } from "./settings.js";
import { createChart } from "./chart.js";
import { createShipTags } from "./shiptags.js";
import { createSeaEvents } from "./seaevents.js";
import { createBoarding } from "./boarding.js";
import { createInput } from "./input.js";
import { createGunnery } from "./gunnery.js";
import { createCompass } from "./compass.js";
import { createMission } from "./mission.js";
import { createObjective } from "./objective.js";
import { createOrders } from "./orders.js";
import { createSuggestions } from "./suggestions.js";
import { createShipStatus } from "./shipstatus.js";
import { createCrewModes } from "./crewmodes.js";
import { createBuffs } from "./buffs.js";

/** Phases with the ship in the water and the HUD up. */
export const LIVE_PHASES = new Set(["briefing", "moored", "sailing", "boarding", "ending"]);
const TOAST_MS = 4200;
const BRACE_PROMPT_MS = 2000;
const SIDE_GLOW = { port: "port", starboard: "starboard", bow: "ahead", stern: "astern" };

/**
 * Build the HUD into `ctx.dom.hud`.
 * @param {object} ctx  the UI context (bus, state(), name(), dom, world?, bayWorld?, aimPreview?)
 */
export function createHud(ctx) {
  const { bus } = ctx;
  const root = ctx.dom.hud;
  root.classList.add("nr-hud");
  soundButtons(root);

  // ---- Skeleton ----------------------------------------------------------------------------

  const el = {
    vignette: h("div.nr-vignette", { "aria-hidden": "true" }, h("i.l"), h("i.r"), h("i.f"), h("i.b")),
    flood: h("div.nr-flood", { "aria-hidden": "true" }),
    flash: h("div.nr-flash", { "aria-hidden": "true" }),
    scope: h("div.nr-scope", { hidden: true, "aria-hidden": "true" }, h("i.nr-cross")),
    centre: h("div.nr-centre"),
    top: h("div.nr-top"),
    left: h("div.nr-left"),
    right: h("div.nr-right"),
    bottom: h("div.nr-bottom"),
    brief: h("div.nr-briefslot"),
    stampSlot: h("div.nr-stampslot"),
    hazard: h("div.nr-hazard", { hidden: true, role: "alert" }),
    toasts: h("div.nr-toasts", { "aria-live": "polite" }),
    pops: h("div.nr-pops", { "aria-hidden": "true" }),
    brace: h("div.nr-brace", { hidden: true, role: "alert" }),
    swivelRing: h("i.nr-swivelring", { hidden: true, "aria-hidden": "true" }),
    markRing: h("i.nr-markring", { hidden: true, "aria-hidden": "true" }),
    pause: h("button.nr-pausebtn", { type: "button", "aria-label": "Pause, sound and settings", title: "Pause (Esc)", html: ICONS.pause }),
    // Off a call with the companion sitting out (Settings → Companion: Solo, or no off-call play): no order feed from them.
    solo: h("button.nr-solobadge", { type: "button" }, "Solo"),
  };
  el.pause.addEventListener("click", () => getSettings(ctx).open());
  el.solo.addEventListener("click", () => getSettings(ctx).open());

  // The pieces.
  fill(root, el.vignette, el.flood, el.flash, el.scope, el.centre, el.top, el.left, el.right, el.bottom, el.brief, el.stampSlot, el.swivelRing, el.markRing);
  let input = null;
  const objective = createObjective(ctx, { banner: el.top, root, input: () => input });
  const seaEvents = createSeaEvents(ctx, el.top);
  const mission = createMission(ctx, { briefing: el.brief, stamp: el.stampSlot });
  el.top.append(el.hazard, el.toasts, el.pops);
  el.left.append(h("div.nr-lefthead", null, el.pause, el.solo));
  const orders = createOrders(ctx, el.left, { root });
  const chart = createChart(ctx, el.right);
  const suggestions = createSuggestions(ctx, el.right);
  // Bottom centre, top to bottom: the heading banner, the compass, BRACE, the helm strip (CSS order).
  const compass = createCompass(ctx, el.bottom, { look: () => input?.look?.() });
  el.bottom.append(el.brace);
  const buffs = createBuffs(ctx, el.bottom);   // v4.2: the power-ups on us, just above the helm strip
  const gunnery = createGunnery(ctx, { reticle: el.centre, deck: el.bottom, root, input: () => input });
  const status = createShipStatus(ctx, { parent: gunnery.el, root });
  // The crew modes: the strip's bottom-left, with the line of what the crew is doing beside them.
  const crewRow = h("div.nr-deckrow.crew");
  gunnery.el.append(crewRow);
  const crewModes = createCrewModes(ctx, crewRow);
  crewRow.append(crewModes.doing);
  const tags = createShipTags(ctx, { root, preview: () => gunnery.preview() });
  const boarding = createBoarding(ctx, { top: el.top, bottom: el.bottom, root });
  const api = { scope, braced, swivelShot, marked, swivelHint: (on) => gunnery.swivelHint(on), fired: (l) => gunnery.fired(l) };
  input = createInput(ctx, { suggestions, boarding, settings: getSettings(ctx), hud: api, crewModes });

  // ---- Little helpers ------------------------------------------------------------------------

  let flashT = 0;
  function flash(kind) {
    el.flash.className = `nr-flash ${kind}`;
    replay(el.flash, "go");
    clearTimeout(flashT);
    flashT = setTimeout(() => el.flash.classList.remove("go"), 1400);
  }

  function pop(msg, { kind = "", x = null, y = null } = {}) {
    const p = h(`div.nr-pop${kind ? `.${kind}` : ""}`, null, msg);
    if (x != null) { p.classList.add("at"); p.style.left = `${x}px`; p.style.top = `${y}px`; root.append(p); } else el.pops.append(p);
    setTimeout(() => p.remove(), 2000);
    while (el.pops.children.length > 3) el.pops.firstChild.remove();
  }

  /** A warning or a status line (never a "done!" confirmation: the game shows those in the world). */
  function toast(msg, { kind = "", ms = TOAST_MS } = {}) {
    if (!msg) return;
    const t = h(`div.nr-toast${kind ? `.${kind}` : ""}`, null, msg);
    el.toasts.append(t);
    while (el.toasts.children.length > 1) el.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, ms);
  }

  function scope(on) {
    show(el.scope, on);
    flag(document.body, "nr-spyglass", on);
  }

  let braceUntil = 0, braceTimer = 0, braceText = "";
  /** The BRACE prompt: `why` under it; it pulses until the Captain braces or it times out. */
  function bracePrompt(why = "", ms = BRACE_PROMPT_MS) {
    braceUntil = performance.now() + ms;
    if (el.brace.hidden || braceText !== why) {
      braceText = why;
      fill(el.brace, h("b", null, "BRACE!"), h("kbd", null, "Space"), why ? h("small", null, why) : null);
      el.brace.className = "nr-brace";
      show(el.brace, true);
      replay(el.brace, "in");
    }
    clearTimeout(braceTimer);
    braceTimer = setTimeout(() => { if (performance.now() >= braceUntil - 10) show(el.brace, false); }, ms);
  }
  function braced() { /* the gun deck's button replays its own */ }
  function braceResult(perfect) {
    clearTimeout(braceTimer);
    fill(el.brace, h("b", null, perfect ? "PERFECT BRACE!" : "Braced"));
    el.brace.className = `nr-brace result${perfect ? " perfect" : ""}`;
    show(el.brace, true);
    replay(el.brace, "in");
    braceTimer = setTimeout(() => show(el.brace, false), 1100);
  }

  let swivelUntil = 0, lastClick = null;
  function swivelShot(x, y) {
    lastClick = { x, y };
    swivelUntil = performance.now() + 1500;
    el.swivelRing.style.left = `${x}px`; el.swivelRing.style.top = `${y}px`;
    show(el.swivelRing, true);
    replay(el.swivelRing, "spin");
    setTimeout(() => { if (performance.now() >= swivelUntil - 20) show(el.swivelRing, false); }, 1500);
  }
  /** A right-click mark: a gilt ring closes on the click point (the ship's own marks follow from the tick). */
  function marked(id, at) {
    if (!at) return;
    el.markRing.style.left = `${at.x}px`; el.markRing.style.top = `${at.y}px`;
    flag(el.markRing, "clear", !id);
    show(el.markRing, true);
    replay(el.markRing, "go");
    setTimeout(() => show(el.markRing, false), 700);
  }

  // ---- Rendering --------------------------------------------------------------------------------

  let snap = null;

  function update(s) {
    if (!s || typeof s !== "object") return;
    snap = s;
    document.body.dataset.phase = s.phase || "";
    const day = num(s.daylight, 1) >= 0.5;
    if (document.body.dataset.tod !== (day ? "day" : "night")) document.body.dataset.tod = day ? "day" : "night";
    flag(root, "nr-live", LIVE_PHASES.has(s.phase));
    flag(root, "nr-solo", !!s.solo);
    if (s.solo) el.solo.title = `${nameOf(ctx)} sits out off a call: the crew modes (1 / 2 / 3) run the crew. Start a call and they're back. (Settings → Companion)`;
    const ship = s.ship || {};
    prop(el.flood, "--w", clamp(num(ship.water) / 100, 0, 1));
    flag(el.flood, "on", num(ship.water) >= 25);

    // The panels.
    compass.update(s);
    objective.update(s);
    mission.update(s);
    status.update(s);
    crewModes.update(s);
    crewModes.doing.title = crewModes.doing.textContent;   // the strip ellipsizes a long line; the whole of it on hover
    orders.update(s);
    chart.update(s);
    seaEvents.update(s);
    buffs.update(s);
    suggestions.update(s);
    gunnery.update(s);
    tags.update(s);
    boarding.update(s);
    flag(el.bottom, "boarding", boarding.active());
    threats(s);
  }

  // ---- Threats: the danger glow, hazard chips, the auto BRACE prompt -------------------------------

  let hazardKey = "", hitGlow = null, hitGlowT = 0;
  function threats(s) {
    const ship = s.ship || {};
    let side = null, d = 0, msg = null, kind = "", brace = null;
    const hz = s.hazards || {};
    const consider = (sd, k) => { if (k > d) { d = k; side = sd; } };
    const sideOf = (rel) => (Math.abs(rel) < 35 ? "ahead" : Math.abs(rel) > 145 ? "astern" : rel > 0 ? "starboard" : "port");
    for (const c of s.contacts || []) {
      if (!c || c.detected === false || c.state === "surrender" || c.state === "sinking") continue;
      const { rel, dist: dd } = relOf(ship, c);
      const sd = sideOf(rel);
      const open = c.portsOpen && (c.portsOpen.port || c.portsOpen.starboard);
      if (open && dd < 380) { consider(sd, 0.7 + 0.3 * (1 - dd / 380)); if (!msg) { msg = `${contactName(c, { article: false })}: gun ports open, ${sideWord(rel)}`; kind = "guns"; } if (dd < 260) brace = brace || (["port", "starboard"].includes(sd) ? `Broadside from the ${sd}` : `Guns firing from ${sd}`); }
      if ((c.state === "ram" || (c.cls === "fireship" && c.lit)) && dd < 220) { consider(sd, 0.9); msg = c.cls === "fireship" ? `Fire ship lit, ${sideWord(rel)}! Steer clear` : `${contactName(c, { article: false })} is ramming, ${sideWord(rel)}!`; kind = "ram"; if (dd < 60) brace = "Ram incoming"; }
      if (c.spotted && !msg) { msg = `Spotted! ${contactName(c, { article: false })}'s lantern is on you`; kind = "ram"; consider(sd, 0.6); }
      else if (num(c.alert) > 0.5 && !msg) { msg = `A lantern's sweeping close, ${sideWord(rel)}`; kind = "guns"; }
    }
    if (hz.wave && Number.isFinite(hz.wave.eta) && hz.wave.eta > 0) {
      const rel = angleDiff(norm360(hz.wave.dirDeg + 180), num(ship.heading));
      consider(sideOf(rel), clamp(1 - hz.wave.eta / 14, 0.3, 1));
      msg = `Rogue wave from the ${point8(norm360(hz.wave.dirDeg + 180))} · ${Math.ceil(hz.wave.eta)} s · meet it bow-on`;
      kind = "wave";
      if (hz.wave.eta < 2.2) brace = "The wave";
    }
    if (hz.kraken && hz.kraken.stage !== "retreat") {
      const arms = (hz.kraken.arms || []).filter((a) => num(a.hp) > 0);
      msg = hz.kraken.stage === "ink" ? "Ink in the water. Something's under us." : `Kraken! ${arms.length} arm${arms.length === 1 ? "" : "s"} on the rails: shoot them (swivel or heavy), or crew to Defend`;
      kind = "kraken"; consider("ahead", 0.8);
    }
    const mortar = (hz.mortars || []).find((m) => m.from !== "rexmaw" && Math.hypot(m.x - ship.x, m.z - ship.z) < (m.r || 30) + 12);
    if (mortar) { msg = `Mortar landing on us in ${Math.max(0, Math.ceil(mortar.eta))} s! Turn or brace`; kind = "ram"; if (mortar.eta < 1.4) brace = "Mortar shell"; consider("ahead", 0.9); }
    if (num(ship.stuckT) > 0 && !msg) { msg = "Aground!"; kind = "ram"; }
    if (hz.maelstrom && Number.isFinite(hz.maelstrom.x) && !msg) {
      const dm = Math.hypot(hz.maelstrom.x - ship.x, hz.maelstrom.z - ship.z);
      if (dm < (hz.maelstrom.r || 220)) { msg = dm < (hz.maelstrom.eye || 35) * 2.5 ? "The maelstrom's eye! Full sail, out!" : "In the maelstrom's pull"; kind = "storm"; consider("ahead", clamp(1 - dm / (hz.maelstrom.r || 220), 0, 1) * 0.7); }
    }
    for (const p of s.projectiles || []) {
      if (p.from === "rexmaw" || !Number.isFinite(p.eta) || p.eta > 0.8) continue;
      if (Math.hypot(p.x - ship.x, p.z - ship.z) < 110) { brace = brace || "Shot incoming"; break; }
    }
    // A hit just landed: that side glows for a moment (the helm strip's arc says it too).
    if (hitGlow && performance.now() < hitGlowT) consider(hitGlow, 0.95);
    el.vignette.dataset.side = side || "";
    prop(el.vignette, "--d", clamp(d, 0, 1));
    flag(el.vignette, "on", d > 0.25 && s.phase === "sailing");
    flag(el.vignette, "urgent", d > 0.85);
    const key = msg ? `${kind}|${msg}` : "";
    if (key !== hazardKey) {
      hazardKey = key;
      if (msg) { fill(el.hazard, h("span.ic", { html: ICONS.warning }), h("b", null, msg)); el.hazard.dataset.kind = kind; show(el.hazard, true); replay(el.hazard, "in"); } else show(el.hazard, false);
    }
    if (brace && s.phase === "sailing" && num(ship.braceT) <= 0) bracePrompt(brace, 1200);
  }

  const nameById = (id) => { const c = (snap?.contacts || []).find((x) => x.id === id); return c ? contactName(c, { article: false }) : "She"; };

  // ---- The run's events -------------------------------------------------------------------------------

  const offs = [
    bus.on("tick", (s) => update(s)),
    bus.on("phase", (p = {}) => {
      if (p.world) chart.setWorld(p.world);
      if (p.phase === "briefing" || p.phase === "moored") chart.reset();
      if (!LIVE_PHASES.has(p.phase)) { show(el.brace, false); scope(false); }
    }),
    bus.on("toast", (p) => toast(typeof p === "string" ? p : p?.text, { kind: p?.kind || "" })),
    // (v4: the boarding fight's own title card says how it went: ui/boarding.js listens to `boardfight`.)
    bus.on("board", (p = {}) => { if (p.stage === "refused" && p.reason) toast(p.reason, { kind: "warn" }); }),
    bus.on("brace", (p = {}) => { if (p.stage !== "start") braceResult(!!p.perfect); }),
    bus.on("brace_call", (p = {}) => bracePrompt(`${byName(ctx, p.by || "companion")} calls it`, BRACE_PROMPT_MS)),
    bus.on("impact", (p = {}) => {
      if (p.target !== "rexmaw" || p.kind === "splash") return;
      if (num(p.dmg) >= 6) flash(p.braced ? "braced" : "hit");
      if (num(p.dmg) >= 1 && p.kind === "hull") pop(`−${Math.round(num(p.dmg))} hull${p.braced ? " (braced)" : ""}`, { kind: "hit" });
    }),
    bus.on("hit_side", (p = {}) => { hitGlow = SIDE_GLOW[p.side] || null; hitGlowT = performance.now() + 1200; if (snap) threats(snap); }),
    bus.on("pickup", (p = {}) => {
      const parts = [];
      if (num(p.gold) > 0) parts.push(`+${gold(p.gold)} gold`);
      if (num(p.hull) > 0) parts.push(`+${Math.round(num(p.hull))} hull`);
      for (const [k, v] of Object.entries(p.ammo || {})) if (num(v) > 0) parts.push(`+${v} ${k}`);
      pop(parts.join(" · ") || PICKUPS[p.kind]?.label || "Hauled aboard", { kind: "gold" });
      if (p.note) toast(`A note in the bottle: ${p.note}`, { ms: 7000 });
    }),
    bus.on("plunder", (p = {}) => { if (num(p.amount) > 0 && p.from !== "pickup") pop(`+${gold(p.amount)} gold`, { kind: "gold" }); }),
    bus.on("bank", (p = {}) => { pop(`Banked ${gold(p.amount)}!`, { kind: "gold" }); flash("gold"); }),
    bus.on("heat", (p = {}) => { if (num(p.level) > num(p.prev)) pop(`Heat ${p.level}: the navy's hunting`, { kind: "hit" }); }),
    bus.on("swivel", (p = {}) => {
      const at = lastClick || {};
      pop(p.hit ? (p.effect === "fire" ? "Hit! She's burning" : p.effect === "officer" ? "Hit! An officer down" : p.effect === "arm" ? "Hit the arm!" : p.effect === "eye" ? "Hit the eye!" : "Hit!") : "Miss", { kind: p.hit ? "gold" : "note", x: at.x, y: at.y });
    }),
    bus.on("sink", (p = {}) => {
      const c = (snap?.contacts || []).find((x) => x.id === p.id);
      pop(c?.cls === "tower" || p.cls === "tower" ? "Tower down!" : `${nameById(p.id)} is going down!`, { kind: "gold" });
    }),
    bus.on("split", (p = {}) => pop(`${nameById(p.id)} split in two!`, { kind: "gold" })),
    bus.on("surrender", (p = {}) => pop(`${nameById(p.id)} strikes her colours!`, { kind: "gold" })),
    bus.on("spotted", (p = {}) => { if (p.stage === "spotted") { flash("hit"); toast("Spotted! The patrol's coming for you.", { kind: "warn" }); } }),
    bus.on("hazard", (p = {}) => {
      if (p.kind === "lightning" && p.stage === "strike") flash("lightning");
      if ((p.kind === "wave" || p.kind === "spout") && p.stage === "hit") flash("wave");
      if (p.kind === "reef" && p.stage === "hit") { flash("hit"); pop("Aground on the reef!", { kind: "hit" }); }
      // v5: the Kraken's eye surfaces (it's locked: the guns lay themselves on it).
      if (p.kind === "kraken" && p.eye && p.stage === "rise") toast("The eye is up — fire everything at it!", { kind: "danger", ms: 5000 });
      // v5: a boss (the Gloam, the Iron Duke) starts a ram run.
      if (p.kind === "ram" && p.stage === "telegraph") {
        const eta = num(p.eta, NaN);
        const rammer = (snap?.contacts || []).find((x) => x.id === (p.by ?? p.id));
        const who = rammer?.cls === "gloam" ? "The Gloam" : rammer?.cls === "manowar" ? "The Iron Duke" : nameById(p.by ?? p.id);
        toast(`Ram run! ${who} is coming at you${Number.isFinite(eta) ? ` (${Math.max(1, Math.round(eta))} s)` : ""}. Brace or turn away`, { kind: "danger", ms: 5500 });
        // Her side of us glows for a few seconds (she may still be in her fog).
        if (rammer && snap?.ship) {
          const { rel } = relOf(snap.ship, rammer);
          hitGlow = Math.abs(rel) < 35 ? "ahead" : Math.abs(rel) > 145 ? "astern" : rel > 0 ? "starboard" : "port";
          hitGlowT = performance.now() + 3500;
          threats(snap);
        }
      }
    }),
    bus.on("overboard", (p = {}) => {
      if (p.stage === "swept") { toast(`${crewName(ctx, p.who)} is overboard! Slow down to pick them up.`, { kind: "warn", ms: 6000 }); flash("wave"); }
      else if (p.stage === "lost") toast(`${crewName(ctx, p.who)} couldn't be reached. The jolly boat will fetch them home.`, { kind: "warn" });
    }),
    bus.on("fire", (p = {}) => { if (p.target === "rexmaw" && p.stage === "start") flash("fire"); }),
    bus.on("contact", (p = {}) => {
      if (p.stage !== "appear") return;
      if (p.cls === "gloam") toast("The Gloam is out there in the fog.", { kind: "warn", ms: 6000 });
      else if (p.cls === "manowar") toast("The Iron Duke is in sight.", { kind: "warn", ms: 5000 });
    }),
    bus.on("view", ({ name } = {}) => { if (name !== "voyage" && name !== "raid") { scope(false); show(el.brace, false); } }),
  ];

  return {
    el: root,
    update,
    toast,
    pop,
    bracePrompt,
    scope,
    flash,
    chart, tags, seaEvents, buffs, suggestions, boarding, input, gunnery, compass, mission, objective, orders, status, crewModes,
    dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); },
  };
}
