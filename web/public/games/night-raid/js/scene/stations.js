// Night Raid: where the crew stand and how they walk the Rexmaw's deck, in
// SHIP SPACE (R.shipSpace: +Z bow, +X PORT, y = the deck under their feet;
// measured from rexmaw_deck.glb / tools/scenes/build_rexmaw_deck.py, see
// blocking.js). For the crew module (js/avatar/crew.js): parent figures to
// R.shipSpace, stand them on these spots, walk them along the graph.
//
//   STATIONS[station] = [{x, y, z, yaw, side?, prop?}, ...]   first spots first
//       yaw: degrees, 0 = facing the bow (+Z), positive turns toward +X (port)
//       side: "port" | "starboard" where a station has two sides (boarding)
//       prop: what they work at ("gun", "pump", "powder", "lines", "wheel", ...)
//   WALK = {nodes: [{id, x, y, z, deck}], edges: [[a, b], ...]}   ids are indices
//   nearestNode(x, y, z) → node index (on the same deck level when it can)
//   walkPath(from {x,y,z}, to {x,y,z}) → [{x, y, z}, ...] (start, graph nodes, end)
//   deckHeight(x, z) → the deck's y at a ship-space spot (main 0, quarterdeck 2.6,
//       forecastle 1.6, the stairs in between)
//
// Decks: main y = 0 (z −4.5 … 14), quarterdeck y = 2.6 (z −12.5 … −4.5, reached
// by the two stairs at x = ±3.45 rising from z −1.9 to −4.3), forecastle y = 1.6
// (z > 14, a step up either side of its front wall's doors). Obstacles the
// graph walks round: the main hatch (|x| < 1.0, z 3.8 … 5.4, cargo on it), the
// mainmast's fife rail (|x| < 0.8, z 7.2 … 8.0), the deck guns at z ≈ 3.2
// (|x| 2.6 … 3.7), crates (x ≈ 3.3) and barrels (x ≈ −3.4) at z 0.5 … 1.6, the
// wheel (z −6.9 … −7.2) and the binnacle (z −6.0) on the centreline, the
// mizzen (z −9.8), the foremast (z 16). The bulwark's inner face is |x| ≈ 4.05
// amidships, narrowing forward of z ≈ 9.

const D = Object.freeze;
const s = (x, y, z, yaw, extra = {}) => D({ x, y, z, yaw, ...extra });

/** Station spots (see the header). Guns: the spots are the gun crews' places inboard of the guns. */
export const STATIONS = D({
  // At the four deck guns a side (deckprops.js: z −0.6, 3.2, 5.8, 9.4), then the powder monkeys between them.
  guns_port: D([
    s(2.3, 0, 3.2, 90, { prop: "gun" }), s(2.3, 0, 5.8, 90, { prop: "gun" }), s(2.3, 0, -0.6, 90, { prop: "gun" }),
    s(2.25, 0, 9.4, 90, { prop: "gun" }), s(2.25, 0, 4.5, 60, { prop: "gun" }), s(2.2, 0, 8.0, 60, { prop: "gun" }),
  ]),
  guns_starboard: D([
    s(-2.3, 0, 3.2, -90, { prop: "gun" }), s(-2.3, 0, 5.8, -90, { prop: "gun" }), s(-2.3, 0, -0.6, -90, { prop: "gun" }),
    s(-2.25, 0, 9.4, -90, { prop: "gun" }), s(-2.25, 0, 4.5, -60, { prop: "gun" }), s(-2.2, 0, 8.0, -60, { prop: "gun" }),
  ]),
  bow_chaser: D([s(0, 1.6, 16.9, 0, { prop: "gun" }), s(0.9, 1.6, 17.2, -20, { prop: "gun" }), s(-0.9, 1.6, 17.2, 20, { prop: "gun" })]),
  sails: D([
    s(1.2, 0, 6.8, 0, { prop: "lines" }), s(-1.2, 0, 6.8, 0, { prop: "lines" }), s(3.1, 0, 8.3, 70, { prop: "lines" }),
    s(-3.1, 0, 8.3, -70, { prop: "lines" }), s(1.3, 1.6, 15.0, 0, { prop: "lines" }), s(-1.3, 1.6, 15.0, 0, { prop: "lines" }),
  ]),
  damage: D([
    s(1.6, 0, 3.4, 150, { prop: "patch" }), s(-1.6, 0, 3.4, -150, { prop: "patch" }), s(3.3, 0, 6.2, 90, { prop: "patch" }),
    s(-3.3, 0, 6.2, -90, { prop: "patch" }), s(3.2, 0, 10.8, 90, { prop: "patch" }), s(-3.2, 0, 10.8, -90, { prop: "patch" }),
  ]),
  pumps: D([s(0.75, 0, 6.45, -90, { prop: "pump" }), s(-0.75, 0, 6.45, 90, { prop: "pump" }), s(0, 0, 5.75, 0, { prop: "pump" })]),
  lookout: D([
    s(-1.1, 1.6, 18.7, -10, { prop: "spyglass" }), s(1.1, 1.6, 18.7, 10, { prop: "spyglass" }),
    s(0, 12.9, 8.0, 0, { prop: "spyglass", aloft: true }),
  ]),
  powder: D([s(0.9, 0, 2.55, -90, { prop: "powder" }), s(-0.9, 0, 2.55, 90, { prop: "powder" }), s(0, 0, 1.75, 0, { prop: "powder" })]),
  boarding: D([
    s(3.3, 0, 5.8, 90, { side: "port" }), s(3.25, 0, 7.6, 90, { side: "port" }), s(3.2, 0, 9.8, 90, { side: "port" }), s(3.3, 0, 4.2, 90, { side: "port" }),
    s(-3.3, 0, 5.8, -90, { side: "starboard" }), s(-3.25, 0, 7.6, -90, { side: "starboard" }), s(-3.2, 0, 9.8, -90, { side: "starboard" }), s(-3.3, 0, 4.2, -90, { side: "starboard" }),
  ]),
  galley: D([s(-2.1, 0, 12.4, -45, { prop: "galley" }), s(-1.5, 0, 13.0, -80, { prop: "galley" })]),
  // Rexmaw Raids: the deck mortar (deckprops.js, B.MORTAR at (1.0, 0, 11.4)): the layer astern of it, a loader each side.
  mortar: D([s(1.0, 0, 10.1, 0, { prop: "mortar" }), s(2.3, 0, 11.4, -90, { prop: "mortar" }), s(-0.3, 0, 11.6, 90, { prop: "mortar" })]),
  quarterdeck: D([
    s(-1.45, 2.6, -5.2, 20, { prop: "wheel" }), s(1.4, 2.6, -5.6, -20), s(-1.6, 2.6, -7.6, 10), s(1.6, 2.6, -7.8, -10), s(0, 2.6, -10.9, 0),
  ]),
});

