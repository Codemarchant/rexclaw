// Broadside: a ship, built from code. The hull is lofted from cross-sections
// (raised quarterdeck and forecastle, tumblehome, painted bands), with a
// deck, six guns a side, three masts, billowing sails that tear, a flag
// that flutters and lanterns for the night. Bow along local +z, starboard
// to +x.
import * as THREE from "three";
import { waveHeight } from "./ocean.js";

const L = 34, B = 4.6, STATIONS = 30, RIB = 12;
export const SHIP = { length: L, beam: B * 2 };

const halfBeam = (t) => (t < 0.12 ? B * (0.8 + 0.2 * (t / 0.12))
  : t > 0.62 ? B * Math.pow(Math.cos(((t - 0.62) / 0.38) * Math.PI / 2), 0.7) : B);
const keel = (t) => -0.3 - 2.6 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02 + 0.015)), 0.35);
export function sheer(t) {
  let h = 2.6;
  if (t < 0.22) h += 1.8 * Math.pow(1 - t / 0.22, 0.6);   // the quarterdeck
  if (t > 0.82) h += 1.1 * ((t - 0.82) / 0.18);           // the forecastle
  return h;
}
const zOf = (t) => (t - 0.5) * L;
const tOf = (z) => z / L + 0.5;

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, g, canvas: c };
}

/** Planks: a light texture the hull's painted colours are multiplied by. */
function plankTexture() {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = "#d9d9d9"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      g.fillStyle = `rgb(${200 + Math.random() * 40},${200 + Math.random() * 40},${200 + Math.random() * 40})`;
      g.fillRect(0, y, w, 15);
      g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, y + 15, w, 1);
      for (let x = Math.random() * 120; x < w; x += 90 + Math.random() * 90) { g.fillRect(x, y, 1, 15); }
    }
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; g.fillRect(Math.random() * w, Math.random() * h, 8 + Math.random() * 30, 1); }
  }).tex;
}

function hullGeometry(teamColor) {
  const pos = [], col = [], uv = [], idx = [];
  const c = new THREE.Color();
  const bottom = new THREE.Color("#5a2416"), wood = new THREE.Color("#3a2414"), band = new THREE.Color(teamColor),
    gold = new THREE.Color("#c9a227"), upper = new THREE.Color("#5b3a1e");
  const RP = RIB + 3;   // rib points: the curve, then the bulwark up and its cap
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let s = 0; s <= STATIONS; s++) {
      const t = s / STATIONS, z = zOf(t), hb = halfBeam(t), k = keel(t), sh = sheer(t);
      for (let j = 0; j < RP; j++) {
        let x, y;
        if (j <= RIB) {
          const u = j / RIB;
          y = k + (sh - k) * u;
          x = hb * Math.sqrt(Math.sin(u * Math.PI / 2)) * (u > 0.82 ? 1 - (u - 0.82) * 0.28 : 1);
        } else if (j === RIB + 1) { x = hb * 0.95; y = sh + 1.0; } else { x = hb * 0.86; y = sh + 1.0; }
        pos.push(x * side, y, z);
        const rel = y - sh;
        c.copy(y < 0.15 ? bottom : rel < -1.5 ? wood : rel < -0.95 ? band : rel < -0.7 ? gold : upper);
        col.push(c.r, c.g, c.b);
        uv.push(t * 7, (y + 3) / 9);
      }
    }
    for (let s = 0; s < STATIONS; s++) for (let j = 0; j < RP - 1; j++) {
      const a = base + s * RP + j, b = a + RP, cc = a + 1, d = b + 1;
      if (side > 0) idx.push(a, b, cc, cc, b, d); else idx.push(a, cc, b, cc, d, b);
    }
  }
  // The transom: close the stern between the two ribs.
  const centre = pos.length / 3;
  pos.push(0, (keel(0) + sheer(0)) / 2, zOf(0)); col.push(0.23, 0.14, 0.08); uv.push(0, 0);
  const stride = (STATIONS + 1) * RP;
  for (let j = 0; j < RIB; j++) {
    const a = j, b = j + 1, pa = stride + j, pb = stride + j + 1;
    idx.push(centre, b, a, centre, pa, pb);
  }
  idx.push(centre, stride, 0, centre, RIB, stride + RIB);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function deckGeometry() {
  const pos = [], uv = [], idx = [];
  for (let s = 0; s <= STATIONS; s++) {
    const t = s / STATIONS, hb = halfBeam(t) * 0.93, y = sheer(t) - 0.05, z = zOf(t);
    pos.push(-hb, y, z, hb, y, z); uv.push(0, t * 10, 2, t * 10);
    if (s < STATIONS) { const a = s * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Sails and flags move in the vertex shader: billow and flutter. */
function wavyMaterial(map, kind, time) {
  const m = new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.92 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", kind === "sail" ? `#include <begin_vertex>
        float bx = uv.x * 2.0 - 1.0;
        float bulge = (1.0 - bx * bx) * (0.4 + 0.6 * sin(uv.y * 3.14159));
        transformed.z += 1.5 * bulge * (1.0 + 0.07 * sin(uTime * 2.3 + uv.y * 5.0 + uv.x * 3.0));` : `#include <begin_vertex>
        transformed.z += sin(uv.x * 7.0 - uTime * 7.0) * 0.45 * uv.x;
        transformed.y += sin(uv.x * 5.0 - uTime * 6.0) * 0.12 * uv.x;`);
  };
  return m;
}

function sailTexture(emblem) {
  return canvasTexture(256, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#f3e9cf"); gr.addColorStop(1, "#d8c9a3");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(120,100,60,.35)"; g.lineWidth = 2;
    for (let x = 32; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.strokeStyle = "rgba(90,70,40,.6)"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(90,70,40,${Math.random() * 0.06})`; g.fillRect(Math.random() * w, Math.random() * h, 12, 12); }
    emblem?.(g, w, h);
  });
}

