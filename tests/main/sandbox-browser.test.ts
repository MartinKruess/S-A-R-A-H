import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { SandboxBrowser, type SandboxWindow } from '../../src/main/sandbox-browser.js';

class FakeWebContents extends EventEmitter {
  stop = vi.fn();
  setWindowOpenHandler = vi.fn();
  executeJavaScript = vi.fn().mockResolvedValue('<html>seite</html>');
  session = {
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    resolveHost: undefined as undefined | ((hostname: string) => Promise<{
      endpoints: Array<{ address: string }>;
    }>),
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
  }, async () => ['93.184.216.34']);
  return { browser, windows };
}

describe('SandboxBrowser.fetchPageHtml', () => {
  it('rejects non-http(s) URLs before any navigation', async () => {
    const { browser, windows } = makeBrowser();
    await expect(browser.fetchPageHtml('file:///etc/passwd', new AbortController().signal)).rejects.toThrow('Blocked URL');
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

  it('rejects HTTP and private or link-local DNS targets', async () => {
    const windows: FakeWindow[] = [];
    const browser = new SandboxBrowser(
      () => {
        const win = new FakeWindow();
        windows.push(win);
        return win;
      },
      async (host) => host === 'private.test' ? ['192.168.1.20'] : ['169.254.169.254'],
    );

    await expect(browser.fetchPageHtml('http://example.com/', new AbortController().signal)).rejects.toThrow('Blocked URL');
    await expect(browser.fetchPageHtml('https://private.test/', new AbortController().signal)).rejects.toThrow('Blocked network target');
    await expect(browser.show('https://metadata.test/')).resolves.toBe(false);
    await expect(browser.show('https://[::ffff:7f00:1]/')).resolves.toBe(false);
    expect(windows).toHaveLength(0);
  });

  it('revalidates with the Electron session resolver immediately before navigation', async () => {
    const win = new FakeWindow();
    win.webContents.session.resolveHost = vi.fn(async () => ({
      endpoints: [{ address: '127.0.0.1' }],
    }));
    const browser = new SandboxBrowser(() => win, async () => ['93.184.216.34']);

    await expect(browser.fetchPageHtml(
      'https://rebind.test/',
      new AbortController().signal,
    )).rejects.toThrow('Blocked network target');

    expect(win.webContents.session.resolveHost).toHaveBeenCalledWith('rebind.test');
    expect(win.loadURL).not.toHaveBeenCalled();
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

  it('blocks a redirect whose hostname resolves to a private address', async () => {
    const win = new FakeWindow();
    win.webContents.session.resolveHost = vi.fn(async (host) => ({
      endpoints: [{ address: host === 'router.lan' ? '10.0.0.1' : '93.184.216.34' }],
    }));
    const browser = new SandboxBrowser(() => win, async () => ['93.184.216.34']);
    const fetching = browser.fetchPageHtml('https://example.com/', new AbortController().signal);
    await vi.waitFor(() => expect(win.loadURL).toHaveBeenCalledOnce());
    const event = { preventDefault: vi.fn() };

    win.webContents.emit('will-redirect', event, 'https://router.lan/admin');

    await expect(fetching).rejects.toThrow('Blocked redirect');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('continues a validated redirect after the cancelled original navigation', async () => {
    const win = new FakeWindow();
    let rejectInitial!: (error: Error & { code: number }) => void;
    win.loadURL
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectInitial = reject; }))
      .mockResolvedValue(undefined);
    const browser = new SandboxBrowser(() => win, async () => ['93.184.216.34']);
    const fetching = browser.fetchPageHtml('https://example.com/start', new AbortController().signal);
    await vi.waitFor(() => expect(win.loadURL).toHaveBeenCalledOnce());

    const event = { preventDefault: vi.fn() };
    win.webContents.emit('will-redirect', event, 'https://example.com/final');
    await vi.waitFor(() => expect(win.loadURL).toHaveBeenCalledTimes(2));
    rejectInitial(Object.assign(new Error('ERR_ABORTED'), { code: -3 }));
    win.webContents.emit('did-finish-load');

    await expect(fetching).resolves.toBe('<html>seite</html>');
    expect(win.loadURL).toHaveBeenLastCalledWith('https://example.com/final');
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

  it('hides a previously visible result when the next display fails', async () => {
    const { browser, windows } = makeBrowser();
    const first = browser.show('https://example.com/first');
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    windows[0].webContents.emit('did-finish-load');
    await expect(first).resolves.toBe(true);

    await expect(browser.show('http://example.com/blocked')).resolves.toBe(false);
    expect(windows[0].hide).toHaveBeenCalledTimes(1);

    const failedNavigation = browser.show('https://example.com/second');
    await vi.waitFor(() => expect(windows[0].loadURL).toHaveBeenCalledWith('https://example.com/second'));
    windows[0].webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED');

    await expect(failedNavigation).resolves.toBe(false);
    expect(windows[0].hide).toHaveBeenCalledTimes(2);
  });

  it('denies popups and keeps later navigation behind the HTTPS policy', async () => {
    const { browser, windows } = makeBrowser();
    const showing = browser.show('https://example.com/seite');
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    windows[0].webContents.emit('did-finish-load');
    await showing;

    const popupHandler = windows[0].webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0];
    expect(popupHandler?.({ url: 'https://evil.test/' })).toEqual({ action: 'deny' });
    const blockedEvent = { preventDefault: vi.fn() };
    windows[0].webContents.emit('will-navigate', blockedEvent, 'http://example.com/insecure');
    expect(blockedEvent.preventDefault).toHaveBeenCalled();

    const approvedProgrammaticEvent = { preventDefault: vi.fn() };
    windows[0].loadURL.mockImplementationOnce(async (targetUrl: string) => {
      windows[0].webContents.emit('will-navigate', approvedProgrammaticEvent, targetUrl);
    });
    const pageEvent = { preventDefault: vi.fn() };
    windows[0].webContents.emit('will-navigate', pageEvent, 'https://example.com/next');
    await vi.waitFor(() => expect(windows[0].loadURL).toHaveBeenLastCalledWith('https://example.com/next'));
    expect(approvedProgrammaticEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('drops stale asynchronous page-navigation validations after a newer navigation or close', async () => {
    const { browser, windows } = makeBrowser();
    const showing = browser.show('https://example.com/start');
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    windows[0].webContents.emit('did-finish-load');
    await showing;
    let releaseStale!: (value: { endpoints: Array<{ address: string }> }) => void;
    windows[0].webContents.session.resolveHost = vi.fn(async (hostname: string) => {
      if (hostname === 'stale.test') {
        return await new Promise((resolve) => { releaseStale = resolve; });
      }
      return { endpoints: [{ address: '93.184.216.34' }] };
    });

    windows[0].webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://stale.test/');
    windows[0].webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://current.test/');
    await vi.waitFor(() => expect(windows[0].loadURL).toHaveBeenLastCalledWith('https://current.test/'));
    releaseStale({ endpoints: [{ address: '93.184.216.34' }] });
    await Promise.resolve();
    expect(windows[0].loadURL).not.toHaveBeenCalledWith('https://stale.test/');

    let releaseAfterClose!: (value: { endpoints: Array<{ address: string }> }) => void;
    windows[0].webContents.session.resolveHost = vi.fn(async () => (
      await new Promise((resolve) => { releaseAfterClose = resolve; })
    ));
    windows[0].webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://after-close.test/');
    browser.close();
    releaseAfterClose({ endpoints: [{ address: '93.184.216.34' }] });
    await Promise.resolve();
    expect(windows[0].loadURL).not.toHaveBeenCalledWith('https://after-close.test/');
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
    const browser = new SandboxBrowser(() => win, async () => ['93.184.216.34']);
    const controller = new AbortController();
    const blocked = browser.fetchPageHtml('https://example.com/', controller.signal);
    await vi.waitFor(() => expect(win.webContents.session.clearStorageData).toHaveBeenCalled());
    controller.abort();

    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' });
    expect(win.webContents.stop).toHaveBeenCalled();
  });

  it('uses a fresh window generation after an aborted native storage cleanup', async () => {
    const windows: FakeWindow[] = [];
    let releaseCleanup!: () => void;
    const browser = new SandboxBrowser(() => {
      const win = new FakeWindow();
      if (windows.length === 0) {
        win.webContents.session.clearStorageData.mockImplementationOnce(
          () => new Promise<void>((resolve) => { releaseCleanup = resolve; }),
        );
      }
      windows.push(win);
      return win;
    }, async () => ['93.184.216.34']);
    const controller = new AbortController();
    const first = browser.fetchPageHtml('https://example.com/first', controller.signal);
    await vi.waitFor(() => expect(windows[0].webContents.session.clearStorageData).toHaveBeenCalled());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const second = browser.fetchPageHtml('https://example.com/second', new AbortController().signal);
    await vi.waitFor(() => expect(windows).toHaveLength(2));
    releaseCleanup();
    windows[1].webContents.emit('did-finish-load');

    await expect(second).resolves.toBe('<html>seite</html>');
    expect(windows[0].destroy).toHaveBeenCalled();
    expect(windows[1].webContents.session.clearStorageData).toHaveBeenCalledOnce();
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
