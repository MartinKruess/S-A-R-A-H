// tests/services/voice/tts-queue.test.ts

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TTS_PRIORITY,
  TtsQueue,
  type TtsQueueItem,
} from '../../../src/services/voice/tts-queue.js';
import type { TtsProvider } from '../../../src/services/voice/tts-provider.interface.js';

const SAMPLE_AUDIO = new Float32Array([0.1, 0.2]);
const TURN_ID = 'turn-1';

function item(
  text: string,
  outputId = `output-${text}`,
  options: Pick<TtsQueueItem, 'priority' | 'pauseAfterPlayback'> = {},
): TtsQueueItem {
  return { turnId: TURN_ID, outputId, text, ...options };
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

  // ── Priority and pause barrier ──────────────────────────────────────────────

  it('plays a timer after the current sentence, preserves the normal prebuffer, and resumes it', async () => {
    const firstAudio = new Float32Array([1]);
    const bufferedAudio = new Float32Array([2]);
    const timerAudio = new Float32Array([3]);
    const normal = item('Buffered normal.');
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    vi.mocked(mockTts.speak)
      .mockResolvedValueOnce(firstAudio)
      .mockResolvedValueOnce(bufferedAudio)
      .mockResolvedValueOnce(timerAudio);

    queue.enqueue(item('Current.'));
    queue.enqueue(normal);
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    queue.enqueue(timer);

    playbackDone(0);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(timer);
    expect(onAudioReady.mock.calls[1][2]).toEqual(timerAudio);

    playbackDone(1);
    expect(queue.isPaused).toBe(true);
    expect(onAudioReady).toHaveBeenCalledTimes(2);

    queue.resume();
    queue.resume();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(3));
    expect(onAudioReady.mock.calls[2][0]).toEqual(normal);
    expect(onAudioReady.mock.calls[2][2]).toEqual(bufferedAudio);
    expect(mockTts.speak).toHaveBeenCalledTimes(3);
    expect(queue.isPaused).toBe(false);

    playbackDone(2);
    expect(onQueueEmpty).toHaveBeenCalledOnce();
  });

  it('selects critical speech before timers while keeping equal-priority timers FIFO-stable', async () => {
    const timerOne: TtsQueueItem = {
      turnId: 'timer-1',
      outputId: 'timer-output-1',
      text: 'Timer one.',
      priority: TTS_PRIORITY.TIMER,
    };
    const timerTwo: TtsQueueItem = {
      turnId: 'timer-2',
      outputId: 'timer-output-2',
      text: 'Timer two.',
      priority: TTS_PRIORITY.TIMER,
    };
    const critical: TtsQueueItem = {
      turnId: 'critical-turn',
      outputId: 'critical-output',
      text: 'Critical.',
      priority: TTS_PRIORITY.CRITICAL,
    };

    queue.enqueue(item('Current.'));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    queue.enqueue(timerOne);
    queue.enqueue(timerTwo);
    queue.enqueue(critical);

    playbackDone(0);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(critical);
    playbackDone(1);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(3));
    expect(onAudioReady.mock.calls[2][0]).toEqual(timerOne);
    playbackDone(2);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(4));
    expect(onAudioReady.mock.calls[3][0]).toEqual(timerTwo);
    playbackDone(3);
  });

  it('does not let an in-flight normal prebuffer synthesis overtake a waiting timer', async () => {
    let resolveNormal = (_audio: Float32Array): void => {};
    const staleNormalAudio = new Float32Array([2]);
    const timerAudio = new Float32Array([3]);
    const resynthesizedNormalAudio = new Float32Array([4]);
    const normal = item('Slow normal.');
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
    };
    vi.mocked(mockTts.speak)
      .mockResolvedValueOnce(new Float32Array([1]))
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => {
        resolveNormal = resolve;
      }))
      .mockResolvedValueOnce(timerAudio)
      .mockResolvedValueOnce(resynthesizedNormalAudio);

    queue.enqueue(item('Current.'));
    queue.enqueue(normal);
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    queue.enqueue(timer);
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(3));
    playbackDone(0);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(timer);
    expect(onAudioReady.mock.calls[1][2]).toEqual(timerAudio);

    resolveNormal(staleNormalAudio);
    playbackDone(1);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(3));
    expect(onAudioReady.mock.calls[2][0]).toEqual(normal);
    expect(onAudioReady.mock.calls[2][2]).toEqual(resynthesizedNormalAudio);
    expect(mockTts.speak).toHaveBeenCalledTimes(4);
    playbackDone(2);
  });

  it('preempts a normal playback synthesis that has not started playing yet', async () => {
    let resolveNormal = (_audio: Float32Array): void => {};
    vi.mocked(mockTts.speak)
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => {
        resolveNormal = resolve;
      }))
      .mockResolvedValueOnce(new Float32Array([2]))
      .mockResolvedValueOnce(new Float32Array([3]));

    queue.enqueue(item('Slow normal.'));
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledOnce());
    queue.enqueue({
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
    });

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    expect(onAudioReady.mock.calls[0][0].turnId).toBe('timer-turn');
    resolveNormal(new Float32Array([1]));
    playbackDone(0);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0].text).toBe('Slow normal.');
    playbackDone(1);
  });

  it('keeps an intentional pause for lower-priority chunks that arrive later', async () => {
    queue.enqueue({
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    });

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    playbackDone(0);

    expect(queue.isPaused).toBe(true);
    queue.enqueue(item('Later streaming chunk.'));
    expect(onAudioReady).toHaveBeenCalledOnce();

    queue.resume();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0].text).toBe('Later streaming chunk.');
    playbackDone(1);
  });

  it('lets all equal-priority timers cross the pause barrier before blocking normal speech', async () => {
    const normal = item('Normal after timers.');
    const timerOne: TtsQueueItem = {
      turnId: 'timer-1',
      outputId: 'timer-output-1',
      text: 'Timer one.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const timerTwo: TtsQueueItem = {
      turnId: 'timer-2',
      outputId: 'timer-output-2',
      text: 'Timer two.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };

    queue.enqueue(item('Current.'));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    queue.enqueue(normal);
    queue.enqueue(timerOne);
    queue.enqueue(timerTwo);
    playbackDone(0);

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(timerOne);
    playbackDone(1);
    expect(queue.isPaused).toBe(true);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(3));
    expect(onAudioReady.mock.calls[2][0]).toEqual(timerTwo);
    playbackDone(2);
    expect(queue.isPaused).toBe(true);
    expect(onAudioReady).toHaveBeenCalledTimes(3);

    queue.resume();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(4));
    expect(onAudioReady.mock.calls[3][0]).toEqual(normal);
    playbackDone(3);
  });

  it('buffers additional normal chunks while paused and releases them in FIFO order on resume', async () => {
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const normalOne = item('Normal one.', 'normal-output-1');
    const normalTwo = item('Normal two.', 'normal-output-2');

    queue.enqueue(timer);
    queue.enqueue(normalOne);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    playbackDone(0);
    expect(queue.isPaused).toBe(true);

    queue.enqueue(normalTwo);
    expect(onAudioReady).toHaveBeenCalledOnce();
    queue.resume();

    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(normalOne);
    playbackDone(1);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(3));
    expect(onAudioReady.mock.calls[2][0]).toEqual(normalTwo);
    playbackDone(2);
  });

  it('stop clears a pause and prevents late synthesis from reviving it', async () => {
    let resolveNormal = (_audio: Float32Array): void => {};
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    vi.mocked(mockTts.speak)
      .mockResolvedValueOnce(new Float32Array([1]))
      .mockImplementationOnce(() => new Promise<Float32Array>((resolve) => {
        resolveNormal = resolve;
      }));

    queue.enqueue(timer);
    queue.enqueue(item('Slow normal.'));
    await vi.waitFor(() => expect(mockTts.speak).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    playbackDone(0);
    expect(queue.isPaused).toBe(true);

    queue.stop();
    resolveNormal(new Float32Array([2]));
    await Promise.resolve();
    expect(queue.isPaused).toBe(false);
    expect(queue.isActive).toBe(false);
    expect(onAudioReady).toHaveBeenCalledOnce();
  });

  it('canceling the turn that owns a completed pause releases preserved normal audio', async () => {
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const normal: TtsQueueItem = {
      turnId: 'normal-turn',
      outputId: 'normal-output',
      text: 'Normal.',
    };

    queue.enqueue(timer);
    queue.enqueue(normal);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    playbackDone(0);
    expect(queue.isPaused).toBe(true);

    queue.cancelTurn('timer-turn');
    expect(queue.isPaused).toBe(false);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(normal);
    playbackDone(1);
  });

  it('does not activate a pause when renderer playback of the pause item fails', async () => {
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const normal = item('Normal.');
    queue.enqueue(timer);
    queue.enqueue(normal);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());

    queue.playbackFailed('timer-turn', onAudioReady.mock.calls[0][1], new Error('failed'));

    expect(queue.isPaused).toBe(false);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    expect(onAudioReady.mock.calls[1][0]).toEqual(normal);
    playbackDone(1);
  });

  it('does not activate a pause after playback timeout and ignores the late ACK', async () => {
    vi.useFakeTimers();
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const normal = item('Normal.');
    queue.enqueue(timer);
    queue.enqueue(normal);
    await vi.runAllTicks();
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    const timerPlaybackId = onAudioReady.mock.calls[0][1] as string;

    await vi.advanceTimersByTimeAsync(5_001);

    expect(queue.isPaused).toBe(false);
    expect(onAudioReady).toHaveBeenCalledTimes(2);
    queue.playbackDone('timer-turn', timerPlaybackId);
    expect(onAudioReady).toHaveBeenCalledTimes(2);
    playbackDone(1);
  });

  it('a non-recoverable renderer failure clears an existing pause and buffered speech', async () => {
    const timer: TtsQueueItem = {
      turnId: 'timer-turn',
      outputId: 'timer-output',
      text: 'Timer elapsed.',
      priority: TTS_PRIORITY.TIMER,
      pauseAfterPlayback: true,
    };
    const critical: TtsQueueItem = {
      turnId: 'critical-turn',
      outputId: 'critical-output',
      text: 'Critical.',
      priority: TTS_PRIORITY.CRITICAL,
    };
    queue.enqueue(timer);
    queue.enqueue(item('Normal.'));
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledOnce());
    playbackDone(0);
    expect(queue.isPaused).toBe(true);

    queue.enqueue(critical);
    await vi.waitFor(() => expect(onAudioReady).toHaveBeenCalledTimes(2));
    queue.playbackFailed(
      'critical-turn',
      onAudioReady.mock.calls[1][1],
      new Error('renderer unavailable'),
      true,
    );

    expect(queue.isPaused).toBe(false);
    expect(queue.isActive).toBe(false);
    expect(queue.pendingCount).toBe(0);
  });
});
