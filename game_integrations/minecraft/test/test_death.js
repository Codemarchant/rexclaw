// Death position capture: the coordinates must survive the respawn, reach
// mem, the status payload, and the brain's event text.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const { Brain } = require("../brain.js");

const STATE = __dirname + "/death_state_test.json";
try { fs.unlinkSync(STATE); } catch (e) { /* fresh */ }

const handlers = {};
const host = {
    online: true,
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
    fire: (name, ...args) => (handlers[name] || []).forEach((f) => f(...args)),
    status: () => ({}),
    inventory: () => [],
};
const events = [];
const brain = new Brain(host, { log() {}, event: (k, t, u) => events.push({ k, t, u }) }, { stateFile: STATE });
// Deliberately NOT configured with an API key: the pump then drops events
// instead of calling xAI, so what was pushed can be inspected.
const pushed = [];
const origPush = brain.push.bind(brain);
brain.push = (event, opts) => { pushed.push(event); return origPush(event, opts); };

// The bot dies at a known spot.
host.fire("death", {}, { x: 120, y: 42, z: -87, at: Date.now() });

// Saved for every future turn, and it survives a restart.
assert.deepStrictEqual(brain.mem.deathSpot, { x: 120, y: 42, z: -87 });

// The companion is told where, so the user can ask for a recovery run.
const spoken = events.find((e) => e.k === "death");
assert.ok(/I died at \(120, 42, -87\)/.test(spoken.t), spoken.t);
assert.strictEqual(spoken.u, "high");

// The brain's own event carries the coordinates, the despawn clock and the
// exact recovery call — the model should never have to invent a location.
const queued = pushed.find((e) => e.type === "death");
assert.ok(/died at \(120, 42, -87\)/.test(queued.text), queued.text);
assert.ok(/5 MINUTES/.test(queued.text), "the despawn deadline must be stated");
assert.ok(/goTo\(120, 42, -87\) then pickup\(\)/.test(queued.text), queued.text);

// Persistence: a restarted sidecar still knows where the stuff is.
brain.persistNow();
const brain2 = new Brain({ online: true, on() {}, status: () => ({}), inventory: () => [] },
    { log() {}, event() {} }, { stateFile: STATE });
assert.deepStrictEqual(brain2.mem.deathSpot, { x: 120, y: 42, z: -87 },
    "death spot must survive a sidecar restart");

// A death with no position available must not crash or fabricate one.
const brain3 = new Brain(host, { log() {}, event() {} }, { stateFile: STATE + "3" });
host.fire("death", {}, null);
assert.strictEqual(brain3.mem.deathSpot, undefined, "no position → no invented coordinates");

fs.unlinkSync(STATE);
try { fs.unlinkSync(STATE + "3"); } catch (e) { /* may not exist */ }
console.log("DEATH-OK");
