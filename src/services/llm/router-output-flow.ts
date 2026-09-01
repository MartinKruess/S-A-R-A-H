import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import type { TurnCoordinator } from '../../core/turn-coordinator.js';
import type { TurnId, TurnTerminalStatus } from '../../core/turn-contract.js';
import { redactSensitiveLiterals } from './sensitive-turn-guard.js';
import type { RouterTurnDraft } from './router-turn-persistence.js';

const MAX_TERMINAL_TURNS = 2_000;

/** Serializes assistant output and owns terminal/error de-duplication for router turns. */
export class RouterOutputFlow {
  private outputQueue: Promise<void> = Promise.resolve();
  private readonly terminalTurns = new Set<TurnId>();
  private readonly terminalTurnOrder: TurnId[] = [];
  private readonly errorTurns = new Set<TurnId>();

  constructor(
    private readonly context: AppContext,
    private readonly serviceId: string,
    private readonly coordinator: TurnCoordinator,
    private readonly drafts: Map<TurnId, RouterTurnDraft>,
    private readonly isOperational: () => boolean,
  ) {}

  get pendingOutput(): Promise<void> {
    return this.outputQueue;
  }

  reset(): void {
    this.terminalTurns.clear();
    this.terminalTurnOrder.length = 0;
    this.errorTurns.clear();
  }

  hasTerminalTurn(turnId: TurnId): boolean {
    return this.terminalTurns.has(turnId);
  }

  isTurnOperational(turnId: TurnId, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    if (this.context.bus.isTurnTerminal(turnId)) return false;
    if (turnId === this.coordinator.activeTurnId) return this.coordinator.isCurrent(turnId);
    return this.isOperational() && !this.terminalTurns.has(turnId);
  }

  enqueue(job: () => Promise<void>): Promise<void> {
    const currentJob = this.outputQueue.then(job);
    this.outputQueue = currentJob.catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.warn('[Router] Output job failed:', error);
    });
    return currentJob;
  }

  emitAssistantResponse(
    turnId: TurnId,
    text: string,
    signal?: AbortSignal,
    recordInHistory = true,
    externalData = false,
    localData = false,
    outputId = randomUUID(),
  ): Promise<void> {
    return this.enqueue(() => this.publishAssistantResponse(
      turnId,
      text,
      signal,
      recordInHistory,
      externalData,
      localData,
      outputId,
    ));
  }

  async publishAssistantResponse(
    turnId: TurnId,
    text: string,
    signal: AbortSignal | undefined,
    recordInHistory: boolean,
    externalData: boolean,
    localData: boolean,
    outputId: string,
  ): Promise<void> {
    if (!this.isTurnOperational(turnId, signal)) return;
    const sensitiveGuard = this.drafts.get(turnId)?.sensitiveGuard;
    const protectedText = sensitiveGuard ? redactSensitiveLiterals(text, sensitiveGuard) : text;
    this.context.bus.emit(this.serviceId, 'llm:chunk', {
      turnId,
      outputId,
      sequence: 0,
      text: protectedText,
    });
    this.context.bus.emit(this.serviceId, 'llm:done', {
      turnId,
      outputId,
      sequence: 1,
      fullText: protectedText,
    });
    this.recordAssistantOutput(turnId, protectedText, externalData, localData);
    if (!this.drafts.has(turnId) && recordInHistory) {
      console.warn('[Router] Refused to record assistant output without an active turn draft');
    }
  }

  recordAssistantOutput(
    turnId: TurnId,
    text: string,
    externalData = false,
    localData = false,
  ): void {
    const draft = this.drafts.get(turnId);
    if (!draft) return;
    draft.assistants.push(text);
    if (externalData) draft.externalData = true;
    if (localData) draft.localData = true;
  }

  emitError(turnId: TurnId, message: string): void {
    if (this.terminalTurns.has(turnId) || this.errorTurns.has(turnId)) return;
    this.errorTurns.add(turnId);
    this.context.bus.emit(this.serviceId, 'llm:error', { turnId, message });
  }

  emitTerminal(turnId: TurnId, status: TurnTerminalStatus, message?: string): void {
    if (this.context.bus.isTurnTerminal(turnId)) {
      this.rememberTerminal(turnId);
      return;
    }
    if (!this.rememberTerminal(turnId)) return;
    this.context.bus.emit(this.serviceId, 'turn:terminal', {
      turnId,
      status,
      ...(message ? { message } : {}),
    });
  }

  rememberTerminal(turnId: TurnId): boolean {
    if (this.terminalTurns.has(turnId)) return false;
    this.terminalTurns.add(turnId);
    this.terminalTurnOrder.push(turnId);
    while (this.terminalTurnOrder.length > MAX_TERMINAL_TURNS) {
      const expired = this.terminalTurnOrder.shift();
      if (expired) {
        this.terminalTurns.delete(expired);
        this.errorTurns.delete(expired);
      }
    }
    return true;
  }
}
