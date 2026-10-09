// Night Raid: where the crew stand and how they get there (ship space).
//
// Ship space is the GLB's frame (scene/blocking.js): +Y up, bow +Z, port +X,
// starboard −X; yaw 0 faces the bow and + turns toward port (+X). Main deck
// y 0, quarterdeck floor y 2.6 over z −12.5…−4.5 (its forward rail at
// z −4.54 for |x| < 2.95), stairs down to the main deck at x ±3.45 (top
// z −4.65 at 2.6 m, foot z −1.7), the mainmast at z +8 (fife rail
// |x| < 0.85, z 7.0…8.3), the mizzen at z −9.8 on the quarterdeck, the wheel
// at z −6.88 with the binnacle at −6.0, the hatch amidships (|x| < 1,
// z 3.8…5.4, cargo on it), the lashed guns at x ±3.25, z 3.2, barrels at
// x −3.4 and crates at x +3.35 around z 0.5…1.3, the forecastle (y 1.6) from
// z 14 to the stem, no stairs up to it in the GLB.
//
// STATIONS below is the crew module's own provisional table; the scene's
// table (createCrew's `stations`, the spec's STATIONS[station] =
// [{x, y, z, yaw}…], yaw in degrees) replaces it station by station.
// WALK is the provisional deck walk graph (lanes clear of masts, hatch,
// guns, the binnacle and the stairs' rails); the scene's `walkGraph`
// replaces it whole. Both shapes are read forgivingly (see normalize*).

import * as THREE from "three";

/** Station spots: ship-space feet position and facing (degrees). Several spots per station, filled in order. */
export const STATIONS = Object.freeze({
  quarterdeck: [{ x: -1.45, y: 2.6, z: -5.2, yaw: 20 }, { x: 1.55, y: 2.6, z: -5.25, yaw: -20 }, { x: -2.2, y: 2.6, z: -8.3, yaw: 10 }, { x: 2.2, y: 2.6, z: -8.3, yaw: -10 }],
  guns_port: [{ x: 2.3, y: 0, z: 3.2, yaw: 90 }, { x: 2.3, y: 0, z: -0.3, yaw: 90 }, { x: 2.3, y: 0, z: 10.4, yaw: 90 }, { x: 2.3, y: 0, z: 6.6, yaw: 90 }],
  guns_starboard: [{ x: -2.3, y: 0, z: 3.2, yaw: -90 }, { x: -2.3, y: 0, z: -0.3, yaw: -90 }, { x: -2.3, y: 0, z: 10.4, yaw: -90 }, { x: -2.3, y: 0, z: 6.6, yaw: -90 }],
  bow_chaser: [{ x: 0.55, y: 0, z: 12.9, yaw: 0 }, { x: -0.55, y: 0, z: 12.9, yaw: 0 }],
  sails: [{ x: -2.95, y: 0, z: 9.3, yaw: -55 }, { x: 2.95, y: 0, z: 9.3, yaw: 55 }, { x: -2.6, y: 2.6, z: -10.6, yaw: -60 }],
  damage: [{ x: -2.85, y: 0, z: 5.7, yaw: -90 }, { x: 2.85, y: 0, z: 5.7, yaw: 90 }, { x: -2.85, y: 0, z: 1.9, yaw: -90 }],
  pumps: [{ x: -1.55, y: 0, z: 6.45, yaw: 0 }, { x: 1.55, y: 0, z: 6.45, yaw: 0 }],
  lookout: [{ x: -2.75, y: 0, z: 12.3, yaw: -35 }, { x: 2.75, y: 0, z: 12.3, yaw: 35 }, { x: -1.4, y: 2.6, z: -11.6, yaw: 180 }],
  powder: [{ x: -1.3, y: 0, z: 4.6, yaw: 90 }, { x: 1.3, y: 0, z: 4.6, yaw: -90 }],
  boarding: [{ x: -2.55, y: 0, z: 1.8, yaw: -90 }, { x: 2.55, y: 0, z: 1.8, yaw: 90 }, { x: -2.55, y: 0, z: -0.9, yaw: -90 }, { x: 2.55, y: 0, z: -0.9, yaw: 90 }],
  galley: [{ x: -1.55, y: 0, z: -3.45, yaw: 180 }, { x: -0.6, y: 0, z: -3.45, yaw: 180 }],
});

