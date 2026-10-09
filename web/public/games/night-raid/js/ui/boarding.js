// The boarding fight on the glass (v4 §1, replacing v3's rock-paper-scissors
// rounds). Nothing here blocks the deck: the fight plays in the scene and
// these are readouts round its edges.
//
//   title card    "BOARDING — take their captain" and her name, for ~2.6 s at
//                 the start; the captain's arrival and the result reuse it
//   top strip     (in the objective banner's place) their captain's name and
//                 HP bar once he's on deck (before that: when he'll show), and
//                 the enemies left as pips with a count
//   bottom strip  (in the helm strip's place) the Captain's pistol (its reload
//                 ring, "click an enemy"), our fighters' HP pips with their
//                 names (down ones crossed out), the crew's focus (what the
//                 companion ordered: boarding_order), and RALLY (F, once)
//   the cursor    a ring that follows the mouse with the pistol's reload; it
//                 turns red over an enemy (the scene's boardfight.pick), with
//                 a small HP bar over that enemy; the captain wears a name tag
//   explainer     the first fight ever: two lines over the bottom strip
//                 (click an enemy to fire, F rallies once); gone after ~10 s
//                 or the first shot
//   whacky        a whacky captain's intro card (name, title, the taunt), what
//                 their gimmick is doing under their bar (captain.status), and
//                 the speech bubbles over her captain and crew (the scene's
//                 boardfight.bubbles(): text pinned over their heads)
//
// Reads `state.boardfight` (core v4: {enemyId, t, ours[], foes[], captain,
// pistol:{cooldown}, rally:{used}, focus, phase}) and the `boardfight` events
// (start / hit / down / captain / struck / repelled). The Captain's hands go
// out as intents: `pistol {foeId}` and `rally`. Screen positions and picking
// come from the scene's boarding fight (ctx.boardfight, or world.boardfight):
// pick(x, y) → foeId | null and screenPos(foeId) → {x, y, visible}.

import { h, fill, text, flag, prop, show, clamp, num, replay, store, nameOf, crewName, crewColor, gold, ICONS } from "./dom.js";
import * as C from "../core/const.js";
import { ARCHETYPES, CREW_VARIANTS } from "../core/boarding.js";

const SEEN_KEY = "rx-rexmaw-raids-boardfight-seen";
const PISTOL_CD = num(C.BOARDFIGHT?.pistolCooldown ?? C.BOARDFIGHT?.pistol?.cooldown, 1.2);   // s (spec: 1.2 s)
const TITLE_MS = 2600;
const EXPLAIN_MS = 10000;
const FOCUS = { captain: "their captain", crew: "their crew", defend: "holding our ground" };
const KIND = { sailor: "Sailor", gunner: "Gunner", captain: "Captain", monkey: "Monkey", gull: "Gull", mate: "Tiny" };
/** A whacky captain's accent (the bubble's border, the card). */
const ACCENT = { normal: "#e0583c", gulls: "#f0a020", admiral: "#3a5aa8", chef: "#d8b070", pip: "#b8352a", bubbles: "#5ab8e8", encore: "#a050c0",
  clackers: "#e2583a", mime: "#202020", pale: "#7ad8e8" };
