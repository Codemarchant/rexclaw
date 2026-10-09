// Rexmaw Raids: the enemy crew in a boarding fight (boardfight.js drives them).
//
// Simple, readable procedural figures: a capsule body on a 13-joint skeleton (pelvis, torso, head,
// two three-joint arms, two two-joint legs) posed by hand every frame and drawn as instances —
// one draw per body part for the whole crew (pelvis, torso, sash, head, tricorn, bandana, upper
// arms, forearms, thighs, shins, the weapons, the captain's coat skirts, contact shadows), on
// two shared programs (cloth/skin and metal). Every foe wears a bright red sash and a faint red rim
// light so they never read as one of ours; the captain is a size bigger, in a long coat and a
// tricorn, with a heavier sabre.
//
// Looks (`look` in spawn): the plain sailor, and the crew variants — navy marines (red coats, shakos,
// muskets), cooks (caps, aprons, rolling pins), monkeys (small, a fez, a tail, a banana), skeletons
// (skulls, ribs, bone-white limbs), flying gulls (a bird body, flapping wings) — and the whacky
// captains: Three-Gulls (a gull's head over the collar and two more poking out of the coat; the coat
// collapses into a heap), Admiral Fernsby-Whistle (powdered wig, bicorne, epaulettes, a teacup),
// Cookie Mabel (toque, apron, frying pan and ladle), Peg-Leg Pip (tiny, an oversized tricorn, a
// peg leg) riding the shoulders of Tiny (huge, bald, a club), Baron Von Bubbles (in a wheeled bathtub,
// shower cap, back-brush), Señor Encore (cape, ruff, moustache), Captain Clackers (a crab: shell, eye
// stalks, two big claws, six legs, a tricorn), The Mime (beret, stripes, white face, no weapon at all),
// The Pale Captain (washed-out blue-grey). Accessories are extra instanced parts that only draw when
// a figure on deck wears them.
//
//   pool       CAP figures built once; spawn() hands slots out, add() one more, clear() takes them back.
//   acts       idle (guard, sway), walk/run (moveTo), attack (windup → chop → recover), parry, hit
//              (flinch and a step back), knock (a stagger), down (a ragdoll-ish topple: falls away
//              from the blow under gravity, bounces, limbs sprawl, the weapon clatters to the deck),
//              aim / fire (pistols, muskets), surrender (weapon down, hands up, some kneel), cheer
//              (repelled us), the captain's telegraph (sabre high in both hands, the blade glowing red)
//              → slam (an overhead blow), taunt (the sabre levelled at us); and the gimmicks' poses:
//              tea (the cup to the lips), sing (arms flung wide, swaying), throw (a pie), mime (palms
//              out on a wall that isn't there), collapse (the gull coat heaps on the deck), getup.
//   frames     the group's frame (boardfight.js parents it to the enemy ship's body: +Z bow, +X port,
//              y = 0 at the waterline). `deckY(x, z)` puts feet on her deck.
//
// API: createSailors(R, {layer}) → {group, spawn(list), add(d), clear(), get(id), list, update(dt, {deckY}),
// pick(ray) → {id, dist}, headWorld(id, out), chestWorld(id, out), bladeWorld(id, out), handWorld(id, out, side),
// muzzleWorld(id, out), ride(id, carrierId|null), warmShow(on), dispose()}.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const CAP = 20;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const THIGH = 0.44, SHIN = 0.44, ANKLE = 0.07;

/** Shirts, trousers, skin, headwear. Navy ships dress their hands in blue and white. */
const PAL = {
  shirt: ["#d9d0bb", "#c8bfa6", "#3d5d8c", "#a8875a", "#6f6a62", "#e6e0d0", "#5b6e4a", "#8a3a2a"],
  navyShirt: ["#24407a", "#2b4a86", "#e8e2d2", "#1f3566"],
  pants: ["#3b352e", "#4a4036", "#2c2a30", "#6a5a46", "#d6cfbe"],
  navyPants: ["#e2dccb", "#d6cfbe", "#2c2a30"],
  skin: ["#e0b48e", "#c8956c", "#a8714c", "#7d4f33", "#f0c8a4", "#b98463"],
  band: ["#b8352a", "#2a3e6a", "#d8d0bc", "#1c1a18", "#6a2a5a", "#3a5a3a"],
  hat: ["#1c1a18", "#2a2420", "#22283a"],
  sash: "#d01e26",
};
const CAPTAIN = { coat: { navy: "#1d2c5a", merchant: "#5a3420", pirate: "#6a1420" }, pants: "#e2dccb", hat: "#141210", sash: "#e0b040" };

/**
 * The looks: colours (null = the usual pick), scale, headwear, the accessories worn, the weapon, the body parts
 * hidden, and flags (crab, tub, bird, coat). Captains' looks are keyed by archetype.
 */
const LOOKS = {
  sailor: {},
  marine: { shirt: ["#b8322a", "#a82c26"], pants: ["#e2dccb"], hat: "shako", acc: ["epaulettes"], gun: "musket" },
  cook: { shirt: ["#f0ece0", "#e6e2d6"], pants: ["#3a3a44", "#4a4036"], hat: "cookCap", acc: ["apron"], weapon: "pin", gun: "pin" },
  monkey: { scale: [0.5, 0.56], shirt: ["#6a4a2a"], pants: ["#5e4026"], skin: ["#6a4a2a"], head: "#b8241e", hat: "fez", acc: ["monkeyFace", "tail"], weapon: "banana", gun: "banana" },
  skeleton: { shirt: ["#3a3633", "#2e2b29"], pants: ["#4a4440", "#3a3633"], skin: ["#e8e2cc"], hat: "bandanaSome", acc: ["ribs"], hide: ["head"], extraHead: "skull", bones: true },
  gull: { bird: true, scale: [0.95, 1.05] },
  tiny: { scale: [1.62, 1.62], shirt: ["#7a5a3a"], pants: ["#3b352e"], skin: ["#c8956c"], hat: "none", weapon: "club" },
  // The captains.
  gulls: { coat: "#3a4a6a", shirt: ["#3a4a6a"], pants: ["#e8a33a"], skin: ["#f4f4f0"], head: "#141210", hat: "tricorn", acc: ["gullPeek", "gullPeek2"], hide: ["head"], extraHead: "gullHead",
    sash: "#e0b040" },
  admiral: { coat: "#1d2c5a", shirt: ["#1d2c5a"], pants: ["#ecebe4"], hat: "bicorne", acc: ["wig", "epaulettes", "teacup"], sash: "#e0b040", head: "#16181f" },
  chef: { scale: [1.28, 1.28], coat: "#f2efe6", shirt: ["#f2efe6"], pants: ["#3a3a44"], hat: "toque", acc: ["apron", "ladle"], weapon: "pan", sash: "#d01e26" },
  pip: { scale: [0.6, 0.6], coat: "#7a1e1e", shirt: ["#7a1e1e"], pants: ["#e2dccb"], hat: "tricorn", hatScale: 1.5, acc: ["peg"], hideR: ["shin"], sash: "#e0b040" },
  bubbles: { scale: [1.1, 1.1], coat: null, shirt: ["#f0c8a4"], skin: ["#f0c8a4"], pants: ["#f0c8a4"], hat: "cookCap", acc: ["tub", "mustache"], weapon: "brush", tub: true,
    tint: { cookCap: "#f4a6c0" }, sash: "#3a8ad0" },
  encore: { coat: "#4a1a5a", shirt: ["#4a1a5a"], pants: ["#1c1a18"], hat: "bandana", head: "#141210", acc: ["cape", "ruff", "mustache"], sash: "#e0b040" },
  clackers: { scale: [1.32, 1.32], coat: null, shirt: ["#d0402a"], pants: ["#c23a26"], skin: ["#d0402a"], hat: "tricorn", head: "#141210", acc: ["crabShell", "claw", "crabLegs"],
    hide: ["torso", "head", "sash"], weapon: "none", crab: true },
  mime: { coat: null, shirt: ["#f6f6f2"], pants: ["#1c1c1e"], skin: ["#faf8f4"], hat: "beret", head: "#141414", acc: ["stripes", "mimeFace"], weapon: "none", sash: "#d01e26" },
  pale: { coat: "#4d5f6a", shirt: ["#56697a"], pants: ["#9fb3bb"], skin: ["#d8eef2"], head: "#1a2228", hat: "tricorn", acc: ["mimeFace"], tint: { mimeFace: "#3a5a6a" }, sash: "#7ad8e8" },
};

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---- Geometry ------------------------------------------------------------------------------------

function paint(geo, hex) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
const merge = (...gs) => mergeGeometries(gs, false);

