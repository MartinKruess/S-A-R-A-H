import type { WorkerTextGenerator } from './model-runtime.js';
import type { Layer2MemoryStore, MemoryStagingRow } from '../../core/storage/layer2-memory-store.js';
import {
  MemoryAuthorStaleWriteError,
  type ApplyMemoryAuthorDeltaInput,
  type ApplyMemoryAuthorDeltaResult,
} from '../../core/storage/storage.interface.js';
import type { TurnPersistencePolicy } from '../../core/memory-policy.js';
import {
  buildDecisionMessages,
  buildExtractionMessages,
  MemoryDecisionSchema,
  MemoryExtractionSchema,
  selectRelatedMemories,
  validateOfferedDecision,
  type MemoryCandidate,
  type MemoryDecision,
  type OfferedMemory,
} from './memory-author-contract.js';

export interface MemoryCuratorOptions {
  idleDelayMs?: number;
  maxSourceChars?: number;
  numCtx?: number;
  onMemoryChanged?: () => void | Promise<void>;
  getCurrentPolicy?: () => TurnPersistencePolicy;
  onMaintenanceFailure?: () => void | Promise<void>;
}

const DEFAULT_IDLE_DELAY_MS = 30_000;
const DEFAULT_MAX_SOURCE_CHARS = 8_000;
const DEFAULT_NUM_CTX = 4_096;
const TEMPORARY_EVIDENCE_PATTERN = /\b(?:heute|gerade|momentan|diesmal|vorübergehend)\b/iu;
const REVISION_EVIDENCE_PATTERN = /\b(?:nicht mehr|mittlerweile|inzwischen|ab jetzt|künftig|nunmehr|jetzt (?:doch|wieder))\b/iu;

export type MemoryCuratorRunResult =
  | { status: 'applied'; result: ApplyMemoryAuthorDeltaResult }
  | { status: 'blocked' | 'canceled' | 'failed' };

/**
 * Runs one small memory-maintenance job through the existing 8B worker.
 *
 * - Never owns or starts a second model runtime.
 * - Cancels active maintenance when a user turn arrives.
 * - Persists only complete, schema-valid results through an atomic storage op.
 *
 * @category Service
 */
