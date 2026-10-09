// Night Raid: the maelstrom (world.maelstrom {x, z, r: 320, eye: 45, ring}).
//
//   the bowl     inside half its radius the sea's surface opens (water.js
//                discards there) and this takes over: a lathed bowl that
//                sinks toward the eye (≈2 m at the treasure ring, 16 m at the
//                eye's lip), then the funnel plunging ~75 m into the dark.
//                Its shader: black water streaming round, faster inward
//                (ω ∝ 1/r), spiral foam arms, the moon's glitter on the
//                slope, a cold bioluminescent churn deep in the throat.
//   the spiral   from the bowl's rim out to the pull radius: foam streaks on
//                the flat sea, winding in, densest near the rim
//   the mist     spray and mist motes wheeling round the eye, rising (a draw
//                range per quality tier)
//   the glow     a faint teal glow over the eye that carries through the night
//   anchors      `roar` (an Object3D at the eye) for the audio's roar point
//
// Ships ride the bowl: depthAt(x, z) and slopeAt(x, z) let world.js and the
// fleet sink and tilt a hull that sails into it.

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";
import { MAX_COUNTS } from "./quality.js";

const DEPTH_LIP = 16, DEPTH_THROAT = 60;
const clamp = THREE.MathUtils.clamp;

const NOISE = /* glsl */`
  float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float mNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x), mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float mFbm(vec2 p) { return mNoise(p) * 0.55 + mNoise(p * 2.07 + 3.1) * 0.3 + mNoise(p * 4.3 - 1.7) * 0.15; }`;

/**
 * @param {object} R  the render context
 * @param {{water: object, fx: object}} deps
 */
