// Broadside: the sea. Gerstner waves on the GPU, and the same waves in
// JavaScript so ships, barrels and the Kraken ride the surface you see.
import * as THREE from "three";

// Direction (degrees), steepness (0..1), wavelength (m).
const WAVES = [
  { dir: 20, steep: 0.16, len: 62 },
  { dir: -32, steep: 0.13, len: 33 },
  { dir: 75, steep: 0.09, len: 19 },
  { dir: 150, steep: 0.06, len: 10.5 },
];
const G = 9.81;

const waveData = WAVES.map((w) => {
  const k = (2 * Math.PI) / w.len, rad = (w.dir * Math.PI) / 180;
  return { k, c: Math.sqrt(G / k), dx: Math.cos(rad), dz: Math.sin(rad), a: w.steep / k, steep: w.steep };
});

/** The water's height at (x, z) at time t, `amp` times the calm sea. */
export function waveHeight(x, z, t, amp = 1) {
  let y = 0;
  for (const w of waveData) y += w.a * amp * Math.sin(w.k * (w.dx * x + w.dz * z - w.c * t));
  return y;
}

const VERT = /* glsl */`
  uniform float uTime, uAmp;
  uniform vec4 uWaves[4];      // dx, dz, k, steepness
  varying vec3 vWorld; varying vec3 vNormal; varying float vHeight;
  void main() {
    vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 base = p;
    vec3 tangent = vec3(1.0, 0.0, 0.0), binormal = vec3(0.0, 0.0, 1.0);
    for (int i = 0; i < 4; i++) {
      vec2 d = uWaves[i].xy; float k = uWaves[i].z; float s = uWaves[i].w * uAmp;
      float c = sqrt(9.81 / k); float a = s / k;
      float f = k * (dot(d, base.xz) - c * uTime);
      p.x += d.x * a * cos(f); p.z += d.y * a * cos(f); p.y += a * sin(f);
      tangent += vec3(-d.x * d.x * s * sin(f), d.x * s * cos(f), -d.x * d.y * s * sin(f));
      binormal += vec3(-d.x * d.y * s * sin(f), d.y * s * cos(f), -d.y * d.y * s * sin(f));
    }
    vNormal = normalize(cross(binormal, tangent));
    vWorld = p; vHeight = p.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform vec3 uDeep, uShallow, uSky, uSunColor, uSunDir, uFogColor;
  uniform float uFogDensity, uSunStrength, uTime, uAmp;
  varying vec3 vWorld; varying vec3 vNormal; varying float vHeight;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    // Ripples on top of the big waves: a bent normal from two noise layers.
    vec2 rp = vWorld.xz * 0.35 + uTime * vec2(0.4, 0.25);
    vec3 N = normalize(vNormal + vec3(noise(rp) - 0.5, 0.0, noise(rp.yx * 1.3 + 7.0) - 0.5) * 0.18);
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    vec3 water = mix(uDeep, uShallow, clamp(vHeight / (1.6 * uAmp) * 0.5 + 0.5, 0.0, 1.0));
    vec3 col = mix(water, uSky, clamp(fres * 0.62, 0.0, 1.0));
    vec3 H = normalize(V + uSunDir);
    col += uSunColor * pow(max(dot(N, H), 0.0), 260.0) * uSunStrength;
    col += uSunColor * pow(max(dot(N, H), 0.0), 18.0) * 0.06 * uSunStrength;
    // Foam on the crests.
    // Foam only on the tallest crests (the waves stack to about 2.6 m).
    float crest = smoothstep(1.55 * uAmp, 2.35 * uAmp, vHeight + (noise(vWorld.xz * 0.6 + uTime * 0.3) - 0.5) * 0.6);
    col = mix(col, vec3(0.93, 0.96, 1.0), crest * 0.6);
    float dist = length(cameraPosition - vWorld);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createOcean() {
  const geo = new THREE.PlaneGeometry(1800, 1800, 360, 360);
  geo.rotateX(-Math.PI / 2);
  const uniforms = {
    uTime: { value: 0 }, uAmp: { value: 1 },
    uWaves: { value: waveData.map((w) => new THREE.Vector4(w.dx, w.dz, w.k, w.steep)) },
    uDeep: { value: new THREE.Color("#0b3a55") }, uShallow: { value: new THREE.Color("#1d6f8f") },
    uSky: { value: new THREE.Color("#9cc6e8") }, uSunColor: { value: new THREE.Color("#fff1d0") },
    uSunDir: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() }, uSunStrength: { value: 1.6 },
    uFogColor: { value: new THREE.Color("#cfe6ff") }, uFogDensity: { value: 0.0011 },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
