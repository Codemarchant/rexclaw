// Rexmaw Raids v3: where to go, drawn in the world (spec A1, B8, C10).
//
//   objective   the current step's marker (core `state.objective.marker`):
//               area / point (or a ship's last known spot, `seen:false`) → a tall gilt light pillar
//               (a camera-facing beam, readable against a day sky — a solid core with a soft halo —
//               glowing at night, seen through fog: its fog is a third of the scene's) and a pulsing
//               ring on the water at `r` (rings of light running in from the edge);
//               ship → a bobbing gilt chevron over her masts with a distance label ("Saltcellar · 420 m").
//               The bonus marker (`objective.bonus.marker`) is the same, smaller and silver-pale.
//   boarding    every eligible ship in `state.boardable` gets an ellipse on the water 30 m out from her
//               hull (her heading turns it): dashed and pale while out of reach, solid and pulsing amber
//               when `inRange` (B works). The HUD's "B — BOARD" prompt anchors over her (`boardAnchor`).
//   off-screen  `objectiveScreen()` gives the HUD the marker's screen point, or where its arrow goes on
//               the edge (and the arrow's angle) when it's off screen or behind the camera.
//
// Pooled at fixed sizes (2 pillars + 2 rings + 2 chevrons + 4 boarding rings), shown once by
// compile(). NaN-safe: every number from the state passes Number.isFinite before it's used.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { LAYERS, WATER_Y } from "./blocking.js";
import { SEA_HEIGHT_GLSL } from "./water.js";

const clamp = THREE.MathUtils.clamp;
const fin = (v) => Number.isFinite(+v);
const GILT = new THREE.Color("#ffcf6b"), PALE = new THREE.Color("#dfe8ff"), AMBER = new THREE.Color("#ffad42"), BOARD_IDLE = new THREE.Color("#f3ead2");
const BOARD_RANGE = 30;                 // core BOARD.range: hull to hull
const BOARDS = 4;
const PILLAR_H = 240;
/** Mast heights by class (m above the water), for the chevron and the boarding prompt. */
const MAST_H = { gunboat: 15, merchant: 30, brig: 30, frigate: 40, fireship: 22, manowar: 50, ironduke: 58, gloam: 44, tower: 22 };
const HALF = { gunboat: [2.4, 9], merchant: [4.6, 15], brig: [4.2, 15], frigate: [5.2, 20], fireship: [3.6, 12], manowar: [7, 27], ironduke: [8, 32], gloam: [5.5, 21] };

const SEA_VERT = /* glsl */`
  uniform float uTime;
  ${SEA_HEIGHT_GLSL}`;

/**
 * @param {object} R  the render context
 * @param {{water: object, fleet: object, posOf: (id: string, out: THREE.Vector3) => THREE.Vector3|null}} deps
 */
