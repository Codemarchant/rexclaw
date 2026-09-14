import React, { useEffect } from "react";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { affectionOfferState, answerAffectionOffer } from "../lib/affection_offer";

/** App-root dialog backing lib/affection_offer.js's offerAffection(). One
 *  tickbox and one button: the choice is the tick, Continue always goes on
 *  to the call. Escape and backdrop click count as "leave it off" (the
 *  question is spent either way, so dismissing never means "ask again"). */
export default function AffectionOfferDialog() {
    const state = useReactive(affectionOfferState);
    useEffect(() => {
        if (!state.open) return;
        const onKey = (ev) => {
            if (ev.key === "Escape") { ev.preventDefault(); answerAffectionOffer(false); }
            if (ev.key === "Enter") { ev.preventDefault(); answerAffectionOffer(affectionOfferState.checked); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [state.open]);
    if (!state.open) return null;
    const name = state.agent?.name || _t("this companion");
    return (
        <div className="rx_dialog_backdrop" onMouseDown={() => answerAffectionOffer(false)}>
            <div className="rx_dialog" role="dialog" aria-modal="true"
                 onMouseDown={(e) => e.stopPropagation()}>
                <h4>{_t("Affection meter")}</h4>
                <p>
                    {_t("%s can keep an affection score that carries across calls. They start a little reserved and warm up as you get to know them, and how you treat them matters.", name)}
                </p>
                <p className="small text-muted">
                    {_t("It adds their affection rules to every prompt plus an occasional silent tool call, so it uses a few more tokens. You can change this any time in the companion's settings.")}
                </p>
                <label className="small"
                       style={{ display: "flex", gap: "0.4rem", alignItems: "center",
                                margin: "0 0 0.75rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={state.checked} disabled={state.saving}
                           onChange={(ev) => { affectionOfferState.checked = ev.target.checked; }} />
                    {_t("Turn on the affection meter for %s", name)}
                </label>
                <div className="rx_dialog_actions">
                    <button type="button" autoFocus className="btn btn-primary btn-sm"
                            disabled={state.saving}
                            onClick={() => answerAffectionOffer(affectionOfferState.checked)}>
                        {_t("Continue")}
                    </button>
                </div>
            </div>
        </div>
    );
}
