// The bay around the Rexmaw (v2 spec §6 Audio): a gentle, unobtrusive sea.
//
// v1's bay had a "rigging singing" bed (three pure sines at 1.25/1.87/2.46 kHz
// over Q60 bandpassed noise, always on) and hissy wind/wash beds (white noise
// at 2.6 kHz and above 1.8 kHz): that was the loud ringing. It's gone. Now:
//
//   sea     the swell: brown noise under a 380 Hz lowpass, slow lapping waves
//           (pink noise through a closing lowpass), nothing above ~1.5 kHz
//   wash    the bow wash, only with way on: pink + brown under 1.1 kHz lowpasses
//   gale    the storm's wind (and a v4 squall's): lower and harder, no whistles
//   town    the harbour's murmur near home port
//
// v4: the always-on sea-breeze bed ("wind", pink noise rising with speed) is
// gone (Jonathan: too loud, not good), and the beds sit lower: what's left in
// fair weather is the water lapping and the wash, the creaks and the rare
// one-shots. Wind is heard only inside weather (the storm cell, a squall).
//
// One-shots on top: the hull creaking on a hard turn (rate-limited), gulls by
// day near land or now and then far off, a buoy bell (rare, distant, a single
// strike) near reefs, shoals and the harbour mouth, far thunder in the storm.
// Held loops from the effect bank: rain in the storm cell, the maelstrom, the
// nearest waterspout, fire on our deck.
//
//   ambience.start()             // safe any time: waits for the first gesture
//   ambience.update(tickState)   // speed, sail, rudder, daylight, storm, maelstrom, spouts, fires, harbour, pause
//   ambience.setWorld(world)     // the port, the maelstrom, the reefs and shoals (buoys)
//   ambience.duck(audioEl)       // −4 dB while a voice line plays
//   ambience.wire(bus)           // follow `tick`, the world (`phase {world}`), pause / resume
//
//   beds ─▶ storm lowpass ─▶ level (Kraken, paused, boarding) ─▶ duck/mute ─▶ speakers

import { SR, render, finish, loopify, graph, db } from "./dsp.js";
import { mix } from "./mix.js";

const Kit = () => globalThis.RexGame || null;
const LOOP = 24, OVERLAP = 3;
/** m/s: half sail 9, full sail 16, the sprint 21 (core SAILS / SPRINT). */
export const SPEEDS = Object.freeze({ half: 9, full: 16, sprint: 21 });

const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** The beds: `level` is the gain at full presence; `build(h, len)` renders one loop. */
export const BEDS = {
  /** The swell: a slow heave of low water and soft laps against the hull. */
  sea: { level: 0.26, build(h, len) {
    for (const pan of [-0.6, 0.6]) {
      const g = h.gain(0.55, h.pan(pan, h.out));
      h.osc("sine", 0.08 + Math.random() * 0.03, 0, len, h.gain(0.3, g.gain));
      h.noise("brown", 0, len, h.filter("lowpass", 380, 0.5, g));
    }
    for (let t = 0.6; t < len - 2; t += 2.6 + Math.random() * 3.4) {   // a lap: a soft rush that closes down
      const g = h.gain(0, h.pan(Math.random() * 1.4 - 0.7, h.out)), amp = 0.12 + Math.random() * 0.14, dur = 1 + Math.random() * 1.1;
      h.swell(g.gain, t, dur * 0.4, amp, dur * 0.1, dur * 0.9);
      const lp = h.filter("lowpass", 1200, 0.5, g);
      lp.frequency.setValueAtTime(1300, t); lp.frequency.exponentialRampToValueAtTime(320, t + dur * 1.4);
      h.noise("pink", t, t + dur * 1.5, lp);
    }
  } },
  /** The bow wash: water folding along the hull, faster and fuller with speed (playbackRate follows it). */
  wash: { level: 0.2, build(h, len) {
    for (const pan of [-0.5, 0.5]) {
      const g = h.gain(0.5, h.pan(pan, h.out));
      h.osc("sine", 0.17 + Math.random() * 0.05, 0, len, h.gain(0.25, g.gain));
      h.noise("pink", 0, len, h.filter("lowpass", 1100, 0.5, h.gain(0.7, g)));
      h.noise("brown", 0, len, h.filter("lowpass", 500, 0.5, g));
    }
    for (let t = 0.3; t < len - 0.6; t += 0.4 + Math.random() * 0.9) {   // the bow dipping
      const g = h.gain(0, h.pan(Math.random() * 1.2 - 0.6, h.out));
      h.swell(g.gain, t, 0.08, 0.12 + Math.random() * 0.12, 0.05, 0.35);
      h.noise("pink", t, t + 0.5, h.filter("lowpass", 900 + Math.random() * 400, 0.5, g));
    }
  } },
  /** Storm wind: lower and harder, longer gusts; no whistles. Only inside weather (the storm cell, a squall). */
  gale: { level: 0.26, build(h, len) {
    for (const [pan, hz] of [[-0.7, 220], [0.7, 420]]) {
      const g = h.gain(0, h.pan(pan, h.out));
      let t = 0;
      g.gain.setValueAtTime(0.5, 0);
      while (t < len) { g.gain.setTargetAtTime(0.35 + Math.random() ** 1.2 * 0.65, t, 0.6); t += 0.8 + Math.random() * 1.8; }
      const bp = h.filter("bandpass", hz, 0.8, h.filter("lowpass", 900, 0.5, g));
      h.osc("sine", 0.11 + Math.random() * 0.08, 0, len, h.gain(hz * 0.4, bp.frequency));
      h.noise("pink", 0, len, bp);
      h.noise("brown", 0, len, h.gain(0.6, h.filter("lowpass", 160, 0.5, g)));
    }
  } },
  /** Home port: a murmur of voices and work ashore. */
  town: { level: db(-38) * 8, build(h, len) {
    for (const pan of [-0.3, 0.3]) {
      const g = h.gain(0.8, h.pan(pan, h.out)), talk = h.gain(0.6, g);
      let t = 0;
      while (t < len) { talk.gain.setTargetAtTime(0.35 + Math.random() * 0.65, t, 0.05); t += 0.12 + Math.random() * 0.25; }
      h.noise("pink", 0, len, h.filter("highpass", 300, 0.7, h.filter("lowpass", 900, 0.7, talk)));
    }
  } },
};

