export interface LoadedModel {
  model: string;
  sizeVram: number;
}

export class VramManager {
  constructor(private baseUrl: string) {}

  async unloadModel(model: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: '0',
        }),
      });
    } catch {
      // Model may already be unloaded — ignore errors
    }
  }

  async getLoadedModels(): Promise<LoadedModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models: { model: string; size_vram: number }[];
      };
      return data.models.map((m) => ({
        model: m.model,
        sizeVram: m.size_vram,
      }));
    } catch {
      return [];
    }
  }

  async swapModels(unload: string, _load: string): Promise<void> {
    await this.unloadModel(unload);
    // The new model is loaded automatically by Ollama on the next chat request.
  }
}
