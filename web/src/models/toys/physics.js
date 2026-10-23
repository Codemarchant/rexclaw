// Physics shared by both toy stages (models/toys/screen_stage.js on the
// roaming desktop, models/toys/scene_stage.js in the 3D view). Everything is
// in metres and seconds with y up; the desktop stage converts at its edges
// through the roam shot's px per metre, so a ball falls, bounces and drifts
// the same on the desktop as in the room.
//
// A toy is a sphere for its motion (radius, mass): gravity, quadratic air
// drag against the air's own motion (so wind pushes a beach ball hard and a
// basketball barely), bounces with a coefficient of restitution, and a
// hollow ball's spin taking the friction at each bounce. The stage gives the
// world: floors and ledges, walls, the companion's body, the hoop.

export const GRAVITY = 9.81;            // m/s², the roam director's
export const AIR_DENSITY = 1.225;       // kg/m³, ISA sea level at 15 °C
// A ball's drag coefficient: about 0.5, from video of beach balls falling
// at their terminal speed (the general sphere value sits in a 0.07-0.5
// range that falls only past the drag crisis, far above toy speeds).
export const SPHERE_CD = 0.5;

// The round turbulent jet a fan or a hair dryer blows (Pope, Turbulent
// Flows, ch. 5, from Hussein, Capp & George 1994): the centreline speed
// falls as u0 · B · d / x past a few nozzle diameters, the jet's half-width
// grows as S · x, and across it the speed falls off as a Gaussian that is
// half the centreline's at that half-width. The turbulence intensity on the
// centreline is about a quarter of the mean speed there.
export const JET_DECAY_B = 5.8;
export const JET_SPREAD_S = 0.094;
export const JET_TURBULENCE = 0.25;

// Past this speed a thrown toy is clamped: a hard human throw (baseball
// pitchers top out near 45 m/s; a casual overhand toss is far below). The
// cap only keeps a flicked mouse from sending a toy to orbit. By eye.
export const MAX_THROW = 14;            // m/s

const LN2 = Math.log(2);

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (a) => {
    const l = len(a);
    return l > 1e-9 ? scale(a, 1 / l) : v3();
};
export const clampLen = (a, max) => {
    const l = len(a);
    return l > max ? scale(a, max / l) : a;
};

/** Drag per unit mass for a sphere of radius r and mass m: a = -k |v| v. */
export function dragK(r, m, cd = SPHERE_CD) {
    return (0.5 * AIR_DENSITY * cd * Math.PI * r * r) / m;
}

/** The air's velocity at `p` from one jet: nozzle at `o`, pointing along
 *  unit `dir`, nozzle diameter `d`, exit speed `u0`. `t` (s) drives the
 *  turbulence, `seed` keeps two jets from gusting in step. */
export function jetAt(p, o, dir, d, u0, t = 0, seed = 0) {
    const rel = sub(p, o);
    const x = dot(rel, dir);
    if (x <= 0) return null;
    // Near the nozzle the core still blows at the exit speed.
    const x0 = d * JET_DECAY_B;
    const uc = x <= x0 ? u0 : (u0 * JET_DECAY_B * d) / x;
    const radial = sub(rel, scale(dir, x));
    const r = len(radial);
    const half = Math.max(d / 2, JET_SPREAD_S * x);
    const u = uc * Math.exp(-LN2 * (r / half) ** 2);
    if (u < 0.05) return null;
    // Gusts: two incommensurate sines, a quarter of the speed at most.
    const gust = 1 + JET_TURBULENCE * (0.6 * Math.sin(t * 7.3 + seed) + 0.4 * Math.sin(t * 13.1 + seed * 2.7));
    return scale(dir, u * gust);
}

/** Speed after a bounce, along the surface, for a hollow ball rolling off
 *  it: the friction at the contact spins it up until it rolls, keeping
 *  1 / (1 + I/mr²) of the slide — a thin shell's I is ⅔ mr², so 3/5. A
 *  solid thing (a donut, a coin) keeps 5/7. */
export function rollKeep(shell) {
    return shell ? 3 / 5 : 5 / 7;
}

/** Launch speed that carries a body from `from` to `to` at elevation
 *  `angle` (rad) with drag k (per unit mass) and wind `wind`, found by
 *  bisection over a simulated flight; the flat direction is from → to.
 *  Returns the launch velocity, or null when nothing up to `vmax` reaches. */
