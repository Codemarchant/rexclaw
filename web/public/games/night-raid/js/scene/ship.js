// Night Raid (from Night Helm): the Rexmaw under way, and the harbour she leaves (from Starboard's ship.js).
//
// The set is the app's own /assets/glb/rexmaw_deck.glb (tools/scenes/
// build_rexmaw_deck.py). Its `sky` and `water` are dropped (sky.js and
// water.js own those). The baked scene merges geometry per material across
// the whole harbour, so at load every mesh is split by triangle into what is
// aboard the Rexmaw (it rides R.shipSpace and sails) and what is ashore (the
// pier, the quay, the town, the headland and its lighthouse, the ships at
// anchor), which stays put. Ashore is turned half a circle about the mooring
// (blocking.js B.ASHORE) so that open water runs out along +Z: the pier stays
// alongside (to starboard), the lighthouse ends up astern, and leg 1 sails
// straight out of the harbour mouth.
//
// Dropped at load, by triangle: the cabin interior (never in shot), the GLB's
// baked ship's wheel (helm.js builds one that turns), the mooring lines and
// the gangplank (she casts off), the rowboat and the anchored ship that lay
// in the new fairway, and the stretch of the painted mountain ring dead ahead.
//
// Then the night pass: lanterns, windows and the lighthouse lamp turn HDR
// so they bloom, town windows go dark one by one, the painted mountains
// become silhouettes, the deck turns wet.
//
// Added, all procedural and made at load:
//   the rail lantern       brass and glass, a living flame, a halo and a warm PointLight
//   the ship's bell        brass, clapper and lanyard on a little belfry, rung in pairs
//   the lighthouse beam    two soft cones sweeping every 14 s (Medium+)
//   the night's lights     the moon (shadows on Medium+, its direction kept in
//                          WORLD space while the ship turns), sky fill, and two
//                          more lantern lights (taffrail, mainmast)
//
// The pose: world.js calls `pose(x, z, heading, heel, pitch, heave)` every
// frame; the ship pitches and heels about B.PIVOT. onRollTurn tells the
// ambience when the roll changes direction (a creak).

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { LAYERS, B } from "./blocking.js";
import { createTweens, noise1, mergeStatic } from "./util.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = THREE.MathUtils.lerp;

const GLB_URL = "/assets/glb/rexmaw_deck.glb";
const QD_FLOOR = 2.6;                           // the quarterdeck floor
/** The cabin under the quarterdeck: meshes entirely inside it are never in shot. */
const CABIN = { x0: -4.3, x1: 4.3, y0: -0.2, y1: 2.62, z0: -12.7, z1: -4.35 };
/** Aboard: the hull out to the rail, and the yards and rigging above the pier's height (GLB frame). */
const isAboard = (x, y, z) => z > -19 && z < 33 && ((Math.abs(x) <= 4.45 && y > -6) || (Math.abs(x) <= 9.2 && y > 4.5));
const TAFFRAIL_LAMP = [0, 4.05, -12.85];
const MAST_LAMP = [0, 2.05, 8.68];
const MOUNTAIN_I = 0.05;

/** The GLB's wheel: a slab around its hub (helm.js replaces it with one that turns). */
const WHEEL_SLAB = { z0: -6.935, z1: -6.79, cx: 0, cy: 3.72, r: 0.9 };
const inWheel = (x, y, z) => z > WHEEL_SLAB.z0 && z < WHEEL_SLAB.z1 && Math.hypot(x - WHEEL_SLAB.cx, y - WHEEL_SLAB.cy) < WHEEL_SLAB.r;

/**
 * Where a GLB triangle goes: "aboard", "port" or "starboard" (ashore, by side
 * of the mooring), or null to drop it. Coordinates are the GLB's frame.
 */
function placeOf(ax, ay, az, bx, by, bz, cx, cy, cz, mname) {
  const x = (ax + bx + cx) / 3, y = (ay + by + cy) / 3, z = (az + bz + cz) / 3;
  if ((mname === "Varnish" || mname === "Brass") && inWheel(ax, ay, az) && inWheel(bx, by, bz) && inWheel(cx, cy, cz)) return null;
  // Mooring lines, ship to bollards (and the gangplank's hand ropes).
  if (mname === "Rope" && x > 4.46 && x < 7.0 && y > -0.8 && y < 3.8 && z > -17 && z < 14) return null;
  // The gangplank.
  if (mname === "Pier" && x > 4.1 && x < 7.6 && z > 1.0 && z < 4.0 && y > -0.66) return null;
  // The rowboat and the anchored ship that would lie in the fairway once ashore turns about.
  if (mname === "Crate" && Math.hypot(x - 5.4, z + 27) < 3.2 && y < 0.6) return null;
  if (Math.hypot(x + 18, z + 44) < 17.5 && y > -6) return null;
  // The mountain ring where it would stand across the course (after the half turn: within 43° of +Z).
  if (mname === "Mountains") { const fx = -x, fz = -z; if (fz > 0 && Math.abs(Math.atan2(fx, fz)) < 0.75) return null; }
  if (isAboard(x, y, z)) return "aboard";
  return x > 0 ? "port" : "starboard";
}

/**
 * Load the Rexmaw and the harbour and dress them for the night. Resolves
 * once she stands (with a plain procedural deck if the GLB can't be had).
 * @param {object} R  the render context
 * @param {{fx?: object}} [opts]
 * @returns {Promise<Ship>}
 */