/** Where a member with no station waits: their own corner of the deck. */
export const HOME = Object.freeze({
  rex: { x: 0.9, y: 0, z: -2.4, yaw: 0 },
  eve: { x: -0.9, y: 2.6, z: -5.3, yaw: 10 },
  ara: { x: -1.2, y: 0, z: -3.1, yaw: 160 },
  sal: { x: 2.05, y: 2.6, z: -6.5, yaw: -110 },          // by their positioning rig (1.35, −6.1)
  leo: { x: 0.0, y: 2.6, z: -5.1, yaw: 0 },
  me: { x: -1.45, y: 2.6, z: -5.2, yaw: 20 },
});

/** The provisional walk graph: two lanes along the main deck, cross-overs, the stairs, the quarterdeck. */
export const WALK = Object.freeze((() => {
  const nodes = [];
  const edges = [];
  const n = (id, x, y, z) => nodes.push({ id, x, y, z });
  for (const [s, k] of [[1, "P"], [-1, "S"]]) {
    n(`${k}a`, s * 2.3, 0, -1.4); n(`${k}b`, s * 2.3, 0, 1.6); n(`${k}c`, s * 2.3, 0, 4.6);
    n(`${k}d`, s * 2.3, 0, 7.6); n(`${k}e`, s * 2.25, 0, 10.4); n(`${k}f`, s * 2.1, 0, 12.8);
    n(`${k}foot`, s * 3.45, 0, -1.7); n(`${k}top`, s * 3.45, 2.6, -4.65);
    n(`${k}qa`, s * 2.6, 2.6, -5.05); n(`${k}qb`, s * 2.35, 2.6, -8.1); n(`${k}qc`, s * 1.6, 2.6, -11.3);
    edges.push([`${k}a`, `${k}b`], [`${k}b`, `${k}c`], [`${k}c`, `${k}d`], [`${k}d`, `${k}e`], [`${k}e`, `${k}f`],
      [`${k}a`, `${k}foot`], [`${k}foot`, `${k}top`, "stairs"], [`${k}top`, `${k}qa`], [`${k}qa`, `${k}qb`], [`${k}qb`, `${k}qc`]);
  }
  n("Caft", 0, 0, -2.6); n("Cmid", 0, 0, 1.6); n("Cfwd", 0, 0, 10.5); n("Cbow", 0, 0, 12.8);
  n("Qmid", 0, 2.6, -5.1); n("Qaft", 0, 2.6, -11.6);
  edges.push(["Pa", "Caft"], ["Sa", "Caft"], ["Pb", "Cmid"], ["Sb", "Cmid"], ["Caft", "Cmid"], ["Pe", "Cfwd"], ["Se", "Cfwd"],
    ["Pf", "Cbow"], ["Sf", "Cbow"], ["Cfwd", "Cbow"], ["Pqa", "Qmid"], ["Sqa", "Qmid"], ["Pqc", "Qaft"], ["Sqc", "Qaft"]);
  /** Things a straight walk must not cross (circles r, boxes x0..x1/z0..z1), each on one deck (y). */
  const obstacles = [
    { kind: "box", y: 0, x0: -1.55, x1: 1.55, z0: 3.6, z1: 6.0 },            // hatch and cargo
    { kind: "box", y: 0, x0: -0.95, x1: 0.95, z0: 6.95, z1: 8.4 },           // mainmast and fife rail
    { kind: "box", y: 0, x0: -0.75, x1: 0.75, z0: 6.1, z1: 6.8 },            // the scene's chain pump (blocking B.PUMP)
    { kind: "box", y: 0, x0: -0.7, x1: 0.7, z0: 2.1, z1: 3.0 },              // the scene's powder kegs (B.POWDER)
    { kind: "box", y: 0, x0: -3.4, x1: -2.2, z0: 12.5, z1: 13.6 },           // the scene's galley brazier (B.GALLEY)
    // the deck guns, four a side (deckprops.js DECK_GUNS_Z)
    ...[-0.6, 3.2, 5.8, 9.4].flatMap((z) => [
      { kind: "box", y: 0, x0: 2.6, x1: 3.95, z0: z - 0.45, z1: z + 0.45 },
      { kind: "box", y: 0, x0: -3.95, x1: -2.6, z0: z - 0.45, z1: z + 0.45 },
    ]),
    { kind: "circle", y: 1.6, x: 0, z: 16, r: 0.45 },                        // foremast
    { kind: "box", y: 0, x0: 2.9, x1: 3.9, z0: 0.1, z1: 1.6 },              // crates
    { kind: "box", y: 0, x0: -3.9, x1: -2.4, z0: 0.0, z1: 1.7 },            // barrels
    { kind: "box", y: 0, x0: -4.5, x1: 4.5, z0: -9, z1: -4.45 },            // the cabin under the quarterdeck
    { kind: "box", y: 2.6, x0: -0.45, x1: 0.45, z0: -7.3, z1: -5.75 },      // wheel and binnacle
    { kind: "box", y: 2.6, x0: 1.0, x1: 1.75, z0: -6.45, z1: -5.75 },       // Sal's positioning rig
    { kind: "circle", y: 2.6, x: 0, z: -9.8, r: 0.5 },                       // mizzen
    { kind: "box", y: 2.6, x0: -2.95, x1: 2.95, z0: -4.6, z1: -4.0 },       // quarterdeck forward rail
  ];
  return { nodes, edges, obstacles };
})());

