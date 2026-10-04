// Broadside! Naval tactics at sea between your ship (the Rexmaw) and your
// companion's, over the Neuro API. Each turn has two orders:
//   1. The helm: turn (hard port … hard starboard) and set sail (full, half,
//      furled). The ship sails it out; the wind decides how far (into the
//      wind you barely move), islands run you aground, loot is picked up.
//   2. The action: fire a broadside, repair, ram or hold fire. Guns only
//      fire from a side whose beam faces the enemy (±32°), a shot along the
//      length of their ship RAKES it (+60%), islands block shots.
// So the fight is about position: get your guns to bear, deny them theirs,
// cross their bow or stern, use the islands. The companion is told what
// every helm order would lead to, and the range for its powers in the wind.
import * as THREE from "three";
import { createOcean, waveHeight } from "./ocean.js";
import { createSky, PRESETS } from "./sky.js";
import { buildShip, drawClaw } from "./ship.js";
import { createEffects, createGulls, createKraken } from "./effects.js";
import { buildIsland, buildLoot, floatLoot, LOOT } from "./islands.js";

const R = window.RexGame, sfx = R.sfx;
const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const DEG = Math.PI / 180;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } } };

// ---- Rules everyone shares (the preview, the real thing, the companion's facts)
const SPEED = 0.62, WIND_ACC = 0.16, GRAV = 9.81, MUZZLE_Y = 3.6;
const HELMS = { "hard port": -45, "port": -22.5, "steady": 0, "starboard": 22.5, "hard starboard": 45 };
const SAILS = { full: 80, half: 42, furl: 0 };
const ARC = 32;            // degrees either side of the beam the guns can bear
const ARENA = 520;         // shoals beyond this radius
const RAM_RANGE = 80;      // metres, with the enemy within 25° of your bow
const AMMO = {
  "cannonball": { speed: 1, dmg: [22, 32], sail: 1 },
  "chain shot": { speed: 1, dmg: [9, 13], sail: 5 },
  "anchor": { speed: 0.78, dmg: [48, 56], sail: 2 },
};
const STOCK = () => ({ "chain shot": 2, "anchor": 1 });
const SHIP_NAMES = { Eve: "The Hypothesis", Ara: "The Teapot", Rex: "The Other Claw", Sal: "The Lily Pad", Leo: "The Understudy" };
const MODES = {
  duel: { storm: false, kraken: false, islands: 3, loot: 3, mult: 1 },
  archipelago: { storm: false, kraken: false, islands: 6, loot: 5, mult: 1.15 },
  storm: { storm: true, kraken: false, islands: 2, loot: 3, mult: 1.3 },
  kraken: { storm: false, kraken: true, islands: 3, loot: 3, mult: 1.2 },
};

const bowOf = (h) => ({ x: Math.sin(h), z: Math.cos(h) });
const starOf = (h) => ({ x: Math.cos(h), z: -Math.sin(h) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** Where `to` lies from `from`'s bow, in degrees: + to starboard. */
function bearing(from, to) {
  const vx = to.x - from.x, vz = to.z - from.z, b = bowOf(from.h), s = starOf(from.h);
  return Math.atan2(vx * s.x + vz * s.z, vx * b.x + vz * b.z) / DEG;
}
/** The side whose guns bear on `to`, or null. */
function bears(from, to) {
  const r = bearing(from, to);
  return Math.abs(r - 90) <= ARC ? "starboard" : Math.abs(r + 90) <= ARC ? "port" : null;
}
/** A shot from `from` at `to` runs along their length: "stern", "bow" or null. */
function rakes(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, L = Math.hypot(dx, dz) || 1, b = bowOf(to.h);
  const c = (dx * b.x + dz * b.z) / L;
  return c > Math.cos(30 * DEG) ? "stern" : c < -Math.cos(30 * DEG) ? "bow" : null;
}
function blockedBy(a, b) {
  for (const isl of S.islands) {
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    const t = THREE.MathUtils.clamp(((isl.x - a.x) * dx + (isl.z - a.z) * dz) / L2, 0, 1);
    if (Math.hypot(a.x + dx * t - isl.x, a.z + dz * t - isl.z) < isl.r * 0.9) return isl;
  }
  return null;
}
const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const compass = (h) => ((180 - h / DEG) % 360 + 360) % 360;
const point = (deg) => POINTS[Math.round(deg / 45) % 8];
function where(rel) {
  const a = Math.abs(rel), side = rel > 0 ? "starboard" : "port";
  return a < 12 ? "dead ahead" : a < 60 ? `off your ${side} bow` : a < 120 ? `on your ${side} beam` : a < 168 ? `off your ${side} quarter` : "dead astern";
}
/** How well a ship sails on heading h in this wind (1 = a beam reach). */
function sailFactor(h) {
  const b = bowOf(h), t = b.x * Math.sin(S.wind.dir) + b.z * Math.cos(S.wind.dir);
  const a = Math.acos(THREE.MathUtils.clamp(t, -1, 1)) / DEG;   // 0 = wind behind, 180 = wind ahead
  const T = [[0, 0.82], [60, 0.95], [90, 1], [120, 0.78], [140, 0.5], [160, 0.22], [180, 0.1]];
  for (let i = 1; i < T.length; i++) if (a <= T[i][0]) { const [a0, f0] = T[i - 1], [a1, f1] = T[i]; return f0 + (f1 - f0) * (a - a0) / (a1 - a0); }
  return 0.1;
}
function range(angle, power, windAlong, ammo = "cannonball") {
  const v = power * SPEED * AMMO[ammo].speed, a = angle * DEG;
  let x = 0, y = MUZZLE_Y, vx = v * Math.cos(a), vy = v * Math.sin(a);
  for (let i = 0; i < 6000; i++) { const dt = 1 / 120; vx += windAlong * WIND_ACC * dt; vy -= GRAV * dt; x += vx * dt; y += vy * dt; if (y < 0 && vy < 0) return x; }
  return x;
}
const windVec = () => ({ x: Math.sin(S.wind.dir) * S.wind.speed, z: Math.cos(S.wind.dir) * S.wind.speed });
function windAlong(from, to) { const d = Math.max(1, dist(from, to)), w = windVec(); return ((to.x - from.x) * w.x + (to.z - from.z) * w.z) / d; }

/** What a helm order does, worked out step by step (the same for the
 *  preview, the companion's options and the real voyage). */
function planMove(key, helm, sail) {
  const p = S.p[key], o = S.p[key === "you" ? "them" : "you"];
  const dh = (HELMS[helm] ?? 0) * DEG;
  const len = SAILS[sail] * sailFactor(p.h + dh) * (mode().storm ? 0.85 : 1) * (0.85 + S.wind.speed / 50);
  const N = 40, path = [];
  let x = p.x, z = p.z, h = p.h, stop = null;
  const picked = [];
  for (let i = 1; i <= N; i++) {
    const f = i / N;
    h = p.h + dh * Math.min(1, f / 0.55);
    const nx = x + Math.sin(h) * len / N, nz = z + Math.cos(h) * len / N;
    const isl = S.islands.find((s) => Math.hypot(nx - s.x, nz - s.z) < s.r + 8);
    if (isl) { stop = "aground"; break; }
    if (Math.hypot(nx - o.x, nz - o.z) < 32) { stop = "ship"; break; }
    if (Math.hypot(nx, nz) > ARENA) { stop = "shoals"; break; }
    x = nx; z = nz;
    for (const l of S.loot) if (!picked.includes(l) && Math.hypot(x - l.x, z - l.z) < 16) picked.push(l);
    path.push({ x, z, h });
  }
  if (!path.length) path.push({ x, z, h: p.h + dh });
  return { path, end: path[path.length - 1], stop, picked, len };
}

// ---- The stage ------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$("stage").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.5, 8000);
const clock = new THREE.Clock();
const time = { value: 0 };
const ocean = createOcean(); scene.add(ocean.mesh);
const sky = createSky(scene);
const fx = createEffects(scene);
const gulls = createGulls(scene);
const kraken = createKraken(scene, fx);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), new THREE.MeshStandardMaterial({ color: "#1c1917", metalness: 0.7, roughness: 0.35 }));
const anchorMesh = (() => {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: "#3f3f46", metalness: 0.8, roughness: 0.4 });
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.6, 8), m);
  const arm = new THREE.Mesh(new THREE.TorusGeometry(1, 0.16, 8, 20, Math.PI), m); arm.rotation.z = Math.PI; arm.position.y = -1;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.09, 8, 16), m); ring.position.y = 1.5;
  g.add(shank, arm, ring); return g;
})();
const flashLight = new THREE.PointLight("#ffb347", 0, 120, 1.5); scene.add(flashLight);
const preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: "#fde68a", dashSize: 1.6, gapSize: 1.2, transparent: true, opacity: 0.85 }));
preview.frustumCulled = false; scene.add(preview);
const courseLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: "#f8fafc", dashSize: 4, gapSize: 3, transparent: true, opacity: 0.7 }));
courseLine.frustumCulled = false; scene.add(courseLine);

