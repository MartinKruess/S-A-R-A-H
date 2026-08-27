import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from './bootstrap.js';
import { recoverInvalidConfigSnapshot, repairInvalidConfig } from './bootstrap.js';
import { SarahConfigSchema } from './config-schema.js';

describe('repairInvalidConfig', () => {
  it('replaces invalid persisted state with the validated default snapshot', async () => {
    const parsedConfig = SarahConfigSchema.parse({});
    const set = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = {
      config: { set },
      parsedConfig,
      configErrors: ['controls.voiceMode: Invalid option'],
    } as unknown as AppContext;

    await repairInvalidConfig(context);

    expect(set).toHaveBeenCalledWith('root', parsedConfig);
    expect(context.configErrors).toBeNull();
  });

  it('repairs an unrelated field without weakening valid privacy settings or losing profile data', () => {
    const recovered = recoverInvalidConfigSnapshot({
      profile: { displayName: 'Martin', city: 'Berlin' },
      trust: { memoryAllowed: false, confirmationLevel: 'maximal', fileAccess: 'none' },
      controls: { voiceMode: 'invalid', pushToTalkKey: 'F8' },
    });

    expect(recovered.errors).toHaveLength(1);
    expect(recovered.config.profile).toEqual(expect.objectContaining({ displayName: 'Martin', city: 'Berlin' }));
    expect(recovered.config.controls.voiceMode).toBe('off');
    expect(recovered.config.controls.pushToTalkKey).toBe('F8');
    expect(recovered.config.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      confirmationLevel: 'maximal',
      fileAccess: 'none',
    }));
  });

  it('repairs invalid trust fields with restrictive values', () => {
    const recovered = recoverInvalidConfigSnapshot({
      profile: { displayName: 'Martin' },
      trust: { memoryAllowed: 'yes', confirmationLevel: 'sometimes', fileAccess: 'everywhere' },
    });

    expect(recovered.config.profile.displayName).toBe('Martin');
    expect(recovered.config.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      confirmationLevel: 'maximal',
      fileAccess: 'none',
    }));
  });

  it('disables memory when the persisted exclusion contract is invalid', () => {
    const recovered = recoverInvalidConfigSnapshot({
      trust: {
        memoryAllowed: true,
        memoryExclusions: 'Finanzen',
        confirmationLevel: 'standard',
        fileAccess: 'specific-folders',
      },
    });

    expect(recovered.errors.some((error) => error.includes('trust.memoryExclusions'))).toBe(true);
    expect(recovered.config.trust.memoryAllowed).toBe(false);
    expect(recovered.config.trust.memoryExclusions).toEqual([]);
  });
});
