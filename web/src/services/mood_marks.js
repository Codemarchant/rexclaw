/**
 * Mood marks — manga emotion marks (漫符) that pop up beside the
 * companion's head when their emotion changes: ♪ for happy, the anger mark
 * for angry, "!" for surprised, a rain cloud for sad, a sigh puff for
 * relaxed (standard manpu meanings; the sweat drop reads as nervous, not
 * sad, so sad gets the gloom cloud).
 *
 * Drawn as sprites in the three.js scene rather than as DOM overlays: the
 * head hides a mark that sits behind it, marks stay with the avatar as it
 * moves and scale with the framing, and they show on the desktop mascot, in
 * selfies and in VR too. Glyphs are painted once onto canvases — no image
 * assets. Placement is in camera space beside the head (never across the
 * face), re-placed every frame; sizes and timings are design values tuned
 * by eye.
 */

const TAU = Math.PI * 2;

// Emotion → mark: glyph, offset from the head (metres along the camera's
// right / up; x is mirrored to a random side), size, life (s), how many.
const MOOD_MARKS = {
    happy:     { glyph: "note",    x: 0.19, y: 0.1,   size: 0.05, life: 1.8, count: 2 },
    angry:     { glyph: "anger",   x: 0.15, y: 0.14,  size: 0.05, life: 2.0 },
    surprised: { glyph: "exclaim", x: 0.17, y: 0.15,  size: 0.05, life: 1.3 },
    sad:       { glyph: "gloom",   x: 0,    y: 0.22,  size: 0.07, life: 2.4 },
    relaxed:   { glyph: "puff",    x: 0.14, y: -0.02, size: 0.05, life: 1.6 },
};

function circle(p, x, y, r) {
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, TAU);
}

/** Fill `build`'s path over a dark outline and a white halo, so a mark
 *  reads on light and dark backdrops alike. */
function outlined(ctx, s, color, build) {
    const p = new Path2D();
    build(p);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = s * 0.1;
    ctx.stroke(p);
    ctx.strokeStyle = "#3b2a33";
    ctx.lineWidth = s * 0.045;
    ctx.stroke(p);
    ctx.fillStyle = color;
    ctx.fill(p);
}

// Glyph painters, (ctx, s) on an s×s canvas.
const GLYPHS = {
    note(ctx, s) {
        outlined(ctx, s, "#ffb938", (p) => {
            p.ellipse(s * 0.36, s * 0.74, s * 0.15, s * 0.11, -0.4, 0, TAU);
            p.rect(s * 0.47, s * 0.14, s * 0.075, s * 0.62);
            p.moveTo(s * 0.545, s * 0.14);
            p.quadraticCurveTo(s * 0.86, s * 0.28, s * 0.76, s * 0.58);
            p.quadraticCurveTo(s * 0.75, s * 0.38, s * 0.545, s * 0.34);
            p.closePath();
        });
    },
    anger(ctx, s) {
        // Four curved arms, their corners pointing at the centre (💢).
        ctx.translate(s / 2, s / 2);
        const arm = new Path2D();
        arm.moveTo(s * 0.07, -s * 0.36);
        arm.quadraticCurveTo(s * 0.09, -s * 0.09, s * 0.36, -s * 0.07);
        ctx.lineCap = "round";
        for (const [color, width] of [["rgba(255, 255, 255, 0.95)", 0.2], ["#e3232f", 0.11]]) {
            ctx.strokeStyle = color;
            ctx.lineWidth = s * width;
            for (let i = 0; i < 4; i++) {
                ctx.stroke(arm);
                ctx.rotate(Math.PI / 2);
            }
        }
    },
    exclaim(ctx, s) {
        outlined(ctx, s, "#ffd93b", (p) => {
            p.moveTo(s * 0.37, s * 0.1);
            p.lineTo(s * 0.63, s * 0.1);
            p.lineTo(s * 0.56, s * 0.62);
            p.lineTo(s * 0.44, s * 0.62);
            p.closePath();
            circle(p, s * 0.5, s * 0.8, s * 0.1);
        });
    },
    gloom(ctx, s) {
        ctx.lineCap = "round";
        ctx.strokeStyle = "#4f8ff0";
        ctx.lineWidth = s * 0.045;
        for (const x of [0.34, 0.52, 0.7]) {
            ctx.beginPath();
            ctx.moveTo(s * x, s * 0.68);
            ctx.lineTo(s * (x - 0.05), s * 0.88);
            ctx.stroke();
        }
        outlined(ctx, s, "#8d97a9", (p) => {
            circle(p, s * 0.3, s * 0.46, s * 0.15);
            circle(p, s * 0.52, s * 0.36, s * 0.2);
            circle(p, s * 0.72, s * 0.48, s * 0.14);
            p.rect(s * 0.3, s * 0.44, s * 0.42, s * 0.17);
        });
    },
    puff(ctx, s) {
        outlined(ctx, s, "#ffffff", (p) => {
            circle(p, s * 0.34, s * 0.58, s * 0.15);
            circle(p, s * 0.52, s * 0.46, s * 0.19);
            circle(p, s * 0.7, s * 0.6, s * 0.13);
        });
    },
};

