import React, { useEffect } from "react";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { confirmState, confirmAnswer } from "../lib/confirm";

/** App-root confirm dialog backing lib/confirm.js's confirmAsk(). Same
 *  markup as UnsavedDialog; Escape cancels, backdrop click cancels. */
export default function ConfirmDialog() {
    const state = useReactive(confirmState);
    useEffect(() => {
        if (!state.open) return;
        const onKey = (ev) => {
            if (ev.key === "Escape") { ev.preventDefault(); confirmAnswer(false); }
            if (ev.key === "Enter") { ev.preventDefault(); confirmAnswer(true); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [state.open]);
    if (!state.open) return null;
    return (
        <div className="rx_dialog_backdrop" onMouseDown={() => confirmAnswer(false)}>
            <div className="rx_dialog" role="dialog" aria-modal="true"
                 onMouseDown={(e) => e.stopPropagation()}>
                <h4>{_t("Are you sure?")}</h4>
                <p>{state.message}</p>
                <div className="rx_dialog_actions">
                    <button type="button" className="btn btn-light btn-sm"
                            onClick={() => confirmAnswer(false)}>
                        {_t("Cancel")}
                    </button>
                    <button type="button" autoFocus className="btn btn-outline-danger btn-sm"
                            onClick={() => confirmAnswer(true)}>
                        <i className="fa fa-check" /> {_t("Confirm")}
                    </button>
                </div>
            </div>
        </div>
    );
}