function buildGeometries() {
  const W = "#ffffff";
  const G = {};
  G.pelvis = paint(new THREE.SphereGeometry(0.17, 12, 8).scale(1, 0.72, 0.72).translate(0, 0.02, 0), W);
  G.torso = paint(new THREE.CapsuleGeometry(0.16, 0.3, 4, 12).scale(1.12, 1, 0.74).translate(0, 0.27, 0), W);
  G.sash = merge(
    paint(new THREE.CylinderGeometry(0.183, 0.178, 0.1, 14).scale(1, 1, 0.78).translate(0, 0.07, 0), W),
    paint(new THREE.BoxGeometry(0.06, 0.2, 0.03).translate(-0.15, -0.05, 0.05), W),
    paint(new THREE.BoxGeometry(0.035, 0.42, 0.025).rotateZ(0.72).translate(-0.02, 0.32, 0.125), W),   // the bandolier across the chest
  );
  G.head = merge(
    paint(new THREE.SphereGeometry(0.115, 14, 10).scale(1, 1.1, 1).translate(0, 0.12, 0), W),
    paint(new THREE.BoxGeometry(0.035, 0.05, 0.05).translate(0, 0.11, 0.115), W),                       // the nose: which way they face
    paint(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8).translate(0, -0.01, 0), W),                  // neck
  );
  const brim = new THREE.CylinderGeometry(0.21, 0.21, 0.03, 3).translate(0, 0.215, -0.01);
  // A tricorn's brim turned up at the three corners.
  const p = brim.attributes.position;
  for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getZ(i)); p.setY(i, p.getY(i) + Math.max(0, r - 0.1) * 0.55); }
  G.tricorn = merge(
    paint(brim, W),
    paint(new THREE.CylinderGeometry(0.095, 0.115, 0.11, 12).translate(0, 0.26, 0), W),
  );
  G.bandana = merge(
    paint(new THREE.SphereGeometry(0.124, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(1.03, 1.08, 1.05).translate(0, 0.125, -0.005), W),
    paint(new THREE.BoxGeometry(0.05, 0.12, 0.025).rotateX(0.5).translate(0.03, 0.06, -0.135), W),
  );
  G.upper = paint(new THREE.CapsuleGeometry(0.054, 0.2, 3, 8).translate(0, -0.13, 0), W);
  G.fore = merge(
    paint(new THREE.CapsuleGeometry(0.046, 0.17, 3, 8).translate(0, -0.11, 0), W),
    paint(new THREE.SphereGeometry(0.055, 8, 6).scale(1, 1.15, 0.9).translate(0, -0.27, 0), W),
  );
  G.thigh = paint(new THREE.CapsuleGeometry(0.072, 0.3, 3, 8).translate(0, -0.2, 0), W);
  G.shin = merge(
    paint(new THREE.CapsuleGeometry(0.058, 0.3, 3, 8).translate(0, -0.2, 0), W),
    paint(new THREE.BoxGeometry(0.11, 0.12, 0.24).translate(0, -0.42, 0.045), "#2a1e16"),
    paint(new THREE.CylinderGeometry(0.068, 0.068, 0.1, 8).translate(0, -0.33, 0), "#3a2a1e"),        // boot tops
  );
  // Weapons in the hand's frame: the fist at (0, -0.04, 0). The cutlass's blade runs out along +Z with
  // a little curve; the pistol's barrel along −Y (the forearm's line: where the arm points, it points).
  const blade = new THREE.BoxGeometry(0.014, 0.05, 0.64, 1, 1, 8).translate(0, 0, 0.38);
  const bp = blade.attributes.position;
  for (let i = 0; i < bp.count; i++) { const z = bp.getZ(i); bp.setY(i, bp.getY(i) + 0.09 * Math.pow(Math.max(0, z) / 0.7, 2)); if (z > 0.66) bp.setY(i, bp.getY(i) * 0.5 + 0.03); }
  G.cutlass = merge(
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 6).translate(0, -0.04, 0), "#3a2414"),
    paint(new THREE.TorusGeometry(0.055, 0.009, 4, 10, Math.PI).rotateY(Math.PI / 2).translate(0, -0.04, 0.03), "#c9a04a"),
    paint(new THREE.BoxGeometry(0.03, 0.03, 0.06).translate(0, -0.04, 0.05), "#c9a04a"),
    paint(blade, "#d6dde4"),
  );
  G.pistol = merge(
    paint(new THREE.BoxGeometry(0.035, 0.05, 0.13).rotateX(0.35).translate(0, -0.03, -0.045), "#4a2c18"),
    paint(new THREE.CylinderGeometry(0.016, 0.02, 0.32, 8).translate(0, -0.2, 0.035), "#2a2c30"),
    paint(new THREE.BoxGeometry(0.03, 0.06, 0.05).translate(0, -0.05, 0.03), "#c9a04a"),
  );
  // A marine's musket (held like the pistol, along −Y): the stock back past the wrist, a long barrel, the bayonet.
  G.musket = merge(
    paint(new THREE.BoxGeometry(0.05, 0.42, 0.07).translate(0, 0.1, -0.02), "#5a3418"),
    paint(new THREE.CylinderGeometry(0.018, 0.02, 0.86, 8).translate(0, -0.45, 0.03), "#3a3c40"),
    paint(new THREE.BoxGeometry(0.012, 0.22, 0.03).translate(0, -0.98, 0.05), "#d6dde4"),
    paint(new THREE.BoxGeometry(0.06, 0.04, 0.05).translate(0, -0.06, 0.03), "#c9a04a"),
  );
  // The captain's coat skirts: a flared cone from the waist to the knees, split at the back.
  G.coat = paint(new THREE.CylinderGeometry(0.19, 0.33, 0.62, 14, 1, true, Math.PI * 0.06, Math.PI * 1.88).rotateY(Math.PI).translate(0, -0.28, 0), W);
  G.coat.computeVertexNormals();

  // ---- The whacky ones' parts (each in its node's frame) ----
  const gullHead = (s = 1) => merge(
    paint(new THREE.SphereGeometry(0.12 * s, 14, 10).scale(1, 1.05, 1.1).translate(0, 0.13 * s, 0), "#f6f6f2"),
    paint(new THREE.ConeGeometry(0.04 * s, 0.17 * s, 8).rotateX(Math.PI / 2).translate(0, 0.1 * s, 0.17 * s), "#f0a020"),
    paint(new THREE.SphereGeometry(0.022 * s, 6, 4).translate(0.07 * s, 0.17 * s, 0.07 * s), "#111111"),
    paint(new THREE.SphereGeometry(0.022 * s, 6, 4).translate(-0.07 * s, 0.17 * s, 0.07 * s), "#111111"),
    paint(new THREE.SphereGeometry(0.035 * s, 6, 4).scale(1.6, 0.7, 1).translate(0, 0.21 * s, 0.05 * s), "#d8d8d4"),     // a scowl
  );
  G.gullHead = merge(gullHead(1), paint(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8).translate(0, -0.01, 0), "#f6f6f2"));
  // Two more gulls: one poking out between the lapels (torso), one under the coat's hem (pelvis), looking sideways.
  G.gullPeek = gullHead(0.75).rotateY(1.1).translate(0.03, 0.2, 0.1);
  G.gullPeek2 = gullHead(0.7).rotateY(-1.4).translate(-0.18, -0.62, 0.06);
  G.wig = merge(
    paint(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1.05, 1, 1.1).translate(0, 0.14, -0.015), "#f2efe8"),
    ...[-1, 1].flatMap((sx) => [0, 1].map((k) => paint(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 8).rotateX(Math.PI / 2).translate(sx * 0.125, 0.11 - k * 0.07, -0.01), "#f2efe8"))),
    paint(new THREE.CylinderGeometry(0.03, 0.025, 0.16, 6).translate(0, 0.0, -0.13), "#f2efe8"),
    paint(new THREE.BoxGeometry(0.09, 0.04, 0.02).translate(0, 0.07, -0.14), "#1c1a18"),
  );
  // The bicorne, worn athwartships: a half disc, gold-edged, a cockade.
  G.bicorne = merge(
    paint(new THREE.CylinderGeometry(0.27, 0.27, 0.07, 18, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.2, 0), "#16181f"),
    paint(new THREE.TorusGeometry(0.27, 0.012, 4, 18, Math.PI).rotateY(Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.2, 0.0), "#e0b040"),
    paint(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10).rotateX(Math.PI / 2).translate(0, 0.27, 0.045), "#f4f0e6"),
  );
  G.epaulettes = merge(...[-1, 1].flatMap((sx) => [
    paint(new THREE.CylinderGeometry(0.075, 0.08, 0.03, 10).translate(sx * 0.19, 0.52, 0), "#e0b040"),
    paint(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 10, 1, true).translate(sx * 0.19, 0.48, 0), "#d0a030"),
  ]));
  G.teacup = merge(
    paint(new THREE.CylinderGeometry(0.04, 0.03, 0.05, 10).translate(0, -0.05, 0.06), "#f6f4ee"),
    paint(new THREE.CylinderGeometry(0.065, 0.065, 0.008, 12).translate(0, -0.078, 0.06), "#f6f4ee"),
    paint(new THREE.TorusGeometry(0.018, 0.005, 4, 8).rotateY(Math.PI / 2).translate(0.045, -0.05, 0.06), "#f6f4ee"),
    paint(new THREE.CylinderGeometry(0.036, 0.036, 0.006, 10).translate(0, -0.027, 0.06), "#6a3a1a"),
  );
  G.toque = merge(
    paint(new THREE.CylinderGeometry(0.11, 0.118, 0.06, 14).translate(0, 0.22, 0), "#f6f4ee"),
    paint(new THREE.CylinderGeometry(0.13, 0.105, 0.22, 14).translate(0, 0.35, 0), "#f6f4ee"),
    paint(new THREE.SphereGeometry(0.16, 12, 8).scale(1, 0.55, 1).translate(0, 0.47, 0), "#ffffff"),
  );
  G.cookCap = merge(
    paint(new THREE.CylinderGeometry(0.115, 0.12, 0.06, 12).translate(0, 0.21, 0), W),
    paint(new THREE.SphereGeometry(0.14, 12, 8).scale(1, 0.6, 1).translate(0, 0.28, -0.01), W),
  );
  G.apron = merge(
    paint(new THREE.BoxGeometry(0.3, 0.62, 0.02).translate(0, 0.06, 0.13), "#f4f1e8"),
    paint(new THREE.BoxGeometry(0.2, 0.08, 0.025).translate(0, 0.0, 0.142), "#e0dccf"),
    paint(new THREE.BoxGeometry(0.025, 0.2, 0.02).rotateZ(0.5).translate(0.07, 0.48, 0.1), "#f4f1e8"),
    paint(new THREE.BoxGeometry(0.025, 0.2, 0.02).rotateZ(-0.5).translate(-0.07, 0.48, 0.1), "#f4f1e8"),
  );
  G.pan = merge(
    paint(new THREE.CylinderGeometry(0.02, 0.022, 0.3, 6).rotateX(Math.PI / 2).translate(0, -0.03, 0.12), "#3a2414"),
    paint(new THREE.CylinderGeometry(0.17, 0.15, 0.04, 16).rotateZ(Math.PI / 2).translate(0, -0.03, 0.42), "#2a2a2e"),
    paint(new THREE.TorusGeometry(0.165, 0.012, 4, 16).rotateY(Math.PI / 2).translate(0.02, -0.03, 0.42), "#3a3a40"),
  );
  G.ladle = merge(
    paint(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 6).rotateX(Math.PI / 2).translate(0, -0.03, 0.16), "#b8bec6"),
    paint(new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, 0.0, 0.36), "#b8bec6"),
  );
  G.pin = merge(
    paint(new THREE.CylinderGeometry(0.042, 0.042, 0.34, 10).rotateX(Math.PI / 2).translate(0, -0.03, 0.24), "#d4ad78"),
    paint(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 6).rotateX(Math.PI / 2).translate(0, -0.03, 0.02), "#b88c58"),
    paint(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 6).rotateX(Math.PI / 2).translate(0, -0.03, 0.46), "#b88c58"),
  );
  G.club = merge(
    paint(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8).rotateX(Math.PI / 2).translate(0, -0.03, 0.03), "#6a4220"),
    paint(new THREE.CylinderGeometry(0.1, 0.05, 0.62, 10).rotateX(Math.PI / 2).translate(0, -0.03, 0.42), "#8a5a30"),
  );
  G.brush = merge(
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 6).rotateX(Math.PI / 2).translate(0, -0.03, 0.26), "#c8955a"),
    paint(new THREE.SphereGeometry(0.09, 10, 6).scale(0.8, 0.5, 1.4).translate(0, -0.03, 0.62), "#e8c838"),
  );
  const banana = new THREE.TorusGeometry(0.11, 0.024, 6, 10, Math.PI * 0.62).rotateZ(Math.PI * 0.2).rotateY(Math.PI / 2).translate(0, -0.08, 0.06);
  G.banana = paint(banana, "#f2d040");
  G.shako = merge(
    paint(new THREE.CylinderGeometry(0.105, 0.11, 0.2, 12).translate(0, 0.3, 0), "#141414"),
    paint(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 12, 1, false, -Math.PI / 2, Math.PI).translate(0, 0.205, 0.03), "#141414"),
    paint(new THREE.BoxGeometry(0.06, 0.07, 0.01).translate(0, 0.3, 0.108), "#e0b040"),
    paint(new THREE.SphereGeometry(0.035, 8, 6).translate(0, 0.43, 0.04), "#f4f0e6"),
  );
  G.beret = merge(
    paint(new THREE.CylinderGeometry(0.145, 0.13, 0.045, 14).rotateZ(0.22).translate(0.02, 0.235, -0.01), W),
    paint(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 4).translate(0.0, 0.275, -0.01), W),
  );
  G.fez = merge(
    paint(new THREE.CylinderGeometry(0.06, 0.075, 0.1, 12).translate(0, 0.25, 0), W),
    paint(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 4).rotateZ(0.6).translate(0.035, 0.28, 0), "#1c1a18"),
  );
  G.crabShell = merge(
    paint(new THREE.SphereGeometry(0.34, 18, 12).scale(1.15, 0.62, 0.78).translate(0, 0.3, 0), "#d0402a"),
    paint(new THREE.SphereGeometry(0.3, 14, 8).scale(1.12, 0.3, 0.72).translate(0, 0.43, 0.02), "#e2583a"),
    ...[-1, 1].flatMap((sx) => [
      paint(new THREE.CylinderGeometry(0.018, 0.022, 0.2, 6).translate(sx * 0.09, 0.56, 0.14), "#c23a26"),
      paint(new THREE.SphereGeometry(0.045, 8, 6).translate(sx * 0.09, 0.67, 0.15), "#f8f8f4"),
      paint(new THREE.SphereGeometry(0.024, 6, 4).translate(sx * 0.09, 0.68, 0.19), "#111111"),
    ]),
    paint(new THREE.BoxGeometry(0.14, 0.02, 0.02).translate(0, 0.33, 0.26), "#5a1410"),                 // a grin
  );
  // A big claw at the hand: a fat lower pincer and a thinner upper one, open.
  G.claw = merge(
    paint(new THREE.SphereGeometry(0.1, 10, 8).scale(1.1, 0.9, 1.3).translate(0, -0.06, 0.08), "#d0402a"),
    paint(new THREE.SphereGeometry(0.08, 10, 6).scale(0.8, 0.55, 2.0).translate(0, -0.1, 0.25), "#e2583a"),
    paint(new THREE.SphereGeometry(0.06, 10, 6).scale(0.75, 0.5, 2.0).rotateX(-0.35).translate(0, 0.0, 0.24), "#e2583a"),
    paint(new THREE.SphereGeometry(0.025, 6, 4).translate(0, -0.1, 0.4), "#f4e0c8"),
  );
  G.crabLegs = merge(...[-1, 1].flatMap((sx) => [-0.12, 0, 0.12].map((dz) =>
    paint(new THREE.CapsuleGeometry(0.03, 0.42, 3, 6).rotateZ(sx * 1.0).translate(sx * 0.3, -0.18, dz), "#c23a26"))));
  // A wheeled bathtub at the feet (the root's frame), foam heaped at the rim.
  const tub = new THREE.CylinderGeometry(0.44, 0.36, 0.44, 22, 1, true).scale(1, 1, 1.55).translate(0, 0.42, 0);
  G.tub = merge(
    paint(tub, "#f2f1ec"),
    paint(new THREE.CylinderGeometry(0.36, 0.36, 0.02, 22).scale(1, 1, 1.55).translate(0, 0.2, 0), "#e0ded6"),
    paint(new THREE.TorusGeometry(0.44, 0.03, 6, 26).rotateX(Math.PI / 2).scale(1, 1, 1.55).translate(0, 0.64, 0), "#e0b040"),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => paint(new THREE.TorusGeometry(0.08, 0.03, 6, 10).rotateY(Math.PI / 2).translate(sx * 0.32, 0.09, sz * 0.42), "#2a2a2e")),
    ...Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2; return paint(new THREE.SphereGeometry(0.11 + 0.03 * (i % 3), 8, 6).translate(Math.cos(a) * 0.32, 0.66 + 0.03 * (i % 2), Math.sin(a) * 0.5), i % 2 ? "#ffffff" : "#e2f2ff"); }),
  );
  const ruff = new THREE.TorusGeometry(0.11, 0.05, 6, 24).rotateX(Math.PI / 2).translate(0, -0.03, 0);
  const rp = ruff.attributes.position;
  for (let i = 0; i < rp.count; i++) { const a = Math.atan2(rp.getZ(i), rp.getX(i)); const k = 1 + 0.18 * Math.sin(a * 12); rp.setX(i, rp.getX(i) * k); rp.setZ(i, rp.getZ(i) * k); }
  G.ruff = paint(ruff, "#f8f6f0");
  G.mustache = merge(...[-1, 1].map((sx) => paint(new THREE.TorusGeometry(0.035, 0.013, 4, 10, Math.PI * 1.2).rotateZ(sx > 0 ? -0.3 : Math.PI + 0.3).translate(sx * 0.04, 0.075, 0.112), "#1c1a18")));
  G.cape = paint(new THREE.CylinderGeometry(0.21, 0.4, 0.95, 14, 1, true, Math.PI * 0.62, Math.PI * 0.76).translate(0, 0.08, -0.02), "#4a1a5a");
  G.cape.computeVertexNormals();
  G.stripes = merge(...[0.04, 0.15, 0.26, 0.37, 0.48].map((y) => paint(new THREE.CylinderGeometry(0.186, 0.186, 0.045, 14, 1, true).scale(1, 1, 0.78).translate(0, y, 0), "#141414")));
  G.mimeFace = merge(
    ...[-1, 1].map((sx) => paint(new THREE.BoxGeometry(0.045, 0.01, 0.01).rotateZ(sx * 0.3).translate(sx * 0.045, 0.19, 0.108), W)),
    ...[-1, 1].map((sx) => paint(new THREE.SphereGeometry(0.016, 6, 4).translate(sx * 0.042, 0.15, 0.11), W)),
    paint(new THREE.BoxGeometry(0.05, 0.012, 0.01).translate(0, 0.07, 0.112), "#b01020"),
  );
  G.skull = merge(
    paint(new THREE.SphereGeometry(0.115, 14, 10).scale(1, 1.08, 1.05).translate(0, 0.14, 0), "#ece6d2"),
    ...[-1, 1].map((sx) => paint(new THREE.SphereGeometry(0.032, 8, 6).translate(sx * 0.045, 0.15, 0.09), "#141210")),
    paint(new THREE.ConeGeometry(0.018, 0.035, 3).rotateX(Math.PI).translate(0, 0.1, 0.105), "#141210"),
    paint(new THREE.BoxGeometry(0.11, 0.05, 0.08).translate(0, 0.04, 0.04), "#dcd4be"),
    paint(new THREE.CylinderGeometry(0.03, 0.035, 0.08, 6).translate(0, -0.01, 0), "#dcd4be"),
  );
  G.ribs = merge(
    ...[0.14, 0.24, 0.34, 0.44].map((y, i) => paint(new THREE.TorusGeometry(0.165 - i * 0.01, 0.014, 4, 12, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI).scale(1, 1, 0.78).translate(0, y, 0.0), "#ece6d2")),
    paint(new THREE.BoxGeometry(0.03, 0.4, 0.02).translate(0, 0.28, 0.12), "#ece6d2"),
  );
  G.monkeyFace = merge(
    ...[-1, 1].map((sx) => paint(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 10).rotateZ(Math.PI / 2).translate(sx * 0.12, 0.15, -0.01), "#d8b08a")),
    paint(new THREE.SphereGeometry(0.075, 10, 6).scale(1.2, 0.8, 0.7).translate(0, 0.09, 0.08), "#d8b08a"),
    paint(new THREE.SphereGeometry(0.06, 10, 6).scale(1.5, 0.9, 0.5).translate(0, 0.16, 0.085), "#d8b08a"),
    ...[-1, 1].map((sx) => paint(new THREE.SphereGeometry(0.02, 6, 4).translate(sx * 0.035, 0.165, 0.115), "#111111")),
  );
  const tailCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.02, -0.14), new THREE.Vector3(0, -0.15, -0.35), new THREE.Vector3(0, 0.1, -0.55),
    new THREE.Vector3(0, 0.35, -0.5), new THREE.Vector3(0, 0.38, -0.36)]);
  G.tail = paint(new THREE.TubeGeometry(tailCurve, 16, 0.028, 6, false), "#5e4026");
  G.peg = merge(
    paint(new THREE.CylinderGeometry(0.035, 0.022, 0.44, 8).translate(0, -0.24, 0), "#8a5a30"),
    paint(new THREE.CylinderGeometry(0.065, 0.06, 0.06, 8).translate(0, -0.03, 0), "#5a3418"),
  );
  // A gull on the wing: a body, a head, a beak; the wings separate (they flap).
  G.birdBody = merge(
    paint(new THREE.SphereGeometry(0.16, 12, 8).scale(0.75, 0.7, 1.35), "#f6f6f2"),
    paint(new THREE.SphereGeometry(0.1, 10, 8).translate(0, 0.09, 0.2), "#f6f6f2"),
    paint(new THREE.ConeGeometry(0.03, 0.13, 6).rotateX(Math.PI / 2).translate(0, 0.08, 0.34), "#f0a020"),
    ...[-1, 1].map((sx) => paint(new THREE.SphereGeometry(0.018, 6, 4).translate(sx * 0.055, 0.12, 0.26), "#111111")),
    paint(new THREE.ConeGeometry(0.1, 0.18, 4).rotateX(-Math.PI / 2).scale(1, 0.3, 1).translate(0, 0.01, -0.27), "#c8ccd0"),
  );
  G.birdWing = merge(
    paint(new THREE.BoxGeometry(0.42, 0.018, 0.17).translate(0.21, 0, 0), "#e8eaec"),
    paint(new THREE.BoxGeometry(0.14, 0.02, 0.15).translate(0.36, 0.002, -0.01), "#3a3c40"),
  );
  return G;
}

