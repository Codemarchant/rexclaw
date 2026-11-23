// Copyright 2026 Codemarchant
/** Where the people are in a drawn manga panel, so the lettering can keep
 *  off them and point at the right face (manga_shoot.js artShot,
 *  manga_page.js). A drawn panel is one flat picture: nothing says where
 *  its characters ended up, and the image generator does not always put
 *  them where it was asked to.
 *
 *  Two MediaPipe models, run locally on the picture (no service, no cost):
 *    - the multiclass selfie segmenter, for which pixels are a person
 *      (hair, skin, clothes; class 0 is background);
 *    - the BlazeFace short-range detector, for the faces.
 *  Both are trained on photos of people. Tried on 160 of the app's own
 *  drawn panels (2026-11-23) the segmenter covered the characters in every
 *  one of the 12 looked at, and the detector found the faces in 11; the
 *  face landmarker camera awareness uses found them in 4, so it is not
 *  used here. Both models are Apache-2.0 (Google's model cards).
 *
 *  Everything here is best effort: a model that can't load, or a picture
 *  it finds no one in, gives null or empty results, and the callers keep
 *  what they did before (assumed face positions, the busy-area map). */
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

// Keep the remote URLs in sync with scripts/fetch_vision_model.py.
const MODELS = {
    person: {
        local: "/assets/vision_models/selfie_multiclass_256x256.tflite",
        remote: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
    },
    face: {
        local: "/assets/vision_models/blaze_face_short_range.tflite",
        remote: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    },
};
const MODEL_CACHE = "rexclaw-vision-models";   // shared with camera_awareness.js

/** Model bytes: the copy bundled with the app, else Google's bucket (kept
 *  in the Cache API) — the same order as camera_awareness.js. */
async function modelBytes({ local, remote }) {
    try {
        const resp = await fetch(local);
        // A missing file may come back as the app's index.html.
        const type = resp.headers.get("content-type") || "";
        if (resp.ok && !type.includes("text/html")) return new Uint8Array(await resp.arrayBuffer());
    } catch (e) { /* not bundled — fall through */ }
    let cache = null;
    try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* no Cache API */ }
    let resp = cache ? await cache.match(remote) : null;
    if (!resp) {
        resp = await fetch(remote);
        if (!resp.ok) throw new Error(`Model download failed (${resp.status}).`);
        if (cache) { try { await cache.put(remote, resp.clone()); } catch (e) { /* quota */ } }
    }
    return new Uint8Array(await resp.arrayBuffer());
}

let loading = null;

/** Both models, loaded once. They run on the CPU: one picture at a time
 *  needs no more, and the GPU context stays the avatar renderer's. */
function models() {
    if (!loading) {
        loading = (async () => {
            const mp = await import("@mediapipe/tasks-vision");
            const fileset = { wasmLoaderPath, wasmBinaryPath };
            const [personBytes, faceBytes] = await Promise.all([modelBytes(MODELS.person), modelBytes(MODELS.face)]);
            const person = await mp.ImageSegmenter.createFromOptions(fileset, {
                baseOptions: { modelAssetBuffer: personBytes, delegate: "CPU" },
                runningMode: "IMAGE", outputCategoryMask: true, outputConfidenceMasks: false,
            });
            const face = await mp.FaceDetector.createFromOptions(fileset, {
                baseOptions: { modelAssetBuffer: faceBytes, delegate: "CPU" },
                runningMode: "IMAGE",
            });
            return { person, face };
        })().catch((e) => {
            console.warn("[manga] people detection unavailable", e);
            loading = null;   // a later page may try again (e.g. back online)
            return null;
        });
    }
    return loading;
}

/** Look at one drawn panel (a canvas). Returns null when the models can't
 *  run, else:
 *    faces   [{ x, y, r }], largest first — centre and radius, x as a
 *            fraction of the width, y and r of the height (the units of a
 *            photoshoot's face);
 *    person  (u, v) => whether that point (fractions of width and height)
 *            is on a person, or null when no one was found. */
export async function seePanel(picture) {
    const loaded = await models();
    if (!loaded) return null;
    try {
        const faces = (loaded.face.detect(picture).detections || [])
            .map((d) => d.boundingBox)
            .filter(Boolean)
            .map((b) => ({
                x: (b.originX + b.width / 2) / picture.width,
                y: (b.originY + b.height / 2) / picture.height,
                r: Math.max(b.width, b.height) / 2 / picture.height,
            }))
            .sort((a, b) => b.r - a.r);

        let person = null;
        const result = loaded.person.segment(picture);
        const mask = result.categoryMask;
        if (mask) {
            // Copied out: the mask's memory is the model's, freed on close.
            const cells = Uint8Array.from(mask.getAsUint8Array());
            const { width, height } = mask;
            if (cells.some((c) => c > 0)) {
                person = (u, v) => {
                    if (u < 0 || v < 0 || u >= 1 || v >= 1) return false;
                    return cells[Math.floor(v * height) * width + Math.floor(u * width)] > 0;
                };
            }
        }
        result.close?.();
        return { faces, person };
    } catch (e) {
        console.warn("[manga] people detection failed on a panel", e);
        return null;
    }
}