/** The Rexmaw's mark: a lobster claw. */
export function drawClaw(g, cx, cy, s, color) {
  g.fillStyle = color;
  g.beginPath(); g.ellipse(cx, cy + s * 0.55, s * 0.28, s * 0.45, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(cx - s * 0.2, cy + s * 0.3);
  g.quadraticCurveTo(cx - s * 0.75, cy - s * 0.2, cx - s * 0.25, cy - s * 0.85);
  g.quadraticCurveTo(cx - s * 0.2, cy - s * 0.3, cx + s * 0.02, cy + s * 0.15); g.fill();
  g.beginPath(); g.moveTo(cx + s * 0.18, cy + s * 0.3);
  g.quadraticCurveTo(cx + s * 0.7, cy - s * 0.05, cx + s * 0.38, cy - s * 0.7);
  g.quadraticCurveTo(cx + s * 0.22, cy - s * 0.2, cx + s * 0.02, cy + s * 0.12); g.fill();
}

function flagTexture(look) {
  return canvasTexture(256, 160, (g, w, h) => {
    g.fillStyle = look.field; g.fillRect(0, 0, w, h);
    if (look.claw) drawClaw(g, w / 2, h / 2 - 6, 70, look.mark);
    else { g.fillStyle = look.mark; g.font = "bold 110px Georgia"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(look.letter, w / 2, h / 2 + 6); }
    g.strokeStyle = "rgba(0,0,0,.4)"; g.lineWidth = 6; g.strokeRect(0, 0, w, h);
  }).tex;
}

const GUNS_Z = [-9.5, -6, -2.5, 1, 4.5, 8];
const MASTS = [{ z: -9.5, h: 19 }, { z: 0, h: 26 }, { z: 9.5, h: 21 }];

/**
 * team: { color (hull band), name, flag: { field, mark, claw | letter }, emblem: fn(g, w, h) for the main sail }
 * Returns the ship: its group and what the game drives each frame.
 */
export function buildShip(team, time) {
  const group = new THREE.Group();
  const body = new THREE.Group();   // what sinks and lists, under the bob
  group.add(body);
  const planks = plankTexture();
  planks.wrapS = planks.wrapT = THREE.RepeatWrapping;
  const hull = new THREE.Mesh(hullGeometry(team.color),
    new THREE.MeshStandardMaterial({ vertexColors: true, map: planks, roughness: 0.85, side: THREE.DoubleSide }));
  const deckTex = plankTexture(); deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping;
  const deck = new THREE.Mesh(deckGeometry(), new THREE.MeshStandardMaterial({ color: "#b48a5c", map: deckTex, roughness: 0.9 }));
  body.add(hull, deck);

  // Guns along both sides, with their ports.
  const dark = new THREE.MeshStandardMaterial({ color: "#151515", roughness: 0.5, metalness: 0.6 });
  const portMat = new THREE.MeshStandardMaterial({ color: "#1a0f08", roughness: 1 });
  const muzzles = { starboard: [], port: [] };
  const barrel = new THREE.CylinderGeometry(0.2, 0.27, 2.3, 10); barrel.rotateZ(Math.PI / 2);
  for (const side of [1, -1]) for (const z of GUNS_Z) {
    const t = tOf(z), x = halfBeam(t) * 0.97 * side, y = sheer(t) - 1.05;
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.85, 0.95), portMat); port.position.set(x + 0.05 * side, y, z);
    const gun = new THREE.Mesh(barrel, dark); gun.position.set(x + 0.7 * side, y, z);
    body.add(port, gun);
    muzzles[side > 0 ? "starboard" : "port"].push(new THREE.Vector3(x + 1.9 * side, y, z));
  }

  // Masts, yards, sails.
  const woodMat = new THREE.MeshStandardMaterial({ color: "#4a2f18", roughness: 0.8 });
  const sails = [];
  MASTS.forEach((m, mi) => {
    const t = tOf(m.z), base = sheer(t) - 0.2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, m.h, 10), woodMat);
    mast.position.set(0, base + m.h / 2, m.z);
    body.add(mast);
    const yards = [0.32, 0.6, 0.84].map((f) => base + m.h * f);
    const widths = [13, 10, 7].map((w) => w * (m.h / 26 + 0.15));
    yards.forEach((y, i) => {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, widths[i], 8), woodMat);
      yard.rotation.z = Math.PI / 2; yard.position.set(0, y, m.z + 0.2);
      body.add(yard);
      // A square sail hangs below its yard, down to the yard beneath (the
      // lowest one to a little above the deck).
      const bottom = i === 0 ? base + 2.2 : yards[i - 1] + 0.3;
      const h = y - 0.15 - bottom, w = widths[i] * 0.93;
      const emblem = mi === 1 && i === 0 ? team.emblem : null;
      const st = sailTexture(emblem);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 12, 10), wavyMaterial(st.tex, "sail", time));
      sail.position.set(0, y - 0.15 - h / 2, m.z + 0.35);
      body.add(sail);
      sails.push({ mesh: sail, g: st.g, tex: st.tex, w: st.canvas.width, h: st.canvas.height });
    });
  });
  // The jib, from the foremast to the bowsprit.
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, 11, 8), woodMat);
  bowsprit.rotation.x = Math.PI / 2 - 0.35; bowsprit.position.set(0, sheer(1) + 1.2, L / 2 + 3.5);
  body.add(bowsprit);

  // The flag, flying from the mainmast.
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(5, 3.1, 14, 6), wavyMaterial(flagTexture(team.flag), "flag", time));
  flag.geometry.translate(2.5, 0, 0);
  flag.rotation.y = -Math.PI / 2;
  flag.position.set(0, sheer(0.5) + MASTS[1].h - 1.4, 0);
  body.add(flag);

  // Lanterns at stern and bow, and a light for the night.
  const lampMat = new THREE.MeshStandardMaterial({ color: "#ffcc66", emissive: "#ffb347", emissiveIntensity: 2 });
  const lights = [];
  for (const [z, y] of [[-L / 2 + 0.6, sheer(0) + 1.8], [L / 2 - 2, sheer(1) + 1.6]]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), lampMat); lamp.position.set(0, y, z);
    const light = new THREE.PointLight("#ffb347", 0, 40, 1.6); light.position.copy(lamp.position);
    body.add(lamp, light); lights.push(light);
  }

  // The nameboard on the stern.
  const board = canvasTexture(512, 96, (g, w, h) => {
    g.fillStyle = "#2b1a0e"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#c9a227"; g.lineWidth = 6; g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = "#f6d77a"; g.font = "italic bold 52px Georgia"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(team.name, w / 2, h / 2 + 3);
  }).tex;
  const name = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 1.2), new THREE.MeshStandardMaterial({ map: board, roughness: 0.7 }));
  name.rotation.y = Math.PI; name.position.set(0, sheer(0) - 0.6, -L / 2 - 0.05);
  body.add(name);

  const ship = {
    group, body, muzzles, sails, lights, hp: 100, list: 0, sinking: 0, wounds: [],
    /** Ride the waves: bob, pitch and roll from the water under the hull. */
    float(t, amp) {
      const yaw = group.rotation.y, px = group.position.x, pz = group.position.z;
      const at = (lx, lz) => waveHeight(px + lx * Math.cos(yaw) + lz * Math.sin(yaw), pz - lx * Math.sin(yaw) + lz * Math.cos(yaw), t, amp);
      const bow = at(0, 13), stern = at(0, -13), star = at(4, 0), port = at(-4, 0);
      body.position.y = (bow + stern + star + port) / 4 * 0.85 - this.sinking * 14;
      body.rotation.x = -Math.atan2(bow - stern, 26) * 0.8 + this.sinking * 0.25;
      body.rotation.z = Math.atan2(star - port, 8) * 0.7 - this.list - this.sinking * 0.5;
    },
    /** Tear holes in a random sail. */
    tear(n = 2) {
      for (let i = 0; i < n; i++) {
        const s = sails[(Math.random() * sails.length) | 0];
        s.g.globalCompositeOperation = "destination-out";
        s.g.beginPath();
        const r = 10 + Math.random() * 18, x = Math.random() * s.w, y = Math.random() * s.h;
        for (let a = 0; a < 6.28; a += 0.6) { const rr = r * (0.6 + Math.random() * 0.6); s.g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        s.g.fill();
        s.g.globalCompositeOperation = "source-over";
        s.tex.needsUpdate = true;
      }
    },
    setLanterns(v) { lights.forEach((l) => { l.intensity = v * 40; }); },
    /** The world position of a point on the ship. */
    world(local) { return body.localToWorld(local.clone()); },
  };
  return ship;
}

export const HULL = { halfBeam, keel, sheer, tOf, zOf };
