import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type {
  CreateReminderInput,
  ReminderAgendaItem,
  ReminderRecord,
  ReminderStateTransition,
} from './reminder-types.js';

export type {
  ReminderAgendaItem,
  ReminderRecord,
  ReminderState,
  ReminderStateTransition,
} from './reminder-types.js';

export type ReminderCreateRecord = CreateReminderInput & {
  sourceKind: 'local';
  createdAt: string;
};
export type ReminderStoreTransition = ReminderStateTransition;

/** Persistence boundary implemented by the encrypted ReminderStore in Gate B. */
export interface ReminderStorePort {
  readonly persistent: boolean;
  create(input: ReminderCreateRecord): Promise<ReminderRecord>;
  listOpen(): Promise<readonly ReminderRecord[]>;
  compareAndSetState(transition: ReminderStateTransition): Promise<boolean>;
}

export type ReminderListScope = 'today' | 'upcoming';

export type ReminderCancelSelector =
  | { kind: 'all' }
  | { kind: 'id'; id: number }
  | { kind: 'text'; text: string }
  | { kind: 'due'; dueLocal: string }
  | { kind: 'exact'; dueLocal: string; text: string };

export interface ReminderCancelResult {
  status: 'cancelled' | 'partially_cancelled' | 'none' | 'ambiguous' | 'already_firing';
  cancelled: ReminderAgendaItem[];
  candidates: ReminderAgendaItem[];
}

export interface ReminderNotification {
  reminderId: number;
  dueLocal: string;
  text: string;
  overdue: boolean;
  speak: string;
}

export interface ReminderClock {
  now(): Date;
}

