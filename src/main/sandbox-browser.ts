// src/main/sandbox-browser.ts
// Container 1 (Spec §6): the web can render here, but nothing can escape.
import type { WebContents } from 'electron';

const LOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/** Structural view over BrowserWindow so tests can inject a fake. */
export interface SandboxWindow {
  webContents: Pick<WebContents, 'stop' | 'executeJavaScript'> & {
    on(event: string, listener: (...args: never[]) => void): void;
    once(event: string, listener: (...args: never[]) => void): void;
    removeListener(event: string, listener: (...args: never[]) => void): void;
    emit?(event: string, ...args: unknown[]): boolean;
    session: { clearStorageData(): Promise<void>; clearCache(): Promise<void> };
  };
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): void;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function defaultCreateWindow(): Promise<SandboxWindow> {
  const { BrowserWindow, session } = await import('electron');
  const webSession = session.fromPartition('sarah-web');
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
  return win as unknown as SandboxWindow;
}

export class SandboxBrowser {
  private window: SandboxWindow | null = null;

  constructor(private createWindowFn: () => SandboxWindow | Promise<SandboxWindow> = defaultCreateWindow) {}

  private async getWindow(): Promise<SandboxWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = await this.createWindowFn();
    win.once('closed', () => {
      if (this.window === win) this.window = null;
    });
    this.window = win;
    return win;
  }

  /**
   * Loads a page and returns its raw HTML. The ONLY script that ever runs is
   * the static outerHTML read – never an interpolated string (Container 2 rule).
   */
  async fetchPageHtml(url: string, signal: AbortSignal): Promise<string> {
    if (!isHttpUrl(url)) throw new Error(`Invalid URL: ${url}`);
    const win = await this.getWindow();
    const wc = win.webContents;
    await wc.session.clearStorageData();
    await wc.session.clearCache();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let redirects = 0;

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
        cleanup();
        wc.executeJavaScript('document.documentElement.outerHTML').then(
          (html) => resolve(String(html)),
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      };
      const onFail = (_e: unknown, code: number, desc: string): void => fail(new Error(`Load failed (${code}): ${desc}`));
      const onRedirect = (event: { preventDefault(): void }, redirectUrl: string): void => {
        redirects += 1;
        if (!isHttpUrl(redirectUrl) || redirects > MAX_REDIRECTS) {
          event.preventDefault();
          wc.stop();
          fail(new Error(`Blocked redirect: ${redirectUrl}`));
        }
      };
      const onGone = (_e: unknown, details: { reason: string }): void => {
        fail(new Error(`Renderer gone: ${details.reason}`));
        win.destroy();
      };
      const onAbort = (): void => {
        wc.stop();
        fail(new Error('Search aborted'));
      };
      const timeout = setTimeout(() => {
        wc.stop();
        fail(new Error('Load timeout'));
      }, LOAD_TIMEOUT_MS);

      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('will-redirect', onRedirect);
      wc.on('render-process-gone', onGone);
      signal.addEventListener('abort', onAbort, { once: true });

      win.loadURL(url).catch((err: Error) => fail(err));
    });
  }

  /** Shows a stored session URL – true only after the page finished loading (Mi6). */
  async show(url: string): Promise<boolean> {
    if (!isHttpUrl(url)) return false;
    const win = await this.getWindow();
    const wc = win.webContents;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const onFinish = (): void => {
        if (settled) return;
        settled = true;
        wc.removeListener('did-fail-load', onFail);
        win.show();
        resolve(true);
      };
      const onFail = (): void => {
        if (settled) return;
        settled = true;
        wc.removeListener('did-finish-load', onFinish);
        resolve(false);
      };
      wc.once('did-finish-load', onFinish);
      wc.once('did-fail-load', onFail);
      win.loadURL(url).catch(() => onFail());
    });
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
