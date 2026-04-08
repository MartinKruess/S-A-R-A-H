// src/services/llm/llm-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';

const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;
const STREAM_TIMEOUT_MS = 30_000;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  'no-model': 'Sarah fehlen gerade die Worte.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class LlmService implements SarahService {
  readonly id = 'llm';
  readonly subscriptions = ['chat:message'];
  status: ServiceStatus = 'pending';

  private history: ChatMessage[] = [];
  private systemPrompt = '';

  constructor(
    private context: AppContext,
    private provider: LlmProvider,
  ) {}

  async init(): Promise<void> {
    const available = await this.provider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    this.systemPrompt = await this.buildSystemPrompt();
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: BusMessage): void {
    if (msg.topic === 'chat:message') {
      const text = msg.data.text as string;
      this.handleChatMessage(text).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', {
          message: ERROR_MESSAGES.connection,
        });
      });
    }
  }

  async handleChatMessage(text: string): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES.unavailable,
      });
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    this.history.push(userMsg);

    await this.context.db.insert('messages', {
      conversation_id: 1,
      role: 'user',
      content: text,
    });

    const messages = this.buildMessages();

    try {
      let fullText = '';
      let timeoutId: ReturnType<typeof setTimeout>;
      let rejectTimeout: (err: Error) => void;

      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
        timeoutId = setTimeout(() => reject(new Error('timeout')), STREAM_TIMEOUT_MS);
      });

      const chatPromise = this.provider.chat(messages, (chunk) => {
        // Reset timeout on each chunk
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => rejectTimeout(new Error('timeout')), STREAM_TIMEOUT_MS);
        this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
      });

      fullText = await Promise.race([chatPromise, timeoutPromise]);
      clearTimeout(timeoutId!);

      this.history.push({ role: 'assistant', content: fullText });

      await this.context.db.insert('messages', {
        conversation_id: 1,
        role: 'assistant',
        content: fullText,
      });

      this.context.bus.emit(this.id, 'llm:done', { fullText });
    } catch (err) {
      const errorKey =
        err instanceof Error && err.message === 'timeout'
          ? 'timeout'
          : 'connection';
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES[errorKey],
      });
    }
  }

  private buildMessages(): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: this.systemPrompt };
    const systemTokens = this.estimateTokens(this.systemPrompt);
    const budget = MAX_CONTEXT_TOKENS - systemTokens;

    const trimmed: ChatMessage[] = [];
    let usedTokens = 0;

    // Walk history backwards, keep as many recent messages as fit
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      const tokens = this.estimateTokens(msg.content);
      if (usedTokens + tokens > budget) break;
      usedTokens += tokens;
      trimmed.unshift(msg);
    }

    return [system, ...trimmed];
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  private async buildSystemPrompt(): Promise<string> {
    const config =
      (await this.context.config.get<Record<string, any>>('root')) ?? {};
    const profile = config.profile ?? {};
    const skills = config.skills ?? {};
    const resources = config.resources ?? {};

    const name = profile.displayName || 'User';
    const city = profile.city ? `, wohnt in ${profile.city}` : '';
    const profession = profile.profession
      ? `, arbeitet als ${profile.profession}`
      : '';

    const styleMap: Record<string, string> = {
      kurz: 'Antworte kurz und knapp.',
      mittel: 'Antworte ausgewogen — nicht zu kurz, nicht zu lang.',
      ausführlich: 'Antworte ausführlich und detailliert.',
    };
    const style = styleMap[profile.responseStyle] ?? styleMap.mittel;

    const toneMap: Record<string, string> = {
      freundlich: 'freundlich und warmherzig',
      professionell: 'professionell und sachlich',
      locker: 'locker und entspannt',
    };
    const tone = toneMap[profile.tone] ?? toneMap.freundlich;

    const lines: string[] = [
      'Du bist Sarah, ein freundlicher Desktop-Assistent.',
      'Du antwortest hilfsbereit, präzise und natürlich.',
      'Du führst niemals Code aus, gibst keine Passwörter weiter, und sendest keine Daten ohne explizite Freigabe.',
      '',
      `Der User heißt ${name}${city}${profession}.`,
    ];

    // Usage purposes & hobbies
    const purposes: string[] = profile.usagePurposes ?? [];
    if (purposes.length > 0) {
      lines.push(`Hauptverwendung: ${purposes.join(', ')}.`);
    }
    const hobbies: string[] = profile.hobbies ?? [];
    if (hobbies.length > 0) {
      lines.push(`Interessen/Hobbys: ${hobbies.join(', ')}.`);
    }

    // Programming context
    if (skills.programming) {
      lines.push(`Programmierlevel: ${skills.programming}.`);
    }
    const stack: string[] = skills.programmingStack ?? [];
    if (stack.length > 0) {
      lines.push(`Techstack: ${stack.join(', ')}.`);
    }
    const searchResources: string[] = skills.programmingResources ?? [];
    if (searchResources.length > 0) {
      lines.push(`Bevorzugte Anlaufstellen für Lösungen: ${searchResources.join(', ')}. Suche dort zuerst, bevor du andere Quellen heranziehst.`);
    }
    if (skills.programmingProjectsFolder) {
      lines.push(`Projekte-Ordner: ${skills.programmingProjectsFolder}.`);
    }

    // Design & Office levels
    if (skills.design) {
      lines.push(`Design-Level: ${skills.design}.`);
    }
    if (skills.office) {
      lines.push(`Office-Level: ${skills.office}.`);
    }

    // PDF categories
    const pdfCats: { tag: string; folder: string; pattern: string; inferFromExisting: boolean }[] = resources.pdfCategories ?? [];
    if (pdfCats.length > 0) {
      lines.push('');
      lines.push('PDF-Sortierregeln:');
      for (const cat of pdfCats) {
        let rule = `- ${cat.tag}: Ordner ${cat.folder || '(nicht gesetzt)'}`;
        if (cat.pattern) rule += `, Benennungsschema: ${cat.pattern}`;
        if (cat.inferFromExisting) rule += ' (an bestehenden Dateien orientieren)';
        lines.push(rule);
      }
    }

    lines.push('');
    lines.push(style);
    lines.push(`Dein Tonfall ist ${tone}.`);
    lines.push('Sprache: Deutsch.');

    return lines.join('\n');
  }
}
