import { describe, it, expect } from 'vitest';
import {
  isValidChatMessage,
  isValidChatInput,
  isValidAudioChunk,
  isValidInteractionMode,
  isValidCaptureFailureInput,
  isValidPlaybackFailureInput,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_AUDIO_CHUNK_SAMPLES,
  MAX_VOICE_ERROR_LENGTH,
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

  it('requires a correlated turn and an explicit interaction mode for chat input', () => {
    const turnId = '11111111-1111-4111-8111-111111111111';
    expect(isValidChatInput({ turnId, message: 'Hallo Sarah', mode: 'chat' })).toBe(true);
    expect(isValidChatInput({ turnId, message: 'Hallo Sarah', mode: 'voice' })).toBe(true);
    expect(isValidChatInput({ turnId, message: 'Hallo Sarah' })).toBe(false);
    expect(isValidChatInput({ turnId, message: 'Hallo Sarah', mode: 'ambient' })).toBe(false);
  });

  it('validates renderer capture failures with an optional correlated captureId', () => {
    const captureId = '33333333-3333-4333-8333-333333333333';
    expect(isValidCaptureFailureInput({ captureId, message: 'Mikrofon nicht verfügbar.' })).toBe(true);
    expect(isValidCaptureFailureInput({ message: 'Mikrofon nicht verfügbar.' })).toBe(true);
    expect(isValidCaptureFailureInput({ captureId: 'stale', message: 'Fehler' })).toBe(false);
    expect(isValidCaptureFailureInput({ captureId, message: '' })).toBe(false);
    expect(isValidCaptureFailureInput({
      captureId,
      message: 'x'.repeat(MAX_VOICE_ERROR_LENGTH + 1),
    })).toBe(false);
  });

  it('validates correlated renderer playback failures', () => {
    const turnId = '11111111-1111-4111-8111-111111111111';
    const playbackId = '22222222-2222-4222-8222-222222222222';
    expect(isValidPlaybackFailureInput({ turnId, playbackId, message: 'Audioausgabe fehlgeschlagen.' })).toBe(true);
    expect(isValidPlaybackFailureInput({ turnId, playbackId: 'stale', message: 'Fehler' })).toBe(false);
    expect(isValidPlaybackFailureInput({ turnId, playbackId, message: '' })).toBe(false);
  });

  it('accepts optional short strings for dialog titles', async () => {
    const { isValidOptionalTitle } = await import('../../src/main/ipc-validation');
    expect(isValidOptionalTitle(undefined)).toBe(true);
    expect(isValidOptionalTitle('Ordner auswählen')).toBe(true);
    expect(isValidOptionalTitle(42)).toBe(false);
    expect(isValidOptionalTitle('x'.repeat(201))).toBe(false);
  });
});