export class MemoryCurator {
  private readonly idleDelayMs: number;
  private readonly maxSourceChars: number;
  private readonly numCtx: number;
  private readonly onMemoryChanged?: () => void | Promise<void>;
  private readonly getCurrentPolicy: () => TurnPersistencePolicy;
  private readonly onMaintenanceFailure?: () => void | Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeController: AbortController | null = null;
  private running: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    private readonly store: Layer2MemoryStore,
    private readonly worker: WorkerTextGenerator,
    options: MemoryCuratorOptions = {},
  ) {
    this.idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.maxSourceChars = options.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;
    this.numCtx = options.numCtx ?? DEFAULT_NUM_CTX;
    this.onMemoryChanged = options.onMemoryChanged;
    this.onMaintenanceFailure = options.onMaintenanceFailure;
    this.getCurrentPolicy = options.getCurrentPolicy
      ?? (() => ({ allowed: true, exclusions: [] }));
  }

  schedule(): void {
    if (this.destroyed) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOne();
    }, this.idleDelayMs);
    this.timer.unref?.();
  }

  cancelForUserInput(): void {
    this.cancelTimer();
    this.activeController?.abort(new DOMException('User input has priority', 'AbortError'));
  }

  async cancelAndWait(): Promise<void> {
    this.cancelForUserInput();
    await this.running?.catch(() => undefined);
  }

  async runOne(): Promise<void> {
    if (this.destroyed || this.running) return this.running ?? Promise.resolve();
    this.running = this.processNext().then(() => undefined)
      .then(async () => {
        if (!this.destroyed && await this.store.hasPending()) this.schedule();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Runs one exact staged request synchronously after canceling lower-priority maintenance. */
  async runStaging(stagingId: number, signal?: AbortSignal): Promise<MemoryCuratorRunResult> {
    if (this.destroyed) return { status: 'failed' };
    this.cancelTimer();
    this.activeController?.abort(new DOMException('Explicit memory has priority', 'AbortError'));
    await this.running?.catch(() => undefined);
    if (this.destroyed) return { status: 'failed' };
    let result: MemoryCuratorRunResult = { status: 'failed' };
    const run = this.processNext(stagingId, signal).then((value) => {
      result = value;
    });
    this.running = run.finally(() => {
      this.running = null;
    });
    await this.running;
    if (!this.destroyed && await this.store.hasPending()) this.schedule();
    return result;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.cancelAndWait();
  }

  private async processNext(
    stagingId?: number,
    externalSignal?: AbortSignal,
  ): Promise<MemoryCuratorRunResult> {
    const job = stagingId == null
      ? await this.store.claimNext()
      : await this.store.claim(stagingId);
    if (!job) return { status: 'failed' };
    if (this.destroyed) {
      await this.store.releaseCancellation(job);
      return { status: 'canceled' };
    }
    const controller = new AbortController();
    const cancelFromExternal = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) cancelFromExternal();
    else externalSignal?.addEventListener('abort', cancelFromExternal, { once: true });
    this.activeController = controller;
    let memoryChanged = false;
    let outcome: MemoryCuratorRunResult = { status: 'failed' };
    try {
      const extractionPlan = buildExtractionMessages(
        job.source_content.slice(0, this.maxSourceChars),
        this.numCtx,
      );
      const extractionOutput = await this.worker.generateWorkerMessages(extractionPlan.messages, {
        signal: controller.signal,
        temperature: 0,
        num_predict: extractionPlan.numPredict,
        keep_alive: -1,
      });
      if (controller.signal.aborted) throw new DOMException('Memory curation aborted', 'AbortError');
      const parsedExtraction: object = JSON.parse(extractionOutput);
      const extraction = MemoryExtractionSchema.parse(parsedExtraction);
      if (extraction.decision === 'ignore'
        || extraction.durability !== 'stable'
        || (extraction.kind === 'preference'
          && TEMPORARY_EVIDENCE_PATTERN.test(extraction.evidence))) {
        const ignored = await this.store.applyAuthorDelta({
          stagingId: job.id,
          action: 'ignore',
          targets: [],
        }, this.getCurrentPolicy());
        return ignored
          ? { status: 'applied', result: ignored }
          : { status: 'blocked' };
      }
      const snapshots = await this.store.listAuthorSnapshots();
      const related = selectRelatedMemories(extraction, snapshots);
      const decisionPlan = buildDecisionMessages(extraction, related, this.numCtx);
      const decisionOutput = await this.worker.generateWorkerMessages(decisionPlan.messages, {
        signal: controller.signal,
        temperature: 0,
        num_predict: decisionPlan.numPredict,
        keep_alive: -1,
      });
      if (controller.signal.aborted) throw new DOMException('Memory curation aborted', 'AbortError');
      const parsedDecision: object = JSON.parse(decisionOutput);
      const decision = MemoryDecisionSchema.parse(parsedDecision);
      if (!validateOfferedDecision(decision, decisionPlan.offered)) {
        throw new Error('Memory Author decision referenced a snapshot that was not offered');
      }
      if (decision.action === 'supersede'
        && !REVISION_EVIDENCE_PATTERN.test(job.source_content)) {
        throw new Error('Memory Author supersede lacks a clear user revision cue');
      }
      const delta = this.toAuthorDelta(job, extraction, decision, decisionPlan.offered);
      const applied = await this.store.applyAuthorDelta(delta, this.getCurrentPolicy());
      if (!applied) return { status: 'blocked' };
      memoryChanged = decision.action !== 'ignore';
      outcome = { status: 'applied', result: applied };
    } catch (error) {
      const canceled = error instanceof Error && error.name === 'AbortError';
      const stale = error instanceof MemoryAuthorStaleWriteError;
      if (canceled || stale) await this.store.releaseCancellation(job);
      else if (this.store.shouldRetry(job)) await this.store.release(job.id);
      else {
        await this.store.fail(job.id);
        await this.onMaintenanceFailure?.();
      }
      if (!canceled && !stale) {
        console.warn(this.store.shouldRetry(job)
          ? '[MemoryCurator] Maintenance job failed; queued for bounded retry'
          : '[MemoryCurator] Maintenance job failed for this run; encrypted staging was retained for startup recovery');
      }
      outcome = { status: canceled ? 'canceled' : 'failed' };
    } finally {
      externalSignal?.removeEventListener('abort', cancelFromExternal);
      if (this.activeController === controller) this.activeController = null;
    }
    if (memoryChanged) {
      try {
        await this.onMemoryChanged?.();
      } catch {
        // The durable transaction already completed. Cache refresh failure must
        // never requeue a consumed staging item or duplicate its memory.
        console.warn('[MemoryCurator] Memory cache refresh failed after durable completion');
      }
    }
    return outcome;
  }

  private toAuthorDelta(
    job: MemoryStagingRow,
    candidate: MemoryCandidate,
    decision: MemoryDecision,
    offered: readonly OfferedMemory[],
  ): ApplyMemoryAuthorDeltaInput {
    if (decision.action === 'ignore') {
      return { stagingId: job.id, action: 'ignore', targets: [] };
    }
    const selected = decision.targets.map((target) => {
      const match = offered.find(({ memory }) => memory.id === target.id)!;
      return match;
    });
    const content = decision.action === 'merge'
      ? [...new Set([...selected.map(({ memory }) => memory.content), candidate.content])]
        .join(' ')
        .slice(0, 2_000)
      : candidate.content;
    return {
      stagingId: job.id,
      action: decision.action,
      ...(decision.topic
        ? { topic: decision.topic }
        : { newTopic: { title: candidate.topic } }),
      targets: decision.targets,
      statement: {
        kind: candidate.kind,
        content,
        evidence: candidate.evidence,
        confidence: candidate.confidence,
      },
    };
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
