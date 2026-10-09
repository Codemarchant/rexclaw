// Rexmaw Raids: boot, wiring, the frame loop and the debug hooks.
//
// The Captain (the user) sails the Rexmaw on day and night missions, aiming and
// firing the guns themselves; their companion takes the Captain's orders (a gun
// crew, repairs, the pumps) and navigates the dark (headings, danger marks).
// The rules live in core/ (run, sim, gunnery, missions, protocol, briefs); this
// file builds the pieces and plugs them together:
//
//   HUD / title / results / settings ──intent──▶ bus ──▶ run.input()
//   HUD look ──UI `look`──▶ world.shots.look() (the camera orbits with the guns)
//   run ──events──▶ bus (HUD, coach, audio, barks, crew avatars via `tick`)
//       ──events──▶ world.event() (scene), crew.event() (the figures on deck)
//       ──tells / forces──▶ protocol ──▶ the companion (game.tell / game.force)
//   every frame: run.step(rawDt × world.timeScale) → world.setAimPreview(run.aimPreview())
//                → world.update(last tick, rawDt, run.pose())
//
// Everything past core/ is imported defensively: a module that is missing or
// throws while loading or building is logged and skipped, so the page always
// boots (without WebGL2 the HUD still sails the raid).
//
// Debug hooks: window.__nightraid (state() always; ?debug=1 adds the mutating
// ones: autopilot(on), mate(on), ff(seconds), stage(name), spawn(cls), act(...),
// board(archetype, cls) for a boarding with a chosen captain, …) and a
// frame-rate overlay.

import { TRACK_IDS } from "./audio/tracks.js";   // first: registers the music before RexGame.create
import { GAME, MODES, DEFAULT_MODE, CLASSES, MISSIONS, DAY_MISSIONS, NIGHT_MISSIONS, FREE_MISSIONS } from "./core/const.js";
import { createBus, BUS_TYPES, EVENTS } from "./core/bus.js";
import { createRun } from "./core/run.js";
import { createProtocol } from "./core/protocol.js";
import { createPresence } from "./core/presence.js";
import * as save from "./core/save.js";
import { generateWorld } from "./core/world.js";
import { forward, dist } from "./core/geom.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";
const Kit = window.RexGame || null;
const OFFCALL = ["wait", "separate", "latest"].includes(params.get("offcall")) ? params.get("offcall") : "wait";
/** Settings → "Companion off a call: Solo" (ui/settings.js `companion`, kept current by its `settings` events). */
let soloOffCall = true;   // the default (Settings → Companion off a call: Solo) until the saved choice loads
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAG = "[rexmaw-raids]";

// ---- Autoplay gating -------------------------------------------------------------
// The game's audio reaches the kit's AudioContext through RexGame.sfx.context(),
// which makes it on demand. A browser only lets it start inside a real gesture,
// so the getter answers null until one. Registered before anything else, so this
// capture listener runs before the renderer's own.
let gestured = false;
if (typeof Kit?.sfx?.context === "function") {
  const kitContext = Kit.sfx.context;
  Kit.sfx.context = () => (gestured ? kitContext() : null);
}
const onGesture = (e) => {
  if (gestured || (e && e.isTrusted === false)) return;
  gestured = true;
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.removeEventListener(ev, onGesture, true);
  setTimeout(() => attempt("ambience.start", () => A.ambience?.start()), 0);
};
for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, onGesture, true);

// ---- Modules ---------------------------------------------------------------------

const MODULES = {
  renderer: "./scene/renderer.js", world: "./scene/world.js", boardfight: "./scene/boardfight.js", crew: "./avatar/crew.js",
  sfx: "./audio/sfx.js", ambience: "./audio/ambience.js", score: "./audio/score.js", barks: "./audio/barks.js",
  hud: "./ui/hud.js", title: "./ui/title.js", results: "./ui/results.js", coach: "./ui/coach.js", settings: "./ui/settings.js",
};

/** Everything the page holds (the debug hooks read it too). */
const S = {
  mods: {}, missing: [], failed: [],
  R: null, world: null, bf: null, crew: null, crewAgent: undefined, P: null, presence: null, run: null, ui: {}, last: null,
};
/** The audio side. */
const A = { sfx: null, ambience: null, score: null, barks: null };

const bus = createBus({ types: BUS_TYPES, name: "rexmaw-raids" });

/** Import one module; null (and a note in S.missing) when it's absent or broken. */
async function optional(key, path) {
  try {
    return await import(path);
  } catch (error) {
    S.missing.push(key);
    console.debug(`${TAG} module ${path} not loaded`, error);
    return null;
  }
}

/** Run a factory only when its module and export exist; log and skip one that throws. */
async function build(key, mod, exportName, ...args) {
  const make = mod?.[exportName];
  if (typeof make !== "function") {
    if (mod) console.debug(`${TAG} ${key}: no ${exportName}() export`);
    return null;
  }
  try {
    return await make(...args);
  } catch (error) {
    S.failed.push(key);
    console.debug(`${TAG} ${key}: ${exportName}() failed`, error);
    bus.emit("error", { type: key, error });
    return null;
  }
}

function report(where, error) {
  console.debug(`${TAG} ${where}`, error);
  bus.emit("error", { type: where, error });
}
/** Run `fn`, reporting (not throwing) what goes wrong. */
function attempt(where, fn) {
  try { return fn(); } catch (error) { report(where, error); return undefined; }
}

