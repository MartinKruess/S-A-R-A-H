import { it, expect } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServerClient } from '../../../../src/services/providers/codex/codex-app-server-client.js';

it.skipIf(process.platform !== 'win32' || process.env.SARAH_CODEX_NATIVE_SMOKE !== '1')('initializes isolated native app server without account or generation', async () => {
  const isolatedHome = await mkdtemp(join(tmpdir(), 'sarah-codex-native-'));
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.launch({ binaryPath: resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
      isolatedHome, cwd: isolatedHome, authKind: 'codex_managed_chatgpt' });
    expect(await client.request('account/read', { refreshToken: false })).toMatchObject({ account: null });
    expect(await readdir(isolatedHome)).not.toContain('auth.json');
  } finally { client?.close(); await rm(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 30_000);
