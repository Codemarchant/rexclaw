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
    // Tray "Hide avatar controls" pin — initial value + change pushes.
    mascotControlsHidden: () => ipcRenderer.invoke("mascot-controls-hidden"),
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
});
