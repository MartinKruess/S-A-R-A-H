import type { SarahConfig, ProgramEntry } from './config-schema.js';
import type { BusEvents } from './bus-events.js';
import type { SystemIpcInfo } from './ipc-contract.js';
import type { VoiceState } from '../services/voice/voice-types.js';

/** Boot sequence status sent from main to splash renderer */
export type BootStatus = {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
};

/** Voice sub-API exposed to renderers */
export interface SarahVoiceApi {
  getState(): Promise<VoiceState>;
  onStateChange(cb: (data: BusEvents['voice:state']) => void): () => void;
  onTranscript(cb: (data: BusEvents['voice:transcript']) => void): () => void;
  onPlayAudio(cb: (data: BusEvents['voice:play-audio']) => void): () => void;
  playbackDone(): Promise<void>;
  onError(cb: (data: BusEvents['voice:error']) => void): () => void;
  setInteractionMode(mode: 'chat' | 'voice'): Promise<void>;
  sendAudioChunk(chunk: number[]): Promise<void>;
  configChanged(): Promise<void>;
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
  splashTts(text: string): Promise<void>;
  getSystemInfo(): Promise<SystemIpcInfo>;
  getConfig(): Promise<SarahConfig>;
  saveConfig(config: Partial<SarahConfig>): Promise<SarahConfig>;
  selectFolder(title?: string): Promise<string | null>;
  detectPrograms(): Promise<ProgramEntry[]>;
  scanFolderExes(folderPath: string): Promise<ProgramEntry[]>;
  openDialog(view: string): Promise<void>;
  chat(message: string): Promise<void>;
  onChatChunk(cb: (data: BusEvents['llm:chunk']) => void): () => void;
  onChatDone(cb: (data: BusEvents['llm:done']) => void): () => void;
  onChatError(cb: (data: BusEvents['llm:error']) => void): () => void;
  voice: SarahVoiceApi;
}