function radialTexture(inner, outer, rgb = "0,0,0") {
  const N = 64, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, `rgba(${rgb},${inner})`); grad.addColorStop(0.5, `rgba(${rgb},${inner * 0.55})`); grad.addColorStop(1, `rgba(${rgb},${outer})`);
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Cloth / skin (rough) and metal; both take the instance colour, both carry the foes' faint red rim. */
function makeMaterial(metal) {
  const m = new THREE.MeshStandardMaterial({
    name: metal ? "rr-foe-metal" : "rr-foe", vertexColors: true, roughness: metal ? 0.32 : 0.78, metalness: metal ? 0.75 : 0,
    envMapIntensity: metal ? 1 : 0.35, emissive: new THREE.Color("#1a1c24"), emissiveIntensity: metal ? 0.2 : 0.55,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: new THREE.Color("#ff4a36") };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        {
          vec3 vv = normalize(vViewPosition + vec3(1e-5));
          float ndv = clamp(dot(normalize(normal + vec3(0.0, 1e-5, 0.0)), vv), 0.0, 1.0);
          totalEmissiveRadiance += uRim * 0.42 * pow(1.0 - ndv, 3.0);
        }`);
  };
  m.customProgramCacheKey = () => (metal ? "rr-foe-metal" : "rr-foe");
  return m;
}

// ---- One figure's skeleton -----------------------------------------------------------------------

function makeSkeleton() {
  const n = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); o.rotation.order = "ZXY"; parent?.add(o); return o; };
  const root = n(null);
  const tilt = n(root);
  const pelvis = n(tilt, 0, 0.92, 0);
  const torso = n(pelvis, 0, 0.05, 0);
  const head = n(torso, 0, 0.56, 0);
  const uR = n(torso, -0.2, 0.45, 0), fR = n(uR, 0, -0.28, 0), hR = n(fR, 0, -0.24, 0);
  const uL = n(torso, 0.2, 0.45, 0), fL = n(uL, 0, -0.28, 0), hL = n(fL, 0, -0.24, 0);
  const tR = n(pelvis, -0.1, -0.02, 0), sR = n(tR, 0, -THIGH, 0);
  const tL = n(pelvis, 0.1, -0.02, 0), sL = n(tL, 0, -THIGH, 0);
  return { root, tilt, pelvis, torso, head, uR, fR, hR, uL, fL, hL, tR, sR, tL, sL };
}

/** Joint angles (radians), everything the pose sets. */
const JOINTS = ["lean", "twist", "bend", "headX", "headY", "rSx", "rSz", "rSy", "rE", "rW", "lSx", "lSz", "lE", "lW", "hRx", "hRz", "kR", "hLx", "hLz", "kL", "crouch"];
const GUARD = { lean: 0.14, twist: 0.28, bend: 0, headX: 0.05, headY: -0.2, rSx: -0.85, rSz: -0.18, rSy: 0, rE: -1.15, rW: 0.55,
  lSx: -0.45, lSz: 0.38, lE: -0.85, lW: 0, hRx: -0.32, hRz: -0.1, kR: 0.42, hLx: 0.26, hLz: 0.1, kL: 0.36, crouch: 0 };
const PISTOL_READY = { ...GUARD, rSx: -0.55, rSz: -0.25, rE: -0.75, rW: 0.15, twist: 0.2 };
/** The crab's guard: both claws up and out. */
const CRAB_GUARD = { ...GUARD, rSx: -1.2, rSz: -0.7, rE: -1.3, rW: 0.2, lSx: -1.2, lSz: 0.7, lE: -1.3, lW: 0.2, twist: 0, lean: 0.05, hRz: -0.35, hLz: 0.35, kR: 0.6, kL: 0.6 };
/** Empty hands (the mime, a monkey): loose fists up. */
const BARE = { ...GUARD, rSx: -0.9, rSz: -0.3, rE: -1.5, rW: 0.3, lSx: -0.8, lSz: 0.35, lE: -1.5, twist: 0.12 };
/** Riding Tiny's shoulders: legs astride, a hand on his head. */
const SEAT = { hRx: -1.45, hRz: -0.55, kR: 1.3, hLx: -1.45, hLz: 0.55, kL: 1.3, lean: 0.05, lSx: -1.9, lSz: 0.1, lE: -0.9 };
/** Key poses (partial over the guard). */
const K = {
  windup: { rSx: -2.65, rSz: -0.4, rE: -0.85, rW: 0.25, twist: -0.18, lean: -0.06, lSx: -1.0, lSz: 0.25, lE: -0.5, headX: -0.05, kR: 0.5, kL: 0.45 },
  chop: { rSx: -0.45, rSz: 0.2, rE: -0.12, rW: 1.15, twist: 0.6, lean: 0.38, lSx: 0.35, lSz: 0.55, lE: -0.3, hRx: -0.6, kR: 0.65, hLx: 0.4, kL: 0.3 },
  parry: { rSx: -1.95, rSz: 0.15, rE: -1.25, rW: -0.75, twist: 0.12, lean: -0.08, lSx: -0.9, lE: -1.2, headX: -0.1 },
  hit: { lean: -0.38, headX: -0.42, rSx: -0.25, rSz: -0.75, rE: -0.4, lSx: -0.3, lSz: 0.9, lE: -0.2, kR: 0.25, kL: 0.2, hRx: 0.1, hLx: -0.1 },
  aim: { rSx: -1.52, rSz: 0.02, rE: -0.04, rW: 0, twist: 0.55, lean: 0.04, headY: -0.5, headX: 0, lSx: 0.15, lSz: 0.35, lE: -1.4, hRx: -0.15, hLx: 0.15 },
  recoil: { rSx: -2.0, rE: -0.35, lean: -0.12, headX: -0.1 },
  surrender: { rSx: -2.95, rSz: -0.32, rE: -0.35, rW: 0, lSx: -2.95, lSz: 0.32, lE: -0.35, twist: 0, lean: -0.05, headX: 0.1, headY: 0, hRx: -0.1, kR: 0.15, hLx: 0.05, kL: 0.15 },
  kneel: { hRx: 0.05, kR: 1.62, hLx: -1.35, kL: 1.45, lean: 0.12, hRz: -0.05, hLz: 0.12 },
  cheer: { rSx: -2.85, rSz: -0.2, rE: -0.3, rW: 0.3, lSx: -0.6, lSz: 0.5, lE: -1.2, twist: 0.05, lean: -0.08, headX: -0.25, headY: 0 },
  telegraph: { rSx: -2.95, rSz: 0.12, rE: -0.6, rW: 0.25, lSx: -2.85, lSz: -0.45, lE: -0.75, twist: -0.12, lean: -0.22, headX: -0.15, headY: 0, hRx: -0.5, kR: 0.8, hLx: 0.35, kL: 0.65 },
  slam: { rSx: -0.25, rSz: 0.1, rE: -0.08, rW: 1.3, lSx: -0.35, lSz: -0.2, lE: -0.2, twist: 0.1, lean: 0.65, headX: 0.2, headY: 0, hRx: -0.85, kR: 1.1, hLx: 0.55, kL: 0.7 },
  taunt: { rSx: -1.45, rSz: 0.05, rE: -0.08, rW: 1.45, twist: 0.5, lean: -0.05, headX: -0.15, headY: -0.35, lSx: 0.2, lSz: 0.3, lE: -1.5 },
  stagger: { lean: -0.25, headX: -0.3, rSz: -0.6, lSz: 0.7, kR: 0.2, kL: 0.15, twist: -0.3 },
  // The gimmicks.
  tea: { lSx: -1.25, lSz: 0.55, lE: -2.25, lW: 0.2, rSx: -0.35, rSz: -0.25, rE: -0.5, twist: 0, lean: -0.12, headX: -0.28, headY: 0 },
  sing: { rSx: -2.1, rSz: -1.05, rE: -0.3, lSx: -2.1, lSz: 1.05, lE: -0.3, twist: 0, lean: -0.2, headX: -0.4, headY: 0, kR: 0.2, kL: 0.2 },
  throwBack: { lSx: -2.6, lSz: 0.5, lE: -1.4, twist: 0.45, lean: -0.15, headY: 0 },
  throwOut: { lSx: -1.3, lSz: 0.1, lE: -0.1, twist: -0.4, lean: 0.3, headY: 0 },
  mime: { rSx: -1.5, rSz: -0.15, rE: -0.25, rW: -1.1, lSx: -1.5, lSz: 0.15, lE: -0.25, lW: -1.1, twist: 0, lean: 0.12, headX: 0.05, headY: 0 },
  panic: { rSx: -2.9, rSz: -0.5, rE: -0.4, lSx: -2.9, lSz: 0.5, lE: -0.4, headX: -0.2, headY: 0, twist: 0 },
};
/** Acts as key-pose timelines: [k (0..1), pose name | null (= the base)]; dur in seconds; `lunge` m forward at the hit. */
const ACTS = {
  attack: { dur: 0.66, keys: [[0, null], [0.42, "windup"], [0.58, "chop"], [1, null]], hitAt: 0.55, lunge: 0.32 },
  heavy: { dur: 0.9, keys: [[0, null], [0.5, "windup"], [0.64, "chop"], [1, null]], hitAt: 0.62, lunge: 0.45 },
  parry: { dur: 0.46, keys: [[0, null], [0.3, "parry"], [0.65, "parry"], [1, null]], lunge: -0.08 },
  hit: { dur: 0.55, keys: [[0, null], [0.16, "hit"], [1, null]], lunge: -0.42 },
  stagger: { dur: 0.9, keys: [[0, null], [0.2, "stagger"], [0.6, "stagger"], [1, null]], lunge: -0.6 },
  fire: { dur: 0.6, keys: [[0, "aim"], [0.1, "recoil"], [0.45, "aim"], [1, "aim"]] },
  slam: { dur: 0.7, keys: [[0, "telegraph"], [0.28, "slam"], [0.75, "slam"], [1, null]], hitAt: 0.26, lunge: 0.55 },
  throw: { dur: 0.7, keys: [[0, null], [0.42, "throwBack"], [0.62, "throwOut"], [1, null]], hitAt: 0.58 },
};
/** Held poses (start an act with a hold: the pose stays for `hold` s). */
const HELD = new Set(["telegraph", "taunt", "aim", "tea", "sing", "mime"]);

// ---- The crew ------------------------------------------------------------------------------------

/**
 * @param {object} R the render context
 * @param {{layer?: number}} [opts]
 */
export function createSailors(R, { layer = R?.LAYERS?.AVATAR ?? 2 } = {}) {
  const group = new THREE.Group();
  group.name = "boardfight-sailors";
  const G = buildGeometries();
  const cloth = makeMaterial(false), metal = makeMaterial(true);
  const parts = {};
  /** Per-slot instance counts (arms, legs, claws and wings take two). */
  const PER2 = new Set(["upper", "fore", "thigh", "shin", "claw", "birdWing"]);
  /** Parts drawn only while somebody on deck wears them (hidden otherwise: no draw). */
  const OPTIONAL = new Set(["tricorn", "bandana", "coat", "pistol", "musket", "pan", "ladle", "pin", "club", "brush", "banana", "gullHead", "gullPeek", "gullPeek2", "wig",
    "bicorne", "epaulettes", "teacup", "toque", "cookCap", "apron", "shako", "beret", "fez", "crabShell", "claw", "crabLegs", "tub", "ruff", "mustache", "cape", "stripes",
    "mimeFace", "skull", "ribs", "monkeyFace", "tail", "peg", "birdBody", "birdWing"]);
  const mk = (name, geo, mat, cast = true) => {
    const per = PER2.has(name) ? 2 : 1;
    const m = new THREE.InstancedMesh(geo, mat, CAP * per);
    m.name = `sailors.${name}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = cast;
    m.layers.set(layer);
    m.count = 0;
    const white = new THREE.Color("#ffffff");
    for (let i = 0; i < CAP * per; i++) m.setColorAt(i, white);
    group.add(m);
    parts[name] = m;
    return m;
  };
  for (const name of ["pelvis", "torso", "sash", "head", "tricorn", "bandana", "coat", "upper", "fore", "thigh", "shin"]) mk(name, G[name], cloth);
  mk("cutlass", G.cutlass, metal); mk("pistol", G.pistol, metal); mk("musket", G.musket, metal); mk("pan", G.pan, metal); mk("ladle", G.ladle, metal);
  for (const name of ["pin", "club", "brush", "banana", "gullHead", "gullPeek", "gullPeek2", "wig", "bicorne", "epaulettes", "teacup", "toque", "cookCap", "apron", "shako",
    "beret", "fez", "crabShell", "claw", "crabLegs", "tub", "ruff", "mustache", "cape", "stripes", "mimeFace", "skull", "ribs", "monkeyFace", "tail", "peg", "birdBody", "birdWing"]) mk(name, G[name], cloth);
  cloth.side = THREE.DoubleSide;           // the coat's skirts and the cape are open
  /** Weapons by name → part (none: empty hands, claws: the crab's own). */
  const WEAPONS = { cutlass: "cutlass", sabre: "cutlass", pistol: "pistol", musket: "musket", pan: "pan", pin: "pin", club: "club", brush: "brush", banana: "banana" };
  const WEAPON_PARTS = [...new Set(Object.values(WEAPONS))];
  // Contact shadows: soft dark blobs under every figure (and longer under the fallen).
  const shadowTex = radialTexture(0.7, 0);
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, CAP);
  shadows.name = "sailors.shadows"; shadows.frustumCulled = false; shadows.count = 0; shadows.renderOrder = 1;
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.layers.set(layer);
  group.add(shadows);
  // The captain's telegraph: the blade glows red-hot.
  const glowTex = radialTexture(1, 0, "255,90,50");
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color("#ff6a3a").multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.name = "sailors.blade-glow"; glow.visible = false; glow.scale.setScalar(0.9); glow.layers.set(R?.LAYERS?.FX ?? 4); glow.renderOrder = 8;
  group.add(glow);

  const figs = Array.from({ length: CAP }, (_, slot) => ({ slot, used: false, sk: makeSkeleton(), cur: { ...GUARD }, tgt: { ...GUARD } }));
  const byId = new Map();
  let live = [];
  let warm = false;
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _s = new THREE.Vector3();
  const _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _m3 = new THREE.Matrix4();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const _c = new THREE.Color(), _flash = new THREE.Color("#ffffff");

  /**
   * Put a crew on deck: [{id, kind: "sailor"|"captain"|…, look?, weapon: "cutlass"|"pistol"|…, x, z, yaw, seed, navy?, coat?, hidden?}].
   * Slots beyond the pool are dropped.
   */
  function spawn(list = []) {
    clear();
    for (const d of list) add(d);
  }

  /** One more figure on deck (a gull out of the coat, Tiny when the captain comes up). Returns false when the pool is full. */
  function add(d) {
    if (byId.has(String(d.id))) return true;
    const f = figs.find((x) => !x.used);
    if (!f) return false;
    const r = rng((d.seed ?? f.slot * 7 + 3) + 11);
    const captain = d.kind === "captain";
    const navy = !!d.navy;
    const pick = (a) => a[Math.floor(r() * a.length) % a.length];
    const L = LOOKS[d.look] || (captain ? null : LOOKS.sailor) || {};
    const lookId = LOOKS[d.look] ? d.look : captain ? "captain" : "sailor";
    // A gun hand: the look's gun (a marine's musket), else a pistol.
    const weapon = d.gunner ? (L.gun && WEAPONS[L.gun] ? L.gun : "pistol") : d.weapon && WEAPONS[d.weapon] ? d.weapon
      : d.weapon === "none" || L.weapon === "none" ? "none" : captain ? (L.weapon || "sabre") : (L.weapon || "cutlass");
    const gunHand = weapon === "pistol" || weapon === "musket";
    const sc = L.scale ? L.scale[0] + r() * (L.scale[1] - L.scale[0]) : captain ? 1.22 : 0.94 + r() * 0.12;
    Object.assign(f, {
      used: true, id: String(d.id), kind: captain ? "captain" : d.kind === "gull" ? "gull" : "sailor", look: lookId, weapon,
      x: +d.x || 0, z: +d.z || 0, yaw: +d.yaw || 0, yawGoal: +d.yaw || 0, y: 0, scale: sc,
      goal: null, speed: 0, maxSpeed: 1.8, vel: 0, phase: r() * 6.28, seed: r() * 100, t: r() * 10,
      act: null, down: false, fall: null, dropped: null, flash: 0, gone: false, shown: d.hidden ? 0 : 1, cheer: false, surrender: false, kneel: r() < 0.45,
      lungeOff: 0, base: L.crab ? CRAB_GUARD : gunHand ? PISTOL_READY : weapon === "none" || weapon === "banana" ? BARE : GUARD, aimAt: null, glow: 0, idleNoise: r(),
      bird: !!L.bird, tub: !!L.tub, crab: !!L.crab, ride: null, collapsed: 0, panic: false, flyH: 1.7 + r() * 0.6, flap: r() * 6.28,
      acc: new Set(L.acc || []), hide: new Set(L.hide || []), hideR: new Set(L.hideR || []), tint: L.tint || {}, hatScale: L.hatScale || 1,
      coatOn: captain && L.coat !== null && !L.bird, extraHead: L.extraHead || null,
      colors: {
        shirt: captain ? (L.coat || CAPTAIN.coat[d.coat] || CAPTAIN.coat.pirate) : L.shirt ? pick(L.shirt) : pick(navy ? PAL.navyShirt : PAL.shirt),
        pants: L.pants ? pick(L.pants) : captain ? CAPTAIN.pants : pick(navy ? PAL.navyPants : PAL.pants),
        skin: L.skin ? pick(L.skin) : pick(PAL.skin),
        head: L.head || (captain ? CAPTAIN.hat : pick(PAL.band)),
        sash: L.sash || (captain ? CAPTAIN.sash : PAL.sash),
      },
      hat: L.hat === "bandanaSome" ? (r() < 0.5 ? "bandana" : "none") : L.hat || (captain ? "tricorn" : (r() < (navy ? 0.55 : 0.3) ? "tricorn" : "bandana")),
    });
    if (L.shirt && captain && !L.coat) f.colors.shirt = pick(L.shirt);
    if (f.hat === "tricorn" && !captain && !L.head) f.colors.head = pick(PAL.hat);
    if (L.bones) { f.colors.upper = f.colors.shirt; }
    if (f.hat !== "tricorn" && f.hat !== "bandana" && f.hat !== "none") f.acc.add(f.hat);
    if (f.extraHead) f.acc.add(f.extraHead);
    if (L.crab) f.acc.add("claw");
    for (const k of JOINTS) { f.cur[k] = f.base[k]; f.tgt[k] = f.base[k]; }
    paintFig(f, 0);
    byId.set(f.id, f);
    live = figs.filter((x) => x.used);
    return true;
  }

  function paintFig(f, flash) {
    const s = f.slot, C = f.colors;
    const set = (mesh, i, hex) => { _c.set(hex); if (flash > 0) _c.lerp(_flash, flash); mesh.setColorAt(i, _c); };
    set(parts.pelvis, s, C.pants); set(parts.torso, s, C.shirt); set(parts.sash, s, C.sash); set(parts.head, s, C.skin);
    set(parts.tricorn, s, C.head); set(parts.bandana, s, C.head); set(parts.coat, s, C.shirt);
    for (const k of [0, 1]) { set(parts.upper, s * 2 + k, C.upper || C.shirt); set(parts.fore, s * 2 + k, C.skin); set(parts.thigh, s * 2 + k, C.pants); set(parts.shin, s * 2 + k, f.look === "skeleton" ? C.skin : C.pants); }
    for (const w of WEAPON_PARTS) set(parts[w], s, "#ffffff");
    // Accessories keep their painted colours (white instance), unless the look tints them; hats take the head colour.
    for (const a of f.acc) {
      const tint = f.tint[a] || (a === "beret" || a === "fez" ? C.head : "#ffffff");
      if (parts[a]) { if (PER2.has(a)) { set(parts[a], s * 2, tint); set(parts[a], s * 2 + 1, tint); } else set(parts[a], s, tint); }
    }
    for (const m of Object.values(parts)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  function clear() {
    for (const f of figs) { f.used = false; f.id = null; f.ride = null; }
    byId.clear();
    live = [];
    glow.visible = false;
  }

  // ---- Acts ----------------------------------------------------------------------------------------

  /**
   * Start an act on figure `id`: "attack" | "heavy" | "parry" | "hit" | "stagger" | "fire" | "slam" | "telegraph" | "taunt" | "aim" |
   * "down" | "surrender" | "cheer" | "idle" | "getup" | "tea" | "sing" | "throw" | "mime" | "collapse" | "panic".
   * opts: {dir: [dx, dz] (a blow's direction, for hit/down), at: {x, z} (face it), hold (seconds, the held poses)}.
   * Returns the act's hit time (s) when it has one.
   */
  function act(id, name, opts = {}) {
    const f = byId.get(String(id));
    if (!f || f.gone) return null;
    if (opts.at) faceTo(f, opts.at.x, opts.at.z, true);
    if (f.down && name !== "getup") return null;
    if (name === "down") {
      const d = opts.dir || [-Math.sin(f.yaw), -Math.cos(f.yaw)];
      const len = Math.hypot(d[0], d[1]) || 1;
      // Fall along the blow: in the figure's frame, back (−Z) or sideways.
      const lx = (d[0] * Math.cos(f.yaw) - d[1] * Math.sin(f.yaw)) / len, lz = (d[0] * Math.sin(f.yaw) + d[1] * Math.cos(f.yaw)) / len;
      f.down = true; f.goal = null; f.ride = null;
      f.fall = { th: 0.05, w: 1.6 + Math.random() * 0.8 + (opts.hard ? 1.6 : 0), ax: Math.atan2(lx, lz), t: 0, slide: opts.hard ? 1.1 : 0.35, rest: false,
        limbs: { rSx: -0.4 - Math.random() * 2, rSz: -0.6 - Math.random() * 0.9, lSx: -0.3 - Math.random() * 2, lSz: 0.6 + Math.random() * 0.9, rE: -Math.random(), lE: -Math.random(), kR: 0.2 + Math.random() * 0.9, kL: 0.2 + Math.random() * 0.9, headY: (Math.random() - 0.5) * 1.4 } };
      f.flash = 1;
      if (!f.bird && !f.crab && !f.tub) dropWeapon(f);
      f.act = null;
      return null;
    }
    if (name === "collapse") {
      // The gull coat: the birds burst out and the coat heaps on the deck where he stood.
      f.down = true; f.goal = null; f.collapsed = 0.001; f.act = null; f.flash = 1;
      dropWeapon(f);
      return null;
    }
    if (name === "getup") { if (f.down) { f.down = false; f.collapsed = 0; f.dropped = null; f.fall = f.fall ? { ...f.fall, rising: 0 } : null; } return null; }
    if (name === "surrender") { f.surrender = true; f.act = null; f.goal = null; if (!f.crab && !f.bird) dropWeapon(f); return null; }
    if (name === "cheer") { f.cheer = true; f.act = null; return null; }
    if (name === "idle") { f.act = null; f.cheer = false; f.aimAt = null; f.panic = false; return null; }
    if (name === "panic") { f.panic = !!(opts.on ?? true); return null; }
    if (HELD.has(name)) {
      f.act = { name, t: 0, dur: opts.hold ?? (name === "telegraph" ? 1.2 : name === "taunt" ? 1.6 : 1.2), hold: true };
      if (name === "telegraph") f.glow = 1;
      return null;
    }
    const A = ACTS[name];
    if (!A) return null;
    if (name === "hit" || name === "stagger") f.flash = 1;
    const dur = A.dur * (f.kind === "captain" ? 1.15 : 1) * (opts.speed ? 1 / opts.speed : 1);
    f.act = { name, t: 0, dur, A, dir: opts.dir || null };
    if (name === "slam") f.glow = 1;
    return A.hitAt != null ? A.hitAt * dur : null;
  }

  function dropWeapon(f) {
    if (f.dropped || f.weapon === "none") return;
    // The weapon clatters down beside them: lying flat on the deck at a random angle.
    const sk = f.sk;
    sk.root.updateMatrixWorld(true);
    const hand = sk.hR.getWorldPosition(_v);
    f.dropped = { x: hand.x + (Math.random() - 0.5) * 0.5, z: hand.z + (Math.random() - 0.5) * 0.5, yaw: Math.random() * Math.PI * 2, t: 0, y0: hand.y };
  }

  function faceTo(f, x, z, snap = false) {
    const y = Math.atan2(x - f.x, z - f.z);
    f.yawGoal = y;
    if (snap) f.yaw = y;
  }

  // ---- The pose ------------------------------------------------------------------------------------

  function keyPose(f, A, k, out) {
    const keys = A.keys;
    let i = 0;
    while (i < keys.length - 2 && k > keys[i + 1][0]) i++;
    const [k0, a] = keys[i], [k1, b] = keys[i + 1];
    const u = smooth(0, 1, (k - k0) / Math.max(1e-3, k1 - k0));
    const pa = a ? K[a] : null, pb = b ? K[b] : null;
    for (const j of JOINTS) {
      const va = pa && pa[j] != null ? pa[j] : f.base[j];
      const vb = pb && pb[j] != null ? pb[j] : f.base[j];
      out[j] = va + (vb - va) * u;
    }
  }

  function poseTarget(f, dt) {
    const T = f.tgt;
    for (const j of JOINTS) T[j] = f.base[j];
    const t = f.t;
    let rate = 14;
    // Locomotion: legs swing on the stride, the off arm counter-swings, a lean into the run.
    const v = f.vel, run = smooth(0.6, 3.2, v);
    if (v > 0.15 && !f.ride) {
      const s = Math.sin(f.phase), c = Math.cos(f.phase);
      const amp = 0.38 + 0.4 * run;
      T.hRx = -amp * s - 0.05; T.hLx = amp * s - 0.05;
      T.kR = 0.15 + (0.55 + 0.6 * run) * Math.max(0, -c); T.kL = 0.15 + (0.55 + 0.6 * run) * Math.max(0, c);
      T.hRz = -0.04; T.hLz = 0.04;
      T.lSx = 0.5 * amp * s * 1.4 - 0.25; T.lE = -0.6 - 0.5 * run;
      T.lean = 0.1 + 0.28 * run; T.twist = 0.1 + 0.12 * s;
      rate = 20;
    } else {
      // Idle life: weight shifts and a sway; a small guard bob.
      const n = f.idleNoise;
      T.lean += 0.03 * Math.sin(t * 1.3 + n * 5); T.twist += 0.06 * Math.sin(t * 0.7 + n * 9);
      T.rSx += 0.06 * Math.sin(t * 2.2 + n); T.rE += 0.05 * Math.sin(t * 2.2 + n + 0.6);
      T.headY += 0.25 * Math.sin(t * 0.45 + n * 3); T.kR += 0.06 * Math.sin(t * 1.9); T.kL += 0.06 * Math.sin(t * 1.9 + 1);
      // The crab clacks his claws.
      if (f.crab) { const cl = 0.18 * Math.max(0, Math.sin(t * 5 + n)); T.rW += cl; T.lW += cl; }
    }
    if (f.ride) Object.assign(T, SEAT);
    if (f.panic) { Object.assign(T, K.panic); T.rSz += 0.35 * Math.sin(t * 14); T.lSz += 0.35 * Math.sin(t * 14 + 1.5); rate = 18; }
    if (f.cheer) {
      Object.assign(T, K.cheer);
      T.rSx += 0.3 * Math.sin(t * 9); T.rE += 0.2 * Math.sin(t * 9 + 0.5);
    }
    if (f.surrender) {
      Object.assign(T, K.surrender);
      if (f.kneel && !f.tub && !f.ride) Object.assign(T, K.kneel);
      T.rSx += 0.05 * Math.sin(t * 7); T.lSx += 0.05 * Math.sin(t * 7 + 1);
      rate = 6;
    }
    const a = f.act;
    if (a) {
      if (a.hold) {
        const P = K[a.name === "aim" ? "aim" : a.name];
        Object.assign(T, P);
        if (a.name === "telegraph") { const tr = 0.04 * Math.sin(t * 40); T.rSx += tr; T.lSx += tr; rate = 6; }
        if (a.name === "sing") { const sw = Math.sin(t * 2.4); T.twist += 0.25 * sw; T.rSz -= 0.15 * Math.sin(t * 4.8); T.lSz += 0.15 * Math.sin(t * 4.8); T.headY = 0.2 * sw; rate = 8; }
        if (a.name === "mime") { const pr = 0.06 * Math.sin(t * 9); T.rSx += pr; T.lSx -= pr; T.rW += pr * 2; T.lW -= pr * 2; }
        if (a.name === "tea") { T.lE += 0.05 * Math.sin(t * 3); }
      } else keyPose(f, a.A, a.t / a.dur, T);
      if (!a.hold || a.name !== "telegraph") rate = rate === 8 ? 8 : 18;
    } else if (f.aimAt && (f.weapon === "pistol" || f.weapon === "musket")) Object.assign(T, K.aim);
    return rate;
  }

  /** Leg extent below the hip for a pose (pelvis frame): the higher leg touches the deck. */
  const legDrop = (h, k, z) => (THIGH * Math.cos(h) + SHIN * Math.cos(h + k)) * Math.cos(z);

  function stepFig(f, dt, deckY) {
    f.t += dt;
    f.flash = Math.max(0, f.flash - dt * 6);
    f.glow = f.act && (f.act.name === "telegraph" || f.act.name === "slam") ? Math.min(1, f.glow + dt * 3) : Math.max(0, f.glow - dt * 3);
    // Riding a carrier's shoulders (Pip on Tiny): carried, not walking.
    const carrier = f.ride ? byId.get(f.ride) : null;
    if (f.ride && (!carrier || carrier.down || carrier.gone)) f.ride = null;
    // Moving.
    if (f.goal && !f.down && !f.surrender && !f.ride) {
      const dx = f.goal.x - f.x, dz = f.goal.z - f.z, d = Math.hypot(dx, dz);
      const want = d > (f.goal.r ?? 0.12) ? Math.min(f.goal.speed ?? f.maxSpeed, d * 3) : 0;
      f.vel = damp(f.vel, want, 6, dt);
      if (d > 1e-3 && f.vel > 0.01) {
        const s = Math.min(d, f.vel * dt);
        f.x += (dx / d) * s; f.z += (dz / d) * s;
        if (!f.goal.keepFacing && d > 0.25) f.yawGoal = Math.atan2(dx, dz);
      }
      if (d <= (f.goal.r ?? 0.12) && f.vel < 0.05) f.goal = null;
      f.phase += (f.vel * dt) / 0.42 * Math.PI * 0.5;
    } else f.vel = damp(f.vel, 0, 8, dt);
    // The act's clock.
    const a = f.act;
    if (a) {
      a.t += dt;
      if (a.A?.lunge && !f.ride && !f.tub) {
        const k = a.t / a.dur;
        const at = a.A.hitAt ?? 0.2;
        const push = a.A.lunge * smooth(0, at, k) * (1 - smooth(at + 0.15, 1, k));
        const dy = push - f.lungeOff;
        f.lungeOff = push;
        // the lunge is along the facing (a step in, or back from a hit)
        f.x += Math.sin(f.yaw) * dy; f.z += Math.cos(f.yaw) * dy;
      }
      if (a.t >= a.dur && !a.hold) { f.act = null; f.lungeOff = 0; }
      else if (a.hold && a.t >= a.dur) { f.act = null; }
    }
    if (!f.down && !f.fall) f.yaw += wrap(f.yawGoal - f.yaw) * (1 - Math.exp(-10 * dt));
    f.y = deckY ? deckY(f.x, f.z) : 0;

    const sk = f.sk, C = f.cur;
    const rate = poseTarget(f, dt);
    for (const j of JOINTS) C[j] = damp(C[j], f.tgt[j], rate, dt);
    // The fall: a topple under gravity about the feet, a bounce, the limbs sprawled.
    let fallTh = 0, lift = 0, fallAx = 0;
    const F = f.fall;
    if (F && !f.bird && !f.collapsed) {
      F.t += dt;
      if (F.rising != null) {
        F.rising += dt;
        const k = smooth(0, 1.1, F.rising);
        fallTh = F.th * (1 - k);
        lift = 0.14 * Math.sin(Math.min(Math.PI / 2, F.th)) * (1 - k);
        fallAx = F.ax;
        if (k >= 1) f.fall = null;
      } else {
        if (!F.rest) {
          F.w += 9.5 * Math.sin(F.th + 0.12) * dt * 1.6;
          F.th += F.w * dt;
          if (F.th >= Math.PI / 2) { F.th = Math.PI / 2; F.w = -F.w * 0.22; if (Math.abs(F.w) < 0.4) { F.rest = true; F.w = 0; } }
          // Sliding with the blow while falling.
          const sl = F.slide * dt * (1 - smooth(0.6, 1.4, F.t));
          f.x += Math.sin(f.yaw + F.ax) * sl; f.z += Math.cos(f.yaw + F.ax) * sl;
        }
        fallTh = F.th; fallAx = F.ax;
        lift = 0.14 * Math.sin(Math.min(Math.PI / 2, F.th));
        const sprawl = smooth(0.2, 1.0, F.th / (Math.PI / 2));
        for (const [j, v] of Object.entries(F.limbs)) C[j] = C[j] + (v - C[j]) * sprawl;
        C.lean = C.lean * (1 - sprawl); C.twist *= 1 - sprawl; C.crouch = 0;
        C.hRx = C.hRx * (1 - sprawl) - 0.15 * sprawl; C.hLx = C.hLx * (1 - sprawl) + 0.1 * sprawl;
      }
    } else if (F && f.bird) F.t += dt;
    if (f.collapsed) f.collapsed = Math.min(1, f.collapsed + dt * 3);
    // Apply the joints.
    let hipY = Math.max(legDrop(C.hRx, C.kR, C.hRz), legDrop(C.hLx, C.kL, C.hLz)) + ANKLE;
    if (f.tub) hipY = 0.52;                                   // sat in his bath
    if (f.collapsed) hipY = hipY * (1 - f.collapsed) + 0.1 * f.collapsed;
    if (carrier) {
      // On the carrier's shoulders: astride the back of his neck, facing where he faces.
      carrier.sk.head.getWorldPosition(_v);
      const cs = carrier.scale;
      f.yaw = f.yawGoal = carrier.yaw;
      f.x = _v.x - Math.sin(f.yaw) * 0.12 * cs; f.z = _v.z - Math.cos(f.yaw) * 0.12 * cs;
      sk.root.position.set(f.x, _v.y + 0.08 * cs - hipY * f.scale, f.z);
    } else sk.root.position.set(f.x, f.y, f.z);
    sk.root.rotation.set(0, f.yaw, 0);
    sk.root.scale.setScalar(f.scale);
    // Topple about the feet: a fall back is a rotation about the figure's X axis, aimed along `ax`.
    sk.tilt.rotation.set(0, 0, 0);
    if (fallTh > 0) {
      const ax = fallAx;
      // the topple axis is perpendicular to the fall direction (ax: 0 = forward, π = back)
      _q.setFromAxisAngle(_v.set(Math.cos(ax), 0, -Math.sin(ax)), fallTh);
      sk.tilt.quaternion.copy(_q);
      sk.tilt.position.set(0, lift / f.scale, 0);
    } else sk.tilt.position.set(0, 0, 0);
    sk.pelvis.position.y = hipY;
    sk.pelvis.rotation.set(0, C.twist * 0.35, 0);
    sk.torso.rotation.set(C.lean, C.twist * 0.65, C.bend);
    sk.head.rotation.set(C.headX - C.lean * 0.5, C.headY - C.twist * 0.6, 0);
    sk.uR.rotation.set(C.rSx, C.rSy, C.rSz);
    sk.fR.rotation.set(C.rE, 0, 0);
    sk.hR.rotation.set(C.rW, 0, 0);
    sk.uL.rotation.set(C.lSx, 0, C.lSz);
    sk.fL.rotation.set(C.lE, 0, 0);
    sk.hL.rotation.set(C.lW, 0, 0);
    sk.tR.rotation.set(C.hRx, 0, C.hRz);
    sk.sR.rotation.set(C.kR, 0, 0);
    sk.tL.rotation.set(C.hLx, 0, C.hLz);
    sk.sL.rotation.set(C.kL, 0, 0);
    sk.root.updateMatrixWorld(true);
    // The dropped weapon slides to a stop.
    if (f.dropped) {
      const d = f.dropped;
      d.t += dt;
      d.y = (deckY ? deckY(d.x, d.z) : 0) + 0.03 + Math.max(0, (d.y0 - f.y) * (1 - smooth(0, 0.35, d.t)));
    }
    // A gull on the wing: bobbing over the deck, wings beating; down, it drops to the planks.
    if (f.bird) {
      f.flap += dt * (f.down ? 0 : 15 + 3 * Math.sin(f.t * 0.7));
      const bob = 0.12 * Math.sin(f.t * 3.1 + f.seed);
      const fall = f.down ? smooth(0, 0.45, f.fall?.t ?? 1) : 0;
      f.birdY = (f.flyH + bob) * (1 - fall) + 0.1 * fall;
    }
  }

  const putM = (mesh, i, m) => mesh.setMatrixAt(i, m);
  function write(f) {
    const s = f.slot, sk = f.sk;
    const vis = f.shown > 0.01 && !f.gone;
    const used = new Set();
    const put = (name, node, i = s) => { parts[name].setMatrixAt(i, vis ? node.matrixWorld : ZERO); if (vis) used.add(name); };
    const off = (name, i = s) => parts[name].setMatrixAt(i, ZERO);
    const human = !f.bird;
    const col = f.collapsed > 0;
    for (const n of ["pelvis", "torso", "sash", "head"]) {
      if (human && !f.hide.has(n) && !col) put(n, sk[n === "sash" ? "torso" : n]); else off(n);
    }
    // Headwear.
    for (const h of ["tricorn", "bandana"]) {
      if (!(human && vis && f.hat === h)) { off(h); continue; }
      if (col) {
        // The tricorn sits on top of the heaped coat.
        _m.compose(_w.set(sk.pelvis.matrixWorld.elements[12], sk.pelvis.matrixWorld.elements[13] - 0.1, sk.pelvis.matrixWorld.elements[14]), _q.setFromEuler(_e.set(0.25, f.yaw, 0.1)), _s.setScalar(f.scale));
        putM(parts[h], s, _m); used.add(h);
      } else if (f.hatScale !== 1) { putM(parts[h], s, _m.copy(sk.head.matrixWorld).multiply(_m2.makeScale(f.hatScale, f.hatScale, f.hatScale).setPosition(0, -0.05, 0))); used.add(h); }
      else put(h, sk.head);
    }
    // The coat: a captain's skirts (heaped flat once Three-Gulls has scattered).
    if (human && vis && f.coatOn) {
      if (col) { putM(parts.coat, s, _m.copy(sk.pelvis.matrixWorld).multiply(_m2.makeScale(1.4, 0.25 + 0.75 * (1 - f.collapsed), 1.4))); used.add("coat"); }
      else put("coat", sk.pelvis);
    } else off("coat");
    const limbs = human && !col;
    const two = (name, a, b) => {
      for (const [k, node] of [[0, a], [1, b]]) {
        const hidden = !limbs || f.hide.has(name) || (k === 0 && f.hideR.has(name)) || (f.tub && (name === "thigh" || name === "shin"));
        if (hidden) off(name, s * 2 + k); else put(name, node, s * 2 + k);
      }
    };
    two("upper", sk.uR, sk.uL); two("fore", sk.fR, sk.fL); two("thigh", sk.tR, sk.tL); two("shin", sk.sR, sk.sL);
    // Accessories on their nodes.
    const ACC_NODE = { gullHead: "head", wig: "head", bicorne: "head", toque: "head", cookCap: "head", shako: "head", beret: "head", fez: "head", ruff: "head",
      mustache: "head", mimeFace: "head", skull: "head", monkeyFace: "head", gullPeek: "torso", epaulettes: "torso", apron: "torso", crabShell: "torso", cape: "torso",
      stripes: "torso", ribs: "torso", gullPeek2: "pelvis", crabLegs: "pelvis", tail: "pelvis", teacup: "hL", ladle: "hL", peg: "sR", tub: "root" };
    for (const [a, node] of Object.entries(ACC_NODE)) {
      if (!(vis && human && !col && f.acc.has(a))) { off(a); continue; }
      put(a, sk[node]);
    }
    if (vis && limbs && f.acc.has("claw")) { put("claw", sk.hR, s * 2); putM(parts.claw, s * 2 + 1, _m.copy(sk.hL.matrixWorld).multiply(_m2.makeScale(-1, 1, 1))); used.add("claw"); }
    else { off("claw", s * 2); off("claw", s * 2 + 1); }
    // The gull on the wing.
    if (vis && f.bird) {
      const fallK = f.down ? smooth(0, 0.45, f.fall?.t ?? 1) : 0;
      _q.setFromEuler(_e.set(f.down ? 0 : 0.12 * Math.sin(f.t * 2), f.yaw, f.down ? 1.3 * fallK : 0.15 * Math.sin(f.t * 1.7)));
      _m.compose(_w.set(f.x, f.y + (f.birdY ?? f.flyH), f.z), _q, _s.setScalar(f.scale));
      putM(parts.birdBody, s, _m); used.add("birdBody");
      const flap = f.down ? 0.1 : 0.75 * Math.sin(f.flap);
      for (const [k, sx] of [[0, 1], [1, -1]]) {
        _m2.compose(_v.set(sx * 0.07, 0.05, 0.02), _q2.setFromAxisAngle(_s.set(0, 0, 1), sx * flap), _w.set(sx, 1, 1));
        putM(parts.birdWing, s * 2 + k, _m3.multiplyMatrices(_m, _m2));
      }
      used.add("birdWing");
    } else { off("birdBody"); off("birdWing", s * 2); off("birdWing", s * 2 + 1); }
    // The weapon.
    const wpart = WEAPONS[f.weapon] || null;
    for (const w of WEAPON_PARTS) if (w !== wpart) off(w);
    if (wpart) {
      if (!vis || !human) off(wpart);
      else if (f.dropped) {
        const d = f.dropped;
        // Flat on the deck (the blade's thin side down), at the angle it fell.
        _q.setFromAxisAngle(_v.set(0, 1, 0), d.yaw).multiply(FLAT);
        _m.compose(_w.set(d.x, d.y, d.z), _q, _s.setScalar(f.scale * (f.kind === "captain" ? 1.25 : 1)));
        putM(parts[wpart], s, _m); used.add(wpart);
      } else if (col) off(wpart);
      else {
        // The captain's sabre is longer.
        if (f.weapon === "sabre") putM(parts[wpart], s, _m.copy(sk.hR.matrixWorld).multiply(_m2.makeScale(1.12, 1.12, 1.3)));
        else putM(parts[wpart], s, sk.hR.matrixWorld);
        used.add(wpart);
      }
    }
    // The contact shadow: under the hips, stretched along a fallen body (small and soft under a gull in the air).
    if (vis) {
      if (f.bird) {
        const k = clamp(1 - ((f.birdY ?? 1.5) - 0.1) / 3, 0.25, 1);
        _m.compose(_w.set(f.x, f.y + 0.03, f.z), _q.identity(), _s.set(0.5 * k, 1, 0.6 * k));
        shadows.setMatrixAt(s, _m);
      } else {
        const lying = f.fall && !col ? Math.sin(Math.min(Math.PI / 2, f.fall.th ?? 0)) * (f.fall.rising != null ? 1 - smooth(0, 1.1, f.fall.rising) : 1) : col ? 1 : 0;
        const hp = sk.pelvis.getWorldPosition(_v);
        const head = sk.head.getWorldPosition(_w);
        const cx = lying > 0.1 && !col ? (hp.x + head.x) / 2 : hp.x, cz = lying > 0.1 && !col ? (hp.z + head.z) / 2 : hp.z;
        const ang = Math.atan2(head.x - hp.x, head.z - hp.z);
        _q.setFromAxisAngle(_v.set(0, 1, 0), lying > 0.1 && !col ? ang : f.yaw);
        const wide = (f.crab ? 1.6 : f.tub ? 1.5 : 0.9) * f.scale;
        _m.compose(_w.set(cx, f.y + 0.03, cz), _q, _s.set(wide, 1, (0.9 + 1.2 * lying) * f.scale * (f.tub ? 1.6 : 1)));
        shadows.setMatrixAt(s, f.ride ? ZERO : _m);
      }
    } else shadows.setMatrixAt(s, ZERO);
    return used;
  }

  /** Per frame. `deckY(x, z)` → the deck's height there (the group's frame). */
  function update(dt, { deckY = null } = {}) {
    const d = Math.max(0, Math.min(0.1, dt || 0));
    let n = 0, gl = null;
    // Carriers before riders (a rider sits on a head posed this frame).
    for (const pass of [0, 1]) {
      for (const f of figs) {
        if (!f.used || (pass === 0) === !!f.ride) continue;
        stepFig(f, d, deckY);
        if (f.flash > 0 || f.flashWas > 0) { paintFig(f, f.flash); f.flashWas = f.flash; }
        n = Math.max(n, f.slot + 1);
        if (f.glow > 0.01 && !f.down) gl = f;
      }
    }
    const used = new Set();
    for (const f of figs) {
      if (f.slot >= n) continue;
      if (!f.used) { hideSlot(f.slot); continue; }
      for (const u of write(f)) used.add(u);
    }
    for (const [k, m] of Object.entries(parts)) {
      m.count = n * (PER2.has(k) ? 2 : 1);
      m.visible = warm || !OPTIONAL.has(k) || used.has(k);
      m.instanceMatrix.needsUpdate = true;
    }
    shadows.count = n; shadows.instanceMatrix.needsUpdate = true;
    if (warm) { for (const m of [...Object.values(parts), shadows]) { m.count = Math.max(1, m.count); m.visible = true; } }
    // The captain's red-hot blade.
    if (gl) {
      bladeLocal(gl, glow.position);
      glow.visible = true;
      const k = gl.glow * (0.8 + 0.2 * Math.sin(gl.t * 30));
      glow.scale.setScalar(0.18 + 0.26 * k);
      glow.material.opacity = k;
    } else glow.visible = warm;
  }

  function hideSlot(s) {
    for (const [k, m] of Object.entries(parts)) {
      if (PER2.has(k)) { m.setMatrixAt(s * 2, ZERO); m.setMatrixAt(s * 2 + 1, ZERO); } else m.setMatrixAt(s, ZERO);
    }
    shadows.setMatrixAt(s, ZERO);
  }

  /** The blade's tip / the gun's muzzle in the group's frame. */
  function bladeLocal(f, out) {
    if (f.bird) return out.set(f.x, f.y + (f.birdY ?? f.flyH), f.z);
    const w = f.weapon;
    const tip = w === "pistol" ? _w.set(0, -0.36, 0.035) : w === "musket" ? _w.set(0, -1.0, 0.03) : w === "none" || w === "banana" ? _w.set(0, -0.05, 0.05)
      : f.crab ? _w.set(0, -0.08, 0.35) : _w.set(0, 0.1, w === "sabre" ? 0.92 : w === "pan" || w === "brush" || w === "club" ? 0.55 : 0.7);
    return out.copy(tip).applyMatrix4(f.sk.hR.matrixWorld);
  }

  const toWorld = (v) => { group.updateMatrixWorld(); return v.applyMatrix4(group.matrixWorld); };
  const _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

  /** A figure's head top (group frame). */
  function headLocal(f, out) {
    if (f.bird) return out.set(f.x, f.y + (f.birdY ?? f.flyH) + 0.25, f.z);
    if (f.collapsed) return out.set(f.x, f.y + 0.45, f.z);
    f.sk.head.getWorldPosition(out); out.y += (f.crab ? 0.12 : 0.32) * f.scale;
    return out;
  }

  return {
    group,
    spawn, add, clear, act,
    get(id) { return byId.get(String(id)) || null; },
    get list() { return live; },
    /** Walk / run to a spot in the group's frame: {r: arrive radius, speed, keepFacing}. */
    moveTo(id, x, z, opts = {}) { const f = byId.get(String(id)); if (f && !f.down && !f.surrender && !f.ride) f.goal = { x, z, ...opts }; },
    stop(id) { const f = byId.get(String(id)); if (f) f.goal = null; },
    faceTo(id, x, z, snap) { const f = byId.get(String(id)); if (f) faceTo(f, x, z, snap); },
    /** Point a gun at a spot (null: back to the ready). */
    aimAt(id, p) { const f = byId.get(String(id)); if (f) { f.aimAt = p || null; if (p) faceTo(f, p.x, p.z); } },
    /** Show / hide a figure (the captain below decks until he comes up; the Pale Captain faded to mist). */
    show(id, on) { const f = byId.get(String(id)); if (f) f.shown = on ? 1 : 0; },
    /** Out of the fight for good (cleared off the deck: a monkey up the rigging). */
    remove(id) { const f = byId.get(String(id)); if (f) f.gone = true; },
    /** Ride on `carrierId`'s shoulders (null: hop down beside him). */
    ride(id, carrierId) {
      const f = byId.get(String(id)); if (!f) return;
      if (!carrierId && f.ride) { const c = byId.get(f.ride); if (c) { f.x = c.x + Math.sin(c.yaw + 1.6) * 0.8; f.z = c.z + Math.cos(c.yaw + 1.6) * 0.8; } }
      f.ride = carrierId ? String(carrierId) : null; f.goal = null;
    },
    update,
    /** The nearest live (standing) figure along a world ray, within `radius` m of its body: {id, dist}. */
    pick(ray, { radius = 0.55, includeDown = false } = {}) {
      group.updateMatrixWorld();
      _inv.copy(group.matrixWorld).invert();
      _ray.copy(ray).applyMatrix4(_inv);
      let best = null, bd = Infinity;
      for (const f of live) {
        if (f.gone || f.shown < 0.5 || (f.down && !includeDown)) continue;
        if (f.bird) { _a.set(f.x, f.y + (f.birdY ?? f.flyH) - 0.15, f.z); _b.set(f.x, f.y + (f.birdY ?? f.flyH) + 0.15, f.z); }
        else {
          f.sk.pelvis.getWorldPosition(_a);
          f.sk.head.getWorldPosition(_b);
          _a.y = f.y + 0.15;
        }
        const r = radius * f.scale * (f.bird ? 1.3 : f.crab || f.tub ? 1.4 : 1);
        const d2 = _ray.distanceSqToSegment(_a, _b, _v, _w);
        if (d2 > r * r) continue;
        const along = _ray.origin.distanceTo(_v);
        if (along < bd) { bd = along; best = f.id; }
      }
      return best != null ? { id: best, dist: bd } : null;
    },
    /** Head top (world) — the HP pips' and the speech bubbles' anchor. */
    headWorld(id, out = new THREE.Vector3()) { const f = byId.get(String(id)); if (!f) return null; return toWorld(headLocal(f, out)); },
    chestWorld(id, out = new THREE.Vector3()) {
      const f = byId.get(String(id)); if (!f) return null;
      if (f.bird) return toWorld(out.set(f.x, f.y + (f.birdY ?? f.flyH), f.z));
      out.set(0, 0.32, 0.05).applyMatrix4(f.sk.torso.matrixWorld); return toWorld(out);
    },
    bladeWorld(id, out = new THREE.Vector3()) { const f = byId.get(String(id)); if (!f) return null; return toWorld(bladeLocal(f, out)); },
    muzzleWorld(id, out = new THREE.Vector3()) { const f = byId.get(String(id)); if (!f) return null; return toWorld(bladeLocal(f, out)); },
    /** A hand (world): "right" | "left" (a pie leaves the left). */
    handWorld(id, out = new THREE.Vector3(), side = "right") {
      const f = byId.get(String(id)); if (!f) return null;
      if (f.bird) return toWorld(out.set(f.x, f.y + (f.birdY ?? f.flyH), f.z));
      return toWorld((side === "left" ? f.sk.hL : f.sk.hR).getWorldPosition(out));
    },
    /** The muzzle's direction (world, unit) for a gun. */
    aimDir(id, out = new THREE.Vector3()) { const f = byId.get(String(id)); if (!f) return null; group.updateMatrixWorld(); return out.set(0, -1, 0).transformDirection(_m.multiplyMatrices(group.matrixWorld, f.sk.hR.matrixWorld)); },
    /** Compile warm-up: one of each part on show. */
    warmShow(on) {
      warm = !!on;
      for (const m of [...Object.values(parts), shadows]) { m.count = on ? Math.max(1, m.count) : m.count; if (on) m.visible = true; }
      glow.visible = !!on;
    },
    dispose() {
      group.removeFromParent();
      for (const g of Object.values(G)) g.dispose();
      for (const m of Object.values(parts)) m.dispose?.();
      cloth.dispose(); metal.dispose(); shadowGeo.dispose(); shadowMat.dispose(); shadowTex.dispose();
      glow.material.dispose(); glowTex.dispose();
    },
  };
}
