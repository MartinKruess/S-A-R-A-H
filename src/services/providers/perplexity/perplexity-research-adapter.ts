import type Perplexity from '@perplexity-ai/perplexity_ai';
import { z } from 'zod';
import { PERPLEXITY_STORAGE_DISCLOSURE } from '../../../core/perplexity-policy.js';
import type { AcceptedSpecialistTaskMetadata, SpecialistAdapterEvent, SpecialistTaskRequest } from '../../../core/specialist-task.js';
import type { SpecialistTaskAdapter, SpecialistResolvedBinding, SpecialistAdapterContext, SpecialistAdapterAcceptance } from '../../specialists/specialist-task-adapter.js';
import { createPerplexityClient, PERPLEXITY_NATIVE_MODEL, PerplexityResponseSchema, perplexityResult, perplexityUsage,
  type PerplexityClientFactory, type PerplexityResponse } from './perplexity-common.js';

interface Active { client: Perplexity; response: PerplexityResponse; controller: AbortController; timer?: ReturnType<typeof setTimeout> }
const CancelAck = z.object({ response_id: z.string(), status: z.literal('cancelling') });

/** One native, stored research request; every follow-up addresses the same accepted ID. */
export class PerplexityResearchAdapter implements SpecialistTaskAdapter {
  readonly operationId = 'perplexity_agent_research' as const;
  private readonly active = new Map<string, Active>();
  constructor(private readonly factory: PerplexityClientFactory = createPerplexityClient,
    private readonly pollIntervalMs = 2000, private readonly cancellationTimeoutMs = 5000) {}
  isReady(): boolean { return true; }
  async preflight(binding: SpecialistResolvedBinding) {
    return binding.providerId === 'perplexity' && binding.operationId === this.operationId
      && binding.modelId === PERPLEXITY_NATIVE_MODEL && binding.authKind === 'api_key'
      ? { ok: true as const } : { ok: false as const, code: 'policy_denied' as const };
  }
  async start(request: SpecialistTaskRequest, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<SpecialistAdapterAcceptance> {
    const key = context.resolveCredential();
    if (!key || signal?.aborted || context.isAllowed?.() === false || request.role !== 'research' || request.privateContext !== false || request.authKind !== 'api_key'
      || request.providerId !== 'perplexity' || request.operationId !== this.operationId || request.modelId !== PERPLEXITY_NATIVE_MODEL
      || !request.credentialGeneration || !request.backgroundConsent || request.storageDisclosureVersion !== PERPLEXITY_STORAGE_DISCLOSURE.version
      || request.accessMode !== 'none' || request.dataEgress.length !== 1 || request.dataEgress[0] !== 'goal'
      || !Number.isInteger(request.budget.maxOutputTokens) || !request.budget.maxOutputTokens || request.budget.maxOutputTokens < 1 || request.budget.maxOutputTokens > 32768
      || !Number.isInteger(request.budget.maxSteps) || !request.budget.maxSteps || request.budget.maxSteps < 1 || request.budget.maxSteps > 10) throw new Error('perplexity_policy_denied');
    const client = this.factory(key);
    const raw = await client.responses.create({ model: PERPLEXITY_NATIVE_MODEL, input: request.goal,
      tools: [{ type: 'web_search' }], background: true, store: true,
      max_output_tokens: request.budget.maxOutputTokens, max_steps: request.budget.maxSteps }, { signal }).catch(() => { throw new Error('perplexity_start_failed'); });
    const parsed = PerplexityResponseSchema.safeParse(raw);
    if (!parsed.success) {
      if (typeof raw.id === 'string' && /^[a-z0-9._:-]{1,128}$/iu.test(raw.id)) {
        try { await client.responses.cancel(raw.id, { signal: AbortSignal.timeout(this.cancellationTimeoutMs) }); } catch { /* Acceptance remains uncertain. */ }
      }
      throw new Error('perplexity_invalid_response');
    }
    const response = parsed.data;
    this.active.set(response.id, { client, response, controller: new AbortController() });
    return { remoteRef: response.id, status: response.status === 'queued' ? 'queued' : 'running' };
  }
  async activate(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext): Promise<void> {
    const active = this.active.get(task.remoteRef); if (!active) return;
    const event = this.event(active.response, context);
    if (event) this.emit(task, context, event);
    if (event && event.type !== 'running' && event.type !== 'cancel_requested') { this.stop(task.remoteRef); return; }
    this.schedule(task, context, active);
  }
  async retrieve(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<SpecialistAdapterEvent | null> {
    try {
      if (context.isAllowed?.() === false) {
        await this.cancelQuietly(task, context);
        return { eventId: 'perplexity.policy_revoked', type: 'incomplete', code: 'policy_revoked' };
      }
      const key = context.resolveCredential(); if (!key) throw new Error();
      const client = this.active.get(task.remoteRef)?.client ?? this.factory(key);
      const response = PerplexityResponseSchema.parse(await client.responses.retrieve(task.remoteRef, { signal }));
      if (response.id !== task.remoteRef) throw new Error();
      if (context.isAllowed?.() === false) {
        await this.cancelQuietly(task, context);
        return { eventId: 'perplexity.policy_revoked', type: 'incomplete', code: 'policy_revoked' };
      }
      const event = this.event(response, context);
      if (!event || event.type === 'running' || event.type === 'cancel_requested') {
        if (!this.active.has(task.remoteRef)) this.active.set(task.remoteRef, { client, response, controller: new AbortController() });
      } else this.stop(task.remoteRef);
      if (event?.type === 'canceled' && task.status !== 'cancel_requested') context.emit({ eventId: 'perplexity.cancel_requested', type: 'cancel_requested' });
      return event;
    } catch {
      await this.cancelQuietly(task, context);
      return { eventId: 'perplexity.recovery_failed', type: 'incomplete', code: 'perplexity_unretrievable' };
    }
  }
  async cancel(task: AcceptedSpecialistTaskMetadata | SpecialistAdapterAcceptance, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<void> {
    const active = this.active.get(task.remoteRef); this.stop(task.remoteRef);
    const key = context.resolveCredential();
    if (!active && !key) throw new Error('perplexity_cancel_unconfirmed');
    const client = active?.client ?? this.factory(key!);
    const bounded = AbortSignal.any([AbortSignal.timeout(this.cancellationTimeoutMs), ...(signal ? [signal] : [])]);
    try {
      const ack = CancelAck.parse(await client.responses.cancel(task.remoteRef, { signal: bounded }));
      if (ack.response_id !== task.remoteRef) throw new Error();
      while (!bounded.aborted) {
        const response = PerplexityResponseSchema.parse(await client.responses.retrieve(task.remoteRef, { signal: bounded }));
        if (response.id !== task.remoteRef) throw new Error();
        const event = this.event(response, context);
        if (event && event.type !== 'running' && event.type !== 'cancel_requested') { context.emit(event); return; }
        await delay(this.pollIntervalMs, bounded);
      }
    } catch { /* Acknowledgement or transport abort is not a terminal cancellation. */ }
    throw new Error('perplexity_cancel_unconfirmed');
  }
  async resume(): Promise<void> { throw new Error('perplexity_resume_unsupported'); }
  async provideInput(): Promise<void> { throw new Error('perplexity_input_unsupported'); }
  private schedule(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, active: Active): void {
    if (active.controller.signal.aborted || active.timer) return;
    active.timer = setTimeout(() => { active.timer = undefined; void this.poll(task, context, active); }, this.pollIntervalMs);
    active.timer.unref?.();
  }
  private async poll(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, active: Active): Promise<void> {
    if (active.controller.signal.aborted) return;
    try {
      if (context.isAllowed?.() === false || !context.resolveCredential() || (task.deadlineAt && Date.now() >= Date.parse(task.deadlineAt))) throw new Error();
      const response = PerplexityResponseSchema.parse(await active.client.responses.retrieve(task.remoteRef, { signal: active.controller.signal }));
      if (active.controller.signal.aborted) return;
      if (response.id !== task.remoteRef) throw new Error();
      if (context.isAllowed?.() === false) {
        context.emit({ eventId: 'perplexity.policy_revoked', type: 'incomplete', code: 'policy_revoked' });
        await this.cancelQuietly(task, context);
        return;
      }
      const event = this.event(response, context);
      if (event && (event.type !== 'running' || response.status !== active.response.status)) this.emit(task, context, event);
      active.response = response;
      if (event && event.type !== 'running' && event.type !== 'cancel_requested') this.stop(task.remoteRef);
      else this.schedule(task, context, active);
    } catch {
      if (active.controller.signal.aborted) return;
      context.emit({ eventId: 'perplexity.poll_failed', type: 'incomplete', code: 'perplexity_unretrievable' });
      try { await this.cancel(task, { ...context, emit: () => {}, publishResult: () => {} }); } catch { /* No remote-stop guarantee. */ }
    }
  }
  private event(response: PerplexityResponse, context: SpecialistAdapterContext): SpecialistAdapterEvent | null {
    const eventId = `perplexity.${response.status}`;
    if (response.status === 'queued') return null;
    if (response.status === 'in_progress') return { eventId, type: 'running' };
    if (response.status === 'cancelling') return { eventId, type: 'cancel_requested' };
    if (response.output.length && context.isAllowed?.() !== false) context.publishResult?.(perplexityResult(response));
    const usage = perplexityUsage(response);
    if (response.status === 'completed') return { eventId, type: 'completed', ...(usage ? { usage } : {}) };
    if (response.status === 'cancelled') return { eventId, type: 'canceled', ...(usage ? { usage } : {}) };
    return { eventId, type: response.status === 'failed' ? 'failed' : 'incomplete', code: `perplexity_${response.status}`, ...(usage ? { usage } : {}) };
  }
  private emit(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext, event: SpecialistAdapterEvent): void {
    if (event.type === 'canceled' && task.status !== 'cancel_requested') context.emit({ eventId: 'perplexity.cancel_requested', type: 'cancel_requested' });
    context.emit(event);
  }
  private stop(id: string): void { const active = this.active.get(id); if (active?.timer) clearTimeout(active.timer); active?.controller.abort(); this.active.delete(id); }
  private async cancelQuietly(task: AcceptedSpecialistTaskMetadata, context: SpecialistAdapterContext): Promise<void> {
    try { await this.cancel(task, { ...context, emit: () => {}, publishResult: () => {} }); } catch { /* Revoked policy never authorizes result publication. */ }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('perplexity_interrupted')); return; }
    const abort = (): void => { clearTimeout(timer); reject(new Error('perplexity_interrupted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
