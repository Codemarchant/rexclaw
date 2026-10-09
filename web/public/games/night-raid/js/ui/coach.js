// The coach (Night Helm's): first-mission prompts, one at a time, each shown
// once ever and dismissible (Got it, or doing the thing; it also bows out on
// its own after 16 s and never comes back), and `coach.say(text)` for anything
// main wants on the card. The card sits in the right column, low, clear of
// the sea. Nothing on the HUD is a permanent hint (v3 §C12).
//
// It reads the same `tick` snapshots as the HUD and the Captain's intents on
// the bus, so a tip bows out the moment the Captain does the thing it asks;
// main can put one up by id too (coach.tip(id)).

import { h, fill, store, withName, replay, num } from "./dom.js";

const DONE_KEY = "rx-rexmaw-raids-coach";

/** The tips, in the order a first mission meets them. */
const TIPS = {
  castoff: { label: "Your orders", text: "Read the steps and how you could lose, then Set sail (Enter). Back (Esc) returns to the missions." },
  look: { label: "Look and the guns", text: "The camera looks where your cursor is: middle ahead, left port, right starboard, the far edges astern. The guns follow: ahead chain shot, the sides broadsides, astern fire barrels." },
  objective: { label: "Where to go", text: "The banner up top is your current step. Follow the gilt arrow at the screen's edge (and the flag on the compass) to it." },
  aim: { label: "Aim and fire", text: "Put her on your beam and hold the right mouse button (or Q) to aim. Cursor higher aims farther; the arcs turn red on a hit. Click to fire." },
  heavy: { label: "Heavy shot", text: "She's close. Tap fire without aiming for a point-blank heavy volley." },
  orders: { label: "Your crew", text: "1 Hold · 2 Attack · 3 Defend. Attack: the gun crews fire on their own. Defend: they repair and pump on their own. Right-click a ship (or Tab) to lock her as THE target. Or just ask {Name}." },
  suggestion: { label: "A suggestion", text: "{Name} has a suggestion. Y takes it, N waves it off. It never stops the ship." },
  night: { label: "Sailing blind", text: "In the dark your chart can't show the reefs. {Name} calls the headings on the compass and marks the danger in red." },
  sprint: { label: "Sprint", text: "At full sail, hold Shift to sprint. It drains the wind bar; let it refill." },
  mortar: { label: "The mortar", text: "Press M for the mortar: three shells on a far target, 2.5 s to land. Great for towers." },
  brace: { label: "Brace", text: "When BRACE flashes, press Space just before the hit lands. A perfect brace shrugs off most of it." },
  swivel: { label: "The swivel gun", text: "That ship's showing glowing weak points. Put the reticle on one and click to fire the swivel gun." },
  pickup: { label: "Floating loot", text: "Crates, barrels and bottles afloat: sail through them to haul them aboard." },
  bank: { label: "Bank it", text: "Plunder only counts once it's banked: sail into the harbour below 3 m/s." },
};

/**
 * Build the coach into `ctx.dom.coach`.
 * @param {object} ctx  the UI context
 */
