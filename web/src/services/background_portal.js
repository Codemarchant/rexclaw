/**
 * Background portal — a new background arriving through a tear in the
 * world (change_background; models/tool_motion.js starts it from the
 * companion's hands).
 *
 * Charging, the old scene dims and pulls towards the orb. Open, a vertical
 * slit tears at the hands, widens into a jagged rift with a burning edge,
 * and the new scene floods out through it to the corners of the screen,
 * settling from a slight zoom. The renderer then swaps the real background
 * in underneath (fade()) and the portal dissolves into it, so the hand-over
 * is exact whatever the backdrop's filters.
 *
 * It is one full-screen quad at the far plane of the scene, not a layer of
 * its own: the companion stays in front of it, transparent hair and
 * ambience draw over it, and the glow pass and the art style see it like
 * the rest of the frame. Over a 2D backdrop only the rift and the band of
 * old scene it bends are drawn — the real backdrop (a playing video
 * included) stays live round them. A 3D room can't stay behind a far-plane
 * quad, so there the old scene is a snapshot of the room, drawn opaque.
 */

const CHARGE_S = 0.6;         // old scene dimming towards the orb (matches the clip's wind-up)
const OPEN_S = 2.1;           // from the first tear to the corners
const FADE_S = 0.35;          // portal dissolving into the real background
const CHARGE_DIM = 0.42;      // how far the old scene falls while charging
const MEDIA_MS = 1500;        // a new background not loaded by then just swaps in
const UNCLAIMED_S = 2.5;      // no motion opened it (it stood down): opens by itself
const GUST_MS = 1800;         // the wind off the tear, dying away
const GUST_SPEED = 4.5;       // m/s at its height, on the toys' wind scale
const LIGHT_MS = 1400;        // the light of the new scene washing over the companion
const LIGHT_BOOST = 0.7;

/** Which background this is, to tell a real switch from a re-apply. */
export const backgroundKey = (b) => (b ? `${b.id ?? ""}|${b.name ?? ""}|${b.scene_url || b.video_url || b.image_url || b.preset_style || ""}` : "");

const VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.99999, 1.0);
    }`;

const FRAGMENT = /* glsl */`
    uniform sampler2D oldMap;
    uniform sampler2D newMap;
    uniform vec2 newCover;      // CSS background-size: cover, as a UV scale
    uniform vec2 center;        // the hands, in UV
    uniform float aspect;
    uniform float charge;       // 0..1 wind-up
    uniform float open;         // 0..1 eased rift
    uniform float time;
    uniform float fade;         // 1 → 0 dissolving at the end
    uniform float opaqueOld;    // 1: oldMap IS the backdrop (a room's snapshot)
    uniform float reach;        // distance from the hands to the farthest corner
    uniform vec3 tint;          // the destination's own colour
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.03 + vec2(13.7, 7.1);
            a *= 0.5;
        }
        return v;
    }
    vec3 newAt(vec2 uv) {
        return texture2D(newMap, 0.5 + (uv - 0.5) * newCover).rgb;
    }

    void main() {
        vec2 p = (vUv - center) * vec2(aspect, 1.0);
        float len = length(p);
        vec2 dir = len > 1e-4 ? p / len : vec2(0.0, 1.0);

        // A slit that becomes a round rift: x counts for more early on.
        float round_ = smoothstep(0.0, 0.55, open);
        float d = length(p * vec2(mix(9.0, 1.0, round_), mix(0.62, 1.0, round_)));
        float radius = open * reach * 1.45;
        // Torn edge. Sampled round a circle, so it has no seam, and scaled
        // by the radius, so the tear starts as a clean line.
        float tear = fbm(dir * 2.6 + time * 0.18) - 0.5
            + 0.45 * (fbm(dir * 9.0 - time * 0.3) - 0.5);
        float s = d + tear * min(radius, 0.42) * 0.85 - radius;
        if (open <= 0.0) s = 10.0;

        float inside = 1.0 - smoothstep(-0.006, 0.0, s);
        float out_ = max(s, 0.0);
        float into = max(-s, 0.0);

        // The old scene bends round the rift, and pulls in as it charges.
        float bend = exp(-out_ * 7.0) * step(0.0, radius - 0.001) * 0.1
            + charge * (1.0 - open) * exp(-len * 2.2) * 0.035;
        vec2 oldUv = vUv - (dir / vec2(aspect, 1.0)) * bend;
        vec3 old = texture2D(oldMap, oldUv).rgb;
        float shade = 1.0 - 0.5 * exp(-out_ * 5.0) * smoothstep(0.0, 0.1, radius);

        // The new scene: arriving from slightly behind, split at the edge.
        float zoom = 1.0 - 0.16 * (1.0 - open) * (1.0 - open);
        vec2 newUv = center + (vUv - center) * zoom;
        vec2 split = (dir / vec2(aspect, 1.0)) * 0.016 * exp(-into * 11.0);
        vec3 fresh = vec3(newAt(newUv + split).r, newAt(newUv).g, newAt(newUv - split).b);

        vec3 color = mix(old * shade, fresh, inside);

        // The burning edge: a white-hot line in the destination's colour
        // haze, with sparks of fire running along it.
        float streak = fbm(vec2(atan(dir.y, dir.x) * 5.0, d * 5.0 - time * 2.4));
        float line = exp(-abs(s) * 95.0);
        float haze = exp(-abs(s) * 13.0) * (0.25 + 0.95 * streak * streak * 2.0);
        float live = smoothstep(0.0, 0.03, open) * (1.0 - smoothstep(0.86, 1.0, open));
        vec3 glow = (vec3(1.0, 0.97, 0.92) * line * 2.6 + tint * haze * 1.5) * live;

        // Over a live backdrop: draw only what the rift touches.
        float band = opaqueOld > 0.5 ? 1.0 : max(inside, exp(-out_ * 7.0) * step(0.001, radius));
        float dim = CHARGE_DIM_GLSL * charge * (1.0 - inside) * (1.0 - smoothstep(0.75, 1.0, open));
        vec3 premult = color * band * (1.0 - dim) + glow;
        float alpha = max(band + (1.0 - band) * dim, min(1.0, dot(glow, vec3(0.33))));
        premult *= fade;
        alpha *= fade;

        // Encoded as a straight colour, then premultiplied: the blend (and
        // the canvas) are premultiplied, the sRGB curve is not linear.
        gl_FragColor = vec4(alpha > 1e-4 ? premult / alpha : vec3(0.0), alpha);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= alpha;
    }`.replace("CHARGE_DIM_GLSL", CHARGE_DIM.toFixed(3));

const easeOut = (x) => 1 - (1 - x) ** 3;

export class BackgroundPortal {
    /** `oldMap`/`newMap`: textures of the scene leaving and arriving (a
     *  VideoTexture for an animated background). `newSize`: the arriving
     *  picture's pixel size. `opaqueOld`: oldMap replaces the backdrop (a
     *  room). `tint`: a THREE.Color from the new scene. `aim`: returns the
     *  hands in UV (a Vector2, or null), followed until the tear opens. */
    constructor(THREE, scene, { oldMap, newMap, newSize, opaqueOld, tint, aim }) {
        this.scene = scene;
        this.newSize = newSize;
        this.aim = aim;
        this.state = "ready";
        this.t = 0;
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                oldMap: { value: oldMap },
                newMap: { value: newMap },
                newCover: { value: new THREE.Vector2(1, 1) },
                center: { value: new THREE.Vector2(0.5, 0.55) },
                aspect: { value: 16 / 9 },
                charge: { value: 0 },
                open: { value: 0 },
                time: { value: 0 },
                fade: { value: 1 },
                opaqueOld: { value: opaqueOld ? 1 : 0 },
                reach: { value: 1 },
                tint: { value: tint },
            },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            depthWrite: false,
            toneMapped: false,
            // Drawn with the opaque queue, after it (the far plane leaves
            // only empty pixels), before anything transparent — but blended,
            // since the real backdrop shows round the rift.
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.quad.renderOrder = 10000;
        this.quad.visible = false;
        scene.add(this.quad);
    }

    charge() {
        if (this.state !== "ready") return;
        this.state = "charge";
        this.t = 0;
        this.quad.visible = true;
    }

    open() {
        if (this.state === "open" || this.state === "fade") return;
        // Never charged (no motion to time it): the rift opens straight off.
        this._chargeLeft = this.state === "charge" ? this.material.uniforms.charge.value : 0;
        const c = this.aim?.();
        if (c) this.material.uniforms.center.value.copy(c);
        this.state = "open";
        this.t = 0;
        this.quad.visible = true;
    }

    /** The real background is in place underneath: dissolve into it. */
    fade() {
        this.state = "fade";
        this.t = 0;
    }

    get opening() {
        return this.state === "open";
    }

    /** How far the rift has spread, 0..1. */
    get progress() {
        return this.material.uniforms.open.value;
    }

    /** Per frame. True once the rift has covered the screen (time to swap
     *  the background in); after fade(), false again and `done` is set. */
    update(dt, width, height) {
        this.t += dt;
        const u = this.material.uniforms;
        u.time.value += dt;
        u.aspect.value = width / Math.max(1, height);
        const k = (this.newSize.x / this.newSize.y) / u.aspect.value;
        if (k > 1) u.newCover.value.set(1 / k, 1);
        else u.newCover.value.set(1, k);
        if (this.state === "charge") {
            const c = this.aim?.();
            if (c) u.center.value.copy(c);
            u.charge.value = easeOut(Math.min(1, this.t / CHARGE_S));
        } else if (this.state === "open") {
            u.open.value = Math.min(1, easeOut(this.t / OPEN_S) * 0.82 + (this.t / OPEN_S) * 0.18);
            u.charge.value = this._chargeLeft;
        } else if (this.state === "fade") {
            u.fade.value = Math.max(0, 1 - this.t / FADE_S);
            this.done = u.fade.value === 0;
        }
        const cx = Math.max(u.center.value.x, 1 - u.center.value.x) * u.aspect.value;
        const cy = Math.max(u.center.value.y, 1 - u.center.value.y);
        u.reach.value = Math.hypot(cx, cy);
        return this.state === "open" && u.open.value >= 1;
    }

    /** Leaves the textures alone: the stage owns those. */
    dispose() {
        this.quad.removeFromParent();
        this.quad.geometry.dispose();
        this.material.dispose();
    }
}

/**
 * One background's trip through the portal, for the avatar renderer:
 * getting the new scene ready, the wind and light that come with the tear,
 * and handing over to the real background (setBackground) once it is
 * covered. `peerId` as for the tool motions: a group-call peer tears it
 * open at their own hands.
 */
export class PortalStage {
    constructor(renderer) {
        this.r = renderer;
        this.current = null;
        this.token = null;
    }

    get active() {
        return !!this.current;
    }

    /** A portal is waiting for its moment. */
    get ready() {
        return this.current?.portal.state === "ready";
    }

    /** The new background's video element, playing already. */
    get video() {
        return this.current?.video || null;
    }

    /** setBackground(bg) is about to run: true when `bg` is already on its
     *  way through here. Any other background wins, and ends the portal. */
    intercepts(bg) {
        const p = this.current;
        if (!p || p.committing) return false;
        if (backgroundKey(bg) === backgroundKey(p.bg)) return true;
        this.drop();
        return false;
    }

    /** Get `bg` ready behind a closed portal. False when it can't go through
     *  one (a mini host, the see-through mascot, XR, media that won't load):
     *  the caller then just setBackground()s it. Otherwise it stays pending
     *  until charge/open, or opens by itself. */
    async prepare(bg, peerId = null) {
        const r = this.r;
        if (!bg || !r.renderer || r._xrActive || !r._hostPaintsBackdrop(r.activeCanvas)) return false;
        if (!r._toolActor(peerId)?.vrm) return false;
        const { THREE } = r.libs;
        this.drop();
        const token = (this.token = {});
        const media = await this._loadMedia(bg);
        if (!media) return false;
        const oldCanvas = await this._snapshotOldScene();
        if (this.token !== token || !oldCanvas) {
            media.texture.dispose();
            media.video?.pause();
            return false;
        }
        const oldMap = new THREE.CanvasTexture(oldCanvas);
        oldMap.colorSpace = THREE.SRGBColorSpace;
        const tint = this._tintOf(media);
        this.current = {
            bg, oldMap, tint, peerId, age: 0, committing: false,
            newMap: media.texture, video: media.video || null, room: r._room || null,
            portal: new BackgroundPortal(THREE, r.scene, {
                oldMap, newMap: media.texture, newSize: new THREE.Vector2(media.width, media.height),
                opaqueOld: !!r._room, tint, aim: () => this._aim(peerId),
            }),
        };
        return true;
    }

    /** The wind-up. Returns the new scene's colour, for the orb to take on. */
    charge() {
        const p = this.current;
        if (!p) return null;
        if (p.room) p.room.visible = false;   // the portal draws its snapshot from here on
        p.portal.charge();
        return p.tint;
    }

    /** Tear it open. */
    open() {
        const p = this.current;
        if (!p || p.portal.opening || p.portal.state === "fade") return;
        const r = this.r;
        if (p.room) p.room.visible = false;
        p.portal.open();
        p.openedAt = performance.now();
        // The blast off the hands: past the companion, away from the camera
        // and a little up. Hair streams out behind them; a gust the other
        // way carries a ponytail over the shoulder, where the arms coming
        // down then pin it. The toys' breeze, if one is blowing, keeps the air.
        if (!r._toyWind) {
            const { THREE } = r.libs;
            const head = r.getHeadWorldPosition(new THREE.Vector3());
            const dir = head.sub(r.camera.position).setY(0).normalize();
            dir.y = 0.35;
            const gust = { x: 0, y: 0, z: 0 };
            p.gust = { dir, value: gust, fn: () => gust };
            r._toyWind = p.gust.fn;
        }
        const { ambient } = r._lights || {};
        if (ambient) p.light = { color: ambient.color.clone(), intensity: ambient.intensity };
    }

    /** The new background as a texture, with its first frame decoded. */
    async _loadMedia(bg) {
        const r = this.r;
        const { THREE } = r.libs;
        const timeout = (fail) => setTimeout(fail, MEDIA_MS);
        if (bg.video_url) {
            const el = r._makeBackgroundVideo(bg.video_url);
            const ok = await new Promise((resolve) => {
                const t = timeout(() => resolve(false));
                el.addEventListener("loadeddata", () => { clearTimeout(t); resolve(true); }, { once: true });
                el.addEventListener("error", () => { clearTimeout(t); resolve(false); }, { once: true });
                el.play().catch(() => {});
            });
            if (!ok || !el.videoWidth) {
                el.pause();
                el.removeAttribute("src");
                el.load();
                return null;
            }
            const texture = new THREE.VideoTexture(el);
            texture.colorSpace = THREE.SRGBColorSpace;
            return { texture, video: el, source: el, width: el.videoWidth, height: el.videoHeight };
        }
        if (!bg.image_url) return null;
        const texture = await Promise.race([
            new THREE.TextureLoader().loadAsync(bg.image_url).catch(() => null),
            new Promise((resolve) => timeout(() => resolve(null))),
        ]);
        if (!texture?.image?.width) return null;
        texture.colorSpace = THREE.SRGBColorSpace;
        return { texture, source: texture.image, width: texture.image.width, height: texture.image.height };
    }

    /** What is on screen behind the companion now, in a canvas: the 2D
     *  backdrop, and the 3D room over it when there is one (rendered alone,
     *  everything else in the scene but the lights hidden for the frame). */
    async _snapshotOldScene() {
        const r = this.r;
        const src = r.renderer.domElement;
        if (!src.width || !src.height) return null;
        const c = document.createElement("canvas");
        c.width = Math.ceil(src.width / 2);
        c.height = Math.ceil(src.height / 2);
        const ctx = c.getContext("2d");
        await r._drawBackdropOnto(ctx, c.width, c.height);
        const room = r._room;
        if (room) {
            const hidden = r.scene.children.filter((o) => o !== room && o.visible && !o.isLight);
            for (const o of hidden) o.visible = false;
            r._draw({ art: false });
            ctx.drawImage(src, 0, 0, c.width, c.height);
            for (const o of hidden) o.visible = true;
            r._draw();
        }
        return c;
    }

    /** The new scene's most vivid colour: its rift burns in it. */
    _tintOf(media) {
        const { THREE } = this.r.libs;
        const tint = new THREE.Color(0.62, 0.45, 1);
        try {
            const c = document.createElement("canvas");
            c.width = c.height = 16;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(media.source, 0, 0, 16, 16);
            const { data } = ctx.getImageData(0, 0, 16, 16);
            let best = 0.08;   // greyer than this keeps the default
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
                const hi = Math.max(r, g, b);
                const score = (hi - Math.min(r, g, b)) * hi;
                if (score > best) {
                    best = score;
                    tint.setRGB(r, g, b, THREE.SRGBColorSpace);
                }
            }
        } catch { /* a tainted canvas keeps the default */ }
        return tint;
    }

    /** Between the actor's hands, as a screen UV. */
    _aim(peerId) {
        const r = this.r;
        const { THREE } = r.libs;
        const humanoid = r._toolActor(peerId)?.vrm?.humanoid;
        const left = humanoid?.getNormalizedBoneNode?.("leftHand");
        const right = humanoid?.getNormalizedBoneNode?.("rightHand");
        if (!left || !right) return null;
        const a = left.getWorldPosition(new THREE.Vector3());
        const b = right.getWorldPosition(new THREE.Vector3());
        a.add(b).multiplyScalar(0.5).project(r.camera);
        return new THREE.Vector2(
            Math.min(0.95, Math.max(0.05, (a.x + 1) / 2)),
            Math.min(0.95, Math.max(0.05, (a.y + 1) / 2)),
        );
    }

    /** Per frame, while active. */
    update(delta) {
        const r = this.r;
        const p = this.current;
        const { portal } = p;
        p.age += delta;
        if (portal.state === "ready" && p.age > UNCLAIMED_S) this.open();
        const size = r.renderer.getDrawingBufferSize(r._sizeScratch ||= new r.libs.THREE.Vector2());
        // Moved to a host that shows no backdrop: straight to the result.
        const covered = portal.update(delta, size.x, size.y) || !r._hostPaintsBackdrop(r.activeCanvas);
        if (p.openedAt) {
            const ms = performance.now() - p.openedAt;
            if (p.gust) {
                const s = ms / GUST_MS;
                const k = GUST_SPEED * Math.min(1, s / 0.1) * Math.max(0, 1 - s) ** 2;
                p.gust.value.x = p.gust.dir.x * k;
                p.gust.value.y = p.gust.dir.y * k;
                p.gust.value.z = p.gust.dir.z * k;
                if (s >= 1) this._endGust(p);
            }
            if (p.light) {
                const s = ms / LIGHT_MS;
                const k = Math.min(1, s / 0.12) * Math.max(0, 1 - s) ** 2;
                const { ambient } = r._lights;
                ambient.color.copy(p.light.color).lerp(p.tint, k * 0.6);
                ambient.intensity = p.light.intensity * (1 + LIGHT_BOOST * k);
                if (s >= 1) this._endLight(p);
            }
        }
        if (covered && portal.state !== "fade") {
            // The real background in place underneath, under the same picture.
            p.committing = true;
            p.room = null;
            r.setBackground(p.bg);
            p.committing = false;
            portal.fade();
        }
        if (portal.done) this.drop();
    }

    _endGust(p) {
        if (p.gust && this.r._toyWind === p.gust.fn) this.r._toyWind = null;
        p.gust = null;
    }

    _endLight(p) {
        if (p.light) {
            this.r._lights.ambient.color.copy(p.light.color);
            this.r._lights.ambient.intensity = p.light.intensity;
        }
        p.light = null;
    }

    /** Clear the portal away, whichever stage it is at. */
    drop() {
        this.token = null;
        const p = this.current;
        if (!p) return;
        this.current = null;
        if (p.room) p.room.visible = true;
        this._endGust(p);
        this._endLight(p);
        p.portal.dispose();
        p.oldMap.dispose();
        p.newMap.dispose();
        // Unless the live background took the element over.
        if (p.video && p.video !== this.r._bgVideoEl) {
            p.video.pause();
            p.video.removeAttribute("src");
            p.video.load();
        }
    }
}
