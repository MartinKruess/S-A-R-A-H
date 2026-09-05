import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  AcceptedSpecialistTaskMetadataSchema,
  MAX_SPECIALIST_EVENT_IDS,
  isTerminalSpecialistTaskStatus,
  type AcceptedSpecialistTaskMetadata,
} from '../../core/specialist-task.js';
import { isAiOperationCompatible } from '../../core/ai-provider-contract.js';

const FILE_NAME = 'specialist-tasks.json';
const SCHEMA_VERSION = 1;
export const MAX_SPECIALIST_TASKS = 100;
export const DEFAULT_SPECIALIST_TERMINAL_RETENTION = 25;

const StoreSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generation: z.number().int().min(1),
  commitId: z.uuid(),
  tasks: z.array(AcceptedSpecialistTaskMetadataSchema).max(MAX_SPECIALIST_TASKS).readonly(),
}).strict().readonly();

export interface SpecialistTaskStoreSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly commitId: string;
  readonly tasks: readonly AcceptedSpecialistTaskMetadata[];
}

export type SpecialistTaskStoreStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'recovered'; readonly message: string }
  | { readonly state: 'degraded'; readonly message: string };

export type SpecialistTaskStoreFaultPoint = 'after-backup-publish';
export type SpecialistTaskPublicationState = 'published' | 'not_published' | 'indeterminate';

const RECOVERED_MESSAGE = 'Die Metadaten laufender Spezialisten wurden aus einer sicheren Kopie geladen.';
const DEGRADED_MESSAGE = 'Die Metadaten laufender Spezialisten sind beschädigt und bleiben unverändert.';

export class SpecialistTaskStoreConflictError extends Error {
  constructor() {
    super('Specialist task metadata changed concurrently');
    this.name = 'SpecialistTaskStoreConflictError';
  }
}

export class SpecialistTaskStoreDegradedError extends Error {
  constructor() {
    super(DEGRADED_MESSAGE);
    this.name = 'SpecialistTaskStoreDegradedError';
  }
}

export class SpecialistTaskStoreValidationError extends Error {
  constructor() {
    super('Specialist task metadata is invalid');
    this.name = 'SpecialistTaskStoreValidationError';
  }
}

interface LoadResult {
  readonly snapshot: SpecialistTaskStoreSnapshot;
  readonly status: SpecialistTaskStoreStatus;
}

/** Atomic metadata-only persistence for provider-accepted specialist tasks. */
export class SpecialistTaskStore {
  private cached: SpecialistTaskStoreSnapshot | null = null;
  private status: SpecialistTaskStoreStatus = { state: 'ready' };

  constructor(
    private readonly storageDir: string,
    private readonly faultInjector?: (point: SpecialistTaskStoreFaultPoint) => void,
  ) {}

  snapshot(): SpecialistTaskStoreSnapshot {
    return this.copy(this.load());
  }

  getStatus(): SpecialistTaskStoreStatus {
    this.load();
    return { ...this.status };
  }

  /** Verifies capacity, disk generation, path safety and an actual durable probe before a paid start. */
  assertCanCreate(taskId: string, expectedGeneration: number): void {
    if (!z.uuid().safeParse(taskId).success) throw new SpecialistTaskStoreValidationError();
    const current = this.assertWritable(expectedGeneration);
    if (current.tasks.length >= MAX_SPECIALIST_TASKS) {
      throw new SpecialistTaskStoreValidationError();
    }
    if (current.tasks.some((task) => task.taskId === taskId)) {
      throw new SpecialistTaskStoreConflictError();
    }
    this.ensureDirectory();
    const probe = path.join(
      this.storageDir,
      `.specialist-tasks-write-probe.${process.pid}.${randomUUID()}`,
    );
    try {
      this.writeDurably(probe, 'probe');
    } finally {
      this.removeTemp(probe);
    }
  }

  /** Reads both authoritative copies after an ambiguous publish and identifies the exact candidate. */
  publicationState(task: AcceptedSpecialistTaskMetadata): SpecialistTaskPublicationState {
    const expected = this.parseTask(task);
    const disk = this.readDisk();
    this.cached = disk.snapshot;
    this.status = disk.status;
    if (disk.status.state === 'degraded') return 'indeterminate';
    const published = disk.snapshot.tasks.find((candidate) => candidate.taskId === expected.taskId);
    if (!published) return 'not_published';
    return this.sameTask(published, expected) ? 'published' : 'indeterminate';
  }

