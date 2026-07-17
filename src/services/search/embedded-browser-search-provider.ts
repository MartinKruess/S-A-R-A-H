import type { SandboxBrowser } from '../../main/sandbox-browser.js';
import type { SearchProvider, SearchResult } from './search-provider.interface.js';
import { sanitizeResults } from './sanitize-web-text.js';

export type SearchDiagnosis = 'consent' | 'captcha' | 'markup-changed' | 'load-failed';

export class SearchDiagnosisError extends Error {
  constructor(public readonly diagnosis: SearchDiagnosis, engine: string) {
    super(`Search blocked (${engine}): ${diagnosis}`);
  }
}

// Regex extraction over the raw HTML string â€” parsing happens HERE in the main
// process; the sandbox page only ever runs the static outerHTML read (Task 9).
const DDG_RESULT = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
const BING_RESULT = /class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

export function extractDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const m of html.matchAll(DDG_RESULT)) {
    results.push({ url: m[1], title: stripTags(m[2]), snippet: stripTags(m[3]) });
  }
  return results;
}

export function extractBing(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const m of html.matchAll(BING_RESULT)) {
    results.push({ url: m[1], title: stripTags(m[2]), snippet: stripTags(m[3]) });
  }
  return results;
}

export function detectBlockPage(html: string): 'consent' | 'captcha' | null {
  const lower = html.toLowerCase();
  if (lower.includes('captcha')) return 'captcha';
  if (lower.includes('consent') || lower.includes('bevor sie fortfahren')) return 'consent';
  return null;
}

export class EmbeddedBrowserSearchProvider implements SearchProvider {
  constructor(private browser: SandboxBrowser) {}

  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const encoded = encodeURIComponent(query); // F11: always encoded before URL building
    const engines: { name: string; url: string; extract: (html: string) => SearchResult[] }[] = [
      { name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encoded}`, extract: extractDuckDuckGo },
      { name: 'bing', url: `https://www.bing.com/search?q=${encoded}`, extract: extractBing },
    ];

    let lastDiagnosis: SearchDiagnosis = 'markup-changed';
    for (const engine of engines) {
      let html: string;
      try {
        html = await this.browser.fetchPageHtml(engine.url, signal);
      } catch (err) {
        console.warn(`[Search] ${engine.name} load failed:`, err);
        lastDiagnosis = 'load-failed';
        continue;
      }
      const blocked = detectBlockPage(html);
      if (blocked) {
        console.warn(`[Search] ${engine.name} blocked: ${blocked}`);
        lastDiagnosis = blocked;
        continue;
      }
      const results = sanitizeResults(engine.extract(html));
      if (results.length > 0) return results;
      console.warn(`[Search] ${engine.name} returned no extractable results (markup changed?)`);
    }
    throw new SearchDiagnosisError(lastDiagnosis, 'all engines');
  }
}
