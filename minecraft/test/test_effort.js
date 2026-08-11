// reasoning_effort must go to the HARD model only (the fast model 400s on
// it), and an unsupported hard model must self-heal rather than fail.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const { Brain } = require("../brain.js");

const STATE = __dirname + "/effort_state_test.json";
try { fs.unlinkSync(STATE); } catch (e) { /* fresh */ }

const host = { online: true, on() {}, status: () => ({}), inventory: () => [] };
const brain = new Brain(host, { log() {}, event() {} }, { stateFile: STATE });
brain.configure({ apiKey: "k", model: "fast-model", hardModel: "hard-model" });

const sent = [];
let failEffortOnce = false;
global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    if (failEffortOnce && body.reasoning_effort) {
        return {
            ok: false,
            status: 400,
            text: async () => "Model hard-model does not support parameter reasoningEffort.",
        };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "await wait(1);" } }] }) };
};

(async () => {
    // Fast model: the parameter must NEVER be sent.
    brain.taskModel = "fast-model";
    await brain._llm({ type: "directive", text: "d" });
    assert.strictEqual(sent.at(-1).model, "fast-model");
    assert.strictEqual(sent.at(-1).reasoning_effort, undefined,
        "the fast model rejects reasoning_effort — it must not be sent");

    // Hard model: sent as "low".
    brain.taskModel = "hard-model";
    await brain._llm({ type: "directive", text: "d" });
    assert.strictEqual(sent.at(-1).reasoning_effort, "low");

    // A hard model that rejects it: one retry without, then remembered.
    failEffortOnce = true;
    sent.length = 0;
    await brain._llm({ type: "directive", text: "d" });
    assert.strictEqual(sent.length, 2, "should retry exactly once");
    assert.strictEqual(sent[0].reasoning_effort, "low");
    assert.strictEqual(sent[1].reasoning_effort, undefined, "retry drops the parameter");
    // Remembered — later calls skip it entirely.
    sent.length = 0;
    await brain._llm({ type: "directive", text: "d" });
    assert.strictEqual(sent.length, 1, "no wasted probe on later turns");
    assert.strictEqual(sent[0].reasoning_effort, undefined);

    try { fs.unlinkSync(STATE); } catch (e) { /* never persisted */ }
    console.log("EFFORT-OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
