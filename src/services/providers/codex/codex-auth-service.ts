import { z } from 'zod';
import type { CodexRpc } from './codex-app-server-client.js';

const DeviceLogin = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1).max(128),
  verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().min(1).max(64) });
const Account = z.object({ account: z.union([z.object({ type: z.literal('apiKey') }),
  z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() }), z.null()]) });

/** Owns one isolated account identity. Never exports managed tokens or falls back to API billing. */
export class CodexAuthService {
  private ready = false;
  private generation = 0;
  private loginId: string | null = null;
  constructor(readonly client: CodexRpc, readonly authKind: 'api_key' | 'codex_managed_chatgpt',
    private readonly changed: (generation: number, ready: boolean) => void = () => {}) {
    client.subscribe((message) => {
      if (message.method === 'account/updated' || message.method === 'sarah/disconnected') {
        this.invalidate();
        if (message.method === 'account/updated') void this.check().catch(() => {});
      }
      if (message.method === 'account/login/completed' && message.params?.loginId === this.loginId) {
        this.loginId = null;
        if (message.params.success === true) void this.check().catch(() => {});
        else this.invalidate();
      }
    });
  }
  isReady(): boolean { return this.ready; }
  getGeneration(): number { return this.generation; }
  async check(): Promise<boolean> {
    const generation = this.generation;
    const result = Account.parse(await this.client.request('account/read', { refreshToken: false }));
    if (generation !== this.generation) return false;
    this.ready = result.account?.type === (this.authKind === 'api_key' ? 'apiKey' : 'chatgpt');
    this.changed(this.generation, this.ready);
    return this.ready;
  }
  async startManagedLogin(): Promise<z.infer<typeof DeviceLogin>> {
    if (this.authKind !== 'codex_managed_chatgpt') throw new Error('codex_auth_policy_denied');
    if (this.loginId) await this.cancelLogin();
    this.invalidate();
    const login = DeviceLogin.parse(await this.client.request('account/login/start', { type: 'chatgptDeviceCode' }));
    this.loginId = login.loginId;
    return login;
  }
  async loginApiKey(apiKey: string): Promise<boolean> {
    if (this.authKind !== 'api_key' || !apiKey.trim()) throw new Error('codex_auth_policy_denied');
    this.invalidate();
    await this.client.request('account/login/start', { type: 'apiKey', apiKey });
    return this.check();
  }
  async cancelLogin(): Promise<void> {
    const loginId = this.loginId; this.loginId = null;
    if (loginId) await this.client.request('account/login/cancel', { loginId });
  }
  async logout(): Promise<void> { this.invalidate(); await this.cancelLogin(); await this.client.request('account/logout', {}); }
  private invalidate(): void { this.ready = false; this.generation += 1; this.changed(this.generation, false); }
}
