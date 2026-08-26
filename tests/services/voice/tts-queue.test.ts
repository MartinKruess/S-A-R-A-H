// tests/services/voice/tts-queue.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsQueue } from '../../../src/services/voice/tts-queue.js';
import type { TtsProvider } from '../../../src/services/voice/tts-provider.interface.js';

const SAMPLE_AUDIO = new Float32Array([0.1, 0.2]);
const TURN_ID = 'turn-1';

function item(text: string, outputId = `output-${text}`) {
  return { turnId: TURN_ID, outputId, text };
}

function makeMockTts(overrides: Partial<TtsProvider> = {}): TtsProvider {
  return {
    id: 'mock',
    init: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue(SAMPLE_AUDIO),
    stop: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('TtsQueue', () => {
  let mockTts: TtsProvider;
  let onAudioReady: ReturnType<typeof vi.fn>;
  let onQueueEmpty: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let queue: TtsQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTts = makeMockTts();
    onAudioReady = vi.fn();
    onQueueEmpty = vi.fn();
    onError = vi.fn();
    queue = new TtsQueue(mockTts, onAudioReady, onQueueEmpty, onError);
  });

  function playbackDone(callIndex = onAudioReady.mock.calls.length - 1): void {
    const [queuedItem, playbackId] = onAudioReady.mock.calls[callIndex] as [
      { turnId: string },
      string,
    ];
    queue.playbackDone(queuedItem.turnId, playbackId);
  }

  // ── Single sentence ──────────────────────────────────────────────────────────

  it('single sentence: enqueue → onAudioReady fires → playbackDone → onQueueEmpty', async () => {
    queue.enqueue(item('Hello world.'));

    // Let speak() resolve
    await vi.waitUntil(() => onAudioReady.mock.calls.length > 0);

    expect(onAudioReady).toHaveBeenCalledOnce();
    expect(onAudioReady).toHaveBeenCalledWith(
      item('Hello world.'),
      expect.any(String),
      SAMPLE_AUDIO,
      22_050,
    );
    expect(onQueueEmpty).not.toHaveBeenCalled();

    playbackDone();

    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  // ── Multiple sentences in order ──────────────────────────────────────────────

  it('multiple sentences: onAudioReady called in enqueue order', async () => {
    const audio1 = new Float32Array([1]);
    const audio2 = new Float32Array([2]);
    const audio3 = new Float32Array([3]);

    let callCount = 0;
    vi.mocked(mockTts.speak)
      .mockImplementationOnce(async () => { callCount++; return audio1; })
      .mockImplementationOnce(async () => { callCount++; return audio2; })
      .mockImplementationOnce(async () => { callCount++; return audio3; });

    queue.enqueue(item('One.'));
    queue.enqueue(item('Two.'));
    queue.enqueue(item('Three.'));

    // First audio ready
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);
    expect(onAudioReady).toHaveBeenNthCalledWith(1, item('One.'), expect.any(String), audio1, 22_050);

    // Signal playback done → second audio plays (may already be pre-buffered)
    playbackDone(0);
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 2);
    expect(onAudioReady).toHaveBeenNthCalledWith(2, item('Two.'), expect.any(String), audio2, 22_050);

    playbackDone(1);
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 3);
    expect(onAudioReady).toHaveBeenNthCalledWith(3, item('Three.'), expect.any(String), audio3, 22_050);

    playbackDone(2);
    expect(onQueueEmpty).toHaveBeenCalledOnce();

    // All three speak calls happened
    expect(mockTts.speak).toHaveBeenCalledTimes(3);
  });

  // ── Pre-buffering ────────────────────────────────────────────────────────────

  it('pre-buffering: second sentence starts synthesizing during first playback', async () => {
    // Use a controllable promise for the second speak() so we can verify the
    // call happens before playbackDone is signalled
    let resolveSecond!: (v: Float32Array) => void;
    const secondDone = new Promise<Float32Array>((res) => { resolveSecond = res; });

    vi.mocked(mockTts.speak)
      .mockResolvedValueOnce(new Float32Array([1]))
      .mockReturnValueOnce(secondDone);

    queue.enqueue(item('First.'));
    queue.enqueue(item('Second.'));

    // Wait for first onAudioReady (first sentence synthesized)
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);

    // speak() should have been called twice already (first + pre-buffer)
    expect(mockTts.speak).toHaveBeenCalledTimes(2);

    // Resolve the second speak and signal playback done
    resolveSecond(new Float32Array([2]));
    playbackDone(0);

    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 2);
    expect(onAudioReady).toHaveBeenCalledTimes(2);

    playbackDone(1);
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  // ── stop() ───────────────────────────────────────────────────────────────────

  it('stop() clears queue and resets state', async () => {
    queue.enqueue(item('One.'));
    queue.enqueue(item('Two.'));
    queue.enqueue(item('Three.'));

    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);

    queue.stop();

    expect(queue.isActive).toBe(false);
    expect(queue.pendingCount).toBe(0);
    // onQueueEmpty should NOT fire after stop()
    expect(onQueueEmpty).not.toHaveBeenCalled();
  });

  it('stop() calls tts.stop()', () => {
    queue.enqueue(item('Hello.'));
    queue.stop();
    expect(mockTts.stop).toHaveBeenCalledOnce();
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it('error in tts.speak() calls onError', async () => {
    const boom = new Error('TTS failure');
    vi.mocked(mockTts.speak).mockRejectedValueOnce(boom);

    queue.enqueue(item('Bad sentence.'));

    await vi.waitUntil(() => onError.mock.calls.length > 0);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onAudioReady).not.toHaveBeenCalled();
  });

  it('error in tts.speak() still triggers onQueueEmpty when queue is exhausted', async () => {
    vi.mocked(mockTts.speak).mockRejectedValueOnce(new Error('oops'));

    queue.enqueue(item('Bad.'));

    await vi.waitUntil(() => onQueueEmpty.mock.calls.length > 0);
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  // ── playbackDone() guard ─────────────────────────────────────────────────────

  it('playbackDone() when not playing is ignored (no crash)', () => {
    expect(() => queue.playbackDone(TURN_ID, 'missing')).not.toThrow();
    expect(onQueueEmpty).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  // ── isActive / pendingCount ──────────────────────────────────────────────────

  it('isActive and pendingCount are correct at each stage', async () => {
    expect(queue.isActive).toBe(false);
    expect(queue.pendingCount).toBe(0);

    queue.enqueue(item('First.'));
    queue.enqueue(item('Second.'));

    // Immediately after enqueue: first is being synthesized, second is pending
    expect(queue.isActive).toBe(true);
    expect(queue.pendingCount).toBe(1); // second is still in queue

    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);

    // First is playing, second may have been taken for pre-buffer
    expect(queue.isActive).toBe(true);

    playbackDone(0);
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 2);

    playbackDone(1);
    expect(queue.isActive).toBe(false);
    expect(queue.pendingCount).toBe(0);
  });

  // ── Reuse after stop ─────────────────────────────────────────────────────────

  it('enqueue after stop works correctly (queue is reusable)', async () => {
    queue.enqueue(item('Before stop.'));
    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);
    queue.stop();

    vi.clearAllMocks();

    // Re-use the same queue instance
    queue.enqueue(item('After stop.'));

    await vi.waitUntil(() => onAudioReady.mock.calls.length >= 1);
    expect(onAudioReady).toHaveBeenCalledOnce();

    playbackDone();
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  it('discards synthesis that resolves after stop and never injects it into the next turn', async () => {
    let resolveOld = (_audio: Float32Array): void => {};
    vi.mocked(mockTts.speak)
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Float32Array([2]));

    queue.enqueue(item('Old turn.', 'old-output'));
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledOnce());
    queue.stop();
    queue.enqueue({ turnId: 'turn-2', outputId: 'new-output', text: 'New turn.' });
    resolveOld(new Float32Array([1]));

    await vi.waitUntil(() => onAudioReady.mock.calls.length === 1);
    expect(onAudioReady.mock.calls[0][0]).toMatchObject({
      turnId: 'turn-2',
      outputId: 'new-output',
    });
    expect(onAudioReady.mock.calls[0][2]).toEqual(new Float32Array([2]));
  });
});
