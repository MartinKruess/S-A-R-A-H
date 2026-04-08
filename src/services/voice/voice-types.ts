// src/services/voice/voice-types.ts

/** Voice service state machine states */
export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

/** Voice control modes — mutually exclusive */
export type VoiceMode = 'off' | 'keyword' | 'push-to-talk';

/** Silence duration before end-of-speech in keyword mode (ms) */
export const SILENCE_TIMEOUT_MS = 2_000;

/** Conversation window duration after last interaction in keyword mode (ms) */
export const CONVERSATION_WINDOW_MS = 60_000;

/** Default push-to-talk hotkey */
export const DEFAULT_PTT_KEY = 'F9';

/** Abort phrases that end the conversation window immediately */
export const ABORT_PHRASES: readonly string[] = [
  'sarah stop',
  'danke sarah',
  'sarah aus',
  'sarah du bist nicht gemeint',
] as const;

/** Check if a transcript contains an abort phrase */
export function isAbortPhrase(transcript: string): boolean {
  const normalized = transcript.toLowerCase().trim();
  return ABORT_PHRASES.some((phrase) => normalized.includes(phrase));
}
