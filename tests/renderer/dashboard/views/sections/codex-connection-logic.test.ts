import { describe, expect, it } from 'vitest';
import { CODEX_DEVICE_LOGIN_URL, managedCodexLoginInput } from '../../../../../src/renderer/dashboard/views/sections/codex-connection-logic.js';

describe('managed Codex login consent', () => {
  it('requires explicit consent and emits no tokens or API credentials', () => {
    expect(managedCodexLoginInput(false)).toBeNull();
    expect(managedCodexLoginInput(true)).toEqual({ acknowledgementVersion: '2026-09-05.codex-managed-chatgpt.v1' });
  });
  it('uses only the fixed official device-login page', () => {
    expect(CODEX_DEVICE_LOGIN_URL).toBe('https://auth.openai.com/codex/device');
  });
});
