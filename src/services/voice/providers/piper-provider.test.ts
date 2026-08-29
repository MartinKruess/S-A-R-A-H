import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PiperProvider } from './piper-provider.js';

describe('PiperProvider availability', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createResources(): string {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-piper-'));
    tempDirs.push(resources);
    const piperDir = path.join(resources, 'piper');
    fs.mkdirSync(piperDir);
    fs.writeFileSync(path.join(piperDir, 'piper.exe'), 'probe fixture');
    fs.writeFileSync(path.join(piperDir, 'de_DE-thorsten-medium.onnx'), 'voice fixture');
    return resources;
  }

  it('reports ready only after the executable probe succeeds', async () => {
    const probe = vi.fn(async (_binaryPath: string, _signal?: AbortSignal) => {});
    const provider = new PiperProvider(createResources(), { probe });
    const availability = vi.fn();
    provider.onAvailabilityChange(availability);

    await provider.init();

    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0][0]).toMatch(/piper[\\/]piper\.exe$/);
    expect(availability).toHaveBeenLastCalledWith({ available: true });
  });

  it('reports unavailable when the binary exists but cannot execute', async () => {
    const provider = new PiperProvider(createResources(), {
      probe: vi.fn(async () => { throw new Error('not executable'); }),
    });
    const availability = vi.fn();
    provider.onAvailabilityChange(availability);

    await expect(provider.init()).rejects.toThrow('not executable');
    expect(availability).toHaveBeenLastCalledWith({
      available: false,
      message: 'not executable',
    });
  });
});
