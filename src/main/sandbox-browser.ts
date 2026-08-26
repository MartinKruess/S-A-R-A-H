// src/main/sandbox-browser.ts
// Container 1 (Spec §6): the web can render here, but nothing can escape.
import type { WebContents } from 'electron';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { abortError, runWithTimeout, throwIfAborted } from '../core/abort-utils.js';

const LOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv6');

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const defaultResolveHost: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
};

/** Structural view over BrowserWindow so tests can inject a fake. */
export interface SandboxWindow {
  webContents: Pick<WebContents, 'stop' | 'executeJavaScript'> & {
    on(event: string, listener: (...args: never[]) => void): void;
    once(event: string, listener: (...args: never[]) => void): void;
    removeListener(event: string, listener: (...args: never[]) => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    emit?(event: string, ...args: unknown[]): boolean;
    session: {
      clearStorageData(): Promise<void>;
      clearCache(): Promise<void>;
      resolveHost?(hostname: string): Promise<{ endpoints: Array<{ address: string }> }>;
      cookies?: {
        set(details: {
          url: string;
          name: string;
          value: string;
          domain?: string;
          path?: string;
          secure?: boolean;
        }): Promise<void>;
      };
    };
  };
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): void;
}

/**
 * Bing gates cookieless EU clients behind a "Bevor Sie fortfahren" consent
 * interstitial. Seeding the cookies a returning visitor already has skips that
 * wall. We set them ourselves, so this is not tracking and the session stays
 * isolated (storage is still cleared before every fetch). Best-effort: a failed
 * cookie must never block the search.
 */
async function seedConsentCookies(
  session: SandboxWindow['webContents']['session'],
  targetUrl: string,
): Promise<void> {
  if (!session.cookies) return;
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return;
  }
  if (!/(^|\.)bing\.com$/.test(host)) return;
  const dob = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const jar: readonly { name: string; value: string }[] = [
    { name: 'SRCHHPGUSR', value: 'SRCHLANG=de' },
    { name: 'SRCHD', value: 'AF=NOFORM' },
    { name: 'SRCHUSR', value: `DOB=${dob}` },
    { name: '_EDGE_V', value: '1' },
    { name: '_EDGE_S', value: 'F=1' },
  ];
  for (const c of jar) {
    try {
      await session.cookies.set({
        url: 'https://www.bing.com',
        name: c.name,
        value: c.value,
        domain: '.bing.com',
        path: '/',
        secure: true,
      });
    } catch {
      // best effort
    }
  }
}

function parseHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family === 6) {
    const mapped = ipv4FromMappedAddress(address);
    return mapped
      ? blockedAddresses.check(mapped, 'ipv4')
      : blockedAddresses.check(address.split('%')[0], 'ipv6');
  }
  return true;
}

