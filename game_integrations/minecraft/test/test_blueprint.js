// blueprintDiff is the build loop's source of truth: it decides what is
// still missing, so a wrong answer either stalls a finished build or
// declares an unfinished one complete.
"use strict";
const assert = require("node:assert");
const { buildRuntime } = require("../skills.js");

// A 3x3 floor of oak_planks at y=64 with one block missing, one wrong block,
// grass where the blueprint wants air, and a stone block that must be cleared.
const world = new Map();
for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) world.set(`${10 + dx},64,${20 + dz}`, "oak_planks");
}
world.set("11,64,21", "dirt");          // wrong block → must be replaced
world.delete("12,64,22");               // missing → must be placed
world.set("10,65,20", "short_grass");   // air-like → already satisfies "air"
world.set("11,65,21", "stone");         // must be cleared

const bot = {
    registry: {
        blocksByName: { oak_planks: { name: "oak_planks" }, stone: { name: "stone" } },
        itemsByName: {},
        blocks: {},
    },
    inventory: { items: () => [{ name: "oak_planks", count: 1 }] },
    entity: { position: null },
    blockAt: (v) => {
        const name = world.get(`${v.x},${v.y},${v.z}`) || "air";
        return { name, diggable: true, boundingBox: name === "air" ? "empty" : "block" };
    },
};
const host = { online: true, bot, status: () => ({}), inventory: () => [] };
const rt = buildRuntime(host, new AbortController(), { log() {}, notify() {}, done() {} });

const bp = {
    origin: { x: 10, y: 64, z: 20 },
    levels: [
        { dy: 0, grid: [["oak_planks", "oak_planks", "oak_planks"],
                        ["oak_planks", "oak_planks", "oak_planks"],
                        ["oak_planks", "oak_planks", "oak_planks"]] },
        { dy: 1, grid: [["air", "air", "air"], ["air", "air", "air"], ["air", "air", "air"]] },
    ],
};

const d = rt.query.blueprintDiff(bp);
assert.strictEqual(d.total, 18);
assert.strictEqual(d.complete, false);
assert.strictEqual(d.correct, 15);
assert.strictEqual(d.percent, 83);

// Exactly the two cells that are wrong, and nothing else.
assert.deepStrictEqual(
    d.place.map((p) => `${p.x},${p.y},${p.z}:${p.found}`).sort(),
    ["11,64,21:dirt", "12,64,22:air"],
);
// Ground cover counts as air; only the stone needs clearing.
assert.strictEqual(d.clear.length, 1);
assert.strictEqual(d.clear[0].found, "stone");

// Every entry carries a .pos alias — findBlocks/entities return that shape,
// and a script that reaches for p.pos.x must not explode.
for (const e of [...d.place, ...d.clear]) {
    assert.deepStrictEqual(e.pos, { x: e.x, y: e.y, z: e.z });
}

// Materials are reported as a SHORTFALL against inventory (needs 2, holds 1).
assert.deepStrictEqual(d.missing_materials, { oak_planks: 1 });

// Placement order is bottom-up, so a wall never floats before its floor.
const ys = d.place.map((p) => p.y);
assert.deepStrictEqual(ys, [...ys].sort((a, b) => a - b));

// Typo tolerance: "Oak Planks" resolves like every other name in the API.
const done = rt.query.blueprintDiff({
    origin: { x: 10, y: 64, z: 20 },
    levels: [{ dy: 0, grid: [["Oak Planks"]] }],
});
assert.strictEqual(done.complete, true);
assert.strictEqual(done.percent, 100);

// A malformed blueprint fails with a message that says how to fix it.
assert.throws(() => rt.query.blueprintDiff({ levels: [] }), /origin/);
assert.throws(() => rt.query.blueprintDiff({ origin: { x: 0, y: 0, z: 0 }, levels: [{}] }), /grid/);

console.log("BLUEPRINT-OK");
