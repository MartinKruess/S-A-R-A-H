import { describe, it, expectTypeOf } from 'vitest';
import type { BusEvents } from '../../src/core/bus-events.js';

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

  it('keeps priority speech semantic and main-process internal', () => {
    expectTypeOf<BusEvents['voice:priority-speech']>().toEqualTypeOf<{
      turnId: string;
      outputId: string;
      text: string;
      priority: 'background' | 'normal' | 'timer' | 'critical' | 'user';
      pauseAfter?: boolean;
    }>();
    expectTypeOf<BusEvents['voice:resume-speech']>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<BusEvents['voice:discard-paused-speech']>().toEqualTypeOf<{
      preserveTurnId: string;
      reason: string;
    }>();
  });
});