export function createMaelstrom(R, { water, fx }) {
  const root = new THREE.Group();
  root.name = "maelstrom";
  root.visible = false;
  R.scene.add(root);
  const wu = water?.uniforms || {};
  const U = {
    uTime: wu.uTime || { value: 0 }, uFogDensity: wu.uFogDensity || { value: 0 }, uFogColor: wu.uFogColor || { value: new THREE.Color() },
    uMoonDir: wu.uMoonDir || { value: new THREE.Vector3(0, 0.4, 0.9) }, uMoonColor: wu.uMoonColor || { value: new THREE.Color("#9fb4ff") }, uMoonVis: wu.uMoonVis || { value: 1 },
    uHorizon: wu.uHorizon || { value: new THREE.Color("#0d1b33") }, uZenith: wu.uZenith || { value: new THREE.Color("#050a1a") },
    uCentre: { value: new THREE.Vector2() }, uR: { value: 320 }, uHole: { value: 160 }, uEye: { value: 45 }, uSpin: { value: 1 },
  };
  const M = { on: false, x: 0, z: 0, r: 320, eye: 45, hole: 160 };

  // ---- The bowl and the funnel (unit lathe, rebuilt per night to the radii) ----
  const RINGS = 56, SEG = 120;
  const bowlGeo = new THREE.BufferGeometry();
  const bPos = new Float32Array((RINGS + 1) * (SEG + 1) * 3), bUv = new Float32Array((RINGS + 1) * (SEG + 1) * 2);
  const bIdx = [];
  for (let j = 0; j < RINGS; j++) for (let i = 0; i < SEG; i++) {
    const a = j * (SEG + 1) + i, b = a + 1, c = a + SEG + 1, d = c + 1;
    bIdx.push(a, c, b, b, c, d);
  }
  bowlGeo.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
  bowlGeo.setAttribute("uv", new THREE.BufferAttribute(bUv, 2));
  bowlGeo.setIndex(bIdx);
  const bowlMat = new THREE.ShaderMaterial({
    name: "NightRaidMaelstromBowl", uniforms: U, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vW; varying vec3 vN; varying float vRho;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vRho = uv.x;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uR, uHole, uEye, uSpin, uMoonVis;
      uniform vec3 uFogColor, uMoonDir, uMoonColor, uHorizon, uZenith;
      uniform vec2 uCentre;
      varying vec3 vW; varying vec3 vN; varying float vRho;
      ${NOISE}
      void main() {
        vec2 d = vW.xz - uCentre;
        float rho = max(length(d), 0.5);
        float th = atan(d.y, d.x);
        // atan jumps by 2π at the back of the circle: every angular pattern is also taken from the other side
        // of the cut and blended there, so there's no seam.
        float w = 0.5 * smoothstep(2.5, 3.14159, abs(th));
        float th2 = th - sign(th) * 6.28318;
        // Angular speed ∝ 1/r (clamped in the throat), the spiral winds in.
        float om = uSpin * 6.0 / max(rho, 6.0);
        float spin = om * uTime + log(rho) * 2.4;
        float s = th + spin, s2 = th2 + spin;
        float arms = mix(mFbm(vec2(s * 3.0, rho * 0.035 - uTime * 0.05)), mFbm(vec2(s2 * 3.0, rho * 0.035 - uTime * 0.05)), w);
        float fine = mix(mNoise(vec2(s * 14.0, rho * 0.4 - uTime * 0.6)), mNoise(vec2(s2 * 14.0, rho * 0.4 - uTime * 0.6)), w);
        float streak = smoothstep(0.55, 0.8, arms) * (0.4 + 0.6 * fine);
        float lip = smoothstep(uEye + 14.0, uEye, rho) * smoothstep(uEye * 0.55, uEye, rho);
        vec3 N = normalize(vN);
        if (N.y < 0.0) N = -N;
        // Fine ripples ride the stream.
        vec2 rip = vec2(mix(mNoise(vec2(s * 40.0, rho * 1.2)), mNoise(vec2(s2 * 40.0, rho * 1.2)), w) - 0.5,
                        mix(mNoise(vec2(s * 40.0 + 7.0, rho * 1.2 + 3.0)), mNoise(vec2(s2 * 40.0 + 7.0, rho * 1.2 + 3.0)), w) - 0.5) * 0.25;
        N = normalize(N + vec3(rip.x, 0.0, rip.y));
        vec3 toCam = cameraPosition - vW;
        float dist = max(length(toCam), 1e-3);
        vec3 V = toCam / dist;
        float F = 0.02 + 0.98 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);
        vec3 Rr = reflect(-V, N);
        float h = max(Rr.y, 0.0);
        vec3 sky = mix(uHorizon, uZenith, sqrt(clamp(h / 0.62, 0.0, 1.0)));
        // Toward the rim the slope flattens into the open sea: darken it to meet the water's own shade (no seam).
        vec3 col = vec3(0.004, 0.012, 0.016) * (1.0 - F) + sky * F * mix(0.6, 0.3, smoothstep(uHole * 0.55, uHole, rho));
        col += uMoonColor * uMoonVis * pow(max(dot(Rr, uMoonDir), 0.0), 220.0) * 2.0;
        // Foam arms and the lip's white water.
        float depth = clamp((${WATER_Y.toFixed(2)} - vW.y) / ${DEPTH_THROAT.toFixed(1)}, 0.0, 1.0);
        vec3 foam = vec3(0.32, 0.38, 0.42) * (0.5 + 0.6 * uMoonVis);
        col = mix(col, foam, clamp(streak * (1.0 - depth * 0.8) + lip * (0.35 + 0.5 * streak), 0.0, 0.85));
        // Darkness falls into the throat; a cold churn of light down there.
        col *= mix(1.0, 0.18, smoothstep(0.08, 0.6, depth));
        float churn = mix(mFbm(vec2(s * 5.0, depth * 10.0 - uTime * 0.7)), mFbm(vec2(s2 * 5.0, depth * 10.0 - uTime * 0.7)), w);
        col += vec3(0.1, 0.9, 0.75) * smoothstep(0.25, 0.9, depth) * smoothstep(0.5, 0.85, churn) * 0.35;
        float fd = uFogDensity * dist;
        col = mix(col, uFogColor, 1.0 - exp(-fd * fd));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const bowl = new THREE.Mesh(bowlGeo, bowlMat);
  bowl.name = "maelstrom.bowl";
  bowl.frustumCulled = false;
  bowl.layers.set(LAYERS.NOREFLECT);
  root.add(bowl);

  // ---- The spiral on the open water (rim → pull radius) ----
  const spiralGeo = new THREE.RingGeometry(1, 2, 160, 12);
  spiralGeo.rotateX(-Math.PI / 2);
  const spiralMat = new THREE.ShaderMaterial({
    name: "NightRaidMaelstromSpiral", uniforms: U, transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uR, uHole, uSpin, uMoonVis;
      uniform vec2 uCentre;
      varying vec3 vW;
      ${NOISE}
      void main() {
        vec2 d = vW.xz - uCentre;
        float rho = length(d);
        if (rho < uHole - 0.5 || rho > uR) discard;
        float th = atan(d.y, d.x);
        float w = 0.5 * smoothstep(2.5, 3.14159, abs(th));           // blend across atan's cut (see the bowl)
        float th2 = th - sign(th) * 6.28318;
        float om = uSpin * 6.0 / max(rho, 6.0);
        float spin = om * uTime + log(rho) * 2.4;
        float s = th + spin, s2 = th2 + spin;
        float k = 1.0 - smoothstep(uHole, uR, rho);          // 1 at the rim, 0 at the pull radius
        float arms = mix(mFbm(vec2(s * 3.0, rho * 0.03 - uTime * 0.04)), mFbm(vec2(s2 * 3.0, rho * 0.03 - uTime * 0.04)), w);
        float fine = mix(mNoise(vec2(s * 18.0, rho * 0.3 - uTime * 0.5)), mNoise(vec2(s2 * 18.0, rho * 0.3 - uTime * 0.5)), w);
        float streak = smoothstep(0.6 - 0.12 * k, 0.82, arms) * (0.35 + 0.65 * fine);
        float a = streak * (0.12 + 0.65 * k * k);
        // A darkening current near the rim (the water drawn down).
        float dark = k * k * 0.25;
        float fd = uFogDensity * length(cameraPosition - vW);
        float seen = exp(-fd * fd);
        vec3 foam = vec3(0.34, 0.4, 0.45) * (0.5 + 0.6 * uMoonVis);
        float alpha = clamp(a + dark, 0.0, 0.9) * seen;
        if (alpha < 0.003) discard;
        vec3 col = (foam * a) / max(a + dark, 1e-3);
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const spiral = new THREE.Mesh(spiralGeo, spiralMat);
  spiral.name = "maelstrom.spiral";
  spiral.frustumCulled = false;
  spiral.renderOrder = 2;
  spiral.layers.set(LAYERS.NOREFLECT);
  root.add(spiral);

  // ---- The mist: motes wheeling round the eye ----
  const MAX = MAX_COUNTS.mist;
  const mistGeo = new THREE.BufferGeometry();
  {
    const a = new Float32Array(MAX * 4);
    let s = 0x9e3779b9;
    const rnd = () => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s / 4294967296; };
    for (let i = 0; i < MAX; i++) {
      const u = rnd();
      a[i * 4] = 0.15 + 1.1 * u * u;          // radius as a fraction of the hole
      a[i * 4 + 1] = rnd() * Math.PI * 2;     // start angle
      a[i * 4 + 2] = rnd();                   // height share
      a[i * 4 + 3] = rnd();                   // seed
    }
    mistGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    mistGeo.setAttribute("aMist", new THREE.BufferAttribute(a, 4));
    mistGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    mistGeo.setDrawRange(0, R.quality.mist || 3000);
  }
  const mistMat = new THREE.ShaderMaterial({
    name: "NightRaidMaelstromMist", uniforms: { ...U, uScale: { value: 800 } }, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */`
      attribute vec4 aMist;
      uniform float uTime, uHole, uEye, uSpin, uScale, uFogDensity, uMoonVis;
      uniform vec2 uCentre;
      varying float vA; varying vec3 vC;
      void main() {
        float rho = aMist.x * uHole;
        float om = uSpin * 6.0 / max(rho, 8.0);
        float th = aMist.y + om * uTime * 1.0;
        float life = fract(aMist.w * 7.0 + uTime * (0.04 + 0.03 * aMist.w));
        float y = ${WATER_Y.toFixed(2)} + 1.0 + life * (8.0 + 30.0 * smoothstep(uEye * 2.0, uEye, rho)) * aMist.z;
        // Inside the eye the mist rises out of the funnel.
        if (rho < uEye) y -= (1.0 - life) * 20.0;
        vec3 p = vec3(uCentre.x + cos(th) * rho, y, uCentre.y + sin(th) * rho);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 1.0);
        float fd = uFogDensity * d;
        vA = sin(life * 3.14159) * 0.075 * exp(-fd * fd) * (0.35 + 0.65 * smoothstep(uHole * 0.9, uEye, rho));
        vC = vec3(0.55, 0.62, 0.68) * (0.35 + 0.5 * uMoonVis);
        gl_PointSize = clamp((4.0 + 10.0 * aMist.w) * uScale / d, 1.0, 140.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vA; varying vec3 vC;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 3.0) * vA;
        if (a < 0.002) discard;
        gl_FragColor = vec4(vC, a);
      }`,
  });
  const mist = new THREE.Points(mistGeo, mistMat);
  mist.name = "maelstrom.mist";
  mist.frustumCulled = false;
  mist.renderOrder = 11;
  mist.layers.set(LAYERS.FX);
  root.add(mist);
  const _bs = new THREE.Vector2();
  mist.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_bs).y;
    mistMat.uniforms.uScale.value = h / (2 * Math.tan((R.camera.fov * Math.PI / 180) / 2));
  };

  // ---- The eye's glow (a big, faint teal billboard) ----
  const glowMat = new THREE.ShaderMaterial({
    name: "NightRaidMaelstromGlow", uniforms: { uFogDensity: U.uFogDensity, uTime: U.uTime }, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying float vSeen;
      uniform float uFogDensity;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float d = max(-mv.z, 1.0);
        float fd = uFogDensity * d * 0.55;
        vSeen = exp(-fd * fd);
        mv.xy += position.xy * vec2(300.0, 70.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv; varying float vSeen;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        float v = exp(-r2 * 6.0) * (0.85 + 0.15 * sin(uTime * 0.8));
        gl_FragColor = vec4(vec3(0.1, 0.55, 0.48) * v * 0.12 * vSeen, 1.0);
      }`,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glow.frustumCulled = false;
  glow.renderOrder = 10;
  glow.layers.set(LAYERS.FX);
  root.add(glow);

  const roar = new THREE.Object3D();
  roar.name = "maelstrom-roar";
  R.scene.add(roar);

  // ---- The profile ----
  function depthOfRho(rho) {
    if (!M.on || rho >= M.hole) return 0;
    if (rho >= M.eye) return DEPTH_LIP * Math.pow((M.hole - rho) / (M.hole - M.eye), 2.2);
    return DEPTH_LIP + DEPTH_THROAT * Math.pow(1 - clamp(rho / M.eye, 0, 1), 0.6);
  }
  function rhoOfRing(j) {
    // Rings: half from the rim to the eye, half down the throat.
    const half = RINGS * 0.62;
    if (j <= half) return M.hole - (M.hole - M.eye) * Math.pow(j / half, 0.9);
    return M.eye * (1 - 0.94 * Math.pow((j - half) / (RINGS - half), 0.85));
  }
  function rebuild() {
    for (let j = 0; j <= RINGS; j++) {
      const rho = rhoOfRing(j);
      const y = WATER_Y - depthOfRho(rho) + (j === 0 ? 0 : 0);
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const k = j * (SEG + 1) + i;
        bPos[k * 3] = Math.cos(a) * rho; bPos[k * 3 + 1] = y; bPos[k * 3 + 2] = Math.sin(a) * rho;
        bUv[k * 2] = rho / M.hole; bUv[k * 2 + 1] = i / SEG;
      }
    }
    bowlGeo.attributes.position.needsUpdate = true;
    bowlGeo.attributes.uv.needsUpdate = true;
    bowlGeo.computeVertexNormals();
    bowlGeo.computeBoundingSphere();
  }

  const _v = new THREE.Vector3();
  return {
    root,
    anchors: { roar },
    /** world.maelstrom, or null to remove it. */
    setWorld(world) {
      const m = world?.maelstrom;
      if (!m || !Number.isFinite(+m.x)) { M.on = false; root.visible = false; water.setHole(0, 0, 0); return; }
      M.on = true;
      M.x = +m.x; M.z = +m.z; M.r = +m.r || 320; M.eye = +m.eye || 45; M.hole = clamp(M.r * 0.5, M.eye * 2.2, M.r * 0.7);
      U.uCentre.value.set(M.x, M.z); U.uR.value = M.r; U.uHole.value = M.hole; U.uEye.value = M.eye;
      rebuild();
      bowl.position.set(M.x, 0, M.z);
      spiral.position.set(M.x, WATER_Y + 0.04, M.z);
      spiral.scale.set(M.r / 2, 1, M.r / 2);   // RingGeometry 1..2 → r/2..r: the shader discards inside the hole
      glow.position.set(M.x, WATER_Y + 6, M.z);
      roar.position.set(M.x, WATER_Y, M.z);
      root.visible = true;
      water.setHole(M.x, M.z, M.hole);
    },
    update(state, dt) {
      if (!M.on) return;
      // The live maelstrom (hazards.maelstrom) may move or resize.
      const hm = state?.hazards?.maelstrom;
      if (hm && Number.isFinite(+hm.x) && (Math.abs(+hm.x - M.x) > 0.5 || Math.abs(+hm.z - M.z) > 0.5)) this.setWorld({ maelstrom: { ...hm, r: hm.r || M.r, eye: hm.eye || M.eye } });
      mistGeo.setDrawRange(0, R.quality.mist || 3000);
    },
    /** How far the surface sinks at world (x, z) (m, ≥ 0). */
    depthAt(x, z) { return M.on ? depthOfRho(Math.hypot(x - M.x, z - M.z)) : 0; },
    /** Where it is, or null. */
    get where() { return M.on ? { x: M.x, z: M.z, r: M.r, eye: M.eye, hole: M.hole } : null; },
    warmShow(on) { root.visible = on || M.on; },
    dispose() {
      root.removeFromParent(); roar.removeFromParent();
      bowlGeo.dispose(); bowlMat.dispose(); spiralGeo.dispose(); spiralMat.dispose(); mistGeo.dispose(); mistMat.dispose();
      glow.geometry.dispose(); glowMat.dispose();
    },
  };
}
