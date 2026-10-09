// Night Raid (from Night Helm): the helm and what the Captain sees of the ship's state.
//
//   the wheel        a varnished eight-spoke ship's wheel with a brass hub at
//                    the GLB's helm (ship.js drops the baked one); it turns with
//                    the Captain's wheel input (1.1 turns at hard over; to
//                    starboard = clockwise from behind), sprung so a keypress
//                    spins it rather than snapping it
//   the cargo        twelve crates lashed amidships (three by two, two tiers);
//                    each one lost goes over the side as a floating crate (fx)
//   hull damage      six stove-in places along the rails, shown one per lost
//                    hull point on the side that took the blow
//   the lantern beam a signal lantern on the forecastle head (hold Q): a
//                    SpotLight (always present, 0 when off: no recompiles) and
//                    a soft cone you see in the fog
//
// All of it rides R.shipSpace.

import * as THREE from "three";
import { B, LAYERS } from "./blocking.js";
import { mergeParts, seeded } from "./util.js";

const DEG = Math.PI / 180;
const TURNS = 1.1;                     // wheel turns at hard over
const LANTERN_POS = [0, 4.35, 18.2];   // the forecastle head, just abaft the stem
const LANTERN_AIM = [0, -1.0, 75];

/** Six places along the rails that can be stove in (ship space; x < 0 is starboard). */
const DAMAGE_SPOTS = [
  [-4.08, 1.12, 1.5, 0.0], [4.08, 1.12, 3.4, 0.0], [-3.95, 1.25, 10.5, 0.15],
  [3.9, 1.32, 12.2, -0.15], [-3.92, 3.72, -9.6, 0.0], [3.92, 3.72, -7.8, 0.0],
];

/**
 * Build the helm, the deck cargo, the damage and the lantern beam.
 * @param {object} R  the render context
 * @param {{fx?: object}} [opts]
 */
