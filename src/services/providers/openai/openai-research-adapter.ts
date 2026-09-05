import type OpenAI from 'openai';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import type { AcceptedSpecialistTaskMetadata, SpecialistAdapterEvent, SpecialistTaskRequest } from '../../../core/specialist-task.js';
import type { SpecialistAdapterAcceptance, SpecialistAdapterContext, SpecialistResolvedBinding, SpecialistTaskAdapter } from '../../specialists/specialist-task-adapter.js';
import { createOpenAiClient, responseResult, responseUsage, type OpenAiClientFactory } from './responses-common.js';

interface ActiveResponse {
  readonly client: OpenAI;
  readonly controller: AbortController;
  response: Response;
  timer?: ReturnType<typeof setTimeout>;
}

/** Background research uses one accepted response ID; polling never recreates a paid request. */
export class OpenAiResearchAdapter implements SpecialistTaskAdapter {
  readonly operationId = 'openai_deep_research' as const;
  private readonly active = new Map<string, ActiveResponse>();
  constructor(private readonly clientFactory: OpenAiClientFactory = createOpenAiClient,
    private readonly pollIntervalMs = 2_000) {}
  isReady(): boolean { return true; }
  async preflight(binding: SpecialistResolvedBinding) {
    return binding.providerId === 'openai' && binding.operationId === this.operationId
      ? { ok: true as const } : { ok: false as const, code: 'policy_denied' as const };
  }

