// Night Raid: the 3D world in one factory (the integrator's entry point).
//
//   const R = createRenderer(ctx);                        // renderer.js
//   const world = await createWorld(R, { world: run.world() });   // core/world.js's bay
//   R.start(); await world.compile();                     // compile behind the title
//   // every frame, with the sim's state and the interpolated pose:
//   world.update(run.state(), dt, run.pose());
//   // on run events:
//   run.on(name, (p) => world.event(name, p))             // volley, impact, sink, hazard, ...
//   world.pick(clientX, clientY)  → {kind: "weak"|"contact"|"crew", id, contactId?} | null
//   world.shipTagAnchors()        → [{contactId, x, y, visible, dist, locked, sinking}] (v4 floating ship tags)
//   world.shots.toggle()          // C; world.shots.spyglass(true, {contactId}) for E
//
// It builds the sky, the sea, the Rexmaw (Night Helm's GLB, its deck guns,
// pump, powder, galley, bow chaser and swivel) and the home port, the bay's
// islands, shoals, fort, wrecks and cove, the enemy fleet, the shot in
// flight, the fires, the maelstrom, the storm (rain, lightning, the rogue
// wave, waterspouts, mortar rings), the Kraken and the effects, and drives
// them from the sim. The camera: a third-person chase that swings to keep the
// current target in frame (default), the helm view (C), the spyglass (E), and
// short cinematic beats (a big broadside, a ship going down, the rogue wave,
// boarding, the Kraken) when cinematics are on.
// See the "## scene API" section of the interfaces doc.

import * as THREE from "three";
import { B, WATER_Y, headingVec, SHOTS, dir, harbourObstacles } from "./blocking.js";
import { createSky } from "./sky.js";
import { createWater } from "./water.js";
import { createFx } from "./fx.js";
import { createShip } from "./ship.js";
import { createHelm } from "./helm.js";
import { createWake } from "./wake.js";
import { createKraken } from "./kraken.js";
import { createFlames } from "./flames.js";
import { createFleet } from "./fleet.js";
import { createShots } from "./shots.js";
import { createIslands } from "./islands.js";
import { createMaelstrom } from "./maelstrom.js";
import { createWeather } from "./weather.js";
import { createDeckProps } from "./deckprops.js";
import { STATIONS, WALK, walkPath, nearestNode, deckHeight } from "./stations.js";
import { createFollow, FOLLOW } from "./follow.js";
import { createLife } from "./life.js";
import { createSails } from "./sails.js";
import { createOverlays } from "./overlays.js";
import { createPickups } from "./pickups.js";
import { createSetPieces } from "./setpieces.js";
import { createSpeedLines } from "./juice.js";
import { createMarkers } from "./markers.js";
import { createTarget } from "./target.js";
import { createSeaEvents } from "./seaevents.js";

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const CLEAR_VIS = 900;                        // m: a clear night in the bay (the core's state.visibility wins)
const DAY_VIS = 1700;                         // m: a clear day's haze
/** Where fires burn aboard the Rexmaw (ship space), in the order they catch. */
const REX_FIRE_SPOTS = [[1.6, 0.2, 2.0], [-1.9, 0.2, 6.6], [0.9, 0.2, 10.4], [-1.3, 2.8, -8.2], [2.2, 0.2, -1.6], [-0.6, 1.8, 16.2], [-2.4, 0.2, 11.6], [1.4, 2.8, -10.4]];
const HOSTILE_STATES = new Set(["approach", "broadside", "ram"]);
/** The sprint: state.ship.sprint is {on, wind} (core v2); a bare true / `sprinting` also counts. */
const sprintOf = (sh) => !!(sh && (sh.sprint === true || sh.sprint?.on === true || sh.sprinting === true));

/**
 * Build the world. Resolves once the GLB is in (everything else is procedural).
 * @param {object} R  the render context from createRenderer
 * @param {{world?: object, quality?: string, cinematics?: boolean, autoCamera?: boolean}} [opts]
 */