const toV = (o) => (Array.isArray(o) ? new THREE.Vector3(+o[0] || 0, +o[1] || 0, +o[2] || 0)
  : Array.isArray(o?.pos) ? new THREE.Vector3(+o.pos[0] || 0, +o.pos[1] || 0, +o.pos[2] || 0)
    : new THREE.Vector3(+o?.x || 0, +o?.y || 0, +o?.z || 0));

/** A spot from the scene's table: {pos: Vector3, yaw (radians)}. Degrees unless `yawRad` is given. */
function normalizeSpot(s) {
  // A spot aloft (the masthead) is off the walk graph: nobody climbs there.
  if (!s || s.aloft) return null;
  const pos = toV(s);
  if (![pos.x, pos.y, pos.z].every(Number.isFinite)) return null;
  const yaw = Number.isFinite(s.yawRad) ? s.yawRad : Number.isFinite(s.yaw) ? THREE.MathUtils.degToRad(s.yaw)
    : Number.isFinite(s.faceYawDeg) ? THREE.MathUtils.degToRad(s.faceYawDeg) : 0;
  return { pos, yaw, fixture: s.fixture ?? null, side: s.side ?? null, prop: s.prop ?? null };
}

/** Station table: ours, with the scene's stations laid over it. */
export function normalizeStations(scene = null) {
  const out = {};
  for (const [k, list] of Object.entries(STATIONS)) out[k] = list.map(normalizeSpot);
  if (scene && typeof scene === "object") {
    for (const [k, list] of Object.entries(scene)) {
      const arr = (Array.isArray(list) ? list : [list]).map(normalizeSpot).filter(Boolean);
      if (arr.length) out[k] = arr;
    }
  }
  return out;
}

/**
 * The walk graph, from any of: {nodes: [{id, x, y, z, links?}], edges?: [[a, b, kind?] | {a, b} | {from, to}]},
 * {nodes: {id: {x, y, z} | [x, y, z]}}. Returns {nodes: Map(id → {id, p, links: Map(id → kind)}), obstacles}.
 */
export function normalizeGraph(g = null) {
  const src = g && (g.nodes || g.edges) ? g : WALK;
  const nodes = new Map();
  const list = Array.isArray(src.nodes) ? src.nodes : Object.entries(src.nodes || {}).map(([id, v]) => ({ id, ...(Array.isArray(v) ? { pos: v } : v) }));
  for (const nd of list) {
    const id = String(nd.id ?? nd.name ?? nodes.size);
    nodes.set(id, { id, p: toV(nd), links: new Map() });
  }
  const link = (a, b, kind = null) => {
    const A = nodes.get(String(a)), B = nodes.get(String(b));
    if (!A || !B || A === B) return;
    const k = kind || (Math.abs(A.p.y - B.p.y) > 0.4 ? "stairs" : "deck");
    A.links.set(B.id, k); B.links.set(A.id, k);
  };
  for (const nd of list) for (const to of nd.links || nd.neighbors || nd.to || []) link(nd.id ?? nd.name, to);
  for (const e of src.edges || []) {
    if (Array.isArray(e)) link(e[0], e[1], e[2]);
    else if (e) link(e.a ?? e.from, e.b ?? e.to, e.kind);
  }
  // The scene's graph carries no obstacles: the same ship's (ours, from the GLB and deckprops) keep shortcuts honest.
  const obstacles = Array.isArray(src.obstacles) ? src.obstacles : WALK.obstacles;
  return { nodes, obstacles };
}

