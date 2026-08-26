import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));

import { spawn } from 'node:child_process';
import { PiperProvider } from '../../../src/services/voice/providers/piper-provider.js';

class MockProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  kill = vi.fn(() => true);
}

describe('PiperProvider process ownership', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('keeps a newer synthesis registered after an older process closes', async () => {
    const firstProcess = new MockProcess();
    const secondProcess = new MockProcess();
    spawnMock
      .mockReturnValueOnce(firstProcess as unknown as ChildProcess)
      .mockReturnValueOnce(secondProcess as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');

    const first = provider.speak('Erster Satz');
    const second = provider.speak('Zweiter Satz');
    firstProcess.stdout.emit('data', Buffer.from([0, 0]));
    firstProcess.emit('close', 0);
    await first;

    provider.stop();
    expect(firstProcess.kill).not.toHaveBeenCalled();
    expect(secondProcess.kill).toHaveBeenCalledOnce();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    secondProcess.emit('close', null);
  });

  it('aborts only the owning synthesis process', async () => {
    const firstProcess = new MockProcess();
    const secondProcess = new MockProcess();
    spawnMock
      .mockReturnValueOnce(firstProcess as unknown as ChildProcess)
      .mockReturnValueOnce(secondProcess as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');
    const controller = new AbortController();

    const first = provider.speak('Abbrechen', controller.signal);
    const second = provider.speak('Weiterlaufen');
    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstProcess.kill).toHaveBeenCalledOnce();
    expect(secondProcess.kill).not.toHaveBeenCalled();

    secondProcess.stdout.emit('data', Buffer.from([0, 0]));
    secondProcess.emit('close', 0);
    await second;
  });

  it('rejects an externally signalled process instead of accepting partial audio', async () => {
    const child = new MockProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');

    const speech = provider.speak('Unvollstaendige Ausgabe');
    child.stdout.emit('data', Buffer.from([0, 0]));
    child.emit('close', null, 'SIGTERM');

    await expect(speech).rejects.toThrow('Piper terminated by signal SIGTERM');
  });

  it('turns a Piper stdin EPIPE into a controlled synthesis rejection', async () => {
    const child = new MockProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');

    const speech = provider.speak('Dieser Text erreicht Piper nicht');
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.emit('error', error);

    await expect(speech).rejects.toThrow('Failed to send text to piper: write EPIPE');
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGTERM');
  });

  it('degrades after a runtime synthesis failure and recovers after a later success', async () => {
    const failedProcess = new MockProcess();
    const recoveredProcess = new MockProcess();
    spawnMock
      .mockReturnValueOnce(failedProcess as unknown as ChildProcess)
      .mockReturnValueOnce(recoveredProcess as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));
    await provider.init();

    const failed = provider.speak('Fehlerhafte Ausgabe');
    failedProcess.emit('close', 1);
    await expect(failed).rejects.toThrow('Piper exited with code 1');

    const recovered = provider.speak('Wiederhergestellte Ausgabe');
    recoveredProcess.stdout.emit('data', Buffer.from([0, 0]));
    recoveredProcess.emit('close', 0);
    await expect(recovered).resolves.toEqual(new Float32Array([0]));

    expect(states).toEqual([
      { available: true },
      { available: false, message: 'Piper exited with code 1' },
      { available: true },
    ]);
  });

  it('does not report an intentional synthesis abort as a runtime outage', async () => {
    const child = new MockProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const provider = new PiperProvider('C:\\resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));
    await provider.init();
    const controller = new AbortController();

    const speech = provider.speak('Abbrechen', controller.signal);
    controller.abort();

    await expect(speech).rejects.toMatchObject({ name: 'AbortError' });
    expect(states).toEqual([{ available: true }]);
    child.emit('close', null, 'SIGTERM');
  });
});
