import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EncryptedStorage } from './encrypted-storage.js';
import { JsonStorage } from './json-storage.js';
import { SqliteStorage } from './sqlite-storage.js';
import Database from 'better-sqlite3';
import { KeyManager } from '../crypto/key-manager.js';
import { encrypt } from '../crypto/crypto.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION } from './storage.interface.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('EncryptedStorage', () => {
  let tmpDir: string;
  let keyManager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-enc-'));
    keyManager = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 92) });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with JsonStorage', () => {
    let storage: EncryptedStorage;
    let rawStorage: JsonStorage;

    beforeEach(() => {
      rawStorage = new JsonStorage(path.join(tmpDir, 'config.json'));
      storage = new EncryptedStorage(rawStorage, keyManager.getOrCreateKey());
    });

    afterEach(async () => {
      await storage.close();
    });

    it('encrypts and decrypts a value transparently', async () => {
      await storage.set('name', 'Sarah');
      expect(await storage.get('name')).toBe('Sarah');
    });

    it('stores encrypted data on disk (not plaintext)', async () => {
      await storage.set('secret', 'my-password-123');
      const rawValue = await rawStorage.get<string>('secret');
      expect(rawValue).not.toBe('my-password-123');
      expect(rawValue).toBeTruthy();
    });

    it('handles objects', async () => {
      const obj = { city: 'Berlin', code: 12345 };
      await storage.set('profile', obj);
      expect(await storage.get('profile')).toEqual(obj);
    });

    it('returns undefined for missing keys', async () => {
      expect(await storage.get('nope')).toBeUndefined();
    });

    it('rejects a plaintext downgrade instead of treating it as a legacy value', async () => {
      await rawStorage.set('legacy', 'vorhandener Klartext');
      await expect(storage.get('legacy')).rejects.toThrow('failed authentication');
    });

    it('rejects an object downgrade instead of bypassing encryption', async () => {
      await rawStorage.set('legacy', { secret: true });
      await expect(storage.get('legacy')).rejects.toThrow('failed authentication');
    });

    it('reads legacy unversioned ciphertext', async () => {
      await rawStorage.set('legacy', encrypt(JSON.stringify({ value: 7 }), keyManager.getOrCreateKey()));
      expect(await storage.get('legacy')).toEqual({ value: 7 });
      expect(await rawStorage.get<string>('legacy')).toMatch(/^sarah-enc:v2:/);
    });

    it('recovers authenticated ciphertext corruption from the last valid JSON snapshot', async () => {
      await storage.set('secret', 'sicher');
      const ciphertext = await rawStorage.get<string>('secret');
      expect(ciphertext).toBeTruthy();
      const replacement = ciphertext!.endsWith('A') ? 'B' : 'A';
      await rawStorage.set('secret', `${ciphertext!.slice(0, -1)}${replacement}`);

      await expect(storage.get('secret')).resolves.toBe('sicher');
      expect(storage.getIntegrityFailures()).toEqual([
        expect.objectContaining({ location: 'config:secret' }),
      ]);
    });

    it('rejects recovery when the backup does not contain the corrupted key', async () => {
      await rawStorage.set('other', 'backup-only');
      await storage.set('secret', 'sicher');

      const configPath = path.join(tmpDir, 'config.json');
      const primary = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      primary.secret = 'sarah-enc:v2:invalid-authenticated-ciphertext';
      fs.writeFileSync(configPath, JSON.stringify(primary), 'utf-8');

      const recovered = new EncryptedStorage(
        new JsonStorage(configPath),
        keyManager.getOrCreateKey(),
      );
      await expect(recovered.get('secret')).rejects.toThrow('failed authentication');
      await recovered.close();
    });

    it('quarantines corruption when no authenticated backup can be recovered', async () => {
      await storage.set('secret', 'sicher');
      const ciphertext = await rawStorage.get<string>('secret');
      const replacement = ciphertext!.endsWith('A') ? 'B' : 'A';
      await rawStorage.set('secret', `${ciphertext!.slice(0, -1)}${replacement}`);
      fs.rmSync(path.join(tmpDir, 'config.json.bak'), { force: true });

      await expect(storage.get('secret')).rejects.toThrow('failed authentication');
    });
  });

  describe('with SqliteStorage', () => {
    let storage: EncryptedStorage;
    let rawStorage: SqliteStorage;

    beforeEach(() => {
      const key = keyManager.getOrCreateKey();
      rawStorage = new SqliteStorage(path.join(tmpDir, 'sarah.db'));
      storage = new EncryptedStorage(rawStorage, key);
    });

    afterEach(async () => {
      await storage.close();
    });

    it('encrypts table row values and decrypts on query', async () => {
      await storage.insert('persistent_rules', { category: 'test', rule: 'secret rule' });
      const rows = await storage.query<{ rule: string }>('persistent_rules', { category: 'test' });
      expect(rows).toHaveLength(1);
      expect(rows[0].rule).toBe('secret rule');
    });

    it('encrypts kv values', async () => {
      await storage.set('key', { data: 'sensitive' });
      expect(await storage.get('key')).toEqual({ data: 'sensitive' });
    });

    it('keeps conversation close_status structural so its SQLite CHECK remains enforceable', async () => {
      const id = await storage.insert('conversations', { mode: 'ambient' });

      await expect(storage.update('conversations', { id }, {
        close_status: 'completed',
        ended_at: '2026-08-27T12:00:00.000Z',
      })).resolves.toBe(1);

      const [raw] = await rawStorage.query<{ close_status: string }>('conversations', { id });
      expect(raw.close_status).toBe('completed');
    });

    it('decrypts message content in queryMessagesPage results', async () => {
      await rawStorage.insert('conversations', { id: 1 });
      await storage.insert('messages', {
        conversation_id: 1,
        turn_id: 'turn-1',
        role: 'user',
        content: 'geheimer Inhalt',
      });

      const rawRows = await rawStorage.queryMessagesPage({ excludeConversationId: 99, limit: 10 });
      expect(rawRows[0].content).not.toBe('geheimer Inhalt');

      const rows = await storage.queryMessagesPage({ excludeConversationId: 99, limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('geheimer Inhalt');
      expect(rows[0].role).toBe('user');
      expect(rows[0].conversation_id).toBe(1);
    });

    it('encrypts every message written through the atomic turn operation', async () => {
      await rawStorage.insert('conversations', { id: 1 });
      await storage.insertTurnMessages(1, 'turn-1', [
        { role: 'user', content: 'private Frage' },
        { role: 'assistant', content: 'private Antwort' },
      ]);

      const rawRows = await rawStorage.queryMessagesPage({ excludeConversationId: 99, limit: 10 });
      expect(rawRows.every((row) => !row.content.includes('private'))).toBe(true);
      const rows = await storage.queryMessagesPage({ excludeConversationId: 99, limit: 10 });
      expect(rows.map((row) => row.content).reverse()).toEqual(['private Frage', 'private Antwort']);
      expect(rows.every((row) => row.turn_id === 'turn-1')).toBe(true);
    });

    it('quarantines a corrupt generic row, skips it, and reports degraded integrity', async () => {
      const failures: string[] = [];
      const observed = new EncryptedStorage(rawStorage, keyManager.getOrCreateKey(), {
        onIntegrityFailure: (failure) => failures.push(failure.location),
      });
      const id = await observed.insert('persistent_rules', { category: 'test', rule: 'geheim' });
      const [raw] = await rawStorage.query<{ rule: string }>('persistent_rules', { id });
      const replacement = raw.rule.endsWith('A') ? 'B' : 'A';
      await rawStorage.update('persistent_rules', { id }, { rule: `${raw.rule.slice(0, -1)}${replacement}` });

      await expect(observed.query('persistent_rules', { id })).resolves.toEqual([]);
      expect(await rawStorage.query('persistent_rules', { id })).toHaveLength(1);
      const rawQuarantined = await rawStorage.query<{ row_data: string }>('storage_quarantine', { source_table: 'persistent_rules' });
      expect(rawQuarantined[0].row_data).toMatch(/^sarah-enc:v2:/);
      const quarantined = await observed.query<{ row_data: string }>('storage_quarantine', { source_table: 'persistent_rules' });
      expect(quarantined).toHaveLength(1);
      expect(JSON.parse(quarantined[0].row_data)).toEqual(expect.objectContaining({ id }));
      expect(failures).toEqual([`row:persistent_rules:${id}:rule`]);
    });

    it('quarantines corrupt message ciphertext instead of returning it as context', async () => {
      await rawStorage.insert('conversations', { id: 2 });
      await storage.insertTurnMessages(2, 'turn-corrupt', [
        { role: 'user', content: 'vertraulich' },
      ]);
      const [raw] = await rawStorage.queryMessagesPage({ excludeConversationId: 99, limit: 10 });
      const replacement = raw.content.endsWith('A') ? 'B' : 'A';
      await rawStorage.update('messages', { id: raw.id }, {
        content: `${raw.content.slice(0, -1)}${replacement}`,
      });

      await expect(storage.queryMessagesPage({ excludeConversationId: 99, limit: 10 })).resolves.toEqual([]);
      expect(await rawStorage.query('messages', { id: raw.id })).toHaveLength(1);
      expect(await rawStorage.query('storage_quarantine', { source_table: 'messages' })).toHaveLength(1);
    });

    it('binds ciphertext to its table, row, and column identity', async () => {
      const firstId = await storage.insert('persistent_rules', { category: 'test', rule: 'erste Regel' });
      const secondId = await storage.insert('persistent_rules', { category: 'test', rule: 'zweite Regel' });
      const [firstRaw] = await rawStorage.query<{ rule: string }>('persistent_rules', { id: firstId });
      await rawStorage.update('persistent_rules', { id: secondId }, { rule: firstRaw.rule });

      await expect(storage.query('persistent_rules', { id: secondId })).resolves.toEqual([]);
      expect(await rawStorage.query('persistent_rules', { id: secondId })).toHaveLength(1);
    });

    it('does not delete rows when the encryption key is wrong', async () => {
      const id = await storage.insert('persistent_rules', { category: 'test', rule: 'recoverable' });
      const wrongKeyStorage = new EncryptedStorage(rawStorage, Buffer.alloc(32, 111));

      await expect(wrongKeyStorage.query('persistent_rules', { id })).resolves.toEqual([]);
      expect(await rawStorage.query('persistent_rules', { id })).toHaveLength(1);
      expect(await rawStorage.query('storage_quarantine', { source_row_id: id })).toHaveLength(1);
    });

    it('rejects plaintext table rows without copying plaintext into quarantine metadata', async () => {
      const id = await rawStorage.insert('persistent_rules', { category: 'test', rule: 'plaintext-secret' });

      await expect(storage.query('persistent_rules', { id })).resolves.toEqual([]);

      const [rawQuarantine] = await rawStorage.query<{ ciphertext: string; row_data: string }>(
        'storage_quarantine',
        { source_row_id: id },
      );
      expect(rawQuarantine.ciphertext).not.toContain('plaintext-secret');
      expect(rawQuarantine.row_data).not.toContain('plaintext-secret');
      expect(await rawStorage.query('persistent_rules', { id })).toHaveLength(1);
    });

    it('does not legitimize a moved unbound legacy ciphertext at its current row', async () => {
      const legacyCiphertext = encrypt(JSON.stringify('legacy secret'), keyManager.getOrCreateKey());
      const sourceId = await rawStorage.insert('persistent_rules', {
        category: 'legacy',
        rule: legacyCiphertext,
      });
      const targetId = await rawStorage.insert('persistent_rules', {
        category: 'legacy',
        rule: legacyCiphertext,
      });

      await expect(storage.query('persistent_rules', { id: targetId })).resolves.toEqual([]);

      const [target] = await rawStorage.query<{ rule: string }>('persistent_rules', { id: targetId });
      expect(target.rule).toBe(legacyCiphertext);
      expect(await rawStorage.query('storage_quarantine', { source_row_id: targetId })).toHaveLength(1);
      expect(await rawStorage.query('persistent_rules', { id: sourceId })).toHaveLength(1);
    });

    it('restores an isolated legacy cell only after review, consent, and an atomic backup', async () => {
      const legacyCiphertext = encrypt(JSON.stringify('reviewed legacy rule'), keyManager.getOrCreateKey());
      const id = await rawStorage.insert('persistent_rules', {
        category: 'legacy',
        rule: legacyCiphertext,
      });

      await expect(storage.query('persistent_rules', { id })).resolves.toEqual([]);
      const review = await storage.reviewLegacyDbRecovery();
      expect(review.warning).toContain('nicht an Tabelle und Zeile gebundener');
      expect(review.candidates).toEqual([
        expect.objectContaining({
          table: 'persistent_rules', rowId: id, column: 'rule', preview: 'reviewed legacy rule',
        }),
      ]);
      await expect(storage.restoreLegacyDbRecovery(
        [review.candidates[0].quarantineId],
        'yes',
      )).rejects.toThrow('confirmation');
      await expect(storage.query('persistent_rules', { id })).resolves.toEqual([]);

      const result = await storage.restoreLegacyDbRecovery(
        [review.candidates[0].quarantineId],
        LEGACY_DB_RECOVERY_CONFIRMATION,
      );

      expect(result.restored).toBe(1);
      expect(fs.existsSync(result.backupPath)).toBe(true);
      const backup = new Database(result.backupPath, { readonly: true });
      const backedUp = backup.prepare('SELECT rule FROM persistent_rules WHERE id = ?').get(id) as { rule: string };
      const backedUpQuarantine = backup.prepare(
        "SELECT reason FROM storage_quarantine WHERE source_table = 'persistent_rules' AND source_row_id = ?",
      ).get(id) as { reason: string };
      backup.close();
      expect(backedUp.rule).toBe(legacyCiphertext);
      expect(backedUpQuarantine.reason).toBe('unbound_legacy_ciphertext');
      await expect(storage.query<{ rule: string }>('persistent_rules', { id })).resolves.toEqual([
        expect.objectContaining({ rule: 'reviewed legacy rule' }),
      ]);
      const [raw] = await rawStorage.query<{ rule: string }>('persistent_rules', { id });
      expect(raw.rule).toMatch(/^sarah-enc:v2:/);
      expect(await rawStorage.query('storage_quarantine', { source_row_id: id })).toEqual([]);
    });
  });
});
