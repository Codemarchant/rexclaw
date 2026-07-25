// Rexclaw desktop shell — Electron wrapper around the FastAPI server.
//
// What it does:
//   1. Finds a Python interpreter (bundled runtime when packaged, else the
//      repo .venv, else PATH) and spawns `python -m uvicorn server.main:app`.
//   2. Polls the server until it answers, then opens a BrowserWindow on it.
//   3. Grants microphone/media permissions (voice mode needs getUserMedia),
//      routes external links to the system browser, and kills the server
//      when the last window closes.
//
// Dev:  cd desktop && npm install && npm start
// If a rexclaw server is already running on the default port (run.sh, PyCharm,
// Docker), the shell attaches to it instead of spawning a second one — handy
// for developing the wrapper against a live session.
const { app, BrowserWindow, dialog, session, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_PORT = parseInt(process.env.REXCLAW_PORT || "8990", 10);
const STARTUP_TIMEOUT_MS = 30000;

// The app is a realtime three.js scene — make sure Chromium actually uses the
// GPU. ignore-gpu-blocklist rescues setups Chromium is over-cautious about;
// the rasterization/zero-copy switches move 2D compositing off the CPU too.
// (If the GPU process still fails — e.g. under WSLg — Chromium falls back to
// software rendering, which is exactly the "avatars jitter" symptom; launch
// from native Windows/macOS/Linux in that case.)
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

let serverProc = null;   // child_process we own (null when attached to external)
let mainWindow = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Python + server management
// ---------------------------------------------------------------------------

/** Resolve the interpreter that runs the server, in preference order:
 *  REXCLAW_PYTHON env → bundled runtime (packaged app) → repo .venv → PATH. */
function resolvePython() {
    if (process.env.REXCLAW_PYTHON) return process.env.REXCLAW_PYTHON;
    const candidates = [];
    if (app.isPackaged) {
        // Phase-2 packaging drops an embedded runtime into resources/python
        // (see electron-builder extraResources in package.json).
        candidates.push(
            path.join(process.resourcesPath, "python",
                      process.platform === "win32" ? "python.exe" : "bin/python3"),
        );
    }
    candidates.push(
        path.join(REPO_ROOT, ".venv",
                  process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"),
    );
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // Last resort: whatever `python` is on PATH. spawn() will surface ENOENT.
    return process.platform === "win32" ? "python" : "python3";
}

/** Server working directory: the repo in dev, the bundled tree when packaged. */
function serverCwd() {
    return app.isPackaged ? path.join(process.resourcesPath, "app-server") : REPO_ROOT;
}

function probe(port, timeoutMs = 1500) {
    // Resolves with the response body of GET / (or rejects) — used both for
    // "is something on this port" and "is that something rexclaw".
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
            let body = "";
            res.on("data", (d) => { body += d; if (body.length > 65536) req.destroy(); });
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("timeout", () => { req.destroy(new Error("timeout")); });
        req.on("error", reject);
    });
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function spawnServer(python, port) {
    const env = { ...process.env, REXCLAW_NO_BROWSER: "1" };
    if (app.isPackaged) {
        // Keep user state out of the install dir: DB, uploads and avatar
        // packs live under the OS per-user app-data folder.
        env.REXCLAW_DATA_DIR = env.REXCLAW_DATA_DIR
            || path.join(app.getPath("userData"), "data");
    }
    const proc = spawn(
        python,
        ["-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", String(port)],
        { cwd: serverCwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    proc.on("exit", (code, signal) => {
        const expected = quitting || signal === "SIGTERM";
        serverProc = null;
        if (!expected) {
            dialog.showErrorBox(
                "Rexclaw server stopped",
                `The backend exited unexpectedly (code ${code}). Check the terminal output; ` +
                `common causes are missing Python dependencies (run run.sh / run.bat once) ` +
                `or another process taking the port.`,
            );
            app.quit();
        }
    });
    return proc;
}

async function waitUntilReady(port) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (quitting) throw new Error("quit during startup");
        try {
            const { status } = await probe(port);
            if (status && status < 500) return;
        } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not answer on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

/** Attach to an already-running rexclaw on the default port, else spawn our
 *  own (on the default port when free, otherwise on an ephemeral one). */
async function ensureServer() {
    try {
        const { body } = await probe(DEFAULT_PORT);
        if (/rexclaw/i.test(body || "")) {
            console.log(`[desktop] attaching to existing server on :${DEFAULT_PORT}`);
            return DEFAULT_PORT;
        }
        console.warn(`[desktop] port ${DEFAULT_PORT} is taken by something else — using a free port`);
    } catch (e) { /* nothing on the default port — we'll own the server */ }

    let port = DEFAULT_PORT;
    try {
        await probe(DEFAULT_PORT);
        port = await findFreePort();   // default port occupied by a non-rexclaw app
    } catch (e) { /* default port free — use it so PWA installs keep one origin */ }

    const python = resolvePython();
    console.log(`[desktop] starting server: ${python} (port ${port})`);
    serverProc = spawnServer(python, port);
    await waitUntilReady(port);
    return port;
}

function stopServer() {
    if (serverProc) {
        try { serverProc.kill("SIGTERM"); } catch (e) { /* already gone */ }
        serverProc = null;
    }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 720,
        minHeight: 520,
        title: "Rexclaw Companions",
        backgroundColor: "#0f172a",
        autoHideMenuBar: true,
        webPreferences: {
            // The UI is the served web app — no Node access in the renderer.
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            // Keep the render loop (and a live voice call) at full rate even
            // when the window loses focus.
            backgroundThrottling: false,
        },
    });

    // Diagnosis aid: REXCLAW_GPU_INFO=1 opens Chromium's GPU status page in a
    // second window. "Graphics Feature Status" should be all green
    // (Hardware accelerated); "Software only" entries explain avatar jitter.
    if (process.env.REXCLAW_GPU_INFO === "1") {
        const gpuWin = new BrowserWindow({ width: 900, height: 700, title: "GPU status" });
        gpuWin.loadURL("chrome://gpu");
    }

    // Voice mode needs the microphone; fullscreen is used by immersive view.
    // Everything else is denied — the app has no use for geolocation etc.
    const ses = mainWindow.webContents.session;
    ses.setPermissionRequestHandler((wc, permission, callback) => {
        callback(["media", "fullscreen", "clipboard-sanitized-write"].includes(permission));
    });
    ses.setPermissionCheckHandler((wc, permission) => {
        return ["media", "fullscreen", "clipboard-sanitized-write"].includes(permission);
    });

    // target=_blank / external links (x.ai, GitHub, …) → system browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return { action: "allow" };
        shell.openExternal(url);
        return { action: "deny" };
    });

    mainWindow.on("closed", () => { mainWindow = null; });
    mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        try {
            const port = await ensureServer();
            createWindow(port);
            app.on("activate", () => {   // macOS dock re-activation
                if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
            });
        } catch (err) {
            dialog.showErrorBox(
                "Rexclaw failed to start",
                `${err.message}\n\nIf this is the first run, execute run.sh / run.bat once ` +
                `so the Python environment and frontend are built.`,
            );
            app.quit();
        }
    });

    app.on("window-all-closed", () => {
        // The server is the app — no reason to keep it warm in the background
        // on any platform, macOS included.
        app.quit();
    });

    app.on("before-quit", () => { quitting = true; stopServer(); });
    process.on("exit", stopServer);
}
