import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { SandboxBrowser, type SandboxWindow } from '../../src/main/sandbox-browser.js';

class FakeWebContents extends EventEmitter {
  stop = vi.fn();
  executeJavaScript = vi.fn().mockResolvedValue('<html>seite</html>');
  session = {
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    cookies: { set: vi.fn().mockResolvedValue(undefined) },
  };
}

class FakeWindow extends EventEmitter implements SandboxWindow {
  webContents = new FakeWebContents();
  destroyed = false;
  loadURL = vi.fn().mockResolvedValue(undefined);
  show = vi.fn();
  hide = vi.fn();
  destroy = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
  isDestroyed = (): boolean => this.destroyed;
}

function makeBrowser(): { browser: SandboxBrowser; windows: FakeWindow[] } {
  const windows: FakeWindow[] = [];
  const browser = new SandboxBrowser(() => {
    const w = new FakeWindow();
    windows.push(w);
    return w;
  });
  return { browser, windows };
}

describe('SandboxBrowser.fetchPageHtml', () => {
  it('rejects non-http(s) URLs before any navigation', async () => {
    const { browser, windows } = makeBrowser();
    await expect(browser.fetchPageHtml('file:///etc/passwd', new AbortController().signal)).rejects.toThrow('Invalid URL');
    expect(windows).toHaveLength(0);
  });

  it('rejects an already-aborted search before creating a browser window', async () => {
    const { browser, windows } = makeBrowser();
    const controller = new AbortController();
    controller.abort();

    await expect(browser.fetchPageHtml('https://example.com/', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(windows).toHaveLength(0);
  });

  it('clears storage, loads, and returns the page html on did-finish-load', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('did-finish-load');
    await expect(p).resolves.toBe('<html>seite</html>');
    expect(windows[0].webContents.session.clearStorageData).toHaveBeenCalled();
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith('document.documentElement.outerHTML');
  });

  it('aborts on redirect to a non-http scheme', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    const evt = { preventDefault: vi.fn() };
    windows[0].webContents.emit('will-redirect', evt, 'file:///x');
    await expect(p).rejects.toThrow('Blocked redirect');
    expect(evt.preventDefault).toHaveBeenCalled();
  });

  it('seeds Bing consent cookies before a bing.com fetch, not for other hosts', async () => {
    const { browser, windows } = makeBrowser();
    const bing = browser.fetchPageHtml('https://www.bing.com/search?q=x', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('did-finish-load');
    await bing;
    const cookieNames = windows[0].webContents.session.cookies.set.mock.calls.map((c) => c[0].name);
    expect(cookieNames).toContain('SRCHHPGUSR');
    expect(windows[0].webContents.session.cookies.set.mock.calls[0][0].domain).toBe('.bing.com');

    const other = browser.fetchPageHtml('https://html.duckduckgo.com/html/?q=x', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('did-finish-load');
    await other;
    // still only the bing seeding — no new cookie writes for duckduckgo
    expect(windows[0].webContents.session.cookies.set.mock.calls.every((c) => c[0].domain === '.bing.com')).toBe(true);
  });

  it('abort signal stops loading; a late did-finish-load is ignored', async () => {
    const { browser, windows } = makeBrowser();
    const ac = new AbortController();
    const p = browser.fetchPageHtml('https://example.com/', ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    windows[0].webContents.emit('did-finish-load'); // spät – darf nichts mehr tun
    expect(windows[0].webContents.stop).toHaveBeenCalled();
  });

  it('render-process-gone fails once; the next call gets a fresh window', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await expect(p).rejects.toThrow('crashed');

    const p2 = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(windows).toHaveLength(2); // frisches Fenster
    windows[1].webContents.emit('did-finish-load');
    await expect(p2).resolves.toBeDefined();
  });

  it('did-fail-load is a defined error path', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED');
    await expect(p).rejects.toThrow('NAME_NOT_RESOLVED');
  });
});

describe('SandboxBrowser.show', () => {
  it('shows only after did-finish-load (Mi6 loaded semantics)', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.show('https://example.com/seite');
    await new Promise((r) => setTimeout(r, 5));
    expect(windows[0].show).not.toHaveBeenCalled();
    windows[0].webContents.emit('did-finish-load');
    await expect(p).resolves.toBe(true);
    expect(windows[0].show).toHaveBeenCalled();
  });

  it('refuses non-http(s) URLs', async () => {
    const { browser } = makeBrowser();
    await expect(browser.show('javascript:alert(1)')).resolves.toBe(false);
  });

  it('aborts on redirect to a non-http scheme', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.show('https://example.com/seite');
    await new Promise((r) => setTimeout(r, 5));
    const evt = { preventDefault: vi.fn() };
    windows[0].webContents.emit('will-redirect', evt, 'file:///x');
    await expect(p).resolves.toBe(false);
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(windows[0].webContents.stop).toHaveBeenCalled();
  });

  it('render-process-gone during show() resolves false; next call gets fresh window', async () => {
    const { browser, windows } = makeBrowser();
    const p = browser.show('https://example.com/seite');
    await new Promise((r) => setTimeout(r, 5));
    windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await expect(p).resolves.toBe(false);

    const p2 = browser.show('https://example.com/seite');
    await new Promise((r) => setTimeout(r, 5));
    expect(windows).toHaveLength(2); // frisches Fenster
    windows[1].webContents.emit('did-finish-load');
    await expect(p2).resolves.toBe(true);
  });

  it('aborts an active stored-result display during shutdown', async () => {
    const { browser, windows } = makeBrowser();
    const controller = new AbortController();
    const showing = browser.show('https://example.com/seite', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));

    controller.abort();

    await expect(showing).rejects.toMatchObject({ name: 'AbortError' });
    expect(windows[0].webContents.stop).toHaveBeenCalled();
  });

  it('aborts while isolated storage preparation is still hanging', async () => {
    const win = new FakeWindow();
    win.webContents.session.clearStorageData.mockImplementationOnce(
      async () => new Promise<void>(() => {}),
    );
    const browser = new SandboxBrowser(() => win);
    const controller = new AbortController();
    const blocked = browser.fetchPageHtml('https://example.com/', controller.signal);
    await vi.waitFor(() => expect(win.webContents.session.clearStorageData).toHaveBeenCalled());
    controller.abort();

    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' });
    expect(win.webContents.stop).toHaveBeenCalled();
  });

  it('aborts while HTML extraction is still hanging', async () => {
    const { browser, windows } = makeBrowser();
    const controller = new AbortController();
    const fetching = browser.fetchPageHtml('https://example.com/', controller.signal);
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    windows[0].webContents.executeJavaScript.mockImplementationOnce(
      async () => new Promise<string>(() => {}),
    );
    windows[0].webContents.emit('did-finish-load');
    controller.abort();

    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
    expect(windows[0].webContents.stop).toHaveBeenCalled();
  });
});
