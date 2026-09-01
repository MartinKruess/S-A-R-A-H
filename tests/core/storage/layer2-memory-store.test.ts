import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { EncryptedStorage } from '../../../src/core/storage/encrypted-storage.js';
import { Layer2MemoryStore } from '../../../src/core/storage/layer2-memory-store.js';

describe('Layer2MemoryStore', () => {
  let tmpDir: string;
  let db: SqliteStorage;
  let store: Layer2MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-memory-store-'));
    db = new SqliteStorage(path.join(tmpDir, 'memory.db'));
    store = new Layer2MemoryStore(db);
    await db.insert('conversations', { mode: 'ambient' });
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stages a safe turn once and refuses unconditional secrets', async () => {
    const policy = { allowed: true, exclusions: [] } as const;
    const safeMessages = [{ role: 'user' as const, content: 'Mein Hobby ist Musik.' }];
    const id = await store.stageTurn(1, 'turn-1', safeMessages, policy);
    expect(id).toBeTypeOf('number');
    expect(await store.stageTurn(1, 'turn-1', safeMessages, policy)).toBe(id);
    expect(await store.stageTurn(1, 'turn-2', [
      { role: 'user', content: 'Mein Passwort ist Fuchs-17.' },
    ], policy)).toBeNull();
  });

  it('stores durable provenance as a salted fingerprint without the raw word sequence', async () => {
    const stagingId = await store.stageTurn(1, 'turn-fingerprint', [
      { role: 'user', content: 'Martin besucht morgen ein Schwimmbad in Berlin.' },
    ], { allowed: true, exclusions: [] });

    const [staging] = await db.query<{ policy_terms: string }>('memory_staging', { id: stagingId });

    expect(staging.policy_terms).toMatch(/^sarah-policy-fp:v1:/);
    expect(staging.policy_terms).not.toMatch(/martin|schwimmbad|berlin/iu);
    expect(staging.policy_terms.length).toBeLessThan(6_000);
  });

  it('applies changed policy to exact turns without deleting unrelated session turns', async () => {
    await db.insertTurnMessages(1, 'turn-music', [
      { role: 'user', content: 'Mein Hobby ist Musik.' },
      { role: 'assistant', content: 'Verstanden.' },
    ]);
    await db.insertTurnMessages(1, 'turn-finance', [
      { role: 'user', content: 'Meine Bank hat das Konto gesperrt.' },
      { role: 'assistant', content: 'Verstanden.' },
    ]);

    const result = await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result.turns).toBe(1);
    const rows = await db.query<{ turn_id: string }>('messages');
    expect(new Set(rows.map((row) => row.turn_id))).toEqual(new Set(['turn-music']));
  });

  it('purges a merged memory when any retained source becomes policy-excluded', async () => {
    await db.insertTurnMessages(1, 'turn-safe-source', [
      { role: 'user', content: 'Martin mag strukturierte Übersichten.' },
    ]);
    await db.insertTurnMessages(1, 'turn-finance-source', [
      { role: 'user', content: 'Die Bankverbindung gehört zu den Finanzen.' },
    ]);
    const topicId = await db.insert('memory_topics', { title: 'Arbeitsweise', version: 1 });
    const memoryId = await db.insert('curated_memories', {
      topic_id: topicId,
      kind: 'preference',
      content: 'Martin mag strukturierte Übersichten.',
      evidence: 'Martin mag strukturierte Übersichten.',
      source_conversation_id: 1,
      source_turn_id: 'turn-safe-source',
      confidence: 0.9,
      status: 'active',
      revision: 2,
      created_by_action: 'merge',
    });
    await db.insert('memory_sources', {
      memory_id: memoryId,
      source_key: 'turn:1:turn-finance-source',
      source_type: 'turn',
      source_conversation_id: 1,
      source_turn_id: 'turn-finance-source',
    });

    const result = await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result.memories).toBe(1);
    expect(await db.query('curated_memories', { id: memoryId })).toEqual([]);
  });

  it('applies changed exclusions to encrypted Memory Author evidence as well as summaries', async () => {
    const topicId = await db.insert('memory_topics', { title: 'Arbeitsweise', version: 1 });
    const memoryId = await db.insert('curated_memories', {
      topic_id: topicId,
      kind: 'fact',
      content: 'Martin bevorzugt eine klare Darstellung.',
      evidence: 'Meine Bankdaten sollen klar dargestellt werden.',
      source_conversation_id: 1,
      source_turn_id: 'turn-evidence',
      confidence: 0.9,
      status: 'active',
      revision: 1,
      created_by_action: 'add',
    });

    const result = await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result.memories).toBe(1);
    expect(await db.query('curated_memories', { id: memoryId })).toEqual([]);
    expect(await db.query('memory_topics', { id: topicId })).toEqual([]);
  });

  it('supports explicit show, correct, forget and hard-delete lifecycle', async () => {
    const finalizePrivacyDeletion = vi.spyOn(db, 'finalizePrivacyDeletion').mockResolvedValue();
    const policy = { allowed: true, exclusions: [] } as const;
    const id = await store.rememberExplicit({
      kind: 'explicit', content: 'Martin bevorzugt kurze Antworten.', sourceConversationId: 1,
      sourceTurnId: 'turn-1', confidence: 1,
    }, policy);
    expect(id).toBeTypeOf('number');
    expect((await store.list())[0]).toMatchObject({ id, kind: 'explicit' });
    expect(await store.correct(id!, 'Martin bevorzugt mittellange Antworten.', policy)).toBe(true);
    expect((await store.list())[0].content).toContain('mittellange');
    expect(await store.forget(id!)).toBe(true);
    expect(finalizePrivacyDeletion).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    expect(await store.list({ includeDeleted: true })).toMatchObject([{ id }]);
    expect(await store.delete(id!)).toBe(true);
    expect(finalizePrivacyDeletion).toHaveBeenCalledTimes(1);
  });

  it('atomically deletes the complete confirmed curated-memory set', async () => {
    const finalizePrivacyDeletion = vi.spyOn(db, 'finalizePrivacyDeletion').mockResolvedValue();
    const policy = { allowed: true, exclusions: [] } as const;
    const first = await store.rememberExplicit({
      kind: 'explicit', content: 'Erste Erinnerung.', sourceConversationId: 1,
      sourceTurnId: 'turn-first', confidence: 1,
    }, policy);
    const second = await store.rememberExplicit({
      kind: 'explicit', content: 'Zweite Erinnerung.', sourceConversationId: 1,
      sourceTurnId: 'turn-second', confidence: 1,
    }, policy);
    if (first == null || second == null) throw new Error('Expected stored memories');
    await store.forget(first);

    expect(await store.deleteAll([first, second])).toBe(2);
    expect(await store.list({ includeDeleted: true })).toEqual([]);
    expect(finalizePrivacyDeletion).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when curated memories changed after confirmation', async () => {
    const policy = { allowed: true, exclusions: [] } as const;
    const confirmed = await store.rememberExplicit({
      kind: 'explicit', content: 'Bestätigte Erinnerung.', sourceConversationId: 1,
      sourceTurnId: 'turn-confirmed', confidence: 1,
    }, policy);
    if (confirmed == null) throw new Error('Expected stored memory');
    await store.rememberExplicit({
      kind: 'explicit', content: 'Später gespeicherte Erinnerung.', sourceConversationId: 1,
      sourceTurnId: 'turn-later', confidence: 1,
    }, policy);

    await expect(store.deleteAll([confirmed])).rejects.toThrow(
      'Curated memories changed after deletion was requested',
    );
    expect(await store.list({ includeDeleted: true })).toHaveLength(2);
  });

  it('recovers an interrupted staging lease for restart processing', async () => {
    await store.stageTurn(1, 'turn-restart', [
      { role: 'user', content: 'Ein sicherer Gesprächsblock.' },
    ], {
      allowed: true,
      exclusions: [],
    });
    const claimed = await store.claimNext(1_000);
    expect(claimed?.state).toBe('processing');

    expect(await store.recoverInterruptedJobs(1_000 + 11 * 60 * 1000)).toBe(1);
    expect(await store.hasPending()).toBe(true);
  });

  it('recovers a fresh processing lease when process restart proves ownership was lost', async () => {
    await store.stageTurn(1, 'turn-fresh-restart', [
      { role: 'user', content: 'Ein sicherer Gesprächsblock.' },
    ], { allowed: true, exclusions: [] });
    await store.claimNext(5_000);

    expect(await store.recoverInterruptedJobs(5_001, true)).toBe(1);
    expect(await store.hasPending()).toBe(true);
  });

  it('removes paraphrased curated memory through staging provenance', async () => {
    await db.insertTurnMessages(1, 'turn-private', [
      { role: 'user', content: 'Meine Bank hat das Konto gesperrt.' },
      { role: 'assistant', content: 'Ich helfe dir dabei.' },
    ]);
    const stagingId = await store.stageTurn(1, 'turn-private', [
      { role: 'user', content: 'Meine Bank hat das Konto gesperrt.' },
      { role: 'assistant', content: 'Ich helfe dir dabei.' },
    ], { allowed: true, exclusions: [] });
    await db.insert('curated_memories', {
      source_staging_id: stagingId,
      kind: 'episode',
      content: 'Ein Zahlungsdienst war vorübergehend nicht verfügbar.',
      source_conversation_id: 1,
      source_turn_id: 'turn-private',
      confidence: 0.8,
      deleted_at: null,
    });
    await db.update('memory_staging', { id: stagingId }, {
      state: 'completed',
      source_content: '',
    });

    const result = await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result.memories).toBe(1);
    expect(await db.query('curated_memories')).toEqual([]);
  });

  it('deletes completed memories fail-closed when fingerprint provenance is malformed', async () => {
    const stagingId = await db.insert('memory_staging', {
      conversation_id: 1,
      turn_id: 'turn-malformed-provenance',
      source_content: '',
      policy_terms: 'sarah-policy-fp:v1:{broken',
      state: 'completed',
    });
    await db.insert('curated_memories', {
      source_staging_id: stagingId,
      kind: 'episode',
      content: 'Harmlos formulierte Erinnerung.',
      source_conversation_id: 1,
      source_turn_id: 'turn-malformed-provenance',
      confidence: 0.8,
      deleted_at: null,
    });

    const result = await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result.memories).toBe(1);
    expect(await db.query('curated_memories')).toEqual([]);
    expect(await db.query('memory_staging')).toEqual([]);
  });

  it('supports legacy plaintext provenance during cleanup and fingerprints surviving rows', async () => {
    const financeId = await db.insert('memory_staging', {
      conversation_id: 1,
      turn_id: 'turn-legacy-finance',
      source_content: '',
      policy_terms: 'meine bank hat das konto gesperrt',
      state: 'completed',
    });
    await db.insert('curated_memories', {
      source_staging_id: financeId,
      kind: 'episode',
      content: 'Ein Dienst war nicht verfügbar.',
      source_conversation_id: 1,
      source_turn_id: 'turn-legacy-finance',
      confidence: 0.8,
      deleted_at: null,
    });
    const safeId = await db.insert('memory_staging', {
      conversation_id: 1,
      turn_id: 'turn-legacy-safe',
      source_content: '',
      policy_terms: 'ich spiele gerne gitarre',
      state: 'completed',
    });

    await store.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(await db.query('memory_staging', { id: financeId })).toEqual([]);
    const [safe] = await db.query<{ policy_terms: string }>('memory_staging', { id: safeId });
    expect(safe.policy_terms).toMatch(/^sarah-policy-fp:v1:/);
    expect(safe.policy_terms).not.toContain('gitarre');
  });

  it('atomically purges quarantined memory originals and encrypted recovery copies for new exclusions', async () => {
    const encryptedDb = new EncryptedStorage(db, Buffer.alloc(32, 77));
    const encryptedStore = new Layer2MemoryStore(encryptedDb);

    await encryptedDb.insertTurnMessages(1, 'turn-corrupt-message', [
      { role: 'user', content: 'Nicht lesbarer Turn.' },
    ]);
    const stagingId = await encryptedStore.persistTurn(1, 'turn-corrupt-staging', [
      { role: 'user', content: 'Nicht lesbare Quelle.' },
    ], { allowed: true, exclusions: [] });
    await encryptedDb.insert('curated_memories', {
      source_staging_id: stagingId,
      kind: 'episode',
      content: 'Paraphrasierte Erinnerung.',
      source_conversation_id: 1,
      source_turn_id: 'turn-corrupt-staging',
      confidence: 0.8,
      deleted_at: null,
    });
    const corruptMemoryId = await encryptedDb.insert('curated_memories', {
      source_staging_id: null,
      kind: 'explicit',
      content: 'Separat beschädigte Erinnerung.',
      source_conversation_id: 1,
      source_turn_id: 'turn-corrupt-memory',
      confidence: 1,
      deleted_at: null,
    });
    await encryptedStore.persistTurn(1, 'turn-safe', [
      { role: 'user', content: 'Ich spiele gerne Gitarre.' },
    ], { allowed: true, exclusions: [] });

    const [message] = await db.query<{ id: number; content: string }>('messages', { turn_id: 'turn-corrupt-message' });
    const [staging] = await db.query<{ source_content: string }>('memory_staging', { id: stagingId });
    const [memory] = await db.query<{ content: string }>('curated_memories', { id: corruptMemoryId });
    await db.update('messages', { id: message.id }, { content: mutateCiphertext(message.content) });
    await db.update('memory_staging', { id: stagingId }, { source_content: mutateCiphertext(staging.source_content) });
    await db.update('curated_memories', { id: corruptMemoryId }, { content: mutateCiphertext(memory.content) });

    const result = await encryptedStore.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result).toEqual({ turns: 2, staging: 1, memories: 2, reminders: 0 });
    expect(await db.query('storage_quarantine')).toEqual([]);
    expect(await db.query('messages', { turn_id: 'turn-corrupt-message' })).toEqual([]);
    expect(await db.query('memory_staging', { id: stagingId })).toEqual([]);
    expect(await db.query('curated_memories', { id: corruptMemoryId })).toEqual([]);
    expect(await db.query('messages', { turn_id: 'turn-safe' })).toHaveLength(1);
  });

  it('retroactively purges matching and unreadable legacy Layer-2 memory but preserves absolute rules', async () => {
    const encryptedDb = new EncryptedStorage(db, Buffer.alloc(32, 79));
    const encryptedStore = new Layer2MemoryStore(encryptedDb);
    const financeFactId = await encryptedDb.insert('learned_facts', {
      category: 'Finanzen', fact: 'Meine Bank hat das Konto gesperrt.', confidence: 0.8, source: 'user',
    });
    const safeFactId = await encryptedDb.insert('learned_facts', {
      category: 'Hobby', fact: 'Ich spiele Gitarre.', confidence: 0.8, source: 'user',
    });
    const financeRuleId = await encryptedDb.insert('persistent_rules', {
      category: 'Finanzen', rule: 'Banktermine vormittags planen.',
    });
    const safeRuleId = await encryptedDb.insert('persistent_rules', {
      category: 'Stil', rule: 'Kurz antworten.',
    });
    const financeSessionRuleId = await encryptedDb.insert('session_rules', {
      session_id: 'current', rule: 'Über mein Konto sprechen.',
    });
    const corruptSessionRuleId = await encryptedDb.insert('session_rules', {
      session_id: 'current', rule: 'Nicht mehr authentifizierbar.',
    });
    const absoluteRuleId = await encryptedDb.insert('absolute_rules', {
      rule: 'Bankdaten niemals ungefragt ausgeben.',
    });
    const [corrupt] = await db.query<{ rule: string }>('session_rules', { id: corruptSessionRuleId });
    await db.update('session_rules', { id: corruptSessionRuleId }, {
      rule: mutateCiphertext(corrupt.rule),
    });
    await encryptedDb.query('session_rules', { id: corruptSessionRuleId });
    const [quarantine] = await db.query<{ id: number }>('storage_quarantine', {
      source_table: 'session_rules', source_row_id: corruptSessionRuleId,
    });
    await db.insert('storage_quarantine', {
      source_table: 'storage_quarantine', source_row_id: quarantine.id,
      column_name: 'row_data', ciphertext: 'nested', row_data: '{}',
      reason: 'cipher_authentication_failed',
    });

    const result = await encryptedStore.applyPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(result).toEqual({ turns: 0, staging: 0, memories: 4, reminders: 0 });
    expect(await db.query('learned_facts', { id: financeFactId })).toEqual([]);
    expect(await db.query('persistent_rules', { id: financeRuleId })).toEqual([]);
    expect(await db.query('session_rules', { id: financeSessionRuleId })).toEqual([]);
    expect(await db.query('session_rules', { id: corruptSessionRuleId })).toEqual([]);
    expect(await encryptedDb.query('learned_facts', { id: safeFactId })).toHaveLength(1);
    expect(await encryptedDb.query('persistent_rules', { id: safeRuleId })).toHaveLength(1);
    expect(await encryptedDb.query('absolute_rules', { id: absoluteRuleId })).toHaveLength(1);
    expect(await db.query('storage_quarantine')).toEqual([]);
  });

  it('retroactively purges excluded and unconditionally private reminders', async () => {
    const encryptedDb = new EncryptedStorage(db, Buffer.alloc(32, 81));
    const encryptedStore = new Layer2MemoryStore(encryptedDb);
    const healthId = await encryptedDb.insert('reminders', {
      due_local: '2026-09-01T08:00',
      text: 'Blutdruck beim Hausarzt messen',
      state: 'pending',
      source_kind: 'local',
      origin_mode: 'chat',
      private_context: 0,
    });
    const secretId = await encryptedDb.insert('reminders', {
      due_local: '2026-09-01T09:00',
      text: 'Passwort ist Fuchs-17',
      state: 'pending',
      source_kind: 'local',
      origin_mode: 'chat',
      private_context: 0,
    });
    const safeId = await encryptedDb.insert('reminders', {
      due_local: '2026-09-01T10:00',
      text: 'Müll rausbringen',
      state: 'pending',
      source_kind: 'local',
      origin_mode: 'chat',
      private_context: 0,
    });
    const corruptId = await encryptedDb.insert('reminders', {
      due_local: '2026-09-01T11:00',
      text: 'Arztbericht abholen',
      state: 'pending',
      source_kind: 'local',
      origin_mode: 'chat',
      private_context: 0,
    });
    const [corrupt] = await db.query<{ text: string }>('reminders', { id: corruptId });
    await db.update('reminders', { id: corruptId }, { text: mutateCiphertext(corrupt.text) });

    const result = await encryptedStore.applyPolicy({ allowed: true, exclusions: ['Gesundheit'] });

    expect(result).toEqual({ turns: 0, staging: 0, memories: 0, reminders: 3 });
    expect(await encryptedDb.query('reminders', { id: healthId })).toEqual([]);
    expect(await encryptedDb.query('reminders', { id: secretId })).toEqual([]);
    expect(await db.query('reminders', { id: corruptId })).toEqual([]);
    expect(await encryptedDb.query('reminders', { id: safeId })).toHaveLength(1);
    expect(await db.query('storage_quarantine', { source_table: 'reminders' })).toEqual([]);
  });

  it('pauses memory without deleting existing readable or quarantined data', async () => {
    const encryptedDb = new EncryptedStorage(db, Buffer.alloc(32, 78));
    const encryptedStore = new Layer2MemoryStore(encryptedDb);
    await encryptedStore.persistTurn(1, 'turn-disable', [
      { role: 'user', content: 'Persistierter Turn.' },
    ], { allowed: true, exclusions: [] });
    const [message] = await db.query<{ id: number; content: string }>('messages', { turn_id: 'turn-disable' });
    await db.update('messages', { id: message.id }, { content: mutateCiphertext(message.content) });
    await encryptedDb.query('messages');
    expect(await db.query('storage_quarantine')).toHaveLength(1);

    const result = await encryptedStore.applyPolicy({ allowed: false, exclusions: [] });

    expect(result).toEqual({ turns: 0, staging: 0, memories: 0, reminders: 0 });
    expect(await db.query('messages')).toHaveLength(1);
    expect(await db.query('memory_staging')).toHaveLength(1);
    expect(await db.query('curated_memories')).toEqual([]);
    expect(await db.query('storage_quarantine')).toHaveLength(1);
  });

  it('keeps conversation summaries untouched while memory is paused', async () => {
    const encryptedDb = new EncryptedStorage(db, Buffer.alloc(32, 80));
    const encryptedStore = new Layer2MemoryStore(encryptedDb);
    await encryptedDb.update('conversations', { id: 1 }, { summary: 'Persistierte Zusammenfassung.' });
    const secondId = await encryptedDb.insert('conversations', {
      mode: 'ambient', summary: 'Beschädigte Zusammenfassung.',
    });
    const [second] = await db.query<{ summary: string }>('conversations', { id: secondId });
    await db.update('conversations', { id: secondId }, {
      summary: mutateCiphertext(second.summary),
    });
    await encryptedDb.query('conversations', { id: secondId });
    expect(await db.query('storage_quarantine', {
      source_table: 'conversations', source_row_id: secondId, column_name: 'summary',
    })).toHaveLength(1);

    await encryptedStore.applyPolicy({ allowed: false, exclusions: [] });

    const summaries = await encryptedDb.query<{ summary: string }>('conversations');
    expect(summaries[0].summary).toBe('Persistierte Zusammenfassung.');
    expect(summaries).toHaveLength(1);
    const rawSummaries = await db.query<{ summary: string }>('conversations');
    expect(rawSummaries.every((row) => row.summary.startsWith('sarah-enc:v2:'))).toBe(true);
    expect(await db.query('storage_quarantine', {
      source_table: 'conversations', column_name: 'summary',
    })).toHaveLength(1);
  });

  it('recovers retained failed curation jobs on a later startup', async () => {
    await store.stageTurn(1, 'turn-failed', [
      { role: 'user', content: 'Ich interessiere mich für Astronomie.' },
    ], { allowed: true, exclusions: [] });
    const job = await store.claimNext();
    expect(job).not.toBeNull();
    await store.fail(job!.id);

    expect(await store.hasPending()).toBe(false);
    expect(await store.recoverFailedJobs()).toBe(1);
    expect(await store.hasPending()).toBe(true);
  });

  it('does not let explicit writes bypass exclusions or immutable secret policy', async () => {
    const financePolicy = { allowed: true, exclusions: ['Finanzen'] } as const;
    expect(await store.rememberExplicit({
      kind: 'explicit', content: 'Meine Bank ist Beispielbank.', sourceConversationId: 1,
      sourceTurnId: 'turn-bank', confidence: 1,
    }, financePolicy)).toBeNull();
    expect(await store.rememberExplicit({
      kind: 'explicit', content: 'Mein API-Key lautet abc-123.', sourceConversationId: 1,
      sourceTurnId: 'turn-secret', confidence: 1,
    }, { allowed: true, exclusions: [] })).toBeNull();
  });
});

function mutateCiphertext(value: string): string {
  const index = Math.max(value.indexOf(':v2:') + 8, Math.floor(value.length / 2));
  const replacement = value[index] === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
