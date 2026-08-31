import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildContextWindow,
  START_CONTEXT_HEADER,
  CHARS_PER_TOKEN,
  RESPONSE_SAFETY_TOKENS,
  CHAT_TEMPLATE_BASE_TOKENS,
  CHAT_TEMPLATE_MESSAGE_TOKENS,
  MIN_EFFECTIVE_NUM_PREDICT,
  estimateTokens,
} from './context-window.js';
import type { ChatMessage } from './llm-provider.interface.js';
import { SarahConfigSchema } from '../../core/config-schema.js';
import {
  appendRuntimeTrustInstructions,
  buildSystemPrompt,
  MIN_CURRENT_USER_PROMPT_TOKENS,
} from './prompt-builder.js';
import { NUM_PREDICT_MAP } from './llm-types.js';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

/** ASCII helper matching the fail-safe byte upper bound. */
function chars(tokens: number): string {
  return 'x'.repeat(tokens * CHARS_PER_TOKEN);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildContextWindow', () => {
  it('keeps the default medium response cap when the protected prompt fits at num_ctx 4096', () => {
    const config = SarahConfigSchema.parse({});
    const systemPrompt = buildSystemPrompt(config, 'chat');
    const current = msg('user', 'Hallo Sarah.');
    const plan = buildContextWindow({
      systemPrompt,
      startContext: [],
      history: [current],
      numCtx: 4096,
      numPredict: NUM_PREDICT_MAP.mittel,
    }, { includeEffectiveNumPredict: true });

    expect(plan.messages.at(-1)).toEqual(current);
    expect(plan.numPredict).toBe(NUM_PREDICT_MAP.mittel);
  });

  it.each(['mittel', 'ausführlich'] as const)(
    'reduces a full-profile %s response only as far as the protected prompt requires',
    (responseStyle) => {
      const config = SarahConfigSchema.parse({
        profile: {
          displayName: 'Martin',
          lastName: 'Mustermann',
          city: 'Berlin',
          address: 'Beispielstraße 42',
          postalCode: '10115',
          birthday: '1990-03-15',
          email: 'martin@example.test',
          profession: 'Softwareentwickler und Designer',
          activities: 'Entwickelt Desktop-Anwendungen und gestaltet Bedienoberflächen',
          usagePurposes: ['Programmieren', 'Recherche', 'Organisation'],
          hobbies: ['Gaming', 'Fotografie'],
          linkPreferences: Array.from({ length: 5 }, (_, index) => ({
            description: `Bevorzugte Quelle ${index + 1}`,
            url: `https://example.test/${index + 1}`,
          })),
        },
        skills: {
          programming: 'Fortgeschritten',
          programmingStack: ['TypeScript', 'React', 'Node.js'],
          programmingResources: ['MDN', 'TypeScript Handbook'],
          programmingProjectsFolder: 'G:\\Projects',
          design: 'Fortgeschritten',
          office: 'Fortgeschritten',
        },
        personalization: {
          responseStyle,
          responseMode: 'thoughtful',
          tone: 'freundlich',
          characterTraits: ['Humorvoll', 'Direkt', 'Geduldig'],
          quirk: 'Verwendet gelegentlich trockenen Humor',
        },
        trust: {
          memoryExclusions: ['Finanzen', 'Gesundheit'],
        },
      });
      const systemPrompt = buildSystemPrompt(config, 'chat');
      const current = msg('user', 'Hallo Sarah.');
      const requested = NUM_PREDICT_MAP[responseStyle];
      const availableForResponse = 4096
        - RESPONSE_SAFETY_TOKENS
        - CHAT_TEMPLATE_BASE_TOKENS
        - estimateTokens(systemPrompt)
        - CHAT_TEMPLATE_MESSAGE_TOKENS
        - estimateTokens(current.content)
        - CHAT_TEMPLATE_MESSAGE_TOKENS;

      const plan = buildContextWindow({
        systemPrompt,
        startContext: [],
        history: [current],
        numCtx: 4096,
        numPredict: requested,
      }, { includeEffectiveNumPredict: true });

      expect(plan.messages).toEqual([msg('system', systemPrompt), current]);
      expect(plan.numPredict).toBe(Math.min(requested, availableForResponse));
      expect(plan.numPredict).toBeGreaterThanOrEqual(MIN_EFFECTIVE_NUM_PREDICT);
      expect(plan.numPredict).toBeLessThan(requested);
    },
  );

  it('assembles [system, header, startContext..., history...] when the budget is large', () => {
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [msg('user', 'alte Frage'), msg('assistant', 'alte Antwort')],
      history: [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')],
      numCtx: 8192,
      numPredict: 1600,
    });

    expect(result.map((m) => m.content)).toEqual([
      'SYS', START_CONTEXT_HEADER, 'alte Frage', 'alte Antwort', 'q1', 'a1', 'q2',
    ]);
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('system');
    expect(result[2].role).toBe('user');
    expect(result[3].role).toBe('assistant');
  });

  it('omits the header when there is no start context', () => {
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [],
      history: [msg('user', 'hallo')],
      numCtx: 8192,
      numPredict: 1600,
    });

    expect(result.map((m) => m.content)).toEqual(['SYS', 'hallo']);
  });

  it('keeps a pre-framed recalled-data system block atomic without adding another header', () => {
    const framed = `${START_CONTEXT_HEADER}\nSARAH_DATA recalled_memory_data {"content":"alte Erinnerung"}`;
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [msg('system', framed)],
      history: [msg('user', 'Was weißt du noch?')],
      numCtx: 2048,
      numPredict: 100,
    });

    expect(result).toEqual([
      msg('system', 'SYS'),
      msg('system', framed),
      msg('user', 'Was weißt du noch?'),
    ]);
    expect(result.filter((message) => message.content === START_CONTEXT_HEADER)).toHaveLength(0);
    expect(result.some((message) => message.role === 'assistant')).toBe(false);
  });

  it('derives the budget from numCtx and numPredict', () => {
    const template = CHAT_TEMPLATE_BASE_TOKENS + (4 * CHAT_TEMPLATE_MESSAGE_TOKENS);
    const input = {
      systemPrompt: '',
      startContext: [] as ChatMessage[],
      history: [msg('user', chars(3)), msg('assistant', chars(5)), msg('user', chars(5))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + template + 13,
    };
    expect(buildContextWindow(input)).toHaveLength(4); // system + complete old turn + current

    // One token less → the older message no longer fits.
    const tight = buildContextWindow({ ...input, numCtx: input.numCtx - 1 });
    expect(tight).toHaveLength(2); // system + current only
    expect(tight[1].content).toBe(chars(5));
  });

  it('reduces the requested answer cap before dropping relevant live history', () => {
    const system = msg('system', 'SYS');
    const current = msg('user', chars(2));
    const older = [msg('user', chars(10)), msg('assistant', chars(10))];
    const protectedTokens = RESPONSE_SAFETY_TOKENS
      + CHAT_TEMPLATE_BASE_TOKENS
      + estimateTokens(system.content) + CHAT_TEMPLATE_MESSAGE_TOKENS
      + estimateTokens(current.content) + CHAT_TEMPLATE_MESSAGE_TOKENS;
    const plan = buildContextWindow({
      systemPrompt: system.content,
      startContext: [],
      history: [...older, current],
      numCtx: protectedTokens + 1_000,
      numPredict: 1_000,
    }, { includeEffectiveNumPredict: true });

    expect(plan.messages).toEqual([system, ...older, current]);
    expect(plan.numPredict).toBeLessThan(1_000);
    expect(plan.numPredict).toBeGreaterThanOrEqual(MIN_EFFECTIVE_NUM_PREDICT);
  });

  it('keeps smaller high-priority recall entries when one entry exceeds the remaining budget', () => {
    const header = msg('system', START_CONTEXT_HEADER);
    const oversized = msg('system', chars(400));
    const compact = msg('system', chars(10));
    const current = msg('user', chars(2));
    const protectedTokens = RESPONSE_SAFETY_TOKENS
      + CHAT_TEMPLATE_BASE_TOKENS
      + estimateTokens('SYS') + CHAT_TEMPLATE_MESSAGE_TOKENS
      + estimateTokens(current.content) + CHAT_TEMPLATE_MESSAGE_TOKENS;
    const recallTokens = estimateTokens(header.content) + CHAT_TEMPLATE_MESSAGE_TOKENS
      + estimateTokens(compact.content) + CHAT_TEMPLATE_MESSAGE_TOKENS;
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [header, oversized, compact],
      history: [current],
      numCtx: protectedTokens + MIN_EFFECTIVE_NUM_PREDICT + recallTokens,
      numPredict: 1_600,
    });

    expect(result).toEqual([msg('system', 'SYS'), header, compact, current]);
  });

  it('bounds configuration-derived system data while keeping essential instructions', () => {
    const marker = 'OVERSIZED_PROFILE_MARKER';
    const config = SarahConfigSchema.parse({
      profile: {
        displayName: marker,
        usagePurposes: Array.from({ length: 20 }, () => 'x'.repeat(200)),
        hobbies: Array.from({ length: 20 }, () => 'y'.repeat(200)),
        linkPreferences: Array.from({ length: 20 }, (_, index) => ({
          description: `z${index}`.repeat(100),
          url: `https://example.test/${'u'.repeat(180)}${index}`,
        })),
      },
      personalization: {
        characterTraits: Array.from({ length: 20 }, () => 't'.repeat(200)),
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = buildSystemPrompt(config, 'chat');
    const maximum = config.llm.workerOptions.num_ctx
      - RESPONSE_SAFETY_TOKENS
      - CHAT_TEMPLATE_BASE_TOKENS
      - (2 * CHAT_TEMPLATE_MESSAGE_TOKENS)
      - MIN_EFFECTIVE_NUM_PREDICT
      - MIN_CURRENT_USER_PROMPT_TOKENS;

    expect(estimateTokens(prompt)).toBeLessThanOrEqual(maximum);
    expect(prompt).toContain('You are Sarah, a desktop assistant.');
    expect(prompt).toContain('You MUST write your answer in German.');
    expect(prompt).not.toContain(marker);
    expect(warn).toHaveBeenCalled();

    const protectedPrompt = appendRuntimeTrustInstructions(prompt, {
      external: true,
      local: true,
    });
    expect(() => buildContextWindow({
      systemPrompt: protectedPrompt,
      startContext: [],
      history: [msg('user', chars(MIN_CURRENT_USER_PROMPT_TOKENS))],
      numCtx: config.llm.workerOptions.num_ctx,
      numPredict: MIN_EFFECTIVE_NUM_PREDICT,
    })).not.toThrow();
  });

  it('drops start context before live history', () => {
    // budget = 10: live history (4 + 4 = 8) fits, header+startContext does not.
    const result = buildContextWindow({
      systemPrompt: '',
      startContext: [msg('user', chars(2))],
      history: [msg('user', chars(2)), msg('assistant', chars(2)), msg('user', chars(4))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS
        + CHAT_TEMPLATE_BASE_TOKENS + (4 * CHAT_TEMPLATE_MESSAGE_TOKENS) + 10,
    });

    // live history survives fully; header + start context did not fit → dropped entirely
    expect(result.map((m) => m.content)).toEqual(['', chars(2), chars(2), chars(4)]);
    expect(result.some((m) => m.content === START_CONTEXT_HEADER)).toBe(false);
  });

  it('trims start context oldest-first', () => {
    const headerTokens = estimateTokens(START_CONTEXT_HEADER) + CHAT_TEMPLATE_MESSAGE_TOKENS;
    // budget: current (2) + header + newest start msg (3) — older start msg (5) must fall off.
    const result = buildContextWindow({
      systemPrompt: '',
      startContext: [
        msg('user', chars(2)), msg('assistant', chars(3)),
        msg('user', chars(1)), msg('assistant', chars(2)),
      ],
      history: [msg('user', chars(2))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + CHAT_TEMPLATE_BASE_TOKENS
        + (4 * CHAT_TEMPLATE_MESSAGE_TOKENS) + 2 + headerTokens + 3,
    });

    expect(result.map((m) => m.content)).toEqual([
      '', START_CONTEXT_HEADER, chars(1), chars(2), chars(2),
    ]);
  });

  it('never retains an assistant message without the user message of its turn', () => {
    const result = buildContextWindow({
      systemPrompt: '',
      startContext: [],
      history: [
        msg('user', chars(6)), msg('assistant', chars(2)),
        msg('user', chars(2)), msg('assistant', chars(2)),
        msg('user', chars(2)),
      ],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + CHAT_TEMPLATE_BASE_TOKENS
        + (4 * CHAT_TEMPLATE_MESSAGE_TOKENS) + 6,
    });
    expect(result.map((message) => message.content)).toEqual([
      '', chars(2), chars(2), chars(2),
    ]);
  });

  it('keeps an interrupted user-only turn as context for the current follow-up', () => {
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [],
      history: [
        msg('user', 'Erkläre die Relativitätstheorie ausführlich'),
        msg('user', 'Erzähl mir mehr dazu'),
      ],
      numPredict: 100,
      numCtx: 2048,
    });

    expect(result).toEqual([
      msg('system', 'SYS'),
      msg('user', 'Erkläre die Relativitätstheorie ausführlich'),
      msg('user', 'Erzähl mir mehr dazu'),
    ]);
  });

  it('does not promote an incomplete persisted start-context turn into live context', () => {
    const result = buildContextWindow({
      systemPrompt: 'SYS',
      startContext: [msg('user', 'Unbeantwortete Frage aus alter Sitzung')],
      history: [msg('user', 'Aktuelle Frage')],
      numPredict: 100,
      numCtx: 2048,
    });

    expect(result).toEqual([
      msg('system', 'SYS'),
      msg('user', 'Aktuelle Frage'),
    ]);
  });

  it('fails closed instead of silently overfilling for an oversized current message', () => {
    expect(() => buildContextWindow({
      systemPrompt: '',
      startContext: [msg('user', 'wird verworfen')],
      history: [msg('user', 'y'.repeat(100 * CHARS_PER_TOKEN))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 10,
    })).toThrow(/Protected prompt exceeds context window/);
  });

  it('fails closed when the protected system prompt leaves no room for the current message', () => {
    expect(() => buildContextWindow({
      systemPrompt: chars(600),
      startContext: [],
      history: [msg('user', 'z'.repeat(1000 * CHARS_PER_TOKEN))],
      numPredict: 100,
      numCtx: 512,
    })).toThrow(/Protected prompt exceeds context window/);
  });

  it('accounts conservatively for multibyte text and chat-template overhead', () => {
    const systemTokens = estimateTokens('S') + CHAT_TEMPLATE_MESSAGE_TOKENS;
    const currentTokens = estimateTokens('😀'.repeat(20)) + CHAT_TEMPLATE_MESSAGE_TOKENS;
    expect(() => buildContextWindow({
      systemPrompt: 'S',
      startContext: [],
      history: [msg('user', '😀'.repeat(20))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + CHAT_TEMPLATE_BASE_TOKENS
        + systemTokens + currentTokens - 1,
    })).toThrow(/Protected prompt exceeds context window/);
  });

  it('rejects the real 4,000-character Qwen overflow repro at a 4,096 context', () => {
    expect(() => buildContextWindow({
      systemPrompt: 'Systemregel '.repeat(140),
      startContext: [],
      history: [msg('user', 'x'.repeat(4_000))],
      numPredict: 1_600,
      numCtx: 4_096,
    })).toThrow(/Protected prompt exceeds context window/);
  });

  it('system prompt and current user message always survive overflow', () => {
    const result = buildContextWindow({
      systemPrompt: 'SYSTEM PROMPT',
      startContext: [msg('user', chars(500))],
      history: [msg('assistant', chars(500)), msg('user', 'aktuelle Frage')],
      numPredict: 1600,
      numCtx: 2048,
    });

    expect(result[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    expect(result[result.length - 1]).toEqual({ role: 'user', content: 'aktuelle Frage' });
  });
});
