// Night Raid (from Night Helm): the set's blocking. Where everything stands
// aboard the Rexmaw, the world frame's conventions, and the camera's shot list.
//
// Frames. WORLD: +Y up, metres; the bay's origin is the home port's mouth,
// +Z = north (the bay's interior). Headings are degrees, 0 = +Z, increasing
// toward −X (starboard at heading 0): heading ψ points along (−sin ψ, 0, cos ψ).
// SHIP SPACE = the frame of `R.shipSpace` (the Rexmaw, the camera, the crew
// and the companion ride in it). world.js moves it every frame to the sim's
// pose: position (x, heave, z), yaw −ψ, then pitch and roll about a pivot
// near the waterline. In ship space +Z is the bow and +X is PORT.
//
// The ship (measured from rexmaw_deck.glb / tools/scenes/build_rexmaw_deck.py;
// glTF = Blender (x, z, −y)): main deck y = 0 over z ∈ [−4.5, 14], the cabin
// under the quarterdeck (floor y = 2.6, z ∈ [−12.5, −4.5]; stairs up both
// sides at x = ±3.45 from z = −1.9 to −4.3), the forecastle (y = 1.6, z > 14),
// the wheel's hub at (0, 3.72, −6.88), the binnacle at (0, 2.6, −6.0), the
// mizzen at z = −9.8, the mainmast at z = +8 (fife rail z ∈ [7.2, 8]), the
// main hatch at z ∈ [3.8, 5.4], |x| < 1, the foremast at z = +16, the stem at
// z ≈ +20, the transom at z = −12.5, the inner bulwark at |x| ≈ 4.05
// amidships, the waterline half-beam ≈ 4.4. Water at y = −2.2.

import * as THREE from "three";

const DEG = Math.PI / 180;

/** Render layers: the main camera sees them all; the water's reflection sees WORLD, SKY and FX. */
export const LAYERS = Object.freeze({ WORLD: 0, SKY: 1, AVATAR: 2, NOREFLECT: 3, FX: 4 });

/** The water plane's height (world y). */
export const WATER_Y = -2.2;

/**
 * Ship-space blocking. Positions are [x, y, z]; angles in degrees.
 * COMPANION: beside the wheel to starboard, a pace forward of the Captain,
 * turned 20° toward them (yaw 0 = facing +Z, positive turns toward +X).
 */
export const B = Object.freeze({
  WHEEL: Object.freeze({ pos: [0, 3.72, -6.88], radius: 0.62 }),
  CAPTAIN_EYE: [0.55, 5.9, -9.35],
  COMPANION: Object.freeze({ pos: [-1.45, 2.6, -5.2], faceYawDeg: 20 }),
  RAIL_LANTERN: [-3.75, 3.78, -6.15],
  BELL: [-1.6, 4.6, -10.6],
  BINNACLE: [0, 3.6, -6.0],
  BOW: [0, 2.2, 20.5],
  BOWSPRIT_TIP: [0, 6.5, 28.5],
  STERN: [0, 3.0, -12.8],
  MASTHEAD: [0, 27, 8],
  MAINTOP: [0, 12.9, 8],
  /** The waterline ellipse: |x| < a, z ∈ [z − b, z + b]. */
  HULL: Object.freeze({ a: 4.4, b: 16.5, z: 3.5 }),
  /** Deck cargo (the plunder in the hold, shown as crates): 12 crates on the main deck forward of the cabin. */
  CARGO: Object.freeze({ center: [0, 0, 4.6], size: 0.86, gap: 0.08 }),
  /** The pivot the ship pitches and rolls about (near the waterline, amidships). */
  PIVOT: [0, -1.2, 2.0],
  /** The harbour ashore turned half a circle about the mooring (open water along +Z). */
  ASHORE: Object.freeze({ rotY: Math.PI }),
  /** The broadside: 8 muzzles a side (ship space, +X = port), the bow chaser, the Captain's swivel. */
  GUNS: Object.freeze({
    port: Object.freeze([-2.6, -0.4, 1.8, 3.2, 5.4, 7.6, 9.8, 12.0].map((z) => Object.freeze([4.55, 0.75, z]))),
    starboard: Object.freeze([-2.6, -0.4, 1.8, 3.2, 5.4, 7.6, 9.8, 12.0].map((z) => Object.freeze([-4.55, 0.75, z]))),
    bow: Object.freeze([Object.freeze([0, 2.35, 19.6])]),
  }),
  BOW_CHASER: Object.freeze({ pos: [0, 1.6, 17.9] }),
  SWIVEL: Object.freeze({ pos: [-2.75, 3.75, -4.75] }),
  /** Deck props the stations work at (ship space): the chain pump, the powder kegs, the galley's cauldron. */
  PUMP: Object.freeze({ pos: [0, 0, 6.45] }),
  POWDER: Object.freeze({ pos: [0, 0, 2.55] }),
  GALLEY: Object.freeze({ pos: [-2.75, 0, 13.0] }),
  /** Rexmaw Raids: the deck mortar, forward of the mainmast on the centreline (a little to port of the galley's lane). */
  MORTAR: Object.freeze({ pos: [1.0, 0, 11.4] }),
});