/**
 * The beds' gains for a moment of the voyage (pure: the harness mixes with it too).
 * @param {{speed?: number, sail?: number, storm?: number, harbour?: number, day?: number, turn?: number}} st
 * @returns {Record<string, number>}
 */
export function bedGains(st = {}) {
  const speed = Math.max(0, Number(st.speed) || 0), storm = Math.max(0, Math.min(1, Number(st.storm) || 0));
  const harbour = Math.max(0, Math.min(1, Number(st.harbour) || 0));
  const v = smooth(speed / SPEEDS.full), sprint = smooth((speed - SPEEDS.full) / (SPEEDS.sprint - SPEEDS.full));
  return {
    sea: BEDS.sea.level * (1 - 0.3 * harbour) * (1 + 0.5 * storm),
    wash: BEDS.wash.level * Math.pow(v, 1.2) * (1 + 0.25 * sprint),
    gale: BEDS.gale.level * storm,
    town: BEDS.town.level * smooth(harbour),
  };
}

/**
 * Build the bay's ambience.
 * @param {{R?: object|null, sfx?: object|null}} [opts]  the render context (listener) and the effect bank
 */
export function createAmbience({ R = null, sfx = null } = {}) {
  const loops = {};
  const st = { speed: 0, sail: 1, storm: 0, harbour: 1, day: 1, paused: false, kraken: false, boarding: false, x: 0, z: 0, fires: 0, phase: "title" };
  let live = null, wantStart = false, disposed = false, ducks = 0, armed = false;
  let world = null, buoys = [], lastRudder = 0, lastCreak = 0, thunderTimer = 0, muteTimer = 0, nextGull = 0, nextBell = 0;
  let rain = null, fire = null, mael = null, spout = null, spoutId = null;

  const ready = (async () => {
    try { await sfx?.ready; } catch { /* the beds don't need it */ }
    if (!globalThis.OfflineAudioContext && !globalThis.webkitOfflineAudioContext) return;
    const t0 = performance.now();
    await Promise.all(Object.entries(BEDS).map(async ([name, bed]) => {
      try {
        const raw = await render(LOOP + OVERLAP, (h) => bed.build(h, LOOP + OVERLAP), { channels: 2, sampleRate: SR });
        loops[name] = finish(loopify(raw, LOOP), { target: 0.9, fadeIn: 0, fadeOut: 0 });
      } catch (error) { console.debug(`[rexmaw-raids] ambience ${name} failed to render`, error); }
    }));
    console.debug(`[rexmaw-raids] ambience: beds rendered in ${(performance.now() - t0).toFixed(0)} ms`);
    if (wantStart) begin();
  })();

  const muted = () => !!Kit()?.sfx?.muted?.();
  const gestured = () => !globalThis.navigator?.userActivation || navigator.userActivation.hasBeenActive;

  function begin() {
    if (live || disposed || !Object.keys(loops).length) return;
    if (!gestured()) { arm(); return; }
    const ctx = Kit()?.sfx?.context?.();
    if (!ctx) return;
    const h = graph(ctx);
    h.out.disconnect();
    const bus = h.gain(0, ctx.destination);
    const level = h.gain(1, bus);
    const lp = h.filter("lowpass", 12000, -3, level);
    const node = {};
    for (const [name, buf] of Object.entries(loops)) {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = h.gain(0);
      src.connect(g).connect(lp);
      src.start(ctx.currentTime + 0.05, Math.random() * LOOP);
      node[name] = { src, g };
    }
    live = { ctx, h, bus, level, lp, node, busTarget: -1 };
    apply(2.5);
    scheduleThunder();
    muteTimer = setInterval(() => applyBus(0.3), 400);
  }

  function arm() {
    if (armed) return;
    armed = true;
    const go = () => { removeEventListener("pointerdown", go, true); removeEventListener("keydown", go, true); setTimeout(begin, 0); };
    addEventListener("pointerdown", go, true);
    addEventListener("keydown", go, true);
  }

  function apply(seconds = 1.5) {
    if (!live) return;
    const { ctx, node, level, lp } = live, t = ctx.currentTime, tc = Math.max(0.05, seconds / 3);
    const set = (param, v) => { param.cancelScheduledValues(t); param.setTargetAtTime(v, t, tc); };
    const gains = bedGains(st), v = smooth(st.speed / SPEEDS.full);
    for (const [name, k] of Object.entries(gains)) if (node[name]) set(node[name].g.gain, k);
    if (node.wash) node.wash.src.playbackRate.setTargetAtTime(0.85 + 0.3 * v, t, tc);
    // Inside the storm the rain smothers the highs a little.
    lp.frequency.cancelScheduledValues(t);
    lp.frequency.setValueAtTime(Math.max(40, lp.frequency.value), t);
    lp.frequency.exponentialRampToValueAtTime(st.storm > 0.5 ? 5000 : 12000, t + Math.max(0.05, seconds));
    set(level.gain, (st.kraken ? 0.55 : 1) * (st.paused ? db(-6) : 1) * (st.boarding ? db(-4) : 1));
    applyBus(seconds);
  }

  function applyBus(seconds) {
    if (!live) return;
    // The Effects fader (mix.js) rides the bus too; it's re-read every 0.4 s (muteTimer), so a fader move lands within that.
    const target = (muted() ? 0 : ducks > 0 ? db(-4) : 1) * mix.level("effects"), p = live.bus.gain;
    if (Math.abs(live.busTarget - target) < 1e-4) return;
    live.busTarget = target;
    const t = live.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(target, t, Math.max(0.03, seconds / 3));
  }

  /** In the storm, far thunder every 8–20 s (the core's lightning strikes bring the near crack). */
  function scheduleThunder() {
    clearTimeout(thunderTimer);
    thunderTimer = setTimeout(() => {
      if (disposed) return;
      if (live && !muted() && !st.paused && st.storm > 0.3 && Math.random() < st.storm) {
        const a = Math.random() * Math.PI * 2, d = 900 + Math.random() * 900;
        sfx?.play?.("thunder_far", { at: R?.listener ? { x: st.x + Math.sin(a) * d, y: 80, z: st.z + Math.cos(a) * d } : null, pan: Math.sin(a) * 0.7, gain: 0.6 + 0.4 * st.storm });
      }
      scheduleThunder();
    }, (8 + Math.random() * 12) * 1000);
  }

  /** Start, steer or stop a held loop toward gain `k`. */
  function holdLoop(hnd, id, k, seconds, at = null) {
    if (k > 0.01) {
      if (!hnd || !hnd.playing) hnd = sfx?.loop?.(id, { gain: 0, at });
      hnd?.gain(k, seconds);
      if (at) hnd?.at(at);
      return hnd || null;
    }
    if (hnd?.playing) hnd.stop(seconds * 1.5);
    return null;
  }

  /** The buoys: the harbour mouth, every reef and shoal (bells ring near them now and then). */
  function buoysOf(w) {
    const out = [];
    if (!w) return out;
    const port = w.port || { x: 0, z: -40, r: 110 };
    out.push({ x: port.x, z: port.z + (port.r || 110) + 40 });
    for (const r of w.reefs || []) if (Number.isFinite(r.x)) out.push({ x: r.x, z: r.z });
    for (const isl of w.islands || []) for (const s of isl.shoals || []) if (Number.isFinite(s.x)) out.push({ x: s.x, z: s.z });
    return out;
  }

  /** Near land: the harbour or within 400 m of an island's edge. */
  function nearLand() {
    if (st.harbour > 0.05) return true;
    for (const isl of world?.islands || []) if (Math.hypot(isl.x - st.x, isl.z - st.z) - (isl.r || 100) < 400) return true;
    return false;
  }

  /** Gulls by day, a buoy bell near a buoy: rare one-shots, never a bed. */
  function oneShots(run) {
    if (!run || !sfx?.play) return;
    const now = performance.now() / 1000;
    if (st.day > 0.5 && st.storm < 0.4) {
      if (!nextGull) nextGull = now + 6 + Math.random() * 10;
      if (now > nextGull) {
        const land = nearLand();
        nextGull = now + (land ? 9 + Math.random() * 16 : 30 + Math.random() * 40);
        const a = Math.random() * Math.PI * 2, d = land ? 60 + Math.random() * 140 : 160 + Math.random() * 200;
        sfx.play("gull", { at: R?.listener ? { x: st.x + Math.sin(a) * d, y: 30, z: st.z + Math.cos(a) * d } : null, pan: Math.sin(a) * 0.8,
          gain: (land ? 0.42 : 0.26) * st.day, pitch: 0.9 + Math.random() * 0.2 });
      }
    } else nextGull = 0;
    if (now > nextBell) {
      let best = null, bd = 250;
      for (const b of buoys) { const d = Math.hypot(b.x - st.x, b.z - st.z); if (d < bd) { bd = d; best = b; } }
      if (best) {
        nextBell = now + 25 + Math.random() * 30;
        sfx.play("buoy_bell", { at: R?.listener ? { x: best.x, y: 2, z: best.z } : null, pan: 0, gain: 0.2 + 0.25 * (1 - bd / 250) });
      } else nextBell = now + 4;
    }
  }

  function update(s) {
    if (!s) return;
    const ship = s.ship || {};
    const prev = { speed: st.speed, storm: st.storm, harbour: st.harbour, sail: st.sail, boarding: st.boarding, paused: st.paused, day: st.day };
    st.phase = s.phase || st.phase;
    st.speed = Number(ship.speed) || 0;
    st.sail = Number.isFinite(ship.sail) ? ship.sail : st.sail;
    st.day = Number.isFinite(s.daylight) ? s.daylight : st.day;
    if (Number.isFinite(ship.x)) { st.x = ship.x; st.z = ship.z; }
    st.paused = !!s.paused;
    st.boarding = s.phase === "boarding";
    st.fires = Number(ship.fires) || 0;
    st.kraken = !!(s.hazards?.kraken && s.hazards.kraken.stage !== "retreat");
    // The storm: 1 inside, fading over 150 m outside its edge.
    const sc = s.storm;
    if (sc && Number.isFinite(sc.x)) {
      const d = Math.hypot(sc.x - st.x, sc.z - st.z) - (sc.r || 450);
      st.storm = sc.inside ? 1 : Math.max(0, Math.min(1, 1 - d / 150));
    } else st.storm = 0;
    // v4 sea events: a squall over us is weather too (its gusts on the gale bed, its rain on the rain loop);
    // full inside its radius, fading over 120 m outside. A squall still telegraphing stays quiet.
    for (const ev of Array.isArray(s.events) ? s.events : []) {
      if (!ev || !/squall|gust/i.test(String(ev.kind || "")) || !/start|active|on|live/i.test(String(ev.stage || ev.state || "active"))) continue;
      if (!Number.isFinite(ev.x) || !Number.isFinite(ev.z)) { st.storm = Math.max(st.storm, 0.8); continue; }
      const d = Math.hypot(ev.x - st.x, ev.z - st.z) - (Number(ev.r) || 300);
      st.storm = Math.max(st.storm, Math.max(0, Math.min(1, 1 - d / 120)) * 0.85);
    }
    // The harbour: loud at the pier, gone 400 m out.
    const port = world?.port || { x: 0, z: -40 };
    st.harbour = s.phase === "title" ? 1 : Math.max(0, Math.min(1, 1 - (Math.hypot(port.x - st.x, port.z - st.z) - 70) / 330));
    // Creaks: the rudder swung hard, or heeling through a turn at speed, or heavy weather. At most one every 2.5 s.
    const rud = Number(ship.rudder ?? (Number(ship.wheel) || 0) * 30) || 0;
    const now = performance.now();
    if (now - lastCreak > 2500 && ((Math.abs(rud - lastRudder) > 14 && st.speed > 2) || (Math.abs(rud) > 22 && st.speed > 5 && Math.random() < 0.05) || (st.storm > 0.5 && Math.random() < 0.015))) {
      lastCreak = now;
      sfx?.play?.("creak", { pan: Math.random() * 1.2 - 0.6, gain: 0.38 + 0.3 * Math.min(1, Math.abs(rud) / 30) });
    }
    lastRudder = rud;
    const changed = Math.abs(prev.speed - st.speed) > 0.2 || Math.abs(prev.storm - st.storm) > 0.03 || Math.abs(prev.harbour - st.harbour) > 0.03
      || prev.sail !== st.sail || prev.boarding !== st.boarding || prev.paused !== st.paused || Math.abs(prev.day - st.day) > 0.05;
    if (changed) apply(1);
    if (!live) return;
    const run = ["briefing", "moored", "sailing", "boarding", "ending"].includes(s.phase) && !st.paused;
    if (!muted()) oneShots(run);
    rain = holdLoop(rain, "rain", run ? st.storm : 0, 1.5);
    fire = holdLoop(fire, "fire", run && st.fires > 0 ? Math.min(1, 0.45 + 0.2 * st.fires) : 0, 0.8);
    // The maelstrom: positional when there's a listener, else louder the closer.
    const m = s.hazards?.maelstrom || world?.maelstrom;
    if (m && Number.isFinite(m.x)) {
      const d = Math.hypot(m.x - st.x, m.z - st.z), reach = (m.r || 220) + 400;
      const k = run && d < reach ? Math.max(0, Math.min(1, 1 - (d - (m.eye || 35)) / reach)) : 0;
      mael = holdLoop(mael, "maelstrom", R?.listener ? (k > 0 ? 0.5 + 0.5 * k : 0) : k, 1.5, R?.listener ? { x: m.x, y: 0, z: m.z } : null);
    }
    // The nearest waterspout within 300 m (v4 sea-event spouts are mirrored into hazards.spouts by the core).
    let best = null, bd = 300;
    for (const sp of s.hazards?.spouts || []) { const d = Math.hypot(sp.x - st.x, sp.z - st.z); if (d < bd) { bd = d; best = sp; } }
    if (best && spoutId !== best.id) { spout?.stop(0.6); spout = null; spoutId = best.id; }
    spout = holdLoop(spout, "spout", run && best ? (R?.listener ? 0.8 : 1 - bd / 300) : 0, 1, best && R?.listener ? { x: best.x, y: 5, z: best.z } : null);
    if (!best) spoutId = null;
  }

  function setWorld(w) {
    world = w || null;
    buoys = buoysOf(world);
    mael?.stop(0.5); mael = null;
  }

  return {
    ready,
    start() { wantStart = true; begin(); },
    update,
    setWorld,
    creak(strength = 1) { sfx?.play?.("creak", { gain: 0.38 + 0.3 * Math.min(1, strength) }); },
    duck(audio = null) {
      ducks++;
      applyBus(0.25);
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        ducks = Math.max(0, ducks - 1);
        applyBus(0.6);
        if (audio) for (const ev of ["ended", "pause", "error"]) audio.removeEventListener(ev, release);
      };
      const cap = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration + 0.5 : audio ? 15 : 4;
      if (audio) for (const ev of ["ended", "pause", "error"]) audio.addEventListener(ev, release);
      setTimeout(release, cap * 1000);
    },
    wire(bus) {
      if (!bus?.on) return () => {};
      const offs = [
        bus.on("tick", (s) => update(s)),
        bus.on("phase", (p = {}) => { if (p.world) setWorld(p.world); }),
        bus.on("intent", ({ name } = {}) => {
          if (name === "pause") { st.paused = true; apply(0.6); }
          else if (name === "resume") { st.paused = false; apply(0.6); }
        }),
      ];
      return () => offs.forEach((off) => { try { off?.(); } catch { /* gone */ } });
    },
    state: () => ({ ...st, running: !!live, gains: bedGains(st) }),
    dispose() {
      disposed = true;
      clearTimeout(thunderTimer); clearInterval(muteTimer);
      for (const l of [rain, fire, mael, spout]) l?.stop(0.2);
      rain = fire = mael = spout = null;
      if (live) {
        for (const { src } of Object.values(live.node)) { try { src.stop(); } catch { /* already */ } }
        try { live.bus.disconnect(); } catch { /* gone */ }
        live = null;
      }
    },
  };
}