/** The shared context every UI module's factory receives. */
const ctx = {
  bus,
  debug: DEBUG,
  get R() { return S.R; },
  /** The scene's world (pick / hover / screenPos for the HUD's mouse). */
  get world() { return S.world; },
  /** The boarding fight on screen (scene/boardfight.js): pick / screenPos / anchors for the fight HUD. */
  get boardfight() { return S.bf || null; },
  get game() { return S.P?.game || null; },
  state: () => S.run?.state?.() ?? null,
  saved: () => S.P?.game?.saved || {},
  name: () => S.P?.game?.companion || "Your companion",
  /** The bay (chart, results). */
  bayWorld: () => S.run?.world?.() ?? null,
  /** The HUD chart's wake, for a results chart without a track. */
  hudWake: () => S.ui.hud?.chart?.wake?.() || [],
  /** The Captain's arcs for a look (the HUD's weapon / hit / target readout); cached per sim step. */
  aimPreview: (look) => S.run?.aimPreview?.(look) ?? null,
  dom: {
    stage: $("#stage"), labels: $("#labels"), hud: $("#hud"), title: $("#title"), overlay: $("#overlay"),
    coach: $("#coach"), settings: $("#settings"), results: $("#results"),
  },
};

// ---- Loading veil ----------------------------------------------------------------

const veil = {
  el: $("#loading"),
  crew: new Map(),
  set(progress, text) {
    if (this.finished) return;   // the crew still coming aboard after the veil lifted don't hold the title back
    if (this.el) {
      this.el.style.setProperty("--p", String(clamp(progress, 0, 1)));
      if (text) { const s = this.el.querySelector(".status"); if (s) s.textContent = text; }
    }
    bus.emit("boot", { stage: text || "", progress });
  },
  /** The crew coming aboard one by one: a name per member, lit as their model lands. */
  roster(info = {}) {
    const box = this.el?.querySelector(".crew");
    if (!box || !info.id) return;
    const was = this.crew.get(info.id) || { name: info.name || info.id, stage: "wait" };
    was.name = info.name || was.name;
    was.stage = info.stage === "loaded" ? "ok" : info.stage === "standee" ? "paper" : info.stage === "loading" ? "loading" : was.stage;
    this.crew.set(info.id, was);
    box.replaceChildren(...[...this.crew.values()].map((m) => {
      const s = document.createElement("span");
      s.className = m.stage;
      s.textContent = m.name;
      return s;
    }));
  },
  done() {
    this.finished = true;
    if (!this.el || this.el.classList.contains("done")) return;
    this.el.classList.add("done");
    this.el.setAttribute("aria-busy", "false");
    const el = this.el;
    setTimeout(() => el.remove(), 900);
  },
  fail(text) {
    if (!this.el) return;
    this.el.classList.add("failed");
    const s = this.el.querySelector(".status"); if (s) s.textContent = text;
  },
};

// ---- Views -----------------------------------------------------------------------

const viewFor = (phase) => (phase === "title" ? "title" : phase === "results" ? "result" : "voyage");
let viewNow = null;
function showView(name) {
  if (!name) return;
  document.body.dataset.view = name;
  if (name === "title") { if (S.ui.title) S.ui.title.show(); else $("#title").hidden = false; }
  else if (S.ui.title) S.ui.title.hide(); else $("#title").hidden = true;
  $("#hud").hidden = name === "title";
  if (name === viewNow) return;
  viewNow = name;
  bus.emit("view", { name });
}

// ---- The run's moments on screen --------------------------------------------------

/** Momentary effects skipped while a debug fast-forward runs (they'd all fire on its one frame). */
const FF_SKIP = new Set(["tick", "volley", "impact", "ports", "swivel", "plunder", "pickup", "crew_line", "fire", "leak", "weak",
  "gun_down", "gun_up", "log", "crew_move", "known", "tell", "mark", "spyglass", "say", "order", "override", "brace", "brace_call",
  "overboard", "medal", "spawn", "contact", "dry_fire", "weapon", "barrel", "mortar_shot", "job", "heading_call", "danger",
  "spotted", "sprint", "split", "boardfight", "sea_event"]);
let ffing = false;

/** The run's events the crew on deck react to. */
const CREW_EVENTS = new Set(["impact", "brace", "volley", "sink", "surrender", "bank", "board", "overboard", "crew_line", "say",
  "order", "hazard", "contact", "fire", "end"]);

function onPhase(phase, prev) {
  S.last = S.run.state();
  // At sea the frame guard may only lower the resolution: a tier step rebuilds the post chain mid-voyage (a visible freeze).
  if (S.R) S.R.holdTierSteps = phase === "sailing" || phase === "boarding";
  showView(viewFor(phase));
  bus.emit("state", S.last);
  if (phase === "briefing") {
    const g = S.P.game;
    attempt("world.setWorld", () => S.world?.setWorld(S.run.world()));
    attempt("world.setDaylight", () => S.world?.setDaylight?.(null));   // the mission's own day or night from here
    attempt("save.start", () => { save.migrate(g.saved); save.markStarted(g.saved); g.save(); });
    attempt("crew.start", () => S.crew?.event("start", {}));
    // Debug: a new mission, a fresh scripted Captain and companion.
    if (autopilotMod && AP.cap) AP.cap = autopilotMod.makeMissionCaptain();
    if (autopilotMod && MATE.on) MATE.m = autopilotMod.helperMate(AP.on ? AP.cap : null);
  }
  if (phase === "title") { titlePreview.key = null; titlePreview.built = null; titlePreview.t = 0; }   // the title's bay again
}

