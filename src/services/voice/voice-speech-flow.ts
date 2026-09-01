import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import type { BusEvents, PrioritySpeechCategory } from '../../core/bus-events.js';
import type { TypedBusMessage } from '../../core/types.js';
import type { OutputId, PlaybackId, TurnId } from '../../core/turn-contract.js';
import type { AudioManager } from './audio-manager.js';
import type { TtsProvider } from './tts-provider.interface.js';
import {
  TTS_PRIORITY,
  TtsQueue,
  type TtsPriority,
  type TtsQueueItem,
} from './tts-queue.js';
import {
  VoiceOutputStore,
  type VoiceOutputLifecycle,
} from './voice-output-store.js';
import type { VoiceMode, VoiceState } from './voice-types.js';

const PRIORITY_SPEECH_QUEUE_PRIORITY: Record<PrioritySpeechCategory, TtsPriority> = {
  background: TTS_PRIORITY.BACKGROUND,
  normal: TTS_PRIORITY.NORMAL,
  timer: TTS_PRIORITY.TIMER,
  critical: TTS_PRIORITY.CRITICAL,
  user: TTS_PRIORITY.USER,
};

interface VoiceSpeechFlowHost {
  getVoiceMode: () => VoiceMode;
  getVoiceState: () => VoiceState;
  isRendererAvailable: () => boolean;
  isTtsAvailable: () => boolean;
  shouldSpeak: (turnId: TurnId, forceSpeak?: boolean) => boolean;
  shouldSpeakError: (turnId: TurnId, outputRequestedSpeech: boolean) => boolean;
  isTurnOwned: (turnId: TurnId, hasOutput: boolean) => boolean;
  removeProcessingTurn: (turnId: TurnId) => void;
  setState: (state: VoiceState) => void;
  restoreOwnedVoiceState: () => void;
  resumeKeywordConversation: () => boolean;
  onSpeechTurnDone: (turnId: TurnId) => void;
}

/** Owns streamed speech output, TTS queueing, and correlated renderer playback. */
export class VoiceSpeechFlow {
  private queue: TtsQueue | null = null;
  private playbackUnsub: (() => void) | null = null;
  private readonly outputStore: VoiceOutputStore;
  private activePlaybackTurn: TurnId | null = null;
  private activePlayback: PlaybackId | null = null;
  private deferred: TtsQueueItem[] = [];
  private readonly spokenTurns = new Set<TurnId>();
  private readonly prioritySpeechTurns = new Set<TurnId>();
  private readonly completedTurns = new Set<TurnId>();
  private readonly routerErrorTurns = new Set<TurnId>();

  constructor(
    private readonly context: AppContext,
    private readonly tts: TtsProvider,
    private readonly audio: AudioManager,
    private readonly host: VoiceSpeechFlowHost,
  ) {
    this.outputStore = new VoiceOutputStore(host.shouldSpeak);
  }

  get ttsQueue(): TtsQueue | null {
    return this.queue;
  }

  get outputs(): Map<OutputId, VoiceOutputLifecycle> {
    return this.outputStore.outputs;
  }

  get activeOutput(): VoiceOutputLifecycle | null {
    return this.outputStore.active;
  }

  get activeOutputTurnId(): TurnId | null {
    return this.activeOutput?.turnId ?? null;
  }

  get activeOutputText(): string {
    return this.activeOutput?.text ?? '';
  }

  get activePlaybackTurnId(): TurnId | null {
    return this.activePlaybackTurn;
  }

  get activePlaybackId(): PlaybackId | null {
    return this.activePlayback;
  }

  get llmStreaming(): boolean {
    return this.outputStore.llmStreaming;
  }

  get isPaused(): boolean {
    return this.queue?.isPaused ?? false;
  }

  get isActive(): boolean {
    return this.queue?.isActive ?? false;
  }

  get deferredSentences(): TtsQueueItem[] {
    return this.deferred;
  }

  get spokenTurnIds(): ReadonlySet<TurnId> {
    return this.spokenTurns;
  }

  get priorityTurnIds(): ReadonlySet<TurnId> {
    return this.prioritySpeechTurns;
  }

