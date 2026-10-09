// Night Raid (from Night Helm): the camera's language (from Starboard's camera.js).
//
// The camera rides in `R.shipSpace` (so it sails, turns and heels with the
// Rexmaw) and moves between named shots (blocking.js `SHOTS`). Position,
// aim, up and field of view each follow a critically damped spring (ω = 4 by
// default, or tuned so a move lands in the duration asked for): nothing
// overshoots, nothing pops. On top of the spring sit the small things that
// make it feel held by a person: trauma shake (Perlin, shake = trauma²), the
// FOV kick, and a sustained FOV offset (full sail widens the view a touch).
//
// New for a ship under way:
//   stabilize   a shot keeps that share (0..1) of the horizon level while the
//               ship pitches and heels; shots not `aboard` keep their position
//               level too (a camera boat, not a camera bolted to the rail)
//   world       a shot's pos/target given in world space (a tentacle, the
//               destination lantern), re-read every frame
//   orbit       circles a ship-space centre (the arrival)
//   crane once  a one-way move (cast-off, the wreck)
//
// Reduced motion: no shake or hit-stop; a move that would spring for longer
// than 1.5 s cuts instead.

import * as THREE from "three";
import { SHOTS, B } from "./blocking.js";

const DEG = Math.PI / 180;
const OMEGA = 4;                // spring stiffness (rad/s)
const SETTLE = 6.6;             // ω·t at which a critically damped spring is within 1%
const SHAKE = { pos: 0.14, rot: 1.4 * DEG, decay: 0.8, freq: 9 };
const KICK = { in: 0.2, out: 0.55 };

/** One step of a critically damped spring, exact for any dt. Mutates and returns `s`. */
function springStep(s, target, omega, dt) {
  const y = s.x - target;
  const e = Math.exp(-omega * dt);
  const k = s.v + omega * y;
  s.x = target + (y + k * dt) * e;
  s.v = (s.v - k * omega * dt) * e;
  return s;
}

const AXES = ["x", "y", "z"];

/** A Vector3 spring: three scalar springs sharing ω. */
function springVec(pos, vel, target, omega, dt) {
  const e = Math.exp(-omega * dt);
  for (const a of AXES) {
    const y = pos[a] - target[a];
    const k = vel[a] + omega * y;
    pos[a] = target[a] + (y + k * dt) * e;
    vel[a] = (vel[a] - k * omega * dt) * e;
  }
}

/** 1D gradient noise in [-1, 1], smooth; `seed` picks the channel. */
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i;
  const g = (n) => { const h = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453; return (h - Math.floor(h)) * 2 - 1; };
  const u = f * f * (3 - 2 * f);
  return 2 * ((1 - u) * g(i) * f + u * g(i + 1) * (f - 1));
}

const easeInOutSine = (x) => -(Math.cos(Math.PI * THREE.MathUtils.clamp(x, 0, 1)) - 1) / 2;
const easeOutCubic = (x) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);

/**
 * Build the camera rig on R (renderer.js does this; everyone else uses R.cam).
 * @param {object} R  the render context: camera, shipSpace, size, motion, post, renderer
 */
