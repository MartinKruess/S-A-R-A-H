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

  // Voice API
  voice: {
    getState: () => ipcRenderer.invoke('voice-get-state') as Promise<string>,
    onStateChange: (callback: (data: { state: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { state: string }) => callback(data);
      ipcRenderer.on('voice:state', handler);
      return () => ipcRenderer.removeListener('voice:state', handler);
    },
    onTranscript: (callback: (data: { text: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
      ipcRenderer.on('voice:transcript', handler);
      return () => ipcRenderer.removeListener('voice:transcript', handler);
    },
    onPlayAudio: (callback: (data: { audio: number[]; sampleRate: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { audio: number[]; sampleRate: number }) => callback(data);
      ipcRenderer.on('voice:play-audio', handler);
      return () => ipcRenderer.removeListener('voice:play-audio', handler);
    },
    playbackDone: () => ipcRenderer.invoke('voice-playback-done'),
    onError: (callback: (data: { message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
    setInteractionMode: (mode: string) => ipcRenderer.invoke('voice-set-interaction-mode', mode),
    sendAudioChunk: (chunk: number[]) => ipcRenderer.invoke('voice-audio-chunk', chunk),
    configChanged: () => ipcRenderer.invoke('voice-config-changed'),
  },
});
