// ASCII map renderer: a top-down view of the surroundings so the brain can
// reason spatially — where the trees/water/buildings are, what's around a
// build site, which direction the mobs are. Hundreds of block types
// collapse into a dozen semantic symbols; entities overlay on top.
//
// Ported/adapted (condensed) from Project AIRI's integrations/minecraft
// cognitive/conscious/map-renderer.ts, MIT License, Copyright (c)
// 2024-PRESENT Neko Ayaka — see README.md credits.
"use strict";

const { Vec3 } = require("vec3");

const SYMBOLS = {
    air: " ", ground: ".", stone: "#", sand: ":", water: "~", lava: "%",
    log: "T", leaves: "*", ore: "$", crop: ";", path: "_",
    wood_structure: "=", stone_structure: "B", interactive: "!",
    danger: "X", snow: "'", ice: "-", glass: "o", unknown: "?",
};
const LEGEND = {
    ground: "grass/dirt", stone: "stone", sand: "sand/gravel", water: "water",
    lava: "LAVA", log: "tree trunk", leaves: "leaves", ore: "ORE",
    crop: "crops", path: "path/slab", wood_structure: "wood build",
    stone_structure: "stone build", interactive: "chest/furnace/table/bed",
    danger: "danger", snow: "snow", ice: "ice", glass: "glass", unknown: "?",
};

const INTERACTIVE = new Set([
    "crafting_table", "furnace", "blast_furnace", "smoker", "chest",
    "trapped_chest", "ender_chest", "barrel", "anvil", "enchanting_table",
    "brewing_stand", "grindstone", "stonecutter", "loom", "smithing_table",
    "composter", "lectern",
]);
const DANGER = new Set(["cactus", "fire", "soul_fire", "magma_block", "sweet_berry_bush", "pointed_dripstone"]);
const STONEY = new Set([
    "stone", "deepslate", "andesite", "diorite", "granite", "tuff", "calcite",
    "basalt", "blackstone", "netherrack", "end_stone", "obsidian", "bedrock",
    "dripstone_block", "gravel",
]);
const GROUND = new Set([
    "grass_block", "dirt", "coarse_dirt", "rooted_dirt", "podzol", "mycelium",
    "mud", "packed_mud", "moss_block", "short_grass", "tall_grass", "fern",
]);
const STONE_BUILD = new Set(["cobblestone", "mossy_cobblestone", "smooth_stone"]);

function classify(name) {
    if (name === "air" || name === "cave_air" || name === "void_air") return "air";
    if (INTERACTIVE.has(name) || name.endsWith("_bed")) return "interactive";
    if (name.includes("lava")) return "lava";
    if (DANGER.has(name)) return "danger";
    if (name.includes("water") || name === "kelp" || name === "seagrass") return "water";
    if (name.endsWith("_ore") || name === "ancient_debris") return "ore";
    if (name.endsWith("_log") || name === "mangrove_roots") return "log";
    if (name.endsWith("_leaves")) return "leaves";
    if (["farmland", "wheat", "carrots", "potatoes", "beetroots", "melon", "pumpkin", "sugar_cane", "bamboo"].includes(name)) return "crop";
    if (name === "dirt_path" || name.endsWith("_slab")) return "path";
    if (/_planks$|_fence$|_door$|_stairs$|_trapdoor$/.test(name)) return "wood_structure";
    if (/_bricks?$|_wall$/.test(name) || STONE_BUILD.has(name)) return "stone_structure";
    if (["snow", "snow_block", "powder_snow"].includes(name)) return "snow";
    if (name.includes("ice")) return "ice";
    if (name.includes("glass")) return "glass";
    if (name.includes("terracotta") || STONEY.has(name)) return "stone";
    if (["sand", "red_sand", "soul_sand", "soul_soil", "clay"].includes(name)) return "sand";
    if (GROUND.has(name)) return "ground";
    return "unknown";
}

const HOSTILE = new Set([
    "zombie", "skeleton", "creeper", "spider", "cave_spider", "enderman",
    "witch", "slime", "magma_cube", "blaze", "ghast", "wither_skeleton",
    "phantom", "drowned", "husk", "stray", "pillager", "vindicator",
    "ravager", "warden", "breeze",
]);

/** Topmost non-air block at (x,z), scanning around the bot's Y so hills and
 *  valleys resolve. Null = unloaded chunk. */
