import { reactive } from "./reactive";
import { rpc } from "./rpc";

/** The one-time "turn on the affection meter?" offer.
 *
 *  Put up by the Voice and Chat views before the first call or chat with a
 *  companion whose `affection_offer` flag is set (rules filled in, meter
 *  off, never asked, no conversation yet). It sits BETWEEN the click and
 *  the session opening:
 *  a realtime call bills by connection time, and a modal over a live call
 *  would also step on the companion's opening line.
 *
 *  Rendered by components/AffectionOfferDialog.jsx at the app root, the
 *  same way lib/confirm.js is. Whatever the answer, and however the dialog
 *  is dismissed, the server marks the question spent for that companion,
 *  so it never nags: the setting stays in the companion editor for later.
 *
 *      await offerAffection(agent);   // resolves once the answer is saved
 */
export const affectionOfferState = reactive({
    open: false, agent: null, checked: false, saving: false, resolve: null,
});

export function offerAffection(agent) {
    if (!agent?.affection_offer) return Promise.resolve(false);
    if (affectionOfferState.resolve) affectionOfferState.resolve(false);
    return new Promise((resolve) => {
        affectionOfferState.agent = agent;
        affectionOfferState.checked = false;
        affectionOfferState.saving = false;
        affectionOfferState.resolve = resolve;
        affectionOfferState.open = true;
    });
}

/** Close the dialog and record the answer. Resolves the offer promise with
 *  whether the meter was turned on. A failed save still closes the dialog
 *  and lets the call go ahead: the offer simply comes back next time. */
export async function answerAffectionOffer(enable) {
    const { agent, resolve, saving } = affectionOfferState;
    if (saving) return;
    affectionOfferState.saving = true;
    let enabled = false;
    try {
        const res = await rpc("/api/agents/affection_offer", { id: agent?.id, enable: !!enable });
        enabled = !!res?.enabled;
    } catch (e) {
        console.error("[affection] could not save the offer answer", e);
    }
    affectionOfferState.open = false;
    affectionOfferState.agent = null;
    affectionOfferState.checked = false;
    affectionOfferState.saving = false;
    affectionOfferState.resolve = null;
    resolve?.(enabled);
}
