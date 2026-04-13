import { describe, it, expectTypeOf } from 'vitest';
import type { BusEvents } from './bus-events.js';

describe('BusEvents type map', () => {
  it('maps chat:message to { text: string; mode: chat | voice }', () => {
    expectTypeOf<BusEvents['chat:message']>().toEqualTypeOf<{ text: string; mode: 'chat' | 'voice' }>();
  });

  it('maps llm:done to { fullText: string }', () => {
    expectTypeOf<BusEvents['llm:done']>().toEqualTypeOf<{ fullText: string }>();
  });

  it('maps voice:play-audio to { audio: number[]; sampleRate: number }', () => {
    expectTypeOf<BusEvents['voice:play-audio']>().toEqualTypeOf<{ audio: number[]; sampleRate: number }>();
  });

  it('maps voice:done to empty payload', () => {
    expectTypeOf<BusEvents['voice:done']>().toEqualTypeOf<Record<string, never>>();
  });
});
