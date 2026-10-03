// Broadside: islands to hide behind (and run aground on) and the loot
// bobbing between them. Both are built from code, like the ships.
import * as THREE from "three";
import { waveHeight } from "./ocean.js";

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** An island: a sand ring, a jagged green hill, rocks and a few palms. */
export function buildIsland({ x, z, r, h, seed }) {
  const rnd = seeded(seed);
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.3, 3, 40), new THREE.MeshStandardMaterial({ color: "#e6cf98", roughness: 1 }));
  sand.position.y = -0.6;
  // The hill: a lathe profile, its rim jittered so it reads as rock, not a cone.
  const prof = [];
  for (let i = 0; i <= 12; i++) { const f = i / 12; prof.push(new THREE.Vector2(r * (1 - f * f * 0.92) * (0.85 + rnd() * 0.15), h * Math.sin(f * Math.PI / 2))); }
  const hillGeo = new THREE.LatheGeometry(prof, 36);
  const pos = hillGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), pz = pos.getZ(i), py = pos.getY(i);
    const n = 1 + (Math.sin(px * 0.31 + seed) + Math.cos(pz * 0.27 + seed * 2)) * 0.08;
    pos.setXYZ(i, px * n, py * (0.9 + rnd() * 0.15), pz * n);
  }
  hillGeo.computeVertexNormals();
  const hill = new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({ color: "#3f6d35", roughness: 0.95, flatShading: true }));
  g.add(sand, hill);
  const rockMat = new THREE.MeshStandardMaterial({ color: "#6b6b6b", roughness: 1, flatShading: true });
  for (let i = 0; i < 6; i++) {
    const a = rnd() * 6.28, rr = r * (0.95 + rnd() * 0.25);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.5 + rnd() * 2.5, 0), rockMat);
    rock.position.set(Math.cos(a) * rr, 0.5, Math.sin(a) * rr); rock.rotation.set(rnd() * 3, rnd() * 3, 0);
    g.add(rock);
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#7a5230", roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#2f7d32", roughness: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < 3 + (rnd() * 3 | 0); i++) {
    const a = rnd() * 6.28, rr = r * (0.55 + rnd() * 0.35), base = h * (1 - (rr / r) ** 2) * 0.55;
    const palm = new THREE.Group();
    palm.position.set(Math.cos(a) * rr, base, Math.sin(a) * rr);
    const tall = 7 + rnd() * 5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, tall, 7), trunkMat);
    trunk.position.y = tall / 2; trunk.rotation.z = (rnd() - 0.5) * 0.4;
    palm.add(trunk);
    for (let k = 0; k < 6; k++) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 6, 1, 4), leafMat);
      const lp = leaf.geometry.attributes.position;
      for (let j = 0; j < lp.count; j++) lp.setZ(j, -(((lp.getY(j) + 3) / 6) ** 2) * 2.2);   // the frond droops
      leaf.geometry.translate(0, 3, 0);
      leaf.position.set(trunk.rotation.z * -tall / 2, tall, 0);
      leaf.rotation.set(1.1, k * 1.05, 0, "YXZ");
      palm.add(leaf);
    }
    g.add(palm);
  }
  return g;
}

export const LOOT = {
  rum: { name: "rum barrel", effect: "+15 hull", color: "#b45309", band: "#dc2626" },
  powder: { name: "powder keg", effect: "your next hit does +60% damage", color: "#1f2937", band: "#facc15" },
  spyglass: { name: "spyglass", effect: "your next shot gets a perfect aim", color: "#ca8a04", band: "#fef3c7" },
  chest: { name: "treasure chest", effect: "60 doubloons", color: "#78350f", band: "#facc15" },
};

/** A floating piece of loot with a glowing ring around it. */
export function buildLoot(kind) {
  const L = LOOT[kind], g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: L.color, roughness: 0.6, metalness: kind === "spyglass" ? 0.8 : 0.1 });
  const band = new THREE.MeshStandardMaterial({ color: L.band, emissive: L.band, emissiveIntensity: 0.4 });
  let body;
  if (kind === "chest") {
    body = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 1.7), mat); box.position.y = 0.75;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 2.6, 12, 1, false, 0, Math.PI), mat);
    lid.rotation.z = Math.PI / 2; lid.position.y = 1.5;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.5, 1.75), band); strap.position.y = 1.1;
    body.add(box, lid, strap);
  } else if (kind === "spyglass") {
    body = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3.6, 12), mat); tube.rotation.z = Math.PI / 2; tube.position.y = 0.6;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.1, 8, 16), band); ring.rotation.y = Math.PI / 2; ring.position.set(1, 0.6, 0);
    body.add(tube, ring);
  } else {
    body = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2, 14), mat); barrel.position.y = 0.6; barrel.rotation.z = Math.PI / 2;
    const b1 = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.08, 6, 20), band); b1.rotation.y = Math.PI / 2; b1.position.set(0.55, 0.6, 0);
    const b2 = b1.clone(); b2.position.x = -0.55;
    body.add(barrel, b1, b2);
  }
  const glow = new THREE.Mesh(new THREE.RingGeometry(3.2, 4, 40), new THREE.MeshBasicMaterial({ color: L.band, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.3;
  g.add(body, glow);
  g.userData = { body, glow, kind };
  return g;
}

/** Bob a piece of loot on the waves. */
export function floatLoot(g, t, amp) {
  const { x, z } = g.position;
  g.position.y = waveHeight(x, z, t, amp);
  g.userData.body.rotation.y = t * 0.6;
  g.userData.body.rotation.z = Math.sin(t * 1.4 + x) * 0.15;
  g.userData.glow.material.opacity = 0.35 + 0.25 * Math.sin(t * 3 + z);
  g.userData.glow.scale.setScalar(1 + 0.08 * Math.sin(t * 3 + z));
}