export async function createShip(R, { fx = null } = {}) {
  const tweens = createTweens();
  const ship = R.shipSpace || R.scene;
  const aboard = new THREE.Group();
  aboard.name = "rexmaw";
  const ashore = new THREE.Group();
  ashore.name = "harbour";
  ashore.rotation.y = B.ASHORE.rotY;
  ship.add(aboard);
  R.scene.add(ashore);
  let speed = 1;

  // ---- Night-pass shader patches ----
  const shared = { uSbTime: { value: 0 } };
  const lampLevel = { value: 1 };
  const windowsLit = { value: 0.6 };

  function patchLantern(mat, level) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSbTime = shared.uSbTime;
      sh.uniforms.uSbLevel = level;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSbWorld;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvSbWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSbWorld;\nuniform float uSbTime, uSbLevel;")
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          float sbH = fract(sin(dot(floor(vSbWorld * 1.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float sbF = 0.93 + 0.05 * sin(uSbTime * (6.0 + sbH * 5.0) + sbH * 40.0) + 0.03 * sin(uSbTime * (13.0 + sbH * 9.0) + sbH * 7.0);
          totalEmissiveRadiance *= sbF * uSbLevel;`);
    };
    mat.customProgramCacheKey = () => "nh-lantern";
    mat.needsUpdate = true;
  }

  function patchWindows(mat, cells) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSbLit = windowsLit;
      sh.uniforms.uSbCells = { value: cells };
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aSbSeed;\nvarying float vSbSeed;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSbSeed = aSbSeed;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSbSeed;\nuniform float uSbLit, uSbCells;")
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          #ifdef USE_EMISSIVEMAP
            vec2 sbCell = uSbCells > 0.5 ? floor(vEmissiveMapUv * uSbCells) : vec2(0.0);
          #else
            vec2 sbCell = vec2(0.0);
          #endif
          float sbSeed = fract(sin(dot(sbCell + vSbSeed * 113.0, vec2(12.9898, 78.233))) * 43758.5453);
          totalEmissiveRadiance *= 1.0 - smoothstep(uSbLit - 0.035, uSbLit + 0.035, sbSeed);`);
    };
    mat.customProgramCacheKey = () => `nh-windows-${cells}`;
    mat.needsUpdate = true;
  }

  // ---- The set ----
  const mountains = [];
  const beaconLocal = new THREE.Vector3(-24, 17.5, 62);      // the GLB's frame; turned with ashore below
  const casters = [];
  const furled = [];            // Rexmaw Raids: the GLB's furled sails on the yards (hidden while sails.js sets hers)
  let loaded = false;
  try {
    const gltf = await new GLTFLoader().loadAsync(GLB_URL);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const meshes = [];
    scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const aboardMats = new Map();
    const aboardMat = (m) => {
      if (m.name !== "LanternGlow" && m.name !== "WindowGlow") return m;
      if (!aboardMats.has(m)) { const c = m.clone(); c.name = `${m.name}Aboard`; aboardMats.set(m, c); }
      return aboardMats.get(m);
    };
    for (const mesh of meshes) {
      const mat = mesh.material, mname = mat?.name || "";
      if (mesh.name === "sky" || mesh.name === "water" || mname === "Sky" || mname === "Water") {
        mesh.geometry.dispose();
        continue;
      }
      const geo = mesh.geometry;
      if (!mesh.matrixWorld.equals(_identity)) geo.applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (bb.min.x >= CABIN.x0 && bb.max.x <= CABIN.x1 && bb.min.y >= CABIN.y0 && bb.max.y <= CABIN.y1 && bb.min.z >= CABIN.z0 && bb.max.z <= CABIN.z1) {
        geo.dispose();
        continue;
      }
      const parts = splitByPlace(geo, mname);
      const seeds = /^(Facade\d|WindowGlow)$/.test(mname) ? windowSeeds(geo) : null;
      for (const [where, part] of Object.entries(parts)) {
        if (!part) continue;
        if (seeds) part.setAttribute("aSbSeed", seeds);
        const m = new THREE.Mesh(part, where === "aboard" ? aboardMat(mat) : mat);
        m.name = `${mesh.name}-${where}`;
        if (where === "aboard") {
          m.castShadow = /^(Varnish|Rope|BulwarkPaint|Sailcloth|Iron)$/.test(mname);
          m.receiveShadow = /^(Deck|BulwarkPaint|Varnish|CabinBoards|NavyPaint|OchrePaint|Hull|Brass|Gilt|Iron|Crate|Barrel)$/.test(mname);
          if (/^(Ceramic|Parchment|Stencil|BottleAmber|BottleGreen|Cork|Terracotta|Foliage|InstrumentGlow|Crate|Barrel|Void|DoorGlass|CabinBoards|NavyPaint|Brass)$/.test(mname)) m.layers.set(LAYERS.NOREFLECT);
          if (m.castShadow) casters.push(m);
          if (mname === "Sailcloth") furled.push(m);
          aboard.add(m);
        } else {
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          ashore.add(m);
          if (mname === "Mountains") mountains.push(m);
          if (mname === "BeaconGlow") { part.computeBoundingBox(); part.boundingBox.getCenter(beaconLocal); }
        }
      }
    }
    // The material pass, by name.
    const seen = new Set();
    const pass = (m) => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      if ("envMapIntensity" in m) m.envMapIntensity = 0.35;
      const aboardCopy = /Aboard$/.test(m.name);
      switch (m.name.replace(/Aboard$/, "")) {
        case "LanternGlow": m.emissiveIntensity *= 3; patchLantern(m, aboardCopy ? lampLevel : { value: 1 }); break;
        case "WindowGlow": m.emissiveIntensity *= 2.5; if (!aboardCopy) patchWindows(m, 0); break;
        case "BeaconGlow": m.emissiveIntensity *= 4; break;
        case "InstrumentGlow": m.emissiveIntensity *= 1.5; break;
        case "Deck": m.roughness = 0.55; m.envMapIntensity = 0.5; break;
        case "Brass": case "Gilt": m.envMapIntensity = 0.9; break;
        case "Mountains": m.emissive.set("#6f84b8"); m.emissiveIntensity = MOUNTAIN_I; break;
        default:
          if (/^Facade\d$/.test(m.name)) { m.emissiveIntensity *= 2; patchWindows(m, 4); }
      }
    };
    aboard.traverse((o) => o.isMesh && pass(o.material));
    ashore.traverse((o) => o.isMesh && pass(o.material));
    loaded = true;
  } catch (error) {
    console.debug("[night-raid] ship: the Rexmaw GLB didn't load; standing up a plain deck", error);
    fallbackDeck(aboard);
  }
  ashore.updateMatrixWorld(true);
  const beaconPos = beaconLocal.clone().applyMatrix4(ashore.matrixWorld);

  // A shadow pass for the rail lantern's cube that only the avatar casts into.
  const noDistance = new THREE.ShaderMaterial({
    name: "nh-no-lantern-shadow",
    vertexShader: "void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "void main(){ gl_FragColor = vec4(1.0); discard; }",
  });
  for (const m of casters) m.customDistanceMaterial = noDistance;

  // ---- Lights (all present from the start: none is ever added or removed) ----
  const moon = new THREE.DirectionalLight("#9fb4ff", 0.4);
  moon.name = "moon";
  const moonTarget = new THREE.Object3D();
  moonTarget.position.set(0, QD_FLOOR + 0.6, -7.5);
  moon.target = moonTarget;
  Object.assign(moon.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 90 });
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.03;
  const hemi = new THREE.HemisphereLight("#1c2a4a", "#050608", 0.27);
  ship.add(moon, moonTarget, hemi);

  const lamp = (pos, I, dist, name) => {
    const l = new THREE.PointLight("#ffb067", I, dist, 2);
    l.name = name;
    l.position.fromArray(pos);
    ship.add(l);
    return l;
  };
  const taffrail = lamp(TAFFRAIL_LAMP, 3.2, 9, "taffrail-lamp");
  const mastLamp = lamp(MAST_LAMP, 4, 10, "mast-lamp");

  // ---- The rail lantern ----
  const rail = buildRailLantern();
  ship.add(rail.group);

  // ---- The ship's bell ----
  const bell = buildBell();
  ship.add(bell.group);

  // ---- The lighthouse beam ----
  const beam = buildBeam(beaconPos);
  R.scene.add(beam.group);

  // ---- Anchors (Object3Ds, so world positions follow the ship) ----
  const anchor = (pos, parent = ship, name = "") => { const o = new THREE.Object3D(); o.name = name; o.position.fromArray(pos); parent.add(o); return o; };
  const anchors = {
    bell: bell.mouth,
    railLantern: rail.flamePoint,
    companion: anchor(B.COMPANION.pos, ship, "companion-spot"),
    captainEye: anchor(B.CAPTAIN_EYE, ship, "captain-eye"),
    helm: anchor(B.WHEEL.pos, ship, "helm"),
    bow: anchor(B.BOW, ship, "bow"),
    stern: anchor(B.STERN, ship, "stern"),
    masthead: anchor(B.MASTHEAD, ship, "masthead"),
    beacon: anchor(beaconPos.toArray(), R.scene, "beacon"),
  };
  anchors.companion.rotation.y = B.COMPANION.faceYawDeg * DEG;

  // ---- State ----
  const state = { lamps: 1, lampsTarget: 1, lampRate: 2, gutter: null, rail: 1, fog: 0 };
  const roll = { prev: 0, prevVel: 0, fns: new Set() };
  const pivot = new THREE.Vector3().fromArray(B.PIVOT);
  const _qYaw = new THREE.Quaternion(), _qPR = new THREE.Quaternion(), _eul = new THREE.Euler(0, 0, 0, "YXZ"), _p = new THREE.Vector3();
  const _md = new THREE.Vector3(), _qi = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);
  let time = 0;

  let harbourShown = true;
  function applyQuality(q) {
    const moonSize = q?.shadows?.moon || 0, lanternSize = q?.shadows?.lantern || 0;
    moon.castShadow = moonSize > 0;
    if (moonSize && moon.shadow.mapSize.x !== moonSize) { moon.shadow.mapSize.set(moonSize, moonSize); moon.shadow.map?.dispose(); moon.shadow.map = null; }
    rail.light.castShadow = lanternSize > 0;
    if (lanternSize && rail.light.shadow.mapSize.x !== lanternSize) { rail.light.shadow.mapSize.set(lanternSize, lanternSize); rail.light.shadow.map?.dispose(); rail.light.shadow.map = null; }
    beam.group.visible = !!q?.beam && harbourShown;
  }
  applyQuality(R.quality);
  const offQuality = R.onQuality?.(applyQuality) || null;

  /** The moon light follows the painted moon, in WORLD terms: its ship-space direction counter-turns as she turns. */
  const _key = { dir: new THREE.Vector3(), intensity: 0, color: new THREE.Color() };
  let shadowWide = false;
  const HEMI_NIGHT = [new THREE.Color("#1c2a4a"), new THREE.Color("#050608")], HEMI_DAY = [new THREE.Color("#a9c8ec"), new THREE.Color("#3a5a62")];
  function placeMoon() {
    const sk = R.sky;
    const day = R.atmos?.day || 0;
    if (day > 0.001 && sk?.keyLight) { sk.keyLight(_key); _md.copy(_key.dir); }
    else if (sk?.moonDir?.isVector3) _md.copy(sk.moonDir); else _md.set(-0.3, 0.4, 0.85).normalize();
    if (R.shipSpace) _md.applyQuaternion(_qi.copy(R.shipSpace.quaternion).invert());
    const vis = Number.isFinite(sk?.moonLight) ? sk.moonLight : 0.8;
    // Rexmaw Raids: by day the same light is the sun (no new light, no recompile), the sky fill brightens.
    moon.intensity = lerp(lerp(0.22, 0.5, clamp(vis, 0, 1)), 2.7, day);
    if (day > 0.001) moon.color.copy(_key.color); else moon.color.set("#9fb4ff");
    hemi.intensity = lerp(0.27, 1.25, day);
    hemi.color.copy(HEMI_NIGHT[0]).lerp(HEMI_DAY[0], day);
    hemi.groundColor.copy(HEMI_NIGHT[1]).lerp(HEMI_DAY[1], day);
    // By day the shadow covers the whole ship (the sails, the rigging on deck); by night the quarterdeck.
    const wide = day > 0.5;
    if (wide !== shadowWide) {
      shadowWide = wide;
      const e = wide ? 24 : 9;
      Object.assign(moon.shadow.camera, { left: -e, right: e, top: e, bottom: -e, far: wide ? 140 : 90 });
      moon.shadow.camera.updateProjectionMatrix();
      moonTarget.position.set(0, wide ? 4 : QD_FLOOR + 0.6, wide ? 3 : -7.5);
    }
    moon.position.copy(moonTarget.position).addScaledVector(_md, wide ? 70 : 45);
  }

  // ---- Frame ----
  const _cam = new THREE.Vector3(), _bd = new THREE.Vector3();
  const offFrame = R.onFrame?.((dt) => {
    tweens.update(dt);
    time += dt;
    shared.uSbTime.value = time;
    placeMoon();

    state.lamps += (state.lampsTarget - state.lamps) * Math.min(1, dt * state.lampRate);
    let gut = 1;
    if (state.gutter) {
      const g = state.gutter;
      g.t += dt * speed;
      const k = g.t / g.d;
      const env = smooth(0, 0.35, k) * (1 - smooth(0.7, 1.0, k));
      const f = 12 + 8 * (0.5 + 0.5 * noise1(time * 0.8, 9));
      gut = 1 - env * (0.6 + 0.3 * Math.sin(time * f * 2 * Math.PI) * (0.5 + 0.5 * noise1(time * 6, 4)));
      if (k >= 1) { state.gutter = null; g.resolve(); }
    }
    const flick = 1 + 0.06 * noise1(time * 7, 1) + 0.03 * noise1(time * 17, 2);
    const level = state.lamps * gut * (1 - 0.85 * (R.atmos?.day || 0));
    lampLevel.value = level;
    const railK = state.rail * level * flick;
    rail.light.intensity = 6 * railK;
    rail.glass.emissiveIntensity = 2.4 * railK;
    rail.flameU.uI.value = 7 * railK;
    rail.flameU.uTime.value = time;
    rail.haloU.uI.value = 0.55 * railK * (1 + 0.4 * state.fog);
    rail.halo.scale.setScalar(1 + 0.35 * state.fog);
    taffrail.intensity = 3.2 * level * (1 + 0.05 * noise1(time * 6, 3));
    mastLamp.intensity = 4 * level * (1 + 0.05 * noise1(time * 5, 5));

    bell.step(dt * speed);

    // The lighthouse: sweep, and flare when a beam looks our way.
    if (beam.group.visible) {
      beam.angle += dt * (2 * Math.PI / 14);
      beam.spin.rotation.y = beam.angle;
      R.camera.getWorldPosition(_cam).sub(beam.group.position);
      const far = _cam.length();
      _cam.normalize();
      // The beam shader takes no scene fog (it's additive light in the air): dim it by the fog
      // between us and the lamp, gently, so the sweep still shows a little way into the murk.
      const fd = (R.scene.fog?.density || 0) * far * 0.5;
      beam.u.uI.value = 0.16 * beam.night * Math.exp(-fd * fd);
      beam.u.uTime.value = time;
      let face = 0;
      for (const s of [1, -1]) {
        _bd.set(Math.cos(beam.angle) * s, -Math.sin(1.2 * DEG), -Math.sin(beam.angle) * s).normalize();
        face = Math.max(face, _bd.dot(_cam));
      }
      // Out at sea the lamp is a point on the horizon: its flare fades with the fog between.
      beam.flareU.uI.value = beam.night * (0.6 + 7 * Math.pow(Math.max(face, 0), 40)) * Math.exp(-fd * fd * 0.5);
    }
  }) || null;

  /** @type {Ship} */
  const api = {
    root: aboard,
    harbour: ashore,
    anchors,
    /** The GLB's furled sails (meshes aboard): sails.js shows them furled and hides them under set canvas. */
    furled,
    /** True when the GLB loaded (false: the plain fallback deck). */
    loaded,
    /** The lighthouse lamp, world space. */
    beacon: beaconPos.clone(),

    /**
     * Put the ship where the sim says: (x, z) on the water, heading (degrees,
     * 0 = +Z, increasing to starboard), heel (radians, starboard rail down
     * positive), pitch (radians, bow up positive), heave (m, the waterline's
     * rise). The ship pitches and heels about B.PIVOT.
     */
    pose(x, z, heading, heel = 0, pitch = 0, heave = 0) {
      const ss = R.shipSpace;
      if (!ss) return;
      _qYaw.setFromAxisAngle(_Y, -heading * DEG);
      _qPR.setFromEuler(_eul.set(-pitch, 0, heel, "YXZ"));
      ss.quaternion.copy(_qYaw).multiply(_qPR);
      // Rotate about the pivot: pos = T + qYaw·P − q·P
      ss.position.set(x, heave, z).add(_p.copy(pivot).applyQuaternion(_qYaw)).sub(_p.copy(pivot).applyQuaternion(ss.quaternion));
      ss.updateMatrixWorld(true);
      // Creaks where the roll turns back.
      const vel = heel - roll.prev;
      if (Math.abs(vel) > 1e-6) {
        if (roll.prevVel !== 0 && Math.sign(vel) !== Math.sign(roll.prevVel)) {
          for (const fn of roll.fns) { try { fn({ side: Math.sign(vel) }); } catch (error) { console.debug("[night-raid] onRollTurn listener threw", error); } }
        }
        roll.prevVel = vel;
      }
      roll.prev = heel;
    },

    /** Every lantern aboard to `intensity` (1 = as lit) over `seconds`. */
    lanterns(intensity, seconds = 0.8) {
      state.lampsTarget = Math.max(0, +intensity || 0);
      state.lampRate = 3 / Math.max(0.05, seconds);
    },

    /** The lanterns aboard gutter for `seconds` (a hard hit, the Kraken's breath). */
    gutter(seconds = 2) {
      if (state.gutter) state.gutter.resolve();
      return new Promise((resolve) => { state.gutter = { t: 0, d: Math.max(0.2, seconds), resolve }; });
    },

    /** Ring `strikes` bells in pairs; `onStrike(i)` fires on each contact (play the sfx there). */
    ringBell(strikes, { onStrike = null } = {}) {
      return bell.ring(clamp(Math.round(+strikes || 1), 1, 8), onStrike);
    },

    /** The roll changes direction: the ambience creaks the hull. */
    onRollTurn(fn) { roll.fns.add(fn); return () => roll.fns.delete(fn); },

    /** Fog 0..1: the rail lantern's halo swells in it. */
    setFog(amount) {
      const target = clamp(+amount || 0, 0, 1) * 3;
      const from = state.fog;
      tweens.tween(1.5, (e) => { state.fog = lerp(from, target, e); });
    },

    /** The town's windows: the fraction still lit (0..1; they go dark as the night wears on). */
    setWindows(v) { windowsLit.value = clamp(+v, 0, 1); },

    /** Night Raid: put the harbour's mooring at world (x, z) (the home port). */
    placeHarbour(x, z) {
      ashore.position.set(+x || 0, 0, +z || 0);
      ashore.updateMatrix();
      ashore.updateMatrixWorld(true);
      beaconPos.copy(beaconLocal).applyMatrix4(ashore.matrixWorld);
      beam.group.position.copy(beaconPos);
      anchors.beacon.position.copy(beaconPos);
      api.beacon.copy(beaconPos);
    },

    /** Show or hide the harbour ashore and its lighthouse beam (world.js hides them once she's well out to sea). */
    showHarbour(on) {
      if (harbourShown === !!on) return;
      harbourShown = !!on;
      ashore.visible = harbourShown;
      beam.group.visible = harbourShown && !!R.quality?.beam;
    },

    setSpeed(s) { tweens.setSpeed(s); speed = s > 0 ? s : 1; },
    flush() {
      tweens.flush();
      bell.flush();
      if (state.gutter) { state.gutter.resolve(); state.gutter = null; }
      state.lamps = state.lampsTarget;
    },

    /** Take the ship and the harbour down and free the GPU resources. */
    dispose() {
      tweens.cancel();
      offFrame?.(); offQuality?.();
      if (R.shipSpace) { R.shipSpace.position.set(0, 0, 0); R.shipSpace.quaternion.identity(); }
      const geos = new Set(), mats = new Set();
      for (const g of [aboard, ashore, rail.group, bell.group, beam.group]) {
        g.traverse((o) => {
          if (o.geometry) geos.add(o.geometry);
          for (const m of [].concat(o.material || [])) mats.add(m);
        });
        g.removeFromParent();
      }
      for (const o of [moon, moonTarget, hemi, taffrail, mastLamp, ...Object.values(anchors)]) o.removeFromParent();
      moon.shadow.map?.dispose();
      rail.light.shadow.map?.dispose();
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => { for (const k of ["map", "normalMap", "emissiveMap", "roughnessMap", "metalnessMap"]) m[k]?.dispose?.(); m.dispose(); });
      noDistance.dispose();
    },
  };

  beam.night = 1;
  api.pose(0, 0, 0);
  return api;

  // ---- Builders (hoisted) ----

  function buildRailLantern() {
    const group = new THREE.Group();
    group.name = "rail-lantern";
    group.position.fromArray(B.RAIL_LANTERN);
    const brass = new THREE.MeshStandardMaterial({ name: "nh-lantern-brass", color: "#c99a4a", metalness: 1, roughness: 0.32, envMapIntensity: 1.0 });
    const darkBrass = new THREE.MeshStandardMaterial({ name: "nh-lantern-patina", color: "#6b5228", metalness: 1, roughness: 0.5, envMapIntensity: 0.6 });
    // Glass rough enough that the flame's PointLight 5 cm away can't throw a half-float-overflowing highlight.
    const glass = new THREE.MeshStandardMaterial({
      name: "nh-lantern-glass", color: "#ffd9a0", emissive: "#ffb067", emissiveIntensity: 2.4, roughness: 0.3, metalness: 0,
      transparent: true, opacity: 0.78, depthWrite: false,
    });
    const lathe = (pts, mat, segs = 28) => new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs), mat);
    const foot = lathe([[0.0, 0], [0.068, 0], [0.071, 0.008], [0.064, 0.02], [0.048, 0.03], [0.044, 0.037], [0.0, 0.037]], brass);
    const chimney = lathe([[0.034, 0.037], [0.046, 0.06], [0.052, 0.1], [0.048, 0.14], [0.037, 0.168], [0.031, 0.18]], glass, 32);
    chimney.renderOrder = 6;
    const cap = lathe([[0.062, 0.178], [0.061, 0.19], [0.042, 0.214], [0.022, 0.236], [0.013, 0.25], [0.0, 0.256]], brass);
    const vent = lathe([[0.016, 0.236], [0.021, 0.244], [0.02, 0.254], [0.0, 0.258]], darkBrass, 12);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0035, 8, 28), brass);
    handle.position.y = 0.28;
    group.add(foot, chimney, cap, vent, handle);
    for (let i = 0; i < 4; i++) {
      const a = (i + 0.5) * Math.PI / 2;
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.145, 6), brass);
      wire.position.set(Math.cos(a) * 0.057, 0.108, Math.sin(a) * 0.057);
      group.add(wire);
    }
    for (const y of [0.068, 0.15]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.057, 0.0028, 6, 32), brass);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      group.add(ring);
    }
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.05), darkBrass);
    bracket.position.set(0, -0.004, 0);
    group.add(bracket);
    for (const o of group.children) { o.castShadow = false; o.receiveShadow = false; }

    const flameU = { uI: { value: 7 }, uTime: { value: 0 }, uSize: { value: 0.05 } };
    const flame = billboard(flameU, /* glsl */`
      uniform float uI, uTime;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float sway = sin(uTime * 9.0) * 0.05 + sin(uTime * 23.0) * 0.025;
        p.x -= sway * (p.y + 1.0) * 0.5;
        float w = 0.42 * (1.0 - p.y) * sqrt(max(0.0, (p.y + 1.0) * 0.5));
        float d = abs(p.x) / max(w, 1e-3);
        float body = smoothstep(1.0, 0.55, d) * smoothstep(1.0, 0.7, p.y) * smoothstep(-1.0, -0.78, p.y);
        float core = smoothstep(0.6, 0.0, d) * smoothstep(0.2, -0.5, p.y) * smoothstep(-1.0, -0.7, p.y);
        vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.7), core) * (body + core * 0.8);
        gl_FragColor = vec4(col * uI, 1.0);
      }`, 1.6);
    flame.scale.set(1, 1.25, 1);
    flame.position.y = 0.1;
    flame.renderOrder = 7;
    const haloU = { uI: { value: 0.55 }, uSize: { value: 0.95 }, uPull: { value: 0.5 }, uColor: { value: new THREE.Color("#ffb067") } };
    const halo = billboard(haloU, /* glsl */`
      uniform float uI;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        float v = exp(-r * r * 7.0) * 0.8 + exp(-r * 3.2) * 0.25;
        gl_FragColor = vec4(uColor * v * uI * smoothstep(1.0, 0.75, r), 1.0);
      }`);
    halo.position.y = 0.11;
    halo.renderOrder = 8;
    halo.layers.set(LAYERS.FX);
    const light = new THREE.PointLight("#ffb067", 6, 10, 2);
    light.position.y = 0.11;
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.near = 0.12;
    light.shadow.bias = -0.002;
    const flamePoint = new THREE.Object3D();
    flamePoint.position.y = 0.11;
    for (const b of [flame, halo]) b.userData.keep = true;
    group.add(flame, halo, light, flamePoint);
    mergeStatic(group);
    return { group, glass, flameU, haloU, halo, light, flamePoint };
  }

  function buildBell() {
    const group = new THREE.Group();
    group.name = "ships-bell";
    group.position.fromArray(B.BELL);
    const brass = new THREE.MeshStandardMaterial({ name: "nh-bell-brass", color: "#cfa451", metalness: 1, roughness: 0.24, envMapIntensity: 1.4, emissive: "#ffcf8a", emissiveIntensity: 0 });
    const wood = new THREE.MeshStandardMaterial({ name: "nh-belfry-wood", color: "#4b2f1c", roughness: 0.48, metalness: 0, envMapIntensity: 0.4 });
    const rope = new THREE.MeshStandardMaterial({ name: "nh-bell-rope", color: "#a88a5c", roughness: 0.95, metalness: 0, map: ropeTexture() });

    const top = 0.36, floor = QD_FLOOR - B.BELL[1];
    const postH = top - floor;
    for (const x of [-0.31, 0.31]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.075, postH, 0.075), wood);
      post.position.set(x, floor + postH / 2, 0);
      const fin = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), brass);
      fin.position.set(x, top + 0.075, 0);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.13), wood);
      foot.position.set(x, floor + 0.025, 0);
      group.add(post, fin, foot);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.09, 0.095), wood);
    bar.position.y = top;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.1), brass);
    strap.position.y = top;
    group.add(bar, strap);

    const hinge = new THREE.Group();
    hinge.position.y = top - 0.05;
    group.add(hinge);
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 8, 20), brass);
    shackle.position.y = -0.015;
    hinge.add(shackle);
    const mouthY = -0.34;
    const outer = [[0.150, 0.000], [0.157, 0.006], [0.153, 0.017], [0.137, 0.046], [0.123, 0.086], [0.114, 0.13], [0.109, 0.175], [0.103, 0.214], [0.089, 0.244], [0.063, 0.261], [0.031, 0.27], [0.0, 0.272]];
    const inner = [[0.0, 0.252], [0.052, 0.247], [0.086, 0.226], [0.099, 0.19], [0.105, 0.14], [0.113, 0.09], [0.127, 0.046], [0.141, 0.013], [0.147, 0.004]];
    const body = new THREE.Mesh(new THREE.LatheGeometry([...outer, ...inner].map(([r, y]) => new THREE.Vector2(r, y + mouthY)), 56), brass);
    body.castShadow = true;
    const crown = new THREE.Mesh(new THREE.LatheGeometry([[0.035, 0], [0.03, 0.02], [0.018, 0.035], [0.0, 0.04]].map(([r, y]) => new THREE.Vector2(r, y + mouthY + 0.27)), 20), brass);
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.006, 8, 20), brass);
    loop.position.y = mouthY + 0.318;
    hinge.add(body, crown, loop);
    for (const [y, r] of [[0.028, 0.14], [0.2, 0.106]]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0035, 8, 56), brass);
      band.rotation.x = Math.PI / 2;
      band.position.y = mouthY + y;
      hinge.add(band);
    }
    const clapper = new THREE.Group();
    clapper.position.y = mouthY + 0.24;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.2, 8), brass);
    rod.position.y = -0.1;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), brass);
    ball.position.y = -0.205;
    clapper.add(rod, ball);
    hinge.add(clapper);
    const lanyard = new THREE.Group();
    lanyard.position.y = -0.235;
    clapper.add(lanyard);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.009, 0.42, 10), rope);
    cord.position.y = -0.21;
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.016, 0.0065, 48, 8, 2, 3), rope);
    knot.position.y = -0.43;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.07, 10, 1, true), rope);
    tail.position.y = -0.48;
    tail.rotation.x = Math.PI;
    lanyard.add(cord, knot, tail);
    const mouth = new THREE.Object3D();
    mouth.position.y = mouthY + 0.12;
    hinge.add(mouth);
    for (const g of [hinge, clapper, lanyard]) g.userData.dynamic = true;
    for (const g of [group, hinge, clapper, lanyard]) mergeStatic(g);
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.customDistanceMaterial = noDistance; } });

    const HIT = 19 * DEG;
    const PULL = 0.12;
    const s = { c: 0, cv: 0, b: 0, bv: 0, l: 0, lv: 0, glint: 0, seq: null };
    const spring = (x, v, k, c, dt, drive = 0) => {
      const a = -k * x - c * v + drive;
      v += a * dt;
      return [x + v * dt, v];
    };
    function impact(i, onStrike) {
      s.c = HIT * Math.sign(s.c || 1);
      s.cv = -s.cv * 0.3 - 2.2 * Math.sign(s.c);
      s.bv += 0.55 * Math.sign(s.c);
      s.lv += 1.5;
      s.glint = 1;
      try { onStrike?.(i); } catch (error) { console.debug("[night-raid] onStrike threw", error); }
    }
    function step(dt) {
      if (dt <= 0) return;
      const d = Math.min(dt, 1 / 30);
      const q = s.seq;
      let driven = false;
      if (q) {
        q.t += d;
        const next = q.times[q.next];
        if (next != null && q.t >= next - PULL) {
          if (q.pullFrom == null) q.pullFrom = s.c;
          const k = clamp((q.t - (next - PULL)) / PULL, 0, 1);
          s.c = lerp(q.pullFrom, HIT, k * k);
          s.cv = 0;
          driven = true;
          if (q.t >= next) { impact(q.next, q.onStrike); q.next++; q.pullFrom = null; driven = false; }
        }
        if (q.t >= q.end) { s.seq = null; q.resolve(); }
      }
      if (!driven) [s.c, s.cv] = spring(s.c, s.cv, 75, 2.4, d);
      [s.b, s.bv] = spring(s.b, s.bv, 260, 5.5, d);
      [s.l, s.lv] = spring(s.l, s.lv, 28, 3.2, d, -s.cv * 2.2);
      s.glint *= Math.exp(-d * 5.5);
      hinge.rotation.x = s.b;
      clapper.rotation.x = s.c - s.b * 0.2;
      lanyard.rotation.x = -s.c * 0.85 + s.l * 0.12;
      brass.emissiveIntensity = s.glint * s.glint * 0.3;
    }
    function ring(n, onStrike) {
      if (s.seq) { s.seq.resolve(); s.seq = null; }
      const times = Array.from({ length: n }, (_, k) => PULL + Math.floor(k / 2) * 1.65 + (k % 2) * 0.55);
      return new Promise((resolve) => { s.seq = { t: 0, times, next: 0, onStrike, resolve, end: times[n - 1] + 0.9, pullFrom: null }; });
    }
    function flush() { if (s.seq) { s.seq.resolve(); s.seq = null; } }
    return { group, mouth, step, ring, flush };
  }

  function buildBeam(at) {
    const group = new THREE.Group();
    group.name = "lighthouse-beam";
    group.position.copy(at);
    const spin = new THREE.Group();
    group.add(spin);
    const LEN = 115;
    const geo = new THREE.CylinderGeometry(0.4, 3.4, LEN, 32, 1, true);
    geo.translate(0, -LEN / 2, 0);
    geo.rotateZ(Math.PI / 2);                  // apex at the lamp, out along +x
    geo.rotateZ(-1.2 * DEG);                   // a touch down, skimming over the water
    const u = { uI: { value: 0.16 }, uTime: { value: 0 }, uColor: { value: new THREE.Color("#ffe2a8") }, uLen: { value: LEN } };
    const ax = `vec3(${Math.cos(-1.2 * DEG).toFixed(6)}, ${Math.sin(-1.2 * DEG).toFixed(6)}, 0.0)`;
    const mat = new THREE.ShaderMaterial({
      name: "nh-lighthouse-beam", uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, fog: false,
      vertexShader: /* glsl */`
        uniform float uLen;
        varying float vAlong;
        varying vec3 vW, vO, vD;
        void main() {
          vAlong = clamp(position.x / uLen, 0.0, 1.0);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vO = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vD = normalize(mat3(modelMatrix) * ${ax});
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uI, uTime, uLen;
        uniform vec3 uColor;
        varying float vAlong;
        varying vec3 vW, vO, vD;
        float hash3(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }
        float vnoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        void main() {
          // THE BLACK BOX (Starboard): vAlong is clamped per vertex, but on the MSAA tiers a
          // varying is evaluated at the pixel centre even where only some samples are covered,
          // so on the cone's far rim it is EXTRAPOLATED a hair past 1.0. pow() of the tiny
          // negative 1 - vAlong is NaN (2.2 is not an integer), additive blending writes the NaN
          // into the HDR target, and the bloom's blur grows it into a black square that sweeps
          // with the beam, right to left across the harbour. Clamp here, and max() the base.
          float al = clamp(vAlong, 0.0, 1.0);
          vec3 r = normalize(vW - cameraPosition);
          vec3 w0 = cameraPosition - vO;
          float b = dot(r, vD), d = dot(r, w0), e = dot(vD, w0);
          float den = max(1.0 - b * b, 1e-4);
          float sc = (b * e - d) / den, tc = (e - b * d) / den;
          float dist = length(w0 + r * sc - vD * tc);
          float rad = mix(0.4, 3.4, clamp(tc / uLen, 0.0, 1.0));
          float q = dist / rad;
          float edge = exp(-q * q * 4.0);
          float fall = pow(max(1.0 - al, 0.0), 2.2) * smoothstep(0.0, 0.02, al);
          float near = smoothstep(18.0, 45.0, length(cameraPosition - vW));
          float dust = 0.65 + 0.35 * vnoise(vec3(al * 40.0, min(dist, 50.0), uTime * 0.15));
          gl_FragColor = vec4(uColor * edge * fall * near * dust * uI, 1.0);
        }`,
    });
    for (const yaw of [0, Math.PI]) {
      const m = new THREE.Mesh(geo, mat);
      m.rotation.y = yaw;
      m.frustumCulled = false;
      m.layers.set(LAYERS.FX);
      spin.add(m);
    }
    const flareU = { uI: { value: 0 }, uSize: { value: 7 }, uColor: { value: new THREE.Color("#fff3d6") } };
    const flare = billboard(flareU, /* glsl */`
      uniform float uI;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float v = exp(-r * r * 18.0) + 0.25 * exp(-r * 4.0) + 0.35 * exp(-abs(p.y) * 60.0) * exp(-abs(p.x) * 2.5);
        gl_FragColor = vec4(uColor * v * uI * smoothstep(1.0, 0.8, r), 1.0);
      }`);
    flare.layers.set(LAYERS.FX);
    flare.renderOrder = 7;
    group.add(flare);
    return { group, spin, u, flareU, angle: 0, night: 1 };
  }
}

