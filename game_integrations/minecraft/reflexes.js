// Reflex layer: self-preservation that acts WITHOUT waking the LLM — eating
// when hungry, fighting back when a hostile mob lands a hit, fleeing when
// nearly dead. The brain plans; reflexes keep the body alive between plans.
//
// Design rules adapted from Project AIRI's reflex behaviors (MIT, see
// README.md credits), which encode lessons learned the hard way there:
// - Hold an engagement to completion — leaving combat to the brain made it
//   thrash between attack and flee on every hit and get killed.
// - NEVER auto-attack players — only hostile mobs that actually hurt us.
//   Player threats are the brain's (and the user's) business.
// - One reflex owns the body at a time; survival eating at critical hunger
//   outranks combat.
"use strict";

const { goals } = require("mineflayer-pathfinder");

const EAT_AT_FOOD = 14;            // saturation headroom: eat before it matters
const EAT_CRITICAL = 6;            // eat even mid-combat below this
const FLEE_BELOW_HEALTH = 8;       // fight back above, run below
const FLEE_DISTANCE = 24;
const ATTACKER_RANGE = 8;          // hostile within this of a fresh hit = the attacker
const ENGAGE_TIMEOUT_MS = 30000;
const TICK_MS = 2000;
const NOTIFY_THROTTLE_MS = 30000;

// Never worth eating; golden apples are saved for the brain to use tactically.
const BAD_FOODS = new Set([
    "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish",
    "chorus_fruit", "golden_apple", "enchanted_golden_apple",
]);
// Raw-but-cookable food is left for the brain to smelt (cooked variants are
// strictly better) — UNLESS it's all we have and health is critical.
const RAW_COOKABLE = new Set([
    "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon", "potato", "kelp",
]);
// How recently a packet-attributed attacker counts as "the one who hit us".
const ATTACKER_RECENCY_MS = 600;

function isHostileMob(entity) {
    if (!entity || entity.type === "player" || !entity.name) return false;
    if (entity.name === "iron_golem" || entity.name === "snow_golem") return false;
    // Type/kind first (covers every mob incl. modded), name list as backstop.
    if (entity.type === "hostile") return true;
    if (typeof entity.kind === "string" && /hostile/i.test(entity.kind)) return true;
    return ["zombie", "skeleton", "creeper", "spider", "cave_spider", "witch",
        "drowned", "husk", "stray", "pillager", "vindicator", "enderman",
        "slime", "magma_cube", "phantom", "zombified_piglin", "wither_skeleton",
        "ravager", "evoker", "vex", "blaze", "ghast", "hoglin", "zoglin",
        "warden", "guardian", "elder_guardian", "silverfish", "endermite",
        "shulker", "piglin_brute", "breeze", "bogged"].includes(entity.name);
}

class Reflexes {
    constructor(host, io) {
        this.host = host;
        this.io = io;
        this.engaged = null;           // "eat" | "fight" | "flee" | "escape" | null
        this._lastHealth = 20;
        this._lastNotifyAt = 0;
        this._lastAttacker = null;     // {entity, at} from the damage_event packet
        this._timer = setInterval(() => this._tick().catch(() => {}), TICK_MS);
        // Hazards kill in seconds — poll faster than the upkeep tick.
        this._hazardTimer = setInterval(() => this._hazardTick().catch(() => {}), 500);
        host.on("health", () => this._onHealth().catch(() => {}));
        // Packet-level attribution: airi's lesson — nearest-hostile guessing
        // blamed the master for a skeleton's arrow. The packet knows.
        host.on("entityHurt", (entity, source) => {
            const bot = this.host.bot;
            if (!bot?.entity || !entity || entity.id !== bot.entity.id) return;
            if (source) this._lastAttacker = { entity: source, at: Date.now() };
        });
        host.on("death", () => { this.engaged = null; this._lastAttacker = null; });
        host.on("end", () => { this.engaged = null; this._lastAttacker = null; });
    }

