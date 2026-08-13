// The runaway-feedback bug: a script that acts but never calls done()
// (followPlayer is a standing state) queued another turn forever — one LLM
// call and one chat line per second. Plus the chat flood guard.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const { Brain } = require("../brain.js");
const { buildRuntime } = require("../skills.js");

const STATE = __dirname + "/loop_state_test.json";
try { fs.unlinkSync(STATE); } catch (e) { /* fresh */ }

const host = { online: true, on() {}, status: () => ({}), inventory: () => [] };
const events = [];
const brain = new Brain(host, { log() {}, event: (k, t, u) => events.push({ k, t, u }) }, { stateFile: STATE });
brain.configure({ apiKey: "k", model: "m" });

let turns = 0;
// Every turn acts and never declares done — the exact followPlayer shape.
brain._llm = async () => { turns += 1; return `await chat("following you!");\nawait followPlayer("Jonny", 3);`; };
brain._runScript = async () => ({
    error: null, aborted: false, logs: [], done: null,
    actions: 2, actionOk: 2, actionErr: 0, abortedDuring: null, delta: null,
});

async function settle() {
    for (let i = 0; i < 400 && (brain.busy || brain.queue.length); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(!brain.busy && !brain.queue.length, "brain never settled — the loop is still running");
}

(async () => {
    brain.push({ type: "directive", text: "follow me", goal: "follow me" });
    await settle();

    // Before the fix this never terminated. Now one counter ends it: the
    // turns change nothing in the world, so the streak runs out.
    assert.ok(turns <= 11, `runaway loop: ${turns} turns for one directive`);
    assert.strictEqual(brain.idle, true, "the brain must stand down, not keep re-planning");
    assert.strictEqual(brain.goal, null);
    const closed = brain.goals.find((g) => g.text === "follow me");
    assert.ok(/stopped re-planning|standing by|steadily/.test(closed.outcome), closed.outcome);
    // A bot that stops must SAY so — a silent stop is the worst outcome.
    const note = events[events.length - 1];
    assert.strictEqual(note.k, "error");
    assert.strictEqual(note.u, "normal", "the companion must be able to speak this");
    assert.ok(/standing by/.test(note.t), note.t);

    // A NEW directive clears the streak so the next task gets its full budget.
    brain.push({ type: "directive", text: "come here", goal: "come here" });
    assert.strictEqual(brain.stuck, 0);
    brain.queue.length = 0;

    // A LONG job that keeps changing the world must NOT be cut off: the
    // streak only counts stagnant turns. (Counting productive ones made the
    // feedback threaten a deadline, and the model answered by calling done()
    // mid-task — "proceeding to craft tools" — and stopping.)
    turns = 0;
    let n = 0;
    const seenEvents = [];
    brain._llm = async (event) => { turns += 1; seenEvents.push(event); return `await collect("oak_log", 1);   // turn ${turns}`; };
    brain._runScript = async () => ({
        error: null, aborted: false, logs: [], done: turns >= 8 ? "hut finished" : null,
        actions: 2, actionOk: 2, actionErr: 0, abortedDuring: null,
        delta: `+${++n} oak_log`,          // real progress every turn
    });
    brain.push({ type: "directive", text: "build a hut", goal: "build a hut" });
    await settle();
    assert.ok(turns >= 8, `a productive multi-turn job must run to completion, stopped after ${turns}`);
    assert.strictEqual(brain.stuck, 0, "progress must keep resetting the streak");
    // Feedback is FACTS ONLY — what ran, what the world says, the script.
    // No countdowns, no attempt counters, and no re-argued rules: every one
    // of those is in the system prompt, stated once.
    const fb = seenEvents.filter((e) => e.type === "feedback").pop();
    assert.ok(/World: \+\d+ oak_log/.test(fb.text), `the world's own account must be there: ${fb.text}`);
    assert.ok(!/follow-up \d+ of|Attempt \d+\/|FINAL attempt/.test(fb.text), `no deadline pressure: ${fb.text}`);
    assert.ok(!/turn limit|done\(\) ONLY|do NOT redo/.test(fb.text), `no re-lectured rules: ${fb.text}`);

    // Chat flood guard: repeats and volume are dropped across scripts.
    const said = [];
    const bot = {
        entity: { position: { x: 0, y: 0, z: 0 } },
        chat: (t) => said.push(t),
        registry: { itemsByName: {}, blocksByName: {}, foodsByName: {} },
        inventory: { items: () => [] },
    };
    const chatHost = { online: true, bot, status: () => ({}), inventory: () => [] };
    const rt = buildRuntime(chatHost, new AbortController(), { log() {}, notify() {}, done() {}, chat() {} });
    assert.deepStrictEqual(await rt.chat("hello"), { said: true });
    const dup = await rt.chat("hello");
    assert.strictEqual(dup.said, false, "an identical line must be suppressed");
    assert.ok(/already said/.test(dup.suppressed));
    for (let i = 0; i < 10; i++) await rt.chat(`line ${i}`);
    assert.ok(said.length <= 6, `chat flood not capped: ${said.length} messages sent`);

    fs.unlinkSync(STATE);
    console.log("LOOP-OK");
    process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
