// tests/services/voice/audio-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioManager } from '../../../src/services/voice/audio-manager.js';

describe('AudioManager', () => {
  let manager: AudioManager;

  beforeEach(() => {
    manager = new AudioManager();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('starts recording', () => {
    manager.startRecording();
    expect(manager.isRecording).toBe(true);
  });

  it('does not start recording twice', () => {
    const onChunk = vi.fn();
    manager.startRecording(onChunk);
    manager.startRecording(onChunk);
    expect(manager.isRecording).toBe(true);
  });

  it('collects chunks and returns combined buffer on stop', () => {
    manager.startRecording();
    manager.feedChunk(new Float32Array([0.1, 0.2]));
    manager.feedChunk(new Float32Array([0.3, 0.4]));
    const result = manager.stopRecording();

    expect(manager.isRecording).toBe(false);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(4);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[2]).toBeCloseTo(0.3);
  });

  it('calls onChunk callback for each fed chunk', () => {
    const onChunk = vi.fn();
    manager.startRecording(onChunk);
    manager.feedChunk(new Float32Array([0.5]));
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0][0][0]).toBeCloseTo(0.5);
  });

  it('ignores chunks when not recording', () => {
    manager.feedChunk(new Float32Array([0.1]));
    manager.startRecording();
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
    manager.startRecording();
    manager.setPlaying(true);
    await manager.destroy();
    expect(manager.isRecording).toBe(false);
    expect(manager.isPlaying).toBe(false);
  });
});
