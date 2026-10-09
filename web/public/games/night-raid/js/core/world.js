// The bay (spec v2 §2): one seeded 1.8 km bay laid out for a mission. Islands
// (blob polygons with shoals), a fort with four gun towers, wrecks, the
// maelstrom, a storm cell, reefs and rocks (hidden in darkness and fog: only
// the companion's chart knows them), fog banks, the smugglers' cove, convoy
// routes and patrol beats, the fleet that starts on them, and the collectables
// (a few off the direct route). Everything comes from the seed and the mission.
//
//   generateWorld(seed, missionId) → world (shape in nightraid-interfaces.md, "core API")
//   arenaWorld(seed, {enemy, range, bearing, heading}) → open water, one enemy (duels, tests)
//   validateWorld(world)  → [problems]
//   navPath(world, from, to, {pad, avoid, reefs}) → [{x,z}] or null
//   isWater(world, x, z, pad, {reefs, shoals}) ; hazardsOf(world) → reefs + shoals as one list
//
// Pure: no three.js, no DOM, no Math.random.

import { createRng } from "./rng.js";
import { BAY, PORT, ISLANDS, FORT, WRECKS, MAELSTROM, STORM, COVE, WIND, MISSIONS, NAMES, CLASSES, REEFS, REEF_NAMES, EXIT, PICKUP,
  DEFAULT_MISSION, BOTTLE_NOTES, CAPE_NAMES } from "./const.js";
import { clamp, dist, polyDist, polylineDist, wrap360, headingOf, capsuleDist, forward, metres } from "./geom.js";

const ISLAND_NAMES = ["Gull Rock", "Hangman's Key", "Lantern Isle", "Brine Tooth", "Widow's Shoal", "Coral Crown", "Driftwood Cay",
  "Parrot Point", "Skull Knoll", "Mermaid's Rest", "Blackreed Isle", "Old Molar", "Kettle Key", "Thimble Isle"];
const R1 = (v) => Math.round(v * 10) / 10;

/** A blob polygon around (cx, cz): radius R with smooth seeded wobble, CCW. */
function blob(rng, cx, cz, R, n = ISLANDS.verts) {
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(rng.range(0.74, 1.1));
  const poly = [];
  for (let i = 0; i < n; i++) {
    const k = (raw[(i + n - 1) % n] + 2 * raw[i] + raw[(i + 1) % n]) / 4;
    const a = (i / n) * Math.PI * 2;
    poly.push({ x: R1(cx + Math.cos(a) * R * k), z: R1(cz + Math.sin(a) * R * k) });
  }
  return poly;
}

const inBay = (x, z, margin = 0) => x > BAY.minX + margin && x < BAY.maxX - margin && z > BAY.minZ + margin && z < BAY.maxZ - margin;

function pickName(rng, cls, used) {
  const pool = (NAMES[cls] || NAMES.brig).filter((n) => !used.has(n));
  const name = rng.pick(pool.length ? pool : NAMES[cls] || NAMES.brig);
  used.add(name);
  return name;
}

/** A reef band (capsule a–b, half-width w) or a rock (a = b). */
function reef(id, name, kind, ax, az, bx, bz, w) {
  const x = (ax + bx) / 2, z = (az + bz) / 2;
  return { id, name, kind, a: { x: R1(ax), z: R1(az) }, b: { x: R1(bx), z: R1(bz) }, w: R1(w), x: R1(x), z: R1(z),
    r: R1(dist(ax, az, bx, bz) / 2 + w) };
}

/**
 * Generate a mission's bay.
 * @param {number} seed
 * @param {string} missionId  a MISSIONS id (unknown → the default mission)
 */
