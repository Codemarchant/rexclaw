// Night Raid: what the crew work with, plain and small.
//
// Hand props (one set per member, hidden between jobs, placed in world space
// every frame by the work pose): a mallet (patching), a brass spyglass
// (lookout), a rammer (the guns), a round shot (loading), a powder keg
// (carrying powder), a bucket (fires), a cutlass (boarding, repelling the
// Kraken), a tea tray (serving), a ladle (the galley), and a line from the
// hands to a block aloft, a gun's tackle or a rescuer at the rail.
//
// Fixtures (ship space, one per station spot that needs one, unless the
// scene builds its own): the bilge pump with a working handle, and the
// galley's pot on a little iron stove. Lit like the ship (standard
// materials); nothing glows.

import * as THREE from "three";

const MATS = () => ({
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4520, roughness: 0.7 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.8 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.45, metalness: 0.8 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a04a, roughness: 0.3, metalness: 0.9 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.25, metalness: 0.95 }),
  china: new THREE.MeshStandardMaterial({ color: 0xece4d4, roughness: 0.35 }),
  wool: new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.95 }),
});

/**
 * One member's hand props. Every prop's local frame: the grip at the origin; mallet, ladle, cutlass and pistol
 * along +Y from the grip; spyglass and rammer along +Z; keg, ball, bucket, tray and flask centred.
 * @param {number} layer
 */
export function createHandProps(layer) {
  const m = MATS();
  const geos = [];
  const mesh = (geo, mat) => { geos.push(geo); return new THREE.Mesh(geo, mat); };
  const group = (...kids) => { const g = new THREE.Group(); g.add(...kids); return g; };

  const handle = mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.3, 8), m.wood); handle.position.y = 0.15;
  const head = mesh(new THREE.BoxGeometry(0.13, 0.065, 0.065), m.iron); head.position.y = 0.3;
  const mallet = group(handle, head);

  const spyglass = new THREE.Group();
  [[0.022, 0.16, 0.08], [0.027, 0.15, 0.22], [0.033, 0.14, 0.35]].forEach(([r, len, z]) => {
    const s = mesh(new THREE.CylinderGeometry(r, r, len, 12), m.brass); s.rotation.x = Math.PI / 2; s.position.z = z; spyglass.add(s);
  });

  const pole = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.7, 8), m.wood); pole.rotation.x = Math.PI / 2; pole.position.z = 0.55;
  const sponge = mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.2, 10), m.wool); sponge.rotation.x = Math.PI / 2; sponge.position.z = 1.45;
  const rammer = group(pole, sponge);

  const ball = mesh(new THREE.SphereGeometry(0.07, 12, 8), m.iron);

  const kegBody = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.32, 14), m.dark);
  const hoopA = mesh(new THREE.TorusGeometry(0.152, 0.008, 4, 16), m.iron); hoopA.rotation.x = Math.PI / 2; hoopA.position.y = 0.11;
  const hoopB = hoopA.clone(); hoopB.position.y = -0.11;
  const keg = group(kegBody, hoopA, hoopB);

  const pail = mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.24, 12, 1, true), m.wood);
  const pailBase = mesh(new THREE.CircleGeometry(0.1, 12), m.wood); pailBase.rotation.x = -Math.PI / 2; pailBase.position.y = -0.12;
  const bail = mesh(new THREE.TorusGeometry(0.13, 0.006, 4, 12, Math.PI), m.iron); bail.position.y = 0.12;
  const bucket = group(pail, pailBase, bail);
  pail.material.side = THREE.DoubleSide;

  const grip = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.13, 8), m.dark); grip.position.y = 0.0;
  const guard = mesh(new THREE.TorusGeometry(0.05, 0.008, 4, 10, Math.PI), m.brass); guard.position.y = 0.07; guard.rotation.z = Math.PI / 2;
  const bladeGeo = new THREE.BoxGeometry(0.035, 0.62, 0.006); bladeGeo.translate(0, 0.39, 0);
  const blade = mesh(bladeGeo, m.steel); blade.rotation.z = 0.08;
  const cutlass = group(grip, guard, blade);

  const board = mesh(new THREE.BoxGeometry(0.42, 0.02, 0.28), m.wood);
  const cupA = mesh(new THREE.CylinderGeometry(0.035, 0.028, 0.07, 10), m.china); cupA.position.set(-0.1, 0.045, 0);
  const cupB = cupA.clone(); cupB.position.set(0.1, 0.045, 0.04);
  const pot = mesh(new THREE.SphereGeometry(0.06, 10, 8), m.china); pot.scale.y = 0.8; pot.position.set(0, 0.06, -0.06);
  const tray = group(board, cupA, cupB, pot);

  const ladleStick = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.45, 6), m.wood); ladleStick.position.y = 0.22;
  const ladleCup = mesh(new THREE.SphereGeometry(0.035, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.iron); ladleCup.rotation.x = Math.PI; ladleCup.position.y = 0.45;
  const ladle = group(ladleStick, ladleCup);

  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xcfb98a, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(lineGeo, lineMat);
  line.frustumCulled = false;

  // The boarding fight: a flintlock (the barrel along +Y from the grip) and Ara's tonic (a small flask
  // whose draught glows faintly gold-green while they tend someone; its only light).
  const stock = mesh(new THREE.BoxGeometry(0.035, 0.12, 0.05), m.wood); stock.position.set(0, -0.02, -0.02); stock.rotation.x = -0.35;
  const barrel = mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.26, 8), m.iron); barrel.position.set(0, 0.14, 0.02);
  const lock = mesh(new THREE.BoxGeometry(0.03, 0.05, 0.04), m.brass); lock.position.set(0, 0.03, 0.02);
  const pistol = group(stock, barrel, lock);
  const glass = mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshStandardMaterial({ color: 0xbfe8d0, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.55 }));
  glass.position.y = 0.05;
  const draught = mesh(new THREE.SphereGeometry(0.036, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd8ff9a, emissive: 0xb8ff6a, emissiveIntensity: 1.6, roughness: 0.4 }));
  draught.position.y = 0.045;
  const neck = mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.05, 8), m.wood); neck.position.y = 0.11;
  const flask = group(glass, draught, neck);
  m.glass = glass.material; m.draught = draught.material;

  const all = { mallet, spyglass, rammer, ball, keg, bucket, cutlass, tray, ladle, line, pistol, flask };
  for (const o of Object.values(all)) { o.visible = false; o.traverse((c) => { c.layers.set(layer); if (c.isMesh) c.castShadow = true; }); }
  return {
    ...all,
    all: Object.values(all),
    /** Hide everything except the named props. */
    only(...names) { for (const [k, o] of Object.entries(all)) o.visible = names.includes(k); },
    setLine(a, b) {
      const p = line.geometry.attributes.position;
      p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    },
    dispose() {
      for (const o of Object.values(all)) o.removeFromParent();
      for (const g of geos) g.dispose();
      for (const x of Object.values(m)) x.dispose();
      lineGeo.dispose(); lineMat.dispose();
    },
  };
}

