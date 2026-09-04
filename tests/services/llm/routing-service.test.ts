import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../src/services/llm/providers/ollama-provider.js';
import {
  ROUTER_DEADLINE_MS,
  ROUTER_NUM_CTX,
  ROUTER_NUM_PREDICT,
  RoutingService,
} from '../../../src/services/llm/routing-service.js';
import {
  createDecisionContext,
  type DecisionContext,
} from '../../../src/core/decision-context.js';

function decisionContext(): DecisionContext {
  const available = { state: 'available' as const, reason: 'ready' as const };
  const unavailable = { state: 'unavailable' as const, reason: 'no_adapter' as const };
  return createDecisionContext({
    version: 1,
    turn: {
      turnId: 'routing-test-turn',
      mode: 'chat',
      privateContext: false,
      inputOrigin: { kind: 'user_text' },
    },
    programRoles: [{ role: 'code_editor', programName: 'Visual Studio Code' }],
    preferredSourceHints: [{ id: 'booking', description: 'Hotels und Unterkünfte' }],
    capabilities: {
      lifecycleGeneration: 7,
      modelExecutionMode: 'exclusive',
      router: available,
      localAnswer: available,
      actions: available,
      webSearch: available,
      visibleBrowserResult: { state: 'unavailable', reason: 'no_visible_result' },
      reminders: available,
      media: { state: 'unknown', reason: 'no_readiness_source' },
      specialists: {
        coding: unavailable,
        research: unavailable,
        vision: unavailable,
      },
    },
  });
}

describe('RoutingService productive request contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends the tag-only output cap through the real Ollama options path', async () => {
    let requestBody: Record<string, object | string | boolean> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const frame = `${JSON.stringify({ message: { content: '[ROUTE:9b]' }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
      { num_predict: 12_000, temperature: 0.9, num_ctx: ROUTER_NUM_CTX },
    ));

    const result = await routing.route('Erkläre mir, warum der Himmel blau ist.');

    expect(result).toMatchObject({ parsed: { kind: 'route', route: '9b' }, hadTag: true });
    expect(result.outputKind).toBe('legacy');
    expect(requestBody).toMatchObject({
      model: 'phi4-mini:3.8b',
      stream: true,
      think: false,
      keep_alive: -1,
      options: {
        num_predict: ROUTER_NUM_PREDICT,
        temperature: 0,
        num_ctx: ROUTER_NUM_CTX,
      },
    });
  });

  it('recognizes a valid bounded proposal and includes only minimized decision context', async () => {
    let requestBody: { messages?: Array<{ role: string; content: string }> } = {};
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"Stelle einen Timer auf 10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const frame = `${JSON.stringify({ message: { content: proposal }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
    ));

    const result = await routing.route(
      'Stelle einen Timer auf 10 Minuten und erkläre Fahrräder',
      decisionContext(),
    );

    expect(result).toMatchObject({
      outputKind: 'proposal',
      proposalOutput: proposal,
      parsed: { kind: 'route', route: '9b' },
      hadTag: false,
    });
    const systemPrompt = requestBody.messages?.[0]?.content ?? '';
    expect(systemPrompt).toContain('SARAH_PROPOSAL_V1');
    expect(systemPrompt).toContain('Visual Studio Code');
    expect(systemPrompt).toContain('Hotels und Unterkünfte');
    expect(systemPrompt).not.toContain('routing-test-turn');
    expect(systemPrompt).not.toContain('lifecycleGeneration');
    expect(systemPrompt).not.toContain('no_adapter');
  });

  it('marks malformed proposal output without interpreting a trailing legacy action', async () => {
    const response = 'SARAH_PROPOSAL_V1 {"intents":[]} [ACTION:open_program:secret.exe]';
    vi.stubGlobal('fetch', vi.fn(async () => {
      const frame = `${JSON.stringify({ message: { content: response }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
    ));

    const result = await routing.route('Öffne etwas und erkläre etwas', decisionContext());

    expect(result).toMatchObject({
      outputKind: 'invalid_proposal',
      parsed: { kind: 'route', route: '9b' },
      hadTag: false,
    });
    expect(result.proposalOutput).toBeUndefined();
  });

  it('never logs raw proposal evidence or output', async () => {
    const sensitiveEvidence = 'erkläre Projekt Ultra-Geheim';
    const proposal = `SARAH_PROPOSAL_V1 {"intents":[{"kind":"answer","evidence":"${sensitiveEvidence}"},{"kind":"answer","evidence":"sage nur okay"}]}`;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const frame = `${JSON.stringify({ message: { content: proposal }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
    ));

    await routing.route(`${sensitiveEvidence} und sage nur okay`, decisionContext());

    const logged = log.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('PROPOSAL');
    expect(logged).not.toContain(sensitiveEvidence);
    expect(logged).not.toContain(proposal);
  });

  it('fits the complete routing prompt plus the maximum accepted user message', async () => {
    let requestBody: { messages?: Array<{ role: string; content: string }>; options?: { num_ctx?: number } } = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const frame = `${JSON.stringify({ message: { content: '[ROUTE:9b]' }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
      { num_ctx: ROUTER_NUM_CTX },
    ));
    const userText = 'x'.repeat(4_000);

    await expect(routing.route(userText)).resolves.toMatchObject({
      parsed: { kind: 'route', route: '9b' },
    });

    expect(requestBody.messages?.at(-1)).toEqual({ role: 'user', content: userText });
    expect(requestBody.options?.num_ctx).toBe(ROUTER_NUM_CTX);
  });

  it('aborts a streaming router classification at its hard total deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const routing = new RoutingService(
      new OllamaProvider('http://localhost:11434', 'phi4-mini:3.8b'),
    );
    const result = routing.route('Erkläre den Himmel.');
    const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(ROUTER_DEADLINE_MS);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
