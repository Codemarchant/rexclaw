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
export const confirmState = reactive({
    open: false, message: "", resolve: null,
    // Optional extra choice rendered as a tickbox in the dialog. When a
    // label is given, confirmAsk resolves {ok, checked} instead of a bool.
    checkboxLabel: null, checked: false,
});

export function confirmAsk(message, { checkboxLabel = null } = {}) {
    // A second ask while one is open (shouldn't happen — the backdrop blocks
    // the UI) settles the first as cancelled rather than stranding it.
    if (confirmState.resolve) confirmState.resolve(false);
    return new Promise((resolve) => {
        confirmState.message = message;
        confirmState.checkboxLabel = checkboxLabel;
        confirmState.checked = false;
        confirmState.resolve = resolve;
        confirmState.open = true;
    });
}

export function confirmAnswer(ok) {
    const { resolve, checkboxLabel, checked } = confirmState;
    const result = checkboxLabel != null ? { ok, checked } : ok;
    confirmState.open = false;
    confirmState.message = "";
    confirmState.checkboxLabel = null;
    confirmState.checked = false;
    confirmState.resolve = null;
    resolve?.(result);
}
