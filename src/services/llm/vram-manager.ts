import { abortableDelay, abortError, throwIfAborted } from '../../core/abort-utils.js';

export interface LoadedModel {
  model: string;
  sizeVram: number;
}

export class VramManager {
  constructor(private baseUrl: string) {}

  async unloadModel(model: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: '0',
        }),
      });
      return response.ok;
    } catch {
      if (signal?.aborted) throw abortError();
      // Model may already be unloaded or Ollama may be stopping.
      return false;
    }
  }

  async getLoadedModels(signal?: AbortSignal): Promise<LoadedModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`, { signal });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models: { model: string; size_vram: number }[];
      };
      return data.models.map((m) => ({
        model: m.model,
        sizeVram: m.size_vram,
      }));
    } catch {
      if (signal?.aborted) throw abortError();
      return [];
    }
  }

  async swapModels(unload: string): Promise<void> {
    await this.unloadModel(unload);
    // The new model is loaded automatically by Ollama on the next chat request.
  }

  async isModelLoaded(model: string, signal?: AbortSignal): Promise<boolean> {
    const target = model.toLowerCase();
    const hasExplicitTag = target.includes(':');
    const loaded = await this.getLoadedModels(signal);
    return loaded.some((entry) => {
      const candidate = entry.model.toLowerCase();
      return hasExplicitTag ? candidate === target : candidate.split(':')[0] === target;
    });
  }

  async waitForModel(
    model: string,
    attempts = 10,
    intervalMs = 100,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      if (await this.isModelLoaded(model, signal)) return true;
      if (attempt < attempts - 1) {
        await abortableDelay(intervalMs, signal);
      }
    }
    return false;
  }
}
