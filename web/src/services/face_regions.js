/**
 * Face regions — the avatar's own emotion expressions, split in two.
 *
 * Every VRM ships the same five emotion expressions (happy, relaxed, sad,
 * angry, surprised) authored by whoever made the model — the one facial
 * vocabulary that is on every avatar, whatever tool made it. The face
 * director builds its faces out of them, but a whole expression can't be
 * used while the character talks: its mouth fights the lip-sync (an open
 * grin under an "oh"), and a smile's closed-eye crescent is the wrong eyes
 * for a polite one. So each expression is split into an UPPER half (brows,
 * eyes, cheeks) and a MOUTH half, added to the face meshes as two new
 * morph targets — `rx:happy:upper`, `rx:happy:mouth`, … — that nothing but
 * the face director writes.
 *
 * Where the line falls comes from the model itself, not from a guess at
 * its proportions: a vertex the model's own blink moves is eye, one its
 * visemes (aa/ih/ou/ee/oh) move is mouth, and the rest go by height —
 * above or below the midpoint between the lowest eyelid vertex and the
 * highest lip vertex. Distance-based rather than exact, so a vertex beside
 * a moving lid is eye too: anime brows and lashes sit almost on top of
 * each other, and cutting between them would tear the shape.
 *
 * Only a shape that moves both the eyelids and the lips (a whole-face
 * "joy", as VRoid's Fcl_ALL_Joy) is cut vertex by vertex. Every other
 * shape an expression binds goes whole to one half, the way face rigs
 * mask each shape to its own region rather than feather one across a
 * seam: the mouth if it moves the visemes' vertices, else the upper face.
 *
 * The brow shapes are also kept on their own (`rx:<preset>:brow`): an upper
 * shape that moves no lid and sits above them, for the brow signals — a
 * raised brow without the surprised eyes' small pupils.
 *
 * A hidden layer goes with the mouth. Many VRChat faces keep blush, tears
 * and gloom as layers tucked inside the head, drawn to sit against the
 * face the whole expression makes — Shinano's blush lies on the cheeks
 * her smiling mouth raises, and with the eyes alone it cut through the
 * skin in blocks. Such a layer is one of an expression's shapes that
 * travels farther than the eyes are from the mouth, which no feature of
 * a face does.
 *
 * An expression made only of material or texture changes (no morphs) has
 * nothing to split; the face director falls back to the whole expression
 * for it.
 */

export const REGION_PRESETS = ["happy", "relaxed", "sad", "angry", "surprised"];
const VISEMES = ["aa", "ih", "ou", "ee", "oh"];
// A vertex counts as moved by an expression past this share of the
// expression's largest movement — below it is mesh noise, not the shape.
const MOVED = 0.1;
// Parts smaller than this (metres) move nothing visible and are skipped.
const MIN_PART = 1e-4;

/** The expression by preset name, falling back to a case-insensitive
 *  custom one (VRoid's 0.x "Surprised" is a custom group, not a preset). */
function findExpression(em, name) {
    return em.getExpression?.(name)
        || em.expressions?.find((e) => e.expressionName?.toLowerCase() === name) || null;
}

/** An expression's morph binds summed per vertex set. Primitives that share
 *  one position buffer (a VRoid face is split into several) are one entry:
 *  { pos, meshes, delta: Float32Array, ndelta: Float32Array|null }. */
function expressionField(expr) {
    return bindsField(expr?._binds || []);
}