export function createCoach(ctx) {
  const { bus } = ctx;
  const root = ctx.dom.coach;
  root.classList.add("nr-coach");
  const card = h("div.nr-coach-card.nr-parchment", { hidden: true, role: "note" });
  fill(root, card);

  const done = new Set(store.get(DONE_KEY, []) || []);
  let showing = null, manualTimer = 0, tipTimer = 0, since = 0, last = null;

  function remember(id) {
    if (done.has(id)) return;
    done.add(id);
    store.set(DONE_KEY, [...done]);
  }

  function render(txt, label, withButton) {
    if (card.dataset.text !== txt) {
      card.dataset.text = txt;
      fill(card,
        label ? h("div.nr-coach-label", null, label) : null,
        h("p", null, txt),
        withButton ? h("button.nr-btn.nr-small", { type: "button", onclick: () => finish(showing) }, "Got it") : null);
      card.hidden = false;
      replay(card, "in");
    }
    document.body.classList.add("nr-coaching");
  }

  function tip(id) {
    if (!TIPS[id] || done.has(id) || (showing && showing !== id)) return;
    showing = id;
    render(withName(ctx, TIPS[id].text), TIPS[id].label, true);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => finish(id), 16000);
  }

  function finish(id) {
    if (!id || showing !== id) return;
    remember(id);
    hide();
    setTimeout(() => nextTip(), 1600);
  }

  function hide() {
    showing = null;
    card.hidden = true;
    card.dataset.text = "";
    clearTimeout(tipTimer);
    document.body.classList.remove("nr-coaching");
  }

  const hostileWithin = (s, m) => (s.contacts || []).some((c) => c && c.detected !== false && c.hostile !== false && c.state !== "sinking" && num(c.dist, 9e9) < m);

  function nextTip(s = last) {
    if (!s || showing) return;
    if (s.phase === "briefing" || s.phase === "moored") return;   // the briefing card has its own two buttons
    if (s.phase !== "sailing") return;
    const t = (performance.now() - since) / 1000;
    if (!done.has("look")) { if (t > 3) tip("look"); return; }
    if (!done.has("objective") && s.objective?.marker && t > 10) { tip("objective"); return; }
    if (!done.has("night") && num(s.daylight, 1) < 0.5 && t > 8) { tip("night"); return; }
    if (!done.has("aim") && hostileWithin(s, 450)) { tip("aim"); return; }
    if (!done.has("orders") && hostileWithin(s, 700) && t > 20) { tip("orders"); return; }
    if (!done.has("suggestion") && s.suggestion) { tip("suggestion"); return; }
    if (!done.has("heavy") && hostileWithin(s, 90)) { tip("heavy"); return; }
    if (!done.has("swivel") && (s.contacts || []).some((c) => c?.weakPoints?.length && num(c.dist, 9e9) < 120)) { tip("swivel"); return; }
    if (!done.has("mortar") && num(s.ship?.ammo?.mortar) > 0 && (s.contacts || []).some((c) => c?.hostile !== false && num(c.dist, 0) > 330 && num(c.dist, 9e9) < 600)) { tip("mortar"); return; }
    if (!done.has("pickup") && (s.pickups || []).some((p) => Math.hypot(p.x - s.ship?.x, p.z - s.ship?.z) < 160)) { tip("pickup"); return; }
    if (!done.has("sprint") && num(s.ship?.sail) >= 2 && t > 30) { tip("sprint"); return; }
    if (!done.has("bank") && num(s.plunder?.hold) > 0 && s.mission?.id?.startsWith?.("free")) tip("bank");
  }

  bus.on("tick", (s) => {
    if (!s) return;
    const prev = last?.phase;
    last = s;
    if (s.phase === "sailing" && prev !== "sailing" && prev !== "boarding") since = performance.now();
    if (!["briefing", "moored", "sailing", "boarding"].includes(s.phase) && showing && showing !== "say") hide();
    if (showing === "castoff" && s.phase === "sailing") finish("castoff");
    nextTip(s);
  });
  bus.on("intent", ({ name, payload } = {}) => {
    const answers = { start_voyage: "castoff", fire: "aim", order: "orders", crew_mode: "orders", mark: "orders", lock: "orders", lock_cycle: "orders", suggestion: "suggestion", sprint: "sprint", brace: "brace", swivel: "swivel" };
    let id = answers[name];
    if (name === "aim" && showing === "look") id = "look";
    if (name === "fire" && showing === "heavy") id = "heavy";
    if (name === "fire" && payload?.mode === "mortar") id = "mortar";
    if (!id) return;
    if (showing === id && (id !== "look" || performance.now() - since > 4000)) finish(id);
    else if (id !== "look" && id !== "castoff") remember(id);
  });
  bus.on("mortar_mode", () => { if (showing === "mortar") finish("mortar"); });
  bus.on("pickup", () => remember("pickup"));
  bus.on("brace_call", () => { if (!done.has("brace") && !showing) tip("brace"); });
  bus.on("bank", () => remember("bank"));
  bus.on("view", ({ name } = {}) => { if (name !== "voyage" && name !== "raid" && showing) hide(); });

  return {
    el: root,
    say(txt, { ms = 0 } = {}) {
      clearTimeout(manualTimer);
      if (!txt) { if (showing === "say") hide(); return; }
      showing = "say";
      render(withName(ctx, String(txt)), "", false);
      if (ms > 0) manualTimer = setTimeout(() => { if (showing === "say") hide(); }, ms);
    },
    tip,
    reset() { done.clear(); store.set(DONE_KEY, []); },
    done: () => [...done],
  };
}
