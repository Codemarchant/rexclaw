import { reactive } from "./reactive";

/** In-app replacement for window.confirm.
 *
 *  Native blocking dialogs (confirm/alert) break renderer keyboard focus in
 *  Electron: after dismissing one, inputs stop accepting keys until the
 *  window is blurred and refocused (minimize/restore). Same reason the
 *  avatar-duplicate flow avoids window.prompt. Every destructive-action
 *  confirmation goes through confirmAsk instead, rendered by
 *  components/ConfirmDialog.jsx at the app root:
 *
 *      if (!(await confirmAsk(_t("Delete X?")))) return;
 */
export const confirmState = reactive({ open: false, message: "", resolve: null });

export function confirmAsk(message) {
    // A second ask while one is open (shouldn't happen — the backdrop blocks
    // the UI) settles the first as cancelled rather than stranding it.
    if (confirmState.resolve) confirmState.resolve(false);
    return new Promise((resolve) => {
        confirmState.message = message;
        confirmState.resolve = resolve;
        confirmState.open = true;
    });
}

export function confirmAnswer(ok) {
    const resolve = confirmState.resolve;
    confirmState.open = false;
    confirmState.message = "";
    confirmState.resolve = null;
    resolve?.(ok);
}
