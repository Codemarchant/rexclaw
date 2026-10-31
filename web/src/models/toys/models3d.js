// The toys as 3D models for the room view (models/toys/scene_stage.js),
// built from three.js shapes at their real size (catalog radius and art
// proportions) in the drawings' colours (models/toys/art.js). Toon shaded
// in three steps, like the avatars' MToon, so a donut doesn't look like it
// came from another game.
//
// Each model's origin is the toy's centre of mass (the physics sphere's
// centre); things that lie flat sit with their underside on the sphere's
// bottom. Gadgets face +X (a fan's head, a dryer's nozzle): the stage turns
// them to their aim. `parts` names what the stage animates.

import { puffHz, PUMPKIN_FACES, PUMPKIN_LID, BOO_S, BATS_ROUND, BATS_OUT, BAT_OUT_S, BAT_HZ, BAT_SPAN } from "./catalog";

let GRAD = null;

// An aquarium's air stone sends up bubbles a millimetre or two across,
// which rise at about a quarter of a metre a second (Clift, Grace & Weber,
// Bubbles, Drops and Particles, 1978); fish flakes float a moment and sink
// slowly (by eye).
const BUBBLE_RISE = 0.25;          // m/s
const FLAKE_SINK = 0.015;          // m/s

function toonRamp(THREE) {
    if (!GRAD) {
        GRAD = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
        GRAD.minFilter = GRAD.magFilter = THREE.NearestFilter;
        GRAD.needsUpdate = true;
    }
    return GRAD;
}

