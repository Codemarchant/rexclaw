// Night Raid: one figure on the Rexmaw's deck (a crew member or the first mate).
//
// Their real VRM (or the paper standee while it loads, and for good when it
// can't) stands in ship space and lives a small life there:
//
//   walking    a station change walks them over the deck walk graph (turn in
//              place first when the way lies behind them, then the walk clip
//              sped to the pace with the root sliding along the path, the
//              stairs a little slower, a jog when there's a fight on), then
//              they turn to face the work.
//   working    each station's work loop, as two-bone IK over the idle with a
//              lean and a hand prop: load / ram / run out the guns (paced by
//              the battery's reload), the pump, hauling a line, the spyglass,
//              carrying powder from the hatch to the guns, patching with a
//              mallet, buckets on a fire, stirring the galley pot and carrying
//              tea, the cutlass at the ready for boarding (and hacking at the
//              Kraken), the first mate's stance on the quarterdeck.
//   reacting   a brace on a heavy hit (the work lets go meanwhile), a flinch
//              and a step back when a shot lands close, a cheer on a sinking or
//              a capture, a recoil jolt at the guns on a volley, a talk gesture
//              when they speak, a point when the first mate gives an order.
//   overboard  swept: dragged to the rail, over it and down into the sea,
//              treading water alongside with an arm up; rescued: a line from the
//              rail, hauled up hand over hand and over the bulwark onto the
//              deck, a "made it"; lost: they go under.
//   idling     a personality stance (Rex's mission-control arms-crossed, Leo's
//              hands-behind-the-back watch, Sal's watchful lean, Eve's
//              finger-to-chin fidgets over the charts, Ara's calm clasped hands)
//              with fidgets of their own.
//
// The eyes and head follow a look target every frame: their battery's target
// for a gunner, the marked or nearest contact for the lookout and anyone at
// leisure, the way ahead when walking, a hit when one lands, now and then the
// Captain. Lip-sync runs from any playing <audio> handed to speak().
//
// LOD: spring bones only within the quality's distance of the camera (60 m
// at High), and a far or off-screen figure animates every third frame.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { VRMUtils } from "@pixiv/three-vrm";
import { createMotions } from "./motions.js";
import { createLipSync } from "./lipsync.js";
import { createStandee } from "./standee.js";
import { loadVrm, setOutlines } from "./vrm.js";
import { createHandProps } from "./props.js";
import { route, railAt } from "./deck.js";
import { armIK, armSign, rotateInSpace, findExpression, EXPRESSIONS, VISEMES, clamp, deg, damp, wrapAngle, finite3, UP } from "./rig.js";

const WATER_Y = -2.2;                 // the sea in ship space (blocking.js WATER_Y; heave rides the frame)
const VRM_TIMEOUT_MS = 60000;
const YAW_OMEGA = 3.2;
const LOOK = { yawMax: deg(65), pitchUp: deg(30), pitchDown: deg(40), neckShare: 0.38, eyeRate: 8 };
const WALK_CLIP_SPEED = 1.35;         // m/s the walking clip covers at rate 1
const PACE = { calm: 1.55, battle: 2.5, stairs: 0.75 };   // m/s; stairs as a share of the deck pace
const CONTACT_SHADOW = { size: 1.0, opacity: 0.42 };

/** The work each task does: rhythm (Hz), whether strokes send a beat, and its loop. */
const TASKS = {
  gun: { hz: 0, beat: false }, pump: { hz: 1.1, beat: true }, haul: { hz: 1.2, beat: true }, spyglass: { hz: 0, beat: false },
  carry: { hz: 0, beat: false, shuttle: "keg" }, patch: { hz: 2.2, beat: true }, douse: { hz: 0.55, beat: true },
  cook: { hz: 0.5, beat: false }, serve: { hz: 0, beat: false, shuttle: "tray" }, cutlass: { hz: 0, beat: false },
  repel: { hz: 1.1, beat: true }, command: { hz: 0, beat: false }, idle: { hz: 0, beat: false },
};
/** A station's default task, and what the state's task words mean. */
export const STATION_TASK = {
  guns_port: "gun", guns_starboard: "gun", bow_chaser: "gun", mortar: "gun", sails: "haul", damage: "patch", pumps: "pump", lookout: "spyglass",
  powder: "carry", boarding: "cutlass", galley: "cook", quarterdeck: "command", repel: "repel",
};
const TASK_WORDS = {
  load: "gun", ram: "gun", run_out: "gun", runout: "gun", reload: "gun", aim: "gun", fire: "gun", guns: "gun", gun: "gun",
  pump: "pump", pumps: "pump", bail: "pump", haul: "haul", sails: "haul", trim: "haul", lines: "haul",
  spyglass: "spyglass", lookout: "spyglass", watch: "spyglass", carry: "carry", powder: "carry", carry_powder: "carry",
  patch: "patch", repair: "patch", hammer: "patch", leak: "patch", leaks: "patch", douse: "douse", fire_fight: "douse", fires: "douse", bucket: "douse",
  cook: "cook", galley: "cook", serve: "serve", tea: "serve", serve_tea: "serve", board: "cutlass", boarding: "cutlass", cutlass: "cutlass",
  ready: null, repel: "repel", kraken: "repel", command: "command", orders: "command", idle: "idle", rest: "idle",
  // core/crew.js taskOf() words
  fight_fire: "douse", repair_mast: "patch", ready_arms: "cutlass", grabbed: "repel",
};
/** core's "stand_by" (nothing to do there right now): the gunners stay at the ready, everyone else waits at the spot. */
const STAND_BY = { guns_port: "gun", guns_starboard: "gun", bow_chaser: "gun", mortar: "gun", lookout: "spyglass", quarterdeck: "command", boarding: "cutlass" };
/** Which battery a gun station serves (core `batteries[side]`: loaded / target). */
const SIDE_OF = { guns_port: "port", guns_starboard: "starboard", bow_chaser: "bow", mortar: "mortar" };

/** The face that goes with a reaction: [emotion, weight, hold seconds]. */
const FACE = {
  brace: ["surprised", 0.8, 1.3], flinch: ["surprised", 0.95, 1.1], hurrah: ["happy", 0.9, 2.6], flail: ["surprised", 1, 3],
  madeit: ["relaxed", 0.7, 2.6], sad: ["sad", 0.7, 3], scared: ["surprised", 0.85, 2], order: ["angry", 0.25, 1.4], talk: ["happy", 0.25, 1.6],
};

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _f = new THREE.Vector3(), _g = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qn = new THREE.Quaternion(), _qy = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);

function makeContactShadow(layer) {
  const N = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const g = canvas.getContext("2d");
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, "rgba(0,0,0,1)"); grad.addColorStop(0.45, "rgba(0,0,0,0.55)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CONTACT_SHADOW.size, CONTACT_SHADOW.size), new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, opacity: CONTACT_SHADOW.opacity, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  mesh.name = "crew-contact-shadow";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.layers.set(layer);
  mesh.renderOrder = 1;
  return { mesh, dispose() { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); map.dispose(); } };
}

/** The name tag: a small gilt plate over the head, shown on hover. */
function makeNameTag(name, role) {
  const el = document.createElement("div");
  el.className = "nr-crew-tag";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    pointerEvents: "none", padding: "3px 10px 4px", borderRadius: "999px", whiteSpace: "nowrap", textAlign: "center",
    font: "italic 700 13px/1.15 Georgia, 'Times New Roman', serif", color: "#ffe7a6", letterSpacing: ".02em",
    background: "linear-gradient(180deg, rgba(20,30,58,.92), rgba(6,10,24,.9))", border: "1px solid rgba(255,207,107,.55)",
    boxShadow: "0 2px 10px rgba(0,0,0,.45)", opacity: "0", transform: "translateY(4px)", transition: "opacity .18s ease, transform .18s ease",
  });
  const b = document.createElement("b"); b.textContent = name; b.style.fontWeight = "800";
  const s = document.createElement("span");
  s.textContent = role ? ` · ${role}` : "";
  Object.assign(s.style, { fontWeight: "400", fontStyle: "normal", fontSize: "11px", color: "rgba(243,230,200,.75)" });
  el.append(b, s);
  const object = new CSS2DObject(el);
  object.center.set(0.5, 1);
  object.visible = false;
  let on = false, timer = 0;
  return {
    object,
    show(v) {
      v = !!v;
      if (v === on) return;
      on = v;
      clearTimeout(timer);
      if (v) { object.visible = true; requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; }); }
      else { el.style.opacity = "0"; el.style.transform = "translateY(4px)"; timer = setTimeout(() => { if (!on) object.visible = false; }, 220); }
    },
    dispose() { clearTimeout(timer); object.removeFromParent(); el.remove(); },
  };
}

