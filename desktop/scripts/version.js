// The release version, from pyproject.toml — the project's single source of
// truth — so desktop builds track releases without also bumping
// desktop/package.json.
//
// No fallback: this becomes the installed app's version, which the updater
// compares against releases. A build that guessed would offer every release
// as an update, forever.
const fs = require("fs");
const path = require("path");

const pyproject = fs.readFileSync(path.join(__dirname, "..", "..", "pyproject.toml"), "utf8");
const found = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
if (!found) throw new Error("No version = \"...\" line found in pyproject.toml");

module.exports = found[1];
