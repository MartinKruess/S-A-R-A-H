import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiUsageStore, type AiUsageInput } from '../../../src/services/providers/ai-usage-store.js';
import { selectCloudText } from '../../../src/services/providers/cloud-text-service.js';
import type { AiProviderHubService } from '../../../src/services/integrations/ai-provider-hub-service.js';
import { TextGenerationError } from '../../../src/services/providers/text-generation-adapter.js';

const directories: string[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-usage-')); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 0, toolCalls: 0 };
function entry(): AiUsageInput { return { requestId: randomUUID(), providerId: 'openai', operationId: 'openai_responses_text',
  role: 'text', authKind: 'api_key', model: 'gpt-4.1-mini', usage }; }

describe('metadata usage store', () => {
  it('reloads partially known Anthropic usage without inventing reasoning or cache reads', () => {
    const dir = directory();
    const partial = { inputTokens: 15, outputTokens: 3, cacheWriteInputTokens: 5 };
    expect(new AiUsageStore(dir).record({ ...entry(), providerId: 'anthropic',
      operationId: 'anthropic_messages_text', model: 'claude-test', usage: partial })).toBe(true);
    expect(new AiUsageStore(dir).list()[0].usage).toEqual(partial);
  });

  it('persists a single cumulative terminal checkpoint and preserves unknown usage', () => {
    const dir = directory(); const store = new AiUsageStore(dir); const input = entry();
    expect(store.record(input)).toBe(true);
    expect(store.record({ ...input, usage: { ...usage, outputTokens: 100 } })).toBe(true);
    expect(store.record({ ...entry(), usage: undefined })).toBe(true);
    const records = new AiUsageStore(dir).list();
    expect(records).toHaveLength(2);
    expect(records[0].usage?.outputTokens).toBe(3);
    expect(records[1].usage).toBeUndefined();
  });
  it('rotates by count and age without keeping prompt/result fields', () => {
    const dir = directory(); const now = Date.now();
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ ...entry(), checkpoint: 'terminal', recordedAt: new Date(now - index * 1000).toISOString() }));
    fs.writeFileSync(path.join(dir, 'ai-usage.json'), JSON.stringify({ version: 1, entries }));
    const store = new AiUsageStore(dir, () => now);
    expect(store.record(entry())).toBe(true);
    expect(store.list()).toHaveLength(10_000);
    expect(new AiUsageStore(dir, () => now + 91 * 24 * 60 * 60_000).list()).toHaveLength(0);
    expect(store.record({ ...entry(), prompt: 'secret' } as AiUsageInput)).toBe(false);
  });
  it('preserves published metadata on disk failure and refuses corrupt input', () => {
    const dir = directory(); const first = new AiUsageStore(dir); first.record(entry());
    const file = path.join(dir, 'ai-usage.json'); const original = fs.readFileSync(file, 'utf8');
    const faulted = new AiUsageStore(dir, Date.now, () => { throw new Error('disk'); });
    expect(faulted.record(entry())).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['ai-usage.json']);
    fs.writeFileSync(file, 'broken');
    expect(new AiUsageStore(dir).record(entry())).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('broken');
  });
});

describe('cloud text accounting', () => {
  function hub() {
    const binding = { bindingId: randomUUID(), revision: 1, credentialGeneration: 1, connectionId: randomUUID(),
      operationId: 'openai_responses_text', providerId: 'openai', modelId: 'gpt-4.1-mini', authKind: 'api_key' };
    return { resolveBinding: () => binding, resolveCredential: () => 'key' } as AiProviderHubService;
  }
  it('records successful usage without letting sink failure discard or rerun output', async () => {
    const generate = vi.fn(async () => ({ fullText: 'Answer', status: 'completed' as const, usage }));
    const sink = vi.fn(() => { throw new Error('disk'); });
    const run = selectCloudText(hub(), new Map([['openai_responses_text', { generate }]]), sink)!;
    expect((await run('secret prompt', new AbortController().signal, vi.fn())).fullText).toBe('Answer');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1-mini', usage }));
    expect(JSON.stringify(sink.mock.calls)).not.toContain('secret prompt');
  });
  it('records partial usage on failed output and unknown usage on transport failure', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new TextGenerationError({ fullText: 'Part', status: 'incomplete', usage }))
      .mockRejectedValueOnce(new Error('transport'));
    const sink = vi.fn();
    const run = selectCloudText(hub(), new Map([['openai_responses_text', { generate }]]), sink)!;
    await run('secret', new AbortController().signal, vi.fn());
    await run('secret', new AbortController().signal, vi.fn());
    expect(sink.mock.calls[0][0].usage).toEqual(usage);
    expect(sink.mock.calls[1][0].usage).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
