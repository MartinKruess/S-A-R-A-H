// Guards for untrusted renderer payloads. Convention (spec A, A3):
// invalid payload → console.warn('[IPC] invalid payload for <channel>')
// + return undefined (void channels) / null (value channels).
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
export const MAX_AUDIO_CHUNK_SAMPLES = 65536;
export const MAX_TITLE_LENGTH = 200;

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
