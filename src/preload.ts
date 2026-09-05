import { contextBridge, ipcRenderer } from 'electron';
import type { SarahApi, BootStatus } from './core/sarah-api.js';
import type { IpcEvents, SystemMetrics, VoiceLevel } from './core/ipc-contract.js';
import type { AudioConfig } from './core/config-schema.js';
import type { VoiceState } from './services/voice/voice-types.js';
import type { RuntimeSnapshot } from './core/app-lifecycle-controller.js';

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
  getSystemMetrics: () => ipcRenderer.invoke('get-system-metrics'),
  onSystemMetrics: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SystemMetrics) => callback(data);
    ipcRenderer.on('system:metrics', handler);
    return () => ipcRenderer.removeListener('system:metrics', handler);
  },
  onVoiceLevel: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: VoiceLevel) => callback(data);
    ipcRenderer.on('voice:level', handler);
    return () => ipcRenderer.removeListener('voice:level', handler);
  },
  onAudioConfigChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AudioConfig) => callback(data);
    ipcRenderer.on('audio-config-changed', handler);
    return () => ipcRenderer.removeListener('audio-config-changed', handler);
  },
  getConfig: () => ipcRenderer.invoke('get-config'),
  getRuntimeStatus: () => ipcRenderer.invoke('get-runtime-status'),
  retryRuntimeRecovery: () => ipcRenderer.invoke('retry-runtime-recovery'),
  getPrivacyState: () => ipcRenderer.invoke('get-privacy-state'),
  onRuntimeStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: RuntimeSnapshot) => callback(data);
    ipcRenderer.on('runtime-status', handler);
    return () => ipcRenderer.removeListener('runtime-status', handler);
  },
  onVoiceInputConfigChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: IpcEvents['voice-input-config-changed'],
    ) => callback(data);
    ipcRenderer.on('voice-input-config-changed', handler);
    return () => ipcRenderer.removeListener('voice-input-config-changed', handler);
  },
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  reviewLegacyDbRecovery: () => ipcRenderer.invoke('legacy-db-recovery-review'),
  restoreLegacyDbRecovery: (quarantineIds) => ipcRenderer.invoke(
    'legacy-db-recovery-restore',
    { quarantineIds },
  ),
  selectFolder: (title?) => ipcRenderer.invoke('select-folder', title),
  detectPrograms: () => ipcRenderer.invoke('detect-programs'),
  scanFolderExes: (folderPath) => ipcRenderer.invoke('scan-folder-exes', folderPath),
  openDialog: (view) => ipcRenderer.invoke('open-dialog', view),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Chat API
  chat: (message, turnId, mode) => ipcRenderer.invoke('chat-message', { turnId, message, mode }),
  onChatChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['llm:chunk']) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  onChatDone: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['llm:done']) => callback(data);
    ipcRenderer.on('llm:done', handler);
    return () => ipcRenderer.removeListener('llm:done', handler);
  },
  onChatError: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['llm:error']) => callback(data);
    ipcRenderer.on('llm:error', handler);
    return () => ipcRenderer.removeListener('llm:error', handler);
  },
  onTurnTerminal: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['turn:terminal']) => callback(data);
    ipcRenderer.on('turn:terminal', handler);
    return () => ipcRenderer.removeListener('turn:terminal', handler);
  },
  onStorageDegraded: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('storage:degraded', handler);
    return () => ipcRenderer.removeListener('storage:degraded', handler);
  },
  onIncognitoChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['privacy:incognito']) => callback(data);
    ipcRenderer.on('privacy:incognito', handler);
    return () => ipcRenderer.removeListener('privacy:incognito', handler);
  },
  onBusDiagnostic: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['bus:diagnostic']) => callback(data);
    ipcRenderer.on('bus:diagnostic', handler);
    return () => ipcRenderer.removeListener('bus:diagnostic', handler);
  },

  // Voice API
  voice: {
    getState: () => ipcRenderer.invoke('voice-get-state'),
    captureFailed: (captureId, message) => ipcRenderer.invoke(
      'voice-capture-failed',
      { captureId, message },
    ),
    onStateChange: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['voice:state']) => callback(data);
      ipcRenderer.on('voice:state', handler);
      return () => ipcRenderer.removeListener('voice:state', handler);
    },
    onCaptureFlushRequest: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: IpcEvents['voice:capture-flush-request'],
      ) => callback(data);
      ipcRenderer.on('voice:capture-flush-request', handler);
      return () => ipcRenderer.removeListener('voice:capture-flush-request', handler);
    },
    onTranscript: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['voice:transcript']) => callback(data);
      ipcRenderer.on('voice:transcript', handler);
      return () => ipcRenderer.removeListener('voice:transcript', handler);
    },
    onPlayAudio: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['voice:play-audio']) => callback(data);
      ipcRenderer.on('voice:play-audio', handler);
      return () => ipcRenderer.removeListener('voice:play-audio', handler);
    },
    onStopPlayback: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: IpcEvents['voice:stop-playback']) => callback(data);
      ipcRenderer.on('voice:stop-playback', handler);
      return () => ipcRenderer.removeListener('voice:stop-playback', handler);
    },
    playbackDone: (turnId, playbackId) => ipcRenderer.invoke('voice-playback-done', { turnId, playbackId }),
    playbackFailed: (turnId, playbackId, message) => ipcRenderer.invoke(
      'voice-playback-failed',
      { turnId, playbackId, message },
    ),
    setCaptureReady: (ready) => ipcRenderer.invoke('voice-set-capture-ready', ready),
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
    onCapability: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { stt: boolean; tts: boolean }) => callback(data);
      ipcRenderer.on('voice:capability', handler);
      return () => ipcRenderer.removeListener('voice:capability', handler);
    },
    setInteractionMode: (mode) => ipcRenderer.invoke('voice-set-interaction-mode', mode),
    sendAudioChunk: (captureId, chunk) => ipcRenderer.invoke('voice-audio-chunk', { captureId, chunk }),
    captureFlushed: (captureId) => ipcRenderer.invoke('voice-capture-flushed', { captureId }),
    configChanged: () => ipcRenderer.invoke('voice-config-changed'),
  },

  // Connections ("Integrationen") API
  connections: {
    list: () => ipcRenderer.invoke('connections-list'),
    connect: (id) => ipcRenderer.invoke('connection-connect', id),
    cancel: (id) => ipcRenderer.invoke('connection-cancel', id),
    disconnect: (id) => ipcRenderer.invoke('connection-disconnect', id),
  },

  // AI provider hub API
  codexConnection: {
    start: (input) => ipcRenderer.invoke('codex-connection-start', input),
    status: () => ipcRenderer.invoke('codex-connection-status'),
    logout: () => ipcRenderer.invoke('codex-connection-logout'),
  },
  aiProviders: {
    list: () => ipcRenderer.invoke('ai-provider-hub-list'),
    saveApiKey: (input) => ipcRenderer.invoke('ai-provider-save-key', input),
    acknowledgeWarnings: (input) => ipcRenderer.invoke('ai-provider-acknowledge-warnings', input),
    deleteConnection: (input) => ipcRenderer.invoke('ai-provider-delete', input),
    replaceBindings: (input) => ipcRenderer.invoke('ai-provider-save-bindings', input),
    checkHealth: (input) => ipcRenderer.invoke('ai-provider-check-health', input),
  },

  // Provider-neutral specialist task API
  specialists: {
    list: () => ipcRenderer.invoke('specialist-tasks-list'),
    provideInput: (input) => ipcRenderer.invoke('specialist-task-provide-input', input),
    resume: (input) => ipcRenderer.invoke('specialist-task-resume', input),
    cancel: (input) => ipcRenderer.invoke('specialist-task-cancel', input),
    onStateChange: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: IpcEvents['specialist:state'],
      ) => callback(data);
      ipcRenderer.on('specialist:state', handler);
      return () => ipcRenderer.removeListener('specialist:state', handler);
    },
  },
};

contextBridge.exposeInMainWorld('sarah', api);
