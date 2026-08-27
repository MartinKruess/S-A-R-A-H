import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildContextWindow,
  START_CONTEXT_HEADER,
  CHARS_PER_TOKEN,
  RESPONSE_SAFETY_TOKENS,
  CHAT_TEMPLATE_BASE_TOKENS,
  CHAT_TEMPLATE_MESSAGE_TOKENS,
  estimateTokens,
} from './context-window.js';
import type { ChatMessage } from './llm-provider.interface.js';

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
