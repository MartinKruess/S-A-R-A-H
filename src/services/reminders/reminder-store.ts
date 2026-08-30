import type { StorageProvider } from '../../core/storage/storage.interface.js';
import type {
  CreateReminderInput,
  ReminderAgendaItem,
  ReminderRecord,
  ReminderSourceKind,
  ReminderState,
  ReminderStateTransition,
} from './reminder-types.js';

export const MAX_OPEN_REMINDERS = 100;

export class ReminderPersistenceUnavailableError extends Error {
  constructor() {
    super('Persistente Erinnerungen sind gerade nicht verfügbar.');
    this.name = 'ReminderPersistenceUnavailableError';
  }
}

export class ReminderLimitError extends Error {
  constructor() {
    super(`Es können höchstens ${MAX_OPEN_REMINDERS} offene Erinnerungen gespeichert werden.`);
    this.name = 'ReminderLimitError';
  }
}

interface ReminderRow {
  id: number;
  due_local: string;
  text: string;
  state: ReminderState;
  source_kind: ReminderSourceKind;
  external_id: string | null;
  created_at: string;
  firing_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export interface ReminderStoreOptions {
  /** Must be false for bootstrap's volatile `:memory:` fallback. */
  persistent: boolean;
}

const DUE_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

function isReminderState(value: string): value is ReminderState {
  return value === 'pending' || value === 'firing' || value === 'delivered' || value === 'cancelled';
}

function assertDueLocal(value: string): void {
  const match = DUE_LOCAL_PATTERN.exec(value);
  if (!match) throw new Error('Reminder dueLocal must use YYYY-MM-DDTHH:mm');
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (local.getFullYear() !== year
    || local.getMonth() !== month - 1
    || local.getDate() !== day
    || local.getHours() !== hour
    || local.getMinutes() !== minute) {
    throw new Error('Reminder dueLocal is not a valid local date and time');
  }
}

function assertTechnicalTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Reminder ${field} is invalid`);
}

function toRecord(row: ReminderRow): ReminderRecord {
  if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('Reminder id is invalid');
  assertDueLocal(row.due_local);
  if (!row.text.trim()) throw new Error('Reminder text is empty');
  if (!isReminderState(row.state)) throw new Error('Reminder state is invalid');
  if (row.source_kind !== 'local') throw new Error('Reminder source is invalid');
  assertTechnicalTimestamp(row.created_at, 'createdAt');
  for (const [field, value] of [
    ['firingAt', row.firing_at],
    ['deliveredAt', row.delivered_at],
    ['cancelledAt', row.cancelled_at],
  ] as const) {
    if (value !== null) assertTechnicalTimestamp(value, field);
  }
  return {
    id: row.id,
    dueLocal: row.due_local,
    text: row.text,
    state: row.state,
    sourceKind: row.source_kind,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    createdAt: row.created_at,
    firingAt: row.firing_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
  };
}

/**
 * Typed persistence boundary for one-shot local reminders.
 *
 * - Keeps content and local due values behind the encrypted StorageProvider.
 * - Exposes compare-and-update state transitions used by the scheduler.
 * - Refuses creation when bootstrap reports volatile fallback storage.
 *
 * @category Data Access
 */
export class ReminderStore {
  readonly persistent: boolean;

  constructor(
    private readonly db: StorageProvider,
    private readonly options: ReminderStoreOptions,
  ) {
    this.persistent = options.persistent;
  }

  async create(input: CreateReminderInput): Promise<ReminderRecord> {
    if (!this.options.persistent) throw new ReminderPersistenceUnavailableError();
    assertDueLocal(input.dueLocal);
    const text = input.text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!text) throw new Error('Reminder text is empty');
    if (input.createdAt !== undefined) assertTechnicalTimestamp(input.createdAt, 'createdAt');
    const open = await this.listOpen();
    if (open.length >= MAX_OPEN_REMINDERS) throw new ReminderLimitError();

    const id = await this.db.insert('reminders', {
      due_local: input.dueLocal,
      text,
      state: 'pending',
      source_kind: input.sourceKind ?? 'local',
      external_id: input.externalId?.trim() || null,
      firing_at: null,
      delivered_at: null,
      cancelled_at: null,
      ...(input.createdAt ? { created_at: input.createdAt } : {}),
    });
    const [created] = await this.db.query<ReminderRow>('reminders', { id });
    if (!created) throw new Error('Persisted reminder could not be read back');
    return toRecord(created);
  }

  async listOpen(): Promise<ReminderRecord[]> {
    const [pending, firing] = await Promise.all([
      this.listByState('pending'),
      this.listByState('firing'),
    ]);
    return [...pending, ...firing].sort(compareReminders);
  }

  async listPendingThrough(latestDueLocal: string): Promise<ReminderRecord[]> {
    assertDueLocal(latestDueLocal);
    return (await this.listByState('pending'))
      .filter((reminder) => reminder.dueLocal <= latestDueLocal)
      .sort(compareReminders);
  }

  async listAgenda(state: 'pending' | 'firing' = 'pending'): Promise<ReminderAgendaItem[]> {
    return (await this.listByState(state)).map((reminder) => ({
      kind: 'reminder',
      id: reminder.id,
      dueLocal: reminder.dueLocal,
      text: reminder.text,
    }));
  }

  async claim(id: number, firingAt: string): Promise<boolean> {
    return this.compareAndSetState({ id, expected: 'pending', next: 'firing', at: firingAt });
  }

  async markDelivered(id: number, deliveredAt: string): Promise<boolean> {
    return this.compareAndSetState({ id, expected: 'firing', next: 'delivered', at: deliveredAt });
  }

  async cancel(id: number, cancelledAt: string): Promise<boolean> {
    assertTechnicalTimestamp(cancelledAt, 'cancelledAt');
    const [row] = await this.db.query<ReminderRow>('reminders', { id });
    if (!row || (row.state !== 'pending' && row.state !== 'firing')) return false;
    return this.compareAndSetState({ id, expected: row.state, next: 'cancelled', at: cancelledAt });
  }

  async compareAndSetState(transition: ReminderStateTransition): Promise<boolean> {
    assertTechnicalTimestamp(transition.at, 'transition timestamp');
    const allowed = (transition.expected === 'pending'
      && (transition.next === 'firing' || transition.next === 'cancelled'))
      || (transition.expected === 'firing'
        && (transition.next === 'pending'
          || transition.next === 'delivered'
          || transition.next === 'cancelled'));
    if (!allowed) return false;
    const timestamps = transition.next === 'firing'
      ? { firing_at: transition.at }
      : transition.next === 'delivered'
        ? { delivered_at: transition.at }
        : transition.next === 'cancelled'
          ? { cancelled_at: transition.at }
          : { firing_at: null };
    return (await this.db.update('reminders', {
      id: transition.id,
      state: transition.expected,
    }, {
      state: transition.next,
      ...timestamps,
    })) === 1;
  }

  async recoverFiring(): Promise<number> {
    const firing = await this.listByState('firing');
    let recovered = 0;
    for (const reminder of firing) {
      const changed = await this.compareAndSetState({
        id: reminder.id,
        expected: 'firing',
        next: 'pending',
        at: new Date().toISOString(),
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  private async listByState(state: ReminderState): Promise<ReminderRecord[]> {
    const rows = await this.db.query<ReminderRow>('reminders', { state });
    return rows.map(toRecord).sort(compareReminders);
  }
}

function compareReminders(left: ReminderRecord, right: ReminderRecord): number {
  return left.dueLocal.localeCompare(right.dueLocal) || left.id - right.id;
}
