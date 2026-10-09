// Rexmaw Raids: the boarding fight on screen (spec v4 §1) — a short Black Flag-style deck fight.
//
// The core runs the fight (state.boardfight: who's standing, hit points, the captain, the pistol,
// the rally, the outcome); this module stages it on the enemy's deck:
//
//   grapple    hooks fly from our rail and bite into hers (lines that stay, sagging, until the end);
//   swing      our crew (the real VRMs, the companion too) swing across one after another on lines
//              from high overhead and land crouched on her deck;
//   fight      the camera on her deck, wide and readable from over the gap (sails edge-on), easing
//              with the fight. Her crew (sailors.js: red sashes, cutlasses and pistols, 6–12 by class)
//              meet ours in paired duels: swings, stabs, parries, clashes of sparks; a hit flinches,
//              a fall is a topple with a bounce. Every hit the core deals lands as a blow: the duelling
//              partner swings and the target reels (or falls). Pistol hands aim and fire. Ara kneels by
//              the hurt with her tonic; Rex charges in shoulder first.
//   captain    their captain (bigger, long coat, tricorn, sabre) comes up from his cabin once half his
//              crew are down: a cut to him, a levelled sabre.
//              His heavy blow is telegraphed: sabre high, the blade red-hot, a red ring on the deck
//              closing on his target — then the slam, splinters and a shock.
//   Captain    the user's pistol (a click on a foe): flash and smoke at our rail, a tracer, a spark
//              on the hit, the foe reels or drops. Rally: a golden shockwave across the deck, the crew
//              thrust their blades up.
//   end        won: her colours come down (the white flag), the last of her crew drop their weapons
//              and raise their hands, ours cheer, then swing home. Lost: ours scramble to the rail
//              and swing back, the lines are cut, her crew brandish their blades.
//   whacky     a whacky captain (state.boardfight.archetype, core/boarding.js ARCHETYPES) and their
//              gimmick on screen: the gull coat collapsing into three gulls on the wing, the admiral's
//              tea (steam), Cookie Mabel's pies (an arc, a splat, stars round the dazed head), Pip on
//              Tiny's shoulders (then running in circles, arms flailing), the Baron's bubble shield (an
//              iridescent sphere that pops and regrows) and soap suds, Señor Encore's notes drifting
//              to his crew, Captain Clackers' claw blocks, the Mime's shimmering walls (ours press on
//              them), the Pale Captain fading to a cold glow, skeletons rattling back up, monkeys off
//              up the rigging with a glint of gold.
//   speech     short lines in bubbles over her captain and crew (the archetype's, the crew variant's):
//              bubbles() lists them for the HUD; each one goes out as cue("say") for the babble voice.
//
// The fight never blocks: it's a presentation over the state, tolerant of missing fields.
// See "## boardfight API" in the interfaces doc for the state it reads and the wiring.

import * as THREE from "three";
import { createSailors } from "./sailors.js";
import { createFighter } from "../avatar/fight.js";
import { CLASSES, classOf, shape } from "./shipkit.js";
import { WATER_Y } from "./blocking.js";
import { ARCHETYPES, CREW_VARIANTS } from "../core/boarding.js";

const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
/** Foes per class when the state doesn't list them (spec: 6–12 by ship class). */
const CREW_BY_CLASS = { gunboat: 6, merchant: 6, fireship: 6, brig: 8, frigate: 10, gloam: 10, manowar: 12, ironduke: 12 };
const ROPE_SEG = 10, ROPE_CAP = 16, HOOKS = 8;
const DUEL = 1.45, DUEL_CAPTAIN = 1.9;
/** The hooks fly for this long before the first of ours swings; then one every SWING_GAP (the core's grapple is 2.5 s). */
const GRAPPLE_T = 0.75, SWING_GAP = 0.2;
/** The captain's telegraphed heavy blow: at most one per this many seconds (his other swings are plain). */
const HEAVY_GAP = 7, HEAVY_WINDUP = 1.1;
const CREW_ORDER = ["rex", "leo", "sal", "eve", "ara", "me"];
/** Speech: the gap between chatter lines (s), the most bubbles up at once, a bubble's life (s per character, capped). */
const CHATTER = [4.2, 7.2], BUBBLES_MAX = 3;
const sayDur = (text) => clamp(1.5 + String(text).length * 0.05, 1.6, 4);
const pickOf = (a) => (Array.isArray(a) && a.length ? a[Math.floor(Math.random() * a.length)] : null);
const isGun = (s) => s && (s.weapon === "pistol" || s.weapon === "musket");

const FX_VERT = `varying vec3 vN; varying vec3 vV; varying vec2 vUv;
void main() { vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
/** The Baron's bubble: clear in the middle, an oil-film rainbow at the rim. */
const BUBBLE_FRAG = `uniform float uOp; uniform float uT; varying vec3 vN; varying vec3 vV;
void main() { float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
  vec3 rain = 0.55 + 0.45 * cos(6.2831 * (f * 1.3 + uT * 0.15 + vec3(0.0, 0.33, 0.67)));
  vec3 c = mix(vec3(0.85, 0.95, 1.0), rain, 0.65) * (0.25 + 1.4 * f);
  gl_FragColor = vec4(c, (0.06 + 0.8 * f) * uOp); }`;
/** The Mime's wall: a faint pane, brighter at its edges, a slow shimmer running up it. */
const WALL_FRAG = `uniform float uOp; uniform float uT; varying vec2 vUv;
void main() { vec2 e = min(vUv, 1.0 - vUv); float edge = 1.0 - smoothstep(0.0, 0.06, min(e.x, e.y));
  float sh = 0.5 + 0.5 * sin(vUv.y * 26.0 - uT * 5.0 + vUv.x * 6.0);
  float a = (0.07 + 0.55 * edge + 0.1 * sh) * uOp;
  gl_FragColor = vec4(vec3(0.85, 0.93, 1.0) * (0.8 + 0.6 * edge), a); }`;

function glyphTexture(ch, size = 64) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.font = `bold ${Math.round(size * 0.78)}px serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "rgba(255,255,255,0.8)"; g.shadowBlur = size * 0.08;
  g.fillText(ch, size / 2, size * 0.54);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** The boardfight object out of a state (a few spellings), or null. */
export function boardFightOf(state) {
  const b = state?.boardfight ?? state?.boardFight ?? state?.board_fight ?? null;
  return b && typeof b === "object" ? b : null;
}
const listOf = (x) => (Array.isArray(x) ? x.filter(Boolean) : x && typeof x === "object" ? Object.entries(x).map(([id, v]) => ({ id, ...(v || {}) })) : []);
const hpOf = (o) => (Number.isFinite(+o?.hp) ? +o.hp : Number.isFinite(+o?.health) ? +o.health : null);
const hpMaxOf = (o) => (Number.isFinite(+o?.hpMax) ? +o.hpMax : Number.isFinite(+o?.maxHp) ? +o.maxHp : Number.isFinite(+o?.max) ? +o.max : null);
const isDown = (o) => !!(o && (o.down || o.dead || o.out || o.ko || o.state === "down" || (hpOf(o) != null && hpOf(o) <= 0)));

/**
 * Build the boarding fight's stage (pooled; nothing shows until start()).
 * @param {object} R  the render context
 * @param {{crew?: object|(() => object), fleet?: object, fx?: object, camera?: object|null, cue?: (name: string, p: object) => void,
 *   state?: () => object}} deps
 *   crew: crew.js's api (or a getter: main rebuilds the crew); fleet: world.fleet; fx: world.fx;
 *   camera: world.shots (its board(enemyId, {force}) / boardEnd() hold the cinematic slot; this module moves the
 *   lens through R.cam.shot("board", …)); cue: presentation beats for the audio (clash, hit, land, slam, pistol, rally…).
 */