/** As expressionField, for the given binds alone. */
function bindsField(binds) {
    const out = new Map();
    for (const bind of binds) {
        if (!bind.primitives || !Number.isInteger(bind.index)) continue;
        for (const mesh of bind.primitives) {
            const g = mesh.geometry;
            const ma = g?.morphAttributes?.position?.[bind.index];
            const pos = g?.attributes?.position;
            if (!ma || !pos) continue;
            let e = out.get(pos);
            if (!e) {
                const normals = g.morphAttributes.normal?.length === g.morphAttributes.position.length;
                e = { pos, meshes: new Set(), seen: new Set(), delta: new Float32Array(pos.count * 3),
                    ndelta: normals ? new Float32Array(pos.count * 3) : null };
                out.set(pos, e);
            }
            e.meshes.add(mesh);
            if (e.seen.has(ma)) continue;       // same buffer, another primitive
            e.seen.add(ma);
            const w = bind.weight;
            const rel = g.morphTargetsRelative !== false;
            for (let i = 0; i < pos.count; i++) {
                e.delta[i * 3] += w * (ma.getX(i) - (rel ? 0 : pos.getX(i)));
                e.delta[i * 3 + 1] += w * (ma.getY(i) - (rel ? 0 : pos.getY(i)));
                e.delta[i * 3 + 2] += w * (ma.getZ(i) - (rel ? 0 : pos.getZ(i)));
            }
            const na = e.ndelta && g.morphAttributes.normal[bind.index];
            if (na) {
                for (let i = 0; i < pos.count; i++) {
                    e.ndelta[i * 3] += w * na.getX(i);
                    e.ndelta[i * 3 + 1] += w * na.getY(i);
                    e.ndelta[i * 3 + 2] += w * na.getZ(i);
                }
            }
        }
    }
    return out;
}

/** How far the expression `name` moves the face at full weight: its
 *  largest vertex displacement, in the mesh's units (metres), or 0.
 *  `skip` (splitEmotionExpressions' `layers`) leaves the hidden layers out. */
export function expressionSize(vrm, name, skip = null) {
    let max = 0;
    for (const e of expressionField(findExpression(vrm?.expressionManager || {}, name)).values()) {
        const off = skip?.get(e.pos);
        for (let i = 0; i < e.pos.count; i++) {
            if (off?.has(i)) continue;
            max = Math.max(max, Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]));
        }
    }
    return max;
}

/** World-space position of vertex i of an entry (bind pose). */
function worldOf(e, i, THREE, v) {
    const mesh = e.meshes.values().next().value;
    return v.fromBufferAttribute(e.pos, i).applyMatrix4(mesh.matrixWorld);
}

/** The points an expression visibly moves, in world space. */
function movedPoints(field, THREE) {
    let max = 0;
    for (const e of field.values()) {
        for (let i = 0; i < e.pos.count; i++) {
            max = Math.max(max, Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]));
        }
    }
    const pts = [];
    if (!max) return pts;
    const v = new THREE.Vector3();
    for (const e of field.values()) {
        for (let i = 0; i < e.pos.count; i++) {
            if (Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]) > MOVED * max) {
                pts.push(worldOf(e, i, THREE, v).clone());
            }
        }
    }
    return pts;
}

/** The vertices an expression visibly moves, by vertex set:
 *  Map(position attribute → Set of vertex indices). */
function movedVertices(field) {
    let max = 0;
    for (const e of field.values()) {
        for (let i = 0; i < e.pos.count; i++) {
            max = Math.max(max, Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]));
        }
    }
    const out = new Map();
    if (!max) return out;
    for (const e of field.values()) {
        const set = out.get(e.pos) || out.set(e.pos, new Set()).get(e.pos);
        for (let i = 0; i < e.pos.count; i++) {
            if (Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]) > MOVED * max) set.add(i);
        }
    }
    return out;
}

/** Nearest-point lookups within `r`, on a uniform grid of cell size r. */
function pointGrid(points, r) {
    const cells = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    for (const p of points) {
        const k = key(Math.floor(p.x / r), Math.floor(p.y / r), Math.floor(p.z / r));
        (cells.get(k) || cells.set(k, []).get(k)).push(p);
    }
    return (p) => {
        const cx = Math.floor(p.x / r), cy = Math.floor(p.y / r), cz = Math.floor(p.z / r);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            for (const q of cells.get(key(cx + dx, cy + dy, cz + dz)) || []) {
                best = Math.min(best, p.distanceTo(q));
            }
        }
        return best;
    };
}

