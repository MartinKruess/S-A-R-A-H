import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export type RpcValue = null | boolean | number | string | RpcValue[] | { [key: string]: RpcValue };
export type RpcObject = { [key: string]: RpcValue };
export interface CodexRpcMessage { id?: string | number; method?: string; params?: RpcObject; result?: RpcValue; error?: RpcValue }
export interface CodexRpc {
  request(method: string, params: RpcObject, signal?: AbortSignal): Promise<RpcValue>;
  respond(id: string | number, result: RpcObject): void;
  subscribe(listener: (message: CodexRpcMessage) => void): () => void;
  close(): void;
}
const Envelope = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  params: z.record(z.string(), z.json()).optional(), result: z.json().optional(), error: z.json().optional() });

/** Dedicated bounded stdio transport. Raw stderr/provider failures are never forwarded. */
export class CodexAppServerClient implements CodexRpc {
  private readonly pending = new Map<number, { resolve(value: RpcValue): void; reject(error: Error): void; cleanup(): void }>();
  private readonly listeners = new Set<(message: CodexRpcMessage) => void>();
  private buffer = '';
  private sequence = 0;
  private closed = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = 30_000) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.resume();
    child.on('error', () => this.close());
    child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
  }

  /** Launch only an application-resolved native binary; no shell, ambient keys or host Codex home. */
  static async launch(options: { binaryPath: string; isolatedHome: string; cwd: string; authKind: 'api_key' | 'codex_managed_chatgpt' }): Promise<CodexAppServerClient> {
    if (![options.binaryPath, options.isolatedHome, options.cwd].every(isAbsolute)) throw new Error('codex_invalid_paths');
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[name]) env[name] = process.env[name];
    env.CODEX_HOME = options.isolatedHome;
    env.HOME = options.isolatedHome;
    env.USERPROFILE = options.isolatedHome;
    const child = spawn(options.binaryPath, ['app-server', '--listen', 'stdio://',
      '-c', 'cli_auth_credentials_store="keyring"', '-c', `forced_login_method="${options.authKind === 'api_key' ? 'api' : 'chatgpt'}"`,
      '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
      '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"'],
    { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: 'pipe' });
    const client = new CodexAppServerClient(child);
    try {
      await client.request('initialize', { clientInfo: { name: 'sarah', title: 'S.A.R.A.H.', version: '1.0.0' } });
      client.write({ method: 'initialized' });
      return client;
    } catch { client.close(); throw new Error('codex_initialization_failed'); }
  }

  request(method: string, params: RpcObject, signal?: AbortSignal): Promise<RpcValue> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('codex_unavailable'));
    if (this.pending.size >= 64) return Promise.reject(new Error('codex_request_limit'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.pending.delete(id); cleanup(); reject(new Error('codex_request_interrupted')); };
      const timer = setTimeout(abort, this.timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ id, method, params }); }
      catch { this.pending.delete(id); cleanup(); reject(new Error('codex_write_failed')); }
    });
  }
  respond(id: string | number, result: RpcObject): void { this.write({ id, result }); }
  subscribe(listener: (message: CodexRpcMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('codex_disconnected')); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'sarah/disconnected' });
    this.listeners.clear();
    this.child.kill();
  }
  private write(message: CodexRpcMessage): void {
    if (this.closed) throw new Error('codex_disconnected');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > 1_048_576) throw new Error('codex_frame_limit');
    this.child.stdin.write(`${line}\n`);
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 2_097_152) { this.close(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      try {
        if (Buffer.byteLength(line) > 1_048_576) throw new Error();
        const message = Envelope.parse(JSON.parse(line)) as CodexRpcMessage;
        if (message.method) {
          for (const listener of this.listeners) listener(message);
          continue;
        }
        if (typeof message.id !== 'number') continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); pending.cleanup();
        if (message.error !== undefined) pending.reject(new Error('codex_rpc_failed'));
        else if (message.result !== undefined) pending.resolve(message.result);
        else pending.reject(new Error('codex_invalid_response'));
      } catch { this.close(); return; }
    }
  }
}
