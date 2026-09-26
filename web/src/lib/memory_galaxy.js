// Memory Galaxy layout — turns a companion's memories into a star map.
//
// Pure data, no three.js: the renderer (services/galaxy_renderer.js) draws
// whatever this returns. Pipeline:
//   1. tokens    — Intl.Segmenter words (so Japanese splits too), stopwords
//                  out, Harman's S-stemmer (SIGIR 1991) folds plurals.
//   2. vectors   — sublinear-tf × idf (Manning, Raghavan & Schütze, IR book
//                  §6.4.1), L2-normalised; cosine similarity via an
//                  inverted index.
//   3. topics    — Louvain modularity clustering (Blondel et al. 2008) on the
//                  k-nearest-neighbour similarity graph: memories that talk
//                  about the same things form one galaxy.
//   4. labels    — class-based TF-IDF (Grootendorst 2022, BERTopic):
//                  W(t,c) = tf(t,c) · log(1 + A / f(t)).
//   5. placement — galaxies arranged by a small force simulation (similar
//                  topics sit near each other); inside a galaxy the members
//                  run along a two-armed logarithmic spiral in the order they
//                  were remembered, oldest at the core, newest at the rim.
//
// Numbers marked "design" are visual choices, not measurements.

const STOPWORDS = new Set((
    "a about above after again against all also am an and any are as at be because been before " +
    "being below between both but by can cannot could did do does doing down during each even " +
    "ever every few for from further get gets getting got had has have having he her here hers " +
    "herself him himself his how i if in into is it its itself just let like made make makes " +
    "many may me might more most much must my myself no nor not now of off on once one only or " +
    "other ought our ours ourselves out over own really said same say says she should since so " +
    "some still such than that the their theirs them themselves then there these they this " +
    "those though through to too under until up upon us very was we were what when where which " +
    "while who whom why will with would you your yours yourself yourselves " +
    "don didn doesn isn wasn aren weren hasn haven hadn won wouldn shouldn couldn can't " +
    "user assistant companion thing things something anything nothing everything way time " +
    "times going went goes come came comes back yes okay ok want wants wanted told tell tells " +
    "asked ask asks feel feels felt think thinks thought know knows knew see sees saw keep " +
    "keeps kept put puts take takes took give gives gave use used uses well good new first " +
    "last next day days today tonight morning evening night week"
).split(/\s+/));

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;
const SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** Harman's S-stemmer: the three plural rules, nothing aggressive, so the
 *  folded key still reads as the word. */
