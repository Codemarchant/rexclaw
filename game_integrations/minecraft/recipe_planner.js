// Recipe planner: recursive crafting-tree resolution — "iron_pickaxe needs
// sticks need planks need logs" — walked against live inventory, so the
// brain can see the WHOLE acquisition plan (gather → smelt → craft) in one
// query instead of discovering each missing ingredient by failing at it.
//
// Beyond a plain recipe walk, it borrows four ideas from Mindcraft's
// npc/item_goal.js (MIT, Copyright (c) 2024 Kolby Nottingham — see
// README.md credits), each of which fixes a way plans go wrong in practice:
//
//   1. COMPETING METHODS. An item can be crafted, mined, smelted or hunted;
//      each is scored and the cheapest wins, so there is a fallback when one
//      route is a dead end.
//   2. FAILURE WEIGHTING. A route that keeps failing in the world gets more
//      expensive, so the plan drifts to alternatives instead of insisting.
//   3. TOOL PREREQUISITES. "Gather iron ore" silently requires a stone
//      pickaxe; the tool becomes part of the plan rather than a surprise.
//   4. TIER SUBSTITUTION. A wooden pickaxe requirement is satisfied by an
//      iron one — never re-craft a downgrade.
//
// Plus a leftovers ledger: crafting 4 planks to satisfy a need of 3 credits
// the spare back, so the next step doesn't gather wood it already has.
"use strict";

// Items produced by smelting (modern ids): output → furnace input.
const SMELT_SOURCES = {
    iron_ingot: "raw_iron",
    gold_ingot: "raw_gold",
    copper_ingot: "raw_copper",
    glass: "sand",
    stone: "cobblestone",
    smooth_stone: "stone",
    brick: "clay_ball",
    charcoal: "oak_log",
    dried_kelp: "kelp",
    baked_potato: "potato",
    cooked_beef: "beef",
    cooked_chicken: "chicken",
    cooked_cod: "cod",
    cooked_mutton: "mutton",
    cooked_porkchop: "porkchop",
    cooked_rabbit: "rabbit",
    cooked_salmon: "salmon",
};

// Items dropped by animals: item → mob to hunt.
const ANIMAL_SOURCES = {
    beef: "cow",
    chicken: "chicken",
    cod: "cod",
    mutton: "sheep",
    porkchop: "pig",
    rabbit: "rabbit",
    salmon: "salmon",
    leather: "cow",
    white_wool: "sheep",
    egg: "chicken",
    feather: "chicken",
};

// Tool tiers, weakest first — a requirement is met by anything at or above it.
const TOOL_TIERS = ["wooden", "stone", "iron", "golden", "diamond", "netherite"];
const TOOL_KINDS = ["pickaxe", "axe", "shovel", "hoe", "sword"];
const MAX_DEPTH = 8;          // recursion guard for cost estimation
const UNREACHABLE = 999;

function smeltSource(itemName) {
    return SMELT_SOURCES[itemName] || null;
}

function animalSource(itemName) {
    return ANIMAL_SOURCES[itemName] || null;
}

/** {tier, kind} for a tool name, else null. */
function toolParts(name) {
    const [tier, kind] = String(name).split("_");
    if (!TOOL_TIERS.includes(tier) || !TOOL_KINDS.includes(kind)) return null;
    return { tier, kind };
}

/** Every item that would satisfy a requirement for `name` — itself, plus
 *  any higher tier of the same tool. */
function qualifyingItems(name) {
    const parts = toolParts(name);
    if (!parts) return [name];
    return TOOL_TIERS.slice(TOOL_TIERS.indexOf(parts.tier))
        .map((tier) => `${tier}_${parts.kind}`);
}

/** How many of `name` the ledger can cover, counting higher tool tiers. */
function heldFor(available, name) {
    return qualifyingItems(name).reduce((n, alt) => n + (available[alt] || 0), 0);
}

/** Spend `qty` of `name` from the ledger, weakest qualifying tier first so a
 *  diamond pickaxe isn't "used up" by a job a wooden one covers. */
function spend(available, name, qty) {
    let left = qty;
    for (const alt of qualifyingItems(name)) {
        if (left <= 0) break;
        const have = available[alt] || 0;
        const take = Math.min(have, left);
        if (take > 0) {
            available[alt] = have - take;
            left -= take;
        }
    }
    return qty - left;
}

