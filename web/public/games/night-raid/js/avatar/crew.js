// Night Raid: the Rexmaw's crew on deck (spec §0.4, §4, §6 "Crew on deck").
//
// Rex, Eve, Ara, Sal and Leo stand on deck as their real VRMs, in the outfit
// each has on right now, and so does the first mate: the companion playing,
// who is one of the five (that member IS the companion) or an extra figure
// on the quarterdeck ("me"). They load one after another behind the title
// (the companion first) with progress callbacks; a paper standee stands in
// for each until their model is up, and for good when it can't be.
//
// The core's state drives them: each member's {station, task, x?, z?,
// overboard?} (state.crew) puts them on a station spot (the scene's STATIONS
// table, several spots per station filled in a stable order) and they walk
// there over the deck walk graph and work it; batteries pace the gunners;
// contacts, the marked contact and the Kraken's arms are what they look at.
// The run's events make them react (member.js has the repertoire). Crew
// barks played on the kit's voice channel (lib/crew.js → RexGame.voice.play)
// are caught here by their file name and lip-synced on the member who
// recorded them; the companion's own lines arrive through speak("me", audio).
//
// API: createCrew(R, opts) → {ready, update(state, dt), event(name, p),
// member(id), pick(ray), hover(id), speak(who, audio), talkPulse(who, sec),
// setQuality(q), setKind(kind), cast, dispose}. Documented in the spec's
// nightraid-interfaces.md under "## crew API".

import * as THREE from "three";
import { resolveCast, CREW_IDS } from "./vrm.js";
import { createMember, STATION_TASK } from "./member.js";
import { normalizeStations, normalizeGraph, HOME } from "./deck.js";
import { createFixtures } from "./props.js";
import { STATIONS as SCENE_STATIONS, WALK as SCENE_WALK } from "../scene/stations.js";

const AVATAR_LAYER_DEFAULT = 2;
/** Spring bones run within this many metres of the camera, per quality tier (spec: 60 m). */
const SPRING_DIST = { low: 25, medium: 45, high: 60, ultra: 80 };
const BATTLE_STATES = new Set(["approach", "broadside", "ram"]);
const LINES_URL = "/games/lib/crew/lines.json";
const ALIASES = { me: "me", "first mate": "me", first_mate: "me", firstmate: "me", companion: "me", mate: "me", you: "me" };

/**
 * The crew on deck.
 * @param {object} R  the render context (scene, camera, shipSpace, renderer, onFrame, onQuality, quality, LAYERS)
 * @param {{bus?: object, agentId?: number|null, stations?: object|false|null, walkGraph?: object|false|null, members?: string[]|null,
 *   agents?: object[]|null, kind?: "vrm"|"standee", fixtures?: boolean|null, tapVoice?: boolean,
 *   onProgress?: (fraction: number, info: object) => void}} opts
 *   `stations` / `walkGraph` default to scene/stations.js's STATIONS and WALK; `false` uses this module's provisional
 *   tables (deck.js). `fixtures` (a pump and a galley stove of our own) default on only with the provisional table:
 *   the scene's deckprops.js builds the real ones.
 */