  start(): void {
    if (this.queue) return;
    this.queue = new TtsQueue(
      this.tts,
      (item, playbackId, audio, sampleRate) => {
        this.activePlaybackTurn = item.turnId;
        this.activePlayback = playbackId;
        this.audio.setPlaying(true);
        if (
          this.host.getVoiceState() !== 'speaking'
          && (item.priority ?? TTS_PRIORITY.NORMAL) !== TTS_PRIORITY.BACKGROUND
        ) {
          this.host.setState('speaking');
        }
        this.context.bus.emit('voice', 'voice:play-audio', {
          turnId: item.turnId,
          outputId: item.outputId,
          playbackId,
          audio: Array.from(audio),
          sampleRate,
        });
      },
      () => { this.onQueueEmpty(); },
      (error, item) => {
        console.error('[VoiceService] TTS error:', error);
        this.context.bus.emit('voice', 'voice:error', {
          turnId: item.turnId,
          outputId: item.outputId,
          message: error.message,
        });
      },
      (ms, turnId) => {
        this.context.bus.emit('voice', 'perf:timing', { turnId, label: 'tts', ms });
      },
      (turnId) => {
        if (this.activePlaybackTurn === turnId) this.clearActivePlayback();
        this.tryCompleteSpokenTurn(turnId);
      },
      (turnId, playbackId) => {
        this.context.bus.emit('voice', 'voice:stop-playback', { turnId, playbackId });
      },
    );

    this.playbackUnsub = this.context.bus.on('voice:playback-done', (message) => {
      if (
        this.activePlaybackTurn !== message.data.turnId
        || this.activePlayback !== message.data.playbackId
      ) return;
      this.clearActivePlayback();
      this.queue?.playbackDone(message.data.turnId, message.data.playbackId);
      if (this.queue?.isPaused) this.host.restoreOwnedVoiceState();
    });
  }

  destroy(): void {
    this.playbackUnsub?.();
    this.playbackUnsub = null;
    this.queue?.stop();
    this.queue = null;
    this.deferred = [];
    this.outputStore.clear();
    this.clearActivePlayback();
    this.spokenTurns.clear();
    this.prioritySpeechTurns.clear();
    this.completedTurns.clear();
    this.routerErrorTurns.clear();
  }

  handleMessage(msg: TypedBusMessage): boolean {
    if (msg.topic === 'llm:filler') {
      this.handleFiller(msg.data);
      return true;
    }
    if (msg.topic === 'voice:priority-speech') {
      this.handlePrioritySpeech(msg.data);
      return true;
    }
    if (msg.topic === 'voice:resume-speech') {
      this.resumeSpeech();
      return true;
    }
    if (msg.topic === 'llm:chunk') {
      this.handleChunk(msg.data);
      return true;
    }
    if (msg.topic === 'llm:done') {
      this.handleDone(msg.data);
      return true;
    }
    if (msg.topic === 'llm:error') {
      this.handleError(msg.data);
      return true;
    }
    return false;
  }

  handleTurnTerminal(turnId: TurnId, status: BusEvents['turn:terminal']['status']): boolean {
    this.routerErrorTurns.delete(turnId);
    if (status === 'canceled') {
      this.removeTurns(new Set([turnId]));
      return false;
    }
    for (const output of this.outputs.values()) {
      if (output.turnId !== turnId || output.complete || output.failed) continue;
      output.buffer.reset();
      output.complete = true;
      output.failed = status === 'error';
    }
    this.tryCompleteSpokenTurn(turnId);
    return this.spokenTurns.has(turnId);
  }

  markRouterError(turnId: TurnId): void {
    this.routerErrorTurns.add(turnId);
  }

  speakNotice(turnId: TurnId, message: string): void {
    const output = this.outputStore.getOrCreate(turnId, randomUUID(), true);
    output.text = message;
    output.complete = true;
    output.failed = true;
    this.enqueueSentences(output, [message]);
  }

  flushDeferredSentences(): void {
    if (
      this.host.getVoiceState() === 'listening'
      || !this.host.isRendererAvailable()
      || !this.queue
      || this.deferred.length === 0
    ) return;
    if (
      !this.queue.isPaused
      && (this.host.getVoiceState() === 'processing' || this.host.getVoiceState() === 'idle')
    ) {
      this.host.setState('speaking');
    }
    for (const item of this.deferred) this.queue.enqueue(item);
    this.deferred = [];
  }

  handlePlaybackFailure(
    turnId: TurnId,
    playbackId: PlaybackId,
    message: string,
    stopRemaining = false,
  ): void {
    if (this.activePlaybackTurn !== turnId || this.activePlayback !== playbackId) return;
    this.clearActivePlayback();
    this.queue?.playbackFailed(turnId, playbackId, new Error(message), stopRemaining);
    if (stopRemaining) this.reconcileStoppedRendererAudio();
  }

