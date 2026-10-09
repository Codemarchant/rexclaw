// Random sea events (spec v4 §3; v4.2 the recurring spawner): seeded per run, the first ~45–75 s in, then one every
// ~60–120 s through a mission (free roam: from ~30–50 s, every ~40–75 s), each telegraphed 8–12 s before it starts and
// placed IN VIEW — 150–400 m off the Rexmaw within ±55° of the camera's look (else her bow), led by where she'll be
// when the telegraph ends — in open water and never on top of the objective; at its start it's checked again and moved
// back into view if she's turned away.
//
//   spout       1–2 waterspouts wander and pull ships in; contact costs hull and spins her
//   squall      a squall line rolls downwind over her: gusts, the visibility drops
//   waves       a set of three rogue waves from one direction (ride them bow or stern on)
//   derelict    an abandoned merchant adrift: stop alongside to salvage her (no fight)
//   treasure    a field of floating cargo for ~90 s
//   kraken_arm  one arm rises, drifts after her and slams the water; shoot it off
//   fog         (night) a fog bank rolls in on the wind
//
// The whacky ones (~40 % of the slots, never two in play at once; each telegraphed the same 8–12 s):
//
//   gerald      the chapbook's shark, grown: a fin circles in on her, a dark shape rises, he leaps right over the
//               Rexmaw and lands where she was going to be (the spot is marked): on her = hull + water on deck,
//               on an enemy = a hole in her
//   sky_whale   a blue whale breaches and keeps going: up into the clouds, a loop, a song, then a belly-flop
//               170–230 m off — its ring wave rocks every ship (meet it bow or stern on), capsizes the small ones,
//               and fish and treasure rain down round the splash
//   dolphins    a pod comes to run alongside: keep pace with them for 6 s and she rides their bow wave (+25 % speed)
//   flying_fish a swarm skims across her course: steer into it and supper lands on deck (a little gold)
//   jellyfish   (night) a bloom of giant glowing jellyfish: anything inside is zapped every 3 s — lead hunters in
//   turtle      an island-sized turtle surfaces with a palm and a chest on her back: alongside, slowly, for the chest
//   admiral     (day) the Seagull Admiral and the squadron dive-bomb the locked (else nearest) hostile — her guns'
//               reload set back each pass; with nobody to bomb the Admiral inspects us and leaves a medal
//
//   const sea = createSeaEvents(hooks)    hooks: the sim's {S, P, world, rng, tele, isWater, emit, objectivePoints,
//                                          hurtPlayer, spin, spawnDerelict, sinkShip, shipById, gainPlunder, addAmmo,
//                                          addPickup, removePickups, spawnWave, waveBusy}
//   sea.step(h)                            the clock: the schedule, the telegraphs, each event's own play
//   sea.driftAt(x, z) / fogAt(x, z) / visibility(x, z, v) / wind()  what the sim's physics and sight read
//   sea.speedMul()                         the dolphins' bow wave on the Rexmaw's speed cap (1 = none)
//   sea.splash(x, z, ammo, from) / sea.swivel(id)                    our shots at a Kraken arm
//   sea.state() → state.events[]           sea.spouts() / sea.banks()  mirrors for v3's drawing
//   sea.force(kind, {x, z, now})           tests and debug: warn one now
//
// Events: {type: "sea_event", id, kind, stage: warn|start|end|hit|salvaged|defeated, x, z, r, label, eta?, …}.
// Pure: no three.js, no DOM, no Math.random (the sim's seeded stream).

import { SEA_EVENTS as SE, SEA_KINDS, SEA_NORMAL, SEA_WHACKY, SEA_LABEL, SHIP, AMMO, FOG, WEAPONS, CLASSES } from "./const.js";
import { clamp, dist, forward, headingOf, wrap180, wrap360, segDist, metres, compass8Abbr } from "./geom.js";

const R1 = (v) => Math.round(v * 10) / 10;
/** The sky whale's flight, phase by phase (s): breach → climb → loop → glide → dive, then the flop. */
const WHALE_PHASES = ["breach", "climb", "loop", "glide", "dive"];