// ---- State ------------------------------------------------------------------------
const fresh = () => ({ x: 0, z: 0, h: 0, hp: 100, kits: 2, ammo: STOCK(), wobble: 1, powder: false, spyglass: false, shots: [], hits: 0, fired: 0, rakes: 0 });
const S = {
  phase: "title", turn: "you", starter: "you", round: 0,
  p: { you: fresh(), them: fresh() }, wind: { dir: 0, speed: 6 },
  islands: [], loot: [], flight: null, voyage: null, krakenLurk: false, timeScale: 1,
  helm: "steady", sail: "full", aim: { angle: 35, power: 65, ammo: "cannonball" },
};
const mode = () => MODES[game.mode] || MODES.duel;
let you = null, them = null;
const ships = () => ({ you, them });

// ---- The kit ------------------------------------------------------------------------
const game = R.create({
  name: "Broadside",
  ui: { recordInto: $("title-record"), modesInto: $("title-modes") },
  modes: [
    { id: "duel", label: "Duel", hint: "three islands" },
    { id: "archipelago", label: "Archipelago", hint: "islands everywhere" },
    { id: "storm", label: "Storm", hint: "gales and big seas" },
    { id: "kraken", label: "Kraken waters", hint: "something below" },
  ],
  onMode: (id, byUser) => { if (byUser && S.phase !== "title" && S.phase !== "over") startMatch(); else applySky(); },
  music: ["broadside", "calm-before", "high-stakes"],
  rules: "You're in Broadside!, a sea battle: your ship against the user's ship, the Rexmaw. Each of your turns has two "
    + "orders. First steer: turn (hard port, port, steady, starboard, hard starboard) and set sail (full, half or furl); "
    + "your ship then sails it out. Sailing into the wind is very slow, with it or across it is fast. Then act: fire a "
    + "broadside, repair, ram or hold. Your guns are along your sides, so they only fire when the enemy is on your beam "
    + "(within 32 degrees of straight out to port or starboard). A shot that runs along the length of their ship, across "
    + "their bow or stern, RAKES it for +60% damage. Islands block shots and you'll run aground on them. Floating loot "
    + "(rum, powder kegs, spyglasses, treasure) is picked up by sailing through it. Every turn tells you exactly what "
    + "each helm order would lead to, and how far your shots fly. Aim is an angle (5 to 70; 45 flies furthest) and a "
    + "power (10 to 100). Four or so solid hits sink a ship.",
  actions: [
    { name: "steer", description: "First order of your turn: turn the ship and set sail. Your ship then sails it out.",
      schema: { type: "object", properties: { helm: { type: "string", enum: Object.keys(HELMS) }, sail: { type: "string", enum: Object.keys(SAILS) } }, required: ["helm"] } },
    { name: "act", description: "Second order: fire (needs a side whose guns bear), repair (uses a kit), ram (close, with them off your bow) or hold.",
      schema: { type: "object", properties: { action: { type: "string", enum: ["fire", "repair", "ram", "hold"] },
        angle: { type: "integer", minimum: 5, maximum: 70 }, power: { type: "integer", minimum: 10, maximum: 100 },
        ammo: { type: "string", enum: ["cannonball", "chain shot", "anchor"] } }, required: ["action"] } },
  ],
  onAction(name, args) {
    if (name === "steer") {
      if (S.phase !== "themHelm") throw new R.Refuse(S.phase === "themAct" ? "You've already steered: now act." : "Not your turn to steer.");
      const helm = normHelm(args.helm), sail = String(args.sail || "full").toLowerCase().trim();
      if (!helm) throw new R.Refuse(`helm is one of: ${Object.keys(HELMS).join(", ")}.`);
      if (!(sail in SAILS)) throw new R.Refuse("sail is full, half or furl.");
      const plan = planMove("them", helm, sail);
      setTimeout(() => sailOut("them", helm, sail), 700);
      return `Helm ${helm}, ${sail} sail: you'll make about ${Math.round(plan.len)} m`
        + `${plan.stop === "aground" ? " but run aground on an island" : plan.stop === "shoals" ? " until the shoals stop you" : ""}. `
        + "You'll be asked for your action when you get there.";
    }
    if (S.phase !== "themAct") throw new R.Refuse(S.phase === "themHelm" ? "Steer first, then act." : "Not your turn to act.");
    const action = String(args.action || "").toLowerCase().trim();
    if (action === "fire") {
      const side = bears(S.p.them, S.p.you);
      if (!side) throw new R.Refuse("None of your guns bear on them from here: you can repair, ram (if close) or hold. Steer better next turn.");
      const angle = R.toInt(args.angle), power = R.toInt(args.power);
      let ammo = String(args.ammo || "cannonball").toLowerCase().trim();
      if (ammo === "chain") ammo = "chain shot";
      if (!(angle >= 5 && angle <= 70)) throw new R.Refuse("angle must be a whole number from 5 to 70.");
      if (!(power >= 10 && power <= 100)) throw new R.Refuse("power must be a whole number from 10 to 100.");
      if (!AMMO[ammo]) throw new R.Refuse('ammo is "cannonball", "chain shot" or "anchor".');
      if (ammo !== "cannonball" && !S.p.them.ammo[ammo]) throw new R.Refuse(`You have no ${ammo} left. Use a cannonball.`);
      setTimeout(() => fire("them", angle, power, ammo), 800);
      return `Firing your ${side} broadside: angle ${angle}, power ${power}, ${ammo}. The result comes in a moment.`;
    }
    if (action === "repair") {
      if (!S.p.them.kits) throw new R.Refuse("You have no repair kits left.");
      setTimeout(() => repair("them"), 500);
      return "Repairing: +15 hull.";
    }
    if (action === "ram") {
      if (!canRam(S.p.them, S.p.you)) throw new R.Refuse(`You can only ram within ${RAM_RANGE} m with them within 25 degrees of your bow.`);
      setTimeout(() => ram("them"), 500);
      return "RAMMING SPEED!";
    }
    if (action === "hold") { setTimeout(() => endTurn("them"), 600); return "Holding fire this turn."; }
    throw new R.Refuse("action is fire, repair, ram or hold.");
  },
  onCompanion: (name) => {
    $("them-name").textContent = name;
    if (S.phase === "title" || S.phase === "over") { buildShips(); hud(); }
  },
  onAgain: () => startMatch(),
});

function normHelm(v) {
  const t = String(v || "").toLowerCase().replace(/left/g, "port").replace(/right/g, "starboard").replace(/straight|ahead|forward/, "steady").trim();
  return t in HELMS ? t : null;
}

// ---- Building the world ----------------------------------------------------------
function enemyLook(name) {
  const letter = (name || "?")[0].toUpperCase();
  return {
    color: "#0e7490", name: SHIP_NAMES[name] || `${name}'s Revenge`,
    flag: { field: "#0e7490", mark: "#facc15", letter },
    emblem: (g, w, h) => { g.fillStyle = "#b45309"; g.beginPath(); g.arc(w / 2, h / 2, 70, 0, 6.28); g.fill();
      g.fillStyle = "#fde68a"; g.font = "bold 96px Georgia"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(letter, w / 2, h / 2 + 6); },
  };
}
let islandMeshes = [];
function buildShips() {
  for (const s of [you, them]) if (s) scene.remove(s.group);
  you = buildShip({ color: "#9f1239", name: "The Rexmaw", flag: { field: "#111111", mark: "#f8fafc", claw: true },
    emblem: (g, w, h) => drawClaw(g, w / 2, h / 2, 80, "#9f1239") }, time);
  them = buildShip(enemyLook(game?.companion), time);
  scene.add(you.group, them.group);
  placeShips();
  applySky();
}
function placeShips() {
  for (const [key, ship] of Object.entries(ships())) {
    const p = S.p[key];
    ship.group.position.set(p.x, 0, p.z); ship.group.rotation.y = p.h;
  }
}
function layOutSea() {
  islandMeshes.forEach((m) => scene.remove(m)); islandMeshes = [];
  S.loot.forEach((l) => scene.remove(l.mesh)); S.loot = [];
  S.islands = [];
  const keepClear = [S.p.you, S.p.them];
  for (let tries = 0; S.islands.length < mode().islands && tries < 400; tries++) {
    const r = rnd(22, 40), a = rnd(0, 6.28), d = rnd(0, 330);
    const isl = { x: Math.cos(a) * d, z: Math.sin(a) * d, r, h: rnd(12, 24), seed: (Math.random() * 1e9) | 0 };
    if (keepClear.some((p) => dist(p, isl) < r + 90)) continue;
    if (S.islands.some((o) => dist(o, isl) < r + o.r + 70)) continue;
    S.islands.push(isl);
    const mesh = buildIsland(isl); scene.add(mesh); islandMeshes.push(mesh);
  }
  for (let i = 0; i < mode().loot; i++) spawnLoot();
}
function spawnLoot() {
  const kinds = ["rum", "rum", "powder", "spyglass", "chest", "chest"];
  for (let tries = 0; tries < 100; tries++) {
    const a = rnd(0, 6.28), d = rnd(40, 380), l = { x: Math.cos(a) * d, z: Math.sin(a) * d, kind: kinds[(Math.random() * kinds.length) | 0] };
    if (S.islands.some((s) => dist(s, l) < s.r + 25) || [S.p.you, S.p.them].some((p) => dist(p, l) < 40)) continue;
    l.mesh = buildLoot(l.kind); l.mesh.position.set(l.x, 0, l.z); scene.add(l.mesh);
    S.loot.push(l);
    return;
  }
}

