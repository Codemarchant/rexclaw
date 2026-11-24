// What the companion does when something happens to a toy (models/toys/
// world.js events): which routine (models/toys/brains.js `why`), and
// whether it cuts in on what they're doing. Shared by both stages' hosts —
// the roam director on the desktop, ToyCompanion in the 3D view.

// (A mount sees to its rider itself: models/toys/mounts.js.)
const QUIET = new Set(["bubble", "coin", "mount"]);

/** The reaction to world event `evt`, or null: {toy, why, part, urgent}. */
export function reactionFor(evt) {
    const t = evt.toy;
    switch (evt.type) {
        // Coming at them: catch it now.
        case "incoming": return { toy: t, why: "thrown", urgent: true };
        case "hit": return { toy: t, why: "hit", part: evt.part, urgent: true };
        case "offer": return { toy: t, why: "offer", urgent: true };
        // A pet held against their chest: into their arms.
        case "handed": return { toy: t, why: "handed", urgent: true };
        // What a pet does of its own accord (pets.js): a bird wanting their
        // arm to sit on, Gerald eating their snack, the dog bringing the
        // ball back.
        case "pet_ask": return { toy: t, why: "asked" };
        case "pet_stole": return { toy: t, why: "stole", part: evt.food };
        case "pet_fetch": return { toy: t, why: "fetch" };
        case "blowdry": return { toy: t, why: "on", urgent: true };
        // Put down or thrown somewhere: they go for it once it's still.
        case "drop":
        case "throw":
        case "toss":
            // A pet is greeted once, when it first comes out of the box:
            // picked up and put down again after that, it's left be.
            if (t.def.kind === "pet") { if (!t._met) t._met = t._fresh = true; return null; }
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