function canvasTex(THREE, w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

const rand = (a, b) => a + Math.random() * (b - a);

export function buildToyModel(THREE, def, radius = def.radius) {
    const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(THREE), ...extra });
    const g = new THREE.Group();
    const parts = {};
    const add = (geo, mat, x = 0, y = 0, z = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        g.add(m);
        return m;
    };
    const r = radius;
    switch (def.id) {
        case "basketball": {
            const tex = canvasTex(THREE, 512, 256, (c, w, h) => {
                c.fillStyle = "#e8742a";
                c.fillRect(0, 0, w, h);
                // Pebbled leather.
                for (let i = 0; i < 2500; i++) {
                    c.fillStyle = `rgba(${Math.random() < 0.5 ? "120,50,10" : "255,190,120"},0.18)`;
                    c.fillRect(Math.random() * w, Math.random() * h, 2, 2);
                }
                c.strokeStyle = "#1c1410";
                c.lineWidth = 6;
                const line = (pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); };
                line([[0, h / 2], [w, h / 2]]);
                line([[w * 0.25, 0], [w * 0.25, h]]);
                line([[w * 0.75, 0], [w * 0.75, h]]);
                for (const cx of [0, 0.5, 1]) {
                    const pts = [];
                    for (let i = 0; i <= 40; i++) {
                        const v = i / 40;
                        pts.push([(cx + 0.13 * Math.sin(Math.PI * v)) * w, v * h]);
                    }
                    line(pts);
                    line(pts.map(([x, y]) => [2 * cx * w - x, y]));
                }
            });
            add(new THREE.SphereGeometry(r, 36, 24), toon("#ffffff", { map: tex }));
            break;
        }
        case "donut": {
            const R = r * 0.66, tube = r * 0.33;
            const lie = (m) => { m.rotation.x = Math.PI / 2; return m; };
            const base = -r + tube;
            lie(add(new THREE.TorusGeometry(R, tube, 16, 36), toon("#d9a05b"), 0, base, 0));
            const icing = lie(add(new THREE.TorusGeometry(R, tube * 1.04, 16, 36), toon("#f472b6"), 0, base + tube * 0.32, 0));
            icing.scale.set(1, 1, 0.62);
            const sprinkles = new THREE.InstancedMesh(new THREE.CapsuleGeometry(r * 0.025, r * 0.08, 2, 4),
                toon("#ffffff"), 26);
            const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
            const cols = ["#facc15", "#38bdf8", "#f8fafc", "#a78bfa", "#34d399"].map((c) => new THREE.Color(c));
            for (let i = 0; i < 26; i++) {
                const a = Math.random() * Math.PI * 2, b = rand(-0.9, 0.9);
                const rr = R + Math.sin(b) * tube;
                const p = new THREE.Vector3(Math.cos(a) * rr, base + tube * 0.32 + Math.cos(b) * tube * 0.66, Math.sin(a) * rr);
                e.set(Math.PI / 2, Math.random() * Math.PI, Math.random() * Math.PI);
                m4.compose(p, q.setFromEuler(e), new THREE.Vector3(1, 1, 1));
                sprinkles.setMatrixAt(i, m4);
                sprinkles.setColorAt(i, cols[i % cols.length]);
            }
            g.add(sprinkles);
            break;
        }
        case "strawberry": {
            const pts = [[0, -1], [0.45, -0.85], [0.85, -0.35], [1, 0.2], [0.85, 0.65], [0.45, 0.9], [0, 0.95]]
                .map(([x, y]) => new THREE.Vector2(x * r, y * r));
            add(new THREE.LatheGeometry(pts, 20), toon("#e11d48"));
            const seeds = new THREE.InstancedMesh(new THREE.SphereGeometry(r * 0.06, 4, 3), toon("#fde68a"), 40);
            const m4 = new THREE.Matrix4();
            for (let i = 0; i < 40; i++) {
                const y = rand(-0.8, 0.7), a = Math.random() * Math.PI * 2;
                const rr = r * (y < 0.2 ? 0.45 + (y + 0.8) * 0.55 : 1 - (y - 0.2) * 0.6) * 1.01;
                m4.makeTranslation(Math.cos(a) * rr, y * r, Math.sin(a) * rr);
                seeds.setMatrixAt(i, m4);
            }
            g.add(seeds);
            const leaf = new THREE.Shape();
            for (let i = 0; i < 10; i++) {
                const a = (i / 10) * Math.PI * 2, rr = i % 2 ? r * 0.35 : r * 0.85;
                if (i) leaf.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else leaf.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
            }
            const l = add(new THREE.ShapeGeometry(leaf), toon("#16a34a", { side: THREE.DoubleSide }), 0, r * 0.93, 0);
            l.rotation.x = -Math.PI / 2;
            add(new THREE.CylinderGeometry(r * 0.06, r * 0.08, r * 0.5, 6), toon("#15803d"), 0, r * 1.15, 0);
            break;
        }
        case "chili": {
            const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(-r * 1.4, r * 0.3, 0), new THREE.Vector3(-r * 0.4, r * 0.25, 0),
                new THREE.Vector3(r * 0.6, -r * 0.05, 0), new THREE.Vector3(r * 1.3, -r * 0.7, 0),
            ]);
            const N = 24, M = 10;
            const geo = new THREE.TubeGeometry(curve, N, r * 0.42, M, false);
            const pos = geo.attributes.position;
            const c = new THREE.Vector3(), v = new THREE.Vector3();
            for (let i = 0; i <= N; i++) {
                curve.getPointAt(i / N, c);
                const taper = i === N ? 0.05 : Math.pow(1 - i / N, 0.6) * 0.9 + 0.1;
                for (let j = 0; j <= M; j++) {
                    const k = i * (M + 1) + j;
                    v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(taper).add(c);
                    pos.setXYZ(k, v.x, v.y, v.z);
                }
            }
            geo.computeVertexNormals();
            add(geo, toon("#dc2626"));
            const stem = add(new THREE.CylinderGeometry(r * 0.12, r * 0.3, r * 0.7, 8), toon("#16a34a"), -r * 1.65, r * 0.35, 0);
            stem.rotation.z = Math.PI / 2.4;
            break;
        }
        case "apple": {
            const pts = [[0, -0.92], [0.35, -0.98], [0.72, -0.82], [0.96, -0.4], [1, 0.1], [0.88, 0.58], [0.6, 0.86], [0.3, 0.86], [0.08, 0.68], [0, 0.64]]
                .map(([x, y]) => new THREE.Vector2(x * r, y * r));
            add(new THREE.LatheGeometry(pts, 28), toon("#e11d48"));
            const blush = add(new THREE.SphereGeometry(r * 0.6, 12, 8), toon("#f43f5e", { transparent: true, opacity: 0.5 }), -r * 0.45, r * 0.15, r * 0.55);
            blush.scale.set(1, 0.8, 0.4);
            const stem = add(new THREE.CylinderGeometry(r * 0.05, r * 0.07, r * 0.5, 6), toon("#78350f"), r * 0.05, r * 0.85, 0);
            stem.rotation.z = -0.25;
            const leaf = new THREE.Shape();
            leaf.moveTo(0, 0);
            leaf.quadraticCurveTo(r * 0.3, r * 0.3, r * 0.75, 0);
            leaf.quadraticCurveTo(r * 0.3, -r * 0.18, 0, 0);
            const lf = add(new THREE.ShapeGeometry(leaf), toon("#22c55e", { side: THREE.DoubleSide }), r * 0.1, r * 0.9, 0);
            lf.rotation.set(0.6, 0, 0.35);
            break;
        }
        case "banana": {
            // The stem end (t = 0) is the top when it's held up to peel:
            // the skin there comes off in three strips that hang down over
            // the lower half (parts.peel, shown as they're pulled).
            const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(-r * 3, r * 1.6, 0), new THREE.Vector3(-r * 1.6, -r * 0.1, 0),
                new THREE.Vector3(r * 0.3, -r * 0.8, 0), new THREE.Vector3(r * 2.2, -r * 0.4, 0), new THREE.Vector3(r * 3.1, r * 0.6, 0),
            ]);
            const taperAt = (s) => 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, Math.max(0, s * 1.05 - 0.02)));
            const tube = (t0, t1, rad, flat) => {
                const N = 20, M = flat ? 5 : 10;
                const pts = Array.from({ length: N + 1 }, (_, i) => curve.getPointAt(t0 + ((t1 - t0) * i) / N));
                const part = new THREE.CatmullRomCurve3(pts);
                const geo = new THREE.TubeGeometry(part, N, rad, M, false);
                const pos = geo.attributes.position;
                const c = new THREE.Vector3(), v = new THREE.Vector3();
                for (let i = 0; i <= N; i++) {
                    part.getPointAt(i / N, c);
                    const taper = taperAt(t0 + ((t1 - t0) * i) / N);
                    for (let j = 0; j <= M; j++) {
                        const k = i * (M + 1) + j;
                        v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(taper).add(c);
                        pos.setXYZ(k, v.x, v.y, v.z);
                    }
                }
                geo.computeVertexNormals();
                return geo;
            };
            const skin = toon("#facc15", { flatShading: true });
            const flesh = add(tube(0, 1, r * 0.66, false), toon("#fef9c3", { side: THREE.DoubleSide }));
            // Eaten down from the top (the bare half, t 0-0.5), a bite at
            // a time: the fruit rebuilt from where it's bitten to.
            let bitten = 0;
            parts.eatTo = (left) => {
                const t0 = Math.round(0.5 * (1 - left) * 40) / 40;
                if (t0 === bitten) return;
                bitten = t0;
                flesh.geometry.dispose();
                flesh.geometry = tube(t0, 1, r * 0.66, false);
            };
            const top = add(tube(0, 0.5, r * 0.8, true), skin);
            add(tube(0.48, 1, r * 0.8, true), skin);
            add(new THREE.SphereGeometry(r * 0.3, 8, 6), toon("#3f2a14"), r * 3.15, r * 0.65, 0);
            const stem = add(new THREE.CylinderGeometry(r * 0.22, r * 0.25, r * 0.7, 6), toon("#65a30d"), -r * 3.1, r * 1.9, 0);
            stem.rotation.z = 0.5;
            // The strips, from the middle down over the lower half, a third
            // of the way round each.
            const mid = curve.getPointAt(0.5), tan = curve.getTangentAt(0.5);
            const peel = [];
            for (let i = 0; i < 3; i++) {
                const strip = new THREE.Group();
                strip.position.copy(mid);
                strip.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan);
                const leaf = new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, r * 0.06, r * 0.8), skin);
                leaf.position.set(r * 1.1, r * 1.2, 0);
                leaf.rotation.z = 0.35;
                const pivot = new THREE.Group();
                pivot.rotation.x = (i / 3) * Math.PI * 2;
                pivot.add(leaf);
                strip.add(pivot);
                strip.visible = false;
                g.add(strip);
                peel.push(strip);
            }
            parts.peel = peel;
            parts.skinTop = [top, stem];
            break;
        }
        case "grape": {
            const grape = add(new THREE.SphereGeometry(r, 16, 12), toon("#7e22ce"));
            grape.scale.set(1, 1.15, 1);
            add(new THREE.SphereGeometry(r * 0.25, 8, 6), new THREE.MeshBasicMaterial({ color: "#e9d5ff" }), -r * 0.4, r * 0.45, r * 0.65);
            add(new THREE.CylinderGeometry(r * 0.08, r * 0.1, r * 0.5, 5), toon("#65a30d"), 0, r * 1.3, 0);
            break;
        }
        case "icecream": {
            // A waffle cone, point down, with a scoop on top (parts.scoop:
            // licked down, the stage shrinks it).
            const floor = -r, coneH = 0.075, coneR = 0.026;
            const waffle = canvasTex(THREE, 128, 128, (c, w, h) => {
                c.fillStyle = "#e0a458";
                c.fillRect(0, 0, w, h);
                c.strokeStyle = "#b9772f";
                c.lineWidth = 5;
                for (let i = -w; i < w * 2; i += 22) {
                    c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.stroke();
                    c.beginPath(); c.moveTo(i, h); c.lineTo(i + h, 0); c.stroke();
                }
            });
            waffle.wrapS = waffle.wrapT = THREE.RepeatWrapping;
            waffle.repeat.set(3, 2);
            const cone = add(new THREE.CylinderGeometry(coneR, 0.003, coneH, 20, 1, true), toon("#ffffff", { map: waffle, side: THREE.DoubleSide }),
                0, floor + coneH / 2, 0);
            cone.castShadow = true;
            add(new THREE.TorusGeometry(coneR, 0.004, 8, 24), toon("#c98a3f"), 0, floor + coneH, 0).rotation.x = Math.PI / 2;
            const scoop = new THREE.Group();
            scoop.position.y = floor + coneH;
            g.add(scoop);
            const cream = toon("#fff7e0");
            const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), cream);
            ball.position.y = 0.022;
            scoop.add(ball);
            // The soft ruff where it meets the cone, and a drip.
            const ruff = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 8, 20), cream);
            ruff.rotation.x = Math.PI / 2;
            ruff.position.y = 0.004;
            scoop.add(ruff);
            const drip = new THREE.Mesh(new THREE.CapsuleGeometry(0.004, 0.012, 4, 8), cream);
            drip.position.set(0.024, -0.006, 0.008);
            scoop.add(drip);
            parts.scoop = scoop;
            break;
        }
        case "rugby": {
            // Long axis along +X. Its panels, two coloured bands and the
            // lace panel painted on (v along the long axis).
            const tex = canvasTex(THREE, 512, 256, (c, w, h) => {
                c.fillStyle = "#f8fafc";
                c.fillRect(0, 0, w, h);
                for (let i = 0; i < 1800; i++) {
                    c.fillStyle = "rgba(100,116,139,0.12)";
                    c.fillRect(Math.random() * w, Math.random() * h, 2, 2);
                }
                for (const [y, col] of [[0.22, "#1d4ed8"], [0.27, "#dc2626"], [0.73, "#dc2626"], [0.78, "#1d4ed8"]]) {
                    c.fillStyle = col;
                    c.fillRect(0, y * h - h * 0.022, w, h * 0.044);
                }
                c.strokeStyle = "#94a3b8";
                c.lineWidth = 3;
                for (let i = 0; i < 4; i++) {
                    c.beginPath(); c.moveTo((i * w) / 4, 0); c.lineTo((i * w) / 4, h); c.stroke();
                }
                c.strokeStyle = "#334155";
                c.lineWidth = 4;
                for (let i = 0; i < 6; i++) {
                    const y = h * (0.4 + i * 0.04);
                    c.beginPath(); c.moveTo(w * 0.1, y); c.lineTo(w * 0.15, y); c.stroke();
                }
            });
            const geo = new THREE.SphereGeometry(r, 36, 24);
            geo.scale(1, def.long, 1);
            geo.rotateZ(-Math.PI / 2);
            add(geo, toon("#ffffff", { map: tex }));
            break;
        }
        case "desk":
        case "floorlamp":
        case "lantern":
        case "lava":
        case "candles":
        case "jar":
        case "moon":
        case "neon":
        case "campfire":
        case "galaxy":
        case "aquarium":
        case "pumpkin":
            buildLamp(THREE, def, r, g, parts, add, toon);
            break;
        case "noodles":
        case "tea":
        case "coffee":
        case "water":
            buildVessel(THREE, def, r, g, parts, add, toon);
            break;
        case "cupcake": {
            const cup = add(new THREE.CylinderGeometry(r * 0.85, r * 0.62, r * 0.9, 16, 1), toon("#f472b6", { flatShading: true }), 0, -r * 0.55, 0);
            cup.castShadow = true;
            for (let i = 0; i < 4; i++) {
                const tor = add(new THREE.TorusGeometry(r * (0.85 - i * 0.18), r * 0.22, 10, 24), toon("#fdf2f8"), 0, r * (0.0 + i * 0.22), 0);
                tor.rotation.x = Math.PI / 2;
            }
            add(new THREE.SphereGeometry(r * 0.22, 12, 8), toon("#e11d48"), 0, r * 0.95, 0);
            break;
        }
        case "football": {
            // The 12 black pentagons at an icosahedron's corners on white,
            // painted per pixel onto the sphere's map.
            const phi = (1 + Math.sqrt(5)) / 2;
            const corners = [[-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0], [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
                [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]].map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
            const tex = canvasTex(THREE, 512, 256, (c, w, h) => {
                const img = c.createImageData(w, h);
                for (let py = 0; py < h; py++) {
                    const th = (py / h) * Math.PI;
                    for (let px = 0; px < w; px++) {
                        const ph = (px / w) * Math.PI * 2;
                        const d = [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
                        let best = -2, second = -2;
                        for (const q of corners) {
                            const dd = q[0] * d[0] + q[1] * d[1] + q[2] * d[2];
                            if (dd > best) { second = best; best = dd; } else if (dd > second) second = dd;
                        }
                        let v = 245;
                        if (best > 0.9) v = 30;                       // the pentagon
                        else if (best - second < 0.012) v = 150;       // a seam
                        const i = (py * w + px) * 4;
                        img.data[i] = img.data[i + 1] = v;
                        img.data[i + 2] = v + (v > 200 ? 5 : 0);
                        img.data[i + 3] = 255;
                    }
                }
                c.putImageData(img, 0, 0);
            });
            add(new THREE.SphereGeometry(r, 36, 24), toon("#ffffff", { map: tex }));
            break;
        }
        case "hardtack": {
            const th = r * 0.4;
            add(new THREE.BoxGeometry(r * 1.85, th, r * 1.85, 2, 1, 2), toon("#e9c46a"), 0, -r + th / 2, 0);
            const holes = new THREE.InstancedMesh(new THREE.CylinderGeometry(r * 0.06, r * 0.06, th * 0.2, 8), toon("#a16207"), 16);
            const m4 = new THREE.Matrix4();
            for (let i = 0; i < 16; i++) {
                m4.makeTranslation((-0.6 + 0.4 * (i % 4)) * r, -r + th, (-0.6 + 0.4 * Math.floor(i / 4)) * r);
                holes.setMatrixAt(i, m4);
            }
            g.add(holes);
            break;
        }
        case "coin": {
            add(new THREE.CylinderGeometry(r, r, r * 0.14, 28), toon("#eab308", { emissive: "#422006" }), 0, -r + r * 0.07, 0);
            add(new THREE.TorusGeometry(r * 0.7, r * 0.06, 6, 24), toon("#a16207"), 0, -r + r * 0.15, 0).rotation.x = Math.PI / 2;
            break;
        }
        case "wand": {
            const handle = add(new THREE.CylinderGeometry(r * 0.07, r * 0.07, r * 1.4, 10), toon("#f472b6"), 0, -r * 0.25, 0);
            handle.castShadow = true;
            // The ring faces the way the wand's held (front on).
            const ring = add(new THREE.TorusGeometry(r * 0.32, r * 0.05, 8, 28), toon("#ec4899"), 0, r * 0.78, 0);
            const film = add(new THREE.CircleGeometry(r * 0.3, 24), new THREE.MeshPhysicalMaterial({
                color: "#ffffff", transparent: true, opacity: 0.25, roughness: 0.05, iridescence: 1,
                iridescenceIOR: 1.33, iridescenceThicknessRange: [200, 800], side: THREE.DoubleSide, depthWrite: false,
            }), 0, r * 0.78, 0);
            parts.ring = ring;
            parts.film = film;
            break;
        }
        case "fan": {
            // A pedestal fan: base on the floor (the sphere's bottom), the head
            // at def.headY.
            // The stand is a unit-tall pole the stage stretches to the head's
            // height (Shift + wheel).
            const floor = -r, headY = floor + def.headY;
            add(new THREE.CylinderGeometry(r * 0.85, r * 0.95, 0.03, 32), toon("#64748b"), 0, floor + 0.015, 0);
            add(new THREE.CylinderGeometry(0.03, 0.04, 0.06, 16), toon("#475569"), 0, floor + 0.05, 0);
            const pole = add(new THREE.CylinderGeometry(0.014, 0.018, 1, 10), toon("#94a3b8"), 0, floor + (def.headY - 0.12) / 2, 0);
            pole.scale.y = def.headY - 0.12;
            parts.pole = pole;
            const head = new THREE.Group();
            head.position.set(0, headY, 0);
            g.add(head);
            const motor = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.08, 4, 12), toon("#cbd5e1"));
            motor.rotation.z = Math.PI / 2;
            motor.position.x = -0.06;
            head.add(motor);
            const cageR = def.jet.d / 2 + 0.01;
            const cageMat = toon("#475569");
            const rim = new THREE.Mesh(new THREE.TorusGeometry(cageR, 0.006, 6, 40), cageMat);
            rim.rotation.y = Math.PI / 2;
            rim.position.x = 0.06;
            head.add(rim);
            for (let i = 0; i < 12; i++) {
                const a = (i / 12) * Math.PI * 2;
                for (const x of [0.02, 0.1]) {
                    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, cageR, 4), cageMat);
                    spoke.position.set(x, Math.sin(a) * cageR / 2, Math.cos(a) * cageR / 2);
                    spoke.rotation.x = -a;
                    head.add(spoke);
                }
            }
            const blades = new THREE.Group();
            blades.position.x = 0.06;
            head.add(blades);
            const bladeMat = toon("#38bdf8", { side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
            for (let i = 0; i < 3; i++) {
                const b = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6), bladeMat);
                b.scale.set(0.006, cageR * 0.48, cageR * 0.2);
                const a = (i / 3) * Math.PI * 2;
                b.position.set(0, Math.sin(a) * cageR * 0.48, Math.cos(a) * cageR * 0.48);
                b.rotation.x = -a;
                b.rotation.y = 0.35;
                blades.add(b);
            }
            const hub = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), toon("#0ea5e9"));
            hub.position.x = 0.06;
            head.add(hub);
            parts.head = head;
            parts.blades = blades;
            break;
        }
        case "dryer": {
            // Along +X: a rounded barrel (a lathe profile, its back domed
            // over the motor), a satin metal band, a flattened air
            // concentrator, the intake grille with the heater's glow behind
            // it, a soft-touch grip with two switches, and its cord.
            const along = (geo) => { geo.rotateZ(-Math.PI / 2); return geo; };
            const barrelProfile = [[0, -0.1], [0.022, -0.098], [0.034, -0.088], [0.039, -0.07], [0.04, -0.02], [0.039, 0.05],
                [0.036, 0.07], [0.033, 0.078]].map(([x, y]) => new THREE.Vector2(x, y));
            add(along(new THREE.LatheGeometry(barrelProfile, 32)), toon("#c084fc"), 0, 0.02, 0);
            const band = add(along(new THREE.CylinderGeometry(0.0405, 0.0405, 0.012, 32)), new THREE.MeshStandardMaterial({
                color: "#e9d5ff", metalness: 0.7, roughness: 0.3,
            }), 0.02, 0.02, 0);
            band.castShadow = true;
            // The concentrator: a cone, squashed to a slot.
            const conc = add(along(new THREE.CylinderGeometry(0.02, 0.033, 0.055, 24, 1, true)), toon("#6b21a8", { side: THREE.DoubleSide }), 0.105, 0.02, 0);
            conc.scale.set(1, 1, 0.55);
            const lip = add(along(new THREE.TorusGeometry(0.02, 0.003, 8, 24)), toon("#4c1d95"), 0.1325, 0.02, 0);
            lip.rotation.set(0, Math.PI / 2, 0);
            lip.scale.set(0.55, 1, 1);
            // The intake: rings over a dark back, the heater glowing through.
            const back = add(new THREE.CircleGeometry(0.03, 24), toon("#2e1065"), -0.099, 0.02, 0);
            back.rotation.y = -Math.PI / 2;
            for (const rr of [0.012, 0.021, 0.029]) {
                const ring = add(new THREE.TorusGeometry(rr, 0.0018, 6, 24), toon("#a78bfa"), -0.1, 0.02, 0);
                ring.rotation.y = Math.PI / 2;
            }
            const glow = add(new THREE.CircleGeometry(0.026, 24), new THREE.MeshBasicMaterial({
                color: "#fb923c", transparent: true, opacity: 0, toneMapped: false,
            }), -0.0985, 0.02, 0);
            glow.rotation.y = -Math.PI / 2;
            // The grip, angled back under the barrel, with its switches.
            const grip = new THREE.Group();
            grip.position.set(-0.022, -0.015, 0);
            grip.rotation.z = -0.28;
            g.add(grip);
            const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, 0.1, 6, 16), toon("#a855f7"));
            handle.position.y = -0.06;
            handle.scale.set(1, 1, 1.15);
            grip.add(handle);
            const rubber = new THREE.Mesh(new THREE.CapsuleGeometry(0.0175, 0.05, 6, 16), toon("#581c87"));
            rubber.position.set(0.002, -0.08, 0);
            rubber.scale.set(1, 1, 1.18);
            grip.add(rubber);
            for (const [y, c] of [[-0.03, "#f5d0fe"], [-0.048, "#f472b6"]]) {
                const sw = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.014), toon(c));
                sw.position.set(0.018, y, 0);
                grip.add(sw);
            }
            const cord = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
                new THREE.Vector3(0, -0.13, 0), new THREE.Vector3(-0.01, -0.17, 0.01), new THREE.Vector3(-0.04, -0.2, 0.03),
                new THREE.Vector3(-0.09, -0.21, 0.04)]), 16, 0.004, 6), toon("#374151"));
            grip.add(cord);
            parts.glow = glow;
            break;
        }
        case "fogger": {
            const floor = -r;
            add(new THREE.BoxGeometry(0.3, 0.2, 0.2), toon("#334155"), 0, floor + 0.1 + 0.02, 0);
            for (const z of [-0.07, 0.07]) for (const x of [-0.11, 0.11]) add(new THREE.BoxGeometry(0.03, 0.02, 0.03), toon("#0f172a"), x, floor + 0.01, z);
            const nozzle = add(new THREE.CylinderGeometry(0.025, 0.03, 0.05, 14), toon("#1e293b"), 0.17, floor + 0.12, 0);
            nozzle.rotation.z = Math.PI / 2;
            const led = add(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: "#64748b" }), 0.12, floor + 0.07, 0.101);
            parts.led = led;
            break;
        }
        case "disco": {
            add(new THREE.IcosahedronGeometry(r, 3), new THREE.MeshPhongMaterial({
                color: "#cbd5e1", specular: "#ffffff", shininess: 140, flatShading: true, emissive: "#1e293b",
            }));
            add(new THREE.CylinderGeometry(0.004, 0.004, 3, 6), toon("#94a3b8"), 0, r + 1.5, 0);
            add(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10), toon("#64748b"), 0, r + 0.01, 0);
            break;
        }
        case "gerald": {
            const grey = toon("#94a3b8"), dark = toon("#64748b");
            const body = add(new THREE.SphereGeometry(1, 24, 16), grey);
            body.scale.set(r * 1.25, r * 0.78, r * 0.72);
            const belly = add(new THREE.SphereGeometry(1, 20, 12), toon("#f1f5f9"), r * 0.08, -r * 0.18, 0);
            belly.scale.set(r * 1.05, r * 0.55, r * 0.62);
            const fin = add(new THREE.ConeGeometry(r * 0.32, r * 0.55, 3), dark, -r * 0.1, r * 0.82, 0);
            fin.scale.z = 0.35;
            fin.rotation.z = 0.25;
            for (const s of [1, -1]) {
                const tail = add(new THREE.ConeGeometry(r * 0.22, r * 0.55, 3), dark, -r * 1.35, s * r * 0.22, 0);
                tail.rotation.z = Math.PI / 2 + s * 0.6;
                tail.scale.z = 0.35;
                const pec = add(new THREE.ConeGeometry(r * 0.18, r * 0.45, 3), dark, r * 0.1, -r * 0.45, s * r * 0.55);
                pec.rotation.x = s * 0.9;
                pec.scale.z = 0.4;
            }
            for (const s of [1, -1]) {
                add(new THREE.SphereGeometry(r * 0.09, 10, 8), toon("#0f172a"), r * 0.85, r * 0.2, s * r * 0.42);
                add(new THREE.SphereGeometry(r * 0.03, 6, 4), new THREE.MeshBasicMaterial({ color: "#ffffff" }), r * 0.9, r * 0.25, s * r * 0.48);
                add(new THREE.SphereGeometry(r * 0.08, 8, 6), toon("#fda4af"), r * 0.75, -r * 0.05, s * r * 0.55).scale.set(1, 0.5, 0.3);
            }
            const mouth = add(new THREE.TorusGeometry(r * 0.25, r * 0.03, 6, 16, Math.PI * 0.9), toon("#1e293b"), r * 1.12, -r * 0.08, 0);
            mouth.rotation.set(0, Math.PI / 2, Math.PI * 1.05);
            break;
        }
        case "chest": {
            const floor = -r, W = 0.3, H = 0.17, D = 0.2;
            const wood = toon("#8b5a2b"), metal = toon("#475569");
            add(new THREE.BoxGeometry(W, H, D), wood, 0, floor + H / 2, 0);
            for (const x of [-0.1, 0.1]) add(new THREE.BoxGeometry(0.025, H + 0.004, D + 0.004), metal, x, floor + H / 2, 0);
            const glow = add(new THREE.PlaneGeometry(W * 0.9, D * 0.9), new THREE.MeshBasicMaterial({ color: "#fde047", transparent: true, opacity: 0 }), 0, floor + H - 0.01, 0);
            glow.rotation.x = -Math.PI / 2;
            // The lid, hinged along the back top edge.
            const lid = new THREE.Group();
            lid.position.set(0, floor + H, -D / 2);
            g.add(lid);
            const top = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, W, 20, 1, false, 0, Math.PI), wood);
            top.rotation.z = Math.PI / 2;
            top.rotation.y = Math.PI / 2;
            top.position.set(0, 0, D / 2);
            lid.add(top);
            for (const x of [-0.1, 0.1]) {
                const band = new THREE.Mesh(new THREE.CylinderGeometry(D / 2 + 0.003, D / 2 + 0.003, 0.025, 20, 1, false, 0, Math.PI), metal);
                band.rotation.z = Math.PI / 2;
                band.rotation.y = Math.PI / 2;
                band.position.set(x, 0, D / 2);
                lid.add(band);
            }
            add(new THREE.BoxGeometry(0.04, 0.05, 0.012), toon("#facc15"), 0, floor + H - 0.02, D / 2 + 0.006);
            parts.lid = lid;
            parts.glow = glow;
            break;
        }
        case "bottle": {
            const prof = [[0, -0.14], [0.034, -0.14], [0.037, -0.12], [0.037, 0.05], [0.03, 0.09], [0.014, 0.11], [0.013, 0.16], [0, 0.16]]
                .map(([x, y]) => new THREE.Vector2(x, y));
            const glass = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), new THREE.MeshPhysicalMaterial({
                color: "#34d399", transparent: true, opacity: 0.5, roughness: 0.08, clearcoat: 1, depthWrite: false,
            }));
            const inner = new THREE.Group();
            inner.add(glass);
            const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.011, 0.03, 10), toon("#b45309"));
            cork.position.y = 0.17;
            inner.add(cork);
            const note = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.11, 10), toon("#fef3c7"));
            note.position.y = -0.04;
            inner.add(note);
            inner.rotation.z = -Math.PI / 2;
            inner.position.y = -r + 0.037;
            g.add(inner);
            break;
        }
        case "bubble": {
            add(new THREE.SphereGeometry(r, 16, 12), bubbleMaterial(THREE));
            break;
        }
        default:
            add(new THREE.SphereGeometry(r, 16, 12), toon("#f472b6"));
    }
    g.traverse((o) => {
        // (Light itself, water and glass cast none.)
        if (o.isMesh && def.id !== "bubble" && !o.userData.clear) { o.castShadow = true; o.receiveShadow = true; }
    });
    return { group: g, parts };
}

