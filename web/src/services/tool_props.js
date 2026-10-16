/**
 * Props and effects for tool motions (models/tool_motion.js): a phone in
 * the hand while the companion texts someone, a palette and brush while a
 * picture is painted, a holographic keyboard for a computer task, an orb
 * of light gathered between the hands for a new background.
 *
 * Props are small GLBs built by tools/motion/tool_motions/build_tool_motions.py
 * together with the clips that hold them; the manifest gives each one's
 * bone and grip. A prop is parented to the actor's NORMALIZED humanoid
 * bone (three-vrm keeps that rig in the scene graph, with identity rest
 * rotations), so the grip — authored in the VRM 1.0 frame — is the same
 * on every avatar. VRM 0.x rigs face the other way round that rig (the
 * same 180° the VRMA retarget corrects for), so there the grip is turned
 * 180° about Y.
 *
 * Props appear and go by scaling (a quick pop, not a fade: their
 * materials stay opaque), at the moments the clip's hand reaches the
 * pocket or the keys light up (see the manifest's show_in / hide_out).
 */

const POP_S = 0.16;           // scale-in / scale-out time of a prop
const ORB_GROW_S = 0.7;       // orb fading in round the hands
const ORB_BURST_S = 0.8;      // orb flung outwards and gone
const ORB_COUNT = 72;

// Same world-size point sprite as ambience.js (see its note on three's
// attenuation leaving out the focal term).
const ORB_VERTEX = /* glsl */`
    attribute float size;
    attribute float alpha;
    attribute vec3 tint;
    uniform float scale;
    varying float vAlpha;
    varying vec3 vTint;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(128.0, size * scale * projectionMatrix[1][1] / -mv.z);
        gl_Position = projectionMatrix * mv;
        vAlpha = alpha;
        vTint = tint;
    }`;

const ORB_FRAGMENT = /* glsl */`
    uniform sampler2D map;
    uniform float opacity;
    varying float vAlpha;
    varying vec3 vTint;
    void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vTint * t.rgb, t.a * vAlpha * opacity);
        #include <colorspace_fragment>
    }`;

function glowTexture(THREE) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.65)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** The normalized bone the manifest names, on `vrm`. */
function boneNode(vrm, bone) {
    return vrm?.humanoid?.getNormalizedBoneNode?.(bone) || null;
}

