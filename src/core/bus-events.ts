import type { VoiceState } from '../services/voice/voice-types.js';
import type {
  OutputId,
  PlaybackId,
  TurnId,
  TurnMode,
  TurnRequest,
  TurnSource,
  TurnTerminalStatus,
  VoiceCaptureId,
} from './turn-contract.js';
import type { ActionConfirmationReference } from './action-confirmation.js';

/**
 * Central event map — every bus topic has exactly one payload type.
 * Adding a new event? Add it here and TypeScript enforces the payload everywhere.
 */
export type BusEvents = {
  'chat:message':        TurnRequest;
  'turn:accepted':       { turnId: TurnId; source: TurnSource; mode: TurnMode };
  'turn:cancel':         { turnId: TurnId; reason: string };
  'turn:terminal':       { turnId: TurnId; status: TurnTerminalStatus; message?: string };
  'llm:chunk':           { turnId: TurnId; outputId: OutputId; sequence: number; text: string };
  'llm:done':            { turnId: TurnId; outputId: OutputId; sequence: number; fullText: string };
  'llm:error':           { turnId: TurnId; message: string };
  'llm:routing':         { turnId: TurnId; from: 'router' | 'local_worker'; to: 'local_worker' | 'backend' | 'extern' };
  'llm:model-swap':      { turnId: TurnId; loading: string; unloading: string };
  // Main-process-only bridging phrase spoken over a model-swap pause (voice mode).
  // Deliberately NOT forwarded to the renderer — it must never render a chat bubble.
  'llm:filler':          { turnId: TurnId; text: string };
  'voice:state':         { state: VoiceState; turnId?: TurnId; captureId?: VoiceCaptureId };
  'voice:listening':     { turnId: TurnId; captureId: VoiceCaptureId };
  'voice:capture-flush-request': { captureId: VoiceCaptureId };
  'voice:transcript':    { turnId: TurnId; captureId: VoiceCaptureId; text: string };
  'voice:speaking':      { turnId: TurnId; outputId: OutputId; text: string };
  'voice:play-audio':    { turnId: TurnId; outputId: OutputId; playbackId: PlaybackId; audio: number[]; sampleRate: number };
  'voice:stop-playback': { turnId: TurnId; playbackId: PlaybackId };
  'voice:done':          { turnId: TurnId };
  'voice:error':         { message: string; turnId?: TurnId; outputId?: OutputId };
  'voice:capability':    { stt: boolean; tts: boolean };
  'voice:interrupted':   { turnId: TurnId };
  'voice:wake':          Record<string, never>;
  'voice:playback-done': { turnId: TurnId; playbackId: PlaybackId };
  'perf:timing':         { label: string; ms: number; turnId?: TurnId; meta?: Record<string, unknown> };
  'boot:status':         { step: string; message?: string };
  'storage:degraded':    { message: string };
  'action:request':      { turnId: TurnId; requestId: string; action: string; param: string; sourceRequestId?: string; confirmation?: ActionConfirmationReference };
  'action:cancel':       { turnId: TurnId; requestId: string; reason: string };
  'action:result':       { turnId: TurnId; requestId: string; action: string; ok: boolean; speak?: string };
  'action:notify':       { notificationId: string; speak: string };
};

/** All valid bus topic strings */
export type BusTopic = keyof BusEvents;