/** The title's bay: the chosen mission's own sea, by day or by night (the tab's light). */
const titlePreview = { key: null, built: null, t: 0 };
const firstMission = (tab) => (tab === "night" ? NIGHT_MISSIONS : tab === "free" ? FREE_MISSIONS : DAY_MISSIONS)[0];
const titleMission = () => {
  const tab = S.P?.game?.mode;
  const id = attempt("title.mission", () => S.ui.title?.mission?.());
  return MISSIONS[id] ? id : firstMission(MODES[tab] ? tab : DEFAULT_MODE);
};
const previewWorld = (id) => generateWorld(Number(params.get("seed")) || 1, id);
function updateTitlePreview(dt) {
  if (!S.world || S.run.phase() !== "title") return;
  titlePreview.t -= dt;
  if (titlePreview.t > 0) return;
  titlePreview.t = 0.3;
  const id = titleMission();
  if (id === titlePreview.key) return;
  const first = titlePreview.key == null;
  titlePreview.key = id;
  if (id !== titlePreview.built) {
    titlePreview.built = id;
    attempt("preview world", () => S.world.setWorld(previewWorld(id)));
  }
  // The tab's light: the day missions under the sun, the night ones under the moon (free roam by its card).
  attempt("world.setDaylight", () => S.world.setDaylight?.(MISSIONS[id].time === "night" ? 0 : 1, { seconds: first ? 0 : 1.2 }));
}

function onResults(results) {
  const g = S.P.game;
  let rec = null;
  attempt("save.record", () => {
    save.migrate(g.saved);
    rec = save.recordMission(g.saved, results);
    save.prune(g.saved);
    g.save();
  });
  attempt("protocol.finish", () => S.P.finish(results));
  // The ship's log stands in for the kit's own end card.
  if (S.ui.results) document.querySelector(".rx-end")?.remove();
  const shown = attempt("results.show", () => S.ui.results?.show({ ...results, world: S.run.world(), best: !!rec?.newBest, newMedals: rec?.newMedals || [] }));
  if (shown?.then) {
    const card = ++resultsCard;
    shown.then((choice) => {
      // Closed (Esc / ×): back to port, unless a newer results card replaced this one (it resolves "close" too).
      if (choice === "close" && card === resultsCard && S.run.phase() === "results") S.run.input("quit");
    }).catch((error) => report("results", error));
  }
}
let resultsCard = 0;

function wireRun() {
  const run = S.run;
  for (const ev of EVENTS) {
    run.on(ev, (p) => {
      if (ev === "tick") S.last = p;
      if (ffing && FF_SKIP.has(ev)) return;
      bus.emit(ev, p);
      if (ev !== "tick") {
        attempt(`world.${ev}`, () => S.world?.event(ev, p));
        if (ev === "boardfight" || ev === "board") attempt(`bf.${ev}`, () => S.bf?.event(ev, p));
        if (CREW_EVENTS.has(ev)) attempt(`crew.${ev}`, () => S.crew?.event(ev, p));
      }
    });
  }
  run.on("phase", ({ phase, prev }) => onPhase(phase, prev));
  run.on("results", ({ results }) => onResults(results));
  run.on("pause", () => bus.emit("state", run.state()));

  // The Captain's intents (HUD, title, results, settings) all go to the run.
  bus.on("intent", ({ name, payload } = {}) => {
    if (name === "spyglass") spyglassView(payload || {});
    attempt(`intent.${name}`, () => run.input(name, payload ?? {}));
  });
  // The crew's splash when someone goes over: the scene draws it.
  bus.on("crew_splash", (p) => attempt("world.crew_splash", () => S.world?.event("crew_splash", p)));
  // The Captain's look (mouse / stick, ui/input.js): the camera orbits to it and the guns follow.
  bus.on("look", (l) => attempt("shots.look", () => S.world?.shots?.look?.(l)));
}

/** The spyglass's camera: zoom in on hold, follow the contact under the crosshair, back out on release. */
let spyOn = false;
function spyglassView({ on, contactId = null }) {
  const sh = S.world?.shots;
  if (!sh) return;
  const live = ["sailing", "boarding", "briefing"].includes(S.run?.phase());
  if (on && live) {
    if (!spyOn) { spyOn = true; attempt("shots.spyglass", () => sh.spyglass(true, { contactId })); }
    else if (contactId) attempt("shots.spyglassAim", () => sh.spyglassAim({ contactId }));
  } else if (spyOn) {
    spyOn = false;
    attempt("shots.spyglass", () => sh.spyglass(false));
  }
}

// ---- Boot ------------------------------------------------------------------------

async function boot() {
  veil.set(0.04, "Unrolling the chart…");

  // The companion's side first: the kit mounts its record line and mode tabs into the title.
  S.P = createProtocol({
    getRun: () => S.run,
    ui: { recordInto: $("#title-record"), modesInto: $("#title-modes") },
    music: TRACK_IDS,
    solo: () => soloOffCall,
    onVoiceLine: (audio) => {
      attempt("crew.speak", () => S.crew?.speak("me", audio));
      attempt("ambience.duck", () => A.ambience?.duck(audio));
    },
  });
  const g = S.P.game;
  S.presence = createPresence({ game: g });
  S.run = createRun({
    mode: MODES[g.mode] ? g.mode : DEFAULT_MODE,
    onCall: () => !!S.presence?.onCall?.(),
    offcall: OFFCALL,
    // Solo off a call: the run sails as it does with no companion link (its own pace, `state.solo`).
    connected: () => !!g.connected && !soloOffCall,
    Refuse: S.P.Refuse,
  });
  wireRun();
  S.presence.onChange?.((on) => { S.P.setOnCall(on); bus.emit("state", S.run.state()); });
  S.presence.onLine?.(() => { const t = S.presence.lastUserText?.(); if (t) S.run.input("captain_line", { text: t }); });

  const keys = Object.keys(MODULES);
  let settled = 0;
  const loaded = await Promise.all(keys.map((k) => optional(k, MODULES[k]).then((m) => {
    veil.set(0.06 + 0.2 * (++settled / keys.length));
    return m;
  })));
  keys.forEach((k, i) => { S.mods[k] = loaded[i]; });
  const M = S.mods;

  // The tells and forces go to the companion; the crew cameos and the companion's
  // off-call lines are audio/barks.js's (the protocol's own are the fallback without it).
  A.barks = await build("barks", M.barks, "createBarks", { bus, game: () => S.P?.game || null });
  attempt("barks.wire", () => A.barks?.wire());
  S.P.attach(S.run, { cameos: !A.barks, reactions: !A.barks });

  // The page.
  veil.set(0.3, "Mustering the crew…");
  attempt("settings", () => M.settings?.getSettings?.(ctx));
  S.ui.title = await build("title", M.title, "createTitle", ctx);
  S.ui.hud = await build("hud", M.hud, "createHud", ctx);
  S.ui.coach = await build("coach", M.coach, "createCoach", ctx);
  S.ui.results = await build("results", M.results, "createResults", ctx);
  if (!S.ui.title) shellTitle();
  showView("title");

  // The sea builds behind the veil, then the crew come aboard one by one.
  await buildScene();
  wireScene();
  if (S.run.phase() !== "title") onPhase(S.run.phase(), null);
  await loadCrew();
  veil.set(1, "Ready.");
  veil.done();
  if (DEBUG) perfOverlay(true);
}

