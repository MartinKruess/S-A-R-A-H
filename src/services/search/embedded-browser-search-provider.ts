import type { SandboxBrowser } from '../../main/sandbox-browser.js';
import type { SearchProvider, SearchResult } from './search-provider.interface.js';
import { sanitizeResults } from './sanitize-web-text.js';
import { abortError, throwIfAborted } from '../../core/abort-utils.js';

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

/**
 * DDG wraps every result URL as `//duckduckgo.com/l/?uddg=<encoded target>`.
 * Unwrap it to the real https target; drop ads (they self-redirect to
 * duckduckgo.com/y.js). Returns null for anything that is not a real external
 * http(s) URL — the sanitizer would reject those anyway, and reporting them
 * as results was the bug that made every DDG search look like "no results".
 */
function unwrapDdgHref(href: string): string | null {
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
    const target = url.searchParams.get('uddg'); // URLSearchParams already decodes it once
    if (!target) return null;
    try {
      const resolved = new URL(target);
      const isHttp = resolved.protocol === 'http:' || resolved.protocol === 'https:';
      // A target still on duckduckgo.com is an ad/tracker hop, not a real result.
      if (isHttp && !resolved.hostname.endsWith('duckduckgo.com')) return target;
    } catch {
      return null;
    }
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? absolute : null;
}

export function extractDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const m of html.matchAll(DDG_RESULT)) {
    const url = unwrapDdgHref(m[1]);
    if (!url) continue;
    results.push({ url, title: stripTags(m[2]), snippet: stripTags(m[3]) });
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
  // A result page may legitimately contain the word "captcha" in its query,
  // title or snippets. Require a challenge marker/structure instead of the
  // bare word so searches about CAPTCHA remain usable.
  const isCaptchaWall =
    /class="[^"]*(?:g-recaptcha|h-captcha)[^"]*"/.test(lower) ||
    /<(?:iframe|script)[^>]+(?:recaptcha|hcaptcha)[^>]*>/.test(lower) ||
    /<(?:input|textarea)[^>]+(?:name|id)="[^"]*captcha[^"]*"/.test(lower) ||
    lower.includes('verify you are human') ||
    lower.includes('bestätigen sie, dass sie ein mensch sind');
  if (isCaptchaWall) return 'captcha';
  // Only a real consent interstitial should block — not the bare word "consent"
  // (privacy footers, cookie scripts) that appears on perfectly good result pages.
  const isConsentWall =
    lower.includes('bevor sie fortfahren') || // Bing/Google EU pre-consent phrase
    /action="[^"]*consent/.test(lower) || // a form posting to a consent endpoint
    lower.includes('id="bnp_container"'); // Bing's consent banner container
  return isConsentWall ? 'consent' : null;
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
      throwIfAborted(signal);
      let html: string;
      try {
        html = await this.browser.fetchPageHtml(engine.url, signal);
      } catch (err) {
        if (signal.aborted) throw abortError('Search aborted');
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
      lastDiagnosis = 'markup-changed';
    }
    throw new SearchDiagnosisError(lastDiagnosis, 'all engines');
  }
}
