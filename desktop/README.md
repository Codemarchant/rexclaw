# Rexclaw desktop shell (Electron)

A thin Electron wrapper: it spawns the existing FastAPI server as a child
process, waits until it answers, and opens a native window on it. The Python
backend and web frontend are completely unchanged — this folder is only the
shell.

## Development

Prerequisites: the normal rexclaw dev setup (run `../run.sh` / `..\run.bat`
once so `.venv` and `web/dist` exist), plus Node.js.

```bash
cd desktop
npm install
npm start
```

Behaviour worth knowing while developing:

- If a rexclaw server is **already running** on the default port (run.sh,
  PyCharm debugger, Docker), the shell attaches to it instead of spawning a
  second one — so you can iterate on the wrapper against a live session.
  It verifies the port actually answers as rexclaw before attaching; an
  unrelated app on 8990 makes the shell spawn its own server on a free port.
- The spawned server inherits your terminal for logs (prefixed `[server]`),
  never auto-opens a browser, and is killed when the last window closes.
- `REXCLAW_PYTHON` overrides interpreter resolution (default: bundled runtime
  when packaged → `../.venv` → `python` on PATH).
- Microphone access is granted at the Electron level (voice mode needs
  `getUserMedia`); external links open in the system browser.
- **Run from native Windows, not the WSL terminal.** Under WSLg Electron's
  GPU process fails to initialize and the whole app falls back to software
  rendering — the avatar visibly jitters. Confirmed: the same scaffold runs
  at full speed launched from PowerShell/cmd. `REXCLAW_GPU_INFO=1 npm start`
  opens `chrome://gpu` alongside the app to check acceleration status.

## Packaging (Windows)

Two steps, both run on Windows (or a windows-latest CI runner — the wheels
must be win_amd64):

```powershell
powershell -ExecutionPolicy Bypass -File build-runtime.ps1   # once, and after dependency changes
npm run dist                                                 # → dist/Rexclaw-<version>-win.zip
```

`build-runtime.ps1` downloads the official Windows embeddable Python
(~45 MB installed), rewrites its `._pth` (which *replaces* `sys.path` and
ignores `PYTHONPATH` — so `Lib\site-packages` and `..\app-server` are listed
explicitly), bootstraps pip, and installs the server dependencies read from
`pyproject.toml`. Only third-party deps go into site-packages — the server
runs from the bundled source tree so its `Path(__file__)`-relative asset
lookups resolve.

`npm run dist` then packages the shell + `server/` + `assets/` + `web/dist`
+ the runtime into a ~320 MB zip. The result is fully standalone: unzip,
run `Rexclaw.exe`, no Python/Node/install required. User state goes to the
per-user app-data folder, never the unzipped directory. The exe is unsigned,
so first launch shows a SmartScreen warning ("More info → Run anyway") until
there's a signing certificate.

The app icon (`build/icon.ico` / `icon.png`) is generated from the PWA icon
(`web/public/icons/icon-512.png`). macOS/Linux packaging is future work —
swap the embeddable package for python-build-standalone in the runtime
script and add per-OS CI jobs.

## Where the packaged app stores data

Standard Windows convention: user state never lives in the unzipped app
folder (so replacing the folder with a new version keeps everything). The
packaged app keeps all state under:

```
%APPDATA%\Rexclaw\data\
├── rexclaw.sqlite3   # settings, companions, sessions, memories
├── files\            # generated/uploaded images
└── avatars\          # custom avatar packs — drop pack folders here
```

Custom avatar packs go in `%APPDATA%\Rexclaw\data\avatars\<PackName>\`
(same pack format as always); packs created in the app's Avatars tab are
written there too. Bundled packs stay read-only inside the app folder at
`resources\app-server\assets\avatars\`. In dev (`npm start`) none of this
applies — the server uses the repo's normal `data/` folder.

## Architecture notes

- `main.js` owns the full lifecycle: resolve Python → spawn uvicorn on the
  default port (or a free one if taken) → poll `GET /` until ready → open
  `BrowserWindow` → SIGTERM the child on quit.
- Data location: in dev the server uses the repo's normal `data/` folder
  (same DB as run.sh). When packaged, `REXCLAW_DATA_DIR` is pointed at the
  per-user app-data directory so state never lives in the install folder.
- Renderer security: `contextIsolation` on, `nodeIntegration` off, no
  preload — the window is just a browser showing the served web app, with a
  permission handler that allows exactly `media` / `fullscreen` / clipboard
  write and denies everything else.
