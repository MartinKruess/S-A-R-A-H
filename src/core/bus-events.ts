import type { VoiceState } from '../services/voice/voice-types.js';

/**
 * Central event map — every bus topic has exactly one payload type.
 * Adding a new event? Add it here and TypeScript enforces the payload everywhere.
 */
export type BusEvents = {
  'chat:message':        { text: string; mode: 'chat' | 'voice' };
  'llm:chunk':           { text: string };
  'llm:done':            { fullText: string };
  'llm:error':           { message: string };
  'llm:routing':         { from: '2b' | '9b'; to: '9b' | 'backend' | 'extern' };
  'llm:model-swap':      { loading: string; unloading: string };
  // Main-process-only bridging phrase spoken over a model-swap pause (voice mode).
  // Deliberately NOT forwarded to the renderer — it must never render a chat bubble.
  'llm:filler':          { text: string };
  'voice:state':         { state: VoiceState };
  'voice:listening':     Record<string, never>;
  'voice:transcript':    { text: string };
  'voice:speaking':      { text: string };
  'voice:play-audio':    { audio: number[]; sampleRate: number };
  'voice:done':          Record<string, never>;
  'voice:error':         { message: string };
  'voice:capability':    { stt: boolean; tts: boolean };
  'voice:interrupted':   Record<string, never>;
  'voice:wake':          Record<string, never>;
  'voice:playback-done': Record<string, never>;
  'perf:timing':         { label: string; ms: number; meta?: Record<string, unknown> };
  'boot:status':         { step: string; message?: string };
  'storage:degraded':    { message: string };
  'action:request':      { requestId: string; action: string; param: string };
  'action:result':       { requestId: string; action: string; ok: boolean; speak?: string };
  'action:notify':       { speak: string };
};

/** All valid bus topic strings */
export type BusTopic = keyof BusEvents;
