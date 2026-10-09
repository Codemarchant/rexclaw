// Night Raid (from Night Helm, from Starboard): the paper-theatre standee, a
// crew member's stand-in while their VRM loads, and for good when it is
// missing, fails to load, or the Avatar setting is "Portrait". It walks to
// stations and goes overboard like the VRM does (the crew module moves its
// root); the reactions (point, nod, brace, cheer, relief, flinch, hurrah,
// flail…) have paper-theatre takes of their own below.
//
// A full-body portrait (the avatar editor's `.fullbody.png` sidecar) becomes
// a hand-cut paper figure: the silhouette is dilated into a cream card edge
// with a darker cut line and a little paper grain, and the figure stands on
// a brass stand at the rail. A plain portrait instead sits in an oval brass
// cameo with a gilt name plate; with no picture at all, the cameo holds a
// cut-paper bust. Everything is drawn once into a canvas texture.
//
// The standee acts in paper-theatre style: hops, bows, droops and rocks on
// its stand for the same tags the VRM plays clips for, bobs gently on the
// swell, and pulses (scale 1.02) while it speaks. The whole game plays the
// same with it.

import * as THREE from "three";

const CREAM = "#efe2c4";
const CUT_LINE = "#9a7b4c";
const INK = "#2a1d10";
const CARD_H = 1.62;          // a paper figure about life size; the bulwark hides the stand
const CAMEO_H = 0.78;         // the cameo card (640×820 px): its oval is about 0.67 m tall
const CAMEO_Y = 1.45;         // the card's centre; the oval sits 5 cm higher, at head height

/** Load an image element; null on any failure (404, decode, timeout). */
function loadImage(url, timeoutMs = 12000) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    const timer = setTimeout(() => { img.src = ""; resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 4 ? img : null); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** True when the picture has a transparent background (a cut-out), from its border pixels. */
function hasCutout(img) {
  const c = canvas(64, 64), g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, 64, 64);
  try {
    const d = g.getImageData(0, 0, 64, 64).data;
    let clear = 0, n = 0;
    for (let i = 0; i < 64; i++) {
      for (const [x, y] of [[i, 0], [i, 63], [0, i], [63, i]]) {
        n++;
        if (d[(y * 64 + x) * 4 + 3] < 24) clear++;
      }
    }
    return clear / n > 0.6;
  } catch {
    return false;    // a tainted canvas: treat it as a photograph
  }
}

/** Sprinkle paper fibres and foxing over what's already drawn (source-atop keeps the shape). */
function paperGrain(g, w, h, amount = 1) {
  g.save();
  g.globalCompositeOperation = "source-atop";
  const n = Math.round(w * h * 0.004 * amount);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    g.fillStyle = Math.random() < 0.5 ? "rgba(120,90,50,0.07)" : "rgba(255,250,235,0.08)";
    g.fillRect(x, y, 1 + Math.random() * 2.5, 0.6 + Math.random() * 0.8);
  }
  for (let i = 0; i < 6 * amount; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = 6 + Math.random() * 22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(150,110,60,0.08)");
    gr.addColorStop(1, "rgba(150,110,60,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
}

/** A silhouette of `img`, grown by `r` pixels and filled with `color`. */
function dilated(img, w, h, pad, r, color) {
  const c = canvas(w, h), g = c.getContext("2d");
  const steps = 28;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    g.drawImage(img, pad + Math.cos(a) * r, pad + Math.sin(a) * r, w - pad * 2, h - pad * 2);
  }
  g.drawImage(img, pad, pad, w - pad * 2, h - pad * 2);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  return c;
}

/** The hand-cut paper figure: cut line, cream card edge, the figure, a touch of grain. */
function cutoutCanvas(img) {
  const H = 1024;
  const scale = H / img.naturalHeight;
  const iw = Math.round(img.naturalWidth * scale);
  const pad = 22;
  const w = Math.min(2048, iw + pad * 2), h = H + pad * 2;
  const c = canvas(w, h), g = c.getContext("2d");
  g.drawImage(dilated(img, w, h, pad, 13, CUT_LINE), 0, 0);
  g.drawImage(dilated(img, w, h, pad, 11, CREAM), 0, 0);
  paperGrain(g, w, h, 1.4);
  g.drawImage(img, pad, pad, w - pad * 2, h - pad * 2);
  return c;
}