  /** Removes expired and excess terminal metadata while retaining every non-terminal task. */
  pruneTerminal(
    cutoffTimestamp: string,
    retainLatest: number,
    expectedGeneration: number,
  ): SpecialistTaskStoreSnapshot {
    const cutoff = Date.parse(cutoffTimestamp);
    if (!Number.isFinite(cutoff)
      || !Number.isSafeInteger(retainLatest)
      || retainLatest < 0
      || retainLatest > MAX_SPECIALIST_TASKS) {
      throw new SpecialistTaskStoreValidationError();
    }
    const current = this.assertWritable(expectedGeneration);
    const retainedTerminalIds = new Set(current.tasks
      .filter((task) => isTerminalSpecialistTaskStatus(task.status))
      .filter((task) => Date.parse(task.updatedAt) >= cutoff)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, retainLatest)
      .map((task) => task.taskId));
    const tasks = current.tasks.filter((task) => (
      !isTerminalSpecialistTaskStatus(task.status) || retainedTerminalIds.has(task.taskId)
    ));
    return tasks.length === current.tasks.length
      ? this.copy(current)
      : this.persist(tasks, current);
  }

  create(
    task: AcceptedSpecialistTaskMetadata,
    expectedGeneration: number,
  ): SpecialistTaskStoreSnapshot {
    const current = this.assertWritable(expectedGeneration);
    const parsed = this.parseTask(task);
    if (current.tasks.some((candidate) => candidate.taskId === parsed.taskId)) {
      throw new SpecialistTaskStoreConflictError();
    }
    return this.persist([...current.tasks, parsed], current);
  }

  update(
    task: AcceptedSpecialistTaskMetadata,
    expectedGeneration: number,
  ): SpecialistTaskStoreSnapshot {
    const current = this.assertWritable(expectedGeneration);
    const parsed = this.parseTask(task);
    const existing = current.tasks.find((candidate) => candidate.taskId === parsed.taskId);
    if (!existing) throw new SpecialistTaskStoreConflictError();
    if (
      parsed.providerId !== existing.providerId
      || parsed.operationId !== existing.operationId
      || parsed.connectionId !== existing.connectionId
      || parsed.bindingId !== existing.bindingId
      || parsed.bindingRevision !== existing.bindingRevision
      || parsed.remoteRef !== existing.remoteRef
      || parsed.role !== existing.role
      || parsed.createdAt !== existing.createdAt
      || parsed.deadlineAt !== existing.deadlineAt
      || parsed.maxTurns !== existing.maxTurns
      || parsed.turnsUsed < existing.turnsUsed
      || parsed.turnsUsed > existing.turnsUsed + 1
      || parsed.sequence <= existing.sequence
      || !this.isNextEventSet(existing.eventIds, parsed.eventIds)
    ) throw new SpecialistTaskStoreValidationError();
    return this.persist(current.tasks.map((candidate) => (
      candidate.taskId === parsed.taskId ? parsed : candidate
    )), current);
  }

  private load(): SpecialistTaskStoreSnapshot {
    if (this.cached) return this.cached;
    const loaded = this.readDisk();
    this.cached = loaded.snapshot;
    this.status = loaded.status;
    return this.cached;
  }

  private assertWritable(expectedGeneration: number): SpecialistTaskStoreSnapshot {
    const current = this.load();
    if (this.status.state === 'degraded') throw new SpecialistTaskStoreDegradedError();
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new SpecialistTaskStoreValidationError();
    }
    if (current.generation !== expectedGeneration) throw new SpecialistTaskStoreConflictError();
    const disk = this.readDisk();
    if (disk.status.state === 'degraded') {
      this.cached = disk.snapshot;
      this.status = disk.status;
      throw new SpecialistTaskStoreDegradedError();
    }
    if (disk.snapshot.generation !== current.generation
      || disk.snapshot.commitId !== current.commitId) {
      this.cached = disk.snapshot;
      this.status = disk.status;
      throw new SpecialistTaskStoreConflictError();
    }
    return current;
  }

  private persist(
    tasks: readonly AcceptedSpecialistTaskMetadata[],
    current: SpecialistTaskStoreSnapshot,
  ): SpecialistTaskStoreSnapshot {
    const next = this.parseSnapshot({
      schemaVersion: SCHEMA_VERSION,
      generation: current.generation + 1,
      commitId: randomUUID(),
      tasks,
    });
    this.ensureDirectory();
    const primary = path.join(this.storageDir, FILE_NAME);
    const backup = `${primary}.bak`;
    const token = `${process.pid}.${randomUUID()}`;
    const primaryTemp = `${primary}.${token}.tmp`;
    const backupTemp = `${backup}.${token}.tmp`;
    const serialized = JSON.stringify(next);
    try {
      this.writeDurably(primaryTemp, serialized);
      this.writeDurably(backupTemp, serialized);
      fs.renameSync(backupTemp, backup);
      this.faultInjector?.('after-backup-publish');
      fs.renameSync(primaryTemp, primary);
      this.cached = next;
      this.status = { state: 'ready' };
      return this.copy(next);
    } catch (error) {
      this.cached = null;
      throw error;
    } finally {
      this.removeTemp(primaryTemp);
      this.removeTemp(backupTemp);
    }
  }

  private readDisk(): LoadResult {
    const primary = path.join(this.storageDir, FILE_NAME);
    const backup = `${primary}.bak`;
    let primaryExists: boolean;
    let backupExists: boolean;
    try {
      this.assertStorageDirectorySafe(false);
      primaryExists = this.regularFileExists(primary);
      backupExists = this.regularFileExists(backup);
    } catch {
      return { snapshot: this.emptySnapshot(), status: { state: 'degraded', message: DEGRADED_MESSAGE } };
    }
    if (!primaryExists && !backupExists) {
      return {
        snapshot: this.emptySnapshot(),
        status: { state: 'ready' },
      };
    }
    const candidates = [primaryExists ? this.readCandidate(primary) : null,
      backupExists ? this.readCandidate(backup) : null]
      .filter((candidate): candidate is SpecialistTaskStoreSnapshot => candidate !== null)
      .sort((left, right) => right.generation - left.generation);
    const selected = candidates[0];
    if (!selected) {
      return { snapshot: this.emptySnapshot(), status: { state: 'degraded', message: DEGRADED_MESSAGE } };
    }
    const bothCurrent = candidates.length === 2
      && candidates[0]?.generation === candidates[1]?.generation
      && candidates[0]?.commitId === candidates[1]?.commitId;
    return {
      snapshot: selected,
      status: bothCurrent
        ? { state: 'ready' }
        : { state: 'recovered', message: RECOVERED_MESSAGE },
    };
  }

  private readCandidate(filePath: string): SpecialistTaskStoreSnapshot | null {
    try {
      return this.parseSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')) as object);
    } catch {
      return null;
    }
  }

  private regularFileExists(filePath: string): boolean {
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile()) throw new SpecialistTaskStoreValidationError();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private emptySnapshot(): SpecialistTaskStoreSnapshot {
    return Object.freeze({
      schemaVersion: 1,
      generation: 0,
      commitId: '00000000-0000-4000-8000-000000000000',
      tasks: Object.freeze([]),
    });
  }

  private parseSnapshot(value: object): SpecialistTaskStoreSnapshot {
    const parsed = StoreSnapshotSchema.safeParse(value);
    if (!parsed.success) throw new SpecialistTaskStoreValidationError();
    const ids = new Set(parsed.data.tasks.map((task) => task.taskId));
    if (ids.size !== parsed.data.tasks.length) throw new SpecialistTaskStoreValidationError();
    for (const task of parsed.data.tasks) this.validateCompatibility(task);
    return Object.freeze({
      ...parsed.data,
      tasks: Object.freeze(parsed.data.tasks.map((task) => Object.freeze({ ...task }))),
    });
  }

  private parseTask(task: AcceptedSpecialistTaskMetadata): AcceptedSpecialistTaskMetadata {
    const parsed = AcceptedSpecialistTaskMetadataSchema.safeParse(task);
    if (!parsed.success) throw new SpecialistTaskStoreValidationError();
    this.validateCompatibility(parsed.data);
    return Object.freeze({ ...parsed.data });
  }

  private validateCompatibility(task: AcceptedSpecialistTaskMetadata): void {
    if (!isAiOperationCompatible(task.providerId, task.role, task.operationId)) {
      throw new SpecialistTaskStoreValidationError();
    }
  }

  private sameTask(
    left: AcceptedSpecialistTaskMetadata,
    right: AcceptedSpecialistTaskMetadata,
  ): boolean {
    return left.taskId === right.taskId
      && left.role === right.role
      && left.providerId === right.providerId
      && left.operationId === right.operationId
      && left.connectionId === right.connectionId
      && left.bindingId === right.bindingId
      && left.bindingRevision === right.bindingRevision
      && left.remoteRef === right.remoteRef
      && left.status === right.status
      && left.sequence === right.sequence
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.deadlineAt === right.deadlineAt
      && left.eventIds.length === right.eventIds.length
      && left.eventIds.every((eventId, index) => eventId === right.eventIds[index])
      && left.maxTurns === right.maxTurns
      && left.turnsUsed === right.turnsUsed
      && left.terminalCode === right.terminalCode;
  }

  private isNextEventSet(previous: readonly string[], next: readonly string[]): boolean {
    return next.length === previous.length + 1
      && next.length <= MAX_SPECIALIST_EVENT_IDS
      && previous.every((eventId, index) => next[index] === eventId);
  }

  private copy(snapshot: SpecialistTaskStoreSnapshot): SpecialistTaskStoreSnapshot {
    return Object.freeze({
      ...snapshot,
      tasks: Object.freeze(snapshot.tasks.map((task) => Object.freeze({
        ...task,
        eventIds: Object.freeze([...task.eventIds]),
      }))),
    });
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.assertStorageDirectorySafe(true);
  }

  private assertStorageDirectorySafe(required: boolean): void {
    try {
      const stats = fs.lstatSync(this.storageDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new SpecialistTaskStoreValidationError();
      }
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private writeDurably(filePath: string, content: string): void {
    const descriptor = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private removeTemp(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // The committed primary/backup remains authoritative.
    }
  }
}