  stopAll(): void {
    this.queue?.stop();
    this.clearActivePlayback();
  }

  stopRendererAudio(): void {
    this.stopAll();
    this.reconcileStoppedRendererAudio();
  }

  removeTurns(turnIds: ReadonlySet<TurnId>): void {
    this.deferred = this.deferred.filter((item) => !turnIds.has(item.turnId));
    for (const turnId of turnIds) {
      this.outputStore.removeTurn(turnId);
      this.spokenTurns.delete(turnId);
      this.prioritySpeechTurns.delete(turnId);
      this.routerErrorTurns.delete(turnId);
      this.queue?.cancelTurn(turnId);
    }
  }

  retainDeferredTurn(turnId: TurnId): void {
    this.deferred = this.deferred.filter((item) => item.turnId === turnId);
  }

  completePriorityTurns(): void {
    for (const turnId of this.prioritySpeechTurns) this.tryCompleteSpokenTurn(turnId);
  }

  private handleFiller(data: BusEvents['llm:filler']): void {
    if (!this.context.bus.isTurnOpen(data.turnId)) return;
    this.enqueueOrDefer({
      turnId: data.turnId,
      outputId: randomUUID(),
      text: data.text,
      priority: TTS_PRIORITY.BACKGROUND,
    });
  }

  private handlePrioritySpeech(data: BusEvents['voice:priority-speech']): void {
    if (
      this.host.getVoiceMode() === 'off'
      || !this.context.bus.isTurnOpen(data.turnId)
      || !data.text
      || !this.queue
    ) return;
    const item: TtsQueueItem = {
      turnId: data.turnId,
      outputId: data.outputId,
      text: data.text,
      priority: PRIORITY_SPEECH_QUEUE_PRIORITY[data.priority],
      pauseAfterPlayback: data.pauseAfter === true && this.hasNormalSpeechWork(),
    };
    this.spokenTurns.add(item.turnId);
    this.prioritySpeechTurns.add(item.turnId);
    if (
      this.host.getVoiceState() !== 'listening'
      && this.host.isRendererAvailable()
      && (this.host.getVoiceState() === 'processing' || this.host.getVoiceState() === 'idle')
    ) {
      this.host.setState('speaking');
    }
    this.context.bus.emit('voice', 'voice:speaking', {
      turnId: item.turnId,
      outputId: item.outputId,
      text: item.text,
    });
    this.enqueueOrDefer(item);
  }

  private resumeSpeech(): void {
    if (!this.queue?.isPaused) return;
    this.queue.resume();
    for (const turnId of [...this.spokenTurns]) this.tryCompleteSpokenTurn(turnId);
    this.host.restoreOwnedVoiceState();
  }

  private handleChunk(data: BusEvents['llm:chunk']): void {
    if (!this.context.bus.isTurnOpen(data.turnId) || !data.text) return;
    const output = this.outputStore.getOrCreate(data.turnId, data.outputId);
    if (data.sequence !== output.sequence || output.complete || output.failed) return;
    output.sequence += 1;
    output.text += data.text;
    if (!output.shouldSpeak) return;
    this.enqueueSentences(output, output.buffer.push(data.text));
  }

  private handleDone(data: BusEvents['llm:done']): void {
    if (!this.context.bus.isTurnOpen(data.turnId)) return;
    const output = this.outputStore.getOrCreate(data.turnId, data.outputId);
    if (output.complete || output.failed) return;
    if (!output.shouldSpeak) {
      output.sequence = data.sequence;
      output.text = data.fullText;
      output.complete = true;
      this.cleanupFinishedOutputs();
      return;
    }
    if (data.fullText.startsWith(output.text)) {
      const recovered = data.fullText.slice(output.text.length);
      if (recovered) {
        this.enqueueSentences(output, output.buffer.push(recovered));
        output.text = data.fullText;
      }
    } else if (data.sequence !== output.sequence) {
      this.queue?.cancelTurn(data.turnId);
      output.buffer.reset();
      output.text = data.fullText;
      this.enqueueSentences(output, output.buffer.push(data.fullText));
    }
    output.sequence = data.sequence;
    output.complete = true;
    const remainder = output.buffer.flush();
    if (remainder) this.enqueueSentences(output, [remainder]);
    if (!this.queue?.isActive) this.onQueueEmpty();
  }

