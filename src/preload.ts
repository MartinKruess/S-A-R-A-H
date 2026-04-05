import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sarah', {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send('splash-done'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  selectFolder: (title?: string) => ipcRenderer.invoke('select-folder', title),
  detectPrograms: () => ipcRenderer.invoke('detect-programs'),
});