/** The 3D bay: the renderer, the world (its GLB), the audio; compiled behind the title. */
async function buildScene() {
  const M = S.mods;
  veil.set(0.34, "Lighting the lanterns…");
  S.R = await build("renderer", M.renderer, "createRenderer", ctx);
  const R = S.R;
  if (R) {
    const set = M.settings?.readSettings?.() || {};
    veil.set(0.4, "Rigging the Rexmaw…");
    // The title looks out over the chosen mission's bay; the mission lays out its real one.
    let preview = null;
    try { const id = titleMission(); preview = previewWorld(id); titlePreview.built = id; } catch (error) { report("preview world", error); }
    S.world = await build("world", M.world, "createWorld", R, {
      world: preview, quality: set.graphics && set.graphics !== "auto" ? set.graphics : null,
      cinematics: set.cinematics !== false, autoCamera: true, wheelZoom: true,
    });
    if (S.world) attempt("run.setObstacles", () => S.run.setObstacles(S.world.harbourObstacles()));
    // The boarding fight on her deck (v4): built before the compile (its battle light joins the compiled light count).
    if (S.world) {
      S.bf = await build("boardfight", M.boardfight, "createBoardFight", R, {
        crew: () => S.crew, fleet: S.world.fleet, fx: S.world.fx, camera: S.world.shots,
        cue: (name, p) => attempt("sfx.boardfight", () => A.sfx?.boardfight?.(name, p)),
      });
      attempt("world.setBoardFight", () => S.world.setBoardFight?.(S.bf));
    }
  }
  veil.set(0.5, "Tuning the band…");
  A.sfx = await build("sfx", M.sfx, "createSfx", { R });
  A.ambience = await build("ambience", M.ambience, "createAmbience", { R, sfx: A.sfx });
  A.score = await build("score", M.score, "createScore", { bus });
  attempt("sfx.wire", () => A.sfx?.wire(bus));
  attempt("ambience.wire", () => { A.ambience?.wire(bus); if (gestured) A.ambience?.start(); });
  if (R) {
    veil.set(0.54, "Polishing the brass…");
    try {
      R.start?.();
      attempt("bf.warm", () => S.bf?.warmShow(true));
      if (S.world) await S.world.compile(); else await R.compile?.();
    } catch (error) { report("renderer start/compile", error); }
    attempt("bf.warm", () => S.bf?.warmShow(false));
  }
}

/** The frame: the debug crew, the run, the world. */
const TITLE_STATE = Object.freeze({ t: 0, phase: "title", clock: 0.05, ship: null, contacts: [], projectiles: [], hazards: { spouts: [], mortars: [], shoals: [] }, pickups: [], plunder: { hold: 0, banked: 0 } });
function frame(rawDt) {
  const run = S.run;
  // The scene's slow motion (a kill's last volley) slows the sim with the picture.
  const ts = S.world ? Number(attempt("world.timeScale", () => S.world.timeScale)) : 1;
  const dt = rawDt * (Number.isFinite(ts) ? clamp(ts, 0, 1) : 1);
  debugCrew(dt);
  run.step(dt);
  if (!S.world) return;
  const title = run.phase() === "title";
  if (title) updateTitlePreview(rawDt);
  else aimFrame();
  const st = title ? TITLE_STATE : (S.last || run.state());
  S.world.update(st, rawDt, title ? null : run.pose());
  // The boarding fight's figures, lens and beats (after the world, so her hull has moved this frame).
  if (!title && S.bf) attempt("boardfight.update", () => S.bf.update(st, dt));
}

/**
 * The Captain's arcs on the sea every frame: the core's preview for the look the guns were last given
 * (the same trace the HUD reads; cached per sim step). It includes the look's mode, so the mortar's
 * circle shows in mortar mode. The mortar ranges by the look's pitch (core: 150–600 m along the look)
 * rather than by the sea under the reticle: at 500 m that point sits ~2° below the horizon, and the
 * ship's heave alone threw it between ~300 m and the sky (measured), so the circle wouldn't hold still.
 */
function aimFrame() {
  const run = S.run;
  const live = run.phase() === "sailing";
  attempt("world.setAimPreview", () => S.world.setAimPreview(live ? run.aimPreview() : null));
}

