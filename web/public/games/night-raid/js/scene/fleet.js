// Rexmaw Raids: the ships of the bay that aren't the Rexmaw, built from the ship kit (shipkit.js:
// planked hulls with wales and painted strakes, gun-port lids that swing up and barrels that run
// out and recoil, rails, stern galleries with lit windows, figureheads, bowsprits with jibs,
// multi-tier sails that billow and reef, ratlines, crow's nests, ensigns and pennants, lanterns).
//
//   classes    merchant, gunboat, brig, frigate, fire ship, man-o'-war, the Iron Duke and the
//              legendary Gloam (CLASSES in shipkit.js): geometry built ONCE per class.
//   pool       a few ships of each class are built at load (every program is compiled once,
//              behind the title: all ships share seven programs); a contact takes a free ship of
//              its class and gives it back when it leaves. A class that runs dry builds another.
//   per ship   hull, rig, guns, sails, port glow, ropes, flags: seven draws (ropes and guns drop
//              out beyond the LOD distance), per-ship uniforms on shared programs.
//   telegraph  `portsOpen` lights that side's ports and swings the lids up over 2.5 s while the
//              barrels run out; a volley ripples muzzle flashes and recoils the barrels down the side.
//   damage     hull lost chars the paint and pocks it with shot holes; masts lost tear the sails
//              (procedural holes) and, past two thirds, bring a mast down over the side; fires burn
//              on deck (flames.js); a fire ship that is lit glows from every seam.
//   sinking    she lists, settles, the bow comes up and she goes down stern first: bubbles, foam,
//              flotsam (and loot afloat: the pickups module draws the core's pickups).
//   weak points glowing, pulsing marks at `weakPoints[].local` (ship frame: +Z bow, +X port).
//
// Frames: a ship's local frame matches the Rexmaw's ship space (+Z bow, +X port, y = 0 at the
// waterline); world yaw = −heading.

import * as THREE from "three";
import { LAYERS, WATER_Y, headingVec } from "./blocking.js";
import { hash } from "./util.js";
import { CLASSES, classOf as kitClassOf, buildClass, shipUniforms, hullMaterial, rigMaterial, gunsMaterial, sailMaterial, ropeMaterial, flagMaterial, portGlowMaterial, SAIL_TINT } from "./shipkit.js";
import { shipTextures } from "./textures.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export { CLASSES };
/** Hull points (the core's numbers), for the hull fraction when a contact doesn't carry hullMax. */
export const HULL_MAX = Object.freeze({ merchant: 110, gunboat: 40, brig: 90, frigate: 180, fireship: 50, manowar: 380, ironduke: 520, gloam: 600 });
/** Top speeds (m/s) the sails are set for. */
const TOP_SPEED = { merchant: 9, gunboat: 12, brig: 12, frigate: 11, fireship: 10, manowar: 8, ironduke: 8, gloam: 11 };
/** The class for a contact (the Iron Duke rides a man-o'-war's cls with a legend flag or her name). */
export function classOf(cls, c = null) {
  const k = kitClassOf(cls);
  if (k === "manowar" && c && (c.legend || c.boss || /iron\s*duke/i.test(String(c.name || "")))) return "ironduke";
  return k;
}
/** Ships built per class at load. */
const POOL = { merchant: 4, gunboat: 4, brig: 3, frigate: 2, fireship: 2, manowar: 1, ironduke: 1, gloam: 1 };
const LAMP_WARM = new THREE.Color("#ffb347").multiplyScalar(4.2);
const LAMP_TEAL = new THREE.Color("#5fffd6").multiplyScalar(4.4);

/**
 * Build the fleet (hidden until contacts come in).
 * @param {object} R  the render context
 * @param {{water: object, fx: object, flames: object}} deps
 */
