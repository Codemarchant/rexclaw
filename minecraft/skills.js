// Skill library — the functions the planner's generated JS composes. Every
// skill takes the live bot at call time (via host.bot) and respects the
// controller's abort signal, so a new "interrupt" directive can stop a
// script mid-walk. Skills throw plain Errors with actionable messages: the
// brain feeds failures back to the LLM, which is expected to adapt.
"use strict";

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { describePlan, methodKey } = require("./recipe_planner");
const { listDesigns, buildDesign } = require("./designs");
const { renderMap, renderCrossSection } = require("./map_renderer");

const NEAR_RANGE = 2;          // "close enough" for goto-style goals
const REACH_RANGE = 4.2;       // survival block interaction reach
const ATTACK_TIMEOUT_MS = 45000;

// Ground that already IS what a design asks for. A dirt shelter on a grassy
// field otherwise demands digging up and re-placing every floor cell —
// dozens of mine-then-place round trips to end up with the same material.
const SAME_AS = {
    dirt: new Set(["grass_block", "coarse_dirt", "rooted_dirt", "podzol", "mycelium", "dirt_path"]),
    cobblestone: new Set(["mossy_cobblestone"]),
    stone: new Set(["andesite", "diorite", "granite"]),
};

// Blocks that count as "empty" for building: placeAt happily replaces them
// and blueprintDiff treats them as air. ONE set for both — when they
// disagreed, a dock blueprint's water cells were flagged "clear this" and
// mineAt can't dig water, an unbreakable error loop.
const PASSABLE = new Set(["air", "cave_air", "void_air", "water", "grass", "short_grass",
    "tall_grass", "snow", "dead_bush", "fern", "seagrass"]);

// Items whose placed block has a DIFFERENT id. Without this table every one
// of these fails "not a placeable block" — which is why the bot could never
// plant a single crop or lay redstone dust.
const ITEM_PLACES_BLOCK = {
    wheat_seeds: "wheat",
    beetroot_seeds: "beetroots",
    melon_seeds: "melon_stem",
    pumpkin_seeds: "pumpkin_stem",
    carrot: "carrots",
    potato: "potatoes",
    nether_wart: "nether_wart",
    cocoa_beans: "cocoa",
    redstone: "redstone_wire",
    string: "tripwire",
    sweet_berries: "sweet_berry_bush",
    glow_berries: "cave_vines",
    kelp: "kelp_plant",
    water_bucket: "water",
    lava_bucket: "lava",
};

// Blocks whose drops need collecting by hand — mineflayer's collectBlock
// plugin silently no-ops on these (mindcraft's mustCollectManually list).
const MANUAL_PICKUP = [
    "wheat", "carrots", "potatoes", "beetroots", "melon", "pumpkin",
    "sugar_cane", "bamboo", "cactus", "nether_wart", "cocoa", "sapling",
    "torch", "lantern", "flower", "tulip", "orchid", "allium", "bluet",
    "daisy", "dandelion", "poppy", "sunflower", "lilac", "rose_bush",
    "peony", "mushroom", "sweet_berry_bush", "cave_vines", "vine", "kelp",
    "seagrass", "lily_pad", "grass", "fern", "snow", "rail", "ladder",
    "sign", "banner", "carpet", "candle", "amethyst_cluster", "glow_lichen",
];

function needsManualPickup(blockName) {
    return MANUAL_PICKUP.some((frag) => blockName.includes(frag));
}

/** Record that a way of obtaining an item didn't work, so the next plan
 *  prices that route higher and drifts to an alternative (mindcraft's
 *  failure-weighted method selection). Kept on the host so it survives
 *  across scripts, like the collect stickiness. */
function noteAcquisitionFailure(host, kind, item, source) {
    const fails = host._recipeFails || (host._recipeFails = {});
    const key = methodKey(item, { kind, source, from: source });
    fails[key] = (fails[key] || 0) + 1;
}

/** Nearest live entity matching `name`, by TOKEN subset in either direction
 *  — "jungle_boat" finds a plain "boat" and vice versa, while "pig" does NOT
 *  match "piglin". Usernames match exactly (case-insensitive). */
function nearestEntityByName(bot, name, maxDist = 48) {
    const wanted = new Set(normalizeName(name).split("_").filter(Boolean));
    if (!wanted.size) return null;
    const subset = (a, b) => [...a].every((t) => b.has(t));
    let best = null, bestD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
        if (!e?.position || !e.isValid || e === bot.entity) continue;
        const uname = (e.username || "").toLowerCase();
        const tokens = new Set(String(e.name || "").toLowerCase().split("_").filter(Boolean));
        const hit = (uname && uname === normalizeName(name))
            || (tokens.size && (subset(wanted, tokens) || subset(tokens, wanted)));
        if (!hit) continue;
        const d = e.position.distanceTo(bot.entity.position);
        if (d < bestD && d <= maxDist) { bestD = d; best = e; }
    }
    return best;
}

// In-game chat rate limits, enforced across scripts (see `chat`).
const CHAT_WINDOW_MS = 60000;
const CHAT_MAX_PER_WINDOW = 6;
const CHAT_REPEAT_MS = 30000;

/** Survival reach, eye to block centre. Past this the server rejects the
 *  swing and bot.dig grinds at air forever (mc-agent-neko's reach guard). */
const DIG_REACH = 4.6;
const DIFF_PLACE_MAX = 24;                 // blocks blueprintDiff hands over per turn
const DIFF_CLEAR_MAX = 12;
// Second-chance path search. bot.pathfinder.thinkTimeout is deliberately
// tight (3s) so ordinary walking stays responsive, but a long route or one
// that has to be DUG legitimately needs longer — and giving up there was
// reported as "could not reach the target", which reads as impossible.
const PATIENT_THINK_MS = 20000;

function eyeDistanceTo(bot, pos) {
    const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
    return eye.distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5));
}

/** Equip and VERIFY the server registered it. A place/use packet that
 *  arrives before the held-slot change resolves is applied to the previous
 *  item and silently dropped — the classic "the command ran but nothing
 *  happened" (mc-agent-neko's tick_confirm lesson). */
async function equipConfirmed(host, ctl, itemName, destination = "hand") {
    const bot = liveBot(host);
    const wanted = normalizeName(itemName);
    const held = destination === "hand" ? bot.heldItem : null;
    if (held && held.name === wanted) return held;
    const item = invItem(bot, wanted)
        || bot.inventory.items().find((i) => i.name === resolveName(bot.registry.itemsByName || {}, wanted, "item").name);
    if (!item) throw new Error(`no ${wanted} in inventory`);
    await bot.equip(item, destination);
    for (let i = 0; i < 10; i++) {
        throwIfAborted(ctl);
        const now = destination === "hand" ? bot.heldItem : bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
        if (now && now.name === item.name) return now;
        await wait(ctl, 60);
    }
    throw new Error(`equipping ${wanted} did not register with the server — try again`);
}

class AbortError extends Error {
    constructor() { super("aborted by a newer directive"); this.aborted = true; }
}

function throwIfAborted(ctl) {
    if (ctl.signal.aborted) throw new AbortError();
}

/** Abortable sleep, capped so a generated `await wait(1e9)` can't wedge the
 *  script past the wall-clock guard's ability to explain why. */
function wait(ctl, ms) {
    const capped = Math.min(Math.max(0, Number(ms) || 0), 60000);
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); resolve(); }, capped);
        const onAbort = () => { cleanup(); reject(new AbortError()); };
        const cleanup = () => { clearTimeout(t); ctl.signal.removeEventListener("abort", onAbort); };
        ctl.signal.addEventListener("abort", onAbort);
    });
}

function liveBot(host) {
    if (!host.online) throw new Error("bot is not connected to the game right now");
    return host.bot;
}

/** LLMs write names every which way — "minecraft:stone_pickaxe",
 *  "Stone Pickaxe", "minecraft_stone_pickaxe". Normalize to the bare id. */
function normalizeName(name) {
    return String(name).trim().toLowerCase()
        .replace(/^minecraft[:_]/, "")
        .replace(/\s+/g, "_");
}

function levenshtein(a, b) {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            m[i][j] = Math.min(
                m[i - 1][j] + 1,
                m[i][j - 1] + 1,
                m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return m[a.length][b.length];
}

/** Resolve a name against a registry dict with typo tolerance (idea from
 *  airi's getClosestBlockName): exact after normalization, else the closest
 *  key — auto-accepted when nearly right, suggested in the error otherwise. */
function resolveName(dict, name, kind) {
    const wanted = normalizeName(name);
    if (dict[wanted]) return dict[wanted];
    let bestKey = null, bestDist = Infinity;
    for (const key of Object.keys(dict)) {
        const d = levenshtein(wanted, key);
        if (d < bestDist) { bestDist = d; bestKey = key; if (!d) break; }
    }
    if (bestKey && bestDist <= 2) return dict[bestKey];
    throw new Error(
        `unknown ${kind} "${name}"${bestKey ? ` — did you mean "${bestKey}"?` : ""} (use exact minecraft ids like "oak_log")`,
    );
}

function itemByName(host, name) {
    return resolveName(host.bot?.registry?.itemsByName || {}, name, "item");
}

function blockByName(host, name) {
    return resolveName(host.bot?.registry?.blocksByName || {}, name, "block");
}

function invItem(bot, name) {
    return bot.inventory.items().find((i) => i.name === name) || null;
}

/** Best melee weapon in inventory by material rank (sword beats axe at the
 *  same tier). Null when unarmed. */
function bestWeapon(bot) {
    const MATERIALS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];
    let best = null, bestRank = -1;
    for (const item of bot.inventory.items()) {
        const m = /^([a-z]+)_(sword|axe)$/.exec(item.name);
        if (!m) continue;
        const rank = MATERIALS.indexOf(m[1]) * 10 + (m[2] === "sword" ? 5 : 4);
        if (rank > bestRank) { bestRank = rank; best = item; }
    }
    return best;
}