// ---- Sky -------------------------------------------------------------------------
const SKIES = ["sunset", "midday", "night", "dawn"];
let skyPick = SKIES.includes(store.get("rx-broadside-sky")) ? store.get("rx-broadside-sky") : "sunset";
function applySky() {
  const id = mode().storm ? "storm" : skyPick;
  sky.apply(id, ocean, renderer, scene);
  const p = PRESETS[id];
  fx.setFog(p.fog, p.fogDensity);
  ocean.uniforms.uAmp.value = mode().storm ? 2.1 : 1;
  for (const s of [you, them]) s?.setLanterns(p.lanterns);
  $("sky-btn").textContent = `${{ sunset: "🌅", midday: "☀️", night: "🌙", dawn: "🌫️", storm: "⛈️" }[id]} ${p.name}`;
  $("sky-btn").disabled = mode().storm;
}
$("sky-btn").onclick = () => { skyPick = SKIES[(SKIES.indexOf(skyPick) + 1) % SKIES.length]; store.set("rx-broadside-sky", skyPick); sfx.whoosh(); applySky(); };

// ---- A match -----------------------------------------------------------------------
function startMatch() {
  game.cancelForce();
  document.querySelector(".rx-end")?.remove();
  S.p = { you: fresh(), them: fresh() };
  // Bow to bow at the start: nobody's guns bear until someone turns.
  const a = rnd(0, 6.28), d = rnd(260, 340);
  Object.assign(S.p.you, { x: Math.cos(a) * d / 2, z: Math.sin(a) * d / 2 });
  Object.assign(S.p.them, { x: -Math.cos(a) * d / 2, z: -Math.sin(a) * d / 2 });
  S.p.you.h = Math.atan2(S.p.them.x - S.p.you.x, S.p.them.z - S.p.you.z) + rnd(-0.3, 0.3);
  S.p.them.h = Math.atan2(S.p.you.x - S.p.them.x, S.p.you.z - S.p.them.z) + rnd(-0.3, 0.3);
  S.wind = { dir: rnd(0, 6.28), speed: Math.round(mode().storm ? rnd(10, 16) : rnd(4, 9)) };
  Object.assign(S, { round: 0, flight: null, voyage: null, krakenLurk: false, phase: "starting" });
  buildShips();
  layOutSea();
  $("title").hidden = true;
  $("hud").hidden = false;
  S.turn = S.starter; S.starter = S.starter === "you" ? "them" : "you";
  sfx.bell(); sfx.cannon();
  banner("BROADSIDE!");
  game.tell(`A new battle of Broadside! begins${mode().storm ? " in a STORM" : ""}${mode().kraken ? " in KRAKEN WATERS" : ""}`
    + `${game.mode === "archipelago" ? " among many islands" : ""}. The ships start ${Math.round(dist(S.p.you, S.p.them))} m apart, bow to bow. `
    + `${S.turn === "you" ? "The user moves" : "You move"} first.`, true);
  game.heckle("start", { chance: 0.6 });
  hud();
  setTimeout(nextTurn, 1800);
}

function nextTurn() {
  if (S.phase === "over") return;
  S.round++;
  if (mode().storm && S.round > 1) {
    S.wind.dir += rnd(-0.6, 0.6);
    S.wind.speed = Math.round(THREE.MathUtils.clamp(S.wind.speed + rnd(-3, 3), 8, 18));
  }
  if (S.round % 4 === 0 && S.loot.length < mode().loot) spawnLoot();
  hud();
  if (mode().kraken && S.round > 2 && !kraken.active() && Math.random() < 0.2) return krakenEvent();
  if (S.turn === "you") userHelm(); else companionHelm();
}

// ---- The helm --------------------------------------------------------------------------
function userHelm() {
  S.phase = "helm";
  setShot("tactical");
  showPanel("helm");
  $("turn").textContent = "Your helm, Captain";
  previewCourse();
}

/** One line per helm order: where it leaves you, for the companion. */
function optionLine(key, helm, sail) {
  const plan = planMove(key, helm, sail);
  const me = { ...S.p[key], ...plan.end }, foe = S.p[key === "you" ? "them" : "you"];
  const side = bears(me, foe), rake = side && rakes(me, foe), wall = blockedBy(me, foe);
  const theirs = bears(foe, me);
  const bits = [`${Math.round(dist(me, foe))} m apart`, side ? `your ${side} guns bear${rake ? ` and RAKE their ${rake}` : ""}${wall ? " (but an island is in the way)" : ""}` : "your guns don't bear"];
  bits.push(theirs ? `their ${theirs} guns would bear on you` : "their guns wouldn't bear on you");
  if (plan.picked.length) bits.push(`picks up ${plan.picked.map((l) => `a ${LOOT[l.kind].name}`).join(" and ")}`);
  if (plan.stop === "aground") bits.push("RUNS AGROUND");
  if (plan.stop === "shoals") bits.push("stopped by the shoals");
  return `- ${helm}: ${bits.join("; ")}.`;
}

function companionHelm() {
  S.phase = "themHelm";
  setShot("tactical");
  showPanel(null);
  $("turn").textContent = `${game.companion} is at the helm…`;
  courseLine.visible = false;
  const me = S.p.them, foe = S.p.you;
  const loot = S.loot.map((l) => `a ${LOOT[l.kind].name} (${LOOT[l.kind].effect}) ${Math.round(dist(me, l))} m ${where(bearing(me, l))}`);
  const isl = S.islands.map((s) => `${Math.round(dist(me, s))} m ${where(bearing(me, s))}`);
  game.force({
    state: `## Broadside! Your turn: steer first\n`
      + `You: heading ${point(compass(me.h))}, hull ${me.hp}/100, ${me.kits} repair kit(s). Them: hull ${foe.hp}/100, `
      + `${Math.round(dist(me, foe))} m away, ${where(bearing(me, foe))}; their ${bears(foe, me) || "guns don't"}${bears(foe, me) ? " guns bear on you" : " bear on you"}.\n`
      + `Wind: ${S.wind.speed} m/s from the ${point(((compass(S.wind.dir) + 180) % 360))}.\n`
      + `Islands: ${isl.length ? isl.join("; ") : "none"}.\nLoot: ${loot.length ? loot.join("; ") : "none"}.\n`
      + `What each helm order does at full sail:\n${Object.keys(HELMS).map((hm) => optionLine("them", hm, "full")).join("\n")}\n`
      + "Half sail goes half as far; furl stays put but still turns. Aim to end with your guns bearing (best: raking), and theirs not.",
    query: "Steer with steer (helm, and sail if not full).",
    actions: ["steer"],
    priority: "medium",
  });
}

/** Sail a helm order out, animated, then on to the action. */
function sailOut(key, helm, sail) {
  const plan = planMove(key, helm, sail);
  S.phase = key === "you" ? "sailing" : "themSailing";
  S.voyage = { key, plan, t: 0, dur: Math.max(1.4, 1 + plan.len / 32), helm, sail };
  showPanel(null);
  courseLine.visible = false;
  if (sail !== "furl") sfx.creak();
  setShot("sail");
}