let BUBBLE_MAT = null;
/** A soap film: clear where you look straight through it, bright at the
 *  rim where you see it edge on (the film is thickest along the line of
 *  sight there), in the swirling colours of its interference, with a glint
 *  of the light. Its `time` uniform swirls the colours (the stage sets it). */
export function bubbleMaterial(THREE) {
    BUBBLE_MAT ||= new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 } },
        vertexShader: /* glsl */`
            varying vec3 vN;
            varying vec3 vV;
            varying vec3 vP;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vN = normalize(normalMatrix * normal);
                vV = normalize(-mv.xyz);
                vP = position;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform float time;
            varying vec3 vN;
            varying vec3 vV;
            varying vec3 vP;
            void main() {
                float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
                float f = pow(rim, 2.0);
                float swirl = f * 1.6 + vP.y * 18.0 + time * 0.6;
                vec3 film = 0.55 + 0.45 * cos(6.2831 * (swirl + vec3(0.0, 0.33, 0.67)));
                vec3 col = mix(vec3(1.0), film, 0.7);
                float glint = pow(max(0.0, dot(normalize(vN), normalize(vec3(-0.45, 0.6, 0.66)))), 60.0);
                float a = 0.05 + f * 0.75 + glint;
                gl_FragColor = vec4(col + glint, clamp(a, 0.0, 1.0));
                #include <colorspace_fragment>
            }`,
        transparent: true,
        depthWrite: false,
    });
    return BUBBLE_MAT;
}

/** The futsal goal (catalog GOAL): its goal line's middle at the origin,
 *  facing +Z out to the pitch; white posts and bar, a net behind. */
export function buildGoalModel(THREE, GOAL) {
    const g = new THREE.Group();
    const white = new THREE.MeshToonMaterial({ color: "#f8fafc", gradientMap: toonRamp(THREE) });
    const W = GOAL.width / 2 + GOAL.post, H = GOAL.height + GOAL.post, D = GOAL.depth, P = GOAL.post;
    const bar = (len, x, y, z, rx = 0, rz = 0) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(P, P, len, 16), white);
        m.position.set(x, y, z);
        m.rotation.set(rx, 0, rz);
        m.castShadow = true;
        g.add(m);
        return m;
    };
    bar(H, -W, H / 2, 0);
    bar(H, W, H / 2, 0);
    bar(2 * W, 0, H, 0, 0, Math.PI / 2);
    // The frame holding the net out behind: thin, grey.
    const grey = new THREE.MeshToonMaterial({ color: "#94a3b8", gradientMap: toonRamp(THREE) });
    // From the bar's ends back down to the ground behind.
    const slope = Math.atan2(D, H);
    for (const x of [-W, W]) {
        const back = new THREE.Mesh(new THREE.CylinderGeometry(P * 0.4, P * 0.4, Math.hypot(D, H), 8), grey);
        back.position.set(x, H / 2, -D / 2);
        back.rotation.x = slope;
        g.add(back);
    }
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(P * 0.4, P * 0.4, 2 * W, 8), grey);
    ground.position.set(0, P * 0.4, -D);
    ground.rotation.z = Math.PI / 2;
    g.add(ground);
    // The net: a mesh of white lines over the back, the roof and the sides.
    const net = new THREE.MeshBasicMaterial({ color: "#f8fafc", wireframe: true, transparent: true, opacity: 0.7 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2 * W, Math.hypot(D, H), 24, 16), net);
    back.position.set(0, H / 2, -D / 2);
    back.rotation.x = slope;
    g.add(back);
    // The sides: triangles of mesh between a post, the ground and the
    // back frame.
    const pts = [];
    for (const x of [-W, W]) {
        const ny = 16, nz = 6;
        for (let j = 0; j <= ny; j++) {
            const y = (H * j) / ny, deep = D * (1 - y / H);
            pts.push(x, y, 0, x, y, -deep);
        }
        for (let i = 1; i <= nz; i++) {
            const z = -(D * i) / nz;
            pts.push(x, 0, z, x, H * (1 + z / D), z);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: "#f8fafc", transparent: true, opacity: 0.7 })));
    return { group: g };
}

/** The hoop (catalog HOOP): base on the floor at its origin, the board's
 *  face toward +Z (the stage turns it to face the court). */
export function buildHoopModel(THREE, HOOP) {
    const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(THREE), ...extra });
    const g = new THREE.Group();
    const boardY = HOOP.rimHeight - HOOP.boardBelowRim + HOOP.boardH / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, boardY + 0.2, 12), toon("#64748b"));
    pole.position.set(0, (boardY + 0.2) / 2, -0.45);
    g.add(pole);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.9), toon("#334155"));
    foot.position.set(0, 0.06, -0.6);
    g.add(foot);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.45), toon("#64748b"));
    arm.position.set(0, boardY, -0.225);
    g.add(arm);
    const tex = canvasTex(THREE, 256, 192, (c, w, h) => {
        c.fillStyle = "#f8fafc";
        c.fillRect(0, 0, w, h);
        c.strokeStyle = "#ef4444";
        c.lineWidth = 10;
        c.strokeRect(5, 5, w - 10, h - 10);
        c.lineWidth = 8;
        c.strokeRect(w * 0.32, h * 0.42, w * 0.36, h * 0.38);
    });
    const board = new THREE.Mesh(new THREE.BoxGeometry(HOOP.boardW, HOOP.boardH, 0.03),
        [toon("#e2e8f0"), toon("#e2e8f0"), toon("#e2e8f0"), toon("#e2e8f0"), toon("#ffffff", { map: tex }), toon("#e2e8f0")]);
    board.position.set(0, boardY, 0);
    g.add(board);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(HOOP.rimRadius, HOOP.rimTube, 8, 40), toon("#ea580c"));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, HOOP.rimHeight, HOOP.rimOut);
    g.add(rim);
    const net = new THREE.Mesh(
        new THREE.LatheGeometry([new THREE.Vector2(HOOP.rimRadius, 0), new THREE.Vector2(HOOP.rimRadius * 0.85, -HOOP.net * 0.5),
            new THREE.Vector2(HOOP.rimRadius * 0.62, -HOOP.net)], 16, 3),
        new THREE.MeshBasicMaterial({ color: "#f8fafc", wireframe: true, transparent: true, opacity: 0.85 }));
    net.position.set(0, HOOP.rimHeight, HOOP.rimOut);
    g.add(net);
    g.traverse((o) => { if (o.isMesh && o !== net) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g, net };
}

/** The rugby posts (catalog POSTS): the middle of the line under the bar
 *  at the origin, facing +Z out to the kicker; white posts padded at the
 *  foot, the bar, and the ball-stop net behind. */
export function buildPostsModel(THREE, POSTS) {
    const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(THREE), ...extra });
    const g = new THREE.Group();
    const white = toon("#f8fafc"), P = POSTS.post, w = POSTS.width / 2;
    for (const x of [-w, w]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(P, P, POSTS.height, 14), white);
        post.position.set(x, POSTS.height / 2, 0);
        g.add(post);
        // The pad round the foot of each post.
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(POSTS.padR, POSTS.padR, POSTS.padH, 16), toon(x < 0 ? "#1d4ed8" : "#dc2626"));
        pad.position.set(x, POSTS.padH / 2, 0);
        g.add(pad);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(P, P, POSTS.width, 14), white);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = POSTS.bar - P;
    g.add(bar);
    // The ball-stop net: two poles and a loose mesh between.
    const grey = toon("#64748b");
    for (const x of [-POSTS.netW / 2, POSTS.netW / 2]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, POSTS.netH, 8), grey);
        pole.position.set(x, POSTS.netH / 2, -POSTS.netBack);
        g.add(pole);
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(POSTS.netW, POSTS.netH, 40, 25),
        new THREE.MeshBasicMaterial({ color: "#e2e8f0", wireframe: true, transparent: true, opacity: 0.28 }));
    net.position.set(0, POSTS.netH / 2, -POSTS.netBack);
    g.add(net);
    g.traverse((o) => { if (o.isMesh && o !== net) { o.castShadow = true; o.receiveShadow = true; } });
    return { group: g };
}

/** A kicking tee: a little orange cone, its cup POSTS.tee up. */
export function buildTeeModel(THREE, POSTS) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.06, POSTS.tee, 16),
        new THREE.MeshToonMaterial({ color: "#f97316", gradientMap: toonRamp(THREE) }));
    m.position.y = POSTS.tee / 2;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return { group: g };
}