export interface ReminderTimeouts {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ReminderServiceOptions {
  store: ReminderStorePort;
  notify: (notification: ReminderNotification) => boolean | Promise<boolean>;
  clock?: ReminderClock;
  timeouts?: ReminderTimeouts;
  onError?: (error: Error) => void;
  guardIntervalMs?: number;
  maxOpenReminders?: number;
}

const DEFAULT_GUARD_INTERVAL_MS = 60_000;
const DEFAULT_MAX_OPEN_REMINDERS = 100;
const DUE_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

const systemClock: ReminderClock = { now: () => new Date() };
const systemTimeouts: ReminderTimeouts = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export class ReminderServiceError extends Error {
  constructor(readonly code: 'not_initialized' | 'not_persistent' | 'invalid_input' | 'past_due' | 'limit_reached') {
    super(code);
    this.name = 'ReminderServiceError';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function localMinuteKey(value: Date): string {
  return `${localDateKey(value)}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function parseDueLocal(value: string): Date | null {
  const match = DUE_LOCAL_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
  ) return null;
  return parsed;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('de-DE');
}

function agendaItem(record: ReminderRecord): ReminderAgendaItem {
  return { kind: 'reminder', id: record.id, dueLocal: record.dueLocal, text: record.text };
}

function compareRecords(left: ReminderRecord, right: ReminderRecord): number {
  return left.dueLocal.localeCompare(right.dueLocal) || left.id - right.id;
}

function notificationText(text: string, overdue: boolean): string {
  const body = text.trim();
  const punctuation = /[.!?]$/u.test(body) ? '' : '.';
  return `${overdue ? 'Überfällige Erinnerung' : 'Erinnerung'}: ${body}${punctuation}`;
}

/**
 * Owns persistent one-shot reminder scheduling without depending on Bus, Electron or SQLite.
 *
 * - Serializes create, cancel and reconcile operations.
 * - Recovers `firing` records on startup and prefers a rare retry over silent loss.
 * - Arms only today's nearest deadline precisely and guards wall-clock changes every minute.
 *
 * @category Service Business Logic
 */
export class ReminderService implements SarahService {
  readonly id = 'reminders';
  readonly subscriptions = [] as const;
  status: ServiceStatus = 'pending';
  private readonly store: ReminderStorePort;
  private readonly notify: ReminderServiceOptions['notify'];
  private readonly clock: ReminderClock;
  private readonly timeouts: ReminderTimeouts;
  private readonly onError: (error: Error) => void;
  private readonly guardIntervalMs: number;
  private readonly maxOpenReminders: number;
  private operationTail: Promise<void> = Promise.resolve();
  private cancelScheduled: (() => void) | null = null;
  private scheduleGeneration = 0;
  private initialized = false;
  private destroyed = false;

  constructor(options: ReminderServiceOptions) {
    this.store = options.store;
    this.notify = options.notify;
    this.clock = options.clock ?? systemClock;
    this.timeouts = options.timeouts ?? systemTimeouts;
    this.onError = options.onError ?? (() => {});
    this.guardIntervalMs = options.guardIntervalMs ?? DEFAULT_GUARD_INTERVAL_MS;
    this.maxOpenReminders = options.maxOpenReminders ?? DEFAULT_MAX_OPEN_REMINDERS;
    if (!Number.isSafeInteger(this.guardIntervalMs) || this.guardIntervalMs < 1) {
      throw new RangeError('guardIntervalMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxOpenReminders) || this.maxOpenReminders < 1) {
      throw new RangeError('maxOpenReminders must be a positive integer');
    }
  }

  /** Restores incomplete delivery state, catches up overdue reminders and arms the scheduler. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.destroyed) throw new ReminderServiceError('not_initialized');
    this.initialized = true;
    try {
      await this.enqueue(async () => {
        const nowIso = this.clock.now().toISOString();
        const open = await this.store.listOpen();
        for (const record of open) {
          if (record.state === 'firing') {
            await this.store.compareAndSetState({
              id: record.id,
              expected: 'firing',
              next: 'pending',
              at: nowIso,
            });
          }
        }
        await this.reconcileOnce();
      });
      this.status = 'running';
    } catch (error) {
      this.initialized = false;
      this.status = 'error';
      throw error;
    }
  }

  /** Persists one already validated local reminder and immediately replans the scheduler. */
  create(input: { dueLocal: string; text: string }): Promise<ReminderAgendaItem> {
    this.assertOperational();
    if (!this.store.persistent) return Promise.reject(new ReminderServiceError('not_persistent'));
    const due = parseDueLocal(input.dueLocal);
    if (!due || !input.text.trim()) return Promise.reject(new ReminderServiceError('invalid_input'));
    if (due.getTime() <= this.clock.now().getTime()) return Promise.reject(new ReminderServiceError('past_due'));

    return this.enqueue(async () => {
      const open = await this.store.listOpen();
      if (open.length >= this.maxOpenReminders) throw new ReminderServiceError('limit_reached');
      const record = await this.store.create({
        dueLocal: input.dueLocal,
        text: input.text,
        sourceKind: 'local',
        createdAt: this.clock.now().toISOString(),
      });
      await this.reconcileOnce();
      return agendaItem(record);
    });
  }

  /** Lists today's or every open reminder in stable chronological order. */
  list(scope: ReminderListScope): Promise<ReminderAgendaItem[]> {
    this.assertOperational();
    return this.enqueue(async () => {
      const today = localDateKey(this.clock.now());
      return (await this.store.listOpen())
        .filter((record) => scope === 'upcoming' || record.dueLocal.startsWith(`${today}T`))
        .sort(compareRecords)
        .map(agendaItem);
    });
  }

  /** Cancels one unambiguous pending reminder or explicitly all pending reminders. */
  cancel(selector: ReminderCancelSelector): Promise<ReminderCancelResult> {
    this.assertOperational();
    return this.enqueue(async () => {
      const open = [...await this.store.listOpen()].sort(compareRecords);
      const matches = this.select(open, selector);
      if (matches.length === 0) return { status: 'none', cancelled: [], candidates: [] };
      if (selector.kind !== 'all' && matches.length > 1) {
        return { status: 'ambiguous', cancelled: [], candidates: matches.map(agendaItem) };
      }

      const cancelled: ReminderAgendaItem[] = [];
      const firing: ReminderAgendaItem[] = [];
      const at = this.clock.now().toISOString();
      for (const record of matches) {
        if (record.state === 'firing') {
          firing.push(agendaItem(record));
          continue;
        }
        const changed = await this.store.compareAndSetState({
          id: record.id,
          expected: 'pending',
          next: 'cancelled',
          at,
        });
        if (changed) cancelled.push(agendaItem(record));
        else firing.push(agendaItem(record));
      }
      await this.reconcileOnce();
      if (firing.length > 0 && cancelled.length > 0) {
        return { status: 'partially_cancelled', cancelled, candidates: firing };
      }
      if (firing.length > 0) {
        return { status: 'already_firing', cancelled: [], candidates: firing };
      }
      return { status: 'cancelled', cancelled, candidates: [] };
    });
  }

  /** Reconciles startup, resume, timeout and explicit lifecycle requests through one serial lane. */
  reconcile(): Promise<void> {
    this.assertOperational();
    return this.enqueue(() => this.reconcileOnce());
  }

  /** Stops local handles while retaining every persistent store record. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;
    this.clearSchedule();
    await this.operationTail;
    this.clearSchedule();
    this.status = 'stopped';
  }

  onMessage(_msg: TypedBusMessage): void {}

  private assertOperational(): void {
    if (!this.initialized || this.destroyed) throw new ReminderServiceError('not_initialized');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileOnce(): Promise<void> {
    this.clearSchedule();
    if (this.destroyed) return;
    const now = this.clock.now();
    const nowMs = now.getTime();
    const currentMinute = localMinuteKey(now);
    const open = [...await this.store.listOpen()].sort(compareRecords);
    for (const record of open) {
      if (record.state !== 'pending') continue;
      const due = parseDueLocal(record.dueLocal);
      if (!due || due.getTime() > nowMs) continue;
      const firing = await this.store.compareAndSetState({
        id: record.id,
        expected: 'pending',
        next: 'firing',
        at: now.toISOString(),
      });
      if (!firing) continue;
      const overdue = record.dueLocal < currentMinute;
      let accepted = false;
      try {
        accepted = await this.notify({
          reminderId: record.id,
          dueLocal: record.dueLocal,
          text: record.text,
          overdue,
          speak: notificationText(record.text, overdue),
        });
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error('Reminder notification failed'));
      }
      await this.store.compareAndSetState({
        id: record.id,
        expected: 'firing',
        next: accepted ? 'delivered' : 'pending',
        at: this.clock.now().toISOString(),
      });
    }
    if (this.destroyed) return;
    this.armNext(await this.store.listOpen());
  }

  private armNext(open: readonly ReminderRecord[]): void {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const today = localDateKey(now);
    const nextToday = open
      .filter((record) => record.state === 'pending' && record.dueLocal.startsWith(`${today}T`))
      .map((record) => parseDueLocal(record.dueLocal)?.getTime())
      .filter((value): value is number => value != null && value > nowMs)
      .sort((left, right) => left - right)[0];
    if (open.length === 0) return;
    const preciseDelay = nextToday == null ? this.guardIntervalMs : nextToday - nowMs;
    const delayMs = Math.max(1, Math.min(this.guardIntervalMs, preciseDelay));
    const generation = ++this.scheduleGeneration;
    this.cancelScheduled = this.timeouts.schedule(() => {
      if (this.destroyed || generation !== this.scheduleGeneration) return;
      this.cancelScheduled = null;
      void this.reconcile().catch((error) => {
        this.onError(error instanceof Error ? error : new Error('Reminder reconcile failed'));
      });
    }, delayMs);
  }

  private clearSchedule(): void {
    this.scheduleGeneration += 1;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private select(open: readonly ReminderRecord[], selector: ReminderCancelSelector): ReminderRecord[] {
    if (selector.kind === 'all') return [...open];
    if (selector.kind === 'id') return open.filter((record) => record.id === selector.id);
    if (selector.kind === 'due') return open.filter((record) => record.dueLocal === selector.dueLocal);
    const normalized = normalizeText(selector.text);
    if (selector.kind === 'text') {
      return open.filter((record) => normalizeText(record.text) === normalized);
    }
    return open.filter((record) => (
      record.dueLocal === selector.dueLocal && normalizeText(record.text) === normalized
    ));
  }
}