function arrive() {
  const { key, plan } = S.voyage;
  const p = S.p[key];
  Object.assign(p, plan.end);
  S.voyage = null;
  const notes = [];
  for (const l of plan.picked) {
    S.loot.splice(S.loot.indexOf(l), 1); scene.remove(l.mesh);
    fx.sparkle(new THREE.Vector3(l.x, 0, l.z)); sfx.sparkle(); sfx.cash();
    const what = LOOT[l.kind];
    if (l.kind === "rum") p.hp = Math.min(100, p.hp + 15);
    if (l.kind === "powder") p.powder = true;
    if (l.kind === "spyglass") p.spyglass = true;
    if (l.kind === "chest" && key === "you") game.award(60, "Treasure!", $("you-plaque"));
    float(`${what.name}!`, key, "#fde68a");
    notes.push(`picked up a ${what.name} (${what.effect})`);
  }
  if (plan.stop === "aground") {
    p.hp = Math.max(0, p.hp - 6); sfx.creak(); sfx.boom(); shake(1); float("-6 aground!", key);
    notes.push("ran aground on an island (-6 hull)");
    if (key === "you") game.react("they_win"); else game.heckle("close_call", { chance: 0.5 });
  }
  if (plan.stop === "shoals") notes.push("was stopped by the shoals at the edge of the sea");
  hud();
  if (notes.length) game.tell(`${key === "you" ? "The user" : "You"} ${notes.join(" and ")}.`, key === "you");
  if (S.p.you.hp <= 0 || S.p.them.hp <= 0) return sink(S.p.them.hp <= 0 ? "them" : "you");
  if (key === "you") userAct(); else companionAct();
}

// ---- The action ----------------------------------------------------------------------
function canRam(me, foe) { return dist(me, foe) < RAM_RANGE && Math.abs(bearing(me, foe)) < 25; }

function userAct() {
  S.phase = "act";
  const side = bears(S.p.you, S.p.them);
  setShot(side ? "aim" : "tactical");
  showPanel("act");
  $("turn").textContent = side ? "Your guns bear: fire!" : "No guns bear: repair, ram or hold";
  hud();
  updatePreview();
}

function companionAct() {
  S.phase = "themAct";
  const me = S.p.them, foe = S.p.you;
  const side = bears(me, foe), rake = side && rakes(me, foe), wall = side && blockedBy(me, foe);
  setShot(side ? "aim" : "tactical");
  showPanel(null);
  $("turn").textContent = `${game.companion} is deciding…`;
  const d = dist(me, foe), along = windAlong(me, foe);
  const table = [40, 50, 60, 70, 80, 90, 100].map((pw) => `power ${pw} ≈ ${Math.round(range(45, pw, along))} m`).join(", ");
  const past = me.shots.slice(-3).map((s, i) => `${i + 1}) angle ${s.angle}, power ${s.power}: ${s.result}`).join("\n");
  let aimLine = "";
  if (side) {
    aimLine = `Your ${side} guns BEAR on them${rake ? `, RAKING their ${rake} (+60% damage)` : ""}${wall ? ". But an island is in the line of fire: the shot will hit the island" : ""}.\n`
      + `Distance ${Math.round(d)} m. Wind along your shot: ${Math.abs(Math.round(along))} m/s ${along >= 0 ? "helping" : "against you"}.\n`
      + `With this wind at angle 45: ${table}.\n`
      + (me.spyglass ? `SPYGLASS: angle 45, power ${bestPower(me, foe)} lands right on them.\n` : "")
      + (me.powder ? "Your powder keg is loaded: your next hit does +60% damage.\n" : "")
      + `Ammo: cannonballs, chain shot (${me.ammo["chain shot"]} left: shreds their sails, their next shot wobbles), the anchor (${me.ammo.anchor} left: huge damage, but it flies only about 60% as far as a cannonball at the same power).\n`
      + (past ? `Your recent shots:\n${past}\n` : "");
  } else aimLine = `None of your guns bear on them (${where(bearing(me, foe))}, ${Math.round(d)} m). You can't fire this turn.\n`;
  game.force({
    state: `## Broadside! Now act\n${aimLine}`
      + `Hulls: yours ${me.hp}/100, theirs ${foe.hp}/100. Repair kits: ${me.kits} (+15 each).`
      + `${canRam(me, foe) ? " You're close enough to RAM them (big damage to them, a little to you)." : ""}`,
    query: side ? "Act: fire (angle, power, ammo), or repair/ram/hold." : `Act: ${me.kits ? "repair, " : ""}${canRam(me, foe) ? "ram, " : ""}or hold.`,
    actions: ["act"],
    priority: "medium",
    afterUser: false,   // follows their own steer, once the ship has sailed (not the user's move)
  });
}

function bestPower(me, foe) {
  const d = dist(me, foe) - 3, along = windAlong(me, foe);
  let best = 50, err = 1e9;
  for (let p = 10; p <= 100; p++) { const e = Math.abs(range(45, p, along) - d); if (e < err) { err = e; best = p; } }
  return best;
}

function fire(key, angle, power, ammo) {
  if (S.flight || S.phase === "over") return;
  const me = S.p[key], foe = S.p[key === "you" ? "them" : "you"], ship = ships()[key];
  const side = bears(me, foe);
  if (!side) return;
  if (ammo !== "cannonball") me.ammo[ammo]--;
  const wobble = me.wobble * (mode().storm ? 2 : 1) * (me.spyglass ? 0.2 : 1);
  me.wobble = 1; me.spyglass = false;
  const d = dist(me, foe), dir = new THREE.Vector3((foe.x - me.x) / d, 0, (foe.z - me.z) / d);
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), gauss() * 0.012 * wobble);
  const a = (angle + gauss() * 0.6 * wobble) * DEG;
  const v = power * SPEED * AMMO[ammo].speed * (1 + gauss() * 0.012 * wobble);
  const muzzle = ship.world(ship.muzzles[side][(Math.random() * 6) | 0]);
  const vel = dir.clone().multiplyScalar(v * Math.cos(a)).setY(v * Math.sin(a));
  S.flight = { key, dir, ammo, angle, power, pos: muzzle.clone(), vel, from: { ...me }, resolved: false,
    rake: rakes(me, foe), along: windAlong(me, foe), start: muzzle.clone() };
  const mesh = ammo === "anchor" ? anchorMesh : ball;
  mesh.position.copy(muzzle); scene.add(mesh); S.flight.mesh = mesh;
  me.fired++;
  S.phase = "flight";
  // The whole broadside: every gun on that side, a ripple of smoke.
  sfx.cannon();
  ship.muzzles[side].forEach((m, i) => setTimeout(() => {
    fx.muzzle(ship.world(m), new THREE.Vector3(dir.x, 0.25, dir.z));
    if (i % 2) sfx.boom();
  }, i * 70));
  flashLight.position.copy(muzzle); flashLight.intensity = 60;
  shake(0.7);
  showPanel(null);
  preview.visible = false;
  setShot("follow");
  if (key === "you") game.heckle("fire", { chance: 0.25 }); else game.react("fire");
}