// ── cups, bowls and bottles ───────────────────────────────────────────────
// What's in one is parts.fill, a group from the inside of its bottom that
// the stage squashes down as it goes; parts.steam rises off a hot one
// (parts.tick), parts.cap comes off a bottle, and a noodle bowl's
// parts.sticks (with noodles hanging off them, parts.strands) go to the
// hand that eats with them (scene_stage.js _sticks).

let STEAM_TEX = null;

function buildVessel(THREE, def, r, g, parts, add, toon) {
    const floor = -r;
    const steamAt = (pts) => {
        if (!STEAM_TEX) STEAM_TEX = canvasTex(THREE, 64, 64, (c, w, h) => {
            const grd = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
            grd.addColorStop(0, "rgba(255,255,255,0.9)");
            grd.addColorStop(1, "rgba(255,255,255,0)");
            c.fillStyle = grd;
            c.fillRect(0, 0, w, h);
        });
        const steam = new THREE.Group();
        const puffs = [];
        for (const [x, y, z] of pts) {
            for (let i = 0; i < 3; i++) {
                const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: STEAM_TEX, transparent: true, depthWrite: false, opacity: 0 }));
                s.userData = { x, y, z, ph: i / 3 + Math.random() * 0.1 };
                steam.add(s);
                puffs.push(s);
            }
        }
        g.add(steam);
        parts.steam = steam;
        parts.tick = (dt, time) => {
            if (!steam.visible) return;
            for (const s of puffs) {
                const u = s.userData, k = (time * 0.45 + u.ph) % 1;
                s.position.set(u.x + 0.006 * Math.sin(time * 3 + u.ph * 9), u.y + k * 0.09, u.z);
                s.scale.setScalar(0.018 + k * 0.035);
                s.material.opacity = 0.45 * Math.sin(Math.PI * k);
            }
        };
    };
    const fill = (y) => {
        const f = new THREE.Group();
        f.position.y = y;
        g.add(f);
        parts.fill = f;
        return f;
    };
    switch (def.id) {
        case "noodles": {
            // A ramen bowl, red outside and glazed white in, with the
            // noodles, an egg, a slice of fish cake and spring onion.
            const V = (x, y) => new THREE.Vector2(x, y);
            add(new THREE.LatheGeometry([V(0.026, floor), V(0.03, floor), V(0.03, floor + 0.006), V(0.046, floor + 0.016),
                V(0.06, floor + 0.036), V(0.066, floor + 0.06), V(0.064, floor + 0.062)], 32), toon("#dc2626", { side: THREE.DoubleSide }));
            add(new THREE.LatheGeometry([V(0.0001, floor + 0.012), V(0.04, floor + 0.016), V(0.054, floor + 0.034), V(0.06, floor + 0.06)], 32),
                toon("#fafaf9", { side: THREE.DoubleSide }));
            const f = fill(floor + 0.012);
            const broth = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.042, 0.04, 28), toon("#f59e0b"));
            broth.position.y = 0.02;
            f.add(broth);
            const yellow = toon("#fde68a");
            for (let i = 0; i < 14; i++) {
                const a0 = Math.random() * Math.PI * 2, rr = rand(0.005, 0.045);
                const pts = Array.from({ length: 5 }, (_, j) => new THREE.Vector3(
                    Math.cos(a0 + j * 0.5) * rr + rand(-0.006, 0.006), 0.04 + rand(0, 0.006), Math.sin(a0 + j * 0.5) * rr + rand(-0.006, 0.006)));
                f.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.0022, 5, false), yellow));
            }
            const egg = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon("#fff7ed"));
            egg.position.set(-0.022, 0.04, 0.01);
            egg.scale.set(1, 0.6, 1.3);
            f.add(egg);
            const yolk = new THREE.Mesh(new THREE.SphereGeometry(0.007, 10, 8), toon("#f59e0b"));
            yolk.position.set(-0.022, 0.046, 0.01);
            yolk.scale.set(1, 0.4, 1.2);
            f.add(yolk);
            const naruto = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.004, 16), toon("#ffffff"));
            naruto.position.set(0.024, 0.045, -0.008);
            naruto.rotation.x = 0.3;
            f.add(naruto);
            const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.005, 0.0013, 4, 12), toon("#f472b6"));
            swirl.position.set(0.024, 0.0475, -0.0075);
            swirl.rotation.x = Math.PI / 2 + 0.3;
            f.add(swirl);
            const onion = toon("#22c55e");
            for (let i = 0; i < 7; i++) {
                const o = new THREE.Mesh(new THREE.TorusGeometry(0.003, 0.0012, 4, 8), onion);
                o.position.set(rand(-0.03, 0.03), 0.046, rand(-0.03, 0.03));
                o.rotation.x = Math.PI / 2;
                f.add(o);
            }
            // Chopsticks, held a third of the way along (the group's
            // origin), the tips at +X; across the bowl until picked up.
            const sticks = new THREE.Group();
            const wood = toon("#d6a35c");
            for (const z of [-0.004, 0.004]) {
                const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0035, 0.22, 6), wood);
                s.rotation.z = -Math.PI / 2;
                s.position.set(0.04, 0, z);
                sticks.add(s);
            }
            const strands = new THREE.Group();
            strands.position.x = 0.15;
            for (let i = 0; i < 4; i++) {
                const pts = Array.from({ length: 4 }, (_, j) => new THREE.Vector3(rand(-0.004, 0.004), -j * 0.022, rand(-0.006, 0.006)));
                strands.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.002, 4, false), yellow));
            }
            strands.visible = false;
            sticks.add(strands);
            sticks.position.set(-0.03, floor + 0.066, 0.012);
            sticks.rotation.y = 0.35;
            sticks.userData.rest = { position: sticks.position.clone(), quaternion: sticks.quaternion.clone() };
            g.add(sticks);
            parts.sticks = sticks;
            parts.strands = strands;
            steamAt([[0, floor + 0.06, 0], [0.02, floor + 0.06, -0.015]]);
            break;
        }
        case "tea": {
            // A blue stoneware mug of tea, a tea bag's tag over the rim.
            const blue = toon("#60a5fa", { side: THREE.DoubleSide });
            add(new THREE.CylinderGeometry(0.04, 0.038, 0.09, 28, 1, true), blue, 0, floor + 0.045, 0);
            add(new THREE.CylinderGeometry(0.038, 0.038, 0.004, 28), blue, 0, floor + 0.002, 0);
            add(new THREE.TorusGeometry(0.04, 0.0025, 6, 28), blue, 0, floor + 0.09, 0).rotation.x = Math.PI / 2;
            const handle = add(new THREE.TorusGeometry(0.022, 0.006, 8, 16, Math.PI), blue, 0.04, floor + 0.045, 0);
            handle.rotation.z = -Math.PI / 2;
            const f = fill(floor + 0.004);
            const tea = new THREE.Mesh(new THREE.CylinderGeometry(0.0375, 0.0365, 0.076, 24), toon("#92400e"));
            tea.position.y = 0.038;
            f.add(tea);
            add(new THREE.CylinderGeometry(0.0004, 0.0004, 0.04, 3), toon("#f5f5f4"), -0.03, floor + 0.08, 0.026).rotation.z = 0.5;
            add(new THREE.BoxGeometry(0.014, 0.016, 0.002), toon("#fef3c7"), -0.045, floor + 0.06, 0.03);
            steamAt([[0, floor + 0.09, 0], [-0.012, floor + 0.09, 0.01]]);
            break;
        }
        case "coffee": {
            // A takeaway cup: paper, a card sleeve, a lid with a sip hole.
            const h = 0.13, mid = floor + h / 2;
            add(new THREE.CylinderGeometry(0.045, 0.033, h, 28), toon("#f5f0e6"), 0, mid, 0);
            add(new THREE.CylinderGeometry(0.0435, 0.0375, 0.05, 28, 1, true), toon("#a16207", { side: THREE.DoubleSide }), 0, mid + 0.005, 0);
            add(new THREE.CylinderGeometry(0.0475, 0.0475, 0.01, 28), toon("#374151"), 0, floor + h + 0.005, 0);
            add(new THREE.CylinderGeometry(0.04, 0.044, 0.008, 28), toon("#4b5563"), 0, floor + h + 0.014, 0);
            add(new THREE.BoxGeometry(0.012, 0.002, 0.005), toon("#111827"), 0.026, floor + h + 0.018, 0);
            steamAt([[0.026, floor + h + 0.02, 0]]);
            break;
        }
        case "water": {
            // A 500 ml bottle, see-through, the water in it, a label and a
            // blue cap.
            const V = (x, y) => new THREE.Vector2(x, y);
            add(new THREE.LatheGeometry([V(0.0001, floor), V(0.03, floor), V(0.033, floor + 0.006), V(0.033, floor + 0.14),
                V(0.022, floor + 0.17), V(0.013, floor + 0.182), V(0.013, floor + 0.192)], 28),
                toon("#e0f2fe", { transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
            const f = fill(floor + 0.004);
            const water = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 24), toon("#38bdf8", { transparent: true, opacity: 0.6 }));
            water.position.y = 0.07;
            f.add(water);
            add(new THREE.CylinderGeometry(0.0335, 0.0335, 0.04, 28, 1, true), toon("#0ea5e9", { side: THREE.DoubleSide }), 0, floor + 0.08, 0);
            parts.cap = add(new THREE.CylinderGeometry(0.015, 0.015, 0.016, 16), toon("#1d4ed8"), 0, floor + 0.2, 0);
            // Where the neck opens: put to their mouth to drink.
            parts.lip = floor + 0.192;
            break;
        }
        default:
    }
}

// ── lamps ─────────────────────────────────────────────────────────────────
// Each lamp's model gives parts.look({on, shade, light}) — its shade's
// colour, what glows when it's on (bulbs, flames, a lit fabric shade) — and
// parts.tick(dt, time, on) for what moves on its own (wax rising, a flame,
// twinkling). parts.lightAt is where its light sits (catalog lamp.at),
// parts.spotDir which way a spot points.

