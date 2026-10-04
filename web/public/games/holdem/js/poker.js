/*
 * Rexmaw Hold'em: the cards. A seven-card hand evaluator, hand names,
 * equity against a random hand (Monte Carlo on the flop and turn, exact on
 * the river, a precomputed table preflop), draws, and what the board looks
 * like. Cards are the kit's { rank: "A".."2"/"10", suit: "hearts"... }.
 *
 * Equity is always against a RANDOM hand, never the user's real cards:
 * the companion must not learn them before a showdown.
 */
(function () {
  "use strict";
  const RV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
  const NAME = { 14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten", 9: "Nine", 8: "Eight", 7: "Seven",
    6: "Six", 5: "Five", 4: "Four", 3: "Three", 2: "Two" };
  const PLURAL = (v) => (v === 6 ? "Sixes" : `${NAME[v]}s`);
  const LETTER = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T" };
  const v = (c) => RV[c.rank];
  const key = (c) => c.rank + c.suit;
  const FULL = [];
  for (const suit of ["hearts", "diamonds", "clubs", "spades"]) for (const rank of Object.keys(RV)) FULL.push({ rank, suit });

  /** The highest straight in a set of values (ace plays low too), or 0. */
  function straightTop(set) {
    const has = (x) => set.has(x) || (x === 1 && set.has(14));
    for (let top = 14; top >= 5; top--) {
      let run = true;
      for (let k = 0; k < 5 && run; k++) run = has(top - k);
      if (run) return top;
    }
    return 0;
  }

  function make(cat, ranks) {
    let score = cat;
    for (let i = 0; i < 5; i++) score = score * 15 + (ranks[i] || 0);
    return { score, cat, ranks };
  }

  /** The best five of 5 to 7 cards: { score (higher wins), cat 0..8, ranks }. */
  function evaluate(cards) {
    const vals = cards.map(v), bySuit = {}, counts = {};
    for (const c of cards) (bySuit[c.suit] = bySuit[c.suit] || []).push(v(c));
    for (const x of vals) counts[x] = (counts[x] || 0) + 1;
    const flush = Object.keys(bySuit).find((s) => bySuit[s].length >= 5);
    if (flush) {
      const sf = straightTop(new Set(bySuit[flush]));
      if (sf) return make(8, [sf]);
    }
    const groups = Object.entries(counts).map(([x, n]) => [n, +x]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const rest = (...not) => vals.filter((x) => !not.includes(x)).sort((a, b) => b - a);
    if (groups[0][0] === 4) return make(7, [groups[0][1], rest(groups[0][1])[0]]);
    if (groups[0][0] === 3 && groups[1]?.[0] >= 2) return make(6, [groups[0][1], groups[1][1]]);
    if (flush) return make(5, bySuit[flush].sort((a, b) => b - a).slice(0, 5));
    const st = straightTop(new Set(vals));
    if (st) return make(4, [st]);
    if (groups[0][0] === 3) return make(3, [groups[0][1], ...rest(groups[0][1]).slice(0, 2)]);
    if (groups[0][0] === 2 && groups[1]?.[0] === 2) {
      const [a, b] = [groups[0][1], groups[1][1]];
      return make(2, [a, b, rest(a, b)[0]]);
    }
    if (groups[0][0] === 2) return make(1, [groups[0][1], ...rest(groups[0][1]).slice(0, 3)]);
    return make(0, vals.sort((a, b) => b - a).slice(0, 5));
  }

  function handName(h) {
    const [a, b] = h.ranks;
    return [
      `${NAME[a]} high`, `a pair of ${PLURAL(a)}`, `two pair, ${PLURAL(a)} and ${PLURAL(b)}`, `three ${PLURAL(a)}`,
      `a straight, ${NAME[a]} high`, `a flush, ${NAME[a]} high`, `a full house, ${PLURAL(a)} full of ${PLURAL(b)}`,
      `four ${PLURAL(a)}`, a === 14 ? "a royal flush" : `a straight flush, ${NAME[a]} high`,
    ][h.cat];
  }

  /** The five cards that make the hand (for lighting them up). */
  function bestFive(cards) {
    const target = evaluate(cards).score;
    const n = cards.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b).slice(0, 5);
      if (n === 7 && evaluate(five).score === target) return five;
    }
    if (n === 6) {
      for (let a = 0; a < n; a++) {
        const five = cards.filter((_, i) => i !== a);
        if (evaluate(five).score === target) return five;
      }
    }
    return cards.slice(0, 5);
  }

  // ---- Equity against a random hand ------------------------------------------

  // Preflop equity (%) of each of the 169 starting hands against one random
  // hand, worked out with this evaluator (40,000 random run-outs a hand;
  // matches the published figures: AA 85%, AKs 67%, 72o 34.6%, 32o 32.3%).
  const PRE = {
    "22": 50.1, "33": 53.7, "44": 56.8, "55": 60.3, "66": 63.8, "77": 66.2, "88": 69.2, "99": 71.9, AA: 84.7, AKs: 67.1, AKo: 65.5, AQs: 66.3, AQo: 64.5,
    AJs: 65.4, AJo: 63.9, ATs: 64.7, ATo: 62.6, A9s: 62.6, A9o: 60.9, A8s: 61.6, A8o: 59.6, A7s: 61.1, A7o: 58.6, A6s: 59.9, A6o: 58.2, A5s: 60,
    A5o: 57.9, A4s: 59.3, A4o: 56.6, A3s: 58.6, A3o: 56, A2s: 57.6, A2o: 54.8, KK: 82.5, KQs: 63.3, KQo: 60.9, KJs: 62.7, KJo: 60.6, KTs: 61.9,
    KTo: 59.9, K9s: 60.1, K9o: 57.7, K8s: 58, K8o: 55.9, K7s: 57.9, K7o: 55.6, K6s: 57.2, K6o: 54.4, K5s: 56.2, K5o: 53.7, K4s: 54.7, K4o: 52.3,
    K3s: 54.3, K3o: 51.7, K2s: 53.3, K2o: 50.7, QQ: 79.9, QJs: 60.2, QJo: 58.2, QTs: 59.6, QTo: 57.4, Q9s: 57.6, Q9o: 54.8, Q8s: 55.5, Q8o: 53.5,
    Q7s: 54.1, Q7o: 51.8, Q6s: 53.5, Q6o: 51.5, Q5s: 52.9, Q5o: 50.2, Q4s: 51.1, Q4o: 48.9, Q3s: 50.9, Q3o: 48, Q2s: 50.4, Q2o: 47.7, JJ: 77.5,
    JTs: 57.2, JTo: 55.3, J9s: 55.8, J9o: 53.5, J8s: 54.2, J8o: 51.5, J7s: 52.3, J7o: 49.7, J6s: 50.7, J6o: 47.9, J5s: 49.7, J5o: 47.4, J4s: 49.4,
    J4o: 46.2, J3s: 48, J3o: 45.6, J2s: 47.3, J2o: 44.3, TT: 74.8, T9s: 53.6, T9o: 51.6, T8s: 52.2, T8o: 49.8, T7s: 50.6, T7o: 47.8, T6s: 49,
    T6o: 46, T5s: 47.4, T5o: 44.7, T4s: 46.5, T4o: 43.5, T3s: 45.9, T3o: 42.7, T2s: 44.9, T2o: 41, "98s": 51, "98o": 48.2, "97s": 49, "97o": 46.8,
    "96s": 47.7, "96o": 44.4, "95s": 45.7, "95o": 42.8, "94s": 44.1, "94o": 41.2, "93s": 42.9, "93o": 39.9, "92s": 42.2, "92o": 38.8, "87s": 47.9, "87o": 44.5, "86s": 46.1,
    "86o": 43.1, "85s": 45, "85o": 41.5, "84s": 42.6, "84o": 39.2, "83s": 40.7, "83o": 37.4, "82s": 40.3, "82o": 36.8, "76s": 45.6, "76o": 42.1, "75s": 43.9, "75o": 40.3,
    "74s": 41.6, "74o": 38.6, "73s": 40, "73o": 36.4, "72s": 38.4, "72o": 34.6, "65s": 43, "65o": 39.9, "64s": 41.7, "64o": 38.2, "63s": 39.7, "63o": 36, "62s": 37.3,
    "62o": 34.2, "54s": 41.3, "54o": 38.1, "53s": 39.9, "53o": 36.3, "52s": 37.9, "52o": 34.1, "43s": 38.6, "43o": 34.9, "42s": 37.3, "42o": 33, "32s": 36.2, "32o": 32.3,
  };

  /** "AKs", "T9o", "77". */
  function code(hole) {
    const [a, b] = [...hole].sort((x, y) => v(y) - v(x));
    const L = (c) => LETTER[v(c)] || String(v(c));
    if (v(a) === v(b)) return L(a) + L(b);
    return L(a) + L(b) + (a.suit === b.suit ? "s" : "o");
  }

  // Each code's share of all 1326 starting combos, strongest first: the
  // "top X%" a hand belongs to.
  const PCT = {};
  {
    let seen = 0;
    for (const [c] of Object.entries(PRE).sort((a, b) => b[1] - a[1])) {
      const combos = c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12;
      seen += combos;
      PCT[c] = seen / 1326;
    }
  }

  /** Share of a random hand's equity (0..1). Dead cards: the companion's own
   *  hand and the board, NEVER the user's cards. */
  function equity(hole, board = [], iterations = 1500) {
    if (!board.length && PRE[code(hole)]) return PRE[code(hole)] / 100;
    const used = new Set([...hole, ...board].map(key));
    const rest = FULL.filter((c) => !used.has(key(c)));
    const need = 5 - board.length;
    let won = 0, n = 0;
    const score = (opp, full) => {
      const mine = evaluate([...hole, ...full]).score, theirs = evaluate([...opp, ...full]).score;
      won += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
      n++;
    };
    if (!need) {
      for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([rest[i], rest[j]], board);
      return won / n;
    }
    const deck = rest.slice();
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < need + 2; k++) {
        const j = k + Math.floor(Math.random() * (deck.length - k));
        [deck[k], deck[j]] = [deck[j], deck[k]];
      }
      score([deck[0], deck[1]], board.concat(deck.slice(2, 2 + need)));
    }
    return won / n;
  }

  /** Hand `a`'s share against hand `b` (both known) from `board` on: for
   *  telling a bad beat from a fair loss once the cards are face up. */
  function versus(a, b, board = [], iterations = 1500) {
    const used = new Set([...a, ...b, ...board].map(key));
    const deck = FULL.filter((c) => !used.has(key(c)));
    const need = 5 - board.length;
    if (!need) {
      const x = evaluate([...a, ...board]).score, y = evaluate([...b, ...board]).score;
      return x > y ? 1 : x === y ? 0.5 : 0;
    }
    let won = 0;
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(Math.random() * (deck.length - k));
        [deck[k], deck[j]] = [deck[j], deck[k]];
      }
      const full = board.concat(deck.slice(0, need));
      const x = evaluate([...a, ...full]).score, y = evaluate([...b, ...full]).score;
      won += x > y ? 1 : x === y ? 0.5 : 0;
    }
    return won / iterations;
  }

  // ---- Reading a hand ---------------------------------------------------------

  /** What you're holding, in a poker player's words: "a pair of Kings (top
   *  pair, Jack kicker)", "Ace high", "playing the board". */
  function describe(hole, board) {
    if (!board.length) {
      const c = code(hole);
      const kind = c.length === 2 ? "a pocket pair" : c.endsWith("s") ? "suited" : "offsuit";
      return `${NAME[Math.max(v(hole[0]), v(hole[1]))]}-${NAME[Math.min(v(hole[0]), v(hole[1]))]} ${kind} (${c})`;
    }
    const h = evaluate([...hole, ...board]);
    let text = handName(h);
    if (board.length === 5 && evaluate(board).score === h.score) return `${text}, all on the board: you're playing the board`;
    const bv = [...new Set(board.map(v))].sort((a, b) => b - a);
    const pocket = v(hole[0]) === v(hole[1]);
    if (h.cat === 1) {
      const p = h.ranks[0];
      if (pocket) text += p > bv[0] ? " (an overpair)" : " (a pocket pair below the top card)";
      else if (!hole.some((c) => v(c) === p)) text += " (the pair is on the board: you only have high cards)";
      else if (p === bv[0]) text += ` (top pair, ${NAME[hole.map(v).find((x) => x !== p) || p]} kicker)`;
      else if (p === bv[1]) text += " (middle pair)";
      else text += " (a low pair)";
    } else if (h.cat === 3) text += pocket ? " (a set)" : "";
    else if (h.cat === 2) {
      const boardPairs = h.ranks.slice(0, 2).filter((r) => board.filter((c) => v(c) === r).length >= 2);
      if (boardPairs.length === 2) text += " (both pairs on the board)";
      else if (boardPairs.length === 1) text += ` (the ${PLURAL(boardPairs[0])} are on the board)`;
    }
    return text;
  }

  /** Draws on the flop or turn: [{ name, outs }]. */
  function draws(hole, board) {
    if (board.length < 3 || board.length > 4) return [];
    const all = [...hole, ...board], out = [];
    const made = evaluate(all).cat;
    if (made < 5) {
      for (const suit of ["hearts", "diamonds", "clubs", "spades"]) {
        if (all.filter((c) => c.suit === suit).length === 4 && hole.some((c) => c.suit === suit)) out.push({ name: "a flush draw", outs: 9 });
      }
    }
    if (made < 4) {
      const mine = new Set(all.map(v)), theirs = new Set(board.map(v));
      let ranks = 0;
      for (let r = 2; r <= 14; r++) {
        if (mine.has(r)) continue;
        const with_ = new Set(mine).add(r), boardOnly = new Set(theirs).add(r);
        if (straightTop(with_) && !straightTop(boardOnly)) ranks++;
      }
      if (ranks >= 2) out.push({ name: "an open-ended straight draw", outs: 8 });
      else if (ranks === 1) out.push({ name: "a gutshot straight draw", outs: 4 });
    }
    return out;
  }

  /** What the board offers: flushes, straights, pairs. */
  function texture(board) {
    if (board.length < 3) return [];
    const notes = [], suits = {};
    for (const c of board) suits[c.suit] = (suits[c.suit] || 0) + 1;
    const most = Math.max(...Object.values(suits));
    if (most >= 3) notes.push(`${most} ${Object.keys(suits).find((s) => suits[s] === most)} on the board: a flush is possible`);
    else if (most === 2 && board.length < 5) notes.push("two of a suit on the board: flush draws are possible");
    const vals = [...new Set(board.map(v))];
    const runs = vals.some((a) => vals.filter((b) => b >= a && b <= a + 4).length >= 3 || (a === 14 && vals.filter((b) => b <= 5).length >= 2));
    if (runs) notes.push("three cards within a straight's reach: a straight is possible");
    if (vals.length < board.length) notes.push("the board is paired: full houses are possible");
    return notes;
  }

  window.RexPoker = { RV, NAME, evaluate, handName, bestFive, equity, versus, code, PCT, PRE, describe, draws, texture, key };
})();