function updateFlight(dt) {
  const f = S.flight;
  if (!f || f.resolved) return;
  const foeKey = f.key === "you" ? "them" : "you", foe = S.p[foeKey], tShip = ships()[foeKey];
  for (let i = 0; i < 4; i++) {
    const h = dt / 4;
    f.vel.addScaledVector(f.dir, f.along * WIND_ACC * h);
    f.vel.y -= GRAV * h;
    f.pos.addScaledVector(f.vel, h);
    const travelled = Math.hypot(f.pos.x - f.start.x, f.pos.z - f.start.z);
    if (S.krakenLurk && travelled > dist(f.from, foe) * 0.45 && f.vel.y < 4) {
      S.krakenLurk = false; f.resolved = true;
      const at = f.pos.clone();
      kraken.grab(new THREE.Vector3(at.x, 0, at.z).addScaledVector(new THREE.Vector3(-f.dir.z, 0, f.dir.x), 10), at, () => {
        scene.remove(f.mesh); sfx.chomp(); sfx.roar();
        resolve(f, { kind: "eaten", text: "was snatched out of the air by the Kraken" });
      });
      sfx.roar(); game.heckle("kraken", { chance: 0.8, minGap: 0 }); game.react("kraken");
      return;
    }
    for (const isl of S.islands) {
      const dh = Math.hypot(f.pos.x - isl.x, f.pos.z - isl.z);
      if (f.pos.y < isl.h && dh < isl.r * (1 - 0.7 * Math.max(0, f.pos.y) / isl.h)) return resolve(f, { kind: "island", at: f.pos.clone() });
    }
    // The target's hull and masts, in its own frame.
    const dx = f.pos.x - foe.x, dz = f.pos.z - foe.z;
    const lx = dx * Math.cos(foe.h) - dz * Math.sin(foe.h), lz = dx * Math.sin(foe.h) + dz * Math.cos(foe.h);
    const water = waveHeight(f.pos.x, f.pos.z, time.value, ocean.uniforms.uAmp.value);
    if (Math.abs(lx) < 1.3 && [-9.5, 0, 9.5].some((mz) => Math.abs(lz - mz) < 1.5) && f.pos.y > 6 && f.pos.y < 30) return resolve(f, { kind: "mast", at: f.pos.clone() });
    if (Math.abs(lx) < 4.8 && Math.abs(lz) < 17.5 && f.pos.y < tShip.body.position.y + 5.2 && f.pos.y > water - 1.5) return resolve(f, { kind: "hull", at: f.pos.clone(), lx, lz });
    if (f.pos.y < water) {
      // How far off, along the shot (short/long) and across it (wide): the
      // target's footprint is long one way and narrow the other.
      const rx = f.pos.x - foe.x, rz = f.pos.z - foe.z;
      const along = rx * f.dir.x + rz * f.dir.z, across = rx * -f.dir.z + rz * f.dir.x;
      const c = Math.abs(f.dir.x * Math.sin(foe.h) + f.dir.z * Math.cos(foe.h)), s = Math.sqrt(1 - Math.min(1, c * c));
      const offAlong = Math.max(0, Math.abs(along) - (c * 17 + s * 4.6)), offAcross = Math.max(0, Math.abs(across) - (c * 4.6 + s * 17));
      return resolve(f, { kind: "water", at: f.pos.clone(), along, across, offAlong, offAcross, off: Math.hypot(offAlong, offAcross) });
    }
  }
  f.mesh.position.copy(f.pos);
  if (f.mesh === anchorMesh) f.mesh.rotation.z += dt * 8;
  if (Math.random() < 0.8) fx.trail(f.pos);
  S.timeScale = dist(f.pos, foe) < 30 && f.vel.y < 0 ? 0.35 : 1;
}

function resolve(f, hit) {
  f.resolved = true;
  S.timeScale = 1;
  const foeKey = f.key === "you" ? "them" : "you", me = S.p[f.key], foe = S.p[foeKey], target = ships()[foeKey];
  let dmg = 0, text, big = false;
  scene.remove(f.mesh);
  if (hit.kind === "hull" || hit.kind === "mast") {
    const ammo = AMMO[f.ammo];
    if (hit.kind === "mast") { dmg = 12; text = "smashed into their rigging"; target.tear(4); }
    else {
      dmg = rnd(...ammo.dmg);
      if (Math.abs(hit.lx) < 1.6 && Math.abs(hit.lz) < 3 && f.ammo !== "chain shot") { dmg += 12; big = true; }
      text = big ? "landed a CRITICAL hit amidships" : "hit their hull";
      target.tear(ammo.sail);
    }
    if (f.rake && hit.kind === "hull") { dmg *= 1.6; text = `RAKED their ${f.rake}, running down the length of the ship`; me.rakes++; }
    if (me.powder) { dmg *= 1.6; me.powder = false; text += " (powder keg!)"; }
    dmg = Math.round(dmg);
    if (f.ammo === "chain shot") { foe.wobble = 2.6; text += " (chain shot: their sails are shredded, their next shot will wobble)"; }
    fx.explosion(hit.at);
    sfx.boom(); sfx.creak();
    shake(big || f.rake ? 1.7 : 1.1);
    flashLight.position.copy(hit.at); flashLight.intensity = 140;
    target.wounds.push(target.body.worldToLocal(hit.at.clone()));
    me.hits++;
    foe.hp = Math.max(0, foe.hp - dmg);
    target.list = (100 - foe.hp) / 100 * 0.12;
    float(`-${dmg}${f.rake ? " RAKED!" : big ? " CRIT!" : ""}`, foeKey);
    banner(f.rake ? `RAKED THE ${f.rake.toUpperCase()}!` : big ? "CRITICAL HIT!" : f.ammo === "anchor" ? "ANCHOR AWAY!" : "DIRECT HIT!");
    if (f.key === "you") { game.award(f.rake ? 45 : big ? 40 : 20, f.rake ? "Raked!" : big ? "Crit!" : "Hit!", $("them-plaque")); game.react("hurt"); game.heckle("hit", { chance: 0.4 }); }
    else { game.react("hit"); game.heckle("hurt", { chance: 0.35 }); }
    setShot("impact", hit.at);
  } else if (hit.kind === "island") {
    text = "smacked into an island";
    fx.dust(hit.at); sfx.boom(); shake(0.5);
    banner("THE ISLAND TOOK IT!");
    setShot("impact", hit.at);
  } else if (hit.kind === "water") {
    const close = hit.off < 7, wide = hit.offAcross > hit.offAlong;
    if (close) { dmg = 5; foe.hp = Math.max(0, foe.hp - dmg); float("-5 rocked", foeKey); }
    const how = wide ? `${Math.round(hit.offAcross)} m wide to the ${hit.across > 0 ? "left" : "right"}`
      : `${Math.round(hit.offAlong)} m ${hit.along < 0 ? "short" : "long"}`;
    text = close ? `splashed right alongside them (${how}), rocking the ship`
      : wide ? `went ${how} of their ship${f.rake ? " (a ship seen end-on is a narrow target)" : ""}`
      : `landed ${Math.round(hit.offAlong)} m ${hit.along < 0 ? "short of" : "past"} their ship`;
    fx.splash(hit.at, 1.3); sfx.splash();
    banner(close ? "SO CLOSE!" : wide ? "WIDE!" : hit.along < 0 ? "SHORT!" : "LONG!");
    if (f.key === "them") game.react("miss"); else game.heckle("miss", { chance: 0.2 });
    setShot("impact", hit.at);
  } else { text = hit.text; banner("THE KRAKEN!"); }
  me.shots.push({ angle: f.angle, power: f.power, ammo: f.ammo, result: text });
  hud();
  const hulls = `Hulls: yours ${S.p.them.hp}/100, theirs ${S.p.you.hp}/100.`;
  if (f.key === "them") game.tell(`Your shot (angle ${f.angle}, power ${f.power}, ${f.ammo}) ${text}. ${hulls}`, false);
  else game.tell(`The user fired (angle ${f.angle}, power ${f.power}, ${f.ammo}): it ${text.replace(/their/g, "your")}. ${hulls}`, dmg === 0);
  setTimeout(() => { S.flight = null; endTurn(f.key); }, 2600);
}

function repair(key) {
  const p = S.p[key];
  p.kits--; p.hp = Math.min(100, p.hp + 15);
  const ship = ships()[key];
  fx.sparkle(ship.world(new THREE.Vector3(0, 4, 0)));
  [0, 250, 500].forEach((t) => setTimeout(() => sfx.clang(), t));
  float("+15 repaired", key, "#86efac");
  banner("PATCHED UP!");
  ship.wounds.splice(0, 1);
  if (key === "them") game.tell(`You repaired: hull ${p.hp}/100.`, true);
  else game.tell(`The user repaired their ship: hull ${p.hp}/100.`, true);
  hud();
  setTimeout(() => endTurn(key), 1800);
}

/** Full sail into them: the rammer surges ahead, timbers split. */
function ram(key) {
  const me = S.p[key], foeKey = key === "you" ? "them" : "you", foe = S.p[foeKey];
  const d = dist(me, foe), b = bowOf(me.h), go = Math.max(0, d - 26);
  S.phase = key === "you" ? "sailing" : "themSailing";
  const plan = { path: Array.from({ length: 20 }, (_, i) => ({ x: me.x + b.x * go * (i + 1) / 20, z: me.z + b.z * go * (i + 1) / 20, h: me.h })), picked: [], stop: null, len: go };
  plan.end = plan.path[19];
  S.voyage = { key, plan, t: 0, dur: 1.3, ram: true };
  banner("RAMMING SPEED!");
  sfx.whoosh(); game.heckle("close_call", { chance: 0.5 });
  setShot("sail");
}
function rammed(key) {
  const me = S.p[key], foeKey = key === "you" ? "them" : "you", foe = S.p[foeKey];
  const side = Math.abs(bowOf(me.h).x * bowOf(foe.h).x + bowOf(me.h).z * bowOf(foe.h).z) < 0.5;   // T-boned
  const dmg = side ? 36 : 26;
  foe.hp = Math.max(0, foe.hp - dmg); me.hp = Math.max(0, me.hp - 8);
  const at = ships()[foeKey].world(new THREE.Vector3(0, 3, 0));
  fx.explosion(at); fx.explosion(at.clone().add(new THREE.Vector3(3, 0, 3)));
  sfx.boom(); sfx.creak(); sfx.clang(); shake(2);
  float(`-${dmg} ${side ? "T-BONED!" : "RAMMED!"}`, foeKey); float("-8", key);
  banner(side ? "T-BONED!" : "RAMMED!");
  ships()[foeKey].tear(3);
  if (key === "you") game.award(30, "Rammed!", $("them-plaque"));
  game.tell(`${key === "you" ? "The user rammed you" : "You rammed them"} for ${dmg} damage${side ? " right in the side" : ""}, `
    + `taking 8 in return. Hulls: yours ${S.p.them.hp}/100, theirs ${S.p.you.hp}/100.`, key === "them");
  hud();
  setTimeout(() => endTurn(key), 2200);
}