function buildLamp(THREE, def, r, g, parts, add, toon) {
    const floor = -r;
    const L = def.lamp;
    const at = new THREE.Vector3(...L.at);
    const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });
    const metal = (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.75, roughness: 0.35 });
    const glow = [];
    const shadeMats = [];
    const lit = [];     // fabric/paper: glows in the light's colour when on
    const offColor = new THREE.Color("#6b7280");
    parts.lightAt = at;
    switch (def.id) {
        case "desk": {
            const topY = floor + 0.75;
            const wood = toon("#a16207"), dark = toon("#78350f");
            add(new THREE.BoxGeometry(1.0, 0.04, 0.5), wood, 0, topY - 0.02, 0);
            for (const x of [-0.46, 0.46]) for (const z of [-0.21, 0.21]) add(new THREE.BoxGeometry(0.04, 0.71, 0.04), dark, x, floor + 0.355, z);
            add(new THREE.BoxGeometry(0.36, 0.12, 0.44), dark, -0.25, topY - 0.1, 0);
            add(new THREE.BoxGeometry(0.08, 0.015, 0.015), toon("#fbbf24"), -0.25, topY - 0.1, 0.226);
            // Books, a mug.
            ["#1d4ed8", "#be123c", "#15803d"].forEach((c, i) => {
                const b = add(new THREE.BoxGeometry(0.22, 0.035, 0.16), toon(c), -0.3, topY + 0.018 + i * 0.036, -0.08);
                b.rotation.y = (i - 1) * 0.12;
            });
            add(new THREE.CylinderGeometry(0.032, 0.03, 0.09, 16), toon("#f8fafc"), -0.02, topY + 0.045, 0.1);
            add(new THREE.TorusGeometry(0.022, 0.006, 6, 12), toon("#f8fafc"), 0.016, topY + 0.05, 0.1);
            // The angled lamp: base, two arms, a hood pointing down.
            const D = new THREE.Vector3(-0.3, -1, 0.05).normalize();
            const C = at.clone().addScaledVector(D, -0.075);
            const A = new THREE.Vector3(0.36, topY + 0.02, -0.06), B = new THREE.Vector3(0.43, topY + 0.3, -0.06);
            const arms = toon("#dc2626");
            shadeMats.push(arms);
            add(new THREE.CylinderGeometry(0.07, 0.08, 0.025, 24), arms, A.x, topY + 0.012, A.z);
            const rod = (p, q) => {
                const m = add(new THREE.CylinderGeometry(0.009, 0.009, p.distanceTo(q), 8), arms, (p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2);
                m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize());
            };
            rod(A, B);
            rod(B, C);
            for (const p of [B, C]) add(new THREE.SphereGeometry(0.014, 10, 8), toon("#334155"), p.x, p.y, p.z);
            const hood = add(new THREE.CylinderGeometry(0.025, 0.075, 0.12, 24, 1, true), arms.clone(), 0, 0, 0);
            hood.material.side = THREE.DoubleSide;
            shadeMats.push(hood.material);
            hood.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), D.clone().negate());
            hood.position.copy(at).addScaledVector(D, -0.02);
            const bulb = add(new THREE.SphereGeometry(0.024, 12, 10), basic("#ffffff"), at.x, at.y, at.z);
            glow.push(bulb);
            parts.spotDir = D;
            break;
        }
        case "floorlamp": {
            const brass = metal("#b08d57");
            add(new THREE.CylinderGeometry(0.15, 0.16, 0.03, 32), toon("#1f2937"), 0, floor + 0.015, 0);
            add(new THREE.CylinderGeometry(0.012, 0.012, at.y - floor, 10), brass, 0, (floor + at.y) / 2, 0);
            const shade = add(new THREE.CylinderGeometry(0.17, 0.2, 0.28, 36, 1, true), toon("#efe6d2", { side: THREE.DoubleSide }), 0, at.y + 0.06, 0);
            shadeMats.push(shade.material);
            lit.push(shade.material);
            add(new THREE.SphereGeometry(0.012, 8, 6), brass, 0, at.y + 0.22, 0);
            glow.push(add(new THREE.SphereGeometry(0.035, 14, 10), basic("#ffffff"), at.x, at.y, at.z));
            break;
        }
        case "lantern": {
            const paper = toon("#fbf7ef");
            const globe = add(new THREE.SphereGeometry(r, 32, 20), paper);
            globe.scale.y = 0.95;
            shadeMats.push(paper);
            lit.push(paper);
            const rib = toon("#d6d3d1");
            for (let i = 1; i < 8; i++) {
                const y = -r + (2 * r * i) / 8, rr = Math.sqrt(Math.max(0, r * r - y * y)) * 1.005;
                add(new THREE.TorusGeometry(rr, 0.0018, 4, 40), rib, 0, y * 0.95, 0).rotation.x = Math.PI / 2;
            }
            add(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 20), rib, 0, r * 0.95, 0);
            add(new THREE.CylinderGeometry(0.003, 0.003, 1.5, 6), toon("#1f2937"), 0, r + 0.75, 0);
            break;
        }
        case "lava": {
            const silver = metal("#cbd5e1");
            add(new THREE.CylinderGeometry(0.042, 0.07, 0.13, 28), silver, 0, floor + 0.065, 0);
            const y0 = floor + 0.13;
            const prof = [[0.042, 0], [0.05, 0.035], [0.043, 0.16], [0.028, 0.25], [0, 0.25]].map(([x, y]) => new THREE.Vector2(x, y));
            const liquid = new THREE.MeshPhongMaterial({ color: "#e11d48", transparent: true, opacity: 0.72, shininess: 80, depthWrite: false });
            const glass = add(new THREE.LatheGeometry(prof, 28), liquid, 0, y0, 0);
            glass.renderOrder = 2;
            shadeMats.push(liquid);
            add(new THREE.CylinderGeometry(0.012, 0.028, 0.05, 20), silver, 0, y0 + 0.275, 0);
            const wax = toon("#ff7a1a");
            parts.wax = wax;
            const blobs = Array.from({ length: 5 }, (_, i) => {
                const b = add(new THREE.SphereGeometry(0.016 + (i % 3) * 0.005, 14, 10), wax, 0, y0 + 0.02, 0);
                b.renderOrder = 1;
                return { m: b, phase: Math.random(), period: rand(18, 32), x: rand(-0.012, 0.012), z: rand(-0.012, 0.012) };
            });
            parts.tick = (dt, time, on) => {
                // Warm wax rises, cools at the top and sinks (once round in
                // 18-32 s, by eye); still when it's off.
                for (const b of blobs) {
                    if (on) b.phase += dt / b.period;
                    const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * b.phase);
                    const narrow = 1 - 0.35 * s;
                    b.m.position.set(b.x * narrow, y0 + 0.02 + s * 0.2, b.z * narrow);
                    const stretch = 1 + 0.4 * Math.abs(Math.sin(2 * Math.PI * b.phase));
                    b.m.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
                }
            };
            parts.lavaLiquid = liquid;
            break;
        }
        case "candles": {
            const wood = toon("#5b3a29");
            add(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 36), wood, 0, floor + 0.54, 0);
            add(new THREE.CylinderGeometry(0.025, 0.03, 0.52, 12), wood, 0, floor + 0.27, 0);
            add(new THREE.CylinderGeometry(0.12, 0.13, 0.025, 28), wood, 0, floor + 0.0125, 0);
            const wax = toon("#f5efe0");
            shadeMats.push(wax);
            const flames = [];
            for (const [x, h, z] of [[-0.07, 0.11, -0.02], [0.05, 0.085, 0.05], [0.075, 0.06, -0.06]]) {
                const top = floor + 0.553 + h;
                add(new THREE.CylinderGeometry(0.03, 0.03, h, 20), wax, x, top - h / 2, z);
                add(new THREE.CylinderGeometry(0.0015, 0.0015, 0.012, 4), toon("#1f2937"), x, top + 0.006, z);
                const flame = add(new THREE.SphereGeometry(0.008, 10, 8), basic("#ffb347", { transparent: true }), x, top + 0.02, z);
                flame.scale.set(1, 2, 1);
                const core = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), basic("#fff7d6"));
                core.position.y = -0.002;
                flame.add(core);
                glow.push(flame);
                flames.push(flame);
            }
            parts.tick = (dt, time, on) => {
                if (!on) return;
                flames.forEach((f, i) => {
                    const k = 1 + 0.18 * Math.sin(time * 13 + i * 2.1) + 0.1 * Math.sin(time * 29 + i);
                    f.scale.set(1, 2 * k, 1);
                });
            };
            break;
        }
        case "jar": {
            const h = 0.25, y0 = floor;
            const glass = add(new THREE.CylinderGeometry(0.068, 0.07, h, 32, 1, true), new THREE.MeshPhysicalMaterial({
                color: "#e0f2fe", transparent: true, opacity: 0.22, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false,
            }), 0, y0 + h / 2, 0);
            glass.renderOrder = 2;
            add(new THREE.CylinderGeometry(0.07, 0.07, 0.008, 32), new THREE.MeshPhysicalMaterial({ color: "#e0f2fe", transparent: true, opacity: 0.3 }), 0, y0 + 0.004, 0);
            add(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 28), metal("#a8a29e"), 0, y0 + h + 0.015, 0);
            const N = 46;
            const leds = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 6, 4), basic("#ffffff"), N);
            const pts = [];
            const m4 = new THREE.Matrix4();
            for (let i = 0; i < N; i++) {
                const a = i * 0.9 + rand(-0.3, 0.3), rr = rand(0.015, 0.058), y = y0 + 0.02 + (h - 0.05) * (i / N) + rand(-0.02, 0.02);
                const p = new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr);
                pts.push(p);
                m4.makeTranslation(p.x, p.y, p.z);
                leds.setMatrixAt(i, m4);
                leds.setColorAt(i, offColor);
            }
            g.add(leds);
            const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#78716c" }));
            g.add(wire);
            const c = new THREE.Color();
            const phases = pts.map(() => Math.random() * 10);
            parts.tick = (dt, time, on) => {
                const base = parts._ledColor;
                for (let i = 0; i < N; i++) {
                    if (!on || !base) { leds.setColorAt(i, offColor); continue; }
                    // Twinkling: each LED's own slow pulse (by eye).
                    const k = 0.55 + 0.45 * Math.sin(time * 2.2 + phases[i]);
                    if (parts._rainbow) c.setHSL((i / N + time * 0.02) % 1, 0.9, 0.62); else c.copy(base);
                    leds.setColorAt(i, c.multiplyScalar(k));
                }
                leds.instanceColor.needsUpdate = true;
            };
            break;
        }
        case "moon": {
            const tex = canvasTex(THREE, 512, 256, (c, w, hh) => {
                c.fillStyle = "#f1ece0";
                c.fillRect(0, 0, w, hh);
                for (let i = 0; i < 70; i++) {
                    const x = Math.random() * w, y = Math.random() * hh, rr = rand(4, 26);
                    const grad = c.createRadialGradient(x, y, rr * 0.2, x, y, rr);
                    grad.addColorStop(0, "rgba(120,110,95,0.35)");
                    grad.addColorStop(0.8, "rgba(150,140,120,0.18)");
                    grad.addColorStop(1, "rgba(255,255,255,0)");
                    c.fillStyle = grad;
                    c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
                }
            });
            const mat = new THREE.MeshToonMaterial({ color: "#ffffff", map: tex, emissiveMap: tex, gradientMap: toonRamp(THREE) });
            add(new THREE.SphereGeometry(r, 40, 28), mat);
            lit.push(mat);
            break;
        }
        case "neon": {
            const W = 0.9, H = 0.3;
            const board = add(new THREE.PlaneGeometry(W, H), new THREE.MeshPhysicalMaterial({
                color: "#0f172a", transparent: true, opacity: 0.35, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false,
            }), 0, 0, -0.005);
            board.renderOrder = 1;
            const canvas = document.createElement("canvas");
            canvas.width = 1024;
            canvas.height = 342;
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            const sign = add(new THREE.PlaneGeometry(W, H), basic("#ffffff", { map: tex, transparent: true, depthWrite: false }), 0, 0, 0.01);
            sign.renderOrder = 2;
            for (const x of [-0.35, 0.35]) add(new THREE.CylinderGeometry(0.002, 0.002, 1.2, 4), toon("#475569"), x, H / 2 + 0.6, 0);
            parts.neon = (on, color) => {
                const c = canvas.getContext("2d");
                c.clearRect(0, 0, canvas.width, canvas.height);
                c.font = "italic 900 170px 'Trebuchet MS', 'Segoe UI', sans-serif";
                c.textAlign = "center";
                c.textBaseline = "middle";
                c.lineJoin = c.lineCap = "round";
                const draw = (blur, width, col, alpha) => {
                    c.save();
                    c.shadowColor = col;
                    c.shadowBlur = blur;
                    c.globalAlpha = alpha;
                    c.strokeStyle = col;
                    c.lineWidth = width;
                    c.strokeText("REXCLAW", 512, 160);
                    // A claw mark under it.
                    for (let i = 0; i < 3; i++) {
                        c.beginPath();
                        c.moveTo(380 + i * 70, 300);
                        c.quadraticCurveTo(420 + i * 70, 262, 470 + i * 70, 252);
                        c.stroke();
                    }
                    c.restore();
                };
                if (on) {
                    draw(40, 16, color, 0.9);
                    draw(14, 10, color, 1);
                    draw(0, 4, "#ffffff", 0.85);
                } else {
                    draw(0, 10, "#94a3b8", 0.8);
                }
                tex.needsUpdate = true;
            };
            parts.neon(false, L.color);
            break;
        }
        case "campfire": {
            // A ring of stones round an ash bed, a teepee of five logs, coals
            // glowing under them; the flames are crossed sheets of a flame
            // shader so they read from any side, embers rise off them.
            const stones = [toon("#78716c"), toon("#57534e"), toon("#a8a29e")];
            for (let i = 0; i < 12; i++) {
                const a = (i / 12) * Math.PI * 2 + rand(-0.08, 0.08), s = rand(0.055, 0.075);
                const m = add(new THREE.DodecahedronGeometry(s, 0), stones[i % 3], Math.cos(a) * 0.34, floor + s * 0.6, Math.sin(a) * 0.34);
                m.scale.set(1.25, 0.8, 1);
                m.rotation.set(rand(0, 3), -a, rand(0, 3));
            }
            add(new THREE.CylinderGeometry(0.28, 0.3, 0.02, 28), toon("#292524"), 0, floor + 0.01, 0);
            const bark = toon("#5b3a21"), cut = toon("#d6b17a");
            for (let i = 0; i < 5; i++) {
                const a = (i / 5) * Math.PI * 2 + 0.4;
                const foot = new THREE.Vector3(Math.cos(a) * 0.22, floor + 0.03, Math.sin(a) * 0.22);
                const top = new THREE.Vector3(Math.cos(a) * 0.035, floor + 0.44, Math.sin(a) * 0.035);
                const dir = top.clone().sub(foot);
                const len = dir.length();
                const log = add(new THREE.CylinderGeometry(0.034, 0.042, len, 9), bark, (foot.x + top.x) / 2, (foot.y + top.y) / 2, (foot.z + top.z) / 2);
                log.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
                // Its sawn foot.
                const end = new THREE.Mesh(new THREE.CircleGeometry(0.041, 9), cut);
                end.position.y = -len / 2 - 0.001;
                end.rotation.x = Math.PI / 2;
                log.add(end);
            }
            const coal = basic("#3f3f46");
            for (let i = 0; i < 14; i++) {
                const a = rand(0, Math.PI * 2), rr = rand(0, 0.2);
                add(new THREE.DodecahedronGeometry(rand(0.018, 0.03), 0), coal, Math.cos(a) * rr, floor + 0.025, Math.sin(a) * rr);
            }
            const fire = fireMaterial(THREE, puffHz(L.fire));
            const flames = new THREE.Group();
            for (let i = 0; i < 3; i++) {
                const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), fire);
                sheet.rotation.y = (i * Math.PI) / 3;
                sheet.renderOrder = 3;
                sheet.userData.clear = true;
                flames.add(sheet);
            }
            flames.position.y = floor + 0.5;
            g.add(flames);
            // A soft glow round the flames.
            const dot = softDot(THREE);
            const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35 }));
            halo.scale.set(1.3, 1.3, 1);
            halo.position.y = floor + 0.3;
            g.add(halo);
            const embers = new Embers(THREE, 36, dot, floor);
            g.add(embers.points);
            parts.fire = { fire, flames, halo, coal, embers };
            parts.tick = (dt, time, on) => {
                fire.uniforms.time.value = time;
                if (on) embers.tick(dt, time);
            };
            break;
        }
        case "galaxy": {
            // A round dark base with a ring in the shade's colour, a frosted
            // dome pricked with stars on top (it turns while it's on), a
            // power light.
            add(new THREE.CylinderGeometry(0.062, 0.07, 0.045, 36), toon("#1e1b2e"), 0, floor + 0.0225, 0);
            const ring = toon("#7c3aed");
            shadeMats.push(ring);
            add(new THREE.TorusGeometry(0.063, 0.004, 8, 40), ring, 0, floor + 0.045, 0).rotation.x = Math.PI / 2;
            const tex = canvasTex(THREE, 256, 128, (c, w, h) => {
                c.fillStyle = "#0b1026";
                c.fillRect(0, 0, w, h);
                for (let i = 0; i < 260; i++) {
                    c.fillStyle = `rgba(255,255,255,${rand(0.4, 1).toFixed(2)})`;
                    c.beginPath();
                    c.arc(rand(0, w), rand(0, h), rand(0.4, 1.4), 0, Math.PI * 2);
                    c.fill();
                }
            });
            const domeMat = new THREE.MeshToonMaterial({ color: "#c7d2fe", map: tex, emissiveMap: tex, gradientMap: toonRamp(THREE) });
            lit.push(domeMat);
            const dome = add(new THREE.SphereGeometry(0.056, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2), domeMat, 0, floor + 0.045, 0);
            parts.led = add(new THREE.SphereGeometry(0.0045, 8, 6), basic("#334155"), 0, floor + 0.022, 0.067);
            // Its sky goes up and out over the room in front of it; the
            // spot's cookie is that sky, turning with the dome.
            parts.spotDir = new THREE.Vector3(0, 1, 0.55).normalize();
            const cookie = new SkyCookie(THREE);
            parts.cookie = cookie.tex;
            parts.spin = 0;
            let last = -1;
            parts.tick = (dt, time, on) => {
                if (!on) return;
                parts.spin += (dt * 2 * Math.PI) / L.turn;
                dome.rotation.y = parts.spin;
                // Redrawn a few times a second: it turns slowly.
                if (time - last > 0.12 || last < 0) {
                    last = time;
                    cookie.draw(parts.spin, parts._sky || []);
                }
            };
            break;
        }
        case "aquarium":
            buildAquarium(THREE, def, g, parts, add, toon, basic, glow, floor);
            break;
        case "pumpkin":
            buildPumpkin(THREE, g, parts, add, toon, basic, floor);
            break;
        default:
            break;
    }
    const lightColor = new THREE.Color();
    parts.look = ({ on, shade, light }) => {
        lightColor.set(light);
        for (const m of shadeMats) m.color.set(shade.color);
        for (const m of lit) {
            m.emissive = m.emissive || new THREE.Color();
            m.emissive.copy(on ? lightColor : new THREE.Color(0)).multiplyScalar(on ? 0.55 : 0);
        }
        for (const o of glow) {
            o.visible = on;
            if (o.material.color && def.id !== "candles") o.material.color.copy(lightColor).lerp(new THREE.Color("#ffffff"), 0.6);
        }
        if (parts.fire) {
            const f = parts.fire, [core, body, tip] = shade.flame;
            f.fire.uniforms.core.value.set(core);
            f.fire.uniforms.body.value.set(body);
            f.fire.uniforms.tip.value.set(tip);
            f.flames.visible = f.halo.visible = f.embers.points.visible = on;
            f.halo.material.color.set(body);
            f.embers.color.set(body);
            f.coal.color.set(on ? tip : "#3f3f46");
        }
        if (def.id === "galaxy") {
            parts._sky = shade.sky;
            parts.led.material.color.set(on ? "#4ade80" : "#334155");
        }
        if (parts.aquarium) parts.aquarium({ on, shade, light: lightColor });
        if (parts.pumpkin) parts.pumpkin({ on, shade });
        if (def.id === "lava") {
            parts.wax.color.set(shade.wax);
            parts.wax.emissive = new THREE.Color(on ? shade.wax : "#000000").multiplyScalar(on ? 0.6 : 0);
            parts.lavaLiquid.emissive = new THREE.Color(on ? shade.color : "#000000").multiplyScalar(on ? 0.5 : 0);
        }
        if (def.id === "jar") {
            parts._ledColor = lightColor.clone();
            parts._rainbow = !!shade.rainbow;
        }
        if (parts.neon) parts.neon(on, shade.color);
    };
}

