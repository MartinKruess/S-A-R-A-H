import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  IPC_COMMAND_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_SEND_CHANNELS,
} from '../../src/core/ipc-contract.js';

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function mainSources(): string {
  const directory = path.join(process.cwd(), 'src', 'main');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('\n');
}

describe('IPC contract parity', () => {
  const preload = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf8');
  const main = mainSources();

  it('keeps invoke channels equal across contract, preload and main handlers', () => {
    const contract = Object.keys(IPC_COMMAND_CHANNELS).sort();
    const renderer = matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g).sort();
    const handlers = matches(main, /ipcMain\.handle\(\s*'([^']+)'/g).sort();
    expect(renderer).toEqual(contract);
    expect(handlers).toEqual(contract);
  });

  it('keeps renderer send channels equal across contract, preload and main listeners', () => {
    const contract = Object.keys(IPC_SEND_CHANNELS).sort();
    const renderer = matches(preload, /ipcRenderer\.send\(\s*'([^']+)'/g).sort();
    const handlers = matches(main, /ipcMain\.(?:on|once)\(\s*'([^']+)'/g).sort();
    expect(renderer).toEqual(contract);
    expect(handlers).toEqual(contract);
  });

  it('keeps renderer event listeners equal to the event contract', () => {
    const contract = Object.keys(IPC_EVENT_CHANNELS).sort();
    const renderer = matches(preload, /ipcRenderer\.(?:on|once)\(\s*'([^']+)'/g).sort();
    expect(renderer).toEqual(contract);
  });
});
