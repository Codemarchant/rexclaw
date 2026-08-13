// Ready-made designs: the schematics must convert faithfully into the
// blueprint shape blueprintDiff consumes, and their generic materials must
// become whatever the bot is actually carrying.
"use strict";
const assert = require("node:assert");
const { listDesigns, buildDesign } = require("../designs.js");

const REGISTRY_BLOCKS = {};
for (const wood of ["oak", "spruce", "birch"]) {
    for (const kind of ["planks", "log", "door"]) REGISTRY_BLOCKS[`${wood}_${kind}`] = { name: `${wood}_${kind}` };
}
for (const n of ["dirt", "cobblestone", "glass", "torch", "chest", "crafting_table",
    "furnace", "bookshelf", "white_bed", "red_bed"]) REGISTRY_BLOCKS[n] = { name: n };

const botWith = (items) => ({
    registry: { blocksByName: REGISTRY_BLOCKS },
    inventory: { items: () => items },
});

// Every shipped design is listed with a real footprint.
const designs = listDesigns();
assert.ok(designs.length >= 4, `expected the shipped designs, got ${designs.length}`);
const byName = Object.fromEntries(designs.map((d) => [d.name, d]));
for (const want of ["dirt_shelter", "small_wood_house", "small_stone_house", "large_house"]) {
    assert.ok(byName[want], `missing design: ${want}`);
    const s = byName[want].size;
    assert.ok(s.x > 0 && s.y > 0 && s.z > 0, `${want} has an empty footprint`);
}

// A bot carrying spruce gets a spruce house.
const spruce = buildDesign(botWith([{ name: "spruce_planks", count: 64 }, { name: "spruce_log", count: 12 }]),
    "small_wood_house", 100, 64, -50);
assert.strictEqual(spruce.design, "small_wood_house");
assert.deepStrictEqual(spruce.origin, { x: 100, y: 64, z: -50 });
const spruceCells = spruce.levels.flatMap((l) => l.grid.flat());
assert.ok(spruceCells.includes("spruce_planks"), "generic planks must resolve to spruce");
assert.ok(spruceCells.includes("spruce_log"), "generic log must resolve to spruce");
assert.ok(!spruceCells.includes("planks"), "no unresolved generic may survive");
assert.ok(!spruceCells.includes("log"));
assert.ok(!spruceCells.includes("door"));
assert.ok(!spruceCells.includes("bed"));

// The same design for a bot carrying birch comes out birch.
const birch = buildDesign(botWith([{ name: "birch_planks", count: 64 }]), "small_wood_house", 0, 64, 0);
assert.ok(birch.levels.flatMap((l) => l.grid.flat()).includes("birch_planks"));

// An empty inventory still yields a buildable design (oak fallback).
const bare = buildDesign(botWith([]), "small_wood_house", 0, 64, 0);
assert.ok(bare.levels.flatMap((l) => l.grid.flat()).includes("oak_planks"));

// The bed keeps the colour the bot actually has.
const redBed = buildDesign(botWith([{ name: "red_bed", count: 1 }]), "small_wood_house", 0, 64, 0);
assert.ok(redBed.levels.flatMap((l) => l.grid.flat()).includes("red_bed"));

// Shape: dy carries the schematic's offset, "" becomes null (don't care),
// "air" stays "air" (must be empty), and rows keep their width.
assert.strictEqual(spruce.levels[0].dy, -1, "small_wood_house starts one below your feet");
const cells = spruce.levels.flatMap((l) => l.grid.flat());
assert.ok(cells.includes(null), "'' must become null");
assert.ok(cells.includes("air"), "'air' must survive as a must-be-empty cell");
assert.ok(!cells.includes(""), "no empty strings may reach the blueprint");
for (const level of spruce.levels) {
    const width = level.grid[0].length;
    for (const row of level.grid) assert.strictEqual(row.length, width, "ragged grid row");
}

// The result must be something blueprintDiff actually accepts.
const { buildRuntime } = require("../skills.js");
const world = new Map();
const bot = {
    registry: { blocksByName: REGISTRY_BLOCKS, itemsByName: {}, blocks: {} },
    inventory: { items: () => [{ name: "spruce_planks", count: 64 }] },
    entity: { position: null },
    blockAt: (v) => ({ name: world.get(`${v.x},${v.y},${v.z}`) || "air", boundingBox: "empty" }),
};
const rt = buildRuntime({ online: true, bot, status: () => ({}), inventory: () => [] },
    new AbortController(), { log() {}, notify() {}, done() {} });
const diff = rt.query.blueprintDiff(spruce);
assert.ok(diff.total > 0 && diff.place.length > 0, "a fresh design must have work to do");
assert.ok(Object.keys(diff.missing_materials).length > 0, "and should report materials to gather");

// Unknown names fail with the list of what exists.
assert.throws(() => buildDesign(botWith([]), "mansion", 0, 64, 0), /available:/);
assert.throws(() => buildDesign(botWith([]), "small_wood_house", null, 64, 0), /origin/);

console.log("DESIGNS-OK");
