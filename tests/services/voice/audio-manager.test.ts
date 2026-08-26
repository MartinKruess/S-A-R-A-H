// tests/services/voice/audio-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioManager } from '../../../src/services/voice/audio-manager.js';

describe('AudioManager', () => {
  const CAPTURE_ID = 'capture-1';
  let manager: AudioManager;

  beforeEach(() => {
    manager = new AudioManager();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('starts recording', () => {
    manager.startRecording(CAPTURE_ID);
    expect(manager.isRecording).toBe(true);
  });

  it('does not start recording twice', () => {
    const onChunk = vi.fn();
    manager.startRecording(CAPTURE_ID, onChunk);
    manager.startRecording(CAPTURE_ID, onChunk);
    expect(manager.isRecording).toBe(true);
  });

  it('collects chunks and returns combined buffer on stop', () => {
    manager.startRecording(CAPTURE_ID);
    manager.feedChunk(CAPTURE_ID, new Float32Array([0.1, 0.2]));
    manager.feedChunk(CAPTURE_ID, new Float32Array([0.3, 0.4]));
    const result = manager.stopRecording(CAPTURE_ID);

    expect(manager.isRecording).toBe(false);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(4);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[2]).toBeCloseTo(0.3);
  });

  it('calls onChunk callback for each fed chunk', () => {
    const onChunk = vi.fn();
    manager.startRecording(CAPTURE_ID, onChunk);
    manager.feedChunk(CAPTURE_ID, new Float32Array([0.5]));
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0][0][0]).toBeCloseTo(0.5);
  });

  it('ignores chunks when not recording', () => {
    manager.feedChunk(CAPTURE_ID, new Float32Array([0.1]));
    manager.startRecording(CAPTURE_ID);
    const result = manager.stopRecording();
    expect(result.length).toBe(0);
  });

  it('returns empty buffer when stopping without recording', () => {
    const result = manager.stopRecording();
    expect(result.length).toBe(0);
  });

  it('tracks playing state', () => {
    expect(manager.isPlaying).toBe(false);
    manager.setPlaying(true);
    expect(manager.isPlaying).toBe(true);
    manager.setPlaying(false);
    expect(manager.isPlaying).toBe(false);
  });

  it('resets state on destroy', async () => {
    manager.startRecording(CAPTURE_ID);
    manager.setPlaying(true);
    await manager.destroy();
    expect(manager.isRecording).toBe(false);
    expect(manager.isPlaying).toBe(false);
  });

  it('ignores stale capture ids and enforces the one-minute sample cap', () => {
    manager.startRecording(CAPTURE_ID);
    expect(manager.feedChunk('old-capture', new Float32Array([1]))).toEqual({
      accepted: false,
      limitReached: false,
    });

    const chunk = new Float32Array(65_536);
    let result = { accepted: true, limitReached: false };
    for (let index = 0; index < 20 && !result.limitReached; index += 1) {
      result = manager.feedChunk(CAPTURE_ID, chunk);
    }

    expect(result.limitReached).toBe(true);
    expect(manager.stopRecording(CAPTURE_ID).length)
      .toBeLessThanOrEqual(AudioManager.MAX_RECORDING_SAMPLES);
  });

  it('distinguishes accepted audio from an over-limit chunk', () => {
    manager.startRecording(CAPTURE_ID);
    const first = manager.feedChunk(
      CAPTURE_ID,
      new Float32Array(AudioManager.MAX_RECORDING_SAMPLES - 1),
    );
    const rejected = manager.feedChunk(CAPTURE_ID, new Float32Array(2));

    expect(first).toEqual({ accepted: true, limitReached: false });
    expect(rejected).toEqual({ accepted: false, limitReached: true });
  });
});
