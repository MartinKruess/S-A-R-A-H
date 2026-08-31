import { describe, expect, it } from 'vitest';
import type { MemoryAuthorSnapshot } from '../../core/storage/layer2-memory-store.js';
import { estimateTokens } from './context-window.js';
import {
  buildDecisionMessages,
  buildExtractionMessages,
  selectRelatedMemories,
  validateOfferedDecision,
  type MemoryCandidate,
} from './memory-author-contract.js';

const candidate: MemoryCandidate = {
  decision: 'candidate',
  kind: 'preference',
  topic: 'Schach',
  content: 'Martin spielt gern Schach.',
  evidence: 'Ich spiele gern Schach.',
  searchTerms: ['Schach', 'Brettspiel'],
  durability: 'stable',
  confidence: 0.9,
};

function snapshot(id: number, title: string, content: string, version = 1): MemoryAuthorSnapshot {
  return {
    topic: { id, title, version },
    memory: {
      id, kind: 'preference', content, confidence: 0.8, revision: 1,
      updated_at: '2026-08-31T00:00:00.000Z',
    },
  };
}

describe('Memory Author contract', () => {
  it('selects at most four deterministic topic-related active memories', () => {
    const selected = selectRelatedMemories(candidate, [
      snapshot(1, 'Fahrrad', 'Martin fährt Fahrrad.'),
      snapshot(2, 'Schach', 'Martin spielt Blitzschach.'),
      snapshot(3, 'Brettspiele', 'Martin mag Schachturniere.'),
      snapshot(4, 'Schach', 'Martin lernt Eröffnungen.'),
      snapshot(5, 'Schach', 'Martin verfolgt Schach-WM.'),
      snapshot(6, 'Schach', 'Martin spielt online.'),
    ]);

    expect(selected).toHaveLength(4);
    expect(selected.every(({ topic, memory }) => (
      topic.title === 'Schach' || memory.content.includes('Schach')
    ))).toBe(true);
    expect(selected.some(({ topic }) => topic.title === 'Fahrrad')).toBe(false);
  });

  it('rejects invented IDs, stale revisions and stale topic versions', () => {
    const offered = selectRelatedMemories(candidate, [snapshot(2, 'Schach', 'Martin spielt Blitzschach.', 3)]);

    expect(validateOfferedDecision({
      action: 'update', topic: { id: 2, version: 3 }, targets: [{ id: 99, revision: 1 }],
    }, offered)).toBe(false);
    expect(validateOfferedDecision({
      action: 'update', topic: { id: 2, version: 3 }, targets: [{ id: 2, revision: 2 }],
    }, offered)).toBe(false);
    expect(validateOfferedDecision({
      action: 'update', topic: { id: 2, version: 2 }, targets: [{ id: 2, revision: 1 }],
    }, offered)).toBe(false);
  });

  it('keeps extraction and decision prompts inside the conservative 4096-token contract', () => {
    const extraction = buildExtractionMessages(`USER: ${'ä'.repeat(20_000)}`, 4_096);
    expect(extraction.messages.at(-1)?.content.endsWith('[/GESPRÄCHSDATEN]')).toBe(true);
    expect(extraction.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
      + extraction.numPredict + 256).toBeLessThanOrEqual(4_096);

    const offered = selectRelatedMemories(candidate, Array.from({ length: 8 }, (_, index) => (
      snapshot(index + 1, 'Schach', `Schach ${'x'.repeat(1_000)}`)
    )));
    const decision = buildDecisionMessages(candidate, offered, 4_096);
    expect(decision.offered.length).toBeLessThanOrEqual(4);
    expect(decision.messages.at(-1)?.content.endsWith('[/MEMORY_DATA]')).toBe(true);
    expect(decision.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
      + decision.numPredict + 256).toBeLessThanOrEqual(4_096);
  });
});
