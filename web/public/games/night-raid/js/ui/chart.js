// The bay chart: a parchment-and-ink map of the whole bay in the HUD's
// top-right corner (under the kit's cog), north up. Islands and the fort's
// towers, the home port, the wrecks, the maelstrom's spiral, the storm cell,
// fog banks, the cove and the way out; the reefs THE CAPTAIN can see (the
// state's `hazards.reefs`: all of them by day, only the close ones in the
// dark — the companion's chart knows the rest, and their mark_danger areas
// come up here in red); floating collectables; patrol lanterns' sweeps; the
// Rexmaw's arrow and wake; every detected contact (red hostile, gold prize,
// a star ring on a mission target); the current objective in gilt (v3: its
// area ring, a pennant and a dotted line from the Rexmaw); a called heading
// and an accepted course; v4: the random sea events (a spout's spiral, a
// squall's rain and reach, rogue waves, a derelict, treasure afloat, a Kraken
// arm, a fog bank), dashed while they're only telegraphed, and the locked
// target's ring. Click it to open it large; click again (or Esc) to fold it
// back.
//
//   const chart = createChart(ctx, parent);
//   chart.setWorld(world);        // core world (run.world()); also from `phase {world}`
//   chart.update(state);          // a tick snapshot
//   drawBay(ctx2d, data, opts)    // the same drawing, for the results card
//
// Frame (core): metres, +Z north, heading 0 = +Z, growing toward −X (east).
// On paper east is to the RIGHT, so the paper x is −world x.

import { h, flag, clamp, num, CLASSES, DANGERS, SEA_EVENTS, seaKind, seaStage, lockOf, POWERUPS } from "./dom.js";

const INK = "#2b1c0c";
const INK_SOFT = "rgba(43, 28, 12, .55)";
const SEA = "#d9c49a";
const LAND = "#b48e55";
const HOSTILE = "#a8201c";
const PRIZE = "#b87a0e";
const FRIEND = "#1d4f7a";
const DANGER = "rgba(200, 24, 18, ";
const DEFAULT_BOUNDS = { minX: -900, maxX: 900, minZ: -80, maxZ: 1720 };

/** Paper transform for a world rectangle into a w × h canvas (with a margin). */
export function paperOf(world, w, hh, pad = 8) {
  const b = world?.bounds || DEFAULT_BOUNDS;
  const spanX = b.maxX - b.minX, spanZ = b.maxZ - b.minZ;
  const k = Math.min((w - pad * 2) / spanX, (hh - pad * 2) / spanZ);
  const ox = (w - spanX * k) / 2, oz = (hh - spanZ * k) / 2;
  return {
    k,
    x: (wx) => ox + (b.maxX - wx) * k,         // east (−X) to the right
    y: (wz) => hh - oz - (wz - b.minZ) * k,     // north up
  };
}

/** A reef as the core gives it: a capsule a–b of half-width w, or rocks (a circle). */
function drawReef(g, P, r, px, { faint = false } = {}) {
  g.save();
  g.strokeStyle = faint ? "rgba(90, 50, 20, .35)" : "rgba(90, 50, 20, .85)";
  g.fillStyle = faint ? "rgba(120, 70, 30, .12)" : "rgba(120, 70, 30, .3)";
  g.setLineDash([px(1.6), px(2)]); g.lineWidth = px(1);
  if (r.a && r.b && r.kind !== "rocks") {
    const w = Math.max(px(1.6), (r.w || 10) * P.k);
    g.lineCap = "round"; g.lineWidth = w * 2;
    g.strokeStyle = g.fillStyle;
    g.setLineDash([]);
    g.beginPath(); g.moveTo(P.x(r.a.x), P.y(r.a.z)); g.lineTo(P.x(r.b.x), P.y(r.b.z)); g.stroke();
    g.lineWidth = px(0.9); g.strokeStyle = faint ? "rgba(90, 50, 20, .35)" : "rgba(90, 50, 20, .8)";
    // Little crosses along the band: the old chart sign for rocks awash.
    const n = Math.max(2, Math.round(Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z) / 30));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = P.x(r.a.x + (r.b.x - r.a.x) * t), y = P.y(r.a.z + (r.b.z - r.a.z) * t), s = px(1.8);
      g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke();
    }
  } else {
    g.beginPath(); g.arc(P.x(r.x), P.y(r.z), Math.max(px(2), (r.r || 12) * P.k), 0, Math.PI * 2); g.fill(); g.stroke();
  }
  g.restore();
}