function wireScene() {
  const R = S.R, world = S.world;
  if (R) R.onFrame((dt, t, rawDt) => frame(rawDt), -60);
  else {
    // No WebGL2: the HUD still sails the raid on the page's own clock.
    let last = performance.now();
    const loop = (now) => { frame(Math.min(0.25, (now - last) / 1000)); last = now; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  if (!world) return;
  // The mouse over the sea: a weak point brightens and the swivel swings to it; a crew member shows their name.
  const stage = ctx.dom.stage;
  let hoverRaf = 0, hx = 0, hy = 0;
  stage?.addEventListener("pointermove", (e) => {
    hx = e.clientX; hy = e.clientY;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const live = ["briefing", "sailing", "boarding"].includes(S.run.phase());
      const hit = live ? attempt("world.hover", () => world.hover(hx, hy)) : null;
      attempt("crew.hover", () => S.crew?.hover(hit?.kind === "crew" ? hit.id : null));
    });
  });
  stage?.addEventListener("pointerleave", () => { attempt("world.hover", () => world.hover(NaN, NaN)); attempt("crew.hover", () => S.crew?.hover(null)); });
}

/** The five named crew (and the companion, if they're not one of them) on deck, loaded one after another. */
async function loadCrew() {
  const M = S.mods;
  if (!S.R || !M.crew) return;
  const agentId = Number(params.get("companion")) || await waitFor(() => S.P?.game?.companionId, 4000) || null;
  const settled = await makeCrew(agentId, true);
  if (!settled) veil.set(0.97, "The crew will join you on deck.");
  // The companion's id can land after the crew does (the kit's link came late): put them aboard then.
  if (!agentId) {
    waitFor(() => S.P?.game?.companionId, 60000).then((id) => {
      if (id && id !== S.crewAgent) attempt("crew.rebuild", () => makeCrew(id, false));
    });
  }
}

/** Build (or rebuild) the crew; resolves true once they're aboard, false if the veil gave up waiting. */
async function makeCrew(agentId, withVeil) {
  const M = S.mods;
  attempt("crew.dispose", () => S.crew?.dispose());
  S.crewAgent = agentId;
  const kind = M.settings?.readSettings?.().avatar === "portrait" ? "standee" : "vrm";
  const onProgress = withVeil ? (f, info = {}) => {
    if (info.stage === "start") for (const m of S.crew?.cast || []) veil.roster({ id: m.id, name: m.name, stage: "wait" });
    veil.roster(info);
    const who = info.name || "The crew";
    const text = info.stage === "start" ? "The crew are coming aboard…"
      : info.stage === "loading" ? `${who} is coming aboard… (${(info.done ?? 0) + 1}/${info.total ?? "?"})`
        : `${who} is aboard.`;
    veil.set(0.56 + 0.41 * f, text);
  } : null;
  S.crew = await build("crew", M.crew, "createCrew", S.R, { bus, agentId, kind, onProgress });
  if (!S.crew) return true;
  attempt("world.setCrewPicker", () => S.world?.setCrewPicker((ray) => S.crew?.pick(ray)));
  const ready = S.crew.ready.then(async () => {
    try { await S.R.compile?.(); } catch (error) { report("crew compile", error); }   // their materials join the compiled set
    attempt("crew.state", () => S.last && S.crew?.update(S.last));
    return true;
  });
  if (!withVeil) return ready;
  return Promise.race([ready, new Promise((r) => setTimeout(() => r(false), 30000))]);
}

function waitFor(get, ms) {
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    const tick = () => {
      const v = get();
      if (v || performance.now() > until) resolve(v || null); else setTimeout(tick, 250);
    };
    tick();
  });
}

/** The first-paint title's own button, should ui/title.js be missing. */
function shellTitle() {
  const b = $("#title-start");
  if (!b) return;
  b.disabled = false;
  b.addEventListener("click", () => bus.intent("start", { mission: titleMission() }));
}

// ---- Settings ----------------------------------------------------------------------

bus.on("settings", (s = {}) => {
  if (s.companion) { soloOffCall = s.companion === "solo"; if (S.run) bus.emit("state", S.run.state()); }
  if (s.graphics) attempt("quality", () => S.R?.setQuality?.(s.graphics));
  if (s.motion) attempt("motion", () => S.R?.setMotion?.(s.motion));
  if (s.avatar) attempt("avatar", () => S.crew?.setKind?.(s.avatar === "portrait" ? "standee" : "vrm"));
  if (s.cinematics != null) attempt("cinematics", () => S.world?.shots?.setCinematics(!!s.cinematics));
  if (s.showFps != null) perfOverlay(!!s.showFps || DEBUG);
});

// ---- Perf overlay (?debug=1, or "Show frame rate" in Settings) -----------------------

let perfTimer = 0;
function perfOverlay(on) {
  let el = $("#perf");
  clearInterval(perfTimer);
  if (!on) { el?.remove(); return; }
  if (!el) { el = document.createElement("pre"); el.id = "perf"; document.body.append(el); }
  const draw = () => {
    const p = S.R?.perf?.();
    const s = S.last;
    const mm = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
    el.textContent = (p
      ? `${p.fps.toFixed(0)} fps  p50 ${p.frameMs.p50.toFixed(1)} ms  p90 ${p.frameMs.p90.toFixed(1)} ms\n`
        + `${p.calls} calls  ${(p.triangles / 1000).toFixed(0)}k tris  ${p.tier} @ ${p.dpr.toFixed(2)}x`
      : "renderer not loaded")
      + (DEBUG && s?.ship ? `\n${s.phase}${s.paused ? " (paused)" : ""} t ${mm(s.t)}  left ${mm(s.mission?.timeLeft ?? 0)}  pace ${s.pace}`
        + `\nhull ${Math.round(s.ship.hull)}  water ${Math.round(s.ship.water)}  heat ${s.heat}  hold ${s.plunder.hold}  banked ${s.plunder.banked}`
        + `\n${(s.contacts || []).filter((c) => c.detected).length} contacts${AP.on ? "  [autopilot]" : ""}${MATE.on ? "  [mate]" : ""}` : "");
  };
  draw();
  perfTimer = setInterval(draw, 500);
}

