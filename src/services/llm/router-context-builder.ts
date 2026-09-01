import type { TurnId } from '../../core/turn-contract.js';
import type { CuratedMemoryView } from '../../core/storage/layer2-memory-store.js';
import { serializePromptData } from './prompt-data.js';
import { appendRuntimeTrustInstructions } from './prompt-builder.js';
import {
  buildContextWindow,
  MIN_EFFECTIVE_NUM_PREDICT,
  START_CONTEXT_HEADER,
  type ContextWindowPlan,
} from './context-window.js';
import { NUM_PREDICT_MAP } from './llm-types.js';
import type { ChatMessage } from './llm-provider.interface.js';

export interface RouterHistoryEntry extends ChatMessage {
  turnId: TurnId;
  transient: boolean;
  privateContext: boolean;
  externalData: boolean;
  localData: boolean;
}

export interface RouterContextDraft {
  recalledContents: string[];
  inheritedTransient: boolean;
}

function retrievalTokens(value: string): Set<string> {
  const stopWords = new Set(['aber', 'dass', 'diese', 'dieser', 'einen', 'eine', 'einer', 'haben', 'mein', 'meine', 'nicht', 'oder', 'sarah', 'über', 'und', 'was', 'wie']);
  return new Set(
    (value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('de-DE').match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
}

function retrieveStartContext(query: string, memories: readonly CuratedMemoryView[]): ChatMessage[] {
  const queryTokens = retrievalTokens(query);
  if (queryTokens.size === 0) return [];
  const ranked = memories
    .map((memory) => {
      const topicTokens = retrievalTokens(memory.topic.title ?? '');
      const memoryTokens = retrievalTokens(memory.content);
      let topicScore = 0;
      let contentScore = 0;
      for (const token of queryTokens) {
        if (topicTokens.has(token)) topicScore += token.length >= 7 ? 2 : 1;
        if (memoryTokens.has(token)) contentScore += token.length >= 7 ? 2 : 1;
      }
      return { memory, score: topicScore * 100 + contentScore };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.memory.id - left.memory.id)
    .slice(0, 5);
  if (ranked.length === 0) return [];
  return [
    { role: 'system', content: START_CONTEXT_HEADER },
    ...ranked.map(({ memory }): ChatMessage => ({
      role: 'system',
      content: serializePromptData('recalled_memory_data', {
        id: memory.id,
        kind: memory.kind,
        topic: memory.topic.title,
        revision: memory.revision,
        createdAt: memory.created_at,
        content: memory.content,
      }),
    })),
  ];
}

/**
 * Builds the bounded worker context and propagates privacy/transience metadata.
 *
 * @category Transformation
 */
export function buildRouterContext(input: {
  systemPrompt: string;
  responseStyle: string;
  currentUser: string;
  memoryAllowed: boolean;
  numCtx: number;
  history: readonly RouterHistoryEntry[];
  curatedMemories: readonly CuratedMemoryView[];
  draft?: RouterContextDraft;
}): ContextWindowPlan {
  const startContext = input.memoryAllowed
    ? retrieveStartContext(input.currentUser, input.curatedMemories)
    : [];
  const protectedSystemPrompt = appendRuntimeTrustInstructions(input.systemPrompt, {
    external: input.history.some((entry) => entry.externalData),
    local: input.history.some((entry) => entry.localData),
  });
  const preparedHistory = input.history.map((entry): ChatMessage => ({
    role: entry.role,
    content: entry.externalData
      ? serializePromptData('external_search_data', { content: entry.content })
      : entry.localData
        ? serializePromptData('local_program_data', { content: entry.content })
        : entry.content,
  }));
  const contextInput = {
    systemPrompt: protectedSystemPrompt,
    startContext,
    history: [...preparedHistory, { role: 'user' as const, content: input.currentUser }],
    numCtx: input.numCtx,
    numPredict: NUM_PREDICT_MAP[input.responseStyle] ?? NUM_PREDICT_MAP.mittel,
  };
  const includesTransientHistory = (messages: readonly ChatMessage[]): boolean => (
    preparedHistory.some((prepared, index) => (
      messages.includes(prepared)
      && (input.history[index].transient
        || input.history[index].externalData
        || input.history[index].localData)
    ))
  );
  const includesPrivateHistory = (messages: readonly ChatMessage[]): boolean => (
    preparedHistory.some((prepared, index) => (
      messages.includes(prepared) && input.history[index].privateContext
    ))
  );
  let plan = buildContextWindow(contextInput, { includeEffectiveNumPredict: true });
  if (input.history.some((entry) => entry.privateContext) && !includesPrivateHistory(plan.messages)) {
    plan = buildContextWindow({
      ...contextInput,
      numPredict: MIN_EFFECTIVE_NUM_PREDICT,
    }, { includeEffectiveNumPredict: true });
  }
  if (input.draft) {
    input.draft.recalledContents = [
      ...startContext.map((message) => message.content),
      ...preparedHistory.flatMap((prepared, index) => (
        plan.messages.includes(prepared) ? [input.history[index].content] : []
      )),
    ];
    input.draft.inheritedTransient = input.draft.inheritedTransient
      || includesTransientHistory(plan.messages);
  }
  return plan;
}