export function createCameraRig(R) {
  const camera = R.camera;

  // The sprung state (ship space).
  const pos = new THREE.Vector3(), posV = new THREE.Vector3();
  const look = new THREE.Vector3(0, 0, 1), lookV = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), upV = new THREE.Vector3();
  const fov = { x: 60, v: 0 }, focus = { x: 10, v: 0 }, shift = { x: 0, v: 0 }, extra = { x: 0, v: 0 };
  let shiftApplied = 0, extraTarget = 0;

  // The goal, re-resolved every frame (shots follow moving things).
  const gPos = new THREE.Vector3(), gLook = new THREE.Vector3(), gUp = new THREE.Vector3(), gTarget = new THREE.Vector3();
  let gFov = 60, gFocus = 10, gShift = 0;

  let shotName = null, shotOpts = {}, omega = OMEGA, pending = null, cutNext = false;
  const shotDefaults = {};          // Night Raid: per-shot live options (the chase's auto-framing, the spyglass's aim)
  let craneT = 0, shotT0 = 0;
  let trauma = 0, shakeT = 0;
  let kick = null;
  let chaseBack = "chase";          // Night Raid sails in the third-person chase by default (C: the helm view)

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ");
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  const _shipQ = new THREE.Quaternion(), _yawQ = new THREE.Quaternion(), _corr = new THREE.Quaternion(), _id = new THREE.Quaternion();
  const PIVOT = new THREE.Vector3().fromArray(B.PIVOT);
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();

  const reduced = () => R.motion === "reduced";

  /** A shot value (array, Vector3, or a function returning either) as a Vector3 in ship space. */
  function asVec(v, out, world) {
    const x = typeof v === "function" ? v() : v;
    if (!x) return out.set(0, 0, 0);
    if (Array.isArray(x)) out.fromArray(x); else out.copy(x);
    if (world && R.shipSpace) R.shipSpace.worldToLocal(out);
    return out;
  }

  /** Resolve the current shot into the goal vectors. */
  function resolveGoal() {
    const s = SHOTS[shotName] || SHOTS.helm;
    const o = shotOpts;
    const world = !!(o.world ?? s.world);
    R.shipSpace?.updateMatrixWorld();

    // Position.
    if (o.pos) asVec(o.pos, gPos, world);
    else if (s.orbit) {
      const ob = s.orbit, a = (ob.start || 0) + (ob.speed || 0.1) * (R.time - shotT0) * (reduced() ? 0.4 : 1);
      gPos.fromArray(ob.center).add(_a.set(Math.sin(a) * ob.radius, ob.height, Math.cos(a) * ob.radius));
    } else if (s.crane) {
      const k = reduced() ? (s.once ? 1 : 0.6)
        : s.once ? easeInOutSine(craneT / s.crane) : easeInOutSine(1 - Math.abs(((craneT / s.crane) % 2) - 1));
      gPos.fromArray(s.pos).lerp(_a.fromArray(s.to), k);
    } else gPos.fromArray(s.pos);

    // Aim.
    if (o.target) asVec(o.target, gTarget, world);
    else if (Array.isArray(s.target) || typeof s.target === "function") asVec(s.target, gTarget, false);
    else gTarget.set(gPos.x, gPos.y, gPos.z + 100);
    gLook.subVectors(gTarget, gPos);
    gFocus = Number.isFinite(o.focus) ? o.focus : Number.isFinite(s.focus) ? s.focus : gLook.length();
    if (gLook.lengthSq() < 1e-8) gLook.set(0, 0, 1);
    gLook.normalize();
    gUp.fromArray(s.up || [0, 1, 0]);

    // Horizon stabilisation: blend from ship space toward the yaw-only frame.
    const k = THREE.MathUtils.clamp(o.stabilize ?? s.stabilize ?? 0, 0, 1);
    if (k > 0 && R.shipSpace) {
      _shipQ.copy(R.shipSpace.quaternion);
      _e.setFromQuaternion(_shipQ, "YXZ");
      _yawQ.setFromAxisAngle(_a.set(0, 1, 0), _e.y);
      _corr.copy(_shipQ).invert().multiply(_yawQ);
      _corr.slerpQuaternions(_id, _corr, k);
      gLook.applyQuaternion(_corr);
      gUp.applyQuaternion(_corr);
      if (!(o.aboard ?? s.aboard ?? (shotName === "helm" || shotName === "companion" || shotName === "kraken" || shotName === "krakenEye"))) {
        gPos.sub(PIVOT).applyQuaternion(_corr).add(PIVOT);
      }
    }

    gFov = o.fov ?? s.fov ?? 60;
    gShift = Number.isFinite(o.shiftY) ? o.shiftY : (s.shiftY || 0);
  }

  function snap() {
    pos.copy(gPos); posV.set(0, 0, 0);
    look.copy(gLook); lookV.set(0, 0, 0);
    up.copy(gUp); upV.set(0, 0, 0);
    fov.x = gFov; fov.v = 0; focus.x = gFocus; focus.v = 0;
    shift.x = gShift; shift.v = 0;
  }

  function settled() {
    return pos.distanceToSquared(gPos) < 1e-4 && look.angleTo(gLook) < 0.0015 && Math.abs(fov.x - gFov) < 0.08
      && posV.lengthSq() < 1e-4 && lookV.lengthSq() < 1e-5;
  }

  function finish(ok) {
    const p = pending;
    pending = null;
    p?.resolve(ok);
  }

  /** Per frame: springs, then the layers on top, then the camera itself. */
  function update(dt) {
    const s = SHOTS[shotName] || SHOTS.helm;
    if (s.crane) craneT += dt;

    resolveGoal();
    if (cutNext) { snap(); cutNext = false; }
    else if (dt > 0) {
      // Rexmaw Raids: a held follow shot (the chase) tightens its spring once it has arrived, so the
      // free look answers the mouse at once while the cut into it still eases.
      const om = !pending && Number.isFinite(shotOpts.omegaHold) ? shotOpts.omegaHold : omega;
      springVec(pos, posV, gPos, om, dt);
      springVec(look, lookV, gLook, Math.max(om, omega), dt);
      look.normalize();
      springVec(up, upV, gUp, om, dt);
      up.normalize();
      springStep(fov, gFov, om, dt);
      springStep(focus, gFocus, omega, dt);
      springStep(shift, gShift, omega, dt);
      springStep(extra, extraTarget, 1.6, dt);
    }
    if (pending && (settled() || R.time - pending.t0 > pending.limit)) finish(true);

    // Trauma shake: Perlin on six channels, shake = trauma².
    let sh = 0;
    if (trauma > 0) {
      trauma = Math.max(0, trauma - SHAKE.decay * dt);
      shakeT += dt * SHAKE.freq;
      sh = reduced() ? 0 : trauma * trauma;
    }

    // The FOV kick: in over 0.2 s, back out over ~0.55 s.
    let kickDeg = 0;
    if (kick) {
      const t = R.time - kick.t0;
      kickDeg = t < KICK.in ? kick.deg * easeOutCubic(t / KICK.in) : kick.deg * (1 - easeInOutSine((t - KICK.in) / KICK.out));
      if (t > KICK.in + KICK.out) kick = null;
    }

    camera.position.copy(pos);
    if (sh > 0) {
      camera.position.x += SHAKE.pos * sh * noise1(shakeT, 1);
      camera.position.y += SHAKE.pos * sh * noise1(shakeT, 2);
      camera.position.z += SHAKE.pos * sh * noise1(shakeT, 3);
    }
    _a.addVectors(pos, look);
    _m.lookAt(pos, _a, up);
    camera.quaternion.setFromRotationMatrix(_m);
    if (sh > 0) {
      _e.set(SHAKE.rot * sh * noise1(shakeT, 4), SHAKE.rot * sh * noise1(shakeT, 5), SHAKE.rot * sh * noise1(shakeT, 6) * 0.6);
      camera.quaternion.multiply(_q.setFromEuler(_e));
      _e.set(0, 0, 0, "YXZ");
    }
    const f = THREE.MathUtils.clamp(fov.x + kickDeg + extra.x, 5, 110);
    const ls = Math.abs(shift.x) > 1e-4 ? shift.x : 0;
    if (Math.abs(camera.fov - f) > 1e-4 || Math.abs(camera.aspect - R.size.aspect) > 1e-6 || Math.abs(ls - shiftApplied) > 1e-5) {
      camera.fov = f;
      camera.aspect = R.size.aspect;
      const W = Math.max(1, R.size.w || 1), H = Math.max(1, R.size.h || 1);
      if (ls) camera.setViewOffset(W, H, 0, -ls * H, W, H);
      else camera.clearViewOffset();
      shiftApplied = ls;
      camera.updateProjectionMatrix();
    }
  }

  const el = R.renderer.domElement;

  /**
   * @typedef {object} ShotOpts
   * @property {number} [duration]   seconds to land in (tunes the spring); a cut when 0
   * @property {boolean} [cut]       jump there this frame
   * @property {number[]|THREE.Vector3|(() => THREE.Vector3|number[])} [target]  aim here instead
   * @property {number[]|THREE.Vector3|(() => THREE.Vector3|number[])} [pos]     stand here instead
   * @property {boolean} [world]     pos/target are world space (re-read every frame)
   * @property {boolean} [aboard]    keep the position bolted to the deck under stabilisation
   * @property {number} [stabilize]  0..1, instead of the shot's own
   * @property {number} [fov]        degrees, instead of the shot's own
   * @property {number} [shiftY]     vertical lens shift (fraction of the frame)
   * @property {number} [focus]      depth-of-field distance (m)
   */

  const cam = {
    /**
     * Move to a named shot. Resolves true once settled, false when another
     * shot interrupts it first. Unknown names resolve false at once.
     * @param {string} name
     * @param {ShotOpts} [opts]
     * @returns {Promise<boolean>}
     */
    shot(name, opts = {}) {
      if (!SHOTS[name]) { console.debug(`[night-raid] camera: no shot "${name}"`); return Promise.resolve(false); }
      finish(false);
      const first = shotName === null;
      if (name === "helm" || name === "chase") chaseBack = name;
      shotName = name;
      shotOpts = { ...(shotDefaults[name] || {}), ...(opts || {}) };
      craneT = 0;
      shotT0 = R.time;
      const dur = Number.isFinite(opts.duration) ? opts.duration : SETTLE / OMEGA;
      omega = THREE.MathUtils.clamp(SETTLE / Math.max(0.05, dur), 0.8, 40);
      const cut = first || opts.cut || dur <= 0 || (reduced() && dur > 1.5);
      if (cut) cutNext = true;
      return new Promise((resolve) => {
        pending = { resolve, t0: R.time, limit: cut ? 0 : dur + 0.35 };
      });
    },

    /** The shot being held or moved to. */
    get current() { return shotName; },

    /** Night Raid: options every call of shot `name` starts from (live pos/target functions). */
    setDefaults(name, opts) { if (opts) shotDefaults[name] = opts; else delete shotDefaults[name]; },

    /** The sailing view the Captain picked last ("helm" or "chase"): cinematics cut back to it. */
    get sailingView() { return chaseBack; },

    /** C: swap between the helm view and the chase view (a quick 0.5 s move). */
    toggleChase() { return cam.shot(chaseBack === "helm" ? "chase" : "helm", { duration: 0.5 }); },

    /** Back to the Captain's sailing view, fast (after a cinematic): a cut by default. */
    back({ duration = 0 } = {}) { return cam.shot(chaseBack, { duration, cut: duration <= 0 }); },

    /** The sprung distance to what the shot looks at (m): depth of field's "auto" focus. */
    get focus() { return focus.x; },

    /** Add trauma (0..1): the shake is trauma², decaying linearly at 0.8/s. @param {number} a */
    trauma(a) { trauma = THREE.MathUtils.clamp(trauma + (+a || 0), 0, 1); },

    /** Kick the field of view by `deg` (in over 0.2 s, then back). @param {number} [deg=-3] */
    fovKick(deg = -3) { kick = { deg, t0: R.time }; },

    /** A sustained FOV offset (degrees) the view eases to (full sail: +3). @param {number} deg */
    fovOffset(deg) { extraTarget = reduced() ? 0 : THREE.MathUtils.clamp(+deg || 0, -20, 20); },

    /** Hit-stop (the post chain owns time; this is a shortcut). @param {number} [ms] @param {number} [scale] */
    hitStop(ms, scale) { R.post?.hitStop(ms, scale); },

    /** Letterbox bars in or out (a cinematic). @param {boolean} on */
    letterbox(on) { R.post?.set({ letterbox: on ? 1 : 0 }); },

    /**
     * A raycaster through a pointer event (or {x, y} in NDC). It tests every
     * layer; its `.ray` is in world space.
     * @param {{clientX: number, clientY: number}|{x: number, y: number}} event
     */
    ray(event) {
      let x = event?.x, y = event?.y;
      if (Number.isFinite(event?.clientX)) {
        const r = el.getBoundingClientRect();
        x = ((event.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
        y = -(((event.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
      }
      camera.updateMatrixWorld();
      raycaster.setFromCamera(new THREE.Vector2(x || 0, y || 0), camera);
      return raycaster;
    },

    /** Debug: the rig's state. */
    state() {
      return { shot: shotName, pos: pos.toArray(), look: look.toArray(), fov: fov.x, extraFov: extra.x, focus: focus.x, trauma };
    },

    /** @internal Per frame, after every other onFrame listener. */
    update,

    dispose() { finish(false); },
  };

  cam.shot("title");
  resolveGoal();
  snap();
  return cam;
}
