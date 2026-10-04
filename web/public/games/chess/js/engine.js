/*
 * Rexmaw Chess: the rules. Full FIDE chess with no shortcuts: castling
 * (through and out of check refused), en passant, promotion to any piece,
 * check, checkmate, stalemate, threefold repetition, the fifty-move rule
 * and dead positions (too little material to mate).
 *
 * Squares are 0..63, a1 = 0, h1 = 7, a8 = 56. A piece is { t, c, id }:
 * t in "pnbrqk", c "w" or "b", and an id that follows it around the board
 * (the page animates by it). A position is { board, turn, castle, ep, half,
 * full }, and make() returns a new one, so positions can be kept for the
 * repetition count and the save.
 *
 * Also here: SAN, FEN, a forgiving move reader ("Nf3", "g1f3", "knight to
 * f3", "seahorse f3", "castle kingside") and the at-a-glance facts the
 * companion is told each turn (mate in one, threats, loose pieces).
 */
(function () {
  "use strict";
  const FILES = "abcdefgh";
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const SLIDES = { r: ROOK_DIRS, b: BISHOP_DIRS, q: [...ROOK_DIRS, ...BISHOP_DIRS] };

  const other = (c) => (c === "w" ? "b" : "w");
  const sqName = (s) => FILES[s & 7] + ((s >> 3) + 1);
  const sqParse = (t) => (/^[a-h][1-8]$/.test(t) ? FILES.indexOf(t[0]) + (Number(t[1]) - 1) * 8 : -1);
  /** The square `df` files and `dr` ranks from `s`, or -1 off the board. */
  function step(s, df, dr) {
    const f = (s & 7) + df, r = (s >> 3) + dr;
    return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
  }

  let nextId = 1;
  /** The starting position. noQueen: "w" or "b" plays without its queen (odds). */
  function initial({ noQueen = null } = {}) {
    const board = Array(64).fill(null), back = "rnbqkbnr";
    for (let f = 0; f < 8; f++) {
      board[f] = { t: back[f], c: "w", id: nextId++ };
      board[8 + f] = { t: "p", c: "w", id: nextId++ };
      board[48 + f] = { t: "p", c: "b", id: nextId++ };
      board[56 + f] = { t: back[f], c: "b", id: nextId++ };
    }
    if (noQueen) board[noQueen === "w" ? 3 : 59] = null;
    return { board, turn: "w", castle: { wk: true, wq: true, bk: true, bq: true }, ep: -1, half: 0, full: 1 };
  }

  /** The squares of `by`'s pieces that attack `sq`. */
  function attackers(board, sq, by) {
    const out = [];
    const pawnFrom = by === "w" ? -1 : 1;   // a white pawn attacks from the rank below
    for (const df of [-1, 1]) {
      const s = step(sq, df, pawnFrom);
      if (s >= 0 && board[s]?.c === by && board[s].t === "p") out.push(s);
    }
    for (const [jumps, t] of [[KNIGHT, "n"], [KING, "k"]]) {
      for (const [df, dr] of jumps) {
        const s = step(sq, df, dr);
        if (s >= 0 && board[s]?.c === by && board[s].t === t) out.push(s);
      }
    }
    for (const [dirs, kinds] of [[ROOK_DIRS, "rq"], [BISHOP_DIRS, "bq"]]) {
      for (const [df, dr] of dirs) {
        let s = step(sq, df, dr);
        while (s >= 0 && !board[s]) s = step(s, df, dr);
        if (s >= 0 && board[s].c === by && kinds.includes(board[s].t)) out.push(s);
      }
    }
    return out;
  }

  const kingSq = (board, c) => board.findIndex((p) => p && p.t === "k" && p.c === c);
  /** Is `c`'s king attacked in position `s`? */
  function inCheck(s, c = s.turn) {
    const k = kingSq(s.board, c);
    return k >= 0 && attackers(s.board, k, other(c)).length > 0;
  }

  /** Every move the side to move could make, before asking whether it
   *  leaves their own king in check. Castling is checked fully here. */
  function pseudo(s) {
    const out = [], { board, turn: c } = s, o = other(c), fwd = c === "w" ? 1 : -1;
    for (let sq = 0; sq < 64; sq++) {
      const pc = board[sq];
      if (!pc || pc.c !== c) continue;
      const add = (to, extra = {}) => out.push({ from: sq, to, piece: pc.t, captured: board[to]?.t || null, ...extra });
      if (pc.t === "p") {
        const last = c === "w" ? 7 : 0, start = c === "w" ? 1 : 6;
        const push = (to, extra = {}) => {
          if ((to >> 3) === last) for (const promo of "qrbn") add(to, { ...extra, promo });
          else add(to, extra);
        };
        const one = step(sq, 0, fwd);
        if (one >= 0 && !board[one]) {
          push(one);
          const two = step(sq, 0, 2 * fwd);
          if ((sq >> 3) === start && !board[two]) add(two, { double: true });
        }
        for (const df of [-1, 1]) {
          const to = step(sq, df, fwd);
          if (to < 0) continue;
          if (board[to] && board[to].c === o) push(to);
          else if (to === s.ep) add(to, { ep: true, captured: "p" });
        }
      } else if (pc.t === "n" || pc.t === "k") {
        for (const [df, dr] of pc.t === "n" ? KNIGHT : KING) {
          const to = step(sq, df, dr);
          if (to >= 0 && board[to]?.c !== c) add(to);
        }
        const home = c === "w" ? 4 : 60;
        if (pc.t === "k" && sq === home && !attackers(board, home, o).length) {
          const rookAt = (r) => board[r]?.t === "r" && board[r].c === c;
          const safe = (...sqs) => sqs.every((x) => !board[x] && !attackers(board, x, o).length);
          if (s.castle[c + "k"] && rookAt(home + 3) && safe(home + 1, home + 2)) add(home + 2, { castle: "k" });
          if (s.castle[c + "q"] && rookAt(home - 4) && !board[home - 3] && safe(home - 1, home - 2)) add(home - 2, { castle: "q" });
        }
      } else {
        for (const [df, dr] of SLIDES[pc.t]) {
          let to = step(sq, df, dr);
          while (to >= 0) {
            if (board[to]) { if (board[to].c === o) add(to); break; }
            add(to);
            to = step(to, df, dr);
          }
        }
      }
    }
    return out;
  }

  /** The position after move `m` (from legal() or pseudo()). */
  function make(s, m) {
    const n = { board: s.board.slice(), turn: other(s.turn), castle: { ...s.castle }, ep: -1,
                half: s.half + 1, full: s.full + (s.turn === "b" ? 1 : 0) };
    const b = n.board, pc = b[m.from];
    b[m.from] = null;
    if (m.ep) b[m.to + (pc.c === "w" ? -8 : 8)] = null;
    b[m.to] = m.promo ? { t: m.promo, c: pc.c, id: pc.id } : pc;
    if (m.castle === "k") { b[m.from + 1] = b[m.from + 3]; b[m.from + 3] = null; }
    if (m.castle === "q") { b[m.from - 1] = b[m.from - 4]; b[m.from - 4] = null; }
    if (pc.t === "p" || m.captured) n.half = 0;
    if (m.double) n.ep = (m.from + m.to) / 2;
    if (pc.t === "k") n.castle[pc.c + "k"] = n.castle[pc.c + "q"] = false;
    for (const [corner, right] of [[0, "wq"], [7, "wk"], [56, "bq"], [63, "bk"]]) {
      if (m.from === corner || m.to === corner) n.castle[right] = false;
    }
    return n;
  }

  const legal = (s) => pseudo(s).filter((m) => !inCheck(make(s, m), s.turn));

  /** Standard algebraic notation for `m`, with + or #. */
  function san(s, m, moves = null) {
    let t;
    if (m.castle) t = m.castle === "k" ? "O-O" : "O-O-O";
    else {
      let dis = "";
      if (m.piece !== "p") {
        const rivals = (moves || legal(s)).filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
        if (rivals.length) {
          const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
          const sameRank = rivals.some((o) => (o.from >> 3) === (m.from >> 3));
          dis = !sameFile ? FILES[m.from & 7] : !sameRank ? String((m.from >> 3) + 1) : sqName(m.from);
        }
      } else if (m.captured) dis = FILES[m.from & 7];
      t = (m.piece === "p" ? "" : m.piece.toUpperCase()) + dis + (m.captured ? "x" : "") + sqName(m.to)
        + (m.promo ? "=" + m.promo.toUpperCase() : "");
    }
    const n = make(s, m);
    if (inCheck(n)) t += legal(n).length ? "+" : "#";
    return t;
  }

  /** The legal moves, each with its .san. */
  function legalSan(s) {
    const moves = legal(s);
    for (const m of moves) m.san = san(s, m, moves);
    return moves;
  }

  /** The repetition key: what FIDE counts as "the same position" (pieces,
   *  side to move, castling rights, and en passant only when it can be taken). */
  function key(s) {
    let k = s.board.map((p) => (p ? (p.c === "w" ? p.t.toUpperCase() : p.t) : ".")).join("") + s.turn
      + ["wk", "wq", "bk", "bq"].filter((r) => s.castle[r]).join("");
    if (s.ep >= 0 && legal(s).some((m) => m.ep)) k += sqName(s.ep);
    return k;
  }

  /** Neither side can ever mate: K v K, K+minor v K, K+B v K+B on one colour. */
  function insufficient(board) {
    const rest = [];
    board.forEach((p, sq) => { if (p && p.t !== "k") rest.push({ ...p, sq }); });
    if (rest.some((p) => "pqr".includes(p.t))) return false;
    if (rest.length <= 1) return true;
    const shade = (sq) => ((sq & 7) + (sq >> 3)) % 2;
    return rest.every((p) => p.t === "b") && rest.every((p) => shade(p.sq) === shade(rest[0].sq));
  }

  /** Is the game over in `s`? keys: every position's key so far, this one last. */
  function status(s, keys = []) {
    const moves = legal(s), check = inCheck(s);
    if (!moves.length) return check ? { over: "checkmate", winner: other(s.turn) } : { over: "stalemate" };
    if (insufficient(s.board)) return { over: "material" };
    if (s.half >= 100) return { over: "fifty" };
    const now = keys[keys.length - 1];
    if (now && keys.filter((k) => k === now).length >= 3) return { over: "repetition" };
    return { over: null, check };
  }

  function material(board) {
    const m = { w: 0, b: 0 };
    for (const p of board) if (p) m[p.c] += VALUE[p.t];
    return m;
  }

  function fen(s) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = "", empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = s.board[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p.c === "w" ? p.t.toUpperCase() : p.t;
      }
      rows.push(row + (empty || ""));
    }
    const castle = ["wk", "wq", "bk", "bq"].filter((r) => s.castle[r])
      .map((r) => (r[0] === "w" ? r[1].toUpperCase() : r[1])).join("") || "-";
    return `${rows.join("/")} ${s.turn} ${castle} ${s.ep >= 0 ? sqName(s.ep) : "-"} ${s.half} ${s.full}`;
  }

  /** The board as text, rank 8 at the top. */
  function ascii(s) {
    const lines = ["  a b c d e f g h"];
    for (let r = 7; r >= 0; r--) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const p = s.board[r * 8 + f];
        row.push(p ? (p.c === "w" ? p.t.toUpperCase() : p.t) : ".");
      }
      lines.push(`${r + 1} ${row.join(" ")}`);
    }
    return lines.join("\n");
  }

  // ---- Reading a move, forgivingly ----------------------------------------

  const PIECE_WORDS = {
    p: ["pawn", "crab"], n: ["knight", "seahorse", "sea horse", "horse"], b: ["bishop", "parrot"],
    r: ["rook", "lighthouse", "tower"], q: ["queen", "kraken"], k: ["king", "captain"],
  };
  const norm = (t) => t.replace(/[+#!?=()\s]/g, "").replace(/0/g, "O").replace(/[x:-]/gi, "");

  /** The legal move meant by `text`: { move } or { error }. `moves` from legalSan(). */
  function parseMove(text, moves) {
    const raw = String(text ?? "").trim().replace(/^\d+\.(\.\.)?\s*/, "").replace(/([1-8])\s*e\.?p\.?$/i, "$1");
    if (!raw) return { error: "No move given." };
    const lower = raw.toLowerCase();
    const one = (list) => (list.length === 1 ? { move: list[0] } : null);

    // 1. Notation as written: "Nf3", "exd5", "e8=Q", "O-O", "nf3".
    const n = norm(raw);
    const exact = moves.filter((m) => norm(m.san) === n);
    if (exact.length) return { move: exact[0] };
    const loose = moves.filter((m) => norm(m.san).toLowerCase() === n.toLowerCase());
    if (one(loose)) return one(loose);

    // 2. Castling in words.
    if (/castl|o-o|0-0/.test(lower)) {
      const want = /o-o-o|0-0-0|queen\s*side|long/.test(lower) ? "q" : /o-o|0-0|king\s*side|short/.test(lower) ? "k" : null;
      const castles = moves.filter((m) => m.castle && (!want || m.castle === want));
      if (castles.length === 1) return { move: castles[0] };
      if (castles.length > 1) return { error: "Castle which way: O-O (kingside) or O-O-O (queenside)?" };
      return { error: "You can't castle that way right now." };
    }

    // Piece words, in the order they're said: the first moves, a second is
    // what a pawn promotes to ("pawn to e8, queen").
    const said = [];
    for (const [t, words] of Object.entries(PIECE_WORDS)) {
      for (const w of words) {
        const at = lower.search(new RegExp(`\\b${w}s?\\b`));
        if (at >= 0) { said.push({ t, at }); break; }
      }
    }
    said.sort((a, b) => a.at - b.at);
    // Notation that names a piece ("Bg5", "nf3") means that piece, never
    // just the square: "Bg5" with no bishop able to go there is refused,
    // not read as the pawn move g5. (A lowercase b is a pawn's file.)
    const letter = /^([KQRNkqrn]|B)[a-h]?[1-8]?[x:-]?[a-h][1-8]/.exec(raw.replace(/\s/g, ""))?.[1];
    const piece = letter ? letter.toLowerCase() : said[0]?.t || null;

    // 3. A move inside a sentence: "I'll play Nf3!" (not when pieces are named:
    //    "knight to f3" must not read as the pawn move f3).
    if (!said.length) {
      for (const token of raw.split(/[\s,;]+/)) {
        const hit = moves.filter((m) => norm(m.san) === norm(token));
        if (hit.length === 1) return { move: hit[0] };
      }
    }

    // 4. Squares: "g1f3", "g1-f3", "e7e8q", "knight to f3", "e8 kraken".
    const squares = [...lower.matchAll(/([a-h])\s*([1-8])/g)].map((x) => sqParse(x[1] + x[2]));
    const letterPromo = /[a-h][1-8][-\s]?[a-h][1-8]\s*=?\(?([qrbn])\)?$/.exec(lower)?.[1];
    const promoWant = letterPromo || (said.length > 1 ? said[said.length - 1].t : null);
    let cands = [];
    if (squares.length >= 2) cands = moves.filter((m) => m.from === squares[0] && m.to === squares[squares.length - 1]);
    else if (squares.length === 1) {
      cands = moves.filter((m) => m.to === squares[0] && (!piece || m.piece === piece));
      if (!cands.length && piece && piece !== "p") cands = moves.filter((m) => m.to === squares[0] && m.promo === piece);
    }
    if (cands.length > 1 && cands.every((m) => m.promo)) {
      const want = promoWant && promoWant !== "p" ? promoWant : piece && piece !== "p" ? piece : "q";
      cands = cands.filter((m) => m.promo === want);
    }
    if (cands.length === 1) return { move: cands[0] };
    if (cands.length > 1) return { error: `"${raw}" could be ${cands.map((m) => m.san).join(" or ")}: say which.` };
    if (squares.length === 1 && piece) {
      return { error: `"${raw}" isn't a legal move here: none of your ${PIECE_WORDS[piece][0]}s can move to ${sqName(squares[0])}.` };
    }
    if (squares.length) return { error: `"${raw}" isn't a legal move here.` };
    return { error: `Couldn't read a move in "${raw}".` };
  }

  // ---- What a player sees at a glance ---------------------------------------

  /** For the side to move: legal moves (with SAN), whether they're in check,
   *  their mates in one, the other side's mate threats, their pieces that
   *  are attacked and loose, and captures that win material. */
  function analyse(s) {
    const c = s.turn, o = other(c), moves = legalSan(s), check = inCheck(s);
    const mates = moves.filter((m) => m.san.endsWith("#")).map((m) => m.san);
    // What would they do if it were their move? (A null move; not when in check.)
    const threats = check ? [] : legalSan({ ...s, turn: o, ep: -1 }).filter((m) => m.san.endsWith("#")).map((m) => m.san);
    const cost = (sq) => (s.board[sq].t === "k" ? 100 : VALUE[s.board[sq].t]);
    const danger = [];
    s.board.forEach((p, sq) => {
      if (!p || p.c !== c || p.t === "k") return;
      const atk = attackers(s.board, sq, o);
      if (!atk.length) return;
      const defended = attackers(s.board, sq, c).length > 0;
      const cheapest = atk.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      if (!defended || cost(cheapest) < VALUE[p.t]) danger.push({ sq, t: p.t, by: s.board[cheapest].t, defended });
    });
    danger.sort((a, b) => VALUE[b.t] - VALUE[a.t]);
    for (const m of moves) m.trade = trade(s, m);
    const captures = moves.filter((m) => m.captured && m.trade.net > 0)
      .map((m) => ({ san: m.san, captured: m.captured, net: m.trade.net, free: m.trade.free }))
      .sort((a, b) => b.net - a.net);
    // Moves that hand material over: the piece lands where it can be taken
    // for less than it's worth (a queen taking a defended pawn).
    const losing = moves.filter((m) => m.trade.net < 0 && !m.san.endsWith("#"))
      .map((m) => ({ san: m.san, piece: m.promo || m.piece, loss: -m.trade.net, captured: m.captured }))
      .sort((a, b) => b.loss - a.loss);
    return { moves, check, mates, threats, danger, captures, losing };
  }

  /** What a move wins or loses on its square, counting one exchange there:
   *  what it takes, minus what the reply takes back. Defended, the mover is
   *  lost only to a cheaper attacker (and gets that attacker back);
   *  undefended, it is simply lost. { net, free } in pawns. */
  function trade(s, m) {
    const c = s.turn, o = other(c);
    const gained = (m.captured ? VALUE[m.captured] : 0) + (m.promo ? VALUE[m.promo] - 1 : 0);
    const after = make(s, m);
    const atk = attackers(after.board, m.to, o);
    if (!atk.length) return { net: gained, free: true };
    const mover = VALUE[m.promo || m.piece];
    const cost = (sq) => (after.board[sq].t === "k" ? 100 : VALUE[after.board[sq].t]);
    const cheapest = Math.min(...atk.map(cost));
    const defended = attackers(after.board, m.to, c).length > 0;
    if (cheapest === 100 && defended) return { net: gained, free: false };   // only their king, and it can't take a guarded piece
    const lost = defended ? Math.max(0, mover - cheapest) : mover;
    return { net: gained - lost, free: false };
  }

  window.RexChess = {
    FILES, VALUE, other, sqName, sqParse, initial, attackers, inCheck, legal, legalSan, make, san,
    key, status, material, fen, ascii, parseMove, analyse, PIECE_WORDS,
  };
})();
