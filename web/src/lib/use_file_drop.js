import { useEffect, useRef, useState } from "react";

/** Make targetRef's element a file drop zone. Dropped files are handed to
 *  onFiles exactly like a picker selection — queued, never auto-sent. While
 *  files hover the element it gets an `is-dragover` class (give the element
 *  the `rx_dropzone` class + a `data-drop-hint` attribute; base.scss draws
 *  the overlay). Re-binds when `enabled` flips, so pass every condition
 *  that also mounts/unmounts the target element. */
export function useFileDrop(targetRef, onFiles, enabled = true) {
    const [dragging, setDragging] = useState(false);
    const onFilesRef = useRef(onFiles);
    onFilesRef.current = onFiles;

    useEffect(() => {
        const el = targetRef.current;
        if (!el || !enabled) return;
        // dragenter/leave fire for every child boundary — depth-count so the
        // overlay doesn't flicker while moving across the container.
        let depth = 0;
        const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
        const setOver = (on) => {
            setDragging(on);
            el.classList.toggle("is-dragover", on);
        };
        const onDragEnter = (ev) => {
            if (!hasFiles(ev)) return;
            ev.preventDefault();
            depth += 1;
            setOver(true);
        };
        const onDragOver = (ev) => {
            if (!hasFiles(ev)) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
        };
        const onDragLeave = (ev) => {
            if (!hasFiles(ev)) return;
            depth = Math.max(0, depth - 1);
            if (!depth) setOver(false);
        };
        const onDrop = (ev) => {
            if (!hasFiles(ev)) return;
            ev.preventDefault();
            depth = 0;
            setOver(false);
            const files = [...(ev.dataTransfer.files || [])];
            if (files.length) onFilesRef.current(files);
        };
        el.addEventListener("dragenter", onDragEnter);
        el.addEventListener("dragover", onDragOver);
        el.addEventListener("dragleave", onDragLeave);
        el.addEventListener("drop", onDrop);
        return () => {
            el.removeEventListener("dragenter", onDragEnter);
            el.removeEventListener("dragover", onDragOver);
            el.removeEventListener("dragleave", onDragLeave);
            el.removeEventListener("drop", onDrop);
            el.classList.remove("is-dragover");
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    return dragging;
}
