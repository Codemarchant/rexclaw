"""Procedurally build the Rexmaw deck scene and export it as a GLB background.

Run headless:
    blender -b --python build_rexmaw_deck.py -- <out_dir> [all|export|preview]

Blender coords: Z up, main deck at z=0, the companion's spawn at the origin
facing -Y (the app's default camera sits at -Y looking +Y). glTF export turns
this into three.js Y-up with the camera on +Z — the app's convention.

Everything is generated: geometry per material is accumulated into a few big
meshes (few draw calls), textures are painted with numpy and packed.
"""
import bpy, bmesh, math, random, sys, os, time
import numpy as np
from mathutils import Vector, Matrix

T0 = time.time()
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.dirname(os.path.abspath(__file__))
MODE = argv[1] if len(argv) > 1 else 'all'
os.makedirs(OUT, exist_ok=True)
random.seed(7)
RNG = np.random.default_rng(7)


def log(*a):
    print(f"[rexmaw {time.time() - T0:6.1f}s]", *a, flush=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
SCN = bpy.context.scene

# ════════════════════════════════════════════════════════════════════════
# Layout constants
# ════════════════════════════════════════════════════════════════════════
W = 4.2            # half beam amidships
BULK_Y = 4.5       # cabin bulkhead (front face) — the backdrop behind the spawn
QD = 2.6           # quarterdeck height
STERN_Y = 12.5
BOW_Y = -20.0
FC_Y = -14.0       # forecastle front wall
FC_Z = 1.6         # forecastle deck height
WATER_Z = -2.2
SKY_R = 78.0            # camera far plane is 100 — keep the dome well inside it
SUN = Vector((0.6, -0.8, math.tan(math.radians(6.0)))).normalized()


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def hw(y):
    """Hull half-width at deck level."""
    if y > 5:
        return W - 0.6 * ((y - 5) / (STERN_Y - 5)) ** 2
    if y < -6:
        t = (y + 6) / (BOW_Y + 6)
        return max(0.03, W * math.sqrt(max(0.0, 1 - t * t)))
    return W


def top(y):
    """Bulwark top height."""
    z = 1.1
    if y > BULK_Y - 1.0:
        z += QD * smooth((y - (BULK_Y - 1.0)) / 1.0)
    if y < -11:
        z += 1.6 * smooth((-11 - y) / 5.0)
    return z


def tf(z):
    """Tumblehome / hull section shape factor."""
    if z >= 0:
        return 1 - 0.02 * z
    k = max(0.0, (-z - 1.4) / 3.0)          # full beam down past the waterline, keel at -4.4
    return math.sqrt(max(0.0, 1 - k * k))


def xi(y, z=0.0):
    """Inner face of the bulwark."""
    return hw(y) * tf(z) - 0.15


# ════════════════════════════════════════════════════════════════════════
# Texture painting (numpy). Arrays are (h, w, 3), row 0 = bottom (Blender).
# ════════════════════════════════════════════════════════════════════════
def vnoise(h, w, ch, cw, rng):
    g = rng.random((ch, cw)).astype(np.float32)
    ys = np.arange(h) * ch / h
    xs = np.arange(w) * cw / w
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    fy = ys - y0
    fx = xs - x0
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    y1 = (y0 + 1) % ch
    x1 = (x0 + 1) % cw
    a = g[y0][:, x0]; b = g[y0][:, x1]; c = g[y1][:, x0]; d = g[y1][:, x1]
    fx = fx[None, :]; fy = fy[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(h, w, ch, cw, octaves, rng, p=0.5):
    tot = np.zeros((h, w), np.float32); amp = 1.0; s = 0.0
    for o in range(octaves):
        tot += amp * vnoise(h, w, min(h, ch * 2 ** o), min(w, cw * 2 ** o), rng)
        s += amp; amp *= p
    return tot / s


def normal_from_height(ht, strength=2.0):
    dx = (np.roll(ht, -1, 1) - np.roll(ht, 1, 1)) * 0.5 * strength
    dy = (np.roll(ht, -1, 0) - np.roll(ht, 1, 0)) * 0.5 * strength
    n = np.stack([-dx, -dy, np.ones_like(ht)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def plank_tex(rng, size=1024, rows=8, base=(0.6, 0.46, 0.32), var=0.08, grain=0.35,
              seam=0.35, joints=2, dirt=0.3, paint=None, chip=0.55, knots=6, nails=True):
    """Boards running along U (image x). Returns (albedo, normal)."""
    h = w = size
    rh = h // rows
    base = np.array(base, np.float32)
    col = np.zeros((h, w, 3), np.float32)
    sm = np.ones((h, w), np.float32)          # seam multiplier (applied last)
    ht = np.ones((h, w), np.float32)
    streak = fbm(h, w, 256, 4, 3, rng)
    ring = fbm(h, w, 48, 3, 2, rng)
    fine = np.sin(np.arange(h, dtype=np.float32)[:, None] * 1.3 + ring * 60) * 0.5 + 0.5
    for r in range(rows):
        y0, y1 = r * rh, (r + 1) * rh
        cuts = sorted(int(c) for c in rng.integers(8, w - 8, size=joints)) if joints else []
        bounds = [0] + cuts + [w]
        first = None
        for k, (a, b) in enumerate(zip(bounds[:-1], bounds[1:])):
            c = base * (1 + rng.normal(0, var)) * (1 + rng.normal(0, var * 0.35, 3))
            if k == 0:
                first = c
            if k == len(bounds) - 2 and cuts:
                c = first                      # wraps round to the first board
            col[y0:y1, a:b] = c
        for cx in cuts:
            sm[y0:y1, cx - 1:cx + 1] *= seam + 0.15
            ht[y0:y1, cx - 1:cx + 1] = 0.35
            if nails:
                for dy in (int(rh * 0.3), int(rh * 0.7)):
                    for dx in (-7, 7):
                        yy, xx = y0 + dy, (cx + dx) % w
                        sm[yy - 1:yy + 2, max(xx - 1, 0):xx + 2] *= 0.45
                        ht[yy - 1:yy + 2, max(xx - 1, 0):xx + 2] = 0.8
        sm[y0:y0 + 2] *= seam
        sm[y0 + 2:y0 + 3] *= (seam + 1) / 2
        ht[y0:y0 + 2] = 0.0
        ht[y0 + 2:y0 + 3] = 0.6
    g = 0.80 + grain * (streak - 0.5) * 1.6 + 0.07 * (fine - 0.5)
    col *= g[..., None]
    for _ in range(knots):
        ky, kx = rng.integers(0, h), rng.integers(0, w)
        yy, xx = np.ogrid[:h, :w]
        dd = ((yy - ky) / 7.0) ** 2 + (((xx - kx + w // 2) % w - w // 2) / 16.0) ** 2
        col *= (1 - 0.45 * np.exp(-dd))[..., None]
    if paint is not None:
        pm = fbm(h, w, 36, 36, 4, rng)
        mask = np.clip((pm - chip) * -9 + 0.5, 0, 1)   # 1 = paint intact
        pv = fbm(h, w, 4, 4, 3, rng)
        pc = np.array(paint, np.float32)[None, None, :] * (0.88 + 0.24 * pv)[..., None]
        col = col * (1 - mask[..., None]) + pc * mask[..., None]
        ht += 0.08 * mask
    if dirt:
        d = fbm(h, w, 4, 4, 5, rng)
        col *= (1 - dirt * np.clip(d - 0.42, 0, 1) * 2.2)[..., None]
    col *= sm[..., None]
    ht += 0.05 * (streak - 0.5)
    return np.clip(col, 0, 1), normal_from_height(ht, 3.0)


def noise_tex(rng, size, c1, c2, ch=8, oct=5, contrast=1.0):
    n = fbm(size, size, ch, ch, oct, rng)
    n = np.clip((n - 0.5) * contrast + 0.5, 0, 1)[..., None]
    return np.array(c1, np.float32) * (1 - n) + np.array(c2, np.float32) * n


def stone_tex(rng, size=1024):
    """Quay masonry: staggered ashlar courses. Tile = 4 m."""
    h = w = size
    rows = 8
    rh = h // rows
    col = np.zeros((h, w, 3), np.float32)
    ht = np.ones((h, w), np.float32)
    for r in range(rows):
        n = int(rng.integers(3, 5))
        cuts = np.sort(rng.integers(0, w, n))
        bounds = list(cuts) + [cuts[0] + w]
        for a, b in zip(bounds[:-1], bounds[1:]):
            c = np.array((0.52, 0.50, 0.46), np.float32) * (1 + rng.normal(0, 0.09)) * (1 + rng.normal(0, 0.03, 3))
            idx = np.arange(a, b) % w
            col[r * rh:(r + 1) * rh, idx] = c
            col[r * rh:(r + 1) * rh, idx[:4]] *= 0.45
            ht[r * rh:(r + 1) * rh, idx[:4]] = 0.2
        col[r * rh:r * rh + 5] *= 0.5
        ht[r * rh:r * rh + 5] = 0.2
    n = fbm(h, w, 16, 16, 5, rng)
    col *= (0.75 + 0.5 * n)[..., None]
    wet = np.linspace(0.55, 1.0, h, dtype=np.float32)[:, None, None]   # darker toward the waterline
    col *= np.clip(wet * 1.25, 0, 1)
    ht += 0.15 * n
    return np.clip(col, 0, 1), normal_from_height(ht, 2.5)


def roof_tex(rng, size=512, base=(0.62, 0.30, 0.18), slate=False):
    h = w = size
    rows = 16
    rh = h // rows
    col = np.zeros((h, w, 3), np.float32)
    base = np.array(base, np.float32)
    per = 12 if not slate else 10
    cw = w // per
    for r in range(rows):
        off = (cw // 2) * (r % 2)
        for k in range(per):
            a = (k * cw + off) % w
            c = base * (1 + rng.normal(0, 0.10))
            idx = np.arange(a, a + cw) % w
            grad = np.linspace(0.55, 1.05, rh, dtype=np.float32)[:, None, None]
            col[r * rh:(r + 1) * rh, idx] = c * grad
            col[r * rh:(r + 1) * rh, idx[:2]] *= 0.5
    n = fbm(h, w, 8, 8, 4, rng)
    col *= (0.75 + 0.45 * n)[..., None]
    return np.clip(col, 0, 1)


def facade_tex(rng, plaster, shutter, lit, size=1024):
    """4x4 storeys/bays of 3 m each (tile 12 m). Returns albedo; emissive
    from the shared `lit` mask is painted by facade_emissive()."""
    h = w = size
    t = size // 4
    n = fbm(h, w, 8, 8, 5, rng)
    col = np.array(plaster, np.float32)[None, None, :] * (0.82 + 0.3 * n)[..., None]
    streaks = fbm(h, w, 3, 40, 3, rng)
    col *= (0.9 + 0.12 * streaks)[..., None]
    sh = np.array(shutter, np.float32)
    for by in range(4):
        for bx in range(4):
            x0, y0 = bx * t, by * t
            wx0, wx1 = x0 + int(t * 0.36), x0 + int(t * 0.64)
            wy0, wy1 = y0 + int(t * 0.30), y0 + int(t * 0.76)
            col[wy0 - 6:wy1 + 6, wx0 - 6:wx1 + 6] = (0.88, 0.86, 0.80)        # stone surround
            col[wy0 - 10:wy0 - 4, wx0 - 10:wx1 + 10] = (0.70, 0.68, 0.62)     # sill
            glass = (1.0, 0.78, 0.45) if lit[by, bx] else (0.16, 0.19, 0.24)
            col[wy0:wy1, wx0:wx1] = glass
            mx = (wx0 + wx1) // 2; my = wy0 + int((wy1 - wy0) * 0.6)
            col[wy0:wy1, mx - 2:mx + 2] = (0.25, 0.2, 0.16)
            col[my - 2:my + 2, wx0:wx1] = (0.25, 0.2, 0.16)
            sw = int(t * 0.11)
            col[wy0:wy1, wx0 - 6 - sw:wx0 - 6] = sh * (0.9 + 0.1 * rng.random())
            col[wy0:wy1, wx1 + 6:wx1 + 6 + sw] = sh * (0.9 + 0.1 * rng.random())
            # rain stain below the sill
            yy = np.arange(y0, wy0 - 10)
            if len(yy):
                fade = np.linspace(0.85, 1.0, len(yy), dtype=np.float32)[::-1][:, None, None]
                col[yy[0]:yy[-1] + 1, wx0:wx1] *= fade
    return np.clip(col, 0, 1)


def facade_emissive(lit, size=1024):
    h = w = size
    t = size // 4
    em = np.zeros((h, w, 3), np.float32)
    for by in range(4):
        for bx in range(4):
            if not lit[by, bx]:
                continue
            x0, y0 = bx * t, by * t
            wx0, wx1 = x0 + int(t * 0.36), x0 + int(t * 0.64)
            wy0, wy1 = y0 + int(t * 0.30), y0 + int(t * 0.76)
            c = np.array((1.0, 0.70, 0.36), np.float32) * (0.75 + 0.25 * RNG.random())
            em[wy0:wy1, wx0:wx1] = c
            mx = (wx0 + wx1) // 2; my = wy0 + int((wy1 - wy0) * 0.6)
            em[wy0:wy1, mx - 2:mx + 2] = 0
            em[my - 2:my + 2, wx0:wx1] = 0
    return em


# ── Sky + water radiance ────────────────────────────────────────────────
S_H = Vector((SUN.x, SUN.y, 0)).normalized()


def sky_rgb(d):
    """Dusk sky radiance for unit directions d[..., 3] (display sRGB-ish)."""
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    el = np.arcsin(np.clip(z, -1, 1))
    eld = np.degrees(el)
    hl = np.sqrt(x * x + y * y) + 1e-6
    c = (x * S_H.x + y * S_H.y) / hl                     # horizontal closeness to sun
    ts = ((c + 1) / 2)[..., None]
    cosg = np.clip(x * SUN.x + y * SUN.y + z * SUN.z, -1, 1)
    gam = np.arccos(cosg)
    zen = np.array((0.13, 0.17, 0.36)) * (1 - ts) + np.array((0.24, 0.27, 0.48)) * ts
    hor = np.array((0.86, 0.60, 0.64)) * (1 - ts ** 1.6) + np.array((1.0, 0.64, 0.34)) * ts ** 1.6
    e = np.clip(el / (math.pi / 2), 0, 1)[..., None]
    k = e ** 0.42
    col = hor * (1 - k) + zen * k
    # Belt of Venus (pink band) over the earth shadow (blue band), anti-sun side
    anti = ((1 - ts[..., 0]) ** 2)
    belt = np.exp(-((eld - 8) / 5.5) ** 2) * anti
    col = col * (1 - 0.35 * belt[..., None]) + np.array((0.98, 0.62, 0.70)) * 0.35 * belt[..., None]
    shadow = np.exp(-((eld - 1.5) / 2.5) ** 2) * anti
    col = col * (1 - 0.35 * shadow[..., None]) + np.array((0.46, 0.46, 0.66)) * 0.35 * shadow[..., None]
    # sun glow + disk
    g1 = np.exp(-gam / 0.10)[..., None]
    g2 = np.exp(-gam / 0.45)[..., None]
    col = col + g2 * np.array((0.55, 0.30, 0.10)) * 0.8 + g1 * np.array((1.0, 0.80, 0.55)) * 0.9
    disk = np.clip((0.018 - gam) / 0.004, 0, 1)[..., None]
    col = col * (1 - disk) + np.array((1.0, 0.97, 0.88)) * disk
    # below the horizon: haze that the water edge blends into
    below = np.clip(-eld / 3.0, 0, 1)[..., None]
    col = col * (1 - below) + (hor * 0.78 + np.array((0.05, 0.1, 0.13)) * 0.22) * below
    return col, ts[..., 0], eld


def sky_tex(W_=2048, H_=1024):
    rng = np.random.default_rng(11)
    u = (np.arange(W_) + 0.5) / W_
    v = (np.arange(H_) + 0.5) / H_
    lon = (u - 0.5) * 2 * math.pi
    lat = (v - 0.5) * math.pi
    LON, LAT = np.meshgrid(lon, lat)
    d = np.stack([np.cos(LAT) * np.cos(LON), np.cos(LAT) * np.sin(LON), np.sin(LAT)], -1)
    col, ts, eld = sky_rgb(d)
    # clouds: horizontally stretched fbm in a band above the horizon
    n = fbm(H_, W_, 10, 14, 6, rng)
    n2 = fbm(H_, W_, 40, 20, 4, rng)
    dens = np.clip((n * 0.8 + n2 * 0.2 - 0.54) / 0.16, 0, 1)
    band = np.clip(eld / 3.0, 0, 1) * np.clip((38 - eld) / 18.0, 0, 1)
    dens *= band * 0.85
    lit = ts ** 2
    cloud = (np.array((0.58, 0.47, 0.62)) * (1 - lit[..., None]) + np.array((1.0, 0.60, 0.42)) * lit[..., None])
    rim = np.exp(-np.arccos(np.clip(d @ np.array(SUN), -1, 1)) / 0.35)[..., None]
    cloud = cloud + rim * np.array((1.0, 0.75, 0.45)) * 0.6
    cloud *= (0.8 + 0.35 * n2)[..., None]
    col = col * (1 - dens[..., None]) + cloud * dens[..., None]
    return np.clip(col, 0, 1)


EYE = np.array((0.0, -1.0, 1.6 - WATER_Z))      # eye relative to the water plane


def water_tex(size=2048, extent=SKY_R):
    rng = np.random.default_rng(5)
    xs = (np.arange(size) + 0.5) / size * 2 * extent - extent
    X, Y = np.meshgrid(xs, xs)
    # ripples → normal perturbation (anisotropic: swell runs along x)
    n1 = fbm(size, size, 300, 110, 4, rng)
    n2 = fbm(size, size, 700, 320, 2, rng)
    hgt = n1 * 0.7 + n2 * 0.3
    gx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 1.2
    gy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 1.2
    dx = X - EYE[0]; dy = Y - EYE[1]; dz = np.full_like(X, -EYE[2])
    L = np.sqrt(dx * dx + dy * dy + dz * dz)
    dx /= L; dy /= L; dz /= L
    N = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    N /= np.linalg.norm(N, axis=-1, keepdims=True)
    I = np.stack([dx, dy, dz], -1)
    dn = (I * N).sum(-1, keepdims=True)
    R = I - 2 * dn * N
    R[..., 2] = np.abs(R[..., 2])
    R /= np.linalg.norm(R, axis=-1, keepdims=True)
    sky, _, _ = sky_rgb(R)
    cos = np.clip(-dn[..., 0], 0, 1)
    F = 0.02 + 0.98 * (1 - cos) ** 5
    F = np.clip(F * 1.15 + 0.08, 0, 1)[..., None]
    deep = np.array((0.035, 0.085, 0.11)) * (0.9 + 0.2 * n1[..., None])
    col = deep * (1 - F) + sky * F * 0.92
    # sparkle along the sun path
    gam = np.arccos(np.clip(R @ np.array(SUN), -1, 1))
    spark = (np.clip((n2 - 0.62) / 0.1, 0, 1) * np.exp(-gam / 0.06))[..., None]
    col = col + spark * np.array((1.0, 0.85, 0.6)) * 0.9
    return np.clip(col, 0, 1)


def mountain_tex(a0, a1, W_=512, H_=64):
    """Hazy silhouettes: horizon sky colour at each azimuth, darker at the foot."""
    az = np.linspace(a0, a1, W_)
    d = np.stack([np.cos(az), np.sin(az), np.full_like(az, 0.05)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    sky, ts, _ = sky_rgb(d)
    tone = np.array((0.30, 0.27, 0.40)) * (1 - ts[..., None]) + np.array((0.52, 0.34, 0.33)) * ts[..., None]
    base = sky * 0.45 + tone * 0.55
    v = np.linspace(0.55, 1.0, H_)[:, None, None]
    return np.clip(base[None, :, :] * v, 0, 1)


def flag_tex(size=512):
    h, w = size // 2 * 1, size
    h = int(size * 0.64)
    col = np.zeros((h, w, 3), np.float32) + np.array((0.55, 0.07, 0.06), np.float32)
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    cx, cy = w * 0.5, h * 0.5
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    ang = np.degrees(np.arctan2(yy - cy, xx - cx))
    claw = (r < h * 0.30) & (r > h * 0.12) & ~((ang > -25) & (ang < 25))      # pincer ring, jaws open to the right
    claw |= (np.abs(yy - cy) < h * 0.07) & (xx < cx - h * 0.2) & (xx > cx - h * 0.55)   # arm
    col[claw] = (0.93, 0.89, 0.80)
    n = fbm(h, w, 6, 10, 4, np.random.default_rng(3))
    col *= (0.85 + 0.25 * n)[..., None]
    return np.clip(col, 0, 1)


def window_glow_tex(size=256):
    """Lamplit cabin interior seen through glass: warm gradient, curtains at the sides."""
    v = np.linspace(0, 1, size)[:, None]
    u = np.linspace(0, 1, size)[None, :]
    col = np.array((0.78, 0.36, 0.14)) * (1 - v[..., None]) + np.array((1.0, 0.72, 0.42)) * v[..., None]
    glow = np.exp(-((u - 0.5) / 0.35) ** 2 - ((v - 0.55) / 0.5) ** 2)[..., None]
    col = col * (0.6 + 0.4 * glow)
    cur = np.clip((np.abs(u - 0.5) - 0.3) / 0.03, 0, 1)
    fold = 0.75 + 0.25 * np.sin(u * 90)
    curtain = np.array((0.42, 0.13, 0.08)) * fold[..., None] * (0.8 + 0.3 * v[..., None])
    col = col * (1 - cur[..., None]) + curtain * cur[..., None]
    return np.clip(np.broadcast_to(col, (size, size, 3)), 0, 1)


def lantern_glow_tex(size=128):
    v = np.linspace(0, 1, size)[:, None]
    u = np.linspace(0, 1, size)[None, :]
    g = np.exp(-((u - 0.5) / 0.28) ** 2 - ((v - 0.42) / 0.3) ** 2)[..., None]
    col = np.array((0.85, 0.40, 0.12)) * (1 - g) + np.array((1.0, 0.92, 0.68)) * g
    return np.clip(np.broadcast_to(col, (size, size, 3)), 0, 1)


def window_view_tex(size=256):
    """Dusk seen from inside the cabin: pink horizon, lavender sky, dark sea."""
    v = np.linspace(0, 1, size)[:, None, None]
    hz = 0.42
    sky = np.array((0.96, 0.62, 0.62)) * (1 - np.clip((v - hz) / (1 - hz), 0, 1)) + \
        np.array((0.38, 0.38, 0.62)) * np.clip((v - hz) / (1 - hz), 0, 1)
    sea = np.array((0.08, 0.13, 0.22)) * (1 - v / hz) + np.array((0.52, 0.42, 0.52)) * (v / hz) ** 3
    col = np.where(v > hz, sky, sea)
    streak = fbm(size, size, 64, 4, 2, np.random.default_rng(9))[..., None]
    col = np.where(v > hz, col, col * (0.85 + 0.3 * streak))
    return np.clip(np.broadcast_to(col, (size, size, 3)), 0, 1)


def chart_tex(rng, w=1024, h=768):
    """Sea chart: parchment, coastlines, rhumb lines from a compass rose, a dotted route."""
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    col = np.array((0.90, 0.83, 0.66), np.float32) * (0.88 + 0.18 * fbm(h, w, 6, 6, 4, rng))[..., None]
    n = fbm(h, w, 5, 7, 6, rng)
    land = n > 0.57
    col[land] *= np.array((0.95, 0.93, 0.78), np.float32)
    coast = (land ^ np.roll(land, 1, 0)) | (land ^ np.roll(land, 1, 1))
    hatch = (n > 0.52) & ~land & (((xx + yy) % 7) < 1.2)
    col[hatch] *= 0.82
    col[:, ::128] *= 0.8
    col[::128, :] *= 0.8
    cx, cy, r = w * 0.3, h * 0.36, 150.0
    dx, dy = xx - cx, yy - cy
    dist = np.sqrt(dx * dx + dy * dy)
    for k in range(16):
        th = k * math.pi / 8
        perp = np.abs(dx * math.sin(th) - dy * math.cos(th))
        along = dx * math.cos(th) + dy * math.sin(th)
        col[(perp < 0.7) & (along > 0)] *= 0.86                                   # rhumb line
        ln = r if k % 2 == 0 else r * 0.6
        col[(perp < 2.2 * (1 - np.clip(along / ln, 0, 1))) & (along > 0) & (along < ln)] *= 0.35   # rose point
    col[np.abs(dist - r * 0.66) < 1.2] *= 0.45
    col[np.abs(dist - r * 0.72) < 0.8] *= 0.55
    col[coast] *= 0.35
    for t in np.linspace(0, 1, 70):                                              # the route, in red ink
        px = w * (0.12 + 0.7 * t) + 60 * math.sin(t * 5)
        py = h * (0.82 - 0.6 * t) + 30 * math.sin(t * 9)
        col[(np.abs(xx - px) < 2.5) & (np.abs(yy - py) < 2.5)] = (0.55, 0.10, 0.07)
    ex, ey = w * 0.82 + 60 * math.sin(5), h * 0.22 + 30 * math.sin(9)
    for s in (1, -1):
        col[(np.abs((xx - ex) - s * (yy - ey)) < 2.5) & (np.abs(xx - ex) < 14)] = (0.55, 0.10, 0.07)
    edge = np.minimum(np.minimum(xx, w - xx), np.minimum(yy, h - yy))
    col *= (0.72 + 0.28 * np.clip(edge / 60, 0, 1))[..., None]
    return np.clip(col, 0, 1)


def rug_tex(rng, w=512, h=768):
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    col = np.zeros((h, w, 3), np.float32) + np.array((0.46, 0.09, 0.07), np.float32)
    gold = np.array((0.80, 0.60, 0.26), np.float32); navy = np.array((0.10, 0.12, 0.26), np.float32)
    d = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
    bord = d < 56
    col[bord] = navy
    col[bord & (((xx + yy) % 28 < 3) | ((xx - yy) % 28 < 3))] = gold * 0.8
    col[((d > 14) & (d < 19)) | ((d > 51) & (d < 56)) | ((d > 64) & (d < 68))] = gold
    u = (xx - w / 2) / (w * 0.26); v = (yy - h / 2) / (h * 0.2)
    e = u * u + v * v
    col[e < 1] = navy
    col[np.abs(e - 1) < 0.06] = gold
    col[(np.abs(u) + np.abs(v)) < 0.55] = (0.62, 0.18, 0.10)
    col[np.abs(np.abs(u) + np.abs(v) - 0.55) < 0.04] = gold
    wear = fbm(h, w, 8, 6, 5, rng)
    col *= (0.8 + 0.3 * wear)[..., None]
    col *= (0.93 + 0.07 * np.sin(xx * 2.1))[..., None]          # knotted pile
    return np.clip(col, 0, 1)


def globe_tex(rng, w=512, h=256):
    n = fbm(h, w, 4, 8, 6, rng)
    col = np.zeros((h, w, 3), np.float32) + np.array((0.34, 0.50, 0.50), np.float32)
    col[n > 0.55] = (0.78, 0.66, 0.44)
    col[:, ::32] *= 0.7
    col[::32, :] *= 0.7
    col *= (0.85 + 0.2 * fbm(h, w, 8, 8, 3, rng))[..., None]
    return np.clip(col * np.array((1.0, 0.95, 0.8)), 0, 1)


def tartan_tex(size=256):
    x = np.arange(size)
    a = ((x % 64) < 10) | (((x + 30) % 64) < 4)
    b = ((x % 64) < 10) | (((x + 30) % 64) < 4)
    col = np.zeros((size, size, 3), np.float32) + np.array((0.45, 0.10, 0.09), np.float32)
    col[a[None, :] & ~b[:, None]] = (0.12, 0.16, 0.30)
    col[b[:, None] & ~a[None, :]] = (0.12, 0.16, 0.30)
    col[a[None, :] & b[:, None]] = (0.08, 0.10, 0.18)
    col *= (0.9 + 0.1 * (((x[None, :] + x[:, None]) % 4) < 2))[..., None]
    return col


# ── The crew portrait, painted from the companions' own full-body renders ──
AV_DIR = os.environ.get('REXCLAW_AVATARS') or os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'avatars'))
CREW = [  # (file, height as a share of the canvas, centre x, feet row) — back row first
    ('Sal/Froggy.fullbody.png', 0.74, 240, 170),
    ('Leo/leo_fancy_suit.fullbody.png', 0.72, 790, 170),
    ('Eve/eve_doctors_coat.fullbody.png', 0.66, 318, 50),
    ('Ara/ara_casual_default.fullbody.png', 0.65, 712, 50),
    ('Rex/CaptainLobster.fullbody.png', 0.80, 512, 18),
]


def load_rgba(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def resize(a, nh):
    h, w = a.shape[:2]
    nw = max(1, int(round(w * nh / h)))
    ys = np.linspace(0, h - 1, nh); xs = np.linspace(0, w - 1, nw)
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, h - 1); x1 = np.minimum(x0 + 1, w - 1)
    fy = (ys - y0)[:, None, None]; fx = (xs - x0)[None, :, None]
    return (a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx) * (1 - fy) + (a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx) * fy


def blur(a, n=1):
    for _ in range(n):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return a


def paste(cv, im, cx, y0):
    """Alpha-over a premultiplied RGBA image, bottom-centre at (cx, y0)."""
    h, w = im.shape[:2]
    x0 = int(cx - w / 2)
    H, W_ = cv.shape[:2]
    xa, xb = max(0, x0), min(W_, x0 + w); ya, yb = max(0, y0), min(H, y0 + h)
    if xa >= xb or ya >= yb:
        return
    sub = im[ya - y0:yb - y0, xa - x0:xb - x0]
    cv[ya:yb, xa:xb] = cv[ya:yb, xa:xb] * (1 - sub[..., 3:4]) + sub[..., :3]


def crew_portrait(rng, w=1024, h=768):
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    v = yy / h
    # painted backdrop: the deck at dusk, a warm glow behind the group
    cv = np.array((0.30, 0.20, 0.24)) * (1 - v[..., None]) + np.array((0.52, 0.38, 0.46)) * v[..., None]
    deck = v < 0.3
    cv[deck] = (np.array((0.36, 0.22, 0.12)) * (0.7 + v[..., None] * 1.5))[deck]
    glow = np.exp(-(((xx - w / 2) / (w * 0.35)) ** 2 + ((yy - h * 0.55) / (h * 0.45)) ** 2))[..., None]
    cv = cv + glow * np.array((0.35, 0.22, 0.10))
    cv[(xx > w * 0.07) & (xx < w * 0.085) & (v > 0.28)] *= 0.55                 # a mast behind them
    cv *= (0.85 + 0.25 * fbm(h, w, 5, 5, 4, rng))[..., None]
    for fn, share, cx, feet in CREW:
        path = os.path.join(AV_DIR, fn)
        if not os.path.exists(path):
            log("portrait: missing", path)
            continue
        im = load_rgba(path)
        ys_, xs_ = np.where(im[..., 3] > 0.05)
        im = im[ys_.min():ys_.max() + 1, xs_.min():xs_.max() + 1].copy()
        im[..., :3] *= im[..., 3:4]                                               # premultiply
        im = resize(im, int(h * share))
        sh = np.zeros_like(im); sh[..., 3] = blur(im[..., 3], 6) * 0.5            # soft cast shadow
        paste(cv, sh, cx + 18, feet - 4)
        paste(cv, im, cx, feet)
    # oil-paint treatment: soften, posterise a touch, directional brush texture, varnish, weave
    cv = blur(cv, 2)
    cv = cv * 0.6 + (np.round(cv * 14) / 14) * 0.4
    strokes = fbm(h, w, 90, 18, 3, rng)
    cv *= (0.9 + 0.2 * strokes)[..., None]
    cv = cv * np.array((1.0, 0.9, 0.72)) * 0.9 + 0.025
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    cv *= (1 - 0.4 * np.clip(r - 0.35, 0, 1) ** 1.5)[..., None]
    cv *= (1 + 0.035 * np.sin(xx * 1.6) * np.sin(yy * 1.6))[..., None]
    return np.clip(cv, 0, 1)


def stripe_tex():
    w = 256
    col = np.zeros((4, w, 3), np.float32)
    for i in range(w):
        col[:, i] = (0.92, 0.90, 0.85) if (i // 32) % 2 == 0 else (0.62, 0.12, 0.10)
    return col


# ════════════════════════════════════════════════════════════════════════
# Blender images + materials
# ════════════════════════════════════════════════════════════════════════
def to_image(name, rgb, noncolor=False):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    if noncolor:
        img.colorspace_settings.name = 'Non-Color'
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def make_mat(name, color=(0.8, 0.8, 0.8), img=None, nrm=None, rough=0.8, metal=0.0,
             emis=None, emis_img=None, strength=1.0, spec=0.5, nrm_strength=1.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*srgb_to_lin(color), 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    if img is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if nrm is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = nrm
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = nrm_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emis is not None or emis_img is not None:
        if emis_img is not None:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = emis_img
            nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        else:
            bsdf.inputs['Emission Color'].default_value = (*srgb_to_lin(emis), 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return m


def srgb_to_lin(c):
    return tuple(((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c)


log("painting textures")
R2 = lambda s: np.random.default_rng(s)
deck_a, deck_n = plank_tex(R2(1), rows=8, base=(0.64, 0.50, 0.35), var=0.07, grain=0.30, dirt=0.35)
hull_a, hull_n = plank_tex(R2(2), rows=8, base=(0.19, 0.13, 0.09), var=0.10, grain=0.35, dirt=0.25)
bulw_a, bulw_n = plank_tex(R2(3), rows=8, base=(0.42, 0.29, 0.18), paint=(0.52, 0.14, 0.10), chip=0.62, dirt=0.25)
varn_a, varn_n = plank_tex(R2(4), size=512, rows=2, base=(0.45, 0.25, 0.12), var=0.05, grain=0.45, seam=0.85, joints=0, dirt=0.1, knots=2, nails=False)
cabin_a, cabin_n = plank_tex(R2(5), rows=12, base=(0.50, 0.33, 0.19), var=0.06, grain=0.4, joints=0, dirt=0.2, knots=3, nails=False)
door_a, door_n = plank_tex(R2(6), size=512, rows=6, base=(0.30, 0.17, 0.09), var=0.05, grain=0.4, joints=0, dirt=0.1, knots=1, nails=False)
navy_a, navy_n = plank_tex(R2(7), size=512, rows=4, base=(0.3, 0.2, 0.12), paint=(0.11, 0.16, 0.28), chip=0.72, joints=0, dirt=0.15, nails=False)
crate_a, crate_n = plank_tex(R2(8), size=512, rows=5, base=(0.68, 0.54, 0.36), var=0.09, grain=0.35, joints=0, dirt=0.3, knots=3)
barrel_a, barrel_n = plank_tex(R2(9), size=512, rows=8, base=(0.46, 0.30, 0.17), var=0.10, grain=0.4, joints=0, dirt=0.3, knots=2, nails=False)
pier_a, pier_n = plank_tex(R2(10), rows=8, base=(0.50, 0.46, 0.40), var=0.09, grain=0.4, dirt=0.4)
stone_a, stone_n = stone_tex(R2(12))
grass = noise_tex(R2(13), 512, (0.22, 0.30, 0.13), (0.36, 0.34, 0.20), ch=6, contrast=1.8)
terra = roof_tex(R2(14))
slate = roof_tex(R2(15), base=(0.30, 0.32, 0.38), slate=True)
lit_mask = RNG.random((4, 4)) < 0.42
facades = [facade_tex(R2(20 + i), p, s, lit_mask) for i, (p, s) in enumerate([
    ((0.93, 0.88, 0.76), (0.20, 0.36, 0.42)),
    ((0.90, 0.72, 0.50), (0.22, 0.30, 0.20)),
    ((0.74, 0.80, 0.84), (0.55, 0.22, 0.16)),
    ((0.90, 0.66, 0.60), (0.20, 0.26, 0.40)),
    ((0.96, 0.95, 0.90), (0.18, 0.34, 0.56)),
])]
facade_em = facade_emissive(lit_mask)
log("painting sky + water")
sky_a = sky_tex()
water_a = water_tex()
MTN_A0, MTN_A1 = math.radians(-110), math.radians(95)
mtn_a = mountain_tex(MTN_A0, MTN_A1)

I = to_image
M = {}
M['deck'] = make_mat('Deck', img=I('deck', deck_a), nrm=I('deck_n', deck_n, True), rough=0.85)
M['hull'] = make_mat('Hull', img=I('hull', hull_a), nrm=I('hull_n', hull_n, True), rough=0.7)
M['bulwark'] = make_mat('BulwarkPaint', img=I('bulwark', bulw_a), nrm=I('bulwark_n', bulw_n, True), rough=0.75)
M['varnish'] = make_mat('Varnish', img=I('varnish', varn_a), nrm=I('varnish_n', varn_n, True), rough=0.45)
M['cabin'] = make_mat('CabinBoards', img=I('cabin', cabin_a), nrm=I('cabin_n', cabin_n, True), rough=0.6)
M['door'] = make_mat('DarkWood', img=I('door', door_a), nrm=I('door_n', door_n, True), rough=0.5)
M['navy'] = make_mat('NavyPaint', img=I('navy', navy_a), nrm=I('navy_n', navy_n, True), rough=0.6)
M['crate'] = make_mat('Crate', img=I('crate', crate_a), nrm=I('crate_n', crate_n, True), rough=0.85)
M['barrel'] = make_mat('Barrel', img=I('barrel', barrel_a), nrm=I('barrel_n', barrel_n, True), rough=0.7)
M['pier'] = make_mat('Pier', img=I('pier', pier_a), nrm=I('pier_n', pier_n, True), rough=0.9)
M['stone'] = make_mat('Stone', img=I('stone', stone_a), nrm=I('stone_n', stone_n, True), rough=0.9)
M['grass'] = make_mat('Grass', img=I('grass', grass), rough=0.95)
M['terracotta'] = make_mat('RoofTerracotta', img=I('terracotta', terra), rough=0.8)
M['slate'] = make_mat('RoofSlate', img=I('slate', slate), rough=0.7)
fem = I('facade_em', facade_em)
for i, fa in enumerate(facades):
    M[f'facade{i}'] = make_mat(f'Facade{i}', img=I(f'facade{i}', fa), emis_img=fem, strength=1.0, rough=0.9)
M['algae'] = make_mat('WaterlineWeed', img=I('algae', noise_tex(R2(16), 256, (0.05, 0.07, 0.05), (0.16, 0.18, 0.11), ch=10, contrast=1.6)), rough=0.4)
M['ochre'] = make_mat('OchrePaint', color=(0.56, 0.40, 0.19), rough=0.6)
M['gold'] = make_mat('Gilt', color=(0.78, 0.58, 0.26), rough=0.3, emis=(0.9, 0.7, 0.32), strength=0.06)
M['brass'] = make_mat('Brass', color=(0.78, 0.58, 0.28), rough=0.35)
M['iron'] = make_mat('Iron', color=(0.08, 0.08, 0.085), rough=0.55)
M['glass_warm'] = make_mat('WindowGlow', color=(0.04, 0.03, 0.02), emis_img=I('window_glow', window_glow_tex()), strength=1.0, rough=0.15, spec=1.0)
M['lantern'] = make_mat('LanternGlow', color=(0.05, 0.04, 0.02), emis_img=I('lantern_glow', lantern_glow_tex()), strength=1.0, rough=0.15, spec=1.0)
M['beacon'] = make_mat('BeaconGlow', color=(1.0, 0.95, 0.8), emis=(1.0, 0.92, 0.7), strength=1.5)
M['glow_green'] = make_mat('InstrumentGlow', color=(0.4, 1.0, 0.7), emis=(0.30, 0.85, 0.55), strength=0.9)
M['rope'] = make_mat('Rope', color=(0.58, 0.46, 0.31), rough=0.95)
M['sail'] = make_mat('Sailcloth', color=(0.88, 0.83, 0.71), rough=0.95)
M['green'] = make_mat('Foliage', color=(0.22, 0.38, 0.16), rough=0.9)
M['tree'] = make_mat('TreeFoliage', color=(0.13, 0.22, 0.12), rough=0.95)
M['pot'] = make_mat('Terracotta', color=(0.64, 0.34, 0.21), rough=0.85)
M['bottle_g'] = make_mat('BottleGreen', color=(0.14, 0.34, 0.20), rough=0.12, spec=1.0)
M['bottle_a'] = make_mat('BottleAmber', color=(0.50, 0.28, 0.08), rough=0.12, spec=1.0)
M['cork'] = make_mat('Cork', color=(0.66, 0.50, 0.32), rough=0.9)
M['parchment'] = make_mat('Parchment', color=(0.92, 0.86, 0.70), rough=0.9)
M['ceramic'] = make_mat('Ceramic', color=(0.86, 0.90, 0.94), rough=0.25)
M['stencil'] = make_mat('Stencil', color=(0.10, 0.08, 0.07), rough=0.9)
M['flag'] = make_mat('Flag', img=I('flag', flag_tex()), rough=0.95)
M['stripes'] = make_mat('LighthouseStripes', img=I('stripes', stripe_tex()), rough=0.8)
M['dark'] = make_mat('Void', color=(0.02, 0.02, 0.02), rough=1.0, spec=0.0)
# captain's cabin
M['glass_clear'] = make_mat('DoorGlass', color=(0.10, 0.12, 0.14), rough=0.05, spec=1.0)
M['glass_view'] = make_mat('WindowView', color=(0.02, 0.02, 0.03), emis_img=I('window_view', window_view_tex()), strength=1.0, rough=0.1, spec=1.0)
M['chart'] = make_mat('Chart', img=I('chart', chart_tex(R2(30))), rough=0.9)
M['rug'] = make_mat('Rug', img=I('rug', rug_tex(R2(31))), rough=1.0, spec=0.2)
M['portrait'] = make_mat('CrewPortrait', img=I('portrait', crew_portrait(R2(32))), rough=0.35)
M['globe'] = make_mat('Globe', img=I('globe', globe_tex(R2(33))), rough=0.4)
M['blanket'] = make_mat('Blanket', img=I('tartan', tartan_tex()), rough=0.95)
M['leather_r'] = make_mat('LeatherRed', color=(0.42, 0.12, 0.09), rough=0.5)
M['leather_g'] = make_mat('LeatherGreen', color=(0.14, 0.26, 0.17), rough=0.5)
M['leather_b'] = make_mat('LeatherBlue', color=(0.13, 0.17, 0.32), rough=0.5)
M['leather_t'] = make_mat('LeatherTan', color=(0.55, 0.36, 0.20), rough=0.5)
M['cushion'] = make_mat('Velvet', color=(0.45, 0.09, 0.12), rough=0.8)
M['hat'] = make_mat('HatFelt', color=(0.07, 0.06, 0.06), rough=0.9)
M['sky'] = make_mat('Sky', color=(0, 0, 0), emis_img=I('sky', sky_a), strength=1.0, rough=1.0, spec=0.0)
M['water'] = make_mat('Water', color=(0, 0, 0), emis_img=I('water', water_a), strength=1.0, rough=1.0, spec=0.0)
M['mountain'] = make_mat('Mountains', color=(0, 0, 0), emis_img=I('mountains', mtn_a), strength=1.0, rough=1.0, spec=0.0)


# ════════════════════════════════════════════════════════════════════════
# Mesh accumulation
# ════════════════════════════════════════════════════════════════════════
XF = [Matrix.Identity(4)]           # transform stack for props placed as groups


class MB:
    def __init__(self, key):
        self.key = key; self.v = []; self.f = []; self.uv = []; self.sm = []

    def tx(self, p):
        return XF[-1] @ Vector(p)

    def face(self, pts, uvs, smooth=False):
        base = len(self.v)
        self.v.extend(self.tx(p) for p in pts)
        self.f.append(tuple(range(base, base + len(pts))))
        self.uv.append(list(uvs)); self.sm.append(smooth)

    def grid(self, P, UV, smooth=True):
        R = len(P); C = len(P[0]); base = len(self.v)
        for row in P:
            self.v.extend(self.tx(p) for p in row)
        for i in range(R - 1):
            for j in range(C - 1):
                a = base + i * C + j
                self.f.append((a, a + 1, a + C + 1, a + C))
                self.uv.append([UV[i][j], UV[i][j + 1], UV[i + 1][j + 1], UV[i + 1][j]])
                self.sm.append(smooth)


MBS = {}
UVFIT = {'glass_warm', 'lantern', 'glass_view', 'portrait', 'chart', 'rug'}   # painted per panel: map each face to 0..1


def mb(key):
    if key not in MBS:
        MBS[key] = MB(key)
    return MBS[key]


class place:
    """with place(pos, yaw): ... — props built in local coords."""
    def __init__(self, pos=(0, 0, 0), yaw=0.0, scale=1.0):
        self.m = Matrix.Translation(Vector(pos)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)

    def __enter__(self):
        XF.append(XF[-1] @ self.m)

    def __exit__(self, *a):
        XF.pop()


def box(key, c, size, R=None, grain=None, tile=2.0):
    m = mb(key)
    c = Vector(c)
    R = R if R is not None else Matrix.Identity(3)
    hs = [s / 2 for s in size]
    fit = key in UVFIT
    if grain is None:
        grain = 0 if fit else max(range(3), key=lambda k: size[k])
    off = (random.random() * tile, random.random() * tile)
    ax = [R.col[k] for k in range(3)]
    for k in range(3):
        for sgn in (-1, 1):
            i, j = [a for a in range(3) if a != k]
            loc = []
            for si, sj in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                l = [0.0, 0.0, 0.0]; l[k] = sgn * hs[k]; l[i] = si * hs[i]; l[j] = sj * hs[j]
                loc.append(l)
            e1 = Vector(loc[1]) - Vector(loc[0]); e2 = Vector(loc[2]) - Vector(loc[1])
            nrm = e1.cross(e2)
            if nrm[k] * sgn < 0:
                loc = loc[::-1]
            if grain in (i, j):
                ua, va = grain, (j if grain == i else i)
            else:
                ua, va = i, j
            pts = [c + ax[0] * l[0] + ax[1] * l[1] + ax[2] * l[2] for l in loc]
            if fit:
                uvs = [((l[ua] + hs[ua]) / size[ua], (l[va] + hs[va]) / size[va]) for l in loc]
            else:
                uvs = [((l[ua] + off[0]) / tile, (l[va] + off[1]) / tile) for l in loc]
            m.face(pts, uvs)


def basis_from(d, up=(0, 0, 1)):
    x = Vector(d).normalized(); u = Vector(up)
    if abs(x.dot(u)) > 0.99:
        u = Vector((1, 0, 0)) if abs(x.x) < 0.9 else Vector((0, 1, 0))
    y = u.cross(x).normalized(); z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def beam(key, p1, p2, w, h, up=(0, 0, 1), tile=2.0):
    p1 = Vector(p1); p2 = Vector(p2)
    box(key, (p1 + p2) / 2, ((p2 - p1).length, w, h), basis_from(p2 - p1, up), grain=0, tile=tile)


def lathe(key, prof, base=(0, 0, 0), axis=(0, 0, 1), segs=16, tile=1.0, capb=False, capt=False,
          smooth=True, phase=0.0):
    m = mb(key)
    base = Vector(base); ax = Vector(axis).normalized()
    e1 = ax.orthogonal().normalized(); e2 = ax.cross(e1)
    rmax = max(r for r, _ in prof) or 0.01
    P = []; UV = []; s = 0.0
    for idx, (r, h) in enumerate(prof):
        if idx:
            s += math.hypot(r - prof[idx - 1][0], h - prof[idx - 1][1])
        row = []; uvr = []
        for j in range(segs + 1):
            a = 2 * math.pi * j / segs + phase
            row.append(base + ax * h + (e1 * math.cos(a) + e2 * math.sin(a)) * r)
            uvr.append((s / tile, 2 * math.pi * rmax * j / segs / tile))
        P.append(row); UV.append(uvr)
    m.grid(P, UV, smooth)
    for cap, idx in ((capb, 0), (capt, len(prof) - 1)):
        if cap and prof[idx][0] > 1e-4:
            ring = P[idx][:segs]
            r = prof[idx][0]
            uvs = [(0.5 + 0.5 * math.cos(2 * math.pi * j / segs), 0.5 + 0.5 * math.sin(2 * math.pi * j / segs)) for j in range(segs)]
            if idx == 0:
                ring = ring[::-1]; uvs = uvs[::-1]
            m.face(ring, uvs)


def tube(key, p1, p2, r1, r2=None, segs=8, caps=False, tile=1.0, smooth=True):
    p1 = Vector(p1); p2 = Vector(p2)
    L = (p2 - p1).length
    if L < 1e-6:
        return
    lathe(key, [(r1, 0), (r2 if r2 is not None else r1, L)], p1, p2 - p1, segs, tile, caps, caps, smooth)


def rope(key, pts, r, segs=5):
    for a, b in zip(pts[:-1], pts[1:]):
        tube(key, a, b, r, r, segs)


def sag(p1, p2, amount, n=10):
    p1 = Vector(p1); p2 = Vector(p2)
    return [p1.lerp(p2, t / n) - Vector((0, 0, amount * 4 * (t / n) * (1 - t / n))) for t in range(n + 1)]


def sphere(key, c, r, segs=10, rings=6, sz=1.0):
    prof = [(r * math.sin(math.pi * k / rings), -r * sz * math.cos(math.pi * k / rings)) for k in range(rings + 1)]
    lathe(key, prof, c, (0, 0, 1), segs)


def circle(c, r, n=24, z=0.0):
    c = Vector(c)
    return [c + Vector((r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z)) for k in range(n + 1)]


def text_mesh(key, s, size, center, R, depth=0.004, font_bold=True):
    cu = bpy.data.curves.new('txt', 'FONT')
    cu.body = s; cu.size = size; cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
    cu.extrude = depth
    ob = bpy.data.objects.new('txt', cu)
    SCN.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    m = mb(key); c = Vector(center)
    for poly in me.polygons:
        pts = [c + R @ me.vertices[i].co for i in poly.vertices]
        m.face(pts, [(0, 0)] * len(pts))
    bpy.data.objects.remove(ob); bpy.data.curves.remove(cu); bpy.data.meshes.remove(me)


# Rotations for text on walls
R_FACE_NEG_Y = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))     # reads from -Y
R_FACE_POS_Y = Matrix(((-1, 0, 0), (0, 0, 1), (0, 1, 0)))     # reads from +Y

# ════════════════════════════════════════════════════════════════════════
# The ship
# ════════════════════════════════════════════════════════════════════════
log("building hull")


def hull(outer_key, y0, y1, hwf, topf, step=0.25, keel=-4.4, tile=2.0, transom_key=None):
    ys = list(np.arange(y0, y1, step)) + [y1]
    below = [-0.5, -1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.0]
    P = []; UV = []
    for y in ys:
        t = topf(y); w = hwf(y)
        zs = [t * (1 - k / 10) for k in range(11)] + below
        star = [(w * tf(z), y, z) for z in zs] + [(0.0, y, keel)]
        port = [(-x, yy, z) for x, yy, z in reversed(star[:-1])]
        prof = star + port
        s = [0.0]
        for a, b in zip(prof[:-1], prof[1:]):
            s.append(s[-1] + math.hypot(b[0] - a[0], b[2] - a[2]))
        P.append([Vector(p) for p in prof])
        UV.append([(y / tile, sv / tile) for sv in s])
    mb(outer_key).grid(P, UV, smooth=True)
    if transom_key:
        ring = P[-1]
        mb(transom_key).face(ring, [(p.x / tile, p.z / tile) for p in ring])
    return ys


ys = hull('hull', BOW_Y, STERN_Y, hw, top, transom_key='hull')

# inner bulwark + rail cap + wales
yin = [y for y in ys if hw(y) > 0.7]
for sgn in (1, -1):
    P = []; UV = []; C = []; CUV = []; Wl = {0.15: ([], []), -0.9: ([], []), WATER_Z: ([], [])}
    for y in yin:
        t = top(y)
        zs = [t * k / 6 for k in range(7)]
        row = [Vector((sgn * xi(y, z), y, z)) for z in zs]
        if sgn < 0:
            row = row[::-1]
        P.append(row); UV.append([(y / 2, p.z / 2) for p in row])
        xo = hw(y) * tf(t) + 0.06; xin = xi(y, t) - 0.05
        cap = [(xo, t - 0.06), (xo, t + 0.07), (xin, t + 0.07), (xin, t - 0.02)]
        crow = [Vector((sgn * x, y, z)) for x, z in cap]
        if sgn < 0:
            crow = crow[::-1]
        C.append(crow); CUV.append([(y / 1.0, k * 0.1) for k in range(4)])
        for zw, (WP, WU) in Wl.items():
            x = hw(y) * tf(zw)
            if zw == WATER_Z:          # wet, weedy band where the hull meets the water
                wp = [(x - 0.01, zw - 0.2), (x + 0.015, zw - 0.1), (x + 0.015, zw + 0.3), (hw(y) * tf(zw + 0.42), zw + 0.42)]
            else:
                wp = [(x, zw - 0.09), (x + 0.06, zw - 0.045), (x + 0.06, zw + 0.045), (x, zw + 0.09)]
            wr = [Vector((sgn * a, y, b)) for a, b in wp]
            if sgn < 0:
                wr = wr[::-1]
            WP.append(wr); WU.append([(y / 2, k * 0.05) for k in range(4)])
    mb('bulwark').grid(P, UV, smooth=False)
    mb('varnish').grid(C, CUV, smooth=True)
    for zw, (WP, WU) in Wl.items():
        mb('algae' if zw == WATER_Z else 'ochre').grid(WP, WU, smooth=True)


def deck(key, y0, y1, z, n=6, step=0.25):
    yy = list(np.arange(y0, y1, step)) + [y1]
    P = []; UV = []
    for y in yy:
        x = xi(y, z) + 0.02
        row = [Vector((-x + 2 * x * k / n, y, z)) for k in range(n + 1)]
        P.append(row); UV.append([(y / 2, p.x / 2) for p in row])
    mb(key).grid(P, UV, smooth=False)


deck('deck', FC_Y, BULK_Y + 0.05, 0.0)
deck('deck', BULK_Y, STERN_Y, QD)
deck('deck', BOW_Y + 1.2, FC_Y, FC_Z)

# stanchions along the inner bulwark
for sgn in (1, -1):
    for y in list(np.arange(-12.6, 3.4, 1.2)) + list(np.arange(5.4, 12.0, 1.2)):
        z0 = QD if y > BULK_Y else 0.0
        t = top(y)
        x = sgn * (xi(y, (z0 + t) / 2) - 0.05)
        box('bulwark', (x, y, (z0 + t) / 2), (0.1, 0.12, t - z0), grain=2)

# bulkhead (the backdrop) ----------------------------------------------------
log("building cabin front")
XB = xi(BULK_Y, 0) + 0.02
F = BULK_Y            # front face plane
DW, DH = 0.68, 1.98   # doorway half-width / height into the captain's cabin
for sgn in (-1, 1):
    box('cabin', (sgn * (XB + DW) / 2, F + 0.06, QD / 2), (XB - DW, 0.12, QD), grain=2)
    box('varnish', (sgn * (DW + 0.01), F + 0.06, DH / 2), (0.02, 0.12, DH), grain=2)   # jamb lining
box('cabin', (0, F + 0.06, (DH + QD) / 2), (2 * DW, 0.12, QD - DH), grain=2)
box('varnish', (0, F + 0.06, DH - 0.01), (2 * DW, 0.12, 0.02), grain=0)
box('varnish', (0, F - 0.03, QD + 0.02), (2 * XB, 0.12, 0.16), grain=0)       # deck edge fascia
box('navy', (0, F - 0.02, QD - 0.13), (2 * XB, 0.07, 0.08), grain=0)          # molding
box('navy', (0, F - 0.015, 0.07), (2 * XB, 0.05, 0.14), grain=0)             # skirting
for x in (-2.85, -1.4, 1.4, 2.85):
    box('navy', (x, F - 0.035, (QD - 0.2) / 2 + 0.05), (0.16, 0.07, QD - 0.3), grain=2)
    box('navy', (x, F - 0.05, QD - 0.25), (0.24, 0.1, 0.08))
    box('navy', (x, F - 0.05, 0.12), (0.22, 0.1, 0.12))

# captain's cabin door (double, glazed upper panels) — both leaves swung open
# inward on their hinges so the cabin shows behind the companion
for x in (-0.74, 0.74):
    box('varnish', (x, F - 0.05, 1.0), (0.12, 0.1, 2.0), grain=2)
box('varnish', (0, F - 0.05, 2.04), (1.6, 0.12, 0.12), grain=0)
box('varnish', (0, F + 0.03, 0.015), (1.4, 0.2, 0.03), grain=0)                  # threshold
DOOR_OPEN = math.radians(97)
for side in (-1, 1):
    hinge = Vector((side * (DW - 0.01), F + 0.13, 0))
    with place(hinge, -side * DOOR_OPEN):
        # built as if closed, relative to the hinge (leaf runs toward the centre)
        def at(x, y, z):
            return (x - hinge.x, y - hinge.y, z)
        cx = side * 0.34
        box('door', at(cx, F + 0.1, 0.99), (0.66, 0.04, 1.96), grain=2, tile=1.0)
        box('glass_clear', at(cx, F + 0.1, 1.42), (0.46, 0.05, 0.62))
        for fy in (F + 0.07, F + 0.13):           # panels both faces
            box('door', at(cx, fy, 0.5), (0.48, 0.03, 0.62), grain=2, tile=1.0)
            for gx in (-0.08, 0.08):
                box('door', at(cx + gx, fy, 1.42), (0.025, 0.03, 0.62))
            box('door', at(cx, fy, 1.42), (0.46, 0.03, 0.025))
            for dz in (1.11, 1.73):
                box('door', at(cx, fy, dz), (0.52, 0.035, 0.05))
            for dx in (-0.25, 0.25):
                box('door', at(cx + dx, fy, 1.42), (0.05, 0.035, 0.66))
        for fy in (F + 0.05, F + 0.15):
            sphere('brass', at(side * 0.07, fy, 1.0), 0.03)
        tube('brass', at(side * 0.07, F + 0.05, 1.0), at(side * 0.07, F + 0.15, 1.0), 0.01, segs=6)
        for hz in (0.3, 1.7):                                                       # strap hinges
            box('iron', at(side * 0.55, F + 0.075, hz), (0.22, 0.012, 0.04))
    for hz in (0.3, 1.7):
        tube('iron', hinge + Vector((0, 0, hz - 0.06)), hinge + Vector((0, 0, hz + 0.06)), 0.018, segs=6, caps=True)

# nameboard REXMAW
box('navy', (0, F - 0.03, 2.28), (1.76, 0.05, 0.3), grain=0)
for z in (2.14, 2.42):
    box('gold', (0, F - 0.058, z), (1.8, 0.012, 0.022))
for x in (-0.89, 0.89):
    box('gold', (x, F - 0.058, 2.28), (0.022, 0.012, 0.3))
text_mesh('gold', "REXMAW", 0.19, (0, F - 0.056, 2.275), R_FACE_NEG_Y, depth=0.005)

# windows either side
for side in (-1, 1):
    cx = side * 2.12
    for (a, b, w_, h_) in ((cx, 0.95, 0.94, 0.08), (cx, 1.77, 0.94, 0.08)):
        box('varnish', (a, F - 0.05, b), (w_, 0.1, h_), grain=0, tile=1.0)
    for x in (cx - 0.43, cx + 0.43):
        box('varnish', (x, F - 0.05, 1.36), (0.08, 0.1, 0.9), grain=2, tile=1.0)
    box('glass_warm', (cx, F - 0.015, 1.36), (0.8, 0.02, 0.76))
    box('door', (cx, F - 0.035, 1.36), (0.03, 0.03, 0.76))
    box('door', (cx, F - 0.035, 1.46), (0.8, 0.03, 0.03))
    box('varnish', (cx, F - 0.12, 0.9), (1.04, 0.22, 0.05), grain=0, tile=1.0)       # sill
    for x in (cx - 0.4, cx + 0.4):
        beam('varnish', (x, F - 0.02, 0.72), (x, F - 0.2, 0.88), 0.04, 0.04)
# herb box under the starboard window (Ara's)
box('pot', (2.12, F - 0.14, 0.99), (0.72, 0.17, 0.14))
for k in range(9):
    x = 2.12 - 0.3 + 0.075 * k
    sphere('green', (x + random.uniform(-0.02, 0.02), F - 0.14 + random.uniform(-0.03, 0.03), 1.08 + random.uniform(0, 0.05)),
           random.uniform(0.06, 0.09), segs=7, rings=5, sz=1.2)


def lantern(c, s=1.0):
    """Hanging ship lantern; c = centre of the glass."""
    c = Vector(c)
    with place(c, 0.0, s):
        box('lantern', (0, 0, 0), (0.12, 0.12, 0.2))
        for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            box('iron', (dx * 0.07, dy * 0.07, 0), (0.018, 0.018, 0.24))
        for z in (-0.06, 0.06):
            box('iron', (0, 0, z), (0.15, 0.15, 0.01))
        box('iron', (0, 0, -0.125), (0.17, 0.17, 0.03))
        lathe('iron', [(0.12, 0), (0.035, 0.09), (0.02, 0.1)], (0, 0, 0.12), segs=4, phase=math.pi / 4, capb=True, smooth=False)
        lathe('iron', [(0.035, 0), (0.035, 0.012), (0.012, 0.03), (0.035, 0.05), (0.035, 0.06)], (0, 0, 0.22), segs=8)


for x in (-1.05, 1.05):
    beam('iron', (x, F, 2.0), (x, F - 0.34, 2.0), 0.03, 0.03)
    beam('iron', (x, F, 1.84), (x, F - 0.2, 2.0), 0.02, 0.02)
    tube('iron', (x, F - 0.32, 2.0), (x, F - 0.32, 1.9), 0.006, segs=4)
    lantern((x, F - 0.32, 1.72))

# bench under the port window, tea + charts on it
BX = -2.12
box('varnish', (BX, F - 0.26, 0.45), (1.1, 0.38, 0.05), grain=0, tile=1.0)
for dx in (-0.48, 0.48):
    for dy in (-0.14, 0.14):
        box('varnish', (BX + dx, F - 0.26 + dy, 0.21), (0.05, 0.05, 0.43), grain=2)
    box('varnish', (BX + dx, F - 0.26, 0.1), (0.05, 0.3, 0.04), grain=1)


def teapot(c):
    with place(c, 0.4):
        lathe('ceramic', [(0.0, 0), (0.06, 0.0), (0.085, 0.03), (0.092, 0.07), (0.08, 0.11), (0.05, 0.13),
                          (0.035, 0.135), (0.035, 0.145), (0.012, 0.16), (0.0, 0.165)], (0, 0, 0), segs=14)
        rope('ceramic', [(0.07, 0, 0.06), (0.12, 0, 0.09), (0.15, 0, 0.14)], 0.012)
        rope('ceramic', [(-0.075, 0, 0.1), (-0.12, 0, 0.1), (-0.13, 0, 0.06), (-0.085, 0, 0.035)], 0.01)


def cup(c):
    lathe('ceramic', [(0.0, 0), (0.025, 0), (0.035, 0.05), (0.032, 0.05), (0.022, 0.006), (0, 0.006)], c, segs=12)


teapot((BX + 0.3, F - 0.24, 0.475))
cup((BX + 0.1, F - 0.14, 0.475))
cup((BX + 0.05, F - 0.33, 0.475))
tube('parchment', (BX - 0.45, F - 0.3, 0.515), (BX - 0.02, F - 0.26, 0.515), 0.04, segs=10, caps=True)
tube('parchment', (BX - 0.42, F - 0.16, 0.51), (BX - 0.1, F - 0.2, 0.51), 0.035, segs=10, caps=True)
box('parchment', (BX - 0.2, F - 0.2, 0.478), (0.36, 0.28, 0.004), R=Matrix.Rotation(0.2, 3, 'Z'))

# quarterdeck front rail ----------------------------------------------------
log("rails, stairs, masts")
BAL = [(0.03, 0), (0.045, 0.08), (0.026, 0.22), (0.05, 0.45), (0.026, 0.68), (0.04, 0.78), (0.04, 0.84)]
RX = 2.95
xs = np.arange(-RX + 0.1, RX - 0.05, 0.2)
for x in xs:
    if abs(x) < 0.02:
        continue
    lathe('varnish', BAL, (x, F + 0.04, QD + 0.1), segs=8, tile=0.5)
beam('varnish', (-RX, F + 0.04, QD + 0.98), (RX, F + 0.04, QD + 0.98), 0.12, 0.08)
beam('varnish', (-RX, F + 0.04, QD + 0.12), (RX, F + 0.04, QD + 0.12), 0.1, 0.05)
for x in (-RX, -1.0, 1.0, RX):
    box('varnish', (x, F + 0.04, QD + 0.52), (0.14, 0.14, 1.04), grain=2)
    sphere('brass', (x, F + 0.04, QD + 1.1), 0.065)

# stairs up to the quarterdeck, both sides
Y0S = 1.9
for sgn in (1, -1):
    cx = sgn * 3.45
    for i in range(12):
        box('deck', (cx, Y0S + 0.2 * i + 0.1, 0.2 * (i + 1) - 0.025), (0.86, 0.26, 0.05), grain=0)
    for xx in (cx - 0.46, cx + 0.46):
        beam('varnish', (xx, Y0S - 0.05, 0.06), (xx, F + 0.05, QD - 0.05), 0.06, 0.28, up=(1, 0, 0))
    hx = cx - sgn * 0.47
    box('varnish', (hx, Y0S + 0.05, 0.52), (0.08, 0.08, 1.04), grain=2)
    sphere('brass', (hx, Y0S + 0.05, 1.08), 0.045)
    beam('varnish', (hx, Y0S + 0.05, 1.02), (hx, F + 0.05, QD + 1.0), 0.06, 0.06)
    for k in range(1, 6):
        t = k / 6
        yb = Y0S + 0.05 + t * (F - Y0S)
        tube('varnish', (hx, yb, 0.2 * (yb - Y0S) / 0.2 + 0.05), (hx, yb, 0.2 * (yb - Y0S) / 0.2 + 0.95 - 0.0), 0.02, segs=6)

# helm + binnacle on the quarterdeck ----------------------------------------
HY = 7.0
box('door', (0, HY + 0.1, QD + 0.5), (0.34, 0.3, 1.0), grain=2, tile=1.0)
box('varnish', (0, HY + 0.1, QD + 1.02), (0.4, 0.36, 0.06))
WZ = QD + 1.12
wc = Vector((0, HY - 0.12, WZ))
ring = [wc + Vector((0.62 * math.cos(a), 0, 0.62 * math.sin(a))) for a in np.linspace(0, 2 * math.pi, 29)]
rope('varnish', ring, 0.04, segs=6)
ring2 = [wc + Vector((0.5 * math.cos(a), 0, 0.5 * math.sin(a))) for a in np.linspace(0, 2 * math.pi, 25)]
rope('varnish', ring2, 0.022, segs=5)
tube('brass', wc + Vector((0, -0.07, 0)), wc + Vector((0, 0.07, 0)), 0.11, segs=12, caps=True)
tube('door', wc + Vector((0, 0.07, 0)), wc + Vector((0, 0.3, 0)), 0.05, segs=8)
for k in range(8):
    a = k * math.pi / 4
    d = Vector((math.cos(a), 0, math.sin(a)))
    tube('varnish', wc + d * 0.1, wc + d * 0.64, 0.022, 0.018, segs=6)
    lathe('varnish', [(0.02, 0), (0.03, 0.05), (0.02, 0.1), (0.03, 0.16), (0.0, 0.2)], wc + d * 0.64, d, segs=6)
lathe('door', [(0.16, 0), (0.12, 0.1), (0.1, 0.8), (0.18, 0.86), (0.18, 0.95)], (0, HY - 1.0, QD), segs=8)
lathe('brass', [(0.17, 0), (0.17, 0.05), (0.15, 0.14), (0.08, 0.22), (0.0, 0.25)], (0, HY - 1.0, QD + 0.95), segs=14)

# Sal's positioning rig (brass box, green dial, whip antenna)
with place((1.35, HY - 0.9, QD), -0.35):
    box('door', (0, 0, 0.45), (0.5, 0.36, 0.9), grain=2, tile=1.0)
    for z in (0.02, 0.88):
        box('brass', (0, 0, z), (0.54, 0.4, 0.04))
    lathe('glow_green', [(0, 0), (0.12, 0), (0.12, 0.01)], (0, -0.19, 0.6), (0, -1, 0), segs=20)
    lathe('brass', [(0.12, 0), (0.14, 0.0), (0.14, 0.025), (0.12, 0.025)], (0, -0.18, 0.6), (0, -1, 0), segs=20)
    for k in range(3):
        sphere('lantern', (-0.15 + 0.15 * k, -0.19, 0.3), 0.02, segs=6, rings=4)
    tube('iron', (0.18, 0.1, 0.9), (0.18, 0.1, 2.1), 0.012, 0.006, segs=5)
    sphere('lantern', (0.18, 0.1, 2.12), 0.025, segs=6, rings=4)

# ship's bell on a little frame on the port side of the rail
BELL = Vector((-2.2, F + 0.3, QD + 1.0))
for dx in (-0.25, 0.25):
    box('varnish', BELL + Vector((dx, 0, 0.35)), (0.07, 0.07, 0.7 + 0.0), grain=2)
box('varnish', BELL + Vector((0, 0, 0.72)), (0.62, 0.09, 0.09), grain=0)
lathe('brass', [(0.0, 0), (0.12, 0), (0.115, 0.02), (0.085, 0.1), (0.07, 0.2), (0.04, 0.24), (0.0, 0.25)],
      BELL + Vector((0, 0, 0.42)), segs=16)
tube('brass', BELL + Vector((0, 0, 0.67)), BELL + Vector((0, 0, 0.72)), 0.015, segs=6)
rope('rope', sag(BELL + Vector((0, 0, 0.43)), BELL + Vector((0.05, -0.08, 0.1)), 0.01, 3), 0.008, 4)

# stern: taffrail lantern + transom windows + name ---------------------------
ST = top(STERN_Y)
tube('iron', (0, STERN_Y - 0.1, ST), (0, STERN_Y + 0.35, ST + 0.5), 0.03, segs=6)
lantern((0, STERN_Y + 0.35, ST + 0.35), s=2.4)
for sgn in (-1, 1):
    tube('iron', (sgn * (hw(STERN_Y) - 0.2), STERN_Y - 0.2, ST), (sgn * (hw(STERN_Y) - 0.1), STERN_Y + 0.2, ST + 0.3), 0.025, segs=6)
    lantern((sgn * (hw(STERN_Y) - 0.1), STERN_Y + 0.2, ST + 0.2), s=1.5)
for k in range(5):
    x = -1.8 + 0.9 * k
    box('glass_warm', (x, STERN_Y + 0.01, 1.6), (0.56, 0.02, 0.62))
    box('varnish', (x, STERN_Y + 0.03, 1.6), (0.66, 0.04, 0.72))
box('gold', (0, STERN_Y + 0.02, 0.65), (3.4, 0.02, 0.04))
text_mesh('gold', "REXMAW", 0.42, (0, STERN_Y + 0.04, 0.3), R_FACE_POS_Y, depth=0.01)

# masts, yards, furled sails, rigging ----------------------------------------


def furled(y_c, z, half, key='sail'):
    pts = [Vector((x, y_c + 0.12, z - 0.18 - 0.08 * (1 - (x / half) ** 2))) for x in np.linspace(-half * 0.95, half * 0.95, 11)]
    for a, b in zip(pts[:-1], pts[1:]):
        rr = 0.2 * (1 - 0.6 * (abs((a.x + b.x) / 2) / half) ** 2)
        tube(key, a, b, rr, rr, segs=8)
    for x in np.linspace(-half * 0.8, half * 0.8, 7):
        tube('rope', (x, y_c, z + 0.05), (x, y_c + 0.12, z - 0.44), 0.012, segs=4)


def mast(x, y, z0, h, r0, tops, yards):
    tube('varnish', (x, y, z0 - 0.2), (x, y, z0 + h), r0, r0 * 0.45, segs=12, tile=2.0)
    lathe('varnish', [(r0 + 0.16, 0), (r0 + 0.1, 0.12), (r0 + 0.02, 0.2)], (x, y, z0), segs=12)
    for tz, tw, td in tops:
        box('varnish', (x, y, tz), (tw, td, 0.1), grain=0)
        box('varnish', (x, y, tz - 0.25), (0.35, td * 0.9, 0.35))
    for yz, half in yards:
        for sgn in (-1, 1):
            tube('varnish', (x, y - 0.25, yz), (x + sgn * half, y - 0.25, yz), 0.13, 0.06, segs=8)
        furled(y - 0.25, yz, half)
        rope('rope', sag((x - half, y - 0.25, yz), (x, y - 0.1, yz + 2.2), 0.3, 6), 0.012, 4)
        rope('rope', sag((x + half, y - 0.25, yz), (x, y - 0.1, yz + 2.2), 0.3, 6), 0.012, 4)


def shrouds(mx, my, z_top, spread, offs, stretch=1.7, rat=True):
    for sgn in (1, -1):
        tops = []; bots = []
        for o in offs:
            yb = my + o * stretch
            t = top(yb) + 0.05
            pt = Vector((sgn * spread, my + o * 0.35, z_top))
            pb = Vector((sgn * (hw(yb) + 0.2), yb, t - 0.3))
            tube('rope', pt, pb, 0.022, segs=5)
            tops.append(pt); bots.append(pb)
            box('varnish', (sgn * (hw(yb) + 0.14), yb, t - 0.34), (0.28, 0.36, 0.08))   # channel
            tube('door', pb, pb + Vector((0, 0, 0.18)), 0.07, segs=8, caps=True)        # deadeye
        if rat:
            z = min(b.z for b in bots) + 0.55
            while z < z_top - 0.6:
                pts = []
                for pt, pb in zip(tops, bots):
                    t = (z - pb.z) / (pt.z - pb.z)
                    pts.append(pb.lerp(pt, t))
                for a, b in zip(pts[:-1], pts[1:]):
                    tube('rope', a, b, 0.009, segs=4)
                z += 0.42


# mainmast (behind the default camera)
MY = -8.0
mast(0, MY, 0, 27, 0.34, [(12.8, 2.6, 1.9), (21.0, 1.4, 1.0)], [(9.6, 7.8), (15.6, 5.8), (22.4, 3.8)])
shrouds(0, MY, 12.6, 1.2, (-1.0, -0.35, 0.3, 0.95))
box('varnish', (0, MY, 0.85), (1.6, 0.1, 0.08)); box('varnish', (0, MY + 0.8, 0.85), (1.6, 0.1, 0.08))
for x in (-0.75, 0.75):
    for yy in (MY, MY + 0.8):
        box('varnish', (x, yy, 0.43), (0.1, 0.1, 0.86), grain=2)
    for k in range(4):
        lathe('door', [(0.018, 0), (0.028, 0.08), (0.018, 0.2)], (x, MY + 0.12 + 0.18 * k, 0.8), segs=5)
# foremast on the forecastle
FMY = -16.0
mast(0, FMY, FC_Z, 22, 0.3, [(FC_Z + 10.5, 2.2, 1.6)], [(FC_Z + 8.0, 6.8), (FC_Z + 13.5, 5.0), (FC_Z + 18.0, 3.2)])
shrouds(0, FMY, FC_Z + 10.3, 1.0, (-0.6, 0.0, 0.6), stretch=1.2)
# mizzen on the quarterdeck (the one behind the companion)
MZY = 9.8
mast(0, MZY, QD, 16, 0.26, [(QD + 9.2, 1.8, 1.4)], [(QD + 7.0, 5.2), (QD + 11.5, 3.6)])
shrouds(0, MZY, QD + 9.0, 0.9, (-0.6, 0.0, 0.6), stretch=1.4)
# spanker boom + gaff, flag at the peak
tube('varnish', (0, MZY + 0.3, QD + 1.9), (0, STERN_Y + 3.5, QD + 2.3), 0.12, 0.08, segs=8)
tube('varnish', (0, MZY + 0.3, QD + 7.8), (0, STERN_Y + 1.2, QD + 10.0), 0.1, 0.06, segs=8)
pts = [Vector((0, y, QD + 1.72 + (y - MZY) * 0.02)) for y in np.linspace(MZY + 0.5, STERN_Y + 3.2, 9)]
for a, b in zip(pts[:-1], pts[1:]):
    tube('sail', a, b, 0.2, 0.2, segs=8)
FP = Vector((0, STERN_Y + 1.2, QD + 10.0))
m = mb('flag')
P = []; UV = []
for i in range(8):
    row = []; uvr = []
    for j in range(5):
        u = i / 7; v = j / 4
        row.append(FP + Vector((-1.5 * u, 0.12 * math.sin(u * 5.5 + v) * u, -0.95 * v)))
        uvr.append((u, 1 - v))
    P.append(row); UV.append(uvr)
m.grid(P, UV, smooth=True)
rope('rope', [FP, FP + Vector((0, 0, -0.95))], 0.008, 4)
# stays
rope('rope', [Vector((0, MY, 12.7)), Vector((0, FMY + 0.6, FC_Z + 1.2))], 0.035)
rope('rope', [Vector((0, MY, 26.5)), Vector((0, FMY, FC_Z + 21.5))], 0.02)
rope('rope', [Vector((0, MZY, QD + 15.5)), Vector((0, MY, 20.8))], 0.02)
rope('rope', [Vector((0, MZY, QD + 9.1)), Vector((0, MY, 11.0))], 0.025)
# bowsprit + jib stays
BS0 = Vector((0, BOW_Y + 1.2, top(BOW_Y + 1.2) - 0.3)); BS1 = Vector((0, BOW_Y - 8.5, top(BOW_Y) + 2.3))
tube('varnish', BS0, BS1, 0.24, 0.1, segs=10)
rope('rope', [Vector((0, FMY, FC_Z + 10.4)), BS1.lerp(BS0, 0.35)], 0.03)
rope('rope', [Vector((0, FMY, FC_Z + 21.5)), BS1], 0.02)
rope('rope', [BS1, Vector((0, BOW_Y + 0.3, -1.6))], 0.02)
# forecastle front wall with doors
box('cabin', (0, FC_Y - 0.06, FC_Z / 2), (2 * xi(FC_Y, 0) + 0.04, 0.12, FC_Z), grain=2)
for x in (-1.3, 1.3):
    box('door', (x, FC_Y + 0.02, 0.8), (0.7, 0.04, 1.5), grain=2, tile=1.0)
beam('varnish', (-xi(FC_Y, 1.6), FC_Y + 0.04, FC_Z + 0.9), (xi(FC_Y, 1.6), FC_Y + 0.04, FC_Z + 0.9), 0.1, 0.08)
for x in np.arange(-xi(FC_Y, 1.6) + 0.2, xi(FC_Y, 1.6) - 0.1, 0.3):
    lathe('varnish', BAL, (x, FC_Y + 0.04, FC_Z + 0.02), segs=6, tile=0.5)

# deck furniture ------------------------------------------------------------
log("deck props")
# hatch grating amidships
HY0 = -4.6
box('varnish', (0, HY0, 0.14), (2.0, 1.6, 0.28))
box('dark', (0, HY0, 0.285), (1.8, 1.4, 0.005))
for x in np.arange(-0.84, 0.86, 0.12):
    box('door', (x, HY0, 0.3), (0.04, 1.42, 0.04), grain=1)
for y in np.arange(-0.6, 0.62, 0.12):
    box('door', (0, HY0 + y, 0.315), (1.8, 0.04, 0.03), grain=0)


def barrel(c, s=1.0, yaw=0.0):
    with place(c, yaw, s):
        prof = [(0.25, 0), (0.29, 0.18), (0.31, 0.45), (0.29, 0.72), (0.25, 0.9)]
        lathe('barrel', prof, (0, 0, 0), segs=18, tile=1.0)
        lathe('barrel', [(0.0, 0.87), (0.235, 0.87), (0.25, 0.9)], (0, 0, 0), segs=18)
        for hz in (0.1, 0.28, 0.62, 0.8):
            r = np.interp(hz, [p[1] for p in prof], [p[0] for p in prof]) + 0.006
            lathe('iron', [(r, hz - 0.022), (r, hz + 0.022)], (0, 0, 0), segs=18)


def crate(c, s=0.6, yaw=0.0, lid=True):
    with place(c, yaw):
        h = s / 2
        box('crate', (0, 0, h), (s, s, s), tile=1.0)
        if not lid:
            box('dark', (0, 0, s - 0.02), (s - 0.06, s - 0.06, 0.005))
        for a in (-1, 1):
            for b in (-1, 1):
                box('crate', (a * (h - 0.02), b * (h - 0.02), h), (0.05, 0.05, s + 0.01), grain=2, tile=1.0)
                box('crate', (0, a * (h - 0.02), h + b * (h - 0.02)), (s + 0.01, 0.05, 0.05), grain=0, tile=1.0)
                box('crate', (a * (h - 0.02), 0, h + b * (h - 0.02)), (0.05, s + 0.01, 0.05), grain=1, tile=1.0)


def bottle(base, axis=(0, 0, 1), key='bottle_g', s=1.0):
    prof = [(0.0, 0), (0.036, 0), (0.038, 0.01), (0.038, 0.18), (0.03, 0.215), (0.013, 0.25), (0.013, 0.29), (0.016, 0.296)]
    prof = [(r * s, h * s) for r, h in prof]
    lathe(key, prof, base, axis, segs=10)
    ax = Vector(axis).normalized()
    tube('cork', Vector(base) + ax * 0.29 * s, Vector(base) + ax * 0.32 * s, 0.012 * s, segs=6, caps=True)


# INBOX crate of bottles (Rex's message archive), starboard side of the cabin front
IB = Vector((2.45, F - 0.5, 0))
crate(IB, 0.62, 0.0, lid=False)
text_mesh('stencil', "INBOX", 0.13, IB + Vector((0, -0.316, 0.34)), R_FACE_NEG_Y, depth=0.002)
for k, (dx, dy, tx, ty) in enumerate([(-0.14, -0.1, 0.1, -0.05), (0.0, -0.12, 0.0, 0.08), (0.14, -0.08, -0.1, 0.0),
                                       (-0.1, 0.1, 0.12, 0.1), (0.1, 0.12, -0.05, -0.1), (0.02, 0.02, 0.0, 0.0)]):
    bottle(IB + Vector((dx, dy, 0.36)), (tx, ty, 1), 'bottle_g' if k % 2 else 'bottle_a')
bottle(IB + Vector((-0.45, -0.25, 0.04)), (0.9, -0.4, 0.05), 'bottle_g')
box('parchment', IB + Vector((0.4, -0.2, 0.003)), (0.14, 0.2, 0.004), R=Matrix.Rotation(0.5, 3, 'Z'))

# crates forward on the starboard side
crate((3.35, -1.2, 0), 0.62, 0.05)
crate((3.3, -0.5, 0), 0.52, -0.08)
crate((3.35, -1.15, 0.62), 0.5, 0.25)
# barrels on the port side
for (x, y, s) in ((-3.45, -1.3, 1.0), (-3.38, -0.6, 1.0), (-2.82, -1.05, 1.0)):
    barrel((x, y, 0), s, random.random())
barrel((-3.42, -0.95, 0.9), 0.6, 0.3)
# lashing rope over the barrels
rope('rope', sag((-3.9, -1.9, 1.0), (-3.9, 0.0, 1.0), -0.3, 8), 0.015)

# coiled rope on deck
for (cx, cy) in ((-1.9, -3.1), (1.6, -6.4)):
    for k in range(4):
        rope('rope', circle((cx, cy, 0.03 + 0.045 * (k % 2) + 0.0), 0.3 - 0.05 * k, 22), 0.025, 5)

# cannons (lashed at closed ports)


def cannon(y, sgn):
    x = sgn * (xi(y, 0.5) - 0.95)
    with place((x, y, 0), 0 if sgn > 0 else math.pi):
        for dy in (-0.2, 0.2):
            box('door', (0.0, dy, 0.2), (0.9, 0.08, 0.3), grain=0)
        for dx in (-0.3, 0.3):
            box('door', (dx, 0, 0.1), (0.12, 0.5, 0.08), grain=1)
            for dy in (-0.26, 0.26):
                tube('door', (dx, dy - 0.04, 0.12), (dx, dy + 0.04, 0.12), 0.12, segs=10, caps=True)
        prof = [(0.0, -0.14), (0.06, -0.14), (0.1, -0.08), (0.17, 0.0), (0.16, 0.5), (0.13, 0.55), (0.12, 1.2),
                (0.14, 1.25), (0.14, 1.32), (0.1, 1.32), (0.07, 1.3)]
        lathe('iron', prof, (-0.4, 0, 0.42), (1, 0, 0.03), segs=14)
    ip = xi(y, 0.5)
    box('navy', (sgn * (ip + 0.01), y, 0.6), (0.03, 0.72, 0.62), grain=1)
    box('iron', (sgn * (ip - 0.005), y + 0.2, 0.6), (0.02, 0.1, 0.5))


cannon(-3.2, 1)
cannon(-3.2, -1)

# fishing rod leaning on the starboard rail (Rex's)
rp0 = Vector((xi(-6.0, 0) - 0.05, -6.0, 0.02)); rp1 = Vector((hw(-5.6) + 0.9, -5.2, 3.4))
tube('door', rp0, rp1, 0.018, 0.006, segs=6)
tube('iron', rp0.lerp(rp1, 0.1), rp0.lerp(rp1, 0.1) + Vector((0.05, 0, -0.05)), 0.03, segs=8, caps=True)
rope('rope', sag(rp1, (hw(-5.6) + 1.6, -5.0, WATER_Z), 0.4, 8), 0.003, 3)

# hanging lantern on the mainmast
beam('iron', (0, MY - 0.34, 2.3), (0, MY - 0.7, 2.3), 0.03, 0.03)
lantern((0, MY - 0.68, 2.05))

# ════════════════════════════════════════════════════════════════════════
# The captain's great cabin, under the quarterdeck (F → STERN_Y)
# ════════════════════════════════════════════════════════════════════════
log("captain's cabin")
CI0, CI1 = F + 0.12, STERN_Y - 0.12        # inner faces of the bulkhead / stern wall
deck('deck', CI0 - 0.02, STERN_Y, 0.0)
# panelled sides: dark wainscot below a chair rail, boards above
ys_c = list(np.arange(CI0, CI1, 0.25)) + [CI1]
for sgn in (1, -1):
    for key, (z0, z1) in (('door', (0.0, 0.95)), ('cabin', (0.95, QD))):
        P = []; UV = []
        for y in ys_c:
            row = [Vector((sgn * (xi(y, z) - 0.02), y, z)) for z in (z0, (z0 + z1) / 2, z1)]
            if sgn < 0:
                row = row[::-1]
            P.append(row); UV.append([(p.z / 2, y / 2) for p in row])
        mb(key).grid(P, UV, smooth=False)
    for a, b in zip(ys_c[:-1], ys_c[1:]):
        beam('varnish', (sgn * (xi(a, 0.95) - 0.045), a, 0.95), (sgn * (xi(b, 0.95) - 0.045), b, 0.95), 0.06, 0.06)
        beam('varnish', (sgn * (xi(a, 0.05) - 0.035), a, 0.06), (sgn * (xi(b, 0.05) - 0.035), b, 0.06), 0.04, 0.12)
XS = xi(CI1, 1.3)
box('cabin', (0, CI1 + 0.05, QD / 2), (2 * XS + 0.1, 0.1, QD), grain=2)
# deck beams overhead + the mizzen passing down through the cabin
for y in np.arange(F + 0.6, CI1, 0.9):
    box('varnish', (0, y, QD - 0.09), (2 * xi(y, QD) - 0.02, 0.14, 0.18), grain=0)
tube('varnish', (0, MZY, 0), (0, MZY, QD), 0.3, 0.28, segs=14, tile=2.0)
for z in (0.0, QD - 0.18):
    lathe('varnish', [(0.42, 0), (0.36, 0.08), (0.31, 0.16)] if z == 0 else [(0.31, 0), (0.36, 0.08), (0.42, 0.16)], (0, MZY, z), segs=14)
for hz in (0.6, 1.9):
    lathe('iron', [(0.305, hz - 0.03), (0.305, hz + 0.03)], (0, MZY, 0), segs=14)
# the backs of the two front windows look out at the dusk
for side in (-1, 1):
    cx = side * 2.12
    box('glass_view', (cx, CI0 + 0.005, 1.36), (0.8, 0.02, 0.76))
    for x in (cx - 0.43, cx + 0.43):
        box('varnish', (x, CI0 + 0.03, 1.36), (0.08, 0.06, 0.9), grain=2, tile=1.0)
    for z in (0.95, 1.77):
        box('varnish', (cx, CI0 + 0.03, z), (0.94, 0.06, 0.08), grain=0, tile=1.0)
    box('door', (cx, CI0 + 0.02, 1.36), (0.03, 0.03, 0.76)); box('door', (cx, CI0 + 0.02, 1.46), (0.8, 0.03, 0.03))

# stern windows + window seat (starboard half of the stern wall)
SW = [0.55, 1.45, 2.35]
for x in SW:
    box('glass_view', (x, CI1 - 0.005, 1.6), (0.56, 0.02, 0.62))
    for dx in (-0.31, 0.31):
        box('varnish', (x + dx, CI1 - 0.03, 1.6), (0.07, 0.06, 0.74), grain=2, tile=1.0)
    for z in (1.27, 1.93):
        box('varnish', (x, CI1 - 0.03, z), (0.69, 0.06, 0.07), grain=0, tile=1.0)
    box('door', (x, CI1 - 0.02, 1.6), (0.025, 0.03, 0.62)); box('door', (x, CI1 - 0.02, 1.7), (0.56, 0.03, 0.025))
SX0, SX1 = 0.05, xi(CI1, 0.4) - 0.02
box('varnish', ((SX0 + SX1) / 2, CI1 - 0.27, 0.44), (SX1 - SX0, 0.54, 0.05), grain=0)
box('door', ((SX0 + SX1) / 2, CI1 - 0.52, 0.21), (SX1 - SX0, 0.04, 0.42), grain=0, tile=1.0)
for k in range(3):
    x = SX0 + (SX1 - SX0) * (k + 0.5) / 3
    box('cushion', (x, CI1 - 0.27, 0.52), ((SX1 - SX0) / 3 - 0.04, 0.48, 0.1))
for x, r in ((SX0 + 0.35, 0.3), (SX1 - 0.4, -0.25)):
    box('cushion', (x, CI1 - 0.1, 0.72), (0.38, 0.12, 0.34), R=Matrix.Rotation(r, 3, 'Z') @ Matrix.Rotation(-0.25, 3, 'X'))

# the crew portrait over a sideboard, port half of the stern wall
PX, PZ, PW, PH = -0.95, 1.5, 1.2, 0.9
box('portrait', (PX, CI1 - 0.015, PZ), (PW, 0.02, PH))
for (dx, dz, w_, h_) in ((0, PH / 2 + 0.05, PW + 0.2, 0.1), (0, -PH / 2 - 0.05, PW + 0.2, 0.1),
                         (PW / 2 + 0.05, 0, 0.1, PH), (-PW / 2 - 0.05, 0, 0.1, PH)):
    box('gold', (PX + dx, CI1 - 0.035, PZ + dz), (w_, 0.05, h_))
for (dx, dz, w_, h_) in ((0, PH / 2 + 0.005, PW + 0.02, 0.02), (0, -PH / 2 - 0.005, PW + 0.02, 0.02),
                         (PW / 2 + 0.005, 0, 0.02, PH), (-PW / 2 - 0.005, 0, 0.02, PH)):
    box('gold', (PX + dx, CI1 - 0.068, PZ + dz), (w_, 0.012, h_))                          # inner bead
box('brass', (PX, CI1 - 0.066, PZ - PH / 2 - 0.05), (0.46, 0.012, 0.07))              # plaque on the frame
text_mesh('stencil', "THE CREW OF THE REXMAW", 0.026, (PX, CI1 - 0.073, PZ - PH / 2 - 0.05), R_FACE_NEG_Y, depth=0.001)
box('door', (PX, CI1 - 0.25, 0.4), (1.4, 0.46, 0.8), grain=0, tile=1.0)                   # sideboard
box('varnish', (PX, CI1 - 0.25, 0.815), (1.46, 0.5, 0.03), grain=0)
for dx in (-0.35, 0.35):
    box('varnish', (PX + dx, CI1 - 0.485, 0.42), (0.6, 0.01, 0.6), grain=2, tile=1.0)
    sphere('brass', (PX + dx * 0.2, CI1 - 0.495, 0.5), 0.018)
lathe('bottle_a', [(0, 0), (0.08, 0), (0.1, 0.06), (0.09, 0.14), (0.035, 0.2), (0.025, 0.27), (0.03, 0.29), (0, 0.29)],
      (PX - 0.35, CI1 - 0.25, 0.83), segs=14)
for dx in (-0.2, -0.1):
    lathe('ceramic', [(0, 0), (0.03, 0), (0.008, 0.01), (0.006, 0.06), (0.03, 0.09), (0.035, 0.14), (0.03, 0.14), (0, 0.1)],
          (PX + dx, CI1 - 0.2, 0.83), segs=10)
for dx in (0.3, 0.45):                                                                    # candlesticks
    lathe('brass', [(0.05, 0), (0.05, 0.015), (0.015, 0.04), (0.012, 0.18), (0.03, 0.19), (0.02, 0.2)], (PX + dx, CI1 - 0.25, 0.83), segs=10)
    tube('parchment', (PX + dx, CI1 - 0.25, 1.03), (PX + dx, CI1 - 0.25, 1.13), 0.012, segs=8, caps=True)
    sphere('lantern', (PX + dx, CI1 - 0.25, 1.15), 0.012, segs=6, rings=4, sz=1.8)

# chart table in the middle, the captain's (empty) chair facing the door
TY = 7.1
box('door', (0, TY, 0.87), (1.8, 1.05, 0.06), grain=0, tile=1.0)
for dy in (-1, 1):
    box('varnish', (0, TY + dy * 0.51, 0.915), (1.8, 0.03, 0.03), grain=0)
    box('door', (0, TY + dy * 0.44, 0.76), (1.5, 0.03, 0.16), grain=0, tile=1.0)
for dx in (-1, 1):
    box('varnish', (dx * 0.885, TY, 0.915), (0.03, 1.05, 0.03), grain=1)
    box('door', (dx * 0.78, TY, 0.76), (0.03, 0.85, 0.16), grain=1, tile=1.0)
    for dy in (-1, 1):
        lathe('door', [(0.05, 0), (0.06, 0.06), (0.035, 0.2), (0.065, 0.45), (0.035, 0.68), (0.05, 0.84)],
              (dx * 0.78, TY + dy * 0.42, 0), segs=8)
    beam('door', (dx * 0.78, TY - 0.42, 0.15), (dx * 0.78, TY + 0.42, 0.15), 0.04, 0.04)
beam('door', (-0.78, TY, 0.15), (0.78, TY, 0.15), 0.04, 0.04)
box('chart', (0.05, TY - 0.03, 0.902), (1.34, 0.9, 0.004))
for (x, y) in ((-0.58, TY - 0.44), (0.66, TY + 0.38), (0.68, TY - 0.44)):             # weights on the corners
    tube('brass', (x, y, 0.904), (x, y, 0.94), 0.03, segs=10, caps=True)
tube('parchment', (-0.72, TY + 0.2, 0.94), (-0.62, TY - 0.4, 0.94), 0.035, segs=10, caps=True)
dv = Vector((0.15, TY - 0.05, 0.905))                                                   # dividers
for a in (-0.18, 0.18):
    beam('brass', dv + Vector((0, 0, 0.012)), dv + Vector((0.28 * math.cos(0.6 + a), 0.28 * math.sin(0.6 + a), 0.0)), 0.008, 0.006)
sphere('brass', dv + Vector((0, 0, 0.014)), 0.012)
sg = Vector((0.45, TY + 0.3, 0.935))                                                    # spyglass
lathe('brass', [(0.028, 0), (0.028, 0.18), (0.024, 0.19), (0.024, 0.34), (0.02, 0.35), (0.02, 0.48), (0.024, 0.49)],
      sg, (-0.9, -0.44, 0), segs=12, capb=True, capt=True)
box('leather_b', (-0.4, TY + 0.3, 0.925), (0.3, 0.22, 0.045), R=Matrix.Rotation(0.3, 3, 'Z'))   # logbook
box('parchment', (-0.4, TY + 0.3, 0.925), (0.285, 0.2, 0.035), R=Matrix.Rotation(0.3, 3, 'Z'))
lathe('stencil', [(0, 0), (0.03, 0), (0.035, 0.03), (0.015, 0.05), (0.018, 0.06), (0, 0.06)], (-0.15, TY + 0.36, 0.904), segs=10)
beam('sail', (-0.15, TY + 0.36, 0.95), (-0.02, TY + 0.44, 1.18), 0.03, 0.004)            # quill
lathe('brass', [(0.07, 0), (0.07, 0.015), (0.02, 0.03), (0.018, 0.1), (0.04, 0.11)], (0.62, TY - 0.2, 0.904), segs=10)
tube('parchment', (0.62, TY - 0.2, 1.01), (0.62, TY - 0.2, 1.1), 0.015, segs=8, caps=True)
sphere('lantern', (0.62, TY - 0.2, 1.125), 0.014, segs=6, rings=4, sz=1.8)
# oil lamp hanging over the table
for z0 in np.arange(1.95, QD - 0.18, 0.06):
    tube('iron', (0, TY, z0), (0, TY, z0 + 0.05), 0.006, segs=4)
lantern((0, TY, 1.78), s=1.4)
box('rug', (0, TY, 0.005), (2.6, 1.8, 0.01))


def chair(pos, yaw, captain=False):
    """Chair facing local -Y."""
    with place(pos, yaw):
        s = 0.62 if captain else 0.48
        sh = 0.46
        box('door', (0, 0, sh), (s, s, 0.05), tile=1.0)
        for dx in (-1, 1):
            for dy in (-1, 1):
                lathe('door', [(0.025, 0), (0.032, 0.15), (0.022, 0.3), (0.028, sh - 0.02)], (dx * (s / 2 - 0.04), dy * (s / 2 - 0.04), 0), segs=6)
        bh = 0.85 if captain else 0.55
        for dx in (-1, 1):
            box('door', (dx * (s / 2 - 0.04), s / 2 - 0.03, sh + bh / 2), (0.05, 0.05, bh), grain=2)
        box('door', (0, s / 2 - 0.03, sh + bh - 0.03), (s + 0.04, 0.06, 0.07), grain=0)
        if captain:
            box('leather_r', (0, 0, sh + 0.055), (s - 0.06, s - 0.06, 0.06))
            box('leather_r', (0, s / 2 - 0.06, sh + bh * 0.5), (s - 0.14, 0.04, bh * 0.65))
            for dx in (-1, 1):
                box('door', (dx * (s / 2 - 0.02), -0.03, sh + 0.26), (0.06, s - 0.02, 0.05), grain=1)
                box('door', (dx * (s / 2 - 0.02), -s / 2 + 0.05, sh + 0.13), (0.05, 0.05, 0.26), grain=2)
                sphere('brass', (dx * (s / 2 - 0.04), s / 2 - 0.03, sh + bh + 0.02), 0.035)
        else:
            box('door', (0, s / 2 - 0.03, sh + bh * 0.6), (s - 0.08, 0.025, bh * 0.35), grain=0)


chair((0, TY + 0.85, 0), 0.0, captain=True)
chair((-1.2, TY - 0.1, 0), math.pi / 2)
chair((1.25, TY + 0.2, 0), -math.pi / 2 + 0.35)

# port side: writing desk with the captain's bottle-orders, pinboard of letters
DXW = -(xi(6.0, 0.8) - 0.3)
box('door', (DXW, 6.0, 0.76), (0.56, 1.3, 0.05), grain=1, tile=1.0)
box('door', (DXW + 0.02, 6.0, 0.62), (0.5, 0.5, 0.22), grain=1, tile=1.0)
for dy in (-0.6, 0.6):
    for dx in (-0.22, 0.22):
        box('door', (DXW + dx, 6.0 + dy, 0.37), (0.05, 0.05, 0.74), grain=2)
for (x, y, r) in ((0.05, -0.35, 0.3), (-0.02, -0.1, -0.2), (0.08, 0.25, 0.1)):
    box('parchment', (DXW + x, 6.0 + y, 0.787), (0.22, 0.3, 0.003), R=Matrix.Rotation(r, 3, 'Z'))
for k, (y, key) in enumerate(((5.55, 'bottle_g'), (5.8, 'bottle_a'))):
    bottle((DXW - 0.12, y - 0.13, 0.822), (0.2, 1, 0.02), key)
bottle((DXW + 0.15, 6.45, 0.785), (0, 0, 1), 'bottle_g')
tube('parchment', (DXW + 0.1, 6.1, 0.8), (DXW - 0.12, 6.35, 0.8), 0.015, segs=8, caps=True)
lathe('brass', [(0.06, 0), (0.06, 0.012), (0.015, 0.03), (0.012, 0.12), (0.035, 0.13)], (DXW + 0.18, 5.5, 0.785), segs=10)
tube('parchment', (DXW + 0.18, 5.5, 0.915), (DXW + 0.18, 5.5, 0.99), 0.013, segs=8, caps=True)
sphere('lantern', (DXW + 0.18, 5.5, 1.005), 0.013, segs=6, rings=4, sz=1.8)
chair((DXW + 0.62, 6.1, 0), -math.pi / 2 - 0.2)
PBX = -(xi(6.0, 1.5) - 0.04)
box('crate', (PBX, 6.0, 1.55), (0.03, 1.1, 0.72), grain=1, tile=1.0)
for (y, z, r) in ((-0.33, 1.7, 0.08), (-0.05, 1.62, -0.1), (0.25, 1.72, 0.05), (-0.2, 1.36, -0.04), (0.2, 1.4, 0.12), (0.42, 1.52, -0.15)):
    box('parchment', (PBX + 0.02, 6.0 + y, z), (0.004, 0.2, 0.26), R=Matrix.Rotation(r, 3, 'X'))
    sphere('brass', (PBX + 0.03, 6.0 + y, z + 0.11), 0.01)
# port aft: the captain's berth, sea chest with the tricorn left on it
BY0, BY1 = 9.6, 11.9
BXo = -(xi(10.7, 0.4) - 0.02); BXi = BXo + 0.95
bx = (BXo + BXi) / 2; by = (BY0 + BY1) / 2
box('door', (bx, by, 0.2), (BXi - BXo, BY1 - BY0, 0.4), grain=1, tile=1.0)
box('door', (BXi - 0.03, by, 0.5), (0.05, BY1 - BY0, 0.25), grain=1, tile=1.0)
box('door', (bx, BY1 - 0.03, 0.7), (BXi - BXo, 0.05, 0.6), grain=0, tile=1.0)
box('sail', (bx - 0.02, by, 0.46), (BXi - BXo - 0.1, BY1 - BY0 - 0.08, 0.14))
box('blanket', (bx - 0.02, by - 0.25, 0.54), (BXi - BXo - 0.04, 1.5, 0.05), tile=1.0)
box('blanket', (BXi + 0.005, by - 0.25, 0.4), (0.02, 1.5, 0.3), tile=1.0)
box('sail', (bx - 0.02, BY1 - 0.3, 0.58), (0.6, 0.34, 0.12), R=Matrix.Rotation(0.08, 3, 'Z'))
lantern((BXo + 0.25, BY1 - 0.9, 1.75), s=1.0)
beam('iron', (BXo + 0.02, BY1 - 0.9, 1.97), (BXo + 0.28, BY1 - 0.9, 1.97), 0.025, 0.025)
CHY = 9.05
box('door', (bx + 0.05, CHY, 0.24), (0.9, 0.5, 0.48), grain=0, tile=1.0)
lathe('door', [(0.26, 0.0), (0.26, 0.9)], (bx + 0.05 - 0.45, CHY, 0.48), (1, 0, 0), segs=16, capb=True, capt=True)   # domed lid
for dx in (-0.32, 0.0, 0.32):
    box('brass', (bx + 0.05 + dx, CHY, 0.26), (0.04, 0.52, 0.5))
box('iron', (bx + 0.05, CHY - 0.26, 0.42), (0.08, 0.02, 0.1))
lathe('hat', [(0.0, 0), (0.3, 0), (0.31, 0.012), (0.29, 0.03), (0.13, 0.025), (0.125, 0.12), (0.1, 0.15), (0.0, 0.155)],
      (bx, CHY, 0.74), segs=3, phase=0.4, smooth=False)
# starboard fore: bookshelf
BKX = xi(5.8, 1.0) - 0.2
box('door', (BKX, 5.75, 1.0), (0.36, 0.04, 2.0), grain=2, tile=1.0)
box('door', (BKX, 7.05, 1.0), (0.36, 0.04, 2.0), grain=2, tile=1.0)
for z in (0.05, 0.5, 0.95, 1.4, 1.98):
    box('door', (BKX, 6.4, z), (0.36, 1.3, 0.035), grain=1, tile=1.0)
brng = random.Random(21)
for z in (0.07, 0.52, 0.97, 1.42):
    y = 5.8
    while y < 6.95:
        t = brng.uniform(0.03, 0.07); hgt = brng.uniform(0.22, 0.36)
        if y + t > 7.0:
            break
        lean = brng.random() < 0.08
        R = Matrix.Rotation(0.25, 3, 'X') if lean else None
        box(brng.choice(('leather_r', 'leather_g', 'leather_b', 'leather_t')), (BKX + 0.02, y + t / 2, z + hgt / 2), (0.24, t, hgt), R=R, grain=2)
        y += t + (0.06 if lean else 0.004)
box('ceramic', (BKX, 6.9, 1.44), (0.1, 0.1, 0.02))
# starboard aft: a globe on its stand
GL = Vector((xi(10.3, 0.8) - 0.55, 10.3, 0))
for k in range(3):
    a = k * 2 * math.pi / 3
    beam('door', GL + Vector((0.28 * math.cos(a), 0.28 * math.sin(a), 0)), GL + Vector((0.05 * math.cos(a), 0.05 * math.sin(a), 0.6)), 0.04, 0.04)
lathe('door', [(0.1, 0.55), (0.14, 0.62), (0.06, 0.66)], GL, segs=10)
lathe('globe', [(0.0, -0.3)] + [(0.3 * math.sin(math.pi * k / 10), -0.3 * math.cos(math.pi * k / 10)) for k in range(1, 10)] + [(0.0, 0.3)],
      GL + Vector((0, 0, 0.98)), (0.35, 0, 1), segs=20)
rope('brass', [GL + Vector((0.34 * math.sin(a), 0, 0.98 + 0.34 * math.cos(a))) for a in np.linspace(0, 2 * math.pi, 25)], 0.012, 5)
# wall sconces
for sgn in (1, -1):
    x = sgn * (xi(8.4, 1.8) - 0.3)
    beam('iron', (sgn * (xi(8.4, 1.8) - 0.02), 8.4, 2.0), (x, 8.4, 2.0), 0.025, 0.025)
    lantern((x, 8.4, 1.78), s=1.0)

# ════════════════════════════════════════════════════════════════════════
# Harbour
# ════════════════════════════════════════════════════════════════════════
log("harbour")
# water + sky
m = mb('water')
Rn = 48
for i in range(Rn):
    for j in range(Rn):
        x0 = -SKY_R + 2 * SKY_R * i / Rn; x1 = -SKY_R + 2 * SKY_R * (i + 1) / Rn
        y0 = -SKY_R + 2 * SKY_R * j / Rn; y1 = -SKY_R + 2 * SKY_R * (j + 1) / Rn
        if min(math.hypot(x, y) for x in (x0, x1) for y in (y0, y1)) > SKY_R + 2:
            continue
        pts = [(x0, y0, WATER_Z), (x1, y0, WATER_Z), (x1, y1, WATER_Z), (x0, y1, WATER_Z)]
        m.face(pts, [((p[0] + SKY_R) / (2 * SKY_R), (p[1] + SKY_R) / (2 * SKY_R)) for p in pts])

m = mb('sky')
NU, NV = 64, 24
P = []; UV = []
for j in range(NV + 1):
    lat = math.radians(-6 + (90 + 6) * j / NV)
    row = []; uvr = []
    for i in range(NU + 1):
        lon = -math.pi + 2 * math.pi * i / NU
        row.append(Vector((SKY_R * math.cos(lat) * math.cos(lon), SKY_R * math.cos(lat) * math.sin(lon), SKY_R * math.sin(lat) + WATER_Z * 0)))
        uvr.append((i / NU, lat / math.pi + 0.5))
    P.append(row); UV.append(uvr)
m.grid(P, UV, smooth=True)

# pier alongside, starboard
PX0, PX1, PZ = 6.2, 10.4, -0.7
PY0, PY1 = -40.0, 30.0
box('pier', ((PX0 + PX1) / 2, (PY0 + PY1) / 2, PZ - 0.12), (PX1 - PX0, PY1 - PY0, 0.24), grain=0)
for y in np.arange(PY0 + 1, PY1, 3.0):
    for x in (PX0 + 0.1, PX1 - 0.1):
        ztop = PZ + 0.35 if x < 7 else PZ - 0.1
        tube('pier', (x, y, WATER_Z - 3), (x, y, ztop), 0.17, segs=8, caps=True)
    beam('pier', (PX0 + 0.05, y, PZ - 0.35), (PX1 - 0.05, y, PZ - 0.35), 0.15, 0.2)
beam('pier', (PX0 - 0.05, PY0, PZ - 0.1), (PX0 - 0.05, PY1, PZ - 0.1), 0.12, 0.25)
BOLL = [(-13.0), (-3.0), (7.0), (16.0)]
for y in BOLL:
    lathe('iron', [(0.14, 0), (0.12, 0.3), (0.16, 0.36), (0.16, 0.42), (0.0, 0.44)], (6.75, y, PZ), segs=12)
# mooring lines ship → bollards
for (ys_, yb) in ((-12.0, -13.0), (-9.0, -3.0), (6.0, 7.0), (10.5, 16.0)):
    a = Vector((hw(ys_) + 0.1, ys_, top(ys_) - 0.1))
    b = Vector((6.75, yb, PZ + 0.35))
    rope('rope', sag(a, b, 0.45, 12), 0.03, 5)
# gangplank
GA = Vector((hw(-1.8) + 0.02, -1.8, 1.18)); GB = Vector((7.4, -3.2, PZ + 0.02))
beam('pier', GA, GB, 0.7, 0.06)
for k in range(1, 9):
    p = GA.lerp(GB, k / 9)
    box('pier', p + Vector((0, 0, 0.04)), (0.1, 0.7, 0.03), R=basis_from(GB - GA))
for dy in (-0.35, 0.35):
    rope('rope', sag(GA + Vector((0, dy, 0.9)), GB + Vector((0, dy, 0.9)), 0.15, 8), 0.015, 4)
# lamp posts on the pier
for y in (-26.0, -13.5, -1.0, 11.5, 24.0):
    lathe('iron', [(0.12, 0), (0.08, 0.2), (0.05, 0.3), (0.045, 3.0), (0.07, 3.1)], (10.0, y, PZ), segs=8)
    lantern((10.0, y, PZ + 3.3), s=1.6)
# pier clutter
crate((9.3, -6.5, PZ), 0.7, 0.3); crate((9.4, -5.7, PZ), 0.6, -0.2); crate((9.35, -6.2, PZ + 0.7), 0.5, 0.6)
barrel((9.6, 4.2, PZ), 1.0, 0.1); barrel((9.2, 4.8, PZ), 1.0, 0.5); barrel((8.9, 20.0, PZ), 1.0, 0.1)
for k in range(3):
    rope('rope', circle((8.2, 13.0, PZ + 0.03 + 0.04 * k), 0.34 - 0.06 * k, 22), 0.025, 5)

# quay wall + town terrain
QX0, QX1, QZ = PX1, 16.0, -0.5
QY0, QY1 = -62.0, 52.0
box('stone', ((QX0 + QX1) / 2, (QY0 + QY1) / 2, (QZ + WATER_Z - 3) / 2), (QX1 - QX0, QY1 - QY0, QZ - WATER_Z + 3), grain=1, tile=4.0)
for y in np.arange(QY0 + 3, QY1, 12.0):
    lathe('iron', [(0.12, 0), (0.08, 0.2), (0.05, 0.3), (0.045, 3.2), (0.07, 3.3)], (15.2, y, QZ), segs=8)
    lantern((15.2, y, QZ + 3.5), s=1.6)


def land_d(x, y):
    d_town = x - QX1
    d_head = (-52 + 5 * math.sin(x * 0.11)) - y
    d_head = min(d_head, x + 58)
    return max(d_town if QY0 - 6 < y < QY1 + 6 else d_town - abs(y - (QY0 + QY1) / 2) * 0.3, d_head)


def ground(x, y):
    d = land_d(x, y)
    hill = 3.0 * math.sin(y * 0.06 + 1.3) * math.sin(x * 0.05) + 1.8 * math.sin(y * 0.13 + x * 0.04) + 1.2 * math.cos(x * 0.11 - y * 0.03)
    if d >= 0:
        return QZ + 0.2 * d + hill * min(1.0, d / 14) + 0.25 * min(1.0, d / 3)
    return QZ + 1.2 * d


m = mb('grass')
STEP = 2.5
gx = np.arange(-60, 84, STEP); gy = np.arange(-85, 80, STEP)
for x in gx:
    for y in gy:
        c = [(x, y), (x + STEP, y), (x + STEP, y + STEP), (x, y + STEP)]
        if any(math.hypot(px, py) > SKY_R - 6 for px, py in c):
            continue
        zs = [ground(px, py) for px, py in c]
        if max(zs) < WATER_Z - 0.5:
            continue
        if all(QX0 - 1 < px <= QX1 and QY0 < py < QY1 for px, py in c):
            continue
        pts = [(px, py, z) for (px, py), z in zip(c, zs)]
        m.face(pts, [(px / 8, py / 8) for px, py in c], smooth=True)

# distant mountains (haze silhouettes)
m = mb('mountain')
N = 96
P = []; UV = []
rng_m = random.Random(4)
hs = [0.0] * (N + 1)
for i in range(N + 1):
    a = MTN_A0 + (MTN_A1 - MTN_A0) * i / N
    hgt = 10 + 7 * math.sin(a * 5.3 + 1) + 5 * math.sin(a * 11.7) + 3 * math.sin(a * 23.1 + 2)
    dsun = abs(math.atan2(math.sin(a - math.atan2(SUN.y, SUN.x)), math.cos(a - math.atan2(SUN.y, SUN.x))))
    hgt *= 0.45 + 0.55 * min(1.0, dsun / 0.5)
    hs[i] = max(3.0, hgt)
for j, fac in enumerate((0.0, 1.0)):
    row = []; uvr = []
    for i in range(N + 1):
        a = MTN_A0 + (MTN_A1 - MTN_A0) * i / N
        r = SKY_R - 4
        row.append(Vector((r * math.cos(a), r * math.sin(a), WATER_Z - 1 + fac * (hs[i] + 1))))
        uvr.append((i / N, fac))
    P.append(row); UV.append(uvr)
m.grid(P, UV, smooth=False)

# town ------------------------------------------------------------------------
log("town")


def house(x, y, w, d, storeys, yaw, fac, roof, warehouse=False):
    c = [(x + dx, y + dy) for dx in (-w / 2, w / 2) for dy in (-d / 2, d / 2)]
    gs = [ground(px, py) for px, py in c]
    gmin, gmax = min(gs), max(gs)
    base = gmin - 0.6
    H = gmax + storeys * 3.0
    key = f'facade{fac}'
    R = Matrix.Rotation(yaw, 3, 'Z')
    ctr = Vector((x, y, 0))
    hw_, hd = w / 2, d / 2
    corners = [ctr + R @ Vector(v) for v in ((-hw_, -hd, 0), (hw_, -hd, 0), (hw_, hd, 0), (-hw_, hd, 0))]
    ms = mb(key)
    off = random.choice((0.0, 3.0, 6.0, 9.0))
    for k in range(4):
        a = corners[k]; b = corners[(k + 1) % 4]
        L = (b - a).length
        pts = [Vector((a.x, a.y, base)), Vector((b.x, b.y, base)), Vector((b.x, b.y, H)), Vector((a.x, a.y, H))]
        vs = [(base - gmax) / 12, (base - gmax) / 12, (H - gmax) / 12, (H - gmax) / 12]
        uvs = [(off / 12, vs[0]), ((off + L) / 12, vs[1]), ((off + L) / 12, vs[2]), (off / 12, vs[3])]
        ms.face(pts[::-1], uvs[::-1])
    # gable roof along the longer side
    ridge_along_w = w >= d
    rh = (min(w, d) / 2) * (0.55 if not warehouse else 0.4)
    ov = 0.35
    if ridge_along_w:
        A = [Vector((-hw_ - ov, -hd - ov, 0)), Vector((hw_ + ov, -hd - ov, 0)), Vector((hw_ + ov, 0, rh)), Vector((-hw_ - ov, 0, rh))]
        B = [Vector((hw_ + ov, hd + ov, 0)), Vector((-hw_ - ov, hd + ov, 0)), Vector((-hw_ - ov, 0, rh)), Vector((hw_ + ov, 0, rh))]
        gab = [[Vector((-hw_, -hd, 0)), Vector((-hw_, hd, 0)), Vector((-hw_, 0, rh))], [Vector((hw_, hd, 0)), Vector((hw_, -hd, 0)), Vector((hw_, 0, rh))]]
        slope = math.hypot(hd + ov, rh); span = w + 2 * ov
    else:
        A = [Vector((hw_ + ov, -hd - ov, 0)), Vector((hw_ + ov, hd + ov, 0)), Vector((0, hd + ov, rh)), Vector((0, -hd - ov, rh))]
        B = [Vector((-hw_ - ov, hd + ov, 0)), Vector((-hw_ - ov, -hd - ov, 0)), Vector((0, -hd - ov, rh)), Vector((0, hd + ov, rh))]
        gab = [[Vector((hw_, -hd, 0)), Vector((-hw_, -hd, 0)), Vector((0, -hd, rh))], [Vector((-hw_, hd, 0)), Vector((hw_, hd, 0)), Vector((0, hd, rh))]]
        slope = math.hypot(hw_ + ov, rh); span = d + 2 * ov
    lift = Vector((0, 0, H))
    for quad in (A, B):
        pts = [ctr + R @ p + lift for p in quad]
        mb(roof).face(pts, [(0, 0), (span / 4, 0), (span / 4, slope / 4), (0, slope / 4)])
        # thickness lip
    for tri in gab:
        pts = [ctr + R @ p + lift for p in tri]
        L = (tri[1] - tri[0]).length
        mb(key).face(pts, [(0.02, 0.9), (0.02 + L / 12, 0.9), (0.02 + L / 24, 0.9 + rh / 12)])
    # chimney
    if random.random() < 0.7:
        cx_, cy_ = random.uniform(-hw_ * 0.6, hw_ * 0.6), random.uniform(-hd * 0.4, hd * 0.4)
        p = ctr + R @ Vector((cx_, cy_, 0))
        box('stone', (p.x, p.y, H + rh * 0.8), (0.6, 0.6, rh * 1.6 + 0.6), R=R, tile=4.0)


fac_i = 0
# waterfront row: warehouses, tavern, chandlery facing the harbour
y = QY0 + 6
while y < QY1 - 4:
    w = random.uniform(5.5, 9.0); d = random.uniform(6.0, 8.0)
    house(QX1 + 3.5 + d / 2 - 3.0, y + w / 2, d, w, random.choice((2, 2, 3)), random.uniform(-0.03, 0.03), fac_i % 5,
          random.choice(('terracotta', 'terracotta', 'slate')), warehouse=True)
    fac_i += 1
    y += w + random.uniform(0.6, 2.5)
# hillside houses
for gx_ in np.arange(QX1 + 14, 62, 7.5):
    for gy_ in np.arange(-56, 48, 7.0):
        x = gx_ + random.uniform(-1.5, 1.5); y = gy_ + random.uniform(-1.5, 1.5)
        if math.hypot(x, y) > SKY_R - 14 or random.random() < 0.18:
            continue
        if abs(x - 44) < 7 and abs(y - 8) < 9:
            continue
        w = random.uniform(4.5, 7.0); d = random.uniform(4.5, 6.5)
        house(x, y, w, d, random.choice((1, 2, 2, 3)), random.uniform(-0.2, 0.2), random.randrange(5),
              random.choice(('terracotta', 'terracotta', 'terracotta', 'slate')))
# church on the hill
CH = Vector((44, 8, 0)); gch = ground(CH.x, CH.y)
house(CH.x + 3, CH.y, 12, 7, 2, 0.0, 4, 'slate')
box('facade4', (CH.x - 4, CH.y, gch + 7), (4.2, 4.2, 15.5), grain=2, tile=12.0)
lathe('slate', [(3.0, 0), (0.0, 8.0)], (CH.x - 4, CH.y, gch + 14.7), segs=4, phase=math.pi / 4, capb=True, smooth=False)
lathe('glass_warm', [(0.0, 0), (0.8, 0), (0.8, 0.05)], (CH.x - 6.15, CH.y, gch + 12), (-1, 0, 0), segs=16)
# lighthouse on the headland
LH = Vector((-24, -62, 0)); glh = ground(LH.x, LH.y)
lathe('stripes', [(2.4, 0), (2.2, 2), (1.6, 15)], (LH.x, LH.y, glh - 1), segs=16, tile=16.0)
box('iron', (LH.x, LH.y, glh + 14.2), (4.0, 4.0, 0.3))
tube('beacon', (LH.x, LH.y, glh + 14.3), (LH.x, LH.y, glh + 16.1), 1.1, segs=12, caps=True)
lathe('terracotta', [(1.5, 0), (0.1, 1.6)], (LH.x, LH.y, glh + 16.1), segs=12, capb=True)
house(LH.x + 5, LH.y - 1, 5, 4, 1, 0.3, 0, 'slate')
# trees on the hills
for _ in range(90):
    x = random.uniform(QX1 + 20, 80); y = random.uniform(-80, 70)
    if math.hypot(x, y) > SKY_R - 8 or land_d(x, y) < 8:
        continue
    g = ground(x, y)
    s = random.uniform(0.8, 1.5)
    tube('door', (x, y, g - 0.3), (x, y, g + 1.6 * s), 0.18 * s, segs=6)
    sphere('tree', (x, y, g + 2.6 * s), 1.4 * s, segs=8, rings=5, sz=1.2)
    sphere('tree', (x + 0.6 * s, y + 0.3 * s, g + 2.0 * s), 1.0 * s, segs=7, rings=4)
for _ in range(25):
    x = random.uniform(-55, 5); y = random.uniform(-74, -55)
    if math.hypot(x, y) > SKY_R - 6 or land_d(x, y) < 4 or abs(x - LH.x) < 6:
        continue
    g = ground(x, y); s = random.uniform(0.8, 1.3)
    sphere('tree', (x, y, g + 1.8 * s), 1.3 * s, segs=7, rings=4, sz=1.2)


# other ships at anchor ------------------------------------------------------
def small_ship(pos, yaw, s):
    with place(pos, yaw, s):
        L0, L1 = -14.0, 10.0
        hwf = lambda y: 3.2 * math.sqrt(max(0.0, 1 - ((y + 3) / (L0 + 3)) ** 2)) if y < -3 else 3.2 - 0.5 * ((y + 3) / 13) ** 2
        topf = lambda y: 1.0 + (2.0 * smooth((y - 3) / 1.0) if y > 3 else 0) + (1.2 * smooth((-8 - y) / 5) if y < -8 else 0)
        hull('hull', L0, L1, hwf, topf, step=0.6, keel=-3.4, transom_key='hull')
        deck('deck', L0 + 1, L1, 0.0, n=3, step=1.0)
        for my, h, yards in ((-7.0, 20, ((7, 6), (12, 4.5), (16, 3))), (0.5, 22, ((8, 7), (13.5, 5), (18, 3.4))), (7.5, 14, ((6, 4), (10, 3)))):
            tube('varnish', (0, my, 0), (0, my, h), 0.26, 0.12, segs=8)
            for yz, half in yards:
                tube('varnish', (-half, my - 0.2, yz), (half, my - 0.2, yz), 0.1, segs=6)
                tube('sail', (-half * 0.9, my - 0.05, yz - 0.22), (half * 0.9, my - 0.05, yz - 0.22), 0.18, segs=6)
            for sgn in (1, -1):
                tube('rope', (sgn * 0.8, my, h * 0.55), (sgn * (hwf(my) + 0.1), my + 1.2, 1.0), 0.03, segs=4)
        tube('varnish', (0, L0 + 1, 2.0), (0, L0 - 6, 4.2), 0.2, 0.09, segs=6)
        rope('rope', [Vector((0, -7, 20)), Vector((0, L0 - 6, 4.2))], 0.03)
        lantern((0, L1 + 0.3, topf(L1) + 0.6), s=2.4)
        for k in range(4):
            box('glass_warm', (-1.2 + 0.8 * k, L1 + 0.01, 1.0), (0.4, 0.02, 0.45))


small_ship((-26, -22, WATER_Z + 1.45), math.radians(35), 0.8)
small_ship((-44, 26, WATER_Z + 1.45), math.radians(-75), 0.85)
small_ship((-18, 44, WATER_Z + 1.45), math.radians(160), 0.7)


def rowboat(pos, yaw):
    with place(pos, yaw, 1.0):
        hwf = lambda y: 0.75 * math.sqrt(max(0.0, 1 - (y / 2.2) ** 2)) + 0.02
        hull('crate', -2.2, 2.2, hwf, lambda y: 0.35 + 0.1 * (y / 2.2) ** 2, step=0.2, keel=-0.4, transom_key=None)
        for yy in (-0.8, 0.4):
            box('crate', (0, yy, 0.18), (1.3, 0.25, 0.04), grain=0, tile=1.0)


rowboat((8.3, -42.5, WATER_Z + 0.1), 0.2)
rowboat((5.4, 27.0, WATER_Z + 0.1), -0.1)


# ════════════════════════════════════════════════════════════════════════
# Finalise meshes
# ════════════════════════════════════════════════════════════════════════
log("finalising meshes")
COLL = bpy.data.collections.new('Rexmaw'); SCN.collection.children.link(COLL)
EXPORT = []
for key, m in MBS.items():
    me = bpy.data.meshes.new(key)
    me.from_pydata([tuple(v) for v in m.v], [], m.f)
    uvl = me.uv_layers.new(name='UVMap')
    flat = [c for face in m.uv for uv in face for c in uv]
    uvl.data.foreach_set('uv', flat)
    me.polygons.foreach_set('use_smooth', m.sm)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) == 2 and lf[0].smooth != lf[1].smooth:
            e.smooth = False
        elif len(lf) == 2 and lf[0].smooth and lf[1].smooth and lf[0].normal.angle(lf[1].normal, 0) > math.radians(60):
            e.smooth = False
    bm.to_mesh(me); bm.free()
    me.materials.append(M[key])
    ob = bpy.data.objects.new(key, me)
    COLL.objects.link(ob)
    EXPORT.append(ob)
tri = sum(len(o.data.polygons) for o in EXPORT)
log(f"{len(EXPORT)} meshes, {tri} polys, {sum(len(o.data.vertices) for o in EXPORT)} verts")

if MODE in ('all', 'export'):
    bpy.ops.object.select_all(action='DESELECT')
    for o in EXPORT:
        o.select_set(True)
    bpy.context.view_layer.objects.active = EXPORT[0]
    glb = os.path.join(OUT, 'rexmaw_deck.glb')
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_image_format='JPEG', export_lights=False,
                              export_cameras=False)
    log(f"exported {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")

# ════════════════════════════════════════════════════════════════════════
# Preview rig (not exported): stand-in figure, app-like lights, cameras
# ════════════════════════════════════════════════════════════════════════
prev = bpy.data.collections.new('Preview'); SCN.collection.children.link(prev)
fig = mb('_fig')
MBS.clear()
M['_fig'] = make_mat('StandIn', color=(0.35, 0.55, 0.85), rough=0.5)
tube('_fig', (0, 0, 0.1), (0, 0, 1.35), 0.2, 0.18, segs=16, caps=True)
sphere('_fig', (0, 0, 1.5), 0.13, segs=16, rings=8)
m = MBS['_fig']
me = bpy.data.meshes.new('StandIn'); me.from_pydata([tuple(v) for v in m.v], [], m.f); me.materials.append(M['_fig'])
me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
so = bpy.data.objects.new('StandIn_1.6m', me); prev.objects.link(so)

world = bpy.data.worlds.new('AppAmbient'); SCN.world = world
try:
    world.use_nodes = True
except Exception:
    pass
bg = world.node_tree.nodes.get('Background')
bg.inputs['Color'].default_value = (*srgb_to_lin((1.0, 0.85, 0.69)), 1)
bg.inputs['Strength'].default_value = 0.55
sun = bpy.data.lights.new('Key', 'SUN'); sun.energy = 2.6; sun.color = srgb_to_lin((1.0, 0.71, 0.43))
sun.angle = math.radians(3)
sun.use_shadow = False      # the app's key light shadows only the avatar, never the room
so = bpy.data.objects.new('Key (golden preset)', sun); prev.objects.link(so)
kd = Vector((1.9, -1.3, 1.0)).normalized()
so.rotation_euler = kd.to_track_quat('Z', 'Y').to_euler()


def cam(name, loc, look, fov):
    c = bpy.data.cameras.new(name); c.sensor_fit = 'VERTICAL'; c.angle_y = math.radians(fov)
    c.clip_start = 0.1; c.clip_end = 100
    o = bpy.data.objects.new(name, c); prev.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o


CAMS = [
    cam('Cam_Full', (0, -2.9, 1.0), (0, 0, 0.85), 35),
    cam('Cam_Face', (0, -1.35, 1.45), (0, 0, 1.42), 20),
    cam('Cam_Wide', (4.5, -8.5, 3.8), (-0.5, 2.5, 1.6), 55),
    cam('Cam_Sunset', (0.5, 3.0, 1.6), (2.0, -12.0, 3.0), 50),
    cam('Cam_Port', (1.5, 0.5, 1.7), (-10, -2, 1.2), 50),
    cam('Cam_Aerial', (16, -18, 12), (0, -1, 1), 50),
    cam('Cam_Pier', (8.4, -12, 0.6), (1.5, 0, -0.8), 50),
    cam('Cam_Cabin', (2.7, 5.1, 1.65), (-1.2, 11.5, 0.9), 62),
    cam('Cam_CabinBack', (-1.5, 11.0, 1.6), (1.5, 5.0, 0.9), 62),
    cam('Cam_Portrait', (-0.95, 10.4, 1.45), (-0.95, 12.5, 1.4), 38),
]
SCN.camera = CAMS[0]
SCN.render.resolution_x = 1280; SCN.render.resolution_y = 720
for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        SCN.render.engine = eng
        break
    except Exception:
        continue
try:
    SCN.eevee.taa_render_samples = 16
except Exception:
    pass
SCN.view_settings.view_transform = 'Standard'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'rexmaw_deck.blend'))
log("saved .blend")

if MODE in ('all', 'preview'):
    for c in CAMS:
        SCN.camera = c
        SCN.render.filepath = os.path.join(OUT, f'preview_{c.name}.png')
        bpy.ops.render.render(write_still=True)
        log("rendered", c.name)
log("done")