function endTurn(key) {
  if (S.phase === "over") return;
  if (S.p.you.hp <= 0 || S.p.them.hp <= 0) return sink(S.p.them.hp <= 0 ? "them" : "you");
  S.turn = key === "you" ? "them" : "you";
  nextTurn();
}

function krakenEvent() {
  sfx.roar();
  game.heckle("kraken", { chance: 0.7, minGap: 0 });
  game.react("kraken");
  if (Math.random() < 0.5) {
    S.krakenLurk = true;
    banner("SOMETHING STIRS BELOW…");
    game.tell("A Kraken is lurking between the ships. It may snatch the next shot.", true);
    setTimeout(() => (S.turn === "you" ? userHelm() : companionHelm()), 1500);
    return;
  }
  const victimKey = Math.random() < 0.5 ? "you" : "them", victim = ships()[victimKey];
  const deck = victim.world(new THREE.Vector3(0, 4, 0));
  banner("KRAKEN!");
  setShot("impact", deck);
  kraken.slam(deck.clone().add(new THREE.Vector3(14, 0, 10)), deck, () => {
    S.p[victimKey].hp = Math.max(0, S.p[victimKey].hp - 10);
    fx.splash(deck.clone().setY(1), 2); sfx.boom(); shake(1.4); float("-10 Kraken!", victimKey);
    victim.tear(3);
    game.tell(`The Kraken slammed ${victimKey === "you" ? "the user's ship" : "your ship"} for 10 damage!`, false);
    hud();
  });
  setTimeout(() => {
    if (S.p.you.hp <= 0 || S.p.them.hp <= 0) return sink(S.p.them.hp <= 0 ? "them" : "you");
    S.turn === "you" ? userHelm() : companionHelm();
  }, 5200);
}

function sink(loserKey) {
  S.phase = "over";
  game.cancelForce();
  showPanel(null);
  const loser = ships()[loserKey];
  loser.sinkingStart = performance.now() / 1000;
  setShot("sink", loser.group.position.clone());
  sfx.boom(); setTimeout(() => sfx.creak(), 600); setTimeout(() => sfx.splash(), 2200);
  banner(loserKey === "them" ? "SHE'S GOING DOWN!" : "ABANDON SHIP!");
  game.heckle("sink", { chance: 0.9, minGap: 0 });
  const userWon = loserKey === "them", Y = S.p.you;
  const accuracy = Y.fired ? Y.hits / Y.fired : 0;
  const points = userWon ? Math.round((250 + Y.hp * 2 + accuracy * 150 + Y.rakes * 40) * mode().mult) : 0;
  if (userWon) game.best(points);
  game.tell(userWon ? `Your ship has sunk! The user won with ${Y.hp}/100 hull left.` : `The user's ship has sunk. You won with ${S.p.them.hp}/100 hull left!`, !userWon);
  setTimeout(() => {
    game.end({ outcome: userWon ? "win" : "loss", points, jackpot: userWon && Y.hp >= 80,
      title: userWon ? "VICTORY AT SEA!" : "SUNK!",
      detail: `${Y.hits} of ${Y.fired} shots hit${Y.fired ? ` (${Math.round(accuracy * 100)}%)` : ""}${Y.rakes ? `, ${Y.rakes} raked` : ""}. `
        + (userWon ? `${enemyLook(game.companion).name} rests with the fishes.` : "The Rexmaw needs a long refit.") });
    $("hud").hidden = true;
  }, 6500);
}

// ---- The player's controls -------------------------------------------------------------
function showPanel(which) {
  $("helm-panel").classList.toggle("off", which !== "helm");
  $("act-panel").classList.toggle("off", which !== "act");
  $("helm-panel").hidden = which === "act";
  $("act-panel").hidden = which !== "act";
}
function previewCourse() {
  if (S.phase !== "helm") { courseLine.visible = false; return; }
  const plan = planMove("you", S.helm, S.sail);
  const pts = [new THREE.Vector3(S.p.you.x, 1, S.p.you.z), ...plan.path.map((q) => new THREE.Vector3(q.x, 1, q.z))];
  courseLine.geometry.dispose();
  courseLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  courseLine.computeLineDistances();
  courseLine.visible = true;
  const me = { ...S.p.you, ...plan.end }, foe = S.p.them;
  const side = bears(me, foe), rake = side && rakes(me, foe), wall = side && blockedBy(me, foe), theirs = bears(foe, me);
  const bits = [`${Math.round(dist(me, foe))} m`];
  bits.push(side ? `<b class="ok">${side} guns bear${rake ? ` · RAKE their ${rake}!` : ""}</b>${wall ? ' <b class="bad">(island in the way)</b>' : ""}` : '<span class="bad">no guns bear</span>');
  bits.push(theirs ? `<span class="bad">their ${theirs} guns bear on you</span>` : '<span class="ok">safe from their guns</span>');
  if (plan.picked.length) bits.push(`<b class="loot">+ ${plan.picked.map((l) => LOOT[l.kind].name).join(", ")}</b>`);
  if (plan.stop === "aground") bits.push('<b class="bad">AGROUND!</b>');
  if (plan.stop === "shoals") bits.push("shoals");
  $("helm-info").innerHTML = bits.join(" · ");
  S.plan = plan;
}
document.querySelectorAll("[data-helm]").forEach((b) => { b.onclick = () => { S.helm = b.dataset.helm; sfx.tick(); hud(); previewCourse(); }; });
document.querySelectorAll("[data-sail]").forEach((b) => { b.onclick = () => { S.sail = b.dataset.sail; sfx.tick(); hud(); previewCourse(); }; });
$("make-way").onclick = () => { if (S.phase === "helm") { sfx.click(); game.tell(`The user steers ${S.helm} at ${S.sail} sail.`, true); sailOut("you", S.helm, S.sail); } };

