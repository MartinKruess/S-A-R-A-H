import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("sarah", {
  version: process.versions.electron,
});
