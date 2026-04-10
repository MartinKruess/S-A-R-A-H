// tests/renderer/services/audio-worklet-processor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioWorkletProcessor globals before import
const postMessage = vi.fn();
const registeredProcessors = new Map<string, new () => { process: (inputs: Float32Array[][]) => boolean; port: { postMessage: typeof postMessage } }>();

vi.stubGlobal('AudioWorkletProcessor', class {
  port = { postMessage };
});

vi.stubGlobal('registerProcessor', (name: string, ctor: new () => { process: (inputs: Float32Array[][]) => boolean; port: { postMessage: typeof postMessage } }) => {
  registeredProcessors.set(name, ctor);
});

// Import triggers registerProcessor
await import('../../../src/renderer/services/audio-worklet-processor.js');

describe('CaptureProcessor', () => {
  let processor: { process: (inputs: Float32Array[][]) => boolean; port: { postMessage: typeof postMessage } };

  beforeEach(() => {
    postMessage.mockClear();
    const Ctor = registeredProcessors.get('capture-processor')!;
    processor = new Ctor();
    // Replace port.postMessage with our spy
    processor.port = { postMessage };
  });

  it('registers as capture-processor', () => {
    expect(registeredProcessors.has('capture-processor')).toBe(true);
  });

  it('buffers samples and posts at 2048', () => {
    // Feed 128 samples at a time (standard AudioWorklet quantum)
    const chunk = new Float32Array(128).fill(0.5);
    const inputs: Float32Array[][] = [[chunk]];

    // 16 * 128 = 2048
    for (let i = 0; i < 15; i++) {
      processor.process(inputs);
    }
    expect(postMessage).not.toHaveBeenCalled();

    // 16th call completes the buffer
    processor.process(inputs);
    expect(postMessage).toHaveBeenCalledOnce();

    const posted = postMessage.mock.calls[0][0] as { samples: Float32Array };
    expect(posted.samples).toBeInstanceOf(Float32Array);
    expect(posted.samples.length).toBe(2048);
    expect(posted.samples[0]).toBeCloseTo(0.5);
  });

  it('posts multiple buffers for large input', () => {
    // Feed 2048 samples in one call → should post once
    const chunk = new Float32Array(2048).fill(0.3);
    processor.process([[chunk]]);
    expect(postMessage).toHaveBeenCalledOnce();

    // Feed another 2048 → second post
    processor.process([[chunk]]);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('handles empty input gracefully', () => {
    const result = processor.process([[]]);
    expect(result).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('handles missing input gracefully', () => {
    const result = processor.process([]);
    expect(result).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('always returns true to keep processor alive', () => {
    const chunk = new Float32Array(128).fill(0.1);
    expect(processor.process([[chunk]])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
  });
});