export function solveLaunch(from, to, angle, k, { vmax = MAX_THROW, wind = v3(), dt = 1 / 120 } = {}) {
    const flat = { x: to.x - from.x, z: to.z - from.z };
    const range = Math.hypot(flat.x, flat.z);
    const dirx = range > 1e-6 ? flat.x / range : 0, dirz = range > 1e-6 ? flat.z / range : 0;
    const launch = (s) => ({ x: dirx * s * Math.cos(angle), y: s * Math.sin(angle), z: dirz * s * Math.cos(angle) });
    // How far along the flat line the body is when it comes back down to
    // the target's height (or passes it on the way up, for a target above).
    const reach = (s) => {
        let p = { ...from }, v = launch(s);
        for (let i = 0; i < 2400; i++) {
            const rel = sub(v, wind);
            const sp = len(rel);
            v = { x: v.x - k * sp * rel.x * dt, y: v.y - (GRAVITY + k * sp * rel.y) * dt, z: v.z - k * sp * rel.z * dt };
            p = add(p, scale(v, dt));
            if (v.y < 0 && p.y <= to.y) return (p.x - from.x) * dirx + (p.z - from.z) * dirz;
        }
        return -Infinity;
    };
    let lo = 0.2, hi = vmax;
    if (reach(hi) < range) return null;
    for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (reach(mid) < range) lo = mid; else hi = mid;
    }
    return launch(hi);
}

/** One step of free flight for toy `t` (p, v, spin) under gravity, drag
 *  and the wind field `windAt(p)`. Toys that float (gadgets set down in
 *  mid-air, held ones) don't move here. Buoyancy as a fraction of weight
 *  carried by the air (a soap bubble's air inside). */
export function fly(t, dt, windAt) {
    const def = t.def;
    const w = windAt ? windAt(t.p) : null;
    const rel = w ? sub(t.v, w) : t.v;
    const sp = len(rel);
    const k = t.k ?? (t.k = dragK(t.radius, t.mass, def.cd ?? SPHERE_CD));
    const lift = t.lift ?? def.buoyancy ?? 0;
    t.v = {
        x: t.v.x - k * sp * rel.x * dt,
        y: t.v.y - (GRAVITY * (1 - lift) + k * sp * rel.y) * dt,
        z: t.v.z - k * sp * rel.z * dt,
    };
    t.p = add(t.p, scale(t.v, dt));
}

/** Bounce `t` off a surface with unit normal `n` (pointing away from it)
 *  that it has gone `depth` into. Restitution along the normal, the roll
 *  along it; a bounce too slow to matter settles it. Returns the impact
 *  speed along the normal (0 when it wasn't moving into the surface). */
export function bounce(t, n, depth, { e = t.def.restitution, soft = 1 } = {}) {
    t.p = add(t.p, scale(n, depth));
    const vn = dot(t.v, n);
    if (vn >= 0) return 0;
    const vnVec = scale(n, vn);
    const vt = sub(t.v, vnVec);
    const keep = t.def.shell ? rollKeep(true) : (t.def.slides ? 0.92 : rollKeep(false));
    // A slow impact doesn't bounce (it would chatter on the floor forever).
    const out = -vn < 0.35 ? 0 : -vn * e * soft;
    t.v = add(scale(vt, keep), scale(n, out));
    return -vn;
}

/** Two toys overlapping: pushed apart along the line between them, with
 *  the impulse a collision of their restitutions and masses gives. */
export function collidePair(a, b) {
    const d = sub(b.p, a.p);
    const l = len(d);
    const r = a.radius + b.radius;
    if (l >= r || l < 1e-9) return false;
    const n = scale(d, 1 / l);
    const ma = a.mass, mb = b.mass;
    const pen = r - l;
    const fixedA = a.pinned, fixedB = b.pinned;
    if (fixedA && fixedB) return false;
    const wa = fixedA ? 0 : (fixedB ? 1 : mb / (ma + mb)), wb = 1 - wa;
    a.p = sub(a.p, scale(n, pen * wa));
    b.p = add(b.p, scale(n, pen * wb));
    const rv = dot(sub(b.v, a.v), n);
    if (rv >= 0) return true;
    const e = Math.min(a.def.restitution, b.def.restitution);
    const inv = (fixedA ? 0 : 1 / ma) + (fixedB ? 0 : 1 / mb);
    const j = (-(1 + e) * rv) / inv;
    if (!fixedA) a.v = sub(a.v, scale(n, j / ma));
    if (!fixedB) b.v = add(b.v, scale(n, j / mb));
    return true;
}

/** Closest point to `p` on the segment a–b. */
export function closestOnSegment(p, a, b) {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const s = l2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    return add(a, scale(ab, s));
}

/** A sphere against a torus (a hoop's ring: centre c, unit normal n,
 *  radius R, tube radius rt). Returns {n, depth} when they touch. */
export function sphereTorus(p, r, c, n, R, rt) {
    const rel = sub(p, c);
    const h = dot(rel, n);
    const inPlane = sub(rel, scale(n, h));
    const l = len(inPlane);
    const ring = l > 1e-9 ? add(c, scale(inPlane, R / l)) : add(c, scale(perp(n), R));
    const d = sub(p, ring);
    const dl = len(d);
    if (dl >= r + rt || dl < 1e-9) return null;
    return { n: scale(d, 1 / dl), depth: r + rt - dl };
}

function perp(n) {
    return Math.abs(n.y) < 0.9 ? norm({ x: -n.z, y: 0, z: n.x }) : { x: 1, y: 0, z: 0 };
}
