// Runs electron-builder for Windows: dist/win-unpacked (zipped by
// make-zip.js, pushed to itch.io by CI) and the installer with its update
// metadata (Rexclaw-<version>-win-setup.exe, its .blockmap, latest.yml).
//
// The app version is set from pyproject.toml here because the in-app updater
// compares it against the release: a build left at desktop/package.json's
// version would see every release as newer.
//
// --publish never: CI attaches the files with `gh release upload`. Left to
// its default, electron-builder tries to publish by itself on a tag build.
const { execFileSync } = require("child_process");
const path = require("path");
const version = require("./version");

execFileSync(
    process.execPath,
    [
        require.resolve("electron-builder/cli.js"),
        "--win",
        "--publish", "never",
        `-c.extraMetadata.version=${version}`,
    ],
    { cwd: path.join(__dirname, ".."), stdio: "inherit" },
);