export function createCrew(R, { bus = null, agentId = null, stations = null, walkGraph = null, members = null, agents = null,
  kind = "vrm", fixtures = null, tapVoice = true, onProgress = null } = {}) {
  const layer = R?.LAYERS?.AVATAR ?? R?.layers?.AVATAR ?? AVATAR_LAYER_DEFAULT;
  const parent = R?.shipSpace || R?.scene;
  const provisional = stations === false;
  let STATIONS = normalizeStations(provisional ? null : stations || SCENE_STATIONS);
  let graph = normalizeGraph(walkGraph === false ? null : walkGraph || SCENE_WALK);
  if (fixtures == null) fixtures = provisional;
  const list = [];                          // members, companion first
  const byId = new Map();
  let companionId = null;
  let disposed = false;
  let lastState = null;
  let selfDrive = typeof R?.onFrame === "function";
  let quality = R?.quality?.tier || "high";
  const emit = (type, payload) => { try { bus?.emit?.(type, payload); } catch { /* the audio is a nicety */ } };

  // Fixtures (the pumps, the galley stove) at the stations that need them.
  const fx = fixtures ? createFixtures(parent, layer) : null;
  const fixtureMap = new Map();
  function buildFixtures() {
    if (!fx) return;
    for (const spot of STATIONS.pumps || []) if (spot.fixture !== false && !fixtureMap.has(spot)) fixtureMap.set(spot, fx.pump(spot));
    const g = STATIONS.galley?.[0];
    if (g && g.fixture !== false && !fixtureMap.has(g)) fixtureMap.set(g, fx.stove(g));
  }
  buildFixtures();

  // ---- Per-frame facts the members read ---------------------------------------------------------
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const contactPos = new Map();             // id → world Vector3
  const _w = new THREE.Vector3(), _l = new THREE.Vector3();
  const frame = {
    camPos, frustum, springDist: SPRING_DIST[quality] ?? 60, battle: false, marked: null, nearest: null,
    loaded: (side) => { const b = lastState?.batteries?.[side]; return Number.isFinite(b?.loaded) ? b.loaded : null; },
    targetFor: (side, root) => targetFor(side, root),
    watchFor: () => frame.marked || frame.nearest || wavePoint(),
    krakenFor: (root) => krakenFor(root),
  };

  const toShip = (world, out) => (parent && parent !== R?.scene ? parent.worldToLocal(out.copy(world)) : out.copy(world));
  const toWorld = (local, out) => (parent && parent !== R?.scene ? parent.localToWorld(out.copy(local)) : out.copy(local));

  /** A battery's target: its named contact, else the nearest contact on that side (ahead for the bow chaser). */
  function targetFor(side, root) {
    const b = lastState?.batteries?.[side];
    const tgt = b?.target;
    if (tgt != null && contactPos.has(String(tgt))) return contactPos.get(String(tgt));
    if (tgt != null) {
      const c = (lastState?.contacts || []).find((x) => x && (String(x.name || "").toLowerCase() === String(tgt).toLowerCase()));
      if (c && contactPos.has(String(c.id))) return contactPos.get(String(c.id));
    }
    if (tgt === "marked" && frame.marked) return frame.marked;
    let best = null, bd = Infinity;
    for (const p of contactPos.values()) {
      const l = toShip(p, _l);
      const ok = side === "port" ? l.x > 0 : side === "starboard" ? l.x < 0 : side === "bow" ? l.z > Math.abs(l.x) : true;
      if (!ok) continue;
      const d = Math.hypot(l.x, l.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best || frame.marked || frame.nearest || null;
  }

  function wavePoint() {
    const w = lastState?.hazards?.wave;
    if (w && Number.isFinite(w.x) && Number.isFinite(w.z)) return _w.set(w.x, 2, w.z);
    return null;
  }

  /** The Kraken's arm at this member's station, as a world point on the rail; else any arm's station. */
  const krakenPoint = new THREE.Vector3();
  function krakenFor(root) {
    const arms = lastState?.hazards?.kraken?.arms;
    if (!Array.isArray(arms) || !arms.length) return null;
    const m = list.find((x) => x.root === root);
    const arm = arms.find((a) => a && a.station === m?.station && (a.hp ?? 1) > 0) || arms.find((a) => a && (a.hp ?? 1) > 0);
    const spot = arm && STATIONS[arm.station]?.[0];
    if (!spot) return null;
    const side = Math.sign(spot.pos.x) || 1;
    return toWorld(_l.set(side * 4.6, spot.pos.y + 2.2, spot.pos.z), krakenPoint);
  }

  function refreshFrame() {
    const cam = R?.camera;
    if (cam) {
      cam.updateMatrixWorld();
      cam.getWorldPosition(camPos);
      projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
    }
    const s = lastState;
    contactPos.clear();
    let near = null, nd = Infinity, battle = false;
    const shipW = parent?.getWorldPosition?.(_w) || _w.set(0, 0, 0);
    for (const c of s?.contacts || []) {
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z) || c.state === "sunk") continue;
      const p = new THREE.Vector3(c.x, 3, c.z);
      contactPos.set(String(c.id), p);
      const d = Math.hypot(c.x - shipW.x, c.z - shipW.z);
      if (d < nd && c.state !== "sinking") { nd = d; near = p; }
      if (BATTLE_STATES.has(c.state) || c.firing) battle = true;
    }
    frame.nearest = nd < 900 ? near : null;
    frame.marked = s?.marked != null ? contactPos.get(String(s.marked)) || null : null;
    frame.battle = battle || !!s?.boarding || (s?.projectiles?.length > 0);
  }

  // ---- The cast ---------------------------------------------------------------------------------

  const C = {
    R, layer, parent, emit, frame,
    get graph() { return graph; },
    personality: (id) => (id === "me" ? "me" : id),
    dropFor: (id, task) => dropFor(id, task),
  };

  function resolveWho(who) {
    if (who == null) return null;
    const k = String(who).trim().toLowerCase();
    if (ALIASES[k]) return companionId;
    if (byId.has(k)) return k;
    const m = list.find((x) => x.name.toLowerCase() === k);
    return m ? m.id : null;
  }

  /** The member, by id ("rex"…"leo", "me"), name, or alias ("me", "first mate", "companion"). */
  const member = (who) => byId.get(resolveWho(who)) || null;

  /** Where a shuttle job goes next: powder to the battery reloading slowest, tea to someone working on the main deck. */
  function dropFor(id, task) {
    if (task === "carry") {
      const sides = ["port", "starboard", "bow"].filter((s) => STATIONS[s === "bow" ? "bow_chaser" : `guns_${s}`]?.length);
      const bat = lastState?.batteries || {};
      let side = sides.filter((s) => Number.isFinite(bat[s]?.loaded) && bat[s].loaded < 1).sort((a, b) => bat[a].loaded - bat[b].loaded)[0];
      if (!side) side = sides[(dropFor.n = (dropFor.n || 0) + 1) % Math.max(1, Math.min(2, sides.length))];
      const g = STATIONS[side === "bow" ? "bow_chaser" : `guns_${side}`]?.[0];
      if (!g) return null;
      // Set down a pace inboard and aft of the gunner (not on their toes), facing the gun.
      const inboard = -Math.sign(g.pos.x || 0) || -1;
      return { pos: new THREE.Vector3(g.pos.x + inboard * 0.7, g.pos.y, g.pos.z - 1.25), yaw: g.yaw };
    }
    if (task === "serve") {
      const busy = list.filter((m) => m.id !== id && m.root.visible && m.mode === "work" && m.position.y < 1 && m.overboardStage == null);
      const m = busy[(dropFor.k = (dropFor.k || 0) + 1) % Math.max(1, busy.length)];
      if (m) {
        const p = m.position;
        const fwd = new THREE.Vector3(Math.sin(m.root.rotation.y), 0, Math.cos(m.root.rotation.y));
        const at = p.clone().addScaledVector(fwd, 0.9);
        at.x = THREE.MathUtils.clamp(at.x, -3.0, 3.0);
        return { pos: at, yaw: Math.atan2(p.x - at.x, p.z - at.z) };
      }
      return { pos: new THREE.Vector3(-2.9, 0, -1.2), yaw: Math.PI };
    }
    return null;
  }

  // ---- Stations from the state --------------------------------------------------------------------

  const ORDER = [...CREW_IDS, "me"];
  function crewStateOf(m) {
    const cs = lastState?.crew;
    if (!cs) return null;
    if (m.isCompanion) return cs[m.id] ?? cs.me ?? null;
    return cs[m.id] ?? null;
  }

  function applyState() {
    if (!lastState) return;
    // Who wants which station (stable order), so two never share a spot.
    const take = new Map();
    // The first mate takes a station's first spot (beside the wheel on the quarterdeck).
    for (const m of [...list].sort((a, b) => (b.isCompanion ? 1 : 0) - (a.isCompanion ? 1 : 0) || ORDER.indexOf(a.id) - ORDER.indexOf(b.id))) {
      const s = crewStateOf(m);
      if (!s) continue;
      // Overboard first.
      const ob = s.overboard;
      if (ob && !m.overboardStage) m.overboard("swept");
      else if (ob === "lost" && m.overboardStage && m.overboardStage !== "sink" && m.overboardStage !== "gone") m.overboard("lost");
      else if (!ob && m.overboardStage) m.overboard(m.overboardStage === "gone" ? "reset" : "rescued");
      if (ob) continue;
      const station = s.station && (STATIONS[s.station] || s.station === "repel") ? s.station : null;
      let spot = null;
      if (Number.isFinite(s.x) && Number.isFinite(s.z)) {
        // A job at a place (a leak, a fire): face the nearer rail there.
        const y = Number.isFinite(s.y) ? s.y : s.z < -4.45 && Math.abs(s.x) < 4.2 ? 2.6 : 0;
        spot = { pos: new THREE.Vector3(s.x, y, s.z), yaw: (Math.sign(s.x) || 1) * Math.PI / 2 };
      } else if (station) {
        let spots = STATIONS[station] || repelSpots();
        if (station === "boarding") spots = boardingOrder(spots);
        const i = take.get(station) || 0;
        take.set(station, i + 1);
        const base = spots[i % spots.length];
        const extra = Math.floor(i / spots.length);
        spot = base;
        if (extra) {
          const leftV = new THREE.Vector3(Math.cos(base.yaw), 0, -Math.sin(base.yaw));
          spot = { pos: base.pos.clone().addScaledVector(leftV, 0.75 * extra), yaw: base.yaw, fixture: base.fixture };
        }
      } else {
        const h = HOME[m.isCompanion && m.id !== "me" ? m.id : m.id] || HOME.me;
        spot = { pos: new THREE.Vector3(h.x, h.y, h.z), yaw: THREE.MathUtils.degToRad(h.yaw) };
      }
      m.assign({ station: station || (s.station ?? null), task: s.task ?? null, spot, fixture: fixtureMap.get(spot) || null });
    }
  }

  /** Repelling the Kraken: at the rail by each grabbed station (the arms still holding), else the boarding spots. */
  let repelCache = { key: "", spots: null };
  function repelSpots() {
    const arms = (lastState?.hazards?.kraken?.arms || []).filter((a) => a && (a.hp ?? 1) > 0 && STATIONS[a.station]);
    const key = arms.map((a) => `${a.id}:${a.station}`).join(",");
    if (repelCache.key === key && repelCache.spots) return repelCache.spots;
    const spots = arms.map((a) => {
      const sp = STATIONS[a.station][0];
      const side = Math.sign(sp.pos.x) || 1;
      const x = Math.abs(sp.pos.x) > 2 ? sp.pos.x : side * 2.9;
      return { pos: new THREE.Vector3(x, sp.pos.y, sp.pos.z + 0.6), yaw: side * Math.PI / 2 };
    });
    repelCache = { key, spots: spots.length ? spots : STATIONS.boarding };
    return repelCache.spots;
  }

  /** Boarding spots on the side of the ship being boarded first. */
  function boardingOrder(spots) {
    const id = lastState?.boarding?.enemyId ?? lastState?.proposal?.target ?? null;
    const p = id != null ? contactPos.get(String(id)) : null;
    if (!p) return spots;
    const side = Math.sign(toShip(p, _l).x) || 1;
    return [...spots].sort((a, b) => (Math.sign(b.pos.x) === side ? 1 : 0) - (Math.sign(a.pos.x) === side ? 1 : 0));
  }

  // ---- Loading ------------------------------------------------------------------------------------

  const progress = (fraction, info) => {
    try { onProgress?.(Math.max(0, Math.min(1, fraction)), info); } catch { /* */ }
    emit("crew_progress", { fraction, ...info });
  };

  const ready = (async () => {
    const { cast, companionId: cid } = await resolveCast({ agentId, agents, members });
    if (disposed) return [];
    companionId = cid;
    for (const c of cast) {
      const m = createMember(C, c);
      list.push(m);
      byId.set(c.id, m);
      const h = HOME[c.id] || HOME.me;
      const qd = STATIONS.quarterdeck?.[0];
      m.place(c.id === "me" && qd ? qd : { pos: new THREE.Vector3(h.x, h.y, h.z), yaw: THREE.MathUtils.degToRad(h.yaw) });
    }
    if (kind === "standee") list.forEach((m) => m.setKind("standee"));
    const total = list.length;
    const report = [];
    progress(0, { done: 0, total, id: null, name: null, stage: "start" });
    for (let i = 0; i < list.length; i++) {
      if (disposed) break;
      const m = list[i];
      progress(i / total, { done: i, total, id: m.id, name: m.name, stage: "loading" });
      const info = kind === "standee" ? { ok: false, error: "standee setting" } : await m.load((f) => progress((i + f * 0.9) / total, { done: i, total, id: m.id, name: m.name, stage: "loading" }));
      report.push({ id: m.id, name: m.name, ...info });
      progress((i + 1) / total, { done: i + 1, total, id: m.id, name: m.name, stage: info.ok ? "loaded" : "standee", ok: !!info.ok });
    }
    applyState();
    return report;
  })().catch((error) => { console.debug("[night-raid] crew: setup failed", error); return []; });

  // ---- The frame ----------------------------------------------------------------------------------

  function step(dt) {
    if (disposed) return;
    refreshFrame();
    for (const m of list) {
      try { m.update(dt); } catch (error) {
        // One figure's bad frame must not stop the others.
        if ((m.__fails = (m.__fails || 0) + 1) <= 3) console.debug(`[night-raid] crew: ${m.name}'s frame failed`, error);
      }
    }
  }

  let offFrame = null, offTick = null, offQuality = null;
  if (selfDrive) offFrame = R.onFrame((dt) => { if (selfDrive) step(dt); }, 25);
  if (bus?.on) offTick = bus.on("tick", (s) => { if (s && typeof s === "object") { lastState = s; applyState(); } });
  if (typeof R?.onQuality === "function") offQuality = R.onQuality((q) => api.setQuality(q));

  // ---- Voice: crew barks off the kit's channel ------------------------------------------------------

  let lineWho = null;
  const linesLoaded = tapVoice ? fetch(LINES_URL).then((r) => (r.ok ? r.json() : null)).then((d) => {
    lineWho = new Map((d?.lines || []).map((l) => [l.id, String(l.who || "").toLowerCase()]));
  }).catch(() => { lineWho = new Map(); }) : Promise.resolve();
  let tapped = null, tapTimer = 0;
  function installTap() {
    const voice = window.RexGame?.voice;
    if (!voice?.play || voice.play.__nrCrew) return !!voice?.play;
    const orig = voice.play;
    const wrapped = function (url, opts = {}) {
      const m = /\/crew\/([^/?#]+)\.mp3/.exec(String(url || ""));
      if (!m) return orig.call(this, url, opts);
      const lineId = decodeURIComponent(m[1]);
      const onStart = opts?.onStart;
      return orig.call(this, url, { ...opts, onStart: (a) => {
        try { onStart?.(a); } finally {
          const who = lineWho?.get(lineId) || (/^(?:nh|nr)-([a-z]+)-/.exec(lineId)?.[1]) || (/^([a-z]+)-/.exec(lineId)?.[1]) || null;
          if (who && a) api.speak(who, a);
        }
      } });
    };
    wrapped.__nrCrew = true;
    voice.play = wrapped;
    tapped = { voice, orig };
    return true;
  }
  if (tapVoice) {
    let tries = 0;
    const poll = () => { if (disposed || installTap() || ++tries > 40) return; tapTimer = setTimeout(poll, 500); };
    poll();
  }

  // ---- Events ---------------------------------------------------------------------------------------

  const each = (fn) => list.forEach((m) => { try { fn(m); } catch (error) { console.debug("[night-raid] crew reaction failed", error); } });
  const stagger = () => Math.random() * 0.5;
  const worldOf = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.z) ? new THREE.Vector3(p.x, Number.isFinite(p.y) ? p.y : 2, p.z) : null);

  const api = {
    ready,
    /** Who's on deck: [{id, name, role, isCompanion, kind, station, task, mode}]. */
    get cast() { return list.map((m) => ({ id: m.id, name: m.name, role: m.cast.role, isCompanion: m.isCompanion, kind: m.kind, station: m.station, task: m.task, mode: m.mode, overboard: m.overboardStage })); },
    /** The member id that is the companion ("rex"…"leo" or "me"), once ready. */
    get companionId() { return companionId; },
    member,

    /**
     * The core's state (10 Hz) and the frame step. Calling it with dt > 0 takes over the frame from R.onFrame.
     * @param {object|null} state  run.state(): crew, batteries, contacts, marked, hazards, boarding…
     * @param {number} [dt]
     */
    update(state, dt = 0) {
      if (state && typeof state === "object" && state !== lastState) { lastState = state; applyState(); }
      if (dt > 0) { selfDrive = false; step(dt); }
    },

    /** A run event (spec §7 events): impact, brace, volley, sink, surrender, board, bank, reward, overboard, crew_line, say, order, hazard, contact, fire, end, start. */
    event(name, p = {}) {
      if (disposed) return;
      p = p || {};
      switch (name) {
        case "impact": {
          if (p.target && p.target !== "rexmaw") return;
          const w = worldOf(p);
          const local = w ? toShip(w, new THREE.Vector3()) : null;
          // A splash is a near miss: only those right beside it flinch.
          const heavy = p.kind !== "splash" && ((Number(p.dmg) || 6) >= 5 || p.kind === "crew");
          each((m) => {
            if (m.overboardStage) return;
            const d = local ? m.position.distanceTo(local) : Infinity;
            if (d < 4.5) m.react("flinch", { from: local });
            else if (heavy) m.react("brace", { delay: Math.random() * 0.15 });
          });
          break;
        }
        case "brace": each((m) => m.react("brace", { delay: Math.random() * 0.1 })); break;
        case "volley": {
          const sides = p.side === "both" ? ["port", "starboard"] : [p.side];
          const st = new Set(sides.map((s) => (s === "bow" ? "bow_chaser" : `guns_${s}`)));
          const at = p.target != null ? contactPos.get(String(p.target)) : null;
          each((m) => {
            if (st.has(m.station)) m.react("recoil");
            else if (at && !m.overboardStage) m.lookAt(at, 2.5);
          });
          break;
        }
        case "sink":
        case "surrender": {
          const at = contactPos.get(String(p.id)) || null;
          each((m) => m.react("cheer", { delay: stagger(), at }));
          break;
        }
        case "board": {
          if (p.stage === "start" || p.stage === "round") each((m) => { if (m.station === "boarding") m.react("slash"); });
          else if (p.stage === "won") each((m) => m.react("cheer", { delay: stagger() }));
          else if (p.stage === "lost") each((m) => m.react("sad"));
          break;
        }
        case "bank": each((m) => m.react("cheer", { delay: stagger() })); break;
        case "reward": if (p.choice) member("me")?.react("order"); break;
        case "overboard": {
          const m = member(p.who);
          if (m && p.stage) m.overboard(p.stage === "swept" ? "swept" : p.stage === "rescued" ? "rescued" : p.stage === "lost" ? "lost" : p.stage, { side: p.side ?? null });
          if (p.stage === "swept") each((o) => { if (o !== m && !o.overboardStage) o.lookAt(m?.root || null, 2.5); });
          if (p.stage === "rescued") each((o) => { if (o !== m) o.react("cheer", { delay: 2.6 + stagger() }); });
          break;
        }
        case "crew_line": { if (p.audio) api.speak(p.who, p.audio); break; }
        case "say": member("me")?.talkPulse(Math.min(2.5, 0.9 + String(p.text || "").length / 40)); break;
        case "order": {
          if (p.by != null && resolveWho(p.by) !== companionId && !/^(me|first|mate|companion|ai)/i.test(String(p.by))) break;
          const tgt = p.payload?.target ?? p.target ?? null;
          const at = tgt != null ? contactPos.get(String(tgt)) || null : null;
          member("me")?.react(at ? "point" : "order", { at });
          break;
        }
        case "hazard": {
          if (p.kind === "kraken" && /ink|rise|appear|grab|start/.test(String(p.stage))) each((m) => m.react("scared", { at: worldOf(p), delay: stagger() }));
          else if (p.kind === "wave" && /telegraph|warn|spotted|start|spawn|appear/.test(String(p.stage))) {
            const at = wavePoint() || worldOf(p);
            each((m) => { if (m.station === "lookout") m.react("point", { at }); else if (at) m.lookAt(at.clone(), 3); });
          }
          break;
        }
        case "contact": {
          if (p.appear === false || p.stage === "lost" || p.lost) break;
          const at = contactPos.get(String(p.id)) || worldOf(p);
          if (at) each((m) => { if (m.station === "lookout") m.react("point", { at }); });
          break;
        }
        case "fire": {
          if (p.target && p.target !== "rexmaw") break;
          if (!(p.start || p.stage === "start")) break;
          const w = worldOf(p);
          if (!w) break;
          const l = toShip(w, new THREE.Vector3());
          each((m) => { if (!m.overboardStage && m.position.distanceTo(l) < 3) m.react("flinch", { from: l }); });
          break;
        }
        case "end": if (/sunk|sink|caught|dawn/.test(String(p.reason))) each((m) => m.react("sad")); break;
        case "start": case "reset": each((m) => { if (m.overboardStage) m.overboard("reset"); }); break;
        default: break;
      }
    },

    /** Ray-pick a crew member: a THREE.Ray / Raycaster (world), or {x, y} in NDC. Returns {kind: "crew", id, name, role, distance} | null. */
    pick(ray, { hover = false } = {}) {
      let r = null;
      const isRay = (x) => !!x?.origin && !!x?.direction && typeof x.distanceSqToSegment === "function";
      if (isRay(ray)) r = ray;
      else if (isRay(ray?.ray)) r = ray.ray;
      else if (Number.isFinite(ray?.x) && Number.isFinite(ray?.y) && R?.camera) {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(ray.x, ray.y), R.camera);
        r = rc.ray;
      }
      if (!r) return null;
      let best = null, bd = Infinity;
      for (const m of list) {
        const d = m.hit(r);
        if (d != null && d < bd) { bd = d; best = m; }
      }
      if (hover) api.hover(best?.id ?? null);
      return best ? { kind: "crew", id: best.id, name: best.name, role: best.cast.role, distance: bd } : null;
    },

    /** pick() at a pointer position in CSS pixels (clientX/Y), e.g. from a pointermove; {hover: true} shows that member's tag. */
    pickAt(px, py, opts = {}) {
      const el = R?.renderer?.domElement;
      const r = el?.getBoundingClientRect?.() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
      if (!(r.width > 0 && r.height > 0)) return null;
      return api.pick({ x: ((px - r.left) / r.width) * 2 - 1, y: -((py - r.top) / r.height) * 2 + 1 }, opts);
    },

    /** Show one member's name tag (null hides them all). */
    hover(who) {
      const id = who == null ? null : resolveWho(who);
      for (const m of list) m.hover(m.id === id);
    },

    /** Lip-sync a playing <audio> on a member ("me" = the companion), with a short talk gesture. */
    speak(who, audioEl) { member(who)?.speak(audioEl); },
    /** A talk gesture without mouth flaps (on a call); default the companion. */
    talkPulse(who = "me", sec = 1.8) { member(who)?.talkPulse(sec); },

    /** Quality: a tier name or R.quality. Low drops MToon outlines; spring bones run within 25/45/60/80 m. */
    setQuality(q) {
      quality = typeof q === "string" ? q : q?.tier || quality;
      frame.springDist = SPRING_DIST[quality] ?? 60;
      for (const m of list) m.setOutlines(quality !== "low");
    },

    /** The Avatar setting: "vrm" (3D) or "standee" (Portrait), live. */
    async setKind(next) {
      kind = next === "standee" ? "standee" : "vrm";
      await ready;
      for (const m of list) m.setKind(kind);
      if (kind === "vrm") for (const m of list) if (!m.loadInfo.ok && m.cast.urls?.vrmUrl && m.loadInfo.error === "standee setting") await m.load();
    },

    /** Station names and spots in use (for debugging and the HUD). */
    get stations() { return STATIONS; },
    get stationTasks() { return { ...STATION_TASK }; },

    dispose() {
      if (disposed) return;
      disposed = true;
      offFrame?.(); offTick?.(); offQuality?.();
      clearTimeout(tapTimer);
      if (tapped && tapped.voice.play?.__nrCrew) tapped.voice.play = tapped.orig;
      for (const m of list) m.dispose();
      fx?.dispose();
      list.length = 0;
      byId.clear();
      void linesLoaded;
    },
  };
  return api;
}
