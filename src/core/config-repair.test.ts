import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from './bootstrap.js';
import { repairInvalidConfig } from './bootstrap.js';
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
});