  private handleError(data: BusEvents['llm:error']): void {
    if (this.context.bus.isTurnTerminal(data.turnId)) return;
    const turnOutputs = [...this.outputs.values()].filter((output) => output.turnId === data.turnId);
    if (
      !this.host.isTurnOwned(data.turnId, turnOutputs.length > 0)
      || this.routerErrorTurns.has(data.turnId)
    ) return;
    this.routerErrorTurns.add(data.turnId);
    this.host.removeProcessingTurn(data.turnId);
    this.deferred = this.deferred.filter((item) => item.turnId !== data.turnId);
    for (const output of turnOutputs) {
      output.buffer.reset();
      output.complete = true;
      output.failed = true;
    }
    this.queue?.cancelTurn(data.turnId);
    if (
      this.host.shouldSpeakError(data.turnId, turnOutputs.some((output) => output.shouldSpeak))
      && this.host.isTtsAvailable()
    ) {
      const output = this.outputStore.getOrCreate(data.turnId, randomUUID(), true);
      output.complete = true;
      output.failed = true;
      this.enqueueSentences(output, [data.message || 'Die Anfrage ist fehlgeschlagen.']);
    }
    if (!this.queue?.isActive) {
      this.cleanupFinishedOutputs();
      this.host.restoreOwnedVoiceState();
    }
  }

  private enqueueSentences(output: VoiceOutputLifecycle, sentences: string[]): void {
    for (const sentence of sentences) {
      if (!sentence) continue;
      output.startedSpeaking = true;
      this.spokenTurns.add(output.turnId);
      if (this.host.getVoiceState() === 'processing' || this.host.getVoiceState() === 'idle') {
        this.host.setState('speaking');
      }
      this.context.bus.emit('voice', 'voice:speaking', {
        turnId: output.turnId,
        outputId: output.outputId,
        text: sentence,
      });
      this.enqueueOrDefer({
        turnId: output.turnId,
        outputId: output.outputId,
        text: sentence,
        priority: TTS_PRIORITY.NORMAL,
      });
    }
  }

  private enqueueOrDefer(item: TtsQueueItem): void {
    if (this.host.getVoiceState() === 'listening' || !this.host.isRendererAvailable()) {
      this.deferred.push(item);
      return;
    }
    this.queue?.enqueue(item);
  }

  private hasNormalSpeechWork(): boolean {
    if (this.deferred.some(
      (item) => (item.priority ?? TTS_PRIORITY.NORMAL) === TTS_PRIORITY.NORMAL,
    )) return true;
    return [...this.outputs.values()].some((output) => (
      output.shouldSpeak
      && ((!output.complete && !output.failed) || this.queue?.hasTurn(output.turnId) === true)
    ));
  }

  private cleanupFinishedOutputs(): void {
    this.outputStore.cleanupFinished(
      (turnId) => this.queue?.hasTurn(turnId) === true,
      (turnId) => this.deferred.some((item) => item.turnId === turnId),
    );
  }

  private onQueueEmpty(): void {
    this.cleanupFinishedOutputs();
    if (this.host.getVoiceState() === 'listening' || this.llmStreaming) return;
    for (const turnId of [...this.spokenTurns]) this.tryCompleteSpokenTurn(turnId);
    if (!this.host.resumeKeywordConversation()) this.host.restoreOwnedVoiceState();
  }

  private tryCompleteSpokenTurn(turnId: TurnId): void {
    if (!this.spokenTurns.has(turnId) || this.completedTurns.has(turnId)) return;
    if (
      !this.context.bus.isTurnTerminal(turnId)
      || this.queue?.hasTurn(turnId)
      || this.deferred.some((item) => item.turnId === turnId)
    ) return;
    this.spokenTurns.delete(turnId);
    this.prioritySpeechTurns.delete(turnId);
    this.completedTurns.add(turnId);
    if (this.completedTurns.size > 2_000) {
      const oldest = this.completedTurns.values().next().value as TurnId | undefined;
      if (oldest) this.completedTurns.delete(oldest);
    }
    this.context.bus.emit('voice', 'voice:done', { turnId });
    this.host.onSpeechTurnDone(turnId);
  }

  private clearActivePlayback(): void {
    this.activePlaybackTurn = null;
    this.activePlayback = null;
    this.audio.setPlaying(false);
  }

  private reconcileStoppedRendererAudio(): void {
    for (const turnId of [...this.spokenTurns]) this.tryCompleteSpokenTurn(turnId);
    this.cleanupFinishedOutputs();
    this.host.restoreOwnedVoiceState();
  }
}
