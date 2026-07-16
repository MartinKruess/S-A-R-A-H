import { describe, it, expect } from 'vitest';
import {
  isValidChatMessage,
  isValidAudioChunk,
  isValidInteractionMode,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_AUDIO_CHUNK_SAMPLES,
} from '../../src/main/ipc-validation';

describe('ipc payload validation', () => {
  it('accepts a normal chat message', () => {
    expect(isValidChatMessage('Hallo Sarah')).toBe(true);
    expect(isValidChatMessage('x'.repeat(MAX_CHAT_MESSAGE_LENGTH))).toBe(true);
  });

  it('rejects non-strings, empty and oversized messages', () => {
    expect(isValidChatMessage(42)).toBe(false);
    expect(isValidChatMessage(null)).toBe(false);
    expect(isValidChatMessage(undefined)).toBe(false);
    expect(isValidChatMessage('')).toBe(false);
    expect(isValidChatMessage('x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1))).toBe(false);
  });

  it('accepts a finite number array as audio chunk', () => {
    expect(isValidAudioChunk([0, 0.5, -0.5])).toBe(true);
  });

  it('rejects non-arrays, empty, oversized and non-finite chunks', () => {
    expect(isValidAudioChunk('nope')).toBe(false);
    expect(isValidAudioChunk(null)).toBe(false);
    expect(isValidAudioChunk([])).toBe(false);
    expect(isValidAudioChunk(new Array(MAX_AUDIO_CHUNK_SAMPLES + 1).fill(0))).toBe(false);
    expect(isValidAudioChunk([0, NaN])).toBe(false);
    expect(isValidAudioChunk([0, Infinity])).toBe(false);
    expect(isValidAudioChunk([0, 'a'])).toBe(false);
  });

  it('accepts only chat and voice as interaction mode', () => {
    expect(isValidInteractionMode('chat')).toBe(true);
    expect(isValidInteractionMode('voice')).toBe(true);
    expect(isValidInteractionMode('keyword')).toBe(false);
    expect(isValidInteractionMode(1)).toBe(false);
    expect(isValidInteractionMode(null)).toBe(false);
  });

  it('accepts optional short strings for dialog titles', async () => {
    const { isValidOptionalTitle } = await import('../../src/main/ipc-validation');
    expect(isValidOptionalTitle(undefined)).toBe(true);
    expect(isValidOptionalTitle('Ordner auswählen')).toBe(true);
    expect(isValidOptionalTitle(42)).toBe(false);
    expect(isValidOptionalTitle('x'.repeat(201))).toBe(false);
  });
});
