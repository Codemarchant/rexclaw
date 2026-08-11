// The checklist: plan API semantics, [PLAN] rendering, status exposure,
// and the property that matters most — a blocked step does NOT throw.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const { Brain } = require("../brain.js");

const STATE = __dirname + "/plan_state_test.json";
try { fs.unlinkSync(STATE); } catch (e) { /* fresh */ }

const host = { online: true, on() {}, status: () => ({}), inventory: () => [] };
const brain = new Brain(host, { log() {}, event() {} }, { stateFile: STATE });
brain.configure({ apiKey: "k", model: "m" });
brain.goal = "build a cozy hut";

// Reach the plan API the same way a script does.
let planApi = null;
brain._runScript = brain._runScript.bind(brain);
const origBuild = require("../brain.js");
// makePlanApi is module-private; exercise it through a real script run.
brain._llm = async () => `
plan.set(["gather 24 spruce logs", "craft a door", "craft a bed", "build the walls"]);
plan.done("gather 24");
try { throw new Error("no wool in inventory"); } catch (e) { plan.block("bed", e.message); }
log("next: " + plan.next());
`;
(async () => {
    const result = await brain._runScript(await brain._llm());
    assert.strictEqual(result.error, null, `script must not throw: ${result.error}`);

    const plan = brain.mem.plan;
    assert.strictEqual(plan.goal, "build a cozy hut", "plan is scoped to the goal");
    assert.strictEqual(plan.steps.length, 4);
    assert.strictEqual(plan.steps[0].status, "done", "substring match marks the right step");
    assert.strictEqual(plan.steps[2].status, "blocked");
    assert.strictEqual(plan.steps[2].note, "no wool in inventory");
    // The key property: blocking did not abort the run — later lines executed.
    assert.ok(result.logs.some((l) => /next: craft a door/.test(l)),
        `blocked step must not stop the script; logs: ${JSON.stringify(result.logs)}`);

    // [PLAN] rendering: counts, marks, the next pointer, the note.
    const text = brain._planText();
    assert.ok(/\[PLAN\] build a cozy hut — 1 done, 1 blocked, 2 left/.test(text), text);
    assert.ok(/✓ gather 24 spruce logs/.test(text), text);
    assert.ok(/✗ craft a bed — blocked: no wool in inventory/.test(text), text);
    assert.ok(/craft a door {3}← next/.test(text), text);

    // Status exposure for the companion.
    const s = brain.statusFields();
    assert.strictEqual(s.plan.progress, "1/4");
    assert.strictEqual(s.plan.doing, "craft a door");
    assert.deepStrictEqual(s.plan.blocked, ["craft a bed (no wool in inventory)"]);

    // A plan from another task is flagged, never silently reused.
    brain.goal = "go fishing";
    assert.ok(/left over from "build a cozy hut"/.test(brain._planText()));

    // Marking a step that doesn't exist must NOT kill the script — a
    // bookkeeping slip used to throw away every action after it.
    brain.goal = "build a cozy hut";
    brain._llm = async () => 'log(JSON.stringify(plan.done("dig a moat")));\nlog("still running");';
    const bad = await brain._runScript(await brain._llm());
    assert.strictEqual(bad.error, null, `a bad step name must not throw: ${bad.error}`);
    assert.ok(bad.logs.some((l) => /nothing marked/.test(l)), bad.logs.join(" | "));
    assert.ok(bad.logs.includes("still running"), "the rest of the script must run");

    // The plan survives a restart (it rides in mem, which persists).
    brain.persistNow();
    const brain2 = new Brain({ online: true, on() {}, status: () => ({}), inventory: () => [] },
        { log() {}, event() {} }, { stateFile: STATE });
    assert.strictEqual(brain2.mem.plan.steps[2].status, "blocked", "plan must survive a restart");

    fs.unlinkSync(STATE);
    console.log("PLAN-OK");
    process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
