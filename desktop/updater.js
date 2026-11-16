// In-app updates for the Windows installer build: electron-updater reading
// the project's GitHub releases (latest.yml, attached by CI).
//
// Only a copy the installer put in place updates itself. The zip is a folder
// the user replaces by hand and itch.io patches its own copy; an update run
// from either would install a second copy somewhere else.
//
// Nothing downloads or installs without a yes: an update is the whole app,
// and installing it restarts Rexclaw.
const { app, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const RELEASES_URL = "https://github.com/Codemarchant/rexclaw/releases";

/** True for a copy made by the installer, which leaves its uninstaller
 *  beside the executable ("Uninstall <executable name>.exe", UNINSTALL_FILENAME
 *  in electron-builder's NSIS template). */
function isInstalledBuild() {
    if (process.platform !== "win32" || !app.isPackaged) return false;
    const exe = process.execPath;
    return fs.existsSync(path.join(path.dirname(exe), `Uninstall ${path.basename(exe, ".exe")}.exe`));
}

/** electron-updater puts the whole HTTP response into some messages. */
function shortError(err) {
    return String((err && err.message) || err).split("\n")[0].slice(0, 300);
}

/** Returns null when this copy does not update itself, else
 *  `{ check, menuItem }`.
 *
 *  getWindow:  the main window, for the dialogs and the taskbar progress.
 *  onChange:   the state changed, so menuItem() reads differently.
 *  stopServer: end the backend and resolve once it has exited, right before
 *              the installer starts replacing files.
 *  hasUnsavedEdits: whether the main window holds edits not yet saved. */
function createUpdater({ getWindow, onChange, stopServer, hasUnsavedEdits }) {
    if (!isInstalledBuild()) return null;
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    // No silent install at quit: it would replace the app with nothing on
    // screen, and opening Rexclaw again meanwhile starts a half-written copy.
    autoUpdater.autoInstallOnAppQuit = false;

    let state = "idle";     // idle | checking | available | downloading | ready
    let version = null;     // the update's version, once one is found
    let percent = 0;
    let askedByUser = false;   // this check came from the menu: report its result
    let installing = false;    // the backend is stopped for the installer

    function set(next) {
        state = next;
        onChange();
    }

    function ask(options) {
        const win = getWindow();
        return win && !win.isDestroyed() && win.isVisible()
            ? dialog.showMessageBox(win, options)
            : dialog.showMessageBox(options);
    }

    function setProgress(fraction) {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.setProgressBar(fraction);
    }

    function check(byUser = false) {
        if (byUser) {
            // Asked while something is already under way: say where it stands.
            if (state === "available") { offerDownload(); return; }
            if (state === "ready") { offerInstall(); return; }
            if (state === "downloading") {
                ask({
                    type: "info",
                    message: `Downloading Rexclaw ${version}: ${percent}%`,
                    detail: "You are asked again when it is ready to install.",
                });
                return;
            }
            // The check under way now answers to the user too.
            if (state === "checking") { askedByUser = true; return; }
        }
        if (state !== "idle") return;
        askedByUser = byUser;
        set("checking");
        autoUpdater.checkForUpdates().catch(() => { /* the error event reports it */ });
    }

    function download() {
        if (state !== "available") return;
        percent = 0;
        set("downloading");
        autoUpdater.downloadUpdate().catch(() => { /* the error event reports it */ });
    }

    async function install() {
        if (state !== "ready" || installing) return;
        installing = true;
        await stopServer();
        // Not silent: the installer shows its progress, and its last page
        // opens Rexclaw again.
        autoUpdater.quitAndInstall(false, true);
    }

    async function offerDownload() {
        for (;;) {
            const { response } = await ask({
                type: "info",
                message: `Rexclaw ${version} is available`,
                detail: `You have ${app.getVersion()}. The download runs in the background, ` +
                    `and nothing is installed until you say so.`,
                buttons: ["Download", "What's new", "Later"],
                defaultId: 0,
                cancelId: 2,
            });
            if (response !== 1) {
                if (response === 0) download();
                return;
            }
            shell.openExternal(`${RELEASES_URL}/tag/v${version}`);
        }
    }

    async function offerInstall() {
        // Installing quits past the window's own Save / Discard question.
        const lost = hasUnsavedEdits()
            ? "A call in progress ends, and the changes you have not saved are lost. "
            : "A call in progress ends. ";
        const { response } = await ask({
            type: "info",
            message: `Rexclaw ${version} is ready to install`,
            detail: "Rexclaw closes and the installer takes over; it opens Rexclaw again when it is done. " +
                lost + "With Later, the tray menu keeps \"Restart to install update\".",
            buttons: ["Restart and install", "Later"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) install();
    }

    autoUpdater.on("update-available", (info) => {
        version = info.version;
        askedByUser = false;
        set("available");
        offerDownload();
    });

    autoUpdater.on("update-not-available", () => {
        set("idle");
        if (askedByUser) {
            ask({ type: "info", message: "Rexclaw is up to date", detail: `Version ${app.getVersion()}.` });
        }
        askedByUser = false;
    });

    // Progress goes to the taskbar, not the tray menu: rebuilding the menu on
    // every step would disturb it while it is open.
    autoUpdater.on("download-progress", (progress) => {
        setProgress(progress.percent / 100);
        percent = Math.floor(progress.percent);
    });

    autoUpdater.on("update-downloaded", () => {
        setProgress(-1);
        set("ready");
        offerInstall();
    });

    autoUpdater.on("error", (err) => {
        console.warn("[updater]", shortError(err));
        if (installing) {
            // The installer never started and the backend is already gone:
            // start over on the version that is installed.
            dialog.showErrorBox(
                "The update could not be installed",
                `${shortError(err)}\n\nRexclaw restarts now. You can get the installer from ${RELEASES_URL}`,
            );
            app.relaunch();
            app.quit();
            return;
        }
        const failed = state;
        setProgress(-1);
        if (failed === "checking") set("idle");
        else if (failed === "downloading") set("available");
        // The check at launch fails quietly: offline, or a release whose
        // files CI is still attaching. A step the user asked for says why.
        if (failed === "downloading" || askedByUser) {
            dialog.showErrorBox(
                failed === "downloading" ? "The update could not be downloaded" : "Could not check for updates",
                `${shortError(err)}\n\nTry again later, or get the installer from ${RELEASES_URL}`,
            );
        }
        askedByUser = false;
    });

    /** The tray menu's update entry, for the current state. */
    function menuItem() {
        switch (state) {
            case "checking":
                return { label: "Checking for updates…", enabled: false };
            case "available":
                return { label: `Download update ${version}`, click: download };
            case "downloading":
                return { label: `Downloading update ${version}…`, enabled: false };
            case "ready":
                // Through the question, never straight to the installer.
                return { label: `Restart to install update ${version}`, click: () => offerInstall() };
            default:
                return { label: "Check for updates…", click: () => check(true) };
        }
    }

    return { check, menuItem };
}

module.exports = { createUpdater };
