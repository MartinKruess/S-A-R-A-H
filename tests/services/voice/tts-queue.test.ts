// tests/services/voice/tts-queue.test.ts

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
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
  let onPlaybackCancel: ReturnType<typeof vi.fn>;
  let queue: TtsQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTts = makeMockTts();
    onAudioReady = vi.fn();
    onQueueEmpty = vi.fn();
    onError = vi.fn();
    onPlaybackCancel = vi.fn();
    queue = new TtsQueue(
      mockTts,
      onAudioReady,
      onQueueEmpty,
      onError,
      undefined,
      undefined,
      onPlaybackCancel,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(queue.hasTurn(TURN_ID)).toBe(true);

    playbackDone();

    expect(onQueueEmpty).toHaveBeenCalledOnce();
    expect(queue.hasTurn(TURN_ID)).toBe(false);
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
    expect(onPlaybackCancel).toHaveBeenCalledWith(
      TURN_ID,
      onAudioReady.mock.calls[0][1],
    );
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
    expect(onError).toHaveBeenCalledWith(boom, item('Bad sentence.'));
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

  it('reports a correlated renderer playback failure and continues the queue', async () => {
    const second = { turnId: 'turn-2', outputId: 'output-2', text: 'Second.' };
    queue.enqueue(item('First.'));
    queue.enqueue(second);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));
    const firstPlaybackId = onAudioReady.mock.calls[0][1] as string;
    const error = new Error('Renderer playback failed');

    queue.playbackFailed(TURN_ID, firstPlaybackId, error);

    expect(onError).toHaveBeenCalledWith(error, item('First.'));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(second);
    expect(queue.hasTurn('turn-2')).toBe(true);

    playbackDone(1);
    expect(queue.isActive).toBe(false);
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  it('ignores a stale renderer playback failure', async () => {
    queue.enqueue(item('Current.'));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    const playbackId = onAudioReady.mock.calls[0][1] as string;

    queue.playbackFailed(TURN_ID, 'stale-playback', new Error('stale'));

    expect(onError).not.toHaveBeenCalled();
    expect(queue.isActive).toBe(true);
    queue.playbackDone(TURN_ID, playbackId);
    expect(queue.isActive).toBe(false);
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

  it('recovers when the renderer never acknowledges playback and ignores its late ACK', async () => {
    vi.useFakeTimers();
    queue.enqueue(item('First.'));
    queue.enqueue({ turnId: 'turn-2', outputId: 'output-2', text: 'Second.' });
    await vi.runAllTicks();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    const firstPlaybackId = onAudioReady.mock.calls[0][1] as string;

    await vi.advanceTimersByTimeAsync(5_001);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Audio playback acknowledgement timed out' }),
      item('First.'),
    );
    expect(onPlaybackCancel).toHaveBeenCalledWith(TURN_ID, firstPlaybackId);
    expect(onAudioReady).toHaveBeenCalledTimes(2);

    queue.playbackDone(TURN_ID, firstPlaybackId);
    expect(onAudioReady).toHaveBeenCalledTimes(2);
    expect(queue.hasTurn('turn-2')).toBe(true);

    playbackDone(1);
    expect(queue.isActive).toBe(false);
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  it('clears the playback timeout when stopped', async () => {
    vi.useFakeTimers();
    queue.enqueue(item('Stop before timeout.'));
    await vi.runAllTicks();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());

    queue.stop();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(onError).not.toHaveBeenCalled();
    expect(onQueueEmpty).not.toHaveBeenCalled();
    expect(queue.isActive).toBe(false);
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

  it('cancels only the selected turn and ignores its late synthesis', async () => {
    let resolveOld = (_audio: Float32Array): void => {};
    vi.mocked(mockTts.speak)
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Float32Array([2]));

    queue.enqueue(item('Old turn.', 'old-output'));
    queue.enqueue({ turnId: 'turn-2', outputId: 'new-output', text: 'New turn.' });
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledOnce());

    queue.cancelTurn(TURN_ID);
    resolveOld(new Float32Array([1]));

    await vi.waitUntil(() => onAudioReady.mock.calls.length === 1);
    expect(onAudioReady.mock.calls[0][0]).toMatchObject({
      turnId: 'turn-2',
      outputId: 'new-output',
    });
  });

  it('keeps another turn queued when the canceled turn owns active playback', async () => {
    const turnTwo = { turnId: 'turn-2', outputId: 'new-output', text: 'New turn.' };
    queue.enqueue(item('Old turn.', 'old-output'));
    queue.enqueue(turnTwo);
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());

    queue.cancelTurn(TURN_ID);

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onPlaybackCancel).toHaveBeenCalledWith(
      TURN_ID,
      onAudioReady.mock.calls[0][1],
    );
    expect(onAudioReady.mock.calls[1][0]).toEqual(turnTwo);
    expect(mockTts.stop).not.toHaveBeenCalled();
    expect(queue.hasTurn(TURN_ID)).toBe(false);
    expect(queue.hasTurn('turn-2')).toBe(true);
  });

  it('drops canceled prebuffer synthesis but continues with the next turn', async () => {
    let resolveCanceledPrebuffer = (_audio: Float32Array): void => {};
    vi.mocked(mockTts.speak)
      .mockResolvedValueOnce(new Float32Array([1]))
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => {
        resolveCanceledPrebuffer = resolve;
      }))
      .mockResolvedValueOnce(new Float32Array([3]));

    queue.enqueue(item('Old one.', 'old-output-1'));
    queue.enqueue(item('Old two.', 'old-output-2'));
    queue.enqueue({ turnId: 'turn-2', outputId: 'new-output', text: 'New turn.' });
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));

    queue.cancelTurn(TURN_ID);
    resolveCanceledPrebuffer(new Float32Array([2]));

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls.map(([queuedItem]) => queuedItem.text)).toEqual([
      'Old one.',
      'New turn.',
    ]);
    expect(queue.hasTurn(TURN_ID)).toBe(false);
    expect(queue.hasTurn('turn-2')).toBe(true);
  });
});
