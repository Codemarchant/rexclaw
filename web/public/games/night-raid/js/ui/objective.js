// The objective on the glass (v3 §A1, §A3; v4 §2: compact): what to do next
// and how not to lose, always in the same place.
//
//   strip       top centre, ONE line: the step ("2/3"), its instruction, the
//               distance and compass word to it, the clock. When the step
//               changes (and when sailing starts) it opens for ~4 s to show
//               the mission's name, the hint, the chain (done ticked, the
//               current one lit) and the bonus, then folds back to the line.
//               Hovering it opens it too.
//   fail chips  under it, small, and only once a counter is at 50 % or more
//               (`state.objective.fail`): "Spotted 2/3" with its bar; amber
//               from 50 %, red and pulsing from 85 %. Crossing a level
//               (`objective {stage:"warn"}`) kicks the chip and puts the line
//               up as a warning (the crew bark is audio/barks.js's).
//   arrow       the current step's marker (`state.objective.marker`): when it is
//               off screen, a gilt arrow inside the screen's edge pointing at it
//               with the distance and its name; on screen the scene's pillar /
//               chevron carries its own name and distance.
//
// Reads `state.objective` (core v3) and falls back to v2's `state.mission.objectives`.

import { h, fill, text, flag, show, prop, clamp, num, replay, clock, angleDiff, bearingTo, point8, dist as metres, MISSIONS, ICONS, reticlePoint, seaBand } from "./dom.js";

const OPEN_MS = 4000;   // the strip stays open this long after a step changes (spec §2: ~4 s)

/** The objective in one shape (core v3, or v2's objectives list as a fallback). */
export function readObjective(s) {
  const o = s?.objective;
  if (o && typeof o === "object") {
    return {
      step: num(o.step, 1), of: num(o.of, (o.steps || []).length || 1), status: o.status || "active",
      instruction: o.instruction || o.text || "", text: o.text || o.instruction || "", hint: o.hint || "",
      count: o.count, need: o.need, marker: o.marker || null, steps: Array.isArray(o.steps) ? o.steps : [],
      bonus: o.bonus || null, fail: Array.isArray(o.fail) ? o.fail : [],
    };
  }
  const objs = Array.isArray(s?.mission?.objectives) ? s.mission.objectives : [];
  if (!objs.length) return null;
  const cur = objs.find((x) => !x.done && !x.failed && !x.optional) || objs[objs.length - 1];
  return {
    step: Math.max(1, objs.indexOf(cur) + 1), of: objs.length, status: s?.mission?.status || "active",
    instruction: cur?.text || "", text: cur?.text || "", hint: "", count: cur?.count, need: cur?.of > 1 ? cur.of : null, marker: null,
    steps: objs.filter((x) => !x.optional).map((x) => ({ id: x.id, text: x.text, done: !!x.done, active: x === cur })), bonus: null, fail: [],
  };
}

const LEVEL = (frac, warn) => (num(warn) >= 0.85 || num(frac) >= 0.85 ? 2 : num(warn) >= 0.5 || num(frac) >= 0.5 ? 1 : 0);

/**
 * @param {object} ctx  the UI context
 * @param {{banner: HTMLElement, root: HTMLElement, input: () => object}} where
 */