export function createBoardFight(R, { crew = null, fleet = null, fx = null, camera = null, cue = null } = {}) {
  const crewOf = () => (typeof crew === "function" ? crew() : crew);
  const sailors = createSailors(R);
  const cueOut = (name, p = {}) => { try { cue?.(name, p); } catch { /* the audio is a nicety */ } };
  const ship = R.shipSpace;

  // ---- Pooled extras: the lines (grapples and swing lines), the hooks, the rings on the deck ----
  const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 5, 1, true).translate(0, 0.5, 0);
  const ropeMat = new THREE.MeshStandardMaterial({ name: "rr-bf-rope", color: "#a48254", roughness: 0.92, emissive: new THREE.Color("#2a2014"), emissiveIntensity: 0.6 });
  const ropes = new THREE.InstancedMesh(ropeGeo, ropeMat, ROPE_CAP * ROPE_SEG);
  ropes.name = "boardfight.ropes"; ropes.frustumCulled = false; ropes.count = 0; ropes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const hookGeo = (() => {
    const parts = [new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6).translate(0, 0.22, 0)];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.TorusGeometry(0.13, 0.022, 4, 8, Math.PI * 0.9).rotateY(Math.PI / 2).translate(0, 0.0, 0.13).rotateY((i / 3) * Math.PI * 2);
      parts.push(g);
    }
    const nonIdx = parts.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k); return n; });
    let count = 0; for (const g of nonIdx) count += g.attributes.position.count;
    const P = new Float32Array(count * 3), N = new Float32Array(count * 3);
    let o = 0;
    for (const g of nonIdx) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    return out;
  })();
  const hookMat = new THREE.MeshStandardMaterial({ name: "rr-bf-hook", color: "#3a3c40", roughness: 0.4, metalness: 0.8 });
  const hooks = new THREE.InstancedMesh(hookGeo, hookMat, HOOKS);
  hooks.name = "boardfight.hooks"; hooks.frustumCulled = false; hooks.count = 0; hooks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  R.scene.add(ropes, hooks);
  ropes.visible = hooks.visible = false;

  const ringTex = (() => {
    const N = 128, c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(N / 2, N / 2, N * 0.28, N / 2, N / 2, N / 2);
    grad.addColorStop(0, "rgba(255,255,255,0)"); grad.addColorStop(0.55, "rgba(255,255,255,0.15)"); grad.addColorStop(0.82, "rgba(255,255,255,1)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const makeRing = (name, color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: ringTex, color: new THREE.Color(color), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    m.name = name; m.visible = false; m.renderOrder = 7; m.frustumCulled = false;
    return m;
  };
  const rallyRing = makeRing("boardfight.rally", "#ffcf5a");
  const rallyRing2 = makeRing("boardfight.rally2", "#fff0b0");
  const warnRing = makeRing("boardfight.telegraph", "#ff3a22");
  const shockRing = makeRing("boardfight.shock", "#ffb070");
  const rings = [rallyRing, rallyRing2, warnRing, shockRing];

  // The stage: a group riding the enemy ship's body (her frame: +Z bow, +X port, y = 0 at the waterline).
  const stage = new THREE.Group();
  stage.name = "boardfight-stage";
  stage.add(sailors.group, ...rings);
  // A warm work-light over the fight by night (battle lanterns): always in the scene at 0 when idle, so adding it
  // never recompiles the lit materials.
  const fightLight = new THREE.PointLight("#ffc890", 0, 24, 2);
  fightLight.name = "boardfight.light";
  R.scene.add(fightLight);

  // ---- The whacky captains' extras (all on the stage, pooled, hidden until a gimmick wants them) ----
  const FXL = R?.LAYERS?.FX ?? 4;
  const shieldMat = new THREE.ShaderMaterial({ name: "rr-bf-bubble", vertexShader: FX_VERT, fragmentShader: BUBBLE_FRAG, uniforms: { uOp: { value: 0 }, uT: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const shield = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), shieldMat);
  shield.name = "boardfight.bubble-shield"; shield.visible = false; shield.renderOrder = 9; shield.layers.set(FXL); shield.frustumCulled = false;
  const wallMat = new THREE.ShaderMaterial({ name: "rr-bf-wall", vertexShader: FX_VERT, fragmentShader: WALL_FRAG, uniforms: { uOp: { value: 0 }, uT: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const wallGeo = new THREE.PlaneGeometry(1.5, 2.1).translate(0, 1.05, 0);
  const walls = Array.from({ length: 3 }, (_, i) => {
    const m = new THREE.Mesh(wallGeo, wallMat.clone());
    m.name = `boardfight.mime-wall${i}`; m.visible = false; m.renderOrder = 9; m.layers.set(FXL); m.frustumCulled = false;
    return m;
  });
  const noteTex = [glyphTexture("♪"), glyphTexture("♫")];
  const notes = Array.from({ length: 16 }, (_, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: noteTex[i % 2], color: new THREE.Color("#ffe27a").multiplyScalar(1.6), transparent: true, depthWrite: false, opacity: 0 }));
    s.name = "boardfight.note"; s.visible = false; s.scale.setScalar(0.32); s.layers.set(FXL); s.renderOrder = 9;
    s.userData = { life: 0, t: 0, v: new THREE.Vector3() };
    return s;
  });
  const starTex = glyphTexture("★");
  const stars = Array.from({ length: 9 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: new THREE.Color("#ffe060").multiplyScalar(1.8), transparent: true, depthWrite: false }));
    s.name = "boardfight.daze-star"; s.visible = false; s.scale.setScalar(0.17); s.layers.set(FXL); s.renderOrder = 9;
    return s;
  });
  const pieGeo = (() => {
    const p = (g, hex) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k);
      const c = new THREE.Color(hex), a = new Float32Array(n.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
      n.setAttribute("color", new THREE.BufferAttribute(a, 3)); return n; };
    const gs = [p(new THREE.CylinderGeometry(0.16, 0.13, 0.06, 16), "#c8883a"), p(new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.02, 0), "#fff6dc")];
    let count = 0; for (const g of gs) count += g.attributes.position.count;
    const P = new Float32Array(count * 3), N = new Float32Array(count * 3), Cc = new Float32Array(count * 3);
    let o = 0; for (const g of gs) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); Cc.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(P, 3)); out.setAttribute("normal", new THREE.BufferAttribute(N, 3)); out.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    return out;
  })();
  const pieMat = new THREE.MeshStandardMaterial({ name: "rr-bf-pie", vertexColors: true, roughness: 0.7, emissive: new THREE.Color("#2a1a08"), emissiveIntensity: 0.6 });
  const pies = Array.from({ length: 2 }, () => { const m = new THREE.Mesh(pieGeo, pieMat); m.name = "boardfight.pie"; m.visible = false; m.userData = { fly: null }; return m; });
  const ghostTex = (() => {
    const N = 64, c = document.createElement("canvas"); c.width = c.height = N;
    const g = c.getContext("2d"), grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    grad.addColorStop(0, "rgba(200,245,255,1)"); grad.addColorStop(0.45, "rgba(120,210,235,0.45)"); grad.addColorStop(1, "rgba(80,160,200,0)");
    g.fillStyle = grad; g.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const ghost = new THREE.Sprite(new THREE.SpriteMaterial({ map: ghostTex, color: new THREE.Color("#bff0ff").multiplyScalar(1.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
  ghost.name = "boardfight.pale-glow"; ghost.visible = false; ghost.layers.set(FXL); ghost.renderOrder = 9;
  const sudsTex = (() => {
    const N = 64, c = document.createElement("canvas"); c.width = c.height = N;
    const g = c.getContext("2d");
    for (let i = 0; i < 14; i++) { const x = 10 + Math.random() * 44, y = 10 + Math.random() * 44, r = 3 + Math.random() * 8; g.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.4})`; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const suds = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: sudsTex, transparent: true, depthWrite: false, opacity: 0.8,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 8);
  suds.name = "boardfight.suds"; suds.visible = false; suds.frustumCulled = false; suds.count = 0; suds.renderOrder = 1;
  const extras = [shield, ...walls, ...notes, ...stars, ...pies, ghost, suds];
  stage.add(...extras);

  // ---- The fight's state ----
  let F = null;            // the fight on now (null when none)
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const Yv = new THREE.Vector3(0, 1, 0);

  // ---- Her ship ----

  /** The fleet's ship record for `id` (sh.body: her frame), or null. */
  function shipRec(id) {
    let rec = null;
    fleet?.each?.((sid, sh) => { if (sid === id || String(sid) === String(id)) rec = sh; });
    return rec;
  }

  function setupShip(enemyId, cls, state) {
    const key = classOf(cls || "brig");
    const c = CLASSES[key] || CLASSES.brig;
    const S = shape(c);
    const sh = shipRec(enemyId);
    let body = sh?.body || null, own = null;
    if (!body) {
      // No ship from the fleet (a test, a contact out of the pool): a stand-in frame at the contact.
      own = new THREE.Group();
      own.name = "boardfight-standin";
      R.scene.add(own);
      body = own;
    }
    body.add(stage);
    stage.position.set(0, 0, 0); stage.rotation.set(0, 0, 0);
    // Her own deck crew make way for ours (the fleet's instanced figures): a per-ship view of her class with no spots.
    if (sh && !sh.__bfK) { sh.__bfK = sh.K; sh.K = Object.create(sh.K, { crewSpots: { value: [] } }); }
    const QD = S.QD, FC = S.FC;
    const zMin = S.zOf(QD + 0.035), zMax = S.zOf(FC - 0.03);
    const deckY = (x, z) => S.deck(clamp(S.tOf(z), 0.005, 0.995));
    const halfW = (z) => S.xAt(clamp(S.tOf(z), 0.01, 0.99), deckY(0, z)) * 0.84;
    return { key, c, S, sh, body, own, zMin, zMax, deckY, halfW, enemyId };
  }

  function placeStandin(st) {
    if (!F?.ship.own || !st) return;
    const c = (st.contacts || []).find((x) => String(x.id) === String(F.enemyId));
    if (!c) return;
    F.ship.own.position.set(+c.x || 0, WATER_Y, +c.z || 0);
    F.ship.own.rotation.set(0, -(+c.heading || 0) * Math.PI / 180, 0);
  }

  /** Clamp a point to her waist (between the quarterdeck and forecastle breaks, inside the bulwarks). */
  const clampDeck = (x, z) => {
    const zz = clamp(z, F.ship.zMin, F.ship.zMax);
    const w = F.ship.halfW(zz);
    return [clamp(x, -w, w), zz];
  };
  const clampQD = (x, z) => [clamp(x, -F.ship.halfW(z), F.ship.halfW(z)), z];
  /** The core's deck metres (x + her port, z + her bow; |x| ≤ beam/2, |z| ≤ len/2) → her drawn hull's. */
  const fromCore = (x, z) => {
    const d = F.deckCore;
    const kx = d && +d.beam > 0 ? (F.ship.c.B * 0.84) / (+d.beam / 2) : 1;
    const kz = d && +d.len > 0 ? F.ship.c.L / +d.len : 1;
    return [x * kx * F.mirror, z * kz];
  };
  /** A z along her deck at least `gap` m from every mast (a lens there would stare into the mast). */
  const clearOfMasts = (z, gap = 2.6) => {
    const ms = F.ship.c.masts.map((m) => F.ship.S.zOf(m.t));
    for (let k = 0; k < 4; k++) {
      const hit = ms.find((mz) => Math.abs(z - mz) < gap);
      if (hit == null) break;
      z = hit + (z >= hit ? gap : -gap);
    }
    return z;
  };

  // ---- World ↔ her frame ----
  const toStage = (world, out = new THREE.Vector3()) => { stage.updateMatrixWorld(true); return stage.worldToLocal(out.copy(world)); };
  const fromStage = (x, y, z, out = new THREE.Vector3()) => { stage.updateMatrixWorld(true); return stage.localToWorld(out.set(x, y, z)); };
  const toShip = (world, out = new THREE.Vector3()) => { ship.updateMatrixWorld(true); return ship.worldToLocal(out.copy(world)); };
  const fromShip = (x, y, z, out = new THREE.Vector3()) => { ship.updateMatrixWorld(true); return ship.localToWorld(out.set(x, y, z)); };

  // ---- Start ----

  /**
   * Start staging a fight. `state` is run.state() (its boardfight), or a boardfight object itself.
   * Safe to call again for the same fight (ignored).
   */
  function start(state) {
    const bf = boardFightOf(state) || (state && (state.foes || state.enemyId) ? state : null) || {};
    const enemyId = bf.enemyId ?? bf.enemy?.id ?? bf.shipId ?? bf.target ?? state?.boarding?.enemyId ?? null;
    if (enemyId == null) return false;
    if (F && String(F.enemyId) === String(enemyId) && !F.over) return true;
    if (F) cleanup();
    const contact = (state?.contacts || []).find((x) => String(x.id) === String(enemyId));
    const cls = bf.cls ?? bf.enemy?.cls ?? contact?.cls ?? fleet?.info?.(enemyId)?.kind ?? "brig";
    const shipInfo = setupShip(enemyId, cls, state);
    F = {
      enemyId, cls: shipInfo.key, ship: shipInfo, t: 0, phase: "grapple", over: false, outcome: null, endT: 0, ended: false,
      foes: new Map(), fighters: new Map(), captainId: null, captainShown: false, captainT: -1, captainName: "",
      ropes: [], swingLines: [], cam: { mode: null, t: 0, focus: new THREE.Vector3(), until: 0 }, side: 1,
      lastPistolT: -9, rallyT: -9, warn: null, shock: null, lastAttackSeen: -99, fallbackAttackT: 9, nextIdleShot: 2,
      bf, focus: bf.focus || "crew",
      // The core's fight: its hits waiting for a blow to show them, its downs, its deck (len, beam, side).
      hits: [], downEv: new Map(), coreDriven: false, deckCore: bf.deck || null, mirror: 1, lastHeavyT: -99, warnStartT: -99,
      // Her captain's archetype (the whacky ones), the speech bubbles, the gimmicks' screen state.
      arch: ARCHETYPES[bf.archetype] ? bf.archetype : "normal", says: new Map(), chatterT: 3.5 + Math.random() * 2, hurtSayT: -9,
      fxT: 0, shieldK: 0, shieldPop: null, ghostK: 0, faded: false, sudsOn: false,
    };
    placeStandin(state);
    stage.updateMatrixWorld(true);
    // Which of her sides faces us (measured: what's drawn wins; the core's deck x is mirrored if it disagrees).
    const us = fromShip(0, 0, 3, _v);
    F.side = toStage(us, _w).x >= 0 ? 1 : -1;
    const coreSide = +bf.deck?.side;
    if (coreSide === 1 || coreSide === -1) F.mirror = coreSide === F.side ? 1 : -1;
    const zMid = (shipInfo.zMin + shipInfo.zMax) / 2;
    F.zMid = zMid;
    spawnFoes(bf);
    takeCrew(bf);
    throwGrapples();
    camera?.board?.(enemyId, { force: true });
    F.cam.focus.set(F.side * shipInfo.halfW(zMid) * 0.3, shipInfo.deckY(0, zMid), zMid);
    shot("grapple", { cut: true });
    cueOut("boardfight_start", { enemyId });
    return true;
  }

  function spawnFoes(bf) {
    const SI = F.ship;
    const list = listOf(bf.foes ?? bf.enemies ?? bf.sailors);
    let capt = bf.captain && typeof bf.captain === "object" ? bf.captain : null;
    const fromList = list.find((f) => f.kind === "captain" || f.boss || f.captain);
    if (!capt && fromList) capt = fromList;
    const sailorsIn = list.filter((f) => f !== fromList);
    const n = sailorsIn.length || CREW_BY_CLASS[F.cls] || 8;
    const navy = !!SI.c.flag && SI.c.flag !== "merchant";
    const out = [];
    const side = F.side;
    // A loose crowd across the waist, thicker on the far side, facing our rail.
    const cols = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const src = sailorsIn[i] || {};
      const id = String(src.id ?? `s${i}`);
      const row = i % 2, col = Math.floor(i / 2);
      let z = THREE.MathUtils.lerp(SI.zMin + 1, SI.zMax - 1, cols > 1 ? col / (cols - 1) : 0.5) + rand(-0.6, 0.6);
      const w = SI.halfW(z);
      let x = -side * w * (row ? 0.55 : 0.05) + rand(-0.4, 0.4);
      // Where the core put them, when it says.
      if (Number.isFinite(+src.x) && Number.isFinite(+src.z)) [x, z] = clampDeck(...fromCore(+src.x, +src.z));
      const gunner = src.kind === "gunner" || src.weapon === "pistol" || src.weapon === "musket" || (!src.kind && i % 4 === 3);
      const look = src.look || (src.kind === "monkey" ? "monkey" : navy && gunner ? "marine" : "sailor");
      out.push({ id, kind: src.kind === "gull" ? "gull" : "sailor", look, gunner, x, z, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2, seed: i * 13 + 5, navy });
      F.foes.set(id, { id, kind: "sailor", look, hp: hpOf(src) ?? 30, hpMax: hpMaxOf(src) ?? hpOf(src) ?? 30, down: isDown(src), engagedBy: null, next: rand(0.5, 2), aimT: rand(2, 5), seen: false, name: src.name || null });
    }
    // The captain: in his cabin (hidden) until he's called up (present on a resumed fight he's already in).
    const capId = String(capt?.id ?? "captain");
    const present = !!capt?.present;
    const cz = SI.S.zOf(0.13);
    out.push({ id: capId, kind: "captain", look: F.arch !== "normal" ? F.arch : null, x: 0, z: present ? cz : SI.S.zOf(SI.S.QD) - 0.5, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2, seed: 99,
      navy, coat: navy ? "navy" : SI.c.flag === "merchant" ? "merchant" : "pirate", hidden: !present });
    F.captainId = capId;
    F.captainName = capt?.name || bf.captainName || "";
    F.foes.set(capId, { id: capId, kind: "captain", look: F.arch, hp: hpOf(capt) ?? 120, hpMax: hpMaxOf(capt) ?? hpOf(capt) ?? 120, down: isDown(capt), engagedBy: null, next: 2, seen: false, present });
    F.captainShown = present;
    sailors.spawn(out);
    for (const f of out) if (F.foes.get(f.id)?.down) { sailors.act(f.id, "down", { dir: [side, 0] }); }
  }

  /** One of hers who turns up mid-fight (Tiny with his captain, the gulls out of the coat): on deck where the core says. */
  function addFoe(src, { at = null } = {}) {
    const id = String(src.id);
    if (F.foes.has(id)) return F.foes.get(id);
    let [x, z] = Number.isFinite(+src.x) ? clampDeck(...fromCore(+src.x, +src.z)) : [0, F.zMid];
    if (at) { x = at.x; z = at.z; }
    const kind = src.kind === "gull" ? "gull" : "sailor";
    const ok = sailors.add({ id, kind, look: src.look || (src.kind === "gull" ? "gull" : "sailor"), gunner: src.kind === "gunner", x, z, yaw: F.side > 0 ? Math.PI / 2 : -Math.PI / 2, seed: id.length * 31 + 7 });
    if (!ok) return null;
    const rec = { id, kind: "sailor", look: src.look || kind, hp: hpOf(src) ?? 30, hpMax: hpMaxOf(src) ?? hpOf(src) ?? 30, down: isDown(src), engagedBy: null, next: rand(0.5, 2), aimT: rand(2, 5), seen: false, name: src.name || null };
    F.foes.set(id, rec);
    return rec;
  }

  function takeCrew(bf) {
    const c = crewOf();
    if (!c) return;
    const listed = listOf(bf.crew ?? bf.party ?? bf.fighters ?? bf.ours);
    const ids = listed.length ? listed.map((x) => String(x.id)) : (c.cast || []).filter((m) => !m.overboard).map((m) => m.id);
    const order = [...ids].sort((a, b) => (CREW_ORDER.indexOf(a) + 9) % 9 - (CREW_ORDER.indexOf(b) + 9) % 9);
    const SI = F.ship;
    const n = order.length;
    let k = 0;
    for (const id of order) {
      const m = c.member?.(id);
      if (!m || m.overboardStage) continue;
      const src = listed.find((x) => String(x.id) === id) || {};
      const f = createFighter(m, { deckY: SI.deckY });
      f.begin(stage);
      const home = new THREE.Vector3(f.x, f.y, f.z);
      // Landing spots along her near rail, spread over the waist.
      const z = THREE.MathUtils.lerp(SI.zMin + 1.4, SI.zMax - 1.4, n > 1 ? k / (n - 1) : 0.5);
      const w = SI.halfW(z);
      const land = new THREE.Vector3(F.side * w * 0.62, SI.deckY(0, z), z);
      F.fighters.set(id, {
        id, f, hp: hpOf(src) ?? 100, hpMax: hpMaxOf(src) ?? hpOf(src) ?? 100, down: false, target: src.target != null ? String(src.target) : null,
        next: rand(0.4, 1.4), land, home, homeShip: toShip(fromStage(home.x, home.y, home.z, _v), new THREE.Vector3()), swingAt: GRAPPLE_T + k * SWING_GAP, landed: false,
        role: id === "ara" ? "healer" : id === "rex" ? "charger" : "fighter", chargeT: 3 + rand(0, 3), healing: null,
      });
      k++;
    }
  }

  // ---- The lines -------------------------------------------------------------------------------

  function throwGrapples() {
    const SI = F.ship;
    const n = 5;
    for (let i = 0; i < n; i++) {
      const z = THREE.MathUtils.lerp(SI.zMin + 0.5, SI.zMax - 0.5, i / (n - 1)) + rand(-0.4, 0.4);
      const w = SI.halfW(z) / 0.84;
      const to = new THREE.Vector3(F.side * (w * 0.98), SI.S.sheer(SI.S.tOf(z)) + SI.S.bulwark(SI.S.tOf(z)) + 0.05, z);
      // From our rail opposite: the nearest point on our side, at the cap rail.
      const tw = fromStage(to.x, to.y, to.z, new THREE.Vector3());
      const tl = toShip(tw, new THREE.Vector3());
      const sx = Math.sign(tl.x) || 1;
      const from = new THREE.Vector3(sx * 4.5, 1.25, clamp(tl.z, -3, 13));
      F.ropes.push({ fromShip: from, toStage: to, t: -i * 0.14, dur: 0.55 + rand(0, 0.15), landed: false, cut: false, fall: null, sag: 1.2 });
    }
  }

  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  function ropeEnds(r, a, b) {
    fromShip(r.fromShip.x, r.fromShip.y, r.fromShip.z, a);
    if (r.fall) { b.copy(r.fall.p); return; }
    fromStage(r.toStage.x, r.toStage.y, r.toStage.z, b);
    if (!r.landed) {
      const k = clamp(r.t / r.dur, 0, 1);
      const arc = Math.sin(k * Math.PI) * (2.5 + a.distanceTo(b) * 0.12);
      b.lerpVectors(a, b, k).y += arc;
    }
  }

  function drawRope(i, a, b, sag) {
    const L = a.distanceTo(b);
    for (let s = 0; s < ROPE_SEG; s++) {
      const u0 = s / ROPE_SEG, u1 = (s + 1) / ROPE_SEG;
      _u.lerpVectors(a, b, u0); _u.y -= sag * 4 * u0 * (1 - u0);
      _p.lerpVectors(a, b, u1); _p.y -= sag * 4 * u1 * (1 - u1);
      const d = _w.subVectors(_p, _u);
      const len = d.length();
      if (len < 1e-4 || !(L > 0)) { ropes.setMatrixAt(i * ROPE_SEG + s, ZERO); continue; }
      _q.setFromUnitVectors(Yv, d.divideScalar(len));
      _m.compose(_u, _q, _s.set(1, len, 1));
      ropes.setMatrixAt(i * ROPE_SEG + s, _m);
    }
  }

  function updateRopes(dt) {
    let i = 0, h = 0;
    for (const r of F.ropes) {
      r.t += dt;
      if (r.t < 0) continue;
      if (!r.landed && !r.fall && r.t >= r.dur) {
        r.landed = true;
        fromStage(r.toStage.x, r.toStage.y, r.toStage.z, _a);
        fx?.sparks?.(_a.clone(), { count: 10, speed: 2.4 });
        fx?.splinters?.(_a.clone(), { count: 5, scale: 0.4 });
        cueOut("grapple_bite", { x: _a.x, y: _a.y, z: _a.z });
      }
      if (r.fall) {
        r.fall.v.y -= 9.8 * dt;
        r.fall.p.addScaledVector(r.fall.v, dt);
        if (r.fall.p.y < WATER_Y - 2) continue;
      }
      ropeEnds(r, _a, _b);
      // Tightening once the hook bites: the sag eases to a working curve.
      r.sag = r.landed && !r.fall ? Math.max(0.35, r.sag - dt * 1.6) : r.fall ? 1.6 : 0.2;
      if (i < ROPE_CAP) drawRope(i++, _a, _b, r.sag);
      if (h < HOOKS) {
        const dir = _c.subVectors(_b, _a).normalize();
        _q.setFromUnitVectors(Yv, dir);
        _m.compose(_b, _q, _s.set(1, 1, 1));
        hooks.setMatrixAt(h++, _m);
      }
    }
    // The swing lines: from high over the gap down to the swinger's raised hand.
    for (const fr of F.fighters.values()) {
      if (!fr.f.leaping || !fr.anchor || i >= ROPE_CAP) continue;
      fr.f.handWorld(_b, "left");
      drawRope(i++, fr.anchor, _b, 0.05);
    }
    ropes.count = i * ROPE_SEG; hooks.count = h;
    ropes.instanceMatrix.needsUpdate = true; hooks.instanceMatrix.needsUpdate = true;
    ropes.visible = i > 0; hooks.visible = h > 0;
  }

  function cutRopes() {
    for (const r of F.ropes) {
      if (r.fall) continue;
      ropeEnds(r, _a, _b);
      r.fall = { p: _b.clone(), v: new THREE.Vector3(rand(-1, 1), rand(0.5, 2), rand(-1, 1)) };
      fx?.sparks?.(_b.clone(), { count: 6, speed: 2 });
    }
  }

  // ---- The swing across ------------------------------------------------------------------------

  function launch(fr, { home = false } = {}) {
    const f = fr.f;
    const from = new THREE.Vector3(f.x, f.y, f.z);
    let to;
    if (home) {
      // Back to where they stood on our deck (in her frame now; the ships drift a little).
      to = toStage(fromShip(fr.homeShip.x, fr.homeShip.y, fr.homeShip.z, _v), new THREE.Vector3());
    } else to = fr.land.clone();
    const d = from.distanceTo(to);
    const ctrl = new THREE.Vector3().lerpVectors(from, to, 0.5);
    ctrl.y = Math.max(from.y, to.y) + 1.1 + d * 0.06;
    // The line's anchor: high over the gap, toward the side they swing from.
    const aw = fromStage(...new THREE.Vector3().lerpVectors(from, to, 0.38).toArray(), new THREE.Vector3());
    fr.anchor = aw.setY(aw.y + 11 + d * 0.15);
    const dur = clamp(0.95 + d / 16, 1.1, 2.3);
    f.leap(from, to, {
      ctrl, dur, onLand: () => {
        fr.landed = !home;
        fr.anchor = null;
        const p = fromStage(to.x, to.y + 0.05, to.z, new THREE.Vector3());
        fx?.splinters?.(p, { count: 6, scale: 0.35 });
        cueOut("land", { who: fr.id, x: p.x, y: p.y, z: p.z, home });
        if (home) fr.home_ = true;
      },
    });
    cueOut("swing", { who: fr.id, home });
  }

  // ---- The camera ------------------------------------------------------------------------------

  /** The fight's focus (her frame): the middle of who's fighting, eased. */
  function stepFocus(dt) {
    let n = 0;
    _p.set(0, 0, 0);
    for (const fr of F.fighters.values()) { if (fr.f.leaping && fr.f.x * F.side > F.ship.halfW(fr.f.z) * 1.2) continue; _p.x += fr.f.x; _p.z += fr.f.z; n++; }
    for (const fo of F.foes.values()) {
      if (fo.down || !fo.engagedBy) continue;
      const s = sailors.get(fo.id); if (!s) continue;
      _p.x += s.x; _p.z += s.z; n++;
    }
    // A whacky captain pulls the frame their way (their gimmick is the show).
    const cs = F.arch !== "normal" && F.captainShown ? sailors.get(F.captainId) : null;
    if (cs && !cs.down && n) { const k = 0.35 * n; _p.x += cs.x * k; _p.z += cs.z * k; n += k; }
    if (n) { _p.divideScalar(n); }
    else _p.set(0, 0, F.zMid);
    _p.z = clamp(_p.z, F.ship.zMin + 1, F.ship.zMax - 1);
    _p.x = clamp(_p.x, -F.ship.halfW(_p.z), F.ship.halfW(_p.z));
    _p.y = F.ship.deckY(_p.x, _p.z);
    F.cam.focus.lerp(_p, 1 - Math.exp(-dt * 1.2));
  }

  /** A camera beat (her frame, re-read every frame). */
  function shot(mode, { cut = false, duration = 0.9, hold = 0 } = {}) {
    if (!F) return;
    F.cam.mode = mode;
    F.cam.t = 0;
    F.cam.until = hold > 0 ? F.t + hold : 0;
    const SI = F.ship, side = F.side, foc = F.cam.focus;
    let pos, target, fov = 52;
    if (mode === "grapple") {
      // From our deck, inboard and aft of the rail she's alongside, across at her.
      const sx = () => (toShip(fromStage(0, 0, F.zMid, _a), _b).x >= 0 ? 1 : -1);
      pos = () => fromShip(-sx() * 0.6, 4.8, toShip(fromStage(0, 0, F.zMid, _a), _b).z - 11, new THREE.Vector3());
      target = () => fromStage(0, SI.deckY(0, F.zMid) + 1.6, F.zMid, new THREE.Vector3());
      fov = 50;
    } else if (mode === "swing") {
      // Low by her far rail, between her masts, looking back at the Rexmaw: the crew swing in toward the lens.
      const cz = clearOfMasts(F.zMid - 3, 2.8);
      pos = () => fromStage(-side * (SI.halfW(cz) / 0.84 + 1.2), SI.deckY(0, cz) + 3.4, cz, new THREE.Vector3());
      target = () => fromStage(side * (SI.halfW(F.zMid) + 3), SI.deckY(0, F.zMid) + 2.4, F.zMid + 1.5, new THREE.Vector3());
      fov = 58;
    } else if (mode === "captain") {
      const capP = () => { const s = sailors.get(F.captainId); return s ? _c.set(s.x, s.y, s.z) : _c.set(0, SI.deckY(0, F.zMid), F.zMid); };
      // Pip up on Tiny's shoulders: back off and up to take in the pair.
      const tall = () => (sailors.get(F.captainId)?.ride ? 1.75 : 1);
      pos = () => { const c = capP(), k = tall(); return fromStage(c.x + side * 3.4 * k, c.y + 2.0 * k, c.z + 1.6 * k, new THREE.Vector3()); };
      target = () => { const c = capP(); return fromStage(c.x, c.y + 1.7 * tall(), c.z, new THREE.Vector3()); };
      fov = 40;
    } else if (mode === "heavy") {
      // The captain's heavy blow: a medium two-shot from our side of them, the red ring on the deck in frame.
      const mid = () => {
        const c = sailors.get(F.captainId), w = F.warn;
        return c ? _c.set((c.x + (w ? w.x : c.x)) / 2, c.y, (c.z + (w ? w.z : c.z)) / 2) : _c.copy(foc);
      };
      // Forward of them and up (he fights from the quarterdeck end: its break and rail stay behind him).
      pos = () => { const m = mid(); return fromStage(m.x + side * 3.6, m.y + 3.4, m.z + 3.2, new THREE.Vector3()); };
      target = () => { const m = mid(); return fromStage(m.x, m.y + 1.0, m.z, new THREE.Vector3()); };
      fov = 46;
    } else if (mode === "won") {
      // The fight's view, pulled back and up a little: ours cheering, her people on their knees, her colours down.
      const cz = () => clamp(clearOfMasts(foc.z - 5.5, 2.2), SI.zMin - 0.5, SI.zMax + 0.5);
      pos = () => fromStage(side * (SI.halfW(foc.z) + 3.6), foc.y + 5.0, cz(), new THREE.Vector3());
      target = () => fromStage(foc.x - side * 0.6, foc.y + 1.2, foc.z + 0.5, new THREE.Vector3());
      fov = 58;
    } else if (mode === "lost") {
      pos = () => fromShip(0, 5.5, toShip(fromStage(0, 0, F.zMid, _a), _b).z - 13, new THREE.Vector3());
      target = () => fromStage(side * SI.halfW(F.zMid) * 0.6, SI.deckY(0, F.zMid) + 1.2, F.zMid, new THREE.Vector3());
      fov = 52;
    } else {
      // The fight: over the gap, a little aft of the action, looking down across her deck (her canvas edge-on),
      // never with a mast between the lens and the fight's middle. A whacky captain works the gimmick from the
      // quarterdeck: then the lens sits forward of the action looking aft, so they loom behind the melee.
      const drift = () => 0.9 * Math.sin(F.t * 0.11);
      const dir = F.arch !== "normal" ? 1 : -1;
      pos = () => fromStage(side * (SI.halfW(foc.z) + 2.4), foc.y + 3.8, clearOfMasts(foc.z + dir * 6.2 + drift(), 2.2), new THREE.Vector3());
      target = () => fromStage(foc.x - side * 0.9, foc.y + 0.9, foc.z - dir * 0.6, new THREE.Vector3());
      fov = 56;
    }
    R.cam.shot("board", { pos, target, world: true, aboard: true, stabilize: 1, fov, cut, duration: cut ? 0 : duration });
  }

  function stepCamera(dt) {
    stepFocus(dt);
    F.cam.t += dt;
    if (F.cam.until && F.t >= F.cam.until) {
      F.cam.until = 0;
      if (!F.over) shot("fight", { duration: 1.0 });
    }
  }

  // ---- The fight ---------------------------------------------------------------------------------

  function standingFoes() { return [...F.foes.values()].filter((fo) => !fo.down && (fo.kind !== "captain" || F.captainShown)); }

  /** Who this fighter goes for: the state's target, else (focus captain) the captain, else the nearest unengaged foe. */
  function chooseTarget(fr) {
    const cur = fr.target && F.foes.get(fr.target);
    if (cur && !cur.down && (cur.kind !== "captain" || F.captainShown)) return cur;
    if (fr.stateTarget) { const st = F.foes.get(fr.stateTarget); if (st && !st.down && (st.kind !== "captain" || F.captainShown)) return st; }
    const list = standingFoes();
    if (!list.length) return null;
    if (F.focus === "captain" && F.captainShown) { const c = F.foes.get(F.captainId); if (c && !c.down) return c; }
    let best = null, bd = Infinity;
    for (const fo of list) {
      const s = sailors.get(fo.id); if (!s) continue;
      const busy = [...F.fighters.values()].some((o) => o !== fr && o.target === fo.id) ? 3.5 : 0;
      const d = Math.hypot(s.x - fr.f.x, s.z - fr.f.z) + busy + (fo.kind === "captain" && F.focus !== "captain" ? 2 : 0);
      if (d < bd) { bd = d; best = fo; }
    }
    return best;
  }

  function stepFighter(fr, dt) {
    const f = fr.f;
    if (f.leaping || !fr.landed || F.over) return;
    if (fr.down || f.isDown) return;
    // Ara tends the fallen: kneel by anyone down (or badly hurt) within reach.
    if (fr.role === "healer") {
      const hurt = [...F.fighters.values()].find((o) => o !== fr && o.landed && (o.down || o.hp / Math.max(1, o.hpMax) < 0.35));
      if (hurt) {
        if (fr.healing !== hurt.id) { fr.healing = hurt.id; fr.target = null; }
        const tx = hurt.f.x + F.side * 0.75, tz = hurt.f.z + 0.35;
        const [cx, cz] = clampDeck(tx, tz);
        if (Math.hypot(cx - f.x, cz - f.z) > 0.35) { f.heal(null); f.moveTo(cx, cz, { speed: 3.2, r: 0.2 }); }
        else if (!f.moving) {
          f.heal({ x: hurt.f.x, z: hurt.f.z });
          fr.healFx = (fr.healFx ?? 0) - dt;
          if (fr.healFx <= 0) { fr.healFx = 0.45; f.handWorld(_v, "left"); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 8, speed: 0.8, size: 0.12, life: 0.9, gravity: -0.8, intensity: 2.4 }); }
        }
        return;
      }
      if (fr.healing) { fr.healing = null; f.heal(null); }
    }
    const fo = chooseTarget(fr);
    if (!fo) { idleFighter(fr, dt); return; }
    if (fr.target !== fo.id) {
      if (fr.target) { const old = F.foes.get(fr.target); if (old && old.engagedBy === fr.id) old.engagedBy = null; }
      fr.target = fo.id;
      fr.next = rand(0.6, 1.2);
    }
    if (!fo.engagedBy || !F.fighters.get(fo.engagedBy) || F.fighters.get(fo.engagedBy).target !== fo.id) fo.engagedBy = fr.id;
    const s = sailors.get(fo.id);
    if (!s) return;
    const dx = f.x - s.x, dz = f.z - s.z, d = Math.hypot(dx, dz) || 1;
    const duel = fo.kind === "captain" ? DUEL_CAPTAIN : DUEL;
    // Rex goes in shoulder first when a fresh foe stands off.
    fr.chargeT -= dt;
    if (fr.role === "charger" && fr.chargeT <= 0 && d > 3.2 && !f.busy) {
      fr.chargeT = rand(7, 10);
      f.charge(s.x + (dx / d) * 0.7, s.z + (dz / d) * 0.7, { r: 0.3, then: () => {
        if (fo.down || !sailors.get(fo.id)) return;
        cueOut("charge_hit", { who: fr.id, foe: fo.id });
        R.cam.trauma(0.12);
        sailors.act(fo.id, "stagger", { dir: [-dx / d, -dz / d] });
        f.chestWorld(_v); fx?.sparks?.(_v.clone(), { count: 8, speed: 2 });
      } });
      return;
    }
    // Into the duel: a pace and a half off them, on our side of them.
    const [gx, gz] = clampDeck(s.x + (dx / d) * duel, s.z + (dz / d) * duel);
    if (Math.hypot(gx - f.x, gz - f.z) > 0.35 && !f.busy) f.moveTo(gx, gz, { speed: d > 4 ? 3.6 : 2.2, r: 0.2, keepFacing: d < 3 });
    f.faceTo(s.x, s.z);
    sailors.faceTo(fo.id, f.x, f.z);
    f.lookAt(sailors.headWorld(fo.id, _v), 0.8);
    // The exchanges: one attacks, the other parries — a clash of sparks — unless the core says someone was hit.
    if (d < duel + 0.6) {
      fr.next -= dt;
      if (fr.next <= 0 && !f.busy && !s.act && !fo.down) {
        fr.next = rand(0.9, 1.9) * (fo.kind === "captain" ? 1.3 : 1);
        const ours = Math.random() < 0.55;
        if (ours) {
          const tHit = f.act(Math.random() < 0.6 ? "swing" : "stab", { at: s }) ?? 0.3;
          later(Math.max(0, tHit - 0.12), () => sailors.act(fo.id, "parry", { at: { x: f.x, z: f.z } }));
          later(tHit, () => clash(fr, fo));
        } else {
          const tHit = sailors.act(fo.id, fo.kind === "captain" ? "attack" : "attack", { at: { x: f.x, z: f.z } }) ?? 0.35;
          later(Math.max(0, tHit - 0.14), () => fr.f.act("block", { at: s }));
          later(tHit, () => clash(fr, fo));
        }
      }
    }
  }

  function idleFighter(fr) {
    // No one left to fight (or the captain's still below): hold the deck, facing her far side.
    const f = fr.f;
    if (!f.moving && !f.busy) f.faceTo(f.x - F.side, f.z);
  }

  function clash(fr, fo) {
    if (!F || fo.down || fr.f.isDown) return;
    const a = fr.f.bladeWorld(_v), b = sailors.bladeWorld(fo.id, _w);
    if (!b) return;
    const p = a.clone().lerp(b, 0.5);
    fx?.sparks?.(p, { count: 9, speed: 2.4, color: "#ffe6b0" });
    cueOut("clash", { who: fr.id, foe: fo.id, x: p.x, y: p.y, z: p.z });
  }

  /** Foes not in a duel: close in on our people (pistols keep their distance, aim and fire). */
  function stepFoes(dt) {
    const fighters = [...F.fighters.values()].filter((fr) => fr.landed && !fr.f.isDown);
    for (const fo of F.foes.values()) {
      const s = sailors.get(fo.id);
      if (!s || fo.down || s.surrender) continue;
      if (fo.kind === "captain" && !F.captainShown) continue;
      // Engaged: their duel partner leads; they hold their ground (a shuffle).
      const eng = fo.engagedBy && F.fighters.get(fo.engagedBy);
      if (eng && eng.target === fo.id && !eng.f.isDown) {
        // The captain's heavy blow, if the core never telegraphs one: every so often.
        if (fo.kind === "captain") fallbackCaptainAttack(fo, eng, dt);
        continue;
      }
      fo.engagedBy = null;
      if (!fighters.length) { if (!s.cheer && !s.act) sailors.stop(fo.id); continue; }
      let best = null, bd = Infinity;
      for (const fr of fighters) { const d = Math.hypot(fr.f.x - s.x, fr.f.z - s.z); if (d < bd) { bd = d; best = fr; } }
      if (!best) continue;
      const dx = s.x - best.f.x, dz = s.z - best.f.z, d = Math.hypot(dx, dz) || 1;
      const ring = isGun(s) ? 4.8 : fo.kind === "captain" ? DUEL_CAPTAIN : 2.6;
      const [gx, gz] = clampDeck(best.f.x + (dx / d) * ring + (fo.kind === "captain" ? 0 : Math.sin(F.t * 0.3 + s.seed) * 0.8), best.f.z + (dz / d) * ring);
      if (Math.hypot(gx - s.x, gz - s.z) > 0.5 && !s.act) sailors.moveTo(fo.id, gx, gz, { speed: d > 5 ? 3.2 : 1.6, r: 0.3, keepFacing: d < 4 });
      sailors.faceTo(fo.id, best.f.x, best.f.z);
      if (fo.kind === "captain" && d < DUEL_CAPTAIN + 0.6) fallbackCaptainAttack(fo, best, dt);
      // A pistol hand: aim, fire (a flash, smoke, a tracer: the core decides the damage).
      if (isGun(s) && d < 9) {
        fo.aimT -= dt;
        if (fo.aimT <= 1 && !fo.aiming) { fo.aiming = true; sailors.aimAt(fo.id, { x: best.f.x, z: best.f.z }); }
        if (fo.aimT <= 0) {
          fo.aimT = rand(3.5, 6); fo.aiming = false;
          sailors.act(fo.id, "fire");
          const mz = sailors.muzzleWorld(fo.id, new THREE.Vector3());
          const dirW = sailors.aimDir(fo.id, new THREE.Vector3());
          if (mz && dirW) {
            fx?.muzzle?.(mz, dirW, { scale: 0.22, smoke: 0.45 });
            const hit = best.f.chestWorld(new THREE.Vector3());
            hit.x += rand(-0.4, 0.4); hit.y += rand(-0.2, 0.4);
            fx?.trail?.(mz, hit, 0.07, { color: "#ffd8a0", lift: 0, size: 0.035, intensity: 3, burst: false });
            cueOut("enemy_pistol", { foe: fo.id, x: mz.x, y: mz.y, z: mz.z });
          }
          later(0.3, () => sailors.aimAt(fo.id, null));
        }
      }
    }
  }

  /** Keep bodies a shoulder apart (ours and theirs), and on her deck. */
  function separate() {
    const bodies = [];
    for (const fr of F.fighters.values()) if (fr.landed && !fr.f.leaping) bodies.push({ x: fr.f.x, z: fr.f.z, r: 0.42, fr });
    // (Not a rider on a carrier's shoulders, not a gull on the wing; a crab or a bathtub takes more room.)
    for (const s of sailors.list) if (!s.down && s.shown > 0.5 && !s.gone && !s.ride && !s.bird) bodies.push({ x: s.x, z: s.z, r: 0.4 * s.scale * (s.crab || s.tub ? 1.5 : 1), s });
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i], B = bodies[j];
        const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), min = A.r + B.r;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) * 0.5, nx = dx / d, nz = dz / d;
        if (A.fr) A.fr.f.nudge(-nx * push, -nz * push); else { A.s.x -= nx * push; A.s.z -= nz * push; }
        if (B.fr) B.fr.f.nudge(nx * push, nz * push); else { B.s.x += nx * push; B.s.z += nz * push; }
      }
    }
    for (const fr of F.fighters.values()) if (fr.landed && !F.over) fr.f.clampTo(clampDeck);
    for (const s of sailors.list) {
      if (s.down || s.ride || s.gone) continue;
      const qd = (s.kind === "captain" || s.look === "tiny") && s.z < F.ship.zMin;
      const [x, z] = qd ? clampQD(s.x, s.z) : clampDeck(s.x, s.z);
      s.x = x; s.z = z;
    }
  }

  // ---- Damage the core dealt, shown as blows -------------------------------------------------------

  function foeHit(fo, { killed = false, pistol = false, from = null, heavy = false } = {}) {
    const s = sailors.get(fo.id);
    if (!s) return;
    const show = () => {
      if (!F) return;
      const dir = from ? [s.x - from.x, s.z - from.z] : [F.side * -1, 0];
      sailors.chestWorld(fo.id, _v);
      fx?.sparks?.(_v.clone(), { count: pistol ? 14 : 10, speed: 2.8, color: "#ffb070" });
      fx?.burst?.(_v.clone(), { color: "#ff6a3a", count: 6, speed: 1.4, size: 0.12, life: 0.4, intensity: 2.6 });
      if (killed) dropFoe(fo, dir, heavy || pistol);
      else sailors.act(fo.id, heavy ? "stagger" : "hit", { dir });
      cueOut("foe_hit", { foe: fo.id, killed, pistol });
    };
    if (pistol) { show(); return; }
    // A blow from their duelling partner (or the nearest of ours on their feet).
    let fr = fo.engagedBy && F.fighters.get(fo.engagedBy);
    if (!fr || fr.f.isDown || !fr.landed) {
      let bd = Infinity;
      for (const o of F.fighters.values()) { if (!o.landed || o.f.isDown) continue; const d = Math.hypot(o.f.x - s.x, o.f.z - s.z); if (d < bd) { bd = d; fr = o; } }
      if (bd > 4) fr = null;
    }
    if (fr && !fr.f.leaping) {
      const t = fr.f.act(Math.random() < 0.65 ? "swing" : "stab", { at: s, speed: 1.15 }) ?? 0;
      later(t, () => { show(); });
      if (killed && fo.engagedBy === fr.id) fr.next = 0.9;
    } else show();
  }

  function crewHit(fr, { down = false } = {}) {
    // A blow from their duelling partner (the captain's heavy one has its own beat).
    const fo = fr.target && F.foes.get(fr.target);
    const s = fo && !fo.down ? sailors.get(fo.id) : null;
    const show = () => {
      if (!F) return;
      const dir = s ? [fr.f.x - s.x, fr.f.z - s.z] : [F.side, 0];
      fr.f.chestWorld(_v);
      fx?.sparks?.(_v.clone(), { count: 8, speed: 2.4, color: "#ffd0a0" });
      if (down) dropOurs(fr, dir);
      else fr.f.act("hit", { at: s ? { x: s.x, z: s.z } : null });
      cueOut("crew_hit", { who: fr.id, down });
    };
    if (s && Math.hypot(s.x - fr.f.x, s.z - fr.f.z) < 3 && !s.act) {
      const t = sailors.act(fo.id, fo.kind === "captain" ? "heavy" : "attack", { at: { x: fr.f.x, z: fr.f.z } }) ?? 0.3;
      later(t, show);
    } else show();
  }

  // ---- The captain -------------------------------------------------------------------------------

  function captainAppears(name) {
    if (!F || F.captainShown) return;
    F.captainShown = true;
    if (name) F.captainName = name;
    const fo = F.foes.get(F.captainId);
    if (fo) fo.present = true;
    const id = F.captainId;
    F.captainT = F.t;
    sailors.show(id, true);
    // Up from the cabin under the quarterdeck: out and down into the waist (where the core puts him), then the
    // sabre levelled at us.
    const SI = F.ship;
    const z = SI.zMin + 1.6;
    if (!F.coreDriven) sailors.moveTo(id, -F.side * SI.halfW(z) * 0.2, z, { speed: 2.2, r: 0.3 });
    // Pip comes up on Tiny's shoulders.
    if (F.arch === "pip") {
      const s = sailors.get(id);
      const tiny = addFoe({ id: "tiny", kind: "mate", look: "tiny", name: "Tiny", hp: 200, max: 200 }, { at: s ? { x: s.x, z: s.z } : null });
      if (tiny) sailors.ride(id, "tiny");
    }
    const A = ARCHETYPES[F.arch];
    later(1.4, () => {
      if (!F || F.over) return;
      if (F.arch === "mime") sailors.act(id, "mime", { hold: 1.4, at: { x: F.cam.focus.x + F.side * 2, z: F.cam.focus.z } });
      else if (F.arch !== "pip") sailors.act(id, "taunt", { hold: 1.4, at: { x: F.cam.focus.x + F.side * 2, z: F.cam.focus.z } });
      say(id, pickOf(A?.lines?.intro) || "", { voice: F.arch });
    });
    // The cut to him: now if the fight's on; while ours are still swinging across, the cut waits for them to land.
    if (!F.over && F.phase === "fight") { shot("captain", { duration: 0.6, hold: 2.9 }); F.captainCutDone = true; }
    R.cam.fovKick(-2);
    cueOut("captain", { id, name: F.captainName, archetype: F.arch });
  }

  /** The heavy blow: telegraph (sabre high, the blade red-hot, a red ring closing on the target) → the slam. */
  function captainTelegraph(targetId = null, windup = 1.2) {
    if (!F || !F.captainShown) return;
    const fo = F.foes.get(F.captainId);
    const s = sailors.get(F.captainId);
    if (!fo || fo.down || !s) return;
    let fr = targetId != null ? F.fighters.get(String(targetId)) : null;
    if (!fr) fr = fo.engagedBy ? F.fighters.get(fo.engagedBy) : null;
    if (!fr) { let bd = Infinity; for (const o of F.fighters.values()) { if (!o.landed || o.f.isDown) continue; const d = Math.hypot(o.f.x - s.x, o.f.z - s.z); if (d < bd) { bd = d; fr = o; } } }
    const at = fr ? { x: fr.f.x, z: fr.f.z } : { x: s.x + Math.sin(s.yaw) * 1.8, z: s.z + Math.cos(s.yaw) * 1.8 };
    sailors.act(F.captainId, "telegraph", { hold: windup, at });
    F.warn = { x: at.x, z: at.z, t: 0, dur: windup, target: fr?.id ?? null };
    F.lastAttackSeen = F.t;
    F.warnStartT = F.t;
    if (!F.over && (F.cam.mode === "fight" || F.cam.mode === "captain")) shot("heavy", { duration: 0.45, hold: windup + 1.0 });
    R.cam.fovKick(-1.5);
    cueOut("captain_windup", { target: fr?.id ?? null, seconds: windup });
  }

  function captainSlam({ targets = null, damage = true } = {}) {
    if (!F) return;
    const s = sailors.get(F.captainId);
    if (!s || F.foes.get(F.captainId)?.down) return;
    const w = F.warn;
    const t = sailors.act(F.captainId, "slam", { at: w ? { x: w.x, z: w.z } : null }) ?? 0.2;
    // Hit points the core takes off under the blow land with it, not before (see readState).
    F.slamPending = { until: F.t + t + 0.02, x: w ? w.x : s.x, z: w ? w.z : s.z, targets: targets || (w?.target ? [w.target] : null) };
    later(t, () => {
      if (!F) return;
      const p = w || { x: s.x + Math.sin(s.yaw) * 1.6, z: s.z + Math.cos(s.yaw) * 1.6 };
      const y = F.ship.deckY(p.x, p.z);
      F.shock = { x: p.x, z: p.z, y, t: 0 };
      F.warn = null;
      const pw = fromStage(p.x, y + 0.1, p.z, new THREE.Vector3());
      fx?.splinters?.(pw, { count: 18, scale: 0.7 });
      fx?.sparks?.(pw.clone().setY(pw.y + 0.3), { count: 16, speed: 3.4, color: "#ffb070" });
      R.cam.trauma(0.32);
      cueOut("captain_slam", { x: pw.x, y: pw.y, z: pw.z });
      // The core's hits by him since the windup land now, heavy; anyone else under it reels (the fallback: the
      // core's hit points decide who falls, see readState).
      const capRec = F.foes.get(F.captainId);
      const struck = new Set();
      if (F.coreDriven) {
        for (const h of F.hits) {
          if (h.used || h.by !== F.captainId || h.t < F.warnStartT - 0.3) continue;
          h.used = true; struck.add(h.target);
          showHurt("ours", h.target, capRec, { heavy: true });
        }
      }
      for (const fr of F.fighters.values()) {
        if (!fr.landed || fr.f.isDown || struck.has(fr.id)) continue;
        const d = Math.hypot(fr.f.x - p.x, fr.f.z - p.z);
        const named = targets && targets.includes?.(fr.id);
        if (d < 1.9 || named) {
          fr.slamT = F.t;
          if (!damage || (F.coreDriven && d < 1.5)) fr.f.act("stagger", { at: { x: s.x, z: s.z } });
        }
      }
    });
  }

  function fallbackCaptainAttack(fo, fr, dt) {
    // Only when the core never telegraphs one itself (no `captain_attack` event / attack state seen lately).
    if (F.t - F.lastAttackSeen < 12 || F.coreTelegraphs) return;
    F.fallbackAttackT -= dt;
    if (F.fallbackAttackT > 0 || F.warn) return;
    F.fallbackAttackT = rand(8, 11);
    captainTelegraph(fr.id, 1.2);
    later(1.2, () => captainSlam({ damage: false }));
  }

  // ---- The user's pistol, the rally -----------------------------------------------------------------

  function pistolShot(p = {}) {
    if (!F) return;
    const id = p.target ?? p.foe ?? p.id ?? p.targetId;
    const fo = id != null ? F.foes.get(String(id)) : null;
    const s = fo ? sailors.get(fo.id) : null;
    const hit = s ? sailors.chestWorld(fo.id, new THREE.Vector3()) : (Number.isFinite(+p.x) ? new THREE.Vector3(+p.x, +p.y || 0, +p.z) : null);
    if (!hit) return;
    // The Captain's own hand: in the fight's view (the lens over the gap is where they stand) the shot leaves from
    // just under the lens toward the target — the flash and the smoke in the frame's foot; in other views, from
    // our rail at the point nearest her.
    let muzzle;
    const camW = R.camera.getWorldPosition(new THREE.Vector3());
    if (F.cam.mode === "fight" || F.cam.mode === "heavy" || F.cam.mode === "captain") {
      const toT = hit.clone().sub(camW);
      const d = toT.length();
      muzzle = camW.clone().addScaledVector(toT.normalize(), Math.min(2.2, d * 0.3)).add(new THREE.Vector3(0, -0.85, 0));
    } else {
      const loc = toShip(hit, new THREE.Vector3());
      const sx = Math.sign(loc.x) || 1;
      muzzle = fromShip(sx * 4.45, 1.65, clamp(loc.z, -3, 13), new THREE.Vector3());
    }
    const dir = hit.clone().sub(muzzle).normalize();
    fx?.muzzle?.(muzzle, dir, { scale: 0.2, smoke: 0.6 });
    fx?.smokeRing?.(muzzle, dir, { scale: 0.22 });
    const miss = p.hit === false || p.miss === true;
    const to = miss ? hit.clone().add(new THREE.Vector3(rand(-0.8, 0.8), rand(-0.6, 0.2), rand(-0.8, 0.8))) : p.blockAt || hit;
    F.lastPistolT = F.t;
    if (fo && !miss) fo.pistolMark = F.t;          // the state's hit points dropping now are this shot's
    R.cam.trauma(0.07); R.cam.fovKick(-1);
    cueOut("pistol", { target: fo?.id ?? null, x: muzzle.x, y: muzzle.y, z: muzzle.z, hit: !miss });
    fx?.trail?.(muzzle, to, Math.max(0.05, muzzle.distanceTo(to) / 320), { color: "#ffe2a8", lift: 0, size: 0.05, intensity: 4, burst: false }).then(() => {
      if (!F) return;
      if (miss) { fx?.splinters?.(to, { count: 6, scale: 0.4 }); return; }
      // Turned aside by a gimmick (a claw, the bubble, mist): sparks where it struck, no one reels.
      if (p.blocked) { fx?.sparks?.(to, { count: 12, speed: 2.6, color: p.blockColor || "#fff0c8" }); p.onBlock?.(); return; }
      if (!fo || fo.downShown) return;
      const killed = !!(p.killed || p.down || (Number.isFinite(+p.hp) && +p.hp <= 0) || (F.coreDriven && (fo.down || recentDown(fo.id))));
      if (F.coreDriven) {
        const s2 = sailors.get(fo.id);
        sailors.chestWorld(fo.id, _v);
        // A ball striking home: a hard white-gold flash, sparks thrown back along the shot.
        fx?.burst?.(_v.clone(), { color: "#fff0c8", count: 14, speed: 2.2, size: 0.2, life: 0.35, intensity: 4.2 });
        fx?.sparks?.(_v.clone(), { count: 18, speed: 3.2, color: "#ffb070" });
        const dir = s2 ? [s2.x - toStage(muzzle, _w).x, s2.z - _w.z] : [-F.side, 0];
        if (killed) dropFoe(fo, dir, true); else { sailors.act(fo.id, "hit", { dir }); fo.hurtShownT = F.t; }
        cueOut("foe_hit", { foe: fo.id, killed, pistol: true });
        return;
      }
      // The state's hit points land it (update()) unless the event already says so.
      if (killed && !fo.down) { fo.down = true; foeHit(fo, { killed: true, pistol: true }); }
      else if (!fo.down) foeHit(fo, { pistol: true });
    });
  }

  function rally() {
    if (!F) return;
    F.rallyT = F.t;
    let n = 0; _p.set(0, 0, 0);
    for (const fr of F.fighters.values()) { if (fr.landed) { _p.x += fr.f.x; _p.z += fr.f.z; n++; } }
    if (n) _p.divideScalar(n); else _p.set(0, 0, F.zMid);
    F.rally = { x: _p.x, z: _p.z, y: F.ship.deckY(_p.x, _p.z), t: 0 };
    for (const fr of F.fighters.values()) {
      if (!fr.landed) continue;
      if (fr.f.isDown) fr.f.getup();
      fr.f.cheer(true);
      later(1.3, () => fr.f.cheer(false));
      fr.f.chestWorld(_v);
      fx?.burst?.(_v.clone(), { color: "#ffd27a", count: 22, speed: 2.2, size: 0.18, life: 0.9, intensity: 3.4 });
    }
    // Their front line reels from it.
    for (const fo of F.foes.values()) {
      const s = sailors.get(fo.id);
      if (!s || fo.down || (fo.kind === "captain" && !F.captainShown)) continue;
      const d = Math.hypot(s.x - F.rally.x, s.z - F.rally.z);
      if (d < 7) later(0.12 + d * 0.04, () => sailors.act(fo.id, "stagger", { dir: [s.x - F.rally.x, s.z - F.rally.z] }));
    }
    R.cam.trauma(0.18); R.cam.fovKick(-3);
    cueOut("rally", {});
  }

  // ---- The end -------------------------------------------------------------------------------------

  function finish(outcome) {
    if (!F || F.over) return;
    F.over = true;
    F.outcome = outcome === "won" ? "won" : "lost";
    F.endT = F.t;
    F.warn = null;
    if (F.outcome === "won") {
      // Her colours come down; the rest drop their blades and raise their hands; ours cheer.
      fleet?.surrender?.(F.enemyId);
      let k = 0;
      for (const fo of F.foes.values()) {
        if (fo.down) continue;
        const id = fo.id;
        if (fo.kind === "captain" && !F.captainShown) continue;
        later(0.2 + 0.15 * k++, () => sailors.act(id, "surrender"));
      }
      k = 0;
      for (const fr of F.fighters.values()) {
        later(0.3 + 0.18 * k++, () => { if (fr.f.isDown) fr.f.getup(); later(fr.f.isDown ? 1.2 : 0, () => fr.f.cheer(true)); });
      }
      shot("won", { duration: 1.4 });
      R.post?.set?.({ letterbox: 1 }, { duration: 0.5 });
      later(3.0, () => goHome());
    } else {
      // Repelled: everyone up and back to the rail, back over; the lines cut; her crew brandish their blades.
      for (const fr of F.fighters.values()) {
        if (fr.f.isDown) fr.f.getup();
        fr.f.cheer(false); fr.f.heal(null);
        const z = clamp(fr.f.z, F.ship.zMin + 0.5, F.ship.zMax - 0.5);
        later(fr.f.isDown ? 1.2 : 0.1, () => fr.f.moveTo(F.side * F.ship.halfW(z) * 0.85, z, { speed: 4, r: 0.25 }));
      }
      for (const fo of F.foes.values()) if (!fo.down && (fo.kind !== "captain" || F.captainShown)) later(rand(0.3, 1.0), () => sailors.act(fo.id, "cheer"));
      shot("lost", { duration: 1.2 });
      later(1.6, () => goHome());
      later(2.6, () => cutRopes());
    }
    cueOut("boardfight_end", { outcome: F.outcome });
  }

  function goHome() {
    if (!F) return;
    let k = 0;
    for (const fr of F.fighters.values()) {
      const go = () => { if (!F) return; if (fr.f.isDown) { fr.f.getup(); later(1.2, go); return; } fr.f.cheer(false); fr.f.heal(null); fr.f.stop(); launch(fr, { home: true }); };
      later(k++ * 0.22, go);
    }
    if (F.outcome === "won") later(1.0, () => cutRopes());
    F.homing = true;
  }

  /** Put everyone back aboard the Rexmaw and clear the stage (after the end beats, or at once). */
  function cleanup() {
    if (!F) return;
    for (const fr of F.fighters.values()) {
      try {
        // Their spot on our deck (ship frame), from where they stood before the fight.
        fr.f.end(ship, fr.homeShip, null);
      } catch (error) { console.debug("[night-raid] boardfight: giving a body back failed", error); }
    }
    sailors.clear();
    sailors.update(0, {});
    const sh = F.ship.sh;
    if (sh?.__bfK) { sh.K = sh.__bfK; delete sh.__bfK; }
    if (sh?.sails && F.sailsHidden) sh.sails.visible = true;
    stage.removeFromParent();
    if (F.ship.own) F.ship.own.removeFromParent();
    for (const r of rings) r.visible = false;
    for (const x of extras) x.visible = false;
    for (const n of notes) n.userData.life = 0;
    for (const p of pies) p.userData.fly = null;
    for (const w of walls) w.material.uniforms.uOp.value = 0;
    suds.count = 0;
    ropes.visible = hooks.visible = false; ropes.count = 0; hooks.count = 0;
    fightLight.intensity = 0;
    R.post?.set?.({ letterbox: 0 }, { duration: 0.4 });
    camera?.boardEnd?.();
    // Without the world's cinematic slot (or if it was let go early), the lens still goes back to sailing.
    if (R.cam.current === "board") R.cam.back?.({ duration: 0 });
    const bf = F.bf;
    lastDone = `${bf?.enemyId ?? bf?.enemy?.id ?? bf?.shipId ?? ""}|${bf?.id ?? ""}`;
    F = null;
    timers.length = 0;
  }
  let lastDone = null;

  // ---- Timers on the fight's clock ----
  const timers = [];
  function later(seconds, fn) { if (F) timers.push({ at: F.t + Math.max(0, seconds), fn }); }

  // ---- The state, each frame -------------------------------------------------------------------------

  function readState(bf) {
    if (!F || !bf) return;
    F.bf = bf;
    if (bf.focus) F.focus = String(bf.focus);
    if (bf.deck && !F.deckCore) F.deckCore = bf.deck;
    // Foes.
    const list = listOf(bf.foes ?? bf.enemies ?? bf.sailors);
    const oursList = listOf(bf.crew ?? bf.party ?? bf.fighters ?? bf.ours);
    // The core's deck fight (v4): positions, acts and events drive the figures; else the fallback below stages it.
    if (!F.coreDriven && [...list, ...oursList].some((x) => Number.isFinite(+x.x) && Number.isFinite(+x.z) && typeof x.act === "string")) F.coreDriven = true;
    if (F.coreDriven) { readCore(bf, list, oursList); return; }
    for (const src of list) {
      const id = String(src.id);
      const fo = F.foes.get(id);
      if (!fo) continue;
      if (fo.kind === "captain") continue;
      applyFoe(fo, src);
    }
    // The captain.
    const capt = (bf.captain && typeof bf.captain === "object") ? bf.captain : list.find((x) => x.kind === "captain" || x.boss || x.captain);
    if (capt) {
      const fo = F.foes.get(F.captainId);
      if (fo) {
        const present = !!(capt.present ?? capt.onDeck ?? capt.appeared ?? capt.visible ?? F.captainShown);
        if (present && !F.captainShown) captainAppears(capt.name);
        if (capt.name) F.captainName = capt.name;
        applyFoe(fo, capt);
        const atk = capt.attack || capt.heavy || null;
        if (atk && typeof atk === "object") {
          const stage_ = atk.stage ?? atk.phase;
          const key = `${stage_}|${atk.id ?? atk.t ?? ""}`;
          if (key !== F.atkKey) {
            F.atkKey = key;
            F.coreTelegraphs = true;
            if (stage_ === "windup" || stage_ === "telegraph") captainTelegraph(atk.target, Number.isFinite(+atk.eta) ? +atk.eta : Number.isFinite(+atk.windup) ? +atk.windup : 1.2);
            else if (stage_ === "strike" || stage_ === "slam") captainSlam({ targets: atk.targets || (atk.target != null ? [String(atk.target)] : null) });
          }
        }
      }
    }
    // Our side.
    const ours = listOf(bf.crew ?? bf.party ?? bf.fighters ?? bf.ours);
    for (const src of ours) {
      const fr = F.fighters.get(String(src.id));
      if (!fr) continue;
      if (src.target != null) fr.stateTarget = String(src.target);
      const hp = hpOf(src), max = hpMaxOf(src);
      if (max) fr.hpMax = max;
      const down = isDown(src);
      if (hp != null && hp < fr.hp - 0.5 && fr.landed && !F.over) {
        const sp = F.slamPending;
        const under = sp && F.t <= sp.until + 0.05 && (sp.targets?.includes?.(fr.id) || Math.hypot(fr.f.x - sp.x, fr.f.z - sp.z) < 2.2);
        const slammed = fr.slamT != null && F.t - fr.slamT < 0.6;
        const fell = () => { const c = sailors.get(F.captainId); const dir = c ? [fr.f.x - c.x, fr.f.z - c.z] : [F.side, 0]; if (down) fr.f.down(dir); else fr.f.act("stagger", { at: c ? { x: c.x, z: c.z } : null }); };
        if (under) later(Math.max(0, sp.until - F.t), fell);
        else if (slammed) fell();
        else crewHit(fr, { down });
      } else if (down && !fr.down && fr.landed && !fr.f.isDown) fr.f.down();
      if (!down && fr.down) {
        fr.f.getup();
        if (hp != null && hp > fr.hp) { fr.f.chestWorld(_v); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 18, speed: 1.6, size: 0.16, life: 1, gravity: -0.6, intensity: 3 }); cueOut("revive", { who: fr.id }); }
      } else if (hp != null && hp > fr.hp + 4 && !down && fr.landed) {
        fr.f.chestWorld(_v); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 10, speed: 1.2, size: 0.12, life: 0.8, gravity: -0.6, intensity: 2.6 });
      }
      if (hp != null) fr.hp = hp;
      fr.down = down;
    }
    // The outcome.
    const out = bf.outcome ?? bf.result ?? (bf.phase === "won" || bf.phase === "lost" ? bf.phase : null) ?? (bf.won ? "won" : bf.lost ? "lost" : null);
    if (out && !F.over) finish(/won|struck|victory|win/i.test(String(out)) ? "won" : "lost");
  }

  function applyFoe(fo, src) {
    const hp = hpOf(src), max = hpMaxOf(src);
    if (max) fo.hpMax = max;
    const down = isDown(src);
    if (src.weapon && fo.kind !== "captain") { /* the weapon picked at spawn stays (no swapping mid-fight) */ }
    if (hp != null && hp < fo.hp - 0.5 && !F.over) {
      const pistolJust = fo.pistolMark != null && F.t - fo.pistolMark < 0.8;
      if (!pistolJust) {
        const rallyJust = F.t - F.rallyT < 1.2;
        if (!fo.down) foeHit(fo, { killed: down, heavy: rallyJust });
      } else if (down && !fo.down) foeHit(fo, { killed: true, pistol: true });
      fo.down = fo.down || down;
    } else if (down && !fo.down) { fo.down = true; foeHit(fo, { killed: true }); }
    if (hp != null) fo.hp = hp;
    if (down) fo.down = true;
  }

  // ---- The core's fight (v4): its positions, its swings, its hits ------------------------------------
  //
  // state.boardfight.ours[] / foes[]: {id, hp, max, state: "fighting"|"down", target, x, z, act, actT} on her deck.
  // A new `act: "swing"` starts that figure's blow at its target; the core's `hit` events (by, target) are held
  // until a blow lands to show them (the target reels, or falls when the core has them down), so every hit is
  // seen as somebody's blow; swings without a hit end in a parry and a clash of sparks. Her gunners aim and fire.
  // Her captain's swings are plain, except one in every HEAVY_GAP seconds: telegraphed (the red ring, the
  // red-hot sabre) — his hits during the windup land with the slam.

  const recentDown = (id) => F.downEv.has(id) && F.t - F.downEv.get(id) < 2;
  const findHit = (by, target, since) => F.hits.find((h) => !h.used && h.by === by && (target == null || h.target === target) && h.t >= since - 0.45);

  function dropFoe(fo, dir, hard = false) {
    if (!fo || fo.downShown) return;
    fo.downShown = true; fo.down = true;
    sailors.act(fo.id, "down", { dir, hard });
    cueOut("foe_down", { foe: fo.id, captain: fo.kind === "captain" });
  }
  function dropOurs(fr, dir = null) {
    if (!fr || fr.f.isDown || fr.f.leaping) return;
    fr.downShown = true;
    fr.f.down(dir);
    if (fr.healing) { fr.healing = null; fr.f.heal(null); }
    cueOut("crew_down", { who: fr.id });
  }

  /** The target reels (or falls when the core has them down) from `by`'s blow. */
  function showHurt(targetSide, targetId, by = null, { heavy = false } = {}) {
    if (!F) return;
    const bp = by ? (by.f ? { x: by.f.x, z: by.f.z } : sailors.get(by.id)) : null;
    if (targetSide === "foes") {
      const fo = F.foes.get(targetId), s = sailors.get(targetId);
      if (!fo || !s || fo.downShown) return;
      const dir = bp ? [s.x - bp.x, s.z - bp.z] : [-F.side, 0];
      sailors.chestWorld(fo.id, _v);
      fx?.sparks?.(_v.clone(), { count: heavy ? 14 : 10, speed: 2.8, color: "#ffb070" });
      fx?.burst?.(_v.clone(), { color: "#ff6a3a", count: 6, speed: 1.4, size: 0.12, life: 0.4, intensity: 2.6 });
      if (fo.down || recentDown(fo.id)) dropFoe(fo, dir, heavy);
      else { sailors.act(fo.id, heavy ? "stagger" : "hit", { dir }); fo.hurtShownT = F.t; }
      cueOut("foe_hit", { foe: fo.id, killed: fo.downShown });
    } else {
      const fr = F.fighters.get(targetId);
      if (!fr || !fr.landed || fr.f.isDown || fr.f.leaping) return;
      const dir = bp ? [fr.f.x - bp.x, fr.f.z - bp.z] : [F.side, 0];
      fr.f.chestWorld(_v);
      fx?.sparks?.(_v.clone(), { count: heavy ? 14 : 8, speed: 2.4, color: "#ffd0a0" });
      if (fr.down || recentDown(fr.id)) dropOurs(fr, dir);
      else { fr.f.act(heavy ? "stagger" : "hit", { at: bp ? { x: bp.x, z: bp.z } : null }); fr.hurtShownT = F.t; }
      cueOut("crew_hit", { who: fr.id, down: !!fr.downShown });
    }
  }

  /** A blow begins: `rec` (ours: a fighter record; foes: a foe record) at `targetId`. False when it can't swing now. */
  function startSwing(rec, side, targetId) {
    if (!F || F.over || !targetId) return false;
    if (side === "ours") {
      const fr = rec, fo = F.foes.get(targetId), s = sailors.get(targetId);
      if (!fr.landed || fr.f.leaping || fr.f.isDown || !fo || !s || fo.downShown || s.shown < 0.5) return false;
      if (fr.f.acting === "swing" || fr.f.acting === "stab") return false;
      if (fr.healing) { fr.healing = null; fr.f.heal(null); }
      const tHit = fr.f.act(Math.random() < 0.6 ? "swing" : "stab", { at: s }) ?? 0.3;
      const sw = fr.swing = { t0: F.t, target: fo.id, done: false };
      later(Math.max(0, tHit - 0.12), () => { if (F && !findHit(fr.id, fo.id, sw.t0) && !fo.downShown && !sailors.get(fo.id)?.act) sailors.act(fo.id, "parry", { at: { x: fr.f.x, z: fr.f.z } }); });
      later(tHit, () => resolveSwing(fr, "ours", fo.id, sw));
      return true;
    }
    const fo = rec, s = sailors.get(fo.id), fr = F.fighters.get(targetId);
    if (!s || fo.downShown || s.down || s.shown < 0.5 || !fr || !fr.landed || fr.f.leaping || fr.f.isDown) return false;
    if (fo.kind === "captain" && (F.warn || (F.slamPending && F.t < F.slamPending.until + 0.3))) return false;
    if (fo.kind === "captain" && F.t - F.lastHeavyT > HEAVY_GAP && F.t - (F.captainT ?? 0) > 2.5) { heavyBlow(fr); return true; }
    if (isGun(s)) { gunnerShot(fo, fr); return true; }
    if (s.bird && !s.act) {
      // A gull's peck: a dive at the face (no blade to swing), the hit lands with it.
      const sw = fo.swing = { t0: F.t, target: fr.id, done: false };
      fr.f.headWorld(_v); const hl = toStage(_v, new THREE.Vector3());
      sailors.moveTo(fo.id, hl.x, hl.z, { speed: 5, r: 0.3 });
      later(0.3, () => resolveSwing(fo, "foes", fr.id, sw));
      return true;
    }
    if (s.act && s.act.name !== "parry") return false;
    const tHit = sailors.act(fo.id, fo.kind === "captain" ? "heavy" : "attack", { at: { x: fr.f.x, z: fr.f.z } }) ?? 0.35;
    const sw = fo.swing = { t0: F.t, target: fr.id, done: false };
    later(Math.max(0, tHit - 0.14), () => { if (F && !findHit(fo.id, fr.id, sw.t0) && !fr.f.busy) fr.f.act("block", { at: s }); });
    later(tHit, () => resolveSwing(fo, "foes", fr.id, sw));
    return true;
  }

  function resolveSwing(rec, side, targetId, sw) {
    if (!F || sw.done) return;
    sw.done = true;
    const h = findHit(rec.id, targetId, sw.t0);
    if (h) { h.used = true; showHurt(side === "ours" ? "foes" : "ours", h.target, rec, { heavy: rec.kind === "captain" }); return; }
    // Parried: steel on steel.
    const fr = side === "ours" ? rec : F.fighters.get(targetId);
    const fo = side === "ours" ? F.foes.get(targetId) : rec;
    if (fr && fo && !fo.downShown && !fr.f.isDown) {
      const a = fr.f.bladeWorld(_v), b = sailors.bladeWorld(fo.id, _w);
      if (b) { const p = a.clone().lerp(b, 0.5); fx?.sparks?.(p, { count: 9, speed: 2.4, color: "#ffe6b0" }); cueOut("clash", { who: fr.id, foe: fo.id, x: p.x, y: p.y, z: p.z }); }
    }
  }

  /** A gunner's shot: aim, the flash and smoke, a tracer; the core's hit (if any) lands with it. */
  function gunnerShot(fo, fr) {
    const sw = fo.swing = { t0: F.t, target: fr.id, done: false };
    sailors.aimAt(fo.id, { x: fr.f.x, z: fr.f.z });
    later(0.32, () => {
      if (!F || fo.downShown) return;
      sailors.act(fo.id, "fire");
      const mz = sailors.muzzleWorld(fo.id, new THREE.Vector3()), dirW = sailors.aimDir(fo.id, new THREE.Vector3());
      if (mz && dirW) {
        fx?.muzzle?.(mz, dirW, { scale: 0.22, smoke: 0.45 });
        const to = fr.f.chestWorld(new THREE.Vector3());
        if (!findHit(fo.id, fr.id, sw.t0)) { to.x += rand(-0.6, 0.6); to.y += rand(-0.2, 0.5); to.z += rand(-0.6, 0.6); }
        fx?.trail?.(mz, to, 0.07, { color: "#ffd8a0", lift: 0, size: 0.035, intensity: 3, burst: false });
        cueOut("enemy_pistol", { foe: fo.id, x: mz.x, y: mz.y, z: mz.z });
      }
      later(0.08, () => resolveSwing(fo, "foes", fr.id, sw));
      later(0.5, () => sailors.aimAt(fo.id, null));
    });
  }

  /** The captain's heavy blow at `fr`: the telegraph, then the slam (his hits meanwhile land with it). */
  function heavyBlow(fr) {
    F.lastHeavyT = F.t;
    captainTelegraph(fr.id, HEAVY_WINDUP);
    later(HEAVY_WINDUP, () => captainSlam({ coreHits: true }));
  }

  function onHit(p) {
    if (!F) return;
    F.coreDriven = true;
    const by = String(p.by ?? ""), tgt = String(p.target ?? "");
    if (by === "pistol" || p.pistol) {
      pistolShot({ target: tgt, killed: p.killed });
      // Her captain stung by the Captain's shot: a yelp (now and then).
      if (tgt === F.captainId && F.t - F.hurtSayT > 5) {
        F.hurtSayT = F.t;
        later(0.35, () => { if (F && !F.foes.get(F.captainId)?.down) say(F.captainId, pickOf(ARCHETYPES[F.arch]?.lines?.hurt), { voice: F.arch }); });
      }
      return;
    }
    const side = p.side === "foes" ? "foes" : "ours";        // the striker's side
    F.hits.push({ by, target: tgt, t: F.t, side, used: false, dmg: +p.dmg || 0 });
    if (F.hits.length > 80) F.hits.splice(0, F.hits.length - 80);
    const rec = side === "ours" ? F.fighters.get(by) : F.foes.get(by);
    const direct = () => later(0.1, () => { if (!F) return; const h = findHit(by, tgt, F.t - 1); if (h) { h.used = true; showHurt(side === "ours" ? "foes" : "ours", tgt, rec || null); } });
    if (!rec) { direct(); return; }
    // The captain's slam is coming: it shows his hits.
    if (side === "foes" && by === F.captainId && (F.warn || (F.slamPending && F.t <= F.slamPending.until))) return;
    // A blow in flight shows it when it lands.
    if (rec.swing && !rec.swing.done && F.t - rec.swing.t0 < 0.9) return;
    if (!startSwing(rec, side, tgt)) direct();
  }

  function onDown(p) {
    if (!F) return;
    const id = String(p.id ?? p.target ?? "");
    F.downEv.set(id, F.t);
    const side = p.side === "ours" || F.fighters.has(id) ? "ours" : "foes";
    const rec = side === "ours" ? F.fighters.get(id) : F.foes.get(id);
    if (!rec) return;
    rec.down = true;
    // Shown by the blow that did it; if none lands within a second, they fall anyway.
    later(1.0, () => { if (!F) return; if (side === "ours") { if (!rec.f.isDown && rec.down) dropOurs(rec); } else if (!rec.downShown) dropFoe(rec, [-F.side, 0]); });
  }

  /** One figure's act changed (a new swing, hurt, down, cheer, yield). */
  function actTransition(rec, side, src) {
    const act = String(src.act ?? "");
    const actT = +src.actT;
    const fresh = !!act && (act !== rec.lastAct || (Number.isFinite(actT) && Number.isFinite(rec.lastActT) && actT + 0.05 < rec.lastActT));
    rec.lastAct = act; rec.lastActT = actT;
    if (!fresh) return;
    switch (act) {
      case "swing": if (!F.over) startSwing(rec, side, src.target != null ? String(src.target) : null); break;
      case "hurt": later(0.3, () => { if (F && !F.over && F.t - (rec.hurtShownT ?? -9) > 0.6) showHurt(side, rec.id, null); }); break;
      case "down": later(0.6, () => { if (!F) return; if (side === "ours") { if (!rec.f.isDown) dropOurs(rec); } else dropFoe(rec, [-F.side, 0]); }); break;
      case "cheer": if (side === "ours") { if (rec.landed && !rec.f.isDown) rec.f.cheer(true); } else sailors.act(rec.id, "cheer"); break;
      case "yield": if (side === "foes") { sailors.act(rec.id, "panic", { on: false }); sailors.act(rec.id, "surrender"); } break;
      // The gimmicks on ours: a pie in the face (reeling, stars), over on the soap, pressed against a wall that isn't there.
      case "dazed": if (side === "ours" && rec.landed && !rec.f.isDown) { rec.f.stop(); rec.f.act("stagger"); } break;
      case "slip":
        if (side === "ours" && rec.landed && !rec.f.isDown && !rec.f.leaping) {
          rec.f.stop();
          rec.f.down([Math.sin(rec.f.yaw), Math.cos(rec.f.yaw)]);
          rec.f.chestWorld(_v); _v.y -= 0.8; fx?.burst?.(_v.clone(), { color: "#f0f8ff", count: 14, speed: 1.4, size: 0.14, life: 0.8, gravity: -0.3, intensity: 1.6 });
          later(1.0, () => { if (F && !rec.down) rec.f.getup(); });
        }
        break;
      case "walled": if (side === "ours" && rec.landed && !rec.f.isDown) { rec.f.stop(); rec.wallT = 0; } break;
      // Hers: the admiral's tea, the aria, a pie thrown, the mime at work, the Pale Captain gone to mist, Pip running, a monkey off.
      case "tea": if (side === "foes") sailors.act(rec.id, "tea", { hold: 3 }); break;
      case "sing": if (side === "foes") sailors.act(rec.id, "sing", { hold: 5 }); break;
      case "throw": if (side === "foes") sailors.act(rec.id, "throw"); break;
      case "mime": if (side === "foes") sailors.act(rec.id, "mime", { hold: 1.4 }); break;
      case "run": if (side === "foes") sailors.act(rec.id, "panic", { on: true }); break;
      case "fled":
        if (side === "foes" && !rec.fled) {
          rec.fled = true;
          const s = sailors.get(rec.id);
          if (s) {
            const z = clamp(s.z, F.ship.zMin, F.ship.zMax);
            sailors.moveTo(rec.id, -F.side * F.ship.halfW(z), z, { speed: 4.5, r: 0.3 });
            later(0.9, () => { if (!F) return; const c = sailors.chestWorld(rec.id, new THREE.Vector3()); if (c) fx?.burst?.(c.setY(c.y + 0.6), { color: "#ffd75a", count: 18, speed: 1.6, size: 0.12, life: 0.8, intensity: 3 }); sailors.remove(rec.id); });
          }
        }
        break;
      default: break;
    }
  }

  function readCore(bf, list, ours) {
    const capt = (bf.captain && typeof bf.captain === "object") ? bf.captain : null;
    if (capt) {
      if (capt.name) F.captainName = capt.name;
      if (!!(capt.present ?? capt.onDeck) && !F.captainShown) captainAppears(capt.name);
    }
    for (const src of list) {
      let fo = F.foes.get(String(src.id));
      if (!fo && (src.kind === "captain" || src.boss)) fo = F.foes.get(F.captainId);
      if (!fo && !F.over && src.state !== "down") fo = addFoe(src);
      if (!fo) continue;
      if (fo.kind === "captain" && !F.captainShown) captainAppears(src.name);
      syncCore(fo, "foes", src);
    }
    if (capt) {
      const fo = F.foes.get(F.captainId);
      if (fo) { const hp = hpOf(capt), max = hpMaxOf(capt); if (max) fo.hpMax = max; if (hp != null) fo.hp = hp; if (isDown(capt)) fo.down = true; }
    }
    for (const src of ours) { const fr = F.fighters.get(String(src.id)); if (fr) syncCore(fr, "ours", src); }
    const out = bf.outcome ?? bf.result ?? (bf.phase === "struck" ? "won" : bf.phase === "repelled" ? "lost" : null);
    if (out && !F.over) finish(/won|struck|victory|win/i.test(String(out)) ? "won" : "lost");
  }

  function syncCore(rec, side, src) {
    const hp = hpOf(src), max = hpMaxOf(src), down = isDown(src);
    if (max) rec.hpMax = max;
    if (Number.isFinite(+src.x) && Number.isFinite(+src.z)) rec.core = { x: +src.x, z: +src.z, target: src.target != null ? String(src.target) : null };
    else if (rec.core && src.target !== undefined) rec.core.target = src.target != null ? String(src.target) : null;
    actTransition(rec, side, src);
    if (side === "ours") {
      const fr = rec;
      // Back on their feet (a rally, a heal): up, with a green-gold glow.
      if (!down && fr.down && (fr.f.isDown || fr.downShown)) {
        fr.f.getup(); fr.downShown = false;
        fr.f.chestWorld(_v); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 18, speed: 1.6, size: 0.16, life: 1, gravity: -0.6, intensity: 3 });
        cueOut("revive", { who: fr.id });
      } else if (hp != null && hp > fr.hp + 3 && !down && fr.landed && !F.over) {
        fr.f.chestWorld(_v); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 10, speed: 1.2, size: 0.12, life: 0.8, gravity: -0.6, intensity: 2.6 });
      }
      if (down && !fr.down) F.downEv.set(fr.id, F.downEv.get(fr.id) ?? F.t);
      fr.down = down;
    } else if (down) rec.down = true;
    if (hp != null) rec.hp = hp;
  }

  /** Ours go where the core has them (on our drawn deck), facing whom they fight; Ara tends the hurt nearby. */
  function stepCoreFighter(fr, dt) {
    const f = fr.f, c = fr.core;
    if (!fr.landed || f.leaping || f.isDown || F.over || !c) return;
    // Pressed against the Mime's wall: palms on it, again and again; dazed by a pie: no steps till it wears off.
    if (fr.lastAct === "walled") {
      const w = (F.bf?.gimmick?.walls || []).find((x) => String(x.target) === fr.id);
      if (w) { const [wx, wz] = clampDeck(...fromCore(w.x, w.z)); f.faceTo(wx, wz); }
      fr.wallT = (fr.wallT ?? 0) - dt;
      if (fr.wallT <= 0 && !f.busy) { fr.wallT = 0.55; f.act("block"); }
      return;
    }
    if (fr.lastAct === "dazed" || fr.lastAct === "slip") return;
    const [gx, gz] = clampDeck(...fromCore(c.x, c.z));
    const far = Math.hypot(gx - f.x, gz - f.z);
    const fo = c.target ? F.foes.get(c.target) : null;
    const s = fo && !fo.downShown ? sailors.get(fo.id) : null;
    if (far > 0.3 && !f.busy) {
      if (fr.role === "charger" && far > 3.5 && !f.moving) f.charge(gx, gz, { r: 0.3 });
      else if (!(fr.role === "charger" && f.moving)) f.moveTo(gx, gz, { speed: far > 3 ? 3.6 : 2.2, r: 0.2, keepFacing: far < 2.2 && !!s });
    }
    if (s) { if (far < 2.2 || !f.moving) f.faceTo(s.x, s.z); fr.lookT = (fr.lookT ?? 0) - dt; if (fr.lookT <= 0) { fr.lookT = 0.5; f.lookAt(sailors.headWorld(fo.id, _v), 0.8); } }
    // Ara: someone of ours down or badly hurt within 5 m, and nobody on her → the tonic.
    if (fr.role === "healer") {
      const hurt = !fr.f.acting && ![...F.foes.values()].some((x) => !x.downShown && x.core?.target === fr.id && Math.hypot(...fromCore(x.core.x - c.x, x.core.z - c.z)) < 2.2)
        ? [...F.fighters.values()].find((o) => o !== fr && o.landed && (o.f.isDown || o.hp / Math.max(1, o.hpMax) < 0.35) && Math.hypot(o.f.x - f.x, o.f.z - f.z) < 5) : null;
      if (hurt && !f.moving) {
        if (fr.healing !== hurt.id) { fr.healing = hurt.id; f.heal({ x: hurt.f.x, z: hurt.f.z }); }
        fr.healFx = (fr.healFx ?? 0) - dt;
        if (fr.healFx <= 0) { fr.healFx = 0.45; f.handWorld(_v, "left"); fx?.burst?.(_v.clone(), { color: "#c8ff8a", count: 8, speed: 0.8, size: 0.12, life: 0.9, gravity: -0.8, intensity: 2.4 }); }
      } else if (fr.healing) { fr.healing = null; f.heal(null); }
    }
  }

  /** Her people go where the core has them, facing whom they fight. */
  function stepCoreFoe(fo) {
    const s = sailors.get(fo.id), c = fo.core;
    if (!s || !c || fo.downShown || fo.fled || s.down || s.surrender || s.shown < 0.5 || s.ride || F.over) return;
    const qd = (fo.kind === "captain" || fo.id === "tiny") && s.z < F.ship.zMin - 0.2;
    const [gx, gz] = qd ? clampQD(...fromCore(c.x, c.z)) : clampDeck(...fromCore(c.x, c.z));
    const fr = c.target ? F.fighters.get(c.target) : null;
    const far = Math.hypot(gx - s.x, gz - s.z);
    // Pip running for it, a monkey, a gull: quick on their feet (wings).
    const quick = s.panic || s.look === "monkey" || s.bird;
    if (far > 0.35 && (!s.act || quick)) sailors.moveTo(fo.id, gx, gz, { speed: quick ? 4 : far > 3 ? 3.2 : 1.7, r: 0.25, keepFacing: far < 2.5 && !!fr && !quick });
    if (fr && fr.landed && !fr.f.leaping && (far < 2.5 || !s.goal)) sailors.faceTo(fo.id, fr.f.x, fr.f.z);
    fo.engagedBy = fr ? fr.id : null;
  }

  // ---- Per frame -------------------------------------------------------------------------------------

  function update(state, dt = 1 / 60) {
    const bf = boardFightOf(state);
    if (!F) {
      // A fight in the state that we haven't staged: start it (late joiners, a reload) — but not the one we just
      // finished staging while the state still carries it.
      if (!bf) lastDone = null;
      const key = bf ? `${bf.enemyId ?? bf.enemy?.id ?? bf.shipId ?? ""}|${bf.id ?? ""}` : null;
      if (bf && key !== lastDone && !(bf.outcome || bf.over || bf.done) && (bf.active !== false)) start(state);
      if (!F) return;
    }
    const d = clamp(+dt || 0, 0, 0.1);
    F.t += d;
    if (F.ship.own) placeStandin(state);
    // Timers.
    for (let i = timers.length - 1; i >= 0; i--) {
      if (F && F.t >= timers[i].at) { const tm = timers.splice(i, 1)[0]; try { tm.fn(); } catch (error) { console.debug("[night-raid] boardfight timer threw", error); } }
      if (!F) return;
    }
    // Phases by our own clock (the state's own phase isn't needed to stage it).
    if (F.phase === "grapple" && F.t >= GRAPPLE_T - 0.15) {
      F.phase = "swing";
      shot("swing", { cut: true });
      // From the cut onto her deck her canvas is out of the picture (her fore-and-aft sails can't be clewed up in
      // the ship shader and hang face-on to a lens looking across her deck); back at cleanup.
      if (F.ship.sh?.sails && F.ship.sh.sails.visible) { F.ship.sh.sails.visible = false; F.sailsHidden = true; }
      for (const fr of F.fighters.values()) later(Math.max(0, fr.swingAt - F.t), () => launch(fr));
    }
    if (F.phase === "swing") {
      const all = [...F.fighters.values()];
      if (all.every((fr) => fr.landed) || F.t > GRAPPLE_T + all.length * SWING_GAP + 3) {
        F.phase = "fight";
        for (const fr of all) { fr.landed = true; }
        shot(F.captainShown && !F.captainCutDone ? "captain" : "fight", { duration: 1.0, hold: F.captainShown && !F.captainCutDone ? 2.6 : 0 });
        F.captainCutDone = F.captainCutDone || F.captainShown;
        R.post?.set?.({ letterbox: 0 }, { duration: 0.6 });
      }
    }
    if (bf && (!bf.enemyId || String(bf.enemyId) === String(F.enemyId) || bf.enemy?.id === F.enemyId)) readState(bf);
    if (!F) return;
    if (F.coreDriven && !F.over) {
      // The core places everyone (ours once they've landed).
      for (const fr of F.fighters.values()) stepCoreFighter(fr, d);
      for (const fo of F.foes.values()) stepCoreFoe(fo);
    } else if (F.phase === "fight" && !F.over) {
      for (const fr of F.fighters.values()) stepFighter(fr, d);
      stepFoes(d);
      // The captain comes up once half his crew are down (when the core doesn't say so itself).
      if (!F.captainShown && !bf?.captain) {
        const sailorsAll = [...F.foes.values()].filter((x) => x.kind !== "captain");
        if (sailorsAll.length && sailorsAll.filter((x) => x.down).length >= sailorsAll.length / 2) captainAppears();
      }
    }
    if (F.homing) {
      // Everyone home → done.
      if ([...F.fighters.values()].every((fr) => fr.home_ || (!fr.f.leaping && fr.f.isDown === false && fr.home_))) { cleanup(); return; }
      if (F.t - F.endT > 12) { cleanup(); return; }
    }
    separate();
    stepRings(d);
    sailors.update(d, { deckY: F.ship.deckY });
    stepWhacky(d, bf || F.bf);
    updateRopes(d);
    stepCamera(d);
    // Her canvas clewed up while she's boarded (it would hang between the lens and the fight); the fleet sets it
    // back when we let go (and keeps it up when she strikes).
    const sh = F.ship.sh;
    if (sh?.U?.uSet && !sh.sinking) {
      F.furl = F.furl == null ? sh.set ?? 1 : F.furl + (0.06 - F.furl) * Math.min(1, d * 1.6);
      if (!(F.homing && F.outcome === "lost")) { sh.set = Math.min(sh.set ?? 1, F.furl); sh.U.uSet.value = sh.set; }
    }
    // The battle lanterns over the fight (by night; a touch by day).
    const foc = F.cam.focus;
    fromStage(foc.x + F.side * 1.5, foc.y + 5.5, foc.z - 1, fightLight.position);
    const want = 70 * (1 - 0.85 * clamp(R.atmos?.day ?? 0, 0, 1)) * smooth(0, 1.5, F.t) * (F.homing ? Math.max(0, 1 - (F.t - F.endT - 2) / 2) : 1);
    fightLight.intensity += (want - fightLight.intensity) * Math.min(1, d * 3);
  }

  function stepRings(dt) {
    const SI = F.ship;
    // The rally: two golden rings racing out across the deck.
    if (F.rally) {
      const r = F.rally; r.t += dt;
      const k = r.t / 0.9;
      for (const [ring, lag, scale] of [[rallyRing, 0, 16], [rallyRing2, 0.12, 11]]) {
        const kk = clamp((r.t - lag) / 0.9, 0, 1);
        ring.visible = kk > 0 && kk < 1;
        ring.position.set(r.x, r.y + 0.08, r.z);
        ring.scale.setScalar(0.5 + scale * (1 - Math.pow(1 - kk, 2.2)));
        ring.material.opacity = 1.2 * (1 - kk);
      }
      if (k > 1.2) F.rally = null;
    } else { rallyRing.visible = rallyRing2.visible = false; }
    // The captain's telegraph: a red ring closing on the spot, pulsing faster as the blow comes.
    if (F.warn) {
      const w = F.warn; w.t += dt;
      const k = clamp(w.t / w.dur, 0, 1);
      // It follows the target until the last third.
      const fr = w.target && F.fighters.get(w.target);
      if (fr && k < 0.66) { w.x = fr.f.x; w.z = fr.f.z; }
      warnRing.visible = true;
      warnRing.position.set(w.x, SI.deckY(w.x, w.z) + 0.07, w.z);
      warnRing.scale.setScalar(3.6 - 1.8 * k);
      warnRing.material.opacity = (0.55 + 0.45 * Math.abs(Math.sin(w.t * (6 + 14 * k)))) * smooth(0, 0.15, w.t);
      if (w.t > w.dur + 1.2) F.warn = null;
    } else warnRing.visible = false;
    // The slam's shock.
    if (F.shock) {
      const s = F.shock; s.t += dt;
      const k = clamp(s.t / 0.55, 0, 1);
      shockRing.visible = k < 1;
      shockRing.position.set(s.x, s.y + 0.08, s.z);
      shockRing.scale.setScalar(0.6 + 6 * (1 - Math.pow(1 - k, 2)));
      shockRing.material.opacity = 1.3 * (1 - k);
      if (k >= 1) F.shock = null;
    } else shockRing.visible = false;
  }

  // ---- Events --------------------------------------------------------------------------------------

  /**
   * A run event. The fight's own: "boardfight" {stage: "start"|"captain"|"captain_attack"|"windup"|"strike"|"pistol"|
   * "rally"|"focus"|"won"|"struck"|"lost"|"repelled"|"end", …}; also the v3 "board" {stage: "start"|"won"|"lost"}.
   */
  function event(name, p = {}) {
    p = p || {};
    if (name !== "boardfight" && name !== "board") return;
    const stage_ = String(p.stage ?? p.type ?? "");
    if (name === "board") {
      // v4 still sends board {stage: "start"} first (the state carries the fight: update() stages it); its
      // won / lost come 2.5 s after struck / repelled, by when the end beats are playing.
      if (stage_ === "won" || stage_ === "lost") finish(stage_);
      return;
    }
    switch (stage_) {
      case "start": if (!F && p.state) start(p.state); break;          // else update() starts it from the state
      case "hit": onHit(p); break;
      case "down": onDown(p); break;
      case "order": if (F && p.focus) F.focus = String(p.focus); break;
      case "captain": case "captain_appears": case "boss": captainAppears(p.name); break;
      case "captain_attack": case "telegraph": case "windup":
        if (F) { F.coreTelegraphs = true; if (p.strike || p.stage2 === "strike") captainSlam({ targets: p.targets }); else captainTelegraph(p.target, Number.isFinite(+p.windup) ? +p.windup : Number.isFinite(+p.eta) ? +p.eta : 1.2); }
        break;
      case "strike": case "slam": case "captain_strike": if (F) { F.coreTelegraphs = true; captainSlam({ targets: p.targets || (p.target != null ? [String(p.target)] : null) }); } break;
      case "pistol": case "shot": pistolShot(p); break;
      case "rally": rally(); break;
      case "focus": if (F && p.focus) F.focus = String(p.focus); break;
      case "gimmick": onGimmick(p); break;
      case "won": case "struck": case "surrender": case "victory": endLine(true); finish("won"); break;
      case "lost": case "repelled": case "cut_free": endLine(false); finish("lost"); break;
      case "end": if (F && !F.over) finish(p.outcome || p.result || "lost"); break;
      default: break;
    }
  }

  // ---- The whacky captains: speech, gimmick moments, the extras each frame ------------------------------

  /** Who's speaking in which voice: her captain (the archetype's), Tiny, her crew (their variant's). */
  function voiceOf(id) {
    if (!F) return "normal";
    if (String(id) === String(F.captainId)) return F.arch;
    const s = sailors.get(id);
    return s?.look === "tiny" ? "tiny" : s?.bird ? "gull" : s?.look && CREW_VARIANTS[s.look] ? s.look : "sailor";
  }
  /** A line over somebody of hers (a bubble for the HUD, a babble for the audio). */
  function say(id, text, { voice = null, dur = null } = {}) {
    if (!F || id == null || !text) return false;
    const s = sailors.get(id);
    if (!s || s.gone) return false;
    // Room for it: the oldest bubble makes way (the same speaker's is replaced).
    if (!F.says.has(String(id)) && F.says.size >= BUBBLES_MAX) {
      let old = null; for (const [k, v] of F.says) if (!old || v.t < F.says.get(old).t) old = k;
      F.says.delete(old);
    }
    const v = voice || voiceOf(id);
    F.says.set(String(id), { text: String(text), t: F.t, dur: dur ?? sayDur(text), voice: v });
    cueOut("say", { id: String(id), text: String(text), voice: v, archetype: F.arch });
    return true;
  }
  /** Somebody of hers on their feet to speak (her captain first when `captain`). */
  function speaker({ captain = false } = {}) {
    const up = [...F.foes.values()].filter((fo) => !fo.down && !fo.fled && sailors.get(fo.id) && sailors.get(fo.id).shown > 0.5 && (fo.kind !== "captain" || F.captainShown));
    if (captain) { const c = up.find((fo) => fo.id === F.captainId); if (c) return c.id; }
    const crew = up.filter((fo) => fo.id !== F.captainId);
    return crew.length ? crew[Math.floor(Math.random() * crew.length)].id : null;
  }
  /** The chatter between moments: her captain's idle lines, her crew's (their variant's), Tiny's. */
  function chatter(dt) {
    if (F.over || F.phase !== "fight") return;
    F.chatterT -= dt;
    for (const [k, v] of F.says) if (F.t - v.t > v.dur) F.says.delete(k);
    if (F.chatterT > 0) return;
    F.chatterT = rand(CHATTER[0], CHATTER[1]) * (F.arch === "normal" ? 1.5 : 1);
    const A = ARCHETYPES[F.arch];
    const capUp = F.captainShown && !F.foes.get(F.captainId)?.down;
    // (Pip off Tiny's shoulders has only one thing on his mind.)
    const running = F.arch === "pip" && !sailors.get(F.captainId)?.ride && F.bf?.gimmick?.running;
    if (capUp && Math.random() < 0.55) { say(F.captainId, pickOf(running ? A.lines.pip_runs : A.lines.idle)); return; }
    const id = speaker();
    if (id == null) return;
    const s = sailors.get(id);
    const V = s.look === "tiny" ? CREW_VARIANTS.tiny : s.bird ? CREW_VARIANTS.gull : CREW_VARIANTS[s.look] || CREW_VARIANTS.sailor;
    say(id, F.arch === "mime" && Math.random() < 0.3 ? "…?" : pickOf(V.lines));
  }
  /** The last word: her captain's surrender (or a gloat when we're thrown back). */
  function endLine(won) {
    if (!F || F.endSaid) return;
    F.endSaid = true;
    const A = ARCHETYPES[F.arch];
    const id = F.captainShown ? F.captainId : speaker();
    if (id == null) return;
    later(0.6, () => say(id, won ? pickOf(A.lines.yield) : pickOf(A.lines.intro) || "Ha!", { voice: voiceOf(id), dur: 3.2 }));
  }

  /** A gimmick moment from the core: its look on deck, its line. */
  function onGimmick(p) {
    if (!F) return;
    const what = String(p.what || "");
    const A = ARCHETYPES[F.arch] || ARCHETYPES.normal;
    const cap = F.captainId, capS = sailors.get(cap);
    const line = (who = cap, key = what) => say(who, pickOf(A.lines[key]), { voice: voiceOf(who) });
    const frOf = (id) => (id != null ? F.fighters.get(String(id)) : null);
    switch (what) {
      case "coat_collapse": {
        // The coat heaps on the deck; three gulls burst out of it in a cloud of feathers.
        const fo = F.foes.get(cap);
        if (fo) { fo.down = true; fo.downShown = true; }
        sailors.act(cap, "collapse");
        const at = capS ? { x: capS.x, z: capS.z } : null;
        (p.ids || ["g1", "g2", "g3"]).forEach((gid, i) => {
          const a = (i / 3) * Math.PI * 2;
          addFoe({ id: gid, kind: "gull", look: "gull", hp: 14, max: 14 }, { at: at ? { x: at.x + Math.cos(a) * 0.5, z: at.z + Math.sin(a) * 0.5 } : null });
        });
        if (capS) { sailors.chestWorld(cap, _v); fx?.burst?.(_v.clone(), { color: "#f8f8f4", count: 46, speed: 2.6, size: 0.16, life: 1.4, gravity: 0.25, intensity: 1.8 }); }
        R.cam.trauma(0.1);
        later(0.3, () => say(p.ids?.[0] || "g1", pickOf(A.lines.coat_collapse), { voice: "gull" }));
        break;
      }
      case "gull_down": { const id = speaker(); if (id && sailors.get(id)?.bird) say(id, pickOf(A.lines.gull_down), { voice: "gull" }); break; }
      case "tea": line(); break;
      case "pie": {
        const fr = frOf(p.target);
        throwPie(fr);
        if (Math.random() < 0.8) line();
        break;
      }
      case "tiny_down": {
        sailors.ride(cap, null);
        line(cap, "tiny_down");
        break;
      }
      case "pip_runs": sailors.act(cap, "panic", { on: true }); later(1.2, () => line(cap, "pip_runs")); break;
      case "dodge": pistolShot({ target: cap, hit: false }); if (Math.random() < 0.7) line(cap, "dodge"); break;
      case "pip_caught": sailors.act(cap, "panic", { on: false }); line(cap, "pip_caught"); break;
      case "shield_pop": {
        if (p.pistol) pistolShot({ target: cap, blocked: true, blockColor: "#cfefff", onBlock: () => popShield() });
        else popShield();
        line(cap, "shield_pop");
        break;
      }
      case "shield_up": F.shieldK = 0.15; line(cap, "shield_up"); break;
      case "slip": if (Math.random() < 0.5 && F.captainShown) line(cap, "slip"); break;
      case "aria": line(); break;
      case "aria_cut": if (capS) { sailors.act(cap, "hit"); } later(0.5, () => line(cap, "aria_cut")); break;
      case "claw_block": {
        sailors.act(cap, "parry");
        if (p.pistol) pistolShot({ target: cap, blocked: true, blockAt: sailors.bladeWorld(cap, new THREE.Vector3()) || undefined });
        else if (capS) fx?.sparks?.(sailors.bladeWorld(cap, new THREE.Vector3()), { count: 10, speed: 2.4, color: "#ffe6b0" });
        cueOut("clash", { who: null, foe: cap });
        if (Math.random() < 0.6) line();
        break;
      }
      case "flanked": line(); break;
      case "wall": if (Math.random() < 0.7) line(cap, "wall"); break;
      case "fade": {
        // Gone to mist: the figure out of sight, a cold glow where he stood.
        if (capS) { sailors.chestWorld(cap, _v); fx?.burst?.(_v.clone(), { color: "#a8d8e8", count: 30, speed: 0.8, size: 0.5, life: 1.4, gravity: -0.2, intensity: 1.2 }); }
        sailors.show(cap, false); F.faded = true;
        line();
        break;
      }
      case "fade_end":
        if (F.faded) { sailors.show(cap, true); F.faded = false; if (capS) { sailors.chestWorld(cap, _v); fx?.burst?.(_v.clone(), { color: "#a8d8e8", count: 24, speed: 1.0, size: 0.45, life: 1.0, gravity: -0.2, intensity: 1.2 }); } }
        break;
      case "pass_through":
        if (p.pistol) pistolShot({ target: cap, blocked: true, blockColor: "#bff0ff" });
        if (Math.random() < 0.7) line(cap, "pass_through");
        break;
      case "reassemble": {
        const fo = F.foes.get(String(p.id));
        if (fo) { fo.down = false; fo.downShown = false; F.downEv.delete(fo.id); fo.lastAct = null; }
        sailors.act(p.id, "getup");
        const c = sailors.chestWorld(p.id, new THREE.Vector3());
        if (c) fx?.sparks?.(c.setY(c.y - 0.5), { count: 16, speed: 2, color: "#f4f0dc" });
        say(p.id, pickOf(CREW_VARIANTS.skeleton.lines), { voice: "skeleton" });
        if (Math.random() < 0.5 && F.captainShown) later(0.8, () => line(cap, "reassemble"));
        break;
      }
      case "monkey_steal": say(p.id, pickOf(["Shiny!", "Hee hee!", "Ook!"]), { voice: "monkey" }); break;
      default: break;
    }
  }

  function popShield() {
    if (!F) return;
    F.shieldPop = { t: 0 };
    const s = sailors.get(F.captainId);
    if (s) { sailors.chestWorld(F.captainId, _v); fx?.burst?.(_v.clone(), { color: "#d8f4ff", count: 30, speed: 2.2, size: 0.14, life: 0.9, gravity: -0.4, intensity: 2.2 }); }
  }

  /** Cookie Mabel's pie: from her hand in an arc to the target's face, then a splat. */
  function throwPie(fr) {
    const pie = pies.find((x) => !x.userData.fly) || pies[0];
    const from = sailors.handWorld(F.captainId, new THREE.Vector3(), "left");
    if (!from || !fr) return;
    const a = toStage(from, new THREE.Vector3());
    pie.userData.fly = { a, fr, t: -0.38, dur: 0.55 };    // leaves the hand as the throw comes over
    pie.position.copy(a); pie.visible = false;
  }

  /** Per frame: the bubble shield, the walls, the notes, the stars, the pies, the pale glow, the suds, the tea's steam; the chatter. */
  function stepWhacky(dt, bf) {
    const G = bf?.gimmick || {};
    F.fxT += dt;
    const cap = sailors.get(F.captainId), capUp = cap && F.captainShown && !cap.down;
    const T = F.t;
    chatter(dt);
    // The Baron's bubble shield.
    const wantShield = F.arch === "bubbles" && capUp && G.shield?.up && !F.over;
    F.shieldK = clamp(F.shieldK + (wantShield ? dt * 1.8 : -dt * 4), 0, 1);
    if (F.shieldPop) F.shieldPop.t += dt;
    if (cap && (F.shieldK > 0.01 || (F.shieldPop && F.shieldPop.t < 0.3))) {
      cap.sk.torso.getWorldPosition(_v);
      const pop = F.shieldPop && F.shieldPop.t < 0.3 ? F.shieldPop.t / 0.3 : 0;
      const r = 1.05 * cap.scale * (0.6 + 0.4 * smooth(0, 1, F.shieldK)) * (1 + 0.4 * pop);
      shield.visible = true;
      shield.position.set(_v.x, _v.y - 0.15, _v.z);
      shield.scale.set(r * (1 + 0.04 * Math.sin(T * 5.1)), r * (1 + 0.04 * Math.sin(T * 4.3 + 1)), r * (1 + 0.04 * Math.sin(T * 3.7 + 2)));
      shieldMat.uniforms.uT.value = T;
      shieldMat.uniforms.uOp.value = pop > 0 ? 1 - pop : F.shieldK;
    } else shield.visible = false;
    if (F.shieldPop && F.shieldPop.t > 0.3 && !wantShield) F.shieldPop = null;
    // Soap suds on her deck and bubbles rising out of the tub.
    if (F.arch === "bubbles" && !F.sudsOn) {
      F.sudsOn = true;
      for (let i = 0; i < 8; i++) {
        const z = THREE.MathUtils.lerp(F.ship.zMin, F.ship.zMax, Math.random()), w = F.ship.halfW(z) * 0.85, x = (Math.random() * 2 - 1) * w;
        _m.compose(_p.set(x, F.ship.deckY(x, z) + 0.025, z), _q.setFromAxisAngle(Yv, Math.random() * 6.28), _s.set(0.9 + Math.random() * 1.1, 1, 0.7 + Math.random() * 0.9));
        suds.setMatrixAt(i, _m);
      }
      suds.count = 8; suds.instanceMatrix.needsUpdate = true; suds.visible = true;
    }
    if (F.arch === "bubbles" && capUp && Math.floor(F.fxT / 0.45) !== Math.floor((F.fxT - dt) / 0.45)) {
      fromStage(cap.x, cap.y + 0.75 * cap.scale, cap.z, _v);
      fx?.burst?.(_v.clone(), { color: "#e2f4ff", count: 4, speed: 0.5, size: 0.1, life: 1.6, gravity: -0.35, intensity: 1.4 });
    }
    // The Mime's walls.
    const W = G.walls || [];
    walls.forEach((m, i) => {
      const w = W[i];
      const op = m.material.uniforms.uOp;
      if (w && !F.over) {
        const [wx, wz] = clampDeck(...fromCore(w.x, w.z));
        const fr = F.fighters.get(String(w.target));
        m.position.set(wx, F.ship.deckY(wx, wz), wz);
        if (fr) m.rotation.set(0, Math.atan2(wx - fr.f.x, wz - fr.f.z), 0);
        op.value = Math.min(1, op.value + dt * 5) * (w.t < 0.3 ? w.t / 0.3 : 1);
        m.visible = true;
      } else { op.value = Math.max(0, op.value - dt * 4); m.visible = op.value > 0.01; }
      m.material.uniforms.uT.value = T;
    });
    // Señor Encore's notes: off his head to the crew he's healing.
    const singing = F.arch === "encore" && capUp && G.aria > 0 && !F.over;
    if (singing && Math.floor(F.fxT / 0.16) !== Math.floor((F.fxT - dt) / 0.16)) {
      const n = notes.find((x) => x.userData.life <= 0);
      if (n) {
        cap.sk.head.getWorldPosition(_v);
        const near = [...F.foes.values()].filter((fo) => fo.id !== F.captainId && !fo.down).map((fo) => sailors.get(fo.id)).filter((s) => s && Math.hypot(s.x - cap.x, s.z - cap.z) < 9);
        const to = near.length ? near[Math.floor(Math.random() * near.length)] : null;
        n.position.set(_v.x, _v.y + 0.25, _v.z);
        const tx = to ? to.x : cap.x + rand(-2, 2), tz = to ? to.z : cap.z + rand(-2, 2), ty = (to ? to.y + 1.6 : _v.y + 1.4);
        n.userData.v.set((tx - _v.x) / 1.4, (ty - _v.y) / 1.4 + 0.4, (tz - _v.z) / 1.4);
        n.userData.life = 1.4; n.userData.t = 0; n.visible = true;
      }
    }
    for (const n of notes) {
      const u = n.userData;
      if (u.life <= 0) { n.visible = false; continue; }
      u.life -= dt; u.t += dt;
      n.position.addScaledVector(u.v, dt);
      n.position.x += Math.sin(u.t * 9) * 0.01;
      n.material.opacity = smooth(0, 0.15, u.t) * smooth(0, 0.4, u.life);
      n.scale.setScalar(0.26 + 0.08 * Math.sin(u.t * 6));
      if (u.life <= 0) n.visible = false;
    }
    // Stars round a pie-dazed head.
    let si = 0;
    for (const fr of F.fighters.values()) {
      if (fr.lastAct !== "dazed" || F.over || !fr.landed || si > 6) continue;
      fr.f.headWorld(_v); toStage(_v, _w);
      for (let k = 0; k < 3; k++) {
        const a = T * 4 + (k / 3) * Math.PI * 2;
        stars[si].position.set(_w.x + Math.cos(a) * 0.28, _w.y - 0.05 + 0.04 * Math.sin(a * 2), _w.z + Math.sin(a) * 0.28);
        stars[si].visible = true; si++;
      }
    }
    for (; si < stars.length; si++) stars[si].visible = false;
    // Pies in flight.
    for (const pie of pies) {
      const fl = pie.userData.fly;
      if (!fl) { pie.visible = false; continue; }
      fl.t += dt;
      if (fl.t < 0) continue;
      const k = clamp(fl.t / fl.dur, 0, 1);
      fl.fr.f.headWorld(_v); toStage(_v, _w); _w.y -= 0.15;
      pie.position.lerpVectors(fl.a, _w, k); pie.position.y += Math.sin(k * Math.PI) * 1.2;
      pie.rotation.set(0.4, T * 9, 0.2); pie.visible = true;
      if (k >= 1) {
        pie.userData.fly = null; pie.visible = false;
        fromStage(_w.x, _w.y, _w.z, _v);
        fx?.burst?.(_v.clone(), { color: "#fff4d8", count: 26, speed: 2.2, size: 0.15, life: 0.7, gravity: 0.8, intensity: 1.8 });
        if (!fl.fr.f.isDown) fl.fr.f.act("stagger");
        cueOut("pie_splat", { who: fl.fr.id });
      }
    }
    // The Pale Captain's cold glow (a strong one where he's faded to mist).
    if (F.arch === "pale" && cap && !(cap.down && !F.faded)) {
      F.ghostK += ((F.faded ? 1 : 0.28) - F.ghostK) * Math.min(1, dt * 4);
      cap.sk.pelvis.getWorldPosition(_v);
      ghost.position.set(_v.x, cap.y + 1.05 * cap.scale, _v.z);
      ghost.scale.set(1.2 * cap.scale, 2.3 * cap.scale, 1);
      ghost.material.opacity = F.ghostK * (0.75 + 0.25 * Math.sin(T * (F.faded ? 23 : 3)));
      ghost.visible = !F.over || F.ghostK > 0.05;
      if (F.faded && Math.floor(F.fxT / 0.3) !== Math.floor((F.fxT - dt) / 0.3)) { fromStage(_v.x, cap.y + 0.3, _v.z, _p); fx?.burst?.(_p.clone(), { color: "#9fc8d8", count: 3, speed: 0.4, size: 0.4, life: 1.2, gravity: -0.15, intensity: 0.9 }); }
    } else ghost.visible = false;
    // The admiral's tea: steam off the cup.
    if (F.arch === "admiral" && capUp && G.tea > 0 && Math.floor(F.fxT / 0.35) !== Math.floor((F.fxT - dt) / 0.35)) {
      const h = sailors.handWorld(F.captainId, _v, "left");
      if (h) fx?.burst?.(h.clone().setY(h.y + 0.1), { color: "#f4f4f4", count: 3, speed: 0.25, size: 0.1, life: 1.1, gravity: -0.5, intensity: 1.1 });
    }
  }

  /** The speech bubbles up now, for the HUD: [{id, text, voice, x, y, visible, age, dur, captain}]. */
  function bubbles() {
    if (!F) return [];
    const out = [];
    for (const [id, v] of F.says) {
      const age = F.t - v.t;
      if (age > v.dur) continue;
      const s = sailors.get(id);
      if (!s || s.gone || (s.shown < 0.5 && !(F.faded && id === String(F.captainId)))) continue;
      const w = sailors.headWorld(id, _v);
      if (!w) continue;
      out.push({ id, text: v.text, voice: v.voice, age, dur: v.dur, captain: id === String(F.captainId), ...project(w.setY(w.y + 0.15)) });
    }
    return out;
  }

  // ---- Picking and anchors -------------------------------------------------------------------------

  const _ndc = new THREE.Vector3();
  function project(world) {
    R.camera.updateMatrixWorld();
    _ndc.copy(world).project(R.camera);
    const r = R.renderer.domElement.getBoundingClientRect();
    const visible = _ndc.z < 1 && _ndc.z > -1 && Math.abs(_ndc.x) <= 1.05 && Math.abs(_ndc.y) <= 1.05;
    return { x: r.left + (_ndc.x * 0.5 + 0.5) * r.width, y: r.top + (-_ndc.y * 0.5 + 0.5) * r.height, visible };
  }

  /** The foe under a client point: a ray against their bodies, else the nearest on screen within 60 px. */
  function pick(clientX, clientY) {
    if (!F || F.over) return null;
    const ray = R.cam.ray({ clientX, clientY }).ray;
    const hit = sailors.pick(ray, { radius: 0.6 });
    if (hit) return hit.id;
    let best = null, bd = 60;
    for (const fo of F.foes.values()) {
      if (fo.down || (fo.kind === "captain" && !F.captainShown)) continue;
      for (const w of [sailors.chestWorld(fo.id, _v), sailors.headWorld(fo.id, _w)]) {
        if (!w) continue;
        const s = project(w);
        if (!s.visible) continue;
        const d = Math.hypot(s.x - clientX, s.y - clientY);
        if (d < bd) { bd = d; best = fo.id; }
      }
    }
    return best;
  }

  /** A fighter's / foe's HP anchor on screen: a foe id, "captain", or "crew:<id>" → {x, y, visible}. */
  function screenPos(id) {
    if (!F) return { x: 0, y: 0, visible: false };
    let w = null;
    const key = String(id);
    if (key.startsWith("crew:")) { const fr = F.fighters.get(key.slice(5)); if (fr) w = fr.f.headWorld(_v); }
    else {
      const fid = key === "captain" ? F.captainId : key;
      if (fid === F.captainId && !F.captainShown) return { x: 0, y: 0, visible: false };
      w = sailors.headWorld(fid, _v);
    }
    if (!w) return { x: 0, y: 0, visible: false };
    return project(w);
  }

  return {
    start,
    update,
    event,
    /** End the fight's staging: `{now: true}` puts everyone home at once; otherwise the end beats play out first. */
    end({ now = false, outcome = null } = {}) {
      if (!F) return;
      if (now) { cleanup(); return; }
      if (!F.over) finish(outcome || "won");
    },
    pick,
    screenPos,
    /**
     * Everything the HUD pins over the fight, per frame: [{id, kind: "foe"|"captain"|"crew", name?, hp, hpMax, down, x, y,
     * visible}] (crew ids as "crew:<id>").
     */
    anchors() {
      if (!F) return [];
      const out = [];
      for (const fo of F.foes.values()) {
        if (fo.kind === "captain" && !F.captainShown) continue;
        const s = screenPos(fo.kind === "captain" ? "captain" : fo.id);
        out.push({ id: fo.id, kind: fo.kind === "captain" ? "captain" : "foe", name: fo.kind === "captain" ? F.captainName : null, hp: fo.hp, hpMax: fo.hpMax, down: fo.down, ...s });
      }
      for (const fr of F.fighters.values()) {
        const s = screenPos(`crew:${fr.id}`);
        out.push({ id: `crew:${fr.id}`, kind: "crew", name: fr.f.name, hp: fr.hp, hpMax: fr.hpMax, down: fr.down || fr.f.isDown, ...s });
      }
      return out;
    },
    /** True from start() until everyone is home again. */
    get active() { return !!F; },
    /** "grapple" | "swing" | "fight" | "won" | "lost" (the end beats) | null. */
    get phase() { return F ? (F.over ? F.outcome : F.phase) : null; },
    get enemyId() { return F?.enemyId ?? null; },
    get captainName() { return F?.captainName || ""; },
    /** Her captain's archetype ("normal" or a whacky one). */
    get archetype() { return F?.arch || null; },
    /** The speech bubbles up now (screen positions, per frame): [{id, text, voice, x, y, visible, age, dur, captain}]. */
    bubbles,
    /** Debug / harness: make one of hers say something (a bubble and the babble). */
    say: (id, text) => say(id === "captain" ? F?.captainId : id, text),
    /** Debug / harness: a camera beat now ("captain" | "fight" | "heavy" | "won" …), held `hold` s. */
    look: (mode = "captain", hold = 4) => { if (F) shot(mode, { duration: 0.4, hold }); return F?.cam.mode ?? null; },
    /** Debug / harness: the figures and fighters. */
    stats() {
      if (!F) return { active: false };
      return {
        active: true, phase: F.phase, t: +F.t.toFixed(2), over: F.over, outcome: F.outcome, side: F.side, cam: F.cam.mode, core: F.coreDriven, archetype: F.arch,
        says: [...F.says].map(([id, v]) => `${id}: ${v.text}`),
        warn: F.warn ? +(F.warn.t / F.warn.dur).toFixed(2) : 0, captain: F.captainShown, hitsPending: F.hits.filter((h) => !h.used).length,
        endAge: F.over ? +(F.t - F.endT).toFixed(2) : 0,
        foes: [...F.foes.values()].map((x) => ({ id: x.id, kind: x.kind, hp: x.hp, down: x.down, engagedBy: x.engagedBy })),
        fighters: [...F.fighters.values()].map((x) => ({ id: x.id, hp: x.hp, down: x.down, landed: x.landed, target: x.target, x: +x.f.x.toFixed(2), z: +x.f.z.toFixed(2) })),
      };
    },
    /** Compile warm-up: the figures, lines and rings on show (call around world.compile()). */
    warmShow(on) {
      if (on) {
        if (!stage.parent) { R.scene.add(stage); stage.position.set(0, -50, 0); }
        sailors.spawn([{ id: "warm", kind: "captain", x: 0, z: 0 }, { id: "warm2", kind: "sailor", weapon: "pistol", x: 1, z: 0 }]);
        sailors.warmShow(true);
        sailors.update(0.016, {});
        ropes.visible = hooks.visible = true; ropes.count = 1; hooks.count = 1;
        for (const r of rings) { r.visible = true; r.material.opacity = 0.01; }
        for (const x of extras) x.visible = true;
        suds.count = 1;
      } else {
        sailors.warmShow(false);
        if (!F) { sailors.clear(); sailors.update(0, {}); stage.removeFromParent(); stage.position.set(0, 0, 0); ropes.visible = hooks.visible = false; ropes.count = 0; hooks.count = 0; }
        for (const r of rings) r.visible = false;
        for (const x of extras) x.visible = false;
        suds.count = 0;
      }
    },
    dispose() {
      if (F) cleanup();
      sailors.dispose();
      ropes.removeFromParent(); hooks.removeFromParent(); fightLight.removeFromParent();
      ropeGeo.dispose(); ropeMat.dispose(); hookGeo.dispose(); hookMat.dispose();
      for (const r of rings) { r.geometry.dispose(); r.material.dispose(); }
      ringTex.dispose();
      shield.geometry.dispose(); shieldMat.dispose(); wallGeo.dispose(); for (const w of walls) w.material.dispose();
      for (const s of [...notes, ...stars, ghost]) s.material.dispose();
      for (const t of [...noteTex, starTex, ghostTex, sudsTex]) t.dispose();
      pieGeo.dispose(); pieMat.dispose(); suds.geometry.dispose(); suds.material.dispose();
    },
  };
}
