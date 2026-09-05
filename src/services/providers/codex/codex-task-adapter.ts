import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AcceptedSpecialistTaskMetadata, SpecialistTaskRequest, SpecialistTaskUsage } from '../../../core/specialist-task.js';
import type { SpecialistTaskAdapter, SpecialistAdapterContext, SpecialistAdapterAcceptance, SpecialistResolvedBinding } from '../../specialists/specialist-task-adapter.js';
import type { CodexRpc, CodexRpcMessage } from './codex-app-server-client.js';

export interface CodexTaskSession {
  client: CodexRpc;
  model: string;
  cwd: string;
  /** Main must establish confinement; 0.153.4 readOnly alone permits reading outside cwd. */
  containmentVerified: boolean;
  isCurrent(): boolean;
}
interface RunningTask { client: CodexRpc; threadId: string; turnId: string; context: SpecialistAdapterContext;
  unsubscribe(): void; timer: ReturnType<typeof setTimeout>; text: string; usage?: SpecialistTaskUsage; terminal: boolean; cancelRequested: boolean }
const SafeId = z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/iu);
const Thread = z.object({ thread: z.object({ id: SafeId }) });
const Turn = z.object({ turn: z.object({ id: SafeId }) });
const Completed = z.object({ threadId: SafeId, turn: z.object({ id: SafeId, status: z.enum(['completed', 'failed', 'interrupted']) }) });
const Item = z.object({ threadId: SafeId, turnId: SafeId, item: z.object({ type: z.literal('agentMessage'), text: z.string().max(200_000) }) });
const Usage = z.object({ threadId: SafeId, turnId: SafeId, tokenUsage: z.object({ total: z.object({
  inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(), reasoningOutputTokens: z.number().int().nonnegative() }) }) });

