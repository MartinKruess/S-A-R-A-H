import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptedStorage } from '../../../src/core/storage/encrypted-storage.js';
import { SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import type { Filter } from '../../../src/core/storage/storage.interface.js';
import {
  MAX_OPEN_REMINDERS,
  ReminderLimitError,
  ReminderPersistenceUnavailableError,
  ReminderStore,
} from '../../../src/services/reminders/reminder-store.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('ReminderStore', () => {
  let tmpDir: string;
  let raw: SqliteStorage;
  let encrypted: EncryptedStorage;
  let store: ReminderStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-reminders-'));
    raw = new SqliteStorage(path.join(tmpDir, 'sarah.db'));
    encrypted = new EncryptedStorage(raw, Buffer.alloc(32, 71));
    store = new ReminderStore(encrypted, { persistent: true });
  });

  afterEach(async () => {
    await encrypted.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and reads a canonical pending reminder', async () => {
    const reminder = await store.create({
      dueLocal: '2026-08-31T10:15',
      text: '  Steuerberater   anrufen  ',
      originMode: 'voice',
      privateContext: false,
    });

    expect(reminder).toEqual(expect.objectContaining({
      id: 1,
      dueLocal: '2026-08-31T10:15',
      text: 'Steuerberater anrufen',
      state: 'pending',
      sourceKind: 'local',
      originMode: 'voice',
      privateContext: false,
    }));
    expect(await store.listOpen()).toEqual([reminder]);
  });

  it('returns the committed reminder when its immediate readback fails', async () => {
    const query = raw.query.bind(raw);
    vi.spyOn(raw, 'query').mockImplementation(async <T = Record<string, unknown>>(
      table: string,
      filter?: Filter,
    ): Promise<T[]> => {
      if (table === 'reminders' && typeof filter?.id === 'number') {
        throw new Error('readback failed');
      }
      return query<T>(table, filter);
    });

    await expect(store.create({
      dueLocal: '2026-08-31T10:15',
      text: 'Nicht doppelt anlegen',
    })).resolves.toEqual(expect.objectContaining({
      id: 1,
      text: 'Nicht doppelt anlegen',
      state: 'pending',
    }));
    expect(await raw.query('reminders')).toHaveLength(1);
  });

  it('keeps reminder text, local due value and external id encrypted at rest', async () => {
    const created = await store.create({
      dueLocal: '2026-09-01T08:45',
      text: 'Manuel wegen Wochenabschluss anrufen',
      externalId: 'local-reference-17',
    });
    const [row] = await raw.query<{
      due_local: string;
      text: string;
      external_id: string;
      state: string;
      source_kind: string;
      origin_mode: string;
      private_context: number;
    }>('reminders', { id: created.id });

    expect(row.due_local).toMatch(/^sarah-enc:v2:/u);
    expect(row.text).toMatch(/^sarah-enc:v2:/u);
    expect(row.external_id).toMatch(/^sarah-enc:v2:/u);
    expect(row.due_local).not.toContain('2026-09-01');
    expect(row.text).not.toContain('Manuel');
    expect(row.state).toBe('pending');
    expect(row.source_kind).toBe('local');
    expect(row.origin_mode).toBe('chat');
    expect(row.private_context).toBe(1);
  });

  it('refuses creation when bootstrap reports volatile storage', async () => {
    const volatileStore = new ReminderStore(encrypted, { persistent: false });
    await expect(volatileStore.create({
      dueLocal: '2026-08-31T10:15',
      text: 'Darf nicht verloren gehen',
    })).rejects.toBeInstanceOf(ReminderPersistenceUnavailableError);
    expect(await raw.query('reminders')).toEqual([]);
  });

  it('filters and orders pending reminders through a local cutoff', async () => {
    const late = await store.create({ dueLocal: '2026-09-01T18:00', text: 'Später' });
    const early = await store.create({ dueLocal: '2026-09-01T08:00', text: 'Früher' });
    await store.create({ dueLocal: '2026-09-02T08:00', text: 'Morgen' });
    const cancelled = await store.create({ dueLocal: '2026-09-01T09:00', text: 'Abgebrochen' });
    await store.cancel(cancelled.id, '2026-08-30T12:00:00.000Z');

    expect((await store.listPendingThrough('2026-09-01T23:59')).map(({ id }) => id)).toEqual([
      early.id,
      late.id,
    ]);
  });

  it('moves one reminder atomically through pending, firing and delivered', async () => {
    const reminder = await store.create({ dueLocal: '2026-08-31T10:15', text: 'Losfahren' });
    expect(await store.claim(reminder.id, '2026-08-31T10:15:00.000Z')).toBe(true);
    expect(await store.claim(reminder.id, '2026-08-31T10:15:01.000Z')).toBe(false);
    expect((await store.listOpen())[0]).toEqual(expect.objectContaining({
      state: 'firing',
      firingAt: '2026-08-31T10:15:00.000Z',
    }));

    expect(await store.markDelivered(reminder.id, '2026-08-31T10:15:02.000Z')).toBe(true);
    expect(await store.markDelivered(reminder.id, '2026-08-31T10:15:03.000Z')).toBe(false);
    expect(await store.listOpen()).toEqual([]);
    const [delivered] = await encrypted.query<{ state: string; delivered_at: string }>('reminders', {
      id: reminder.id,
    });
    expect(delivered).toEqual(expect.objectContaining({
      state: 'delivered',
      delivered_at: '2026-08-31T10:15:02.000Z',
    }));
  });

  it('recovers firing reminders to pending after an interrupted process', async () => {
    const first = await store.create({ dueLocal: '2026-08-31T10:00', text: 'Erste' });
    const second = await store.create({ dueLocal: '2026-08-31T11:00', text: 'Zweite' });
    await store.claim(first.id, '2026-08-31T10:00:00.000Z');
    await store.claim(second.id, '2026-08-31T11:00:00.000Z');

    expect(await store.recoverFiring()).toBe(2);
    expect((await store.listPendingThrough('2026-08-31T23:59')).map(({ state }) => state)).toEqual([
      'pending',
      'pending',
    ]);
    expect(await store.recoverFiring()).toBe(0);
  });

  it('cancels only an open reminder with compare-and-update semantics', async () => {
    const pending = await store.create({ dueLocal: '2026-08-31T10:00', text: 'Pending' });
    const delivered = await store.create({ dueLocal: '2026-08-31T11:00', text: 'Delivered' });
    await store.claim(delivered.id, '2026-08-31T11:00:00.000Z');
    await store.markDelivered(delivered.id, '2026-08-31T11:00:01.000Z');

    expect(await store.cancel(pending.id, '2026-08-30T12:00:00.000Z')).toBe(true);
    expect(await store.cancel(pending.id, '2026-08-30T12:00:01.000Z')).toBe(false);
    expect(await store.cancel(delivered.id, '2026-08-30T12:00:02.000Z')).toBe(false);
    const [cancelled] = await encrypted.query<{ state: string; cancelled_at: string }>('reminders', {
      id: pending.id,
    });
    expect(cancelled).toEqual(expect.objectContaining({ state: 'cancelled' }));
  });

  it('enforces the active reminder limit across pending and firing states', async () => {
    for (let index = 0; index < MAX_OPEN_REMINDERS; index += 1) {
      await store.create({
        dueLocal: `2026-09-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00`,
        text: `Erinnerung ${index}`,
      });
    }
    await expect(store.create({
      dueLocal: '2026-09-10T10:00',
      text: 'Eine zu viel',
    })).rejects.toBeInstanceOf(ReminderLimitError);
  });

  it('rejects malformed local due values before persistence', async () => {
    await expect(store.create({ dueLocal: '2026-02-30T10:00', text: 'Ungültig' })).rejects.toThrow(
      'not a valid local date',
    );
    await expect(store.create({ dueLocal: '2026-08-31T10:00:30', text: 'Sekunden' })).rejects.toThrow(
      'YYYY-MM-DDTHH:mm',
    );
  });

  it('quarantines AAD-moved reminder ciphertext instead of returning corrupted content', async () => {
    const first = await store.create({ dueLocal: '2026-08-31T10:00', text: 'Erste Erinnerung' });
    const second = await store.create({ dueLocal: '2026-08-31T11:00', text: 'Zweite Erinnerung' });
    const [firstRaw] = await raw.query<{ text: string }>('reminders', { id: first.id });
    await raw.update('reminders', { id: second.id }, { text: firstRaw.text });

    expect((await store.listOpen()).map(({ id }) => id)).toEqual([first.id]);
    expect(await raw.query('storage_quarantine', {
      source_table: 'reminders',
      source_row_id: second.id,
    })).toHaveLength(1);
  });
});