const BUBBLE_CSS = `
.nr-bfsay { position: absolute; left: 0; top: 0; max-width: 210px; padding: 4px 10px 5px; border-radius: 13px; pointer-events: none; z-index: 6;
  background: #fffaf0; color: #1b1410; border: 2px solid var(--ac, #1b1410); box-shadow: 0 3px 10px rgba(0,0,0,.45);
  font: 700 .8rem/1.2 var(--nr-sans, system-ui, sans-serif); text-align: center; white-space: normal; overflow-wrap: anywhere; will-change: transform, opacity; }
.nr-bfsay::after { content: ""; position: absolute; left: 50%; bottom: -9px; width: 12px; height: 12px; translate: -50% 0; rotate: 45deg;
  background: #fffaf0; border-right: 2px solid var(--ac, #1b1410); border-bottom: 2px solid var(--ac, #1b1410); }
.nr-bfsay.captain { font-size: .86rem; border-width: 2.5px; }
.nr-bfsay.in { animation: nr-bfsay-in .28s cubic-bezier(.2, 1.7, .4, 1) both; }
@keyframes nr-bfsay-in { from { scale: .4; opacity: 0; } to { scale: 1; opacity: 1; } }
.nr-bfcard[data-kind="whacky"] b { font-size: clamp(1.6rem, 4.4vw, 2.7rem); white-space: normal; max-width: 90vw; }
.nr-bfcard[data-kind="whacky"] span { font-size: 1rem; }
.nr-bfcard[data-kind="whacky"] small { text-transform: none; letter-spacing: .02em; font: italic 600 .95rem var(--nr-serif, serif); color: #fff3c4; max-width: min(560px, 88vw); }
.nr-bfcapstatus { font: italic 600 .68rem var(--nr-serif, serif); color: #ffd28a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
const PISTOL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 7.5h15.5l1.6-1.6h1.9v4.2H11.6l-1.4 1.4.3 1.6-1.9.5-.5-1.4-1.6 1.6-1.8 6.7H1.5l2.6-8.4-1.6-1.6Z"/><circle cx="9.3" cy="12.6" r="1.1" fill="rgba(0,0,0,.45)"/></svg>';

/**
 * @param {object} ctx  the UI context (bus, state(), name(), boardfight? / world.boardfight?)
 * @param {{top: HTMLElement, bottom: HTMLElement, root: HTMLElement}} where
 */
export function createBoarding(ctx, { top, bottom, root }) {
  const { bus } = ctx;
  const BF = () => { try { return ctx.boardfight || ctx.world?.boardfight || null; } catch { return null; } };

  // ---- The title card (also: the captain's arrival, the result) ----------------------------------
  const tcBig = h("b.gilt"), tcSub = h("span"), tcSmall = h("small");
  const card = h("div.nr-bfcard", { hidden: true, role: "status", "aria-live": "polite" }, tcBig, tcSub, tcSmall);
  root.append(card);
  let cardT = 0;
  function titleCard(big, sub = "", small = "", { ms = TITLE_MS, kind = "" } = {}) {
    text(tcBig, big); text(tcSub, sub); text(tcSmall, small);
    card.dataset.kind = kind;
    show(card, true);
    replay(card, "in");
    clearTimeout(cardT);
    cardT = setTimeout(() => show(card, false), ms);
  }

  // ---- The top strip: their captain, the enemies left --------------------------------------------
  const capName = h("b.nr-bfcapname"), capFill = h("i"), capVal = h("small"), capWait = h("small.nr-bfcapwait"), capStatus = h("small.nr-bfcapstatus", { hidden: true });
  const cap = h("div.nr-bfcap", null, h("div.nr-bfcapline", null, h("span.ic", { html: ICONS.skull }), capName, capVal),
    h("span.nr-bfcapbar", null, capFill), capWait, capStatus);
  // The speech bubbles' look (kept with them: they're this module's own).
  if (!document.getElementById("nr-bfsay-css")) document.head.append(h("style#nr-bfsay-css", null, BUBBLE_CSS));
  const sayEls = new Map();
  const foePips = h("span.nr-bffoepips"), foeN = h("b.nr-bffoen");
  const vsName = h("small.nr-bfvs");
  const topBar = h("section.nr-bftop", { hidden: true, role: "group", "aria-label": "The enemy" },
    vsName, cap, h("div.nr-bffoes", { title: "Enemies still standing" }, foePips, foeN));
  top.append(topBar);

  // ---- The bottom strip: pistol, our fighters, focus, rally --------------------------------------
  const pistolRing = h("i.nr-bfpring");
  const pistolNote = h("small");
  const pistol = h("div.nr-bfpistol", { title: `Click an enemy to fire your pistol (${PISTOL_CD} s reload)` },
    h("span.nr-bfpic", null, pistolRing, h("span.ic", { html: PISTOL_SVG })), h("div", null, h("b", null, "Pistol"), pistolNote));
  const ours = h("div.nr-bfours", { role: "group", "aria-label": "Our fighters" });
  const focus = h("div.nr-bffocus");
  const rallyBtn = h("button.nr-bfrally", { type: "button", title: "Rally the crew: a heal and a burst of fury (once per fight)", onclick: () => rally() },
    h("b", null, "Rally"), h("kbd", null, "F"), h("small", null, "once"));
  const deck = h("section.nr-bfdeck", { hidden: true, role: "group", "aria-label": "Boarding" },
    pistol, h("div.nr-bfmid", null, ours, focus), rallyBtn);
  const explain = h("div.nr-bfexplain", { hidden: true, role: "note" });
  bottom.append(explain, deck);

  // ---- The cursor, the hovered enemy, the captain's tag -------------------------------------------
  const curRing = h("i.nr-bfcurring"), curText = h("small");
  const cursor = h("div.nr-bfcursor", { hidden: true, "aria-hidden": "true" }, curRing, curText);
  const hoverTag = h("div.nr-foetag", { hidden: true, "aria-hidden": "true" }, h("small"), h("span.nr-foebar", null, h("i")));
  const capTag = h("div.nr-foetag.captain", { hidden: true, "aria-hidden": "true" }, h("small"), h("span.nr-foebar", null, h("i")));
  root.append(cursor, hoverTag, capTag);

  let snap = null, F = null, fightKey = null, raf = 0, hovered = null, localCdUntil = 0, ralliedFor = null;
  let px = innerWidth / 2, py = innerHeight * 0.5, pointerIn = false;

  const fighting = () => !!F && !snap?.paused && F.phase !== "struck" && F.phase !== "repelled";
  const foeById = (id) => (F?.foes || []).find((f) => f && f.id === id) || null;
  const captainFoe = () => (F?.foes || []).find((f) => f?.kind === "captain") || null;
  const standing = (f) => f && f.state !== "down" && f.state !== "dead" && num(f.hp, 1) > 0;

  /** The pistol's full reload (the core's `pistol.max`, else the spec's 1.2 s). */
  const pistolMax = () => Math.max(0.1, num(F?.pistol?.max, PISTOL_CD));
  /** Seconds the pistol still needs (the core's word, or our own clock since the last click, whichever is longer). */
  function pistolLeft() {
    const core = num(F?.pistol?.cooldown, 0);
    const mine = Math.max(0, (localCdUntil - performance.now()) / 1000);
    return Math.max(core, mine);
  }

  // ---- Explainer (first fight ever) ---------------------------------------------------------------
  let explainT = 0;
  function explainer() {
    if (store.get(SEEN_KEY, false)) return;
    fill(explain, h("span", null, h("b", null, "Click an enemy"), " to fire your pistol · ", h("kbd", null, "F"), " rallies the crew once"),
      h("span", null, `Down their captain and she strikes. The crew fight on their own; ${nameOf(ctx)} can call the focus.`));
    show(explain, true);
    replay(explain, "in");
    clearTimeout(explainT);
    explainT = setTimeout(dismiss, EXPLAIN_MS);
  }
  function dismiss() {
    clearTimeout(explainT);
    if (!explain.hidden) { show(explain, false); store.set(SEEN_KEY, true); }
  }

  // ---- Tick (10 Hz) --------------------------------------------------------------------------------
  function update(s) {
    snap = s || null;
    F = s?.boardfight || null;
    const on = !!F;
    flag(document.body, "nr-fighting", on);
    show(topBar, on);
    show(deck, on);
    if (!on) {
      show(cursor, false); show(hoverTag, false); show(capTag, false); show(explain, false);
      for (const el of sayEls.values()) el.remove();
      sayEls.clear();
      fightKey = null;
      return;
    }
    // A fight we haven't greeted (the start event can land before the HUD's first tick, or not at all).
    const key = `${F.enemyId ?? "?"}`;
    if (key !== fightKey) { fightKey = key; greet(); }
    // Top: who we're boarding, their captain, the enemies left.
    const ship = (s.contacts || []).find((c) => c.id === F.enemyId);
    text(vsName, `Boarding ${F.enemyName || ship?.name || "her"}`);
    const Cp = F.captain || {};
    const cf = captainFoe();
    const capOn = !!Cp.present || !!cf;
    flag(cap, "on", capOn);
    text(capName, capOn ? (Cp.name || cf?.name || "Their captain") : "Their captain");
    const chp = num(Cp.hp ?? cf?.hp, 0), cmax = Math.max(1, num(Cp.max ?? cf?.max, 1));
    prop(capFill, "--p", capOn ? clamp(chp / cmax, 0, 1) : 0);
    text(capVal, capOn ? `${Math.max(0, Math.round(chp))}` : "");
    const foes = (F.foes || []).filter((f) => f && f.kind !== "captain");
    const total = foes.length, up = foes.filter(standing).length;
    text(capWait, capOn ? "" : `on deck once half their crew is down (${Math.max(0, up - Math.floor(total / 2))} more)`);
    show(capWait, !capOn);
    // A whacky captain's gimmick, in a few words (the bubble shield's up, he's singing, Pip's running…).
    const status = capOn ? String(Cp.status || "") : "";
    text(capStatus, status);
    show(capStatus, !!status);
    const sig = foes.map((f) => (standing(f) ? 1 : 0)).join("");
    if (foePips.dataset.sig !== sig) { foePips.dataset.sig = sig; fill(foePips, foes.map((f) => h(`i${standing(f) ? "" : ".down"}`))); }
    const capUp = cf ? standing(cf) : capOn && chp > 0;
    text(foeN, `${Number.isFinite(Number(F.foesLeft)) ? num(F.foesLeft) : up + (capUp ? 1 : 0)} left`);
    // Bottom: our fighters.
    const list = Array.isArray(F.ours) ? F.ours : [];
    const osig = list.map((o) => o?.id).join(",");
    if (ours.dataset.sig !== osig) {
      ours.dataset.sig = osig;
      fill(ours, list.map((o) => h("div.nr-bffighter", { dataset: { id: o.id }, style: `--c:${crewColor(o.id)}` },
        h("small", null, o.id === "me" ? nameOf(ctx) : o.name || crewName(ctx, o.id)), h("span.nr-bfhp", null, h("i")))));
    }
    for (const o of list) {
      const el = ours.querySelector(`[data-id="${CSS.escape(String(o.id))}"]`);
      if (!el) continue;
      const p = clamp(num(o.hp, 0) / Math.max(1, num(o.max, 1)), 0, 1);
      prop(el, "--p", p);
      const down = o.state === "down" || p <= 0;
      if (down && !el.classList.contains("down")) replay(el, "hit");
      flag(el, "down", down);
      flag(el, "low", !down && p < 0.35);
      el.title = `${crewName(ctx, o.id)}: ${down ? "down" : `${Math.round(num(o.hp))}/${Math.round(num(o.max))}`}`;
    }
    // The crew's focus (the companion's boarding_order).
    const fk = F.focus || "captain";
    if (focus.dataset.k !== fk) { focus.dataset.k = fk; fill(focus, h("small", null, "Crew focus"), h("b", null, FOCUS[fk] || fk)); replay(focus, "in"); }
    // Rally.
    const used = !!F.rally?.used || ralliedFor === fightKey;
    rallyBtn.disabled = used || !fighting();
    flag(rallyBtn, "used", used);
    text(rallyBtn.querySelector("small"), used ? "used" : "once");
    // The pistol.
    paintPistol();
    schedule();
  }

  function paintPistol() {
    const left = pistolLeft();
    const p = clamp(1 - left / pistolMax(), 0, 1);
    prop(pistol, "--p", p);
    prop(cursor, "--p", p);
    flag(pistol, "loading", left > 0.05);
    flag(cursor, "loading", left > 0.05);
    text(pistolNote, !fighting() ? "" : F.phase === "grapple" ? "Grapples across…" : left > 0.05 ? `Reloading ${left.toFixed(1)} s` : "Click an enemy");
    text(curText, left > 0.05 ? `${left.toFixed(1)}` : hovered ? "Fire" : "");
  }

  function greet() {
    const name = F.enemyName || (snap?.contacts || []).find((c) => c.id === F.enemyId)?.name || "";
    titleCard("BOARDING", "— take their captain —", name);
    explainer();
  }

  // ---- Every frame while fighting: the cursor, the tags ---------------------------------------------
  function schedule() { if (!raf && F) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (!F) return;
    const live = fighting();
    show(cursor, live && pointerIn);
    if (live && pointerIn) cursor.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
    hovered = live && pointerIn ? pickFoe(px, py, { exact: true }) : null;
    flag(cursor, "hot", !!hovered);
    paintPistol();
    tag(hoverTag, hovered && foeById(hovered)?.kind !== "captain" ? foeById(hovered) : null);
    const cf = captainFoe();
    tag(capTag, cf && standing(cf) ? cf : null, F.captain?.name || cf?.name);
    speech();
    schedule();
  }

  /** The speech bubbles over her captain and crew (the scene says who says what, and where their heads are). */
  function speech() {
    let list = [];
    try { list = BF()?.bubbles?.() || []; } catch { list = []; }
    const seen = new Set();
    const arch = F?.archetype || "normal";
    for (const b of list) {
      if (!b || !b.visible || !Number.isFinite(b.x)) continue;
      const key = String(b.id);
      seen.add(key);
      let el = sayEls.get(key);
      if (!el || el.dataset.text !== b.text) {
        if (!el) { el = h("div.nr-bfsay", { "aria-hidden": "true" }); root.append(el); sayEls.set(key, el); }
        el.dataset.text = b.text;
        text(el, b.text);
        flag(el, "captain", !!b.captain);
        el.style.setProperty("--ac", b.captain ? ACCENT[arch] || ACCENT.normal : "#1b1410");
        replay(el, "in");
      }
      const fade = clamp((num(b.dur, 2) - num(b.age, 0)) / 0.3, 0, 1);
      el.style.opacity = String(fade);
      el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y - 14)}px) translate(-50%, -100%)`;
    }
    for (const [k, el] of sayEls) if (!seen.has(k)) { el.remove(); sayEls.delete(k); }
  }

  /** A small bar over an enemy (their kind or the captain's name, their HP), at the scene's spot for them. */
  function tag(el, foe, name = null) {
    if (!foe) { show(el, false); return; }
    let p = null;
    try { p = BF()?.screenPos?.(foe.id) || null; } catch { p = null; }
    if (!p || !p.visible || !Number.isFinite(p.x)) { show(el, false); return; }
    show(el, true);
    text(el.firstChild, name || (foe.kind === "mate" ? foe.name : null) || (foe.look && CREW_VARIANTS[foe.look]?.label) || KIND[foe.kind] || "Enemy");
    prop(el, "--p", clamp(num(foe.hp, 0) / Math.max(1, num(foe.max, 1)), 0, 1));
    el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
  }

  /** The enemy under the pointer: the scene's pick; without one, the captain or the first enemy standing. */
  function pickFoe(x, y, { exact = false } = {}) {
    const api = BF();
    if (typeof api?.pick === "function") {
      let got = null;
      try { got = api.pick(x, y); } catch { got = null; }
      const id = got && typeof got === "object" ? got.foeId ?? got.id ?? null : got;
      const f = id != null ? foeById(id) : null;
      return f && standing(f) ? f.id : null;
    }
    if (exact) return null;
    const cf = captainFoe();
    if (cf && standing(cf)) return cf.id;
    return (F?.foes || []).find(standing)?.id || null;
  }

  // ---- The Captain's hands -------------------------------------------------------------------------
  /** A click on the deck: the pistol at the enemy under it. True when the fight took the click. */
  function click(x, y) {
    if (!fighting()) return false;
    px = x; py = y; pointerIn = true;
    if (F.phase === "grapple") { replay(cursor, "nope"); popAt(x, y, "The grapples are still flying", "note"); return true; }
    if (pistolLeft() > 0.05) { replay(cursor, "nope"); return true; }
    const id = pickFoe(x, y);
    if (!id) { replay(cursor, "nope"); popAt(x, y, "Click an enemy", "note"); return true; }
    bus.intent("pistol", { foeId: id });
    localCdUntil = performance.now() + pistolMax() * 1000;
    replay(cursor, "fired");
    dismiss();
    paintPistol();
    return true;
  }
  function rally() {
    if (!fighting()) return false;
    if (F.rally?.used || ralliedFor === fightKey) { replay(rallyBtn, "nope"); return true; }
    ralliedFor = fightKey;
    bus.intent("rally");
    replay(rallyBtn, "sent");
    flag(rallyBtn, "used", true);
    rallyBtn.disabled = true;
    return true;
  }

  function popAt(x, y, msg, kind = "") {
    const p = h(`div.nr-pop.at${kind ? `.${kind}` : ""}`, null, msg);
    p.style.left = `${Math.round(x)}px`; p.style.top = `${Math.round(y)}px`;
    root.append(p);
    setTimeout(() => p.remove(), 1900);
  }
  function popOnFoe(id, msg, kind) {
    let p = null;
    try { p = BF()?.screenPos?.(id) || null; } catch { p = null; }
    if (p?.visible && Number.isFinite(p.x)) popAt(p.x, p.y - 10, msg, kind);
    else popAt(px, py - 24, msg, kind);
  }

  addEventListener("pointermove", (e) => {
    px = e.clientX; py = e.clientY;
    pointerIn = !!(e.target instanceof Element && (e.target.closest("#stage") || e.target === document.body));
    if (F) schedule();
  });
  document.addEventListener("pointerleave", () => { pointerIn = false; });

  // ---- Events --------------------------------------------------------------------------------------
  /** What a fight event says (the reward on a strike, the reason on a repel). */
  function lootLine(p = {}) {
    const parts = [];
    const g = num(p.gold ?? p.loot?.gold ?? (typeof p.loot === "number" ? p.loot : NaN), NaN);
    if (Number.isFinite(g) && g > 0) parts.push(`+${gold(g)} gold`);
    for (const [k, v] of Object.entries(p.ammo || p.loot?.ammo || {})) if (num(v) > 0) parts.push(`+${Math.round(num(v))} ${k}`);
    return parts.join(" · ");
  }
  const offs = [
    bus.on("boardfight", (p = {}) => {
      const st = String(p.stage || "");
      if (st === "start") { fightKey = `${p.enemyId ?? F?.enemyId ?? "?"}`; titleCard("BOARDING", "— take their captain —", p.enemyName || p.name || ""); explainer(); }
      else if (st === "captain") {
        const A = ARCHETYPES[p.archetype];
        // A whacky captain gets a proper entrance: the name, the title, the taunt.
        if (A && p.archetype !== "normal") titleCard(p.name || A.name, A.title || "", A.taunt ? `“${A.taunt}”` : "", { ms: 3600, kind: "whacky" });
        else titleCard("Their captain!", p.name || F?.captain?.name || "", "Down the captain and she strikes", { ms: 2000, kind: "captain" });
        replay(cap, "in");
      }
      else if (st === "hit" && (p.by === "pistol" || p.by === "captain_pistol" || p.by === "user")) popOnFoe(p.foeId ?? p.target ?? p.id, `−${Math.round(num(p.dmg))}`, "hit");
      else if (st === "down" && (p.by === "pistol" || p.by === "user") && (p.foeId ?? p.id)) popOnFoe(p.foeId ?? p.id, "Down!", "gold");
      else if (st === "struck") {
        dismiss();
        const extra = [p.prize?.item ? `+ ${p.prize.item}` : "", num(p.stolen, 0) > 0 ? `monkeys pinched ${gold(p.stolen)}` : ""].filter(Boolean).join(" · ");
        titleCard("She strikes!", lootLine(p) || "The prize is yours", extra || p.name || F?.enemyName || "", { ms: 3600, kind: "won" });
      }
      else if (st === "repelled") {
        dismiss();
        const lost = Math.round(num(p.handsLost, 0));
        titleCard("Repelled", "They cut the grapples", lost > 0 ? `Our crew are back aboard · ${lost} hand${lost === 1 ? "" : "s"} lost` : "Our crew are back aboard, bruised", { ms: 3600, kind: "lost" });
      }
    }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { show(card, false); dismiss(); } }),
  ];

  return {
    el: deck, update,
    /** A fight is on (the HUD hides the helm strip, the compass, the reticle and the tags). */
    active: () => !!F,
    fighting,
    click, rally,
    dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); cancelAnimationFrame(raf); },
  };
}
