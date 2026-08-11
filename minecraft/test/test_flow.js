// Flow: a stored blueprint must be scoped to the task it was made for, and
// an idle brain must still hear emergencies (it used to swallow death).
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const { Brain } = require("../brain.js");

const STATE = __dirname + "/flow_state_test.json";
try { fs.unlinkSync(STATE); } catch (e) { /* fresh */ }

const handlers = {};
const host = {
    online: true,
    on: (n, f) => { (handlers[n] = handlers[n] || []).push(f); },
    fire: (n, ...a) => (handlers[n] || []).forEach((f) => f(...a)),
    status: () => ({}), inventory: () => [],
};
const events = [];
const brain = new Brain(host, { log() {}, event: (k, t, u) => events.push({ k, t, u }) }, { stateFile: STATE });
brain.configure({ apiKey: "k", model: "m" });

const seen = [];
brain._llm = async (event) => { seen.push(event); return "await wait(1);"; };
brain._runScript = async () => ({
    error: null, aborted: false, logs: [], done: "ok",
    actions: 1, actionOk: 1, actionErr: 0, abortedDuring: null, delta: null,
});
async function settle() {
    for (let i = 0; i < 200 && (brain.busy || brain.queue.length); i++) await new Promise((r) => setTimeout(r, 5));
}

(async () => {
    // A design made for the hut...
    brain.goal = "build a hut";
    brain.mem.blueprint = { origin: { x: 5, y: 64, z: 5 }, levels: [{ dy: 0, grid: [["oak_planks"]] }] };
    brain._trackBlueprint();
    assert.strictEqual(brain.mem.blueprintFor, "build a hut");
    assert.ok(/2 level|1 level/.test(brain._blueprintText()));
    assert.ok(!/earlier task/.test(brain._blueprintText()), "own-task design must not be attributed");

    // ...must be ATTRIBUTED once the task changes (the "hold position"
    // bug), but never with an instruction attached: the flag fires on a
    // wording mismatch, which is exactly what a resume looks like, and
    // "ignore or replace it" then starts a second hut beside the first.
    brain.goal = "hold position here";
    const text = brain._blueprintText();
    assert.ok(/from your earlier task "build a hut"/.test(text), text);
    assert.ok(!/\bignore\b|NOT this task/i.test(text), `state the fact, don't order: ${text}`);
    assert.ok(/Continue it if this task is that build/.test(text), text);

    // The grid itself never enters [MEM] — only the pointer line. Checked
    // against the REAL prompt the model would receive.
    brain.mem.note = "keep me";
    let sentPrompt = null;
    global.fetch = async (url, opts) => {
        sentPrompt = JSON.parse(opts.body).messages[1].content;
        return { ok: true, json: async () => ({ choices: [{ message: { content: "await wait(1);" } }] }) };
    };
    const realLlm = Object.getPrototypeOf(brain)._llm.bind(brain);
    await realLlm({ type: "feedback", text: "carry on" });
    assert.ok(/\[BLUEPRINT\]/.test(sentPrompt), "the pointer line must be present");
    assert.ok(/from your earlier task/.test(sentPrompt), "and carry the attribution");
    assert.ok(!/oak_planks/.test(sentPrompt), "the grid itself must NOT be dumped into the prompt");
    assert.ok(/keep me/.test(sentPrompt), "other mem keys still ride in [MEM]");

    // Idle brain: death and danger now get through; feedback still doesn't.
    brain.idle = true;
    seen.length = 0;
    brain.push({ type: "feedback", text: "carry on" });
    await settle();
    assert.strictEqual(seen.length, 0, "our own feedback must not wake a finished task");

    brain.idle = true;
    seen.length = 0;
    host.fire("death", {}, { x: 1, y: 2, z: 3, at: Date.now() });
    // The wake is synchronous in push(); the turn that follows may well
    // finish and idle again, which is correct.
    assert.strictEqual(brain.idle, false, "an emergency re-engages the brain");
    await settle();
    assert.ok(seen.some((e) => e.type === "death"), "a death must reach the model even when idle");

    brain.idle = true;
    seen.length = 0;
    brain.push({ type: "danger", text: "Your health is low (3/20)." }, { interrupt: true });
    await settle();
    assert.ok(seen.some((e) => e.type === "danger"), "danger must reach the model even when idle");

    try { fs.unlinkSync(STATE); } catch (e) { /* fine */ }
    console.log("FLOW-OK");
    process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