/**
 * One figure on deck.
 * @param {object} C  the crew's shared context: R, layer, parent, graph, emit(type, payload), frame (per-frame facts), fixtureFor(spot)
 * @param {{id: string, name: string, role: string, urls: object, isCompanion: boolean}} cast
 */
export function createMember(C, cast) {
  const { R, layer } = C;
  const id = cast.id;
  const root = new THREE.Group();
  root.name = `crew-${id}`;
  const pose = new THREE.Group();          // tilt / tumble / bob, under the root's yaw
  pose.name = `crew-${id}-pose`;
  root.add(pose);
  C.parent?.add(root);
  root.visible = false;                      // until a body is up
  const lookProxy = new THREE.Object3D();
  lookProxy.name = `crew-${id}-look`;
  R?.scene?.add(lookProxy);
  const lookAnchor = new THREE.Object3D();   // a look target that rides the ship
  (C.parent || R?.scene)?.add(lookAnchor);
  const lip = createLipSync();
  const props = createHandProps(layer);
  for (const o of props.all) R?.scene?.add(o);
  const shadow = makeContactShadow(layer);
  root.add(shadow.mesh);
  const tag = makeNameTag(cast.name, cast.role);
  root.add(tag.object);

  let disposed = false;
  let V = null, standee = null, standeePromise = null, shown = null, wantKind = "vrm", vrmPromise = null;
  let loadInfo = { ok: false, bytes: 0, ms: 0, url: cast.urls?.vrmUrl || null, error: null };
  let outlines = true;

  // Behaviour.
  let t = Math.random() * 10;
  let yaw = 0, yawVel = 0, bodyYaw = 0;
  let mode = "idle";                         // idle | walk | work | overboard
  let want = null;                           // {station, task, spot, key, side}
  let walk = null;                           // {path, seg, along, turning, then}
  let work = null;                           // {task, t, cycle, spot, side, shuttle?}
  let workW = 0;
  let pauseUntil = 0;                        // reactions: the work lets go until then
  let kick = 0;                              // recoil jolt at the guns
  const step = new THREE.Vector3();          // a flinch's step away (ship space), springs back
  let ob = null;                             // overboard {phase, t, side, from, x, z, ...}
  let lookMode = null, lookUntil = 0;        // an explicit look (Vector3 world / Object3D / "captain")
  let auto = { what: "ahead", until: 0 };
  const lookDir = new THREE.Vector3(0, 0, 1);
  let saccade = new THREE.Vector2(), saccadeT = 0;
  let lookWeight = 1, lookWeightTarget = 1;
  let fidgetT = 6 + Math.random() * 10;
  let loopTag = undefined;                   // the motions loop we last asked for
  let lodAcc = 0, lodTick = 0, springsOn = true;
  let hovered = false;
  let drive = null;                          // a driver that owns the body for a while (fight.js): {step(dt, H), pose(st, dt, H)}
  const stanceTag = `stance_${C.personality?.(id) || (id === "me" ? "me" : id)}`;
  const fidgetTag = `fidget_${C.personality?.(id) || (id === "me" ? "me" : id)}`;

  // ---- Bodies ---------------------------------------------------------------------------------

  function ensureStandee() {
    if (!standeePromise) {
      standee = createStandee(R, { fullbodyUrl: cast.urls?.fullbodyUrl, portraitUrl: cast.urls?.portraitUrl, name: cast.name, layer });
      pose.add(standee.group);
      standeePromise = standee.ready.then(() => standee);
    }
    return standeePromise;
  }

  async function showStandee() {
    const s = await ensureStandee();
    if (disposed) return;
    if (V) V.holder.visible = false;
    shown = "standee";
    root.visible = !ob || ob.phase !== "gone";
    await s.show(true);
  }

  function showVrm() {
    if (!V || disposed) return;
    V.holder.visible = true;
    shown = "vrm";
    root.visible = !ob || ob.phase !== "gone";
    root.updateMatrixWorld(true);
    try { V.vrm.springBoneManager?.reset(); } catch { /* */ }
    if (standee) standee.show(false, { instant: true });
    loopTag = undefined;                     // re-ask for the right loop on the new body
  }

  function setupVrm(vrm, holder) {
    const bone = (name) => vrm.humanoid?.getNormalizedBoneNode?.(name) || null;
    const exp = vrm.expressionManager;
    const names = {};
    for (const [k, aliases] of Object.entries({ ...EXPRESSIONS, ...VISEMES })) names[k] = findExpression(exp, aliases);
    const fwd = vrm.lookAt?.faceFront?.clone().normalize() || new THREE.Vector3(0, 0, vrm.meta?.metaVersion === "0" ? -1 : 1);
    const st = {
      vrm, holder,
      motions: createMotions({ vrm, idleUrl: cast.urls?.idleUrl || null }),
      hips: bone("hips"), neck: bone("neck"), headBone: bone("head"),
      chest: bone("upperChest") || bone("chest"), spine: bone("spine"),
      lArm: bone("leftUpperArm"), rArm: bone("rightUpperArm"), lLow: bone("leftLowerArm"), rLow: bone("rightLowerArm"),
      lHand: bone("leftHand"), rHand: bone("rightHand"),
      hipsBase: bone("hips")?.position.clone() || null,
      fwd, left: new THREE.Vector3().crossVectors(UP, fwd).normalize(),
      names, emo: {}, emoTarget: {}, emoHold: {},
      blinkIn: 2 + Math.random() * 3, blinkPhase: -1, yaw: 0, pitch: 0, saved: new Map(), armSign: 0,
    };
    for (const b of [st.neck, st.headBone]) if (b) st.saved.set(b, b.quaternion.clone());
    if (vrm.lookAt) vrm.lookAt.target = lookProxy;
    return st;
  }

  /**
   * Load the VRM (the crew module calls these one after another behind the title).
   * @param {(fraction: number) => void} [onProgress]
   * @returns {Promise<{ok: boolean, bytes: number, ms: number, url: string|null, error: string|null}>}
   */
  async function load(onProgress = null) {
    const t0 = performance.now();
    if (!cast.urls?.vrmUrl) {
      loadInfo = { ok: false, bytes: 0, ms: 0, url: null, error: "no VRM" };
      await showStandee();
      return loadInfo;
    }
    if (!shown) showStandee();               // the paper figure stands in meanwhile
    vrmPromise = (async () => {
      const { vrm, holder, top, half, bytes } = await loadVrm(cast.urls.vrmUrl, layer, onProgress);
      if (disposed) { VRMUtils.deepDispose(vrm.scene); return null; }
      const st = setupVrm(vrm, holder);
      st.top = top; st.half = half; st.bytes = bytes;
      holder.visible = false;
      pose.add(holder);
      root.updateMatrixWorld(true);
      setOutlines(vrm.scene, outlines);
      try { vrm.springBoneManager?.reset(); } catch { /* */ }
      try {
        const r = R?.renderer;
        if (r?.compileAsync && r.extensions?.has?.("KHR_parallel_shader_compile")) await r.compileAsync(holder, R.camera, R.scene);
        else r?.compile?.(holder, R.camera, R.scene);
      } catch { /* the first frame compiles instead */ }
      await st.motions.ready;
      st.motions.preload(["walk", stanceTag, "brace", "talk"]).catch(() => {});
      return st;
    })();
    const timeout = new Promise((res) => setTimeout(() => res("timeout"), VRM_TIMEOUT_MS));
    let result = null;
    try { result = await Promise.race([vrmPromise, timeout]); } catch (error) {
      console.debug(`[night-raid] crew: ${cast.name}'s VRM failed; the paper figure stays`, error);
      loadInfo = { ok: false, bytes: 0, ms: performance.now() - t0, url: cast.urls.vrmUrl, error: String(error?.message || error) };
      return loadInfo;
    }
    if (disposed || !result) return loadInfo;
    if (result === "timeout") {
      loadInfo = { ok: false, bytes: 0, ms: performance.now() - t0, url: cast.urls.vrmUrl, error: "timeout" };
      vrmPromise.then((st) => { if (st && !disposed) { V = st; if (wantKind === "vrm") showVrm(); } }).catch(() => {});
      return loadInfo;
    }
    V = result;
    loadInfo = { ok: true, bytes: V.bytes, ms: performance.now() - t0, url: cast.urls.vrmUrl, error: null };
    if (wantKind === "vrm") showVrm();
    return loadInfo;
  }

  // ---- Where they go, and what they do there ---------------------------------------------------

  const taskOf = (station, task) => {
    if (String(task).toLowerCase() === "stand_by") return STAND_BY[station] || "idle";
    const w = task != null ? TASK_WORDS[String(task).toLowerCase()] : undefined;
    if (w) return w;
    return STATION_TASK[station] || "idle";
  };

  /**
   * Put them on a station (or home): {station, task, spot: {pos, yaw}, key}. A new spot walks them there;
   * a new task on the same spot just changes the work.
   */
  function assign(next) {
    if (!next?.spot) return;
    const task = taskOf(next.station, next.task);
    const key = `${next.station}|${next.spot.pos.x.toFixed(2)},${next.spot.pos.y.toFixed(2)},${next.spot.pos.z.toFixed(2)}`;
    const sameSpot = want && want.key === key;
    want = { station: next.station || null, task, spot: next.spot, key, side: SIDE_OF[next.station] || null, drop: next.drop || null, fixture: next.fixture || null };
    if (ob || drive) return;                 // back aboard first (or back from the fight: release() walks them there)
    if (sameSpot && (mode === "work" || mode === "idle" || (mode === "walk" && walk?.dest === key))) {
      if (work && work.task !== task) startWork();
      return;
    }
    goTo(want.spot.pos, want.spot.yaw, key, () => startWork());
  }

  /** Walk to a ship-space point, then face `yawEnd` and run `then`. */
  function goTo(pos, yawEnd, dest, then) {
    endWork();
    const path = route(C.graph, root.position, pos);
    if (path.length < 2 || root.position.distanceTo(pos) < 0.08) {
      root.position.copy(pos);
      bodyYaw = yawEnd;
      walk = null;
      mode = "idle";
      then?.();
      return;
    }
    const first = path[1].p;
    const head = Math.atan2(first.x - root.position.x, first.z - root.position.z);
    walk = { path, seg: 0, along: 0, turning: Math.abs(wrapAngle(head - yaw)) > deg(70), turnT: 0, yawEnd, then, dest };
    bodyYaw = head;
    mode = "walk";
    setLoop("walk", walk.turning ? 0.7 : 1.4);
  }

  function setLoop(tag, rate = 1) {
    if (shown !== "vrm" || !V) { loopTag = tag; return; }
    if (tag === "walk") {
      V.motions.releaseHold(0.25);
      if (loopTag === "walk") { V.motions.loopRate("walk", rate); return; }
    }
    if (loopTag === tag) return;
    loopTag = tag;
    V.motions.setLoop(tag, { rate });
  }

  function startWork() {
    if (!want) return;
    mode = "work";
    walk = null;
    root.position.copy(want.spot.pos);
    bodyYaw = want.spot.yaw;
    const task = want.task;
    work = { task, t: 0, cycle: 0, spot: want.spot, side: want.side, leg: null, fixture: want.fixture };
    props.only();
    setLoop(task === "command" || task === "idle" ? stanceTag : null);
    if (shown === "vrm" && V && task === "patch") V.motions.play("crouch", { hold: true, toLowest: true, fadeIn: 0.35 });
    if (TASKS[task]?.shuttle) work.leg = { phase: "pick", t: 0 };
    C.emit?.("avatar_work", { who: id, task, stage: "arrive" });
  }

  function endWork() {
    if (!work) return;
    C.emit?.("avatar_work", { who: id, task: work.task, stage: "leave" });
    if (shown === "vrm" && V) V.motions.releaseHold(0.3);
    work = null;
    props.only();
  }

  /** The shuttle jobs (powder, tea): pick up, walk to the drop, put down, walk back. */
  function updateShuttle(dt) {
    const L = work.leg;
    L.t += dt;
    const spot = work.spot;
    if (L.phase === "pick" || L.phase === "drop") {
      const dur = L.phase === "pick" ? 1.1 : (work.task === "serve" ? 1.8 : 0.9);
      if (L.t === dt && shown === "vrm" && V && work.task === "carry") V.motions.play("crouch", { hold: true, toLowest: true, fadeIn: 0.25, rate: 1.6 });
      if (L.t >= dur) {
        if (shown === "vrm" && V) V.motions.releaseHold(0.25);
        const loaded = L.phase === "pick";
        const dest = loaded ? (C.dropFor?.(id, work.task) || null) : spot;
        if (!dest) { L.phase = "pick"; L.t = 0; return; }
        const path = route(C.graph, root.position, dest.pos);
        L.phase = loaded ? "go" : "back";
        L.t = 0; L.loaded = loaded; L.path = path; L.seg = 0; L.along = 0; L.dest = dest;
        setLoop("walk", 1.3);
      }
      return;
    }
    // Walking a leg.
    if (stepPath(L, dt, false)) {
      root.position.copy(L.dest.pos);
      bodyYaw = L.dest.yaw;
      setLoop(null);
      L.phase = L.phase === "go" ? "drop" : "pick";
      L.t = 0;
      if (L.phase === "drop") C.emit?.("avatar_beat", { who: id, task: work.task });
    }
  }

  /** Advance along a path ({path, seg, along}); true when arrived. */
  function stepPath(W, dt, hurry) {
    const a = W.path[W.seg]?.p, bw = W.path[W.seg + 1];
    if (!a || !bw) return true;
    const deckPace = C.frame?.battle ? PACE.battle : PACE.calm;
    const pace = (bw.kind === "stairs" ? deckPace * PACE.stairs : deckPace) * (hurry ? 1.15 : 1);
    if (t >= pauseUntil) W.along += pace * dt;
    let len = a.distanceTo(bw.p);
    while (W.along >= len) {
      W.along -= len;
      W.seg++;
      if (W.seg >= W.path.length - 1) return true;
      len = W.path[W.seg].p.distanceTo(W.path[W.seg + 1].p);
    }
    const a2 = W.path[W.seg].p, b2 = W.path[W.seg + 1].p;
    root.position.lerpVectors(a2, b2, clamp(W.along / Math.max(1e-3, len), 0, 1));
    const dx = b2.x - a2.x, dz = b2.z - a2.z;
    if (Math.hypot(dx, dz) > 0.05) bodyYaw = Math.atan2(dx, dz);
    if (shown === "vrm" && V) V.motions.loopRate("walk", clamp(pace / WALK_CLIP_SPEED, 0.8, 2.3));
    return false;
  }

  function updateWalk(dt) {
    if (!walk) { mode = "idle"; return; }
    if (walk.turning) {
      // Turn in place toward the way first (a shuffle on the slowed walk clip).
      walk.turnT += dt;
      if (Math.abs(wrapAngle(bodyYaw - yaw)) < deg(25) || walk.turnT > 0.9) { walk.turning = false; setLoop("walk", 1.4); }
      return;
    }
    if (stepPath(walk, dt, false)) {
      const w = walk;
      walk = null;
      root.position.copy(w.path[w.path.length - 1].p);
      bodyYaw = w.yawEnd;
      mode = "idle";
      setLoop(stanceTag);
      w.then?.();
    }
  }

  // ---- Overboard ---------------------------------------------------------------------------------

  /** "swept" | "rescued" | "lost" (and "reset": back aboard at once, a new run). */
  function overboard(stage, { side = null } = {}) {
    if (drive && stage !== "reset") return;  // in a boarding fight: the fight owns the body
    if (stage === "swept") {
      if (ob && ob.phase !== "gone") return;
      endWork();
      walk = null;
      mode = "overboard";
      const s = side || (Math.sign(root.position.x) || (Math.random() < 0.5 ? -1 : 1));
      const rail = railAt(root.position.z, root.position.y, s);
      ob = { phase: "drag", t: 0, side: s, from: root.position.clone(), deckY: root.position.y, rail, z: clamp(root.position.z, -11, 12.5) };
      bodyYaw = s > 0 ? -Math.PI / 2 : Math.PI / 2;      // their back to the sea
      setLoop(null);
      playTag("flail");
      face("flail");
      lookFor("captain", 1.5);
      C.emit?.("crew_overboard", { who: id, stage: "swept" });
      return;
    }
    if (!ob) return;
    if (stage === "rescued" && (ob.phase === "swim" || ob.phase === "fall" || ob.phase === "over" || ob.phase === "drag")) {
      if (ob.phase !== "swim") skipToWater();
      ob.phase = "haul"; ob.t = 0;
      ob.startY = root.position.y;
      ob.rail = railAt(ob.z, 0.2, ob.side);
      return;
    }
    if (stage === "lost" && ob.phase !== "gone") {
      if (ob.phase !== "swim") skipToWater();
      ob.phase = "sink"; ob.t = 0; ob.startY = root.position.y;
      face("sad");
      return;
    }
    if (stage === "reset") {
      ob = null;
      pose.rotation.set(0, 0, 0); pose.position.set(0, 0, 0);
      props.only();
      root.visible = !!shown;
      shadow.mesh.visible = true;
      mode = "idle";
      if (want) { root.position.copy(want.spot.pos); bodyYaw = want.spot.yaw; startWork(); }
    }
  }

  /** Feet height while treading water: the water at the chest, whatever their size. */
  const swimY = () => WATER_Y - 0.76 * (shown === "vrm" && V ? V.top : 1.65);
  /** Where they surface and are hauled from: alongside the main deck (not under the quarterdeck). */
  const swimZ = (z) => clamp(z, -3.2, 12.5);

  function skipToWater() {
    ob.z = swimZ(ob.z);
    root.position.set(ob.rail.x + ob.side * 2.6, swimY(), ob.z);
    pose.rotation.set(0, 0, 0);
    ob.phase = "swim"; ob.t = 0;
  }

  function updateOverboard(dt) {
    ob.t += dt;
    const s = ob.side;
    // They face inboard (their back to the sea), so falling toward the sea is a backward pitch.
    const tilt = (x) => { pose.rotation.set(-x, 0, 0); };
    switch (ob.phase) {
      case "drag": {
        // Dragged across the deck to the rail by the water.
        const k = Math.min(1, ob.t / 0.9);
        const e = k * k * (3 - 2 * k);
        root.position.set(THREE.MathUtils.lerp(ob.from.x, ob.rail.x - s * 0.3, e), ob.deckY, THREE.MathUtils.lerp(ob.from.z, ob.z, e));
        tilt(0.25 * e);
        if (k >= 1) { ob.phase = "over"; ob.t = 0; ob.x0 = root.position.x; }
        break;
      }
      case "over": {
        // Up and over the bulwark, tumbling back.
        const k = Math.min(1, ob.t / 0.55);
        root.position.x = ob.x0 + s * 0.9 * k;
        root.position.y = ob.deckY + Math.sin(k * Math.PI * 0.5) * (Math.max(0.4, ob.rail.top - ob.deckY) + 0.1);
        tilt(0.25 + 1.0 * k);
        if (k >= 1) { ob.phase = "fall"; ob.t = 0; ob.vy = 0.8; ob.vx = s * 1.8; }
        break;
      }
      case "fall": {
        ob.vy -= 9.8 * dt;
        root.position.x += ob.vx * dt;
        root.position.y += ob.vy * dt;
        tilt(1.25 + 0.6 * Math.min(1, ob.t / 0.8));
        if (!ob.splashed && root.position.y + 0.8 <= WATER_Y) {
          ob.splashed = true;
          const w = root.parent ? root.parent.localToWorld(_t1.set(root.position.x, WATER_Y, root.position.z)) : _t1.copy(root.position);
          C.emit?.("crew_splash", { who: id, x: w.x, y: w.y, z: w.z });
        }
        if (root.position.y <= WATER_Y - 1.7) { ob.phase = "surface"; ob.t = 0; ob.x0 = root.position.x; ob.y0 = root.position.y; ob.z0 = ob.z; }
        break;
      }
      case "surface": {
        // Back up for air, upright, drifting to where they'll tread water.
        const k = Math.min(1, ob.t / 1.2);
        const e = k * k * (3 - 2 * k);
        root.position.x = THREE.MathUtils.lerp(ob.x0, ob.rail.x + s * 2.6, e);
        root.position.y = THREE.MathUtils.lerp(ob.y0, swimY(), e);
        ob.z = THREE.MathUtils.lerp(ob.z0, swimZ(ob.z0), e);
        root.position.z = ob.z;
        tilt(1.85 * (1 - e));
        if (k >= 1) { ob.phase = "swim"; ob.t = 0; }
        break;
      }
      case "swim": {
        // Treading water alongside, an arm up.
        root.position.set(ob.rail.x + s * 2.6, swimY() + 0.07 * Math.sin(ob.t * 2.2), ob.z);
        pose.rotation.set(0.1 * Math.sin(ob.t * 1.7), 0, 0.08 * Math.sin(ob.t * 1.3));
        bodyYaw = s > 0 ? -Math.PI / 2 : Math.PI / 2;     // facing the ship
        break;
      }
      case "haul": {
        // Hauled up the side on a line, hand over hand, then over the rail.
        const dur = 2.6;
        const k = Math.min(1, ob.t / dur);
        const e = k * k * (3 - 2 * k);
        const top = ob.rail.top - 1.2;
        root.position.set(THREE.MathUtils.lerp(ob.rail.x + s * 2.6, ob.rail.x + s * 0.75, Math.min(1, e * 1.4)),
          THREE.MathUtils.lerp(ob.startY, top, e) + 0.06 * Math.sin(ob.t * 9) * (1 - k), ob.z);
        pose.rotation.set(-0.18 * (1 - e), 0, 0);
        if (k >= 1) { ob.phase = "climb"; ob.t = 0; ob.x0 = root.position.x; ob.y0 = root.position.y; }
        break;
      }
      case "climb": {
        const k = Math.min(1, ob.t / 0.7);
        // Over the bulwark onto the main deck.
        root.position.x = THREE.MathUtils.lerp(ob.x0, ob.rail.x - s * 0.5, k);
        root.position.y = THREE.MathUtils.lerp(ob.y0, 0, k) + Math.sin(k * Math.PI) * 0.9;
        pose.rotation.set(0.35 * Math.sin(k * Math.PI), 0, 0);
        if (k >= 1) {
          root.position.y = 0;                // aboard on the main deck
          ob = null;
          props.only();
          mode = "idle";
          bodyYaw = -Math.sign(s) * Math.PI / 2;
          playTag("madeit");
          face("madeit");
          C.emit?.("crew_overboard", { who: id, stage: "aboard" });
          const w = want;
          if (w) setTimeout(() => { if (!disposed && !ob && want === w) goTo(w.spot.pos, w.spot.yaw, w.key, () => startWork()); }, 1600);
        }
        break;
      }
      case "sink": {
        const k = Math.min(1, ob.t / 2.6);
        root.position.y = ob.startY - 2.2 * k * k;
        if (k >= 1) { ob.phase = "gone"; root.visible = false; }
        break;
      }
      default: break;
    }
    shadow.mesh.visible = !ob || ob.phase === "drag";
  }

  // ---- Looking ------------------------------------------------------------------------------------

  const cameraPos = (out) => (R?.camera ? R.camera.getWorldPosition(out) : out.set(0, 6, -10));

  function headWorld(out) {
    if (shown === "vrm" && V?.headBone) return V.headBone.getWorldPosition(out);
    return pose.localToWorld(out.set(0, standee ? standee.headHeight() : 1.5, 0));
  }

  function lookFor(target, seconds) {
    lookMode = target?.isVector3 ? target.clone() : target;
    lookUntil = seconds > 0 ? t + seconds : 0;
  }
  const lookShip = (x, y, z, seconds) => { lookAnchor.position.set(x, y, z); lookFor(lookAnchor, seconds); };

  /** What they'd look at by themselves (world point into `out`), or null. */
  function autoTarget(out) {
    const F = C.frame || {};
    if (mode === "overboard") return ob?.phase === "swim" || ob?.phase === "haul" ? cameraPos(out) : null;
    if (mode === "walk" && walk && !walk.turning) {
      const nx = walk.path[Math.min(walk.seg + 1, walk.path.length - 1)].p;
      return root.parent ? root.parent.localToWorld(out.set(nx.x + (nx.x - root.position.x), root.position.y + 1.5, nx.z + (nx.z - root.position.z))) : null;
    }
    if (work) {
      if (work.task === "gun" || work.task === "cutlass") { const p = F.targetFor?.(work.side, root); if (p) return out.copy(p); }
      if (work.task === "spyglass") { const p = F.watchFor?.(root); if (p) return out.copy(p); }
      if (work.task === "repel") { const p = F.krakenFor?.(root); if (p) return out.copy(p); }
      if (work.task === "command") { const p = F.marked || F.nearest; if (p && t % 9 < 6) return out.copy(p); }
    }
    // At leisure (or a calm job): the marked / nearest contact, the way ahead, now and then the Captain.
    if (t > auto.until) {
      const r = Math.random();
      const what = (F.marked || F.nearest) && r < 0.45 ? "contact" : r < 0.62 ? "captain" : r < 0.8 ? "work" : "ahead";
      auto = { what, until: t + 1.6 + Math.random() * 3.2 };
    }
    switch (auto.what) {
      case "contact": { const p = F.marked || F.nearest; return p ? out.copy(p) : null; }
      case "captain": return cameraPos(out);
      case "work": return pose.localToWorld(out.set(0, 0.8, 0.9));
      default: return root.parent ? root.parent.localToWorld(out.set(root.position.x * 0.7, root.position.y + 1.4, root.position.z + 40)) : null;
    }
  }

  function updateLook(dt) {
    if (lookUntil && t > lookUntil) { lookMode = null; lookUntil = 0; }
    const H = headWorld(_v1);
    let target = null;
    if (lookMode === "captain" || lookMode === "camera") target = cameraPos(_v2);
    else if (lookMode?.isObject3D) target = lookMode.getWorldPosition(_v2);
    else if (lookMode?.isVector3) target = _v2.copy(lookMode);
    if (!target) target = autoTarget(_v2);
    if (!target || !finite3(target)) {
      target = _v2.set(Math.sin(yaw), 0, Math.cos(yaw));
      if (root.parent) target.transformDirection(root.parent.matrixWorld);
      target.multiplyScalar(8).add(H);
    }
    saccadeT -= dt;
    if (saccadeT <= 0) { saccadeT = 0.6 + Math.random() * 1.6; saccade.set((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.03); }
    const dir = _v3.subVectors(target, H);
    const dist = Math.max(0.3, dir.length());
    dir.divideScalar(dist);
    const side = _v4.crossVectors(UP, dir).normalize();
    dir.addScaledVector(side, saccade.x).addScaledVector(UP, saccade.y).normalize();
    if (!finite3(dir)) return;
    lookDir.lerp(dir, 1 - Math.exp(-LOOK.eyeRate * dt)).normalize();
    lookProxy.position.copy(H).addScaledVector(lookDir, Math.min(dist, 14));
    lookProxy.updateMatrixWorld();
  }

  // ---- The VRM, per frame -------------------------------------------------------------------------

  function headTurn(st, dt) {
    const { neck, headBone, vrm } = st;
    if (!headBone) return;
    for (const [b, q] of st.saved) q.copy(b.quaternion);
    lookWeight = damp(lookWeight, lookWeightTarget, 3, dt);
    const H = headBone.getWorldPosition(_v1);
    const dir = _v2.subVectors(lookProxy.position, H).normalize();
    if (!finite3(dir)) return;
    dir.applyQuaternion(vrm.scene.getWorldQuaternion(_q1).invert());
    const x = dir.dot(st.left), y = dir.y, z = dir.dot(st.fwd);
    const yawT = clamp(Math.atan2(x, z), -LOOK.yawMax, LOOK.yawMax) * lookWeight;
    const pitchT = clamp(Math.atan2(y, Math.hypot(x, z)), -LOOK.pitchDown, LOOK.pitchUp) * lookWeight;
    st.yaw = damp(st.yaw, yawT, 4.5, dt);
    st.pitch = damp(st.pitch, pitchT, 4.5, dt);
    const q = _q1.setFromAxisAngle(UP, st.yaw).multiply(_q2.setFromAxisAngle(st.left, -st.pitch));
    if (neck) {
      _qn.identity().slerp(q, LOOK.neckShare);
      rotateInSpace(neck, _qn, vrm.scene);
      q.multiply(_qn.invert());
    }
    rotateInSpace(headBone, q, vrm.scene);
  }

  function faceUpdate(st, dt, mouth) {
    const exp = st.vrm.expressionManager;
    if (!exp) return;
    const n = st.names;
    for (const k of ["happy", "sad", "surprised", "relaxed", "angry"]) {
      if (st.emoHold[k] && t > st.emoHold[k]) { st.emoTarget[k] = 0; st.emoHold[k] = 0; }
      st.emo[k] = damp(st.emo[k] || 0, st.emoTarget[k] || 0, 5, dt);
      if (n[k]) exp.setValue(n[k], st.emo[k]);
    }
    st.blinkIn -= dt;
    if (st.blinkIn <= 0 && st.blinkPhase < 0) { st.blinkPhase = 0; st.blinkIn = Math.random() < 0.15 ? 0.32 : 3 + Math.random() * 3; }
    let blink = 0;
    if (st.blinkPhase >= 0) {
      st.blinkPhase += dt;
      const p = st.blinkPhase;
      blink = p < 0.07 ? p / 0.07 : p < 0.1 ? 1 : Math.max(0, 1 - (p - 0.1) / 0.12);
      if (p > 0.22) st.blinkPhase = -1;
    }
    blink *= clamp(1 - 0.9 * (st.emo.happy || 0) - 0.7 * (st.emo.surprised || 0), 0, 1);
    if (n.blink) exp.setValue(n.blink, blink);
    const ohFromSurprise = n.surprised ? 0 : 0.35 * (st.emo.surprised || 0);
    for (const k of ["aa", "ih", "ou", "ee", "oh"]) {
      if (!n[k]) continue;
      exp.setValue(n[k], k === "oh" ? Math.max(mouth.oh, ohFromSurprise) : mouth[k]);
    }
  }

  function proceduralPose(st) {
    if (!st.armSign) st.armSign = armSign(st.vrm, st.lArm, st.lHand);
    const breathe = Math.sin(t * Math.PI * 2 / 4.4);
    if (st.lArm) st.lArm.rotation.set(0, 0, st.armSign * (1.2 + 0.015 * breathe));
    if (st.rArm) st.rArm.rotation.set(0, 0, -st.armSign * (1.2 + 0.015 * breathe));
    if (st.chest) st.chest.rotation.set(-0.014 * breathe, 0, 0);
  }

  /** The work pose over the clip: two-bone IK for the arms, a lean, the job's prop. */
  function workPose(st, dt) {
    const reacting = t < pauseUntil;
    const want = (work && mode === "work" && !reacting) || (ob && (ob.phase === "swim" || ob.phase === "haul" || ob.phase === "fall" || ob.phase === "over")) ? 1 : 0;
    workW = damp(workW, want, reacting ? 9 : 5, dt);
    kick = Math.max(0, kick - dt * 2.5);
    if (workW < 0.01) { if (!work || reacting) props.only(...(work?.leg?.loaded && !reacting ? [work.task === "serve" ? "tray" : "keg"] : [])); return; }
    pose.updateMatrixWorld(true);
    const fwd = _a.set(0, 0, 1).transformDirection(pose.matrixWorld);
    const left = _b.set(1, 0, 0).transformDirection(pose.matrixWorld);
    const up = _c.set(0, 1, 0).transformDirection(pose.matrixWorld);
    const anchor = st.chest || st.spine || st.hips;
    if (!anchor) return;
    const chestP = anchor.getWorldPosition(_d);
    const floorY = root.getWorldPosition(_e).y + 0.08;
    const W = workW;
    const poleL = _f.copy(up).multiplyScalar(-1).addScaledVector(left, 0.55).addScaledVector(fwd, -0.3).normalize();
    const poleR = _g.copy(up).multiplyScalar(-1).addScaledVector(left, -0.55).addScaledVector(fwd, -0.3).normalize();
    const at = (out, f, l, u) => out.copy(chestP).addScaledVector(fwd, f).addScaledVector(left, l).addScaledVector(up, u);
    const floor = (v) => { if (v.y < floorY) v.y = floorY; return v; };
    const both = (tl, tr) => { armIK(st.lArm, st.lLow, st.lHand, tl, poleL, W); armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W); };
    const lean = (a) => { if (st.spine && a) rotateInSpace(st.spine, _qy.setFromAxisAngle(st.left, a * W), st.vrm.scene); };
    const handProp = (prop, hand, dir) => {
      const h = hand?.getWorldPosition(_t3);
      if (!h) return;
      prop.visible = true;
      prop.position.copy(h);
      prop.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
    };
    const between = (prop, tl, tr, yUp = 0) => { prop.visible = true; prop.position.copy(tl).add(tr).multiplyScalar(0.5); prop.position.y += yUp; prop.quaternion.copy(root.getWorldQuaternion(_q1)); };

    // Overboard: an arm up, waving, or both hands on the line.
    if (ob) {
      props.only(ob.phase === "haul" ? "line" : undefined);
      if (ob.phase === "haul") {
        const a = 0.5 + 0.5 * Math.cos(ob.t * 2 * Math.PI * 1.4), b = 1 - a;
        const tl = at(_t1, 0.32, 0.08, 0.35 + 0.25 * a), tr = at(_t2, 0.32, -0.08, 0.35 + 0.25 * b);
        both(tl, tr);
        const railTop = root.parent ? root.parent.localToWorld(_e.set(ob.rail.x, ob.rail.top + 0.15, ob.z)) : _e.copy(tl);
        props.setLine(_t3.copy(tl).add(tr).multiplyScalar(0.5), railTop);
        props.line.visible = true;
      } else {
        const wave = Math.sin(ob.t * 7);
        armIK(st.rArm, st.rLow, st.rHand, at(_t1, 0.25, -0.25 + 0.12 * wave, 0.75), poleR, W);
        armIK(st.lArm, st.lLow, st.lHand, at(_t2, 0.35, 0.3, -0.1 + 0.1 * Math.sin(ob.t * 3)), poleL, W * 0.7);
      }
      return;
    }

    if (!work) { props.only(); return; }    // off the job, the work pose easing out
    const task = work.task;
    const def = TASKS[task] || TASKS.idle;
    const ph = work.t * (def.hz || 0);
    const stroke = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);           // 1 up … 0 down
    switch (task) {
      case "gun": {
        const L = C.frame?.loaded?.(work.side);
        const l = Number.isFinite(L) ? L : ((work.t / 6) % 1.15);
        lean(-0.2 * kick);
        if (l >= 0.999) {
          // Ready: the lanyard in the right hand, eyes on the target.
          props.only("line");
          const tr = at(_t2, 0.28, -0.16, -0.42);
          armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
          props.setLine(st.rHand.getWorldPosition(_t3), at(_t1, 1.1, -0.05, -0.95));
        } else if (l < 0.34) {
          // Load: a round shot from the garland at the side, crouched in to the muzzle.
          props.only("ball");
          const k = l / 0.34;
          const reach = k < 0.45 ? k / 0.45 : 1;
          const tr = floor(at(_t2, 0.15 + 0.45 * reach, -0.32 + 0.3 * reach, -0.85 + 0.15 * reach));
          const tl = floor(at(_t1, 0.15 + 0.45 * reach, -0.12 + 0.2 * reach, -0.8 + 0.12 * reach));
          both(tl, tr);
          lean(0.42);
          between(props.ball, tl, tr, 0.02);
        } else if (l < 0.72) {
          // Ram: the rammer along the bore, driven home.
          props.only("rammer");
          const s = 0.5 + 0.5 * Math.sin(((l - 0.34) / 0.38) * Math.PI * 2 * 3);
          const tl = at(_t1, 0.25 + 0.25 * s, 0.05, -0.42), tr = at(_t2, 0.12 + 0.25 * s, -0.12, -0.45);
          both(tl, tr);
          lean(0.22 + 0.1 * s);
          props.rammer.visible = true;
          props.rammer.position.copy(tr).addScaledVector(fwd, -0.15);
          props.rammer.quaternion.setFromUnitVectors(Z_AXIS, _t3.copy(fwd).addScaledVector(up, -0.18).normalize());
        } else {
          // Run out: hauling the gun tackle, leaning back into it.
          props.only("line");
          const s = 0.5 + 0.5 * Math.sin(((l - 0.72) / 0.28) * Math.PI * 2 * 2);
          const tl = at(_t1, 0.5 - 0.25 * s, 0.14, -0.48), tr = at(_t2, 0.38 - 0.25 * s, -0.14, -0.5);
          both(tl, tr);
          lean(-0.12 * s);
          props.setLine(_t3.copy(tl).add(tr).multiplyScalar(0.5), at(_e, 1.5, 0.45, -1.05));
        }
        break;
      }
      case "pump": {
        const fx = work.fixture;
        if (fx?.handle) {
          fx.handle.rotation.x = -0.35 + 0.65 * (1 - stroke);
          fx.handle.updateMatrixWorld(true);
          const g = fx.grip.getWorldPosition(_t3);
          both(_t1.copy(g).addScaledVector(left, 0.11), _t2.copy(g).addScaledVector(left, -0.11));
        } else {
          // The scene's chain pump: both hands round its crank handle, in front at the waist.
          const a = ph * Math.PI * 2;
          const f = 0.42 + 0.13 * Math.cos(a), u = -0.36 + 0.15 * Math.sin(a);
          both(at(_t1, f, 0.1, u), at(_t2, f, -0.1, u));
          lean(0.12 + 0.08 * Math.cos(a));
          break;
        }
        lean(0.2 * (1 - stroke));
        break;
      }
      case "haul": {
        const a = stroke, b = 0.5 + 0.5 * Math.cos((ph + 0.5) * Math.PI * 2);
        const tl = at(_t1, 0.26, 0.06, 0.06 + 0.5 * a), tr = at(_t2, 0.28, -0.05, 0.06 + 0.5 * b);
        both(tl, tr);
        lean(-0.08);
        props.only("line");
        props.setLine(_t3.copy(tl).add(tr).multiplyScalar(0.5), at(_e, 0.7, 0, 6.5));
        break;
      }
      case "spyglass": {
        props.only("spyglass");
        const headP = st.headBone ? st.headBone.getWorldPosition(_t1) : at(_t1, 0, 0, 0.45);
        const dir = _t2.copy(lookDir);
        if (!finite3(dir) || dir.lengthSq() < 0.5) dir.copy(fwd);
        const eye = headP.addScaledVector(dir, 0.1).addScaledVector(left, -0.035).addScaledVector(up, 0.03);
        props.spyglass.position.copy(eye);
        props.spyglass.quaternion.setFromUnitVectors(Z_AXIS, dir);
        armIK(st.rArm, st.rLow, st.rHand, _e.copy(eye).addScaledVector(dir, 0.1).addScaledVector(up, -0.03), poleR, W);
        armIK(st.lArm, st.lLow, st.lHand, _t3.copy(eye).addScaledVector(dir, 0.34).addScaledVector(up, -0.04).addScaledVector(left, 0.01), poleL, W);
        break;
      }
      case "carry":
      case "serve": {
        const L = work.leg;
        const tray = task === "serve";
        if (!L || L.phase === "pick" || L.phase === "drop") {
          // Crouched at the pile (or holding the tray out), the load between the hands.
          const offer = tray && L?.phase === "drop";
          const tl = floor(at(_t1, offer ? 0.5 : 0.42, 0.17, offer ? -0.25 : -0.85)), tr = floor(at(_t2, offer ? 0.5 : 0.42, -0.17, offer ? -0.25 : -0.85));
          both(tl, tr);
          lean(offer ? 0.12 : 0.35);
          const prop = tray ? props.tray : props.keg;
          const holding = tray ? true : (L?.phase === "pick" ? L.t > 0.6 : L ? L.t < 0.45 : false);
          props.only(holding ? (tray ? "tray" : "keg") : undefined);
          if (holding) between(prop, tl, tr, tray ? -0.02 : 0);
        } else if (L.loaded || tray) {
          const tl = at(_t1, 0.32, 0.16, tray ? -0.3 : -0.48), tr = at(_t2, 0.32, -0.16, tray ? -0.3 : -0.48);
          both(tl, tr);
          lean(tray ? 0 : -0.06);
          props.only(tray ? "tray" : "keg");
          between(tray ? props.tray : props.keg, tl, tr, tray ? -0.02 : 0);
        } else {
          props.only();
          workW = damp(workW, 0, 6, dt);
        }
        break;
      }
      case "patch": {
        props.only("mallet");
        const tr = floor(at(_t1, 0.4, -0.1, -0.5 + 0.28 * stroke));
        const tl = floor(at(_t2, 0.44, 0.14, -0.64));
        armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
        armIK(st.lArm, st.lLow, st.lHand, tl, poleL, W);
        handProp(props.mallet, st.rHand, _t3.copy(fwd).multiplyScalar(0.35 + 0.65 * (1 - stroke)).addScaledVector(up, 0.25 + 0.75 * stroke));
        break;
      }
      case "douse": {
        props.only("bucket");
        const s = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);              // 0 back … 1 thrown
        const tl = at(_t1, 0.1 + 0.55 * s, 0.1, -0.7 + 0.6 * s), tr = at(_t2, 0.1 + 0.55 * s, -0.1, -0.7 + 0.6 * s);
        both(floor(tl), floor(tr));
        lean(0.3 - 0.35 * s);
        props.bucket.visible = true;
        props.bucket.position.copy(tl).add(tr).multiplyScalar(0.5).addScaledVector(up, -0.12);
        props.bucket.quaternion.setFromAxisAngle(_t3.copy(left), -1.4 * s * s).premultiply(root.getWorldQuaternion(_q1));
        break;
      }
      case "cook": {
        props.only("ladle");
        const a = ph * Math.PI * 2;
        const tr = at(_t1, 0.48 + 0.07 * Math.cos(a), -0.08 + 0.07 * Math.sin(a), -0.32);
        armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
        handProp(props.ladle, st.rHand, _t3.copy(up).multiplyScalar(-1).addScaledVector(fwd, 0.25));
        props.ladle.quaternion.multiply(_q2.setFromAxisAngle(Z_AXIS, Math.PI));
        lean(0.18);
        break;
      }
      case "cutlass":
      case "repel": {
        props.only("cutlass");
        const slash = task === "repel" || (work.slashUntil && t < work.slashUntil);
        const s = slash ? 0.5 - 0.5 * Math.cos(ph * Math.PI * 2 * (task === "repel" ? 1 : 1.1)) : 0;
        const bob = 0.03 * Math.sin(t * 3.1);
        const tr = at(_t1, 0.3 + 0.3 * s, -0.24 + 0.1 * s, 0.05 + bob - 0.5 * s);
        armIK(st.rArm, st.rLow, st.rHand, tr, poleR, W);
        armIK(st.lArm, st.lLow, st.lHand, at(_t2, 0.32, 0.22, -0.28 + bob), poleL, W * 0.8);
        lean(0.12 + 0.2 * s);
        handProp(props.cutlass, st.rHand, _t3.copy(up).multiplyScalar(1 - 1.6 * s).addScaledVector(fwd, 0.55 + 0.6 * s));
        break;
      }
      default:
        props.only();
        workW = damp(workW, 0, 6, dt);
        break;
    }
  }

  function updateVrm(st, dt, mouth) {
    for (const [b, q] of st.saved) b.quaternion.copy(q);
    st.motions.update(dt);
    if (st.hips && st.hipsBase) {
      st.hips.position.x = st.hipsBase.x;
      st.hips.position.z = st.hipsBase.z;
      if (!st.motions.drivesHips) st.hips.position.y = st.hipsBase.y;
    }
    if (!st.motions.hasIdle) proceduralPose(st);
    if (drive?.pose) { try { drive.pose(st, dt, handle); } catch (error) { if ((drive.fails = (drive.fails || 0) + 1) <= 3) console.debug(`[night-raid] crew: ${cast.name}'s fight pose failed`, error); } }
    else workPose(st, dt);
    headTurn(st, dt);
    faceUpdate(st, dt, mouth);
    if (springsOn) st.vrm.update(dt);
    else {
      st.vrm.humanoid?.update?.();
      st.vrm.lookAt?.update?.(dt);
      st.vrm.expressionManager?.update?.();
      st.vrm.nodeConstraintManager?.update?.();
      for (const m of st.vrm.materials || []) m.update?.(dt);
    }
  }

  // ---- The frame ----------------------------------------------------------------------------------

  function updateYaw(dt) {
    const err = wrapAngle(bodyYaw - yaw);
    const w = (mode === "walk" ? 2.6 : mode === "overboard" ? 2.2 : 1) * (R?.motion === "reduced" ? YAW_OMEGA * 1.6 : YAW_OMEGA);
    yawVel += (w * w * err - 2 * w * yawVel) * dt;
    yaw = wrapAngle(yaw + yawVel * dt);
    root.rotation.y = yaw;
  }

  /**
   * One frame. `F` (crew.js's per-frame facts): camera world position, quality's spring distance, battle flag.
   * @param {number} dt
   */
  function update(dt) {
    if (disposed) return;
    dt = Math.max(0, Math.min(dt || 0, 0.1));
    t += dt;
    const F = C.frame || {};
    // LOD: how far from the camera; far or off-screen bodies animate every third frame.
    const wp = root.getWorldPosition(_t1);
    const dist = F.camPos ? wp.distanceTo(F.camPos) : 0;
    const wantSprings = dist < (F.springDist ?? 60);
    if (wantSprings && !springsOn && V) { try { V.vrm.springBoneManager?.reset(); } catch { /* */ } }
    springsOn = wantSprings;
    const offscreen = F.frustum && shown === "vrm" && V ? !F.frustum.containsPoint(_t2.copy(wp).addScaledVector(UP, 0.9)) && dist > 4 : false;
    lodAcc += dt;
    const heavyEvery = dist > 120 || offscreen ? 3 : 1;
    const doBody = ++lodTick % heavyEvery === 0;

    if (drive) { try { drive.step?.(dt, handle); } catch (error) { if ((drive.fails = (drive.fails || 0) + 1) <= 3) console.debug(`[night-raid] crew: ${cast.name}'s fight step failed`, error); } }
    else if (mode === "overboard" && ob) updateOverboard(dt);
    else if (mode === "walk") updateWalk(dt);
    else if (mode === "work" && work) {
      work.t += dt;
      const def = TASKS[work.task];
      if (def?.hz && t >= pauseUntil) {
        const n = Math.floor(work.t * def.hz + 0.5);
        if (n > work.cycle) { work.cycle = n; if (def.beat && work.t > 0.2) C.emit?.("avatar_beat", { who: id, task: work.task }); }
      }
      if (def?.shuttle) updateShuttle(dt);
    }
    // A flinch's step away springs back. (A driver owns the pose group's offset and tilt.)
    if (!drive) {
      if (step.lengthSq() > 1e-6) { step.multiplyScalar(Math.exp(-2.4 * dt)); }
      pose.position.set(step.x, pose.position.y, step.z);
      if (!ob) pose.position.y = shown === "standee" && mode === "walk" ? 0.04 * Math.abs(Math.sin(t * 8)) : 0;
    }

    // Idle life: the stance loop and personality fidgets.
    if (!drive && (mode === "idle" || (mode === "work" && (work?.task === "command" || work?.task === "idle"))) && shown === "vrm" && V) {
      if (loopTag !== stanceTag && !V.motions.busy) setLoop(stanceTag);
      fidgetT -= dt;
      if (fidgetT <= 0 && !V.motions.busy && !lip.speaking) {
        fidgetT = (id === "eve" ? 8 : 13) + Math.random() * 12;
        V.motions.play(Math.random() < 0.8 ? fidgetTag : "lookaround", { fadeIn: 0.5 });
      }
    }

    if (shown === "standee" && mode !== "overboard" && !drive) {
      // The paper figure keeps its face to the camera.
      const cam = cameraPos(_t2);
      const local = root.parent ? root.parent.worldToLocal(_t3.copy(cam)) : _t3.copy(cam);
      bodyYaw = mode === "walk" ? bodyYaw : Math.atan2(local.x - root.position.x, local.z - root.position.z);
    }
    updateYaw(dt);
    if (!doBody) return;
    const bdt = lodAcc;
    lodAcc = 0;
    root.updateMatrixWorld(true);
    updateLook(bdt);
    const mouth = lip.update(bdt);
    if (shown === "vrm" && V) updateVrm(V, bdt, mouth);
    if (standee && shown === "standee") standee.update(bdt, { level: lip.level, reduced: R?.motion === "reduced" });
    const top = shown === "vrm" && V ? V.top : (standee ? standee.headHeight() + 0.25 : 1.8);
    tag.object.position.set(0, top + 0.28, 0);
  }

  // ---- Reactions ----------------------------------------------------------------------------------

  function face(kind) {
    const f = FACE[kind];
    if (f) expression(f[0], f[1], f[2]);
  }

  function expression(name, w = 1, holdS = null) {
    if (!V) return;
    for (const k of ["happy", "sad", "surprised", "relaxed", "angry"]) if (k !== name) { V.emoTarget[k] = 0; V.emoHold[k] = 0; }
    if (!name || !(name in EXPRESSIONS)) return;
    V.emoTarget[name] = clamp(w, 0, 1);
    V.emoHold[name] = holdS ? t + holdS : 0;
  }

  async function playTag(tag, opts = {}) {
    if (disposed || !tag) return false;
    if (shown !== "vrm" || !V) return standee ? standee.react(tag, opts) : false;
    return V.motions.play(tag, opts);
  }

  /**
   * A reaction: "brace", "flinch" ({from: ship-space Vector3}), "cheer", "sad", "scared", "recoil", "point" ({at: world Vector3}),
   * "order" ({at}), "slash". Busy hands let go for the clip and take the work back after.
   */
  function react(kind, opts = {}) {
    if (disposed || ob) return;
    const delay = Number(opts.delay) || 0;
    if (delay > 0) { setTimeout(() => react(kind, { ...opts, delay: 0 }), delay * 1000); return; }
    switch (kind) {
      case "brace":
        pauseUntil = t + 1.25;
        face("brace");
        playTag("brace", { cut: 1.4 });
        break;
      case "flinch": {
        pauseUntil = t + 0.9;
        face("flinch");
        if (opts.from?.isVector3) {
          const away = _t1.subVectors(root.position, opts.from); away.y = 0;
          if (away.lengthSq() > 1e-4) {
            away.normalize().multiplyScalar(0.45);
            // the step is in pose space (under the root's yaw): rotate it in
            away.applyAxisAngle(UP, -yaw);
            step.copy(away);
          }
          lookShip(opts.from.x, opts.from.y + 0.6, opts.from.z, 1.8);
        }
        playTag("flinch", { cut: 1.4 });
        break;
      }
      case "cheer":
        if (mode === "walk") { face("hurrah"); break; }
        pauseUntil = t + 2.2;
        face("hurrah");
        lookFor(opts.at || null, 2.4);
        playTag("hurrah", { cut: 2.6 });
        break;
      case "sad": face("sad"); if (mode !== "walk" && !work) playTag("sad", { cut: 2.5 }); break;
      case "scared": face("scared"); if (opts.at) lookFor(opts.at, 3); if (mode !== "walk") { pauseUntil = t + 1.6; playTag("scared", { cut: 2.2 }); } break;
      case "recoil": kick = 1; face("flinch"); break;
      case "slash": if (work) work.slashUntil = t + 2.4; break;
      case "point":
      case "order": {
        if (opts.at) lookFor(opts.at, 2.5);
        face("order");
        if (mode === "walk" || (work && work.task !== "command" && work.task !== "idle")) break;
        let side = null;
        if (opts.at?.isVector3 && root.parent) {
          const l = root.parent.worldToLocal(_t1.copy(opts.at));
          side = wrapAngle(Math.atan2(l.x - root.position.x, l.z - root.position.z) - yaw) > 0 ? "left" : "right";
        }
        pauseUntil = t + 1.8;
        playTag(kind === "point" || side ? "point" : "order", { side, up: false, cut: 2.2 });
        break;
      }
      default: break;
    }
  }

  // ---- A driver's handle (fight.js: the boarding fight) -------------------------------------------

  /** What a driver gets: the body's groups and props, its clock and size, and the face / motion / look calls. */
  const handle = {
    id, root, pose, props,
    get name() { return cast.name; },
    get isCompanion() { return !!cast.isCompanion; },
    /** The VRM's per-frame state ({vrm, motions, bones...}) when the 3D body shows, else null (the paper standee). */
    get V() { return shown === "vrm" && V ? V : null; },
    get t() { return t; },
    get yaw() { return yaw; },
    /** Height (m) of the body showing. */
    get height() { return shown === "vrm" && V ? V.top : (standee ? standee.headHeight() + 0.25 : 1.7); },
    /** Turn the body toward yaw `y` (radians, the parent's frame) on the member's own spring; `snap` turns at once. */
    setYaw(y, snap = false) { bodyYaw = y; if (snap) { yaw = y; yawVel = 0; root.rotation.y = y; } },
    face: (kind) => face(kind),
    expression: (name, w, holdS) => expression(name, w, holdS),
    play: (tag, opts) => playTag(tag, opts),
    loop: (tag, rate) => setLoop(tag, rate),
    lookAt: (target, seconds = 2) => lookFor(target, seconds),
  };

  /**
   * Hand the body to a driver (fight.js), or take it back with null. While driven the member's own walking, working,
   * overboard and idle life stop: the driver's step(dt, H) moves them (H.root / H.pose) and pose(st, dt, H) poses the
   * VRM after the clips (instead of the work pose). The state's assignments are kept and walked to on release
   * (the driver puts the root back under the ship first). Returns the handle.
   */
  function takeover(driver, { resume = true } = {}) {
    if (driver) {
      endWork();
      walk = null;
      drive = driver;
      mode = "fight";
      if (shown === "vrm" && V) { V.motions.stop(0.25); loopTag = undefined; }
      props.only();
      return handle;
    }
    if (!drive) return handle;
    drive = null;
    pose.rotation.set(0, 0, 0);
    pose.position.set(0, 0, 0);
    step.set(0, 0, 0);
    props.only();
    workW = 0;
    pauseUntil = 0;
    mode = "idle";
    if (shown === "vrm" && V) { V.motions.stop(0.3); loopTag = undefined; }
    setLoop(stanceTag);
    if (resume && want && !ob) goTo(want.spot.pos, want.spot.yaw, want.key, () => startWork());
    return handle;
  }

  // ---- API ----------------------------------------------------------------------------------------

  return {
    id, cast, root,
    get name() { return cast.name; },
    get isCompanion() { return !!cast.isCompanion; },
    get kind() { return shown; },
    get mode() { return mode; },
    get station() { return want?.station || null; },
    get task() { return work?.task || want?.task || null; },
    get overboardStage() { return ob ? ob.phase : null; },
    get loadInfo() { return { ...loadInfo }; },
    /** Diagnostics: the rig's bones, size, LOD and work weights. */
    debug() {
      const bones = V ? Object.fromEntries(["hips", "neck", "headBone", "chest", "spine", "lArm", "rArm", "lLow", "rLow", "lHand", "rHand"].map((k) => [k, !!V[k]])) : null;
      return { id, kind: shown, mode, task: work?.task || null, workW: +workW.toFixed(2), springsOn, speaking: lip.speaking, top: V?.top ?? null, half: V?.half ?? null,
        loop: loopTag ?? null, current: V?.motions.current ?? null, pos: root.position.toArray().map((x) => +x.toFixed(2)), yaw: +yaw.toFixed(2), bones };
    },
    get position() { return root.position.clone(); },
    load, update, assign, overboard, react, takeover,
    /** True while a driver (the boarding fight) owns the body. */
    get driven() { return !!drive; },
    /** Where they stand now (ship space), for placing them before the first assignment. */
    place(spot) {
      if (!spot) return;
      root.position.copy(spot.pos);
      yaw = bodyYaw = spot.yaw;
      root.rotation.y = yaw;
    },
    /** Look at a world point / Object3D / "captain" for `seconds`. */
    lookAt(target, seconds = 2.5) { lookFor(target, seconds); },
    /** Lip-sync a playing <audio> (a crew bark, the companion's own line) with a short talk gesture. */
    speak(audioEl) {
      if (!audioEl || disposed) return;
      lip.speak(audioEl);
      const sec = Number.isFinite(audioEl.duration) ? audioEl.duration : 2;
      face("talk");
      if (mode === "idle" || work?.task === "command" || work?.task === "idle") {
        lookFor("captain", clamp(sec, 1.5, 5));
        if (shown === "vrm" && V && !V.motions.busy) V.motions.play("talk", { cut: clamp(sec, 1.2, 2.5), trimLeadIn: true });
        else if (standee) standee.pulse(clamp(sec, 1.2, 4));
      }
    },
    /** On a call (no audio here): a talk gesture without mouth flaps. */
    talkPulse(sec = 1.8) {
      if (disposed) return;
      const s = clamp(sec, 1.2, 2.5);
      face("talk");
      if (mode === "walk" || (work && work.task !== "command" && work.task !== "idle")) return;
      if (shown === "vrm" && V) { if (!V.motions.busy) V.motions.play("talk", { cut: s, trimLeadIn: true }); }
      else standee?.pulse(s);
    },
    /** Ray test (world THREE.Ray) against a capsule around the body: the distance along the ray, or null. */
    hit(ray) {
      if (!root.visible || disposed) return null;
      root.updateMatrixWorld(true);
      const top = shown === "vrm" && V ? V.top : 1.7;
      const r = shown === "vrm" && V ? V.half : 0.32;
      const a = pose.localToWorld(_t1.set(0, 0.25, 0)), b = pose.localToWorld(_t2.set(0, Math.max(0.5, top - 0.15), 0));
      const pr = new THREE.Vector3(), ps = new THREE.Vector3();
      const d2 = ray.distanceSqToSegment(a, b, pr, ps);
      if (d2 > r * r) return null;
      return ray.origin.distanceTo(pr);
    },
    /** The name tag on (hover) or off. */
    hover(on) { hovered = !!on; tag.show(hovered); },
    get hovered() { return hovered; },
    setOutlines(on) { outlines = !!on; if (V) setOutlines(V.vrm.scene, outlines); },
    async setKind(next) {
      wantKind = next === "standee" ? "standee" : "vrm";
      if (wantKind === "standee") { await showStandee(); return; }
      if (V) showVrm();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lip.dispose();
      tag.dispose();
      shadow.dispose();
      props.dispose();
      if (V) { V.motions.dispose(); try { VRMUtils.deepDispose(V.vrm.scene); } catch { /* */ } V = null; }
      standee?.dispose();
      lookProxy.removeFromParent();
      lookAnchor.removeFromParent();
      root.removeFromParent();
    },
  };
}