// ---- Helpers --------------------------------------------------------------------

const _identity = new THREE.Matrix4();

/** A camera-facing quad (uSize world units across, ×aspect wide), with its own shader. */
export function billboard(u, frag, aspect = 1, additive = true) {
  u.uSize = u.uSize || { value: 1 };
  u.uAspect = { value: aspect };
  u.uPull = u.uPull || { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, premultipliedAlpha: !additive,
    vertexShader: /* glsl */`
      uniform float uSize, uAspect, uPull;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float len = length(mv.xyz);
        if (len > 1e-4) mv.xyz += (-mv.xyz / len) * min(uPull, len * 0.5);
        vec3 s = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0);
        mv.xy += position.xy * vec2(uSize / uAspect, uSize) * s.xy;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: frag,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  return m;
}

/**
 * Split a merged harbour mesh by triangle: aboard the Rexmaw, ashore to
 * port, ashore to starboard (placeOf drops what Night Helm doesn't want).
 * Parts share the source's vertex attributes and carry their own index and bounds.
 * @param {THREE.BufferGeometry} geo
 * @param {string} mname  the material's name
 */
function splitByPlace(geo, mname) {
  const pos = geo.attributes.position.array;
  const index = geo.index ? geo.index.array : null;
  const triCount = index ? index.length / 3 : pos.length / 9;
  const at = (k) => (index ? index[k] : k);
  const buckets = { aboard: [], port: [], starboard: [] };
  for (let t = 0; t < triCount; t++) {
    const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
    const where = placeOf(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2], pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2], mname);
    if (where) buckets[where].push(a, b, c);
  }
  for (const k of Object.keys(buckets)) {
    const n = buckets[k].length / 3;
    if (!n || n >= 24 || k === "aboard") continue;
    const into = ["port", "starboard"].filter((o) => o !== k && buckets[o].length / 3 >= 24).sort((x, y) => buckets[y].length - buckets[x].length)[0];
    if (into) { buckets[into].push(...buckets[k]); buckets[k] = []; }
  }
  const out = {};
  const Arr = index && index instanceof Uint32Array ? Uint32Array : (pos.length / 3 > 65535 ? Uint32Array : Uint16Array);
  for (const [k, list] of Object.entries(buckets)) {
    if (!list.length) { out[k] = null; continue; }
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(Arr.from(list), 1));
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) box.expandByPoint(v.fromArray(pos, list[i] * 3));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    out[k] = g;
  }
  return out;
}

/** A seed per connected piece (a wall, a window pane): union-find over shared vertices. */
function windowSeeds(geo) {
  const n = geo.attributes.position.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const idx = geo.index ? geo.index.array : null;
  const tris = idx ? idx.length / 3 : n / 3;
  for (let t = 0; t < tris; t++) {
    const a = find(idx ? idx[t * 3] : t * 3), b = find(idx ? idx[t * 3 + 1] : t * 3 + 1), c = find(idx ? idx[t * 3 + 2] : t * 3 + 2);
    parent[b] = a; parent[c] = a;
  }
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = find(i); const s = Math.sin(r * 12.9898 + 4.1) * 43758.5453; seeds[i] = s - Math.floor(s); }
  return new THREE.BufferAttribute(seeds, 1);
}

/** Twisted-rope stripes for the bell's lanyard. */
function ropeTexture() {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#b39466"; g.fillRect(0, 0, 64, 128);
  g.strokeStyle = "rgba(60, 40, 20, .55)"; g.lineWidth = 5;
  for (let i = -128; i < 192; i += 16) { g.beginPath(); g.moveTo(0, i); g.lineTo(64, i + 40); g.stroke(); }
  g.strokeStyle = "rgba(255, 240, 210, .18)"; g.lineWidth = 2;
  for (let i = -128; i < 192; i += 16) { g.beginPath(); g.moveTo(0, i + 6); g.lineTo(64, i + 46); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 3);
  return t;
}

/** When the GLB can't be had: a plain hull and quarterdeck, so the voyage still plays. */
function fallbackDeck(group) {
  const wood = new THREE.MeshStandardMaterial({ name: "nh-fallback-deck", color: "#4a3322", roughness: 0.7 });
  const paint = new THREE.MeshStandardMaterial({ name: "nh-fallback-bulwark", color: "#2c1e14", roughness: 0.8 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.receiveShadow = true; m.castShadow = true; group.add(m); };
  add(new THREE.BoxGeometry(8.4, 0.3, 8.6), wood, 0, QD_FLOOR - 0.15, -8.5);
  add(new THREE.BoxGeometry(8.4, 4.6, 33), paint, 0, -0.2, 3.5);
  for (const x of [-4.05, 4.05]) add(new THREE.BoxGeometry(0.22, 1.2, 8.6), paint, x, QD_FLOOR + 0.6, -8.5);
  add(new THREE.CylinderGeometry(0.22, 0.26, 16, 16), wood, 0, QD_FLOOR + 8, -9.8);
  add(new THREE.CylinderGeometry(0.3, 0.34, 24, 16), wood, 0, 12, 8);
}

/**
 * @typedef {object} Ship
 * @property {THREE.Group} root       the Rexmaw (rides R.shipSpace)
 * @property {THREE.Group} harbour    ashore (world space, turned by B.ASHORE)
 * @property {object} anchors          bell, railLantern, companion, captainEye, helm, bow, stern, masthead, beacon
 * @property {(x: number, z: number, heading: number, heel?: number, pitch?: number, heave?: number) => void} pose
 */
