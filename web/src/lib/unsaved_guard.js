// Odoo-style unsaved-changes guard.
//
// Views in this app stay mounted and toggle with `display:none`, so an
// unsaved edit isn't lost by unmounting — it's lost when the view re-fetches
// on re-activation. To match Odoo's form behaviour we (1) let the active view
// publish its dirty state + save/discard handlers here, and (2) have the tab
// bar and window-close intercept navigation while dirty and prompt
// Save / Discard / Cancel.
//
// Only ONE view is active at a time, and the guard forbids leaving a dirty
// view without resolving it — so a hidden view is always clean and a single
// shared slot is enough.
import { useEffect, useRef } from "react";
import { reactive } from "./reactive";

// Reactive so the tab bar / App can react to dirtiness (e.g. a nav intercept).
export const unsavedGuard = reactive({ dirty: false });

// Non-reactive handler slot for the currently-dirty view.
let _handlers = { save: null, discard: null };

export function getUnsavedHandlers() {
    return _handlers;
}

export function publishUnsaved(handlers) {
    _handlers = handlers || { save: null, discard: null };
    unsavedGuard.dirty = true;
}

export function clearUnsaved() {
    _handlers = { save: null, discard: null };
    unsavedGuard.dirty = false;
}

/**
 * Publish this view's unsaved state to the shared guard while it is the
 * active tab. `save` must resolve truthy on success / falsy on failure (so a
 * failed save cancels the pending navigation); `discard` reverts the draft.
 *
 * @param {boolean} active  is this the visible tab
 * @param {boolean} isDirty does the view hold unsaved edits
 * @param {() => (boolean|Promise<boolean>)} save
 * @param {() => (void|Promise<void>)} discard
 */
export function useUnsavedGuard(active, isDirty, save, discard) {
    // Latest handlers via a ref so their changing identity each render never
    // re-runs the effect (which would thrash the shared slot).
    const ref = useRef({ save, discard });
    ref.current = { save, discard };

    useEffect(() => {
        if (!active || !isDirty) return undefined;
        publishUnsaved({
            save: () => ref.current.save?.(),
            discard: () => ref.current.discard?.(),
        });
        return () => clearUnsaved();
    }, [active, isDirty]);
}