class Orb {
    constructor(THREE, vrm, map) {
        this.THREE = THREE;
        this.vrm = vrm;
        this.time = 0;
        this.state = "grow";
        this.stateT = 0;
        const geometry = new THREE.BufferGeometry();
        this.positions = new Float32Array(ORB_COUNT * 3);
        this.sizes = new Float32Array(ORB_COUNT);
        this.alphas = new Float32Array(ORB_COUNT);
        const tints = new Float32Array(ORB_COUNT * 3);
        geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
        geometry.setAttribute("size", new THREE.BufferAttribute(this.sizes, 1));
        geometry.setAttribute("alpha", new THREE.BufferAttribute(this.alphas, 1));
        geometry.setAttribute("tint", new THREE.BufferAttribute(tints, 3));
        // Per mote: an orbit (axis, radius, speed, phase) round the centre,
        // a colour along cyan → violet → pink, and a flicker phase.
        this.motes = [];
        const a = new THREE.Color(0x66e0ff), b = new THREE.Color(0xa070ff), c = new THREE.Color(0xff7ad9);
        const col = new THREE.Color();
        for (let i = 0; i < ORB_COUNT; i++) {
            const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            const u = Math.random();
            col.copy(u < 0.5 ? a : b).lerp(u < 0.5 ? b : c, (u % 0.5) * 2);
            tints.set([col.r, col.g, col.b], i * 3);
            this.motes.push({
                axis,
                start: new THREE.Vector3().randomDirection().projectOnPlane(axis).normalize(),
                radius: 0.03 + Math.random() * 0.065,
                speed: (1.6 + Math.random() * 2.4) * (Math.random() < 0.5 ? -1 : 1),
                phase: Math.random() * Math.PI * 2,
                size: 0.008 + Math.random() * 0.016,
                vel: new THREE.Vector3(),
                pos: new THREE.Vector3(),
            });
        }
        this.material = new THREE.ShaderMaterial({
            uniforms: { map: { value: map }, opacity: { value: 0 }, scale: { value: 1 } },
            vertexShader: ORB_VERTEX,
            fragmentShader: ORB_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.points = new THREE.Points(geometry, this.material);
        this.points.frustumCulled = false;
        this.core = new THREE.Sprite(new THREE.SpriteMaterial({
            map, color: 0xb8a0ff, transparent: true, opacity: 0, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.center = new THREE.Vector3();
        this._a = new THREE.Vector3();
        this._b = new THREE.Vector3();
        this._q = new THREE.Quaternion();
    }

    /** Between the palms: the middle of the two middle-finger bases. */
    _centre(out) {
        const l = boneNode(this.vrm, "leftMiddleProximal") || boneNode(this.vrm, "leftHand");
        const r = boneNode(this.vrm, "rightMiddleProximal") || boneNode(this.vrm, "rightHand");
        if (!l || !r) return false;
        l.getWorldPosition(this._a);
        r.getWorldPosition(this._b);
        out.addVectors(this._a, this._b).multiplyScalar(0.5);
        return true;
    }

    burst() {
        if (this.state === "burst") return;
        this.state = "burst";
        this.stateT = 0;
        for (const m of this.motes) {
            m.vel.copy(m.pos).sub(this.center).normalize()
                .multiplyScalar(0.9 + Math.random() * 1.4).add(this._b.set(0, 0.25, 0.35));
        }
    }

    /** False once it has burst and faded (dispose it then). */
    update(dt, scale) {
        this.time += dt;
        this.stateT += dt;
        this.material.uniforms.scale.value = scale;
        const burst = this.state === "burst";
        if (!burst) this._centre(this.center);
        const grow = Math.min(1, this.stateT / ORB_GROW_S);
        const fade = burst ? Math.max(0, 1 - this.stateT / ORB_BURST_S) : grow;
        this.material.uniforms.opacity.value = fade;
        for (let i = 0; i < ORB_COUNT; i++) {
            const m = this.motes[i];
            if (burst) {
                m.vel.multiplyScalar(Math.exp(-2.2 * dt));
                m.pos.addScaledVector(m.vel, dt);
            } else {
                this._q.setFromAxisAngle(m.axis, this.time * m.speed + m.phase);
                const breathe = 1 + 0.12 * Math.sin(this.time * 3.1 + m.phase);
                m.pos.copy(m.start).applyQuaternion(this._q)
                    .multiplyScalar(m.radius * (0.35 + 0.65 * grow) * breathe).add(this.center);
            }
            this.positions.set([m.pos.x, m.pos.y, m.pos.z], i * 3);
            this.sizes[i] = m.size;
            this.alphas[i] = 0.55 + 0.45 * Math.sin(this.time * 9 + m.phase * 3);
        }
        const g = this.points.geometry;
        g.getAttribute("position").needsUpdate = true;
        g.getAttribute("alpha").needsUpdate = true;
        g.getAttribute("size").needsUpdate = true;
        // The core: a soft glow that pulses, flares on the burst and goes.
        const flare = burst ? 1 + 2.5 * Math.min(1, this.stateT / 0.12) : 1;
        const pulse = 1 + 0.15 * Math.sin(this.time * 5.3);
        this.core.position.copy(this.center);
        this.core.scale.setScalar(0.13 * grow * pulse * flare);
        this.core.material.opacity = 0.85 * (burst ? Math.max(0, 1 - this.stateT / 0.35) : grow);
        this.core.material.color.setHSL(0.72 + 0.08 * Math.sin(this.time * 1.7), 0.9, 0.72);
        return !(burst && this.stateT >= ORB_BURST_S);
    }

    dispose() {
        this.points.removeFromParent();
        this.core.removeFromParent();
        this.points.geometry.dispose();
        this.material.dispose();
        this.core.material.dispose();
    }
}

export class ToolProps {
    constructor(libs, scene) {
        this.libs = libs;
        this.scene = scene;
        this._models = new Map();   // url → Promise<THREE.Object3D> (the loaded prop, cloned per use)
        this._props = new Set();    // live prop handles
        this._orbs = new Set();
        this._glow = null;
    }

    _load(url) {
        if (!this._models.has(url)) {
            const { GLTFLoader } = this.libs;
            this._models.set(url, new GLTFLoader().loadAsync(url).then((g) => g.scene).catch((e) => {
                console.warn("[tool-motion] prop load failed", url, e);
                this._models.delete(url);
                return null;
            }));
        }
        return this._models.get(url);
    }

    /** Load a prop ahead of its first use, so it is ready by show time. */
    preload(url) {
        if (url) this._load(url);
    }

    /** Put a prop (hidden, scale 0) into `vrm`'s hand. Resolves to a handle
     *  with show() / hide() / dispose(), or null when it can't be placed. */
    async attach(vrm, url, { bone, position, rotation }) {
        const { THREE } = this.libs;
        const model = await this._load(url);
        const node = boneNode(vrm, bone);
        if (!model || !node) return null;
        const obj = model.clone(true);
        const vrm0 = vrm.meta?.metaVersion === "0";
        const p = position || [0, 0, 0];
        obj.position.set(vrm0 ? -p[0] : p[0], p[1], vrm0 ? -p[2] : p[2]);
        obj.quaternion.fromArray(rotation || [0, 0, 0, 1]);
        // The prop itself is modelled in the 1.0 frame too, so on a 0.x rig
        // it turns with it (not the conjugation a bone rotation gets).
        if (vrm0) obj.quaternion.premultiply(new THREE.Quaternion(0, 1, 0, 0));
        obj.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
        obj.scale.setScalar(0);
        obj.visible = false;
        node.add(obj);
        const handle = { obj, vrm, target: 0, value: 0, disposed: false };
        handle.show = () => { handle.target = 1; obj.visible = true; };
        handle.hide = () => { handle.target = 0; };
        handle.dispose = () => {
            handle.disposed = true;
            obj.removeFromParent();
            this._props.delete(handle);
        };
        this._props.add(handle);
        return handle;
    }

    /** Start the orb between `vrm`'s hands; returns it (burst() ends it). */
    orb(vrm) {
        const { THREE } = this.libs;
        this._glow ||= glowTexture(THREE);
        const orb = new Orb(THREE, vrm, this._glow);
        this.scene.add(orb.points);
        this.scene.add(orb.core);
        this._orbs.add(orb);
        return orb;
    }

    /** Per frame, after the bones are posed. `scale` = drawing-buffer height. */
    update(dt, scale) {
        for (const h of this._props) {
            // The avatar was swapped or unloaded underneath it.
            if (!h.vrm?.scene?.parent) { h.dispose(); continue; }
            if (h.value === h.target) continue;
            const step = dt / POP_S;
            h.value = h.target > h.value ? Math.min(h.target, h.value + step) : Math.max(h.target, h.value - step);
            // Ease-out-back on the way in for a little pop.
            const s = h.value;
            const k = h.target > 0 ? 1 + 2.2 * (s - 1) ** 3 + 1.2 * (s - 1) ** 2 : s * s;
            h.obj.scale.setScalar(Math.max(0, k));
            if (h.value === 0) h.obj.visible = false;
        }
        for (const orb of this._orbs) {
            const alive = orb.vrm?.scene?.parent && orb.update(dt, scale);
            if (!alive) {
                orb.dispose();
                this._orbs.delete(orb);
            }
        }
    }

    get active() {
        return this._props.size > 0 || this._orbs.size > 0;
    }
}
