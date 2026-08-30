import { randomUUID } from 'crypto';
import type { OutputId, PlaybackId, TurnId } from '../../core/turn-contract.js';
import type { TtsProvider } from './tts-provider.interface.js';

const TTS_SAMPLE_RATE = 22_050;
const PLAYBACK_ACK_GRACE_MS = 5_000;
const PLAYBACK_ACK_MAX_MS = 120_000;

export const TTS_PRIORITY = {
  BACKGROUND: 0,
  NORMAL: 100,
  TIMER: 200,
  CRITICAL: 300,
  USER: 400,
} as const;

export type TtsPriority = typeof TTS_PRIORITY[keyof typeof TTS_PRIORITY];

type QueueState = 'idle' | 'synthesizing' | 'playing' | 'prebuffering' | 'paused';

export interface TtsQueueItem {
  turnId: TurnId;
  outputId: OutputId;
  text: string;
  /** Defaults to normal requested speech so existing callers retain FIFO behavior. */
  priority?: TtsPriority;
  /** Pauses lower-priority speech after this item's successful playback acknowledgement. */
  pauseAfterPlayback?: boolean;
}

interface QueueEntry {
  item: TtsQueueItem;
  sequence: number;
}

interface BufferedAudio {
  entry: QueueEntry;
  audio: Float32Array;
}

interface PauseRequest {
  turnId: TurnId;
  priority: TtsPriority;
}

export class TtsQueue {
  private queue: QueueEntry[] = [];
  private state: QueueState = 'idle';
  private preBuffer: BufferedAudio | null = null;
  private activePlayback: {
    entry: QueueEntry;
    playbackId: PlaybackId;
  } | null = null;
  private playbackAckTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSynthesis: QueueEntry | null = null;
  private activeSynthesisMode: 'playback' | 'prebuffer' | null = null;
  private pauseRequests: PauseRequest[] = [];
  private nextSequence = 0;
  private generation = 0;
  private synthesisAbort = new AbortController();

  constructor(
    private tts: TtsProvider,
    private onAudioReady: (
      item: TtsQueueItem,
      playbackId: PlaybackId,
      audio: Float32Array,
      sampleRate: number,
    ) => void,
    private onQueueEmpty: () => void,
    private onError: (error: Error, item: TtsQueueItem) => void,
    private onTiming?: (ms: number, turnId: TurnId) => void,
    private onPlaybackProgress?: (turnId: TurnId) => void,
    private onPlaybackCancel?: (turnId: TurnId, playbackId: PlaybackId) => void,
  ) {}

  enqueue(item: TtsQueueItem): void {
    const entry = { item, sequence: this.nextSequence++ };
    this.insertQueued(entry);
    if (
      this.activeSynthesis
      && this.activeSynthesisMode === 'prebuffer'
      && this.compareEntries(entry, this.activeSynthesis) < 0
    ) {
      const interrupted = this.activeSynthesis;
      this.invalidateSynthesis();
      this.insertQueued(interrupted);
      if (this.activePlayback) this.startPreBuffer();
      else void this.continueQueue();
      return;
    }
    if (!this.activePlayback && !this.activeSynthesis) void this.continueQueue();
  }

  playbackDone(turnId: TurnId, playbackId: PlaybackId): void {
    if (
      !this.activePlayback
      || this.activePlayback.entry.item.turnId !== turnId
      || this.activePlayback.playbackId !== playbackId
    ) return;
    this.finishPlayback(true);
  }

  playbackFailed(
    turnId: TurnId,
    playbackId: PlaybackId,
    error: Error,
    stopRemaining = false,
  ): void {
    if (
      !this.activePlayback
      || this.activePlayback.entry.item.turnId !== turnId
      || this.activePlayback.playbackId !== playbackId
    ) return;
    this.onError(error, this.activePlayback.entry.item);
    if (stopRemaining) {
      this.stop();
      return;
    }
    this.finishPlayback(false);
  }