/**
 * The unit direction toward azimuth φ and altitude θ (degrees), φ measured
 * from +Z toward −X (the heading convention).
 * @param {number} az @param {number} alt @param {THREE.Vector3} [out]
 */
export function dir(az, alt, out = new THREE.Vector3()) {
  const p = az * DEG, t = alt * DEG;
  return out.set(-Math.sin(p) * Math.cos(t), Math.sin(t), Math.cos(p) * Math.cos(t));
}

/** A heading (degrees) as a unit vector on the water: [dx, dz]. */
export function headingVec(deg) {
  const p = deg * DEG;
  return [-Math.sin(p), Math.cos(p)];
}

const fromCompanion = (dx, dy, dz) => { const c = B.COMPANION.pos; return [c[0] + dx, c[1] + dy, c[2] + dz]; };

/**
 * The shot list, as data camera.js resolves every frame. Ship space unless a
 * shot says `world: true`. A shot has `pos` and one way to aim:
 *   - `target`: a point [x, y, z] (or a function returning one);
 *   - `look`:   [az, alt] from `pos` (ship-relative azimuth).
 * `fov` is degrees. `crane` (s) moves `pos` → `to`: looping back and forth,
 * or once with `once: true`. `orbit` = {center, radius, height, speed (rad/s),
 * start (rad)} circles the centre. `stabilize` 0..1 keeps that share of the
 * horizon level while the ship heels and pitches. `aboard` keeps the position
 * bolted to the deck under stabilisation. world.js overrides pos/target per
 * frame for the live shots (the chase's auto-framing, the spyglass, the
 * sinking, the rogue wave, the boarding cut).
 */
