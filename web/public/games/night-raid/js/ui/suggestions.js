// The companion's suggestion card (v2 spec §4 `suggest`): small and quiet,
// never a blocker. "Eve suggests · Take her · the Sea Wren — “she's riding
// low with spice”". Y sets the course / marks the target (`suggestion {id,
// accept: true}`), N waves it off; ignore it and it drifts away when it
// expires. The `suggestion` event stamps it ("Course set" / "Waved off").

import { h, text, prop, clamp, num, replay, byName, contactName, SUGGEST } from "./dom.js";

/**
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent
 */
export function createSuggestions(ctx, parent) {
  const { bus } = ctx;
  const who = h("small.nr-sgwho");
  const kind = h("b.nr-sgkind");
  const target = h("span.nr-sgtarget");
  const pitch = h("p.nr-sgpitch");
  const ring = h("i.nr-sgring", { "aria-hidden": "true" });
  const yes = h("button.nr-btn.nr-small.nr-yes", { type: "button" }, "Aye ", h("kbd", null, "Y"));
  const no = h("button.nr-btn.nr-small.nr-ghost", { type: "button", title: "Wave it off" }, h("kbd", null, "N"));
  const stamp = h("span.nr-sgstamp", { hidden: true });
  const el = h("section.nr-suggestion", { hidden: true, role: "status", "aria-live": "polite" },
    h("div.nr-sghead", null, ring, who, kind), target, pitch, h("div.nr-sgbtns", null, yes, no, stamp));
  parent.append(el);
  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));

  let open = null, maxLeft = 1, closing = 0;

  function answer(accept) {
    if (!open) return false;
    bus.intent("suggestion", { id: open.id, accept: !!accept });
    replay(accept ? yes : no, "sent");
    if (!accept) finish("declined");
    return true;
  }

  function render(p, s) {
    text(who, `${byName(ctx, p.by || "companion")} suggests`);
    text(kind, SUGGEST[p.kind] || String(p.kind || "A plan"));
    const c = p.target ? (s?.contacts || []).find((x) => x.id === p.target) : null;
    const tn = p.targetName || (c ? contactName(c) : p.target && typeof p.target === "string" ? p.target : "");
    text(target, tn ? tn : "");
    text(pitch, p.pitch ? `“${p.pitch}”` : "");
    el.dataset.kind = p.kind || "";
    text(yes.firstChild, p.kind === "flee" || p.kind === "route" || p.kind === "loot" ? "Set course " : "Mark her ");
  }

  function update(s) {
    const p = s?.suggestion || null;
    if (p && (!open || open.id !== p.id)) {
      open = p; maxLeft = Math.max(1, num(p.expiresIn, 20));
      clearTimeout(closing); closing = 0;
      stamp.hidden = true;
      el.classList.remove("answered", "accepted", "declined", "expired", "out");
      render(p, s);
      el.hidden = false;
      replay(el, "in");
      yes.disabled = no.disabled = false;
    } else if (p) { open = p; render(p, s); }
    if (p) prop(ring, "--p", clamp(num(p.expiresIn) / maxLeft, 0, 1));
    if (!p && open && !closing) finish("expired");
  }

  function finish(stage) {
    if (!open && el.hidden) return;
    el.classList.add("answered", stage);
    stamp.hidden = false;
    text(stamp, stage === "accepted" ? "Aye" : stage === "declined" ? "Waved off" : "");
    yes.disabled = no.disabled = true;
    open = null;
    clearTimeout(closing);
    closing = setTimeout(() => { el.classList.add("out"); setTimeout(() => { el.hidden = true; closing = 0; }, 350); }, stage === "expired" ? 200 : 1100);
  }

  const offs = [
    bus.on("suggestion", (p = {}) => { if (["accepted", "declined", "expired"].includes(p.stage) && (!open || !p.id || open.id === p.id)) finish(p.stage); }),
    bus.on("phase", (p = {}) => { if (p.phase !== "sailing" && p.phase !== "boarding") { open = null; el.hidden = true; } }),
  ];

  return { el, update, answer, isOpen: () => !!open, current: () => open, dispose() { offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); } };
}
