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
  scanFolderExes: (folderPath: string) => ipcRenderer.invoke('scan-folder-exes', folderPath),
  openDialog: (view: string) => ipcRenderer.invoke('open-dialog', view),

  // Chat API
  chat: (message: string) => ipcRenderer.invoke('chat-message', message),
  onChatChunk: (callback: (data: { text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  onChatDone: (callback: (data: { fullText: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { fullText: string }) => callback(data);
    ipcRenderer.on('llm:done', handler);
    return () => ipcRenderer.removeListener('llm:done', handler);
  },
  onChatError: (callback: (data: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('llm:error', handler);
    return () => ipcRenderer.removeListener('llm:error', handler);
  },
});
