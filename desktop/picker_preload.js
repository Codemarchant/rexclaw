// Preload for the screen-share picker window: exposes exactly one call —
// the user's source choice (or null for cancel) — to the picker page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rexclawPicker", {
    choose: (sourceId) => ipcRenderer.send("rexclaw-screen-pick", sourceId),
});