export function createMarkers(R, { water, fleet, posOf }) {
  const root = new THREE.Group();
  root.name = "markers";
  R.scene.add(root);
  const wu = water.uniforms;
  const disposables = [];

  // ---- The pillar: a camera-facing beam (cylindrical billboard), one quad ----
  const pillarGeo = new THREE.PlaneGeometry(1, 1, 1, 8);
  pillarGeo.translate(0, 0.5, 0);
  const pillarMat = new THREE.ShaderMaterial({
    name: "RexmawObjectivePillar", transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTime: wu.uTime, uFogDensity: wu.uFogDensity, uFogColor: wu.uFogColor, uDay: { value: 0 }, uColor: { value: GILT.clone() },
      uHeight: { value: PILLAR_H }, uWidth: { value: 6 }, uAlpha: { value: 1 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */`
      uniform float uHeight, uWidth;
      varying vec2 vUv; varying float vDist; varying float vY;
      void main() {
        vUv = uv;
        vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = cameraPosition - c; toCam.y = 0.0;
        float d = max(length(toCam), 1e-3);
        vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-5, 0.0, 0.0));
        // Never thinner than ~3 px: the beam widens with distance.
        float w = max(uWidth, d * 0.006);
        vec3 p = c + right * position.x * w + vec3(0.0, position.y * uHeight, 0.0);
        vDist = d; vY = position.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uDay, uAlpha, uSeed;
      uniform vec3 uColor, uFogColor;
      varying vec2 vUv; varying float vDist; varying float vY;
      void main() {
        float x = (vUv.x - 0.5) * 2.0;
        float core = exp(-x * x * 26.0), halo = exp(-x * x * 3.2);
        float up = vY;
        float fadeUp = (1.0 - smoothstep(0.35, 1.0, up)) * (0.55 + 0.45 * (1.0 - up));
        float base = smoothstep(0.0, 0.015, up);
        // Light rising up the beam.
        float bands = 0.9 + 0.1 * sin(up * 40.0 - uTime * 2.2 + uSeed);
        // Fog: a third of the scene's, so the beam reads through the mist (it's the target).
        float fd = uFogDensity * vDist * 0.33;
        float seen = exp(-fd * fd);
        float glow = (core * 1.4 + halo * 0.35) * fadeUp * base * bands * uAlpha;
        // Premultiplied: by day the core covers the sky (alpha), at night it adds (bloom).
        // By day a deeper gold (it has to stand out from a pale sky); at night it glows.
        vec3 rgb = mix(uColor, uColor * vec3(1.0, 0.72, 0.32), uDay * core) * glow * mix(2.2, 1.15, uDay);
        float a = clamp((core * 0.85 + halo * 0.12) * fadeUp * base * uAlpha * mix(0.15, 0.8, uDay), 0.0, 1.0);
        rgb = mix(uFogColor * a, rgb, seen);
        gl_FragColor = vec4(rgb * mix(0.6, 1.0, seen), a * seen);
      }`,
  });
  disposables.push(pillarGeo, pillarMat);

  // ---- The ring on the water: a disc riding the swell, the shader draws the rim and the pulses ----
  const ringGeo = new THREE.RingGeometry(0.0, 1.0, 128, 6);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMatFor = (name) => new THREE.ShaderMaterial({
    name, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { uTime: wu.uTime, uSwellA: wu.uSwellA, uSwellB: wu.uSwellB, uChopA: wu.uChopA, uChopB: wu.uChopB,
      uFogDensity: wu.uFogDensity, uDay: { value: 0 }, uColor: { value: GILT.clone() }, uAlpha: { value: 1 },
      uRadius: { value: 40 }, uScale: { value: new THREE.Vector2(1, 1) }, uDash: { value: 0 }, uPulse: { value: 1 }, uFill: { value: 0.06 }, uFogK: { value: 0.33 } },
    vertexShader: /* glsl */`
      ${SEA_VERT}
      varying vec2 vLocal; varying float vDist;
      void main() {
        vLocal = position.xz;
        vec4 w = modelMatrix * vec4(position, 1.0);
        w.y = ${WATER_Y.toFixed(2)} + seaHeight(w.xz) + 0.12;
        vDist = length(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity, uDay, uAlpha, uRadius, uDash, uPulse, uFill, uFogK;
      uniform vec2 uScale;
      uniform vec3 uColor;
      varying vec2 vLocal; varying float vDist;
      void main() {
        float r = length(vLocal);                       // 0..1 across the disc (an ellipse once scaled)
        float px = max(fwidth(r), 1e-4);
        // The rim: a band ~1.6 m wide whatever the size, kept ≥ 3 px on screen (far off it's a thin ellipse).
        float bw = max(1.6 / max(uRadius, 1.0), px * 3.0);
        float rim = smoothstep(1.0, 1.0 - px, r) * smoothstep(1.0 - bw - px, 1.0 - bw, r);
        // Dashes (boarding, out of reach): 36 round the rim, crawling.
        float ang = atan(vLocal.y, vLocal.x);
        float dash = mix(1.0, step(0.45, fract(ang * 36.0 / 6.2831853 + uTime * 0.25)), uDash);
        // Rings of light running in from the rim every 2.2 s, and a faint fill.
        float ph = fract(uTime / 2.2);
        float pr = 1.0 - ph * 0.9;
        float pulse = exp(-pow((r - pr) * uRadius / 2.2, 2.0)) * (1.0 - ph) * uPulse * step(r, 1.0);
        float breathe = 0.8 + 0.2 * sin(uTime * 3.1);
        float fill = uFill * smoothstep(1.0, 0.2, r) * step(r, 1.0);
        float k = (rim * dash * breathe + pulse * 0.55 + fill) * uAlpha;
        float fd = uFogDensity * vDist * uFogK;
        float seen = exp(-fd * fd);
        vec3 rgb = mix(uColor, uColor * vec3(1.0, 0.8, 0.45), uDay) * k * mix(1.9, 1.35, uDay);
        float a = clamp(k * mix(0.25, 0.95, uDay), 0.0, 1.0);
        gl_FragColor = vec4(rgb * seen, a * seen);
      }`,
  });
  disposables.push(ringGeo);

  // ---- The chevron over a ship: a V that points down, gilt with a dark keel line (readable on a bright sky) ----
  const chevGeo = (() => {
    const s = new THREE.Shape();
    s.moveTo(-3.2, 3.0); s.lineTo(0, 0); s.lineTo(3.2, 3.0); s.lineTo(3.2, 4.4); s.lineTo(0, 1.5); s.lineTo(-3.2, 4.4); s.lineTo(-3.2, 3.0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false });
    g.translate(0, 0, -0.25);
    return g;
  })();
  const chevMat = new THREE.MeshBasicMaterial({ name: "RexmawChevron", color: GILT.clone().multiplyScalar(1.6), fog: false, toneMapped: true, transparent: true, depthTest: false, depthWrite: false });
  const chevBack = new THREE.MeshBasicMaterial({ name: "RexmawChevronEdge", color: new THREE.Color("#1a1006"), fog: false, side: THREE.BackSide, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
  disposables.push(chevGeo, chevMat, chevBack);

  function makeLabel(cls) {
    const el = document.createElement("div");
    el.className = `nr-world-marker ${cls}`;
    el.style.cssText = "pointer-events:none;white-space:nowrap;font:600 13px/1.2 Georgia,serif;letter-spacing:.04em;color:#ffdf8f;"
      + "text-shadow:0 1px 2px #000,0 0 6px rgba(0,0,0,.85);padding:2px 8px;border-radius:3px;background:rgba(8,10,16,.42);transition:opacity .25s";
    const o = new CSS2DObject(el);
    o.center.set(0.5, 1);
    o.visible = false;
    root.add(o);
    return { el, o, text: "" };
  }
  const setText = (L, t) => { if (L.text !== t) { L.text = t; L.el.textContent = t; } };

  /** One objective marker (pillar + ring + chevron + label). */
  function makeObjective(main) {
    const pillar = new THREE.Mesh(pillarGeo, main ? pillarMat : pillarMat.clone());
    pillar.frustumCulled = false; pillar.renderOrder = 6; pillar.layers.set(LAYERS.NOREFLECT); pillar.visible = false;
    if (!main) { pillar.material.uniforms.uColor.value = PALE.clone(); pillar.material.uniforms.uWidth.value = 3.5; pillar.material.uniforms.uHeight.value = 120; pillar.material.uniforms.uSeed.value = 2.1; pillar.material.uniforms.uTime = wu.uTime; pillar.material.uniforms.uFogDensity = wu.uFogDensity; pillar.material.uniforms.uFogColor = wu.uFogColor; disposables.push(pillar.material); }
    const ring = new THREE.Mesh(ringGeo, ringMatFor(main ? "RexmawObjectiveRing" : "RexmawBonusRing"));
    ring.frustumCulled = false; ring.renderOrder = 4; ring.layers.set(LAYERS.NOREFLECT); ring.visible = false;
    if (!main) { ring.material.uniforms.uColor.value = PALE.clone(); ring.material.uniforms.uAlpha.value = 0.6; ring.material.uniforms.uPulse.value = 0.4; }
    disposables.push(ring.material);
    const chev = new THREE.Group();
    const c1 = new THREE.Mesh(chevGeo, chevMat), c2 = new THREE.Mesh(chevGeo, chevBack);
    c2.scale.setScalar(1.12); c2.position.y = -0.2;
    c1.renderOrder = 21; c2.renderOrder = 20;
    for (const m of [c1, c2]) { m.frustumCulled = false; m.layers.set(LAYERS.NOREFLECT); }
    chev.add(c2, c1);
    chev.visible = false;
    if (!main) chev.scale.setScalar(0.6);
    root.add(pillar, ring, chev);
    return { main, pillar, ring, chev, label: makeLabel(main ? "objective" : "bonus"), anchor: new THREE.Vector3(), on: false, key: "", ship: null, dist: 0 };
  }
  const objectives = [makeObjective(true), makeObjective(false)];

  // ---- Boarding rings ----
  const boards = [];
  for (let i = 0; i < BOARDS; i++) {
    const ring = new THREE.Mesh(ringGeo, ringMatFor("RexmawBoardRing"));
    ring.frustumCulled = false; ring.renderOrder = 4; ring.layers.set(LAYERS.NOREFLECT); ring.visible = false;
    ring.material.uniforms.uFogK.value = 0.6;
    disposables.push(ring.material);
    root.add(ring);
    boards.push({ ring, id: null, inRange: false });
  }

  const S = { state: null, day: 0, time: 0, ship: { x: 0, z: 0 } };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _cam = new THREE.Vector3();

  const contactOf = (id) => (S.state?.contacts || []).find((c) => c.id === id) || null;
  const clsOf = (c) => { const k = fleet.info?.(c?.id)?.kind; return k || c?.cls || "brig"; };
  const mastH = (c) => MAST_H[clsOf(c)] ?? 32;

  /** Where the marker's world anchor is (the chevron's tip over a ship, else the pillar a little above the sea). */
  function placeObjective(o, m, dt) {
    if (!m || !fin(m.x) || !fin(m.z)) {
      if (o.on) { o.on = false; o.pillar.visible = o.ring.visible = o.chev.visible = false; o.label.o.visible = false; }
      return;
    }
    o.on = true;
    const shipId = m.kind === "ship" && m.seen !== false ? (m.contactId ?? m.id ?? null) : null;
    const c = shipId != null ? contactOf(shipId) : null;
    const p = shipId != null ? posOf(shipId, _v) : null;
    const sh = S.ship;
    if (p) {
      // A ship: the chevron bobs over her masts; it grows with distance so it stays a readable size.
      o.pillar.visible = false; o.ring.visible = false; o.chev.visible = true;
      R.camera.getWorldPosition(_cam);
      const d = _cam.distanceTo(p);
      const k = clamp(d / 110, 1, 9);
      const top = WATER_Y + mastH(c) + 4 + 3 * k + Math.sin(S.time * 2.4) * 1.1 * k;
      o.chev.position.set(p.x, top, p.z);
      o.chev.scale.setScalar((o.main ? 1 : 0.6) * k);
      o.chev.rotation.y = Math.atan2(_cam.x - p.x, _cam.z - p.z);
      o.anchor.set(p.x, top + 4.6 * k, p.z);
      o.ship = shipId;
    } else {
      // An area or a point (or a ship's last known spot): the pillar and the ring.
      const r = clamp(fin(m.r) ? +m.r : m.kind === "point" ? 14 : 45, 6, 400);
      o.chev.visible = false; o.pillar.visible = true; o.ring.visible = true;
      o.pillar.position.set(+m.x, WATER_Y, +m.z);
      o.ring.position.set(+m.x, WATER_Y, +m.z);
      o.ring.scale.set(r, 1, r);
      const u = o.ring.material.uniforms;
      u.uRadius.value = r; u.uDash.value = m.seen === false ? 1 : 0;
      o.anchor.set(+m.x, WATER_Y + 26, +m.z);
      o.ship = null;
    }
    // The label: name · distance from the Rexmaw.
    const dist = fin(m.dist) ? +m.dist : Math.hypot((p ? p.x : +m.x) - sh.x, (p ? p.z : +m.z) - sh.z);
    o.dist = dist;
    const name = (m.label || c?.name || (o.main ? "Objective" : "Bonus")).toString();
    setText(o.label, `${name} · ${dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : Math.round(dist / 10) * 10 + " m"}`);
    o.label.o.position.copy(o.anchor);
    o.label.o.visible = true;
    o.label.el.style.opacity = o.main ? "1" : "0.75";
    o.label.el.style.color = o.main ? "#ffdf8f" : "#dfe8ff";
  }

  function placeBoards() {
    // No rings on the water while we're aboard her: the deck fight has the screen.
    const list = Array.isArray(S.state?.boardable) && !S.state?.boardfight ? S.state.boardable : [];
    let n = 0;
    for (const b of list) {
      if (n >= BOARDS) break;
      const id = b?.contactId ?? b?.id;
      const p = id != null ? posOf(id, _v) : null;
      if (!p) continue;
      const c = contactOf(id);
      const info = fleet.info?.(id);
      const [hb, hl] = info && fin(info.B) && fin(info.L) ? [info.B / 2, info.L / 2] : (HALF[clsOf(c)] || [4.5, 15]);
      const slot = boards[n++];
      slot.id = id;
      slot.inRange = !!b.inRange && !b.problem;
      const ring = slot.ring, u = ring.material.uniforms;
      // v4: the core's own ring (`boardable[].ring` {x, z, heading, ax, az}: the ellipse B works inside), so the
      // drawn ring and the rule agree; else (older cores) her hull + 30 m (+ ours) along her heading.
      const rg = b.ring && fin(b.ring.ax) && fin(b.ring.az) && +b.ring.ax > 0 && +b.ring.az > 0 ? b.ring : null;
      const ax = rg ? +rg.ax : hb + BOARD_RANGE + 4.4, az = rg ? +rg.az : hl + BOARD_RANGE + 4.4;
      ring.position.set(rg && fin(rg.x) ? +rg.x : p.x, WATER_Y, rg && fin(rg.z) ? +rg.z : p.z);
      const hd = rg && fin(rg.heading) ? +rg.heading : fin(c?.heading) ? +c.heading : fin(info?.heading) ? +info.heading : 0;
      ring.rotation.y = -hd * Math.PI / 180;
      ring.scale.set(ax, 1, az);
      u.uRadius.value = (ax + az) / 2;
      u.uDash.value = slot.inRange ? 0 : 1;
      u.uColor.value.copy(slot.inRange ? AMBER : BOARD_IDLE);
      u.uPulse.value = slot.inRange ? 1 : 0;
      u.uFill.value = slot.inRange ? 0.08 : 0.02;
      u.uAlpha.value = slot.inRange ? 1 : 0.7;
      ring.visible = true;
    }
    for (let i = n; i < BOARDS; i++) { boards[i].ring.visible = false; boards[i].id = null; }
  }

  function update(state, dt) {
    S.state = state;
    S.time += dt;
    S.day = R.atmos?.day || 0;
    const sh = state?.ship;
    if (sh && fin(sh.x) && fin(sh.z)) { S.ship.x = +sh.x; S.ship.z = +sh.z; }
    const live = state && state.phase !== "title" && state.phase !== "briefing" && state.phase !== "moored" && state.phase !== "results";
    const obj = live ? state.objective : null;
    const active = obj && (obj.status == null || obj.status === "active");
    placeObjective(objectives[0], active ? obj.marker : null, dt);
    const bonus = active && obj.bonus && !obj.bonus.done && !obj.bonus.failed ? obj.bonus.marker : null;
    placeObjective(objectives[1], bonus, dt);
    if (live) placeBoards(); else for (const b of boards) b.ring.visible = false;
    for (const m of [pillarMat, ...objectives.map((o) => o.pillar.material), ...objectives.map((o) => o.ring.material), ...boards.map((b) => b.ring.material)]) m.uniforms.uDay.value = S.day;
  }

  /** A world point → {x, y, visible, onScreen, behind, ndc} (client px). */
  function project(p) {
    R.camera.updateMatrixWorld();
    _w.copy(p).project(R.camera);
    const r = R.renderer.domElement.getBoundingClientRect();
    // Behind the lens (w < 0): the projection mirrors; flip it so the arrow points the right way.
    _v.copy(p).applyMatrix4(R.camera.matrixWorldInverse);
    const behind = _v.z > 0;
    let nx = _w.x, ny = _w.y;
    if (behind) { nx = -nx; ny = -ny; }
    const onScreen = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
    return { x: r.left + (nx * 0.5 + 0.5) * r.width, y: r.top + (-ny * 0.5 + 0.5) * r.height, nx, ny, onScreen, behind, rect: r };
  }

  /** The screen-edge point and angle for an arrow toward an off-screen (or behind) point. */
  function edgeOf(pr, margin) {
    const r = pr.rect;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = pr.x - cx, dy = pr.y - cy;
    if (pr.behind && Math.abs(dy) < 1e-3 && Math.abs(dx) < 1e-3) dy = r.height;   // dead astern: point down
    if (pr.behind) dy = Math.max(dy, Math.abs(dx) * 0.25 + 1);                        // behind: the arrow leans to the bottom edge
    const hw = r.width / 2 - margin, hh = r.height / 2 - margin;
    const s = Math.min(hw / Math.max(Math.abs(dx), 1e-3), hh / Math.max(Math.abs(dy), 1e-3));
    return { x: cx + dx * s, y: cy + dy * s, angle: Math.atan2(dy, dx) * 180 / Math.PI };
  }

  const api = {
    root, update,
    /**
     * The objective marker on screen for the HUD: {active, kind, id, label, dist, x, y, onScreen, behind,
     * edge:{x, y, angle (deg, 0 = right, 90 = down)}} — `edge` is where the off-screen arrow goes. null when no marker.
     */
    objectiveScreen({ margin = 48, bonus = false } = {}) {
      const o = objectives[bonus ? 1 : 0];
      if (!o.on) return null;
      const pr = project(o.anchor);
      return { active: true, kind: o.ship ? "ship" : "area", id: o.ship, label: o.label.text, dist: o.dist, x: pr.x, y: pr.y, onScreen: pr.onScreen, behind: pr.behind,
        visible: pr.onScreen, edge: pr.onScreen ? null : edgeOf(pr, margin) };
    },
    /** The objective marker's world anchor (Vector3) or null. */
    objectiveAnchor(out = new THREE.Vector3(), { bonus = false } = {}) { const o = objectives[bonus ? 1 : 0]; return o.on ? out.copy(o.anchor) : null; },
    /** The "B — BOARD" prompt's world anchor over ship `id` (default: the nearest eligible one), or null. */
    boardAnchor(id = null, out = new THREE.Vector3()) {
      const list = Array.isArray(S.state?.boardable) ? S.state.boardable : [];
      const b = id != null ? list.find((x) => (x?.contactId ?? x?.id) === id) : list[0];
      const cid = b ? (b.contactId ?? b.id) : id;
      if (cid == null) return null;
      const p = posOf(cid, out);
      if (!p) return null;
      p.y = WATER_Y + mastH(contactOf(cid)) * 0.62;
      return p;
    },
    /** The boarding rings now: [{id, inRange}]. */
    get boards() { return boards.filter((b) => b.ring.visible).map((b) => ({ id: b.id, inRange: b.inRange })); },
    project, edgeOf,
    warmShow(on) {
      for (const o of objectives) { o.pillar.visible = on || (o.on && !o.ship); o.ring.visible = on || (o.on && !o.ship); o.chev.visible = on || (o.on && !!o.ship); }
      for (const b of boards) b.ring.visible = on || b.id != null;
    },
    reset() { for (const o of objectives) { o.on = false; o.pillar.visible = o.ring.visible = o.chev.visible = false; o.label.o.visible = false; } for (const b of boards) { b.ring.visible = false; b.id = null; } },
    stats() { return { objective: objectives[0].on ? (objectives[0].ship ? "chevron" : "pillar") : null, bonus: objectives[1].on, boards: boards.filter((b) => b.ring.visible).length }; },
    dispose() {
      root.removeFromParent();
      for (const o of objectives) o.label.el.remove();
      for (const d of disposables) d.dispose?.();
    },
  };
  return api;
}
