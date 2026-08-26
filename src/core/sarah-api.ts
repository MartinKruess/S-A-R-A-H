import type { SarahConfig, ProgramEntry, AudioConfig } from './config-schema.js';
import type { BusEvents } from './bus-events.js';
import type { BusDiagnostic, IpcCommands, IpcEvents, SystemIpcInfo, SystemMetrics, VoiceLevel } from './ipc-contract.js';
import type { PlaybackId, TurnId, VoiceCaptureId } from './turn-contract.js';
import type { ConnectionInfo } from '../services/integrations/oauth-connection-service.js';
import type { SaveConfigResult } from './config-apply.js';
import type { RuntimeSnapshot } from './app-lifecycle-controller.js';

export type { ConnectionInfo };

/** Boot sequence status sent from main to splash renderer */
export type BootStatus = {
  step:
    | 'whisper'
    | 'router'
    | 'router-ready'
    | 'router-terminal'
    | 'whisper-ready'
    | 'whisper-unavailable'
    | 'piper'
    | 'piper-ready'
    | 'piper-unavailable';
  message?: string;
  /** Display class for the splash status line; defaults to 'info'. */
  severity?: 'info' | 'warning' | 'error';
};

/** Voice sub-API exposed to renderers */
export interface SarahVoiceApi {
  getState(): Promise<IpcEvents['voice:state']>;
  onStateChange(cb: (data: IpcEvents['voice:state']) => void): () => void;
  onTranscript(cb: (data: BusEvents['voice:transcript']) => void): () => void;
  onPlayAudio(cb: (data: BusEvents['voice:play-audio']) => void): () => void;
  onStopPlayback(cb: (data: BusEvents['voice:stop-playback']) => void): () => void;
  playbackDone(turnId: TurnId, playbackId: PlaybackId): Promise<void>;
  playbackFailed(turnId: TurnId, playbackId: PlaybackId, message: string): Promise<void>;
  setCaptureReady(ready: boolean): Promise<void>;
  onError(cb: (data: BusEvents['voice:error']) => void): () => void;
  onCapability(cb: (data: BusEvents['voice:capability']) => void): () => void;
  setInteractionMode(mode: 'chat' | 'voice'): Promise<void>;
  sendAudioChunk(captureId: VoiceCaptureId, chunk: number[]): Promise<void>;
  captureFailed(captureId: VoiceCaptureId | undefined, message: string): Promise<void>;
  configChanged(): Promise<void>;
}

/** Connections ("Integrationen") sub-API exposed to renderers */
export interface SarahConnectionsApi {
  list(): Promise<ConnectionInfo[]>;
  connect(id: string): Promise<{ ok: boolean; error?: string }>;
  disconnect(id: string): Promise<void>;
}

/** Full API exposed to renderers via contextBridge as `sarah` global */
export interface SarahApi {
  version: string;
  splashDone(): void;
  wizardDone(): void;
  bootDone(): void;
  bootReady(): void;
  revealDone(): void;
  onBootStatus(cb: (data: BootStatus) => void): () => void;
  onTransitionStart(cb: () => void): () => void;
  splashTts(text: string): Promise<IpcCommands['splash-tts']['output']>;
  getSystemInfo(): Promise<SystemIpcInfo>;
  getSystemMetrics(): Promise<SystemMetrics>;
  onSystemMetrics(cb: (data: SystemMetrics) => void): () => void;
  onVoiceLevel(cb: (data: VoiceLevel) => void): () => void;
  onAudioConfigChanged(cb: (audio: AudioConfig) => void): () => void;
  onVoiceInputConfigChanged(
    cb: (config: IpcEvents['voice-input-config-changed']) => void,
  ): () => void;
  getConfig(): Promise<SarahConfig>;
  getRuntimeStatus(): Promise<RuntimeSnapshot>;
  onRuntimeStatus(cb: (snapshot: RuntimeSnapshot) => void): () => void;
  saveConfig(config: Partial<SarahConfig>): Promise<SaveConfigResult>;
  selectFolder(title?: string): Promise<string | null>;
  detectPrograms(): Promise<ProgramEntry[]>;
  scanFolderExes(folderPath: string): Promise<ProgramEntry[]>;
  openDialog(view: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  chat(
    message: string,
    turnId: TurnId,
    mode: 'chat' | 'voice',
  ): Promise<IpcCommands['chat-message']['output']>;
  onChatChunk(cb: (data: BusEvents['llm:chunk']) => void): () => void;
  onChatDone(cb: (data: BusEvents['llm:done']) => void): () => void;
  onChatError(cb: (data: BusEvents['llm:error']) => void): () => void;
  onTurnTerminal(cb: (data: BusEvents['turn:terminal']) => void): () => void;
  onStorageDegraded(cb: (data: BusEvents['storage:degraded']) => void): () => void;
  onBusDiagnostic(cb: (data: BusDiagnostic) => void): () => void;
  voice: SarahVoiceApi;
  connections: SarahConnectionsApi;
}