/** An oval brass cameo holding `img` (or a cut-paper bust), with a gilt name plate. */
function cameoCanvas(img, name) {
  const w = 640, h = 820;
  const cx = w / 2, cy = 360, rx = 250, ry = 320;
  const c = canvas(w, h), g = c.getContext("2d");

  // The brass ring: a lathe-turned bevel, light from the upper left.
  const ring = (rxo, ryo, fill) => { g.beginPath(); g.ellipse(cx, cy, rxo, ryo, 0, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); };
  const brass = g.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
  brass.addColorStop(0, "#fff0b8"); brass.addColorStop(0.25, "#e0a43c"); brass.addColorStop(0.5, "#7a5420");
  brass.addColorStop(0.75, "#d9a645"); brass.addColorStop(1, "#5c3d14");
  ring(rx + 34, ry + 34, brass);
  const inner = g.createLinearGradient(cx + rx, cy + ry, cx - rx, cy - ry);
  inner.addColorStop(0, "#ffe7a0"); inner.addColorStop(0.5, "#8a6224"); inner.addColorStop(1, "#3d2a0e");
  ring(rx + 12, ry + 12, inner);
  // Beading around the ring.
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const x = cx + Math.cos(a) * (rx + 23), y = cy + Math.sin(a) * (ry + 23);
    const b = g.createRadialGradient(x - 1.5, y - 1.5, 0, x, y, 5);
    b.addColorStop(0, "#fff6d0"); b.addColorStop(1, "#8a6224");
    g.beginPath(); g.arc(x, y, 4.2, 0, Math.PI * 2); g.fillStyle = b; g.fill();
  }

  // The window: the picture, or indigo velvet and a cut-paper bust.
  g.save();
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.clip();
  const velvet = g.createRadialGradient(cx, cy - 80, 30, cx, cy, ry * 1.1);
  velvet.addColorStop(0, "#27406e"); velvet.addColorStop(1, "#070b1a");
  g.fillStyle = velvet; g.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  if (img) {
    // Cover-fit, favouring the top of the picture (faces live there).
    const s = Math.max((rx * 2) / img.naturalWidth, (ry * 2) / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    g.drawImage(img, cx - dw / 2, cy - ry - Math.max(0, (dh - ry * 2) * 0.12), dw, dh);
  } else {
    g.fillStyle = CREAM;
    g.beginPath();
    g.ellipse(cx, cy - 40, 92, 112, 0, 0, Math.PI * 2);                 // head
    g.moveTo(cx - 210, cy + ry); g.bezierCurveTo(cx - 200, cy + 120, cx - 120, cy + 90, cx - 60, cy + 70);
    g.lineTo(cx + 60, cy + 70); g.bezierCurveTo(cx + 120, cy + 90, cx + 200, cy + 120, cx + 210, cy + ry);
    g.closePath();
    g.fill();
    paperGrain(g, w, h, 0.8);
  }
  // Inner shadow under the ring's lip.
  const lip = g.createRadialGradient(cx, cy, Math.min(rx, ry) * 0.75, cx, cy, Math.max(rx, ry) * 1.02);
  lip.addColorStop(0, "rgba(0,0,0,0)"); lip.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = lip; g.fillRect(0, 0, w, h);
  g.restore();

  // The name plate: a small gilt cartouche under the cameo.
  if (name) {
    const py = cy + ry + 62, pw = Math.min(520, 120 + name.length * 26), ph = 64;
    const plate = g.createLinearGradient(0, py - ph / 2, 0, py + ph / 2);
    plate.addColorStop(0, "#fff0b8"); plate.addColorStop(0.45, "#d9a645"); plate.addColorStop(1, "#6b4a18");
    g.beginPath();
    g.moveTo(cx - pw / 2 + 18, py - ph / 2); g.lineTo(cx + pw / 2 - 18, py - ph / 2);
    g.quadraticCurveTo(cx + pw / 2, py, cx + pw / 2 - 18, py + ph / 2); g.lineTo(cx - pw / 2 + 18, py + ph / 2);
    g.quadraticCurveTo(cx - pw / 2, py, cx - pw / 2 + 18, py - ph / 2);
    g.fillStyle = plate; g.fill();
    g.strokeStyle = "rgba(60,34,6,0.8)"; g.lineWidth = 2; g.stroke();
    g.font = "italic 800 34px Georgia, 'Times New Roman', serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = INK;
    g.fillText(name.length > 22 ? `${name.slice(0, 21)}…` : name, cx, py + 2);
  }
  return c;
}

function texture(c, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  hop: (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t))),
};

/**
 * Paper-theatre reactions: each returns the pose offsets at time t (s) and
 * its length. Offsets: y (m), rx (bow), rz (rock), ry (turn), s (scale).
 */
