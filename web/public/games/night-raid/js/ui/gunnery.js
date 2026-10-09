// The Captain's guns on the glass (v2 spec §3, Black Flag style).
//
//   centre        the reticle: it follows the weapon the look picks (chain
//                 ahead, broadsides to the sides, barrels astern, the mortar
//                 ring), turns red when the arcs would hit a ship, dims and
//                 shows its reload arc while the guns are loading, and says
//                 what to do ("Hold RMB / Q to aim · click to fire"). Hit
//                 markers flash on it; damage numbers float off the ship hit.
//                 v4: with a target locked (Tab / right-click) the reticle
//                 names her under its words ("▢ Sea Wren · 320 m"), gilt when
//                 the arcs are on her. (v3's bar over the target ship is gone:
//                 the floating ship tags, ui/shiptags.js, carry her name and
//                 hull now.)
//   bottom centre the gun deck: the port and starboard reload bars either side
//                 of the weapon badge (its ammo and reload), the other
//                 weapons' counts, mortar mode (M), the sails (W/S), speed and
//                 the wind bar for the sprint (Shift), and BRACE (Space).
//
// Reads the 10 Hz tick (state.gunnery, state.reload, ship.ammo, ship.sprint)
// and, every frame while the guns are live, the core's aim preview through
// ctx.aimPreview(look) when main provides it (the arcs themselves are the
// scene's to draw on the water).

import { h, fill, text, flag, prop, clamp, num, replay, contactName, WEAPONS, ICONS, reducedMotion, dist, reticlePoint, lockOf } from "./dom.js";

const SAILS = ["Furled", "Half", "Full"];
const ICON_OF = { broadside: "cannon", heavy: "cannon", chain: "chain", mortar: "mortar", barrels: "barrel", swivel: "swivel", none: "cannon" };
const RELOAD_KEY = { broadside: null, heavy: null, chain: "bow", mortar: "mortar", barrels: "barrels", swivel: "swivel" };
const AMMO_KEY = { chain: "chain", mortar: "mortar", barrels: "barrels" };
const PREVIEW_MS = 33;

/**
 * @param {object} ctx  the UI context (bus, state(), world?, aimPreview?)
 * @param {{reticle: HTMLElement, deck: HTMLElement, root: HTMLElement, input: () => object}} where
 */
