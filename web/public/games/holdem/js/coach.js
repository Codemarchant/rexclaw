/*
 * Rexmaw Hold'em: what the companion is told when it's their turn. A fast
 * voice model plays poker the way it plays chess: badly, unless the facts a
 * player sees at a glance are written out. So each decision comes with its
 * hand in words, its equity, the price, standard bet sizes, a read on the
 * user (from their PUBLIC actions only), a plan and a bluff option. The
 * companion decides; their character is free to overrule the plan.
 *
 * Where the numbers come from:
 * - Push/fold ranges for short stacks: rounded from heads-up Nash
 *   push/fold charts (HoldemResources Calculator): at 10 big blinds the
 *   small blind shoves about 58% of hands and the big blind calls with
 *   about 37%.
 * - Deep-stacked heads-up: the button opens about 80% of hands to 2-2.5
 *   big blinds; the big blind 3-bets about 12% and defends most of the rest.
 * - Bluff maths: a bet of B into a pot P breaks even when the user folds
 *   more than B / (B + P) of the time; on the river a balanced pot-sized bet
 *   is one bluff for every two value bets (B / (P + 2B) of the betting range).
 * - Draws: the rule of 4 and 2 (outs x 4 on the flop, x 2 on the turn).
 * Equity is against a random hand, never the user's real cards.
 */
