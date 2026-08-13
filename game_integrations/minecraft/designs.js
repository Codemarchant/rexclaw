// Ready-made building designs, so "build me a hut" doesn't require the
// planning model to hand-author a hundred grid cells of JSON — which is what
// it had to do before, and why huts never came out right. The model picks a
// design and a spot; the geometry is data, and query.blueprintDiff() drives
// the placing exactly as it does for a hand-written blueprint.
//
// The schematics in designs/*.json are Project Mindcraft's
// (src/agent/npc/construction), MIT License, Copyright (c) Kolby Nottingham
// — see README.md credits. Their shape is blocks[y][z][x] with an `offset`
// (the y the structure starts at, relative to where you stand); ours is
// levels[{dy, grid[dz][dx]}], so dy = y + offset and the cells map straight
// across.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DESIGN_DIR = path.join(__dirname, "designs");

// Placeholders that become whatever the bot actually carries. A design says
// "planks" and gets spruce or oak depending on what was gathered — the point
// of a reusable design.
const WOOD_TYPES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak",
    "mangrove", "cherry", "bamboo", "crimson", "warped"];
const WOOD_GENERICS = new Set(["planks", "log", "door", "fence", "stairs", "slab", "trapdoor"]);
const BED_COLOURS = ["white", "red", "blue", "yellow", "green", "orange", "pink",
    "purple", "cyan", "brown", "black", "gray", "light_gray", "light_blue", "lime", "magenta"];

let cache = null;

/** Every design on disk, parsed once. */
function catalogue() {
    if (cache) return cache;
    cache = {};
    let files = [];
    try {
        files = fs.readdirSync(DESIGN_DIR).filter((f) => f.endsWith(".json"));
    } catch (e) {
        return cache;   // no designs shipped — the model can still hand-write blueprints
    }
    for (const file of files) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(DESIGN_DIR, file), "utf8"));
            if (!Array.isArray(raw.blocks) || !raw.blocks.length) continue;
            cache[raw.name || path.basename(file, ".json")] = raw;
        } catch (e) { /* skip an unreadable design rather than break them all */ }
    }
    return cache;
}

/** The wood the bot has most of — a spruce hut when it chopped spruce. */
function preferredWood(bot) {
    const counts = {};
    let best = null, bestN = 0;
    for (const item of bot?.inventory?.items?.() || []) {
        for (const wood of WOOD_TYPES) {
            if (!item.name.startsWith(`${wood}_`)) continue;
            counts[wood] = (counts[wood] || 0) + item.count;
            if (counts[wood] > bestN) { bestN = counts[wood]; best = wood; }
        }
    }
    return best || "oak";
}

/** The bed colour the bot carries, else plain white. */
function preferredBed(bot) {
    for (const item of bot?.inventory?.items?.() || []) {
        if (item.name.endsWith("_bed")) return item.name;
    }
    return "white_bed";
}

/** Turn one schematic cell into a real block name (or null for "leave it"). */
function resolveCell(cell, bot, wood) {
    if (cell === "" || cell === null || cell === undefined) return null;   // don't care
    if (cell === "air") return "air";
    if (cell === "bed") return preferredBed(bot);
    if (WOOD_GENERICS.has(cell)) {
        const name = `${wood}_${cell}`;
        // Bamboo has no logs, crimson/warped no planks-with-that-name, etc.
        if (bot?.registry?.blocksByName?.[name]) return name;
        return `oak_${cell}`;
    }
    return cell;
}

/** Names + footprints, for the model to choose from. */
function listDesigns() {
    return Object.values(catalogue()).map((d) => ({
        name: d.name,
        size: { x: d.blocks[0][0].length, z: d.blocks[0].length, y: d.blocks.length },
        contains: [...new Set(d.blocks.flat(2).filter((c) => c && c !== "air"))].sort(),
    }));
}

/** A design as a blueprint ready for mem.blueprint, anchored at (x, y, z) —
 *  the north-west corner of its footprint, at the level you stand on. */
function buildDesign(bot, name, x, y, z) {
    const design = catalogue()[String(name)];
    if (!design) {
        const names = Object.keys(catalogue()).join(", ") || "none installed";
        throw new Error(`no design called "${name}" — available: ${names}`);
    }
    if (![x, y, z].every(Number.isFinite)) {
        throw new Error("a design needs an origin: query.design(name, x, y, z) — the corner to build from");
    }
    const wood = preferredWood(bot);
    const offset = Number.isFinite(design.offset) ? design.offset : 0;
    const levels = design.blocks.map((layer, i) => ({
        dy: i + offset,
        grid: layer.map((row) => row.map((cell) => resolveCell(cell, bot, wood))),
    }));
    return {
        design: design.name,
        origin: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
        levels,
    };
}

module.exports = { listDesigns, buildDesign };
