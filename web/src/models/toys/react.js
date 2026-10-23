// What the companion does when something happens to a toy (models/toys/
// world.js events): which routine (models/toys/brains.js `why`), and
// whether it cuts in on what they're doing. Shared by both stages' hosts —
// the roam director on the desktop, ToyCompanion in the 3D view.

const QUIET = new Set(["bubble", "coin"]);

/** The reaction to world event `evt`, or null: {toy, why, part, urgent}. */
export function reactionFor(evt) {
    const t = evt.toy;
    switch (evt.type) {
        // Coming at them: catch it now.
        case "incoming": return { toy: t, why: "thrown", urgent: true };
        case "hit": return { toy: t, why: "hit", part: evt.part, urgent: true };
        case "offer": return { toy: t, why: "offer", urgent: true };
        case "blowdry": return { toy: t, why: "on", urgent: true };
        // Put down or thrown somewhere: they go for it once it's still.
        case "drop":
        case "throw":
        case "toss":
            if (!t.def.gadget && !QUIET.has(t.def.kind)) t._fresh = true;
            return null;
        case "rest":
            if (!t._fresh) return null;
            t._fresh = false;
            return { toy: t, why: "dropped" };
        case "switch":
            if (t.on && ["fan", "disco", "fogger", "lamp"].includes(t.def.kind)) return { toy: t, why: "on" };
            return null;
        case "open": return { toy: t, why: "dropped" };
        case "score":
        case "goal": return evt.by === "user" ? { toy: t, why: "cheer" } : null;
        default: return null;
    }
}