const REACTIONS = {
  celebrate: { dur: 1.1, at: (t) => { const k = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.55; return { y: 0.09 * ease.hop(k), s: 1 + 0.03 * ease.hop(k) }; } },
  jump: { dur: 0.7, at: (t) => ({ y: 0.16 * ease.hop(t / 0.7), s: 1 + 0.03 * ease.hop(t / 0.7) }) },
  bow: { dur: 2.4, at: (t) => { const k = t < 0.8 ? ease.inOut(t / 0.8) : t < 1.5 ? 1 : 1 - ease.inOut((t - 1.5) / 0.9); return { rx: 0.34 * k }; } },
  sad: { dur: 3.2, at: (t) => { const k = t < 0.8 ? ease.out(t / 0.8) : t < 2.4 ? 1 : 1 - ease.inOut((t - 2.4) / 0.8); return { rx: 0.09 * k, y: -0.025 * k }; } },
  surprised: { dur: 0.9, at: (t) => { const k = t < 0.14 ? ease.out(t / 0.14) : 1 - ease.inOut((t - 0.14) / 0.76); return { y: 0.05 * k, s: 1 + 0.05 * k }; } },
  think: { dur: 3.0, at: (t) => ({ rz: 0.045 * Math.sin((t / 3.0) * Math.PI * 2) }) },
  listen: { dur: 2.2, at: (t) => ({ rz: 0.06 * ease.hop(t / 2.2) }) },
  wave: { dur: 1.8, at: (t) => ({ rz: 0.09 * Math.sin(t * Math.PI * 3.3) * (1 - t / 1.8) }) },
  greet: { dur: 1.5, at: (t) => ({ y: 0.05 * ease.hop(t / 0.5) * (t < 0.5 ? 1 : 0), rz: 0.07 * Math.sin(t * Math.PI * 2.6) * (1 - t / 1.5) }) },
  shrug: { dur: 1.0, at: (t) => ({ rz: 0.06 * Math.sin(t * Math.PI * 4) * (1 - t), y: 0.02 * ease.hop(t) }) },
  point: { dur: 1.8, at: (t, o) => { const k = t < 0.35 ? ease.out(t / 0.35) : t < 1.3 ? 1 : 1 - ease.inOut((t - 1.3) / 0.5); return { rz: 0.1 * k * (o.side === "right" ? -1 : 1) }; } },
  lookaround: { dur: 3.0, at: (t) => ({ ry: 0.28 * Math.sin((t / 3.0) * Math.PI * 2) }) },
  talk: { dur: 1.6, at: (t) => ({ s: 1 + 0.015 * ease.hop((t % 0.4) / 0.4) }) },
  fidget: { dur: 1.4, at: (t) => ({ rz: 0.03 * Math.sin(t * Math.PI * 1.4) }) },
  idle: { dur: 0.1, at: () => ({}) },
  // Night Helm's navigator.
  nod: { dur: 0.9, at: (t) => ({ rx: 0.08 * ease.hop(t / 0.45) * (t < 0.45 ? 1 : 0) + 0.05 * ease.hop((t - 0.45) / 0.45) * (t >= 0.45 ? 1 : 0) }) },
  scan: { dur: 2.6, at: (t) => ({ ry: 0.22 * Math.sin((t / 2.6) * Math.PI * 2), y: 0.015 * ease.hop(t / 2.6) }) },
  pointUp: { dur: 1.8, at: (t) => { const k = t < 0.35 ? ease.out(t / 0.35) : t < 1.3 ? 1 : 1 - ease.inOut((t - 1.3) / 0.5); return { rx: -0.1 * k, y: 0.03 * k }; } },
  brace: { dur: 1.1, at: (t) => { const k = t < 0.1 ? t / 0.1 : 1 - ease.inOut((t - 0.1) / 1.0); return { rz: 0.12 * k * Math.sin(t * 40), rx: -0.08 * k }; } },
  relief: { dur: 2.0, at: (t) => ({ y: -0.03 * ease.hop(t / 2.0), rx: 0.05 * ease.hop(t / 2.0) }) },
  cheer: { dur: 1.0, at: (t) => ({ y: 0.1 * ease.hop(t / 0.5) * (t < 0.5 ? 1 : 0), s: 1 + 0.03 * ease.hop(t) }) },
  arrive: { dur: 1.6, at: (t) => { const k = (t % 0.53) / 0.53; return { y: 0.12 * ease.hop(k), s: 1 + 0.04 * ease.hop(k) }; } },
  resolve: { dur: 1.4, at: (t) => ({ rx: -0.05 * ease.hop(t / 1.4), s: 1 + 0.02 * ease.hop(t / 1.4) }) },
  calm: { dur: 3.0, at: (t) => ({ s: 1 + 0.025 * ease.hop(t / 3.0), y: 0.01 * ease.hop(t / 3.0) }) },
  scared: { dur: 1.6, at: (t) => { const k = t < 0.2 ? ease.out(t / 0.2) : 1 - ease.inOut((t - 0.2) / 1.4); return { rx: -0.12 * k, y: -0.03 * k, rz: 0.04 * k * Math.sin(t * 30) }; } },
  // Night Raid's crew.
  flinch: { dur: 0.8, at: (t) => { const k = t < 0.08 ? t / 0.08 : 1 - ease.inOut((t - 0.08) / 0.72); return { rx: -0.14 * k, y: -0.02 * k }; } },
  hurrah: { dur: 1.2, at: (t) => { const k = (t % 0.6) / 0.6; return { y: 0.12 * ease.hop(k), s: 1 + 0.03 * ease.hop(k) }; } },
  flail: { dur: 1.0, at: (t) => ({ rz: 0.22 * Math.sin(t * Math.PI * 6), rx: -0.1 }) },
  madeit: { dur: 2.0, at: (t) => ({ y: -0.03 * ease.hop(t / 2.0), rx: 0.08 * ease.hop(t / 2.0) }) },
  order: { dur: 1.2, at: (t) => ({ rx: -0.06 * ease.hop(t / 1.2), rz: 0.05 * ease.hop(t / 1.2) }) },
};
for (const k of ["rex", "eve", "ara", "sal", "leo", "me"]) { REACTIONS[`stance_${k}`] = REACTIONS.calm; REACTIONS[`fidget_${k}`] = REACTIONS.fidget; }