export function createHelm(R, { fx = null } = {}) {
  const ship = R.shipSpace;
  const root = new THREE.Group();
  root.name = "helm";
  ship.add(root);
  const disposables = [];

  // ---- The wheel ----
  const varnish = new THREE.MeshStandardMaterial({ name: "nh-wheel-varnish", color: "#6a3f20", roughness: 0.32, metalness: 0, envMapIntensity: 0.7 });
  const brass = new THREE.MeshStandardMaterial({ name: "nh-wheel-brass", color: "#c99a4a", roughness: 0.28, metalness: 1, envMapIntensity: 1.0 });
  disposables.push(varnish, brass);
  const wheel = new THREE.Group();
  wheel.name = "wheel";
  wheel.position.fromArray(B.WHEEL.pos);
  root.add(wheel);
  {
    const wood = [];
    wood.push(new THREE.TorusGeometry(0.62, 0.04, 10, 56));
    wood.push(new THREE.TorusGeometry(0.5, 0.022, 8, 48));
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      const spoke = new THREE.CylinderGeometry(0.018, 0.024, 0.54, 8);
      spoke.translate(0, 0.37, 0);
      spoke.rotateZ(a);
      wood.push(spoke);
      const handle = new THREE.LatheGeometry([[0.0, 0], [0.022, 0.0], [0.03, 0.05], [0.02, 0.1], [0.032, 0.15], [0.026, 0.19], [0.0, 0.205]].map(([r, y]) => new THREE.Vector2(r, y)), 8);
      handle.translate(0, 0.64, 0);
      handle.rotateZ(a);
      wood.push(handle);
    }
    const w = new THREE.Mesh(mergeParts(wood), varnish);
    const hubG = new THREE.CylinderGeometry(0.11, 0.11, 0.14, 20);
    hubG.rotateX(Math.PI / 2);
    const capG = new THREE.CylinderGeometry(0.06, 0.08, 0.05, 16);
    capG.rotateX(Math.PI / 2);
    capG.translate(0, 0, -0.095);
    const hub = new THREE.Mesh(mergeParts([hubG, capG]), brass);
    for (const m of [w, hub]) { m.castShadow = true; m.receiveShadow = true; wheel.add(m); disposables.push(m.geometry); }
  }
  const wheelSpring = { x: 0, v: 0 };

  // ---- The cargo ----
  const crateTex = crateTexture();
  const crateMat = new THREE.MeshStandardMaterial({ name: "nh-cargo-crate", color: "#c9a27a", map: crateTex, roughness: 0.8, metalness: 0, envMapIntensity: 0.35 });
  const crateGeo = new THREE.BoxGeometry(B.CARGO.size, B.CARGO.size, B.CARGO.size);
  const CARGO_MAX = 12;
  const cargo = new THREE.InstancedMesh(crateGeo, crateMat, CARGO_MAX);
  cargo.name = "cargo";
  cargo.castShadow = true;
  cargo.receiveShadow = true;
  cargo.layers.set(LAYERS.NOREFLECT);
  root.add(cargo);
  disposables.push(crateGeo, crateMat, crateTex);
  const slots = [];
  {
    const [cx, cy, cz] = B.CARGO.center, s = B.CARGO.size + B.CARGO.gap;
    const rnd = seeded(31);
    // Bottom tier first, so the count trims the top tier away first.
    for (let tier = 0; tier < 2; tier++) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const p = new THREE.Vector3(cx + (col - 1) * s, cy + B.CARGO.size / 2 + tier * B.CARGO.size, cz + (row - 0.5) * s);
          slots.push({ p, yaw: (rnd() - 0.5) * 0.12 });
        }
      }
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    slots.forEach((sl, i) => cargo.setMatrixAt(i, m.compose(sl.p, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sl.yaw), new THREE.Vector3(1, 1, 1))));
    cargo.instanceMatrix.needsUpdate = true;
  }
  let cargoShown = CARGO_MAX;

  // ---- Hull damage ----
  const raw = new THREE.MeshStandardMaterial({ name: "nh-splinter", color: "#b48a5e", roughness: 0.9, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ name: "nh-gash", color: "#120c08", roughness: 1, metalness: 0 });
  disposables.push(raw, dark);
  const damage = DAMAGE_SPOTS.map(([x, y, z, tilt], i) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.z = tilt;
    const rnd = seeded(101 + i);
    const gash = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 1.5), dark);
    gash.position.y = -0.2;
    g.add(gash);
    const parts = [];
    for (let k = 0; k < 9; k++) {
      const len = 0.35 + rnd() * 0.7;
      const s = new THREE.BoxGeometry(0.05 + rnd() * 0.05, len, 0.08 + rnd() * 0.08);
      s.translate(0, len / 2, 0);
      s.rotateX((rnd() - 0.5) * 1.2);
      s.rotateZ((rnd() - 0.5) * 1.6 + Math.sign(x) * 0.5);
      s.translate((rnd() - 0.5) * 0.3, -0.05, (rnd() - 0.5) * 1.4);
      parts.push(s);
    }
    const spl = new THREE.Mesh(mergeParts(parts), raw);
    g.add(spl);
    disposables.push(gash.geometry, spl.geometry);
    g.visible = false;
    g.scale.setScalar(0.001);
    root.add(g);
    return { g, used: false, side: Math.sign(x), t: 0 };
  });

  // ---- The lantern beam ----
  const spot = new THREE.SpotLight(0xffe0b0, 0, 170, 10 * DEG, 0.55, 1.4);
  spot.name = "lantern-beam";
  spot.position.fromArray(LANTERN_POS);
  spot.castShadow = false;
  const spotTarget = new THREE.Object3D();
  spotTarget.position.fromArray(LANTERN_AIM);
  spot.target = spotTarget;
  root.add(spot, spotTarget);
  const coneU = { uI: { value: 0 }, uFog: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color("#ffe6bf") } };
  const CONE_LEN = 90;
  const coneGeo = new THREE.CylinderGeometry(0.25, Math.tan(10 * DEG) * CONE_LEN, CONE_LEN, 28, 1, true);
  coneGeo.translate(0, -CONE_LEN / 2, 0);
  coneGeo.rotateX(-Math.PI / 2);                 // apex at the origin, out along +Z
  const coneMat = new THREE.ShaderMaterial({
    name: "nh-lantern-cone", uniforms: coneU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      varying float vAlong;
      varying vec3 vW, vO, vD;
      void main() {
        vAlong = clamp(position.z / ${CONE_LEN.toFixed(1)}, 0.0, 1.0);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vD = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uI, uFog, uTime;
      uniform vec3 uColor;
      varying float vAlong;
      varying vec3 vW, vO, vD;
      void main() {
        float al = clamp(vAlong, 0.0, 1.0);
        vec3 r = normalize(vW - cameraPosition);
        vec3 w0 = cameraPosition - vO;
        float b = dot(r, vD), d = dot(r, w0), e = dot(vD, w0);
        float den = max(1.0 - b * b, 1e-4);
        float sc = (b * e - d) / den, tc = (e - b * d) / den;
        float dist = length(w0 + r * sc - vD * tc);
        float rad = 0.25 + ${Math.tan(10 * DEG).toFixed(4)} * max(tc, 0.0);
        float q = dist / max(rad, 0.05);
        float edge = exp(-q * q * 2.5);
        float fall = (1.0 - al) * (1.0 - al) * smoothstep(0.0, 0.03, al);
        float shimmer = 0.85 + 0.15 * sin(uTime * 3.0 + al * 30.0);
        gl_FragColor = vec4(uColor * edge * fall * shimmer * uI * (0.25 + 1.6 * uFog), 1.0);
      }`,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.name = "lantern-cone";
  cone.position.fromArray(LANTERN_POS);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1),
    new THREE.Vector3().fromArray(LANTERN_AIM).sub(cone.position).normalize());   // ship space (lookAt would read world)
  cone.frustumCulled = false;
  cone.renderOrder = 6;
  cone.layers.set(LAYERS.FX);
  cone.visible = false;
  root.add(cone);
  disposables.push(coneGeo, coneMat);
  // The lantern itself: a small housing with a hot lens.
  const lensU = { uI: { value: 0 }, uSize: { value: 0.9 } };
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    name: "nh-lantern-lens", uniforms: lensU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      uniform float uSize; varying vec2 vUv;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform float uI; varying vec2 vUv;
      void main() { vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p); float v = exp(-r2 * 30.0) * 3.0 + exp(-r2 * 5.0) * 0.4;
        gl_FragColor = vec4(vec3(1.0, 0.88, 0.7) * v * uI * smoothstep(1.0, 0.7, r2), 1.0); }`,
  }));
  lens.position.fromArray(LANTERN_POS).add(new THREE.Vector3(0, 0, 0.25));
  lens.frustumCulled = false;
  lens.renderOrder = 7;
  lens.layers.set(LAYERS.FX);
  root.add(lens);
  disposables.push(lens.geometry, lens.material);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 14), brass);
  housing.rotation.x = Math.PI / 2;
  housing.position.fromArray(LANTERN_POS);
  root.add(housing);
  disposables.push(housing.geometry);
  let beamOn = false, beamK = 0;

  // ---- Frame ----
  const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  let wheelTarget = 0;
  const off = R.onFrame((dt, t) => {
    // The wheel: a stiff critically damped spring toward the input, so it spins, not snaps.
    const x = wheelSpring.x - wheelTarget;
    const e = Math.exp(-14 * dt), k = wheelSpring.v + 14 * x;
    wheelSpring.x = wheelTarget + (x + k * dt) * e;
    wheelSpring.v = (wheelSpring.v - k * 14 * dt) * e;
    wheel.rotation.z = wheelSpring.x * TURNS * 2 * Math.PI;

    // Damage reveals: a quick scale-in with a jolt.
    for (const d of damage) {
      if (!d.used || d.t >= 1) continue;
      d.t = Math.min(1, d.t + dt * 4);
      const s = d.t < 0.6 ? d.t / 0.6 * 1.15 : 1.15 - 0.15 * (d.t - 0.6) / 0.4;
      d.g.scale.setScalar(Math.max(0.001, s));
    }

    // The lantern beam.
    beamK += ((beamOn ? 1 : 0) - beamK) * (1 - Math.exp(-dt * (beamOn ? 10 : 6)));
    const flick = 0.95 + 0.05 * Math.sin(t * 17.0) * Math.sin(t * 5.3);
    spot.intensity = 9000 * beamK * flick;
    coneU.uI.value = 0.12 * beamK * flick;
    coneU.uFog.value = R.atmos?.fog || 0;
    coneU.uTime.value = t;
    lensU.uI.value = 2.5 * beamK * flick;
    cone.visible = beamK > 0.01;
  });

  const helm = {
    root, wheel, cargo, spot,
    /** World position of the lantern beam's lamp. */
    lanternWorld: (out = new THREE.Vector3()) => ship.localToWorld(out.fromArray(LANTERN_POS)),

    /**
     * The Captain's wheel (−1 hard port … +1 hard starboard). Pass the sim's
     * `wheel` (or `rudder / 35` when there is no separate input).
     * @param {number} v
     */
    setWheel(v) { wheelTarget = THREE.MathUtils.clamp(+v || 0, -1.2, 1.2); },

    /**
     * Crates aboard (0..12). Crates that go are thrown over the side toward
     * `side` (−1 starboard, +1 port) as floating crates.
     * @param {number} n
     * @param {{side?: number, shipVel?: {x: number, z: number}}} [opts]
     */
    setCargo(n, { side = 0, shipVel = null, quiet = false } = {}) {
      const next = THREE.MathUtils.clamp(Math.round(+n || 0), 0, CARGO_MAX);
      if (next < cargoShown && fx && !quiet) {
        for (let i = cargoShown - 1; i >= next; i--) {
          ship.updateMatrixWorld();
          cargo.getMatrixAt(i, _m);
          _v.setFromMatrixPosition(_m);
          ship.localToWorld(_v);
          // Thrown outboard: the side that was hit, else the low side.
          const s = side || (Math.random() < 0.5 ? -1 : 1);
          _q.copy(ship.quaternion);
          const sideW = new THREE.Vector3(s, 0, 0).applyQuaternion(_q).setY(0).normalize();
          fx.crateOverboard(_v, { n: 1, vx: shipVel?.x || 0, vz: shipVel?.z || 0, sideX: sideW.x, sideZ: sideW.z });
        }
      }
      cargoShown = next;
      cargo.count = next;
    },

    /**
     * Hull points lost so far (0..6): one stove-in place per point, on the
     * side that took the blow when there's one free there.
     * @param {number} lost
     * @param {{side?: number}} [opts]  −1 starboard, +1 port
     */
    setDamage(lost, { side = 0 } = {}) {
      const want = THREE.MathUtils.clamp(Math.round(+lost || 0), 0, damage.length);
      let used = damage.filter((d) => d.used).length;
      while (used < want) {
        const free = damage.filter((d) => !d.used);
        const pick = free.find((d) => side && d.side === side) || free[0];
        if (!pick) break;
        pick.used = true; pick.t = 0; pick.g.visible = true;
        used++;
      }
      if (want === 0) for (const d of damage) { d.used = false; d.t = 0; d.g.visible = false; d.g.scale.setScalar(0.001); }
    },

    /** The lantern beam on or off (hold Q). */
    lantern(on) { beamOn = !!on; },
    get lanternOn() { return beamOn; },

    /** A fresh voyage: all twelve crates aboard, the hull whole, the wheel amidships. */
    reset() {
      cargoShown = CARGO_MAX; cargo.count = CARGO_MAX;
      helm.setDamage(0);
      wheelTarget = 0; wheelSpring.x = 0; wheelSpring.v = 0;
      beamOn = false; beamK = 0;
    },

    /** For the compile warm-up: show everything that is ever shown. */
    warmShow(on) {
      for (const d of damage) d.g.visible = on || d.used;
      cone.visible = on || beamK > 0.01;
    },

    dispose() {
      off();
      root.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
  return helm;
}

/** A plank-sided crate face: boards, a frame and a stencilled mark. */
function crateTexture() {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#a07a52"; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 4; i++) {
    g.fillStyle = i % 2 ? "#946c46" : "#a8835a";
    g.fillRect(0, i * 32, 128, 31);
    g.fillStyle = "rgba(40,25,10,.5)"; g.fillRect(0, i * 32 + 31, 128, 1);
  }
  g.strokeStyle = "#5e4128"; g.lineWidth = 12; g.strokeRect(6, 6, 116, 116);
  g.beginPath(); g.moveTo(10, 10); g.lineTo(118, 118); g.stroke();
  g.fillStyle = "rgba(25,18,10,.55)"; g.font = "bold 22px Georgia, serif"; g.textAlign = "center";
  g.fillText("RX", 92, 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
