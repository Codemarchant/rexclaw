// The acquisition planner: shared ingredients must accumulate, tools must
// appear as prerequisites, higher tool tiers must satisfy lower requirements,
// batch leftovers must be credited, and a route that keeps failing must lose
// to its alternatives.
"use strict";
const assert = require("node:assert");
const { planRecipe, describePlan, qualifyingItems } = require("../recipe_planner.js");

// wooden_pickaxe = 3 planks + 2 sticks; sticks = 2 planks → 4; planks from a
// log → 4 per craft. Iron ore needs a stone pickaxe to mine.
const ITEMS = {
    wooden_pickaxe: 1, stick: 2, oak_planks: 3, oak_log: 4,
    stone_pickaxe: 5, cobblestone: 6, iron_ingot: 7, raw_iron: 8, iron_pickaxe: 9,
};
const registry = {
    itemsByName: Object.fromEntries(Object.entries(ITEMS).map(([n, id]) => [n, { id, name: n }])),
    items: Object.fromEntries(Object.entries(ITEMS).map(([n, id]) => [id, { name: n }])),
    recipes: {
        1: [{ inShape: [[3, 3, 3], [null, 2, null], [null, 2, null]], result: { id: 1, count: 1 } }],
        2: [{ inShape: [[3], [3]], result: { id: 2, count: 4 } }],
        3: [{ ingredients: [4], result: { id: 3, count: 4 } }],
        5: [{ inShape: [[6, 6, 6], [null, 2, null], [null, 2, null]], result: { id: 5, count: 1 } }],
        9: [{ inShape: [[7, 7, 7], [null, 2, null], [null, 2, null]], result: { id: 9, count: 1 } }],
    },
    blocks: {
        10: { name: "oak_log", drops: [4] },
        11: { name: "stone", drops: [6], harvestTools: { 1: true } },      // wooden pickaxe
        12: { name: "iron_ore", drops: [8], harvestTools: { 5: true } },   // stone pickaxe
    },
    blocksByName: {
        oak_log: { name: "oak_log", drops: [4] },
        stone: { name: "stone", drops: [6], harvestTools: { 1: true } },
        iron_ore: { name: "iron_ore", drops: [8], harvestTools: { 5: true } },
    },
};
const botWith = (items = []) => ({
    registry,
    inventory: { items: () => items },
    recipesFor: (id) => (id === 1 || id === 5 || id === 9 ? [] : [{}]),   // tools need a table
});

// 1. Shared ingredients accumulate across branches. A pickaxe consumes 5
//    planks (3 for the head, 2 via sticks) — the old visited-set version
//    dropped the second branch entirely and reported 3.
//    `amount` is the SHORTFALL each craft covers, and crafting is batched
//    (one craft yields 4), so the first batch's spare covers part of the
//    second need: 3 + 1 = 4, not 5. That difference IS the leftover ledger.
{
    const plan = planRecipe(botWith(), "wooden_pickaxe", 1);
    const planks = plan.steps.find((s) => s.action === "craft" && s.item === "oak_planks");
    assert.ok(planks, "expected a planks craft step");
    assert.strictEqual(planks.amount, 4, `planks shortfall must be 4 (5 consumed, 1 covered by the spare), got ${planks.amount}`);
    assert.strictEqual(plan.steps.filter((s) => s.item === "oak_planks").length, 1, "duplicates must merge");
    assert.ok(plan.requiresCraftingTable);
    const text = describePlan(botWith(), "wooden_pickaxe", 1);
    assert.ok(text.indexOf("gather") < text.indexOf("craft"), `gather must come first:\n${text}`);
}

// 2. Leftovers stop the plan buying wood it already has: one log yields 4
//    planks, and 4 planks cover both a plank and a stick requirement.
{
    const plan = planRecipe(botWith(), "wooden_pickaxe", 1);
    const logs = plan.steps.find((s) => s.action === "gather" && s.item === "oak_log");
    assert.strictEqual(logs.amount, 2, `8 planks from 2 logs covers 5; got ${logs.amount}`);
    // With a few planks already in hand, no wood is gathered at all.
    const stocked = planRecipe(botWith([{ name: "oak_planks", count: 8 }]), "wooden_pickaxe", 1);
    assert.ok(!stocked.steps.some((s) => s.item === "oak_log"),
        `planks in inventory must remove the wood run: ${JSON.stringify(stocked.steps)}`);
}

// 3. Tools become prerequisites: mining iron needs a stone pickaxe, which
//    needs cobblestone, which needs a wooden pickaxe.
{
    const plan = planRecipe(botWith(), "iron_ingot", 1);
    const names = plan.steps.map((s) => `${s.action}:${s.item}`);
    assert.ok(names.includes("craft:stone_pickaxe"), `stone pickaxe must be planned: ${names}`);
    assert.ok(names.includes("craft:wooden_pickaxe"), `wooden pickaxe must be planned: ${names}`);
    const ironStep = plan.steps.find((s) => s.item === "raw_iron");
    assert.strictEqual(ironStep.tool, "stone_pickaxe", "the gather step must name the tool it needs");
    const text = describePlan(botWith(), "iron_ingot", 1);
    assert.ok(/needs stone_pickaxe/.test(text), text);
}

// 4. Tier substitution: an iron pickaxe already satisfies the stone
//    requirement, so neither pickaxe is re-crafted.
{
    assert.deepStrictEqual(qualifyingItems("stone_pickaxe"),
        ["stone_pickaxe", "iron_pickaxe", "golden_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]);
    const plan = planRecipe(botWith([{ name: "iron_pickaxe", count: 1 }]), "raw_iron", 1);
    const names = plan.steps.map((s) => s.item);
    assert.ok(!names.includes("stone_pickaxe"), `must not re-craft a downgrade: ${names}`);
    assert.ok(!names.includes("wooden_pickaxe"), `nor its prerequisites: ${names}`);
}

// 5. Failure weighting: a route that keeps failing in the world loses to its
//    alternative. Cobblestone can come from stone OR from a deepslate
//    variant; whichever keeps failing should stop being chosen.
{
    const twoSources = JSON.parse(JSON.stringify(registry));
    twoSources.blocks["13"] = { name: "cobbled_deepslate_source", drops: [6] };   // no tool needed
    twoSources.blocksByName.cobbled_deepslate_source = twoSources.blocks["13"];
    const bot = { registry: twoSources, inventory: { items: () => [] }, recipesFor: () => [] };

    // Untouched, it prefers the cheapest route — the one needing no tool.
    const clean = planRecipe(bot, "cobblestone", 1);
    const cleanSource = clean.steps.find((s) => s.item === "cobblestone").source;
    assert.strictEqual(cleanSource, "cobbled_deepslate_source",
        "with no history it should avoid the route that needs a pickaxe");

    // Once that route has failed repeatedly, the planner routes around it —
    // even though the alternative now costs a tool.
    const fails = { "gather:cobblestone:cobbled_deepslate_source": 6 };
    const rerouted = planRecipe(bot, "cobblestone", 1, { fails });
    const reroutedSource = rerouted.steps.find((s) => s.item === "cobblestone").source;
    assert.strictEqual(reroutedSource, "stone",
        `a repeatedly failing route must lose to its alternative, got ${reroutedSource}`);
}

// 6. Nothing regressed for a simple, already-satisfied request.
assert.strictEqual(describePlan(botWith([{ name: "oak_log", count: 9 }]), "oak_log", 4),
    "You already have 4x oak_log.");
assert.ok(/not a real item id/.test(describePlan(botWith(), "unobtainium", 1)));

console.log("RECIPE-OK");
