# Rexclaw mini-games

Every game is a folder. The library (`index.html`) lists each folder that has a
`game.json`, so a game can be one page or a whole project with scripts,
models, sounds and textures. Built-in games live here; an extension's games
live in its own static folder and are listed the same way.

```
games/
  lib/                  the kit every game shares
    neuro.js            RexGame.create(): Neuro API client, saves, modes, settings, chat dock
    kit.css             the look of what the kit puts on a page (loaded by neuro.js itself)
    juice.js            RexGame.sfx (synthesised sounds) and RexGame.fx (confetti, gulls...)
    music.js            RexGame.music: a synth band, every track written as data
    scenes.js           RexGame.scenes: animated backdrops (night, storm, tavern...)
    crew.js, crew/      the Rexmaw crew's cameo lines, recorded in their own voices
    lines.js            the companions' reaction lines (recorded per companion)
    games.css           OPTIONAL: the Rexmaw table theme (header, panels, felt)
    vendor/three/       three.js, copied in at build time (see below)
  broadside/            a 3D game with a look of its own: js/ modules, no games.css
  connect-four/
    game.json           what the library shows
    cover.svg           the tile's art
    index.html          the entry page
  my-big-game/
    game.json
    cover.png
    index.html
    js/main.js          anything else the game needs
    assets/ship.glb
```

## game.json

```json
{
  "title": "Connect Four",
  "description": "One or two sentences for the tile.",
  "tags": ["strategy", "board"],
  "cover": "cover.svg",
  "background": "linear-gradient(135deg,#2563eb,#1e3a8a)",
  "entry": "index.html",
  "order": 10,
  "save_key": "Connect Four"
}
```

Only `title` is required. `entry` defaults to `index.html`. `cover` is any
image in the folder (`icon`, an emoji, is the fallback). `order` sorts the
library (lower first). `save_key` is the name the page passes to
`RexGame.create({ name })`, which its saves and the library's records are
filed under; it defaults to the title.

## The page

Only `neuro.js` is required; it loads `kit.css` for its own widgets. Take the
rest as you like: `games.css` gives the shared table look, and a game with
a look of its own (Broadside) simply leaves it out.

```html
<link rel="stylesheet" href="../lib/games.css">   <!-- optional theme -->
<script src="../lib/neuro.js"></script>
<script src="../lib/juice.js"></script>    <!-- sound effects, confetti -->
<script src="../lib/music.js"></script>    <!-- background music -->
<script src="../lib/scenes.js"></script>   <!-- animated backdrops -->
<script src="../lib/crew.js"></script>     <!-- the crew's cameos -->
<script src="../lib/lines.js"></script>    <!-- the companion's reactions -->
<script>
const game = RexGame.create({
  name: "My game",                       // what the companion sees, and the save key
  rules: "How to play, told to the companion once.",
  actions: [{ name: "make_move", description: "...", schema: { type: "object", properties: {...} } }],
  onAction(name, data) { /* validate, apply, return a short result; throw new RexGame.Refuse("why") */ },
  modes: [{ id: "classic", label: "Classic", hint: "..." }],   // optional tabs, remembered
  onMode(id) { /* restart in that mode */ },
  music: ["brine-barnacle", "candlelight-bluff"],   // tracks from music.js, picked in ⚙
  scenes: ["tavern", "night", "storm"],            // backdrops from scenes.js, picked in ⚙
  ui: { recordInto: el, modesInto: el },          // place the kit's furniture yourself
  onAgain() { /* the result screen's Play again */ },
  onLoad(saved) { /* the save arrived: restore anything you keep */ },
});
game.force({ state, query, actions: ["make_move"] });   // the companion's turn
game.tell("Something happened.", /* silent */ true);
game.award(20, "Nice!", element);                        // doubloons, with a pop
game.end({ outcome: "win", points: 100, detail: "..." }); // record, sound, confetti, result screen
game.react("they_win");                                  // the companion's line (lines.js)
game.heckle("splash");                                   // a crew cameo (crew/lines.json)
game.save({ anything: "you like" });                     // per companion, up to 64 KB
</script>
```

A new music track is a few lines of data in `music.js` (tempo, metre, a
chord per bar, parts with rhythms); its melody is composed from its seed.
New crew lines go in `crew/lines.json`, then
`python tools/games/bake_crew_voices.py --db <the app's database>` records
them in the crew's voices (only the missing ones).

Pages use relative paths (`../lib/`) inside this folder; an extension's
pages use absolute ones (`/games/lib/neuro.js`).

Write the state for a companion on a voice call: short, and with the
obvious facts spelled out ("you can win in column 5") rather than left to be
worked out. Read every move forgivingly ("five", "Rock", "8 of hearts").

## Bigger games, three.js

The app's own three.js is copied to `lib/vendor/three/` when the web app is
built (`npm run build`), with its addons, so 3D games work offline and match
the app's version:

```html
<script type="importmap">
{ "imports": {
    "three": "/games/lib/vendor/three/three.module.min.js",
    "three/addons/": "/games/lib/vendor/three/addons/" } }
</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
</script>
```

Plain ES modules work as they are (`<script type="module" src="js/main.js">`).
A game that needs a bundler can build into its folder and ship the output.

## Games in an extension

An extension (see Rexclaw's README, "Extensions") lists its games by putting
game folders in its static folder:

```python
from pathlib import Path

def setup(api):
    api.add_static(Path(__file__).parent / 'games')   # games/<game>/game.json ...
```

Each `games/<game>/` with a `game.json` appears in the library under the
extension's name, served at `/plugins/<extension id>/<game>/`. That is the way
to keep private games (or ones for grown-ups) out of the app's own folder.