export function generateWorld(seed, missionId = DEFAULT_MISSION) {
  const M = MISSIONS[missionId] || MISSIONS[DEFAULT_MISSION];
  const id = M.id;
  const r = createRng(seed).fork(`world:${id}`);
  // The night's variant (v3): its own stream, so the bay's layout draws stay put.
  const vr = createRng(seed).fork(`variant:${id}`);
  const variant = { id: "", label: "", bonus: null };
  const ORD = ["first", "second", "third"];
  const night = M.time === "night";
  const wind = { dirDeg: Math.round(r.range(0, 360)), strength: Math.round(r.range(WIND.strength[0], WIND.strength[1]) * 100) / 100 };
  const port = { x: PORT.x, z: PORT.z, r: PORT.r };
  const start = { x: 0, z: 50, heading: 0 };
  const used = new Set();
  const islands = [], reefs = [], fog = [], routes = [], fleet = [], wrecks = [], pickups = [], maze = [];
  let maelstrom = null, storm = null, cove = null, exit = null, fort = null;
  const keep = [];   // {x, z, r}: discs islands must stay clear of
  const lines = [];  // polylines islands and reefs must stay clear of: {points, loop, pad}
  const names = r.shuffle([...ISLAND_NAMES]);
  const reefNames = r.shuffle([...REEF_NAMES]);
  let reefN = 0, nameN = 0;
  const nextReefName = () => reefNames[nameN++ % reefNames.length];

  const islandFits = (x, z, R) => {
    if (!inBay(x, z, R + 60)) return false;
    if (dist(x, z, port.x, port.z) < R + ISLANDS.clearPort) return false;
    for (const k of keep) if (dist(x, z, k.x, k.z) < R + k.r) return false;
    for (const l of lines) if (polylineDist(x, z, l.points, l.loop) < R + (l.pad ?? ISLANDS.clearRoute)) return false;
    for (const o of islands) if (dist(x, z, o.x, o.z) < R + o.r + ISLANDS.gap) return false;
    for (const rf of reefs) if (capsuleDist(x, z, rf).d < R + 30) return false;
    return true;
  };
  const addIsland = (x, z, R) => {
    const isl = { id: `isl${islands.length + 1}`, name: names[islands.length % names.length], x: Math.round(x), z: Math.round(z), r: 0,
      poly: blob(r, x, z, R), shoals: [] };
    for (const p of isl.poly) isl.r = Math.max(isl.r, dist(x, z, p.x, p.z));
    isl.r = Math.round(isl.r);
    islands.push(isl);
    return isl;
  };
  const scatterIslands = (count, zMin = 250, zMax = BAY.maxZ - 120) => {
    for (let tries = 0; islands.length < count && tries < 1500; tries++) {
      const R = r.range(ISLANDS.size[0] / 2, ISLANDS.size[1] / 2) * (tries > 900 ? 0.6 : 1);
      const x = r.range(BAY.minX + 120, BAY.maxX - 120), z = r.range(zMin, zMax);
      if (islandFits(x, z, R * 1.1)) addIsland(x, z, R);
    }
  };
  const openWater = (x, z, margin) => {
    if (!inBay(x, z, 60)) return false;
    if (dist(x, z, port.x, port.z) < port.r + margin) return false;
    for (const isl of islands) {
      if (dist(x, z, isl.x, isl.z) < isl.r + margin) return false;
      for (const s of isl.shoals) if (dist(x, z, s.x, s.z) < s.r + margin) return false;
    }
    for (const rf of reefs) if (capsuleDist(x, z, rf).d < margin) return false;
    if (maelstrom && dist(x, z, maelstrom.x, maelstrom.z) < maelstrom.r + margin) return false;
    return true;
  };
  /** Scattered reef bands and rocks in open water (not on the routes, not near the port). */
  const scatterReefs = (bands, rocks, { zMin = 280, zMax = BAY.maxZ - 80, clearOf = [] } = {}) => {
    const okAt = (x, z, rad) => {
      if (!inBay(x, z, 40) || z < zMin || z > zMax) return false;
      if (dist(x, z, port.x, port.z) < 300 + rad) return false;
      for (const l of lines) if (polylineDist(x, z, l.points, l.loop) < rad + 45) return false;
      for (const k of [...keep, ...clearOf]) if (dist(x, z, k.x, k.z) < k.r + rad) return false;
      for (const isl of islands) if (dist(x, z, isl.x, isl.z) < isl.r + rad + 25) return false;
      for (const o of reefs) if (dist(x, z, o.x, o.z) < o.r + rad + 50) return false;
      return true;
    };
    for (let n = 0, tries = 0; n < bands && tries < 400; tries++) {
      const L = r.range(REEFS.bandLen[0], REEFS.bandLen[1]), w = r.range(REEFS.bandW[0], REEFS.bandW[1]);
      const x = r.range(BAY.minX + 80, BAY.maxX - 80), z = r.range(zMin, zMax), h = r.range(0, 180);
      if (!okAt(x, z, L / 2 + w)) continue;
      const f = forward(h);
      reefs.push(reef(`reef${++reefN}`, nextReefName(), "reef", x - f.x * L / 2, z - f.z * L / 2, x + f.x * L / 2, z + f.z * L / 2, w));
      n++;
    }
    for (let n = 0, tries = 0; n < rocks && tries < 400; tries++) {
      const rr = r.range(REEFS.rockR[0], REEFS.rockR[1]);
      const x = r.range(BAY.minX + 60, BAY.maxX - 60), z = r.range(zMin, zMax);
      if (!okAt(x, z, rr)) continue;
      reefs.push(reef(`reef${++reefN}`, nextReefName(), "rocks", x, z, x, z, rr));
      n++;
    }
  };
  const addShoals = () => {
    let shoalN = 0;
    for (const isl of islands) {
      if (!r.chance(ISLANDS.shoalChance)) continue;
      const n = r.int(1, 3), a0 = r.range(0, Math.PI * 2);
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 1.1 + r.range(-0.2, 0.2);
        const sr = r.range(ISLANDS.shoalR[0], ISLANDS.shoalR[1]);
        const x = isl.x + Math.cos(a) * (isl.r + sr * 0.6), z = isl.z + Math.sin(a) * (isl.r + sr * 0.6);
        let ok = inBay(x, z, 40) && dist(x, z, port.x, port.z) > PORT.r + 200;
        for (const l of lines) if (polylineDist(x, z, l.points, l.loop) < sr + 40) ok = false;
        for (const k of keep) if (dist(x, z, k.x, k.z) < k.r + sr) ok = false;
        if (ok) isl.shoals.push({ id: `shoal${++shoalN}`, x: Math.round(x), z: Math.round(z), r: Math.round(sr) });
      }
    }
  };
  const addWrecks = (n, zMin = 500, near = null) => {
    for (let tries = 0; wrecks.length < n && tries < 600; tries++) {
      const x = near ? near.x + r.range(-near.r, near.r) : r.range(BAY.minX + 150, BAY.maxX - 150);
      const z = near ? near.z + r.range(-near.r, near.r) : r.range(zMin, BAY.maxZ - 150);
      if (!openWater(x, z, 70) || dist(x, z, port.x, port.z) < 450) continue;
      if (wrecks.some((w) => dist(x, z, w.x, w.z) < 380)) continue;
      wrecks.push({ id: `wreck${wrecks.length + 1}`, x: Math.round(x), z: Math.round(z), heading: Math.round(r.range(0, 360)),
        loot: Math.round(r.range(WRECKS.loot[0], WRECKS.loot[1]) / 10) * 10 });
    }
  };
  const addFog = (n, zMin, zMax, rr = [150, 250], density = 0.85) => {
    for (let i = 0; i < n; i++) {
      fog.push({ x: Math.round(r.range(BAY.minX + 100, BAY.maxX - 100)), z: Math.round(r.range(zMin, zMax)), r: Math.round(r.range(rr[0], rr[1])),
        density: Math.round(r.range(density - 0.1, density + 0.05) * 100) / 100 });
    }
  };
  const addMaelstrom = () => {
    for (let i = 0; i < 400 && !maelstrom; i++) {
      const x = r.range(-620, 620), z = r.range(750, 1500);
      if (dist(x, z, port.x, port.z) < MAELSTROM.minPortDist) continue;
      let ok = true;
      for (const l of lines) if (polylineDist(x, z, l.points, l.loop) < MAELSTROM.r + (i < 250 ? 80 : 30)) ok = false;
      if (ok) maelstrom = { x: Math.round(x), z: Math.round(z), r: MAELSTROM.r, eye: MAELSTROM.eye, ring: [...MAELSTROM.ring] };
    }
    if (maelstrom) keep.push({ x: maelstrom.x, z: maelstrom.z, r: ISLANDS.clearMaelstrom + 40 });
  };
  const fortOn = (isl) => {
    const h = Math.atan2(port.z - isl.z, port.x - isl.x);
    const fx = isl.x + Math.cos(h) * isl.r * 0.82, fz = isl.z + Math.sin(h) * isl.r * 0.82;
    // Four towers along the coast facing the bay, spacing apart.
    const tx = -Math.sin(h), tz = Math.cos(h);
    const towers = [];
    for (let i = 0; i < FORT.towers; i++) {
      const o = (i - (FORT.towers - 1) / 2) * FORT.spacing;
      // Slide each tower onto the coast line (just inside the island).
      let x = fx + tx * o, z = fz + tz * o;
      const pd = polyDist(x, z, isl.poly);
      if (pd.d > -6) { const k = Math.hypot(x - isl.x, z - isl.z) || 1; const want = Math.max(10, k - (pd.d + 10)); x = isl.x + (x - isl.x) / k * want; z = isl.z + (z - isl.z) / k * want; }
      towers.push({ id: `tower${i + 1}`, name: NAMES.tower[i] || `tower ${i + 1}`, x: Math.round(x), z: Math.round(z), hpMax: FORT.towerHp, guns: FORT.towerGuns, range: FORT.range });
    }
    return { id: "fort", x: Math.round(fx), z: Math.round(fz), island: isl.id, towers };
  };
  /** Collectables off the direct route from `a` to `b` (risk/reward). */
  const placePickups = (a, b, kinds) => {
    const L = dist(a.x, a.z, b.x, b.z) || 1;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    let n = 0;
    for (let tries = 0; n < kinds.length && tries < 400; tries++) {
      const t = r.range(0.2, 0.9), side = r.sign(), off = r.range(140, 320);
      const x = a.x + ux * L * t + -uz * off * side, z = a.z + uz * L * t + ux * off * side;
      if (!openWater(x, z, 30)) continue;
      if (pickups.some((p) => dist(x, z, p.x, p.z) < 120)) continue;
      const kind = kinds[n];
      const value = kind === "chest" ? Math.round(r.range(PICKUP.chestGold[0], PICKUP.chestGold[1]) / 10) * 10 : kind === "bottle" ? PICKUP.bottleGold
        : kind === "barrel" ? PICKUP.barrelHull : PICKUP.crateGold;
      const p = { id: `pk${pickups.length + 1}`, kind, x: Math.round(x), z: Math.round(z), value };
      if (kind === "bottle") p.note = r.pick(BOTTLE_NOTES);
      pickups.push(p);
      n++;
    }
  };
  const route = (rid, kind, points, loop = false) => { const rt = { id: rid, kind, points: points.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) })), loop }; routes.push(rt); lines.push({ points: rt.points, loop, pad: 70 }); return rt; };
  const defaultKinds = (chest = true) => ["crate", "barrel", "bottle", "crate", "barrel", ...(chest ? ["chest"] : [])];

  switch (id) {
    case "spice_fleet": {
      const west = r.sign();   // +1: the fleet starts west (+X) and runs east
      const a = { x: west * r.range(560, 700), z: r.range(260, 380) };
      exit = { x: Math.round(-west * r.range(560, 700)), z: Math.round(r.range(1450, 1580)), r: EXIT.r };
      const mid = { x: (a.x + exit.x) / 2 + r.range(-120, 120), z: (a.z + exit.z) / 2 + r.range(-80, 80) };
      route("fleet", "convoy", [a, mid, exit]);
      for (let i = 0; i < 3; i++) fleet.push({ id: `m${i + 1}`, cls: "merchant", name: pickName(r, "merchant", used), role: "objective", route: "fleet", offset: -i * 75, objective: true });
      fleet.push({ id: "g1", cls: "gunboat", name: pickName(r, "gunboat", used), role: "escort", route: "fleet", offset: 60 });
      fleet.push({ id: "g2", cls: "gunboat", name: pickName(r, "gunboat", used), role: "escort", route: "fleet", offset: -200 });
      keep.push({ x: exit.x, z: exit.z, r: EXIT.r + 60 });
      // Variant: which merchant is the prize, the escort, the cape's name.
      const pi = vr.int(0, 2);
      fleet[pi].prize = true;
      const escort = vr.pick(["pair", "trio", "split"]);
      if (escort === "trio") fleet.push({ id: "g3", cls: "gunboat", name: pickName(vr, "gunboat", used), role: "escort", route: "fleet", offset: -90 });
      if (escort === "split") { fleet[3].offset = 140; fleet[4].offset = -260; }
      exit.name = vr.pick(CAPE_NAMES);
      variant.id = `prize${pi + 1}-${escort}`;
      variant.prize = fleet[pi].id; variant.cape = exit.name; variant.escort = escort;
      variant.label = `The prize, ${fleet[pi].name}, sails ${ORD[pi]} in line; ${escort === "trio" ? "three gunboats" : escort === "split" ? "a gunboat ahead and one astern" : "two gunboats"} escort; they run for ${exit.name}.`;
      variant.bonusPick = vr.pick(["board_prize", "rake", "chest"]);
      scatterIslands(r.int(5, 6));
      scatterReefs(r.int(2, 3), r.int(2, 3));
      placePickups(start, mid, defaultKinds());
      break;
    }
    case "silence_fort": {
      const fx = r.range(-300, 300), fz = r.range(1150, 1350), R = r.range(95, 125);
      const isl = addIsland(fx, fz, R);
      fort = fortOn(isl);
      keep.push({ x: fort.x, z: fort.z, r: 380 });   // the approach in front of the guns is open water
      scatterIslands(r.int(5, 6));
      scatterReefs(r.int(2, 3), r.int(2, 4), { clearOf: [{ x: fort.x, z: fort.z, r: 260 }] });
      fleet.push({ id: "g1", cls: "gunboat", name: pickName(r, "gunboat", used), role: "harass", x: fort.x + r.range(-120, 120), z: fort.z - 260, heading: 180 });
      fleet.push({ id: "g2", cls: "gunboat", name: pickName(r, "gunboat", used), role: "harass", x: fort.x + r.range(-120, 120), z: fort.z - 300, heading: 180 });
      placePickups(start, { x: fort.x, z: fort.z - 300 }, ["crate", "crate", "barrel", "bottle", "barrel", "chest"]);
      // Variant: the magazine tower, a third gunboat or not, the approach side.
      const mi = vr.int(0, fort.towers.length - 1);
      fort.towers[mi].magazine = true;
      const three = vr.chance(0.5);
      if (three) fleet.push({ id: "g3", cls: "gunboat", name: pickName(vr, "gunboat", used), role: "harass", x: fort.x + vr.range(-150, 150), z: fort.z - 330, heading: 180 });
      const approach = vr.pick(["west", "south", "east"]);
      variant.id = `mag${mi + 1}-${three ? 3 : 2}-${approach}`;
      variant.magazine = fort.towers[mi].id; variant.approach = approach;
      variant.bonusPick = vr.pick(["magazine", "gunboats", "chest"]);
      // v5: what the garrison sends out when half its towers are down (FORT.sallyAt).
      variant.sally = vr.pick(["brig", "gunboats", "fireship"]);
      variant.id += `-${variant.sally}`;
      variant.label = `The ${fort.towers[mi].name} holds the magazine; ${three ? "three" : "two"} gunboats harass; a firing point ${approach === "south" ? "south" : `south-${approach}`} of the fort; `
        + `when half the towers fall the garrison sends out ${variant.sally === "brig" ? "a brig" : variant.sally === "gunboats" ? "two more gunboats" : "a fire ship"}.`;
      break;
    }
    case "navy_convoy": {
      const west = r.sign();
      const a = { x: west * 820, z: r.range(650, 850) };
      exit = { x: Math.round(-west * 820), z: Math.round(r.range(1150, 1450)), r: EXIT.r };
      const mid = { x: r.range(-150, 150), z: (a.z + exit.z) / 2 + r.range(-60, 160) };
      route("convoy", "convoy", [a, mid, exit]);
      fleet.push({ id: "f1", cls: "frigate", name: pickName(r, "frigate", used), role: "escort", route: "convoy", offset: 40, objective: true });
      fleet.push({ id: "b1", cls: "brig", name: pickName(r, "brig", used), role: "convoy", route: "convoy", offset: -60, chest: true, objective: true });
      fleet.push({ id: "b2", cls: "brig", name: pickName(r, "brig", used), role: "convoy", route: "convoy", offset: -150 });
      keep.push({ x: exit.x, z: exit.z, r: EXIT.r + 60 });
      scatterIslands(r.int(5, 6));
      scatterReefs(r.int(2, 3), r.int(2, 3));
      placePickups(start, mid, defaultKinds());
      // Variant: the goal (sink the frigate, or take the paymaster's chest), which brig carries it, the cape's name.
      const goal = vr.pick(["frigate", "chest"]);
      if (vr.chance(0.5)) { fleet[1].chest = false; fleet[1].objective = false; fleet[2].chest = true; fleet[2].objective = true; }
      const chestShip = fleet.find((f) => f.chest);
      exit.name = vr.pick(CAPE_NAMES);
      variant.id = `${goal}-${chestShip.id}`;
      variant.goal = goal; variant.chest = chestShip.id; variant.frigate = "f1"; variant.cape = exit.name;
      variant.label = goal === "frigate"
        ? `Sink the escort frigate ${fleet[0].name}; the paymaster's chest rides in ${chestShip.name}. They run for ${exit.name}.`
        : `The paymaster's chest rides in the brig ${chestShip.name}, ${chestShip.id === "b1" ? "close behind" : "at the back of"} the convoy; take her intact before ${exit.name}.`;
      variant.bonusPick = goal === "frigate" ? "board_chest" : "sink_frigate";
      // v5: the convoy's call for help once she's attacked: two gunboats out from the cape, or a fire ship cut loose from the convoy.
      // (Never a fire ship on a chest night: her blast would sink the chest with the brig.)
      variant.relief = vr.pick(["gunboats", "fireship"]);
      if (goal === "chest") variant.relief = "gunboats";
      variant.id += `-${variant.relief}`;
      variant.label += ` Attacked, the convoy calls for ${variant.relief === "gunboats" ? "the cape's gunboats" : "its fire ship"}.`;
      break;
    }
    case "iron_duke": {
      keep.push({ x: 0, z: 800, r: 520 });   // open water for the duel
      scatterIslands(r.int(4, 5));
      scatterReefs(1, 2, { clearOf: [{ x: 0, z: 800, r: 520 }] });
      const dx = r.range(-150, 150), dz = r.range(850, 1000);
      // Variant: where she waits (dead ahead, or off a bow) and how she lies.
      const lie = vr.pick(["ahead", "east", "west"]);
      const ox = lie === "east" ? -vr.range(180, 260) : lie === "west" ? vr.range(180, 260) : 0;
      fleet.push({ id: "d1", cls: "manowar", name: "Iron Duke", role: "boss", x: Math.round(clamp(dx + ox, -420, 420)), z: Math.round(dz), heading: lie === "ahead" ? 180 : lie === "east" ? 225 : 135, objective: true });
      placePickups(start, { x: 0, z: 900 }, ["crate", "crate", "barrel", "barrel", "bottle", "chest"]);
      variant.id = `duke-${lie}`; variant.lie = lie;
      variant.label = `The Iron Duke waits ${lie === "ahead" ? "dead ahead in open water" : `off to the ${lie === "east" ? "north-east" : "north-west"}`}, three gun decks and a mortar.`;
      variant.bonusPick = vr.pick(["rake", "chain", "chest"]);
      break;
    }
    case "smugglers_run": {
      // The cove: tucked under an island at the north end.
      const cx = r.range(-380, 380), iz = r.range(1530, 1600), R = r.range(70, 95);
      const isl = addIsland(cx, iz, R);
      cove = { x: Math.round(cx + r.range(-20, 20)), z: Math.round(iz - R - COVE.r * 0.8), r: COVE.r, island: isl.id };
      exit = { x: cove.x, z: cove.z, r: cove.r };
      keep.push({ x: cove.x, z: cove.z, r: COVE.r + 40 });
      // The maze: rows of reef across the bay, each with two gaps that don't line up.
      const rows = [r.range(360, 420), r.range(600, 660), r.range(840, 900), r.range(1080, 1140), r.range(1300, 1350)];
      let prevGaps = [];
      for (let ri = 0; ri < rows.length; ri++) {
        const z0 = rows[ri], nm = nextReefName();
        const gaps = [];
        for (let tries = 0; gaps.length < 2 && tries < 100; tries++) {
          const gx = r.range(BAY.minX + 140, BAY.maxX - 140);
          if (gaps.some((g) => Math.abs(g - gx) < 380)) continue;
          if (prevGaps.some((g) => Math.abs(g - gx) < 220)) continue;
          gaps.push(gx);
        }
        prevGaps = gaps;
        const gw = r.range(95, 125);
        let x = BAY.minX + 10;
        const tilt = r.range(-0.12, 0.12);
        maze.push({ z: Math.round(z0), tilt: Math.round(tilt * 1000) / 1000, w: Math.round(gw), gaps: gaps.map((gx) => ({ x: Math.round(gx), z: Math.round(z0 + tilt * gx) })) });
        while (x < BAY.maxX - 10) {
          const L = r.range(90, 150);
          let x2 = Math.min(BAY.maxX - 10, x + L);
          const g = gaps.find((gx) => gx - gw / 2 > x - 1 && gx - gw / 2 < x2);
          if (g != null) x2 = g - gw / 2;
          const w = r.range(REEFS.bandW[0], REEFS.bandW[1]);
          if (x2 - x > 12) reefs.push(reef(`reef${++reefN}`, nm, "reef", x + w, z0 + tilt * x + r.range(-12, 12), x2 - w * 0.2, z0 + tilt * x2 + r.range(-12, 12), w));
          x = g != null ? g + gw / 2 : x2;
        }
      }
      // Rocks loose inside the maze (never in a gap's mouth).
      for (let n = 0, tries = 0; n < 7 && tries < 300; tries++) {
        const rr = r.range(REEFS.rockR[0], REEFS.rockR[1]);
        const x = r.range(BAY.minX + 80, BAY.maxX - 80), z = r.range(rows[0] + 50, rows[rows.length - 1] - 50);
        if (reefs.some((o) => capsuleDist(x, z, o).d < rr + 45)) continue;
        reefs.push(reef(`reef${++reefN}`, nextReefName(), "rocks", x, z, x, z, rr));
        n++;
      }
      // Patrol beats between the rows, lanterns lit.
      for (let pi = 0; pi < 3; pi++) {
        const z = (rows[pi + 1] + rows[pi + 2]) / 2 + r.range(-15, 15);
        const x0 = r.range(-650, -250), x1 = r.range(250, 650);
        route(`beat${pi + 1}`, "patrol", [{ x: x0, z }, { x: x1, z }], true);
        lines.pop();   // patrol beats may run between reefs
        const cls = pi === 1 ? "brig" : "gunboat";
        fleet.push({ id: `p${pi + 1}`, cls, name: pickName(r, cls, used), role: "patrol", route: `beat${pi + 1}`, offset: r.range(0, 600), lantern: true });
      }
      for (let i = 0; i < 5; i++) fog.push({ x: Math.round(r.range(-700, 700)), z: Math.round(rows[0] + (i + 0.5) * (rows[rows.length - 1] - rows[0]) / 5), r: Math.round(r.range(200, 300)), density: 0.9 });
      scatterIslands(islands.length + r.int(2, 3), 1250);
      placePickups(start, cove, ["crate", "barrel", "bottle", "chest", "barrel"]);
      // Variant: the entry gap (the first row's gap nearer the straight line), the bonus.
      const g0 = maze[0].gaps.slice().sort((p, q) => Math.abs(p.x - (start.x + (cove.x - start.x) * 0.25)) - Math.abs(q.x - (start.x + (cove.x - start.x) * 0.25)))[0];
      variant.entry = g0 ? { x: g0.x, z: g0.z } : null;
      variant.id = `cove${cove.x >= 0 ? "W" : "E"}-${maze.length}rows`;
      variant.label = `The cove lies under ${isl.name}, ${maze.length} reef rows north; three patrols sweep lanterns between the rows.`;
      variant.bonusPick = vr.pick(["unseen", "chest"]);
      break;
    }
    case "the_gloam": {
      addMaelstrom();
      scatterIslands(r.int(5, 6));
      scatterReefs(r.int(3, 4), r.int(3, 5));
      addFog(6, 400, 1600, [160, 260], 0.9);
      // (v5: she starts well clear of the maelstrom — v4 could put her in its eye.)
      let gx = r.range(-300, 300), gz = r.range(800, 950);
      for (let i = 0; i < 40 && maelstrom && (dist(gx, gz, maelstrom.x, maelstrom.z) < maelstrom.r + 250 || !openWater(gx, gz, 60)); i++) { gx = r.range(-600, 600); gz = r.range(700, 1300); }
      fleet.push({ id: "gl1", cls: "gloam", name: "The Gloam", role: "legend", x: Math.round(gx), z: Math.round(gz), heading: 180, objective: true });
      placePickups(start, { x: 0, z: 900 }, defaultKinds());
      const gl = fleet[fleet.length - 1];
      variant.id = `gloam${gl.x >= 0 ? "W" : "E"}`;
      variant.label = `The Gloam was last seen ${metres(dist(start.x, start.z, gl.x, gl.z))} out, ${gl.x >= 0 ? "west" : "east"} of north, among ${fog.length} fog banks.`;
      variant.bonusPick = vr.pick(["rake", "chest", "hull"]);
      break;
    }
    case "krakens_wake": {
      scatterIslands(r.int(5, 6));
      // v5: a near wreck (550–1000 m out) and a far one (beyond 950 m) with guards over her.
      addWrecks(1, 550, { x: 0, z: 760, r: 260 });
      addWrecks(2, 950);
      for (const w of wrecks) keep.push({ x: w.x, z: w.z, r: 90 });
      for (const w of wrecks) scatterReefs(2, 2, { zMin: Math.max(300, w.z - 260), zMax: Math.min(BAY.maxZ - 60, w.z + 260), clearOf: wrecks.map((q) => ({ x: q.x, z: q.z, r: 90 })) });
      addFog(4, 700, 1600, [160, 240], 0.8);
      exit = { x: port.x, z: port.z + 90, r: EXIT.r, name: "the harbour mouth" };
      placePickups(start, wrecks[0] || { x: 0, z: 1200 }, defaultKinds());
      // Variant (v5): who guards the far wreck, what waits on the run home, the order of the Kraken's attacks while its eye is down.
      const guard = vr.pick(["gunboats", "brig"]);
      const far = wrecks[wrecks.length - 1];
      if (far) {
        const gs = guard === "brig" ? ["brig"] : ["gunboat", "gunboat"];
        gs.forEach((cls, i) => {
          let x = far.x, z = far.z + 120;
          for (let k = 0; k < 16; k++) {
            const a = vr.range(0, Math.PI * 2), rr = vr.range(90, 150);
            if (openWater(far.x + Math.cos(a) * rr, far.z + Math.sin(a) * rr, 35)) { x = far.x + Math.cos(a) * rr; z = far.z + Math.sin(a) * rr; break; }
          }
          fleet.push({ id: `k${i + 1}`, cls, name: pickName(vr, cls, used), role: "guard", x: Math.round(x), z: Math.round(z), heading: Math.round(vr.range(0, 360)) });
        });
      }
      const escape = vr.pick(["arms", "cutters", "fireship"]);
      const attacks = vr.shuffle(["arms", "wave", "grab"]);
      variant.guard = guard; variant.escape = escape; variant.attacks = attacks; variant.guardWreck = far?.id || null;
      variant.id = `wrecks-${wrecks.map((w) => (w.x >= 0 ? "W" : "E")).join("")}-${guard}-${escape}`;
      variant.label = `Two wrecks lie in Kraken water${wrecks.length ? `, ${wrecks.map((w) => `${metres(dist(start.x, start.z, w.x, w.z))} ${w.x >= 0 ? "west" : "east"} of north`).join(" and ")}` : ""}; `
        + `${guard === "brig" ? "a navy brig guards" : "two navy gunboats guard"} the far one; then the Kraken itself rises${escape === "cutters" ? ", and navy cutters wait off the harbour mouth" : escape === "fireship" ? ", and a fire ship waits off the harbour mouth" : ""}.`;
      variant.bonusPick = vr.pick(["repel", "chest", "arms", "guards"]);
      break;
    }
    default: {
      // Free roam: the v1 sandbox, scaled to the 1.8 km bay.
      const west = r.chance(0.5) ? 1 : -1;
      const capeA = { x: west * r.range(560, 700), z: r.range(600, 1500) };
      const capeB = { x: -west * r.range(560, 700), z: r.range(600, 1500) };
      const mid = { x: (capeA.x + capeB.x) / 2, z: (capeA.z + capeB.z) / 2 };
      route("convoy", "convoy", [capeA, { x: mid.x, z: mid.z + 140 }, capeB, { x: mid.x, z: mid.z + 300 }], true);
      const pz = r.range(420, 700), px = r.range(-250, 250), pw = r.range(220, 320), ph = r.range(140, 200);
      route("patrol", "patrol", [{ x: px - pw, z: pz }, { x: px - pw, z: pz + ph }, { x: px + pw, z: pz + ph }, { x: px + pw, z: pz }], true);
      addMaelstrom();
      const fortIsle = (() => {
        for (let tries = 0; tries < 300; tries++) {
          const R = r.range(80, 110), x = r.range(-650, 650), z = r.range(900, 1550);
          if (islandFits(x, z, R * 1.1)) return addIsland(x, z, R);
        }
        return null;
      })();
      if (fortIsle) { fort = fortOn(fortIsle); keep.push({ x: fort.x, z: fort.z, r: 200 }); }
      scatterIslands(r.int(5, 7));
      addShoals();
      scatterReefs(night ? r.int(3, 5) : r.int(2, 3), night ? r.int(3, 5) : r.int(2, 3));
      addWrecks(WRECKS.count);
      // The cove under an island far from home.
      const far = islands.filter((i) => dist(i.x, i.z, port.x, port.z) > 600);
      for (let tries = 0; !cove && tries < 80 && far.length; tries++) {
        const isl = r.pick(far), a = r.range(0, Math.PI * 2);
        const x = isl.x + Math.cos(a) * (isl.r + COVE.r * 0.6), z = isl.z + Math.sin(a) * (isl.r + COVE.r * 0.6);
        if (inBay(x, z, 80) && polyDist(x, z, isl.poly).d > 20 && islands.every((o) => o === isl || dist(x, z, o.x, o.z) > o.r + 50)
          && reefs.every((o) => capsuleDist(x, z, o).d > 40)) cove = { x: Math.round(x), z: Math.round(z), r: COVE.r, island: isl.id };
      }
      if (night) {
        for (let i = 0; i < 100 && !storm; i++) {
          const x = r.range(-600, 600), z = r.range(800, 1500);
          if (dist(x, z, port.x, port.z) > 650 && (!maelstrom || dist(x, z, maelstrom.x, maelstrom.z) > 380)) {
            const a = r.range(0, Math.PI * 2);
            storm = { x: Math.round(x), z: Math.round(z), r: STORM.r, vx: Math.round(Math.cos(a) * STORM.drift * 100) / 100, vz: Math.round(Math.sin(a) * STORM.drift * 100) / 100 };
          }
        }
        addFog(3, 500, 1600, [150, 230], 0.75);
      }
      const convoyN = r.int(2, 3);
      for (let i = 0; i < convoyN; i++) fleet.push({ id: `m${fleet.length + 1}`, cls: "merchant", name: pickName(r, "merchant", used), role: "convoy", route: "convoy", offset: i * 70 });
      fleet.push({ id: `e${fleet.length + 1}`, cls: "gunboat", name: pickName(r, "gunboat", used), role: "escort", route: "convoy", offset: -100 });
      for (let n = 0, tries = 0; n < 2 && tries < 300; tries++) {
        const near = n === 0;
        const x = near ? r.range(-450, 450) : r.range(BAY.minX + 150, BAY.maxX - 150), z = near ? r.range(380, 700) : r.range(400, BAY.maxZ - 150);
        if (!openWater(x, z, 90) || dist(x, z, port.x, port.z) < 380) continue;
        fleet.push({ id: `m${fleet.length + 1}`, cls: "merchant", name: pickName(r, "merchant", used), role: "merchant", x: Math.round(x), z: Math.round(z), heading: Math.round(r.range(0, 360)) });
        n++;
      }
      fleet.push({ id: `n${fleet.length + 1}`, cls: "brig", name: pickName(r, "brig", used), role: "patrol", route: "patrol", offset: 0, lantern: night });
      placePickups(start, { x: 0, z: 1200 }, ["crate", "barrel", "bottle", "crate", "barrel", "bottle", "chest"]);
      variant.id = `free-${convoyN}`;
      variant.label = `${convoyN} merchants on the convoy route with a gunboat; a navy brig on patrol${night ? " with a lantern; a storm cell drifts" : ""}.`;
      break;
    }
  }
  if (id !== "smugglers_run" && !["free_day", "free_night"].includes(id)) addShoals();
  // The bonus objective: a chest pickup when the variant picked one (else the variant's fallback).
  if (variant.bonusPick) {
    let kind = variant.bonusPick;
    if (kind === "chest") {
      const ch = pickups.find((p) => p.kind === "chest");
      if (ch) { ch.bonus = true; variant.bonus = { kind, pickupId: ch.id }; } else kind = id === "krakens_wake" ? "repel" : id === "smugglers_run" ? "unseen" : "rake";
    }
    if (!variant.bonus) variant.bonus = { kind };
    delete variant.bonusPick;
  }

  const pois = [
    { id: "port", kind: "port", x: port.x, z: port.z, label: "Home port" },
    ...routes.filter((rt) => rt.kind === "convoy").map((rt) => ({ id: rt.id, kind: "convoy", x: rt.points[1].x, z: rt.points[1].z, label: id === "spice_fleet" ? "The spice fleet's course" : "Convoy route" })),
    ...wrecks.map((w) => ({ id: w.id, kind: "wreck", x: w.x, z: w.z, label: "Wreck" })),
    ...(maelstrom ? [{ id: "maelstrom", kind: "maelstrom", x: maelstrom.x, z: maelstrom.z, label: "The Maelstrom" }] : []),
    ...(storm ? [{ id: "storm", kind: "storm", x: storm.x, z: storm.z, label: "Storm cell" }] : []),
    ...routes.filter((rt) => rt.kind === "patrol").map((rt) => ({ id: rt.id, kind: "patrol", x: Math.round((rt.points[0].x + rt.points[1].x) / 2), z: Math.round((rt.points[0].z + rt.points[1].z) / 2), label: "Navy patrol" })),
    ...(cove ? [{ id: "cove", kind: "cove", x: cove.x, z: cove.z, label: "Smugglers' cove" }] : []),
    ...(fort ? [{ id: "fort", kind: "fort", x: fort.x, z: fort.z, label: "The fort" }] : []),
    ...(exit && id !== "smugglers_run" ? [{ id: "exit", kind: "exit", x: exit.x, z: exit.z, label: id === "krakens_wake" ? "The harbour mouth" : exit.name || "The far cape" }] : []),
  ];

  return {
    seed: Number(seed) >>> 0, mission: id, mode: id, time: M.time, size: BAY.size, arena: false,
    bounds: { minX: BAY.minX, maxX: BAY.maxX, minZ: BAY.minZ, maxZ: BAY.maxZ },
    wind, port, islands, fort, wrecks, maelstrom, storm, reefs, fog, cove, exit, routes, pois, fleet, pickups, start,
    variant, maze: maze.length ? maze : null,
  };
}

