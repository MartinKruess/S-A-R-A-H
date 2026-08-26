import { describe, it, expectTypeOf } from 'vitest';
import type { BusEvents } from './bus-events.js';

describe('BusEvents type map', () => {
  it('maps chat:message to the correlated turn request', () => {
    expectTypeOf<BusEvents['chat:message']>().toMatchTypeOf<{
      turnId: string;
      source: 'chat' | 'voice';
      mode: 'chat' | 'voice';
      originalText: string;
    }>();
  });

  it('maps llm:done to { fullText: string }', () => {
    expectTypeOf<BusEvents['llm:done']>().toEqualTypeOf<{
      turnId: string;
      outputId: string;
      sequence: number;
      fullText: string;
    }>();
  });

  it('maps voice:play-audio to { audio: number[]; sampleRate: number }', () => {
    expectTypeOf<BusEvents['voice:play-audio']>().toMatchTypeOf<{
      turnId: string;
      outputId: string;
      playbackId: string;
      audio: number[];
      sampleRate: number;
    }>();
  });

  it('maps voice:done to a correlated payload', () => {
    expectTypeOf<BusEvents['voice:done']>().toEqualTypeOf<{ turnId: string }>();
  });
});