    stop() {
        clearInterval(this._timer);
        clearInterval(this._hazardTimer);
    }

    _notify(text, urgency = "normal") {
        // The brain always learns what the body did (cheap — read on its
        // next turn); the USER only hears the throttled headline.
        this.io.behavior?.(text);
        const now = Date.now();
        if (now - this._lastNotifyAt < NOTIFY_THROTTLE_MS) return;
        this._lastNotifyAt = now;
        this.io.event("notify", text, urgency);
    }

    /** Damage taken → identify the attacker and respond. Prefers the
     *  packet-attributed source (works for ranged mobs at any distance,
     *  never blames bystanders); nearest hostile is only a fallback. */
    async _onHealth() {
        const bot = this.host.bot;
        if (!bot || !bot.entity) return;
        const health = bot.health ?? 20;
        const dropped = health < this._lastHealth - 0.5;
        if (dropped) this._lastHit = this._lastHealth - health;
        this._lastHealth = health;
        if (!dropped) return;
        if (this.engaged === "fight" || this.engaged === "flee" || this.engaged === "escape") return;

        let attacker = null;
        const tracked = this._lastAttacker;
        if (tracked && Date.now() - tracked.at < ATTACKER_RECENCY_MS
            && tracked.entity?.isValid && isHostileMob(tracked.entity)) {
            attacker = tracked.entity;   // NEVER a player — isHostileMob excludes them
        }
        if (!attacker) {
            const pos = bot.entity.position;
            let best = Infinity;
            for (const e of Object.values(bot.entities || {})) {
                if (!e?.position || !isHostileMob(e)) continue;
                const d = e.position.distanceTo(pos);
                if (d < ATTACKER_RANGE && d < best) { best = d; attacker = e; }
            }
        }
        if (!attacker) return;   // fall/fire/environment — the brain hears via its own event

        // One more hit like that would kill us: absolute thresholds miss
        // the case where a single blow does 9 damage from full-ish health.
        const lethalNext = this._lastHit && this._lastHit >= health;
        // Creepers explode on approach — never melee them reflexively.
        if (health < FLEE_BELOW_HEALTH || lethalNext || attacker.name === "creeper") {
            await this._flee(attacker);
        } else {
            await this._fight(attacker);
        }
    }

