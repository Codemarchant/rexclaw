/**
 * Manga Diary photoshoot: poses the live avatar for each storyboard panel
 * and photographs it (renderer: beginPhotoShoot / framePhoto /
 * capturePhoto). Per panel: size the viewfinder to the panel's photo, set
 * the face, frame the shot, play the pose clip from just before its key
 * frame and take the photo as it passes — on an open-eyed frame.
 *
 * The optional Imagine art (server/manga.py paint_panel) joins here too:
 * a painted scene replaces the photo's backdrop, a painted panel replaces
 * the photo altogether (artShot).
 */
import { avatarRenderer } from "../services/avatar_renderer";
import { EMOTION_GESTURE_MAP, GESTURE_FILE_MAP } from "../models/avatar_catalog";

// Where each clip's pose reads best, as a fraction of the clip — design
// values picked by eye. The emotion clips (Blush, Sad, …) stand in when a
// panel has a feeling but no pose.
const KEY_POSE = {
    greeting: 0.4, goodbye: 0.45, peace_sign: 0.5, thinking: 0.55, clapping: 0.35,
    blow_kiss: 0.5, jump: 0.42, model_pose: 0.6, shoot: 0.5, look_around: 0.3,
    sleepy: 0.55, show_full_body: 0.5, spin: 0.25,
};
const EMOTION_KEY_POSE = 0.5;
const LEAD_IN_S = 0.35;        // start this far before the key frame: covers the clip's 0.25 s fade-in
const FACE_SETTLE_MS = 700;    // longest emotion cross-fade (neutral, 0.6 s) and a frame
const BLINK_OPEN = 0.15;       // blink weight under which the eyes count as open
const BLINK_WAIT_FRAMES = 20;
const POSE_TIMEOUT_MS = 4000;
const OUTFIT_SETTLE_MS = 600;  // after a model swap, the idle leaves the bind pose (as the portrait shots wait)

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true once the renderer shows `avatarId` with its model loaded. */
export async function waitForAvatar(avatarId, timeoutMs = 30000) {
    const until = performance.now() + timeoutMs;
    while (performance.now() < until) {
        const r = avatarRenderer;
        if (r.vrm && !r._loadingVrmPromise && Number(r._currentAvatarPayload?.id) === Number(avatarId)) {
            return true;
        }
        await sleep(150);
    }
    return false;
}

export function beginShoot(host) {
    avatarRenderer.mount(host);
    return avatarRenderer.beginPhotoShoot();
}

export function endShoot(host) {
    avatarRenderer.stopGesture();
    avatarRenderer.setEmotion("neutral", { explicit: false, settle: true });
    avatarRenderer.endPhotoShoot();
    avatarRenderer.unmount(host);
}

export function currentVrmUrl() {
    return avatarRenderer._loadedVrmUrl || null;
}

/** Dress the companion in the wardrobe entry named `name` (an unknown name
 *  keeps what they have on). A model swap re-frames the camera and loads
 *  the idle again, so the photoshoot hold is re-taken and the idle given a
 *  moment to leave the bind pose. True when an outfit was changed. */
export async function wearOutfit(avatar, name) {
    const want = (avatar?.outfits || []).find(
        (o) => o.name.toLowerCase() === String(name || "").toLowerCase());
    if (!want?.vrm_url || want.vrm_url === currentVrmUrl()) return false;
    await avatarRenderer.setOutfit(want.vrm_url, avatar.vrma_idle_url || null);
    avatarRenderer.beginPhotoShoot();
    await sleep(OUTFIT_SETTLE_MS);
    return true;
}

/** Back into what they wore before the shoot. */
export async function restoreOutfit(avatar, url) {
    if (url && url !== currentVrmUrl()) {
        await avatarRenderer.setOutfit(url, avatar?.vrma_idle_url || null).catch(() => {});
    }
}

// The renderer never re-admits a removed peer id (see removePeer), so each
// entrance gets a fresh one.
let peerSeq = 0;

/** `avatar` in the wardrobe entry named `outfit`; unchanged for '' or a
 *  name the wardrobe doesn't have. */
function dressed(avatar, outfit) {
    const want = outfit && (avatar?.outfits || []).find((o) => o.name.toLowerCase() === outfit.toLowerCase());
    return want ? { ...avatar, vrm_url: want.vrm_url } : avatar;
}

/** Who stands beside the companion in a panel, left to right the way the
 *  group-call layout lines them up: the cast members it names, then the
 *  user's avatar (Settings → "Your avatar"), each in this panel's outfit
 *  for them. Each is {key, sig, avatar}; key is a cast name or "user", sig
 *  also tells outfits apart. */
export function panelLineup(spec, cast, userAvatar) {
    const out = [];
    const add = (key, avatar) => out.push({ key, avatar, sig: `${key}@${avatar.vrm_url}` });
    for (const w of spec.with || []) {
        const member = cast.find((c) => c.name === w.name);
        if (member?.avatar) add(w.name, dressed(member.avatar, w.outfit));
    }
    if (spec.with_user && userAvatar) add("user", dressed(userAvatar, spec.user_outfit));
    return out;
}

export const lineupSig = (line) => line.map((c) => c.sig).join("|");

