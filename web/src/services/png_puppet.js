// Copyright 2026 Codemarchant
/**
 * PNG looks: a 2D image standing in the scene where a VRM would.
 *
 * The image loads as a minimal VRM built in code — a humanoid skeleton with
 * no mesh bound to it, the standard expression slots with nothing bound to
 * them, and the image on a flat card that turns to face the camera. Every
 * system that drives a VRM (blink, lip sync, emotions, the procedural idle,
 * gestures, walking, staging) keeps writing its bones and expressions as
 * usual; each frame the card reads them back:
 *
 *   - blink (blink / blinkLeft / blinkRight) and the speech visemes
 *     (aa ih ou ee oh) pick one of up to four frames — the PNGtuber states
 *     base / mouth open / eyes closed / mouth open + eyes closed;
 *   - the head, neck and spine roll tilt the card, the head's nod squashes
 *     it a little, the hips' travel (jumps, root motion) moves it;
 *   - speech bounces it and a surprised face hops it, the classic
 *     PNGtuber reactions.
 *
 * The four-state set follows the PNGTuber avatar spec of AITuber OnAir
 * (shinshin86/aituber-onair, MIT, skills/create-pngtuber-avatar-states):
 * eyes open/closed × mouth closed/open on one canvas.
 *
 * The extra frames ride the look's URL as a fragment the server adds
 * (store.look_url): "/avatars/Kira/kira.png#mouth_open=…&eyes_closed=…".
 * Browsers never send the fragment, so the base URL fetches as-is.
 */
import * as THREE from "three";
import { VRM, VRMExpression, VRMExpressionManager, VRMHumanoid } from "@pixiv/three-vrm";

export const PNG_LOOK_RE = /\.(png|jpe?g|webp)$/i;
export const PNG_FRAMES = ["mouth_open", "eyes_closed", "mouth_open_eyes_closed"];

// The figure's height in metres (the card, cropped to it): a standing
// character's, so a full-body image stands beside VRM companions at their
// scale.
const CARD_HEIGHT = 1.6;

// Rest skeleton (metres, parent-relative) of a 1.6 m figure facing +Z, the
// normalized VRM 1.0 frame, scaled to the figure's own height in the
// image (figureBounds). The camera frames the face at the eye bone, so it
// sits where an illustrated character's eyes are: anime figures are drawn
// six to seven heads tall with the eyes about halfway down the head, i.e.
// about 0.915 of the height (1.465 m) — a drawing convention, not a
// measurement; a VRM's own eye bone sat at 0.94 here and framed the face
// low with the chest cut off.
const BONES = [
    ["hips", null, [0, 0.85, 0]],
    ["spine", "hips", [0, 0.1, 0]],
    ["chest", "spine", [0, 0.12, 0]],
    ["upperChest", "chest", [0, 0.12, 0]],
    ["neck", "upperChest", [0, 0.13, 0]],
    ["head", "neck", [0, 0.08, 0]],
    ["leftEye", "head", [0.03, 0.065, 0.05]],
    ["rightEye", "head", [-0.03, 0.065, 0.05]],
    ["leftShoulder", "upperChest", [0.03, 0.1, 0]],
    ["leftUpperArm", "leftShoulder", [0.12, 0, 0]],
    ["leftLowerArm", "leftUpperArm", [0.25, 0, 0]],
    ["leftHand", "leftLowerArm", [0.22, 0, 0]],
    ["rightShoulder", "upperChest", [-0.03, 0.1, 0]],
    ["rightUpperArm", "rightShoulder", [-0.12, 0, 0]],
    ["rightLowerArm", "rightUpperArm", [-0.25, 0, 0]],
    ["rightHand", "rightLowerArm", [-0.22, 0, 0]],
    ["leftUpperLeg", "hips", [0.09, -0.05, 0]],
    ["leftLowerLeg", "leftUpperLeg", [0, -0.38, 0]],
    ["leftFoot", "leftLowerLeg", [0, -0.38, 0]],
    ["leftToes", "leftFoot", [0, -0.04, 0.1]],
    ["rightUpperLeg", "hips", [-0.09, -0.05, 0]],
    ["rightLowerLeg", "rightUpperLeg", [0, -0.38, 0]],
    ["rightFoot", "rightLowerLeg", [0, -0.38, 0]],
    ["rightToes", "rightFoot", [0, -0.04, 0.1]],
];

const EXPRESSIONS = [
    "neutral", "happy", "angry", "sad", "relaxed", "surprised",
    "aa", "ih", "ou", "ee", "oh",
    "blink", "blinkLeft", "blinkRight",
    "lookUp", "lookDown", "lookLeft", "lookRight",
];
const VISEMES = ["aa", "ih", "ou", "ee", "oh"];