export function createFleet(R, { water, fx, flames }) {
  const root = new THREE.Group();
  root.name = "fleet";
  R.scene.add(root);
  const disposables = [];
  const wu = water?.uniforms || {};
  const fogU = { uFogDensity: wu.uFogDensity || { value: 0 }, uTime: wu.uTime || { value: 0 } };

  // Per-class geometry (shared by every ship of the class).
  const kinds = {};
  for (const key of Object.keys(CLASSES)) {
    const K = buildClass(key);
    kinds[key] = K;
    disposables.push(K.hullG, K.rigG, K.gunsG, K.glowG, K.sailsG, K.ropeG, K.flagG);
  }

  // ---- One ship ----
  let seq = 0;
  function buildShip(kind) {
    const K = kinds[kind], c = K.c;
    const group = new THREE.Group();
    group.name = `ship-${kind}-${seq++}`;
    group.visible = false;
    const body = new THREE.Group();
    group.add(body);
    const U = shipUniforms(fogU.uTime);
    U.uSeed.value = (hash(group.name) % 1000) / 37.0;
    K.masts.forEach((m, i) => { if (i < 4) { U.uMastZ.value.setComponent(i, m.z); U.uMastY.value.setComponent(i, m.y); } });
    const tint = SAIL_TINT[c.sail] || SAIL_TINT.plain;
    U.uSailTint.value.setRGB(tint[0], tint[1], tint[2]);
    if (c.eerie) U.uEerie.value = 1;
    if (c.ember) U.uEmber.value = 1;
    if (c.stripe) { const sc = new THREE.Color(c.stripe[0]); U.uStripe.value.set(sc.r, sc.g, sc.b, c.stripe[1] || 6); }
    if (K.emblem) {
      const cell = shipTextures().EMBLEM_CELLS[K.emblem.cell] || [0, 0];
      U.uEmblem.value.set(cell[0], 1 - cell[1], K.emblem.mast, 1);
      U.uEmblemTier.value = K.emblem.tier;
    }
    U.uRag.value = c.tattered || 0;
    U.uWorn.value = c.tattered ? 1 : 0;
    const hullMat = hullMaterial(U), rigMat = rigMaterial(U), gunsMat = gunsMaterial(U);
    const sailMat = sailMaterial(U, { worn: !!c.tattered }), ropeMat = ropeMaterial(U, c.eerie ? "#0b0e0e" : "#1d1712"), flagMat = flagMaterial(U);
    const glowMat = portGlowMaterial(fogU);
    if (c.eerie) glowMat.uniforms.uColor.value.set("#3fffd0");      // the Gloam's open ports burn cold
    const hull = new THREE.Mesh(K.hullG, hullMat);
    const rig = new THREE.Mesh(K.rigG, rigMat);
    const guns = new THREE.Mesh(K.gunsG, gunsMat);
    const sails = new THREE.Mesh(K.sailsG, sailMat);
    const glow = new THREE.Mesh(K.glowG, glowMat);
    glow.renderOrder = 6;
    glow.layers.set(LAYERS.FX);
    const ropes = new THREE.LineSegments(K.ropeG, ropeMat);
    const flag = new THREE.Mesh(K.flagG, flagMat);
    flag.visible = !!c.flag;
    body.add(hull, rig, guns, sails, glow, ropes, flag);
    for (const m of [hull, rig, guns, sails, ropes, flag]) m.frustumCulled = true;
    root.add(group);
    disposables.push(hullMat, rigMat, gunsMat, sailMat, ropeMat, flagMat, glowMat);
    return {
      kind, K, group, body, hull, rig, guns, sails, glow, ropes, flag, U, glowMat,
      id: null, busy: false, last: null,
      portsK: new THREE.Vector2(), vis: 1, visT: 1, dmg: 0, burn: 0, tears: 0, sink: 0, sinking: false, sunk: false, surrender: false,
      heading: 0, turnRate: 0, heel: 0, recoil: 0, recoilV: 0, pitch: 0, roll: 0, heave: 0, x: 0, z: 0, speed: 0, fade: 0,
      bubbleT: 0, flotsamT: 0, lit: 0, mastsSeen: 100, fires: [], wakeT: 0, set: 0.6, falls: [], fallen: 0,
      scorch: 0, smokeT: 0, sprayT: 0, dCam: 1e9,
    };
  }
  const pool = {};
  for (const [k, n] of Object.entries(POOL)) pool[k] = Array.from({ length: n }, () => buildShip(k));
  const byId = new Map();

  function resetShip(sh) {
    sh.id = null; sh.busy = false; sh.last = null; sh.group.visible = false;
    sh.portsK.set(0, 0); sh.vis = 1; sh.visT = 1; sh.dmg = 0; sh.burn = 0; sh.sink = 0; sh.sinking = false; sh.sunk = false; sh.surrender = false;
    sh.recoil = 0; sh.recoilV = 0; sh.fade = 0; sh.lit = 0; sh.fires.length = 0; sh.mastsSeen = 100; sh.tears = 0; sh.falls.length = 0; sh.fallen = 0;
    sh.scorch = sh.K.c.ember ? 0.4 : 0; sh.smokeT = 0; sh.sprayT = 0; sh.dCam = 1e9;   // the fire ship's canvas is sooty from the start
    const U = sh.U;
    U.uDmg.value = 0; U.uBurn.value = 0; U.uScorch.value = sh.scorch; U.uTear.value = 0; U.uFall.value.set(0, 0, 0, 0); U.uWhite.value = 0;
    U.uOpen.value.set(0, 0); U.uRun.value.set(0, 0); U.uFireT.value.set(-99, -99);
    sh.flag.visible = !!sh.K.c.flag;
  }

  function claim(c) {
    const kind = classOf(c.cls, c);
    let sh = pool[kind].find((s) => !s.busy);
    if (!sh) { sh = buildShip(kind); pool[kind].push(sh); }
    resetShip(sh);
    sh.busy = true; sh.id = c.id;
    sh.x = +c.x || 0; sh.z = +c.z || 0; sh.heading = +c.heading || 0;
    // A contact that turns up close (a new night's opening, a debug spawn) is simply there; far ones fade in.
    R.camera.getWorldPosition(_cam);
    sh.fade = Math.hypot(sh.x - _cam.x, sh.z - _cam.z) < 400 ? 1 : 0;
    byId.set(c.id, sh);
    return sh;
  }

  function release(sh) {
    byId.delete(sh.id);
    resetShip(sh);
  }

  /** More holes in the sails (a hit aloft). */
  function tear(sh, n = 2) { sh.tears += n; }

  /** Bring a mast down over the side (index into the class's masts; default the foremost standing). */
  function fallMast(sh, index = null) {
    const n = sh.K.masts.length;
    let i = index;
    if (i == null) { for (let k = n - 1; k >= 0; k--) if (!sh.falls.some((f) => f.i === k)) { i = k; break; } }
    if (i == null || i >= 4 || sh.falls.some((f) => f.i === i)) return false;
    sh.falls.push({ i, t: 0, side: Math.random() < 0.5 ? -1 : 1, splashed: false });
    sh.fallen++;
    return true;
  }

  // ---- Lantern glows: one additive Points draw for every ship ----
  const LAMP_CAP = 160;
  const lampPos = new Float32Array(LAMP_CAP * 3), lampCol = new Float32Array(LAMP_CAP * 3), lampSize = new Float32Array(LAMP_CAP);
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute("position", new THREE.BufferAttribute(lampPos, 3).setUsage(THREE.DynamicDrawUsage));
  lampGeo.setAttribute("aColor", new THREE.BufferAttribute(lampCol, 3).setUsage(THREE.DynamicDrawUsage));
  lampGeo.setAttribute("aSize", new THREE.BufferAttribute(lampSize, 1).setUsage(THREE.DynamicDrawUsage));
  lampGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  lampGeo.setDrawRange(0, 0);
  const lampMat = new THREE.ShaderMaterial({
    name: "NightRaidShipLamps", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uScale: { value: 800 }, uFogDensity: fogU.uFogDensity, uTime: fogU.uTime },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize;
      uniform float uScale, uFogDensity, uTime;
      varying vec3 vCol;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.5);
        float fd = uFogDensity * d * 0.45;
        float flick = 0.9 + 0.1 * sin(uTime * 7.0 + position.x * 3.1 + position.z);
        vCol = aColor * exp(-fd * fd) * flick;
        gl_PointSize = clamp(aSize * uScale / d, 2.5, 64.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        gl_FragColor = vec4(vCol * (exp(-r2 * 9.0) + 0.25 * exp(-r2 * 2.5)), 1.0);
      }`,
  });
  const lampPts = new THREE.Points(lampGeo, lampMat);
  lampPts.frustumCulled = false;
  lampPts.renderOrder = 12;
  lampPts.layers.set(LAYERS.FX);
  root.add(lampPts);
  disposables.push(lampGeo, lampMat);
  const _bs = new THREE.Vector2();
  lampPts.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_bs).y;
    lampMat.uniforms.uScale.value = h / (2 * Math.tan((R.camera.fov * DEG) / 2));
  };

  // ---- Weak points: pulsing marks (instanced billboards) ----
  const WEAK_CAP = 32;
  const weakGeo = new THREE.InstancedBufferGeometry();
  const quadG = new THREE.PlaneGeometry(1, 1);
  weakGeo.index = quadG.index;
  weakGeo.setAttribute("position", quadG.attributes.position);
  weakGeo.setAttribute("uv", quadG.attributes.uv);
  const weakAt = new THREE.InstancedBufferAttribute(new Float32Array(WEAK_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
  weakGeo.setAttribute("aAt", weakAt);
  weakGeo.instanceCount = 0;
  const weakMat = new THREE.ShaderMaterial({
    name: "NightRaidWeakPoints", transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: fogU.uTime },
    vertexShader: /* glsl */`
      attribute vec4 aAt;             // world x, y, z, seed (negative seed: hovered)
      uniform float uTime;
      varying vec2 vUv; varying float vHover; varying float vPulse; varying float vFar;
      void main() {
        vUv = uv;
        vHover = aAt.w < 0.0 ? 1.0 : 0.0;
        vFar = abs(aAt.w) > 5.0 ? 1.0 : 0.0;
        vPulse = 0.5 + 0.5 * sin(uTime * 5.0 + abs(aAt.w) * 20.0);
        vec4 mv = modelViewMatrix * vec4(aAt.xyz, 1.0);
        float d = max(-mv.z, 1.0);
        float s = max(1.6, d * 0.022) * (1.0 + 0.15 * vPulse + 0.3 * vHover);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying float vHover; varying float vPulse; varying float vFar;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float rq = (r - 0.62) / 0.07;
        float ring = exp(-rq * rq);
        float core = exp(-r * r * 22.0);
        float cross = (exp(-abs(p.x) * 40.0) + exp(-abs(p.y) * 40.0)) * smoothstep(0.95, 0.3, r) * 0.25;
        vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.9, 0.55), vHover);
        float a = (ring * (0.7 + 0.5 * vPulse) + core * 1.2 + cross) * smoothstep(1.0, 0.9, r);
        gl_FragColor = vec4(col * a * (2.6 + 1.5 * vHover) * mix(1.0, 0.35, vFar), 1.0);
      }`,
  });
  const weakMesh = new THREE.Mesh(weakGeo, weakMat);
  weakMesh.frustumCulled = false;
  weakMesh.renderOrder = 20;
  weakMesh.layers.set(LAYERS.NOREFLECT);
  root.add(weakMesh);
  disposables.push(weakGeo, weakMat, quadG);
  const weakList = [];         // [{contactId, weakId, pos: Vector3}]
  let hoverWeak = null;

  // ---- Bow waves: one instanced foam decal for every ship ----
  const FOAM_CAP = 32;
  // Subdivided so it can ride the swell (the vertex shader lifts every vertex onto water.js's three trains).
  const foamGeo = new THREE.PlaneGeometry(2, 2, 10, 12);
  foamGeo.rotateX(-Math.PI / 2);
  const foamAttr = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
  foamGeo.setAttribute("aFoam", foamAttr);
  const foamMat = new THREE.ShaderMaterial({
    name: "NightRaidShipFoam", transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { uTime: fogU.uTime, uFogDensity: fogU.uFogDensity, uMoon: { value: 0.8 },
      uSwellA: wu.uSwellA || { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uSwellB: wu.uSwellB || { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] } },
    vertexShader: /* glsl */`
      attribute vec2 aFoam;        // speed 0..1, seed
      uniform vec4 uSwellA[3]; uniform vec4 uSwellB[3]; uniform float uTime;
      varying vec2 vP; varying vec2 vF; varying float vDist;
      // The swell, as water.js computes it (uSwellA: dir.xz, k, ω; uSwellB: amplitude, phase).
      float rrSwell(vec2 xz) {
        float h = 0.0;
        for (int i = 0; i < 3; i++) h += uSwellB[i].x * sin(uSwellA[i].z * dot(uSwellA[i].xy, xz) - uSwellA[i].w * uTime + uSwellB[i].y);
        return h;
      }
      void main() {
        vP = position.xz; vF = aFoam;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        float sw = rrSwell(w.xz);
        w.y += (sw == sw ? sw : 0.0) + 0.05;          // NaN-safe
        vec4 mv = viewMatrix * w;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uMoon;
      varying vec2 vP; varying vec2 vF; varying float vDist;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float sp = vF.x;
        vec2 p = vP;
        float hullE = length(vec2(p.x / 0.32, p.y / 0.82));
        float wash = smoothstep(1.35, 1.0, hullE) * smoothstep(0.92, 1.02, hullE);
        float bow = smoothstep(0.55, 0.95, p.y) * smoothstep(0.7, 0.2, abs(abs(p.x) - (1.0 - p.y) * 0.9 - 0.25));
        float trail = smoothstep(-0.2, -1.0, p.y) * smoothstep(0.55, 0.05, abs(p.x) - (-p.y - 0.2) * 0.25);
        float grain = n(vec2(p.x * 9.0, p.y * 14.0 - uTime * (0.8 + 2.4 * sp)) + vF.y * 17.0);
        float a = (wash * 0.55 + bow * 0.9 + trail * 0.55 * grain) * smoothstep(0.35, 0.75, grain + 0.25) * sp;
        float fd = uFogDensity * vDist;
        a *= exp(-fd * fd);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vec3(0.5, 0.58, 0.64) * (0.45 + 0.6 * uMoon), a * 0.75);
      }`,
  });
  const foamMesh = new THREE.InstancedMesh(foamGeo, foamMat, FOAM_CAP);
  foamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  foamMesh.count = 0;
  foamMesh.frustumCulled = false;
  foamMesh.renderOrder = 3;
  foamMesh.layers.set(LAYERS.NOREFLECT);
  root.add(foamMesh);
  disposables.push(foamGeo, foamMat);

  // ---- Crews: simple figures on every deck, one instanced draw for the whole fleet (the Gloam's in a second,
  // self-lit one). Legs, a shirt, a head and a hat in vertex colours; the instance colour tints the shirt only
  // (aTint marks it). Culled beyond CREW_RANGE, gone when she sinks.
  const CREW_CAP = 160, GHOST_CAP = 16, CREW_RANGE = 350;
  const crewGeo = (() => {
    const parts = [];
    const add = (g, col, tint) => {
      const n = g.attributes.position.count;
      const c = new THREE.Color(col), cc = new Float32Array(n * 3), tt = new Float32Array(n);
      for (let i = 0; i < n; i++) { cc[i * 3] = c.r; cc[i * 3 + 1] = c.g; cc[i * 3 + 2] = c.b; tt[i] = tint; }
      g.setAttribute("color", new THREE.BufferAttribute(cc, 3));
      g.setAttribute("aTint", new THREE.BufferAttribute(tt, 1));
      if (g.index) g = g.toNonIndexed();
      for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color", "aTint"].includes(k)) g.deleteAttribute(k);
      parts.push(g);
    };
    for (const s of [1, -1]) add(new THREE.CylinderGeometry(0.09, 0.075, 0.82, 5).translate(s * 0.11, 0.41, 0), "#2a2622", 0);   // legs
    add(new THREE.CylinderGeometry(0.2, 0.17, 0.7, 7).translate(0, 1.13, 0), "#ffffff", 1);                                    // shirt / coat
    for (const s of [1, -1]) add(new THREE.CylinderGeometry(0.06, 0.055, 0.62, 4).rotateZ(s * 0.18).translate(s * 0.27, 1.12, 0), "#ffffff", 1);
    add(new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.63, 0), "#c8a080", 0);                                           // head
    add(new THREE.CylinderGeometry(0.15, 0.17, 0.09, 8).translate(0, 1.74, 0), "#1c1a18", 0);                               // hat
    let n = 0; for (const g of parts) n += g.attributes.position.count;
    const out = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3), T = new Float32Array(n);
    let o = 0;
    for (const g of parts) {
      P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); C.set(g.attributes.color.array, o * 3); T.set(g.attributes.aTint.array, o);
      o += g.attributes.position.count; g.dispose();
    }
    out.setAttribute("position", new THREE.BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.BufferAttribute(C, 3));
    out.setAttribute("aTint", new THREE.BufferAttribute(T, 1));
    return out;
  })();
  const crewMaterial = (ghost) => {
    const m = new THREE.MeshStandardMaterial({ name: ghost ? "rr-crew-ghost" : "rr-crew", vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.3 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aTint;")
        // The instance colour tints only the clothes: undo it on skin, legs and hat.
        .replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvColor.rgb = aTint > 0.5 ? vColor.rgb : color.rgb;\n#endif");
      if (ghost) {
        sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(0.15, 0.9, 0.75) * 0.55 * (0.7 + 0.3 * sin(vViewPosition.y * 3.0));`);
      }
    };
    m.customProgramCacheKey = () => (ghost ? "rr-crew-ghost" : "rr-crew");
    if (ghost) { m.transparent = true; m.opacity = 0.62; m.depthWrite = false; }
    return m;
  };
  const crewMat = crewMaterial(false), ghostMat = crewMaterial(true);
  const crewMesh = new THREE.InstancedMesh(crewGeo, crewMat, CREW_CAP);
  const ghostMesh = new THREE.InstancedMesh(crewGeo, ghostMat, GHOST_CAP);
  for (const m of [crewMesh, ghostMesh]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.name = m === crewMesh ? "fleet-crews" : "fleet-ghost-crew";
    root.add(m);
  }
  {
    const c0 = new THREE.Color("#ffffff");
    for (let i = 0; i < CREW_CAP; i++) crewMesh.setColorAt(i, c0);
    for (let i = 0; i < GHOST_CAP; i++) ghostMesh.setColorAt(i, new THREE.Color("#9fe8dc"));
  }
  disposables.push(crewGeo, crewMat, ghostMat);
  /** Shirt colours per class (navy coats, merchants' mixed slops, the fire ship's sooty few). */
  const CREW_COLS = {
    navy: ["#1f3566", "#24407a", "#e8e2d2", "#b8352a"], merchant: ["#d8cdb4", "#8a5a34", "#5a6a4a", "#b8352a", "#3a4a6a"],
    fireship: ["#3a3028", "#4a3a2a"], gloam: ["#9fe8dc"],
  };
  const _cc = new THREE.Color(), _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _cs = new THREE.Vector3(1, 1, 1), _cp = new THREE.Vector3(), _ce = new THREE.Euler();
  function crewFor(sh, idx, ghost) {
    const mesh = ghost ? ghostMesh : crewMesh, cap = ghost ? GHOST_CAP : CREW_CAP;
    const spots = sh.K.crewSpots;
    const lowK = R.quality.tier === "low" ? 0.5 : 1;
    const n = Math.min(spots.length, Math.ceil(spots.length * lowK));
    const cl = sh.K.c;
    const pal = CREW_COLS[cl.eerie ? "gloam" : sh.kind === "fireship" ? "fireship" : cl.flag === "merchant" ? "merchant" : "navy"];
    const t = fogU.uTime.value;
    const fallen = sh.falls.length;
    for (let k = 0; k < n && idx < cap; k++) {
      const p = spots[k];
      // Hands at the guns duck when she fires; the ghosts drift; everyone sways on their feet.
      const bob = ghost ? 0.12 * Math.sin(t * 0.9 + p.seed) + 0.1 : 0.025 * Math.sin(t * 2.1 + p.seed);
      const sway = 0.05 * Math.sin(t * 0.7 + p.seed * 2.0) + (fallen ? 0.12 * Math.sin(t * 6 + p.seed) : 0);
      _cp.set(p.x, p.y + bob, p.z);
      _ce.set(0, p.yaw + 0.25 * Math.sin(t * 0.23 + p.seed), sway);
      _cq.setFromEuler(_ce);
      _cm.compose(_cp, _cq, _cs).premultiply(sh.body.matrixWorld);
      mesh.setMatrixAt(idx, _cm);
      if (!ghost) mesh.setColorAt(idx, _cc.set(pal[(k + Math.floor(p.seed * 3)) % pal.length]));
      idx++;
    }
    return idx;
  }

  // ---- Pooled lights: the nearest ships' lanterns, and gun flashes ----
  const shipLights = Array.from({ length: 3 }, (_, i) => {
    const l = new THREE.PointLight("#ffb067", 0, 42, 2);
    l.name = `ship-lantern-${i}`;
    R.scene.add(l);
    return l;
  });
  const flashLight = new THREE.PointLight("#ffc27a", 0, 120, 2);
  flashLight.name = "gun-flash";
  R.scene.add(flashLight);
  let flashK = 0;

  // ---- Volleys: muzzles ripple down the side ----
  const queue = [];
  let clock = 0;

  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
  const _sw = { h: 0, dx: 0, dz: 0 };
  const _cam = new THREE.Vector3();

  /** Ship-local → world for a ship (after its pose). */
  function toWorld(sh, local, out) { return out.copy(local).applyMatrix4(sh.body.matrixWorld); }

  function volley(by, side, { balls = 0, ammo = "round" } = {}) {
    const sh = byId.get(by);
    if (!sh) return false;
    const s = side === "bow" ? "bow" : side === "port" ? "port" : "starboard";
    const guns = sh.K.guns[s] || [];
    if (!guns.length) return true;
    const n = clamp(balls || guns.length, 1, guns.length);
    const step = Math.max(1, Math.floor(guns.length / n));
    const order = guns.filter((_, i) => i % step === 0).slice(0, n);
    order.forEach((g, i) => queue.push({ at: clock + (g.order ?? i / n) * 0.55 + Math.random() * 0.04, sh, g, ammo, scale: sh.K.c.L > 40 ? 1.25 : 1 }));
    // The barrels recoil down the side (the guns shader ripples them by order); the ship heels away.
    const ft = fogU.uTime.value;
    if (s === "port" || s === "bow") sh.U.uFireT.value.x = ft;
    if (s === "starboard") sh.U.uFireT.value.y = ft;
    sh.recoilV += (s === "port" ? -1 : 1) * 0.6 * Math.min(1, n / 6);
    if (s === "port") sh.portsK.x = Math.max(sh.portsK.x, 0.95); else if (s === "starboard") sh.portsK.y = Math.max(sh.portsK.y, 0.95);
    return true;
  }

  function fireGun(item) {
    const sh = item.sh;
    sh.body.updateMatrixWorld();
    const g = item.g;
    const muzzle = toWorld(sh, _v.set(g.mx ?? g.x, g.my ?? g.y, g.mz ?? g.z), new THREE.Vector3());
    const out = _d.set(g.side || 0, 0.03, g.side ? 0 : 1).transformDirection(sh.body.matrixWorld);
    fx.muzzle(muzzle, out, { scale: item.scale, smoke: R.quality.smoke ?? 1 });
    fx.smokeRing?.(muzzle, out, { scale: item.scale });
    flashLight.position.copy(muzzle).addScaledVector(out, 3);
    flashK = Math.max(flashK, 1);
  }

  // ---- Per frame ----
  const seen = new Set();
  let dropFn = null;
  let windNow = { dirDeg: 0, strength: 0.7 };
  let dayNow = 0;

  function update(state, dt, ctx = {}) {
    clock += dt;
    const list = Array.isArray(state?.contacts) ? state.contacts : [];
    seen.clear();
    R.camera.getWorldPosition(_cam);
    windNow = ctx.wind || windNow;
    dropFn = typeof ctx.drop === "function" ? ctx.drop : null;
    // Day or night: the state's daylight (eased over ~2.5 s), else the sky's. Lanterns, stern windows, crews read it.
    const dayT = Number.isFinite(+state?.daylight) ? clamp(+state.daylight, 0, 1) : (R.atmos?.day || 0);
    dayNow += (dayT - dayNow) * Math.min(1, (dt || 0) / 2.5);
    if (!Number.isFinite(dayNow)) dayNow = dayT;
    for (const c of list) {
      if (!c || c.id == null) continue;
      if (/^(fort|tower)$/.test(String(c.cls || "").toLowerCase())) continue;
      seen.add(c.id);
      let sh = byId.get(c.id);
      if (!sh) { if (c.state === "sunk") continue; sh = claim(c); }
      sh.last = c;
      stepShip(sh, c, dt, windNow);
    }
    for (const sh of [...byId.values()]) {
      if (seen.has(sh.id)) continue;
      if (sh.sinking && !sh.sunk) { stepShip(sh, sh.last, dt, windNow); continue; }
      sh.fade -= dt / 1.2;
      if (sh.fade <= 0) release(sh); else stepShip(sh, sh.last, dt, windNow, true);
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].at > clock) continue;
      const it = queue.splice(i, 1)[0];
      if (it.sh?.busy) fireGun(it);
    }
    flashK = Math.max(0, flashK - dt * 7);
    flashLight.intensity = 2600 * flashK * flashK;

    // Lamps, lights, bow waves, weak points, fires, crews.
    const day = dayNow;
    const low = R.quality.tier === "low";
    let nl = 0, nf = 0, nc = 0, ng = 0;
    const near = [];
    weakList.length = 0;
    for (const sh of byId.values()) {
      if (!sh.group.visible) continue;
      const c = sh.K.c;
      const col = c.eerie ? LAMP_TEAL : LAMP_WARM;
      const lampK = sh.vis * clamp(sh.fade, 0, 1) * (1 - smooth(0.3, 0.8, sh.sink)) * (1 - 0.88 * day) * (sh.last?.derelict ? 0 : 1);   // a derelict is dark
      for (const lp of sh.K.lamps) {
        if (nl >= LAMP_CAP) break;
        toWorld(sh, lp, _v);
        lampPos[nl * 3] = _v.x; lampPos[nl * 3 + 1] = _v.y; lampPos[nl * 3 + 2] = _v.z;
        lampCol[nl * 3] = col.r * lampK; lampCol[nl * 3 + 1] = col.g * lampK; lampCol[nl * 3 + 2] = col.b * lampK;
        lampSize[nl] = 1.3;
        nl++;
      }
      near.push(sh);
      // The crew on deck (near enough to see, afloat, not cloaked).
      if (sh.dCam < CREW_RANGE && sh.sink < 0.15 && !sh.sinking && sh.vis > 0.6 && sh.fade > 0.4 && sh.K.crewSpots.length && !sh.last?.derelict) {
        if (c.eerie) ng = crewFor(sh, ng, true); else nc = crewFor(sh, nc, false);
      }
      if (nf < FOAM_CAP && sh.sink < 0.5) {
        const sp = clamp(sh.speed / 10, 0, 1) * clamp(sh.fade, 0, 1);
        _m.compose(_v.set(sh.x, WATER_Y + 0.04, sh.z), _q.setFromAxisAngle(_w.set(0, 1, 0), -sh.heading * DEG), _d.set(c.B * 3.1, 1, c.L * 0.62));
        const [hx, hz] = headingVec(sh.heading);
        _m.elements[12] = sh.x + hx * c.L * 0.08; _m.elements[14] = sh.z + hz * c.L * 0.08;
        foamMesh.setMatrixAt(nf, _m);
        foamAttr.setXY(nf, sp, (hash(sh.group.name) % 100) / 100);
        nf++;
      }
      const wps = sh.last?.weakPoints;
      if (Array.isArray(wps) && !sh.sinking) {
        for (const wp of wps) {
          if (weakList.length >= WEAK_CAP || !wp?.local) continue;
          const pos = toWorld(sh, _v.set(+wp.local.x || 0, +wp.local.y || 0, +wp.local.z || 0), new THREE.Vector3());
          weakList.push({ contactId: sh.id, weakId: wp.id, pos });
        }
      }
      const burning = (sh.fireCount || 0) + (sh.lit > 0.01 ? 6 : 0);
      if (burning && flames && !sh.sunk) {
        const spots = sh.K.fireSpots;
        const n = Math.min(spots.length, burning);
        for (let k = 0; k < n; k++) {
          const f = sh.fires[k];
          const local = f?.local || spots[(k * 3) % spots.length];
          toWorld(sh, local, _v);
          if (_v.y < WATER_Y + 0.2) continue;
          flames.add(_v, { size: (f ? 2.2 : 3.2) * (c.L > 40 ? 1.3 : 1), seed: (k + 1) * 0.37 + (hash(sh.group.name) % 13), smoke: true });
        }
        // Burning canvas: with two or more fires (or a lit fire ship) the flames climb into the sails.
        if (burning >= 2 && !sh.sinking) {
          const ms = sh.K.masts;
          for (let k = 0; k < Math.min(ms.length, burning >= 4 ? ms.length : 1); k++) {
            const m = ms[(k + 1) % ms.length];
            if (sh.falls.some((f) => f.i === (k + 1) % ms.length)) continue;
            toWorld(sh, _v.set(0, m.y + m.h * (0.3 + 0.12 * k), m.z + 0.8), _w);
            flames.add(_w, { size: 2.6 * (c.L > 40 ? 1.3 : 1), seed: 5.1 + k * 0.71 + (hash(sh.group.name) % 7), smoke: true });
          }
        }
      }
      // A badly hurt hull smokes (grey-brown columns from her wounds), even with no fire aboard.
      if (!low && sh.dmg > 0.5 && !sh.sunk && sh.dCam < 900) {
        sh.smokeT -= dt * (0.8 + 3 * (sh.dmg - 0.5));
        if (sh.smokeT <= 0) {
          sh.smokeT = 1;
          const t = 0.2 + ((clock * 7.13) % 1) * 0.6;
          toWorld(sh, _v.set((((clock * 3.7) % 1) - 0.5) * c.B, sh.K.S.deck(t) + 0.6, sh.K.S.zOf(t)), _w);
          fx.steam?.(_w);
        }
      }
      // The fire ship smoulders all the time: embers and a thread of smoke off her tarred deck.
      if (c.ember && !sh.sunk && sh.dCam < 700 && sh.vis > 0.5) {
        sh.smokeT -= dt * (low ? 1 : 2.5);
        if (sh.smokeT <= 0) {
          sh.smokeT = 1;
          const t = 0.15 + ((clock * 5.31) % 1) * 0.7;
          toWorld(sh, _v.set((((clock * 2.9) % 1) - 0.5) * c.B, sh.K.S.deck(t) + 0.4, sh.K.S.zOf(t)), _w);
          fx.embers?.(_w, { count: 3 });
          if (!low && ((clock * 13.7) % 1) < 0.5) fx.steam?.(_w);
        }
      }
      // Spray off her bow when she's making way.
      if (sh.speed > 6 && !sh.sinking && sh.dCam < 450 && sh.vis > 0.5) {
        sh.sprayT -= dt * (sh.speed - 5) * (low ? 0.15 : 0.35);
        if (sh.sprayT <= 0) {
          sh.sprayT = 1;
          const [hx, hz] = headingVec(sh.heading);
          toWorld(sh, _v.set(0, 0.4, c.L * 0.48), _w);
          _w.y = WATER_Y + 0.5;
          fx.spray?.(_w, { dirX: hx, dirZ: hz, amount: clamp((sh.speed - 5) / 6, 0.3, 1) * (c.L > 40 ? 1.3 : 0.9) });
        }
      }
    }
    crewMesh.count = nc; ghostMesh.count = ng;
    if (nc) { crewMesh.instanceMatrix.needsUpdate = true; if (crewMesh.instanceColor) crewMesh.instanceColor.needsUpdate = true; }
    if (ng) ghostMesh.instanceMatrix.needsUpdate = true;
    lampGeo.setDrawRange(0, nl);
    for (const a of [lampGeo.attributes.position, lampGeo.attributes.aColor, lampGeo.attributes.aSize]) a.needsUpdate = true;
    foamMesh.count = nf;
    if (nf) { foamMesh.instanceMatrix.needsUpdate = true; foamAttr.needsUpdate = true; }
    foamMat.uniforms.uMoon.value = 0.8 + day * 1.2;
    const rx = +state?.ship?.x, rz = +state?.ship?.z;
    for (let i = 0; i < weakList.length; i++) {
      const w = weakList[i];
      const hov = hoverWeak && hoverWeak.contactId === w.contactId && hoverWeak.weakId === w.weakId;
      // Beyond the swivel's 120 m the mark dims (it's a promise, not a shot yet): +10 on the seed says "far".
      const far = Number.isFinite(rx) && Math.hypot(w.pos.x - rx, w.pos.z - rz) > 120 ? 10 : 0;
      weakAt.setXYZW(i, w.pos.x, w.pos.y, w.pos.z, (hov ? -1 : 1) * (0.1 + (i * 0.173) % 1 + far));
    }
    weakGeo.instanceCount = weakList.length;
    if (weakList.length) weakAt.needsUpdate = true;

    near.sort((a, b) => (Math.hypot(a.x - _cam.x, a.z - _cam.z) - Math.hypot(b.x - _cam.x, b.z - _cam.z)));
    const nLights = Math.min(shipLights.length, R.quality.shipLights ?? 3);
    shipLights.forEach((l, i) => {
      const sh = i < nLights ? near[i] : null;
      if (!sh || sh.vis < 0.2) { l.intensity = 0; return; }
      toWorld(sh, sh.K.lamps[0] || _w.set(0, 3, -sh.K.c.L * 0.45), _v);
      l.position.copy(_v);
      l.color.set(sh.K.c.eerie ? "#5fffd6" : sh.lit > 0.1 ? "#ff7a2a" : "#ffb067");
      l.distance = sh.lit > 0.1 ? 70 : 42;
      l.intensity = (sh.lit > 0.1 ? 900 * sh.lit : 60 * (1 - 0.9 * day) * (sh.last?.derelict ? 0 : 1)) * clamp(sh.fade, 0, 1) * (1 - sh.sink);
    });
  }

  function stepShip(sh, c, dt, wind, leaving = false) {
    if (!c) return;
    const K = sh.K, cl = K.c, U = sh.U;
    sh.group.visible = true;
    if (!leaving) sh.fade = Math.min(1, sh.fade + dt / 1.5);
    const hd = Number.isFinite(+c.heading) ? +c.heading : sh.heading;
    const rate = dt > 0 ? wrap180(hd - sh.heading) / dt : 0;
    if (Math.abs(rate) < 90) sh.turnRate += (rate - sh.turnRate) * (1 - Math.exp(-dt / 0.6));
    sh.heading = hd;
    if (Number.isFinite(+c.x)) sh.x = +c.x;
    if (Number.isFinite(+c.z)) sh.z = +c.z;
    sh.speed = Math.max(0, +c.speed || 0);
    const [fx_, fz_] = headingVec(hd);
    const px = -fz_, pz = fx_;
    const L2 = cl.L * 0.4, B2 = cl.B * 0.9;
    const hB = water.swellAt(sh.x + fx_ * L2, sh.z + fz_ * L2, _sw).h;
    const hS = water.swellAt(sh.x - fx_ * L2, sh.z - fz_ * L2, _sw).h;
    const hP = water.swellAt(sh.x + px * B2, sh.z + pz * B2, _sw).h;
    const hR = water.swellAt(sh.x - px * B2, sh.z - pz * B2, _sw).h;
    const big = clamp(cl.L / 30, 0.6, 1.8);
    const pitchT = Math.atan((hB - hS) / (2 * L2)) * 0.8 / big;
    // v4: a derelict (c.derelict) lists ~13° to one side unless the state says how far.
    const heelSim = Number.isFinite(+c.heel) ? +c.heel * DEG : c.derelict ? ((hash(sh.group.name) % 2) ? 13 : -13) * DEG : clamp(-sh.turnRate * sh.speed * 0.0006, -0.12, 0.12);
    const rollT = Math.atan((hP - hR) / (2 * B2)) * 0.7 / big + heelSim;
    const k = 1 - Math.exp(-dt / 0.4);
    sh.pitch += (pitchT - sh.pitch) * k;
    sh.roll += (rollT - sh.roll) * k;
    sh.heave += (((hB + hS + hP + hR) / 4) * 0.85 + (dropFn ? dropFn(sh.x, sh.z) : 0) - sh.heave) * k;
    sh.recoilV += (-30 * sh.recoil - 4.5 * sh.recoilV) * dt;
    sh.recoil += sh.recoilV * dt;

    const st = c.state;
    if (st === "sinking" || st === "sunk") startSinking(sh);
    if ((st === "surrender" || c.flag === "white") && !sh.surrender) sh.surrender = true;
    U.uWhite.value = sh.surrender ? 1 : 0;
    const pOpen = !sh.surrender && !sh.sinking && (c.portsOpen?.port || (c.firing && c.firing === "port"));
    const sOpen = !sh.surrender && !sh.sinking && (c.portsOpen?.starboard || (c.firing && c.firing === "starboard"));
    sh.portsK.x = clamp(sh.portsK.x + (pOpen ? dt / 2.5 : -dt / 1.6), 0, 1);
    sh.portsK.y = clamp(sh.portsK.y + (sOpen ? dt / 2.5 : -dt / 1.6), 0, 1);
    const gp = smooth(0, 1, sh.portsK.x), gs = smooth(0, 1, sh.portsK.y);
    sh.glowMat.uniforms.uGlow.value.set(gp, gs);
    // The lids swing up first (the first 60 % of the telegraph), then the guns run out.
    U.uOpen.value.set(smooth(0, 0.6, sh.portsK.x), smooth(0, 0.6, sh.portsK.y));
    U.uRun.value.set(smooth(0.45, 1, sh.portsK.x), smooth(0.45, 1, sh.portsK.y));
    const hullMax = +c.hullMax || HULL_MAX[sh.kind] || 100;
    const hv = Number.isFinite(+c.hull) ? +c.hull : 1;
    const hullK = clamp(hv <= 1.0001 ? hv : hv / hullMax, 0, 1);
    sh.dmg += ((1 - hullK) - sh.dmg) * Math.min(1, dt * 2);
    U.uDmg.value = sh.dmg;
    // Masts lost: the sails tear, and past two thirds down a mast comes over the side.
    const mv = Number.isFinite(+c.masts) ? +c.masts : 1;
    const masts = Math.min(mv <= 1.0001 ? mv * 100 : mv, c.derelict ? 30 : 100);   // a derelict's canvas hangs torn, a mast gone
    if (masts < sh.mastsSeen - 6) { sh.tears += Math.floor((sh.mastsSeen - masts) / 6); sh.mastsSeen = masts; }
    if (!sh.sinking && masts < 34 && sh.fallen < 1 && K.masts.length > 1) fallMast(sh);
    if (!sh.sinking && masts < 8 && sh.fallen < 2 && K.masts.length > 2) fallMast(sh);
    // Holes, not a skeleton: even a wreck keeps most of her canvas (the fallen masts carry theirs away).
    U.uTear.value = clamp((100 - masts) / 100 * 0.55 + sh.tears * 0.008, 0, 0.58);
    for (const f of sh.falls) {
      f.t += dt;
      const a = Math.min(1, f.t / 2.4);
      U.uFall.value.setComponent(f.i, f.side * 1.5 * a * a);
      if (a >= 1 && !f.splashed) {
        f.splashed = true;
        const m = K.masts[f.i];
        toWorld(sh, _v.set(f.side * m.h * 0.8, 0, m.z), _w);
        fx.splash?.(_w.setY(WATER_Y).clone(), { scale: 2.2 });
        fx.splinters?.(_w.clone().setY(WATER_Y + 1), { count: 30, scale: 1.4 });
        R.cam?.trauma?.(Math.hypot(_w.x - _cam.x, _w.z - _cam.z) < 200 ? 0.2 : 0.05);
      }
    }
    // Sails: set by her speed (courses come off first), struck when she surrenders.
    const top = TOP_SPEED[sh.kind] || 10;
    const setT = sh.surrender ? 0.08 : sh.sinking ? sh.set : c.derelict ? 0.55 : clamp(0.25 + sh.speed / (top * 0.8), 0.25, 1);
    sh.set += (setT - sh.set) * Math.min(1, dt * 0.6);
    U.uSet.value = sh.set;
    U.uWind.value = clamp(+wind.strength || 0.7, 0, 1.2);
    const rel = wrap180((wind.dirDeg ?? 0) - hd);
    U.uLee.value = rel >= 0 ? 1 : -1;
    // The flags stream downwind (the shader turns them about their staffs).
    const downwind = wrap180((wind.dirDeg ?? 0) + 180 - hd);
    U.uFlagYaw.value = Math.PI - downwind * DEG;
    // Windows and lanterns lit by night (the state's daylight, eased).
    U.uWin.value = 1 - 0.92 * dayNow;
    const litT = sh.kind === "fireship" && (c.lit || c.ai === "lit" || st === "ram") ? 1 : 0;
    sh.lit += (litT - sh.lit) * Math.min(1, dt * (litT ? 0.4 : 2));
    const nFires = Math.max(sh.fires.length, Math.round(+c.fires || 0));
    sh.fireCount = nFires;
    const fireK = clamp(nFires / 4, 0, 1);
    sh.burn = Math.max(sh.lit, fireK * 0.6);
    U.uBurn.value = sh.burn;
    // Fire leaves its mark on the canvas (scorch grows while she burns, never heals).
    sh.scorch = clamp(sh.scorch + sh.burn * dt * 0.12, 0, 0.9);
    U.uScorch.value = sh.scorch;
    if (sh.lit > 0.3 && Math.random() < dt * 6) fx.embers?.(toWorld(sh, _v.set((Math.random() - 0.5) * cl.B, cl.h0 + 1 + Math.random() * 8, (Math.random() - 0.5) * cl.L * 0.7), _w));
    sh.visT = c.cloaked || c.cloak || c.ai === "cloak" ? 0.12 : 1;
    sh.vis += (sh.visT - sh.vis) * Math.min(1, dt * 0.8);
    const vis = sh.vis * clamp(sh.fade, 0, 1);
    U.uVis.value = vis;
    sh.glowMat.uniforms.uVis.value = vis;
    if (cl.eerie && Math.random() < dt * (sh.visT < 0.5 ? 14 : 3)) {
      toWorld(sh, _v.set((Math.random() - 0.5) * cl.B * 3, Math.random() * 6, (Math.random() - 0.5) * cl.L * 1.1), _w);
      fx.ghostMist?.(_w, { thick: sh.visT < 0.5 });
    }
    // LOD: the ropes and the guns drop out at range; the flags further.
    const dCam = Math.hypot(sh.x - _cam.x, sh.z - _cam.z);
    sh.dCam = dCam;
    const lod = R.quality.tier === "low" ? 0.6 : R.quality.tier === "medium" ? 0.8 : 1;
    sh.ropes.visible = vis > 0.4 && dCam < 420 * lod;
    sh.guns.visible = dCam < 520 * lod;
    sh.flag.visible = vis > 0.4 && dCam < 900 * lod && (!!cl.flag || sh.surrender) && !c.derelict;   // v4: a derelict flies no colours

    let sinkY = 0, sinkPitch = 0, sinkRoll = 0;
    if (sh.sinking) {
      // v4: the small ones go quicker (~10 s; 16 s for a frigate and up).
      sh.sink = Math.min(1, sh.sink + dt / (cl.L < 35 ? 10 : 16));
      const s = sh.sink;
      sinkRoll = smooth(0, 0.2, s) * 0.3 * sh.sinkSide;
      sinkPitch = smooth(0.15, 0.7, s) * 0.5;
      sinkY = -smooth(0, 0.25, s) * 1.6 - smooth(0.25, 1, s) * (cl.L * 0.55 + cl.D + 6);
      sh.bubbleT -= dt;
      if (sh.bubbleT <= 0 && s < 0.97) {
        sh.bubbleT = 0.45;
        toWorld(sh, _v.set(0, 0, -cl.L * 0.2 + Math.random() * cl.L * 0.4), _w);
        fx.bubbles(_w.setY(WATER_Y), { seconds: 1.2, radius: cl.B * 1.4 });
        if (s > 0.2) fx.foam(_w, { radius: cl.B * 2 + s * cl.L * 0.3, life: 3, alpha: 0.6 });
      }
      sh.flotsamT -= dt;
      if (sh.flotsamT <= 0 && s < 0.85) {
        sh.flotsamT = 0.7;
        toWorld(sh, _v.set((Math.random() - 0.5) * cl.B * 2, cl.h0, (Math.random() - 0.5) * cl.L * 0.8), _w);
        fx.flotsam?.(_w, { n: 1 + Math.floor(Math.random() * 3), vx: 0, vz: 0 });
      }
      if (s >= 1) { sh.sunk = true; sh.group.visible = false; }
    }
    sh.group.position.set(sh.x, WATER_Y, sh.z);
    sh.group.rotation.set(0, -hd * DEG, 0);
    sh.body.position.set(0, sh.heave + sinkY, 0);
    sh.body.rotation.set(-(sh.pitch + sinkPitch), 0, sh.roll + sh.recoil * 0.12 + sinkRoll, "YXZ");
    sh.group.updateMatrixWorld(true);
    for (let i = sh.fires.length - 1; i >= 0; i--) if (sh.fires[i].out) sh.fires.splice(i, 1);
  }

  function startSinking(sh) {
    if (sh.sinking) return;
    sh.sinking = true;
    sh.sink = 0;
    sh.sinkSide = Math.random() < 0.5 ? -1 : 1;
    sh.portsK.set(0, 0);
    // A burst of wreckage as she breaks: spars, planks, a mast or two over the side.
    sh.body.updateMatrixWorld();
    toWorld(sh, _v.set(0, sh.K.c.h0, 0), _w);
    fx.flotsam?.(_w.clone(), { n: 8 });
    if (sh.K.masts.length > 1 && sh.fallen < 1) fallMast(sh);
    if (sh.kind === "fireship" && sh.lit > 0.2) {
      fx.explosion?.(_w.clone().setY(_w.y + 1), { scale: 1.6 });
      R.cam?.trauma?.(0.3);
    }
  }

  // ---- API ----
  return {
    root,
    CLASSES,
    kinds,
    update,
    volley,
    /** The world position of contact `id`'s ship (or null). */
    positionOf(id, out = new THREE.Vector3()) { const sh = byId.get(id); return sh && sh.group.visible ? out.set(sh.x, WATER_Y + sh.K.c.h0, sh.z) : null; },
    /** A point on contact `id`'s ship in its own frame → world (or null). */
    localToWorld(id, local, out = new THREE.Vector3()) { const sh = byId.get(id); return sh ? toWorld(sh, out.copy(local), out) : null; },
    /** World → contact `id`'s frame (or null). */
    worldToLocal(id, world, out = new THREE.Vector3()) { const sh = byId.get(id); if (!sh) return null; sh.body.updateMatrixWorld(); return sh.body.worldToLocal(out.copy(world)); },
    /** The ship's size: {L, B, h0, radius} (or null). */
    sizeOf(id) { const sh = byId.get(id); return sh ? { L: sh.K.c.L, B: sh.K.c.B, h0: sh.K.c.h0, radius: sh.K.radius } : null; },
    /** Her class key and pose, for overlays (heading, speed, x, z). */
    info(id) { const sh = byId.get(id); return sh ? { kind: sh.kind, x: sh.x, z: sh.z, heading: sh.heading, speed: sh.speed, L: sh.K.c.L, B: sh.K.c.B, sinking: sh.sinking, vis: sh.vis } : null; },
    has(id) { return byId.has(id); },
    /** Every live ship's {id, x, z, L, B, heading} (the aim preview's hit test, the overlays). */
    each(fn) { for (const sh of byId.values()) if (sh.group.visible && !sh.sinking) fn(sh.id, sh); },
    /** v4: every shown ship, sinking ones too (the tags' anchors). */
    eachAll(fn) { for (const sh of byId.values()) if (sh.group.visible) fn(sh.id, sh); },
    /** v4: contact `id`'s ship record (read-only use: x, z, heading, heave, K, vis, fade, sinking, sink, sunk), or null. */
    ship(id) { return byId.get(id) || null; },
    /** A hit on contact `id` at world (x, y, z) of `kind` ("hull" | "mast" | "crew"): splinters, sail tears. */
    impact(id, p, kind = "hull", dmg = 6) {
      const sh = byId.get(id);
      if (!sh) return;
      const at = _v.set(+p.x || sh.x, Number.isFinite(+p.y) ? +p.y : WATER_Y + sh.K.c.h0 * 0.6, +p.z || sh.z);
      if (kind === "mast" || kind === "sails") { tear(sh, 1 + Math.round(dmg / 6)); fx.splinters(at.clone(), { count: 14, scale: 0.9 }); }
      else { fx.splinters(at.clone(), { count: 22 + Math.round(dmg * 2.4), scale: 1.3 }); fx.sparks(at.clone(), { count: 14, speed: 4 }); }
      sh.recoilV += (Math.random() - 0.5) * 0.35 * Math.min(2, dmg / 6);
    },
    /** A fire started or went out on contact `id` at world (x, z). */
    fire(id, p, stage) {
      const sh = byId.get(id);
      if (!sh) return;
      if (stage === "out") {
        const f = sh.fires.find((x) => !x.out);
        if (f) { f.out = true; toWorld(sh, f.local, _v); fx.steam?.(_v.clone()); }
        return;
      }
      sh.body.updateMatrixWorld();
      const local = Number.isFinite(+p.x) ? sh.body.worldToLocal(_v.set(+p.x, WATER_Y + sh.K.c.h0 + 0.5, +p.z)) : sh.K.fireSpots[sh.fires.length % sh.K.fireSpots.length].clone();
      local.x = clamp(local.x, -sh.K.c.B * 0.7, sh.K.c.B * 0.7);
      local.z = clamp(local.z, -sh.K.c.L * 0.42, sh.K.c.L * 0.42);
      local.y = sh.K.S.deck(sh.K.S.tOf(local.z)) + 0.2;
      sh.fires.push({ local: local.clone(), out: false });
    },
    sink(id) { const sh = byId.get(id); if (sh) startSinking(sh); },
    surrender(id) { const sh = byId.get(id); if (sh) sh.surrender = true; },
    /** The weak point under a ray (world), or null: {contactId, weakId, dist}. */
    pickWeak(ray) {
      let best = null;
      for (const w of weakList) {
        const d = ray.distanceToPoint(w.pos);
        const along = _v.copy(w.pos).sub(ray.origin).dot(ray.direction);
        if (along <= 0) continue;
        const tol = Math.max(1.6, along * 0.02);
        if (d < tol && (!best || along < best.dist)) best = { contactId: w.contactId, weakId: w.weakId, dist: along };
      }
      return best;
    },
    /** The ship under a ray, or null: {id, dist}. */
    pickShip(ray) {
      let best = null;
      for (const sh of byId.values()) {
        if (!sh.group.visible || sh.vis < 0.3) continue;
        const cl = sh.K.c;
        const [hx, hz] = headingVec(sh.heading);
        const a = _v.set(sh.x - hx * cl.L / 2, WATER_Y + cl.h0 * 0.6 + 2, sh.z - hz * cl.L / 2);
        const b = _w.set(sh.x + hx * cl.L / 2, WATER_Y + cl.h0 * 0.6 + 2, sh.z + hz * cl.L / 2);
        const segPt = new THREE.Vector3(), rayPt = new THREE.Vector3();
        const d2 = ray.distanceSqToSegment(a, b, rayPt, segPt);
        const along = rayPt.clone().sub(ray.origin).length();
        const tol = Math.max(cl.B * 1.4 + 3, along * 0.012);
        if (d2 < tol * tol && (!best || along < best.dist)) best = { id: sh.id, dist: along };
      }
      return best;
    },
    /** Highlight a hovered weak point ({contactId, weakId} or null). */
    hoverWeak(w) { hoverWeak = w || null; },
    stats() {
      let draws = 0;
      for (const sh of byId.values()) if (sh.group.visible) sh.body.traverse((o) => { if ((o.isMesh || o.isLine) && o.visible) draws++; });
      return { ships: byId.size, built: Object.values(pool).reduce((n, l) => n + l.length, 0), weak: weakList.length, queue: queue.length, draws };
    },
    /** For the compile warm-up: every pooled ship shown (with its ports open, a mast down, the white flag). */
    warmShow(on) {
      for (const list of Object.values(pool)) for (const sh of list) {
        if (on) { sh.group.visible = true; sh.glowMat.uniforms.uGlow.value.set(1, 1); for (const m of [sh.ropes, sh.guns, sh.flag]) m.visible = true; }
        else if (!sh.busy) { sh.group.visible = false; sh.glowMat.uniforms.uGlow.value.set(0, 0); }
      }
      weakGeo.instanceCount = on ? 1 : weakList.length;
      foamMesh.count = on ? Math.max(1, foamMesh.count) : foamMesh.count;
      crewMesh.count = on ? Math.max(1, crewMesh.count) : crewMesh.count;
      ghostMesh.count = on ? Math.max(1, ghostMesh.count) : ghostMesh.count;
    },
    reset() {
      for (const sh of [...byId.values()]) release(sh);
      queue.length = 0;
      weakList.length = 0; weakGeo.instanceCount = 0;
      foamMesh.count = 0;
      crewMesh.count = 0; ghostMesh.count = 0;
      lampGeo.setDrawRange(0, 0);
      for (const l of shipLights) l.intensity = 0;
      flashK = 0; flashLight.intensity = 0;
    },
    dispose() {
      root.removeFromParent();
      for (const l of shipLights) l.removeFromParent();
      flashLight.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
}
