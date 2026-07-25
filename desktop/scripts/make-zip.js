// Wraps electron-builder's dist/win-unpacked output in a conventionally
// structured zip: everything under a single Rexclaw-<version>-win/ top-level
// folder, so unzipping into Downloads/ doesn't scatter loose files.
//
// Uses the OS bsdtar (ships with Windows 10+ and macOS; `-a` infers zip from
// the extension). Windows-only pipeline for now — mirrors build-runtime.ps1.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Version from pyproject.toml — the project's single source of truth — so
// the zip name tracks releases without also bumping desktop/package.json.
const pyproject = fs.readFileSync(path.join(__dirname, "..", "..", "pyproject.toml"), "utf8");
const version = (pyproject.match(/^version\s*=\s*"([^"]+)"/m)
    || [null, require("../package.json").version])[1];
const dist = path.join(__dirname, "..", "dist");
const src = path.join(dist, "win-unpacked");
const name = `Rexclaw-${version}-win`;
const staged = path.join(dist, name);
const zip = path.join(dist, `${name}.zip`);

if (!fs.existsSync(src)) {
    console.error("dist/win-unpacked missing — electron-builder must run first");
    process.exit(1);
}
fs.rmSync(zip, { force: true });

// Zip through a directory junction named after the release, so the archive
// entries carry `Rexclaw-<version>-win/` without renaming or copying 300 MB.
// (Windows' bsdtar has no -s path substitution, and renaming win-unpacked
// fails with EPERM whenever anything — Explorer, a terminal, Defender —
// holds a handle inside it. A junction sidesteps all of that.)
try { fs.rmdirSync(staged); } catch (e) { /* no stale junction */ }
fs.symlinkSync(src, staged, "junction");
try {
    execFileSync("tar", ["-a", "-c", "-f", zip, name], { cwd: dist, stdio: "inherit" });
} finally {
    fs.rmdirSync(staged);   // removes only the junction, never the target
}
const mb = Math.round(fs.statSync(zip).size / 1024 / 1024);
console.log(`[make-zip] wrote ${zip} (${mb} MB, top-level folder: ${name}/)`);
