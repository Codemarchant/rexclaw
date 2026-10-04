/*
 * Rexmaw Hold'em: the betting. One heads-up no-limit hand as a state
 * machine, by the standard rules:
 * - the button posts the small blind and acts first before the flop, last after;
 * - a bet is at least the big blind, a raise at least the last full raise;
 * - an all-in for less than a full raise does not reopen the betting for a
 *   player who has already acted (they may only call or fold);
 * - an uncalled part of a bet goes back; a lone all-in runs the board out;
 * - a split pot's odd chip goes to the big blind (first seat after the button).
 *
 * Seats are "you" (the user) and "them" (the companion). Nothing here knows
 * about the page: act() changes the hand and returns what happened.
 */
(function () {
  "use strict";
  const other = (p) => (p === "you" ? "them" : "you");
  const STREETS = ["preflop", "flop", "turn", "river"];

  function newHand({ stacks, button, sb, bb, deck }) {
    const h = {
      stacks: { ...stacks }, button, sb, bb, deck, board: [], street: 0, pot: 0,
      bets: { you: 0, them: 0 }, invested: { you: 0, them: 0 }, betTo: 0, lastRaise: bb,
      acted: { you: false, them: false }, noReraise: null, folded: null, toAct: null, done: false, result: null,
      aggressor: null, history: [],
    };
    // Dealt one at a time, starting left of the button (the big blind).
    const first = other(button);
    h.hole = { [first]: [deck.pop()], [button]: [deck.pop()] };
    h.hole[first].push(deck.pop());
    h.hole[button].push(deck.pop());
    put(h, button, Math.min(sb, h.stacks[button]));
    put(h, first, Math.min(bb, h.stacks[first]));
    h.betTo = Math.max(h.bets.you, h.bets.them);
    startStreet(h, button);
    // A blind that put someone all-in can leave nobody to act: run it out.
    h.openingEvents = [];
    if (!h.toAct) closeStreet(h, h.openingEvents);
    return h;
  }

  function put(h, p, amount) {
    h.stacks[p] -= amount;
    h.bets[p] += amount;
    h.invested[p] += amount;
  }

  const potTotal = (h) => h.pot + h.bets.you + h.bets.them;

  /** Does `p` still have to act on this street? */
  function needsAction(h, p) {
    const o = other(p);
    if (h.folded || h.done || h.stacks[p] === 0) return false;
    if (h.stacks[o] === 0 && h.bets[p] >= h.bets[o]) return false;   // nothing left to play for
    return !h.acted[p] || h.bets[p] < h.betTo;
  }

  /** What `p` may do now. Amounts are raise-TO totals for this street. */
  function options(h, p) {
    const o = other(p), toCall = Math.max(0, h.betTo - h.bets[p]);
    const maxTo = h.bets[p] + h.stacks[p];
    // Raising past what they can match only gets handed back.
    const effMax = Math.min(maxTo, h.bets[o] + h.stacks[o]);
    const minTo = h.betTo === 0 ? Math.min(h.bb, maxTo) : Math.min(h.betTo + h.lastRaise, maxTo);
    const canRaise = h.toAct === p && h.stacks[p] > toCall && h.stacks[o] > 0 && h.noReraise !== p && effMax > h.betTo;
    return {
      toCall: Math.min(toCall, h.stacks[p]), canCheck: toCall === 0, canCall: toCall > 0,
      canRaise, isBet: h.betTo === 0, minTo: Math.min(minTo, effMax), maxTo: effMax,
      allInTo: effMax, pot: potTotal(h),
    };
  }

  /** Apply `action` ("fold" "check" "call" "bet" "raise" "all_in") for `p`;
   *  `to` is the raise-to total for bet/raise. Returns { ok, error, events }. */
  function act(h, p, action, to = 0) {
    if (h.done) return { ok: false, error: "The hand is over." };
    if (h.toAct !== p) return { ok: false, error: "It isn't your turn to act." };
    const o = options(h, p), events = [];
    if (action === "all_in") {
      if (o.canRaise) { action = "raise"; to = o.maxTo; }
      else if (o.canCall) action = "call";
      else action = "check";
    }
    if (action === "bet") action = "raise";
    switch (action) {
      case "fold":
        if (o.canCheck) return { ok: false, error: "There's nothing to call: check instead of folding." };
        h.folded = p;
        record(h, p, "fold");
        break;
      case "check":
        if (!o.canCheck) return { ok: false, error: `You can't check: it's ${o.toCall} to call.` };
        h.acted[p] = true;
        record(h, p, "check");
        break;
      case "call": {
        if (!o.canCall) return { ok: false, error: "There's no bet to call: check instead." };
        put(h, p, o.toCall);
        h.acted[p] = true;
        record(h, p, "call", o.toCall);
        break;
      }
      case "raise": {
        if (!o.canRaise) return { ok: false, error: o.canCall ? "You can't raise now: call or fold." : "You can't bet now." };
        to = Math.round(to);
        if (to > o.maxTo) to = o.maxTo;
        const allIn = to === h.bets[p] + h.stacks[p];
        if (to < o.minTo && !allIn) return { ok: false, error: `The smallest ${o.isBet ? "bet" : "raise"} is to ${o.minTo}.` };
        const increment = to - h.betTo;
        const wasBet = o.isBet;
        put(h, p, to - h.bets[p]);
        if (increment >= h.lastRaise) { h.lastRaise = increment; h.noReraise = null; }
        else if (h.acted[other(p)]) h.noReraise = other(p);   // short all-in: no reopening
        h.betTo = to;
        h.acted[p] = true;
        h.aggressor = p;
        record(h, p, wasBet ? "bet" : "raise", to, allIn);
        break;
      }
      default:
        return { ok: false, error: `Unknown action "${action}".` };
    }
    progress(h, p, events);
    return { ok: true, events };
  }

  function record(h, p, action, amount = 0, allIn = false) {
    h.history.push({ street: h.street, p, action, amount, allIn: allIn || (action !== "fold" && action !== "check" && h.stacks[p] === 0) });
  }

  function startStreet(h, first) {
    if (needsAction(h, first)) h.toAct = first;
    else if (needsAction(h, other(first))) h.toAct = other(first);
    else h.toAct = null;
  }

  /** After `p` acted: the next player, the next street, or the end. */
  function progress(h, p, events) {
    if (h.folded) return finish(h, other(h.folded), "fold", events);
    if (needsAction(h, other(p))) { h.toAct = other(p); return; }
    if (needsAction(h, p)) { h.toAct = p; return; }
    closeStreet(h, events);
  }

  function closeStreet(h, events) {
    // An uncalled part of a bet goes back.
    const hi = h.bets.you > h.bets.them ? "you" : "them", lo = other(hi);
    const back = h.bets[hi] - h.bets[lo];
    if (back > 0) { h.stacks[hi] += back; h.bets[hi] -= back; h.invested[hi] -= back; events.push({ kind: "returned", p: hi, amount: back }); }
    h.pot += h.bets.you + h.bets.them;
    h.bets = { you: 0, them: 0 };
    h.betTo = 0; h.lastRaise = h.bb; h.noReraise = null; h.acted = { you: false, them: false };
    h.toAct = null;
    const allIn = h.stacks.you === 0 || h.stacks.them === 0;
    if (allIn && h.street < 3) events.push({ kind: "runout" });
    while (h.street < 3) {
      h.street++;
      h.deck.pop();   // the burn card
      const n = h.street === 1 ? 3 : 1;
      for (let i = 0; i < n; i++) h.board.push(h.deck.pop());
      events.push({ kind: STREETS[h.street] });
      if (!allIn) {
        startStreet(h, other(h.button));
        if (h.toAct) return;
      }
    }
    showdown(h, events);
  }

  function showdown(h, events) {
    const P = window.RexPoker;
    const hands = { you: P.evaluate([...h.hole.you, ...h.board]), them: P.evaluate([...h.hole.them, ...h.board]) };
    const winner = hands.you.score > hands.them.score ? "you" : hands.you.score < hands.them.score ? "them" : "split";
    events.push({ kind: "showdown" });
    finish(h, winner, "showdown", events, hands);
  }

  function finish(h, winner, how, events, hands = null) {
    const pot = potTotal(h);
    h.pot = 0; h.bets = { you: 0, them: 0 };   // paid out below; result.pot keeps the size
    const won = { you: 0, them: 0 };
    if (winner === "split") {
      const bb = other(h.button);
      won.you = won.them = Math.floor(pot / 2);
      won[bb] += pot - won.you - won.them;   // the odd chip
    } else won[winner] = pot;
    h.stacks.you += won.you; h.stacks.them += won.them;
    h.done = true; h.toAct = null;
    h.result = { winner, how, pot, won, hands };
    events.push({ kind: "end" });
  }

  window.RexTable = { newHand, options, act, potTotal, needsAction, other, STREETS };
})();