function updatePreview() {
  const side = S.phase === "act" && bears(S.p.you, S.p.them);
  if (!side) { preview.visible = false; return; }
  const me = S.p.you, foe = S.p.them, d = dist(me, foe);
  const dir = new THREE.Vector3((foe.x - me.x) / d, 0, (foe.z - me.z) / d), along = windAlong(me, foe);
  const muzzle = you.world(you.muzzles[side][2]);
  const v = S.aim.power * SPEED * AMMO[S.aim.ammo].speed, a = S.aim.angle * DEG;
  const pts = [];
  let h = 0, y = muzzle.y, vh = v * Math.cos(a), vy = v * Math.sin(a);
  const total = (2 * vy) / GRAV + 1, dt = 1 / 30, show = me.spyglass ? 1.2 : 0.42;
  for (let t = 0; t < total * show && (t < 0.2 || y > -1); t += dt) {
    pts.push(new THREE.Vector3(muzzle.x + dir.x * h, y, muzzle.z + dir.z * h));
    vh += along * WIND_ACC * dt; vy -= GRAV * dt; h += vh * dt; y += vy * dt;
  }
  preview.geometry.dispose();
  preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  preview.computeLineDistances();
  preview.visible = true;
  $("angle-v").textContent = `${S.aim.angle}°`; $("power-v").textContent = S.aim.power;
}
function setAim(k, v) {
  S.aim[k] = k === "angle" ? THREE.MathUtils.clamp(v, 5, 70) : THREE.MathUtils.clamp(v, 10, 100);
  $(k).value = S.aim[k]; sfx.tick(); updatePreview();
}
$("angle").oninput = (e) => setAim("angle", Number(e.target.value));
$("power").oninput = (e) => setAim("power", Number(e.target.value));
document.querySelectorAll("[data-ammo]").forEach((b) => {
  b.onclick = () => { const a = b.dataset.ammo; if (a !== "cannonball" && !S.p.you.ammo[a]) { sfx.error(); return; } S.aim.ammo = a; sfx.click(); hud(); updatePreview(); };
});
$("fire").onclick = () => {
  if (S.phase !== "act" || !bears(S.p.you, S.p.them)) { sfx.error(); return; }
  if (S.aim.ammo !== "cannonball" && !S.p.you.ammo[S.aim.ammo]) S.aim.ammo = "cannonball";
  fire("you", S.aim.angle, S.aim.power, S.aim.ammo);
  if (S.aim.ammo !== "cannonball" && !S.p.you.ammo[S.aim.ammo]) S.aim.ammo = "cannonball";
};
$("repair").onclick = () => { if (S.phase === "act" && S.p.you.kits) { S.phase = "busy"; showPanel(null); repair("you"); } };
$("ram").onclick = () => { if (S.phase === "act" && canRam(S.p.you, S.p.them)) { showPanel(null); ram("you"); } };
$("hold").onclick = () => { if (S.phase === "act") { S.phase = "busy"; showPanel(null); game.tell("The user holds fire.", true); endTurn("you"); } };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type === "text") return;
  const step = e.shiftKey ? 5 : 1;
  if (S.phase === "helm") {
    const keys = { 1: "hard port", 2: "port", 3: "steady", 4: "starboard", 5: "hard starboard" };
    if (keys[e.key]) { S.helm = keys[e.key]; hud(); previewCourse(); }
    else if (e.key === " " || e.key === "Enter") $("make-way").click();
    else return;
    e.preventDefault(); return;
  }
  if (S.phase !== "act") return;
  if (e.key === "ArrowLeft") setAim("angle", S.aim.angle - step);
  else if (e.key === "ArrowRight") setAim("angle", S.aim.angle + step);
  else if (e.key === "ArrowUp") setAim("power", S.aim.power + step);
  else if (e.key === "ArrowDown") setAim("power", S.aim.power - step);
  else if (e.key === " " || e.key === "Enter") $("fire").click();
  else return;
  e.preventDefault();
});

// ---- The camera director -----------------------------------------------------------------
const cam = { mode: "title", at: new THREE.Vector3(), pos: new THREE.Vector3(0, 60, 260), look: new THREE.Vector3(), yaw: 0, pitch: 0, zoom: 1, shake: 0 };
function setShot(m, at = null) { cam.mode = m; if (at) cam.at.copy(at); cam.yaw = 0; cam.pitch = 0; }
function shake(v) { cam.shake = Math.max(cam.shake, v); }
function shipPos(key) { const g = ships()[key].group.position; return new THREE.Vector3(g.x, 0, g.z); }
function direct(dt, t) {
  const want = new THREE.Vector3(), look = new THREE.Vector3();
  let k = 2;
  const active = S.turn, me = shipPos(active), foe = shipPos(active === "you" ? "them" : "you");
  switch (cam.mode) {
    case "title": want.set(Math.cos(t * 0.05) * 300, 70, Math.sin(t * 0.05) * 300); look.set(0, 8, 0); k = 1; break;
    case "tactical": {
      // High over the shoulder of whoever's moving: the whole board in view.
      // Looking past your own ship (kept clear of the panels) to theirs.
      const mid = me.clone().add(foe).multiplyScalar(0.5), d = me.distanceTo(foe);
      const back = me.clone().sub(foe).setY(0).normalize();
      want.copy(me).addScaledVector(back, 95 + d * 0.15).setY(62 + d * 0.22);
      look.copy(mid).lerp(foe, 0.15).setY(-10); k = 1.6; break;
    }
    case "sail": {
      const g = ships()[S.voyage?.key || active].group, b = bowOf(g.rotation.y);
      want.set(g.position.x - b.x * 60 + b.z * 22, 28, g.position.z - b.z * 60 - b.x * 22);
      look.set(g.position.x + b.x * 40, 4, g.position.z + b.z * 40); k = 3; break;
    }
    case "aim": {
      const dir = foe.clone().sub(me).normalize(), side = new THREE.Vector3(-dir.z, 0, dir.x);
      want.copy(me).addScaledVector(dir, -42).addScaledVector(side, 16).setY(22);
      look.copy(foe).setY(4); k = 2.5; break;
    }
    case "follow": {
      const f = S.flight;
      if (f && !f.resolved) { const side = new THREE.Vector3(-f.dir.z, 0, f.dir.x); want.copy(f.pos).addScaledVector(f.dir, -30).addScaledVector(side, 24).add(new THREE.Vector3(0, 8, 0)); look.copy(f.pos).addScaledVector(f.vel, 0.4); k = 5; }
      else { want.copy(cam.pos); look.copy(cam.look); }
      break;
    }
    case "impact": want.copy(cam.at).add(new THREE.Vector3(-26, 14, -32)); look.copy(cam.at); k = 2.5; break;
    case "sink": want.copy(cam.at).add(new THREE.Vector3(Math.cos(t * 0.15) * 75, 24, Math.sin(t * 0.15) * 75)); look.copy(cam.at); k = 1.2; break;
  }
  const rel = want.clone().sub(look);
  rel.applyAxisAngle(new THREE.Vector3(0, 1, 0), cam.yaw); rel.y += cam.pitch * 40; rel.multiplyScalar(cam.zoom);
  want.copy(look).add(rel);
  const a = 1 - Math.exp(-dt * k);
  cam.pos.lerp(want, a); cam.look.lerp(look, a);
  const minY = waveHeight(cam.pos.x, cam.pos.z, t, ocean.uniforms.uAmp.value) + 2;
  if (cam.pos.y < minY) cam.pos.y = minY;
  camera.position.copy(cam.pos);
  if (cam.shake > 0) { camera.position.add(new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(cam.shake)); cam.shake = Math.max(0, cam.shake - dt * 2.5); }
  camera.lookAt(cam.look);
}
let drag = null;
renderer.domElement.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; });
addEventListener("pointerup", () => { drag = null; });
addEventListener("pointermove", (e) => {
  if (!drag) return;
  cam.yaw -= (e.clientX - drag.x) * 0.004; cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - drag.y) * 0.004, -0.5, 1);
  drag = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener("wheel", (e) => { cam.zoom = THREE.MathUtils.clamp(cam.zoom * (1 + Math.sign(e.deltaY) * 0.08), 0.45, 2.2); }, { passive: true });

