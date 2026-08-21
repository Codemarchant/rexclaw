// Inline list-item editors (heartbeat / MCP-connection / lore-story drafts)
// living inside the companion form. They save independently via their own
// Save buttons, but the surrounding form's Save must ALSO commit them — a
// draft silently dying because the user pressed the main Save instead of
// the row-level one is a data-loss trap. Panels register their open draft
// here ({dirty, flush}); the parent flushes on Save and feeds the combined
// dirtiness into the unsaved-changes guard.
import { useEffect, useRef } from "react";

const _strip = (draft) => {
    const clean = {};
    for (const k of Object.keys(draft)) {
        if (!k.startsWith("_")) clean[k] = draft[k];
    }
    return clean;
};

/** Stamp an opening draft with a snapshot of its content, so editorDirty()
 *  can tell real edits from a just-opened (or reverted) form. Meta keys
 *  (leading underscore) stay out of the snapshot and comparison. */
export function withEditorSnapshot(draft) {
    return { ...draft, _snap: JSON.stringify(_strip(draft)) };
}

/** Has this draft actually been edited since it was opened? */
export function editorDirty(editing) {
    return !!editing && JSON.stringify(_strip(editing)) !== editing._snap;
}

/** Publish this panel's open-draft state to the parent form. `register` is
 *  optional (panels also render outside the companion editor); `flush` is
 *  read through a ref so the registered callback always sees fresh state. */
export function useRegisterChildEditor(register, dirty, flush) {
    const flushRef = useRef(flush);
    flushRef.current = flush;
    useEffect(() => {
        if (!register) return undefined;
        register({ dirty, flush: () => flushRef.current() });
        return () => register(null);
    }, [register, dirty]);
}
