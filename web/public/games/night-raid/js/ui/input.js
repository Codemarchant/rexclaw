// The Captain's hands (v2 §1, §3; v3 §B5, §B7): keyboard and mouse into
// intents on the bus, Black Flag style. Never calls into the sim.
//
//   mouse              CURSOR AIM (default): the look follows where the cursor
//                      is: the middle = ahead, the left half = port, the right
//                      half = starboard, the far edges = the astern quarters
//                      (a small dead zone in the middle, smoothed); higher on
//                      the screen tilts the look up (and aims farther). Over a
//                      HUD control or the helm strip the look holds still.
//                      FREE LOOK (Settings → Mouse): click the sea to capture
//                      the mouse (pointer lock); moving it swings the camera;
//                      Esc lets go. If the window refuses the capture, cursor
//                      aim stands in and Settings says why.
//   right mouse / Q    hold to aim (broadsides draw their arcs); the right
//                      mouse's aim starts after HOLD_MS (220 ms) held, so a tap
//                      never zooms; a hold that began on a ship locks her too
//   right-click        (a tap) on or near a ship: LOCK her as the target
//                      (`lock {contactId}`; the scene's pick is generous); on
//                      her again, or on open sea: clear it (`lock {contactId:null}`)
//                      Chorded presses (left while right is held, and back)
//                      arrive as pointermoves with `button` set: handled too
//   Tab / middle click cycle the lock through the ships in sight (`lock_cycle
//                      {dir}`, Shift+Tab backwards); a middle click on a ship
//                      locks that one. Esc clears a lock (with none: pause).
//                      The arcs snap to the locked ship (core), the reticle
//                      names her, her tag and hull wear the gilt bracket.
//   left click / F     fire the weapon the look picks (`fire {}`); a tap without
//                      aiming on a broadside look is the heavy close volley; on a
//                      glowing weak point it's the swivel gun instead
//   1 / 2 / 3          crew mode Hold / Attack / Defend (`crew_mode {mode}`)
//   BOARDING FIGHT     (v4, `state.boardfight`): a click on an enemy fires the
//                      Captain's pistol (`pistol {foeId}`, ui/boarding.js picks
//                      him), F rallies the crew once (`rally`); the look stays
//                      put (the scene's fight camera has the view)
//   mouse wheel        zoom: the scene binds it on the canvas (deck level ⇄ tactical)
//   M                  mortar mode on / off
//   A / D, ← / →       the wheel, held (`wheel {value}`, eased, 0 on release)
//   W / S, ↑ / ↓       sails up / down (`sail {delta}`)
//   Shift (hold)       sprint at full sail (`sprint {on}`)
//   Space              brace
//   E (hold)           the spyglass (`spyglass {on, contactId}`)
//   Y / N              take / wave off the companion's suggestion
//   B                  board (inside a ship's 30 m ring) · C helm view · Esc
//                      pause (at the briefing: Back)
//   Enter / W          at the briefing: Set sail (`start_voyage`)
//
// Every frame the look or the aim changes it goes out twice: the UI event
// `look {yaw, pitch, aiming, mode, locked, cursor}` (the camera and the HUD
// follow it) and the core intent `aim {lookYawRel, lookPitch, aiming, mode}`.
//
// Keys stand down while a text field has focus (the kit's chat dock), while
// the settings or results are open, and outside the phases the helm works in.

import { typing, clamp, angleDiff, reticlePoint, store, lockOf } from "./dom.js";
import { readSettings } from "./settings.js";

const HELM = new Set(["moored", "sailing", "boarding"]);
const RAMP_S = 0.25;            // seconds from centre to full lock on the wheel
const SPY_EVERY_MS = 200;       // the spyglass re-reports the contact under the crosshair this often
const SENS = 0.16;              // free look: degrees of look per pixel of mouse
const PITCH = [-32, 24];        // look pitch range (°, + up)
// Right mouse: a tap (released within HOLD_MS, moved under TAP_PX) locks / lets go of the ship under it with no aim
// zoom; held past HOLD_MS (or dragged) it aims, and a hold that began on a ship locks her too.
const HOLD_MS = 220, TAP_PX = 7;
const CREW_KEYS = { 1: "hold", 2: "attack", 3: "defend" };

