import type { ChatMessage, LlmProvider } from '../llm-provider.interface.js';
import type { OllamaOptions } from '../llm-types.js';

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';

  constructor(
    private baseUrl: string,
    private model: string,
    private options?: OllamaOptions,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.some((m) => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }

  async chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        think: false,
        ...(this.options && { options: this.options }),
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error('Ollama returned empty response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            message: { content: string };
            done: boolean;
          };
          const chunk = parsed.message.content;
          if (chunk) {
            fullText += chunk;
            onChunk(chunk);
          }
        } catch {
          // Skip malformed JSON chunks from Ollama
        }
      }
    }

    return fullText;
  }
}