export function createSeaEvents(H) {
  const { S, P, world, rng } = H;
  const tele = () => (H.tele ? H.tele() : 1);
  const cfg = S.cfg || {};
  const night = !!S.night;
  const list = [];
  let n = 0;
  let boostT = 0;          // the dolphins' bow wave on the Rexmaw (s left)

  // ---- The schedule (v4.2: a recurring seeded spawner) ------------------------------------------------
  // The first FIRST s in, then one every GAP s (free roam FREE_FIRST / FREE_GAP) until the mission's last TAIL s. Each slot is
  // rolled up front from its own stream (whacky `SE.whacky` of the time, the kinds dealt from shuffled bags), so the same seed
  // gives the same schedule; at its time a whacky slot with another whacky one still in play takes an ordinary kind instead
  // (never two at once), and a kind already in play is passed over for the next in the bag.
  const kinds = SEA_NORMAL.filter((k) => (k !== "fog" || night) && !(k === "kraken_arm" && cfg.id === "krakens_wake"));
  const odd = SEA_WHACKY.filter((k) => (k !== "jellyfish" || night) && (k !== "admiral" || !night));
  const sr = typeof rng.fork === "function" ? rng.fork("schedule") : rng;
  const bagOf = (src, r) => { let b = []; return () => { if (!b.length) b = r.shuffle(src.slice()); return b.pop(); }; };
  const dealNormal = bagOf(kinds, sr), dealOdd = bagOf(odd.length ? odd : kinds, sr);
  const spare = bagOf(kinds, typeof rng.fork === "function" ? rng.fork("spare") : rng);
  const hi = (cfg.limit || 600) - SE.tail;
  const schedule = [];
  if (!world.arena && kinds.length) {
    const first = cfg.free ? SE.freeFirst : SE.first, gap = cfg.free ? SE.freeGap : SE.gap;
    for (let at = sr.range(first[0], first[1]); at <= hi; at += sr.range(gap[0], gap[1])) {
      const whacky = odd.length > 0 && sr.next() < SE.whacky;
      schedule.push({ at, kind: whacky ? dealOdd() : dealNormal(), whacky, tries: 0 });
    }
  }
  /** The slot's kind at its time: no second whacky one, no kind twice at once. */
  function kindNow(s) {
    const busy = new Set(list.map((ev) => ev.kind));
    let kind = s.kind;
    if (SEA_WHACKY.includes(kind) && list.some((ev) => SEA_WHACKY.includes(ev.kind))) kind = spare();
    for (let i = 0; i < kinds.length && busy.has(kind); i++) kind = spare();
    return busy.has(kind) ? null : kind;
  }

  const emit = (ev, stage, extra = {}) => H.emit({ type: "sea_event", id: ev.id, kind: ev.kind, stage, x: R1(ev.x), z: R1(ev.z), r: ev.r, label: ev.label, ...extra });
  const objPts = () => { try { return H.objectivePoints() || []; } catch { return []; } };
  const farFromObjective = (x, z, m = SE.clearObj) => objPts().every((p) => dist(x, z, p.x, p.z) >= m);
  const inBay = (x, z, m) => { const b = world.bounds; return x > b.minX + m && x < b.maxX - m && z > b.minZ + m && z < b.maxZ - m; };
  /** Open water clear of land, port, the maelstrom, the fort and the objective; `relax`: the nearer margins (SE.relax), so a
   *  spot in view can still be had when the objective, the fort or the maelstrom fill the view at the full ones. */
  function clearSpot(x, z, pad, relax = false) {
    const M = relax ? SE.relax : null;
    if (!inBay(x, z, 100)) return false;
    if (dist(x, z, world.port.x, world.port.z) < (M ? M.port : SE.clearPort)) return false;
    if (world.maelstrom && dist(x, z, world.maelstrom.x, world.maelstrom.z) < world.maelstrom.r + (M ? M.maelstrom : 150)) return false;
    if (world.fort && dist(x, z, world.fort.x, world.fort.z) < (M ? M.fort : SE.clearFort)) return false;
    if (pad != null && !H.isWater(x, z, pad)) return false;
    return farFromObjective(x, z, M ? M.obj : SE.clearObj);
  }

  // The camera's look (relative to her bow, from the Captain's aim intents): only once the input has sent one.
  const look0 = S.look;
  const lookAt = () => (S.look && S.look !== look0 && Number.isFinite(S.look.yaw) ? wrap360(P.heading + S.look.yaw) : null);
  const padOf = (kind) => (kind === "admiral" ? null : kind === "derelict" || kind === "sky_whale" ? 40 : kind === "turtle" || kind === "jellyfish" ? 60 : kind === "treasure" ? 30 : 25);
  /** The kinds put on a spot of their own (the waves come to her, the squall / fog roll down the wind, Gerald circles in). */
  const SPOTTED = new Set(["spout", "derelict", "treasure", "kraken_arm", "sky_whale", "dolphins", "flying_fish", "jellyfish", "turtle", "admiral"]);

  /** Is (x, z) where the Captain will see it: VIEW m off, within ±VIEW_ARC° of her bow or of the camera's look? */
  function inView(x, z) {
    const d = dist(x, z, P.x, P.z);
    if (!(d >= SE.view[0] && d <= SE.view[1])) return false;
    const brg = headingOf(x - P.x, z - P.z), look = lookAt();
    return Math.abs(wrap180(brg - P.heading)) <= SE.viewArc || (look != null && Math.abs(wrap180(brg - look)) <= SE.viewArc);
  }

  /** Where an event of `kind` goes now: {x, z} or null (try again later). `lead` s: where she'll be when its telegraph ends. */
  function place(kind, lead = 0, { viewOnly = false } = {}) {
    // The waves come to the Rexmaw wherever she is: not while she's right on the objective.
    if (kind === "waves") return objPts().every((p) => dist(P.x, P.z, p.x, p.z) >= SE.clearObj * 0.6) ? { x: P.x, z: P.z } : null;
    if (kind === "squall" || kind === "fog") {
      const up = kind === "squall" ? SE.squall.upwind : SE.fog.upwind;
      for (const off of [0, 40, -40, 80, -80, 120, -120]) {
        const f = forward(S.wind.dirDeg + off);
        const x = P.x + f.x * up, z = P.z + f.z * up;
        if (inBay(x, z, 0) && farFromObjective(x, z)) return { x, z };
      }
      return null;
    }
    const pad = padOf(kind);
    // In view: within ±ARC° of the camera's look first (when the Captain has looked), then of her bow — at the full
    // margins, then at the nearer ones (the objective, the fort or the maelstrom may fill the view); then off her
    // beams, then anywhere round her a little further out — all DIST m off where she'll be when the telegraph ends
    // (her velocity × `lead`, at most LEAD_MAX m), never closer than DIST to her now. `viewOnly`: the view cones alone.
    const vx = Number.isFinite(P.vx) ? P.vx : 0, vz = Number.isFinite(P.vz) ? P.vz : 0, v = Math.hypot(vx, vz);
    const k = v * lead > SE.leadMax ? SE.leadMax / (v * lead) : 1;
    const ox = P.x + vx * lead * k, oz = P.z + vz * lead * k;
    const look = lookAt();
    const view = [...(look != null ? [[look, SE.arc, 1]] : []), [P.heading, SE.arc, 1]];
    const cones = [...view, ...view.map(([c, a, f]) => [c, a, f, true]), ...(viewOnly ? [] : [[P.heading, 110, 1], [P.heading, 180, 1.3]])];
    for (const [c, arc, far, relax] of cones) {
      for (let i = 0; i < 16; i++) {
        const f = forward(c + rng.range(-arc, arc)), d = rng.range(SE.dist[0], SE.dist[1] * far);
        const x = ox + f.x * d, z = oz + f.z * d;
        if (dist(x, z, P.x, P.z) < SE.dist[0] * 0.8) continue;
        if (clearSpot(x, z, pad, !!relax)) return { x, z };
      }
    }
    return null;
  }

  function warn(kind, at, warnT = null) {
    const id = `sea${++n}`;
    const r = kind === "spout" ? SE.spout.pullR : kind === "squall" ? SE.squall.r : kind === "fog" ? SE.fog.r : kind === "treasure" ? SE.treasure.r
      : kind === "kraken_arm" ? SE.kraken_arm.slamR : kind === "derelict" ? 30 : kind === "gerald" ? SE.gerald.nearR : kind === "sky_whale" ? 60
        : kind === "dolphins" ? SE.dolphins.paceR : kind === "flying_fish" ? SE.flying_fish.catchR : kind === "jellyfish" ? SE.jellyfish.r
          : kind === "turtle" ? SE.turtle.r : kind === "admiral" ? 40 : 120;
    const ev = { id, kind, stage: "warn", x: at.x, z: at.z, r, label: SEA_LABEL[kind] || kind, warnT: warnT ?? rng.range(SE.warn[0], SE.warn[1]) * tele(), t: 0, dur: 0 };
    ev.eta = ev.warnT;
    if (kind === "gerald") { ev.finA = rng.range(0, Math.PI * 2); ev.finX = at.x; ev.finZ = at.z; }
    list.push(ev);
    emit(ev, "warn", { eta: R1(ev.warnT) });
    return ev;
  }

  // ---- Each kind --------------------------------------------------------------------------------------

  function start(ev) {
    ev.stage = "active"; ev.t = 0;
    // Checked again now (v4.2): she may have turned away over the telegraph, or the objective moved on; back into view.
    if (SPOTTED.has(ev.kind) && !ev.pinned && (!inView(ev.x, ev.z) || !clearSpot(ev.x, ev.z, padOf(ev.kind), true))) {
      const at = place(ev.kind, 0, { viewOnly: true });
      if (at) { ev.x = at.x; ev.z = at.z; ev.moved = true; }
    }
    const K = SE[ev.kind];
    switch (ev.kind) {
      case "spout": {
        ev.dur = rng.range(K.s[0], K.s[1]);
        const m = rng.int(K.n[0], K.n[1]);
        ev.spouts = [];
        for (let i = 0; i < m; i++) {
          const a = rng.range(0, Math.PI * 2), o = i ? rng.range(40, 70) : 0;
          ev.spouts.push({ id: `${ev.id}s${i + 1}`, x: ev.x + Math.cos(a) * o, z: ev.z + Math.sin(a) * o, r: K.r, pullR: K.pullR, dir: rng.range(0, 360), cd: 0, hit: {} });
        }
        break;
      }
      case "squall": {
        ev.dur = rng.range(K.s[0], K.s[1]);
        const f = forward(S.wind.dirDeg + 180);
        ev.vx = f.x * K.drift; ev.vz = f.z * K.drift; ev.intensity = 0;
        break;
      }
      case "waves": {
        ev.dur = SE.waves.s; ev.n = SE.waves.n; ev.done = 0; ev.next = 0; ev.spawned = 0;
        ev.dirDeg = wrap360(S.wind.dirDeg + 180 + rng.range(-35, 35));
        break;
      }
      case "derelict": {
        ev.dur = K.s; ev.gold = Math.round(rng.range(K.gold[0], K.gold[1]) / 10) * 10; ev.salvage = 0;
        const e = H.spawnDerelict({ x: ev.x, z: ev.z, heading: rng.range(0, 360) });
        ev.contactId = e ? e.id : null;
        break;
      }
      case "treasure": {
        ev.dur = K.s;
        const m = rng.int(K.n[0], K.n[1]);
        for (let i = 0; i < m; i++) {
          const a = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.next()) * K.r;
          const kind = i < 2 ? "chest" : i < 4 ? "crate" : i === 4 ? "bottle" : "flotsam";
          const value = kind === "chest" ? Math.round(rng.range(K.chest[0], K.chest[1]) / 5) * 5 : kind === "flotsam" ? Math.round(rng.range(K.flotsam[0], K.flotsam[1]) / 5) * 5
            : kind === "bottle" ? 60 : 20;
          H.addPickup({ id: `${ev.id}p${i + 1}`, kind, x: ev.x + Math.cos(a) * rr, z: ev.z + Math.sin(a) * rr, value, event: ev.id, age: 0 });
        }
        ev.total = m;
        break;
      }
      case "kraken_arm": {
        ev.dur = K.s; ev.hp = K.hp; ev.max = K.hp; ev.slamIn = K.every;
        break;
      }
      case "fog": {
        ev.dur = rng.range(K.s[0], K.s[1]);
        const f = forward(S.wind.dirDeg + 180);
        ev.vx = f.x * K.drift; ev.vz = f.z * K.drift; ev.density = 0;
        break;
      }
      case "gerald": startGerald(ev, K); break;
      case "sky_whale": startWhale(ev, K); break;
      case "dolphins": {
        ev.dur = K.s; ev.side = rng.sign(); ev.joined = false; ev.pace = 0; ev.boosted = false; ev.podH = headingOf(P.x - ev.x, P.z - ev.z); ev.podV = K.join;
        break;
      }
      case "flying_fish": {
        // Across her course: at where she'll be when they get there, a little ahead of her bow.
        const T = dist(ev.x, ev.z, P.x, P.z) / K.speed, f = forward(P.heading);
        const tx = P.x + P.vx * T + f.x * K.lead, tz = P.z + P.vz * T + f.z * K.lead;
        ev.dirDeg = headingOf(tx - ev.x, tz - ev.z); ev.run = dist(ev.x, ev.z, tx, tz) + K.past; ev.went = 0; ev.caught = false;
        ev.dur = Math.min(K.s, ev.run / K.speed + 1);
        break;
      }
      case "jellyfish": {
        ev.dur = K.s; ev.zapIn = K.every; ev.amt = 0;
        const f = forward(S.wind.dirDeg + 180);
        ev.vx = f.x * K.drift; ev.vz = f.z * K.drift;
        break;
      }
      case "turtle": {
        ev.dur = K.s; ev.grab = 0; ev.taken = false; ev.bumpCd = 0;
        ev.gold = Math.round(rng.range(K.gold[0], K.gold[1]) / 10) * 10;
        // She swims off across open water (the first heading with 200 m of sea ahead).
        const h0 = rng.range(0, 360);
        ev.heading = h0;
        for (let i = 0; i < 12; i++) {
          const hh = wrap360(h0 + i * 30), f = forward(hh);
          if ([60, 120, 200].every((d) => H.isWater(ev.x + f.x * d, ev.z + f.z * d, K.r))) { ev.heading = hh; break; }
        }
        break;
      }
      case "admiral": {
        ev.dur = K.s; ev.passes = 0; ev.diveIn = 0; ev.mode = "fly"; ev.targetId = null; ev.targetName = null; ev.medal = false; ev.leaveT = 0;
        ev.heading = headingOf(P.x - ev.x, P.z - ev.z);
        break;
      }
      default: break;
    }
    emit(ev, "start", { dur: R1(ev.dur), ...startExtra(ev) });
  }
  /** What the scene and the crew want to know when one starts (the leap's ends, the flop's spot, …). */
  function startExtra(ev) {
    if (ev.kind === "gerald") return { launch: { x: R1(ev.launch.x), z: R1(ev.launch.z) }, land: { x: R1(ev.land.x), z: R1(ev.land.z) } };
    if (ev.kind === "sky_whale") return { flop: { x: R1(ev.flop.x), z: R1(ev.flop.z) }, flopIn: R1(ev.flopAt) };
    return {};
  }

  /** Gerald: the leap is fixed when he rises — from beside her course to where she's going (± a few metres). */
  function startGerald(ev, K) {
    ev.phase = "rise"; ev.pt = 0;
    const T = K.rise + K.air, f = forward(P.heading), side = rng.sign();
    const nx = Math.cos(P.heading * Math.PI / 180) * side, nz = Math.sin(P.heading * Math.PI / 180) * side;
    const px = P.x + P.vx * T, pz = P.z + P.vz * T;
    const off = rng.range(K.land[0], K.land[1]), along = rng.range(-8, 8);
    ev.launch = { x: px + nx * K.launch - f.x * 12, z: pz + nz * K.launch - f.z * 12 };
    ev.land = { x: px - nx * off + f.x * along, z: pz - nz * off + f.z * along };
    ev.x = ev.launch.x; ev.z = ev.launch.z;
    ev.heading = headingOf(ev.land.x - ev.launch.x, ev.land.z - ev.launch.z);
    ev.dur = K.rise + K.air + K.swim;
  }

  /** The sky whale: the flop is fixed at the breach — 170–230 m off her, off to one side of where the whale came up
   *  (so it flies across her bow), in open water. */
  function startWhale(ev, K) {
    ev.phase = "breach"; ev.pt = 0; ev.bx = ev.x; ev.bz = ev.z;
    const toSpot = headingOf(ev.x - P.x, ev.z - P.z), side = rng.sign();
    let flop = null;
    for (let i = 0; i < 16 && !flop; i++) {
      const f = forward(toSpot + (i % 2 ? -side : side) * rng.range(45, 110)), d = rng.range(K.flopFrom[0], K.flopFrom[1]);
      const x = P.x + f.x * d, z = P.z + f.z * d, ds = dist(x, z, ev.x, ev.z);
      if (ds >= 150 && ds <= 560 && H.isWater(x, z, 40) && inBay(x, z, 60)) flop = { x, z };
    }
    if (!flop) { const f = forward(toSpot + 180); flop = { x: ev.x + f.x * 260, z: ev.z + f.z * 260 }; }
    ev.flop = flop;
    ev.heading = headingOf(flop.x - ev.x, flop.z - ev.z);
    ev.flopAt = K.breach + K.climb + K.loop + K.glide + K.dive;
    ev.dur = ev.flopAt + K.after;
    ev.ring = null; ev.crossed = {};
  }

  function end(ev, extra = {}) {
    if (ev.stage === "end") return;
    if (ev.kind === "treasure" || ev.kind === "sky_whale") H.removePickups((p) => p.event === ev.id);
    if (ev.kind === "derelict") {
      const e = ev.contactId ? H.shipById(ev.contactId) : null;
      if (e && !e.gone && e.state !== "sinking") H.sinkShip(e, ev.salvaged ? "scuttled" : "foundered");
    }
    ev.stage = "end";
    const i = list.indexOf(ev);
    if (i >= 0) list.splice(i, 1);
    emit(ev, "end", extra);
  }

  function play(ev, h) {
    const K = SE[ev.kind];
    ev.t += h;
    switch (ev.kind) {
      case "spout": {
        for (const sp of ev.spouts) {
          sp.cd = Math.max(0, sp.cd - h);
          sp.dir = wrap360(sp.dir + rng.range(-30, 30) * h);
          if (dist(sp.x, sp.z, ev.x, ev.z) > K.roam) sp.dir = headingOf(ev.x - sp.x, ev.z - sp.z);
          const f = forward(sp.dir);
          sp.x += f.x * K.speed * h; sp.z += f.z * K.speed * h;
          if (sp.cd <= 0 && dist(sp.x, sp.z, P.x, P.z) < sp.r + SHIP.radius + 4) {
            sp.cd = K.cd;
            const r = H.hurtPlayer(K.dmg, { cause: "spout", x: sp.x, z: sp.z });
            if (!r?.cancelled) { H.spin(1.2); emit(ev, "hit", { target: "rexmaw", spout: sp.id }); H.emit({ type: "hazard", kind: "spout", stage: "hit", id: sp.id, x: R1(sp.x), z: R1(sp.z) }); }
          }
          for (const e of S.ships) {
            if (e.gone || e.fixed || e.state === "sinking" || (sp.hit[e.id] ?? -1e9) > S.t - K.cd) continue;
            const C = e.C || CLASSES[e.cls];
            if (dist(sp.x, sp.z, e.x, e.z) < sp.r + C.beam / 2 + 2) { sp.hit[e.id] = S.t; e.hull -= K.dmg; if (e.hull <= 0) H.sinkShip(e, "spout"); }
          }
        }
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "squall": {
        ev.x += ev.vx * h; ev.z += ev.vz * h;
        ev.intensity = clamp(Math.min(ev.t / K.ramp, (ev.dur - ev.t) / (K.ramp + 2)), 0, 1);
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "waves": {
        ev.x = P.x; ev.z = P.z;
        ev.next -= h;
        if (ev.spawned < ev.n && ev.next <= 0 && !H.waveBusy()) {
          ev.spawned++;
          H.spawnWave(ev.dirDeg, (ev.spawned === 1 ? SE.waves.first : SE.waves.every) * tele(), { event: ev.id });
          ev.next = SE.waves.every;
        }
        if ((ev.spawned >= ev.n && !H.waveBusy()) || ev.t >= ev.dur) end(ev);
        break;
      }
      case "derelict": {
        const e = ev.contactId ? H.shipById(ev.contactId) : null;
        if (!e || e.gone || e.state === "sinking") { end(ev, { sunk: true }); break; }
        ev.x = e.x; ev.z = e.z;
        const C = e.C || CLASSES.merchant;
        const gap = dist(P.x, P.z, e.x, e.z) - (SHIP.beam / 2 + C.beam / 2);
        if (!ev.salvaged && gap <= K.gap && P.speed < K.speed) {
          ev.salvage = Math.min(1, ev.salvage + h / K.salvageS);
          if (ev.salvage >= 1) {
            ev.salvaged = true; e.salvaged = true;
            H.gainPlunder(ev.gold, "derelict");
            const ammo = H.addAmmo(K.ammo);
            emit(ev, "salvaged", { gold: ev.gold, ammo, contactId: e.id });
            end(ev, { salvaged: true });
            break;
          }
        } else if (!ev.salvaged) ev.salvage = Math.max(0, ev.salvage - h / K.salvageS);
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "treasure": {
        ev.left = S.pickups.filter((p) => p.event === ev.id).length;
        if (!ev.left) end(ev, { collected: true });
        else if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "kraken_arm": {
        const d = dist(ev.x, ev.z, P.x, P.z);
        if (d > 30) { ev.x += ((P.x - ev.x) / d) * K.speed * h; ev.z += ((P.z - ev.z) / d) * K.speed * h; }
        ev.slamIn -= h;
        if (ev.slamIn <= 0) {
          ev.slamIn = K.every;
          const f = forward(P.heading);
          const s = segDist(ev.x, ev.z, P.x + f.x * SHIP.half, P.z + f.z * SHIP.half, P.x - f.x * SHIP.half, P.z - f.z * SHIP.half);
          if (s.d <= K.slamR) {
            const r = H.hurtPlayer(K.dmg, { cause: "kraken_arm", x: ev.x, z: ev.z });
            if (!r?.cancelled) emit(ev, "hit", { target: "rexmaw", dmg: R1(r.dmg || K.dmg) });
          }
          for (const e of S.ships) {
            if (e.gone || e.fixed || e.state === "sinking") continue;
            if (dist(ev.x, ev.z, e.x, e.z) <= K.slamR + (e.C?.beam || 8) / 2) { e.hull -= K.dmg; if (e.hull <= 0) H.sinkShip(e, "kraken"); }
          }
        }
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "fog": {
        ev.x += ev.vx * h; ev.z += ev.vz * h;
        ev.density = K.density * clamp(Math.min(ev.t / K.fade, (ev.dur - ev.t) / K.fade), 0, 1);
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "gerald": playGerald(ev, K, h); break;
      case "sky_whale": playWhale(ev, K, h); break;
      case "dolphins": playDolphins(ev, K, h); break;
      case "flying_fish": {
        const f = forward(ev.dirDeg);
        ev.x += f.x * K.speed * h; ev.z += f.z * K.speed * h; ev.went += K.speed * h;
        if (!ev.caught && hullDist(ev.x, ev.z) <= K.catchR) {
          ev.caught = true;
          H.gainPlunder(K.gold, "fish");
          emit(ev, "caught", { gold: K.gold });
        }
        if (ev.went >= ev.run || ev.t >= ev.dur) end(ev, { caught: !!ev.caught });
        break;
      }
      case "jellyfish": {
        ev.x += ev.vx * h; ev.z += ev.vz * h;
        ev.amt = clamp(Math.min(ev.t / K.fade, (ev.dur - ev.t) / K.fade), 0, 1);
        ev.zapIn -= h;
        if (ev.zapIn <= 0 && ev.amt > 0.5) {
          ev.zapIn = K.every;
          const zapped = [];
          if (dist(P.x, P.z, ev.x, ev.z) < ev.r) {
            const r = H.hurtPlayer(K.dmg, { cause: "jellyfish", x: P.x, z: P.z, braceable: false });
            if (!r?.cancelled) { zapped.push("rexmaw"); emit(ev, "hit", { target: "rexmaw", dmg: R1(r.dmg || K.dmg) }); }
          }
          for (const e of S.ships) {
            if (e.gone || e.fixed || e.state === "sinking" || e.derelict || dist(e.x, e.z, ev.x, ev.z) >= ev.r) continue;
            e.hull -= K.enemyDmg; zapped.push(e.id);
            if (e.hull <= 0) H.sinkShip(e, "jellyfish");
          }
          if (zapped.length) emit(ev, "zap", { targets: zapped });
        }
        if (ev.t >= ev.dur) end(ev);
        break;
      }
      case "turtle": playTurtle(ev, K, h); break;
      case "admiral": playAdmiral(ev, K, h); break;
      default: if (ev.t >= 60) end(ev);
    }
  }

  /** The Rexmaw's hull line (bow to stern) to a point, m. */
  function hullDist(x, z) {
    const f = forward(P.heading);
    return segDist(x, z, P.x + f.x * SHIP.half, P.z + f.z * SHIP.half, P.x - f.x * SHIP.half, P.z - f.z * SHIP.half).d;
  }
  const afloat = (e) => e && !e.gone && !e.fixed && e.state !== "sinking";

  function playGerald(ev, K, h) {
    ev.pt += h;
    if (ev.phase === "rise" && ev.pt >= K.rise) { ev.phase = "air"; emit(ev, "leap", { air: K.air, apex: K.apex }); }
    if (ev.phase === "air") {
      const k = clamp((ev.pt - K.rise) / K.air, 0, 1);
      ev.x = ev.launch.x + (ev.land.x - ev.launch.x) * k; ev.z = ev.launch.z + (ev.land.z - ev.launch.z) * k;
      if (k >= 1) { geraldLands(ev, K); ev.phase = "swim"; }
    }
    if (ev.phase === "swim") { const f = forward(ev.heading); ev.x += f.x * 7 * h; ev.z += f.z * 7 * h; }
    if (ev.t >= ev.dur) end(ev, { landed: true, on: ev.onUs ? "rexmaw" : ev.onShip || null });
  }
  function geraldLands(ev, K) {
    const { x, z } = ev.land;
    const d = hullDist(x, z);
    if (d <= K.hitR) {
      const r = H.hurtPlayer(K.dmg, { cause: "gerald", x, z });
      ev.onUs = !r?.cancelled;
      if (ev.onUs) { P.water = Math.min(100, P.water + K.water); emit(ev, "hit", { target: "rexmaw", dmg: R1(r.dmg ?? K.dmg), landed: true }); }
    } else {
      const near = d <= K.nearR;
      if (near) P.water = Math.min(100, P.water + K.splashWater);
      emit(ev, "splash", { near, miss: Math.round(d) });
    }
    for (const e of S.ships) {
      if (!afloat(e) || e.derelict) continue;
      const C = e.C || CLASSES[e.cls] || CLASSES.merchant;
      if (dist(x, z, e.x, e.z) > K.hitR + C.beam / 2 + C.len * 0.25) continue;
      e.hull -= K.enemyDmg; ev.onShip = e.id;
      emit(ev, "hit", { target: e.id, name: e.name, dmg: K.enemyDmg, landed: true });
      if (e.hull <= 0) H.sinkShip(e, "gerald");
    }
  }

  function playWhale(ev, K, h) {
    ev.pt += h;
    if (ev.t < ev.flopAt) {
      // The flight (the scene draws it from the phase and its clock): breach → climb → loop → glide → dive.
      let t = ev.t, ph = "breach";
      for (const p of WHALE_PHASES) { const d = K[p]; if (t < d) { ph = p; break; } t -= d; ph = p; }
      if (ph !== ev.phase) { ev.phase = ph; ev.pt = 0; emit(ev, "phase", { phase: ph }); }
      // Its spot on the water under it: from the breach toward the flop, mostly over the glide and the dive.
      const k = clamp((ev.t - K.breach) / (ev.flopAt - K.breach), 0, 1);
      const w = k < 0.6 ? k * 0.5 : 0.3 + (k - 0.6) / 0.4 * 0.7;
      ev.x = ev.bx + (ev.flop.x - ev.bx) * w; ev.z = ev.bz + (ev.flop.z - ev.bz) * w;
      return;
    }
    if (!ev.ring) {
      // The belly-flop: the ring wave goes out; the fish and the treasure come down round the splash.
      ev.phase = "flop"; ev.pt = 0; ev.x = ev.flop.x; ev.z = ev.flop.z;
      ev.ring = { r: 0, max: K.ringMax };
      emit(ev, "flop", { ring: K.ringMax, speed: K.ring });
      const m = rng.int(K.loot[0], K.loot[1]);
      for (let i = 0; i < m; i++) {
        const a = rng.range(0, Math.PI * 2), rr = 15 + Math.sqrt(rng.next()) * (K.lootR - 15);
        const kind = i < 2 ? "chest" : i < 4 ? "bottle" : "crate";
        const value = kind === "chest" ? Math.round(rng.range(K.chest[0], K.chest[1]) / 5) * 5 : kind === "bottle" ? Math.round(rng.range(K.gold[0], K.gold[1]) / 5) * 5 : 20;
        H.addPickup({ id: `${ev.id}p${i + 1}`, kind, x: ev.flop.x + Math.cos(a) * rr, z: ev.flop.z + Math.sin(a) * rr, value, event: ev.id, age: 0 });
      }
      ev.total = m;
    }
    if (ev.ring.r < ev.ring.max) {
      ev.ring.r = Math.min(ev.ring.max, ev.ring.r + K.ring * h);
      const R = ev.ring.r, fx = ev.flop.x, fz = ev.flop.z;
      // The Rexmaw: ridden bow or stern on to the flop (within 30°), else it slews her (hull + water).
      if (!ev.crossed.rexmaw && R >= dist(fx, fz, P.x, P.z) - K.ringBand / 2) {
        ev.crossed.rexmaw = true;
        const a = Math.abs(wrap180(P.heading - headingOf(P.x - fx, P.z - fz)));
        if (a <= K.rideDeg || a >= 180 - K.rideDeg) emit(ev, "ridden", { target: "rexmaw", angle: Math.round(a) });
        else {
          const r = H.hurtPlayer(K.dmg, { cause: "whale_wave", x: P.x, z: P.z });
          if (!r?.cancelled) { P.water = Math.min(100, P.water + K.water); emit(ev, "hit", { target: "rexmaw", dmg: R1(r.dmg ?? K.dmg), angle: Math.round(a) }); }
        }
      }
      for (const e of S.ships) {
        if (!afloat(e) || e.derelict || ev.crossed[e.id] || R < dist(fx, fz, e.x, e.z) - K.ringBand / 2) continue;
        ev.crossed[e.id] = true;
        if (K.capsize.includes(e.cls) && R < K.ringMax * 0.65) { emit(ev, "capsized", { target: e.id, name: e.name }); H.sinkShip(e, "capsized"); }
        else { e.hull -= K.bigDmg; if (e.hull <= 0) H.sinkShip(e, "whale_wave"); }
      }
    }
    ev.left = S.pickups.filter((p) => p.event === ev.id).length;
    if (ev.t >= ev.dur || (ev.ring.r >= ev.ring.max && !ev.left)) end(ev, { collected: !ev.left });
  }

  function playDolphins(ev, K, h) {
    const f = forward(P.heading), pn = { x: Math.cos(P.heading * Math.PI / 180), z: Math.sin(P.heading * Math.PI / 180) };
    if (!ev.joined) {
      // They come to her: to a spot off her bow on one side, then run straight on her course.
      const tx = P.x + f.x * K.ahead + pn.x * K.side * ev.side, tz = P.z + f.z * K.ahead + pn.z * K.side * ev.side;
      const d = dist(ev.x, ev.z, tx, tz);
      ev.podH = headingOf(tx - ev.x, tz - ev.z);
      const step = Math.min(d, K.join * h);
      if (d > 0.01) { ev.x += (tx - ev.x) / d * step; ev.z += (tz - ev.z) / d * step; }
      if (d < 15 || ev.t > 25) { ev.joined = true; ev.podH = P.heading; ev.podV = K.speed; emit(ev, "joined", { side: ev.side > 0 ? "port" : "starboard" }); }
    } else {
      const g = forward(ev.podH);
      ev.x += g.x * ev.podV * h; ev.z += g.z * ev.podV * h;
      // Keeping pace: close by them, under way.
      if (!ev.boosted && dist(P.x, P.z, ev.x, ev.z) <= K.paceR && P.speed >= K.paceV) {
        ev.pace = Math.min(1, ev.pace + h / K.paceS);
        if (ev.pace >= 1) { ev.boosted = true; ev.boostedAt = ev.t; boostT = K.boostS; emit(ev, "boost", { mul: K.boost, s: K.boostS }); }
      }
      // Off they go once she's had her ride (they veer away).
      if (ev.boosted && ev.t - ev.boostedAt > 6) { ev.podH = wrap360(ev.podH + ev.side * 12 * h); ev.podV = K.join; }
    }
    if (ev.t >= ev.dur || (ev.boosted && ev.t - ev.boostedAt > 12)) end(ev, { boosted: !!ev.boosted });
  }

  function playTurtle(ev, K, h) {
    ev.bumpCd = Math.max(0, ev.bumpCd - h);
    let f = forward(ev.heading);
    if (!H.isWater(ev.x + f.x * (K.r + 30), ev.z + f.z * (K.r + 30), K.r)) { ev.heading = wrap360(ev.heading + 40 * h); f = forward(ev.heading); }
    const v = K.speed * clamp(ev.t / 4, 0, 1) * clamp((ev.dur - ev.t) / 6 + 0.3, 0, 1);
    ev.x += f.x * v * h; ev.z += f.z * v * h;
    const d = dist(P.x, P.z, ev.x, ev.z), gap = d - K.r - SHIP.beam / 2;
    // Sailing into her shell: a bump (she doesn't notice; the Rexmaw does).
    if (gap < -2 && ev.bumpCd <= 0) {
      ev.bumpCd = K.bumpCd;
      const r = H.hurtPlayer(K.bump, { cause: "turtle", x: ev.x, z: ev.z });
      P.speed *= 0.3;
      if (d > 0.1) { const push = -gap; P.x += (P.x - ev.x) / d * push; P.z += (P.z - ev.z) / d * push; }
      if (!r?.cancelled) emit(ev, "hit", { target: "rexmaw", dmg: R1(r.dmg ?? K.bump), bump: true });
    }
    if (!ev.taken && gap <= K.gap && P.speed < K.slow) {
      ev.grab = Math.min(1, ev.grab + h / K.salvageS);
      if (ev.grab >= 1) {
        ev.taken = true;
        H.gainPlunder(ev.gold, "turtle");
        const ammo = H.addAmmo(K.ammo);
        emit(ev, "salvaged", { gold: ev.gold, ammo });
      }
    } else if (!ev.taken) ev.grab = Math.max(0, ev.grab - h / K.salvageS);
    if (ev.t >= ev.dur) end(ev, { salvaged: !!ev.taken });
  }

  function playAdmiral(ev, K, h) {
    // The target: the locked hostile within reach, else the nearest; nobody → the Admiral inspects the Rexmaw.
    const hostile = (e) => afloat(e) && !e.derelict && (e.hostile || e.provoked) && dist(e.x, e.z, P.x, P.z) <= K.reach;
    let tgt = ev.targetId ? S.ships.find((e) => e.id === ev.targetId) : null;
    if (ev.mode !== "leave" && !hostile(tgt)) {
      const locked = S.marked ? S.ships.find((e) => e.id === S.marked) : null;
      tgt = hostile(locked) ? locked : null;
      if (!tgt) { let bd = Infinity; for (const e of S.ships) { if (!hostile(e)) continue; const d = dist(e.x, e.z, P.x, P.z); if (d < bd) { bd = d; tgt = e; } } }
      const id = tgt ? tgt.id : null;
      if (id !== ev.targetId) { ev.targetId = id; ev.targetName = tgt ? tgt.name : null; if (tgt) emit(ev, "target", { target: id, name: tgt.name }); }
    }
    const goal = ev.mode === "leave" ? { x: ev.x + forward(ev.heading).x * 100, z: ev.z + forward(ev.heading).z * 100 } : tgt || P;
    const d = dist(ev.x, ev.z, goal.x, goal.z);
    if (ev.mode !== "leave") ev.heading = headingOf(goal.x - ev.x, goal.z - ev.z);
    const fl = forward(ev.heading), step = Math.min(Math.max(0, d - 6), K.fly * h);
    ev.x += fl.x * (ev.mode === "leave" ? K.fly * h : step); ev.z += fl.z * (ev.mode === "leave" ? K.fly * h : step);
    if (ev.mode === "fly" && d < 30) { ev.mode = tgt ? "dive" : "inspect"; ev.diveIn = 0.8; }
    if (ev.mode === "dive") {
      if (!tgt) ev.mode = "fly";
      else {
        ev.diveIn -= h;
        if (ev.diveIn <= 0) {
          ev.diveIn = K.every; ev.passes++;
          tgt.hull -= K.dmg;
          for (const b of Object.values(tgt.batteries || {})) if (b && b.guns > 0) b.loaded = Math.min(b.loaded ?? 1, K.loaded);
          emit(ev, "dive", { target: tgt.id, name: tgt.name, pass: ev.passes });
          if (tgt.hull <= 0) H.sinkShip(tgt, "gulls");
          if (ev.passes >= K.passes) { ev.mode = "leave"; ev.leaveT = ev.t; }
        }
      }
    }
    // An inspection takes a few turns round her before the medal comes down.
    if (ev.mode === "inspect" && !ev.medal && (ev.inspectT = (ev.inspectT || 0) + h) >= K.inspect) {
      ev.medal = true; H.gainPlunder(K.medal, "admiral");
      emit(ev, "medal", { gold: K.medal });
      ev.mode = "leave"; ev.leaveT = ev.t;
    }
    if (ev.t >= ev.dur || (ev.mode === "leave" && ev.t - ev.leaveT > 5)) end(ev, { passes: ev.passes, medal: !!ev.medal });
  }

  // ---- The clock -----------------------------------------------------------------------------------------

  function step(h) {
    for (const s of schedule) {
      if (s.done || S.t < s.at) continue;
      if (S.boarding) { s.at = S.t + 5; continue; }    // not while the deck fight is on (the world's at a crawl)
      const kind = kindNow(s);
      const warnT = rng.range(SE.warn[0], SE.warn[1]) * tele();
      const at = kind ? place(kind, warnT) : null;
      if (at) { s.done = true; s.kind = kind; warn(kind, at, warnT); }
      else if (++s.tries > 6) s.done = true;   // nowhere fair to put it (or every kind already in play): skipped
      else s.at = S.t + SE.retry;
    }
    for (const ev of list.slice()) {
      if (ev.stage === "warn") {
        ev.warnT -= h; ev.eta = Math.max(0, ev.warnT);
        if (ev.kind === "waves") { ev.x = P.x; ev.z = P.z; }
        if (ev.kind === "squall" || ev.kind === "fog") { const f = forward(S.wind.dirDeg + 180), sp = ev.kind === "squall" ? SE.squall.drift : SE.fog.drift; ev.x += f.x * sp * h; ev.z += f.z * sp * h; }
        if (ev.kind === "gerald") {
          // The fin circles, and the circle closes on her (to about the leap's length off).
          const K = SE.gerald, d = dist(ev.x, ev.z, P.x, P.z);
          if (d > K.launch + 10) { ev.x += (P.x - ev.x) / d * K.approach * h; ev.z += (P.z - ev.z) / d * K.approach * h; }
          ev.finA += h * 0.35;
          ev.finX = ev.x + Math.cos(ev.finA) * K.circleR; ev.finZ = ev.z + Math.sin(ev.finA) * K.circleR;
        }
        if (ev.warnT <= 0) start(ev);
        continue;
      }
      play(ev, h);
    }
    boostT = Math.max(0, boostT - h);
  }

  // ---- What the sim reads --------------------------------------------------------------------------------

  /** The waterspouts' pull at (x, z): a drift (m/s) toward each one within its reach, with a little swirl. */
  function driftAt(x, z) {
    let dx = 0, dz = 0;
    for (const ev of list) {
      if (ev.kind !== "spout" || ev.stage !== "active") continue;
      for (const sp of ev.spouts) {
        const d = dist(x, z, sp.x, sp.z);
        if (d >= sp.pullR || d < 1) continue;
        const v = SE.spout.pull * (1 - d / sp.pullR);
        const ux = (sp.x - x) / d, uz = (sp.z - z) / d;
        dx += ux * v + uz * v * 0.4; dz += uz * v - ux * v * 0.4;
      }
    }
    return { x: dx, z: dz };
  }
  /** The rolling fog banks' density at (x, z). */
  function fogAt(x, z) {
    let f = 0;
    for (const ev of list) if (ev.kind === "fog" && ev.stage === "active") { const d = dist(x, z, ev.x, ev.z); if (d < ev.r) f = Math.max(f, ev.density * clamp((ev.r - d) / FOG.edge, 0, 1)); }
    return f;
  }
  /** The squalls' grip on the visibility at (x, z). */
  function visibility(x, z, v) {
    for (const ev of list) {
      if (ev.kind !== "squall" || ev.stage !== "active") continue;
      const d = dist(x, z, ev.x, ev.z);
      if (d >= ev.r) continue;
      const k = ev.intensity * clamp((ev.r - d) / 60, 0, 1);
      v = Math.min(v, v + (SE.squall.visibility - v) * k);
    }
    return v;
  }
  /** The squall's gusts on the Rexmaw: {strength, dir} to add to the wind. */
  function wind() {
    let strength = 0, dir = 0;
    for (const ev of list) {
      if (ev.kind !== "squall" || ev.stage !== "active" || dist(P.x, P.z, ev.x, ev.z) >= ev.r) continue;
      strength += SE.squall.gust * ev.intensity * (0.6 + 0.4 * Math.sin(ev.t * 1.3));
      dir += SE.squall.swing * ev.intensity * Math.sin(ev.t * 0.45);
    }
    return { strength, dir };
  }
  /** One of our balls splashed at (x, z): a Kraken arm right there takes it. */
  function splash(x, z, ammo) {
    for (const ev of list.slice()) {
      if (ev.kind !== "kraken_arm" || ev.stage !== "active") continue;
      if (dist(x, z, ev.x, ev.z) > SE.kraken_arm.splashR) continue;
      armHit(ev, (AMMO[ammo] || AMMO.round).hull, ammo);
      return true;
    }
    return false;
  }
  function armHit(ev, dmg, by) {
    ev.hp = Math.max(0, ev.hp - dmg);
    H.emit({ type: "impact", target: ev.id, x: R1(ev.x), y: 3, z: R1(ev.z), dmg: R1(dmg), kind: "hull", ammo: by, from: "rexmaw" });
    if (ev.hp > 0) return;
    H.gainPlunder(SE.kraken_arm.gold, "kraken");
    emit(ev, "defeated", { gold: SE.kraken_arm.gold });
    end(ev, { defeated: true });
  }
  /** The Captain's swivel at an arm (by its event id): within the swivel's reach. */
  function swivel(id) {
    const ev = list.find((x) => x.id === id && x.kind === "kraken_arm" && x.stage === "active");
    if (!ev) return null;
    if (dist(P.x, P.z, ev.x, ev.z) > WEAPONS.swivel.range) return { hit: false, reason: "out of range" };
    armHit(ev, SE.kraken_arm.swivel, "swivel");
    return { hit: true };
  }

  /** state.events[]. */
  function state() {
    return list.map((ev) => {
      const o = { id: ev.id, kind: ev.kind, stage: ev.stage, x: R1(ev.x), z: R1(ev.z), r: ev.r, label: ev.label,
        eta: ev.stage === "warn" ? R1(ev.eta) : 0, t: R1(ev.t), left: ev.stage === "active" ? R1(Math.max(0, ev.dur - ev.t)) : null };
      if (ev.kind === "spout") o.spouts = (ev.spouts || []).map((sp) => ({ id: sp.id, x: R1(sp.x), z: R1(sp.z), r: sp.r, pullR: sp.pullR }));
      // Unrounded: the scene scales the sea's storm height by it, and 0.1 steps lurched the whole sea as it ramped in.
      if (ev.kind === "squall") { o.intensity = ev.intensity || 0; o.visibility = SE.squall.visibility; }
      if (ev.kind === "waves") { o.n = SE.waves.n; o.done = ev.spawned || 0; o.next = R1(Math.max(0, ev.next || 0)); o.dirDeg = ev.dirDeg != null ? Math.round(ev.dirDeg) : null; }
      if (ev.kind === "derelict") { o.contactId = ev.contactId || null; o.salvage = R1(ev.salvage || 0); }
      if (ev.kind === "treasure") o.left = ev.stage === "active" ? S.pickups.filter((p) => p.event === ev.id).length : null;
      if (ev.kind === "kraken_arm") { o.hp = ev.hp != null ? R1(ev.hp) : SE.kraken_arm.hp; o.max = SE.kraken_arm.hp; o.slamIn = ev.slamIn != null ? R1(ev.slamIn) : null; o.slamR = SE.kraken_arm.slamR; }
      if (ev.kind === "fog") { o.density = R1(ev.density || 0); o.vx = R1(ev.vx || 0); o.vz = R1(ev.vz || 0); }
      // The whacky ones: what the scene stages and the chips say (each `phase` with its clock `phaseT`).
      if (ev.kind === "gerald") {
        const K = SE.gerald;
        Object.assign(o, { phase: ev.phase || "circle", phaseT: R1(ev.pt || 0), heading: Math.round(ev.heading || 0), apex: K.apex, rise: K.rise, air: K.air,
          fin: ev.stage === "warn" ? { x: R1(ev.finX), z: R1(ev.finZ), a: R1(ev.finA) } : null });
        if (ev.launch) { o.launch = { x: R1(ev.launch.x), z: R1(ev.launch.z) }; o.land = { x: R1(ev.land.x), z: R1(ev.land.z), r: K.hitR }; o.landIn = R1(Math.max(0, K.rise + K.air - (ev.t || 0))); }
      }
      if (ev.kind === "sky_whale") {
        const K = SE.sky_whale;
        Object.assign(o, { phase: ev.phase || "blow", phaseT: R1(ev.pt || 0), heading: Math.round(ev.heading || 0) });
        if (ev.flop) {
          Object.assign(o, { bx: R1(ev.bx), bz: R1(ev.bz), flop: { x: R1(ev.flop.x), z: R1(ev.flop.z) }, flopIn: R1(Math.max(0, ev.flopAt - ev.t)),
            times: { breach: K.breach, climb: K.climb, loop: K.loop, glide: K.glide, dive: K.dive } });
          o.ring = ev.ring ? { r: R1(ev.ring.r), max: ev.ring.max, speed: K.ring, band: K.ringBand } : null;
          o.afloat = ev.ring ? S.pickups.filter((p) => p.event === ev.id).length : null;
        }
      }
      if (ev.kind === "dolphins") Object.assign(o, { heading: Math.round(ev.podH ?? 0), speed: R1(ev.podV ?? 0), joined: !!ev.joined, pace: R1(ev.pace || 0), boosted: !!ev.boosted, boostLeft: R1(boostT) });
      if (ev.kind === "flying_fish") Object.assign(o, { heading: Math.round(ev.dirDeg ?? 0), speed: SE.flying_fish.speed, caught: !!ev.caught });
      if (ev.kind === "jellyfish") Object.assign(o, { amt: R1(ev.amt || 0), zapIn: R1(Math.max(0, ev.zapIn ?? SE.jellyfish.every)), vx: R1(ev.vx || 0), vz: R1(ev.vz || 0) });
      if (ev.kind === "turtle") Object.assign(o, { heading: Math.round(ev.heading ?? 0), speed: SE.turtle.speed, grab: R1(ev.grab || 0), taken: !!ev.taken });
      if (ev.kind === "admiral") Object.assign(o, { heading: Math.round(ev.heading ?? 0), mode: ev.mode || "fly", targetId: ev.targetId || null, targetName: ev.targetName || null,
        passes: ev.passes || 0, medal: !!ev.medal });
      return o;
    });
  }
  /** v3-shaped mirrors: the waterspouts for hazards.spouts, the fog banks for fog.banks. */
  const spouts = () => list.flatMap((ev) => (ev.kind === "spout" ? (ev.stage === "active" ? ev.spouts.map((sp) => ({ id: sp.id, x: R1(sp.x), z: R1(sp.z), r: sp.r, stage: "active", event: ev.id }))
    : [{ id: `${ev.id}s1`, x: R1(ev.x), z: R1(ev.z), r: SE.spout.r, stage: "forming", event: ev.id }]) : []));
  const banks = () => list.filter((ev) => ev.kind === "fog" && ev.stage === "active").map((ev) => ({ id: ev.id, x: R1(ev.x), z: R1(ev.z), r: ev.r, density: R1(ev.density) }));

  /** A fact line for the companion's brief (warn/start), in compass words. */
  function factFor(ev, stage) {
    const d = dist(P.x, P.z, ev.x, ev.z), brg = compass8Abbr(headingOf(ev.x - P.x, ev.z - P.z));
    const where = ev.kind === "waves" ? "" : ` ${metres(d)} ${brg}`;
    const what = {
      spout: "a waterspout forming", squall: "a squall line coming down the wind", waves: "a set of rogue waves building", derelict: "a derelict adrift (stop alongside to salvage her)",
      treasure: "floating cargo glinting on the water", kraken_arm: "something huge stirring below", fog: "a fog bank rolling in",
      gerald: "a shark's fin circling in on us — a very big one (the crew say it's Gerald, from Rex's chapbook)",
      sky_whale: "a whale blowing", dolphins: "a dolphin pod heading our way", flying_fish: "a flying-fish swarm stirring the water",
      jellyfish: "a glow under the water: a jellyfish bloom", turtle: "an island that wasn't on the chart (it's moving: a giant turtle)",
      admiral: "gulls in formation: the Seagull Admiral and the squadron",
    }[ev.kind] || ev.kind;
    if (stage === "warn") return `${what[0].toUpperCase()}${what.slice(1)}${where}, in ~${Math.max(1, Math.round(ev.eta))} s.`;
    const live = {
      spout: `${ev.spouts?.length || 1} waterspout${ev.spouts?.length === 2 ? "s" : ""}${where}: they pull ships in within ${SE.spout.pullR} m and hit for ${SE.spout.dmg}.`,
      squall: `The squall is on us${where}: gusts, visibility down to ${SE.squall.visibility} m inside it.`,
      waves: `Rogue waves from the ${compass8Abbr((ev.dirDeg ?? 0) + 180)}: three of them, ${SE.waves.every} s apart; meet them bow or stern on (within 25°).`,
      derelict: `A derelict merchant${where}, nobody aboard: under ${SE.derelict.speed} m/s within ${SE.derelict.gap} m of her for ${SE.derelict.salvageS} s salvages her.`,
      treasure: `Floating cargo${where}: chests and crates for ~${Math.round(SE.treasure.s)} s.`,
      kraken_arm: `A Kraken arm${where}, slamming the water every ${SE.kraken_arm.every} s within ${SE.kraken_arm.slamR} m; shot or the swivel knock it off (${SE.kraken_arm.hp} hp).`,
      fog: `A fog bank rolling in${where}: ~110 m visibility inside.`,
      gerald: ev.land ? `Gerald is leaping at us: he lands ${metres(hullDist(ev.land.x, ev.land.z))} ${compass8Abbr(headingOf(ev.land.x - P.x, ev.land.z - P.z))} of us in ~${Math.max(1, Math.round(SE.gerald.rise + SE.gerald.air - ev.t))} s (the dark patch on the water); `
        + `on us that's ${SE.gerald.dmg} hull and water on deck: turn away now. On an enemy it's a hole in her.` : `Gerald${where}.`,
      sky_whale: ev.flop ? `The whale${where} isn't stopping: it's flying up into the clouds and will belly-flop ~${metres(dist(P.x, P.z, ev.flop.x, ev.flop.z))} ${compass8Abbr(headingOf(ev.flop.x - P.x, ev.flop.z - P.z))} of us in ~${Math.round(ev.flopAt - ev.t)} s. `
        + `Its ring wave rocks every ship: meet it bow or stern on (within ${SE.sky_whale.rideDeg}°), small ships capsize; fish and treasure rain down round the splash.` : `A whale${where}.`,
      dolphins: `A dolphin pod${where} coming to run alongside: keep pace with them (within ${SE.dolphins.paceR} m, at ${SE.dolphins.paceV}+ m/s) for ${SE.dolphins.paceS} s and we ride their bow wave (+${Math.round((SE.dolphins.boost - 1) * 100)}% speed for ${SE.dolphins.boostS} s).`,
      flying_fish: `Flying fish${where} skimming across our bow: steer into the swarm and supper lands on deck (+${SE.flying_fish.gold} gold).`,
      jellyfish: `A bloom of giant jellyfish${where}, ${SE.jellyfish.r} m across: anything inside is stung every ${SE.jellyfish.every} s (us ${SE.jellyfish.dmg} hull, them ${SE.jellyfish.enemyDmg}). Keep clear, or lead hunters through it.`,
      turtle: `A giant turtle${where} with a palm and a chest on her back, swimming slowly: come alongside (within ${SE.turtle.gap} m, under ${SE.turtle.slow} m/s) for ${SE.turtle.salvageS} s and the chest is ours. Don't ram her shell.`,
      admiral: `The Seagull Admiral and the squadron${where}: they dive-bomb the locked hostile (else the nearest) within ${SE.admiral.reach} m, setting her guns' reload back each pass; with nobody to bomb the Admiral inspects us.`,
    };
    return live[ev.kind] || `${ev.label}${where}.`;
  }

  /** Tests and debug: warn one of `kind` now (at x, z or the usual place; `now` skips the telegraph). */
  function force(kind, { x = null, z = null, now = false } = {}) {
    if (!SEA_KINDS.includes(kind)) return null;
    const pinned = x != null && z != null;
    const at = pinned ? { x, z } : place(kind) || { x: P.x + forward(P.heading).x * 300, z: P.z + forward(P.heading).z * 300 };
    const ev = warn(kind, at);
    ev.pinned = pinned;
    if (now) { ev.warnT = 0; ev.eta = 0; start(ev); }
    return ev;
  }

  /** The dolphins' bow wave on the Rexmaw's speed cap. */
  const speedMul = () => (boostT > 0 ? SE.dolphins.boost : 1);

  return {
    step, driftAt, fogAt, visibility, wind, splash, swivel, state, spouts, banks, force, factFor, speedMul,
    list: () => list, schedule: () => schedule.map((s) => ({ at: Math.round(s.at), kind: s.kind, whacky: !!s.whacky, done: !!s.done })),
    inView,
    byId: (id) => list.find((ev) => ev.id === id) || null,
  };
}