/** minecraft-data recipe cells come in three shapes across versions:
 *  plain item id, [id, metadata], or {id, metadata}. Normalize to id|null. */
function cellId(cell) {
    if (cell == null) return null;
    if (typeof cell === "number") return cell >= 0 ? cell : null;
    if (Array.isArray(cell)) return cellId(cell[0]);
    if (typeof cell === "object") return cellId(cell.id);
    return null;
}

/** All crafting recipes for an item as [{ingredientName: count}], plus the
 *  output count per craft. */
function craftingRecipes(registry, itemName) {
    const item = registry.itemsByName[itemName];
    if (!item) return null;
    const raw = registry.recipes?.[item.id];
    if (!raw || !raw.length) return null;
    const out = [];
    for (const r of raw) {
        const ids = [];
        if (Array.isArray(r.ingredients)) {
            for (const ing of r.ingredients) {
                const id = cellId(ing);
                if (id != null) ids.push(id);
            }
        } else if (Array.isArray(r.inShape)) {
            for (const row of r.inShape) {
                for (const cell of row) {
                    const id = cellId(cell);
                    if (id != null) ids.push(id);
                }
            }
        }
        if (!ids.length) continue;
        const ingredients = {};
        for (const id of ids) {
            const name = registry.items[id]?.name;
            if (!name) continue;
            ingredients[name] = (ingredients[name] || 0) + 1;
        }
        const result = r.result;
        const count = typeof result === "number" ? 1 : (result?.count ?? 1);
        out.push({ ingredients, outputCount: Math.max(1, count) });
    }
    return out.length ? out : null;
}

/** Blocks whose drops include the item — "where do I mine this". */
function blockSources(registry, itemName) {
    const item = registry.itemsByName[itemName];
    if (!item) return [];
    const sources = [];
    for (const block of Object.values(registry.blocks)) {
        if (block.drops && block.drops.includes(item.id)) sources.push(block.name);
    }
    return sources;
}

/** The weakest tool that can harvest a block, or null when hands will do.
 *  This is the prerequisite that otherwise ambushes a gather step. */
function requiredTool(registry, blockName) {
    const block = registry.blocksByName?.[blockName];
    const ids = Object.keys(block?.harvestTools || {});
    if (!ids.length) return null;
    const names = ids.map((id) => registry.items?.[id]?.name).filter(Boolean);
    if (!names.length) return null;
    // Weakest tier available, so the plan doesn't demand a diamond pickaxe
    // to mine stone.
    let best = names[0], bestRank = 99;
    for (const n of names) {
        const parts = toolParts(n);
        const rank = parts ? TOOL_TIERS.indexOf(parts.tier) : 50;
        if (rank < bestRank) { bestRank = rank; best = n; }
    }
    return best;
}

/** Does crafting this need a 3x3 grid? Probed against the live bot (2x2
 *  recipes resolve with no table). */
function needsCraftingTable(bot, itemName) {
    const item = bot.registry.itemsByName[itemName];
    if (!item) return false;
    return bot.recipesFor(item.id, null, 1, null).length === 0;
}

function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

/** Every way to obtain an item, in no particular order. */
function methodsFor(bot, name) {
    const registry = bot.registry;
    const out = [];
    for (const recipe of craftingRecipes(registry, name) || []) {
        out.push({ kind: "craft", ingredients: recipe.ingredients, outputCount: recipe.outputCount });
    }
    const smelt = smeltSource(name);
    if (smelt) out.push({ kind: "smelt", from: smelt });
    for (const source of blockSources(registry, name)) {
        out.push({ kind: "gather", source, tool: requiredTool(registry, source) });
    }
    const animal = animalSource(name);
    if (animal) out.push({ kind: "hunt", source: animal });
    return out;
}

/** Rough cost of obtaining `name`: how deep the tree goes, plus how often
 *  this route has actually failed in the world. Memoised per plan. */
