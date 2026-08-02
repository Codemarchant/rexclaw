// Attachment helpers shared by the voice input rows (VoiceView and the
// /#transcript mirror window).

/** Downscale a user-picked image file to a data URL (long edge ≤ maxSize).
 *  createImageBitmap honours EXIF orientation, so phone photos come out
 *  upright. PNG keeps transparency; everything else re-encodes as JPEG. */
export async function downscaleImageFile(file, maxSize = 2048) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return file.type === "image/png"
        ? canvas.toDataURL("image/png")
        : canvas.toDataURL("image/jpeg", 0.9);
}

/** Hidden context note describing a batch of uploaded attachments. The voice
 *  model can't see images or read files — the note tells it what arrived and
 *  which tools (delegate_task / create_video / create_image) can use them.
 *  Model-facing: stays English regardless of UI language. */
export function attachmentNote(images, docs) {
    const parts = [];
    if (images.length) {
        const listing = images
            .map((p) => `"${p.name}" (image_url=${p.image_url}, imagine_image_id=${p.imagine_image_id})`)
            .join("; ");
        parts.push(
            `The user attached ${images.length} image(s): ${listing}. `
            + `You cannot see them (voice is audio-only), but you can use `
            + `them — call delegate_task with an imagine_image_id in files `
            + `to have their content described/analyzed, or pass an `
            + `image_url to create_video as source_image (animate that `
            + `exact image) or reference_images (feature its people/objects `
            + `in a new clip, up to 3).`
        );
    }
    if (docs.length) {
        const listing = docs
            .map((p) => `"${p.name}" (xai_file_id=${p.xai_file_id}`
                + (p.imagine_image_id
                    ? `, imagine_image_id=${p.imagine_image_id}` : "")
                + `)`)
            .join("; ");
        parts.push(
            `The user attached ${docs.length} file(s): ${listing}. You `
            + `cannot read them yourself — call delegate_task with the `
            + `imagine_image_id value(s) (preferred — they stay valid `
            + `forever) or xai_file_id value(s) in files to read/analyze `
            + `their content.`
        );
        if (docs.some((p) => (p.mimetype || "").startsWith("video/"))) {
            parts.push(
                `Attached videos can also be modified: pass the `
                + `imagine_image_id as create_video edit_video to change `
                + `one or extend_video to continue it (never a file_… `
                + `id there).`
            );
        }
    }
    return `[System] ${parts.join(" ")}`;
}
