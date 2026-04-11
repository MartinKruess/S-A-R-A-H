export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  num_predict?: number;
}

export interface LlmProvider {
  /** Unique provider ID, e.g. 'ollama', 'claude', 'openai' */
  readonly id: string;

  /** Check if the provider is reachable and the model is available */
  isAvailable(): Promise<boolean>;

  /**
   * Send messages to the LLM and stream the response.
   * @param messages - Conversation history including system prompt
   * @param onChunk - Called for each streamed text chunk
   * @param options - Per-call options (overrides constructor defaults)
   * @returns The complete response text
   */
  chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: ChatOptions,
  ): Promise<string>;
}