/** One bounded, ephemeral coding turn. Restart never resubmits a goal or resumes an agent. */
export class CodexTaskAdapter implements SpecialistTaskAdapter {
  readonly operationId = 'openai_codex' as const;
  private readonly tasks = new Map<string, RunningTask>();
  constructor(private readonly resolveSession: (binding: SpecialistResolvedBinding | SpecialistTaskRequest) => CodexTaskSession | null,
    private readonly containmentAvailable: () => boolean = () => false) {}
  isReady(): boolean { return this.containmentAvailable(); }
  unavailableReason(): 'codex_workspace_containment_unverified' | null {
    return this.containmentAvailable() ? null : 'codex_workspace_containment_unverified';
  }
  async preflight(binding: SpecialistResolvedBinding): Promise<{ ok: true } | { ok: false; code: 'unavailable' }> {
    const session = this.resolveSession(binding);
    return session?.containmentVerified && session.isCurrent() ? { ok: true } : { ok: false, code: 'unavailable' };
  }
  async start(request: SpecialistTaskRequest, context: SpecialistAdapterContext, signal?: AbortSignal): Promise<SpecialistAdapterAcceptance> {
    const session = this.resolveSession(request);
    if (!session?.containmentVerified || !session.isCurrent() || request.modelId !== session.model || !request.credentialGeneration || request.accessMode !== 'read_only'
      || !request.workspaceReference || !request.dataEgress.includes('workspace_files') || signal?.aborted) throw new Error('codex_policy_denied');
    const thread = Thread.parse(await session.client.request('thread/start', { model: session.model, cwd: session.cwd,
      approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      developerInstructions: 'Work only on the supplied goal. Do not download dependencies, change files, or access the network.' }, signal));
    if (!session.isCurrent() || signal?.aborted) throw new Error('codex_identity_changed');
    const remoteRef = randomUUID();
    const task: RunningTask = { client: session.client, threadId: thread.thread.id, turnId: '', context,
      unsubscribe: () => {}, timer: setTimeout(() => { void this.stop(remoteRef, 'codex_deadline'); }, request.budget.timeoutMs),
      text: '', terminal: false, cancelRequested: false };
    this.tasks.set(remoteRef, task);
    task.unsubscribe = session.client.subscribe((message) => this.onMessage(remoteRef, message));
    try {
      const turn = Turn.parse(await session.client.request('turn/start', { threadId: task.threadId,
        input: [{ type: 'text', text: request.goal }], model: session.model, cwd: session.cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }, signal));
      task.turnId = turn.turn.id;
      return { remoteRef, status: 'running' };
    } catch {
      // A timed-out start is ambiguous. Terminate this owned process, never retry generation.
      session.client.close(); this.release(remoteRef); throw new Error('codex_start_incomplete');
    }
  }
  async retrieve(): Promise<null> { return null; }
  async resume(): Promise<void> { throw new Error('codex_resume_not_supported'); }
  async provideInput(): Promise<void> { throw new Error('codex_input_not_supported'); }
  async cancel(task: AcceptedSpecialistTaskMetadata | SpecialistAdapterAcceptance): Promise<void> {
    const active = this.tasks.get(task.remoteRef);
    if (!active || active.terminal) throw new Error('codex_task_unavailable');
    active.cancelRequested = true;
    await active.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
    // Only turn/completed interrupted can confirm cancellation.
  }
  private onMessage(ref: string, message: CodexRpcMessage): void {
    const task = this.tasks.get(ref);
    if (!task || task.terminal) return;
    if (message.method === 'sarah/disconnected') { task.context.emit({ eventId: randomUUID(), type: 'incomplete', code: 'codex_disconnected' }); this.release(ref); return; }
    const params = message.params;
    if (params?.threadId !== task.threadId) return;
    const incomingTurn = typeof params.turnId === 'string' ? params.turnId
      : params.turn && typeof params.turn === 'object' && !Array.isArray(params.turn) ? params.turn.id : null;
    // turn/started may arrive before the turn/start RPC response.
    if (!task.turnId && typeof incomingTurn === 'string') task.turnId = incomingTurn;
    if (incomingTurn !== task.turnId) return;
    if (message.id !== undefined) {
      // No escalation is granted by a read-only task confirmation.
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') task.client.respond(message.id, { decision: 'decline' });
      else { task.client.respond(message.id, {}); void this.stop(ref, 'codex_unsupported_approval'); }
      return;
    }
    if (message.method === 'item/completed') {
      const parsed = Item.safeParse(params);
      if (parsed.success) task.text = parsed.data.item.text;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const parsed = Usage.safeParse(params);
      if (parsed.success) { const usage = parsed.data.tokenUsage.total; task.usage = { inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningOutputTokens, toolCalls: 0 }; }
    }
    if (message.method === 'turn/completed') {
      const parsed = Completed.safeParse(params);
      if (!parsed.success) { void this.stop(ref, 'codex_invalid_completion'); return; }
      const status = parsed.data.turn.status;
      if (status === 'completed') {
        task.context.publishResult?.({ text: task.text, citations: [] });
        task.context.emit({ eventId: randomUUID(), type: 'completed', summary: 'Coding-Auftrag abgeschlossen.', ...(task.usage ? { usage: task.usage } : {}) });
      } else if (status === 'interrupted' && task.cancelRequested) task.context.emit({ eventId: randomUUID(), type: 'canceled' });
      else task.context.emit({ eventId: randomUUID(), type: 'incomplete', code: 'codex_turn_incomplete' });
      this.release(ref);
    }
  }
  private async stop(ref: string, code: string): Promise<void> {
    const task = this.tasks.get(ref); if (!task) return;
    task.context.emit({ eventId: randomUUID(), type: 'incomplete', code });
    this.release(ref);
    try { await task.client.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId }); } catch { task.client.close(); }
  }
  private release(ref: string): void {
    const task = this.tasks.get(ref); if (!task) return;
    task.terminal = true; clearTimeout(task.timer); task.unsubscribe(); this.tasks.delete(ref);
  }
}