  private finishPlayback(completedSuccessfully: boolean): void {
    if (!this.activePlayback) return;
    const completedEntry = this.activePlayback.entry;
    this.clearPlaybackAckTimer();
    this.activePlayback = null;
    this.onPlaybackProgress?.(completedEntry.item.turnId);

    if (completedSuccessfully && completedEntry.item.pauseAfterPlayback) {
      this.pauseRequests.push({
        turnId: completedEntry.item.turnId,
        priority: this.priorityOf(completedEntry),
      });
    }

    if (this.activeSynthesis) {
      this.state = 'synthesizing';
      return;
    }
    void this.continueQueue();
  }

  stop(): void {
    this.invalidateSynthesis();
    this.tts.stop();
    this.queue = [];
    this.preBuffer = null;
    this.pauseRequests = [];
    this.clearPlaybackAckTimer();
    if (this.activePlayback) {
      this.onPlaybackCancel?.(
        this.activePlayback.entry.item.turnId,
        this.activePlayback.playbackId,
      );
    }
    this.activePlayback = null;
    this.state = 'idle';
  }

  cancelTurn(turnId: TurnId): void {
    this.queue = this.queue.filter((entry) => entry.item.turnId !== turnId);
    if (this.preBuffer?.entry.item.turnId === turnId) this.preBuffer = null;
    this.pauseRequests = this.pauseRequests.filter((request) => request.turnId !== turnId);

    const cancelsSynthesis = this.activeSynthesis?.item.turnId === turnId;
    if (cancelsSynthesis) this.invalidateSynthesis();

    if (this.activePlayback?.entry.item.turnId === turnId) {
      this.onPlaybackCancel?.(turnId, this.activePlayback.playbackId);
      this.finishPlayback(false);
      return;
    }

    if (this.activePlayback) {
      if (cancelsSynthesis || !this.activeSynthesis) this.startPreBuffer();
      return;
    }
    if (!this.activeSynthesis) void this.continueQueue();
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  get isPaused(): boolean {
    return this.pauseRequests.length > 0;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  hasTurn(turnId: TurnId): boolean {
    return this.activePlayback?.entry.item.turnId === turnId
      || this.activeSynthesis?.item.turnId === turnId
      || this.preBuffer?.entry.item.turnId === turnId
      || this.queue.some((entry) => entry.item.turnId === turnId)
      || this.pauseRequests.some((request) => request.turnId === turnId);
  }

  /**
   * - Removes every active priority barrier.
   * - Continues with preserved audio before synthesizing later equal-priority items.
   *
   * @category Service
   */
  resume(): void {
    if (!this.isPaused) return;
    this.pauseRequests = [];
    if (this.activePlayback) {
      this.startPreBuffer();
      return;
    }
    if (!this.activeSynthesis) void this.continueQueue();
  }

  private async continueQueue(): Promise<void> {
    if (this.activePlayback || this.activeSynthesis) return;

    const queued = this.peekEligibleQueued();
    if (this.preBuffer && this.isEligible(this.preBuffer.entry)) {
      if (!queued || this.compareEntries(this.preBuffer.entry, queued) <= 0) {
        const buffered = this.preBuffer;
        this.preBuffer = null;
        this.state = 'playing';
        this.emitAudio(buffered.entry, buffered.audio);
        this.startPreBuffer();
        return;
      }
    }

    const entry = this.takeEligibleQueued();
    if (entry) {
      await this.synthesizeForPlayback(entry);
      return;
    }

    if (this.isPaused) {
      this.state = 'paused';
      return;
    }

    const shouldNotify = this.state !== 'idle';
    this.state = 'idle';
    if (shouldNotify) this.onQueueEmpty();
  }

  private async synthesizeForPlayback(entry: QueueEntry): Promise<void> {
    const generation = this.generation;
    this.activeSynthesis = entry;
    this.activeSynthesisMode = 'playback';
    this.state = 'synthesizing';
    try {
      const startedAt = performance.now();
      const audio = await this.tts.speak(entry.item.text, this.synthesisAbort.signal);
      if (generation !== this.generation) return;
      this.activeSynthesis = null;
      this.activeSynthesisMode = null;
      this.onTiming?.(Math.round(performance.now() - startedAt), entry.item.turnId);
      this.state = 'playing';
      this.emitAudio(entry, audio);
      this.startPreBuffer();
    } catch (value) {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.activeSynthesis = null;
      this.activeSynthesisMode = null;
      this.onError(value instanceof Error ? value : new Error(String(value)), entry.item);
      await this.continueQueue();
    }
  }

  private startPreBuffer(): void {
    if (!this.activePlayback || this.activeSynthesis || this.preBuffer) return;
    const entry = this.takeEligibleQueued();
    if (!entry) return;
    const generation = this.generation;
    this.activeSynthesis = entry;
    this.activeSynthesisMode = 'prebuffer';
    this.state = 'prebuffering';

    void this.tts.speak(entry.item.text, this.synthesisAbort.signal).then((audio) => {
      if (generation !== this.generation) return;
      this.activeSynthesis = null;
      this.activeSynthesisMode = null;
      this.preBuffer = { entry, audio };
      if (this.activePlayback) {
        this.state = 'prebuffering';
        return;
      }
      void this.continueQueue();
    }, (value) => {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.activeSynthesis = null;
      this.activeSynthesisMode = null;
      this.onError(value instanceof Error ? value : new Error(String(value)), entry.item);
      if (this.activePlayback) {
        this.state = 'playing';
        this.startPreBuffer();
        return;
      }
      void this.continueQueue();
    });
  }

  private emitAudio(entry: QueueEntry, audio: Float32Array): void {
    const playbackId = randomUUID();
    this.activePlayback = { entry, playbackId };
    this.clearPlaybackAckTimer();
    const audioDurationMs = Math.ceil((audio.length / TTS_SAMPLE_RATE) * 1_000);
    const timeoutMs = Math.min(
      PLAYBACK_ACK_MAX_MS,
      Math.max(PLAYBACK_ACK_GRACE_MS, audioDurationMs + PLAYBACK_ACK_GRACE_MS),
    );
    this.playbackAckTimer = setTimeout(() => {
      if (this.activePlayback?.playbackId !== playbackId) return;
      this.onError(new Error('Audio playback acknowledgement timed out'), entry.item);
      this.onPlaybackCancel?.(entry.item.turnId, playbackId);
      this.finishPlayback(false);
    }, timeoutMs);
    this.onAudioReady(entry.item, playbackId, audio, TTS_SAMPLE_RATE);
  }

  private insertQueued(entry: QueueEntry): void {
    const index = this.queue.findIndex((queued) => this.compareEntries(entry, queued) < 0);
    if (index === -1) this.queue.push(entry);
    else this.queue.splice(index, 0, entry);
  }

  private peekEligibleQueued(): QueueEntry | null {
    return this.queue.find((entry) => this.isEligible(entry)) ?? null;
  }

  private takeEligibleQueued(): QueueEntry | null {
    const index = this.queue.findIndex((entry) => this.isEligible(entry));
    if (index === -1) return null;
    return this.queue.splice(index, 1)[0] ?? null;
  }

  private isEligible(entry: QueueEntry): boolean {
    if (!this.isPaused) return true;
    const barrier = Math.max(...this.pauseRequests.map((request) => request.priority));
    return this.priorityOf(entry) >= barrier;
  }

  private compareEntries(left: QueueEntry, right: QueueEntry): number {
    const priorityDifference = this.priorityOf(right) - this.priorityOf(left);
    return priorityDifference || left.sequence - right.sequence;
  }

  private priorityOf(entry: QueueEntry): TtsPriority {
    return entry.item.priority ?? TTS_PRIORITY.NORMAL;
  }

  private invalidateSynthesis(): void {
    this.generation += 1;
    this.synthesisAbort.abort();
    this.synthesisAbort = new AbortController();
    this.activeSynthesis = null;
    this.activeSynthesisMode = null;
  }

  private clearPlaybackAckTimer(): void {
    if (!this.playbackAckTimer) return;
    clearTimeout(this.playbackAckTimer);
    this.playbackAckTimer = null;
  }
}