export function createObjective(ctx, { banner: parent, root, input }) {
  const { bus } = ctx;

  // ---- The strip (one line; it opens for a few seconds on a new step) ----------------------
  const mLabel = h("b.nr-oblabel"), mTime = h("span.nr-obtime");
  const stepNo = h("span.nr-obstep"), stepText = h("b.nr-obtext"), stepWhere = h("span.nr-obwhere"), stepHint = h("small.nr-obhint");
  const jobClock = h("span.nr-objob");   // v5 free roam: the side job's clock (objective.bonus.left)
  const chain = h("ol.nr-obchain", { "aria-label": "The steps" });
  const bonus = h("div.nr-obbonus", { hidden: true });
  const fails = h("div.nr-obfails", { role: "group", "aria-label": "How you could lose" });
  const more = h("div.nr-obmore", null, h("div.nr-obhead", null, h("span.ic.nr-obic"), mLabel), stepHint, chain, bonus);
  const el = h("section.nr-objective", { hidden: true, role: "status", "aria-live": "polite", "aria-label": "Objective" },
    h("div.nr-obline", null, stepNo, stepText, stepWhere, jobClock, mTime), more);
  // v5 Kraken's Wake: the boss bar under the strip (the Kraken's wounds, this surfacing's hurt toward the next wound, when
  // it dives or rises) and a small tag over the eye while it's up.
  const bossPips = h("span.nr-bosspips"), bossNote = h("small.nr-bossnote"), bossFill = h("i");
  const boss = h("section.nr-boss", { hidden: true, role: "group", "aria-label": "The Kraken" },
    h("div.nr-bossline", null, h("span.ic", { html: ICONS.skull }), h("b.nr-bossname", null, "The Kraken"), bossPips, bossNote),
    h("span.nr-bossbar", null, bossFill));
  // (No range on it: the scene's step marker over the eye says how far.)
  const eyePips = h("span.nr-bosspips"), eyeHp = h("i");
  const eyeTag = h("div.nr-tag.boss.danger.nr-eyetag", { hidden: true, "aria-hidden": "true" },
    h("div.nr-tagline", null, h("span.nr-tagname", null, "The Kraken"), eyePips), h("span.nr-taghull", null, eyeHp));
  parent.append(el, boss, fails);
  root.append(eyeTag);
  let openT = 0, hovering = false;
  /** Open the strip for `ms` (it folds back to its one line after). */
  function open(ms = OPEN_MS) {
    flag(el, "open", true);
    clearTimeout(openT);
    openT = setTimeout(() => { if (!hovering) flag(el, "open", false); }, ms);
  }
  el.addEventListener("pointerenter", () => { hovering = true; flag(el, "open", true); clearTimeout(openT); });
  el.addEventListener("pointerleave", () => { hovering = false; open(900); });

  // ---- The edge arrow ---------------------------------------------------------------------------
  const arrowDist = h("b"), arrowLabel = h("small");
  // An arrow with a shaft (a bare triangle reads the wrong way round at most angles).
  const point = h("span.nr-obpoint", { html: '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0-11 7.5-2.5H2.6V10H-2.6V-2.5H-7.5Z"/></svg>' });
  const arrow = h("div.nr-obarrow", { hidden: true, "aria-hidden": "true" }, point, h("span.nr-obarrowtext", null, arrowDist, arrowLabel));
  root.append(arrow);

  let snap = null, raf = 0, stepSig = "", failSig = "", stepKey = "";
  const levels = new Map();   // fail id → level shown (0/1/2)

  /** "420 m NE" to the step's marker (its own numbers, else from the ship to it). */
  function whereTo(s, mk) {
    if (!mk) return "";
    const ship = s.ship;
    let x = mk.x, z = mk.z;
    if (mk.kind === "ship" && mk.contactId) { const c = (s.contacts || []).find((k) => k.id === mk.contactId); if (c && Number.isFinite(c.x)) { x = c.x; z = c.z; } }
    const has = ship && Number.isFinite(x) && Number.isFinite(z);
    const d = num(mk.dist, has ? Math.hypot(x - ship.x, z - ship.z) : NaN);
    const word = mk.compass || (Number.isFinite(mk.bearing) ? point8(mk.bearing) : has ? point8(bearingTo(ship.x, ship.z, x, z)) : "");
    return Number.isFinite(d) ? `${metres(d)}${word ? ` ${word}` : ""}` : word;
  }

  function update(s) {
    snap = s;
    const live = s && (s.phase === "sailing" || s.phase === "boarding" || s.phase === "ending");
    const O = live ? readObjective(s) : null;
    show(el, !!O);
    flag(document.body, "nr-has-objective", !!O);
    paintBoss(O ? s.objective?.eye : null, s);
    if (!O) { show(fails, false); show(arrow, false); stepKey = ""; return; }
    // The mission and its clock.
    const m = MISSIONS[s.mission?.id] || {};
    text(mLabel, s.mission?.label || m.label || "");
    const ic = el.querySelector(".nr-obic");
    const icon = (m.time || s.mission?.time) === "night" ? "moon" : "sun";
    if (ic.dataset.k !== icon) { ic.dataset.k = icon; ic.innerHTML = ICONS[icon]; }
    const left = num(s.mission?.timeLeft, NaN);
    text(mTime, Number.isFinite(left) ? clock(left) : "");
    flag(mTime, "late", Number.isFinite(left) && left <= 60);
    // The step, on one line, with the way to it.
    text(stepNo, O.of > 1 ? `${O.step}/${O.of}` : "Goal");
    stepNo.title = O.of > 1 ? `Step ${O.step} of ${O.of}` : "Objective";
    const count = Number.isFinite(O.need) && O.need > 1 ? ` (${Math.min(num(O.count), O.need)}/${O.need})` : "";
    text(stepText, `${O.text}${count && !O.text.includes(`/${O.need}`) ? count : ""}`);
    el.title = O.text || "";
    // (The core's own step text often ends "— 510 m NE" already: then the strip doesn't say it twice.)
    text(stepWhere, /\d\s?k?m\b/.test(O.text) ? "" : whereTo(s, O.marker));
    text(stepHint, O.hint);
    // A new step (or the first look at it): open for a few seconds.
    // (Keyed on the instruction: the text's "— 270 m W" tail changes every 10 m she sails.)
    const key = `${s.mission?.id}|${O.step}|${O.of}|${O.instruction}`;
    if (key !== stepKey) { stepKey = key; open(); }
    flag(el, "done", O.status === "success");
    flag(el, "failed", O.status === "fail");
    // The chain.
    const sig = JSON.stringify(O.steps.map((x) => [x.id, x.done, x.active, x.text]));
    if (sig !== stepSig) {
      const prev = new Map([...chain.children].map((li) => [li.dataset.id, li.classList.contains("done")]));
      stepSig = sig;
      fill(chain, O.steps.map((x, i) => {
        const li = h(`li.nr-obdot${x.done ? ".done" : ""}${x.active ? ".now" : ""}`, { dataset: { id: x.id ?? String(i) }, title: x.text || "" }, h("i.nr-check"), h("span", null, x.text || ""));
        if (x.done && prev.get(String(x.id ?? i)) === false) li.classList.add("flash");
        return li;
      }));
    }
    // The bonus.
    show(bonus, !!O.bonus);
    if (O.bonus) {
      const b = O.bonus;
      const key = `${b.text}|${b.done}|${b.failed}`;
      if (bonus.dataset.k !== key) {
        bonus.dataset.k = key;
        fill(bonus, h("span.ic", { html: ICONS.star }), h("span", null, h("small", null, "Bonus "), b.text || ""), b.reward ? h("em", null, ` · ${b.reward}`) : null);
        flag(bonus, "done", !!b.done); flag(bonus, "failed", !!b.failed);
      }
    }
    // v5: a side job on the clock (free roam's jobs, 170 s each) shows its time left on the one line.
    const jobLeft = O.bonus && !O.bonus.done && !O.bonus.failed ? num(O.bonus.left, NaN) : NaN;
    text(jobClock, Number.isFinite(jobLeft) ? `Side job ${clock(jobLeft)}` : "");
    jobClock.title = Number.isFinite(jobLeft) ? `${O.bonus.text || "Side job"}${O.bonus.reward ? ` (${O.bonus.reward})` : ""}` : "";
    flag(jobClock, "late", Number.isFinite(jobLeft) && jobLeft <= 30);
    flag(document.body, "nr-sidejob", Number.isFinite(jobLeft));
    // The fail counters.
    paintFails(O.fail);
    schedule();
  }

  /** The boss bar: wounds as pips, this surfacing's hurt (hp 1 → 0 toward the next wound), and what it's doing. */
  function paintBoss(E, s) {
    show(boss, !!E);
    if (!E) return;
    const need = Math.max(1, num(E.need, 3)), wounds = clamp(num(E.wounds), 0, need);
    const pipSig = `${wounds}/${need}`;
    if (bossPips.dataset.k !== pipSig) {
      const kick = bossPips.dataset.k != null;
      bossPips.dataset.k = pipSig; eyePips.dataset.k = pipSig;
      const pips = () => Array.from({ length: need }, (_, i) => h(`i${i < wounds ? ".hit" : ""}`));
      fill(bossPips, pips()); fill(eyePips, pips());
      bossPips.title = `${wounds} of ${need} wounds`;
      if (kick) replay(boss, "kick");
    }
    const up = E.stage === "up" || E.stage === "rise";
    prop(boss, "--p", clamp(num(E.hp, 1), 0, 1));
    flag(boss, "under", !up);
    // (The step's marker sits on the eye: its range and compass word, so the bar and the strip agree.)
    const mk = s?.objective?.marker, ship = s?.ship;
    const where = mk && Number.isFinite(mk.dist) ? `${metres(mk.dist)}${mk.compass ? ` ${mk.compass}` : ""}`
      : ship && Number.isFinite(E.x) ? `${metres(Math.hypot(E.x - ship.x, E.z - ship.z))} ${point8(bearingTo(ship.x, ship.z, E.x, E.z))}` : "";
    const riseIn = num(E.riseIn, NaN);
    text(bossNote, E.stage === "up" ? `${where} · dives in ${Math.ceil(num(E.upLeft))} s`
      : E.stage === "rise" ? `surfacing ${where}`
      : wounds >= need ? "driven off" : Number.isFinite(riseIn) ? `under · surfacing in ${Math.ceil(riseIn)} s` : "under");
  }

  /** The eye's tag (while it's up): over it, with its wounds and this surfacing's hurt. */
  function placeEyeTag() {
    const E = snap?.objective?.eye;
    let p = null;
    if (E && (E.stage === "up" || E.stage === "rise") && Number.isFinite(E.x) && ctx.world?.screenPos) {
      try { p = ctx.world.screenPos({ isVector3: true, x: E.x, y: 15, z: E.z }); } catch { p = null; }
    }
    if (!p || !p.visible || !Number.isFinite(p.x)) { show(eyeTag, false); return; }
    const band = seaBand();
    show(eyeTag, true);
    prop(eyeHp, "--p", clamp(num(E.hp, 1), 0, 1));
    eyeTag.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(clamp(p.y, band.top + 18, band.bottom - 6))}px) translate(-50%, -100%)`;
  }

  // v4 §2: a fail counter only gets a chip once it's a warning (50 %+); below that the briefing said it.
  function paintFails(list) {
    const rows = list.filter((f) => f && (f.label || f.text) && LEVEL(f.frac, f.warn) >= 1);
    show(fails, rows.length > 0);
    const sig = rows.map((f) => f.id).join(",");
    if (sig !== failSig) {
      failSig = sig;
      fill(fails, rows.map((f) => h("div.nr-obfail", { dataset: { id: f.id } }, h("span.ic", { html: ICONS.warning }), h("span.nr-oflabel"), h("span.nr-ofbar", null, h("i")))));
    }
    for (const f of rows) {
      const chip = fails.querySelector(`[data-id="${CSS.escape(String(f.id))}"]`);
      if (!chip) continue;
      text(chip.querySelector(".nr-oflabel"), f.label || f.text);
      chip.title = f.text || "";
      prop(chip, "--p", clamp(num(f.frac), 0, 1));
      const lv = LEVEL(f.frac, f.warn);
      flag(chip, "warn", lv === 1);
      flag(chip, "danger", lv === 2);
      const was = levels.get(f.id) ?? 0;
      if (lv > was) replay(chip, "kick");
      levels.set(f.id, lv);
    }
  }

  // ---- Every frame: the arrow --------------------------------------------------------------------
  const liveNow = () => snap && (snap.phase === "sailing" || snap.phase === "boarding") && !snap.paused;
  function schedule() { if (!raf && liveNow()) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (!liveNow()) { show(arrow, false); show(eyeTag, false); return; }
    place();
    placeEyeTag();
    schedule();
  }

  /** The marker's screen point (null when the scene can't say). */
  function screenOf(mk) {
    const w = ctx.world;
    if (!w?.screenPos) return null;
    try {
      if (mk.kind === "ship" && mk.contactId && mk.seen !== false) return w.screenPos(mk.contactId, { lift: 26 });
      if (Number.isFinite(mk.x) && Number.isFinite(mk.z)) return w.screenPos({ isVector3: true, x: mk.x, y: 10, z: mk.z });
    } catch { /* fall through */ }
    return null;
  }

  function place() {
    const O = readObjective(snap);
    const mk = O?.marker;
    if (!mk || snap.phase === "boarding") { show(arrow, false); return; }
    const d = num(mk.dist, NaN);
    // The scene's own projection of its marker (behind the lens handled): `edge.angle` 0 = right, 90 = down.
    let os = null;
    try { os = ctx.world?.objectiveScreen?.() || null; } catch { os = null; }
    const p = os ? { x: os.x, y: os.y, visible: os.onScreen } : screenOf(mk);
    const W = innerWidth;
    const band = seaBand();
    // On screen the scene's own marker (pillar / chevron) carries the name and the distance: no arrow, unless
    // the marker sits under the objective banner itself (then the arrow points up at it from below).
    const r = el.getBoundingClientRect();
    const underBanner = p && r.height > 0 && p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom + 30;
    if (p && p.visible && !underBanner && p.x > 40 && p.x < W - 40 && p.y > 40 && p.y < band.bottom) { show(arrow, false); return; }
    // Off screen: the arrow on an ellipse inside the screen's edge, toward the marker (0 = up, clockwise).
    let a;
    if (os?.edge && Number.isFinite(os.edge.angle)) a = (os.edge.angle + 90) * Math.PI / 180;
    else {
      const camYaw = num(ctx.world?.look?.yaw, num(input?.()?.look?.()?.yaw, 0));
      let rel = Number.isFinite(mk.rel) ? mk.rel : null;
      if (rel == null && snap.ship && Number.isFinite(mk.bearing)) rel = angleDiff(mk.bearing, num(snap.ship.heading));
      if (rel == null) { show(arrow, false); return; }
      a = angleDiff(rel, camYaw) * Math.PI / 180;
    }
    const c = reticlePoint();
    const top = Math.min(c.y - 40, band.top + 30), bottom = Math.max(c.y + 60, band.bottom - 40);
    // Inside the side columns (crew report, chart, contacts), so the arrow never lands on a panel.
    const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nr-col")) || 236;
    const rx = Math.max(160, W / 2 - col - 70), ry = Math.cos(a) >= 0 ? c.y - top : bottom - c.y;
    const x = c.x + Math.sin(a) * rx, y = c.y - Math.cos(a) * ry;
    show(arrow, true);
    arrow.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    point.firstChild.style.transform = `rotate(${(a * 180 / Math.PI).toFixed(1)}deg)`;
    text(arrowDist, metres(d));
    text(arrowLabel, mk.label || (mk.compass ? `${mk.compass}` : ""));
    flag(arrow, "ship", mk.kind === "ship");
  }

  // ---- Events ----------------------------------------------------------------------------------
  const offs = [
    bus.on("objective", (p = {}) => {
      if (p.stage === "done" && !p.bonus) { replay(el, "tick"); open(); }
      else if (p.stage === "start") { replay(el, "next"); open(); }
      else if (p.stage === "warn") {
        const chip = fails.querySelector(`[data-id="${CSS.escape(String(p.id || ""))}"]`);
        if (chip) replay(chip, "kick");
        // The clock's half-way mark is only the banner's amber; every other crossing (and the clock at 85 %) gets a warning line.
        if (p.id === "time" && num(p.level) < 0.85) return;
        bus.emit("toast", { text: p.label || p.text || "Careful", kind: num(p.level) >= 0.85 ? "danger" : "warn" });
      }
    }),
    bus.on("phase", (p = {}) => { if (p.phase === "briefing" || p.phase === "title") { stepSig = ""; failSig = ""; stepKey = ""; levels.clear(); } }),
  ];

  return { el, update, read: () => readObjective(snap), dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); cancelAnimationFrame(raf); } };
}
