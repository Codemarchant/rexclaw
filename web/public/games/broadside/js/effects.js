// Broadside: smoke, fire, spray, splinters, floating wreckage, the gulls
// overhead and the Kraken below. Particles come from two pooled point
// systems (one blended, one additive) drawn with a soft sprite.
import * as THREE from "three";
import { waveHeight } from "./ocean.js";

function softSprite() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,.6)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Particles {
  constructor(scene, max, additive, sprite) {
    this.max = max;
    this.p = [];
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: sprite }, uScale: { value: 600 }, uFog: { value: new THREE.Color() }, uFogD: { value: 0.001 } },
      vertexShader: `attribute vec3 aColor; attribute float aSize, aAlpha; uniform float uScale, uFogD; uniform vec3 uFog;
        varying vec3 vC; varying float vA;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / -mv.z;
          float d = -mv.z; float fog = 1.0 - exp(-uFogD * uFogD * d * d);
          vC = mix(aColor, uFog, fog * ${additive ? "0.0" : "1.0"}); vA = aAlpha * (1.0 - fog * ${additive ? "1.0" : "0.4"}); }`,
      fragmentShader: `uniform sampler2D uTex; varying vec3 vC; varying float vA;
        void main() { vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vC, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(o) {
    if (this.p.length >= this.max) this.p.shift();
    this.p.push({ x: o.pos.x, y: o.pos.y, z: o.pos.z, vx: o.vel?.x || 0, vy: o.vel?.y || 0, vz: o.vel?.z || 0,
      life: o.life, age: 0, size: o.size, grow: o.grow ?? 0, color: new THREE.Color(o.color), color2: o.color2 ? new THREE.Color(o.color2) : null,
      alpha: o.alpha ?? 1, gravity: o.gravity ?? 0, drag: o.drag ?? 0, floor: o.floor ?? -Infinity });
  }
  update(dt) {
    const keep = [];
    for (const q of this.p) {
      q.age += dt;
      if (q.age >= q.life) continue;
      q.vy -= q.gravity * dt;
      const k = Math.max(0, 1 - q.drag * dt);
      q.vx *= k; q.vy *= k; q.vz *= k;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < q.floor) continue;
      keep.push(q);
    }
    this.p = keep;
    const c = new THREE.Color();
    this.p.forEach((q, i) => {
      const f = q.age / q.life;
      this.pos[i * 3] = q.x; this.pos[i * 3 + 1] = q.y; this.pos[i * 3 + 2] = q.z;
      c.copy(q.color); if (q.color2) c.lerp(q.color2, f);
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
      this.size[i] = q.size + q.grow * q.age;
      this.alpha[i] = q.alpha * (f < 0.1 ? f / 0.1 : 1 - (f - 0.1) / 0.9);
    });
    this.geo.setDrawRange(0, this.p.length);
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) this.geo.attributes[name].needsUpdate = true;
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

export function createEffects(scene) {
  const sprite = softSprite();
  const soft = new Particles(scene, 4000, false, sprite);
  const glow = new Particles(scene, 2500, true, sprite);
  const rings = [], debris = [];

  const fx = {
    setFog(color, density) { for (const s of [soft, glow]) { s.mat.uniforms.uFog.value.set(color); s.mat.uniforms.uFogD.value = density; } },
    setScale(h) { soft.mat.uniforms.uScale.value = glow.mat.uniforms.uScale.value = h * 0.9; },

    muzzle(pos, dir) {
      for (let i = 0; i < 14; i++) glow.emit({ pos, vel: dir.clone().multiplyScalar(rnd(8, 30)).add(V(rnd(-3, 3), rnd(-2, 3), rnd(-3, 3))),
        life: rnd(0.15, 0.35), size: rnd(2, 4), grow: 4, color: "#fff2b0", color2: "#ff6a00", drag: 4 });
      for (let i = 0; i < 26; i++) soft.emit({ pos, vel: dir.clone().multiplyScalar(rnd(3, 14)).add(V(rnd(-2, 2), rnd(0, 3), rnd(-2, 2))),
        life: rnd(1.5, 3.5), size: rnd(2.5, 4.5), grow: rnd(2.5, 5), color: "#e5e7eb", color2: "#6b7280", alpha: 0.55, drag: 1.2, gravity: -0.6 });
    },
    trail(pos) {
      soft.emit({ pos, vel: V(rnd(-0.3, 0.3), rnd(0, 0.5), rnd(-0.3, 0.3)), life: rnd(0.8, 1.6), size: 1.3, grow: 2.2, color: "#d1d5db", color2: "#9ca3af", alpha: 0.4 });
      glow.emit({ pos, vel: V(0, 0, 0), life: 0.12, size: 1.2, color: "#ffb347", alpha: 0.6 });
    },
    splash(pos, scale = 1) {
      for (let i = 0; i < 70 * scale; i++) {
        const a = Math.random() * 6.28, r = rnd(0, 3);
        soft.emit({ pos: pos.clone().add(V(Math.cos(a) * r, 0, Math.sin(a) * r)), vel: V(Math.cos(a) * rnd(1, 6), rnd(8, 22) * scale, Math.sin(a) * rnd(1, 6)),
          life: rnd(1, 2), size: rnd(0.8, 2.2), grow: 1, color: "#f1f5f9", color2: "#bae6fd", alpha: 0.85, gravity: 18, floor: pos.y - 1 });
      }
      for (let i = 0; i < 20; i++) soft.emit({ pos, vel: V(rnd(-4, 4), rnd(1, 4), rnd(-4, 4)), life: rnd(1.5, 3), size: 3, grow: 4, color: "#e0f2fe", alpha: 0.3, drag: 1 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.4, 40), new THREE.MeshBasicMaterial({ color: "#f8fafc", transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.copy(pos).setY(pos.y + 0.15);
      scene.add(ring); rings.push({ mesh: ring, age: 0, scale });
    },
    explosion(pos) {
      for (let i = 0; i < 60; i++) glow.emit({ pos, vel: V(rnd(-1, 1), rnd(-0.3, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(4, 16)),
        life: rnd(0.3, 0.9), size: rnd(2, 5), grow: 3, color: "#fff7c2", color2: "#c2410c", drag: 3 });
      for (let i = 0; i < 40; i++) soft.emit({ pos, vel: V(rnd(-4, 4), rnd(2, 9), rnd(-4, 4)), life: rnd(2, 4.5), size: rnd(3, 5), grow: rnd(3, 6),
        color: "#57534e", color2: "#1c1917", alpha: 0.75, drag: 1, gravity: -1 });
      for (let i = 0; i < 30; i++) soft.emit({ pos, vel: V(rnd(-14, 14), rnd(6, 20), rnd(-14, 14)), life: rnd(1, 2.2), size: rnd(0.4, 0.9),
        color: "#7c4a22", alpha: 1, gravity: 20, floor: -1 });
      for (let i = 0; i < 4; i++) this.wreckage(pos);
    },
    /** A burning wound: called every frame for each wound on a ship. */
    burn(pos, intensity) {
      if (Math.random() < 0.6 * intensity) glow.emit({ pos: pos.clone().add(V(rnd(-0.6, 0.6), 0, rnd(-0.6, 0.6))), vel: V(rnd(-0.5, 0.5), rnd(2, 5), rnd(-0.5, 0.5)),
        life: rnd(0.4, 0.9), size: rnd(1.2, 2.4), grow: -1, color: "#ffd166", color2: "#e63900", drag: 1 });
      if (Math.random() < 0.5) soft.emit({ pos, vel: V(rnd(-0.6, 0.6), rnd(2, 4), rnd(-0.6, 0.6)), life: rnd(3, 6), size: 2, grow: rnd(2, 4),
        color: "#44403c", color2: "#0c0a09", alpha: 0.5 * intensity, gravity: -0.3 });
    },
    /** White water off the bow and in the wake of a ship under way. */
    wake(pos, back) {
      soft.emit({ pos: pos.clone().add(V(rnd(-2, 2), 0.3, rnd(-2, 2))), vel: back.clone().multiplyScalar(rnd(1, 3)).add(V(rnd(-1.5, 1.5), rnd(0.2, 1), rnd(-1.5, 1.5))),
        life: rnd(1.5, 3), size: rnd(1.5, 3), grow: 2.5, color: "#f8fafc", color2: "#bae6fd", alpha: 0.55, drag: 0.6 });
    },
    sparkle(pos) {
      for (let i = 0; i < 40; i++) glow.emit({ pos: pos.clone().add(V(0, 2, 0)), vel: V(rnd(-6, 6), rnd(4, 14), rnd(-6, 6)),
        life: rnd(0.6, 1.4), size: rnd(0.8, 1.6), color: "#fef08a", color2: "#f59e0b", gravity: 9, drag: 1 });
    },
    /** A shot that smacks into an island: sand, rock, a palm frond or two. */
    dust(pos) {
      for (let i = 0; i < 50; i++) soft.emit({ pos, vel: V(rnd(-7, 7), rnd(3, 12), rnd(-7, 7)), life: rnd(1, 2.5), size: rnd(1.5, 3), grow: 3,
        color: "#d6b98a", color2: "#a8a29e", alpha: 0.7, gravity: 6, drag: 1 });
      for (let i = 0; i < 16; i++) soft.emit({ pos, vel: V(rnd(-10, 10), rnd(6, 16), rnd(-10, 10)), life: rnd(1, 2), size: rnd(0.4, 0.8), color: "#57534e", gravity: 20 });
    },
    bubbles(pos) {
      for (let i = 0; i < 6; i++) soft.emit({ pos: pos.clone().add(V(rnd(-6, 6), 0, rnd(-14, 14))), vel: V(0, rnd(1, 3), 0), life: rnd(0.6, 1.4), size: rnd(0.4, 1), color: "#e0f2fe", alpha: 0.8 });
    },
    flashLight: null,

    /** Barrels and planks that bob about after a hit. */
    wreckage(pos) {
      const barrel = Math.random() < 0.5;
      const mesh = new THREE.Mesh(barrel ? new THREE.CylinderGeometry(0.5, 0.5, 1.2, 10) : new THREE.BoxGeometry(2.5, 0.2, 0.5),
        new THREE.MeshStandardMaterial({ color: barrel ? "#7c4a22" : "#8b5a2b", roughness: 0.9, transparent: true }));
      mesh.position.copy(pos);
      scene.add(mesh);
      debris.push({ mesh, vel: V(rnd(-8, 8), rnd(6, 14), rnd(-8, 8)), spin: V(rnd(-4, 4), rnd(-4, 4), rnd(-4, 4)), age: 0, floating: false });
    },

    update(dt, t, amp) {
      soft.update(dt); glow.update(dt);
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]; r.age += dt;
        r.mesh.scale.setScalar(1 + r.age * 9 * r.scale);
        r.mesh.material.opacity = Math.max(0, 0.7 - r.age * 0.45);
        r.mesh.position.y = waveHeight(r.mesh.position.x, r.mesh.position.z, t, amp) + 0.15;
        if (r.age > 1.6) { scene.remove(r.mesh); r.mesh.geometry.dispose(); rings.splice(i, 1); }
      }
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i]; d.age += dt;
        const water = waveHeight(d.mesh.position.x, d.mesh.position.z, t, amp);
        if (!d.floating) {
          d.vel.y -= 20 * dt; d.mesh.position.addScaledVector(d.vel, dt);
          d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt; d.mesh.rotation.z += d.spin.z * dt;
          if (d.mesh.position.y < water) { d.floating = true; fx.splash(d.mesh.position.clone(), 0.25); }
        } else {
          d.mesh.position.y += (water - d.mesh.position.y) * Math.min(1, dt * 4);
          d.mesh.rotation.x = Math.sin(t * 1.3 + i) * 0.2; d.mesh.rotation.z = Math.cos(t * 1.1 + i) * 0.2;
          d.mesh.position.x += Math.sin(t * 0.2 + i) * dt * 0.4;
        }
        if (d.age > 25) d.mesh.material.opacity = Math.max(0, 1 - (d.age - 25) / 3);
        if (d.age > 28) { scene.remove(d.mesh); debris.splice(i, 1); }
      }
    },
  };
  return fx;
}

/** Gulls: a little flock circling high over the duel. */
export function createGulls(scene, count = 8) {
  const mat = new THREE.MeshStandardMaterial({ color: "#f8fafc", side: THREE.DoubleSide, roughness: 0.8 });
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -0.35, 0, 0, 0.35, 2.4, 0.2, -0.1], 3));
  wingGeo.computeVertexNormals();
  const birds = Array.from({ length: count }, (_, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), mat); body.scale.set(1, 0.8, 2.2);
    const l = new THREE.Mesh(wingGeo, mat), r = new THREE.Mesh(wingGeo, mat); r.scale.x = -1;
    g.add(body, l, r); scene.add(g);
    return { g, l, r, radius: rnd(40, 110), h: rnd(32, 55), speed: rnd(0.12, 0.25) * (i % 2 ? 1 : -1), phase: Math.random() * 6.28 };
  });
  return {
    update(t) {
      for (const b of birds) {
        const a = b.phase + t * b.speed;
        b.g.position.set(Math.cos(a) * b.radius, b.h + Math.sin(t * 0.7 + b.phase) * 3, Math.sin(a) * b.radius - 30);
        b.g.rotation.y = -a + (b.speed > 0 ? 0 : Math.PI);
        const flap = Math.sin(t * 9 + b.phase) * 0.6;
        b.l.rotation.z = flap; b.r.rotation.z = -flap;
      }
    },
  };
}

/** The Kraken: tentacles of overlapping beads that rise, sway and strike. */
export function createKraken(scene, fx) {
  const mat = new THREE.MeshStandardMaterial({ color: "#7c3aed", roughness: 0.45, metalness: 0.1, emissive: "#2e1065", emissiveIntensity: 0.4 });
  const bead = new THREE.SphereGeometry(1, 14, 10);
  const SEG = 22;
  const tentacles = Array.from({ length: 4 }, () => {
    const beads = Array.from({ length: SEG }, (_, i) => { const m = new THREE.Mesh(bead, mat); m.scale.setScalar(1.6 * (1 - i / SEG) + 0.2); m.visible = false; scene.add(m); return m; });
    return { beads };
  });
  let act = null;   // { kind: "slam" | "grab", at, target, start, onStrike, struck }

  const kraken = {
    active: () => !!act,
    /** Rise beside `at` and slam onto `target`; onStrike fires at the impact. */
    slam(at, target, onStrike) { act = { kind: "slam", at: at.clone(), target: target.clone(), start: performance.now() / 1000, onStrike, struck: false }; fx.splash(at, 1.6); },
    /** Snatch something out of the air at `target`. */
    grab(at, target, onStrike) { act = { kind: "grab", at: at.clone(), target: target.clone(), start: performance.now() / 1000, onStrike, struck: false }; fx.splash(at, 1.2); },
    update(t) {
      if (!act) return;
      const k = performance.now() / 1000 - act.start;
      const dur = act.kind === "grab" ? 2.6 : 4.4;
      const rise = Math.min(1, k / 1.1), sink = k > dur - 1 ? Math.max(0, 1 - (k - (dur - 1))) : 1;
      const strikeAt = act.kind === "grab" ? 0.7 : 2.5;
      const strike = Math.min(1, Math.max(0, (k - strikeAt) / 0.35));
      if (strike >= 1 && !act.struck) { act.struck = true; act.onStrike?.(); }
      tentacles.forEach((ten, ti) => {
        const off = V((ti - 1.5) * 5, 0, (ti % 2 ? 4 : -4));
        const root = act.at.clone().add(off).setY(-2);
        const lean = act.kind === "grab" && ti > 0 ? 0 : strike;
        const tipAim = act.target.clone().add(V(off.x * 0.3, 0, off.z * 0.3));
        ten.beads.forEach((m, i) => {
          const f = i / (SEG - 1);
          const h = 26 * f * rise * sink * (act.kind === "grab" && ti === 0 ? 1.4 : 1);
          const sway = Math.sin(t * 2.2 + ti * 1.7 + f * 4) * 4 * f;
          const up = root.clone().add(V(sway, h, Math.cos(t * 1.8 + ti + f * 3) * 3 * f));
          const towards = root.clone().lerp(tipAim, f);
          towards.y = Math.max(-1, tipAim.y * f + Math.sin(f * Math.PI) * 10);
          m.position.copy(up.lerp(towards, lean * f));
          m.visible = sink > 0.02;
        });
      });
      if (k > dur) { act = null; tentacles.forEach((ten) => ten.beads.forEach((m) => { m.visible = false; })); }
    },
  };
  return kraken;
}