/** Nearest free spot to place a block: air with a solid, diggable floor,
 *  scanning rings around the bot (adapted from airi's getNearestFreeSpace). */
function nearestFreeSpace(bot, maxDist = 8) {
    const base = bot.entity.position.floored();
    for (let r = 2; r <= maxDist; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // ring only
                for (let dy = -1; dy <= 1; dy++) {
                    const pos = base.offset(dx, dy, dz);
                    const at = bot.blockAt(pos);
                    const above = bot.blockAt(pos.offset(0, 1, 0));
                    const below = bot.blockAt(pos.offset(0, -1, 0));
                    if (!at || !above || !below) continue;
                    if (at.name !== "air" || above.name !== "air") continue;
                    if (below.boundingBox !== "block" || !below.diggable) continue;
                    return pos;
                }
            }
        }
    }
    return null;
}

/** Sweep dropped item entities near the bot, walking to each. Used after
 *  kills and digs — drops spawn a few hundred ms AFTER the event, so the
 *  first scan being empty means "keep waiting", not "no drops" (airi's
 *  hardest-won combat lesson). Grace window resets on every pickup. */
async function sweepDrops(host, ctl, { want = null, radius = 8, deadlineMs = 6000, graceMs = 1500 } = {}) {
    const bot = liveBot(host);
    const startedAt = Date.now();
    let lastFoundAt = Date.now();
    let collected = 0;
    while (Date.now() - startedAt < deadlineMs && Date.now() - lastFoundAt < graceMs + 400) {
        throwIfAborted(ctl);
        const pos = bot.entity.position;
        let target = null, best = Infinity;
        for (const e of Object.values(bot.entities || {})) {
            if (!e?.position || !e.isValid || e.name !== "item") continue;
            const d = e.position.distanceTo(pos);
            if (d > radius) continue;
            if (want) {
                const dropped = e.getDroppedItem?.();
                if (!dropped || dropped.name !== want) continue;
            }
            if (d < best) { best = d; target = e; }
        }
        if (!target) {
            await wait(ctl, 250);   // drops may still be spawning
            continue;
        }
        try {
            await gotoGoal(host, ctl, new goals.GoalNear(
                target.position.x, target.position.y, target.position.z, 1));
        } catch (e) {
            if (ctl.signal.aborted) throw e;
            break;   // unreachable drop — don't loop on it
        }
        await wait(ctl, 300);
        if (!target.isValid) { collected += 1; lastFoundAt = Date.now(); }
        else break;   // stood next to it and it's still there
    }
    return collected;
}

/** Block ids to mine when asked for `name`: the block itself (if it is
 *  one) PLUS every block that DROPS it as an item. Vanilla-critical:
 *  "cobblestone" must match stone (cobblestone rarely exists in the wild —
 *  it's what stone drops), "raw_iron" must match both iron ores, "diamond"
 *  both diamond ores. */
function sourceBlockIds(bot, name) {
    const registry = bot.registry;
    const wanted = normalizeName(name);
    const ids = new Set();
    const block = registry.blocksByName?.[wanted];
    if (block) ids.add(block.id);
    const item = registry.itemsByName?.[wanted];
    if (item) {
        for (const b of Object.values(registry.blocks || {})) {
            if (b.drops && b.drops.includes(item.id)) ids.add(b.id);
        }
    }
    if (!ids.size) {
        if (item) {
            // Real item, but the world never drops it as a block — tools,
            // crafted goods, mob drops. Steer to the right verb.
            throw new Error(
                `nothing minable drops "${wanted}" — craft it (see query.recipePlan("${wanted}")) `
                + `or, if it's lying on the ground, use pickup("${wanted}")`,
            );
        }
        // Typo path: fuzzy-resolve across blocks+items, then retry.
        const merged = { ...registry.itemsByName, ...registry.blocksByName };
        const def = resolveName(merged, wanted, "block or item");
        return sourceBlockIds(bot, def.name);
    }
    return [...ids];
}

/** Pathfinder goal wrapper: abort clears the goal, which rejects the
 *  in-flight goto — map both flavors to AbortError so scripts see one
 *  shape. A stagnation watchdog (3×5s ticks with <1.5 blocks of movement,
 *  exempting mid-dig/mid-build phases) cancels a wedged path with a
 *  diagnosable reason instead of eating the whole script budget. */
async function gotoGoal(host, ctl, goal) {
    const bot = liveBot(host);
    throwIfAborted(ctl);
    // Walking is impossible while riding a boat/minecart/horse, and the
    // pathfinder just wedges — leaving the vehicle is what the caller means.
    if (bot.vehicle) {
        try { bot.dismount(); } catch (e) { /* already off */ }
        await wait(ctl, 300);
    }
    const onAbort = () => { try { bot.pathfinder.setGoal(null); } catch (e) { /* gone */ } };
    ctl.signal.addEventListener("abort", onAbort);
    let stagnant = 0;
    let lastPos = bot.entity.position.clone();
    const watchdog = setInterval(() => {
        try {
            if (!bot.entity) return;
            if (bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.()) {
                stagnant = 0;
                lastPos = bot.entity.position.clone();
                return;
            }
            const moved = bot.entity.position.distanceTo(lastPos);
            lastPos = bot.entity.position.clone();
            stagnant = moved < 1.5 ? stagnant + 1 : 0;
            if (stagnant >= 3) { try { bot.pathfinder.setGoal(null); } catch (e) { /* fine */ } }
        } catch (e) { /* non-fatal */ }
    }, 5000);
    try {
        await bot.pathfinder.goto(goal);
    } catch (e) {
        if (ctl.signal.aborted) throw new AbortError();
        // The survival reflex layer SHARES this pathfinder: fleeing a mob,
        // climbing out of water and fighting back all take the goal away
        // (setGoal(null) / a goto of their own), which rejects our travel
        // with "Path was stopped before it could be completed". That is not
        // the destination being unreachable — it is the body saving itself,
        // and reporting it as a travel failure sent the model round the
        // same doomed retry every few seconds. Let the reflex finish, then
        // carry on to where we were going.
        if (String(e.message || "").includes("Path was stopped") && host.reflexes?.engaged) {
            const doing = host.reflexes.engaged;
            for (let i = 0; i < 24 && host.reflexes?.engaged; i++) await wait(ctl, 500);
            throwIfAborted(ctl);
            try {
                await bot.pathfinder.goto(goal);
                return;
            } catch (after) {
                if (ctl.signal.aborted) throw new AbortError();
                throw new Error(`travel was interrupted by your body's survival reflex (${doing}) and could not resume: ${after.message}. `
                    + "Deal with what is attacking you, then travel again");
            }
        }
        if (stagnant >= 3) {
            const p = bot.entity?.position?.floored();
            throw new Error(`navigation stalled — no progress for 15s${p ? ` at (${p.x}, ${p.y}, ${p.z})` : ""}. `
                + "Underground, in a pit, or walled in: call surface(). Otherwise dig through the obstacle (mineAt) or try a closer waypoint");
        }
        // "Took too long to decide path to goal" is the THINK BUDGET
        // expiring, not proof the target is unreachable — recovering a
        // death drop at y=50 or crossing a few hundred blocks needs a
        // search this size. One patient retry before we call it a failure;
        // the old behaviour reported "could not reach the target" and the
        // model believed it.
        const thoughtTooLong = String(e.message || "").includes("long to decide");
        if (thoughtTooLong) {
            const previous = bot.pathfinder.thinkTimeout;
            bot.pathfinder.thinkTimeout = PATIENT_THINK_MS;
            try {
                await bot.pathfinder.goto(goal);
                return;
            } catch (again) {
                if (ctl.signal.aborted) throw new AbortError();
                throw new Error(`no path found to the target after searching for ${PATIENT_THINK_MS / 1000}s`
                    + ` (${again.message}) — it is out of path range (${bot.pathfinder.searchRadius} blocks) or sealed off.`
                    + " Travel toward it in stages with closer waypoints, or surface() first if you are underground");
            } finally {
                bot.pathfinder.thinkTimeout = previous;
            }
        }
        throw new Error(`could not reach the target (${e.message})`);
    } finally {
        clearInterval(watchdog);
        ctl.signal.removeEventListener("abort", onAbort);
    }
}

/** The player entity for `name`, forgivingly. Directives arrive with the
 *  user's REAL name ("follow Johnny") while the world only knows their
 *  character ("Codemarchant"), so an exact miss falls back to the only other
 *  player present — which in a single-player world is always the right
 *  answer. A miss otherwise names who IS here, instead of a dead end. */
function findPlayerEntity(bot, name) {
    const wanted = String(name || "").toLowerCase();
    const others = Object.values(bot.players || {})
        .filter((p) => p?.username && p.username !== bot.username);
    const exact = others.find((p) => p.username === name)
        || others.find((p) => p.username.toLowerCase() === wanted);
    const chosen = exact || (others.length === 1 ? others[0] : null);
    if (!chosen) {
        const names = others.map((p) => p.username);
        throw new Error(names.length
            ? `no player called "${name}" here — these are: ${names.join(", ")}`
            : `no other players are in the world right now`);
    }
    if (!chosen.entity) {
        throw new Error(`${chosen.username} is in the world but too far away to see — walk their way first`);
    }
    return chosen.entity;
}

/** Build the skill + query surface for one script run. Everything is bound
 *  to `ctl` so aborting the controller stops the whole script. */
