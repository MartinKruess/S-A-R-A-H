import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sarah", {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send("splash-done"),
});