export const SHOTS = Object.freeze({
  // C: behind the wheel (Night Helm's view).
  helm: { pos: B.CAPTAIN_EYE, target: [0.2, -1.5, 24], fov: 60, stabilize: 0.65, aboard: true },
  // The default: Rexmaw Raids' Black Flag follow, 28 m astern and 11 m up (follow.js orbits it by the mouse).
  chase: { pos: [0, 12.6, -24.5], target: [0, -2, 50], fov: 56, stabilize: 0.82 },
  // E / right mouse: the spyglass from the quarterdeck (world.js aims it).
  spyglass: { pos: [0.55, 6.3, -8.6], target: [0, 0, 300], fov: 11, stabilize: 0.9, aboard: true },
  // The title: off her starboard bow at the mooring, looking aft over the moored ship and the harbour.
  title: { pos: [-6, 8.5, 41], to: [-8.5, 10.5, 36], crane: 16, target: [18, 10, -52], fov: 56, stabilize: 1 },
  // Casting off: one long crane from low off the starboard bow up and back over the ship.
  castOff: { pos: [-15, 3.2, 34], to: [-6, 22, -50], crane: 8, once: true, target: [0, 3.5, 12], fov: 52, stabilize: 1 },
  // A big broadside: low off the firing side, ahead, looking aft along the gun line (world.js mirrors x).
  volley: { pos: [26, 3.4, 30], target: [2, 1.2, -2], fov: 46, stabilize: 1 },
  // A ship going down (world.js aims at it from beside the Rexmaw).
  sink: { pos: [0, 16, -30], target: [0, 0, 100], fov: 40, stabilize: 1 },
  // The rogue wave: low off the quarter, the wall over the bow (world.js aims at the wave).
  wave: { pos: [-9, 5.5, -22], target: [0, 6, 60], fov: 58, stabilize: 0.4 },
  // Boarding: on the rail, looking across at the enemy's deck (world.js mirrors x and aims).
  board: { pos: [2.9, 4.9, 4.5], target: [30, 2, 6], fov: 50, stabilize: 0.85, aboard: true },
  // The Kraken: from above the helm, aimed at the arm (world target set by world.js).
  kraken: { pos: [1.2, 6.6, -11.5], target: [0, 4, 60], fov: 50, stabilize: 1, aboard: true },
  krakenEye: { pos: [0.6, 6.0, -10.5], target: [0, 4, 120], fov: 34, stabilize: 1, aboard: true },
  // Banking plunder / arriving home: a slow orbit around the ship.
  arrival: { orbit: { center: [0, 3, 2], radius: 40, height: 14, speed: 0.11, start: 2.4 }, target: [0, 4, 2], fov: 48, stabilize: 1 },
  // The Rexmaw sinking: a slow pull up and away from the listing ship.
  wreck: { pos: [16, 9, 30], to: [34, 34, 52], crane: 12, once: true, target: [0, 0, 2], fov: 48, stabilize: 1 },
  // The companion, close (a reaction, the results card): three-quarter on, from forward of them.
  companion: { pos: fromCompanion(1.4, 1.85, 2.9), target: fromCompanion(0, 1.45, 0), fov: 36, stabilize: 1, aboard: true },
});

/**
 * What stands in the water at the home port once ashore is turned (relative
 * to the mooring, metres): add the port's (x, z) for world coordinates
 * (`harbourObstacles(port)`). Capsules {a:{x,z}, b:{x,z}, r} and circles {x, z, r}.
 * Land (the quay, the town) is everything with x < −10.4 for z ∈ [−62, 52]
 * (mooring-relative); past z = 52 the shore falls back to x ≈ −24 at z = 72.
 */
export const HARBOUR_OBSTACLES = Object.freeze([
  Object.freeze({ kind: "pier", a: { x: -8.3, z: -39 }, b: { x: -8.3, z: 29 }, r: 2.1 }),
  Object.freeze({ kind: "quay", a: { x: -13.2, z: -62 }, b: { x: -13.2, z: 52 }, r: 2.8 }),
  Object.freeze({ kind: "shore", a: { x: -16, z: 52 }, b: { x: -27, z: 70 }, r: 5 }),
  Object.freeze({ kind: "ship", x: 44, z: 26, r: 11 }),
  Object.freeze({ kind: "ship", x: 26, z: -22, r: 10 }),
  Object.freeze({ kind: "boat", x: -8.3, z: -42.5, r: 2.5 }),
]);

/** HARBOUR_OBSTACLES moved to the port's mooring (world coordinates). @param {{x: number, z: number}} port */
export function harbourObstacles(port) {
  const px = +port?.x || 0, pz = +port?.z || 0;
  const mv = (p) => ({ x: p.x + px, z: p.z + pz });
  return HARBOUR_OBSTACLES.map((o) => (o.a ? { kind: o.kind, a: mv(o.a), b: mv(o.b), r: o.r } : { kind: o.kind, ...mv(o), r: o.r }));
}
