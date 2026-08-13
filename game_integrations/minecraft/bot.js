// Mineflayer bot lifecycle: connection, plugins, reconnect, and the status
// snapshot the brain and the server both consume. No LLM logic here — the
// brain drives everything through skills.js.
"use strict";

const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const collectBlock = require("mineflayer-collectblock").plugin;
const pvp = require("mineflayer-pvp").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

// The player's furniture. The pathfinder prices any block as a 1-cost
// obstacle when canDig is on, so without this it will happily tunnel
// through a bed, a chest or the base furnace on its way somewhere — the
// single most unforgivable thing a companion can do in a shared world.
// (Both mindcraft and mc-agent-neko learned this by destroying their own.)
const NEVER_BREAK = [
    "white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed",
    "lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed",
    "purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed",
    "chest", "trapped_chest", "ender_chest", "barrel", "shulker_box",
    "crafting_table", "furnace", "blast_furnace", "smoker", "anvil",
    "chipped_anvil", "damaged_anvil", "enchanting_table", "brewing_stand",
    "beacon", "conduit", "lodestone", "respawn_anchor", "bell", "jukebox",
    "lectern", "cartography_table", "fletching_table", "grindstone", "loom",
    "smithing_table", "stonecutter", "composter", "hopper", "dropper",
    "dispenser", "observer", "note_block", "bookshelf", "flower_pot",
    "item_frame", "armor_stand", "spawner", "end_portal_frame",
];

/** Newest Minecraft release the bot can actually join. mineflayer's own
 *  certification list is the binding limit (minecraft-data usually runs
 *  ahead of it) — protocol support lags new game releases by weeks. */
function newestSupportedVersion() {
    try {
        return mineflayer.latestSupportedVersion || "unknown";
    } catch (e) {
        return "unknown";
    }
}

/** Wraps a mineflayer bot with reconnect supervision. `handlers` receive the
 *  live bot instance on every (re)spawn — everything downstream must go
 *  through `.bot` at call time, never cache the instance across reconnects. */
class BotHost {
    constructor(config, log) {
        this.config = config;
        this.log = log;
        this.bot = null;
        this.mcData = null;
        this.stopped = false;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._listeners = { spawn: [], death: [], chat: [], end: [], health: [], entityHurt: [] };
        this.reflexes = null;   // wired by index.js; surfaced in status()
        // Where the body last fell. Dropped items stay at that spot (and
        // despawn ~5 minutes later), but by the time anything reacts the
        // bot has already respawned elsewhere — so it has to be captured
        // at the moment of death or the location is simply gone.
        this.lastDeath = null;
        this._recentPos = null;
    }

    on(event, fn) {
        (this._listeners[event] || (this._listeners[event] = [])).push(fn);
    }

    _emit(event, ...args) {
        for (const fn of this._listeners[event] || []) {
            try { fn(...args); } catch (e) { this.log("handler error", event, e.message); }
        }
    }

    start() {
        this.stopped = false;
        this._connect();
    }

    stop() {
        this.stopped = true;
        try { this.bot?.quit(); } catch (e) { /* already gone */ }
        this.bot = null;
    }

