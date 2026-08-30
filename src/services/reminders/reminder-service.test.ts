import { describe, expect, it, vi } from 'vitest';
import {
  ReminderService,
  ReminderServiceError,
  type ReminderClock,
  type ReminderCreateRecord,
  type ReminderNotification,
  type ReminderRecord,
  type ReminderState,
  type ReminderStorePort,
  type ReminderStoreTransition,
  type ReminderTimeouts,
} from './reminder-service.js';

class MemoryReminderStore implements ReminderStorePort {
  readonly records: ReminderRecord[];
  private nextId: number;

  constructor(readonly persistent = true, initial: ReminderRecord[] = []) {
    this.records = initial.map((record) => ({ ...record }));
    this.nextId = Math.max(0, ...initial.map((record) => record.id)) + 1;
  }

  async create(input: ReminderCreateRecord): Promise<ReminderRecord> {
    const { externalId, ...recordInput } = input;
    const record: ReminderRecord = {
      id: this.nextId++,
      state: 'pending',
      firingAt: null,
      deliveredAt: null,
      cancelledAt: null,
      ...recordInput,
      ...(externalId ? { externalId } : {}),
    };
    this.records.push(record);
    return { ...record };
  }

  async listOpen(): Promise<readonly ReminderRecord[]> {
    return this.records
      .filter((record) => record.state === 'pending' || record.state === 'firing')
      .map((record) => ({ ...record }));
  }

  async compareAndSetState(transition: ReminderStoreTransition): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === transition.id);
    if (!record || record.state !== transition.expected) return false;
    record.state = transition.next;
    return true;
  }
}

class FakeClock implements ReminderClock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  set(value: Date): void { this.value = new Date(value); }
}

class FakeTimeouts implements ReminderTimeouts {
  callback: (() => void) | null = null;
  delayMs: number | null = null;
  cancelCount = 0;

  schedule(callback: () => void, delayMs: number): () => void {
    this.callback = callback;
    this.delayMs = delayMs;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.cancelCount += 1;
      if (this.callback === callback) this.callback = null;
    };
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function localDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function record(id: number, dueLocal: string, text: string, state: ReminderState = 'pending'): ReminderRecord {
  return {
    id,
    dueLocal,
    text,
    state,
    sourceKind: 'local',
    createdAt: '2026-08-30T08:00:00.000Z',
    firingAt: null,
    deliveredAt: null,
    cancelledAt: null,
  };
}

async function flushOperations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReminderService', () => {
  it('recovers firing reminders at startup and delivers overdue entries chronologically', async () => {
    const store = new MemoryReminderStore(true, [
      record(2, '2026-08-30T09:30', 'Zweite Erinnerung', 'firing'),
      record(1, '2026-08-30T09:00', 'Erste Erinnerung'),
    ]);
    const clock = new FakeClock(localDate(2026, 8, 30, 10, 0));
    const notifications: ReminderNotification[] = [];
    const service = new ReminderService({
      store,
      clock,
      notify: (notification) => { notifications.push(notification); return true; },
    });

    await service.init();

    expect(notifications.map((item) => item.reminderId)).toEqual([1, 2]);
    expect(notifications.every((item) => item.overdue)).toBe(true);
    expect(notifications[0].speak).toBe('Überfällige Erinnerung: Erste Erinnerung.');
    expect(store.records.map((item) => item.state)).toEqual(['delivered', 'delivered']);
    await service.destroy();
  });