/** The deck's height at a ship-space spot (the stairs ramp between the main deck and the quarterdeck). */
export function deckHeight(x, z) {
  const ax = Math.abs(x);
  if (z <= -4.5) return 2.6;
  if (ax > 3.0 && ax < 3.95 && z < -1.9 && z > -4.5) return Math.min(2.6, ((-1.9 - z) / 2.4) * 2.6);
  if (z >= 14) return 1.6;
  return 0;
}

// ---- The walk graph ---------------------------------------------------------------------------

const N = [];
const node = (id, x, y, z, deck) => { N.push(D({ id: N.length, name: id, x, y, z, deck })); return N.length - 1; };
const E = [];
const link = (a, b) => E.push(D([a, b]));
const chain = (...ids) => { for (let i = 0; i < ids.length - 1; i++) link(ids[i], ids[i + 1]); };

// The main deck: two gun lanes (port +X, starboard −X), a centre line broken by the hatch and the fife rail.
const P = {}, Sb = {}, C = {};
for (const [k, z] of [["aft", -3.2], ["a", -1.0], ["b", 2.2], ["c", 5.0], ["d", 7.8], ["e", 10.8], ["f", 13.1]]) {
  const half = k === "aft" ? 1.6 : k === "f" ? 1.9 : 2.25;
  P[k] = node(`main.port.${k}`, half, 0, z, "main");
  Sb[k] = node(`main.stbd.${k}`, -half, 0, z, "main");
}
// Centre line: aft of the powder kegs (z 2.55), then forward of the mainmast; the kegs, the hatch, the pump
// (z 6.45) and the fife rail fill the middle, so the lanes carry everyone past them.
for (const [k, z] of [["door", -3.7], ["a", -2.0], ["b", 0.9], ["e", 9.2], ["f", 12.4]]) C[k] = node(`main.centre.${k}`, 0, 0, z, "main");
chain(P.aft, P.a, P.b, P.c, P.d, P.e, P.f);
chain(Sb.aft, Sb.a, Sb.b, Sb.c, Sb.d, Sb.e, Sb.f);
chain(C.door, C.a, C.b);
chain(C.e, C.f);
// Cross links where the centre is clear.
link(P.aft, C.door); link(Sb.aft, C.door);
link(P.a, C.a); link(Sb.a, C.a);
link(P.b, C.b); link(Sb.b, C.b);
link(P.d, C.e); link(Sb.d, C.e);
link(P.e, C.e); link(Sb.e, C.e);
link(P.f, C.f); link(Sb.f, C.f);
// The rails (boarding, damage control): outboard of the lanes, between the guns.
const railP = [node("rail.port.c", 3.3, 0, 5.8, "main"), node("rail.port.d", 3.25, 0, 7.6, "main"), node("rail.port.e", 3.2, 0, 9.8, "main")];
const railS = [node("rail.stbd.c", -3.3, 0, 5.8, "main"), node("rail.stbd.d", -3.25, 0, 7.6, "main"), node("rail.stbd.e", -3.2, 0, 9.8, "main")];
chain(...railP); chain(...railS);
link(railP[0], P.c); link(railP[1], P.d); link(railP[2], P.e);
link(railS[0], Sb.c); link(railS[1], Sb.d); link(railS[2], Sb.e);