function costOf(bot, name, ctx, depth = 0) {
    if (heldFor(ctx.available, name) > 0) return 0;
    if (depth > MAX_DEPTH || ctx.stack.has(name)) return UNREACHABLE;
    if (ctx.memo.has(name)) return ctx.memo.get(name);
    ctx.stack.add(name);
    let best = UNREACHABLE;
    for (const method of methodsFor(bot, name)) {
        let child = 0;
        if (method.kind === "craft") {
            for (const ing of Object.keys(method.ingredients)) {
                child = Math.max(child, costOf(bot, ing, ctx, depth + 1));
            }
        } else if (method.kind === "smelt") {
            child = costOf(bot, method.from, ctx, depth + 1);
        } else if (method.kind === "gather" && method.tool) {
            child = costOf(bot, method.tool, ctx, depth + 1);
        }
        if (child >= UNREACHABLE) continue;
        best = Math.min(best, 1 + child + (ctx.fails[methodKey(name, method)] || 0));
    }
    // No method at all = a base resource: find it in the world.
    if (best === UNREACHABLE && !methodsFor(bot, name).length) best = 1 + (ctx.fails[name] || 0);
    ctx.stack.delete(name);
    ctx.memo.set(name, best);
    return best;
}

/** Stable id for "this way of getting this item", for failure counting. */
function methodKey(name, method) {
    if (method.kind === "craft") return `craft:${name}`;
    if (method.kind === "smelt") return `smelt:${name}:${method.from}`;
    if (method.kind === "gather") return `gather:${name}:${method.source}`;
    return `hunt:${name}:${method.source}`;
}

/** Cheapest way to get `name` right now, accounting for past failures. */
function bestMethod(bot, name, ctx) {
    let best = null, bestCost = UNREACHABLE;
    for (const method of methodsFor(bot, name)) {
        let child = 0;
        if (method.kind === "craft") {
            for (const ing of Object.keys(method.ingredients)) {
                child = Math.max(child, costOf(bot, ing, ctx, 1));
            }
        } else if (method.kind === "smelt") {
            child = costOf(bot, method.from, ctx, 1);
        } else if (method.kind === "gather" && method.tool) {
            child = costOf(bot, method.tool, ctx, 1);
        }
        if (child >= UNREACHABLE) continue;
        const cost = 1 + child + (ctx.fails[methodKey(name, method)] || 0);
        if (cost < bestCost) { bestCost = cost; best = method; }
    }
    return best;
}

/** Build the full acquisition plan for `amount` of `itemName`. Returns
 *  {steps, missing, requiresCraftingTable, unknown} where steps are in
 *  dependency order (base materials first).
 *
 *  `opts.fails` is a {methodKey: count} map of routes that have failed in
 *  the world — pass it to make the plan route around them. */