function buildRuntime(host, ctl, io) {
    const skills = {
        /** Say something in game chat. Also relayed to the companion — the
         *  voice side must hear what the game side says, or their world
         *  models silently diverge.
         *
         *  Throttled ACROSS scripts, not just within one: a re-planning
         *  loop once produced a line a second, which floods the server's
         *  chat for every player on it. Suppression is silent and reported
         *  back to the model rather than thrown, so it can't turn a chatty
         *  script into a failed one. */
        chat: async (message) => {
            throwIfAborted(ctl);
            const text = String(message).slice(0, 250);
            const now = Date.now();
            const log = host._chatLog || (host._chatLog = []);
            while (log.length && now - log[0].at > CHAT_WINDOW_MS) log.shift();
            if (log.some((c) => c.text === text && now - c.at < CHAT_REPEAT_MS)) {
                return { said: false, suppressed: "you already said exactly that a moment ago" };
            }
            if (log.length >= CHAT_MAX_PER_WINDOW) {
                return { said: false, suppressed: `too many messages (${CHAT_MAX_PER_WINDOW} in ${CHAT_WINDOW_MS / 1000}s) — let the conversation breathe` };
            }
            log.push({ text, at: now });
            liveBot(host).chat(text);
            io.chat?.(text);
            return { said: true };
        },

        /** Walk to coordinates (stops within `range` blocks). */
        goTo: async (x, y, z, range = NEAR_RANGE) => {
            const bot = liveBot(host);
            let ty = Math.floor(y);
            // Coordinates of a ground block mean "stand THERE", not "dig a
            // silly hole into it" — nudge one up when the target is solid
            // with standing room above.
            const at = bot.blockAt(new Vec3(Math.floor(x), ty, Math.floor(z)));
            const up1 = bot.blockAt(new Vec3(Math.floor(x), ty + 1, Math.floor(z)));
            const up2 = bot.blockAt(new Vec3(Math.floor(x), ty + 2, Math.floor(z)));
            if (at?.boundingBox === "block" && up1?.name === "air" && up2?.name === "air") ty += 1;
            await gotoGoal(host, ctl, new goals.GoalNear(Math.floor(x), ty, Math.floor(z), range));
        },

        /** Walk to a player. */
        goToPlayer: async (name, range = NEAR_RANGE) => {
            const bot = liveBot(host);
            const entity = findPlayerEntity(bot, name);
            await gotoGoal(host, ctl, new goals.GoalFollow(entity, range));
        },

        /** Follow a player until stop()/interrupt. Returns immediately. */
        followPlayer: async (name, range = 3) => {
            const bot = liveBot(host);
            const entity = findPlayerEntity(bot, name);
            bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
            // A follow goal outlives the script — make interrupts kill it,
            // or the old follow fights the next directive for the body.
            ctl.signal.addEventListener("abort", () => {
                try { bot.pathfinder.setGoal(null); } catch (e) { /* fine */ }
            }, { once: true });
        },

        /** Board the nearest matching rideable entity (boat, minecart,
         *  horse…) — walks over first if needed, verifies the mount took. */
        mount: async (name = "boat") => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            if (bot.vehicle) throw new Error("already riding something — dismount() first");
            const best = nearestEntityByName(bot, name);
            if (!best) {
                throw new Error(`no "${name}" entity nearby — query.entities("${name}") to see what's actually around`);
            }
            const bestD = best.position.distanceTo(bot.entity.position);
            if (bestD > 3) {
                await gotoGoal(host, ctl, new goals.GoalNear(best.position.x, best.position.y, best.position.z, 2));
            }
            throwIfAborted(ctl);
            bot.mount(best);
            for (let i = 0; i < 10 && !bot.vehicle; i++) await wait(ctl, 200);
            if (!bot.vehicle) {
                throw new Error(`mounting the ${best.name || name} did not take — it may be occupied, or drifted out of reach`);
            }
            return { mounted: best.name || name };
        },

        /** Get off whatever we're riding. Safe to call when not riding. */
        dismount: async () => {
            const bot = liveBot(host);
            if (!bot.vehicle) return { dismounted: false, note: "not riding anything" };
            bot.dismount();
            for (let i = 0; i < 10 && bot.vehicle; i++) await wait(ctl, 200);
            if (bot.vehicle) throw new Error("could not dismount — try moveAway() or botCall(\"dismount\")");
            return { dismounted: true };
        },

        /** Full-body stop: movement, combat, digging, item use, controls. */
        stop: async () => {
            const bot = liveBot(host);
            try { bot.pathfinder.setGoal(null); } catch (e) { /* fine */ }
            try { bot.pvp.stop(); } catch (e) { /* fine */ }
            try { bot.stopDigging(); } catch (e) { /* fine */ }
            try { bot.deactivateItem(); } catch (e) { /* fine */ }
            try { bot.clearControlStates(); } catch (e) { /* fine */ }
        },

        /** Escape underground: pathfind upward in steps — digging what the
         *  current tools allow, scaffolding with inventory blocks — and
         *  shift sideways when the column above is blocked, until open sky.
         *  THE way out of caves, holes and enclosures; replaces the
         *  hopeless pattern of hand-rolled pillar/bridge micro-plans. */
        surface: async () => {
            const bot = liveBot(host);
            let lastError = null;
            for (let round = 0; round < 6; round++) {
                throwIfAborted(ctl);
                const pos = bot.entity.position.floored();
                let open = true;
                for (let y = pos.y + 2; y <= Math.min(pos.y + 48, 320); y++) {
                    const b = bot.blockAt(new Vec3(pos.x, y, pos.z));
                    if (b && b.boundingBox === "block") { open = false; break; }
                }
                if (open) return { surfaced: true, at: { x: pos.x, y: pos.y, z: pos.z } };
                try {
                    await gotoGoal(host, ctl, new goals.GoalY(Math.min(pos.y + 12, 100)));
                } catch (e) {
                    if (ctl.signal.aborted) throw e;
                    lastError = e;
                    // This column won't rise — sidestep and try another.
                    try {
                        await skills.moveAway(10);
                    } catch (e2) {
                        if (ctl.signal.aborted) throw e2;
                    }
                }
            }
            throw new Error("couldn't reach open sky from here"
                + (lastError ? ` (last obstacle: ${lastError.message})` : "")
                + " — the rock above may need a pickaxe I don't have; craft/fetch one, or query.map({view:\"cross\"}) to find a cave route");
        },

        /** Relocate a random-ish distance away — the recovery move when a
         *  search came up empty ("no oak_log within 64 blocks"). */
        moveAway: async (distance = 20) => {
            const bot = liveBot(host);
            const d = Math.min(Math.max(5, distance | 0 || 20), 64);
            const pos = bot.entity.position;
            for (let attempt = 0; attempt < 8; attempt++) {
                throwIfAborted(ctl);
                const angle = Math.random() * Math.PI * 2;
                const x = Math.floor(pos.x + Math.cos(angle) * d);
                const z = Math.floor(pos.z + Math.sin(angle) * d);
                try {
                    await gotoGoal(host, ctl, new goals.GoalXZ(x, z));
                    return;
                } catch (e) {
                    if (ctl.signal.aborted) throw e;
                    /* unreachable direction — spin again */
                }
            }
            throw new Error(`couldn't find a walkable direction ${d} blocks away`);
        },

        /** Collect `count` of a block type (finds, walks, mines with the
         *  right tool, picks up drops). */
        collect: async (blockName, count = 1) => {
            const bot = liveBot(host);
            const ids = sourceBlockIds(bot, blockName);
            const wanted = Math.min(Math.max(1, count | 0), 64);
            // Track the actual ITEM arriving in inventory — the collect
            // plugin silently no-ops when the tool can't harvest, so "I ran
            // N times" is NOT "I have N items" (airi's worst-bug lesson).
            const itemName = normalizeName(blockName);
            const countItem = () => bot.inventory.items()
                .reduce((n, i) => n + (i.name === itemName ? i.count : 0), 0);
            const trackable = !!bot.registry.itemsByName?.[itemName];
            // Protected blocks — chests, beds, furnaces, the user's things —
            // are in the pathfinder's no-break list, and collectBlock shares
            // those movements. It therefore REFUSES to break one, silently,
            // and the verification below reports "gathered 0" with a guess
            // about tools or a full inventory. That guess sent the bot round
            // the same loop forever. These are made, not mined: say so.
            const noBreak = bot.collectBlock?.movements?.blocksCantBreak;
            if (ids.length && noBreak?.size && ids.every((id) => noBreak.has(id))) {
                throw new Error(`${blockName} is protected from mining — breaking one is never allowed (it may be the user's). `
                    + `Make it instead: query.recipePlan("${itemName}") gives the recipe, then craft("${itemName}")`);
            }
            // Stone-class trap: the block exists but drops something ELSE
            // (stone → cobblestone, grass_block → dirt). The inventory
            // verification could never pass — fail up-front with the real
            // conversion path instead of a misleading "wrong tool?".
            if (trackable) {
                const itemId = bot.registry.itemsByName[itemName].id;
                const dropsWanted = ids.some((id) => bot.registry.blocks[id]?.drops?.includes(itemId));
                if (!dropsWanted) {
                    const dropName = bot.registry.items[bot.registry.blocks[ids[0]]?.drops?.[0]]?.name;
                    throw new Error(dropName
                        ? `mining ${blockName} drops ${dropName}, never ${itemName} itself — collect("${dropName}") and see query.recipePlan("${itemName}") to convert it`
                        : `mining ${blockName} drops nothing without silk touch — see query.recipePlan("${itemName}") for how to obtain it`);
                }
            }
            let gathered = 0;
            let consecutiveFailures = 0;
            for (let i = 0; i < wanted * 2 && gathered < wanted; i++) {
                throwIfAborted(ctl);
                if (bot.inventory.emptySlotCount() === 0) {
                    throw new Error(`inventory is FULL (gathered ${gathered}x ${blockName} so far) — deposit or discard something first`);
                }
                // Target stickiness across turns: every new script re-picks
                // "nearest", which drifts to a different block each turn and
                // cancels the path already in flight. Keep working the same
                // one while it is still valid.
                let block = null;
                const sticky = host._collectSticky;
                if (sticky && sticky.name === blockName && Date.now() - sticky.at < 60000) {
                    const b = bot.blockAt(sticky.pos);
                    if (b && ids.includes(b.type)) block = b;
                }
                if (!block) block = bot.findBlock({ matching: ids, maxDistance: 64 });
                if (!block) {
                    host._collectSticky = null;
                    // This route came up empty — future plans price it higher.
                    noteAcquisitionFailure(host, "gather", normalizeName(blockName), normalizeName(blockName));
                    throw new Error(`no ${blockName} (or any block that drops it) found within 64 blocks (gathered ${gathered} so far) — try moveAway(30) and search again`);
                }
                host._collectSticky = { name: blockName, pos: block.position, at: Date.now() };
                // Tool gate: equip the right tool, then verify we can
                // actually harvest — digging unharvestable blocks wastes
                // time and yields nothing.
                try { await bot.tool.equipForBlock(block); } catch (e) { /* bare hands */ }
                if (!block.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
                    const toolIds = Object.keys(block.harvestTools || {});
                    const toolName = toolIds.length
                        ? (bot.registry.items[toolIds[0]]?.name || "a better tool")
                        : "a better tool";
                    // The tool-progression lesson belongs HERE, at the one
                    // moment it is true, rather than in every prompt: the
                    // model used to treat a missing tool as a dead end.
                    throw new Error(`cannot harvest ${block.name} with current tools — need ${toolName}: craft it now and retry (query.recipePlan("${toolName}")). The lowest tier that works is enough — a wooden pickaxe already mines stone and cobblestone`);
                }
                const before = trackable ? countItem() : 0;
                const onAbort = () => { try { bot.collectBlock.cancelTask(); } catch (e) { /* fine */ } };
                ctl.signal.addEventListener("abort", onAbort);
                try {
                    if (needsManualPickup(block.name)) {
                        // The collectBlock plugin silently no-ops on crops,
                        // saplings, torches and flowers — dig by hand and
                        // sweep the drops instead.
                        await gotoGoal(host, ctl, new goals.GoalNear(
                            block.position.x, block.position.y, block.position.z, 2));
                        throwIfAborted(ctl);
                        const fresh = bot.blockAt(block.position);
                        if (fresh && ids.includes(fresh.type)) await bot.dig(fresh);
                        await sweepDrops(host, ctl, { radius: 4, deadlineMs: 2500, graceMs: 600 });
                    } else {
                        await bot.collectBlock.collect(block);
                    }
                    consecutiveFailures = 0;
                } catch (e) {
                    if (ctl.signal.aborted) throw new AbortError();
                    consecutiveFailures += 1;
                    // Two strikes was too few for an ABUNDANT resource: a
                    // pair of path blips on a forest full of trees ended the
                    // gather, and the model then went hunting for wood types
                    // that don't exist in the biome.
                    if (consecutiveFailures >= 4) {
                        noteAcquisitionFailure(host, "gather", normalizeName(blockName), block.name);
                        throw new Error(`collecting ${blockName} keeps failing: ${e.message} (gathered ${gathered} so far)`);
                    }
                    continue;   // transient (path blip, block vanished) — try the next one
                } finally {
                    ctl.signal.removeEventListener("abort", onAbort);
                }
                if (trackable) {
                    const after = countItem();
                    if (after > before) {
                        gathered += after - before;
                    } else {
                        // Mined but nothing arrived — sweep drops once, then
                        // recount before declaring divergence.
                        await sweepDrops(host, ctl, { radius: 6, deadlineMs: 2500, graceMs: 800 });
                        const swept = countItem();
                        if (swept > before) gathered += swept - before;
                        else throw new Error(`mined ${block.name} but no ${itemName} reached the inventory (wrong tool? full inventory?) — gathered ${gathered} so far`);
                    }
                } else {
                    gathered += 1;   // untrackable item id — trust the plugin
                }
            }
            if (gathered < wanted) {
                throw new Error(`only gathered ${gathered}/${wanted} ${blockName}`);
            }
        },

        /** Pick up dropped item entities lying on the ground (walks to
         *  each; pickup happens on proximity). itemName filters what to
         *  grab; null grabs everything nearby. Dropped items despawn after
         *  5 minutes — hurry after a death. */
        pickup: async (itemName = null, radius = 16) => {
            const want = itemName ? itemByName(host, itemName).name : null;
            const r = Math.min(Math.max(2, radius | 0 || 16), 32);
            const collected = await sweepDrops(host, ctl, { want, radius: r, deadlineMs: 10000, graceMs: 1500 });
            if (!collected) {
                throw new Error(want
                    ? `no dropped ${want} within ${r} blocks (dropped items despawn after 5 minutes)`
                    : `no dropped items within ${r} blocks`);
            }
            return { collected };
        },

        /** Mine the specific block at coordinates. */
        mineAt: async (x, y, z) => {
            const bot = liveBot(host);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            const block = bot.blockAt(pos);
            if (!block || block.name === "air") throw new Error(`no block at ${pos} (it's ${block?.name || "unloaded"})`);
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
            }
            throwIfAborted(ctl);
            try { await bot.tool.equipForBlock(block); } catch (e) { /* dig bare-handed */ }
            const target = bot.blockAt(pos);
            if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
                const toolIds = Object.keys(target.harvestTools || {});
                const toolName = toolIds.length ? (bot.registry.items[toolIds[0]]?.name || "a better tool") : "a better tool";
                throw new Error(`cannot harvest ${target.name} with current tools — need ${toolName}: craft it now and retry (query.recipePlan("${toolName}"))`);
            }
            // Reach guard: past ~4.6 blocks eye-to-centre the server rejects
            // every swing and bot.dig grinds at air until the script budget
            // dies. Fail fast with the real reason instead.
            const reach = eyeDistanceTo(bot, pos);
            if (reach > DIG_REACH) {
                throw new Error(`(${pos.x}, ${pos.y}, ${pos.z}) is ${reach.toFixed(1)} blocks away — out of reach (max ${DIG_REACH}). goTo closer, or clear what's blocking the approach`);
            }
            await bot.dig(target);
            // Verify: laggy servers occasionally ghost the dig — check and re-dig once.
            const after = bot.blockAt(pos);
            if (after && after.name === target.name) {
                await bot.dig(after).catch(() => {});
            }
            await sweepDrops(host, ctl, { radius: 5, deadlineMs: 3000, graceMs: 1000 });
        },

        /** Toss items onto the ground in front of you — "drop some
         *  cobblestone", "get rid of the dirt". count=-1 means all. This,
         *  not placeAt, is how items leave the inventory loose. */
        drop: async (itemName, count = 1) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            const have = bot.inventory.items()
                .filter((i) => i.name === def.name)
                .reduce((n, i) => n + i.count, 0);
            if (!have) throw new Error(`no ${itemName} in inventory`);
            const wanted = count === -1 ? have : Math.min(Math.max(1, count | 0), have);
            let tossed = 0;
            while (tossed < wanted) {
                throwIfAborted(ctl);
                const stack = invItem(bot, def.name);
                if (!stack) break;
                const n = Math.min(wanted - tossed, stack.count);
                await bot.toss(def.id, null, n);
                tossed += n;
                await wait(ctl, 150);   // server needs a beat between stack tosses
            }
            return { dropped: tossed };
        },

        /** Place a block from inventory at coordinates (needs an adjacent
         *  solid block to place against). BLOCKS ONLY — dropping items on
         *  the ground is drop(). */
        placeAt: async (itemName, x, y, z) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            // Seeds, crops, redstone dust and buckets place a block with a
            // DIFFERENT id than the item — without the map they all read as
            // "not placeable" and no crop could ever be planted.
            const placesAs = ITEM_PLACES_BLOCK[def.name];
            // Steering error: tools/food/ingots aren't placeable, and the
            // model reaches for placeAt when it means drop.
            if (!placesAs && !bot.registry.blocksByName[def.name]) {
                throw new Error(`${def.name} is not a placeable block — to put items on the ground use drop("${def.name}", count)`);
            }
            // Crops go ON farmland: till the dirt with a hoe first
            // (useOnBlock("iron_hoe", x, y-1, z)), or the seed pops straight
            // back out.
            if (placesAs && /wheat|beetroot|carrot|potato|melon|pumpkin/.test(placesAs)) {
                const below = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) - 1, Math.floor(z)));
                if (below && below.name !== "farmland") {
                    throw new Error(`${def.name} needs farmland underneath (found ${below.name}) — till it first with useOnBlock("<a hoe>", ${Math.floor(x)}, ${Math.floor(y) - 1}, ${Math.floor(z)})`);
                }
            }
            const item = invItem(bot, def.name);
            if (!item) throw new Error(`no ${itemName} in inventory`);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE + 1));
            }
            // Ground cover counts as empty — refusing to build on grass made
            // most of the overworld unbuildable.
            const target = bot.blockAt(pos);
            if (target && !PASSABLE.has(target.name)) {
                throw new Error(`${pos} is occupied by ${target.name} (mineAt it first)`);
            }
            // Step out of the target space — placing into your own feet/head
            // silently fails. Small attachables are fine to place underfoot.
            const DONT_MOVE_FOR = new Set(["torch", "redstone_torch", "lever", "rail",
                "powered_rail", "detector_rail", "tripwire_hook", "redstone_wire"]);
            const feet = bot.entity.position;
            if (!DONT_MOVE_FOR.has(def.name)
                && Math.abs(feet.x - (pos.x + 0.5)) < 0.9
                && Math.abs(feet.z - (pos.z + 0.5)) < 0.9
                && pos.y >= Math.floor(feet.y) - 1 && pos.y <= Math.floor(feet.y) + 1) {
                await gotoGoal(host, ctl, new goals.GoalInvert(
                    new goals.GoalNear(pos.x, pos.y, pos.z, 2)));
            }
            const faces = [
                new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0),
                new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1),
            ];
            let ref = null, face = null;
            for (const f of faces) {
                const b = bot.blockAt(pos.plus(f));
                if (b && b.boundingBox === "block") { ref = b; face = f.scaled(-1); break; }
            }
            if (!ref) throw new Error(`nothing solid adjacent to ${pos} to place against`);
            throwIfAborted(ctl);
            await equipConfirmed(host, ctl, def.name);
            // placeBlock waits for a confirming block_update that laggy
            // servers often deliver late or not at all — the block is
            // frequently placed anyway. Verify reality before failing, and
            // give it one retry.
            for (let attempt = 0; ; attempt++) {
                try {
                    await bot.placeBlock(ref, face);
                    return;
                } catch (e) {
                    if (ctl.signal.aborted) throw new AbortError();
                    await wait(ctl, 400);
                    const now = bot.blockAt(pos);
                    if (now && !PASSABLE.has(now.name)) return;   // it landed
                    if (attempt >= 1) {
                        throw new Error(`placing ${def.name} at ${pos} failed twice (${e.message}) — try a different spot`);
                    }
                    // The block may have been consumed (bucket, seeds) —
                    // re-equip rather than swinging an empty hand.
                    try { await equipConfirmed(host, ctl, def.name); } catch (e2) { throw e; }
                }
            }
        },

        /** Craft `count` of an item. Uses a nearby crafting table when the
         *  recipe needs one (walks to it); 2x2 recipes work anywhere. */
        craft: async (itemName, count = 1) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            const wanted = Math.min(Math.max(1, count | 0), 64);
            let table = null;
            let recipes = bot.recipesFor(def.id, null, 1, null);
            if (!recipes.length) {
                const tableDef = blockByName(host, "crafting_table");
                table = bot.findBlock({ matching: tableDef.id, maxDistance: 32 });
                // Autonomy: a table in the pocket is as good as one in the
                // world — place it instead of failing.
                if (!table && invItem(bot, "crafting_table")) {
                    const spot = nearestFreeSpace(bot, 8);
                    if (spot) {
                        await skills.placeAt("crafting_table", spot.x, spot.y, spot.z);
                        table = bot.findBlock({ matching: tableDef.id, maxDistance: 16 });
                    }
                }
                if (table) recipes = bot.recipesFor(def.id, null, 1, table);
                if (!recipes.length) {
                    throw new Error(
                        `cannot craft ${itemName}: missing ingredients`
                        + (table ? "" : " or no crafting_table within 32 blocks (craft one from 4 planks, or placeAt one you carry)"),
                    );
                }
                if (bot.entity.position.distanceTo(table.position) > REACH_RANGE) {
                    await gotoGoal(host, ctl, new goals.GoalNear(table.position.x, table.position.y, table.position.z, NEAR_RANGE));
                }
            }
            throwIfAborted(ctl);
            // bot.craft's count is CRAFT OPERATIONS, not items: sticks yield
            // 4 per craft, so craft("stick", 4) must run ONE operation.
            const perCraft = recipes[0].result?.count ?? 1;
            await bot.craft(recipes[0], Math.ceil(wanted / perCraft), table || undefined);
        },

        /** Equip an item. Destination is inferred from the name when
         *  omitted (helmet→head, shield→off-hand, …) — armor in the main
         *  hand was a real failure mode. */
        equip: async (itemName, destination = null) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            const item = invItem(bot, def.name);
            if (!item) throw new Error(`no ${itemName} in inventory`);
            let dest = destination;
            if (!dest) {
                if (def.name.endsWith("_helmet")) dest = "head";
                else if (def.name.endsWith("_chestplate") || def.name === "elytra") dest = "torso";
                else if (def.name.endsWith("_leggings")) dest = "legs";
                else if (def.name.endsWith("_boots")) dest = "feet";
                else if (def.name === "shield") dest = "off-hand";
                else dest = "hand";
            }
            throwIfAborted(ctl);
            await bot.equip(item, dest);
        },

        /** Eat/drink an inventory item. */
        consume: async (itemName) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            const item = invItem(bot, def.name);
            if (!item) throw new Error(`no ${itemName} in inventory`);
            // Edibility check FIRST: mineflayer's consume waits for a
            // "finished eating" packet that never comes for a non-food, so
            // eating a log burned 13 seconds and returned the useless
            // "Promise timed out." Fail instantly with the real reason.
            const foods = bot.registry.foodsByName || {};
            const DRINKABLE = /potion|milk_bucket|honey_bottle/;
            if (!foods[def.name] && !DRINKABLE.test(def.name)) {
                throw new Error(`${def.name} is not food or drink — you cannot consume it`
                    + (bot.registry.blocksByName?.[def.name] ? " (it's a block: placeAt or craft with it)" : ""));
            }
            throwIfAborted(ctl);
            await equipConfirmed(host, ctl, def.name);
            try {
                await bot.consume();
            } catch (e) {
                if (/timed out/i.test(e.message || "")) {
                    throw new Error(`eating ${def.name} never completed (the server didn't confirm it) — are you already full?`);
                }
                throw e;
            }
        },

        /** Walk to a player, toss items, and VERIFY they picked them up —
         *  a toss into a wall or their back is not a delivery. */
        give: async (playerName, itemName, count = 1) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            let remaining = Math.max(1, count | 0);
            const have = bot.inventory.items()
                .filter((i) => i.name === def.name)
                .reduce((n, i) => n + i.count, 0);
            if (!have) throw new Error(`no ${itemName} in inventory`);
            remaining = Math.min(remaining, have);
            const entity = findPlayerEntity(bot, playerName);
            await gotoGoal(host, ctl, new goals.GoalFollow(entity, NEAR_RANGE));
            throwIfAborted(ctl);
            await bot.lookAt(entity.position.offset(0, 1, 0));
            const received = new Promise((resolve) => {
                const timer = setTimeout(() => { cleanup(); resolve(false); }, 4000);
                const onCollect = (collector) => {
                    if (collector?.username === playerName) { cleanup(); resolve(true); }
                };
                const cleanup = () => { clearTimeout(timer); bot.removeListener("playerCollect", onCollect); };
                bot.on("playerCollect", onCollect);
            });
            // Multi-stack: toss loops until the requested count is out.
            let tossed = 0;
            while (tossed < remaining) {
                const stack = invItem(bot, def.name);
                if (!stack) break;
                const n = Math.min(remaining - tossed, stack.count);
                await bot.toss(def.id, null, n);
                tossed += n;
            }
            if (!(await received)) {
                throw new Error(`tossed ${tossed}x ${itemName} but ${playerName} didn't pick it up — it's on the ground near them`);
            }
        },

        /** Deposit items into the chest at coordinates. `items` like
         *  [{name:"cobblestone", count:64}]; omit to deposit everything. */
        depositAt: async (x, y, z, items = null) => {
            const bot = liveBot(host);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            const block = bot.blockAt(pos);
            if (!block || !/chest|barrel|shulker/.test(block.name)) {
                throw new Error(`no chest at ${pos} (found ${block?.name || "nothing"})`);
            }
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
            }
            throwIfAborted(ctl);
            const chest = await bot.openContainer(block);
            let depositError = null;
            try {
                // "Deposit everything" must not strip the bot naked: keep
                // armor, weapons and tools out of the auto-dump.
                const KEEP = /(_helmet|_chestplate|_leggings|_boots|_sword|_axe|_pickaxe|_shovel|_hoe|shield)$/;
                const list = items || bot.inventory.items()
                    .filter((i) => !KEEP.test(i.name))
                    .map((i) => ({ name: i.name, count: i.count }));
                for (const entry of list) {
                    const def = itemByName(host, entry.name);
                    const have = bot.inventory.items()
                        .filter((i) => i.name === def.name)
                        .reduce((n, i) => n + i.count, 0);
                    const n = Math.min(entry.count || have, have);
                    if (n > 0) await chest.deposit(def.id, null, n);
                }
            } catch (e) {
                depositError = e;
            } finally {
                // The real error outranks a failing close().
                try { chest.close(); } catch (e) { /* ignore */ }
            }
            if (depositError) throw depositError;
        },

        /** Withdraw items from the chest at coordinates. */
        withdrawAt: async (x, y, z, items) => {
            const bot = liveBot(host);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            const block = bot.blockAt(pos);
            if (!block || !/chest|barrel|shulker/.test(block.name)) {
                throw new Error(`no chest at ${pos} (found ${block?.name || "nothing"})`);
            }
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
            }
            throwIfAborted(ctl);
            const chest = await bot.openContainer(block);
            let withdrawError = null;
            try {
                for (const entry of items || []) {
                    const def = itemByName(host, entry.name);
                    const available = chest.containerItems()
                        .filter((i) => i.name === def.name)
                        .reduce((n, i) => n + i.count, 0);
                    if (!available) throw new Error(`the chest has no ${entry.name}`);
                    await chest.withdraw(def.id, null, Math.min(entry.count || available, available));
                }
            } catch (e) {
                withdrawError = e;
            } finally {
                try { chest.close(); } catch (e) { /* ignore */ }
            }
            if (withdrawError) throw withdrawError;
        },

        /** Smelt/cook in a furnace: finds one within 32 blocks (or places
         *  one from inventory), fuels it from inventory coal/charcoal, and
         *  waits for the output. `itemName` is the INPUT (e.g. "raw_iron",
         *  "beef", "sand"). Adapted from airi's smeltItem. */
        smelt: async (itemName, count = 1) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            const num = Math.min(Math.max(1, count | 0), 64);
            const have = invItem(bot, def.name);
            if (!have || have.count < num) {
                throw new Error(`need ${num}x ${itemName} in inventory to smelt (have ${have?.count || 0})`);
            }
            const furnaceDef = blockByName(host, "furnace");
            let placedFurnace = false;
            let furnaceBlock = bot.findBlock({ matching: furnaceDef.id, maxDistance: 32 });
            if (!furnaceBlock) {
                if (!invItem(bot, "furnace")) {
                    throw new Error("no furnace within 32 blocks and none in inventory — craft one (8 cobblestone) or find one");
                }
                const spot = nearestFreeSpace(bot, 8);
                if (!spot) throw new Error("could not find a clear spot to place the furnace");
                await skills.placeAt("furnace", spot.x, spot.y, spot.z);
                placedFurnace = true;
                furnaceBlock = bot.findBlock({ matching: furnaceDef.id, maxDistance: 16 });
                if (!furnaceBlock) throw new Error("placed a furnace but lost track of it");
            }
            if (bot.entity.position.distanceTo(furnaceBlock.position) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(
                    furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, NEAR_RANGE));
            }
            throwIfAborted(ctl);
            const furnace = await bot.openFurnace(bot.blockAt(furnaceBlock.position));
            try {
                const inputItem = furnace.inputItem();
                if (inputItem && inputItem.type !== def.id && inputItem.count > 0) {
                    throw new Error(`the furnace is busy smelting ${inputItem.name}`);
                }
                if (!furnace.fuelItem() && furnace.fuel <= 0) {
                    const fuel = bot.inventory.items().find(
                        (i) => i.name === "coal" || i.name === "charcoal" || i.name === "blaze_rod");
                    const fuelNeeded = Math.ceil(num / 8);
                    if (!fuel || fuel.count < fuelNeeded) {
                        throw new Error(`no fuel: need ${fuelNeeded}x coal/charcoal in inventory`);
                    }
                    await furnace.putFuel(fuel.type, null, fuelNeeded);
                }
                await furnace.putInput(def.id, null, num);
                // ~10s per item; poll the output, abortable. Two-strike
                // drain detection: "input empty + output empty" races the
                // last item's completion, so only break after seeing it in
                // two consecutive rounds with nothing collected between.
                let collected = 0;
                let emptyStrikes = 0;
                const deadline = Date.now() + num * 12000 + 5000;
                while (collected < num && Date.now() < deadline) {
                    await wait(ctl, 3000);
                    if (furnace.outputItem()) {
                        const out = await furnace.takeOutput();
                        if (out) { collected += out.count; emptyStrikes = 0; }
                    } else if (!furnace.inputItem()) {
                        emptyStrikes += 1;
                        if (emptyStrikes >= 2) break;
                    }
                }
                if (collected < num) {
                    throw new Error(`smelting stalled: got ${collected}/${num} (check fuel)`);
                }
            } finally {
                try { furnace.close(); } catch (e) { /* fine */ }
                // A furnace we placed for this job is worth taking back —
                // best-effort only, never masking a smelt error.
                if (placedFurnace) {
                    try {
                        const temp = bot.blockAt(furnaceBlock.position);
                        if (temp?.name === "furnace") await bot.collectBlock.collect(temp);
                    } catch (e) { /* leave it — not worth failing over */ }
                }
            }
        },

        /** Attack the nearest entity whose name matches (e.g. "zombie").
         *  Resolves when the target dies/disappears. */
        attack: async (entityName) => {
            const bot = liveBot(host);
            if (entityName === "creeper" || entityName === "phantom") {
                throw new Error(`melee on a ${entityName} is suicide (it explodes/dives) — keep your distance or let it wander off`);
            }
            const pos = bot.entity.position;
            let target = null, best = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (!e?.position || e === bot.entity) continue;
                const name = e.username || e.name || "";
                if (name !== entityName) continue;
                const d = e.position.distanceTo(pos);
                if (d > 48) continue;   // don't march across the world after a loaded-chunk ghost
                if (d < best) { best = d; target = e; }
            }
            if (!target) throw new Error(`no "${entityName}" within 48 blocks to attack`);
            throwIfAborted(ctl);
            // Fight with a weapon, not whatever mining left in hand.
            const weapon = bestWeapon(bot);
            if (weapon) await bot.equip(weapon, "hand").catch(() => {});
            bot.pvp.attack(target);
            const started = Date.now();
            try {
                while (target.isValid && Date.now() - started < ATTACK_TIMEOUT_MS) {
                    await wait(ctl, 500);
                }
            } finally {
                try { bot.pvp.stop(); } catch (e) { /* fine */ }
            }
            if (target.isValid) throw new Error(`gave up attacking ${entityName} after ${ATTACK_TIMEOUT_MS / 1000}s`);
            // Loot: drops spawn a beat after the kill — sweep or the meat rots.
            const looted = await sweepDrops(host, ctl, { radius: 8, deadlineMs: 6000, graceMs: 1500 });
            return { killed: entityName, drops: looted };
        },

        /** Use/activate the block at coordinates: doors, levers, buttons,
         *  trapdoors, fence gates. */
        activate: async (x, y, z) => {
            const bot = liveBot(host);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            const block = bot.blockAt(pos);
            if (!block || block.name === "air") throw new Error(`nothing to activate at ${pos}`);
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
            }
            throwIfAborted(ctl);
            await bot.activateBlock(bot.blockAt(pos));
        },

        /** Drop a torch on the ground next to the bot — call every dozen
         *  blocks while mining so tunnels stay lit and mob-free. */
        placeTorch: async () => {
            const bot = liveBot(host);
            if (!invItem(bot, "torch")) throw new Error("no torches in inventory (craft: 1 stick + 1 coal makes 4)");
            // Already lit here? Don't carpet the tunnel in torches.
            const lit = bot.findBlock({
                matching: (b) => b && (b.name === "torch" || b.name === "wall_torch"),
                maxDistance: 6,
            });
            if (lit) return;   // quiet no-op — the spot is covered
            const base = bot.entity.position.floored();
            for (const off of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 0, 0]]) {
                const pos = base.offset(off[0], off[1], off[2]);
                const at = bot.blockAt(pos);
                const below = bot.blockAt(pos.offset(0, -1, 0));
                if (at?.name === "air" && below?.boundingBox === "block") {
                    try {
                        await skills.placeAt("torch", pos.x, pos.y, pos.z);
                        return;
                    } catch (e) { /* next spot */ }
                }
            }
            throw new Error("no clear ground nearby for a torch");
        },

        /** Right-click an ENTITY with an item (or bare hand). The single
         *  primitive behind breeding, taming, shearing, milking, saddling,
         *  leashing, dyeing and name tags — walks over, equips, verifies. */
        useOn: async (entityName, itemName = null) => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            const target = nearestEntityByName(bot, entityName);
            if (!target) {
                throw new Error(`no "${entityName}" nearby — query.entities("${entityName}") to see what's actually around`);
            }
            if (itemName) await equipConfirmed(host, ctl, itemName);
            if (target.position.distanceTo(bot.entity.position) > 3) {
                await gotoGoal(host, ctl, new goals.GoalNear(
                    target.position.x, target.position.y, target.position.z, 2));
            }
            throwIfAborted(ctl);
            if (!target.isValid) throw new Error(`the ${entityName} is gone`);
            await bot.lookAt(target.position.offset(0, target.height ? target.height / 2 : 0.5, 0));
            bot.useOn(target);
            await wait(ctl, 300);
            return { usedOn: target.name || entityName, with: itemName || "bare hand" };
        },

        /** Use the held/《itemName》 item on a BLOCK — the right-click that
         *  tills soil with a hoe, bone-meals a crop, lights a portal with
         *  flint and steel, empties a bucket, strips a log. */
        useOnBlock: async (itemName, x, y, z) => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
            }
            if (itemName) await equipConfirmed(host, ctl, itemName);
            const block = bot.blockAt(pos);
            if (!block) throw new Error(`no block loaded at ${pos}`);
            throwIfAborted(ctl);
            await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
            // Line-of-sight guard: if the raycast lands on something else,
            // we would right-click the wrong block (mindcraft's check).
            const cursor = bot.blockAtCursor?.(5);
            if (cursor && !cursor.position.equals(pos)) {
                throw new Error(`${cursor.name} at (${cursor.position.x}, ${cursor.position.y}, ${cursor.position.z}) is in the way — move or clear it first`);
            }
            await bot.activateBlock(block);
            await wait(ctl, 250);
            return { used: itemName || "bare hand", on: block.name };
        },

        /** Use an item on YOURSELF / in the air: eat manually, drink, throw
         *  an ender pearl, cast a fishing rod, raise a shield, fire a
         *  rocket. `seconds` holds it down (bow charge, shield block). */
        useItem: async (itemName, seconds = 0) => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            if (itemName) await equipConfirmed(host, ctl, itemName);
            bot.activateItem();
            const hold = Math.min(Math.max(0, Number(seconds) || 0), 30);
            if (hold) await wait(ctl, hold * 1000);
            bot.deactivateItem();
            return { used: itemName || "held item", heldFor: hold };
        },

        /** Fire a bow at the nearest matching mob — the answer to creepers
         *  and phantoms, which attack() refuses to melee. */
        shoot: async (entityName, charge = 1.2) => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            const target = nearestEntityByName(bot, entityName);
            if (!target) throw new Error(`no "${entityName}" in sight to shoot`);
            const weapon = invItem(bot, "bow") ? "bow" : (invItem(bot, "crossbow") ? "crossbow" : null);
            if (!weapon) throw new Error("no bow or crossbow in inventory");
            if (!invItem(bot, "arrow")) throw new Error("no arrows in inventory");
            await equipConfirmed(host, ctl, weapon);
            await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.9 : 1.2, 0), true);
            bot.activateItem();
            await wait(ctl, Math.min(Math.max(0.3, Number(charge) || 1.2), 3) * 1000);
            throwIfAborted(ctl);
            if (target.isValid) {
                await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.9 : 1.2, 0), true);
            }
            bot.deactivateItem();
            await wait(ctl, 200);
            return { shotAt: target.name || entityName, stillAlive: !!target.isValid };
        },

        /** Put a boat / minecart / armor stand / spawn egg into the world.
         *  placeAt only handles BLOCKS; these are entities. */
        placeVehicle: async (itemName, x = null, y = null, z = null) => {
            throwIfAborted(ctl);
            const bot = liveBot(host);
            const item = await equipConfirmed(host, ctl, itemName);
            let ref = null;
            if (x !== null) {
                const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
                if (bot.entity.position.distanceTo(pos) > REACH_RANGE) {
                    await gotoGoal(host, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, NEAR_RANGE));
                }
                ref = bot.blockAt(pos);
            } else {
                // Nearest surface in front: water for boats, ground otherwise.
                const base = bot.entity.position.floored();
                for (let r = 1; r <= 4 && !ref; r++) {
                    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
                        const b = bot.blockAt(base.offset(dx, -1, dz)) || null;
                        if (b && b.name !== "air" && b.name !== "cave_air") { ref = b; break; }
                    }
                }
            }
            if (!ref) throw new Error("nothing solid (or water) nearby to place it on — stand next to the spot first");
            await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true);
            await bot.placeEntity(ref, new Vec3(0, 1, 0));
            await wait(ctl, 400);
            return { placed: item.name, at: { x: ref.position.x, y: ref.position.y + 1, z: ref.position.z } };
        },

        /** Steer whatever you are riding. Boats/minecarts respond to this;
         *  a saddled mount needs steer=true plus a direction. forward/left
         *  are -1..1. Runs for `seconds`, then stops. */
        steer: async (forward = 1, left = 0, seconds = 3) => {
            const bot = liveBot(host);
            if (!bot.vehicle) throw new Error("not riding anything — mount() first");
            const f = Math.max(-1, Math.min(1, Number(forward) || 0));
            const l = Math.max(-1, Math.min(1, Number(left) || 0));
            const until = Date.now() + Math.min(Math.max(1, Number(seconds) || 3), 30) * 1000;
            while (Date.now() < until) {
                throwIfAborted(ctl);
                if (!bot.vehicle) break;
                try { bot.moveVehicle(l, f); } catch (e) { /* server may ignore */ }
                await wait(ctl, 100);
            }
            const p = bot.entity.position.floored();
            return { at: { x: p.x, y: p.y, z: p.z }, stillRiding: !!bot.vehicle };
        },

        /** Equip the best armor in inventory onto every slot. */
        equipArmor: async () => {
            const bot = liveBot(host);
            const RANK = ["leather", "golden", "chainmail", "iron", "diamond", "netherite"];
            const slots = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet" };
            let equipped = 0;
            for (const [piece, dest] of Object.entries(slots)) {
                let best = null, bestRank = -1;
                for (const item of bot.inventory.items()) {
                    if (!item.name.endsWith(`_${piece}`)) continue;
                    const rank = RANK.indexOf(item.name.split("_")[0]);
                    if (rank > bestRank) { bestRank = rank; best = item; }
                }
                if (best) {
                    throwIfAborted(ctl);
                    await bot.equip(best, dest);
                    equipped += 1;
                }
            }
            if (!equipped) throw new Error("no armor in inventory");
        },

        /** Sleep in a nearby bed (skips the night). Tries several beds —
         *  the nearest is often occupied (usually by the user), and only a
         *  "not night" failure means no other bed will help. */
        sleep: async () => {
            const bot = liveBot(host);
            const beds = bot.findBlocks({ matching: (b) => bot.isABed(b), maxDistance: 32, count: 8 })
                .map((p) => bot.blockAt(p))
                .filter(Boolean);
            if (!beds.length) throw new Error("no bed within 32 blocks");
            let lastError = null;
            for (const bed of beds) {
                throwIfAborted(ctl);
                try {
                    if (bed.getProperties?.().occupied) continue;
                } catch (e) { /* no properties — try it anyway */ }
                if (bot.entity.position.distanceTo(bed.position) > REACH_RANGE) {
                    try {
                        await gotoGoal(host, ctl, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, NEAR_RANGE));
                    } catch (e) {
                        if (ctl.signal.aborted) throw e;
                        lastError = e;
                        continue;
                    }
                }
                try {
                    await bot.sleep(bot.blockAt(bed.position));
                    return;   // lying down; mineflayer wakes us at dawn
                } catch (e) {
                    lastError = e;
                    if (/night|day/i.test(e.message || "")) {
                        throw new Error("can only sleep at night (or in a thunderstorm)");
                    }
                    /* occupied/obstructed/too far — next bed */
                }
            }
            throw new Error(`couldn't use any nearby bed (${lastError?.message || "all occupied"})`);
        },

        /** Look at a player (social presence — cheap and expressive). */
        lookAt: async (playerName) => {
            const bot = liveBot(host);
            const entity = findPlayerEntity(bot, playerName);
            await bot.lookAt(entity.position.offset(0, 1.6, 0));
        },
    };

    // Memoized per script run — enumerating ~1300 recipes is too slow to
    // repeat inside a loop.
    let craftableCache = null;

    const query = {
        /** Current self/world snapshot (position, health, players, entities…). */
        status: () => host.status(),
        /** Inventory as [{name, count}]. */
        inventory: () => host.inventory(),
        /** How many of an item we hold. */
        count: (itemName) => {
            const bot = liveBot(host);
            const wanted = normalizeName(itemName);
            return bot.inventory.items()
                .filter((i) => i.name === wanted)
                .reduce((n, i) => n + i.count, 0);
        },
        /** Do we hold at least n of an item? */
        has: (itemName, n = 1) => query.count(itemName) >= n,
        /** Nearby entities WITH GEOMETRY: [{name, username, type, pos,
         *  distance, isHostile}], nearest first. Filter by name/type
         *  ("zombie", "player") or omit for everything. This is how you
         *  find where things ARE — status() only gives counts. */
        entities: (nameOrType = null, maxDistance = 48) => {
            const bot = liveBot(host);
            const pos = bot.entity.position;
            const out = [];
            for (const e of Object.values(bot.entities || {})) {
                if (!e?.position || e === bot.entity || !e.isValid) continue;
                const d = e.position.distanceTo(pos);
                if (d > Math.min(maxDistance, 128)) continue;
                const name = e.username || e.name || "entity";
                if (nameOrType && name !== nameOrType && e.type !== nameOrType && e.name !== nameOrType) continue;
                const ex = Math.round(e.position.x), ey = Math.round(e.position.y), ez = Math.round(e.position.z);
                const record = {
                    name,
                    username: e.username || null,
                    type: e.type,
                    x: ex, y: ey, z: ez,          // both shapes — see findBlocks
                    pos: { x: ex, y: ey, z: ez },
                    distance: Math.round(d * 10) / 10,
                    isHostile: e.type === "hostile" || (typeof e.kind === "string" && /hostile/i.test(e.kind)),
                };
                // Detail that makes an animal a CHARACTER rather than a
                // target: is it a baby, is it tamed, is it someone's pet
                // with a name, what is it wearing, how hurt is it.
                try {
                    if (typeof e.health === "number") record.health = Math.round(e.health);
                    const custom = e.getCustomName?.();
                    const customName = custom?.toString?.() || (typeof custom === "string" ? custom : null);
                    if (customName) record.customName = customName;
                    const meta = Array.isArray(e.metadata) ? e.metadata : [];
                    if (meta.some((m) => m && typeof m === "object" && m.itemCount === undefined && m.baby === true)) record.baby = true;
                    const gear = (e.equipment || []).filter(Boolean).map((i) => i.name);
                    if (gear.length) record.equipment = gear;
                    if (e.vehicle) record.riding = true;
                    if (e.passengers?.length) record.carrying = e.passengers.length;
                } catch (err) { /* metadata shape varies by version */ }
                out.push(record);
            }
            return out.sort((a, b) => a.distance - b.distance).slice(0, 50);
        },
        /** What's AROUND me: distinct block types within radius, with the
         *  nearest occurrence of each — the exploration primitive ("what is
         *  here?" instead of guessing names). {ores:true} filters to ores. */
        nearbyBlocks: (radius = 24, { ores = false } = {}) => {
            const bot = liveBot(host);
            const positions = bot.findBlocks({
                matching: (b) => b && b.name !== "air" && b.name !== "cave_air"
                    && (!ores || b.name.endsWith("_ore") || b.name === "ancient_debris")
                    && (ores || b.boundingBox === "block"),
                maxDistance: Math.min(Math.max(4, radius | 0 || 24), 48),
                count: 800,
            });
            const pos = bot.entity.position;
            const byName = new Map();
            for (const p of positions) {
                const block = bot.blockAt(p);
                if (!block) continue;
                const d = p.distanceTo(pos);
                const entry = byName.get(block.name);
                if (!entry) byName.set(block.name, { name: block.name, count: 1, nearest: { x: p.x, y: p.y, z: p.z }, pos: { x: p.x, y: p.y, z: p.z }, distance: Math.round(d * 10) / 10 });
                else {
                    entry.count += 1;
                    if (d < entry.distance) {
                        entry.nearest = { x: p.x, y: p.y, z: p.z };
                        entry.pos = entry.nearest;
                        entry.distance = Math.round(d * 10) / 10;
                    }
                }
            }
            return [...byName.values()].sort((a, b) => a.distance - b.distance);
        },
        /** Everything craftable right now (with a nearby table if present).
         *  Optional substring filter ("pickaxe"). Memoized per script. */
        craftable: (substring = null) => {
            const bot = liveBot(host);
            if (!craftableCache) {
                const tableDef = bot.registry.blocksByName.crafting_table;
                const table = tableDef ? bot.findBlock({ matching: tableDef.id, maxDistance: 16 }) : null;
                craftableCache = [];
                for (const item of Object.values(bot.registry.items)) {
                    if (bot.recipesFor(item.id, null, 1, table).length) craftableCache.push(item.name);
                }
                craftableCache.sort();
            }
            return substring
                ? craftableCache.filter((n) => n.includes(normalizeName(substring)))
                : craftableCache;
        },
        /** Light level at a position (or under the bot). ≤7 spawns mobs —
         *  the reason torches exist. */
        lightLevel: (x = null, y = null, z = null) => {
            const bot = liveBot(host);
            const pos = x === null
                ? bot.entity.position.floored()
                : new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
            const block = bot.blockAt(pos);
            return block ? { light: block.light ?? null, skyLight: block.skyLight ?? null } : null;
        },
        /** Nearest matching blocks as records: [{name, pos, distance,
         *  diggable, solid}, …] — MAY BE EMPTY, always check .length before
         *  indexing. Accepts item names too — matches every block that
         *  drops the item ("cobblestone" finds stone, "diamond" finds both
         *  diamond ores; the record's name tells you which variant). */
        findBlocks: (blockName, maxDistance = 64, count = 5) => {
            const bot = liveBot(host);
            const ids = sourceBlockIds(bot, blockName);
            const pos = bot.entity.position;
            return bot
                .findBlocks({ matching: ids, maxDistance: Math.min(maxDistance, 128), count: Math.min(count, 32) })
                .map((p) => {
                    const b = bot.blockAt(p);
                    return {
                        name: b?.name || "unknown",
                        // BOTH shapes, always. The prompt promises entry.x
                        // and entry.pos.x are equally safe; only .pos was
                        // ever here, so activate(door.x, …) silently became
                        // activate(NaN, NaN, NaN) — no TypeError to learn
                        // from, just a call that could never work.
                        x: p.x, y: p.y, z: p.z,
                        pos: { x: p.x, y: p.y, z: p.z },
                        distance: Math.round(p.distanceTo(pos) * 10) / 10,
                        diggable: b?.diggable ?? null,
                        solid: b?.boundingBox === "block",
                    };
                });
        },
        /** Block record at coordinates (null when unloaded). */
        blockAt: (x, y, z) => {
            const bot = liveBot(host);
            const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
            return b ? { name: b.name, diggable: b.diggable, solid: b.boundingBox === "block" } : null;
        },
        /** ASCII map. query.map(16) or query.map({radius}) = top-down
         *  surface view (building, navigation, finding features/mobs).
         *  query.map({view:"cross", radius, yLevel, axis:"x"|"z"}) = a
         *  VERTICAL slice — the only way to see underground: caves show as
         *  gaps, lava as %, ores as $. Take one before digging down and
         *  every ~15 blocks of tunnel. */
        map: (opts = 16) => {
            const bot = liveBot(host);
            if (typeof opts === "number") return renderMap(bot, opts);
            if (opts && /^cross/.test(opts.view || "")) return renderCrossSection(bot, opts);
            return renderMap(bot, opts?.radius ?? 16);
        },
        /** Full acquisition plan for an item as readable text: gather →
         *  smelt → craft steps in dependency order, checked against the
         *  live inventory. Read this BEFORE any multi-step goal ("make an
         *  iron pickaxe") instead of discovering the tree by failing. */
        recipePlan: (itemName, count = 1) =>
            describePlan(liveBot(host), itemName, count, { fails: host._recipeFails || {} }),
        /** Can this item be crafted right now? Returns true/false. */
        canCraft: (itemName) => {
            const bot = liveBot(host);
            const def = itemByName(host, itemName);
            if (bot.recipesFor(def.id, null, 1, null).length) return true;
            const tableDef = blockByName(host, "crafting_table");
            const table = bot.findBlock({ matching: tableDef.id, maxDistance: 32 });
            return !!(table && bot.recipesFor(def.id, null, 1, table).length);
        },
        /** The ready-made structures you can build: [{name, size, contains}].
         *  Always look here before designing anything yourself. */
        designs: () => listDesigns(),
        /** A ready-made design as a blueprint anchored at (x, y, z) — the
         *  north-west corner of its footprint, on the level you stand on.
         *  Generic materials become what you actually carry (a spruce hut
         *  when you chopped spruce). Store the result as mem.blueprint and
         *  build it with the normal blueprintDiff loop. */
        design: (name, x, y, z) => buildDesign(liveBot(host), name, x, y, z),
        /** Diff a blueprint against the LIVE world — the building loop's
         *  source of truth. bp = {origin:{x,y,z}, levels:[{dy, grid}]} where
         *  grid[dz][dx] maps to (origin.x+dx, origin.y+dy, origin.z+dz);
         *  "air" = must be empty, null = don't care. Progress lives in the
         *  world itself: an interrupted build resumes by re-diffing, never
         *  by re-deriving coordinates. Returns what to place (sorted
         *  bottom-up), what to clear, and materials the inventory lacks. */
        blueprintDiff: (bp) => {
            const bot = liveBot(host);
            // Consulting the design means this script is building it — the
            // brain reads this instead of comparing goal wording.
            host._blueprintTouched = true;
            if (!bp || typeof bp !== "object" || !bp.origin || !Array.isArray(bp.levels)) {
                throw new Error('blueprintDiff needs {origin:{x,y,z}, levels:[{dy, grid:[["block_name",...],...]}]} — design it once and store it as mem.blueprint');
            }
            const { x: ox, y: oy, z: oz } = bp.origin;
            if (![ox, oy, oz].every(Number.isFinite)) throw new Error("blueprint origin must be numeric {x, y, z}");
            const AIR_LIKE = PASSABLE;
            const resolved = new Map();   // raw cell text → canonical block name
            const place = [], clear = [];
            let total = 0, correct = 0, unloaded = 0;
            for (let li = 0; li < bp.levels.length; li++) {
                const level = bp.levels[li] || {};
                const dy = Number.isFinite(level.dy) ? level.dy : li;
                if (!Array.isArray(level.grid)) throw new Error(`blueprint level ${li} has no grid — expected grid:[["block_name",...],...]`);
                for (let dz = 0; dz < level.grid.length; dz++) {
                    const row = level.grid[dz] || [];
                    for (let dx = 0; dx < row.length; dx++) {
                        const cell = row[dx];
                        if (cell === null || cell === undefined || cell === "") continue;
                        let wanted = resolved.get(cell);
                        if (!wanted) {
                            wanted = normalizeName(cell) === "air" ? "air" : blockByName(host, cell).name;
                            resolved.set(cell, wanted);
                        }
                        total += 1;
                        if (total > 4000) throw new Error("blueprint too large (over 4000 cells) — build it in sections");
                        const x = ox + dx, y = oy + dy, z = oz + dz;
                        const b = bot.blockAt(new Vec3(x, y, z));
                        if (!b) { unloaded += 1; continue; }
                        const isAir = AIR_LIKE.has(b.name);
                        if (wanted === "air") {
                            if (isAir) correct += 1;
                            // Both shapes on purpose: findBlocks/entities
                            // return `.pos`, so a model that has just used
                            // those reaches for p.pos.x here and got
                            // "Cannot read properties of undefined". Cheap
                            // to satisfy either guess.
                            else clear.push({ found: b.name, x, y, z, pos: { x, y, z } });
                        } else if (b.name === wanted || SAME_AS[wanted]?.has(b.name)) {
                            correct += 1;
                        } else {
                            place.push({ name: wanted, x, y, z, pos: { x, y, z }, found: isAir ? "air" : b.name });
                        }
                    }
                }
            }
            place.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);   // lower levels first
            const missing = {};
            for (const p of place) missing[p.name] = (missing[p.name] || 0) + 1;
            for (const name of Object.keys(missing)) {
                missing[name] = Math.max(0, missing[name] - query.count(name));
                if (!missing[name]) delete missing[name];
            }
            return {
                complete: total > 0 && correct === total,
                percent: total ? Math.round((correct / total) * 100) : 0,
                total,
                correct,
                // One turn's worth of work. The batch is the ONLY thing
                // pacing a build now, so it is sized to finish a shelter in
                // a handful of turns rather than twenty. (The counts were
                // also out of step with the slices, under-reporting what
                // was left.)
                place: place.slice(0, DIFF_PLACE_MAX),
                place_remaining: Math.max(0, place.length - DIFF_PLACE_MAX),
                clear: clear.slice(0, DIFF_CLEAR_MAX),
                clear_remaining: Math.max(0, clear.length - DIFF_CLEAR_MAX),
                missing_materials: missing,
                unloaded_cells: unloaded,   // > 0 → walk to the site and re-diff
            };
        },
    };

    /** Escape hatch: call any bot.* method the skill library doesn't cover
     *  (lookAt, setControlState, activateItem, swingArm…). Denylist blocks
     *  connection/event tampering; {x,y,z} args auto-upgrade to Vec3.
     *  Results that can't serialize come back null. Adapted from airi's
     *  botCall, plus abort-awareness it lacked. */
    const BOTCALL_DENY = new Set(["end", "quit", "connect", "on", "once", "off",
        "addListener", "removeListener", "removeAllListeners", "emit", "prependListener"]);
    const botCall = async (method, args = []) => {
        throwIfAborted(ctl);
        const bot = liveBot(host);
        const name = String(method);
        if (BOTCALL_DENY.has(name) || name.includes(".")) {
            throw new Error(`botCall: "${name}" is not allowed (no connection/event methods, no dot-paths)`);
        }
        if (typeof bot[name] !== "function") {
            throw new Error(`botCall: bot.${name} is not a function`);
        }
        const marshalled = (Array.isArray(args) ? args : []).map((a) =>
            (a && typeof a === "object" && typeof a.x === "number" && typeof a.y === "number" && typeof a.z === "number")
                ? new Vec3(a.x, a.y, a.z) : a);
        const result = await bot[name](...marshalled);
        try { return structuredClone(result); } catch (e) {
            try { return JSON.parse(JSON.stringify(result)); } catch (e2) { return null; }
        }
    };

    return {
        ...skills,
        botCall,
        query,
        wait: (ms) => wait(ctl, ms),
        log: (...args) => io.log(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
        notify: (headline, urgency = "normal") => io.notify(String(headline), urgency),
        done: (summary) => io.done(String(summary || "")),
    };
}

module.exports = { buildRuntime, AbortError };