// The stairs to the quarterdeck, both sides (foot → head).
const stairP = [node("stairs.port.foot", 3.45, 0, -1.6, "stairs"), node("stairs.port.mid", 3.45, 1.3, -3.1, "stairs"), node("stairs.port.head", 3.4, 2.6, -4.75, "qd")];
const stairS = [node("stairs.stbd.foot", -3.45, 0, -1.6, "stairs"), node("stairs.stbd.mid", -3.45, 1.3, -3.1, "stairs"), node("stairs.stbd.head", -3.4, 2.6, -4.75, "qd")];
chain(...stairP); chain(...stairS);
link(stairP[0], P.a); link(stairS[0], Sb.a);

// The quarterdeck.
const Q = {
  pf: node("qd.port.fwd", 2.3, 2.6, -5.4, "qd"), sf: node("qd.stbd.fwd", -2.3, 2.6, -5.4, "qd"),
  cf: node("qd.centre.fwd", 0, 2.6, -5.3, "qd"),
  pw: node("qd.port.wheel", 1.6, 2.6, -7.4, "qd"), sw: node("qd.stbd.wheel", -1.6, 2.6, -7.4, "qd"),
  pa: node("qd.port.aft", 1.5, 2.6, -9.6, "qd"), sa: node("qd.stbd.aft", -1.5, 2.6, -9.6, "qd"),
  ca: node("qd.centre.aft", 0, 2.6, -11.0, "qd"),
};
link(stairP[2], Q.pf); link(stairS[2], Q.sf);
chain(Q.sf, Q.cf, Q.pf);
chain(Q.pf, Q.pw, Q.pa, Q.ca, Q.sa, Q.sw, Q.sf);

// The forecastle (a step up beside its front wall's doors).
const F = {
  ps: node("fc.port.step", 1.9, 1.6, 14.6, "fc"), ss: node("fc.stbd.step", -1.9, 1.6, 14.6, "fc"),
  p: node("fc.port", 1.2, 1.6, 16.6, "fc"), st: node("fc.stbd", -1.2, 1.6, 16.6, "fc"),
  bow: node("fc.bow", 0, 1.6, 18.3, "fc"),
};
link(P.f, F.ps); link(Sb.f, F.ss);
chain(F.ps, F.p, F.bow, F.st, F.ss);

/** The deck walk graph (ship space). */
export const WALK = D({ nodes: D(N), edges: D(E) });

const adj = N.map(() => []);
for (const [a, b] of E) {
  const d = Math.hypot(N[a].x - N[b].x, N[a].y - N[b].y, N[a].z - N[b].z);
  adj[a].push([b, d]); adj[b].push([a, d]);
}

/** The node nearest a ship-space spot (preferring the same deck level). */
export function nearestNode(x, y, z) {
  let best = 0, bd = Infinity;
  for (const n of N) {
    const d = Math.hypot(n.x - x, (n.y - y) * 3, n.z - z);
    if (d < bd) { bd = d; best = n.id; }
  }
  return best;
}

/** A walk from one ship-space spot to another: [{x, y, z}] (start, the graph's nodes, end). Dijkstra over ~50 nodes. */
export function walkPath(from, to) {
  const a = nearestNode(from.x, from.y ?? deckHeight(from.x, from.z), from.z);
  const b = nearestNode(to.x, to.y ?? deckHeight(to.x, to.z), to.z);
  const dist = new Float64Array(N.length).fill(Infinity), prev = new Int32Array(N.length).fill(-1), done = new Uint8Array(N.length);
  dist[a] = 0;
  for (;;) {
    let u = -1, ud = Infinity;
    for (let i = 0; i < N.length; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
    if (u < 0 || u === b) break;
    done[u] = 1;
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
  }
  const path = [];
  for (let u = b; u >= 0; u = prev[u]) { path.push(u); if (u === a) break; }
  path.reverse();
  const out = [{ x: from.x, y: from.y ?? deckHeight(from.x, from.z), z: from.z }];
  for (const i of path) out.push({ x: N[i].x, y: N[i].y, z: N[i].z });
  out.push({ x: to.x, y: to.y ?? deckHeight(to.x, to.z), z: to.z });
  // Drop a first/last node that only doubles back.
  if (out.length > 3 && Math.hypot(out[0].x - out[2].x, out[0].z - out[2].z) < Math.hypot(out[1].x - out[2].x, out[1].z - out[2].z)) out.splice(1, 1);
  if (out.length > 3) {
    const L = out.length;
    if (Math.hypot(out[L - 1].x - out[L - 3].x, out[L - 1].z - out[L - 3].z) < Math.hypot(out[L - 2].x - out[L - 3].x, out[L - 2].z - out[L - 3].z)) out.splice(L - 2, 1);
  }
  return out;
}
