// Rexmaw Raids v4: picking ships, the target lock and the anchors for the ships' floating tags (spec §2).
//
//   pick        generous: a ship counts when the cursor is within `PICK_PX` (60 client px) of her projected
//               silhouette (the screen box round her hull and rig), or when the cursor's ray hits her enlarged
//               hull volume (a box half again as wide as her beam, a fifth longer, up to her tops). Of the ships
//               that count, the one nearest the cursor wins (the screen box's distance, then her centre's).
//   lock        a gilt bracket (four corners, a soft glow, a small pip over her) round the locked ship's screen
//               box: the core's `state.lock` (or `setLock` from the UI while it waits for the state). It snaps in
//               from 1.4× when the lock changes.
//   hover       a faint pale outline round the ship under the cursor (not the locked one).
//   tags        `tagAnchors()` → where each ship's floating tag sits: over her masthead, in client px.
//
// The brackets are clip-space quads (screen-aligned, sized in pixels from the projected box), drawn on top with
// no depth; NOREFLECT so the water's mirror never sees them. Two draws, built once. NaN-safe.

import * as THREE from "three";
import { LAYERS, WATER_Y } from "./blocking.js";

const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;
export const PICK_PX = 60;
const PAD_PX = 9, MIN_PX = 34;
const GILT = new THREE.Color("#ffcf6b"), PALE = new THREE.Color("#f3ead2");

/** The lock's contact id from the state: `lock` as an id, {contactId}, {id} or {target}. */
export function lockIdOf(st) {
  const l = st?.lock;
  if (l == null) return null;
  if (typeof l === "string" || typeof l === "number") return l;
  return l.contactId ?? l.id ?? l.target ?? null;
}

/**
 * @param {object} R  the render context
 * @param {{fleet: object}} deps
 */