/** A v4 sea event on the chart: its reach (squall, fog) and a small ink icon in its colour. */
function drawSeaEvent(g, P, px, ev, { warn = false, big = false } = {}) {
  const kind = seaKind(ev.kind), col = SEA_EVENTS[kind]?.color || "#9fb4ff";
  const x = P.x(ev.x), y = P.y(ev.z), s = px(big ? 6 : 4.2);
  g.save();
  g.globalAlpha = warn ? 0.6 : 1;
  if ((kind === "squall" || kind === "fog") && num(ev.r) > 0) {
    const r = ev.r * P.k;
    g.fillStyle = kind === "fog" ? "rgba(120, 132, 150, .22)" : "rgba(40, 60, 110, .18)";
    g.strokeStyle = kind === "fog" ? "rgba(90, 100, 120, .6)" : "rgba(40, 60, 110, .7)";
    g.lineWidth = px(1.1); g.setLineDash(warn ? [px(3), px(3)] : []);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([]);
  }
  // A dark rim under the colour so it reads on the paper.
  g.lineWidth = px(1.6); g.strokeStyle = INK; g.fillStyle = col; g.lineCap = "round";
  const stroke2 = (draw) => { g.strokeStyle = INK; g.lineWidth = px(2.6); g.beginPath(); draw(); g.stroke(); g.strokeStyle = col; g.lineWidth = px(1.3); g.beginPath(); draw(); g.stroke(); };
  if (kind === "spout") stroke2(() => { for (let a = 0; a < Math.PI * 4; a += 0.3) { const r = s * (1 - a / (Math.PI * 4)); const fx = x + Math.cos(a) * r, fy = y + Math.sin(a) * r; if (a === 0) g.moveTo(fx, fy); else g.lineTo(fx, fy); } });
  else if (kind === "squall") stroke2(() => { for (let i = -1; i <= 1; i++) { g.moveTo(x + i * s * 0.7, y - s); g.lineTo(x + i * s * 0.7 - s * 0.4, y + s); } });
  else if (kind === "waves") stroke2(() => { for (let i = -1; i <= 1; i++) { g.moveTo(x - s, y + i * s * 0.6); g.quadraticCurveTo(x, y + i * s * 0.6 - s * 0.6, x + s, y + i * s * 0.6); } });
  else if (kind === "derelict") stroke2(() => { g.moveTo(x - s, y + s * 0.4); g.lineTo(x + s, y + s * 0.4); g.moveTo(x - s * 0.2, y + s * 0.4); g.lineTo(x + s * 0.4, y - s); });
  else if (kind === "treasure") {
    for (const [dx, dy] of [[0, 0], [s * 0.9, s * 0.5], [-s * 0.8, s * 0.6]]) {
      const q = s * 0.55;
      g.beginPath(); g.moveTo(x + dx, y + dy - q); g.lineTo(x + dx + q, y + dy); g.lineTo(x + dx, y + dy + q); g.lineTo(x + dx - q, y + dy); g.closePath();
      g.lineWidth = px(0.8); g.strokeStyle = INK; g.fill(); g.stroke();
    }
  } else if (kind === "kraken_arm") stroke2(() => { g.moveTo(x - s * 0.3, y + s); g.bezierCurveTo(x + s, y + s * 0.3, x - s, y - s * 0.3, x + s * 0.3, y - s); });
  else if (kind === "fog") stroke2(() => { for (let i = -1; i <= 1; i++) { g.moveTo(x - s, y + i * s * 0.55); g.lineTo(x + s, y + i * s * 0.55); } });
  // v4 whacky ones: a fin, a whale, leaping dolphins, a winged fish, a jelly's bell, a turtle, a gull in a hat.
  else if (kind === "gerald") {
    if (ev.land && Number.isFinite(ev.land.x)) {      // where he'll land: a red cross
      const lx = P.x(ev.land.x), ly = P.y(ev.land.z), q = px(3.2);
      g.strokeStyle = "#c0392b"; g.lineWidth = px(1.6); g.beginPath(); g.moveTo(lx - q, ly - q); g.lineTo(lx + q, ly + q); g.moveTo(lx + q, ly - q); g.lineTo(lx - q, ly + q); g.stroke();
    }
    g.beginPath(); g.moveTo(x - s, y + s * 0.6); g.quadraticCurveTo(x + s * 0.1, y - s * 0.2, x + s * 0.2, y - s); g.lineTo(x + s, y + s * 0.6); g.closePath();
    g.lineWidth = px(1); g.strokeStyle = INK; g.fill(); g.stroke();
  } else if (kind === "sky_whale") {
    if (ev.ring && num(ev.ring.r) > 0 && ev.flop) {
      g.strokeStyle = "rgba(29, 79, 122, .75)"; g.lineWidth = px(1.4);
      g.beginPath(); g.arc(P.x(ev.flop.x), P.y(ev.flop.z), num(ev.ring.r) * P.k, 0, Math.PI * 2); g.stroke();
    } else if (ev.flop && Number.isFinite(ev.flop.x)) {
      g.setLineDash([px(2), px(2)]); g.strokeStyle = "rgba(29, 79, 122, .75)"; g.lineWidth = px(1.2);
      g.beginPath(); g.arc(P.x(ev.flop.x), P.y(ev.flop.z), px(5), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    stroke2(() => { g.moveTo(x - s, y); g.quadraticCurveTo(x, y - s * 1.1, x + s * 0.9, y - s * 0.1); g.moveTo(x - s, y); g.lineTo(x - s * 1.4, y - s * 0.5); g.moveTo(x - s, y); g.lineTo(x - s * 1.4, y + s * 0.4); });
  } else if (kind === "dolphins") stroke2(() => { for (const dx of [-0.6, 0.6]) { g.moveTo(x + (dx - 0.5) * s, y + s * 0.4); g.quadraticCurveTo(x + dx * s, y - s * 0.8, x + (dx + 0.5) * s, y + s * 0.4); } });
  else if (kind === "flying_fish") stroke2(() => { g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y); g.lineTo(x - s * 0.4, y - s * 0.8); g.moveTo(x, y); g.lineTo(x - s * 0.4, y + s * 0.8); });
  else if (kind === "jellyfish") {
    g.beginPath(); g.arc(x, y, s * 0.75, Math.PI, 0); g.closePath(); g.lineWidth = px(1); g.strokeStyle = INK; g.fill(); g.stroke();
    stroke2(() => { for (const dx of [-0.45, 0, 0.45]) { g.moveTo(x + dx * s, y); g.quadraticCurveTo(x + dx * s + s * 0.25, y + s * 0.5, x + dx * s, y + s); } });
  } else if (kind === "turtle") {
    g.beginPath(); g.ellipse(x, y, s * 0.85, s * 0.65, 0, 0, Math.PI * 2); g.lineWidth = px(1); g.strokeStyle = INK; g.fill(); g.stroke();
    g.beginPath(); g.arc(x + s * 1.05, y, s * 0.28, 0, Math.PI * 2); g.fill(); g.stroke();
  } else if (kind === "admiral") {
    stroke2(() => { g.moveTo(x - s, y - s * 0.1); g.quadraticCurveTo(x - s * 0.5, y - s * 0.7, x, y); g.quadraticCurveTo(x + s * 0.5, y - s * 0.7, x + s, y - s * 0.1); });
    g.fillStyle = INK; g.beginPath(); g.moveTo(x - s * 0.35, y - s * 0.35); g.lineTo(x + s * 0.35, y - s * 0.35); g.lineTo(x, y - s * 0.75); g.closePath(); g.fill();
  }
  else { g.beginPath(); g.arc(x, y, s * 0.6, 0, Math.PI * 2); g.fill(); g.stroke(); }
  if (big) { g.globalAlpha = 1; g.fillStyle = INK; g.font = `italic ${px(9.5)}px Georgia, serif`; g.textAlign = "center"; g.fillText(ev.label || SEA_EVENTS[kind]?.label || kind, x, y + s + px(10)); }
  g.restore();
}

/**
 * Draw the bay onto a 2D context.
 * @param {CanvasRenderingContext2D} g
 * @param {{world: object|null, state?: object|null, wake?: Array<{x:number,z:number}>, track?: Array<{x:number,z:number}>}} data
 * @param {{width: number, height: number, scale?: number, big?: boolean, reveal?: number, allReefs?: boolean}} opts
 */
export function drawBay(g, data, { width, height, scale = 1, big = false, reveal = 1, allReefs = false } = {}) {
  const { world, state } = data;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, width, height);
  // Paper (a touch darker at night).
  const night = state ? num(state.daylight, 1) < 0.5 : world?.time === "night";
  const grad = g.createRadialGradient(width / 2, height / 2, width * 0.1, width / 2, height / 2, width * 0.75);
  grad.addColorStop(0, night ? "#dccba0" : "#ecdcb4"); grad.addColorStop(1, night ? "#bfa877" : SEA);
  g.fillStyle = grad;
  g.fillRect(0, 0, width, height);
  if (!world) { g.restore(); return; }
  const P = paperOf(world, width, height, 8 * scale);
  const px = (v) => v * scale;
  const b = world.bounds || DEFAULT_BOUNDS;
  // Grid: a faint 200 m square.
  g.strokeStyle = "rgba(43, 28, 12, .08)"; g.lineWidth = px(1);
  for (let x = Math.ceil(b.minX / 200) * 200; x <= b.maxX; x += 200) { g.beginPath(); g.moveTo(P.x(x), P.y(b.minZ)); g.lineTo(P.x(x), P.y(b.maxZ)); g.stroke(); }
  for (let z = Math.ceil(b.minZ / 200) * 200; z <= b.maxZ; z += 200) { g.beginPath(); g.moveTo(P.x(b.minX), P.y(z)); g.lineTo(P.x(b.maxX), P.y(z)); g.stroke(); }

  // Fog banks.
  for (const f of state?.fog?.banks || world.fog || []) {
    if (!Number.isFinite(f.x) || !f.r) continue;
    const r = f.r * P.k, fg = g.createRadialGradient(P.x(f.x), P.y(f.z), r * 0.15, P.x(f.x), P.y(f.z), r);
    fg.addColorStop(0, `rgba(120, 132, 150, ${0.32 * clamp(num(f.density, 0.7), 0, 1)})`); fg.addColorStop(1, "rgba(120, 132, 150, 0)");
    g.fillStyle = fg; g.beginPath(); g.arc(P.x(f.x), P.y(f.z), r, 0, Math.PI * 2); g.fill();
  }
  // The storm cell (live position in the state).
  const storm = state?.storm && Number.isFinite(state.storm.x) ? state.storm : world.storm;
  if (storm && Number.isFinite(storm.x) && storm.r) {
    const r = storm.r * P.k;
    const sg = g.createRadialGradient(P.x(storm.x), P.y(storm.z), r * 0.2, P.x(storm.x), P.y(storm.z), r);
    sg.addColorStop(0, "rgba(40, 52, 80, .38)"); sg.addColorStop(1, "rgba(40, 52, 80, 0)");
    g.fillStyle = sg; g.beginPath(); g.arc(P.x(storm.x), P.y(storm.z), r, 0, Math.PI * 2); g.fill();
    if (big) { g.fillStyle = "rgba(30, 40, 66, .7)"; g.font = `italic ${px(11)}px Georgia, serif`; g.textAlign = "center"; g.fillText("storm", P.x(storm.x), P.y(storm.z)); }
  }

  // The maelstrom: a spiral and its eye.
  const m = world.maelstrom;
  if (m && Number.isFinite(m.x)) {
    const cx = P.x(m.x), cy = P.y(m.z), R = (m.r || 220) * P.k;
    g.strokeStyle = "rgba(20, 70, 90, .55)"; g.lineWidth = px(1.1);
    g.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.12) {
      const rr = R * (1 - a / (Math.PI * 6));
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = "rgba(10, 30, 40, .7)"; g.beginPath(); g.arc(cx, cy, Math.max(px(2), (m.eye || 35) * P.k), 0, Math.PI * 2); g.fill();
  }

  // Islands and their names.
  for (const isl of world.islands || []) {
    const poly = Array.isArray(isl.poly) && isl.poly.length > 2 ? isl.poly : null;
    g.fillStyle = LAND; g.strokeStyle = INK; g.lineWidth = px(1.2);
    g.beginPath();
    if (poly) poly.forEach((p, i) => (i ? g.lineTo(P.x(p.x), P.y(p.z)) : g.moveTo(P.x(p.x), P.y(p.z))));
    else g.arc(P.x(isl.x), P.y(isl.z), (isl.r || 100) * P.k, 0, Math.PI * 2);
    g.closePath(); g.fill(); g.stroke();
    if (big && isl.name) { g.fillStyle = INK_SOFT; g.font = `italic ${px(10)}px Georgia, serif`; g.textAlign = "center"; g.fillText(isl.name, P.x(isl.x), P.y(isl.z) + (isl.r || 100) * P.k + px(11)); }
  }
  // Revealed shoals, dotted.
  for (const s of state?.hazards?.shoals || []) {
    g.setLineDash([px(1.5), px(2.5)]); g.strokeStyle = "rgba(120, 70, 20, .8)"; g.lineWidth = px(1);
    g.beginPath(); g.arc(P.x(s.x), P.y(s.z), Math.max(px(2), (s.r || 30) * P.k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  }
  // Reefs: only what the Captain's chart may show (the state's list). The results card can show them all.
  const seen = new Set();
  for (const r of state?.hazards?.reefs || []) { seen.add(r.id); drawReef(g, P, r, px); }
  if (allReefs) for (const r of world.reefs || []) if (!seen.has(r.id)) drawReef(g, P, r, px, { faint: !!state });

  // The fort's towers (live: down ones greyed).
  const towers = state?.fort?.towers || world.fort?.towers || [];
  for (const t of towers) {
    if (!Number.isFinite(t.x)) continue;
    const s = px(big ? 4.5 : 3.2);
    g.fillStyle = t.down ? "rgba(70, 60, 50, .55)" : HOSTILE; g.strokeStyle = INK; g.lineWidth = px(0.8);
    g.fillRect(P.x(t.x) - s, P.y(t.z) - s, s * 2, s * 2); g.strokeRect(P.x(t.x) - s, P.y(t.z) - s, s * 2, s * 2);
    if (big && !t.down && t.range) { g.setLineDash([px(3), px(3)]); g.strokeStyle = "rgba(168, 32, 28, .3)"; g.beginPath(); g.arc(P.x(t.x), P.y(t.z), t.range * P.k, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
  }

  // The cove, the way out, the wrecks.
  if (world.cove && Number.isFinite(world.cove.x)) {
    g.strokeStyle = FRIEND; g.lineWidth = px(1.4); g.setLineDash([px(2), px(2)]);
    g.beginPath(); g.arc(P.x(world.cove.x), P.y(world.cove.z), Math.max(px(4), (world.cove.r || 60) * P.k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    if (big) { g.fillStyle = FRIEND; g.font = `italic ${px(10)}px Georgia, serif`; g.textAlign = "center"; g.fillText("cove", P.x(world.cove.x), P.y(world.cove.z) - px(8)); }
  }
  if (world.exit && Number.isFinite(world.exit.x)) {
    g.strokeStyle = "rgba(29, 79, 122, .7)"; g.lineWidth = px(1.2);
    g.beginPath(); g.arc(P.x(world.exit.x), P.y(world.exit.z), Math.max(px(4), (world.exit.r || 90) * P.k), 0, Math.PI * 2); g.stroke();
  }
  const wrecks = state?.wrecks || world.wrecks || [];
  for (const w of wrecks) {
    const x = P.x(w.x), y = P.y(w.z), s = px(big ? 4 : 3);
    g.strokeStyle = w.salvaged ? "rgba(90, 70, 40, .5)" : PRIZE; g.lineWidth = px(1.4);
    g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke();
  }

  // Home port: the harbour ring and a little pier.
  const port = world.port || { x: 0, z: -40, r: 110 };
  g.setLineDash([px(3), px(2)]); g.strokeStyle = FRIEND; g.lineWidth = px(1.3);
  g.beginPath(); g.arc(P.x(port.x), P.y(port.z), Math.max(px(5), port.r * P.k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  g.fillStyle = FRIEND; g.fillRect(P.x(port.x) - px(1.5), P.y(port.z) - px(1), px(3), px(7));

  // Danger areas the companion marked (red; they fade as they expire).
  for (const d of state?.dangers || []) {
    if (!Number.isFinite(d.x)) continue;
    const life = clamp(num(d.expiresIn, 60) / 60, 0.25, 1), r = Math.max(px(5), (d.r || 60) * P.k);
    g.fillStyle = `${DANGER}${0.22 * life})`; g.strokeStyle = `${DANGER}${0.85 * life})`; g.lineWidth = px(1.4);
    g.setLineDash([px(4), px(2.5)]);
    g.beginPath(); g.arc(P.x(d.x), P.y(d.z), r, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([]);
    g.fillStyle = `${DANGER}${life})`; g.font = `700 ${px(big ? 10 : 8)}px system-ui, sans-serif`; g.textAlign = "center";
    g.fillText(big ? (d.label || DANGERS[d.kind] || "Danger") : "!", P.x(d.x), P.y(d.z) + px(3));
  }

  // Collectables afloat.
  for (const p of state?.pickups || []) {
    if (!Number.isFinite(p.x)) continue;
    const s = px(p.kind === "chest" || p.kind === "ring" ? 2.6 : 1.8);
    g.fillStyle = p.kind === "chest" || p.kind === "ring" ? "#d89a12" : p.kind === "barrel" ? "#2f7a4a" : "#8a6220";
    g.strokeStyle = INK; g.lineWidth = px(0.6);
    g.beginPath(); g.moveTo(P.x(p.x), P.y(p.z) - s); g.lineTo(P.x(p.x) + s, P.y(p.z)); g.lineTo(P.x(p.x), P.y(p.z) + s); g.lineTo(P.x(p.x) - s, P.y(p.z)); g.closePath(); g.fill(); g.stroke();
  }

  // v4.2 power-ups afloat: a glowing dot in the kind's colour with a four-point sparkle (labelled on the big chart).
  for (const p of Array.isArray(state?.powerups) ? state.powerups : []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const info = POWERUPS[p.kind] || { color: "#ffffff", label: p.label || "Power-up" };
    const x = P.x(p.x), y = P.y(p.z), s = px(big ? 4.2 : 3);
    g.save();
    g.globalAlpha = num(p.left, 60) < 8 ? 0.55 : 1;
    g.fillStyle = info.color; g.shadowColor = info.color; g.shadowBlur = px(5);
    g.beginPath(); g.arc(x, y, s * 0.62, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0; g.strokeStyle = INK; g.lineWidth = px(0.7); g.stroke();
    g.strokeStyle = info.color; g.lineWidth = px(1); g.beginPath();
    g.moveTo(x - s * 1.25, y); g.lineTo(x - s * 0.75, y); g.moveTo(x + s * 0.75, y); g.lineTo(x + s * 1.25, y);
    g.moveTo(x, y - s * 1.25); g.lineTo(x, y - s * 0.75); g.moveTo(x, y + s * 0.75); g.lineTo(x, y + s * 1.25); g.stroke();
    if (big) { g.fillStyle = INK; g.font = `italic ${px(9)}px Georgia, serif`; g.textAlign = "center"; g.fillText(info.label, x, y + s + px(9)); }
    g.restore();
  }

  // v4 random sea events: an icon each (dashed and fainter while only telegraphed), the squall's and the fog's reach.
  for (const ev of Array.isArray(state?.events) ? state.events : []) {
    if (!ev || !Number.isFinite(ev.x) || !Number.isFinite(ev.z)) continue;
    const stage = seaStage(ev);
    if (stage === "end") continue;
    drawSeaEvent(g, P, px, ev, { warn: stage === "warn", big });
  }

  // A course and a called heading.
  if (state?.course && Number.isFinite(state.course.x) && state.ship) {
    g.setLineDash([px(4), px(3)]); g.strokeStyle = "rgba(29, 79, 122, .85)"; g.lineWidth = px(1.4);
    g.beginPath(); g.moveTo(P.x(state.ship.x), P.y(state.ship.z)); g.lineTo(P.x(state.course.x), P.y(state.course.z)); g.stroke(); g.setLineDash([]);
    g.fillStyle = FRIEND; g.beginPath(); g.arc(P.x(state.course.x), P.y(state.course.z), px(2.6), 0, Math.PI * 2); g.fill();
  }
  // The current objective (v3): a gilt ring round its area (or the ship) and a flag, a dotted line from us.
  const mk = state?.objective?.marker;
  if (mk && state.ship) {
    let mx = mk.x, mz = mk.z;
    if (mk.kind === "ship" && mk.contactId && mk.seen !== false) {
      const c = (state.contacts || []).find((x) => x.id === mk.contactId);
      if (c && Number.isFinite(c.x)) { mx = c.x; mz = c.z; }
    }
    if (Number.isFinite(mx) && Number.isFinite(mz)) {
      const x = P.x(mx), y = P.y(mz), r = Math.max(px(big ? 7 : 5), (mk.r || (mk.kind === "ship" ? 0 : 40)) * P.k);
      g.setLineDash([px(2), px(2.5)]); g.strokeStyle = "rgba(184, 122, 14, .7)"; g.lineWidth = px(1.1);
      g.beginPath(); g.moveTo(P.x(state.ship.x), P.y(state.ship.z)); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = "rgba(255, 207, 107, .22)"; g.strokeStyle = "#b8862f"; g.lineWidth = px(1.8);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      // A little pennant on a pole.
      const fh = px(big ? 12 : 9);
      g.strokeStyle = "#5a3a10"; g.lineWidth = px(1.2);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - fh); g.stroke();
      g.fillStyle = "#e0a43c"; g.beginPath(); g.moveTo(x, y - fh); g.lineTo(x + fh * 0.7, y - fh * 0.78); g.lineTo(x, y - fh * 0.56); g.closePath(); g.fill();
      if (big && mk.label) { g.fillStyle = INK; g.font = `italic 700 ${px(10)}px Georgia, serif`; g.textAlign = "left"; g.fillText(mk.label, x + fh * 0.8, y - fh * 0.5); }
    }
  }
  const call = state?.headingCall;
  if (call && Number.isFinite(call.deg) && state.ship && num(call.expiresIn, 1) > 0) {
    const a = call.deg * Math.PI / 180, L = 260;
    const ex = state.ship.x - Math.sin(a) * L, ez = state.ship.z + Math.cos(a) * L;
    g.setLineDash([px(2), px(3)]); g.strokeStyle = "rgba(184, 122, 14, .95)"; g.lineWidth = px(1.6);
    g.beginPath(); g.moveTo(P.x(state.ship.x), P.y(state.ship.z)); g.lineTo(P.x(ex), P.y(ez)); g.stroke(); g.setLineDash([]);
  }

  // Our wake (results: the track, revealed over time).
  const track = data.track || data.wake;
  if (Array.isArray(track) && track.length > 1) {
    const n = Math.max(2, Math.round(track.length * clamp(reveal, 0, 1)));
    g.strokeStyle = "rgba(29, 79, 122, .65)"; g.lineWidth = px(big ? 1.6 : 1.1); g.lineJoin = "round";
    g.beginPath();
    for (let i = 0; i < n; i++) { const p = track[i]; if (i) g.lineTo(P.x(p.x), P.y(p.z)); else g.moveTo(P.x(p.x), P.y(p.z)); }
    g.stroke();
  }

  // Contacts (and patrol lanterns' sweeps at night).
  const marked = lockOf(state);
  for (const c of state?.contacts || []) {
    if (c.detected === false || !Number.isFinite(c.x) || c.cls === "tower") continue;
    const x = P.x(c.x), y = P.y(c.z), s = px(big ? 5 : 3.6);
    if (c.lantern && Number.isFinite(c.lantern.yaw) && night) {
      const yaw = c.lantern.yaw * Math.PI / 180, half = (c.lantern.half || 15) * Math.PI / 180, r = (c.lantern.range || 240) * P.k;
      // Heading grows toward −X (paper right): on paper the angle is the canvas's clockwise from up.
      g.fillStyle = c.spotted ? "rgba(255, 140, 40, .32)" : "rgba(255, 200, 80, .22)";
      g.beginPath(); g.moveTo(x, y); g.arc(x, y, r, yaw - Math.PI / 2 - half, yaw - Math.PI / 2 + half); g.closePath(); g.fill();
    }
    const color = c.state === "surrender" ? "#f4efe2" : c.cls === "merchant" && !c.hostile ? PRIZE : c.hostile === false ? FRIEND : HOSTILE;
    g.save(); g.translate(x, y); g.rotate((Number(c.heading) || 0) * Math.PI / 180);
    g.fillStyle = color; g.strokeStyle = INK; g.lineWidth = px(0.8);
    g.beginPath(); g.moveTo(0, -s * 1.5); g.lineTo(s * 0.8, s); g.lineTo(-s * 0.8, s); g.closePath(); g.fill(); g.stroke();
    g.restore();
    if (c.objective || c.chest) { g.strokeStyle = "#d89a12"; g.lineWidth = px(1.2); g.setLineDash([px(2), px(1.5)]); g.beginPath(); g.arc(x, y, s * 2.2, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
    if (c.id === marked) { g.strokeStyle = PRIZE; g.lineWidth = px(1.4); g.beginPath(); g.arc(x, y, s * 2.8, 0, Math.PI * 2); g.stroke(); }
    if (big) {
      g.fillStyle = INK; g.font = `${px(9.5)}px system-ui, sans-serif`; g.textAlign = "left";
      g.fillText(c.known ? (c.name || CLASSES[c.cls]?.name || c.cls) : (CLASSES[c.cls]?.name || "Sail"), x + s * 1.8, y + px(3));
    }
  }

  // The Rexmaw: a gilt arrow with a dark rim.
  const ship = state?.ship;
  if (ship && Number.isFinite(ship.x)) {
    const s = px(big ? 7 : 5);
    g.save(); g.translate(P.x(ship.x), P.y(ship.z)); g.rotate((Number(ship.heading) || 0) * Math.PI / 180);
    g.fillStyle = "#ffcf6b"; g.strokeStyle = "#1a1206"; g.lineWidth = px(1.3);
    g.beginPath(); g.moveTo(0, -s * 1.6); g.lineTo(s * 0.85, s); g.lineTo(0, s * 0.5); g.lineTo(-s * 0.85, s); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  // North arrow and a scale bar on the big chart.
  g.fillStyle = INK; g.font = `italic 700 ${px(big ? 12 : 9)}px Georgia, serif`; g.textAlign = "center";
  g.fillText("N", width - px(big ? 16 : 10), px(big ? 18 : 12));
  g.beginPath(); g.moveTo(width - px(big ? 16 : 10), px(big ? 22 : 15)); g.lineTo(width - px(big ? 16 : 10), px(big ? 36 : 24)); g.strokeStyle = INK; g.lineWidth = px(1); g.stroke();
  if (big) {
    const L = 200 * P.k, x1 = width - px(14);   // bottom right: the legend lives bottom left
    g.beginPath(); g.moveTo(x1 - L, height - px(12)); g.lineTo(x1, height - px(12)); g.stroke();
    g.font = `${px(9)}px system-ui, sans-serif`; g.textAlign = "right"; g.fillText("200 m", x1, height - px(16));
  }
  g.restore();
}

/**
 * The HUD's chart.
 * @param {object} ctx  the UI context
 * @param {HTMLElement} parent
 */
export function createChart(ctx, parent) {
  const canvas = h("canvas.nr-chartcv", { "aria-hidden": "true" });
  const legend = h("div.nr-chartlegend", { hidden: true },
    h("span", null, h("i.l-goal"), "Objective"), h("span", null, h("i.l-ship"), "Rexmaw"), h("span", null, h("i.l-foe"), "Hostile"), h("span", null, h("i.l-prize"), "Prize"),
    h("span", null, h("i.l-danger"), "Danger (marked)"), h("span", null, h("i.l-reef"), "Reef"), h("span", null, h("i.l-loot"), "Floating loot"),
    h("span", null, h("i.l-port"), "Home port"), h("span", null, h("i.l-fort"), "Gun tower"), h("span", null, h("i.l-event"), "Sea event"));
  const el = h("button.nr-chart", { type: "button", title: "The bay chart (click to open it large)", "aria-label": "Bay chart" }, canvas, legend);
  parent.append(el);
  let world = null, last = null, big = false, dirty = true, raf = 0;
  const wake = [];

  el.addEventListener("click", () => { big = !big; flag(el, "big", big); legend.hidden = !big; dirty = true; schedule(); });
  addEventListener("keydown", (e) => { if (big && e.key === "Escape") { big = false; flag(el, "big", false); legend.hidden = true; dirty = true; schedule(); } }, true);
  addEventListener("resize", () => { dirty = true; schedule(); });

  function schedule() { if (!raf) raf = requestAnimationFrame(paint); }

  function paint() {
    raf = 0;
    if (!dirty || !el.isConnected || !el.getClientRects().length) return;   // (offsetParent is null for the fixed big chart)
    dirty = false;
    const r = el.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(60, Math.round(r.width)), hh = Math.max(60, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== hh * dpr) {
      canvas.width = w * dpr; canvas.height = hh * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${hh}px`;
    }
    const g = canvas.getContext("2d");
    if (g) drawBay(g, { world, state: last, wake }, { width: canvas.width, height: canvas.height, scale: dpr, big });
  }

  return {
    el,
    setWorld(w) { world = w || null; wake.length = 0; dirty = true; schedule(); },
    update(s) {
      if (!s) return;
      last = s;
      if (!world && ctx.bayWorld?.()) world = ctx.bayWorld();
      const sh = s.ship;
      if (sh && Number.isFinite(sh.x)) {
        const p = wake[wake.length - 1];
        if (!p || Math.hypot(p.x - sh.x, p.z - sh.z) > 15) { wake.push({ x: sh.x, z: sh.z }); if (wake.length > 800) wake.splice(0, 100); }
      }
      dirty = true;
      schedule();
    },
    reset() { wake.length = 0; dirty = true; },
    wake: () => wake.slice(),
  };
}
