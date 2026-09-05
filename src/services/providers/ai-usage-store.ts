import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { AiAuthKindSchema, AiProviderIdSchema, AiProviderOperationIdSchema, AiProviderRoleSchema,
  AiUsageRecordSchema, isAiOperationCompatible } from '../../core/ai-provider-contract.js';
import { SpecialistTaskUsageSchema } from '../../core/specialist-task.js';

const MAX_RECORDS = 10_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const EntrySchema = z.object({
  requestId: z.uuid(),
  checkpoint: z.enum(['terminal']),
  providerId: AiProviderIdSchema,
  operationId: AiProviderOperationIdSchema,
  role: AiProviderRoleSchema,
  authKind: AiAuthKindSchema,
  model: z.string().min(1).max(200).regex(/^[a-z0-9._:/-]+$/iu),
  recordedAt: z.iso.datetime({ offset: true }),
  usage: SpecialistTaskUsageSchema.optional(),
}).strict().superRefine((entry, context) => {
  if (!isAiOperationCompatible(entry.providerId, entry.role, entry.operationId)) {
    context.addIssue({ code: 'custom', message: 'Incompatible usage identity' });
  }
  if (entry.usage && !AiUsageRecordSchema.safeParse({ providerId: entry.providerId,
    role: entry.role, operationId: entry.operationId, model: entry.model,
    recordedAt: entry.recordedAt, ...entry.usage }).success) {
    context.addIssue({ code: 'custom', message: 'Invalid usage' });
  }
}).readonly();
const SnapshotSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(MAX_RECORDS) }).strict();
export type AiUsageEntry = z.infer<typeof EntrySchema>;
export type AiUsageInput = Omit<AiUsageEntry, 'recordedAt' | 'checkpoint'>;
export type AiUsageSink = (entry: AiUsageInput) => void;

/** One terminal cumulative checkpoint per app request; unknown usage is never recorded as zero. */
export class AiUsageStore {
  private readonly file: string;
  private entries: readonly AiUsageEntry[] = [];
  private healthy = true;
  constructor(directory: string, private readonly now: () => number = Date.now,
    private readonly beforePublish?: () => void) {
    this.file = path.join(directory, 'ai-usage.json');
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size > 24 * 1024 * 1024) throw new Error('oversized_usage');
      const parsed = SnapshotSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      const identities = new Set(parsed.entries.map((entry) => entry.requestId));
      if (identities.size !== parsed.entries.length) throw new Error('duplicate_usage');
      this.entries = this.retained(parsed.entries);
      if (this.entries.length !== parsed.entries.length) this.publish(this.entries);
    } catch { this.healthy = false; }
  }

  /** Fails independently of generation; callers must never retry paid work on false. */
  record(input: AiUsageInput): boolean {
    try {
      if (!this.healthy) return false;
      const parsed = EntrySchema.parse({ ...input, checkpoint: 'terminal', recordedAt: new Date(this.now()).toISOString() });
      if (this.entries.some((entry) => entry.requestId === parsed.requestId)) return true;
      const next = this.retained([...this.entries, parsed]);
      this.publish(next);
      this.entries = next;
      return true;
    } catch { return false; }
  }

  private publish(next: readonly AiUsageEntry[]): void {
    let temporary: string | undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      temporary = `${this.file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, entries: next }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.beforePublish?.();
      fs.renameSync(temporary, this.file);
    }
    finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Published or unavailable temporary file. */ } }
    }
  }

  /** Returns only bounded metadata; terminal checkpoints must not be interpreted as deltas. */
  list(): readonly AiUsageEntry[] { return this.retained(this.entries).map((entry) => structuredClone(entry)); }

  private retained(entries: readonly AiUsageEntry[]): readonly AiUsageEntry[] {
    const earliest = this.now() - RETENTION_MS;
    return entries.filter((entry) => Date.parse(entry.recordedAt) >= earliest)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)).slice(-MAX_RECORDS);
  }
}
