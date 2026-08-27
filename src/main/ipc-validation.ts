import { MAX_CHAT_MESSAGE_LENGTH } from '../core/chat-limits.js';
export { MAX_CHAT_MESSAGE_LENGTH } from '../core/chat-limits.js';

// Guards for untrusted renderer payloads. Convention (spec A, A3):
// invalid payload → console.warn('[IPC] invalid payload for <channel>')
// + return undefined (void channels) / null (value channels).
export const MAX_AUDIO_CHUNK_SAMPLES = 65536;
export const MAX_TITLE_LENGTH = 200;
export const MAX_VOICE_ERROR_LENGTH = 500;
const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

export function isValidChatInput(
  value: unknown,
): value is { turnId: string; message: string; mode: 'chat' | 'voice' } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { turnId?: unknown; message?: unknown; mode?: unknown };
  return isValidCorrelationId(candidate.turnId)
    && isValidChatMessage(candidate.message)
    && isValidInteractionMode(candidate.mode);
}

export function isValidAudioInput(
  value: unknown,
): value is { captureId: string; chunk: number[] } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { captureId?: unknown; chunk?: unknown };
  return isValidCorrelationId(candidate.captureId) && isValidAudioChunk(candidate.chunk);
}

export function isValidPlaybackDoneInput(
  value: unknown,
): value is { turnId: string; playbackId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { turnId?: unknown; playbackId?: unknown };
  return isValidCorrelationId(candidate.turnId) && isValidCorrelationId(candidate.playbackId);
}

export function isValidPlaybackFailureInput(
  value: unknown,
): value is { turnId: string; playbackId: string; message: string } {
  if (!isValidPlaybackDoneInput(value)) return false;
  const candidate = value as { message?: unknown };
  return typeof candidate.message === 'string'
    && candidate.message.length > 0
    && candidate.message.length <= MAX_VOICE_ERROR_LENGTH;
}

export function isValidCaptureFailureInput(
  value: unknown,
): value is { captureId?: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { captureId?: unknown; message?: unknown };
  const captureIdValid = candidate.captureId === undefined
    || isValidCorrelationId(candidate.captureId);
  return captureIdValid
    && typeof candidate.message === 'string'
    && candidate.message.length > 0
    && candidate.message.length <= MAX_VOICE_ERROR_LENGTH;
}

export function isValidChatMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHAT_MESSAGE_LENGTH;
}

export function isValidAudioChunk(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_AUDIO_CHUNK_SAMPLES
    && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function isValidInteractionMode(value: unknown): value is 'chat' | 'voice' {
  return value === 'chat' || value === 'voice';
}

export function isValidOptionalTitle(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_TITLE_LENGTH);
}