// Mouth frame switching with hysteresis, so the faint resting-mouth values
// the idle engine writes never flap it and a word holds it open between
// syllable peaks.
const MOUTH_OPEN_AT = 0.18;
const MOUTH_CLOSE_AT = 0.1;
const EYES_CLOSED_AT = 0.5;

// How much of the skeleton's motion the card follows. A card can't turn
// in depth, so the body's roll and travel come through damped.
const ROLL_FOLLOW = 0.6;
const ROLL_LIMIT = 0.35;        // rad
const NOD_SQUASH = 0.12;        // scale-y per rad of head pitch
const SPEECH_BOUNCE = 0.012;    // card heights per unit of mouth opening
const SURPRISE_HOP = 0.02;      // card heights at full surprise
const SMOOTH_RATE = 18;         // 1/s, the bounce's exponential smoothing

const ROLL_BONES = ["hips", "spine", "chest", "upperChest", "neck", "head"];

/** True when this look URL is an image (a PNG look) rather than a VRM. */
export function isPngLook(url) {
    return typeof url === "string" && PNG_LOOK_RE.test(url.split("#")[0].split("?")[0]);
}

/** {base, mouth_open?, eyes_closed?, mouth_open_eyes_closed?} from a look URL. */
export function pngLookFrames(url) {
    const [base, fragment = ""] = url.split("#");
    const params = new URLSearchParams(fragment);
    const frames = { base };
    for (const key of PNG_FRAMES) {
        const ref = params.get(key);
        if (ref) frames[key] = ref;
    }
    return frames;
}

/** The figure's top and bottom in the image as fractions of its height
 *  (0 = top edge), from its opaque pixels; null without alpha or a canvas.
 *  Generated images leave margin above the head and below the feet, which
 *  would otherwise count as figure. */
function figureBounds(image) {
    try {
        const w = 128;
        const h = Math.max(1, Math.round(w * image.height / image.width));
        const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let top = -1, bottom = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] > 16) {
                    if (top < 0) top = y;
                    bottom = y;
                    break;
                }
            }
        }
        if (top < 0 || (top === 0 && bottom === h - 1)) return null;   // nothing, or no transparency
        return { top: top / h, bottom: (bottom + 1) / h };
    } catch (e) {
        return null;
    }
}

const _loader = new THREE.TextureLoader();