  async start(request: SpecialistTaskRequest, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<SpecialistAdapterAcceptance> {
    const key = context.resolveCredential();
    if (!key || context.isAllowed?.() === false || request.providerId !== 'openai' || request.operationId !== this.operationId
      || !request.backgroundConsent || !request.modelId
      || !['o3-deep-research', 'o4-mini-deep-research'].includes(request.modelId)
      || !Number.isInteger(request.budget.maxOutputTokens) || !request.budget.maxOutputTokens
      || request.budget.maxOutputTokens < 1 || request.budget.maxOutputTokens > 32_768
      || !Number.isInteger(request.budget.maxToolCalls) || !request.budget.maxToolCalls
      || request.budget.maxToolCalls < 1 || request.budget.maxToolCalls > 100
      || request.accessMode !== 'none' || request.dataEgress.some((scope) => scope !== 'goal')) {
      throw new Error('research_policy_denied');
    }
    const client = this.clientFactory(key);
    let response: Response;
    try {
      // Documented Responses parameter omitted by the pinned SDK's stable generated type.
      const parameters: ResponseCreateParamsNonStreaming & { max_tool_calls: number } = {
        model: request.modelId, input: request.goal, background: true, store: false,
        max_output_tokens: request.budget.maxOutputTokens, max_tool_calls: request.budget.maxToolCalls,
        tools: [{ type: 'web_search_preview' }],
      };
      response = await client.responses.create(parameters, { signal });
    } catch { throw new Error('research_start_failed'); }
    if (!/^resp_[a-z0-9_-]{1,120}$/iu.test(response.id)) throw new Error('research_invalid_reference');
    this.active.set(response.id, { client, response, controller: new AbortController() });
    return { remoteRef: response.id, status: response.status === 'queued' ? 'queued' : 'running' };
  }

  /** Called only after durable acceptance, including immediate provider completion. */
  async activate(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext): Promise<void> {
    const active = this.active.get(task.remoteRef);
    if (!active) return;
    const terminal = this.event(active.response, context);
    if (terminal) {
      this.emit(task, context, terminal);
      if (terminal.type !== 'running') { this.stop(task.remoteRef); return; }
    }
    this.schedule(task, context, active);
  }

  async retrieve(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<SpecialistAdapterEvent | null> {
    try {
      const key = context.resolveCredential();
      if (!key) throw new Error('credential_unavailable');
      const client = this.active.get(task.remoteRef)?.client ?? this.clientFactory(key);
      const response = await client.responses.retrieve(task.remoteRef, {}, { signal });
      if (response.id !== task.remoteRef) throw new Error('reference_mismatch');
      if (!this.active.has(task.remoteRef) && ['queued', 'in_progress'].includes(response.status ?? '')) {
        this.active.set(task.remoteRef, { client, response, controller: new AbortController() });
        this.schedule(task, context, this.active.get(task.remoteRef)!);
      }
      const event = this.event(response, context);
      if (event && event.type !== 'running') this.stop(task.remoteRef);
      // Reconciliation starts from metadata, so preserve the cancellation transition.
      if (event?.type === 'canceled' && task.status !== 'cancel_requested') {
        context.emit({ eventId: 'research.remote_cancel_requested', type: 'cancel_requested' });
      }
      return event;
    } catch { return { eventId: 'research.retrieve_failed', type: 'incomplete', code: 'research_unretrievable' }; }
  }

  async resume(): Promise<void> { throw new Error('research_resume_unsupported'); }
  async provideInput(): Promise<void> { throw new Error('research_input_unsupported'); }

  async cancel(task: AcceptedSpecialistTaskMetadata | SpecialistAdapterAcceptance, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<void> {
    const active = this.active.get(task.remoteRef);
    this.stop(task.remoteRef);
    try {
      const key = context.resolveCredential();
      if (!key && !active) throw new Error('credential_unavailable');
      const client = active?.client ?? this.clientFactory(key!);
      const response = await client.responses.cancel(task.remoteRef, { signal });
      if (response.id !== task.remoteRef) throw new Error('reference_mismatch');
      const event = this.event(response, context);
      if (!event || event.type === 'running') throw new Error('cancellation_unconfirmed');
      context.emit(event);
    } catch { throw new Error('research_cancel_unconfirmed'); }
  }

  private schedule(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, active: ActiveResponse): void {
    if (active.controller.signal.aborted || active.timer) return;
    active.timer = setTimeout(() => {
      active.timer = undefined;
      void this.poll(task, context, active);
    }, this.pollIntervalMs);
    active.timer.unref?.();
  }

  private async poll(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, active: ActiveResponse): Promise<void> {
    if (active.controller.signal.aborted) return;
    if (task.deadlineAt && Date.now() >= Date.parse(task.deadlineAt)) {
      this.stop(task.remoteRef);
      context.emit({ eventId: 'research.deadline', type: 'incomplete', code: 'deadline_exceeded' });
      try { await active.client.responses.cancel(task.remoteRef); } catch { /* Remote outcome remains uncertain. */ }
      return;
    }
    try {
      if (!context.resolveCredential() || context.isAllowed?.() === false) throw new Error('credential_revoked');
      const response = await active.client.responses.retrieve(task.remoteRef, {}, { signal: active.controller.signal });
      if (active.controller.signal.aborted) return;
      if (response.id !== task.remoteRef) throw new Error('reference_mismatch');
      const event = this.event(response, context);
      if (event && (event.type !== 'running' || active.response.status !== response.status)) this.emit(task, context, event);
      active.response = response;
      if (event && event.type !== 'running') this.stop(task.remoteRef);
      else this.schedule(task, context, active);
    } catch {
      if (active.controller.signal.aborted) return;
      this.stop(task.remoteRef);
      context.emit({ eventId: 'research.poll_failed', type: 'incomplete', code: 'research_unretrievable' });
      try { await active.client.responses.cancel(task.remoteRef); } catch { /* Never claim remote billing stopped. */ }
    }
  }

  private event(response: Response, context: SpecialistAdapterContext): SpecialistAdapterEvent | null {
    const eventId = `research.${response.status ?? 'unknown'}`;
    switch (response.status) {
      case 'queued': return null;
      case 'in_progress': return { eventId, type: 'running' };
      case 'completed':
        context.publishResult?.(responseResult(response));
        return { eventId, type: 'completed', usage: responseUsage(response) };
      case 'cancelled': return { eventId, type: 'canceled', usage: responseUsage(response) };
      case 'failed': return { eventId, type: 'failed', code: 'research_failed', usage: responseUsage(response) };
      default:
        if (response.output.length) context.publishResult?.(responseResult(response));
        return { eventId, type: 'incomplete', code: 'research_incomplete', usage: responseUsage(response) };
    }
  }

  private emit(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, event: SpecialistAdapterEvent): void {
    if (event.type === 'canceled' && task.status !== 'cancel_requested') {
      context.emit({ eventId: 'research.remote_cancel_requested', type: 'cancel_requested' });
    }
    context.emit(event);
  }

  private stop(remoteRef: string): void {
    const active = this.active.get(remoteRef);
    if (active?.timer) clearTimeout(active.timer);
    active?.controller.abort();
    this.active.delete(remoteRef);
  }
}