/**
 * Build a standee for one companion.
 *
 * @param {object} R  the render context (renderer, for anisotropy)
 * @param {{fullbodyUrl?: string|null, portraitUrl?: string|null, name?: string, layer?: number}} opts
 * @returns {{
 *   group: THREE.Group, ready: Promise<"cutout"|"cameo">, readonly style: string,
 *   react: (tag: string, opts?: {loop?: boolean, side?: string}) => Promise<boolean>,
 *   stopLoop: () => void, pulse: (seconds: number) => void,
 *   show: (on: boolean, opts?: {instant?: boolean}) => Promise<void>,
 *   headHeight: () => number,
 *   update: (dt: number, opts?: {level?: number, reduced?: boolean}) => void,
 *   dispose: () => void,
 * }}
 *   `group` sits at the companion's feet; its local +Z is the card's face.
 *   `level` is the lip-sync loudness (0..1) for the speaking pulse.
 */
export function createStandee(R, { fullbodyUrl = null, portraitUrl = null, name = "", layer = 0 } = {}) {
  const group = new THREE.Group();
  group.name = "standee";
  const pivot = new THREE.Group();            // pivots at the stand's foot: bows tip the whole card
  group.add(pivot);
  const holder = new THREE.Group();           // the card itself (shown/hidden by folding)
  pivot.add(holder);

  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a04a, metalness: 1, roughness: 0.3, envMapIntensity: 0.7 });
  const disposables = [brass];
  let style = "cameo";
  let cardH = CAMEO_H, cardY = CAMEO_Y;

  // The stand: a turned brass foot and a rod up the back of the card.
  const footGeo = new THREE.LatheGeometry([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.17, 0), new THREE.Vector2(0.17, 0.012),
    new THREE.Vector2(0.12, 0.03), new THREE.Vector2(0.05, 0.05), new THREE.Vector2(0.02, 0.07), new THREE.Vector2(0, 0.07),
  ], 28);
  const foot = new THREE.Mesh(footGeo, brass);
  const rodGeo = new THREE.CylinderGeometry(0.011, 0.014, 1, 12);
  rodGeo.translate(0, 0.5, 0);
  const rod = new THREE.Mesh(rodGeo, brass);
  rod.position.z = -0.03;
  const clipGeo = new THREE.BoxGeometry(0.07, 0.035, 0.03);
  const clip = new THREE.Mesh(clipGeo, brass);
  holder.add(foot, rod, clip);
  disposables.push(footGeo, rodGeo, clipGeo);

  let front = null, back = null;
  const finish = (c) => {
    const map = texture(c, R?.renderer);
    const aspect = c.width / c.height;
    const geo = new THREE.PlaneGeometry(cardH * aspect, cardH);
    const frontMat = new THREE.MeshStandardMaterial({
      map, alphaTest: 0.5, roughness: 0.88, metalness: 0,
      emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.07,    // readable away from the lantern, never washed out
    });
    const backMat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, color: 0x4a3a28, roughness: 0.9 });
    front = new THREE.Mesh(geo, frontMat);
    back = new THREE.Mesh(geo, backMat);
    back.rotation.y = Math.PI;
    back.position.z = -0.004;
    front.position.y = back.position.y = cardY;
    holder.add(front, back);
    disposables.push(map, geo, frontMat, backMat);
    // The rod reaches to the card's lower third; the clip holds the card's foot.
    const rodTop = style === "cutout" ? cardY - cardH * 0.12 : cardY - cardH * 0.36;
    rod.scale.y = Math.max(0.1, rodTop);
    clip.position.set(0, style === "cutout" ? 0.05 : rodTop, -0.012);
    group.traverse((o) => { o.layers.set(layer); if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return style;
  };

  const ready = (async () => {
    const full = await loadImage(fullbodyUrl);
    if (full && hasCutout(full)) {
      style = "cutout"; cardH = CARD_H; cardY = CARD_H / 2;
      return finish(cutoutCanvas(full));
    }
    const pic = full || await loadImage(portraitUrl);
    style = "cameo"; cardH = CAMEO_H; cardY = CAMEO_Y;
    return finish(cameoCanvas(pic, name));
  })().catch((error) => {
    console.debug("[night-raid] standee: drawing failed, using the plain cameo", error);
    style = "cameo"; cardH = CAMEO_H; cardY = CAMEO_Y;
    return finish(cameoCanvas(null, name));
  });

  // ---- Acting ----------------------------------------------------------------------

  let t = 0;
  let shot = null;          // { r, t, opts, resolve }
  let loop = null;          // { r, t, opts }
  let pulseUntil = 0;
  let shown = 0, showTarget = 0, showResolve = null;   // starts folded flat; show(true) stands it up

  /** Play a reaction (or hold it as a loop). Resolves when a one-shot finishes. */
  function react(tag, opts = {}) {
    const r = REACTIONS[tag] || REACTIONS.idle;
    if (opts.loop) {
      loop = { r, t: 0, opts };
      return Promise.resolve(true);
    }
    shot?.resolve(false);
    return new Promise((resolve) => { shot = { r, t: 0, opts, resolve }; });
  }

  function update(dt, { level = 0, reduced = false } = {}) {
    t += dt;
    // Unfold / fold: the card swings up from flat (rx −90°) on its foot.
    const before = shown;
    shown += (showTarget - shown) * (1 - Math.exp(-dt * 7));
    if (Math.abs(showTarget - shown) < 0.002) shown = showTarget;
    if (before !== shown && shown === showTarget) { showResolve?.(); showResolve = null; }
    holder.visible = shown > 0.01;

    let y = 0, rx = 0, rz = 0, ry = 0, s = 1;
    const add = (o) => { y += o.y || 0; rx += o.rx || 0; rz += o.rz || 0; ry += o.ry || 0; s *= o.s || 1; };
    if (loop) { loop.t = (loop.t + dt) % loop.r.dur; if (!shot) add(loop.r.at(loop.t, loop.opts)); }
    if (shot) {
      shot.t += dt;
      add(shot.r.at(Math.min(shot.t, shot.r.dur), shot.opts));
      if (shot.t >= shot.r.dur) { shot.resolve(true); shot = null; }
    }
    // The swell: a slow bob and a slight rock (much smaller with reduced motion).
    const k = reduced ? 0.2 : 1;
    y += 0.006 * k * Math.sin(t * 2 * Math.PI * 0.25);
    rz += 0.01 * k * Math.sin(t * 2 * Math.PI * 0.21 + 1.3);
    // Speaking: a soft pulse with the voice (or with talkPulse's beat).
    const beat = t < pulseUntil ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 4.2) : 0;
    s *= 1 + 0.02 * Math.max(level, beat * 0.8);

    pivot.position.y = y;
    pivot.rotation.set(rx, ry, rz);
    holder.rotation.x = (1 - ease.out(shown)) * -Math.PI / 2;
    holder.scale.setScalar(s);
  }

  return {
    group,
    ready,
    get style() { return style; },
    react,
    pulse(seconds) { pulseUntil = t + Math.max(0, seconds); },
    /** Unfold onto the rail (true) or fold flat and away (false). */
    show(on, { instant = false } = {}) {
      showTarget = on ? 1 : 0;
      if (instant) shown = showTarget;
      if (shown === showTarget) { holder.visible = on; return Promise.resolve(); }
      return new Promise((resolve) => { showResolve?.(); showResolve = resolve; });
    },
    /** Where the face is, above the feet (m): for the thinking dots and the look target. */
    headHeight: () => (style === "cutout" ? CARD_H * 0.9 : CAMEO_Y + 0.12),
    update,
    dispose() {
      shot?.resolve(false);
      group.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
}
