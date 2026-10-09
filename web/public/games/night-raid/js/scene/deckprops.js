// Night Raid: what the crew work at aboard the Rexmaw (ship space), added to
// the GLB's deck: the gun deck (four carriage guns a side: the GLB's pair at
// z 3.2 plus three more, each with its port lid in the bulwark, that run in
// and out when the side fires), the bow chaser on the forecastle, the
// Captain's swivel gun on the quarterdeck rail, the chain pump by the
// mainmast, the powder kegs by the main hatch, and the galley's cauldron
// over a brazier forward. One merged mesh per material; the guns that recoil
// are their own little groups.

import * as THREE from "three";
import { B } from "./blocking.js";
import { mergeParts, createTweens } from "./util.js";

/** The deck guns' z (ship space), a side; the GLB's own pair stand at 3.2. */
export const DECK_GUNS_Z = Object.freeze([-0.6, 3.2, 5.8, 9.4]);
const BULWARK_X = 4.05;

/**
 * @param {object} R  the render context
 * @param {{fx?: object}} [deps]
 */
export function createDeckProps(R, { fx = null } = {}) {
  const root = new THREE.Group();
  root.name = "deck-props";
  R.shipSpace.add(root);
  const tweens = createTweens();
  const iron = new THREE.MeshStandardMaterial({ name: "nr-gun-iron", color: "#1d1d1f", roughness: 0.42, metalness: 0.85, envMapIntensity: 0.8 });
  const wood = new THREE.MeshStandardMaterial({ name: "nr-gun-wood", color: "#4b2f1c", roughness: 0.7, metalness: 0, envMapIntensity: 0.4 });
  const navy = new THREE.MeshStandardMaterial({ name: "nr-port-lid", color: "#1a2a4a", roughness: 0.6, metalness: 0, envMapIntensity: 0.4 });
  const brass = new THREE.MeshStandardMaterial({ name: "nr-brass", color: "#b8913f", roughness: 0.32, metalness: 1, envMapIntensity: 1.0 });
  const keg = new THREE.MeshStandardMaterial({ name: "nr-keg", color: "#5a3a20", roughness: 0.75, metalness: 0, envMapIntensity: 0.35 });
  const ember = new THREE.MeshStandardMaterial({ name: "nr-brazier-ember", color: "#2a1208", emissive: "#ff6a20", emissiveIntensity: 2.2, roughness: 0.9 });
  const mats = [iron, wood, navy, brass, keg, ember];

  // ---- One carriage gun (local: muzzle out along +X), its parts by material ----
  function gunParts(scale = 1) {
    const w = [], f = [];
    for (const dz of [-0.24, 0.24]) { const ch = new THREE.BoxGeometry(1.0, 0.32, 0.08); ch.translate(0, 0.26, dz); w.push(ch); }
    for (const dx of [-0.34, 0.34]) {
      const ax = new THREE.BoxGeometry(0.12, 0.08, 0.6); ax.translate(dx, 0.12, 0); w.push(ax);
      for (const dz of [-0.3, 0.3]) { const wh = new THREE.CylinderGeometry(0.13, 0.13, 0.08, 12); wh.rotateX(Math.PI / 2); wh.translate(dx, 0.13, dz); w.push(wh); }
    }
    const prof = [[0.0, -0.16], [0.07, -0.16], [0.11, -0.09], [0.18, 0.0], [0.17, 0.55], [0.14, 0.6], [0.13, 1.3], [0.15, 1.36], [0.15, 1.44], [0.1, 1.44], [0.07, 1.42]];
    const barrel = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r * scale, y * scale)), 14);
    barrel.rotateZ(-Math.PI / 2);
    barrel.translate(-0.45, 0.47, 0);
    f.push(barrel);
    return { wood: mergeParts(w), iron: mergeParts(f) };
  }
  const gp = gunParts();
  const guns = { port: [], starboard: [] };
  const lidParts = [];
  for (const side of ["port", "starboard"]) {
    const sx = side === "port" ? 1 : -1;
    for (const z of DECK_GUNS_Z) {
      const g = new THREE.Group();
      g.name = `gun-${side}-${z}`;
      const run = new THREE.Group();          // what recoils
      run.add(new THREE.Mesh(gp.wood, wood), new THREE.Mesh(gp.iron, iron));
      g.add(run);
      g.position.set(sx * (BULWARK_X - 0.95), 0, z);
      g.rotation.y = side === "port" ? 0 : Math.PI;
      if (z === 3.2) run.visible = false;     // the GLB's own gun stands here
      root.add(g);
      guns[side].push({ g, run, z, kick: 0 });
      if (z !== 3.2) {
        const lid = new THREE.BoxGeometry(0.03, 0.62, 0.72);
        lid.translate(sx * (BULWARK_X + 0.02), 0.6, z);
        lidParts.push(lid);
      }
    }
  }
  const lids = new THREE.Mesh(mergeParts(lidParts), navy);
  root.add(lids);

  // ---- The bow chaser (forecastle, firing over the bow) ----
  const chaser = new THREE.Group();
  chaser.name = "bow-chaser";
  {
    const run = new THREE.Group();
    const p = gunParts(1.05);
    run.add(new THREE.Mesh(p.wood, wood), new THREE.Mesh(p.iron, iron));
    chaser.add(run);
    chaser.userData.run = run;
    chaser.position.fromArray(B.BOW_CHASER.pos);
    chaser.rotation.y = -Math.PI / 2;          // +X (the muzzle) → +Z (the bow)
  }
  root.add(chaser);

  // ---- The swivel gun on the quarterdeck rail (the Captain's) ----
  const swivel = new THREE.Group();
  swivel.name = "swivel";
  swivel.position.fromArray(B.SWIVEL.pos);
  {
    const post = new THREE.CylinderGeometry(0.05, 0.06, 0.55, 8); post.translate(0, -0.25, 0);
    const yoke = new THREE.TorusGeometry(0.09, 0.02, 6, 12, Math.PI); yoke.rotateX(Math.PI / 2); yoke.rotateZ(Math.PI);
    swivel.add(new THREE.Mesh(mergeParts([post, yoke]), iron));
    const pivot = new THREE.Group();
    const prof = [[0.0, -0.1], [0.05, -0.1], [0.07, 0.0], [0.065, 0.5], [0.055, 0.55], [0.05, 0.8], [0.06, 0.84], [0.04, 0.85]];
    const barrel = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 10);
    barrel.rotateX(Math.PI / 2);
    barrel.translate(0, 0, -0.25);
    const tiller = new THREE.CylinderGeometry(0.015, 0.02, 0.5, 6); tiller.rotateX(Math.PI / 2 + 0.3); tiller.translate(0, -0.05, -0.55);
    pivot.add(new THREE.Mesh(barrel, brass), new THREE.Mesh(tiller, wood));
    swivel.add(pivot);
    swivel.userData.pivot = pivot;
  }
  root.add(swivel);

  // ---- The chain pump (two cisterns, a crank and its handles) ----
  {
    const parts = [], brassParts = [];
    for (const dx of [-0.32, 0.32]) { const c = new THREE.CylinderGeometry(0.2, 0.22, 0.9, 12); c.translate(dx, 0.45, 0); parts.push(c); }
    const box = new THREE.BoxGeometry(1.0, 0.25, 0.5); box.translate(0, 0.9, 0); parts.push(box);
    for (const dx of [-0.6, 0.6]) { const st = new THREE.BoxGeometry(0.08, 1.15, 0.08); st.translate(dx, 0.58, 0); parts.push(st); }
    const crank = new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8); crank.rotateZ(Math.PI / 2); crank.translate(0, 1.1, 0); brassParts.push(crank);
    for (const dx of [-0.75, 0.75]) { const h = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6); h.translate(dx, 0.9, 0); brassParts.push(h); }
    const pump = new THREE.Group();
    pump.name = "pump";
    pump.position.fromArray(B.PUMP.pos);
    pump.add(new THREE.Mesh(mergeParts(parts), wood), new THREE.Mesh(mergeParts(brassParts), brass));
    root.add(pump);
  }
  // ---- The powder kegs (the magazine's hatch is just forward) ----
  {
    const parts = [];
    const spots = [[-0.42, 0, -0.1], [0.0, 0, 0.12], [0.42, 0, -0.08], [-0.2, 0.62, 0.0], [0.24, 0.62, 0.02]];
    for (const [x, y, z] of spots) {
      const prof = [[0.2, 0], [0.24, 0.12], [0.26, 0.3], [0.24, 0.48], [0.2, 0.6]];
      const k = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), 12);
      k.translate(x, y, z);
      parts.push(k);
    }
    const kegs = new THREE.Mesh(mergeParts(parts), keg);
    kegs.name = "powder";
    kegs.position.fromArray(B.POWDER.pos);
    root.add(kegs);
  }
  // ---- The galley: a cauldron on a brazier ----
  {
    const parts = [];
    const pot = new THREE.LatheGeometry([[0.0, 0.0], [0.25, 0.02], [0.33, 0.15], [0.33, 0.36], [0.3, 0.42]].map(([r, h]) => new THREE.Vector2(r, h)), 16);
    pot.translate(0, 0.42, 0); parts.push(pot);
    for (let k = 0; k < 3; k++) { const a = k * 2.094; const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 5); leg.translate(Math.cos(a) * 0.3, 0.25, Math.sin(a) * 0.3); parts.push(leg); }
    const galley = new THREE.Group();
    galley.name = "galley";
    galley.position.fromArray(B.GALLEY.pos);
    galley.add(new THREE.Mesh(mergeParts(parts), iron));
    const coals = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 12), ember);
    coals.position.y = 0.12;
    galley.add(coals);
    root.add(galley);
  }
  // ---- Rexmaw Raids: the deck mortar forward of the mainmast (a squat iron bore on its oak bed) ----
  const mortar = new THREE.Group();
  mortar.name = "mortar";
  mortar.position.fromArray(B.MORTAR.pos);
  {
    const bed = new THREE.BoxGeometry(1.5, 0.35, 1.5); bed.translate(0, 0.175, 0);
    const cheeks = []; for (const dx of [-0.55, 0.55]) { const c = new THREE.BoxGeometry(0.16, 0.45, 1.1); c.translate(dx, 0.55, 0); cheeks.push(c); }
    mortar.add(new THREE.Mesh(mergeParts([bed, ...cheeks]), wood));
    const tilt = new THREE.Group();
    tilt.position.y = 0.62;
    tilt.rotation.x = -0.75;                      // laid at ~45° forward
    const bore = new THREE.LatheGeometry([[0.0, -0.32], [0.42, -0.3], [0.46, -0.05], [0.4, 0.3], [0.36, 0.5], [0.42, 0.56], [0.3, 0.56], [0.26, 0.2], [0.0, 0.18]].map(([r, h]) => new THREE.Vector2(r, h)), 16);
    const trun = new THREE.CylinderGeometry(0.1, 0.1, 1.0, 8); trun.rotateZ(Math.PI / 2);
    tilt.add(new THREE.Mesh(mergeParts([bore, trun]), iron));
    mortar.add(tilt);
    mortar.userData.tilt = tilt;
  }
  root.add(mortar);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const offFrame = R.onFrame((dt) => {
    if (mortar.userData.kick > 0) {
      mortar.userData.kick = Math.max(0, mortar.userData.kick - dt / 1.2);
      const k = mortar.userData.kick;
      mortar.userData.tilt.position.y = 0.62 - 0.18 * (k > 0.94 ? (1 - k) / 0.06 : k / 0.94);
    }
    tweens.update(dt);
    for (const side of ["port", "starboard"]) for (const gun of guns[side]) {
      if (gun.kick <= 0) continue;
      gun.kick = Math.max(0, gun.kick - dt / 2.2);
      // Recoil: slam back 0.9 m in 0.08 s, then the crew run it out again over ~2 s.
      const k = gun.kick > 0.96 ? (1 - gun.kick) / 0.04 : gun.kick / 0.96;
      gun.run.position.x = -0.9 * Math.min(1, k);
    }
    const run = chaser.userData.run;
    if (chaser.userData.kick > 0) {
      chaser.userData.kick = Math.max(0, chaser.userData.kick - dt / 2.2);
      const k = chaser.userData.kick;
      run.position.x = -0.8 * Math.min(1, k > 0.96 ? (1 - k) / 0.04 : k / 0.96);
    }
    // Embers off the galley's brazier.
    if (fx && Math.random() < dt * 1.5) { const p = new THREE.Vector3(B.GALLEY.pos[0], 0.4, B.GALLEY.pos[2]); R.shipSpace.localToWorld(p); fx.embers?.(p, { count: 1 }); }
    ember.emissiveIntensity = 1.8 + 0.5 * Math.sin(R.time * 6.3) * Math.sin(R.time * 2.9);
  }, 27);

  return {
    root,
    guns,
    /** A side's guns fire: they slam back, staggered like the muzzle flashes. */
    recoil(side, { stagger = 0.08 } = {}) {
      if (side === "bow") { chaser.userData.kick = 1; return; }
      if (side === "mortar") { mortar.userData.kick = 1; return; }
      (guns[side] || []).forEach((g, i) => { if (!g.run.visible) return; setTimeout(() => { g.kick = 1; }, i * stagger * 1000); });
    },
    /** Point the swivel at a world position (the Captain's aim). */
    aimSwivel(world) {
      if (!world) return;
      const local = R.shipSpace.worldToLocal(world.clone());
      const d = local.sub(swivel.position);
      swivel.userData.pivot.rotation.set(-Math.atan2(d.y, Math.hypot(d.x, d.z)), Math.atan2(d.x, d.z), 0, "YXZ");
    },
    /** The swivel's muzzle (world). */
    swivelMuzzle(out = new THREE.Vector3()) { return swivel.userData.pivot.localToWorld(out.set(0, 0, 0.62)); },
    /** The deck mortar's mouth (world) and its throw direction. */
    mortarMuzzle(out = new THREE.Vector3()) { return mortar.userData.tilt.localToWorld(out.set(0, 0.6, 0)); },
    mortarDir(out = new THREE.Vector3()) { const a = mortar.userData.tilt.localToWorld(new THREE.Vector3(0, 0, 0)); return mortar.userData.tilt.localToWorld(out.set(0, 1, 0)).sub(a).normalize(); },
    /** The bow chaser's muzzle (world). */
    chaserMuzzle(out = new THREE.Vector3()) { return chaser.localToWorld(out.set(1.05, 0.47, 0)); },
    dispose() {
      offFrame();
      tweens.cancel();
      root.removeFromParent();
      root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of mats) m.dispose();
    },
  };
}