function planRecipe(bot, itemName, amount = 1, opts = {}) {
    const registry = bot.registry;
    if (!registry.itemsByName[itemName]) {
        return { unknown: true, steps: [], missing: {}, requiresCraftingTable: false };
    }
    const ctx = {
        available: inventoryCounts(bot),
        fails: opts.fails || {},
        memo: new Map(),
        stack: new Set(),
    };
    const steps = [];
    const missing = {};
    // Recursion stack, NOT a visited set: a visited set silently dropped the
    // second branch's demand for a shared ingredient (a pickaxe needs 3
    // planks for the head plus 2 more via sticks — it reported 3, not 5).
    const walking = new Set();

    const resolve = (name, needed) => {
        if (walking.has(name)) return;   // cycle (gold nugget ↔ ingot)
        walking.add(name);
        try {
            resolveInner(name, needed);
        } finally {
            walking.delete(name);
        }
    };

    const resolveInner = (name, needed) => {
        const have = heldFor(ctx.available, name);
        if (have >= needed) { spend(ctx.available, name, needed); return; }
        const short = needed - have;
        spend(ctx.available, name, have);
        ctx.memo.clear();   // the ledger moved; cached costs are stale

        const method = bestMethod(bot, name, ctx);

        if (method?.kind === "smelt") {
            steps.push({ action: "smelt", item: name, amount: short, from: method.from });
            resolve(method.from, short);
            return;
        }
        if (method?.kind === "craft") {
            const crafts = Math.ceil(short / method.outputCount);
            const scaled = {};
            for (const [ing, per] of Object.entries(method.ingredients)) scaled[ing] = per * crafts;
            steps.push({
                action: "craft",
                item: name,
                amount: short,
                ingredients: scaled,
                needsTable: needsCraftingTable(bot, name),
            });
            for (const [ing, n] of Object.entries(scaled)) resolve(ing, n);
            // Batch rounding leaves spares — credit them so the next need
            // doesn't send the bot back out for wood it already has.
            const surplus = (crafts * method.outputCount) - short;
            if (surplus > 0) ctx.available[name] = (ctx.available[name] || 0) + surplus;
            return;
        }
        if (method?.kind === "gather") {
            // The tool is part of the plan, not a surprise mid-mine.
            if (method.tool && heldFor(ctx.available, method.tool) < 1) {
                resolve(method.tool, 1);
            }
            steps.push({ action: "gather", item: name, amount: short, source: method.source, tool: method.tool || null });
            missing[name] = (missing[name] || 0) + short;
            return;
        }
        if (method?.kind === "hunt") {
            steps.push({ action: "hunt", item: name, amount: short, source: method.source });
            missing[name] = (missing[name] || 0) + short;
            return;
        }
        // Nothing knows how to get it — say so plainly.
        steps.push({ action: "gather", item: name, amount: short, source: "unknown", tool: null });
        missing[name] = (missing[name] || 0) + short;
    };

    resolve(itemName, Math.max(1, amount | 0));

    // Shared ingredients resolve once per branch — merge the duplicates so
    // "planks" reads as one line with the TOTAL amount. Each item keeps its
    // DEEPEST position: parents are pushed before their ingredients, so the
    // last occurrence sits after every consumer and the reversed rendering
    // stays in true dependency order.
    const byKey = new Map();
    steps.forEach((s, i) => {
        const key = `${s.action}:${s.item}:${s.from || s.source || ""}`;
        const prior = byKey.get(key);
        if (!prior) { byKey.set(key, { step: s, at: i }); return; }
        prior.step.amount += s.amount;
        if (s.ingredients) {
            for (const [ing, n] of Object.entries(s.ingredients)) {
                prior.step.ingredients[ing] = (prior.step.ingredients[ing] || 0) + n;
            }
        }
        prior.at = i;
    });
    const merged = [...byKey.values()].sort((a, b) => a.at - b.at).map((e) => e.step);
    return {
        unknown: false,
        steps: merged,
        missing,
        requiresCraftingTable: merged.some((s) => s.action === "craft" && s.needsTable),
    };
}

/** LLM-facing rendering: dependency order (do first → do last), with what's
 *  already covered by inventory omitted. */
function describePlan(bot, itemName, amount = 1, opts = {}) {
    const plan = planRecipe(bot, itemName, amount, opts);
    if (plan.unknown) return `"${itemName}" is not a real item id.`;
    if (!plan.steps.length) return `You already have ${amount}x ${itemName}.`;
    const lines = [`Plan for ${amount}x ${itemName} (in order):`];
    const ordered = [...plan.steps].reverse();
    ordered.forEach((s, i) => {
        if (s.action === "craft") {
            const ing = Object.entries(s.ingredients).map(([n, c]) => `${c}x ${n}`).join(" + ");
            lines.push(`${i + 1}. craft ${s.amount}x ${s.item} from ${ing}${s.needsTable ? " (needs crafting_table)" : ""}`);
        } else if (s.action === "smelt") {
            lines.push(`${i + 1}. smelt ${s.amount}x ${s.from} -> ${s.item} (needs furnace + fuel)`);
        } else if (s.action === "hunt") {
            lines.push(`${i + 1}. hunt ${s.source} for ${s.amount}x ${s.item}`);
        } else {
            lines.push(`${i + 1}. gather ${s.amount}x ${s.item}`
                + (s.source !== "unknown" ? ` (mine ${s.source}` : " (source unknown")
                + (s.tool ? `, needs ${s.tool}` : "") + ")");
        }
    });
    if (plan.requiresCraftingTable) lines.push("A crafting_table is required at some step.");
    const missing = Object.entries(plan.missing);
    if (missing.length) {
        lines.push(`Base resources to acquire: ${missing.map(([n, c]) => `${c}x ${n}`).join(", ")}.`);
    } else {
        lines.push("All base resources are already in inventory.");
    }
    return lines.join("\n");
}

module.exports = {
    planRecipe, describePlan, smeltSource, animalSource, blockSources,
    qualifyingItems, requiredTool, methodKey,
};
