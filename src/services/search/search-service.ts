import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { SandboxBrowser } from '../../main/sandbox-browser.js';
import type { LaunchResult } from '../../main/program-launcher.js';
import type { SearchProvider, SearchResult } from './search-provider.interface.js';
import { buildSummaryPrompt, type SummarizeFn } from './summarize-results.js';
import { linkAbortSignals, throwIfAborted, waitForSettlement } from '../../core/abort-utils.js';
import { randomUUID } from 'crypto';

/** Single-slot result session (Mi4): show_browser never looks up by requestId. */
interface ResultSession {
  turnId: string;
  requestId: string;
  results: SearchResult[];
}

export class SearchService implements SarahService {
  readonly id = 'search';
  readonly subscriptions = [] as const;
  status: ServiceStatus = 'pending';

  private sessions = new Map<string, ResultSession>();
  private latestSessionId: string | null = null;
  private searching = false;
  private abort: AbortController | null = null;
  private activeSearch: Promise<string> | null = null;

  constructor(
    private provider: SearchProvider,
    private browser: SandboxBrowser,
    private summarize: SummarizeFn,
  ) {}

  async init(): Promise<void> {
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.abort?.abort();
    if (this.activeSearch) await waitForSettlement(this.activeSearch, 2_000);
    this.activeSearch = null;
    this.abort = null;
    this.searching = false;
    this.sessions.clear();
    this.latestSessionId = null;
    this.status = 'stopped';
  }

  onMessage(_msg: TypedBusMessage): void {
    // Invoked directly by ActionService — no bus subscriptions.
  }

  async runSearch(
    query: string,
    correlationOrSignal?: { turnId: string; requestId: string } | AbortSignal,
    signal?: AbortSignal,
  ): Promise<string> {
    const correlation = correlationOrSignal instanceof AbortSignal
      ? { turnId: randomUUID(), requestId: randomUUID() }
      : correlationOrSignal ?? { turnId: randomUUID(), requestId: randomUUID() };
    const callerSignal = correlationOrSignal instanceof AbortSignal ? correlationOrSignal : signal;
    if (this.searching) throw new Error('search already running');
    this.searching = true;
    this.abort = new AbortController();
    const controller = this.abort;
    const linked = linkAbortSignals(controller.signal, callerSignal);
    const operation = this.doRunSearch(
      query,
      correlation,
      linked.signal,
      controller,
    ).finally(() => linked.dispose());
    this.activeSearch = operation;
    void operation.finally(() => {
      if (this.activeSearch === operation) this.activeSearch = null;
    }).catch(() => {});
    return operation;
  }

  private async doRunSearch(
    query: string,
    correlation: { turnId: string; requestId: string },
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<string> {
    this.browser.hide(); // F6: a new search ends display mode
    try {
      throwIfAborted(signal);
      const results = await this.provider.search(query, signal);
      throwIfAborted(signal);
      this.sessions.set(correlation.requestId, { ...correlation, results });
      this.latestSessionId = correlation.requestId;
      while (this.sessions.size > 8) {
        const oldest = this.sessions.keys().next().value as string | undefined;
        if (oldest) this.sessions.delete(oldest);
        else break;
      }
      return await this.summarize(buildSummaryPrompt(results), signal);
    } finally {
      this.searching = false;
      if (this.abort === controller) this.abort = null;
    }
  }

  async showResult(
    param: string,
    correlationOrSignal?: { turnId: string; requestId: string } | AbortSignal,
    signal?: AbortSignal,
  ): Promise<LaunchResult> {
    const callerSignal = correlationOrSignal instanceof AbortSignal ? correlationOrSignal : signal;
    throwIfAborted(callerSignal);
    if (this.searching) return { ok: false, speak: 'Moment, ich suche gerade noch.' };
    const session = this.latestSessionId ? this.sessions.get(this.latestSessionId) : undefined;
    if (!session || session.results.length === 0) {
      return { ok: false, speak: 'Ich habe gerade keine Suchergebnisse offen.' };
    }
    const results = session.results;

    let target: SearchResult | undefined;
    if (/^[1-8]$/.test(param.trim())) {
      target = results[Number(param.trim()) - 1];
      if (!target) return { ok: false, speak: `So viele Ergebnisse habe ich nicht — es sind ${results.length}.` };
    } else {
      const q = param.trim().toLowerCase();
      const hits = results.filter((r) => r.title.toLowerCase().includes(q));
      if (hits.length === 0) return { ok: false, speak: 'Dazu habe ich kein passendes Ergebnis.' };
      if (hits.length > 1) {
        return { ok: false, speak: `Meinst du ${hits.map((h) => h.title).join(' oder ')}?` };
      }
      target = hits[0];
    }

    const shown = callerSignal
      ? await this.browser.show(target.url, callerSignal)
      : await this.browser.show(target.url); // only stored, validated session URLs
    return shown ? { ok: true } : { ok: false, speak: 'Die Seite ließ sich nicht öffnen.' };
  }
}