(function () {
  "use strict";
  const pct = (x) => `${Math.round(x * 100)}%`;
  const STREET = ["preflop", "the flop", "the turn", "the river"];
  const NASH_PUSH = [[3, 1], [5, 0.85], [7, 0.7], [10, 0.58], [12, 0.5], [15, 0.42]];
  const NASH_CALL = [[3, 0.7], [5, 0.55], [7, 0.45], [10, 0.37], [12, 0.32], [15, 0.28]];
  const band = (table, bbs) => (table.find(([max]) => bbs <= max) || table[table.length - 1])[1];

  function cardsText(cards) { return cards.map(window.RexGame.cardText).join(" "); }

  /** What happened in this hand, in words, street by street. */
  function story(h) {
    const T = window.RexTable, out = [];
    for (let s = 0; s <= h.street; s++) {
      const acts = h.history.filter((a) => a.street === s).map((a) => {
        const what = { fold: "folded", check: "checked", call: `called ${a.amount}`, bet: `bet ${a.amount}`,
                       raise: `raised to ${a.amount}` }[a.action];
        return `${a.p === "you" ? "the user" : "you"} ${what}${a.allIn ? " (all-in)" : ""}`;
      });
      if (acts.length) out.push(`${T.STREETS[s][0].toUpperCase() + T.STREETS[s].slice(1)}: ${acts.join(", ")}.`);
    }
    return out.join(" ");
  }

  /** The user's habits, from what they did in front of the companion. */
  function readText(reads) {
    if (!reads || reads.hands < 3) return "Read on the user: too few hands yet to read them.";
    const bits = [`plays ${pct(reads.vpip / reads.hands)} of hands`, `raises ${pct(reads.pfr / reads.hands)} before the flop`];
    if (reads.faced >= 2) bits.push(`folded to ${reads.folds} of your ${reads.faced} bets after the flop`);
    const style = reads.aggr + reads.calls >= 4 ? (reads.aggr > reads.calls * 1.3 ? "aggressive (bets more than calls)"
      : reads.calls > reads.aggr * 1.3 ? "passive (calls more than bets)" : "balanced") : null;
    if (style) bits.push(style);
    let text = `Read on the user (${reads.hands} hands, public actions only): ${bits.join(", ")}.`;
    const shown = (reads.shown || []).slice(-2);
    if (shown.length) text += ` Recent showdowns: ${shown.map((s) => `${s.cards} (${s.what})${s.note ? ` ${s.note}` : ""}`).join("; ")}.`;
    if (reads.caught) text += ` They have caught you bluffing ${reads.caught} time${reads.caught > 1 ? "s" : ""}.`;
    return text;
  }

  /** A raise-to total: `frac` of the pot on top of calling. */
  function sizeTo(h, o, frac) {
    const raw = h.betTo + frac * (o.pot + o.toCall);
    const step = h.sb || 1;
    return Math.max(o.minTo, Math.min(o.maxTo, Math.round(raw / step) * step));
  }

  /** The companion's briefing for its turn. */
  function brief(h, { handNo, reads, shoveOnly = false, levelText = "" }) {
    const P = window.RexPoker, T = window.RexTable;
    const o = T.options(h, "them"), hole = h.hole.them, board = h.board;
    const eq = P.equity(hole, board, 2000);
    const eff = Math.min(h.stacks.them + h.bets.them, h.stacks.you + h.bets.you);
    const bbs = Math.round(eff / h.bb);
    const lines = [];
    lines.push(`## Hold'em NOW: hand ${handNo}, ${STREET[h.street]}${levelText ? `, ${levelText}` : ""}. `
      + (h.button === "them" ? "You have the button (small blind): you act last after the flop."
        : "You are the big blind: you act first after the flop."));
    lines.push(`Your cards (secret, don't say them): ${cardsText(hole)}. Board: ${board.length ? cardsText(board) : "nothing yet"}.`);
    const preTop = !board.length ? ` A top-${pct(P.PCT[P.code(hole)])} starting hand.` : "";
    lines.push(`You have ${P.describe(hole, board)}. It wins ${pct(eq)} against a random hand.${preTop}`);
    const draws = P.draws(hole, board);
    const outs = draws.reduce((n, d) => n + d.outs, 0);
    if (draws.length) {
      const hit = Math.min(0.95, outs * (board.length === 3 ? 4 : 2) / 100);
      lines.push(`You also have ${draws.map((d) => d.name).join(" and ")}: ${outs} outs, about ${pct(hit)} to hit by the river.`);
    }
    for (const t of P.texture(board)) lines.push(`Board: ${t}.`);
    lines.push(`Pot ${o.pot}. Stacks behind: you ${h.stacks.them}, the user ${h.stacks.you} (${bbs} big blinds effective).`);
    const sofar = story(h);
    if (sofar) lines.push(`This hand: ${sofar}`);
    const need = o.toCall ? o.toCall / (o.pot + o.toCall) : 0;
    if (o.toCall) lines.push(`To call: ${o.toCall}. Calling breaks even if you win ${pct(need)} of the time.`);
    lines.push(readText(reads));

    // The plan.
    const { plan, bluff } = h.street === 0 ? preflopPlan(h, o, hole, bbs, shoveOnly) : postflopPlan(h, o, eq, need, outs, reads);
    lines.push(`Plan (a solid line; play your own character, you may overrule it): ${plan}.`);
    if (bluff) lines.push(`Bluff option: ${bluff}`);

    // Sizes and what's allowed.
    if (o.canRaise && !shoveOnly) {
      const clamp = (x) => Math.min(o.maxTo, Math.max(o.minTo, Math.round(x / h.sb) * h.sb));
      const raises = h.history.filter((a) => a.street === 0 && a.action === "raise").length;
      const pre = raises === 0 ? (o.toCall ? `open to ${clamp(2.5 * h.bb)}` : `raise to ${clamp(3.5 * h.bb)}`)
        : raises === 1 ? `3-bet to about ${clamp(3 * h.betTo)}` : `4-bet to about ${clamp(2.3 * h.betTo)}`;
      lines.push(h.street === 0
        ? `Standard sizes: ${pre}, all-in ${o.maxTo}.`
        : `Sizes (raise-to totals): 1/3 pot ${sizeTo(h, o, 1 / 3)}, 1/2 pot ${sizeTo(h, o, 1 / 2)}, 2/3 pot ${sizeTo(h, o, 2 / 3)}, pot ${sizeTo(h, o, 1)}, all-in ${o.maxTo}.`);
    }
    const can = [];
    if (shoveOnly && o.canRaise && h.stacks.you > 0) can.push("fold", `all_in (${o.maxTo})`);
    else {
      if (o.toCall) can.push("fold", `call ${o.toCall}${o.toCall >= h.stacks.them ? " (all-in)" : ""}`); else can.push("check");
      if (o.canRaise && !shoveOnly) can.push(`${o.isBet ? "bet" : "raise to"} ${o.minTo}-${o.maxTo}`);
      if (o.canRaise) can.push(`all_in (${o.maxTo})`);
    }
    lines.push(`You can: ${can.join(", ")}.`);
    return lines.join("\n");
  }

  function preflopPlan(h, o, hole, bbs, shoveOnly) {
    const P = window.RexPoker;
    const top = P.PCT[P.code(hole)];
    const raises = h.history.filter((a) => a.street === 0 && (a.action === "raise" || a.action === "bet")).length;
    const userRaised = h.history.some((a) => a.street === 0 && a.p === "you" && a.action === "raise");
    const facingShove = h.stacks.you === 0;
    if (shoveOnly || bbs <= 12) {
      if (!userRaised && !facingShove) {
        const range = band(NASH_PUSH, bbs);
        return { plan: top <= range ? `all-in: with ${bbs} big blinds, shove the top ${pct(range)} of hands, and yours is in it`
          : o.toCall ? `fold: with ${bbs} big blinds, shove the top ${pct(range)} and fold the rest` : "check" };
      }
      const range = band(NASH_CALL, bbs);
      return { plan: top <= range ? `call: against a shove at ${bbs} big blinds, call with the top ${pct(range)}; yours is in it`
        : `fold: against a shove at ${bbs} big blinds, call only with the top ${pct(range)}` };
    }
    if (raises === 0 && o.toCall) {   // the button, first in
      return top <= 0.8 ? { plan: `raise to ${Math.max(o.minTo, 2.5 * h.bb)}: heads-up the button opens about 80% of hands` }
        : { plan: "fold: one of the worst 20% of hands", bluff: `open anyway to ${Math.max(o.minTo, 2.5 * h.bb)} and see if they fold the big blind.` };
    }
    if (raises === 0) {   // the big blind, after a limp
      return { plan: top <= 0.35 ? `raise to ${Math.min(o.maxTo, Math.max(o.minTo, 3.5 * h.bb))}: punish the limp` : "check: see a free flop" };
    }
    if (raises === 1) {   // the big blind facing an open
      if (top <= 0.12) return { plan: `3-bet to about ${Math.min(o.maxTo, Math.max(o.minTo, 3 * h.betTo))}: a top-12% hand` };
      if (top <= 0.7) return { plan: `call: the big blind defends most hands heads-up, and you're getting a price` };
      return { plan: "fold: too weak even for the big blind", bluff: `3-bet to ${Math.min(o.maxTo, Math.max(o.minTo, 3 * h.betTo))} as a bluff; they open so many hands that they often can't continue.` };
    }
    if (raises === 2) {   // re-raised
      if (top <= 0.05) return { plan: `4-bet to ${Math.min(o.maxTo, Math.max(o.minTo, Math.round(2.3 * h.betTo)))}, or all-in: a premium hand` };
      if (top <= 0.25) return { plan: "call: strong enough to see a flop" };
      return { plan: "fold: they re-raised and your hand isn't strong enough" };
    }
    return { plan: top <= 0.04 ? "all-in or call: this is a premium hand" : "fold: this many raises means a big hand" };
  }

  function postflopPlan(h, o, eq, need, outs, reads) {
    const river = h.street === 3;
    const userChecked = h.history.some((a) => a.street === h.street && a.p === "you" && a.action === "check");
    const scary = window.RexPoker.texture(h.board).some((t) => /flush is possible|straight is possible/.test(t));
    const foldRate = reads && reads.faced >= 3 ? reads.folds / reads.faced : null;
    const bluffWhy = (bet, pot) => {
      const be = bet / (bet + pot);
      const why = [`it pays if the user folds more than ${pct(be)} of the time`];
      if (foldRate !== null) why.push(`they've folded to ${pct(foldRate)} of your bets`);
      if (userChecked) why.push("they checked, which often means a weak hand");
      if (scary) why.push("the board is scary enough to represent a big hand");
      return why.join("; ");
    };
    if (o.canCheck) {
      const half = sizeTo(h, o, 1 / 2), twoThirds = sizeTo(h, o, 2 / 3);
      if (!o.canRaise) return { plan: "check" };
      if (eq >= 0.85 && !river && Math.random() < 0.25) return { plan: "check to trap: you're very strong, let them catch up or bluff" };
      if (eq >= 0.72) return { plan: `bet ${twoThirds} for value` };
      if (eq >= 0.58) return { plan: `bet ${half}: thin value, and it protects your hand` };
      if (eq >= 0.42) return { plan: "check: some showdown value, no need to build the pot" };
      if (outs >= 8 && !river) return { plan: `semi-bluff: bet ${half}; if they call, your draw is the backup`, bluff: null };
      const amount = river ? twoThirds : half;
      return { plan: "check and give up the pot, unless you bluff", bluff: `bet ${amount} (${bluffWhy(amount - h.bets.them, o.pot)}).${river ? " A balanced river range is one bluff for every two value bets." : ""}` };
    }
    // Facing a bet: bigger bets mean stronger hands, so knock some off.
    const eqAdj = eq - 0.12 * Math.min(1.5, o.toCall / Math.max(1, o.pot - o.toCall));
    const raiseTo = Math.min(o.maxTo, Math.max(o.minTo, Math.round(3 * h.betTo / h.sb) * h.sb));
    if (eqAdj >= 0.75 && o.canRaise) return { plan: `raise to ${raiseTo} for value` };
    if (eqAdj >= need + 0.03) return { plan: `call: you're getting the right price (${pct(eqAdj)} against what they'd bet with, ${pct(need)} needed)` };
    if (outs && !river && outs * (h.street === 1 ? 4 : 2) / 100 >= need * 0.85) {
      return { plan: "call: your draw plus what you can win later make this close" };
    }
    const bluff = o.canRaise && !river ? `raise to ${raiseTo} as a bluff (${bluffWhy(raiseTo - h.bets.them, o.pot)}).` : null;
    return { plan: `fold: not enough to call (${pct(eqAdj)} against what they'd bet with, ${pct(need)} needed)`, bluff };
  }

  /** Was the companion's bet a bluff, by its own cards? (For Polly.) */
  function bluffy(h) {
    const P = window.RexPoker;
    if (!h.board.length) return P.PCT[P.code(h.hole.them)] > 0.55;
    return P.equity(h.hole.them, h.board, 600) < 0.4;
  }

  window.RexCoach = { brief, story, readText, bluffy, cardsText, sizeTo };
})();
