/*
 * Rexmaw Chess: the pieces, in costume. Inline SVG (no emoji or chess-font
 * glyphs: WSL's headless Chrome has neither). Classes, coloured per side in
 * the page's CSS: .b body, .d detail line, .k ink (eyes, buttons), .g gold,
 * .s stripe, .beam the lighthouse's light.
 *
 *   crab = pawn, seahorse = knight, parrot = bishop, lighthouse = rook,
 *   Kraken (in a tiara) = queen, the Captain = king. Nobody knows what the
 *   Captain looks like (see the crew's lore), so the Captain is a hat.
 */
(function () {
  "use strict";
  const PLINTH = '<path class="b" d="M25 92h50a3 3 0 0 0 3-3v-2a6 6 0 0 0-6-6H28a6 6 0 0 0-6 6v2a3 3 0 0 0 3 3z"/>';
  const eye = (x, y, r = 4, look = 0) => `<circle class="w" cx="${x}" cy="${y}" r="${r}"/><circle class="k" cx="${x + look}" cy="${y}" r="${r * 0.5}"/>`;

  const ART = {
    // Crab: claws up, eyes on stalks.
    p: '<path class="d" d="M35 72l-10 8M33 66l-13 3M65 72l10 8M67 66l13 3M38 58l-9-12M62 58l9-12M45 54v-9M55 54v-9"/>'
      + '<ellipse class="b" cx="50" cy="66" rx="19" ry="13"/>'
      + '<path class="b" d="M27 40L32.4 32.8A9 9 0 1 0 35.95 39.06Z"/><path class="b" d="M73 40L67.6 32.8A9 9 0 1 1 64.05 39.06Z"/>'
      + eye(45, 43, 4) + eye(55, 43, 4)
      + '<path class="d" d="M44 69q6 5 12 0"/>',
    // Seahorse: facing left, like every knight; crest, back fin, belly ridges.
    n: '<path class="b" d="M52 13L54 4l4 6 4-5 1 9z"/><path class="b" d="M67 28l11 3-8 5 9 4-10 4z"/>'
      + '<path class="b" d="M60 12C50 8 40 12 37 20L22 22C17 23 17 30 22 31L37 31C38 37 42 41 46 43C38 50 36 62 44 72L41 82H70C64 72 63 62 67 52C73 42 74 26 66 17C64 14 62 13 60 12Z"/>'
      + eye(47, 21, 4.5, -1)
      + '<path class="d" d="M48 52q4 1.5 8 0M47 59q5 1.5 10 0M48 66q5 1.5 10 0"/>',
    // Parrot: crest, hooked beak, folded wing.
    b: '<path class="b" d="M44 17L37 5l10 8 2-12 5 12 8-8-5 13z"/>'
      + '<path class="b" d="M40 36C30 48 32 68 42 82H60C69 66 68 46 60 36Z"/>'
      + '<circle class="b" cx="50" cy="28" r="13"/>'
      + '<path class="g" d="M60 22C71 21 75 33 66 39C66 34 63 32 59 32Z"/>'
      + eye(52, 26, 4, 1)
      + '<path class="d" d="M43 47C38 57 41 69 50 76M48 50c-2 7 0 13 5 17"/>',
    // Lighthouse: striped tower, gallery, lit lamp room, beams.
    r: '<path class="beam" d="M58 22L90 13V33ZM42 22L10 13V33Z"/>'
      + '<path class="b" d="M37 82L41 38H59L63 82Z"/>'
      + '<path class="s" d="M39.6 54H60.4L61.3 64H38.7Z"/>'
      + '<path class="b" d="M34 33h32v6H34z"/><path class="d" d="M37 33v-4M44 33v-4M56 33v-4M63 33v-4"/>'
      + '<path class="b" d="M41 17h18v16H41z"/><path class="g" d="M44 20h12v10H44z"/>'
      + '<path class="b" d="M38 18L50 7 62 18z"/><circle class="b" cx="50" cy="6" r="2.5"/>'
      + '<path class="k" d="M47 82v-7a3 3 0 0 1 6 0v7z"/>',
    // Kraken: a mantle with shifty eyes, tentacles, and a tiara (she's the queen).
    q: '<path class="b" d="M33 42C31 56 22 64 13 66C19 75 30 73 35 65C35 73 32 79 27 82H73C68 79 65 73 65 65C70 73 81 75 87 66C78 64 69 56 67 42Z"/>'
      + '<path class="d" d="M45 60q-1 11-6 20M55 60q1 11 6 20M50 60v20"/>'
      + '<path class="b" d="M50 9C67 9 73 27 68 41C65 49 58 52 50 52C42 52 35 49 32 41C27 27 33 9 50 9Z"/>'
      + eye(42, 34, 5.5, 2) + eye(58, 34, 5.5, 2)
      + '<path class="d" d="M45 45q5 3 10-1"/>'
      + '<path class="g" d="M38 16L40 5l5 6 5-9 5 9 5-6 2 11Q50 12 38 16Z"/>',
    // The Captain: tricorn, coat, epaulettes, and a face nobody has ever described.
    k: '<path class="b" d="M29 82C29 66 35 55 44 50H56C65 55 71 66 71 82Z"/>'
      + '<path class="d" d="M50 52L44 68M50 52L56 68"/><circle class="k" cx="50" cy="70" r="2"/><circle class="k" cx="50" cy="76" r="2"/>'
      + '<ellipse class="g" cx="38" cy="55" rx="7" ry="3.2"/><ellipse class="g" cx="62" cy="55" rx="7" ry="3.2"/>'
      + '<circle class="b" cx="50" cy="40" r="11"/>'
      + '<text class="q" x="50" y="46.5" text-anchor="middle">?</text>'
      + '<path class="b" d="M21 32C34 35 40 25 50 23C60 25 66 35 79 32C73 20 62 12 50 12C38 12 27 20 21 32Z"/>'
      + '<path class="gd" d="M25 30C36 32 42 24 50 22C58 24 64 32 75 30M50 3v9M46 6.5h8"/>',
  };

  /** A piece's SVG markup. */
  const svg = (t) => `<svg viewBox="4 0 92 96" aria-hidden="true">${ART[t]}${PLINTH}</svg>`;

  // What the pieces are called: on the board, and to the companion.
  const NAME = { p: "crab", n: "seahorse", b: "parrot", r: "lighthouse", q: "Kraken", k: "Captain" };
  const CHESS = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

  window.RexChessPieces = { svg, NAME, CHESS };
})();