// ---- Debug: the scripted Captain and First Mate, fast-forward, stages -----------------

const AP = { on: false, cap: null, acc: 0 };
const MATE = { on: false, m: null };
let autopilotMod = null;
async function loadAutopilot() {
  if (!autopilotMod) autopilotMod = await import("./autopilot.js");
  return autopilotMod;
}
if (DEBUG) loadAutopilot().catch((error) => report("autopilot", error));

/** Every 0.2 s of game time: the scripted Captain steers, the scripted First Mate gives orders. */
function debugCrew(dt, force = false) {
  if (!AP.on && !MATE.on) return;
  AP.acc += dt;
  if (!force && AP.acc < 0.2) return;
  const step = AP.acc;
  AP.acc = 0;
  const run = S.run;
  if (!run.sim() || run.phase() === "title" || run.phase() === "results") return;
  if (AP.on && AP.cap) attempt("autopilot", () => AP.cap(run, step));
  if (MATE.on && MATE.m) attempt("mate", () => MATE.m.step(run, step));
}

function setAutopilot(on) {
  if (!autopilotMod) return "autopilot module still loading; try again";
  const was = AP.on;
  AP.on = !!on;
  if (AP.on && !AP.cap) AP.cap = autopilotMod.makeMissionCaptain();
  if (!AP.on && S.run) S.run.input("wheel", { value: 0 });
  if (MATE.on && was !== AP.on) MATE.m = autopilotMod.helperMate(AP.on ? AP.cap : null);
  return AP.on;
}
function setMate(on) {
  if (!autopilotMod) return "autopilot module still loading; try again";
  if (on && MATE.on && MATE.m) return true;   // already aboard: keep their standing orders
  MATE.on = !!on;
  MATE.m = MATE.on ? autopilotMod.helperMate(AP.on ? AP.cap : null) : null;
  return MATE.on;
}

/** Run the mission on by `seconds` of sim time at once (the debug crew act if they're on). */
function ff(seconds = 10, until = null) {
  const run = S.run;
  const n = Math.max(1, Math.round(seconds * 30));
  ffing = true;
  let i = 0;
  try {
    for (; i < n; i++) {
      if (i % 6 === 0) { AP.acc = 0.2; debugCrew(0, true); }
      run.step(1 / 30);
      if (until && i % 3 === 0 && until(run)) break;
    }
  } finally { ffing = false; }
  const st = run.state();
  S.last = st;
  bus.emit("tick", st);
  attempt("crew.update", () => S.crew?.update(st));
  attempt("world.update", () => S.world?.update(run.phase() === "title" ? TITLE_STATE : st, 1 / 30, run.pose()));
  return { phase: st.phase, t: st.t, timeLeft: st.mission?.timeLeft, mission: st.mission?.status, hull: st.ship?.hull, water: st.ship?.water, heat: st.heat, plunder: st.plunder,
    contacts: (st.contacts || []).filter((c) => c.detected).map((c) => `${c.cls} ${c.dist}m ${c.state}`), simSeconds: Math.round(i / 30) };
}

const STAGES = ["title", "briefing", "sailing", "duel", "boarding", "fort", "smugglers", "storm", "maelstrom", "kraken", "gloam", "bank",
  "dawn", "results"];
/** The mission a stage needs (others play in whichever mission is running, or the title's choice). */
const STAGE_MISSION = { fort: "silence_fort", smugglers: "smugglers_run", storm: "free_night", maelstrom: "free_day", kraken: "krakens_wake",
  gloam: "the_gloam", bank: "free_day" };
const underway = () => !["title", "results"].includes(S.run.phase());
/** Start a mission (the title's choice by default): `start {mission}`. */
function begin(mission = titleMission(), seed = null) {
  if (underway() || S.run.phase() === "results") S.run.input("quit");
  if (seed != null) S.run.setSeed(seed);
  const id = MISSIONS[mission] ? mission : titleMission();
  bus.intent("start", { mission: id, mode: MISSIONS[id].tab, night: MISSIONS[id].time === "night" });
}
/** At sea now (in `mission` if given): a mission if there's none, Set sail if the briefing is up. */
function atSea(mission = null) {
  if (mission && underway() && S.run.world()?.mission !== mission) begin(mission);
  if (!underway()) begin(mission || undefined);
  if (S.run.phase() === "briefing") bus.intent("start_voyage");
  return S.run.phase() === "sailing" || S.run.phase() === "boarding";
}
/** Sail her out of the harbour first: the sim puts no ship within 500 m of home port. */
function offshore() {
  const port = S.run.world()?.port || { x: 0, z: -40 };
  ff(150, (r) => { const P = r.sim().S.ship; return dist(P.x, P.z, port.x, port.z) > 480; });
}
/** A point `d` m off the Rexmaw, `rel` degrees off her bow (+ = starboard). */
function offShip(d, rel = 0) {
  const P = S.run.sim().S.ship;
  const f = forward(P.heading + rel);
  return { x: P.x + f.x * d, z: P.z + f.z * d };
}
function spawn(cls = "brig", { d = 420, rel = 25, role = null } = {}) {
  if (!CLASSES[cls]) return `unknown class; try: ${Object.keys(CLASSES).join(", ")}`;
  if (!atSea()) return "not at sea";
  const sim = S.run.sim();
  const at = offShip(d, rel);
  const e = sim.spawnShip(cls, role || (cls === "merchant" ? "merchant" : cls === "gloam" ? "legend" : "hunter"), { x: at.x, z: at.z, r: 0 });
  if (cls === "gloam") sim.S.legendSpawned = true;
  ff(0.2);
  return { id: e.id, name: e.name, cls: e.cls, dist: Math.round(dist(sim.S.ship.x, sim.S.ship.z, e.x, e.z)) };
}