/**
 * Cursor aim: screen position → look. The scene's own mapping (world.shots.cursorLook, the camera's
 * numbers in scene/follow.js FOLLOW.cursor) is used when the scene is up, so the HUD and the camera
 * agree; this copy of it serves without WebGL and in the harness.
 *   x: |u| ≤ DEAD of the half-width from the middle = dead ahead; beyond it the yaw grows to
 *      ±EDGE_YAW at the edge (curve 0.9: chain ≤ 40° ≈ the middle quarter, the broadsides 40–140°,
 *      the astern barrels in the outer ~12 % each side).
 *   y: the middle = PITCH_REST; the top adds PITCH_UP°, the bottom takes PITCH_DOWN° (same dead zone).
 * The scene eases the camera to it (τ 0.14 s); this layer only de-jitters (TAU 0.04 s).
 */
export const CURSOR_AIM = Object.freeze({ DEAD: 0.07, EDGE_YAW: 165, CURVE: 0.9, PITCH_REST: -11, PITCH_UP: 10, PITCH_DOWN: 16, TAU: 0.04 });
/** Cursor aim's mortar view: the outer EDGE of the width each side turns the view, up to PAN °/s at the very edge. */
const MORTAR_VIEW = Object.freeze({ EDGE: 0.06, PAN: 70 });
export function cursorLook(x, y, w = innerWidth, hgt = innerHeight, invert = false) {
  const A = CURSOR_AIM;
  const nx = clamp((x / Math.max(1, w)) * 2 - 1, -1, 1), ny = clamp(-((y / Math.max(1, hgt)) * 2 - 1), -1, 1) * (invert ? -1 : 1);
  const u = clamp((Math.abs(nx) - A.DEAD) / (1 - A.DEAD), 0, 1);
  const v = Math.sign(ny) * clamp((Math.abs(ny) - A.DEAD) / (1 - A.DEAD), 0, 1);
  return { yaw: Math.sign(nx) * A.EDGE_YAW * Math.pow(u, A.CURVE), pitch: A.PITCH_REST + (v > 0 ? v * A.PITCH_UP : v * A.PITCH_DOWN) };
}

/**
 * @param {object} ctx  the UI context
 * @param {{suggestions?: object, boarding?: object, settings?: object, hud?: object, crewModes?: object}} parts
 */
