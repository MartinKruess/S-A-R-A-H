import { describe, expect, it, vi } from 'vitest';
import { retryTransientKeyAccess } from './key-access-retry.js';

class TemporaryKeyAccessError extends Error {}

describe('retryTransientKeyAccess', () => {
  it('performs two bounded retries for a transient key access failure', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new TemporaryKeyAccessError('one'))
      .mockRejectedValueOnce(new TemporaryKeyAccessError('two'))
      .mockResolvedValue('ready');
    const wait = vi.fn(async () => undefined);

    await expect(retryTransientKeyAccess(operation, {
      retries: 2,
      delayMs: 250,
      isTransient: (error) => error instanceof TemporaryKeyAccessError,
      wait,
    })).resolves.toBe('ready');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 250);
    expect(wait).toHaveBeenNthCalledWith(2, 250);
  });

  it('does not retry an error classified as final', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('final'));
    const wait = vi.fn(async () => undefined);

    await expect(retryTransientKeyAccess(operation, {
      retries: 2,
      delayMs: 250,
      isTransient: (error) => error instanceof TemporaryKeyAccessError,
      wait,
    })).rejects.toThrow('final');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('fails after the configured transient retry limit', async () => {
    const operation = vi.fn().mockRejectedValue(new TemporaryKeyAccessError('offline'));

    await expect(retryTransientKeyAccess(operation, {
      retries: 2,
      delayMs: 250,
      isTransient: (error) => error instanceof TemporaryKeyAccessError,
      wait: async () => undefined,
    })).rejects.toThrow('offline');

    expect(operation).toHaveBeenCalledTimes(3);
  });
});
