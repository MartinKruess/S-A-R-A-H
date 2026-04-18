import { contextBridge, ipcRenderer } from 'electron';
import type { SarahApi, BootStatus } from './core/sarah-api.js';
import type { VoiceState } from './services/voice/voice-types.js';

const api: SarahApi = {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send('splash-done'),
  wizardDone: () => ipcRenderer.send('wizard-done'),
  bootDone: () => ipcRenderer.send('boot-done'),
  bootReady: () => ipcRenderer.send('boot-ready'),
  revealDone: () => ipcRenderer.send('reveal-done'),
  onBootStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: BootStatus) => callback(data);
    ipcRenderer.on('boot-status', handler);
    return () => ipcRenderer.removeListener('boot-status', handler);
  },
  onTransitionStart: (callback) => {
    const handler = () => callback();
    ipcRenderer.once('transition-start', handler);
    return () => ipcRenderer.removeListener('transition-start', handler);
  },
  splashTts: (text) => ipcRenderer.invoke('splash-tts', text),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  selectFolder: (title?) => ipcRenderer.invoke('select-folder', title),
  detectPrograms: () => ipcRenderer.invoke('detect-programs'),
  scanFolderExes: (folderPath) => ipcRenderer.invoke('scan-folder-exes', folderPath),
  openDialog: (view) => ipcRenderer.invoke('open-dialog', view),

  // Chat API
  chat: (message) => ipcRenderer.invoke('chat-message', message),
  onChatChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  onChatDone: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { fullText: string }) => callback(data);
    ipcRenderer.on('llm:done', handler);
    return () => ipcRenderer.removeListener('llm:done', handler);
  },
  onChatError: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('llm:error', handler);
    return () => ipcRenderer.removeListener('llm:error', handler);
  },

  // Voice API
  voice: {
    getState: () => ipcRenderer.invoke('voice-get-state'),
    onStateChange: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { state: VoiceState }) => callback(data);
      ipcRenderer.on('voice:state', handler);
      return () => ipcRenderer.removeListener('voice:state', handler);
    },
    onTranscript: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
      ipcRenderer.on('voice:transcript', handler);
      return () => ipcRenderer.removeListener('voice:transcript', handler);
    },
    onPlayAudio: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { audio: number[]; sampleRate: number }) => callback(data);
      ipcRenderer.on('voice:play-audio', handler);
      return () => ipcRenderer.removeListener('voice:play-audio', handler);
    },
    playbackDone: () => ipcRenderer.invoke('voice-playback-done'),
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
    setInteractionMode: (mode) => ipcRenderer.invoke('voice-set-interaction-mode', mode),
    sendAudioChunk: (chunk) => ipcRenderer.invoke('voice-audio-chunk', chunk),
    configChanged: () => ipcRenderer.invoke('voice-config-changed'),
  },
};

contextBridge.exposeInMainWorld('sarah', api);