    _connect() {
        if (this.stopped) return;
        // Tear down any superseded instance so its listeners can't fire
        // against the new one (airi's stale-bot lesson).
        if (this.bot) {
            try { this.bot.removeAllListeners(); this.bot.quit(); } catch (e) { /* gone */ }
        }
        const { host, port, username, auth, version } = this.config;
        this.log(`connecting to ${host}:${port} as ${username} (${auth})`);
        const bot = mineflayer.createBot({
            host,
            port,
            username,
            auth,
            version: version || undefined,   // undefined → auto-negotiate
        });
        this.bot = bot;
        // Every handler below guards `this.bot === bot` — a late event from a
        // superseded socket must never touch live state or double-reconnect.
        let ended = false;
        // Spawn watchdog: a connect that stalls before spawn (proxy limbo,
        // resource-pack hang) would otherwise wait forever.
        const spawnWatchdog = setTimeout(() => {
            if (this.bot === bot && !bot.entity) {
                this.log("no spawn within 30s — recycling the connection");
                try { bot.quit(); } catch (e) { /* fine */ }
            }
        }, 30000);
        // Some servers require accepting a resource pack before spawning.
        bot.once("resourcePack", () => {
            try { bot.acceptResourcePack(); } catch (e) { /* not supported */ }
        });

        bot.loadPlugin(pathfinder);
        bot.loadPlugin(collectBlock);
        bot.loadPlugin(pvp);
        bot.loadPlugin(toolPlugin);

        bot.once("spawn", () => {
            if (this.bot !== bot) return;
            clearTimeout(spawnWatchdog);
            this._reconnectDelay = RECONNECT_BASE_MS;
            // minecraft-data must match the negotiated version, so it can
            // only load after spawn.
            this.mcData = require("minecraft-data")(bot.version);
            const movements = new Movements(bot);
            // Digging while pathing is normal survival play (tunnel to the
            // ore, step through a hillside) — and with canDig=false most
            // underground/embedded targets are UNREACHABLE, which is the
            // recipe for the A* blowup below.
            movements.canDig = true;
            // Pillar-up material: the defaults are dirt+cobblestone only,
            // which strands a bot carrying nothing but planks in any hole.
            // Any common junk block should do for scaffolding.
            for (const n of ["netherrack", "cobbled_deepslate", "stone", "granite", "diorite",
                "andesite", "tuff", "sandstone", "oak_planks", "spruce_planks", "birch_planks",
                "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks"]) {
                const item = bot.registry.itemsByName?.[n];
                if (item && !movements.scafoldingBlocks.includes(item.id)) {
                    movements.scafoldingBlocks.push(item.id);
                }
            }
            // Never break the player's things while pathing.
            for (const name of NEVER_BREAK) {
                const block = bot.registry.blocksByName?.[name];
                if (block) movements.blocksCantBreak.add(block.id);
            }
            // Which doors the bot may OPEN comes from a static list inside
            // mineflayer-pathfinder that predates every wood added since
            // 1.16 — mangrove, cherry, bamboo, crimson, warped, pale oak and
            // copper doors are all absent, and a door it can't open is just
            // a wall it won't walk through (spruce_trapdoor is missing too,
            // while spruce_door is present). Ask the SERVER's registry
            // instead. Iron stays out: it needs a button or lever.
            let openable = 0;
            for (const block of bot.registry.blocksArray || []) {
                const name = block.name || "";
                const isDoor = name.endsWith("_door") || name.endsWith("_trapdoor") || name.endsWith("_fence_gate");
                if (!isDoor || name.startsWith("iron_")) continue;
                if (!movements.openable.has(block.id)) openable += 1;
                movements.openable.add(block.id);
            }
            bot.pathfinder.setMovements(movements);
            if (openable) this.log(`pathfinder: taught ${openable} extra door/gate type(s) it can open`);
            // pvp and collectBlock each construct their OWN Movements, which
            // silently ignore everything tuned above (scaffolding, the
            // no-break list) — hand them ours so a chase or a mining run
            // can't bulldoze what pathing protects.
            try { if (bot.pvp) bot.pvp.movements = movements; } catch (e) { /* plugin shape */ }
            try { if (bot.collectBlock) bot.collectBlock.movements = movements; } catch (e) { /* plugin shape */ }
            // Memory guard: searchRadius defaults to -1 (unlimited), and an
            // unreachable goal then makes A* expand every reachable node in
            // the loaded world on every recompute — observed eating the
            // whole 4GB heap in ~5 minutes. Bound the search space and the
            // per-compute think time; far targets still work (the path
            // recomputes as the bot advances).
            bot.pathfinder.searchRadius = 96;
            // How long A* may search before it gives up and reports
            // "Took to long to decide path to goal!". Three seconds was far
            // too tight in real terrain (forest, hills, anything indoors
            // behind a door) — and the cost of failing is not three seconds,
            // it is a whole LLM turn plus a model that concludes the target
            // is unreachable. This is the GLOBAL budget, so it covers
            // collectBlock and pvp, which path themselves and never touch
            // gotoGoal's own patient retry. Still bounded in memory by
            // searchRadius above.
            bot.pathfinder.thinkTimeout = 10000;
            this.log(`spawned (mc ${bot.version})`);
            this._emit("spawn", bot);
        });
        // A one-second position sample: a fall death can move the body a
        // long way in the instant before the packet lands, so this is the
        // backstop when the entity has already been moved to the respawn.
        const posSampler = setInterval(() => {
            if (this.bot === bot && bot.entity?.position) this._recentPos = bot.entity.position.clone();
        }, 1000);
        bot.on("death", () => {
            if (this.bot !== bot) return;
            const spot = bot.entity?.position || this._recentPos;
            this.lastDeath = spot
                ? { x: Math.round(spot.x), y: Math.round(spot.y), z: Math.round(spot.z), at: Date.now() }
                : null;
            if (this.lastDeath) this.log(`died at (${this.lastDeath.x}, ${this.lastDeath.y}, ${this.lastDeath.z})`);
            this._emit("death", bot, this.lastDeath);
        });
        bot.on("health", () => { if (this.bot === bot) this._emit("health", bot); });
        // Packet-level damage attribution (1.20+ damage_event): the reflex
        // layer prefers this over guessing the nearest hostile.
        bot.on("entityHurt", (entity, source) => {
            if (this.bot === bot) this._emit("entityHurt", entity, source);
        });
        bot.on("chat", (username, message) => {
            if (this.bot !== bot) return;
            if (username === bot.username) return;   // never react to our own chat
            this._emit("chat", username, message);
        });
        // Kicks and connection errors used to reach the console ONLY — the
        // user just saw the bot go quiet. Both are relayed now.
        bot.on("kicked", (reason) => {
            const text = typeof reason === "string" ? reason : JSON.stringify(reason);
            this.log("kicked:", text);
            if (this.bot === bot) this._emit("kicked", text);
        });
        bot.on("error", (e) => {
            this.log("bot error:", e.message);
            // The one everyone hits after a Minecraft update: protocol
            // support lags new releases by weeks. Say what actually works.
            let hint = null;
            if (/no data available|is not supported/i.test(e.message || "")) {
                hint = `that Minecraft version is newer than the bot's protocol data. `
                    + `Newest supported release: ${newestSupportedVersion()}. In the Minecraft `
                    + `launcher, create an Installation pinned to it and open the world with that.`;
                this.log(`→ ${hint}`);
            }
            if (this.bot === bot) this._emit("error", e.message, hint);
        });
        // ── Ambient awareness ──────────────────────────────────────────
        // A companion that never notices anything is a tool. These feed the
        // brain's ambient buffer (cheap: read on the next turn it takes
        // anyway); only a few of them are wired to actually wake it.
        bot.on("playerJoined", (player) => {
            if (this.bot !== bot || !player?.username || player.username === bot.username) return;
            this._emit("ambient", "join", `${player.username} just joined the world.`);
        });
        bot.on("playerLeft", (player) => {
            if (this.bot !== bot || !player?.username || player.username === bot.username) return;
            this._emit("ambient", "leave", `${player.username} left the world.`);
        });
        // Someone throwing you items is a gift — the most missable moment
        // in the game and previously invisible.
        bot.on("playerCollect", (collector, collected) => {
            if (this.bot !== bot || collector?.id !== bot.entity?.id) return;
            const name = collected?.getDroppedItem?.()?.name || "something";
            this._emit("ambient", "pickup", `You picked up ${name}.`);
        });
        bot.on("whisper", (username, message) => {
            if (this.bot !== bot || username === bot.username) return;
            this._emit("whisper", username, message);
        });
        bot.on("forcedMove", () => {
            if (this.bot !== bot || !bot.entity) return;
            const p = bot.entity.position.floored();
            this._emit("ambient", "teleport", `You were moved by the server to (${p.x}, ${p.y}, ${p.z}) — any coordinates you were heading to may be stale.`);
        });
        bot.on("rain", () => {
            if (this.bot !== bot) return;
            this._emit("ambient", "weather", bot.isRaining ? "It started raining." : "The rain stopped.");
        });
        bot.on("spawnReset", () => {
            if (this.bot === bot) this._emit("ambient", "spawn_lost", "Your bed is gone or blocked — your respawn point was reset.");
        });
        // Nightfall/daybreak edges only: `time` fires about once a second.
        let wasNight = null;
        bot.on("time", () => {
            if (this.bot !== bot || !bot.time) return;
            const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23000;
            if (wasNight === null) { wasNight = night; return; }
            if (night === wasNight) return;
            wasNight = night;
            this._emit("ambient", "daylight", night
                ? "Night is falling — hostile mobs will start spawning."
                : "The sun is coming up.");
        });
        bot.on("end", () => {
            if (ended || this.bot !== bot) return;   // dedup + stale guard
            ended = true;
            clearTimeout(spawnWatchdog);
            clearInterval(posSampler);
            this._emit("end");
            this.bot = null;
            if (this.stopped) return;
            this.log(`disconnected — retrying in ${Math.round(this._reconnectDelay / 1000)}s`);
            setTimeout(() => this._connect(), this._reconnectDelay);
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
        });
    }

