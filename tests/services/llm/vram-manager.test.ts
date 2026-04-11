import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VramManager } from '../../../src/services/llm/vram-manager';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('VramManager', () => {
  let manager: VramManager;

  beforeEach(() => {
    mockFetch.mockReset();
    manager = new VramManager('http://localhost:11434');
  });

  describe('unloadModel', () => {
    it('sends keep_alive 0 to unload model', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await manager.unloadModel('qwen3.5:2b');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3.5:2b',
            prompt: '',
            keep_alive: '0',
          }),
        },
      );
    });

    it('does not throw on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('connection refused'));
      await expect(manager.unloadModel('qwen3.5:2b')).resolves.toBeUndefined();
    });
  });

  describe('getLoadedModels', () => {
    it('returns list of loaded model names', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          models: [
            { model: 'qwen3.5:2b', size_vram: 3000000000 },
            { model: 'qwen3.5:9b', size_vram: 6500000000 },
          ],
        }),
      });

      const models = await manager.getLoadedModels();
      expect(models).toEqual([
        { model: 'qwen3.5:2b', sizeVram: 3000000000 },
        { model: 'qwen3.5:9b', sizeVram: 6500000000 },
      ]);
    });

    it('returns empty array on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('connection refused'));
      const models = await manager.getLoadedModels();
      expect(models).toEqual([]);
    });
  });

  describe('swapModels', () => {
    it('unloads current model then returns', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await manager.swapModels('qwen3.5:2b', 'qwen3.5:9b');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('qwen3.5:2b');
      expect(body.keep_alive).toBe('0');
    });
  });
});