/**
 * Open water with one enemy, for duels and tests: no islands, no hazards.
 * The enemy starts `range` m out on the Rexmaw's bow (± `bearing`), heading across or toward her.
 */
export function arenaWorld(seed, { enemy = "brig", range = 520, bearing = null, heading = null, time = "day" } = {}) {
  const r = createRng(seed).fork("arena");
  const wind = { dirDeg: Math.round(r.range(0, 360)), strength: Math.round(r.range(0.75, 1.0) * 100) / 100 };
  const start = { x: 0, z: 400, heading: 0 };
  const b = bearing != null ? bearing : r.range(-40, 40);
  const ex = start.x - Math.sin(b * Math.PI / 180) * range, ez = start.z + Math.cos(b * Math.PI / 180) * range;
  const h = heading != null ? heading : enemy === "merchant" ? wrap360(headingOf(ex - start.x, ez - start.z) + r.range(-30, 30))
    : wrap360(headingOf(start.x - ex, start.z - ez) + r.range(-50, 50));
  const used = new Set();
  return {
    seed: seed >>> 0, mission: "arena", mode: "arena", time, size: BAY.size, bounds: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
    wind, port: { x: 0, z: -3000, r: PORT.r }, islands: [], fort: null, wrecks: [], maelstrom: null, storm: null, reefs: [], fog: [], cove: null, exit: null,
    routes: [], pois: [], pickups: [],
    fleet: [{ id: "x1", cls: enemy, name: pickName(r, CLASSES[enemy] ? enemy : "brig", used), role: "arena", x: Math.round(ex), z: Math.round(ez), heading: Math.round(h) }],
    start, arena: true, variant: { id: "arena", label: "", bonus: null }, maze: null,
  };
}

