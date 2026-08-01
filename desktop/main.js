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
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
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
let serverPort = DEFAULT_PORT;   // resolved by ensureServer(); VR handoff needs it
let serverScheme = "http";       // https when headset access is on
let externalServer = false;      // attached to a server we didn't spawn
let headsetAccess = false;       // persisted toggle: HTTPS + LAN bind for headset browsers
let restartInFlight = false;     // toggle restart underway — child exits are ours to handle
let mainWindow = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Shell settings (persisted under userData)
// ---------------------------------------------------------------------------

function settingsPath() {
    return path.join(app.getPath("userData"), "shell-settings.json");
}

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch (e) { return {}; }
}

function saveSettings(patch) {
    try {
        const merged = { ...loadSettings(), ...patch };
        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
    } catch (e) {
        console.error("[desktop] settings save failed:", e);
    }
}

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

function probe(port, timeoutMs = 1500, scheme = "http") {
    // Resolves with the response body of GET / (or rejects) — used both for
    // "is something on this port" and "is that something rexclaw".
    return new Promise((resolve, reject) => {
        const mod = scheme === "https" ? https : http;
        const opts = { host: "127.0.0.1", port, path: "/", timeout: timeoutMs };
        // Headset access serves the app's own self-signed cert.
        if (scheme === "https") opts.rejectUnauthorized = false;
        const req = mod.get(opts, (res) => {
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
    if (headsetAccess) {
        // HTTPS + LAN bind so a headset browser on the same WiFi can
        // connect (WebXR/mic need a secure origin). The server generates
        // its self-signed cert under the data dir.
        env.REXCLAW_SSL = "1";
        env.REXCLAW_HOST = "0.0.0.0";
    }
    if (app.isPackaged) {
        // Keep user state out of the install dir: DB, uploads and avatar
        // packs live under the OS per-user app-data folder.
        env.REXCLAW_DATA_DIR = env.REXCLAW_DATA_DIR
            || path.join(app.getPath("userData"), "data");
    }
    // Headset mode goes through server.main (it resolves/generates the TLS
    // cert itself; the uvicorn CLI doesn't read the REXCLAW_SSL vars).
    const args = headsetAccess
        ? ["-m", "server.main"]
        : ["-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", String(port)];
    if (headsetAccess) env.REXCLAW_PORT = String(port);
    const proc = spawn(
        python,
        args,
        { cwd: serverCwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    proc.on("exit", (code, signal) => {
        // restartInFlight: the headset toggle owns this exit — its rollback
        // reports failures; the crash dialog would quit the app mid-recovery.
        const expected = quitting || restartInFlight || signal === "SIGTERM";
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
        // Fail fast when the child we're waiting on already died (e.g. a
        // bad config) instead of polling out the full timeout.
        if (!externalServer && serverProc === null) {
            throw new Error("server exited during startup — check the terminal output");
        }
        try {
            const { status } = await probe(port, 1500, serverScheme);
            if (status && status < 500) return;
        } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not answer on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

/** Attach to an already-running rexclaw on the default port, else spawn our
 *  own (on the default port when free, otherwise on an ephemeral one). */
async function ensureServer() {
    // A dev server may be serving either protocol (REXCLAW_SSL) — probe both.
    for (const scheme of ["http", "https"]) {
        try {
            const { body } = await probe(DEFAULT_PORT, 1500, scheme);
            if (/rexclaw/i.test(body || "")) {
                console.log(`[desktop] attaching to existing ${scheme} server on :${DEFAULT_PORT}`);
                externalServer = true;
                serverScheme = scheme;
                return DEFAULT_PORT;
            }
            console.warn(`[desktop] port ${DEFAULT_PORT} is taken by something else — using a free port`);
            break;
        } catch (e) { /* nothing speaking this protocol on the default port */ }
    }
    serverScheme = headsetAccess ? "https" : "http";

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
// VR handoff
// ---------------------------------------------------------------------------
// WebXR is compiled out of Electron (checkout_webxr off in DEPS →
// enable_vr=false; electron/electron#35011), so the shell can never present
// an immersive session itself. "Enter VR" in the UI instead opens the same
// origin in a real Chromium browser in --app mode: a chromeless standalone
// window with full WebXR over whatever OpenXR runtime is active (SteamVR,
// VDXR/Virtual Desktop, Oculus). Same server, same session data.

/** Read a string value from the Windows registry via reg.exe (no native
 *  deps). Resolves null when the key/value doesn't exist. Pass no valueName
 *  to read the key's default value. */
function regQuery(key, valueName) {
    return new Promise((resolve) => {
        execFile("reg", ["query", key, ...(valueName ? ["/v", valueName] : ["/ve"])],
                 { windowsHide: true }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const m = stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
            resolve(m ? m[1].trim().replace(/^"|"$/g, "") : null);
        });
    });
}

/** First installed Chromium browser that can run WebXR. Chrome is preferred
 *  (broadest runtime support), Edge is the ships-with-Windows guarantee.
 *  Resolution goes through the App Paths registry — the mechanism installers
 *  use to register an executable's real location, wherever it was installed
 *  (HKCU covers per-user installs) — with the conventional paths only as a
 *  fallback for unregistered copies. Desktop WebXR is OpenXR-on-Windows
 *  only, so other platforms return null and the caller falls back to the
 *  default browser. */
async function findVRBrowser() {
    if (process.platform !== "win32") return null;
    for (const exe of ["chrome.exe", "msedge.exe"]) {
        for (const hive of ["HKCU", "HKLM"]) {
            const p = await regQuery(
                `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`);
            if (p && fs.existsSync(p)) return p;
        }
    }
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const candidates = [
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
            : null,
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    return candidates.filter(Boolean).find((c) => fs.existsSync(c)) || null;
}

/** True when an OpenXR runtime (SteamVR, VDXR/Virtual Desktop, Oculus, …)
 *  is registered as active — without one, desktop WebXR has no headset to
 *  present to and the handoff button would be a dead end. */
async function hasOpenXRRuntime() {
    if (process.platform !== "win32") return false;
    const manifest = await regQuery("HKLM\\SOFTWARE\\Khronos\\OpenXR\\1", "ActiveRuntime");
    return !!(manifest && fs.existsSync(manifest));
}

// The UI shows its VR button only when this resolves true — mirrors the
// browser behaviour of probing isSessionSupported() before offering VR.
ipcMain.handle("vr-available", async () => {
    return (await hasOpenXRRuntime()) && !!(await findVRBrowser());
});

ipcMain.handle("open-vr-handoff", async () => {
    // #vr tells the page to auto-enter the immersive session once the
    // avatar is up; the presentation-gesture switch lets that happen
    // without a click (if a future Chrome drops the switch, the auto-enter
    // fails quietly and the in-page VR button still works).
    const url = `${serverScheme}://127.0.0.1:${serverPort}/#vr`;
    const browser = await findVRBrowser();
    if (browser) {
        console.log(`[desktop] VR handoff → ${browser}`);
        const proc = spawn(
            browser,
            ["--disable-gesture-requirement-for-presentation", `--app=${url}`],
            { detached: true, stdio: "ignore" },
        );
        proc.unref();
        return path.basename(browser);
    }
    // No Chromium browser found — a default-browser tab still beats nothing.
    shell.openExternal(url);
    return "external";
});

// ---------------------------------------------------------------------------
// Headset access (HTTPS + LAN bind so a headset browser can connect)
// ---------------------------------------------------------------------------

/** The LAN address a headset would dial — prefer the classic home ranges so
 *  virtual adapters (Hyper-V, VPN) don't win. Best-effort; null when offline. */
function lanIP() {
    const addrs = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
            if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) {
                addrs.push(i.address);
            }
        }
    }
    return addrs.find((a) => a.startsWith("192.168."))
        || addrs.find((a) => a.startsWith("10."))
        || addrs[0] || null;
}

function headsetInfo() {
    const ip = lanIP();
    return {
        enabled: headsetAccess,
        external: externalServer,
        url: headsetAccess && ip ? `https://${ip}:${serverPort}/` : null,
    };
}

ipcMain.handle("headset-info", () => headsetInfo());

ipcMain.handle("headset-toggle", async () => {
    if (externalServer) {
        return { ...headsetInfo(),
                 error: "The server is running outside the app — set REXCLAW_SSL/REXCLAW_HOST there instead." };
    }
    const previous = headsetAccess;
    headsetAccess = !headsetAccess;
    try {
        await restartServer();
        saveSettings({ headsetAccess });
    } catch (err) {
        // Roll back so a failed HTTPS start doesn't strand the app.
        headsetAccess = previous;
        try { await restartServer(); } catch (e2) { /* reported below either way */ }
        return { ...headsetInfo(), error: `Could not switch modes: ${err.message}` };
    }
    if (mainWindow) mainWindow.loadURL(`${serverScheme}://127.0.0.1:${serverPort}/`);
    return headsetInfo();
});

/** Kill the owned server and resolve once it has actually exited — spawning
 *  the replacement before the old process releases the port makes uvicorn
 *  die with a bind error (exit code 3). */
function stopServerAndWait(timeoutMs = 5000) {
    return new Promise((resolve) => {
        const proc = serverProc;
        if (!proc) return resolve();
        const hardKill = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch (e) { /* already gone */ }
        }, timeoutMs);
        proc.once("exit", () => { clearTimeout(hardKill); resolve(); });
        try { proc.kill("SIGTERM"); } catch (e) { clearTimeout(hardKill); resolve(); }
    });
}

async function restartServer() {
    restartInFlight = true;
    try {
        await stopServerAndWait();
        // Small grace so the OS finishes releasing the listener.
        await new Promise((r) => setTimeout(r, 300));
        serverScheme = headsetAccess ? "https" : "http";
        serverProc = spawnServer(resolvePython(), serverPort);
        await waitUntilReady(serverPort);
    } finally {
        restartInFlight = false;
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
            // The UI is the served web app — no Node access in the renderer;
            // the preload exposes only the VR handoff bridge.
            preload: path.join(__dirname, "preload.js"),
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
    mainWindow.loadURL(`${serverScheme}://127.0.0.1:${port}/`);
}

// Headset mode serves the app's own self-signed certificate — trust it for
// loopback only; anything else keeps Chromium's normal verdict.
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    let host = "";
    try { host = new URL(url).hostname; } catch (e) { /* fall through to deny */ }
    if (host === "127.0.0.1" || host === "localhost") {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

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
            // Drop the HTTP cache before the first load. The server didn't
            // always send Cache-Control on index.html, so shells that ran an
            // older version can have a heuristically-cached entry page (and
            // through it, the old hashed bundles) — which no one ever
            // force-reloads in an app window. Clearing only the HTTP cache
            // keeps localStorage (locale, UI prefs) intact, and costs
            // nothing meaningful against a localhost server.
            await session.defaultSession.clearCache();
            headsetAccess = !!loadSettings().headsetAccess;
            const port = await ensureServer();
            serverPort = port;
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
