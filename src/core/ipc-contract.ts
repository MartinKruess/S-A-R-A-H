import type { SarahConfig, SarahConfigPatch, ProgramEntry, AudioConfig } from './config-schema.js';
import type { BusEvents } from './bus-events.js';
import type { BusTopic } from './bus-events.js';
import type { ConnectionInfo } from '../services/integrations/oauth-connection-service.js';
import type { SaveConfigResult } from './config-apply.js';
import type { RuntimeSnapshot } from './app-lifecycle-controller.js';
import type { PlaybackId, TurnId, VoiceCaptureId } from './turn-contract.js';
import type { LegacyDbRecoveryResult, LegacyDbRecoveryReview } from './storage/storage.interface.js';
import type {
  AcknowledgeAiWarningsInput,
  AiHubMutationResult,
  AiProviderHubSnapshot,
  CheckAiConnectionHealthInput,
  DeleteAiConnectionInput,
  ReplaceAiBindingsInput,
  SaveAiApiKeyInput,
} from './ai-provider-contract.js';
import type {
  SpecialistTaskControlResult,
  SpecialistTaskIdInput,
  SpecialistTaskList,
  SpecialistTaskProvideInput,
  SpecialistTaskResumeInput,
} from './specialist-task-ipc.js';

/** IPC channels using ipcMain.handle / ipcRenderer.invoke (request-response) */
export interface IpcCommands {
  'get-system-info':            { input: void; output: SystemIpcInfo };
  'get-system-metrics':         { input: void; output: SystemMetrics };
  'get-config':                 { input: void; output: SarahConfig };
  'get-runtime-status':         { input: void; output: RuntimeSnapshot };
  'retry-runtime-recovery':     {
    input: void;
    output: { ok: boolean; modelRecovered: boolean; sttRecovered: boolean; message?: string };
  };
  'get-privacy-state':         { input: void; output: { incognitoActive: boolean } };
  'save-config':                { input: SarahConfigPatch; output: SaveConfigResult };
  'legacy-db-recovery-review':  { input: void; output: LegacyDbRecoveryReview };
  'legacy-db-recovery-restore': {
    input: { quarantineIds: number[] };
    output: LegacyDbRecoveryResult | null;
  };
  'select-folder':              { input: string | undefined; output: string | null };
  'detect-programs':            { input: void; output: ProgramEntry[] };
  'scan-folder-exes':           { input: string; output: ProgramEntry[] };
  'open-dialog':                { input: string; output: void };
  'open-external-url':          { input: string; output: void };
  'chat-message':               {
    input: { turnId: TurnId; message: string; mode: 'chat' | 'voice' };
    output: { accepted: boolean; turnId: TurnId };
  };
  'voice-get-state':            { input: void; output: BusEvents['voice:state'] };
  'voice-capture-failed':       {
    input: { captureId?: VoiceCaptureId; message: string };
    output: void;
  };
  'voice-playback-done':        { input: { turnId: TurnId; playbackId: PlaybackId }; output: void };
  'voice-playback-failed':      {
    input: { turnId: TurnId; playbackId: PlaybackId; message: string };
    output: void;
  };
  'voice-set-capture-ready':    { input: boolean; output: void };
  'voice-audio-chunk':          { input: { captureId: VoiceCaptureId; chunk: number[] }; output: void };
  'voice-capture-flushed':      { input: { captureId: VoiceCaptureId }; output: void };
  'voice-set-interaction-mode': { input: 'chat' | 'voice'; output: void };
  'voice-config-changed':       { input: void; output: void };
  'splash-tts':                 {
    input: string;
    output: { audio: number[]; sampleRate: number } | null;
  };
  'connections-list':           { input: void;   output: ConnectionInfo[] };
  'connection-connect':         { input: string; output: { ok: boolean; error?: string } };
  'connection-cancel':          { input: string; output: void };
  'connection-disconnect':      { input: string; output: void };
  'ai-provider-hub-list':        { input: void; output: AiProviderHubSnapshot };
  'codex-connection-start': { input: import('./codex-connection.js').CodexLoginInput; output: import('./codex-connection.js').CodexConnectionState };
  'codex-connection-status': { input: void; output: import('./codex-connection.js').CodexConnectionState };
  'codex-connection-logout': { input: void; output: import('./codex-connection.js').CodexConnectionState };
  'ai-provider-save-key':        { input: SaveAiApiKeyInput; output: AiHubMutationResult };
  'ai-provider-acknowledge-warnings': { input: AcknowledgeAiWarningsInput; output: AiHubMutationResult };
  'ai-provider-delete':          { input: DeleteAiConnectionInput; output: AiHubMutationResult };
  'ai-provider-save-bindings':   { input: ReplaceAiBindingsInput; output: AiHubMutationResult };
  'ai-provider-check-health':    { input: CheckAiConnectionHealthInput; output: AiHubMutationResult };
  'specialist-tasks-list':       { input: void; output: SpecialistTaskList };
  'specialist-task-provide-input': { input: SpecialistTaskProvideInput; output: SpecialistTaskControlResult };
  'specialist-task-resume':      { input: SpecialistTaskResumeInput; output: SpecialistTaskControlResult };
  'specialist-task-cancel':      { input: SpecialistTaskIdInput; output: SpecialistTaskControlResult };
}