function percentile(values, q) {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Split the VRM's emotion expressions and add the halves as morph targets.
 * Returns { morphs: {name: [[mesh, index]]}, parts: {preset: {upper, mouth}},
 * layers } where `parts` says which halves exist and `layers` (Map: position
 * attribute → Set of vertex indices) the hidden layers' vertices, which a
 * measure of how far the face moves leaves out: a blush sliding out from
 * inside the head is no bigger a smile. Safe to call once per loaded VRM;
 * returns empty maps when the model has no blink or no visemes to measure
 * the face by.
 */
export function splitEmotionExpressions(vrm, THREE) {
    const morphs = {};
    const parts = {};
    const layers = new Map();
    const em = vrm?.expressionManager;
    if (!em) return { morphs, parts, layers };
    vrm.scene.updateMatrixWorld(true);
    const eyes = movedPoints(expressionField(findExpression(em, "blink")), THREE);
    const lips = VISEMES.flatMap((n) => movedPoints(expressionField(findExpression(em, n)), THREE));
    if (!eyes.length || !lips.length) return { morphs, parts, layers };

    // The face's own measures: the lowest eyelid point, the highest lip
    // point (2nd / 98th percentiles, so one stray vertex can't move them),
    // and a reach of a tenth of the eye-to-mouth distance.
    const eyeLow = percentile(eyes.map((p) => p.y), 0.02);
    const lipHigh = percentile(lips.map((p) => p.y), 0.98);
    const centre = (pts) => pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const reach = 0.1 * centre(eyes).distanceTo(centre(lips));
    const split = (eyeLow + lipHigh) / 2;
    const band = Math.max(Math.abs(eyeLow - lipHigh) / 2, reach);
    const nearEye = pointGrid(eyes, reach);
    const nearLip = pointGrid(lips, reach);
    const lidVerts = movedVertices(expressionField(findExpression(em, "blink")));
    const lipVerts = movedVertices(bindsField(VISEMES.flatMap((n) => findExpression(em, n)?._binds || [])));
    const upperCache = new Map();
    const v = new THREE.Vector3();

    /** 0..1: how far a world-space point belongs to the upper face. */
    const upperAt = (p) => {
        const ne = Math.max(0, 1 - nearEye(p) / reach);
        const nl = Math.max(0, 1 - nearLip(p) / reach);
        if (ne + nl > 0) return ne / (ne + nl);
        const t = Math.max(0, Math.min(1, (p.y - (split - band)) / (2 * band)));
        return t * t * (3 - 2 * t);
    };

    /** 0..1 per vertex: how far each vertex belongs to the upper face. */
    const upperOf = (e) => {
        let u = upperCache.get(e.pos);
        if (u) return u;
        u = new Float32Array(e.pos.count);
        for (let i = 0; i < e.pos.count; i++) u[i] = upperAt(worldOf(e, i, THREE, v));
        upperCache.set(e.pos, u);
        return u;
    };

    const eyeToMouth = centre(eyes).distanceTo(centre(lips));

    const lidTop = percentile(eyes.map((p) => p.y), 0.98);

    /** One bound shape: the half it goes to whole — "mouth" if it moves the
     *  lips, else "upper" — or null for a whole-face shape (it moves both
     *  the lids and the lips), which is cut vertex by vertex; `far`, how
     *  far it moves anything (world units); and `brow`, an upper shape
     *  that moves no lid and sits above them (not a pupil's). */
    const shapeOf = (bind) => {
        const field = bindsField([bind]);
        const moved = movedVertices(field);
        let lid = false, lip = false, far = 0;
        const ys = [];
        for (const e of field.values()) {
            const scale = e.meshes.values().next().value.matrixWorld.getMaxScaleOnAxis();
            for (const i of moved.get(e.pos) || []) {
                lid ||= !!lidVerts.get(e.pos)?.has(i);
                lip ||= !!lipVerts.get(e.pos)?.has(i);
                far = Math.max(far, scale * Math.hypot(e.delta[i * 3], e.delta[i * 3 + 1], e.delta[i * 3 + 2]));
                ys.push(worldOf(e, i, THREE, v).y);
            }
        }
        const brow = !lid && !lip && ys.length > 0 && percentile(ys, 0.5) > lidTop;
        return { field, far, brow, half: lid && lip ? null : lip ? "mouth" : "upper" };
    };

    for (const preset of REGION_PRESETS) {
        const binds = (findExpression(em, preset)?._binds || []).map(shapeOf);
        // A hidden layer among the expression's shapes (see the header)
        // goes with the mouth. A one-shape expression travelling as far is
        // a single whole-face sculpt (VRoid's Fcl_ALL_Joy moves its mouth
        // interior ~70 mm) and cuts fine.
        for (const b of binds) {
            if (binds.length < 2 || b.far <= eyeToMouth) continue;
            b.half = "mouth";
            b.brow = false;
            for (const e of b.field.values()) {
                const set = layers.get(e.pos) || layers.set(e.pos, new Set()).get(e.pos);
                for (let i = 0; i < e.pos.count; i++) {
                    if (e.delta[i * 3] || e.delta[i * 3 + 1] || e.delta[i * 3 + 2]) set.add(i);
                }
            }
        }
        // Per vertex set: the expression's movement shared out to the halves,
        // and its brow shapes on their own as well — the brow signals' share
        // of the upper half (a raised brow without the surprised eyes).
        const sets = new Map();
        const halves = () => ({ upper: null, mouth: null, brow: null });
        for (const { field, half, brow } of binds) {
            for (const e of field.values()) {
                const len = e.delta.length;
                let s = sets.get(e.pos);
                if (!s) {
                    s = { meshes: new Set(), delta: halves(), ndelta: e.ndelta ? halves() : null };
                    for (const h of ["upper", "mouth", "brow"]) {
                        s.delta[h] = new Float32Array(len);
                        if (s.ndelta) s.ndelta[h] = new Float32Array(len);
                    }
                    sets.set(e.pos, s);
                }
                e.meshes.forEach((m) => s.meshes.add(m));
                if (e.ndelta && !s.ndelta) {
                    s.ndelta = halves();
                    for (const h of ["upper", "mouth", "brow"]) s.ndelta[h] = new Float32Array(len);
                }
                const u = half ? null : upperOf(e);
                for (let i = 0; i < e.pos.count; i++) {
                    const share = half === "upper" ? 1 : half === "mouth" ? 0 : u[i];
                    for (let k = 0; k < 3; k++) {
                        s.delta.upper[i * 3 + k] += e.delta[i * 3 + k] * share;
                        s.delta.mouth[i * 3 + k] += e.delta[i * 3 + k] * (1 - share);
                        if (brow) s.delta.brow[i * 3 + k] += e.delta[i * 3 + k];
                        if (e.ndelta) {
                            s.ndelta.upper[i * 3 + k] += e.ndelta[i * 3 + k] * share;
                            s.ndelta.mouth[i * 3 + k] += e.ndelta[i * 3 + k] * (1 - share);
                            if (brow) s.ndelta.brow[i * 3 + k] += e.ndelta[i * 3 + k];
                        }
                    }
                }
            }
        }
        for (const s of sets.values()) {
            for (const half of ["upper", "mouth", "brow"]) {
                const d = s.delta[half];
                const n = s.ndelta?.[half] || null;
                let max = 0;
                for (let i = 0; i < d.length; i += 3) max = Math.max(max, Math.hypot(d[i], d[i + 1], d[i + 2]));
                if (max < MIN_PART) continue;
                const name = `rx:${preset}:${half}`;
                const posAttr = new THREE.Float32BufferAttribute(d, 3);
                const nrmAttr = n ? new THREE.Float32BufferAttribute(n, 3) : null;
                // One new target per geometry that draws these vertices; the
                // buffers themselves are shared, like the originals.
                for (const mesh of s.meshes) {
                    const g = mesh.geometry;
                    const idx = g.morphAttributes.position.length;
                    g.morphAttributes.position.push(posAttr);
                    if (g.morphAttributes.normal) g.morphAttributes.normal.push(nrmAttr || new THREE.Float32BufferAttribute(new Float32Array(d.length), 3));
                    mesh.morphTargetInfluences.push(0);
                    mesh.morphTargetDictionary[name] = idx;
                    (morphs[name] ||= []).push([mesh, idx]);
                }
                (parts[preset] ||= {})[half] = true;
            }
        }
    }
    return { morphs, parts, layers };
}
