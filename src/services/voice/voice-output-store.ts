import type { OutputId, TurnId } from '../../core/turn-contract.js';
import { SentenceBuffer } from './sentence-buffer.js';

export interface VoiceOutputLifecycle {
  turnId: TurnId;
  outputId: OutputId;
  sequence: number;
  text: string;
  complete: boolean;
  failed: boolean;
  shouldSpeak: boolean;
  startedSpeaking: boolean;
  buffer: SentenceBuffer;
}

/** Owns correlated streaming-output state without owning TTS or turn policy. */
export class VoiceOutputStore {
  readonly outputs = new Map<OutputId, VoiceOutputLifecycle>();
  private currentOutputId: OutputId | null = null;

  constructor(private readonly shouldSpeak: (turnId: TurnId, force?: boolean) => boolean) {}

  get active(): VoiceOutputLifecycle | null {
    return this.currentOutputId ? this.outputs.get(this.currentOutputId) ?? null : null;
  }

  get llmStreaming(): boolean {
    return [...this.outputs.values()].some((output) => (
      output.startedSpeaking && !output.complete && !output.failed
    ));
  }

  getOrCreate(turnId: TurnId, outputId: OutputId, forceSpeak?: boolean): VoiceOutputLifecycle {
    const existing = this.outputs.get(outputId);
    if (existing) {
      if (existing.turnId !== turnId) {
        throw new Error(`Output ${outputId} cannot change its owning turn`);
      }
      this.currentOutputId = outputId;
      return existing;
    }
    const output: VoiceOutputLifecycle = {
      turnId,
      outputId,
      sequence: 0,
      text: '',
      complete: false,
      failed: false,
      shouldSpeak: this.shouldSpeak(turnId, forceSpeak),
      startedSpeaking: false,
      buffer: new SentenceBuffer(),
    };
    this.outputs.set(outputId, output);
    this.currentOutputId = outputId;
    return output;
  }

  cleanupFinished(hasQueuedTurn: (turnId: TurnId) => boolean, isDeferred: (turnId: TurnId) => boolean): void {
    for (const [outputId, output] of this.outputs) {
      if ((!output.complete && !output.failed) || hasQueuedTurn(output.turnId) || isDeferred(output.turnId)) continue;
      this.outputs.delete(outputId);
    }
    this.reconcileCurrentOutput();
  }

  removeTurn(turnId: TurnId): void {
    for (const [outputId, output] of this.outputs) {
      if (output.turnId === turnId) this.outputs.delete(outputId);
    }
    this.reconcileCurrentOutput();
  }

  clear(): void {
    this.outputs.clear();
    this.currentOutputId = null;
  }

  private reconcileCurrentOutput(): void {
    if (!this.currentOutputId || this.outputs.has(this.currentOutputId)) return;
    this.currentOutputId = null;
    for (const outputId of this.outputs.keys()) this.currentOutputId = outputId;
  }
}
