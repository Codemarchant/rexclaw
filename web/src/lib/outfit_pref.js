// The companion's current outfit — server-side state (agents.current_outfit_name,
// via /api/voice/agents/<id>/outfit), so a pick survives reloads, app
// restarts, companion switches and the mascot pop-out (a fresh page
// instance), and so text-mode pictures of the companion use the outfit
// they actually have on. Written by the outfit dropdown, the mascot's
// picker and the change_outfit tool; read wherever an avatar is hydrated
// from scratch. Used to be a localStorage key per avatar — browser-only, so
// the server never knew.
//
// The page's view of the value is the agent entry from /api/voice/agents
// (current_outfit_id, this boot's id for the recorded outfit name). No
// separate cache: outfit ids are reissued whenever a pack is re-scanned (an
// Avatars-tab save, a server restart), and a cached id would outlive them
// while a refetched agent entry can't.
import { rpc } from "./rpc";

/** Record `outfitId` (0 = main outfit) as what `agent` is wearing. `agent`
 *  is the /api/voice/agents entry (mutated in place so callers holding it
 *  see the new value) or a bare agent id. Fire-and-forget on the wire. */
export function storeOutfitPref(agent, outfitId) {
    const agentId = Number(typeof agent === "object" ? agent?.id : agent);
    if (!agentId) return;
    const id = Number(outfitId) || 0;
    if (agent && typeof agent === "object") agent.current_outfit_id = id;
    rpc(`/api/voice/agents/${agentId}/outfit`, { outfit_id: id })
        .catch((e) => console.warn("[outfit] could not persist outfit pick", e));
}

/** The outfit entry `agent` currently has on, or null for the main outfit
 *  (nothing recorded, or the recorded id no longer exists). */
export function storedOutfit(agent) {
    const avatar = agent?.avatar;
    if (!avatar?.id) return null;
    const id = Number(agent.current_outfit_id || 0);
    if (!id) return null;
    return (avatar.outfits || []).find((o) => Number(o.id) === id) || null;
}

/** Re-read the server's value for `agent` (another page instance — the
 *  mascot — or the change_outfit tool may have changed it since the agents
 *  list was fetched) and return the outfit entry as storedOutfit would.
 *  Updates the agent entry in place. */
export async function refreshStoredOutfit(agent) {
    if (!agent?.id) return null;
    try {
        const data = await rpc("/api/voice/agents", {});
        const fresh = (data.agents || []).find((a) => Number(a.id) === Number(agent.id));
        if (fresh) agent.current_outfit_id = Number(fresh.current_outfit_id || 0);
    } catch (e) {
        console.warn("[outfit] could not refresh outfit pick", e);
    }
    return storedOutfit(agent);
}
