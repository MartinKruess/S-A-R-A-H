import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RouterService, type RouterServiceOptions } from '../../../src/services/llm/router-service.js';
import { bootstrap } from '../../../src/core/bootstrap.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { LlmProvider, ChatMessage } from '../../../src/services/llm/llm-provider.interface.js';
import type { ApplyMemoryAuthorDeltaInput, ApplyMemoryAuthorDeltaResult, CompleteMemoryStagingInput, StorageProvider, Filter, MessageRow, MessagesPageQuery, TurnMessageWrite, Layer2MemoryPurgeResult } from '../../../src/core/storage/storage.interface.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { START_CONTEXT_HEADER } from '../../../src/services/llm/context-window.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageBus } from '../../../src/core/message-bus.js';
import { MediaContext } from '../../../src/services/llm/media-context.js';
import type { TurnRequest } from '../../../src/core/turn-contract.js';
import {
  ActionConfirmationGate,
} from '../../../src/core/action-confirmation.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../../src/core/chat-availability.js';
import { ModelRuntime } from '../../../src/services/llm/model-runtime.js';
import type { SarahService } from '../../../src/core/service.interface.js';
import type { ServiceStatus } from '../../../src/core/types.js';
import {
  BlockingProvider,
  FakeProvider,
  FailingAfterWarmupProvider,
  FailingMidstreamProvider,
  FailingStorage,
  RecoveringProvider,
  ScriptedProvider,
  StubActionService,
  StubVoiceService,
  UnavailableProvider,
  startAction,
} from './router-service-test-harness.js';