/**
 * Debug: put the mission at a beat for a screenshot. The sim runs there for real (the debug
 * Captain and First Mate in fast-forward); a stage only sets up what a short session can't
 * wait for (a ship on the horizon, the storm cell overhead, the Kraken's roll).
 */
function stage(name) {
  const run = S.run;
  if (!STAGES.includes(name)) return `unknown stage; try: ${STAGES.join(", ")}`;
  if (!autopilotMod && !["title", "briefing"].includes(name)) return "autopilot module still loading; try again";
  const sim = () => run.sim();
  const crew = () => { setAutopilot(true); setMate(true); };
  if (STAGE_MISSION[name]) atSea(STAGE_MISSION[name]);
  switch (name) {
    case "title":
      if (run.phase() !== "title") run.input("quit");
      break;
    case "briefing":
      begin();
      break;
    case "sailing":
      atSea(); crew(); ff(25);
      break;
    case "duel": {
      atSea(); crew();
      offshore();
      const e = spawn("brig", { d: 520, rel: 30 });
      if (AP.cap && e?.id) AP.cap.mem.focus = e.id;
      let volleys = 0;
      const off = run.on("volley", (p) => { if (p.by === "rexmaw") volleys++; });
      ff(150, (r) => {
        const x = r.sim().shipById(e.id);
        return !x || x.gone || x.state === "sinking" || (volleys >= 1 && dist(x.x, x.z, r.sim().S.ship.x, r.sim().S.ship.z) < 320);
      });
      off();
      break;
    }
    case "boarding": {
      atSea(); crew();
      offshore();
      // A merchant off the bow for the scripted Captain to chase down; another if she gets away or sinks.
      for (let tries = 0; tries < 4 && run.phase() === "sailing"; tries++) {
        const e = spawn("merchant", { d: 420, rel: 0 });
        if (!e?.id) break;
        if (AP.cap) { AP.cap.mem.targetId = e.id; AP.cap.mem.focus = e.id; }
        ff(300, (r) => { const x = r.sim().shipById(e.id); return r.phase() === "boarding" || !x || x.gone || x.state === "sinking"; });
      }
      break;
    }
    case "fort":
    case "smugglers":
      // Underway in that mission with the scripted pair working its objective for a while.
      crew(); ff(name === "fort" ? 60 : 40);
      break;
    case "storm": {
      atSea(); crew();
      offshore();
      const S0 = sim().S;
      if (S0.storm) { const at = offShip(120, 0); S0.storm.x = at.x; S0.storm.z = at.z; S0.wavesT = 0.5; }
      ff(60, (r) => { const w = r.sim().S.hazards.wave; return w && w.eta <= 3.2; });
      break;
    }
    case "maelstrom": {
      atSea();
      setAutopilot(false);
      const Wm = run.world().maelstrom;
      const P = sim().S.ship;
      // On the pull's edge south of the eye, bow on to it (the chase looks across the whirl); the storm cell back where the bay put it.
      if (Wm) { P.x = Wm.x; P.z = Wm.z - 290; P.heading = 0; P.speed = 6; }
      const S0 = sim().S, Ws = run.world().storm;
      if (S0.storm && Ws) { S0.storm.x = Ws.x; S0.storm.z = Ws.z; }
      ff(3);
      break;
    }
    case "kraken":
      atSea(); crew();
      sim().startKraken();
      ff(60, (r) => r.sim().S.hazards.kraken?.stage === "grab" && r.sim().S.hazards.kraken.t > 1.5);
      break;
    case "gloam":
      atSea(); crew();
      offshore();
      spawn("gloam", { d: 480, rel: -30 });
      ff(20);
      break;
    case "bank": {
      // Home with a hold worth banking (a prize's worth put aboard if it's empty): the scripted Captain sails in and slows.
      atSea(); crew();
      if (!sim().S.plunder.hold) sim().gainPlunder(450, "debug");
      let banked = false;
      const off = run.on("bank", () => { banked = true; });
      ff(600, (r) => banked || r.phase() !== "sailing");
      off();
      break;
    }
    case "dawn":
      atSea(); crew();
      ff(1200, (r) => r.sim().S.cfg.limit - r.sim().S.t < 85 || r.phase() !== "sailing");
      break;
    case "results":
      if (run.phase() !== "results") {
        atSea(); crew();
        ff(1600, (r) => r.phase() === "results");
      }
      break;
    default:
      break;
  }
  return run.phase();
}

// ---- Hooks --------------------------------------------------------------------------

const eventLog = [];
bus.on("*", (payload, type) => {
  if (type === "tick" || type === "state" || type === "boot") return;
  eventLog.push({ t: Math.round(performance.now()), type, payload });
  if (eventLog.length > 400) eventLog.splice(0, eventLog.length - 400);
});

