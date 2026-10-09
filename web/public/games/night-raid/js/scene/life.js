// Rexmaw Raids: the bay's life and air. Gulls wheeling over the ship and the islands by day; fog
// banks rolling over the water by night (thicker on the night missions). Two draws, built once.
//
//   gulls      one instanced draw: a body and two wings that flap in the vertex shader; each
//              gull circles an anchor (the Rexmaw, an island) at its own height and pace, glides
//              and flaps in turns. Day only.
//   fog banks  one instanced draw of soft, upright billboards (yaw-only: they stand on the sea)
//              on a 1.4 km tile that wraps round the camera (world-anchored, so the ship sails
//              through them); their noise drifts downwind; they thin out near the camera so the
//              lens never sits in a wall. setBanks(0..1); auto from the night's visibility.

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";

const clamp = THREE.MathUtils.clamp;
const GULLS = 16;
const BANKS = 64;
const TILE = 1400;
const MOON_MIST = new THREE.Color(0.2, 0.25, 0.32);

export function createLife(R, { water } = {}) {
  const root = new THREE.Group();
  root.name = "life";
  R.scene.add(root);
  const wu = water?.uniforms || {};
  const time = wu.uTime || { value: 0 };

  // ---- Gulls ----
  const gullGeo = (() => {
    const pos = [], wing = [];
    const tri = (a, b, c, wa, wb, wc) => { pos.push(...a, ...b, ...c); wing.push(wa, wb, wc); };
    // Body (a thin diamond), two wings (inner and outer panels; outer flaps more), a tail.
    tri([0, 0, 0.32], [0.06, 0, -0.1], [-0.06, 0, -0.1], 0, 0, 0);
    tri([0, 0, 0.32], [0, 0.07, 0], [0.06, 0, -0.1], 0, 0, 0);
    tri([0, 0, 0.32], [-0.06, 0, -0.1], [0, 0.07, 0], 0, 0, 0);
    for (const s of [1, -1]) {
      tri([0.04 * s, 0.02, 0.12], [0.42 * s, 0.05, 0.02], [0.05 * s, 0.02, -0.06], 0.1 * s, 0.6 * s, 0.1 * s);
      tri([0.42 * s, 0.05, 0.02], [0.82 * s, 0.0, -0.12], [0.36 * s, 0.03, -0.08], 0.6 * s, 1.0 * s, 0.6 * s);
    }
    tri([0, 0, -0.1], [0.1, 0, -0.26], [-0.1, 0, -0.26], 0, 0, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 1));
    g.computeVertexNormals();
    return g;
  })();
  const flapAttr = new THREE.InstancedBufferAttribute(new Float32Array(GULLS * 2), 2).setUsage(THREE.DynamicDrawUsage);
  gullGeo.setAttribute("aFlap", flapAttr);
  const gullMat = new THREE.MeshStandardMaterial({ name: "rr-gull", color: "#f2f0ea", roughness: 0.8, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  gullMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aWing;\nattribute vec2 aFlap;\nuniform float uTime;\nvarying float vNrWing;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vNrWing = abs(aWing);
        float nrA = sin(uTime * aFlap.x + aFlap.y) * 0.75 * step(0.01, aFlap.x) + 0.18;
        transformed.y += abs(aWing) * nrA * 0.7 * (0.4 + 0.6 * abs(aWing));`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vNrWing;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.25, smoothstep(0.85, 1.0, vNrWing));");
  };
  gullMat.customProgramCacheKey = () => "rr-gull";
  const gulls = new THREE.InstancedMesh(gullGeo, gullMat, GULLS);
  gulls.name = "gulls";
  gulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gulls.frustumCulled = false;
  gulls.count = 0;
  root.add(gulls);
  const birds = Array.from({ length: GULLS }, (_, i) => ({
    r: 24 + Math.random() * 60, h: 12 + Math.random() * 22, w: (0.18 + Math.random() * 0.22) * (Math.random() < 0.5 ? -1 : 1),
    a: Math.random() * 6.28, anchor: i < 9 ? "ship" : "isle", isle: 0, flapT: Math.random() * 4, flap: 0, scale: 1.4 + Math.random() * 0.5, bob: Math.random() * 6,
  }));
  let isles = [];

  // ---- Fog banks ----
  const bankGeo = new THREE.PlaneGeometry(1, 1);
  bankGeo.translate(0, 0.5, 0);
  const bankAttr = new THREE.InstancedBufferAttribute(new Float32Array(BANKS * 4), 4);
  bankGeo.setAttribute("aBank", bankAttr);
  const denAttr = new THREE.InstancedBufferAttribute(new Float32Array(BANKS).fill(1), 1);
  bankGeo.setAttribute("aDen", denAttr);
  const bankU = {
    uTime: time, uAmount: { value: 0 }, uColor: { value: new THREE.Color() }, uCenter: { value: new THREE.Vector2() },
    uFogDensity: wu.uFogDensity || { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, uPlaced: { value: 0 },
  };
  const bankMat = new THREE.ShaderMaterial({
    name: "RexmawFogBanks", uniforms: bankU, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec4 aBank;         // x, z (tile-local, or world when placed), width, seed
      attribute float aDen;
      uniform vec2 uCenter, uWind; uniform float uTime, uPlaced;
      varying vec2 vUv; varying float vSeed; varying float vNear; varying float vDist; varying float vH; varying float vDen;
      void main() {
        vUv = uv; vSeed = aBank.w; vDen = aDen;
        // Placed (the mission's fog banks): world spots that wander a little. Else wrapped on a tile round the camera, drifting downwind.
        vec2 rel;
        vec3 c;
        if (uPlaced > 0.5) {
          vec2 p = aBank.xy + vec2(sin(uTime * 0.05 + aBank.w * 20.0), cos(uTime * 0.04 + aBank.w * 13.0)) * 18.0;
          rel = p - uCenter;
          c = vec3(p.x, ${WATER_Y.toFixed(2)} - 1.0, p.y);
        } else {
          vec2 p = aBank.xy + uWind * uTime * 2.2;
          rel = mod(p - uCenter + ${(TILE / 2).toFixed(1)}, ${TILE.toFixed(1)}) - ${(TILE / 2).toFixed(1)};
          c = vec3(uCenter.x + rel.x, ${WATER_Y.toFixed(2)} - 1.0, uCenter.y + rel.y);
        }
        // Upright, turned to face the camera about Y only.
        vec3 toCam = cameraPosition - c; toCam.y = 0.0;
        float l = max(length(toCam), 1e-3);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x) / l;
        float w = aBank.z, h = w * (0.2 + 0.08 * fract(aBank.w * 7.3));
        vec3 wp = c + right * position.x * w + vec3(0.0, position.y * h, 0.0);
        vH = position.y;
        vNear = smoothstep(18.0, 70.0, l);
        float edge = uPlaced > 0.5 ? 1.0 - smoothstep(1100.0, 1500.0, length(rel)) : 1.0 - smoothstep(${(TILE * 0.36).toFixed(1)}, ${(TILE * 0.5).toFixed(1)}, max(abs(rel.x), abs(rel.y)));
        vNear *= edge;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAmount, uFogDensity; uniform vec3 uColor;
      varying vec2 vUv; varying float vSeed; varying float vNear; varying float vDist; varying float vH; varying float vDen;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * n2(p); p = p * 2.02 + 3.1; a *= 0.5; } return s; }
      void main() {
        vec2 q = vUv * vec2(3.0, 1.2) + vec2(vSeed * 13.0 + uTime * 0.02, vSeed * 5.0);
        float n = fbm(q) * 0.75 + fbm(q * 2.7 - uTime * 0.03) * 0.35;
        float sideFade = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        float body = smoothstep(1.0, 0.25, vH) * smoothstep(0.0, 0.06, vH);
        float a = smoothstep(0.3, 0.8, n) * sideFade * body * uAmount * vNear * 0.75 * clamp(vDen, 0.0, 1.5);
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * (0.9 + 0.25 * n), a);
      }`,
  });
  const banks = new THREE.InstancedMesh(bankGeo, bankMat, BANKS);
  banks.name = "fog-banks";
  banks.frustumCulled = false;
  banks.renderOrder = 9;
  banks.layers.set(LAYERS.NOREFLECT);
  {
    let s = 0x5eed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < BANKS; i++) bankAttr.setXYZW(i, (rnd() - 0.5) * TILE, (rnd() - 0.5) * TILE, 90 + rnd() * 140, rnd());
    const id = new THREE.Matrix4();
    for (let i = 0; i < BANKS; i++) banks.setMatrixAt(i, id);
  }
  banks.count = 0;
  root.add(banks);

  // ---- State ----
  const L = { day: 0, dayT: 0, banks: 0, bankT: 0, auto: true, placed: false };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _cam = new THREE.Vector3();

  function applyTier(q) { banks.count = L.banks > 0.01 ? (q.tier === "low" ? 18 : q.tier === "medium" ? 30 : BANKS) : 0; }

  function update(dt, { ship = null, wind = null } = {}) {
    const d = Math.min(0.1, Math.max(0, dt));
    L.day += (L.dayT - L.day) * Math.min(1, d * 0.8);
    R.camera.getWorldPosition(_cam);
    // Gulls: by day, round the ship and the islands.
    const show = L.day > 0.3;
    gulls.count = show ? GULLS : 0;
    if (show) {
      const sx = ship ? +ship.x || 0 : _cam.x, sz = ship ? +ship.z || 0 : _cam.z;
      for (let i = 0; i < GULLS; i++) {
        const b = birds[i];
        b.a += b.w * d;
        b.flapT -= d;
        if (b.flapT <= 0) { b.flap = b.flap ? 0 : 1; b.flapT = b.flap ? 1 + Math.random() * 2 : 2 + Math.random() * 4; }
        let ax = sx, az = sz;
        if (b.anchor === "isle" && isles.length) { const is = isles[i % isles.length]; ax = is.x; az = is.z; }
        const x = ax + Math.cos(b.a) * b.r, z = az + Math.sin(b.a) * b.r;
        const y = WATER_Y + b.h + Math.sin(R.time * 0.6 + b.bob) * 1.2;
        // Facing along the circle, banking into the turn.
        const yaw = Math.atan2(-Math.sin(b.a) * Math.sign(b.w), Math.cos(b.a) * Math.sign(b.w));
        _e.set(0, yaw, -0.35 * Math.sign(b.w), "YXZ");
        _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.setScalar(b.scale));
        gulls.setMatrixAt(i, _m);
        flapAttr.setXY(i, b.flap ? 9 + (i % 3) : 0, i * 1.7);
      }
      gulls.instanceMatrix.needsUpdate = true;
      flapAttr.needsUpdate = true;
    }
    // Fog banks: the mission's (placed) by night; else from the visibility (the core's), or as set.
    if (L.auto) {
      const vis = R.atmos?.visibility || 900;
      L.bankT = L.day > 0.5 ? 0 : L.placed ? 1 : clamp((1000 - vis) / 650, 0, 1);
    }
    L.banks += (L.bankT - L.banks) * Math.min(1, d * 0.5);
    bankU.uAmount.value = L.banks;
    bankU.uCenter.value.set(_cam.x, _cam.z);
    // Moonlit mist: paler than the air it hangs in, so a bank stands out as a wall of grey before you're in it.
    if (R.scene.fog) bankU.uColor.value.copy(R.scene.fog.color).lerp(MOON_MIST, 0.55).multiplyScalar(0.7 + 0.6 * (R.sky?.moonLight || 0));
    if (wind) { const a = ((+wind.dirDeg || 0) + 180) * Math.PI / 180; bankU.uWind.value.set(-Math.sin(a), Math.cos(a)); }
    applyTier(R.quality);
  }

  return {
    root, gulls, banks,
    update,
    setDay(v, seconds = 2) { L.dayT = clamp(+v || 0, 0, 1); if (!(seconds > 0)) L.day = L.dayT; },
    setIslands(list = []) { isles = (list || []).filter((i) => Number.isFinite(+i.x)).map((i) => ({ x: +i.x, z: +i.z })); },
    /**
     * The mission's fog banks (world.fog / state.fog.banks: [{x, z, r, density}]): the billboards gather in them.
     * An empty list goes back to the camera-wrapped tile driven by the visibility.
     */
    setFogBanks(list = []) {
      const banksIn = (list || []).filter((b) => Number.isFinite(+b.x) && +b.r > 0);
      L.placed = banksIn.length > 0;
      bankU.uPlaced.value = L.placed ? 1 : 0;
      let s = 0x0f06;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      if (!L.placed) {
        for (let i = 0; i < BANKS; i++) { bankAttr.setXYZW(i, (rnd() - 0.5) * TILE, (rnd() - 0.5) * TILE, 90 + rnd() * 140, rnd()); denAttr.setX(i, 1); }
      } else {
        const total = banksIn.reduce((n, b) => n + +b.r, 0) || 1;
        let i = 0;
        for (const b of banksIn) {
          const n = Math.max(2, Math.round(BANKS * (+b.r / total)));
          for (let k = 0; k < n && i < BANKS; k++, i++) {
            const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * +b.r * 0.85;
            bankAttr.setXYZW(i, +b.x + Math.cos(a) * rr, +b.z + Math.sin(a) * rr, clamp(+b.r * (0.5 + rnd() * 0.5), 60, 220), rnd());
            denAttr.setX(i, clamp(Number.isFinite(+b.density) ? +b.density : 0.8, 0.2, 1.4));
          }
        }
        for (; i < BANKS; i++) denAttr.setX(i, 0);
      }
      bankAttr.needsUpdate = true; denAttr.needsUpdate = true;
    },
    warmShow(on) { gulls.count = on ? GULLS : 0; banks.count = on ? BANKS : 0; if (on) bankU.uAmount.value = 0.001; },
    stats: () => ({ gulls: gulls.count, banks: banks.count, bankAmount: L.banks }),
    dispose() { root.removeFromParent(); gullGeo.dispose(); gullMat.dispose(); bankGeo.dispose(); bankMat.dispose(); },
  };
}
