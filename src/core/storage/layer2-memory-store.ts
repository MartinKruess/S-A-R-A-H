import type {
  CuratedMemoryKind,
  MessageRow,
  StorageProvider,
} from './storage.interface.js';
import { createHash, randomBytes } from 'crypto';
import {
  containsUnconditionallyPrivateData,
  expandMemoryExclusions,
  mustKeepTurnTransient,
  type TurnPersistencePolicy,
} from '../memory-policy.js';

export type MemoryStagingState = 'pending' | 'processing' | 'completed' | 'failed';

export interface MemoryStagingRow {
  id: number;
  conversation_id: number;
  turn_id: string;
  source_content: string;
  policy_terms: string;
  state: MemoryStagingState;
  attempts: number;
  lease_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CuratedMemoryRow {
  id: number;
  source_staging_id: number | null;
  kind: CuratedMemoryKind;
  content: string;
  source_conversation_id: number | null;
  source_turn_id: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CuratedMemoryWrite {
  kind: CuratedMemoryKind;
  content: string;
  sourceConversationId: number | null;
  sourceTurnId: string;
  confidence: number;
}

interface LearnedFactRow {
  id: number;
  category: string;
  fact: string;
  source: string;
}

interface PersistentRuleRow {
  id: number;
  category: string;
  rule: string;
}

interface SessionRuleRow {
  id: number;
  rule: string;
}

interface ReminderPolicyRow {
  id: number;
  text: string;
}

const STALE_LEASE_MS = 10 * 60 * 1000;
const MAX_STAGING_SOURCE_CHARS = 12_000;
const MAX_STAGING_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30_000;
const POLICY_FINGERPRINT_PREFIX = 'sarah-policy-fp:v1:';
const POLICY_FINGERPRINT_BYTES = 4096;
const POLICY_FINGERPRINT_HASHES = 5;

interface PolicyFingerprintPayload {
  version: 1;
  salt: string;
  bits: string;
}

function normalizePolicyTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('de-DE')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function fingerprintPositions(token: string, salt: Buffer): number[] {
  const digest = createHash('sha256').update(salt).update('\0').update(token, 'utf8').digest();
  const bitCount = POLICY_FINGERPRINT_BYTES * 8;
  return Array.from(
    { length: POLICY_FINGERPRINT_HASHES },
    (_, index) => digest.readUInt32BE(index * 4) % bitCount,
  );
}

function setFingerprintBit(bits: Buffer, position: number): void {
  bits[Math.floor(position / 8)] |= 1 << (position % 8);
}

function hasFingerprintBit(bits: Buffer, position: number): boolean {
  return (bits[Math.floor(position / 8)] & (1 << (position % 8))) !== 0;
}

function buildPolicyTerms(messages: ReadonlyArray<{ content: string }>): string {
  return buildPolicyFingerprint(messages.map((message) => message.content).join('\n'));
}

function buildPolicyFingerprint(value: string): string {
  const source = value.slice(0, MAX_STAGING_SOURCE_CHARS);
  const tokens = new Set(normalizePolicyTokens(source));
  if (/https?:\/\/[^\s<>"']+/iu.test(source)) {
    tokens.add('browser');
    tokens.add('browserverlauf');
    tokens.add('url');
  }
  const salt = randomBytes(16);
  const bits = Buffer.alloc(POLICY_FINGERPRINT_BYTES);
  for (const token of tokens) {
    for (const position of fingerprintPositions(token, salt)) setFingerprintBit(bits, position);
  }
  const payload: PolicyFingerprintPayload = {
    version: 1,
    salt: salt.toString('base64url'),
    bits: bits.toString('base64'),
  };
  return `${POLICY_FINGERPRINT_PREFIX}${JSON.stringify(payload)}`;
}

function parsePolicyFingerprint(stored: string): { salt: Buffer; bits: Buffer } | null {
  if (!stored.startsWith(POLICY_FINGERPRINT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(stored.slice(POLICY_FINGERPRINT_PREFIX.length)) as Partial<PolicyFingerprintPayload>;
    if (parsed.version !== 1 || typeof parsed.salt !== 'string' || typeof parsed.bits !== 'string') return null;
    const salt = Buffer.from(parsed.salt, 'base64url');
    const bits = Buffer.from(parsed.bits, 'base64');
    return salt.length === 16 && bits.length === POLICY_FINGERPRINT_BYTES ? { salt, bits } : null;
  } catch {
    return null;
  }
}

function fingerprintMatchesPolicy(
  stored: string,
  policy: TurnPersistencePolicy,
): boolean | null {
  if (!stored.startsWith(POLICY_FINGERPRINT_PREFIX)) {
    if (!stored.trim()) return null;
    return mustKeepTurnTransient([stored], policy);
  }
  const fingerprint = parsePolicyFingerprint(stored);
  if (!fingerprint) return null;
  return expandMemoryExclusions(policy.exclusions).some((exclusion) => {
    const tokens = normalizePolicyTokens(exclusion);
    return tokens.length > 0 && tokens.every((token) =>
      fingerprintPositions(token, fingerprint.salt).every(
        (position) => hasFingerprintBit(fingerprint.bits, position),
      ),
    );
  });
}

/**
 * Typed Layer-2 memory access over the provider-independent storage boundary.
 *
 * - Separates raw short-term staging from curated memories.
 * - Claims one resumable job at a time and commits its result atomically.
 * - Applies changed privacy policies retroactively at turn granularity.
 *
 * @category Data Access Authorization
 */
export class Layer2MemoryStore {
  constructor(private readonly db: StorageProvider) {}

  private stagingSource(
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
  ): string | null {
    const contents = messages.map((message) => message.content);
    if (mustKeepTurnTransient(contents, policy)) return null;
    const source = messages
      .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.content}`)
      .join('\n')
      .trim()
      .slice(0, MAX_STAGING_SOURCE_CHARS);
    return source && !containsUnconditionallyPrivateData(source) ? source : null;
  }

  async recoverInterruptedJobs(now = Date.now(), recoverFresh = false): Promise<number> {
    const rows = await this.db.query<MemoryStagingRow>('memory_staging');
    let recovered = 0;
    for (const row of rows) {
      if (row.state !== 'processing') continue;
      const leasedAt = row.lease_started_at ? Date.parse(row.lease_started_at) : Number.NaN;
      if (!recoverFresh && Number.isFinite(leasedAt) && now - leasedAt < STALE_LEASE_MS) continue;
      recovered += await this.db.update('memory_staging', { id: row.id }, {
        state: 'pending',
        lease_started_at: null,
        updated_at: new Date(now).toISOString(),
      });
    }
    return recovered;
  }

  async recoverFailedJobs(now = Date.now()): Promise<number> {
    const rows = await this.db.query<MemoryStagingRow>('memory_staging', { state: 'failed' });
    let recovered = 0;
    for (const row of rows) {
      if (!row.source_content.trim()) continue;
      recovered += await this.db.update('memory_staging', { id: row.id }, {
        state: 'pending',
        attempts: 0,
        lease_started_at: null,
        updated_at: new Date(now).toISOString(),
      });
    }
    return recovered;
  }

  async stageTurn(
    conversationId: number,
    turnId: string,
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
  ): Promise<number | null> {
    const source = this.stagingSource(messages, policy);
    if (!source) return null;
    const existing = await this.db.query<MemoryStagingRow>('memory_staging', { turn_id: turnId });
    if (existing[0]) return existing[0].id;
    return this.db.insert('memory_staging', {
      conversation_id: conversationId,
      turn_id: turnId,
      source_content: source,
      policy_terms: buildPolicyTerms(messages),
      state: 'pending',
      attempts: 0,
      lease_started_at: null,
    });
  }

  async persistTurn(
    conversationId: number,
    turnId: string,
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
  ): Promise<number | null> {
    const source = this.stagingSource(messages, policy);
    if (!source) return null;
    return this.db.persistTurnWithMemoryStaging(
      conversationId,
      turnId,
      messages,
      source,
      buildPolicyTerms(messages),
    );
  }

  async claimNext(now = Date.now()): Promise<MemoryStagingRow | null> {
    await this.recoverInterruptedJobs(now);
    const rows = await this.db.query<MemoryStagingRow>('memory_staging', { state: 'pending' });
    const next = rows
      .filter((row) => {
        if (row.attempts <= 0) return true;
        const updatedAt = Date.parse(row.updated_at);
        return !Number.isFinite(updatedAt)
          || now - updatedAt >= RETRY_BACKOFF_MS * (2 ** Math.max(0, row.attempts - 1));
      })
      .sort((left, right) => left.id - right.id)[0];
    if (!next) return null;
    await this.db.update('memory_staging', { id: next.id }, {
      state: 'processing',
      attempts: next.attempts + 1,
      lease_started_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    return {
      ...next,
      state: 'processing',
      attempts: next.attempts + 1,
      lease_started_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
  }

  async hasPending(): Promise<boolean> {
    return (await this.db.query<MemoryStagingRow>('memory_staging', { state: 'pending' })).length > 0;
  }

  async release(stagingId: number): Promise<void> {
    await this.db.update('memory_staging', { id: stagingId }, {
      state: 'pending',
      lease_started_at: null,
      updated_at: new Date().toISOString(),
    });
  }

  async releaseCancellation(job: MemoryStagingRow): Promise<void> {
    await this.db.update('memory_staging', { id: job.id }, {
      state: 'pending',
      attempts: Math.max(0, job.attempts - 1),
      lease_started_at: null,
      updated_at: new Date().toISOString(),
    });
  }

  async fail(stagingId: number): Promise<void> {
    await this.db.failMemoryStaging(stagingId);
  }

  shouldRetry(job: MemoryStagingRow): boolean {
    return job.attempts < MAX_STAGING_ATTEMPTS;
  }

  async complete(
    stagingId: number,
    memory: CuratedMemoryWrite,
    policy: TurnPersistencePolicy,
  ): Promise<boolean> {
    const [staging] = await this.db.query<MemoryStagingRow>('memory_staging', { id: stagingId });
    if (!staging || mustKeepTurnTransient([staging.source_content, memory.content], policy)) {
      if (staging) await this.completeWithoutMemory(stagingId);
      return false;
    }
    if (containsUnconditionallyPrivateData(memory.content)) {
      await this.completeWithoutMemory(stagingId);
      return false;
    }
    await this.db.completeMemoryStaging({ stagingId, memory });
    return true;
  }

  async completeWithoutMemory(stagingId: number): Promise<void> {
    await this.db.discardMemoryStaging(stagingId);
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<CuratedMemoryRow[]> {
    const rows = await this.db.query<CuratedMemoryRow>('curated_memories');
    return rows
      .filter((row) => (options.includeDeleted || row.deleted_at == null)
        && !containsUnconditionallyPrivateData(row.content))
      .sort((left, right) => right.id - left.id);
  }

  async rememberExplicit(
    memory: CuratedMemoryWrite,
    policy: TurnPersistencePolicy,
  ): Promise<number | null> {
    const content = memory.content.trim();
    if (!content || mustKeepTurnTransient([content], policy)) return null;
    return this.db.insert('curated_memories', {
      source_staging_id: null,
      kind: 'explicit',
      content,
      source_conversation_id: memory.sourceConversationId,
      source_turn_id: memory.sourceTurnId,
      confidence: 1,
      deleted_at: null,
    });
  }

  async correct(id: number, content: string, policy: TurnPersistencePolicy): Promise<boolean> {
    const safe = content.trim();
    if (!safe || mustKeepTurnTransient([safe], policy)) return false;
    return (await this.db.update('curated_memories', { id }, {
      content: safe,
      updated_at: new Date().toISOString(),
    })) > 0;
  }

  async forget(id: number): Promise<boolean> {
    return (await this.db.update('curated_memories', { id }, {
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })) > 0;
  }

  async delete(id: number): Promise<boolean> {
    const deleted = await this.db.delete('curated_memories', { id });
    if (deleted > 0) await this.db.finalizePrivacyDeletion?.();
    return deleted > 0;
  }

  async deleteAll(expectedIds: readonly number[]): Promise<number> {
    if (!this.db.deleteAllCuratedMemories) {
      throw new Error('Storage provider does not support atomic curated-memory deletion');
    }
    return this.db.deleteAllCuratedMemories(expectedIds);
  }

  async applyPolicy(
    policy: TurnPersistencePolicy,
  ): Promise<{ turns: number; staging: number; memories: number; reminders: number }> {
    if (!policy.allowed) {
      return { turns: 0, staging: 0, memories: 0, reminders: 0 };
    }

    const messages = await this.db.query<MessageRow>('messages');
    const turns = new Map<string, MessageRow[]>();
    for (const message of messages) {
      const key = `${message.conversation_id}:${message.turn_id}`;
      const group = turns.get(key) ?? [];
      group.push(message);
      turns.set(key, group);
    }

    const stagingRows = await this.db.query<MemoryStagingRow>('memory_staging');
    const memories = await this.db.query<CuratedMemoryRow>('curated_memories');
    const reminders = await this.db.query<ReminderPolicyRow>('reminders');
    const [learnedFacts, persistentRules, sessionRules] = await Promise.all([
      this.db.query<LearnedFactRow>('learned_facts'),
      this.db.query<PersistentRuleRow>('persistent_rules'),
      this.db.query<SessionRuleRow>('session_rules'),
    ]);
    const purgedUnreadable = policy.exclusions.length > 0
      ? await this.db.purgeQuarantinedLayer2Memory()
      : { turns: 0, staging: 0, memories: 0, legacy: 0, quarantine: 0 };
    const purgedUnreadableReminders = policy.exclusions.length > 0
      && this.db.purgeQuarantinedReminders
      ? await this.db.purgeQuarantinedReminders()
      : 0;
    const purgedLegacy = policy.exclusions.length > 0
      ? await this.db.purgeLayer2LegacyMemory({
        learnedFactIds: learnedFacts
          .filter((row) => mustKeepTurnTransient([row.fact, row.category, row.source], policy))
          .map((row) => row.id),
        persistentRuleIds: persistentRules
          .filter((row) => mustKeepTurnTransient([row.rule, row.category], policy))
          .map((row) => row.id),
        sessionRuleIds: sessionRules
          .filter((row) => mustKeepTurnTransient([row.rule], policy))
          .map((row) => row.id),
      })
      : 0;
    const excludedSources = new Set<string>();
    const excludedStagingIds = new Set<number>();
    for (const rows of turns.values()) {
      if (!mustKeepTurnTransient(rows.map((row) => row.content), policy)) continue;
      excludedSources.add(`${rows[0].conversation_id}:${rows[0].turn_id}`);
    }
    for (const row of stagingRows) {
      const fingerprintMatch = fingerprintMatchesPolicy(row.policy_terms ?? '', policy);
      const sourceExcluded = mustKeepTurnTransient([row.source_content], policy);
      const missingCompletedProvenance = row.source_content === '' && fingerprintMatch === null;
      const excluded = sourceExcluded
        || fingerprintMatch === true
        || missingCompletedProvenance
        || excludedSources.has(`${row.conversation_id}:${row.turn_id}`);
      if (!excluded) {
        if (row.policy_terms && !row.policy_terms.startsWith(POLICY_FINGERPRINT_PREFIX)) {
          await this.db.update('memory_staging', { id: row.id }, {
            policy_terms: buildPolicyFingerprint(row.policy_terms),
            updated_at: new Date().toISOString(),
          });
        } else if (row.policy_terms.startsWith(POLICY_FINGERPRINT_PREFIX)
          && parsePolicyFingerprint(row.policy_terms) === null) {
          await this.db.update('memory_staging', { id: row.id }, {
            policy_terms: '',
            updated_at: new Date().toISOString(),
          });
        }
        continue;
      }
      excludedStagingIds.add(row.id);
      excludedSources.add(`${row.conversation_id}:${row.turn_id}`);
    }

    let deletedMemories = purgedUnreadable.memories + purgedLegacy;
    for (const row of memories) {
      const excludedByProvenance = (row.source_staging_id != null && excludedStagingIds.has(row.source_staging_id))
        || (row.source_conversation_id != null
          && excludedSources.has(`${row.source_conversation_id}:${row.source_turn_id}`));
      if (!excludedByProvenance && !mustKeepTurnTransient([row.content], policy)) continue;
      deletedMemories += await this.db.delete('curated_memories', { id: row.id });
    }

    let deletedTurns = purgedUnreadable.turns;
    for (const rows of turns.values()) {
      if (!excludedSources.has(`${rows[0].conversation_id}:${rows[0].turn_id}`)) continue;
      deletedTurns += (await this.db.deleteTurnMessages(rows[0].conversation_id, rows[0].turn_id)) > 0 ? 1 : 0;
    }

    let deletedStaging = purgedUnreadable.staging;
    for (const row of stagingRows) {
      if (!excludedStagingIds.has(row.id)) continue;
      deletedStaging += await this.db.delete('memory_staging', { id: row.id });
    }
    let deletedReminders = purgedUnreadableReminders;
    for (const reminder of reminders) {
      if (!mustKeepTurnTransient([reminder.text], policy)) continue;
      deletedReminders += await this.db.delete('reminders', { id: reminder.id });
    }
    const privacyRowsRemoved = deletedTurns > 0
      || deletedStaging > 0
      || deletedMemories > 0
      || deletedReminders > 0
      || purgedUnreadable.quarantine > 0
      || purgedLegacy > 0;
    if (privacyRowsRemoved) await this.db.finalizePrivacyDeletion?.();
    return {
      turns: deletedTurns,
      staging: deletedStaging,
      memories: deletedMemories,
      reminders: deletedReminders,
    };
  }
}
