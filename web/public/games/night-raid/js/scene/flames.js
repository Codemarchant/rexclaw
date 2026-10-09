// Night Raid: fires. Every fire in the bay (a burning deck aboard the
// Rexmaw or an enemy, a fire ship lit for her ram, a silenced fort) is a
// flame from one pool, drawn in ONE instanced draw: a camera-facing tongue
// of fire (a flame shader: licking, flickering, white-hot at the root), HDR
// so it blooms. Each frame the owners call begin(), add(worldPos, {size,
// seed}) for every fire they want seen, then end(): the pool is refilled, a
// little smoke and a few embers rise from each fire (through fx), and the
// two pooled fire lights go to the biggest fires near the camera.

import * as THREE from "three";
import { LAYERS } from "./blocking.js";

const CAP = 96;

/**
 * @param {object} R  the render context
 * @param {{fx: object, water: object}} deps
 */
export function createFlames(R, { fx, water }) {
  const quad = new THREE.PlaneGeometry(1, 1.6);
  quad.translate(0, 0.62, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  const aAt = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aK = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aAt", aAt);
  geo.setAttribute("aK", aK);
  geo.instanceCount = 0;
  const wu = water?.uniforms || {};
  const mat = new THREE.ShaderMaterial({
    name: "NightRaidFlames", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 }, uFogDensity: wu.uFogDensity || { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec4 aAt;     // world x, y, z, size (m)
      attribute vec2 aK;      // intensity, seed
      uniform float uTime, uFogDensity;
      varying vec2 vUv; varying float vI, vSeed;
      void main() {
        vUv = uv;
        vSeed = aK.y;
        vec4 mv = modelViewMatrix * vec4(aAt.xyz, 1.0);
        float d = max(-mv.z, 0.5);
        float fd = uFogDensity * d * 0.55;
        vI = aK.x * exp(-fd * fd);
        float breathe = 1.0 + 0.12 * sin(uTime * (3.0 + aK.y * 2.0) + aK.y * 30.0);
        mv.xy += position.xy * aAt.w * breathe;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv; varying float vI, vSeed;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;                 // x across, y up (-1 root .. 1 tip)
        float t = uTime * (1.6 + vSeed * 0.5);
        float lick = n(vec2(p.x * 2.3 + vSeed * 9.0, p.y * 2.0 - t * 2.4)) * 0.6 + n(vec2(p.x * 5.1 - vSeed * 4.0, p.y * 4.3 - t * 3.7)) * 0.4;
        float y01 = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
        float w = 0.62 * (1.0 - y01 * 0.85) * sqrt(max(y01 + 0.08, 0.0));
        float x = p.x + (lick - 0.5) * 0.55 * y01;
        float d = abs(x) / max(w, 1e-3);
        float body = smoothstep(1.0, 0.45, d) * smoothstep(1.0, 0.55, y01 + (lick - 0.5) * 0.45) * smoothstep(-1.0, -0.82, p.y);
        float core = smoothstep(0.55, 0.0, d) * smoothstep(0.55, 0.0, y01) * smoothstep(-1.0, -0.85, p.y);
        vec3 col = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.86, 0.5), core) * (body * 1.4 + core * 1.6);
        gl_FragColor = vec4(col * vI * 2.6, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  mesh.layers.set(LAYERS.FX);
  R.scene.add(mesh);

  const lights = Array.from({ length: 2 }, (_, i) => {
    const l = new THREE.PointLight("#ff7a2a", 0, 34, 2);
    l.name = `fire-light-${i}`;
    R.scene.add(l);
    return l;
  });

  const list = [];          // this frame's fires: {x, y, z, size, seed, i, smoke}
  let time = 0, emitAcc = 0;
  const _cam = new THREE.Vector3(), _v = new THREE.Vector3();
  const off = R.onFrame((dt) => { time += dt; mat.uniforms.uTime.value = time; }, 26);

  return {
    /** Start a frame's list. */
    begin() { list.length = 0; },
    /**
     * One fire this frame at `pos` (world).
     * @param {THREE.Vector3} pos @param {{size?: number, seed?: number, intensity?: number, smoke?: boolean}} [o]
     */
    add(pos, { size = 2, seed = 0, intensity = 1, smoke = true } = {}) {
      if (list.length >= CAP || !pos) return;
      list.push({ x: pos.x, y: pos.y, z: pos.z, size, seed, i: intensity, smoke });
    },
    /** Push the list to the GPU, puff smoke and embers, place the fire lights. */
    end(dt) {
      const n = list.length;
      for (let k = 0; k < n; k++) {
        const f = list[k];
        aAt.setXYZW(k, f.x, f.y, f.z, f.size);
        aK.setXY(k, f.i, (f.seed % 1 + 1) % 1);
      }
      geo.instanceCount = n;
      if (n) { aAt.needsUpdate = true; aK.needsUpdate = true; }
      // Smoke and embers, a budget per second shared by every fire.
      emitAcc += (dt || 0) * Math.min(40, n * 3);
      while (emitAcc >= 1 && n) {
        emitAcc -= 1;
        const f = list[Math.floor(Math.random() * n)];
        _v.set(f.x, f.y + f.size * 1.2, f.z);
        if (f.smoke) fx?.steam?.(_v);
        fx?.embers?.(_v, { count: 2 });
      }
      if (!n) emitAcc = 0;
      // The fire lights: the biggest fires near the camera.
      R.camera.getWorldPosition(_cam);
      const ranked = list.map((f) => ({ f, s: f.size * f.i / Math.max(20, Math.hypot(f.x - _cam.x, f.z - _cam.z)) })).sort((a, b) => b.s - a.s);
      lights.forEach((l, i) => {
        const r = ranked[i];
        if (!r) { l.intensity = Math.max(0, l.intensity - (dt || 0) * 400); return; }
        l.position.set(r.f.x, r.f.y + r.f.size * 0.8, r.f.z);
        // By day the sun swamps firelight: much weaker (at full strength it painted a white hull orange).
        l.intensity = (45 + 25 * Math.sin(time * 13 + i) * Math.sin(time * 7.3)) * Math.min(2.5, r.f.size / 2) * r.f.i * (1 - 0.8 * (R.atmos?.day || 0));
      });
    },
    /** For the compile warm-up. */
    warmShow(on) { geo.instanceCount = on ? Math.max(1, geo.instanceCount) : list.length; },
    get count() { return list.length; },
    reset() { list.length = 0; geo.instanceCount = 0; for (const l of lights) l.intensity = 0; },
    dispose() {
      off();
      mesh.removeFromParent();
      for (const l of lights) l.removeFromParent();
      geo.dispose(); quad.dispose(); mat.dispose();
    },
  };
}