    /** Fast loop: escape lava and drowning — the hazards that kill faster
     *  than any LLM round-trip. Highest priority of all reflexes. */
    async _hazardTick() {
        const bot = this.host.bot;
        if (!bot || !bot.entity || this.engaged === "escape") return;
        const inLava = !!bot.entity.isInLava;
        const drowning = !!bot.entity.isInWater && (bot.oxygenLevel ?? 20) <= 6;
        if (!inLava && !drowning) {
            await this._sandGuard(bot);
            await this._fireGuard(bot);
            return;
        }

        this.engaged = "escape";
        this._notify(inLava ? "I'm in lava — getting out!" : "I'm drowning — swimming up!", "high");
        try {
            try { bot.pathfinder.setGoal(null); } catch (e) { /* fine */ }
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
                if (!bot.entity) break;
                const stillLava = !!bot.entity.isInLava;
                const stillDrowning = !!bot.entity.isInWater && (bot.oxygenLevel ?? 20) <= 8;
                if (!stillLava && !stillDrowning) break;
                const target = stillLava ? this._nearestSafeStand(bot) : null;
                if (target) {
                    await bot.lookAt(target.offset(0.5, 1, 0.5)).catch(() => {});
                } else {
                    // Open water / no floor found: straight up.
                    await bot.lookAt(bot.entity.position.offset(0, 3, 0)).catch(() => {});
                }
                bot.setControlState("jump", true);
                bot.setControlState("forward", true);
                await new Promise((r) => setTimeout(r, 150));
            }
        } finally {
            try {
                bot.setControlState("jump", false);
                bot.setControlState("forward", false);
            } catch (e) { /* fine */ }
            // Reconnect guard: don't clear an engagement a NEW bot
            // instance's reflex just set.
            if (this.host.bot === bot) this.engaged = null;
        }
    }

    /** Gravel and sand suffocate whoever is standing under them mid-dig —
     *  step out from under a falling column before it lands. */
    async _sandGuard(bot) {
        if (this.engaged) return;
        try {
            const base = bot.entity.position.floored();
            let falling = false;
            for (let dy = 2; dy <= 4; dy++) {
                const b = bot.blockAt(base.offset(0, dy, 0));
                if (b && /sand|gravel|concrete_powder|anvil/.test(b.name)) { falling = true; break; }
            }
            if (!falling) return;
            const head = bot.blockAt(base.offset(0, 1, 0));
            if (head && head.boundingBox === "block") return;   // already covered
            this.engaged = "escape";
            this._notify("something's falling above me — moving out of the way", "normal");
            bot.setControlState("sprint", true);
            bot.setControlState("forward", true);
            await new Promise((r) => setTimeout(r, 600));
            bot.setControlState("forward", false);
            bot.setControlState("sprint", false);
        } catch (e) { /* non-fatal */ } finally {
            if (this.host.bot === bot && this.engaged === "escape") this.engaged = null;
        }
    }

    /** On fire and holding water: douse yourself. The cheapest life saved
     *  in the game, and it needs no plan. */
    async _fireGuard(bot) {
        if (this.engaged || !bot.entity?.isOnFire) return;
        if ((bot.health ?? 20) > 12) return;   // brief singe — don't waste the bucket
        const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
        if (!bucket) return;
        this.engaged = "escape";
        try {
            this._notify("I'm on fire — putting myself out", "high");
            await bot.equip(bucket, "hand");
            await bot.lookAt(bot.entity.position.offset(0, -1, 0), true);
            bot.activateItem();
            await new Promise((r) => setTimeout(r, 300));
            bot.deactivateItem();
        } catch (e) { /* non-fatal */ } finally {
            if (this.host.bot === bot) this.engaged = null;
        }
    }

    /** Nearest solid, non-burny floor with two clear blocks above, scanning
     *  ±6 around the bot (adapted from airi's findNearestSafeStand). */
    _nearestSafeStand(bot) {
        const base = bot.entity.position.floored();
        let best = null, bestScore = Infinity;
        for (let dx = -6; dx <= 6; dx++) {
            for (let dz = -6; dz <= 6; dz++) {
                for (let dy = -1; dy <= 3; dy++) {
                    const floor = bot.blockAt(base.offset(dx, dy - 1, dz));
                    if (!floor || floor.boundingBox !== "block") continue;
                    if (/lava|fire|magma/.test(floor.name)) continue;
                    const a = bot.blockAt(base.offset(dx, dy, dz));
                    const b = bot.blockAt(base.offset(dx, dy + 1, dz));
                    if (!a || !b) continue;
                    if (a.boundingBox !== "empty" || b.boundingBox !== "empty") continue;
                    if (/lava/.test(a.name) || /lava/.test(b.name)) continue;
                    const score = Math.abs(dx) + Math.abs(dz) + 0.5 * Math.abs(dy);
                    if (score < bestScore) { bestScore = score; best = base.offset(dx, dy, dz); }
                }
            }
        }
        return best;
    }

    async _fight(attacker) {
        const bot = this.host.bot;
        this.engaged = "fight";
        this._notify(`a ${attacker.name} is on me — fighting it off`, "normal");
        try {
            bot.pvp.attack(attacker);
            const started = Date.now();
            while (attacker.isValid && Date.now() - started < ENGAGE_TIMEOUT_MS) {
                await new Promise((r) => setTimeout(r, 500));
                // Deteriorating mid-fight → switch to flee.
                if ((bot.health ?? 20) < FLEE_BELOW_HEALTH) {
                    try { bot.pvp.stop(); } catch (e) { /* fine */ }
                    this.engaged = null;
                    return this._flee(attacker);
                }
            }
        } finally {
            try { bot.pvp.stop(); } catch (e) { /* fine */ }
            if (this.host.bot === bot) this.engaged = null;
        }
    }

    async _flee(threat) {
        const bot = this.host.bot;
        this.engaged = "flee";
        this._notify("low health — running from danger!", "high");
        try {
            // Raise a shield while backing off: it blocks arrows outright
            // and halves a creeper blast. Free survival if one is carried.
            const shield = bot.inventory.items().find((i) => i.name === "shield");
            if (shield) {
                try {
                    if (bot.inventory.slots[45]?.name !== "shield") await bot.equip(shield, "off-hand");
                    await bot.lookAt(threat.position.offset(0, 1, 0), true);
                    bot.activateItem(true);   // off-hand
                    setTimeout(() => { try { bot.deactivateItem(); } catch (e) { /* fine */ } }, 2500);
                } catch (e) { /* shield is a bonus, never a blocker */ }
            }
            let away = bot.entity.position.minus(threat.position);
            if (!(away.norm() > 0.01)) {
                // Point-blank hit: threat at our exact position would make
                // normalize() a NaN vector — pick a random direction.
                const a = Math.random() * Math.PI * 2;
                away = away.offset(Math.cos(a), 0, Math.sin(a));
            }
            away = away.normalize().scaled(FLEE_DISTANCE);
            const target = bot.entity.position.plus(away);
            await bot.pathfinder.goto(
                new goals.GoalNear(target.x, target.y, target.z, 3),
            ).catch(() => {});   // any distance gained is a win; don't insist
        } finally {
            if (this.host.bot === bot) this.engaged = null;
        }
    }

    /** Periodic upkeep: eat when hungry — or when badly hurt, since health
     *  only regenerates at food ≥ 18 (eat-to-heal, airi's actual trigger).
     *  Skipped while fighting unless critical. Raw-but-cookable food is
     *  left for the brain to smelt, unless it's all we have and we're
     *  desperate. */
    async _tick() {
        const bot = this.host.bot;
        if (!bot || !bot.entity) return;
        if (this.engaged === "eat" || this.engaged === "flee" || this.engaged === "escape") return;
        const food = bot.food ?? 20;
        const health = bot.health ?? 20;
        const eatToHeal = health <= 6 && food < 18;   // top up so regen kicks in
        if (food > EAT_AT_FOOD && !eatToHeal) return;
        if (this.engaged === "fight" && food > EAT_CRITICAL && !eatToHeal) return;

        const foods = bot.registry.foodsByName || {};
        const desperate = health <= EAT_CRITICAL;
        let bestItem = null, bestPoints = -1;
        let rawItem = null, rawPoints = -1;
        for (const item of bot.inventory.items()) {
            const f = foods[item.name];
            if (!f || BAD_FOODS.has(item.name)) continue;
            if (RAW_COOKABLE.has(item.name)) {
                if (f.foodPoints > rawPoints) { rawPoints = f.foodPoints; rawItem = item; }
                continue;
            }
            if (f.foodPoints > bestPoints) { bestPoints = f.foodPoints; bestItem = item; }
        }
        if (!bestItem && desperate) bestItem = rawItem;   // raw beats dead
        if (!bestItem) return;   // nothing edible — the brain's low-food event handles it

        this.engaged = "eat";
        const held = bot.heldItem;
        try {
            await bot.equip(bestItem, "hand");
            await bot.consume();
            // Restore whatever tool was in hand so a running script's next
            // dig/attack isn't done with a pork chop.
            if (held) await bot.equip(held, "hand").catch(() => {});
        } catch (e) {
            /* interrupted by movement/damage — retried next tick */
        } finally {
            this.engaged = null;
        }
    }
}

module.exports = { Reflexes };