describe('RouterService (memory commands & recall)', () => {
  let tmpDir: string;
  let ctx: AppContext;
  let router: RouterService | null = null;
  let workerProvider: FakeProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-'));
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 94) });
    ctx.registry.register(new StubActionService());
    workerProvider = new FakeProvider();
    router = null;
  });

  afterEach(async () => {
    await router?.destroy();
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRouter(context: AppContext, options: RouterServiceOptions = {}): RouterService {
    router = new RouterService(
      context,
      new FakeProvider('warm'),
      workerProvider,
      new MediaContext(),
      options,
    );
    return router;
  }

  /** Drives a full chat turn through the worker path (bypasses 2B routing). */
  async function chatTurn(
    r: RouterService,
    text: string,
    mode: 'chat' | 'voice' = 'chat',
  ): Promise<void> {
    r.activeModel = '9b';
    await r.handleChatMessage(text, mode);
  }

  it('supports explicit memory commands through the author and preserves auditable evidence', async () => {
    ctx.parsedConfig.trust.showContextEnabled = true;
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    await r.init();

    await chatTurn(r, 'Merk dir: Mein Lieblingsplanet ist Saturn.');
    const [stored] = await ctx.db.query<{
      id: number; content: string; source_turn_id: string; revision: number; status: string;
    }>('curated_memories');
    expect(stored.content).toBe('Mein Lieblingsplanet ist Saturn.');
    expect(stored).toMatchObject({ revision: 1, status: 'active' });
    expect(await ctx.db.query('memory_sources', { memory_id: stored.id })).toEqual([
      expect.objectContaining({ source_turn_id: stored.source_turn_id, source_type: 'turn' }),
    ]);

    await chatTurn(r, '/showcontext');
    expect(outputs.at(-1)).toContain('## Allgemein');
    expect(outputs.at(-1)).toContain(`${stored.id} [fact, active, Revision 1]`);
    expect(outputs.at(-1)).toContain('Quelle: Session');

    await chatTurn(r, `/correctmemory ${stored.id} Mein Lieblingsplanet ist Jupiter.`);
    await chatTurn(r, '/exportmemory');
    expect(outputs.at(-1)).toContain('Jupiter');
    expect(outputs.at(-1)).toContain('source');
    expect(outputs.at(-1)).toContain('"revision": 2');
    expect(outputs.at(-1)).toContain('"evidence"');

    await chatTurn(r, `/forget ${stored.id}`);
    const forgotten = await ctx.db.query<{ deleted_at: string | null }>('curated_memories', { id: stored.id });
    expect(forgotten[0].deleted_at).not.toBeNull();
    await chatTurn(r, '/showcontext');
    expect(outputs.at(-1)).toContain(`${stored.id} [fact, deleted, Revision 2]`);
    await chatTurn(r, `/deletememory ${stored.id}`);
    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('stores only custom-command arguments as explicit memory content', async () => {
    ctx.parsedConfig.controls.customCommands = [
      { command: '/notiz', prompt: 'Merke dir folgende Notiz' },
    ];
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/notiz Kunde Meyer zahlt erst im Oktober');

    const memories = await ctx.db.query<{ content: string }>('curated_memories');
    expect(memories.map((memory) => memory.content)).toEqual([
      'Kunde Meyer zahlt erst im Oktober',
    ]);
    expect(memories[0].content).not.toContain('Zusätzliche Argumente des Nutzers');
  });

  it('reconciles explicit duplicates and clear revisions without claiming success on model failure', async () => {
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    await r.init();
    const candidate = (content: string, evidence = content): string => JSON.stringify({
      decision: 'candidate',
      kind: 'preference',
      topic: 'Schach',
      content,
      evidence,
      searchTerms: ['Schach'],
      durability: 'stable',
      confidence: 0.95,
    });

    workerProvider.queueMemoryAuthorReplies(
      candidate('Martin spielt gern Schach.', 'Ich spiele gern Schach.'),
      JSON.stringify({ action: 'add', topic: null, targets: [] }),
    );
    await chatTurn(r, '/remember Ich spiele gern Schach.');
    const [first] = await ctx.db.query<{ id: number; revision: number }>('curated_memories');
    expect(outputs.at(-1)).toContain('thematisch eingeordnet');

    workerProvider.queueMemoryAuthorReplies(
      candidate('Martin spielt gern Schach.', 'Schach spiele ich wirklich gern.'),
      JSON.stringify({
        action: 'ignore',
        topic: { id: 1, version: 1 },
        targets: [{ id: first.id, revision: first.revision }],
      }),
    );
    await chatTurn(r, '/remember Schach spiele ich wirklich gern.');
    expect(await ctx.db.query('curated_memories')).toHaveLength(1);
    expect(outputs.at(-1)).toContain('kein Duplikat');

    workerProvider.queueMemoryAuthorReplies(
      candidate('Martin spielt nicht mehr gern Schach.', 'Mittlerweile spiele ich nicht mehr gern Schach.'),
      JSON.stringify({
        action: 'supersede',
        topic: { id: 1, version: 1 },
        targets: [{ id: first.id, revision: first.revision }],
      }),
    );
    await chatTurn(r, '/remember Mittlerweile spiele ich nicht mehr gern Schach.');
    expect(await ctx.db.query('curated_memories', { status: 'active' })).toEqual([
      expect.objectContaining({ content: 'Martin spielt nicht mehr gern Schach.', revision: 2 }),
    ]);
    expect(await ctx.db.query('curated_memories', { status: 'superseded' })).toEqual([
      expect.objectContaining({ id: first.id, superseded_by_id: expect.any(Number) }),
    ]);
    expect(outputs.at(-1)).toContain('ersetzt die veraltete Aussage');

    workerProvider.queueMemoryAuthorReplies('kein-json');
    await chatTurn(r, '/remember Ich sammle Schachbretter.');
    expect(await ctx.db.query('curated_memories')).toHaveLength(2);
    expect(outputs.at(-1)).toContain('keine neue Erinnerung bestätigt');
    expect(outputs.at(-1)).not.toContain('wurde gespeichert');
  });

  it('recalls active memories only and prioritizes a topic-title match over content-only overlap', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    const chessTopic = await ctx.db.insert('memory_topics', { title: 'Schach', version: 1 });
    const otherTopic = await ctx.db.insert('memory_topics', { title: 'Freizeit', version: 1 });
    await ctx.db.insert('curated_memories', {
      topic_id: chessTopic, kind: 'preference', content: 'Martin bevorzugt die Sizilianische Verteidigung.',
      evidence: 'Ich bevorzuge die Sizilianische Verteidigung.', source_conversation_id: 1,
      source_turn_id: 'active-chess', confidence: 1, status: 'active', revision: 1,
      created_by_action: 'add',
    });
    await ctx.db.insert('curated_memories', {
      topic_id: chessTopic, kind: 'preference', content: 'Diese alte Schach-Aussage darf nicht erscheinen.',
      evidence: 'alte Aussage', source_conversation_id: 1, source_turn_id: 'old-chess', confidence: 1,
      status: 'superseded', revision: 1, created_by_action: 'add',
    });
    await ctx.db.insert('curated_memories', {
      topic_id: otherTopic, kind: 'episode', content: 'Ein langer Bericht über Schach und Schachturniere.',
      evidence: 'Bericht über Schach', source_conversation_id: 1, source_turn_id: 'content-only',
      confidence: 1, status: 'active', revision: 1, created_by_action: 'add',
    });
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Was weißt du über Schach?');

    const recalled = (workerProvider.lastMessages ?? [])
      .filter(({ content }) => content.startsWith('SARAH_DATA recalled_memory_data'));
    expect(recalled).toHaveLength(2);
    expect(recalled[0].content).toContain('"topic":"Schach"');
    expect(recalled.some(({ content }) => content.includes('alte Schach-Aussage'))).toBe(false);
  });

  it('refuses to persist an assistant output without an active turn draft', async () => {
    const r = makeRouter(ctx);
    await r.init();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await (r as unknown as {
      emitAssistantResponse(turnId: string, text: string): Promise<void>;
    }).emitAssistantResponse('orphan-output-turn', 'Nicht zu persistierende Ausgabe');

    expect(await ctx.db.query('messages')).toEqual([]);
    expect(r.liveHistoryTurnCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[Router] Refused to record assistant output without an active turn draft',
    );
  });

  it('requires an explicit confirmation before deleting all curated memories', async () => {
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    await r.init();
    await chatTurn(r, '/remember Erste Erinnerung');
    await chatTurn(r, '/remember Zweite Erinnerung');

    await chatTurn(r, '/deletememory all');
    expect(await ctx.db.query('curated_memories')).toHaveLength(2);
    expect(outputs.at(-1)).toContain('/deletememory all bestätigen');

    await chatTurn(r, '/deletememory all abbrechen');
    expect(await ctx.db.query('curated_memories')).toHaveLength(2);
    expect(outputs.at(-1)).toContain('abgebrochen');

    await chatTurn(r, '/deletememory all');
    await chatTurn(r, '/deletememory all bestätigen');
    expect(await ctx.db.query('curated_memories')).toEqual([]);
    expect(outputs.at(-1)).toContain('2 kuratierte Erinnerungen wurden endgültig gelöscht');
  });

  it('does not delete a memory created after delete-all confirmation was requested', async () => {
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    await r.init();
    await chatTurn(r, '/remember Bereits vorhanden');
    await chatTurn(r, '/deletememory all');
    await chatTurn(r, '/remember Neu hinzugekommen');

    await chatTurn(r, '/deletememory all bestätigen');

    expect(await ctx.db.query('curated_memories')).toHaveLength(2);
    expect(outputs.at(-1)).toContain('Es wurde nichts gelöscht');
  });

  it('marks showcontext and exportmemory as visual-only but leaves normal replies at default speech', async () => {
    ctx.parsedConfig.trust.showContextEnabled = true;
    const r = makeRouter(ctx);
    const speechPolicies: BusEvents['turn:output-policy'][] = [];
    ctx.bus.on('turn:output-policy', (message) => speechPolicies.push(message.data));
    await r.init();

    await chatTurn(r, '/showcontext', 'voice');
    await chatTurn(r, '/exportmemory', 'voice');
    await chatTurn(r, 'Erzähle mir etwas Kurzes.', 'voice');

    expect(speechPolicies).toHaveLength(2);
    expect(speechPolicies.every((policy) => policy.speech === 'suppress')).toBe(true);
    expect(new Set(speechPolicies.map((policy) => policy.turnId)).size).toBe(2);
  });

  it('does not treat a normal file-save request or meaningless pronoun as memory', async () => {
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Speichere die Datei im Dokumente-Ordner.');
    await chatTurn(r, 'Merk dir das');

    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('does not allow explicit memory commands to bypass configured exclusions', async () => {
    ctx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/remember Meine Bank ist Beispielbank.');
    await chatTurn(r, 'Merk dir: Meine Bank ist Beispielbank.');

    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('does not allow direct /remember to bypass normalized env-secret labels', async () => {
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/remember OPENAI_API\u200B_KEY=abc-123');

    expect(await ctx.db.query('curated_memories')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
  });

  it('bounds live history to the newest 24 turns', async () => {
    const r = makeRouter(ctx);
    await r.init();
    for (let index = 0; index < 30; index += 1) {
      await chatTurn(r, `Frage ${index}`);
    }
    expect(r.liveHistoryTurnCount).toBe(24);
  });

  it('keeps a complete turn transient when user text or assistant output matches an exclusion', async () => {
    ctx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Mein Kontostand ist vertraulich');

    expect(await ctx.db.query('messages')).toHaveLength(0);
  });

  it('applies changed exclusions and pauses memory without deleting retained data', async () => {
    const r = makeRouter(ctx);
    await r.init();
    await chatTurn(r, 'Mein Hobby ist Musik.');
    await chatTurn(r, 'Meine Bank hat mein Konto gesperrt.');
    expect(await ctx.db.query('messages')).toHaveLength(4);

    await r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    let messages = await ctx.db.query<{ content: string }>('messages');
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.content.includes('Bank'))).toBe(false);

    await r.applyMemoryPolicy({ allowed: false, exclusions: [] });
    messages = await ctx.db.query<{ content: string }>('messages');
    expect(messages).toHaveLength(2);
    expect(await ctx.db.query('memory_staging')).toHaveLength(1);
    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('exposes the authoritative incognito state for renderer reload recovery', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    await r.init();

    expect(r.privacyState).toEqual({ incognitoActive: false });
    await chatTurn(r, '/anonymous');
    expect(r.privacyState).toEqual({ incognitoActive: true });
    await chatTurn(r, '/anonymous');
    expect(r.privacyState).toEqual({ incognitoActive: false });
  });

});