/** Stand `wanted` beside the companion, given who stands there now
 *  (`current`, [{key, sig, id}]). The layout goes by order of entrance,
 *  so any change — a person or an outfit — re-enters the whole line. A
 *  model swap re-frames the camera, so the photoshoot hold is re-taken.
 *  Resolves with the new [{key, sig, id}]. */
export async function setLineup(current, wanted) {
    if (lineupSig(current) === lineupSig(wanted)) return current;
    clearLineup(current);
    const next = [];
    for (const w of wanted) {
        const id = `manga-peer-${++peerSeq}`;
        await avatarRenderer.setPeerAvatar(id, w.avatar);
        next.push({ key: w.key, sig: w.sig, id });
    }
    avatarRenderer.beginPhotoShoot();
    await sleep(OUTFIT_SETTLE_MS);
    return next;
}

export function clearLineup(current) {
    for (const c of current || []) avatarRenderer.removePeer(c.id);
}

/** Size the viewfinder host so the drawing buffer is the panel's photo size. */
export function sizeHost(host, panel) {
    const dpr = window.devicePixelRatio || 1;
    host.style.width = `${panel.shotW / dpr}px`;
    host.style.height = `${panel.shotH / dpr}px`;
}

function blinkWeight() {
    try {
        return avatarRenderer.vrm?.expressionManager?.getValue?.("blink") || 0;
    } catch (e) {
        return 0;
    }
}

/** A painted image, cover-fitted onto a canvas of the panel's photo size. */
export async function loadArt(url, panel) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = panel.shotW;
    c.height = panel.shotH;
    const s = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    c.getContext("2d").drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    return c;
}

// Where an illustrated panel's face is expected: the side paint_panel asks
// for (even panels right, odd left), at the height and size each shot puts
// it — design values, so the balloons keep clear of it.
const ART_FACE = {
    closeup: { y: 0.45, r: 0.2 }, bust: { y: 0.38, r: 0.12 }, waist: { y: 0.3, r: 0.08 },
    full: { y: 0.2, r: 0.05 }, wide: { y: 0.35, r: 0.035 },
};

/** A whole Imagine-drawn panel in the photo's place. Opaque, so it is
 *  inked like a photo taken in a 3D room (`room`). A group shot was asked
 *  for left to right, companion first (paint_panel): `keys` are the others
 *  drawn, in that order, and the faces are spread evenly across. */
export function artShot(art, panel, spec, keys = []) {
    const f = ART_FACE[spec.shot] || ART_FACE.bust;
    if (keys.length) {
        const n = keys.length + 1;
        const at = (k) => ({ x: (k + 0.5) / n, y: f.y, r: f.r });
        return { figure: art, backdrop: null, room: true, face: at(0),
                 others: Object.fromEntries(keys.map((key, k) => [key, at(k + 1)])) };
    }
    return { figure: art, backdrop: null, room: true,
             face: { x: panel.index % 2 ? 0.36 : 0.64, y: f.y, r: f.r } };
}

/** Pose and photograph one panel. `host` must already be sized for it.
 *  `lineup` is who stands beside the companion ([{key, id}], from
 *  setLineup); the shot's `others` maps each key to where its face landed. */
export async function shootPanel(panel, spec, lineup = []) {
    await frame();
    await frame();
    avatarRenderer.stopGesture();
    avatarRenderer.setEmotion(spec.emotion, { explicit: false, settle: true });
    for (const c of lineup) {
        const emotion = c.key === "user" ? spec.user_emotion
            : (spec.with || []).find((w) => w.name === c.key)?.emotion;
        avatarRenderer.setPeerEmotion(c.id, emotion || "neutral");
    }
    avatarRenderer.framePhoto(spec.shot, spec.angle);
    await sleep(FACE_SETTLE_MS);

    // The emotion clips move the whole body (relaxed is a full stretch that
    // tips the head sideways), so they only stand in where the body is in
    // frame; a close-up or bust keeps the idle stance and lets the face act.
    const bodyInFrame = spec.shot === "waist" || spec.shot === "full" || spec.shot === "wide";
    const url = spec.pose !== "none" ? GESTURE_FILE_MAP[spec.pose]
        : bodyInFrame ? EMOTION_GESTURE_MAP[spec.emotion] : null;
    const action = url ? await avatarRenderer.playGesture(url) : null;
    if (action) {
        const key = action.getClip().duration * (KEY_POSE[spec.pose] ?? EMOTION_KEY_POSE);
        action.time = Math.max(0, key - LEAD_IN_S);
        const until = performance.now() + POSE_TIMEOUT_MS;
        while (action.isRunning() && action.time < key && performance.now() < until) await frame();
    } else {
        await frame();
    }
    for (let i = 0; i < BLINK_WAIT_FRAMES && blinkWeight() > BLINK_OPEN; i++) await frame();
    // Re-frame at the moment of capture: a close-up follows the head
    // wherever the pose has taken it.
    avatarRenderer.framePhoto(spec.shot, spec.angle);
    const shot = await avatarRenderer.capturePhoto({
        maxSize: Math.max(panel.shotW, panel.shotH), peerIds: lineup.map((c) => c.id),
    });
    if (shot) shot.others = Object.fromEntries(lineup.map((c) => [c.key, shot.peerFaces[c.id]]));
    return shot;
}
