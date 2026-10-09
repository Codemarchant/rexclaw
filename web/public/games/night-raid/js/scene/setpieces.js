// Rexmaw Raids: the missions' set pieces that aren't a ship or an island.
//
//   patrol lanterns  navy patrols on night missions carry a hooded lantern in the bow that sweeps
//                    the water ahead: a cone of light through the fog (volumetric, fog-faded, with
//                    drifting motes in it) and a pool of light on the swell where it lands. When the
//                    patrol has spotted the Rexmaw (`spotted`/`alert`/state "approach"/"ram") the beam
//                    swings onto her and burns red-gold. Pool of four (fixed: nothing compiles later).
//                    Which contacts: `lantern`/`searchlight` true, or a navy patrol (`role:"patrol"`)
//                    by night. The core may steer it: `beamYaw` (deg, relative to her heading).
//   the Gloam        cloak and reappearance beats: a burst of teal mist and a ring across the sea
//                    when she comes back out of the fog.

import * as THREE from "three";
import { LAYERS, WATER_Y, headingVec } from "./blocking.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const BEAMS = 4;
const LEN = 150;

export function createSetPieces(R, { water, fleet, fx }) {
  const root = new THREE.Group();
  root.name = "setpieces";
  R.scene.add(root);
  const wu = water.uniforms;

  // ---- Beams: a cone along +Z from its apex, widening to 9 m ----
  const coneGeo = new THREE.CylinderGeometry(0.35, 9, LEN, 28, 1, true);
  coneGeo.translate(0, -LEN / 2, 0);
  coneGeo.rotateX(-Math.PI / 2);          // apex at the origin, out along +Z
  const beamMat = new THREE.ShaderMaterial({
    name: "RexmawPatrolBeam", transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uI: { value: 1 }, uColor: { value: new THREE.Color("#ffd9a0") }, uLen: { value: LEN }, uRad: { value: 9 } },
    vertexShader: /* glsl */`
      varying float vAlong; varying vec3 vW; varying vec3 vO; varying vec3 vD;
      void main() {
        vAlong = clamp(position.z / ${LEN.toFixed(1)}, 0.0, 1.0);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vD = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uI, uLen, uRad; uniform vec3 uColor;
      varying float vAlong; varying vec3 vW; varying vec3 vO; varying vec3 vD;
      float h3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
      float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main() {
        // (The black box lesson: clamp what a pow() eats; varyings can overshoot under MSAA.)
        float al = clamp(vAlong, 0.0, 1.0);
        vec3 r = normalize(vW - cameraPosition);
        vec3 w0 = cameraPosition - vO;
        float b = dot(r, vD), d = dot(r, w0), e = dot(vD, w0);
        float den = max(1.0 - b * b, 1e-4);
        float sc = (b * e - d) / den, tc = (e - b * d) / den;
        float dist = length(w0 + r * sc - vD * tc);
        float rad = mix(0.35, uRad, clamp(tc / max(uLen, 1.0), 0.0, 1.0));
        float q = dist / max(rad, 0.05);
        float edge = exp(-q * q * 3.0);
        float fall = pow(max(1.0 - al, 0.0), 1.6) * smoothstep(0.0, 0.03, al);
        float dust = 0.6 + 0.4 * n3(vec3(al * 30.0, dist * 0.5, uTime * 0.25));
        float near = smoothstep(4.0, 25.0, length(cameraPosition - vW));
        float fd = uFogDensity * length(cameraPosition - vW) * 0.35;
        float fog = exp(-fd * fd);
        // The fog is what makes a beam: thicker fog, a brighter shaft (up to a point).
        float thick = clamp(uFogDensity * 900.0, 0.35, 1.6);
        gl_FragColor = vec4(uColor * edge * fall * dust * near * fog * thick * uI * 0.22, 1.0);
      }`,
  });
  // The pool of light on the swell where the beam lands.
  const poolGeo = new THREE.PlaneGeometry(2, 2, 12, 12);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.ShaderMaterial({
    name: "RexmawBeamPool", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uI: { value: 1 }, uColor: { value: new THREE.Color("#ffd9a0") } },
    vertexShader: /* glsl */`
      uniform vec4 uSwellA[3]; uniform vec4 uSwellB[3]; uniform float uTime;
      varying vec2 vP; varying float vDist;
      void main() {
        vP = position.xz;
        vec4 w = modelMatrix * vec4(position, 1.0);
        float h = 0.0;
        for (int i = 0; i < 3; i++) h += uSwellB[i].x * sin(uSwellA[i].z * dot(uSwellA[i].xy, w.xz) - uSwellA[i].w * uTime + uSwellB[i].y);
        w.y = ${WATER_Y.toFixed(2)} + h + 0.1;
        vec4 mv = viewMatrix * w;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFogDensity, uI; uniform vec3 uColor;
      varying vec2 vP; varying float vDist;
      void main() {
        float r = length(vP);
        float a = exp(-r * r * 2.6) * (1.0 - smoothstep(0.85, 1.0, r));
        float fd = uFogDensity * vDist * 0.45;
        gl_FragColor = vec4(uColor * a * uI * exp(-fd * fd) * 0.9, 1.0);
      }`,
  });
  const beams = Array.from({ length: BEAMS }, (_, i) => {
    const mat = beamMat.clone(); mat.uniforms.uTime = wu.uTime; mat.uniforms.uFogDensity = wu.uFogDensity;
    const pmat = poolMat.clone(); for (const k of ["uTime", "uFogDensity", "uSwellA", "uSwellB"]) pmat.uniforms[k] = wu[k];
    const cone = new THREE.Mesh(coneGeo, mat);
    cone.frustumCulled = false; cone.renderOrder = 11; cone.layers.set(LAYERS.FX); cone.visible = false;
    const pool = new THREE.Mesh(poolGeo, pmat);
    pool.frustumCulled = false; pool.renderOrder = 4; pool.layers.set(LAYERS.NOREFLECT); pool.visible = false;
    root.add(cone, pool);
    return { cone, pool, mat, pmat, id: null, yaw: 0, alert: 0, light: null };
  });
  // One real light rides the nearest beam (fixed: present from the start).
  const spot = new THREE.SpotLight("#ffd9a0", 0, 160, 0.16, 0.5, 1.4);
  spot.name = "patrol-lantern";
  const spotTarget = new THREE.Object3D();
  spot.target = spotTarget;
  R.scene.add(spot, spotTarget);

  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _cam = new THREE.Vector3();
  const gloam = new Map();      // id → {vis}

  function wantsBeam(c, day) {
    if (!c || c.state === "sinking" || c.state === "surrender") return false;
    if (c.lantern || c.searchlight || c.beam) return true;
    return day < 0.5 && (c.role === "patrol" || c.ai === "patrol") && (c.navy || /gunboat|brig|frigate|manowar/.test(String(c.cls || "")));
  }

  function update(st, dt) {
    const day = R.atmos?.day || 0;
    R.camera.getWorldPosition(_cam);
    const ship = st?.ship;
    const cands = [];
    for (const c of st?.contacts || []) if (wantsBeam(c, day) && fleet.has(c.id)) cands.push(c);
    cands.sort((a, b) => (+a.dist || 1e9) - (+b.dist || 1e9));
    let nearest = null;
    beams.forEach((bm, i) => {
      const c = cands[i];
      if (!c) { bm.cone.visible = false; bm.pool.visible = false; bm.id = null; return; }
      if (bm.id !== c.id) { bm.id = c.id; bm.yaw = 0; bm.alert = 0; bm.phase = Math.random() * 6.28; }
      const info = fleet.info(c.id);
      if (!info || info.sinking) { bm.cone.visible = false; bm.pool.visible = false; return; }
      // The lantern in the bow, a little above the forecastle.
      const at = fleet.localToWorld(c.id, _v.set(0, (fleet.sizeOf(c.id)?.h0 || 2) + 3.2, info.L * 0.42), new THREE.Vector3());
      if (!at) return;
      // The core's lantern: {yaw (world °), half (°), range (m)}, `alert` 0..1, `spotted`. Else a sweep of ±55°.
      const L = c.lantern && typeof c.lantern === "object" ? c.lantern : null;
      const alertT = c.spotted ? 1 : Number.isFinite(+c.alert) ? clamp(+c.alert, 0, 1) : (c.state === "ram" ? 1 : 0);
      bm.alert += (alertT - bm.alert) * Math.min(1, dt * 1.5);
      let yawT;
      if (L && Number.isFinite(+L.yaw)) yawT = +L.yaw;
      else if (Number.isFinite(+c.beamYaw)) yawT = +c.heading + +c.beamYaw;
      else yawT = +info.heading + Math.sin(R.time * 0.7 + bm.phase) * 55;
      if (c.spotted && ship && !(L && Number.isFinite(+L.yaw))) {
        const dx = +ship.x - at.x, dz = +ship.z - at.z;
        yawT = Math.atan2(-dx, dz) / DEG;
      }
      const dy = ((((yawT - bm.yaw + 180) % 360) + 360) % 360) - 180;
      bm.yaw += dy * Math.min(1, dt * (L ? 8 : bm.alert > 0.5 ? 3 : 1.4));
      const reach = L && Number.isFinite(+L.range) ? clamp(+L.range, 40, 400) : LEN;
      const half = L && Number.isFinite(+L.half) ? clamp(+L.half, 3, 40) : 3.4;
      bm.mat.uniforms.uLen.value = reach;
      bm.mat.uniforms.uRad.value = Math.tan(half * DEG) * reach;
      bm.cone.scale.set(Math.tan(half * DEG) * reach / 9, Math.tan(half * DEG) * reach / 9, reach / LEN);
      const range = c.spotted && ship ? clamp(Math.hypot(+ship.x - at.x, +ship.z - at.z), 30, reach * 0.9) : reach * 0.72;
      const pitch = Math.atan2(at.y - WATER_Y, range);
      bm.cone.position.copy(at);
      _e.set(pitch, -bm.yaw * DEG, 0, "YXZ");
      bm.cone.quaternion.setFromEuler(_e);
      const vis = clamp(info.vis ?? 1, 0, 1) * (1 - day);
      const col = bm.mat.uniforms.uColor.value.set("#ffd9a0").lerp(_c.set("#ff7a4a"), bm.alert * 0.7);
      bm.mat.uniforms.uI.value = vis * (1 + 0.6 * bm.alert);
      bm.cone.visible = vis > 0.02;
      // The pool where it lands.
      const [hx, hz] = headingVec(bm.yaw);
      const land = _w.set(at.x + hx * range, WATER_Y, at.z + hz * range);
      bm.pool.position.copy(land);
      const pr = Math.max(6, Math.tan(half * DEG) * range * 1.1);
      bm.pool.scale.set(pr, 1, pr * 1.5);
      bm.pool.rotation.y = -bm.yaw * DEG;
      bm.pmat.uniforms.uI.value = vis * (0.8 + 0.6 * bm.alert);
      bm.pmat.uniforms.uColor.value.copy(col);
      bm.pool.visible = bm.cone.visible;
      if (!nearest || (+c.dist || 1e9) < (+nearest.c.dist || 1e9)) nearest = { c, bm, at: at.clone(), land: land.clone(), vis };
    });
    if (nearest && R.quality.tier !== "low") {
      spot.position.copy(nearest.at);
      spotTarget.position.copy(nearest.land);
      spot.intensity = 900 * nearest.vis * (1 + 0.5 * nearest.bm.alert);
      spot.color.copy(nearest.bm.mat.uniforms.uColor.value);
    } else spot.intensity = 0;

    // The Gloam: a burst when she comes out of her cloak.
    for (const c of st?.contacts || []) {
      if (!/gloam/i.test(String(c.cls || ""))) continue;
      const g = gloam.get(c.id) || { cloaked: false };
      const now = !!(c.cloaked || c.cloak || c.ai === "cloak");
      if (g.cloaked && !now) {
        const p = fleet.positionOf(c.id, new THREE.Vector3());
        if (p) {
          for (let k = 0; k < 14; k++) fx.ghostMist?.(p.clone().add(_v.set((Math.random() - 0.5) * 40, Math.random() * 10, (Math.random() - 0.5) * 50)), { thick: true });
          water.pulse?.({ x: p.x, z: p.z, color: "#5fffd6", speed: 14, intensity: 1.4 });
          R.cam?.trauma?.(0.15);
        }
      }
      g.cloaked = now;
      gloam.set(c.id, g);
    }
  }
  const _c = new THREE.Color();

  return {
    root, update,
    warmShow(on) { for (const b of beams) { b.cone.visible = on; b.pool.visible = on; } },
    stats: () => ({ beams: beams.filter((b) => b.cone.visible).length }),
    reset() { gloam.clear(); for (const b of beams) { b.cone.visible = false; b.pool.visible = false; b.id = null; } spot.intensity = 0; },
    dispose() { root.removeFromParent(); spot.removeFromParent(); spotTarget.removeFromParent(); coneGeo.dispose(); poolGeo.dispose(); beamMat.dispose(); poolMat.dispose(); for (const b of beams) { b.mat.dispose(); b.pmat.dispose(); } },
  };
}