function ipv4FromMappedAddress(address: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (dotted) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

async function validatePublicHttpsUrl(raw: string, resolveHost: HostResolver): Promise<URL> {
  const url = parseHttpsUrl(raw);
  if (!url) throw new Error(`Blocked URL: ${raw}`);
  const hostname = normalizedHostname(url);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked network target: ${hostname}`);
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error(`Blocked network target: ${hostname}`);
  }
  return url;
}

async function defaultCreateWindow(): Promise<SandboxWindow> {
  const { BrowserWindow, session } = await import('electron');
  // A timed-out native storage operation cannot be cancelled. A fresh,
  // in-memory partition per window prevents its late completion from mutating
  // the session used by the next browser generation.
  const webSession = session.fromPartition(`sarah-web-${randomUUID()}`);
  webSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  webSession.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: webSession },
  });
  // Plain Chrome UA – drop the Electron marker.
  const ua = win.webContents.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(/\s?s-a-r-a-h\/\S+/i, '');
  win.webContents.setUserAgent(ua);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win as unknown as SandboxWindow;
}

export class SandboxBrowser {
  private window: SandboxWindow | null = null;
  private generation = 0;
  private readonly approvedNavigations = new WeakMap<SandboxWindow, Set<string>>();
  private readonly navigationTokens = new WeakMap<SandboxWindow, number>();

  constructor(
    private createWindowFn: () => SandboxWindow | Promise<SandboxWindow> = defaultCreateWindow,
    private resolveHost: HostResolver = defaultResolveHost,
  ) {}

  private async getWindow(): Promise<SandboxWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const generation = this.generation;
    const win = await this.createWindowFn();
    if (generation !== this.generation) {
      if (!win.isDestroyed()) win.destroy();
      throw abortError('Browser window generation became stale');
    }
    win.once('closed', () => {
      if (this.window === win) this.window = null;
    });
    const approvedNavigations = new Set<string>();
    this.approvedNavigations.set(win, approvedNavigations);
    this.navigationTokens.set(win, 0);
    // Page-initiated navigations remain constrained after the request-scoped
    // load listeners have been removed. Redirects receive the stronger async
    // DNS validation in fetchPageHtml()/show().
    win.webContents.on('will-navigate', (event: { preventDefault(): void }, targetUrl: string) => {
      if (approvedNavigations.delete(targetUrl)) return;
      event.preventDefault();
      const navigationToken = (this.navigationTokens.get(win) ?? 0) + 1;
      const windowGeneration = this.generation;
      this.navigationTokens.set(win, navigationToken);
      void validatePublicHttpsUrl(targetUrl, this.resolverFor(win)).then(
        (safeUrl) => {
          if (
            windowGeneration !== this.generation
            || this.window !== win
            || win.isDestroyed()
            || this.navigationTokens.get(win) !== navigationToken
          ) return;
          void this.navigate(win, safeUrl.toString()).catch(() => wcStopSafely(win));
        },
        () => {
          if (
            windowGeneration === this.generation
            && this.window === win
            && !win.isDestroyed()
            && this.navigationTokens.get(win) === navigationToken
          ) wcStopSafely(win);
        },
      );
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window = win;
    return win;
  }

  private resolverFor(win: SandboxWindow): HostResolver {
    const { session } = win.webContents;
    const resolveHost = session.resolveHost;
    if (!resolveHost) return this.resolveHost;
    return async (hostname) => {
      const result = await resolveHost.call(session, hostname);
      return result.endpoints.map(({ address }) => address);
    };
  }

  private async validateForWindow(win: SandboxWindow, raw: string, signal?: AbortSignal): Promise<URL> {
    return await runWithTimeout(
      () => validatePublicHttpsUrl(raw, this.resolverFor(win)),
      LOAD_TIMEOUT_MS,
      'Browser session target validation timed out',
      signal,
    );
  }

  private navigate(win: SandboxWindow, url: string): Promise<void> {
    const approved = this.approvedNavigations.get(win);
    this.navigationTokens.set(win, (this.navigationTokens.get(win) ?? 0) + 1);
    approved?.add(url);
    return win.loadURL(url).finally(() => approved?.delete(url));
  }

  private invalidateWindow(win: SandboxWindow): void {
    this.generation += 1;
    if (!win.isDestroyed()) win.destroy();
    if (this.window === win) this.window = null;
  }

  private async prepareWindow(signal?: AbortSignal): Promise<SandboxWindow> {
    try {
      return await runWithTimeout(
        () => this.getWindow(),
        LOAD_TIMEOUT_MS,
        'Browser window preparation timed out',
        signal,
      );
    } catch (error) {
      this.generation += 1;
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      this.window = null;
      throw error;
    }
  }

  /**
   * Loads a page and returns its raw HTML. The ONLY script that ever runs is
   * the static outerHTML read – never an interpolated string (Container 2 rule).
   */
  async fetchPageHtml(url: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await runWithTimeout(
      () => validatePublicHttpsUrl(url, this.resolveHost),
      LOAD_TIMEOUT_MS,
      'Browser target validation timed out',
      signal,
    );
    throwIfAborted(signal);
    const win = await this.prepareWindow(signal);
    await this.validateForWindow(win, url, signal);
    throwIfAborted(signal);
    const wc = win.webContents;
    try {
      await runWithTimeout(
        async (preparationSignal) => {
          await wc.session.clearStorageData();
          throwIfAborted(preparationSignal);
          await wc.session.clearCache();
          throwIfAborted(preparationSignal);
          await seedConsentCookies(wc.session, url); // skip Bing's EU consent wall (search only)
          throwIfAborted(preparationSignal);
        },
        LOAD_TIMEOUT_MS,
        'Browser storage preparation timed out',
        signal,
      );
    } catch (error) {
      wc.stop();
      this.invalidateWindow(win);
      throw error;
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let redirects = 0;
      let activeNavigationUrl = comparableUrl(url);
      const replacedNavigationUrls = new Set<string>();

      const cleanup = (): void => {
        settled = true;
        clearTimeout(timeout);
        wc.removeListener('did-finish-load', onFinish);
        wc.removeListener('did-fail-load', onFail);
        wc.removeListener('will-redirect', onRedirect);
        wc.removeListener('render-process-gone', onGone);
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        cleanup();
        reject(err);
      };

      const onFinish = (): void => {
        if (settled) return;
        void runWithTimeout(
          () => wc.executeJavaScript('document.documentElement.outerHTML'),
          LOAD_TIMEOUT_MS,
          'Browser HTML extraction timed out',
          signal,
        ).then(
          (html) => {
            if (settled) return;
            cleanup();
            resolve(String(html));
          },
          (err) => fail(err instanceof Error ? err : new Error(String(err))),
        );
      };
      const onFail = (
        _e: unknown,
        code: number,
        desc: string,
        validatedUrl = '',
      ): void => {
        const failedUrl = comparableUrl(validatedUrl);
        if (
          isRedirectCancellationCode(code, desc)
          && failedUrl.length > 0
          && replacedNavigationUrls.has(failedUrl)
        ) return;
        fail(new Error(`Load failed (${code}): ${desc}`));
      };
      const onRedirect = (event: { preventDefault(): void }, redirectUrl: string): void => {
        redirects += 1;
        event.preventDefault();
        replacedNavigationUrls.add(activeNavigationUrl);
        if (redirects > MAX_REDIRECTS) {
          wc.stop();
          fail(new Error(`Blocked redirect: ${redirectUrl}`));
          return;
        }
        void this.validateForWindow(win, redirectUrl, signal).then(
          (safeUrl) => {
            if (settled || win.isDestroyed()) return;
            const nextUrl = safeUrl.toString();
            activeNavigationUrl = comparableUrl(nextUrl);
            void this.navigate(win, nextUrl).catch((error: Error & { code?: number | string }) => {
              if (!isExpectedRedirectCancellation(error, nextUrl, replacedNavigationUrls)) fail(error);
            });
          },
          () => {
            wc.stop();
            fail(new Error(`Blocked redirect: ${redirectUrl}`));
          },
        );
      };
      const onGone = (_e: unknown, details: { reason: string }): void => {
        fail(new Error(`Renderer gone: ${details.reason}`));
        win.destroy();
      };
      const onAbort = (): void => {
        wc.stop();
        this.invalidateWindow(win);
        fail(abortError('Search aborted'));
      };
      const timeout = setTimeout(() => {
        wc.stop();
        this.invalidateWindow(win);
        fail(new Error('Load timeout'));
      }, LOAD_TIMEOUT_MS);

      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('will-redirect', onRedirect);
      wc.on('render-process-gone', onGone);
      signal.addEventListener('abort', onAbort, { once: true });

      this.navigate(win, url).catch((error: Error & { code?: number | string }) => {
        if (isExpectedRedirectCancellation(error, url, replacedNavigationUrls)) return;
        fail(error);
      });
    });
  }

  /** Shows a stored session URL – true only after the page finished loading (Mi6). */
  async show(url: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await runWithTimeout(
        () => validatePublicHttpsUrl(url, this.resolveHost),
        LOAD_TIMEOUT_MS,
        'Browser target validation timed out',
        signal,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      this.hide();
      return false;
    }
    throwIfAborted(signal);
    const win = await this.prepareWindow(signal);
    try {
      await this.validateForWindow(win, url, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (!win.isDestroyed()) win.hide();
      return false;
    }
    throwIfAborted(signal);
    const wc = win.webContents;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let redirects = 0;
      let activeNavigationUrl = comparableUrl(url);
      const replacedNavigationUrls = new Set<string>();

      const cleanup = (): void => {
        settled = true;
        clearTimeout(timeout);
        wc.removeListener('did-finish-load', onFinish);
        wc.removeListener('did-fail-load', onFail);
        wc.removeListener('will-redirect', onRedirect);
        wc.removeListener('render-process-gone', onGone);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (): void => {
        if (settled) return;
        cleanup();
        if (!win.isDestroyed()) win.hide();
        resolve(false);
      };

      const onFinish = (): void => {
        if (settled) return;
        cleanup();
        win.show();
        resolve(true);
      };
      const onFail = (
        _event?: unknown,
        code?: number,
        desc = '',
        validatedUrl = '',
      ): void => {
        const failedUrl = comparableUrl(validatedUrl);
        if (
          code !== undefined
          && isRedirectCancellationCode(code, desc)
          && failedUrl.length > 0
          && replacedNavigationUrls.has(failedUrl)
        ) return;
        fail();
      };
      const onRedirect = (event: { preventDefault(): void }, redirectUrl: string): void => {
        redirects += 1;
        event.preventDefault();
        replacedNavigationUrls.add(activeNavigationUrl);
        if (redirects > MAX_REDIRECTS) {
          wc.stop();
          fail();
          return;
        }
        void this.validateForWindow(win, redirectUrl, signal).then(
          (safeUrl) => {
            if (settled || win.isDestroyed()) return;
            const nextUrl = safeUrl.toString();
            activeNavigationUrl = comparableUrl(nextUrl);
            void this.navigate(win, nextUrl).catch((error: Error & { code?: number | string }) => {
              if (!isExpectedRedirectCancellation(error, nextUrl, replacedNavigationUrls)) fail();
            });
          },
          () => {
            wc.stop();
            fail();
          },
        );
      };
      const onGone = (): void => {
        fail();
        win.destroy();
      };
      const onAbort = (): void => {
        if (settled) return;
        wc.stop();
        this.invalidateWindow(win);
        cleanup();
        reject(abortError('Browser display aborted'));
      };
      const timeout = setTimeout(() => {
        wc.stop();
        this.invalidateWindow(win);
        fail();
      }, LOAD_TIMEOUT_MS);

      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('will-redirect', onRedirect);
      wc.on('render-process-gone', onGone);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.navigate(win, url).catch((error: Error & { code?: number | string }) => {
        if (isExpectedRedirectCancellation(error, url, replacedNavigationUrls)) return;
        onFail();
      });
    });
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  close(): void {
    this.generation += 1;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

function wcStopSafely(win: SandboxWindow): void {
  if (!win.isDestroyed()) win.webContents.stop();
}

function isRedirectCancellation(error: Error & { code?: number | string }): boolean {
  return error.code === -3 || error.code === 'ERR_ABORTED' || error.message.includes('ERR_ABORTED');
}

function isRedirectCancellationCode(code: number, description: string): boolean {
  return code === -3 || description.includes('ERR_ABORTED');
}

function comparableUrl(raw: string): string {
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function isExpectedRedirectCancellation(
  error: Error & { code?: number | string },
  url: string,
  replacedNavigationUrls: ReadonlySet<string>,
): boolean {
  return isRedirectCancellation(error) && replacedNavigationUrls.has(comparableUrl(url));
}