function easeOutBack(k) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
}

export class MoodMarks {
    constructor(THREE, scene) {
        this.THREE = THREE;
        this.group = new THREE.Group();
        this.group.name = "mood-marks";
        scene.add(this.group);
        this._textures = {};
        this._pools = {};      // glyph → idle sprites
        this._live = [];
        this._pending = null;
        this._head = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3();
        this._back = new THREE.Vector3();
    }

    /** An emotion was set — its mark pops on the next update, unless that
     *  same mark is still showing. */
    show(name) {
        if (!MOOD_MARKS[name] || this._live.some((p) => p.emotion === name)) return;
        this._pending = name;
    }

    /** Per frame. head: the head bone's world position (null without an
     *  avatar); camera: the viewing camera. */
    update(dt, head, camera) {
        if (!this._pending && !this._live.length) return;
        const e = camera.matrixWorld.elements;
        this._right.set(e[0], e[1], e[2]).normalize();
        this._up.set(e[4], e[5], e[6]).normalize();
        this._back.set(e[8], e[9], e[10]).normalize();
        if (head) {
            this._head.copy(head);
            if (this._pending) {
                this._spawnMark(this._pending);
                this._pending = null;
            }
        }
        for (let i = this._live.length - 1; i >= 0; i--) {
            const p = this._live[i];
            p.age += dt;
            if (p.age >= p.life) this._release(i);
            else this._place(p);
        }
    }

    dispose() {
        this.group.removeFromParent();
        this.group.traverse((o) => o.material?.dispose());
        for (const t of Object.values(this._textures)) t.dispose();
    }

    _texture(glyph) {
        if (!this._textures[glyph]) {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 128;
            GLYPHS[glyph](canvas.getContext("2d"), 128);
            const tex = new this.THREE.CanvasTexture(canvas);
            tex.colorSpace = this.THREE.SRGBColorSpace;
            this._textures[glyph] = tex;
        }
        return this._textures[glyph];
    }

    _spawnMark(emotion) {
        // One mark at a time: a new emotion replaces the last one's.
        for (let i = this._live.length - 1; i >= 0; i--) this._release(i);
        const m = MOOD_MARKS[emotion];
        const side = Math.random() < 0.5 ? -1 : 1;
        for (let n = 0; n < (m.count || 1); n++) {
            const pool = (this._pools[m.glyph] ||= []);
            let sprite = pool.pop();
            if (!sprite) {
                sprite = new this.THREE.Sprite(new this.THREE.SpriteMaterial({
                    map: this._texture(m.glyph), transparent: true, depthWrite: false,
                }));
                this.group.add(sprite);
            }
            sprite.visible = true;
            const p = {
                emotion, glyph: m.glyph, sprite, side, phase: Math.random() * TAU,
                x: side * (m.x + n * 0.05), y: m.y + n * 0.04, z: 0.05,
                size: m.size, life: m.life, age: -n * 0.3,
            };
            this._live.push(p);
            this._place(p);
        }
    }

    _release(i) {
        const p = this._live[i];
        const last = this._live.pop();
        if (last !== p) this._live[i] = last;
        p.sprite.visible = false;
        this._pools[p.glyph].push(p.sprite);
    }

    _place(p) {
        const t = p.age;
        let x = p.x, y = p.y, scale = p.size, opacity = 1, rot = 0;
        if (t < 0) {
            opacity = 0;   // a mark waiting for its turn (the second ♪)
        } else {
            scale *= t < 0.3 ? easeOutBack(t / 0.3) : 1;
            opacity = Math.min(1, (p.life - t) / 0.35);
            switch (p.glyph) {
                case "note":
                    y += t * 0.05;
                    x += Math.sin(t * 5 + p.phase) * 0.012;
                    rot = Math.sin(t * 4 + p.phase) * 0.2;
                    break;
                case "anger":
                    scale *= 1 + 0.12 * Math.max(0, Math.sin(t * 13));
                    break;
                case "exclaim":
                    if (t < 0.35) x += Math.sin(t * 60) * 0.004;
                    break;
                case "gloom":
                    y += Math.sin(t * 2.2) * 0.008;
                    break;
                case "puff":
                    x += t * 0.05 * p.side;
                    y += t * 0.03;
                    scale *= 1 + t * 0.25;
                    break;
            }
        }
        const s = p.sprite;
        s.position.copy(this._head)
            .addScaledVector(this._right, x)
            .addScaledVector(this._up, y)
            .addScaledVector(this._back, p.z);
        s.scale.setScalar(Math.max(scale, 1e-4));
        s.material.opacity = Math.max(opacity, 0);
        s.material.rotation = rot;
    }
}