  it('arms the nearest reminder today precisely but never beyond the 60-second guard', async () => {
    const store = new MemoryReminderStore(true, [record(1, '2026-08-30T10:01', 'Kurz')]);
    const clock = new FakeClock(localDate(2026, 8, 30, 10, 0));
    clock.set(new Date(clock.now().getTime() + 30_000));
    const timeouts = new FakeTimeouts();
    const notify = vi.fn((_notification: ReminderNotification) => true);
    const service = new ReminderService({ store, clock, timeouts, notify });
    await service.init();

    expect(timeouts.delayMs).toBe(30_000);
    clock.set(localDate(2026, 8, 30, 10, 1));
    timeouts.fire();
    await flushOperations();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.records[0].state).toBe('delivered');
    await service.destroy();
  });

  it('uses the guard for a future day and catches the reminder after midnight', async () => {
    const store = new MemoryReminderStore(true, [record(1, '2026-08-31T00:00', 'Mitternacht')]);
    const clock = new FakeClock(localDate(2026, 8, 30, 23, 59));
    clock.set(new Date(clock.now().getTime() + 30_000));
    const timeouts = new FakeTimeouts();
    const notify = vi.fn((_notification: ReminderNotification) => true);
    const service = new ReminderService({ store, clock, timeouts, notify });
    await service.init();

    expect(timeouts.delayMs).toBe(60_000);
    clock.set(localDate(2026, 8, 31, 0, 0));
    timeouts.fire();
    await flushOperations();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].overdue).toBe(false);
    await service.destroy();
  });

  it('reconciles a standby clock jump immediately when the armed guard fires', async () => {
    const store = new MemoryReminderStore(true, [record(1, '2026-08-30T10:05', 'Nach Standby')]);
    const clock = new FakeClock(localDate(2026, 8, 30, 10, 0));
    const timeouts = new FakeTimeouts();
    const notify = vi.fn((_notification: ReminderNotification) => true);
    const service = new ReminderService({ store, clock, timeouts, notify });
    await service.init();

    clock.set(localDate(2026, 8, 30, 10, 6));
    timeouts.fire();
    await flushOperations();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].overdue).toBe(true);
    await service.destroy();
  });

  it('serializes concurrent reconciles and dispatches one due reminder once', async () => {
    const store = new MemoryReminderStore(true, [record(1, '2026-08-30T10:00', 'Nur einmal')]);
    const clock = new FakeClock(localDate(2026, 8, 30, 9, 59));
    let release = (): void => {};
    const accepted = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const notify = vi.fn(() => accepted);
    const service = new ReminderService({ store, clock, notify });
    await service.init();
    clock.set(localDate(2026, 8, 30, 10, 0));

    const first = service.reconcile();
    const second = service.reconcile();
    await flushOperations();
    expect(notify).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.records[0].state).toBe('delivered');
    await service.destroy();
  });

  it('fails closed for ambiguous cancel and succeeds after one candidate is gone', async () => {
    const store = new MemoryReminderStore(true, [
      record(1, '2026-08-30T11:00', 'Steuerberater anrufen'),
      record(2, '2026-08-30T12:00', 'Steuerberater anrufen'),
    ]);
    const service = new ReminderService({
      store,
      clock: new FakeClock(localDate(2026, 8, 30, 10, 0)),
      notify: () => true,
    });
    await service.init();

    const ambiguous = await service.cancel({ kind: 'text', text: 'steuerberater  anrufen' });
    expect(ambiguous.status).toBe('ambiguous');
    expect(store.records.map((item) => item.state)).toEqual(['pending', 'pending']);
    expect((await service.cancel({ kind: 'id', id: 1 })).status).toBe('cancelled');
    expect((await service.cancel({ kind: 'text', text: 'Steuerberater anrufen' })).status).toBe('cancelled');
    expect(store.records.map((item) => item.state)).toEqual(['cancelled', 'cancelled']);
    await service.destroy();
  });

  it('cancels all pending records while reporting a concurrently firing record', async () => {
    const store = new MemoryReminderStore(true, [
      record(1, '2026-08-30T11:00', 'Eins'),
      record(2, '2026-08-30T12:00', 'Zwei', 'firing'),
    ]);
    const service = new ReminderService({
      store,
      clock: new FakeClock(localDate(2026, 8, 30, 10, 0)),
      notify: () => true,
    });
    await service.init();
    store.records[1].state = 'firing';

    const result = await service.cancel({ kind: 'all' });

    expect(result.status).toBe('partially_cancelled');
    expect(result.cancelled.map((item) => item.id)).toEqual([1]);
    expect(result.candidates.map((item) => item.id)).toEqual([2]);
    await service.destroy();
  });

  it('creates only in persistent storage, lists chronologically, and filters today', async () => {
    const clock = new FakeClock(localDate(2026, 8, 30, 10, 0));
    const volatile = new ReminderService({
      store: new MemoryReminderStore(false),
      clock,
      notify: () => true,
    });
    await volatile.init();
    await expect(volatile.create({ dueLocal: '2026-08-30T11:00', text: 'Nicht dauerhaft' }))
      .rejects.toMatchObject({ code: 'not_persistent' } satisfies Partial<ReminderServiceError>);
    await volatile.destroy();

    const store = new MemoryReminderStore();
    const service = new ReminderService({ store, clock, notify: () => true });
    await service.init();
    await service.create({ dueLocal: '2026-08-31T09:00', text: 'Morgen' });
    await service.create({ dueLocal: '2026-08-30T12:00', text: 'Heute' });

    expect((await service.list('today')).map((item) => item.text)).toEqual(['Heute']);
    expect((await service.list('upcoming')).map((item) => item.text)).toEqual(['Heute', 'Morgen']);
    await service.destroy();
  });

  it('requeues a refused notification and removes local scheduling on destroy without deleting it', async () => {
    const store = new MemoryReminderStore(true, [record(1, '2026-08-30T10:00', 'Später erneut')]);
    const clock = new FakeClock(localDate(2026, 8, 30, 10, 0));
    const timeouts = new FakeTimeouts();
    const service = new ReminderService({ store, clock, timeouts, notify: () => false });

    await service.init();
    expect(store.records[0].state).toBe('pending');
    expect(timeouts.delayMs).toBe(60_000);
    await service.destroy();

    expect(timeouts.callback).toBeNull();
    expect(store.records[0].state).toBe('pending');
    expect(timeouts.cancelCount).toBeGreaterThan(0);
  });
});
