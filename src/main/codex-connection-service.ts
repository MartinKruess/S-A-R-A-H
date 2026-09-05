import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AiProviderHubService } from '../services/integrations/ai-provider-hub-service.js';
import { CODEX_MANAGED_CHATGPT_NOTICE } from '../services/integrations/ai-auth-policy.js';
import { CodexAppServerClient } from '../services/providers/codex/codex-app-server-client.js';
import { CodexAuthService } from '../services/providers/codex/codex-auth-service.js';
import { CodexLoginInputSchema, type CodexLoginInput, type CodexConnectionState } from '../core/codex-connection.js';
import type { CodexRpc } from '../services/providers/codex/codex-app-server-client.js';

/** Owns an explicit managed login; no account tokens cross Main IPC. */
export class CodexConnectionService {
  private auth: CodexAuthService | null = null;
  private connectionId: string | null = null;
  private publishedGeneration = -1;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly userData: string, private readonly hub: AiProviderHubService,
    private readonly launch: (options: Parameters<typeof CodexAppServerClient.launch>[0]) => Promise<CodexRpc> = CodexAppServerClient.launch) {}
  available(id: string): boolean { return id === this.connectionId && this.auth?.isReady() === true
    && this.auth.getGeneration() === this.publishedGeneration && !this.stopped; }
  start(input: CodexLoginInput): Promise<CodexConnectionState> { return this.serial(async () => {
    if (!CodexLoginInputSchema.safeParse(input).success) return this.failure();
    const saved = await this.save();
    if (!saved) return this.failure();
    const auth = await this.ensure();
    const login = await auth.startManagedLogin();
    return {state:'waiting',message:'Melde dich bei OpenAI an und prüfe danach den Status.',
      verificationUrl:login.verificationUrl,userCode:login.userCode};
  }); }
  status(): Promise<CodexConnectionState> { return this.serial(async () => {
    const existing = this.hub.snapshot().connections.find((entry) => entry.authKind === 'codex_managed_chatgpt');
    if (!existing) return {state:'not_connected',message:'Keine Codex-Anmeldung gespeichert.'};
    if (existing.acknowledgement.generalWarningVersion !== CODEX_MANAGED_CHATGPT_NOTICE.version) return this.failure();
    this.connectionId = existing.connectionId;
    const auth = await this.ensure();
    if (!await auth.check()) return {state:'not_connected',message:'Noch nicht bei Codex angemeldet.'};
    if (auth.getGeneration() !== this.publishedGeneration) {
      const generation = auth.getGeneration();
      if (!await this.save()) return this.failure();
      if (!auth.isReady() || generation !== auth.getGeneration() || this.stopped) return this.failure();
      this.publishedGeneration = generation;
    }
    await this.hub.checkHealth({connectionId: this.connectionId!});
    if (!this.connectionId || !this.available(this.connectionId)) return this.failure();
    return {state:'connected',message:'ChatGPT-Anmeldung verbunden. Coding bleibt gesperrt: Projektbegrenzung noch nicht nachgewiesen.'};
  }); }
  logout(): Promise<CodexConnectionState> { return this.serial(async () => {
    const existing = this.hub.snapshot().connections.find((entry) => entry.authKind === 'codex_managed_chatgpt');
    if (!this.connectionId && existing) this.connectionId = existing.connectionId;
    if (this.connectionId) this.hub.invalidateConnection(this.connectionId);
    // A fresh Sarah process must also erase its own previously persisted keyring session.
    if (existing && !this.auth) await this.ensure();
    if (this.auth) await this.auth.logout();
    this.auth?.client.close(); this.auth = null; this.publishedGeneration = -1;
    return {state:'not_connected',message:'Codex abgemeldet.'};
  }); }
  close(): void { this.stopped = true; if (this.connectionId) this.hub.invalidateConnection(this.connectionId);
    this.auth?.client.close(); this.auth = null; this.publishedGeneration = -1; }
  private async save(): Promise<boolean> {
    const result = await this.hub.saveManagedConnection({acknowledgement:{generalWarningVersion:CODEX_MANAGED_CHATGPT_NOTICE.version}});
    if (!result.ok) return false;
    this.connectionId = result.snapshot.connections.find((entry) => entry.authKind === 'codex_managed_chatgpt')?.connectionId ?? null;
    return this.connectionId !== null;
  }
  private async ensure(): Promise<CodexAuthService> {
    if (this.auth) return this.auth;
    if (process.platform !== 'win32' || !['x64','arm64'].includes(process.arch)) throw new Error('codex_platform_unavailable');
    const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const packageRoot = path.dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`));
    const binaryPath = path.join(packageRoot,'vendor',target,'bin','codex.exe');
    const isolatedHome = path.join(this.userData,'codex-managed');
    fs.mkdirSync(isolatedHome,{recursive:true});
    const client = await this.launch({binaryPath,isolatedHome,cwd:isolatedHome,authKind:'codex_managed_chatgpt'});
    if (this.stopped) { client.close(); throw new Error('codex_stopped'); }
    this.auth = new CodexAuthService(client,'codex_managed_chatgpt',(_generation,ready) => {
      if (!ready && this.connectionId) this.hub.invalidateConnection(this.connectionId);
    });
    return this.auth;
  }
  private failure(): CodexConnectionState { return {state:'unavailable',message:'Codex-Anmeldung nicht verfügbar. Installation und sicheren Anmeldespeicher prüfen.'}; }
  private serial(operation:()=>Promise<CodexConnectionState>): Promise<CodexConnectionState> {
    const result = this.queue.then(async()=> {
      if (this.stopped) return this.failure();
      try { const result = await operation(); return this.stopped ? this.failure() : result; }
      catch { this.auth?.client.close(); this.auth=null; this.publishedGeneration = -1;
        if (this.connectionId) this.hub.invalidateConnection(this.connectionId); return this.failure(); }
    });
    this.queue=result.then(()=>{}); return result;
  }
}