function sStem(w) {
    if (CJK_RE.test(w) || w.length <= 3) return w;
    if (w.endsWith("ies") && !w.endsWith("eies") && !w.endsWith("aies")) return w.slice(0, -3) + "y";
    if (w.endsWith("es") && !w.endsWith("aes") && !w.endsWith("ees") && !w.endsWith("oes")) return w.slice(0, -1);
    if (w.endsWith("s") && !w.endsWith("us") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
}

/** Words of `text` → [stem, surface] pairs. */
function tokenize(text) {
    const out = [];
    const s = (text || "").toLowerCase().replace(/[‘’]/g, "'");
    const push = (raw) => {
        const w = raw.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, "");
        if (!w || STOPWORDS.has(w) || /^[\d.,:'-]+$/.test(w)) return;
        if (CJK_RE.test(w) ? w.length < 2 : w.length < 3) return;
        out.push([sStem(w), w]);
    };
    if (SEGMENTER) {
        for (const seg of SEGMENTER.segment(s)) if (seg.isWordLike) push(seg.segment);
    } else {
        for (const m of s.matchAll(/[\p{L}\p{N}'-]+/gu)) push(m[0]);
    }
    return out;
}

/** Deterministic PRNG (mulberry32) so a galaxy looks the same every visit. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rand) {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const K_NEIGHBOURS = 8;      // design: edges per memory in the similarity graph
const MIN_SIM = 0.08;        // design: weaker links are noise between short facts
const MIN_GALAXY = 3;        // design: smaller topic groups become stray stars
const KEYWORD_WEIGHT = 2;    // episodes' curated recall keywords count double
const RELATED = 6;

/** Sparse TF-IDF vectors (Map term → weight, L2-normalised). */
function buildVectors(mems) {
    const docs = mems.map((m) => {
        const counts = new Map();
        const add = (text, weight) => {
            for (const [stem] of tokenize(text)) counts.set(stem, (counts.get(stem) || 0) + weight);
        };
        add(m.content, 1);
        add((m.keywords || "").replace(/,/g, " "), KEYWORD_WEIGHT);
        return counts;
    });
    const df = new Map();
    for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
    const n = docs.length;
    const vectors = docs.map((d) => {
        const v = new Map();
        let norm = 0;
        for (const [t, tf] of d) {
            const f = df.get(t);
            if (f < 2) continue; // a word only one memory uses links nothing
            const w = (1 + Math.log(tf)) * Math.log(n / f);
            if (w <= 0) continue;
            v.set(t, w);
            norm += w * w;
        }
        norm = Math.sqrt(norm) || 1;
        for (const [t, w] of v) v.set(t, w / norm);
        return v;
    });
    return { vectors, df };
}

/** Top neighbours of every memory by cosine similarity. */
function nearestNeighbours(vectors) {
    const postings = new Map();
    vectors.forEach((v, i) => {
        for (const [t, w] of v) {
            if (!postings.has(t)) postings.set(t, []);
            postings.get(t).push([i, w]);
        }
    });
    return vectors.map((v, i) => {
        const scores = new Map();
        for (const [t, w] of v) {
            for (const [j, wj] of postings.get(t)) {
                if (j !== i) scores.set(j, (scores.get(j) || 0) + w * wj);
            }
        }
        return [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, Math.max(K_NEIGHBOURS, RELATED));
    });
}

/** Louvain: greedy modularity local moving, then fold each community into
 *  one node and repeat until nothing moves. `adj[i]` is a Map j → weight. */
function louvain(adj) {
    let graph = adj.map((m) => new Map(m));
    let self = graph.map(() => 0);
    let members = graph.map((_, i) => [i]);
    for (let level = 0; level < 12; level++) {
        const n = graph.length;
        const k = graph.map((m, i) => [...m.values()].reduce((a, b) => a + b, 0) + 2 * self[i]);
        const m2 = k.reduce((a, b) => a + b, 0);
        if (!m2) break;
        const comm = graph.map((_, i) => i);
        const tot = k.slice();
        let movedAny = false;
        for (let pass = 0; pass < 20; pass++) {
            let moved = false;
            for (let i = 0; i < n; i++) {
                const own = comm[i];
                tot[own] -= k[i];
                const links = new Map();
                for (const [j, w] of graph[i]) links.set(comm[j], (links.get(comm[j]) || 0) + w);
                let best = own;
                let bestGain = (links.get(own) || 0) - tot[own] * k[i] / m2;
                for (const [c, w] of links) {
                    const gain = w - tot[c] * k[i] / m2;
                    if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
                }
                comm[i] = best;
                tot[best] += k[i];
                if (best !== own) moved = true;
            }
            if (!moved) break;
            movedAny = true;
        }
        if (!movedAny) break;
        const ids = new Map();
        for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
        const next = [...ids.keys()].map(() => new Map());
        const nextSelf = [...ids.keys()].map(() => 0);
        const nextMembers = [...ids.keys()].map(() => []);
        for (let i = 0; i < n; i++) {
            const ci = ids.get(comm[i]);
            nextSelf[ci] += self[i];
            nextMembers[ci].push(...members[i]);
            for (const [j, w] of graph[i]) {
                const cj = ids.get(comm[j]);
                if (ci === cj) nextSelf[ci] += w / 2; // each edge is seen from both ends
                else next[ci].set(cj, (next[ci].get(cj) || 0) + w);
            }
        }
        if (next.length === n) break;
        graph = next;
        self = nextSelf;
        members = nextMembers;
    }
    return members;
}

/** c-TF-IDF top terms of each topic, returned as display words. */
function topicTerms(groups, mems, df, n) {
    const surface = new Map(); // stem → Map(surface → count)
    const classTf = groups.map((g) => {
        const tf = new Map();
        for (const i of g) {
            const m = mems[i];
            const toks = [...tokenize(m.content), ...tokenize((m.keywords || "").replace(/,/g, " "))];
            for (const [stem, word] of toks) {
                tf.set(stem, (tf.get(stem) || 0) + 1);
                if (!surface.has(stem)) surface.set(stem, new Map());
                const s = surface.get(stem);
                s.set(word, (s.get(word) || 0) + 1);
            }
        }
        return tf;
    });
    const total = new Map();
    let words = 0;
    for (const tf of classTf) for (const [t, c] of tf) { total.set(t, (total.get(t) || 0) + c); words += c; }
    const avg = words / Math.max(1, classTf.length);
    const display = (stem) => [...surface.get(stem)].sort((a, b) => b[1] - a[1])[0][0];
    return classTf.map((tf) => [...tf]
        // design: words in over a third of all memories (names, "love") label everything, so nothing
        .filter(([t]) => (df.get(t) || 0) <= n / 3 && (df.get(t) || 0) >= 2)
        .map(([t, c]) => [t, c * Math.log(1 + avg / total.get(t))])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([t]) => display(t)));
}

function centroid(vectors, group) {
    const c = new Map();
    for (const i of group) for (const [t, w] of vectors[i]) c.set(t, (c.get(t) || 0) + w);
    let norm = 0;
    for (const w of c.values()) norm += w * w;
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of c) c.set(t, w / norm);
    return c;
}

function cosine(a, b) {
    let s = 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    for (const [t, w] of small) { const o = big.get(t); if (o) s += w * o; }
    return s;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => scale(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Place galaxies: similar topics attract, all repel, none overlap. */
function placeGalaxies(clusters, sim) {
    const K = clusters.length;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spread = 2.2 * Math.sqrt(clusters.reduce((a, c) => a + c.radius * c.radius, 0));
    const pos = clusters.map((_, i) => {
        const y = K === 1 ? 0 : 1 - (2 * i + 1) / K;
        const r = Math.sqrt(1 - y * y);
        return [Math.cos(golden * i) * r * spread, y * spread * 0.6, Math.sin(golden * i) * r * spread];
    });
    const ITER = 500;
    for (let it = 0; it < ITER; it++) {
        const cool = 1 - it / ITER;
        const f = pos.map(() => [0, 0, 0]);
        for (let a = 0; a < K; a++) {
            for (let b = a + 1; b < K; b++) {
                const d = sub(pos[a], pos[b]);
                const dist = Math.max(len(d), 0.01);
                const u = scale(d, 1 / dist);
                const minD = (clusters[a].radius + clusters[b].radius) * 1.35;
                let push = (minD * minD * 0.5) / (dist * dist);
                if (dist < minD) push += (minD - dist) * 1.5;
                const s = sim[a][b];
                if (s > 0.02) push -= s * 3 * (dist - minD) / minD;
                for (let x = 0; x < 3; x++) { f[a][x] += u[x] * push; f[b][x] -= u[x] * push; }
            }
            for (let x = 0; x < 3; x++) f[a][x] -= pos[a][x] * 0.015;
        }
        for (let a = 0; a < K; a++) {
            const step = Math.min(len(f[a]), 4) * cool;
            const dir = norm(f[a]);
            for (let x = 0; x < 3; x++) pos[a][x] += dir[x] * step;
        }
    }
    const mean = [0, 1, 2].map((x) => pos.reduce((acc, p) => acc + p[x], 0) / K);
    return pos.map((p) => sub(p, mean));
}

const ARMS = 2;
const PITCH = (14 * Math.PI) / 180; // design, inside the 10–40° range of real spiral arms
const CORE_FRACTION = 0.14;

/** A point on a galaxy's arm: t 0 = core, 1 = rim. */
export function spiralPoint(g, t, arm, rand, spreadScale = 1) {
    const r = g.radius * (CORE_FRACTION + (1 - CORE_FRACTION) * t);
    const theta = g.phase + arm * (2 * Math.PI / ARMS) + Math.log(r / (g.radius * CORE_FRACTION)) / Math.tan(PITCH);
    const lateral = gauss(rand) * g.radius * 0.04 * (0.5 + t) * spreadScale;
    const vertical = gauss(rand) * g.radius * 0.025 * (1.4 - t) * spreadScale;
    const along = r + lateral;
    const [u, v, n] = [g.u, g.v, g.normal];
    const c = Math.cos(theta) * along;
    const s = Math.sin(theta) * along;
    return [0, 1, 2].map((x) => g.center[x] + u[x] * c + v[x] * s + n[x] * vertical);
}

const DAY = 86400000;
const RECENT_RECALL_DAYS = 3; // design: "recently recalled" pulse window

/** Build the whole map. `mems` = rows from /api/memories/list. */
export function buildGalaxy(mems) {
    const list = [...mems].sort((a, b) =>
        (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || a.id - b.id);
    const n = list.length;
    const { vectors, df } = buildVectors(list);
    const nn = nearestNeighbours(vectors);

    const adj = list.map(() => new Map());
    nn.forEach((row, i) => {
        for (const [j, s] of row.slice(0, K_NEIGHBOURS)) {
            if (s < MIN_SIM) break;
            adj[i].set(j, Math.max(adj[i].get(j) || 0, s));
            adj[j].set(i, Math.max(adj[j].get(i) || 0, s));
        }
    });

    const groups = louvain(adj)
        .filter((g) => g.length >= MIN_GALAXY)
        .sort((a, b) => b.length - a.length || Math.min(...a) - Math.min(...b));
    const clusterOf = new Int32Array(n).fill(-1);
    groups.forEach((g, c) => g.forEach((i) => { clusterOf[i] = c; }));

    const terms = topicTerms(groups, list, df, n);
    const cents = groups.map((g) => centroid(vectors, g));
    const sim = cents.map((a) => cents.map((b) => cosine(a, b)));

    const clusters = groups.map((g, c) => {
        const rand = rng(0x9e3779b9 ^ (c * 7919));
        // Discs tilt up to ~24° off horizontal: edge-on spirals read as streaks.
        const normal = norm([(rand() * 2 - 1) * 0.5, 1.6, (rand() * 2 - 1) * 0.5]);
        const u = norm(cross(normal, Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const v = cross(normal, u);
        return {
            id: c,
            label: terms[c].slice(0, 2).join(" · ") || "…",
            terms: terms[c],
            hue: (0.58 + c * 0.618034) % 1, // golden-angle hues stay distinct
            radius: 2.3 * Math.sqrt(g.length) + 2,
            size: g.length,
            normal, u, v,
            phase: rand() * Math.PI * 2,
            members: [...g].sort((a, b) => a - b), // list is time-sorted, so this is oldest first
        };
    });
    const centers = clusters.length ? placeGalaxies(clusters, sim) : [];
    clusters.forEach((c, i) => { c.center = centers[i]; });

    const positions = new Array(n);
    for (const c of clusters) {
        const rand = rng(0x51ed27 ^ (c.id * 104729));
        c.members.forEach((i, k) => {
            const t = c.members.length === 1 ? 0 : k / (c.members.length - 1);
            positions[i] = spiralPoint(c, t, k % ARMS, rand);
        });
    }
    const extent = Math.max(12, ...clusters.map((c) => len(c.center) + c.radius));
    const strayRand = rng(0x2545f491);
    for (let i = 0; i < n; i++) {
        if (positions[i]) continue;
        const dir = norm([gauss(strayRand), gauss(strayRand) * 0.6, gauss(strayRand)]);
        positions[i] = scale(dir, extent * (1.05 + strayRand() * 0.35));
    }

    const now = Date.now();
    const stars = list.map((m, i) => {
        const used = Date.parse(m.last_used_at || "") || 0;
        return {
            index: i,
            mem: m,
            cluster: clusterOf[i],
            pos: positions[i],
            born: Date.parse(m.created_at) || 0,
            episode: m.memory_type === "episode",
            core: m.scope === "core",
            recent: used > 0 && now - used < RECENT_RECALL_DAYS * DAY,
            seed: rng(m.id * 2654435761)(),
        };
    });
    const related = nn.map((row) => row
        .filter(([, s]) => s >= MIN_SIM)
        .slice(0, RELATED)
        .map(([j, s]) => ({ index: j, sim: s })));
    clusters.forEach((c) => { c.firstRank = c.members[0]; });

    return { stars, clusters, related, extent };
}
