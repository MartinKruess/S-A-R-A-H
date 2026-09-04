import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildRoutingPrompt } from './routing-prompt.js';
import { parseRouteTag, type ParsedRoute } from './route-parser.js';
import { chatWithTimeout } from './chat-with-timeout.js';
import { runWithTimeout } from '../../core/abort-utils.js';
import { buildContextWindow } from './context-window.js';
import type { DecisionContext } from '../../core/decision-context.js';
import {
  parseRouterPlanProposal,
  ROUTER_PROPOSAL_PREFIX,
} from './router-proposal-contract.js';

// A 4,096-character proposal normally fits comfortably while keeping the
// small router's generation budget bounded. Legacy tags stop far earlier.
export const ROUTER_NUM_PREDICT = 1_024;
export const ROUTER_NUM_CTX = 16_384;
export const ROUTER_DEADLINE_MS = 15_000;

interface RoutingResultBase {
  parsed: ParsedRoute;
  tookMs: number;
  hadTag: boolean;
}

export type RoutingResult = RoutingResultBase & (
  | { readonly outputKind: 'legacy'; readonly proposalOutput?: undefined }
  | { readonly outputKind: 'proposal'; readonly proposalOutput: string }
  | { readonly outputKind: 'invalid_proposal'; readonly proposalOutput?: undefined }
);

export class RoutingService {
  constructor(
    private provider: LlmProvider,
    private now: () => Date = () => new Date(),
  ) {}

  async route(text: string, signal?: AbortSignal): Promise<RoutingResult>;
  async route(
    text: string,
    decisionContext: DecisionContext,
    signal?: AbortSignal,
  ): Promise<RoutingResult>;
  async route(
    text: string,
    contextOrSignal?: DecisionContext | AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<RoutingResult> {
    const decisionContext = contextOrSignal instanceof AbortSignal
      ? undefined
      : contextOrSignal;
    const signal = contextOrSignal instanceof AbortSignal
      ? contextOrSignal
      : callerSignal;
    const messages: ChatMessage[] = buildContextWindow({
      systemPrompt: buildRoutingPrompt(this.now(), decisionContext),
      startContext: [],
      history: [{ role: 'user', content: text }],
      numCtx: ROUTER_NUM_CTX,
      numPredict: ROUTER_NUM_PREDICT,
    });
    const start = performance.now();
    const response = await runWithTimeout(
      (deadlineSignal) => chatWithTimeout(this.provider, messages, () => {}, {
        keep_alive: -1,
        num_predict: ROUTER_NUM_PREDICT,
        temperature: 0,
        signal: deadlineSignal,
      }),
      ROUTER_DEADLINE_MS,
      'Router classification timed out',
      signal,
    );
    const tookMs = Math.round(performance.now() - start);
    const parsed = parseRouteTag(response);
    const hadTag = /^\s*\[(?:ROUTE:\w+|ACTION:[a-z_]+(?::[^\]]*)?)]\s*$/.test(response);
    const normalizedOutput = response.normalize('NFC').trim();
    const proposalCandidate = normalizedOutput.startsWith(ROUTER_PROPOSAL_PREFIX.trimEnd());
    const proposal = proposalCandidate ? parseRouterPlanProposal(response) : null;
    // Never log raw model output or action parameters: both may contain private
    // user text, including during one-shot or multi-turn incognito requests.
    const decision = proposal?.ok
      ? 'PROPOSAL'
      : proposalCandidate
        ? 'INVALID_PROPOSAL'
        : parsed.kind === 'action'
          ? `ACTION ${parsed.action}`
          : `ROUTE ${parsed.route}`;
    console.log(`[Router] ${decision} (hadTag=${hadTag})`);
    if (proposal?.ok) {
      return {
        parsed,
        tookMs,
        hadTag,
        outputKind: 'proposal',
        proposalOutput: normalizedOutput,
      };
    }
    return {
      parsed,
      tookMs,
      hadTag,
      outputKind: proposalCandidate ? 'invalid_proposal' : 'legacy',
    };
  }

  async warmup(signal?: AbortSignal): Promise<void> {
    await this.provider.chat(
      [{ role: 'user', content: 'ok' }],
      () => {},
      { num_predict: 1, keep_alive: -1, signal },
    );
  }
}
