import { describe, it, expect, vi } from 'vitest';
import {
  EmbeddedBrowserSearchProvider,
  extractDuckDuckGo,
  extractBing,
  detectBlockPage,
  SearchDiagnosisError,
} from './embedded-browser-search-provider.js';
import type { SandboxBrowser } from '../../main/sandbox-browser.js';

// DDG wraps every result URL in a protocol-relative redirect: the real target
// sits URL-encoded in the `uddg` param, and the `&` is HTML-entity-escaped in the
// serialized DOM. Ads self-redirect to duckduckgo.com/y.js and must be dropped.
const ddgHref = (target: string): string =>
  `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=deadbeef`;

const DDG_FIXTURE = `<html><body>
<div class="result result--ad">
  <h2 class="result__title"><a class="result__a" href="${ddgHref('https://duckduckgo.com/y.js?ad_domain=booking.com')}">Booking.com – Anzeige</a></h2>
  <a class="result__snippet" href="${ddgHref('https://duckduckgo.com/y.js?ad_domain=booking.com')}">Anzeige für Hotels.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="${ddgHref('https://hotel-kiel.example/zimmer')}">Hotel Kiel – Zimmer &amp; Preise</a></h2>
  <a class="result__snippet" href="${ddgHref('https://hotel-kiel.example/zimmer')}">Zentral gelegenes Hotel in Kiel mit Förde-Blick.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="${ddgHref('https://nordsee.example/kiel')}">Kiel Übernachtung</a></h2>
  <a class="result__snippet" href="${ddgHref('https://nordsee.example/kiel')}">Günstige Zimmer ab 49 Euro.</a>
</div>
</body></html>`;

const BING_FIXTURE = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://hotel-kiel.example/">Hotel Kiel</a></h2><div class="b_caption"><p>Hotel direkt an der Förde.</p></div></li>
</ol></body></html>`;

const CONSENT_FIXTURE = '<html><body><form action="/consent">Bevor Sie fortfahren… anonymized data</form></body></html>';

describe('extractors', () => {
  it('unwraps the DDG redirect to the real https target and drops ads', () => {
    const results = extractDuckDuckGo(DDG_FIXTURE);
    expect(results).toHaveLength(2); // the duckduckgo.com/y.js ad is dropped
    expect(results[0].title).toContain('Hotel Kiel');
    expect(results[0].url).toBe('https://hotel-kiel.example/zimmer'); // real target, not the /l/ redirect
    expect(results[0].snippet).toContain('Förde-Blick');
    expect(results[1].url).toBe('https://nordsee.example/kiel');
  });

  it('keeps a direct http(s) href when a result is not wrapped', () => {
    const html =
      '<h2><a class="result__a" href="https://direct.example/x">Direkt</a></h2>' +
      '<a class="result__snippet" href="https://direct.example/x">Ein Treffer.</a>';
    const results = extractDuckDuckGo(html);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://direct.example/x');
  });

  it('extracts Bing results', () => {
    const results = extractBing(BING_FIXTURE);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://hotel-kiel.example/');
  });

  it('returns [] on changed markup instead of throwing', () => {
    expect(extractDuckDuckGo('<html><body>anders</body></html>')).toEqual([]);
  });

  it('detects consent/captcha block pages as distinguishable diagnoses', () => {
    expect(detectBlockPage(CONSENT_FIXTURE)).toBe('consent');
    expect(detectBlockPage('<html>bitte lösen Sie das captcha</html>')).toBe('captcha');
    expect(detectBlockPage(DDG_FIXTURE)).toBeNull();
  });

  it('does not flag the bare word "consent" on a normal results page (no false positive)', () => {
    const normal = `<html><body><footer><a href="/privacy">Manage consent</a></footer>${BING_FIXTURE}</body></html>`;
    expect(detectBlockPage(normal)).toBeNull();
  });
});

describe('EmbeddedBrowserSearchProvider', () => {
  it('encodes the query and falls back to Bing when DDG yields nothing', async () => {
    const fetchPageHtml = vi.fn()
      .mockResolvedValueOnce('<html><body>leer</body></html>')
      .mockResolvedValueOnce(BING_FIXTURE);
    const provider = new EmbeddedBrowserSearchProvider({ fetchPageHtml } as unknown as SandboxBrowser);
    const results = await provider.search('hotels kiel & umgebung', new AbortController().signal);
    expect(fetchPageHtml.mock.calls[0][0]).toContain(encodeURIComponent('hotels kiel & umgebung'));
    expect(fetchPageHtml.mock.calls[1][0]).toContain('bing.com');
    expect(results).toHaveLength(1);
  });

  it('throws a diagnosis error when both engines are blocked', async () => {
    const fetchPageHtml = vi.fn().mockResolvedValue(CONSENT_FIXTURE);
    const provider = new EmbeddedBrowserSearchProvider({ fetchPageHtml } as unknown as SandboxBrowser);
    await expect(provider.search('hotels', new AbortController().signal)).rejects.toBeInstanceOf(SearchDiagnosisError);
  });

  it('propagates markup-changed diagnosis when both engines return unrecognizable content', async () => {
    const fetchPageHtml = vi.fn()
      .mockRejectedValueOnce(new Error('load-failed'))
      .mockResolvedValueOnce('<html><body>unrecognizable markup</body></html>');
    const provider = new EmbeddedBrowserSearchProvider({ fetchPageHtml } as unknown as SandboxBrowser);
    try {
      await provider.search('hotels', new AbortController().signal);
      expect.fail('should have thrown SearchDiagnosisError');
    } catch (err) {
      expect(err).toBeInstanceOf(SearchDiagnosisError);
      expect((err as SearchDiagnosisError).diagnosis).toBe('markup-changed');
    }
  });
});
