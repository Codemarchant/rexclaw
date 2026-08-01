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
});
