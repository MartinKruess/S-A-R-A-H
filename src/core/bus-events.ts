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
import type { ActionIntent } from './action-intent.js';

/** Semantic speech classes carried by the main-process-only priority speech bus. */
export type PrioritySpeechCategory = 'background' | 'normal' | 'timer' | 'critical' | 'user';

/**
 * Central event map — every bus topic has exactly one payload type.
 * Adding a new event? Add it here and TypeScript enforces the payload everywhere.
 */
export type BusEvents = {
  'chat:message':        TurnRequest;
  'turn:accepted':       { turnId: TurnId; source: TurnSource; mode: TurnMode };
  'turn:output-policy':  { turnId: TurnId; speech: 'suppress' };
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
  // Main-process-only speech path. The VoiceService owns the concrete queue priority
  // and decides whether a requested post-playback pause is currently warranted.
  'voice:priority-speech': { turnId: TurnId; outputId: OutputId; text: string; priority: PrioritySpeechCategory; pauseAfter?: boolean };
  'voice:resume-speech': Record<string, never>;
  'voice:discard-paused-speech': { preserveTurnId: TurnId; reason: string };
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
  'privacy:incognito':   { active: boolean; turnId: TurnId };
  'search:discard-session': { requestId: string };
  'action:request':      ActionIntent & { turnId: TurnId; requestId: string; sourceRequestId?: string; confirmation?: ActionConfirmationReference; originMode?: TurnMode; privateContext?: boolean };
  'action:cancel':       { turnId: TurnId; requestId: string; reason: string };
  'action:result':       {
    turnId: TurnId;
    requestId: string;
    action: string;
    ok: boolean;
    speak?: string;
    reminderCancelAmbiguity?: {
      candidates: Array<{ id: number; dueLocal: string }>;
    };
  };
  'action:notify':       { notificationId: string; kind: 'timer' | 'reminder'; speak: string; originMode?: TurnMode; privateContext?: boolean };
  'action:notify-accepted': { notificationId: string };
};

/** All valid bus topic strings */
export type BusTopic = keyof BusEvents;