function surfaceAt(bot, x, z, aroundY) {
    const top = Math.min(aroundY + 16, 319);
    const bottom = Math.max(aroundY - 48, -64);
    for (let y = top; y >= bottom; y--) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (block && block.name !== "air" && block.name !== "cave_air" && block.name !== "void_air") {
            return { name: block.name, y };
        }
    }
    return null;
}

/** Render a top-down ASCII map around the bot. Radius clamped to 24 (a
 *  49x49 scan is already ~7k blockAt calls). */
function renderMap(bot, radius = 16) {
    const r = Math.max(4, Math.min(radius | 0 || 16, 24));
    const center = bot.entity.position;
    const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
    const size = r * 2 + 1;
    const grid = Array.from({ length: size }, () => new Array(size).fill(" "));
    const used = new Set();

    for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
            const surface = surfaceAt(bot, cx + dx, cz + dz, cy);
            if (!surface) continue;
            const cat = classify(surface.name);
            if (cat !== "air") used.add(cat);
            grid[dz + r][dx + r] = SYMBOLS[cat];
        }
    }

    // Entities overlay terrain; the bot is always dead center.
    const entities = [];
    for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position) continue;
        const ex = Math.floor(e.position.x) - cx;
        const ez = Math.floor(e.position.z) - cz;
        if (Math.abs(ex) > r || Math.abs(ez) > r) continue;
        let symbol = null, label = null;
        if (e.type === "player") {
            symbol = "P"; label = e.username || "player";
        } else if (e.name && e.name !== "item") {
            symbol = HOSTILE.has(e.name) ? "M" : "A";
            label = e.name;
        }
        if (!symbol) continue;
        grid[ez + r][ex + r] = symbol;
        entities.push(`${symbol} ${label} at (${ex > 0 ? "+" : ""}${ex}, ${ez > 0 ? "+" : ""}${ez})`);
    }
    grid[r][r] = "@";

    const lines = [
        `Top-down map centered on you (@) at (${cx}, ${cy}, ${cz}), radius ${r}.`,
        `Up = north (-Z), left = west (-X). Offsets are (east, south) from you.`,
    ];
    for (const row of grid) lines.push(`|${row.join("")}|`);
    if (entities.length) lines.push(`Entities: ${entities.join("; ")}`);
    const legend = [...used].map((c) => `${SYMBOLS[c]}=${LEGEND[c]}`).join(" ");
    lines.push(`Legend: @=you P=player M=hostile A=animal ${legend}`);
    return lines.join("\n");
}

/** Vertical slice through the world — the underground eye. The top-down
 *  view only sees surface columns; this shows caves (voids), lava pockets
 *  (%), and ore ($) at depth. axis "x" slices east-west (fixed Z), "z"
 *  slices north-south (fixed X). yLevel recenters vertically — e.g.
 *  {yLevel: -58} inspects the diamond layer without descending. */
function renderCrossSection(bot, { radius = 12, yLevel = null, axis = "x" } = {}) {
    const r = Math.max(4, Math.min(radius | 0 || 12, 32));
    const center = bot.entity.position;
    const cx = Math.floor(center.x), cz = Math.floor(center.z);
    const botY = Math.floor(center.y);
    const cy = yLevel === null ? botY : Math.floor(yLevel);
    const size = r * 2 + 1;
    const used = new Set();
    const lines = [
        `Cross-section (${axis === "x" ? "east-west, fixed Z=" + cz : "north-south, fixed X=" + cx}) centered at (${cx}, ${cy}, ${cz}), radius ${r}.`,
        `Top row is Y=${cy + r}; left is ${axis === "x" ? "west (-X)" : "north (-Z)"}. ' ' = open air/cave.`,
    ];
    for (let dy = r; dy >= -r; dy--) {
        const wy = cy + dy;
        let row = "";
        for (let dh = -r; dh <= r; dh++) {
            const pos = axis === "x"
                ? new Vec3(cx + dh, wy, cz)
                : new Vec3(cx, wy, cz + dh);
            const block = bot.blockAt(pos);
            if (!block) { row += "?"; continue; }
            if (wy === botY && dh === 0 && cy === botY) { row += "@"; continue; }
            const cat = classify(block.name);
            if (cat !== "air") used.add(cat);
            row += SYMBOLS[cat];
        }
        const gutter = (dy % 4 === 0) ? String(wy).padStart(5) : "     ";
        lines.push(`${gutter}|${row}|`);
    }
    const legend = [...used].map((c) => `${SYMBOLS[c]}=${LEGEND[c]}`).join(" ");
    lines.push(`Legend: @=you ${legend}`);
    return lines.join("\n");
}

module.exports = { renderMap, renderCrossSection };