/** Does the straight walk a→b (same deck) cross an obstacle? */
function blocked(a, b, obstacles) {
  for (const o of obstacles) {
    if (Math.abs((o.y ?? 0) - a.y) > 0.8 || Math.abs((o.y ?? 0) - b.y) > 0.8) continue;
    const steps = Math.max(2, Math.ceil(a.distanceTo(b) / 0.2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (o.kind === "circle" ? Math.hypot(x - o.x, z - o.z) < o.r : x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return true;
    }
  }
  return false;
}

/** The node to step onto from p: nearest on the same deck with a clear walk to it (else just the nearest there). */
function entry(graph, p) {
  let best = null, bd = Infinity, clear = null, cd = Infinity;
  for (const nd of graph.nodes.values()) {
    if (Math.abs(nd.p.y - p.y) > 0.8) continue;
    const d = Math.hypot(nd.p.x - p.x, nd.p.z - p.z);
    if (d < bd) { bd = d; best = nd; }
    if (d < cd && !blocked(p, nd.p, graph.obstacles)) { cd = d; clear = nd; }
  }
  return clear || best;
}

/**
 * A walk from `from` to `to` (ship-space Vector3s) over the graph: [{p: Vector3, kind: "deck"|"stairs"}…],
 * first point `from`, last `to`. A straight walk when it's clear and on one deck.
 */
export function route(graph, from, to) {
  const out = [{ p: from.clone(), kind: "deck" }];
  const sameDeck = Math.abs(from.y - to.y) < 0.8;
  if (sameDeck && !blocked(from, to, graph.obstacles)) { out.push({ p: to.clone(), kind: "deck" }); return out; }
  const A = entry(graph, from), B = entry(graph, to);
  if (!A || !B) { out.push({ p: to.clone(), kind: sameDeck ? "deck" : "stairs" }); return out; }
  // Dijkstra (the graph is a few dozen nodes); stairs cost a little more.
  const dist = new Map([[A.id, 0]]), prev = new Map(), open = new Set([A.id]), done = new Set();
  while (open.size) {
    let cur = null, cd = Infinity;
    for (const id of open) { const d = dist.get(id); if (d < cd) { cd = d; cur = id; } }
    open.delete(cur);
    if (cur === B.id) break;
    done.add(cur);
    const C = graph.nodes.get(cur);
    for (const [nid, kind] of C.links) {
      if (done.has(nid)) continue;
      const nd = graph.nodes.get(nid);
      const d = cd + C.p.distanceTo(nd.p) * (kind === "stairs" ? 1.3 : 1);
      if (d < (dist.get(nid) ?? Infinity)) { dist.set(nid, d); prev.set(nid, cur); open.add(nid); }
    }
  }
  const chain = [];
  if (A.id === B.id || prev.has(B.id)) {
    for (let id = B.id; id; id = prev.get(id)) { chain.unshift(id); if (id === A.id) break; }
  }
  if (!chain.length) { out.push({ p: to.clone(), kind: sameDeck ? "deck" : "stairs" }); return out; }
  let last = graph.nodes.get(chain[0]);
  out.push({ p: last.p.clone(), kind: "deck" });
  for (let i = 1; i < chain.length; i++) {
    const nd = graph.nodes.get(chain[i]);
    out.push({ p: nd.p.clone(), kind: last.links.get(nd.id) || "deck" });
    last = nd;
  }
  out.push({ p: to.clone(), kind: Math.abs(last.p.y - to.y) > 0.4 ? "stairs" : "deck" });
  // Smooth: skip a waypoint when the walk past it is clear and stays on one deck.
  for (let i = 1; i < out.length - 1;) {
    const a = out[i - 1].p, b = out[i + 1].p;
    if (out[i].kind !== "stairs" && out[i + 1].kind !== "stairs" && Math.abs(a.y - b.y) < 0.2 && Math.abs(out[i].p.y - a.y) < 0.2
      && !blocked(a, b, graph.obstacles)) out.splice(i, 1);
    else i++;
  }
  return out.filter((w, i) => i === 0 || w.p.distanceTo(out[i - 1].p) > 0.04);
}

/** The Rexmaw's hull half-width at deck level (m), from the deck builder's hw(). */
export function hullHalfWidth(z) {
  const W = 4.2;
  if (z < -5) return W - 0.6 * Math.min(1, (-z - 5) / 7.5) ** 2;
  if (z > 6) { const t = Math.min(0.999, (z - 6) / 14); return Math.max(0.03, W * Math.sqrt(1 - t * t)); }
  return W;
}

/** Inside face of the bulwark (x, on `side` ±1) and its rail top (y) at z, for a figure standing at height y. */
export function railAt(z, y, side) {
  const x = side * (hullHalfWidth(z) - 0.15);
  const top = z > 14 && y > 1.0 ? 2.5 : y > 1.3 ? 3.6 : 1.1;     // forecastle, quarterdeck, main deck
  return { x, top };
}