export function createGunnery(ctx, { reticle: rParent, deck: dParent, root, input }) {
  const { bus } = ctx;

  // ---- The reticle ----------------------------------------------------------------------
  const ring = h("i.nr-rring", { "aria-hidden": "true" });
  const glyph = h("span.nr-rglyph", { "aria-hidden": "true" });
  const rLabel = h("b.nr-rlabel");
  const rHint = h("small.nr-rhint");
  const hitX = h("i.nr-hitx", { "aria-hidden": "true" });
  const rLock = h("span.nr-rlock");
  const reticle = h("div.nr-reticle", { "aria-hidden": "true" }, ring, glyph, hitX, h("div.nr-rtext", null, rLabel, rHint, rLock));
  rParent.append(reticle);

  // ---- The gun deck --------------------------------------------------------------------------
  const side = (key, label) => {
    const fillEl = h("i"), lbl = h("small", null, label), secs = h("b");
    const el = h(`div.nr-side.${key}`, { title: `${label} battery reload` }, lbl, h("span.nr-reload", null, fillEl), secs);
    return { el, fill: fillEl, secs, was: 1 };
  };
  const port = side("port", "Port"), stbd = side("starboard", "Starboard");
  const wIcon = h("span.nr-wicon"), wName = h("b.nr-wname"), wAmmo = h("small.nr-wammo"), wRing = h("i.nr-wring");
  const badge = h("div.nr-wbadge", null, wRing, wIcon, h("div.nr-wtext", null, wName, wAmmo));
  const others = h("div.nr-wothers");
  const mortarMode = h("button.nr-mmode", { type: "button", title: "Mortar mode (M)", onclick: () => input()?.toggleMortar?.() }, h("span", { html: ICONS.mortar }), h("kbd", null, "M"));
  const sails = h("div.nr-sails", { role: "group", "aria-label": "Sails (W / S)" });
  SAILS.forEach((name, i) => sails.append(h("button.nr-notch", { type: "button", dataset: { i: String(i) }, title: `${name} sail`, onclick: () => bus.intent("sail", { set: i }) }, h("i"), h("small", null, name))));
  const speed = h("b.nr-speed");
  const windFill = h("i");
  const windBar = h("span.nr-windbar", { title: "Sprint wind (hold Shift at full sail)" }, h("span", { html: ICONS.wind }), h("span.nr-wbar", null, windFill), h("kbd", null, "Shift"));
  const braceBtn = h("button.nr-bracebtn", { type: "button", title: "Brace for impact (Space)" }, h("span.nr-bracering"), h("b", null, "Brace"), h("kbd", null, "Space"));
  braceBtn.addEventListener("click", () => { bus.intent("brace"); replay(braceBtn, "sent"); });
  const deck = h("section.nr-deck", { role: "group", "aria-label": "Guns and sails" },
    h("div.nr-deckrow.guns", null, port.el, badge, stbd.el),
    h("div.nr-deckrow.helm", null, sails, h("span.nr-kit", null, others, mortarMode), h("span.nr-speedbox", null, speed, windBar), braceBtn));
  dParent.append(deck);

  // ---- State --------------------------------------------------------------------------------
  let snap = null, preview = null, lastPreview = 0, raf = 0, swivelOn = false;
  let aimingSince = 0;

  function weaponNow() {
    const g = snap?.gunnery || {};
    const w = preview?.weapon || g.weapon || "none";
    const s = preview?.side ?? g.side ?? null;
    // v5: laid on the Kraken's eye (locked while it's up) counts as aimed: a plain click fires that lay.
    const onEye = !!preview?.snapped && lockOf(snap) === "kraken_eye";
    return { w, side: s, aiming: onEye || (preview ? !!preview.aiming : !!g.aiming), ready: preview ? preview.ready !== false : g.ready !== false };
  }

  function reloadOf(w, s) {
    const r = snap?.reload || {};
    if (w === "broadside" || w === "heavy") return num(r[s === "port" ? "port" : "starboard"], 1);
    const k = RELOAD_KEY[w];
    return k ? num(r[k], 1) : 1;
  }
  function ammoOf(w) {
    const k = AMMO_KEY[w];
    if (!k) return null;
    const a = snap?.ship?.ammo || {};
    return Number.isFinite(Number(a[k])) ? Math.max(0, Math.round(Number(a[k]))) : null;
  }

  // ---- Tick (10 Hz) -------------------------------------------------------------------------------
  function update(s) {
    snap = s;
    const ship = s?.ship || {};
    const r = s?.reload || {};
    for (const [b, key] of [[port, "port"], [stbd, "starboard"]]) {
      const v = clamp(num(r[key], 1), 0, 1);
      prop(b.el, "--p", v);
      const left = num(s?.reloadS?.[key], NaN);
      text(b.secs, v >= 0.999 ? "Ready" : Number.isFinite(left) ? `${left.toFixed(1)} s` : `${Math.round(v * 100)} %`);
      flag(b.el, "ready", v >= 0.999);
      if (v >= 0.999 && b.was < 0.999) replay(b.el, "loaded");
      b.was = v;
      const live = s?.ship?.guns?.[key];
      flag(b.el, "down", !!live && num(live.live, 1) <= 0);
    }
    // The other weapons' counts.
    const ammo = ship.ammo || {};
    const sig = `${ammo.chain}|${ammo.mortar}|${ammo.barrels}|${clamp(num(r.bow, 1), 0, 1).toFixed(1)}|${clamp(num(r.mortar, 1), 0, 1).toFixed(1)}|${clamp(num(r.barrels, 1), 0, 1).toFixed(1)}`;
    if (others.dataset.sig !== sig) {
      others.dataset.sig = sig;
      fill(others, [["chain", "Chain", "bow"], ["mortar", "Mortar", "mortar"], ["barrels", "Barrels", "barrels"]].map(([k, label, rk]) => {
        const n = Number.isFinite(Number(ammo[k])) ? Math.max(0, Math.round(Number(ammo[k]))) : null;
        return h(`span.nr-wother.${k}${n === 0 ? ".out" : ""}`, { dataset: { w: k }, style: `--p:${clamp(num(r[rk], 1), 0, 1)}`, title: `${WEAPONS[k].label}: ${WEAPONS[k].look}` },
          h("span.ic", { html: ICONS[ICON_OF[k]] }), h("small", null, label), h("b", null, n == null ? "—" : String(n)));
      }));
    }
    flag(mortarMode, "on", s?.gunnery?.mode === "mortar" || input()?.look?.().mode === "mortar");
    // Sails, speed, the sprint bar.
    const sail = clamp(Math.round(num(ship.sail)), 0, 2);
    [...sails.children].forEach((b, i) => { flag(b, "on", i <= sail); flag(b, "now", i === sail); });
    text(speed, `${(num(ship.speed) * 1.94384).toFixed(0)} kn`);
    const sp = ship.sprint || {};
    prop(windBar, "--p", clamp(num(sp.wind, 1), 0, 1));
    flag(windBar, "on", !!sp.on);
    flag(windBar, "low", num(sp.wind, 1) < 0.15);
    flag(windBar, "avail", sail === 2);
    flag(deck, "sprint", !!sp.on);
    const bT = num(ship.braceT);
    flag(braceBtn, "braced", bT > 0);
    prop(braceBtn, "--p", clamp(bT / 1.2, 0, 1));
    paint();
    schedule();
  }

  // ---- Frame (the preview, the reticle, the target bar) --------------------------------------------
  const liveNow = () => snap && snap.phase === "sailing" && !snap.paused;
  function schedule() { if (!raf && liveNow()) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    if (!liveNow()) return;
    if (now - lastPreview > PREVIEW_MS && typeof ctx.aimPreview === "function") {
      lastPreview = now;
      try { preview = ctx.aimPreview(input()?.lookPayload?.() || undefined) || null; } catch { preview = null; }
    }
    paint();
    schedule();
  }

  function paint() {
    if (!snap) return;
    const { w, side: sd, aiming, ready } = weaponNow();
    const look = input()?.look?.() || {};
    const reload = reloadOf(w, sd);
    const ammo = ammoOf(w);
    const empty = ammo === 0;
    // The badge.
    const iconKey = ICON_OF[w] || "cannon";
    if (wIcon.dataset.k !== iconKey) { wIcon.dataset.k = iconKey; wIcon.innerHTML = ICONS[iconKey]; }
    const label = w === "broadside" && sd ? `${sd === "port" ? "Port" : "Starboard"} broadside` : w === "heavy" && sd ? `Heavy · ${sd === "port" ? "port" : "starboard"}` : WEAPONS[w]?.label || "";
    text(wName, label || "Guns");
    text(wAmmo, w === "none" ? "" : ammo == null ? "∞ round shot" : empty ? "none left" : `${ammo} left`);
    prop(badge, "--p", clamp(reload, 0, 1));
    flag(badge, "loading", reload < 0.999);
    flag(badge, "empty", empty);
    badge.dataset.w = w;
    for (const el of others.children) flag(el, "now", el.dataset.w === w);
    flag(port.el, "now", (w === "broadside" || w === "heavy") && sd === "port");
    flag(stbd.el, "now", (w === "broadside" || w === "heavy") && sd === "starboard");
    // The reticle.
    const hit = !!preview?.hit;
    reticle.dataset.w = w;
    reticle.dataset.side = sd || "";
    flag(reticle, "aiming", aiming);
    flag(reticle, "hit", hit && aiming);
    flag(reticle, "loading", (reload < 0.999 || empty) && (aiming || w !== "chain"));
    flag(reticle, "swivel", swivelOn);
    prop(reticle, "--p", clamp(reload, 0, 1));
    const range = num(preview?.range ?? snap.gunnery?.range, NaN);
    // The how-to words show until the Captain has done the thing once (v3 §C12: no permanent hints).
    const knows = (k) => !!input()?.learned?.(k);
    const teach = (k, words) => (knows(k) ? "" : words);
    let lab = "", hint = "";
    if (swivelOn) { lab = "Swivel gun"; hint = "Click the weak point"; }
    // Looking ahead is mostly just looking ahead: the bow chasers speak up once the Captain aims them (as the broadsides do).
    else if (w === "chain" && !aiming) hint = teach("aim", "Hold right mouse or Q to aim");
    else if (empty) { lab = WEAPONS[w]?.label || ""; hint = "None left: crates and captures resupply"; }
    else if (reload < 0.999) { lab = label; hint = "Reloading…"; }
    else if (w === "broadside") { lab = aiming ? `${Number.isFinite(range) ? dist(range) : ""}` : ""; hint = aiming ? (hit ? "On target" + teach("aimfire", " · click to fire") : teach("aimfire", "Cursor higher for range · click to fire")) : teach("aim", "Hold right mouse or Q to aim"); }
    else if (w === "heavy") { lab = preview?.targetId ? "Heavy shot" : ""; hint = preview?.targetId ? "Point blank" + teach("fire", " · click to fire") : teach("aim", "Hold right mouse or Q to aim"); }
    else if (w === "chain") { lab = Number.isFinite(range) ? `Chain · ${dist(range)}` : "Chain shot"; hint = hit ? "On her rigging" : teach("aimfire", "Click to fire the bow chasers"); }
    else if (w === "mortar") { lab = `Mortar${Number.isFinite(range) ? ` · ${dist(range)}` : ""}`; hint = teach("fire", look.mode === "mortar" ? "Point at the sea, click to fire · screen edges turn the view · M to put it away" : "A far target: click to fire"); }
    else if (w === "barrels") { lab = "Fire barrels"; hint = teach("fire", "Click to drop them astern"); }
    text(rLabel, lab);
    text(rHint, hint);
    // The locked target, by name: the arcs snap to her (core v4); gilt when they're on her.
    const lockId = lockOf(snap);
    // v5: the Kraken's eye (locked while it's up) isn't a contact: its name and range come from state.lock.
    const lc = lockId === "kraken_eye" ? (typeof snap.lock === "object" ? snap.lock : null) : lockId ? (snap.contacts || []).find((c) => c.id === lockId) : null;
    text(rLock, lc ? `${lockId === "kraken_eye" ? lc.name : contactName(lc, { article: false })} · ${dist(num(lc.dist, NaN))}` : "");
    flag(rLock, "on", !!lc && (!!preview?.snapped || (!!preview?.targetId && preview.targetId === lockId)));
    flag(reticle, "quiet", !lab && !hint && !lc);
    if (aiming && !aimingSince) aimingSince = performance.now();
    if (!aiming) aimingSince = 0;
    void ready;
  }

  // ---- Hit markers and damage numbers ----------------------------------------------------------------
  const pending = new Map();   // target id → {dmg, timer}
  function hitMarker(p) {
    replay(hitX, "go");
    if (!reducedMotion()) replay(reticle, "kick");
    const key = p.target || "?";
    const acc = pending.get(key) || { dmg: 0, raking: false, timer: 0, x: p.x, y: p.y, z: p.z };
    acc.dmg += num(p.dmg);
    acc.raking = acc.raking || !!p.raking;
    clearTimeout(acc.timer);
    acc.timer = setTimeout(() => { pending.delete(key); damageNumber(key, acc); }, 260);
    pending.set(key, acc);
  }
  function damageNumber(id, acc) {
    if (acc.dmg < 0.5) return;
    let p = null;
    try { p = ctx.world?.screenPos?.(id, { lift: 10 }) || null; } catch { p = null; }
    const r = reticlePoint(), at = p && p.visible ? p : { x: r.x + 40, y: r.y - 30 };
    const n = h(`div.nr-dmg${acc.raking ? ".raking" : ""}${acc.dmg >= 25 ? ".big" : ""}`, null, `${Math.round(acc.dmg)}`, acc.raking ? h("small", null, " raking") : null);
    n.style.left = `${Math.round(at.x + (Math.random() - 0.5) * 30)}px`;
    n.style.top = `${Math.round(at.y)}px`;
    root.append(n);
    setTimeout(() => n.remove(), 1300);
  }

  const offs = [
    bus.on("impact", (p = {}) => { if ((p.from === "rexmaw" || p.by === "rexmaw") && p.target && p.target !== "rexmaw" && p.kind !== "splash") hitMarker(p); }),
    bus.on("dry_fire", (p = {}) => {
      replay(reticle, "nope");
      const why = p.reason === "empty" ? "None left" : p.reason === "reloading" ? "Still loading" : "Nothing bears";
      text(rHint, why);
    }),
    bus.on("volley", (p = {}) => { if (p.by === "rexmaw" && p.firedBy !== "crew") { replay(reticle, "fired"); } }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "moored") { preview = null; pending.clear(); } schedule(); }),
    bus.on("look", () => schedule()),
  ];

  return {
    update,
    /** The scene says the cursor's on a glowing weak point (the swivel takes the click). */
    swivelHint(on) { if (swivelOn !== !!on) { swivelOn = !!on; paint(); } },
    fired() { replay(badge, "kick"); },
    preview: () => preview,
    el: deck, reticle,
    dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); cancelAnimationFrame(raf); },
  };
}