export async function createWorld(R, { world: bay = null, quality = null, cinematics = true, autoCamera = true, wheelZoom = true } = {}) {
  if (quality) R.setQuality(quality);
  R.atmos.haze = R.atmos.haze || new THREE.Color("#8a96a8");
  R.atmos.hazeK = 0;
  const sky = createSky(R);
  const water = createWater(R);
  const fx = createFx(R);
  const ship = await createShip(R, { fx });
  const helm = createHelm(R, { fx });
  const wake = createWake(R);
  const kraken = createKraken(R, { fx, water });
  const flames = createFlames(R, { fx, water });
  const fleet = createFleet(R, { water, fx, flames });
  const shotsInFlight = createShots(R, { fx });
  const islands = createIslands(R, { water, fx, flames });
  const maelstrom = createMaelstrom(R, { water, fx });
  const weather = createWeather(R, { water, fx });
  const props = createDeckProps(R, { fx });
  const life = createLife(R, { water });
  const sails = createSails(R, { ship });
  const overlays = createOverlays(R, { water, fleet, fx });
  const pickups = createPickups(R, { water, fx, flames });
  const setpieces = createSetPieces(R, { water, fleet, fx });
  const speedLines = createSpeedLines(R);
  const markers = createMarkers(R, { water, fleet, posOf: (id, out) => posOf(id, out) });
  const target = createTarget(R, { fleet });          // v4: generous picking, the lock bracket, the hover outline, tag anchors
  const seaEvents = createSeaEvents(R, { water, fx }); // v4: state.events (spouts, squalls, rogue sets, derelicts, …)
  overlays.setGround((x, z) => islands.heightAt(x, z));

  sky.setNight(0.05, { duration: 0 });
  water.setNight(0.05, { duration: 0 });
  R.setVisibility(CLEAR_VIS);

  // ---- State kept between frames ----
  const S = {
    bay: null, state: null, phase: null, heading: 0, turnRate: 0, speed: 0, accel: 0,
    heel: 0, pitch: 0, heave: 0, lurch: { heel: 0, pitch: 0, v: 0, vp: 0 },
    hull: null, hullMax: 100, cargo: null, lastHitSide: 0, wreck: 0, wrecked: false, idleT: 0,
    look: null, lookT: 0, wind: { dirDeg: 0, strength: 0.7 },
    cinematics, autoCamera, cine: null, spy: null, chase: { az: 0, azT: 0, user: 0, dist: 0, extra: 0, target: null },
    timers: [], rexFires: [], krakenSeen: false, waveCut: null, lastX: null, lastZ: null, clock: 0,
    crewPicker: null, boardEnemy: null, day: null, dayLock: null,
  };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _sw = { h: 0, dx: 0, dz: 0 }, _sl = { dx: 0, dz: 0 };
  const cam = R.cam;

  /** Run `fn` after `seconds` of animation time (paused with the world, unlike setTimeout). */
  const after = (seconds, fn) => S.timers.push({ at: R.time + seconds, fn });
  const toWorld = (x, y, z, out = new THREE.Vector3()) => { R.shipSpace.updateMatrixWorld(); return R.shipSpace.localToWorld(out.set(x, y, z)); };
  const toLocal = (p, out = new THREE.Vector3()) => { R.shipSpace.updateMatrixWorld(); return R.shipSpace.worldToLocal(out.copy(p)); };

  /**
   * The sea point under a screen point (client px) as the chase camera would see it with the ship sitting level:
   * her position and heading, without the heave, pitch and roll. The camera rides R.shipSpace, so a plain ray
   * through it swings with every wave (at ~500 m a 1° pitch moves the point tens of metres); this one holds still
   * under a still cursor. Above the horizon: far out along the cursor's bearing (the core clamps to the range).
   */
  const _lvM = new THREE.Matrix4(), _lvQ = new THREE.Quaternion(), _lvE = new THREE.Euler(), _lvO = new THREE.Vector3(), _lvD = new THREE.Vector3();
  const _lvOne = new THREE.Vector3(1, 1, 1), _lvY = new THREE.Vector3(0, 1, 0);
  function levelSeaPoint(clientX, clientY) {
    const el = R.renderer.domElement, rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || S.lastX == null) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1, ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    _lvE.setFromQuaternion(R.shipSpace.quaternion, "YXZ");
    _lvQ.setFromAxisAngle(_lvY, _lvE.y);
    R.camera.updateMatrix();
    _lvM.compose(_lvO.set(S.lastX, 0, S.lastZ), _lvQ, _lvOne).multiply(R.camera.matrix);
    _lvO.setFromMatrixPosition(_lvM);
    _lvD.set(nx, ny, 0.5).applyMatrix4(R.camera.projectionMatrixInverse).applyMatrix4(_lvM).sub(_lvO).normalize();
    if (_lvD.y > -0.002) { _lvD.y = 0; _lvD.normalize(); return { x: _lvO.x + _lvD.x * 2000, z: _lvO.z + _lvD.z * 2000 }; }
    const t = (WATER_Y - _lvO.y) / _lvD.y;
    return { x: _lvO.x + _lvD.x * t, z: _lvO.z + _lvD.z * t };
  }

  /** The surface's extra height at (x, z): down into the maelstrom's bowl, up a rogue wave. */
  const surfaceDrop = (x, z) => -maelstrom.depthAt(x, z) + weather.waveHeightAt(x, z);

  // ---- The Rexmaw's pose ----
  function pose(sh, dt) {
    const x = +sh.x || 0, z = +sh.z || 0, hd = +sh.heading || 0, sp = Math.max(0, +sh.speed || 0);
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.5) : 1;
    if (dt > 0) {
      const rate = wrap180(hd - S.heading) / dt;
      if (Math.abs(rate) < 120) S.turnRate += (rate - S.turnRate) * k;
      const acc = (sp - S.speed) / dt;
      if (Math.abs(acc) < 20) S.accel += (acc - S.accel) * (1 - Math.exp(-dt / 0.8));
    }
    S.heading = hd; S.speed = sp;
    const reduced = R.motion === "reduced" ? 0.3 : 1;
    // Heel: the sim's when the pose carries it; else outward on a turn and to leeward under sail.
    let heelBase;
    if (Number.isFinite(+sh.heel)) heelBase = +sh.heel;
    else {
      const heelTurn = clamp(-S.turnRate * sp * 0.045, -8, 8);
      const beta = wrap180((S.wind.dirDeg ?? 0) - hd) * DEG;
      const sailK = [0.15, 0.6, 1][clamp(Math.round(+sh.sail || 0), 0, 2)];
      heelBase = heelTurn - Math.sin(beta) * 4.5 * sailK * clamp(S.wind.strength ?? 0.5, 0, 1.5);
    }
    // The swell, the maelstrom's bowl and a rogue wave under her: bow against stern, port against starboard.
    const [fx_, fz_] = headingVec(hd);
    const px = -fz_, pz = fx_;
    const surf = (sx, sz) => water.swellAt(sx, sz, _sw).h - maelstrom.depthAt(sx, sz) + weather.waveHeightAt(sx, sz);
    const hBow = surf(x + fx_ * 16, z + fz_ * 16), hSt = surf(x - fx_ * 12, z - fz_ * 12);
    const hP = surf(x + px * 4.4, z + pz * 4.4), hS = surf(x - px * 4.4, z - pz * 4.4);
    const hC = surf(x, z);
    const pitchSwell = Math.atan((hBow - hSt) / 28) * 0.8 / DEG;
    const rollSwell = Math.atan((hP - hS) / 8.8) * 0.7 / DEG;
    const pitchAcc = clamp(S.accel * 0.5, -1.6, 1.6);
    S.idleT += dt;
    const idle = 0.35 * Math.sin(S.idleT * 2 * Math.PI * 0.08) + 0.06 * Math.sin(S.idleT * 2 * Math.PI * 0.137 + 1.3);
    const wet = clamp((+sh.water || 0) / 100, 0, 1);
    const L = S.lurch;
    if (dt > 0) {
      L.v += (-40 * L.heel - 5 * L.v) * dt; L.heel += L.v * dt;
      L.vp += (-40 * L.pitch - 5 * L.vp) * dt; L.pitch += L.vp * dt;
    }
    if (S.wrecked) S.wreck = Math.min(1, S.wreck + dt / 9);
    const heelT = (heelBase + rollSwell + idle) * reduced + L.heel + S.wreck * 16;
    const pitchT = (pitchSwell + pitchAcc) * reduced + L.pitch - S.wreck * 7;
    S.heel += (heelT - S.heel) * (dt > 0 ? 1 - Math.exp(-dt / (0.35 + wet * 0.3)) : 1);
    S.pitch += (pitchT - S.pitch) * (dt > 0 ? 1 - Math.exp(-dt / 0.3) : 1);
    // A big wave or the bowl moves her bodily (no 0.8 damping on what isn't the swell).
    const big = -maelstrom.depthAt(x, z) + weather.waveHeightAt(x, z);
    const heaveT = (hC - big) * 0.8 * reduced + big - S.wreck * 6 - wet * 0.6;
    S.heave += (heaveT - S.heave) * (dt > 0 ? 1 - Math.exp(-dt / 0.4) : 1);
    ship.pose(x, z, hd, S.heel * DEG, S.pitch * DEG, S.heave);
    if (sp > 4 && hBow - hSt > 0.35 && Math.random() < dt * 3) {
      ship.anchors.bow.getWorldPosition(_v);
      _v.y = WATER_Y + 0.6 + hBow;
      fx.spray(_v, { dirX: fx_, dirZ: fz_, amount: clamp((sp - 4) / 4, 0.4, 1) });
    }
    // Rexmaw Raids: water sheeting off the bow at speed; over the forecastle when she digs in at the sprint.
    if (sp > 8 && dt > 0) {
      const sprint = sprintOf(sh);
      toWorld(0, -1.7, 17.5, _v);
      _v.y = WATER_Y + 0.4 + hBow;
      const dig = hBow - hSt > 0.22 ? 1 : 0;
      fx.bowWater?.(_v, fx_, fz_, px * 1.8, pz * 1.8, dt, { rate: clamp((sp - 8) / 8, 0, 1.4) * (sprint ? 1.3 : 1), over: sprint ? 0.6 + dig * 1.5 : dig * 0.4, shipVX: fx_ * sp * 0.55, shipVZ: fz_ * sp * 0.55 });
    }
  }

  // ---- The camera: the Black Flag follow (follow.js), free look by mouse ----
  const follow = createFollow(R);
  cam.setDefaults("chase", { pos: () => follow.pos, target: () => follow.target, fov: FOLLOW.fov, omegaHold: 14, stabilize: 0.82 });
  function stepChase(st, dt) {
    const sh = st?.ship || {};
    const sprint = sprintOf(sh);
    // AC4's travel-speed pull-back only holds in open water: a hostile within ~350 m damps it.
    let threat = 0;
    for (const c of st?.contacts || []) {
      if (c.down || c.sinkT > 0 || c.state === "sinking" || c.state === "sunk") continue;
      if (!(c.hostile || HOSTILE_STATES.has(c.state) || c.firing || c.cls === "tower")) continue;
      const dd = Number.isFinite(+c.dist) ? +c.dist : Math.hypot((+c.x || 0) - (+sh.x || 0), (+c.z || 0) - (+sh.z || 0));
      threat = Math.max(threat, smooth(450, 250, dd));
    }
    const r = follow.step(dt, { sail: sh.sail, sprint, turnRate: S.turnRate, speed: S.speed, threat });
    R.cam.fovOffset(cam.current === "chase" ? r.fovOff : cam.current === "spyglass" ? S.spyZoom : 0);
    S.chase.az = follow.look.yaw;
  }

  // ---- The mouse wheel: the chase's zoom (deck level ↔ tactical); the spyglass's zoom while it's up (AC4) ----
  S.spyZoom = 0;
  function zoomBy(notches) {
    const n = clamp(+notches || 0, -4, 4);
    if (!n) return;
    if (cam.current === "spyglass") { S.spyZoom = clamp(S.spyZoom + n * 1.2, -6, 6); return; }
    follow.zoomBy(n);
  }
  let unbindWheel = null;
  function bindWheel(el) {
    unbindWheel?.();
    if (!el) { unbindWheel = null; return; }
    let acc = 0;
    const onWheel = (e) => {
      if (cam.current !== "chase" && cam.current !== "spyglass") return;
      // The scene owns the wheel over the sea: nothing else turns it into pitch.
      e.stopPropagation();
      // Pixel / line / page deltas → notches (a mouse click ≈ 100 px; trackpads add up).
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      acc += px;
      const n = Math.trunc(acc / 100);
      if (n) { acc -= n * 100; zoomBy(n); }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    unbindWheel = () => el.removeEventListener("wheel", onWheel);
  }
  if (wheelZoom) bindWheel(R.renderer.domElement);

  /** A cinematic beat: cut to `name` for `seconds` (or until endCine when `hold`), then back to the sailing view. */
  function cine(name, opts = {}, seconds = 2, { letterbox = false, priority = 1, hold = false, force = false } = {}) {
    if (!S.cinematics && !force) return false;
    if (S.spy) return false;
    if (S.cine && S.cine.priority > priority) return false;
    cam.shot(name, { ...opts, cut: opts.cut ?? true, duration: opts.duration ?? 0 });
    S.cine = { name, until: R.time + seconds, priority, hold, letterbox };
    if (letterbox) R.post.set({ letterbox: 1 }, { duration: 0.35 });
    return true;
  }
  function endCine({ duration = 0 } = {}) {
    if (!S.cine) return;
    if (S.cine.letterbox) R.post.set({ letterbox: 0 }, { duration: 0.4 });
    S.cine = null;
    cam.back({ duration });
  }
  const lastCine = {};
  const cineReady = (name, gap) => { if (lastCine[name] && R.time - lastCine[name] < gap) return false; lastCine[name] = R.time; return true; };

  const shots = {
    /** The default third-person chase. */
    chase: (o = {}) => { endCineQuiet(); return cam.shot("chase", o); },
    /** The helm view (Night Helm's). */
    helm: (o = {}) => { endCineQuiet(); return cam.shot("helm", o); },
    /** C: swap chase ⇄ helm. */
    toggle: () => { endCineQuiet(); return cam.toggleChase(); },
    /** Back to the Captain's sailing view (a cut by default). */
    back: (o = {}) => { endCineQuiet(); return cam.back(o); },
    /** Free look: swing by mouse deltas (degrees). The input layer: lookBy(dx * k, −dy * k). */
    lookBy: (dYaw, dPitch) => follow.lookBy(+dYaw || 0, +dPitch || 0),
    /** Put the look at a hull-relative yaw / pitch (degrees); `{source:"cursor"}` eases there (cursor aim), else at once. */
    setLook: (yaw, pitch, opts) => follow.setLook(yaw, pitch, opts),
    /**
     * Cursor aim, the camera's side: a client point on the canvas → the look {yaw, pitch} (centre = ahead, left half =
     * port, right half = starboard, far edges = the quarters astern, a dead zone in the middle, pitch gently by height).
     * `apply` (default true) eases the camera there. The UI sends the result on as its `look` / `aim`.
     */
    cursorLook(clientX, clientY, { apply = true } = {}) {
      const r = R.renderer.domElement.getBoundingClientRect();
      const nx = ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, ny = -(((clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
      return follow.cursorLook(nx, ny, { apply });
    },
    /** The mouse wheel's zoom: notches (+ out toward the tactical view, − in toward deck level); in the spyglass it zooms the glass. */
    zoomBy: (notches) => zoomBy(notches),
    /** The zoom's goal 0 (deck level) … 1 (tactical); 0.36 = the default sailing view. `{cut}` jumps. */
    setZoom: (z, o) => follow.setZoom(z, o),
    /** {goal, now, distance (m from the orbit's centre)}. */
    get zoom() { return follow.zoom; },
    /** Bind the wheel to the zoom on an element (createWorld binds the canvas by default; null unbinds). */
    bindWheel: (el) => bindWheel(el),
    /** Hold the aim (right mouse / Q): the shoulder view toward a side. */
    aim: (on, side = null) => follow.aim(on, side),
    /** Look astern of the bow again. */
    recentre: () => follow.recentre(),
    /**
     * The Captain's look from the input layer (ui/input.js emits UI event `look` {yaw, pitch, aiming, mode, locked}):
     * the camera orbits to it. yaw: degrees relative to the hull, + starboard; pitch: degrees, + up. While looks keep
     * arriving the camera never recentres on its own. Aiming (or mode "mortar") swings into the shoulder view.
     */
    look(l = {}) {
      if (!l) return;
      // v3 cursor aim (the default): the look eases to the cursor's and never recentres by itself. Free look (pointer lock) is immediate.
      const cursor = l.source === "cursor" || l.cursor === true || l.locked === false;
      follow.setLook(Number.isFinite(+l.yaw) ? +l.yaw : null, Number.isFinite(+l.pitch) ? +l.pitch : null, { source: cursor ? "cursor" : "free" });
      const zone = follow.look.zone;
      const aimOn = !!l.aiming || l.mode === "mortar";
      follow.aim(aimOn, l.mode === "mortar" ? "mortar" : zone);
    },
    /** The camera's look now: {yaw (hull-relative, + starboard), pitch, aim01, zone, aiming}. */
    get lookState() { return follow.look; },
    /** The core's `aim` intent payload for the look now: {lookYawRel, lookPitch, aiming, mode, point?}. */
    lookPayload({ aiming = null, mode = "auto", point = null } = {}) {
      const l = follow.look;
      const out = { lookYawRel: Math.round(l.yaw * 10) / 10, lookPitch: Math.round(l.pitch * 10) / 10, aiming: aiming == null ? l.aiming : !!aiming, mode };
      if (point && Number.isFinite(point.x)) out.point = { x: point.x, z: point.z };
      return out;
    },
    /** The mortar's aim under the cursor (client px) → {x, z} world, steady while she rolls (see levelSeaPoint). */
    mortarPoint: (clientX, clientY) => levelSeaPoint(clientX, clientY),
    /**
     * E / right mouse: the spyglass. `on` with a contactId aims at it; without one, `yawDeg`/`pitchDeg`
     * (ship-relative, + = starboard / up) aim it (update with spyglassAim while held).
     */
    spyglass(on, { contactId = null, yawDeg = null, pitchDeg = 0 } = {}) {
      if (!on) {
        if (!S.spy) return;
        S.spy = null;
        S.spyZoom = 0;
        R.post.set({ scope: 0 }, { duration: 0.25 });
        cam.back({ duration: 0.3 });
        return;
      }
      endCineQuiet();
      const yaw = Number.isFinite(yawDeg) ? yawDeg : (S.chase.az || 0);
      S.spy = { contactId, yaw, pitch: pitchDeg, aim: new THREE.Vector3() };
      R.post.set({ scope: 1 }, { duration: 0.3 });
      cam.shot("spyglass", { target: () => spyAim(), duration: 0.35 });
    },
    /** Steer the spyglass (ship-relative degrees) or put it on a contact. */
    spyglassAim({ contactId, yawDeg, pitchDeg } = {}) {
      if (!S.spy) return;
      if (contactId !== undefined) S.spy.contactId = contactId;
      if (Number.isFinite(yawDeg)) S.spy.yaw = yawDeg;
      if (Number.isFinite(pitchDeg)) S.spy.pitch = clamp(pitchDeg, -20, 25);
    },
    title: (o = {}) => { endCineQuiet(); return cam.shot("title", o); },
    castOff: (o = {}) => { endCineQuiet(); return cam.shot("castOff", { duration: 2.5, ...o }).then((ok) => { if (ok && cam.current === "castOff") cam.shot("chase", { duration: 2.5 }); return ok; }); },
    /** A big broadside from `side`: low off that side looking aft along the guns (1.5 s). */
    volley: (side = "port", o = {}) => cine("volley", { pos: [side === "port" ? 26 : -26, 3.4, 30], target: [side === "port" ? 2 : -2, 1.2, -2], ...o }, 1.6, { priority: 1, force: !!o.force }),
    /** A ship going down (4.5 s, letterboxed). */
    sink: (id, o = {}) => {
      const at = fleet.positionOf(id, new THREE.Vector3());
      if (!at) return false;
      const sp = toWorld(0, 0, 0, new THREE.Vector3());
      const d = _v.subVectors(at, sp).setY(0);
      const L = Math.max(1, d.length());
      d.normalize();
      const side = new THREE.Vector3(-d.z, 0, d.x);
      const pos = sp.clone().addScaledVector(d, Math.min(L * 0.45, 140)).addScaledVector(side, 30 + L * 0.08).setY(WATER_Y + 14);
      return cine("sink", { pos: () => toLocal(pos, new THREE.Vector3()), target: () => toLocal(fleet.positionOf(id, _w) || at, new THREE.Vector3()), fov: 40 }, 4.5, { letterbox: true, priority: 2, force: !!o.force });
    },
    /** The rogue wave over her (2.8 s). */
    wave: (o = {}) => {
      const w = weather.wave;
      if (!w) return false;
      const loc = toLocal(_v.set(w.x, WATER_Y, w.z));
      const side = loc.x >= 0 ? -1 : 1;
      return cine("wave", { pos: [side * 9, 5.5, -22], target: () => { const ww = weather.wave; return ww ? toLocal(_w.set(ww.x, WATER_Y + 7, ww.z), new THREE.Vector3()) : new THREE.Vector3(0, 6, 60); } }, 2.8, { priority: 3, force: !!o.force });
    },
    /** Boarding: on the rail, across at the enemy's deck; holds until boardEnd(). */
    board: (enemyId, o = {}) => {
      const at = fleet.positionOf(enemyId, new THREE.Vector3());
      const loc = at ? toLocal(at) : new THREE.Vector3(30, 0, 6);
      const sx = loc.x >= 0 ? 1 : -1;
      // Aft on the boarding side, looking forward along our rail at her: the party on deck, her hull across the gap,
      // under our yards (a camera on the near rail sat in her rigging; one across the deck looked into our own sails).
      return cine("board", { pos: [sx * 5.5, 7, -17], target: () => { const p = fleet.positionOf(enemyId, _w); return p ? toLocal(p.setY(p.y + 2), new THREE.Vector3()) : new THREE.Vector3(sx * 30, 2, 6); } }, 999, { letterbox: true, priority: 4, hold: true, force: !!o.force });
    },
    boardEnd: () => { if (S.cine?.name === "board") endCine(); },
    /** The Kraken: aimed at an arm (2.5 s). */
    kraken: (armId = null, o = {}) => cine("kraken", { pos: () => new THREE.Vector3().fromArray(SHOTS.kraken.pos), target: () => toLocal(kraken.armTarget(armId, _w) || toWorld(0, 4, 60, _u), new THREE.Vector3()), fov: 52 }, 2.5, { priority: 3, force: !!o.force }),
    /** Home / banking: a slow orbit. */
    arrival: (o = {}) => { endCineQuiet(); return cam.shot("arrival", { duration: 2, ...o }); },
    /** The Rexmaw going down: a pull up and away. */
    wreck: (o = {}) => { endCineQuiet(); return cam.shot("wreck", { duration: 1.5, ...o }); },
    companion: (o = {}) => { endCineQuiet(); return cam.shot("companion", { duration: 1.2, ...o }); },
    /** Cinematic beats on or off (the setting); forced beats still play. */
    setCinematics(on) { S.cinematics = !!on; if (!on && S.cine && !S.cine.hold) endCine(); },
    get cinematics() { return S.cinematics; },
    get current() { return cam.current; },
    names: Object.keys(SHOTS),
  };
  function endCineQuiet() { if (S.cine) { if (S.cine.letterbox) R.post.set({ letterbox: 0 }, { duration: 0.3 }); S.cine = null; } }
  function spyAim() {
    const sp = S.spy;
    if (!sp) return new THREE.Vector3(0, 0, 300);
    const c = sp.contactId != null ? fleet.positionOf(sp.contactId, _w) : null;
    if (c) return toLocal(c.setY(c.y + 3), sp.aim);
    const eye = SHOTS.spyglass.pos;
    return dir(sp.yaw, sp.pitch, sp.aim).multiplyScalar(320).add(_u.fromArray(eye));
  }

  // ---- Look: the grade, the haze ----
  function setLook(name) {
    if (S.look === name) return;
    S.look = name;
    R.post.set({ grade: { phase: name } }, { duration: 3 });
  }
  function stepLook(st, dt) {
    const sh = st?.ship || {};
    let look = "bay";
    const sk = weather.storminess;
    const mw = maelstrom.where;
    const mk = mw ? smooth(mw.r * 1.3, mw.r * 0.6, Math.hypot((+sh.x || 0) - mw.x, (+sh.z || 0) - mw.z)) : 0;
    let gloam = 0, battle = false;
    for (const c of st?.contacts || []) {
      const d = Number.isFinite(+c.dist) ? +c.dist : Math.hypot(c.x - sh.x, c.z - sh.z);
      if (c.cls === "gloam" && d < 700) gloam = Math.max(gloam, smooth(700, 300, d));
      if (d < 480 && (c.portsOpen?.port || c.portsOpen?.starboard || c.firing || c.state === "broadside" || c.state === "ram")) battle = true;
    }
    if ((st?.projectiles?.length || 0) > 0) battle = true;
    if (battle) look = "battle";
    if (mk > 0.5) look = "maelstrom";
    if (gloam > 0.5) look = "gloam";
    if (sk > 0.5) look = "storm";
    if ((S.clock ?? 0) > 0.88 && !(S.day > 0.5)) look = "dawn";
    if (S.day > 0.5 && sk <= 0.5) look = battle ? "daybattle" : "day";
    setLook(look);
    // The fog's colour leans: the storm's slate, the maelstrom's green-black, the Gloam's cold teal.
    let hk = 0;
    if (sk > 0.02) { R.atmos.haze.set("#2a3240"); hk = 0.75 * sk; }
    else if (gloam > 0.02) { R.atmos.haze.set("#3d5a57"); hk = 0.5 * gloam; }
    else if (mk > 0.02) { R.atmos.haze.set("#1f3a36"); hk = 0.35 * mk; }
    R.atmos.hazeK += (hk - R.atmos.hazeK) * Math.min(1, dt * 0.6);
    // Under the storm's cloud the stars go out.
    const starsK = Math.round((1 - sk) * 20) / 20;
    if (starsK !== S.starsK) { S.starsK = starsK; sky.fadeStars(starsK, { duration: 1.5 }); }
    // Visibility: the core's when it sends one, else a clear night closing in in the storm and the mist. v4: inside a
    // sea event's squall or fog bank it closes further (never wider than the core's: the smaller wins).
    const base = Number.isFinite(+st?.visibility) ? +st.visibility : (S.day > 0.5 ? DAY_VIS : CLEAR_VIS) * (1 - 0.82 * sk) * (1 - 0.35 * mk) * (1 - 0.6 * gloam);
    R.setVisibility(Math.min(base, seaEvents.visibility));
    if (seaEvents.fogIn > 0.02 && sk <= 0.02) { R.atmos.haze.set("#56606c"); R.atmos.hazeK = Math.max(R.atmos.hazeK, 0.45 * seaEvents.fogIn); }
  }

  /** Day (1) or night (0): state.daylight (0..1), state/world `timeOfDay`/`time`/`tod` ("day"|"night"), the mission's. */
  function dayOf(st, bay) {
    const n = +st?.daylight;
    if (Number.isFinite(n)) return n >= 0.5 ? 1 : 0;
    const words = [st?.timeOfDay, st?.tod, st?.time, st?.mission?.time, st?.mission?.tod, bay?.timeOfDay, bay?.tod, bay?.time, bay?.mission?.time];
    for (const w of words) {
      if (typeof w !== "string") continue;
      if (/day|noon|sun/i.test(w)) return 1;
      if (/night|dusk|dark/i.test(w)) return 0;
    }
    if (st?.day === true || bay?.day === true) return 1;
    return 0;
  }
  function setDay(v, seconds = 2.5) {
    S.day = v;
    sky.setDay(v, { duration: seconds });
    if (S.bay?.wind) sky.setWind(S.bay.wind.dirDeg);
    ship.lanterns(v > 0.5 ? 0.25 : 1, seconds || 0.1);
    water.setGlow(v > 0.5 ? 0 : null, { duration: seconds || 0.01 });
    life?.setDay(v, seconds);
    S.look = null;
  }

  // ---- The Kraken: the core's grab (arms at the rails' stations) → the event arms ----
  function stepKraken(st) {
    const k = st?.hazards?.kraken;
    // v4: a sea event's lone arm (seaevents.js) rides alongside the hazard's.
    const evArms = seaEvents.arms;
    if (!k) { kraken.sync(evArms.map((a) => ({ ...a, stage: a.stage === "up" && !kraken.armTarget(a.id, _w) ? "rise" : a.stage }))); return; }
    const list = [...evArms];
    const stage = k.stage;
    if (stage === "ink") {
      // Ink in the water: dark clouds spreading where it will rise.
      if (Number.isFinite(+k.x) && Math.random() < 0.25) fx.ghostMist?.(_v.set(+k.x + (Math.random() - 0.5) * 30, WATER_Y + 0.3, +k.z + (Math.random() - 0.5) * 30), { thick: false });
      if (Number.isFinite(+k.x)) list.push({ id: "kraken-ink", x: +k.x, z: +k.z, stage: "tremor" });
    }
    (k.arms || []).forEach((arm, i) => {
      const sp = STATIONS[arm.station]?.[0];
      const local = sp ? { x: sp.x, z: sp.z } : { x: i % 2 ? 4 : -4, z: -2 + i * 4 };
      const sx = local.x >= 0 ? 1 : -1;
      const p = toWorld(sx * 7.5, 0, local.z, _v);
      const alive = (+arm.hp || 0) > 0 && stage !== "retreat";
      list.push({ id: arm.id, x: p.x, z: p.z, stage: alive ? "up" : "sink" });
    });
    if (stage === "grab" && !S.krakenSeen) { S.krakenSeen = true; if (cineReady("kraken", 60)) shots.kraken(k.arms?.[0]?.id ?? null); R.cam.trauma(0.4); }
    // "up" straight away would skip the rise: claim with "rise" the first frames.
    for (const it of list) { if (it.stage === "up" && !kraken.armTarget(it.id, _w)) it.stage = "rise"; }
    kraken.sync(list);
  }

  // ---- v5 Kraken's Wake: the Kraken's eye (state.objective.eye) → kraken.js's set piece ----
  // Mantle centred on the core's eye spot (its r = 18 m reach covers the mantle and the eye, ~7 m toward her), facing
  // her; up for the "rise" (the telegraph) and "up" stages, sunk on "dive", hidden while "down" (a faint ring of light
  // at `next`, where it will rise).
  function stepEye(st) {
    const E = st?.objective?.eye;
    const sh = st?.ship;
    const up = E && (E.stage === "rise" || E.stage === "up") && Number.isFinite(+E.x) && Number.isFinite(+E.z);
    if (!up) {
      if (S.eye) { kraken.sinkPiece(); S.eye = null; }
      const n = E?.stage === "down" ? E.next : null;
      if (n && Number.isFinite(+n.x) && Number.isFinite(+n.z) && R.time >= (S.eyeRingAt || 0)) {
        S.eyeRingAt = R.time + 3.2;
        water.pulse?.({ x: +n.x, z: +n.z, color: "#3ff3e0", speed: 5, intensity: 0.6 });
      }
      return;
    }
    const x = +E.x, z = +E.z;
    const fx0 = Number.isFinite(+sh?.x) ? +sh.x : x + 1, fz0 = Number.isFinite(+sh?.z) ? +sh.z : z;
    const face = Math.atan2(fz0 - z, fx0 - x);
    if (!S.eye || Math.hypot(S.eye.x - x, S.eye.z - z) > 1 || kraken.pieceStage === "hidden" || kraken.pieceStage === "sink") {
      // A new surfacing: the core's rise lasts ~3 s, the piece's ~8 s, so it plays faster (faster still if it's already up).
      kraken.placePiece(x, z, fx0, fz0);
      kraken.risePiece(E.stage === "up" ? 4 : 2.4);
      S.eye = { x, z, face };
    } else if (Math.abs(Math.atan2(Math.sin(face - S.eye.face), Math.cos(face - S.eye.face))) > 0.07) {
      // Keep the eye on her as she sails round it.
      kraken.placePiece(x, z, fx0, fz0);
      S.eye.face = face;
    }
    if (E.stage === "up") kraken.risePiece(4);
  }

  // ---- The API ----
  const api = {
    R, sky, water, fx, ship, helm, wake, kraken, flames, fleet, shots, islands, maelstrom, weather, props, life, sails,
    overlays, pickups, setpieces, speedLines, markers, target, seaEventsLayer: seaEvents,
    /** The camera's look now (= shots.lookState): {yaw (hull-relative °, + starboard), pitch (°, + up), aim01, zone, aiming}. */
    get look() { return follow.look; },
    /**
     * Slow motion: animation time at `scale` for `seconds`, easing back (a ship's last volley, her sinking).
     * The sim keeps its own clock: main scales run.step by world.timeScale to slow the sim with it.
     */
    slowmo(scale = 0.3, seconds = 0.8) {
      if (R.motion === "reduced") return false;
      R.post.hitStop(Math.max(0, +seconds || 0) * 1000, clamp(+scale || 0.3, 0.02, 1), 260);
      return true;
    },
    /** The animation time scale now (hit-stop / slow-mo), 0..1: main may multiply the sim's dt by it. */
    get timeScale() { return R.post.timeScale(performance.now()); },
    /** The mortar's circle follows this sea point when the core's preview has no target (null clears). */
    setAimPoint(x, z) { overlays.setAimPoint(x, z); },
    /** A preview the scene draws itself (solo/debug): {weapon, side, aiming, arcs?|line?|drops?|target?}; null clears. */
    setAimPreview(p) { overlays.setPreview(p); },
    /** The fort's gun towers, world: [{i, x, z, top, down}] (state.fort.towers[i] ↔ i). */
    fortTowers: () => islands.fortTowers(),
    /** Day (1) or night (0) by hand (null: back to the state's / the world's). */
    setDaylight(v, { seconds = 2.5 } = {}) { S.dayLock = v == null ? null : (+v >= 0.5 ? 1 : 0); if (S.dayLock != null && S.dayLock !== S.day) setDay(S.dayLock, seconds); },
    get daylight() { return S.day || 0; },
    /** Ship-space crew spots and the deck walk graph (stations.js). */
    STATIONS, walkGraph: WALK, walkPath, nearestNode, deckHeight,
    /** Anchors for audio and look targets (Object3Ds; getWorldPosition follows them). */
    anchors: { ...ship.anchors, roar: maelstrom.anchors.roar },
    /** Where the companion stands: parent R.shipSpace, ship-space feet and facing. */
    companionSpot: { parent: R.shipSpace, pos: [...B.COMPANION.pos], faceYawDeg: B.COMPANION.faceYawDeg, anchor: ship.anchors.companion },
    blocking: B,
    get bay() { return S.bay; },
    /** v4: the boarding fight module (scene/boardfight.js) main built, or null: it stages boarding in place of v3's grapple. */
    setBoardFight(bf) { S.bf = bf || null; },
    /** The fight's pick / screenPos / anchors for the HUD (ui/boarding.js reads world.boardfight too). */
    get boardfight() { return S.bf || null; },

    /**
     * Per frame, with run.state() and run.pose() (the pose is interpolated between the sim's steps;
     * it overrides the state's ship and contact x/z/heading/heel).
     * @param {object} state @param {number} dt  real seconds @param {object} [pose]
     */
    update(state, dt = 1 / 60, poseIn = null) {
      if (!state) return;
      const d = clamp(+dt || 0, 0, 0.1);
      const st = mergePose(state, poseIn);
      S.state = st;
      if (st.phase !== S.phase) phaseChange(st.phase, S.phase);
      const sh = st.ship || { x: S.bay?.port?.x ?? 0, z: S.bay?.port?.z ?? 0, heading: 0, speed: 0 };
      // A jump (a new night, a restart): no wake strung across it, no lurch.
      const jumped = S.lastX != null && Math.hypot((+sh.x || 0) - S.lastX, (+sh.z || 0) - S.lastZ) > 60;
      S.lastX = +sh.x || 0; S.lastZ = +sh.z || 0;
      if (jumped) { wake.reset(); S.chase.settled = false; S.turnRate = 0; S.accel = 0; S.heading = +sh.heading || 0; S.speed = +sh.speed || 0; }
      // The wind and the night clock. The live (gusting) wind drives the sails, heel, rain and fog; the sea keeps
      // the bay's mean wind (setWorld): turning the swell's direction moves every crest at once (its phase is
      // measured from the world origin, so 1° at 1 km out is radians of phase) and its strength sets the whole
      // sea's height, so following each gust made the sea, the ship and the camera lurch as a storm arrived.
      const wind = st.wind || S.bay?.wind;
      if (wind) S.wind = { dirDeg: +wind.dirDeg || 0, strength: +wind.strength || 0.7 };
      // The sky's night clock: v2's state.clock is mission progress, so a night mission holds a moonlit deep
      // night (free roam by night still runs dusk → dawn on it); v1 states (no daylight) keep the clock.
      const v2 = Number.isFinite(+st.daylight);
      const freeRoam = /^free/.test(String(st.mission?.id || S.bay?.mission || ""));
      const skyClock = !v2 || freeRoam ? +st.clock : 0.42;
      if (Number.isFinite(skyClock)) {
        const c = clamp(skyClock, 0, 1);
        if (Math.abs(c - S.clock) > 0.004) { S.clock = c; sky.setNight(c, { duration: 2 }); water.setNight(c, { duration: 2 }); ship.setWindows(0.85 - 0.6 * c); }
      }
      // Rexmaw Raids: day or night (the mission's), unless the API set it.
      const dayT = S.dayLock ?? dayOf(st, S.bay);
      if (dayT !== S.day) setDay(dayT, S.day == null ? 0 : 2.5);
      pose(sh, d);
      wake.update(+sh.x || 0, +sh.z || 0, +sh.heading || 0, Math.max(0, +sh.speed || 0), -maelstrom.depthAt(+sh.x || 0, +sh.z || 0));
      helm.setWheel(Number.isFinite(+sh.wheel) ? +sh.wheel : (Number.isFinite(+sh.rudder) ? +sh.rudder / 35 : 0));
      // Hull damage on the rails, the plunder in the hold as crates on deck.
      if (Number.isFinite(+sh.hullMax)) S.hullMax = +sh.hullMax;
      if (Number.isFinite(+sh.hull) && +sh.hull !== S.hull) {
        S.hull = +sh.hull;
        helm.setDamage(Math.round((1 - clamp(S.hull / Math.max(1, S.hullMax), 0, 1)) * 6), { side: S.lastHitSide });
      }
      const hold = +st.plunder?.hold;
      if (Number.isFinite(hold)) {
        const n = clamp(Math.ceil(hold / 160), 0, 12);
        if (n !== S.cargo) {
          const prev = S.cargo;
          S.cargo = n;
          const [hx, hz] = headingVec(+sh.heading || 0);
          if (prev == null || n > prev) helm.setCargo(n, { quiet: true });
          else helm.setCargo(n, { side: S.lastHitSide || 1, shipVel: { x: hx * (+sh.speed || 0), z: hz * (+sh.speed || 0) } });
        }
      }
      // Far out, the harbour is fog: don't draw what can't be seen.
      const port = S.bay?.port || { x: 0, z: -40 };
      const fogReach = 3.2 / Math.max(1e-4, R.atmos.density);
      ship.showHarbour(Math.hypot((+sh.x || 0) - port.x, (+sh.z || 0) - port.z) < Math.min(1700, fogReach + 200));

      // Fires: aboard (the sim's count, at deck spots, or where a fire event put them), the fleet's, the islands'.
      flames.begin();
      const nRex = clamp(Math.round(+sh.fires || 0), 0, REX_FIRE_SPOTS.length);
      for (let i = 0; i < nRex; i++) {
        const f = S.rexFires[i] || REX_FIRE_SPOTS[i];
        flames.add(toWorld(f[0], f[1], f[2], _v), { size: 1.7, seed: i * 0.37 + 0.1 });
      }
      if (S.rexFires.length > nRex) S.rexFires.length = nRex;

      // v4: the sea events first (their derelicts join the fleet, their spouts / squall / waves the weather).
      seaEvents.update(st, d);
      fleet.update(fleetState(st), d, { wind: S.wind, drop: surfaceDrop });
      target.update(st, d);
      shotsInFlight.update(st, d);
      R.camera.getWorldPosition(_w);
      islands.update(st, d, { camPos: _w });
      maelstrom.update(st, d);
      weather.update(weatherState(st), d, { ship: sh, wind: S.wind, extra: seaEvents.extra });
      life.update(d, { ship: sh, wind: S.wind });
      overlays.update(st, d, { look: follow.look });
      // Her own canvas thins whenever the chase camera looks ahead (it would hide the sea she's sailing into), further over
      // the bow chasers, and in the boarding shot (it looks across the deck).
      // (v3: not out at the tactical zoom — the lens looks down over her canvas from there.)
      // v4.1: the bow lookout (zoomed in, looking ahead: follow's closeAhead 0..1) stands forward of her canvas; it still
      // thins to 0.2 with it, for the move out there past her side.
      const lookAhead = follow.look.zone === "bow" && cam.current === "chase" && follow.zoom.now < 0.62;
      const closeFade = cam.current === "chase" ? 1 - 0.8 * follow.look.closeAhead : 1;
      // The GLB's ensign at the spanker gaff's peak: hidden while the lens is within 7 m of it (close in it filled the frame),
      // and while the chase looks ahead (from the rest stop it hangs right over the reticle, in front of the mainmast).
      if (S.ensign === undefined) { S.ensign = null; R.shipSpace.traverse((o) => { if (o.name === "flag-aboard") S.ensign = o; }); }
      if (S.ensign) { S.ensign.getWorldPosition(_u); R.camera.getWorldPosition(_w); S.ensign.visible = _u.distanceTo(_w) > 7 && !lookAhead; }
      sails.setFade(Math.min(closeFade, (lookAhead && follow.state.aiming) || S.cine?.name === "board" ? 0.22 : lookAhead ? 0.45 : 1));
      pickups.update(st, d);
      setpieces.update(st, d);
      markers.update(st, d);
      speedLines.update(d, { sprint: sprintOf(sh) ? 1 : 0, speed: S.speed });
      sails.update(d, { sail: st.phase === "moored" || st.phase === "briefing" || st.phase === "title" ? 0 : sh.sail, sprint: sprintOf(sh), wind: S.wind, heading: +sh.heading || 0, masts: sh.masts, day: S.day || 0 });
      stepKraken(st);
      stepEye(st);
      flames.end(d);
      stepLook(st, d);

      // Timers, the chase, the cinematic beats.
      for (let i = S.timers.length - 1; i >= 0; i--) if (R.time >= S.timers[i].at) { const t = S.timers.splice(i, 1)[0]; try { t.fn(); } catch (e) { console.debug("[night-raid] timer threw", e); } }
      stepChase(st, d);
      if (S.cine && !S.cine.hold && R.time > S.cine.until) endCine();
      // The rogue wave: cut to it just before it hits (once per wave).
      const wv = st.hazards?.wave;
      if (wv && Number.isFinite(+wv.eta) && +wv.eta < 2.6 && +wv.eta > 0 && S.waveCut !== (wv.id ?? "w")) { S.waveCut = wv.id ?? "w"; shots.wave(); }
      // Aim the Captain's swivel at a hovered weak point (pick() remembers it).
      if (S.hover?.kind === "weak") { const p = S.hover.pos; if (p) props.aimSwivel(p); }
    },

    /**
     * A run event (run.on names and payloads; see the core API). The world reacts; nothing is returned.
     * @param {string} name @param {object} [p]
     */
    event(name, p = {}) {
      switch (name) {
        case "volley": onVolley(p); break;
        case "impact": onImpact(p); break;
        case "fire": {
          if (p.target === "rexmaw") {
            if (p.stage === "out") { const f = S.rexFires.pop(); if (f) fx.steam(toWorld(f[0], f[1] + 0.3, f[2], _v)); }
            else if (Number.isFinite(+p.x)) { const l = toLocal(_v.set(+p.x, WATER_Y + 2.5, +p.z)); S.rexFires.push([clamp(l.x, -3.4, 3.4), deckHeight(l.x, l.z) + 0.2, clamp(l.z, -11, 18)]); }
          } else fleet.fire(p.target, p, p.stage);
          break;
        }
        case "crew_splash":
          if (Number.isFinite(+p.x)) fx.splash(_v.set(+p.x, WATER_Y, +p.z), { scale: 0.6 });
          break;
        case "pickup": pickups.collect(p); break;
        case "powerup": pickups.powerup(p); break;
        case "barrel":
          if (Number.isFinite(+p.x)) {
            if (p.stage === "ignite") { fx.burst(_v.set(+p.x, WATER_Y + 0.8, +p.z), { color: "#ff8a3a", count: 30, speed: 3, size: 0.4, life: 0.7, intensity: 4 }); fx.embers?.(_v, { count: 8 }); }
            else if (p.stage === "out") fx.steam?.(_v.set(+p.x, WATER_Y + 0.6, +p.z));
            else if (p.stage === "drop") fx.splash(_v.set(+p.x, WATER_Y, +p.z), { scale: 0.8 });
          }
          break;
        case "danger":
          // The companion marks an area: a red ring of light runs out across it (the decal itself is overlays').
          if (p.stage !== "expire" && Number.isFinite(+p.x)) water.pulse({ x: +p.x, z: +p.z, color: "#ff3a2a", speed: Math.max(6, (+p.r || 40) / 3), intensity: 0.8 });
          break;
        case "heading_call": {
          const sh = S.state?.ship;
          if (sh) water.pulse({ x: +sh.x, z: +sh.z, color: "#ffd27a", speed: 16, intensity: 0.6 });
          break;
        }
        case "split": {
          const e = fleet.positionOf(p.id, _v);
          if (e) { fx.splinters(e.clone(), { count: 60, scale: 1.8 }); fx.splash(e.clone().setY(WATER_Y), { scale: 2.4 }); fx.flotsam?.(e.clone(), { n: 8 }); R.cam.trauma(0.35); }
          fleet.sink(p.id);
          break;
        }
        case "contrib": {
          // A small gilt glint where the crew's work shows (the HUD's "+12 Leo's guns" pops at popAnchor()).
          const at = popWorld(p, new THREE.Vector3());
          fx.burst(at, { color: "#ffd27a", count: 10, speed: 1.2, size: 0.14, life: 0.55, intensity: 2.6 });
          break;
        }
        case "objective":
          // A new step: a gilt ring of light runs out from the new marker (or from the Rexmaw toward a ship).
          if (p.stage === "start" && p.marker && Number.isFinite(+p.marker.x)) water.pulse({ x: +p.marker.x, z: +p.marker.z, color: "#ffd27a", speed: 14, intensity: 0.9 });
          break;
        case "spotted":
          if (p.stage === "spotted") R.cam.fovKick(-1.5);
          break;
        case "sink":
          if (p.cause === "explode") { const e = fleet.positionOf(p.id, _v); if (e) { fx.explosion(e.clone().setY(e.y + 1), { scale: 1.6 }); R.cam.trauma(closeTo(p.id, 300) ? 0.45 : 0.15); } }
          // Our kill, close enough to see: a beat of slow motion (0.3×, 0.8 s).
          if ((p.ours || p.by === "rexmaw" || p.cause === "gunfire" || p.cause === "ram") && closeTo(p.id, 450)) api.slowmo(0.3, 0.8);
          fleet.sink(p.id);
          // v4: the letterboxed cut only for the big ones and the mission's prize (the core's `cinematic`; an older core
          // without the flag: by class). Small ships go down in place (fleet.js: flotsam, ~10 s), no cut.
          if (isCinematicSink(p) && cineReady("sink", 14) && closeTo(p.id, 700)) after(0.6, () => shots.sink(p.id));
          else { const e = fleet.positionOf(p.id, _v); if (e && closeTo(p.id, 700)) { fx.flotsam?.(e.clone(), { n: 6 }); fx.splash(e.clone().setY(WATER_Y), { scale: 1.6 }); } }
          break;
        case "sea_event": onSeaEvent(p); break;
        case "surrender": fleet.surrender(p.id); break;
        case "brace":
          R.cam.fovKick(p.perfect ? -3 : -1.5);
          if (p.perfect) { ship.anchors.helm.getWorldPosition(_v); fx.burst(_v.add(_w.set(0, 1.4, 0)), { color: "#ffd27a", count: 24, speed: 2, size: 0.18, life: 0.6, intensity: 3 }); }
          break;
        case "swivel": onSwivel(p); break;
        case "board":
          // v4: with the deck-fight module (setBoardFight) its hooks and lines replace v3's gold grapple trails, and it
          // ends the boarding shot itself once everyone is home (boardEnd() here would cut its end beats).
          if (p.stage === "start") { S.boardEnemy = p.enemyId; shots.board(p.enemyId, { force: true }); R.cam.trauma(0.25); if (!S.bf) grapple(p.enemyId); }
          else if (p.stage === "won" || p.stage === "lost") { if (!S.bf?.active) shots.boardEnd(); S.boardEnemy = null; }
          else if (p.stage === "round") { R.cam.trauma(0.12); const e = fleet.positionOf(p.enemyId ?? S.boardEnemy, _v); if (e) fx.sparks(e.setY(e.y + 2), { count: 20, speed: 3 }); }
          break;
        case "hazard": onHazard(p); break;
        case "overboard":
          if (p.stage === "swept" || p.stage === "lost") { const side = Math.random() < 0.5 ? 1 : -1; fx.splash(toWorld(side * 5.5, 0, 2 + Math.random() * 6, _v).setY(WATER_Y), { scale: 0.7 }); }
          break;
        case "bank": {
          ship.ringBell(2);
          const c = toWorld(0, 0, 3, _v);
          water.pulse({ x: c.x, z: c.z, color: "#ffd27a", speed: 9, intensity: 1.2 });
          for (let k = 0; k < 3; k++) after(k * 0.25, () => fx.burst(toWorld((Math.random() - 0.5) * 3, 2.5, 3 + (Math.random() - 0.5) * 4, new THREE.Vector3()), { color: "#ffd27a", count: 30, speed: 2.5, size: 0.2, life: 1, intensity: 3.5 }));
          break;
        }
        case "plunder": {
          if (p.amount > 0) { const c = toWorld(0, 2.5, 4, _v); fx.burst(c, { color: "#ffd27a", count: 26, speed: 2, size: 0.18, life: 0.9, intensity: 3 }); }
          break;
        }
        case "medal": {
          ship.anchors.masthead.getWorldPosition(_v);
          for (let k = 0; k < 2; k++) after(k * 0.38, () => fx.burst(_v.clone().add(_w.set((Math.random() - 0.5) * 16, 4 + Math.random() * 8, 10 + Math.random() * 20)), { color: "#ffd27a", count: 60, speed: 6, size: 0.45, life: 1.6, intensity: 3.6 }));
          break;
        }
        case "dawn":
          if (p.stage === "dawn") { sky.setNight(1, { duration: 20 }); water.setNight(1, { duration: 20 }); }
          break;
        case "end":
          if (p.reason === "sunk") { S.wrecked = true; ship.lanterns(0.3, 4); ship.gutter(3); R.cam.trauma(0.5); R.post.set({ grade: { sat: 0.7, vignette: 0.62 } }, { duration: 3 }); if (S.autoCamera) shots.wreck(); }
          else if (p.reason === "home" || p.reason === "dawn" || p.reason === "retired") { ship.ringBell(4); if (S.autoCamera) shots.arrival(); }
          break;
        case "contact":
          if (p.stage === "lost") { /* the fleet fades it out when it leaves the state */ }
          break;
        case "camera":
          if (p.view === "helm") shots.helm({ duration: 0.5 });
          else if (p.view === "chase") shots.chase({ duration: 0.5 });
          else shots.toggle();
          break;
        case "phase": if (p.phase) phaseChange(p.phase, p.prev); break;
        default: break;
      }
    },

    /**
     * What's under the pointer: a glowing weak point (on a ship, or a Kraken arm), a contact's ship,
     * or a crew member (when the crew module registered a picker with setCrewPicker).
     * @returns {{kind: "weak", id, contactId}|{kind: "contact", id}|{kind: "crew", id}|null}
     */
    pick(clientX, clientY, { spyglass = false } = {}) {
      // The spyglass: whatever contact sits nearest the point on screen (a generous circle, not the hull's outline).
      if (spyglass) {
        const r = R.renderer.domElement.getBoundingClientRect();
        let best = null, bd = 0.12 * r.height;
        for (const c of S.state?.contacts || []) {
          const s = api.screenPos(c.id, { lift: 4 });
          if (!s.visible) continue;
          const d = Math.hypot(s.x - clientX, s.y - clientY);
          if (d < bd) { bd = d; best = c.id; }
        }
        return best != null ? { kind: "contact", id: best } : null;
      }
      const ray = cam.ray({ clientX, clientY }).ray;
      // Precise hits first (a weak point, a Kraken arm, a crew member under the ray), nearest along it; else the
      // v4 generous ship pick (target.js: within 60 px of her silhouette or the ray through her enlarged hull).
      const hits = [];
      const w = fleet.pickWeak(ray);
      if (w) hits.push({ kind: "weak", id: w.weakId, contactId: w.contactId, dist: w.dist - 2 });
      const arms = [...(S.state?.hazards?.kraken?.arms || []).map((a) => ({ id: a.id, hp: a.hp, contactId: "kraken" })),
        ...seaEvents.arms.map((a) => ({ id: a.id, hp: a.hp, contactId: a.eventId }))];
      for (const arm of arms) {
        if (!((+arm.hp || 0) > 0)) continue;
        const p = kraken.armTarget(arm.id, _v);
        if (!p) continue;
        const along = _w.copy(p).sub(ray.origin).dot(ray.direction);
        if (along > 0 && ray.distanceToPoint(p) < Math.max(2.2, along * 0.03)) hits.push({ kind: "weak", id: arm.id, contactId: arm.contactId, dist: along - 2 });
      }
      // v5: the Kraken's eye while it's above the water (the core takes the swivel on "kraken_eye"): on or near the eye, or
      // anywhere over the mantle.
      const eyeSt = S.state?.objective?.eye;
      if (eyeSt && (eyeSt.stage === "up" || eyeSt.stage === "rise") && kraken.pieceStage !== "hidden" && kraken.pieceStage !== "sink") {
        const p = kraken.eyeTarget(_v);
        const along = _w.copy(p).sub(ray.origin).dot(ray.direction);
        const onEye = along > 0 && ray.distanceToPoint(p) < Math.max(4, along * 0.035);
        const body = _w.set(+eyeSt.x, WATER_Y + 3, +eyeSt.z);
        const onBody = Number.isFinite(body.x) && _u.copy(body).sub(ray.origin).dot(ray.direction) > 0 && ray.distanceToPoint(body) < Math.max(9, along * 0.04);
        // Or near it on screen (as generous as a ship's pick: it's far off and the click should just take it).
        const sp = !onEye && !onBody && along > 0 ? api.screenPos(p) : null;
        const nearSp = !!sp?.visible && Math.hypot(sp.x - clientX, sp.y - clientY) <= 60;
        if (onEye || onBody || nearSp) hits.push({ kind: "weak", id: "kraken_eye", contactId: "kraken_eye", dist: along - 4 });
      }
      const c = S.crewPicker?.(ray);
      if (c) hits.push({ kind: "crew", id: c.id, dist: (c.dist ?? c.distance ?? 0) - 1 });
      hits.sort((a, b) => a.dist - b.dist);
      let h = hits[0] || null;
      if (!h) { const s = target.pick(clientX, clientY, ray); if (s) h = { kind: "contact", id: s.id }; }
      if (!h) return null;
      const out = { kind: h.kind, id: h.id };
      if (h.contactId != null) out.contactId = h.contactId;
      return out;
    },

    /**
     * v4: the ship nearest a client point within `radius` px of her silhouette (or under the ray through her enlarged
     * hull): {id, px (0 inside her box), dist (m)} | null. pick() uses it after the precise hits.
     */
    pickShip(clientX, clientY, { radius } = {}) {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
      return target.pick(clientX, clientY, cam.ray({ clientX, clientY }).ray, radius ? { radius } : {});
    },

    /** pick() plus hover feedback (a hovered weak point brightens and the swivel follows it; a hovered ship gets a faint outline). */
    hover(clientX, clientY) {
      const hit = Number.isFinite(clientX) ? api.pick(clientX, clientY) : null;
      const krakenArm = hit?.kind === "weak" && (hit.contactId === "kraken" || !fleet.has(hit.contactId));
      fleet.hoverWeak(hit?.kind === "weak" && !krakenArm ? { contactId: hit.contactId, weakId: hit.id } : null);
      S.hover = hit?.kind === "weak" ? { kind: "weak", pos: hit.id === "kraken_eye" ? kraken.eyeTarget(new THREE.Vector3()) : krakenArm ? kraken.armTarget(hit.id, new THREE.Vector3()) : weakPos(hit.contactId, hit.id) } : null;
      target.setHover(hit?.kind === "contact" ? hit.id : null);
      return hit;
    },

    /**
     * v4: the floating ship tags' anchors (the UI's): every ship afloat → {contactId, x, y (client px, `lift` m above
     * her masthead), visible, dist (m from the Rexmaw), locked, sinking}. The UI filters (≤ 600 m or locked).
     */
    shipTagAnchors(opts) { return target.tagAnchors(opts); },
    /** v4: the lock bracket follows state.lock; the UI may set it ahead of the state (id | null; undefined = the state's). */
    setLock(id) { target.setLock(id); },
    get lockId() { return target.lockId; },
    /** v4: the lock bracket's screen box ({x, y, w, h} client px) or null. */
    get lockRect() { return target.lockRect; },
    /** v4: the sea events the scene is drawing: [{id, kind, stage, k}]. */
    seaEvents: () => seaEvents.stats(),

    /** The crew module's picker: fn(ray) → {id, dist} | null. */
    setCrewPicker(fn) { S.crewPicker = typeof fn === "function" ? fn : null; },

    /**
     * A contact's (or any world point's) place on screen: {x, y, visible} in client pixels. v3 special ids:
     * "objective" / "objective:bonus" (the marker's anchor: over the chevron, or up the pillar), "board" / "board:<id>"
     * (the "B — BOARD" prompt's anchor over the nearest / that eligible ship). Their `lift` is already in.
     */
    screenPos(idOrWorld, { lift = 6 } = {}) {
      let p = null, anchored = !!idOrWorld?.isVector3;
      if (idOrWorld?.isVector3) p = _v.copy(idOrWorld);
      else if (idOrWorld === "rexmaw") p = toWorld(0, 8, 3, _v);
      else if (idOrWorld === "kraken_eye") { p = S.eye ? kraken.eyeTarget(_v) : null; anchored = true; }   // v5: its damage numbers
      else if (idOrWorld === "objective" || idOrWorld === "objective:bonus") { p = markers.objectiveAnchor(_v, { bonus: idOrWorld !== "objective" }); anchored = true; }
      else if (typeof idOrWorld === "string" && (idOrWorld === "board" || idOrWorld.startsWith("board:"))) { p = markers.boardAnchor(idOrWorld === "board" ? null : idOrWorld.slice(6), _v); anchored = true; }
      else p = posOf(idOrWorld, _v);
      if (!p) return { x: 0, y: 0, visible: false };
      if (!anchored) p.y += lift;
      R.camera.updateMatrixWorld();
      const ndc = p.clone().project(R.camera);
      const r = R.renderer.domElement.getBoundingClientRect();
      const visible = ndc.z < 1 && ndc.z > -1 && Math.abs(ndc.x) <= 1.05 && Math.abs(ndc.y) <= 1.05;
      return { x: r.left + (ndc.x * 0.5 + 0.5) * r.width, y: r.top + (-ndc.y * 0.5 + 0.5) * r.height, visible };
    },

    /**
     * The HUD's objective arrow (spec A1): {active, kind:"ship"|"area", id, label, dist, x, y, onScreen, behind,
     * edge:{x, y, angle°} | null} — when off screen (or behind the lens) `edge` is the arrow's spot `margin` px in
     * from the screen edge and its angle (0 = pointing right, 90 = down). null when there's no marker.
     */
    objectiveScreen(opts = {}) { return markers.objectiveScreen(opts); },

    /**
     * Where a crew contribution pops (spec C10): a `contrib` event payload {kind, who, x, z, target, side?} → the
     * screen spot {x, y, visible} near what did it — "guns": that battery on the Rexmaw (its side from `side`, else
     * the bearing of `target` / x,z: port, starboard or the bow chasers); "hull"/"leak"/"fire": the damage station
     * on the side last hit (or nearest x,z when it's aboard); "water": the pumps; "brace": the helm; "reef": the
     * spot on the sea (or the lookout at the bow). `{world:true}` returns the world point (Vector3) instead.
     */
    popAnchor(p = {}, { world: wantWorld = false } = {}) {
      const out = new THREE.Vector3();
      popWorld(p || {}, out);
      if (wantWorld) return out;
      return api.screenPos(out);
    },

    /** A contact's world position (for audio panning), or null. */
    contactPos(id, out = new THREE.Vector3()) { return posOf(id, out); },

    /** Ship space → world (the crew module's figures ride R.shipSpace, so most never need it). */
    shipToWorld(x, y, z, out = new THREE.Vector3()) { return toWorld(x, y, z, out); },

    /**
     * A new night: lays out the bay (islands, shoals, the fort, wrecks, the cove, the maelstrom, the
     * storm), the harbour at world.port, the wind and the moon; resets every effect and the Rexmaw.
     */
    setWorld(w) {
      S.bay = w || null;
      S.hull = null; S.cargo = null; S.lastHitSide = 0; S.wrecked = false; S.wreck = 0; S.krakenSeen = false; S.waveCut = null; S.eye = null;
      S.turnRate = 0; S.accel = 0; S.heel = 0; S.pitch = 0; S.heave = 0; S.lurch = { heel: 0, pitch: 0, v: 0, vp: 0 };
      S.rexFires.length = 0; S.timers.length = 0; S.clock = 0; S.look = null; S.chase.settled = false;
      const port = w?.port || { x: 0, z: -40 };
      ship.placeHarbour(port.x, port.z);
      water.setHarbour(port.x, port.z);
      islands.setWorld(w);
      water.setIslands(w?.islands || []);
      life.setIslands(w?.islands || []);
      life.setFogBanks(Array.isArray(w?.fog) ? w.fog : []);
      maelstrom.setWorld(w);
      weather.setWorld(w);
      weather.reset();
      fleet.reset();
      pickups.reset();
      setpieces.reset();
      markers.reset();
      target.reset();
      seaEvents.reset();
      follow.recentre();
      shotsInFlight.reset();
      flames.reset();
      kraken.reset();
      fx.reset();
      helm.reset();
      wake.reset();
      ship.lanterns(1, 0.1);
      sky.setNight(0.05, { duration: 0 });
      water.setNight(0.05, { duration: 0 });
      water.setRipple(1, { duration: 0 });
      R.atmos.hazeK = 0;
      if (w?.wind) { S.wind = { dirDeg: +w.wind.dirDeg || 0, strength: +w.wind.strength || 0.7 }; water.setWind(S.wind.dirDeg, S.wind.strength); }
      sky.setMoon(18, 21);                      // north over the bay: its glitter path leads out of the harbour
      ship.pose(port.x, port.z, 0);
      S.heading = 0; S.lastX = port.x; S.lastZ = port.z;
      R.post.set({ grade: { phase: "harbour", sat: 0.95, vignette: 0.42 } }, { duration: 0.5 });
    },

    /** The harbour's pier, quay, shore and anchored ships (world), for the core's colliders. */
    harbourObstacles: () => harbourObstacles(S.bay?.port || { x: 0, z: -40 }),

    /**
     * Compile every material now (call behind the title, after R.start()): every pooled object is
     * shown for the compile, then put back.
     */
    async compile() {
      const warm = [kraken, helm, fleet, shotsInFlight, islands, maelstrom, weather, flames, fx, life, sails, overlays, pickups, setpieces, speedLines, markers, target, seaEvents];
      for (const m of warm) m.warmShow?.(true);
      const parts = fx.flareParts;
      const wasStar = parts.star.visible, wasCrates = parts.crates.count;
      parts.star.visible = true; parts.crates.count = Math.max(1, wasCrates);
      const culled = [];
      R.scene.traverse((o) => { if (o.frustumCulled && (o.isMesh || o.isPoints || o.isLine)) { culled.push(o); o.frustumCulled = false; } });
      try { await R.compile(); } finally {
        for (const o of culled) o.frustumCulled = true;
        for (const m of warm) m.warmShow?.(false);
        parts.star.visible = wasStar; parts.crates.count = wasCrates;
      }
    },

    /** Debug: what's in the bay. */
    stats() {
      return {
        fleet: fleet.stats(), islands: islands.stats(), shots: shotsInFlight.count, flames: flames.count, fx: fx.stats(), perf: R.perf(),
        shot: cam.current, cine: S.cine?.name ?? null, look: S.look, storm: weather.storminess, chase: follow.look,
        pose: { heel: S.heel, pitch: S.pitch, heave: S.heave },
        day: S.day, sails: sails.set, overlays: overlays.stats(), pickups: pickups.count, life: life.stats(), beams: setpieces.stats(), speedLines: speedLines.amount,
        markers: markers.stats(), zoom: follow.zoom, water: water.stats?.(), target: target.stats(), seaEvents: seaEvents.stats(),
      };
    },

    dispose() {
      unbindWheel?.();
      for (const m of [seaEvents, target, markers, speedLines, setpieces, pickups, overlays, sails, life, props, weather, maelstrom, islands, shotsInFlight, fleet, flames, kraken, wake, helm, ship, fx, water, sky]) m.dispose?.();
    },
  };

  // ---- Event handlers ----
  /** A contact's world position: a ship (fleet), or a fort tower (`cls:"tower"` contacts live in islands.js). */
  function posOf(id, out) { return fleet.positionOf(id, out) || islands.towerPos?.(id, out) || null; }
  /** The world point a crew contribution belongs to (see api.popAnchor). */
  function popWorld(p, out) {
    const kind = String(p.kind || "");
    const sideOf = () => {
      if (p.side === "port" || p.side === "starboard" || p.side === "bow") return p.side;
      const t = p.target != null ? posOf(p.target, _w) : (Number.isFinite(+p.x) ? _w.set(+p.x, WATER_Y, +p.z) : null);
      if (!t) return "port";
      const l = toLocal(t, _u);
      if (l.z > Math.abs(l.x) * 1.4 && l.z > 0) return "bow";
      return l.x >= 0 ? "port" : "starboard";
    };
    if (kind === "guns") {
      const side = sideOf();
      if (side === "bow") return toWorld(0, 3.4, 18.4, out);
      const g = B.GUNS[side];
      const m = g[Math.floor(g.length / 2)];
      return toWorld(m[0] * 1.08, m[1] + 2.6, m[2], out);
    }
    if (kind === "hull" || kind === "leak" || kind === "fire") {
      // Aboard (within the hull's reach): the spot itself; else the damage station on the side last hit.
      if (Number.isFinite(+p.x)) { const l = toLocal(_w.set(+p.x, WATER_Y + 2, +p.z), _u); if (Math.abs(l.x) < 7 && l.z > -15 && l.z < 22) return toWorld(clamp(l.x, -4.4, 4.4), 2.8, clamp(l.z, -11, 18), out); }
      const sp = STATIONS.damage?.[S.lastHitSide < 0 ? 3 : 2];
      return sp ? toWorld(sp.x * 1.25, 2.8, sp.z, out) : toWorld(0, 2.8, 6, out);
    }
    if (kind === "water") return toWorld(0, 3.2, B.PUMP.pos[2], out);
    if (kind === "brace") return toWorld(B.WHEEL.pos[0], B.WHEEL.pos[1] + 2, B.WHEEL.pos[2], out);
    if (kind === "reef") {
      if (Number.isFinite(+p.x)) return out.set(+p.x, WATER_Y + 4, +p.z);
      return toWorld(0, 5, 19, out);
    }
    if (Number.isFinite(+p.x)) return out.set(+p.x, WATER_Y + 4, +p.z);
    return toWorld(0, 6, 3, out);
  }
  /** A sink worth the cinematic: the core's `cinematic` flag; without one (older cores) the big classes and a prize. */
  function isCinematicSink(p) {
    if (typeof p.cinematic === "boolean") return p.cinematic;
    const c = (S.state?.contacts || []).find((x) => x.id === p.id);
    const kind = fleet.info(p.id)?.kind || "";
    return !!(c?.prize || c?.objective || /^(frigate|manowar|ironduke|gloam)$/.test(kind));
  }
  /** The run's `sea_event` {id, kind, stage, x, z, r, …}: telegraph rings, the arm's slam and its end, salvage glints. */
  function onSeaEvent(p) {
    seaEvents.event(p);
    const kind = String(p.kind || "");
    const stage = String(p.stage || "");
    // (A spout's or a wave's hit also comes as `hazard {kind: "spout"|"wave", stage: "hit"}`: onHazard shakes for those.)
    if (stage === "hit") {
      if (/kraken|arm/.test(kind)) { kraken.slam(p.id); R.cam.trauma(0.45); S.lurch.v += 10; }
    } else if (stage === "defeated" && /kraken|arm/.test(kind)) {
      kraken.hit(p.id);
    } else if (stage === "salvaged" && Number.isFinite(+p.x)) {
      for (let k = 0; k < 3; k++) after(k * 0.25, () => fx.burst(_w.set(+p.x + (Math.random() - 0.5) * 8, WATER_Y + 4 + Math.random() * 3, +p.z + (Math.random() - 0.5) * 8).clone(), { color: "#ffd27a", count: 30, speed: 2.5, size: 0.25, life: 1, intensity: 3.5 }));
    }
  }
  function closeTo(id, m) {
    const p = fleet.positionOf(id, _v);
    const sh = S.state?.ship;
    return !!(p && sh && Math.hypot(p.x - sh.x, p.z - sh.z) < m);
  }
  function weakPos(contactId, weakId) {
    const c = (S.state?.contacts || []).find((x) => x.id === contactId);
    const wp = c?.weakPoints?.find((x) => x.id === weakId);
    return wp ? fleet.localToWorld(contactId, new THREE.Vector3(+wp.local.x || 0, +wp.local.y || 0, +wp.local.z || 0)) : null;
  }

  function onVolley(p) {
    const by = p.by;
    const weapon = p.weapon || (p.ammo === "mortar" ? "mortar" : p.ammo === "barrels" ? "barrels" : null);
    if ((by === "rexmaw" || by == null) && weapon === "mortar") {
      // The deck mortar: a heavy thump upward, a ring of smoke, the bed kicks.
      const mz = props.mortarMuzzle(new THREE.Vector3()), dirM = props.mortarDir(new THREE.Vector3());
      const shells = clamp(+p.balls || 1, 1, 3);
      for (let i = 0; i < shells; i++) after(i * 0.45, () => { fx.muzzle(mz, dirM, { scale: 1.3, smoke: R.quality.smoke ?? 1 }); fx.smokeRing?.(mz, dirM, { scale: 1.4 }); props.recoil("mortar"); R.cam.trauma(0.22); S.lurch.vp -= 2.5; });
      R.cam.fovKick(-2);
      return;
    }
    if ((by === "rexmaw" || by == null) && weapon === "barrels") {
      // Fire barrels over the taffrail: three splashes astern (the core's `barrel` events light them).
      for (let i = 0; i < 3; i++) after(i * 0.3, () => fx.splash(toWorld((i - 1) * 2.4, 0, -16 - i * 2, new THREE.Vector3()).setY(WATER_Y), { scale: 0.9 }));
      return;
    }
    if (typeof by === "string" && by.startsWith("tower")) {
      const sh = S.state?.ship;
      islands.towerVolley?.(by.slice(by.indexOf(":") + 1), { balls: +p.balls || 0, target: sh ? { x: +sh.x, z: +sh.z } : null, mortar: p.ammo === "mortar" });
      return;
    }
    if (by === "rexmaw" || by == null) {
      const side = p.side === "starboard" ? "starboard" : p.side === "bow" ? "bow" : "port";
      const muzzles = B.GUNS[side];
      const n = clamp(+p.balls || muzzles.length, 1, muzzles.length);
      const step = muzzles.length / n;
      const sx = side === "port" ? 1 : side === "starboard" ? -1 : 0;
      for (let i = 0; i < n; i++) {
        const m = side === "bow" ? props.chaserMuzzle(new THREE.Vector3()) : null;
        const local = muzzles[Math.min(muzzles.length - 1, Math.floor(i * step))];
        after(i * (0.06 + Math.random() * 0.05), () => {
          const pos = m || toWorld(local[0], local[1], local[2], new THREE.Vector3());
          const out = R.shipSpace.localToWorld(new THREE.Vector3(sx, 0.04, sx ? 0 : 1)).sub(R.shipSpace.localToWorld(new THREE.Vector3(0, 0, 0))).normalize();
          fx.muzzle(pos, out, { scale: 1.05 * (p.ammo === "heavy" ? 1.3 : 1), smoke: R.quality.smoke ?? 1 });
          fx.smokeRing?.(pos, out, { scale: p.ammo === "heavy" ? 1.3 : 1 });
        });
      }
      props.recoil(side);
      R.cam.trauma(0.14 + 0.025 * n + (p.ammo === "heavy" ? 0.15 : 0));
      R.cam.fovKick(p.ammo === "heavy" ? -2.4 : -1.4);
      S.lurch.v += sx * -0.9 * Math.min(1, n / 6) * (p.ammo === "heavy" ? 1.6 : 1);
      // The side-cam only for a broadside the Captain didn't aim themself (the companion's guns, the crew's).
      const captains = p.firedBy === "captain" || p.by === "captain" || follow.state.aiming || follow.state.idle < 2.5;
      if (n >= 6 && side !== "bow" && !captains && cam.current === "chase" && cineReady("volley", 9)) shots.volley(side);
      return;
    }
    if (typeof by === "string" && by.startsWith("fort")) {
      const sh = S.state?.ship;
      islands.fortVolley({ balls: +p.balls || 0, target: sh ? { x: +sh.x, z: +sh.z } : null });
      return;
    }
    fleet.volley(by, p.side, { balls: +p.balls || 0, ammo: p.ammo });
  }

  function onImpact(p) {
    shotsInFlight.noteImpact(p.x, p.y, p.z);
    const kind = p.kind || "hull";
    if (kind === "explosion" || p.ammo === "fireship") {
      if (Number.isFinite(+p.x)) fx.explosion(new THREE.Vector3(+p.x, Number.isFinite(+p.y) ? +p.y : WATER_Y + 2, +p.z), { scale: 1.4 });
      if (p.target === "rexmaw") { R.cam.trauma(0.7); R.post.hitStop(80, 0.06); S.lurch.v += 20; ship.gutter(1.5); }
      return;
    }
    if (kind === "splash") { fx.splash(_v.set(+p.x || 0, WATER_Y, +p.z || 0), { scale: p.ammo === "heavy" ? 1.5 : 1 }); return; }
    if (p.target === "rexmaw") {
      const dmg = +p.dmg || 6;
      const braced = !!p.braced;
      const tr = clamp(0.18 + dmg * 0.03, 0.15, 0.75) * (braced ? 0.55 : 1);
      R.cam.trauma(tr);
      if (tr >= 0.4) { R.post.hitStop(60, 0.08); R.post.set({ ca: 0.5 }, { duration: 0.08 }); after(0.14, () => R.post.set({ ca: 0 }, { duration: 0.5 })); }
      const at = Number.isFinite(+p.x) ? _v.set(+p.x, Number.isFinite(+p.y) ? +p.y : WATER_Y + 2, +p.z) : toWorld(0, 1, 3, _v);
      const local = toLocal(at, _u);
      S.lastHitSide = p.side === "port" ? 1 : p.side === "starboard" ? -1 : local.x >= 0 ? 1 : -1;
      const lx = clamp(local.x, -4.3, 4.3), lz = clamp(local.z, -12, 19);
      const hull = toWorld(lx, clamp(local.y, 0.2, 3.5), lz, new THREE.Vector3());
      if (kind === "water") fx.sheet(hull, { count: 30, radius: 2.5 });
      else if (kind === "mast") { fx.splinters(toWorld(0, 9 + Math.random() * 8, Math.random() < 0.5 ? 8 : 16, new THREE.Vector3()), { count: 18, scale: 1 }); }
      else { fx.splinters(hull, { count: 16 + Math.round(dmg * 1.5), scale: 1.1 }); fx.sparks(hull, { count: 10, speed: 4 }); }
      S.lurch.v += -S.lastHitSide * 20 * tr;
      S.lurch.vp += (local.z > 8 ? 12 : 3) * tr;
      if (tr >= 0.45) ship.gutter(0.8);
      return;
    }
    // v5: our shot striking the Kraken's eye (`impact {target: "kraken_eye"}`): it squints, a burst of water, a hit marker.
    if (p.target === "kraken_eye") {
      const at = kraken.eyeTarget(new THREE.Vector3());
      kraken.pieceReact("hit");
      fx.splash(_v.set(at.x + (Math.random() - 0.5) * 8, WATER_Y, at.z + (Math.random() - 0.5) * 8), { scale: p.ammo === "mortar" ? 1.6 : 0.9 });
      if (p.ammo === "mortar") fx.explosion(at.clone(), { scale: 0.5 });
      overlays.hitMarker(at.x, at.y, at.z, { heavy: p.ammo !== "round", size: p.ammo !== "round" ? 1.3 : 1 });
      return;
    }
    // v4: our shot striking a sea event's Kraken arm (`impact {target: <eventId>}`): it flinches, teal sparks.
    if (p.target != null && !fleet.has(p.target) && kraken.armTarget(p.target, _w)) {
      kraken.hit(p.target);
      return;
    }
    if (!fleet.has(p.target) && islands.towerPos?.(p.target, _w)) {
      // A fort tower: stone chips and a puff of dust where it struck.
      const at = Number.isFinite(+p.x) ? new THREE.Vector3(+p.x, Number.isFinite(+p.y) ? +p.y : _w.y - 4, +p.z) : _w.clone();
      fx.splinters(at, { count: 16, scale: 1.2 });
      fx.sparks(at, { count: 12, speed: 4 });
      fx.ghostMist?.(at, { thick: false });
      if (p.ammo === "mortar") fx.explosion(at, { scale: 0.7 });
    } else fleet.impact(p.target, p, kind, +p.dmg || 6);
    // Our shot striking home: a hit marker (bigger for heavy shot and raking), a touch of shake when close.
    if ((p.from === "rexmaw" || p.by === "rexmaw" || p.ours) && Number.isFinite(+p.x) && p.target != null) {
      const heavy = p.ammo === "heavy" || p.raking || (+p.dmg || 0) >= 10;
      overlays.hitMarker(+p.x, Number.isFinite(+p.y) ? +p.y : WATER_Y + 2, +p.z, { heavy, size: heavy ? 1.3 : 1 });
      if (closeTo(p.target, 160)) R.cam.trauma(heavy ? 0.12 : 0.05);
    }
  }

  function onSwivel(p) {
    const muzzle = props.swivelMuzzle(new THREE.Vector3());
    // The Kraken's arms, a sea event's lone arm (targetId = weakId = the event id, v4), else a ship's weak point.
    // v5: the Kraken's eye (targetId = weakId = "kraken_eye"); the scene's hit reaction comes with its impact.
    const eyeShot = p.targetId === "kraken_eye";
    const arm = !eyeShot && (p.targetId === "kraken" || (!fleet.has(p.targetId) && kraken.armTarget(p.weakId, _u) != null));
    const to = eyeShot ? kraken.eyeTarget(new THREE.Vector3()) : arm ? kraken.armTarget(p.weakId, new THREE.Vector3()) : weakPos(p.targetId, p.weakId) || fleet.positionOf(p.targetId, new THREE.Vector3());
    if (!to) return;
    props.aimSwivel(to);
    fx.burst(muzzle, { color: "#ffcf8a", count: 18, speed: 4, size: 0.18, life: 0.25, intensity: 5, scale: 1, gravity: 0 });
    fx.trail(muzzle, to, Math.max(0.12, muzzle.distanceTo(to) / 260), { color: "#ffb04a", lift: 0.5, size: 0.08, intensity: 4, burst: false }).then(() => {
      if (p.hit) { fx.burst(to, { color: arm || eyeShot ? "#3ff3e0" : "#ffcf6b", count: 40, speed: 4, size: 0.3, life: 0.8, intensity: 4 }); fx.sparks(to, { count: 16, speed: 4 }); if (arm) kraken.hit(p.weakId); }
      else fx.splash(_v.set(to.x + (Math.random() - 0.5) * 4, WATER_Y, to.z + (Math.random() - 0.5) * 4), { scale: 0.35 });
    });
    R.cam.trauma(0.06);
  }

  function onHazard(p) {
    const k = p.kind, stage = p.stage;
    if (k === "wave" && (stage === "hit" || stage === "impact")) {
      R.cam.trauma(p.fine ? 0.35 : 0.75);
      fx.sheet(toWorld(0, 3, 14, _v), { count: 60, radius: 4 });
      fx.sheet(toWorld(0, 2.5, 4, _v), { count: 50, radius: 4 });
      S.lurch.vp += p.fine ? 6 : 14;
      S.lurch.v += (Math.random() < 0.5 ? -1 : 1) * (p.fine ? 4 : 18);
      ship.gutter(1.2);
    } else if (k === "spout" && (stage === "hit" || stage === "impact")) {
      R.cam.trauma(0.6);
      fx.sheet(toWorld(0, 4, 3, _v), { count: 60, radius: 5 });
      S.lurch.v += 16;
    } else if (k === "lightning" && Number.isFinite(+p.x) && (stage === "strike" || stage === "hit")) {
      weather.strike(+p.x, +p.z, { target: p.target, mast: p.mast });
    } else if (k === "kraken" && p.eye) {
      // v5 Kraken's Wake: the eye's beats (stepEye raises / sinks the piece from the state): ink and a big splash as it
      // breaks the surface and as it goes under, a roar on a wound.
      if (!Number.isFinite(+p.x)) return;
      const at = _v.set(+p.x, WATER_Y, +p.z);
      if (stage === "telegraph") { fx.bubbles(at.clone(), { seconds: 3, radius: 10 }); water.pulse?.({ x: at.x, z: at.z, color: "#3ff3e0", speed: 6 }); }
      else if (stage === "rise" || stage === "dive" || stage === "driven") {
        fx.splash(at.clone(), { scale: 3.2 });
        fx.foam(at.clone(), { radius: 16, life: 6 });
        for (let i = 0; i < 6; i++) fx.ghostMist(_w.set(at.x + (Math.random() - 0.5) * 26, WATER_Y + 0.4, at.z + (Math.random() - 0.5) * 26), { thick: true });
        if (stage !== "rise") fx.bubbles(at.clone(), { seconds: 2.5, radius: 9 });
      } else if (stage === "wound") { kraken.pieceReact("roar"); R.cam.trauma(0.3); }
    } else if (k === "kraken") {
      if (stage === "grab" || stage === "slam") { R.cam.trauma(0.4); kraken.slam(p.armId ?? p.id); }
    } else if (k === "ram" && stage === "telegraph") {
      // v5: a boss starts a ram run: a red ring of light from her (out of the fog too) and foam piling at her bow.
      const at = fleet.positionOf(p.id ?? p.by, new THREE.Vector3()) || (Number.isFinite(+p.x) ? new THREE.Vector3(+p.x, WATER_Y, +p.z) : null);
      if (at) { water.pulse?.({ x: at.x, z: at.z, color: "#ff4a3a", speed: 9, intensity: 1.4 }); fx.foam(at.setY(WATER_Y), { radius: 14, life: 4 }); }
    } else if (k === "shoal" || k === "island") {
      if (stage === "hit" || stage === "aground" || stage === "on") {
        R.cam.trauma(0.3);
        S.lurch.vp -= 6;
        ship.anchors.bow.getWorldPosition(_v);
        fx.foam(_v.setY(WATER_Y), { radius: 9, life: 4, alpha: 0.7 });
        fx.spray(_v.setY(WATER_Y + 0.4), { amount: 0.8 });
      }
    } else if (k === "mortar" && (stage === "impact" || stage === "hit")) {
      if (Number.isFinite(+p.x)) { fx.splash(_v.set(+p.x, WATER_Y, +p.z), { scale: 2.2 }); fx.explosion(_v.set(+p.x, WATER_Y + 0.5, +p.z), { scale: 0.6 }); }
      const sh = S.state?.ship;
      if (sh && Number.isFinite(+p.x)) { const d = Math.hypot(+p.x - sh.x, +p.z - sh.z); if (d < 90) R.cam.trauma(0.5 * (1 - d / 90) + 0.1); }
    }
  }

  /** Boarding: grappling lines thrown across (a few gold-lit trails), a burst of sparks on the enemy's rail. */
  function grapple(enemyId) {
    const e = fleet.positionOf(enemyId, new THREE.Vector3());
    if (!e) return;
    const loc = toLocal(e, new THREE.Vector3());
    const sx = loc.x >= 0 ? 1 : -1;
    for (let k = 0; k < 4; k++) {
      after(k * 0.18, () => {
        const from = toWorld(sx * 4, 2.2, 1 + k * 3, new THREE.Vector3());
        const to = e.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random(), (Math.random() - 0.5) * 10));
        fx.trail(from, to, 0.5, { color: "#d8b37a", lift: 4, size: 0.06, intensity: 1.6, burst: false });
      });
    }
  }

  function phaseChange(phase, prev) {
    S.phase = phase;
    if (!S.autoCamera) return;
    if (phase === "title" || phase === "moored" || phase === "briefing") { if (cam.current !== "title") shots.title({ cut: true }); }
    else if (phase === "sailing" && (prev === "moored" || prev === "briefing")) shots.castOff();
    else if (phase === "results" && cam.current !== "arrival" && cam.current !== "wreck") shots.arrival();
  }

  /** v4: the fleet's view of the state: a derelict event's listed ship flagged derelict, stand-in hulls added. */
  function fleetState(st) {
    const extra = seaEvents.contacts;
    const list = Array.isArray(st.contacts) ? st.contacts : [];
    const flag = list.some((c) => !c.derelict && seaEvents.isDerelict(c.id));
    if (!extra.length && !flag) return st;
    return { ...st, contacts: [...(flag ? list.map((c) => (!c.derelict && seaEvents.isDerelict(c.id) ? { ...c, derelict: true } : c)) : list), ...extra] };
  }
  /** v4: the weather's view: a spout event's funnels drawn by seaevents (their hazards.spouts mirrors dropped). */
  function weatherState(st) {
    const sp = st.hazards?.spouts;
    if (!Array.isArray(sp) || !sp.length || !sp.some((s) => seaEvents.ownsSpout(s))) return st;
    return { ...st, hazards: { ...st.hazards, spouts: sp.filter((s) => !seaEvents.ownsSpout(s)) } };
  }

  /** Merge run.pose() over run.state(): the ship and the contacts at this frame's interpolated pose. */
  function mergePose(state, ps) {
    if (!ps) return state;
    const out = { ...state };
    if (ps.ship && state.ship) out.ship = { ...state.ship, ...ps.ship };
    else if (ps.ship) out.ship = { ...ps.ship };
    const pc = ps.contacts;
    if (pc && Array.isArray(state.contacts)) out.contacts = state.contacts.map((c) => (pc[c.id] ? { ...c, ...pc[c.id] } : c));
    return out;
  }

  api.anchors.lanternBeam = (() => { const o = new THREE.Object3D(); o.position.set(0, 4.35, 18.2); R.shipSpace.add(o); return o; })();
  if (bay) api.setWorld(bay);
  else { api.setWorld({ port: { x: 0, z: -40, r: 140 }, islands: [], wrecks: [], wind: { dirDeg: 200, strength: 0.7 } }); }
  cam.shot("title", { cut: true });
  return api;
}