export function createInput(ctx, parts = {}) {
  const { bus } = ctx;
  const held = { left: false, right: false };
  let wheel = 0, sent = 0, raf = 0, lastT = 0;
  let spy = false, spyTimer = 0;
  let enabled = true;
  const S0 = readSettings();
  const look = { yaw: 0, pitch: -6, aiming: false, mode: "auto", locked: false, invert: !!S0.invertLook };
  let mouseMode = S0.mouse;      // "cursor" | "free"
  let lockDenied = false;
  const aimBy = { mouse: false, key: false };
  let lookDirty = true, lookRaf = 0, cursor = { x: innerWidth / 2, y: innerHeight * 0.46 }, cursorLive = false, lastLookT = 0;
  // Cursor aim's mortar: the circle goes where the cursor points on the sea (world.mortarPoint), not along the look.
  let mortarPt = null, pointDirty = false;
  const pointing = () => look.mode === "mortar" && cursorAim();
  let sprinting = false, shiftAt = 0;

  const state = () => ctx.state?.() || null;
  const phase = () => state()?.phase || "title";
  const briefing = () => { const s = state(); return s?.phase === "briefing" || (s?.phase === "moored" && s?.mission?.status === "briefing"); };
  const live = () => enabled && HELM.has(phase()) && !briefing() && !state()?.paused && !document.body.classList.contains("nr-modal-open");
  const stage = ctx.dom?.stage || document.getElementById("stage");
  const cursorAim = () => mouseMode === "cursor" || !look.locked;
  /** The boarding fight has the mouse (the pistol) and F (the Rally). */
  const fighting = () => !!parts.boarding?.fighting?.();

  // ---- The wheel -----------------------------------------------------------------------

  function target() { return (held.right ? 1 : 0) - (held.left ? 1 : 0); }
  function loop(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
    lastT = now;
    const t = target();
    const step = dt / RAMP_S;
    wheel = t === 0 ? 0 : clamp(wheel + Math.sign(t - wheel) * Math.min(step, Math.abs(t - wheel)), -1, 1);
    if (Math.abs(wheel - sent) > 0.04 || (wheel === t && wheel !== sent)) { sent = wheel; bus.intent("wheel", { value: Math.round(wheel * 100) / 100 }); }
    if (t !== 0 || wheel !== 0) raf = requestAnimationFrame(loop); else lastT = 0;
  }
  function steer(side, down) {
    if (held[side] === down) return;
    held[side] = down;
    if (!down && target() === 0) { wheel = 0; if (sent !== 0) { sent = 0; bus.intent("wheel", { value: 0 }); } }
    if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); }
  }

  // ---- The look --------------------------------------------------------------------------

  const lookPayload = () => ({ lookYawRel: Math.round(look.yaw * 10) / 10, lookPitch: Math.round(look.pitch * 10) / 10, aiming: look.aiming, mode: look.mode,
    ...(pointing() && mortarPt ? { point: { x: Math.round(mortarPt.x * 10) / 10, z: Math.round(mortarPt.z * 10) / 10 } } : {}) });
  function markLook() {
    lookDirty = true;
    if (!lookRaf) lookRaf = requestAnimationFrame(flushLook);
  }
  /** Where the helm strip starts (the look holds still below it); re-measured at most twice a second. */
  let stripTop = Infinity, stripAt = 0;
  function belowStrip(y) {
    const now = performance.now();
    if (now - stripAt > 500) {
      stripAt = now;
      const el = document.querySelector("#hud .nr-bottom");
      const r = el?.getBoundingClientRect?.();
      stripTop = r && r.height > 0 ? r.top - 8 : Infinity;
    }
    return y > stripTop;
  }
  function flushLook(now) {
    lookRaf = 0;
    let again = false;
    // Cursor aim: ease toward the look the cursor's place asks for (not in a boarding fight: its camera has the view).
    if (pointing() && live() && cursorLive && !fighting()) {
      // The mortar under the cursor: the view holds still (a cursor at the left or right edge turns it) and the
      // point is re-read every frame, since the sea under a still cursor travels with her.
      const dt = Math.min(0.05, (now - (lastLookT || now)) / 1000);
      const ex = cursor.x / Math.max(1, innerWidth), E = MORTAR_VIEW.EDGE;
      const push = ex < E ? -(1 - ex / E) : ex > 1 - E ? (ex - (1 - E)) / E : 0;
      if (push) { look.yaw = wrap(look.yaw + push * MORTAR_VIEW.PAN * dt); lookDirty = true; }
      const p = ctx.world?.mortarPoint?.(cursor.x, cursor.y);
      if (p && (!mortarPt || Math.hypot(p.x - mortarPt.x, p.z - mortarPt.z) > 0.5)) { mortarPt = p; pointDirty = true; }
      again = true;
    } else if (cursorAim() && live() && cursorLive && !fighting()) {
      const dt = Math.min(0.05, (now - (lastLookT || now)) / 1000);
      const want = wantLook(cursor.x, cursor.y);
      const dy = angleDiff(want.yaw, look.yaw), dp = want.pitch - look.pitch;
      if (Math.abs(dy) > 0.05 || Math.abs(dp) > 0.05) {
        const k = dt > 0 ? 1 - Math.exp(-dt / CURSOR_AIM.TAU) : 0;
        look.yaw = wrap(look.yaw + dy * k);
        look.pitch = clamp(look.pitch + dp * k, PITCH[0], PITCH[1]);
        lookDirty = true;
        again = true;
      }
    }
    lastLookT = again ? now : 0;
    if ((lookDirty || pointDirty) && HELM.has(phase())) {
      if (lookDirty) bus.emit("look", { yaw: look.yaw, pitch: look.pitch, aiming: look.aiming, mode: look.mode, locked: look.locked, cursor: cursorAim() });
      lookDirty = false; pointDirty = false;
      bus.intent("aim", lookPayload());
    }
    if (again) lookRaf = requestAnimationFrame(flushLook);
  }
  const wrap = (deg) => angleDiff(deg, 0);
  /** The look the cursor's place asks for: the scene's mapping when it's up (camera and HUD agree), else ours. */
  function wantLook(x, y) {
    const yy = look.invert ? innerHeight - y : y;
    try {
      const l = ctx.world?.shots?.cursorLook?.(x, yy, { apply: false });
      if (l && Number.isFinite(l.yaw) && Number.isFinite(l.pitch)) return l;
    } catch { /* fall back */ }
    return cursorLook(x, yy, innerWidth, innerHeight, false);
  }
  function turnLook(dx, dy) {
    look.yaw = wrap(look.yaw + dx * SENS);
    look.pitch = clamp(look.pitch + (look.invert ? dy : -dy) * SENS * 0.8, PITCH[0], PITCH[1]);
    markLook();
  }
  function setAiming() {
    const on = (aimBy.mouse || aimBy.key) && live();
    if (on === look.aiming) return;
    look.aiming = on;
    markLook();
  }
  function toggleMortar() {
    look.mode = look.mode === "mortar" ? "auto" : "mortar";
    mortarPt = null;
    markLook();
    bus.emit("mortar_mode", { on: look.mode === "mortar" });
  }

  // ---- Free look: pointer lock -------------------------------------------------------------
  // v2's capture "didn't do anything" in the Rexclaw desktop window: Electron's session
  // permission handler (desktop/main.js) allows only media / fullscreen / clipboard, so the
  // "pointerLock" request is denied, requestPointerLock() rejects and `pointerlockerror`
  // fires; v2 swallowed that click and then fell back to an unlocked relative look that
  // ran into the screen edges. Now cursor aim is the default (no capture needed), and a
  // refused capture says so in Settings and keeps cursor aim working.

  const canLock = () => !!stage?.requestPointerLock && !lockDenied;
  function lock() {
    if (!canLock() || document.pointerLockElement === stage) return;
    try {
      const p = stage.requestPointerLock();
      if (p?.catch) p.catch(() => denied());
    } catch { denied(); }
  }
  function denied() {
    if (lockDenied) return;
    lockDenied = true;
    document.body.dataset.lock = "denied";
    bus.emit("mouse_lock", { state: "denied" });
    bus.emit("toast", { text: "This window won't capture the mouse: cursor aim is standing in (Settings → Mouse).", kind: "warn" });
  }
  function unlock() { if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { /* fine */ } } }
  document.addEventListener("pointerlockchange", () => {
    look.locked = document.pointerLockElement === stage;
    document.body.classList.toggle("nr-locked", look.locked);
    if (look.locked) { document.body.dataset.lock = "locked"; bus.emit("mouse_lock", { state: "locked" }); }
    else if (!lockDenied) { document.body.dataset.lock = ""; bus.emit("mouse_lock", { state: "free" }); }
    markLook();
  });
  document.addEventListener("pointerlockerror", () => denied());

  // ---- The spyglass ----------------------------------------------------------------------

  /** Where the Captain is pointing: the screen centre with the mouse locked, else the cursor. */
  const aimPoint = () => (look.locked ? reticlePoint() : cursor);
  function pickAt(x, y, opts) {
    try { return ctx.world?.pick?.(x, y, opts) || null; } catch { return null; }
  }
  function underCrosshair() {
    const c = reticlePoint();
    const hit = pickAt(c.x, c.y, { spyglass: true });
    if (hit && (hit.kind === "contact" || hit.kind === "weak")) return hit.contactId || hit.targetId || (hit.kind === "contact" ? hit.id : null);
    return null;
  }
  function spyglass(on) {
    if (spy === on) return;
    spy = on;
    clearInterval(spyTimer);
    parts.hud?.scope?.(on);
    if (on) {
      const report = () => bus.intent("spyglass", { on: true, contactId: underCrosshair() });
      report();
      spyTimer = setInterval(() => { if (!live()) spyglass(false); else report(); }, SPY_EVERY_MS);
    } else bus.intent("spyglass", { on: false });
  }

  // ---- Fire, the swivel gun, marking a ship ------------------------------------------------

  function swivelTarget(hit) {
    if (!hit) return null;
    if (hit.kind === "weak") return { targetId: hit.contactId || hit.targetId, weakId: hit.weakId || hit.id };
    if (hit.kind === "kraken" || hit.kind === "arm") return { targetId: "kraken", weakId: hit.armId || hit.id };
    return null;
  }
  function contactAt(x, y) {
    const hit = pickAt(x, y) || pickAt(x, y, { spyglass: true });
    if (!hit) return null;
    if (hit.kind === "contact") return hit.id;
    if (hit.kind === "weak") return hit.contactId || hit.targetId || null;
    return null;
  }
  function fire() {
    if (!live() || phase() !== "sailing") return false;
    const at = aimPoint();
    const sw = swivelTarget(pickAt(at.x, at.y));
    // v5: a click on (or near) the Kraken's eye fires everything at it: the swivel when it reaches, and the guns, the look
    // turned onto the eye so the core lays them on it (it's the locked target while it's up).
    if (sw?.targetId === "kraken_eye") {
      bus.intent("swivel", sw);
      const s = state(), E = s?.objective?.eye, P = s?.ship;
      const rel = E && P ? angleDiff(Math.atan2(-(E.x - P.x), E.z - P.z) * 180 / Math.PI - P.heading, 0) : look.yaw;
      bus.intent("fire", { ...lookPayload(), lookYawRel: Math.round(rel * 10) / 10 });
      parts.hud?.fired?.(look);
      return true;
    }
    if (sw?.targetId) { bus.intent("swivel", sw); parts.hud?.swivelShot?.(at.x, at.y); return true; }
    bus.intent("fire", lookPayload());
    parts.hud?.fired?.(look);
    return true;
  }
  /**
   * Lock a ship as THE target (v4 `lock`; the arcs snap to her, the crew in Attack and the companion's
   * "marked" use her). Locking her again clears it; `id` null clears it.
   */
  function lockTarget(id, at = null) {
    if (!live() || fighting()) return false;
    const cur = lockOf(state());
    const next = id && cur !== id ? id : null;
    if (!next && !cur) return false;
    bus.intent("lock", { contactId: next });
    parts.hud?.marked?.(next, at);
    return true;
  }
  /** Tab / a middle click on open sea: the next ship in sight (dir −1: the previous one). */
  function cycleLock(dir = 1) {
    if (!live() || fighting()) return false;
    bus.intent("lock_cycle", { dir: dir < 0 ? -1 : 1 });
    return true;
  }
  /** v3's name: right-click marking is locking now. */
  const mark = lockTarget;
  function setCrewMode(mode) {
    if (!live() || !mode) return false;
    bus.intent("crew_mode", { mode });
    parts.crewModes?.picked?.(mode);
    return true;
  }

  // ---- Keys ------------------------------------------------------------------------------

  function onDown(e) {
    if (e.defaultPrevented || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "Escape") {
      if (document.querySelector(".nr-chart.big")) return;   // the chart folds itself back
      if (document.body.classList.contains("nr-modal-open")) return;   // a panel closes itself
      if (briefing()) { bus.intent("back"); e.preventDefault(); return; }
      // A locked target: the first Esc lets go of her; with none, Esc is the pause menu.
      if (phase() === "sailing" && live() && !fighting() && lockOf(state())) { lockTarget(null); e.preventDefault(); return; }
      if (["sailing", "moored", "boarding", "ending"].includes(phase())) { parts.settings?.toggle?.(); e.preventDefault(); }
      return;
    }
    if (briefing() && enabled && !state()?.paused && !document.body.classList.contains("nr-modal-open")) {
      if ((k === "Enter" || k === "w" || k === "ArrowUp") && !e.repeat) { bus.intent("start_voyage"); e.preventDefault(); }
      return;
    }
    if (!live()) return;
    // The boarding fight: F is the Rally; the helm keys stand down (the ships are lashed together).
    if (fighting()) {
      if (k === "f" && !e.repeat) { parts.boarding?.rally?.(); e.preventDefault(); }
      return;
    }
    let used = true;
    switch (k) {
      case "Tab":
        // Shift+Tab: that Shift was for the Tab, not a sprint.
        if (e.shiftKey && sprinting && performance.now() - shiftAt < 600) { sprinting = false; bus.intent("sprint", { on: false }); }
        if (!e.repeat && phase() === "sailing") cycleLock(e.shiftKey ? -1 : 1);
        break;
      case "a": case "ArrowLeft": steer("left", true); break;
      case "d": case "ArrowRight": steer("right", true); break;
      case "w": case "ArrowUp": if (!e.repeat) bus.intent("sail", { delta: 1 }); break;
      case "s": case "ArrowDown": if (!e.repeat) bus.intent("sail", { delta: -1 }); break;
      case "Shift": if (!e.repeat && !sprinting) { sprinting = true; shiftAt = performance.now(); bus.intent("sprint", { on: true }); } break;
      case " ": if (!e.repeat) { bus.intent("brace"); parts.hud?.braced?.(); } break;
      case "q": if (!e.repeat) { aimBy.key = true; setAiming(); } break;
      case "m": if (!e.repeat) toggleMortar(); break;
      case "f": if (!e.repeat) fire(); break;
      case "e": if (!e.repeat) spyglass(true); break;
      case "b": if (!e.repeat) bus.intent("board"); break;
      case "c": if (!e.repeat) bus.intent("camera"); break;
      case "y": if (!e.repeat) parts.suggestions?.answer?.(true); break;
      case "n": if (!e.repeat) parts.suggestions?.answer?.(false); break;
      case "1": case "2": case "3":
        if (!e.repeat) used = setCrewMode(CREW_KEYS[k]);
        break;
      default: used = false;
    }
    if (used) e.preventDefault();
  }
  function onUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "a" || k === "ArrowLeft") steer("left", false);
    else if (k === "d" || k === "ArrowRight") steer("right", false);
    else if (k === "e") spyglass(false);
    else if (k === "q") { aimBy.key = false; setAiming(); }
    else if (k === "Shift" && sprinting) { sprinting = false; bus.intent("sprint", { on: false }); }
  }

  // ---- Mouse --------------------------------------------------------------------------------

  // The right mouse: tap = lock, hold = aim. `rDown` = {x, y, at (where it points), ship (under it at the press),
  // moved (px, pointer lock), aiming (the hold has begun), timer}.
  let rDown = null;
  function rmbDown(e) {
    clearTimeout(rDown?.timer);
    const at = look.locked ? reticlePoint() : { x: e.clientX, y: e.clientY };
    rDown = { x: e.clientX, y: e.clientY, at, ship: phase() === "sailing" ? contactAt(at.x, at.y) : null, moved: 0, aiming: false, timer: 0 };
    rDown.timer = setTimeout(rmbHold, HOLD_MS);
  }
  /** Held past HOLD_MS, dragged, or fired through: it's an aim (and the ship it began on is locked). */
  function rmbHold() {
    if (!rDown || rDown.aiming) return;
    clearTimeout(rDown.timer);
    rDown.aiming = true;
    if (!live()) return;
    aimBy.mouse = true; setAiming();
    if (rDown.ship && rDown.ship !== lockOf(state())) lockTarget(rDown.ship, rDown.at);
  }
  function rmbUp() {
    const r = rDown;
    if (!r) return;
    rDown = null;
    clearTimeout(r.timer);
    if (r.aiming) { aimBy.mouse = false; setAiming(); return; }
    // A tap: on or near a ship, lock her (again: let go); on open sea, let go of the lock. No aim, no zoom.
    if (!live() || phase() !== "sailing") return;
    const id = r.ship || contactAt(r.at.x, r.at.y);
    if (id) lockTarget(id, r.at);
    else if (lockOf(state())) lockTarget(null, r.at);
  }
  /** A press on the sea (pointerdown, or a chorded press: see below). */
  function pressOnSea(e) {
    if (!live()) return;
    // The boarding fight takes the left click (the pistol); nothing else on the deck answers the mouse.
    if (fighting()) {
      if (e.button === 0) { parts.boarding?.click?.(e.clientX, e.clientY); e.preventDefault(); }
      return;
    }
    // Middle click: lock the ship under it, or cycle through the ships in sight (and no auto-scroll).
    if (e.button === 1) {
      e.preventDefault();
      if (phase() !== "sailing") return;
      const at = look.locked ? reticlePoint() : { x: e.clientX, y: e.clientY };
      const id = contactAt(at.x, at.y);
      if (id && id !== lockOf(state())) lockTarget(id, at); else cycleLock(1);
      return;
    }
    if (e.button === 2) { rmbDown(e); e.preventDefault(); return; }
    if (e.button !== 0) return;
    // Free look: the first click on the sea captures the mouse (when the window allows it).
    if (mouseMode === "free" && !look.locked && canLock() && phase() === "sailing" && !swivelTarget(pickAt(e.clientX, e.clientY))) { lock(); return; }
    // Firing with the right mouse down: that press was an aim, not a tap (the shot goes out aimed).
    if (rDown && !rDown.aiming) rmbHold();
    fire();
  }
  const onSea = (e) => e.target === stage || !!stage?.contains(e.target);
  // Pointer Events send a second button's press / release (while another is held) as a pointermove with `button` set
  // (pointerdown / pointerup only mark the first press and the last release): left-click to fire while the right
  // mouse aims arrives this way.
  const BUTTON_BIT = { 0: 1, 1: 4, 2: 2 };
  function chord(e) {
    const bit = BUTTON_BIT[e.button];
    if (!bit) return;
    const down = (e.buttons & bit) !== 0;
    if (down) { if (look.locked || onSea(e)) pressOnSea(e); }
    else if (e.button === 2) rmbUp();
  }
  addEventListener("pointermove", (e) => {
    if (e.button >= 0) chord(e);
    if (look.locked) {
      if (live()) turnLook(e.movementX || 0, e.movementY || 0);
      if (rDown && !rDown.aiming) { rDown.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0); if (rDown.moved > TAP_PX) rmbHold(); }
      return;
    }
    // Cursor aim follows the cursor only over the open sea (not over a HUD control, not below the helm strip's top).
    const over = onSea(e) && !belowStrip(e.clientY);
    if (over) cursor = { x: e.clientX, y: e.clientY };
    cursorLive = over;
    if (rDown && !rDown.aiming && Math.hypot(e.clientX - rDown.x, e.clientY - rDown.y) > TAP_PX) rmbHold();
    if (over && live()) markLook();
  });
  document.addEventListener("pointerleave", () => { cursorLive = false; });
  stage?.addEventListener("pointerdown", pressOnSea);
  addEventListener("pointerup", (e) => { if (e.button === 2) rmbUp(); });
  stage?.addEventListener("contextmenu", (e) => e.preventDefault());
  stage?.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  // The mouse wheel is the scene's (world.js binds it on the canvas: zoom deck level ⇄ tactical, the spyglass's zoom).
  let hoverRaf = 0;
  stage?.addEventListener("pointermove", () => {
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const at = aimPoint();
      const sw = live() ? swivelTarget(pickAt(at.x, at.y)) : null;
      const on = !!sw && sw.targetId !== "kraken_eye";   // the eye takes every gun, not just the swivel (the reticle names it)
      document.body.classList.toggle("nr-cur-swivel", on);
      parts.hud?.swivelHint?.(on);
    });
  });

  function releaseAll() {
    held.left = held.right = false;
    if (sent !== 0) { sent = 0; wheel = 0; bus.intent("wheel", { value: 0 }); }
    if (sprinting) { sprinting = false; bus.intent("sprint", { on: false }); }
    aimBy.mouse = aimBy.key = false;
    if (look.aiming) { look.aiming = false; markLook(); }
    clearTimeout(rDown?.timer);
    rDown = null;
    spyglass(false);
  }

  addEventListener("keydown", onDown);
  addEventListener("keyup", onUp);
  addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });
  bus.on("view", ({ name } = {}) => { if (name !== "voyage" && name !== "raid") { releaseAll(); unlock(); } });
  bus.on("phase", ({ phase: p } = {}) => {
    if (!HELM.has(p)) { releaseAll(); unlock(); }
    if (p === "moored" || p === "briefing") { look.yaw = 0; look.pitch = -6; look.mode = "auto"; markLook(); }
  });
  bus.on("pause", ({ on } = {}) => { if (on) { releaseAll(); unlock(); } });
  bus.on("settings", (s = {}) => {
    if (s.invertLook != null) look.invert = !!s.invertLook;
    if (s.mouse) { mouseMode = s.mouse === "free" ? "free" : "cursor"; if (mouseMode === "cursor") unlock(); markLook(); }
  });

  // Learned once: the Captain has used the guns (the reticle stops spelling out the controls).
  const LEARN_KEY = "rx-rexmaw-raids-learned";
  const learned = new Set(store.get(LEARN_KEY, []) || []);
  bus.on("intent", ({ name, payload } = {}) => {
    const k = name === "fire" ? (payload?.aiming ? "aimfire" : "fire") : name === "aim" && payload?.aiming ? "aim" : null;
    if (!k || learned.has(k)) return;
    learned.add(k);
    store.set(LEARN_KEY, [...learned]);
  });

  return {
    /** The wheel as the Captain holds it (−1..1), for the HUD's wheel. */
    wheel: () => wheel,
    /** The look: {yaw, pitch, aiming, mode, locked, cursor}. */
    look: () => ({ ...look, cursor: cursorAim() }),
    lookPayload,
    spyglass: () => spy,
    sprinting: () => sprinting,
    releaseAll,
    lock, unlock,
    mouseMode: () => mouseMode,
    lockDenied: () => lockDenied,
    /** Has the Captain done `k` ("aim", "fire", "aimfire") at least once ever? */
    learned: (k) => learned.has(k),
    setEnabled(on) { enabled = !!on; if (!on) releaseAll(); },
    /** On-screen helm buttons (touch): steer("left"|"right", down). */
    steer,
    /** lockShip(id | null, at?) locks / lets go of a target ship; cycleLock(dir) steps through the ships in sight. */
    fire, mark, lockShip: lockTarget, cycleLock, toggleMortar, setCrewMode,
    /** Set the look directly (tests, a debug hook, a touch stick): {yaw, pitch, aiming, mode}. */
    setLook(l = {}) {
      if (Number.isFinite(l.yaw)) look.yaw = wrap(l.yaw);
      if (Number.isFinite(l.pitch)) look.pitch = clamp(l.pitch, PITCH[0], PITCH[1]);
      if (l.aiming != null) { aimBy.key = !!l.aiming; look.aiming = !!l.aiming; }
      if (l.mode) look.mode = l.mode === "mortar" ? "mortar" : "auto";
      cursorLive = false;
      markLook();
    },
    /** Put the cursor somewhere (harness): cursor aim eases toward it. */
    pointAt(x, y) { cursor = { x, y }; cursorLive = true; markLook(); },
  };
}
