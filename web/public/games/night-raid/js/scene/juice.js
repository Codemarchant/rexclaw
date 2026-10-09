// Rexmaw Raids: speed. Streaks of wind and spray rushing past the lens at the full-sail sprint
// (one additive line draw riding the camera), and the slow-mo hook (world.slowmo) on the
// post chain's clock: a ship's final volley, her sinking.

import * as THREE from "three";
import { LAYERS } from "./blocking.js";

const N = 90;
const clamp = THREE.MathUtils.clamp;

export function createSpeedLines(R) {
  const pos = new Float32Array(N * 2 * 3), info = new Float32Array(N * 2 * 2);
  const seeds = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, r: 0.28 + Math.random() * 0.9, z: Math.random(), len: 0.5 + Math.random() * 1.2, sp: 0.6 + Math.random() * 0.9 }));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aInfo", new THREE.BufferAttribute(info, 2).setUsage(THREE.DynamicDrawUsage));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    name: "RexmawSpeedLines", transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uK: { value: 0 }, uDay: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec2 aInfo;   // end (0 tail, 1 head), fade
      varying vec2 vI;
      void main() { vI = aInfo; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uK, uDay;
      varying vec2 vI;
      void main() {
        float a = vI.x * vI.y * uK;
        if (a < 0.003) discard;
        gl_FragColor = vec4(mix(vec3(0.75, 0.85, 0.95), vec3(1.0), uDay) * a * mix(0.55, 0.35, uDay), 1.0);
      }`,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = "speed-lines";
  lines.frustumCulled = false;
  lines.renderOrder = 30;
  lines.layers.set(LAYERS.NOREFLECT);
  R.camera.add(lines);
  let k = 0;

  function update(dt, { sprint = 0, speed = 0 } = {}) {
    const target = clamp(sprint, 0, 1) * clamp((speed - 12) / 6, 0, 1);
    k += (target - k) * Math.min(1, dt * (target > k ? 2.5 : 1.5));
    mat.uniforms.uK.value = R.motion === "reduced" ? 0 : k;
    mat.uniforms.uDay.value = R.atmos?.day || 0;
    lines.visible = k > 0.01;
    if (!lines.visible) return;
    // Camera space: streaks on a cone round the view axis, rushing from ahead (−z) past the lens (+z).
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      s.z += dt * s.sp * (1.4 + 1.2 * k);
      if (s.z > 1) { s.z -= 1; s.a = Math.random() * Math.PI * 2; s.r = 0.28 + Math.random() * 0.9; }
      const z0 = -6 + s.z * 7.5;
      const rr = s.r * (1.2 + (z0 + 6) * 0.25);
      const x = Math.cos(s.a) * rr * R.size.aspect * 0.8, y = Math.sin(s.a) * rr * 0.8;
      const fade = Math.sin(s.z * Math.PI);
      pos.set([x, y, z0 - s.len, x * 1.04, y * 1.04, z0], i * 6);
      info.set([0, fade, 1, fade], i * 4);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aInfo.needsUpdate = true;
  }

  return {
    update,
    get amount() { return k; },
    warmShow(on) { lines.visible = on || k > 0.01; if (on) mat.uniforms.uK.value = 0.001; },
    dispose() { lines.removeFromParent(); geo.dispose(); mat.dispose(); },
  };
}
