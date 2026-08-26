import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildContextWindow,
  START_CONTEXT_HEADER,
  CHARS_PER_TOKEN,
  RESPONSE_SAFETY_TOKENS,
  MIN_CURRENT_MESSAGE_TOKENS,
} from './context-window.js';
import type { ChatMessage } from './llm-provider.interface.js';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

/** chars → tokens helper matching the estimator (ceil(chars / CHARS_PER_TOKEN)). */
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
    // reserve = numPredict + RESPONSE_SAFETY_TOKENS; system prompt is empty (0 tokens).
    // budget = 13 tokens: current (5) + older (8) = 13 → both fit exactly.
    const input = {
      systemPrompt: '',
      startContext: [] as ChatMessage[],
      history: [msg('user', chars(3)), msg('assistant', chars(5)), msg('user', chars(5))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 13,
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
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 10,
    });

    // live history survives fully; header + start context did not fit → dropped entirely
    expect(result.map((m) => m.content)).toEqual(['', chars(2), chars(2), chars(4)]);
    expect(result.some((m) => m.content === START_CONTEXT_HEADER)).toBe(false);
  });

  it('trims start context oldest-first', () => {
    const headerTokens = Math.ceil(START_CONTEXT_HEADER.length / CHARS_PER_TOKEN);
    // budget: current (2) + header + newest start msg (3) — older start msg (5) must fall off.
    const result = buildContextWindow({
      systemPrompt: '',
      startContext: [
        msg('user', chars(2)), msg('assistant', chars(3)),
        msg('user', chars(1)), msg('assistant', chars(2)),
      ],
      history: [msg('user', chars(2))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 2 + headerTokens + 3,
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
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 6,
    });
    expect(result.map((message) => message.content)).toEqual([
      '', chars(2), chars(2), chars(2),
    ]);
  });

  it('keeps an over-budget current message whole when it fits the guarantee floor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // budget 10 < message (100 tokens), but 100 ≤ MIN_CURRENT_MESSAGE_TOKENS → kept whole
    const result = buildContextWindow({
      systemPrompt: '',
      startContext: [msg('user', 'wird verworfen')],
      history: [msg('user', 'y'.repeat(100 * CHARS_PER_TOKEN))],
      numPredict: 100,
      numCtx: 100 + RESPONSE_SAFETY_TOKENS + 10,
    });

    expect(result).toHaveLength(2); // system + current, history/startContext dropped
    expect(result[1].content).toBe('y'.repeat(100 * CHARS_PER_TOKEN));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('truncates a truly oversized current message to the guarantee floor, never to zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // negative budget: huge system prompt + small numCtx (H3 review case)
    const result = buildContextWindow({
      systemPrompt: chars(600),
      startContext: [],
      history: [msg('user', 'z'.repeat(1000 * CHARS_PER_TOKEN))],
      numPredict: 100,
      numCtx: 512,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe(chars(600)); // system prompt survives untouched
    expect(result[1].content).toBe('z'.repeat(MIN_CURRENT_MESSAGE_TOKENS * CHARS_PER_TOKEN));
    expect(warn).toHaveBeenCalledOnce();
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