/** IPC events sent from main to renderer (one-way, forwarded bus events) */
export interface IpcEvents {
  'bus:diagnostic':     BusDiagnostic;
  'llm:chunk':         BusEvents['llm:chunk'];
  'llm:done':          BusEvents['llm:done'];
  'llm:error':         BusEvents['llm:error'];
  'turn:terminal':     BusEvents['turn:terminal'];
  'storage:degraded':  BusEvents['storage:degraded'];
  'privacy:incognito': BusEvents['privacy:incognito'];
  'specialist:state':  BusEvents['specialist:state'];
  'voice:state':       BusEvents['voice:state'];
  'voice:capture-flush-request': BusEvents['voice:capture-flush-request'];
  'voice:transcript':  BusEvents['voice:transcript'];
  'voice:play-audio':  BusEvents['voice:play-audio'];
  'voice:stop-playback': BusEvents['voice:stop-playback'];
  'voice:error':       BusEvents['voice:error'];
  'voice:capability':  BusEvents['voice:capability'];
  'boot-status':       BusEvents['boot:status'];
  'system:metrics':        SystemMetrics;
  'voice:level':           VoiceLevel;
  'audio-config-changed':  AudioConfig;
  'voice-input-config-changed': { voiceMode: SarahConfig['controls']['voiceMode'] };
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
  'retry-runtime-recovery': true,
  'get-privacy-state': true,
  'save-config': true,
  'legacy-db-recovery-review': true,
  'legacy-db-recovery-restore': true,
  'select-folder': true,
  'detect-programs': true,
  'scan-folder-exes': true,
  'open-dialog': true,
  'open-external-url': true,
  'chat-message': true,
  'voice-get-state': true,
  'voice-capture-failed': true,
  'voice-playback-done': true,
  'voice-playback-failed': true,
  'voice-set-capture-ready': true,
  'voice-audio-chunk': true,
  'voice-capture-flushed': true,
  'voice-set-interaction-mode': true,
  'voice-config-changed': true,
  'splash-tts': true,
  'connections-list': true,
  'connection-connect': true,
  'connection-cancel': true,
  'connection-disconnect': true,
  'ai-provider-hub-list': true,
  'codex-connection-start': true,
  'codex-connection-status': true,
  'codex-connection-logout': true,
  'ai-provider-save-key': true,
  'ai-provider-acknowledge-warnings': true,
  'ai-provider-delete': true,
  'ai-provider-save-bindings': true,
  'ai-provider-check-health': true,
  'specialist-tasks-list': true,
  'specialist-task-provide-input': true,
  'specialist-task-resume': true,
  'specialist-task-cancel': true,
};

export const IPC_EVENT_CHANNELS: Readonly<Record<keyof IpcEvents, true>> = {
  'bus:diagnostic': true,
  'llm:chunk': true,
  'llm:done': true,
  'llm:error': true,
  'turn:terminal': true,
  'storage:degraded': true,
  'privacy:incognito': true,
  'specialist:state': true,
  'voice:state': true,
  'voice:capture-flush-request': true,
  'voice:transcript': true,
  'voice:play-audio': true,
  'voice:stop-playback': true,
  'voice:error': true,
  'voice:capability': true,
  'boot-status': true,
  'system:metrics': true,
  'voice:level': true,
  'audio-config-changed': true,
  'voice-input-config-changed': true,
  'runtime-status': true,
  'transition-start': true,
};

export interface BusDiagnostic {
  topic: BusTopic;
  source: string;
  timestamp: string;
  turnId?: TurnId;
}

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
  captureId: VoiceCaptureId;
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