// ── the scene-setters' parts ─────────────────────────────────────────────

const FIRE_FRAGMENT = /* glsl */`
    uniform float time;
    uniform float puff;
    uniform vec3 core;
    uniform vec3 body;
    uniform vec3 tip;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.07; a *= 0.5; }
        return s;
    }
    void main() {
        float x = vUv.x * 2.0 - 1.0, y = vUv.y;
        // Turbulence rising through it; a swell running up it at the
        // fire's puffing frequency.
        float n = fbm(vec2(x * 2.2, y * 2.6 - time * 2.2));
        float swell = 0.5 + 0.5 * sin(6.2832 * (puff * time - y * 1.1));
        float w = mix(0.62, 0.08, pow(y, 0.8)) * (0.85 + 0.3 * swell);
        float bend = (n - 0.5) * 0.5 * y + 0.06 * sin(time * 1.3 + y * 3.0) * y;
        float sheet = 1.0 - smoothstep(w * 0.35, w, abs(x - bend));
        float top = 1.0 - smoothstep(0.35 + 0.45 * n * (0.7 + 0.3 * swell), 0.95, y);
        float a = sheet * top * smoothstep(0.0, 0.06, y);
        a *= smoothstep(0.2, 0.6, n + (1.0 - y) * 0.55);
        vec3 col = mix(tip, body, smoothstep(0.05, 0.45, a));
        col = mix(col, core, smoothstep(0.55, 0.95, a) * (1.0 - y * 0.8));
        gl_FragColor = vec4(col, clamp(a * 1.25, 0.0, 1.0));
        #include <colorspace_fragment>
    }`;

/** Flames: a sheet of rising noise narrowing to its tips, swelling at
 *  `hz` (the fire's puffing), coloured core → body → tip. */
function fireMaterial(THREE, hz) {
    return new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 }, puff: { value: hz },
            core: { value: new THREE.Color("#fff4c2") }, body: { value: new THREE.Color("#ffb03a") }, tip: { value: new THREE.Color("#e2401a") },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: FIRE_FRAGMENT,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
}

/** A soft round dot: a glow, an ember, a bubble. */
function softDot(THREE) {
    return canvasTex(THREE, 64, 64, (c, w) => {
        const grad = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = grad;
        c.fillRect(0, 0, w, w);
    });
}

/** Embers off a fire: sparks rising from its bed on the eddies, slowing as
 *  they cool and fading out (by eye). */
class Embers {
    constructor(THREE, n, map, floor) {
        this.floor = floor;
        this.color = new THREE.Color("#ffb03a");
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.018, map, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.points.frustumCulled = false;
        this.e = Array.from({ length: n }, () => this._spawn({}, Math.random()));
    }

    _spawn(e, age = 0) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.13;
        e.x = Math.cos(a) * r;
        e.y = this.floor + rand(0.1, 0.3);
        e.z = Math.sin(a) * r;
        e.vx = rand(-0.06, 0.06);
        e.vy = rand(0.5, 1.1);
        e.vz = rand(-0.06, 0.06);
        e.life = rand(1.0, 2.4);
        e.age = age * e.life;
        e.ph = Math.random() * 6;
        return e;
    }

    tick(dt, time) {
        const pos = this.points.geometry.attributes.position, col = this.points.geometry.attributes.color;
        const c = this.color;
        this.e.forEach((e, i) => {
            e.age += dt;
            if (e.age > e.life) this._spawn(e);
            e.x += (e.vx + 0.08 * Math.sin(time * 3 + e.ph)) * dt;
            e.y += e.vy * dt;
            e.z += (e.vz + 0.08 * Math.cos(time * 2.6 + e.ph)) * dt;
            e.vy *= 1 - 0.4 * dt;
            pos.setXYZ(i, e.x, e.y, e.z);
            const k = (1 - e.age / e.life) * (0.6 + 0.4 * Math.sin(time * 20 + e.ph * 3));
            col.setXYZ(i, c.r * k, c.g * k, c.b * k);
        });
        pos.needsUpdate = col.needsUpdate = true;
    }
}

const rgba = (hex, a) => {
    const v = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
};

/** The galaxy projector's sky as its spot's cookie: nebula clouds in the
 *  shade's colours and stars in a soft-edged disc, turned by `spin`. */
class SkyCookie {
    constructor(THREE) {
        const c = this.canvas = document.createElement("canvas");
        c.width = c.height = 256;
        this.tex = new THREE.CanvasTexture(c);
        this.tex.colorSpace = THREE.SRGBColorSpace;
        this.stars = Array.from({ length: 160 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.sqrt(Math.random()) * 120, s: rand(0.6, 1.8), b: rand(0.5, 1) }));
        this.clouds = Array.from({ length: 9 }, (_, i) => ({ a: Math.random() * Math.PI * 2, r: rand(15, 95), s: rand(40, 85), i }));
        this.draw(0, []);
    }

    draw(spin, sky) {
        const g = this.canvas.getContext("2d"), C = 128;
        g.globalCompositeOperation = "source-over";
        g.fillStyle = "#000";
        g.fillRect(0, 0, 256, 256);
        g.globalCompositeOperation = "lighter";
        if (sky.length) {
            for (const cl of this.clouds) {
                const x = C + Math.cos(cl.a + spin) * cl.r, y = C + Math.sin(cl.a + spin) * cl.r;
                const col = sky[cl.i % sky.length];
                const grad = g.createRadialGradient(x, y, 0, x, y, cl.s);
                grad.addColorStop(0, rgba(col, 0.55));
                grad.addColorStop(1, rgba(col, 0));
                g.fillStyle = grad;
                g.fillRect(x - cl.s, y - cl.s, cl.s * 2, cl.s * 2);
            }
        }
        g.fillStyle = "#fff";
        for (const s of this.stars) {
            g.globalAlpha = s.b;
            g.beginPath();
            g.arc(C + Math.cos(s.a + spin) * s.r, C + Math.sin(s.a + spin) * s.r, s.s, 0, Math.PI * 2);
            g.fill();
        }
        g.globalAlpha = 1;
        // A soft edge to the disc.
        g.globalCompositeOperation = "source-over";
        const edge = g.createRadialGradient(C, C, 90, C, C, 128);
        edge.addColorStop(0, "rgba(0,0,0,0)");
        edge.addColorStop(1, "rgba(0,0,0,1)");
        g.fillStyle = edge;
        g.fillRect(0, 0, 256, 256);
        this.tex.needsUpdate = true;
    }
}

/** Light through rippling water: a tiling net of bright lines (where
 *  sines of whole periods cross zero), to scroll over the tank's floor. */