const hooks = {
  /** The run's snapshot, or null before it exists. */
  state: () => S.run?.state?.() ?? null,
  /** The last `n` bus events (domain events, intents, toasts, errors). */
  events: (n = 50) => eventLog.slice(-n),
  perf: () => S.R?.perf?.() ?? null,
  /** Which modules didn't load or failed to build. */
  modules: () => ({ missing: [...S.missing], failed: [...S.failed] }),
  /** Who's on deck and how their models loaded. */
  crew: () => S.crew?.cast ?? null,
  game: GAME,
};
if (DEBUG) {
  Object.assign(hooks, {
    /** The scripted Captain on/off (works the mission's objective: aims and fires, boards, picks up loot). */
    autopilot: (on = true) => setAutopilot(on),
    /** The scripted companion on/off (only the companion's tools via run.companion, like the core tests'). */
    mate: (on = true) => setMate(on),
    ff,
    /** Sail to a beat: see STAGES. */
    stage,
    stages: () => [...STAGES],
    /** A ship of class `cls` off the bow (merchant gunboat brig frigate fireship manowar gloam). */
    spawn,
    /** Start a mission by id (spice_fleet silence_fort navy_convoy iron_duke smugglers_run the_gloam krakens_wake free_day free_night). */
    mission: (id, seed = null) => { begin(id, seed); return S.run.phase(); },
    missions: () => Object.keys(MISSIONS),
    /** Act as the companion: one of the eleven tools (man_guns repair bail spyglass call_heading mark_danger …). */
    act(name, args = {}) {
      try { return { ok: true, message: S.run.companion(name, args) }; } catch (e) { return { ok: false, message: e?.message || String(e) }; }
    },
    /** The companion said this aloud ("Fire!", "Brace!"). */
    say: (text) => S.run?.heard(String(text)),
    user: (intent, payload = {}) => bus.intent(intent, payload),
    shot: (name, ...a) => attempt(`shot.${name}`, () => S.world?.shots?.[name]?.(...a)),
    quality: (tier) => S.R?.setQuality?.(tier),
    seed: (n = null) => { S.run?.setSeed(n); return n; },
    results: () => S.run?.results?.() ?? null,
    mateLast: () => MATE.m?.last ?? null,
    /**
     * v4: force a random sea event now (spout squall waves derelict treasure kraken_arm fog, and the whacky ones:
     * gerald sky_whale dolphins flying_fish jellyfish turtle admiral). opts {x, z, now}.
     */
    seaEvent(kind, opts = {}) {
      if (!atSea()) return "not at sea";
      try {
        const ev = S.run.sim().sea.force(kind, opts);
        return ev ? { id: ev.id, kind: ev.kind, x: Math.round(ev.x), z: Math.round(ev.z), eta: ev.eta }
          : "unknown kind; try: spout squall waves derelict treasure kraken_arm fog gerald sky_whale dolphins flying_fish jellyfish turtle admiral";
      } catch (e) { return e?.message || String(e); }
    },
    /** v4: the boarding fight on screen (phase, who's staged). */
    boardfight: () => (S.bf ? { active: S.bf.active, phase: S.bf.phase, enemyId: S.bf.enemyId, stats: attempt("bf.stats", () => S.bf.stats?.()) } : null),
    /**
     * Board now, meeting a chosen captain: a struck ship of class `cls` (merchant brig frigate) laid alongside to starboard,
     * then B. `archetype`: normal gulls admiral chef pip bubbles encore clackers mime pale (null = the seeded pick).
     */
    board(archetype = null, cls = "merchant") {
      if (!atSea()) return "not at sea";
      if (S.run.phase() !== "sailing") return `not now (${S.run.phase()})`;
      if (!CLASSES[cls]?.boardable) return "that class can't be boarded; try merchant, brig or frigate";
      const sim = S.run.sim(), P = sim.S.ship;
      const at = offShip(36, 90);
      const e = sim.spawnShip(cls, cls === "merchant" ? "merchant" : "hunter", { x: at.x, z: at.z, r: 0 });
      // (Laid exactly there: the spawner moves a ship off a spot too near the harbour or the shore.)
      Object.assign(e, { x: at.x, z: at.z, heading: P.heading, speed: 0, vx: 0, vz: 0, wantSpeed: 0, wantHeading: P.heading, state: "surrender", surrenderT: 0, provoked: true });
      Object.assign(P, { speed: 0, vx: 0, vz: 0 });
      const forced = archetype ? S.run.setArchetype(archetype) : null;
      if (archetype && !forced) return "unknown archetype; try: normal gulls admiral chef pip bubbles encore clackers mime pale";
      const ok = S.run.input("board", { contactId: e.id });
      return ok ? { id: e.id, name: e.name, cls, archetype: S.run.fight()?.arch ?? null } : (S.run.state().boardable?.find((b) => b.contactId === e.id)?.problem || "refused");
    },
    S, A, bus,
  });
}
Object.defineProperty(window, "__nightraid", { value: Object.freeze(hooks), configurable: true });

// ---- Go ------------------------------------------------------------------------------

if (!Kit) console.debug(`${TAG} the games kit (neuro.js) didn't load; sailing without a companion connection`);

// The kit's dock grows with the companion's speech bubble: --nr-dock keeps the
// stylesheet's 150px as its floor, and rises above the bubble only for long lines.
// --nr-dock-h is its height right now (the boarding fight's strip rides just above it).
const DOCK_FLOOR = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nr-dock")) || 150;
function syncDock() {
  const dock = document.querySelector(".rx-dock");
  if (!dock || typeof ResizeObserver !== "function") return !!dock;
  new ResizeObserver(() => {
    const h = Math.ceil(dock.getBoundingClientRect().height), px = Math.max(DOCK_FLOOR, h);
    document.documentElement.style.setProperty("--nr-dock", `${px}px`);
    document.documentElement.style.setProperty("--nr-dock-h", `${h}px`);
  }).observe(dock);
  return true;
}
if (!syncDock()) new MutationObserver((_, mo) => { if (syncDock()) mo.disconnect(); }).observe(document.body, { childList: true });

boot().catch((error) => {
  console.debug(`${TAG} boot failed`, error);
  bus.emit("error", { type: "boot", error });
  veil.fail("The ship couldn't be readied. Reload the page to try again.");
});