// ---- Navigation grid (tests, the scripted captain, reachability) --------------------

const CELL = 40;

/** Is (x, z) open water (not inside an island grown by `pad`; with `shoals`/`reefs`, clear of those too)? */
export function isWater(world, x, z, pad = 0, { shoals = false, reefs = false } = {}) {
  if (x < world.bounds.minX || x > world.bounds.maxX || z < world.bounds.minZ || z > world.bounds.maxZ) return false;
  for (const isl of world.islands) {
    if (dist(x, z, isl.x, isl.z) > isl.r + pad + (shoals ? 40 : 0)) continue;
    if (polyDist(x, z, isl.poly).d < pad) return false;
    if (shoals) for (const sh of isl.shoals) if (dist(x, z, sh.x, sh.z) < sh.r + pad * 0.6) return false;
  }
  if (reefs) for (const rf of world.reefs || []) if (dist(x, z, rf.x, rf.z) < rf.r + pad && capsuleDist(x, z, rf).d < pad * 0.6) return false;
  if (world.fort) for (const t of world.fort.towers) if (dist(x, z, t.x, t.z) < FORT.towerR + pad) return false;
  return true;
}

/** Every hazard under the water as one list (reefs, rocks, shoals as rocks): the companion's chart. */
export function hazardsOf(world) {
  const out = [...(world.reefs || [])];
  for (const isl of world.islands) for (const sh of isl.shoals) out.push({ id: sh.id, name: `the shoal off ${isl.name}`, kind: "shoal", a: { x: sh.x, z: sh.z }, b: { x: sh.x, z: sh.z }, w: sh.r, x: sh.x, z: sh.z, r: sh.r });
  return out;
}