function causticTex(THREE) {
    const t = canvasTex(THREE, 128, 128, (c, w, h) => {
        const img = c.createImageData(w, h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const u = (x / w) * 2 * Math.PI, v = (y / h) * 2 * Math.PI;
                const s = Math.sin(3 * u + 2 * v) + Math.sin(-2 * u + 3 * v + 1.3) + Math.sin(4 * u - v + 2.1) + Math.sin(u + 4 * v + 0.4);
                const k = Math.pow(Math.max(0, 1 - Math.abs(s) / 1.6), 5);
                const i = (y * w + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * k);
                img.data[i + 3] = 255;
            }
        }
        c.putImageData(img, 0, 0);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

/** A pumpkin of radius 1, flattened, ribbed in `ribs` lobes (a lobe's
 *  middle to the front), darker down its grooves. Its uv is the front view,
 *  so a face cut in a square canvas lands as drawn (PUMPKIN_FACES). */
function pumpkinGeometry(THREE, ribs) {
    const geo = new THREE.SphereGeometry(1, 96, 56);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const lobe = Math.abs(Math.cos(Math.atan2(x, z) * ribs / 2)) ** 0.6;
        const girth = 1 - 0.085 * (1 - lobe) * Math.sqrt(Math.sqrt(Math.max(0, 1 - y * y)));
        // The back maps to the canvas's solid corner.
        uv.setXY(i, z > -0.02 ? 0.5 + x / 2 : 0, z > -0.02 ? 0.5 + y / 2 : 0);
        p.setXYZ(i, x * girth, y * 0.8 * (1 - 0.28 * Math.abs(y) ** 6), z * girth);
        const shade = 0.62 + 0.38 * lobe;
        col.set([shade, shade, shade], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
}

/** A carved face's holes onto canvas 2D `c` of a square `w`, from
 *  PUMPKIN_FACES (and the lid's zigzag, if `lid`). */
function cutFace(c, w, face, lid) {
    c.save();
    c.translate(w / 2, w / 2);
    c.scale(w / 100, w / 100);
    for (const d of PUMPKIN_FACES[face]) c.fill(new Path2D(d));
    if (lid) {
        c.lineWidth = 1.1;
        c.stroke(new Path2D(PUMPKIN_LID));
    }
    c.restore();
}

/** One wing of a bat, root at the origin, out along +X, scalloped behind. */
function batWing(THREE) {
    const s = BAT_SPAN / 2;
    const pts = [[0, 0.32], [0.45, 0.42], [1, 0.1], [0.82, -0.2], [0.62, -0.06], [0.44, -0.28], [0.24, -0.1], [0, -0.3]];
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x * s, z * s)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    return geo;
}

const INTERIOR_FRAGMENT = /* glsl */`
    uniform vec3 hot;
    uniform vec3 warm;
    uniform float power;
    varying vec3 vP;
    void main() {
        // Falling off from the candle, low in the middle.
        vec3 d = vP - vec3(0.0, -0.45, 0.0);
        float k = power / (1.0 + 2.2 * dot(d, d));
        vec3 col = mix(warm, hot, smoothstep(0.3, 0.95, k));
        gl_FragColor = vec4(mix(vec3(0.03, 0.015, 0.01), col, clamp(k * 1.7, 0.0, 1.0)), 1.0);
        #include <colorspace_fragment>
    }`;

/** The jack-o'-lantern: a hay bale, gourds, and the pumpkin on it with its
 *  face really cut through. Its skin and a few layers of flesh under it have
 *  the holes (so the cut has depth from any angle), a hollow lit from the
 *  candle behind them, the flame itself seen through. Its face's glow soaks
 *  through the thin skin round the cuts and falls on the floor in front.
 *  parts.pumpkin sets its look (shade: skin, face, flame); parts.boo(k)
 *  flares it and sets it rattling, at 1 with bats bursting from its mouth;
 *  parts.flare is what's left of that, for the stage's light. */
function buildPumpkin(THREE, g, parts, add, toon, basic, floor) {
    const R = 0.26, BALE_H = 0.36, BALE_W = 0.92, BALE_D = 0.46;
    const midY = floor + BALE_H + R * 0.6;
    const FRONT = BALE_D / 2;

    // The bale: pressed straw, two strings round it, ends sticking out.
    const straw = canvasTex(THREE, 512, 256, (c, w, h) => {
        c.fillStyle = "#b8923f";
        c.fillRect(0, 0, w, h);
        c.lineWidth = 1.6;
        for (let i = 0; i < 2600; i++) {
            const x = rand(0, w), y = rand(0, h), a = rand(-0.5, 0.5), l = rand(14, 44);
            c.strokeStyle = ["#e3c56b", "#cfa94f", "#9c7a30", "#f0d98c"][i % 4];
            c.beginPath();
            c.moveTo(x, y);
            c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
            c.stroke();
        }
    });
    add(new THREE.BoxGeometry(BALE_W, BALE_H, BALE_D), toon("#ffffff", { map: straw }), 0, floor + BALE_H / 2, 0);
    const twine = toon("#6b4a24");
    for (const x of [-0.24, 0.24]) add(new THREE.BoxGeometry(0.012, BALE_H + 0.006, BALE_D + 0.006), twine, x, floor + BALE_H / 2, 0);
    const tufts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.002, 0.003, 1, 4), toon("#e3c56b"), 46);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (let i = 0; i < 46; i++) {
        const side = i % 2 ? 1 : -1, end = i % 3 === 0;
        const at = end ? V(side * BALE_W / 2, floor + rand(0.02, BALE_H), rand(-FRONT, FRONT)) : V(rand(-BALE_W / 2, BALE_W / 2), floor + (i % 4 ? rand(0.01, 0.06) : BALE_H), FRONT * (i % 5 ? 1 : -1));
        e.set(rand(-1.2, 1.2), 0, rand(-1.2, 1.2));
        m4.compose(at, q.setFromEuler(e), V(1, rand(0.06, 0.15), 1));
        tufts.setMatrixAt(i, m4);
    }
    g.add(tufts);

    // Everything on `head` jumps when it rattles.
    const head = new THREE.Group();
    head.position.y = midY;
    g.add(head);
    const geo = pumpkinGeometry(THREE, 10);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1024;
    const cut = new THREE.CanvasTexture(canvas);
    const skinGlowCanvas = document.createElement("canvas");
    skinGlowCanvas.width = skinGlowCanvas.height = 512;
    const skinGlow = new THREE.CanvasTexture(skinGlowCanvas);
    skinGlow.colorSpace = THREE.SRGBColorSpace;
    const skin = toon("#ffffff", { vertexColors: true, alphaMap: cut, alphaTest: 0.5, emissive: "#000000", emissiveMap: skinGlow });
    const shell = new THREE.Mesh(geo, skin);
    shell.scale.setScalar(R);
    head.add(shell);
    // The flesh under the skin, in steps down to the hollow.
    const flesh = basic("#8a5a2b", { alphaMap: cut, alphaTest: 0.5 });
    for (const s of [0.975, 0.95, 0.925, 0.9]) {
        const m = new THREE.Mesh(geo, flesh);
        m.scale.setScalar(R * s);
        m.userData.clear = true;
        head.add(m);
    }
    const hollow = new THREE.ShaderMaterial({
        uniforms: { hot: { value: new THREE.Color() }, warm: { value: new THREE.Color() }, power: { value: 0 } },
        vertexShader: /* glsl */`
            varying vec3 vP;
            void main() {
                vP = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: INTERIOR_FRAGMENT,
        side: THREE.BackSide,
    });
    const inner = new THREE.Mesh(geo, hollow);
    inner.scale.setScalar(R * 0.885);
    inner.userData.clear = true;
    head.add(inner);
    // The candle stub and its flame, a crossed pair of sheets.
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.06, 14), toon("#f5efe0"));
    stub.position.y = -R * 0.45;
    stub.userData.clear = true;
    head.add(stub);
    const fire = fireMaterial(THREE, 4);
    const flames = new THREE.Group();
    for (const a of [0, Math.PI / 2]) {
        const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.26), fire);
        sheet.rotation.y = a;
        sheet.renderOrder = 3;
        sheet.userData.clear = true;
        flames.add(sheet);
    }
    flames.position.y = R * 0.3;
    head.add(flames);

    // The stem, bent over, and a curl of vine off it.
    const stemGeo = new THREE.CylinderGeometry(0.018, 0.05, 0.13, 8, 6);
    const sp = stemGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
        const y = sp.getY(i) + 0.065;
        sp.setX(i, sp.getX(i) + 1.9 * y * y);
    }
    stemGeo.computeVertexNormals();
    const stem = new THREE.Mesh(stemGeo, toon("#5f6b2e"));
    stem.position.y = R * 0.56 + 0.05;
    head.add(stem);
    const curl = new THREE.Curve();
    curl.getPoint = (t, out = new THREE.Vector3()) => {
        const a = t * 11;
        return out.set(-0.02 - t * 0.1 + Math.cos(a) * 0.02 * (1 - t * 0.5), R * 0.56 + 0.012 + Math.sin(t * Math.PI) * 0.03, 0.04 + t * 0.06 + Math.sin(a) * 0.02 * (1 - t * 0.5));
    };
    const vine = new THREE.Mesh(new THREE.TubeGeometry(curl, 48, 0.0035, 5), toon("#4d7c2f"));
    head.add(vine);

    // A small gourd on the bale, another on the floor by it.
    const gourdMat = toon("#ffffff", { vertexColors: true });
    for (const [x, y, z, s, c] of [[-0.38, floor + BALE_H + 0.055, 0.08, 0.07, "#d9a441"], [0.56, floor + 0.075, 0.2, 0.095, "#d4631a"]]) {
        const m = add(geo, gourdMat.clone(), x, y, z);
        m.material.color.set(c);
        m.scale.setScalar(s);
        m.rotation.y = rand(0, 6);
    }

    // Its face's light: a glow out of the holes, and on the floor in front.
    const dot = softDot(THREE);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    halo.scale.set(0.95, 0.95, 1);
    halo.position.set(0, midY, R + 0.06);
    g.add(halo);
    const castCanvas = document.createElement("canvas");
    castCanvas.width = castCanvas.height = 512;
    const castTex = new THREE.CanvasTexture(castCanvas);
    castTex.colorSpace = THREE.SRGBColorSpace;
    const cast = add(new THREE.PlaneGeometry(1.5, 1.5), basic("#ffffff", { map: castTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }), 0, floor + 0.006, FRONT + 0.75);
    cast.rotation.x = -Math.PI / 2;
    cast.userData.clear = true;

    // The bats. Three meshes of instances: a body, each wing (the left one
    // mirrored); flat black, seen against the glow. Each frame sets them.
    const N = BATS_ROUND + BATS_OUT;
    const dark = new THREE.MeshBasicMaterial({ color: "#0d0812", side: THREE.DoubleSide });
    const wingGeo = batWing(THREE);
    const bodyGeo = new THREE.SphereGeometry(0.03, 8, 6);
    bodyGeo.scale(0.8, 0.75, 1.5);
    const swarm = [new THREE.InstancedMesh(bodyGeo, dark, N), new THREE.InstancedMesh(wingGeo, dark, N), new THREE.InstancedMesh(wingGeo, dark, N)];
    for (const m of swarm) {
        m.frustumCulled = false;
        m.userData.clear = true;
        m.visible = false;
        m.count = 0;
        g.add(m);
    }
    const bats = Array.from({ length: N }, (_, i) => ({
        ph: rand(0, 6.28), rate: rand(0.75, 1.15), r: rand(0.8, 1.25), h: rand(0.55, 1.05), dir: i % 2 ? 1 : -1,
        out: i >= BATS_ROUND, t: -1, last: null, hz: BAT_HZ * rand(0.85, 1.2),
    }));
    const obj = new THREE.Object3D();
    const pos = new THREE.Vector3();
    const place = (b, i, flap, k) => {
        if (b.last) {
            const dx = pos.x - b.last.x, dz = pos.z - b.last.z;
            if (dx * dx + dz * dz > 1e-8) b.yaw = Math.atan2(dx, dz);
        } else b.last = new THREE.Vector3();
        b.last.copy(pos);
        const set = (mesh, z, sx) => {
            obj.position.copy(pos);
            obj.rotation.set(0.25, b.yaw || 0, z, "YXZ");
            obj.scale.set(sx * k, k, k);
            obj.updateMatrix();
            mesh.setMatrixAt(i, obj.matrix);
        };
        set(swarm[0], 0, 1);
        set(swarm[1], flap, 1);
        set(swarm[2], -flap, -1);
    };

    let faceNow = null, boo = -1, booK = 0;
    const fleshOff = new THREE.Color("#8a5a2b"), fleshHot = new THREE.Color();
    parts.flare = 0;
    parts.boo = (k = 1) => {
        boo = 0;
        booK = k;
        if (k < 1) return;
        for (const b of bats) if (b.out) { b.t = 0; b.life = rand(BAT_OUT_S[0], BAT_OUT_S[1]); b.ang = rand(-1.25, 1.25); b.up = rand(0.7, 2); b.last = null; }
    };
    const carve = (face) => {
        const c = canvas.getContext("2d");
        c.fillStyle = "#ffffff";
        c.fillRect(0, 0, 1024, 1024);
        c.fillStyle = c.strokeStyle = "#000000";
        cutFace(c, 1024, face, true);
        cut.needsUpdate = true;
        // Black skin, white soft round the cuts: where the light soaks through.
        const k = skinGlowCanvas.getContext("2d");
        k.filter = "none";
        k.fillStyle = "#000000";
        k.fillRect(0, 0, 512, 512);
        k.filter = "blur(6px)";
        k.fillStyle = k.strokeStyle = "#ffffff";
        cutFace(k, 512, face, false);
        k.filter = "none";
        skinGlow.needsUpdate = true;
        // The face on the floor: soft-edged, fading with distance.
        const f = castCanvas.getContext("2d");
        f.globalCompositeOperation = "source-over";
        f.clearRect(0, 0, 512, 512);
        f.filter = "blur(5px)";
        f.fillStyle = f.strokeStyle = "#ffffff";
        cutFace(f, 512, face, false);
        f.filter = "none";
        f.globalCompositeOperation = "destination-in";
        const grad = f.createRadialGradient(256, 170, 60, 256, 256, 280);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        f.fillStyle = grad;
        f.fillRect(0, 0, 512, 512);
        castTex.needsUpdate = true;
    };
    parts.pumpkin = ({ on, shade }) => {
        // Scrolled to a new face while it's lit: a little flare.
        if (faceNow && faceNow !== shade.face && on) parts.boo(0.45);
        if (faceNow !== shade.face) carve(shade.face);
        faceNow = shade.face;
        const [core, body, tip] = shade.flame;
        skin.color.set(shade.color);
        skin.emissive.set(on ? body : "#000000");
        fire.uniforms.core.value.set(core);
        fire.uniforms.body.value.set(body);
        fire.uniforms.tip.value.set(tip);
        hollow.uniforms.hot.value.set(core);
        hollow.uniforms.warm.value.set(body);
        fleshHot.set(body).lerp(new THREE.Color(core), 0.35);
        halo.material.color.set(body);
        cast.material.color.set(body);
        flames.visible = halo.visible = cast.visible = on;
    };

    parts.tick = (dt, time, on) => {
        fire.uniforms.time.value = time;
        // The stage's flicker (scene_stage _lampFrame), so light and face agree.
        const k = 0.85 + 0.1 * Math.sin(time * 13) + 0.05 * Math.sin(time * 29 + 1.3);
        if (boo >= 0) {
            boo += dt;
            if (boo > BOO_S) boo = -1;
        }
        const f = parts.flare = boo < 0 ? 0 : booK * Math.min(1, boo / 0.06) * (1 - boo / BOO_S) ** 1.5;
        // A rattle: rocking and hopping on the bale, dying away.
        head.rotation.z = f * 0.1 * Math.sin(time * 34);
        head.rotation.x = f * 0.04 * Math.sin(time * 27);
        head.position.y = midY + f * 0.035 * Math.abs(Math.sin(time * 19));
        head.scale.setScalar(1 + f * 0.05);
        if (on) {
            const glow = k * (1 + f * 2.4);
            hollow.uniforms.power.value = 1.3 * glow;
            skin.emissiveIntensity = 0.3 * glow;
            flesh.color.copy(fleshHot).multiplyScalar(Math.min(1.3, 0.55 + 0.5 * glow));
            halo.material.opacity = Math.min(0.9, 0.2 * glow);
            cast.material.opacity = Math.min(1, 0.42 * glow);
        } else {
            hollow.uniforms.power.value = 0;
            skin.emissiveIntensity = 0;
            flesh.color.copy(fleshOff);
        }
        // The bats: round and round it while it's lit; out of its mouth and
        // away on a boo.
        let shown = 0;
        for (const b of bats) {
            if (b.out ? b.t < 0 : !on) continue;
            const i = shown++;
            const flap = 0.65 * Math.sin(2 * Math.PI * b.hz * time + b.ph);
            let scale = 1;
            if (b.out) {
                b.t += dt;
                const s = b.t / b.life;
                if (s >= 1) { b.t = -1; shown--; continue; }
                const go = 3.6 * s ** 1.2;
                pos.set(Math.sin(b.ang) * go + 0.14 * Math.sin(time * 7 + b.ph) * s, midY - 0.05 + b.up * go * 0.75 * (0.25 + s) + 0.1 * Math.sin(time * 5 + b.ph), R + Math.cos(b.ang) * go * 0.6);
                scale = Math.min(1, b.t / 0.12) * Math.min(1, (1 - s) / 0.12);
            } else {
                const a = (time * 0.85 * b.rate + b.ph) * b.dir;
                const rr = b.r + 0.18 * Math.sin(time * 0.6 + b.ph);
                pos.set(Math.cos(a) * rr, midY + R + b.h + 0.16 * Math.sin(time * 1.1 + b.ph), Math.sin(a) * rr * 0.8);
            }
            place(b, i, flap, scale);
        }
        for (const m of swarm) {
            m.visible = shown > 0;
            m.count = shown;
            m.instanceMatrix.needsUpdate = true;
        }
    };
}

/** The aquarium: a stand, the tank on it with gravel, plants, a rock, an
 *  air stone's bubbles and its fish, lit from the hood. parts.aquarium
 *  sets its look; parts.feed() sprinkles flakes on the water. */
function buildAquarium(THREE, def, g, parts, add, toon, basic, glow, floor) {
    // The tank (catalog: 76 × 30 × 30 cm) on its stand.
    const W = 0.76, D = 0.3, H = 0.3, STAND = 0.72;
    const wood = toon("#3b2a20"), trim = toon("#111827");
    add(new THREE.BoxGeometry(W + 0.04, STAND, D + 0.06), wood, 0, floor + STAND / 2, 0);
    add(new THREE.BoxGeometry(0.006, STAND - 0.1, 0.004), trim, 0, floor + STAND / 2, (D + 0.06) / 2 + 0.002);
    for (const x of [-0.04, 0.04]) add(new THREE.SphereGeometry(0.008, 8, 6), toon("#d6b17a"), x, floor + STAND * 0.55, (D + 0.06) / 2 + 0.008);
    const y0 = floor + STAND;
    add(new THREE.BoxGeometry(W + 0.012, 0.018, D + 0.012), trim, 0, y0 + 0.009, 0);
    add(new THREE.BoxGeometry(W + 0.02, 0.035, D + 0.02), trim, 0, y0 + H + 0.0175, 0);
    glow.push(add(new THREE.BoxGeometry(W - 0.06, 0.004, 0.02), basic("#ffffff"), 0, y0 + H - 0.004, 0));
    const surface = y0 + 0.018 + H * 0.88;
    // Lit by the hood when it's on: the background on the back glass, the
    // gravel, the plants.
    const litMats = [];
    const back = canvasTex(THREE, 8, 128, (c, w, h) => {
        const gr = c.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, "#0e7490");
        gr.addColorStop(1, "#082f49");
        c.fillStyle = gr;
        c.fillRect(0, 0, w, h);
    });
    const backMat = toon("#ffffff", { map: back, emissiveMap: back });
    litMats.push(backMat);
    add(new THREE.PlaneGeometry(W - 0.01, H - 0.02), backMat, 0, y0 + H / 2, -D / 2 + 0.004);
    const pebbles = canvasTex(THREE, 256, 64, (c, w, h) => {
        c.fillStyle = "#a8a29e";
        c.fillRect(0, 0, w, h);
        const cols = ["#d6d3d1", "#78716c", "#e7e5e4", "#57534e", "#c2a68a"];
        for (let i = 0; i < 900; i++) {
            c.fillStyle = cols[i % cols.length];
            c.beginPath();
            c.ellipse(rand(0, w), rand(0, h), rand(1, 2.6), rand(0.8, 2), rand(0, 3), 0, Math.PI * 2);
            c.fill();
        }
    });
    const gravel = toon("#ffffff", { map: pebbles, emissiveMap: pebbles });
    litMats.push(gravel);
    add(new THREE.BoxGeometry(W - 0.01, 0.04, D - 0.01), gravel, 0, y0 + 0.038, 0);
    const bedTop = y0 + 0.058;
    const rock = add(new THREE.DodecahedronGeometry(0.06, 1), toon("#6b7280"), 0.1, bedTop + 0.02, -0.06);
    rock.scale.set(1.4, 0.8, 1);
    const drift = add(new THREE.CylinderGeometry(0.014, 0.02, 0.32, 8), toon("#6b4423"), -0.06, bedTop + 0.035, 0.0);
    drift.rotation.set(0, 0.4, Math.PI / 2 - 0.35);
    // Ribbon plants in a clump at each end, swaying.
    const leaf = [toon("#22c55e", { side: THREE.DoubleSide }), toon("#15803d", { side: THREE.DoubleSide })];
    litMats.push(...leaf);
    const blades = [];
    for (let i = 0; i < 18; i++) {
        const h = rand(0.12, 0.24);
        const geo = new THREE.PlaneGeometry(0.012, h, 1, 4);
        geo.translate(0, h / 2, 0);
        const x = i % 2 ? rand(-W / 2 + 0.03, -W / 2 + 0.18) : rand(W / 2 - 0.2, W / 2 - 0.04);
        const b = add(geo, leaf[i % 3 === 0 ? 1 : 0], x, bedTop - 0.005, rand(-D / 2 + 0.03, 0));
        b.rotation.y = rand(0, Math.PI);
        blades.push({ m: b, ph: rand(0, 6), lean: rand(-0.12, 0.12) });
    }
    // The light on the floor and back through the ripples: two layers
    // drifting across each other.
    const c1 = causticTex(THREE), c2 = c1.clone();
    c1.repeat.set(3, 1.2);
    c2.repeat.set(2.4, 1);
    const caustics = [c1, c2].map((t) => new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
    const clear = (m, order = 0) => {
        m.userData.clear = true;
        m.renderOrder = order;
        return m;
    };
    caustics.forEach((m, i) => {
        clear(add(new THREE.PlaneGeometry(W - 0.012, D - 0.012), m, 0, bedTop + 0.002 + i * 0.001, 0)).rotation.x = -Math.PI / 2;
        clear(add(new THREE.PlaneGeometry(W - 0.012, surface - bedTop), m, 0, (bedTop + surface) / 2, -D / 2 + 0.006 + i * 0.001));
    });
    const waterMat = new THREE.MeshPhongMaterial({ color: "#7dd3fc", transparent: true, opacity: 0.24, shininess: 90, depthWrite: false });
    clear(add(new THREE.BoxGeometry(W - 0.008, surface - y0 - 0.018, D - 0.008), waterMat, 0, (y0 + 0.018 + surface) / 2, 0), 2);
    clear(add(new THREE.BoxGeometry(W, H, D), new THREE.MeshPhysicalMaterial({
        color: "#e0f7ff", transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false,
    }), 0, y0 + H / 2, 0), 4);
    // The air stone and its bubbles.
    const stone = { x: -W / 2 + 0.07, z: -D / 2 + 0.05 };
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10), toon("#e7e5e4"), stone.x, bedTop + 0.006, stone.z);
    const dot = softDot(THREE);
    const bubbles = Array.from({ length: 26 }, (_, i) => ({ y: bedTop + (i / 26) * (surface - bedTop), ph: rand(0, 6) }));
    const bub = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(bubbles.length * 3), 3)),
        new THREE.PointsMaterial({ size: 0.007, map: dot, transparent: true, depthWrite: false, color: "#e0f2fe", opacity: 0.85 }));
    bub.frustumCulled = false;
    g.add(bub);
    // Flakes on the water when they're fed.
    const FLAKES = 20;
    const flakes = [];
    const flakePts = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(FLAKES * 3), 3)),
        new THREE.PointsMaterial({ size: 0.005, color: "#f97316" }));
    flakePts.frustumCulled = false;
    g.add(flakePts);
    // The fish: neon tetras (2.2 cm) and male guppies (3.5 cm long, nose to
    // the tail's root: FishBase), a dwarf gourami about 6 cm (by eye);
    // cruising at a couple of body lengths a second (by eye). The tetras
    // school; the others go their own way.
    const lo = new THREE.Vector3(-W / 2 + 0.035, bedTop + 0.025, -D / 2 + 0.03);
    const hi = new THREE.Vector3(W / 2 - 0.035, surface - 0.02, D / 2 - 0.03);
    const randIn = (v = new THREE.Vector3()) => v.set(rand(lo.x, hi.x), rand(lo.y, hi.y), rand(lo.z, hi.z));
    const tailGeo = (l, spread) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, -l, spread, 0, -l, -spread, 0]), 3));
        geo.computeVertexNormals();
        return geo;
    };
    const fish = [];
    const mkFish = ({ len, body, deep = 0.17, stripe = null, belly = null, tail, tailLen = 0.3, tailSpread = 0.14, kind, speed }) => {
        const f = new THREE.Group();
        const b = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), toon(body));
        b.scale.set(len * 0.42, len * deep, len * 0.08);
        f.add(b);
        if (belly) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), toon(belly));
            m.scale.set(len * 0.24, len * deep * 0.75, len * 0.083);
            m.position.set(-len * 0.14, -len * deep * 0.25, 0);
            f.add(m);
        }
        if (stripe) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), basic(stripe));
            m.scale.set(len * 0.36, len * deep * 0.28, len * 0.085);
            m.position.set(len * 0.02, len * deep * 0.3, 0);
            f.add(m);
        }
        for (const z of [-1, 1]) {
            const e = new THREE.Mesh(new THREE.SphereGeometry(len * 0.045, 6, 4), basic("#0f172a"));
            e.position.set(len * 0.3, len * deep * 0.25, z * len * 0.07);
            f.add(e);
        }
        const t = new THREE.Mesh(tailGeo(len * tailLen, len * tailSpread), toon(tail, { side: THREE.DoubleSide }));
        t.position.x = -len * 0.38;
        f.add(t);
        g.add(f);
        fish.push({
            g: f, tail: t, kind, speed, p: randIn(), v: new THREE.Vector3(), to: randIn(), t: 0, yaw: rand(-3, 3), pitch: 0, ph: rand(0, 6),
            off: new THREE.Vector3(rand(-0.07, 0.07), rand(-0.03, 0.03), rand(-0.05, 0.05)),
        });
    };
    for (let i = 0; i < 8; i++) mkFish({ len: 0.026, body: "#a3b4c6", deep: 0.15, stripe: "#22d3ee", belly: "#ef4444", tail: "#e2e8f0", kind: "tetra", speed: 0.06 });
    ["#f97316", "#3b82f6", "#ec4899"].forEach((tail) => mkFish({ len: 0.035, body: "#d4d4d8", deep: 0.14, tail, tailLen: 0.55, tailSpread: 0.3, kind: "guppy", speed: 0.045 }));
    mkFish({ len: 0.06, body: "#f97316", deep: 0.3, stripe: "#60a5fa", tail: "#ea580c", tailLen: 0.32, tailSpread: 0.2, kind: "gourami", speed: 0.03 });
    const school = { to: randIn(), t: 0 };
    const tmp = new THREE.Vector3(), want = new THREE.Vector3();
    parts.feed = () => {
        for (let i = 0; i < 14 && flakes.length < FLAKES; i++) {
            flakes.push({ p: new THREE.Vector3(rand(-0.14, 0.14), surface - 0.002, rand(-0.08, 0.08)), float: rand(1.5, 4), dx: rand(-1, 1) });
        }
    };
    parts.tick = (dt, time, on) => {
        dt = Math.min(dt, 0.05);
        if ((school.t -= dt) <= 0) { randIn(school.to); school.t = rand(3, 6); }
        for (const f of fish) {
            // The nearest flake it can see, else the school or its own way.
            let food = null, fd = 0.3;
            for (const fl of flakes) {
                const d = fl.p.distanceTo(f.p);
                if (d < fd) { fd = d; food = fl; }
            }
            let target;
            if (food) target = food.p;
            else if (f.kind === "tetra") target = tmp.copy(school.to).add(f.off).clamp(lo, hi);
            else {
                if ((f.t -= dt) <= 0 || f.p.distanceTo(f.to) < 0.03) { randIn(f.to); f.t = rand(4, 9); }
                target = f.to;
            }
            want.subVectors(target, f.p);
            const d = want.length();
            const sp = (food ? 2.2 : 1) * f.speed * Math.min(1, d / 0.05);
            if (d > 1e-4) want.multiplyScalar(sp / d); else want.set(0, 0, 0);
            f.v.lerp(want, Math.min(1, dt * (food ? 3 : 1.2)));
            f.p.addScaledVector(f.v, dt).clamp(lo, hi);
            // Its nose (+X) the way it swims, turning smoothly.
            const s = f.v.length();
            if (s > 0.004) {
                const yaw = Math.atan2(-f.v.z, f.v.x);
                const dy = Math.atan2(Math.sin(yaw - f.yaw), Math.cos(yaw - f.yaw));
                f.yaw += dy * Math.min(1, dt * 6);
                f.pitch += (Math.asin(Math.max(-1, Math.min(1, f.v.y / s))) * 0.6 - f.pitch) * Math.min(1, dt * 4);
            }
            f.g.position.copy(f.p);
            f.g.rotation.set(0, f.yaw, f.pitch, "YZX");
            f.tail.rotation.y = Math.sin(time * (7 + s * 140) + f.ph) * 0.5;
            if (food && fd < 0.012) flakes.splice(flakes.indexOf(food), 1);
        }
        // Flakes float a moment, then sink; any that reach the gravel are
        // left to the gravel.
        for (let i = flakes.length - 1; i >= 0; i--) {
            const fl = flakes[i];
            if ((fl.float -= dt) > 0) fl.p.x += fl.dx * 0.004 * dt;
            else fl.p.y -= FLAKE_SINK * dt;
            if (fl.p.y < bedTop + 0.003) flakes.splice(i, 1);
        }
        const fp = flakePts.geometry.attributes.position;
        flakes.forEach((fl, i) => fp.setXYZ(i, fl.p.x, fl.p.y, fl.p.z));
        flakePts.geometry.setDrawRange(0, flakes.length);
        fp.needsUpdate = true;
        if (on) {
            const bp = bub.geometry.attributes.position;
            bubbles.forEach((b, i) => {
                b.y += BUBBLE_RISE * dt;
                if (b.y > surface) b.y = bedTop + 0.01;
                bp.setXYZ(i, stone.x + 0.004 * Math.sin(time * 9 + b.ph + b.y * 40), b.y, stone.z + 0.004 * Math.cos(time * 7 + b.ph));
            });
            bp.needsUpdate = true;
        }
        for (const b of blades) {
            b.m.rotation.z = b.lean + 0.09 * Math.sin(time * 0.8 + b.ph);
            b.m.rotation.x = 0.05 * Math.sin(time * 0.6 + b.ph * 1.3);
        }
        c1.offset.set(time * 0.03, time * 0.02);
        c2.offset.set(-time * 0.025, time * 0.035);
    };
    parts.aquarium = ({ on, shade, light }) => {
        waterMat.color.set(shade.water);
        waterMat.emissive.set(on ? shade.water : "#000000").multiplyScalar(on ? 0.3 : 0);
        for (const m of litMats) m.emissive.copy(light).multiplyScalar(on ? (leaf.includes(m) ? 0.15 : 0.35) : 0);
        for (const m of caustics) {
            m.color.copy(light);
            m.opacity = on ? 0.22 : 0.04;
        }
        bub.visible = on;
    };
}
