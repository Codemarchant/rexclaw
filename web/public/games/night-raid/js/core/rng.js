// Seeded randomness for Rexmaw Raids (copied from Night Helm's). Everything in core/ that rolls a die
// rolls it here (Math.random is banned in core/), so a voyage can be
// replayed exactly: the tests seed it, "Tonight's run" seeds it from the
// local date so everyone sails the same water that night, and the results
// screen shows the seed so a good run can be sailed again.
//
//   const r = createRng(42);
//   r.next()            → [0, 1)
//   r.int(3, 97)        → an integer in [3, 97]
//   r.range(2, 5)       → a float in [2, 5)
//   r.pick(list)        → one element
//   r.shuffle(list)     → the same array, shuffled in place
//   r.chance(0.3)       → true 30% of the time
//   r.fork("hazards")   → an independent stream, derived from this seed and a label
//
// No three.js, no DOM.

/**
 * A 32-bit string hash (FNV-1a with a final avalanche), for turning dates and
 * labels into seeds.
 * @param {string} text
 * @returns {number} an unsigned 32-bit integer
 */
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * mulberry32: a small, fast generator with a full 2^32 period, plenty for a
 * party game.
 * @param {number} seed
 * @returns {() => number} each call → [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fresh, unpredictable seed for an ordinary voyage: the platform's crypto
 * source when there is one, else the clocks.
 * @returns {number}
 */
export function freshSeed() {
  try {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  } catch {
    const t = (globalThis.performance?.now?.() ?? 0) * 1000;
    return hashString(`${Date.now()}:${t}`);
  }
}

/**
 * The local calendar day as "YYYY-MM-DD" ("Tonight's run": the voyage is the
 * same for everyone on that date, wherever they are).
 * @param {Date} [date]
 * @returns {string}
 */
export function dateKey(date = new Date()) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

/** Whether `key` looks like a "YYYY-MM-DD" date. */
export function isDateKey(key) {
  return typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/**
 * The seed of a night's shared run: the date and the mode hashed together,
 * so each mode tab has its own water tonight.
 * @param {string} date  "YYYY-MM-DD"
 * @param {string} mode
 * @returns {number}
 */
export function dailySeed(date, mode) {
  return hashString(`night-raid:${date}:${mode}`);
}

/**
 * @typedef {Object} Rng
 * @property {number} seed          the seed it was made from
 * @property {() => number} next    [0, 1)
 * @property {(lo: number, hi: number) => number} int   an integer in [lo, hi], both inclusive
 * @property {(lo: number, hi: number) => number} range a float in [lo, hi)
 * @property {<T>(list: T[]) => T} pick                  one element (undefined for an empty list)
 * @property {<T>(list: T[]) => T[]} shuffle             Fisher-Yates, in place; returns the list
 * @property {(p: number) => boolean} chance             true with probability p
 * @property {() => number} sign                         −1 or +1, evenly
 * @property {(label: string|number) => Rng} fork        an independent stream for a sub-task
 */

/**
 * A seeded generator with the helpers the voyage needs.
 * @param {number|string} [seed]  a number, or any string (hashed); omitted: a fresh seed
 * @returns {Rng}
 */
export function createRng(seed = freshSeed()) {
  const s = typeof seed === "number" && Number.isFinite(seed) ? seed >>> 0 : hashString(String(seed));
  const next = mulberry32(s);
  const rng = {
    seed: s,
    next,
    int(lo, hi) {
      const a = Math.ceil(Math.min(lo, hi)), b = Math.floor(Math.max(lo, hi));
      return a + Math.floor(next() * (b - a + 1));
    },
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (list) => (list && list.length ? list[Math.floor(next() * list.length)] : undefined),
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    fork: (label) => createRng(hashString(`${s}:${label}`)),
  };
  return rng;
}
