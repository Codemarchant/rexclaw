// Bridge for the served web app. WebXR is compiled out of Electron
// (electron/electron#35011), so the UI needs a way to ask the shell to open
// the app in a VR-capable browser instead. Nothing else is exposed — the
// renderer stays a plain web page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rexclawDesktop", {
    // True when the machine can actually present VR: an active OpenXR
    // runtime is registered AND a WebXR-capable browser is installed.
    vrAvailable: () => ipcRenderer.invoke("vr-available"),
    // Resolves with the browser used ("chrome.exe" / "msedge.exe" /
    // "external" for the default-browser fallback).
    openVR: () => ipcRenderer.invoke("open-vr-handoff"),
    // Headset access: {enabled, external, url, error?}. Toggling restarts
    // the bundled server (HTTPS + LAN bind) and reloads the window.
    headsetInfo: () => ipcRenderer.invoke("headset-info"),
    headsetToggle: () => ipcRenderer.invoke("headset-toggle"),
    // Desktop mascot: pop the avatar out into a small frameless transparent
    // always-on-top window (loads /#mascot in a second BrowserWindow and
    // hides this one). resume:true → the mascot page auto-resumes the
    // session the caller just ended.
    openMascot: (opts) => ipcRenderer.invoke("mascot-open", opts || {}),
    // Screen-share handoff across pop-out/in: the leaving window sets the
    // flag when its share is armed; the arriving window takes it (once) and
    // silently re-arms the same source. take resolves {id, audio} or null.
    shareHandoffSet: () => ipcRenderer.invoke("share-handoff-set"),
    shareHandoffTake: () => ipcRenderer.invoke("share-handoff-take"),
    // Called FROM the mascot window: restore the main window (telling it
    // whether to resume the call) and close this one.
    closeMascot: (opts) => ipcRenderer.invoke("mascot-close", opts || {}),
    setMascotPin: (flag) => ipcRenderer.invoke("mascot-pin", !!flag),
    setMascotSize: (size) => ipcRenderer.invoke("mascot-size", size || {}),
    // Ghost mode: while on, the shell streams global cursor positions
    // (window-relative) and the page decides per-region/per-pixel whether
    // the window should ignore mouse events.
    setMascotGhost: (on) => ipcRenderer.invoke("mascot-ghost", !!on),
    setMascotIgnoreMouse: (on) => ipcRenderer.invoke("mascot-ignore-mouse", !!on),
    // Grab-the-character dragging: origin fetch + absolute position stream +
    // end (restores the non-resizable lock the drag temporarily lifts).
    mascotDragStart: () => ipcRenderer.invoke("mascot-drag-start"),
    mascotDragMove: (pos) => ipcRenderer.invoke("mascot-drag-move", pos || {}),
    mascotDragEnd: () => ipcRenderer.invoke("mascot-drag-end"),
    // Snap the overlay to a corner of its current display, or send it to the
    // next monitor (keeping the corner it sits in).
    alignMascot: (corner) => ipcRenderer.invoke("mascot-align", corner),
    mascotNextDisplay: () => ipcRenderer.invoke("mascot-next-display"),
    // "Hide avatar between calls": setting get/set + push, and the raw
    // window visibility call the mascot page drives from its call state.
    mascotHideIdle: () => ipcRenderer.invoke("mascot-hide-idle-get"),
    setMascotHideIdle: (flag) => ipcRenderer.invoke("mascot-hide-idle-set", !!flag),
    onMascotHideIdle: (cb) => {
        ipcRenderer.removeAllListeners("mascot-hide-idle");
        ipcRenderer.on("mascot-hide-idle", (event, flag) => cb(flag));
    },
    setMascotVisible: (on) => ipcRenderer.invoke("mascot-visible", !!on),
    // Tray "Hide avatar controls" pin — initial value, setter, change pushes.
    mascotControlsHidden: () => ipcRenderer.invoke("mascot-controls-hidden"),
    setMascotControlsHidden: (flag) => ipcRenderer.invoke("mascot-controls-hidden-set", !!flag),
    // "Open in mascot mode": open straight into the desktop overlay at launch.
    startupMascot: () => ipcRenderer.invoke("startup-mascot-get"),
    setStartupMascot: (flag) => ipcRenderer.invoke("startup-mascot-set", !!flag),
    // Hotkeys. setGlobalHotkeys replaces the OS-wide registration wholesale
    // ([{action, accelerator}]) and resolves {registered, failed};
    // runHotkeyAction asks the shell to perform the actions it owns (window
    // placement, the pop-out handoff, the transcript window); onHotkeyAction
    // receives the ones this window should perform.
    setGlobalHotkeys: (list) => ipcRenderer.invoke("set-global-hotkeys", list || []),
    runHotkeyAction: (action) => ipcRenderer.invoke("run-hotkey-action", action),
    onHotkeyAction: (cb) => {
        ipcRenderer.removeAllListeners("hotkey-action");
        ipcRenderer.on("hotkey-action", (event, action) => cb(action));
    },
    onMascotControlsHidden: (cb) => {
        ipcRenderer.removeAllListeners("mascot-controls-hidden");
        ipcRenderer.on("mascot-controls-hidden", (event, flag) => cb(flag));
    },
    // Push channels. Re-registering replaces the previous callback (single
    // subscriber — survives React remounts/HMR).
    onMascotReturned: (cb) => {
        ipcRenderer.removeAllListeners("mascot-returned");
        ipcRenderer.on("mascot-returned", (event, data) => cb(data));
    },
    onMascotCursor: (cb) => {
        ipcRenderer.removeAllListeners("mascot-cursor");
        ipcRenderer.on("mascot-cursor", (event, data) => cb(data));
    },
    onMascotPopoutRequest: (cb) => {
        ipcRenderer.removeAllListeners("mascot-popout-request");
        ipcRenderer.on("mascot-popout-request", () => cb());
    },
    onMascotPopbackRequest: (cb) => {
        ipcRenderer.removeAllListeners("mascot-popback-request");
        ipcRenderer.on("mascot-popback-request", () => cb());
    },
    // Tray "Ghost mode" → the page toggles (it owns the ghost machinery and
    // the persisted pref; the shell's checkbox follows via the mascot-ghost
    // IPC the toggle itself makes).
    onMascotGhostRequest: (cb) => {
        ipcRenderer.removeAllListeners("mascot-ghost-request");
        ipcRenderer.on("mascot-ghost-request", () => cb());
    },
});