/**
 * A path of waypoints from `from` to `to` around the islands (A* on a 40 m grid, islands grown by `pad`;
 * with `reefs`, around the reefs and shoals too), or null if there's no way through.
 */
export function navPath(world, from, to, { pad = 30, avoid = [], shoals = false, reefs = false } = {}) {
  const b = world.bounds.minX < -2000 ? { minX: Math.min(from.x, to.x) - 600, maxX: Math.max(from.x, to.x) + 600, minZ: Math.min(from.z, to.z) - 600, maxZ: Math.max(from.z, to.z) + 600 } : world.bounds;
  const W = Math.ceil((b.maxX - b.minX) / CELL), H = Math.ceil((b.maxZ - b.minZ) / CELL);
  const key = (i, j) => j * W + i;
  const cx = (i) => b.minX + (i + 0.5) * CELL, cz = (j) => b.minZ + (j + 0.5) * CELL;
  const cell = (x, z) => [clamp(Math.floor((x - b.minX) / CELL), 0, W - 1), clamp(Math.floor((z - b.minZ) / CELL), 0, H - 1)];
  const blocked = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = cx(i), z = cz(j);
    let bad = !isWater(world, x, z, pad, { shoals: shoals || reefs, reefs });
    for (const a of avoid) if (dist(x, z, a.x, a.z) < a.r) bad = true;
    blocked[key(i, j)] = bad ? 1 : 0;
  }
  const [si, sj] = cell(from.x, from.z), [ti, tj] = cell(to.x, to.z);
  blocked[key(si, sj)] = 0; blocked[key(ti, tj)] = 0;
  const g = new Float64Array(W * H).fill(Infinity), came = new Int32Array(W * H).fill(-1), closed = new Uint8Array(W * H);
  // A binary heap on f = g + h.
  const heap = [];
  const f = (k) => g[k] + Math.hypot((k % W) - ti, Math.floor(k / W) - tj);
  const push = (k) => { heap.push(k); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (f(heap[p]) <= f(heap[i])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < heap.length && f(heap[l]) < f(heap[m])) m = l; if (rr < heap.length && f(heap[rr]) < f(heap[m])) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  g[key(si, sj)] = 0;
  push(key(si, sj));
  while (heap.length) {
    const k = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === key(ti, tj)) break;
    const i = k % W, j = Math.floor(k / W);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = key(ni, nj);
      if (blocked[nk] || closed[nk]) continue;
      if (di && dj && (blocked[key(i + di, j)] || blocked[key(i, j + dj)])) continue;
      const ng = g[k] + (di && dj ? Math.SQRT2 : 1);
      if (ng < g[nk]) { g[nk] = ng; came[nk] = k; push(nk); }
    }
  }
  if (!closed[key(ti, tj)]) return null;
  const path = [];
  for (let k = key(ti, tj); k !== -1; k = came[k]) path.push({ x: cx(k % W), z: cz(Math.floor(k / W)) });
  path.reverse();
  path[path.length - 1] = { x: to.x, z: to.z };
  const out = [path[0]];
  for (let n = 1; n < path.length - 1; n++) {
    const a = out[out.length - 1], c = path[n + 1];
    const d1 = headingOf(path[n].x - a.x, path[n].z - a.z), d2 = headingOf(c.x - path[n].x, c.z - path[n].z);
    if (Math.abs(((d2 - d1 + 540) % 360) - 180) > 1) out.push(path[n]);
  }
  out.push(path[path.length - 1]);
  return out;
}
