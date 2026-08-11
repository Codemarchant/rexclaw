// Position shapes must be consistent across queries: a script that reaches
// for .pos (as findBlocks/entities return) must not explode on a
// blueprintDiff or nearbyBlocks entry.
"use strict";
const assert = require("node:assert");
const { buildRuntime } = require("../skills.js");

const world = new Map();
for (let dx = 0; dx < 2; dx++) world.set(`${10 + dx},64,20`, "dirt");   // wrong block → needs placing

const bot = {
    registry: {
        blocksByName: { oak_planks: { name: "oak_planks" }, dirt: { name: "dirt" }, stone: { name: "stone" } },
        itemsByName: {},
        blocks: {},
    },
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 5, floored() { return this; } } },
    blockAt: (v) => {
        const name = world.get(`${v.x},${v.y},${v.z}`) || "air";
        return { name, boundingBox: name === "air" ? "empty" : "block", position: v };
    },
    findBlocks: () => [{ x: 3, y: 64, z: 4, distanceTo: () => 5 }],
};
const host = { online: true, bot, status: () => ({}), inventory: () => [] };
const rt = buildRuntime(host, new AbortController(), { log() {}, notify() {}, done() {} });

// blueprintDiff: both flat coords AND .pos
const d = rt.query.blueprintDiff({
    origin: { x: 10, y: 64, z: 20 },
    levels: [{ dy: 0, grid: [["oak_planks", "oak_planks"]] }],
});
assert.ok(d.place.length, "expected blocks to place");
for (const p of d.place) {
    assert.strictEqual(typeof p.x, "number", "flat coords must stay");
    assert.deepStrictEqual(p.pos, { x: p.x, y: p.y, z: p.z }, "a .pos alias must exist");
}

// The exact line from the failing log must now work.
const p = d.place[0];
assert.doesNotThrow(() => {
    const args = [p.name, p.pos.x, p.pos.y, p.pos.z];
    assert.strictEqual(args.length, 4);
});

// clear entries too.
world.set("10,64,20", "stone");
const d2 = rt.query.blueprintDiff({
    origin: { x: 10, y: 64, z: 20 },
    levels: [{ dy: 0, grid: [["air"]] }],
});
assert.ok(d2.clear.length && d2.clear[0].pos, "clear entries need .pos as well");

// nearbyBlocks: keeps .nearest and gains .pos
const nearby = rt.query.nearbyBlocks(8);
assert.ok(nearby.length);
for (const b of nearby) {
    assert.ok(b.nearest, "nearest must stay for existing scripts");
    assert.deepStrictEqual(b.pos, b.nearest, ".pos must alias nearest");
}

console.log("SHAPES-OK");
