// Broadside: sky, light and weather. A gradient dome with a sun (or moon),
// stars at night, and presets that set the whole mood at once: sky, sun,
// lights, water colours and fog.
import * as THREE from "three";

export const PRESETS = {
  sunset: { name: "Sunset", top: "#24315e", horizon: "#f59e5b", sun: "#ffc68a", sunElev: 7, sunAz: -25, sunSize: 1.2,
    light: 2.4, hemiSky: "#ffd2a8", hemiGround: "#2a3550", hemi: 0.9, deep: "#0a2e48", shallow: "#2b6f88", waterSky: "#f6b37a",
    fog: "#e8a072", fogDensity: 0.0013, stars: 0, lanterns: 0.6, exposure: 1.0 },
  midday: { name: "Midday", top: "#2f6fd6", horizon: "#cfe5ff", sun: "#fff6e0", sunElev: 55, sunAz: 20, sunSize: 0.8,
    light: 3.0, hemiSky: "#cfe8ff", hemiGround: "#3b4a5c", hemi: 1.0, deep: "#06406b", shallow: "#1f8bb0", waterSky: "#a9d1f5",
    fog: "#d6ebff", fogDensity: 0.0009, stars: 0, lanterns: 0, exposure: 0.95 },
  night: { name: "Moonlit night", top: "#02040e", horizon: "#16233f", sun: "#c7d6ff", sunElev: 26, sunAz: 30, sunSize: 0.9,
    light: 0.55, hemiSky: "#3b4f7c", hemiGround: "#05070d", hemi: 0.45, deep: "#020a18", shallow: "#0b2a4a", waterSky: "#24365a",
    fog: "#0b1428", fogDensity: 0.0016, stars: 1, lanterns: 2.2, exposure: 1.15, moon: true },
  dawn: { name: "Dawn fog", top: "#7d8fd6", horizon: "#f6cfd8", sun: "#ffe4cf", sunElev: 4, sunAz: 60, sunSize: 1.4,
    light: 1.6, hemiSky: "#f2d9e6", hemiGround: "#4a5568", hemi: 1.0, deep: "#3a5470", shallow: "#7c97ad", waterSky: "#e8cdd8",
    fog: "#e9d3dc", fogDensity: 0.0032, stars: 0, lanterns: 0.4, exposure: 1.0 },
  storm: { name: "Storm", top: "#0c111b", horizon: "#3a4556", sun: "#9fb0c8", sunElev: 30, sunAz: 0, sunSize: 0,
    light: 0.9, hemiSky: "#7f8ea3", hemiGround: "#111827", hemi: 0.7, deep: "#0c1c26", shallow: "#2c4652", waterSky: "#4b5563",
    fog: "#2f3a48", fogDensity: 0.0028, stars: 0, lanterns: 1.4, exposure: 1.05 },
};

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = /* glsl */`
  uniform vec3 uTop, uHorizon, uSun, uSunDir; uniform float uSunSize, uMoon, uFlash;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
    col = mix(col, uHorizon * 0.8, clamp(-h * 4.0, 0.0, 1.0));
    float d = max(dot(vDir, uSunDir), 0.0);
    col += uSun * pow(d, 9.0) * 0.35 * uSunSize;                    // the glow around it
    float disc = smoothstep(0.9993 - uSunSize * 0.0004, 0.9997, d);  // the disc
    col = mix(col, uMoon > 0.5 ? vec3(0.93, 0.95, 1.0) : uSun * 1.6, disc * step(0.01, uSunSize));
    col += vec3(0.8, 0.85, 1.0) * uFlash;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createSky(scene) {
  const uniforms = {
    uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunSize: { value: 1 }, uMoon: { value: 0 }, uFlash: { value: 0 },
  };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms, side: THREE.BackSide, depthWrite: false }));
  dome.renderOrder = -1;
  scene.add(dome);

  // Stars: a shell of points that fades in at night.
  const starGeo = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i < 2200; i++) {
    const u = Math.random(), v = Math.random() * 0.48 + 0.02;
    const th = u * Math.PI * 2, ph = Math.acos(1 - v);
    pts.push(Math.sin(ph) * Math.cos(th) * 2500, Math.cos(ph) * 2500, Math.sin(ph) * Math.sin(th) * 2500);
  }
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: "#ffffff", size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
  scene.add(stars);

  const sunLight = new THREE.DirectionalLight("#ffffff", 2);
  const hemi = new THREE.HemisphereLight("#ffffff", "#333333", 1);
  scene.add(sunLight, sunLight.target, hemi);

  // Rain: streaks that fall around the camera in a storm.
  const rainGeo = new THREE.BufferGeometry();
  const RAIN = 2400, rainPos = new Float32Array(RAIN * 6);
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: "#b6c7d9", transparent: true, opacity: 0.35 }));
  rain.frustumCulled = false; rain.visible = false;
  const drops = Array.from({ length: RAIN }, () => [(Math.random() - 0.5) * 200, Math.random() * 90, (Math.random() - 0.5) * 200]);
  scene.add(rain);

  let preset = null, flash = 0, nextBolt = 0;

  function apply(id, ocean, renderer, scene_) {
    const p = PRESETS[id];
    preset = p;
    uniforms.uTop.value.set(p.top); uniforms.uHorizon.value.set(p.horizon); uniforms.uSun.value.set(p.sun);
    uniforms.uSunSize.value = p.sunSize; uniforms.uMoon.value = p.moon ? 1 : 0;
    const el = THREE.MathUtils.degToRad(p.sunElev), az = THREE.MathUtils.degToRad(p.sunAz);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    uniforms.uSunDir.value.copy(dir);
    sunLight.position.copy(dir).multiplyScalar(500); sunLight.color.set(p.sun); sunLight.intensity = p.light;
    hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGround); hemi.intensity = p.hemi;
    stars.material.opacity = p.stars;
    rain.visible = id === "storm";
    const u = ocean.uniforms;
    u.uDeep.value.set(p.deep); u.uShallow.value.set(p.shallow); u.uSky.value.set(p.waterSky);
    u.uSunColor.value.set(p.sun); u.uSunDir.value.copy(dir); u.uSunStrength.value = id === "storm" ? 0.2 : p.moon ? 0.8 : 1.6;
    u.uFogColor.value.set(p.fog); u.uFogDensity.value = p.fogDensity;
    scene_.fog = new THREE.FogExp2(p.fog, p.fogDensity);
    renderer.toneMappingExposure = p.exposure;
    nextBolt = 0;
  }

  /** Per frame: rain, lightning. Returns true on the frame a bolt strikes. */
  function update(dt, t, camera) {
    let bolt = false;
    dome.position.copy(camera.position);
    stars.position.copy(camera.position);
    if (rain.visible) {
      for (let i = 0; i < RAIN; i++) {
        const d = drops[i];
        d[1] -= dt * 60; d[0] -= dt * 12;
        if (d[1] < 0) { d[1] = 80 + Math.random() * 10; d[0] = (Math.random() - 0.5) * 200; d[2] = (Math.random() - 0.5) * 200; }
        const x = camera.position.x + d[0], y = d[1], z = camera.position.z + d[2];
        rainPos.set([x, y, z, x + 0.4, y - 2.2, z], i * 6);
      }
      rainGeo.attributes.position.needsUpdate = true;
      if (t > nextBolt) {
        nextBolt = t + 5 + Math.random() * 9;
        if (t > 3) { flash = 1; bolt = true; }
      }
    }
    if (flash > 0) {
      flash = Math.max(0, flash - dt * 3.2);
      const f = flash * (0.6 + 0.4 * Math.sin(t * 60));
      uniforms.uFlash.value = f * 0.8;
      hemi.intensity = (preset?.hemi || 1) + f * 3;
    } else uniforms.uFlash.value = 0;
    return bolt;
  }

  return { apply, update, preset: () => preset, sunLight };
}
