// tests/renderer/services/audio-worklet-processor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioWorkletProcessor globals before import
const postMessage = vi.fn();
type ProcessorPort = {
  postMessage: typeof postMessage;
  onmessage: ((event: MessageEvent<{
    type: 'begin' | 'flush' | 'cancel'; captureId: string;
  }>) => void) | null;
};
type Processor = { process: (inputs: Float32Array[][]) => boolean; port: ProcessorPort };
const registeredProcessors = new Map<string, new () => Processor>();

vi.stubGlobal('AudioWorkletProcessor', class {
  port: ProcessorPort = { postMessage, onmessage: null };
});

vi.stubGlobal('registerProcessor', (name: string, ctor: new () => Processor) => {
  registeredProcessors.set(name, ctor);
});

// Import triggers registerProcessor
await import('../../../src/renderer/services/audio-worklet-processor.js');

describe('CaptureProcessor', () => {
  let processor: Processor;

  beforeEach(() => {
    postMessage.mockClear();
    const Ctor = registeredProcessors.get('capture-processor')!;
    processor = new Ctor();
  });

  const control = (type: 'begin' | 'flush' | 'cancel', captureId = 'capture-1'): void => {
    processor.port.onmessage?.({ data: { type, captureId } } as MessageEvent<{
      type: 'begin' | 'flush' | 'cancel'; captureId: string;
    }>);
  };

  it('registers as capture-processor', () => {
    expect(registeredProcessors.has('capture-processor')).toBe(true);
  });

  it('buffers samples and posts at 2048', () => {
    control('begin');
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

    const posted = postMessage.mock.calls[0][0] as {
      type: string; captureId: string; samples: Float32Array;
    };
    expect(posted).toMatchObject({ type: 'chunk', captureId: 'capture-1' });
    expect(posted.samples).toBeInstanceOf(Float32Array);
    expect(posted.samples.length).toBe(2048);
    expect(posted.samples[0]).toBeCloseTo(0.5);
  });

  it('posts multiple buffers for large input', () => {
    control('begin');
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

  it('drops pre-key samples and starts every capture with an empty buffer', () => {
    processor.process([[new Float32Array(1024).fill(0.1)]]);
    control('begin', 'capture-1');
    processor.process([[new Float32Array(1024).fill(0.2)]]);
    control('begin', 'capture-2');
    processor.process([[new Float32Array(2048).fill(0.3)]]);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: 'chunk',
      captureId: 'capture-2',
    });
    const samples = (postMessage.mock.calls[0][0] as { samples: Float32Array }).samples;
    expect(samples.every((sample) => Math.abs(sample - 0.3) < 1e-6)).toBe(true);
  });

  it('flushes a partial final block before acknowledging the matching capture', () => {
    control('begin', 'capture-1');
    processor.process([[new Float32Array(128).fill(0.7)]]);
    control('flush', 'stale-capture');
    expect(postMessage).not.toHaveBeenCalled();

    control('flush', 'capture-1');

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: 'chunk', captureId: 'capture-1',
    });
    expect((postMessage.mock.calls[0][0] as { samples: Float32Array }).samples).toHaveLength(128);
    expect(postMessage.mock.calls[1][0]).toEqual({ type: 'flushed', captureId: 'capture-1' });
  });

  it('drops a canceled partial block and ignores audio until the next begin', () => {
    control('begin', 'capture-1');
    processor.process([[new Float32Array(128).fill(0.7)]]);
    control('cancel', 'stale-capture');
    processor.process([[new Float32Array(1920).fill(0.6)]]);
    expect(postMessage).toHaveBeenCalledOnce();

    processor.process([[new Float32Array(64).fill(0.55)]]);
    control('cancel', 'capture-1');
    processor.process([[new Float32Array(2048).fill(0.5)]]);
    expect(postMessage).toHaveBeenCalledOnce();

    control('begin', 'capture-2');
    processor.process([[new Float32Array(2048).fill(0.4)]]);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toMatchObject({
      type: 'chunk', captureId: 'capture-2',
    });
  });
});
