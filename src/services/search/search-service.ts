import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { SandboxBrowser } from '../../main/sandbox-browser.js';
import type { LaunchResult } from '../../main/program-launcher.js';
import type { SearchProvider, SearchResult } from './search-provider.interface.js';
import { buildSummaryPrompt, type SummarizeFn } from './summarize-results.js';
import { throwIfAborted, waitForSettlement } from '../../core/abort-utils.js';

/** Single-slot result session (Mi4): show_browser never looks up by requestId. */
interface ResultSession {
  results: SearchResult[];
}

export class SearchService implements SarahService {
  readonly id = 'search';
  readonly subscriptions = [] as const;
  status: ServiceStatus = 'pending';

  private session: ResultSession | null = null;
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
    this.session = null;
    this.status = 'stopped';
  }

  onMessage(_msg: TypedBusMessage): void {
    // Invoked directly by ActionService — no bus subscriptions.
  }

  async runSearch(query: string): Promise<string> {
    if (this.searching) throw new Error('search already running');
    this.searching = true;
    this.abort = new AbortController();
    const controller = this.abort;
    const operation = this.doRunSearch(query, controller);
    this.activeSearch = operation;
    void operation.finally(() => {
      if (this.activeSearch === operation) this.activeSearch = null;
    }).catch(() => {});
    return operation;
  }

  private async doRunSearch(query: string, controller: AbortController): Promise<string> {
    this.browser.hide(); // F6: a new search ends display mode
    this.session = null; // the new search replaces the old session completely
    try {
      throwIfAborted(controller.signal);
      const results = await this.provider.search(query, controller.signal);
      throwIfAborted(controller.signal);
      this.session = { results };
      return await this.summarize(buildSummaryPrompt(results), controller.signal);
    } finally {
      this.searching = false;
      if (this.abort === controller) this.abort = null;
    }
  }

  async showResult(param: string): Promise<LaunchResult> {
    if (this.searching) return { ok: false, speak: 'Moment, ich suche gerade noch.' };
    if (!this.session || this.session.results.length === 0) {
      return { ok: false, speak: 'Ich habe gerade keine Suchergebnisse offen.' };
    }
    const results = this.session.results;

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

    const shown = await this.browser.show(target.url); // only stored, validated session URLs
    return shown ? { ok: true } : { ok: false, speak: 'Die Seite ließ sich nicht öffnen.' };
  }
}
