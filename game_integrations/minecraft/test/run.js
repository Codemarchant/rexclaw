// Test runner: every test_*.js in this folder, each in its own process so a
// crash or a stray timer in one can't take the others down.
//
//   cd game_integrations/minecraft && npm test
//
// Each suite is a plain script that throws on failure and prints "<NAME>-OK"
// when it passes — no framework, nothing to install.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const suites = fs.readdirSync(dir)
    .filter((f) => /^test_.*\.js$/.test(f))
    .sort();

if (!suites.length) {
    console.error("no test_*.js files found");
    process.exit(1);
}

let failed = 0;
for (const file of suites) {
    process.stdout.write(`${file.padEnd(24)} `);
    try {
        const out = execFileSync(process.execPath, [path.join(dir, file)], {
            encoding: "utf8",
            timeout: 120000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        console.log(out.trim().split("\n").pop() || "ok");
    } catch (e) {
        failed += 1;
        console.log("FAILED");
        const detail = `${e.stdout || ""}${e.stderr || ""}`.trim();
        if (detail) console.log(detail.split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n"));
    }
}

// State files the brain persists during a run — never leave them behind for
// the next run to restore from.
for (const f of fs.readdirSync(dir)) {
    if (/_state_test\.json/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