/** Fixtures at the station spots (ship space). `pump(spot)` returns its handle (rotate .rotation.x to work it). */
export function createFixtures(parent, layer) {
  const m = MATS();
  const geos = [];
  const made = [];
  const mesh = (geo, mat) => { geos.push(geo); return new THREE.Mesh(geo, mat); };
  const place = (g, spot, ahead) => {
    const yaw = spot.yaw;
    g.position.set(spot.pos.x + Math.sin(yaw) * ahead, spot.pos.y, spot.pos.z + Math.cos(yaw) * ahead);
    g.rotation.y = yaw;
    g.traverse((c) => { c.layers.set(layer); if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    parent?.add(g);
    made.push(g);
    return g;
  };
  return {
    /** The bilge pump: a wooden column 0.85 m ahead of the spot, its handle reaching back to the pumper's waist. */
    pump(spot) {
      const g = new THREE.Group();
      g.name = "crew-pump";
      const col = mesh(new THREE.BoxGeometry(0.22, 0.9, 0.22), m.wood); col.position.y = 0.45;
      const cap = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 12), m.iron); cap.position.y = 0.92;
      const spout = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8), m.iron); spout.rotation.z = Math.PI / 2; spout.position.set(0.17, 0.7, 0);
      const pivot = new THREE.Group(); pivot.position.set(0, 0.92, 0);
      const bar = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.46, 8), m.wood); bar.rotation.x = Math.PI / 2; bar.position.z = -0.23;
      const crossbar = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 8), m.wood); crossbar.rotation.z = Math.PI / 2; crossbar.position.z = -0.46;
      pivot.add(bar, crossbar);
      g.add(col, cap, spout, pivot);
      place(g, spot, 0.85);
      return { group: g, handle: pivot, grip: crossbar };
    },
    /** The galley stove and its pot, 0.5 m ahead of the spot. */
    stove(spot) {
      const g = new THREE.Group();
      g.name = "crew-stove";
      const box = mesh(new THREE.BoxGeometry(0.5, 0.55, 0.42), m.iron); box.position.y = 0.275;
      const pot = mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.2, 14), m.iron); pot.position.y = 0.65;
      const lid = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 14), m.dark); lid.position.y = 0.76; lid.position.x = 0.12; lid.rotation.z = 0.5;
      const pipe = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), m.iron); pipe.position.set(0.18, 0.95, 0.12);
      g.add(box, pot, lid, pipe);
      place(g, spot, 0.5);
      return { group: g, pot };
    },
    dispose() {
      for (const g of made) g.removeFromParent();
      for (const x of geos) x.dispose();
      for (const x of Object.values(m)) x.dispose();
    },
  };
}
