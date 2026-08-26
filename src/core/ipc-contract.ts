import type { SarahConfig, ProgramEntry, AudioConfig } from './config-schema.js';
import type { VoiceState } from '../services/voice/voice-types.js';
import type { BusEvents } from './bus-events.js';
import type { ConnectionInfo } from '../services/integrations/oauth-connection-service.js';
import type { SaveConfigResult } from './config-apply.js';
import type { RuntimeSnapshot } from './app-lifecycle-controller.js';
import type { PlaybackId, TurnId, VoiceCaptureId } from './turn-contract.js';

/** IPC channels using ipcMain.handle / ipcRenderer.invoke (request-response) */
export interface IpcCommands {
  'get-system-info':            { input: void; output: SystemIpcInfo };
  'get-system-metrics':         { input: void; output: SystemMetrics };
  'get-config':                 { input: void; output: SarahConfig };
  'get-runtime-status':         { input: void; output: RuntimeSnapshot };
  'save-config':                { input: Partial<SarahConfig>; output: SaveConfigResult };
  'select-folder':              { input: string | undefined; output: string | null };
  'detect-programs':            { input: void; output: ProgramEntry[] };
  'scan-folder-exes':           { input: string; output: ProgramEntry[] };
  'open-dialog':                { input: string; output: void };
  'open-external-url':          { input: string; output: void };
  'chat-message':               {
    input: { turnId: TurnId; message: string };
    output: { accepted: boolean; turnId: TurnId };
  };
  'voice-get-state':            { input: void; output: VoiceState };
  'voice-playback-done':        { input: { turnId: TurnId; playbackId: PlaybackId }; output: void };
  'voice-audio-chunk':          { input: { captureId: VoiceCaptureId; chunk: number[] }; output: void };
  'voice-set-interaction-mode': { input: 'chat' | 'voice'; output: void };
  'voice-config-changed':       { input: void; output: void };
  'splash-tts':                 { input: string; output: void };
  'connections-list':           { input: void;   output: ConnectionInfo[] };
  'connection-connect':         { input: string; output: { ok: boolean; error?: string } };
  'connection-disconnect':      { input: string; output: void };
}

/** IPC events sent from main to renderer (one-way, forwarded bus events) */
export interface IpcEvents {
  'llm:chunk':         BusEvents['llm:chunk'];
  'llm:done':          BusEvents['llm:done'];
  'llm:error':         BusEvents['llm:error'];
  'turn:terminal':     BusEvents['turn:terminal'];
  'storage:degraded':  BusEvents['storage:degraded'];
  'voice:state':       BusEvents['voice:state'];
  'voice:transcript':  BusEvents['voice:transcript'];
  'voice:play-audio':  BusEvents['voice:play-audio'];
  'voice:error':       BusEvents['voice:error'];
  'voice:capability':  BusEvents['voice:capability'];
  'boot-status':       BusEvents['boot:status'];
  'system:metrics':        SystemMetrics;
  'voice:level':           VoiceLevel;
  'audio-config-changed':  AudioConfig;
  'runtime-status':        RuntimeSnapshot;
  'transition-start':      void;
}

/** IPC events sent from renderer to main (one-way) */
export interface IpcSendEvents {
  'splash-done':  void;
  'wizard-done':  void;
  'boot-done':    void;
  'boot-ready':   void;
  'reveal-done':  void;
}

export const IPC_COMMAND_CHANNELS: Readonly<Record<keyof IpcCommands, true>> = {
  'get-system-info': true,
  'get-system-metrics': true,
  'get-config': true,
  'get-runtime-status': true,
  'save-config': true,
  'select-folder': true,
  'detect-programs': true,
  'scan-folder-exes': true,
  'open-dialog': true,
  'open-external-url': true,
  'chat-message': true,
  'voice-get-state': true,
  'voice-playback-done': true,
  'voice-audio-chunk': true,
  'voice-set-interaction-mode': true,
  'voice-config-changed': true,
  'splash-tts': true,
  'connections-list': true,
  'connection-connect': true,
  'connection-disconnect': true,
};

export const IPC_EVENT_CHANNELS: Readonly<Record<keyof IpcEvents, true>> = {
  'llm:chunk': true,
  'llm:done': true,
  'llm:error': true,
  'turn:terminal': true,
  'storage:degraded': true,
  'voice:state': true,
  'voice:transcript': true,
  'voice:play-audio': true,
  'voice:error': true,
  'voice:capability': true,
  'boot-status': true,
  'system:metrics': true,
  'voice:level': true,
  'audio-config-changed': true,
  'runtime-status': true,
  'transition-start': true,
};

export const IPC_SEND_CHANNELS: Readonly<Record<keyof IpcSendEvents, true>> = {
  'splash-done': true,
  'wizard-done': true,
  'boot-done': true,
  'boot-ready': true,
  'reveal-done': true,
};

/** Live system load metrics pushed via `system:metrics`. Values are fractions 0..1. */
export interface SystemMetrics {
  cpu: number;
  ram: number;
  gpu: number | null;
  ts: number;
}

/** Live voice input level pushed via `voice:level`. `bars` is a rolling FIFO window, oldest → newest. */
export interface VoiceLevel {
  rms: number;
  bars: number[];
  ts: number;
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