// ---- The chart: a top-down map of the battle ---------------------------------------------
const chart = $("chart"), cg = chart.getContext("2d");
function drawChart(t) {
  const W = chart.width, H = chart.height, sc = (W / 2 - 8) / ARENA;
  const X = (x) => W / 2 + x * sc, Y = (z) => H / 2 + z * sc;   // north (-z) up
  cg.clearRect(0, 0, W, H);
  cg.fillStyle = "#0b3a55"; cg.beginPath(); cg.arc(W / 2, H / 2, W / 2 - 4, 0, 6.28); cg.fill();
  cg.strokeStyle = "rgba(253,230,138,.35)"; cg.setLineDash([4, 4]); cg.beginPath(); cg.arc(W / 2, H / 2, ARENA * sc, 0, 6.28); cg.stroke(); cg.setLineDash([]);
  for (const s of S.islands) { cg.fillStyle = "#e6cf98"; cg.beginPath(); cg.arc(X(s.x), Y(s.z), s.r * sc * 1.15, 0, 6.28); cg.fill(); cg.fillStyle = "#3f6d35"; cg.beginPath(); cg.arc(X(s.x), Y(s.z), s.r * sc * 0.8, 0, 6.28); cg.fill(); }
  for (const l of S.loot) { cg.fillStyle = LOOT[l.kind].band; cg.beginPath(); cg.arc(X(l.x), Y(l.z), 4 + Math.sin(t * 4) * 1, 0, 6.28); cg.fill(); }
  const arcs = (p, color) => {
    for (const side of [1, -1]) {
      const beam = p.h + side * Math.PI / 2;
      cg.fillStyle = color; cg.beginPath(); cg.moveTo(X(p.x), Y(p.z));
      for (let a = -ARC; a <= ARC; a += 4) { const ang = beam + a * DEG; cg.lineTo(X(p.x + Math.sin(ang) * 420), Y(p.z + Math.cos(ang) * 420)); }
      cg.closePath(); cg.fill();
    }
  };
  const live = (key) => { const g = ships()[key]?.group; return g ? { x: g.position.x, z: g.position.z, h: g.rotation.y } : S.p[key]; };
  arcs(live("them"), "rgba(14,116,144,.14)"); arcs(live("you"), "rgba(225,29,72,.16)");
  if (S.phase === "helm" && S.plan) {
    cg.strokeStyle = "#f8fafc"; cg.setLineDash([3, 3]); cg.beginPath(); cg.moveTo(X(S.p.you.x), Y(S.p.you.z));
    for (const q of S.plan.path) cg.lineTo(X(q.x), Y(q.z));
    cg.stroke(); cg.setLineDash([]);
    shipIcon(S.plan.end, "rgba(248,250,252,.55)");
  }
  shipIcon(live("them"), "#22d3ee"); shipIcon(live("you"), "#fb7185");
  if (S.flight && !S.flight.resolved) { cg.fillStyle = "#fff"; cg.beginPath(); cg.arc(X(S.flight.pos.x), Y(S.flight.pos.z), 2.5, 0, 6.28); cg.fill(); }
  // The wind, top right.
  const wx = W - 22, wy = 22, wd = { x: Math.sin(S.wind.dir), z: Math.cos(S.wind.dir) };
  cg.strokeStyle = "#bae6fd"; cg.lineWidth = 2.5; cg.beginPath(); cg.moveTo(wx - wd.x * 12, wy - wd.z * 12); cg.lineTo(wx + wd.x * 12, wy + wd.z * 12); cg.stroke();
  cg.beginPath(); cg.arc(wx + wd.x * 12, wy + wd.z * 12, 3, 0, 6.28); cg.fillStyle = "#bae6fd"; cg.fill(); cg.lineWidth = 1;
  cg.fillStyle = "#fde68a"; cg.font = "bold 10px system-ui"; cg.textAlign = "center"; cg.fillText("N", W / 2, 13);
  function shipIcon(p, color) {
    const b = bowOf(p.h), s = starOf(p.h), L = 11, B = 4.5;
    cg.fillStyle = color; cg.beginPath();
    cg.moveTo(X(p.x) + b.x * L, Y(p.z) + b.z * L);
    cg.lineTo(X(p.x) - b.x * L * 0.7 + s.x * B, Y(p.z) - b.z * L * 0.7 + s.z * B);
    cg.lineTo(X(p.x) - b.x * L * 0.7 - s.x * B, Y(p.z) - b.z * L * 0.7 - s.z * B);
    cg.closePath(); cg.fill();
  }
}

// ---- HUD ---------------------------------------------------------------------------------
function hud() {
  if (!you) return;
  for (const k of ["you", "them"]) {
    const p = S.p[k];
    $(`${k}-hp`).style.width = `${p.hp}%`;
    $(`${k}-hp`).className = `fill${p.hp < 35 ? " low" : ""}`;
    $(`${k}-hpv`).textContent = p.hp;
    $(`${k}-extra`).textContent = [p.kits ? `🔧${p.kits}` : "", p.powder ? "💥 powder" : "", p.spyglass ? "🔭 spyglass" : "", p.wobble > 1 ? "🌀 torn sails" : ""].filter(Boolean).join("  ");
  }
  $("them-ship").textContent = enemyLook(game.companion).name;
  $("wind").textContent = `${S.wind.speed} m/s from the ${point((compass(S.wind.dir) + 180) % 360)}`;
  $("dist").textContent = `${Math.round(dist(S.p.you, S.p.them))} m`;
  $("round").textContent = `Round ${Math.max(1, Math.ceil(S.round / 2))}`;
  document.querySelectorAll("[data-helm]").forEach((b) => b.classList.toggle("on", b.dataset.helm === S.helm));
  document.querySelectorAll("[data-sail]").forEach((b) => b.classList.toggle("on", b.dataset.sail === S.sail));
  document.querySelectorAll("[data-ammo]").forEach((b) => {
    const a = b.dataset.ammo;
    b.classList.toggle("on", S.aim.ammo === a);
    b.querySelector("i").textContent = a === "cannonball" ? "∞" : S.p.you.ammo[a];
    b.disabled = a !== "cannonball" && !S.p.you.ammo[a];
  });
  const side = bears(S.p.you, S.p.them), rake = side && rakes(S.p.you, S.p.them), wall = side && blockedBy(S.p.you, S.p.them);
  $("bear").innerHTML = side ? `<b class="ok">${side[0].toUpperCase() + side.slice(1)} guns bear</b>${rake ? ` · <b class="loot">RAKING their ${rake}!</b>` : ""}${wall ? ' · <b class="bad">island in the way</b>' : ""}`
    : '<span class="bad">No guns bear from here.</span> Repair, ram or hold, and steer better next turn.';
  $("fire").disabled = !side;
  $("repair").textContent = `🔧 Repair (${S.p.you.kits})`; $("repair").disabled = !S.p.you.kits;
  $("ram").disabled = !canRam(S.p.you, S.p.them);
}
function banner(text) { const el = $("banner"); el.textContent = text; el.classList.remove("show"); void el.offsetWidth; el.classList.add("show"); }
function float(text, key, color) { R.fx.float(text, { at: $(`${key}-plaque`), color: color || (key === "you" ? "#fca5a5" : "#fde68a"), big: true }); }

// ---- The loop ------------------------------------------------------------------------------
S.p.you = Object.assign(fresh(), { x: -150, z: 60, h: 2.2 });
S.p.them = Object.assign(fresh(), { x: 150, z: -60, h: -0.9 });
buildShips();
hud();
$("set-sail").onclick = () => { sfx.click(); startMatch(); };
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); fx.setScale(innerHeight); });
fx.setScale(innerHeight);

function frame() {
  requestAnimationFrame(frame);
  const raw = Math.min(clock.getDelta(), 0.05);
  const dt = raw * S.timeScale;
  time.value += dt;
  const t = time.value, amp = ocean.uniforms.uAmp.value;
  ocean.uniforms.uTime.value = t;
  stepVoyage(raw);
  for (const [key, s] of Object.entries(ships())) {
    if (s.sinkingStart) s.sinking = Math.min(1, (performance.now() / 1000 - s.sinkingStart) / 8);
    s.float(t, amp);
    const hp = S.p[key].hp;
    for (const w of s.wounds) fx.burn(s.body.localToWorld(w.clone()), hp < 50 ? 1 : 0.35);
    if (s.sinking > 0 && s.sinking < 1) fx.bubbles(s.group.position.clone().setY(0.5));
  }
  for (const l of S.loot) floatLoot(l.mesh, t, amp);
  updateFlight(dt);
  flashLight.intensity *= Math.pow(0.02, raw);
  if (sky.update(raw, t, camera)) sfx.thunder();
  fx.update(dt, t, amp);
  gulls.update(t);
  kraken.update(t);
  direct(raw, t);
  drawChart(t);
  renderer.render(scene, camera);
}

/** Move the sailing ship along its planned course, wake and all. */
function stepVoyage(dt) {
  const v = S.voyage;
  if (!v) return;
  v.t += dt;
  const f = Math.min(1, v.t / v.dur), path = v.plan.path, from = S.p[v.key];
  const ease = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
  const idx = ease * path.length, i = Math.min(path.length - 1, Math.floor(idx));
  const a = i === 0 ? from : path[i - 1], b = path[i], u = idx - Math.floor(idx);
  const g = ships()[v.key].group;
  g.position.set(a.x + (b.x - a.x) * u, 0, a.z + (b.z - a.z) * u);
  g.rotation.y = a.h + (b.h - a.h) * u;
  if (Math.random() < 0.7 && v.plan.len > 1) {
    const bw = bowOf(g.rotation.y);
    fx.wake(new THREE.Vector3(g.position.x - bw.x * 16, 0.2, g.position.z - bw.z * 16), new THREE.Vector3(-bw.x, 0, -bw.z));
    fx.wake(new THREE.Vector3(g.position.x + bw.x * 17, 0.2, g.position.z + bw.z * 17), new THREE.Vector3(bw.z, 0, -bw.x));
  }
  if (f >= 1) {
    if (v.ram) { Object.assign(S.p[v.key], v.plan.end); S.voyage = null; rammed(v.key); }
    else arrive();
  }
}
frame();

// A handle for testing from the console: the state, the rules, and a fast
// forward for voyages and shots in the air (slow software renderers crawl).
window.__broadside = { S, range, bears, rakes, planMove, bestPower,
  aim: (angle, power) => { setAim("angle", angle); setAim("power", power); },
  fastForward(seconds = 14) {
    for (let t = 0; t < seconds; t += 0.02) {
      if (S.voyage) stepVoyage(0.05);
      else if (S.flight && !S.flight.resolved) updateFlight(0.02);
      else break;
    }
  } };
