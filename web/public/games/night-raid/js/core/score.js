// The tally: what a mission was worth. Pure arithmetic, no three.js, no DOM.
//
//   score({ outcome, loot, sunk, captured, medals:{time,hull,loot}, hull, free })
//   → { outcome:"win"|"loss", lines:[{key, label, count, points}], total, stars, doubloons }
//
// A success +500, gold one for one, every ship sunk +50, every ship taken
// +100, medals by tier (gold 300, silver 200, bronze 100), hull left ×2 on a
// success. Stars: one per medal category won (free roam: the hull and loot
// medals plus one for banking anything). The kit's outcome is the user's:
// "win" on a success.

import { SCORE } from "./const.js";

export function score({ outcome = "fail", loot = 0, sunk = 0, captured = 0, medals = {}, hull = 0, free = false } = {}) {
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const ok = outcome === "success";
  const tiers = Object.values(medals || {}).filter(Boolean);
  const medalPts = tiers.reduce((a, t) => a + (SCORE.medal[t] || 0), 0);
  const lines = [
    { key: "success", label: "Mission complete", count: ok ? 1 : 0, points: ok ? SCORE.success : 0 },
    { key: "gold", label: free ? "Plunder banked" : "Gold gathered", count: n(loot), points: n(loot) * SCORE.gold },
    { key: "sunk", label: "Ships sunk", count: n(sunk), points: n(sunk) * SCORE.sunk },
    { key: "captured", label: "Ships taken", count: n(captured), points: n(captured) * SCORE.captured },
    { key: "medals", label: "Medals", count: tiers.length, points: medalPts },
    { key: "hull", label: "Hull home", count: ok ? n(hull) : 0, points: ok ? n(hull) * SCORE.hull : 0 },
  ];
  const total = lines.reduce((s, l) => s + l.points, 0);
  let stars = Math.min(3, tiers.length + (free && ok && n(loot) > 0 ? 1 : 0));
  if (!ok) stars = 0;
  return { outcome: ok ? "win" : "loss", lines, total, stars, doubloons: Math.floor(total / SCORE.perDoubloon) };
}