async function loadTexture(url) {
    const tex = await _loader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** The VRM a PNG look loads as. */
class PngPuppet extends VRM {
    constructor(params, cards, camera) {
        super(params);
        this.isPngLook = true;
        this.cards = cards;              // {base, mouth_open, ...} → Mesh
        this.card = cards.base.parent;   // the group the camera-facing turn is applied to
        this.camera = camera;
        this._mouthOpen = false;
        this._bounce = 0;
        this._shown = cards.base;
        this._euler = new THREE.Euler();
        this._q = new THREE.Quaternion();
        this._qParent = new THREE.Quaternion();
        this._v = new THREE.Vector3();
        this._cam = new THREE.Vector3();
        this._restHips = this.humanoid.getNormalizedBoneNode("hips").position.clone();
        this._restHeadY = this.humanoid.getNormalizedBoneNode("head").position.y;
    }

    update(delta) {
        super.update(delta);
        try {
            this._apply2D(delta);
        } catch (e) { /* a frame of the card never takes the loop down */ }
    }

    _value(name) {
        return this.expressionManager.getValue(name) || 0;
    }

    _apply2D(delta) {
        // Frame: eyes from blink, mouth from the visemes.
        const blink = Math.max(this._value("blink"),
            (this._value("blinkLeft") + this._value("blinkRight")) / 2);
        const mouth = Math.max(...VISEMES.map((v) => this._value(v)));
        this._mouthOpen = this._mouthOpen ? mouth > MOUTH_CLOSE_AT : mouth > MOUTH_OPEN_AT;
        const eyesClosed = blink >= EYES_CLOSED_AT;
        const c = this.cards;
        let show = c.base;
        if (this._mouthOpen && eyesClosed) show = c.mouth_open_eyes_closed || c.mouth_open || c.eyes_closed || c.base;
        else if (this._mouthOpen) show = c.mouth_open || c.base;
        else if (eyesClosed) show = c.eyes_closed || c.base;
        if (show !== this._shown) {
            this._shown.visible = false;
            show.visible = true;
            this._shown = show;
        }

        // Pose: roll, nod and travel read off the normalized skeleton.
        const h = this.humanoid;
        let roll = 0;
        for (const name of ROLL_BONES) {
            this._euler.setFromQuaternion(h.getNormalizedBoneNode(name).quaternion, "YXZ");
            roll += this._euler.z;
        }
        roll = Math.max(-ROLL_LIMIT, Math.min(ROLL_LIMIT, roll * ROLL_FOLLOW));
        this._euler.setFromQuaternion(h.getNormalizedBoneNode("head").quaternion, "YXZ");
        const nod = this._euler.x;
        const hips = h.getNormalizedBoneNode("hips").position;
        const headY = h.getNormalizedBoneNode("head").position.y - this._restHeadY;

        const target = mouth * SPEECH_BOUNCE + this._value("surprised") * SURPRISE_HOP;
        this._bounce += (target - this._bounce) * (1 - Math.exp(-SMOOTH_RATE * delta));

        const card = this.card;
        card.position.set(
            hips.x - this._restHips.x,
            (hips.y - this._restHips.y) + headY + this._bounce * CARD_HEIGHT,
            hips.z - this._restHips.z,
        );
        card.scale.set(1, 1 - Math.abs(nod) * NOD_SQUASH, 1);

        // Face the camera (turning about the vertical only), then roll.
        if (this.camera) {
            this.scene.updateMatrixWorld(true);
            card.getWorldPosition(this._v);
            this.camera.getWorldPosition(this._cam);
            const yaw = Math.atan2(this._cam.x - this._v.x, this._cam.z - this._v.z);
            this._q.setFromEuler(this._euler.set(0, yaw, roll, "YXZ"));
            this.scene.getWorldQuaternion(this._qParent).invert();
            card.quaternion.copy(this._qParent.multiply(this._q));
        } else {
            card.rotation.set(0, 0, roll);
        }
    }
}

/**
 * Build the gltf-shaped object the VRM loaders return ({scene, userData:
 * {vrm}, animations}) for a PNG look, so the base avatar, peers and combo
 * partners take it through their usual path.
 */
export async function loadPngLook(url, camera) {
    const frames = pngLookFrames(url);
    const base = await loadTexture(frames.base);
    const extra = await Promise.all(PNG_FRAMES.map((key) => (frames[key]
        ? loadTexture(frames[key]).catch((e) => {
            console.warn(`[voice] PNG look frame ${key} failed to load`, frames[key], e);
            return null;
        })
        : null)));

    // The card is the figure, not the image: cropped to its top and bottom
    // (the empty margin above the head and below the feet cut off), then
    // CARD_HEIGHT tall with its feet on the floor. The camera frames the
    // face shot up to the model's top edge, which is then the top of the
    // hair, as on a VRM, instead of the image's empty margin above it.
    const aspect = (base.image?.width || 1) / (base.image?.height || 1);
    const fig = (base.image && figureBounds(base.image)) || { top: 0, bottom: 1 };
    const span = Math.max(0.2, fig.bottom - fig.top);
    const geometry = new THREE.PlaneGeometry(CARD_HEIGHT * aspect / span, CARD_HEIGHT);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
        uv.setY(i, (1 - fig.bottom) + uv.getY(i) * span);   // v runs bottom (0) to top (1)
    }
    uv.needsUpdate = true;
    geometry.translate(0, CARD_HEIGHT / 2, 0);   // feet on the floor
    const scene = new THREE.Group();
    scene.name = "PngLook";
    const card = new THREE.Group();
    scene.add(card);
    const cards = {};
    const make = (tex, key) => {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            alphaTest: 0.02,
            side: THREE.DoubleSide,
            toneMapped: false,
        }));
        mesh.name = `PngLook_${key}`;
        mesh.visible = key === "base";
        card.add(mesh);
        cards[key] = mesh;
    };
    make(base, "base");
    PNG_FRAMES.forEach((key, i) => { if (extra[i]) make(extra[i], key); });

    // Skeleton: plain nodes, nothing skinned to them.
    const nodes = {};
    for (const [name, parent, pos] of BONES) {
        const node = new THREE.Object3D();
        node.name = `PngLook_${name}`;
        node.position.fromArray(pos);
        (parent ? nodes[parent] : scene).add(node);
        nodes[name] = node;
    }
    const humanoid = new VRMHumanoid(
        Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, { node }])),
    );
    scene.add(humanoid.normalizedHumanBonesRoot);

    const expressionManager = new VRMExpressionManager();
    for (const name of EXPRESSIONS) {
        const exp = new VRMExpression(name);
        scene.add(exp);
        expressionManager.registerExpression(exp);
    }

    const vrm = new PngPuppet({
        scene,
        humanoid,
        expressionManager,
        meta: { metaVersion: "1", name: frames.base.split("/").pop() },
    }, cards, camera);
    scene.updateMatrixWorld(true);
    return { scene, userData: { vrm }, animations: [] };
}
