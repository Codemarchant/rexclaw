// The interrupt injector rewrites model-authored code before it runs, so a
// bug here corrupts valid scripts. Strings, templates, comments and escapes
// must all survive untouched.
"use strict";
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// Module-private — lift it out of the source to exercise it directly.
const src = fs.readFileSync(path.join(__dirname, "..", "brain.js"), "utf8");
const start = src.indexOf("function injectInterruptChecks");
const end = src.indexOf("\n}", start) + 2;
assert.ok(start > 0 && end > start, "could not locate injectInterruptChecks");
const injectInterruptChecks = new Function(`${src.slice(start, end)}; return injectInterruptChecks;`)();

const CASES = [
    ["plain statements", 'await chat("hi");\nawait wait(1);\n', 2],
    ["semicolon inside a string", 'await chat("one; \\n two");\n', 1],
    ["semicolon inside a template", 'const s = `a;\nb`;\nawait chat(s);\n', 2],
    ["template with interpolation", 'const s = `at ${x};\n${y}`;\nlog(s);\n', 2],
    ["trailing line comment", 'await chat("x");  // note; \nlog(1);\n', 2],
    ["block comment", '/* a;\n b; */\nlog(1);\n', 1],
    ["for-loop header is not a statement end", 'for (let i = 0; i < 3; i++) {\n  await mineAt(1, 2, 3);\n}\n', 1],
    ["escaped quote", 'await chat("say \\"hi\\"; ok");\n', 1],
];

for (const [name, code, expected] of CASES) {
    const out = injectInterruptChecks(code);
    const count = (out.match(/if \(__stop\(\)\) return;/g) || []).length;
    assert.strictEqual(count, expected, `${name}: expected ${expected} checks, got ${count}\n${out}`);
    new vm.Script(`(async () => {\n${out}\n})()`);   // must still compile
}

// The injected checks must actually stop a pure-JS loop mid-flight.
let stopped = false;
const sandbox = { __stop: () => stopped, out: [] };
const code = injectInterruptChecks("for (let i = 0; i < 5; i++) {\n  out.push(i);\n}\n");
const ctx = vm.createContext(sandbox);
new vm.Script(`(async () => {\n${code}\n})()`).runInContext(ctx);
assert.deepStrictEqual(sandbox.out, [0, 1, 2, 3, 4], "runs to completion when not stopped");

stopped = true;
sandbox.out.length = 0;
new vm.Script(`(async () => {\n${code}\n})()`).runInContext(ctx);
assert.deepStrictEqual(sandbox.out, [0], "stops at the first check after the abort");

console.log("INJECT-OK");
