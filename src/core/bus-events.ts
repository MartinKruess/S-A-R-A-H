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
  'voice:state':         { state: VoiceState };
  'voice:listening':     Record<string, never>;
  'voice:transcript':    { text: string };
  'voice:speaking':      { text: string };
  'voice:play-audio':    { audio: number[]; sampleRate: number };
  'voice:done':          Record<string, never>;
  'voice:error':         { message: string };
  'voice:interrupted':   Record<string, never>;
  'voice:wake':          Record<string, never>;
  'voice:playback-done': Record<string, never>;
};

/** All valid bus topic strings */
export type BusTopic = keyof BusEvents;
