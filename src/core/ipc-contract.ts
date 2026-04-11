import type { SarahConfig, ProgramEntry } from './config-schema.js';
import type { VoiceState } from '../services/voice/voice-types.js';
import type { BusEvents } from './bus-events.js';

/** IPC channels using ipcMain.handle / ipcRenderer.invoke (request-response) */
export interface IpcCommands {
  'get-system-info':            { input: void; output: SystemIpcInfo };
  'get-config':                 { input: void; output: SarahConfig };
  'save-config':                { input: Partial<SarahConfig>; output: SarahConfig };
  'is-first-run':               { input: void; output: boolean };
  'select-folder':              { input: string | undefined; output: string | null };
  'detect-programs':            { input: void; output: ProgramEntry[] };
  'scan-folder-exes':           { input: string; output: ProgramEntry[] };
  'open-dialog':                { input: string; output: void };
  'chat-message':               { input: string; output: void };
  'voice-get-state':            { input: void; output: VoiceState };
  'voice-playback-done':        { input: void; output: void };
  'voice-audio-chunk':          { input: number[]; output: void };
  'voice-set-interaction-mode': { input: 'chat' | 'voice'; output: void };
  'voice-config-changed':       { input: void; output: void };
}

/** IPC events sent from main to renderer (one-way, forwarded bus events) */
export interface IpcEvents {
  'llm:chunk':         BusEvents['llm:chunk'];
  'llm:done':          BusEvents['llm:done'];
  'llm:error':         BusEvents['llm:error'];
  'voice:state':       BusEvents['voice:state'];
  'voice:listening':   BusEvents['voice:listening'];
  'voice:transcript':  BusEvents['voice:transcript'];
  'voice:speaking':    BusEvents['voice:speaking'];
  'voice:play-audio':  BusEvents['voice:play-audio'];
  'voice:done':        BusEvents['voice:done'];
  'voice:error':       BusEvents['voice:error'];
  'voice:interrupted': BusEvents['voice:interrupted'];
  'voice:wake':        BusEvents['voice:wake'];
}

/** IPC events sent from renderer to main (one-way) */
export interface IpcSendEvents {
  'splash-done': void;
}

/** System info returned by get-system-info IPC channel */
export interface SystemIpcInfo {
  os: string;
  platform: string;
  arch: string;
  cpu: string;
  cpuCores: string;
  totalMemory: string;
  freeMemory: string;
  hostname: string;
  shell: string;
  language: string;
  timezone: string;
  folders: {
    documents: string;
    downloads: string;
    pictures: string;
    desktop: string;
  };
}
