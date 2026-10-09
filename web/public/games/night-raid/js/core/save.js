// Rexmaw Raids' save: per mission the best medal in each category (time,
// hull, loot), the best time, plays and completions; totals; the last few
// runs (seeds to sail again). It lives in the kit's per-companion game save
// next to the kit's own keys, which this file never touches (points, record,
// streak, bestStreak, best, lastPlayed, mode).
//
//   migrate(saved)                       fill in / repair, safe on {} and junk (and on a v1 Night Raid save)
//   recordMission(saved, results)        → { newBest, newMedals:[{cat, tier}], first }   (recordNight is an alias)
//   isFirst(saved) / markStarted(saved)  the first run: the coach rides along
//   summary(saved) / bestFor(saved, id) / recordFor(saved, id) / prune(saved)
//
// Everything mutates the save object it is given; the caller calls game.save().
// Pure: no three.js, no DOM.

import { SAVE_BUDGET, MISSION_IDS, MISSIONS, MEDAL_TIERS, MEDAL_CATS } from "./const.js";

export const SAVE_VERSION = 2;
export const RECENT_MAX = 12;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const int0 = (v) => Math.max(0, Math.floor(num(v)));
const TOTAL_KEYS = ["missions", "done", "gold", "sunk", "captured", "pickups", "seconds", "orders", "medals"];
const tierRank = (t) => (t ? MEDAL_TIERS.length - MEDAL_TIERS.indexOf(t) : 0);   // gold 3, silver 2, bronze 1, none 0
const better = (a, b) => (tierRank(a) >= tierRank(b) ? a : b);

function blankMission() { return { plays: 0, done: 0, bestTime: null, best: { time: null, hull: null, loot: null }, score: 0 }; }

export function migrate(saved) {
  const s = isObj(saved) ? saved : {};
  s.v = SAVE_VERSION;
  const seen = isObj(s.seen) ? s.seen : {};
  s.seen = { ...seen, first: !!seen.first };
  const ms = isObj(s.missions) ? s.missions : {};
  s.missions = {};
  for (const id of MISSION_IDS) {
    const m = isObj(ms[id]) ? ms[id] : {};
    const b = isObj(m.best) ? m.best : {};
    s.missions[id] = {
      plays: int0(m.plays), done: int0(m.done), bestTime: Number.isFinite(m.bestTime) ? m.bestTime : null,
      best: Object.fromEntries(MEDAL_CATS.map((c) => [c, MEDAL_TIERS.includes(b[c]) ? b[c] : null])), score: int0(m.score),
    };
  }
  const t = isObj(s.totals) ? s.totals : {};
  s.totals = {};
  for (const k of TOTAL_KEYS) s.totals[k] = int0(t[k]);
  s.recent = Array.isArray(s.recent) ? s.recent.filter((r) => isObj(r) && Number.isFinite(r.seed) && MISSIONS[r.mission]).slice(-RECENT_MAX) : [];
  // v1 Night Raid keys that no longer mean anything.
  for (const k of ["records", "daily", "nights", "homes", "sinkings", "medals"]) delete s[k];
  s.summary = summary(s);
  return s;
}

export function markStarted(saved) { saved.seen = { ...(saved.seen || {}), first: true }; }

/** Keep a finished mission. */
export function recordMission(saved, results) {
  if (!isObj(saved.missions)) migrate(saved);
  const id = MISSIONS[results.mission] ? results.mission : null;
  const t = saved.totals;
  const add = (k, v) => { t[k] = int0(t[k]) + int0(v); };
  const ok = results.outcome === "success";
  add("missions", 1);
  if (ok) add("done", 1);
  add("gold", results.loot);
  add("sunk", results.sunk?.length);
  add("captured", results.captured?.length);
  add("pickups", results.stats?.pickups);
  add("seconds", results.elapsed);
  add("orders", results.orders?.companion);
  const out = { newBest: false, newMedals: [], first: false };
  if (!id) return out;
  const m = saved.missions[id] || (saved.missions[id] = blankMission());
  m.plays++;
  if (ok) {
    out.first = m.done === 0;
    m.done++;
    if (!results.free && (m.bestTime == null || results.elapsed < m.bestTime)) { m.bestTime = Math.round(results.elapsed * 10) / 10; out.newBest = true; }
    for (const c of MEDAL_CATS) {
      const got = results.medals?.[c] || null;
      if (got && tierRank(got) > tierRank(m.best[c])) { out.newMedals.push({ cat: c, tier: got }); add("medals", 1); }
      m.best[c] = better(got, m.best[c]);
    }
  }
  if ((results.score?.total || 0) > m.score) { m.score = results.score.total; out.newBest = true; }
  saved.recent.push({ seed: results.seed, mission: id, outcome: results.outcome, score: results.score?.total || 0, stars: results.score?.stars || 0 });
  while (saved.recent.length > RECENT_MAX) saved.recent.shift();
  saved.summary = summary(saved);
  return out;
}

/** "5 of 7 missions done · 6 gold medals · 4,850 gold". */
export function summary(saved) {
  const ms = saved?.missions || {};
  const played = Object.values(ms).filter((m) => m?.plays > 0).length;
  if (!played) return "No raids yet: the Rexmaw waits at the pier";
  const story = MISSION_IDS.filter((id) => !MISSIONS[id].free);
  const done = story.filter((id) => ms[id]?.done > 0).length;
  const golds = Object.values(ms).reduce((a, m) => a + MEDAL_CATS.filter((c) => m?.best?.[c] === "gold").length, 0);
  return [`${done} of ${story.length} missions done`, `${golds} gold medal${golds === 1 ? "" : "s"}`, `${int0(saved?.totals?.gold).toLocaleString("en")} gold`].join(" · ");
}

export function byteSize(value) {
  const s = JSON.stringify(value ?? null);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** Keep the save under budget: the oldest recent runs go first. */
export function prune(saved, budget = SAVE_BUDGET) {
  let dropped = 0, bytes = byteSize(saved);
  while (bytes > budget && saved.recent?.length) { saved.recent.shift(); dropped++; bytes = byteSize(saved); }
  return { bytes, dropped };
}