    get online() {
        return !!(this.bot && this.bot.entity);
    }

    /** Compact world/self snapshot. Feeds the brain's context (as prose-ish
     *  JSON) and the server's status relay — keep it small, it's read by
     *  LLMs on both ends. */
    status() {
        const bot = this.bot;
        if (!bot || !bot.entity) return { online: false };
        const pos = bot.entity.position;
        const players = Object.keys(bot.players || {}).filter((n) => n !== bot.username);
        const entities = {};
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position) continue;
            if (e.position.distanceTo(pos) > 16) continue;
            const name = e.username || e.name || e.displayName || "entity";
            if (name === "item") continue;
            entities[name] = (entities[name] || 0) + 1;
        }
        const held = bot.heldItem ? bot.heldItem.name : null;
        let biome = null;
        try {
            const id = bot.world?.getBiome?.(pos.floored());
            biome = bot.registry?.biomes?.[id]?.name || null;
        } catch (e) { /* unloaded */ }
        const position = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
        let effects = [];
        try {
            effects = Object.values(bot.entity.effects || {})
                .map((e) => bot.registry?.effects?.[e.id]?.name)
                .filter(Boolean);
        } catch (e) { /* shape varies by version */ }
        const spawn = bot.spawnPoint;
        return {
            online: true,
            username: bot.username,
            position,
            pos: position,   // alias — models guess both names; never crash on either
            dimension: bot.game?.dimension,
            biome,
            health: Math.round(bot.health ?? 0),
            food: Math.round(bot.food ?? 0),
            // What the BODY is actually doing — never the skill or goal
            // label, which lies whenever a plan stalls (mc-agent-neko's
            // "said it was digging a shelter, actually just standing").
            activity: this.activity(),
            held,
            // Riding something? Then walking/pathing/placing is impossible
            // until dismount() — the model could not see this before.
            riding: bot.vehicle ? (bot.vehicle.name || "a vehicle") : null,
            oxygen: bot.oxygenLevel ?? null,
            effects,
            xpLevel: bot.experience?.level ?? null,
            sleeping: !!bot.isSleeping,
            spawnPoint: spawn ? { x: Math.round(spawn.x), y: Math.round(spawn.y), z: Math.round(spawn.z) } : null,
            // Where the last death happened, with how long ago — dropped
            // items despawn about 5 minutes after they fall.
            deathSpot: this.lastDeath
                ? { ...this.lastDeath, minutesAgo: Math.round((Date.now() - this.lastDeath.at) / 60000) }
                : null,
            gameMode: bot.game?.gameMode ?? null,
            difficulty: bot.game?.difficulty ?? null,
            emptySlots: bot.inventory?.emptySlotCount?.() ?? null,
            timeOfDay: bot.time ? (bot.time.isDay ? "day" : "night") : null,
            // Raw ticks: 0 dawn, 12000 dusk, 13000 mobs spawn, 24000 wraps.
            timeTicks: bot.time ? bot.time.timeOfDay : null,
            raining: !!bot.isRaining,
            thundering: (bot.thunderState ?? 0) > 0,
            nearbyPlayers: players,
            nearbyEntities: entities,
            // What the survival reflex layer is doing right now (null = idle).
            reflex: this.reflexes?.engaged || null,
        };
    }

    /** What the body is physically doing right now, read from live state in
     *  specificity order. The honest answer to "what are you up to?" — a
     *  plan label can claim work that stalled minutes ago. */
    activity() {
        const bot = this.bot;
        if (!bot || !bot.entity) return "offline";
        try {
            if (bot.isSleeping) return "sleeping";
            if (bot.pvp?.target) return `fighting a ${bot.pvp.target.name || "mob"}`;
            if (bot.targetDigBlock) return `digging ${bot.targetDigBlock.name}`;
            if (bot.vehicle) return `riding ${bot.vehicle.name || "a vehicle"}`;
            if (bot.pathfinder?.isMoving?.()) return "travelling";
            return "standing still";
        } catch (e) {
            return "unknown";
        }
    }

    /** Inventory as [{name, count, …}] merged across slots. Tools also carry
     *  the durability of the MOST WORN stack — the one about to break, and
     *  the only one worth warning about — plus any enchantments. */
    inventory() {
        const bot = this.bot;
        if (!bot) return [];
        const merged = {};
        for (const item of bot.inventory?.items() || []) {
            const entry = merged[item.name] || (merged[item.name] = { name: item.name, count: 0 });
            entry.count += item.count;
            const max = item.maxDurability;
            if (max) {
                const left = max - (item.durabilityUsed || 0);
                if (entry.durability === undefined || left < entry.durability) {
                    entry.durability = left;
                    entry.durabilityMax = max;
                }
            }
            try {
                const names = (item.enchants || []).map((e) => e.name).filter(Boolean);
                if (names.length) entry.enchants = [...new Set([...(entry.enchants || []), ...names])];
            } catch (e) { /* nbt shape varies by version */ }
        }
        return Object.values(merged);
    }
}

module.exports = { BotHost };