export function createTarget(R, { fleet }) {
  const geo = new THREE.PlaneGeometry(2, 2);
  const make = (name, color, lock) => {
    const mat = new THREE.ShaderMaterial({
      name, transparent: true, depthTest: false, depthWrite: false, fog: false,
      uniforms: { uRect: { value: new THREE.Vector4(-0.1, -0.1, 0.1, 0.1) }, uSize: { value: new THREE.Vector2(100, 100) },
        uColor: { value: color.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 }, uLock: { value: lock ? 1 : 0 } },
      vertexShader: /* glsl */`
        uniform vec4 uRect;   // NDC: x0, y0, x1, y1
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(mix(uRect.xy, uRect.zw, uv), 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec2 uSize; uniform vec3 uColor; uniform float uAlpha, uTime, uLock;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * uSize;                       // px from the bottom-left corner
          vec2 q = min(p, uSize - p);                 // px in from the nearest edges
          float edge = min(q.x, q.y);
          float a = 0.0;
          if (uLock > 0.5) {
            // Corners: L-shaped strokes 2.4 px thick, arms a quarter of the shorter side (≤ 22 px), a soft glow out.
            float arm = min(22.0, min(uSize.x, uSize.y) * 0.28);
            float inCorner = step(max(q.x, q.y), arm);
            float stroke = 1.0 - smoothstep(2.4, 3.4, edge);
            float glow = exp(-edge * 0.32) * 0.35;
            a = inCorner * (stroke + glow);
            // A small diamond pip over the top edge's middle.
            vec2 c = vec2(uSize.x * 0.5, uSize.y - 7.0);
            float dmd = abs(p.x - c.x) + abs(p.y - c.y);
            a = max(a, 1.0 - smoothstep(4.0, 5.2, dmd));
            a *= 0.85 + 0.15 * sin(uTime * 4.0);
          } else {
            // A thin, faint outline with rounded corners.
            vec2 r = max(vec2(6.0) - q, 0.0);
            float d = 6.0 - length(r);                // distance in from the rounded border
            d = (q.x < 6.0 && q.y < 6.0) ? d : edge;
            a = (1.0 - smoothstep(0.9, 1.9, abs(d - 1.2))) * 0.8 + exp(-max(d, 0.0) * 0.25) * 0.12;
          }
          a *= uAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (uLock > 0.5 ? 1.6 : 1.1), clamp(a, 0.0, 1.0));
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = 40;
    mesh.visible = false;
    mesh.layers.set(LAYERS.NOREFLECT);
    R.scene.add(mesh);
    return { mesh, mat, id: null, alpha: 0, snap: 1, rect: null };
  };
  const lock = make("target-lock", GILT, true);
  const hover = make("target-hover", PALE, false);

  const _v = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _hit = new THREE.Vector3();
  const _box = new THREE.Box3(), _ray = new THREE.Ray();
  const T = { lockOverride: undefined, lockId: null, hoverId: null, time: 0, st: null };
  const tops = new Map();     // class key → masthead height (m above her waterline)

  function mastTop(sh) {
    let t = tops.get(sh.kind);
    if (t == null) {
      t = 0;
      for (const m of sh.K.plan?.list || []) t = Math.max(t, (+m.base || 0) + (+m.h || 0));
      if (!(t > 0)) t = sh.K.c.h0 + 18;
      tops.set(sh.kind, t);
    }
    return t;
  }

  /** Project world (x, y, z) → client px; null behind the lens. */
  function toScreen(x, y, z, rect) {
    _v.set(x, y, z).project(R.camera);
    if (!(_v.z < 1 && _v.z > -1) || !Number.isFinite(_v.x)) return null;
    return { x: rect.left + (_v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-_v.y * 0.5 + 0.5) * rect.height };
  }

  /** A ship's screen box (client px) from her hull's corners and her rig: {x0, y0, x1, y1, cx, cy} or null. */
  function screenBox(sh, rect) {
    const c = sh.K.c;
    const hw = c.B * 0.75, hl = c.L * 0.5;
    const [hx, hz] = [-Math.sin(sh.heading * DEG), Math.cos(sh.heading * DEG)];
    const px = -hz, pz = hx;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    const add = (lx, ly, lz) => {
      const s = toScreen(sh.x + px * lx + hx * lz, WATER_Y + ly + (sh.heave || 0), sh.z + pz * lx + hz * lz, rect);
      if (!s) return;
      n++;
      if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
      if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
    };
    for (const lz of [-hl, hl]) for (const lx of [-hw, hw]) { add(lx, -0.3, lz); add(lx, c.h0 + 1.2, lz); }
    for (const m of sh.K.plan?.list || []) {
      const w = (m.yards?.[0]?.w || c.B * 2) * 0.5;
      add(0, (+m.base || 0) + (+m.h || 0), m.z);
      add(w, (+m.base || 0) + m.h * 0.45, m.z); add(-w, (+m.base || 0) + m.h * 0.45, m.z);
    }
    if (n < 3 || !Number.isFinite(x0 + y0 + x1 + y1)) return null;
    // A box far bigger than the screen means the lens is right on top of her: no box.
    if (x1 - x0 > rect.width * 3 || y1 - y0 > rect.height * 3) return null;
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  /** The enlarged hull volume vs a world ray: the distance along it, or null. */
  function rayHull(sh, ray) {
    const c = sh.K.c, top = mastTop(sh);
    const a = -sh.heading * DEG, ca = Math.cos(a), sa = Math.sin(a);
    // World → her frame (yaw only): rotate by −a about Y.
    const toLocal = (v, out, point) => {
      const x = point ? v.x - sh.x : v.x, z = point ? v.z - sh.z : v.z;
      return out.set(x * ca - z * sa, point ? v.y - WATER_Y : v.y, x * sa + z * ca);
    };
    _ray.origin.copy(toLocal(ray.origin, _o, true));
    _ray.direction.copy(toLocal(ray.direction, _d, false)).normalize();
    const hw = c.B * 0.75 * 1.6 + 2, hl = c.L * 0.5 * 1.2 + 3;
    _box.min.set(-hw, -2, -hl); _box.max.set(hw, Math.max(c.h0 + 6, top * 0.75), hl);
    const p = _ray.intersectBox(_box, _hit);
    return p ? p.distanceTo(_ray.origin) : null;
  }

  /**
   * The ship nearest the cursor within reach: {id, px (screen distance to her box, 0 inside), dist (m along the ray),
   * ray: bool} or null.
   */
  function pick(clientX, clientY, ray, { radius = PICK_PX } = {}) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = R.renderer.domElement.getBoundingClientRect();
    R.camera.updateMatrixWorld();
    let best = null;
    fleet.each((id, sh) => {
      if (sh.vis < 0.3 || sh.fade < 0.3 || sh.last?.synthetic) return;     // a sea event's stand-in hull isn't a contact
      const box = screenBox(sh, rect);
      const along = ray ? rayHull(sh, ray) : null;
      if (!box && along == null) return;
      let dx = 0, dy = 0;
      if (box) { dx = Math.max(box.x0 - clientX, 0, clientX - box.x1); dy = Math.max(box.y0 - clientY, 0, clientY - box.y1); }
      const px = along != null ? 0 : Math.hypot(dx, dy);
      if (px > radius) return;
      const centre = box ? Math.hypot(box.cx - clientX, box.cy - clientY) : 0;
      const score = px + centre * 0.35;
      const far = ray ? Math.hypot(sh.x - ray.origin.x, sh.z - ray.origin.z) : 0;
      if (!best || score < best.score) best = { id, px, dist: along ?? far, ray: along != null, score };
    });
    if (!best) return null;
    delete best.score;
    return best;
  }

  /** Per frame: which ship, how strongly (the box itself is laid out just before the draw, with the frame's camera). */
  function place(o, id, rect, dt, target) {
    const sh = id != null ? fleet.ship?.(id) : null;
    const box = sh && sh.group.visible && !sh.sunk ? screenBox(sh, rect) : null;
    const want = box && target > 0 ? target * clamp(sh.fade, 0, 1) * (sh.sinking ? 1 - sh.sink : 1) : 0;
    if (id !== o.id) { o.id = id; o.snap = 1.4; o.alpha = 0; }
    o.alpha += (want - o.alpha) * Math.min(1, dt * 10);
    o.snap += (1 - o.snap) * Math.min(1, dt * 9);
    o.sh = sh;
    if (!box || o.alpha < 0.01) { o.mesh.visible = false; o.rect = null; return; }
    o.mesh.visible = true;
    layout(o, rect, box);
  }
  /** The bracket's clip-space rect from the ship's screen box. */
  function layout(o, rect, box) {
    let w = Math.max(MIN_PX, box.x1 - box.x0 + PAD_PX * 2), h = Math.max(MIN_PX, box.y1 - box.y0 + PAD_PX * 2);
    w *= o.snap; h *= o.snap;
    const cx = box.cx, cy = box.cy;
    const nx0 = ((cx - w / 2 - rect.left) / rect.width) * 2 - 1, nx1 = ((cx + w / 2 - rect.left) / rect.width) * 2 - 1;
    const ny1 = -(((cy - h / 2 - rect.top) / rect.height) * 2 - 1), ny0 = -(((cy + h / 2 - rect.top) / rect.height) * 2 - 1);
    if (![nx0, nx1, ny0, ny1].every(Number.isFinite)) { o.mesh.visible = false; return; }
    o.mat.uniforms.uRect.value.set(nx0, ny0, nx1, ny1);
    o.mat.uniforms.uSize.value.set(w, h);
    o.mat.uniforms.uAlpha.value = o.alpha;
    o.mat.uniforms.uTime.value = T.time;
    o.rect = { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  // The camera moves after world.update (R.cam.update): lay the bracket out again right before it's drawn.
  for (const o of [lock, hover]) {
    o.mesh.onBeforeRender = () => {
      if (!o.sh || !o.sh.group.visible || !T.rect) return;
      const rect = T.rect;            // this frame's (update() read it once: no layout reads in the draw)
      const box = screenBox(o.sh, rect);
      if (box) layout(o, rect, box);
    };
  }

  return {
    pick,
    /** Per frame (after the fleet): the lock from the state (or the override), the hover; places both brackets. */
    update(st, dt) {
      T.st = st;
      T.time += dt;
      T.lockId = T.lockOverride !== undefined ? T.lockOverride : lockIdOf(st);
      if (T.lockId == null && T.hoverId == null && !lock.mesh.visible && !hover.mesh.visible) return;
      const rect = T.rect = R.renderer.domElement.getBoundingClientRect();
      R.camera.updateMatrixWorld();
      place(lock, T.lockId, rect, dt, 1);
      place(hover, T.hoverId != null && T.hoverId !== T.lockId ? T.hoverId : null, rect, dt, 0.55);
    },
    /** The hovered ship (or null): a faint outline. */
    setHover(id) { T.hoverId = id ?? null; },
    /** The UI's lock while the state catches up (null: none; undefined: back to the state's). */
    setLock(id) { T.lockOverride = id; },
    get lockId() { return T.lockId; },
    get hoverId() { return T.hoverId; },
    /** The lock bracket's screen box now ({x, y, w, h} client px) or null. */
    get lockRect() { return lock.mesh.visible ? lock.rect : null; },
    /**
     * The floating tags' anchors: every ship afloat → {contactId, x, y (client px, `lift` m over her masthead), visible,
     * dist (m from the Rexmaw, or the camera when there's no ship), locked, sinking}.
     */
    tagAnchors({ lift = 4 } = {}) {
      const out = [];
      const rect = R.renderer.domElement.getBoundingClientRect();
      R.camera.updateMatrixWorld();
      const sh0 = T.st?.ship;
      R.camera.getWorldPosition(_o);
      const ox = Number.isFinite(+sh0?.x) ? +sh0.x : _o.x, oz = Number.isFinite(+sh0?.z) ? +sh0.z : _o.z;
      fleet.eachAll?.((id, sh) => {
        if (sh.sunk || sh.last?.synthetic) return;
        const y = WATER_Y + (sh.heave || 0) + mastTop(sh) + lift;
        _v.set(sh.x, y, sh.z).project(R.camera);
        const front = _v.z < 1 && _v.z > -1 && Number.isFinite(_v.x);
        const x = rect.left + (_v.x * 0.5 + 0.5) * rect.width, yy = rect.top + (-_v.y * 0.5 + 0.5) * rect.height;
        const visible = front && Math.abs(_v.x) <= 1.02 && Math.abs(_v.y) <= 1.02 && sh.vis > 0.3 && sh.fade > 0.3 && !(sh.sink > 0.6);
        out.push({ contactId: id, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(yy) ? yy : 0, visible, dist: Math.round(Math.hypot(sh.x - ox, sh.z - oz)), locked: id === T.lockId, sinking: !!sh.sinking });
      });
      return out;
    },
    warmShow(on) {
      for (const o of [lock, hover]) { o.mesh.visible = !!on; if (on) o.mat.uniforms.uAlpha.value = 0.01; }
    },
    reset() { T.lockId = null; T.hoverId = null; T.lockOverride = undefined; for (const o of [lock, hover]) { o.id = null; o.alpha = 0; o.mesh.visible = false; } },
    stats: () => ({ lock: T.lockId, hover: T.hoverId, lockShown: lock.mesh.visible }),
    dispose() { for (const o of [lock, hover]) { o.mesh.removeFromParent(); o.mat.dispose(); } geo.dispose(); },
  };
}
